# OSD image draft

One Node 24 image supports native SQLite (`STG_DB=file`), DuckDB,
HANA/HANA Express and PostgreSQL, and includes the JavaScript DIAG/RFC
listeners. The HANA Stack starts a separate SAP HANA Express container under
SAP's terms. The `draft` tag is a multi-platform manifest for `linux/amd64`
and `linux/arm64`; Docker selects the matching tested image automatically.

The unified **OSD Docker image** workflow builds both profiles on native
AMD64 and ARM64 runners. Each architecture checks its installed architecture,
license inventory and Compose acceptance suite. ARM64 covers SQLite and DuckDB;
AMD64 also covers PostgreSQL. The workflow combines the verified image digests
into multi-platform tags. To try it on a 64-bit Raspberry Pi host, use the
normal SQLite or DuckDB Stack; see the
[Pi quick start and safe upgrade notes](spin.md#raspberry-pi-arm64).
The CI acceptance run is on an ARM64 GitHub runner. Separately, SQLite ran on
a Raspberry Pi 4 (2 GB, Debian 13 arm64): the container was healthy, served
ADT/OData, and reused its persistent database after an image update. Full
DIAG/RFC client acceptance on that particular Pi was not run. HXE is not part
of this ARM64 test or Stack; its published Docker image is AMD64-only.

## Optional showcase packs

The core `draft` image has no optional packs. A separate `showcase-draft` image
contains the pinned Vivid Vibes (`o4d`), Zork and Vector workbench (`zvdb`)
packs, including their compiled ABAP, seed rows and web assets. The ready
Compose files select `showcase-draft` by default. In Portainer, set the Stack
variable `OSD_TAG=draft` to use the core image. The Compose files interpolate
that variable in the image name and pull on redeploy. The showcase
image is built with `OSD_IMAGE_PACKS=o4d,zork,zvdb`; changing a runtime
environment variable alone cannot add these packs to the core image. A new
Stack and database volume is the simplest first trial, since the vector pack
adds a table to the database schema and an existing one is not migrated. For an
existing HANA Stack, set a fresh `HANA_SCHEMA`, for example `OSD_SHOWCASE`.

A `vscode-v*` release tag publishes both profiles after all four native
builds pass. The same workflow can be dispatched with `publish=true` for a
manual publication. A dispatch with the default `publish=false` is a dry run.
See [Docker CI](docker-ci.md) for the job graph and tags.

Short, complete Portainer stacks: [SQLite](../docker/compose.sqlite.yml),
[DuckDB](../docker/compose.duckdb.yml), [HANA](../docker/compose.hana.yml),
[PostgreSQL](../docker/compose.postgres.yml).
Their full contents are generated into [spin.md](spin.md). The older
`docker/Dockerfile` and `docker/compose.yml` remain the Bun release experiments;
the ready image uses `docker/image/Dockerfile` and the four named stacks.

## Build and automation

```sh
docker buildx build --platform linux/amd64 --load -f docker/image/Dockerfile -t osd:ci .
docker buildx build --platform linux/amd64 --load -f docker/image/Dockerfile.probes -t osd-probes:ci .
sh docker/image/smoke.sh
```

The smoke suite deploys the actual SQLite, DuckDB and PostgreSQL Compose files in
disposable projects, creates an OData record and reads it after stopping and
starting the whole stack with its volumes retained (including HXE when enabled).
From a separate client container it checks the published HTTP/HTTPS ADT and
OData endpoints, renders the DIAG tape screen with pinned SAP-TUI, and calls
`SADT_REST_RFC_ENDPOINT` over 33nn. The RFC response must carry HTTP status 200
and the same serving generation as the direct HTTP/HTTPS build endpoint.
This is a schema-bound wire client: automatic deep-type discovery via
`RFC_METADATA_GET` is not supported by the current stub. It is not a claim of
general RFC compatibility or TLS transport over RFC.

Reports, raw ANSI, the rendered `diag.svg` screenshot, and RFC responses are in
`.local/image-acceptance/` locally and `image-acceptance/` in CI; CI uploads them as
`protocol-acceptance-<profile>-<arch>` even on failure. Test-client binaries
are not added to the runtime image.
On a sufficiently sized **Linux amd64** test host, after accepting SAP's license:

```sh
OSD_TEST_DATABASES='sqlite duckdb postgres hana' ACCEPT_SAP_LICENSE=YES sh docker/image/smoke.sh
```

This also boots a fresh HXE and deletes only the suite's disposable projects
and volumes afterwards. Each test selects a random starting point in instance
range **50–89**, then finds a free set of `30nn/32nn/33nn/80nn/443nn` ports.
`30nn` is reserved conservatively; the image currently uses internal HTTP 3030.
The Portainer defaults remain 11/15/17/19. Selection is advisory, not an atomic
reservation: if another process claims a port before Compose binds it, startup
fails without stopping the other process. Do not run against real data.

The [OSD Docker image workflow](docker-ci.md) runs on Docker-related PRs,
`vscode-v*` release tags and manual dispatch. PRs and default dispatches do
not log in or push. A publication uploads each architecture by untagged digest,
pulls and smoke-tests that exact image, then releases its digest artifact only
after the suite passes. The tested local image must be the pushed one (config
digest or, on a containerd image store, manifest digest; see `docker-ci.md`).
The manifest job assembles those digests and checks for both platforms.
SPDX SBOMs, provenance records and acceptance logs are kept as artifacts. The
action summary prints the published manifest digest. The GHCR package must be
public for anonymous Portainer pulls;
otherwise add GHCR credentials in Portainer. No Docker Hub account is needed.
The ready-image stacks set `pull_policy: always` for OSD, including the HXE
initializer, so a redeployment checks GHCR instead of reusing a stale local
`showcase-draft`. Existing Portainer stacks need their pasted YAML updated, or
their `OSD_TAG` set to `showcase-draft` or a newer immutable tag.
The older `open-steamgate-protocols` GHCR package remains a historical
artifact; these stacks neither pull it nor update it.

Library and test-client revisions are in `docker/image/sources.json`.
Node/Debian base tags and the transpiler's npm install can resolve newer
patches; immutable published image digests, rather than a promise of
bit-identical rebuilds, identify deployed artifacts. This first draft keeps
the JavaScript tooling that ADT needs for parsing and activation; it is not
yet a size-optimized runtime. There are no OS compilers or git in the final
OSD stage, and no build happens during normal startup.

The image's `/opt/osd/image-licenses.json` records source pins, installed npm
licenses, review blockers and explicit assumptions; original library licenses
remain beside the library files. The
repository owner authorized a temporary
MIT assumption for the pinned `oisee/open-abap-odata` and
`oisee/open-abap-gui` forks on 2026-09-20. Their original `LICENSE` files still
say `todo`; the manifest records this assumption rather than claiming an
upstream license grant. Other unrecognized
licenses block publishing. Entertainment packs and captured media are omitted.

## HANA configuration

The HANA demo Stack creates a *new* HANA Express server, an init container for
its password file, and OSD on the same private network. Only
`ACCEPT_SAP_LICENSE=YES` must be supplied manually after you accept SAP's
license. `HANA_PASSWORD` defaults to the known demo value
`OSD17_Demo!ChangeMe`; change it before first start outside a disposable,
isolated test environment. The SQL port is not published to the host. The
password is stored in the HXE volume and cannot be changed by merely editing
the Stack variable on a subsequent deployment. A cold HXE startup can take
several minutes; an orderly shutdown may also take a few minutes.
`hana-init` uses the same OSD image, not an extra custom image. It must finish
with exit code 0 before HXE starts; an exited initializer is normal. It writes
the password file that HXE requires before its first boot.

For an *existing* HANA server, configure the OSD image with `HANA_HOST`,
**tenant SQL** `HANA_PORT`, `HANA_USER`, `HANA_PASSWORD` and optionally
`HANA_SCHEMA` (default `OSD`) in your own Compose file. `localhost` inside OSD
refers to OSD, not to another container.

The adapter sets its current schema and creates it if permitted. Choose a
dedicated schema with an uppercase identifier; there is no table/schema-prefix
feature. The user needs the permissions to create/use the schema and create
and modify OSD tables. Avoid sharing a schema between independent instances.
As an alternative to environment passwords, mount a secret file and set
`OSD_HANA_PASSWORD_FILE`. Destructive `STG_DB_FRESH=1` is refused by the image.
The HXE image is pulled separately under SAP's terms; CI does not redistribute
or boot it. Test the full HXE Stack on a host with enough memory.

## PostgreSQL configuration

The PostgreSQL Stack starts a new PostgreSQL 17 server beside OSD. No SQL port
is published to the host. Instance `19` exposes HTTP 8019, HTTPS 44319,
DIAG 3219 and ADT-over-RFC 3319. The only optional setting is
`POSTGRES_PASSWORD`; its public demo default is for disposable, isolated
tests only. Set a private password before first start elsewhere. PostgreSQL
initializes credentials only on an empty data volume; changing the Stack
variable later does not change the server password. OSD uses a dedicated
database named `osd` and its `public` schema. It refuses to seed a nonempty,
unstamped database and refuses a mismatched schema fingerprint without
dropping data. `STG_DB_FRESH=1` is disabled in the image.

Older `docker-draft` images reject `STG_DB=postgres`. Deploy this Stack only
with a newly tested publication of the image; set `OSD_TAG` in Portainer to
the immutable `sha-…-run-…` tag from its successful Actions summary.

## Portainer acceptance

1. Select Docker Standalone on an amd64 host. Add a fresh `osd11` stack and
   paste the SQLite block from spin.md; instance `11` is already the default.
2. Confirm OSD becomes healthy. Open
   `http://<docker-host>:8011/app/flp.html`; trust the self-signed certificate
   to check HTTPS on 44311 as well. Set `TLS_SAN` to your hostname before
   first deployment; existing certificates are deliberately retained.
3. Open System Status → Database: expect connected `sqlite`, storage `file`.
   Read Travels, create a test travel, restart OSD, and confirm it remains.
4. Repeat with a new stack for DuckDB (default instance `15`): expect `duckdb` and
   `file`. Use exactly one worker for a writable DuckDB file.
5. Run the acceptance suite above: SAP-TUI must display `Tape loading error, 0:1`
   from 32nn, and ADT-over-RFC must return the running OSD generation from 33nn.
   These are DIAG/RFC stub entry points, not full SAP GUI/RFC implementations.
6. Use the HANA Stack (default instance `17`) after license acceptance, and
   verify `HDB` / `server` and a new HXE container.
7. Use the PostgreSQL Stack (default instance `19`) with the newly tested
   image; expect `postgres` / `server`, an OData write surviving a full Stack
   restart, and DIAG/RFC on 3219/3319.

Do not delete existing volumes or use `down -v` to upgrade a real stack.
Existing-volume schema upgrades are a separate release gate. For this draft,
persist database and TLS volumes; source/ADT edits inside the container are
ephemeral across container replacement. Internal HTTP/TLS ports stay fixed;
Compose derives the external ports from INSTANCE. Global identity/instance
harmonization in ABAP/System Status remains separate work.
