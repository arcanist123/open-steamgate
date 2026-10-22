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

`FromEnv` takes an `os.LookupEnv`-style lookup. `STG_RFC_AUTH_MODE` supports
demo (only when absent) and static; a present empty value is rejected before
listening. An empty `STG_RFC_PORT` selects port 0, while an absent port uses
the instance default. A present empty `INSTANCE` cannot derive a port.
Static requires
`STG_RFC_USER` and `STG_RFC_PASSWORD`; `STG_RFC_CLIENT` optionally restricts
the caller's client. These are separate from `STG_ADT_USER/PASSWORD/CLIENT/LANGUAGE`.
`FromEnv` and `Start` call upstream `Check` synchronously before opening listeners.
Static logon decoding retains upstream's default 64 KiB limit.

The dependency also registers RFC_GET_STRUCTURE_DEFINITION in addition to JS's
three FMs. Cross-connection lock-handle adoption and backend logoff on disconnect
are not provided by this pinned API. Caller identity is not propagated as the
HTTP repository owner. This remains an opt-in compatibility path.

Validation: `go test -race ./rfcnative`, `go vet ./rfcnative`.

Detailed parity and remaining differences: [native protocols](../../../../docs/native-protocols.md).
The pinned dependency confines backend origins/headers and retains rotated CSRF
tokens. The local HTTP seam supplies stateful sessions.

`STG_HOST_NAME` defaults only when absent; an empty value is preserved in
the backend options. The pinned upstream logon identity still substitutes
`osd-bridge` for an empty host on the wire.
