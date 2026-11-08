# tools/selfhost — gogen through abapiti over the whole osgo input set

Self-hosting step 4 proved one class: gogen, compiled to Go by
[abapiti](https://github.com/oisee/abapiti), emitted the same Go as Node
gogen for `ZCL_GOGEN_T_RUNTIME`
([record](../../docs/history/2026-10-20-self-hosting-step4.md)). This module
asks the same question of **everything `tools/gogen/osgo.mjs` compiles**:
the layers of `abap_transpile.json` with the packs, `gen/`, and the locked
libraries, with the build's own override and skip decisions.

| File | Job |
| --- | --- |
| `corpus-inputs.mjs` | Freezes the inputs: `osgCompileInputs()` of `tools/gogen/osg-build.mjs` (the function `compileOsg` itself calls) → `inputs.json` (folders in layer order, objects, skipped files) and `manifest.json` (every file with role and SHA-256, pins, input hash, the manifest's own SHA-256). Refuses an unfetched pack and a stale `gen/`, as `osgo.mjs` does. `--objects A,B` narrows to a slice for bisecting. |
| `corpus-driver.mjs` | The step-4 driver with `compileOsg`'s and `writeGo`'s options (`tolerant`, no test classes, package `main`, no layers, no unit build). Installed as `.local/step4/step4-driver.mjs` for the run and removed afterwards. |
| `corpus-run.mjs` | One run: inputs, then abapiti's `tools/selfhost-step4.py --inputs` twice — `--list-traps` (reached lowering traps) and the full run (Node reference with V8 coverage, translated closure, `emit-go` with that run's reachability, `go build`, the Go run, `cmp`). Records wall time and peak RSS per phase in `timings.json`. |
| `corpus-report.mjs` | The verdict: whole output byte-equal, clean exit, zero reached traps — else exit 1. Attributes each top-level Go declaration to its object (`typeName` of `go-symbols.mjs`) for a per-object equal / diff / missing / crash table, and counts reached functions of the translated closure from `reach.json`. |

Both sides read the same `inputs.json` bytes (its SHA-256 is in the
manifest), so the Node and the native runner see one input set. The native
program is built from the reachability of the Node run on the same inputs:
a body Node never entered becomes a located trap, so a different input fails
loudly instead of passing quietly.

## Running it

Heavy: the Node reference compiles all of OSG, abapiti emits the whole
gogen closure, and `go build` of the generated module needs up to 24 GB.
It does not fit a CI runner (see `docs/self-hosting.md`); it is a manual
gate on a big host. Prerequisites in the OSG checkout: `npm ci`,
`node tools/osd-libs.mjs`, `node tools/osd-fetch.mjs`, `npm run transpile`.
Beside it: an abapiti checkout and its binary (`go build -o abapiti-bin
./cmd/abapiti`), abaplint at the tag of OSG's `@abaplint/core`
(2.120.73, `9f7f098c`, with `npm ci` in `packages/core` so `json5` resolves -- without it the translated `Config` traps on its first use) and the transpiler at OSG's `@abaplint/transpiler`
(2.14.3, `8b566b19`), as tsconfig path roots for the translated closure.

```sh
STEP4_NO_SYSTEMD=1 GOTOOLCHAIN=go1.26.0 GOFLAGS=-buildvcs=false \
  node tools/selfhost/corpus-run.mjs --abapiti ../abapiti --bin ../abapiti-bin \
    --abaplint ../abaplint --transpiler ../transpiler --out ../out-corpus
cat ../out-corpus/summary.txt     # selfhost-corpus: PASS|FAIL objects=… equal=… diff=… crash=…
```

`STEP4_NO_SYSTEMD=1` is for a container without a user systemd (the
container's own memory cap applies); elsewhere the abapiti harness puts each
step in a memory-limited scope. The output directory keeps `inputs/`,
`traps/` (`reached-traps.tsv`), `full/` (`ref.go`, `gogen.go`, logs,
`reach.json`, evidence), `timings.json`, `report.json` and `summary.txt`.

`node --test tools/selfhost/corpus-report.test.mjs` checks the comparison
itself: one changed byte, a dropped declaration, an empty output and a
reordering each fail.
