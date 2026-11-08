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
  `since` is the start as Node's `Date` JSON, `launcherPid` is this process
  (it is its own facade), `launcherIdentity` echoes `OSD_LAUNCHER_IDENTITY`
  when a launcher set it. `hot` is there for shape: a Go process takes no
  warm swap, so the generation never carries Node's `warm-unverified`
  suffix. Another method gets the host's 404, as express answers a door
  with no route for it.
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
   lock; at the deadline the quiesce gives up and `Final` is not run.
4. `Stop.Exit(0)`. Exit 0 also when the grace won over a step that never
   finished: it is left behind and its LUW rolls back with the connection,
   which is what the Node child does ("leaving anyway"). A **second signal**
   during the stop exits 1 at once, without the drain.

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
