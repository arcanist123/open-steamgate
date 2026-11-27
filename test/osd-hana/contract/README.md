# Recorded contracts of the sidecar (`osd-hana-dump`)

These files are what the REAL binary printed, not what somebody thought it would print.
The tests' fake sidecar serves these documents (and variants that change VALUES only);
it may not invent a field -- `test/osd-hana-contract.mjs` fails when it does.

- Recorded with: `osd-hana-dump v2.62.1` (commit `c10a25cae70a032b87daa7c96906d0ecd6b588a5`),
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

`dump-part-w3mi-only.json` is one part (`part-NNNNN/`) of a real chunked `dump`
(v2.62.1, 2026-11-18) whose 500-name chunk held only W3MI objects: `files` (the
part's directory listing -- no `tables/`, `src/` or `catalog/`), `reposrc_bytes`
(the empty `reposrc.jsonl`), the part's `manifest.json` and one `objects.jsonl`
row. Object names, connection, schema and author are synthetic; keys, nesting,
value types and the zero counts are as recorded. The fake's W3MI-only part is
held to it (`test/osd-hana-contract.mjs`).

`fields.json` lists every key a probe document may carry. Keys marked `"recorded"`
appear in a recording above. Keys marked `"source"` were NOT produced by a recording
(they need a login that owns the schema, an administrator, the system database, or a
database without an ABAP schema); they are taken from the sidecar's own `probe.go` and
README at the pinned tag. Keys marked `"announced"` are promised for a later version
and exist in no released binary this module pins. The document a database without a
readable ABAP schema gets (`probe-no-schema`, exit 5: `ok` false, `abap_schemas` null,
no `error`) is likewise read off the source, not recorded.

## Derived from source

The `derived-probe-*.json` files are NOT recordings. Each one is a recording above (named in
its `derived_from`) with VALUES changed and `notes` added exactly as the sidecar's
`cmd/osd-hana-dump/probe.go` at the pinned tag writes them -- derived from source, for the
cases no recording login produced. They share the recordings' shape (`{"exit", "derived_from",
"document"}`) and carry no key `fields.json` does not list.

What `probe.go` does when a value is not readable: it leaves the value at its zero (`0`,
`false`, an omitted list) and appends a note -- so a `0` or a `false` beside such a note is
NOT a finding. The notes, verbatim (`<schema>` is the schema's name):

| note | what it makes unknown |
|---|---|
| `system privileges not readable` | whether the login is an administrator (`admin_privileges`, and so `login_class` "admin") |
| `<schema>: privileges not readable` | that schema's `non_select_on_schema` / `non_select_kinds` |
| `<schema>: REPOSRC not readable` | that schema's `reposrc_rows` |
| `<schema>: TADIR not readable` | that schema's `tadir_rows` |

`connected to SYSTEMDB: connect to the tenant (its own port, or --database)` is the one other
note `probe.go` writes; it marks nothing unknown. `tools/osd-hana/probe-doc.mjs` reads the four
notes above; any note it does not recognise is printed verbatim under the verdict.

| file | derived from | changed |
|---|---|---|
| `derived-probe-counts-unreadable.json` | `probe-ok` | both counts 0, the REPOSRC and TADIR notes |
| `derived-probe-privileges-unreadable.json` | `probe-ok` | the schema privileges note |
| `derived-probe-system-privileges-unreadable.json` | `probe-ok` | the system privileges note |
| `derived-probe-owner-system-privileges-unreadable.json` | `probe-ok` | the login owns the schema (kind OWNER), the system privileges note |
