import {semanticQuery, withRole, provenanceGraph} from "./frontend-provenance.mjs";
// Superclass chains are walked lazily once per owner -- the program, or while
// a lowering is recorded its tracking proxy: the first walk in each recording
// still makes the reads a transcript and a cache key need, and later walks
// would only repeat them. A chain is extended exactly as far as the loop it
// replaces would have gone, 20 steps at most; step(c) names c's superclass.
/** @type {WeakMap<object, Map<string, import("./frontend-cache-types.ts").ChainEntry>>} */ const CHAINS = new WeakMap();
/** @param {WeakMap<object, Map<string, import("./frontend-cache-types.ts").ChainEntry>>} map @param {object} owner @returns {Map<string, import("./frontend-cache-types.ts").ChainEntry>} */ const memo = (map, owner) => map.get(owner) ?? map.set(owner, new Map()).get(owner);

/** @param {object} owner @param {import("./frontend-session-types.ts").Registry} reg @param {string | null | undefined} cls @param {string} ancestor @param {(name: string) => string | null | undefined} step @returns {boolean} */ export function chainHas(owner, reg, cls, ancestor, step) {
  if (!cls) return false;
  const chains = memo(CHAINS, owner);
  if (!chains.has(cls)) chains.set(cls, {reg, chain: [cls], done: false});
  const entry = chains.get(cls);
  if (entry.reg !== reg) {
    for (let c = cls, guard = 0; c && guard < 20; guard += 1) {
      if (c === ancestor) return true;
      c = step(c);
    }
    return false;
  }
  for (let i = 0; i < 20; i += 1) {
    if (i >= entry.chain.length) return false;
    const c = entry.chain[i];
    if (c === ancestor) return true;
    if (i + 1 === entry.chain.length && !entry.done) {
      const next = step(c);
      if (next) entry.chain.push(next); else entry.done = true;
    }
  }
  return false;
}

/** @param {{caught?: CaughtIndex}} program @param {readonly string[]} names @returns {boolean} */ export function caughtPresence(program, names) {
  if (!program.caught) throw new Error("caught index unavailable");
  return program.caught.get(JSON.stringify(names)) === true;
}

/** @typedef {{lookup: (key: string) => boolean, safe: () => boolean, get: (key: string) => boolean}} CaughtState */
/** @type {WeakMap<object, CaughtState>} */ const caughtIndexes = new WeakMap();
/** @param {unknown} value @returns {boolean} */ export const isCaughtIndex = (value) => typeof value === "object" && value !== null && caughtIndexes.has(value);
// A read-only caught index: its one method is a keyed read, recorded by the
// replay proxy like Map.get (frontend-replay.mjs). It has no own fields and
// no set/delete/clear; its state lives in caughtIndexes, keyed by identity.
export class CaughtIndex {
  /** @param {string} key @returns {boolean} */ get(key) {
    const state = caughtIndexes.get(this);
    if (!state) throw new Error("caught index unavailable");
    return state.get(key);
  }
}
// Rebuild the current selection's hierarchy before the class seam. A CATCH
// consumes whether any selected class matches, not the matching names or their
// implementation bytes. The old walk also tests at most twenty chain members.
/** @type {readonly import('./frontend-session-types.ts').QueryScalar[]} */ const yes = Object.freeze([true]), /** @type {readonly import('./frontend-session-types.ts').QueryScalar[]} */ no = Object.freeze([false]), /** @type {readonly string[]} */ noProviders = Object.freeze([]);
/** @param {import('./frontend-session-types.ts').Registry} reg @param {ReadonlySet<string>} wanted @param {(name: string) => string | null | undefined} step @returns {CaughtIndex} */ export function caughtIndex(reg, wanted, step) {
  /** @type {Set<string>} */ const ancestors = new Set(), /** @type {Set<string>} */ providers = new Set();
  withRole("scheduling", () => {
    for (const name of wanted) {
      for (let /** @type {string | null | undefined} */ at = name, i = 0; at && i < 20; i++) {
        ancestors.add(at);
        providers.add(`CLAS ${at.split(":")[0]}`);
        at = step(at);
      }
    }
  });
  const state = {/** @type {number | undefined} */ epoch: undefined, complete: false};
  /** @returns {boolean} */ const safe = () => {
    const trace = provenanceGraph(reg);
    if (!trace) return true;
    if (trace.unknownVersion === state.epoch) return state.complete;
    /** @param {import('./frontend-session-types.ts').QueryEntry | undefined} entry @returns {boolean} */ const unknown = (entry) => [...entry?.queries.values() ?? []].some((q) => q.role === "artifact" && q.kind === "unknown-scan");
    state.epoch = trace.unknownVersion;
    state.complete = !unknown(trace.global) && ![...providers].some((owner) => unknown(trace.artifacts.get(owner)));
    return state.complete;
  };
  /** @type {Map<string, boolean>} */ const values = new Map();
  /** @param {readonly string[]} names @returns {boolean} */ const answer = (names) => names.some((name) => ancestors.has(name));
  /** @param {string} key @returns {boolean} */ const lookup = (key) => {
    if (!values.has(key)) values.set(key, answer(JSON.parse(key)));
    return values.get(key) === true;
  };
  const index = new CaughtIndex();
  caughtIndexes.set(index, {lookup, safe, get: (key) => {
    const result = lookup(key);
    semanticQuery(reg, "caught", JSON.parse(key), result ? yes : no, {providers: noProviders, complete: safe(), policy: "selected-subclass-presence"});
    return result;
  }});
  return index;
}

/** @param {CaughtIndex | undefined} index @param {readonly string[]} names @returns {{result: readonly boolean[], providers: readonly string[], complete: boolean}} */ export function currentCaughtAnswer(index, names) {
  const state = index && caughtIndexes.get(index);
  if (!state) throw new Error("caught index unavailable");
  return {result: state.lookup(JSON.stringify(names)) ? yes : no, providers: noProviders, complete: state.safe()};
}
