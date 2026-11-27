# workpool -- the work processes of a serving sidecar

ADR 0010 slice 5 ("M work processes in a sidecar"). One pool, M work
processes, one connection of the one SQLite WAL file each, one dialog step
on each at a time -- the dispatcher/work-process shape of a system, in one
process. The three database proofs the slice asks for first live in
`workpool_test.go`: parallel reads beside a held write lock; a
read-then-write step refused at the upgrade (SQLITE_BUSY_SNAPSHOT, not
covered by busy_timeout, so not replayed) where `BEGIN IMMEDIATE` takes the
write lock before the first read and cannot hit it; a hung writer with a
read and a write beside it, the fence stopping the hung statement and the
waiting write proceeding after the rollback.

What is here and what is not:

- **The step kinds** (the ADR's policy, decided by the kind of step, not by
  the transaction): `Read` runs on a connection the pool put in
  `query_only` mode -- M read steps in parallel beside a writer, a write
  inside one refused by the connection; `Write` is for the kernel to open
  `BEGIN IMMEDIATE` on. The transaction bracket itself is the kernel's
  (`go/abap` `DialogStepOn`), so this package lends the connection and owns
  what belongs to the connection: `query_only`, `busy_timeout` (the drain
  grace, `DefaultBusyTimeout`), the per-work-process statement cache.
- **The write token**: a `Write` step takes the pool's one write token
  before its work process and holds it to its end (a WAIT gives it up with
  the work process). SQLite has one writer; without the token M writers
  each waited inside SQLite's busy handler, which sleeps 1 to 100 ms
  between tries rather than waking the next writer, and the write mix
  through M work processes lost 44 % at 4 clients. A writer waiting for the
  token holds no work process, so reads go on beside it. `busy_timeout`
  stays for what writes beside the pool.
- **The fence** is `sqlite3_interrupt`, which modernc.org/sqlite exposes as
  the cancellation of the running statement's context: every step's context
  is cancellable (`Interrupt(wp)`), and the step's next statement fails and
  unwinds as a dump, its LUW rolled back. A step in a loop with no statement
  running is not fenced by this -- that is the process kill of slice 6.
- **A WAIT gives the work process up** (`Step.Yield`): back to the
  dispatcher for the sleep, another lent on return; the step handle keeps
  working because the connection under it is the pool's to swap. The kernel
  ends and reopens the transaction around the yield. A step fenced while
  it waits for a work process back holds none: its statements are refused
  (never run on a connection another step holds) and its end returns
  nothing. A dump that leaves the step's work unrecovered still gives the
  work process back.
- **A connection that cannot be proven clean is replaced, never lent
  broken.** A fenced step, or one a statement of which failed, has its
  connection scrubbed (`ROLLBACK`) before the work process goes back; a
  scrub that fails discards the connection. The work process then re-enters
  the channel only with a new one: the open is retried with a backoff
  (10 ms to 1 s) for `ReconnectGrace` (the drain grace by default), and when
  no connection can be had it is **stopped** -- out of service for good,
  logged through `Logf`, counted by `OutOfService()`, its row saying
  `Stopped` (`ZOSD_WP`; `GET /osd/serving` carries `workProcesses`). The
  pool then serves with M-1; the drain waits only for the work processes in
  service; with every one stopped a new step answers `ErrNoWorkProcess` and
  a WAIT's return holds none (its statements are refused). No lend, no
  WAIT's return and no `Close` ever meets a work process without a
  connection. The grace bounds the caller, not the number of tries: every
  attempt (database/sql admission, the driver's open, the priming) runs
  under a context that ends with the grace or with `Close`, on a goroutine
  waited for no longer than that, so a hung open or a held file lock cannot
  keep the step past it; a connection that arrives late is closed, never
  published. `Close` ends a reconnect in progress and waits for it.
- **The drain** (`Locker`): the pool as the `sync.Locker` of
  `go/serving`'s stop -- Lock stops the lending and takes every work
  process out of circulation, which waits for the steps in flight (they
  hold theirs until they end) and for a WAIT that gave its up; Unlock lends
  again.
- **The registry rows** (`Snapshot`): number, kind, state, generation, step
  started, report -- the SM50 shape, written by the host into `ZOSD_WP`
  through the status refresh (a read step is `query_only`, so the facts of
  a step's begin and end are in memory and land in the tables when the
  status is refreshed, as the other five tables' facts do).

One step of a **session** at a time is the host's rule, not the pool's: the
host owns the logical internal sessions (their statics, their turn) and
hands the pool only the step. No import of `osg/gogen/abap`, of generated
code or of `tools/osd-*`.

```sh
go test ./workpool/            # the three proofs and the pool over them
go test -race ./workpool/
```
