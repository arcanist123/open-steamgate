# lintresolve

Native file-membership resolver for a fixed compiled generation. Node performs
root/config/pack discovery at build time and embeds versioned Rules. Resolve
refreshes library glob selection, library grouping, whole-object hidden winners,
ordered checker paths and pack candidate types. It neither spawns processes nor
fetches, extracts archives, publishes generations or parses mutable config.

Structural guards refuse with `rebuild`. lintinput owns lifecycle/freshness and
binds rules per compiler. The optional cmd/lintresolve build/test driver reads
Rules on stdin and emits the Node Facts projection on stdout. --validate checks
the supported JS/RE2 exclusion subset; unsupported regexes fail the build.

This package imports objstore data types only, never generated ABAP or checker
code. Run go test -race ./lintresolve ./lintinput from tools/gogen/go.
