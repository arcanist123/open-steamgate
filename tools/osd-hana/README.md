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
| `sidecar.lock.json` | the pin: version, commit, SHA-256 per target (linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64), the capabilities, and the public release URL + asset name per target |
| `fetch-sidecar.mjs` | the BUILD-time fetcher: downloads the pinned release asset per target, verifies SHA-256 against the pin, writes it atomically. Never reached from the `osd hana` verbs |
| `connect.mjs` | connection input: `--host --port --database --user`, `--env-file`, `--password-stdin`, hidden TTY prompt. **No `--password` flag, ever** (argv is visible to every user of the machine). The password channels, in order: `--password-stdin` > `HANA_PASSWORD` in the env file > `$OSD_HANA_PASSWORD` > the hidden prompt (TTY only); a run with none of them is a refusal that names all four |
| `probe-doc.mjs` | reads the sidecar's `probe` document, in ONE place, by the real binary's field names (`abap_schemas[].schema`, per-schema `non_select_on_schema` / `abap_attached`, `login_class`, `admin_privileges`, `notes`); records what the document did not report, and turns the sidecar's "... not readable" notes into UNKNOWN (never a 0 or a "can only read"); other notes are printed verbatim |
| `verdict.mjs` | the plain-language verdict and the `--json` document, from one source so they cannot disagree |
| `reader.mjs` | the dedicated read-only user: `--create-reader` / `--drop-reader` (the only non-SELECT statements in the module, sent over `hdb`, never the sidecar) |
| `secret-store.mjs` | where the reader's credentials live: a `get/set/delete` interface; the CLI default is a file under the user's config directory, `0600` in a `0700` directory, enforced with fchmod even when it already existed. The extension will inject VS Code SecretStorage behind the same interface |
| `redact.mjs` | the redactor: child stderr passes through it; stdout is parsed raw and only what is printed or embedded is masked (`redactValues`: string values only, never keys or numbers; password, user, host masked; secrets shorter than 3 characters are ignored) |
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
   the redactor; stdout's one JSON line is parsed raw — exactly one line,
   or a refusal, never a guess — and redacted only where it is printed or
   embedded (string values; a numeric password such as `123` never touches
   a row count). Numbers are never masked and a string value equal to
   (or containing) a credential is, so every decision reads the raw
   document and a quoted line is redacted before it is truncated. Exit codes 0–5 map to the
   contract's named outcomes: `0 done, 1 usage, 2 connection, 3 partial,
   4 refused, 5 unsupported`.

The doctor's own exit codes: **0** ready to extract, **1** usage or setup
(flag errors, sidecar not found / refused, consent declined), **2** cannot
connect or log on, **5** no ABAP schema readable by this login, or the
sidecar could not examine the database (the message says which).

### TLS

The sidecar advertises the `tls` capability in its handshake (W0-contract
"Additions"; the current pin `0d5767b` does not have it — the code is written
against the capability and tested both ways with the fake). TLS is **one
consistent set of flags for both transports** — the sidecar's connection and
the reader path's hdb connection:

- `--ca-file` / `--tls-server-name` **need `--encrypt`**: without it they are
  a usage error, refused before anything connects — TLS-shaped flags on one
  transport while the other carries the new password in clear is not a thing
  this tool does. `--trust-server-certificate` alone stays valid (it IS an
  encryption request, just without validation);
- with `--encrypt`, the CA file's content reaches **hdb too** (hdb's
  documented `ca` option, passed to `tls.connect`; `--tls-server-name`
  becomes hdb's `servername`) — a private CA verifies on both paths;
- when you ask for TLS and the pinned sidecar lacks the capability, the
  doctor **refuses** — it never falls back to clear text. Note this refuses
  the WHOLE run, including `--create-reader` / `--drop-reader`, although hdb
  could encrypt its own connection: fail-closed until the pin moves;
- with the capability, the flags are passed to the sidecar as well: the
  probe (and the reader probe) ride the sidecar's own session, not hdb's.

The verdict says the probe's `tls` value, one plain sentence each:
**verified** ("the server's certificate was verified"), **unverified**
("encrypted, but the server is not authenticated"), **off** ("the connection
is NOT encrypted"). The measured trial-image failure — a verified TLS
connection to an **IP address** is refused with "certificate doesn't contain
any IP SANs" (the self-signed certificate is issued for a host name, not an
IP) — gets its own explanation on both paths: connect by the host NAME the
certificate was issued for, or pass `--ca-file` with the server's PEM, or
`--trust-server-certificate` on a network you trust.

## The verdict

Said so a person who has never seen HANA can act on it: reachable? tenant or
system database? ABAP schema found? release, clients, repository size; is an
ABAP server still attached (informational); what kind of login this is
(schema owner / administrator / other) and whether it can do more than read.
`--json` prints the same findings as one JSON document (never the password):
`probe` is the sidecar's document as it came, `verdict` is what the doctor read
from it, and `verdict.missing` names what the sidecar did not report.

Four rules about the probe document (`probe-doc.mjs`):

- **A value the sidecar could not read is unknown, not zero.** The sidecar
  leaves it at `0` / `false` and adds a note (`<schema>: REPOSRC not
  readable`, `<schema>: TADIR not readable`, `<schema>: privileges not
  readable`, `system privileges not readable`). The doctor then says "not
  readable with this login" for a count, "could not determine whether this
  login can write" instead of "can only read", and the `--create-reader` flow
  asks whether the login is an administrator instead of assuming
  (`verdict.unknown` in `--json`). A note it does not recognise is printed
  verbatim under the verdict.

- **A missing field is said, not guessed.** When the document lacks something
  the verdict needs, the doctor prints "NOT REPORTED by the sidecar: ..." and
  assumes nothing — it never renders an absent field as "none", "no" or "can
  only read".
- **"No ABAP schema" is claimed only when the document positively says so**:
  the sidecar exits 5 with its probe document and `abap_schemas: null` ("no
  ABAP schema readable by this login" — a login without `SELECT` on the schema
  sees none, so the doctor names the schema owner or an administrator as the
  way on). Exit 5 with the sidecar's error line instead means it could not
  examine the database at all; the doctor says exactly that, and that it is
  not a finding. An answer with no `abap_schemas` key at all is a disagreement
  between the binary and this module: exit 1, said as such.
- **Several ABAP schemas** in one database are all listed (each with its own
  "attached" line); `--create-reader` then needs `--schema`. With `--schema`
  the sidecar looks only at that one. Exit 5 therefore means "no ABAP schema
  readable by this login, or the sidecar could not examine the database".

The doctor never refuses a login because it is powerful: every session the
sidecar opens is read-only at the database level, so extraction is safe with
any login. That sentence is said exactly once, when the login can write — and
with an unpinned binary (`--allow-unpinned-sidecar`) it is qualified instead:
"this binary's read-only claim is its own; it was not checksum-verified", in
the plain text and in `--json`. If the password equals a public default of a
trial image, the doctor warns loudly (hashes in `defaults.mjs`, a courtesy
check, one place) and changes nothing.

## The dedicated reader

`osd hana doctor --create-reader` (`--drop-reader` to undo).

### Which login do I need?

The doctor reads the probe's login class and asks only for what is missing:

| the present login is… | what happens |
|---|---|
| **the administrator** (USER ADMIN, not the schema owner — the measured case) | it runs `CREATE USER`, `ALTER USER ... DISABLE PASSWORD LIFETIME` and `GRANT CATALOG READ`; the doctor then asks for the **schema owner's** login — the catalogue's owner name is shown as the suggestion — with the password from `$OSD_HANA_OWNER_PASSWORD` or a hidden prompt. Non-interactive use: `--owner-user` + `$OSD_HANA_OWNER_PASSWORD`. There is deliberately **no** `--owner-password-stdin` |
| **the schema owner** | it runs `GRANT SELECT ON SCHEMA`; the doctor asks for an **administrator** login the same way: `--admin-user` + `$OSD_HANA_ADMIN_PASSWORD` (or a hidden prompt) |

On a **real terminal** the doctor really asks, with the production wiring (no
injected prompt): it asks only when **stdin AND stderr are a terminal**, with
two separate prompts — a **visible** line question for a login NAME (the
answer echoes; the catalogue's suggestion is the default when you just press
Enter) and the **hidden** prompt for a PASSWORD (raw mode, nothing echoed).
Without a terminal the refusal text names the flag and the environment
variable, and nothing is sent.
| **both** (one login that can do both — it exists on some systems) | one step, one consent, one connection |
| **neither** | the doctor explains what the two logins must do and **sends nothing** |

On the measured systems **no single login does the whole flow**: the
administrator's `GRANT SELECT ON SCHEMA` fails with 258, and the schema owner
cannot create users. The consent screen shows **all statements of both
logins**, grouped by who runs each, before anything is sent — and the
executed statements are exactly the printed ones (one statement source in
`reader.mjs`, the password mask applied at print time only). Under "run as
the new reader, changes nothing" it also lists the reader's own proof
statements (one SELECT and the no-row UPDATE probe) and the `DROP USER` that
undoes a failed run. Neither extra password is stored: each is used for its
statements and dropped.

`--no-catalog-read` leaves `GRANT CATALOG READ` out; the doctor then says
that database procedures (AMDP) cannot be extracted with this reader (the
dump reports an empty catalog, exit 3).

### What the flow does

- shows the exact SQL (password masked) and asks for consent; `--yes` for
  non-interactive use. The consent screen and the wire are ONE source: the
  statements executed are the statements shown, with the mask replaced by the
  generated password at execution time only;
- the statements, per role: the **administrator** runs
  `CREATE USER <name> PASSWORD <pw> NO FORCE_FIRST_PASSWORD_CHANGE`,
  `ALTER USER <name> DISABLE PASSWORD LIFETIME` and
  `GRANT CATALOG READ TO <name>` (needed for dumping database procedures —
  without it the procedure definitions come back empty); the **schema owner**
  runs `GRANT SELECT ON SCHEMA "<schema>" TO <name>`;
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
  nothing. Any failure **after** a successful CREATE drops the half-set-up
  reader again — **by the administrator connection, the only one that can** —
  and the message names **which login failed at which statement**: the
  owner's refused `GRANT` (258), a wrong owner password, a failed owner logon,
  all end with "the reader was dropped again; nothing was left behind";
- the tenant database reaches **every** connection of the path
  (administrator, second login, reader proof, drop) — one place builds the
  driver's options;
- SQL shape as measured (E1 report): the user name is sent **unquoted** and
  validated (see above); the schema name is **quoted as an identifier** with
  embedded `"` doubled; in catalogue comparisons it is a **bound parameter**,
  never concatenated;
