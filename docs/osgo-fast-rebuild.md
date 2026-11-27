# The osgo rebuild after a save: three Go packages instead of one

*Measured 2026-11-08 on a shared 4-core x86-64 host (Go 1.26.0, Node 26),
every run under the shared heavy-job lock, neighbouring jobs running
(load 2 to 4.5). The long tail of ADR 0010's hot swap
([`adr/0010-osgo-work-processes-and-hot-swap.md`](adr/0010-osgo-work-processes-and-hot-swap.md)).*

## What was slow

`tools/gogen/osgo.mjs` wrote every generated class into one file of package
`main` beside `go/cmd/osgo/main.go` (21 MB, 400 000 lines). Go compiles a
package as a whole, so a one-literal edit of one class recompiled all 1071
classes: of a 51 s `go build`, 48.5 s was `compile main`, 2.4 s the link.
`tools/gogen/unit.mjs` did not pay this, for two reasons: it already split its
classes into packages (`generated/core` for the libraries, `generated/app`
for the repository, `main` for the test classes), and its `app` is only the
closure of the classes under test, so it is small.

## What changed

The split is now one mechanism, `tools/gogen/go-layers.mjs`, which `unit.mjs`
and `osgo.mjs` both use. For `unit.mjs` it is the split it had, with two
corrections that can move a declaration but no class: a structure or constant
of an interface starts with its interface (it started in `core`), and a
shape-named structure is owned by nobody (see below); `unit.mjs --class
ZCL_OSD_ADT_JSON` gives the same rows and the same tier counts before and
after. For osgo (`tools/gogen/osgo-layers.mjs`):

| package | holds | changes when |
| --- | --- | --- |
| `go/generated/osgo/core` | the libraries (open-abap-core, the shim, open-abap-odata, ...) and the tree's objects they reference (pulled down) | a library pin moves, or such an object is edited |
| `go/generated/osgo/app` | the tree: `src/`, `gen/`, the packs | an object is edited for the first time, or committed |
| `main` (`go/cmd/osgo`) | the objects `git status` shows as modified or untracked under a layer folder, `OSGO_HOT`, whatever references them (promoted), and `main.go` | every save |

