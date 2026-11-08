# serving

The supervised-host contract of a one-process ABAP host: what a supervisor
(the VS Code launcher's `waitForServing`, vsp, a CI script) needs from the
process, the Go half of `tools/osd-serve.mjs` plus the facade in front of it
(`tools/osd-runtime.mjs`, `tools/osd-proxy.mjs`,
`tools/osd-serving-front.mjs`). ADR 0010 slice 1; the field names and
status codes are the Node host's, so one client reads both.

## What it answers

- **`GET /osd/serving`** (`Host.Serving`), while serving: `200`
  `{ready: true, pid, since, generation, hot: {swaps: 0, unverified: false},
  root, database, launcherPid, launcherIdentity?}`. `generation` is the
  build's (`buildGeneration`, `"go:"` + 16 hex of the generated program),
  `since` is the start in epoch milliseconds (the Node child's `Date.now()`), `launcherPid` is this process
  (it is its own facade), `launcherIdentity` echoes `OSD_LAUNCHER_IDENTITY`
  when a launcher set it. `hot` is there for shape: a Go process takes no
  warm swap, so the generation never carries Node's `warm-unverified`
  suffix. Another method gets the host's 404, as the Node child answers a
  door with no route for it (the facade in front of that child turns the
  child's 404 into a 503 by re-serialising it as JSON -- a quirk of the
  front, not copied).
- **`X-OSD-Generation`** on every answer (`Host.Wrap`), the 404s and the
  refusals included, equal to the body's `generation`.
- **While draining**, every request -- `/osd/serving` too -- is `503`
  `{error: {code: "STG/NOT_SERVING", message: {lang, value}}, ready: false,
  draining: true, phase: "draining", seconds, generation, pid}`: the
  facade's answer when nothing serves, with the phase a poller wants. It
  never says `starting`, so `waitForServing` does not extend its deadline
  for a process that is leaving.

## The drain

`Host.OnSignal` (SIGTERM, SIGINT, SIGHUP -- the three the Node supervisor
handles) runs `Host.stop`, all within the grace (`DefaultGrace` 55 s, the
Node supervisor's quiesce budget under the launcher's 60 s SIGKILL):

1. `Drain`: stop admitting (newcomers get the 503), wait until the requests
   in flight are answered. A WebSocket upgrade is admitted but not counted:
   a push channel's socket lives as long as its page, and its steps take the
   work process, which step 3 waits for instead.
2. `Stop.Shutdown`: close the listeners (`http.Server.Shutdown`).
3. `Quiesce`: take the work process once and run `Stop.Final` with it held
   (close the database: a WAL file checkpoints). A step that hangs holds the
   lock; at the deadline the quiesce gives up and `Final` is not run. A
   `Final` that does not return (a close stuck on a checkpoint) is bounded
   by the same deadline: left running, the stop goes on, the file recovers
   on its next open.
4. `Stop.Exit(0)`. Exit 0 also when the grace won over a step that never
   finished or a close that never returned: what is left behind is logged
   (`stopped in N ms (drained false, database closed false)`), the LUW rolls
   back with the connection, which is what the Node child does ("leaving
   anyway"). The exit code says the stop ran to its end; the grace decided
   what it left. A **second signal** during the stop exits 1 at once,
   without the drain.

Inside `Drain`, the context's wake-up takes the host mutex before it
broadcasts: a waiter is then either before its check of `ctx.Err` or
already in `Wait`, so the wake-up cannot fall between the two (a hung step
sends no other). `TestDrainCancellationBetweenCheckAndWaitIsNotLost` holds
that instant open through the `beforeWait` hook.

## Deliberate differences from the Node facade

The field names and status codes are the Node child's; this process is its
own facade, so a few things the facade adds or does are not here, on
purpose, and the shared check (`tools/osd-host-contract.mjs`) asks only for
what both truly answer:

- not in the success body: `workProcess`, `databaseIdentity` (the Node
  child's connection descriptor), the facade's `warm` and `bind`;
- in the refusal body, beyond the facade's `error`: `ready`, `draining`,
  `phase`, `seconds`, `generation`, `pid` -- what a poller wants to know,
  shaped like the facade's own `starting` answer;
- `HEAD` and `POST /osd/serving` answer as the Node child does (200 without
  a body, 404), where the facade answers 503 for both;
- the generation never carries `warm-unverified`.

Every step committed or rolled back when it ended (`abap.DialogStep`), so
`Final` commits nothing; the lock is only the proof that no step is half-way.

## API

`New(Options) *Host` (Generation required; Grace defaults to 55 s),
`Wrap(http.Handler) http.Handler`, `Serving(notFound http.Handler)
http.HandlerFunc`, `Drain(ctx) bool`, `Quiesce(ctx, sync.Locker, final)
bool`, `OnSignal(<-chan os.Signal, Stop)` (nil channel: `Signals` through
`signal.Notify`), `InFlight()`, `Draining()`, `Generation()`.

No import of `osg/gogen/abap`: the work process arrives as a `sync.Locker`,
the database as `Stop.Final`, the listeners as `Stop.Shutdown`. Standard
library only; `go test -race ./serving/...`; compiles for `GOOS=windows`
(the signal names exist there; the launcher's `taskkill` is not yet mapped).
Wired from `cmd/osgo/serving.go`.
