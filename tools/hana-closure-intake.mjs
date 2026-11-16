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
//   makes -- on the MACRO-EXPANDED statements, never by a text search: a
//   macro builds the literal from its arguments (`DEFINE w. WRITE '@&1 x'.`
//   called `w KERNEL.`), so no text prefilter can be a necessary condition.
//   All the delivered files are parsed in ONE registry, so a macro defined in
//   a class's macros include, in a program include or in another delivered
//   object expands where it is called, the way the transpiler expands it.
//   What cannot be expanded here fails CLOSED: an unparsed statement in an
//   object that pulls source in from outside the delivered set (an INCLUDE or
//   a type pool the delivered files do not carry) may be a call to a macro
//   defined there -- the object is refused, "macro not resolvable for the
//   kernel check".
// - a FRAMEWORK NAMESPACE: a namespace this tree's libraries provide (the
//   clean-room /IWBEP/ contract and its kind) is ours to implement; a dump
//   that brings an object of it anyway is refused, never merged
//   (tools/hana-closure-framework.mjs derives the namespaces).
import {readdirSync, readFileSync} from "node:fs";
import {join, relative} from "node:path";
import * as abaplint from "@abaplint/core";

// the transpiler's own prefix (write.js: concat.startsWith("'@KERNEL "))
export const KERNEL_PREFIX = "'@KERNEL ";

/** the kernel refusals of a set of delivered ABAP files, parsed together
 *  in one registry (`files`: [{name, text}], abapGit file names; the .xml
 *  files ride along, an include's program kind is in them). Returns
 *  [{file, line, object, reason, text?}]: "kernel splice" for every
 *  (expanded) WRITE the transpiler would splice, "macro not resolvable for
 *  the kernel check" for an unparsed statement in an object that includes
 *  source the set does not carry. Pure. */
export function kernelRefusals(files) {
  const reg = new abaplint.Registry();
  for (const f of files) reg.addFile(new abaplint.MemoryFile(f.name, String(f.text ?? "")));
  reg.parse();
  const found = [];
  const has = (type, name) => reg.getObject(type, String(name ?? "").toUpperCase()) !== undefined;
  for (const object of reg.getObjects()) {
    if (object instanceof abaplint.ABAPObject === false) continue;
    let external;
    const unknown = [];
    for (const file of object.getABAPFiles()) {
      const base = String(file.getFilename()).split("/").pop();
      for (const statement of file.getStatements()) {
        const kind = statement.get();
        if (kind instanceof abaplint.Statements.Write === true) {
          const source = statement.findDirectExpression(abaplint.Expressions.Source);
          // the transpiler's test is case-sensitive; this one is not -- a
          // superset, so a transpiler that grows a case-insensitive check
          // finds nothing new delivered
          if (source !== undefined && source.concatTokens().toUpperCase().startsWith(KERNEL_PREFIX) === true) {
            found.push({file: base, line: statement.getStart().getRow(), object: objectOfLayerFile(base), reason: "kernel splice",
              text: statement.concatTokens().slice(0, 120)});
          }
        } else if (kind instanceof abaplint.Statements.Include === true) {
          const name = statement.findFirstExpression(abaplint.Expressions.IncludeName)?.concatTokens();
          if (name !== undefined && has("PROG", name) === false) external ??= `INCLUDE ${name}`;
        } else if (kind instanceof abaplint.Statements.TypePools === true) {
          for (const t of statement.getTokens().slice(1)) {
            const name = t.getStr();
            if (/^[A-Za-z0-9_/]+$/.test(name) === true && has("TYPE", name) === false) external ??= `TYPE-POOLS ${name}`;
          }
        } else if (kind instanceof abaplint.Unknown === true) {
          unknown.push({file: base, line: statement.getStart().getRow()});
        }
      }
    }
    if (external !== undefined && unknown.length > 0) {
      for (const u of unknown) {
        found.push({...u, object: objectOfLayerFile(u.file), reason: `macro not resolvable for the kernel check (${external} is not delivered)`});
      }
    }
  }
  return found;
}

/** the kernel splices of one ABAP source file alone: [{line, text}] -- the
 *  one-file case of kernelRefusals, for a quick look. Pure. */
export function kernelSplices(filename, source) {
  return kernelRefusals([{name: filename, text: source}]).filter((r) => r.reason === "kernel splice")
    .map((r) => ({line: r.line, text: r.text}));
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
  const gones = new Map();
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
    }
    gones.set(folder, gone);
  }
  // the kernel check over every delivered ABAP and XML file at once, the
  // winner of a basename only (the later folder wins the build too)
  const winner = new Map();
  for (const [folder, files] of tree) {
    for (const [rel, source] of files) {
      const base = rel.split("/").pop();
      if (rel.startsWith("src/") === false || /\.(?:abap|xml)$/i.test(base) === false) continue;
      if (gones.get(folder).has(objectOfLayerFile(base)) === true) continue;
      winner.set(base, {folder, name: base, source});
    }
  }
  const scanned = [...winner.values()];
  for (const r of kernelRefusals(scanned.map((w) => ({name: w.name, text: read(w.source)})))) {
    const at = scanned.find((w) => w.name === r.file);
    refusals.push({object: r.object, folder: at?.folder, file: r.file, line: r.line, reason: r.reason});
    for (const [folder] of tree) gones.get(folder).set(r.object, true);
  }
  for (const [folder, files] of tree) {
    const gone = gones.get(folder);
    for (const rel of [...files.keys()]) {
      const base = rel.split("/").pop();
      if (rel.startsWith("src/") === true && base.split(".").length >= 3 && gone.has(objectOfLayerFile(base)) === true) files.delete(rel);
    }
  }
  return refusals;
}

/** the kernel refusals already on disk in the delivered layers
 *  (gen/hana-src/**): an island an older tool merged, before this refusal.
 *  The same check as the merge's, over every delivered file at once (the
 *  later folder's file winning a basename). [{file, line, reason}],
 *  root-relative. */
export function deliveredSplices(root) {
  const winner = new Map();
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
      else if (/\.(?:abap|xml)$/i.test(entry.name) === true && entry.name.split(".").length >= 3) winner.set(entry.name, at);
    }
  };
  walk(join(root, "gen", "hana-src"));
  return kernelRefusals([...winner].map(([name, at]) => ({name, text: readFileSync(at, "utf8")})))
    .map((r) => ({file: relative(root, winner.get(r.file)), line: r.line, reason: r.reason}));
}

/** the build seam's fail-closed check: throws when a delivered layer on
 *  disk carries a kernel splice or a statement the check cannot expand.
 *  tools/osd-build.mjs calls it before every transpile, the closure's
 *  positive control before its build. */
export function assertNoDeliveredSplice(root) {
  const found = deliveredSplices(root);
  if (found.length > 0) {
    throw new Error(`hana-closure: refused: ${found[0].reason.startsWith("kernel splice") ? "kernel splice" : "kernel check"} in a delivered layer -- ${found.map((f) => `${f.file}:${f.line} (${f.reason})`).join(", ")}; the build does not run over it (merge the dump again: hana-src-gen refuses the object)`);
  }
}
