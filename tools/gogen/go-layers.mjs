// Layered Go emission: the generated classes of one program split into a
// stack of Go packages, each importing only the ones below it, so a change in
// an upper package recompiles that package and the link, not the whole
// program. One mechanism for every runner that builds a large program:
// unit.mjs (core = libraries, app = the repository, main = the test classes)
// and osgo.mjs (core = libraries, app = the repository, main = the objects
// being edited and cmd/osgo itself).
//
// A class starts in the tier its caller gives it (`classTier`) and is
// promoted until nothing it references lies above it: its superclass, the
// classes it calls or creates, the types of its attributes, parameters,
// locals and bodies, the interfaces it implements. A cycle of classes ends up
// in one tier (the highest of its members). Structures, constants, tables
// and interfaces follow the classes that own or use them. The emitter
// exports fields in a layered build (emit-go.mjs `ident`), which is the only
// difference in the Go it writes; behaviour does not depend on the tiers.
import {mkdirSync} from "node:fs";
import {join} from "node:path";
import {referencedClasses} from "./emit-go.mjs";
import {constructorFactories} from "./emit-constructors.ts";
import {writeGo, writeSymbols} from "./symbols.ts";

/** the classes a method body calls, creates or tests against (IS INSTANCE OF) */
export function callsIn(node, out) {
  if (Array.isArray(node)) { for (const n of node) callsIn(n, out); return out; }
  if (!node || typeof node !== "object") return out;
  if (node.e === "call") {
    if (node.owner) out.add(node.owner);
    if (node.receiver?.type?.k === "ref" && !node.receiver.type.intf) out.add(node.receiver.type.name);
  }
  if (node.e === "new") out.add(node.cls);
  // IS INSTANCE OF a class: the class must be compiled, an object of a
  // subclass of it can exist (a stub would answer false for it)
  if (node.c === "instance_of" && !node.type?.intf && node.type?.name !== "OBJECT") out.add(node.type.name);
  for (const [k, v] of Object.entries(node)) if (k !== "type") callsIn(v, out);
  return out;
}

export const goSymbol = (name) => {
  const id = String(name).toUpperCase().replace(/=>|~|-/g, "__").replace(/[^A-Z0-9_]/g, "_");
  return id.startsWith("_") ? `N${id}` : id;
};

/**
 * Assign every class, interface, structure, constant and table of `program`
 * to a tier.
 * @param program the front end's program
 * @param {{names: string[], classTier: (name: string) => number, interfaceTier: (name: string) => number, ddicTier: (name: string) => number|undefined}} opts
 *   names: one per tier, the last is package main; classTier: the starting
 *   tier of a class (IR name, `OWNER:LOCAL` for a local class);
 *   interfaceTier: of a global interface; ddicTier: of a DDIC structure by
 *   its name, undefined when it is no DDIC object (tier 0)
 */
