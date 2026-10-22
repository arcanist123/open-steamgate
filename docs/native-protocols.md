# Optional native osgo protocol listeners

Build osgo with `node tools/gogen/osgo.mjs` using the usual heavy wrapper.
Run the resulting binary with `-adt -rfc -diag`. The listeners themselves
need no Node/Bun process. A Node-free CHECKRUN additionally requires the
existing Go checker linkage described in `tools/step3/README.md`; a plain
build still defaults CHECKRUN to its existing Node compiler.

| Switch | Environment | Port |
|---|---|---|
| `-rfc` (requires `-adt`) | `OSD_OSGO_RFC=1`, `OSD_OSGO_ADT=1` | `STG_RFC_PORT`, default `33${INSTANCE}` |
| `-diag` | `OSD_OSGO_DIAG=1` | `STG_DIAG_PORT`, then `DIAG_PORT`, default `32${INSTANCE}` |

`INSTANCE` defaults to `00` and must be two decimal digits. Ports accept zero
for test allocation. Both protocols use osgo's `-addr` / `OSD_BIND` policy:
IPv4 and IPv6 loopback by default, explicit configuration to widen.
The private RFC HTTP backend remains IPv4 loopback even with a public bind.

## RFC seam and licensing

`rfcnative` mounts `github.com/oisee/open-rfc-go/pkg/adtbridge`, pinned at
`61d450713a040bc0afc39c4994be6bbfcba5bd79`
(`v0.2.1-0.20261022173244-61d450713a04`). Backend exposes only TLS transport
configuration, not a custom RoundTripper. The adapter therefore starts a
private ephemeral loopback HTTP server with osgo's own handler. The dependency
owns each conversation's cookie jar and CSRF fetch/retry. The HTTP seam supplies
`X-SAP-ADT-SessionType: stateful` when absent, including for CSRF probes, as JS
does. It does not change the global HTTP transport.

No RFC dependency source was copied into OSG or relabelled MIT. Root `NOTICE`
retains oisee and Marian Zeis/open-rfc attribution and links the dependency's
provenance mapping. `LICENSES/Apache-2.0.txt` carries its actual license text.
The existing Docker inventory is for JS source/npm distributions; it does not
ship osgo. A native binary distribution must include these notices/licenses.

The function profile is JS's `SADT_REST_RFC_ENDPOINT`,
`RFC_GET_FUNCTION_INTERFACE`, `DDIF_FIELDINFO_GET`, plus Go's
`RFC_GET_STRUCTURE_DEFINITION`. No generic RFC/FM runtime is advertised.

This integration is opt-in. `STG_RFC_AUTH_MODE` selects `demo` (default) or
`static`, exactly as the JS server's environment entrypoint. Static requires
`STG_RFC_USER` and `STG_RFC_PASSWORD`; optional `STG_RFC_CLIENT` restricts logons
to that client. `STG_ADT_USER/PASSWORD/CLIENT/LANGUAGE` independently configure
the HTTP backend identity; an orphan backend password is rejected. Unsupported
modes and incomplete identities fail synchronously through upstream `Check`
in `FromEnv`, and again in `Start` before opening listeners. Static logon
reassembly uses upstream's default `MaxLogonBytes` of 64 KiB. An external
`STG_ADT_BACKEND` is not selected by osgo.

Differences from JS, including limitations of the pinned API:

- RFC demo logons are accepted without decoding/validating the supplied caller
  identity. Static mode decodes and validates the caller user/password/client,
  but neither mode propagates caller identity as the HTTP repository owner.
- No shared lock-handle adoption between RFC connections or backend logoff on
  disconnect. Cookies remain per conversation.
- Since open-rfc-go#10 (`c620e342`) the bridge confines every request and
  redirect to the backend origin and base path, rejects absolute and
  authority-relative URIs before applying credentials, ignores caller
  Authorization/Cookie/Host headers, and adopts a rotated CSRF token from
  successful responses.
- RFC resource policy also differs: native backend requests time out at 30 s
  versus JS's 120 s; native has no JS-style 64-connection cap or socket idle
  timeout. The 30 passing assertions cover a narrower contract than complete
  replacement parity.
- Metadata is not identical. The public `open-rfc-go/rfc` client cannot perform
  the recursive ADT request against either bridge at these pins. The probe
  reports JS's APPC response-pending error and native's unimplemented classic
  nested `v` layout. The independent capture-free wire probe succeeds; it is
  not evidence that the public client succeeded.

## DIAG reuse

`diagnative` mounts the MIT `open-diag-go/pkg/lsd` service at
`b9a0b534ec1b4597cb00d17e064ff2580ba97eac`
(`v0.0.0-20261022180029-b9a0b534ec1b`), with `Stub: "tape"`. It can render
the tape/shell; no new DIAG stack was built. One fan-in listener feeds both address families to a single
`lsd.Serve`, avoiding concurrent initialization of its global renderer state.

