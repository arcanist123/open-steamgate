// The osgo fast path (docs/osgo-fast-rebuild.md, "The fast path"): may this
// osgo build skip the Node build?
//
// osgo.mjs reads two things of a Node build: gen/ (what the generators
// write) and nothing else -- the transpiled JavaScript is never loaded. It
// refuses a gen/ that is not the generation of the tree's inputs (staleGen:
// build/by-input/<hash>/manifest.json must exist), so every save used to run
// the whole Node build first, 38 s of which ~30 s is a transpile osgo throws
// away.
//
// The fast path accepts a tree the Node build has not built when, and only
// when, it can prove that a build of it would leave gen/ as it is:
//
//   1. the live generation L exists, and gen/ on disk is the gen/ L was made
//      with (manifest `gen`, genHash);
//   2. no inactive-object overlay is in play (a build would compile another
//      view than the tree);
//   3. every source file whose digest differs from L's record is an existing
//      file of L (source-inputs.json), and with those files counted at L's
//      digests the tree hashes to L exactly (hashOf `substitute`, the proof
//      the warm prime uses): so nothing else changed -- no config, library,
//      generator, YAML, DDIC, new or removed file;
//   4. each changed file passes the warm rule (osd-warm.mjs warmRule), the
//      rule that already lets the Node warm build skip every generator: the
//      content of an existing class or interface, no AMDP, the same
//      INTERFACES lines, no RAP handler, no SUBMIT, no program declaration.
//
// Anything else answers {ok: false, reason} and osgo.mjs runs the full Node
// build first, as before. The tree's generation is named by the same
// function a full build names it with (hashOf), and osgo's own generation
// (status.mjs, `go:<hash>` of the program) follows from gen/ and the tree,
// which are the same bytes either way. Nothing is written under build/: the
// Node host never sees a generation it did not build.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, relative, resolve} from "node:path";

const AMDP = /BY\s+DATABASE\s+(PROCEDURE|FUNCTION)/i;
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Whether osgo may build this tree without the Node build.
 * @param {string} root the checkout
 * @param {{tools?: string}} [options] where tools/ is (tests point it elsewhere)
 * @returns {Promise<{ok: true, hash: string, base: string, changed: string[]} | {ok: false, reason: string, hash?: string, base?: string}>}
 */
export async function fastProof(root, options = {}) {
  const tools = options.tools ?? join(root, "tools");
  const {genHash, hashOf, inputsOf, layout, liveHash} = await import(`${tools}/osd-build.mjs`);
  const {sourceBuildOverlay} = await import(`${tools}/osd-source-build-view.mjs`);
  const {activeOverlay} = await import(`${tools}/osd-build.mjs`);
  const {warmRule} = await import(`${tools}/osd-warm.mjs`);
  const {sourceSnapshotPath} = await import(`${tools}/osd-source-snapshot.mjs`);
  const paths = layout(root);
  const digests = new Map();
  let inputs, hash;
  // a library that is not at its pin, or has local changes, cannot name a
  // generation (osd-lib-path.mjs throws): the full build says so in its words
  try {
    inputs = inputsOf(root);
    hash = hashOf(root, inputs, {digests});
  } catch (e) {
    return {ok: false, reason: `the tree's generation cannot be named: ${e.message}`};
  }
  if (existsSync(join(paths.byInput, hash, "manifest.json"))) return {ok: false, hash, reason: `generation ${hash} is built already: nothing to skip`};
  const base = liveHash(root);
  if (base === undefined) return {ok: false, hash, reason: "no live generation to start from"};
  const generation = join(paths.byInput, base);
  let manifest, record;
  try {
    manifest = JSON.parse(readFileSync(join(generation, "manifest.json"), "utf8"));
    record = JSON.parse(readFileSync(join(generation, "source-inputs.json"), "utf8"));
  } catch (e) {
    return {ok: false, hash, base, reason: `live generation ${base} has no manifest or source record (${e.code ?? e.message})`};
  }
  const gen = genHash(root);
  if (manifest.gen !== gen) return {ok: false, hash, base, reason: `gen/ is not the gen/ of live ${base} (${gen} on disk, ${manifest.gen} recorded)`};
  if (activeOverlay(await sourceBuildOverlay(root)) !== undefined) return {ok: false, hash, base, reason: "inactive objects are kept out of the build (an overlay): the full build compiles that view"};
  // the files whose digest is not live's; a file live does not record is new
  const substitute = new Map();
  const changed = [];
  for (const [file, digest] of digests) {
    const key = relative(root, file).replaceAll("\\", "/");
    const was = record[key];
    if (was === digest) continue;
    if (was === undefined) {
      // not a source input of live (a YAML, a JSON, a new file): the hash
      // proof below decides; recorded or not, it is not a class body
      if (/\.(abap|xml)$/i.test(key)) return {ok: false, hash, base, reason: `${key}: not in live ${base} (a new file)`};
      continue;
    }
    substitute.set(resolve(file), was);
    changed.push(key);
  }
  const back = hashOf(root, inputs, {substitute});
  if (back !== base) return {ok: false, hash, base, reason: `more than source edits changed since live ${base} (with ${changed.length} edited files put back the tree hashes to ${back}): a file was added or removed, or the config, a library, a generator or a non-source input changed`};
  if (changed.length === 0) return {ok: false, hash, base, reason: "no source file differs from live, yet the hash does"};
  // the AMDP classes, which read interfaces as type sources (warmRule)
  const amdpText = [...digests.keys()].filter((f) => /\.clas\.abap$/i.test(f)).map((f) => readFileSync(f, "utf8")).filter((t) => AMDP.test(t)).join("\n");
  for (const key of changed) {
    const before = beforeOf(root, generation, key, record[key], sourceSnapshotPath);
    if (before === undefined) return {ok: false, hash, base, reason: `${key}: live's copy is not retained`};
    const after = readFileSync(join(root, key), "utf8");
    const reason = warmRule({path: key, before, after, amdpText});
    if (reason !== undefined) return {ok: false, hash, base, reason};
  }
  return {ok: true, hash, base, changed: changed.sort()};
}

