# Running it in containers, and connecting an IDE to it

For a new installation, use the [ready-image quickstart](spin.md): one
prebuilt OSD image serves SQLite, DuckDB or HANA Express, including the
DIAG/RFC stubs. The short Portainer stacks are embedded there in full. Build
instructions and image verification are in [docker-image.md](docker-image.md).

The Bun release instructions below document an older experiment. In particular,
its HANA profile is **not** the working HANA Express stack and its image does
not include the DIAG/RFC bridge. Do not use it for a new Portainer deployment.

## Which address it listens on

Outside a container OSD listens on **loopback only**: `127.0.0.1`, plus `::1`
for a client that resolves `localhost` to IPv6. One variable, `OSD_BIND`,
read in one place (`tools/osd-bind.mjs`, and `tools/gogen/go/osdbind` for
OSGo), sets the address of every listener: HTTP, HTTPS, the push channels on
the HTTP port, DIAG and RFC (`STG_DIAG_HOST` / `STG_RFC_HOST` still override
those two), the dev proxies and the ZO4D stands (`o4dserve`, a bare
`-listen :port`). The serving child behind the front stays on `127.0.0.1`
whatever it says. The log line `Listening on ... (bound to ...)`, `bind` in
`/osd/serving` and `osd doctor` say which addresses were taken, and a
loopback-only start prints `listening on localhost only; for the network set
OSD_BIND=0.0.0.0`. OSGo's `-addr` wins over `OSD_BIND`. Two tools stay apart
on purpose: `tools/osd-tcp-forward.mjs` exists to expose ports and takes
`--bind` (default `127.0.0.1`), and `scripts/serve-build.mjs`, the LAN
preview of static files, listens everywhere and says so.

**A container is open.** The images and every compose file here set
`OSD_BIND=0.0.0.0`, because a published port arrives on the container's own
interface and never on its loopback. OSD has no real logon: the ADT facade
accepts any credentials and the RFC bridge runs in demo mode. Whoever
publishes the ports secures them: publish on `127.0.0.1:` only
(`"127.0.0.1:3130:3030"`), keep the host behind a firewall, or put an
authenticating proxy in front. Do not publish them on a public address.
The per-start bearer token the VS Code extension hands to ABAP-FS is accepted
from loopback only; it does not close this. Keeping remote logon open on a
non-loopback bind is a decision (2026-10-03: stands stay on the home network),
to be revisited before any stand gets a public address.

## Historical Bun release experiment

Three configurations exist, they differ by one variable at the database seam,
and the simplest needs nothing installed but docker.

```sh
bun scripts/make-release.mjs .local/release     # the release the image copies
docker build -f docker/Dockerfile -t osd:local .

cd docker
docker compose --profile sqlite up              # nothing else to run
docker compose --profile hana up                # HANA Express beside it
```

The image is the release directory and a CA bundle. Nothing is compiled at
image time: the Bun binary needs no Node and no npm, and the tree it serves
travels beside it.

## The health check is by content

```
wget -qO- http://localhost:3030/sap/bc/adt/core/http/build | grep -q commit
```

Not "the port is open". An unbuilt or half-started system **listens** and
answers 503 to everything, and a comparison against one reports differences
that are not differences — measured, and written down in the backlog as the
first thing branch plumbing had to learn.

## HANA Express

The image is 4.49 GB and wants 8–16 GB of memory. The licence is accepted by
the person running it and the master password is theirs: put it in
`docker/hxe/password.json` as `{"master_password":"…"}` before starting, and
set the same value in `HANA_PASSWORD` for the OSD service. Neither travels in
this repository.

Three corrections to SAP's published recipe, measured on 2026-09-18 and
recorded in [`amdp-in-hana.md`](amdp-in-hana.md):

- `kernel.shmmni` **cannot** be set per container — it is not namespaced and
  docker refuses the flag outright;
- `kernel.shmmax` and `kernel.shmall` should be **inherited**, not set: the
  published values are lower than a modern host already has;
- `Check failed: syscalls` for `move_pages` and `mbind` can be ignored on a
  single-socket machine — those place pages across NUMA nodes and there is one
  node. On a multi-socket host the seccomp profile has to be built by hand.

The health check waits on a **condition** rather than a timeout
(`SELECT 1 FROM DUMMY`), because a cold start was measured once at 169 s and a
slower machine should wait rather than fail.

**What is proven and what is not.** `STG_DB=hana` serves, and `npm run unit`
against HANA is green in 19.1 s — both measured against a HANA Express beside
the host rather than through this compose, which has not been run end to end.
And one negative measurement worth more than the positive ones: the **wire**
suite against HANA does not run slowly, it **hangs** — 21 minutes, no output,
two seconds of process CPU, three open sockets. A process waiting on the
database, not computing. So there is no `e2e-hana` profile here and a longer
timeout would not make one: the thing to wait for does not exist yet.

And HANA is a mode, never a default: per statement it costs 52× a single-row
SELECT and 3.8× a 200-row one ([`db-backends.md`](db-backends.md)).

## Connecting Eclipse (ADT)

OSD answers the ADT surface, so Eclipse treats it as a system
([`adt-facade.md`](adt-facade.md)):

1. **Custom Application Server** is the stock route. Eclipse logs on over
   RFC and tunnels ADT inside one `SADT_REST_RFC_ENDPOINT` call
   ([`adt-over-rfc.md`](adt-over-rfc.md)); the ready image runs the
   JavaScript bridge on `33` + `INSTANCE` (3311 for the SQLite stack,
   3300 for a plain `docker run` with the default instance `00`). Values:
   application server `localhost`, system number = the instance, system
   ID `OSD`, client `001`, user `DEVELOPER`, any password
   (`STG_RFC_AUTH_MODE=demo`). From a clone the bridge is a second
   command, `INSTANCE=00 node tools/protocols/server.mjs`; from the
   binary, `./osd protocols`.
2. **ABAP Cloud Project** needs HTTPS: Eclipse refuses `http://` for this
   kind, so `http://localhost:3030` is not a Cloud Project URL. Use
   `https://localhost:443nn` (44311 for the SQLite stack). The container
   makes a self-signed certificate on first start naming exactly `TLS_SAN`
   (default `DNS:osd,DNS:localhost,IP:127.0.0.1`; the variable replaces the
   list, so keep those when adding a host name), which Eclipse asks to
   trust once. From a clone, `npm run osd:tls` first; HTTPS is then
   `44300 + (port mod 100)`, 44330 for 3030. The binary makes no
   certificate and has no Cloud Project route.
3. Any user and password on either route: the façade does not check them,
   because there is nothing to check against.
4. The package tree, opening and editing sources, activation, ABAP Unit and
   F8 data preview all answer; every path that does not is recorded at
   `/osd/not-served`, so the worklist writes itself. Neither route was
   re-run with a real Eclipse on 2026-11-08; both wires were exercised
   with clients ([`coming-from-a4h.md`](coming-from-a4h.md) §7).

## Connecting VS Code (abap-fs)

`murbani.vscode-abap-remote-fs` speaks plain ADT over HTTP with basic auth,
and it asks for one thing at logon that a system has to answer:
`/sap/bc/adt/compatibility/graph`. OSD serves it.

```jsonc
// .vscode/settings.json
"abapfs.remote": {
  "OSD": {
    "url": "http://localhost:3030",
    "username": "developer",
    "password": "any",
    "allowSelfSigned": true
  }
}
```

Honest scope: one route served and tested, **not** a connected client browsing
a tree end to end. What the extension asks for and we lack names itself in
`/osd/not-served`, which is the instrument rather than a guess — backlog A.14
turns that list into a measured coverage number.
