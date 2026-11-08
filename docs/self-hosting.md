# Self-hosting

The agreed order is **1 → 2 → 4 → 3 → 5** (2026-10-14, recorded in the
[step-4 history](history/2026-10-20-self-hosting-step4.md)). “Done” below
means the named, frozen milestone and its recorded evidence. It does not imply
that every runtime route or every compiler input has been proved.

| Step | Status and proven scope | Record | Next milestone |
| --- | --- | --- | --- |
| 1 — M1 | Done: translated abaplint checks OSG's frozen ABAP corpus, byte-equal to Node | [Steps 1–2](history/2026-10-14-self-hosting-steps-1-2.md) | Keep the pinned nonempty-diagnostic oracle green |
| 2 — fixed point (M2) | Done: translated abaplint checks its generated ABAP with dependencies, byte-equal to Node | [Steps 1–2](history/2026-10-14-self-hosting-steps-1-2.md) | Preserve the accepted gate; keep the no-deps stress variant separately scoped |
| 3 — ADT syntax | Done for recorded CHECKRUN/CHECK/OUTLINE gates with optional linked native engines; Go default when linked | [Step 3](history/2026-10-22-self-hosting-step3.md) | Preserve freshness/refusal and execution-origin gates; close remaining acceptance gaps explicitly |
| 4 — gogen through abapiti | Done for compileProgram + emitGo on the reference class, generated Go byte-equal and unit green. Whole osgo input set: harness in place, **not equal** (measurement below) | [Step 4](history/2026-10-20-self-hosting-step4.md) | Whole osgo input set: clear the reached traps ([abapiti gaps](selfhost-abapiti-gaps.md)), then output equality and a gate |
| 5 — transpiler through abapiti | Planned; no completion claimed | This page's proposal below | Inventory the pinned @abaplint/transpiler path, then prove successive slices |

## Whole osgo input set: first measurement (2026-11-08)

`node tools/selfhost/corpus-run.mjs` ([harness](../tools/selfhost/README.md)) ran
on OSG `ae541da2` with abapiti `90f2443a` (selfhost), abaplint `9f7f098c`
(2.120.73) and the transpiler at `8b566b19` (2.14.3), in an 8-core, 40 GB container:

| | |
| --- | --- |
| input set | 18 folders, 1,340 objects, 3,404 files, 94 skipped (`osgCompileInputs`) |
| Node gogen | 20,761,458 bytes of Go, `ref=e935f509b3231c78` |
| verdict | `selfhost-corpus: FAIL objects=1340 equal=0 diff=0 crash=1340` |
| reached functions | 349 / 551 bodies of the translated closure |
| reached traps | 92 roots, 214 unreached (`step4-traps: 92 reached (0/18 unknown) 214 unreached`) |
| wall time | 595 s (trap listing 269 s, full run 323 s) |
| peak RSS | 12.5 GB (full run, `go build`); 3.5 GB for the trap listing |

