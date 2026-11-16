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
// Exit codes (fix round 4: "not checked" is not "partial"): 0 everything in
// scope written -- an object whose only gap is a part the dump cannot even
// check (screens, GUI status, variants, component texts, ...) is written,
// carrying its `unchecked` list; 3 partial (a part the dump SHOWS exists was
// not extracted, an object skipped or unsupported, or an error -- the report
// says what); 1 usage; 2 connection; 4 refused output directory; 5 no ABAP
// schema; 6 internal error (a conversion/write failure or the ledger
// invariant -- a best-effort report is still written and names the failure;
// never an uncaught crash).
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";
import {collectConnection, parseFlags, UsageError} from "./connect.mjs";
import {Sidecar, HandshakeError, SidecarVerifyError, handshake, locateSidecar, loadPin, verifySidecar, resetVerifiedSidecars, DEFAULT_PIN_PATH} from "./sidecar.mjs";
import {convert, outOfScopeSourcePrograms} from "./convert/convert.mjs";
import {renderMdReport, planDocuments} from "./report.mjs";
import {buildPlan, printPlan, consentGate, buildDumpRequest, requestedPairs, requestedOf, largePlanNumbers} from "./extract-plan.mjs";
import {sidecarTlsArgs, tlsShapeWithoutEncrypt, TLS_VALUE_FLAGS, TLS_BOOLEAN_FLAGS} from "./tls.mjs";
import {
  dumpRequestFingerprint, reusableDump, readJsonl, foreignOutEntries,
  sha256File, walkFiles, clearUnprotected, writeMarker, ensureGitignoreLine,
} from "./extract-workarea.mjs";
// the restart rule's public seam (the tests import it from here)
export {dumpRequestFingerprint, reusableDump};

export const EXTRACT_EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  connection: 2,
  partial: 3,
  refusedOut: 4,
  noAbapSchema: 5,
  internal: 6,
});

const VALUE_FLAGS = ["host", "port", "database", "user", "schema", "env-file", "out", "dump-dir", "package", "name", "author", "sidecar-pin", ...TLS_VALUE_FLAGS];
const REPEATABLE = ["package", "name"];
const BOOLEAN_FLAGS = ["password-stdin", "json", "no-local", "inactive", "include-sap", "dry-run", "allow-unpinned-sidecar", "yes", "yes-large", "help", ...TLS_BOOLEAN_FLAGS];
// the capabilities extract needs from the sidecar (contract W0)
const NEEDED_CAPABILITIES = ["list", "dump", "local", "packages", "names", "closure", "inactive", "catalog", "ddic"];

