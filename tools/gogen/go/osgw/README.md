# osgw -- the gateway

The stable process in front of an osgo generation, ADR 0010 slice 3
(`docs/adr/0010-osgo-work-processes-and-hot-swap.md`). It owns what must
outlive a generation -- the public port, the lock table, the generation
table -- and runs the ABAP in a **sidecar**: the osgo binary started with
`-sidecar <dir>`. `cmd/osgw` is the entry. (The ADR calls the package
`go/gateway`; that name is taken under `tools/gogen` by the generated OData
runner `go/cmd/gateway` of `gateway.mjs` and its ignored binary `go/gateway`,
so it is `go/osgw`, after its command.)


```sh
osgw [-binary tools/gogen/.out/osgo] [-port N] [-addr A] -- -adt -root <tree> -home <dir>
```

Port and address rules are osgo's (`-port`, `OSD_PORT`, `STG_PORT`,
`INSTANCE`, 3095; `-addr`, `OSD_BIND`, loopback); the arguments after `--`
are the sidecar's, and it is given `-port N` too so what it reports names the
public port.

## What it does

- **Sockets.** The gateway listens; the sidecar answers HTTP on
  `SidecarSocket(dir, pid)` (`<dir>/http-<pid>.sock`, one per process, so two
  sidecars of slice 4's swap never share one). Every request but `GET`/`HEAD
  /osd/serving` crosses to it: written by `forward.go` onto a pooled
  connection and its answer copied back in the request's own goroutine
  (hop-by-hop headers and `Expect` dropped, the `Host` kept, no
  `X-Forwarded-For`, no `User-Agent` added, no transparent gzip, a body of
  unknown length streamed and flushed as it comes, a request without a body
  sent again once when a pooled connection turns out closed -- only for
  `GET`/`HEAD`/`OPTIONS`/`TRACE`, or when the write itself failed; a `POST`
  or `DELETE` that was written may have run and answers 503). A WebSocket
  upgrade goes through `httputil.ReverseProxy`, which hands the connection
  over. `httputil.ReverseProxy` for everything was the first version: its
  `http.Transport` passes each answer between a read and a write goroutine,
  and on the OData bench that hand-off (futex, scheduler) was a quarter of
  the gateway's CPU. The sidecar sees the request as the client sent it, and
  the client gets the sidecar's answer, its `X-OSD-Generation` included.
- **The lock table.** One `enq.Server`, served on `LockSocket(dir)`
  (`<dir>/enq.sock`) by the E3 protocol of `go/enqnet`. osgo's
  `-sidecar` mode puts its ADT kernel, its step glue and the generated
  `ENQUEUE_*`/`DEQUEUE_*` on an `enqnet.Client` of it before its first step, so
  an owner is (generation, session, LUW) and a lock outlives the process
  that took it until the rule below releases it.
- **A sidecar that dies** (crash, kill, OOM): its requests in flight answer
  `503 STG/NOT_SERVING` (`phase: restarting`; the LUW rolled back with its
  connection, the client may retry); the lock server, seeing its connection
  close, releases the dialog locks of its sessions and the locks of their
  open LUWs. osgo runs its update task inline (`COMMIT WORK` says
  `UpdateDone` before it returns), so the locks of an update a COMMIT had
  handed over go too. That is sound by ordering, not by an abort:
  `GeneratedCommitWork` commits the database before the lock `Commit` /
  `UpdateDone` (`go/enqnet/README.md` has the argument, and the one older
  divergence: a stateful LUW spanning steps has committed its earlier steps'
  writes, and a crash keeps them while its locks go).
  `Options.UpdatesOutside` keeps them until `UpdateDone` for a sidecar whose
  update task runs elsewhere. A lock connection that breaks while its sidecar
  still runs does not release anything first: the hello names the sidecar's
  pid, the gateway kills it, waits for its exit, and only then do its locks
  go (that process could still commit). The
  gateway starts a replacement of the same binary; requests that arrive
  meanwhile wait for it (`AdmitWait`, 30 s). A replacement that dies within
  `RestartWindow` (1 min) of its start is not replaced again: `/osd/serving`
  answers 503 `phase: failed` and says why, `Failed()` closes, and
  `cmd/osgw` exits 1 so a supervisor sees it.
- **Readiness.** A sidecar counts as serving once its own `GET /osd/serving`
  says `ready`. The gateway's `/osd/serving` is the supervised-host contract
  of `go/serving` (`tools/osd-host-contract.mjs` holds both to it): `pid` is
  the sidecar that serves, `launcherPid` the gateway (the process a launcher
  owns and signals), `generation`, `root`, `database` the sidecar's; under
  `gateway` the generation table (`id`, `pid`, `generation`, `state`
  starting/serving/draining/retired, `started`, `ended`, `why`, `steps` in
  flight, `pinned` sessions), `restarts`, `locks` (rows in the table),
  `failed`.
- **Session pinning.** A response that sets a stateful-session cookie
  (`SAP_SESSIONID_*`, `sap-contextid`) pins that session to the sidecar that
  set it, a cookie that is cleared unpins it, and a request carrying a pinned
  cookie goes to its sidecar while that one lives. With one sidecar this is
  bookkeeping; it is what the swap routes by (below).
- **The drain.** The gateway is wrapped in `serving.Host` (admission, the
  503 to newcomers, `X-OSD-Generation` on its own answers). On SIGTERM,
  SIGINT or SIGHUP (`cmd/osgw`): the requests in flight finish, the
  listeners close, `Stop` sends the sidecar SIGTERM -- its own drain -- and
  kills it at the grace; the lock server closes only after the sidecar is
  gone (a sidecar whose lock connection drops leaves at once, which is how a
  sidecar of a crashed gateway avoids holding the database as an orphan).
  The sidecar runs in a process group of its own, so a terminal's Ctrl-C
  reaches the gateway only. On Windows there is no SIGTERM to send: the stop
  kills the sidecar.

## The generation swap (slice 4, `swap.go`)

With a builder (`Options.Builder`, a `go/genbuild` `Builder`; `cmd/osgw
-build "node tools/gogen/osgo.mjs --fast"`), the sidecars get
`-gateway-builds` and the gateway swaps generations without a restart:

1. **Build request.** An activation that published answers `X-OSD-Build:
   published; building` from a sidecar that leaves nothing inactive
   (otherwise `published; not building: n inactive object(s) ...`); the
   gateway asks its `genbuild.Queue` for a build (debounced 500 ms, one at a
   time, coalesced) and puts the id into the answer: `published; building
   b3` (`; last build failed ...` when the one before failed).
2. **Build to the side.** The builder runs in the tree; its executable is
   stashed under `GenDir/<sha16>/` (written beside, renamed). The first
   generation is stashed too, so a replacement after a crash restarts the
   code that served, never the builder's newest output. A build that is the
   executable already serving is no swap (`ErrSameGeneration`).
3. **Candidate.** The stash is started with `-candidate`: the database file
   opened `query_only` (`abap.OpenDBCandidate`), its boot writes (seed
   normalisation, demo rows, status rows) deferred. A file whose DDL
   fingerprint (`go/dbschema`) is not the candidate's makes it write
   `RefusedFile(dir, pid)` and exit 4: the swap is refused, `X-OSD-Build:
   built; schema differs, restart needed`, the old generation serves on.
4. **Smoke.** `GET` of each `Options.Smoke` path (default `/health`;
   `cmd/osgw` adds the demo service's `$metadata`) must answer 2xx, on read
   transactions: a step that tries to write dumps.
5. **Promote.** `POST /osd/promote` (the gateway's door; a client's request
   to that path is answered 404 here): the candidate opens the file for
   writing and runs its deferred boot writes. Then the routing flips: the
   candidate is `serving`, new sessions and stateless requests go to it,
   sessions pinned to the old generation stay there.
6. **Drain, retire.** The old generation is `draining` until it has no step
   in flight and no pinned session, then gets SIGTERM (its own drain) and
   exits; past the grace (55 s) it is killed. Killed or crashed during the
   drain, it is not replaced. Its lock connection closes with it, and the
   lock server releases its sessions' dialog locks then; until then a lock
   held by a pinned old-generation session refuses a conflicting request of
   the new generation (one table, owner = generation, session, LUW).

`/osd/serving` reports `gateway.build` (`state` building / swapping / live /
failed / refused, `id`, `generation`, `why`, `swaps`, `seconds`), `hot.swaps`,
and answers with `X-OSD-Build`: `building b3`, `live go:...`, `build failed b3:
...`, `built; schema differs, restart needed`. `Swap(ctx, binary)` is the same
swap for an embedder that builds by itself.

Any failure keeps the old generation serving and is reported, never silent:
a build that fails, a candidate that does not start, refuses the schema,
fails its smoke or its promotion, or a serving sidecar that changed during
the swap (a crash replaced it).

## Not yet

HTTPS, native RFC and DIAG listeners are still the sidecar's (osgo flags for
them pass through), so they are re-bound when a sidecar is replaced, and a
candidate given those flags cannot bind them while the old generation holds
them: use the swap without them. APC sockets are proxied, not held: a
sidecar crash or a retired generation closes them. A swap over an in-memory
database is refused by the candidate (a restart is the way). No daemon
mailboxes, no hand-over of in-memory session state (by design, ADR 0010).

## API

`Start(ctx, Options) (*Gateway, error)` starts the lock server and the first
sidecar and returns once it serves; `Handler()` is the front door
(`Host().Wrap(gateway)`); `Host()`, `Locks()`, `Dir()`, `Table()`;
`Swap(ctx, binary)`, `BuildStatus()`; `Stop(ctx)` drains, `Kill()` ends at
once. `SidecarSocket`, `LockSocket`, `RefusedFile` are the names both sides
use.

No import of `osg/gogen/abap`, of generated code or of `tools/osd-*`: it
imports `go/enq`, `go/enqnet`, `go/genbuild` and `go/serving`. Tests run the test binary itself as the
sidecar (`GATEWAY_FAKE_SIDECAR=1`): pass-through, `/osd/serving`, a crash
with its locks and the restart policy, pinning, the drain, a failed start;
and the swap (`swap_test.go`, a generation = a shell wrapper of the test
binary with another `FAKE_GENERATION`): promote and retire, a pinned
session's lock against the new generation, the old one killed during its
drain, a refused schema, a failed smoke and promotion, the same executable,
the build an activation asks for. The real thing: `tools/osgw-swap-live.mjs`.

```sh
go test -race ./osgw/
```