A class starts in its tier and is promoted until nothing it references lies
above it; a structure, constant, table or interface follows the class or
interface that owns it (a structure the front end named after the first class
that used its shape is owned by nobody and rises only with its fields). The
packages import downwards only, with dot imports, so `main.go` and the other
generated files of `main` (`zz_boot.go`, `zz_adt_session.go`, `zz_unit.go`,
`zz_lint.go`, `zz_status.go`) name the classes as before. A layered build
exports the fields of generated structures (`Name` for `name`; `XP__key` for
RAP's `%KEY`, `__key` unlayered), which is the only difference in the Go it
writes.

What did not change: the program (the same classes, statements, seed rows),
and **the generation**. `osgo.mjs` still hashes the unlayered emission for
`buildGeneration`, so the same inputs name the same generation whatever is
edited; on the measured tree the prime builds below gave `go:4bbfc29274ad29c3`
in both layouts (the hash names the tree's inputs, so another tree, or this
one at another commit, gives another value, the same in both layouts).
`--unlayered` (or `OSGO_LAYERS=0`) builds the single package as before.

Two smaller savings in the same place: one layered build emits three times,
and the two whole-program analyses (ownership, table moves) are computed by
the first emission and handed to the others; and a core or app package whose
emission is unchanged gets its formatted copy back from `.out/gofmt` instead of
another `gofmt` over 20 MB.

## Measured

`node tools/gogen/osgo-cycle.mjs` is the instrument: it builds once from the
clean tree (the prime, not counted), then per run changes one string literal in
`ZCL_ZSTG_DEMO_DPC_EXT=>KEY_FROM`, runs `node tools/osd-build.mjs` and `node
tools/gogen/osgo.mjs` as a user does, stops the running binary with SIGTERM,
starts the new one (`-adt`, fresh `-home`) and waits until `/osd/serving`
answers `ready` **with the generation the build wrote**. Phases come from
`osgo.mjs`'s own clock (`.out/osgo-phases.json`) and `go build -debug-trace`
(compile per package, link). The file is restored however the run ends.

```
flock <heavy lock> node tools/gogen/osgo-cycle.mjs --unlayered --runs 3   # before
flock <heavy lock> node tools/gogen/osgo-cycle.mjs --runs 3               # after
flock <heavy lock> node tools/gogen/osgo-cycle.mjs --runs 1 --gocache cold [--unlayered]
```

Warm `GOCACHE`, three edits each, the median (ms). The numbers are of this
tree and this host: the *before* column (and the earlier *after* run named
below) at PR commit `03410918`, the *after* column and the cold runs at
`0a7862ab`, both on the main of 2026-11-08 the branch was then based on. They were not
re-measured after the review fixes (interfaces in `main`, object files of
any kind marking an edit), which do not change the package of the measured
edit. *Before* is `--unlayered`
on this branch (the old single package, same tree); *after* is the default.
The edit is the second and later save of the class (see "first save" below).

| phase | before | after |
| --- | ---: | ---: |
| transpile (`osd-build.mjs`) | 39 097 | 38 176 |
| `osgo.mjs`, all of it | **84 843** | **40 055** |
| -- stale check | 987 | 930 |
| -- front end (`compileOsg`) | 22 133 | 22 201 |
| -- database, media, ICF, store | 1 132 | 1 145 |
| -- layer plan | -- | 707 |
| -- emit (three packages after) | 5 327 | 6 328 |
| -- emit for the generation hash | (in emit) | 3 598 |
| -- gofmt | 2 429 | 196 |
| -- `go build` | **51 481** | **4 007** |
| ---- compile `main` | 48 503 | 960 |
| ---- compile `app` / `core` | -- | 0 / 0 (cached) |
| ---- link | 2 356 | 2 418 |
| stop the old binary (SIGTERM, drained) | 369 | 282 |
| start to `/osd/serving` ready with the new generation | 2 574 | 2 584 |
| **edit to serving** | **126 933** | **82 014** |

Runs (edit to serving, ms): before 137 956, 126 933, 125 567; after
82 196, 80 867, 82 014; the **first save** of the class 119 991, of it
`compile app` 36 339 (the class leaves `app`, which is compiled once). An
earlier run of the after case without the two smaller savings gave
87 964 / 90 060 / 90 194 (emit 10.0 s, gofmt 2.5 s).

Cold `GOCACHE` (an empty cache per build, the module cache kept; one edit
each, so one number, not a median): before 154 668, after 159 045 ms
edit to serving; `go build` 79.5 s and 80.1 s, of which 64.7 s is the
standard library and the dependencies. The split does not help a cold build:
`core` (11.6 s) and `app` (36.4 s) compile one after the other and sum to the
old `main` (48.3 s).

Raw rows: `--json <file>` writes every run. Binary: 89.7 MB layered against
85.8 MB unlayered (package paths in the symbol names).

## What is left of the edit-to-serving time

After the change the edit costs ~82 s, and Go is ~4 s of it. What is left,
largest first:

1. **The transpile, 38 s.** `osgo.mjs` refuses a `gen/` that is not the
   generation of the tree's inputs (`staleGen`), so a save runs the Node
   build, which transpiles every object to JavaScript osgo never loads. What
   osgo reads of it is `gen/` (the generators alone take **8.4 s** here,
   `runGenerators`, three runs 8 425 / 8 438 / 8 493 ms) and the active
   source snapshot the object store reports (`store.mjs`). A build step that
   publishes the snapshot and runs the generators without the transpile would
   bring the cycle to about 52 s, inside ADR 0010's 60 s. Not done here: it
   changes what "the generation of the inputs" means for the Node host too.
   (Done since for osgo alone, without the generators: "The fast path"
   below.)
2. **The front end, 22 s.** `compileOsg` parses and lowers all 1071 classes
   on every build. The disk cache the runners have (`OSD_GOGEN_CACHE`) was
   tried and is slower on this tree (34 s on a hit, 66 s filling it), so it is
   not used; an incremental front end that keeps the registry in a process,
   as `docs/warm-compile.md` does for the Node side, is the way to the rest.
3. **Emission, 10 s**: three layered emissions (6.3 s) and the unlayered one
   the generation is hashed from (3.6 s). Hashing the layered output instead
   would save the second but make the generation depend on what is edited.
4. Restart, ~3 s, and link, ~2.4 s: the swap of ADR 0010 slice 4 hides the
   first; the second is the floor of a 90 MB static binary.

## The fast path: no Node build for a class body (2026-11-09)

*Decision (Alice 2026-11-09): an osgo-only fast rebuild is fine; the Node
host's build stays as it is until the fast path is proven to name the same
generation as a full build.* Measured on the same shared 4-core host as
above, under the heavy-job lock, load ~1.6.

`node tools/gogen/osgo.mjs --fast` (or `OSGO_FAST=1`) asks
`tools/gogen/osgo-fast.mjs` first whether a full Node build of the tree
would leave `gen/` as it is. Only then does it skip the build; otherwise it
runs `node tools/osd-build.mjs` itself and goes on as before. The answer is
yes only when all of these hold:

1. there is a live generation, and `gen/` on disk is the `gen/` it was made
   with (its manifest's `gen`, `genHash`);
2. no inactive objects are kept out of the build (no overlay: the full
   build would compile another view than the tree);
3. every source file whose digest differs from the live generation's record
   (`source-inputs.json`) is a file that record has, and **with those files
   counted at the live digests the tree hashes to the live generation
   exactly** (`hashOf` with `substitute`, the proof the warm prime makes).
   So nothing else moved: no config, library, generator, YAML, DDIC, page,
   added or removed file;
4. each changed file passes the warm rule (`osd-warm.mjs warmRule`), the
   rule that already lets the Node warm build skip every generator: the
   content of an existing class or interface, no AMDP body before or after,
   the same `INTERFACES` lines, no RAP handler or saver, no RAP derived
   types, no `SUBMIT`, no program declaration. Object XML is not such a file.

Because no generator reads what such an edit changes, the fast path runs no
generator at all (not "only the generators osgo consumes": there are none
to run for it); `gen/` is checked, not rewritten. Nothing is written under
`build/`, so the Node host never sees a generation it did not build. Two
things osgo took from the live generation are made to match a full build:

- **the store** (`zz_store.json`, DESTINATION 'STORE'): its active copy of a
  file is the generation's snapshot of it, and the live one holds the old
  bytes of the edited files. Those files are active as they are now, from a
  copy under `.out/osgo-active/<digest>` (read digest-checked, like a
  snapshot). Copies that neither this build's store nor the last build's
  (the binary that may still be serving until the new one replaces it)
  names are removed, so the folder holds at most two builds' edits;
- **the cross-reference** (`CROSS`, `WBCROSSGT`, `WBCROSSGTX`, `D010INC`
  seed rows): a parse of the whole tree, ~10-12 s, cached per generation in
  `build/xref`. The fast path takes the live generation's rows and derives
  the rows of the edited objects again from their own files
  (`fastXrefRows`, ~0.3 s): every row names its object, one object's rows are
  contiguous in each table, and they depend only on its statements and on
  the set of object names, which the fast case cannot change. Where the
  premise does not hold (no cached live rows, an object without rows in a
  table it now has rows in) the tree is parsed as before. Checked against a
  fresh parse on a body, a method and an interface edit: identical rows.

**An edit that does not compile is never built by the fast path.** The
full Node build refuses it (`osd-build: FAILED: check_syntax, ...`, exit 1);
the fast path skips that build, so it owes the check. The front end osgo
runs anyway has already put every object through abaplint's syntax pass
(`program.diagnostics`); after it, `fastSyntaxRefusal` (osgo-fast.mjs)
looks for an error in an object the proof names as edited. If there is
one, the fast path gives up and the full path runs: `osgo fast: full build
(syntax errors in the edited objects: <OBJECT>: <file>:<line>: <message>)`,
then `osd-build.mjs`, whose refusal is the build's, with its message and
exit code, before anything is emitted. If the Node build accepts the tree
(the front end can be stricter than the transpiler), it is built the full
way. Errors in objects nobody edited are the live generation's (the Node
build accepted them, the tolerant front end leaves them out as before) and
do not refuse. Measured at the head that added it: the check reads what the
front end already computed, **0 ms** on a clean edit (`fast syntax check`
in `.out/osgo-phases.json`); a body edit calling a method that does not
exist ended `osgo.mjs --fast` with exit 1 after ~22 s of front end plus the
Node build's refusal, `.out/osgo` untouched (same mtime).

A library the tree cannot name a generation with (not at its pin, or with
local changes: `osd-lib-path.mjs` refuses it) is not an error of the fast
path: it answers no, prints `osgo fast: full build (the tree's generation
cannot be named: ...)`, and the full build then fails with its own words.

**ADT CHECK after a fast build.** A fast build leaves `build/live` where it
was, so the binary it makes primes its check compiler with the *old* live
generation (`objstore.SetCompiler(..., liveGeneration(root))`). That name
does not decide what a check reads: the Node check sidecar
(`tools/osd-compiler-sidecar.mjs`) checks the object's active snapshot (the
`.out/osgo-active` copy for an edited file) inside a registry of the tree
as it is on disk, and the generation is only compared with `build/live`
to refuse a verdict across a swap -- which matches here, since neither
moved. Measured at `cd585ebf` (`ZCL_ZSTG_DEMO_DPC_EXT` gains a static
method `osgo_fast_probe`; `ZCL_OSD_CLASSRUN_DUMPER` calls it; as a control
in the same build `ZCL_OSD_CLASSRUN_DEMO` calls a method that does not
exist), one `POST /sap/bc/adt/checkruns` per class, version active:

