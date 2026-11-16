# Recorded contracts of the sidecar (`osd-hana-dump`)

These files are what the REAL binary printed, not what somebody thought it would print.
The tests' fake sidecar serves these documents (and variants that change VALUES only);
it may not invent a field -- `test/osd-hana-contract.mjs` fails when it does.

- Recorded with: `osd-hana-dump v2.62.0` (commit `a0177d8649cc0eb490a29cc8730adf5fbdfa3361`),
  the binary `tools/osd-hana/sidecar.lock.json` pins, against a HANA database that holds an
  ABAP schema, on 2026-11-16.
- Every identifier was replaced by a synthetic one (host, port, login, schema, clients,
  correlation id; row counts rounded). Field names, nesting, value types and the exit
  codes are untouched.
- A NEWER PIN REQUIRES RE-RECORDING: run the four commands below with the new binary,
  replace the identifiers, and update `fields.json` from the sidecar's README and
  `probe.go` at the new tag.

| file | command | exit |
|---|---|---|
| `version.json` | `--version --json` | 0 |
| `probe-ok.json` | `probe --host H --port P --database D` (a login that may only read) | 0 |
| `probe-auth-failed.json` | the same with a wrong password | 2 |
| `probe-connect-refused.json` | `probe` against a port nobody listens on | 2 |

Each file is `{"exit": <code>, "document": <the one JSON line of stdout>}`.

`fields.json` lists every key a probe document may carry. Keys marked `"recorded"`
appear in a recording above. Keys marked `"source"` were NOT produced by a recording
(they need a login that owns the schema, an administrator, the system database, or a
database without an ABAP schema); they are taken from the sidecar's own `probe.go` and
README at the pinned tag. Keys marked `"announced"` are promised for a later version
and exist in no released binary this module pins. The document a database without a
readable ABAP schema gets (`probe-no-schema`, exit 5: `ok` false, `abap_schemas` null,
no `error`) is likewise read off the source, not recorded.
