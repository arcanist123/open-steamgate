# tools/osd-hana — `osd hana doctor`, `osd hana extract`

First piece of the "rescue your own ABAP code out of a HANA database whose
ABAP server is gone or expiring" product line. This module locates, verifies,
runs and explains the Go sidecar **`osd-hana-dump`** (owned by the sibling
`vsp` project; the contract between the two is frozen: see `W0-contract.md`
in the task tree — the tracked facts are restated here).

Nothing in this module opens a listening socket, and no statement that is not
a SELECT is sent — with exactly one exception: `--create-reader` /
`--drop-reader` talk to the database through the Node driver `hdb` directly,
because the sidecar is read-only by construction and cannot create a user.

## Files

| file | what it is |
|---|---|
| `osd-hana.mjs` | the `osd hana <verb>` entry; `bin/osd.mjs` dispatches mode `hana` here |
| `doctor.mjs` | the `doctor` verb: sidecar lifecycle + probe + verdict, exit codes |
| `extract.mjs` | the `extract` verb: scope → plan → dump → convert → report (see below) |
| `report.mjs` | the extract report: `extract-report.md` and the JSON document, from one source |
| `convert/` | the dump → abapGit-repository converter (`xml.mjs` the abapGit XML layout, `ddic.mjs` the DDIC serializers, `program.mjs` CLAS/INTF/PROG/FUGR, `convert.mjs` the walk) |
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

## The extract

`osd hana extract --out <dir>` writes your own code out of the database into
an abapGit-layout repository (an `.abapgit.xml` and `src/`) that abapGit can
clone, diff and deploy:

1. **Scope** — fails CLOSED: in scope are exactly the objects the sidecar
   classifies as `customer` (local packages included; `--no-local` leaves
   them out). A missing, unknown or differently-cased class is NOT customer:
   the object is left out, listed as `skipped: unknown-class`, and the run
   says the sidecar may be newer than this module. `--package`, `--name`
   (repeatable) and `--author` narrow the selection; the request they build
   for `list` is schema-1 JSON the sidecar validates field by field.
   SAP-delivered objects are extracted only with `--include-sap` together
   with an explicit `--package` or `--name` — then the output directory AND
   the dump directory must not sit inside a git working tree (extract
   refuses), and the report and the console carry the notice that the
   content is the vendor's and must not be published. Table CONTENTS are not
   extracted; the sidecar's `tables` request field stays reserved.
