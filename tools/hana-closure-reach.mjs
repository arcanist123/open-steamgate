// Which methods a READ can reach: the analysis behind the closure's reads
// frontier (milestone 4, phase 1; docs/db-backends.md "The reads frontier").
//
// The closure walk (tools/hana-closure.mjs) closes every name an island
// object mentions, in every method, for every object the island holds. On
// the five-service family run that did not converge: most of what it asked
// sat in definitions of objects no read ever runs. This module computes, from
// an abaplint registry of the island and the seed services, what a read
// needs -- and nothing is wired into the walk yet (phase 2):
//
//   kept objects K and reachable methods R, one least fixed point of
//   - ENTRIES: per service, the DPC chain's implementation of each read the
//     dispatcher makes (ENTRY_TABLE, bound to src/gateway by a test), the
//     MPC chain's DEFINE, both constructors; the class constructor of every
//     kept class (this runtime runs them at load);
//   - CALLS: exact where the scope resolved the target (a static or super
//     call: that implementation; an instance call on a class: it and every
//     redefinition in a kept subclass; an interface method: every kept
//     implementer); by method name over kept classes where it did not (the
//     receiver's type is unknown); an instantiation reaches the constructor;
//     a raised event reaches the kept handlers;
//   - KEEPS: a reachable body names an island object, or a kept definition
//     needs it HARD (superclass, INTERFACES, a qualified x=>name, RAISING).
//     A definition that names an object only as a bare `TYPE REF TO x` makes
//     x a SHELL (an empty definition is enough) until a reachable body
//     reaches through such a reference (`->`), which promotes it.
//
// What a read never runs is reported, never decided here. Dynamic calls,
// dynamic creation, BAdIs, events and dynamic function calls on read paths
// are RECORDED, never guessed. Names in the namespaces this tree's libraries
// own are never asks. Pure apart from the CLI at the bottom.
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import * as abaplint from "@abaplint/core";
import {analyseObject, requestKindOf} from "./hana-closure-graph.mjs";
import {libraryFiles} from "./osd-inputs.mjs";

const up = (s) => String(s ?? "").toUpperCase();
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = (it) => [...it].sort(byText);
const shortOf = (m) => up(m).split("~").pop();
const DPC = "/IWBEP/IF_MGW_APPL_SRV_RUNTIME";
const MPC = "/IWBEP/CL_MGW_PUSH_ABS_MODEL";
const REGISTRY = "ZCL_OAO_REGISTRY";

/** What a GET makes the framework call on a service's classes: one row per
 *  read, with the src/gateway methods that make the call (`source` class,
 *  `callers`). test/hana-closure-reach.mjs parses those classes and asserts
 *  that the calls they make on the DPC interface, the abstract model and
 *  the registry are exactly ENTRY_TABLE + WRITE_CALLS -- a new call must be
 *  classified, a row nobody calls fails. `on` says which seed class the
 *  method is resolved on; `when` names the option a row needs. */
export const ENTRY_TABLE = [
  {operation: "entity set (direct, navigation, $expand row)", on: "dpc", via: DPC, method: "GET_ENTITYSET", source: "ZCL_STG_DISPATCHER", callers: ["EXPAND_ROW", "READ_ENTITY_SET"]},
  {operation: "entity set with $expand", on: "dpc", via: DPC, method: "GET_EXPANDED_ENTITYSET", source: "ZCL_STG_DISPATCHER", callers: ["READ_ENTITY_SET"]},
  {operation: "entity (direct, navigation, $expand row)", on: "dpc", via: DPC, method: "GET_ENTITY", source: "ZCL_STG_DISPATCHER", callers: ["EXPAND_ROW", "READ_ENTITY"]},
  {operation: "entity with $expand", on: "dpc", via: DPC, method: "GET_EXPANDED_ENTITY", source: "ZCL_STG_DISPATCHER", callers: ["READ_ENTITY"]},
  {operation: "media $value", on: "dpc", via: DPC, method: "GET_STREAM", source: "ZCL_STG_DISPATCHER", callers: ["MEDIA"]},
  {operation: "function import by GET", on: "dpc", via: DPC, method: "EXECUTE_ACTION", source: "ZCL_STG_DISPATCHER", callers: ["FUNCTION_IMPORT"], when: "functionImports"},
  {operation: "data provider instance", on: "dpc", via: REGISTRY, call: "CREATE_DPC", method: "CONSTRUCTOR", source: "ZCL_STG_DISPATCHER", callers: ["FUNCTION_IMPORT", "MEDIA", "READ_ENTITY", "READ_ENTITY_SET"]},
  {operation: "model ($metadata, the model the dispatcher reads)", on: "mpc", via: MPC, method: "DEFINE", source: "ZCL_STG_MODEL_INFO ZCL_OAO_HTTP_HANDLER", callers: ["BUILD", "METADATA"]},
  {operation: "model provider instance", on: "mpc", via: REGISTRY, call: "CREATE_MPC", method: "CONSTRUCTOR", source: "ZCL_STG_MODEL_INFO ZCL_OAO_HTTP_HANDLER", callers: ["BUILD", "METADATA"]},
];
/** the calls the same classes make on non-GET paths: never entries. */
export const WRITE_CALLS = [
  {via: DPC, method: "CREATE_DEEP_ENTITY", callers: ["WRITE_ENTITY"]},
  {via: DPC, method: "CREATE_ENTITY", callers: ["WRITE_ENTITY"]},
  {via: DPC, method: "DELETE_ENTITY", callers: ["WRITE_ENTITY"]},
  {via: DPC, method: "UPDATE_ENTITY", callers: ["WRITE_ENTITY"]},
  {via: DPC, method: "UPDATE_STREAM", callers: ["MEDIA"]},
  // the re-read behind a write's or a bound POST action's If-Match
  {via: DPC, method: "GET_ENTITY", callers: ["CURRENT_ETAG", "FUNCTION_IMPORT", "WRITE_ENTITY"]},
  {via: REGISTRY, method: "CREATE_DPC", callers: ["WRITE_ENTITY"]},
];
/** the classes the binding reads, and which call targets it binds. */
export const BINDING = {
  ZCL_STG_DISPATCHER: {targets: [DPC, REGISTRY], methods: undefined},
  ZCL_STG_MODEL_INFO: {targets: [MPC, REGISTRY], methods: ["BUILD"]},
  ZCL_OAO_HTTP_HANDLER: {targets: [MPC, REGISTRY], methods: ["METADATA"]},
};