| build | the dependent that calls the new method | the control |
| --- | --- | --- |
| fast (`build/live` unchanged) | processed, no errors | 1 error: `Method "osgo_fast_missing" not found` |
| full (`osd-build.mjs` + `osgo.mjs`, control left out: the Node build refuses it) | processed, no errors | -- |

So a dependent is checked against the edited class as it is now, the same
verdict as after a full build. (The fast row was measured before the syntax
check above existed; with it, the control's edit is refused at build time.)

### Same generation, both ways

Each edit was built the fast way (`osgo.mjs --fast`), then the full way
(`osd-build.mjs`, then `osgo.mjs`), from a live generation set up as CI sets
it up (`sh tools/abapfs-osgo.sh --setup-only`, the conformance fixture
staged), and the two compared:

| edit | Node generation, fast proof / full build | osgo generation, both | generated files | ADT conformance on osgo, fast / full |
| --- | --- | --- | --- | --- |
| a method body (a literal in `ZCL_ZSTG_DEMO_DPC_EXT`) | `a0b30c27e800abf9` / `a0b30c27e800abf9` | `go:96af888f9e538008` | same | 56 pass, 8 fail / the same 64 verdicts |
| a new method (defined and implemented) | `c33c17e8a1595653` / `c33c17e8a1595653` | `go:111895459c5cf751` | same | the same |
| an interface (a constant in `ZIF_OSD_ADT_ROUTE`, read by 56 objects) | `1c0a3a30aa81f5b6` / `1c0a3a30aa81f5b6` | `go:5103fd9a83afbcb5` | same | the same |

"Generated files" are the eleven files osgo writes besides the binary; ten
of them, every generated Go file of `main`, `app` and `core`, `zz_tables.json`
and `zz_db.json` (the seed, cross-reference included), are byte for byte the
full build's. `zz_store.json`
is the same by content: the same roots, libraries, exclusions and all 1 676
built digests, and behind every active path the bytes with that digest; the
paths differ, because a full build's name its own generation's snapshot
(`build/by-input/<hash>/source/...`) and the fast build's name the live one
and `.out/osgo-active`. That file is embedded, so the two binaries differ
in those bytes only. The eight conformance failures are the same cases in
both builds (X1, C9b, O1-O5, W5, the runner's expected file against this
local setup; not investigated here), so they say nothing about the fast
path either way. The values are of this tree at
`7d625b5f`; another tree gives others, the same both ways.
`osgo-fast.test.mjs` covers the decision over a small tree: the three edit
kinds are fast, and an `INTERFACES` line, an AMDP body, DDIC, object XML, a
YAML, a new or removed class, the config, a stale `gen/` and an inactive
overlay each take the full build, and so does a syntax error in an edited
object (`fastSyntaxRefusal`).

### Measured

`osgo-cycle.mjs --fast` runs `osgo.mjs --fast` alone per edit (its prime is
always the full build), and refuses the measurement when an edit fell back to
the full build, so a fallback cannot pass for a fast run in the median. Warm `GOCACHE`, three edits each after the first,
the median (ms), at `7d625b5f`:

| phase | full path (`--runs 3`) | fast path (`--runs 3 --fast`) |
| --- | ---: | ---: |
| transpile (`osd-build.mjs`) | 39 182 | -- |
| `osgo.mjs`, all of it | 51 920 | 41 559 |
| -- fast proof | -- | 847 |
| -- stale check | 894 | 331 |
| -- front end | 22 370 | 22 370 |
| -- database, media, ICF, store | 12 215 | 1 303 |
| -- emit / generation hash emit | 6 227 / 3 662 | 6 543 / 3 978 |
| -- gofmt | 421 | 197 |
| -- `go build` (compile `main` / link) | 4 094 (1 001 / 2 379) | 4 095 (1 010 / 2 414) |
| stop + start to `/osd/serving` ready | 130 + 5 651 | 116 + 5 133 |
| **edit to serving** | **97 339** | **46 912** |

Runs (edit to serving, ms): full 97 339, 96 036, 97 477; fast 47 883,
46 912, 45 861. The full path is slower here than the 82 s above because
the cross-reference is now parsed inside `osgo.mjs` (12 s) on the main this
branch is based on; the fast path does not parse it. The **ADR 0010 target,
edit to a served new generation under 60 s, is met** by the fast path for
the edits it accepts; every other edit pays the full path.

### The front end, measured and left

The 22 s front end is now the largest phase. Measured once on this tree
(`compileOsg` over 2 898 files, 1 079 classes): the abaplint parse of the
inputs alone is 8.6 s of the 20.7 s, the rest is the syntax pass and the
lowering. Reusing it for unchanged objects needs the parsed registry to
outlive the build process: abaplint's objects are not serialisable, and the
on-disk object cache the runners have (`OSD_GOGEN_CACHE`) is slower here
(above). What `docs/warm-compile.md` does on the Node side is a resident
compiler process holding the registry, and for osgo that is a daemon of its
own (prime, file updates, invalidation of the dependent closure, its own
proof against a cold run): not a small change, so it is not done here. With
the fast path the cycle is ~47 s, so it is no longer needed for ADR 0010's
target.

## The incremental front end (2026-11-10)

Measured on the same shared host as above, under the heavy-job lock, the
same `osgo-cycle.mjs --fast` edits. Code: `tools/gogen/osgo-incr.mjs`,
`osgo-incr-anon.mjs`, `osgo-incr-deps.mjs`, `osgo-incr-meta.mjs`, `osgo-incr-db.mjs` (README:
`tools/gogen/osgo-incr.md`).

Why not the runners' whole-tree cache again: it was measured slower on this
tree (34 s on a hit, 66 s filling it, above) because a hit still pays
everything that is per file: the registry build, the parse and the syntax
pass over all ~2 900 files. The design rule that follows: **a hit pays for
the edited set, not for the tree.** What the cache achieves here: the
lowering, the largest single cost after the parse, drops to the re-lowered
set (55 of 1 085 objects for the measured body edit); the parse and the
syntax pass drop only to the registry the proof needs, 2 669 of 2 852 files,
so the front end of a hit is 15.8 s against 21.1 s. The registry is what it
must be: every non-class file the full build loads (below), and the
reference closure of the re-lowered classes.

A full front end records, per object (classes, interfaces, function groups,
DDIC -- ~1 080 entries, ~19 MB), under the live generation
(`build/osgo-incr/<generation>/`): the lowered IRs of the classes it pushed,
every write its lowering made to the shared program state, the supplied
parameters and RTTI typedefs, what it read through the registry, the
classes and interfaces its IR names (its `deps`), and the digests of its
files. The database statements are attributed per object the same way,
after proving the reconstruction equals the real `DatabaseSetup` run.

A fast build (the fast proof already says only the content of existing
classes and interfaces changed) then assembles the program:

1. it re-lowers the edited objects and, transitively, everything whose
   recorded `deps` include one;
2. its registry holds every non-class file the full build loads, the
   classes whose constructor DEFAULTs the emission resolves, and the
   reference closure of the re-lowered set (their recorded reads **and**
   deps, and every class any member's text spells);
3. every other object's recorded writes are replayed into the shared state,
   its IR comes from the cache, and the fresh lowering runs through
   `compileProgram` itself, so the fresh IRs come out of the code path a
   full build uses;
4. the shared collections are rebuilt in the order the full build wrote
   them, and the final analyses run over that state (below).

Anything it cannot prove refuses with a reason and the full front end runs
(`osgo incr: the full front end runs (...)`); the README lists every case.

### Same order, same names: what the real tree taught

The first real-tree proofs named another generation for every edit, with
conformance identical: `core.go`/`app.go` differed in **order and naming
only**. Each cause is now a regression test over a small tree that fails on
the merge before it:

- **Passes, not objects.** compileProgram enters an object more than once:
  the local discovery, the class pass, then the local classes after
  *every* class, then the function groups. A merge that grouped an
  object's writes at its first slot put a local class's types
  (`LCL_STACK__TY_DATA`, `LCL_JSON_PARSER__TY_NODE`) at their owner's place
  instead of after all classes. Every `enter` is now a segment of one global
  sequence, recorded and replayed in that sequence; the global passes keep
  the slot they ran in, and one that wrote between two objects refuses.
- **The final analyses see the full build's state.** The interface walk,
  the dynamic statics and the table pass iterate the program's collections
  in insertion order and append what they derive; they used to see the
  cache's pre-seed with the fresh writes after it, which swapped interface
  declarations in `app.go`. A hook before them (`incr.lowered`) puts the
  merged classes and collections in place; `interfaceAttrs`, a memo the
  emitter reads in order, is recorded like the rest.
- **An anonymous structure is named by its declaration.** abaplint keys
  them by type instance, and the first lowering to reach one names it. The
  shape does not say which instance a lowering reached: every exception
  class has its own `MSGID/MSGNO/ATTR1..4` textid constant, and
  `ZCL_STG_SADL_DPC` reaches its own and `ZCL_OSD_RAP_SADL`'s. The cache
  records the name of every instance a global class or interface member
  owns, by the member's path, and a fresh lowering takes it; an instance no
  global member owns comes from the object's own syntax run and is named
  after it both ways.
- **The registry holds every non-class file.** abaplint enumerates objects
  in the order a *name* first appeared; the closure had dropped a behaviour
  definition in `src/`, so `ZI_RAP_NOTE`'s row type (the table pass, in that
  order) moved behind its neighbours.
- **The emission resolves constructor DEFAULTs for every class** (CREATE
  OBJECT by name, `emit-constructors.ts`), cached or not: a cached
  `CL_GUI_DOCKING_CONTAINER` outside the closure emitted a panic where the
  full build constructs.

The other two phases the fast path still paid:

- **the generation hash** no longer emits the whole program unlayered to
  hash it (3.7 s). It is the content digest of the program itself plus the
  statements it boots from (`tools/gogen/program-digest.mjs`, ~0.26 s).
  Because it hashes the program content and not the packaging, the same
  edit names the same generation however the classes were packaged -- the
  property the unlayered emission bought -- and a battery test checks that
  the digest changes exactly when the emitted text changes.
- **a fast save emits package `main` only.** Core and app cannot have
  changed (the fast proof says only class and interface content moved, and
  the layer plan is a function of that), and the build proves it instead
  of trusting it: a layered build records per package below main the digest
  of its emission inputs with the formatted bytes and symbols it produced
  (`.out/osgo-pkg.json`); a later build whose inputs match and whose
  on-disk bytes hash to the record skips the emission.

### Same program, both ways

The three edits of the table above, each built the fast way and the full
way from the same live generation (the conformance fixture staged, as CI
stages it), at the branch head merged with `main` (`3133bdfe`):

| edit | re-lowered / registry files | osgo generation, fast = full | generated files | ADT conformance, fast / full |
| --- | --- | --- | --- | --- |
| a method body (a literal in `ZCL_ZSTG_DEMO_DPC_EXT`) | 55 / 2 669 of 2 852 | `go:5b66be01d42ee9a8` | byte-identical (11 files; `zz_store.json` by content) | 64 pass / 64 pass, the same verdicts |
| a new method, defined and implemented | 55 / 2 669 of 2 852 | `go:9d46726a77d58d2a` | same | the same |
| an interface constant (`ZIF_OSD_ADT_ROUTE`) | 98 / 2 669 of 2 852 | `go:8dedd76c1cac41e8` | same | the same |

"By content" for `zz_store.json` is the rule of the fast path above: the
same roots, libraries, exclusions and built digests, the same active keys,
each active path the same file in each build's own snapshot (the edited
file under `.out/osgo-active/<its digest>`). Script
`.local/incr-proof-full.mjs` (not tracked).

