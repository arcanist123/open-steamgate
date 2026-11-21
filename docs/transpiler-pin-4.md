# Transpiler pin move 4

The transpiler pin moves from `local/osd-build-3d` (`9792b3c8`, upstream
2.14.3 `c8a493c3` plus twelve fork commits) to `local/osd-build-4c`
(`a0d80fff183d805194842562b25dc71b86f0ce81`) on `oisee/transpiler`, which is
upstream main `8824945a` (2.14.19, the EML lowering #2049 and the Open SQL
host-variable escape #2050) with fourteen commits on top. The reason for the
move is EML: `src/rap_demo/zcl_rap_note_eml` is written with real `MODIFY` /
`READ` / `COMMIT ENTITIES` and is now built and tested like any other class.

## Source pins

| Pin | Before | After |
| --- | --- | --- |
| oisee/transpiler | `9792b3c879972450aeb99b89747545a51b589522` (`local/osd-build-3d`) | `a0d80fff183d805194842562b25dc71b86f0ce81` (`local/osd-build-4c`) |
| Parser: OSG CLI/core and transpiler root/library/CLI | exact `2.120.73` | exact `2.120.94` |
| npm `@abaplint/transpiler`, `transpiler-cli`, `runtime` | `2.14.3` | `2.14.19` |

The workflows read the pin from `libs.lock.json` (`tools/osd-lock.mjs`), so
there is no second copy of the SHA to move. The other two of the "three pins"
(open-abap-core and the pack manifests) are unchanged.

## What the branch carries

The base is upstream main after #2050 and before 2.14.20 (`8824945a`).
2.14.20 (`5395f3b9`) moves the parser to 2.120.95 and changes PROG
behaviour, so it belongs to a separate move. Because #2050 is upstream, the
fork no longer carries the SQL escape. The build gate
(`tools/osd-ci-transpiler-build.sh`) requires the `only` option and registry
reuse, which never went upstream. The fork also keeps the old pin's
arithmetic:

| Commit | Origin | Why |
| --- | --- | --- |
| `b147dc0a` four fixes | fork `70c28074`, clean pick | still not upstream |
| `e5fc0043` built-in argument by name | fork `99bce8ed`, clean pick | still not upstream |
| `fec0f09c` `only` option | fork `f48650af`, clean pick | warm compile, `dsl-l3-load`, the build gate |
| `444039fb` registry reuse with `only` | fork `2ebac0a2`, clean pick | as above |
| `5133dd2d` CREATE DATA TYPE HANDLE guard | fork `f34e9bf4`, clean pick | test only |
| `8a6eee2e` core exact 2.120.94, `only` without the plugin guard | new, as `6f2119b8` did for 2.120.73 | the gate compares the parser by manifest string |
| `1ea248fd` `SELECT SINGLE FOR UPDATE` runs as the SELECT | new | ANOMALY-2026-11-09-select-for-update-refused |
| `945f2c8a` exact packed arithmetic | fork `cd914013`, conflicts resolved | see below |
| `b7c9f499` int8 and integer byte conversions | fork `aa06510e`, conflicts resolved | `x`/`xstring` from `i` and `int8` |
| `dd7338f2`, `ad4c7adf`, `0cba1f13`, `271cc1b8` type `i` overflow, positions, LOOP TO 0, labels | fork `13473321`, `acb974ba`, `a8b25e86`, `da9b1785` (upstream PR #1955, open) | the `i` range check |
| `a0d80fff` adaptation to upstream main | new, as `6f2119b8` did for 2.14.3 | see below |

The conflicts were with upstream main's reworked numeric runtime (#2005
exact decfloat34 and packed overflow, #2032 int8 rounding, #2041 int8 to
hex). This is how each was resolved:

- `Packed.set` keeps the fork's mixed Number/bigint representation and exact
  packed-to-packed rescale, and keeps upstream's exact `DecFloat34`
  conversion (by its text). On overflow, a packed source (a calculation
  result or a MOVE between p fields) raises `CX_SY_ARITHMETIC_OVERFLOW`, as
  in the fork's measured cases. Any other source raises
  `CX_SY_CONVERSION_OVERFLOW` and leaves the target unchanged, as in
  upstream's case (`small = 100` into `p LENGTH 2 DECIMALS 1`). Both test
  sets pass with that split.
- `XString.set` keeps the fork's two's complement for `i` and `int8`
  (`asUintN`), which covers upstream's negative-`int8` branch.
- `add.ts` keeps the fork's `Integer.calculated` and `setCalculated()` on the
  float result, and upstream's `decfloat34` branch.
- `template_formatting.ts`: upstream's `decimalToFixed` replaces the fork's
  `decimalsOfDecimal`, and the fork's `checkIntegerResult` stays.
- `read_table.ts` takes both import lists.
- `Integer.set`: the merge took the fork's range-checked rewrite of the
  whole function, which dropped upstream's `Date` branch (days since
  01.01.0001). The adaptation commit restores that branch, with upstream's
  comments.
