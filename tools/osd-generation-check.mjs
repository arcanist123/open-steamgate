// Can the generation load? A transpile that exits 0 says the transpiler
// wrote files; it does not say node can evaluate them. Twice on the HANA
// track (2026-11-14) a green transpile left a generation that could not
// load: five modules were invalid JavaScript (`INPUT.it_x[]`, ANORMALIES
// table-body-suffix-js), and a class pool whose locals subclass the global
// class made the class module and its locals module await each other at the
// top level (ANORMALIES local-inherits-owner). Neither showed until a host
// imported init.mjs: the first as a SyntaxError naming another line, the
// second as a boot that never returned (node exits 13, "unsettled top-level
// await", only once nothing else keeps the event loop alive -- a host with
// an open database connection just hangs).
//
// Three checks, cheapest first:
//   syntax  every module parsed as an ES module by V8 (what `node --check`
//           does, in one child instead of one per file); a failure refuses
//           when init.mjs or index.mjs reaches the module at load time, and
//           is reported as latent when only a run imports it (a program);
//   cycles  the top-level `await import("./x")` edges between modules: a
//           cycle among them never settles once it is entered, so any cycle
//           is a defect, named module by module;
//   load    (opt-in, it costs a full import) a child node imports the entry
//           (init.mjs); exit 13 is the unsettled top-level await.
// The build runs syntax and cycles over a new generation before it is named
// (tools/osd-build.mjs), hana-serve before it imports one; the CLI runs all
// three: `node tools/osd-generation-check.mjs [output] [--no-load] [--json]`.
//
// A module already known not to parse is named in
// tools/osd-generation-check.allow.json with its reason and its anomaly; an
// entry whose module now parses is reported as stale. Cycles and load
// failures have no allow list.
import {spawnSync} from "node:child_process";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {runsAs} from "./osd-main.mjs";

const TOOLS = dirname(fileURLToPath(import.meta.url));
export const ALLOW_FILE = join(TOOLS, "osd-generation-check.allow.json");

// node exits with 13 when the main module's top-level await never settles
export const UNSETTLED_TLA = 13;

// The generated code's own import form: one statement per line, at column 0,
// relative to the module (packages/transpiler/src/handlers/handle_abap.ts and
// the unit/init scripts). An indented import is inside a function and runs
// later, so it is not a load-time edge.
const TOP_LEVEL_IMPORT = /^(?:const \{[^}]*\} = )?await import\("(\.{1,2}\/[^"]+)"\);$/gm;

export function modulesOf(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => f.endsWith(".mjs")).sort();
}

/** module -> the modules it awaits at the top level (same folder only;
 *  anything else, such as ../test/setup.mjs, is outside the generation) */
export function importEdges(dir, modules = modulesOf(dir)) {
  const known = new Set(modules);
  const edges = new Map();
  for (const module of modules) {
    const targets = [];
    for (const match of readFileSync(join(dir, module), "utf8").matchAll(TOP_LEVEL_IMPORT)) {
      const specifier = match[1];
      if (!specifier.startsWith("./") || specifier.slice(2).includes("/")) continue;
      const target = decodeURIComponent(specifier.slice(2));
      if (known.has(target)) targets.push(target);
    }
    edges.set(module, targets);
  }
  return edges;
}

/** every cycle among the edges, one per strongly connected component, as
 *  the path that closes it (a -> b -> a); sorted, so a report is stable */
export function findCycles(edges) {
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const components = [];
  const visit = (start) => {
    // iterative Tarjan: a generation has thousands of modules
    const work = [[start, 0]];
    indices.set(start, index); low.set(start, index); index++;
    stack.push(start); onStack.add(start);
    while (work.length > 0) {
      const frame = work[work.length - 1];
      const [node, i] = frame;
      const next = edges.get(node) ?? [];
      if (i < next.length) {
        frame[1]++;
        const to = next[i];
        if (!indices.has(to)) {
          indices.set(to, index); low.set(to, index); index++;
          stack.push(to); onStack.add(to);
          work.push([to, 0]);
        } else if (onStack.has(to)) {
          low.set(node, Math.min(low.get(node), indices.get(to)));
        }
        continue;
      }
      work.pop();
      if (work.length > 0) {
        const parent = work[work.length - 1][0];
        low.set(parent, Math.min(low.get(parent), low.get(node)));
      }
      if (low.get(node) === indices.get(node)) {
        const component = [];
        let member;
        do { member = stack.pop(); onStack.delete(member); component.push(member); } while (member !== node);
        const selfLoop = component.length === 1 && (edges.get(node) ?? []).includes(node);
        if (component.length > 1 || selfLoop) components.push(component);
      }
    }
  };
  for (const node of [...edges.keys()].sort()) if (!indices.has(node)) visit(node);
  return components.map((component) => closePath(component, edges)).sort((a, b) => a[0].localeCompare(b[0]));
}