### Measured

`osgo-cycle.mjs --runs 3 --fast`, warm `GOCACHE`, one run at a time, medians
of the three edits after the first (ms); before is `main` at `3133bdfe`,
after is this branch merged with it:

| phase | before | after |
| --- | ---: | ---: |
| `osgo.mjs`, all of it | 39 912 | 29 625 |
| -- fast proof | 876 | 899 |
| -- stale check | 319 | 355 |
| -- front end | 21 114 | 15 820 |
| -- database, media, ICF, store | 1 377 | 1 345 |
| -- layer plan | 745 | 1 132 |
| -- emit | 6 419 | 4 423 |
| -- generation hash emit / program digest | 3 719 | 259 |
| -- gofmt | 225 | 35 |
| -- `go build` (compile `main` / link) | 4 251 (1 080 / 2 552) | 4 541 (1 132 / 2 461) |
| stop + start to `/osd/serving` ready | 55 + 2 578 | 99 + 2 426 |
| **edit to serving** | **42 603** | **32 085** |

Runs (edit to serving, ms): before 42 876, 42 255, 42 603; after 32 085,
34 873, 31 978. The first save of a class still moves it into `main`; in
these runs `app`'s recompile came out of a warm `GOCACHE` on the after side
(the proofs had built that `app` already), so the "first edit" columns are
not comparable and are left out. The full build that writes the cache
costs ~2-3 s more front end than one that does not. What is left: the
front end of a hit (15.8 s) is the parse and syntax pass of a registry of
2 669 files -- every non-class file plus the closure -- not the lowering;
shrinking it needs the parsed registry to outlive the process (the daemon
of "The front end, measured and left"), not a smaller closure.

