# lintinput

Resolves Node layer/config facts and captures ordered filesystem inputs for
`storelint.Compiler`. It imports no generated code and can be tested without
building osgo or linking either checker. `New` wires capture into an injected
engine; `Resolve` runs the structural Node resolver, never a checker.

Config/pack hashing and competing membership detection live here. Ordinary
saved byte edits retain the resolved decisions and use the incremental bridge.
The command owns flags, engine selection and generated factory wiring only.

Run `go test -race ./lintinput` from `tools/gogen/go`.
