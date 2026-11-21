# The warm compile: a save in half a second

*Measured 2026-09-25 on one 16-core x86-64 workstation (i7-10700K), Node 26
and the Bun 1.4.2 binary, on this tree (1728 objects, 976 source files,
5107 hashed inputs).*

A save of a class used to reach the running system in about 18 seconds:
the parent's check (3.1 s, a reparse of the tree), the cold build (11.3 s,
twelve generators and a transpile of every object) and a recycle of the
serving process (3.0 s, most of it the start-up's own checks). With
`OSD_WARM=1` it is under half a second:

| the save | before | warm, Node | warm, Bun binary |
| --- | --- | --- | --- |
| a class a few objects read (the demo DPC, 3 objects rebuilt) | ~18 s | **455–504 ms, median 463** | 540–568 ms, median 550 |
| an interface 141 objects read (`ZIF_STG_CDS_SOURCE`) | ~19 s | **1.94–2.07 s** | not measured |

The time is from the write of the file to the first OData answer that
carries the change (the class) or to the dev loop's own line (the
interface), five runs each, through the real dev loop (`STG_DEV=1
OSD_WARM=1`). Of the 463 ms, the build is ~410 ms (~290 of it the
transpile of the three objects) and the swap is 4 ms; the rest is the file
watcher and a 30 ms debounce.

## How it works

For ADT Save, Check, and the difference between class replacement and program
runtime recycling, see [ADR 0009](adr/0009-warm-adt-check-and-activation.md).
ADT Save only writes source; the warm compiler is used on Check and Activate.

STORE ACTIVATE uses the same activation publisher as ADT
(`tools/osd-publish-activation.mjs`): capture the checked revision, publish via
`ObjectStore.publish`, and promote only when that revision matches the build's
reads and current source. STORE validates synchronously in the source host's
retained registry, updating changed files and dirtying their transitive readers.
A primed compiler also checks the affected closure during the build for both callers.
Eligibility, inactive-source isolation, cold fallback, swap refusal/recycle and
verification retain the rules below. STORE's durable operation reports the
warm generation ID and `live:true` after an acknowledged swap, with
`verified:false` until the cold comparison succeeds. ACTIVATION_STATUS reads
the current verification observation without mutating the completed operation;
RUN_TESTS pins that same published generation even before comparison.

1. **The registry is kept in a compiler process.** `tools/osd-warm.mjs` holds the abaplint
   registry of the live generation for as long as the process lives. It is
   primed once after the runtime is up. `tools/osd-warm-process.mjs` starts
   `osd-warm-worker.mjs` through `osd-host.mjs`, including in the Bun binary
   and VSIX host. Both the full prime and subsequent warm builds run there;
   the launcher can answer HTTP and proxy requests throughout. The warm
   path becomes available only when the prime completes. An activation
   during priming waits for it at most 60 s times the host's measured
   slowdown, then builds cold while the prime goes on; the prime's own
   deadline is sized by the tree (`tools/warm-deadline/README.md`). Other
   requests keep using the serving generation throughout. A silent compiler, exit, or IPC loss kills and
   awaits the compiler before building cold; later publications stay cold
   until restart. The inactive-source metadata is sent with each operation. The
   prime checks its premise rather than assuming it: a full run of the kept
   registry must give the live generation's files byte for byte.
