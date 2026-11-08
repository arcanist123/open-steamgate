// Reads one corpus run (corpus-run.mjs) and decides it: the Go-compiled
// gogen's output against Node gogen's, byte for byte, per object, plus the
// reached-function count of the translated closure and the reached traps.
//
//   node tools/selfhost/corpus-report.mjs <out>
//
// Writes <out>/report.json and prints one line; exit 0 only when the whole
// output is byte-identical, the run exited cleanly and no trap was reached.
// The per-object table attributes each top-level Go declaration to the object
// whose Go name owns it (typeName of go-symbols.mjs); it explains a difference,
// it never replaces the whole-file comparison that decides.
import {existsSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {typeName} from "../gogen/go-symbols.mjs";

const sha = (b) => createHash("sha256").update(b).digest("hex");
const DECL = /^(?:func|type|var|const) /;

/** top-level declarations of generated Go: [{key, text}] in order; the preamble is key "" */
export function declarations(go) {
  const out = [];
  let cur = {key: "", lines: []};
  for (const line of go.split("\n")) {
    if (DECL.test(line)) {
      out.push(cur);
      cur = {key: declKey(line), lines: []};
    }
    cur.lines.push(line);
  }
  out.push(cur);
  return out.map((d) => ({key: d.key, text: d.lines.join("\n")}));
}

/** `func (me *X) M(` -> X.M, `func F(` -> F, `type T ...` -> T, `var v = ` -> v */
export function declKey(line) {
  const m = /^func \(\w+ \*?(\w+)\) (\w+)/.exec(line) ?? /^func (\w+)/.exec(line) ?? /^(?:type|var|const) \(?(\w+)/.exec(line);
  if (!m) return line.slice(0, 60);
  return m[2] ? `${m[1]}.${m[2]}` : m[1];
}

/** a function from a declaration key to its owning object (or "(program)") */
export function ownerOf(objects) {
  const names = [...new Set(objects.map((o) => typeName(o)))].sort((a, b) => b.length - a.length);
  const byName = new Map(objects.map((o) => [typeName(o), o.toUpperCase()]));
  return (key) => {
    const token = key.split(".")[0].replace(/^(?:statics_|slot_|I_|zero_|new_)/, "");
    for (const g of names) if (token === g || token.startsWith(`${g}_`) || token.startsWith(`${g}__`)) return byName.get(g);
    return "(program)";
  };
}

/**
 * Compare two outputs. Returns {equal, firstDifference, objects: {name:
 * status}, decls: {...}}. status: equal | diff | missing (in the reference,
 * not in the candidate) | extra (only in the candidate).
 */
export function compareOutputs(ref, out, objects) {
  const equal = ref.equals(out);
  let firstDifference = null;
  if (!equal) {
    let i = 0;
    while (i < ref.length && i < out.length && ref[i] === out[i]) i++;
    const before = ref.subarray(0, i).toString("utf8");
    firstDifference = {byte: i + 1, line: before.split("\n").length, ref: i < ref.length ? ref[i].toString(16) : "EOF", out: i < out.length ? out[i].toString(16) : "EOF"};
  }
  const owner = ownerOf(objects);
  const r = declarations(ref.toString("utf8")), o = declarations(out.toString("utf8"));
  // keys can repeat (init blocks, var _ = ...): pair them by occurrence
  const index = (list) => {
    const m = new Map(), seen = new Map();
    for (const d of list) { const n = (seen.get(d.key) ?? 0) + 1; seen.set(d.key, n); m.set(`${d.key}#${n}`, d.text); }
    return m;
  };
  const ri = index(r), oi = index(o);
  const status = new Map(), counts = {equal: 0, diff: 0, missing: 0, extra: 0};
  const mark = (obj, s) => {
    const prev = status.get(obj);
    const rank = {equal: 0, extra: 1, missing: 2, diff: 3};
    if (!prev || rank[s] > rank[prev]) status.set(obj, s);
  };
  const changed = [];
  for (const [k, text] of ri) {
    const s = !oi.has(k) ? "missing" : oi.get(k) === text ? "equal" : "diff";
    counts[s]++;
    mark(owner(k.replace(/#\d+$/, "")), s);
    if (s !== "equal" && changed.length < 50) changed.push({decl: k, status: s});
  }
  for (const k of oi.keys()) if (!ri.has(k)) { counts.extra++; mark(owner(k.replace(/#\d+$/, "")), "extra"); if (changed.length < 50) changed.push({decl: k, status: "extra"}); }
  // equal bytes decide; declaration pairing can only explain
  if (!equal && counts.diff + counts.missing + counts.extra === 0) changed.push({decl: "(ordering)", status: "diff"});
  return {equal, firstDifference, decls: counts, changed, objects: Object.fromEntries([...status].sort())};
}

/** executed / all function bodies of the translated closure (abapiti coverage-manifest reach.json) */
export function reachCount(reach) {
  const spans = reach?.spans ?? [];
  return {executed: spans.filter((s) => s.executed).length, bodies: spans.length};
}

/*
 * Reached traps by kind and by module (traps/reached-traps.tsv of abapiti's
 * --list-traps). The kind is the first pattern a row's messages match, in
 * this order; G = an OSG typing change removes it, A = abapiti lowering.
 */
const KINDS = [
  ["G untyped value (dynamic/void)", /on dynamic is not lowered|on void|<- dynamic|\/ dynamic|dynamic \/|array<dynamic>|collection key dynamic/],
  ["A recursive union / union ABI", /recursive union literal|union type is not lowered|unionref/],
  ["A regexp feature", /JavaScript regexp/],
  ["A namespace import / global object", /identifier \w+ is not a lowered local or module value/],
  ["A bigint arithmetic", /bigint/],
  ["A number/string builtin form", /toFixed|padEnd|repeat requires|parseInt/],
  ["A/G structural type mismatch", /classref|interfaceref|call argument type mismatch|assignment type mismatch/],
  ["G optional parameter / Array() / untyped arithmetic", /missing argument|KindIdentifier|non-numeric/],
];
export function classifyTraps(tsv) {
  const byKind = {}, byModule = {};
  for (const line of tsv.split("\n").slice(1).filter(Boolean)) {
    const [location, message] = line.split("\t");
    const kind = KINDS.find(([, re]) => re.test(message))?.[0] ?? "other";
    const module = location.replace(/:\d+:\d+$/, "");
    byKind[kind] = (byKind[kind] ?? 0) + 1;
    byModule[module] = (byModule[module] ?? 0) + 1;
  }
  const sorted = (o) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)));
  return {byKind: sorted(byKind), byModule: sorted(byModule)};
}

const readText = (p) => (existsSync(p) ? readFileSync(p, "utf8") : null);

export function decide(dir) {
  const full = join(dir, "full"), traps = join(dir, "traps");
  const manifest = JSON.parse(readFileSync(join(dir, "inputs", "manifest.json"), "utf8"));
  const timings = existsSync(join(dir, "timings.json")) ? JSON.parse(readFileSync(join(dir, "timings.json"), "utf8")) : {};
  const summary = readText(join(full, "summary.txt"))?.trim() ?? "full: not run";
  const trapLine = readText(join(traps, "summary.txt"))?.trim() ?? "step4-traps: not run";
  const reached = /^step4-traps: (\d+) reached \((\d+)\/(\d+) unknown\) (\d+) unreached/.exec(trapLine);
  const trapTsv = readText(join(traps, "reached-traps.tsv"));
  const trapClasses = trapTsv ? classifyTraps(trapTsv) : null;
  const reachPath = existsSync(join(full, "reach.json")) ? join(full, "reach.json") : join(traps, "reach.json");
  const reach = existsSync(reachPath) ? reachCount(JSON.parse(readFileSync(reachPath, "utf8"))) : null;
  const refPath = join(full, "ref.go"), outPath = join(full, "gogen.go");
  const run = /run=(.*?) cmp=/.exec(summary)?.[1] ?? "not-run";
  const objects = manifest.objects;
  let comparison = null;
  if (existsSync(refPath)) {
    const ref = readFileSync(refPath), out = existsSync(outPath) ? readFileSync(outPath) : Buffer.alloc(0);
    comparison = compareOutputs(ref, out, objects);
    comparison.refSha256 = sha(ref);
    comparison.outSha256 = sha(out);
    comparison.refBytes = ref.length;
  }
  // an object with no declaration of its own is decided by the whole file
  const perObject = {};
  for (const o of objects) perObject[o.toUpperCase()] = run !== "ok" ? "crash" : comparison?.objects[o.toUpperCase()] ?? (comparison?.equal ? "equal" : "unattributed");
  const tally = Object.values(perObject).reduce((n, s) => ((n[s] = (n[s] ?? 0) + 1), n), {});
  const pass = run === "ok" && comparison?.equal === true && (!reached || Number(reached[1]) === 0);
  const report = {
    pass, osgCommit: manifest.osgCommit, osgDirty: manifest.osgDirty, manifestSha256: manifest.manifestSha256, inputsSha256: manifest.inputsSha256,
    objects: objects.length, files: manifest.files.length, tally, run, summary, traps: trapLine,
    reachedTraps: reached ? Number(reached[1]) : null, unreachedTraps: reached ? Number(reached[4]) : null,
    trapClasses, firstRuntimeTrap: run.startsWith("trap") ? run : null,
    reachedFunctions: reach, comparison: comparison && {...comparison, objects: undefined}, timings, perObject,
  };
  writeFileSync(join(dir, "report.json"), JSON.stringify(report, null, 1) + "\n");
  const line = `selfhost-corpus: ${pass ? "PASS" : "FAIL"} objects=${objects.length} equal=${tally.equal ?? 0} diff=${(tally.diff ?? 0) + (tally.missing ?? 0) + (tally.extra ?? 0) + (tally.unattributed ?? 0)} crash=${tally.crash ?? 0}`
    + ` bytes=${comparison ? (comparison.equal ? "equal" : `differ@${comparison.firstDifference.line}:${comparison.firstDifference.byte}`) : "none"}`
    + ` reached-functions=${reach ? `${reach.executed}/${reach.bodies}` : "?"} traps=${reached ? `${reached[1]} reached ${reached[4]} unreached` : "?"}`
    + ` ref=${comparison?.refSha256.slice(0, 16) ?? "none"} out=${comparison?.outSha256.slice(0, 16) ?? "none"}`;
  return {report, line};
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: corpus-report.mjs <out>"); process.exit(2); }
  const {report, line} = decide(dir);
  writeFileSync(join(dir, "summary.txt"), line + "\n");
  console.log(line);
  process.exit(report.pass ? 0 : 1);
}
