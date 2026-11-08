
## 3. Analytics and CDS (no gate, S can start)

```
3.1  star schema                                                      [S]
     ├─ @Analytics.dataCategory: #DIMENSION / #TEXT
     ├─ @ObjectModel.text.element, foreign-key associations
     └─ so the analytical list page shows names, not codes
3.2  view parameters                                                  [S]
     └─ parameterised entity sets in OData v2
3.3  delta extraction (the BI piece)                                  [S]
     ├─ @Analytics.dataExtraction.enabled, delta by a timestamp element
     ├─ !deltatoken on the service, __delta in the answer
     └─ a change-log table our own writes fill, so deletions are in the delta
3.4  calculated measures over the virtual-element exit                [S]
     └─ free now, docs/virtual-elements.md
```


## 3b. More database backends (after 0.8, Alice 2026-10-04)

The seam is one object: `abap.context.databaseConnections["DEFAULT"]` and its
eleven-method `DatabaseClient` (`docs/db-backends.md`). SQLite, DuckDB, PostgreSQL
and HANA already sit behind it. Each new engine is a client module, a DDL and
literal dialect, the LUW (savepoints or replay), and a Compose stack with its own
instance number. Nothing changes in the transpiled ABAP.

```
3b.1 HANA: in-place migration of an existing schema                    [Should, 0.8/0.9]
     └─ 0.7 refuses an old schema with a clear message; per-table migration
        (#610, draft) covers SQLite, DuckDB and PostgreSQL first
3b.2 Oracle Database Free (formerly XE)                                [S]
     ├─ free without a time limit: 2 CPU threads, 2 GB RAM, 12 GB user data;
     │  the official container image runs on x86-64 and ARM (Apple Silicon)
     ├─ the second "real" enterprise engine next to HANA: SAP systems ran on
     │  Oracle for decades, so its Open SQL edge cases are worth measuring
     ├─ dialect: no LIMIT before 12c-style FETCH FIRST, empty string = NULL
     │  (a CHAR/STRING trap for ABAP's initial values), identifier case,
     │  NUMBER for P, savepoints exist
     └─ also reachable without install: Oracle Cloud Always Free (Autonomous
        DB) and FreeSQL; a stack stays local-first
3b.3 MariaDB / MySQL                                                   [S]
     ├─ the most common open-source server engine; a Compose stack like PG
     ├─ dialect: backtick identifiers, sql_mode for strict types, utf8mb4,
     │  DECIMAL for P, savepoints (InnoDB)
     └─ one client can serve both, measured on both
3b.4 ClickHouse, for the analytics side only                           [R]
     ├─ columnar OLAP: no row-level transactions, mutations are asynchronous,
     │  so not a full Open SQL backend for writes
     ├─ candidate as a read replica for the CDS cube and SADL analytics
     │  (docs/backlog/data-analytics.md §3), next to DuckDB, which already
     │  covers in-process analytics
     └─ decide only after a measurement against DuckDB on the 1M-fact cube
        (`npm run bench:cube`)
```

Each one is done when `npm run unit` and the `.http` regression cases pass on it,
the support page has a column for it, and it has a stack in the i7/i3 Portainer
set.

### The rest of the one-row inserts, and what the seed fix did not reach (2026-09-19)

`tools/osd-batch-inserts.mjs`, called once in `test/setup.mjs`. Suite
`test/batch-inserts.mjs`.

The seed fix (e088c4d) was measured against an empty database — statement
count, not end-to-end. Measured end to end, on a real `npm run unit`, with
the SQL sieve:

```
6793 statements, 1563 ms    before either
4315 statements,  976 ms    after the seed was batched
1711 statements,  441 ms    after this
```

`WBCROSSGT` left the table entirely after the seed fix — it came from the
seed. `TADIR` (1542) and `REPOSRC` (907) did not, because they come from a
**different writer**: the statements the transpiler hands `setup()`. Not
ours, and one row each.

Two things decided the design, and the second is the one worth keeping:

**The values are never parsed.** A statement is split at `VALUES ` and
everything after is carried verbatim, so a comma or a bracket inside a
quoted string cannot be misread — which is the defect the seed's own test
had, where splitting a five-column row on commas found seven parts. The
answer here is to need no parser at all.

**Merging only consecutive runs caught barely a third**, because the rows
arrive interleaved — a directory entry, then its source, then the next
object's. Merging across other INSERTs is what got TADIR from 1542 to zero,
and it is safe for a reason that can be stated: **an INSERT reads nothing**,
so two inserts into different tables commute, and the rows that end up in
the database do not depend on which went first. Order *within* a shape is
kept. Anything that is not an INSERT is a **barrier** — a CREATE, a DELETE
or a statement the batcher cannot read may depend on what came before it,
and a statement it cannot read keeps its place untouched. A batcher that
dropped what it could not read would be silent data loss, which is worse
than the cost it saves.

The test that matters runs both versions on a real DuckDB and compares the
tables: the claim is not "the text is equivalent", it is "the rows are the
same". `npm run unit`, `unit:file` and `unit:duckdb` are green.

### NYC taxi cross-database visual benchmark (2026-09-20)

Compare the same January 2025 NYC TLC analytical facts on SQLite, DuckDB and
HANA Express; the current full import is DuckDB-only. Build a repeatable,
validated import for the other adapters before making performance claims.
Keep schema, client, fact rows, source checksum and OData query shapes equal.
On equivalent hardware, without competing workloads, record cold and warm
runs separately. Measure visible first chart/table and filter-response times
in Playwright, OData latency (median and p95 for the five existing
`tools/bench-taxi.mjs` shapes), and SQL execution where possible. Capture
browser traces, DB/host configuration, network placement, errors and result
counts; display a visual comparison without conflating CDN/UI5 startup with
database time. HANA Express availability and licensing remain external gates.
Do not use this benchmark to mutate an existing production volume.