2. **A save builds what it reaches.** The changed file replaces its copy in
   the registry, and the transpiler builds the edited objects and,
   transitively, their readers, taken from abaplint's scope references
   (`only`). This needs three transpiler changes, all offered upstream under
   [abaplint/transpiler#1898](https://github.com/abaplint/transpiler/issues/1898):
   [#1899](https://github.com/abaplint/transpiler/pull/1899) (temporary names
   numbered per object), [#1900](https://github.com/abaplint/transpiler/pull/1900)
   (`only`) and [#1921](https://github.com/abaplint/transpiler/pull/1921) (a
   second run with `only` checks the chosen objects, not the registry).
   `probe()` tries them on two classes at start; without them the warm path
   says which is missing and every build stays cold.
3. **The generation is an ordinary one.** Hard links to the live
   generation's files (2529 files, 24 ms), the rebuilt modules and the
   scripts written over them, the manifest a cold build would write, named by
   the same hash of the inputs, switched to by the same rename. The input
   hash is per-file digests kept by stat, and the libraries' walk is kept
   while a watcher on each hears nothing: 155 ms became a few.
4. **The serving process takes the modules.** `tools/osd-hot.mjs` loads them
   under the work-process lock, between two dialog steps. A transpiled module
   registers its class itself (`abap.Classes['ZCL_X'] = zcl_x`) and runs its
   class constructor when evaluated, and everything else reaches a class
   through that table at call time; the only bindings a module holds are its
   static imports, and each rebuilt module's imports are rewritten to the
   instance the process already has. The copies go to
   `build/hot/<generation>/`, file URLs with `?swap=N`, so stack traces and
   source maps read as files and a generation swapped back to is evaluated
   again.

## The build view, with objects inactive

The source lock covers only snapshot and publication turns. A snapshot in
`osd-store-compile-view.mjs` captures the overlay, inactive source metadata,
and input digests, including generated sources read by prime. Compilation
runs outside that lock. The child checks the snapshot's hash before reading,
and checks source and library bytes against their digests before adding them
to its registry. Cold builds also check their expected hash, read digests and
generator-input stamps. Saves, creates, deletes and promotions can proceed
while either compiler works.

The compiler builds beside the live generation without switching it. Under
the source lock, the parent compares the current activation view's digest
with the snapshot before switching. A mismatch discards that result and
retries the current view; the response records the number of superseded
attempts. Unrelated inactive edits remain excluded on the retry. Priming
uses the same checks and catches up on intervening saves before warm becomes
available. Its process deadline and shutdown/reaping rules still apply.

`test/warm-process.mjs` pauses compilation before hashing and after generation
construction. Saves must finish within 200 ms, while no stale or unrelated
inactive source reaches the live generation. It also covers a cold-build
retry and saves both before and after prime has loaded its registry. Other
regressions inject a CPU-bound hung prime, child exit and IPC loss; cold
fallback returns only after child exit.

An ADT save makes its object inactive, and an inactive object is kept out
of every build (`ObjectStore#overlay`, #460): its last active copy from
`build/inactive/active/`, or nothing when it never had one. The registry is
primed from that view and not from the raw tree, and an activation of a set
S is a warm edit of it: S's saved sources replace their copies, every other
inactive object keeps serving its copy, before and after. A file is known by
its place in the tree, whichever copy the view reads (`#logical`), so a
promotion is a content edit and the warm rule applies to it as to any save
(a new object, `INTERFACES`, AMDP and generator inputs stay cold). A file
the view reads from elsewhere with the same bytes is rebuilt for its source
map, which names where it was read. A refused build leaves the registry on
the old view (the edit held, reverted by the next build that does not
activate it). The comparison runs a cold transpile of that generation's frozen
view, including the active-copy source-map locations. A prime that is due after
a nonincremental cold build runs at the
next activation if the five seconds have not passed, since an ADT client
saves and activates at once. A prime whose view names the live generation
differently (an object saved since, read from its copy) is accepted only on
proof that the saves since are the whole difference: the live view rebuilt
-- those objects read from the tree as live read them, each file counted
with its active copy's digest -- must hash to the live name exactly, so a
generator input (a `.stg.yaml`), a library, the config or a generator that
changed since refuses the prime and the build goes cold. A full run of the
registry cannot see those (it transpiles today's `gen/`), and neither can
the comparison. The registry then takes live's file order (a copy is listed
after the tree, and `init.mjs` loads objects in that order), and each
copied file is placed where the live source map says it was read from.

Before this every activation through ADT was cold. Measured on the stand-in
(create, two edits, delete, twice; `OSD_WARM=1 STG_DEV=1`): 110 s and 7
boots with every activation cold, then 77 s and 4 boots with both edits
warm (1.5 s each); with the proof, 103 s and 5 boots, both edits warm (the
second after a prime on demand, 18 s in all).

## What is warm, and what is cold

The generators read the tree too, and a change one of them would see has to
reach them. Read off each of them (`GENERATORS_READ`, pinned by
`test/warm.mjs` so a new generator makes somebody read this again), an edit
is warm when it is a **content edit of an existing class or interface**
outside `gen/`, **with no AMDP body** before or after (amdp-gen reads those),
**the same `INTERFACES` lines** (osd-tran-registry reads them), and for an
interface, **no AMDP class naming it** (amdp-gen reads interfaces as type
sources). A new or removed file, DDIC, CDS, SICF, IWSV, a YAML, a library,
the config, a page or a generator is the cold build, after which a bounded delta advances the compiler child's kept registry. Up to
100 added, changed or removed class/interface/include files (and their object
XML) use abaplint add/update/remove, reparse their dependent closure, and prove
the affected outputs and scripts against the cold publication. An added file
also invalidates every object with any unresolved syntax reference and its
dependent closure: missing targets have no resolved edge in the old graph.
Re-indexing then records newly resolved readers for later warm edits. The kept config
and unrelated syntax results survive (#1921). The `$TMP` author sidecar
`local/tmp/tadir.json` is retained in the byte proof but never passed to registry
mutation: abaplint admits no object for it, and VSP creation changes it. `warm: updated ...` reports its
cost. Config/layer/library/toolchain changes, generator inputs such as AMDP or
`INTERFACES`, larger deltas, or a failed byte premise log `warm: re-prime: ...`
and require a full prime.

Background comparisons yield to a full registry prime: an already running
frozen comparison has up to 30 seconds to finish. On timeout the front kills
and reaps that verifier before priming; queued comparisons resume once priming
settles. Saves remain available during that wait. Verifiers also have a
180-second lifetime deadline, and acquiring their build-lock pins is bounded.
This prevents a silent verifier from blocking later cold publications.

## The checks, and why each exists

- **The importer check.** A module a warm build does not replace keeps its
  binding to the old instance of anything it imported. So before a swap,
  every module that statically imports a rebuilt one must be rebuilt too;
  otherwise the build is refused as not warm. The scope references are the
  plan; this is the check on it.
- **The comparison with a cold transpile.** After a warm build, a child
  process transpiles the same inputs cold into a scratch folder and compares
  the output byte for byte (`osd-warm.mjs verify`). Until it has passed, the
  generation answers `X-OSD-Generation: <hash> warm-unverified`, and
  `<hash>.warm.json` beside it says so -- a process started later on it says
  so too, and a cold build never takes it as a cache hit: it builds it again
  and replaces it if the bytes differ. A difference found by the comparison
  rebuilds cold, recycles and primes the replacement compiler. IPC failure
  events reject only requests belonging to their child, so a retired child's
  late disconnect cannot disable its replacement. Discarding a busy baseline
  requests cold fallback before killing the child; its disconnect cannot mark
  the compiler unavailable. Measured: 2529 files, 0 differing, 8.5 s in
  the background. `compile-inputs.json` retains the exact source/library order,
  config and source-map locations, with raw bytes addressed by `source-inputs.json`
  in `build/source-by-digest`. Cold and warm builds, priming, updates and
  verification share `orderRegistry`: an unparsed cold registry supplies its
  native object order, including admission rules and name groups, while warm
  retains its parsed objects and caches. A non-object file such as
  `local/tmp/tadir.json` therefore cannot move the library's TADIR schema or
  metadata rows ahead of T000/T100. Constructor script order follows the same
  rule. The frozen config names `output`, without a scratch path or process ID,
  so repeated packaging of identical inputs keeps the same seed ID. The verifier
  builds a fresh registry solely from
  these inputs. Live edits, cold publications and library/config changes cannot
  invalidate its inputs. A concurrent replacement of the same generation hash
  supersedes the comparison: manifest identity and the sidecar captured before
  spawning must still match before the parent records a verdict under the
  build lock. Sidecars are written atomically, and a vanished sidecar always
  settles the promise as superseded. Successful verifications are acknowledged
  to the worker; both processes prune unchecked hashes against retained and
  in-flight generations instead of keeping historical verdict sets.
  Missing frozen inputs or output, and zero compared files, are
  `inconclusive` with a reason; corrupt provenance is a failure. A verifier pins
  its generation and scratch directory under the build lock until comparison
  finishes, so concurrent GC retains both and their frozen source bytes. Pins
  expire after five minutes even if their PID was reused; GC then removes
  their scratch, and removes warm sidecars with unpinned generations.
  **It runs no
  generators**: it compares the transpile of the frozen
  `gen/`, so it checks the warm build and not the rule of what is warm; a
  generator reading something the rule lets through would go unseen by it
  until the next cold build.
- **One lock, one read.** The build lock is held from the first read of the
  tree to the switch, and a file is read once: its bytes are hashed against
  the digest the generation is named by, and a save that lands in between is
  refused rather than named wrongly. What the compiler knows of the tree
  changes only once the new generation is live; an edit the transpiler
  refuses stays in the registry and is built with the save that fixes it,
  and any other failure drops the registry.
- **What the process holds itself.** `osd-serve.mjs` imports a few modules
  (the ICF shim, the APC host, the registries, the status writer) and keeps
  them: a build that rebuilds one of those is recycled, not swapped
  (`HOST_HELD`, kept equal to its imports by a test). The gateway's model
  cache (`zcl_stg_model_info`) is cleared after every swap, so an edited
  `_MPC_EXT` is read again.
- **The catch-up recycle.** Every swap leaves its old module instances in
  the module map, and the init script's repository rows are only refreshed
  by a start. After 25 swaps, a heap 512 MB
  larger than at the first swap, or a minute without a save
  (`OSD_WARM_SWAPS`, `OSD_WARM_HEAP_MB`, `OSD_WARM_QUIET_MS`), the process
  is replaced by one started on the live generation, and `build/hot/` goes.
  A recycle cuts every APC WebSocket, so the swap count and the quiet
  minute wait while a client holds one (counted by the upgrade proxy,
  `tools/osd-proxy.mjs`, released at the close or the end of either side).
  The quiet recycle is asked again every quiet period while a socket is open
  (so it may come soon after the last one closes), and the swap count at the
  next swap. With several work processes each one's heap growth counts. The
  heap limit does not wait: it is the safety limit. PIA's terminal dropped
  in 1-2 turns of 15 while a turn waited on its model (2026-10-06).
  A save or an activation restarts a pending quiet period, and a quiet
  timer that fires while an activation is running or queued waits another
  period: otherwise the recycle can land on that activation and turn its
  warm swap into a cold load (adt-lifecycle on #625, 2026-10-07).
- **One activation per save, answered once it is live.** `publish()` runs
  one at a time per store, and a caller whose tree is the one already
  queued, or the one a build in flight named its generation after, takes
  that publish's answer instead of building again behind it: the dev loop
  and VS Code's activation of one disk save are one build and one swap, and
  both answers carry `X-OSD-Swap-Ms`. A build the serving process already
  runs (same generation, same process) loads nothing -- no swap, no
  recycle, sessions kept -- and says how that process got it. A catch-up
  recycle a swap brings (the swap limit, the heap) is awaited by that
  swap's activation, which then answers cold with the reason. A runtime
  changing hands is waited for while its boot keeps talking, and the
  activation fails, saying so rather than hang, once it has said nothing
  for `OSD_TRANSITION_MS` (60 s) -- silence, not slowness, as the
  runtime's own boot limit already was. A fixed 60 s had turned a boot
  that was slow and correct into a failed activation (vsp-i7, 0.6.1511: a
  boot past 60 s under load, the cross-reference alone 21.6 s).
- **A save is not an activation.** The dev loop (`STG_DEV=1`) never builds
  a file of an object that is inactive and still holds the version saved
  through the store (`ObjectStore#savedInactive`): an ADT create or save,
  whose activation is the façade's. Without this every create and PUT
  through the façade was a cold build and a recycle of its own -- 21
  recycles in vsp-i7's suite, 1.52x the cold run's wall time, and the
  activation behind them timed out -- and the build made a saved-only
  version live. The rule reads the store's persistent inactive set, not a
  record of the write: it ends with the activation, the delete, or bytes
  that differ from the saved version (`outside`, which the dev loop builds
  and activates like any other editor's change). So the same bytes again
  -- another editor, a checkout, a watcher event that comes late, a retry
  after a failed activation -- stay that inactive source until somebody
  activates it. A delete is not covered: it takes effect at once, as on a
  system, and the dev loop builds the tree without the object.
  Measured on a create, two edits and a delete, twice
  (`OSD_WARM=1 STG_DEV=1`): 290 s and 10 recycles before, 83-90 s and 2
  recycles after, both edits warm (1.3-1.5 s).
- **The prime waits for a runtime changing hands**. Frozen comparisons keep
  at most two pending generations alongside one running comparison. The current
  generation takes the next turn; older pending work beyond the limit, and work
  deleted by GC, is logged as "superseded, not verified". Unchecked generations
  keep their disk verdict. Cold builds keep the running comparison alive,
  and front shutdown explicitly terminates the verification child. The
  prime formerly blocked the process that supervises the runtime; landing
  in the middle of a recycle made that recycle read 17-30 s slower. It now
  runs in its own compiler process. Closing the front kills and awaits that
  process, including during a CPU-bound prime; the exit reaper also covers
  launcher shutdown.

Startup regression measured on 2026-10-04: the supplied bare VSIX smoke
reported its first `/osd/serving` answer **12.99 s after Start resolved**,
beside a **12.833 s** prime. With the compiler process, the same bare VS Code
1.101.2 harness and a rebuilt VSIX answered in **0.27–0.34 s** across two runs.
The checkout regression (`test/vscode-warm-ready.mjs`) answered serving in **0.127 s**
and its first ADT classrun in **0.103 s**, both while still priming, then
kept polling through the full run. `test/warm.mjs` also covers activation
during priming, inactive source views, comparison and process cleanup. A
seeded Bun binary with no tool scripts in its test checkout answered serving
in **0.143 s** and classrun in **138 ms** during an **18.077 s** prime.

Round 2 verification (2026-10-04), with `npm run binary -- --seed` and
`build/osd up` in a newly materialized standalone home:

| Measurement | Result |
| --- | --- |
| First `/osd/serving` after Start resolved | **0.108 s** |
| First classrun, still priming | **0.119 s** |
| Full prime, front polled throughout | **16.093 s**, 1537 files |
| Warm activation, including front work | **7.533 s**, acknowledged swap **3 ms** |
| Parent RSS after prime | **1372.0 MiB** |
| Compiler RSS after prime | **2385.9 MiB** |
| Combined parent/compiler RSS | **3757.9 MiB** |

The parent registry and `UnitRisk` graph prewarmed in `test/start.mjs` serve
ADT Unit discovery, test plans and risk/xref reads. They are retained for those
reads, independently of the compiler. The RSS total above includes both
processes, measured after the prime with that prewarm enabled. The serving
runtime is a third process and is outside this two-registry total. The compiler
has its own **512 MiB heap-growth limit from the completed prime**: after a
build exceeding it, the process is reaped, its published generation is kept,
and the next activation primes a replacement. This supplements the serving
runtime's existing 512 MiB growth and 25-swap recycle limits. A regression
injects a smaller compiler threshold and verifies the generation survives.

The binary run initially exposed classrun's cached-module export after an
acknowledged warm swap: it still printed the old value. Classrun now resolves
the live class from `abap.Classes`, and the successful run verified the changed
output after activation. `vscode-warm-ready` repeats that cached-import case;
`vscode-warm` now starts the supervised child host and waits for priming instead
of accepting an inline host's permanent "not primed yet" state.

The final focused run passed **78 tests**: the original 71 plus five compiler
process regressions and two platform kill-strategy tests. All eight files ran
with the isolation hook: no leaked compiler workers or processes, and no new
allowances. `vscode-warm` used its existing bounded restored-source generation
allowance, with a real **7 ms** warm swap. The checkout startup check measured
**0.145 s** for serving and **0.126 s** for classrun. The injected hung prime
completed cold activation and a subsequent publication in **612 ms** with a
500 ms compiler deadline. Suite registration lists 308 ordinary and seven
grouped suites; the changed-file size guard passes without raised budgets.
The store, ABAP destination and launcher checks added **166 passing tests**
under isolation (244 passing across the two final focused runs).
The full guard still reports five inherited breaches in untouched files.
Local evidence is under `.local/warm-round2/`, including the failing race
control and the first binary run that exposed the stale classrun export.

Round 3 verification (2026-10-04), after replacing the compile-wide source
lock with snapshot and publication turns:

| Measurement | Result |
| --- | --- |
| Save during paused prime or warm/cold compile | **under 200 ms**, asserted before resuming the compiler |
| Fresh seeded binary: first serving answer after Start | **0.137 s** |
| Fresh seeded binary: first classrun, still priming | **0.132 s** |
| Binary prime, front polled throughout | **14.619 s**, 1537 files |
| Binary warm activation and acknowledged swap | **7.168 s**, swap **3 ms** |
| Bare VS Code 1.101.2: first serving answer after Start | **0.27 s**, supplied baseline **12.99 s** |
| Checkout startup: serving and classrun during prime | **0.107 s** and **0.123 s** |
| Checkout VS Code warm swap | **6 ms** |

All **83 focused tests**, **166 store/destination/launcher tests**, and
**45 build/active-version tests** passed with isolation (**294 total**).
Five new compiler-process regressions cover save latency, superseded builds,
publication after a late save, and prime catch-up before warm is advertised.
The paused dispatch/hash contamination regression still passes: B's inactive
edit never enters A's live generation. No new isolation allowances were added
and no compiler workers or processes leaked. The existing `vscode-warm`
restored-source generation allowance still applies.

Suite registration has no drift (308 ordinary and seven grouped suites).
The changed-file size guard passes with no budget increases; the full guard
has four inherited Go breaches outside this change. Extracting retention and
input race checks reduced `osd-build.mjs` below its 1000-line limit. The
structural leak scan found no matches; the private identifier check remains
unavailable because this checkout lacks `.local/leak-identifiers.json`.
Evidence, including the failing save-latency controls, is under
`.local/warm-round3/`. The final seeded binary and rebuilt bare-system VSIX
both exercised the compiler child through `osd-host.mjs`, after rebasing onto
`origin/main` at `45d2e383` (extension metadata and documentation only).

Round 4 verification (2026-10-04), rebased onto `origin/main` at `b78d2a91`:
the xref failure was a direct compiler caller assuming the registry survived
every build. The compiler may reap itself after heap growth. The fixture now
completes its direct activations and awaits the public `prime()` result after
recycling, before editing again. It also forces a recycle before the SQL
refresh failure case. The only `not primed` throw is `WarmCompiler.build()`;
ADT publications already await the store's in-flight prime, with the existing
30-second compiler deadline and cold fallback. The heap regression now proves
both the direct-call refusal and a successful warm publication after it.

The helper allow-list names the compiler child and its reason: it dispatches
through `osd-host` and must not receive the HTTP/ABAP-FS token. Its environment
now retains only OS paths, host execution options and build source selection.
An actual child-process regression checks the bridge and batch tokens,
PostgreSQL/HANA passwords and an arbitrary secret. Restoring the old broad
environment makes that regression fail on the four secrets the shared helper
did not scrub.

Both failing files passed **43 tests** under the CI isolation and no-retry
hooks. The full focused group passed **84 tests** (83 existing plus the
credential regression), and store/destination/launcher passed **166**. No
compiler processes leaked and no isolation allowances were added. The checkout
startup test answered serving in **0.108 s** and classrun in **0.112 s** while
priming; `vscode-warm` completed a **7 ms** swap. Suite registration still lists
308 ordinary and seven grouped suites. The changed-file size guard passes,
without raised budgets; four inherited Go breaches remain outside this change.
Structural leak checks found zero matches; the private identifier list remains
absent. Evidence is in `.local/warm-round4/`. Binary and bare VSIX smoke were
not repeated in this round; their prior measurements above remain separate.

Incremental/frozen-input probe (2026-10-06), on an isolated copy of this
checkout, using the pinned compiler child and ObjectStore publication path:

| Measurement | Result |
| --- | ---: |
| Baseline cold build, 2334 objects | 23.105 s |
| Initial prime, 1877 source files | 16.779 s |
| Create: expected cold publication including registry update | 27.935 s |
| Incremental update, 2 files / 1 object | 5.182 s |
| Next activation: edit the created class | 1.692 s warm |
| Edit the existing demo DPC | 1.442 s warm |
| Frozen comparisons, 3543 outputs each | 16.445 s / 16.588 s, zero differences |

There was exactly one prime and zero superseded publication attempts. These
are compiler/publication timings with no serving runtime attached; the
runtime swap path is covered separately by the VS Code and ADT xref suites.
The update pays for rebuilding the dependency index during the cold creation,
so the following activation pays only for its warm delta. The first full-tree
attempt exposed same-name objects of different types being ordered apart;
iteration now preserves abaplint's name groups, file order within each group,
and the kept objects/config/caches. Constructor and mixed source/library
regressions cover both ordering cases. The edit-storm regression verifies two
earlier generations despite 200 ms saves and a later cold publication; live
config/gen/library changes cannot hide a deliberately mismatching output.
Validation covers 253 distinct tests across 15 focused files, with isolation
and no-retry hooks; the final seven-file core run passes 142/142 in 55 seconds. The requested runtime paths pass (VS Code swap 6 ms;
startup serving/classrun 0.105 s / 0.129 s). Supplemental reruns correct six
2-second default fixture timeouts, invoke the CLI through Node, and give the
identity fixture the transpiler-owned core. The supplied CLI bundle contained
two core copies and emitted scripts without objects: its oracle was rebuilt
from the pinned source into workspace-local scratch with a core alias, selected
through `OSD_TEST_TRANSPILE_CLI`; shared dependencies were not modified.
A URL-cloned library regression also passes after retaining its bytes before
clone cleanup. Suite registration and the changed-file size guard pass with
four inherited Go breaches, no raised budgets and no new isolation allowances.
The structural leak scan is clean; the private identifier list is absent.
Evidence is under `.local/warm-task/`.

Launcher shutdown uses `taskkill /T /F` on Windows and a dedicated process
group on POSIX, with kill escalation. The platform strategies are unit tested
(Windows mocked); they do not depend on the CPU-bound compiler processing
an IPC disconnect.

## What a swap means, compared with a system

The next dialog step that uses the class gets the new one, with its class
constructor run again for it, as activation gives a new load to new
sessions; an object created before the swap keeps the code it was created
with, as a running session does. One difference is written down as
`NOTE-2026-09-25-warm-swap-class-constructor`: a system runs the class
constructor at the first access, and a swap runs it at once.

## Running it

```
OSD_WARM=1 STG_DEV=1 npm start          # or: OSD_WARM=1 STG_DEV=1 build/osd up
```

For a local checkout, `npm run bootstrap` runs this pin step itself after
`npm ci` — it verifies or builds the pin, links all four packages from
`libs.lock.json`, and refuses to transpile on the published package at
`node_modules/@abaplint/transpiler`. `npm run transpiler:pin` is the same
step on its own. The persistent default is
`$HOME/.cache/osd/transpiler-<ref>`; override it with `TRANSPILER` pointing at a
persistent checkout. Temporary directories and session scratchpads are refused.
A verified build is reused; an incomplete clean checkout at the pin is rebuilt.
A checkout at another commit or with tracked edits is refused: choose a new cache
path instead. With `OSD_WARM=1`, a transpiler missing `only` or registry/config
reuse prints `warm off: the transpiler is not the pinned build (run: npm run
transpiler:pin)` plus the detailed reason at startup and in `osd doctor`.
Doctor keeps this informational (exit 0): cold compilation remains available.

## Not yet

- **Generators should read the build view; until then, any inactive
  generator input forces cold.** They read the raw tree (a saved DDLS, YAML,
  TABL, a class's `INTERFACES` or AMDP), so while such an object is
  inactive, or a class's saved source differs from its copy in a way the
  warm rule refuses, every build is cold (`WarmCompiler#generatorInput`).

- **The cross-reference after a swap** is refreshed for the build's `only`
  set in the serving child under the module-swap work-process lock, before
  acknowledging the swap. CROSS, WBCROSSGT, WBCROSSGTX and D010INC rows
  owned by these objects are replaced transactionally; other rows remain.
  The warm compiler derives the selected rows from its retained registry,
  after transpiling the exact build view (including active-copy overlays),
  before publishing the generation. The rows travel with the modules over
  IPC; no checkout read or whole-tree parse runs during the swap. The child
  applies the rows transactionally before importing modules, and a failed
  refresh or import keeps the work-process lock until the supervisor recycles
  it. The reported swap time includes the SQL refresh.
  `test/adt-xref-warm.mjs` cold-builds an isolated temporary tree and checks
  added and dropped references in WBCROSSGT and WBCROSSGTX, active copies,
  timing, and a SQL failure with queued work held until recycle.
- **The cross-reference is still a full parse per new generation** at every
  start (~5 s alone, 21.6 s on vsp-i7 under load). `build/xref/` now keeps
  the last eight generations' rows rather than one, so a tree that goes
  back to a generation (an object created and deleted again) is a hit.
  Seeding after the runtime answers would not take the parse off the
  child's single thread, only move the stall to the first requests and
  leave where-used empty meanwhile; per-object rows keyed by the file
  digest are the follow-up.
- **The dev loop's cold path** still reparses the tree three times (the
  parent's check, the build, the child's cross-reference seed; foreman-dell's
  measurement) and runs every generator on every save. The warm path checks
  synchronously using the source host's kept registry: only changed source files
  are updated, and affected objects and transitive readers are dirtied before
  reparsing. It retains the publication validator's identifier rules, including
  the 30-character method-name limit, and checks new class includes before
  scheduling publication. The warm path skips generators and derives selected
  xref rows from the compiler registry. Cold builds queue the changed generated
  files for the same synchronous validator; failed builds that rewrote `gen/`
  invalidate it when no complete file delta is available.
- **Priming after a nonincremental cold build** costs a full transpile in the
  compiler process. Ordinary creates and removals instead update the registry.
  Saves during a prime can require another prime to catch up; requests continue
  to answer and saves no longer wait for that work.
- **The init script's rows** (`reposrc`, `tadir`) stay at the text the
  process started with until the catch-up recycle.
The former in-process numbering defect is recorded as
`ANOMALY-2026-09-25-in-process-numbering`; the current pin includes #1899,
which gives each object stable temporary names across repeated runs.

Round 7 verification policy (#625): priming/publication waits at most 30 s for
a running comparison (`OSD_WARM_VERIFY_WAIT_MS`, instance `warmVerifyWaitMs`;
legacy `warmVerifyDeadlineMs` remains accepted). Cancellation during that wait
keeps the disk verdict unchecked and requeues the hash after priming. A verifier
itself has a separate 180 s lifetime (`OSD_WARM_VERIFY_LIFETIME_MS`, instance
`warmVerifyLifetimeMs`, compiler `verifyDeadlineMs`): about eleven times the
measured 16.5 s comparison. Both settings are milliseconds. Lifetime expiry
stays unchecked; another activation or the quiet retry can compare it again.

Verification history retains at most three recent hashes plus one in flight;
the store additionally prunes to its current/queued/running hashes and informs
the worker. Discarding history never alters the unchecked on-disk verdict.
Pins renew every minute; Linux process-start identity keeps a CPU-bound live
verifier pinned across lease expiry while rejecting reused PIDs. Platforms
without `/proc` use the renewing five-minute lease. GC also removes unpinned
sidecars whose generation directory vanished during a crash. Both `same` and
`differs` settle under the build lock with an identity recheck and atomic rename.
