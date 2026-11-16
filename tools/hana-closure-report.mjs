// What a closure run says about itself (H5x-4 B1): the loop's state file and
// argv helpers, carved out of tools/hana-closure.mjs (its size budget asked
// for exactly this carve), the stub record held once per (class, method),
// and the run summary with its seed guard.
//
// The stub record. A dumper round re-lays gen/hana-src from the layers, so
// every stub of the walk is cut AGAIN in the next iteration's stub round --
// bed run 21 recorded 298 entries for 101 unique (class, method) pairs, and
// the iteration line counted the entries. The record is a Map keyed by
// object, class and method: the latest round's finding wins, `rounds` counts
// how often the method was stubbed, and every reader -- the
// closure-stubs.json `stubs` section, the iteration line, the summary --
// reads the unique pairs. Since M3 B5.1 the record is the CURRENT
// iteration's (see "A stub exists only while its reason holds NOW" below).
//
// The summary (gen/hana-closure/closure-summary.json, written at the fixed
// point): {fixed_point, loads (+ load_error), iterations, island_objects,
// stubs_unique, lifted, lifted_stubs, excluded, gaps, seed: {classes,
// stubbed_methods}, failures}. It is the false-green
// guard of the brief: a green transpile proves nothing when the service's
// own classes were excluded or their reads stubbed away, so the run FAILS
// (after writing the summary) when
// - a seed class -- the registered service's MPC/DPC/_EXT, the closure
//   guard's own set -- is excluded, or one a registration or an island file
//   names is not an island object;
// - a seed-class method matches a --require-unstubbed glob and is stubbed.
//
// Milestone 4: the seeds are not the whole service. A service's DPC may
// inherit from ANOTHER service's _EXT class, and a hand-written DPC need
// not have a SEGW project nor a suffix; both run methods no seed glob
// looked at. serviceClasses(root) reads the registration the island has
// (gen/hana-segw/from-dump.json and the island's *.iwsv.xml / *.iwmo.xml,
// joined the way tools/segw-registry.mjs joins them -- never a name suffix)
// and follows each registered class's superclass chain through the island
// (abaplint's class definition); closureSummary, given those `services`,
// reports per service which of its classes carry stubs and applies
// --require-unstubbed to every one of them.
import {readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import * as abaplint from "@abaplint/core";
import {dumpFacts, mergeRegistrations, registeredServices, segwRegistrations} from "./segw-registry.mjs";

// ---------------------------------------------------------- state, argv ----

export const loadState = (out) => {
  try {
    return JSON.parse(readFileSync(join(out, "state.json"), "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
    throw error;
  }
};

export const saveState = (out, state) => {
  writeFileSync(join(out, "state.json"), JSON.stringify(state, null, 2) + "\n");
};

export function take(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`hana-closure: ${name} needs a value`);
  args.splice(at, 2);
  return value;
}

/** every value of a repeatable option, in order. */
export function takeAll(args, name) {
  const values = [];
  for (let value = take(args, name); value !== undefined; value = take(args, name)) values.push(value);
  return values;
}

export function has(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

// ---------------------------------------------------------- stub record ----

const stubKey = (r) => `${r.object ?? ""}|${r.class ?? ""}|${String(r.method ?? "").toUpperCase()}`;

/** one applied stub into the walk's record: a (class, method) already there
 *  takes the latest round's fields and counts one more round. `previous`
 *  -- the record of the iteration before, when the record is rebuilt per
 *  iteration -- only carries the round count over. Mutates and returns
 *  `record` (a Map). */
export function recordStub(record, stub, previous = undefined) {
  const key = stubKey(stub);
  const before = record.get(key) ?? previous?.get(key);
  record.set(key, {...stub, rounds: (before?.rounds ?? 0) + 1});
  return record;
}

/** the record's unique entries, in first-stubbed order. Pure. */
export const stubList = (record) => [...record.values()];

// A stub exists only while its reason holds NOW (M3 B5.1, the bed's fresh
// run: 111 unique stubs against 37 for the same island resumed). Every
// iteration re-lays gen/hana-src pristine from the layers and its stub
// rounds cut again whatever its findings still name, so the source was
// never wrong -- the RECORD was: one Map for the whole walk, never pruned,
// kept the stub of a method whose missing class arrived a dump later. The
// record is now the current iteration's stubs; an entry of the iteration
// before that this one did not cut again is LIFTED: its body is back and
// its record goes. A resumed run starts from the record on disk, so it
// lifts the same way a fresh run does, and both end on the same set.
// Within one iteration the record still accumulates over the stub rounds
// (H5x-2: a later round's decision must not drop an earlier round's stubs,
// which stay in the source until the next re-lay).

/** the record on disk as the iteration before a resumed run's first: the
 *  `stubs` section of closure-stubs.json keyed like the walk's own. */
export function loadStubRecord(out) {
  const record = new Map();
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(join(out, "closure-stubs.json"), "utf8"));
  } catch {
    return record;
  }
  for (const stub of Array.isArray(parsed?.stubs) === true ? parsed.stubs : []) record.set(stubKey(stub), stub);
  return record;
}

/** the entries of `previous` that `current` does not hold: the lifted
 *  stubs, as {object, class, method}. An object `excluded` from this
 *  iteration's build has no body back -- its stubs are gone, not lifted.
 *  Pure. */
export const liftedStubs = (previous, current, excluded = new Set()) => [...previous.entries()]
  .filter(([key, s]) => current.has(key) === false && excluded.has(String(s.object ?? "").toUpperCase()) === false)
  .map(([, s]) => ({object: s.object, class: s.class, method: String(s.method ?? "").toUpperCase()}));

/** the run's lifted set, kept across its iterations: a lift is added, a
 *  method stubbed again leaves it. Mutates and returns `lifted` (a Map). */
export function trackLifted(lifted, previous, current, excluded = new Set()) {
  for (const s of liftedStubs(previous, current, excluded)) lifted.set(stubKey(s), s);
  for (const key of current.keys()) lifted.delete(key);
  return lifted;
}

// ------------------------------------------------------------- summary ----

/** a --require-unstubbed glob as a predicate over (class, method): `*` and
 *  `?`, case-insensitive; a glob with `=>` matches `CLASS=>METHOD`, any
 *  other matches the method name alone. Pure. */
export function unstubbedGlob(glob) {
  const text = String(glob).toUpperCase();
  const re = new RegExp(`^${text.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
  return (cls, method) => re.test(text.includes("=>") === true
    ? `${String(cls).toUpperCase()}=>${String(method).toUpperCase()}` : String(method).toUpperCase());
}

/** the island's class files by object name: `<name>.clas.abap` below
 *  gen/hana-src (a `#ns#` file name is /NS/), the later file winning */
function islandClassFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (/^[^.]+\.clas\.abap$/i.test(entry.name) === true) {
        files.set(entry.name.replace(/\.clas\.abap$/i, "").replace(/#/g, "/").toUpperCase(), join(dir, entry.name));
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  return files;
}

/** the superclass a class file names (abaplint's class definition, never a
 *  regex over ABAP), upper case, or undefined */
export function superClassOf(filename, source) {
  const reg = new abaplint.Registry().addFile(new abaplint.MemoryFile(filename, source)).parse();
  const obj = reg.getFirstObject();
  const name = obj?.getType?.() === "CLAS" ? obj.getClassDefinition?.()?.superClassName : undefined;
  return name === undefined || name === "" ? undefined : String(name).toUpperCase();
}

/** The registered services of the island at `root` and the classes each
 *  runs: [{service, dpc, mpc, classes}] -- the registered DPC and MPC and
 *  every superclass of either that is an island class, in chain order. The
 *  registration is the island's own: the dump facts (gen/hana-segw) merged
 *  under the island's *.iwsv.xml / *.iwmo.xml the way the SEGW registry
 *  merges them. A class outside the island ends its chain (the framework's
 *  base classes are not the service's). */
export function serviceClasses(root) {
  const xml = segwRegistrations([join(root, "gen", "hana-src")]);
  const facts = dumpFacts(join(root, "gen", "hana-segw"));
  const {entries} = mergeRegistrations(xml, facts?.services ?? []);
  const files = islandClassFiles(root);
  const supers = new Map();
  const superOf = (name) => {
    if (supers.has(name) === false) {
      const file = files.get(name);
      supers.set(name, file === undefined ? undefined : superClassOf(file.slice(file.lastIndexOf("/") + 1), readFileSync(file, "utf8")));
    }
    return supers.get(name);
  };
  const chain = (start) => {
    const out = [];
    for (let name = String(start ?? "").trim().toUpperCase(); name !== "" && files.has(name) === true && out.includes(name) === false; name = superOf(name) ?? "") {
      out.push(name);
    }
    return out;
  };
  return registeredServices(entries).map((e) => {
    const dpc = String(e.dpc).toUpperCase();
    const mpc = String(e.mpc).toUpperCase();
    return {service: String(e.external ?? e.service), dpc, mpc, classes: [...new Set([...chain(dpc), ...chain(mpc)])]};
  }).sort((a, b) => (a.service < b.service ? -1 : a.service > b.service ? 1 : 0));
}

/** the run summary and its failures. Inputs: `seeds` -- the seed classes
 *  (the closure guard's set); `named` -- those a registration or an island
 *  file named, which must be island objects (a base derived off an _EXT
 *  name is checked only for exclusion; absent, the _EXT's own superclass
 *  ask covers it); `present(name)` -- an island object by file;
 *  `excluded` -- the excluded objects; `stubs` -- the unique stub list;
 *  `lifted` -- the stubs this run lifted ({object, class, method}, see
 *  trackLifted); `gaps` -- [{name, kind}]; `requireUnstubbed` -- the
 *  globs; `load` -- {loads, error, built?} from the load check (B6);
 *  `searchHelps` -- the summary's search_helps block, passed through;
 *  `services` -- serviceClasses(root): with it the summary carries a
 *  `services` block (per service the classes that carry stubs) and
 *  --require-unstubbed covers every class of every service, not only the
 *  seeds. Pure. */
export function closureSummary({fixedPoint = true, iterations, islandObjects, seeds, named = seeds, present, excluded, stubs, lifted = [], gaps, requireUnstubbed = [], load, searchHelps, services}) {
  const seedList = [...(seeds ?? [])].map((s) => String(s).toUpperCase()).sort();
  const seedSet = new Set(seedList);
  const excludedList = [...(excluded ?? [])].map((s) => String(s).toUpperCase()).sort();
  const excludedSet = new Set(excludedList);
  const seedStubs = (stubs ?? [])
    .filter((s) => seedSet.has(String(s.object ?? s.class ?? "").toUpperCase()) === true)
    .map((s) => ({class: String(s.object ?? s.class).toUpperCase(), method: String(s.method).toUpperCase()}))
    .sort((a, b) => (a.class + "|" + a.method < b.class + "|" + b.method ? -1 : 1));
  const namedSet = new Set([...(named ?? [])].map((s) => String(s).toUpperCase()));
  const failures = [];
  for (const seed of seedList) {
    if (present(seed) !== true) {
      if (namedSet.has(seed) === true) failures.push(`seed class ${seed} is not an island object`);
    } else if (excludedSet.has(seed) === true) failures.push(`seed class ${seed} is excluded from the build`);
  }
  // milestone 4: every class a registered service runs, seeds or not
  const stubOf = (s) => ({class: String(s.object ?? s.class).toUpperCase(), method: String(s.method).toUpperCase()});
  const byClass = new Map();
  for (const s of stubs ?? []) {
    const one = stubOf(s);
    if (byClass.has(one.class) === false) byClass.set(one.class, new Set());
    byClass.get(one.class).add(one.method);
  }
  const serviceBlock = services === undefined ? undefined : services.map((svc) => {
    const stubbed = svc.classes.filter((c) => byClass.has(c) === true)
      .map((c) => ({class: c, methods: [...byClass.get(c)].sort()}));
    return {service: svc.service, dpc: svc.dpc, mpc: svc.mpc, classes: [...svc.classes], stubbed};
  });
  const checked = new Map(seedStubs.map((s) => [`${s.class}|${s.method}`, {...s, services: []}]));
  for (const svc of serviceBlock ?? []) {
    for (const {class: cls, methods} of svc.stubbed) {
      for (const method of methods) {
        const key = `${cls}|${method}`;
        if (checked.has(key) === false) checked.set(key, {class: cls, method, services: []});
        checked.get(key).services.push(svc.service);
      }
    }
  }
  for (const glob of requireUnstubbed) {
    const match = unstubbedGlob(glob);
    const hit = [...checked.values()].filter((s) => match(s.class, s.method) === true)
      .sort((a, b) => (a.class + "|" + a.method < b.class + "|" + b.method ? -1 : 1));
    if (hit.length > 0) {
      const what = services === undefined ? "seed method(s)" : "service method(s)";
      failures.push(`--require-unstubbed ${glob}: ${hit.length} ${what} stubbed: ${hit.map((s) => `${s.class}=>${s.method}${s.services.length > 0 ? ` (${s.services.join(", ")})` : ""}`).join(", ")}`);
    }
  }
  // B6: a fixed point whose build is green and whose generation does not
  // import is not a service; a build that did not complete says so itself
  if (load !== undefined && load.loads !== true && load.built !== false) {
    failures.push(`the island generation does not load: ${load.error}`);
  }
  return {
    fixed_point: fixedPoint,
    ...(load !== undefined ? {loads: load.loads === true, ...(load.loads === true ? {} : {load_error: load.error})} : {}),
    iterations,
    island_objects: islandObjects,
    stubs_unique: (stubs ?? []).length,
    lifted: [...lifted].length,
    lifted_stubs: [...lifted].map((s) => ({class: String(s.object ?? s.class).toUpperCase(), method: String(s.method).toUpperCase()}))
      .sort((a, b) => (a.class + "|" + a.method < b.class + "|" + b.method ? -1 : 1)),
    excluded: excludedList,
    gaps: (gaps ?? []).map((g) => ({name: g.name, kind: g.kind})),
    seed: {classes: seedList, stubbed_methods: seedStubs},
    ...(serviceBlock !== undefined ? {services: serviceBlock} : {}),
    // milestone 3: the search helps the island names (tools/hana-closure-shlp.mjs
    // searchHelpSummary); a seed's value-help set whose help is missing is
    // listed under `unserved`, never a failure
    ...(searchHelps !== undefined ? {search_helps: searchHelps} : {}),
    ...(requireUnstubbed.length > 0 ? {require_unstubbed: [...requireUnstubbed]} : {}),
    failures,
  };
}

/** writes closure-summary.json and throws when the summary carries a
 *  failure: the run exits non-zero, the summary on disk says why. */
export function writeClosureSummary(out, summary) {
  writeFileSync(join(out, "closure-summary.json"), JSON.stringify(summary, null, 2) + "\n");
  if (summary.failures.length > 0) {
    throw new Error(`the fixed point does not carry the service (${join(out, "closure-summary.json")}):\n  ${summary.failures.join("\n  ")}`);
  }
}
