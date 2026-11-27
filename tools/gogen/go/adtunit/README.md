# adtunit -- ABAP Unit runs for the Go ADT host

What: `POST /sap/bc/adt/abapunit/testruns` and `.../testruns/evaluation`,
the HOST continuation osgo uses to run the test classes compiled into its
binary (docs/osgo-adt-activation.md). It parses the run configuration
(one object reference, the optional `#testclass=..;testmethod=..` selector,
`withNavigationUri`). It runs the selected local test classes through
an `Executor` and answers with the class-protocol `aunit:runResult` of
`tools/adt-unit-result.mjs`. `testdata/node-demo-run.xml` is the Node host's
answer for the `$ZOSD_TEST` fixture. The test compares the Go document with
it byte for byte, except for the execution times.

The host supplies:

- `Owners`: the test classes by owner, generated into `cmd/osgo/zz_unit.go`
  by `tools/gogen/osgo-adt-unit.mjs`. Each has its methods and lines, and
  closures for class setup and teardown and for a new instance.
- `Executor`: `Begin` isolates one test class (osgo: a fresh `abap.Session`
  that owns a copy of the seed database, `Session.OpenUnitDB`). `Catch` turns a panic
  into an `Alert`: failedAssertion, exception or shortDump, with ABAP stack
  frames.
- `Live`: whether the class is still the source the binary was built from.
  A changed class is refused with 409 ("rebuild osgo"). `HasTests` tells
  a class without tests (an empty result) from one whose tests were not
  compiled in (409).

The order of a run is ABAP Unit's: class_setup, then for each method a new
instance with setup, the method and teardown, then class_teardown. Methods
are reported sorted by name. The package has no ABAP-generated types and no
dependency on `go/abap`. Run `go test ./adtunit` and `go vet ./adtunit`.
