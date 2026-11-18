#!/usr/bin/env node
// The serve scope: which code of a rescued island a route needs, and the
// rest kept from the build (docs/hana-serve-icf.md).
//
//   node tools/hana-serve-scope.mjs --root <OBJECT> [--root <OBJECT>]...
//   node tools/hana-serve-scope.mjs --show
//   node tools/hana-serve-scope.mjs --clear
//
// The closure walk (tools/hana-closure.mjs) closes every name an island
// object mentions, for every object the dump's packages hold. A package
// that holds an HTTP handler can also hold a GUI report and a push channel
// that pulls in a library of its own, and then the island is many times
// what the route runs -- and the part the route never runs is where the
// build breaks. This tool cuts the island to what the named roots reach:
//
//   - the roots are named, never guessed (`--root`, repeatable): a handler
//     class, a class a check calls. Nothing here knows an application.
//   - an object is kept when a kept object's source names it: every
//     identifier of its .abap files, comment lines (`*` in column 1) left
//     out, against the names of the island's code objects (CLAS, INTF,
//     PROG, FUGR and the function modules its XML lists). Coarse on
//     purpose: a name in a string or a trailing comment keeps its object,
//     so the cut can keep too much and never cuts what a body calls by a
//     literal name.
//   - only code under gen/hana-src is cut. The dictionary stays (a type
//     nobody uses costs nothing), and so does everything of the tree's own
//     (src/, packs, libraries).
//   - the rest goes into gen/hana-closure/serve-scope.json (beside the
//     closure's own record, OSD_HANA_CLOSURE_OUT moves both), which the
//     build reads through the same seam as the closure's exclusions
//     (tools/hana-closure-exclusions.mjs, excludedObjectFiles): the files
//     stay in their layers, the transpiler and the report converter
//     (tools/osd-gui-convert.mjs) are kept from them, and
//     `node tools/osd-inputs.mjs` lists each one.
//
// The record names a real tenant's objects, which is why it lives under
// gen/hana-closure (private, never tracked). `--clear` removes it; run that
// before the closure walks again, or the walk's positive-control build
// runs without the objects the record names.
//
// packsHidingTenant: a pack is layered after the island, so a pack object
// of the same name wins it and the build runs our copy of the code instead
// of the tenant's -- a rescued system served out of something else. Both
// this CLI and tools/hana-serve.mjs refuse a build where that happens;
// OSD_WEB_PACKS selects the packs a build takes.
import {existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {serveScopeFile as scopeFile, serveScopeLeftOut} from "./hana-closure-exclusions.mjs";

export {scopeFile};

export const ISLAND = join("gen", "hana-src");
const CODE = new Set(["clas", "intf", "prog", "fugr"]);
const KIND = {clas: "CLAS", intf: "INTF", prog: "PROG", fugr: "FUGR"};

const slash = (p) => p.split(sep).join("/");
const nameOf = (base) => base.replace(/#/g, "/").toUpperCase();

function walk(dir, out) {
  let entries;
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, out);
    else out.push(path);
  }
  return out;
}

