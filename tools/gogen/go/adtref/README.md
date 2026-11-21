# adtref -- ADT object references

What: the URI of a repository object and the object of a URI
(`/sap/bc/adt/oo/classes/zcl_x` <-> CLAS ZCL_X) for the source types the Go ADT
host serves (CLAS, INTF, PROG, INCL, DDLS, SRVD), the elements of a request
body with their namespaced attributes, and the objects an activation body names.
It is the Go side of `uriOf`, `objectFromUri` and `objectReferencesIn` in
`tools/adt-documents.mjs`, and its `exceptionDocument`. `go/adtactivate` and `go/adtunit` use it.

No ABAP-generated types and no store: pure functions over strings and bytes.
Run `go test ./adtref` and `go vet ./adtref` from the Go module.
