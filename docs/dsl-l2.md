# DSL L2: a domain rule compiled to L1

Status: slices 1 to 8 and row rules, 2026-11-24. Built on L1 (`docs/dsl-l1.md`) and the template engine
(`docs/abap-templates.md`).

## What L2 is

L1 is a typed model a generator fills; nobody writes it by hand. L2 is what a person writes: a
rule in the terms of a domain -- its tables, its fields, its words. The L2 compiler turns a rule
into an L1 model, and from there the chain is L1's: templates render ABAP, and every output
line keeps its provenance down to the line of the rule it came from.

The compiler (`tools/dsl-l2.mjs`, with the interpreter and the case derivation in
`tools/dsl-l2-eval.mjs`) knows the rule language and the DDIC, and nothing of any domain: tables,
fields and the words of the alert come from the rule. A test greps both files for the demo's
domain words and fails on a hit.

## Slice 1: the language

A rule is one YAML file, `<name>.l2.yaml`:

```yaml
rule: maintenance-ship-no-future-voyage
class: zcl_l2_maintenance_ship        # optional; default ZCL_L2_<RULE>, at most 30 characters
title: A ship in maintenance has no voyage departing after the check date
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M'               # optional
forbid:
  exists: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date > $date
alert: "{ship.ship_id} {ship.name}: in maintenance, voyage {voy.voyage_id} departs {voy.dep_date}"
boundaries: auto                      # optional, slice 2: auto, or a list such as [when/1, forbid/where/2]
examples:
  - name: flagged
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect:
      - "S001 Albatross: in maintenance, voyage V00001 departs 20261005"
```

It reads: for every row of the `for` table matching `when`, every row of the `exists` table
matching `where` is a violation, and each is one alert line.

Grammar (the expressions are parsed by a small recursive-descent parser over tokens):

```
source      := TABLE 'as' ALIAS
conjunction := comparison ('and' comparison)*
comparison  := operand ('=' | '<>' | '<' | '>' | '<=' | '>=') operand
operand     := ALIAS '.' FIELD | 'literal' | NUMBER | '$date' | '$name' | date-window
date-window := '$date' ('-' | '+') (NONNEGATIVE_INTEGER | '$int_name')
alert       := text with {ALIAS.FIELD} holes
```

Checked against the DDIC (`tools/dsl-ddic.mjs`, abaplint's registry, `DDIC_PROVIDER` and its
`literalType`), every error naming the rule file and line (`file:line: message`):

