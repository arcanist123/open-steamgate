# Coming from the ABAP Cloud Developer Trial (A4H)

*Written and measured on 2026-11-08 against commit `378b0504`. Every
command below was run on a Linux x64 host; what was not run says so.*

## Who this is for

You learned or practised ABAP on a local **A4H** container (SAP's ABAP
Cloud Developer Trial) and that container is going away. You want a free
system on your own machine that Eclipse ADT connects to, that runs ABAP
Unit, that answers OData to a Fiori app, and that you can put your own
abapGit repository into.

open-steamgate (OSD) is that, with one honest difference up front: it is
**not an SAP system and bundles nothing of SAP's**. It is Lars Hvam's
abaplint transpiler and the open-abap runtime library with a Gateway, an
ADT facade, CDS, SADL, jobs and a launchpad built on top (MIT). Your
`SELECT * FROM sflight` will not work, because there is no `SFLIGHT`;
your class with `cl_abap_unit_assert` and your `_DPC_EXT` will. Section 5
is the table of what A4H has and this does not; read it before you invest
an evening.

The first hour, in order:

1. run it (three ways, pick one),
2. connect Eclipse,
3. bring your own code,
4. run ABAP Unit, F8, the Fiori apps,
5. know the limits.

## 1. Run it

### Ports and identity, side by side

| | A4H (trial defaults) | open-steamgate, `npm start` | open-steamgate, Docker image |
| --- | --- | --- | --- |
| System ID | `A4H` | `OSD` | `OSD` |
| Instance / system number | `00` | `00` | `00` (`INSTANCE`) |
| Client | `001` | ADT and cookies say `001`; **`sy-mandt` in ABAP is `123`** (section 5) | same |
| User / password | `DEVELOPER` / your password | `DEVELOPER` / **anything** (no check) | same |
| HTTP | 50000 | **3030** | 3030 inside, publish where you like |
| HTTPS | 50001 | **44330** (`44300 + port mod 100`), only after `npm run osd:tls` | **44300** inside, certificate made on first start |
| SAP GUI (DIAG) | 3200 | 3200, only with `node tools/protocols/server.mjs` | 3200 inside |
| RFC / gateway (Eclipse *Custom Application Server*) | 3300 | 3300, same command | 3300 inside |

