# adtactivate -- ADT activation on a host that cannot build

What: `POST /sap/bc/adt/activation` for the Go ADT host, as a HOST
continuation of the shared ABAP front (`cmd/osgo/adt_session.go`). osgo has no
transpiler, so activation means a syntax check followed by publishing in the
object store (docs/osgo-adt-activation.md, option a):

- no `method` is the exact A4H 400. A method other than `activate` is an
  empty 200. A body without object references is a 400.
- `If-Match` with one object compares the saved source's entity tag (412 on a
  mismatch), as the Node host does.
- each object is checked with CHECKRUN over its saved source. An error
  cancels the activation with the Node failure document (`activationExecuted="false"`,
  "Activation was cancelled", one located `msg type="E"` per issue). A
  check that cannot run refuses the activation. `forced` skips the check.
- a clean set is published with `objstore.ActivateAll`, all or nothing: if any
  object cannot be published, the whole activation is cancelled and nothing changes. That is the active
  version in the store, and the objects leave the inactive list. An object
  that is still the bytes the binary was built from gets the Node success
  document byte for byte. A changed one gets `generationExecuted="false"`,
  a `type="W"` message that says a rebuild is needed to run it, and
  `X-OSD-Build: published; rebuild osgo to run it`.

`Store` is injectable (`Default` is objstore's). The package has no
ABAP-generated types and no dependency on `go/abap`. Run `go test ./adtactivate`
and `go vet ./adtactivate` from the Go module.