export function planLayers(program, {names, classTier, interfaceTier, ddicTier, pullDown = false}) {
  // emitGo resolves omitted constructor arguments, and a DEFAULT may register a
  // structured constant or an anonymous type (/UI2/CL_JSON's PRETTY_MODE); do it
  // before the layers are split, or that declaration lands in no package. The
  // class's by-name factory uses those values, so they count like its body.
  const factories = constructorFactories(program);
  const layer = new Map(program.classes.map((c) => [c.name, classTier(c.name)]));
  const interfaceLayer = new Map([...program.interfaceMethods.keys()].map((name) => [name, interfaceTier(name)]));
  // the class or interface a structure or constant belongs to (ZCL_X__TY_Y,
  // ZIF_X__TY_Y), longest Go name first; its tier is read when asked
  const owners = [...[...layer.keys()].map((name) => ({name, symbol: goSymbol(name), tiers: layer})),
    ...[...interfaceLayer.keys()].map((name) => ({name, symbol: goSymbol(name), tiers: interfaceLayer}))]
    .sort((a, b) => b.symbol.length - a.symbol.length);
  const ownerTier = (name) => { const o = owners.find(({symbol}) => name.startsWith(symbol + "__")); return o ? o.tiers.get(o.name) : undefined; };
  // A structure the front end named after the first class that used its
  // shape (no qname: ZCL_X__S_SIGN_OPTION_LOW_HIGH) is shared by shape, not
  // owned: it starts low and rises only with its fields.
  const structOwnerTier = (name) => program.structs.get(name)?.qname ? ownerTier(name) : undefined;
  const structLayer = new Map([...program.structs].map(([name, st]) => [name, structOwnerTier(name) ?? ddicTier(st.qname ?? name) ?? 0]));
  const typeLayer = (t) => !t ? 0 : t.k === "table" ? typeLayer(t.row)
    : t.k === "struct" ? (structLayer.get(t.go) ?? 0)
      : t.k === "ref" ? (t.intf ? interfaceLayer.get(t.name) : layer.get(t.name)) ?? 0 : 0;
  const bodyTypeLayer = (node) => {
    if (Array.isArray(node)) return node.reduce((max, value) => Math.max(max, bodyTypeLayer(value)), 0);
    if (!node || typeof node !== "object") return 0;
    return Object.entries(node).reduce((max, [key, value]) =>
      key === "type" ? max : Math.max(max, bodyTypeLayer(value)), typeLayer(node.type));
  };
  const refsOf = new Map();
  const classRefs = (c) => {
    let refs = refsOf.get(c);
    if (refs) return refs;
    refs = new Set(referencedClasses({...program, classes: [c], structs: new Map()}));
    if (c.super) refs.add(c.super);
    for (const m of c.methods) callsIn(m.body, refs);
    for (const m of c.stubs ?? []) callsIn(m.body, refs);
    refsOf.set(c, refs);
    return refs;
  };
  // pullDown: what a lower tier references comes down to it (the tree's DDIC
  // and interfaces a library uses go with the library), except the top tier,
  // which stays where it is; the promotion below then lifts whatever
  // references the top tier. Without it a class only ever moves up.
  const lowered = pullDown ? lowerReferenced() : 0;
  const initialLayer = new Map(layer);
  function lowerReferenced() {
    const last = names.length - 1;
    const tierOf = (key) => key[0] === "c" ? layer.get(key.slice(2)) : key[0] === "i" ? interfaceLayer.get(key.slice(2)) : structLayer.get(key.slice(2));
    const setTier = (key, t) => (key[0] === "c" ? layer : key[0] === "i" ? interfaceLayer : structLayer).set(key.slice(2), t);
    const typeKeys = (t, out) => {
      if (!t) return out;
      if (t.k === "table") return typeKeys(t.row, out);
      if (t.k === "struct" && structLayer.has(t.go)) out.add(`s:${t.go}`);
      if (t.k === "ref") out.add(`${t.intf ? "i" : "c"}:${t.name}`);
      return out;
    };
    const bodyKeys = (node, out) => {
      if (Array.isArray(node)) { for (const n of node) bodyKeys(n, out); return out; }
      if (!node || typeof node !== "object") return out;
      typeKeys(node.type, out);
      for (const [k, v] of Object.entries(node)) if (k !== "type") bodyKeys(v, out);
      return out;
    };
    const ownerKey = (name) => { const o = owners.find(({symbol}) => name.startsWith(symbol + "__")); return o ? `${o.tiers === layer ? "c" : "i"}:${o.name}` : undefined; };
    const classes = new Map(program.classes.map((c) => [c.name, c]));
    const edgesOf = (key) => {
      const out = new Set();
      const name = key.slice(2);
      if (key[0] === "c") {
        const c = classes.get(name);
        for (const ref of classRefs(c)) out.add(`c:${ref}`);
        for (const intf of c.interfaces ?? []) out.add(`i:${intf}`);
        for (const a of c.attributes ?? []) typeKeys(a.type, out);
        for (const m of [...c.methods, ...(c.stubs ?? []), ...(c.constructor ? [c.constructor] : [])]) {
          typeKeys(m.returning?.type, out);
          for (const p of m.params ?? []) typeKeys(p.type, out);
          for (const l of m.locals ?? []) typeKeys(l.type, out);
          bodyKeys(m.body, out);
        }
        bodyKeys(factories.get(c.name)?.args, out);
      } else if (key[0] === "i") {
        for (const m of program.interfaceMethods.get(name) ?? []) {
          typeKeys(m.returning?.type, out);
          for (const p of m.params ?? []) typeKeys(p.type, out);
        }
      } else {
        for (const f of program.structs.get(name)?.fields ?? []) typeKeys(f.type, out);
      }
      // a structure sits at least as high as its owner (the promotion), so
      // the owner comes down with it
      if (key[0] === "s" && program.structs.get(name)?.qname) { const o = ownerKey(name); if (o) out.add(o); }
      return [...out].filter((k) => tierOf(k) !== undefined);
    };
    let count = 0;
    const all = [...[...layer.keys()].map((n) => `c:${n}`), ...[...interfaceLayer.keys()].map((n) => `i:${n}`), ...[...structLayer.keys()].map((n) => `s:${n}`)];
    for (let t = 0; t < last - 1; t++) {
      const queue = all.filter((k) => tierOf(k) === t);
      while (queue.length) {
        for (const ref of edgesOf(queue.pop())) {
          const at = tierOf(ref);
          if (at > t && at < last) { setTier(ref, t); count++; queue.push(ref); }
        }
      }
    }
    return count;
  }
  // a cycle across tiers goes to the highest tier among its members (the
  // promotion below would end there too, one reference at a time)
  const edges = new Map(program.classes.map((c) => [c.name, [...classRefs(c)].filter((ref) => layer.has(ref))]));
  const index = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const crossLayerCycles = [];
  function visitCycle(name) {
    index.set(name, index.size);
    low.set(name, index.get(name));
    stack.push(name);
    onStack.add(name);
    for (const ref of edges.get(name) ?? []) {
      if (!index.has(ref)) { visitCycle(ref); low.set(name, Math.min(low.get(name), low.get(ref))); }
      else if (onStack.has(ref)) low.set(name, Math.min(low.get(name), index.get(ref)));
    }
    if (low.get(name) !== index.get(name)) return;
    const component = [];
    let member;
    do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== name);
    if (component.length < 2 || new Set(component.map((n) => initialLayer.get(n))).size < 2) return;
    component.sort();
    crossLayerCycles.push(component);
    const top = Math.max(...component.map((n) => layer.get(n)));
    for (const n of component) layer.set(n, top);
  }
  for (const name of layer.keys()) if (!index.has(name)) visitCycle(name);
  // why a class left its starting tier: the first reference that lifted it
  const because = new Map();
  // every promotion in the order it happened (the first ones are the causes)
  const order = [];
  for (const cycle of crossLayerCycles) for (const n of cycle) if (layer.get(n) > initialLayer.get(n)) because.set(n, `cycle ${cycle.join(" ")}`);
  let promoted = true;
  while (promoted) {
    promoted = false;
    for (const [name, st] of program.structs) {
      const next = st.fields.reduce((max, f) => Math.max(max, typeLayer(f.type)),
        Math.max(structLayer.get(name), structOwnerTier(name) ?? 0));
      if (next > structLayer.get(name)) { structLayer.set(name, next); promoted = true; order.push(`struct ${name}`); }
    }
    for (const [name, sigs] of program.interfaceMethods) {
      const next = sigs.reduce((max, m) => m.params.reduce((tier, p) => Math.max(tier, typeLayer(p.type)),
        Math.max(max, typeLayer(m.returning?.type))), interfaceLayer.get(name));
      if (next > interfaceLayer.get(name)) { interfaceLayer.set(name, next); promoted = true; order.push(`interface ${name}`); }
    }
    for (const c of program.classes) {
      let next = layer.get(c.name);
      for (const ref of classRefs(c)) if ((layer.get(ref) ?? 0) > next) { next = layer.get(ref); because.set(c.name, `class ${ref}`); order.push(`class ${c.name} by class ${ref}`); }
      for (const intf of c.interfaces ?? []) if ((interfaceLayer.get(intf) ?? 0) > next) { next = interfaceLayer.get(intf); because.set(c.name, `interface ${intf}`); order.push(`class ${c.name} by interface ${intf}`); }
      if (next > layer.get(c.name)) { layer.set(c.name, next); promoted = true; }
      for (const a of c.attributes ?? []) next = Math.max(next, typeLayer(a.type));
      for (const m of [...c.methods, ...(c.stubs ?? []), ...(c.constructor ? [c.constructor] : [])]) {
        next = Math.max(next, typeLayer(m.returning?.type));
        for (const p of m.params ?? []) next = Math.max(next, typeLayer(p.type));
        for (const l of m.locals ?? []) next = Math.max(next, typeLayer(l.type));
        next = Math.max(next, bodyTypeLayer(m.body));
      }
      next = Math.max(next, bodyTypeLayer(factories.get(c.name)?.args));
      if (next > layer.get(c.name)) { layer.set(c.name, next); promoted = true; because.set(c.name, "a type"); order.push(`class ${c.name} by a type`); }
    }
  }
  const layerClasses = names.map((_, i) => program.classes.filter((c) => layer.get(c.name) === i));
  const info = {
    classes: Object.fromEntries(names.map((name, i) => [name, layerClasses[i].length])),
    lowered,
    crossLayerCycles,
    promoted: [...layer].filter(([name, value]) => value > initialLayer.get(name))
      .map(([name, value]) => ({class: name, from: names[initialLayer.get(name)], to: names[value], because: because.get(name)})),
  };
  return {order, names, layer, structLayer, interfaceLayer, typeLayer, ownerTier, layerClasses, info};
}

