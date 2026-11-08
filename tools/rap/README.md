# RAP source tools

`bdef-parse.mjs` parses behavior definitions into a versioned JSON model;
`tokenize.mjs` supplies source spans and reuses abaplint token/position classes.
`bdef-gen.mjs` generates ordinary ABAP types under `gen/rap/`;
`lower-derived.mjs` lowers explicit derived declarations in the source loader.
There is no runtime in this folder.

```
node tools/rap/bdef-parse.mjs example.bdef.asbdef --json
node tools/rap/bdef-parse.mjs --corpus corpus-directory
node tools/rap/bdef-gen.mjs
npx mocha test/rap-bdef-parse.mjs test/rap-derived-types.mjs
```

Import `parseBdef(source)` or `corpusCounts(directory)` without CLI side effects.
See [the schema and coverage](../../docs/rap-bdef.md). Unknown grammar is retained
in `unparsed`, so consumers must check that array before generating anything.

See [the R1 mechanism and limits](../../docs/rap-derived-types.md).
