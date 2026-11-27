# RAP source tools

`bdef-parse.mjs` parses behavior definitions into a versioned JSON model;
`tokenize.mjs` supplies source spans and reuses abaplint token/position classes.
`bdef-gen.mjs` generates ordinary ABAP types under `gen/rap/`;
`lower-derived.mjs` lowers explicit derived declarations and the handler
declarations of the system's form (`FOR DETERMINE` / `FOR VALIDATE` /
`FOR MODIFY` / `FOR READ` / `FOR LOCK`, R3) in the source loader.
`rap-runtime-gen.mjs` (called by `bdef-gen.mjs`) writes the typed adapter of
each managed BDEF and `ZCL_OSD_RAP_REGISTRY` for the ABAP runtime in
`src/rap/` ([R2](../../docs/rap-runtime.md)).
R5: `bdef-gen.mjs` also resolves the tree of a BDEF from its CDS
compositions (`treeOf`), writes the derived types of its associations
(`TABLE FOR CREATE e\_x`, `READ IMPORT/RESULT/LINK e\_x`), and resolves a
projection BDEF against its base (`projectionOf`); the registry answers the
projection entities ([R5](../../docs/rap-runtime.md)).
R6: internal, factory and determine actions (`checkAction` in `bdef-gen.mjs`;
a determine action joins the actions marked `determine`, its members become
the model's `members`), and a dependency by an association to an ancestor.
R8: draft (`checkAction` and `checkDraft` in `bdef-gen.mjs`; the runtime's
contract -- draft tables, the mandatory draft actions -- refused by
`rap-runtime-gen.mjs`, which also writes the union class of each draft
entity, `zcl_rap_<hash>_d<n>`); `srvd-gen.mjs` serves a draft entity with the
key `IsActiveEntity` and `Common.DraftRoot` / `DraftNode`. R9: it adds the
navigations `SiblingEntity` and `DraftAdministrativeData` to every entity of
a draft BO and serves `ZOSD_I_DRAFTADM` as `DraftAdministrativeData`; the
union rows carry `SIBLINGENTITY`, `DRAFTADMIN`, `INPROCESSBYUSER`.
R11: an interface BDEF (`interface;`) is resolved and typed as a projection
of its base; a root's determine action may name members of the entities
below it (`ls_member-entity`); an unmanaged save without a mapping table
reads through its CDS view; the adapter hands handlers `%is_draft` and
`%pid` in their keys; `bdef-parse.mjs` keeps an entity header's pragmas.
The CDS side of the carrier singleton (constant elements, the computed
root) is `tools/cds-computed.mjs`.
`srvd-gen.mjs` (called by `bdef-gen.mjs`) reads service definitions
(`*.srvd.srvdsrv`) into `gen/rap/<srvd>.stg.yaml`, which `stg-compile --all`
compiles into a service ([R2c](../../docs/rap-runtime.md#serving-r2c)).

```
node tools/rap/bdef-parse.mjs example.bdef.asbdef --json
node tools/rap/bdef-parse.mjs --corpus corpus-directory
node tools/rap/bdef-gen.mjs
npx mocha test/rap-bdef-parse.mjs test/rap-derived-types.mjs test/rap-runtime-gen.mjs
```

Import `parseBdef(source)` or `corpusCounts(directory)` without CLI side effects.
See [the schema and coverage](../../docs/rap-bdef.md). Unknown grammar is retained
in `unparsed`, so consumers must check that array before generating anything.

See [the R1 mechanism and limits](../../docs/rap-derived-types.md).
