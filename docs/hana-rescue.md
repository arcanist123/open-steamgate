# Rescue your own ABAP code out of a HANA database

Release R1, "Rescue". This page is for people who know SAP but not the
insides of HANA.

You have an ABAP system whose application server is gone or about to go: an
expired trial licence, a restored backup, a box nobody can start. The HANA
database behind it is still there. Your code is in that database. This tool
reads it out and writes it as an
[abapGit](https://abapgit.org/) repository you can clone, diff and deploy
anywhere.

It is for **rescuing your own code**. It is not a way to run SAP.

A worked example, one package from start to finish with screenshots:
[Rescue $ZORK](rescue-zork.md).

Two commands do the work:

- `osd hana doctor` looks at the database and says, in plain words, whether
  your code can be rescued. It changes nothing (one optional exception, see
  [the dedicated reader](#an-optional-dedicated-read-only-user)).
- `osd hana extract` writes your code into a folder.

Both exist on the command line and, as the "OSD: Extract my code from HANA"
command, in the VS Code extension ([see below](#from-vs-code)).

The module's own reference is
[`tools/osd-hana/README.md`](../tools/osd-hana/README.md). This page is the
guide; that file is the detail.

## What is yours, and what stays out

Extracted by default: the objects the sidecar (see next section) classifies
as customer objects. That means:

- Z\* and Y\* objects,
- objects in your own registered `/NAMESPACE/`,
- objects in local `$` packages (leave them out with `--no-local`).

SAP-delivered objects stay out. The rule fails closed: if an object's class
is missing, unknown or written differently than expected, it is **not** treated
as yours. It is left out and listed as `skipped: unknown-class`.

`--include-sap` exists, but only together with an explicit `--package` or
`--name`. It refuses to run if the output folder or the dump folder sits
inside a git working tree. The report and the console say that this content is
the vendor's and must not be published. Never put it in a git tree.

Table **contents** are not extracted. Table definitions are.

## Getting the tool

You need `osd` and the sidecar `osd-hana-dump`.

`osd-hana-dump` is a small program, owned by the
[vsp project](https://github.com/oisee/vibing-steampunk). It does the actual
reading. It opens no listening socket.

**VS Code:** the extension comes in five platform packages (linux-x64,
linux-arm64, darwin-x64, darwin-arm64, win32-x64), and each carries exactly one
sidecar, for its own platform. The Marketplace installs the one that matches
your machine; from a GitHub release, install
`open-steamgate-<platform>-<version>.vsix`. The universal package (served on
every other platform, web included) carries no sidecar: the command then says so, and tells you
to install the platform package of the same release or to point
`OSD_HANA_DUMP` at the pinned binary. Nothing is downloaded.

**Command line:** download the sidecar from the
[v2.62.1 release](https://github.com/oisee/vibing-steampunk/releases/tag/v2.62.1).
The assets are named `osd-hana-dump-<os>-<arch>` for Linux and macOS (amd64,
arm64) and `osd-hana-dump-windows-amd64.exe` for Windows. The SHA-256 each
platform's file must have is in `tools/osd-hana/sidecar.lock.json`. Then tell
`osd` where the file is:

```sh
export OSD_HANA_DUMP=/path/to/osd-hana-dump-linux-amd64
```

Without `OSD_HANA_DUMP` (or a path handed in by the extension) the tool stops
and says how to get the binary. It never downloads anything by itself.

Before every run `osd` checks the file against a pinned SHA-256 for your
platform (`tools/osd-hana/sidecar.lock.json`) and then asks the binary to
describe itself (`--version --json`). A mismatch is refused and both hashes
are named. A binary that is not in the pin is refused unless you add
`--allow-unpinned-sidecar`. Then the tool says loudly that the binary's
read-only claim is its own and was not verified.

Known targets in the pin: linux-x64, linux-arm64, darwin-x64, darwin-arm64,
win32-x64. A platform outside that list (for example Windows on ARM) is
refused by name.

## `osd hana doctor`

```sh
osd hana doctor --host <host> --port <port> --database <tenant> --user <user>
```

Flags:

| flag | meaning |
|---|---|
| `--host`, `--port`, `--database`, `--user` | the connection. `--database` is the tenant name |
| `--schema NAME` | the ABAP schema, if you do not want it found for you |
| `--env-file FILE` | a file with `HANA_HOST`, `HANA_PORT`, `HANA_DATABASE`, `HANA_USER`, `HANA_PASSWORD`, `HANA_SCHEMA` |
| `--json` | the same findings as one JSON document (never the password) |
| `--allow-unpinned-sidecar` | see above |

### The password

There is **no `--password` flag**, on purpose: command-line arguments can be
read by every user of the machine. The password comes from the first of these
that exists:

1. `--password-stdin`
2. `HANA_PASSWORD` in the env file
3. the environment variable `OSD_HANA_PASSWORD`
4. a hidden prompt (only on a terminal)

With none of them the tool refuses and names all four. The password reaches
the sidecar only through its environment. It never appears in argv, a temp
file, the output or the report.

### The verdict

The doctor answers, in plain language:

- can it connect, and is this the tenant or the system database?
- is there an ABAP schema?
- which release, which clients, how big is the repository?
- is an ABAP server still attached? (Information only.)
- what kind of login is this: schema owner, administrator, or other, and can
  it do more than read?

If the password is a public default of a HANA trial image, it warns loudly. It
changes nothing.

Exit codes:

| code | meaning |
|---|---|
| 0 | ready to extract |
| 1 | usage or setup: bad flags, sidecar not found or refused, consent declined |
| 2 | cannot connect or log on |
| 5 | no ABAP schema found |

### Why a powerful login is safe

The doctor never refuses a login because it is powerful. Every session the
sidecar opens is read-only **at the database level**: the session is switched
to read-only, so HANA itself refuses any write, and only a single `SELECT`
(or `WITH ... SELECT`) is sent. Extraction is safe with any login, including
an administrator. When your login can write, the verdict says this once. With
an unpinned binary it adds that the read-only claim was not checksum-verified.

### An optional dedicated read-only user

If you prefer not to use a powerful login at all, the doctor can set up a
separate user that can only read. The sidecar cannot create users (it is
read-only by construction). So this is the one place where the tool talks to
the database itself, with the Node driver `hdb`.

```sh
osd hana doctor ... --create-reader     # set up
osd hana doctor ... --drop-reader       # take it away again
```

On the systems this was measured on, **no single login can do the whole
job**. An administrator cannot grant `SELECT` on the schema (error 258). The
schema owner cannot create users. So it takes two logins:

| the present login is | it does | then the doctor asks for |
|---|---|---|
| the administrator | creates the user, grants `CATALOG READ` | the **schema owner**'s login |
| the schema owner | grants `SELECT` on the schema | an **administrator**'s login |
| both in one | everything, in one step | nothing |
| neither | nothing: the doctor explains what the two logins must do and sends nothing | |

The second login's name comes from `--owner-user` or `--admin-user` (or a
visible question on a terminal). Its password comes from
`$OSD_HANA_OWNER_PASSWORD` or `$OSD_HANA_ADMIN_PASSWORD`, or a hidden prompt.
There is deliberately no stdin option for it. Neither extra password is
stored.

The exact SQL, as the consent screen shows it before anything is sent (the
password is masked on screen):

```sql
-- run by the administrator
CREATE USER <reader> PASSWORD <generated> NO FORCE_FIRST_PASSWORD_CHANGE;
ALTER USER <reader> DISABLE PASSWORD LIFETIME;
GRANT CATALOG READ TO <reader>;

-- run by the schema owner
GRANT SELECT ON SCHEMA "<schema>" TO <reader>;
```

The statements that are shown are exactly the ones that are executed. The
screen also lists the reader's own proof statements and the `DROP USER` that
undoes a failed run.

Things to know:

- The reader's name must match `^OSD_[A-Z0-9_]{1,26}$`. The default is
  `OSD_READER`. Change it with `--reader-name`.
- `GRANT CATALOG READ` is needed to extract database procedures (AMDP).
  `--no-catalog-read` leaves it out; the dump then has an empty catalogue
  and the extract ends with exit code 3.
- If the user already exists, the tool never creates over it and never drops
  it. It tells you to pick another name or use `--drop-reader`.
- After the grants, the reader is proved twice: a read of the schema's
  `TADIR`, and an `UPDATE` that changes no rows, which the database **must**
  refuse (error 258). If it is not refused, or the answer is anything else,
  the reader is dropped and the run fails loudly.
- The reader's password is generated (28 letters and digits) and kept in a
  secret store: a `0600` file in a `0700` folder under your config directory
  (the extension uses VS Code SecretStorage). It is never printed. `--json`
  reports user, schema and where it is stored.
- `--yes` answers the consent question in scripts.
- `--drop-reader` removes **only a reader this tool created**. It checks that
  the stored entry matches the system (host, port, database and the recorded
  system identity), and that the stored password still logs on as the reader.
  If any check fails, it refuses, keeps the secret and prints the one SQL
  line an administrator can run by hand (`DROP USER <name> CASCADE`). There is
  no force flag.

### TLS

| flag | effect |
|---|---|
| `--encrypt` | TLS with certificate validation |
| `--trust-server-certificate` | TLS without validation. Said loudly |
| `--ca-file FILE` | a private CA to verify against. Needs `--encrypt` |
| `--tls-server-name NAME` | the name to check the certificate for. Needs `--encrypt` |

The flags apply to both connections (the sidecar's and the reader path's). If
you ask for TLS and the sidecar cannot do it, the doctor refuses. It never
falls back to clear text. Without `--encrypt` the reader path is not encrypted,
and its consent text says the new password travels in clear.

The verdict says one of: the certificate was verified, encrypted but the
server is not authenticated, or the connection is **not** encrypted.

**"certificate doesn't contain any IP SANs":** the server's certificate was
issued for a host name, not an IP address, so a verified connection to the IP
is refused. Connect with the host name the certificate was issued for, or pass
`--ca-file` with the server's PEM file, or use `--trust-server-certificate` on
a network you trust.

## `osd hana extract`

```sh
osd hana extract --out <dir> --host ... --port ... --database ... --user ...
```

It takes the doctor's connection flags (`--host`, `--port`, `--database`,
`--user`, `--schema`, `--env-file`, `--password-stdin`,
`--allow-unpinned-sidecar`) and these:

| flag | meaning |
|---|---|
| `--out <dir>` | where the repository goes (required) |
| `--dump-dir <dir>` | where the raw dump goes. Default `<out>/.osd-hana/dump` |
| `--package <pattern>` | narrow by package (repeatable). The pattern is SQL `LIKE`: `%` (or `*`) is any text, `_` is any one character, so `'$ZORK%'` is `$ZORK` and its subpackages and `$ZORK_00` also matches `$ZORKX00`. A local `$` package the pattern matches is selected, even with `--no-local` |
| `--name <pattern>` | narrow by object name (repeatable), same wildcards |
| `--author <user>` | keep only this author's objects, and add this author's local objects from every package. Beside `--package` it is **not** a narrowing: it brings in the author's local objects outside the pattern too |
| `--no-local` | leave local `$` packages out of the default scope (a `$` package a `--package` pattern names is still selected) |
| `--inactive` | ask the sidecar to include inactive versions |
| `--include-sap` | see "What is yours" above |
| `--dry-run` | print the plan and stop. Never asks |
| `--yes`, `--yes-large` | consent for scripts |
| `--json` | print the plan as one JSON document |

### The plan, and consent

First the tool lists what is in scope, without reading any source. The plan
shows counts and byte estimates per type and per package, a table per author
for local objects, the three biggest packages, and the types the converter
cannot write. If local objects of more than one author are in scope it says so
and names `--author` and `--no-local` as the way to narrow. (On a trial system
that is where several people's untransported work lives.)

Nothing is dumped before you have seen the plan.

- On a terminal it asks `extract N objects (S MB) into <out>?`. `y` or `yes`
  goes on. Anything else, or end of input, declines and writes nothing.
- A script needs `--yes`.
- A plan above **5 000 objects or 200 MB** is "large". It needs
  `--yes-large`. A plain `--yes` is refused. On a terminal the question says
  so and wants the full word `yes`.

### What lands in the output folder

```
<out>/
  .abapgit.xml
  src/                      the abapGit repository: one folder per package
  .gitignore                contains ".osd-hana/"
  extract-report.md         the report, for people
  extract-report.json       the same, for tools
  .osd-hana/dump/           the raw dump (part-NNNNN folders)
```

ABAP source is byte-identical to what the database holds. The XML is
abapGit's own layout. File names are lower case, and a `/` in a namespace
becomes `#`. Package folders follow the PREFIX folder logic when the package
names allow it (every child named `<parent>_<suffix>`), and otherwise FULL
(each package nested under its parent). `MASTER_LANGUAGE` in `.abapgit.xml`
follows the master language the database reports for most objects.

`.osd-hana/` is in `.gitignore` from the first moment. **Before publishing an
extracted repository,** remove `extract-report.json`, `extract-report.md` and
`.osd-hana/`: they contain absolute local paths and the raw dump.

### The report

The report is always written. The first line of `extract-report.md`, and the
one console line, is the summary. It never says "everything" while anything
is unchecked.

Every object in scope ends in exactly one state:

| state | meaning |
|---|---|
| written | files written |
| written-partial | written, but a part that the dump shows exists was **not extracted** |
| skipped | not written, with a reason (unknown class, no source in the dump, name collision, and so on) |
| unsupported | a type the converter cannot write. It is listed, never dropped |

The totals per type always add up to the in-scope count. If they do not, that
is an internal error (exit 6), never a silent one.

Under an object, a part that is missing is one of two kinds:

- **not extracted**: the dump shows the part exists, and it was not written.
  Examples: an include the sidecar could not deliver, foreign keys the dump
  carries but this converter does not write, translated texts in languages
  other than the master (only the E text is written), a sidecar error on the
  object. The object is `written-partial`.
- **not checked**: the dump cannot tell whether the part exists at all. The
  dump carries no screen, GUI-status or variant tables, so screens, GUI
  statuses and variants are "not checked" on every program and function
  group. Secondary indexes, search-help assignments and component texts are
  "not checked" while the dump does not carry their tables. An object whose
  only gaps are "not checked" is still `written`, and carries an `unchecked`
  list.

So "not extracted" means we know something is missing. "Not checked" means we
do not know. The two are never mixed, and a summary line names the unchecked
kinds with counts.

Exit codes:

| code | meaning |
|---|---|
| 0 | everything in scope written (unchecked parts do not count against it) |
| 1 | usage |
| 2 | cannot connect |
| 3 | partial: a part is not extracted, an object is skipped or unsupported, or an error occurred. The report says what |
| 4 | output directory refused (for example `--include-sap` inside a git tree) |
| 5 | no ABAP schema |
| 6 | internal error. A best-effort report is written anyway |

### Restarting

A dump is reused when its manifest records the same request and finished
without errors. Run the same command again to continue after an interruption.
A dump from a different request is refused, never mixed. On a restart the
report notes objects that appeared or disappeared in the database since the
dump. `src/` and `.abapgit.xml` are rewritten from the dump.

The dump request names the in-scope objects exactly (sidecar v2.62.1), never
your patterns, so nothing SAP-delivered is fetched unless `--include-sap` asked
for it. Names go in chunks of 500 per request; each chunk is its own
`part-NNNNN` folder. Before conversion, every dump is audited: if it holds
content for an object that is not in scope (beyond the extra names the
sidecar reports as dependencies it closed over), the run is refused with exit
code 4, the repository is left as it was, and the dump is marked so that it
is never reused. Remove that dump folder before you run again.

## What is extracted, and what is not

From the converter's own list of types (`SUPPORTED_TYPES` in
`tools/osd-hana/convert/convert.mjs`):

| object type | result |
|---|---|
| CLAS, INTF | sources (the includes the dump delivers) and abapGit XML. Component texts are "not checked". Class texts in languages other than E are "not extracted" |
| MSAG | message classes: master-language messages, plus the other languages' texts. Long texts are "not checked" (the dump has no documentation tables) |
| PROG | source, and text pool. Screens, GUI statuses and variants are "not checked" |
| FUGR | main program, includes and function modules with signatures; the group's short text is its master-language TLIBT text. Screens, GUI statuses and variants are "not checked". Function texts in languages other than E are "not extracted" |
| BDEF, DDLS, DDLX, SRVD | the source (CDS, behaviour, metadata extension, service definition) with abapGit XML |
| TABL | definition from the dictionary tables. Foreign keys are "not extracted" when the dump carries them. Secondary indexes, search-help assignments and component texts are "not checked" while the dump lacks them. Table texts other than E are "not extracted". **Contents are not extracted** |
| DTEL, DOMA, TTYP, SHLP, VIEW | definition from the dictionary tables |
| any other type (for example DCLS, which the sidecar can list) | `unsupported`: listed in the plan and the report, not written, exit 3 |

A table field typed directly, without a data element, is written with the
`MASK` the dictionary derives for it.

There is no "rows-only" group in the converter. Rows of tables (table data) are
never extracted.

Database procedures (AMDP) come through the sidecar's catalogue, which needs
`CATALOG READ` or schema ownership. Without it the dump reports an empty
catalogue and the extract exits with 3.

Which types the sidecar can list is the sidecar's business. The plan shows the
types it finds, and marks the ones this converter cannot write.

## From VS Code

The command **"OSD: Extract my code from HANA"** (desktop only) runs the same
steps with prompts instead of flags:

1. **Connection:** host, port, tenant (optional) and user, or a remembered
   connection (setting `osd.hanaExtract.connections`, never a password). The
   password is asked in a password box and used for this run only.
2. **Doctor verdict:** the same plain-language verdict as `osd hana doctor`.
   If your login can write, you are told why extraction is still safe.
3. **Optional read-only user:** you can create a dedicated one first. The
   exact SQL is shown, grouped by the login that runs each statement, and
   nothing is sent unless you choose **Yes**. If a second login is needed you
   are asked for it. The new user's generated password goes to VS Code
   SecretStorage, and later runs can log on as that user.
4. **Plan:** the objects in scope by type and, for local objects, by author,
   with sizes. You can narrow to one package or pattern (**Only package…**,
   for example `$ZORK%`), to one author, or leave local packages out. Once a
   pattern is set, the plan offers only **Change package pattern…**: an
   author beside a pattern would add that author's objects from other
   packages.
5. **Confirm:** you choose an empty folder and confirm "Extract N objects
   (S MB) into ...?". Nothing is dumped before that.
6. **Progress:** cancellable. Cancelling stops the reader.
7. **Done:** the report (`extract-report.md`) opens. If not everything could be
   written, a warning shows the report's first sentence.

The form has no TLS fields; use the command line for `--encrypt`. The command
needs the osd-hana tools: an open-steamgate checkout (`osd.home` or the
workspace folder) or the bundled system after its first Start. The sidecar
comes from the platform package, see "Getting the tool".

## Known limits

- Scope comes from the sidecar's classification. This tool only narrows it.
- No table contents. Only definitions.
- Screens, GUI statuses and variants are not checked (the dump has no tables for
  them). Secondary indexes, search-help assignments and component texts are not
  checked while the dump lacks their tables.
- Only the E text of table, class and function texts is written. Other
  languages are reported as "not extracted".
- Foreign keys that the dump carries are not written yet.
- TLS needs a sidecar with the `tls` capability. The pinned v2.62.1 has it. An
  older binary is refused for TLS, never used in clear text.
- The VS Code form has no TLS fields.
- Message-class long texts are "not checked".
- An ABAP schema name with control characters is refused. Folder names that
  collide, or names unsafe as paths, refuse the objects concerned.
- The reader flow needs two different logins on the systems measured so far.
- The secret file on Windows inherits the profile's access rights (`chmod`
  has no effect there).

Found a problem? Open an issue at
<https://github.com/oisee/open-steamgate/issues>. Do not paste passwords,
host names, user names or schema names of a real system, or the dump. The
report is safe to share only after you have removed absolute paths from it.
Problems with the sidecar itself belong at
<https://github.com/oisee/vibing-steampunk/issues>.
