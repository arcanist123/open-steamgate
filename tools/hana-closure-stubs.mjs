// The lazy-activation step of the closure (H5c round 3), beside the loop:
// abaplint's parser in, stub bodies out. tools/hana-closure.mjs stays the
// loop -- this file is its own package so the size budget stays honest --
// and takes the classifier back from it: a load-time cycle of function
// declarations only, every call happens at runtime.
//
// A class compiles as a whole or not at all. --stub-unresolved uses that:
// the body of every island method whose findings do not resolve is
// replaced by the stub raise of zcx_osd_not_activated, so the service
// activates with what resolves and the island grows only on a real miss.
//
// H5x-2 shapes the planner with the structural pass
// (tools/hana-closure-graph.mjs): a method's missing names come from its
// references (level "method" and "signature", attributed by name) beside
// the text fallback's remaining shapes, and two rewrites join the body
// stubs:
// - a GLOBAL FRIENDS clause naming an object that is gone (excluded, or
//   answered missing/refused -- the caller's `goneOf`) is stripped: a
//   friend that leaves with the test framework costs the friending class a
//   source rewrite, never its place in the build (graph-closure/REPORT.md
//   item 5; KNOT-15 rule: FRIENDS is soft);
// - a signature-level miss (the method_definition scope: a parameter typed
//   by a missing name) no longer reads as definition material: while the
//   dumper can still answer its DDIC name the signature stays, and once the
//   name is answered -- or is a code kind staying lazy -- the parameter is
//   cut from the METHODS statement and the body stubbed (report item 8).
// H5x-1's decisions all stand: a DDIC-kind name a would-be-stubbed method
// names is eagerly requested, only code kinds stay lazy (--defer-ddic keeps
// round 3); a name whose object is in the island is never asked, never
// deferred; a method keeps its body only while a DDIC name of its is still
// pending; nameless, present-only, resolved-but-still-failing and dead
// names all stub; a nameless stub's raise carries its finding's text and
// the nameless stubs' findings are the framework work list. A class or
// interface whose DEFINITION references a missing name is excluded -- by
// the graph decision (tools/hana-closure-graph.mjs graphDecide) over the
// whole island, not by this file.
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import * as abaplint from "@abaplint/core";
import {classifyFindings, nameFromAbapFile} from "./hana-closure-exclude.mjs";
import {requestKindOf, stripFriends, cutSignatureParams} from "./hana-closure-graph.mjs";

// the island class and interface files a stub pass may rewrite or exclude:
// gen/hana-src/**/*.clas.abap, the locals includes beside them, and the
// *.intf.abap files (an interface is never stubbed -- it has no method
// bodies -- but its definition-level references are what gets excluded).
// Basename -> every match's path -- the validation reports bare basenames,
// and a basename both an island layer and src/ carry is the island's (the
// later layer wins the build), so the stub targets the gen/hana-src copy
// and never the tree's own src/ file.
export function islandClassPaths(root) {
  const map = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.(?:clas(?:\.locals_imp)?|intf)\.abap$/.test(entry.name) === true) {
        const paths = map.get(entry.name) ?? [];
        paths.push(join(dir, entry.name));
        map.set(entry.name, paths);
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  return map;
}

/** the METHOD ... ENDMETHOD blocks of one class file, by source position:
 *  abaplint's parser, never a regex over ABAP (the house rule; the same
 *  approach tools/amdp-extract.mjs cuts AMDP bodies with). `headerEnd` is
 *  the position just past the header's closing dot, `endStart` the
 *  ENDMETHOD's first character -- a body is the text between them, a
 *  finding is in it when its line is strictly between the two rows. A
 *  `.clas.locals_imp.abap` parses as the class's second file, its blocks
 *  carry the local class's name. Pure. */