/** every method call one class makes on `targets` (declaring class or
 *  interface names), as the scope resolved it: [{caller, target, method,
 *  line}], sorted. `methods` limits the callers. */
export function callsIn(reg, className, targets, methods = undefined) {
  const obj = reg.getObject("CLAS", up(className));
  if (obj === undefined) throw new Error(`${className} is not in the registry`);
  const want = new Set(targets.map(up));
  const out = new Map();
  const visit = (node, method) => {
    const id = node.getIdentifier();
    const here = id.stype === abaplint.ScopeType.Method ? up(id.sname) : method;
    for (const r of node.getData().references) {
      const target = up(r.extra?.ooName);
      if (r.referenceType !== "Method" || want.has(target) === false || here === undefined) continue;
      if (methods !== undefined && methods.includes(here) === false) continue;
      const method = up(r.resolved?.getName());
      out.set(`${here}|${target}|${method}`, {caller: here, target, method, line: r.position.getStart().getRow()});
    }
    for (const c of node.getChildren()) visit(c, here);
  };
  visit(new abaplint.SyntaxLogic(reg, obj).run().spaghetti.getTop(), undefined);
  return [...out.values()].sort((a, b) => byText(`${a.target}|${a.method}|${a.caller}`, `${b.target}|${b.method}|${b.caller}`));
}

// ------------------------------------------------------------ namespaces ----

export const namespaceOf = (name) => /^(\/[^/]+\/)/.exec(up(name))?.[1];

/** the namespaces the libraries of abap_transpile.json carry, minus the
 *  seed's own: a library that carries one class of a namespace does not make
 *  a seed of that namespace a framework of ours. Sorted. */
export function frameworkNamespaces(root, seedNames = []) {
  const seed = new Set(seedNames.map(namespaceOf).filter((ns) => ns !== undefined));
  const out = new Set();
  for (const lib of libraryFiles(root)) {
    for (const file of lib.files) {
      const m = /^#([^#]+)#/.exec(String(file).split("/").pop());
      if (m !== null) out.add(`/${up(m[1])}/`);
    }
  }
  return sorted([...out].filter((ns) => seed.has(ns) === false));
}

// ---------------------------------------------------------- the parse ----

const baseName = (f) => String(f ?? "").split("/").pop();
const exprName = (n) => n.get().constructor.name;
const isExpr = (n) => n.constructor.name === "ExpressionNode";

/** walk an expression tree: (node, ancestors) for every expression node */
function eachExpression(node, fn, path = []) {
  for (const c of node.getChildren()) {
    if (isExpr(c) === false) continue;
    fn(c, path);
    eachExpression(c, fn, [...path, exprName(c)]);
  }
}

// the head object name of a type or class expression: `x=>t-c` -> X
const headOf = (text) => up(text).split("=>")[0].split("-")[0].trim();

/** the names one statement mentions, with the carrier a dependency needs:
 *  super | intf | raising | qualified | ref | type | class | friend | table */