const USAGE = `Usage: osd hana extract --out <dir> [--dump-dir <dir>]
                        [--package <pattern>]... [--name <pattern>]...
                        [--author <user>] [--no-local] [--inactive]
                        [--include-sap] [--dry-run] [--json]
                        [--yes] [--yes-large]
                        connection flags as the doctor's (--host --port
                        --database --user --schema --env-file
                        --password-stdin --allow-unpinned-sidecar)
                        [--encrypt | --trust-server-certificate]
                        [--ca-file F] [--tls-server-name N]

Extracts your own ABAP code out of a HANA database into an abapGit-layout
repository (an .abapgit.xml and src/), reading ONLY through the sidecar
binary osd-hana-dump (read-only by construction). The scope is the sidecar's
customer classification, local packages included; --package/--name/--author
narrow it, --no-local leaves local packages out. SAP-delivered objects are
extracted only with --include-sap together with an explicit --package or
--name; that content is the vendor's and must not be published. Table
contents are not extracted.

The plan (per type, per package, per author for local objects, the biggest
packages) is printed first; --dry-run stops after it and never asks. Nothing
is dumped without consent: on a terminal the command asks "extract N objects
(S MB) into <out>?" after the plan; a non-interactive run needs --yes. A plan
above ${largePlanNumbers()} needs --yes-large instead (one --yes is not consent for a
large read). The dump lands in <out>/.osd-hana/dump (or --dump-dir) and is
reused when its manifest echoes the same request; a dump the scope audit
refused is marked refused in its own directory and never reused -- remove it
and re-run. Nothing outside <out>/.osd-hana changes before every refusal is
passed: a refused run leaves the repository as it was, and the audit's
refusal report is <out>/.osd-hana/refused-report.md. A writing run's report
is <out>/extract-report.json and extract-report.md; <out>/.gitignore is
never overwritten (created when absent, the .osd-hana/ line appended when
missing).

TLS: the doctor's flags and rules. --encrypt verifies the server's
certificate (--ca-file / --tls-server-name shape that and need --encrypt);
--trust-server-certificate encrypts without verifying. A TLS ask against a
sidecar without the "tls" capability is refused -- never a clear-text run.

Exit codes: 0 everything in scope written (a part the dump cannot even check
does not count against the object -- it is carried as its 'unchecked' list);
3 partial (a part the dump shows exists was not extracted, an object skipped
or unsupported, or an error -- the report says what); 1 usage; 2 cannot
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

  // TLS: --ca-file / --tls-server-name shape the certificate check, so they
  // need --encrypt (the doctor's rule, tls.mjs) -- refused before anything runs
  if (tlsShapeWithoutEncrypt(flags)) {
    return fail("osd hana extract: --ca-file and --tls-server-name need --encrypt (they shape the certificate check). " +
      "To encrypt WITHOUT certificate validation: --trust-server-certificate alone.");
  }

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

  // ---- TLS: the doctor's flag set and capability rule (tls.mjs) ----------
  const tls = sidecarTlsArgs(flags, handshakeInfo);
  if (tls.refused) {
    return fail(`osd hana extract: this sidecar (${handshakeInfo.version ?? "unknown version"}) does not list the "tls" capability -- ` +
      "it cannot encrypt its connection, and you asked it to (--encrypt / --trust-server-certificate / --ca-file / --tls-server-name).\n" +
      "  Refusing: extract will NOT connect in clear text when TLS was asked for. Use a sidecar build with the tls capability, " +
      "or re-run without the TLS flags on a network you trust.");
  }

  // ---- connection ---------------------------------------------------------
  let connection;
  try {
    connection = await collectConnection({flags, env, stdin, isTTY});
  } catch (error) {
    if (error instanceof UsageError) return fail(`osd hana: ${error.message.replace(/^osd hana: /, "")}`);
    return fail(`osd hana: taking the password failed: ${error.message}`);
  }
  connection = {...connection, tlsArgs: tls.args};

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

  // ---- M-5 (critic round 2): the command never deletes or overwrites what
  // it did not create. A marker file inside .osd-hana/ records that this
  // directory is ours and exactly what we wrote (paths with SHA-256). An
  // <out> that holds anything else is refused (exit 4), NOTHING TOUCHED --
  // including one with only src/ and .abapgit.xml, which the fixed name list
  // used to clean out. On a restart only marker-listed unchanged files are
  // replaced; a file the user changed (or one the marker does not list) is
  // kept and reported, and the object that would overwrite it is refused per
  // object in the ledger.
  const markerPath = path.join(out, ".osd-hana", "marker.json");
  let marker;
  try {
    marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  } catch {
    marker = undefined;
  }
  const claimedOut = marker !== undefined;
  const foreign = await foreignOutEntries(out, claimedOut);
  if (foreign.length > 0) {
    io.err(`osd hana extract: refusing the output directory ${out}: it holds ${foreign.join(", ")}, and ${markerPath} does not exist to say this command created them.`
      + " Choose an empty directory (or restore the marker); nothing was touched.");
    return EXTRACT_EXIT.refusedOut;
  }
  const kept = []; // {path, why} -- never overwritten, reported, protected
  const protectedPaths = new Set();
  if (claimedOut) {
    // the report files are this command's own output (regenerated by every
    // writing run), the .gitignore is only ever appended to (fix round 6);
    // src/ and .abapgit.xml obey the
    // marker: listed and unchanged may be replaced, anything else is kept.
    const listed = new Map((Array.isArray(marker.files) ? marker.files : []).map((f) => [f.path, f.sha256]));
    const protect = (rel, abs) => {
      const why = listed.has(rel)
        ? `it changed since the last run (marker hash ${String(listed.get(rel)).slice(0, 12)}...)`
        : "the marker of the last run does not list it";
      kept.push({path: rel, why});
      protectedPaths.add(rel);
    };
    await walkFiles(path.join(out, "src"), "src", async (rel, abs) => {
      if (!listed.has(rel) || listed.get(rel) !== sha256File(abs)) protect(rel, abs);
    });
    const dotAbapgit = path.join(out, ".abapgit.xml");
    try {
      const rel = ".abapgit.xml";
      if (listed.get(rel) !== sha256File(dotAbapgit)) protect(rel, dotAbapgit);
    } catch { /* not there -- nothing to protect */ }
  }
  const listDir = path.join(out, ".osd-hana", "list");
  await fs.mkdir(path.join(out, ".osd-hana"), {recursive: true});
  // M-2: the raw dump never belongs in the repository -- <out> is an
  // abapGit-layout repository a user will `git add .` in. Fix round 6
  // (CRITIC round 4 MUST-1/SHOULD-1): the work area ignores ITSELF (`*` in
  // its own .gitignore) the moment it exists, so a run that stops before
  // the commit point -- a dry-run, a declined prompt, any refusal -- leaves
  // nothing committable and touches no repository file: `<out>/.gitignore`
  // is the user's or the repository's, and only a WRITING run creates it or
  // appends the `.osd-hana/` line (ensureGitignoreLine, at the commit point).
  await fs.writeFile(path.join(out, ".osd-hana", ".gitignore"), "*\n");
  // Nothing outside the work area changes before the commit point below:
  // listing -> plan -> consent -> dump -> scope audit, and only then the
  // provisional marker, the src/ refresh, the .gitignore line, conversion.
  // A refusal anywhere before it leaves the repository byte-identical.
  // the listing is derived data of this very request; the sidecar refuses a
  // non-empty --out, so a restart clears it (the DUMP is the artefact that is
  // never thrown away -- reusableDump below decides over that one)
  await fs.rm(listDir, {recursive: true, force: true});

  // ---- 1+2: list + plan ----------------------------------------------------
  const requestPath = path.join(out, ".osd-hana", "request.json");
  await fs.writeFile(requestPath, `${JSON.stringify(request, null, 1)}\n`);
  const listRun = await runVerb(sidecar, "list", {requestPath, out: listDir, fail, connection});
  if (typeof listRun === "number") return listRun;
  const listedRaw = await readJsonl(path.join(listDir, "objects.jsonl"));
  // SHOULD-5 (critic round 2): an EXACT duplicate id -- the same object
  // listed twice, e.g. matched by two patterns -- is de-duplicated before
  // the plan counts it. Ids that really differ only by case stay two rows
  // and meet the case-collision rule in the converter.
  const seenListed = new Set();
  const listed = listedRaw.filter((r) => {
    const id = `${r.type}:${r.name}`;
    if (seenListed.has(id)) return false;
    seenListed.add(id);
    return true;
  });
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

  // ---- consent (fix round 3, part B): nothing is dumped without the user
  // having seen the plan. On a terminal the command asks after the plan; a
  // non-interactive run needs --yes; a LARGE plan needs --yes-large instead.
  // --dry-run never reaches this (it returned above), --json does not skip it.
  const consent = await consentGate({flags, io, stdin, isTTY, plan, out});
  if (consent === "declined") return EXTRACT_EXIT.ok;
  if (consent === "refused") return EXTRACT_EXIT.usage;

  // ---- 3: dump -------------------------------------------------------------
  // M-2 (critic round 2): nothing of the vendor's is fetched unless asked.
  // The request is built in ONE function (buildDumpRequest,
  // ./extract-plan.mjs) from the in-scope rows of the listing: the exact
  // (type, name) pairs as `requested: {TYPE: [names]}` -- the sidecar expands
  // sources and closes the dictionary itself (the rule lives there).
  const chunkSize = typeof dumpChunkSize === "number" && dumpChunkSize > 0 ? dumpChunkSize : 500;
  const dumpRequest = buildDumpRequest({rows: inScopeRows, inactive: flags.inactive === true});
  const dumpPairs = requestedPairs(dumpRequest.requested);
  const dumpRequestPath = path.join(out, ".osd-hana", "dump-request.json");
  const reused = await reusableDump(dumpDir, dumpRequest);
  let dumpErrors = [];
  let dumpParts;
  let dumpPartial = false; // the sidecar said partial -- never "all written" (M-3)
  if (reused.ok) {
    io.err(`osd hana extract: reusing the existing dump in ${dumpDir} (same request, sidecar exit 0)`);
    if (Array.isArray(reused.errors)) dumpErrors = reused.errors;
  } else if (reused.exists) {
    return fail(`osd hana extract: refusing the dump directory ${dumpDir}: ${reused.why}\n` +
      "  A dump is never mixed. Remove the directory or pass --dump-dir.");
  } else if (dumpPairs.length === 0) {
    // everything in scope is unknown-class: nothing to fetch (and the sidecar
    // refuses an empty selection) -- the conversion below skips everything
    await fs.rm(dumpDir, {recursive: true, force: true});
  } else {
    const chunks = [];
    for (let i = 0; i < dumpPairs.length; i += chunkSize) chunks.push(dumpPairs.slice(i, i + chunkSize));
    if (chunks.length === 1) {
      await fs.writeFile(dumpRequestPath, `${JSON.stringify(dumpRequest, null, 1)}\n`);
      const dumpRun = await runVerb(sidecar, "dump", {requestPath: dumpRequestPath, out: dumpDir, fail, connection});
      if (typeof dumpRun === "number") return dumpRun;
      dumpPartial = dumpPartial || dumpRun.outcome === "partial";
    } else {
      // one request per chunk, one directory per chunk: the sidecar refuses a
      // non-empty --out. Since v2.62.1 the sidecar keeps its own statements
      // under 500 parameters, so chunking is a bound on one run's size, not
      // a workaround any more.
      dumpParts = [];
      const closures = [];
      for (const [n, chunk] of chunks.entries()) {
        const part = `part-${String(n + 1).padStart(5, "0")}`;
        const partDir = path.join(dumpDir, part);
        await fs.rm(partDir, {recursive: true, force: true});
        const partRequest = {...dumpRequest, requested: requestedOf(chunk)};
        const partRequestPath = path.join(out, ".osd-hana", `dump-request-${part}.json`);
        await fs.writeFile(partRequestPath, `${JSON.stringify(partRequest, null, 1)}\n`);
        const dumpRun = await runVerb(sidecar, "dump", {requestPath: partRequestPath, out: partDir, fail, connection});
        if (typeof dumpRun === "number") return dumpRun;
        dumpPartial = dumpPartial || dumpRun.outcome === "partial";
        const partManifest = JSON.parse(await fs.readFile(path.join(partDir, "manifest.json"), "utf8"));
        dumpParts.push(part);
        dumpErrors.push(...(partManifest.sidecar?.errors ?? []));
        if (partManifest.closure !== undefined) closures.push(partManifest.closure);
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
          counts: {package_objects: dumpPairs.length},
          errors: dumpErrors,
          parts: dumpParts,
          objects_report: "part-*/objects.jsonl",
        },
        // the parts' closures, merged: the audit's allowance is their union
        ...(closures.length > 0 ? {closure: {resolved: mergeResolved(closures)}} : {}),
      }, null, 1)}\n`);
    }
  }

  const dumpManifest = JSON.parse(await fs.readFile(path.join(dumpDir, "manifest.json"), "utf8"));
  // M-3: the sidecar's own errors -- per chunk (aggregate) or in the one
  // manifest -- are never dropped; each becomes a ledger line or a run-level
  // line below, and the exit code cannot be 0.
  dumpErrors = dumpErrors.length > 0 ? dumpErrors : (dumpManifest.sidecar?.errors ?? []);
  // the dump holds every object of the request; the sidecar counts DDIC
  // objects as "rows", so the object total is its own package_objects
  const dumpedCount = dumpManifest.counts?.package_objects ?? dumpManifest.sidecar?.counts?.package_objects;
  const dumpRoots = (dumpManifest.sidecar?.parts ?? []).map((p) => path.join(dumpDir, p));
  const dumpObjects = [];
  for (const root of dumpRoots.length > 0 ? dumpRoots : [dumpDir]) {
    dumpObjects.push(...await readJsonl(path.join(root, "objects.jsonl")));
  }
  // ---- M-2: the dump delivers exactly the scope, or the run stops ----------
  // Fix round 5 (M-1): the audit runs on EVERY dump before conversion --
  // reused or fresh. A dump the audit refused is marked refused.json in its
  // own directory and never reused: the next run refuses it and names the
  // directory to remove (reusableDump). "Just run it again" must not walk
  // past the refusal -- the audit is a pure function of dump + scope.
  // An object outside the scope that carries content -- sources (files,
  // `written`) or definition rows (`rows`) -- is over-delivery, EXCEPT the
  // names the sidecar's dictionary closure reached, which it lists in the
  // manifest's `closure.resolved` (v2.62.1): exactly those extras are
  // legitimate, nothing else. Skipped rows (excluded, not-found) carry no
  // content and do not trip the audit.
  const norm = (v) => String(v ?? "").trim().toUpperCase();
  const scopeSet = new Set(inScopeRows.map((r) => `${norm(r.type)}:${norm(r.name)}`));
  const closureSet = closureAllowance(dumpManifest);
  const carriesContent = (r) => (Array.isArray(r.files) && r.files.length > 0)
    || ["w", "written", "rows"].includes(String(r.status ?? "").trim().toLowerCase());
  const outOfScope = dumpObjects.filter((r) => {
    const id = `${norm(r.type)}:${norm(r.name)}`;
    return !scopeSet.has(id) && !closureSet.has(id) && carriesContent(r);
  });
  const auditRoots = dumpRoots.length > 0 ? dumpRoots : [dumpDir];
  let orphanSources = [];
  try {
    // the source-level audit (fix round 5, SHOULD-1): every REPOSRC row the
    // dump fetched must belong to an in-scope object -- a source fetched for
    // a sibling (or a name the shapes cannot even justify) is the vendor's
    // or a stranger's code on disk
    orphanSources = await outOfScopeSourcePrograms({dump: dumpDir, roots: auditRoots, scopeIds: scopeSet});
  } catch (e) {
    // an unreadable dump is the converter's refusal to raise, not the
    // audit's -- let the conversion path produce its report
    if (e.code !== "ENOENT") throw e;
  }
  if (outOfScope.length > 0 || orphanSources.length > 0) {
    const objList = outOfScope.slice(0, 8).map((r) => `${norm(r.type)}:${norm(r.name)}`).join(", ");
    const srcList = orphanSources.slice(0, 8).join(", ");
    const why = [
      outOfScope.length > 0
        ? `${outOfScope.length} object${outOfScope.length === 1 ? "" : "s"} with sources outside the scope (${objList}${outOfScope.length > 8 ? ", ..." : ""})`
        : undefined,
      orphanSources.length > 0
        ? `${orphanSources.length} source row${orphanSources.length === 1 ? "" : "s"} outside the scope -- no in-scope object owns them (${srcList}${orphanSources.length > 8 ? ", ..." : ""})`
        : undefined,
    ].filter(Boolean).join("; and ");
    // fix round 6 (MUST-1): the audit runs BEFORE the commit point, so this
    // sentence is true -- the repository was not touched; the dump, its
    // refused.json and the refusal report live in the work area
    const refusalReport = path.join(out, ".osd-hana", "refused-report.md");
    io.err(`osd hana extract: refusing the dump directory ${dumpDir}: it carries ${why}`
      + " -- the dump was to fetch exactly the in-scope objects, so this is not ours to keep. Remove the dump directory (or pass --dump-dir) and re-run."
      + ` The repository in ${out} is unchanged; the refusal report is ${refusalReport}.`);
    try {
      // the refusal poisons the dump: never reused (fix round 5, M-1)
      await fs.writeFile(path.join(dumpDir, "refused.json"), `${JSON.stringify({
        schema: 1, tool: "osd hana extract", refused_by: "scope audit", when: now().toISOString(), why,
        objects: outOfScope.map((r) => `${norm(r.type)}:${norm(r.name)}`),
        sources: orphanSources,
      }, null, 1)}\n`);
    } catch { /* marking must not mask the refusal */ }
    try {
      // the refusal report goes to the work area: a refused run writes no
      // repository file (a first-ever refusal must not leave report files
      // that make the next run refuse an unclaimed directory)
      await writeReport(path.join(out, ".osd-hana"), {
        schema: 1, out, dump_dir: dumpDir, request: dumpRequest,
        sidecar: describeSidecar(verified, handshakeInfo),
        folder_logic: {logic: "unknown", folders: []},
        plan, totals: totals(plan, [], dumpedCount, undefined, scopeSet),
        objects: [], errors: [{error: `the dump is refused: it carries ${why}`}],
        duration_ms: now().getTime() - started,
        notice: flags["include-sap"] === true ? "This extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it." : undefined,
      }, "refused-report");
    } catch { /* the refusal itself must not be masked by a report problem */ }
    return EXTRACT_EXIT.refusedOut;
  }

  // ---- 4: convert -- THE COMMIT POINT --------------------------------------
  // Fix round 6 (CRITIC round 4 MUST-1): every refusal is behind us -- the
  // listing, the plan, the consent gate, the dump (or its reuse) and the
  // scope audit (object + source) -- so only now does the run touch a
  // repository file. The provisional marker carries an existing marker's file
  // list (the marker never shrinks: a crash between this write and the final
  // one leaves the last complete list, not an empty one).
  await writeMarker(markerPath, {schema: 1, tool: "osd hana extract", files: Array.isArray(marker?.files) ? marker.files : [], kept});
  // the derived repository is refreshed from what THIS run writes -- but only
  // the files the marker listed unchanged (M-5): kept files stay on disk, and
  // the conversion refuses the objects that would overwrite them. Stale files
  // of objects that no longer convert are still removed, so a restart over a
  // drifted dump leaves nothing that claims content this run did not produce.
  await clearUnprotected(path.join(out, "src"), protectedPaths);
  // SHOULD-1 (round 4): the .gitignore is created when absent, the line
  // appended when missing, never overwritten
  const gitignoreAction = await ensureGitignoreLine(path.join(out, ".gitignore"));
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
    conversion = await convert({dump: dumpDir, out, listed: inScopeRows, preSkipped: unknownClassRows, roots: dumpRoots.length > 0 ? dumpRoots : undefined, protectedPaths, keptPaths: kept, onLedger: (l) => { ledgerAtFailure = l; }});
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
      totals: totals(plan, entries, dumpedCount, dumpedInScope, scopeIds),
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
  // M-3: each sidecar error becomes a ledger line on the object it names
  // (or a run-level line when it names none); the exit code is 3.
  const runLevelDumpErrors = [];
  for (const err of dumpErrors) {
    const base = String(err?.name ?? "").split("=>")[0].trim().toUpperCase();
    const matches = base === "" ? [] : conversion.entries.filter((e) => e.name.toUpperCase() === base || e.id.toUpperCase() === base);
    if (matches.length > 0) {
      for (const e of matches) {
        e.parts.push({part: "dump error", disposition: "not extracted", reason: `${err.error ?? JSON.stringify(err)}`});
        if (e.status === "written") e.status = "written-partial";
      }
    } else {
      runLevelDumpErrors.push(err);
    }
  }
  const durationMs = now().getTime() - started;
  const totalsDoc = totals(plan, conversion.entries, dumpedCount, dumpedInScope, scopeIds);
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
    dump_errors: runLevelDumpErrors,
    dump_partial: dumpPartial || dumpErrors.length > 0,
    kept,
    gitignore: {action: gitignoreAction},
    ddic_tables: conversion.ddicTables,
    duration_ms: durationMs,
    notice: flags["include-sap"] === true
      ? "This extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it."
      : undefined,
  };
  // the M1 backstop, structural: exit 0 is refused unless the ledger accounts
  // for exactly the listing's in-scope count -- totals that do not add up are
  // an internal error, never a silently wrong report
  if (conversion.unaccounted.length > 0 || totalsDoc.accounts !== true) {
    const mismatch = accountsFor(scopeIds, conversion.entries);
    reportDoc.ledger_error = `the ledger does not match the listing: ${conversion.unaccounted.length} unaccounted`
      + `${mismatch.duplicates.length ? `, duplicate ledger keys: ${mismatch.duplicates.join(", ")}` : ""}`
      + `${mismatch.missing.length ? `, missing from the ledger: ${mismatch.missing.join(", ")}` : ""}`
      + `${mismatch.extra.length ? `, in the ledger but not in scope: ${mismatch.extra.join(", ")}` : ""}`;
  } else {
    // M-3: "all written" would be a lie while the sidecar itself reported
    // that it could not deliver everything; round 4: the sentence speaks in
    // the two part kinds and never says "all"/"completely" while any
    // unchecked part exists
    const s = sentence(totalsDoc, conversion.entries);
    reportDoc.sentence = (dumpErrors.length > 0 || dumpPartial)
      ? `the sidecar reported ${dumpErrors.length} error${dumpErrors.length === 1 ? "" : "s"} on this dump${dumpPartial ? " (exit partial)" : ""} -- the report lists them on their objects; ${s}`
      : s;
  }
  await writeReport(out, reportDoc);

  // ---- M-5: the marker's final form -- everything this run wrote, hashed ----
  {
    const files = [];
    // per-object files carry their hash from the conversion
    for (const e of conversion.entries) for (const f of e.files ?? []) files.push({path: f.path, sha256: f.sha256, bytes: f.bytes});
    // the .gitignore is listed only while it is this command's own file
    // (SHOULD-1, round 4): created by this run, or created by an earlier one
    // and unchanged since -- a user's file we merely appended to is theirs
    const prevGitignore = (Array.isArray(marker?.files) ? marker.files : []).find((f) => f.path === ".gitignore")?.sha256;
    for (const rel of [".abapgit.xml", ".gitignore", "extract-report.json", "extract-report.md"]) {
      const abs = path.join(out, rel);
      try {
        const st = await fs.stat(abs);
        const sha = sha256File(abs);
        if (rel === ".gitignore" && !(gitignoreAction === "created" || (gitignoreAction === "unchanged" && prevGitignore === sha))) continue;
        files.push({path: rel, sha256: sha, bytes: st.size});
      } catch { /* absent -- not ours to list */ }
    }
    await writeMarker(markerPath, {schema: 1, tool: "osd hana extract", finished: now().toISOString(), files, kept});
  }

  if (flags["include-sap"] === true) io.out("NOTICE: this extraction includes SAP-delivered content. It is the vendor's property, not yours; do not publish it.");
  io.out(`extract-report: ${path.join(out, "extract-report.md")}`);
  io.out(reportDoc.sentence ?? reportDoc.ledger_error);
  if (reportDoc.ledger_error !== undefined) return EXTRACT_EXIT.internal;
  if (dumpErrors.length > 0 || dumpPartial) return EXTRACT_EXIT.partial;
  return reportDoc.totals.written === reportDoc.totals.inScope ? EXTRACT_EXIT.ok : EXTRACT_EXIT.partial;
}

