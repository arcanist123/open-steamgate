# lintresolve driver

Build/test CLI for the self-contained lintresolve package. Reads embedded Rules
JSON from stdin. `lintresolve ROOT` emits exact ordered Facts; `--validate`
compiles supported exclusions in Go RE2, failing the build on incompatibility.
No Node execution occurs in this command. The serving runtime calls the package.
