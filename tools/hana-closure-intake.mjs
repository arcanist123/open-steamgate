// What a dumped source may NOT bring into a delivered layer (milestone 4).
// Two refusals, both decided per OBJECT (every file of the object leaves
// together) where a dumped source enters gen/hana-src -- tools/hana-src-gen.mjs
// -- and nowhere else: this tree's own src/ and the libraries are never
// scanned.
//
// - a KERNEL SPLICE: the transpiler copies `WRITE '@KERNEL <js>'` verbatim
//   into the generated module (the pinned @abaplint/transpiler,
//   build/src/statements/write.js: a WRITE whose Source expression's
//   concatenated tokens start with the five-character quote-@KERNEL-space
//   prefix is emitted as the literal's inside, nothing else is honoured that
//   way). This tree uses it on purpose in its own classes; a delivered class
//   carrying one would run arbitrary JavaScript in the host. Detected
//   structurally -- abaplint's statement nodes, the same test the transpiler
//   makes -- never by a text search over the source (the byte check below is
//   only the necessary condition that lets a file without the marker skip
//   the parse).
// - a FRAMEWORK NAMESPACE: a namespace this tree's libraries provide (the
//   clean-room /IWBEP/ contract and its kind) is ours to implement; a dump
//   that brings an object of it anyway is refused, never merged
//   (tools/hana-closure-framework.mjs derives the namespaces).
import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import * as abaplint from "@abaplint/core";

// the transpiler's own prefix (write.js: concat.startsWith("'@KERNEL "))
export const KERNEL_PREFIX = "'@KERNEL ";

/** the kernel splices of one ABAP source file: [{line, text}], one per WRITE
 *  statement the transpiler would splice. `filename` is the abapGit file name
 *  (it tells the registry the object kind). A file that does not parse is
 *  scanned statement by statement as far as abaplint structures it; a file
 *  without the marker bytes is not parsed at all. Pure. */
export function kernelSplices(filename, source) {
  const text = String(source ?? "");
  if (text.toUpperCase().includes("@KERNEL") === false) return [];
  const reg = new abaplint.Registry();
  reg.addFile(new abaplint.MemoryFile(filename, text));
  reg.parse();
  const found = [];
  for (const object of reg.getObjects()) {
    if (object instanceof abaplint.ABAPObject === false) continue;
    for (const file of object.getABAPFiles()) {
      for (const statement of file.getStatements()) {
        if (statement.get() instanceof abaplint.Statements.Write === false) continue;
        const source = statement.findDirectExpression(abaplint.Expressions.Source);
        if (source === undefined) continue;
        // the transpiler's test is case-sensitive; this one is not -- a
        // superset, so a transpiler that grows a case-insensitive check
        // finds nothing new delivered
        if (source.concatTokens().toUpperCase().startsWith(KERNEL_PREFIX) === true) {
          found.push({line: statement.getStart().getRow(), text: statement.concatTokens().slice(0, 120)});
        }
      }
    }
  }
  return found;
}

/** the object a layer file belongs to, as the TADIR name: `#ns#cl_x.clas.abap`
 *  -> /NS/CL_X (abapGit's escaping read backwards). Pure. */
export function objectOfLayerFile(filename) {
  const stem = String(filename ?? "").split("/").pop().split(".")[0] ?? "";
  let name = stem;
  try {
    name = decodeURIComponent(stem);
  } catch {
    // as it stands
  }
  return name.replace(/^#([^#]+)#/, "/$1/").toUpperCase();
}

/** the namespace of a TADIR name (`/IWBEP/`), or undefined. Pure. */
export function namespaceOf(name) {
  const m = /^(\/[^/]+\/)/.exec(String(name ?? "").toUpperCase());
  return m === null ? undefined : m[1];
}

/** the refusals over one layer tree (folder -> (relative path -> source)):
 *  every object with a kernel splice in any of its ABAP files, and every
 *  object of a refused namespace. Returns [{object, folder, file, reason,
 *  line?}] -- one entry per splice, one per refused-namespace object -- and
 *  removes the refused objects' files from the tree in place. `read(source)`
 *  gives a tree entry's text. */
export function refuseObjects(tree, {namespaces = [], read}) {
  const refusedNs = new Set(namespaces.map((n) => String(n).toUpperCase()));
  const refusals = [];
  for (const [folder, files] of tree) {
    const gone = new Map();
    for (const [rel, source] of files) {
      const base = rel.split("/").pop();
      if (rel.startsWith("src/") === false || base.split(".").length < 3) continue;
      const object = objectOfLayerFile(base);
      const ns = namespaceOf(object);
      if (ns !== undefined && refusedNs.has(ns) === true) {
        if (gone.has(object) === false) {
          gone.set(object, true);
          refusals.push({object, folder, file: base, reason: `framework namespace ${ns}: provided by this tree's libraries, never merged from a dump`});
        }
        continue;
      }
      // an object named KERNEL_*: the transpiler and the runtime resolve
      // their own kernel classes by that name (KERNEL_LOCK, KERNEL_CALL, ...),
      // and a delivered one would stand in for the runtime's
      if (/^KERNEL_/.test(object) === true) {
        if (gone.has(object) === false) {
          gone.set(object, true);
          refusals.push({object, folder, file: base, reason: "kernel name: the runtime's own class names are KERNEL_*"});
        }
        continue;
      }
      if (/\.abap$/i.test(base) === false) continue;
      for (const splice of kernelSplices(base, read(source))) {
        gone.set(object, true);
        refusals.push({object, folder, file: base, line: splice.line, reason: "kernel splice"});
      }
    }
    for (const rel of [...files.keys()]) {
      const base = rel.split("/").pop();
      if (rel.startsWith("src/") === true && base.split(".").length >= 3 && gone.has(objectOfLayerFile(base)) === true) files.delete(rel);
    }
  }
  return refusals;
}

/** the kernel splices already on disk in the delivered layers
 *  (gen/hana-src/**): an island an older tool merged, before this refusal.
 *  [{file, line}], root-relative. */
export function deliveredSplices(root) {
  const found = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const at = join(dir, entry.name);
      if (entry.isDirectory()) walk(at);
      else if (entry.name.endsWith(".abap") === true) {
        for (const s of kernelSplices(entry.name, readFileSync(at, "utf8"))) found.push({file: relative(root, at), line: s.line});
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  return found;
}

/** the build seam's fail-closed check: throws when a delivered layer on
 *  disk carries a kernel splice. */
export function assertNoDeliveredSplice(root) {
  const found = deliveredSplices(root);
  if (found.length > 0) {
    throw new Error(`hana-closure: refused: kernel splice in a delivered layer -- ${found.map((f) => `${f.file}:${f.line}`).join(", ")}; the build does not run over it (merge the dump again: hana-src-gen refuses the object)`);
  }
}