Release gate: adding `ZOSD_TAXIFACT` changes the generated schema. Existing
SQLite files can be moved aside or rebuilt on fingerprint drift; PostgreSQL
refuses drift, while existing DuckDB/HANA schemas do not create the new table
at startup. Before rolling this code into a persistent stack, provide and
test an additive, non-destructive migration for each backend (including
restart and data-retention checks), or use an explicitly fresh demo database.
Until then, keep the previously working container image active.

### ZVDB production continuation (deferred, 2026-09-21)

The `$ZVDB_100` experiment successfully demonstrated an identical Hamming
rank in portable ABAP and HANA SQLScript over two committed embedding buckets.
Do not turn it into a production classifier by adding another global threshold.
If a real consumer appears, use binary vectors as the shortlist index, rerank
with retained float vectors, calibrate by immutable model/bucket/corpus version,
and permit an `UNKNOWN` result. A Live quality run must be a bounded,
asynchronous job with progress and cancellation; Published remains the
committed deterministic report. Before enabling the pack in persistent images,
add non-destructive HANA/DuckDB schema migration and restart coverage.

### Portable and native fuzzy-text profiles (deferred, 2026-09-22)

The AMDP corpus now uses a deliberately modest `simple-search-v0`: exact or
substring matching with fixed integer scores, measured only over the current
ASCII fixture. Empty and NULL queries return no non-null matches. This exists
to keep the general SQLScript milestones moving and must not be presented as
a portable linguistic profile or HANA fuzzy compatibility.

After the remaining general corpus milestones, implement ADR 0002. Specify a
small normative `portable-deterministic` evaluator and prove exact ordinary-SQL
lowerings on HANA and DuckDB. Qualify native HANA/DuckDB matchers separately on
a frozen synthetic observation-catalogue corpus with held-out precision,
recall, top-K and false-positive gates. Every native result must retain exact
engine/build/configuration identity. Do not block cursor/control-flow, nested
calls, shared transactions or the original ABAP Unit path on this specialised
search work.

### Three vector engines on a HANA deployment, and the eAMDP session that goes stale (2026-09-30)

Seen on a HANA-backed deployment (status: Engine HDB): the zvdb Vector Workbench with engine **HANA** answers
"HANA failed: Connection closed". Read from the code (`packs/zvdb`, `tools/amdp-destination.mjs`,
`tools/amdp-run.mjs`, `tools/osd-status.mjs`):

- The **HANA** engine is eAMDP: `search_db` (`BY DATABASE PROCEDURE FOR HDB`) is rewritten by `tools/amdp-gen.mjs`
  into a call of the `'AMDP'` destination, and `AmdpDestination` runs it on HANA over **its own** `hdb` session
  (credentials from `HANA_*`/`HXE_*` or `~/.osd/hxe-password`), not over the system's `HanaDatabaseClient`.
- That session is opened once, cached, and never validated or reopened. A socket the server or a proxy dropped
  (idle timeout, HANA restart) fails on the next call with hdb's raw "Connection closed"; only the first connect is
  wrapped. The status page reads the system connection, so it says HDB while the eAMDP session is dead or points
  elsewhere. The page's hint "available only when OSD itself uses HANA" is a client-side text, not a check.

**Fix (small, do first):** the destination validates its session before use and reconnects once on a closed/reset
socket, and reports a refused connection in words (host/schema, not credentials); better, it reuses the system's HANA
connection when the system database is HANA and the schema matches. Test with a session killed between two calls.

**Fix done (2026-09-30):** eAMDP shares an in-flight connection attempt across callers, publishes a session only
after it connects and selects its schema, and binds deployment cache writes to that session. A closed/reset
connection triggers one reconnect, redeployment and call retry. Connect, deploy and execution failures name the
host, port and schema; literal and URL-encoded credentials and connection-string values are redacted.
It keeps a separate session even when the system database is HANA: `HanaDatabaseClient` disables autocommit for the
ABAP LUW, while eAMDP's procedure DDL and calls currently use their own session. Sharing it would let deployment
affect the caller's transaction. The vector page now points to the HANA destination when its call fails.

**Then: three engines selectable on HANA**, each labelled truthfully in `SearchResultSet-Engine`:
- **ANYDB**: portable Open SQL through the DB seam (works on every engine today).
- **eAMDP**: the AMDP body executed natively on HANA through the destination (today's "HANA").
- **pAMDP**: the same SQLScript lowered to the portable engine. Today it runs only when the system database is
  DuckDB (`#portable`), and pAMDP is parked (`docs/ideas.md`). On HANA it would need the IR executed on a local
  DuckDB copy or a HANA SQL lowering; decide when pAMDP is unparked. Until then the page must say why it is grey.
- `Component.js` enables AMDP only for duckdb and HANA only for HDB; derive both from what the server reports it
  can run, not from the status fact.

**Declared (2026-11-08):** the status page now has an **AMDP methods** facet (`AmdpMethodSet`) with the engine each
method would run on at that moment -- `portable-duckdb`, `portable-refused`, `hdb`, `hdb-stale`, `hdb-idle`, `unavailable` + reason --
read off the destination's own session state and the system connection, not off configuration
(`docs/amdp-engine-status.md`, `tools/amdp-status.mjs`, `ZCL_OSD_STATUS=>ENGINE`). The zvdb page still decides
from the status fact; pointing it at `AmdpMethodSet` is the remaining item here. pAMDP stays parked for new features.
