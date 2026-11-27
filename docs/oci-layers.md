# OCI layers and systems

`tools/osd-layer.mjs` builds reproducible abapGit repositories, publishes them
through the OCI Distribution API, and groups layers into an ordered system.
No external registry client is needed.

```sh
node tools/osd-layer.mjs build ./src/example --name example --kind input --out /tmp/example-layer
node tools/osd-layer.mjs push ghcr.io/owner/osd/example:v1 ./src/example --name example --kind input
node tools/osd-layer.mjs system push ghcr.io/owner/osd/system:v1 ghcr.io/owner/osd/example@sha256:<64-hex>
node tools/osd-layer.mjs inspect ghcr.io/owner/osd/system@sha256:<64-hex>
```

Build prints the tree and manifest digests. Push commands print a digest
reference suitable for pinning; inspect accepts a tag for discovery as well
as a digest. System inputs must be digest references. Earlier layers are lower;
later layers overlay them. Publishing does not install or transpile a system.

## Layer format

A layer is an OCI image manifest v1.1, with `schemaVersion: 2`, media type
`application/vnd.oci.image.manifest.v1+json` and artifact type
`application/vnd.osd.layer.v1`. Its config has media type
`application/vnd.osd.layer.config.v1+json` and this JSON shape:

```json
{"schema":1,"name":"example","kind":"input","treeDigest":"sha256:<64-hex>","source":{"repo":"https://github.com/owner/repo","commit":"<commit>","path":"src"}}
```

`kind` is one of `lib`, `input`, `pack`, `customer`. The optional `source`
is supplied by `--source <repo>@<commit>:<path>`. The manifest annotations
are `org.osd.layer.name`, `org.osd.layer.kind` and, when source is known,
`org.opencontainers.image.source` (the repository).

`build` and `push` accept `--private` for private source. This adds
`"private":true` to the config and `org.osd.layer.private=true` to the
manifest. Without the flag, neither field is present and existing digests
remain unchanged. Private layers, including any system containing one, may
be pushed only to an exact registry host in `OSD_PRIVATE_REGISTRIES` (comma or
whitespace separated `host[:port]`). A bare host matches only a reference
without a port; `host:port` matches only that port. The default is empty. `ghcr.io` and
`*.github.io` always refuse private layers, even when listed. A refusal is
`PRIVATE_LAYER` (CLI exit 2) and names the layer and destination registry.
System descriptors carry the private annotation; system push reads every
layer config again before uploading.

Public artefacts made from a checkout (release and download archives, the
VSIX and binary seeds, the OSGo and Bun release binaries, Pages, the Docker
image, CI artifacts, the system release) call `assertPublicSystem`. It
refuses, as `PRIVATE_LAYER`, an installed system with a private layer, a
private fetched source under `packs/`, and a live generation built from
either: every generation's `manifest.json` records `systemDigest`,
`systemPrivate` and the privacy of each input. A live generation without that
record, or from another system than the installed one, is refused until
rebuilt.

An artefact copies the working tree, not the manifest, so its provenance comes
from `tools/osd-public-tree.mjs`. At write time, and again at verify time for
artefacts made from the tree (the release directory and its hosts, download
bundles, the preview and its screenshots, the Docker image, the CI archive),
it requires the tree to hash to the live generation (`hashOf(root)`, which
names private and unknown inputs) and recomputes the privacy of every
current input, `OSD_PACKS` folders included. A private pack fetched after a
public build is refused; any other change asks for a rebuild. The sidecar of
a directory artefact records links by their target and refuses a link that
leaves the artefact.

**The read record.** A generation's privacy comes from what its build
actually read, not from a second walk of what it should have read. Every
reader of source bytes (the transpiler's file and library loads, media,
RAP bindings, BSP and pack files, source layers) reports each read, and every
generator child runs under `tools/osd-generator-reads.mjs`, which hooks
`node:fs` and `node:child_process` and logs each read with its real path and
digest. The build writes them to `build/by-input/<hash>/reads.json`
(`tools/osd-read-record.mjs`): `{schema, root, reads: [{path, real, sha256,
privacy, identities}], uncovered}`. A read's privacy is that of the
`.osd-source.json` / `.osd-layer.json` markers in its real ancestry (any
private → private; else any unknown → unknown). `publicProvenance`,
`assertPublicSystem` and `osd-ci-artifact pack` require the record
(`READ_RECORD` when missing or invalid) and refuse, as `UNKNOWN_PRIVACY`:

