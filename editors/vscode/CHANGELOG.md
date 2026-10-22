# Changelog

## Unreleased

- **open-steamgate in vscode.dev.** The extension now has a browser entry: in vscode.dev (and other VS Code for the Web hosts) the whole ABAP gateway runs in the extension's web worker, with no server, on sql.js persisted in IndexedDB (or DuckDB-Wasm with `osd.web.database`). Available there:
  - the OSD view;
  - F8 Data Preview on TABL/DDLS;
  - SQL notebooks (SQLScript cells on DuckDB);
  - the Fiori launchpad with every tile, in webviews. That covers the Travels/Bookings apps with Create, the analytics apps, SEGW, ICF services, System status, Zork, WEBGUI, System information, the Data browser, Vivid Vibes and LSD with sound, and the content-pack apps.

  Desktop-only: Start/Rebuild, F9, ABAP Unit, the debugger, Check/Activate, jobs.
- New icon and activity-bar glyph: the open-steamgate gear-gate.

- Add the read-only **OSD Jobs** sidebar: status groups, name/user/date filters, step details, job logs, verified saved output and copyable job keys. The jobs status item opens the panel; active jobs refresh through the existing status poll.

- Activation now sends `method=activate`; a server from this release answers activation without it with 400 "Parameter method could not be found.", as an SAP system does. The extension and its bundled server update together.
- Show readable job summaries by default, with newest runs first, durations, counts and failure reasons. Keep worker JSON behind **Show raw job log**.

- Add **OSD: Open sample** in the command palette, walkthrough, and status actions: bundled notebooks plus the osg-demo hello class when present, with an offer to start the system.

- Label system state, serving generation, and job worker status separately. System and jobs status clicks offer state-specific start actions and the overview; hide jobs when disabled or unsupported.

- Start and supervise background job workers with the local system (`osd.jobs.worker`), with an OSD jobs status bar and the OSD: Jobs output channel. The default SQLite file database runs jobs without a terminal.
- SAP kernel rejections now appear as red squiggles while typing, with a Problems link to the support section. `osg.kernelStrict` defaults to `error` and allows runs; choose `warning`, `off`, or `refuse` (also stops object runs and tests). Desktop VSIX installs include the scanner and its dependencies.
- Variables, Watch and hover in ABAP debug sessions now show ABAP values and types, structure components, table rows (first 100), reference targets and object attributes instead of runtime wrapper fields.
- Automatically connect **OSD (local)** in the ABAP-FS API v2 fork with a fresh per-start bearer token and no password prompt; withdraw it on Stop. Marketplace ABAP-FS gets a remembered, one-time offer to add a local settings entry without a saved password. Passwordless auto-connect needs the fork until API v2 is upstream.

- Fix (0.5.1467 regression): **Run as ABAP Application with debugger** and **Attach debugger and call** stop again at a bound breakpoint when the serving process runs a generation other than the live one (a build ahead of the recycle, a warm swap). The debugger reads source maps from the whole `build/` again; it still predicts breakpoints in the live generation only.
- Fix (0.5.1467 regression): the wait for verified breakpoints asked only js-debug's attach session, which never verifies one, so both commands gave up after 15 s and dropped the run or the call without a word. The wait now asks the target's child session too, matches breakpoints by path, real path or ABAP object, and on giving up runs anyway. **Attach debugger and call** no longer asks "Continue without stopping?" and waits for an answer; it says so and calls. Every attach step is logged to the **OSD: System log** channel.
- Show DPC_EXT entity-set redefinitions and their source lines on service Details, using the same owner lookup as the HTTP lens; count services registered directly to a class in its readers lens.
- Register `.abap` as ABAP with breakpoint support, so VS Code accepts breakpoint toggles in a fresh profile.
- Refresh the Test Explorer and test-count lenses after Start and workspace layer changes.
- The Test Explorer runs ABAP Unit by `RISK LEVEL`: HARMLESS objects in parallel (longest `DURATION` first), the rest one at a time after them; an undeclared level counts as DANGEROUS. A HARMLESS class that reaches a database write is warned about on its `RISK LEVEL` line and runs alone, and one that writes anyway fails with "RISK LEVEL HARMLESS but wrote to <table>". Cancel now stops the test run in flight.
- Debugging switches itself on; `osd.debug` is gone. A breakpoint in an `.abap` file or **Run with debugger** opens the running system's inspector (127.0.0.1 only) and attaches, with no restart; once no `.abap` breakpoint is left and the debug session has ended, it is closed again. `OSD_INSPECT=1` opens it at start, and an existing `"osd.debug": true` is still read for one release.
- The OSD tree opens its pages inside VS Code by default (the Fiori Launchpad, apps, services, `$metadata`, the `/osd/*` endpoints): one tab per page, reused on a second click. The launchpad, endpoint and service nodes have an inline link-external action, and every page node an "... in External Browser" context item, for the system browser. `osd.openIn: browser` restores the old default. The System overview's launchpad button and the details panel's `$metadata` link follow the same rule; page tabs close on Stop and reload after a rebuild.
- Stop (and Rebuild) no longer warn "the system stopped unexpectedly": a stop you asked for logs `--- osd stopped ---`, and only an exit nobody asked for warns.
- Add **osd: Generate taxi data...** and **osd: Reset taxi data to minimal**, also on the taxi data service in the OSD tree: the system no longer makes taxi sample rows at start.
- Ship the bundled system's cross-reference rows with its prebuilt generation, so the first start seeds them from a file instead of parsing the tree (5.1 s -> 0.1 s measured).
- Ship the bundled system's generation prebuilt, so the first start reuses it instead of transpiling (build step 21.7 s -> 0.35 s measured; first start 35 s -> 14 s).
- Warn when a breakpoint is set in an `.abap` file the running system does not run (another checkout, the bundled copy, or an overridden object), and offer to open the copy that runs.
- Add a Marketplace build profile with staged third-party notices and no web extension entry. The sample interactive-fiction pack now uses a story rebuilt from an MIT source release.
- Add publisher metadata, Marketplace README, screenshots, and optional prerelease manifest property.
