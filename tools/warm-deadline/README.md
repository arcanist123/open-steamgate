# warm-deadline

How long the HTTP front lets the warm compiler work before it calls the
compiler silent, kills it and builds cold (`warmOperation` in
`tools/osd-store-warm.mjs`). After such a timeout of a save or of the prime,
warm builds stay off until the host restarts, and the warm status says so
(`disabled: true`), so a client waiting for `primed` stops waiting.

## What the deadline guards

A hung compiler would hold forever whatever waits for it: the prime (and the
saves that wait for it), or a warm build. The deadline is when the front
calls the compiler dead, kills it and builds cold; warm stays off after it.
A save's own wait for a running prime is bounded separately and shorter.

A deadline that is too short is just as bad: a prime that is working, only
slowly, is killed, and the host never builds warm again. Until 2026-11-11
one fixed 30 s bound covered both a one-object save (~0.5 s) and a
whole-tree prime (20 s on a CI runner, 37.8 s on a 4-core workstation), so
the prime failed on any machine somewhat slower than a CI runner, and on CI
whenever a runner was slow.

## How it is sized

- **A save, a check**: 30 s (`OPERATION_MS`) times the speed
  factor, at most 2 min (`OPERATION_CEILING_MS`).
- **The update after a cold publication** (`kind: "update"`): sized like the
  prime, because it re-transpiles the closure of what the cold build changed
  and at most the whole registry -- after an interface is created that is 209
  objects, 13-29 s on green CI runners, which a 30 s bound cut on every runner
  slower than the reference (adt-lifecycle, 2026-11-14). Its timeout does not
  turn warm off: the compiler is killed and the registry primed again, and the
  prime's own deadline is what decides that the compiler is silent.
- **The prime**: 16 ms per input file of the compile view (`PRIME_MS_PER_FILE`),
  at least 30 s, times the speed factor, at most 15 min (`CEILING_MS`).
  Measured on the reference machine: 37.8 s for 6924 input files, 5.5 ms
  each; 16 ms is about three times that. This is the prime's lifetime, not
  what a person waits for.
- **A save that arrives during the prime** waits for it at most 60 s
  (`SAVE_WAIT_MS`) times the factor, at most 3 min (`saveWait`). Then that
  save, and every later save during the same prime, builds cold, while the
  prime goes on; a prime whose view a cold publication changed rebuilds its
  baseline and is primed again.
- **The speed factor**: a fixed single-threaded workload (strings, small
  objects, JSON, a hash), best of three rounds of ten chunks, ~60 ms on the
  reference machine (`REFERENCE_CALIBRATION_MS`). Measured time over the
  reference, clamped to 1..8: it never shortens a deadline, and a factor
  past 8 is a broken machine, not a slow one. Measured once per process. In
  the host, `measureSpeed()` runs it before the prime starts, yielding to the
  event loop after every chunk and counting only the chunks' own time, so
  requests wait at most one chunk; `calibrate()` is the blocking form for a
  process that serves nothing (a test harness).
- Explicit overrides (below) are taken as given: no factor, no ceiling.

Measured with one core and a busy loop on it (about 2.3x slower): factor
2.26, prime deadline 250 s, prime 89.9 s.

## Overrides, in order

1. `store.warmDeadlineMs` (tests that want a hang caught in milliseconds)
2. `OSD_WARM_PRIME_DEADLINE_MS` for the prime, `OSD_WARM_DEADLINE_MS` for the rest
   (and `store.warmSaveWaitMs`, then `OSD_WARM_SAVE_WAIT_MS`, for the save's wait)
3. `OSD_WARM_SPEED_FACTOR` in place of the calibration (a CI job that knows its runner)

## Not hiding a slowdown

The front logs the deadline and how it was reached before the prime, and the
prime's time against it after:

```
warm: prime deadline 117822 ms (base 110784 ms x speed factor 1.06 from calibration, calibration 63.8 ms against 60) for 6924 input files
warm: prime took 37564 ms of its 121467 ms deadline (6924 input files, speed factor 1.10, 4.93 ms per file per factor)
```

A prime that grows slower shows as a shrinking margin in that second line
long before it fails, and `test/vscode-warm-ready.mjs` fails when the last
number (seen 2.9 on CI, 4.9-5.7 on the reference machine) passes 11.5. Test harnesses that wait for a host to start and prime
(`test/store-cold-build.mjs`, `test/vscode-warm-ready.mjs`) scale their own
waits with `scaled()`, and print the factor they used.

Test: `test/warm-deadline.mjs`.
