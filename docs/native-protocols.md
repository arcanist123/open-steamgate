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
`c620e342404d0ea23f6da9b63bfbe97cc7c6e258`
(`v0.2.1-0.20261022165448-c620e342404d`). Backend exposes only TLS transport
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

This integration is opt-in and supports `STG_RFC_AUTH_MODE=demo` only (also the
default). Every other mode fails before protocol listeners are opened.
`STG_ADT_USER/PASSWORD/CLIENT/LANGUAGE` configure backend identity; an orphan
password is rejected. An external `STG_ADT_BACKEND` is not selected by osgo.

Differences from JS, including limitations of the pinned API:

- RFC demo logons are accepted without decoding/validating the supplied caller
  identity; it is not propagated as the repository owner. Configured backend
  identity is used in the logon response. Static RFC authentication is absent.
- No shared lock-handle adoption between RFC connections or backend logoff on
  disconnect. Cookies remain per conversation.
- Since open-rfc-go#10 (`c620e342`) the bridge confines every request and
  redirect to the backend origin and base path, rejects absolute and
  authority-relative URIs before applying credentials, ignores caller
  Authorization/Cookie/Host headers, and adopts a rotated CSRF token from
  successful responses.
- Metadata is not identical. The public `open-rfc-go/rfc` client cannot perform
  the recursive ADT request against either bridge at these pins. The probe
  reports JS's APPC response-pending error and native's unimplemented classic
  nested `v` layout. The independent capture-free wire probe succeeds; it is
  not evidence that the public client succeeded.

## DIAG reuse

`diagnative` mounts the already pinned MIT `open-diag-go/pkg/lsd` service at
`62029ee085bc`, with `Stub: "tape"`. It can render the tape/shell; no new DIAG
stack was built. One fan-in listener feeds both address families to a single
`lsd.Serve`, avoiding concurrent initialization of its global renderer state.

The existing fragmented hello/NI ping, tape text, repeated screen and `/i`
end-of-session assertions pass against it. Differences remain: its embedded
shell names `LSD` rather than OSG's selected SID; malformed hellos receive a
screen; NI limit is 64 MiB versus JS's 1 MiB; it lacks JS's connection cap and
initial idle timeout; it waits briefly after EOP before closing. The twelve
second hold and exit commands are already implemented by the dependency.
The dependency owns the scrubbed shell; there was no new field audit or stock
SAP GUI acceptance run for this integration.

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

The baseline is 30 passing tests. Native replay gives 25 passing / 5 failing:
startup error API timing/text, the two static-auth scenarios, DIAG SID, and
junk-hello rejection. In demo mode the RFC cookie/CSRF scenario reaches the
backend and fails on the retained rotated token. Required failures are retained
and no existing suite is removed/skipped or made green by weakened assertions.
The adapter ignores custom DIAG screen/hold options, which are JS test factory
options not exposed by osgo; the wire assertions remain unchanged.

Validate packages with `gofmt`, `go vet`, and `go test -race` for `rfcnative`,
`diagnative` and `cmd/osgo`. A host generated with Go checker linkage also needs
its temporary module replacement (`withGoLintModule` in
`tools/gogen/lint-engine.mjs`) for vet and tests.

## Measured validation on 63acb9c9 plus this branch

The real wire session receives 200 for discovery and CHECKRUN with equal body
bytes through JS and native 33nn. CHECKRUN is `processed` and reports the
intentional missing implementation of `broken`, rather than `notProcessed`.
Both osgo processes run with an empty executable PATH. The test driver and JS
bridge still use Node; the native osgo listeners and CHECKRUN do not.
The two existing HTTP ADT conformance cases run against osgo separately.
The public Go RFC client probe exits 1 for both bridges; therefore the complete
session script deliberately exits 1 even when its wire comparison succeeds.

Both new production packages and the two test helper packages pass vet and race
checks (helper packages have no unit tests). Full generated `cmd/osgo` vet is
not green: the default race-test invocation stops on a generated redundant
`lv_len > 0 && lv_len > 0`, and full vet also reports generated unreachable
code. Those failures are retained. A separately labelled
`go test -race -vet=off ./cmd/osgo` passes; it exercises host tests but does not
replace the failed vet result. No CI workflow or required check is disabled.

Size budgets are exact physical production lines: rfcnative 106, diagnative
111. Command glue has an explicitly reasoned package budget; main.go remains
at the existing 800-line file ceiling. The size checker and leak scanner pass.
