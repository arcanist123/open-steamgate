// What gateway.mjs and osgo.mjs share: OSG compiled whole (src/, gen/ and the
// libraries of abap_transpile.json) and its database as SQL statements.
import {copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {assertTableFieldsTyped} from "./frontend-ddic.mjs";
import {dbCacheRead, dbCacheWrite, dbContributions, dbFlat, incrAssemble, incrRecorder} from "./osgo-incr.mjs";
import {home} from "./home.mjs";
import {libraryPath} from "../osd-lib-path.mjs";

// a listed folder that is not on disk reads as empty (H3/FIX-4:
// gen/hana-ddic is listed before its first build writes it, and the osgo
// host imports this module on a fresh clone): tools/osd-inputs.mjs
// walkListed, the one walker the layer list shares
const walk = (d) => walkListed(d);

/*
 * The layers in the order the Node build reads them (tools/osd-inputs.mjs):
 * abap_transpile.json's input_folder with every pack's ABAP folders before
 * gen/ (tools/osd-packs.mjs inputFoldersOf), the later folder winning an
 * object both hold. test/ stays out, as it always has here: it holds test
 * fixtures, not the system. A file an later layer hides is not loaded at all
 * (`hidden`), the way osd-build.mjs hands the transpiler the winner only.
 */
const {inputFoldersOf} = await import(`${home}/tools/osd-packs.mjs`);
const {layers: layersOf, walkListed} = await import(`${home}/tools/osd-inputs.mjs`);
const {unfetched, describeUnfetched} = await import(`${home}/tools/osd-fetch.mjs`);
const transpileConfig = JSON.parse(readFileSync(`${home}/abap_transpile.json`, "utf8"));
const layerFolders = inputFoldersOf(home, transpileConfig).filter((f) => f !== "test");
export const layers = layerFolders.map((f) => `${home}/${f}`);
const resolved = layersOf(home, {...transpileConfig, input_folder: layerFolders});
if (resolved.duplicates.length > 0) throw new Error(`the same object twice in one folder: ${JSON.stringify(resolved.duplicates)}`);
/** the files of an object that a later layer holds too, absolute */
export const hidden = new Set(resolved.hidden.map((f) => `${home}/${f}`));
// CDS is lowered to DDIC views in gen/cds, as in the Node build. The
// frontend reads .asddls separately for the CDS-to-SQL name map; loading
// only its XML into the registry would give DatabaseSetup a sourceless DDLS.
for (const file of layers.flatMap(walk)) {
  if (/\.ddls\.xml$/i.test(file)) hidden.add(file);
}
export const overridden = resolved.overridden;
export const libs = ["open-abap-core/src", "express-icf-shim/src", "open-abap-apc/src", "open-abap-gui/src", "open-abap-gui/framework", "open-abap-odata/src", "ajson/src/core"]
  .map((d) => join(libraryPath(home, d.split("/")[0]), d.slice(d.indexOf("/") + 1))).filter(existsSync);

/*
 * abapGit is a library of the Node build with a file list (the "files"
 * globs of its entry in abap_transpile.json: the HTML, event and string-map
 * classes the sapevent node and ZOSD_GIT use, not all of abapGit). A folder
 * here is loaded whole, so the listed files are copied into .out/libs/abapgit
 * and that folder is the library. Without it ZCL_OSD_SAPEVENT had syntax
 * errors and its SICF node answered "not in this program".
 */
function filteredLib(name) {
  let spec;
  try { spec = JSON.parse(readFileSync(`${home}/abap_transpile.json`, "utf8")).libs?.find((l) => String(l.folder).toLowerCase().endsWith(`/${name}`)); } catch { return null; }
  const root = spec ? libraryPath(home, name) : null;
  if (!root || !existsSync(root) || !Array.isArray(spec.files)) return null;
  const out = join(import.meta.dirname, ".out", "libs", name);
  rmSync(out, {recursive: true, force: true});
  const globs = spec.files.map((g) => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*")}$`));
  const all = (d) => readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap((e) => (e.isDirectory() ? all(join(d, e.name)) : [join(d, e.name)]));
  for (const f of all(root)) {
    const rel = f.slice(root.length);
    if (rel.startsWith("/.git/") || !globs.some((r) => r.test(rel))) continue;
    mkdirSync(dirname(join(out, rel)), {recursive: true});
    copyFileSync(f, join(out, rel));
  }
  return out;
}
const abapgit = filteredLib("abapgit");
if (abapgit) libs.push(abapgit);

// a library object a layer holds too is the layer's: the Node build takes it out of the library input
// (src/gateway/compat overlays three objects of open-abap-odata), and the front end loads one of each
const layerFiles = new Set(layers.flatMap(walk).filter((f) => !hidden.has(f)).map((f) => f.split("/").pop()));
for (const f of libs.flatMap(walk)) if (layerFiles.has(f.split("/").pop())) hidden.add(f);
// a generated web app inside an input (a run cockpit, its Set app) is no ABAP: its Set.view.xml reads
// like a DDIC view named SET, and the database below would try to create it
const {cockpitAppsOf} = await import(`${home}/tools/osd-cockpit-apps.mjs`);
for (const app of cockpitAppsOf(home, layerFolders)) for (const f of walk(app.dir)) hidden.add(f);

/**
 * What compileOsg hands the front end: the folders in layer order, the objects
 * and the files left out (`hidden`). One definition, so a harness that replays
 * the build (tools/selfhost/) compiles exactly what osgo.mjs compiles.
 */
export function osgCompileInputs({extraFolders = []} = {}) {
  // a pack that fetches a folder and has not: a smaller system than its
  // manifest describes, refused as osd-build.mjs's prepare() refuses it,
  // rather than compiled from whatever is on disk
  const missing = unfetched(home);
  if (missing.length > 0) {
    const e = new Error(`OSGo refuses to build: ${describeUnfetched(missing)}`);
    e.code = "UNFETCHED";
    e.missing = missing;
    throw e;
  }
  const folders = [...layers, ...libs, ...extraFolders];
  const objects = [...new Set(folders.flatMap(walk).filter((f) => !hidden.has(f) && (/\.(clas|intf)\.abap$/.test(f) || /\.fugr\.xml$/.test(f)) && !f.includes("testclasses")).map((f) => f.split("/").pop().split(".")[0]))];
  return {folders, objects, hidden};
}

/** every class, interface and function group of the layers and libraries, compiled (a statement outside the subset is a stub)
 *
 * `incr` is the per-object cache of the fast path (tools/gogen/osgo-incr.mjs):
 * `{proof}` assembles the program out of the live generation's cache when the
 * proof holds (and says why it did not when it cannot), `{recordGen}` records
 * what a full front end lowered into that generation's cache. Without `incr`
 * nothing of it runs. */
export function compileOsg({extraFolders = [], includeTests = new Set(), incr} = {}) {
  const {folders, objects} = osgCompileInputs({extraFolders});
  const t0 = performance.now();
  let program;
  let incrInfo;
  let note = "";
  if (incr?.proof?.ok) {
    // a cache that cannot be read or assembled is a miss like any other:
    // the full front end below runs, never an abort
    let attempt;
    try { attempt = incrAssemble({root: home, folders, objects, hidden, includeTests, proof: incr.proof}); }
    catch (e) { attempt = {ok: false, reason: `the per-object cache could not be used: ${e.message}`}; }
    if (attempt.ok) {
      program = attempt.program;
      incrInfo = {read: attempt, proofBase: incr.proof.base};
      note = `\nosgo incr: ${attempt.reused} objects from the cache of generation ${incr.proof.base}, ${attempt.lowered.length} lowered fresh; ${attempt.notes.join("; ")}`;
    } else {
      incrInfo = {refused: attempt.reason};
      note = `\nosgo incr: the full front end runs (${attempt.reason})`;
    }
  }
  if (!program) {
    const recorder = incr?.recordGen ? incrRecorder({root: home, folders, hidden, objects, includeTests}) : undefined;
    program = compileProgram({folders, objects, tolerant: true, skip: (path) => hidden.has(path), ...(includeTests.size ? {includeTests} : {}), ...(recorder ? {incr: recorder} : {})});
    if (recorder) incrInfo = {written: recorder.finish({gen: incr.recordGen})};
  }
  const summary = `front end: ${program.classes.length} classes, ${program.partial.length} statement stubs, ${program.skipped.length} methods not compiled, ${program.broken.length} objects with syntax errors (${Math.round(performance.now() - t0)} ms)`;
  return {program, summary: `${summary}\nlayers: ${layerFolders.join(", ")}${overridden.length ? `; overridden: ${overridden.map((o) => `${o.object} by ${o.winner}`).join(", ")}` : ""}${note}`, incr: incrInfo};
}

/**
 * The database: the transpiler's CREATE TABLEs for this registry and the rows
 * test/seed.mjs gives the Node side, so both hosts start from the same data.
 * Rows of a table this program has no definition for (a pack's) are left out,
 * and said so in the summary.
 */
export async function osgDatabase(program, options = {}) {
  const {DatabaseSetup} = await import(`${home}/node_modules/@abaplint/transpiler/build/src/db/index.js`);
  // options.incr is what compileOsg's cache did: a read assembles the
  // statements out of the recorded per-object lists with the re-lowered
  // objects' rows derived again; a write records them after proving the
  // reconstruction is exactly what the real run produced
  /** @type {{schemas: {sqlite: string[]}, insert: string[]}} */ let setup;
  if (options.incr?.read) {
    // validated with the index before the cache was taken (osgo-incr-meta.mjs)
    const cached = options.incr.read.incrDb.db ?? dbCacheRead(options.incr.read.incrDb.dir);
    if (cached === undefined) throw new Error(`osgo incr: the cache of generation ${options.incr.proofBase} has no database record`);
    const fresh = dbContributions(program.reg, new Set(options.incr.read.incrDb.relower));
    const flat = dbFlat(cached, fresh);
    setup = {schemas: {sqlite: flat.schemas}, insert: flat.insert};
  } else {
    assertTableFieldsTyped(program.reg);
    setup = new DatabaseSetup(program.reg).run();
    if (options.incr?.written) {
      const mine = dbContributions(program.reg);
      const flat = dbFlat(mine);
      if (flat.schemas.join("\n") === setup.schemas.sqlite.join("\n") && flat.insert.join("\n") === setup.insert.join("\n")) {
        dbCacheWrite(options.incr.written.dir, mine);
      } else {
        options.incr.dbMismatch = true;
        console.log("osgo incr: the database statements did not attribute per object; the next fast build runs the full front end");
      }
    }
  }
  process.env.OSD_ROOT ??= home;
  const {seedStatements} = await import(`${home}/test/seed.mjs`);
  const seed = seedStatements();
  const created = new Set(setup.schemas.sqlite.map((x) => /^CREATE\s+(?:TABLE|VIEW)\s+['"]?([\w\/]+)/i.exec(x)?.[1]?.toLowerCase()).filter(Boolean));
  const inserts = [...setup.insert, ...(Array.isArray(seed) ? seed : [seed])].filter((x) => String(x).trim() !== "");
  const skipped = new Map();
  const kept = inserts.filter((x) => {
    const t = /^INSERT\s+INTO\s+['"]?([\w\/]+)/i.exec(x)?.[1]?.toLowerCase();
    if (t === undefined || created.has(t)) return true;
    skipped.set(t, (skipped.get(t) ?? 0) + 1);
    return false;
  });
  // the cross-reference the Node hosts seed at start (tools/osd-xref-seed.mjs,
  // CROSS / WBCROSSGT / WBCROSSGTX / D010INC derived from the tree), here
  // once at build time, so where-used and the main programs of an include
  // answer on osgo as they do on Node; only the tables this program defines
  const {rows: xrefRows, insertStatements: xrefInserts, counts: xrefCounts} = await import(`${home}/tools/osd-xref-seed.mjs`);
  // options.xref: rows the caller has already (the osgo fast path's, osgo-fast.mjs)
  const xref = options.xref ?? await xrefRows(home);
  const xrefStatements = xrefInserts(xref).filter((x) => {
    const t = /^(?:INSERT\s+INTO|DELETE\s+FROM)\s+['"]?([\w\/]+)/i.exec(x)?.[1]?.toLowerCase();
    return t !== undefined && created.has(t);
  });
  const xrefSummary = Object.entries(xrefCounts(xref)).map(([t, n]) => `${t} ${n}`).join(", ");
  const summary = `database: ${created.size} tables and views, ${kept.length} inserts${skipped.size ? `; left out, no table in this program: ${[...skipped].map(([t, n]) => `${t} (${n})`).join(", ")}` : ""}; cross-reference: ${xrefSummary}`;
  return {statements: [...setup.schemas.sqlite, ...kept, ...xrefStatements], summary};
}

/*
 * Is gen/ the generation of this tree? (parity-wave2) gen/ is written by
 * `npm run transpile` (tools/osd-build.mjs) from the tree's inputs, and OSGo
 * compiles it as it finds it. A tree changed since its last build keeps the
 * old gen/: the main checkout of 2026-09-25 held table sources from before
 * #48 ('1 = 1' as an empty WHERE, which a system and OSGo refuse) and a
 * ZCL_ZSTG_SADL_DPC from before #67 (LT_TAXI-ZONE), and an osgo built from
 * it broke SEGW, status, ICF and the taxi app while Node, which accepts
 * '1 = 1', did not show it. The build answers by its own record: the hash of
 * the inputs now must name a build (build/by-input/<hash>/manifest.json).
 * Returns undefined when it does, else why not.
 */
export async function staleGen(root = home) {
  const {hashOf, layout, liveHash} = await import(`${root}/tools/osd-build.mjs`);
  const hash = hashOf(root);
  if (existsSync(join(layout(root).byInput, hash, "manifest.json"))) return undefined;
  return `gen/ of ${root} is not the generation of its inputs: they hash to ${hash} and no build of that exists (live: ${liveHash(root) || "none"}); run npm run transpile there first`;
}
