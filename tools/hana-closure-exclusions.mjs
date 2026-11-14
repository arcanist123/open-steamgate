// The exclusion record seam (H5x-1, the schema H5x-2): when the closure
// walk (tools/hana-closure.mjs) decides -- as a graph analysis over the
// island's references, tools/hana-closure-graph.mjs graphDecide -- that an
// object cannot compile in this build, it keeps the file from the
// transpiler through this tree's own exclusion seam: the exclude_filter of
// tools/osd-build.mjs's ownConfig, the same one that keeps hidden and
// inactive files out. The file stays in its layer on disk; only the build
// is kept from it.
//
// The record is gen/hana-closure/closure-stubs.json -- the walk's --out
// (OSD_HANA_CLOSURE_OUT) when it ran with one -- and carries the decision's
// six sections plus the errors list (H5x-2's schema, FIX-1's `errors`):
//     {roots, cascades, cycles, stubs, waits, errors, excluded}
// roots -- the objects whose definition references a name answered missing
// ({level: "definition", object, file, kind, missing, findings}); cascades
// -- the dependents that fall with them ({level: "cascade", object, file,
// of, findings, excluded: true}) and the FRIENDS strips ({edge: "friends",
// action: "strip-friends", excluded: false}); cycles -- the SCCs of present
// objects kept whole ({level: "cycle", members, kept: true}); stubs -- the
// method stubs ({object, file, class, method, missing, finding}); waits --
// the objects whose definition names are still pending, the next request's
// asks ({object, names}); errors -- one {file, error} entry per island
// object whose analysis or planning threw (FIX-1: the object is "red, unknown
// cause" -- kept in the build, never excluded, the run continues);
// excluded -- the out-of-build objects per kind ({CLAS: [...], INTF:
// [...]}), the request's `excluded` key's twin.
//
// One reader here -- tools/osd-build.mjs, tools/hana-ddic-gen.mjs's
// validationMessage (the loop's own validate channel) and
// tools/osd-inputs.mjs all read the same record through definitionExclusions
// and excludedFiles -- and no dependency beyond node:fs, so the browser
// graph osd-inputs sits in stays clean. A file an H5x-1 iterator wrote (an
// array of records) still reads: its definition-level entries map into
// roots/cascades, its method stubs into stubs.
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";

// the record's path: gen/hana-closure/closure-stubs.json by default, the
// loop's --out when the walk ran with one -- OSD_HANA_CLOSURE_OUT is how the
// loop tells the readers it spawns (osd-build, hana-ddic-gen --from-build)
// where its record lives. A human running osd-inputs by hand sets it too.
export const closureStubsFile = (root) =>
  join(process.env.OSD_HANA_CLOSURE_OUT ?? join(root, "gen", "hana-closure"), "closure-stubs.json");

const EMPTY = () => ({roots: [], cascades: [], cycles: [], stubs: [], waits: [], errors: [], excluded: {}});

const kindOfEntry = (e) => (/\.intf\.abap$/.test(String(e?.file ?? "")) === true ? "INTF" : "CLAS");

/** the closure-stubs.json record of one tree: the six-section object when
 *  the walk has written one, the empty record when it has never run here,
 *  the H5x-1 array shape mapped into the six sections (a file that is not
 *  readable JSON reads as empty: the record is the walk's output, and a
 *  half-written one must not silently hide objects from a build). */
export function closureStubs(root, file = closureStubsFile(root)) {
  if (existsSync(file) === false) return EMPTY();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return EMPTY();
  }
  if (Array.isArray(parsed) === true) {
    const out = EMPTY();
    for (const e of parsed) {
      if (e?.level === "definition" && typeof e.file === "string") {
        out.roots.push({...e, kind: kindOfEntry(e), missing: []});
      } else if (e?.level === "cascade" && e.excluded === true && typeof e.file === "string") {
        out.cascades.push({...e, kind: kindOfEntry(e)});
      } else if (e?.level === "cycle") {
        out.cycles.push({members: e.members ?? [], kept: true, findings: e.findings ?? {}});
      } else if (e?.level === "method") {
        out.stubs.push(e);
      }
    }
    for (const e of [...out.roots, ...out.cascades]) {
      out.excluded[e.kind] = [...(out.excluded[e.kind] ?? []), e.object];
    }
    return out;
  }
  if (parsed === null || typeof parsed !== "object") return EMPTY();
  return {
    roots: Array.isArray(parsed.roots) === true ? parsed.roots : [],
    cascades: Array.isArray(parsed.cascades) === true ? parsed.cascades : [],
    cycles: Array.isArray(parsed.cycles) === true ? parsed.cycles : [],
    stubs: Array.isArray(parsed.stubs) === true ? parsed.stubs : [],
    waits: Array.isArray(parsed.waits) === true ? parsed.waits : [],
    errors: Array.isArray(parsed.errors) === true ? parsed.errors : [],
    excluded: parsed.excluded !== null && typeof parsed.excluded === "object" ? parsed.excluded : {},
  };
}

/** the exclusion records that keep files from the transpiler: the roots and
 *  the cascades excluded with them -- a strip cascade (edge "friends") is a
 *  RECORD only (its file stays in the build; the clause is what leaves) --
 *  with the fields osd-inputs prints (object, file, findings). `file` --
 *  the record path, for the loop's in-process reads of a non-default --out. */
export function definitionExclusions(root, file = undefined) {
  const record = closureStubs(root, file);
  return [
    ...record.roots.filter((r) => typeof r.file === "string")
      .map((r) => ({object: r.object, file: r.file, findings: r.findings ?? [], level: "definition", missing: r.missing ?? []})),
    ...record.cascades.filter((c) => c.excluded === true && typeof c.file === "string")
      .map((c) => ({object: c.object, file: c.file, findings: c.findings ?? [], level: "cascade", of: c.of ?? []})),
  ];
}

// the files of one object beside the record's main file: an object is all
// of them or none -- with the .clas.xml left in, the transpiler registers
// the class, lists it in init.mjs and writes no module for it, so the
// generation does not load (H5x-4 B4, the first island build that
// finished: `Cannot find module .../cl_..._test_base.clas.mjs`)
const COMPANIONS = {
  clas: ["clas.abap", "clas.xml", "clas.locals_imp.abap", "clas.locals_def.abap", "clas.macros.abap", "clas.testclasses.abap"],
  intf: ["intf.abap", "intf.xml"],
};

/** the root-relative file paths of the excluded objects' main files (what
 *  a report prints). The build keeps every file of each object from the
 *  transpiler: excludedObjectFiles. */
export function excludedFiles(root, file = undefined) {
  return definitionExclusions(root, file).map((e) => e.file);
}

/** every file of each excluded object, for the build's exclude_filter. */
export function excludedObjectFiles(root, file = undefined) {
  const out = [];
  for (const main of excludedFiles(root, file)) {
    const m = /^(.*)\.(clas|intf)\.[^/]*$/.exec(main);
    if (m === null) {
      out.push(main);
      continue;
    }
    for (const suffix of COMPANIONS[m[2]]) out.push(`${m[1]}.${suffix}`);
  }
  return out;
}
