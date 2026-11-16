# tools/osd-hana — `osd hana doctor`

First piece of the "rescue your own ABAP code out of a HANA database whose
ABAP server is gone or expiring" product line. This module locates, verifies,
runs and explains the Go sidecar **`osd-hana-dump`** (owned by the sibling
`vsp` project; the contract between the two is frozen: see `W0-contract.md`
in the task tree — the tracked facts are restated here). `osd hana extract`
is the next job and does not exist yet.

Nothing in this module opens a listening socket, and no statement that is not
a SELECT is sent — with exactly one exception: `--create-reader` /
`--drop-reader` talk to the database through the Node driver `hdb` directly,
because the sidecar is read-only by construction and cannot create a user.

## Files

| file | what it is |
|---|---|
| `osd-hana.mjs` | the `osd hana <verb>` entry; `bin/osd.mjs` dispatches mode `hana` here |
| `doctor.mjs` | the `doctor` verb: sidecar lifecycle + probe + verdict, exit codes |
| `sidecar.mjs` | locate / verify (SHA-256 pin) / handshake / run the sidecar |
| `sidecar.lock.json` | the pin: version, commit, SHA-256 per target (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64) |
| `connect.mjs` | connection input: `--host --port --database --user`, `--env-file`, `--password-stdin`, hidden TTY prompt. **No `--password` flag, ever** (argv is visible to every user of the machine). The password channels, in order: `--password-stdin` > `HANA_PASSWORD` in the env file > `$OSD_HANA_PASSWORD` > the hidden prompt (TTY only); a run with none of them is a refusal that names all four |
| `verdict.mjs` | the plain-language verdict and the `--json` document, from one source so they cannot disagree |
| `reader.mjs` | the dedicated read-only user: `--create-reader` / `--drop-reader` (the only non-SELECT statements in the module, sent over `hdb`, never the sidecar) |
| `secret-store.mjs` | where the reader's credentials live: a `get/set/delete` interface; the CLI default is a file under the user's config directory, `0600` in a `0700` directory, enforced with fchmod even when it already existed. The extension will inject VS Code SecretStorage behind the same interface |
| `redact.mjs` | the redactor: every byte of child stderr AND stdout passes through it before it is printed or embedded (password, user, host masked; secrets shorter than 3 characters are ignored) |
| `defaults.mjs` | the courtesy check: SHA-256 hashes of the public default passwords of HANA trial images; warn loudly, change nothing |

## How the doctor runs the sidecar

1. **Locate** — `OSD_HANA_DUMP` (explicit path) wins, then the path the caller
   handed in (the extension passes its bundled binary), then a clear error
   that says how to get the binary. There is no download.
2. **Verify** — before the first use in a process, SHA-256 of the file against
   `sidecar.lock.json` for this target. A mismatch is refused and names both
   hashes. An explicit path that is not in the pin is refused unless
   `--allow-unpinned-sidecar` is given, and is then announced loudly. A
   target the pin does not cover (e.g. win32-arm64) is refused under its own
   name, never silently mapped to another target. A `--sidecar-pin` naming a
   file other than the module's own `sidecar.lock.json` counts as **unpinned
   for every claim**: it can check bytes, but it never produces a `pinned:
   true` — the embedding host substitutes its pin through a trusted caller
   seam, not through the CLI flag.
3. **Handshake** — `--version --json` must say `schema: 1`, `read_only: true`
   and carry the capabilities the verb needs (`probe` for the doctor); a
   pinned binary must also state the pinned version and commit. Otherwise the
   doctor refuses and names what is missing.
