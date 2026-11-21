# What is running: the system status as an OData service and a Fiori app

*2026-09-17. The question was "what build is running, on which ports, how
many processes, how much is registered"; the answer is a service, not a
status page, because everything OSD knows about itself can be said in
ABAP over OData, and then a Fiori Elements app renders it for free.*

## The shape

Five DDIC tables under `src/status/` hold the snapshot; five CDS views over
them carry the labels and the associations; one `stg.yaml` makes the
service; a Fiori Elements V2 app renders it; the façade fills the tables
when somebody reads the service.

The SID is not chosen here: it comes from `tools/osd-identity.mjs`, the one
place this tree says which system it is, and the same function sets `sy-sysid`,
`sy-mandt` and `sy-uname` at boot and gives the ADT façade its identity. The id
is one setting, `OSD_SID` (alias `STG_ADT_SID`, default `OSD`), the same for
the façade; only the façade's client differs from `sy-mandt`, and
`docs/webgui.md` ("The status bar tells the truth") says why.

`ZOSD_SYS-PID` is the process these tables were *written in*, which is the
process that answers the read: the façade when it holds the ABAP inline, and
otherwise the child the snapshot was posted to (found by the port of the
address it posts to). SAP Easy Access prints it where SAP GUI prints the
session number.

| table | CDS view | what a row is |
| --- | --- | --- |
| `ZOSD_SYS` | `ZC_OSD_SYSTEM` | the system: SID, host kind, generation built and serving, whether they are in step, work processes, when it started, when the snapshot was taken, and the process the tables were written in (`PID`) |
| `ZOSD_PROC` | `ZC_OSD_PROCESS` | a process: pid, role (`facade` or `work`), port, generation, epoch, sockets pinned to it, RSS |
| `ZOSD_PORT` | `ZC_OSD_PORT` | a port: number, protocol (HTTP, HTTPS, RFC, DIAG), what it is for, whether anything is listening |
| `ZOSD_SVC` | `ZC_OSD_SERVICE` | a service: path, kind (`ODATA`, `ICF`, `APC`), handler class (`HANDLER_NAME`, OData `HandlerName`), the pack it came from |
| `ZOSD_PACK` | `ZC_OSD_PACK` | a pack: name, order, objects, folders, description |

`ZC_OSD_SYSTEM` exposes four associations, and `src/status/zosd_status.stg.yaml`
turns them into navigation properties, so the service is

```
/sap/opu/odata/sap/ZOSD_STATUS_SRV/SystemSet('OSG')?$expand=to_Processes,to_Ports,to_Services,to_Packs
```

and the object page's facets are those four collections. The UI annotations
(header, header facets, line items, field groups, labels) come from the same
YAML, so `webapp/status/` carries no annotation file of its own — a list
report over the one system row, an object page behind it.

## Where the numbers come from

`tools/osd-status.mjs` takes the snapshot in the façade, which is the only
process that knows all of it: the pool and the supervisor for the work
processes, the listeners it opened for the ports, `tools/osd-icf.mjs` for
ICF services and push channels, the SEGW registry for OData services,
`tools/osd-packs.mjs` for packs, `liveHash` and the serving runtime for the
two generations. RFC and DIAG are reported as `absent` with a note naming
the sibling that would serve them, rather than left out.

It travels as JSON to `POST /osd/status` on a work process, where
`ZCL_OSD_STATUS=>REFRESH` parses it with `/ui2/cl_json` and replaces the
five tables. The work processes share one SQLite file by default
(`test/run.mjs` sets `STG_DB=file`), so one write is enough for all of them.
The refresh happens when a request for the service arrives, so what the app
shows is what was true when it was asked; a failed refresh is logged and the
tables are served as they are.

## AMDP methods: where each body runs

`AmdpMethodSet` (facet **AMDP methods**, table `ZOSD_AMDP`, view
`ZC_OSD_AMDP`) lists every `BY DATABASE PROCEDURE / FUNCTION FOR HDB` method
of the tree with the engine a call would use at the moment of the snapshot:
`portable-duckdb`, `portable-refused`, `hdb`, `hdb-stale`, `hdb-idle` or `unavailable` with a
reason. The facts come from the AMDP destination itself (its session's
`readyState`, whether a driver and a HANA are configured) and from the system
connection, through `tools/amdp-status.mjs`; a work process adds them to
`/osd/serving` and the facade copies them into the snapshot, the way the
database facts travel. `ZCL_OSD_STATUS=>ENGINE` does the classification in
ABAP. Two `AMDP` rows in the Environment facet say the system-wide half. The
whole story, with the truth table, is `docs/amdp-engine-status.md`.

## Platform facts in the Environment facet

The existing `DatabaseSet` also carries coarse `Platform` rows, so adding
them does not change the DDIC schema or rebuild a persisted SQLite volume.
`Architecture` comes from the Node runtime (`linux/arm64` on a 64-bit Pi),
`Runtime OS` from the runtime filesystem's `/etc/os-release` (the **container**
OS in Docker), and `Kernel` from the host kernel shared with the container.
If the board model is visible at `/proc/device-tree/model` or
`/sys/firmware/devicetree/base/model`, or is mounted at
`/run/host/device-model`, `Device` names the Raspberry Pi model without
exposing its serial number. Docker on pi48w does not expose the device-tree
model by default, so it needs the explicit mount below. `Host OS` appears only when an operator
mounts the host's release file read-only at `/run/host/os-release`; the
container OS is never presented as the host OS. For example, add this to a
Pi's `docker run` command when creating a new container:

```sh
--mount type=bind,source=/etc/os-release,target=/run/host/os-release,readonly
--mount type=bind,source=/proc/device-tree/model,target=/run/host/device-model,readonly
```

The browser-preview worker reports only `browser`, without inspecting the
visitor's device or OS. On Docker hosts, `INSTANCE=11` now makes the port
rows refer to 3211/3311 rather than inferring 3230/3330 from internal HTTP
port 3030.

**Nothing identifies a client.** Sockets are counted, never described: no
addresses, no user names, no session ids. That is the same rule the rest of
the repository keeps, and a status app is exactly where it would be easiest
to break.

## What it cost, and two things measured on the way

- `UI.HeaderFacets` did not exist in the YAML annotation compiler, so the
  object page's header showed only the title and the description and
  everything else fell into the first section. `tools/stg-compile.mjs` now
  emits it beside `UI.Facets` — the same ReferenceFacet, a different term —
  and every Fiori Elements object page in the tree can use it.
- A pid and a port are identifiers, not quantities: as `Edm.Int32` a Fiori
  field groups the digits and a pid reads `173,027`. They are `Edm.String`
  in the model now. Casting them in the CDS view instead
  (`cast(pid as abap.char(10)) as Pid`) does **not** work here: the field
  disappears from the row the generated source class hands back, and the key
  comes out empty (`PortSet()`), which is worth knowing before someone
  reaches for a cast in a view.

## On the browser deployment

*2026-09-17, backlog U.2.* The preview on GitHub Pages is the same ABAP in a
service worker, and there the façade does not exist: no pool, no listener, no
operating-system process, no `/proc`. The five tables are filled anyway, by
the worker, through the same door — `web/preview-backend.mjs` builds the JSON
of the contract above and calls `ZCL_OSD_STATUS=>REFRESH` once when the
runtime is up and the seed has run, and again whenever a request for
`ZOSD_STATUS_SRV` arrives, which is what keeps `SnapAt` honest. Nothing about
the shape is special; only the values are.

What the browser says:

| field | there | why |
| --- | --- | --- |
| `host_kind` | `browser` | it is a service worker, not node, bun or a SEA |
| `workers` | 1 | the worker is the whole system |
| `gen_live`, `gen_serving`, `synced` | the bundle's stamp, twice, in step | a bundle cannot serve a generation other than itself; the stamp is the digest `scripts/build-preview.mjs` writes into `sw.js` and `build.json` |
| `root_hint` | the deployment's directory (`main`, `pr-7`) | the last segment of the worker's mount, and never a path from anyone's disk. Served from the root, as `npm run web:preview` is locally, it is `preview` |
| `pid` | 0 | a service worker is not a process anybody can number; SAP Easy Access prints the system without a session rather than printing the zero (`docs/webgui.md`) |
| `started_at`, `snap_at` | the real clock | `web/preview-runtime.mjs` pins `Date` so two builds of the same code answer with the same bytes; the snapshot is the one caller that steps outside it, through `realNow()`, because a frozen "snapshot taken" would be a lie told to quieten a screenshot diff. A worker is shut down when idle, so `started_at` is when it last woke, not when the page was opened |

**Processes**: one row, role `worker`. `pid` and `port` are 0 and `rss_mb` is
0 — a service worker has no pid, no port and no way to read its own resident
size, and an empty column says that better than an invented number.
`sockets` is real: it is the number of push channels open in the worker right
now, so opening Zork and looking at the status app shows 1.

**Ports**: one row, port 0, protocol HTTP, state `absent`, with the note *a
service worker has no socket: requests are intercepted in the browser*. One
row rather than none, for the reason the façade reports RFC and DIAG as
absent rather than omitting them: an empty section and a snapshot that forgot
to look are the same picture. It is one row and not three because `port` is
the key of `ZOSD_PORT` and 0 is the only number here that is not a guess, so
three protocols would be three rows with one key.

**Services**: the real paths this bundle answers — the ICF services and push
channels of the generated `web/generated/services.mjs`, plus the OData
services of the SEGW registration objects. The pack a service came from is
worked out at build time by `servicesOf` in `tools/osd-status.mjs`, the same
function the façade uses, and written into the generated table.

**Packs**: name, order, objects, folders and description, from `packsInfo` at
build time (`web/generated/status.mjs`). The object counts are therefore
real, but they are the build's count and not something the worker can check;
nothing in a bundle can enumerate a folder.

What is not there, and would be on a server: a second process, a listening
port, a resident size, an RFC or DIAG row with a number, and a generation
that differs from the one being served — a deployment cannot be rebuilt under
its own feet.

## Tests

`test/osd-status.mjs` (the snapshot over a fake runtime and fake listeners),
`ZCL_OSD_STATUS`'s ABAP Unit tests (a snapshot written and read back, a
second refresh replacing the first, malformed JSON changing nothing), and
`test/e2e/status.spec.mjs` in a browser: the row, the header, a work
process, the HTTP port `listening`, a service path, a pack. The browser
deployment has its own check in `test/e2e/preview.spec.mjs` ("the status app
says what the deployment in the browser is"): host `browser`, one work
process, a port that says `absent`, the ICF path of a pack, the three packs.