export function methodBlocks(source, filename = "zcl_stub.clas.abap") {
  const reg = new abaplint.Registry().addFile(new abaplint.MemoryFile(filename, source)).parse();
  const blocks = [];
  for (const file of reg.getFirstObject()?.getABAPFiles() ?? []) {
    let impl;
    let open;
    for (const st of file.getStatements()) {
      const kind = st.get().constructor.name;
      if (kind === "ClassImplementation") {
        impl = String(st.getTokens()[1]?.getStr() ?? "").toUpperCase();
      } else if (kind === "MethodImplementation" && open === undefined) {
        open = st;
      } else if (kind === "EndMethod" && open !== undefined) {
        const headerEnd = open.getEnd();
        const endStart = st.getStart();
        blocks.push({
          className: impl ?? "",
          method: String(open.getTokens()[1]?.getStr() ?? "").toUpperCase(),
          headerEnd: {row: headerEnd.getRow(), col: headerEnd.getCol()},
          endStart: {row: endStart.getRow(), col: endStart.getCol()},
        });
        open = undefined;
      }
    }
  }
  return blocks;
}

/** the class-constructor paths of one class file (B6): per class, the
 *  methods its CLASS_CONSTRUCTOR reaches through calls of the same class
 *  (transitively, the constructor included), the stub raise text of every
 *  method whose body already is a stub raise, and whether the constructor
 *  already is the signal stub. A class constructor runs when its module
 *  loads -- in this runtime and, as the first use of the class, on a system
 *  -- so a raise anywhere on that path stops the generation from loading.
 *  Calls are read off abaplint's MethodName expressions; a call into
 *  another class is not followed (the load check in the summary catches
 *  one). Pure. */
export function constructorPaths(source, filename = "zcl_stub.clas.abap") {
  const reg = new abaplint.Registry().addFile(new abaplint.MemoryFile(filename, source)).parse();
  const calls = new Map();
  const raised = new Map();
  const signalled = new Set();
  for (const file of reg.getFirstObject()?.getABAPFiles() ?? []) {
    let impl = "";
    let method;
    for (const st of file.getStatements()) {
      const kind = st.get().constructor.name;
      if (kind === "ClassImplementation") impl = String(st.getTokens()[1]?.getStr() ?? "").toUpperCase();
      else if (kind === "MethodImplementation") method = String(st.getTokens()[1]?.getStr() ?? "").toUpperCase();
      else if (kind === "EndMethod") method = undefined;
      else if (method !== undefined) {
        const key = `${impl}|${method}`;
        const list = calls.get(key) ?? new Set();
        for (const m of st.findAllExpressions(abaplint.Expressions.MethodName)) list.add(m.getFirstToken().getStr().toUpperCase());
        calls.set(key, list);
        const tokens = st.getTokens().map((t) => t.getStr().toUpperCase());
        if (kind === "Raise" && tokens.includes("ZCX_OSD_NOT_ACTIVATED")) {
          const text = st.getTokens().map((t) => t.getStr()).find((t) => t.startsWith("'"));
          raised.set(key, text === undefined ? "" : text.slice(1, -1));
        }
        if (method === "CLASS_CONSTRUCTOR" && tokens.join(" ").includes("ZCX_OSD_NOT_ACTIVATED => SIGNAL")) signalled.add(impl);
      }
    }
  }
  const reach = new Map();
  for (const key of calls.keys()) {
    const [cls, m] = key.split("|");
    if (m !== "CLASS_CONSTRUCTOR") continue;
    const seen = new Set(["CLASS_CONSTRUCTOR"]);
    const queue = ["CLASS_CONSTRUCTOR"];
    while (queue.length > 0) {
      for (const next of calls.get(`${cls}|${queue.shift()}`) ?? []) {
        if (seen.has(next) === false && calls.has(`${cls}|${next}`)) { seen.add(next); queue.push(next); }
      }
    }
    reach.set(cls, seen);
  }
  return {reach, raised, signalled};
}

// the offsets of one parsed position over the source (the rewrite cuts all
// work in character offsets)
const offsetAt = (source, at) => {
  const lines = source.split("\n");
  let offset = 0;
  for (let i = 0; i < at.row - 1; i++) offset += lines[i].length + 1;
  return offset + at.col - 1;
};

/** the missing names of one stub, comma-joined, ~200 characters at most --
 *  the text travels in the exception and says exactly what the method
 *  waits for; a list that does not fit ends in ", ...". Pure. */