Reached traps by kind (the corpus report's classifier, first matching pattern):
54 untyped `dynamic`/`void` values (G), 10 namespace imports or the global
`Object` (A), 8 recursive unions (A), 8 structural type mismatches (A/G),
3 optional parameters / `Array()` (G), 3 regexp features (A), 3 number/string
builtins (A), 2 bigint (A), 1 other. By module: `frontend.mjs` 47,
`sqlscript-lower.mjs` 19, `osd-narrow-submit.mjs` 5, `ir-writes.mjs` 4,
`emit-go.mjs` 4, the rest one to three each. The Go run trapped at its first
reached root, so no object produced output. Two regexp roots and the
five SUBMIT-narrowing roots are fixed in OSG since this run. Those fixes are not
remeasured yet. The run is a manual gate: its peak memory does not fit a CI runner.

## Next milestone proposal

These are proposed implementation slices and acceptance criteria. This docs
change runs no builds, makes no new measurements and installs no new CI gate.
The existing step-4 single-class result is the starting point, not whole-corpus
coverage. Continue maintaining gogen in JS/TS and translating it through abapiti;
generated Go remains generated code.

### A. gogen-in-Go over the whole osgo input set

1. **Freeze the whole workload and host boundary.** Pin the OSG commit,
   `libs.lock.json`, Node packages, abapiti emitter/core and Go toolchain.
   Export the exact ordered inputs of the real osgo build, including source,
   tests where selected by that build, generated ABAP, every selected locked
   library and default pack. Use the canonical layer/override decisions from
   [`osd-inputs.mjs`](../tools/osd-inputs.mjs) and
   [`osgo.mjs`](../tools/gogen/osgo.mjs), rather than another hand-maintained
   file list. Include logical path, content SHA-256, checkable/dependency role,
   config, selectors, library/pack pins and generated-input provenance. Refuse
   missing libraries/packs or stale generated inputs. Prove manifest equality
   between the Node runner and the native runner, with no skipped files or
   shadow-winner drift. Keep a self-contained harness and README next to it.
2. **Extend lowering from the reference class to corpus slices.** Start with
   existing testdata, then OSG source/generated registries, then locked library
   and pack closures, ending with the complete manifest. Inventory reached
   lowering/runtime traps per exact pin and input; assign each fix to gogen's
   types/host contract or abapiti's lowering. Compare raw emitted artifacts
   against Node on each slice. Zero reached traps alone is insufficient: every
   input must have the same generated result or the same explicit refusal,
   and every refusal must remain visible. Unexpected refusals block whole-
   corpus acceptance; an excluded path cannot count as coverage.
3. **Complete the generation, including host-produced artifacts.** Exercise the
   real compileOsg/emitGo path and its schema/table, statements, assets,
   registries and bridge/status outputs, with explicit host I/O shims. Compare
   the sorted relative output-path set and exact bytes of every deterministic
   artifact, using a framed path/content SHA-256 manifest plus byte comparison.
   Do not normalize emitted Go or sort away semantic input order. Run cold
   isolated Node and native generations; explicitly disable cache for the base
   proof, then compare supported warm/cache modes to that same cold oracle.
4. **Prove generation identity and execution.** Require the same osgo
   `go:` generation value from both outputs and verify that the native binary
   reports it. The current generation comes from generated Go plus statements
   ([osgo.mjs](../tools/gogen/osgo.mjs),
   [status.mjs](../tools/gogen/status.mjs)); compare those bytes and all the
   other artifacts as well. OSG's separate input-addressed generation hash in
   [`hashOf`](../tools/osd-build.mjs) is useful for provenance but cannot prove
   output equality by itself. Record both identities with their meanings.
   Build the emitted native generation and run the focused existing ABAP Unit
   and runtime smoke gates appropriate to the whole build. Run generation with
   Node/Bun absent from PATH and make delegation fail visibly; Node remains
   the oracle in a separate process. Missing input, trap, stale pin and changed
   output must all make the harness fail.
5. **Make equality a CI gate.** Add a registered whole-corpus job after the
   harness is proven. Fetch exactly the locked dependencies/default packs,
   materialize generators once from the frozen inputs, and run Node/native
   generation in separate clean directories. Gate on manifest completeness,
   zero unexpected traps/refusals, byte equality, generation-hash equality,
   native build and focused execution results. Retain pin manifests, output
   hashes and first differing paths as artifacts, with private data excluded.
   Check that changing one emitted byte, dropping one input/output and forcing
   delegation each turn the gate red. Trigger it for gogen, host shims,
   generators, configs, lockfiles and pin changes; retain a scheduled full run
   to catch dependency drift. A skipped or missing native library must refuse,
   not pass. Keep the existing M1/M2 and step-3 gates as independent regression
   evidence. Claim this milestone only on a named OSG commit and named abapiti
   pin with the complete green CI result.

### B. step 5 inventory over @abaplint/transpiler

1. **Pin the real entry path.** Inventory the version OSG actually loads through
   [`osd-transpile.mjs`](../tools/osd-transpile.mjs) and
   [`libs.lock.json`](../libs.lock.json), including the transpiler's own core
   dependency, runtime/schema dependencies and build-time Node I/O. Record
   package versions, repository SHAs, entry functions, reachable modules and
   selected configuration. Do not assume the step-3 core .73 pin describes
   the transpiler's dependency closure. The first deliverable is a tracked
   inventory with a reproducible command and source locations, not a forecast
   of completion time.
2. **Classify translation blockers.** Run abapiti's typed frontend over the
   pinned entry/closure and report counts by category and source location:
   dynamic/any types, structural casts, capturing closures, regex/JSON,
   filesystem/process/module APIs and other unsupported forms. Separate reached
   paths on the OSG workload from unexercised paths. Give every blocker a minimal
   fixture, owner (transpiler typing, abapiti lowering or host adapter), intended
   slice and proof. Assert that every diagnostic is classified; an empty report
   from an unloaded entry cannot pass. Existing type-form guidance lives in
   [`abapiti-lint.md`](../tools/gogen/abapiti-lint.md).
3. **Prove a minimal translated vertical slice.** Begin with a small supported
   class and its test: invoke the same transpiler API/config on Node and the
   translated target, compare complete output filenames and JS/runtime/schema
   bytes, execute each against the same pinned runtime and compare unit results.
   Add a deliberately broken source to prove diagnostic/refusal parity. Keep
   Node-only services behind explicit host interfaces and demonstrate that the
   translated path executes without Node fallback.
4. **Expand with differential gates.** Add dependency-bearing classes, DDIC and
   database setup, then the OSG/library/pack corpus defined in A. Reuse its
   input manifest, output-byte comparison and pin reporting; compare the JS
   generation and behavior produced by the transpiler, separately from gogen's
   Go outputs. For each slice retain trap/coverage inventories, diagnostics and
   execution results. Completion of this inventory means a reproducible blocker
   list and reviewed slice boundaries; completion of step 5 additionally needs
   translated execution, whole-workload equality and a CI gate. Neither result
   is inferred from steps 1–4.
