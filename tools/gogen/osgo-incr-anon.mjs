// The anonymous structures of the osgo per-object front-end cache: which
// declaration owns an instance, and the name a fast build gives it. Part of
// tools/gogen/osgo-incr.mjs (README tools/gogen/osgo-incr.md), carved out of
// it (the size rule).
const upper = (text) => String(text).toUpperCase();
const keyOf = (type, name) => `${type} ${name}`;

/** the component names of an anonymous structure: what both builds can
 *  name it by (abaplint keys it by type instance, which a new registry
 *  does not share) */
export const shapeOf = (t) => { try { return t.getComponents().map((c) => upper(c.name)).join(","); } catch { return undefined; } };

/** where each anonymous structure instance of a registry is declared: the
 *  global class or interface member that owns it, as paths
 *  ("CLAS ZCX_A|C|BUSINESS_ERROR", a component or row below it appended).
 *  Both builds' registries parse the same declarations, so a path names the
 *  same instance in both -- which the shape alone does not (every exception
 *  class has its own MSGID/MSGNO/ATTR1..4 textid constant). Built once per
 *  registry, after the syntax pass, at the first anonymous structure the
 *  lowering reaches. An instance no global member owns (a method's own
 *  local type) has no path. */
export function anonOrigins(reg) {
  const out = new Map(); // instance -> [paths]
  const visit = (t, path, depth) => {
    if (!t || typeof t !== "object" || depth > 12) return;
    try {
      if (typeof t.getComponents === "function" && typeof t.getQualifiedName === "function") {
        if (!t.getQualifiedName()) { if (!out.has(t)) out.set(t, []); out.get(t).push(path); }
        for (const c of t.getComponents()) visit(c.type, `${path}-${upper(c.name)}`, depth + 1);
      } else if (typeof t.getRowType === "function") visit(t.getRowType(), `${path}[]`, depth + 1);
    } catch { /* a type abaplint cannot describe owns no path */ }
  };
  for (const obj of reg.getObjects()) {
    const type = obj.getType();
    if (type !== "CLAS" && type !== "INTF") continue;
    let def;
    try { def = obj.getDefinition(); } catch { continue; }
    if (!def) continue;
    const base = keyOf(type, upper(obj.getName()));
    try { for (const a of def.getAttributes().getAll()) visit(a.getType(), `${base}|A|${upper(a.getName())}`, 0); } catch { /* none */ }
    try { for (const c of def.getAttributes().getConstants()) visit(c.getType(), `${base}|C|${upper(c.getName())}`, 0); } catch { /* none */ }
    try { for (const td of def.getTypeDefinitions().getAll()) visit(td.type.getType(), `${base}|T|${upper(td.type.getName())}`, 0); } catch { /* none */ }
    try {
      for (const m of def.getMethodDefinitions().getAll()) for (const prm of m.getParameters().getAll()) visit(prm.getType(), `${base}|M|${upper(m.getName())}|${upper(prm.getName())}`, 0);
    } catch { /* none */ }
  }
  return out;
}

/** abaplint keys anonymous structures by type instance; a new registry has
 *  new instances, so the substitute answers by the component names the
 *  write-time build named, which is the same answer whenever abaplint
 *  shared the instance -- and never invents one (a miss lowers as the full
 *  build would, naming the structure after the class that reached it) */
