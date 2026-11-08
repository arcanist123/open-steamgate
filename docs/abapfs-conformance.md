# ABAP-FS conformance

How well the ADT façade serves [ABAP-FS](https://github.com/marcellourbani/vscode_abap_remote_fs)
(`murbani.vscode-abap-remote-fs` 2.10.3, MIT, Marcello Urbani). The aim is for
OSG to be the local system ABAP-FS can browse, edit, check, activate and test
against with no SAP system behind it, and to name what it still cannot do.

There are two layers:

1. **Protocol layer** (this document, done). ABAP-FS's own ADT client is run
   against the façade, call by call, as the extension calls it. It takes
   seconds and needs no VS Code.
2. **UI layer** (planned, below). The real extension is driven in a real VS
   Code under Xvfb, with screenshots.

Both run on demand. Neither is part of `npm test`.

## Run it

```sh
npm run conformance:abapfs -- --start             # own OSG on :3393, stopped afterwards
npm run conformance:abapfs -- --url http://localhost:3030   # a system that is already running
npm run conformance:abapfs -- --start --only write,create   # some groups (connect always runs)
npm run conformance:abapfs -- --start --update-expected     # accept the current matrix
```

`--update-expected` refuses to write after an aborted or unclean run. A
scenario that did not run keeps its previous expectation.

`--start` runs `test/run.mjs` from this checkout with `STG_PORT` and a
database under `.local/conformance/abapfs/db/`. It waits for `/osd/serving`
and stops the process group at the end. It needs a built generation
(`npm run transpile`); use `tools/osd-heavy.sh` for contended heavyweight
builds so the host assigns the instance and ports.

Output:

- `.local/conformance/abapfs/report.md`: the matrix (feature → endpoints →
  result → ms → note), the gaps sorted by user impact, and the diff against
  the expectations;
- `report.json` in the same folder: every scenario with each HTTP call and
  its status;
- a summary on stdout.

The exit code is 1 on a regression against
`test/fixtures/abapfs-conformance/expected.json`, meaning a PASS that was
lost or a MISSING that became a FAIL. It is 2 if a restore failed or anything
was left behind:

- **On the system.** A scratch object counts as gone only when a read
  answers a confirmed 404. A timeout, an auth error or a 500 is reported as
  "existence unknown".
- **In the checkout.** With `--start`, every tracked and untracked file
  (except `.local/`) is recorded before the run, as git sees it: its mode and a content hash and again after OSG has
  stopped. That also catches a second change to a file that was already
  dirty. With `--url` the checkout is not this tool's to judge, so the repo
  check is skipped and the report says so. The system-side cleanup is still
  verified.

## Against osgo

The `osgo-host` CI job runs this harness after the shared ADT conformance
runner, against the same binary and server started with `-adt`. It uses
`test/fixtures/abapfs-conformance/expected-osgo.json`: `only` selects the
groups in one place, and `ratchet: true` fails every status change, including
FAIL→MISSING and a PASS improvement, until the baseline is recorded. Every gap
has a reason. The client
is installed by the harness with its pinned `npm ci`; no separate client
installation or unpinned dependency cache is needed.

Build and run from the repository root with dependencies installed (`npm ci`,
Node 22 and Go 1.26, plus the project's fetched libraries/toolchain). Use one
heavy allocation so the server uses its assigned `STG_PORT`:

```sh
OSD_HEAVY_RANGE=90-99 GOCACHE=/tmp/osg-go-cache tools/osd-heavy.sh sh tools/abapfs-osgo.sh
```

[`tools/abapfs-osgo.sh`](../tools/abapfs-osgo.sh) uses `set -eu` to stop
immediately on a staging, transpile or build failure. CI calls the same script
with `--setup-only`: it stages the synthetic outline fixture in `src/` and the
live source snapshot, transpiles, stages the fixture again in the new live
generation, writes and verifies the executable compiler launcher
`tools/gogen/.out/osd` (Node → `bin/osd.mjs`), then builds osgo. The tracked
ABAP-FS fixture/write package in `src/zosd_test/` (`$ZOSD_TEST`) enters the
generation with `src/` as a writable store root; Go also supplies the `$TMP`
package. The full recipe checks the ADT
compiler gate, starts the server, runs the pinned client, propagates its exit
code and stops the server. Reports go to `.local/conformance/abapfs-osgo/`.

Readiness keeps `/osd/serving` authoritative for Node. A 404 or non-JSON
response falls back to `/sap/bc/adt/discovery`: a 401 proves the ADT path is
there, while a 200 must have an Atom service-document content type and root
element. Each request has its own deadline, so a stalled response cannot hang
the wait.
The osgo expectations select every group, `write` included, since source save
landed on osgo (#855). An explicit `--only write` overrides them for diagnosis.

Measured at `6847c55a` (main after #855) and again on
`feat/osgo-adt-read-families`, every group, osgo `-adt` built by the recipe
above:

| | PASS | FAIL | MISSING | of |
|---|---|---|---|---|
| main `6847c55a` | 25 | 1 | 21 | 47 |
| with `go/adtpreview` + `go/adtread` | 28 | 1 | 18 | 47 |
| with `go/adtactivate` + `go/adtunit` | 30 | 1 | 16 | 47 |
| with the function, message, include, preflight, where-used and core discovery families (ABAP) | 37 | 0 | 10 | 47 |

The three that moved are `data.freestyle`, `data.table` (the data preview
routes are mounted once `abap.ADTPreview` says the host answers SYSTEM SQL in
the request's own step) and `activate.inactiveObjects` (a Go continuation of
the HOST verdict, as the Node facade serves it). `activate.object` and
`unit.run` moved next (`feat/osgo-adt-activate-unit`): activation checks and
publishes in the object store, with a rebuild warning when the code changed,
and ABAP Unit runs the fixture's test class compiled into the binary
(docs/osgo-adt-activation.md). What is left, and why:

Then `feat/osgo-adt-more-families` (2026-11-08,
docs/adt-abap-port/family-specs/functions-messages-xref.md) moved seven
more, on both hosts at once because they are ABAP in `src/adt/`:
`object.FUGR`, `object.FM` and `object.MSAG` (ZCL_OSD_ADT_FUNCTION and
ZCL_OSD_ADT_MSAG over the abapGit files of the store, the group's parts read
through STORE READ by program name), `object.INCL.mainprograms`
(ZCL_OSD_ADT_INCLUDES over D010INC), `whereused.references`
(ZCL_OSD_ADT_WHEREUSED over WBCROSSGT; osgo seeds the cross-reference at
build), `create.validate` (the preflight is native ABAP over STORE OBJECT,
so `programs/validation` and `includes/validation` join the OO and package
forms, on osgo too, whose store has no PARSE CREATE_VALIDATION) and
`debugger.coreDiscovery` (core discovery holds one collection per workspace,
which is the form the pinned client parses). What is left, and why:

| Scenario | osgo | Node | Why |
|---|---|---|---|
| `editor.completion`, `editor.elementinfo`, `editor.definition`, `editor.typehierarchy`, `editor.prettyprinter` | MISSING | MISSING | Route not served on either host. An empty proposal list, an empty hierarchy or an identity pretty printer would be well-formed and false: the user would read "no proposals" or "already formatted" where the system has simply not looked. These need the compiler's symbol table in the request's step and are not stubbed. |
| `transport.userTransports`, `transport.configurations` | MISSING | MISSING | Route not served: there is no CTS (`transport.check` answers "no transport needed" and passes). An empty `tm:root` would be true, but discovery does not advertise the CTS workspace, so ABAP-FS never asks; the kit asks directly. Left unserved rather than serving a view of a transport system that does not exist. |
| `atc.customizing`, `atc.run` | MISSING | MISSING | Route not served: no ATC. A run that answers zero findings without having checked would be a lie. |
| `debugger.breakpoints` | MISSING | MISSING | Route not served: no ADT debugger; a breakpoint that nothing will hit is not set. |

So no scenario Node serves is MISSING on osgo, and every MISSING is a route
nobody serves, each for a stated reason.

The same client against the Node host, measured the same day with
`--start` (`test/run.mjs`, the default child mode, whose ADT front runs in
the reduced parent kernel): **35 PASS, 0 FAIL, 12 MISSING**, the two extra
MISSING being `object.INCL.mainprograms` and `whereused.references`, whose
routes read D010INC and WBCROSSGT and are registered only where the kernel
has those tables (ZCL_OSD_KERNEL_GUARD=>HAS_CROSS_REFERENCE). With
`OSD_ADT_ONE_RUNTIME=1`, the ADT step in the serving child, the Node host
measures **37 / 0 / 10** like osgo. `test/fixtures/abapfs-conformance/expected.json`
records the default mode.

## The client, and why it is pinned this way

The tool uses `abap-adt-api` 8.4.3 (MIT), the library ABAP-FS 2.10.3 ships.
Its version and integrity come from ABAP-FS's `pnpm-lock.yaml`. The library
is **not** in the root `package.json`. `tools/abapfs-conformance/` holds a
`package.json` and a `package-lock.json` of its own. Its `overrides` pin
every transitive package to the version in that same pnpm lock: 42 packages,
and every integrity in our lock equals the one in theirs. On first use the
tool copies the pair into `.local/conformance/abapfs/deps` (ignored) and
runs `npm ci` there, which verifies each tarball's integrity.

Why a separate lockfile rather than a bare fetch of one tarball: the library
has seven dependencies. Their transitive versions decide how the XML is
parsed (fast-xml-parser 5.11.1), and floating them would test a client
ABAP-FS does not ship. Why not the root package: the main install would carry
a dependency that only an on-demand check uses.
`test/adt-abapfs-conformance.mjs` checks that the lock still pins the
ABAP-FS integrity and that the licence is MIT.

## Coverage

Every scenario is a sequence of client calls taken from the extension's
source, with the extension's own arguments. The client logs in with a dummy
user and password, client 001, and uses a stateful session for lock, write,
delete and activate. Reads go through its stateless clone, as ABAP-FS does.
Fixtures are the `$ZOSD_TEST` package, which has one object of each kind and
a test class with one pass and one deliberate failure.

| Group | Scenarios |
|---|---|
| connect | compatibility/graph login + CSRF token, stateless clone, discovery and its CTS/abapGit gates |
| tree | nodestructure for `$TMP`, `$ZOSD_TEST` and the System Library root, nodepath, object types |
| objects | structure + source for CLAS, INTF, PROG, INCL, FUGR, FM, DDLS, MSAG, TABL; class includes; outline; include main programs |
| write | lock, PUT source with a marker, read back, PUT original, unlock, verify byte-equal |
| check / activate / unit | checkruns on clean and on broken source, activation, inactive objects, ABAP Unit with the deliberate failure |
| search / whereused / editor | quickSearch, usageReferences, completion, navigation target, element info, pretty printer, type hierarchy |
| versions / data | revisions + one revision's content, datapreview freestyle and ddic |
| transports / atc / debugger | transportchecks, transport requests and configurations, ATC customizing and run, core discovery, listeners, breakpoints |
| create | name validation, create + delete of a scratch program in `$TMP` and in `$ZOSD_TEST`, verified gone |

The statuses:

- **PASS**: the calls answered, and the result passed the scenario's check.
  For example, the unit run must report exactly the one deliberate failure.
- **MISSING**: the façade does not serve the endpoint. That is its
  catch-all 404 ("is not served"), or a 501.
- **FAIL**: anything else. That covers a served route that refused, a
  document the client could not parse, or a check that did not hold. A
  routed 404 such as "DEVC $TMP does not exist" is a FAIL and not a
  MISSING.

Safety rules:

- The write scenario restores the original source on every path and
  verifies the restore on every path. A failed or unverified restore is
  fatal: the run stops before activation, and every remaining scenario is
  reported as not run.
- No delete runs without a non-empty lock handle.
- Each scratch object is deleted in its own scenario, and checked again in a
  `finally` at the end of the run, one object at a time. Both checks only
  accept a confirmed 404.

`test/adt-abapfs-conformance.mjs` proves each rule offline with fake
clients: restore-fatal, cleanup after a read error, handle validation, the
MISSING→FAIL regression and the hash diff.

## Current matrix (2026-10-02, fix/tmp-package)

**30 PASS, 1 FAIL, 16 MISSING of 47** (was 29 / 2 / 16 on origin/main
b3df2f86; `create.createDelete` went FAIL -> PASS once `$TMP` became a
package of the store, `tools/osd-tmp.mjs`). A run with `--start` takes 12 to 35
s, including starting the system. Most of the spread is activation. It
answers in under 1 s when nothing needs building, and in about 20 s when it
waits for the rebuild. The syntax check takes about 3.6 s and ABAP Unit about
2 s. Everything else takes milliseconds.

What works end to end:

- connect;
- the tree (`$TMP`, packages, root, reveal);
- opening CLAS, INTF, PROG, INCL, DDLS and TABL;
- class includes and the outline;
- lock/save/unlock with a verified restore;
- the syntax check, which reports errors on broken source;
- activation;
- ABAP Unit, with the failure reaching the client;
- quick search;
- versions;
- SQL and table preview;
- the transport check;
- debugger listeners;
- feeds, dumps and users;
- create + delete in a real package and in `$TMP`.

Gaps, by what an ABAP-FS user loses:

1. **New-object name validation**: class/interface (`oo/validation/objectname`),
   package (`packages/validation`), program (`programs/validation`) and
   include (`includes/validation`) preflights check repository names,
   duplicates and writable parents, in ABAP on both hosts. `functions/validation`
   and `messageclass/validation` stay missing: nothing here creates those
   objects, so their wizards stop before a POST that would be refused.
2. **Code completion** (MISSING, `abapsource/codecompletion/proposal`).
3. **Go to definition** (MISSING, `navigation/target`).
4. **Function groups and modules open** (`functions/groups/*`, read-only; the
   tree lists a group's modules and includes), **message classes open**
   (`messageclass/*`, the document and a text form), **where-used answers**
   at object level (`informationsystem/usageReferences`, over WBCROSSGT),
   and **an include knows its main program** (`mainprograms`, over D010INC).
   Since 2026-11-08; see the osgo table above.
5. **Debugging can start but not debug**: `core/discovery` parses now (one
   collection per workspace); `debugger/breakpoints` is not served.

Then: ATC (customizing, runs), element-info hover, the pretty printer, the
transport organizer and its search configuration (all expected missing),
and the type hierarchy. The transport and abapGit
panels stay hidden on their own, because the façade does not advertise
their discovery gates. That is the intended state while those endpoints do
not exist.

`test/fixtures/abapfs-conformance/expected.json` holds this matrix. A later
run reports each change against it as a regression or an improvement.

## The UI layer (next)

The protocol layer proves what the client library receives. It does not prove
what a user sees. The UI layer follows the harness that osg-demo already uses
for VS Code screenshots (`test/vscode-shots.mjs` there):

- **Real desktop VS Code under Xvfb**, launched with Playwright `_electron`.
  Headless Chromium renders a blank workbench, and code-server adds a
  server we do not need. Use the official linux-x64 tarball, pinned here by
  URL and sha256. Without sudo, Xvfb and xauth come from `apt download` +
  `dpkg -x`.
- **ABAP-FS VSIX pinned by sha256.** Take the release asset, check its hash
  ourselves, and install it with `<tarball>/bin/code --install-extension`
  into a fresh `--user-data-dir` / `--extensions-dir`. Its dependencies
  `larshp.vscode-abap` and `hudakf.cds` are installed and pinned the same
  way (`docs/vscode-workbench-spike.md` has 2.9.1-era hashes).
- **Settings before launch**:
  - `abapfs.remote.osg = {url: http://localhost:<STG_PORT>, username, client: "001"}`;
  - workspace trust off, startup editor none, updates and telemetry off,
    AI features off;
  - the workspace is an `adt://osg` folder in a neutral `/tmp` path.
- **The password prompt** is the one interactive step left (ABAP-FS
  research, PR candidate A). The harness types a dummy password once, and
  ABAP-FS keeps it in its own SecretStorage.
- **Steps mirror the groups above**: open the tree, open a class, edit and
  save, activate, run the unit test (`1 passed, 1 failed`), search, and run
  an SQL query.
- **Waits and evidence**:
  - wait on the proving text, never on fixed sleeps;
  - read output channels from the profile logs;
  - copy screenshots out only when every step passed, and keep the failing
    window otherwise;
  - restore sources and close debug sessions in `finally`.
- **Budget**: 3–5 minutes locally, so it stays on demand and out of CI.

Each gap this protocol layer names gets a UI step, so the UI layer shows the
failure where the user would see it: completion, definition, the create
wizard, and opening an FM or a message class.


Creation compatibility (2026-10-05): the package document includes its own
`adtcore:uri`. ABAP and Node Check decode UTF-8 base64 artifacts even when
source contains one line, only a comment, or syntax errors. Live probes with
ABAP-FS's pinned client passed package/class validation, create, read and
cleanup; VSP `WriteSource(mode=create)` passed source check, write and
activation. VSP `GetPackage` reads a node inventory; its empty top-level URI
is not a measurement of the package document's URI. Eclipse wizard acceptance
still needs an interactive check after deployment.

Eclipse follow-up: discovery also advertises both implemented validation
resources and measured package properties/value-help templates. A resource
that works at a fixed URL is insufficient for clients that discover its URI.
In demo RFC mode without configured backend credentials, the bridge forwards
the logon user's name to the local backend, so new `$TMP` objects are owned
by that user and appear in their tree. Explicit backend credentials stay
unchanged. RFC tests cover owner-filtered trees and nodepath for the editor
and source URI, including the `Link with Editor` follow-up.
