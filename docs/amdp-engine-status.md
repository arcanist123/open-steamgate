# Where an AMDP body runs: declared per method on the status page

*2026-11-08. Decision (Alice, 2026-11-08): portable AMDP stays parked for new
features, but its existence and its engine are declared. A user must see, per
AMDP method, where the body runs right now.* eAMDP (native HANA over the destination) gets a full-parity sprint, planned
from 2026-12-05.

## The two engines, and the one that is not there

An AMDP method (`BY DATABASE PROCEDURE` / `FUNCTION FOR HDB`) is ABAP on the
outside and SQLScript inside. `tools/amdp-gen.mjs` cuts the body out before
the transpiler sees the class, replaces it with `CALL FUNCTION 'Z_AMDP_…'
DESTINATION 'AMDP'`, and writes the body to `gen/amdp/procedures.json` twice:
as the SQLScript HANA gets, and, when the compiler accepts it, as the
portable IR (`portable`), or else the exact refusal (`portableRefusal`). A
compiled body is also lowered for DuckDB at build time (`dialectCheck`); when
that lowering refuses a construct, the refusal is written beside the IR as
`portableDuckdbRefusal`. The IR is kept and the call path is unchanged: the
call refuses at run time with the same message.

The destination (`tools/amdp-destination.mjs`) decides at call time:

| system database (`STG_DB`) | what a call does |
| --- | --- |
| DuckDB | **pAMDP**: the compiled IR runs on the system's own DuckDB connection, inside the caller's LUW. A method the compiler refused is refused here too, and so is a compiled one whose DuckDB lowering refuses a construct (at call time); there is no HANA fallback on DuckDB, by design (a passing unit test must not reach a hidden HANA). |
| SQLite, PostgreSQL, HANA | **eAMDP**: the SQLScript is deployed to HANA and called over the destination's **own** `hdb` session (`HXE_HOST` / `HXE_PASSWORD` or `~/.osd/hxe-password`), never over the system connection, even when the system database is HANA. No HANA configured: the call fails and says so. |
| browser preview | no HANA driver in the bundle; on DuckDB-Wasm pAMDP, on sql.js nothing. |

There is **no portable-on-SQLite path**: the IR has a SQLite lowering, and the
value-parity instrument runs it (`docs/pamdp-value-parity.md`), but the
destination never routes a call there. Saying `portable-sqlite` on a page
would be the backlog's lie in the other direction.

## The engine labels

`ZCL_OSD_STATUS=>ENGINE` (`src/status/`) classifies one method from five
facts of the moment; the truth table is `ltcl_engine` in its test include.

| engine | meaning |
| --- | --- |
| `portable-duckdb` | pAMDP on the system DuckDB connection |
| `portable-refused` | compiled into the IR, but DuckDB's lowering refuses a construct of it, so a call on DuckDB refuses; `Reason` names the construct |
| `hdb` | eAMDP, the destination session is connected |
| `hdb-stale` | eAMDP, the destination holds a session that is no longer connected (the server or a proxy dropped it); the next call reconnects once |
| `hdb-idle` | eAMDP, HANA configured, no session opened yet; the first call connects |
| `unavailable` | nothing would run; `Reason` says why: no driver, no HANA configured, or on DuckDB the compiler's refusal |

`Portable` says whether the body is in the compiled subset, whatever the
engine; on SQLite the reason adds "used only when the system database is
DuckDB" (or, for a body DuckDB refuses, "DuckDB would refuse the call: …"),
so a reader learns both facts from one row.

## Where the facts come from

The ABAP side cannot see the destination, so the host adds an `amdp` member
to the status snapshot (`tools/amdp-status.mjs`, the contract in
`tools/osd-status.mjs`):

```
"amdp": {"db": "duckdb", "driver": true, "configured": false, "session": "none",
         "methods": [{"clsname": "ZCL_OSD_AMDP_DEMO", "mtdname": "SQUARES",
                      "kind": "procedure", "portable": true, "refusal": ""}]}
```

- `db` is the system connection's engine (`databaseDescriptor`), never the
  configuration.
- `driver`, `configured`, `session` come from `AmdpDestination.sessionState()`:
  the destination's own settings provider says whether a driver and a HANA
  are there, and `session` is `this.client.readyState` read at that moment
  (`none` when never dialled, `connected`, `closed`). No host, port, user or
  schema leaves the destination.
- `methods` are the destination's `procedures` (what `amdp-gen` wrote), each
  with `portable` and the refusal text cut to a column: the compiler's
  `portableRefusal`, or for a compiled body its `portableDuckdbRefusal`.
