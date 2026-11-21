// The per-object front-end cache of the osgo fast path. README:
// tools/gogen/osgo-incr.md; the measurements and the design against the
// runners' whole-tree cache: docs/osgo-fast-rebuild.md "The incremental
// front end".
//
// A full front end (compileOsg without a fast proof) records, per object of
// the tree and the libraries, what its lowering produced (the class IRs, the
// writes it made to the shared program state, in order) and what it depended
// on (the registry objects it read, the classes and interfaces it named, the
// owner of every generated type name). A fast build -- osgo-fast.mjs proved
// that only the *content* of existing classes and interfaces changed since
// the live generation -- re-lowers the edited objects and everything that
// transitively depends on them, in a registry that holds only that closure
// plus every non-class object, and takes every other object's lowered IR
// from this cache, replaying the recorded writes in the original order so
// the shared state is exactly the state the full build would have had.
//
// Anything it cannot prove refuses, and the caller runs the full front end:
// a missing or unreadable entry, a non-serialisable IR, a syntax error in a
// re-lowered object, a changed broken-set, an anonymous structure an edit
// could have renamed. The cache never guesses.
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {deserialize, serialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {compileProgram, defaultValue, aliasTarget} from "./frontend.mjs";
import {listListed} from "./host-io-compat.mjs";
import {caughtIndex} from "./frontend-hierarchy.mjs";
import {referencedClasses} from "./emit-go.mjs";
import {callsIn, goSymbol} from "./go-layers.mjs";
import {objectOfFile} from "./osgo-layers.mjs";
import {portable, toolIdentity} from "./frontend-object-cache.mjs";
import {prepareDynamicStatics} from "./frontend-dynamic-call.mjs";
import {AnonShapes, anonOrigins, anonFirstMoved} from "./osgo-incr-anon.mjs";
import {semanticDeps} from "./osgo-incr-deps.mjs";
import {readSealedCache, unsealCache} from "./osgo-incr-meta.mjs";

export const SCHEMA = "osgo-incr/6";
const sha = (value) => createHash("sha256").update(value).digest("hex");
const upper = (text) => String(text).toUpperCase();
// listListed, not readdirSync: the folders here are compileOsg's layer list,
// and a listed folder that is not on disk reads as empty, the one rule
// tools/osd-inputs.mjs walkListed states (H3/FIX-4; H5b fix round 2: the
// registryFiles/proof walks hit the same list the full front end walks)
const walk = (d) => listListed(d).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
/** every ABAP word of a source, namespace forms included */
const wordsOf = (text) => new Set(text.toUpperCase().match(/(?:\/[A-Z0-9_]+\/)?[A-Z_][A-Z0-9_]*/g) ?? []);
const keyOf = (type, name) => `${type} ${name}`;

/** the registry object a file belongs to: ["CLAS"|"INTF"|"FUGR"|"DDIC"|"OTHER", NAME] */
export function objectOf(fileName) {
  const name = fileName.split("/").at(-1);
  if (/\.clas\./i.test(name)) return ["CLAS", objectOfFile(name)];
  if (/\.intf\./i.test(name)) return ["INTF", objectOfFile(name)];
  if (/\.fugr\./i.test(name)) return ["FUGR", objectOfFile(name)];
  // `type` is the ABAP type pool (`abap.type.abap` of a library): ABAP the
  // syntax pass resolves (`abap_component_tab` of the RTTI classes), not XML
  const kind = /\.(tabl|ttyp|dtel|doma|view|enqu|msag|prog|type|w3mi|shlp|tran|webi|xslt|suso|suvo|tobj|iacg|iamu|iext|iobj|sfp|susc)(?:\.[a-z_]+)?\.(abap|xml)$/i.exec(name)?.[1];
  return [kind ? "DDIC" : "OTHER", objectOfFile(name)];
}

/** the files compileProgram loads, the way its own walk decides: absolute
 *  path -> object key. A read-side `skip` narrows the registry to a subset
 *  of exactly these files, so no other rule can differ. */
export function registryFiles(folders, hidden, includeTests) {
  const files = new Map();
  for (const folder of folders) {
    for (const file of walk(folder)) {
      const name = file.split("/").at(-1);
      if (hidden.has(file) || !/\.(abap|xml)$/i.test(name) || /\.ddls\.xml$/i.test(name)) continue;
      if (/\.clas\.testclasses\.abap$/i.test(name)
          && !(includeTests === true || (includeTests instanceof Set && includeTests.has(objectOfFile(name))))) continue;
      const [type, object] = objectOf(name);
      if (type === "OTHER") continue;
      files.set(file, keyOf(type, object));
    }
  }
  return files;
}

/** the class, interface and type names one lowered class IR spells: what
 *  another object's lowering could have read through it */
function irNames(ir) {
  const refs = new Set(), types = new Set();
  const visit = (node) => {
    if (Array.isArray(node)) { node.forEach(visit); return; }
    if (!node || typeof node !== "object") return;
    if (node.e === "call" && node.owner) refs.add(node.owner);
    if (node.cls) refs.add(node.cls);
    const t = node.type;
    if (t && typeof t === "object") visitType(t);
    for (const [k, v] of Object.entries(node)) if (k !== "type") visit(v);
  };
  const visitType = (t) => {
    if (Array.isArray(t)) { t.forEach(visitType); return; }
    if (!t || typeof t !== "object") return;
    if (t.k === "ref" && t.name) refs.add(t.name);
    if (t.k === "struct" && t.go) types.add(t.go);
    if (t.row) visitType(t.row);
  };
  visit(ir);
  return {refs, types};
}

/** the collections whose lowering-time writes replay at read time. Fields
 *  assigned later (locals, functionModules, lockObjects, the final-output
 *  analyses) are rebuilt by the fresh compile, not replayed. */
const RECORDED = ["structs", "consts", "sigs", "events", "missing", "dynStatics", "excAttrs", "intfOwnAttrs",
  "badStructs", "ddicOutputLen", "interfaces", "interfaceAttrs", "skipped", "partial", "classes"];

/** every op of one collection an object's lowering made, all its passes in
 *  order (a payload holds them per segment: one segment per `enter`) */
const flatOps = (payload, coll) => (payload?.segs ?? []).flatMap((seg) => seg[coll] ?? []);


/** one recorded op, applied to a collection */
function applyOp(target, op) {
  const [method, ...args] = op;
  if (method === "set") target.set(args[0], args[1]);
  else if (method === "add") target.add(args[0]);
  else if (method === "delete") target.delete(args[0]);
  else if (method === "clear") target.clear();
  else if (method === "push") target.push(args[0]);
}

/** where a write outside every object's mark (a global pass) sits in the
 *  sequence of segments: "A" before the first segment of the discovery
 *  phase, "B" after its last, "C" before the first segment of the lowering
 *  phase, "D" after its last; null anywhere else. With no segment in a
 *  phase its two slots are one ("AB" / "CD"). */
function straySlot(phase, at, count) {
  if (count === 0) return phase === 0 ? "AB" : "CD";
  if (at === 0) return phase === 0 ? "A" : "C";
  if (at === count) return phase === 0 ? "B" : "D";
  return null;
}

// ---------------------------------------------------------------------------
// the write side
// ---------------------------------------------------------------------------

/** a proxy over one of the shared collections that turns every mutating
 *  call into an op (`["set",k,v]`, `["add",v]`, `["delete",k]`, `["clear"]`,
 *  `["push",v]`), handed to `onOp` -- the write side records the ops of an
 *  object's lowering, the read side the ops of the fresh one, and both then
 *  agree on what a replay of those ops does */
function opProxy(coll, value, onOp) {
  return new Proxy(value, {
    get(target, method) {
      const member = target[method];
      if (typeof member !== "function") return member;
      if (method === "set") return (k, v) => { onOp(["set", k, v]); return target.set(k, v); };
      if (method === "add") return (v) => { onOp(["add", v]); return target.add(v); };
      if (method === "delete") return (k) => { onOp(["delete", k]); return target.delete(k); };
      if (method === "clear") return () => { onOp(["clear"]); return target.clear(); };
      if (method === "push") return (...vs) => { for (const v of vs) onOp(["push", v]); return target.push(...vs); };
      return member.bind(target);
    },
  });
}

/**
 * The recorder a full compileOsg installs into compileProgram. Nothing it
 * does changes the compile; `finish` writes the cache of one generation.
 * @param {{root: string, folders: string[], hidden: Set<string>, objects: string[], includeTests: Set<string>}} o
 */
export function incrRecorder({root, folders, hidden, objects, includeTests}) {
  const buckets = new Map();
  const order = []; // first-enter order
  // the full build's write sequence: one segment per `enter`, in the order
  // compileProgram enters them -- the local discovery, the class pass, the
  // local classes after every class, the function groups -- as
  // [key, occurrence of that key, phase]. An object's writes belong to the
  // segment they were made in, not to the object as a whole: the locals
  // pass writes an owner's local types after EVERY class, and a merge that
  // grouped them at the owner's slot moved them (LCL_STACK__TY_DATA).
  const segments = [];
  const phaseCount = [0, 0];
  const anonNamed = new Map(); // declaration path -> the name its instance got (null: ambiguous)
  // declaration path -> {object key ("" for a global pass): the first
  // position in the segment sequence it reached the instance at}; a global
  // pass sits between two segments (n + 0.5). The full build names an
  // instance after its FIRST reacher; a fast build checks that the first
  // reacher did not move (anonFirstMoved, osgo-incr-anon.mjs)
  const anonReach = new Map();
  let current = null;
  let lowering = false;
  let program;
  const bucket = (key) => {
    if (!buckets.has(key)) buckets.set(key, {key, segs: [], reads: new Set(), supplied: [], rttiDefs: []});
    return buckets.get(key);
  };
  // a write outside any object's mark is a global pass, which the fast
  // build runs again over its own registry; recorded here is only WHERE it
  // ran in the segment sequence, so the reader can put its own there and
  // refuse when the layout is not one it can reproduce
  const straySlots = {};
  const record = (coll, op) => {
    if (current === null) {
      // the phase's segment count is not known yet: remember the position,
      // classify it at finish
      const phase = lowering ? 1 : 0;
      (straySlots[coll] ??= []).push([phase, phaseCount[phase]]);
      return;
    }
    const seg = bucket(current).segs.at(-1);
    (seg[coll] ??= []).push(op);
  };
  const proxy = (coll, value) => opProxy(coll, value, (op) => record(coll, op));
  const ownership = new Map();
  return {
    // the compileProgram hooks (frontend.mjs)
    prepare(p, reg) {
      program = p;
      for (const coll of RECORDED) {
        if (p[coll] instanceof Map || p[coll] instanceof Set || Array.isArray(p[coll])) p[coll] = proxy(coll, p[coll]);
      }
      // which name the lowering gave each declared anonymous structure it
      // reached (anonOrigins): the reader pins a fresh lowering to it
      const anon = p.anonStructs;
      let origins;
      const note = (t, go) => {
        // the name each declared instance got, by every path that names it;
        // two names for one path (it cannot happen in one registry) poison it
        origins ??= anonOrigins(reg);
        const who = current ?? "", at = current === null ? segments.length - 0.5 : segments.length - 1;
        for (const path of origins.get(t) ?? []) {
          if (anonNamed.has(path) && anonNamed.get(path) !== go) anonNamed.set(path, null);
          else anonNamed.set(path, go);
          if (!anonReach.has(path)) anonReach.set(path, {});
          if (!Object.hasOwn(anonReach.get(path), who)) anonReach.get(path)[who] = at;
        }
      };
      p.anonStructs = {
        get(t) { const go = anon.get(t); if (go !== undefined) note(t, go); return go; },
        set(t, go) { note(t, go); anon.set(t, go); return this; },
        // a probe that finds a name is a reach too: the read side's has()
        // answers through get(), and both sides must count the same reaches
        has(t) { const go = anon.get(t); if (go !== undefined) note(t, go); return go !== undefined; },
      };
      const get = reg.getObject.bind(reg);
      reg.getObject = (type, name) => {
        const value = get(type, name);
        if (type && name && current !== null) bucket(current).reads.add(keyOf(upper(type), upper(name)));
        return value;
      };
    },
    enter(key) {
      if (!order.includes(key)) order.push(key);
      const b = bucket(key);
      b.segs.push({});
      segments.push([key, b.segs.length - 1, lowering ? 1 : 0]);
      phaseCount[lowering ? 1 : 0] += 1;
      current = key;
    },
    exit() { current = null; },
    lowering() { lowering = true; },
    suppliedOf(owner, contributed) { bucket(keyOf("CLAS", owner)).supplied = contributed; },
    rttiOf(owner, defs) { bucket(keyOf("CLAS", owner)).rttiDefs = defs; },
    ownershipOf(name, value) { ownership.set(upper(name), {names: [...value.names], dynamic: value.dynamic}); },
    /** write the cache of generation `gen`; returns what it wrote */
    finish({gen}) {
      const dir = join(root, "build", "osgo-incr", gen);
      // a generation is usable only once its database record is written and
      // the stamp over both is (dbCacheWrite, osgo-incr-meta.mjs): an older
      // stamp of this directory must not certify what is written now
      unsealCache(dir);
      const reg = program.reg;
      // which bucket pushed each class, off the recorded push ops
      const pushedNames = new Map(); // class name -> bucket key
      for (const b of order) for (const op of flatOps(bucket(b), "classes")) if (op[0] === "push") pushedNames.set(op[1].name ?? op[1], b);
      const supers = Object.fromEntries([...reg.getObjects()].filter((o) => o.getType() === "CLAS")
        .map((o) => [upper(o.getName()), o.getDefinition()?.getSuperClass()?.toUpperCase() ?? null]));
      // per pushed class or interface: the symbols its generated type names
      // start with (a class's local types, an interface's, and the anonymous
      // structure named after the class that first used its shape)
      const symbolOwner = new Map([...pushedNames].map(([name, key]) => [goSymbol(name), key]));
      for (const intf of program.interfaces) symbolOwner.set(goSymbol(intf), keyOf("INTF", intf));
      const symbols = [...symbolOwner.keys()].sort((a, b) => b.length - a.length);
      const anonNames = new Map([...program.structs].filter(([, st]) => st?.qname === undefined));
      const entries = {};
      const filesByObject = new Map();
      for (const [file, key] of registryFiles(folders, hidden, includeTests)) {
        if (!filesByObject.has(key)) filesByObject.set(key, []);
        filesByObject.get(key).push(file);
      }
      let allPortable = true;
      const ooKeys = new Set([...filesByObject.keys()].filter((k) => k.startsWith("CLAS ") || k.startsWith("INTF ")));
      for (const [key, b] of buckets) {
        const irs = program.classes.filter((c) => pushedNames.get(c.name) === key);
        const deps = new Set(b.reads);
        // what the syntax pass resolved through another object (a type alias
        // the IR keeps no name of, osgo-incr-deps.mjs), and every class or
        // interface the object's text spells (a dynamic name in a literal):
        // invalidation edges, not only registry members
        const semantic = semanticDeps(reg, key, objectOf);
        for (const dep of semantic ?? []) deps.add(dep);
        for (const f of filesByObject.get(key) ?? []) {
          if (!/\.abap$/i.test(f)) continue;
          for (const w of wordsOf(readFileSync(f, "utf8"))) for (const t of ["CLAS", "INTF"]) if (ooKeys.has(keyOf(t, w))) deps.add(keyOf(t, w));
        }
        const anonRefs = new Set();
        for (const ir of irs) {
          const names = irNames(ir);
          const bodyRefs = new Set();
          for (const method of [...ir.methods ?? [], ...(ir.stubs ?? [])]) callsIn(method.body ?? [], bodyRefs);
          if (Object.hasOwn(ir, "constructor")) callsIn(ir.constructor?.body ?? [], bodyRefs);
          for (const ref of [...referencedClasses({...program, classes: [ir], structs: new Map()}), ...bodyRefs, ...names.refs]) {
            for (const type of ["CLAS", "INTF"]) if (buckets.has(keyOf(type, ref))) deps.add(keyOf(type, ref));
          }
          if (ir.super && buckets.has(keyOf("CLAS", ir.super))) deps.add(keyOf("CLAS", ir.super));
          for (const intf of ir.interfaces ?? []) if (buckets.has(keyOf("INTF", intf))) deps.add(keyOf("INTF", intf));
          for (const name of names.types) {
            const owner = symbolOwner.get(symbols.find((s) => name.startsWith(s + "__")));
            if (owner !== undefined && owner !== key) { deps.add(owner); if (anonNames.has(name)) anonRefs.add(name); }
          }
        }
        deps.delete(key);
        /** @type {any} */ const payload = {key, ir: Object.fromEntries(irs.map((c) => [c.name, c])),
          segs: b.segs, reads: [...b.reads], supplied: b.supplied, rttiDefs: b.rttiDefs};
        let ok = true;
        try { if (!portable(payload)) ok = false; } catch { ok = false; }
        // the file name the registry gives each pushed class (status.mjs
        // counts a pack's objects by it): recorded as the full build has it
        const regFiles = Object.fromEntries(irs.map((c) => [c.name, (reg.getObject("CLAS", c.name) ?? reg.getObject("INTF", c.name))?.getFiles?.()[0]?.getFilename?.()])
          .filter(([, f]) => f !== undefined));
        const entry = {deps: [...deps].sort(), reads: [...b.reads].sort(), pushed: irs.map((c) => c.name), regFiles,
          anonRefs: [...anonRefs].sort(), broken: false, segs: b.segs.length,
          super: irs.find((c) => !c.name.includes(":"))?.super ?? supers[key.slice(5)] ?? null,
          files: Object.fromEntries((filesByObject.get(key) ?? []).map((f) => [relative(root, f), sha(readFileSync(f))]))};
        if (ok) {
          try {
            mkdirSync(join(dir, "e"), {recursive: true});
            const bytes = deflateRawSync(serialize(payload));
            const file = join(dir, "e", `${sha(key)}.bin`);
            const temp = `${file}.${process.pid}.pending`;
            writeFileSync(temp, bytes);
            renameSync(temp, file);
            entry.digest = sha(bytes);
          } catch { ok = false; }
        }
        entry.portable = ok;
        if (semantic === null) entry.depsKnown = false;
        if (!ok) allPortable = false;
        entries[key] = entry;
      }
      const broken = [...program.broken].map(upper);
      for (const name of broken) if (!entries[keyOf("CLAS", name)] && !entries[keyOf("INTF", name)]) entries[keyOf("CLAS", name)] = {deps: [], reads: [], pushed: [], anonRefs: [], broken: true, super: supers[name] ?? null, files: {}, portable: true};
      // the global passes' slots, per collection; a write in the middle of
      // a phase is a layout the reader cannot reproduce, and it refuses
      const slots = {};
      let strayLayoutOk = true;
      for (const [coll, positions] of Object.entries(straySlots)) {
        for (const [phase, at] of positions) {
          const slot = straySlot(phase, at, phaseCount[phase]);
          if (slot === null) strayLayoutOk = false;
          else (slots[coll] ??= new Set()).add(slot);
        }
      }
      // the classes whose constructor the emission calls with every argument
      // omitted (emit-constructors.ts: the DEFAULTs resolve through the
      // registry, in the class that declares the constructor), and the
      // classes that inherit it: a fast build's registry must hold them
      const byName = new Map(program.classes.map((c) => [c.name, c]));
      const ctorDefaults = new Set();
      for (const cls of program.classes) {
        // the same walk emit-constructors.ts makes, expression for expression
        let at = cls;
        while (at && !at.constructor && !at.ctorParams) at = at.super ? byName.get(at.super) : undefined;
        const params = at?.constructor?.params ?? at?.ctorParams ?? [];
        if (params.length === 0) continue;
        for (const c of [cls, at]) { const key = pushedNames.get(c.name); if (key !== undefined) ctorDefaults.add(key); }
      }
      const index = {schema: SCHEMA, tool: toolIdentity(), folders, objects, order, segments, strayLayoutOk,
        ctorDefaults: [...ctorDefaults].sort(),
        anonNamed: Object.fromEntries(anonNamed),
        anonReach: Object.fromEntries(anonReach),
        straySlots: Object.fromEntries(Object.entries(slots).map(([c, s]) => [c, [...s].sort()])),
        classes: program.classes.map((c) => [pushedNames.get(c.name), c.name]),
        entries, broken, supers, wanted: [...program.wanted],
        // the CDS views are read off the .ddls.asddls sources, which the
        // closure registry never holds (registryFiles takes .abap/.xml
        // only), so the fast build's own registry cannot rebuild them -- and
        // a CDS source is not a class or interface, so on the fast path it
        // cannot have changed either; the recorded map is the answer
        cdsViews: {...program.cdsViews},
        diagnostics: program.diagnostics.map((d) => `${upper(d.object)}\0${d.message}`),
        rtti: {structs: [...program.rtti.structs], known: [...program.rtti.known], classSupers: [...program.rtti.classSupers]},
        ownership: [...ownership],
        aliased: [...reg.getObjects()].filter((o) => o.getType() === "CLAS" && ((o.getDefinition()?.getAliases?.().getAll?.() ?? []).length > 0)).map((o) => upper(o.getName())),
        registryOrder: [...reg.getObjects()].map((o) => keyOf(o.getType(), upper(o.getName()))),
        includeTests: [...includeTests].sort(), allPortable};
      writeIndex(dir, index);
      pruneGenerations(join(root, "build", "osgo-incr"), gen);
      return {dir, objects: Object.keys(entries).length, allPortable};
    },
  };
}

function writeIndex(dir, index) {
  mkdirSync(dir, {recursive: true});
  const file = join(dir, "index.json"), temp = `${file}.${process.pid}.pending`;
  writeFileSync(temp, JSON.stringify(index));
  renameSync(temp, file);
}

/** keep the newest few generations of the cache (a fast build reads the live
 *  one; older ones only take space) */
function pruneGenerations(root, current) {
  try {
    const gens = readdirSync(root, {withFileTypes: true}).filter((e) => e.isDirectory()).map((e) => ({name: e.name, used: statSync(join(root, e.name)).mtimeMs})).sort((a, b) => b.used - a.used);
    for (const {name} of gens.slice(3)) if (name !== current) rmSync(join(root, name), {recursive: true, force: true});
  } catch { /* cache housekeeping must not fail a build */ }
}

// ---------------------------------------------------------------------------
// the read side
// ---------------------------------------------------------------------------


/**
 * The program of a fast build, assembled from the cache of the live
 * generation plus fresh lowerings of the edited objects and their
 * dependents, or why that cannot be done.
 * @param {{root: string, folders: string[], objects: string[], hidden: Set<string>, includeTests: Set<string>, proof: {ok: true, base: string, changed: string[]}}} o
 */
export function incrAssemble({root, folders, objects, hidden, includeTests, proof}) {
  const dir = join(root, "build", "osgo-incr", proof.base);
  const notes = [];
  // the index, the database record and the stamp over both, validated as a
  // whole (osgo-incr-meta.mjs): a cache a build left half-written, or one
  // whose metadata does not have the shape this reader walks, is a miss
  const sealed = readSealedCache(dir, proof.base);
  if (!sealed.ok) return {ok: false, reason: sealed.reason};
  const index = sealed.index;
  if (index.schema !== SCHEMA) return {ok: false, reason: `the per-object cache has schema ${index.schema}, not ${SCHEMA}`};
  if (index.tool !== toolIdentity()) return {ok: false, reason: "the front end changed since the cache was written"};
  if (JSON.stringify(index.folders) !== JSON.stringify(folders)) return {ok: false, reason: "the layer folders changed since the cache was written"};
  if (JSON.stringify(index.objects) !== JSON.stringify(objects)) return {ok: false, reason: "the object list changed since the cache was written"};
  if (JSON.stringify(index.includeTests) !== JSON.stringify([...includeTests].sort())) return {ok: false, reason: "the ABAP Unit owners changed since the cache was written"};

  const edited = new Set();
  for (const file of proof.changed) {
    const [type, name] = objectOf(file);
    if (type !== "CLAS" && type !== "INTF") return {ok: false, reason: `${file}: the edit is not of a class or interface`};
    // an interface is not lowered on its own -- no entry -- but every object
    // that implements or names it depends on it, and its methods are
    // computed again from its (edited) definition either way
    if (type === "CLAS" && !index.entries[keyOf(type, name)]) return {ok: false, reason: `${file}: the cache has no entry for ${type} ${name}`};
    edited.add(keyOf(type, name));
  }
  // what a fast build must re-lower: the edited objects and, transitively,
  // every object that depends on one (read it, called it, named a type it
  // owns); an entry whose IR did not serialise always re-lowers
  const dependents = new Map();
  for (const [key, entry] of Object.entries(index.entries)) for (const dep of entry.deps ?? []) {
    if (!dependents.has(dep)) dependents.set(dep, []);
    dependents.get(dep).push(key);
  }
  const relower = new Set(edited);
  for (let queue = [...edited]; queue.length > 0;) {
    const next = [];
    for (const key of queue) for (const dep of dependents.get(key) ?? []) if (!relower.has(dep)) { relower.add(dep); next.push(dep); }
    queue = next;
  }
  for (const [key, entry] of Object.entries(index.entries)) if (entry.portable === false || entry.depsKnown === false) relower.add(key);
  notes.push(`re-lowering ${relower.size} of ${Object.keys(index.entries).length} objects (edited: ${[...edited].join(", ")})`);

  // the registry of the fast build: every non-class object, plus the
  // reference closure of the classes it re-lowers -- their recorded reads
  // and deps, and every class whose name any member's text spells (a
  // reference the lowering stubs out is in neither recorded set, and
  // abaplint's syntax pass resolves it anyway)
  const allFiles = registryFiles(folders, hidden, includeTests);
  const byKey = new Map(); // object key -> [files]
  for (const [file, key] of allFiles) {
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(file);
  }
  const need = new Set();
  const queue = []; // every member whose references still walk: the classes
  // re-lowered plus every non-class object, all of them in the registry
  for (const [key, files] of byKey) {
    if (key.startsWith("CLAS ") && !relower.has(key)) continue;
    for (const f of files) need.add(f);
    queue.push(key);
  }
  // the CDS sources: compileProgram reads their SQL view names off them,
  // and the lowering (a SELECT from a CDS name) and the table registry ask
  // for those; registryFiles leaves them out, they are not registry objects
  for (const folder of folders) for (const f of walk(folder)) if (/\.ddls\.asddls$/i.test(f) && !hidden.has(f)) need.add(f);
  // and every other file compileProgram loads that registryFiles does not
  // map (a BDEF, a DDLS's XML, any type it does not name): they are no
  // class, so the full build's registry holds them all, and abaplint
  // enumerates its objects in the order a NAME first appeared -- a
  // behaviour definition in src/ puts ZI_RAP_NOTE before a view of gen/,
  // and the table pass writes its row types in that order
  for (const folder of folders) {
    for (const f of walk(folder)) {
      const name = f.split("/").at(-1);
      if (hidden.has(f) || allFiles.has(f) || !/\.(abap|xml)$/i.test(name) || /\.clas\./i.test(name)) continue;
      need.add(f);
    }
  }
  const wordCache = new Map();
  const words = (key) => {
    if (wordCache.has(key)) return wordCache.get(key);
    const set = new Set();
    for (const f of byKey.get(key) ?? []) if (/\.abap$/i.test(f)) for (const w of wordsOf(readFileSync(f, "utf8"))) set.add(w);
    wordCache.set(key, set);
    return set;
  };
  const enqueued = new Set(queue.filter((k) => k.startsWith("CLAS ")));
  // the classes whose constructor DEFAULTs the emission resolves through
  // the registry (emit-constructors.ts, CREATE OBJECT ... TYPE (name)), for
  // every class of the program, cached or not
  for (const key of index.ctorDefaults ?? []) {
    if (relower.has(key) || !byKey.has(key) || enqueued.has(key)) continue;
    for (const f of byKey.get(key)) need.add(f);
    enqueued.add(key);
    queue.push(key);
  }
  for (let i = 0; i < queue.length; i += 1) {
    const key = queue[i];
    // `reads` alone is not what the registry must hold: abaplint's syntax
    // pass resolves a type the lowering never calls getObject for (the class
    // of a TYPE REF TO in a signature), which `deps` names -- and it must
    // resolve for every object in the registry, not only the classes this
    // build re-lowers, because findIssues checks them all against it. A
    // reference in a statement the lowering stubs out is in neither set, so
    // every member's words are candidates too (a support object of this
    // shape, zcl_stg_json_text spelling zcl_stg_json, refused the first
    // real-tree run)
    const entry = index.entries[key];
    const names = new Set([...(entry?.reads ?? []), ...(entry?.deps ?? [])]);
    for (const w of words(key)) names.add(keyOf("CLAS", w));
    for (const name of names) {
      if (!name.startsWith("CLAS ") || relower.has(name)) continue;
      if (!byKey.has(name) || !index.entries[name] || enqueued.has(name)) continue;
      for (const f of byKey.get(name)) need.add(f);
      enqueued.add(name);
      queue.push(name);
    }
  }
  notes.push(`registry ${need.size} of ${allFiles.size} files`);

  // the cached entries, loaded and digest-checked
  const payloads = new Map(); // key -> payload (undefined when unreadable)
  const load = (key) => {
    if (payloads.has(key)) return payloads.get(key);
    const entry = index.entries[key];
    let payload;
    if (entry?.portable && entry.digest) {
      try {
        const bytes = readFileSync(join(dir, "e", `${sha(key)}.bin`));
        if (sha(bytes) === entry.digest) payload = deserialize(inflateRawSync(bytes));
      } catch { /* unreadable: a miss */ }
    }
    payloads.set(key, payload);
    return payload;
  };
  const reusedKeys = [];
  for (const key of index.order) {
    if (relower.has(key)) continue;
    if (load(key) === undefined) return {ok: false, reason: `${key}: its cache entry is unreadable`};
    reusedKeys.push(key);
  }

  // the anonymous structures a fresh lowering may be handed: only a shape
  // the write-time build covered with exactly ONE name -- its owner reused,
  // so it does not mint it again -- and more than its creator referenced,
  // so it truly flowed through one shared instance. A shape several names
  // cover (the RAP message row, constructed per lowering and named after
  // each first reacher: four names on this tree) is never answered: a
  // fresh lowering mints its own, as the full build's reachers did
  const creatorOf = new Map(), referencers = new Map(), namesOfShape = new Map();
  for (const key of index.order) {
    const payload = load(key);
    if (payload !== undefined) for (const op of flatOps(payload, "structs")) {
      if (op[0] !== "set") continue;
      creatorOf.set(op[1], key);
      if (op[2]?.qname !== undefined) continue;
      if (!namesOfShape.has(op[2].shape)) namesOfShape.set(op[2].shape, new Set());
      namesOfShape.get(op[2].shape).add(op[1]);
    }
    for (const name of index.entries[key].anonRefs ?? []) {
      if (!referencers.has(name)) referencers.set(name, new Set());
      referencers.get(name).add(key);
    }
  }
  const seeds = new Map(); // component names -> go name
  for (const [shape, names] of namesOfShape) {
    if (names.size !== 1) continue;
    const name = [...names][0];
    const creator = creatorOf.get(name);
    if (creator === undefined || relower.has(creator)) continue;
    const refs = referencers.get(name) ?? new Set();
    if (refs.size >= 2 || (refs.size === 1 && !refs.has(creator))) seeds.set(shape, name);
  }
  const seededNames = new Set(seeds.values());
  // the full build's layout of the global passes must be one this build can
  // reproduce (see straySlot)
  if (index.strayLayoutOk !== true) return {ok: false, reason: "a global pass of the live generation wrote between two objects"};
  // which object first wrote each key of the keyed collections in the
  // live generation (the re-lowered objects' entries describe their last
  // lowering): a fresh lowering that FIRST writes a key another object
  // first wrote there would put it at the wrong slot of the merge
  const firstSetter = new Map(); // coll \0 key -> object key
  for (const [key, occ] of index.segments) {
    const payload = load(key);
    for (const coll of ["structs", "consts", "sigs", "events"]) for (const op of payload?.segs?.[occ]?.[coll] ?? []) {
      if (op[0] === "set" && !firstSetter.has(`${coll}\0${op[1]}`)) firstSetter.set(`${coll}\0${op[1]}`, key);
    }
  }

  // the fast compileProgram: fresh lowerings over the closure registry,
  // with the shared state pre-seeded from the cache. The fresh lowering's
  // own writes are recorded per object (opProxy), so the merged program can
  // put every collection back in the order the full build's lowering wrote
  // it -- the program digest and the emitted Go read several of them in
  // insertion order, and "reused first, fresh after it" is not that order
  const freshRtti = [];
  const freshOwnership = new Map();
  const freshSegs = new Map(); // key -> [{coll: [ops]}], one per `enter`, as the write side records
  const freshPhases = new Map(); // key -> [phase of each segment]
  const freshStrays = []; // [coll, op, phase, segments of the phase before it]
  const freshCount = [0, 0];
  let currentKey = null;
  let lowering = 0;
  let orderDoubt;
  const raws = {}; // coll -> the collection itself, under the recording proxy
  let freshList; // the classes the fresh lowering pushed
  let hookDoubt;
  const supers = new Map(Object.entries(index.supers));
  const readIncr = {
    // only the re-lowered objects compile; everything else stays in `wanted`
    // (a call of a class outside the program is refused during lowering) and
    // its IR comes from the cache
    compiles: (key) => relower.has(key),
    enter(key) {
      if (!freshSegs.has(key)) { freshSegs.set(key, []); freshPhases.set(key, []); }
      freshSegs.get(key).push({});
      freshPhases.get(key).push(lowering);
      freshCount[lowering] += 1;
      currentKey = key;
    },
    exit() { currentKey = null; },
    lowering() { lowering = 1; },
    // the partial registry cannot walk the superclass chains of the classes
    // it does not hold -- and its own `wanted` is partial with them, the
    // selection drops what the registry does not know -- so both the walk's
    // start set and its steps come from the write-time build's records
    // (frontend.mjs asks this hook before it walks)
    caughtIndex: (reg) => caughtIndex(reg, new Set(index.wanted), (c) => supers.get(c) ?? null),
    prepare(p, reg) {
      for (const coll of RECORDED) {
        const target = p[coll];
        if (!["skipped", "partial", "classes"].includes(coll)) {
          // in the full build's segment order, the cached objects only
          for (const [key, occ] of index.segments) {
            if (relower.has(key)) continue;
            for (const [method, ...args] of load(key).segs?.[occ]?.[coll] ?? []) {
              if (method === "set") target.set(args[0], args[1]);
              else if (method === "add") target.add(args[0]);
              else if (method === "delete") target.delete(args[0]);
              else if (method === "clear") target.clear();
            }
          }
        }
        // the fresh lowering's writes land in the same collections, recorded
        // per object; one outside any object's mark is a global pass,
        // recorded by which side of the lowering it ran on (the rebuild
        // below puts it there).
        // `classes` keeps its own merge off index.classes below.
        raws[coll] = target;
        if (coll !== "classes") p[coll] = opProxy(coll, target, (op) => {
          if (currentKey === null) { freshStrays.push([coll, op, lowering, freshCount[lowering]]); return; }
          const seg = freshSegs.get(currentKey).at(-1);
          (seg[coll] ??= []).push(op);
          // a key this object writes FIRST in this build must be one it (or
          // nobody) wrote first in the full build, or the merge puts it at
          // another object's slot
          if (op[0] === "set" && target instanceof Map && !target.has(op[1])) {
            const id = `${coll}\0${op[1]}`;
            const before = firstSetter.get(id);
            if (before !== undefined && before !== currentKey) orderDoubt ??= `${currentKey} now first writes ${coll} ${op[1]}, which ${before} wrote first in the live generation`;
          }
        });
      }
      const supplied = new Map(p.supplied);
      for (const key of reusedKeys) for (const [k, params] of load(key).supplied ?? []) supplied.set(k, new Set([...(supplied.get(k) ?? []), ...params]));
      p.supplied = supplied;
      let origins;
      const segAt = new Map(index.segments.map(([key, occ], i) => [`${key}\0${occ}`, i]));
      p.anonStructs = anonShapes = new AnonShapes(seeds, () => currentKey, index.anonNamed ?? {}, (t) => (origins ??= anonOrigins(reg)).get(t) ?? [],
        () => segAt.get(`${currentKey}\0${(freshSegs.get(currentKey)?.length ?? 0) - 1}`));
      // the fresh lowering resolves CDS view types through this map
      // (frontend.mjs), and the mini registry's own is empty -- its walk
      // never reaches the .ddls.asddls sources; the merge restores the
      // recorded one below, over what the mini's final analysis answered
      p.cdsViews = index.cdsViews ?? {};
    },
    // the lowering is done, the final analyses (the interface walk, the
    // dynamic statics, the table registry, ...) are next: they read the
    // classes and the shared collections in insertion order, and append
    // what they derive. They must see the full build's state there, not the
    // pre-seed's order with the fresh writes after it: the merged class
    // list, and every recorded collection rebuilt in the segment sequence.
    lowered(p) {
      freshList = p.classes;
      const merged = mergeClasses(freshList);
      if (!merged.ok) { hookDoubt = merged.reason; return; }
      const strays = classifyStrays();
      if (!strays.ok) { hookDoubt = strays.reason; return; }
      for (const coll of RECORDED) {
        if (coll === "classes") continue;
        const raw = raws[coll];
        const want = mergeColl(coll, strays.bySlot, false);
        // the keyed collections were pre-seeded, so they must hold the same
        // entries already; the lists (skipped, partial) were not, and take
        // the cached objects' entries here
        const same = raw instanceof Map ? raw.size === want.size && [...want.keys()].every((k) => raw.has(k))
          : raw instanceof Set ? raw.size === want.size && [...want].every((k) => raw.has(k))
            : true;
        if (!same) { hookDoubt = `the merged ${coll} holds other entries than the fresh build's`; return; }
        if (raw instanceof Map) { raw.clear(); for (const [k, v] of want) raw.set(k, v); }
        else if (raw instanceof Set) { raw.clear(); for (const v of want) raw.add(v); }
        else raw.splice(0, raw.length, ...want);
      }
      p.classes = merged.classes;
    },
    rttiOf(owner, defs) { freshRtti.push([owner, defs]); },
    ownershipOf(name, value) { freshOwnership.set(upper(name), value); },
  };

  // the merge, in the full build's order: its segment sequence
  // (index.segments), each segment the fresh writes of an object that
  // lowered again or the recorded ones of an object taken from the cache,
  // and the global passes in the slots they ran in. The program digest and
  // the emitted Go read several of these collections in insertion order;
  // any other order names another generation. The passes are this build's
  // own: its registry holds every object they read (every non-class object
  // is a member).
  function classifyStrays() {
    const bySlot = {}; // coll -> slot -> [ops]
    for (const [coll, op, phase, at] of freshStrays) {
      let slot = straySlot(phase, at, freshCount[phase]);
      if (slot === null) return {ok: false, reason: `a global pass wrote ${coll} between two objects`};
      if (slot === "AB" || slot === "CD") {
        // this build had no segment in the phase: the slot is the one the
        // full build used, if it used only one of the two
        const both = slot.split("");
        const used = (index.straySlots[coll] ?? []).filter((x) => both.includes(x));
        if (used.length > 1) return {ok: false, reason: `the global passes of ${coll} ran on both sides of a phase this build has no object in`};
        slot = used[0] ?? both[0];
      }
      ((bySlot[coll] ??= {})[slot] ??= []).push(op);
    }
    return {ok: true, bySlot};
  }
  function mergeColl(coll, bySlot, withFinal) {
    const like = raws[coll];
    const out = like instanceof Map ? new Map() : like instanceof Set ? new Set() : [];
    const strays = (slot) => { for (const op of bySlot[coll]?.[slot] ?? []) applyOp(out, op); };
    const segs = (phase) => {
      for (const [key, occ, p] of index.segments) {
        if (p !== phase) continue;
        const ops = relower.has(key) ? freshSegs.get(key)?.[occ]?.[coll] : load(key).segs?.[occ]?.[coll];
        for (const op of ops ?? []) applyOp(out, op);
      }
    };
    strays("A"); segs(0); strays("B");
    strays("C"); segs(1);
    if (withFinal) strays("D");
    return out;
  }
  // the classes in the recorded push order
  function mergeClasses(fresh) {
    const freshClasses = new Map(fresh.map((c) => [c.name, c]));
    const classes = [];
    for (const [key, name] of index.classes) {
      if (key === undefined || relower.has(key)) {
        const ir = freshClasses.get(name);
        if (ir === undefined) return {ok: false, reason: `${name} of ${key ?? "the fresh compile"} was not lowered fresh as expected`};
        classes.push(ir);
        // a fresh IR may not newly name an anonymous structure another object
        // first used: whether the full build would share it through the same
        // abaplint instance is exactly what this registry cannot prove
        for (const type of irNames(ir).types) {
          if (seededNames.has(type) && !(index.entries[key]?.anonRefs ?? []).includes(type)) {
            return {ok: false, reason: `${key}: the edit now names the shared anonymous structure ${type}`};
          }
        }
      } else {
        const ir = load(key)?.ir[name];
        if (ir === undefined) return {ok: false, reason: `${key}: no lowered ${name} in the cache`};
        classes.push(ir);
      }
    }
    if (classes.length !== index.classes.length || fresh.length !== new Set(fresh.map((c) => c.name)).size) return {ok: false, reason: "the fresh lowering pushed a class twice"};
    return {ok: true, classes};
  }

  let anonShapes;
  let mini;
  try {
    mini = compileProgram({folders, objects, tolerant: true, skip: (p) => hidden.has(p) || !need.has(p), includeTests, incr: readIncr});
  } catch (e) {
    return {ok: false, reason: `the fresh lowering failed: ${e.message}`};
  }
  // an object the fast build re-lowered must come out clean: the full front
  // end would drop it from the program, and that is not this edit's answer
  const reloweredObjects = new Set([...relower].map((k) => k.slice(5)));
  const freshErrors = mini.diagnostics.filter((d) => reloweredObjects.has(upper(d.object)));
  if (freshErrors.length > 0) return {ok: false, reason: `syntax errors in re-lowered objects (${freshErrors[0].object}: ${freshErrors[0].message})`};
  // and nothing outside the re-lowered set may have turned broken
  const cachedBroken = new Set(index.broken);
  for (const name of mini.broken) if (!reloweredObjects.has(upper(name)) && !cachedBroken.has(upper(name))) {
    const why = mini.diagnostics.find((d) => upper(d.object) === upper(name))?.message ?? "no diagnostic";
    return {ok: false, reason: `${name}: the edit left it with syntax errors the live generation did not have (${why})`};
  }

  if (anonShapes?.doubt !== undefined) return {ok: false, reason: anonShapes.doubt};
  // an edit that moves the first reacher of a declared anonymous structure
  // (an earlier object now reaches it, or the first stops) renames it in the
  // full build; the pinned name would be the old one
  const moved = anonFirstMoved(index.anonReach, anonShapes?.reached ?? new Map(), relower);
  if (moved !== undefined) return {ok: false, reason: `the first object to reach the anonymous structure of ${moved} is another one after the edit`};
  // the full build entered every re-lowered object as often, and in the
  // same phases, as this one did (the discovery, the class pass, the local
  // classes, the function groups); an edit that changed that changes the
  // full build's sequence too, and the merge below could not follow it
  const recordedSegs = new Map();
  for (const [key, , phase] of index.segments) {
    if (!recordedSegs.has(key)) recordedSegs.set(key, []);
    recordedSegs.get(key).push(phase);
  }
  for (const key of relower) {
    if (JSON.stringify(freshPhases.get(key) ?? []) !== JSON.stringify(recordedSegs.get(key) ?? [])) {
      return {ok: false, reason: `${key}: its passes differ from the live generation's (${JSON.stringify(freshPhases.get(key) ?? [])} against ${JSON.stringify(recordedSegs.get(key) ?? [])})`};
    }
  }
  if (orderDoubt !== undefined) return {ok: false, reason: orderDoubt};
  if (hookDoubt !== undefined) return {ok: false, reason: hookDoubt};
  if (freshList === undefined) return {ok: false, reason: "the front end did not report the end of the lowering"};

  const strays = classifyStrays();
  if (!strays.ok) return {ok: false, reason: strays.reason};
  const program2 = mini;
  for (const coll of RECORDED) {
    if (coll === "classes") continue; // merged below, off index.classes
    const out = mergeColl(coll, strays.bySlot, true);
    // the mini's final pass ran over the full build's state (the lowered
    // hook), so its own collections are this merge already, order included
    const raw = raws[coll];
    const flat = (c) => JSON.stringify(c instanceof Map ? [...c.keys()] : [...c].map((v) => (typeof v === "string" ? v : "")));
    if (flat(raw) !== flat(out)) return {ok: false, reason: `the merged ${coll} is not in the order the fresh build's final pass left it`};
    program2[coll] = out;
  }
  // the interface methods: the final pass walked `interfaces` in the merged
  // order (the lowered hook), and the emitted Go declares the interfaces
  // in this map's order -- checked, not trusted
  {
    const names = [...program2.interfaces];
    const have = mini.interfaceMethods ?? new Map();
    if (names.length !== have.size || names.some((n, k) => [...have.keys()][k] !== n)) {
      return {ok: false, reason: "the interface methods are not in the merged interfaces' order"};
    }
  }
  const merged = mergeClasses(freshList);
  if (!merged.ok) return {ok: false, reason: merged.reason};
  const classes = merged.classes;
  program2.classes = classes;
  program2.wanted = new Set(index.wanted);
  // the mini's final analysis rebuilt the CDS view map off a registry that
  // holds no .ddls source; the recorded map is the fast path's answer (a
  // CDS edit is not a class or interface edit and refuses before this)
  program2.cdsViews = index.cdsViews ?? {};
  const cachedDiag = index.diagnostics.map((d) => d.split("\0")).map(([object, message]) => ({object, message}))
    .filter((d) => !reloweredObjects.has(upper(d.object)));
  program2.diagnostics = [...cachedDiag, ...mini.diagnostics];
  program2.broken = [...new Set([...index.broken.filter((n) => !reloweredObjects.has(upper(n))), ...mini.broken.map(upper)])];
  // rtti: the full build's table interleaves the dictionary and the class
  // typedefs in registry enumeration order (index.registryOrder recorded
  // it); rebuild that order, a re-lowered class's typedefs fresh, an absent
  // class's from the cache
  {
    const freshDefs = new Map(freshRtti);
    const wanted = new Set([...index.wanted].map((n) => upper(n)));
    const structs = new Map(), known = new Set(), classSupers = new Map();
    const typed = new Set(["TABL", "DTEL", "TTYP", "DOMA", "CLAS", "INTF", "VIEW", "DDLS"]);
    for (const key of index.registryOrder) {
      const space = key.indexOf(" ");
      const type = key.slice(0, space), name = key.slice(space + 1);
      if (!typed.has(type)) continue;
      known.add(name);
      if ((type === "TABL" || type === "VIEW") && mini.rtti.structs.has(name)) structs.set(name, mini.rtti.structs.get(name));
      if (type === "CLAS" && wanted.has(name)) {
        if (relower.has(key)) {
          for (const [n, comps] of freshDefs.get(name) ?? []) { if (comps) structs.set(n, comps); known.add(n); }
        } else if (index.entries[key]) {
          for (const [n, comps] of load(key).rttiDefs ?? []) { if (comps) structs.set(n, comps); known.add(n); }
        }
      }
      // every class of the registry gets an entry, a null super included
      // (the digest reads them); an absent class's from the recorded map
      if (mini.rtti.classSupers.has(name)) classSupers.set(name, mini.rtti.classSupers.get(name));
      else if (type === "CLAS") classSupers.set(name, index.entries[key]?.super ?? index.supers[name] ?? null);
    }
    // compiled local classes share the RTTI name space: their supers append
    // after the inventory, in program.classes order (rttiLocalSupers), which
    // the merged `classes` array is
    for (const c of classes) if (c.name.includes(":")) classSupers.set(c.name, c.super ?? null);
    program2.rtti = {structs, known, classSupers};
    // the dictionary's other names (frontend.mjs tableRegistry): the mini
    // computed them off its own partial rtti, so they follow the merged one
    const tableNames = new Set((program2.tables ?? []).map((t) => t.name));
    program2.ddicNames = [...known].filter((n) => !/=>/.test(n) && !tableNames.has(n)).sort();
  }
  // the superclass chain of every merged class, for CATCH at run time
  {
    const superOf = (name) => {
      const ir = classes.find((c) => c.name === name);
      if (ir !== undefined) return ir.super ?? null;
      return index.supers[name] ?? null;
    };
    const out = {};
    for (const c of classes) {
      const chain = [c.name];
      for (let at = superOf(c.name), guard = 0; at && guard < 64; at = superOf(at), guard += 1) chain.push(at);
      if (!chain.includes("CX_ROOT")) continue;
      for (let i = 0; i + 1 < chain.length; i += 1) out[chain[i]] = chain[i + 1];
    }
    program2.exceptionSupers = out;
  }
  // ownership: the recorded collection order, a fresh value where the fresh
  // registry answered for the name, the cached one where it did not
  {
    const merged = new Map();
    for (const [name, value] of index.ownership) {
      merged.set(name, freshOwnership.get(name) ?? mini.ownershipSafety.get(name)
        ?? {names: new Set(value.names), dynamic: value.dynamic});
    }
    for (const [name, value] of mini.ownershipSafety) if (!merged.has(name)) merged.set(name, value);
    program2.ownershipSafety = merged;
  }
  // dynamic dispatch over the merged classes; a class with an alias outside
  // the fresh registry would resolve differently than the full build
  const aliasedOutside = index.aliased.filter((name) => mini.reg.getObject("CLAS", name) === undefined);
  if (aliasedOutside.length > 0) {
    return {ok: false, reason: `${aliasedOutside[0]} has interface aliases and is outside the fresh registry`};
  }
  program2.dynamicDispatch = [];
  prepareDynamicStatics(program2, {defaultValue, aliasTarget});
  // the files of the compiled classes, for what reads them without lowering
  // (status.mjs): the partial registry does not hold most of them
  // -- the name the full build's registry gave it, which is what the
  // status counts by, so the fast and the full build answer the same
  const filesOf = new Map();
  for (const entry of Object.values(index.entries)) for (const [name, file] of Object.entries(entry.regFiles ?? {})) filesOf.set(name, file);
  program2.filesOf = filesOf;
  return {ok: true, program: program2, lowered: [...relower].sort(), reused: reusedKeys.length, notes,
    incrDb: {dir, db: sealed.db, relower: [...relower], registryOrder: index.registryOrder}};
}

// the database statements of the fast path: osgo-incr-db.mjs (its own file,
// the size rule); re-exported so callers keep one import
export {dbContributions, dbFlat, dbCacheWrite, dbCacheRead} from "./osgo-incr-db.mjs";
