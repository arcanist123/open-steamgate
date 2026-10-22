# storelint

`Compiler` implements `storecheck.Compiler` for ADT CHECKRUN using an injected
ABAP or Go `Engine`. The linked Go library also handles ordinary CHECK and
OUTLINE natively; engines without those callbacks delegate to `Other`.
`NewGoEngine` adapts the optional generated library's host-facing `GoLibrary`.
The typed generated host bridge converts external types, so this package has
no dependency on the generated abaplint module or the ABAP runtime.

`Prime` initializes the persistent registry before readiness. One mutex
serializes saved-file diffs and overlay install/check/restore. Structural
layer/config changes re-prime; changed source bytes update incrementally.
The ABAP bridge owns private Session/Statics; the Go library owns its Checker
and serializes generated globals. Callbacks must not acquire the HTTP
work-process lock or start a dialog step.

Input guards must match before and after each check. Missing/failed prime,
unsupported sources and trapped failures become `notProcessed`. A failed
check can recover after successful restoration; failed prime/update/restore
poisons the host compiler. Opted-in CHECKRUN never falls back to the sidecar.
`MapIssues` preserves order, duplicates and coordinates, uses severity E and
mirrors Node's URI rules. Origin logs and work counters name the selected
engine; neither engine identity nor an empty report substitutes for parity
and performance gates. See [the build and gate guide](../../../step3/README.md).

The saved store fast path changes target enumeration only. `syncSaved` still
validates all checker inputs before selection, and `unchanged` captures them
again after the engine returns. Membership identities retained by lintinput
never replace these observations. This package keeps its ordered competing-file
comparison, structural winner selection, root/type/include refusals and source
install/restore lifecycle. The outer objstore boundary still verifies the saved
target's expected hashes, revision and live-generation link before answering.

Native CHECK shares the same mutex and saved snapshot synchronization, uses
CheckObject (INCL -> PROG), and retains Node's scalar and severity contracts.
CDS diagnostics come from cdscheck over the pinned original-parser extractor.
Native OUTLINE reuses the saved Tree only when every ABAP filename and byte
matches the complete host-resolved object, including local/test includes and
competing directories. Different or missing active-version files use an isolated
checker. adtoutline builds either document with the same projection. Both paths
verify containment/expected hashes and full saved inputs before returning.
Failed isolated parses leave saved state untouched; a failed saved Tree parse
re-primes the saved baseline before refusing, poisoning only if restoration fails.
The outer store still rejects concurrent revision, live-link and file changes.