// one concrete cycle through the component, from its smallest member
function closePath(component, edges) {
  const members = new Set(component);
  const start = [...component].sort()[0];
  const previous = new Map([[start, undefined]]);
  const queue = [start];
  while (queue.length > 0) {
    const node = queue.shift();
    for (const to of edges.get(node) ?? []) {
      if (!members.has(to)) continue;
      if (to === start) {
        const path = [start];
        for (let at = node; at !== start; at = previous.get(at)) path.splice(1, 0, at);
        return [...path, start];
      }
      if (!previous.has(to)) { previous.set(to, node); queue.push(to); }
    }
  }
  return [start, start];
}

// The parse runs in a child: vm.SourceTextModule is V8's module parser and
// needs a flag this process was not started with. Under a Bun binary there is
// no such parser; the syntax half says it was skipped rather than passing.
const PARSER = `
import {readFileSync} from "node:fs";
import {join} from "node:path";
import vm from "node:vm";
const [dir, ...modules] = JSON.parse(readFileSync(0, "utf8"));
const failed = [];
for (const module of modules) {
  try { new vm.SourceTextModule(readFileSync(join(dir, module), "utf8"), {identifier: module}); }
  catch (error) { failed.push({module, message: String(error && error.message || error)}); }
}
process.stdout.write(JSON.stringify(failed));
`;