export function stubNamesText(names) {
  const parts = [];
  let length = 0;
  for (const name of names) {
    const add = (parts.length === 0 ? 0 : 2) + name.length;
    if (parts.length > 0 && length + add > 193) break;
    parts.push(name);
    length += add;
  }
  return parts.length === names.length ? parts.join(", ") : `${parts.join(", ")}, ...`;
}

/** the raise text of a stub whose findings name nothing (S-3, fix round
 *  1): the first finding's message -- so the exception says why even with
 *  no name, and a GET never reads "needs ''". A quote is doubled for the
 *  ABAP literal; the text is capped like the names list. Pure. */
export function stubReasonText(finding) {
  const text = String(finding?.message ?? finding ?? "").replace(/'/g, "''");
  return text.length > 193 ? `${text.slice(0, 190)}...` : text;
}

// a finding is structural-matched when a reference that NAMES its thing
// sits on its line (+/-2): the name must be in the finding's message, or a
// fallback shape on the same line (a SELECT's table beside a type lookup)
// would lose its name to a reference it does not carry
const refMatched = (refs, finding) => refs.some((r) =>
  Math.abs((r.line ?? 0) - finding.line) <= 2 &&
  String(finding.message ?? "").toUpperCase().includes(r.name) === true);

// one method block's missing names: the structural references first (with
// their TADIR-ish kinds), then the text fallback's shapes for the findings
// no reference carries. Pure.
const blockNames = (refs, inside) => {
  const missing = [];
  const missingKinds = [];
  const push = (name, kind) => {
    if (missing.includes(name) === true) return;
    missing.push(name);
    missingKinds.push({name, kind});
  };
  for (const r of refs) push(r.name, requestKindOf(r.name, r));
  for (const n of classifyFindings(inside.filter((f) => refMatched(refs, f) === false)).names) push(n.name, n.kind);
  return {missing, missingKinds};
};

/** lazy activation, the stubbing step (round 3): map the findings of ONE
 *  island class file onto the METHOD ... ENDMETHOD blocks abaplint parsed
 *  out of it, and give every method that carries a finding the stub body
 *  (`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = ...`,
 *  indented inside the method). `refs` -- H5x-2: the file object's
 *  structural references (tools/hana-closure-graph.mjs); a method's names
 *  come from its references first. Findings outside any body -- the
 *  definition part -- come back in `unmatched`: they cannot be stubbed, so
 *  their names stay in the request (the graph decision reads them). A file
 *  that does not parse is left whole, all its findings unmatched. Per
 *  method: `missing` are the names first-named (a cascade finding adds
 *  none) and `missingKinds` carries each name with its kind, for the
 *  request's `deferred`. Pure: the caller writes the source back. */
export function stubBodies(source, findings, filename = "zcl_stub.clas.abap", refs = []) {
  let blocks;
  try {
    blocks = methodBlocks(source, filename);
  } catch {
    return {source, stubs: [], unmatched: findings};
  }
  const stubs = [];
  const matched = new Set();
  for (const block of blocks) {
    const methodRefs = refs.filter((r) => r.level === "method" && r.method === block.method);
    const inside = findings.filter((f) => f.line > block.headerEnd.row && f.line < block.endStart.row);
    if (inside.length === 0) continue;
    const {missing, missingKinds} = blockNames(methodRefs, inside);
    stubs.push({...block, missing, missingKinds, finding: inside[0].raw, reason: stubReasonText(inside[0])});
    for (const finding of inside) matched.add(finding);
  }
  if (stubs.length === 0) return {source, stubs: [], unmatched: findings};
  const out = applyStubs(source, stubs);
  return {source: out, stubs, unmatched: findings.filter((f) => matched.has(f) === false)};
}

// the one rewrite pass: cut every stub's body (header's closing dot to the
// ENDMETHOD), back to front, the stub raise indented like the ENDMETHOD
const applyStubs = (source, stubs) => {
  const lines = source.split("\n");
  let out = source;
  for (const stub of [...stubs].sort((a, b) => offsetAt(source, b.headerEnd) - offsetAt(source, a.headerEnd))) {
    const indent = (/^[ \t]*/.exec(lines[stub.endStart.row - 1] ?? "") ?? [""])[0];
    const text = stub.missing.length > 0 ? stubNamesText(stub.missing) : stub.reason;
    // a class constructor runs when its module loads: its stub signals and
    // returns, it never raises (constructorPaths below)
    const statement = stub.method === "CLASS_CONSTRUCTOR"
      ? `zcx_osd_not_activated=>signal( '${text}' ).`
      : `RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = '${text}'.`;
    const body = `\n${indent}  ${statement}\n${indent}`;
    const start = offsetAt(source, stub.headerEnd);
    const end = offsetAt(source, stub.endStart);
    out = out.slice(0, start) + body + out.slice(end);
  }
  return out;
};

// ------------------------------------------------------------- H5x-1 ------

// the classification kinds that name code, and the kinds that name the
// dictionary. Only the code kinds stay lazy under --stub-unresolved; every
// DDIC kind -- including the kind-less `ddic` triple -- is eager.
const CODE_KINDS = new Set(["clas", "intf", "fugr", "prog"]);
export const isCodeKind = (kind) => CODE_KINDS.has(kind) === true;

/** an object name to the abapGit file base it stages as: the namespace
 *  escaped as #ns#, lower case -- tools/hana-ddic-map.mjs abapGitFileName's
 *  one rule, read backwards. Pure. */
export function abapBaseOf(name) {
  return String(name ?? "").replace(/\/([^/]+)\//, "#$1#").toLowerCase();
}

// the island file suffixes an object of each classified kind stages as; a
// kind-less `ddic` name is checked against every kind the request asks it
// under (the request's own kinds, DOMA not among them). A CODE kind is
// checked as .clas.abap OR .intf.abap (fix round 1, M-1.4): the classified
// kind of a ZIF_ name is the name-prefix heuristic's `clas`, and presence
// by the one suffix asked every customer interface again every round.
const FILE_SUFFIXES = {
  clas: [".clas.abap", ".intf.abap"],
  intf: [".intf.abap", ".clas.abap"],
  tabl: [".tabl.xml"],
  dtel: [".dtel.xml"],
  doma: [".doma.xml"],
  ttyp: [".ttyp.xml"],
  shlp: [".shlp.xml"],
  ddic: [".tabl.xml", ".dtel.xml", ".ttyp.xml", ".shlp.xml"],
};

/** whether the island holds an object of this name and kind: the file its
 *  abapGit name stages as is among the island's basenames. Pure. */
export function objectFilePresent(name, kind, islandFiles) {
  const base = abapBaseOf(name);
  return (FILE_SUFFIXES[kind] ?? []).some((suffix) => islandFiles.has(`${base}${suffix}`));
}

/** H5x-1's presence rule over a classified name list: a name whose object
 *  is in the island -- or excluded from the build this run -- is dropped,
 *  never requested and never a gap, and counted: its finding is a cascade
 *  of that object's own findings, and asking the dumper for a name the
 *  island already holds is what asked three times for one interface on the
 *  bed. Pure. */
export function dropPresentNames(names, islandFiles, excludedObjects = new Set()) {
  let present = 0;
  const kept = names.filter((n) => {
    if (excludedObjects.has(n.name) === true) return false;
    if (objectFilePresent(n.name, n.kind, islandFiles) === true) {
      present += 1;
      return false;
    }
    return true;
  });
  return {names: kept, present};
}

/** the island's registered service classes: the MPC/DPC pairs the
 *  gen/hana-segw facts (tools/hana-segw-gen.mjs's from-dump.json) and the
 *  *.iwsv.xml / *.iwmo.xml files in the island name -- the same fields
 *  tools/segw-registry.mjs reads (SRH CLASS_NAME -> DPC, OHD CLASS_NAME ->
 *  MPC) -- each with its non-_EXT twin. A definition-level reference to a
 *  missing name in one of these is the service itself: the run fails, it is
 *  never excluded. */
export function registeredServiceClasses(root) {
  return serviceGuard(root).names;
}

/** whether the guard works by suffix alone: no gen/hana-segw facts with a
 *  service, and no island *.iwsv.xml / *.iwmo.xml -- on the bed run 15 the
 *  island had neither, the guard was inert, and the service's own DPC_EXT
 *  was excluded. The iteration line then says "service guard: by suffix, no
 *  registration". Pure. */
export function serviceGuardBySuffixOnly(root) {
  return serviceGuard(root).registered === false;
}

// the guard's sources and what they said: `names` is every protected class
// -- the registered MPC/DPC pairs, and ALWAYS (with or without a
// registration) the island's own classes of the seed suffixes _MPC,
// _MPC_EXT, _DPC, _DPC_EXT: the objects the walk started from, the dump's
// selected service package, recognisable by the suffixes when no
// registration names them; `registered` says a registration source existed.
function serviceGuard(root) {
  const names = new Set();
  // the names a source NAMED (a registration, an island file), apart from
  // the bases derived off an _EXT: the summary requires the named ones in
  // the island (H5x-4 B1), a derived base only when present
  const named = new Set();
  const add = (name) => {
    const upper = String(name ?? "").trim().toUpperCase();
    if (upper === "") return;
    names.add(upper);
    named.add(upper);
    if (/(?:_DPC|_MPC)_EXT$/.test(upper) === true) names.add(upper.replace(/_EXT$/, ""));
  };
  let registered = false;
  try {
    const facts = JSON.parse(readFileSync(join(root, "gen", "hana-segw", "from-dump.json"), "utf8"));
    for (const entry of facts.services ?? []) {
      add(entry.dpc);
      add(entry.mpc);
      registered = true;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const tag = (xml, name) => {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml);
    return m === null ? "" : m[1].trim();
  };
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/\.iwsv\.xml$/i.test(entry.name) === true) {
        const xml = readFileSync(join(dir, entry.name), "utf8");
        const head = /<_-IWBEP_-I_MGW_SRH>[\s\S]*?<\/_-IWBEP_-I_MGW_SRH>/.exec(xml)?.[0] ?? xml;
        add(tag(head, "CLASS_NAME"));
        registered = true;
      } else if (/\.iwmo\.xml$/i.test(entry.name) === true) {
        const xml = readFileSync(join(dir, entry.name), "utf8");
        const head = /<_-IWBEP_-I_MGW_OHD>[\s\S]*?<\/_-IWBEP_-I_MGW_OHD>/.exec(xml)?.[0] ?? xml;
        add(tag(head, "CLASS_NAME"));
        registered = true;
      } else if (/\.clas\.abap$|\.intf\.abap$/.test(entry.name) === true) {
        const stem = entry.name.replace(/\.(?:clas|intf)\.abap$/, "");
        if (/_(?:mpc|dpc)(?:_ext)?$/i.test(stem) === true) add(nameFromAbapFile(stem));
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  return {names, named, registered};
}

/** the seed classes the run summary checks (H5x-4 B1): `all` the guard's
 *  set, `named` those a registration or an island file named -- the ones
 *  that must be island objects. */
export function seedClasses(root) {
  const {names, named} = serviceGuard(root);
  return {all: names, named};
}

/** the framework-gaps.json list from the loop's accumulation map: one entry
 *  per distinct nameless finding text, the quoted member beside it where
 *  the shape has one, sorted by finding text, each used_by sorted by file,
 *  line, method. `isSeed(basename)` -- fix round 2, item 7: the nameless
 *  stubs of the SEED classes (the walk's starting service package) are
 *  this list's first section, flagged `seed: true` -- that list is the
 *  next slice's brief (the members our /IWBEP/ layer lacks). A use is
 *  listed once per (file, line, method), however many stub rounds met it
 *  (H5x-4 B1: the stub record counts unique pairs, so does this). Pure. */
export function frameworkGapList(gapFindings, isSeed = undefined) {
  const byUse = (a, b) => a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line || (a.method < b.method ? -1 : 1);
  const once = (uses) => [...new Map(uses.map((u) => [`${u.file}|${u.line}|${u.method}`, u])).values()];
  return [...gapFindings.values()]
    .map((entry) => ({...entry, used_by: once(entry.used_by).sort(byUse)}))
    .map((entry) => (isSeed !== undefined && entry.used_by.some((u) => isSeed(u.file) === true) === true
      ? {...entry, seed: true} : entry))
    .sort((a, b) => (b.seed === true ? 1 : 0) - (a.seed === true ? 1 : 0) ||
      (a.finding < b.finding ? -1 : a.finding > b.finding ? 1 : 0));
}

// a name is still PENDING when this iteration's request can still bring it:
// not asked yet, its object neither present in the island nor excluded this
// run, the dumper's answer neither missing nor refused. (A name the dumper
// was asked for always has its answer by the time a stub round runs -- the
// pending round is executed before the walk continues.) The stub rule, the
// eager list and the hold decision all read this one predicate; the
// EXCLUSION decision reads a stricter one -- and since H5x-2 it is the
// graph's gate (tools/hana-closure-graph.mjs graphDecide's pendingOf), the
// loop hands it in.
function pendingOf(name, kind, {asked, missingOf, refusedOf, presentFile, excludedObjects}) {
  return asked(name) === false && presentFile(name, kind) === false &&
    missingOf(name) === false && refusedOf(name) === false &&
    excludedObjects.has(name) === false;
}

// the quoted member token of a nameless finding, where the shape has one --
// the method, attribute or component the text says is missing. A Variable
// cascade's quoted token is the local variable, not the member: no token is
// extracted there, the finding text is the record. Pure.
const memberOf = (message) => {
  const m = /^(?:Method (?:or attribute )?|Attribute (?:or constant )?|Component )"([^"]+)"/.exec(String(message ?? ""));
  return m === null ? undefined : m[1];
};

/** one pass of the lazy-activation loop over ONE island file (H5x-1,
 *  reshaped by H5x-2): which of the file's method stubs to apply, which
 *  signatures to cut, which FRIENDS clauses to strip, what the names defer
 *  and what they ask eagerly. `refs` -- the object's structural references
 *  (tools/hana-closure-graph.mjs analyseIsland's unknowns); `goneOf(name)`
 *  says an object is excluded, or its name answered missing/refused (the
 *  FRIENDS strip's predicate). Returns {source, stubs, unmatched, eager,
 *  deferred, nameless, friendsStripped} -- `source` is the rewritten
 *  source when anything applied (the caller writes it back), `unmatched`
 *  is what no stub reaches -- the signature-line findings included, the
 *  decision's material beside the structural definition references. Pure. */
export function planStubPass({source, findings, basename, refs = [], missingOf = () => false, asked = () => false,
  refusedOf = () => false, islandFiles = new Set(), excludedObjects = new Set(), deferDdic = false, goneOf = () => false}) {
  // FRIENDS first: the cut stays inside the CLASS DEFINITION line, so the
  // findings' rows survive it (a friend that is gone costs a clause, not
  // the class)
  const friends = stripFriends(source, basename, goneOf);
  const work = friends.source;
  let blocks;
  try {
    blocks = methodBlocks(work, basename);
  } catch {
    // a file that does not parse is left whole: its findings stay in the
    // request, the way they always have -- a parse error is not a
    // definition-level reference
    return {unparseable: true, source, stubs: [], unmatched: findings, eager: [], deferred: [], nameless: [], friendsStripped: []};
  }
  // the class-constructor paths (B6): what a class constructor reaches runs
  // at load, so a name it waits for is eager even when it names code, and
  // once nothing is pending a raise on the path turns the constructor itself
  // into the signal stub
  const paths = constructorPaths(work, basename);
  const onConstructorPath = (block) => paths.reach.get(block.className)?.has(block.method) === true;
  const presentFile = (name, kind) => objectFilePresent(name, kind, islandFiles) === true;
  const pending = (name, kind) => pendingOf(name, kind, {asked, missingOf, refusedOf, presentFile, excludedObjects});
  const present = (name, kind) => presentFile(name, kind) === true && excludedObjects.has(name) === false;
  const findingOf = (refs2, fallbackFinding) => {
    const withFinding = refs2.find((r) => r.finding !== undefined);
    return withFinding?.finding ?? fallbackFinding?.raw ?? "";
  };
  // the signature-level misses (report item 8): a parameter typed by a
  // name the build does not provide. While its DDIC name is pending the
  // signature stays; once the name is answered -- or is a code kind
  // staying lazy -- the parameter is cut and the body stubbed
  const sigRefs = new Map();
  for (const r of refs) {
    if (r.level !== "signature") continue;
    const list = sigRefs.get(r.method) ?? [];
    list.push(r);
    sigRefs.set(r.method, list);
  }
  const sigStubs = [];
  const sigDeferred = [];
  const sigEager = [];
  const sigCut = new Map();
  const sigMethods = new Set();
  for (const [method, list] of sigRefs) {
    const code = [];
    const ddic = [];
    const pendingDdic = [];
    for (const r of list) {
      const nk = {name: r.name, kind: requestKindOf(r.name, r)};
      if (isCodeKind(nk.kind) === true) {
        if (present(nk.name, nk.kind) === false) code.push({...nk, finding: findingOf(list, undefined)});
      } else if (pending(nk.name, nk.kind) === true) pendingDdic.push({...nk, finding: findingOf(list, undefined)});
      else ddic.push(nk);
    }
    const block = blocks.find((b) => b.method === method);
    if (pendingDdic.length > 0 || block === undefined) {
      // the dumper can still answer, or there is no body to stub: the
      // signature stays whole, the names go out eager
      sigEager.push(...pendingDdic);
      continue;
    }
    sigMethods.add(method);
    if (cutVarsBy(list).length > 0) sigCut.set(method, cutVarsBy(list));
    const missingKinds = [...code, ...ddic];
    sigStubs.push({...block, missing: missingKinds.map((n) => n.name), missingKinds,
      finding: findingOf(list, findings.find((f) => sigLineOf(refs, list, f) === true)),
      reason: stubReasonText(findingOf(list, undefined) || `signature type ${list[0].name} not found`), signature: true});
    sigDeferred.push(...code);
  }
  // the body stubs over the blocks whose bodies the decision keeps: the
  // nameless stubs' findings are the framework work list
  const stubs = [];
  const deferred = [];
  const eager = [];
  const nameless = [];
  let dropped = 0;
  for (const block of blocks) {
    if (sigMethods.has(block.method) === true) continue;
    const inside = findings.filter((f) => f.line > block.headerEnd.row && f.line < block.endStart.row);
    if (inside.length === 0) continue;
    const methodRefs = refs.filter((r) => r.level === "method" && r.method === block.method);
    const {missing, missingKinds} = blockNames(methodRefs, inside);
    const stub = {...block, missing, missingKinds, finding: inside[0].raw, reason: stubReasonText(inside[0])};
    const byName = new Map(missingKinds.map((n) => [n.name, n]));
    const forName = (nk) => ({
      name: nk.name, kind: nk.kind,
      finding: byName.get(nk.name)?.finding ?? stub.finding,
      ...(byName.get(nk.name)?.message !== undefined ? {message: byName.get(nk.name).message} : {}),
    });
    const fallbackNames = classifyFindings(inside.filter((f) => refMatched(methodRefs, f) === false)).names;
    const collectNameless = () => {
      for (const f of inside) {
        if (refMatched(methodRefs, f) === true || fallbackNames.some((n) => n.finding === f.raw) === true) continue;
        const member = memberOf(f.message);
        nameless.push({finding: f.message, ...(member !== undefined ? {member} : {}), line: f.line, method: stub.method});
      }
    };
    const code = missingKinds.filter((nk) => isCodeKind(nk.kind) === true);
    const ddic = missingKinds.filter((nk) => isCodeKind(nk.kind) === false);
    if (onConstructorPath(block) === true && missingKinds.some((nk) => pending(nk.name, nk.kind) === true)) {
      // on a class constructor's path every pending name is asked now, code
      // kinds included, and the body stays one more round: the dumper may
      // still bring what the constructor needs at load
      for (const nk of missingKinds) {
        if (pending(nk.name, nk.kind) === true) eager.push(forName(nk));
      }
      dropped += 1;
      continue;
    }
    if (deferDdic === true) {
      // --defer-ddic: round 3's behaviour -- every name of a stubbed
      // method is lazy, even the dictionary's
      stubs.push(stub);
      if (stub.missing.length === 0) collectNameless();
      for (const nk of missingKinds) {
        if (present(nk.name, nk.kind) === false) deferred.push(forName(nk));
      }
      continue;
    }
    if (code.length > 0) {
      // a code-kind name remains: the method is stubbed, the code names
      // stay deferred (lazy, grows on the miss), and its DDIC names are
      // asked from the dumper in this iteration -- eager, not deferred
      stubs.push(stub);
      for (const nk of code) {
        if (present(nk.name, nk.kind) === false) deferred.push(forName(nk));
      }
      for (const nk of ddic) {
        if (pending(nk.name, nk.kind) === true) eager.push(forName(nk));
      }
      continue;
    }
    if (ddic.some((nk) => pending(nk.name, nk.kind) === true)) {
      // a dictionary name this iteration's request can still bring: the
      // body stays one more round, the finding rejoins the classification
      dropped += 1;
      continue;
    }
    // nothing is pending: nameless cascades, present-only names,
    // resolved-but-still-failing and dead names alike -- the body goes
    // (fix round 1, M-1.1: round 0's keep-branch kept the bed's DPC_EXT
    // red forever on nameless member cascades)
    stubs.push(stub);
    if (stub.missing.length === 0) collectNameless();
  }
  // ONE rewrite pass: every stub's positions come from the same parse of
  // `work` (the FRIENDS-stripped source), so they must all be applied over
  // that one source. Applying the signature stubs in a second pass over the
  // body-stubbed source computed their offsets against stale rows and ran
  // offsetAt past the rewritten source's end on a class whose body stubs had
  // moved its lines (bed run 17: `Cannot read properties of undefined
  // (reading 'length')`, first iteration, right after the first build; a
  // single signature stub never even reaches applyStubs' sort comparator,
  // which is why the signature-cut scenario stayed green while the bed died).
  // a class constructor whose path holds a stub raise -- one applied now or
  // one already in the source -- becomes the signal stub itself, carrying
  // the names the path waits for: the miss is recorded, the load goes on
  for (const [cls, reach] of paths.reach) {
    if (paths.signalled.has(cls) === true) continue;
    const ctor = blocks.find((b) => b.className === cls && b.method === "CLASS_CONSTRUCTOR");
    if (ctor === undefined) continue;
    const now = [...stubs, ...sigStubs].filter((st) => st.className === cls && reach.has(st.method) === true);
    if (now.some((st) => st.method === "CLASS_CONSTRUCTOR") === true) continue;
    const before = [...reach].filter((m) => paths.raised.has(`${cls}|${m}`) === true && now.some((st) => st.method === m) === false);
    if (now.length === 0 && before.length === 0) continue;
    const missing = [...new Set(now.flatMap((st) => st.missing))];
    const texts = [...now.filter((st) => st.missing.length === 0).map((st) => st.reason),
      ...before.map((m) => paths.raised.get(`${cls}|${m}`))].filter((t) => t !== "");
    const methods = [...now.map((st) => st.method), ...before].join(", ");
    stubs.push({...ctor, missing, missingKinds: [], finding: `class constructor reaches stubbed ${methods}`,
      // the texts are ABAP literal contents already (a stub's reason, a raise
      // read off the source), quotes doubled: used as they are
      reason: texts[0] ?? stubReasonText(`class constructor reaches stubbed ${methods}`), constructorPath: true});
  }
  const allStubs = [...stubs, ...sigStubs];
  let outSource = work;
  if (allStubs.length > 0) outSource = applyStubs(outSource, allStubs);
  for (const [method, vars] of sigCut) {
    outSource = cutSignatureParams(outSource, basename, method, vars).source;
  }
  nameless.sort((a, b) => a.finding < b.finding ? -1 : a.finding > b.finding ? 1 : 0);
  return {source: outSource, stubs: [...stubs, ...sigStubs], unmatched: findings.filter((f) =>
    blocks.some((b) => f.line > b.headerEnd.row && f.line < b.endStart.row) === false),
  eager: [...eager, ...sigEager], deferred: [...deferred, ...sigDeferred], nameless,
  friendsStripped: friends.stripped};
}

// the parameter names a signature cut removes: the reference's `var` (the
// UnknownType's own name is the parameter)
const cutVarsBy = (list) => [...new Set(list.map((r) => r.var).filter((v) => v !== undefined))];
// whether a finding sits on a signature reference's line (the raise reason
// of a signature stub prefers it)
const sigLineOf = (refs, list, f) => list.some((r) => Math.abs((r.line ?? 0) - f.line) <= 2) && refMatched(refs, f);
