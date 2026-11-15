# ADT object lifecycle and timings

`tools/adt-lifecycle.mjs` creates, edits, checks and activates disposable DEVC,
CLAS, INTF, PROG, INCL and DDLS objects through the pinned ABAP-FS SDK
(`abap-adt-api` 8.4.3) and the public VSP MCP client at `.github/ci/vsp.ref`.
The objects have unique names, must be absent before creation, and are deleted
in `finally` through real lock handles. Each deletion must be followed by 404.
Source readbacks compare exact contents, allowing only CRLF normalization;
active readbacks prove publication of the edited version.

Packages have no source editing/activation operation in these clients and are
reported as N/A. ABAP-FS PROG, INCL and DDLS preflight validation currently
returns 404: these three measured gaps are reported MISSING while creation
continues. Failed validation of another kind, failed creation, failed readback,
missing operations and cleanup failures make the job fail.

## Run locally

Prepare the repository's pinned runtime, libraries and fetched packs as for
`npm run transpile`. Install the SDK with `npm ci --prefix tools/abapfs-conformance`.
Build VSP from the public commit in `.github/ci/vsp.ref`:

```sh
ref="$(cat .github/ci/vsp.ref)"
git clone https://github.com/oisee/vibing-steampunk.git .local/vsp-source
git -C .local/vsp-source checkout --detach "$ref"
mkdir -p .local/vsp-bin
(cd .local/vsp-source && go build -o ../vsp-bin/vsp ./cmd/vsp)
VSP="$PWD/.local/vsp-bin/vsp" OSD_HEAVY_RANGE=90-99 OSD_HEAVY_SLOTS=4 \
  tools/osd-heavy.sh node tools/adt-lifecycle.mjs --start
```

Use Node 22. `--start` owns a server on the reserved `STG_PORT`, binds to
loopback and uses a separate file database. It closes the server and compiler
after cleanup. It uses ONE_RUNTIME=1, matching the measured Eclipse server. The default mode can target an already isolated local HTTP
server with `URL`; it refuses external hosts and embedded credentials.
`SDK_ROOT` and `VSP` select installed dependencies, and `OUT` selects the
report folder. The default is `.local/adt-lifecycle/report`.

## CI and performance comparisons

The `adt-lifecycle` job in `tests.yml` runs on its own runner beside the six
suite shards, using the same built-tree artifact. It is required by the
`test` gate. Its summary is appended to the overall PR test comment and
uploaded with JSON evidence and the server log, including when a run fails.
Raw local timings are not used as runner thresholds.

Each source object is edited three times; each edit changes its contents.
The report includes every sample and its median. SDK Save includes lock,
write, unlock and readback. VSP WriteSource includes Check and Activate;
these timings measure different client operations. Initial creation and
activation are separate from repeat edits. Compiler readiness is awaited
before each repeat. A compiler dropped by its normal memory guard is prepared
by activating the unchanged baseline; this preparation is separately reported
and excluded from edit medians. For CLAS, INTF and INCL, a generation change and an
increase in warm swap count are required. An unexpected cold publication
fails even when its timing happens to be fast. REPORT and DDLS presently
remain cold; their repeat timings are measured and compared too.

CI timing is advisory; only functional operations, active readback, cleanup,
MISSING allowances and warm-path correctness determine the required job and
PR row. Every sampled operation median is divided by a same-run reference:
the median of four cheap untouched controls, ABAP-FS CLAS/INTF `edit` and
`readback-active` medians. The fixed class/interface pair excludes larger
program/include/CDS reads and compilation work. All four controls must have
positive finite medians; otherwise comparison is pending.

The workflow collects up to five compatible green `main` push runs, newest
first, looking through the latest 30 successful runs of `tests.yml`. Collection
stops after five usable runs or 170 seconds (including requests and unzip),
with a three-minute step timeout and `continue-on-error`. Recipe,
SDK, VSP, runtime/library pins, Node major, OS and architecture must match.
Each main run is normalized by its own reference; the median of those
normalized values is the operation's baseline. One artifact per run is used,
trying the newest `adt-lifecycle-attempt-N` first. Missing, expired, unreadable,
invalid or incompatible artifacts are skipped. Fewer than five usable runs
are accepted, with their count, commit identities and reference medians in
the summary; no usable history is explicitly comparison pending. API failures
leave fewer baselines or comparison pending with an explanation, preserving
functional gates. The required functional report runs immediately after the
measurement step with `if: always()`, before history collection, and saves its
PASS/FAIL and summary. The optional combined report runs after collection even
if collection fails or times out; unreadable history leaves timing pending.
Only the first report step can fail the gate, and its fallback summary remains
available if the optional report fails.