- the reader's password is CSPRNG-generated (28 characters, upper + lower +
  digit, letters and digits only, so nothing needs escaping on the wire) and
  is never printed, logged or put on argv — **including the `--json`
  document**, which reports `{user, schema, stored_at}` only. The secret
  store is the password's only resting place;
- after the grants, the reader is **proved twice**: a real connection as the
  reader reading `"<schema>"."TADIR"`, and the write probe
  `UPDATE "<schema>"."TADIR" SET "PGMID" = "PGMID" WHERE 1 = 0`, which the
  database **must refuse** (measured: 258; the statement changes nothing even
  if wrongly allowed). **Only HANA error 258 proves the refusal** (critic
  M-1): if the probe is not refused, the reader is dropped and the run fails
  loudly — "the reader can write"; if the probe answers any OTHER error (a
  syntax error, anything) or the connection is lost, that proves NOTHING —
  the reader is dropped, no secret is stored, and the run fails loudly
  saying which of the three outcomes it was;
- then the doctor runs the sidecar's `probe` **as the reader** and shows its
  verdict — the reader sees the database like the measured reader: class
  "other", no write on the schema, a dump identical to the owner's. In
  `--json` the reader's probe document comes as `reader_probe`;
- the connection is **encrypted only when asked**: `--encrypt` (TLS with
  certificate validation, hdb's `useTLS`; `--ca-file` / `--tls-server-name`
  reach hdb as `ca` / `servername` — see "TLS" above for the one-set rule) or
  `--trust-server-certificate` (TLS without validation, announced loudly in
  the consent text). Without `--encrypt` the consent text says plainly that
  the connection is not encrypted and the new password travels in clear — use
  a trusted network;
