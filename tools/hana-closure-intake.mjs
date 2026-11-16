// What a dumped source may NOT bring into a delivered layer (milestone 4),
// decided per OBJECT (every file of the object leaves
// together) where a dumped source enters gen/hana-src -- tools/hana-src-gen.mjs
// -- and nowhere else: this tree's own src/ and the libraries are never
// scanned.
//
// - a FRAMEWORK NAMESPACE: a namespace this tree's libraries provide (the
//   clean-room /IWBEP/ contract and its kind) is ours to implement; a dump
//   that brings an object of it anyway is refused, never merged
//   (tools/hana-closure-framework.mjs derives the namespaces).
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
 *  every object of a refused namespace. Returns [{object, folder, file,
 *  reason}] -- one per refused-namespace object -- and
 *  removes the refused objects' files from the tree in place. `read(source)`
 *  gives a tree entry's text. */
export function refuseObjects(tree, {namespaces = []}) {
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
    }
    for (const rel of [...files.keys()]) {
      const base = rel.split("/").pop();
      if (rel.startsWith("src/") === true && base.split(".").length >= 3 && gone.has(objectOfLayerFile(base)) === true) files.delete(rel);
    }
  }
  return refusals;
}

