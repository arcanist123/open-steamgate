# lintinput

Resolves Node layer/config facts and captures ordered filesystem inputs for
`storelint.Compiler`. It imports no generated code and can be tested without
building osgo or linking either checker. `New` wires capture into an injected
engine; `Resolve` runs the structural Node resolver, never a checker.

Config/pack hashing and competing membership detection live here. Ordinary
saved byte edits retain the resolved decisions and use the incremental bridge.
The command owns flags, engine selection and generated factory wiring only.

Run `go test -race ./lintinput` from `tools/gogen/go`.

Library namespaces are walked once per normal capture using directory entries,
without reading source bytes again or statting ordinary files. A namespace
change invokes Node's canonical glob/exclusion resolution and re-primes.
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
See objstore's README for identity, timestamp-window and platform fallbacks.
`BenchmarkFreshness3000` compares full reads and cached capture on a 3,000-file,
13.2 MB synthetic tree (300 project and 2,700 library files). It measures one
snapshot, the compiler CHECKRUN path, and the store CHECKRUN path including the
index build and final target/revision guards. The engine is a no-op to isolate
host freshness cost; these are not HTTP or real lint engine latency figures.

```sh
go test ./lintinput -run '^$' -bench BenchmarkFreshness3000 -benchmem -benchtime=1s -count=3
```
