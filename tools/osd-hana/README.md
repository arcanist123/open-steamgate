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
| `extract-plan.mjs` | the extract plan document, the consent gate, and `buildDumpRequest` — the ONE function the dump request is built in |
| `extract-workarea.mjs` | the extract work area: the dump restart rule (`reusableDump`), the marker (atomic), the `src/` refresh that never touches a kept file |
| `report.mjs` | the extract report: `extract-report.md` and the JSON document, from one source |
| `convert/` | the dump → abapGit-repository converter (`xml.mjs` the abapGit XML layout, `ddic.mjs` the DDIC serializers, `program.mjs` CLAS/INTF/PROG/FUGR, `convert.mjs` the walk) |
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

The sidecar advertises the `tls` capability in its handshake (since
v2.62.1, the current pin; the code is written against the capability and
tested both ways with the fake, so an older binary without it is still
refused for TLS rather than used in clear text). TLS is **one
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

   **The marker** — `.osd-hana/marker.json` records that this directory is
   this command's and exactly what it wrote (paths with SHA-256). Round 5: a
   run that stops at the plan — `--dry-run`, a declined prompt, a refused
   non-interactive run, any refusal before conversion — leaves the marker
   BYTE-IDENTICAL: the marker is written only where a run commits to writing
   repository files, and it never SHRINKS (a provisional write carries the
   last run's file list, so even a crash between the two writes keeps the
   complete list). Both writes are atomic (temp + rename). Without this, a
   harmless `--dry-run` emptied the marker and the next real run kept every
   object ("the marker of the last run does not list it").

   **The commit point** (round 6) — nothing outside the work area
   `.osd-hana/` changes until the run has passed every refusal: listing →
   plan → consent → dump (or reuse) → scope audit, and only then the
   provisional marker, the `src/` refresh, the `.gitignore` line and the
   conversion. A refusal at any step before it leaves the repository —
   `src/`, `.abapgit.xml`, `.gitignore`, the last run's report and the
   marker — byte-identical; the audit's refusal report goes to
   `.osd-hana/refused-report.md`. The work area ignores itself (`*` in
   `.osd-hana/.gitignore`), so the raw dump is never committable even
   before a run has written anything else. `<out>/.gitignore` is never
   overwritten: a writing run creates it when absent and appends
   `.osd-hana/` when the line is missing (the report says which); a
   `--dry-run` or a refused run does neither.

   **Consent** — nothing is dumped without the user having seen the plan.
   On a terminal the command asks `extract N objects (S MB) into <out>?`
   after the plan; `y` or `yes` proceeds, anything else (EOF included)
   declines and nothing is written. A non-interactive run needs `--yes`. A
   plan above **5 000 objects or 200 MB** (estimated bytes) is LARGE: it
   needs `--yes-large` instead — a plain `--yes` is refused, and on a
   terminal the question says so and wants the full `yes`. The numbers live
   in exactly one place (`LARGE_PLAN` in `extract-plan.mjs`); the prompt,
   the refusals and this README quote it.
3. **Dump** — the dump request NAMES the in-scope objects of the listing,
   exactly: `requested: {TYPE: [names]}` (sidecar v2.62.1), sorted and
   de-duplicated, in chunks of 500 objects (one request, one directory per
   chunk under `<out>/.osd-hana/dump/part-NNNNN`, one aggregate manifest) —
   and never the user's patterns, so nothing of the vendor's is fetched
   unless `--include-sap` asked for it. The sidecar selects TADIR per type,
   expands the sources of CLAS / INTF / FUGR / PROG itself (a function group:
   its main program `SAPL<grp>` and its includes `L<grp>` + exactly three
   characters — so a sibling group whose name extends this one's is never
   fetched), takes MSAG / DDLS / DDLX / SRVD / DCLS by name, and closes the
   dictionary kinds over their dependencies; the extra names that closure
   reached are listed in the manifest's `closure.resolved`. The request is
   built in ONE function (`buildDumpRequest` in `extract-plan.mjs`); the
   include-name LIKE patterns of the earlier rounds are gone with v2.62.1.
   A dump made from such patterns is never reused for a `requested` run
   (the reuse fingerprint carries the kind of selection).
   **The scope audit** runs on EVERY dump before conversion, reused or fresh
   (round 5): every object the dump delivered WITH content — sources, or
   definition rows (`rows`) — must be in the scope set or be one of the
   names the sidecar lists in `closure.resolved` (exactly those extras are
   legitimate; a sidecar that over-delivers anything else still fails the
   run), and every REPOSRC row it fetched must resolve to an in-scope
   owner (`convert/ownership.mjs` — the one resolver the converter writes
   by, so the two cannot drift). Anything outside the scope refuses the run
   (exit 4), names the dump directory so it can be removed, leaves the
   repository byte-identical (the audit runs before the commit point) —
   and MARKS the dump: `refused.json` in the dump directory. A marked dump
   is never reused: the next run refuses it and names the directory to
   remove, so "just run it again" cannot walk past the refusal. (Sources
   arriving through the wholesale DD-table dump — DDDDLSRC and friends carry
   every object's rows, like DD02L — are metadata, not evidence of
   over-delivery; the object audit covers their objects.)
   The raw dump never belongs in the repository: the work area ignores
   itself, and a writing run makes sure `<out>/.gitignore` names
   `.osd-hana/` (see the commit point in 2).
   Restartable: an existing dump whose aggregate manifest echoes the same
   request selection (canonically compared; the derived names may drift with
   the listing) and finished without errors is reused; anything else is
   refused, never mixed — and a dump the audit marked refused is refused
   forever, until it is removed. On a restart the live listing is compared
   with the reused dump's own object list and drift for objects that
   APPEARED since the dump is reported (they are skipped as not-in-dump);
   an object that LEFT the scope makes the reused dump fail the audit
   (refused, marked, directory named) — the dump then holds code that is no
   longer yours to keep, and re-dumping is the honest restart. The refusal
   leaves the previous repository byte-identical; only the re-dump's
   conversion replaces `src/` and `.abapgit.xml` — see the marker rule in 4.
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
   part exists and it was not written (a failed include, foreign keys /
   indexes / search-help assignments / component texts the dump carries FOR
   THIS TABLE and this converter does not serialise — round 5 reads the
   aspect tables per TABNAME, so a table without foreign keys of its own is
   no longer partial just because the DD tables are in the dump; a
   translated text pool left out, a sidecar error on the object) — or `not checked` — the
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
