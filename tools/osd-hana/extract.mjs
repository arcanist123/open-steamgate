// `osd hana extract --out <dir>`: your own code out of a HANA database into an
// abapGit-layout repository, read-only, through the sidecar -- this code never
// sends a statement to the database, opens no socket, and never sees the
// password on argv or in a log (the password reaches the sidecar's
// environment only).
//
//   1. scope     -- the SIDECAR's customer/sap classification (never a second
//                   rule here); local packages included by default (`--no-local`
//                   turns them off), narrowed by --package/--name/--author;
//                   SAP-delivered objects only with --include-sap AND an
//                   explicit --package/--name (then the output directory must
//                   not be inside a git working tree, and the report and the
//                   console carry the notice that this content is the
//                   vendor's). Table CONTENTS are not extracted; the `tables`
//                   request field stays reserved.
//   2. plan      -- `list`, then a per-type / per-package table with counts
//                   and byte estimates and what will be skipped as
//                   unsupported. --dry-run stops here. --json prints the plan
//                   as JSON.
//   3. dump      -- the schema-1 request, restartable: an existing dump whose
//                   manifest echoes the same request and whose sidecar exit
//                   was 0 is reused; anything else is refused, never mixed.
//   4. convert   -- the abapGit-layout repository in <out> (see ./convert/).
//   5. report    -- <out>/extract-report.json and .md, always written.
//
// Exit codes: 0 everything in scope written; 3 partial (something written
// partially, skipped or unsupported -- the report says what); 1 usage; 2
// connection; 4 refused output directory; 5 no ABAP schema; 6 internal error
// (a conversion/write failure or the ledger invariant -- a best-effort report
// is still written and names the failure; never an uncaught crash).
import fs from "node:fs/promises";
import path from "node:path";
import {collectConnection, parseFlags, UsageError} from "./connect.mjs";
import {Sidecar, HandshakeError, SidecarVerifyError, handshake, locateSidecar, loadPin, verifySidecar, resetVerifiedSidecars, DEFAULT_PIN_PATH} from "./sidecar.mjs";
import {convert, SUPPORTED_TYPES} from "./convert/convert.mjs";
import {renderMdReport, planDocuments} from "./report.mjs";

export const EXTRACT_EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  connection: 2,
  partial: 3,
  refusedOut: 4,
  noAbapSchema: 5,
  internal: 6,
});

const VALUE_FLAGS = ["host", "port", "database", "user", "schema", "env-file", "out", "dump-dir", "package", "name", "author", "sidecar-pin"];
const REPEATABLE = ["package", "name"];
const BOOLEAN_FLAGS = ["password-stdin", "json", "no-local", "inactive", "include-sap", "dry-run", "allow-unpinned-sidecar", "help"];
// the capabilities extract needs from the sidecar (contract W0)
const NEEDED_CAPABILITIES = ["list", "dump", "local", "packages", "names", "inactive", "catalog", "ddic"];

const USAGE = `Usage: osd hana extract --out <dir> [--dump-dir <dir>]
                        [--package <pattern>]... [--name <pattern>]...
                        [--author <user>] [--no-local] [--inactive]
                        [--include-sap] [--dry-run] [--json]
                        connection flags as the doctor's (--host --port
                        --database --user --schema --env-file
                        --password-stdin --allow-unpinned-sidecar)

Extracts your own ABAP code out of a HANA database into an abapGit-layout
repository (an .abapgit.xml and src/), reading ONLY through the sidecar
binary osd-hana-dump (read-only by construction). The scope is the sidecar's
customer classification, local packages included; --package/--name/--author
narrow it, --no-local leaves local packages out. SAP-delivered objects are
extracted only with --include-sap together with an explicit --package or
--name; that content is the vendor's and must not be published. Table
contents are not extracted.

The plan (a per-type and per-package table) is printed first; --dry-run
stops after it. The dump lands in <out>/.osd-hana/dump (or --dump-dir) and
is reused when its manifest echoes the same request. The report is written
to <out>/extract-report.json and extract-report.md.

Exit codes: 0 everything in scope written; 3 partial (something written
partially, skipped or unsupported -- the report says what); 1 usage; 2 cannot
connect; 4 refused output directory; 5 no ABAP schema; 6 internal error (the
report, best effort, is written anyway and names the failure).`;

