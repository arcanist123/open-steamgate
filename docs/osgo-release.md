# OSGo release binary in CI

The `vscode-v0.N.NNNN` release includes `osgo-linux-x64`,
`osgo-linux-arm64`, `osgo-darwin-arm64`, `osgo-darwin-x64`,
`osgo-windows-x64.exe`, and `osgo-windows-arm64.exe`, each
with a matching `.sha256`. The Go executable runs the compiled OData
services with a pure Go SQLite driver. It does not need Node, a Go installation,
or a separate database server. Enable ADT with `-adt` or `OSD_OSGO_ADT=1` (off by default). It mounts
`/sap/bc/adt` through the shared ABAP `ZCL_OSD_ADT_HANDLER`, plus the ADT
logoff route. Discovery, identity, package browsing, search, source reads,
versions and locks are served, and so are the DDIC documents, type structure,
virtual folders, the data preview (SQL console and table F8 run one SELECT on
the request's own transaction, `go/adtpreview`) and the inactive-objects feed
(`go/adtread`); the CDS data preview still needs a DDLS parser osgo does not
have. Class/interface/program creation, locked source
PUTs (including class includes) and locked deletion use Go host orchestration.
CHECK uses the configured compiler provider; outline parsing needs the compiler
sidecar. Activation checks the source and publishes it in the object store
(`go/adtactivate`): the inactive list empties and the active version is the
saved one, but the binary keeps running the code it was built with, and the
answer warns that a rebuild is needed. ABAP Unit runs in process for the test
classes compiled into the binary (`OSGO_UNIT_OWNERS`, by default the
`$ZOSD_TEST` fixture) and refuses a class that changed since the build
(`go/adtunit`; docs/osgo-adt-activation.md). Source operations require a matching tree
at `-root`; an executable alone does not carry editable sources.

**Readiness is `GET /osd/serving`**, the route the Node host answers and
the VS Code launcher polls, so vsix and VSP consumers can rely on one
answer from both hosts: `200` with `{"ready": true, "generation": "go:…",
"pid", "since", "root", "database", "hot", "launcherPid"}` while the binary
serves, and `503` `{"error": {"code": "STG/NOT_SERVING"}, "ready": false,
"draining": true}` from the moment it was told to stop. `X-OSD-Generation`
is on every answer and equals that `generation`, the content hash the
executable was built from (the one the status service shows as the serving
generation). `/health` stays as the liveness line for scripts that already
use it. **Stopping** is SIGTERM (or SIGINT, SIGHUP): the binary stops
admitting, lets the dialog steps in flight finish, closes the listeners,
closes the database under the work process and exits 0, all within 55 s (a
step or a database close still running at the deadline is left behind) --
the same budget the Node supervisor's quiesce has, under the launcher's 60 s
SIGKILL. A second signal ends it at once with exit 1. `node
tools/osd-host-contract.mjs --base <url> [--drain <pid>]` checks the
contract against a running host and times the drain; the `osgo-host` CI job
runs it on every change.

The VS Code extension is one consumer: with `osd.engine: "osgo"` it downloads
the asset for its platform from its own release tag, checks it against the
`.sha256`, keeps it in its global storage and starts it with `-port N -root
<tree> -home <dir> -adt` (docs/vscode-extension.md, "Engine").

Pin a tested release tag in consumer CI and download both files from that
tag. For example, on Linux x64:

```sh
tag=vscode-v0.N.NNNN
asset=osgo-linux-x64
gh release download "$tag" -R oisee/open-steamgate -p "$asset" -p "$asset.sha256"
sha256sum -c "$asset.sha256"
chmod +x "$asset"
./"$asset" -version
mkdir -p "$RUNNER_TEMP/osgo-home"
./"$asset" -home "$RUNNER_TEMP/osgo-home" -port 3095 &
pid=$!
ready=0
for attempt in $(seq 1 60); do
  if curl --fail --silent http://127.0.0.1:3095/osd/serving | grep -q '"ready":true'; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then echo 'OSGo did not become ready' >&2; exit 1; fi
curl --fail 'http://127.0.0.1:3095/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=1&$format=json'
kill "$pid"   # SIGTERM: drains and exits 0 within 55 s
wait "$pid"
```

`-home` puts the SQLite database at `<home>/osgo.sqlite`; a fresh directory
is a full data reset. `-db <path>` chooses a database file explicitly and
overrides `-home` and `STG_DB_PATH`. `-home` overrides `STG_DB_PATH`. With no
path setting the database is reseeded at each start. The startup log says
`database: in memory (use -home or -db to keep data)`. `-port`
overrides `OSD_PORT`, which overrides `STG_PORT`; then `INSTANCE=nn` supplies
HTTP `80nn`, otherwise the default is 3095. All listeners share `-addr`
over `OSD_BIND`, otherwise loopback (`127.0.0.1` and available `::1`).
Keep the listeners private: OSGo does not provide authentication.

HTTPS uses `-tls-port`, then `STG_TLS_PORT`, then `443nn` with INSTANCE;
without these it stays off. `-tls-port=0` disables it. It requires a valid
`-tls-cert`/`-tls-key` PEM pair (or `OSD_TLS_CERT`/`OSD_TLS_KEY`), otherwise
reads `<root>/.local/tls/osd.crt` and `osd.key` (`OSD_TLS_DIR` overrides the
directory). Missing default credentials leave HTTPS off. Generation remains
the separate `npm run osd:tls` command, just as in the JS host.
See [OSGo host options](../tools/gogen/README.md#osgo-host-2026-09-23)
for all four ports, precedence, TLS controls and protocol opt-ins.

The compiled OData services and seed rows are in the executable. The optional
webapp, pack pages, media, and ADT object store still use files from `-root`
or `-media` when present. CI that only needs the service and data can run the
binary in an empty working directory as shown above.

Building the binary from a checkout is `node tools/gogen/osgo.mjs` (heavy).
The generated classes go into three Go packages, so after a save of one
class only package `main` is recompiled and linked; `docs/osgo-fast-rebuild.md`
has the layout, the numbers and `tools/gogen/osgo-cycle.mjs`, which measures
the edit cycle. A release build from a clean tag checkout has nothing edited,
so its `main` holds no generated class.