/**
 * Write each tier: tier i < last into `pkgDir(i)` as package names[i],
 * imported as `importPath(i)`; the last tier into mainDir as package main,
 * dot-importing all below. Returns the Go source of each tier, bottom first
 * (undefined for a tier in `skip`, whose emission the caller proved
 * unchanged: its symbols still enter mainDir/symbols.json, through
 * `symbolsOf(i)`).
 */
export function writeLayers(program, plan, {mainDir, pkgDir, importPath, unitBuild = true, skip = new Set(), symbolsOf, symbolsSink}) {
  const {names, layer, structLayer, interfaceLayer, typeLayer, ownerTier, layerClasses} = plan;
  const last = names.length - 1;
  const symbols = new Map();
  const allClassNames = new Set(program.classes.map((c) => c.name));
  const markerOf = (i) => `Gogen${names[i][0].toUpperCase()}${names[i].slice(1)}Layer`;
  const sources = [];
  // the whole-program analyses (ownership, table moves) are the same for
  // every tier: computed by the first emission, reused by the others
  const analysis = {};
  for (let i = 0; i <= last; i++) {
    if (skip.has(i)) {
      sources.push(undefined);
      for (const [key, entry] of symbolsOf?.(i) ?? []) symbols.set(key, entry);
      continue;
    }
    const before = symbols.size;
    const dir = i === last ? mainDir : pkgDir(i);
    mkdirSync(dir, {recursive: true});
    const own = new Set(layerClasses[i].map((c) => c.name));
    const below = [...Array(i).keys()];
    sources.push(writeGo(join(dir, "zz_generated.go"), program, i === last ? "main" : names[i], {
      classes: layerClasses[i], visibleClasses: new Set([...allClassNames].filter((n) => layer.get(n) <= i)),
      structs: new Map([...program.structs].filter(([name]) => structLayer.get(name) === i)),
      consts: new Map([...program.consts].filter(([name, c]) => {
        return Math.max(ownerTier(name) ?? 0, typeLayer(c.type)) === i;
      })),
      tables: (program.tables ?? []).filter((t) => typeLayer(t.row) === i),
      // every tier, main too: an edited interface starts in main, and one whose
      // signature names a type of main is promoted there
      interfaces: new Set([...interfaceLayer].filter(([, t]) => t === i).map(([name]) => name)),
      events: new Map([...program.events].filter(([, ev]) => (layer.get(ev.decl) ?? interfaceLayer.get(ev.decl) ?? 0) === i)),
      externalClasses: new Set([...allClassNames].filter((n) => i === last ? layer.get(n) < last : !own.has(n))),
      ...(below.length ? {imports: below.map(importPath), importMarkers: below.map(markerOf)} : {}),
      ...(i === last ? {} : {marker: markerOf(i)}), analysis,
    }, unitBuild, symbols, i === last ? "main" : importPath(i)));
    symbolsSink?.(i, [...symbols].slice(before));
  }
  writeSymbols(mainDir, symbols);
  return sources;
}
