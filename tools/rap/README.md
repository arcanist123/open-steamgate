# RAP source tools

`bdef-parse.mjs` parses behavior definitions into a versioned JSON model;
`tokenize.mjs` supplies source spans and reuses abaplint token/position classes.
There is no runtime or generated ABAP in this folder.

```
node tools/rap/bdef-parse.mjs example.bdef.asbdef --json
node tools/rap/bdef-parse.mjs --corpus corpus-directory
npx mocha test/rap-bdef-parse.mjs
```

Import `parseBdef(source)` or `corpusCounts(directory)` without CLI side effects.
See [the schema and coverage](../../docs/rap-bdef.md). Unknown grammar is retained
in `unparsed`, so consumers must check that array before generating anything.