- a read outside what `hashOf` digested (`uncovered`), or one whose bytes or
  target changed since;
- an incomplete record: a child the recorder cannot follow (a shell, a
  non-node program, a worker, a detached child, a node child that never
  answered the handshake) or a read it could not name;
- a read of unknown privacy, or one whose identity marker changed.

A node child is also incomplete when anything could run before the recorder
or start processes past it (`tools/osd-generator-children.mjs` `preloadsOf`):
a `-r`/`--require`/`--import`/`--loader` other than the recorder itself, an
env or config file (`--env-file*`, `--experimental-*config-file`), `--run`,
`--test`, `--watch*` or a snapshot flag -- in node's argv, in `NODE_OPTIONS`
(osd's own children included) or in a fork's `execArgv`. Every word of the
argv is scanned, the script's own arguments too: telling them apart would need
node's full list of flags that take a value, so the check fails closed. **For
generator authors:** a generator whose child gets an argument spelled like one
of these flags (`--require`, `--run`, `--test`, ...) makes its generation
unpublishable. Give such an option another name, or pass the value through a
file or the child's environment; and start node children with plain
`node <script>`, not through npm, npx, a shell or `node --run`.

`hashOf` therefore digests every file class the build reads: input folders by
what the transpiler lists (not by extension, so W3MI media count), locked and
URL libraries whole, root `data/` and `abaplint.jsonc`, BSP and pack folders,
and what finding the packs reads -- every manifest in the tree's own pack
place, selected by `OSD_WEB_PACKS` or not (a left-out pack's fetched
identities are not read; a selected pack's are hashed with it). `OSD_PACKS` places (the extension's per-machine
scratch pack) are not digested. DSL navigation metadata
(`*.trace.meta.json`) is neither read nor hashed.

What the record does not cover: reads by native code or by a program that
is not node (they make the record incomplete rather than wrong, except git,
which runs only for a fixed list of metadata commands); bytes that reach the
output without a file read (environment variables, network); and the
transpiler and generator code itself, which is named by the generator
identity in the hash rather than by the record.

A binary built before any generation exists (the fresh-clone check in
`tests.yml`) is built with `build-binary --unstamped`: test only, refused with
`--seed` or a release target, and without a sidecar, so make-release,
make-download-bundle and release-verify refuse it. `buildVsix(..., {stamp:
false})` is the same for test packages and has no command-line form; a
prebuilt VSIX is stamped from its own seed's live generation.
`test/oci-release-workflow.mjs` checks every workflow job: a stamping step
comes after a step that builds a generation.

A fetched identity has `private` true or false, or `null` when the source
cannot attest it: only an osd layer config can, so a foreign OCI zip (an
empty config) records `null`. An identity fetched before the field existed
has none. Both build and serve; every publishing path refuses them, and
`node tools/osd-fetch.mjs` fetches an identity without the field again.

A CI artifact carries the live generation, never all of `build/`. Of the
caches every generation shares it carries what the public live generation
reaches, which is what the swap job's fast path reads: the
`build/source-by-digest` entries named in live's `source-inputs.json`, and
live's cross-reference rows `build/xref/<key>.json`. Each is listed with its
digest in `.local/ci-artifact/closure.json`; `osd-ci-artifact verify` checks
every listed digest and refuses an unlisted file. `pack` derives live's rows
when no host wrote them and exits 3 when a fast-path input would still be
missing; a shared store linked out of the tree is refused. The CI
transpiler it carries (`.local/ci-artifact/transpiler`) is bound by
`tools/osd-ci-transpiler.mjs` to the pinned commit and a digest list of its
files: no tracked change, no file that is neither tracked nor ignored by the
clone (its ignored build output ships as listed), no source identity marker
inside it or above it. Its `.git` ships, because a consumer names the linked
transpiler by `git rev-parse HEAD` in it.

From a shell, `node tools/osd-public-tree.mjs write|verify <artefact>` stamps or
verifies against the tree; `node tools/osd-provenance.mjs verify <artefact>`
checks bytes and record only, with no repository imports.

A layer cannot be built from a build store without `--private`: a folder
under this checkout's `build/`, under any `build/` holding `by-input` or
`source-by-digest`, or holding a generation `manifest.json`. Files copied
out of a store carry no identity and cannot be detected; keep their identity
with them or mark the layer private.

`build` and `push` also accept `--closure <file.json>`. The file must hold
`{"unresolved":0,"items":[]}` with a nonnegative integer and an array of
opaque objects, within 4 MiB. The config stores it only when supplied. A
system with closures records their sum as `org.osd.system.unresolved` on the
index. `inspect` and `osd-fetch --system` report each layer's count and the
system total when present.

There is exactly one layer blob, media type `application/vnd.osd.abapgit.zip`,
with `org.opencontainers.image.title` equal to `<name>.zip`. Config and blob
descriptors contain the SHA-256 digest and byte size of their exact bytes.

The ZIP is an abapGit offline repository. When the folder contains a root
`.abapgit.xml`, its files retain their relative paths, including its
STARTING_FOLDER layout. Otherwise input/customer files are placed under
`src/`, while lib/pack files keep their paths; the builder generates
`.abapgit.xml` with STARTING_FOLDER `/src/`. Symlinks and
other nonregular entries are refused, as is `.osd-source.json` at any depth;
build from the original source tree rather than a fetched tree's identity file.
The builder skips `.git` (directories and files) and `node_modules` at any
depth and logs each exclusion. Copied layers containing them are refused.

Files are sorted by UTF-8 path bytes, stored without compression (method 0),
and encoded with UTF-8 flags, fixed version fields, no extra fields and the fixed ZIP date
1980-01-01. No current timestamps appear in the config, manifest or index.
The shared ZIP encoder also serves `osd-abapgit-zip`'s in-process path, which
retains its existing compression level. Rebuilding the same inputs produces
identical ZIP, config and manifest bytes across Node and Bun: the digest is
runtime-independent because entries are stored. abapGit's `cl_abap_zip` reads
method 0. Before republishing a layer, the tool extracts and re-encodes its
ZIP and requires byte equality (`NOT_CANONICAL` otherwise), rejecting comments,
extra fields, compression and differing entry order. It also verifies treeDigest.
So a system holds only layers built by `osd-layer`: `osd-fetch` accepts a
foreign zip (a plain `oras push`, an abapGit export) as a pack source, but to
join a system it is unpacked and rebuilt with `osd-layer build`, which gives it
a new digest.

The leak gate before every push scans each file's content under a neutral
name, the archive paths, the config, the annotations and the destination
reference, and refuses a capture file (`*.pcap`, `*.pcapng`, `*.jsonl`) and any
file larger than the scanner reads. The repository's `.leak-allow.json` does
not apply to a published layer: a folder whose content is only allowed in this
repository (`packs/lsd`, `packs/zvdb`'s vectors) cannot be published as is.
A layer brings its own exceptions instead: `osd-layer push … --leak-allow
<file>` and `osd-layer system push … --leak-allow <file>` take a file in the
publication exception format. Every entry requires `layer`, archive `file`,
`fileSha256` (SHA-256 of the entire staged file), `category`, exact positive
`count`, and a reviewed `reason`. Identifier categories use numbered category
IDs; entries never contain matched text or a hash of matched text. Changed
bytes, missing paths, ambiguous layers and changed category counts are
`BAD_ALLOW`. Metadata documents are never excepted. The flag repeats.
Public scanner output contains categories and paths only.
For private layers the same gate uses `--private-layer`: it ignores only
entries in the two existing identifier-list categories
`корпус SAP (A4H, только локально)` and `SEGW-образцы SAP (только локально)`
(`SAP_CORPUS_CATEGORIES` in `tools/osd-leak-scan.mjs`); no list is renamed.
A list with neither category is refused. Every other category, hosts, users,
logons, project names, credentials, tokens, addresses, home paths and binary
IPv4 views remain checked.

`treeDigest` uses `tools/osd-oci.mjs`'s shared helper: SHA-256 of concatenated
`<content sha256 hex>  <archive relative path>\n` lines, sorted by UTF-8 path
bytes, over exactly every file in the ZIP, including `.abapgit.xml`. Content
is hashed as raw bytes, preserving BOM and line endings. `osd-fetch` verifies
this before selecting `path` (default `src`) and applying exclusions:

```json
{"sources":[{"folder":"upstream","oci":"ghcr.io/owner/osd/example@sha256:<64-hex>","path":"src","exclude":[]}]}
```

A layer whose STARTING_FOLDER is not `/src/` needs an explicit `path` in the
pack source, for example `"path":"objects"` for STARTING_FOLDER `/objects/`.

## System format

A system is an OCI image index with `schemaVersion: 2`, media type
`application/vnd.oci.image.index.v1+json` and artifact type
`application/vnd.osd.system.v1`. `manifests` holds layer manifest descriptors
in layer order, each with `org.osd.layer.name`, `org.osd.layer.kind`, and
`org.osd.layer.order` annotations. Orders are decimal strings `"0"`, `"1"`,
… without gaps or duplicates. Resolvers verify these annotations and sort by
them; array position alone does not establish order. Inspect checks the index
identity against each layer config and verifies each layer's tree digest.

Index annotations include `org.osd.osg.commit` from `git rev-parse HEAD` of the
tool's OSG checkout (resolved relative to the module), omitted when it has no
Git metadata. `org.osd.transpiler` is `repo@ref` from `libs.lock.json` under
`OSD_ROOT` or the working directory, omitted when no transpiler is recorded.
There is no created timestamp.

All referenced manifests and blobs live in the index's repository. Descriptors
carry no repository. For layers from other repositories on the same registry,
publishing first tries `POST /v2/<repo>/blobs/uploads/?mount=<digest>&from=<other>`.
If a mount is unavailable it uploads the verified bytes; layers from other
registries also use verified downloads and uploads. The layer manifest is PUT
by digest into the destination repository before the index is published.
Existing blobs are skipped after HEAD. Uploads use POST followed by monolithic
PUT to the returned Location, preserving its query and adding `digest`.
Upload locations must have the same origin as the registry.

## Authentication and publication gate

Push uses `repository:<repo>:pull,push` token scope, with the same credential
rules as pull: `OSD_OCI_USER` and `OSD_OCI_TOKEN` apply only to the exact host
in `OSD_OCI_REGISTRY`; `GITHUB_TOKEN` applies only to `ghcr.io`. Token realms
must be HTTPS except for local test registries. JSON reads are capped at 4 MiB;
blob reads are bounded by their descriptor size and verified by digest.

Before any registry write, the layer CLI runs `tools/osd-leak-scan.mjs --paths`
over every published file's content under neutral `content/000001.txt` names,
a `paths.txt` listing archive paths, and `meta.json` with config, manifest/index
annotations and destination references (repository and tag). Original OCI JSON
bytes also pass through the neutral content scan before publication. Files and
metadata exceeding the scanner's 8 MiB size limit are refused rather than skipped.
A system scans every downloaded layer and the index before copying anything.
Scanner exit 1 refuses publication with `LEAK` and redacted findings (CLI exit 2).
Scanner exit 2, including a missing identifier list, or a spawn failure refuses
with `SCAN_FAILED` and its reason. The scanner finds `.local/leak-identifiers.json`
or the path in `OSD_LEAK_IDENTIFIERS` using its normal lookup rules. Findings are
redacted. The gate does not change or weaken scanner rules.

`.github/workflows/oci-layers.yml` is manual only. It publishes two smoke
layers and a system to GHCR, inspects the system and fetches a pinned layer
through an OSD pack. It needs the `OSD_LEAK_IDENTIFIERS` Actions secret and
package write permission; it fails closed when the secret is absent.

## Install one complete system (E.10 step 3)

```sh
node tools/osd-fetch.mjs --system ghcr.io/owner/osd/system@sha256:<64-hex>
npm run transpile
```

The reference must be pinned by digest, without a tag. Alternatively pass a
local system index JSON, or an OCI layout's `index.json` containing one
system-index descriptor. The layout wrapper is followed one level, verifying
the descriptor's digest and size. Layer manifests, configs and ZIPs must be
present under `blobs/sha256/<hex>` beside the supplied file. The system index's
exact bytes are hashed to obtain its identity; every referenced blob is checked against
its descriptor's digest and size. Registry indexes are verified against the
requested digest. Both forms verify contiguous orders, layer identities,
canonical ZIPs and tree digests before installation.

The installer extracts into a sibling staging directory, writes every layer's
`.osd-layer.json` and the system's `.osd-system.json` there, then renames the
complete directory to `.local/system/`. An existing installation is moved
aside only after validation; a failed final rename restores it. Validation
failures leave the previous installation untouched. The system identity holds
`digest`, toolchain `annotations`, and `layers`, each with `order`, `name`,
`kind`, manifest `digest`, `treeDigest` and a system-relative `path`.

`tools/osd-system.mjs` supplies the shared `activeSystem(root, env)` resolver:

- `lib` layers live in `libs/<name>/`. The name is the library's
  `libs.lock.json` folder. Libraries retain repository paths even when they
  have no `.abapgit.xml` (one is generated without wrapping the tree). They
  remain transpiler dependencies with the configured `files` and
  `exclude_filter` selection rules. Installed layer identity replaces the
  Git checkout gate; a missing configured library is an error naming it.
- `input` and `customer` layers live in `inputs/<name>/`; their abapGit
  STARTING_FOLDER supplies the input folder. Inputs, packs and customers
  follow index order, with `gen/` appended last. Put customer layers after
  the tree's own inputs. Later objects win and override reports name both
  paths. The checkout's own `src/` and `test/` are ignored in system mode.
- `pack` layers live in `packs/<name>/`; only these packs are discovered.
  Their index order supplies ABAP, whole-table TABU seed precedence, DDIC,
  tiles and webapps, regardless of the manifests' development `order` values.
  Pack names must be lowercase, matching pack discovery.
  Pack files retain their paths at the ZIP root. A missing `.abapgit.xml`
  is generated with STARTING_FOLDER `/src/`; a web-only pack needs no src.

The proof includes `test/` as an input layer named `test`: its ABAP Unit
objects are part of today's transpiled system. Generator inputs exclude
this layer, just as they exclude the development tree's incomplete fixtures.
`gen/` is always regenerated and never published as a layer. The `src` input
can be built from a staged repository root containing `.abapgit.xml`, `src/`,
`data/` and `webapp/`, so the tree's seed captures and static pages also belong
to the digest. Only the input layer named `src` supplies these root `data/`
and `webapp/` directories. Other input layers and customer layers contribute
ABAP from their STARTING_FOLDER; their repository-root `data/` and `webapp/`
are not consumed. Use a pack layer for additional seed data and pages.
Logical source paths preserve configuration exclusions and
source maps after installation. The SEGW schema now lives at
`tools/segw-tables.json`, as part of the toolchain rather than an ABAP input.

For a pack with fetched sources, fetch first, stage a copy of the complete
pack, remove `.osd-source.json` and `.osd-fetched.json`, and strip `sources`
from its staged `osd-pack.json`. Preserve its `abap` folder list and the
resolved folders at their original paths. Build that copy with `--kind pack`.
Unresolved `sources`, names differing from `--name`, escaping folder paths and
fetch identities are refused. `scripts/system-roundtrip.mjs` implements this
staging recipe. No later source fetch is needed by an installed pack.

System mode refuses `OSD_PACKS`, `OSD_WEB_PACKS`, `OSD_LAYERS`, every
`OSD_LIB_*` override (including empty settings), and an existing `local/tmp`
layer even with `OSD_TMP=off`. Removing `.local/system/` returns to ordinary
checkout resolution. With no active system, development resolution retains
its existing behavior. The generation hash adds the system digest to its
existing content and toolchain hashing. Internal registry discovery uses
an explicit option to reuse already selected roots; unit discovery can omit
extra checkout packs without setting environment overrides. An installed
system always retains its complete index closure. ADT exposes installed source
roots as read-only and refuses saves, creates and deletes through its existing
ReadOnly response before writing source or inactive versions. `$TMP` has no
writable root in system mode; creating an object there is also refused.
The VS Code debugger resolves logical source maps to the installed files,
including breakpoint discovery and attach path overrides.

Each build's `prepare()` re-reads and verifies every installed layer's complete
treeDigest, including libraries, source, seeds and static pages, before using
a cached generation or running generators. Only the installer's root identity
file is excluded. Added, changed, missing or nonregular files refuse the build,
name the layer and say `run osd-fetch --system again`. There is no development
bypass: edit a checkout and rebuild/refetch the layer. Verification logs its
file count, byte count and elapsed time; the roundtrip report records that cost.

“System = digest” covers the ABAP, fresh seed data and pages, with the OSG
commit and transpiler pin recorded by `org.osd.osg.commit` and
`org.osd.transpiler`. A different running OSG commit prints a warning and is
allowed; reproducing the original toolchain uses those annotations. No live
database state is included or restored.

### Local roundtrip proof

```sh
OSD_HEAVY_RANGE=50-59 GOCACHE=/mnt/ssd-510/osg/go-build TMPDIR=/mnt/ram/stoker \
  tools/osd-heavy.sh node scripts/system-roundtrip.mjs
```

This dev tool is outside CI. It syncs absent libraries, fetches pack sources,
builds all locked libraries plus src, test and every pack, and uploads them to
the in-process loopback registry from the test helper. It creates a scratch
checkout without src, packs, data, webapp or gen, installs by digest, builds
both roots and compares SHA-256 hashes of every output file and both file sets.
It reports the index digest, per-layer file counts and byte sizes, total size,
object counts, differing paths, layer-verification cost and elapsed time. `OSD_ROUNDTRIP_DIR` can name
a directory outside the heavy wrapper's temporary directory to keep its
scratch tree, build logs and `report.json` after the wrapper exits.

The proof uses the registry fixture's low-level upload functions, so it can
include the repository-allowed pack vectors that the public publication leak
gate refuses. Its registry binds only loopback and is closed on completion;
it never publishes to a network registry. Real publication continues through
`osd-layer push` / `system push` and their unchanged fail-closed leak gate.

## Release publication

Alice's decision (2026-10-15): publish only release tags, **never merges to
main**. `.github/workflows/oci-release.yml` runs for `vscode-stable-v*`
(stable) and `vscode-v*` (prerelease), with no manual dispatch trigger. The test gate exports its resolved commit SHA; both later jobs
check out exactly that SHA and refresh the remote tag at startup. Publication
refreshes it again immediately before the first upload. A moved or deleted tag,
a dirty checkout, or a HEAD differing from the tested SHA is refused. Runs for
the same tag queue without cancellation.

Published bytes always come from the tested SHA: the publisher checks out by
SHA, so moving the tag during upload cannot change those bytes. The tag check
and registry uploads are not atomic. If the tag moves after the final
pre-upload check, the `public-check` job refreshes the tag and asserts that it
still names the tested SHA; a mismatch fails the run even though packages may
already have been uploaded. The operator must then delete the release's
packages, or re-run the workflow for the intended tag after its commit passes
the required tests.

`scripts/system-publish.mjs` shares the roundtrip's staging recipe: locked
libraries, src (including seeds and pages), test, and every resolved pack,
with fetch identities and staged manifest `sources` removed. It publishes
through the same layer and system leak validators as `osd-layer push` and
`system push`, then uploads the gated bytes to
`ghcr.io/<owner>/open-steamgate/<kind>-<name>:<release-tag>` and
`ghcr.io/<owner>/open-steamgate/osd-system:<release-tag>`. Kinds are `lib`,
`input`, and `pack`. All packages link to this public OSG repository; library config sources still
record their upstream repository and locked commit.
The layer and system CLIs accept `--annotations <JSON-file>` for string annotations;
these pass through the same metadata leak gate.

The complete `lsd` pack and complete `zvdb` pack are omitted: the former has
repository-only content, the latter repository-only vectors, which the
public gate refuses. The repository allow list is never imported.
Every omitted pack and its reason is printed and recorded in the system's
`org.osd.release.omitted-packs` JSON annotation and job summary/text artifact.
All other packs are included without a cap; any other refusal fails the job.

Pin the printed `repo@sha256:...` references rather than the discovery tags:
`node tools/osd-fetch.mjs --system <system-repo@sha256:...>`. The workflow
requests a pull token from `ghcr.io/token` **without credentials** for every
published repository and GETs each manifest, including the system manifest,
by digest. Any package that is not publicly readable fails publication
verification. It then installs the system by digest in a scratch root and
runs the existing complete treeDigest verifier and the real `osd-build` /
transpiler, then executes the generated `init.mjs` / `initializeABAP()` and queries its initialized
database. The scratch root includes the checkout’s `test/` runtime support,
including `setup.mjs`. Any build or initialization failure fails the job. All layers and the complete system
pass their gates before the first upload. Publication also waits for the
successful `tests.yml` push run for the exact tag commit and uses the same
stamped-version validator as the VS Code release. The job summary and plain
text Actions artifact contain the system pin, ordered layer pins and omissions;
no GitHub release assets are created.

The release workflow explicitly passes `--leak-allow .leak-allow.release.json`
to the publisher. It validates the file using `osd-layer`'s existing allow-file
checks, requires an included layer name on every entry,
then passes only that layer's entries to its layer gate and the complete file
to the system gate. The manual smoke workflow does not use this file.
Exceptions cannot cover metadata, another path, another layer, or changed bytes.

Each exception records one of these reviewed classes:

- **A:** a false positive in encoded/binary data, such as integrity hashes,
  generated source hashes, embedded font bytes or seed PNG pixels.
- **B:** a hand-authored synthetic fixture value, verified to identify no real
  system or session.
- **C:** unchanged text in a public upstream repository at the locked commit.
  The reason links to that exact file/commit and names a public branch that
  contains the commit. Both public reachability and byte equality are checked.
- **D:** anything that might identify one of our live systems. Stop publication;
  never allow it. Report only the layer, archive path and category to Alice.

New user-owned GHCR packages may start private. The anonymous public check
fails closed. On the first release, each new package may need to be switched
to public by hand in its GitHub package settings, then the workflow rerun.
Expected packages under `open-steamgate/`:
`lib-open-abap-core`, `lib-express-icf-shim`, `lib-open-abap-apc`, `lib-abapgit`,
`lib-open-abap-gui`, `lib-open-abap-odata`, `lib-ajson`, `input-src`, `input-test`,
`pack-o4d`, `pack-zork`, `pack-gui-examples`, `pack-travels-a4h`, `osd-system`.

To add an entry, run the offline staging/build preflight, establish A/B/C
provenance locally, and record the entire staged file's SHA-256, category
and exact match count. Never record a matched value or its fingerprint.
Regenerate counts under neutral filenames, as the publication gate does.
Re-run every included layer and the system gate, then prove an unrelated byte
change and injected addresses/identifiers refuse publication in every layer kind.
The complete `lsd` and `zvdb` packs retain their existing omissions.

Release permissions are isolated in three jobs. `wait-for-tests` has only
`actions: read` and no identifier secret. `publish` needs that gate and has
`contents: read`, `packages: write`, and the identifier secret. Publication
uses only Node built-ins: no npm install, compiler build, or transpiler link.
The security boundaries are a tagged, tested commit reviewed as first-party code,
exact job pinning, no third-party code on disk in the publish workspace, and
minimal child environments. Immediately after
checkout, and again immediately before the publish command, the job asserts
that no `node_modules` entry exists anywhere under `GITHUB_WORKSPACE`, including
hidden folders and linked directories; traversal errors fail closed. It never
installs dependencies or restores a dependency cache. `setup-node`'s own Node
toolcache is the runtime itself and is acceptable outside this workspace.
Locked library and pack sources are treated as data, never executed.

The workflow test pins the exact job set (`wait-for-tests`, `publish`,
`public-check`), top-level permissions (`{}`), concurrency and tag-only triggers.
It walks every string in each pre-install step's `run`, `env` and `with` to
refuse secret references and pins every step from installation onward.
It also compares the entire publish job against an explicit expected
value: ordered steps, pinned action SHAs, every run line, conditions and
environment. Any addition or change requires review of that allowlist. Commands
such as `node --eval`, `node --import`, `npx`, tab-separated npm invocations,
and extra Node entries fail by construction. The complete `wait-for-tests` job
is also compared against an independent expected value, including the tested step; masking a failure with `|| true`
requires review and fails the test.

The parser-based import guard catches accidents; it does not defend against a
deliberately obfuscating first-party author. Code review of the tested tag
handles that threat. The lint is not a security boundary. It covers
publish entry points, inline modules and the leak scanner, rejects nonliteral
and third-party imports, and flags dynamic execution by AST. Its builtin
allowlist is exactly `node:fs`, `node:path`, `node:url`, `node:crypto`,
`node:os` and `node:zlib`; `node:child_process` is permitted only through
the exact-source exceptions below. Every other builtin is refused.
First-party subprocess exceptions live in
`test/fixtures/oci-publish-subprocesses.json`: file, module, function, fixed
executable (`git` or `process.execPath`), fixed scanner script under `tools/`,
and the exact call source. Each entry permits one occurrence; another call in
the same file, an alias, or a changed executable/script fails. Public boot tools
and VSIX/GitHub release subprocesses are outside the publish import graph. The
binary host registers its scanner dispatcher at startup; plain Node publishing
uses the fixed repository scanner path and does not use `OSD_SELF` dispatch.
No static JavaScript denylist can prove arbitrary code safe. The tagged tested
commit, exact job pinning, workspace assertions and minimal child environments
are the security boundaries.
No third-party action runs after the identifier file is written, even after
removal. `public-check` needs both earlier jobs, receives its
pinned system and layer report through job outputs, and has only
`contents: read`, no secrets and no package permission. A fresh runner makes
anonymous install/build/initialization independent of publishing credentials
and private files. Only the unprivileged jobs install npm dependencies with
`--ignore-scripts`; the public check builds the pinned transpiler with lifecycle
hooks disabled. Identifier-list exceptions and redacted logs use the single
coarse category `identifier`; internal list categories never enter public output.
Repository allow entries cannot store value fingerprints either.

The publish job runs only for a release tag push and declares
`environment: release`; there is no manual dispatch trigger. The repository
owner must create the `release` environment and restrict deployment tags to
`vscode-v*` and `vscode-stable-v*`. The publication-only secret
`OSD_RELEASE_LEAK_IDENTIFIERS` must be an environment secret of `release`, never a repository secret.
Only the publish job reads that name. Keep the repository-level
`OSD_LEAK_IDENTIFIERS`: `leak-scan.yml`, `release.yml` and `oci-layers.yml` still
read it. The separate name prevents fallback to that repository secret: a
missing environment yields an empty secret and fails closed. The install step
checks for a non-empty value after checkout, fetching and staging have finished,
then writes the identifier file in that same step. Stoker will ask
Alice to configure this; the code change does not create or change GitHub settings.

The identifier file must not coexist with fetching or unpacking layer sources,
or executing content from outside the tested commit. The job checks out that commit,
asserts no `node_modules`, sets up Node, validates the tag, resolves locked
libraries and packs in release mode, and stages a release plan with validated archives before writing
the identifier file. Release Git sources require a full 40-hex commit SHA and
an `https://` repository URL; Git option terminators and a protocol allowlist
reject option injection and local/external transports. The identifier list is
installed only after this preparation, then the job repeats the dependency
assertion and publishes. An `always()` step removes the list on failure too.
After the file appears, fetched sources are read only as data for scanning,
hashing and upload; they are never imported or executed.
The publisher uses the prepared plan and exact gated layer bytes to upload
the system directly, with no registry layer pull or unpacking. Immediately
before the first upload, after scanning and registry preflight, first-party Git
fetches the tag ref from `origin` with fixed argv and requires the remote tag
commit to equal both HEAD and TESTED_SHA. A moved or deleted remote tag refuses
publication. This one tag refresh may run while the identifier file exists.
Every subprocess in the publish import graph, including all Git calls and the
plain Node leak scanner, receives an explicit environment from the one shared
`publishChildEnv` helper in `tools/osd-env.mjs`, built from constants:
`PATH=/usr/local/bin:/usr/bin:/bin`, `HOME=/tmp`, `LANG=C.UTF-8`. Git additionally
gets `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null` and
`GIT_TERMINAL_PROMPT=0`. No child inherits `process.env` or a spread of it;
`GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_*`, `GIT_CONFIG_VALUE_*`, `NODE_OPTIONS` and
registry credentials cannot reach a child. GHCR credentials stay in the
publisher process that needs them for its built-in HTTP client. A first-party
child probe verifies this with a poisoned parent environment, and an AST guard
requires the helper at every spawn/execFile site in the publish graph.
An `OSD_LEAK_IDENTIFIERS` override is forwarded as an explicit
`--identifiers` file path, otherwise it reads the list from its first-party checkout. The public job refreshes the remote tag again before its
independent boot check, catching movement during upload too.

The import lint follows real paths (including symlinks) and requires every
relative module in the publish graph to be tracked by Git under `tools/`,
`scripts/` or `bin/`. Fetched directories, `.local/`, `upstream/` and workspace
dependencies cannot supply publisher code. Exact subprocess exceptions also
bind every call through the reviewed Git wrappers to its argv source.
Loader properties such as `binding`, `dlopen` and `getBuiltinModule` are
rejected on every receiver. Nonliteral element accesses other than individual
environment-property reads, value uses of `globalThis`, and assignments to `process.env` or its members
are refused; `process` cannot be aliased as a value. `constructor`, `execve`
and `loadEnvFile` members are also refused. `process.env` may only be the object
of a plain property read: aliases, spreads, `Object.assign`, `Reflect.set` and
`Object.defineProperty` uses fail the lint. Configuration helpers read named
settings individually; those settings never form a child environment.

Before any registry write, publication resolves every layer discovery tag
and the system discovery tag. An existing different manifest digest refuses
the entire publication; an identical digest permits an idempotent retry.
Lookup/authentication failures also refuse publication rather than treating
the package as absent. Consumers should continue pinning digests.

The first release must confirm GHCR's response for a not-yet-existing package
using the intended publishing credentials (404 versus 401/403), before attempting
the release. Only 404 is treated as absent;
401/403 and every other lookup error fail closed before any upload.
If GHCR masks absence as an authorization failure, resolve the registry setup
and rerun; do not bypass the preflight or reinterpret that failure as absence.
This live first-release confirmation is still required; loopback tests cannot
establish GHCR's behavior for a new package.
