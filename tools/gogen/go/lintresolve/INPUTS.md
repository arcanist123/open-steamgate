# Native resolver input sweep — PR #838 critic rounds 1–2

Audited `lintBuildSpec` through `packAt`/`packsOf`, `rootsOf`, `libraryFiles`,
`rootPackage`/`userLayersOf`, `layers`/`filesIn`, installed-system and abapGit
helpers. Scope is checker facts and refusal outcomes for a fixed compiled
policy. Paths below are project-relative unless an explicit external layer or
pack place is configured. Stat follows links except strict ZIP overlay checks.

| Producer / input read | Native treatment |
| --- | --- |
| `abap_transpile.json` existence and raw bytes: input order, exclusions, library folders/globs/excludes | SHA256 guard; embedded plan, patterns and exclusions. Config changes require rebuild. |
| `abaplint.jsonc` raw bytes; pinned publication validator and abaplint defaults | File SHA256 guarded; exact effective config JSON embedded. Package code/defaults are compiled policy, not runtime files. |
| `libs.lock.json` bytes (environment library names; locked pack source repo/ref validation) | SHA256 guarded, including validation of unselected packs at build time. |
| `OSD_PACKS`, `OSD_WEB_PACKS`, `OSD_TMP`, `OSD_LAYERS`, `OSD_LAYER_PACKAGE`, `OSD_LAYER_DISCOVERY_ONLY`, every `OSD_LIB_*` including newly introduced keys | Exact environment map guarded, distinguishing unset and empty. No other environment setting is read by these discovery functions. |
| `.local/system/.osd-system.json` existence/bytes; each installed `.osd-layer.json` identity/order | SHA256 guarded. Installed physical/logical mappings and layer order embedded. |
| Every installed layer's `.abapgit.xml` existence/bytes and derived starting folder | SHA256 guarded; paths embedded. Input/source membership recomputed by native walks. |
| Pack places: directory stat, own-manifest existence, otherwise sorted immediate child names and child-manifest existence | `Manifests` recomputes discovery before/after resolution and on capture guards. Manifest inventory and SHA256 compared, including unselected packs. Missing/non-directory places use the same discovery rule. |
| Every discovered `osd-pack.json` raw bytes: names/order/selection, path declarations, source/ref/OCI, BSP/intents/resourceRoots/tiles shape validation | All discovered manifests guarded, including unselected packs. Validation is build-time fixed policy. `parseRef` and shape validators read no extra files or environment. |
| Every pack ABAP candidate's stat (default `src`, `.`, or each declared path; missing/directory/other) | Recomputed in `Resolve` and `lintinput.packSources`; mutable and reselects roots in original slots. Exact relative candidate keys preserved (`""` for project root); root descriptors separately use `"."`. |
| Every declared fetched source directory stat and `.osd-source.json` bytes (including unselected packs) | Directory kind in `states`, identity existence/bytes in SHA256 guards; require rebuild on drift. This is independent of whether it is also an ABAP candidate. |
| Pack `data`, `ddic`, `webapp`: stat of enabled declared/default folders, including absent or non-directory values | `packAt.directoryRequirements` records every evaluated path beside its stat; producer embeds kinds in `states`. Content under these folders is not pack validation input. Default DDIC paths for every possible ABAP candidate plus the no-ABAP fallback are guarded, so native candidate reselection cannot introduce an unguarded directory probe. |
| Every declared BSP folder stat; existence/type required even for unselected packs | Same `directoryRequirements` and `states`, with `rebuild` on removal/replacement before engine entry. Path containment and app validation depend only on guarded manifest bytes. BSP asset bytes are not read by `packAt`. |
| `local/tmp` existence/type (`inputFoldersOf`, `withTmp`, installed-system refusal) | `states` guards missing/directory/other; fixed root plan preserves TMP placement and filtering. |
| Every listed/root `.abapgit.xml` existence/bytes; abapGit layout tags | SHA256 guarded; descriptor and safe starting-folder resolution embedded. |
| Root `package.devc.xml` raw bytes, other immediate lowercase `*.devc.xml` names and bytes | Metadata inventory and SHA256 guards. Addition/removal/rename/content drift requires rebuild. |
| Root filename-prefix inference over immediate `clas/intf/prog` ABAP/XML names (including unnamed `package.devc.xml`) | `rootPackageInfo` records the actual inference branch. Native guard recomputes prefix result, permitting same-prefix changes and refusing changed inference/fallback. Inference uses names, not file contents or stat types. |
| Plain `OSD_LAYERS` input existence/type, source-folder existence; optional `.abapgit.xml` bytes | Config/metadata bytes guarded; native root walks recheck directory reads/stats. Missing plain roots can acquire mutable source membership; invalid file roots refuse during native traversal. |
| ZIP archive bytes; materialized `.osd-source-id`, repository `.abapgit.xml`, overlay `<id>.meta.txt` | SHA256 guarded. No extraction runs natively. Materialized source membership is walked natively. Archive extraction, chmod and cache creation are build-time operations. |
| ZIP source recursive Dirent directory traversal and DEVC/class/interface names; corresponding overlay target existence and strict `writable()` link checks | `ZipLayers` embeds source/overlay pairs. Native topology walk uses Dirent directory semantics and rechecks every target and every ancestor with Lstat. Missing seeded target or redirected path requires rebuild, before any checker call. Existing overlay bytes remain mutable and captured. |
| ZIP overlay `.osd-overlay.txt` target path, ancestors; containment/realpath boundary | Native strict ancestor Lstat checks refuse links, including a linked overlay directory; relative targets are compiled from validated paths within root. No link-free descendant can escape the overlay realpath. |
| `local/overlays/.osd-mounts.txt` existence/bytes used only to suppress redundant reconciliation writes | Build-time output reconciliation, not a checker input: existing bytes never choose roots, packages, membership or refusal policy. Native runtime performs no reconciliation writes. |
| Library directory existence, recursive sorted entries, per-entry directory stat; `.git`, `node_modules`, `output` skips | Recomputed by native library walk and lifecycle namespace detection. Missing library roots remain mutable. Same follow-link and directory-read behavior as producer; selected file bytes captured natively. |
| Library physical/logical path, glob selection, case-insensitive excludes, testclass suffix and installed metadata-name skips | Recomputed natively from guarded compiled patterns/mappings; ordered grouping and duplicates retained. |
| `layers.filesIn`: ordered roots, recursive sorted entries and per-entry stat; DEVC/web-sidecar exclusion, object identity, later-root wins | Recomputed by native hidden walk, JS-compatible ordering/case/percent decoding. Duplicate lists are computed by Node but not used by `lintBuildSpec`; checker facts preserve duplicates identically. |
| `layers` shadow scan: `local` existence, sorted children, non-input child stat, recursive directory entries/stats | Recomputed by native topology validation using the currently selected roots from the same root-plan helper as `Resolve`, including lifecycle guards. Former pack roots become shadows immediately after candidate reselection. Shadow report values are unused checker outputs, but read/stat failures must still refuse. |
| Ordered selected source/library file bytes (`walkStoreFiles` and capture) | Native store traversal and strict captured bytes/SHA256. Before/after structural guards and existing retry lifecycle remain in force. |