- the tables exist, and their key resolves (the provider's own refusals pass through); `for` and
  `exists` are two different tables, and `where` holds at least one equality between a field of
  each (the join condition of slice 2's one query);
- `class` and `title` are text, the title one line;
- every `alias.field` exists; `when` may name only the `for` alias, `where` both;
- each comparison names a field of the table being selected on one side (a condition written the
  other way round is mirrored); the other side is a literal, `$date`, or a field of the outer
  alias, never a second field of the same table;
- both sides have compatible DDIC types: the same built-in type field against field, DATS against
  `$date`, and a literal that fits the field by the rules of the engine's `literal` filter (a
  CHAR literal no longer than the field, a DATS literal eight digits, an integer within the range
  of INT1/INT2/INT4/INT8, a packed number within its digits and decimals, one source line and at
  most 255 characters once quotes are doubled). The rules are written twice, in the filter and in
  `misfit`, so that an error names the rule line; `test/dsl-l2.mjs` runs boundary values of every
  type through both and fails when they disagree;
- every `{hole}` names a field of a declared alias;
- a rule carries its proof: it has at least one example, and every example states `expect`
  (`expect: []` when it expects no alert; a missing key is an error);
- example rows name only the rule's own tables, give every key field, and their values fit.

The YAML is read by js-yaml (the reader `tools/stg-compile.mjs` uses) with its FAILSAFE schema,
so a value stays the text written. js-yaml keeps no positions, so `lineIndex` reads each key's
and list item's line from the file's text; what sits inside a flow collection (`[{...}]`) takes
the line of the key holding it.

## The chain

1. **L1 model** (`compileRule`): plain data. Every node has `@id` (`rule/<name>`, `.../for`,
   `.../when/<n>`, `.../forbid`, `.../forbid/where/<n>`, `.../alert/text/<n>`,
   `.../alert/hole/<n>`, `.../example/<name>`, its rows, fields and expected lines) and
   `rule_line`. Every literal carries its sibling `@type` in DDIC terms (`value@type`,
   `date@type`, `label@type`), so the templates print it with `| literal`. Names the templates
   print (`lt_<alias>`, `ls_<alias>`, `mt_<table>`, test method names) are decided here.
   A table node carries the line where its table enters the rule (`for:` or `exists:`).
2. **ABAP** through `ZCL_OSD_TPL`: `recipes/l2-check/template.tpl` renders `ZCL_L2_<RULE>` with
   `check( iv_date ) RETURNING rt_alerts TYPE string_table`: **one Open SQL statement** (slice 2),
   `SELECT ... FROM <for> AS a INNER JOIN <exists> AS b ON <the equalities between their fields>
   INTO CORRESPONDING FIELDS OF TABLE ... WHERE <the rest> ORDER BY <the for key> <the exists
   key>`, ABAP 7.02 (`~`, no `@`), one condition per line so each line traces to its own node; the
   alert lines are built from the joined rows, which come back in that stable order.
   `recipes/l2-check-test/template.tpl` renders its test class: one method per example and per
   derived case (below) that inserts the rows, calls `check` and `check_reference`, compares the
   two, compares `check` with `expect` order-insensitively, and deletes its rows again in
   `teardown` (RISK LEVEL DANGEROUS, the rule's own tables only). The generated SELECTs carry no MANDT condition:
   that is correct ABAP, because on a system the kernel adds the logon client to Open SQL. This
   runtime is single-client by a settled decision (ANORMALIES `no-implicit-mandt`, upstream
   abaplint/transpiler#606), so do not add a MANDT condition to the template. Both pass the `abap` profile
   (`ZCL_OSD_DSL_PROFILE`); `build` exits nonzero on an error finding.
3. **Trace**: `<class>.clas.trace.json` (and `<class>.clas.testclasses.trace.json`), one entry per
   output line: `line` -> `template_line` -> `node` (the nearest `@id` on the data path) ->
   `rule_line`. The `AND dep_date > iv_date` line of the demo traces to the rule's `where:` line,
   the alert text lines to its `alert:` line, and in the test class the `check( iv_date = ... )`
   call to its example's `date:` line.
4. **Proof**: the generated test class runs with every other ABAP Unit test. `test/dsl-l2.mjs`
   builds the rule, changes `>` to `>=` in the generated ABAP (the query and the reference alike,
   the expectations staying those of the unmutated rule), transpiles it alone and runs the tests:
   the example departing on the check date fails and so does the derived `b_dep_date_eq`; with
   that example cut from a copy of the rule, the derived case alone still fails. The same for
   `status = 'M'` changed to `<>`, and for a JOIN that lost its ON equality, which the comparison
   with `check_reference` catches.

## Slice 2: one query, and the boundaries found by the compiler

### One query instead of a SELECT per row

Slice 1 rendered `for` plus `forbid.exists ... where` as a SELECT on the `exists` table for every
row of the `for` table: the pattern recipe R1 (verified lift) exists to remove. Slice 2 renders
`check` as one statement with an INNER JOIN. The `where` equalities between a field of each table
become the `ON`; `when` and every other `where` comparison go in `WHERE`, qualified `alias~column`.
The columns the alert and the order need are selected under the names `<alias>_<column>` (at most
30 characters; the compiler says so when an alias makes one longer) into one result line, and
`ORDER BY` the `for` key and then the `exists` key. `test/dsl-l2.mjs` counts the database calls
as `test/lift-r1.mjs` does: one per `check`, however many `for` rows; 1 + n for the reference.

The direct form stays as the reference: the slice-1 nested form is rendered into the generated
test class as `check_reference` (private to the test). Every example and every derived case runs
both, asserts that they answer alike **in the same order**, and then asserts the case's `expect`
against `check`. The optimised translation is proven equal to the obvious one, the way verified
lift proves AFTER equal to BEFORE.

### The interpreter

`evaluate(rule, rows, params)` (`tools/dsl-l2-eval.mjs`) runs the compiled rule in JavaScript:
the `for` rows that meet `when`, each checked against the `exists` rows that meet `where`, one
alert per pair, the text from the holes. It compares by DDIC type: CHAR ignoring trailing blanks,
DATS / TIMS / NUMC as their digit strings, INT and DEC numerically. The generated tests prove
that the ABAP agrees with it.

- At build time every hand-written example runs through it: when it disagrees with the
  example's `expect`, the build fails with the example's line (`file:line: example "x" expects
  [...] but the rule gives [...]`). A wrong example never reaches ABAP.
- What it does not model: a negative number or a packed (DEC / CURR / QUAN) field **in an alert
  hole**. It prints `10.50`, as a system does; this runtime prints `10.5`
  (`ANOMALY-2026-09-30-concat-packed-drops-decimals`), so such a rule fails its generated test
  here instead of passing quietly. Conditions on packed fields are fine.

### Boundaries

`boundaries: auto` selects every comparison of the rule; a list selects some by their place,
`when/1`, `forbid/where/2` (the numbers of the `@id`s in the model and the trace). For each the
compiler derives cases from the field's DDIC type and the operator:

| comparison | cases |
|---|---|
| ordered type (DATS, TIMS, NUMC, INT*, DEC, CURR, QUAN) against a literal or `$date` | `lt`, `eq`, `gt`: the value one step below, equal, one step above. A step is a day, a second, 1, or 10^-decimals; DATS arithmetic is calendar correct (month ends, 29 February), and a step that leaves the type (255 + 1 in INT1, 99991231 + 1) is skipped and listed under `skipped` |
| equality (or any operator) on a CHAR-like type | `eq`, `ne` (a different value of the same length), `blank` (initial) |
| field = field, the join | `match`, `nomatch` |
| a field compared with an outer field by another operator | `lt`, `eq`, `gt` around the outer value |
| each `exists` | `zero` (no exists row) and `two` (two exists rows for one `for` row, the second with another value in the first key field that no equality fixes) |

A case is a small row set: one row per table, from a base that satisfies every other condition so
that only the condition under test decides. The base is the first example's first rows when they
make the rule fire exactly once, else rows generated from the field types (a value for every
field that satisfies every condition on it). The check date is the first example's. A case
changes one field, then restores the join equalities that are not under test. The expected alerts
come from the interpreter.

**A case must discriminate.** Before a case is emitted the compiler evaluates its rows with
mutants of the condition it targets (every other operator, the literal or parameter one step
either way, the condition dropped); if none changes the alerts, the case would pass whether the
translation is right or wrong, so it is not emitted and is listed under `skipped` ("does not
isolate <condition>"). A changed field keeps its tested value and the other row is adjusted
(the inner field of a join follows an outer one and the other way round; other conditions on the
exists row are re-solved). The `two` case picks a second key value that still satisfies the whole
`where` and needs exactly two alerts, else it is skipped. A field-to-field comparison needs equal
type, length and decimals (the query compares columns, the nested form a converted host value).
NUMC values, literals and alert holes are read at the DDIC length (`'12'` in NUMC 4 is `0012`).

The cases become test methods `b_<column>_<lt|eq|gt|ne|blank|match|nomatch|zero|two>`, in the test
class after the hand-written examples; `<column>` is the field (`<alias>_<column>` when two
conditions name the same field, `c<n>` when that is too long), the whole name at most 30
characters. Every node of a case traces to the rule line of its condition. Every JOIN line
traces to its condition too (`ON` and `WHERE`: the `where:` or `when:` line).

```
node tools/dsl-l2.mjs cases <rule.l2.yaml>      # the derived cases, rows and expected alerts
```

prints the reviewer's view: for each case its method, condition, rows and the alerts expected.
The demo rule derives ten cases (`status`: eq, ne, blank; the join: match, nomatch; `dep_date`:
lt, eq, gt; the `exists`: zero, two).

## Slice 3: or, not, several exists, require

### The language

```yaml
when: ship.status = 'M' or ship.status = 'D'
forbid:
  exists: ZOSD_L2_CREW as crew
  where: crew.ship_id = ship.ship_id
    and not (crew.role = 'K' or crew.since > $date)
```

```
condition   := disjunction
disjunction := conjunction ('or' conjunction)*
conjunction := negation ('and' negation)*
negation    := 'not' negation | '(' disjunction ')' | comparison
```

`not` binds tighter than `and`, `and` tighter than `or`; parentheses group. The model keeps the
tree (`when.tree`, `clauses[n].tree`: `{op: and | or, items}`, `{op: not, item}`,
`{op: cmp, index}`), and the comparisons stay a list in the order written, each with its own
`@id` (`when/2`, `forbid/where/3`) and **its own rule line**: a condition written over several
lines (a plain scalar continued on more indented lines, or `|` / `>`) gives each comparison the
line it stands on. When the lines, joined the way YAML joins them, are not the value js-yaml read
(quotes, escapes, blank lines, indentation kept by `|`), every comparison takes the key's line.
An alias may not be `and`, `or`, `not` or `as`.

**Several exists.** `forbid:` holds one clause (`exists` + `where`, as before), or a list of two
or three under `all:` or `any:`:

```yaml
forbid:
  all:                                   # every clause matches: one alert per combination
    - exists: ZOSD_L2_VOY as voy
      where: voy.ship_id = ship.ship_id and voy.dep_date > $date
    - exists: ZOSD_L2_CREW as crew
      where: crew.ship_id = ship.ship_id and (crew.role = 'C' or crew.role = 'P')
alert: "{ship.ship_id}: voyage {voy.voyage_id}, crew {crew.crew_id}"
```

Under `all` the alert may name every alias. Under `any` each matching row of each clause is one
alert: a clause may carry its own `alert:` (holes from `for` and its own alias), and the rule's
`alert:` is shared by the clauses that do not, and may name only `for` fields. A clause's `where`
sees `for` and its own alias, not another clause's. Under `any` two clauses may read the same
table under different aliases (each is its own query; in the derived cases each clause gets a row
of its own in that table, and a case whose rows would share a key is skipped). Under `all` and
`forbid` every table is read once: a clause's `zero` case empties its table, which would empty
the other clause too.

**`require:`** is the dual of `forbid:`: one `exists` + `where`, and the alert fires for a `for`
row that meets `when` when **no** row matches. Its alert names only `for` fields (there is no row
of the other table to name).

### Row rules

`forbid: row` emits one alert for every `for` row that passes `when`, without
reading a second table:

```yaml
rule: grounded-ship
title: Grounded airships need attention
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M' or ship.status = 'D'
forbid: row
alert: "{ship.ship_id} {ship.name}: grounded"
examples:
  - name: maintenance
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
    expect: ["S001 Albatross: grounded"]
```

`when:` is required; omitting it is refused at the `forbid:` line because it
would flag every row. Only fields of the `for` alias may appear in the alert.
The scalar `row` stands alone: `exists` and `where` belong to the other
rule forms. The compiler uses the same L1 model and templates to produce one
SELECT with `when` as its WHERE, ordered by the driving table's keys.
Comparisons stay on separate lines and boolean groups keep their parentheses.
`range:`, `params:`, `keys:`, and `examples:` work as for other rules;
`boundaries: auto` derives cases only from `when`. The generated check and
ABAP Unit keep the `osd-trace/1` origins of the rule's lines.

The complete demo is `src/l2demo/grounded_ship.l2.yaml`: maintenance and dry
dock statuses, with a parameter override, a driving-key range and returned keys.
The ship table has no duration field.

**Duplicates** in one conjunction (or disjunction) are an error at the second one's line. Two
comparisons are the same after the mirroring every comparison gets anyway (the selected table's
field on the left: `a = b` and `b = a`, `a < b` and `b > a` meet), the other side compared as the
field holds it (CHAR without trailing blanks, `12.5` and `12.50` in a DEC alike). The same
comparison in two different groups (`(a and b) or (a and c)`) is fine. A `not` and a group are
compared as units, the items of a group in any order: `not a and not a` is refused, and so is
`(a or b) and (b or a)`; `a and not a` is not a duplicate.

### The lowering

- Every `where` needs, among its top-level conjuncts (joined by `and`, not under `or` or `not`),
  an equality with a `for` field: it becomes the clause's `ON` (for `require`, the correlation of
  the subquery). A clause without one is refused with the reason; for `all` the reason says that
  every clause joins the `for` table in the one query.
- `when` and the rest of each `where` are one `and` in `WHERE`, one comparison per line.
  A group inside a group is parenthesised, and so is everything after a `NOT`, so the lines never
  lean on Open SQL's precedence (which is the rule language's). A line holds one comparison and
  its parentheses.
- **No line over 255 characters.** An alert text (up to 255 characters as a literal) is cut into
  pieces of at most 100, each its own `&&` line; an expected alert of a test method that does not
  fit one literal is built in `lv_exp` the same way (`APPEND` takes no expression in 7.02).
  Wide character values assigned to example and derived-case row fields also use pieces
  joined with `&&`. These are string literals, preserving blanks between pieces and the
  complete field value (the CHAR 255 airship-note demo covers G23). What
  the `abap` profile still refuses (a long example name in the assert call's line, a long CHAR
  literal after its column) is a `RuleError` at the rule line of the node the line traces to,
  raised by `renderRule` before any file is written, so `build`, `check` and the API refuse it
  alike. Before, the profile's error only made the `build` command exit 1, after writing the
  files, and `check` and `buildRule` did not look at it.
- `forbid` with one clause or `all:` is **one** `SELECT`: `for INNER JOIN` each clause in turn,
  ordered by the `for` key and each clause's key. `any:` is **one query per clause** (7.02 Open SQL
  has no `UNION`), each into its own table (`lt_join1`, `lt_join2`), and the alerts come clause
  by clause, each clause in key order. `check` makes as many database calls as the rule has
  clauses, whatever the number of rows; `test/dsl-l2.mjs` counts them.
- `require` is **one** `SELECT` on the `for` table with a correlated subquery:
  `WHERE <when> AND NOT EXISTS ( SELECT * FROM <table> AS <alias> WHERE <where> )`, the outer
  field written `for_alias~field`. **Chosen after measuring** (2026-09-30): the transpiler takes
  the 7.02 form, passes the subquery through to SQL with its correlation, and SQLite answers it;
  a probe over five ships and five voyages gave the expected rows for `OR`, `NOT ( ... )` and
  `NOT EXISTS` against the nested form. So the FOR ALL ENTRIES fallback the spec named was not
  needed, and no anomaly was found. (The SQLite client of the runtime turns every `~` of the
  statement into `.`, which is how `ship~ship_id` inside the subquery reaches the database.)
- `check_reference` stays the direct nested form for every construct: a `SELECT` per row of the
  table before it, `LOOP` for `forbid`, `IF lt_x IS INITIAL` for `require`, one pass per clause for
  `any` (clause by clause, the order `check` answers in).

### The interpreter and the derived cases

`evaluate` walks the trees. Two-valued logic is enough: a field is never NULL here (every row is
written by an ABAP `INSERT`, which fills every column, and every join is an inner join), so
`not` is plain negation.

A case must make its comparison decide. The compiler walks from the tree's root to the
comparison: under an `and` the other items must hold, under an `or` they must not, a `not`
passes the decision through; every other tree of the rule holds. Rows are solved for that (a
tree's ways to come out true or false are enumerated, at most 64 per tree), starting from the
first example's first rows, and then the comparison's field takes its boundary values as in
slice 2. Under a `not` the mutants are the same and the expected result flips (the interpreter
computes it). Under `require` a comparison of `when` is tested with no exists row, since with one
the rule stays silent whatever `when` says.

The discriminate guard stays mandatory. Its mutants of a comparison are: always true (dropped
from an `and`), always false (dropped from an `or`), every other operator, and the literal or
parameter one step either way. The structural cases have a guard of their own: some clause
replaced by one that always matches, or by one that never does, must change the alerts.

| rule | structural cases |
|---|---|
| `forbid`, one clause | `b_exists_zero`, `b_exists_two` (as in slice 2) |
| `all` | per clause `b_<alias>_zero` (that clause unmatched: no alert), `b_<alias>_two` |
| `any` | per clause `b_<alias>_only` (only that clause matches), `b_<alias>_two`; `b_exists_zero` |
| `require` | `b_exists_zero` (no exists row: the alert), `b_exists_one` (one matching row: none) |

`<alias>` falls back to `exists<n>` when a name would pass 30 characters.

### Demo

Beside the slice 1-2 rule, on the same fleet with a crew table (`ZOSD_L2_CREW`):
`src/l2demo/grounded_ship_crew.l2.yaml` (`or` and `not`, its `where` over two lines; 6 examples,
16 derived cases) and `src/l2demo/ship_captain.l2.yaml` (`require`; 6 examples, 13 derived
cases). The slice 1-2 demo's ABAP did not change; its traces did, where a line that named no
value (`TYPES: BEGIN OF`, `ORDER BY`, the reference's `SELECT` lines) traced to the rule's root
and now traces to its query or its level.

`test/dsl-l2.mjs` also builds a synthetic `all` rule and a synthetic `any` rule over the three
fleet tables and runs them, and mutates the generated ABAP once per construct: `OR` made `AND`,
a `NOT` dropped, `NOT EXISTS` made `EXISTS` (the reference's `IS INITIAL` made `IS NOT
INITIAL`), and one clause of `all` taken out of the query and the reference alike; each turns
its cases red.

## Commands

```
node tools/dsl-l2.mjs build <rule.l2.yaml> --out <dir> [--ddic <folder>]...
node tools/dsl-l2.mjs check <rule.l2.yaml> --out <dir> [--ddic <folder>]...
node tools/dsl-l2.mjs cases <rule.l2.yaml> [--ddic <folder>]...
```

`build` writes the class (`.clas.abap`, `.clas.testclasses.abap`, `.clas.xml`) and both traces.
`check` regenerates into a scratch folder and compares byte for byte; exit 1 on drift. Both need
a built tree (`npm run transpile`): the templates render in the ABAP runtime. `--ddic` defaults to
`src` and open-abap-core's DDIC.

## Adding a rule

1. Put the tables it reads under `src/` (abapGit TABL XML), if they are not there.
2. Write `src/<folder>/<name>.l2.yaml` with examples that pass, and `boundaries: auto`; the
   compiler derives the boundary cases itself (`node tools/dsl-l2.mjs cases <file>` shows them).
3. `node tools/dsl-l2.mjs build src/<folder>/<name>.l2.yaml --out src/<folder>`, then
   `npm run transpile` and `node tools/osd-unit-run.mjs`.
4. Commit the rule and the generated files together; `check` keeps them in step.

`*.l2.yaml` and `*.trace.json` are excluded from the transpile and from abaplint
(`abap_transpile.json`, `abaplint.jsonc`): abaplint would read a trace as a file of the class and
a rule file as an object of an unknown type.

## Slice 4: count with a threshold

`limit:` counts related rows for each `for` row that passes `when`. It takes
`count: TABLE as alias`, a slice-3 `where:` with a top-level equality to the
`for` table, and exactly one threshold: `more_than: n` or `at_least: m`.
Thresholds are non-negative INT4 integers; `at_least: 0` is refused because it
holds for every `for` row. `more_than: 0` and `at_least: 1` mean existence,
with one alert per `for` row. `limit` cannot be combined with `forbid` or
`require`. The alert names fields of the `for` row and may use `{count}`;
the counted table has no single row to name. The interpreter prints the count
with JavaScript's integer decimal conversion. Both generated ABAP methods copy
the integer into a length-12 character field and `CONDENSE ... NO-GAPS`, so
the alert has no padding or leading zeros.

The intended aggregate JOIN lowering was probed first in
`docs/probes/dsl-l2/`. `GROUP BY` and aliased `COUNT( * )` reached generated
SQL, but transpiler 2.13.93 has no `HAVING` support and omitted it. See
`ANORMALIES.md#anomaly-2026-10-01-select-having-dropped`. The chosen lowering
uses one 7.02 Open SQL INNER JOIN ordered by the `for` key. A loop counts
adjacent matching rows and emits one alert after a group exceeds the threshold.
The reference independently selects the `for` rows, then selects matching
count-table rows per row and uses `DESCRIBE TABLE ... LINES`. Each test runs
both methods and compares their ordered alerts, then compares to the
interpreter. Derived cases put the count at `n` and `n + 1` for `more_than`,
or `m - 1` and `m` for `at_least`. A two-group case checks the transition
between distinct `for` rows. Each threshold boundary case must change under a mutant of
its threshold. Per-comparison cases include enough other matching rows for
their own comparison to decide the threshold.
Case generation is bounded to 64 counted rows so a valid INT4 threshold cannot
allocate billions of test rows. Cases needing more rows are reported as skipped
with the cap named. `build` and `check` warn at the threshold's rule line
whenever a derived case is skipped for the cap, naming the cases: the two-group
case needs `over + at` counted rows, so it is lost from `more_than: 32` and
`at_least: 33`, a boundary case from `more_than: 64` and `at_least: 65`. A
threshold whose cases all fit (`more_than: 31`, `at_least: 32`) draws no
warning, and `at_least: 64` warns about the two-group case only, both of its
boundaries (63 and 64) being derived. Hand-written
examples must cover the skipped cases. The second group's `for` row takes
different values in every non-key field the alert names, so the alert lines
tell the groups apart; where no such values exist the case is skipped with
that reason.

The demo is `src/l2demo/ship_voyage_limit.l2.yaml`: zero, two, three and five
future voyages, a ship excluded by `when`, a cross-ship case that exposes a
missing ON equality, and groups inserted out of key order with the last group
both above and below the threshold.

## Slice 5: count from below (`fewer_than`, `exactly`, zero counts)

`limit:` takes exactly one of `more_than: n`, `at_least: n`, `fewer_than: n`
or `exactly: n`. `fewer_than: 0` is refused (a count is never below 0);
`exactly: 0` is allowed. The other slice-4 rules stand, and `{count}` prints
`0` for a `for` row with no related row. `fewer_than` and `exactly` need that
row: it can break the rule ("an active ship has at least two crew members",
`fewer_than: 2`) and the INNER JOIN of slice 4 never returns it.

### The probe, and the shape chosen

`docs/probes/dsl-l2/zcl_l2_outer_probe.clas.abap` (and its test include)
measured, on 2026-10-01, transpiled with the fleet tables and run here:

- a LEFT OUTER JOIN with the join equality in `ON` returns the `for` row with
  no match once, its outer columns **initial** (`''`, `00000000`): what a
  system does with a null;
- `ON` with an equality against a literal (`crew~role = 'C'`), `ON` with
  `crew~since > iv_date`, and a right-table column in `WHERE` all pass
  abaplint's syntax check for `v702` and `open-abap` and answer by standard
  SQL. The first is legal Open SQL: SAP's own example of an outer join has
  `p~cityfrom = 'FRANKFURT'` in its `ON` (SAP Help, "Specifying Two or More
  Database Tables as an Outer Join",
  https://help.sap.com/saphelp_autoid2007/helpdata/en/fc/eb39c4358411d1829f0000e829fbfe/content.htm?no_cache=true).
  The other two are not: an outer join's `ON` takes `=` comparisons only,
  joined by AND, and no column of the right table may stand in `WHERE` (the
  later releases lift this in strict mode only, which needs `@` and `INTO`
  last). Recorded as `ANOMALY-2026-10-01-outer-join-702-restrictions-unchecked`;
  not measured on a 7.02 system;
- `COLLECT` does not sum in this runtime: it looks for a line equal as a
  whole and inserts the work area when there is none. A standard table then
  gains a second row for a key with another count, a sorted table with a
  unique key refuses the duplicate and keeps its first row
  (`ANOMALY-2026-10-01-collect-does-not-sum`, the same on transpiler `main`).
  The first lowering counted with it; `check_reference` failed every case
  with a count of two or more.

Neither the probe nor the rule was run on A4H: ABAP Unit runs there
currently return no test classes at all.

The compiler chooses one LEFT OUTER JOIN for `fewer_than` and `exactly` when
the counted clause's entire `where` is a conjunction of equalities to outer
fields or literals. Every `where` equality goes in `ON`; `when` alone goes in
`WHERE`. The query orders by the `for` key, and the code then runs `SORT lt_join BY`
that key itself, so the loop never depends on the database returning the rows
of one key together (the same `SORT` guards the one-query count of slice 4,
which also detects a key change by comparing with the previous row). The
`ORDER BY` stays as a request to the database. A test shuffles the joined rows
right after the `SELECT` (the first row moves to the end, which splits a key
of two rows from itself): green with the `SORT`, red without it. Removing
`ORDER BY` alone stays green by design, since the `SORT` makes it redundant for
correctness. The loop counts a row only when
the counted table's `MANDT` key is not initial. On a 7.02 system Open SQL's
implicit current-client handling guarantees a real joined row has a
noninitial client marker. This matters: the runtime probe accepted a real crew
row with an initial `CREW_ID`, so that key field cannot distinguish it from a
missing side. The generated query collects each `for` key once into `lt_for`,
a table of its own type (`ty_for`, the `for` alias's fields only, so the
counted table's client marker is not in it), and clears its count before
reading the counted rows. The `ship_min_captains` demo exercises this form, including
the real row with an initial crew ID. This runtime does not implement implicit
client filtering: a direct database probe accepted a row with both `MANDT`
and `CREW_ID` initial, an all-initial DDIC key. Such manually inserted rows
are outside this one-query guarantee. The compiler does not emit an explicit
client equality in `ON`, which
7.02 Open SQL allows only with `CLIENT SPECIFIED` (the same SAP Help page
linked above).

A non-equality such as `crew.since <= $date`, a parameter equality, or an
`or` / `not` in `where` keeps the two-query form below. The compiler makes
this choice from the condition tree, not from generated SQL.

1. The `for` rows that meet `when`, the key and the fields the alert names,
   `ORDER BY` the `for` key, into `lt_for`. It traces to the `for:` line, its
   `WHERE` to `when:`.
2. The slice-4 INNER JOIN, selecting only the `for` key, into `lt_join`. A
   loop counts it per key into a sorted table `lt_count` (`READ TABLE ... WITH
   TABLE KEY`, then `ADD 1` and `MODIFY TABLE`, or `INSERT ... INTO TABLE`
   for a new key; no `COLLECT`, see above).

For the two-query form, `LOOP AT lt_for`: `CLEAR lv_count`, `READ TABLE lt_count` by the key, the
count taken when found, and 0 when not; the threshold decides the alert. The
alerts come in the `for` key order. `more_than` and `at_least` keep the
one-query lowering of slice 4; their ABAP did not change. `check_reference`
stays the nested form (`DESCRIBE TABLE ... LINES` counts 0 by itself).
`test/dsl-l2.mjs` counts database calls: one for the equality-only form and
two for the other form, whatever the number of `for` rows.

### Derived cases

The interpreter evaluates `<` and `=` as it does `>` and `>=`; a `for` row
with no counted row counts 0. The threshold cases:

| threshold | cases (counted rows) |
|---|---|
| `more_than: n` | `not_over` n, `over` n + 1 (slice 4) |
| `at_least: m` | `below` m - 1, `at` m (slice 4) |
| `fewer_than: m` | `below` m - 1, `at` m, and `zero` (0) unless m - 1 is 0; `next_zero` |
| `exactly: n` | `below` n - 1 (not for n = 0), `at` n, `above` n + 1, and `zero` unless one of them is 0; `next_zero` |

`next_zero` puts a `for` key with counted rows directly before, in key order,
a key with none. The first key's count is the one that would change the
second key's answer were it carried over (`fewer_than: m`: m; `exactly: n`:
n, or 1 for `exactly: 0`), and the case must change its alerts under the
mutant that keeps the previous row's count (the interpreter's `stale`
mutant). It tests the count reset per `for` row, which no other derived case
does: the zero cases have one `for` row, and the two-group case guarantees
neither a key without counted rows nor the order of its keys.

A case with 0 counted rows has a `for` row and no row of the counted table at
all. A threshold case must discriminate: some mutant changes its alerts,
another operator (`<` for `<=`; `=` for `>=`, `<=`, `<>`), the value one
either way, or, for `fewer_than` and `exactly`, the `for` rows read through
the INNER JOIN only. The case of a comparison is built at a pivot count: for
a `when` comparison the count at which the rule alerts nearest the threshold
(`fewer_than: m`: m - 1, `exactly: n`: n), for a `where` comparison the count
at which one row less changes the answer (m; n, or 1 for `exactly: 0`). So
`fewer_than: 1` tests its `when` on a ship with no counted row. The two-group
case stays: the first group alerts (m - 1 rows, or n), the second does not
(m rows, or n + 1), and the groups must read differently in the alert. The
64-row cap and its warning apply as in slice 4 (`fewer_than: 33` loses the
two-group case, `exactly: 64` its `above` case and the two groups).

### Demo and mutations

`src/l2demo/ship_min_crew.l2.yaml`: an active ship has at least two crew
members aboard on the check date (`fewer_than: 2`, `where` with
`crew.since <= $date`). Its examples have ships with 0, 1, 2 and 3 crew, one
whose second member joins after the check date, a ship filtered out by `when`,
a ship without crew next to one with two, and five ships and six crew members
inserted out of key order; 13 derived cases. `test/dsl-l2.mjs` mutates the
generated ABAP: `<` made `<=` fails `two_crew_members` and `b_count_at`;
`CLEAR lv_count` dropped (a ship without crew keeps the count of the ship
before it) fails `fleet_out_of_key_order` and `b_count_next_zero`, and on a
copy of the rule whose only example has one crew member it fails
`b_count_next_zero` alone, so the derived cases catch it without a
hand-written fleet; `CHECK sy-subrc = 0` after the read
of the counts (only the keys the join returned alert, the merge of the
missing rows gone) fails `no_crew`, `other_ships_crew`, the fleet and
`b_count_zero`. A synthetic `exactly: 1` rule over the crew roles runs green
and fails `none_and_two` and `b_count_above` with `=` made `>=`, and
`b_count_next_zero` with `CLEAR lv_count` dropped; `exactly: 0`
and `exactly: 3` run green with their own cases.

`src/l2demo/ship_min_captains.l2.yaml` is the one-query example:
`crew.ship_id = ship.ship_id and crew.role = 'C'`. Its committed generated
class contains one `SELECT`. The examples and every derived case compare
`check` with `check_reference`, including an inserted crew row whose
`CREW_ID` is initial. The one-query call count stays one across five ships.
Three generated-code mutants go red: counting a missing-side row as one,
moving the role equality from `ON` to `WHERE`, and dropping `CLEAR lv_count`.

## Slice 6: sum, min and max of a numeric field

`limit` can name one numeric field of its counted table with `sum`, `min` or
`max`, followed by `where` and one of the same four thresholds as `count`:

```yaml
limit:
  sum: ZOSD_L2_CARGO.weight as cargo
  where: cargo.ship_id = ship.ship_id
  more_than: 1000.00
alert: "{ship.ship_id}: {sum} kg booked"
```

The field must resolve in DDIC as `INT1`, `INT2`, `INT4`, `INT8`, `DEC`,
`CURR` or `QUAN`. `FLTP` is refused because its rounding and equality cannot
be proved here. Other fields, including `CHAR`, `NUMC` and `DATS`, are refused
at the aggregate field's rule line with their DDIC type in the reason. The
threshold goes through the existing `literal` / `misfit` checks against the
field type, including the number of DEC decimals. Thus `1000.001` does not fit
`DEC 9,2`.

SUM accumulates in `p LENGTH 16 DECIMALS d` for packed fields and `INT8` for
integer fields. MIN and MAX use the field's own type. This widens
`INT1`/`INT2`/`INT4`; an `INT8` sum is limited by the full `INT8` result range,
and a packed sum uses a 16-byte accumulator with the field's decimals. The
rule does not establish a maximum number of matching rows, so an actual sum
can still overflow its accumulator. To keep the generated boundary test from
overflowing first, it skips an adjacent INT8 sum boundary outside the INT8
range (for example, `above` at INT8 maximum) and records the reason in
`model.skipped`.

An empty SUM is 0. An empty MIN or MAX is undefined: with either operation,
`fewer_than` and `exactly` are refused at the threshold line. For
`more_than` and `at_least`, a `for` row with no matching counted row produces
no MIN/MAX alert. SUM thresholds whose answer may depend on the empty value
use the two-query lowering or the equality-only LEFT OUTER JOIN from slice 5.
For all aggregates, the main query is an ordered JOIN, then an explicit SORT,
then an ABAP loop. It accumulates one result per `for` key; it does not use
`HAVING`, which this runtime drops. `check_reference` remains a nested SELECT
per `for` row and loops over the selected values.

The native-aggregate probe at `docs/probes/dsl-l2/` showed that this
transpiler does execute `SELECT SUM( weight )`, `MAX( weight )` and `GROUP BY`
with the expected grouped values. `HAVING` is still dropped, so the generated
rule uses the loop for its threshold. The probe also recorded that packed
`10.50` assigned directly to STRING becomes `10.50 `, but assigning through a
fixed CHAR first loses the decimals; packed `-10.50` becomes `10.50-`. The
packed formatter copies the magnitude to packed, converts it to STRING,
condenses it, then prefixes a negative sign. For integer aggregate alerts,
direct INT8-to-STRING conversion puts the sign first here and last on SAP
(ANORMALIES `int8-string-sign`, measured on A4H: INT8 and I -3 to STRING
both give `3-`). The generated formatter converts the magnitude to
INT8, converts it to STRING, condenses it, then prefixes `-`; INT8 minimum
uses its known decimal magnitude because that positive value cannot fit in
INT8. The interpreter emits the same field-literal text, including DEC scale.

Derived SUM boundaries are `t - 1` smallest field step, `t` and `t + 1`
smallest field step (one for integer fields, `10^-d` for packed); MIN and MAX
include a group whose extreme equals the threshold. Applicable zero, next-zero
and two-group cases follow slice 5. `src/l2demo/ship_cargo_limit.l2.yaml`
demonstrates fractional weights below, at and above a DEC threshold; the
max-cargo demo and test-only all-negative groups exercise MIN and MAX, including
the initial-value guard and alert formatting. The integer formatter has a
generated-code shape assertion: removing its magnitude conversion and explicit
sign prefix is rejected even though this runtime's direct INT8 conversion
would print a leading sign. The tests mutate `>`, SUM-to-count, MAX-to-MIN,
MAX's first-row guard, the accumulator reset and the accumulator's decimals;
each mutation is caught.

## Slice 7: typed parameters and date windows

`params:` declares names for `$name` operands. Each name has a DDIC element,
a table field (`<TABLE>-<field>`, typed as the field is and named so in the
ABAP) or a provider-resolved built-in `type`, and may have a `default`. A bare
`C`, `N`, `P` or `X` is refused at its line: it has no length, and a system
refuses it in a class or a report (A4H, 2026-10-02; `tools/dsl-l2-params.mjs`). For example,
`max_days: {type: ZOSD_L2_DAYS, default: 30}` declares `$max_days`. A default
makes the ABAP IMPORTING parameter optional; without it, every example must
supply a value. An example's `params:` mapping overrides defaults. The test
class passes those values to both `check` and `check_reference`, and the
interpreter receives the effective values. A declared parameter must be used.
Unknown names, `date` as a declared name, unresolved and FLTP types, and
defaults or example values that fail the `literal` filter are refused at
their source lines. A direct comparison needs the same DDIC built-in type,
length and decimals as its selected field.

`$date - N` and `$date + N` compare with DATS fields. `N` is a non-negative
INT4 literal or a declared INT1/2/4 parameter whose supplied values are
non-negative INT4 day counts. The compiler assigns each distinct bound once
to `DATA lv_window_<n> TYPE d` before any SELECT; Open SQL compares the
field with that local. The reference method does the same. The interpreter
uses Gregorian day arithmetic, including month ends and 29 February. Its
derived cases use the bound, the preceding day and the following day when
they isolate the condition. The discriminator also checks offset mutants
`N - 1` and `N + 1`; the demo's lower-bound `lt` and `eq` cases kill them.
Window use lines in the trace carry both `rule_line` (the comparison's line)
and `param_rule_line` (the declaration's `params:` line). A window against a
non-DATS field, a negative literal offset, and a non-integer offset parameter
are refused at the comparison line.

`src/l2demo/recent_voyage.l2.yaml` uses the fleet's ship and voyage tables:
an active ship needs a voyage in the last `$max_days` days, default 30. Its
first example sets one day and checks the 2024-02-29 lower bound from a
2024-03-01 check date. The derived cases check the adjacent days. The rule
stays out of `fleet.l3.yaml`; the fleet set instead demonstrates a set
parameter with its captain rule.

## Optional driving-key range (`range:`)

For the L3 pile planner (`docs/dsl-l3.md`, "Piles and set parameters"), a rule may declare a key
range on its driving table:

```yaml
for: ZOSD_L2_SHIP as ship
range: ship.ship_id
```

`range:` names a field of the `for:` alias (refused at its line otherwise, and for a field the
table does not have). The generated `check` then takes `it_range TYPE RANGE OF <for
table>-<field> OPTIONAL`, and the query that reads the `for:` table carries `<alias>~<field> IN
it_range` as one more conjunct of its `WHERE`: the range is tested by the database, never in a
`LOOP ... WHERE`, and a `when:` that is an `or` is parenthesised before it, as any group is
(`layout` in `tools/dsl-l2.mjs`). An empty range is every row, as Open SQL has it, and the
interpreter reads it the same way. The reference in the test class filters its first `SELECT` the
same way, and the line traces to the rule's `range:` line.

An example may give a range of its own, as select-option rows, sign `I` with option `EQ` (a low)
or `BT` (a low and a high), each value fitting the field:

```yaml
  - name: the range keeps the inner ship
    date: 20261001
    range: [{sign: I, option: BT, low: S002, high: S003}]
    rows: ...
```

The test class passes the range to `check` and to `check_reference`; an example without one
passes none, and the derived cases run over every row. Every demo rule on `ZOSD_L2_SHIP` has such
an example over three flagged ships, one inside the range, so dropping the range from the `WHERE`
turns that example red (`test/dsl-l2.mjs`). The range is part of the compiled model, so it changes
the model hash of the rules that declare it. A rule without `range:` renders the same ABAP as
before: `test/dsl-l2.mjs` renders the two demo rules without one through the templates and through
the templates with every range section taken out, and compares the bytes. The code is
`tools/dsl-l2-range.mjs`.

## The keys a rule flags (`keys:`)

For the L3 filter stages (`docs/dsl-l3.md`, "Stages, filters and a schedule"), a rule with a
`range:` may also hand back the driving keys it flags:

```yaml
for: ZOSD_L2_SHIP as ship
range: ship.ship_id
keys: true
```

The class then has, beside `check`, `keys( iv_date, it_range, <params> ) RETURNING rt_keys`,
`rt_keys` a `RANGE OF <for table>-<field>` (the class's `tt_range`): sign `I`, option `EQ`, one row
per distinct flagged key, sorted. It is the check's own query (each query, for `any:`) with the key
field only, `SELECT DISTINCT <alias>~<field> ... APPENDING TABLE`, then `SORT` and `DELETE ADJACENT
DUPLICATES`: one query, never a `SELECT` per row, and a key flagged by several rows is one row.
`keys:` is `true` or `false`; `keys: true` needs a `range:` and is refused, at its line, on a
`limit:` rule: a threshold is decided in ABAP over the ordered rows (the `HAVING` probe fails on
this runtime, slice 4), so a limit rule's keys are not one `SELECT DISTINCT`. That is the one
deviation from the slice's design; the demo's filter is a `forbid:` rule.

An example may give `expect_keys: [S001, S003]`; the interpreter answers it by evaluating the rule
with every alert replaced by its driving key (`ruleKeys` in `tools/dsl-l2-range.mjs`, so every kind
of rule answers through the one evaluator), and a list that is not the rule's sorted keys is refused
at its line. Every test of a keys rule, example and derived case alike, asserts `keys( )` beside
`check( )` against the interpreter's answer (or `expect_keys` when the example gives it). The model
node is `driving_keys` (a `keys` already names a part of the count query); the `keys` method's own
lines trace to the `keys:` line, its query to the rule's own lines, as the check's does. A rule without
`keys:` renders the ABAP it rendered before: `test/dsl-l2.mjs` renders four demo rules through the
templates with and without the keys sections and compares the bytes (the sidecars' template line
numbers moved, their model hashes did not). The demo rule is `ship_busy.l2.yaml`: a ship that is not
decommissioned with a voyage ahead; the mutant whose `keys( )` returns duplicates turns its example
"several voyages one key" red.

## Slice 8: range parameters (`field in $name`)

Real rule sets select by ranges, a SELECT-OPTIONS or a variant's table of countries, categories,
statuses, and a rule should say `ship.status in $restricted`, not an OR chain of equalities. A
parameter is a range when it says so:

```yaml
params:
  restricted: {type: ZOSD_L2_SHIP-STATUS, range: true, default: [M, D]}
when: ship.status in $restricted
```

`range: true` makes the parameter a selection table of its type (a data element, a built-in or
`<TABLE>-<field>`, as for a scalar). The class declares `TYPES tt_restricted TYPE RANGE OF
<type>` and takes it as `iv_restricted TYPE tt_restricted OPTIONAL`. The type of a range is a
character, numeric, date or time type; a string or a floating point type is refused at the
parameter, and so is a name of more than 24 characters (the local copy is `lt_p_<name>`) and the
name `range` (the driving-key range's `tt_range`).

**Rows.** `default` and an example's `params:` value are a list of SELECT-OPTIONS rows
`{sign, option, low, high}`, or of bare values, each one an `I EQ` row (`[M, D]`). The sign is `I`
or `E`, the option `EQ` or `BT` (a `BT` row has `high`, with `low` not above it; an `EQ` row has
none); values fit the type by the same check as every literal. Refused at their lines: an unknown
sign, option or key, a value that does not fit, a `BT` without `high` or reversed, a scalar
default for a range, a list for a scalar. A range without `default` is an empty table.

**Conditions.** `field in $name` and `field not in $name` are comparisons like the others: they
may stand in `when`, in a `forbid` or `require` `where`, under `and`, `or` and `not`, and the field is of the table being selected, on the left. The generated Open SQL is
`ship~status IN lt_p_restricted` (a table of the class's own, no `@` host escape: the same form
the driving-key range has) or `NOT IN`; the nested reference form says `status IN lt_p_restricted`.
`in` is a word of the condition language now, so it can no longer be an alias. Refused at the
comparison's line: `in` with a parameter that is not a range, a range parameter under `=`, `<`
and the rest (the message says to write `in`), `$date`, a literal or a field on the right, a field
that is not on the left, and a field whose type is not the range's.

**Empty means every value, and `not in` of it means none.** Open SQL reads a value as in a
selection table when it meets some `I` row (every value when there is no `I` row) and no `E` row,
and an empty table as every value. `NOT IN` is the negation of the whole, so against an empty table
it holds for no value. The interpreter (`inSelection` in `tools/dsl-l2-range.mjs`) says the same,
and the ABAP of `test/dsl-l2.mjs` ("slice 8") agrees on this runtime for an empty table, `E` rows
alone and `E` rows cut out of a `BT` row. **Measured here only: not yet on A4H.**

**The default is applied when the parameter is not supplied.** A range with a default makes the
class (and the test's `check_reference`) copy it into a local table: `IF iv_restricted IS
SUPPLIED. lt_p_restricted = iv_restricted. ELSE.` then the default rows, one `APPEND` each. So a
caller can supply an empty table on purpose (every value), which a scalar `DEFAULT` cannot tell
from "not given" in the same way. A range without a default is read directly:
`ship~status IN iv_restricted`. Every row of the default traces to its line of `params:`, and the
line that uses it to the condition (`rule_line`) and the declaration (`param_rule_line`).

**Examples.** `params: {restricted: [A]}` gives an example its own table; `[]` is the empty table. The
test builds the table from its rows (`lt_p_restricted`, `ls_p_restricted`) and passes it to `check`
and `check_reference`. An example that gives none gets the rule's default, and the interpreter the
same.

**Derived cases.** A range comparison has four, `b_<column>_<in|out|empty|excl>`, each isolating
the comparison like the others and each killing one mutant of it:

| case | rows | kills |
|---|---|---|
| `in` | a value that the table holds | the condition always false, `in` turned into `not in` |
| `out` | a value that it does not | the condition always true (the range ignored), `in` turned into `not in` |
| `empty` | the table emptied for this case (an argument of the case), with a value the full table did not hold | an empty table read as no value, `in` turned into `not in` |
| `excl` | an `E` row for the value of `in` added to the table (an argument of the case) | the `E` rows dropped, the range ignored |

`node tools/dsl-l2.mjs cases` prints the table a case sets for itself (`$restricted: I EQ M, I EQ D, E EQ M`, `(empty table)`).
An empty default has no value outside it, so `out` is skipped and listed under `skipped` ("no
value outside the range: an empty range holds every value"). The mutants are `{...cond, constant}`,
the operator turned, and two of the range's own (`exclusions_ignored`, `empty_is_none` on the
comparison's `rhs`, tools/dsl-l2-eval.mjs, `mutantsOf`); `test/dsl-l2.mjs` checks each case against
the mutant it is for, and four mutants of the generated ABAP: `in` turned into `not in`, the table
dropped from the WHERE (red against `check_reference` too), the default never applied and the
default always applied.

`src/l2demo/ship_restricted_status.l2.yaml` is the demo: a ship whose status is in `restricted`
(default `M`, `D`) and whose id is not in `exempt` (default one `BT` row, `S900` to `S999`) has no
voyage after the check date, with twelve examples (the table omitted, replaced, empty, one `E` row, a `BT`
row with an `E` row cut out of it, an exempt ship, its own exempt table, both tables at once, and a
driving-key range beside them) and fifteen derived cases (four for each of the two range comparisons). It has a `range:`
of its own, so a set may pile it (docs/dsl-l3.md, "Range set parameters"); it stays out of
`fleet.l3.yaml` and `fleet2.l3.yaml`, whose tests count their rules and alerts, and `fleet3.l3.yaml`
runs it.

## Not yet

Grouping by fields of the counted table, a range comparison in a `limit`'s `where` (untested), the other options of a range row (`NE`, `GT`, `CP` and the rest) and a range over a string type,
`limit` under `all` / `any`, a condition on the outer table inside `where` beyond
the join (a comparison of an `exists` field with an outer field is allowed; one of only outer
fields is not), a `for` and an `exists` on the same table, a join without an equality, an
equality under `or` as a join, a clause of `all` or `any` naming another clause, `require` with
more than one clause, more than three clauses, a message class for the alert, and running a rule
on A4H. Date windows use a proleptic Gregorian calendar in the interpreter;
their behavior across the 1582 calendar switch still needs measurement on a
system. There is no runtime guard for very large day offsets. The interpreter's
agreement with a system is measured here only, on this runtime (NUMC
comparisons against a literal, for one, are the interpreter's reading of the DDIC and are not
exercised by an ABAP test).