export function syntaxErrors(dir, modules = modulesOf(dir), {execPath = process.execPath} = {}) {
  if (process.versions.bun !== undefined) return {skipped: "no V8 module parser in a Bun host", errors: []};
  if (modules.length === 0) return {errors: []};
  const r = spawnSync(execPath, ["--experimental-vm-modules", "--no-warnings", "--input-type=module", "-e", PARSER],
    {input: JSON.stringify([resolve(dir), ...modules]), encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`generation-check: the parser child failed (${r.status}): ${r.stderr.trim().split("\n").slice(-3).join(" ")}`);
  return {errors: JSON.parse(r.stdout)};
}

/** import the entry in a child node; exit 13 is an unsettled top-level await */
export function loadCheck(dir, {entry = "init.mjs", timeoutMs = 180000, env = process.env, execPath = process.execPath} = {}) {
  const file = join(dir, entry);
  if (!existsSync(file)) return {ok: false, reason: `no ${entry} in ${dir}`};
  const script = `await import(${JSON.stringify(pathToFileURL(resolve(file)).href)}); process.exit(0);`;
  const r = spawnSync(execPath, ["--input-type=module", "-e", script], {encoding: "utf8", env, timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024});
  if (r.error && r.error.code !== "ETIMEDOUT") throw r.error;
  const stderr = (r.stderr ?? "").trim();
  if (r.status === 0) return {ok: true};
  if (r.status === UNSETTLED_TLA) return {ok: false, code: r.status, reason: "unsettled top-level await (a cycle of awaited imports)", stderr};
  if (r.signal !== null || r.error?.code === "ETIMEDOUT") return {ok: false, signal: r.signal, reason: `did not load within ${timeoutMs} ms`, stderr};
  return {ok: false, code: r.status, reason: `the import failed (exit ${r.status})`, stderr};
}

export function readAllow(file = ALLOW_FILE) {
  if (!existsSync(file)) return [];
  const entries = JSON.parse(readFileSync(file, "utf8")).syntax ?? [];
  for (const entry of entries) {
    if (typeof entry.module !== "string" || typeof entry.reason !== "string" || entry.reason.trim() === "") {
      throw new Error(`${file}: every entry needs a module and a reason`);
    }
  }
  return entries;
}

/** the modules a start loads: the roots and what they await at the top
 *  level, transitively */
export function reachable(edges, roots) {
  const seen = new Set(roots);
  const queue = [...roots];
  while (queue.length > 0) {
    for (const to of edges.get(queue.shift()) ?? []) if (!seen.has(to)) { seen.add(to); queue.push(to); }
  }
  return seen;
}

// What a start imports: the runtime's init and the unit harness. A program
// is not among them -- it is imported when it is run -- so a program module
// that does not parse is a latent defect, said but not a refusal (the
// consumer pack carries three with the top-level RETURN of 2026-11-08). With
// neither root present every module counts.
export const ROOTS = ["init.mjs", "index.mjs"];

// The class-constructor wait-cycles the transpiler broke into a defined order (pin 4j,
// cctor_plan.ts): init.mjs carries them as one data line and says them at load. They load, so
// they are no failure -- but a reader of the build should know which pools run in an order ABAP
// would not use (ANORMALIES cctor-load-order).
const CCTOR_CYCLES = /^const __abapClassConstructorCycles = (\[.*\]);$/m;

export function constructorCycles(dir, entry = "init.mjs") {
  const file = join(dir, entry);
  if (!existsSync(file)) return [];
  const match = CCTOR_CYCLES.exec(readFileSync(file, "utf8"));
  return match === null ? [] : JSON.parse(match[1]);
}

export function checkGeneration(dir, {load = false, allow = readAllow(), entry = "init.mjs", timeoutMs, env, execPath} = {}) {
  const modules = modulesOf(dir);
  const syntax = syntaxErrors(dir, modules, {execPath});
  const edges = importEdges(dir, modules);
  const present = new Set(modules);
  const roots = ROOTS.filter((root) => present.has(root));
  const started = roots.length > 0 ? reachable(edges, roots) : present;
  const allowed = new Set(allow.map((a) => a.module));
  const errors = syntax.errors.filter((e) => !allowed.has(e.module) && started.has(e.module));
  const latent = syntax.errors.filter((e) => !allowed.has(e.module) && !started.has(e.module));
  const tolerated = syntax.errors.filter((e) => allowed.has(e.module));
  const stale = syntax.skipped ? [] : allow.filter((a) => present.has(a.module) && !syntax.errors.some((e) => e.module === a.module)).map((a) => a.module);
  const cycles = findCycles(edges);
  const loaded = load ? loadCheck(dir, {entry, timeoutMs, env, execPath}) : undefined;
  const ok = errors.length === 0 && cycles.length === 0 && (loaded === undefined || loaded.ok);
  return {ok, modules: modules.length, syntax: errors, latent, syntaxSkipped: syntax.skipped, tolerated, stale, cycles, load: loaded,
    cctorCycles: constructorCycles(dir, entry)};
}

export function describe(result) {
  const lines = [];
  for (const e of result.syntax) lines.push(`syntax: ${e.module}: ${e.message}`);
  for (const c of result.cycles) lines.push(`cycle of awaited imports: ${c.join(" -> ")}`);
  if (result.load && !result.load.ok) {
    lines.push(`load: ${result.load.reason}`);
    const warning = (result.load.stderr ?? "").split("\n").filter((l) => l.trim() !== "").slice(0, 4);
    for (const l of warning) lines.push(`  ${l}`);
  }
  return lines;
}

/** one line for a report: the first thing that stops the generation from
 *  loading -- a module that does not parse, a cycle, or the import's first
 *  error with the module and line it names; undefined when it loads */
export function firstLoadError(result) {
  if (result.ok === true) return undefined;
  const statics = describe({...result, load: undefined});
  if (statics.length > 0) return statics[0];
  const load = result.load ?? {};
  const lines = String(load.stderr ?? "").split("\n").map((l) => l.trim()).filter((l) => l !== "");
  const error = lines.find((l) => /^(?:[A-Za-z]*Error\b|Warning: Detected|not activated)/.test(l)) ?? lines[0];
  const at = lines.find((l) => /^file:\/\/.+:\d+$/.test(l));
  return [load.reason, error, at === undefined ? undefined : `at ${at.replace(/^.*\//, "")}`].filter((x) => x !== undefined).join(": ");
}

/** for a host about to import a generation, and for the build: throw rather
 *  than hang or serve half a system */
export function assertLoadable(dir, {log = () => {}, ...options} = {}) {
  const result = checkGeneration(dir, options);
  if (result.syntaxSkipped) log(`generation-check: syntax skipped (${result.syntaxSkipped})`);
  for (const t of result.tolerated) log(`generation-check: known not to parse (allow list): ${t.module}`);
  for (const l of result.latent) log(`generation-check: does not parse, not loaded at start (on demand only): ${l.module}: ${l.message}`);
  for (const c of result.cctorCycles) log(`generation-check: class constructors in a wait-cycle run in a defined order ABAP would not use: ${c.join(" <-> ")}`);
  for (const s of result.stale) log(`generation-check: stale allow entry, ${s} parses now`);
  if (!result.ok) {
    const error = new Error(`the generation cannot load:\n  ${describe(result).join("\n  ")}`);
    error.code = "GENERATION_UNLOADABLE";
    error.check = result;
    throw error;
  }
  return result;
}

if (runsAs("osd-generation-check.mjs")) {
  const args = process.argv.slice(2);
  const dir = args.find((a) => !a.startsWith("--")) ?? "output";
  const result = checkGeneration(dir, {load: !args.includes("--no-load")});
  if (args.includes("--json")) {
    // the closure's fixed point reads this (tools/hana-closure-merge.mjs loadCheckOf)
    console.log(JSON.stringify({ok: result.ok, modules: result.modules, cycles: result.cycles, syntax: result.syntax,
      latent: result.latent, loads: result.ok, load_error: firstLoadError(result), cctor_cycles: result.cctorCycles}));
    process.exit(result.ok ? 0 : 1);
  }
  for (const line of describe(result)) console.log(line);
  for (const t of result.tolerated) console.log(`known not to parse (allow list): ${t.module}`);
  for (const l of result.latent) console.log(`does not parse, not loaded at start: ${l.module}: ${l.message}`);
  for (const c of result.cctorCycles) console.log(`class constructors in a wait-cycle, defined order: ${c.join(" <-> ")}`);
  for (const s of result.stale) console.log(`stale allow entry: ${s} parses now`);
  if (result.syntaxSkipped) console.log(`syntax skipped: ${result.syntaxSkipped}`);
  const load = result.load === undefined ? "load not run" : result.load.ok ? "init.mjs loads" : "init.mjs does not load";
  console.log(`generation-check: ${result.modules} modules, ${result.syntax.length} not parsing, ${result.cycles.length} cycles, ${load}: ${result.ok ? "OK" : "FAILED"}`);
  process.exitCode = result.ok ? 0 : 1;
}
