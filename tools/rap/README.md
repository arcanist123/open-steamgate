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
