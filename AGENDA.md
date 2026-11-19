# AGENDA — open-steamgate

The living board: what is decided, what is open, what is next. Dated analyses go
in `docs/` as `YYYY-MM-DD-topic.md`.

> The open list, as a tree with owners and external dependencies, is
> [`docs/backlog/README.md`](docs/backlog/README.md). This file stays the narrative: what
> was decided and why.

## HANA track: milestone 3 closed, milestone 4 = funnel (2026-11-15)

Milestone 3 is closed (last PR #959): the sample service's whole read side and
a Fiori Elements app, 98 of 115 oracle requests equal, none silently wrong.
What does not work is written down in `docs/hana-milestones.md` ("Known, not
done"): exit value helps, labels in a second language, the speed of the largest
list, and one commit that was not re-measured. Next, decided 2026-11-14:
milestone 4 is a funnel over all registered services (64 registered, 37
answering, 19 code-based, one at the last stage); host safety is PR #960.

## Serving a rescued push channel over HANA: what the member cut leaves open (2026-11-18)

Zork's push channel plays over its own HANA tenant (`docs/hana-serve-icf.md`,
"APC"); the scope's `--cut-members-typed-by` is what lets its class build
without the AI library. Open, and not Zork's to fix:

- **A stubbed method skips the side effects after it.** The cut replaces a
  whole method body with the loud raise, so a caller that does more after
  the call never gets there: the channel's `on_close` saves the AI session
  (stubbed) before it unregisters the connection, so the unregister never
  runs and the connection count keeps gone connections until the class's
  own expiry. The raise is loud (log line, stub trace); the effect on the
  caller is not said anywhere but here. Candidates: list each stubbed
  method's callers in the scope's output, or a cut that turns a call to a
  stubbed method whose result nobody reads into a logged no-op -- which
  would no longer be "never guess", so it needs a decision first.
- **gogen: `EXPORT`/`IMPORT` are refused** (`NOT_COMPILED`, "statement
  Export"), so `test/unit/zcl_osd_shared_memory_test` stays in the Go
  inventory's gap list (advisory) until the Go runtime has the two shared
  media; the JS runtime has them in the pin `local/osd-build-4l`.

## CI isolation for ADT pull requests, temporary (2026-10-03)

Decided by Alice (through dell) after three ADT pull requests with green tests
waited half a day on an image check that failed for reasons outside ADT (a
Docker Hub token reset, then two DuckDB engines on one file).

1. **The image does not gate an ADT-only pull request.** `docker.yml` excludes
   `src/adt/**`, `tools/adt-*`, `test/adt-*` and `test/suites.d/adt.json` from its
   `pull_request` paths
   (`docs/**` was never in them). The image is needed only on tagged
   releases, which still build, probe and publish it: **an image break caused
   by an ADT change shows up at the tag; adt-i5 fixes it before the release.**
   **Revert this at the 0.7 tag or when the image has its first user,
   whichever comes first. Owner: adt-i5.**
2. **Quarantine.** A check that is red on the latest `main` run is not waited
   for by `merge-when-green` for at most 24 hours: one line here with the
   check's name, the link to that red `main` run (the evidence is on `main`,
   not on another pull request), an owner and the expiry. The check keeps running. Never
   quarantined: `leak-scan`, `test`, `suites`.
3. **What an ADT pull request waits for** follows from (1): `test` and the
   `suites` shards, plus any check its own paths still trigger.

Quarantined checks (name, red main run, owner, expires):

- none

## Names a system reserves: ZONE, HANDLER, SECTION, PARAMETER (2026-09-24)

Decided: the taxi fact table's field `ZONE`, a reserved word on a system
(ANORMALIES zone-reserved-word), is `PICKUP_ZONE`. A4H refuses the CDS
element `Zone` as well, so the cube's element is `PickupZone` and the OData
property is `PICKUPZONE` (osg-i7 and the foreman: the demo's OData has no
outside consumers, and a cube that activates on a system matters more than
the old property name); the page's annotations, its e2e test and the bench
follow. A DuckDB file made before (`STG_DB_PATH`, the real import of
`tools/import-nyc-taxi.mjs`) is **migrated, not re-imported**:
`tools/osd-db-migrate.mjs` renames the column when the old one is there, from
the DuckDB branch of `test/setup.mjs` and from the import, and puts back the
running generation's views, which DuckDB would otherwise keep naming `zone`.
The stamped backends (SQLite file, SQLite with `STG_DB_PATH`, PostgreSQL)
already rebuild or set a file aside on any DDIC change and hold only seed rows.

The other names of the tree in `TRESE` (A4H's list of reserved names, 453
entries) that A4H refuses (measured the same day) are renamed the same way,
by the same rule (fix/reserved-words; agreed with osg-i7): the table field
gets a name that says what it holds, the CDS alias stays unless it is
reserved itself, and a renamed alias takes the OData property with it.

| table field | now | CDS element | now |
| --- | --- | --- | --- |
| `ZOSD_ICF_APC-HANDLER` | `CLASS_NAME` (SAPC's name) | `ZC_OSD_ICF_APC.Handler` | `ClassName` |
| `ZOSD_ICF_ASIDE-HANDLER` | `ICF_HANDLER` | (no view) | |
| `ZOSD_SVC-HANDLER` | `HANDLER_NAME` | `ZC_OSD_SERVICE.Handler` | `HandlerName` |
| `ZOSD_DB-SECTION` | `CATEGORY` | `ZC_OSD_DATABASE.Section` | `Category` |
| `ZSTG_FM_PARAM-PARAMETER` | `PARAM_NAME` | (table-mapped; OData stays `Parameter`) | |
| `ICFHANDLER-ICFHANDLER` (SAP's) | unchanged | `ZC_OSD_ICF_HANDLER.Handler` | `IcfHandler` |

The five tables and four views activate on A4H with these names
(`$ZOSG_TMP_0040`, deleted). DuckDB files are migrated by the same list in
`tools/osd-db-migrate.mjs`; the status snapshot JSON keeps `handler` and
`section`. The migration is DuckDB's only: a SQLite file with this drift
is moved to `<file>.<schema>.drift` and the system starts empty, so the
module signatures in `ZSTG_FM_PARAM` come back only by posting the
`*.fugr.xml` to `FunctionGroupSet` again, and the `ZOSD_ICF_ASIDE` records
stay in the `.drift` file. `test/reserved-words.mjs` fails when an own transparent table or
a CDS element takes one of the refused names again. The structures with
`COUNT`, `FILE`, `PACKAGE`, `ROWCOUNT` and `RULE` (ZOSD_TYPE_S,
ZOSD_OBJECT_S, ZOSD_SQLTRACE_S, ZOSD_ISSUE_S) stay: a structure has no
database table, and A4H's own structures carry all of those names.

Open:
- `ZOSD_ICF_ORIGIN`'s description is 62 characters; ADT refuses more than
  60 when it creates a table (`ZSTG_FM_PARAM`'s 66 was, and is 42 now). Not
  measured through abapGit.

## Sources are files; tables hold only derived indices (2026-09-24)

Decided by Alice: sources stay files in abapGit shape plus git. Database
tables hold only DERIVED indices such as the cross-reference, rebuilt from
the files per generation and never edited. The first one to follow it:
`CROSS`, `WBCROSSGT`, `WBCROSSGTX` and `D010INC` were filled only by a manual
`osd-xref.mjs --write`, so every host started with them empty and vsp's
where-used saw nothing. Now one module, `tools/osd-xref-seed.mjs`, fills
them on every host -- `test/start.mjs`, `tools/osd-serve.mjs` (and so the
binary), `tools/osd-data.mjs` at start, the browser preview and OSGo at
build -- replacing the rows rather than merging with them, and the parse is
cached per generation under `build/xref/`. `test/xref-seed.mjs` fails when
a host stops calling it.

## Demo data in ABAP, the same on every host (2026-09-24)

Decided (Alice): demo data is generated by ABAP, not by a script per host.
`ZCL_OSD_DEMO_DATA=>BOOT` runs at start on Node (`test/start.mjs`,
`tools/osd-serve.mjs`, so the binary), in the browser preview (start and
reset) and in OSGo, through `tools/osd-demo-data.mjs` and one knob,
`OSD_DEMO_ROWS` (default 20000, `0` for none). The rows are synthetic NYC
taxi facts, FACT_ID 9000000001 and up; A4H, Node and OSGo gave the same
first rows and checksum for the same class (docs/demo-data.md).
Revised 2026-09-27 (vg/taxi-on-demand): nothing is generated at start
(the phase took 3849 ms of a packaged first start). A year of synthetic
trips is made on request -- the taxi app's "Generate data", `osd: Generate
taxi data...`, or `POST ZOSD_TAXI_SRV/GenerateYear` -- and `ResetData`
goes back to the four sample rows. `OSD_DEMO_ROWS` stays as an opt-in and
covers only the sample month's keys (up to 9099999999), never a year.

Open:
- `ZCL_OSD_DEMO_DATA` has not run on a system: ZOSD_TAXIFACT could not be
  created there before the `PICKUP_ZONE` rename (#67, above).
- The flight facts (`tools/gen-data.mjs`, `STG_DATA_SCALE`) move to a
  `ZCL_OSD_DEMO_FLIGHT` over `ZCL_OSD_DEMO_RANDOM` the same way; not started.

## pAMDP scalars: host first, engine only where paired (2026-09-24)

Decided with foreman-dell on #44: a scalar rule measured on A4H is the
host's to evaluate, not the engine's, so it holds on SQLite, DuckDB and
sql.js alike and ports to the Go IR without a database. The engine route
(`SELECT <expr> FROM DUMMY`) stays for what is not measured yet -- ordering a
text, CASE, functions -- and each function leaves it only with an
engine = A4H pair in the IR pairs files. Open: LENGTH / SUBSTR / UPPER /
LOWER / TRIM measured and moved to the host.

Open, found by the critic on #51 (2026-09-24), both older than it: the
compiler accepts a DECLARE after a statement (`BEGIN ... END; DECLARE n
...`) and an assignment to a scalar IN parameter (`iv = 3`), which HANA's
grammar should refuse -- one A4H probe, then a refusal; and an IF with one
branch that assigns a table variable read after END IF is refused with
"column ID is not present in the typed query scope" where the reason is
"lt is not assigned on every path".

## SAP Easy Access, and the GUI substitutes wired in, 2026-09-18

The system has an entry screen. `/sap/bc/gui/sap/its/webgui/` — the path the
real ITS webgui answers on, used on purpose — serves the classic SAP Easy
Access screen, drawn by `ZCL_OSD_WEBGUI` (`src/webgui/`) behind a
`*.sicf.xml`, the same ICF pattern as `packs/lsd`. Title bar, command field,
folder tree with the disclosure triangles, the tall image panel with the
bulge down the right-hand side, message in the status bar. No JavaScript:
the folders are `<details>`, the command field is a GET form, a node is an
anchor. `docs/webgui.md` is the whole of it; the tile is on the launchpad;
`test/webgui.mjs`, `test/e2e/webgui.spec.mjs` and two ABAP Unit classes are
the tests. Backlog track **G**.

**The menu is the system, not a copy of it.** Everything below the fixed
folders is read in ABAP out of the five status tables that `ZOSD_STATUS_SRV`
already serves — OData services, ICF nodes, push channels, UI5 apps, content
packs — because a menu that can disagree with the system status is a menu
that is wrong somewhere, and there should be only one list to be wrong. Two
things were added to that inventory rather than to the menu: `ZOSD_SVC-TEXT`
(the name a human calls a service, which every source already carried and
`servicesOf()` was dropping), and `KIND = 'APP'` rows read from each app's own
`manifest.json`, pointed at the launchpad with the app's **own** inbound
intent. The refresh `ZOSD_STATUS_SRV` pays for is now registered for the
Easy Access path too, before the SICF mount, because that mount answers
instead of passing on.

**A node has a kind** — FOLDER / APP / SERVICE / TRANSACTION — and the third
one exists before anything needs it. `ZABAPGIT` is the single transaction and
it answers "not runnable yet". That is the seam: abapGit should eventually
arrive as a transaction you type the name of, not as a bespoke page, because
that is how a system works.

**`open-abap-gui` is in as a library** (not a pack: it is SAP-namespace shim
code like `open-abap-core`), from our fork at `ed96e89`, `/src` only plus the
three `scaffold` files `/src` names by name. **+301 objects**, 1173 → 1474,
which is exactly `/src` and the three: none of the 162 examples, none of the
test tree. The screen escapes its text through `cl_gui_control=>escape_html`,
so the library is called rather than only compiled against.

**What is next, and the one thing it needs first (G.2).** The outbound half of
`sapevent` is real and tested here: `cl_gui_control` rewrites
`<a href="sapevent:X">` into a form that posts. The inbound half does not
exist — **nothing in `open-abap-gui` ever raises the `sapevent` event**; the
one example that registers a handler has a handler that cannot fire, and the
scaffold host folds the click into its own `gg_action` dispatch instead. So
before anything about running abapGit through the substitutes: take the POST,
raise `sapevent` with `action` and `postdata` the way SAP fills them, and
prove a click comes back **against abapGit's own HTML**, not a synthetic
anchor. One class and one test. Running abapGit itself was deliberately not
started.

## Milestone — the demo as an oracle, packs from repositories, Pages alive, 2026-09-17

Status at the close of the 16/17 session (the narrative is
[`docs/retro-2026-09-17.md`](docs/retro-2026-09-17.md), the method
[`docs/frame-comparison.md`](docs/frame-comparison.md), the dossier
[`docs/upstream.md`](docs/upstream.md)):

- **Deployed, all three on commit `ae5235a`+:** the lab on 3030, the i7
  (Bun binary, 8 work processes, `~/osd-i7`), and GitHub Pages
  (`oisee.github.io/open-steamgate/main`): launchpad, ZO4D demo, Zork, the
  SAP LSD light-show with music.
- **Packs:** `packs/o4d`, `packs/zork` fetch vivid-vibes and zork-abap at
  a commit (`node tools/osd-fetch.mjs`); `packs/lsd` is tracked (recording
  as `.ndjson`, music as `.m4a`).
- **The oracle:** 22 of 22 scenes attributed; what still differs anywhere
  is abaplint #4302 (numeric functions typed `i`).

**Upstream, checked 2026-09-17 evening.** Nobody has written on any of
them yet; three PRs merged by Lars the same morning, no comments beyond the
Regression bot.

| where | what | state |
| --- | --- | --- |
| transpiler #1862 | float vs character literal (`parseInt`) | merged 06:41 |
| transpiler #1864 | −0.5 to `i` rounds away from zero | merged 06:44 |
| transpiler #1867 | APPEND of a raw number keeps its fraction | merged 06:49 |
| transpiler #1863 | MOD with a float operand | open, Regression green, unreviewed |
| transpiler #1860 | its issue | open |
| transpiler #1866 | integer division rounded before the next operation, calc type `i` | open question, unanswered |
| abaplint #4302 | `frac`/`abs`/`floor`/`ceil`/`trunc`/`sign` return `i` | open, test only, unanswered |
| npm | runtime/transpiler 2.13.87, core 2.120.54 | no release carries the three merges yet |

**Projection on the plan.** E.1, E.2 (incl. sources), E.8 milestone 1,
B.12 (pool), B.13 (base image), SP4, N3 are done. Open, in the order to
take them: the user's path with a small SEGW/CDS pack (Astra's next step,
no number yet); E.7 (browser demo stops mid-show, profiling the slow
effects, tie-break sort key in vivid-vibes); D.9 (`docs/adt-facade.md`
for abapGit #7880); upstream tails (open-abap-core patches as PRs, the
`?img=` line to vivid-vibes, the recorder to sap-lsd); E.9 (a pack's own
page), E.8 milestone 2 (a DIAG decoder in JavaScript) if wanted.

**Check first, next session:**

1. `npm view @abaplint/runtime version` — a release above 2.13.87 carries
   #1862/#1864/#1867: drop those three commits from `local/osd-build`, take
   the published runtime, update the transpiler entry in `libs.lock.json`,
   and see Pages stay green.
2. `gh pr view 1863 -R abaplint/transpiler`, `gh issue view 1866`, `gh issue
   view 4302 -R abaplint/abaplint` — any word from Lars decides whether
   #1866 becomes a PR and who fixes #4302.
3. Pages by content: `curl .../main/build.json` shows a build after the
   last push; the Zork and LSD pages answer; the demo plays past rotozoom
   or stops where it stopped (E.7, unmeasured).
4. The i7 and the lab still serve (`/app/packs.json` on both); the lab
   was restarted by `scripts/osd-restart.sh 3030` and runs without the
   other session's `OSD_PACKS=.local/packs` (the vibes example pack is not
   on it, by design).
5. Uncommitted in the tree, not ours: README, `tools/osd-tls-proxy.mjs`,
   `src/zosd_test/...`, four docs and `scripts/osd-restart.sh` (another
   session's); `docs/adt-facade-proposed.md` (Astra's, D.9). In
   `.local/lars/open-abap-core`: uncommitted patches plus the fork branch
   `osd-build` that pins them. In `~/dev/sap-lsd`: commit 304f0c4 (the
   recorder), unpushed.

## Milestone — the ADT surface (OSD as a real ABAP Cloud system), 2026-09-15

Eclipse ADT 3.60 and vsp treat OSD as a system: log on, browse the package
tree to any depth, open and edit every source kind, save, activate, run unit
tests, preview table and CDS data on F8, and create and delete objects — and
every change lands on the git tree as abapGit files. The server side of the
surface is catalogued in [`docs/adt-surface.md`](docs/adt-surface.md), each
capability with its resource, its shape, and the client gate it satisfies; the
client contract it was built against is [`docs/adt-facade.md`](docs/adt-facade.md).

What made it work, in order of how invisible the cause was:
- **The compatibility graph is the gate.** A missing `compatibilityAvailable`
  node makes the client read every feature as absent and send nothing; the
  same is true per feature (`SOURCESERVICES/outline` for the outline,
  `DDIC.DDLSOURCES/ddlSources` for opening a CDS view). Most failures were
  decided in the client before a socket opened.
- **An empty `<OBJECT_VIT_URI/>` made every tree node the same node.** The
  client parses it as `new URI("")` and compares nodes by path, so clicking
  one package opened another and deeper nodes hung on "Loading repository
  tree ...". Omitting the empty element fixed browsing to any depth. Proven by
  byte-code, not guessed.
- **Save kept content only once a written object read back inactive** with a
  new ETag; a 304 wiped the editor.
- **F8 rows** needed Open SQL (comma-less field lists, `UP TO n ROWS`)
  translated at the data layer.
- **Create/delete** write and remove the abapGit files a package's folder
  holds, and a file that appears on disk is served without a restart.

Method that carried it: read the client's jars for the gate, pull fresh A4H
captures as oracles, and record what the live client actually sent
(`STG_ADT_DUMP`) rather than replay what it "must have" sent. The system id is
one setting, `OSD_SID` (default **OSD**, alias `STG_ADT_SID`), the same for
ADT and the runtime; until 2026-10-02 ADT said OS2 so a restart kept a
project's logon, moot while no Eclipse project exists.

Open next: the editor documents for FUGR/MSAG/DOMA/TTYP/VIEW/SHLP (each its
own format), function-group create, and the RFC → ADT bridge (Eclipse's
non-cloud logon travels over RFC, not HTTP; oracle capture on the gateway
port is the first step, `~/dev/open-rfc-go` carries the transport and an
`adt-rfc-bridge` skeleton).

## Decided (2026-09-11)

- **Repo created** as the OData/Gateway member of the SAP-protocol family
  (`vsp → odgp → steamgate`). Public, MIT.
- **v1 scope = classic code-based SEGW only.** CDS / SADL / RAP deferred (no
  local ABAP interpreter exists anywhere; Gap 5 in `docs/prior-art.md`).
- **v1 OData version = v2** (SEGW's native output). v4 rides with the deferred
  CDS/RAP path.
- **Clean-room reimplementation of the `/IWBEP/` interfaces.** No SAP source, no
  standard DDIC bundled. `open-abap-odata` is a *spec*, not a base (effectively
  unlicensed).
- **Reuse, do not rebuild:** transpiler + `@abaplint/database-sqlite` (Open SQL);
  fe-mockserver-core (OData v2/v4 wire); ui5-middleware-fe-mockserver (FE
  serving); abapGit TABU + `load-table-contents` (seed data); abap2UI5 playground
  (Phase-0 harness template).
- **Build only:** the `/IWBEP/` Gateway runtime (model registry + DPC dispatch)
  and the `$filter` → SELECT-OPTIONS / `io_tech_request_context` bridge (the
  crux). See gap-list in `docs/prior-art.md`.

- **Gateway lives here; the interface/DDIC layer lives in our fork
  `oisee/open-abap-odata`** (decided 2026-09-11; revised 2026-09-12: **we
  work in the fork and send the reusable pieces upstream as PRs**, one at a
  time: #40 registry + exception constructors (merged 2026-09-12), #42 EDM
  setters + facets (open); queued behind it on fork main: associations,
  function imports, `get_expanded_*` in the base class, SADL interfaces +
  annotations. Fork `main` = `upstream/main` + that queue, rebased after
  every merge. Steamgate first, backport what is proven). For the
  transpiler the same rule: fixes go as PRs from branches of `oisee/transpiler`
  off `upstream/main` (#1829 literal length, #1830 FAE dedupe, #1831 views +
  CREATE DATA TABLE OF, #1832 FAE empty driver; all merged and released as
  2.13.86 the same day, workarounds removed). Pulled in as a transpiler lib with
  `files` limited to `src/{oo,ddic,exceptions,internal}`. Upstream contact is
  issue #39 (license) only. The dispatcher, request context, serializer and
  `$filter` bridge are open-steamgate code. **Working assumption (Alice,
  2026-09-11): treat open-abap-odata as MIT until issue #39 says otherwise.**
  If the answer is "no", reimplement the ~50 signatures from SAP's public
  contract.

## Packaging, media and what Bun is for, 2026-09-14

The day started with a socket error and ended with three beliefs corrected.
Written down because two of them had already been planned around.

**Media out of SMW0 now works in the browser.** `WWWDATA_IMPORT` read the
bytes from the file beside the transpiled module, which is right on a
checkout and impossible in a service worker, so the gateway answered every
request except the ones that showed a picture or played a sound. The fix is
a seam rather than a special case: open-abap-core lets a host install
`abap.W3MI_LOADER(objid, filename)` and the disk becomes the fallback. The
build copies the media beside the bundle instead of into it, so a visitor
pays for the audio only if the page plays it. Zork boots from
`ZORK-MINI.Z3` in a browser, and a 4.6 MB track arrives in 0.78 s. The same
hook is what a compiled binary will need, which is the sign the seam is in
the right place — it was cut for one reason and paid for two.

**A stateful APC handler speaks before the page is listening.** Draining
what `on_start` pushed before signalling open delivers a message while the
page's socket is still CONNECTING, so `onmessage` runs before `onopen` and
the page's reply comes back as "the socket is not open". Open first, then
drain. The page was right and we were wrong.

**Three things believed about Bun were false.** There are no native
dependencies at all — `@abaplint/database-sqlite` is `sql.js`, wasm — so the
question carried since the idea was raised does not exist. The percent
defects (`%23` for namespaces, `%25` for the 172 W3MI names) are a
ten-line bundler plugin, not a blocker. And `bun build --compile` does
**not** inherit the specifier defect: `Bun.build({compile, plugins})` builds
a binary that runs, while the plugin-less CLI and the interpreted path both
fail. Transpiler #1841 stays worth having and stops being a gate.

**Bun does not replace webpack, and will not soon.** It bundles the same
graph 166 times faster and the result cannot be evaluated: it keeps
`import.meta` and 8893 top-level awaits, and a service worker is a classic
script. webpack lowers both. So the two are not competitors — webpack ships
the browser, Bun ships the binary, and the fantasy of one tool doing both is
retired.

**One local HTML file: possible, but not with a worker.** A service worker
cannot be registered from `file://`. The route is to run the runtime in the
page and shim `fetch` and `XMLHttpRequest`, which is the trick
`preview-socket.mjs` already plays on `WebSocket`, and which
`handleRequest()` is already shaped for. It needs webpack for the same
lowering, because `file://` also refuses module scripts. Parked as backlog
1a.2: worth it only for "send someone a file they double-click", and where
an executable may be run the binary is better, because it is the server and
the https a worker demands off localhost stops mattering.

**UI5 is not embedded.** Decided rather than measured: Fiori Elements
(`sap.fe`, `sap.ui.generic.app`) is SAPUI5 and is not in OpenUI5, so
embedding OpenUI5 would buy freestyle apps and not the thing this project
exists for. CDN by default, a cached dist for offline.

**Layers, in Alice's formulation.** The binary takes an ordered list of
abapGit `src` paths; a later layer wins a name collision; data layers
(`data/*.tabu.json`) apply the same way. The argument is no longer
theoretical: `local/o4d/` and `local/vivid-vibes/` both carry
`ZCL_O4D_HTTP_HANDLER` and the directory walk decided silently which one ran.
The unifying observation is that `hash(ordered layers)` is the transpile
cache key **and** the ADT version-id proposed earlier — one number, and it
is what makes "spin a runtime from sources" true rather than aspirational,
because the first run transpiles 1065 objects and later runs do not. One
question is open and is Alice's: does a layer override the object or single
files (backlog 1.5).

**Three false greens in one day.** A test that called `install()` itself and
passed while the path it covered was broken; a suite that passed against a
stale `build/sw.js`; a fix confirmed by grepping for a comment webpack
strips. Same shape each time: the check and the thing checked drifted apart.
The rule that follows is in CLAUDE.md, and it is the argument for running
one e2e suite against every packaging target rather than trusting that a
second runtime behaves like the first.

## DuckDB as the store, 2026-09-12 (night run)

`tools/duckdb-client.mjs` implements the transpiler's `DatabaseClient` over
`@duckdb/node-api` (in-process, columnar). `STG_DB=duckdb` makes
`test/setup.mjs` load the PostgreSQL DDL the transpiler already emits
(`NCHAR` → `VARCHAR`), the seed rows and the CDS views into DuckDB instead of
SQLite. **All 69 ABAP Unit tests and the HTTP suite pass unchanged on DuckDB**
(`npm run unit:duckdb`, `npm run integration:duckdb`, `npm run start:duckdb`),
including the SADL cube's `GROUP BY`. Adaptations: trailing blanks in
string literals are trimmed (ABAP CHAR semantics; SQLite tolerated the padded
literals, VARCHAR does not); the ABAP LUW is real (INSERT/UPDATE/DELETE open
a transaction, `COMMIT WORK` / `ROLLBACK WORK` end it) and a failed statement,
which aborts a DuckDB transaction, is fenced by replaying the LUW's
successful statements into a fresh transaction (savepoint emulation; test
`ltcl_luw` runs on both stores); `STG_DB_PATH=file.duckdb` persists schema,
seed and data between runs. Open: DECIMAL/DATE column types instead of
NCHAR, and packaging as `@abaplint/database-duckdb`.

## Analytics on DuckDB, 2026-09-12 (evening): the cube that shows why

The thesis behind DuckDB was analytics; the demo had three travels and no
analytical app. Now: `ZSTG_FLIGHTFACT` (airline, month, status, seats,
price, currency) with 24 seed rows and `tools/gen-data.mjs` for any number
of synthetic facts (`STG_DATA_SCALE`), the CDS cube `ZC_STG_FLIGHTCUBE`
(`@Analytics.dataCategory: #CUBE`, seats and revenue `@Aggregation.default:
#SUM`) in `ZSTG_SADL_SRV`, and a Fiori Elements V2 Analytical List Page
(`webapp/analytics/`, tile "Flight analytics"): chart per airline, table by
airline/month/status with totals, compact filters. Every request of the
page is a `$select` on dimensions and measures the SADL runtime turns into
`GROUP BY`; on DuckDB that is one columnar scan.

Three things the runtime needed for that, all in `src/sadl` and
open-abap-odata #60: `sap:semantics="aggregate"` on the entity type (the
odata library learned annotations on entity types; without the attribute
the page does not bind analytically), synthetic keys on aggregated rows (the
UI5 model keeps entries by their uri; with an empty key every aggregated row
was the same entry and the table showed one airline 24 times), and
`$inlinecount` counted before the page is cut.

`npm run bench:cube -- <rows>` boots the runtime once per store with that
many facts and times the page's four requests (median of 5). 200,000 facts
on this machine, ms: total 21 vs 8, per airline 103 vs 12, per
airline/month/status 220 vs 33, filtered per month 26 vs 10 (SQLite vs
DuckDB). 1,000,000 facts: total 77 vs 10, per airline 575 vs 17, per
airline/month/status 1098 vs 39, filtered per month 114 vs 15; loading the
million takes 5.3 s into SQLite (multi-row INSERTs) and 6.6 s into DuckDB
(a CSV through `read_csv`, most of it writing the CSV in JavaScript). The
row store scans a million rows per chart; the column store reads two
columns. That is the DuckDB thesis, measured.

## SADL-lite, 2026-09-12 (night run)

Reference-data-source services run now, read-only, with analytics.
- **Build:** `tools/cds2ddic.mjs` parses `src/cds/*.ddls.asddls` with abaplint
  and writes into `gen/cds/` a DDIC VIEW (abapGit XML) per CDS projection,
  so the transpiler creates the SQLite view and ABAP sees typed fields; a
  `zif_stg_cds_source` class per view (static FROM, dynamic WHERE / ORDER BY /
  field list / GROUP BY); and `zcl_stg_cds_registry` with fields, EDM types,
  keys, labels, every annotation, associations with ON pairs and cardinality.
  Single-source projections only; joins, expressions and parameters are next.
- **Runtime (`src/sadl/`, clean-room):** `cl_sadl_gw_model_exposure`
  (`get_exposure_xml` → `expose( model )`) reads the `<sadl:definition>` a
  SEGW RDS MPC carries and builds entity types, sets (`<Structure>Set`),
  associations with referential constraints and navigation properties from
  the registry. `cl_sadl_gw_dpc_factory=>create_for_sadl` returns
  `zcl_stg_sadl_dpc` (`if_sadl_gw_dpc`): ranges → dynamic WHERE, `$orderby`,
  `$top/$skip`, keys, navigation through the association pairs, generic
  `$expand` via the dispatcher.
- **Annotation layer for analytics:** `@Analytics.dataCategory: #CUBE` →
  `sap:semantics="aggregate"` on the set; `@Aggregation.default: #SUM` →
  `sap:aggregation-role="measure"`, other fields `dimension`;
  `@Semantics.amount.currencyCode` / `quantity.unitOfMeasure` → `sap:unit`;
  `@EndUserText.label` → `sap:label`; `@UI.lineItem` / `@UI.selectionField`
  → `UI.LineItem` / `UI.SelectionFields` vocabulary annotations in
  `$metadata`. On an aggregate set `$select=Dim,Measure` runs
  `SELECT dim, SUM(measure) ... GROUP BY dim` (what an analytical list page
  sends on v2).
- Demo: `ZSTG_SADL_SRV` with `ZC_STG_TRAVEL`, `ZC_STG_BOOKING` (association),
  `ZC_STG_TRAVELCUBE` (cube). Generated-shape MPC/DPC in 7.02 syntax; real
  SEGW output is 7.40 and needs the abaplint downport first.
- Fork b18ea73: `if_sadl_gw_model_exposure(_data)`, `cx_sadl_exposure_error`,
  changeset types, `vocab_anno_model`, labels + custom `sap:` annotations +
  vocabulary XML in `$metadata`.
- Open: joins/expressions in CDS, SADL writes (`maxEditMode` ≠ RO), `$apply`
  (v4) and `$select`-less aggregation, DDLS downport of real corpus code.

## `$expand` round two, 2026-09-12 (night run)

Nested paths (`$expand=to_Travel/to_Bookings`) recurse per level. With
`$expand` present the dispatcher calls `get_expanded_entityset` /
`get_expanded_entity` with an `io_expand` tree; a DPC that fills deep rows
itself lists them in `et_expanded_tech_clauses` and the serializer inlines
those components, the rest is expanded generically. The framework base in
the fork (fc5ce3d) delegates to the plain reads, as SAP's does. Demo DPC has
the fast path for `TravelSet?$expand=to_Bookings` (two SELECTs). Two more
transpiler anomalies logged (FAE de-dup by DB key, FAE with empty driver).
Express route answers 500 on a kernel error instead of hanging.

## Deep insert and function imports done 2026-09-11 (night run)

Deep insert: nested navigation payloads in a POST reach `create_deep_entity`
with an `io_expand` tree; the entry provider fills the SEGW deep structure
(one component per navigation property) recursively; the 201 response inlines
what the DPC returned. Function imports: `model->create_action` with input
parameters, return entity type/set or primitive, HTTP method, `sap:action-for`;
`<FunctionImport>` in `$metadata`; `/Service/Action?Param='v'` dispatched to
`execute_action`, result serialized as entity, feed or `{"d":{"Name":v}}`.
Fork: `oisee/open-abap-odata` a5272e8. Lesson kept in code: SAP's
`get_form_fields` lowercases names, the handler uses `get_form_fields_cs`.

## Navigation and `$expand` done 2026-09-11

Fork: `create_association` / `create_association_set` /
`create_navigation_property` / referential constraints are real, `$metadata`
emits them. open-steamgate: `Set(key)/nav`, `Set(key)/nav/$count`,
`Set(key)/nav(key)`, to-many and to-one, `$expand=a,b` (first level) on
entity sets and single entities by the generic route a real Gateway takes when
the DPC has no `get_expanded_*`: `get_entityset` / `get_entity` of the target
set with `it_navigation_path` and the source keys in `it_key_tab`. Navigation
properties not expanded are `__deferred` links. Demo grew a `Booking` entity
(DATS field → `Edm.DateTime`) with a 1:N association. Still open: deep insert,
writes through navigation, `get_expanded_entityset` when a DPC implements it,
nested `$expand`.

## `$batch` done 2026-09-11

`zcl_stg_batch`: multipart/mixed in and out, retrieve parts dispatched one by
one, changesets in order and answered as a whole (first failure becomes the
changeset's single error part, later requests are not run; no rollback of the
earlier ones yet, the local SQLite has no transaction bracket). The Fiori
Elements app runs with `useBatch: true` now; Playwright covers list, filter and
**Delete from the list report** (DELETE inside a changeset, then the refresh
GET in the same batch). Keyboard-driven in the test: pointer clicks never pass
Playwright's stability check under the WSL headless compositor.

## Phase 1b — writes done 2026-09-11

POST / PUT / PATCH / MERGE / DELETE reach `create_entity`, `update_entity`,
`delete_entity` of the DPC with an `io_data_provider`
(`zcl_stg_entry_provider`: request body parsed by `zcl_stg_json=>parse_object`,
mapped through the model, EDM-typed conversion). 201 + Location, 204, business
exceptions as 400 with the DPC's message. CSRF fetch answered. The demo DPC
does real INSERT / UPDATE / DELETE on SQLite. Still open: a transaction bracket around changesets, complex types,
media resources/streams.

## Phase 4 demo — Fiori Elements list report, 2026-09-11

`webapp/` is a Fiori Elements V2 list report (SAPUI5 1.120 from the CDN,
annotations file, no controller code) served by the same Express process at
`/app/`, so no proxy and no CORS. The exact SmartTable requests
(`$select`, `$skip/$top`, `$inlinecount=allpages`, `$filter`, `$metadata`
with `sap-language`) are answered by the dispatcher. `npm run e2e` runs the
Playwright check (needs `playwright install-deps chromium` once, sudo):
**green 2026-09-11**, the list report renders the four travels and the filter
bar's `$filter=Status eq 'X'` reaches the DPC. Console shows FE V2's
`Only ODataModel with batch mode enabled are supported` for the transaction
controller: **`$batch` is a prerequisite for writes from Fiori**, add it to
Phase 1b.

## Phase 1+2 — read path incl. `$filter` done 2026-09-11

`/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$filter=Status eq 'A' and TravelId ge 'T0002'&$top=2&$inlinecount=allpages`
answers real OData v2 JSON from the transpiled DPC over SQLite, with the
filter delivered as `it_filter_select_options` and through
`io_tech_request_context->get_filter( )`. 35 ABAP Unit + 9 mocha. Writes
answer 501: next is Phase 1b (POST/PUT/PATCH/DELETE with body
deserialization, `/iwbep/if_mgw_entry_provider`), then `$expand` and
navigation, then Phase 3/4 (fe-mockserver front, Fiori Elements).

## Phase 0 — done 2026-09-11

`npm test` is green: abaplint, transpile, 6 ABAP Unit tests, 2 mocha wire
tests. A hand-written SEGW-shaped MPC/DPC (`src/demo/`) runs its Open SQL
against SQLite seeded from an abapGit TABU capture (`data/`), honours
`it_filter_select_options`, paging and `it_key_tab`. The ICF handler answers
501 until the dispatcher exists. First two entries in `ANORMALIES.md`.

## Sprint 0 — audit before building (highest priority)

Do this before any architectural commitment.

- [x] **Dependency-closure probe.** Measured 2026-09-11 on eight public SEGW
      repos, see `docs/2026-09-11-closure-probe.md`. The closure of a classic
      hand-written DPC is DDIC (data elements, domains, tables), not code:
      1–65 standard objects, 0–2 standard classes. It is capturable via
      abapGit per user, not something to shim. Framework-bound services
      (SADL, BOPF, CRM) are flagged mechanically. Tool:
      `npm run probe -- --closure <repo>`.
- [ ] **Corpus check.** Confirm the target services are classic code-based SEGW,
      not SADL-/RAP-generated (which have no transpilable `GET_ENTITYSET`).
      Mechanical now: `npm run probe -- --closure <repo>` and grep the output
      for `CL_SADL_GW_DPC_FACTORY` / `/BOBF/`. Still to run on the real
      target corpus.
- [ ] **Accessor grep.** Which `io_tech_request_context` methods do the target
      DPCs actually call (`get_filter` / `get_filter_select_options` / read
      `it_filter_select_options`)? Build for the shapes that exist.
- [x] **Clone + hand-audit `open-abap-odata` `src/`.** Done 2026-09-11, see
      `docs/2026-09-11-lars-ecosystem-audit.md` §4. LICENSE reads `todo`
      (verified). Data path is a literal; interfaces + DDIC are the asset.
- [ ] **Open-SQL coverage probe.** Run the target DPCs' real SELECTs (FOR ALL
      ENTRIES, joins, aggregates, client-dependent) through syntax.abaplint.org
      and the transpiler. Note the fixed-client-123 / no-implicit-MANDT
      correctness risk.

## Quick wins (from the 2026-09-11 ecosystem audit, §6)

Ranked in `docs/2026-09-11-lars-ecosystem-audit.md`. Recommended order:

- [x] **QW0** Asked upstream for an MIT grant on `open-abap-odata`:
      https://github.com/open-abap/open-abap-odata/issues/39 (2026-09-11).
      Not blocking on the answer.
- [x] **QW6** Scaffold Phase 0 in the open-abap house style. Done 2026-09-11.
- [x] **QW7** Closure probe: `tools/closure-probe.mjs` (static, abaplint
      registry with libs as dependencies). The dynamic complement is
      `"unknownTypes": "runtimeError"` in `abap_transpile.json`. Done 2026-09-11.
- [x] **QW1** Registry instead of the hardcoded test DPC, plus working
      gateway exception constructors: `oisee/open-abap-odata` main at
      4c2c301 (2026-09-11). Sent upstream as open-abap-odata PR #40
      (2026-09-12); open-steamgate consumes the fork without `exclude_filter`.
- [x] **QW5** Truthful `$metadata`: keys, entity sets, all EDM setters,
      facets, labels. Fork main (2026-09-11).
- [x] **QW2** Generic OData v2 JSON serializer driven by the model
      (`zcl_stg_json`, `zcl_stg_model_info`). 2026-09-11.
- [x] **QW3** `zcl_stg_url` + `zcl_stg_request_context` (all req facets, filter
      facet, `get_osql_where_clause`, `convert_select_option`) +
      `zcl_stg_dispatcher` (GET entity set / entity / `$count` / `$metadata` /
      service document, `$top/$skip/$orderby/$inlinecount`, OData error
      bodies, 501 for writes). 24 ABAP Unit + 8 mocha. 2026-09-11.
- [x] **QW4** `$filter` → SELECT-OPTIONS: `zcl_stg_filter` (tokenizer,
      recursive-descent parser, range converter). Per-property ORs joined by
      AND, ge/le → BT, ne / not-eq → E EQ, startswith/endswith/substringof →
      CP, datetime/guid/bool literals; inexpressible filters leave the table
      empty and pass the raw string. Unknown property → 400. 2026-09-11.

## Call with Lars, 2026-09-12 (what was agreed; the details stay off the record)

- **Upstream PRs are welcome, one fix at a time, small scope.** Anomalies go
  upstream as separate fixes, not into our workaround pile. NPM releases lag
  the merge; plan for it (#1829–#1832 merged the same day, release pending).
- **open-abap-odata license (#39):** no license is deliberate; Lars leans
  towards MIT but has not decided. Issue closed after the call. Our stance
  stays: interfaces as the spec, clean-room MIT implementation here.
- **open-abap-odata's original goal = ours:** a full OData runtime written in
  ABAP so old Gateway services run on Steampunk without SEGW ("replace the
  runtime, not the services").
- **Nothing that auto-connects to a real SAP system** goes into Lars's repos.
  A "local runtime → real system for missing FM/class, human in the loop"
  bridge is a side project on our side only.
- **Tooling stance (Lars):** catch mistakes with the linter, not with LLM
  rules; no skills/MCP; Node is enough; DDIC/standard-class scaffolds in
  abapGit form belong in `dependencies`.
- **Look at:** open-abap-gui (browser-only front + transpiled back on GitHub
  Pages, visual before/after diffs in PRs; classic reports → classes).
- **Open:** collaboration model (PRs straight into open-abap-odata vs our
  fork as the source); abapGit REST API as the blessed deploy path; whether a
  local SADL / V4 / RAP simulator is needed at all. RFC and a DIAG front:
  "cool but not necessary".

### Links Lars shared after the call (public)

- [larshp/hithub](https://github.com/larshp/hithub) — GitHub clone in ABAP,
  MIT, active. `docs/preview-deployments.md` is the pattern to copy: the
  transpiled app + SQLite-compiled-to-JS bundled by webpack into a **service
  worker**, served from GitHub Pages per PR, screenshots + visual diffs
  against `main`, pinned clock so diffs are deterministic. Same ICF shim we
  use. Has its own `ANORMALIES.md` and an abapGit-metadata script.
- [larshp/zqjs](https://github.com/larshp/zqjs) — a JavaScript engine in ABAP
  derived from QuickJS. The answer to "Steampunk has no JS engine".
- [larshp/stock-allocation-fun](https://github.com/larshp/stock-allocation-fun/pulls)
  — one task, one PR per model (Opus 5, Sol, Astra, Ox Alpha, DeepSeek…): a
  model bake-off on ABAP with preview deployments as the judge.
- [Flow one-pagers](https://docs.heliconialabs.com/flow-onepagers.pdf)
  (Heliconia Labs, July 2026) — abapGit Flow process deck; one-pager 11
  "Transport Sequencing and Preview Deployments" is where a local Gateway +
  Fiori preview per PR would slot in.
- [OpenCode Go](https://opencode.ai/go) — flat-fee key for open-weight
  models with OpenAI/Anthropic-compatible endpoints; the tooling direction
  Lars mentioned (nothing vendor-specific).
- [Gallo, DEFCON 20 (2012): Uncovering SAP vulnerabilities, reversing the
  Diag protocol](https://defcon.org/images/defcon-20/dc-20-presentations/Gallo/DEFCON-20-Gallo-Uncovering-SAP-Vulnerabilities.pdf)
  — the public prior art for DIAG (Core Security, later pysap). Citable in
  `docs/layers-we-own.md`.

**Done 2026-09-12: object page.** `sap.suite.ui.generic.template.ObjectPage`
in the manifest, `UI.Facets` + `UI.FieldGroup#General` + bookings through
`to_Bookings/@UI.LineItem`; non-draft Edit/Save. The gateway now does what
the Gateway does on PATCH/MERGE: `get_entity` first, the request laid over
it (`zcl_stg_entry_provider->set_base`), so Fiori's MERGE of one field no
longer blanks the rest. Fork: `bind_structure` derives
`sap:display-format="Date"` for DATS fields (dates render as dates).

**Lars, 2026-09-12 (afternoon):** invited `oisee` as collaborator on
`abaplint/transpiler` and `open-abap/open-abap-odata`, saw the preview
("looks promising") and said yes to backporting the steamgate work into
open-abap-odata; later the same day: self-merging there is fine, he has no
time for it. **Queue drained 2026-09-12 evening:** #43 associations, #44
function imports, #45 expanded reads, #46 SADL interfaces + annotations,
#47 display-format Date, #48 searchable, all merged (CI green, squash).
Fork `main` == upstream; `abap_transpile.json` now takes upstream directly.

**Done 2026-09-12: value helps.** `StatusVHSet` in the demo MPC/DPC,
`Common.ValueList` on Status and TravelId, `Common.Text` + `TextArrangement`
(StatusText filled by the DPC), `search` → `iv_search_string`; e2e opens the
F4 dialog, searches, picks, filters. Next in this line: object page
(`$expand` to bookings, edit), then `$search` on the list, console cleanup.

**Done 2026-09-12: the preview build.** `npm run web:preview` puts the gateway
into a service worker (sql.js), `preview.yml` deploys `main/` and `pr-<n>/`
to GitHub Pages with screenshots; `docs/preview-deployments.md`. Visual diffs
against `main` (hithub's `generate-screenshot-diffs.mjs`) are the next step.

## Backlog: SEGW offline (decided 2026-09-12, "отличный план")

SEGW is two things: an editor for the project tree and a generator. We do
the generator, the editor is the file.

1. **IWMO/IWSV → registry. Done 2026-09-12 evening.** `tools/segw-registry.mjs`
   reads `<service>.iwsv.xml` (group → model, service → DPC class) and
   `<model>.iwmo.xml` (model → MPC class), joins them by model + version and
   generates `gen/segw/zcl_stg_segw_registry`; the demo now carries its own
   IWSV/IWMO and registers itself, the servers call the generated class. Over
   the corpus it finds 11 services in 8 repos, incl. a SADL one whose DPC is
   `CL_SADL_GTK_EXPOSURE_DPC` and a project whose classes end in `_CUST`, not
   `_EXT`: class names must come from the objects, never from a convention.
2. **IWPR → `_MPC`/`_DPC` generator. First cut 2026-09-12 evening:**
   `tools/segw-gen.mjs` reads the tree (`SBD_*` design: project, model,
   service, generated artifacts, operations per set; `SBO_*` model: entity
   types, properties, sets, associations, association sets, navigation
   properties, referential constraints, complex types, function imports and
   parameters) and writes `_MPC`/`_DPC` `.clas.abap` + `.clas.xml` and the
   two empty `_EXT`. `--check <folder>` diffs against the classes SEGW made
   from the same IWPR. Corpus score: `abap_simple_odata_service` all four
   files byte-identical (timestamps masked); DPC `.abap` identical on 5 of
   7 projects, the other 2 identical modulo method declaration order
   (abapGit version); MPC differs by known things only: text-element labels
   (the tree does not say which labels came from DDIC and which were typed:
   an option later), `super->define( )` of older releases (`--super-define`),
   `set_conversion_exit`, and two repos whose classes were generated from an
   older tree than the one committed. Not yet: RDS templates (`define_rds_n`,
   SADL DPC delegation), media, text pools. `_EXT` never overwritten.
   **Second cut 2026-09-12 night, against SAP's own sample projects from
   A4H** (`docs/segw-mapping.md`): operations mapped to RFC/BOR modules
   (DS_TYPE 2, signature from the abapGit function group, `--lib`) and to
   search helps (DS_TYPE 6) are generated as SEGW writes them; SADL over
   CDS and EPM objects joins DDIC; complex types over DDIC structures,
   `set_action_for`, complex return types, `set_semantic`, `set_as_etag`,
   the real nullable flag, decimal digits/scale, entity-set flags read the
   way the tree means them. [`/IWBEP/GWSAMPLE_BASIC`](https://help.sap.com/docs/ABAP_PLATFORM_NEW/68bf513362174d54b58cddec28794093/59283fc4528f486b83b1a58a4f1063c0.html) DPC now comes out
   line-identical; the RFC DPCs differ by release drift only (2012 key
   loops vs 2013 converted keys). Redefine and annotation-model projects
   are recognised and skipped. Corpus (third-party) still identical.
   The project tree mixes sources: `SBD_DS.DS_TYPE` (5 = DDIC structure;
   the corpus has 14) and the `GENERATED_METHODS_RDS` attachment for
   reference data sources (CDS via SADL; 2 corpus projects, they call
   `cl_sadl_gw_model_exposure` in `_MPC_EXT` and `create_for_sadl` in
   `_DPC_EXT`). The generator must route RDS entities to our SADL runtime
   and leave DDIC ones to the hand-written DPC. RFC/BOR mapping: done
   (second cut, above; runtime side = the RFC replay client). ODC (external
   services) exists in SEGW but not in any oracle we have: out of scope.
3. **Edit the model without a system. First cut 2026-09-12 night:**
   `tools/stg-compile.mjs` (`docs/stg-compile.md`): `<service>.stg.yaml` →
   IWPR (deterministic node ids) + IWSV/IWMO + the four classes through
   segw-gen; sources none / `struct:` / `table:` / `cds:` (SADL); the demo
   model as `src/demo/zstg_demo.stg.yaml`, round trip through segw-gen
   `--check` identical, IWSV/IWMO byte-identical to the demo's, compiled
   classes lint clean. Same night: `stg-compile --all` in transpile
   (`gen/stg/`, `src/` wins by object name) and `service:`+`set:` = local
   ODC through `zcl_stg_odata_client` (`src/demo_odc/`, `ltcl_odc`), and
   per-operation `function:`/`searchhelp:` mappings (the YAML twin of the
   mapped fixture gives segw-gen's methods method for method). Then
   `annotations:` in the YAML → `ZCL_<project>_MPC_ANN` over
   `vocab_anno_model` (open-abap-odata #61 object model, #62 `sap:label`
   from the property annotation), the demo's `webapp/annotations/` deleted.
   Complex types followed (`complexTypes:`, a property `type: <complex
   type>`, `returns: {complexType:}`; segw-gen had the templates from the
   ESH sample). Include and function imports over a module wait for an
   oracle: no corpus project has either (`docs/stg-compile.md`, Not yet);
   two small SEGW projects on A4H (an included model, a function import
   mapped to an RFC) would give it, on Alice's say-so.
4. **SEGW as an application. Foundation 2026-09-12 night:** generic CRUD
   over `table:` sources (`zcl_stg_tab_<table>` classes from cds2ddic,
   create / update / delete / get_entity in `zcl_stg_sadl_dpc`), the first
   two project-tree tables `ZSTG_SBD_PR` / `ZSTG_SBD_PRT` under
   `src/segw/ddic/` and `ZSTG_SEGW_SRV` from `src/segw/zstg_segw.stg.yaml`
   (`ltcl_crud`: POST 201, GET, PUT 204, `$filter`, DELETE 204, 404 after).
   Same night, the tables (`docs/segw-tree.md`): all 53 `SBD_*` / `SBO_*`
   tables of 21 real SEGW projects, generated from a derived spec
   (`tools/segw-tables.mjs`, fields in SEGW's order, keys as unique
   prefixes, `STG_SEQ` for row order), `ZSTG_SEGW_SRV` with one entity per
   table, `tools/segw-tree.mjs` import / export: every SEGW-written IWPR
   file round trips byte for byte (BOM aside); the hand-written fixtures
   and stg-compile's output do not, because they write fields and orders
   SEGW does not (list in the doc, for the stg-compile owner). Cloud pass
   `npm run segw:cloud`: 155 issues, 133 of them the 7.02 SELECT form the
   downport rule asks for. Then: stg-compile writes SEGW's field set and
   order (6c78bf9), push / pull and `ImportSet` through the service
   (ef500bc, 19f9a0e), and the editor app `webapp/segw/`
   (`docs/segw-editor.md`): the tree of a project over `ZSTG_SEGW_SRV`,
   nodes edited in place (MERGE), Create for every model node kind
   (types, sets + operations, associations, navigation, function imports,
   parameters, properties), Delete via `NodeSet`, Import IWPR via
   `ImportSet` / `FunctionGroupSet`, Export through `ExportSet`, Generate through `GenerateSet` (files landed by a dev route of `test/start.mjs`)
   (`tools/segw-editor.mjs`, output in `gen/segw-editor/`; that route was
   cut on 2026-09-25, host-tools review C1), launchpad tile
   `SegwProject-manage`, `test/e2e/segw.spec.mjs`. Generate in ABAP landed
   in three stages (16d7988, 3c50c73, a913296: MPC, DPC + EXT pair, RFC
   and search-help bodies with `ZSTG_FM_PARAM`), every file byte-identical
   to segw-gen over the corpus. Where a project's files land on a system is
   answered too (Alice, 2026-09-13, "вариант 1"): `RepoSet` / `RepoFileSet`
   give the project as an abapGit repository (`.abapgit.xml`, the package,
   the tree, IWSV/IWMO, the classes), abapGit pulls it and creates and
   activates the classes; we write nothing into a live system. The other
   route (a class over the Class Builder and a transport) stays unbuilt.
   Next: SEGW's wizards (DDIC import, map to data source), that pull
   against A4H (needs Alice's go), the editor's download button.

Order: after `$search` / console / T0009 (this list), then 1, then 2.
Merging our own PRs in open-abap-odata: Lars said yes (no time), so the
queue is PR → CI → squash-merge by us. The transpiler stays his to merge. A
second session only for step 2 in its own worktree, if at all.

## Backlog: what we said we did not want, re-assessed 2026-09-12 (three research passes)

**RFC/BOR mapping.** Cheaper than feared. `CALL FUNCTION` to a function
module with source runs already (FUGR → `abap.FunctionModules`);
`DESTINATION` goes to `abap.context.RFCDestinations[dest].call(...)`, one JS
object, no transpiler change. Gotcha: `DESTINATION 'NONE'` is not treated
as local, register it. The corpus has no RFC-mapped project, but every
generated DPC carries the RFC skeleton (`COMMIT_WORK` →
`BAPI_TRANSACTION_COMMIT`, `rfc_save_log`, `log_message`). To do: bodies
for `/iwbep/cl_sb_gen_dpc_rt_util`, `/iwbep/cl_cos_logger`,
`BAPI_TRANSACTION_COMMIT/ROLLBACK` as FUGR over our LUW (1–2 days, given
to the transpiler session); BAPIs without source: stub FMs over SQLite,
or capture/replay JSON through vsp (`.local/` only, 1–2 days), or the
human-in-the-loop bridge (side project only). BOR/SWO1: dead, ignore.

## Demo parity (2026-09-12 night)

Done: Create on the object page's bookings table (`POST
TravelSet('T0001')/to_Bookings`: the dispatcher creates in the target set
and hands the DPC the parent keys, the navigation path and
`iv_source_name`; a to-one navigation is 405, other writes through a
navigation stay 501), the booking's own object page below the travel, a
second app (`webapp/booking/`, list report + object page over
`BookingSet`), `webapp/flp.html` = the `sap.ushell` sandbox with both apps,
`UI.DataFieldForIntentBasedNavigation` ("Open in Bookings", hidden without
a launchpad) and `UI.DataFieldWithIntentBasedNavigation` back. Both keys
travel with the intent, so the target app lands on the object page. Not
done, by choice: draft, inline create in the table (draft-only in FE V2).

Order after this: ~~`stg-compile`~~, ~~ODC-local~~, ~~`function:` in the YAML~~ (done, step 3 above), then annotations in the file, draft last; the
search-help provider is with the transpiler session; the live RFC client
(open-rfc npm, record mode, replay substitutions) waits for a go.

## Media entities, 2026-09-13

The demo serves a picture per travel: `PhotoSet` is a media entity
(`set_is_media`, `m:HasStream`), its bytes come from `ZSTG_PHOTO` through
the DPC's `GET_STREAM` and go back through `UPDATE_STREAM`, the gateway
answers `<entity>/$value` with the bytes and their MIME type
(`ty_response-body_x`, `set_data` instead of `set_cdata`), and the JSON of
such an entity carries `media_src` / `edit_media`. `UI.IsImageURL` on a
property whose value is that URL is what Fiori Elements renders, so the
list report has a column of pictures and the object page a header image.
Library side: open-abap-odata #63 (`set_is_media` was `ASSERT 1 = 'todo'`).
`media: true` in a `stg.yaml` entity writes `IS_MEDIA` into the tree and
segw-gen emits the `set_is_media` line, which also removes one difference
against the two corpus MPCs that have media entities. The whole story is in
[`docs/media-entities.md`](docs/media-entities.md); not yet: `CREATE_STREAM`
with a slug, deleting a media resource, streaming instead of one `xstring`.

## The Fiori apps: real ones, and what deploying them to a system takes (2026-09-13)

Asked by Alice, answered from the tree: our apps are not a simulation of
Fiori, they are Fiori. `webapp/<app>/` holds what any SAPUI5 app holds
(`Component.js`, `manifest.json` descriptor version 1.59 with `sap.app` /
`sap.ui` / `sap.ui5`, `dataSources`, `models`, `crossNavigation` inbounds
and outbounds, `i18n/`, and for the freestyle SEGW editor `view/` +
`controller/`). UI5 itself comes from SAP's CDN (1.120.50): Fiori Elements
V2 templates, the smart controls, `sap.ushell`. What open-steamgate
replaces is only what sits below `/sap/opu/odata/sap/`.

So the apps can be deployed as BSP applications (`WAPA`, abapGit or
`/UI5/UI5_REPOSITORY_LOAD`, deploy-back is the vsp sibling's job). Three
things differ between the repo and a deployed copy, none of them
structural:

- `sap.app.dataSources.mainService.uri`: ours is relative to the mount
  (`../sap/opu/odata/sap/…`), a deployed app wants `/sap/opu/odata/sap/…`.
- the bootstrap in `index.html`: ours is the CDN, a system's is
  `/sap/public/bc/ui5_ui5/resources/sap-ui-core.js`; under a launchpad the
  page is not deployed at all, the shell loads the Component.
- `webapp/flp.html` + `launchpad.js` are the sandbox and stay here; on a
  system the tiles are catalog content and target mappings over the
  `crossNavigation.inbounds` the manifests already declare.

Plus `ui5 build` for `Component-preload.js` (we run with
`componentPreload="off"`, fine locally, slow on a system). The looks are
the same modulo the system's UI5 version and theme. What the sandbox does
not have: roles, catalogs and personalization (test adapters), logon,
a real CSRF handshake, translations beyond the default language.

**Backlog item:** try it once on A4H, on Alice's say-so: a BSP with the
Travels app, the three changes above, a tile over `Travel-manage`, next to
the transpiled `ZSTG_DEMO_SRV` deployed the same way. That is the end-to-end
proof that a service and its app built offline land on a system unchanged.

## RFC replay (2026-09-12, transpiler session)

`CALL FUNCTION ... DESTINATION x` is served without a system:
`tools/rfc-replay.mjs`, installed by `test/setup.mjs`. `'NONE'` and `''`
run `abap.FunctionModules` in this process (the odata library registers
`'NONE'` the same way from every DPC); any other destination replays a
capture from `STG_RFC_CAPTURE` (default `.local/capture/a4h/rfc`, never
committed): `<folder>/<FUNCNAME>/<n>.json` with `params` (the input by
name) and `result` (the exports by name), exactly what `rfc call <FM>
<json>` of open-rfc-go takes and prints, plus optional `exception`/`subrc`
for classic exceptions. Direction of each name comes from the caller's
signature at replay, so a capture needs no direction markers; the split form
`exporting`/`tables`/`changing` + `importing_out`/`tables_out`/
`changing_out` is accepted too. Selection: exact input match (trailing blanks
and name case ignored), then the scalar parameters only, then the first
capture; no capture at all is an error that names the function module and
the `rfc call` line to record it. `test/rfc-replay.mjs` runs on synthetic
captures in `test/fixtures/rfc/`; real captures are Alice's, made through
open-rfc-go against A4H, and stay under `.local/`. Reference service for it:
ZSTG_RFC (steamgate session, in A4H).

**ODC / Include / Redefine.** Not in the corpus at all. Simulate: (a) a
local "external" service = a second MPC/DPC in the registry called
in-process through `zcl_stg_dispatcher=>dispatch` with a small
`zcl_stg_odata_client` (2–3 days, the core); (b) an online service through
`cl_http_client` (real HTTP in Node via `@KERNEL`; the preview needs a
fetch branch and CORS is not ours), +2 days; (c) an express proxy route
(half a day, a bypass, not composition). Include = merge two model infos;
Redefine = inherit from the other service's `_EXT`.

**Our own composition layer ("CAP for SEGW").** `*.stg.yaml`: one service,
entities from `cds:`, `table:`, `function:`, `service:` (include/ODC),
`abap:` (hand-written DPC), annotations in one place. `tools/stg-compile`
emits IWPR + IWSV/IWMO/IWSG (real abapGit objects → deploy into SEGW),
`_MPC`/`_DPC` through `segw-gen`, and routes `cds:` to SADL, `table:` to a
generic Open-SQL DPC, `service:` to the client above. First step (1 day):
`cds:` + `abap:` only, the demo rewritten on it, `--check` against the
demo's IWPR byte-identical. That is backlog step 3 ("edit the file").

**BOPF / draft.** A Fiori Elements V2 draft app needs, on the wire: a
compound key `DB_KEY + IsActiveEntity`, `DraftAdministrativeData` and
`SiblingEntity` navigations, four function imports Edit/Activation/
Preparation/Validation with `sap:action-for` and `sap:applicable-path`,
`Common.DraftRoot`, and the request flow create → MERGE in changesets →
Activation / DELETE draft. All of it is generic: a draft table per entity
(generated from `@ObjectModel.writeDraftPersistence`), routing by
`IsActiveEntity` in `zcl_stg_sadl_dpc`, the four actions implemented once,
one shared draft-admin table. ~9 days to a working draft app (guid/boolean
keys 1, SADL writes 2, draft metadata 2, actions 2, e2e 1, downport of
7.40 MPC/DPC 1). What cannot be shimmed: real BOPF determinations/
validations/actions in customer code; abapGit does not serialize the BO
model, so `/bobf/` stubs (+5–8 days) only pay off with a second BOPF repo
in the corpus. Every corpus SADL exposure is `maxEditMode="RO"`: writes
have no real oracle. Locks and `DraftIsCreatedByMe` need a user, ours is
fixed.

Decision pending (Alice): which of these enters the plan and in what
order; the composition layer and RFC shims are the cheapest, draft the
most visible for Fiori people.

**Live and record (2026-09-12, later the same day).** `tools/rfc-live.mjs`:
a live client on the `open-rfc` npm package (SDK-free TypeScript, node
22.14+, zero dependencies; loads on node 26 too), one session per
destination opened on the first call and closed when the process ends,
same runtime signature in and the same JSON convention out as the replay
(`toJson`/`fromJson` shared), classic exceptions mapped to `sy-subrc`
through the caller's EXCEPTIONS, anything else thrown. `record` is live
plus a capture file per call in the replay format, so a captured dataset
comes out of an end-to-end run. `.local/rfc-destinations.json` (never
committed; `docs/rfc-destinations.example.json`) maps destination names to
kinds `local | replay | live | record | fallback`; `connection` is an
object in the node-rfc convention or a path to an open-rfc-go `.rfc.json`
(`~/.rfc.json#A4H`). Replay results take placeholders (`{{param:IV_X}}`,
`{{now:YYYYMMDD}}`, `{{seq:NAME:8}}`, `{{sql:SELECT ...}}` against our
database) so a read after a create finds what was created. Live is node
only; the preview keeps local and replay. Tests fake the open-rfc client;
a run against A4H is by hand, on Alice's say-so, never in CI.

## DDIC routing rule (Lars, chat 2026-09-12 evening)

- **open-abap-core takes only released data elements** (C1 contract); he
  wants core small.
- Everything not released goes to **open-abap/open-abap-deprecated**
  ("deprecated artifacts", MIT, empty as of today): PRs there for what the
  on-prem corpus needs (`/IWFND/SU_ERRLOG`, CRM/BOPF/LXE structures).
- **abapedia/s4-private-2022-doma-and-dtel**: released + deprecated DOMA/DTEL
  of S/4 2022 in abapGit form (23,661 DTEL, 189 DOMA, 2.5 MB, **no license
  file**): cloned into `.local/lars/`, picked up by `segw:closure` as an
  optional library; not vendored, not a transpiler lib until the license is
  clear. With it the missing-DDIC bucket of the corpus went from 1143 to
  947 issues (abap_simple_odata_service to 0); what remains is mostly the
  repositories' own Z/Y structures (TABL) and CRM/BOPF pieces.
- The transpiler session re-sorts its core PRs #1213–#1215 by this rule.

## Backlog: client handling, re-opened by OSD (2026-09-14)

`abaplint/transpiler#606` has been open since 2022, and larshp's answer on it
is *"or ignore it? as the client feature is not needed in the
transpiler/runtime — just spin up multiple"*. For a transpiler that runs unit
tests, that is the right call and we agreed with it: one database per client,
and the question goes away. Documented rather than implemented, in
`abaplint/transpiler#1850`.

**OSD changes the calculus, and this is the note to come back to.** An
off-stack doppelgänger is not a test harness — it is a stand-in for one
system, and the thing it stands in for has clients. Three consequences we can
already name:

- **Captured data.** We seed from a real system. If more than one client has
  rows in the capture, every `SELECT` here returns more rows than the same
  statement returns there, and nothing reports it: it reads as "the capture
  was bigger than I thought". Measured: a `CLNT`-keyed table with rows under
  123, 456 and 789 gives 3 rows here and 1 on a system
  (`ANOMALY-2026-09-11-no-implicit-mandt`).
- **"Spin up multiple" costs more here than there.** A second database is
  cheap for a test run and not cheap for OSD, which carries an object store,
  an ADT façade and a serving child per instance. Client isolation by process
  means a doppelgänger per client.
- **It is the same shape as the day's other findings**: output that looks
  right, is plausibly sized, and is quietly wrong, with no error anywhere
  along the path.

None of that is an argument for changing larshp's mind about the transpiler.
It is an argument that *OSD* may want client handling of its own — most
likely in our Open SQL layer rather than in his, so his "not needed in the
transpiler/runtime" stays true and we stop being surprised. Worth costing
before anyone starts: the cheap version is a client predicate added where OSD
builds SQL, the expensive version is `CLIENT SPECIFIED` and client-dependent
`INSERT`/`UPDATE`/`DELETE` semantics, and only the first is obviously worth
it.

Not started. Recorded because the decision to ignore it was taken for a
different system than the one we are now building.

## Backlog: Gateway extension points the corpus really uses (2026-09-12)

Counted over the corpus DPC/MPC classes. Have: `sap:` annotations and
vocabulary in `$metadata`, SADL exposure, `execute_action`,
`get_expanded_*`, every `io_tech_request_context` facet, changeset types.
Missing, in order of use:
- `get_logger` (17) and `get_message_container` (8) from
  `/iwbep/if_mgw_conv_srv_runtime`: check what open-abap-core stubs and
  make them real (messages must reach the OData error body).
- `set_header` (5) / `get_request_header` (2) on the runtime: response and
  request headers from the DPC.
- media: `get_stream` / `create_stream` (4 each), `$value`, `set_is_media`.
- changesets: `changeset_begin` / `changeset_process` / `changeset_end`
  (4); today `$batch` calls the operations one by one.
- vocabulary annotation providers: `vocab_anno_model` (2) in `_MPC_EXT`,
  `/iwbep/if_mgw_vocan_model`, `IWVB` objects.

## Ideas parked (2026-09-11)

The current register of ideas, with status and reason for each, is
[`docs/ideas.md`](docs/ideas.md) (from 2026-09-25; ADRs 0003 and 0004).
The entries below are the first round, kept as they were.

- **DuckDB: done as a spike 2026-09-12** (section above). ClickHouse would
  be the same adapter shape without UPDATE/DELETE semantics; not started.
- **SADL-lite: done 2026-09-12** (see the section above); joins and writes
  remain.
- **SAP GUI front (DIAG) for reports and dynpros.** Orthogonal to OData: the
  DIAG sibling already has the protocol reverse-engineered (SAP-LZH writer
  included). open-abap-gui models a classic report / dynpro / selection screen
  through host interfaces (`zif_gg_report_v1`, dynpro builders) and renders
  HTML; a DIAG renderer behind the same host interfaces would let a real SAP
  GUI log on to the local runtime. Separate project, shares the transpiled
  runtime and the DDIC capture with this one.
- **`capture` tool:** probe JSON → abapGit data config for exactly the
  DTEL/DOMA/TABL/TTYP + TABU rows a DPC needs → `.local/capture/<system>/`
  as a lib. See the closure doc.

## Cheap checks that could shrink the plan

- [x] ~~Does fe-mockserver *evaluate* `$filter`?~~ **Moot, 2026-09-13.** No
  fe-mockserver is used at all: the wire layer had to be ABAP to run in a
  system's ICF, so `$filter` is parsed and turned into SELECT-OPTIONS in
  `src/gateway/zcl_stg_filter`, `$metadata` / `$batch` / the JSON are ABAP
  too, and the project has no `@sap-ux/*` dependency. The same answer retires
  the other two checks (the data-access seam, pointing the UI5 middleware at
  an external endpoint): express serves `webapp/`, SAPUI5 comes from the CDN,
  and the files deploy as a BSP unchanged (see "The Fiori apps").

## Un-swept sources to check

- [ ] `SAP/abap-file-formats` + `-tools` (official SRVD/SRVB/DDLS/BDEF/IWSG
      spec).
- [ ] Standalone OData parsers: `odata-v4-parser`/`-literal` (Jaystack),
      `@cap-js/cds` `cds.parse.expr`.
- [ ] Alternative wire layers: `odata-v4-server` (Jaystack),
      `@cap-js-community/odata-v2-adapter` (cov2ap, battle-tested v2).
- [x] open-abap org: base-class impl of `/IWBEP/CL_MGW_ABS_DATA`/`ABS_MODEL`;
      open-abap-odata branches/history for a fuller gateway. Swept 2026-09-11:
      no-op base only, single `main`, no fuller gateway; `open-abap-sadl/cds/rap`
      are interface stubs (audit §3).

## Build order (see docs/prior-art.md §4)

0. Substrate stand-up (reuse) → 1. Gateway model + dispatch → **2. request-
   context bridge (crux)** → 3. wire layer → 4. Fiori serving.