4. **Run** — credentials reach the child only through its environment
   (`OSD_HANA_USER`, `OSD_HANA_PASSWORD`) — never argv, never a temp file.
   The child gets a **minimal environment**: an allowlist (`PATH`,
   `HOME`/`USERPROFILE`, `TMPDIR`/`TEMP`/`TMP`, `SystemRoot`, `LANG`/`LC_*`)
   plus the two credential variables — never the parent's whole environment.
   The sidecar README names no proxy or SSL variables, so none are
   forwarded. `spawn` with an argument array, no shell, a timeout that kills
   the child, and a cap (8 MB) on the output the doctor accumulates.
   Whenever a pin is in play, **every spawn re-verifies the bytes first**
   (a fresh, uncached hash — the binary is ~7 MB, so milliseconds): no gap
   between the verified bytes and the executed bytes. stderr passes through
   the redactor; stdout is redacted before its one JSON line is parsed —
   exactly one line, or a refusal, never a guess. Exit codes 0–5 map to the
   contract's named outcomes: `0 done, 1 usage, 2 connection, 3 partial,
   4 refused, 5 unsupported`.

The doctor's own exit codes: **0** ready to extract, **1** usage or setup
(flag errors, sidecar not found / refused, consent declined), **2** cannot
connect or log on, **5** no ABAP schema found.

## The verdict

Said so a person who has never seen HANA can act on it: reachable? tenant or
system database? ABAP schema found? release, clients, repository size; is an
ABAP server still attached (informational); what kind of login this is
(schema owner / administrator / other) and whether it can do more than read.
`--json` prints the same findings as one JSON document (never the password).

The doctor never refuses a login because it is powerful: every session the
sidecar opens is read-only at the database level, so extraction is safe with
any login. That sentence is said exactly once, when the login can write — and
with an unpinned binary (`--allow-unpinned-sidecar`) it is qualified instead:
"this binary's read-only claim is its own; it was not checksum-verified", in
the plain text and in `--json`. If the password equals a public default of a
trial image, the doctor warns loudly (hashes in `defaults.mjs`, a courtesy
check, one place) and changes nothing.

## The dedicated reader

`osd hana doctor --create-reader` (`--drop-reader` to undo):

- shows the exact SQL (password masked) and asks for consent; `--yes` for
  non-interactive use. The consent screen and the wire are ONE source: the
  statements executed are the statements shown, with the mask replaced by the
  generated password at execution time only;
- the reader name must be **ours**: `--reader-name` must match
  `^OSD_[A-Z0-9_]{1,26}$` (default `OSD_READER`), for create and drop alike —
  the name is sent UNQUOTED (anything else would be an injection, not a
  name), and a name that is not ours must never reach `DROP USER` at all;
- the schema name is checked **before any consent text is built**: a name
  carrying C0/C1 control characters (ESC, CR, LF, TAB, DEL, the C1 range) is
  refused outright — a name that can rewrite the terminal must not get onto
  the consent screen. The conservative set a real ABAP schema name draws from
  is upper-case letters, digits, `_` and `/` at most; printable-but-unusual
  names are kept working through the identifier quoting, and every name a
  message prints goes through one `show()` that escapes non-printables;
- **before CREATE USER** the catalogue is asked whether the name exists: a
  user that already exists — ours from an earlier run and maybe in use, or
  somebody else's — is never CREATEd over and never dropped. The refusal says
  so and points at `--reader-name` (a different name) or `--drop-reader`;
- any **failure of CREATE USER itself** — 258 (no USER ADMIN), 331 (the name
  existed after all), 412 (the database's password policy rejects the
  generated password; the generator uses letters and digits only), a network
  error, anything — sends **no DROP**: this run created nothing, so it removes
  nothing. Only failures **after** a successful CREATE drop the half-set-up
  reader again and say what happened;
- the tenant database reaches **every** connection of the path
  (administrator, reader proof, drop) — one place builds the driver's options;
- SQL shape as measured (E1 report): the user name is sent **unquoted** and
  validated (see above); the schema name is **quoted as an identifier** with
  embedded `"` doubled; in catalogue comparisons it is a **bound parameter**,
  never concatenated;
- the reader's password is CSPRNG-generated (28 characters, upper + lower +
  digit, letters and digits only, so nothing needs escaping on the wire) and
  is never printed, logged or put on argv — **including the `--json`
  document**, which reports `{user, schema, stored_at}` only. The secret
  store is the password's only resting place;
