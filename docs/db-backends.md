# The database seam: what a backend has to be

The transpiled ABAP never touches a database driver. Every Open SQL statement
goes through one object, `abap.context.databaseConnections["DEFAULT"]`, which
implements the runtime's `DatabaseClient` interface. Swapping the engine is
swapping that object. This repository already carries two implementations,
which is the best evidence that the seam is real:
`@abaplint/database-sqlite` (sql.js) and `tools/duckdb-client.mjs` (ours).

## The interface

`@abaplint/runtime/build/src/db/db.d.ts`, eleven members, all asynchronous:

| Member | Takes | Gives |
| --- | --- | --- |
| `name` | — | the identifier of the database (`"sqlite"`, `"duckdb"`) |
| `connect()` / `disconnect()` | — | — |
| `execute(sql)` | one statement or an array of them | — |
| `beginTransaction()` | — | no-op when one is open |
| `commit()` / `rollback()` | — | no-op when none is open |
| `insert({table, columns, values})` | strings | `{subrc, dbcnt}` |
| `update({table, where, set})` | strings | `{subrc, dbcnt}` |
| `delete({table, where})` | strings | `{subrc, dbcnt}` |
| `select({select, primaryKey})` | the statement in **ABAP SQL**, the key fields | `{rows}` |
| `openCursor({select, primaryKey})` | the same | `{fetchNextCursor(n), closeCursor()}` |

A row is a flat object of `number | string | Uint8Array | null`. There are no
prepared statements, no bind variables and no cursors in the interface itself:
the runtime hands over finished SQL text, and `openCursor` may be served by
reading everything and slicing, which is what our DuckDB client does.

That is the whole contract. For a Go host-function backend it means eleven
functions taking strings and returning plain data — no objects to model, no
callbacks except the two the cursor returns.

## Where the switch is

Above the clients, in this repository, not inside the runtime:
`test/setup.mjs` is called by the transpiled runtime before anything runs
(`abap_transpile.json`, `options.setup`) and decides:

```js
db = new SQLiteDatabaseClient();                 // or DuckDBDatabaseClient
abap.context.databaseConnections["DEFAULT"] = db;
await db.connect();
await db.execute(schemas.sqlite);                // DDL for that dialect
await db.execute(insert);                        // the transpiler's seed rows
await db.execute(seedStatements());              // ours, from data/*.tabu.json
```

`STG_DB=duckdb` picks the other one, `STG_DB_PATH` makes it persistent, the
browser preview passes a database restored from cache storage. A third
backend needs no change anywhere else: write the object, add a branch here.
The VS Code extension picks `STG_DB` for you (`osd.database.system` /
`osd.database.tests`, `docs/vscode-extension.md`, "Databases") rather than
you setting the env var by hand.

## What the runtime emits, and who translates

The runtime emits **ABAP SQL**, not the target dialect, and the client does a
small, known rewrite. `@abaplint/database-sqlite` does exactly seven
substitutions before handing the text to sql.js:

- `UP TO n ROWS` → `LIMIT n`
- `ORDER BY PRIMARY KEY` → the key fields, or dropped when they are unknown
- `ASCENDING` / `DESCENDING` → `ASC` / `DESC`
- `~` → `.` (the ABAP table-field separator)
- `LIMIT 0` dropped
- `LEFT(x, n)` / `RIGHT(x, n)` → `substr(...)`

Everything else is passed through, so a backend over a SQLite-compatible
engine (`modernc.org/sqlite` is one) can reuse those rules verbatim and is
done. `INTO CORRESPONDING FIELDS`, aggregates, joins, `FOR ALL ENTRIES` and
the rest are resolved by the runtime before the client sees them.

What it cost to go to a *different* dialect is the honest measure of how much
dialect there is, and it is documented in
[`docs/handover-database-duckdb.md`](handover-database-duckdb.md). Three
things, no more:

1. **A different DDL flavour.** The transpiler writes the schema in four
   dialects (`schemas.sqlite`, `.pg`, `.hdb`, `.snowflake`); DuckDB takes the
   PostgreSQL one with `NCHAR(n)` rewritten to `VARCHAR(n)`.
2. **Trailing blanks.** ABAP CHAR is blank-padded and the runtime pads the
   literals it puts into SQL. SQLite columns are `NCHAR ... COLLATE RTRIM`,
   so `'A  ' = 'A'` holds; DuckDB compares the blanks, so our client trims
   literals (quote-aware). A SQLite-compatible engine inherits the collation
   and needs none of this.
3. **Savepoints.** The runtime opens a transaction on the first modifying
   statement and expects a failed statement to leave the transaction usable.
   DuckDB aborts the whole transaction instead, so our client remembers the
   successful statements of the LUW and replays them. SQLite behaves the way
   the runtime expects.

So: a Go backend over `modernc.org/sqlite` is the cheap case. It inherits the
SQLite DDL, the `COLLATE RTRIM` semantics and real savepoints, and its whole
job is the eleven methods plus the seven rewrites.

## What a host-function backend still has to solve

Everything in the interface is `Promise`-returning and the transpiled ABAP is
`await`-ed all the way down. A JavaScript engine embedded in Go therefore
needs a microtask queue and, if Go work happens off the JS thread, an event
loop that resolves promises from Go. If the Go side answers synchronously,
the methods can return already-resolved promises and no loop is needed.

Two things this repository can say about the JS side, from carrying the
browser build: the runtime needs no WebAssembly to have a database, because
`webpack.config.cjs` already aliases `sql.js$` to `sql.js/dist/sql-asm.js`,
the asm.js build (plain JavaScript, one file, no `.wasm` to route); and the
whole gateway plus runtime plus that engine already bundles to **one classic
script** (`build/sw.js`, 14 MB, service worker, no ESM at load time). Whether
a given engine executes a 4 MB asm.js blob fast enough is a separate
question, and a Go-backed client removes it entirely.

## What the vsp session measured on top of this (2026-09-13)

The question behind the write-up was whether the transpiler's runtime plus
this gateway can be embedded into a single static Go binary instead of
shipping a Node sidecar. Their result, for the record:

- **goja runs it, after one down-level.** As published, the runtime does not
  load: `abap.statements.loop` is an async generator and goja has none. With
  Babel lowering the async-generator syntax it runs, byte-identical output,
  three small shims, and 40 to 85 times slower than V8 **with the database
  stubbed**. That makes it an envelope for the runtime, not a measurement of
  a request: the Go path still needs the modernc backend before any number
  means something end to end. Bun sidesteps it with a native SQLite, and
  runs JavaScriptCore rather than V8.
- **The blocker was never WebAssembly.** Our browser build already uses the
  asm.js build of sql.js, so a database without wasm exists today. The case
  for a Go backend over `modernc.org/sqlite` is speed and dropping a 14 MB
  bundle, not feasibility.
- If the embed path is chosen, the first build item is exactly the eleven
  methods and seven rewrites above, as Go host functions.

## Not measured here

Speed of a Go-hosted engine against ours. `npm run bench:cube -- 1000000` compares SQLite and DuckDB through this
same seam; nothing comparable exists for a Go engine yet.

## The LUW, and the fact that there was not one

Measured 2026-09-18, while making a `$batch` changeset atomic (backlog B.2):
**nothing in this system ever committed.** All three clients implement the
bracket — `beginTransaction` is called by every write, and `commit` /
`rollback` end it — so the server ran from boot to disconnect inside a single
open transaction, and the rows survived only because `export()` and
`disconnect()` commit on the way out.

That is not harmless once anything rolls back. A `ROLLBACK WORK` issued to
undo one failed request would have undone everything written since the
process started, including the tables the generation writes at boot (`tadir`,
`wwwparams`, `t100`).

So the rule is: **a rollback is always preceded by a commit that fences it.**
`zcl_stg_batch` issues `COMMIT WORK` before it dispatches a changeset, which
ends whatever LUW was open, and only then can its `ROLLBACK WORK` reach no
further back than the changeset itself. The same shape is what any other
transactional boundary here has to use until something owns the LUW properly.

`COMMIT WORK` reaches every open connection (`abap.statements.commit` loops
over `context.databaseConnections`), so this holds for SQLite, the file-backed
client and DuckDB alike — DuckDB emulates savepoints by replay, which is why
it too needs the fence rather than a nested transaction.

### What the fence fixed in the DuckDB client as a side effect

`tools/duckdb-client.mjs` has no savepoints. It keeps every successful
modifying statement of the open LUW in `this.luw` and, when a failing
statement aborts the DuckDB transaction, rolls back and **replays the array**
into a fresh one. `beginTransaction`, `commit` and `rollback` each reset it.

While nothing committed, `commit` was never called, so that array grew from
boot until disconnect — and every failed statement replayed the entire
history of the process, the generation's boot writes included. The behaviour
was correct and quietly quadratic.

With the fence the array lives exactly one LUW, which gives a cheap check
that the bracket is really there: **the length of `luw` must stay within one
LUW's worth of statements.** Noticed by the workstation session, 2026-09-18,
reading the client rather than the symptom.

Verified after the change, on all three clients rather than assumed, because
they only behaved alike while the bracket was unused: `npm run unit:duckdb`
passes, and the wire suite against a DuckDB-backed server is 22 of 22,
including the changeset rollback and the composition cascade.

## What a remote database costs, measured

The question "could HANA be the data layer, so AMDP runs native?" is a good
one and the seam allows it. What decides it is the per-statement cost, and it
was measured on 2026-09-18 — the same three statements against the in-process
SQLite this tree uses and against HANA Express in a container on the same
machine:

| statement | SQLite, in process | HANA Express, container | factor |
| --- | ---: | ---: | ---: |
| `SELECT` one row by key | 38 us | 1976 us | **52x** |
| `SELECT` 200 rows | 195 us | 743 us | 3.8x |
| `INSERT` one row | 12 us | 1748 us | **146x** |

The shape matters more than the numbers: **the cost is per statement, not per
row.** One round trip that brings back 200 rows is only 3.8x worse than doing
it in process, because the round trip dominates and it is paid once. A single
row costs the same round trip for almost no work, so it is 52x. An insert,
which in SQLite is twelve microseconds, is 146x.

So ABAP written set-wise — `SELECT ... INTO TABLE`, `FOR ALL ENTRIES` — ports
to a remote database almost for free, and ABAP written row-at-a-time does not.
That is the same rule a real system teaches, and here it is with numbers.

What follows for us:

- **HANA can be the data layer, as an option, and never as the default.** It
  buys fidelity that nothing else does: `sy-dbsys = HDB`, real HANA semantics,
  and AMDP running against the same tables the rest of the ABAP reads, which
  removes the mirroring question in `docs/amdp-in-hana.md` entirely.
- It costs a 4.5 GB image and a container to run anything at all, against
  SQLite's nothing, and it would make the test suite markedly slower: our seed
  alone is 2521 statements, which is about 30 ms in process and about 4.4 s
  over the wire.
