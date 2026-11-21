# open-steamgate in a container: the release directory and nothing else.
#
# The release (`bun scripts/make-release.mjs`) is already self-contained --
# the Bun binary needs no Node and no npm, and the tree it serves travels
# beside it. So the image is a base with a CA bundle and that directory; there
# is no build step here and nothing is compiled at image time.
#
# Built from the repository root so the context can reach .local/release:
#   bun scripts/make-release.mjs .local/release
#   docker build -f docker/Dockerfile -t osd:local .
FROM node:24-bookworm-slim AS provenance-check
WORKDIR /check
COPY tools/osd-provenance.mjs /check/osd-provenance.mjs
COPY .local/release/ /release/
RUN node --input-type=module -e 'import {verifyPublicArtefact} from "./osd-provenance.mjs"; verifyPublicArtefact("/release")'

FROM debian:12-slim

# Three packages, and each one was added because something measurably did not
# work without it (2026-09-19):
#   ca-certificates  TLS out of the container
#   wget             the health check below. `debian:12-slim` has neither wget
#                    nor curl, so the check could never pass -- in EITHER
#                    profile. Measured: a container serving $metadata 200 the
#                    whole time reported `unhealthy` five probes running,
#                    `sh: 1: wget: not found`. Anything waiting on
#                    `service_healthy` waited for ever.
#   libatomic1       the Node and SEA hosts (`run.sh node`, `run.sh sea`) die
#                    instantly without it: "error while loading shared
#                    libraries". The comment further down advertises those
#                    hosts, so the image has to carry what they need.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates wget libatomic1 \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /osd
COPY --from=provenance-check /release/ /osd/

# The database file lives outside the image layer, for the reason
# docs/amdp-in-hana.md records about HANA's own data: a writable layer copies
# on first write and dies with the container.
VOLUME ["/osd/data-run"]
# OSD_BIND: every interface, because a published port arrives on the
# container's own address and never on its loopback (tools/osd-bind.mjs).
# The system has no real logon; whoever publishes the port secures it.
ENV STG_PORT=3030 \
    OSD_BIND=0.0.0.0 \
    STG_DB_PATH=/osd/data-run/osd.sqlite \
    OSD_WORKERS=4

EXPOSE 3030
# the Bun binary; ./run.sh sea|node|system picks the other hosts
ENTRYPOINT ["./run.sh"]
CMD ["bun"]
