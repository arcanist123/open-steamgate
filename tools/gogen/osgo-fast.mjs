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
import {existsSync, readFileSync} from "node:fs";
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
  const inputs = inputsOf(root);
  const digests = new Map();
  const hash = hashOf(root, inputs, {digests});
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
