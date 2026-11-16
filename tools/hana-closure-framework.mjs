// Framework gaps by namespace (milestone 4). Our layer OWNS the namespaces
// this tree's libraries provide -- the clean-room Gateway contract
// (/IWBEP/, through open-abap-odata and src/gateway) and whatever else a
// library carries a namespace of -- so a name in one of them that the build
// does not resolve is a FRAMEWORK GAP: recorded in framework-gaps.json with
// used_by, never asked from the dumper, and never merged from a dump that
// brings it anyway (tools/hana-src-gen.mjs --refuse-namespace refuses the
// object, tools/hana-closure-intake.mjs). On the five-service family run the
// walk asked the tenant for 31 Gateway-namespace names instead.
//
// The namespaces are DERIVED, never a hard-coded list: the namespaces of the
// library files abap_transpile.json lists (tools/osd-inputs.mjs
// libraryFiles -- the libs' own `files` and `exclude_filter` applied, the
// system's lib layers in system mode), minus every namespace the closure's
// SEED holds objects in or is packaged in: a library that carries one class
// of a namespace (open-abap-core's JSON helper is a launchpad-namespace
// class) does not make a seed of that namespace a framework of ours -- the
// seed's own namespace is the tenant's.
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {libraryFiles} from "./osd-inputs.mjs";
import {namespaceOf, objectOfLayerFile} from "./hana-closure-intake.mjs";

/** the namespaces of the library files the build loads: `/NS/` per
 *  `#ns#...` file. */
export function libraryNamespaces(root) {
  const out = new Set();
  let libs = [];
  try {
    libs = libraryFiles(root);
  } catch {
    libs = [];
  }
  for (const lib of libs) {
    for (const file of lib.files ?? []) {
      const ns = namespaceOf(objectOfLayerFile(String(file)));
      if (ns !== undefined) out.add(ns);
    }
  }
  return out;
}

/** the framework namespaces of one closure: the libraries' minus the
 *  seed's (`seedNamespaces`, tools/hana-closure-seed.mjs). Sorted. */
export function frameworkNamespaces(root, seedNamespaces = new Set()) {
  return [...libraryNamespaces(root)].filter((ns) => seedNamespaces.has(ns) === false).sort();
}

/** the predicate over a TADIR name. Pure. */
export function frameworkPredicate(namespaces) {
  const set = new Set(namespaces);
  return (name) => {
    const ns = namespaceOf(name);
    return ns !== undefined && set.has(ns) === true;
  };
}

/** the accumulator of one iteration's name-bearing framework gaps:
 *  add(name, kind, use) with use = {file, line, method?}; list() the
 *  entries sorted by name, each used_by unique and sorted. */
export function frameworkNames() {
  const map = new Map();
  return {
    add(name, kind, use) {
      const entry = map.get(name) ?? {name, kind, namespace: namespaceOf(name),
        finding: `${name} not provided by this tree's libraries (framework namespace ${namespaceOf(name)})`, used_by: []};
      if (use !== undefined && entry.used_by.some((u) => u.file === use.file && u.line === use.line && u.method === use.method) === false) {
        entry.used_by.push(use);
      }
      map.set(name, entry);
    },
    has: (name) => map.has(name),
    get size() {
      return map.size;
    },
    list: () => [...map.values()].sort((a, b) => (a.name < b.name ? -1 : 1)).map((e) => ({...e,
      used_by: [...e.used_by].sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line))})),
  };
}

/** splits the walk's ask list: a name in a framework namespace leaves the
 *  list and joins the accumulator (with every structural use the analysis
 *  recorded of it, and the finding the ask came from). Returns the kept
 *  names. */
export function splitFrameworkNames(names, isFramework, acc, analysisObjects = []) {
  const kept = [];
  for (const n of names) {
    if (isFramework(n.name) === false) {
      kept.push(n);
      continue;
    }
    const uses = [];
    for (const o of analysisObjects) {
      for (const u of o.unknowns ?? []) {
        if (u.name === n.name) uses.push({file: u.file ?? o.file, line: u.line, ...(u.method !== undefined ? {method: u.method} : {})});
      }
    }
    if (uses.length === 0) {
      const at = /, ([^,\s:]+):(\d+)$/.exec(String(n.finding ?? ""));
      uses.push(at === null ? undefined : {file: at[1], line: Number(at[2])});
    }
    for (const use of uses) acc.add(n.name, n.kind, use);
  }
  return kept;
}

/** framework-gaps.json with the name-bearing gaps beside the nameless ones
 *  the stub rounds wrote: `names` (one entry per name, `name` set) after
 *  the finding entries, and the merge refusals of framework-namespace
 *  objects marked `refused_from_dump`. Returns the count of name entries. */
export function writeFrameworkNames(out, acc, refusedFromDump = []) {
  const file = join(out, "framework-gaps.json");
  let list = [];
  try {
    list = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    list = [];
  }
  const names = acc.list();
  for (const r of refusedFromDump) {
    const entry = names.find((e) => e.name === r.object);
    if (entry !== undefined) entry.refused_from_dump = true;
    else names.push({name: r.object, namespace: namespaceOf(r.object), finding: r.reason, refused_from_dump: true, used_by: []});
  }
  writeFileSync(file, JSON.stringify([...list.filter((e) => e.name === undefined), ...names], null, 2) + "\n");
  return names.length;
}