/** the island's code objects: {key, kind, name, files (root-relative), names} */
export function islandObjects(root) {
  const objects = new Map();
  for (const path of walk(join(root, ISLAND), [])) {
    const m = /^([^.]+)\.([a-z]+)(?:\.|$)/.exec(path.split(sep).pop());
    if (m === null || CODE.has(m[2]) === false) continue;
    const key = `${KIND[m[2]]} ${nameOf(m[1])}`;
    const one = objects.get(key) ?? {key, kind: KIND[m[2]], name: nameOf(m[1]), files: [], names: [nameOf(m[1])]};
    one.files.push(slash(relative(root, path)));
    objects.set(key, one);
  }
  // a function module is called by its own name, not its group's
  for (const one of objects.values()) {
    if (one.kind !== "FUGR") continue;
    for (const file of one.files.filter((f) => f.endsWith(".fugr.xml"))) {
      for (const m of readFileSync(join(root, file), "utf8").matchAll(/<FUNCNAME>([^<]+)<\/FUNCNAME>/g)) one.names.push(m[1].trim().toUpperCase());
    }
  }
  return [...objects.values()].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** the identifiers of an ABAP source, comment lines left out */
export function identifiers(source) {
  const out = new Set();
  for (const line of String(source).split(/\r?\n/)) {
    if (line.startsWith("*")) continue;
    for (const m of line.matchAll(/[A-Za-z0-9_/]+/g)) out.add(m[0].toUpperCase());
  }
  return out;
}

/** kept and left out, from the roots. `objects` is islandObjects(root);
 *  `read` reads a root-relative file. A root the island does not hold is
 *  an error naming it: a typo would otherwise cut everything. */
export function cut(objects, roots, read) {
  const byName = new Map();
  for (const one of objects) for (const name of one.names) byName.set(name, one);
  const wanted = roots.map((r) => String(r).replace(/#/g, "/").toUpperCase());
  const unknown = wanted.filter((r) => byName.has(r) === false);
  if (unknown.length > 0) throw new Error(`hana-serve-scope: no code object of the island (${ISLAND}) is named ${unknown.join(", ")}`);
  const kept = new Set();
  const queue = wanted.map((r) => byName.get(r));
  while (queue.length > 0) {
    const one = queue.shift();
    if (kept.has(one.key)) continue;
    kept.add(one.key);
    for (const file of one.files.filter((f) => f.endsWith(".abap"))) {
      for (const id of identifiers(read(file))) {
        const next = byName.get(id);
        if (next !== undefined && kept.has(next.key) === false) queue.push(next);
      }
    }
  }
  return {
    roots: wanted,
    kept: objects.filter((o) => kept.has(o.key)).map((o) => o.key),
    leftOut: objects.filter((o) => kept.has(o.key) === false).map((o) => ({object: o.key, files: o.files})),
  };
}

/** the record, or undefined when there is none */
export function readScope(root, file = scopeFile(root)) {
  if (existsSync(file) === false) return undefined;
  const parsed = JSON.parse(readFileSync(file, "utf8"));
  return {roots: parsed.roots ?? [], kept: parsed.kept ?? [], leftOut: serveScopeLeftOut(root, file)};
}

/** the pack objects that hide an island object: [{object, winner, hidden}] */
export async function packsHidingTenant(root, env = process.env) {
  const {layers} = await import("./osd-inputs.mjs");
  const island = `${slash(ISLAND)}/`;
  // osd-inputs names a winner by its folder and a hidden file by its path,
  // both root-relative
  const inIsland = (path) => `${slash(String(path))}/`.startsWith(island);
  return layers(root, undefined, env).overridden
    .filter((o) => inIsland(o.winner) === false && o.hidden.some(inIsland));
}

export function describeHiding(list) {
  return `${list.length} object(s) of the rescued island are hidden by a later layer, so the build would run that copy instead of the tenant's: `
    + list.slice(0, 5).map((o) => `${o.object} (won by ${o.winner})`).join(", ")
    + " -- select the packs this build takes with OSD_WEB_PACKS (docs/hana-serve-icf.md)";
}

if (runsAs("hana-serve-scope.mjs")) {
  const root = process.env.OSD_ROOT ?? process.cwd();
  const argv = process.argv.slice(2);
  const file = scopeFile(root);
  try {
    if (argv.includes("--clear")) {
      rmSync(file, {force: true});
      console.log(`hana-serve-scope: no serve scope (${slash(relative(root, file))} removed)`);
    } else if (argv.includes("--show")) {
      const record = readScope(root);
      console.log(record === undefined ? "hana-serve-scope: no serve scope: the whole island is built"
        : `hana-serve-scope: roots ${record.roots.join(", ")}; ${record.kept.length} kept, ${record.leftOut.length} left out`);
    } else {
      const roots = argv.flatMap((a, i) => (a === "--root" ? [argv[i + 1]] : []));
      if (roots.length === 0 || roots.includes(undefined)) throw new Error("usage: hana-serve-scope --root <OBJECT> [--root <OBJECT>]... | --show | --clear");
      const result = cut(islandObjects(root), roots, (f) => readFileSync(join(root, f), "utf8"));
      mkdirSync(dirname(file), {recursive: true});
      writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`hana-serve-scope: roots ${result.roots.join(", ")}: ${result.kept.length} code object(s) kept, ${result.leftOut.length} left out of the build -> ${slash(relative(root, file))}`);
      const hiding = await packsHidingTenant(root);
      if (hiding.length > 0) {
        console.error(`hana-serve-scope: ${describeHiding(hiding)}`);
        process.exit(1);
      }
    }
  } catch (e) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}