export async function extractMain(argv, {
  io = {out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`)},
  env = process.env,
  stdin = process.stdin,
  isTTY = Boolean(stdin?.isTTY),
  callerPath,
  pinFile, // the TRUSTED seam for the embedding host / tests to name a pin file; the CLI flag --sidecar-pin is a public input and never 'pins' by itself (critic S-E, SHOULD-2 round 2)
  dumpChunkSize, // the test seam: how many names one dump request may carry (the CLI uses the default, 500)
  sidecarTimeoutMs = 600_000,
  // the test seam: extra child-env for the sidecar (the FAKE sidecar's
  // scenario knobs reach the child only through it -- the child env is the
  // core's minimal allowlist, the parent's environment never leaks). The CLI
  // never sets it.
  sidecarExtraEnv,
  now = () => new Date(),
} = {}) {
  resetVerifiedSidecars();
  const started = now().getTime();
  let flags;
  try {
    flags = parseFlags(argv, {valueFlags: VALUE_FLAGS, booleanFlags: BOOLEAN_FLAGS, repeatable: REPEATABLE}).flags;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return EXTRACT_EXIT.usage;
    }
    throw error;
  }
  const fail = (message) => {
    io.err(message);
    return EXTRACT_EXIT.usage;
  };
  if (flags.help === true) {
    io.out(USAGE);
    return EXTRACT_EXIT.ok;
  }
  for (const required of ["out"]) {
    if (typeof flags[required] !== "string" || flags[required] === "") {
      return fail(`osd hana extract: --out is required (the repository and the report are written there)\n\n${USAGE}`);
    }
  }
  const out = path.resolve(flags.out);
  const dumpDir = flags["dump-dir"] !== undefined ? path.resolve(flags["dump-dir"]) : path.join(out, ".osd-hana", "dump");

  // --include-sap only together with an explicit --package/--name
  const hasExplicitSelection = (flags.package?.length ?? 0) > 0 || (flags.name?.length ?? 0) > 0;
  if (flags["include-sap"] === true && !hasExplicitSelection) {
    return fail("osd hana extract: --include-sap needs an explicit --package or --name (vendor content is never extracted wholesale)");
  }

  // ---- one rule for every directory this run writes (critic M3 + S2) -------
  // Judged on the REAL locations: symlinks are resolved first, so a symlinked
  // <out> or --dump-dir pointing into a git working tree still counts.
  // --out naming an existing FILE is a usage error, said -- not an uncaught
  // ENOTDIR out of readdir deep in the run (critic S3)
  try {
    if (!(await fs.lstat(out)).isDirectory()) {
      return fail(`osd hana extract: --out names an existing file: ${out} -- a directory is required`);
    }
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  const realOut = await realResolve(out);
  const realDump = await realResolve(dumpDir);
  const explicitDumpDir = flags["dump-dir"] !== undefined;
  // the dump is raw output too: it may not BE the repository or sit inside it
  // (the raw jsonl would mix into the tree a user later commits)
  if (explicitDumpDir && (realDump === realOut || isInside(realDump, realOut))) {
    io.err(`osd hana extract: refusing the dump directory ${dumpDir}: it is the output directory or inside the output -- the raw dump would mix into the repository.`);
    return EXTRACT_EXIT.refusedOut;
  }
  // --include-sap: the vendor's bytes must not land inside a git working
  // tree -- neither the repository nor the dump that carries them verbatim
  if (flags["include-sap"] === true) {
    const outTree = await inGitTree(realOut);
    if (outTree) {
      io.err(`osd hana extract: refusing ${out}: it is inside the git working tree ${outTree} -- vendor content must not be published.`);
      return EXTRACT_EXIT.refusedOut;
    }
    const dumpTree = await inGitTree(realDump);
    if (dumpTree) {
      io.err(`osd hana extract: refusing the dump directory ${dumpDir}: it is inside the git working tree ${dumpTree} -- vendor content must not be published.`);
      return EXTRACT_EXIT.refusedOut;
    }
  }

  // ---- sidecar: locate, verify, handshake --------------------------------
  let sidecarPath;
  try {
    sidecarPath = locateSidecar({env, callerPath});
  } catch (error) {
    return fail(error.message);
  }
  let pin;
  let foreignPin = false;
  try {
    // Two ways to name a pin: `pinFile`, the trusted seam the embedding host
    // (the extension, the tests) uses to substitute its own pin; and the CLI
    // flag --sidecar-pin, a public input. A pin file that is not the module's
    // own sidecar.lock.json never makes a binary 'pinned' -- it can check
    // bytes, but every pinned claim stays false and the run needs
    // --allow-unpinned-sidecar (critic S-E; extract takes the doctor core's
    // rule, not a re-implementation -- SHOULD-2 round 2).
    const pinPath = pinFile ?? flags["sidecar-pin"] ?? DEFAULT_PIN_PATH;
    pin = loadPin(pinPath);
    foreignPin = pinFile === undefined && path.resolve(pinPath) !== path.resolve(DEFAULT_PIN_PATH);
  } catch (error) {
    return fail(error.message);
  }
  let verified;
  try {
    verified = await verifySidecar(sidecarPath, {
      pin,
      allowUnpinned: flags["allow-unpinned-sidecar"] === true,
      foreignPin,
      loud: (line) => io.err(line.trimEnd()),
    });
  } catch (error) {
    return fail(error.message);
  }
  let handshakeInfo;
  try {
    handshakeInfo = await handshake(sidecarPath, {requiredCapabilities: NEEDED_CAPABILITIES, pin: verified.pinned ? pin : undefined, env, extraEnv: sidecarExtraEnv});
  } catch (error) {
    if (error instanceof HandshakeError) return fail(error.message);
    return fail(`osd hana: the sidecar handshake could not run: ${error.message}`);
  }

  // ---- connection ---------------------------------------------------------
  let connection;
  try {
    connection = await collectConnection({flags, env, stdin, isTTY});
  } catch (error) {
    if (error instanceof UsageError) return fail(`osd hana: ${error.message.replace(/^osd hana: /, "")}`);
    return fail(`osd hana: taking the password failed: ${error.message}`);
  }

  // ---- the request (schema 1) --------------------------------------------
  const request = {
    schema: 1,
    ...(flags.package?.length ? {packages: [...flags.package]} : {}),
    ...(flags.name?.length ? {names: [...flags.name]} : {}),
    ...(flags["no-local"] === true
      ? {}
      : {local: flags.author !== undefined ? {authors: [flags.author]} : {all: true}}),
    inactive: flags.inactive === true,
    catalog: true,
    ddic: true,
    provenance: "osd hana extract", // stable: the reuse fingerprint is the whole request, so nothing per-run may enter it
  };

  const sidecar = new Sidecar(sidecarPath, {
    credentials: {user: connection.user, password: connection.password, host: connection.host, schema: connection.schema},
    timeoutMs: sidecarTimeoutMs,
    onStderr: (text) => io.err(text.trimEnd()),
    env,
    extraEnv: sidecarExtraEnv,
    // A pin in play means every spawn re-verifies the bytes first (fresh,
    // uncached -- Sidecar's default, the doctor's wiring): between the initial
    // verify and the list/dump spawns sits the whole plan print, and a swap in
    // that window must not run unaudited bytes under the cached verdict
    // (critic S-3). The binary is ~7 MB; a fresh sha256 read is milliseconds.
    pin,
    allowUnpinned: flags["allow-unpinned-sidecar"] === true,
    foreignPin,
    loud: (line) => io.err(line.trimEnd()),
  });

  // the output directory must be fresh (only our own work area may exist)
  const existing = await freshOutEntries(out);
  if (existing.length > 0) {
    io.err(`osd hana extract: refusing a non-empty output directory: ${out} holds ${existing.join(", ")}`);
    return EXTRACT_EXIT.refusedOut;
  }
  const listDir = path.join(out, ".osd-hana", "list");
  await fs.mkdir(path.join(out, ".osd-hana"), {recursive: true});
  // M-2: the raw dump never belongs in the repository -- <out> is an
  // abapGit-layout repository a user will `git add .` in, so the work area is
  // ignored by name the moment it exists
  await fs.writeFile(path.join(out, ".gitignore"), ".osd-hana/\n");
  // the listing is derived data of this very request; the sidecar refuses a
  // non-empty --out, so a restart clears it (the DUMP is the artefact that is
  // never thrown away -- reusableDump below decides over that one)
  await fs.rm(listDir, {recursive: true, force: true});

  // ---- 1+2: list + plan ----------------------------------------------------
  const requestPath = path.join(out, ".osd-hana", "request.json");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 1)}\n`);
  const listRun = await runVerb(sidecar, "list", {requestPath, out: listDir, fail, connection});
  if (typeof listRun === "number") return listRun;
  const listed = await readJsonl(path.join(listDir, "objects.jsonl"));
  if (listed.length === 0) {
    // an EMPTY SELECTION is not "no ABAP schema" (N3): the schema is there,
    // the narrowing simply matched nothing -- a usage answer, not a verdict
    // about the database
    return fail("osd hana extract: the selection matched no objects -- widen --package/--name or drop --no-local (there IS an ABAP schema; it just holds nothing in this scope).");
  }

  const author = flags.author;
  const byAuthor = (r) => author === undefined || String(r.author ?? "").trim().toUpperCase() === author.toUpperCase();
  // M-1 (critic round 2): the scope fails CLOSED. Only the sidecar's exact
  // customer class is in scope -- a missing, unknown or differently-cased
  // class is NOT customer and is never trusted in the unsafe direction.
  // --include-sap admits the exact sap class; it never admits the unknown.
  // A sap row without the flag is the sidecar's own exclusion -- not unknown,
  // deliberately out of scope, counted in the plan's sap column.
  const isKnownClass = (r) => r.class === "customer" || r.class === "sap";
  const isClassified = (r) => r.class === "customer" || (flags["include-sap"] === true && r.class === "sap");
  const inScopeRows = listed.filter(isClassified).filter(byAuthor);
  const unknownClassRows = listed.filter((r) => !isKnownClass(r)).filter(byAuthor);
  const scopeIds = new Set([...inScopeRows, ...unknownClassRows].map((r) => `${r.type}:${r.name}`));
  if (scopeIds.size === 0) {
    return fail("osd hana extract: nothing is in scope after the narrowing flags -- nothing to extract.");
  }
  if (unknownClassRows.length > 0) {
    io.err(`osd hana extract: ${unknownClassRows.length} listed objects have an unknown classification and were left out -- only the sidecar's exact customer class is in scope; the sidecar may be newer than this module.`);
  }

  const plan = buildPlan(inScopeRows, listed, unknownClassRows);
  if (flags.json === true) {
    io.out(JSON.stringify(planDocuments({plan, request, sidecar: describeSidecar(verified, handshakeInfo), out, dumpDir}), null, 1));
  } else {
    printPlan(io, plan);
  }
  if (flags["dry-run"] === true) return EXTRACT_EXIT.ok;

  // ---- 3: dump -------------------------------------------------------------
  // M-2 (critic round 2): nothing of the vendor's is fetched unless asked.
  // The dump request NAMES the in-scope objects -- exact names, LIKE-escaped
  // (the sidecar matches `LIKE ? ESCAPE '\'`), sorted, chunked -- built from
  // the listing, never from the user's patterns; the unknown-class rows are
  // not fetched at all. The sidecar has no per-type objects field yet (its
  // schema-1 request takes names/packages/local only -- measured on the
  // binary, "json: unknown field \"objects\""), so exact names are what the
  // schema can carry; the post-dump audit below catches anything else.
  const exactNamePattern = (name) => String(name).trim().replace(/([%_\\])/g, "\\$1");
  const chunkSize = typeof dumpChunkSize === "number" && dumpChunkSize > 0 ? dumpChunkSize : 500;
  const dumpNames = [...new Set(inScopeRows.map((r) => String(r.name).trim().toUpperCase()))].sort().map(exactNamePattern);
  const dumpRequest = {
    schema: 1,
    names: dumpNames,
    inactive: flags.inactive === true,
    catalog: true,
    ddic: true,
    provenance: "osd hana extract",
  };
  const dumpRequestPath = path.join(out, ".osd-hana", "dump-request.json");
  const reused = await reusableDump(dumpDir, dumpRequest);
  let dumpErrors = [];
  let dumpParts;
  if (reused.ok) {
    io.err(`osd hana extract: reusing the existing dump in ${dumpDir} (same request, sidecar exit 0)`);
    if (Array.isArray(reused.errors)) dumpErrors = reused.errors;
  } else if (reused.exists) {
    return fail(`osd hana extract: refusing the dump directory ${dumpDir}: ${reused.why}\n` +
      "  A dump is never mixed. Remove the directory or pass --dump-dir.");
  } else if (dumpNames.length === 0) {
    // everything in scope is unknown-class: nothing to fetch (and the sidecar
    // refuses an empty name list) -- the conversion below skips everything
    await fs.rm(dumpDir, {recursive: true, force: true});
  } else {
    const chunks = [];
    for (let i = 0; i < dumpNames.length; i += chunkSize) chunks.push(dumpNames.slice(i, i + chunkSize));
    if (chunks.length === 1) {
      await fs.writeFile(dumpRequestPath, `${JSON.stringify(dumpRequest, null, 1)}\n`);
      const dumpRun = await runVerb(sidecar, "dump", {requestPath: dumpRequestPath, out: dumpDir, fail, connection});
      if (typeof dumpRun === "number") return dumpRun;
    } else {
      // one request per chunk, one directory per chunk: the sidecar refuses a
      // non-empty --out, and its name IN-lists must stay under the SQL
      // parameter limit (measured: ~4e4 parameters fail, w3 report #4)
      dumpParts = [];
      for (const [n, chunk] of chunks.entries()) {
        const part = `part-${String(n + 1).padStart(5, "0")}`;
        const partDir = path.join(dumpDir, part);
        await fs.rm(partDir, {recursive: true, force: true});
        const partRequest = {...dumpRequest, names: chunk};
        const partRequestPath = path.join(out, ".osd-hana", `dump-request-${part}.json`);
        await fs.writeFile(partRequestPath, `${JSON.stringify(partRequest, null, 1)}\n`);
        const dumpRun = await runVerb(sidecar, "dump", {requestPath: partRequestPath, out: partDir, fail, connection});
        if (typeof dumpRun === "number") return dumpRun;
        const partManifest = JSON.parse(await fs.readFile(path.join(partDir, "manifest.json"), "utf8"));
        dumpParts.push(part);
        dumpErrors.push(...(partManifest.sidecar?.errors ?? []));
      }
      // the aggregate manifest is what reuse and the converter read: same
      // sidecar block shape as a single dump, `parts` naming the directories
      const first = JSON.parse(await fs.readFile(path.join(dumpDir, dumpParts[0], "manifest.json"), "utf8"));
      const sidecarBlock = first.sidecar ?? {};
      await fs.writeFile(path.join(dumpDir, "manifest.json"), `${JSON.stringify({
        tool: sidecarBlock.name ?? "osd-hana-dump",
        provenance: "osd hana extract",
        request: dumpRequest,
        sidecar: {
          name: sidecarBlock.name ?? "osd-hana-dump",
          version: sidecarBlock.version,
          commit: sidecarBlock.commit,
          request: dumpRequest,
          counts: {package_objects: dumpNames.length},
          errors: dumpErrors,
          parts: dumpParts,
          objects_report: "part-*/objects.jsonl",
        },
      }, null, 1)}\n`);
    }
  }

  // ---- 4: convert ----------------------------------------------------------
  // the derived repository is refreshed from what THIS run writes: a restart
  // over a drifted dump must not leave stale files behind (they would claim
  // content the run did not produce)
  await fs.rm(path.join(out, "src"), {recursive: true, force: true});
  await fs.rm(path.join(out, ".abapgit.xml"), {force: true});
  const dumpManifest = JSON.parse(await fs.readFile(path.join(dumpDir, "manifest.json"), "utf8"));
  // the dump holds every object of the request; the sidecar counts DDIC
  // objects as "rows", so the object total is its own package_objects
  const dumpedCount = dumpManifest.counts?.package_objects ?? dumpManifest.sidecar?.counts?.package_objects;
  const dumpRoots = (dumpManifest.sidecar?.parts ?? []).map((p) => path.join(dumpDir, p));
  const dumpObjects = [];
  for (const root of dumpRoots.length > 0 ? dumpRoots : [dumpDir]) {
    dumpObjects.push(...await readJsonl(path.join(root, "objects.jsonl")));
  }
  // ---- M-2: the dump delivers exactly the scope, or the run stops ----------
  // A source the dump fetched although nothing in scope names it is the
  // vendor's code landing on disk: the run refuses, names the dump directory
  // (remove it), and writes nothing. Excluded closure rows (the sidecar's
  // skipped DDIC metadata around the requested objects) are not sources and
  // do not trip the audit.
  const norm = (v) => String(v ?? "").trim().toUpperCase();
  const scopeSet = new Set(inScopeRows.map((r) => `${norm(r.type)}:${norm(r.name)}`));
  const carriesSource = (r) => (Array.isArray(r.files) && r.files.length > 0)
    || ["w", "written"].includes(String(r.status ?? "").trim().toLowerCase());
  const outOfScope = dumpObjects.filter((r) => !scopeSet.has(`${norm(r.type)}:${norm(r.name)}`) && carriesSource(r));
  if (outOfScope.length > 0) {
    const list = outOfScope.slice(0, 8).map((r) => `${norm(r.type)}:${norm(r.name)}`).join(", ");
    io.err(`osd hana extract: refusing the dump directory ${dumpDir}: it carries ${outOfScope.length} objects outside the scope (${list}${outOfScope.length > 8 ? ", ..." : ""})`
      + " -- the dump was to fetch exactly the in-scope objects, so this is not ours to keep. Remove the dump directory (or pass --dump-dir) and re-run. Nothing was written.");
    try {
      await writeReport(out, {
        schema: 1, out, dump_dir: dumpDir, request: dumpRequest,
        sidecar: describeSidecar(verified, handshakeInfo),
        folder_logic: {logic: "unknown", folders: []},
        plan, totals: totals(plan, [], dumpedCount, undefined),
        objects: [], errors: [{error: `the dump carries ${outOfScope.length} objects outside the scope: ${list}`}],
        duration_ms: now().getTime() - started,
        notice: flags["include-sap"] === true ? "This extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it." : undefined,
      });
    } catch { /* the refusal itself must not be masked by a report problem */ }
    return EXTRACT_EXIT.refusedOut;
  }
  // of the dump's own object list, how many this run's scope covers (N2: the
  // dump total also counts SAP-class objects a narrow scope excluded)
  const inScopeDumpRow = (r) => (r.class !== "sap" || flags["include-sap"] === true)
    && (author === undefined || String(r.author ?? "").trim().toUpperCase() === author.toUpperCase());
  const dumpedInScope = dumpObjects.filter(inScopeDumpRow).length;
  // ---- S4: the reused dump's object list vs the live listing ---------------
  // Chosen design (the alternative -- refusing the restart -- is rejected in
  // REPORT.md): the LIVE LISTING stays authoritative for scope -- the plan
  // promised exactly those objects and the ledger must account for them --
  // while the reused dump is the truth for their CONTENT. Objects the live
  // listing has and the dump lacks become ledger-skipped not-in-dump lines
  // (nothing vanishes silently); objects the dump has but the listing no
  // longer does are NOT written -- a restart must not resurrect deleted code
  // -- and every difference is reported here as drift.
  let drift;
  if (reused.ok) {
    const dumpIds = new Set(dumpObjects.filter(inScopeDumpRow).map((r) => `${r.type}:${r.name}`));
    const listedIds = new Set(inScopeRows.map((r) => `${r.type}:${r.name}`));
    const appeared = [...listedIds].filter((id) => !dumpIds.has(id)).sort();
    const disappeared = [...dumpIds].filter((id) => !listedIds.has(id)).sort();
    if (appeared.length > 0 || disappeared.length > 0) drift = {appeared, disappeared};
  }
  let conversion;
  let ledgerAtFailure; // the S3 promise: even a mid-run failure keeps its ledger for the report
  try {
    conversion = await convert({dump: dumpDir, out, listed: inScopeRows, preSkipped: unknownClassRows, roots: dumpRoots.length > 0 ? dumpRoots : undefined, onLedger: (l) => { ledgerAtFailure = l; }});
  } catch (error) {
    const entries = ledgerAtFailure?.entries ?? [];
    const reportDoc = {
      schema: 1,
      out,
      dump_dir: dumpDir,
      dump_reused: reused.ok === true,
      request,
      sidecar: describeSidecar(verified, handshakeInfo),
      folder_logic: {logic: "unknown", folders: []},
      plan,
      totals: totals(plan, entries, dumpedCount, dumpedInScope),
      objects: entries,
      errors: [{error: error.message}],
      internal_error: `converting the dump failed: ${error.message}`,
      duration_ms: now().getTime() - started,
      notice: flags["include-sap"] === true
        ? "This extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it."
        : undefined,
    };
    await writeReport(out, reportDoc);
    io.err(`osd hana extract: converting the dump failed: ${error.message} -- exit ${EXTRACT_EXIT.internal} (internal error; a best-effort report is at ${path.join(out, "extract-report.md")})`);
    return EXTRACT_EXIT.internal;
  }

  // ---- 5: report -----------------------------------------------------------
  const durationMs = now().getTime() - started;
  const totalsDoc = totals(plan, conversion.entries, dumpedCount, dumpedInScope);
  const reportDoc = {
    schema: 1,
    out,
    dump_dir: dumpDir,
    dump_reused: reused.ok === true,
    request,
    sidecar: describeSidecar(verified, handshakeInfo),
    folder_logic: {logic: conversion.folderLogic, folders: conversion.folders},
    plan,
    totals: totalsDoc,
    objects: conversion.entries,
    errors: conversion.errors,
    empty_sources: conversion.emptySources,
    drift,
    unknown_class: unknownClassRows.length,
    duration_ms: durationMs,
    notice: flags["include-sap"] === true
      ? "This extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it."
      : undefined,
  };
  // the M1 backstop, structural: exit 0 is refused unless the ledger accounts
  // for exactly the listing's in-scope count -- totals that do not add up are
  // an internal error, never a silently wrong report
  if (conversion.unaccounted.length > 0 || totalsDoc.accounts !== true) {
    reportDoc.ledger_error = `the ledger accounts for ${conversion.entries.length - conversion.unaccounted.length} of ${plan.inScope} in-scope objects`;
  } else {
    reportDoc.sentence = sentence(totalsDoc);
  }
  await writeReport(out, reportDoc);

  if (flags["include-sap"] === true) io.out("NOTICE: this extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it.");
  io.out(`extract-report: ${path.join(out, "extract-report.md")}`);
  io.out(reportDoc.sentence ?? reportDoc.ledger_error);
  if (reportDoc.ledger_error !== undefined) return EXTRACT_EXIT.internal;
  return reportDoc.totals.written === reportDoc.totals.inScope ? EXTRACT_EXIT.ok : EXTRACT_EXIT.partial;
}

// ---- helpers ---------------------------------------------------------------

async function runVerb(sidecar, verb, {requestPath, out, fail, connection}) {
  // host/port/database and an explicit ABAP schema are the connection flags;
  // user and password travel in the child's environment only (the Sidecar)
  const args = ["--request", requestPath, "--out", out, "--host", connection.host, "--port", String(connection.port)];
  if (connection.database !== undefined) args.push("--database", connection.database);
  if (connection.schema !== undefined) args.push("--abap-schema", connection.schema);
  let run;
  try {
    run = await sidecar.run(verb, {args});
  } catch (error) {
    if (error instanceof SidecarVerifyError) {
      // The re-verification immediately before the spawn refused (a swap in
      // the window after the first verify): a setup failure, not a connect
      // problem -- the message names both hashes.
      return fail(error.message);
    }
    // A timeout or a child that could not start: cannot-connect, not usage --
    // the binary itself was verified and hand-shaken.
    fail(error.message);
    return EXTRACT_EXIT.connection;
  }
  switch (run.outcome) {
    case "done":
    case "partial": // the manifest carries the per-object reasons; the report accounts for them
      return run;
    case "connection":
      fail(`osd hana: cannot connect or log on: ${run.summary.error ?? "the sidecar said so"}`);
      return EXTRACT_EXIT.connection;
    case "unsupported":
      fail(`osd hana: no ABAP schema found on this database${run.summary.error ? ` (${run.summary.error})` : ""} -- there is no ABAP code to extract here.`);
      return EXTRACT_EXIT.noAbapSchema;
    case "refused":
      fail(`osd hana: the sidecar refused: ${run.summary.error ?? "unknown"}`);
      return EXTRACT_EXIT.refusedOut;
    case "usage":
      return fail(`osd hana: the sidecar refused the ${verb} as a usage error: ${run.summary.error ?? "unknown"}`);
    default:
      return fail(`osd hana: unmapped sidecar outcome: ${run.outcome}`);
  }
}

/** Restart rule: an existing dump whose manifest echoes the same request and
 *  whose sidecar exit was 0 (no errors in the manifest block) is reused;
 *  anything else is refused, never mixed. The echo is compared on the
 *  request's SELECTION (schema, flags, provenance -- canonically, so key
 *  order of a re-writing sidecar cannot refuse a reuse, NOTE-6): the explicit
 *  `names` are derived from the live listing and may drift between runs --
 *  the drift logic (S4) reports what that means for the content. A chunked
 *  dump's aggregate manifest must list parts that are all readable. */
export function dumpRequestFingerprint(request) {
  const {names, ...rest} = request ?? {};
  return stableStringify(rest);
}

function stableStringify(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export async function reusableDump(dumpDir, request) {
  let raw;
  try {
    raw = await fs.readFile(path.join(dumpDir, "manifest.json"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {exists: false, ok: false};
    return {exists: true, ok: false, why: `the manifest is unreadable (${e.message})`};
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return {exists: true, ok: false, why: `the manifest is not JSON (${e.message})`};
  }
  const block = manifest.sidecar;
  if (block === undefined) return {exists: true, ok: false, why: "the manifest has no sidecar block (an old or partial dump)"};
  if (dumpRequestFingerprint(block.request ?? null) !== dumpRequestFingerprint(request)) {
    return {exists: true, ok: false, why: "its manifest echoes a different request"};
  }
  if ((block.errors?.length ?? 0) > 0) return {exists: true, ok: false, why: `its manifest carries ${block.errors.length} errors`};
  if (block.counts === undefined) return {exists: true, ok: false, why: "the manifest carries no counts (the dump did not finish)"};
  for (const part of block.parts ?? []) {
    try {
      await fs.access(path.join(dumpDir, part, "objects.jsonl"));
    } catch {
      return {exists: true, ok: false, why: `its part ${part} is missing (a partial chunked dump)`};
    }
  }
  return {exists: true, ok: true, errors: block.errors ?? []};
}

async function readJsonl(file) {
  const out = [];
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line));
  return out;
}

async function freshOutEntries(out) {
  let entries;
  try {
    entries = await fs.readdir(out);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  // entries this command itself may have written (a restart over a previous
  // extraction of the same scope); anything else means the directory is in use
  const ours = new Set([".osd-hana", ".abapgit.xml", ".gitignore", "src", "extract-report.json", "extract-report.md"]);
  return entries.filter((e) => !ours.has(e));
}

// The enclosing git working tree (directory or gitfile), or undefined.
export async function inGitTree(dir) {
  let p = path.resolve(dir);
  for (;;) {
    try {
      const st = await fs.lstat(path.join(p, ".git"));
      if (st.isFile() || st.isDirectory()) return p;
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    const q = path.dirname(p);
    if (q === p) return undefined;
    p = q;
  }
}

// Resolve symlinks (critic M3/S2: the directory rules judge the REAL
// location, not the spelling): a trailing component that does not exist yet
// resolves through its nearest existing ancestor.
export async function realResolve(p) {
  try {
    return await fs.realpath(p);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  return path.join(await realResolve(path.dirname(p)), path.basename(p));
}

// Is `child` `parent` itself or one of its descendants?
export function isInside(child, parent) {
  return child !== parent && child.startsWith(`${parent}${path.sep}`);
}

function buildPlan(rows, allRows, unknownClassRows = []) {
  const perType = new Map();
  const perPackage = new Map();
  const byType = new Map();
  const unknownSet = new Set(unknownClassRows);
  // the unknown-class rows are part of the selection and are accounted in the
  // plan's in-scope counts (the ledger will carry them as skipped), but they
  // contribute no bytes and are never dumped
  for (const r of [...rows, ...unknownClassRows]) {
    const t = perType.get(r.type) ?? {type: r.type, inScope: 0, bytes: 0, unsupported: 0, unknownClass: 0};
    t.inScope++;
    if (!SUPPORTED_TYPES.has(r.type)) t.unsupported++;
    if (unknownSet.has(r)) t.unknownClass++;
    perType.set(r.type, t);
    if (!rows.includes(r)) continue; // per-package/bytes stay classified-only
    t.bytes += Number(r.source_bytes_compressed ?? 0);
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    const p = perPackage.get(r.package) ?? {package: r.package, objects: 0, bytes: 0};
    p.objects++;
    p.bytes += Number(r.source_bytes_compressed ?? 0);
    perPackage.set(r.package, p);
  }
  return {
    onSystem: allRows.length,
    customer: allRows.filter((r) => r.class === "customer").length,
    sap: allRows.filter((r) => r.class === "sap").length,
    unknownClass: unknownClassRows.length,
    inScope: rows.length + unknownClassRows.length,
    perType: [...perType.values()].sort((a, b) => a.type.localeCompare(b.type)),
    perPackage: [...perPackage.values()].sort((a, b) => a.package.localeCompare(b.package)),
    unsupportedTypes: [...perType.values()].filter((t) => t.unsupported > 0).map((t) => t.type),
  };
}

// The totals are computed FROM THE LEDGER (critic M1: never recomputed in a
// way that could mask a gap); the plan carries the in-scope counts and the
// two are asserted equal -- `accounts` is the exit-0 gate.
function totals(plan, entries, dumpedCount, dumpedInScope) {
  const perType = {};
  for (const p of plan.perType) perType[p.type] = {inScope: p.inScope, written: 0, writtenPartial: 0, skipped: 0, unsupported: 0};
  const t = {
    onSystem: plan.onSystem,
    dumped: dumpedCount ?? plan.inScope,
    dumped_in_scope: dumpedInScope,
    inScope: plan.inScope,
    written: 0,
    writtenPartial: 0,
    skipped: 0,
    unsupported: 0,
    perType,
    notExtracted: [],
  };
  const byType = {};
  for (const e of entries) {
    if (e.status === undefined) continue; // the failure path: unresolved yet
    const slot = perType[e.type] ?? {inScope: 0, written: 0, writtenPartial: 0, skipped: 0, unsupported: 0};
    // inScope comes from the plan (the listing); the sum check below is the
    // cross-validation of the ledger against it -- no double counting
    perType[e.type] = slot;
    if (e.status === "written") {
      t.written++;
      slot.written++;
    } else if (e.status === "written-partial") {
      t.writtenPartial++;
      slot.writtenPartial++;
    } else if (e.status === "unsupported") {
      t.unsupported++;
      slot.unsupported++;
    } else {
      t.skipped++;
      slot.skipped++;
    }
    if (e.status !== "written") {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      t.notExtracted.push({type: e.type, status: e.status});
    }
  }
  t.accounts = entries.length === plan.inScope && Object.values(perType).every((v) => v.written + v.writtenPartial + v.skipped + v.unsupported === v.inScope);
  t.notExtracted = Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({type, count}));
  return t;
}

function sentence(t) {
  if (t.writtenPartial + t.skipped + t.unsupported === 0) return `all ${t.inScope} objects in scope were written`;
  const byType = t.notExtracted.map((x) => `${x.type} ${x.count}`).join(", ");
  return `${t.writtenPartial + t.skipped + t.unsupported} objects of ${t.inScope} could not be fully extracted (${byType})`;
}

async function writeReport(out, reportDoc) {
  await fs.writeFile(path.join(out, "extract-report.json"), `${JSON.stringify(reportDoc, null, 1)}\n`);
  await fs.writeFile(path.join(out, "extract-report.md"), renderMdReport(reportDoc));
}

function describeSidecar(verified, handshakeInfo) {
  return {
    path: verified.path,
    pinned: verified.pinned,
    target: verified.target,
    sha256: verified.sha256,
    version: handshakeInfo?.version,
    commit: handshakeInfo?.commit,
    capabilities: handshakeInfo?.capabilities,
  };
}

function printPlan(io, plan) {
  const mb = (b) => `${(b / 1_000_000).toFixed(1)} MB`;
  io.out(`plan: ${plan.inScope} objects in scope (system holds ${plan.onSystem}: ${plan.customer} customer, ${plan.sap} sap)`);
  io.out("  per type:");
  for (const t of plan.perType) {
    const mark = SUPPORTED_TYPES.has(t.type) ? "" : "  (unsupported -- will be listed, not written)";
    io.out(`    ${t.type.padEnd(8)} ${String(t.inScope).padStart(6)}  ${mb(t.bytes).padStart(10)}${mark}`);
  }
  io.out("  per package:");
  for (const p of plan.perPackage) io.out(`    ${p.package.padEnd(32)} ${String(p.objects).padStart(6)}  ${mb(p.bytes).padStart(10)}`);
}