## Limits


- **The first save of a class moves it from `app` to `main`**, which
  recompiles `app` once (36 s here); the edits after it are the fast case. A
  commit moves it back (another `app` compile). Nothing else triggers it.
- An edited class that many classes reference statically drags them into
  `main` (they are promoted); the build says how many (`layers: ...;
  promoted: n`) and `.out/osgo-phases.json` names each with its reason.
- A tree object a library references (a DDIC stub, an interface, a class)
  is compiled with the library in `core` while it is not edited. Once it is
  edited it starts in `main` like any other, and the library classes that
  reference it are promoted into `main` with it (`main` is never pulled
  down). `core` has then lost those classes, so the first save recompiles
  `core` and `app` once, and the saves after it only `main`; a commit moves
  them back (another `core` and `app` compile).
- An edited interface, or one promoted into `main` because its signature
  names a type that lives there, is emitted in `main` with the classes that
  implement it (`osgo-layers.test.mjs` builds and runs both cases).
- The binary is 89.7 MB against 85.8 MB: the package paths in the symbol
  names.
- A cold `GOCACHE` gains nothing from the split (above).
- Host code that reads a generated field **by name through reflection** must
  try the exported spelling too: `cmd/osgo/adt_unit.go` (an assertion's
  `msg`/`expected`/`actual`, which ADT conformance case X4 caught) and
  `abap/filedialog.go` (`filename`) do. A host dump's cast detail prints Go
  type names (`castdiag.Context`, `%T`), which now carry `core.`/`app.`
  instead of `main.`; it is host diagnostics, not an ABAP-visible text.