- The two pieces of work are a `DatabaseClient` (eleven methods, the npm
  driver `hdb`, the same shape as `tools/duckdb-client.mjs`) and **a DDL
  generator, which does not exist**: the transpiler's `schemas.hdb` is
  literally `["todo"]`, next to three real generators for SQLite, PostgreSQL
  and Snowflake. Both would be contributions upstream rather than local
  patches.
- The same numbers price the Go host-function backend discussed above: in
  process it inherits SQLite's order of magnitude, over a socket it inherits
  this one.

## What `STG_DB=hana` would actually cost, measured against HANA Express

Measured 2026-09-18 against HXE on the i7, because the estimate before it was
guesswork. The three things that cost work when DuckDB was added are the
things to price, and two of the three come out cheaper than they did there.

**1. The DDL is free.** HANA accepts the PostgreSQL schema the transpiler
already generates, **unchanged**: all 77 `CREATE TABLE` statements of this
tree's tables were accepted as written. DuckDB needed one rewrite
(`NCHAR(n)` → `VARCHAR(n)`); HANA needs none. So `schemas.hdb` being
`["todo"]` upstream does not block us — `schemas.pg` is the HANA schema too,
which is worth knowing before anyone writes a generator.

*What this does not say*: acceptance is not semantics. The next point is an
example of a statement that is accepted and behaves differently.

**2. Blank padding: the same problem DuckDB had.** ABAP `CHAR` is
blank-padded and the runtime pads the literals it puts into SQL. SQLite's
columns are `NCHAR ... COLLATE RTRIM`, so `'A  ' = 'A'` holds for free. HANA
does not pad and does not ignore the padding:

```
NCHAR(10) holding 'A'   ->  LENGTH(K) = 1
WHERE K = 'A         '  ->  no rows
WHERE K = 'A'           ->  one row
```

So a HANA client needs the same quote-aware literal trim
`tools/duckdb-client.mjs` already does, and that code is reusable as it
stands.

**3. Savepoints are not needed, and this is where HANA is cheaper than
DuckDB.** The runtime opens a transaction on the first modifying statement
and expects a failed statement to leave the transaction usable. DuckDB aborts
the whole transaction, which is why our client keeps the LUW's successful
statements and replays them. HANA behaves the way the runtime expects:
measured, a duplicate-key `INSERT` was rejected and **the next `INSERT` was
accepted** — the transaction survived. No replay machinery at all.

One prerequisite that falls out of the same probe: the session has to have
autocommit turned off, or `COMMIT`/`ROLLBACK` mean nothing and `SAVEPOINT`
answers `TxSavepoint with autocommit is not supported`.

**So the remaining work is the eleven methods and the connection handling**,
with the literal trim borrowed from the DuckDB client and no dialect work of
consequence. What stays expensive is not the writing — it is the per-statement
latency measured in the section above, which is why this is a mode and not a
default.

## The HANA client, and the ten things that were in the way

Built 2026-09-18, `tools/hana-client.mjs`, `STG_DB=hana`. **Both suites reach
parity with SQLite: the 146 ABAP unit tests all run, and the 22 wire tests all
pass.**

What is worth recording is not that it works but what it cost, because nine
of the ten obstacles were **not** about SQL, and none of them could have been
read out of documentation. Each was found by running the suite and watching
where it stopped.

1. **Identifier case and quoting.** Three shapes were tried and only the third
   works. *As written* (quoted, lower case): HANA accepts all 77 `CREATE
   TABLE` and then nothing can be read, because the runtime's references are
   unquoted and HANA folds those to upper — `invalid column name:
   zosd_test_item.ITEM_ID`. *Unquoted*: both sides fold alike, until a column
   called `cross` turns out to be a reserved word — and `SYS.RESERVED_KEYWORDS`
   also holds `END`, `GROUP`, `ORDER`, `START`, all plausible ABAP field names.
   *Quoted upper case*: unquoted references fold onto it and reserved words are
   safe. That one.
2. **A rerun met its own tables.** `STG_DB_FRESH=1` now drops the schema first.
3. **Seed inserts arrive in two shapes** — columns in single quotes (HANA reads
   those as string literals) and columns already double-quoted in lower case.
   Both are folded.
4. **The driver's packet limit.** node-hdb defaults to 128 KB and refuses
   anything larger with `Packet size limit exceeded`. Our own seed statements
   are tiny — the largest is 2 KB — but the transpiler puts whole ABAP sources
   into `reposrc` and SMW0 media into `wwwdata` as hex, so one `INSERT` is
   megabytes. Raised to 64 MB; the driver's own ceiling is 2^30-1.
5. **The same stream carries both forms.** Most references are unquoted, and
   some statements arrive quoted in lower case — `INSERT INTO "cross" ("type",
   ...)`, written by the runtime at boot. Folding the contents of every quoted
   identifier to upper makes both land on one name.
6. **Row keys come back upper case** and the runtime looks a column up by the
   lower-case name it asked for: `rowsToTarget` reads `row[field]`, gets
   `undefined` and dies inside `Character.set`. Folded back down on return.
   Fold up on the way out, fold down on the way back — one rule, twice.
7. **A double quote is not always an identifier.** A column holding the JSON
   `{"draft":"kept"}` is a *value*, and folding it turned the data into
   `{"DRAFT":"KEPT"}`. A test caught it; nothing threw.
8. **`WHERE true AND true AND ...`**, which the runtime builds when it has no
   condition, is not valid in HANA — `incorrect syntax near "AND"`. Rewritten
   to `1 = 1`. **This is the only genuine dialect rewrite in the whole list.**
9. **`hasSchema()` asked for its own column in the wrong case**, answered
   false against a schema that was plainly there, and the setup then tried to
   create everything twice. The rule introduced in (6) caught its author one
   screen later.
10. **A Buffer does not imply a binary column.** node-hdb returns `BLOB` and
    `VARBINARY` as Buffer, but also returns `CLOB`/`NCLOB` that way. Converting
    every Buffer to hex preserved vectors and silently changed a session JSON
    string into `7B22...`. Prepared-result metadata now decides: character
    LOBs decode as UTF-8; binary LOBs retain the hexadecimal ABAP boundary.

**The rule worth carrying out of this**: a transformation of SQL that
distinguishes literals from the rest cannot be done in two passes. Items 7 and
8 are the same mistake — parse where the literals are, then run a regular
expression over the whole joined string, which no longer knows. Both were
silent data corruption rather than an error, and both were caught by a test
comparing a stored value, not by reading the code.

## Existing schema, read-only

`HANA_EXISTING_SCHEMA=1` runs the runtime over a HANA that already holds an
SAP system's schema — the tables are there, the data is there, and nothing of
ours may touch either. Built 2026-11-11 (H1): the mode in
`tools/hana-client.mjs`, the read-only guard beside it, and the first
measuring tool, `tools/hana-ddic-probe.mjs`.

The flags:

- `HANA_EXISTING_SCHEMA=1` — the mode. `connect()` skips `DROP SCHEMA` and
  `CREATE SCHEMA` and points the session at the configured `HANA_SCHEMA`
  with `SET SCHEMA`; `test/setup.mjs` returns straight after `connect()`, so
  the transpiler's DDL, the seed, the drift checks and the pack reseed are
  all skipped. The mode only skips; there is no second code path.
- `STG_DB_FRESH=1` together with it is refused before a socket is even
  opened: "start from nothing" is exactly what the mode must never mean
  against a schema somebody else owns.
- `OSD_HANA_WRITE=1` lifts the read-only guard below. Nothing in this tree
  sets it; it is the seam a later slice will need when the mode stops being
  read-only.