The existing fragmented hello/NI ping, tape text, repeated screen and `/i`
end-of-session assertions pass against it. `lsd.Options.SID` receives the host's
selected SID: `OSD_SID`, then `STG_ADT_SID`, default `OSD`. Both hosts trim ASCII
blanks, uppercase it, and reject anything other than three ASCII letters/digits
starting with a letter. The dependency now rejects malformed hellos.

Since open-diag-go #4 the limits match JS: NI payload 1 MiB, 64 sockets,
30 s initial and later idle timeout, and after EOP the write side is
half-closed while reading continues until the peer closes. The twelve second hold and exit commands are already implemented by
the dependency. Its scrubbed shell is not asserted byte-identical to JS's.
There was no new field audit or stock SAP GUI acceptance run.

## Reproduce the evidence

Build helpers from `tools/gogen/go`:

```sh
go build -o ../.out/native-protocol-test-host ./rfcnative/testdata/host
go build -o ../.out/native-rfc-client ./rfcnative/testdata/client
```

From the repository root, use `OSD_HEAVY_RANGE=90-99 tools/osd-heavy.sh` before
these Node/mocha commands:

```sh
node_modules/.bin/mocha test/protocol-{ni,sap-compress,rfc,diag}.mjs
node --import ./tools/protocols/native-test-loader.mjs \
  node_modules/mocha/bin/mocha.js --timeout 5000 --exit \
  test/protocol-{ni,sap-compress,rfc,diag}.mjs
OSD_PROTOCOL_TEST_AUTH_MODE=demo node \
  --import ./tools/protocols/native-test-loader.mjs \
  node_modules/mocha/bin/mocha.js --timeout 5000 --exit \
  test/protocol-rfc.mjs --grep 'forwards two calls'
node tools/protocols/native-parity-session.mjs
```

The opt-in loader substitutes listener construction only; codec assertions
still exercise JS codecs and are not counted as native codec coverage. Test
RFC handlers reverse-proxy to the existing suite's mock backend; the real
session probe uses osgo's actual native ADT handler. It takes turns with JS
and native RFC on the same allocated 33nn, keeps each pair of calls on one
conversation, and compares HTTP status and decoded body bytes, not volatile
HTTP headers or raw RFC envelopes. Local details go to
`.local/native-protocols/session.json`; no wire captures are committed.

The JS baseline and native replay both pass **30/30** at these pins. Native
replay covers static wrong-password rejection without backend requests,
synchronous invalid-auth setup, cookie/CSRF forwarding and rotation, configured
DIAG SID and junk-hello rejection. The adapter translates actual native error
logs to the JS factory logging callbacks and runs the production Go config
validator synchronously in a helper subprocess; no assertions are weakened.
The adapter ignores custom DIAG screen/hold options, which are JS test factory
options not exposed by osgo; the wire assertions remain unchanged.

Validate packages with `gofmt`, `go vet`, and `go test -race` for `rfcnative`,
`diagnative` and `cmd/osgo`. A host generated with Go checker linkage also needs
its temporary module replacement (`withGoLintModule` in
`tools/gogen/lint-engine.mjs`) for vet and tests.

## Measured validation on feat/osgo-protocols-parity

The real wire session receives 200 for discovery and CHECKRUN with equal body
bytes through JS and native 33nn. CHECKRUN is `processed` and reports the
intentional missing implementation of `broken`, rather than `notProcessed`.
Both osgo processes run with an empty executable PATH. The test driver and JS
bridge still use Node; the native osgo listeners and CHECKRUN do not.
Measured on 2026-10-22 over instance 90 (`3390`):

| Request | JS / native status | JS / native body bytes | Comparison |
|---|---|---|---|
| Discovery | 200 / 200 | 14442 / 14442 | identical |
| CHECKRUN | 200 / 200 | 580 / 580 | identical, processed |

Discovery SHA-256: `a7d085bf0b6782e64440613e40cc84591b08781b67fd04714027d7051b5b8a2d`.
CHECKRUN SHA-256: `10b2eefc89f3e350c9c6e8ff1b387dabde22bfcbf2d710bde56d99f4c2495828`.
The two existing HTTP ADT conformance cases pass against osgo separately (2/2).
The public Go RFC client probe exits 1 for both bridges; therefore the complete
session script deliberately exits 1 even when its wire comparison succeeds.

Both adapter packages and the two test helper packages pass vet and race
checks (helper packages have no unit tests). Full generated `cmd/osgo` vet is
not green: the default race-test invocation stops on a generated redundant
`lv_len > 0 && lv_len > 0`, and full vet also reports generated unreachable
code. Those failures are retained. A separately labelled
`go test -race -vet=off ./cmd/osgo` passes; it exercises host tests but does not
replace the failed vet result. No CI workflow or required check is disabled.

Size budgets are exact physical production lines: rfcnative 130, diagnative
117. Command glue has an explicitly reasoned package budget; main.go remains
at the existing 800-line file ceiling. The size checker and leak scanner pass.