function statementNames(st) {
  const out = [];
  const tokens = st.getTokens().map((t) => up(t.getStr()));
  const sname = st.get().constructor.name;
  eachExpression(st, (node, path) => {
    const e = exprName(node);
    const row = node.getFirstToken().getStart().getRow();
    const text = node.concatTokens();
    if (e === "ClassName") {
      if (path.at(-1) === "SuperClassName") out.push({name: up(text), carrier: "super", row});
      else if (path.at(-1) === "ClassFriends") out.push({name: up(text), carrier: "friend", row});
      else if (path.at(-1) === "MethodDefRaising") out.push({name: up(text), carrier: "raising", row});
      else if (sname !== "ClassDefinition" && sname !== "ClassImplementation" && sname !== "ClassDefinitionLoad" && sname !== "ClassDeferred") {
        out.push({name: up(text), carrier: sname === "Catch" ? "class" : "qualified", row});
      }
    } else if (e === "InterfaceName" && sname === "InterfaceDef") {
      out.push({name: up(text), carrier: "intf", row});
    } else if (e === "TypeName") {
      const at = node.getFirstToken();
      const i = st.getTokens().findIndex((t) => t.getStart().equals(at.getStart()));
      const ref = i >= 2 && tokens[i - 1] === "TO" && tokens[i - 2] === "REF";
      out.push({name: headOf(text), carrier: text.includes("=>") ? "qualified" : ref ? "ref" : "type", row});
    } else if (e === "DatabaseTable" && /^\(/.test(text) === false) {
      out.push({name: up(text), carrier: "table", row});
    }
  });
  return out;
}

const HARD = new Set(["super", "intf", "raising", "qualified", "type", "class"]);

/** one island object's structure: classes (global + local), method
 *  implementations with their row ranges, definition statements, and per
 *  implementation the statements of its body. */
function parseObject(obj) {
  const name = up(obj.getName());
  const out = {name, kind: obj.getType(), classes: new Map(), impls: [], defNames: [], files: []};
  for (const file of obj.getABAPFiles()) {
    const base = baseName(file.getFilename());
    out.files.push(base);
    let cls; // {key} of the open definition/implementation
    let impl;
    let inDef = false;
    for (const st of file.getStatements()) {
      const s = st.get().constructor.name;
      const toks = st.getTokens().map((t) => up(t.getStr()));
      if (s === "Comment" || s === "Empty") continue;
      if (s === "ClassDefinition" || s === "Interface") {
        const cname = toks[1];
        const key = cname === name ? name : `${name}\\${cname}`;
        const c = out.classes.get(key) ?? {key, object: name, name: cname, kind: s === "Interface" ? "INTF" : "CLAS",
          super: undefined, interfaces: [], aliases: new Map(), handlers: []};
        const inh = toks.indexOf("INHERITING");
        if (inh >= 0) c.super = toks[inh + 2];
        out.classes.set(key, c);
        cls = c;
        inDef = true;
      } else if (s === "EndClass" || s === "EndInterface") {
        cls = undefined;
        inDef = false;
        continue;
      } else if (s === "ClassImplementation") {
        const cname = toks[1];
        cls = out.classes.get(cname === name ? name : `${name}\\${cname}`) ?? {key: cname === name ? name : `${name}\\${cname}`};
        inDef = false;
        continue;
      } else if (s === "MethodImplementation") {
        impl = {key: `${cls?.key}=>${toks[1]}`, classKey: cls?.key, object: name, method: toks[1], short: shortOf(toks[1]),
          file: base, start: st.getStart().getRow(), end: st.getStart().getRow(), statements: []};
        out.impls.push(impl);
        continue;
      } else if (s === "EndMethod") {
        if (impl !== undefined) impl.end = st.getStart().getRow();
        impl = undefined;
        continue;
      }
      if (impl !== undefined) {
        impl.statements.push(st);
        continue;
      }
      if (cls !== undefined && inDef === true) {
        if (s === "InterfaceDef") cls.interfaces.push(toks[1]);
        if (s === "Aliases") cls.aliases.set(toks[1], toks[3]);
        if (s === "MethodDef") {
          const ev = toks.indexOf("EVENT");
          if (toks.includes("FOR") && ev >= 0) cls.handlers.push({method: toks[1], event: toks[ev + 1]});
        }
      }
      // definition statements: everything outside METHOD bodies (local
      // types of the locals includes included -- the object compiles whole)
      if (s !== "ClassImplementation" && s !== "EndClass") {
        for (const n of statementNames(st)) out.defNames.push({...n, file: base, owner: cls?.key ?? name});
      }
    }
  }
  return out;
}

// ------------------------------------------------------------- the model ----

/** the island's structure, one SyntaxLogic pass per object (through the
 *  structural pass's analyseObject, whose unknowns are the asks the walk
 *  makes today). */
function model(reg, island, analyse) {
  const objects = new Map();
  const classes = new Map();
  const impls = new Map();
  const errors = [];
  for (const name of island) {
    const obj = reg.getObject("CLAS", name) ?? reg.getObject("INTF", name);
    const parsed = parseObject(obj);
    const main = obj.getABAPFiles().map((f) => f.getFilename()).find((f) => /\.(clas|intf)\.abap$/.test(f));
    let analysis;
    try {
      analysis = analyse(reg, main);
    } catch (error) {
      errors.push({object: name, error: String(error?.message ?? error)});
    }
    parsed.unknowns = [];
    for (const [file, bucket] of analysis?.perFile ?? []) for (const u of bucket.unknowns) parsed.unknowns.push({...u, file});
    parsed.scope = analysis?.scope;
    objects.set(name, parsed);
    for (const c of parsed.classes.values()) classes.set(c.key, c);
    for (const i of parsed.impls) impls.set(i.key, i);
  }
  return {objects, classes, impls, errors};
}

const implAt = (o, file, row) => o.impls.find((i) => i.file === file && row > i.start && row < i.end);

// ------------------------------------------------------------- the walk ----

/** The reads frontier over one island. `reg` holds the island (non-
 *  dependency objects) and whatever resolves around it (dependencies);
 *  `services` [{service, dpc, mpc}] name the registered classes. Options:
 *  frameworkNamespaces (never asks, never walked), functionImports (the
 *  GET function-import row), alarms [{pattern, label}] (matched against
 *  object and package), packages (object -> package label), cap (kept code
 *  objects before the tripwire trips), analyse (the structural pass). */
export function reach(reg, services, options = {}) {
  const fw = new Set(options.frameworkNamespaces ?? []);
  const isFw = (n) => fw.has(namespaceOf(n));
  const cap = options.cap ?? 400;
  const island = sorted([...reg.getObjects()].filter((o) => (o.getType() === "CLAS" || o.getType() === "INTF") &&
    reg.isDependency(o) === false).map((o) => up(o.getName())));
  const frameworkObjects = island.filter(isFw);
  const {objects, classes, impls, errors} = model(reg, island.filter((n) => isFw(n) === false), options.analyse ?? analyseObject);
  const inIsland = (n) => objects.has(n);
  const present = (n) => ["CLAS", "INTF", "TABL", "VIEW", "DDLS", "TTYP", "DTEL", "DOMA", "TYPE"].some((t) => reg.getObject(t, n) !== undefined);

  // class chain (keys), through island classes and on into the registry
  const superKey = (key) => {
    const c = classes.get(key);
    if (c !== undefined) {
      if (c.super === undefined) return undefined;
      const local = `${c.object}\\${c.super}`;
      return classes.has(local) ? local : c.super;
    }
    const def = reg.getObject("CLAS", key)?.getDefinition?.();
    const s = def?.getSuperClass?.();
    return s === undefined ? undefined : up(s);
  };
  const chains = new Map();
  const chain = (key) => {
    if (chains.has(key) === false) {
      const out = [];
      for (let k = key; k !== undefined && out.includes(k) === false; k = superKey(k)) out.push(k);
      chains.set(key, out);
    }
    return chains.get(key);
  };
  const implsOf = new Map();
  for (const i of [...impls.values()].sort((a, b) => byText(a.key, b.key))) {
    const list = implsOf.get(i.classKey) ?? [];
    list.push(i);
    implsOf.set(i.classKey, list);
  }
  const ownImpl = (key, method) => (implsOf.get(key) ?? []).find((i) => i.method === up(method));
  const resolveImpl = (key, method) => {
    for (const k of chain(key)) {
      const i = ownImpl(k, method);
      if (i !== undefined) return i;
    }
    return undefined;
  };
  const byObject = new Map();
  for (const c of [...classes.values()].sort((a, b) => byText(a.key, b.key))) byObject.set(c.object, [...(byObject.get(c.object) ?? []), c]);
  const classesOfObject = (name) => byObject.get(name) ?? [];

  const K = new Map(); // object -> why
  const R = new Map(); // impl key -> why
  const kq = [];
  const rq = [];
  const promoted = new Set();
  const pending = {iface: new Set(), redef: new Map(), byName: new Set(), events: new Set()};
  const stats = {exact: 0, redefinition: 0, interface: 0, byName: 0, unresolvedStatic: 0};
  const bodyAsks = new Map(); // name -> [{...}]
  const bodyNamed = new Set();
  const dynamic = [];
  const fms = new Map();
  const derefs = new Map(); // object type name -> first evidence

  const keep = (n, why) => {
    if (inIsland(n) === false || K.has(n)) return;
    K.set(n, why);
    kq.push(n);
  };
  const reachImpl = (i, why) => {
    if (i === undefined || R.has(i.key)) return;
    R.set(i.key, why);
    rq.push(i);
  };

  // entries
  const entries = [];
  const rows = ENTRY_TABLE.filter((r) => r.when === undefined || options[r.when] === true);
  for (const s of [...services].sort((a, b) => byText(up(a.service), up(b.service)))) {
    for (const role of ["dpc", "mpc"]) {
      const cls = up(s[role]);
      keep(cls, {rule: "seed", by: up(s.service)});
      for (const k of chain(cls).filter(inIsland)) keep(k, {rule: "seed", by: up(s.service)});
      for (const row of rows.filter((r) => r.on === role)) {
        const name = row.via === DPC ? `${row.via}~${row.method}` : row.method;
        const i = resolveImpl(cls, name);
        entries.push({service: up(s.service), operation: row.operation, method: name, implementation: i?.key ?? null});
        reachImpl(i, {rule: "entry", by: `${up(s.service)}: ${row.operation}`});
      }
    }
  }

  // what a kept object adds: its hard definition names, its class
  // constructors, and every pending call it now answers
  const onKeep = (n) => {
    const o = objects.get(n);
    for (const d of o.defNames) {
      if (HARD.has(d.carrier) === false || d.name === n) continue;
      if (classes.has(`${n}\\${d.name}`)) continue;
      if (inIsland(d.name)) keep(d.name, {rule: d.carrier, by: n, file: d.file, line: d.row});
    }
    for (const c of classesOfObject(n)) {
      reachImpl(ownImpl(c.key, "CLASS_CONSTRUCTOR"), {rule: "class-constructor", by: c.key});
      for (const i of implsOf.get(c.key) ?? []) {
        if (i.method.includes("~") && pending.iface.has(i.method)) reachImpl(i, {rule: "interface", by: i.method});
        if (pending.byName.has(i.short)) reachImpl(i, {rule: "by-name", by: i.short});
        for (const k of chain(c.key).slice(1)) {
          if (pending.redef.get(k)?.has(i.method)) reachImpl(i, {rule: "redefinition", by: `${k}=>${i.method}`});
        }
      }
      for (const [alias, target] of c.aliases) {
        if (pending.byName.has(alias)) reachImpl(resolveImpl(c.key, target), {rule: "alias", by: `${c.key}~${alias}`});
      }
      for (const h of c.handlers) if (pending.events.has(h.event)) reachImpl(ownImpl(c.key, h.method), {rule: "event", by: h.event});
    }
  };
  const keptClasses = () => [...K.keys()].flatMap(classesOfObject);
  const ifaceBy = new Map();
  const callInterface = (method, by) => {
    if (pending.iface.has(method) === false) {
      pending.iface.add(method);
      ifaceBy.set(method, by);
      for (const c of keptClasses()) reachImpl(ownImpl(c.key, method), {rule: "interface", by});
    }
  };
  const callRedefinitions = (decl, method, by) => {
    const set = pending.redef.get(decl) ?? new Set();
    if (set.has(method)) return;
    set.add(method);
    pending.redef.set(decl, set);
    for (const c of keptClasses()) if (chain(c.key).slice(1).includes(decl)) reachImpl(ownImpl(c.key, method), {rule: "redefinition", by});
  };
  const callByName = (short, by) => {
    if (pending.byName.has(short)) return;
    pending.byName.add(short);
    for (const c of keptClasses()) {
      for (const i of implsOf.get(c.key) ?? []) if (i.short === short) reachImpl(i, {rule: "by-name", by});
      if (c.aliases.has(short)) reachImpl(resolveImpl(c.key, c.aliases.get(short)), {rule: "alias", by});
    }
  };
  const raiseEvent = (event, by) => {
    if (pending.events.has(event)) return;
    pending.events.add(event);
    for (const c of keptClasses()) for (const h of c.handlers) if (h.event === event) reachImpl(ownImpl(c.key, h.method), {rule: "event", by});
  };
  // a local class or interface name of the object -> its key
  const keyIn = (o, name) => (classes.has(`${o.name}\\${name}`) ? `${o.name}\\${name}` : name);
  const objectOfKey = (key) => key.split("\\")[0];

  const bodyName = (i, name, carrier, row) => {
    if (name === "" || name === i.object) return;
    if (classes.has(`${i.object}\\${name}`)) return;
    if (inIsland(name)) {
      bodyNamed.add(name);
      keep(name, {rule: "body", by: i.key, file: i.file, line: row});
    } else if (present(name) === false && (carrier === "class" || carrier === "qualified" || carrier === "table")) {
      addAsk(bodyAsks, name, {kind: carrier === "table" ? "tabl" : requestKindOf(name, {via: "qual"}), level: "method", object: i.object, method: i.key, file: i.file, line: row});
    }
  };

  const onReach = (i) => {
    const o = objects.get(i.object);
    const by = i.key;
    for (const st of i.statements) {
      const s = st.get().constructor.name;
      const row = st.getStart().getRow();
      const toks = st.getTokens().map((t) => up(t.getStr()));
      for (const n of statementNames(st)) bodyName(i, n.name, n.carrier, n.row);
      const dyn = (kind) => dynamic.push({method: by, kind, file: i.file, line: row, statement: st.concatTokens().slice(0, 160)});
      const hasDynamic = () => {
        let hit = false;
        eachExpression(st, (n) => { if (exprName(n) === "Dynamic") hit = true; });
        return hit;
      };
      if (s === "Call" && hasDynamic()) dyn("dynamic method call");
      else if (s === "CreateObject" && hasDynamic()) dyn("dynamic CREATE OBJECT");
      else if (s === "GetBadi" || s === "CallBadi") dyn("BAdI");
      else if (s === "RaiseEvent") {
        dyn("event");
        raiseEvent(toks[2], by);
      } else if (s === "CallFunction") {
        const f = st.getTokens()[2];
        if (/^['`]/.test(f?.getStr() ?? "") === true) {
          const fm = up(f.getStr().replace(/['`]/g, ""));
          fms.set(fm, sorted(new Set([...(fms.get(fm) ?? []), by])));
        } else dyn("dynamic CALL FUNCTION");
      }
    }
    for (const u of o.unknowns) {
      if (u.level === "method" && u.file === i.file && u.line > i.start && u.line < i.end && u.kind !== "friend") {
        addAsk(bodyAsks, u.name, {kind: requestKindOf(u.name, u), level: "method", object: i.object, method: by, file: u.file, line: u.line});
      }
    }
  };

  // the scope's references inside reachable bodies: calls, instantiations,
  // object names, dereferences (for shells)
  const tokenIndex = new Map();
  const tokenAt = (o, file, row, col) => {
    if (tokenIndex.has(o.name) === false) {
      const idx = new Map();
      const obj = reg.getObject(o.kind, o.name);
      for (const f of obj.getABAPFiles()) {
        for (const st of f.getStatements()) {
          const toks = st.getTokens();
          toks.forEach((t, n) => idx.set(`${baseName(f.getFilename())}:${t.getStart().getRow()}:${t.getStart().getCol()}`, {toks, n}));
        }
      }
      tokenIndex.set(o.name, idx);
    }
    return tokenIndex.get(o.name).get(`${file}:${row}:${col}`);
  };
  const refsByImpl = new Map();
  for (const o of objects.values()) {
    if (o.scope === undefined) continue;
    const visit = (node) => {
      for (const r of node.getData().references) {
        const file = baseName(r.position.getFilename());
        const row = r.position.getStart().getRow();
        const i = implAt(o, file, row);
        if (i === undefined) continue;
        const list = refsByImpl.get(i.key) ?? [];
        list.push(r);
        refsByImpl.set(i.key, list);
      }
      for (const c of node.getChildren()) visit(c);
    };
    visit(o.scope.getTop());
  }
  const typeTarget = (type) => {
    const t = type?.constructor?.name;
    if (t === "ObjectReferenceType") return up(type.getIdentifierName());
    if (t === "UnknownType") return /unable to resolve ([A-Za-z0-9_/#]+)/.exec(String(type.getError?.() ?? ""))?.[1]?.toUpperCase();
    if (t === "VoidType") return up(type.getVoided?.());
    return undefined;
  };
  const followedByArrow = (o, file, pos) => {
    const at = tokenAt(o, file, pos.getStart().getRow(), pos.getStart().getCol());
    if (at === undefined) return false;
    let n = at.n + 1;
    if (at.toks[n]?.getStr() === "(" || /\($/.test(at.toks[n]?.getStr() ?? "") || /\($/.test(at.toks[at.n].getStr())) {
      let depth = 0;
      for (let j = at.n; j < at.toks.length; j++) {
        const s = at.toks[j].getStr();
        if (s.endsWith("(")) depth++;
        if (s.startsWith(")")) depth--;
        if (depth === 0 && j > at.n) {
          n = j + 1;
          break;
        }
      }
    }
    return at.toks[n]?.getStr() === "->";
  };
  const onReferences = (i) => {
    const o = objects.get(i.object);
    for (const r of refsByImpl.get(i.key) ?? []) {
      const rt = r.referenceType;
      const row = r.position.getStart().getRow();
      const file = baseName(r.position.getFilename());
      if (rt === "Method") {
        const at = tokenAt(o, file, row, r.position.getStart().getCol());
        const prev = up(at?.toks[at.n - 1]?.getStr());
        const prev2 = up(at?.toks[at.n - 2]?.getStr());
        const decl = r.extra?.ooName === undefined ? undefined : keyIn(o, up(r.extra.ooName));
        const method = up(r.resolved?.getName());
        if (r.resolved === undefined || r.resolved === null || decl === undefined) {
          if (prev === "=>") {
            const q = keyIn(o, prev2);
            if (classes.has(q)) reachImpl(resolveImpl(q, up(r.position.getName())), {rule: "static", by: i.key});
            else stats.unresolvedStatic++;
          } else {
            stats.byName++;
            callByName(shortOf(r.position.getName()), i.key);
          }
          continue;
        }
        const declObject = objectOfKey(decl);
        // member access through an island object: the read uses it
        if (inIsland(declObject) && declObject !== i.object) {
          bodyNamed.add(declObject);
          if (K.has(declObject) === false) keep(declObject, {rule: "member-access", by: i.key, file, line: row});
        }
        const isIntf = classes.get(decl)?.kind === "INTF" || reg.getObject("INTF", decl) !== undefined;
        if (isIntf) {
          stats.interface++;
          callInterface(`${decl.split("\\").pop()}~${method}`, i.key);
        } else if (prev2 === "SUPER" && prev === "->") {
          stats.exact++;
          const sk = superKey(i.classKey);
          if (sk !== undefined) reachImpl(resolveImpl(sk, method), {rule: "super", by: i.key});
        } else if (r.resolved.isStatic?.() === true || method === "CONSTRUCTOR" || prev === "=>") {
          stats.exact++;
          reachImpl(resolveImpl(decl, method), {rule: "call", by: i.key});
        } else {
          stats.exact++;
          stats.redefinition++;
          reachImpl(resolveImpl(decl, method), {rule: "call", by: i.key});
          callRedefinitions(decl, method, i.key);
        }
        const ret = r.resolved.getParameters?.()?.getReturning?.();
        const target = typeTarget(ret?.getType?.());
        if (target !== undefined && followedByArrow(o, file, r.position)) derefs.set(target, derefs.get(target) ?? {method: i.key, file, line: row});
      } else if (rt === "Constructor Reference") {
        const name = r.resolved?.getName?.();
        if (name === undefined) continue;
        const key = keyIn(o, up(name));
        keep(objectOfKey(key), {rule: "instantiation", by: i.key, file, line: row});
        if (inIsland(objectOfKey(key))) bodyNamed.add(objectOfKey(key));
        reachImpl(resolveImpl(key, "CONSTRUCTOR"), {rule: "constructor", by: i.key});
      } else if (rt === "Object") {
        const name = up(r.extra?.ooName ?? r.resolved?.getName?.());
        if (inIsland(name) && name !== i.object) {
          bodyNamed.add(name);
          keep(name, {rule: "body", by: i.key, file, line: row});
        }
      } else if ((rt === "Read From" || rt === "Write To") && r.resolved?.getType !== undefined) {
        const target = typeTarget(r.resolved.getType());
        if (target !== undefined && followedByArrow(o, file, r.position)) derefs.set(target, derefs.get(target) ?? {method: i.key, file, line: row});
      }
    }
  };

  const fix = () => {
    while (kq.length > 0 || rq.length > 0) {
      while (kq.length > 0) onKeep(kq.shift());
      while (rq.length > 0) {
        const i = rq.shift();
        onReach(i);
        onReferences(i);
      }
    }
  };

  // definition dependencies of the kept objects: hard / shell, settled
  // against the bodies; a dereferenced shell is promoted and the walk goes on
  const definition = () => {
    const deps = [];
    const missing = new Map();
    for (const n of sorted(K.keys())) {
      const o = objects.get(n);
      const unknownAt = new Map();
      for (const u of o.unknowns) if (u.level !== "method") unknownAt.set(`${u.file}|${u.name}`, u);
      const claimed = new Set();
      for (const d of o.defNames) {
        if (d.carrier === "friend" || d.carrier === "table" || d.name === n || classes.has(`${n}\\${d.name}`)) continue;
        const u = unknownAt.get(`${d.file}|${d.name}`);
        if (u !== undefined) claimed.add(`${d.file}|${d.name}`);
        // a bare reference or a plain type the scope did not find unknown is
        // a local type or a built-in one (TYPE REF TO data); a class-shaped
        // carrier (super, INTERFACES, RAISING, x=>) names a global object
        const classShaped = d.carrier !== "type" && d.carrier !== "ref";
        const state = inIsland(d.name) ? "island" : present(d.name) ? "resolved" : u !== undefined || classShaped ? "missing" : undefined;
        if (state === undefined || state === "resolved") continue;
        deps.push({from: n, to: d.name, carrier: d.carrier, hard: HARD.has(d.carrier), state, file: d.file, line: d.row,
          ...(u !== undefined ? {kind: requestKindOf(d.name, u)} : {})});
      }
      for (const [key, u] of unknownAt) {
        if (claimed.has(key) || u.kind === "friend") continue;
        deps.push({from: n, to: u.name, carrier: u.via ?? "type", hard: true, state: "missing", file: u.file, line: u.line, kind: requestKindOf(u.name, u)});
      }
    }
    const hardTo = new Set(deps.filter((d) => d.hard).map((d) => d.to));
    const shells = new Map();
    for (const d of deps) {
      if (d.hard || hardTo.has(d.to) || bodyNamed.has(d.to) || bodyAsks.has(d.to) || K.has(d.to) || promoted.has(d.to)) continue;
      const s = shells.get(d.to) ?? {name: d.to, present: d.state === "island", by: []};
      s.by.push({object: d.from, file: d.file, line: d.line});
      shells.set(d.to, s);
    }
    for (const d of deps) {
      if (d.state !== "missing") continue;
      if (d.hard === false && shells.has(d.to)) continue;
      missing.set(d.to, missing.get(d.to) ?? []);
      missing.get(d.to).push({kind: d.kind ?? requestKindOf(d.to, {via: d.carrier === "intf" ? "interfaces" : "qual"}), level: "definition",
        object: d.from, carrier: d.carrier, file: d.file, line: d.line});
    }
    return {deps, shells, missing};
  };
  fix();
  let def = definition();
  for (;;) {
    const hits = sorted([...def.shells.keys()].filter((s) => derefs.has(s) && promoted.has(s) === false));
    if (hits.length === 0) break;
    for (const s of hits) {
      promoted.add(s);
      if (inIsland(s)) keep(s, {rule: "promoted", by: derefs.get(s).method, file: derefs.get(s).file, line: derefs.get(s).line});
    }
    fix();
    def = definition();
  }
  for (const s of promoted) def.shells.delete(s);
  // a present object a kept definition names only bare and a reachable body
  // reaches into (member access) is a shell promoted by the same rule
  const bareTo = new Set(def.deps.filter((d) => d.carrier === "ref").map((d) => d.to));
  const promotedList = [
    ...[...promoted].map((n) => ({name: n, present: inIsland(n), ...derefs.get(n)})),
    ...[...K.entries()].filter(([n, w]) => w.rule === "member-access" && bareTo.has(n) && promoted.has(n) === false)
      .map(([n, w]) => ({name: n, present: true, method: w.by, file: w.file, line: w.line})),
  ].sort((a, b) => byText(a.name, b.name));

  // the asks: what the frontier WOULD issue against what it would not
  const would = new Map();
  const framework = new Map();
  const put = (name, ev) => {
    if (isFw(name)) addAsk(framework, name, ev);
    else addAsk(would, name, ev);
  };
  for (const [name, evs] of def.missing) for (const ev of evs) put(name, ev);
  for (const [name, evs] of bodyAsks) for (const ev of evs) put(name, ev);
  const wouldNot = new Map();
  for (const o of objects.values()) {
    for (const u of o.unknowns) {
      if (u.kind === "friend" || would.has(u.name) || framework.has(u.name)) continue;
      const i = implAt(o, u.file, u.line);
      const why = K.has(o.name) === false ? "object not kept" : i !== undefined ? (R.has(i.key) ? undefined : "unreachable method") :
        def.shells.has(u.name) ? "shell" : undefined;
      if (why === undefined) continue;
      if (isFw(u.name)) continue;
      addAsk(wouldNot, u.name, {kind: requestKindOf(u.name, u), why, object: o.name, file: u.file, line: u.line, ...(i !== undefined ? {method: i.key} : {})});
    }
  }
  // the class-shaped names the scope does not record (static calls, RAISE,
  // CATCH, x=>): off the read path they are the walk's asks today
  const classShaped = new Set(["super", "intf", "raising", "qualified", "class"]);
  const notAsked = (name, ev) => {
    if (would.has(name) || framework.has(name) || isFw(name) || inIsland(name) || present(name)) return;
    addAsk(wouldNot, name, ev);
  };
  for (const o of objects.values()) {
    const kept = K.has(o.name);
    if (kept === false) {
      for (const d of o.defNames) {
        if (classShaped.has(d.carrier) && classes.has(`${o.name}\\${d.name}`) === false) {
          notAsked(d.name, {kind: requestKindOf(d.name, {via: d.carrier === "intf" ? "interfaces" : "qual"}), why: "object not kept", object: o.name, file: d.file, line: d.row});
        }
      }
    }
    for (const i of o.impls) {
      if (R.has(i.key)) continue;
      for (const st of i.statements) {
        for (const n of statementNames(st)) {
          if (classShaped.has(n.carrier) === false || classes.has(`${o.name}\\${n.name}`)) continue;
          notAsked(n.name, {kind: requestKindOf(n.name, {via: "qual"}), why: kept ? "unreachable method" : "object not kept", object: o.name, method: i.key, file: i.file, line: n.row});
        }
      }
    }
  }
  for (const [name, s] of def.shells) if (s.present === false && would.has(name) === false) addAsk(wouldNot, name, {kind: requestKindOf(name, {via: "qual"}), why: "shell", object: s.by[0].object, file: s.by[0].file, line: s.by[0].line});

  // alarms: a kept object matching a tooling pattern, with the chain that kept it
  const chainOfKeep = (n) => {
    const out = [];
    const seen = new Set();
    for (let k = n; K.has(k) && seen.has(k) === false; k = objectOfKey(String(K.get(k).by).split("=>")[0])) {
      seen.add(k);
      const w = K.get(k);
      out.push(`${k} (${w.rule}${w.by !== undefined ? ` by ${w.by}` : ""})`);
      if (w.rule === "seed") break;
    }
    return out;
  };
  const alarms = [];
  for (const n of sorted(K.keys())) {
    const pkg = options.packages?.[n] ?? "";
    for (const a of options.alarms ?? []) {
      if (new RegExp(a.pattern, "i").test(n) || new RegExp(a.pattern, "i").test(pkg)) {
        alarms.push({object: n, package: pkg, label: a.label ?? a.pattern, chain: chainOfKeep(n)});
        break;
      }
    }
  }

  // an interface call no kept class answers while island classes would: the
  // implementer is created where no name shows it (a dynamic CREATE OBJECT,
  // a factory outside the island) -- recorded beside the dynamic constructs
  const openDispatch = [];
  for (const method of sorted(pending.iface)) {
    const all = [...impls.values()].filter((i) => i.method === method);
    if (all.length === 0 || all.some((i) => R.has(i.key))) continue;
    openDispatch.push({method, by: ifaceBy.get(method), islandImplementers: sorted(new Set(all.map((i) => i.object)))});
  }
  const askList = (m) => sorted(m.keys()).map((name) => ({name, kind: m.get(name)[0].kind, class: codeKind(m.get(name)[0].kind) ? "code" : "ddic",
    evidence: m.get(name).sort((a, b) => byText(`${a.file}|${String(a.line).padStart(6)}`, `${b.file}|${String(b.line).padStart(6)}`))}));
  const unreachable = {};
  for (const n of sorted(K.keys())) {
    const list = objects.get(n).impls.filter((i) => R.has(i.key) === false).map((i) => i.key).sort(byText);
    if (list.length > 0) unreachable[n] = list;
  }
  const wouldList = askList(would);
  const kept = sorted(K.keys()).map((n) => ({object: n, kind: objects.get(n).kind, ...(options.packages?.[n] !== undefined ? {package: options.packages[n]} : {}), ...K.get(n)}));
  const keptCode = kept.length;
  return {
    services: services.map((s) => ({service: up(s.service), dpc: up(s.dpc), mpc: up(s.mpc)})).sort((a, b) => byText(a.service, b.service)),
    frameworkNamespaces: sorted(fw),
    frameworkObjects,
    entries: entries.sort((a, b) => byText(`${a.service}|${a.method}`, `${b.service}|${b.method}`)),
    kept,
    reachable: sorted(R.keys()).map((k) => ({method: k, ...R.get(k)})),
    unreachable,
    notKept: sorted(objects.keys()).filter((n) => K.has(n) === false),
    definitionDependencies: def.deps.sort((a, b) => byText(`${a.from}|${a.to}|${a.file}|${String(a.line).padStart(6)}`, `${b.from}|${b.to}|${b.file}|${String(b.line).padStart(6)}`)),
    shells: sorted(def.shells.keys()).map((n) => def.shells.get(n)),
    promoted: promotedList,
    asks: {would: wouldList, wouldNot: askList(wouldNot), framework: askList(framework)},
    dynamic: dynamic.sort((a, b) => byText(`${a.method}|${String(a.line).padStart(6)}|${a.kind}`, `${b.method}|${String(b.line).padStart(6)}|${b.kind}`)),
    openDispatch,
    functionModules: sorted(fms.keys()).map((name) => ({name, methods: fms.get(name)})),
    alarms,
    tripwire: {keptCodeObjects: keptCode, cap, overCap: keptCode > cap, codeAsks: wouldList.filter((a) => a.class === "code").length},
    edges: stats,
    errors,
    counts: {
      islandObjects: objects.size,
      islandMethods: impls.size,
      kept: K.size,
      keptBy: countBy(kept, (k) => k.rule),
      keptMethods: [...K.keys()].reduce((a, n) => a + objects.get(n).impls.length, 0),
      reachable: R.size,
      shells: def.shells.size,
      promoted: promotedList.length,
      asksCode: wouldList.filter((a) => a.class === "code").length,
      asksDdic: wouldList.filter((a) => a.class === "ddic").length,
      asksFramework: framework.size,
      notAsked: wouldNot.size,
      dynamic: dynamic.length,
      openDispatch: openDispatch.length,
      alarms: alarms.length,
    },
  };
}

const codeKind = (k) => k === "clas" || k === "intf";
function addAsk(map, name, ev) {
  const list = map.get(name) ?? [];
  list.push(ev);
  map.set(name, list);
}
function countBy(list, fn) {
  const out = {};
  for (const x of list) out[fn(x)] = (out[fn(x)] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort((a, b) => byText(a[0], b[0])));
}

/** the summary a person reads: one line per count, sorted lists after. */
export function summaryLines(r) {
  const c = r.counts;
  const lines = [
    `reads frontier: ${r.services.length} service(s), ${r.entries.length} entry row(s) (${r.entries.filter((e) => e.implementation !== null).length} with an island implementation)`,
    `island: ${c.islandObjects} code object(s), ${c.islandMethods} method(s); ${r.frameworkObjects.length} framework-namespace object(s) not walked (${r.frameworkNamespaces.join(" ") || "none"})`,
    `kept: ${c.kept} (${Object.entries(c.keptBy).map(([k, v]) => `${k} ${v}`).join(", ")}), ${c.keptMethods} method(s) in them; not kept: ${r.notKept.length}`,
    `reachable methods: ${c.reachable}; call references in reachable bodies: ${Object.entries(r.edges).map(([k, v]) => `${k} ${v}`).join(", ")}`,
    `shells: ${c.shells} (${r.shells.filter((s) => s.present).length} present in the island), promoted: ${c.promoted}`,
    `asks the frontier would issue: ${c.asksCode} code, ${c.asksDdic} DDIC-kind; would not: ${c.notAsked}; framework (never asked): ${c.asksFramework}`,
    `dynamic on read paths: ${c.dynamic}${r.dynamic.length > 0 ? ` (${Object.entries(countBy(r.dynamic, (d) => d.kind)).map(([k, v]) => `${k} ${v}`).join(", ")})` : ""}; function modules called: ${r.functionModules.length}; interface calls only unkept island classes answer: ${c.openDispatch}`,
    `tripwire: ${r.tripwire.keptCodeObjects} kept code object(s), cap ${r.tripwire.cap}${r.tripwire.overCap ? " -- OVER" : ""}; alarms: ${c.alarms}`,
  ];
  for (const a of r.alarms) lines.push(`frontier alarm: ${a.object} [${a.label}] ${a.chain.join(" <- ")}`);
  for (const e of r.errors) lines.push(`analysis error: ${e.object}: ${e.error}`);
  return lines;
}

// ------------------------------------------------------------------ CLI ----

const CONFIG = {global: {files: "/**/*.*"}, syntax: {version: abaplint.Version.OpenABAP, errorNamespace: "."}, rules: {}};
const ISLAND_FILE = /\.(?:clas(?:\.(?:locals_def|locals_imp|macros))?\.abap|intf\.abap|clas\.xml|intf\.xml|(?:tabl|dtel|doma|ttyp|view|type)\.xml|type\.abap)$/;

function filesUnder(dir, out = []) {
  for (const e of readdirSync(dir, {withFileTypes: true}).sort((a, b) => byText(a.name, b.name))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) filesUnder(p, out);
    else out.push(p);
  }
  return out;
}
const objectOfFile = (f) => up(baseName(f).split(".")[0].replace(/#/g, "/"));

/** the registry the CLI analyses: the island folders (later wins per file)
 *  as the analysed objects, this tree's libraries and src/ as what resolves
 *  around them; framework-namespace island objects are left out (never
 *  fetched under the frontier). Returns {reg, packages, dropped}. */
export function islandRegistry(root, islandDirs, frameworkNs) {
  const fw = new Set(frameworkNs);
  const island = new Map();
  const packages = {};
  const dropped = new Set();
  for (const dir of islandDirs) {
    for (const f of filesUnder(dir)) {
      if (ISLAND_FILE.test(baseName(f)) === false) continue;
      const obj = objectOfFile(f);
      if (fw.has(namespaceOf(obj))) {
        if (/\.(?:clas|intf)\.abap$/.test(f)) dropped.add(obj);
        continue;
      }
      island.set(baseName(f), f);
      const rel = f.slice(resolve(dir).length + 1).split("/");
      if (rel.length > 1) packages[obj] = rel[0];
    }
  }
  const islandObjects = new Set([...island.keys()].map(objectOfFile));
  const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify(CONFIG)));
  for (const [base, f] of [...island].sort((a, b) => byText(a[0], b[0]))) reg.addFile(new abaplint.MemoryFile(base, readFileSync(f, "utf8")));
  const deps = new Map();
  for (const lib of libraryFiles(root)) for (const f of lib.files) deps.set(baseName(f), f);
  for (const f of filesUnder(join(root, "src"))) deps.set(baseName(f), f);
  for (const [base, f] of [...deps].sort((a, b) => byText(a[0], b[0]))) {
    if (ISLAND_FILE.test(base) === false || islandObjects.has(objectOfFile(base)) || island.has(base)) continue;
    try {
      reg.addDependency(new abaplint.MemoryFile(base, readFileSync(f, "utf8")));
    } catch {
      // a second file of one name across the libraries: the first stays
    }
  }
  reg.parse();
  return {reg, packages, dropped: sorted(dropped)};
}

function main(argv) {
  const arg = (k) => argv.flatMap((a, i) => (a === k ? [argv[i + 1]] : []));
  const islands = arg("--island");
  const servicesFile = arg("--services")[0];
  if (islands.length === 0 || servicesFile === undefined) {
    process.stderr.write("usage: node tools/hana-closure-reach.mjs --island <dir> [--island <dir>] --services <json> [--json <out>] " +
      "[--alarms <json>] [--function-imports] [--cap <n>] [--framework-namespace /NS/]\n");
    return 2;
  }
  const root = fileURLToPath(new URL("..", import.meta.url));
  const raw = JSON.parse(readFileSync(servicesFile, "utf8"));
  const services = (Array.isArray(raw) ? raw : raw.services ?? []).map((s) => ({service: s.service, dpc: s.dpc, mpc: s.mpc}));
  const seedNames = services.flatMap((s) => [s.dpc, s.mpc]);
  const given = arg("--framework-namespace");
  const fw = given.length > 0 ? sorted(given.map(up)) : frameworkNamespaces(root, seedNames);
  const {reg, packages, dropped} = islandRegistry(root, islands, fw);
  const alarms = arg("--alarms").length > 0 ? JSON.parse(readFileSync(arg("--alarms")[0], "utf8")) : [];
  const result = reach(reg, services, {frameworkNamespaces: fw, functionImports: argv.includes("--function-imports"), alarms, packages,
    cap: arg("--cap").length > 0 ? Number(arg("--cap")[0]) : 400});
  result.frameworkObjects = sorted(new Set([...result.frameworkObjects, ...dropped]));
  result.namespaceSource = given.length > 0 ? "--framework-namespace" : "the libraries of abap_transpile.json, minus the seed's namespaces";
  for (const line of summaryLines(result)) process.stdout.write(`${line}\n`);
  if (arg("--json").length > 0) writeFileSync(arg("--json")[0], `${JSON.stringify(result, null, 1)}\n`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
