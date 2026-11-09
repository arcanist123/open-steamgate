# Transpiler pin move 4

The transpiler pin moves from `local/osd-build-3d` (`9792b3c8`, upstream
2.14.3 `c8a493c3` plus twelve fork commits) to `local/osd-build-4b`
(`297b1dc92da8965ab00bb56dc68bca92259e1aea`) on `oisee/transpiler`, which is
upstream main `62931245` (2.14.19 plus the EML lowering, #2049) with seven
commits on top. The reason for the move is EML: `src/rap_demo/zcl_rap_note_eml`
is written with real `MODIFY` / `READ` / `COMMIT ENTITIES` and is now built
and tested like any other class.

## Source pins

| Pin | Before | After |
| --- | --- | --- |
| oisee/transpiler | `9792b3c879972450aeb99b89747545a51b589522` (`local/osd-build-3d`) | `297b1dc92da8965ab00bb56dc68bca92259e1aea` (`local/osd-build-4b`) |
| Parser: OSG CLI/core and transpiler root/library/CLI | exact `2.120.73` | exact `2.120.94` |
| npm `@abaplint/transpiler`, `transpiler-cli`, `runtime` | `2.14.3` | `2.14.19` |

The workflows read the pin from `libs.lock.json` (`tools/osd-lock.mjs`), so
there is no second copy of the SHA to move. The other two of the "three pins"
(open-abap-core and the pack manifests) are unchanged.

## What the branch carries

`local/osd-build-4` (`d3ae05de`) is upstream main `62931245` plus the Open SQL
host-variable escape, the same change as abaplint/transpiler#2050 (merged
upstream on 2026-11-09 as `8824945a`, after the branch was cut). That alone
does not build OSG: the build gate (`tools/osd-ci-transpiler-build.sh`)
requires the `only` option and registry reuse, which never went upstream.
`local/osd-build-4b` adds:

| Commit | Origin | Why |
| --- | --- | --- |
| `8054d96f` four fixes | fork `70c28074`, clean pick | still not upstream |
| `95ce0592` built-in argument by name | fork `99bce8ed`, clean pick | still not upstream |
| `89155453` `only` option | fork `f48650af`, clean pick | warm compile, `dsl-l3-load`, the build gate |
| `d5111ce3` registry reuse with `only` | fork `2ebac0a2`, clean pick | as above |
| `d5c30cc0` CREATE DATA TYPE HANDLE guard | fork `f34e9bf4`, clean pick | test only |
| `6d43ae02` core exact 2.120.94, `only` without the plugin guard | new, as `6f2119b8` did for 2.120.73 | the gate compares the parser by manifest string |
| `297b1dc9` `SELECT SINGLE FOR UPDATE` runs as the SELECT | new | ANOMALY-2026-11-09-select-for-update-refused |

## What is not carried

Six fork commits conflict with upstream main, which reworked
`packed.ts`, `integer.ts`, `add.ts`, `read_table.ts`, `loop.ts` and the
template formatting since 2.14.3: exact packed arithmetic (`cd914013`), int8
and integer byte conversions (`aa06510e`), type `i` overflow and its
positions (`13473321`, `acb974ba`, `a8b25e86`, `da9b1785`; upstream PR #1955,
still open) and the 2.120.73 adaptation (`6f2119b8`). Their own tests, run
against `local/osd-build-4b`, fail in about 90 cases (integer overflow 35,
packed store and arithmetic 53, three others). OSG's ABAP Unit run shows no
failure from them (845 methods; the 9 failures were all FOR UPDATE), so no
test of this tree depended on them, but the `i` range check is again missing
(ANOMALY-2026-09-25-zip-read-int4 and the other `#1955` entries). Porting them
onto upstream main is a decision of its own.

## What the upstream jump changed for OSG

- **Parser 2.120.94: a token is its own position.** `Token.start` is gone
  (`AbstractToken extends Position`), so code that read `token.start` got
  `undefined`. `tools/amdp-extract.mjs` crashed the build (`next.col` of
  undefined: `undefined === undefined` passed its same-row test);
  `tools/osd-unit.mjs` and `tools/gogen/osgo-adt-unit.mjs` would have put every
  test method at line 1. All three use `getStart()` now, which both parser
  versions have.
- **The parser checks the BDEF of an EML statement.** `MODIFY ENTITIES OF
  zi_rap_note` is a syntax error ("Behavior definition not found") unless the
  BDEF is in the transpiler's registry, so `\.bdef\.` left the
  `exclude_filter` of `abap_transpile.json`; the transpiler reads the BDEF and
  emits nothing for it.
- **`SELECT SINGLE FOR UPDATE` is refused** (2.14.14 at transpile time, 2.14.15
  at run time). Fork commit `297b1dc9`, anomaly entry, needs an issue.
- **EML lowering.** The `_eml_demo` exclusion is gone, and so is the matching
  filter in `test/rap-derived-types.mjs`.

## How it was checked

All of these ran on one machine, one at a time under the shared lock:

- transpiler repository, `local/osd-build-4b` before the FOR UPDATE commit:
  `npx mocha` 2856 passing, 151 failing, all 151 `connect ECONNREFUSED
  127.0.0.1:5432` (no PostgreSQL on the machine); `packages/transpiler` mocha
  434 passing after it.
- `npm run transpile`: 2442 objects.
- `node tools/osd-unit-run.mjs`: 845 methods, 9 failed before `297b1dc9`, all
  `SELECT SINGLE FOR UPDATE` in `ZCL_L3_FLEET_PROOF`; after it the class passes
  except the six methods the full run gives a worker.
- `node tools/osd-unit.mjs CLAS ZCL_RAP_NOTE_EML`, `ZCL_OSD_RAP_EML_TEST`,
  `ZCL_OSD_RAP_TEST`: all green.
- `npm run lint`: 0 errors (86 warnings, as before).
- `npx mocha` over `test/mocha.mjs` (30, the quote-in-a-key wire tests among
  them), `test/odata-v4.mjs` (83, "round three" among them), `test/rap-*.mjs`
  (21, 10, 6, 14), `test/transpiler-pin.mjs` (13), `test/amdp.mjs` (34),
  `test/amdp-demo.mjs` (4), `test/sqlscript-table-function.mjs` (21),
  `test/store-exclusions.mjs` (4): all passing.
- osgo: `sh tools/abapfs-osgo.sh --setup-only` builds, the ADT gogen gate has 0
  failures, and `test/adt-conformance/run.mjs --target osgo` answers 64 pass,
  0 fail.