What is refused: unless `OSD_HANA_WRITE=1`, every statement that is not a
SELECT is refused at one chokepoint (`#guard` in `tools/hana-client.mjs`)
before it reaches the driver, with code `HANA_READONLY` and the statement
kind in the message — never the statement text, which may carry data.
Allowed beside SELECT: `SET` (connect()'s own session statement) and
`COMMIT`/`ROLLBACK` — the LUW bracket the runtime calls unconditionally
(`COMMIT WORK`, every `disconnect()`); the guard runs before a refused
statement could open a transaction, so both degenerate to the no-op their
early return already is. Refused by kind: INSERT, UPDATE, DELETE, MERGE,
UPSERT, CREATE, DROP, ALTER, TRUNCATE, CALL — and anything else, WITH
included. A text carrying more than one statement — a top-level `;` outside
the literals and comments — is refused as kind `multi` before the kind of
its first word is even read: `SELECT 1; DROP TABLE …` is two statements,
and the first word says nothing about the second.
`insert()`/`update()`/`delete()` re-throw the refusal instead of
answering subrc 4: "refused" is not "no such row". The native channel
(`defineRelation`, `native`, `dropRelation`) is refused the same way — a
lowered SQLScript write is a write.

One door this does not close: `tools/amdp-destination.mjs` builds its own
raw `hdb` client — its deploy issues `CREATE SCHEMA`, `DROP PROCEDURE`/
`FUNCTION` and `CREATE PROCEDURE`/`FUNCTION` through it, not through the
`HanaDatabaseClient` — so an AMDP deployed while the mode is on writes
without ever meeting the guard. Nothing in the mode's flow deploys AMDP
today, and the destination is not routed through the chokepoint yet;
gating that is part of the slice that first runs AMDP against an existing
schema. Until then the read-only promise covers what reaches
`HanaDatabaseClient`, and nothing beyond it.

The probe:

```
node tools/hana-ddic-probe.mjs --tables <A,B,C> [--out <dir>] [--diff] [--mandt]
```

reads DD02L, DD03L, DD04L, DD01L and DD02T from the configured schema
through the hana-client — the same `HANA_*` env, the same identifier
folding and literal trim — and emits the tree's own abapGit `*.tabl.xml`
per table. The DD03L → shape mapping is `tools/hana-ddic-map.mjs`, a pure
function tested without a database (`test/hana-ddic-map.mjs`, fixtures
`ZOSD_H1_*`). The DD* column lists are measured, not guessed —
`SYS.TABLE_COLUMNS` of a real schema, pinned as the fixture of
`test/hana-ddic-probe.mjs`, whose fake driver refuses any statement naming
a column the list does not carry (the first run against a real system died
on DD04L's INTTYPE, which lives on DD03L only) — and every read is pinned
to the active version (`AS4LOCAL = 'A'`, `AS4VERS = '0000'`), so a table
carrying an inactive version does not yield its fields twice. INTTYPE and
INTLEN come from DD03L directly, for every field, resolved or not; only a
blank is derived from the type rules, and the probe prints, per field,
when that was. `--diff` compares against `src/**/<table>.tabl.xml` when
present — field order, type, length, decimals, key flag, and the reference
a CURR/QUAN field carries (REFTABLE/REFFIELD, PRECFIELD, straight from
DD03L) — and exits 1 on any difference; `--mandt` says which tables have
MANDT as the first key
field. No HANA is reachable from CI: the probe is exercised with fixtures
and fake drivers, and run against a system by hand.

## Shadow schema: the client lives in HANA

`HANA_EXISTING_SCHEMA=1` with `HANA_OWN_SCHEMA` set (built 2026-11-11, H3):
the session does not sit in the tenant's schema — it sits in a schema of our
own, behind one view or synonym per table the build knows, and the logon
client is the filter.

The why: the runtime has no implicit client
(ANOMALY-2026-09-11-no-implicit-mandt in ANORMALIES.md) — `sy-mandt` is a
constant and generated SQL carries no `MANDT` predicate, so over a real
system's schema every read crosses every client; on the bed, 19,634 of the
tenant's 41,568 tables have MANDT as the first key field. Fixing it in the
generators is refused upstream ([abaplint/transpiler#606](https://github.com/abaplint/transpiler/issues/606));
fixing it in the database seam would need a second SQL parser. So the client
lives in HANA, the way SAP's own client handling does there: for every table
the generation knows (`ddicTables()` in `tools/hana-shadow-schema.mjs` walks
the same layers the build does), `connect()` makes sure our own schema holds

```
CREATE VIEW "<own>"."T" AS SELECT * FROM "<tenant>"."T" WHERE "<C>" = SESSION_CONTEXT('CLIENT')   -- DD02L.CLIDEP = 'X'
CREATE SYNONYM "<own>"."T" FOR "<tenant>"."T"                                                    -- otherwise
```

where `<C>` is the table's own client column, read off the tenant's DD03L
(active version): the first key field, in `POSITION` order, whose `DATATYPE`
is `CLNT` (`clientField` in `tools/hana-ddic-map.mjs`, read in chunks beside
the `DD02L` read). It is not assumed to be `MANDT`: on the bed a whole family
of client-dependent tables names it `CLIENT`, and `MANDANT`, `CLNT`, `RCLNT`
occur too. Until 2026-11-13 the view was hard-coded on `MANDT`, and for any
other name HANA refused the `CREATE VIEW` (no such column): in the eager set
that error ended `connect()`, and in the lazy half the fallback swallowed it
and the caller got the original 259, as if the table did not exist. A table
`DD02L` calls client-dependent with **no** `CLNT` key field (a few on the
bed carry something else first) is refused by name, with code
`HANA_NO_CLIENT_COLUMN`: no shadow object at all — a synonym would read
every client's rows, and a view on a guessed column is a wrong answer
dressed as a right one. The eager set says the refused names on stderr and
the connect goes on (any view or synonym an older build left for such a
table is dropped); a statement that then touches one gets the refusal, by
name, instead of a 259.

and then `SET SCHEMA "<own>"`. Joins, FOR ALL ENTRIES and aggregates inherit
the predicate; no generated SQL changes anywhere. Creation is idempotent:
the catalog (`SYS.VIEWS` with its `DEFINITION`, `SYS.SYNONYMS`) is read
first, existing objects are left alone, and a view whose definition drifted
is recreated with `CREATE OR REPLACE`. HANA holds the view's query string —
the text after `AS`, with `*` expanded into the quoted column list — in
`DEFINITION`, and "current" is decided structurally: whitespace-normalised,
the query must select anything (`*` or any quoted column list) from
`"<tenant>"."<T>"` with `WHERE "<C>" = SESSION_CONTEXT('CLIENT')`, `<C>` the
same DD03L column the view is created with (quoted, or bare for the views
made on `MANDT` before the column came from DD03L). The FROM
target and the predicate decide, the projection is HANA's to spell, and a
view pointing at another schema or table, filtering by a hard-coded
client, or filtering on a column that is not the table's client column, is
recreated. A connect that finds the view current sends nothing
(fix round 2: comparing the whole `CREATE` text recreated every view on
every connect; fix round 3, bed-measured 2026-11-12: comparing even the
query text did the same, because HANA stores the expanded columns — and two
hosts connecting at once raced on the replace).

The flags:

- `OSD_CLIENT` — the logon client. Existing-schema mode refuses to start
  without it: the session filters on `SESSION_CONTEXT('CLIENT')`, and a NULL
  client reads every client-dependent table empty. It is passed to node-hdb
  as the connect option `'SESSIONVARIABLE:CLIENT'` — `SET 'CLIENT'` is
  refused by HANA (455, predefined, measured on the bed). The same value is
  `sy-mandt` at boot (`bootIdentity` in tools/osd-identity.mjs), so ABAP
  branching on `sy-mandt` sees the logon client; `connect()` sets it too, for
  directly-constructed clients.
- `HANA_OWN_SCHEMA` — our schema, the session's home. Unset keeps the H1
  behavior exactly: `SET SCHEMA` to `HANA_SCHEMA` (the tenant), no shadow
  objects.
- `HANA_SCHEMA` stays the tenant. `STG_DB_FRESH=1` with the mode is refused
  as before; `OSD_HANA_WRITE=1` lifts the read-only guard as before.

Two guards keep the DDL ours. The read-only guard is extended by exactly one
allow: the four shadow shapes — `CREATE [OR REPLACE] VIEW`, `CREATE
SYNONYM`, `DROP VIEW`, `DROP SYNONYM` — and only when the owning schema read
off the statement is `HANA_OWN_SCHEMA`; a `CREATE` on the tenant schema is
still refused with `HANA_READONLY`, and `CREATE TABLE` on our own schema is
not a shadow shape and stays refused. And the eager set is only what the
tenant's `DD02L` holds: a table of our own (`ZSTG_*`) has no shadow, because
it is not in `DD02L` at all. Table names with a SAP namespace
(`/DMO/TRAVEL`) shadow like any other: quoted identifiers carry the
slashes, the 259 parser keeps the namespace, and the eager set admits the
name. `HANA_OWN_SCHEMA` equal to `HANA_SCHEMA` is refused before a socket
opens — the shadow views would sit on the tenant's own tables, and the
read-only guard, reading the owning schema off the statement, would admit
DDL on them. Both schema names are normalised to upper once at
construction, so the DDL, the catalog literals and `SET SCHEMA` spell one
schema.

The lazy half: a statement that fails with HANA error 259 (invalid table
name) carries the table name in the error; when the tenant's `DD02L` holds
that name, the shadow object is created and the statement retried — once,
and only once. The lazy half reads the same DD03L client column, and makes
or checks the view by the same rule as the eager set. The name is read from the error, never from the statement.

The DDIC the build knows comes from the real system:
`tools/hana-ddic-gen.mjs` reads the tenant's DD03L and writes
`gen/hana-ddic/<table>.tabl.xml` — `--tables A,B` reads those,
`--from-build` discovers them (a missing DDIC name surfaces in the
transpile's own validation output, `check_syntax, Database table or view "x"
not found` / `unknown_types, ... contains unknown: X not found`; the tool
reads the transpiler's words, never parses ABAP). `npm run transpile` creates the folder
empty from the first build on (only a database-backed `--from-build` fills it), and the readers
tolerate its absence regardless, because a fresh clone runs the osgo host before any transpile.
`gen/hana-ddic` is listed
in `abap_transpile.json` **before** `src/`: the later folder wins, so a
hand-written `src/<table>.tabl.xml` of the same name shadows the generated
copy — the real system's DDIC loses to an override only on purpose, and a
folder that is an input of its own is walked as its own layer by the build,
the transpiler and the store alike. Everything is exercised with fakes and
fixtures (`test/hana-ddic-gen.mjs`, `test/hana-shadow-schema.mjs`); no HANA
is reachable from CI, and the acceptance runs on the bed.

The control that the filter works, on a bed:
`node tools/hana-client-control.mjs --table <T> --clients 000,001`, with the
env of the mode. Per client it opens a session the way the runtime does and
counts `<T>` through our own schema, then reads the tenant directly (rows per
DD03L client column, and the total). It passes only when every client's count
is the tenant's count for that client, the shadow object is a view, and the
counts differ from each other and from the total -- so a table holding one
client's rows cannot pass: a missing filter would read the same numbers. It
refuses to run outside the shadow-schema mode. Tests over a fake database in
`test/hana-client-control.mjs`.

Not covered, as decided when the mechanism was chosen (2026-11-11): `CLIENT
SPECIFIED` — reading across all clients would want a synonym-read variant
per table, countable in the corpus before anyone needs it; and writes into
the tenant schema, which the grant forbids today (OSG is SELECT-only there).
The mode stays read-only; the shadow DDL is our schema's own and is the one
explicit exception the guard admits.

A DDIC view of the tenant (H5d) takes the synonym, client dependence or
not: the tenant object is itself a read-only database view, and the
shadow names it — it does not wrap it. A wrapped view would be a second
definition of a read-only object to police for drift, bought for a client
filter that only a client-dependent view could use; the view the dumps
carry is client-independent, a client-dependent one would read across
clients through the synonym, and if one ever arrives the filtered shape
is one branch away (`TABCLASS` rides with `CLIDEP` in the eager read).
The view reaches the eager set the way a table does — its structure type
is a TABL object of `gen/hana-ddic`, so `ddicTables()` collects it — and
a read that outruns the eager set is the lazy fallback's 259, answered
with the same synonym. Outside this mode there is no shadow and no
database view at all: the structure type is the whole of what a non-HANA
backend gets, and a read of the view fails at SQL time.

## Sources out of the tenant: gen/hana-src

The other half of the tenant's content is its sources. They do not arrive
through a loader (the H4 decision, 2026-11-12: vsp already holds the decoder
and a second one would be a new wheel) — they arrive as **input layers**,
made by two tools that live outside this repository and read nothing but a
dump:

1. `vsp hana dump` (the a4h sibling's private binary) writes a dump
   directory: `manifest.json`, `reposrc.jsonl`, `src/*.abap` and the raw
   cross-reference tables under `tables/*.jsonl`. The dumper holds the
   credentials; this repository never runs it.
2. the dump→layers converter (`dump-to-layers.mjs`, Node builtins only)
   reads a dump and writes `plan.json` plus `layers/<name>/{.abapgit.xml,
   src/}` — one abapGit repository per package, `order` topological with
   dependencies first, `cycles` the package SCCs it cannot order.

`tools/hana-src-gen.mjs` copies the selected layers into
`gen/hana-src/<NNN>-<name>/` — NNN is the plan's order, zero-padded, so the
names sort in dependency order — and writes `gen/hana-src/manifest.json`
with the layers' provenance: the source directory — for `--from-dump`, the
dump directory and the `--system` prefix, not the converter's temp
directory (a fresh mkdtemp every run would make `--from-dump --check` drift
on the path alone, and point at a directory that no longer exists) —, the
dump manifest's provenance and hash when plan.json carries them, the
converter's commit when plan.json carries one. A cycle group is one folder, the members' src
merged and the members named in the manifest, because no order between
them is valid. `--packages <LIKE>` scopes it (the converter's own glob:
`%` or `*` is any run of characters, `_` is one character), `--check`
exits 1 when the existing gen/hana-src has drifted, and `--from-dump` runs
the converter itself (`OSD_HANA_CONVERTER` names its path) on a dump
directory, started through `tools/osd-host.mjs` like every tool a tool
starts (`scriptCommandIn` with this process's environment: a compiled
binary is its own `process.execPath`, so there the interpreter is
`OSD_NODE`, else the `node` on the `PATH` — the SEA build's variable
already, `scripts/build-sea.mjs` naming the Node that goes inside):

    node <converter> <dump> --out <layers> --system <prefix>
    node tools/hana-src-gen.mjs --layers <layers>
    # or: node tools/hana-src-gen.mjs --from-dump --dump <dump> --system <prefix>

Dumps and layer directories live outside git — they hold a real tenant's
sources, and the tool refuses a `--layers` inside this tree unless it sits
under `gen/` or `.local/`, both untracked, so neither the layers nor the
manifest is ever committed; `--out` is held to the same rule. The tool
never reads the dump's `tables/*.jsonl` at all; the provenance it records
is what plan.json copied from the dump manifest.

A generation built with a private gen/ layer in its inputs is private like
the layers themselves — the tenant's sources (`gen/hana-src`) and their
dictionary (`gen/hana-ddic`, the DD03L shapes the H3 generation writes)
reached the transpile — and every publisher that bundles a build refuses
it: the preview (scripts/build-preview.mjs:59, beside its $TMP refusals),
the docker image (docker/image/assemble.mjs:17 guards `build/live` before
anything is copied), the download bundle
(scripts/make-download-bundle.mjs:40, before anything is staged) and the
release directory (scripts/make-release.mjs:47, before the tree and the
generation are copied — the directory docs/docker.md documents as "the
release the image copies"). The refusal reads the generation's own record
of what it was built from (`manifest.inputs.folders`, the expanded folder
list tools/osd-build.mjs writes), so it is decided by what the build read,
not by what the tree holds now; the helper is `generationHanaSrcProblem`
in tools/osd-tmp.mjs, beside the `$TMP` one, and its one list of the
private prefixes is also what every publisher's gen/ copy filter drops
(docker/image/assemble.mjs:57, scripts/make-download-bundle.mjs:79,
scripts/make-release.mjs:57), so a stale `gen/hana-src`, `gen/hana-ddic`
or `gen/hana-closure` (the closure walk's state, request and gaps files,
which carry tenant object names) on disk never rides along with a
generation whose record is clean. The build context is covered separately
by docker/image/Dockerfile.dockerignore, which names them.
Publishers that stage `gen/` never are safe by construction: the VSIX seed
(scripts/build-vsix.mjs:353-354 stages src, webapp, tools, data and four
files; the binary's seed tars the same staging), the OCI system publish
(scripts/system-stage.mjs:12 stages src, data, webapp) and the preview
itself (it writes bundles under web/generated and build/preview only).
The CI artifact tar (tools/osd-ci-artifact.mjs:17, `gen output build`)
packs a fresh CI checkout, which holds no tenant folders, and feeds the
CI suite jobs — it publishes nothing.

The layering rule is the one `gen/hana-ddic` already established, one step
further: one entry `gen/hana-src/*` in `abap_transpile.json`, after
`gen/hana-ddic` and before `src/`, expanded to its children wherever the
folder list is read (`expandedFolders` in tools/osd-packs.mjs; the inputs
report, the transpiler, the store and the capture all read the same
expansion). The children are expanded and not listed because their names
are the converter's `<system>-<package>` of private packages, and a
tracked config should carry neither the churn nor the names. The later
folder wins, so the real system's sources lose only to a hand-written
`src/` override, on purpose — a generated copy of an object `src/` now
holds is reported by `node tools/osd-inputs.mjs` like any override. A
layer's `.abapgit.xml` is a repository marker, not an object, and the
store keeps every child non-writable under `$STG_HANA_SRC`, the way gen/
is kept.

What the converter cannot source is counted, not lost: plan.json's
`no_source` — IWSV/IWMO/IWOM/IWSG/IWPR, TABL, SHLP, SICF, WAPA, W3MI,
DTEL, FUGR and friends — is copied into gen/hana-src/manifest.json and
reported. Those kinds have other routes: TABL come from `gen/hana-ddic`
(H3), the SEGW kinds from the SEGW tables (H5); gen/hana-src reports them
and carries the sources only.

Exercised with fixtures (`test/hana-src-gen.mjs`, synthetic `ZOSD_H4_*`
converter output built in a temp dir); no tenant content is reachable
from CI.

## The dump's dictionary: --from-dump

`vsp hana dump --ddic` also writes the DD* tables it measured as JSONL next
to the sources (`tables/DD02L.jsonl`, DD03L, DD04L, DD01L, DD02T, DD04T,
DD01T, DD07L, DD40L — one row per line, the table's full measured column
set, the keys as HANA stores them). `tools/hana-ddic-gen.mjs --from-dump
<dir>` reads those files and feeds them through the same mapper as the live
read — one mapping, and the dump path is its second consumer (2026-11-12,
H5a). The keys arrive upper case and are folded and trimmed here, the way
the hana-client folds and trims on its way out of HANA; the rows are
filtered to the active version the live read's WHERE pins (`AS4LOCAL 'A'`,
`AS4VERS '0000'`), so a table dumped with an inactive version does not
yield its fields twice. A DD* file the dump does not carry is no rows, not
an error.

The live read never needed the kinds the dump carries beyond tables, so
this path writes what H3's could not: `*.tabl.xml` for every active DD02L
row — TABCLASS INTTAB as an include structure (no DD09L, no client),
TABCLASS TRANSP in the transport shape with its DD09L, and any other
TABCLASS (an APPEND, a VIEW, a POOL or CLUSTER) refused by name rather
than written as a structure it is not (2026-11-12, fix round 1) — and
`*.dtel.xml` and `*.doma.xml` for the DD04L and DD01L rows, in the DD04V
shape a system's own export writes: a domain-typed element (REFKIND D)
goes out with DOMNAME and none of the type tags the DD04L row carries as
the domain's copy, a predefined-typed one with its type after DTELMASTER
and the initial values dropped. The writers are the tree's first
DD04V/DD01V writers (until now those files existed only hand-written),
beside `tablXml` in `tools/hana-ddic-map.mjs`, in the envelope the tree's
own files carry. The texts are the T table's row in the L row's master
language (`MASTERLANG`/`DTELMASTER`/`DOMMASTER`, E when none is named —
the live read's `DDLANGUAGE 'E'`, said per object instead of per query);
the TABL header's `DDLANGUAGE` is that language too, and a table with no
text in it goes out without the `DDTEXT`, not with an empty tag. The
labels come from DD04T, which is where the dictionary keeps
DDTEXT and REPTEXT and the three SCRTEXTs (DD04L carries only the lengths
they are shown in). A domain's fixed values come from DD07L, whose rows
carry no words (DD07T is not in --ddic), so a domain with values goes out
without them. An `.INCLUDE` row is not a refusal here: the dump carries
every DD02L table's DD03L, so the marker goes out the way a system's own
abapGit export spells it — `.INCLUDE`, `.INCLU-<suffix>` and `.INCLU--AP`
(the dictionary's append spelling), the structure named in PRECFIELD, the
transpiler expanding it off that — and the included fields' expanded
copies the DD03L read also carries under the base table's own name are
dropped by the dictionary's own mark: every expanded copy carries
`ADMINFIELD '1'`, every plain row `'0'` (measured on the real closure
dump: 16 copies against 265 plain rows, the 7 marker rows `'0'` as
well, and the first copy one position after its marker — the "two
positions later" an earlier sentence here claimed is not what the dump
measures), and the rule is the mark's value space, abapGit's own
`ADMINFIELD <> '0'`: anything but `'0'` is a copy, not only the `'1'`
the dumps measure. The name is only the fallback, for a row that carries no
mark at all — suffixed spellings included, since a `.INCLU-<suffix>`
marker renames its copies by the suffix (the splice H5a first wrote
here put every such field into the XML twice; and a field list that
still repeats a FIELDNAME is refused at generation, naming table and
field — a plain `'0'` row an include's expansion would collide with
included). `ddicFieldsWithIncludes` keeps the markers and drops the
copies; `ddicFields`, which the live
read keeps, refuses an include row. A structured component
(DD03L COMPTYPE S, DATATYPE STRU) carries its own COMPTYPE and resolves
through the structure's own tabl.xml, which the same run writes. File names
are the abapGit ones (lower case, a /namespace/ spelled #namespace#), the
one rule `abapGitFileName` gives both the live read and the dump read; the
layering is the H3 one, unchanged — `gen/hana-ddic` stays listed before
`src/`, and the later folder wins.

`--check` compares an existing `--out` with what the dump would write and
exits 1 on drift — a file missing, a content difference, a file the plan
does not write; the live read has no plan to compare against, so `--check`
refuses it. Not covered, and said so in the run's last line: search helps
(SHLP — DD30L-DD33L are not in --ddic), messages (MSAG), and table types
(DD40L rows are counted, not written). Everything is exercised with
fixtures (`test/hana-ddic-gen.mjs`, synthetic `ZOSD_H5_*` JSONL in a temp
dir, carrying the real files' measured column sets); no tenant content is
reachable from CI, and the acceptance runs against a real dump, by hand.

The two TABCLASS kinds the first real closure run refused by name are
written since H5d (2026-11-12). An APPEND structure goes out as its own
TABL: TABCLASS APPEND, the SQLTAB target its DD02L row names beside it,
the include shape otherwise — no DD09L, no client — which is the shape
the fetched pack's own append export carries, with the fields in DD03L
order. The append reaches the target table through the chain the export
spells: the base table's marker names its include, the include's
`.INCLU--AP` names the append, and the transpiler expands both off
PRECFIELD — so the target's type carries the appended fields with the
generator merging nothing, the same route the pack's consumers take over
its exports (they parse the type, appended component names included; they
merge nothing). A DDIC view (TABCLASS VIEW) goes out as a read-only
structure type — its DD03L fields, TABCLASS VIEW, no DD09L: the join
tables a `.view.xml` needs (DD26S/DD27S) are not in `--ddic`, so the CDS
route's DDIC-view shape is out of reach here. What the view is for
depends on the backend, and that is the shadow schema's paragraph below.
POOL and CLUSTER stay refused by name, and the refusal is about the
TABCLASS alone: what a view became and where its reads stand is said in
the run's summary (a view line, when the dump carries views) and in the
shadow-schema paragraph above. The live read hands TABCLASS and SQLTAB
to the same writer, so `--tables` on an append or a view writes the
shapes this section describes, not TRANSP with a DD09L (2026-11-12,
fix round 1).

## Registration out of a tenant: gen/segw from the dump

The XML path reads the registration facts out of abapGit's `*.iwsv.xml`
and `*.iwmo.xml`. On a system the same facts are one row each in the
Gateway backend registration tables — `/IWBEP/I_MGW_SRH` (the service:
technical name, version, URL name, DPC class), `/IWBEP/I_MGW_SRG`
(service → model) and `/IWBEP/I_MGW_OHD` (model → MPC class), texts in
`/IWBEP/I_MGW_SRT` — and the dumper writes them under `tables/` like any
other table (`tools/hana-segw-gen.mjs`):

    node tools/hana-segw-gen.mjs --from-dump <dir> [--service <NAME>[:<VERSION>]]... [--check]

The join is the tables' own: `SRH.TECHNICAL_NAME+VERSION` →
`SRG.GROUP_TECH_NAME+GROUP_VERSION` → `SRG.MODEL_TECH_NAME+MODEL_VERSION`
→ `OHD.TECHNICAL_NAME+VERSION`, the version as the tables carry it
("0001"). The service text comes from the SRT row in E — the language the
XML DESCRIPTION element stands for — else the first by language; the OHT
is not read, because the XML side has no consumer for the model
description either. A class counts as present when the dump's
`reposrc.jsonl` names its class pool or `SEOCLASS` names it, or when
`gen/hana-src` holds its source (the classes ride into the build through
H4's layers). A service whose DPC or MPC class is absent is reported and
skipped, never emitted: for the XML side that is a comment line in the
generated class, for the dump side an entry of from-dump.json's skipped
list — and neither becomes a register() call. `--service` selects
technical names with an optional version and refuses a selection nothing
matches; the default is every service row of the dump.

There is one writer, not a second one. The tool writes the facts
(`gen/hana-segw/from-dump.json` — the joined services, the skips, the XML
overrides — and `gen/hana-segw/manifest.json`: source, dump directory,
the dump manifest's provenance; no clock in it, because gen/hana-segw is
hashed as an input folder and a clock would rename every generation), and
the registry class itself comes from tools/segw-registry.mjs's
`registryClass`, written where it always lived, gen/segw/, merged under
the XML objects: a (service, version) the XML objects also name keeps its
XML registration, reported as an override, the way the later folder wins
a file. The build's own segw-registry run produces the same bytes from
the facts, so the class on disk is stable across builds. `--check`
compares both folders and exits 1 on drift.

The facts live in a folder of their own, not in gen/segw, for two reasons
the build dictates. gen/hana-segw is an input folder entry of
`abap_transpile.json`, after `gen/hana-src/*` (the gen/hana-ddic rule):
the dump lives outside the tree, so writing the facts is what renames the
generation and makes the next build actually retranspile the registry —
while gen/segw's class is generator output the build itself rewrites
mid-build, and a hashed folder that the build writes trips its own
changed-watch (the bytes the generation is named by must be the bytes it
is built from). And gen/hana-segw is private the way gen/hana-src is: a
prefix in the one list (tools/osd-tmp.mjs), refused by
`generationHanaSrcProblem` through the generation's recorded folder list,
dropped by every publisher's gen/ copy filter, named in
Dockerfile.dockerignore beside the other two. Its `.json` files are
excluded from the transpiler like gen/rap/bindings.json.

The class under gen/segw cannot ride that prefix — the XML source writes
the same path and must keep publishing — but during a dump-fed phase it
carries tenant service names, and a stale one beside a clean generation
must not ride either. So the publishers' gen/ copy filters drop gen/segw
through `segwPrivateGen`, which checks whether the facts exist, at copy
time, in the very tree being copied: there is no staleness window in the
copy, and removing gen/hana-segw publishes again once the next build has
rewritten the class from the XML alone. Exercised with fixtures
(`test/hana-segw-gen.mjs`, synthetic `ZOSD_H5_*` dump tables built in a
temp dir); no tenant content is reachable from CI.

## The closure, by iteration

H5a's first transpile of a real SEGW service's layer measured where the work
is: the four classes transpile against this tree's libraries with **zero**
`/IWBEP/` framework errors — open-abap-odata provides the contract — and the
1,144 findings are everything else they name: the service's dependency
closure. CLAUDE.md's Sprint-0 prediction said the closure is the long pole,
so the closure is walked by a loop instead of measured once:
`tools/hana-closure.mjs` iterates to a fixed point.

One iteration: merge the current dump into the inputs, run the build's own
validation over the tree — the same channel `hana-ddic-gen --from-build`
reads, its `validationMessage` reused, not duplicated — classify every
finding the transpiler emits, and ask the dumper for the names that are
missing: the request file (`--ddic-closure`) carries the fresh names per
TADIR kind, the dictionary kinds closed over transitively on the server,
`seen` skipped. The loop repeats until a validation names nothing it has
not already asked for — and the build itself vouches for that validation
(the positive control, below).

The merge **accumulates**. Bed run 5's finding: a `--from-dump` per dump
REPLACED `gen/hana-src`, so from the second merge on the island held only
the latest dump's layers — iteration 3 validated a tree without the
service, and the fixed point was false. The island is the union of the
seed dump and every dump so far. Each dump is converted once — the
converter (`OSD_HANA_CONVERTER`, spawned through `scriptCommandIn` like
every external script, its argv the converter's own contract — `<dump>
--out <dir> --system <prefix> --allow-in-repo`, the flag because the
layers dir sits inside the git working tree, under the untracked
`.local/`, and the converter refuses that without it) writes
`.local/hana-closure/layers-<NNN>/`, remembered in `state.json` — and
`hana-src-gen` is called with ALL the
layers dirs (`--layers`, repeatable): one folder per layer name, each
file from the later dump that carries it (later wins per object,
reported), folders renumbered in the flags' order. `gen/hana-ddic`
accumulates by the tool's own write mode: `hana-ddic-gen --from-dump`
writes per-file overlays and never clears the folder (checked on
`feat/hana-ddic-from-dump`), so a delta dump's tables land beside the
earlier ones. After each merge the island's object count — classes,
interfaces, tables — is compared with the previous iteration's: the count
rides every iteration line, and a shrink aborts the run with both counts
instead of letting a later "fixed point" validate a tree the service has
vanished from. Per kind since round 5: classes, interfaces and tables are
each non-decreasing — a total that a second dump's new tables hold up
while the classes walk away is still a lost island.

The dictionary half has a writer of record since round 5: the converter
master writes `.tabl`/`.dtel`/`.doma`/`.ttyp.xml` from the dump's DD* rows,
and the layers carry them into the build through `hana-src-gen` alone.
When the merged layers carry DDIC XML, the loop does **not** run
`hana-ddic-gen --from-dump` on top of it — one log line says so — and the
table counts read the layers' `*.tabl.xml` as much as `gen/hana-ddic`'s,
so the shrink control does not go blind to tables with the converter as
the writer. Without DDIC XML in the layers (older converter output) the
DDIC merge runs as before. The cross-check — `hana-ddic-gen --from-dump
--against <layers>`, comparing field lists and types, reporting
divergences and never refusing — is a follow-up, not built.

The writer of record is per **name**, not per run (2026-11-12, round 7).
Bed run 10 made the hole visible: the dump's closure answered 86 DOMA /
156 DTEL / 25 TABL as resolved, and the converter — writing only the
objects of the TADIR packages its selection covers — produced 10 `dtel`
and 7 `tabl`. So after the merge the loop reads every dump's
`closure.resolved` per kind (accumulated in `state.json` across the walk)
and checks each resolved `.tabl`/`.dtel`/`.doma` name against the island's
XMLs (`gen/hana-ddic`'s and the layers' together); the names without one
are written by `hana-ddic-gen --from-dump --names <exactly those names>`
into `gen/hana-ddic`, newest dump first until every name has its rows.
Where the converter did write one, its file wins: `gen/hana-src` layers
after `gen/hana-ddic`, and the later folder wins. TTYP and SHLP are not
written by `--from-dump` (no DD40L writer exists in this tree), so their
resolved-without-XML names stay unwritten — and visible, on the iteration
line's counts (below). A TABCLASS the dump path refuses during the fill is
the merge-refusal gap it already is, and the fill continues without it.

Only the **island** is classified. The service lives in `gen/hana-src/*`
and `gen/hana-ddic/*`; findings whose file lies in `src/`, `packs/` or
another `gen/` folder are the tree's own business and never enter a
request — the first bed run asked 82 names, most of them the rap-flight
pack's `/DMO/` views, and a closure has no business walking another
application's tree. The validation reports **bare file names** (the
transpiler knows the name only), so the scope is not a path prefix on the
finding but a basename set collected from the island folders
(`gen/hana-src/**`, `gen/hana-ddic/*`); a basename both an island layer and
`src/` carry is the island's, the later layer wins the build anyway. The
findings outside the island are reported once per iteration, as a count.

The island carries **no test code** (2026-11-12, round 7). Bed run 12
pulled SAP's unit-test assertion class through a facade's test include and
stubbed six of its methods, and 157 of its 362 island findings sat in
`*.clas.testclasses.abap`. The dumper's `--skip-test-includes` (round 7,
the dumper's own flag, off by default there) keeps CCAU test includes out
of the closure — it rides on every dumper call, the by-hand command
included — and `hana-src-gen` stages neither a `*.testclasses.abap`
include nor a `*_TEST` class, so a dump that carries them anyway does not
bring them into `gen/hana-src`; the object count applies the same rule, so
a `state.json` written by an older iterator does not read as a shrink on
the rule's first merge. Findings in test includes are not island
findings.

The island's own objects are test code only when their **own definition**
is (H5x-3, fix round 1): the framework's own `CL_AUNIT_*`/`IF_AUNIT_*`
names, a class whose own header says `FOR TESTING`, and a class that
inherits from or implements one of them. The first round classified
transitively — everything whose structural record or source tokens named a
test-code object, at any depth — and bed run 19 died on the seed guard
because of it: two EPM test classes that mention AUNIT types dragged the
whole EPM layer in, and the registered service's own DPC followed (its
generated header comments name its own `_EXT` subclass). A class that
merely references test code is production code; a **dependent** of an
excluded test class falls as a cascade of it, the #934 graph rule (the
loop hands the roots to the decision as seeds), and a `GLOBAL FRIENDS`
clause naming one strips — a friend that leaves costs the clause, not the
class. `testCodeObjects` in `tools/hana-closure-graph.mjs` is the
predicate; the guard still fails the run if the rule would ever exclude a
registered service's own class.

A merge tool's refusal of one object does not stop the loop either. H5a's
TABCLASS guard makes `hana-ddic-gen` exit 2 on the first object it refuses
to write (`hana-ddic-map: <name>: TABCLASS APPEND is not written here` —
an APPEND structure is real dictionary content, so it is not an error to
meet one in a dump). The loop parses the refusal, records the object as a
**gap** — kind TABL, reason `unsupported TABCLASS APPEND`: the dictionary
HAS it, the generator here cannot write it, and asking cannot source it,
so it never enters a request either — and retries the step against a
filtered copy of the dump under `.local/hana-closure/` (`tables/DD02L.jsonl`
minus the refused rows; the merge tools write per-file overlays, so the
retry is safe, and the loop's own dump stays the original). The gap leaves
when a dump the merge handled carries the name again without a refusal —
the generator learned to write it; a delta dump that lost the name is not
a resolution.

The names come from **structure** since H5x-2, not from the transpiler's
words: `tools/hana-closure-graph.mjs` builds the island's abaplint registry
once per iteration — the same file set the build's validation reads (inputs
and libs, hidden layers kept out, and nothing else excluded: the graph
decides about excluded objects itself, so it must see their files) — and
runs ONE SyntaxLogic pass per island object (`references(registry, file)`),
collecting the unknown references as data, `{name, kind, line, level,
method?}`, the level from the scope chain (`definition` in class/interface
scopes, `method` in bodies, `signature` in the method_definition scopes a
METHODS statement opens) and the carrier beside the name. Measured on the
pinned core, the carriers are:

| carrier | the text shape it replaces |
| --- | --- |
| `Object (Void)` / `Object (Unknown)` references — `extra.ooName`/`ooType` carry the qualified name and the object type (a missing `TYPE REF TO`, a missing `INTERFACES`) | `Unknown class x`, the void-reference shapes |
| scope vars/types whose type is UnknownType, the error text carrying the name **and the fix keyword** (`... not found, lookup` / `lookupDataElement` / `lookupDomain`) | `contains unknown: X not found` — the DTEL/DOMA kind split survives structurally |
| the same for a qualified type (`TYPE zif=>field`: `Could not resolve top X, resolveTypeChain`, `REF, unable to resolve x`) | `could not resolve top X`, `unable to resolve x` |
| the parsed CLASS DEFINITION statement's `INHERITING FROM` — the scope records nothing here | `Super class "X" not found or contains errors` |
| the same statement's `GLOBAL FRIENDS` names — collected as soft names (below) | `Friend class X does not exist` |
| every `INTERFACES x.` statement, in a class **and inside an INTERFACE definition** — an absent `x` is a definition-level INTF ask, a present one a definition edge (H5x-4 B1) | `Interface X unknown` |
| a global interface's METHODS parameters, read off the interface's definition (signature level, with the method) | `Contains unknown, Could not resolve top X` (unknown_types) |

The last two rows are bed run 21's: the walk reached a fixed point at
iteration 10 while the control build stayed rc=1 on three findings naming
two interfaces nobody had asked for. Inside an interface the checker stops
at the first unknown include and records nothing at all, and an
interface's parameters are no scope var (a class's are vars of the METHOD
scope; an interface has no method scope), so neither reached the request.
The include's finding sits on the INTERFACE statement's line, not the
include's, so it is structural-matched by the name alone; `Interface X
unknown` also has a text branch now (INTF), the fallback for a finding no
reference carried.

And what NO scope records, measured: a SELECT's table (the INTO variable's
error names none), `STANDARD TABLE OF` a missing name, and the
statement-level class references — RAISE/CATCH/CREATE OBJECT, static calls,
`TYPE "x" not found`. Those stay text asks. A finding whose line a reference
sits on **and whose message names the reference's thing** is
structural-matched and never reaches the classifier; the rest goes to the
text fallback (`tools/hana-closure-exclude.mjs`), which keeps exactly the
shapes no carrier supplies: the SELECT shapes (`Database table or view "x"
not found`, `field not part of structure x-comp`), the statement-level class
references (`Unknown class x`, `Class x not found`, `CATCH/RAISE, unknown
class`, `TYPE "x" not found`), `resolveConstantValue, not found: X` (a
constant default records nothing in the scope), `Target type unknown,
<name>` with the target-VARIABLE rule (a local variable's name is a
cascade, counted, never asked), the function-group dialect error, and the
type-lookup branches for findings whose UnknownType carried no extractable
name (a domain-typed variable's error can be the bare name). The member
cascades — `Method "m" not found`, `Component "c" not found in structure`,
`Definition for "X" not found in scope(...)`, `Method parameter type not
compatible`, the `Type error` tails, a bare `X unknown`, and the super and
friend wordings — are counted, never asked: their names travel structurally
or name nothing askable. A finding the fallback has no shape for is
`unclassified`, printed per iteration as before — with the structural pass
in place that is a carrier the probes did not measure, visible instead of
silently dropped. The iteration line counts `N structural` beside the
cascade count. The kind-less dictionary triple grew DOMA (the structural
error text says `lookup` for every kind-less miss), so a structural-only
ask still resolves domains.

De-duplicated, the 1,144 name **49 objects** — one iteration's ask. The
`contains unknown: X not found` shapes carry no dictionary kind (16 of the
49), so the name is requested under TABL, DTEL, TTYP **and** DOMA (H5x-2: the structural ask carries no DOMA precision, so the triple grew the fourth kind) — SHLP too when
the finding itself says search help — and the dumper answers what exists,
reporting the rest in the dump manifest's `closure.missing`. That answer is
**per kind**, so a name that exists comes back `resolved` under one kind and
`missing` under the other two: the normal answer for a name the dictionary
HAS, and not a gap — the gap rule is asked **and** still unresolved after
the dump. A name the dumper answered but
the next validation still names is a **gap** (not in the tenant, or a kind
this route cannot source yet): `closure-gaps.json` carries the gap's kind,
the first finding that named it and how many validation passes have named
it (`first_finding`, `iterations_requested`), recomputed each pass, so a
gap a later round resolves leaves the file on its own; the merge-refusal
gaps carry a `reason` and no `iterations_requested` — they were never
asked. An `unhandled` kind in the dump manifest's `closure` — a request
kind the dumper's closure does not follow — gaps the name with reason
`unhandled by the dumper's closure`, unless a kind's `missing` already
said does-not-exist or a later round resolved the name. The loop's files sit
under `gen/hana-closure/` — `state.json` (the iteration, the current dump,
every name asked with its kinds, its iteration and its first finding, the
names `closure.missing` reported, the merge refusals recorded as gaps, and
the round still pending a dump),
`closure-request.json`, `closure-gaps.json` — and they are tenant content
like the layers: `gen/hana-closure` is on the private gen/ list. The dumps
are not: they go to gitignored `.local/hana-closure/dump-<NNN>/`. The
iteration line carries the per-kind gap counts (`gaps by kind: TABL 1,
DTEL 2`) and the resolved-vs-written DDIC counts (`DDIC resolved/written:
TABL 25/25, DTEL 156/153`), so a writer-of-record hole — resolved names
without an island XML — is visible on every iteration line, before
anything asks.

The dumper runs only where its credentials are, with the argv its CLI
refuses to run without:

    $OSD_HANA_DUMPER hana dump --host <HANA_HOST> --port <HANA_PORT> \
        --user <HANA_USER> --schema <HANA_SCHEMA> \
        --provenance "hana-closure iteration <n>: the closure request's names" \
        --ddic-closure gen/hana-closure/closure-request.json \
        --out .local/hana-closure/dump-<NNN> --skip-test-includes --allow-in-repo

`OSD_HANA_DUMPER` names the binary and `OSD_HANA_DUMP_ENV` an env file with
the connection (`KEY=VALUE` lines, `#` comments, `export ` allowed):
`HANA_HOST`, `HANA_PORT`, `HANA_USER`, `HANA_SCHEMA` become the argv flags
the binary marks required, and `HANA_PASSWORD` becomes `VSP_HANA_PASSWORD`
in the child's environment — the only thing the dumper reads from the
environment, and the only secret: nothing from the env file is on the argv
but the connection flags. The loop's own log line for the command is
redacted — `--host <env>`, `--user <env>`, `--schema <env>`, never the
values, because a loop log is exactly what gets pasted into a report (the
first bed run's log carried the bed's connection); the values appear only
in the by-hand command the loop prints when no dumper is configured, and
in the child's environment. The request travels as a file (`--ddic-closure`,
schema 1: `schema`, `iteration`, `generation` — the hash the merge's
manifest carries of the dump's own manifest —, `source`,
`requested`/`seen` under the nine upper-case TADIR kinds, and the `gaps`),
`seen` holds every name an earlier iteration requested so the dumper skips
it, and the dump lands in `.local/hana-closure/dump-<NNN>/` — gitignored,
and inside the working tree, which the dumper refuses, hence
`--allow-in-repo`. The dumper is a foreign binary — another project's, not
a tool of this tree and not a Node script — so it is spawned by the path
the environment names, never through `toolCommand`/`scriptCommandIn` (which
would dispatch it through `osd gen` or put a node interpreter in front of
it) and never `process.execPath`. Without both variables the loop stops and
prints the command. The request is written before any dumper round: its
names are asked from that moment (`state.json`), the round stays pending,
and the next run picks it up — with the dumper configured it executes the
pending round; a hand-run dump is continued with `--dump <that directory>`,
and names still unresolved there surface as gaps, and a `--dump`
continuation clears the pending round it supersedes (the next configured
run must not re-execute an answered round into a directory the dumper
refuses as non-empty). `--dry-run` writes and
prints the request and stops; `--max-iterations <n>` bounds the dumper
rounds of a run (default 10) and stops after writing the pending request.
The merges' `--from-dump` is `hana-ddic-gen`'s dump mode (PR #926,
merged); a tool without the flag is refused with a message saying so.

No "fixed point" without a positive control. Bed run 4's: `npm run
transpile` on the post-iteration tree exited 1 on a generator step with
ZERO transpiler findings — and the loop read that as convergence. Before
the loop declares a fixed point now, it runs the build itself
(`tools/osd-build.mjs`, spawned like every tool) and reads its exit:
exit 0 stands, and so does a non-zero exit whose log carries findings
("exit 1 with findings only" — the findings are the walk's material); a
non-zero exit with no findings aborts the run with the build's FAILED
line.

Exercised with fakes, the way CI must be (`test/hana-closure.mjs`, fixtures
`ZOSD_H5C_*`): the loop's validate step is the transpiler's own validation
over a scratch tree, the merge is a fake host behind `OSD_SELF` (the loop
owns the tools' argv; the converter is a fixture script keyed by dump path,
the positive control's build a fake-host mode), and the dumper is a
fixture script that mimics
the real binary's CLI contract — the required connection flags, the
schema-1 request, the refusal of an `--out` inside a git working tree
unless `--allow-in-repo`, the password from `VSP_HANA_PASSWORD` only —
spawned by path, with the argv, the request file, the dump directory, the
provenance and the child's environment all asserted (the password never on
the argv). Round 7 adds `--skip-test-includes` to that argv and the
per-name fill's `--names` argv beside it; the fill scenario stages a layer
with one converter-written table and a dump that resolves a second, and
the no-test-code rule is held in the fake host's own staging as well as in
`test/hana-src-gen.mjs` against the real tool. No HANA is reachable from
CI; the real iteration is dell's, on the bed.

## Lazy activation: stubbing what the island cannot close

A class compiles as a whole or not at all. That is why the closure above
had to close every name an island class MENTIONS: a method no request will
ever run still keeps the whole class out of the build until its types
exist. The iterator has a mode that stops paying that price:
`--stub-unresolved`. After the classification and before the request, it
takes every island class file (`gen/hana-src/**/*.clas.abap`, the locals
includes beside them), finds the METHOD ... ENDMETHOD block each finding
sits in — cut at abaplint's parsed positions, the way
`tools/amdp-extract.mjs` cuts AMDP bodies, never a regex over ABAP — and
replaces the bodies that do not resolve with one line:

    RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = '<names>'.

`zcx_osd_not_activated` (`src/hana/`, a `cx_no_check` subclass, so the stub
carries no RAISING clause) answers `get_text( )` with
`not activated here: needs <missing>` — the names, comma-joined, ~200
characters at most. The raise is also the one signal a catch cannot
swallow. `$batch` runs a changeset's requests inside `CATCH cx_root`
(`zcl_stg_batch`), so a stub raise on the bed surfaces only as an error
part — nothing on the wire says what the island still waits for. The
constructor therefore signals the kernel itself, through a
`WRITE '@KERNEL …'` line: a handler the host installed on
`globalThis.osdNotActivated` receives the missing names at construction —
before any `CATCH` can see the exception — and without a handler the
console carries `not activated: <missing>`. Form 2 (`OSD_LAZY`, later)
will turn the handler into a JS throw of its own. The ABAP Unit test
beside the class proves both paths over the built module: handler
installed (it receives the names), handler absent (the console says
them), and a raise that is immediately `CATCH`ed (the signal already
left — the property `$batch` cannot defeat). The stubbed source is written back into the island
file — generated content, so rewriting in place is what the merge does
anyway — and recorded in `gen/hana-closure/closure-stubs.json`'s `stubs`
section, `{object, file, class, method, missing, finding, signature?,
rounds}` — ONCE per (class, method): a dumper round re-lays the island, so
the same method is stubbed again every iteration, and bed run 21 recorded
298 entries for 101 unique pairs; the latest round's finding wins and
`rounds` counts the re-stubs, and the iteration line's "stubbed method(s)"
and `framework-gaps.json`'s `used_by` count unique pairs (H5x-4 B1) —
H5x-2's record plus FIX-1's `errors` (`{roots, cascades, cycles, stubs,
waits, errors, excluded}`), the WALK's: stubs from every iteration stay in
it while each iteration writes its own decision beside them. The body
stubs and the signature stubs land in ONE rewrite pass over one parse
(FIX-1: two passes computed the signature stubs' offsets against the
pre-rewrite source and crashed `offsetAt` past the shrunken source on bed
run 17 — a class whose body stubs had moved its lines). What stays lazy is code and only code. A name of a DDIC kind —
TABL, DTEL, DOMA, TTYP, SHLP, and the kind-less triple — that a
would-be-stubbed method names is requested from the dumper in the same
iteration: a DDIC closure is cheap and pulls no code, and a stub over a
table that exists costs a miss-rerun cycle per method at GET time. A
method keeps its body only while a DDIC name of that method is still
pending in this iteration's request — not asked yet, its object neither in
the island nor excluded this run, the dumper's answer neither missing nor a
merge refusal (`state.refused`, not `state.missing`). Nameless
cascade-only findings, present-only names, resolved-but-still-failing
names and dead names all stub (fix round 1: the round-0 keep-branch held
the bed's DPC_EXT red forever on the nameless member cascades of the
/IWBEP/ runtime it uses). A nameless stub's raise carries its first
finding's text — a GET never reads "needs ''" — and the nameless stubs'
findings are the framework work list: `framework-gaps.json` beside the
stubs, one entry per distinct finding text with the quoted member token
beside it where the shape has one (a method, attribute or component; a
Variable cascade's quoted token is the local variable, not the member) and
a `used_by` of every file, line and method that hit it, sorted — "framework
gaps: N" on the iteration line. When the dumper answered missing for a
DDIC name, that name is a gap and the stub records it; a code kind (CLAS,
INTF, FUGR, PROG) remains deferred as before; `--defer-ddic` keeps the
round-3 behaviour, every name of a stubbed method lazy.

Before anything is requested, the island is checked by file name —
abapGit naming, `/` to `#`, lower case; the XML present for the DDIC
kinds — and a name whose object the island already holds is never
requested and never a gap, whatever an earlier iteration asked: its
finding is a cascade of that object's own findings, counted on the
iteration line as `cascade (present)`. (The bed asked three times for an
interface the island already carried in layer 036; the finding was that
interface's own.) A code kind is present as `.clas.abap` OR `.intf.abap`
of the base — the classified kind of a `ZIF_` name is the prefix
heuristic's CLAS, and presence by the one suffix asked every customer
interface again every round (fix round 1).

And when no stub applies any more, the exclusion is decided over the whole
island as a GRAPH analysis (H5x-2, `tools/hana-closure-graph.mjs`
`graphDecide`, over the structural pass's references; #933's text
machinery — `exclusionDecisions`/`statusOf` — is deleted, no two
machineries). The island's dependency graph has an edge per
DEFINITION-level reference between island objects (a definition-level
unknown naming a present island object is an edge to it — its red is that
object's own), Tarjan's algorithm gives the strongly connected components,
and the rules are:

- **The gate.** Nothing at all is decided while any definition-level name
  of any island object is still pending — unasked, or asked with no answer
  recorded; a merge refusal counts as answered; a friend name gates too
  (the friend may still come). Method- and signature-level names are the
  stub rounds' own material and do not gate.
- **A root** is an object whose definition references a name ANSWERED
  ABSENT (a `missing` answer, a merge refusal, asked and resolved but
  still failing), or whose definition findings name nothing (parse
  garbage). A friend name never roots — friendship is test access, not a
  type dependency.
- **The dependents** that cannot compile without a root — a
  definition-level reference, transitively — are excluded WITH it in the
  same decision (`{level: "cascade", of: [roots], excluded: true}`): the
  graph reaches them without waiting for the transpiler to report them
  red. A dependent that references a root only from a BODY is stubbed, not
  excluded. An excluded name is never "answered" for its dependents — the
  same rule, one traversal.
- **A cycle** of present objects that names only each other — an SCC with
  no root inside — is KEPT: `{level: "cycle", members, kept: true}`; a
  cycle with a root inside falls whole (the root's fall breaks it). A
  cycle member's residual findings are the checker limit the record
  reports, and its nameless findings read as no root.
- **A FRIENDS clause naming an excluded object** is a strip, never an
  exclusion: `{level: "cascade", ..., edge: "friends",
  action: "strip-friends", excluded: false}` recorded, and the stub pass
  cuts the clause (below).
- **Never the walk's seed classes** — the MPC/DPC/_EXT pairs a
  registration names (`gen/hana-segw` or the island's `*.iwsv.xml` /
  `*.iwmo.xml`), and without any registration every island class of those
  suffixes; the run FAILS with the object, how it was recognised and its
  findings. Without a registration the iteration line says `service guard:
  by suffix, no registration`.

The decision is per iteration: the excluded set and the records are
cleared whenever the island grows and re-decided from scratch — an object
excluded on an incomplete island comes back once its roots arrive — and
the request's `excluded` key and the record carry the LAST decision's
exclusions (the roots and the cascades that fall with them). The record is
`closure-stubs.json` in H5x-2's schema with FIX-1's `errors` — `{roots,
cascades, cycles, stubs, waits, errors, excluded}`: the roots (`{level:
"definition", object, file, kind, missing, findings}`), the cascades and
the FRIENDS strips, the kept cycles, the stubs, the WAITS — the objects
whose definition names are still pending, `{object, names}`: a blocked
decision's waits are exactly what the request goes out with — the ERRORS —
one `{file, error}` entry per island object whose analysis or planning
threw (FIX-1): the object is "red, unknown cause" — kept in the build,
never excluded by the decision, its findings still classified by the text
fallback, the run continues; one object's throw never stops the walk —
and the per-kind `excluded` map. The record lands in the loop's `--out`
(`OSD_HANA_CLOSURE_OUT` tells every reader where), not only the fixed
gen/hana-closure path (S-1), and the sorted exclusion list joins the
generation hash (S-2): through the build's own exclusion seam, the one
that already keeps hidden and inactive files from the transpiler
(`ownConfig` in `tools/osd-build.mjs`; the loop's validation channel,
`validationMessage`, applies the same record; `tools/osd-inputs.mjs`
prints it). One reader — `tools/hana-closure-exclusions.mjs` — knows the
format, and a file an H5x-1 iterator wrote (an array of records) still
reads. The file stays in its layer on disk — never deleted, never
rewritten. While a decision is BLOCKED the hold releases (S-2.2): a file
whose definition material is settled keeps its method stubs back only for
the round the decision actually runs — at a blocked decision the stubs
apply after all, so a capped run leaves its stubbable files green instead
of red forever (the bed's cl_epm_bo, run 16's 31 findings). One kind of
object is never excluded: the walk's own seed classes, above.

Every fixed point writes `closure-summary.json` beside the record
(`tools/hana-closure-report.mjs`, H5x-4 B1): `{fixed_point, iterations,
island_objects, stubs_unique, lifted, lifted_stubs, excluded, gaps, seed:
{classes, stubbed_methods}, failures}` — the machine-readable answer to
"does the island carry the service". The stub record is the CURRENT
iteration's (M3 B5.1): every iteration re-lays the island pristine and
cuts only what its findings still name, so a stub of an earlier iteration
whose missing name has since arrived is **lifted** — its record goes, the
iteration line says `N lifted` and the summary lists it. Before, one record
for the whole walk kept every stub ever cut: on the bed a fresh walk
reported 111 unique stubs and the same island resumed 37. A resumed run
starts from the record on disk, so fresh and resumed walks end on the
same set; an object excluded in the meantime has no stub and is not
counted as lifted. It is the false-green guard: a green control
build proves nothing when the service's own classes were excluded or their
reads stubbed away, so the run exits non-zero, the summary on disk, when a
seed class (the guard's set above) is excluded, when one a registration or
an island file names is not an island object (a base derived off an _EXT
name only when present), or when a seed method matching a
`--require-unstubbed <glob>` (repeatable; `*_GET_ENTITYSET`, or
`CLASS=>METHOD`) is stubbed.

The names a stub waits for are not gaps: the service ACTIVATES without
them, so they leave `requested` and the gaps file and travel in a new
optional request key, `deferred: {kind: [names]}`, beside
`requested`/`seen`. The dumper's reader reads `requested`/`seen` and
ignores unknown keys — the file stays schema 1, and nobody asks the
dictionary for a deferred name today. That is the point: the island grows
only on a real miss. A request that reaches a stubbed method fails with
`zcx_osd_not_activated`'s text — `not activated here: needs <missing>` —
naming exactly what the method waits for. That failure is the signal to
run the iterator again: without the flag the walk asks for everything
(round 2's behaviour) and the dump closes the missed method's names; with
the flag on afterwards, the method resolves, loses its stub, and the next
build carries it for real. Without the flag at all, behaviour is round 2's,
byte for byte.

Exercised with the fixtures (`test/hana-closure.mjs`, `ZOSD_H5C_*` and the
structural units' `ZOSD_H5G_*`): the carriers per shape on synthetic
objects (void object references, type lookups with their fix keyword,
qualified chains, a missing superclass, GLOBAL FRIENDS, a missing
INTERFACES with its ooType, a signature miss, a body DATA) and the shapes
no scope records (a SELECT's table, a static call); `graphDecide` on the
bed-15 shape in miniature — a root two layers below a cycle and the seed:
only the root side excluded, the cycle kept, the seed kept, a friend strip
recorded, the gate blocking on a pending name, a friend name never
rooting, a cycle with a root inside falling whole, the seed guard failing
the run both ways; `stripFriends` and `cutSignatureParams` on the
statement text (a subset strip, the whole clause gone, one parameter cut
with DEFAULT and OPTIONAL, a mixed two-parameter clause keeping its
keyword); the record and the seam (`--out`, an H5x-1 array
still reading). FIX-1 adds: the bed-17 shape in miniature — a class whose
body stubs move its lines while a signature stub still carries rows from
the same parse, both landing in one rewrite pass (the bed's `Cannot read
properties of undefined (reading 'length')`) — and one object's analysis
throwing: recorded `{file, error}` in the record's `errors` section, the
object "red, unknown cause" — kept, never excluded — while the rest is
still analysed. The loop scenarios: a method whose only miss is a table
the fake dumper resolves — asked in that iteration, the method never
stubbed — and the inverse with a dictionary-lacking table (a gap, the
stub recording it); a code-kind miss deferred with its method stubbed;
`--defer-ddic` is round 3; the cap stops a rewrite that cannot settle;
mode off is round 2; the real build over a two-file fixture island GREEN
with the definition-level class excluded and failing without the record —
the acceptance, the island builds. H5x-2 adds: the bed-15-shaped island
end to end (only the root side excluded, the cycle and the seed kept, the
body-level dependent stubbed); the blocked decision's waits being the
request's asks (the round trip); S-2.2 — the held file's methods stubbing
while the decision blocks; a GLOBAL FRIENDS clause naming an excluded
object stripped with the class kept; a signature-level miss cut from the
METHODS statement with the body stubbed once the name is answered; the
classifier's three units (the fallback asks, the counted cascades, a
structural shape reaching the classifier visible as unclassified); the
earlier rounds' regression guards kept green (the superclass arriving
late, the per-iteration re-decision, the seed guard with and without a
registration, the `resolveConstantValue` ask, the seed class's nameless
stubs leading `framework-gaps.json` flagged `seed: true`). One mutation
per MUST, each red: the structural pass bypassed (analyseObject empty —
the fallback alone), the cycle keep dropped, the seam's cascade
exclusions dropped, the S-2.2 hold never released. The exception class
carries its own ABAP Unit test
(`src/hana/zcx_osd_not_activated.clas.testclasses.abap`), which asserts
the text and the raise. No HANA is reachable from CI.

## A host over an existing schema: tools/hana-serve.mjs

Built 2026-11-13 (H5x-4 B3). The ordinary server cannot boot in
existing-schema mode, and this is the minimal honest host for that mode,
not the product. `test/start.mjs` writes while it boots — the ICF registry
(ICFSERVICE/ICFHANDLER), the cross-reference seed (CROSS, WBCROSSGT,
D010INC), the demo data, the status tables — and the read-only guard refuses
every one of them; several of those tables carry the tenant's own names, and
our Z tables have no home in this mode at all. Where our own tables live
here is a decision for after the milestone. `tools/hana-serve.mjs` does only
what reading a service needs: it boots the generation in `output/` through
the same `test/setup.mjs` (which in this mode connects and returns before any
DDL or seed), registers the services through the generated SEGW registry
(`gen/segw/zcl_stg_segw_registry`, the dump's registration included when
`gen/hana-segw` holds one), and answers OData v2 GETs through the request
path every host uses — `ZCL_STG_HTTP_HANDLER` behind `CL_EXPRESS_ICF_SHIM`,
one dialog step per request (`tools/osd-dialog-step.mjs`) — under
`/sap/opu/odata/sap/<SERVICE>/` and `/sap/opu/odata/<namespace>/<SERVICE>/`.
The second route is the address a service in a namespace has on a system
(`ZCL_STG_URL` reads both; the service is looked up by its external name
either way, and the answer's URLs repeat the prefix the request came in on --
`$batch` inner requests included. `sap` in any case is the one `/sap/`
prefix and is answered as lower-case `sap`, so a service does not live under
two spellings).

```
STG_DB=hana HANA_EXISTING_SCHEMA=1 HANA_SCHEMA=<tenant> HANA_OWN_SCHEMA=<own> OSD_CLIENT=<client> \
  HANA_HOST=… HANA_PORT=… HANA_USER=… HANA_PASSWORD=… (or OSD_HANA_PASSWORD_FILE) \
  [OSD_SQL_TRACE=1 [OSD_SQL_TRACE_FILE=<file>]] [OSD_BIND=0.0.0.0] \
  node tools/hana-serve.mjs [--port 3040]
HANA_OWN_SCHEMA=<own> node tools/hana-serve.mjs --check-trace <trace.ndjson> [--own-schema <own>]
```

It refuses to start outside the mode, with `OSD_HANA_WRITE=1`, with
`STG_DB_FRESH=1` or without `OSD_CLIENT`. The promise is read-only toward
every system, not only the database: it also refuses to start with
`STG_RFC_PROXY` or `STG_TABLE_PROXY` set, or with a destinations file
(`STG_RFC_DESTINATIONS`, default `.local/rfc-destinations.json`) naming a
`live`, `record` or `fallback` destination -- `local` and `replay` stay,
they never leave the box; it answers anything but GET with 405
before a line of ABAP runs; it binds to loopback unless `OSD_BIND` opens it.
Every statement on the DatabaseClient interface is counted, and a boot that
sent a write — refused by the guard, or swallowed somewhere as subrc 4 —
stops the host before it listens. A GET that writes is logged with the
method and kind. The client is built through one seam in `test/setup.mjs`
(`globalThis.__osdHanaClientFactory`), which the host sets; `--client-module
<file>` replaces HANA with that module's `createClient(options)`, and the
host says so on its first line.

`OSD_SQL_TRACE=1` records every statement into `OSD_SQL_TRACE_FILE`
(default `.local/hana-serve/sql-trace.ndjson`; it can carry data and stays
local): the interface through the existing `STG_SQL_TRACE` wrapper, and for
HANA the text the driver is handed (`op: "driver"`, the client's
`sqlTrace` option) — `connect()`'s own `SET SCHEMA` and shadow DDL, which no
wrapper of the eleven members sees, included. A trace is evidence only with
its **positive control**: the boot sends one known SELECT
(`SELECT 'OSD_TRACE_PROBE' AS probe FROM dummy`) through the connection the
ABAP reads through, and `--check-trace` fails a trace that does not carry it
on every channel it has, then lists every statement that is not a read.
Shadow DDL is counted apart only on the own schema the host ran with
(`HANA_OWN_SCHEMA` or `--own-schema`); **with none given there is no shadow
DDL at all**, every schema-qualified CREATE/DROP is a write, and the check
says it was run without one (fail closed: from a fresh shell a tenant-schema
`CREATE VIEW` was once judged clean). The two channels record different
things: the api channel records what was *asked of* the client -- a call the
client refused carries its `error` code and is listed as a refused attempt,
not as a statement sent -- and the driver channel records what was *sent*.
A refused attempt still fails the check: the code tried to write. An earlier "zero writes" on
this track was read off a trace that was off; an empty trace and an off
trace look the same, and the control is what tells them apart.

After each `$metadata` the host prints `bind_structure: N of M not found:
<names>`. `bind_structure` in the model API (open-abap-odata) returns
silently when the type is not found, and on a system the structure decides
display formats, lengths and conversions — so a miss is a wrong `$metadata`
with no error. `tools/osd-bind-structure-log.mjs` wraps the entity type's
and the complex type's `bind_structure`, runs the original unchanged and
resolves the name once more with the same `CL_ABAP_TYPEDESCR=>DESCRIBE_BY_NAME`;
the count is cumulative over distinct names since boot. Its first run found
one in our own demo: `ZCL_ZSTG_DEMO_MPC` bound `TS_STATUS_VH` where the type
is `TS_STATUSVH` (fixed; the demo now reads 0 of 4, and the host test
expects exactly that).

`tools/odata-metadata-diff.mjs <ours.xml> <theirs.xml> [--accept
annotations,order]` compares two `$metadata` documents parsed
(fast-xml-parser), not their names: **structure** (entity and complex types,
properties with Type, Nullable, MaxLength, Precision, Scale and every other
non-`sap:` attribute, keys, navigation properties, associations with ends and
referential constraints, entity sets, association sets, function imports and
their parameters with `m:HttpMethod`, the schema namespace, and the document
versions a client branches on: `edmx:Edmx/@Version` and
`DataServices/@DataServiceVersion`), **annotations** (every `sap:*`
attribute — label, creatable/updatable/deletable, addressable, …— and
vocabulary `<Annotations>` blocks per target), **order** (the same members in
another order, property order included). It exits 0 only when every class
that differs is accepted, and prints every difference either way. A
reference into the document's own schema namespace is compared by its local
name, and a differing namespace (or a sole container's name) is one
structure finding — reported, never normalised away. It supersedes the
names-only `tools/osd-metadata-diff.mjs` for oracle work.

Tested without HANA: `test/hana-serve.mjs` runs the host as a child over the
generation with a fake client (`test/fixtures/hana-serve/fake-client.mjs`:
reads from fixtures, every write throws) and the demo service: `$metadata`
and a GET under both prefixes, 405, the trace with its control (and a copy
without it failing the check), the bind log; one write added to the boot
turns it red. `test/gateway-metadata-diff.mjs` covers the diff with two
synthetic documents.
