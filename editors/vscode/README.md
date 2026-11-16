A local ABAP application server inside VS Code. No SAP or ADT connection needed.

SAP kernel rejections now appear as red squiggles while typing, with a Problems link to the support section. `osg.kernelStrict` defaults to `error` and allows runs; choose `warning`, `off`, or `refuse` (also stops object runs and tests). Desktop VSIX installs include the scanner and its dependencies.

# open-steamgate

Start a bundled ABAP runtime, explore its OData services, run ABAP Unit, and open local Fiori apps. The extension carries its own system seed and builds it on first start.

<!-- real capture pending: OSD tree with a selected service card in VS Code desktop -->

![Fiori list report captured from the local demo](https://raw.githubusercontent.com/oisee/open-steamgate/main/editors/vscode/media/screenshots/fiori-list-report.png)

<!-- real capture pending: VS Code desktop debugger stopped on an ABAP source line -->

## Quick start

1. Install **open-steamgate** from the VS Code Marketplace, or install the downloaded `.vsix` with **Extensions: Install from VSIX...**.
2. Open the **OSD** Activity Bar view and select **Start**. The first start builds the bundled system; later starts reuse its cache.
3. Run **OSD: Open sample** from the command palette or the system status bar. Choose a bundled notebook and run a cell; the command offers to start OSD if needed. In an [osg-demo](https://github.com/oisee/osg-demo) workspace, it also offers **ZOSD_DEMO_HELLO** (press **F9** to run).

The status bar shows **OSD running/stopped**, the serving **OSD generation**, and **OSD jobs** (when enabled for a file SQLite database). Click the system item for start actions or **System overview**, and the jobs item to open **OSD Jobs**.

VS Code 1.101 or newer is required. The system runs locally on desktop or in a Remote-WSL or Remote-SSH workspace. It does not need a SAP or ADT connection.

The editor’s ▷ button runs classrun (F9) when the class implements
`IF_OO_ADT_CLASSRUN`. The beaker runs ABAP Unit and appears for classes
with test methods; it runs exactly the same command as **Ctrl+Shift+F10**
(`testing.runCurrentFile`). Tests also run through the Test Explorer.
**F8 / ▷ / F9 never run ABAP Unit.** F8 runs classrun for a class implementing
`IF_OO_ADT_CLASSRUN`, even when it has tests; reports run in a terminal,
and tables/CDS views open Data Preview. Other supported run actions keep
their object dispatch. A class with nothing to run shows
“Nothing to run for <OBJ>. Tests: Ctrl+Shift+F10.” Each button’s tooltip
names its action and key.

## What works

- Start and stop the local server; inspect its services and generation in the OSD tree.
- Run ABAP Unit in Test Explorer; check, activate, and run ABAP files with familiar keys.
- Open local OData and Fiori apps, inspect short dumps, use SQL notebooks, and debug ABAP through VS Code's Node debugger.
- Add an abapGit-style workspace layer over the bundled source.

## What connects to what

The **osd system** is a local ABAP server. Start builds and launches it on
its allocated HTTP port (shown in **OSD running** and System overview).
`osd.url` points extension requests to that listener; independently started
systems default to port 3030.

The ABAP-FS mount **OSD (local)** (`osd-local`) exposes source from that
same server over ADT. It is a filesystem connection, independent of debugging.

The osd debugger attaches VS Code’s Node debugger on demand when you set an
ABAP breakpoint while the system runs, or press **F9** / **▷** with a
breakpoint already set. **Start system never starts a debug session**, even
with saved breakpoints. No launch configuration is needed. The SAP ADT and
ABAP-FS debuggers are unrelated to osd: **Attach to server**, **ABAP on server**,
and **ABAP Replay Debugger** target SAP systems.

Each Output channel starts with a line explaining its contents:

- **OSD**: extension diagnostics and command/debugger activity.
- **OSD: Console**: classrun/F9 output and Check/Activate feedback.
- **OSD: System log**: server build/runtime logs and debugger attachment diagnostics.
- **OSD: Jobs**: job summaries, or worker JSON events and diagnostics after
  the explicit **Show raw job log** action. **Show jobs** restores summaries.

## ABAP values in the debugger

When stopped on an ABAP line, Variables, Watch and hover show ABAP values:
`'ABC' (c20)`, `12.50 (p8,2)`, `42 (i)`, `9223372036854775807 (int8)`,
`2026-10-03 (d)`, `12:34:56 (t)`, and `ABCDEF (xstring)`. Character values
omit trailing padding; strings preserve it. Float values use scientific notation with a locale-independent decimal point, and fixed hex includes its byte length (`ABCD0000 (x4)`).

Expand `{…} (structure)` to see its declared lowercase components. Tables
show `[3 rows] (standard table)` (or sorted) and expand to rows `1`,
`2`, `3`. Field symbols and data references show `->` followed by the target
value and expand through a `->` child. Unassigned/initial references say so.
Objects show their class name and expand to ABAP attributes, including private
attributes exposed by the transpiler.

The view shows the first 100 standard/sorted table rows, with a `…more` count
for the rest; that node does not load more rows. Hashed tables show a summary
without enumerating rows: the installed runtime has no bounded iterator or
maintained count. Text and hex previews stop after 256 storage characters.
CHAR previews omit trailing padding, so the projected view is not an exact
padded-storage display; inspecting never changes that storage. CASTING field
symbols use their declared type for supported hex/character reinterpretations. Reference previews stop after eight links or a cycle.
Dates use ISO order rather than a user-specific SAP date format. Float fixtures
are derived from SAP's [scientific type-f formatting rules](https://help.sap.com/doc/abapdocu_816_index_htm/8.16/en-US/ABENWRITE_FORMATS.html),
with a fixed decimal point; they are not captured SAP debugger output or a
claim of exact parity across debugger versions and locales. Bundled constructors
must have their runtime names restored by `bin/osd.mjs`; the tests bundle the
runtime and execute that exact startup block. Unknown values
and failed formatting keep VS Code's default rendering. The view uses the
built-in Node debugger's [custom generator options](https://github.com/microsoft/vscode-js-debug/blob/main/OPTIONS.md),
which js-debug currently marks deprecated. It applies to desktop system and
ABAP Unit sessions started by the extension; it does not change Watch expression
syntax or provide a browser debugger. Custom child properties are for inspection;
edit ABAP values in source rather than using Set Value on the projected children.

## Rescue your ABAP code from a HANA database

**OSD: Extract my code from HANA** (desktop only) copies your own ABAP code out
of a HANA database whose ABAP server is gone or about to expire, into an
abapGit-layout folder you can clone, diff and deploy. It reads only; it never
writes to the database.

1. **Connection.** Enter the host, port, tenant database (optional) and user,
   or pick a remembered connection. The password is asked in a password box
   and used for this run only. You can remember the connection in your
   settings (`osd.hanaExtract.connections`); a password is never stored
   there.
2. **Check.** The database is checked first and the verdict is shown in plain
   words: reachable, ABAP schema found, release and size, what kind of login
   this is. If your login can write, you are told why extraction is still
   safe, and you can create a dedicated read-only user first. That shows the
   exact SQL (grouped by the login that runs each statement) and sends
   nothing unless you choose **Yes**; if a second login is needed, you are
   asked for it. The new user's generated password is kept in VS Code's
   secret storage, and later runs can log on as that user.
3. **Plan.** The objects in scope are listed by type and, for local
   objects, by author, with their size. You can narrow to one author or leave
   local packages out.
4. **Extract.** Choose an empty folder and confirm "Extract N objects (S MB)
   into ...?". Progress can be cancelled; cancelling stops the reader. The
   report (`extract-report.md`) opens when it finishes. If not everything
   could be written, you get a warning with the report's first sentence and
   the report lists every object.

The reader (`osd-hana-dump`) is bundled per platform. Without one, the command
explains how to point `OSD_HANA_DUMP` at the pinned binary. Before you publish
an extracted folder, delete `extract-report.json`, `extract-report.md` and
`.osd-hana/`: they contain local paths and the raw dump.

## Current limits

- Portable AMDP support is limited. HANA-specific SQLScript needs HANA, and some methods are not portable to SQLite.
- Warm rebuild requires upstream transpiler fixes [#1900](https://github.com/abaplint/transpiler/pull/1900) and [#1921](https://github.com/abaplint/transpiler/pull/1921) to be released. Until then activation uses the cold build path.
- `osd.engine: "osgo"` runs the release's Go executable instead of the Node host. It is downloaded on the first start (about 73 MB on Linux x64) from this extension's own release, checked against its `.sha256` and kept; it is never part of the VSIX. It serves the services it was built with, so workspace ABAP is not compiled into it, an activation needs a rebuild of osgo, and CHECK/activation need the compiler sidecar it does not download yet. SQLite only; no debugger and no background jobs.
- The Marketplace build has no browser extension entry. The separate web gateway probe remains a development experiment.

The extension is MIT licensed. Bundled dependency declarations and licence review items are in `THIRD-PARTY-NOTICES.md` inside the VSIX.

### Background jobs

**osd: Start system** also starts the job worker, restarts it after a crash,
and stops it with the system or extension. Serving generation changes restart
the worker after its active job finishes, with a bounded shutdown wait.
No terminal command is needed.
`osd.jobs.worker` defaults to `auto`; use `off` to disable it or `on` to enable
it explicitly. Both modes require durable file SQLite. The default `osd.database.system=sqlite` stores a shared file.
Other backends leave the worker stopped and show one message to use file SQLite.
The **OSD jobs** status bar shows idle, running/queued counts, or a stopped
worker. Click it to open **OSD Jobs** in the OSD sidebar. Browse the newest
200 saved runs grouped by status, filter by name/user/date, and expand a job
for steps, start condition and duration. Right-click for **Open job log**,
**Open output** (the API verifies SHA-256), or **Copy job key**. Log and output
tabs are read-only; missing output is reported explicitly. The panel refreshes
with the jobs status poll while jobs are active or waiting, retaining its last
view while the system is busy or paused. Stopped systems and disabled APIs
show a one-line state with **Start system**. Only imported saved runs are
listed; unimported reservations are outside this API, and step variants/users
are shown only when recorded. No cancel, repeat or delete actions are included.

Use **OSD: Show jobs** for a readable **OSD: Jobs** summary:
one line per run, newest first, with its name, state, start time, duration,
step/output counts where available, and failure reason. The summary refreshes
every two seconds after opening and shows up to 200 recent runs.
**Show raw job log** in the action menu or command palette opens the unchanged
worker JSON events and diagnostics in **OSD: Jobs**. This explicit action switches the channel to raw mode;
**Show jobs** restores summaries. Raw mode streams live events and retains
the worker log for this window’s session.

## Local ABAP-FS connection

Start your pocket system with **osd: Start**. With [our ABAP-FS fork, branch osd-api](https://github.com/oisee/vscode_abap_remote_fs/tree/osd-api), **OSD (local)** appears without a password prompt. It connects automatically in an empty window, a multi-root window, or a saved/Untitled workspace (`workspaceFile` is defined). In a single-folder window, a one-time, non-modal **Open OSD (local) in ABAP-FS** / **Not now** offer leaves mounting to your explicit click. Mounting reloads that window; OSD remembers that the system was running and starts it automatically on activation. Dismissal and **Not now** are remembered across windows. Stop withdraws it; a new start uses a fresh token. Passwordless auto-connect requires this fork until API v2 is upstream. Tokens stay in memory and the serving process environment, never settings or files.

The provider sends `name: "OSD (local)"` and `id: "osd-local"`. The fork at `0e200a2d` documents a display `name`, but its API mount still names the root from the ID, so it currently reads **osd-local(ABAP)**. Fork follow-up: use the provided display name when mounting the workspace folder.

With Marketplace ABAP-FS (API v1 or older), the first start offers **Add** / **Not now** once, remembered across windows. **Add** creates **OSD (local)** in user `abapfs.remote` settings with the local URL, client and username, preserving other entries and saving no password. Connect through ABAP-FS and enter any password: the local system accepts it. The settings entry remains after Stop; if a later start chooses another port, update its URL. Existing entries are preserved. This integration covers desktop systems started by OSD; independently started systems and vscode.dev do not receive a token connection.