// ---- helpers ---------------------------------------------------------------

async function runVerb(sidecar, verb, {requestPath, out, fail, connection}) {
  // host/port/database and an explicit ABAP schema are the connection flags;
  // user and password travel in the child's environment only (the Sidecar)
  const args = ["--request", requestPath, "--out", out, "--host", connection.host, "--port", String(connection.port)];
  if (connection.database !== undefined) args.push("--database", connection.database);
  if (connection.schema !== undefined) args.push("--abap-schema", connection.schema);
  args.push(...(connection.tlsArgs ?? []));
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
  // The doctor's rule (parse raw, redact where printed): every decision reads
  // the RAW `run.summary` (and the outcome); what reaches a person is the
  // masked `run.display`. A short numeric password ("123") must not turn a
  // count of 1234 into ***4 -- and must not be printed when echoed in text.
  const shown = run.display ?? {};
  switch (run.outcome) {
    case "done":
    case "partial": // the manifest carries the per-object reasons; the report accounts for them
      return run;
    case "connection":
      fail(`osd hana: cannot connect or log on: ${shown.error ?? "the sidecar said so"}`);
      return EXTRACT_EXIT.connection;
    case "unsupported":
      fail(`osd hana: no ABAP schema found on this database${run.summary.error ? ` (${shown.error})` : ""} -- there is no ABAP code to extract here.`);
      return EXTRACT_EXIT.noAbapSchema;
    case "refused":
      fail(`osd hana: the sidecar refused: ${shown.error ?? "unknown"}`);
      return EXTRACT_EXIT.refusedOut;
    case "usage":
      return fail(`osd hana: the sidecar refused the ${verb} as a usage error: ${shown.error ?? "unknown"}`);
    default:
      return fail(`osd hana: unmapped sidecar outcome: ${run.outcome}`);
  }
}

