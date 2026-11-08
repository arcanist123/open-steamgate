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
edited; the prime builds below give `go:4bbfc29274ad29c3` in both layouts.
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

Warm `GOCACHE`, three edits each, the median (ms). *Before* is `--unlayered`
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

## Limits

- **The first save of a class moves it from `app` to `main`**, which
  recompiles `app` once (36 s here); the edits after it are the fast case. A
  commit moves it back (another `app` compile). Nothing else triggers it.
- An edited class that many classes reference statically drags them into
  `main` (they are promoted); the build says how many (`layers: ...;
  promoted: n`) and `.out/osgo-phases.json` names each with its reason.
- A tree object a library references (a DDIC stub, an interface) is compiled
  with the library in `core`, so editing it recompiles `core`.
- The binary is 89.7 MB against 85.8 MB: the package paths in the symbol
  names.
- A cold `GOCACHE` gains nothing from the split (above).
- Host code that reads a generated field **by name through reflection** must
  try the exported spelling too: `cmd/osgo/adt_unit.go` (an assertion's
  `msg`/`expected`/`actual`, which ADT conformance case X4 caught) and
  `abap/filedialog.go` (`filename`) do. A host dump's cast detail prints Go
  type names (`castdiag.Context`, `%T`), which now carry `core.`/`app.`
  instead of `main.`; it is host diagnostics, not an ABAP-visible text.