export class AnonShapes {
  /** @param {Map<string, string>} seed shape -> the one name the write-time build gave it
   *  @param {() => string | null} currentKey the object lowering now
   *  @param {Record<string, string | null>} named declaration path -> the name the full build gave its instance
   *  @param {(t: any) => string[]} originsOf the declaration paths of an instance in this registry
   *  @param {() => number | undefined} position where the object lowering now sits in the full build's segment sequence */
  constructor(seed, currentKey = () => null, named = {}, originsOf = () => [], position = () => undefined) {
    Object.assign(this, {seed, currentKey, named, originsOf, position});
    this.mine = new Map();
    this.doubt = undefined;
    /** declaration path -> the earliest position a fresh lowering reached it at */
    this.reached = new Map();
  }
  /** a fresh lowering reached instance `t`: where, by every path naming it */
  reach(t) {
    if (this.currentKey() === null) return;
    const at = this.position();
    for (const p of this.originsOf(t)) {
      if (at === undefined) { this.doubt ??= `${this.currentKey()} reached the anonymous structure of ${p} outside the live generation's segments`; continue; }
      if (!this.reached.has(p) || this.reached.get(p) > at) this.reached.set(p, at);
    }
  }
  /** The full build named every instance after the FIRST object of its
   *  order to reach it; a fresh lowering reaches it in another order (the
   *  first reacher may be cached), and the shape does not say which
   *  instance it is (every exception class has its own MSGID/MSGNO/ATTR1..4
   *  textid constant). The declaration does:
   *  - an instance a global class or interface member owns takes the name
   *    the full build gave that declaration. None recorded means no object
   *    of the full build reached it -- a cached object reaches what it
   *    reached then, so only re-lowered objects reach it now, in the full
   *    build's relative order, and the first of them names it, here as
   *    there.
   *  - an instance no global member owns comes from the lowering object's
   *    own syntax run (its own definition, a method's local type): only
   *    that object reaches it, and it names it after itself, both ways.
   *  - outside every object's mark (a global pass) the old answer stands:
   *    the one name the write-time build gave the shape, if it gave one. */
  get(t) {
    this.reach(t);
    if (this.mine.has(t)) {
      const go = this.mine.get(t);
      for (const p of this.originsOf(t)) {
        if (Object.hasOwn(this.named, p) && this.named[p] !== go) this.doubt ??= `the anonymous structure of ${p} is ${go} here, ${this.named[p]} in the live generation`;
      }
      return go;
    }
    const paths = this.originsOf(t);
    if (paths.length > 0) {
      const names = new Set(paths.filter((p) => Object.hasOwn(this.named, p)).map((p) => this.named[p]));
      if (names.has(null) || names.size > 1) {
        this.doubt ??= `the anonymous structure of ${paths[0]} had several names in the live generation`;
        return undefined;
      }
      const recorded = [...names][0];
      if (recorded !== undefined) this.mine.set(t, recorded);
      return recorded;
    }
    if (this.currentKey() !== null) return undefined;
    const shape = shapeOf(t);
    return shape === undefined ? undefined : this.seed.get(shape);
  }
  set(t, go) { this.reach(t); this.mine.set(t, go); }
  has(t) { return this.get(t) !== undefined; }
  seededNames() { return new Set(this.seed.values()); }
}

/** Whether the first reacher of a declared anonymous structure moved: the
 *  full build names an instance after the FIRST object of its segment
 *  sequence to reach it (`recorded`: path -> {object key or "" for a global
 *  pass: first position}). In the fast build the cached objects reach what
 *  they reached then, the re-lowered ones what `reached` says now; an edit
 *  that makes an earlier object reach it (or stops the first reacher from
 *  reaching it) renames it in the full build, and the pinned name would be
 *  wrong. Returns the first such path, or undefined.
 *  @param {Record<string, Record<string, number>>} recorded
 *  @param {Map<string, number>} reached
 *  @param {Set<string>} relower */
export function anonFirstMoved(recorded, reached, relower) {
  for (const [path, by] of Object.entries(recorded)) {
    const fresh = reached.get(path);
    const entries = Object.entries(by);
    if (fresh === undefined && !entries.some(([k]) => k !== "" && relower.has(k))) continue;
    const was = Math.min(...entries.map(([, at]) => at));
    const now = Math.min(...entries.filter(([k]) => k === "" || !relower.has(k)).map(([, at]) => at), fresh ?? Infinity);
    if (now !== was) return path;
  }
  return undefined;
}
