# Native DIAG tape launcher

Self-contained adapter over the existing MIT `open-diag-go/pkg/lsd` API;
no ABAP or generated-code dependency and no new protocol implementation.
`-diag` / `OSD_OSGO_DIAG=1` enables the tape dynpro, `STG_DIAG_PORT`
then `DIAG_PORT` overrides the default `32${INSTANCE}` (`00` by default).
Binding uses the host's `OSD_BIND` / `-addr`, loopback IPv4+IPv6 by default.
One fan-in listener calls Serve once because lsd writes package-global renderer
configuration. Call once at startup; no runtime reconfiguration is supported.

The existing library renders the tape shell, keepalives, repeat screens, exit
and a twelve-second hold. Its embedded scrubbed shell differs from JS's shell;
it is not byte parity. It accepts malformed hellos which JS rejects, allows
64 MiB NI frames rather than JS's 1 MiB, lacks JS's idle/connection caps, and
uses its embedded LSD identity rather than the configured OSG SID. No claim
of strict JS conformance or stock GUI acceptance for this integration is made.

Validation: `go test -race ./diagnative`, `go vet ./diagnative`.
