# OSGo release binary in CI

The `vscode-v0.N.NNNN` release includes `osgo-linux-x64`,
`osgo-linux-arm64`, `osgo-darwin-arm64`, `osgo-darwin-x64`,
`osgo-windows-x64.exe`, and `osgo-windows-arm64.exe`, each
with a matching `.sha256`. The Go executable runs the compiled OData
services with a pure Go SQLite driver. It does not need Node, a Go installation,
or a separate database server. OSGo does **not** serve ADT yet; the readiness
route is `GET /health`, not `/sap/bc/adt/core/http/build`.

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
  if curl --fail --silent http://127.0.0.1:3095/health | grep -q '"status":"ready"'; then
    ready=1
    break
  fi
  sleep 0.5
done
if [ "$ready" -ne 1 ]; then echo 'OSGo did not become ready' >&2; exit 1; fi
curl --fail 'http://127.0.0.1:3095/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=1&$format=json'
kill "$pid"
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
