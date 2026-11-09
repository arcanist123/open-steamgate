# VS Code release

For a local Marketplace candidate, run `npm run vsix:marketplace` after
`npm run bootstrap`. This profile includes the Zork pack with its Zork I story
rebuilt from Microsoft's MIT source release, omits the browser entry,
adds the VS Code prerelease manifest property, and writes staged
`THIRD-PARTY-NOTICES.md`. Review the build's `LICENSE REVIEW` lines before
uploading anything. This command does not publish; the release workflow below
continues to build its separate GitHub VSIX. For a local stable Marketplace
candidate, use `OSD_VSIX_PROFILE=marketplace OSD_VSIX_PRERELEASE=0 npm run vsix`.

## Marketplace screenshots

Capture these in VS Code desktop with the window set to 1280x800. Save each
as a PNG at the path shown, then add its HTTPS raw GitHub URL to
`editors/vscode/README.md` in place of the matching pending-capture comment.

| View to capture | PNG path |
| --- | --- |
| OSD Activity Bar tree with a service selected and its service card visible | `editors/vscode/media/screenshots/tree-service-card.png` |
| Run with Debugger stopped on an ABAP source line, with the debug controls and variables visible | `editors/vscode/media/screenshots/debugger-abap-line.png` |

The Fiori list report image at `editors/vscode/media/screenshots/fiori-list-report.png`
is already a real capture and remains in the Marketplace README.

The [release workflow](../.github/workflows/release.yml) publishes both channels:
`vscode-v*` tags publish prereleases; `vscode-stable-v*` tags publish stable
versions on Visual Studio Marketplace and a GitHub release marked **Latest**.
The Marketplace profile publishes after the GitHub release and tagged `tests`
workflow pass. Manual dispatch selects `channel` (`prerelease` by default or
`stable`) for the GitHub release; it never publishes to Marketplace.
Configure the `VSCE_PAT` repository Actions secret for the `oisee` publisher;
the job reads it only for the final publish step.

The tag must equal `vscode-v<stamped version>` or
`vscode-stable-v<stamped version>` for its channel. Major and minor come from
`editors/vscode/package.json`; `scripts/build-vsix.mjs` stamps patch from
`git rev-list --count HEAD`. The workflow checks the tag against that version
and checks the VSIX filename and packaged manifest. Full git history is
required for this count. Before installing dependencies or building artifacts,
stable releases query Marketplace and fail clearly if that version already
exists, including as a prerelease (a prerelease rerun is not refused here, so it
can still repair its GitHub release). A prerelease version cannot
be republished as stable: use a new commit and its new stamped version.

