# Docker image CI

[OSD Docker image](../.github/workflows/docker.yml) replaces the separate
AMD64, ARM64 and manifest workflows. Its `build` matrix runs the core image
(`OSD_IMAGE_PACKS` empty) and showcase image
(`OSD_IMAGE_PACKS=o4d,zork,zvdb`) on native AMD64 and ARM64 runners. Every leg
builds its local image and external probe clients, checks architecture and
license inventory, and runs the Compose smoke suite. AMD64 covers SQLite,
DuckDB and PostgreSQL; ARM64 covers SQLite and DuckDB. Acceptance logs, SBOMs
and provenance records are artifacts. No QEMU is installed.

A PR changing any source included by `docker/image/Dockerfile.dockerignore`
runs both profiles on AMD64, with no registry login or
push. Select **Actions → OSD Docker image → Run workflow** and leave `publish`
unchecked for the same dry run on both architectures and both profiles. Set
`publish=true` to publish a tested commit manually. A `vscode-v*` or `vscode-stable-v*` tag push
publishes automatically. The old `osd-image-*` tag trigger and weekly Docker
cron are retired; release tags and manual dry runs now select Docker builds.

The read-only `build` matrix handles PRs and dry runs. On a publishing run, the
`publish` matrix pushes each build by untagged digest, pulls that exact digest
for the same smoke checks, and uploads the digest only after they pass. Only
this matrix has package write permission. Before exposing the digest to the
manifest job, `docker/image/verify-pushed.sh` checks that the tested local
image is the pushed one, and the pushed platform and revision label. The image
ID it compares depends on the daemon's image store: the classic store reports
the config digest, Docker 29's containerd store (the `ubuntu-26.04` runner
image behind `ubuntu-latest` since 2026-11) reports the manifest digest; either
match is accepted, anything else fails with both digests in the log. The
read-only `build` matrix runs the same push-by-digest, pull and check against
a throwaway `registry:2` service on the runner, so a PR or a `publish=false`
dry run exercises the publish legs' identity check on each runner image.
The SBOM step (`anchore/sbom-action`, which downloads syft from GitHub
releases) is tried up to three times, 60 s and 180 s apart; the SBOM stays
required.
On a `vscode-v*` or `vscode-stable-v*` tag push, each `manifest` job first verifies that the tag resolves
to the commit used to build the images, then waits for the complete
`tests.yml` push run of that exact tag commit using the same gate as the VS Code
release. A failed, cancelled, or timed-out test run leaves only untagged
digests in GHCR. Manual `publish=true` runs have no tag test run and retain
their explicit manual publication path; the `publish=false` dry run never
waits. The `manifest` matrix then joins the two digests for each profile and checks
that the manifest contains exactly AMD64
and ARM64. The GHCR package is `ghcr.io/oisee/open-steamgate`. For a release
tag `vscode-v0.7.N` or `vscode-stable-v0.7.N`, showcase receives `0.7.N`, `showcase`, `latest` and
`showcase-draft`; core receives `0.7.N-core` and `draft`. A manual publication
uses `sha-<commit>-run-<run-id>-<attempt>` in place of the version, with
`-core` for core, and updates the same moving tags. The `showcase-draft` name
remains available for existing Compose stacks. Use the version tag or digest
from the workflow summary to pin a deployment.
