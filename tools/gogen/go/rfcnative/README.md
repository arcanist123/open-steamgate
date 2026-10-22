# Native RFC launcher

Standalone host adapter; imports no ABAP/generated code. `FromEnv` selects
`-rfc` / `OSD_OSGO_RFC=1`, `STG_RFC_PORT` (default `33${INSTANCE}`, instance
`00` by default), and the existing STG_ADT credential/client/language settings.
The host requires `-adt` as well. `OSD_BIND` / `-addr` select the public bind;
loopback IPv4 and IPv6 are the default. The backend always uses a separate
private IPv4 loopback listener against the host's own HTTP handler. The pinned
Backend API cannot accept an in-process RoundTripper. No external backend is
selected and no default HTTP transport is replaced.

The Apache-2.0 dependency owns RFC, NI, metadata, conversation cookie jars and
CSRF retry. OSG copies none of that source. See root NOTICE.

Only demo mode is supported: non-demo modes fail before opening listeners.
Unlike JS demo, this dependency does not validate/decode the RFC caller identity
or propagate it as the HTTP repository owner. Its configured backend identity
is used in logon replies. It also registers RFC_GET_STRUCTURE_DEFINITION in
addition to JS's three FMs. Cross-connection lock-handle adoption and backend
logoff on disconnect are not provided by this pinned API. This is an opt-in
compatibility path, not full JS security/session parity.

Validation: `go test -race ./rfcnative`, `go vet ./rfcnative`.

Detailed parity and URI/header admission gaps: [native protocols](../../../../docs/native-protocols.md).
Successful-response CSRF token rotation differs from JS; stale-token retry
is retained by the dependency. The local HTTP seam supplies stateful sessions.
