// A cold publication can advance a kept registry without another full run.
// The caller provides its logical build view and graph operations; this module
// owns the delta, registry mutation and proof against the published bytes.
import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve} from "node:path";
import {generatorIdentity, hashOf, inputsOf, layout, liveHash, prepare, rootsWanted} from "./osd-build.mjs";
import {assertToolchain} from "./osd-transpiler.mjs";
import {checkRead, checkView} from "./osd-store-compile-view.mjs";
import {outputFiles, readAll, isBinaryFilename} from "./osd-transpile.mjs";
import {orderRegistry} from "./osd-warm-order.mjs";
import {lowerDerived, readRapBindings} from "./rap/lower-derived.mjs";
import {lowerNarrowSubmit} from "./osd-narrow-submit.mjs";
import {TMP_FOLDER, TMP_AUTHORS} from "./osd-tmp.mjs";

const key = o => `${o.getType()} ${o.getName()}`;
export const UPDATE_LIMIT = 100;

export async function updateRegistry(c, activating, {viewOf, closure, index, rule, importersOf, NotWarm}) {
  const started = Date.now(), root = c.root;
  const authorSidecar = path => relative(root, path) === join(TMP_FOLDER, TMP_AUTHORS);
  const refuse = reason => { throw new NotWarm(reason); };
  if (!c.primed) refuse("no kept registry");
  const {config, stack} = prepare(root);
  const transpiler = assertToolchain(root, c.loaded);
  const identity = {config: readFileSync(layout(root).config, "utf8"), transpiler, generators: generatorIdentity(root), layers: JSON.stringify(inputsOf(root, config))};
  for (const k of Object.keys(identity)) if (identity[k] !== c.identity[k]) refuse(`the ${k} changed`);
  const overlay = c.overlayOf(activating);
  checkView(root, c.compileView, overlay);
  const raw = new Map();
  // Do not reuse a library walk here: a cold build may have changed a lib.
  const hash = hashOf(root, inputsOf(root, config), {digests: raw, transpiler, overlay});
  if (hash !== liveHash(root)) refuse("the inputs are no longer the cold publication");
  const view = viewOf(overlay, raw, config, stack);
  const edits = [], removed = [];
  const rapBindings = readRapBindings(root, checkRead(c.compileView));
  const out = resolve(root, c.own.output_folder);
  for (const [path, before] of c.files) if (!view.actual.has(path)) removed.push({path, before});
  for (const [path, actual] of view.actual) {
    const before = c.files.get(path);
    const digest = view.digests.get(path);
    if (before && digest !== undefined && digest === c.digests.get(path) && !c.held.has(path) && c.actual.get(path) === actual) continue;
    const [after] = await readAll([actual], out, (text, filename) => lowerDerived(lowerNarrowSubmit(text, filename, c.core), filename, rapBindings), checkRead(c.compileView));
    if (digest !== undefined && createHash("sha256").update(readFileSync(actual)).digest("hex") !== digest) refuse(`${relative(root, path)} changed while being read`);
    if (!before || before.contents !== after.contents || before.relative !== after.relative || c.held.has(path)) edits.push({path, before, after});
  }
  const changed = new Set([...edits, ...removed].map(e => e.path));
  // Inputs not read by the registry include libraries, pages, layer manifests
  // and generator sources. None can be repaired by updating source objects.
  for (const path of new Set([...c.digests.keys(), ...view.digests.keys()])) {
    if (c.digests.get(path) !== view.digests.get(path) && !changed.has(path)) refuse(`${relative(root, path)}: a config, layer, library or generator input changed`);
  }
  if (changed.size > UPDATE_LIMIT) refuse(`delta ${changed.size} files exceeds ${UPDATE_LIMIT}`);
  for (const {path, before, after} of [...edits, ...removed]) {
    const name = basename(path);
    // Creation/deletion updates $TMP authors; Registry admits no object for
    // this sidecar. Keep its bytes/order in the proof without reparsing it.
    if (authorSidecar(path)) continue;
    // Metadata travels with new/deleted source objects. Other object types
    // remain conservative until their generator contracts are established.
    if (/\.(clas|intf|prog)\.xml$/i.test(name)) continue;
    const reason = rule({path: name, before: before?.contents ?? "", after: after?.contents ?? "", amdpText: c.amdpText});
    if (reason) refuse(reason);
  }
  const old = [...edits, ...removed].map(e => e.before && c.owner.get(e.before.filename)).filter(Boolean);
  // A missing target has no resolved edge in the old graph. On additions,
  // reparse every unresolved consumer and its readers before re-indexing.
  const unresolved = edits.some(e => !e.before) ? [...c.unresolved] : [];
  const affectedKeys = new Set([...closure([...old, ...c.pending, ...unresolved])].map(key));
  // Restore the native iterator while mutating object membership.
  delete c.reg.getObjects;
  for (const {path, before} of removed) if (!authorSidecar(path)) c.reg.removeFile(c.reg.getFileByName(before.filename));
  for (const {path, before, after} of edits) {
    if (authorSidecar(path)) continue;
    const file = new c.core.MemoryFile(after.filename, after.contents);
    if (before) c.reg.updateFile(file); else c.reg.addFile(file);
    affectedKeys.add(`${file.getObjectType()} ${file.getObjectName().toUpperCase()}`);
  }
  const byActual = new Map([...view.actual].map(([logical, actual]) => [actual, logical]));
  const replacements = new Map(edits.map(e => [e.path, e.after]));
  const files = new Map(view.wanted.map(actual => {
    const path = byActual.get(actual);
    const file = replacements.get(path) ?? c.files.get(path);
    return [path, {...file, path: actual, relative: relative(out, dirname(actual))}];
  }));
  orderRegistry(c.reg, c.core, files.values(), c.libs);
  const affected = [...c.reg.getObjects()].filter(o => affectedKeys.has(key(o)));
  for (const o of affected) o.setDirty();
  // #1921: keep the registry's config and unrelated syntax results intact.
  const output = await new c.Transpiler({...c.settings, only: o => affectedKeys.has(key(o))}).run(c.reg);
  const liveOut = join(layout(root).byInput, hash, "output");
  const written = outputFiles(output, c.own, liveOut, [...files.values()]);
  const differing = written.filter(f => !existsSync(f.path) || readFileSync(f.path, isBinaryFilename(f.path) ? "latin1" : "utf8") !== f.contents);
  if (differing.length) refuse(`incremental registry differs in ${differing.length} outputs (${differing.slice(0, 3).map(f => basename(f.path)).join(", ")})`);
  checkView(root, c.compileView, overlay);
  c.files = files;
  c.actual = view.actual;
  c.digests = view.digests;
  c.pending = new Set();
  c.held = new Map();
  c.hash = hash;
  c.config = config;
  c.amdpText = [...files.values()].filter(f => /BY\s+DATABASE\s+(PROCEDURE|FUNCTION)/i.test(f.contents)).map(f => f.contents).join("\n");
  index();
  c.importers = importersOf(liveOut);
  c.wanted = rootsWanted(join(layout(root).byInput, hash), config);
  const result = {hash, files: changed.size, objects: affected.length, ms: Date.now() - started};
  c.log(`warm: updated ${result.files} files, ${result.objects} objects in ${result.ms} ms`);
  return result;
}
