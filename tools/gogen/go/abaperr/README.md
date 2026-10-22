# abaperr

Leaf error types recovered by the dispatcher and generated code.
`HostError` reports a host contract failure; `ArithmeticError` models an ABAP exception.
`NotCompiled` builds an arithmetic error for an unsupported operation.
This package has no imports and go/abap aliases both types for identity.

`ArithmeticError.Detail` is optional host diagnostic context. `Error()` and
`abap.Exception.Text()`/`TextOf()` exclude it so ABAP `get_text` and semantic
comparisons retain their text. Uncaught-exception reporters, including bridge
`main` functions such as step4b, should use `abap.DumpText(recovered)` to append
` [detail]`; it also handles caught/rethrown and materialised kernel exceptions.