- the statements: `CREATE USER <name> PASSWORD <pw> NO FORCE_FIRST_PASSWORD_CHANGE`,
  `ALTER USER <name> DISABLE PASSWORD LIFETIME`,
  `GRANT SELECT ON SCHEMA "<schema>" TO <name>`, then a real connection as
  the reader proving one SELECT;
- the connection is **encrypted only when asked**: `--encrypt` (TLS with
  certificate validation, hdb's `useTLS`) or `--trust-server-certificate`
  (TLS without validation, announced loudly in the consent text). Without
  `--encrypt` the consent text says plainly that the connection is not
  encrypted and the new password travels in clear — use a trusted network;
- error 258 on CREATE USER = this login may not create users → the two ways
  on (a login with USER ADMIN, or go on read-only with the present login);
  error 258 on GRANT = this login may not grant the schema → the schema's
  owner is named as the login that can; a 332 after a failed create means
  "user absent", never the cause;
- every driver error text passes a redactor holding this run's passwords —
  an error message never repeats a password verbatim;
- the administrator's password is used for these statements only and is never
  stored;
- the reader's credentials go to the secret store under a key of **host,
  port, database and name**, with the connection facts, the creation time and
  the **system identity** (`SYSTEM_ID` + `DATABASE_NAME` from
  `SYS.M_DATABASE`) in the entry. The file backend writes atomically (temp
  file + rename in the `0700` directory) and refuses a symlinked store. The
  extension injects VS Code SecretStorage behind the same `get/set/delete`
  interface.

`--drop-reader` drops **only a reader this tool created**, and proves it
before anything is sent:

- the name must match `^OSD_[A-Z0-9_]{1,26}$` and must not be the login the
  run is connected as (the current login is necessarily in `SYS.USERS` —
  dropping it would drop the administrator itself);
- the secret store must hold an entry for exactly this host + port + database
  + name. Otherwise the tool refuses — it never drops a user it does not own
  — and prints the one statement an administrator can run by hand
  (`DROP USER <name> CASCADE`). There is no force flag, by decision;
- **proof of ownership, then consent**: the stored password must log on AS
  THE READER to this exact host/port/database — success proves the user is
  the one this store created; and when the entry carries one, the recorded
  system identity must match `SYS.M_DATABASE` now (an address is not an
  identity: every HXE container is `localhost:39017/HXE`, and a tunnel puts
  any system behind `localhost:<port>`). A failed proof refuses, prints the
  one hand-run SQL line, and **keeps the secret**;
- then `DROP USER <name> CASCADE` with the administrator login, the
  `SYS.USERS` absence proof, and the stored secret is removed. A 332 means
  "already absent": still proved, still removed, said so.

Windows notes: `chmod` has no effect there; the secret file inherits the
profile's ACLs, and `fchmod` is skipped rather than pretending. A sidecar
path with no extension resolves to the existing `<path>.exe` (the real name
of the binary; `spawn` would need it). A target the pin does not cover
(e.g. win32-arm64) is refused under its own name — never collapsed into
win32-x64.

## Filling the pin

`sidecar.lock.json` is filled from the build's `SHA256SUMS` plus
`--version --json` of the built binary (its `os_arch` maps to the pin's
target names). Bump it whenever the sidecar ships a new version — the doctor
refuses a binary whose hash or self-description does not match.

## Tests

`test/osd-hana-doctor.mjs` (sidecar handling, verdicts, connection input) and
`test/osd-hana-reader.mjs` (the dedicated reader, the secret store), with a
FAKE sidecar (`test/osd-hana/fake-sidecar.mjs`, a shebang script the tests
point `OSD_HANA_DUMP` at, verified against a generated pin through the
trusted `pinFile` seam) and a FAKE `hdb` client
(`test/osd-hana/fake-client.mjs`) injected through the reader's
`clientFactory` seam. No network, no database.
