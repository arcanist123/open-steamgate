# ADT source writes on OSGo

`adtwrite` is the host continuation for the shared ABAP ADT front. It owns
PUT source/main, class include saves/creation, and POST/DELETE for classes,
interfaces and programs. It has no ABAP-generated types and uses `objstore`
for file mutations. The host calls it only for a HOST verdict, after ABAP's
session, CSRF and XML checks, inside the same serialized dialog step.

`Session.Holds` checks both the persistent ABAP handle row and the actual ENQ
holder, including session liveness. DELETE releases the handle and ENQ lock.
Every supported mutation requires a handle except collection CREATE. Interface
and program DELETE also require a handle (stricter than the JS host).

Creation uses an existing writable package folder and abapGit metadata; it
refuses duplicates and unsafe paths. A class starts with a readable active
skeleton. PUT changes the inactive working source, preserving the built active
snapshot. Conditional first saves of absent definitions, macros and implementations
compare against the same CRLF templates served by the shared ABAP GET. DELETE
invalidates all active proofs for the deleted object while retaining immutable
build files, so a recreated class cannot inherit its predecessor's includes.
Programs allow up to 40 characters in the name segment; classes and interfaces
retain their 30-character limit. New class active skeletons are retained for the
process lifetime;
a restart requires rebuilding to retain their active version. Source files and
metadata remain on disk. No executable generation is activated by these writes.
Activation (`go/adtactivate`) and ABAP Unit (`go/adtunit`) are separate HOST continuations; see
docs/osgo-adt-activation.md.

Run `go test ./adtwrite ./objstore` and `go vet ./adtwrite ./objstore` from
the Go module. The HTTP W1-W5 cases exercise the generated host integration;
package tests cover includes, lock ownership, ETags, refusal paths and cleanup.
