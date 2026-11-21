# The RAP flight reference scenario as a pack: what runs, what is refused

`packs/rap-flight` fetches SAP's public, Apache-2.0
[abap-platform-refscen-flight](https://github.com/SAP-samples/abap-platform-refscen-flight)
at commit `5353cbeb013a3a2fbd7f1ba6be89e54f68cfe22c` of its
`ABAP-platform-2025` branch, the newest platform branch that carries the
managed, unmanaged and draft scenarios side by side. The pack keeps the
**managed** scenario and what it reads: the reuse layer (agencies,
carriers, supplements, status tables, the value-help views), the read-only
views, and the legacy base (the tables the managed data generator copies
from, and the data generator). The other scenarios are excluded by pattern,
each pattern with its reason in the manifest (`_exclude_why`).

This document is the measurement: every object of the kept folders, by
type, against the generators and the transpiler as they are on `main`
(R0 `tools/rap/bdef-parse.mjs`, R1/R2 `tools/rap/bdef-gen.mjs` and
`src/rap/`, `tools/cds2ddic.mjs`), and the walls ranked by how many objects
each one blocks -- the input for the draft and EML work. Nothing here was
measured on a system; the oracle for "what SAP does" is the source itself.

How it was measured, so it can be re-measured:
`node tools/rap-flight/classify.mjs` does all of it -- fetches the pinned
commit's `src/` with no exclude list into `.local/rap-flight-classify/`,
counts the four other scenarios off that clone, classifies every object of
the kept folders with abaplint (the build's libraries and the pack's `src/`
as dependencies, the issue list taken per object: a parser error first, else
a syntax or unknown-type issue, else clean), runs `bdef-gen.mjs`'s own
`generate()` per BDEF for the first wall, and `cds2ddic.mjs`'s own
`parseDDLS()` per view for the skip reason. The tables below are its output;
the one column that stays hand-written is the BDEF table's "also in it", a
reading of each definition. The cold build (`npm run transpile`) over the
final exclude list is the last column of the story and is re-run by every
CI build.

## The scenario, by object type (managed + reuse + readonly + legacy)

| type | objects | lint-clean | refused (parser) | needs a feature or an object | note |
| --- | ---: | ---: | ---: | ---: | --- |
| clas | 29 | 5 | 12 | 12 | 9 behavior pools, 5 test consumers, 2 data generators, the legacy BO, the AMDP class, exceptions, messages |
| intf | 2 | 2 | 0 | 0 | the BAdI interface, the legacy interface |
| fugr | 2 | 2 | 0 | 0 | the legacy API, the managed scenario's update-task modules |
| bdef | 15 | 15 (abaplint) | 0 | **15 (bdef-gen)** | see the next table |
| ddls | 64 | 64 (abaplint) | 0 | **26 (cds2ddic)** | 38 generate, see below |
| ddlx | 7 | 7 | 0 | 0 | metadata extensions: parsed, nothing reads them |
| dcls | 0 | | | | (the access controls are in the excluded scenarios) |
| tabl | 51 | 51 | 0 | 0 | 9 of them name `ABP_LOCINST_LASTCHANGE_USER` (7) or `SDRAFT_UUID` (2), which the overlay's stand-ins resolve -- that is what the stand-ins are for |
| ttyp | 16 | 16 | 0 | 0 | |
| dtel | 58 | 58 | 0 | 0 | |
| doma | 39 | 39 | 0 | 0 | |
| msag | 8 | 8 | 0 | 0 | |
| nrob | 4 | 4 | 0 | 0 | number range objects: parsed; the runtime counts in memory per session |
| srvd / srvb | 8 / 8 | 8 / 8 | 0 | 0 | service definitions and bindings: parsed; R3's srvd half refuses six of the eight service definitions (the table below) and the pack fetches none of them -- the overlay serves the views through a `*.stg.yaml` of its own |
| enho / enhs | 2 / 1 | 3 | 0 | 0 | the BAdI implementation and its spot: parsed, `GET BADI` is not transpiled |
| auth / suso / enqu | 1 / 1 / 1 | 3 | 0 | 0 | |

"Lint-clean" is abaplint with the open-abap syntax version; it does not say
the transpiler runs the object, and for BDEF, DDLS and the service objects
it says only that the file parsed. The next three tables are the generators.

### The 15 behavior definitions against `bdef-gen.mjs`

Every one is refused, and the build treats a refused BDEF as a failed build,
so the manifest excludes `\.bdef\.`; the pools that implement them are
excluded with them. `tools/rap-flight/classify.mjs` runs `bdef-gen`'s own
`generate()` per BDEF and prints each refusal verbatim; the kind and the
first wall are that reading, refined by eye into which construct it was, and
the "also in it" column is a reading of each definition:

| BDEF | kind | first wall | also in it |
| --- | --- | --- | --- |
| `/DMO/I_TRAVEL_M` | managed, 3 entities | compositions / associations (`association _Booking { create; }`) | early numbering, `features : instance`, `factory action`, `internal action`, `with additional save` + `with unmanaged save`, `authorization master`, `lock master`, `etag master` |
| `/DMO/C_TRAVEL_PROCESSOR_M` | projection, 3 | projection (`use` needs resolution) | `use association ... { create; }` |
| `/DMO/C_TRAVEL_APPROVER_M` | projection, 1 | projection | |
| `/DMO/I_SUPPLEMENT` | managed, 2 | associations | **draft** (`with draft`, `total etag`), determine actions, early numbering |
| `/DMO/C_SUPPLEMENT` | projection, 1 | projection | draft |
| `/DMO/R_AGENCYTP` | managed, 1 | determine actions | **draft**, **late numbering**, `with additional save` |
| `/DMO/I_AGENCYTP` | interface | interface BDEF | draft |
| `/DMO/C_AGENCYTP` | projection, 1 | projection | draft |
| `/DMO/I_CARRIERSLOCKSINGLETON_S` | managed, 2 | unparsed grammar (1 statement) | **draft**, singleton, associations, determine actions |
| `/DMO/C_CARRIERSLOCKSINGLETON_S` | projection, 2 | projection | draft, singleton |
| `/DMO/ZZ_X_*` (5, extensibility chapter) | extensions | unparsed grammar (2 statements each) | events, `with draft` |

Counted over the 15: projection `use` 7, associations/compositions 6,
draft 9 (7 after the projections), determine actions 3, late numbering 1,
unparsed 6 (5 of them extensions). The managed root `/DMO/I_TRAVEL_M` is
blocked by its compositions alone before anything else is asked.

### The 8 service definitions against `bdef-gen.mjs` (the srvd half)

Main's R3 (#892) turns a service definition into a served project
(`gen/rap/<srvd>.stg.yaml` -> `stg-compile --all`), so a definition is no
longer parsed and shelved: it is served or it fails the build. The classify
script runs the same `generate()` per service definition; the verdict is
the first exposed entity the view layer cannot give the generator (in the
classify clone the views all exist, so the walls are the generator's own
skips; in the pack's fetch the projection views are not there at all, and
the readonly root skips the same way):

| SRVD | verdict |
| --- | --- |
| `/DMO/FLIGHT_LEGACY` | served (1 service) |
| `/DMO/FLIGHT_R` | Unresolved CDS entity `/DMO/C_CONNECTION_R`: unsupported CDS elements (the readonly root's association) |
| `/DMO/UI_AGENCY` | Unresolved CDS entity `/DMO/C_AGENCYTP`: no select |
| `/DMO/UI_CARRIERS_S` | Unresolved CDS entity `/DMO/C_CARRIERSLOCKSINGLETON_S`: no select |
| `/DMO/UI_SUPPLEMENT` | Unresolved CDS entity `/DMO/C_SUPPLEMENT`: no select |
| `/DMO/UI_TRAVEL_APPROVER_M` | Unresolved CDS entity `/DMO/C_TRAVEL_APPROVER_M`: no select |
| `/DMO/UI_TRAVEL_PROCESSOR_M` | Unresolved CDS entity `/DMO/C_TRAVEL_PROCESSOR_M`: no select |
| `/DMO/ZZ_X_REVIEW_UI_AGENCY` | not a service definition the reader takes (`extend service`, the extensibility chapter) |

The one that resolves, the legacy base view, is not this pack's service to
publish: the service here is the overlay's own YAML under a name of ours.
So the manifest excludes `\.srvd\.` the way it excludes `\.bdef\.` -- a
refusal is a failed build. The bindings (`srvb`) stay fetched, parsed and
unread, the way they were.

### The 64 CDS views against `cds2ddic.mjs`

38 generate (a DDIC view, a `zcl_stg_cds_*` source class, a registry
entry): every interface view over one `/dmo/` table, the value helps, the
read-only views, the three managed interface views. 26 are skipped and
said why (the classify script prints the histogram):

| skip reason | views | what it is |
| --- | ---: | --- |
| "no select" | 23 | `as projection on` (the managed and reuse consumption views and the extension views of the excluded chapter) |
| "joins are not supported yet" | 1 | `/DMO/I_CARRIERSLOCKSINGLETON_S` (the singleton root is a join) |
| "a cast this generator cannot read" | 1 | an extension view's `avg( )` |
| "no field of /DMO/AGENCY could be resolved" | 1 | `/DMO/CURRENCY_HELPER`, a view with parameters whose one element is `currency_conversion( )` -- the manifest excludes it for this reason |

The first namespaced view made the generator write `gen/cds/dmo/currhlp.view.xml`
and fail with ENOENT: a namespaced SQL view name is now written in abapGit's
form (`#dmo#currhlp`) and carried as a word inside the generated class
name (`ZCL_STG_CDS_DMO_CURRHLP`), `tools/cds-names.mjs`. Two things the
generator does not resolve for these views and should: a namespaced
association target (`association to /DMO/I_Agency`) comes back as `/`, and
`/DMO/CURRENCY_HELPER` over the stand-in `I_Currency` yields 0 fields.
Neither stops a build; both are why the overlay's service has no
navigation properties yet.

## What the build gets, and what the overlay adds

The manifest's exclude list, with the count of objects each line keeps
out of the kept folders:

| pattern | why | objects |
| --- | --- | ---: |
| `^(draft\|colldraft\|hierarchy\|unmanaged)/` | the other scenarios | draft 99, colldraft 48, hierarchy 91, unmanaged 49 files (the classify script's count) |
| `^reuse/agency/(cntry\|datgn\|rev)/` | the extensibility chapter: BDEF extensions, `RAISE ENTITY EVENT`, `WITH INDICATORS` | 3 folders, 11 BDEF/CLAS objects |
| `^reuse/agency/slogn/.*\.(clas\|ddls\|devc)\.` | the slogan extension's views and test; its append structure stays because `/dmo/agency` includes it | 6 |
| `\.bdef\.` | every BDEF is refused by `bdef-gen.mjs`, and a refusal fails the build | 15 |
| `\.srvd\.` | main's R3 (#892) serves every service definition it finds, and a refusal fails the build: six of the seven name views kept out above or a view the type generator skips, and the seventh, the legacy base view, is not this pack's service to publish -- the service here is the overlay's own YAML | 7 |
| `\.clas\.testclasses\.abap$` | ABAP Unit over `cl_abap_behv_test_environment`, `cl_cds_test_environment`, `cl_osql_test_environment`, none of which exists here | 22 files |
| `/#dmo#bp_` | the behavior pools (EML, implicit handler signatures) | 9 |
| `/#dmo#tc_` | the test consumers (EML against the business objects) | 5 |
| `/#dmo#cl_flight_amdp\.` | the AMDP currency conversion: `tools/amdp-gen.mjs` resolves no HANA type for a `/dmo/` data-element parameter (it knows built-in types and local `TYPES`, not the DDIC) | 1 |
| `/#dmo#cl_flight_legacy\.`, `/#dmo#flight_travel_api\.fugr\.` | the legacy business object (calls the AMDP class, selects from `I_Currency`) and the function group over it; the data generator needed only its price formula, inlined | 2 |
| the 12 views `cds2ddic` does not generate (10 `as projection on`, the singleton join, the parametrised currency helper) | `test/cds-check.mjs` wants every view of the tree generated, so a view the generator skips is kept out rather than left as a skip line in every build | 12 |

The overlay (`packs/rap-flight/src/`, every change marked `OSD overlay`):
four DDIC stand-ins (`ABP_LOCINST_LASTCHANGE_USER`, `SDRAFT_UUID`,
`I_CURRENCY`, `I_COUNTRYTEXT`; released SAP objects, to go to
open-abap-core and then be dropped here), copies of the two data generators
with the number-range, BAdI and statement changes the pack README lists
(six that the build refused, four more that only the first run found), a
seed class, and `zosd_rapflight.stg.yaml`: the generated views as
read-only entity sets of `ZOSD_RAPFLIGHT_SRV` over SADL.

### The transpile

The cold build over the final exclude list is green: `npm run transpile`,
2652 objects in 40.7 s, 247 of the output modules the pack's (build 5 of
the job; builds 1-4 were UNFETCHED, the AMDP refusal, the class-name and
field-less-view refusals, and two transpiler walls in the data generator).
What the pack hands the transpiler and what came out:

| type | objects | transpiled | note |
| --- | ---: | ---: | --- |
| clas | 9 | 9 | 2 overlaid data generators, the auxiliary class, the message class, 5 exceptions |
| intf | 2 | 2 | |
| fugr | 1 | 1 | the managed scenario's update-task modules |
| tabl | 49 | 49 | with the four stand-ins |
| ttyp / dtel / doma | 16 / 53 / 36 | all | |
| ddls | 35 | 35 generated by cds2ddic | DDIC view + source class + registry entry each; no navigation (namespaced association targets, above) |
| msag / nrob / ddlx / srvb / enho / enhs / auth / suso / enqu | 6 / 4 / 6 / 8 / 1 / 1 / 1 / 1 / 1 | parsed, not transpiled | no reader for any of them here; the `srvd` objects are not fetched at all (R3 serves them, above) |
| overlay: seed class, service YAML | 1 + 1 | 1 + 4 | `ZCL_OSD_RAPFLIGHT_SEED`; `ZOSD_RAPFLIGHT_SRV` MPC/DPC pairs through stg-compile |

Two transpiler walls the data generator hit after abaplint had passed it,
both now spelled out in the overlay: an inline `CORRESPONDING` inside a host
expression (`INSERT ... FROM TABLE @( CORRESPONDING #( ... ) )`, "type not
found: #"; 7 statements) and `KEY primary_key` in a table expression
("TableExpressionTranspiler: todo, SimpleName"; 1). The standalone probe
that found them in seconds instead of a build each is worth keeping in
mind: `Transpiler.run` over a registry with the tree as dependencies and
the few classes under test as main files, syntax check off.

The 247 modules, counted by what wrote them: 174 are upstream's
`/DMO/` objects (49 tables, 53 data elements, 16 table types, 35 DDIC
views, 9 classes and their 2 local includes, 6 message classes, 2
interfaces, the function group, the lock object), 35 the source classes
`cds2ddic` generated over the views, 28 the table-source classes it
generated over the tables, 6 the overlay (the seed class, the service's
four MPC/DPC classes), and 4 the DDIC stand-ins.

A third wall the green build said nothing about, because a build transpiles
and never loads what it wrote: `UPDATE dbtab FROM wa` lowers to one JS
property access per component of the row, and six of the generated
table-source classes had a component an append structure names `/dmo/...`
(`/dmo/agency`'s slogan field) or a draft table's admin include names
`%admin` -- not JavaScript, so the modules did not parse, and the runtime's
init, which imports every module, died without naming a file. Found by the
first seed capture (a host that loads the output is the test the build is
not); `cds2ddic` now updates such tables `FROM TABLE @lt_rows`, and
`test/output-parses.mjs` parses every module the build wrote with acorn,
which is how the same reading found one more broken module on `main`
(`zl3_fleet2.prog.mjs`, a top-level `RETURN`), carried there as a dated
exception.

## The seed: the scenario's own generator, run once per build

`tools/rap-flight/seed-capture.mjs` runs `ZCL_OSD_RAPFLIGHT_SEED`, which
gives `/DMO/CL_FLIGHT_DATA_GENERATOR` the console an ADT class run asks
for, inside one dialog step; what the generator wrote is then read out of
the database into `data/*.tabu.json`, abapGit's TABU form with ISO dates.
The rows are generator output and are **not tracked** (the licence decision
of 2026-11-09: derived content of the fetched upstream stays out of the
repository): a build makes them -- `build()` itself, so every path that ends
in a generation (the CLI, a first start's `ensureSourceBuild`, a store's
activation build) and a cache hit included, but only when the pack is one of
that build's selected inputs, so the core+zork web build is asked for
nothing. The build starts the capture as a child against the generation it
just made (`--no-switch` included, not the live pointer), on a database of
its own -- the child clears the inherited `STG_DB`/`STG_DB_PATH`, so a build
that runs inside a process serving a persistent DuckDB file still captures
where an inherited configuration would be refused the file -- and a capture
happens whenever the inputs the generator reads changed -- the
upstream commit, the overlay's generator copies, the seed class and the
capture itself, their digest in `data/.osd-seed.json` -- so a fresh
checkout seeds itself and a diff carries no derived rows. The generator is
random where the scenario is: the master data (agencies, airports,
connections, statuses, supplements) comes out the same every run, and the
transactional counts do not. The counts of one capture (6.3 s for the
generator):

| table | rows | | table | rows |
| --- | ---: | --- | --- | ---: |
| /dmo/airport | 47 | | /dmo/supplement, /dmo/suppl_text | 48 + 48 |
| /dmo/carrier | 16 | | /dmo/travel | 3190 |
| /dmo/connection | 20 | | /dmo/booking | 7726 |
| /dmo/flight | 40 | | /dmo/book_suppl | 13442 |
| /dmo/agency | 50 | | /dmo/travel_m | 3190 |
| /dmo/customer | 668 | | /dmo/booking_m | 7726 |
| /dmo/supplcat (+ its texts) | 4 + 4 | | /dmo/booksuppl_m | 13442 |
| the three status pairs | 4+4, 3+3, 3+3 | | **22 files** | **~11 MB** |

The size is a fact to know before leaning on it: the preview deployment
inlines every pack's seed statements into its bundle
(`scripts/build-preview.mjs`), so this pack adds ~11 MB to what a browser
downloads on a cold start. Nothing reads the three legacy transactional
tables at boot -- the service serves the managed and reuse views, and the
managed rows are seeded directly; they are carried because they are what the
generator made and `readonly/`'s views over them are the natural next
service.

Getting there took four more overlay answers after the build was green, each
found by the run and each in ANORMALIES.md: `SELECT ... FROM @itab` is not
taken (the `@` reaches the SQL), a functional call inside a table
expression's key is called **per row** here and once on a system (the plane
pick drew a fresh number per row and missed), `cl_abap_random_int` asserts
`high > low` where a system takes `min = max` (a country with one street),
and the runtime's string functions take no integer argument (the phone
number). A green build said nothing about any of them; the run is the test.

## The walls, ranked by objects blocked

Over the 29 classes, 15 BDEFs and 22 test includes of the scenario, what
each missing piece blocks (an object counts under every wall it hits, so
the columns do not add up):

| # | wall | objects | where |
| --- | --- | ---: | --- |
| 1 | **EML** (`READ ENTITIES` 12, `MODIFY ENTITIES` 10, `COMMIT ENTITIES` 2, `READ ENTITY` 2, `GET PERMISSIONS` 2, `SET LOCKS` 2, `RAISE ENTITY EVENT` 1): the transpiler emits `throw new Error("ReadEntities, not supported")` | 16 | every pool, every test consumer, two test includes |
| 2 | **RAP derived types in handlers** (`TYPE TABLE FOR` 9, `TYPE STRUCTURE FOR` 10, `TYPE RESPONSE FOR` 11, `%tky` 12, `%cid` 8, `%control` 4, `%is_draft` 7) -- R1 lowers them only for a BDEF `bdef-gen` accepts, and it accepts none here | 14 | pools, test consumers |
| 3 | **Implicit handler signatures** (`FOR VALIDATE` 8, `FOR READ` 6, `FOR GLOBAL AUTHORIZATION` 6, `FOR MODIFY` 5, `FOR NUMBERING` 4, `FOR INSTANCE FEATURES` 4, `FOR DETERMINE` 4, `FOR LOCK` 2): abaplint parses them, nothing types `keys` / `entities` / `result` | 9 | every pool |
| 4 | **Compositions and associations in a BDEF** (`association _Booking { create; }`, `use association`) | 6 BDEFs + the 3 pools of `/DMO/I_TRAVEL_M` | the managed root cannot even be typed |
| 5 | **Projection BDEFs** (`use create/update/action`) | 7 BDEFs | every consumption view |
| 6 | **Draft** (`with draft`, `total etag`, `%is_draft`, `SDRAFT_UUID`, the `_D` tables) | 7 BDEFs, 7 classes, 4 tables | the reuse BOs; the whole `draft/` scenario (72 files) waits behind it |
| 7 | **RAP test doubles** (`cl_cds_test_environment` 10, `cl_osql_test_environment` 9, `cl_abap_behv_test_environment` 2, `cl_botd_*` 2) | 12 | every ABAP Unit include of the scenario |
| 8 | **abaplint parser gaps** on 7.5x syntax: `CLASS ... DEFINITION DEFERRED FOR TESTING` (8 objects), `CORRESPONDING ... DISCARDING DUPLICATES` (7), `CORRESPONDING #( a FROM b USING k = k ... )` (1), `MAPPING %fail = DEFAULT VALUE #( )` (2), `TYPES ... WITH INDICATORS` / `UPDATE ... INDICATORS` (1), a `SWITCH` over `REDUCE ... LET` (1) | 12 | pools and the data generators; the generators are overlaid around them |
| 9 | **Released DDIC missing from open-abap-core**: `ABP_LOCINST_LASTCHANGE_USER` (7 tables), `SDRAFT_UUID` (2), the views `I_Currency` (24 files name it), `I_Country` / `I_CountryText` (25) | 9 tables + 2 classes | stand-ins in the overlay |
| 10 | **Number ranges**: `cl_numberrange_intervals` has only a no-op `create`, `cl_numberrange_runtime=>number_get` has no `quantity`; `CL_ABAP_RANDOM_INT8`, `CL_ABAP_RANDOM_FLOAT` absent | 2 | the data generators, overlaid |
| 11 | **Features / authorization / locks** (`features : instance`, `authorization master`, `lock master`, `etag master`): parsed and ignored by R2; since R4 `etag master`, instance features and early numbering run ([rap-runtime.md](rap-runtime.md), "R4"), authorization and locks are still ignored | 4 BDEFs | not a wall yet, because nothing reaches them |
| 12 | **`GET BADI` / `CALL BADI`**, BAdI definitions (ENHS) | 1 | the data generator, overlaid |
| 13 | **Late numbering** | 1 BDEF | `/DMO/R_AGENCYTP` |

Reading it as a build order: EML and the handler signatures (1-3) are one
piece of work and unblock every pool at once *given* a BDEF model, and the
BDEF model for this scenario needs compositions and projections (4-5)
before draft (6). The test doubles (7) are a separate track and gate
nothing but the tests. The parser gaps (8) are abaplint issues, each with
a one-line reproducer in the table.

## Per construct (R4)

`node tools/rap-flight/constructs.mjs` is the finer measurement R4 started
from: per BDEF of `managed/` and the reuse layer (`--all` adds the
extension chapter), every behavior construct and every handler form of its
pools, each with what the tree does with it (runs, ignored, refused; the
`SUPPORT` table in the script names the test behind each "runs"), and the
first refusal of `bdef-gen` + `rap-runtime-gen` over the BDEF, the
scenario's DDIC and the pool. R4 moved `etag master` (4 BDEFs), early
numbering and `FOR NUMBERING` (2), `features : instance` and `FOR INSTANCE
FEATURES` (2) from ignored or refused to running; the first wall of every
BDEF is unchanged, which is the measurement's point: compositions,
projections and draft are what stands between this tree and the scenario
([rap-runtime.md](rap-runtime.md), "R4").

## R7: the managed travel BO runs

Since RAP R7 ([rap-runtime.md](rap-runtime.md), "R7") the managed travel
business object is built and served without draft (V2 data requests and V4; V2 `$metadata` of the namespaced services fails on open-abap-odata's unescape, ANORMALIES):

- **Fetched as they are**: `/DMO/I_TRAVEL_M`, `/DMO/C_TRAVEL_PROCESSOR_M`
  and `/DMO/C_TRAVEL_APPROVER_M` (BDEFs) and the five consumption views of
  the managed scenario (`as projection on`, generated since R5). The
  manifest's BDEF pattern excludes every other BDEF (draft, the singleton
  grammar, the interface BDEF).
- **From the overlay**: the three behavior pools, whole (an object the
  overlay names hides every file of it upstream, so the main class and its
  XML are copies too), and the two service definitions without their value
  helps (`/DMO/I_*_StdVH`, `I_CurrencyStdVH`, `I_CountryVH` are not fetched
  or not released here). Served at `/sap/opu/odata/sap/%2FDMO%2FUI_TRAVEL_PROCESSOR_M`
  and `.../%2FDMO%2FUI_TRAVEL_APPROVER_M`, and the same under `odata4`.
- **The seed**: the seed class also fills the `I_CURRENCY` stand-in with the
  currencies the generated data uses (the validations look a currency up
  there), and `test/seed.mjs` now resolves a field typed by a data element
  through the element and its domain. Before, every `/dmo/` DATS column went
  in as ISO text cut to eight characters (`2027-06-`): no seeded date of the
  pack compared equal to anything, and the booking's `validateConnection`
  found no flight.

### R7: the travel pools

What the overlay changes in the three `locals_imp` includes, each marked
`OSD overlay` in the source. None changes what a handler decides:

| change | where | why |
| --- | --- | --- |
| `DEFINITION DEFERRED FOR TESTING` lines and the `FRIENDS` naming test classes dropped | all three | the test classes are not fetched; abaplint does not parse the statement |
| an EML target declared with its derived type, `WITH CORRESPONDING #( keys )` as a declared import table | every READ / MODIFY ENTITIES | abaplint types an inline EML target void (docs/rap-eml.md) |
| `READ ENTITIES ... BY \_assoc`, the deep `MODIFY ... CREATE BY` of `copyTravel` written as the `ZCL_OSD_RAP_EML` calls they lower to, the statement in a comment | travel, booking | `BY` is not lowered by the pinned transpiler (R5) |
| the `LINK` reads by `\_Travel` / `\_Booking` that only fill a message's `%path` not made; `%path` from the instance's own key | booking, supplement | the key of a child carries its ancestors' keys, so the result is the same |
| `CORRESPONDING ... DISCARDING DUPLICATES` as a loop into the sorted table | all three | not parsed |
| `CORRESPONDING #( ... EXCEPT ... )`, `CORRESPONDING #( DEEP ... )`, `MAPPING %fail = DEFAULT VALUE` spelled out | travel, supplement | not transpiled / not parsed |
| `USING KEY entity`, `KEY id` read by the key fields; `LOOP ... GROUP BY` and the two `REDUCE ... USING KEY` of the cba numbering as loops | travel, booking | the derived tables have no secondary keys `id` / `entity` here (the saver's `REQUEST FOR CHANGE` does have `entity`) |
| `%param = CORRESPONDING #( travel )` in the two status actions | travel | the structure move fails at run time (ANORMALIES "RAP R7: the flight travel pools") |
| `cl_numberrange_runtime=>number_get` replaced by the highest saved travel ID + 1 | travel | this runtime's class has no QUANTITY / return codes and `/DMO/TRV_M` no interval (unmeasured against a system's interval) |
| `/dmo/cl_flight_amdp=>convert_currency` replaced by 0 for an amount in another currency | travel | the AMDP class is not fetched; HANA's `CONVERT_CURRENCY` with `error_handling 'set to null'` and no rates answers null (unmeasured) |

The saver `lcl_save` is upstream's, but for its `FRIENDS` line: the
additional save of the travel and the unmanaged save of the supplements
through `/DMO/FLIGHT_BOOKSUPPL_C/U/D` run as written.

Tests: `test/rap-flight-travel.mjs` (V2 and V4: create, cba, validation
messages, update through the unmanaged save, `copyTravel`, delete with the
cascade, `acceptTravel` / `rejectTravel` through the approver projection)
and `ZCL_OSD_RAPFLIGHT_R7_TEST` (the change log in `/dmo/log_travel`, the
supplements in `/dmo/booksuppl_m`).

## R10: the supplement and agency BOs run with draft

Since RAP R10 ([rap-runtime.md](rap-runtime.md), "R10") the draft BOs of
the reuse layer are built and served with their projections: the
supplement (`/DMO/I_SUPPLEMENT`, `/DMO/C_SUPPLEMENT`, served as
`/DMO/UI_SUPPLEMENT`) and the agency (`/DMO/R_AGENCYTP`, `/DMO/C_AGENCYTP`,
served as `/DMO/UI_AGENCY`), over V4 at `/sap/opu/odata4/sap/%2FDMO%2FUI_...`
and over V2 data requests.

- **Fetched as they are**: the four BDEFs, the two service definitions and
  the two consumption views (their path elements are served since R10, the
  ones that reach `I_Country` / `I_Currency` -- table stand-ins here -- are
  not, and the build says so). `/DMO/I_AGENCYTP` (an interface BDEF) and the
  carrier singleton stay out.
- **From the overlay**: the three pools, whole. What changes in the
  `locals_imp` includes, each marked `OSD overlay`:

| change | where | why |
| --- | --- | --- |
| `DEFINITION DEFERRED FOR TESTING` and the `FRIENDS` naming test classes dropped | all three | the test classes are not fetched |
| an EML target declared with its derived type, `WITH CORRESPONDING #( keys )` as a declared import table | every READ ENTITIES | abaplint types an inline EML target void |
| `CORRESPONDING ... DISCARDING DUPLICATES` as a loop | supplement, agency validations | not parsed |
| `cl_numberrange_runtime=>number_get` replaced by the highest saved ID + 1 (the supplement's per category, over the active and the draft table) | supplement early numbering, agency `adjust_numbers` | this runtime's class has no QUANTITY / SUBOBJECT / return codes and the objects no interval (unmeasured against a system's interval) |
| `LOOP ... GROUP BY` as a loop over the categories | supplement early numbering | the numbering per category, spelled out |
| `MODIFY AUGMENTING ENTITIES ... RELATING TO` and `READ ENTITIES ... BY \_assoc ... LINK` written as the `ZCL_OSD_RAP_EML` calls they stand for; `RELATING TO` not run | supplement projection's augment | not lowered by the pinned transpiler (ANORMALIES "RAP R10") |
| `KEY draft` / `KEY cid` reads by the key fields | supplement projection's augment | the derived tables have no such secondary keys here |
| `ASSERT agency_id_max = number_range_key` dropped | agency `adjust_numbers` | no number range |

- **The seed**: the seed class also fills an `I_COUNTRY` stand-in (the
  released view `I_Country`, read by the agency's country validation) with
  the countries of the generated agencies and customers.

Tests: `test/rap-r10.mjs` (generators; V4: create a supplement draft with
its description through the augment, change it, Prepare, Activate; a
validation refusing Activate; Edit and Discard; V2 reads; an agency draft
under a preliminary key, activated to its final key; a refused agency) and
`ZCL_OSD_RAPFLIGHT_R10_TEST` (the same through the runtime with
`%is_draft`, and an active agency created and numbered late).

## R11: the agency's interface BDEF and the carrier singleton run

Since RAP R11 ([rap-runtime.md](rap-runtime.md), "R11") all ten behavior
definitions of the scenario run. `/DMO/I_AGENCYTP` (`interface; use
draft;`) is typed as a projection of `/DMO/R_AGENCYTP` and used through EML
in the base's transaction; the carrier singleton
(`/DMO/I_CARRIERSLOCKSINGLETON_S`, `/DMO/C_CARRIERSLOCKSINGLETON_S`) is
served as `/DMO/UI_CARRIERS_S` over V4: its root is a computed view (one
row: the literal key 1 and `max( last_changed_at )` over `/dmo/carrier`),
its carriers carry the constant `CarrierSingletonID`, and Edit drafts the
root with every carrier.

- **Fetched as they are**: the interface BDEF and its view, the singleton's
  two BDEFs, its four views and `/DMO/UI_CARRIERS_S`.
- **From the overlay**: the singleton's pool `/dmo/bp_i_carrierslocksingle_s`,
  whole. In its `locals_imp`, each marked `OSD overlay`:

| change | where | why |
| --- | --- | --- |
| `DEFINITION DEFERRED FOR TESTING` and the `FRIENDS` naming test classes dropped | the handler and the saver | the test classes are not fetched |
| an EML target declared with its derived type, `WITH CORRESPONDING #( keys )` as a declared import table | every READ ENTITIES | abaplint types an inline EML target void |
| `CORRESPONDING ... DISCARDING DUPLICATES MAPPING ... EXCEPT *` as a loop | the features, validateCurrencyCode | not parsed |

- **The seed**: the `I_CURRENCY` stand-in also gets the carriers'
  currencies, which the singleton's `validateCurrencyCode` looks up when
  the carriers are activated.

Tests: `test/rap-r11.mjs` (generators; V4: the root and its carriers,
navigation and `$expand`, Edit + change + create below the draft + Prepare
+ Activate and back, a refused Activate and Discard) and
`ZCL_OSD_RAPFLIGHT_R11_TEST` (the interface through EML; the singleton
through the runtime with `%is_draft`).

## Not done

- All of the scenario's business objects run: the managed travel (R7),
  the supplement and agency (R10), the agency's interface BDEF and the
  carrier singleton (R11) (`node tools/rap-flight/constructs.mjs`). V2 `$metadata`
  of the two travel services fails (ANORMALIES "RAP R7: a namespaced
  service's V2 $metadata"); V4's answers.
- Of the service definitions (`srvd`) `/DMO/UI_SUPPLEMENT` and
  `/DMO/UI_AGENCY` are fetched (R10), `/DMO/UI_CARRIERS_S` (R11); the managed travel's two come from the
  overlay without their value helps (R7), the readonly root's does not resolve, and the legacy base view is not this
  pack's service to publish. The bindings (`srvb`) are not read. The
  read-only views are served by the overlay's own YAML
  (`ZOSD_RAPFLIGHT_SRV`).
- The `draft/`, `colldraft/`, `hierarchy/` and `unmanaged/` scenarios are
  not fetched; their counts above come from the clone, not from a build.
- The ABAP Unit includes are not run.