// the bytes live was built from: the shared copy by digest, else the
// generation's own snapshot
function beforeOf(root, generation, key, digest, snapshotPath) {
  for (const file of [join(root, "build", "source-by-digest", digest), join(generation, "source", snapshotPath(key))]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    if (sha(bytes) === digest) return bytes.toString("utf8");
  }
  return undefined;
}

/**
 * The store's view of a fast build (store.mjs `edited`): each edited file is
 * active as it is now, from a copy of its bytes under `outDir`, keyed by
 * digest, where a full build's snapshot would have put it.
 * Every other copy in `outDir` is removed except those the last build's
 * store names (`previous`, its zz_store.json): that binary may still be
 * serving them until the new one replaces it.
 * @param {string} root
 * @param {string[]} changed root-relative files (fastProof)
 * @param {string} outDir where the copies go (inside root)
 * @param {{previous?: string}} [options]
 */
export function fastStoreEdits(root, changed, outDir, options = {}) {
  const edited = new Map();
  mkdirSync(outDir, {recursive: true});
  for (const file of changed) {
    const bytes = readFileSync(join(root, file));
    const digest = sha(bytes);
    const copy = join(outDir, digest);
    if (!existsSync(copy)) writeFileSync(copy, bytes);
    edited.set(file, {digest, path: relative(root, copy).replaceAll("\\", "/")});
  }
  const keep = new Set([...edited.values()].map(({path}) => resolve(root, path)));
  if (options.previous !== undefined && existsSync(options.previous)) {
    try {
      for (const path of Object.values(JSON.parse(readFileSync(options.previous, "utf8")).active ?? {})) keep.add(resolve(root, path));
    } catch { /* an unreadable last store names nothing to keep */ }
  }
  for (const name of readdirSync(outDir)) {
    const copy = join(outDir, name);
    if (!keep.has(resolve(copy))) rmSync(copy, {force: true});
  }
  return edited;
}

/**
 * The cross-reference rows of a fast build without parsing the tree: the
 * live generation's rows (build/xref, keyed as osd-xref-seed.mjs keys them)
 * with the rows of each edited object derived again from its own files.
 * Every row names its object (INCLUDE, or MASTER for D010INC), the rows of
 * one object are contiguous in each table, and what an object's rows say
 * depends on its own statements and on the set of object names, which the
 * fast case does not change -- so the block is replaced where it was.
 * undefined when the live rows are not cached or an edited object had no
 * row in a table it now has rows in (its place is not known): the caller
 * parses the tree as before.
 * @param {string} root
 * @param {{base: string, changed: string[]}} proof
 * @param {{tools?: string}} [options]
 */