There is no logon check anywhere: whoever reaches a port is `DEVELOPER`.
Outside a container OSD listens on loopback only. A container listens on
every interface, so publish its ports on `127.0.0.1:` or keep the machine
behind a firewall ([`docker.md`](docker.md#which-address-it-listens-on)).

### A. Docker, from the published image

The image is public on GHCR (`ghcr.io/oisee/open-steamgate`, tags
`showcase-draft` with the demo packs and `draft` without, amd64 and
arm64; anonymous pull, no login). One command, with the ports mapped to
the numbers an A4H person already knows:

```sh
docker run -d --name osd \
  -p 3030:3030 -p 44300:44300 -p 3200:3200 -p 3300:3300 \
  -v osd-data:/data -v osd-tls:/opt/osd/.local/tls \
  ghcr.io/oisee/open-steamgate:showcase-draft
```

Then `http://localhost:3030/app/flp.html` is the launchpad and
`http://localhost:3030/sap/bc/adt/discovery` is what Eclipse reads first.
The container reports `healthy` once the system answers by content, not
when the port opens. Measured here: the pull is 825 MB (amd64), `healthy`
28 s after `docker run`, then discovery `200`, launchpad `200`, HTTPS
discovery on 44300 `200`, `TravelSet` answers, and the log says
`OSD JS protocols: DIAG 0.0.0.0:3200; RFC 0.0.0.0:3300`. The database is
the `osd-data` volume and survives `docker rm`; the certificate is
`osd-tls`. Stop with `docker stop osd`, remove with `docker rm osd`.

`showcase-draft` is a moving tag, but it does not follow every merge: the
Docker image workflow publishes on a `vscode-v*` / `vscode-stable-v*` tag
push or on a manual dispatch with `publish=true`, and only after the
image passed its acceptance suite ([`docker-ci.md`](docker-ci.md)). To
know what you run, read `commit` from
`http://localhost:3030/sap/bc/adt/core/http/build`, or pin a version tag
GHCR also carries: `0.7.1696` (the current stable release, with the demo
packs), `0.7.1696-core` (without), `0.7.2114` for the newest prerelease
(on 2026-11-08 `latest`, `showcase` and `showcase-draft` all resolved to
that prerelease, not to the stable).

Prefer Compose or Portainer? [`docs/spin.md`](spin.md) has one pasteable
stack per database (SQLite, DuckDB, PostgreSQL, HANA Express); the SQLite
one publishes 8011 / 44311 / 3211 / 3311.

Building the image yourself: `docker buildx build --platform linux/amd64
--load -f docker/image/Dockerfile -t osd:local .` (`docker/Dockerfile`
without `image/` is an older Bun experiment, not the published image).
Measured here with the legacy builder, because this host has no buildx
plugin (`DOCKER_BUILDKIT=0 docker build -f docker/image/Dockerfile -t
osd:local .`, with `docker/image/Dockerfile.dockerignore` copied to
`.dockerignore`, the only name the legacy builder reads): 259 s, 774 MB,
`healthy` 20 s after `docker run`, discovery and launchpad `200`.

### B. From a clone, with Node

Node 22.18+ or 24 (Node 26 works, it only prints that `open-rfc` has
not been tested on it), git, and for HTTPS `openssl`.

```sh
git clone https://github.com/oisee/open-steamgate && cd open-steamgate
npm ci                 # measured: 387 packages in 18 s
npm run bootstrap      # clones the 7 pinned libraries into .local/lars/, fetches the packs, builds; measured 55 s
npm run osd:tls        # a self-signed certificate in .local/tls/ -- Eclipse refuses plain HTTP
npm start              # http://localhost:3030/  and  https://localhost:44330/
```

`npm start` prints what it bound:

```
Listening on http://localhost:3030/sap/opu/odata/sap/  (bound to 127.0.0.1, ::1)
ADT façade   on http://localhost:3030/sap/bc/adt/core/discovery
HTTPS        on https://localhost:44330  (self-signed, sha256 ...)
             the certificate is .local/tls/osd.crt; a client will ask once whether to trust it
```

The first start imports the generation (about 12 s here) and `/osd/ready`
answers `{"ready":true}` roughly half a minute after the command. For the
SAP GUI and RFC ports, start the listeners beside it:

```sh
INSTANCE=00 node tools/protocols/server.mjs
# OSD JS protocols: DIAG 127.0.0.1:3200; RFC 127.0.0.1:3300 -> http://127.0.0.1:3030
```

`npm run dev` is the same server rebuilding as you edit ABAP;
`STG_PORT=3050 npm start` moves it (HTTPS then is 44350).

### C. The VS Code extension

Install **open-steamgate: local ABAP server** from the Marketplace
(publisher `oisee`, listed since 2026-09-27) or the `.vsix` from
[Releases](https://github.com/oisee/open-steamgate/releases), then run
**osd: Start** from the OSD view. The extension carries its own system
seed, builds it on first start, and gives you the object tree, F8 data
preview, ABAP Unit in the Test Explorer, a debugger on ABAP lines and a
`.http` CodeLens. It does **not** need Eclipse, and you can still point
Eclipse at the port it shows in the status bar. A workspace folder with
`.abapgit.xml` (or `src/` with ABAP) becomes a layer over the bundled
system; see its [README](../editors/vscode/README.md).

### D. Also: one binary, or nothing at all

Each release carries `osd-linux-x64`, `osd-linux-arm64`,
`osd-darwin-arm64`, `osd-darwin-x64`, `osd-windows-x64.exe` and
`osd-windows-arm64.exe`: `mv osd-linux-x64 osd && chmod +x osd && ./osd up`
copies the embedded system into your user data directory and serves on
3030 (HTTP only: the binary makes no certificate, so Eclipse reaches it
over RFC with `./osd protocols` in a second terminal, section 2).
`./osd doctor` says what a binary contains. What was measured
(2026-11-08): the seeded `osd-linux-x64`, built from main `af7a91f0`
with the release workflow's recipe (116.0 MB), started in a container
with no Node and no checkout and passed the whole chain of this page --
discovery, `core/http/build`, package tree, source read, edit + activate
+ F9, ABAP Unit, F8, the OData V2 and V4 services, the launchpad in
Chromium, and a zip passed with `--layer`. The macOS and Windows
binaries were checked by their executable header only, not started. A
binary built with plain `npm run binary` in a clone is the
**checkout-mode** binary (no embedded seed, as `build/osd doctor` says)
and serves that checkout; it is not the route this page recommends.
And the browser demo at
[oisee.github.io/open-steamgate/main/app/flp.html](https://oisee.github.io/open-steamgate/main/app/flp.html)
runs the same ABAP in a service worker over sql.js; nothing to install,
nothing to connect Eclipse to.

## 2. Connect Eclipse ADT

OSD answers the ADT surface ([`adt-facade.md`](adt-facade.md)), so both
project kinds of the ABAP Development Tools connect. **Neither was
re-run with a real Eclipse for this page**; the values below are what the
system reports and what the facade's tests exercise, and the two wire
paths were both exercised with a client on this host (section 7).

### ABAP Cloud Project (HTTPS)

Eclipse refuses a plain-HTTP cloud project, which is why the certificate
exists.

| field | value |
| --- | --- |
| Connection | *Use a URL* |
| URL | `https://localhost:44330` from `npm start`, `https://localhost:44300` from the Docker image |
| User / password | `DEVELOPER` / anything |
| System ID shown | `OSD` (change it only with `OSD_SID`, together with the projects that point at it: ADT refuses a system whose id changed under a project) |
| Certificate | self-signed; Eclipse asks once whether to trust it. Java checks the *subject alternative names*, so the certificate must name the address you type. The two paths make different ones (see below). |

What each path puts into the certificate, read off the code that makes it:

| path | made by | names in it |
| --- | --- | --- |
| `npm start` in a clone | `npm run osd:tls` (`tools/osd-tls.mjs`), once, into `.local/tls/osd.crt`; the start log prints the SHA-256 | `DNS:localhost`, `DNS:osd`, `IP:127.0.0.1`, `IP:::1` and every non-loopback **IPv4** address of the machine at that moment (so a client on the host OS reaching a WSL system by its address is fine) |
| Docker image | `docker/image/entrypoint.mjs` on first start, into the `osd-tls` volume | exactly `TLS_SAN`, default `DNS:osd,DNS:localhost,IP:127.0.0.1`. **Not** `::1`, not the host's addresses. `TLS_SAN` *replaces* the list, so to add a name keep the defaults in it: `docker run … -e TLS_SAN=DNS:osd,DNS:localhost,IP:127.0.0.1,DNS:your-host.example …` on the **first** start (the variable has to be passed into the container; an existing `osd-tls` volume keeps its old certificate, remove the volume to get a new one) |

So from a container, connect as `https://localhost:44300` or
`https://127.0.0.1:44300`, not by `::1` and not by the machine's own name
unless you put it into `TLS_SAN` first. The critic of this page executed
the entrypoint's certificate block against the four names: with the
default list `localhost` and `127.0.0.1` verify, `::1` and
`your-host.example` do not; with `TLS_SAN=DNS:your-host.example` alone only
that name verifies.

What answered over HTTPS on this host: `curl -k https://localhost:44330/sap/bc/adt/discovery` → 200, and the same with `--cacert .local/tls/osd.crt` → 200.

### Custom Application Server (RFC)

This kind never touches HTTP: Eclipse logs on over RFC on the gateway
port and tunnels every ADT request inside one `SADT_REST_RFC_ENDPOINT`
call ([`adt-over-rfc.md`](adt-over-rfc.md)). The built-in JavaScript
bridge answers it (`tools/protocols/`), in the Docker image by default and
from a clone with `node tools/protocols/server.mjs`.

| field | value |
| --- | --- |
| Application Server | `localhost` |
| System Number | `00` (the bridge listens on `33` + instance) |
| System ID | `OSD` |
| Client | `001` |
| User / password | `DEVELOPER` / anything (`STG_RFC_AUTH_MODE=demo`, the default) |
| Language | `EN` |

Measured: a schema-bound RFC client (the one the image's acceptance suite
uses, `docker/image/rfc-probe.go` built inside
[open-rfc-go](https://github.com/oisee/open-rfc-go)) called
`SADT_REST_RFC_ENDPOINT` on 3300 for `/sap/bc/adt/core/http/build` and
`/sap/bc/adt/discovery`; both came back `200` with the serving
generation in `x-osd-generation`, and the bridge logged
`{"function":"SADT_REST_RFC_ENDPOINT","method":"GET","path":"/sap/bc/adt/discovery","status":200}`.

### What works once connected, and what does not

Package tree, open and edit source, save, activate, ABAP Unit, F8 Data
Preview, SQL console, create and delete of CLAS, INTF, PROG, INCL, DDLS
and DEVC. Not served, and therefore **not advertised in discovery**: ATC
and the ADT debugger (the VS Code extension debugs instead). The server
keeps the list of what a client asked for and it lacked at
`/osd/not-served`.

## 3. Bring your own code

An abapGit repository is a **layer**: a folder (or the zip abapGit
exports) with `.abapgit.xml` at its root. Later layers win a name they
share, and the build names every override with both files.

```sh
node bin/osd.mjs up --layer /path/to/your-repo        # a folder or a .zip, repeatable
OSD_LAYERS=/path/to/a:/path/to/b npm start            # the same as an environment variable
./osd up --layer your-repo.zip                        # the binary, after mv osd-linux-x64 osd
```

In VS Code, open the repository folder in the workspace and restart OSD;
in the Docker image, mount it and set `OSD_LAYERS` to the mount. A zip is
verified (CRC, sizes, no path escape) and extracted once under
`build/source-layers/<sha256>`; edits through ADT land in an overlay
beside it, never in your archive ([`source-layers.md`](source-layers.md)).

Measured here: a folder with `.abapgit.xml` and three classes
`ZCL_A4H_PROBE_*` (section 6), `node bin/osd.mjs up --layer <folder>`:
`built … in 45132 ms, 2406 objects` (three more than the clone's base
build; the base count depends on what the tree carries -- the seeded
release binary's base build was 2222 objects on 2026-11-08, its
zip layer of one class 2224), ready about a
minute after the command, the package tree gained `$ZA4H` (derived from
the `ZCL_A4H_` prefix; abapGit folders usually omit the root package,
`OSD_LAYER_PACKAGE` names it when the prefix is ambiguous), and F9 on
each class answered over ADT.

**What runs.** Whatever the abaplint transpiler compiles: classes,
interfaces, reports (`PROG`), function groups, tables, table types, data
elements, domains, message classes, search helps, lock objects, CDS DDL
sources, transactions that name a class, and `W3MI` / `SMIM` media. The
package objects (`DEVC`) give the tree its folders. `SUBMIT` is a
subset: the static forms `SUBMIT zprog [WITH p = v …] AND RETURN` and
`SUBMIT … VIA JOB … AND RETURN` are lowered onto the batch-report runtime
before transpiling (`tools/osd-narrow-submit.mjs`, cases in
`test/narrow-submit.mjs`; the jobs row of the README); every other form,
a dynamic program name among them, and a report that needs a dynpro are
refused by the build. Not run: dynpro screens (`CALL TRANSACTION` is a no-op, see
section 5), anything whose dependency is a standard object this tree does
not have.

**Seeing what did not compile.** The build is one command and it fails
closed:

```
osd-build: FAILED: <check>, <message>, <file>:<line>
```

among the generators' own lines. A missing period is reported as the
*next* statement not existing in "the configured ABAP version", so look one
statement up. While it serves, `curl localhost:3030/sap/bc/adt/core/http/build`
says whether source, built and serving generations agree, and
`curl localhost:<child port>/osd/dumps` lists the last runtime errors, each
naming its ABAP statement ([`using-osd.md` §9](using-osd.md#9-when-something-is-wrong)).
`node tools/osd-inputs.mjs` prints the layers, overrides and shadows.

**Standard objects you depend on.** Your code calls `cl_abap_typedescr`,
`cl_abap_unit_assert`, `cl_http_utility`, `cl_abap_conv_*`, `/ui2/cl_json`
and a few hundred others: those come from
[open-abap-core](https://github.com/open-abap/open-abap-core) and are a
subset, sometimes a stub. `BAPI_*`, `SFLIGHT`, `T000` and the rest of the
standard dictionary are not there at all (section 5). `CL_SALV_TABLE`,
`CL_GUI_ALV_GRID` and the other `cl_gui_*` names **do** exist, as the
substitutes of [open-abap-gui](https://github.com/open-abap/open-abap-gui)
(a library of this tree, pinned in `libs.lock.json`): they render to HTML
instead of a control, are work in progress, and nothing on this page
verified how much of a given class behaves like SAP's. Before you spend
time, compute the closure of your folder against the libraries:

```sh
npm run probe -- <folder> \
  --lib .local/lars/open-abap-odata/src \
  --lib .local/lars/open-abap-gui/src \
  --lib .local/lars/open-abap-apc/src
```

The `--lib` lines matter: the probe's defaults are open-abap-core,
express-icf-shim and this tree's `src/` (its OData default points at a
folder bootstrap no longer uses), so without them Gateway, GUI and APC
names are reported missing although the build has them.

## 4. Work

**ABAP Unit.** In Eclipse `Ctrl+Shift+F10`, in VS Code the Test Explorer
or the beaker, on the command line `npm run unit` for the tree. The
facade's run of one class on this host:

```
POST /sap/bc/adt/abapunit/testruns  (one objectReference to /sap/bc/adt/oo/classes/zcl_osd_adt_discovery)
→ 200 application/vnd.sap.adt.abapunit.testruns.result.v2+xml, 5 testMethod, 0 alert
```

**F8 Data Preview and the SQL console.** `POST
/sap/bc/adt/datapreview/freestyle?rowNumber=3` with `SELECT travel_id,
description FROM zstg_demo` answered three rows (`T0001` … `Berlin to
Copenhagen`) on this host; that is the route Eclipse's F8 and the SQL
console take.

**OData and Fiori.** `http://localhost:3030/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`
names `TravelSet`, `BookingSet`, `StatusVHSet`, `PhotoSet`;
`TravelSet?$top=1&$format=json` returns `T0001`, "Berlin to Copenhagen".
The launchpad at `/app/flp.html` has the Travels and Bookings list reports
(Fiori Elements V2), Flight analytics (an analytical list page over a CDS
cube), the SEGW editor, System status, and with the showcase image Vivid
Vibes, Zork and the vector workbench. SAPUI5 1.120 comes from SAP's CDN
unchanged, so the browser needs the internet for the UI library.

**SAP Easy Access, SE16, ST05.** Served by ABAP as HTML at
`/sap/bc/gui/sap/its/webgui/` (200 on this host), the path the real ITS
webgui answers on. They are pages written by classes, not dynpros.

**Your service.** One YAML file is a SEGW project
(`npm run stg:compile -- my.stg.yaml`); `@OData.publish: true` on a CDS
view is a service; a `_MPC_EXT` / `_DPC_EXT` pair from a real SEGW
project runs as it is ([`using-osd.md`](using-osd.md)).

## 5. What A4H has that this does not

| A4H | open-steamgate | what to do instead |
| --- | --- | --- |
| SAP GUI with dynpro: SE80, SE11, SE16, SM30, your `CALL SCREEN` programs | **No dynpro processor.** Port 3200 accepts SAP GUI and shows one fixed screen (`R Tape loading error, 0:1`) so a GUI can connect and you can see it is not SAP; a report that needs a dynpro is refused, `CALL TRANSACTION` is a no-op, only the static `SUBMIT … AND RETURN` / `VIA JOB` forms run (section 3). The classic transactions here (SE16, ST05, Easy Access) are HTML pages written by ABAP classes | Lars Hvam's [open-abap-gui](https://github.com/open-abap/open-abap-gui) is the off-stack dynpro work: GUI controls, classic report and dynpro processing rendered as HTML, work in progress (its converter and its `cl_gui_*` / SALV substitutes are already a library of this tree). Selection screens exist today as a terminal UI and as a real SAP GUI screen over DIAG in `osabap`, the report-to-binary compiler (README) |
| Standard DDIC: `SFLIGHT`, `T000`, `MARA`, the whole dictionary | **None of it**; clean-room, no SAP source and no SAP tables. The demo data is airship travels | Bring your own tables as abapGit `TABL`/`DTEL`/`DOMA` files; released data elements and domains exist in open-abap-core |
| BAPIs, standard function modules, SAP's class library | A subset of `CL_*`/`IF_*` from open-abap-core, some methods stubbed with `ASSERT 1 = 'todo'`; `CL_SALV_*` / `CL_GUI_*` as open-abap-gui's HTML substitutes, behaviour unverified here. No BAPIs | the probe command of section 3 tells you the closure before you start; missing pieces go upstream to open-abap-core as small PRs |
| `sy-mandt = '001'`, your logon client | **`sy-mandt = 123`**, fixed by the runtime; ADT and the session cookie say client `001`. Open SQL on a client-dependent table adds **no implicit `MANDT` condition**, so rows of every client are visible ([`ANORMALIES.md`](../ANORMALIES.md)) | Never branch on `sy-mandt`; put `MANDT` into your seed rows yourself and do not rely on an implicit client filter |
| `sy-sysid = 'A4H'`, your timezone, real `sy-uzeit` | `sy-sysid = OSD` (or `OSD_SID`); the runtime is **UTC** and fixed-point arithmetic is always on | Do not depend on local time in tests |
| Full ABAP 7.58 / ABAP Cloud syntax check in ADT, ATC | abaplint's `open-abap` dialect: a 7.02 baseline plus a curated set of newer features (section 6); no ATC | abaplint runs on the tree (`npm run lint`); `npm run segw:cloud` is an informational pass with `syntax.version: Cloud` |
| RAP (BDEF, EML, managed and unmanaged scenarios, draft), OData V4 | RAP, 2026-11-08: a **managed** BDEF runs **handler-direct**: the runtime calls the pool's determinations, validations, actions and the save sequence itself, there is **no EML** (`MODIFY/READ/COMMIT ENTITIES` do not transpile), no draft, no unmanaged save, and the managed BO is not yet served over OData ([`rap-runtime.md`](rap-runtime.md)). OData V4: every V2 service also answers on `/sap/opu/odata4/sap/<service>/` with reads, entity writes, ETags and JSON `$batch`; no actions/functions, no deep insert, no multipart `$batch`, no Fiori Elements V4 app yet ([`odata-v4.md`](odata-v4.md)). Code-based SEGW and SADL over CDS are what works end to end | Classic `_DPC_EXT`, CDS with `@OData.publish`, `stg-compile` |
| Transport system, SAP-owned namespaces | Everything is a file in git; a "transport" is a commit, a branch is a system copy | `git` |
| Debugger in Eclipse | Not served over ADT | The VS Code extension debugs ABAP lines through Node's debugger |
| SAP's licence and a developer key | MIT; the one SAP-licensed thing you *can* attach is HANA Express as a database, under SAP's own terms | |

## 6. Which ABAP syntax is accepted (measured)

`abaplint.jsonc` sets `syntax.version: "open-abap"`. abaplint's own
comment on that version reads *"not a real SAP release. A dialect that is
'702 baseline + a curated set of newer features' (opted in
per-statement)"*. The curated set is wide: inline `DATA(…)` and
`FIELD-SYMBOL(…)`, `VALUE`, `NEW`, `REDUCE`, `FOR`, string templates,
table expressions, `CAST`, `CASE TYPE OF`, `LOOP … GROUP BY`, the new
Open SQL (`@` host variables, CTEs, SQL functions), enumerations, test
seams, `COMMIT ENTITIES` and the EML statements are all on the list in
the core (`version.js`, 2.120.73). Three small classes in a layer were
built with the command of section 3 on this host:

| probe | constructs | result |
| --- | --- | --- |
| `zcl_a4h_probe_740` | `DATA(…)`, `VALUE #( )`, `NEW`, `REDUCE`, `FOR`, `FIELD-SYMBOL(…)`, string templates, `IF_OO_ADT_CLASSRUN` | builds; F9 (`POST /sap/bc/adt/oo/classrun/zcl_a4h_probe_740`) prints `1: one`, `2: two`, `sum 3, client 123, sysid OSD` |
| `zcl_a4h_probe_757` | `FINAL(…)` (7.57 / ABAP Cloud) | builds; F9 prints `final inline declaration, ABAP 7.57` |
| `zcl_a4h_probe_cloud` | `cl_abap_context_info=>get_user_technical_name( )` and `get_system_date( )` (released ABAP Cloud API, implemented in open-abap-core) | builds; F9 prints `cloud context: user DEVELOPER, date 20261108` |

So the syntax people write today, 7.40 through `FINAL`, is accepted, and
what limits a program is the library (section 5), not the parser. The
7.02 baseline still shows: a statement abaplint has not opted into the
dialect is refused by the build with `FAILED: … <file>:<line>`, `SUBMIT`
is the static subset of section 3, and there is no dynpro.

ABAP source is 7-bit ASCII here as on a system; an em dash in a comment
is a lint error.

## 7. What was verified for this page, and what was not

Verified on 2026-11-08, Linux x64, Node 26.9.0, Docker 29.1.3, commit
`378b0504`: `npm ci`, `npm run bootstrap`, `npm run osd:tls`, `npm start`,
every `curl` quoted above over HTTP and HTTPS (discovery, CSRF token,
package tree, source read, data preview, ABAP Unit run, `$metadata`,
`TravelSet`, launchpad, webgui), `node tools/protocols/server.mjs` and an
RFC client calling ADT through it, `docker pull` and `docker run` of
`ghcr.io/oisee/open-steamgate:showcase-draft` with the one-liner above,
`docker build` of `docker/image/Dockerfile` (legacy builder) and a run of
that image, `node bin/osd.mjs up --layer <folder>` with the three probe
classes and their F9 output over ADT, `npm run binary` and `build/osd
doctor`.

Not verified: a real Eclipse (none on this host), the VS Code extension
from the Marketplace (not run here; the extension's own tests run in CI),
`docker buildx build` as written (no buildx plugin here), the arm64
image, the release binaries (not downloaded; the checkout-mode binary
built here did not start, section 1 D), the binaries for macOS and
Windows (built by the release workflow, started only on Linux x64 by it).

## 8. Where to ask

[GitHub issues](https://github.com/oisee/open-steamgate/issues) of
open-steamgate for anything about this system; runtime and language
defects usually end up as small upstream issues in
[abaplint/transpiler](https://github.com/abaplint/transpiler) and
[open-abap/open-abap-core](https://github.com/open-abap/open-abap-core),
and [`ANORMALIES.md`](../ANORMALIES.md) records every known difference
from SAP before it is worked around. A worked example as a book is
[osg-demo](https://github.com/oisee/osg-demo): one application, chapter by
chapter, against a pinned open-steamgate tag.