- `unknown: true` (with `db: "unknown"` and no methods) when the work process
  holding the destination did not answer within a second (a busy boot, a hot
  swap). The Environment rows then say "not known" rather than "no HANA
  driver in this build", and `REFRESH` keeps the `ZOSD_AMDP` rows it had.

Who asks whom: the inline host (`test/start.mjs` without a pool) reads its
own destination; with a pool, the **work process** adds `amdp` to its
`/osd/serving` answer and the facade copies it into the snapshot
(`childAmdpFacts`, under the same rules as `childDatabaseFacts`: the local
child only, a bounded vocabulary, a failure is an observation). The browser
preview reads its own destination in `statusSnapshot`.

`REFRESH` classifies each method and writes `ZOSD_AMDP`; `ZC_OSD_AMDP` is the
CDS view; `AmdpMethodSet` (`ZOSD_STATUS_SRV`, `src/status/zosd_status.stg.yaml`)
serves it, with `to_Amdp` from the system row and the **AMDP methods** facet
on the status app's object page. Two rows of the Environment facet (section
`AMDP`) say the whole-system half: whether the portable engine is on and the
state of the HANA destination.

## What pAMDP is, honestly

- The compiled subset (`tools/sqlscript-to-procedure-ir.mjs`): `DECLARE`
  scalars and table variables, assignments of `SELECT` (CTEs, joins, set
  operations, aggregates, window functions, `TOP`, `ORDER BY`), scalar
  assignments, `IF` / `ELSEIF`, `WHILE`, `FOR … IN` over integer bounds,
  `CALL` of another AMDP of the tree that returns one relation, `RETURN
  SELECT …` as the last statement of a table function, and `INSERT` /
  `UPDATE` / `DELETE` outside `READ-ONLY`. Constructs outside the subset
  are refused by name at build time (`portableRefusal`), among them
  cursors, `EXEC`, array functions beyond a fixed set and nested calls
  with several outputs. Scalar functions without a measured rendering
  (`FLOOR`, `LEFT`, `TO_NCHAR`, `TO_NCLOB`, `ESCAPE_*`, `TO_BINARY` at the
  last count) are **not** refused by the compiler: the body compiles, and
  DuckDB's lowering refuses the call when it is made. The build runs that
  lowering too and records the refusal (`portableDuckdbRefusal`), so the
  status page says `portable-refused` for such a body instead of
  `portable-duckdb`; the call itself still refuses at run time.
- Value parity against HANA was measured once, 2026-10-01, over the corpus:
  31 bodies ran on both sides, 16 equal, 1 differing cell (NULL
  concatenation in a scalar function), 2 HANA errors, 12 portable errors
  (`docs/pamdp-value-parity.md`). That is the extent of the evidence.
- The ADT check run already warns, per method, when a body is not in the
  subset for the configured engine (`portabilityWarnings` in
  `tools/amdp-gen.mjs`, surfaced by `tools/adt-checkrun.mjs`). It runs the
  same `dialectCheck` the build runs for DuckDB. It accepts `sqlite` and
  `postgres` as well, because those are lowering dialects (the parity
  instrument uses the SQLite one); a warning "not supported on sqlite" is
  about that lowering, not about an engine a call runs on. A positive
  "runs on …" line in ADT was not added: the check run has no per-system
  session state and the status page is where that fact belongs.

## Tests

- `src/status/zcl_osd_status.clas.testclasses.abap`: `ltcl_engine` (the
  truth table, no database, including `portable-refused`) and
  `ltcl_status->amdp_round_trip` (JSON in, rows and engines out, kept on an
  `unknown` snapshot, replaced on the next refresh).
- `test/amdp-pack.mjs`: a body with `FLOOR` compiles and carries
  `portableDuckdbRefusal`; the same body with `+ 1` does not.
- `test/osd-status.mjs`: the snapshot's shape (`amdp` member, the two AMDP
  rows between the database and the platform rows, "not known" for a pool
  whose child does not answer).
- `test/amdp-status-host.mjs`: the host module with a hand-set session, and
  the child boundary on SQLite and DuckDB: `/osd/serving` carries `amdp`,
  the facade's snapshot equals it, `AmdpMethodSet` answers `portable-duckdb`
  for `ZCL_OSD_AMDP_DEMO=>SQUARES` on DuckDB and one of the eAMDP family on
  SQLite.
- `test/e2e/status.spec.mjs`: the AMDP methods facet shows the demo method
  with an engine label.