export async function fastXrefRows(root, proof, options = {}) {
  const tools = options.tools ?? join(root, "tools");
  const {cacheKey, wellFormed, TABLES} = await import(`${tools}/osd-xref-seed.mjs`);
  const key = await cacheKey(root, {hash: proof.base});
  if (key === undefined) return undefined;
  let rows;
  try { rows = JSON.parse(readFileSync(join(root, "build", "xref", `${key}.json`), "utf8")); } catch { return undefined; }
  if (!wellFormed(rows)) return undefined;
  const {ObjectStore, INCLUDES} = await import(`${tools}/osd-store.mjs`);
  const {configuredRegistry} = await import(`${tools}/osd-store-registry.mjs`);
  const {CrossReference} = await import(`${tools}/osd-xref.mjs`);
  const abaplint = await import(`${root}/node_modules/@abaplint/core/build/src/index.js`);
  const store = new ObjectStore({root});
  const objects = new Map();
  for (const file of proof.changed) {
    const m = /([^/]+)\.(clas|intf)(\.[a-z_]+)?\.abap$/i.exec(file);
    if (!m) return undefined;
    const type = m[2].toUpperCase() === "CLAS" ? "CLAS" : "INTF";
    const name = m[1].replace(/#/g, "/").toUpperCase();
    objects.set(`${type} ${name}`, {type, name});
  }
  const registry = configuredRegistry(store).registry;
  for (const {type, name} of objects.values()) {
    const entry = store.find(type, name);
    if (entry === undefined) return undefined;
    const files = type === "CLAS" ? [entry.file, ...Object.values(INCLUDES).filter(Boolean).map((s) => entry.file.replace(/\.clas\.abap$/, s))] : [entry.file];
    for (const file of new Set([...files, entry.file.replace(/\.abap$/, ".xml")])) {
      if (existsSync(join(root, file))) registry.addFile(new abaplint.MemoryFile("/" + file, readFileSync(join(root, file), "utf8")));
    }
  }
  registry.parse();
  const xref = new CrossReference(undefined, registry);
  // the names of the whole tree, as a full build sees them
  const TYPE_OBJECTS = new Set(["CLAS", "INTF", "TABL", "DTEL", "DOMA", "TTYP", "VIEW", "DDLS"]);
  xref.byName = new Map(store.list().filter((o) => TYPE_OBJECTS.has(o.type)).map((o) => [o.name, o.type]));
  const fresh = xref.build([...objects.values()]).tables();
  const fresher = {CROSS: fresh.cross, WBCROSSGT: fresh.wbcrossgt, WBCROSSGTX: fresh.wbcrossgtx, D010INC: fresh.d010inc};
  const out = {};
  for (const table of TABLES) {
    const owner = (row) => (table === "D010INC" ? row.MASTER : row.INCLUDE);
    let list = rows[table];
    for (const {name} of objects.values()) {
      const at = list.findIndex((row) => owner(row) === name);
      const mine = fresher[table].filter((row) => owner(row) === name);
      if (at < 0) {
        if (mine.length > 0) return undefined;
        continue;
      }
      const end = at + list.slice(at).findIndex((row) => owner(row) !== name);
      const stop = end < at ? list.length : end;
      // contiguous, or the premise does not hold
      if (list.slice(stop).some((row) => owner(row) === name)) return undefined;
      list = [...list.slice(0, at), ...mine, ...list.slice(stop)];
    }
    out[table] = list;
  }
  return out;
}

/**
 * The syntax check the fast path owes: the full Node build refuses a tree
 * whose edit does not compile (osd-build.mjs: `FAILED: check_syntax, ...`),
 * and the fast path must not turn such a tree into a binary. The front end
 * osgo runs anyway has checked every object (`program.diagnostics`, the
 * abaplint syntax pass, file and line in each message); an error in an
 * object the proof names as edited is the refusal. Errors in objects nobody
 * edited are the live generation's (the front end is tolerant of them, the
 * Node build accepted them) and are not this edit's.
 * @param {string[]} changed root-relative files (fastProof)
 * @param {{object: string, message: string}[]} diagnostics
 * @returns {string | undefined} the refusal, naming object, file and line
 */
export function fastSyntaxRefusal(changed, diagnostics) {
  const edited = new Set(changed.map((f) => /([^/]+)\.(clas|intf)(\.[a-z_]+)?\.abap$/i.exec(f)?.[1].replace(/#/g, "/").toUpperCase()).filter(Boolean));
  const mine = diagnostics.filter((d) => edited.has(String(d.object).toUpperCase()));
  if (mine.length === 0) return undefined;
  return `syntax errors in the edited objects: ${mine.map((d) => `${d.object.toUpperCase()}: ${d.message}`).join("; ")}`;
}
