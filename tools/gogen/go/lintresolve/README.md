# lintresolve

Native checker file-membership resolution for a fixed compiled generation.
Node discovers and validates config, libraries, roots, selected packs and
prepared source layers at build time. It embeds versioned Rules alongside the
initial Facts. Each compiler owns these immutable rules; no global root registry
or disk policy sidecar is required.

Resolve refreshes library glob selection, library grouping, whole-object hidden
winners, ordered checker paths and pack candidate types. Patterns default to
/src/**; only library excludes ignore case, and library testclasses are always
excluded. Hidden competition excludes DEVC and web trace sidecars. Arrays retain
order and duplicates; file suffix admission is case-sensitive. Effective config
JSON remains the exact build-time string, including pinned producer defaults.
The Facts JSON projection preserves absent root metadata versus empty arrays.

Structural changes refuse with `rebuild`: raw config/lock/manifest edits or
removals, pack discovery changes (including unselected packs), tracked layer
environment changes, installed identities, abapGit/package metadata, prepared
archive identities, inferred root-package changes (including unnamed DEVC headers),
pack validation folder kinds, ZIP overlay seed/link requirements, and $TMP
topology changes. Native validation also preserves shadow-scan refusals.
Candidate directory changes are
within scope and reselect pack roots at their original insertion slots.
Ordinary source and library directories may add/remove files without rebuild.
Prepared ZIP seed topology stays fixed; changing it requires rebuilding.
The complete read/guard inventory is [INPUTS.md](INPUTS.md).

No subprocess, network, fetch, extraction, config normalization or publication
runs here. ZIP layers must already be prepared at build time; runtime never
materializes an archive. lintinput retains strict captures, before/after guards,
namespace detection, retry behavior and checker lifecycle. Its exclusion callback
applies these same JS-compatible rules to capture, including installed logical
paths. This does not alter the object store's built/active generation proofs.

Regex sources use a deliberately restricted ASCII JS/RE2 subset; --validate
actually compiles every exclusion in Go during the build. Lookaround,
backreferences, Unicode/property escapes, whitespace classes, embedded flags and
POSIX classes refuse with rebuild. Dot line endings, UTF-16 units and legacy
case folding are adapted and compared to the real JS engine in tests. Globs
implement the build's literal pattern plus * and ** grammar, not filepath.Match.

The package depends on objstore data/capture helpers and x/text Unicode casing,
never generated ABAP or checker code. cmd/lintresolve is a build/test driver:
Rules JSON on stdin, ordered Facts on stdout, or --capture for ordered filename
and raw SHA256 pairs. Run go test -race ./lintresolve ./lintinput ./objstore from
tools/gogen/go, and node --test tools/gogen/lint-resolve.test.mjs from the repo.
The oracle uses disposable snapshots, including a whole-checkout copy. Windows
path and filesystem behavior has not been measured by the Linux oracle.