2. **Plan** — the sidecar's `list` (no sources read) becomes a per-type and
   per-package table with counts and byte estimates, a per-AUTHOR table for
   the local objects (count + bytes — on a trial system that is where
   several people's untransported work lives), the three biggest packages,
   and names the types the converter cannot write. When local objects of
   more than one author are in scope, the plan says so and names the
   narrowing flags: "local objects of K authors are in scope; narrow with
   `--author <name>` or `--no-local`". `--dry-run` stops here and never
   asks; `--json` prints the plan as one document. Names from the database
   never reach the terminal or the report raw: control characters are
   printed escaped, never interpreted.

   **Consent** — nothing is dumped without the user having seen the plan.
   On a terminal the command asks `extract N objects (S MB) into <out>?`
   after the plan; `y` or `yes` proceeds, anything else (EOF included)
   declines and nothing is written. A non-interactive run needs `--yes`. A
   plan above **5 000 objects or 200 MB** (estimated bytes) is LARGE: it
   needs `--yes-large` instead — a plain `--yes` is refused, and on a
   terminal the question says so and wants the full `yes`. The numbers live
   in exactly one place (`LARGE_PLAN` in `extract-plan.mjs`); the prompt,
   the refusals and this README quote it.
3. **Dump** — the dump request NAMES the in-scope objects of the listing:
   exact names, sorted, LIKE-escaped (the sidecar matches
   `LIKE ? ESCAPE '\'`), in chunks of 500 (one request, one directory per
   chunk under `<out>/.osd-hana/dump/part-NNNNN`, one aggregate manifest) so
   a big selection cannot blow the sidecar's SQL parameter limit — and never
   the user's patterns, so nothing of the vendor's is fetched unless
   `--include-sap` asked for it. Composite objects carry, next to their
   exact name, the include-name pattern their sources hide behind in
   REPOSRC — measured on the real bed and confirmed there (round 3): a
   class's/interface's sources sit behind the 30-character `=`-padded name
   (`<name padded to 30 with =>%`), a function group's behind its main
   program and includes (`SAPL<grp>%`, `L<grp>%`); flat programs and DDIC
   need only the exact name. TADIR selection stays exact (a padded prefix
   names exactly one object), so the selection cannot widen; an include
   pattern that happens to match a foreign name (`L<grp>%` also prefixes a
   longer group's includes) brings at most a source no in-scope owner
   claims — never written — and if the sidecar ever reports such an object
   itself, the audit below refuses the run. The request is built in ONE
   function (`buildDumpRequest` in `extract-plan.mjs`): when the sidecar
   gains an exact `objects: [{type, name}]` request field (asked of its
   owner), the patterns go away and only that function changes. After the
   dump, every object the dump fetched WITH sources on disk is checked
   against the scope set: anything outside it refuses the run (exit 4),
   names the dump directory so it can be removed, and writes nothing.
   `<out>/.gitignore` carries `.osd-hana/` from the first moment — the raw
   dump never belongs in the repository.
   Restartable: an existing dump whose aggregate manifest echoes the same
   request selection (canonically compared; the names may drift with the
   listing) and finished without errors is reused; anything else is refused,
   never mixed. On a restart the live listing is compared with the reused
   dump's own object list and any drift (objects appeared or disappeared
   since the dump) is reported in the report; `src/` and `.abapgit.xml` are
   refreshed — see the marker rule in 4.
4. **Convert** — the dump becomes the repository: folder logic PREFIX when
   the package names allow it (one hierarchy, every child
   `<parent>_<suffix>`), otherwise FULL — and under FULL every package's
   folder is nested under its parent's, as abapGit's
   `package_to_path` does. File names as abapGit writes them (lower case, a
   namespace `/` becomes `#`). ABAP is byte-identical to the dump; the XML is
   abapGit's own layout (BOM, one element per line, its field order), decided
   from abapGit's serializers, not from single files. The report is built
   from a ledger: every in-scope object ends in exactly one state, and every
   part the converter knows it cannot write is a line under its object, in
   exactly one of two kinds (round 4): `not extracted` — the dump shows the
   part exists and it was not written (a failed include, foreign keys the
   dump carries but this converter does not serialise, a translated text
   pool left out, a sidecar error on the object) — or `not checked` — the
   dump cannot tell whether the part exists at all. `written-partial` is
   ONLY for `not extracted`: an object whose only gap is a `not checked`
   part is `written`, carrying its `unchecked` list ("not checked" is not
   "partial" — a signal that is always on is no signal). The dump carries no
   screen/CUA/variant tables at all, so screens, GUI statuses and variants
   are `not checked` on every PROG/FUGR rather than claimed complete. A type
   the converter cannot write is never dropped silently: it is listed, and
   the exit code is 3. Object and package names from the dump are validated
   as path components (traversal, backslashes, control characters,
   Windows-reserved names are refused per object); a name collision refuses
   both objects, never last-writer-wins.
5. **Report** — always written: `<out>/extract-report.json` and
   `extract-report.md`: per type on the system / dumped / written /
   written-partial / skipped / unsupported (the totals always add up to the
   in-scope count — a mismatch is an internal error, never a silent one),
   per object its files with SHA-256, package, state (active/inactive,
   `generated` flagged), its `not extracted` part lines and its `unchecked`
   list, the sidecar version + pin, the request, the folder logic, the
   duration. The FIRST line of the md — and the one console line — is the
   summary, and it never claims completeness while any unchecked part
   exists: "N objects written. For K of them this tool could not check:
   <part kinds with counts>." with the losses ("M objects of T could not be
   fully extracted (...)") named first; "all objects in scope were written"
   is said only when nothing is unchecked. The per-object unchecked lists
   stay in the json and in a collapsed section of the md.

Exit codes: **0** everything in scope written — a part the dump cannot even
check does not count against its object (it is carried as the object's
`unchecked` list), **3** partial (a part the dump shows exists was not
extracted, an object skipped or unsupported, or an error — the report says
what), **1** usage, **2** cannot connect, **4** refused output directory,
**5** no ABAP schema, **6** internal error (a conversion/write failure or
the ledger invariant — a best-effort report is written anyway and names the
failure).

Before publishing an extracted repository: remove `extract-report.json`,
`extract-report.md` and `.osd-hana/` — they carry absolute local paths (and
the dump). `.abapgit.xml`'s `MASTER_LANGUAGE` follows the dump's dominant
TADIR master language, not a hard-coded guess.

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
