# Tools

The top-level `osd-build.mjs`, `osd-transpile.mjs`, `osd-warm.mjs`, and `osd-hot.mjs` build and refresh generations of transpiled ABAP. Start with [the feature map](../docs/where-is.md) for their commands and tests; [warm compile](../docs/warm-compile.md) explains the short rebuild path.

The `segw-*.mjs`, `cds2ddic.mjs`, and `stg-compile.mjs` files turn service, CDS, and project descriptions into source or registry artifacts. The corresponding behavior is described in [SEGW mapping](../docs/segw-mapping.md), [SEGW tree](../docs/segw-tree.md), and [the compile pipeline](../docs/stg-compile.md).

The `osd-store.mjs`, `osd-data.mjs`, `osd-db.mjs`, and `osd-runtime.mjs` files provide object, data, database, and process commands. [Database backends](../docs/db-backends.md) covers the storage choices. `osd-tmp.mjs` (with `osd-store-tmp.mjs` for the store and `osd-tmp-view.mjs` for what a session sees) is `$TMP`, the local package every system has: the folder `local/tmp`, a build layer once something is created in it, objects with their author, and never part of a deploy zip (`test/tmp-package.mjs`, measured on A4H in `test/fixtures/tmp-package/a4h.json`).

`osd-sql-literals.mjs` is the one place a database client finds the string literals in a statement: `splitLiterals` scans them once (`''` is a quote inside one), `outsideLiterals` runs a rewrite over the code with every literal masked and puts the literals back byte for byte, and `abapSelectToSql` is the rewrite list every client applies to a runtime SELECT (UP TO, ORDER BY PRIMARY KEY, ASCENDING/DESCENDING, `~`, LIMIT 0, LEFT/RIGHT for SQLite). A client never runs a regular expression over the whole statement: a value such as `'a~b'` or `'x UP TO 9 ROWS'` is data (ANORMALIES `sql-literals-statement-text`, `test/sql-literals.mjs`). `sql-literals.mjs` (`trimLiterals`) reads the same scanner.

The `osd-suites.mjs`, `osd-leak-scan.mjs`, and `osd-naming-scan.mjs` files run integration and publication checks. [CI tests](../docs/ci-tests.md) explains the suite split; `npm run where` rebuilds [the feature map](../docs/where-is.md) from repository inventories.

`osd-vsix-bare-smoke.mjs` installs and starts a VSIX in Ubuntu without Node, npm or Git on PATH. Its self-contained [module and README](../docker/vsix-bare/README.md) cover the harness, optional layers and advisory workflow.

`gogen/` holds the Go backend and its own [README](gogen/README.md). `sqlscript/` holds SQLScript parsing and analysis tools; see [the SQLScript surface](../docs/sqlscript-surface.md).

[layer-version](layer-version/README.md) checks minimum `osd` requirements in pack and workspace manifests before a build and stamps the packaged system version.