- error 258 on CREATE USER = this login may not create users → the two ways
  on (a login with USER ADMIN, or go on read-only with the present login);
  error 258 on `GRANT SELECT` in the one-login case = this login may not
  grant the schema → the schema's owner is named as the login that can; a
  332 after a failed create means "user absent", never the cause;
- every driver error text passes a redactor holding ALL of this run's
  passwords (the generated one, the present login's, the second login's) —
  an error message never repeats a password verbatim;
- the present login's password is used for its statements only and is never
  stored, and so is the second login's;
- the reader's credentials go to the secret store under a key of **host,
  port, database and name**, with the connection facts, the creation time,
  whether `CATALOG READ` was granted, and the **system identity**
  (`SYSTEM_ID` + `DATABASE_NAME` from `SYS.M_DATABASE`) in the entry. The
  file backend writes atomically (temp file with `wx`, then rename **over**
  the destination — the destination is never deleted first, so a crash can
  lose the new entry, never every stored reader) and refuses a symlinked
  store. The extension injects VS Code SecretStorage behind the same
  `get/set/delete` interface.

`--drop-reader` drops **only a reader this tool created**, and proves it
before anything is sent. It is **not gated behind a successful probe**: it
runs before the probe entirely, so a removed ABAP schema (probe exit 5) or a
broken main login does not block a teardown:

- the name must match `^OSD_[A-Z0-9_]{1,26}$` and must not be the login the
  run is connected as (the current login is necessarily in `SYS.USERS` —
  dropping it would drop the administrator itself);