// The enclosing git working tree (directory or gitfile), or undefined.
export async function inGitTree(dir) {
  let p = path.resolve(dir);
  for (;;) {
    try {
      // stat, not lstat (critic round 2 NOTE-3): a working tree whose .git is
      // a SYMLINK to a git directory elsewhere is still a git tree -- git
      // itself says so, and so must this check
      const st = await fs.stat(path.join(p, ".git"));
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

// SHOULD-4 (critic round 2): the exit-0 gate as a real check. The set of
// in-scope ids from the listing and the set of ledger keys are compared AS
// SETS -- no duplicate ledger key, nothing missing, nothing extra, ids
// exact -- computed independently of the per-type counters (which held by
// construction and could not fire). This is what refuses exit 0 when the
// ledger and the listing disagree.
export function accountsFor(scopeIds, entries) {
  const seen = new Set();
  const duplicates = [];
  for (const e of entries) {
    if (seen.has(e.id)) duplicates.push(e.id);
    seen.add(e.id);
  }
  const missing = [...scopeIds].filter((id) => !seen.has(id));
  const extra = [...new Set(entries.map((e) => e.id).filter((id) => !scopeIds.has(id)))];
  return {
    accounts: duplicates.length === 0 && missing.length === 0 && extra.length === 0,
    duplicates: [...new Set(duplicates)],
    missing,
    extra,
  };
}

// The totals are computed FROM THE LEDGER (critic M1: never recomputed in a
// way that could mask a gap); the plan carries the in-scope counts and
// accountsFor (the set comparison above) is the exit-0 gate.
function totals(plan, entries, dumpedCount, dumpedInScope, scopeIds) {
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
    // fix round 4, the two counters over the written objects (the ledger's
    // set accounting above is unchanged): part lines known to be missing vs
    // part lines the dump cannot even check
    notExtractedParts: 0,
    uncheckedParts: 0,
    uncheckedObjects: 0,
    unchecked: [],
  };
  const byType = {};
  const uncheckedKinds = new Map();
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
    if (e.status === "written" || e.status === "written-partial") {
      // the two part kinds, counted separately (round 4)
      t.notExtractedParts += (e.parts ?? []).length;
      const un = e.unchecked ?? [];
      t.uncheckedParts += un.length;
      if (e.status === "written" && un.length > 0) {
        t.uncheckedObjects++;
        for (const u of un) uncheckedKinds.set(u.part, (uncheckedKinds.get(u.part) ?? 0) + 1);
      }
    }
    if (e.status !== "written") {
      byType[e.type] = (byType[e.type] ?? 0) + 1;
      t.notExtracted.push({type: e.type, status: e.status});
    }
  }
  t.accounts = accountsFor(scopeIds ?? new Set(), entries).accounts
    && Object.values(perType).every((v) => v.written + v.writtenPartial + v.skipped + v.unsupported === v.inScope);
  t.notExtracted = Object.entries(byType).sort(([a], [b]) => a.localeCompare(b)).map(([type, count]) => ({type, count}));
  t.unchecked = [...uncheckedKinds.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([kind, count]) => ({kind, count}));
  return t;
}

// Fix round 4: the summary speaks in the two part kinds and NEVER overclaims
// -- no sentence says "all" or "completely" while any unchecked part exists
// (a signal that is always on is no signal). The "N objects written. For K of
// them this tool could not check: <part kinds with counts>." sentence sits at
// the top of extract-report.md and prints once on the console; the per-object
// lists stay in the json and in the md's collapsed section. Losses (not
// extracted, skipped, unsupported) are named first, as before.
function sentence(t, entries = []) {
  const losses = t.writtenPartial + t.skipped + t.unsupported;
  const byType = t.notExtracted.map((x) => `${x.type} ${x.count}`).join(", ");
  const parts = [];
  if (losses > 0) parts.push(`${losses} object${losses === 1 ? "" : "s"} of ${t.inScope} could not be fully extracted (${byType})`);
  if (t.uncheckedObjects > 0) {
    const kinds = t.unchecked.map((x) => `${x.kind} ${x.count}`).join(", ");
    parts.push(`${t.written} object${t.written === 1 ? "" : "s"} written. For ${t.uncheckedObjects} of them this tool could not check: ${kinds}`);
  }
  if (parts.length === 0) return `all ${t.inScope} objects in scope were written`;
  return `${parts.join(". ")}.`;
}

async function writeReport(dir, reportDoc, base = "extract-report") {
  await fs.writeFile(path.join(dir, `${base}.json`), `${JSON.stringify(reportDoc, null, 1)}\n`);
  await fs.writeFile(path.join(dir, `${base}.md`), renderMdReport(reportDoc));
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

/** The closure allowance of a dump: TYPE:NAME for every name the sidecar's
 *  dictionary closure resolved (manifest `closure.resolved`, per kind). A
 *  manifest without the block allows nothing extra. */
export function closureAllowance(manifest) {
  const allowed = new Set();
  const resolved = manifest?.closure?.resolved;
  if (resolved === null || typeof resolved !== "object") return allowed;
  for (const [kind, names] of Object.entries(resolved)) {
    if (!Array.isArray(names)) continue;
    for (const n of names) allowed.add(`${String(kind).trim().toUpperCase()}:${String(n ?? "").trim().toUpperCase()}`);
  }
  return allowed;
}

function mergeResolved(closures) {
  const merged = {};
  for (const c of closures) {
    for (const [kind, names] of Object.entries(c?.resolved ?? {})) {
      if (!Array.isArray(names)) continue;
      const set = new Set(merged[kind] ?? []);
      for (const n of names) set.add(n);
      merged[kind] = [...set].sort();
    }
  }
  return merged;
}
