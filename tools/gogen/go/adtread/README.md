# Read-only ADT host routes on OSGo

`adtread` serves the read-only ADT routes that the shared ABAP front hands to
its host with an `x-osd-served-by: HOST` verdict, the way `tools/adt-facade.mjs`
serves them on Node. Today that is one route:

- `GET /sap/bc/adt/activation/inactiveobjects`: the `ioc:inactiveObjects` feed
  of `objstore.Inactive()` (what was saved or created and not activated since),
  the document of `inactiveObjectsDocument` in `tools/adt-documents.mjs`, with
  the Basic logon user as `ioc:user`.

`cmd/osgo` calls `Serve` after `adtwrite` declines, inside the same dialog step.
The package has no ABAP-generated types and no dependency on `go/abap`.
Run `go test ./adtread` and `go vet ./adtread` from the Go module.