A warning fires when at least **two operations are strictly above 1.3x** their
normalized historical median, or **any one reaches 2.0x**. A single operation
between 1.3x and 2.0x is shown above margin but stays quiet. Triggered warnings
produce a GitHub annotation and a summary section with raw medians, normalized
medians, ratios and baseline counts; they never change the report's functional
PASS/FAIL or CI exit code. Raw main milliseconds are shown for context only.
A uniform runner slowdown cancels out; a regression in the reference controls
can mask slowdowns, so retain raw measurements for investigation.

The VSP family's `params.timeout` is a functional-result bound, not part of the
TIMING rule, and the 90 s the lifecycle passed for every operation was too thin
for one family: a DDLS activation re-runs the CDS generator and a cold build
inside the same call, and two CI runs — #922 at 6e3b2ca7f and #908 at
60c10bcfe — failed on `WriteSource timed out after 90s` while every full rerun
passed. #926 at 43224485647 is sometimes named beside them and was a different
failure: both of its attempts were cancelled at the job's 40-minute cap on a
slow runner, its only FAIL row is an INCL warm-swap, and neither attempt's log
holds a DDLS timeout — a failure this margin does not address. The measured
numbers behind the fix: about 50 s per DDLS update on a green CI runner; 79–92 s
on the runner classes that failed, where the failing activations were cut at
the budget and their true duration is unknown; 98.1 s for an ABAP-FS
activation-edit on the slowest of those runners; and 48.9–52.9 s per DDLS
update sample in the DIAG-7 i3 measurement under one lock. a4h-i7 had already
given the osd-adt-one-runtime root hook 180 s for the same reason (#908).

The DDLS family's budget is therefore 240 s — about 4x the green-runner median
— as a floor rather than a ceiling: 240 s × the measured-speed factor of
`tools/warm-deadline` (honoring `OSD_WARM_SPEED_FACTOR`), clamped to
[240, 480] s. The floor is load-bearing because the calibration under-tracks
this cost: it runs single-threaded and idle in the harness process while the
activation builds under the lifecycle's own concurrent load. Across the
recorded runs the factor moved only 1.00–1.29 while the DDLS cost moved 1.7–2x,
so the first cut of this fix — 90 s × factor, clamped to [90, 240] s — would
have handed the very runners that failed a budget of 104–116 s against
activations that had just outgrown 90 s. With the factors CI has actually
measured (1.00–1.29), a runner receives 240–310 s. Every other operation keeps
90 s, the client-side rpc ceiling in `adt-lifecycle-vsp.mjs` rides above the
widest budget by a minute of slack (it only ever catches a dead VSP, never a
slow activation), and the timing rule is unchanged: a slow DDLS still can never
fail the gate, a timed-out one always did. The adt-lifecycle job's
`timeout-minutes: 40` stays as it is: a green run measures 21–24 minutes, a
DDLS call that consumes its whole budget fails the gate regardless, and the cap
bounds a pathological run's wall time — the price is that a slow failure can
arrive as a cancellation rather than a red row (as #926 shows), so read the job
log for the cancel marker before treating a cancellation as flakiness.
`test/adt-lifecycle-report.mjs` pins the values, the three call sites and
the ceiling ("VSP call budgets").

The interface family's create+write+activate call takes the same budget
(2026-11-14): 51-72 s on good CI runs, cut at 90.0 s on slow runners three times
on 2026-11-13. The first creation in the family builds cold, as a DDLS
activation does; the interface's edits and explicit activation keep 90 s.

**One rule since 2026-11-14, not a list of types.** The next red was the PROG
create, cut at 90.0 s on a 1.11 runner: every create builds the tree cold, and
the per-type list had covered only DDLS and the INTF create. Measured over 27
runs (median / max on factor-1.00 runners / max on slower ones, seconds):

| VSP step | median | max @1.00 | max >1.00 |
|---|---:|---:|---:|
| CLAS create+write+activate | 52.6 | 56.0 | 69.6 |
| INTF create+write+activate | 75.6 | 82.2 | 101.7 |
| PROG create+write+activate | 63.9 | 75.7 | 90.0 (cut) |
| INCL create+write+activate | 66.5 | 73.2 | 83.8 |
| DDLS create+write+activate | 65.7 | 78.4 | 87.3 |
| PROG edit+check+activate (cold: no warm PROG) | 63.2 | 71.1 | 81.6 |
| DDLS edit+check+activate | 75.5 | 85.4 | 101.2 |

`vspCallTimeoutS(type, op)` in `adt-lifecycle-vsp.mjs` is the only source of a
VSP budget: the cold-build budget (`coldBuildTimeoutS`, 240 s × factor within
240-480 s) for every create, every explicit activation and every call on a
type the warm compiler does not build; 90 s only for a content edit of a warm
type (`WARM_TYPES`: CLAS, INTF, INCL, the same set the swap check reads; those
edits measure 4-9 s, one outlier of 28.7 s in 201). A type added to the lifecycle starts on the cold budget.
`test/adt-lifecycle-report.mjs` pins it for every type in the fixture table
and an unknown one, and that the lifecycle has exactly three `timeout:` sites,
all through the function. The job's cap is 60 minutes (#948); green runs take
23-39 minutes, and a call that uses its whole budget fails the gate anyway.

The wait for the warm compiler (`warmReady`) takes the same budget too
(2026-11-14, `warmReadyTimeoutS`). On the slow runner of #942 (speed factor
1.19) the interface's create took 101.7 s and pushed the warm compiler past its
own deadline; it re-primed behind two 29-36 s verification comparisons, and the
fixed 90 s wait ran out with no prime started. On green runs the same wait is
about 54 s (a 29-37 s baseline activation and a 15-30 s prime).

That reading was wrong, and the longer wait did not help (2026-11-14, 7 red of
24 runs, on main's transpiler pin and on the newer ones alike): the deadline
the interface create overran was that of the **registry update after the cold
publication**, a fixed 30 s x speed factor for a re-transpile of 209 objects
that took 13-29 s on the green runs, and a timeout there turned warm off for
the life of the host. The status then said `cold` forever, the log said
`re-prime` for a prime that never came, and `warmReady` waited out its whole
budget. Every red run had exactly one `warm compiler exceeded` on that update
(speed factor 1.02-1.19, cut at 30.6-35.6 s); no green run had one. The update
is now sized like the prime (`kind: "update"`, `tools/warm-deadline/README.md`),
its timeout drops the compiler and re-primes instead, the warm status carries
`disabled`, and `warmReady` fails at once with the reason when it is set
(`test/warm-update-timeout.mjs`).

A third red of 2026-11-14 (#946, a fast runner: speed factor 1.00,
calibration 34.9 ms) was not a budget: VSP's explicit activation of the class
failed in 1.6 s with "a build is already running". A frozen verification had
just settled and the next one had started; a verifier takes the build lock for
milliseconds to pin its generation and to settle its verdict, and a store
build refused on the first BUSY. Store builds (warm and cold) and a host's
start build now wait for the lock up to 10 s (`tools/osd-build-lock-wait.mjs`,
`OSD_BUILD_LOCK_WAIT_MS`; an empty or non-positive value is the default) before
they answer BUSY, and a build of another process still gets BUSY. The first
attempt is unchanged; on BUSY only the lock is polled, and the cold build then
runs once more under it (`lockHeld`), so its whole-tree hash runs twice at most
rather than once per poll (`test/build-lock-wait.mjs` counts it).

`test/adt-lifecycle-report.mjs` transcribes the real #635/#633/#636 tables as
JSON fixtures (all QUIET), injects one 2x operation slowdown (WARN), uniform
1.6x runner slowdown (QUIET), isolated sample outliers, and five-run history
with differing runner speeds. It also checks CLI annotations and exit codes,
artifact fallback, collection timeouts, malformed baseline warnings for passing
and failing current runs, missing cleanup, failed validation/readback and MISSING
allowances. `test/osd-suites.mjs` checks that a warning retains the green
functional PR row and a functional failure keeps that row and `test` red.

## Initial local observation, 2026-10-05

The initial single-pass matrix produced 73 PASS, three MISSING validations,
four N/A package operations and zero FAIL. All 12 objects were deleted and
confirmed absent. These are local observations, not CI baselines:

| Object | SDK repeat activation | VSP edit + Check + Activate |
|---|---:|---:|
| CLAS | 2.4 s | 4.2 s |
| INTF | 2.5 s | 4.2 s |
| INCL | 2.6 s | 4.3 s |
| PROG REPORT | 28.0 s | 33.9 s |
| DDLS | 28.0 s | 33.8 s |

The protocol layer uses the actual clients. A real VS Code editor UI or
Eclipse wizard is outside this script's coverage.

## Three-sample local validation

The CI recipe passed with 123 PASS, three MISSING preflights, four N/A
package operations and zero FAIL; all 12 objects were deleted and confirmed
absent. Repeat activation medians were CLAS 2.333 s, INTF 2.419 s, INCL
2.416 s, REPORT 27.300 s and DDLS 26.738 s. VSP combined repeat medians
were 3.906 s, 3.981 s, 3.997 s, 32.030 s and 31.940 s respectively.
The full local run took approximately 15 minutes, including compiler
preparation and cold builds; GitHub runner duration remains unmeasured.
All 87 focused comparator/suite-reporter tests passed, actionlint and
suite registration passed. A sustained 15 s class-activation injection into
the real report exited 1 under the original blocking rule and named the operation; unchanged evidence compared
to itself passed. A clean VSP checkout build passed exact-commit metadata
validation and a real SyntaxCheck with the diagnostics parser.