- The unmeasured `int8 / int8` into `p` keeps its fraction (3.5), as in
  `osd-build-2`. `move.ts`'s long line is split to pass upstream's lint.

## What the upstream jump changed for OSG

- **Parser 2.120.94: a token is its own position.** `Token.start` is gone
  (`AbstractToken extends Position`), so code that read `token.start` got
  `undefined`. `tools/amdp-extract.mjs` crashed the build (`next.col` of
  undefined: `undefined === undefined` passed its same-row test).
  `tools/osd-unit.mjs` and `tools/gogen/osgo-adt-unit.mjs` would have put every
  test method at line 1. All three use `getStart()` now, which both parser
  versions have.
- **The parser checks the BDEF of an EML statement.** `MODIFY ENTITIES OF
  zi_rap_note` is a syntax error ("Behavior definition not found") unless the
  BDEF is in the transpiler's registry, so `\.bdef\.` left the
  `exclude_filter` of `abap_transpile.json`. The transpiler reads the BDEF and
  emits nothing for it.
- **`SELECT SINGLE FOR UPDATE` is refused** (2.14.14 at transpile time, 2.14.15
  at run time). Handled by fork commit `1ea248fd` and an anomaly entry that
  says it needs an issue.
- **`MODIFY itab FROM wa` inside a LOOP over the table no longer changes the
  row.** The same upstream release (#2041) turned the statement into a
  primary-key lookup that modifies in place or does nothing on a miss; a
  `WITH DEFAULT KEY` table serialises as `keyFields: []`, which the runtime
  expands to every character-like component, so once the loop has written
  `DRY` into `status` the lookup cannot find the row any more. Up to 2.14.13
  the missed lookup still inserted the work area, which landed on the SAP
  answer for the one shape in tree that does this (the L3 dry report).
  `ANOMALY-2026-11-09-modify-in-loop-by-key`; the L3 set template rebuilds the
  rows into a fresh table instead (`recipes/l3-set/template.tpl`,
  `src/l2demo/zcl_l3_fleet2.clas.abap`).
- **EML lowering.** The `_eml_demo` exclusion is gone, and so is the matching
  filter in `test/rap-derived-types.mjs`.
- **The upstream runtime changes from 2.14.3 to 2.14.19 come with the jump**,
  among them CLEANUP (#1993), the ASSIGN type check (#2018), GT/LT compared
  per component (#2035) and `TYPE (name)` read case-insensitively (#1998);
  the upstream changelog has the full list.
- **`trunc( f )` types its result as `f`.** Measured on both parsers with the
  same class: core 2.120.73 typed `trunc` over a float argument as `i`,
  2.120.94 types it as `f` (the ABAP keyword documentation gives `trunc` the
  argument's type for `f`, so the new one is the honest reading). The kernel
  conformance inventory moved with it, counts conserved one to one: 259
  `i → i` became `f → i`, 381 `i → int8` became `f → int8`, 288 `i → f`
  became `f → f`, and `i → f` left the measured folders. The two public
  folders of `.github/ci/kernel-inventory.json` and the six affected
  `docs/osg-support.md` rows were regenerated from the measured run
  (`mono`/`qjs` are not measured in CI and were carried over unchanged).
- **Changing a LOOP's whole table is a syntax error in classes now** (core's
  new `LoopTableChange` check, absent in 2.120.73). `zcl_gogen_t_movclr` is
  the deliberate oracle for exactly that move/clear, so the gogen frontend
  tolerates this one message (`tools/gogen/frontend-selection.mjs`, beside
  the dynamic-RAISE tolerance); `src/` stays policed by the lint, which runs
  `check_syntax` over it.
- **`CrossIncludeMacros` gained a second registry-wide sweep.** Every
  `Registry.parse()` now also runs `reparseCyclicPrograms()`, which iterates
  `getObjects()` looking for programs in an INCLUDE cycle it must parse
  again. The gogen provenance hooks classify such iterations by their stack
  site, and the new site was not in the pattern, so every recorded compile
  carried one unclassified global scan whose result was the whole registry;
  merged into every dependency node, it refused certificates and re-lowered
  unrelated classes (56 failures across the cache test files). The site is
  classified `include-macro-context` like `findCandidates`, with a test that
  a cyclic-include registry records no unknown scan
  (`tools/gogen/frontend-provenance-hooks.mjs`,
  `tools/gogen/frontend-provenance.test.mjs`).
- **`DDIC.lookupDomain` calls `parseDomainType` directly.** The DOMA entry
  point was split: `parseType(reg)` is a thin wrapper and
  `parseDomainType(reg, dtel, description)` does the work. Core calls the new
  name, so the gogen hooks patch both and the DOMA still opens its
  `ddic-type` artifact frame (`tools/gogen/frontend-provenance-hooks.mjs`).
- **Scope data containers are shared and frozen while empty.** `ScopeData`
  starts every container at one frozen `EMPTY_OBJECT`/`EMPTY_ARRAY` and
  replaces it on first write through its setters, so a raw
  `getData().vars.NAME = x` write now throws. The digest-projection test
  adds its probe variable through `setVariable`, which is the same observable
  mutation through the API both parser versions expose
  (`tools/gogen/frontend-artifact-digests.test.mjs`).

## The advisory CI jobs

Four advisory jobs built with a transpiler other than the pin and went red
on the EML demo (`Statement CommitEntities not supported`, then
`bootstrap: transpile failed`):

- `unit-inventory` and `gogen` (gogen.yml) installed the published npm
  `@abaplint/transpiler` and never built the pin. Both run
  `npm run transpiler:pin` after `npm ci` now, the same build gate and links
  tests.yml uses. For `gogen` this is not only the transpile: the frontend,
  the cache identity and the `DatabaseSetup` import resolve
  `@abaplint/transpiler` and its `@abaplint/core` off `node_modules`.
- `consumer-smoke` bootstrapped the runtime under test the same way; the
  install step is now `npm ci`, the pin, then `npm run bootstrap`. Splitting
  it into three bounded steps (10 + 15 + 10) pushed the sum of the step
  bounds past the job budget, which the suites' budget test reads off the
  workflow: the job timeout is 95 now and the test sums every step bound
  instead of the first two (`test/consumer-smoke.mjs`).
- `kernel-conformance` (tests.yml) already links the pinned build from the
  `built-tree` artifact; its failure was the stale inventory above, not a
  wrong transpiler.

## Open

- Probe on A4H, unmeasured: a `p`-to-`p` MOVE that overflows. The SAP
  conversion rules say `CX_SY_CONVERSION_OVERFLOW`; the fork's test asserts
  `CX_SY_ARITHMETIC_OVERFLOW`, which is what 4c raises.
- Probe on A4H, unmeasured: the value left in the target after a caught
  `p = p + 7` with `p TYPE p LENGTH 1`. 4c leaves 10 in it; the conversion
  branch restores the old value.

## How it was checked

All of these ran on one machine, one at a time under the shared lock:

- Transpiler repository at `local/osd-build-4c`: `npx mocha` (every suite,
  including the fork's numeric ones) gives 3267 passing and 151 failing. All
  151 failures are `connect ECONNREFUSED 127.0.0.1:5432` (no PostgreSQL on
  the machine). `npm run lint` is clean. The same numeric tests failed in 90
  cases on `local/osd-build-4b`, which did not carry the ports.
- OSG on 4c: `npm run transpile`, the full `node tools/osd-unit-run.mjs`, and
  `npx mocha` over `test/mocha.mjs` (with the quote-in-a-key wire tests),
  `test/odata-v4.mjs` (with "round three"), `test/rap-*.mjs`,
  `test/transpiler-pin.mjs`, `test/amdp.mjs` and `test/amdp-demo.mjs`.
  `npm run transpile` succeeds; ABAP Unit runs 845 methods in 104 classes
  with 0 failures; the mocha files give 30, 83, 21, 10, 6, 14, 13, 34 and 4
  passing.
- On the intermediate 4b, which differs only in the runtime arithmetic:
  `npm run lint` gave 0 errors, `test/sqlscript-table-function.mjs` and
  `test/store-exclusions.mjs` passed, osgo built, the ADT gogen gate had 0
  failures, and `test/adt-conformance/run.mjs --target osgo` gave 64 pass,
  0 fail. Before the FOR UPDATE commit, 9 of 845 ABAP Unit methods failed,
  all of them `SELECT SINGLE FOR UPDATE` in `ZCL_L3_FLEET_PROOF`.
- The advisory-job round: `node tools/gogen/semantics.mjs` passes (508 ok
  rows; it had failed on `zcl_gogen_t_movclr.clas.abap:65` before the
  tolerance), `node tools/gogen/unit.mjs --fixture tools/gogen/testdata
  --jobs 4` runs 147 tests in 47 classes, all SUCCESS, `npx mocha
  test/kernel-conformance.mjs test/osg-support.mjs` gives 36 passing, and
  `node tools/osd-kernel-check.mjs --support <the run's support.json>
  --page docs/osg-support.md --inventory .github/ci/kernel-inventory.json`
  says the evidence agrees. `npm run bootstrap` on the pin builds 2442
  objects. The corpus cannot be regenerated on this machine (the C fixtures
  want clang), so the TestOSD folder was derived from the CI run's measured
  `support.json` minus the locally staged `int8` folder, whose constructs
  are byte-identical to the tracked ones.
- The gogen cache round (job 129202076154, 56 failures in the
  `node --test --test-concurrency=1` step over the sixteen cache/provenance
  files): rerun file by file on the pin after the three adaptations above,
  every file green — 331 tests, 0 failures, including the "CI oracle"
  mutation sweep (62 attempts, 0 mismatches) and both NEGATIVE fresh-process
  oracles; `node tools/gogen/lint-engine.test.mjs` with
  `tools/step3/checkrun-diff.test.mjs` and `npx tsc -p tsconfig.gogen.json`
  stay clean, and `semantics.mjs`/`unit.mjs` above were rerun and pass.
