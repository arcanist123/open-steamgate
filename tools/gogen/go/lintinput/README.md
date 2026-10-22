# lintinput

Resolves fixed-generation native layer/file facts and captures ordered filesystem inputs for
`storelint.Compiler`. It imports no generated code and can be tested without
building osgo or linking either checker. `New` wires capture into an injected
engine; the optional `Resolve` test seam replaces the per-instance native resolver,
never a checker. Build-time rules are described in [lintresolve](../lintresolve/README.md).

Config/pack hashing and competing membership detection live here. Changes to
fixed policy return `notProcessed` with `rebuild`; file-selection and candidate
type changes resolve natively. The effective checker config stays build-time exact.
Ordinary
saved byte edits retain the resolved decisions and use the incremental bridge.
The command owns flags, engine selection and generated factory wiring only.

Run `go test -race ./lintinput` from `tools/gogen/go`.

Library namespaces are walked once per normal capture using directory entries,
without reading source bytes again or statting ordinary files. A namespace
change invokes the native embedded glob/exclusion rules and re-primes.
Changes outside the original globs may cause one conservative resolution but
cannot add those files to the checker. Configured library folders are watched
including empty/missing ones; startup resolves once to refresh embedded lists.
Directory symlinks explicitly refuse capture because WalkDir cannot monitor
changes beneath them; use physical library roots. File symlinks are supported.

Both freshness snapshots include the namespace fingerprint. A membership
change during checking refuses the result and the next request re-primes.
`BenchmarkLibrarySnapshot3000` compares snapshots with/without detection and
measures detection separately on 3,000 files in 30 subdirectories:

```sh
go test ./lintinput -run '^$' -bench BenchmarkLibrarySnapshot3000 -benchmem -benchtime=2s -count=3
```

Each `New` compiler now owns an `objstore.LintCache`. Ordinary captures continue
all structural guards, namespace walks, hidden-file hashing and layer checks;
only stable file content reads/hashes are reused. Both before/after snapshots
use this path, and the after-check pass still reads changed or racy files.
Reuse requires Linux `statfs` to identify ext2/3/4, XFS, Btrfs, tmpfs, ZFS or
F2FS. The decision is memoized per directory and followed-file device for one
capture only; probing the file follows symlinks into other mounts. NFS,
CIFS/SMB, 9p, FUSE, unknown types, probe failures and other platforms always
read. Overlayfs always reads because its type does not establish the coherence
of the backing layers. See objstore's README for identity and window details.

Both generated in-process adapters (ABAP/TS-HA and Go library) use `New`.
Production settings are read once when `New` creates the compiler:

- `OSD_LINT_STAT_CACHE=auto|off` (default `auto`): auto permits reuse only on
  allowlisted filesystems; off unconditionally opens/reads all inputs.
- `OSD_LINT_STAT_CACHE_WINDOW=5s`, for example: a Go duration of at least `2s`
  sets the timestamp window (default `2s`). A longer window handles coarser
  timestamps but never bypasses the filesystem allowlist.

Invalid values log a warning and select full reads. Restart the host after
changing settings. Full reads preserve open/read validation; they do not add
coherence to a filesystem configured with incoherent data caching.
`BenchmarkFreshness3000` compares full reads and cached capture on a 3,000-file,
13.2 MB synthetic tree (300 project and 2,700 library files). It measures one
snapshot, the compiler CHECKRUN path, and the store CHECKRUN path including the
index build and final target/revision guards. The engine is a no-op to isolate
host freshness cost; these are not HTTP or real lint engine latency figures.

```sh
go test ./lintinput -run '^$' -bench BenchmarkFreshness3000 -benchmem -benchtime=1s -count=3
```

Saved CHECKRUN retains a physical membership set, canonical object identities,
per-object directory counts and hidden identities across successful snapshots.
The delta compares names without reclassifying survivors; additions use the
shared `storelint.ObjectIdentity` decoder. New cross-directory competitors,
hidden winner changes, and removal/rename of a competing file force canonical
resolution. Ordinary additions/includes/removals remain incremental. Content
hashes do not key this state. Resolution replaces the retained layer facts;
failed captures never advance membership. Ordered competing membership remains
checked separately by storelint before updating its engine registry.

`BenchmarkMembershipDelta3000` compares rebuilding these facts with retaining
and advancing them across captures. `BenchmarkFreshness3000` measures the whole
saved store CHECKRUN (both captures and final guards) on the same 3,000-file tree.