No pack-validation file input remains outside the manifest, lock and source
identity guards. Optional folder projections do not read their contents. Pack
markers (`.osd-fetched.json`) are not read by `packAt`; `markerOf` is a separate
fetch API. Seeds, static pages and BSP assets are not checker inputs unless an
ABAP/library root also selects them by its existing suffix rules.

`storeConfig` also computes built/active publication proofs, and ObjectStore
initialization may load inactive-version records. `lintBuildSpec` deliberately
discards those outputs; they do not supply the checker roots/config/hidden/files
projection. Publication proof refresh is outside this resolver's contract.

Sweep additions: native refusal checks for shadow traversal failures and ZIP
overlay links/missing seeded members. Covered by the Node oracle and ZIP
startup/live CHECKRUN regression. Critic cases cover unnamed DEVC inference,
BSP removal/file replacement, and exact root-pack keys through fallback changes.

Round-2 audit of every `Rules` consumer in `lintresolve`: `Roots` was the only
stale selection used as a current decision (shadow exclusions). Its remaining
use is the legacy no-plan fallback; producer rules always carry a root plan.
Plan slots, pack candidates/defaults/packages and explicit overrides are policy
from guarded config/manifests/environment. Candidate types and metadata
precedence are recomputed by the shared `currentRoots` helper. Library
folders/globs/exclusions and physical/logical mappings depend on guarded
config, environment and installed identities; library membership/groups are
recomputed. Hidden winners and checker files use the resolved roots/libraries.
Metadata/inference directories and ZIP source/overlay pairs describe fixed
listed/user layers and guarded installed paths; their file inventories,
inference, seed targets and link topology are rechecked. Pack optional-folder
states cover every candidate, independent of the selected root. No additional
concrete stale-selection defect was found. The committed round-2 oracle fixture
covers a selected `local/extra` replaced by a dangling link; its lifecycle
regression covers both mutation before startup and after a healthy CHECKRUN.