- the secret store must hold an entry for exactly this host + port + database
  + name. Otherwise the tool refuses — it never drops a user it does not own
  — and prints the one statement an administrator can run by hand
  (`DROP USER <name> CASCADE`). There is no force flag, by decision;
- **proof of ownership, then consent**: the stored password must log on AS
  THE READER to this exact host/port/database, and the recorded system
  identity must match `SYS.M_DATABASE` now (an address is not an identity:
  every HXE container is `localhost:39017/HXE`, and a tunnel puts any system
  behind `localhost:<port>`). A stored entry **without** a system identity —
  written before identities were recorded — is **refused** with the hand-run
  line: the reader logon alone proves the password works on whatever now
  answers, not that it is the same system. A failed proof refuses, prints
  the one hand-run SQL line, and **keeps the secret**;
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

## Fetching the sidecar (BUILD time)

The pin's `release` block names the public release URL and the asset name
per target. `tools/osd-hana/fetch-sidecar.mjs` turns that into the binary a
host bundles:

    node tools/osd-hana/fetch-sidecar.mjs --target linux-x64 --out <dir>
    node tools/osd-hana/fetch-sidecar.mjs --all --out <dir>

It writes `<dir>/<target>/osd-hana-dump[.exe]`, mode 0755, atomically (temp
file + rename). The rules it holds:

- **verify against the pin, not against a downloaded checksum file** — the
  pin is what this repo stands behind; a mismatch deletes the temp file,
  exits non-zero and names both hashes;
- **no host but the pin's release URL and GitHub's asset hosts** — every
  hop (the first request and each redirect, followed manually) is checked
  against that list before it is taken; `http://` is refused except on the
  loopback, which exists for the tests;
- **a cached hit makes no request** — a file already on disk with the
  pinned hash is kept; `--offline` refuses to download and succeeds only on
  such a hit;
- **it is a build tool, not runtime code**: nothing runs at import time, no
  new dependency (node's own `fetch`), and no `osd hana` verb references it
  — the runtime's rule stands: locate and verify a binary that is already
  on disk, never download (there is no download at runtime on purpose). The
  platform packaging (one extension bundle per target) calls this script and
  bundles its output.

## Tests

`test/osd-hana-contract.mjs` (the recorded sidecar contracts; the doctor on
the real probe document), `test/osd-hana-doctor.mjs` (sidecar handling,
verdicts, TLS capability, connection input), `test/osd-hana-fetch.mjs` (the build-time fetcher:
download + verify + atomic write, the mismatch refusal, the cached hit, the
offline mode, the refused redirect, the truncated download, the unknown
target, the not-a-runtime-tool guard — against a local HTTP server on
127.0.0.1 with the release URL injected through the pin seam, no real
network), `test/osd-hana-reader.mjs` (the dedicated reader's
mechanics, the secret store) and `test/osd-hana-two-login.mjs` (the guided
two-login flow: roles, per-login statements, failure rules, the write proof,
the reader probe), with a FAKE sidecar (`test/osd-hana/fake-sidecar.mjs`, a
shebang script the tests point `OSD_HANA_DUMP` at, verified against a
generated pin through the trusted `pinFile` seam; it answers its probe by WHO
it is run as) and a FAKE `hdb` client (`test/osd-hana/fake-client.mjs`,
scripted per login) injected through the reader's `clientFactory` seam.
Every guard has a named mutation behind it, each confirmed RED. No network,
no database.

**The fakes are recorded contracts, not guesses.** `test/osd-hana/contract/`
holds what the pinned binary really printed (`--version --json`, a successful
`probe`, a refused logon, a refused connection — identifiers replaced, field
names, nesting, value types and exit codes untouched) and `fields.json`, which
lists every key a probe document may carry and where the knowledge comes from
(`recorded`, the sidecar's own `source` at the pinned tag, or `announced` for a
later version). The fake sidecar serves these documents with VALUES varied;
`test/osd-hana-contract.mjs` fails when a scenario carries a key that file
does not list. The first version of the doctor read names only the fake spoke,
and was green on every test while answering "no ABAP schema" on a healthy
database — that is what this arrangement exists to prevent.
**To re-record** (required whenever `sidecar.lock.json` moves to a new
version): fetch the pinned binary with `fetch-sidecar.mjs`, run the four
commands the contract README names against a database with an ABAP schema
(password only through `OSD_HANA_PASSWORD`), replace every identifier with a
synthetic one, update `fields.json` from the sidecar's README and `probe.go`
at the new tag, and run one real `osd hana doctor` — exit 0 and a full verdict
is the acceptance.
