# castdiag

Host-only cast diagnostics, independent of the ABAP runtime.
`Context` captures source/target Go types and the caller of the rejecting binding;
call it only inside a failed cast branch. Successful casts do no diagnostic work.
`DumpText` unwraps `DiagnosticCause() (prefix string, cause any)` carriers and
appends `DiagnosticDetail() string` context. `WithDetail` supports reporters
with an existing wire text shape. Neither seam changes Error/get_text, attributes,
serialization or reference comparison. This package never imports go/abap.