VS Code users on the stable channel receive stable releases. Users who opt
into pre-release receive the higher version across both channels, including a
stable release when it is newer ([VS Code publishing documentation](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#prerelease-extensions)).

## Cut or repeat a release

To publish a tagged prerelease, merge the intended code, then calculate and
push the tag on that commit:

```sh
tag="$(node scripts/release-version.mjs --suggest)"
git tag "$tag"
git push origin "$tag"
```

To cut a stable release, merge a new commit whose stamped version has never
been published on Marketplace, then use the stable tag prefix:

```sh
tag="$(node scripts/release-version.mjs --suggest | sed 's/^vscode-v/vscode-stable-v/')"
git tag "$tag"
git push origin "$tag"
```

Stable publication omits `vsce publish --pre-release` and the VSIX prerelease
property. GitHub creation and editing use `--prerelease=false --latest`, with
the same title and notes as prereleases. Both tag patterns trigger identical
tests, binaries, OSGo, Compose, Docker image tags, leak scans and smoke checks.

A tag push for either channel builds a draft release and publishes it only after
the VSIX, binary, and Compose uploads all succeed and the complete tagged
`tests.yml` push run passes for the tag's exact commit. The shared gate
resolves one run ID and follows it; failure, cancellation, or a 60-minute
timeout leaves the release in draft. The Marketplace job then checks package version and zip integrity,
channel-appropriate manifest, browser entry, and licence review, and publishes the
Marketplace profile with the same version. A failed Marketplace publication
leaves the GitHub release public and the Marketplace job red; rerun the
tagged workflow after fixing the cause without moving the tag, provided the
version has not reached Marketplace. Once it exists there, a stable tag's rerun
stops at the early version check; a prerelease rerun can still repair its GitHub
release and assets, and the Marketplace job then reports the duplicate. Use a
new commit for another Marketplace release.
To prepare a draft without pushing a tag, run **VS Code release** from the intended branch.
Select `channel`, leave `tag` blank to derive the stamped version from that
ref, and leave `draft` true. You may enter a tag, but it must match the version of the
selected ref and selected channel; any existing tag must point to that commit.
The workflow uses `gh release create --draft --target <commit>` with the
selected channel flags and never runs `git push`. A dispatch with `draft=true` does not change the release's draft
state. To publish an existing draft through the workflow, push its tag and
pass tagged tests on that commit, then rerun with `draft=false` (prerelease only: a stable dispatch is
always a draft for review, and stable is published by pushing a
`vscode-stable-v<version>` tag). An untagged
draft cannot be published by dispatch because no tagged test run exists for it.
A new dispatch must first create the draft. An existing release
is updated only when its commit matches the run's checkout commit. When the
tag exists, the workflow fetches
tags and compares the commit resolved from `refs/tags/<tag>^{commit}`. For an
untagged draft, it requires the release's recorded `targetCommitish` to be
the exact checkout SHA and the release to remain a draft. Same-named assets
are uploaded
with `--clobber` on every rerun. Do not move a published tag.

The VSIX job installs dependencies with Node 24, runs `npm run bootstrap`
for the pinned libraries and packs in `libs.lock.json`, and builds the VSIX.
The system seed is assembled by `scripts/build-vsix.mjs` from the traced
`node_modules` closure. Before this change, that copied the published npm
`@abaplint/transpiler` and `@abaplint/runtime`; the release jobs did not link
the fork. The seeded binary uses the same `stageSystemSeed()` function and
had the same issue, even though CI tests link the fork. There was no licence
exclusion: the fork and upstream transpiler both declare MIT. Release builds
now compile and link the `libs.lock.json` fork before bootstrap, for the VSIX,
seeded binary, and Marketplace profile.

The locked fork commit contains upstream `only` (#1900) and registry reuse on
a second run (#1921). The release jobs link its `@abaplint/core` into the host
so the registry and transpiler use the same class identities. The
archive check requires the compiled option and the runtime DATASET host, plus
the lockfile ref stamped into the seed. The transpiler and runtime distributions
are copied without their build-time `node_modules`, sources, and tests; their
runtime dependency closure is already staged from the root lockfile. The local
VSIX measured 13.2 MiB before and 13.2 MiB after this change (unpacked 133.9
to 134.3 MiB, Node 24, default Zork pack).
Before creating or editing a release, it generates CHANGELOG.md from first-parent
GitHub PR merge titles since the nearest previous `vscode-v*` or `vscode-stable-v*` tag. A merge
commit without a title in its body gets its title from the PR API. Squash
commits and manually copied changes have no PR merge commit and do not
appear. The generated CHANGELOG.md, release README, and `FILE_ID.DIZ` pass through
`tools/osd-leak-scan.mjs --paths` before release creation. Configure the
repository secret `OSD_LEAK_IDENTIFIERS` with the JSON content of
`.local/leak-identifiers.json` (an object whose keys name identifier kinds and
whose values are arrays of private names). The VSIX job writes that content
to the gitignored file on its runner. A dispatch with `draft=true` may continue
on scan exit 2 when this secret is absent only if the release is new or remains
a draft; the job warns that the private name check did not run. Before editing
or uploading assets to an existing published release, including on a
`draft=true` dispatch, the workflow requires the secret and scan exit 0 over
all three files. It checks release state again before each upload, so an
exit-2 run stops if the release has since been published. Publication by tag
push or dispatch with `draft=false` has the same full-scan requirement.
Without the secret, the workflow fails with instructions to add it or publish
by hand after a local `npm run leak`. A match (exit 1) always stops the release.

## Assets

| Asset | Build or source |
| --- | --- |
| `open-steamgate-<version>.vsix` and `.sha256` | Universal VS Code extension, version checked against the tag |
| `osd-linux-x64`, `osd-linux-arm64`, `osd-darwin-arm64`, `osd-darwin-x64`, `osd-windows-x64.exe`, `osd-windows-arm64.exe`, each with `.sha256` | `npm run bootstrap`, then `npm run binary -- --seed <output> <bun-target>` with Bun 1.4.2 (`bun-darwin-x64-baseline` and `bun-windows-arm64` for the two added 2026-10-02) |
| `osgo-linux-x64`, `osgo-linux-arm64`, `osgo-darwin-arm64`, `osgo-darwin-x64`, `osgo-windows-x64.exe`, `osgo-windows-arm64.exe`, each with `.sha256` | `go build` with `CGO_ENABLED=0` per `GOOS`/`GOARCH` ([docs/osgo-release.md](osgo-release.md)) |
| `sqlite.yml`, `duckdb.yml`, `postgres.yml`, `hana.yml` | [Tracked Compose sources](../docker/compose/), validated with `docker compose config` |
| `README.md` | Short instructions for starting every asset, also included in the release notes |
| `CHANGELOG.md` | Merged PR titles since the previous release; the release body points to it |
| `FILE_ID.DIZ` | Classic BBS description generated from the version, with printable ASCII and CRLF lines |

The binary and Compose jobs start after the VSIX job creates the draft.
The final publish job needs all three upload jobs and the tagged test gate,
so a failed upload or test leaves the draft unpublished. A draft-only dispatch
skips the tagged test wait. Rerun the workflow to fill or replace assets. An
already published release is updated in place on reruns. Each checksum is
`sha256sum` output with the corresponding asset basename.

On a rerun against an already public release, the VSIX, binary, and Compose
jobs require a successful `tests.yml` push run for the tag's exact commit
before editing the release or replacing an asset. A draft-only dispatch can
still build and upload to a draft without waiting for tagged tests.

`npm run binary` defaults to checkout mode: it builds from a fresh checkout
after `npm ci`, without `.local/lars` or an embedded system seed. Run that
binary from a bootstrapped open-steamgate checkout (`npm run bootstrap`):
the gui converter is loaded from the checkout's `.local/lars/open-abap-gui`
at run time, with its `@abaplint/core` answered by the binary's own copy.
`--seed` (or `OSD_BINARY_SEED=1`) requires the bootstrapped libraries and
packs and embeds the seed. Run `osd doctor` to see which mode a binary
contains and whether the converter loads.

**Every binary is checked by its content before it is uploaded**
(`scripts/release-verify.mjs`, 2026-09-30): the header must name the target
(ELF x86-64 / aarch64, Mach-O arm64 / x86-64, PE x64 / ARM64) and the `.sha256` must be the
file's own digest. The Linux x64 binary, the one the runner can execute, is
also run the way a user runs it: `./osd up` outside any checkout, with an empty
data home. It must boot from its embedded seed, answer the demo service's
`$metadata` with `TravelSet`, name its generation in `X-OSD-Generation`, and
serve the ABAP file this commit changed last, read back over ADT, byte for
byte. A seed built from other source fails there. The VSIX is checked by the
version inside `extension/package.json`, the Docker image by
`docker/image/smoke.sh` before `docker.yml` publishes it, and each deployed
preview by `release-verify.mjs pages` in `pages.yml`: its `build.json` must
name the commit and its `sw.js` must carry the stamp `build.json` names.

The measured seeded Linux x64 binary is 116.0 MB (decimal, 2026-11-08, main `af7a91f0`; 316.4 MB was written here on 2026-09-30, and it was 109.5 MB on 2026-09-16). All four requested Bun targets cross-compiled on Linux x64 with Bun 1.4.2
in the local release check. No target failed to build. Only Linux x64 was
built on its native host; cross-compilation does not prove that Linux arm64,
macOS arm64, or Windows x64 starts successfully. macOS x64 and Windows arm64
were added on 2026-10-02 (the six platforms the vsp sibling ships): both
cross-compiled on Linux x64 with Bun 1.4.2 to a Mach-O x86_64 and a PE32+
ARM64, and both pass `release-verify.mjs binary`; neither has been started on
its own host. macOS x64 uses `bun-darwin-x64-baseline`, like the other x64
targets: no AVX2, so a pre-Haswell Intel Mac and Rosetta 2 before macOS 15
can run it. The binary's only native module, DuckDB, is stubbed out at build
time for every target; SQLite is sql.js (WebAssembly), and open-rfc and hdb
are plain JavaScript, so no target carries a platform-specific addon. The binaries contain the
system seed, including source, selected packs, tools, data, and pinned library
sources. On first start outside a checkout, the seed is copied into a
content-keyed `osd-home-<seedId>` under `$XDG_DATA_HOME/open-steamgate` or
`~/.local/share/open-steamgate` on Linux, `~/Library/Application Support/open-steamgate`
on macOS, and `%LOCALAPPDATA%\\open-steamgate` on Windows. Existing copies and
edits are retained. Run `osd up --layer <dir>` to add an ABAP folder above the
seed; repeat the option or use `OSD_LAYERS` with the platform path separator.
Copy an object's abapGit file from the materialized home into your layer to
edit it. The binary excludes the optional native DuckDB
module; the DuckDB Compose variant uses the Docker image instead.

The Compose files use the image published by the OSD Docker image
workflow, `ghcr.io/oisee/open-steamgate:showcase-draft`, by default. This moving
image tag includes the optional showcase packs. Set `OSD_TAG=draft` for the core
image, or set it to a tested version tag from the Docker image workflow to pin
it. SQLite
is the default file backend. PostgreSQL starts a database in the stack and
requires `POSTGRES_PASSWORD` in the caller's environment. HANA connects to
an existing tenant and requires `HANA_HOST`, `HANA_USER`, and
`HANA_PASSWORD` in the environment; `HANA_PORT` and `HANA_SCHEMA` are
optional. The HANA file carries no server address or credential value. Run
one variant at a time, for example:

```sh
docker compose -f sqlite.yml up -d
```

The release workflow does not build or publish Docker images or create a
HANA server.
