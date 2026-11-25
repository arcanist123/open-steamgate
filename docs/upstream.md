# What goes upstream, and how

> **2026-09-17, 06:41–06:49:** Lars merged #1862 (compare), #1864 (rounding)
> and #1867 (APPEND) within the morning; #1863 (MOD) is still open, #1866
> (integer division) unanswered, abaplint/abaplint#4302 open. The npm
> runtime is still 2.13.87; when the next release carries the three, the
> pinned `local/osd-build` loses three of its commits and the preview pin
> moves to a published version plus what remains (core pin, MOD).


The current transpiler and runtime build is `local/osd-build-4m` at `a272f3c96ad43bda22ab2ad7eff6349cf01cd5cf`
(upstream 2.14.38 `1c768652`, parser 2.120.118, with items 20 and 21 merged upstream and the CDS metadata of #2264)
with the fork commits ported onto it ([transpiler-pin-4.md](transpiler-pin-4.md), "4m"). Until 2026-11-25 it was
`local/osd-build-4c` at `a0d80fff183d805194842562b25dc71b86f0ce81`
(upstream main `8824945a`, 2.14.19 plus the EML lowering #2049 and the SQL escape #2050, parser 2.120.94) with
fourteen fork commits: the `only` option and registry reuse, the built-in and "four fixes" commits, `SELECT SINGLE
FOR UPDATE` run as the SELECT, and the numeric ones ported onto upstream main (exact packed arithmetic, int8 and
integer byte conversions, the type `i` overflow of #1955). [The pin move report](transpiler-pin-4.md) lists them. The dossier below is the historical snapshot. Every one of those fixes has an entry
in `ANORMALIES.md` and a branch in that clone, and `npm run parked` prints the
two side by side and complains where they disagree. This is the dossier for
sending them: what each is, what proves it, where the fix lives, and what to
do next. Snapshot of 2026-09-16; `npm run parked` is the live version.

## The procedure, once per fix

1. `git fetch origin` in `~/dev/transpiler`, and move `main` to `origin/main`
   — the parked report compares branches with the local `main`, and today
   that is nine commits behind, so it shows upstream's own commits as if they
   were ours.
2. A branch **inside `abaplint/transpiler`**, never a fork: the regression
   workflow fires on a push to a branch there and not on a pull request from
   a fork (CLAUDE.md, the rule read off the workflows). After pushing, check
   that **Regression** is in the checks, not only **CI**.
3. In that repository's own clone, with nothing uncommitted, run its lint and
   the package's tests before the PR. An em dash in an ABAP comment failed the
   lint once; the prose style used everywhere else here is what breaks it.
4. One small PR per fix, the ANORMALIES entry as the description's source:
   reproducer, expected, actual, where. Lars merges; nothing of ours is
   merged by us there.
5. When it lands: the entry's status becomes `fixed upstream: #NNNN`, and
   when a release carries it, the version line says which. When every entry
   the link exists for says so, `npm run transpiler:published` drops the link.

## Already upstream — update the record, wait for a release

| entry | branch | upstream | in a release? |
| --- | --- | --- | --- |
| `ANOMALY-2026-09-14-float-separator-not-inverse` | `fix/float-separator` | #1847 merged | 2.13.87 |
| `ANOMALY-2026-09-13-paren-before-conv` | `fix/rearranger-constructor-operand` | #1843 merged | 2.13.87 |
| `ANOMALY-2026-09-13-conv-second-in-expression` | `fix/conv-builtin-type-name` | #1842 merged | after 2.13.87 |
| `ANOMALY-2026-09-13-sy-tabix-not-restored` | `fix/sy-tabix-restore` | #1848 merged | after 2.13.87 |
| `ANOMALY-2026-09-14-sy-tabix-hashed` | `fix/sy-tabix-restore` | #1848 merged | after 2.13.87 |

Their statuses in `ANORMALIES.md` were updated with this document. The
branches can be deleted once `main` is moved; `parked` will then stop listing
them.

## Local only — ready to send, in this order

Checked against GitHub on 2026-09-24. What stood here as items 1 to 5 has gone
out and is merged: `fix/w3mi-objid` (abaplint/transpiler#1846),
`fix/percent-in-filename` (#1844), `fix/compare-character-literal` (#1862),
`fix/binary-file-copy` (#1845), and the two builtin anomalies of
`fix/builtin-not-a-method`, which went away upstream in 2.13.88 without our
branch. What is left:

6. **`fix/sy-tabix-restore`, the remaining commit** — "Take the
   class-constructor timing out of …", `ANOMALY-2026-09-14-class-constructor-eager`.
   #1848 took the sy-tabix half. The issue is filed
   (abaplint/transpiler#1849); the commit is still local. Rebase the branch
   on `origin/main`, and it is one commit to offer against #1849.

7. **express-icf-shim: a posted form has no form fields** —
   `ANOMALY-2026-09-19-posted-form-has-no-fields`. `cl_express_icf_shim`
   fills the request's form fields from the query string alone, so a handler
   behind `<form method="post">` reads every field as empty and behaves as
   though nobody typed anything. No branch yet, and no issue yet. The fix is
   small and belongs where the request is assembled: when the method carries
   a body and the content type is `application/x-www-form-urlencoded`, parse
   it into the same fields — and decode `+` as a space, which
   `cl_http_utility=>string_to_fields` does not do (it decodes with
   `decodeURIComponent`). The interface already names the body as a source:
   `get_form_fields_cs` takes `search_option DEFAULT
   co_body_before_query_string`. Workaround here:
   `src/webgui/zcl_osd_form`, with `test/unit/zcl_osd_form_test`, whose last
   test asserts the **gap** so the workaround has an expiry.

8. **express-icf-shim: one static server for every request** —
   `ANOMALY-2026-10-02-icf-shim-static-server`. `cl_express_icf_shim=>run`
   hangs each request's `request` and `response` entities on
   `CLASS-DATA mi_server`, so a handler that is still running when another
   `run` starts -- here, one in a WAIT, which gives the work process up --
   resumes on the other request's entities, and the shim answers its caller
   with the other request's response. No branch and no issue yet. The fix
   is small: a local `DATA li_server TYPE REF TO if_http_server` in `run`,
   created per call and passed to `request` and `response` as a parameter
   (both are private, so nothing outside changes). Workaround here: the
   WAIT's roll-out and roll-in in `tools/osd-dialog-step.mjs` save and
   restore the static server and its two entities; `test/dialog-step-icf.mjs`
   fails without it. When the fix is in the pinned shim, the roll-out's
   shim half goes and the test stays.

9. **`get-run-time-wrap`: GET RUN TIME does not wrap at 2^31** --
   `ANOMALY-2026-10-10-get-run-time-wrap`. Measured on an ABAP 7.5x system:
   the kernel returns non-negative elapsed microseconds that wrap at `2^31`
   (minute 35 `2100029253`, minute 36 `12546088`, then `72546692`). The
   runtime assigns the unwrapped count, and `Integer.set` does not
   range-check, so a `TYPE i` field holds an out-of-range value after about
   35.8 minutes. The fix keeps `context.runTime.last` unwrapped for the
   backward-clock clamp and wraps only at assignment
   (`packages/runtime/src/statements/get_run_time.ts`); two fake-clock tests
   (`performance.now` and `Date.now`) fail without it. Sent as
   abaplint/transpiler#1990; next: record the containing release.

The five below came out of HANA milestone 2 (#942, `docs/hana-milestone-2.md`).
Each sits in `ANORMALIES.md` under its name; none has an issue or a PR yet.

10. **open-abap-odata: the default association set** --
    `ANOMALY-2026-11-14-default-association-set`. `create_association`
    ignores `iv_def_assoc_set` (the interface's default is `abap_true`), so a
    SEGW-generated MPC answers `$metadata` with no AssociationSet; and a
    function import that names only its return entity type gets no
    `EntitySet`. Carried here as the overlay
    `src/gateway/compat/zcl_oao_model.clas.abap` (compat README); test
    `ZCL_OSD_H5X_TEST` default_sets_in_metadata. One small PR to
    open-abap-odata; then drop the overlay and its exclusion.

11. **express-icf-shim / open-abap-core: an encoded form-field name** --
    `ANOMALY-2026-11-14-form-field-names-encoded`. `get_form_fields_cs`
    leaves `%24top` undecoded, so the option is ignored without a word.
    Workaround: `ZCL_STG_URL=>OPTION` decodes a well-formed name; test
    `ZCL_OSD_H5X_TEST` encoded_option_names. Needs an issue first: which of
    the two builds the fields decides where the fix goes.

Three more from HANA milestone 3 (B4, the `$metadata` annotations of the
SEGW sample; measured against the system's own `$metadata`, the EN and the
DE capture). The overlays sit in `src/gateway/compat/` with their library
copies excluded from both pulls (abap_transpile.json, abaplint.jsonc).

15. **open-abap-odata: labels from the text pool** --
    `ANOMALY-2026-11-14-textpool-absent`. `set_label_from_text_element`
    stores the symbol and the writer prints the ABAP field name. The PR:
    a small provider interface in the library (`get_text( container,
    symbol, language )`), the writer asking it in `sy-langu` and writing
    no label when it answers nothing, never the field name; this
    repository's provider is `ZCL_OSD_TEXTPOOL` over the build-time
    registry (tools/osd-textpool-registry.mjs), which stays here. Also a
    parameter's label (SEGW calls the same method on it). Test here:
    `ZCL_OSD_H5X_TEST` ltcl_annotations.

16. **open-abap-odata: bind_structure from the dictionary, the writer as
    the model says** -- `ANOMALY-2026-11-14-bind-structure-ddic`. Three
    PRs, in this order: (a) `sap:unicode` only from the model's
    annotation (no hard-coded `false`); (b) `sap:unit` and derived
    `sap:semantics` from a field-information provider bind_structure
    asks (data element, type, reference field per component; this
    repository's is `ZCL_OSD_DDIC_INFO` over tools/osd-ddic-info-registry.mjs);
    (c) the label of the data element through the same provider, and no
    `sap:display-format="Date"` derived for a DATS component (the system
    writes none; the date mark stays for a V4 facade). Consumer impact to
    state in the PR: a model that set no label loses the field-name label,
    and a Fiori V2 app shows a SEGW-path date with its time unless the
    model annotates `display-format` itself.

17. **abaplint/transpiler: SET LOCALE LANGUAGE** --
    `ANOMALY-2026-11-14-set-locale-noop`. The runtime's `setLocale` is
    empty; worked around in the dispatcher by setting `sy-langu` for the
    request. Needs an issue first (what else the statement should switch
    is the question).

12. **transpiler: a class constructor's targets at load** --
    `ANOMALY-2026-11-14-cctor-load-order`. Fixed in the pin
    `local/osd-build-4j` (28a3c53a, #941), cycle-free; a branch inside
    abaplint/transpiler from those commits, after a critic pass.

13. **transpiler runtime: a DEC 21,7 value formats through a double** --
    `ANOMALY-2026-11-14-packed-21-format`. Needs an issue with the
    one-line reproducer from the entry. Workaround: `ZCL_STG_JSON=>VALUE`
    rounds a packed timestamp to whole seconds.

14. **abaplint: SELECT SINGLE with CONNECTION before FROM** --
    `ANOMALY-2026-11-14-select-single-connection`. Needs an issue in
    abaplint/abaplint (no push rights there, see `npm run parked`).
    Workaround: the closure's structure pre-pass
    (`tools/hana-closure-stubs.mjs` structureStubs).

The three below came out of milestone 3 B5.2 (#952, search helps).

15. **open-abap-odata: search helps over a join** --
    `ANOMALY-2026-11-14-shlp-joins`. `zcl_oao_shlp_ddic` selects from one
    table: no text table, no help view, a list field only when exported, no
    default values. Carried here as the overlay
    `src/gateway/compat/zcl_oao_shlp_ddic.clas.abap` with the new
    `zif_oao_shlp_source` (compat README); the generator that writes the
    joins stays here (`tools/segw-shlp.mjs`). Proof: the generated join
    classes frozen in `test/hana-m2`, `ZCL_OSD_H5X_TEST` ltcl_value_help,
    `ZCL_STG_SHLP_TEST`. One small PR to open-abap-odata (provider +
    interface); then drop the overlay and its exclusion.

16. **transpiler: a help view becomes a database view** --
    `ANOMALY-2026-11-14-help-view-schema`. Needs an issue (skip
    `VIEWCLASS H` in the schema). Workaround: `dropHelpViews`
    (`tools/osd-warm-order.mjs`, on every path that orders a registry).

17. **transpiler runtime: CREATE DATA ... TYPE STANDARD TABLE OF a class's
    type** -- `ANOMALY-2026-11-14-create-data-table-of-class-type`. Needs
    a reduced reproducer and an issue. Workaround: a named table type.
18. **transpiler runtime + database packages: SQL literals re-read as
    statement text** -- `ANOMALY-2026-11-14-sql-literals-statement-text`.
    Fixed in the pin `local/osd-build-4k`: `packages/runtime/src/
    sql_literals.ts` (one scan; `outsideLiterals` masks the literals for a
    rewrite), used by `expandDynamic` (no substitution or EQ rewrite inside a
    literal, a backtick literal sent single-quoted, an unassigned field
    symbol is `CX_SY_DYNAMIC_OSQL_SEMANTICS`, the `field IN` lookup linear)
    and by `select()`/`openCursor()` of database-sqlite, -pg, -hdb and
    -snowflake (a copy of the file per package, held identical by a test,
    because those packages build against the published runtime). Tests:
    `packages/runtime/test/expand_dynamic.ts`, `sql_literals.ts`,
    `test/database.ts` "literals in a dynamic WHERE are data". One small PR
    from a branch inside abaplint/transpiler after a critic pass; with it
    released, `tools/sqlite-heap-client.mjs` and `tools/postgres-client.mjs`
    drop their `select()`/`openCursor()`.

19. **transpiler: a blank-separated dynamic ORDER BY** -- `ORDER BY (lv)`
    with `lv = 'a b'` or `'a DESCENDING b'` is legal Open SQL and reached
    the database without commas. Fixed at the source in the pin
    `local/osd-build-4k` (`abap.dynamicOrderBy`, cherry-picked from the
    milestone-3 branch, tests kept). The same PR as item 18 or one beside
    it; with the pin, the host-side comma pass (#947's `tools/osd-order-by.mjs`)
    is removed, and the twin's ORDER BY tests pass through the pin alone.
    A follow-up on the same pin keeps PRIMARY KEY inside a longer list one
    item (critic of #954).

20. **transpiler: `EXPORT`/`IMPORT` TO/FROM `SHARED MEMORY` and `SHARED
    BUFFER`** -- `ANOMALY-2026-11-18-export-import-shared-memory`. **Sent
    2026-11-19: abaplint/transpiler#2134**, from the branch `shared-memory`
    inside abaplint/transpiler (`786dae56`, one commit on `main` `a64f380e`),
    after a critic pass. Both statements transpiled to a runtime
    "transpiler todo" throw for every medium, so this is a feature, not a
    defect: one store per medium in the runtime instance's context
    (`abap.context.dataClusters`), keyed by dbtab, client, area and ID,
    `IMPORT` of a missing cluster `sy-subrc` 4, every other medium
    unchanged. Upstream test `test/statements/export_import.ts`, 11 cases,
    10 failing on `main` (the 11th checks the other media still throw);
    `npm test` 3156 passing. Regression: 17 of 17 downstream repositories
    green, the performance table green (read off the bot comment's rows).
    Here `test/unit/zcl_osd_shared_memory_test`. **Merged 2026-11-19
    (`73e33f03`), released in 2.14.38.** The pin `local/osd-build-4m` is
    built on 2.14.38 and no longer carries the fork's earlier form
    (`8aafdd71` + `c2b0b584` of 4l); the other fork commits keep it a fork
    pin, not npm.

21. **transpiler: `TYPE decfloat16`** -- `ANOMALY-2026-11-18-decfloat16-type-todo`.
    **Sent 2026-11-19: abaplint/transpiler#2135**, branch `decfloat16`
    inside abaplint/transpiler (`cd22c2d3`, one commit on `a64f380e`), after
    a critic pass. Any `DATA ... TYPE decfloat16` transpiled to
    `new abap.types.typeTodoDecFloat16Type()`, which is not a constructor;
    it now runs on the runtime's `DecFloat34`. Test
    `test/types/decfloat16.ts`, 3 cases, all failing on `main` with
    `typeTodoDecFloat16Type is not a constructor`; `npm test` 3148 passing.
    Regression: 17 of 17 green, performance green. **Merged 2026-11-19
    (`5813c035`), released in 2.14.38**, with #2244 rounding to 16 digits;
    `local/osd-build-4m` drops the fork's `e9958256` + `b2998ada`.

22. **open-abap-core and open-abap-gui under abaplint 2.120.118** -- no PR
    needed: Lars fixed upstream what the parser and the runtime's `CLEAR` of
    a `TABLES` parameter broke there (open-abap-core #1331, #1334, #1336,
    #1337, #1345, including `CONVERT_ITF_TO_STREAM_TEXT`'s
    `CLEAR text_stream[]`; open-abap/open-abap-gui#231). The pins moved onto
    upstream: `oisee/open-abap-core` `osd/core-rebase-2026-11-25` is
    upstream main plus the three commits open-steamgate still holds
    (`GENERAL_GET_RANDOM_INT`, `INT4_TABLE`, the `W3MI_LOADER` hook) and
    `hex_digit` of a named `x LENGTH 1` (gogen compiles no generic `x`), which
    stay candidates; `oisee/open-abap-gui` keeps its base (upstream's
    converter is TypeScript now) with #231 picked and the other findings
    fixed as upstream fixed them, so nothing of it is a candidate either.

## What we carry, and what we wait for

*Decided 2026-09-17, after the performance work made the question real.*

Divergence from the published packages comes in two kinds, and they are held
oppositely.

**A defect fix is carried.** Without it this tree computes a different answer
from a system, and the oracle says so every time the demo runs. So it lives on
`local/osd-build`, pinned by commit in the preview workflow, with an entry in
`ANORMALIES.md` and a DEBT entry saying the tree is built by something that is
not published. `npm run parked` complains in both directions, and
`npm run transpiler:published` drops the link when a release carries
everything. That machinery exists and works; nothing changes here.

**A performance change is not carried.** It is sent, and it arrives when a
release carries it. Four reasons, in order of weight:

1. **Nothing is broken while we wait.** The only cost of waiting is speed, and
   speed that nobody else can reproduce is not worth a fork.
2. **A patch that lives only here makes our numbers untrue for everyone else.**
   The whole value of this work is that a maintainer can check it. "Fast here"
   would say nothing about what someone who installs the package gets, and the
   demo's frame rate would stop being evidence about anything but us.
3. **Every pin is a standing tax**: rebase it, re-measure it and re-pin it on
   each release, forever, and the public deployment becomes a build nobody can
   reproduce. We already pay this for the defect fixes, which is enough.
4. **It buys no correctness.** A performance change that alters one frame is
   wrong by definition, so carrying it cannot protect the oracle — the thing
   the defect pins exist to protect.

**The exception, and it is the shape to aim for: a flag.** The code-generation
work is built behind a feature flag defaulted off (`feature_flags.ts` in the
transpiler, an empty mechanism waiting for its first user). Once that is
released, turning it on here is a setting, not a fork: upstream owns the code,
we own the choice, and it leaves our accounting entirely. Anything upstream is
willing to offer as a flag should be taken as a flag rather than as a patch.

**Why this was written down.** The critic pass on 2026-09-17 found that the
build the performance numbers were measured on had been described as "2.13.87
plus the three merged fixes" when it was in fact a local branch carrying a
fourth, unmerged one, and the baseline was not `main` either. The files on the
hot path turned out to be identical, so the measurements held, but the
description did not — and that is the ordinary failure mode of a carried
patch. The more we carry, the less any sentence about "the build" means.

So each item in the queue below says which kind it is, and the performance ones
say **wait for a release**.

## The performance track, in sending order

*Opened 2026-09-17 after `docs/demo-profile.md` and `docs/abap-hot-code.md`.*

These are not defects and they have no `ANORMALIES.md` entry, because
nothing here computes a different answer from a real kernel — the answers
are right and they are slow. `npm run parked` therefore does not claim
these branches, so **this section is their only record**, and each branch
carries its reason in `git branch --edit-description`, which is the rule
for a branch that is not a defect fix.

What they are all about: an ABAP arithmetic operation costs about 30 ns
here and about 1 ns in plain JavaScript, and one frame of the demo's
`sdf_blobs` performs 1.97 million of them. The cost is the protocol around
the operation — dispatch on the operand types, parse each operand, allocate
the result — and not the arithmetic. Seven of twenty-six demo scenes miss
their frame budget because of it.

**The order below is by gain against risk, and it is deliberately not the
order somebody would guess.** Each item goes as one issue with the
measurement, then one pull request with one commit, one test and one number,
through the critic gate (CLAUDE.md).

| # | what | where | gain, measured | state |
| --- | --- | --- | --- | --- |
| 0 | the anchor issue: the arithmetic protocol dominates compute-bound ABAP, with the profile and the ranked list | an issue only, `abaplint/transpiler` | — | to write |
| 1 | a constant `Character` remembers the number it parses to | runtime, `types/character.ts` + `operators/_parse.ts` | -35 to -77 % on the operation, below the measurement threshold on the demo | **sent 2026-09-18: issue #1872, PR #1873**, branch `perf/character-constant-numeric` 40cab17c — see below |
| 2 | a `Float`/`Float` branch in `add`/`minus`/`multiply` | runtime, `operators/` | -4 to -13 % of a heavy frame's CPU | **sent 2026-09-17: issue #1868, PR #1869**, branch `perf/float-fast-path` 111d6a93 |
| 3 | plain JavaScript arithmetic when the operand types are proven | transpiler, `expressions/source.ts` + a new type walk, behind a feature flag | 110-200 ns to about 1 | in progress |
| 4 | a synchronous `LOOP AT` when the body contains no `await` | runtime + codegen | 172–349 ns a row to 74 | design question, unwritten |
| 5 | method inlining | transpiler | 123 ns to 67, and 206 to 67 for a structure return | unwritten, high risk |

## A candidate for abaplint, not yet drafted: the AMDP body comes out four times

Found 2026-09-18 while building the AMDP scissors (`docs/amdp-in-hana.md`),
researched against abaplint's own source rather than guessed at.

**The observation.** A class with one AMDP method whose body is twenty lines
yields **four** `NativeSQL` statements, three of them starting on the same
row and nesting inside one another:

```
1  rows 31-46   DECLARE lv_i INTEGER; ...
2  rows 47-47   SELECT lv_i AS id,
3  rows 31-47   DECLARE lv_i INTEGER; ...
4  rows 31-50   DECLARE lv_i INTEGER; ...
```

Concatenating their tokens does not reproduce the source, and neither does
taking the longest: the concatenation drops the original line breaks, and
SQLScript has `--` line comments, so a lost newline changes what is
commented out.

**Why, from the source.** `3_structures/structures/method.ts` says a method
body is `opt(alt(sub(Body), star(sta(NativeSQL))))`. `NativeSQL` is a marker
whose matcher deliberately throws — it is assigned out of band, by
`statement_parser.ts`'s `nativeSQL()` pass, which runs **after**
`lazyUnknown()`. That second pass is an editor-typing recovery heuristic: for
a statement that failed to categorise, it tries every row boundary as a split
point and keeps the first suffix that categorises as something. Neither pass
promises the statements it emits are non-overlapping or exhaustive. So the
AMDP path is not a dedicated extraction mechanism; it is two general-purpose
salvage heuristics meeting.

**The proposal, if it is sent**: make an AMDP body become exactly **one**
`NativeSQL` statement covering the whole span, carved out before
`lazyUnknown` can touch it — which is what `star(sta(NativeSQL))` already
implies in practice, and which makes the built-in path give what every
consumer is otherwise forced to compute from source positions by hand. Ask
in the same breath whether `EXEC SQL ... ENDEXEC` has the same shape, since
`nativeSQL()` handles both.

**It is not a rediscovery.** The three related issues — #743, #1777 and the
still-open #3486 — are all about making the *linter* stop complaining about
AMDP bodies. None is about a consumer needing the verbatim body or a
non-overlapping statement list.

**What is not proven.** The mechanism-level explanation is solid; the exact
step-by-step reconstruction of those four ranges is not, because it was read
rather than traced with an instrumented run. An issue should state the
observation and let the maintainer pick the fix, rather than assert the
internal cause.

Unsent, undrafted, and it goes through the critic like everything else.

Notes that belong with them, so they are not rediscovered:

**Item 1, re-measured against 2.13.89 and sent, 2026-09-18** (issue #1872,
PR #1873; the calculation-type issue that came out of the same work is #1871,
and the A4H measurement behind it is a comment on #1866).** The
branch was held because its numbers were taken against a base that has since
moved; it was rebased (`a284eb2f` -> `40cab17c`, onto `2f011157` = 2.13.89,
which already carries the Float/Float fast path of #1869) and measured again.
Host: i7-10700K, node 26, `intel_pstate` on `powersave` — which boosts itself,
4.9 GHz measured under load, so no governor change was needed. Protocol: the
12 cases of `.local/measure/drafts/bench-operators.mjs`, 2 runtimes, 5 sweeps
interleaved with the column order reversed on alternate sweeps. Both builds
were verified **by content**, not by the build exiting 0: `getNumeric` absent
from the base's built `character.js` and present in the branch's, and the
float fast path present in the base's `add.js`. The first build of the branch
was a false green — `tsc` returned 0 and left yesterday's `build/` in place.

| operation | base 2.13.89 | + cache | delta | five sweeps |
| --- | ---: | ---: | ---: | --- |
| `divide(const '0.5', Float)` | 97.32 ns | 22.37 ns | **-77.0 %** | -77.0 -76.3 -76.8 -77.6 -76.6 |
| `multiply(const '0.5', Float)` | 148.48 ns | 75.71 ns | **-49.0 %** | -49.3 -50.0 -48.0 -49.0 -49.1 |
| `add(const '0.5', Float)` | 170.49 ns | 99.60 ns | **-41.6 %** | -41.9 -42.0 -41.6 -40.8 -41.9 |
| `multiply(Float, const '0.5')` | 224.05 ns | 144.90 ns | **-35.3 %** | -35.0 -36.3 -34.8 -35.7 -34.7 |
| `multiply(Character '0.5', Float)`, not a constant | 149.17 ns | 128.84 ns | -13.6 % | -13.4 -14.2 -13.0 -14.0 -15.0 |
| `Float`/`Float` and `Integer`/`Integer` | 9-21 ns | unchanged | -4.0 to +2.9 % | noise |

The absolute nanoseconds are about twice those in
`.local/measure/drafts/measurement.txt` because that table was taken on the
workstation; ratios within one machine are what compare.

**The verdict, and the wording matters.** Per operation the win is large and
reproducible — a spread of fractions of a percent across five sweeps, against
a harness whose own noise is about 10 %. At whole-program level the
contribution is **below our measurement threshold**, which is not the same
claim as "a few percent": the `both/fast` column of `measurement.txt` cannot
carry that claim, because it measured the *head* placement that was rejected
(its own first line says the shape "is NOT on the branch") and because its
per-round CPU wanders 5890-9890 ms on one scene while the signs disagree
between scenes. `docs/abap-hot-code.md` already states the rule: no absolute
number here may be quoted finer than half a significant figure.

It was parked under Alice's rule of that morning — pure performance without a
roughly twofold win waits, only defect fixes go up — and then **unparked by
her the same day**: "гони в апстрим то что готово и что улучшит
производительность и радость". So it goes, through the critic gate. The
argument that supports sending it, which was recorded while it was still the
counter-argument:
**ABAP 7.02 has no float literal**, so `lv_x = lv_y * '0.5'` is how real code
writes any percentage or rounding, while the author of our demo scenes hoisted
those constants into `DATA` by hand — exactly what the cache makes
unnecessary. Our corpus therefore *understates* the share of constant-literal
arithmetic. It stays weak as an argument because real business ABAP is bound
by the database, not by arithmetic; the niche is compute-bound code.



**What measuring changed about items 1 and 2, 2026-09-17.** Both were
written, tested and measured before either was sent, and both moved:

- The fast path went **under** the integer branch, not at the head of it,
  and `divide` was left alone. At the head it is worth more on the demo
  (-13.9 % against -13.3 % on `sdf_blobs`, -19.2 against -9.8 on
  `quat_julia`) and it takes integer division from 10.4 ns to 16.4, three
  runs running, which is more than two `instanceof` can explain and looks
  like an inlining threshold. A change that speeds up floats by slowing
  integer division is not one to offer, so the branch carries the
  placement that regresses nothing, and the issue puts both columns in
  front of Lars, whose weighting of integer division is not ours to
  assume.
- Item 1 is large per operation (a constant literal operand costs 45 %
  less) and **invisible on the demo, inside the noise**. The draft says so
  rather than hiding it. The reason is the more interesting finding: the
  operators convert a character operand with
  `Number.isInteger(Number(left.get()))` before they ever reach `parse()`,
  so the cache removes the second conversion of two.
- Found while measuring, not implemented and **not yet measured on a
  system**: the calculation type of `lv_i * '2'` depends on which side the
  literal is on (`Integer` on the left, `Float` on the right, and `minus`
  the same), and `divide` has no character branch at all. Until it is
  measured on A4H it is a candidate in an issue and not an anomaly,
  because this project measures a discrepancy before it claims one.

- **Item 1 and item 3 overlap on purpose.** Folding `'0.5'` in code
  generation makes it disappear; caching it in the runtime makes it cheap
  for every caller that the code generator cannot prove. Both are worth
  having, and item 1 is five lines against a project.
- **Item 3's admission rule is the whole safety argument**: every operand
  a `Float`, an `Integer` or a numeric literal, and at least one proven
  `Float`. One proven float means the calculation-type flag can never
  produce an `Integer` result, which is what makes the rest fall away.
  Packed, `decfloat34`, `int8`, hex, date, time and character variables
  are refused.
- **`Integer.set(number)` and `Integer.set(Float)` are equivalent**, both
  through `roundHalfAwayFromZero`, and the integer overflow check below
  them is commented out. Read in the source, 2026-09-17. That is what makes
  handing `.set()` a raw number safe, and it is the fact item 3 rests on.
- **What is deliberately not in this list**, so that nobody proposes it
  again: a lookup table for a function over a proven range, and any
  "fast maths" library. Measured, not argued — `sin( )` is 19 ns and a
  `READ TABLE INDEX` lookup is 71, so a table is four times slower than the
  function it would replace, and no table equals `Math.sin` at the sampled
  points, which breaks the frame comparison against a real system. For the
  same reason, hand-expanding `**` into multiplications is a pessimisation:
  `** 8` is 44 ns and three multiplies are 83.
- **The demo's own ABAP is not part of this stream.** Rewriting three
  scenes by the same rules took 28 to 38 % off a frame with every frame
  identical, which measures the ceiling a compiler could reach on its own.
  It is a measurement, not a patch to send (Alice, 2026-09-17).

**What went out first, and why only that** (2026-09-17). Item 2 alone, as
issue [#1868](https://github.com/abaplint/transpiler/issues/1868) and PR
[#1869](https://github.com/abaplint/transpiler/pull/1869), from a branch
inside the repository so **Regression** runs — confirmed in the checks, beside
build and transpiler, which is the thing a fork's branch never gets. Five
drafts were ready and four were held on purpose: a spare-time maintainer given
five items in one evening answers none of them, and item 2's issue ends on a
question (which placement of the branch he wants) whose answer changes what
the rest should say. Also ready and waiting: an issue for the packed
calculation type with the A4H measurement, and a comment giving #1866 the
measurement it has never had.

Every item's evidence is `docs/demo-profile.md` (where the time goes) and
`docs/abap-hot-code.md` (what each idiom costs, and what the code generator
would have to know). The oracle — `tools/o4d-record.mjs --compare` against a
recording made with the unmodified transpiler — is the acceptance test for
all of them: a performance change that alters one frame is wrong.

## Not for sending

- `fix/conv-builtin-type` — superseded 2026-09-14, split into the branches
  above. Delete.
- `fix/silent-zero-output` — a new failure mode with false positives on
  existing tests; parked on purpose, not a PR.
- `docs/client-handling` — merged upstream as #1850 already. Delete.

## Beside the transpiler

- **`open-abap-gui`, one PR owed (2026-09-18)**: fork branch
  `html-viewer-sapevent` on `oisee/open-abap-gui`, two commits, lint and
  the 496 unit tests of that repository green, the browser spec of the
  HTML viewer example (`zcl_gg_ex_151`) green. The first commit is the
  inbound half of `sapevent` — `cl_gui_html_viewer=>dispatch_sapevent`,
  the raise, the `CNHT` type pool, the rewrite of a document's own
  `<form action="sapevent:X">` and `formaction`, the classic exceptions on
  `load_data` / `show_url` / `set_registered_events` / `set_focus` — with
  five unit tests on the round trip; the second is
  `ANOMALY-2026-09-18-html-viewer-show-url`, `show_url` of what
  `load_data` loaded. The PR would say: nothing raised `sapevent` on the
  viewer, so a handler registered on it could never fire; the scaffold
  host folds the click into its own dispatch, which is not the SAP
  contract abapGit is written against; the shape of `postdata` was
  measured against that consumer (`zcl_abapgit_gui_event`, 256-character
  lines joined respecting blanks, only the pair delimiters escaped). The
  one number nobody has measured on a frontend is the line width SAP GUI
  itself fills; it is one constant. Critic pass before sending, as for
  the rest. Self-merging there is not agreed; it is Lars's to merge.
- **`open-abap-core`, a two-line fix owed and no branch yet (2026-09-18)**:
  `ANOMALY-2026-09-18-system-uuid-window`. `cl_system_uuid`'s private
  `RANDOM` falls back to `rv_str = window.crypto.randomUUID();` when the
  imported `crypto` has no `randomUUID`, which is what webpack's
  `crypto-browserify` polyfill is, and a service worker has no `window` —
  so every `create_uuid_*` throws in the browser deployment. Read off
  `build/preview/sw.js` rather than reasoned about. The same line also
  assigns the JavaScript variable instead of calling `set( )` on it, so a
  plain page, where `window` exists, hands a raw string back where the
  caller's type is a `String`. The fix is `globalThis.crypto` and
  `rv_str.set(…)`. Not written yet because `oisee` has no write access to
  `open-abap-core` and it takes a fork (the exception the tree already
  documents); the workaround is local
  (`zcl_osd_tran_session=>new_id( )`), so nothing is blocked. Critic pass
  before sending, as for the rest.
- **`@abaplint/core`**: one owed, and it is not a table edit.
  `ANOMALY-2026-09-16-numeric-builtins-typed-integer` — `frac`, `abs`,
  `floor`, `ceil`, `trunc` and `sign` are declared with a fixed integer
  return type, and ABAP gives them the type of their argument. It is the
  last three of sixty differing frames of the demo. The return type has to
  come from the argument where the call is typed
  (`expressions/method_call_chain.ts`). Issue abaplint/abaplint#4302, filed
  2026-09-17 with the A4H measurement; the three syntax tests (`frac( f )`
  typed `f`, `abs( f )` typed `f`, `frac( i )` still `i`) sit on
  `fix/numeric-builtins-argument-type` in the fork worktree, without a fix.
  A fork PR when the fix is written.
- **`@abaplint/runtime`, two more, found by probing around it and measured
  on A4H 2026-09-17**: `ANOMALY-2026-09-16-mod-result-integer` (`MOD`
  with a float operand returns an integer; a system says 0.75) is #1860 and
  `ANOMALY-2026-09-16-integer-rounds-negative-half-to-zero` (`-0.5` to `i`
  is 0, `Math.round`; a system says −1) is #1861. Both fixed on a branch
  (`fix/mod-float-result`, `fix/integer-round-half-away`), one commit each
  with the test, runtime tests and lint green; **PRs #1863 and #1864**,
  2026-09-17, from inside the repository.
- **`@abaplint/runtime`, from the plasma scene (2026-09-17)**:
  `ANOMALY-2026-09-17-append-number-rounded` — `APPEND sin( x ) TO` a
  float table rounds every value to an integer, because `cloneRow` wraps
  a raw number as an `Integer` first. Branch `fix/append-number-float`, one commit with a
  test (`packages/runtime/test/statements/append_number.ts`), runtime
  tests and lint green; issue #1865 and **PR #1867**, 2026-09-17, after
  the critic pass Alice asked for. Cherry-picked onto `local/osd-build`.
- **`@abaplint/core`, from the mountains scene (2026-09-17)**:
  `ANOMALY-2026-09-17-character-literal-calc-type` — already fixed
  upstream by #4293 in 2.120.52; the pin was behind. `local/osd-build`
  now takes `^2.120.54` (c148d363), and the transpiler entry in
  `libs.lock.json` has to move with it. Nothing to send.
- **`@abaplint/transpiler`, from the last seven plasma frames (2026-09-17)**:
  `ANOMALY-2026-09-17-integer-division-not-rounded` — in calculation type
  `i` a system rounds every `/` to an integer before the next operation
  (`7 / 2 + 7 / 2` is 8 there, 7 here; measured on A4H). The fix needs
  the statement's calculation type, so it is the transpiler's, not the
  runtime's: put to Lars as issue #1866 with the six measured lines,
  2026-09-17. Not started.
- **How these were found**: `docs/frame-comparison.md`, the demo as an
  oracle, scene by scene.
- **The order was test, issue, fix (Alice, 2026-09-17):** the reproducers
  went first, with the A4H measurement, so the issue could say what a
  system answers; the fixes followed the same day for the two runtime
  ones. The core one (#4302) is still test-only: its fix is not a table
  edit and belongs in the syntax pass.
- **Alice's own repositories, through the packs** (`packs/*/README.md`
  says what each overlay changes): `oisee/vivid-vibes`, one line in
  `zcl_o4d_http_handler` — the megademo page asks `?image=<name>` and the
  handler serves `?img=<NAME>.PNG`, so no picture loads at the pinned
  commit. `oisee/zork-abap` needs nothing: the pack runs its HEAD as is
  (an earlier pack carried five classes from an older commit, which is why
  it looked patched). A PR to vivid-vibes once the line is reviewed; until
  then the overlay is the diff.
- **Filed as issues rather than fixed (Alice, 2026-09-17): "можно пока не
  фиксить … а пока сделать тест и завести как issue."** The tests are the
  measured contract; a fix that passes them is the PR.
- **open-abap-core**: `W3MIMETABTYPE` (#1218) and `get_source_position`
  (#1219) are merged; `SCMS_BINARY_TO_XSTRING` and the `WWWDATA_IMPORT` walk
  are in `.local/lars/open-abap-core` and still to send — a fork there, since
  `oisee` has no write access (CLAUDE.md).
- **Bun** (`oven-sh/bun`): the resolver takes a percent-encoded relative
  specifier literally (`ANOMALY-2026-09-13-bun-percent-encoded-specifier`).
  Worked around in `bin/osd.mjs`; transpiler #1841 would remove the need.
  An issue upstream is worth filing with the two-file reproducer from
  `docs/bun-spike.md` part one.
- **Node**: nothing to send. A single executable could not import a file
  outside itself on 26.3 and can on 26.9 (`docs/bun-spike.md` part four).

## The HANA line, 2026-09-19

Sent in one afternoon, in the order they block each other, and every one of
them went through the critic gate first.

- **transpiler #1877** — `execute()` never opened the LUW on the HANA client.
  `connect()` turns autocommit off, `inTransaction` is set only by the
  modifying path, and `commit()` returns at its first line while it is false,
  so `disconnect()`'s documented implicit commit never happened. One file,
  eight lines. **Before any release of `database-hdb`**: a release without it
  ships silent data loss to anyone with two connections. Invisible on one,
  including in upstream's own `test/_utils.ts:97-99`.
- **open-abap-core #1254** — the three-backend report. 819 test methods:
  SQLite 819/0/0, DuckDB 816/3/0, HANA 815/3/1. Declines separated from
  failures. The one red is diagnosed and it is theirs: `get_location` takes
  the stack frame after the last `cl_abap_unit_assert`, and on HANA the
  awaits reach the event loop, so V8 drops the async user frame and the test
  sees the tick queue. Logs at `.local/hana-report/run-{sqlite,duckdb,hana}.log`
  — keep them, the next session must not re-derive the table.
- **transpiler #1878** — a question, not a PR: `execute()` returns `void`, so
  a procedure's rows have nowhere to go, and nothing in the interface binds a
  parameter. ADBC in open-abap-core is the same gap in their own ecosystem
  (`set_param`, `execute_procedure` are `ASSERT 1 = 'not supported'`). Four
  options for where AMDP support could live; B (the seam only) is the one
  answerable without any AMDP opinion.

**What the critic caught, because the value of the gate is in the misses.**
Two drafts, ten must-fixes between them, and the four that mattered were all
the same kind — a claim I believed because I had not gone to look:

1. "there is no native channel" — `execute()` is one, and our own
   `docs/db-seam-native.md` already said so
2. "the parse is already there, only the emit is missing" — written for a
   repository whose sister tracker holds **our own** open issue saying the
   parse loses colons (abaplint#4307, PR #4312)
3. "one file different between the three runs" — the generated runner was
   patched too, and Lars would have diffed it in ten seconds
4. the one red reported as having no cause — the critic reproduced and
   diagnosed it in five minutes

And one number was cut for being second-hand: a colleague's measurement of
our own suite, which neither the author nor the critic had run. Unverifiable
and about us, not about them.

## Local int8 byte conversion fix (2026-10-03)

`ANOMALY-2026-10-03-int8-hex-conversion` is fixed on
`fix/int8-hex-conversion` in `.local/transpiler`, based on its `main`.
The runtime keeps the low bytes of an int8 assigned to x, zero-pads long
byte targets on the left, decodes the last eight source bytes signed and
converts i/int8 to xstring using the measured source width and minimal-byte
rules. Fixed-length i byte conversions already match and remain unchanged.
The upstream runtime tests include both Hex implementations; OSG's two
oracle classes run through `test/osgjs-int8.mjs`, pending until the pinned
runtime carries the fix (`OSD_INT8_UPSTREAM=1` verifies a local build).
The unsent issue/PR draft is `.local/jsint8-upstream.md`. Nothing is pushed
or sent as part of this task.

Proof: upstream 192 runtime passes (154 new; red proof 119 pass / 35 fail),
99 affected ABAP passes / 4 existing pending, lint; OSG int8 10/10 and all
26 supplied xstring conversion methods. The additional comparison methods
in inbox 007 still fail 5/7; those operators are outside this fix. Validation
uses core 2.120.64 because 2.120.65 changes a CREATE DATA operand node.
The OSG proof used a disposable dependency copy; the original shared local
2.13.93 dependencies were preserved.

## EML lowering for the transpiler (2026-11-08, RAP R2a)

Not an anomaly: a gap. `@abaplint/transpiler` parses `MODIFY ENTITIES`,
`READ ENTITIES`, `COMMIT ENTITIES` and `ROLLBACK ENTITIES` (abaplint, v754
and OpenABAP) and emits `throw new Error("ModifyEntities, not supported,
transpiler")` for the first two and nothing for the last two (`Statement
CommitEntities not supported`). The patch on branch `rap-eml` of the job's
own clone of `abaplint/transpiler` (`transpiler-rap-eml.patch` beside it;
nothing pushed) lowers the four statements onto a kernel class,
`KERNEL_RAP_EML`, in the convention `CALL TRANSFORMATION`, `AUTHORITY-CHECK`
and `SCAN` already use: a guard, then one call per operation with the names
as strings and the tables and targets as they are
([rap-eml.md](rap-eml.md), "The calling convention"). The kernel class is
this repository's `src/rap/kernel_rap_eml`; the transpiler ships none, as
it ships none of the others.

Files: `packages/transpiler/src/statements/_eml.ts` (walker over the flat
statement, shared), `modify_entities.ts`, `read_entities.ts`, new
`commit_entities.ts` and `rollback_entities.ts`, `index.ts`. Tests:
`packages/transpiler/test/single_statements.ts` (the emitted code for
fourteen forms, the two existing EML expectations replaced), and
`test/statements/eml.ts` at the root (a fake kernel class records what the
running statements hand it: names, tables, targets, sy-subrc). Not lowered,
said at run time with the addition's name: `OPERATIONS`, `BY` (deep EML),
`RELATING TO`, `AUGMENTING`, `LINK`, `READ ... EXECUTE`, `IN SIMULATION
MODE`.

Beside it, **needs an issue in abaplint/abaplint**:
`ANOMALY-2026-11-08-eml-inline-target-void`, an inline `DATA( )` target of
an EML statement is typed void instead of from the BDEF, so the transpiler
can declare nothing for it; the lowering requires declared targets and the
draft PR says so.

Sending: a branch inside `abaplint/transpiler` (the regression workflow
rule), after the critic reads the draft against the diff; the draft PR text
is `transpiler-rap-eml-PR.md` in the job folder. Merged as #2049
(`62931245`); the pin carries it since `local/osd-build-4c`
([transpiler-pin-4.md](transpiler-pin-4.md)) and
`src/rap_demo/zcl_rap_note_eml` is no longer excluded from the build.

## open-abap-odata -- the /IWBEP/ members the SEGW sample calls (H5x-3)

The pinned open-abap-odata (`bd9f1fb`) lacks six members the SEGW sample
service calls (framework-gaps.json of bed run 18 -- private evidence; the
stub messages in the dumped DPC_EXT name each one). The change sits in the
`.local/lars/open-abap-odata` working tree on branch
`feat/iwbep-members-h5x3` (from `bd9f1fb`) as three commits, one per member
group, one small PR each, and is proven here first: the overlays under
`src/gateway/compat/` carry the same text with the lib copies excluded from
both pulls (abap_transpile.json, abaplint.jsonc), and this repository's
unit and wire tests are the proof. The clone's own lint was run in the
clone before anything is drafted. Sending is gated by the critic
(CLAUDE.md), like every upstream PR.

| PR (to send) | objects | proof here |
| --- | --- | --- |
| request context: navigation path + function import | `/IWBEP/IF_MGW_REQ_FUNC_IMPORT` (get_function_import_name, get_converted_parameters exporting `es_parameter_values`), `/IWBEP/IF_MGW_REQ_ENTITY` + `/IWBEP/IF_MGW_REQ_ENTITYSET` (get_navigation_path returning the technical navigation table), the new DDIC `/IWBEP/S_MGW_TECH_NAVI` + `/IWBEP/T_MGW_TECH_NAVI`, `zcl_oao_request_context`, `/IWBEP/CL_MGW_REQUEST`, `/IWBEP/CL_SB_GEN_READ_AFTR_CRT` | `src/gateway/zcl_stg_request_context.clas.testclasses.abap` (both facets' getter over a two-step path: navigation property, source and target entity type per row; name + converted parameters); the sample's call sites live in the private framework-gaps.json |
| message container | `/IWBEP/IF_MGW_CONTEXT` (get_message_container), `/IWBEP/IF_MESSAGE_CONTAINER` (add_message: type, id, number, text, v1-v4, error category, leading flag, entity type, key table, response-header switch, message target -- all but the type optional; [SAP Help Portal, `/IWBEP/IF_MESSAGE_CONTAINER`, Method ADD_MESSAGE](https://help.sap.com/saphelp_gateway20sp12/helpdata/en/25/21aecce9db435daaea433071ff7d94/content.htm)), `zcl_oao_context`, `zcl_oao_msg_container` | `src/gateway/compat/zcl_oao_msg_container.clas.testclasses.abap`; the demo DPC's container use and the wire test in `test/mocha.mjs` (innererror.errordetails over the wire) |
| changeset structures | `/IWBEP/IF_MGW_APPL_SRV_RUNTIME`: `content_id` / `content_id_ref` on `ty_s_changeset_request` and `ty_s_changeset_response`, `content_id_ref` on `ty_s_operation_info` | the `ltcl_changeset_types` unit test beside the request context |

The changeset PR adds **types only**. Nothing in this runtime fills
`content_id` / `content_id_ref`: `zcl_stg_batch` reads a part's
Content-ID (the V4 facade answers with it) but does not pass it into
`ty_s_changeset_request`, `ty_s_changeset_response` or
`ty_s_operation_info`, and nothing calls `CHANGESET_BEGIN` with operation
info. The PR text must say so and must not read as $batch Content-ID
referencing through the changeset API; `ltcl_changeset_types` is a compile
check of the fields and nothing more.

Fix round 2 (critic of #935) moved two shapes to the contract and widened
one signature; the lib branch carries them as two `fixup!` commits on top
of the three, to be squashed into their PRs (request context, message
container) before anything is sent:

- `get_converted_parameters` exports `es_parameter_values` (the contract
  name; the sample calls it so), not `es_parameters`;
- `get_navigation_path` returns `/IWBEP/T_MGW_TECH_NAVI` (row
  `/IWBEP/S_MGW_TECH_NAVI`: `nav_prop`, `key`, `key_tab` of
  `/IWBEP/T_MGW_TECH_PAIRS`, `target_entity_type`, `multiplicity`,
  `source_entity_type`, `is_containment_navigation`) on both facets, the
  technical navigation path the [SAP Help Portal page of the request
  interface](https://help.sap.com/saphelp_gateway20sp12/helpdata/en/88/1733b1d5fd42d7a732bc405d1ed67b/content.htm)
  documents for `GET_NAVIGATION_PATH`. The field names are the contract
  the sample reads (no public page lists the structure's fields); the
  contract's object-reference field `key_converter` is left out -- the
  serializer would need a reference-typed DDIC field, and no caller here
  reads it;
- `add_message` gains the documented optional parameters.

When the PRs land and the pin moves, the overlays and both exclusions go
(`src/gateway/compat/README.md`).
