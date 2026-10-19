// Host-only isolated checks. Each variant has its own process, so compiler
// globals and a second registry cannot retain the previous variant's heap.
import {spawnSync} from "node:child_process";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {abaplint} from "./frontend-base.mjs";
import {compileProgram} from "./frontend.mjs";
import {selectionDiagnostics} from "./frontend-selection.mjs";
import {recordLowering} from "./frontend-replay.mjs";
import {parseObserved, cdsInputIdentity, cdsInputDigest, setCdsInputs, prepareCdsRegistry} from "./frontend-inventory.mjs";
import {prepareSession, finishSession} from "./frontend-session.mjs";
import {cacheDiagnostic} from "./frontend-cache-diagnostics.mjs";

function sameFiles(reg, expected) {
  const actual = [...reg.getObjects()].flatMap(o => o.getFiles().map(f => ({name: f.getFilename(), raw: f.getRaw(), dependency: reg.isDependency(o)})));
  return actual.length === expected.length && actual.every((f, i) => f.name === expected[i].name && f.raw === expected[i].raw && f.dependency === expected[i].dependency);
}
export function equivalentMethodDiscovery(reg, previous, current, rounds, includeTests, changedNames) {
  const started = performance.now();
  try {
    const wanted = new Set(changedNames);
    const changes = current.files.flatMap((row, i) => {
      if (!wanted.has(row.name)) return [];
      const evidence = JSON.parse(previous.files[i].evidence);
      if (typeof evidence[3] !== "string") throw new Error("missing-old-source");
      return [{name: row.name, owner: row.owner.slice(5), key: row.owner, before: evidence[3]}];
    });
    if (!changes.length || changes.length !== wanted.size) throw new Error("incomplete-changed-owners");
    const changedOwners = new Set(changes.map(c => c.key)), owners = new Map(current.files.map(f => [f.name, f.owner]));
    // Method-only candidates bind every declaration and all other files.
    // Their unchanged owners keep the authoritative loaded-registry issues;
    // the parser's ordinary rule runner rechecks every changed owner below.
    const issues = [];
    for (const issue of reg.findIssues()) {
      const owner = owners.get(issue.getFilename());
      if (!owner) throw new Error("unowned-diagnostic");
      if (changedOwners.has(owner)) continue;
      issues.push({filename: issue.getFilename(), message: issue.getMessage(), key: issue.getKey(), severity: issue.getSeverity(),
        start: [issue.getStart().getRow(), issue.getStart().getCol()], end: [issue.getEnd().getRow(), issue.getEnd().getCol()]});
    }
    const files = current.files.map(f => ({name: f.name, raw: f.value.raw, dependency: f.dependency}));
    const config = reg.getConfig().get();
    if (JSON.stringify(config) !== current.config || cdsInputDigest(reg) !== current.cds || !sameFiles(reg, files)) throw new Error("changed-loaded-scope");
    const cds = cdsInputIdentity(reg).ordered.map(([filename, source]) => ({filename, source}));
    const payload = JSON.stringify({config, files, changes, rounds, issues, cds, includeTests: includeTests instanceof Set ? [...includeTests] : includeTests});
    const captures = [];
    for (const variant of ["before", "after"]) {
      const result = spawnSync(process.execPath, ["--preserve-symlinks", fileURLToPath(import.meta.url), "--probe", variant], {
        input: payload, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
      });
      if (result.status !== 0) throw new Error("probe-child-failed");
      const capture = JSON.parse(result.stdout);
      if (!Array.isArray(capture.references) || !capture.references.every(r => typeof r === "string")) throw new Error(capture.error ?? "incomplete-probe");
      captures.push(capture);
    }
    const equivalent = JSON.stringify(captures[0].references) === JSON.stringify(captures[1].references);
    cacheDiagnostic({event: "method-discovery", equivalent, ms: Math.round(performance.now() - started), variants: captures.map(c => c.phases)});
    return equivalent;
  } catch (error) {
    cacheDiagnostic({event: "method-discovery", equivalent: false, ms: Math.round(performance.now() - started), reason: error.message});
    return false;
  }
}

function methodBodies(raw, name) {
  const reg = new abaplint.Registry(); reg.addFile(new abaplint.MemoryFile(name, raw)); reg.parse();
  const methods = new Map(); let implementation, method, body;
  for (const s of [...reg.getObjects()].flatMap(o => o.getABAPFiles().flatMap(f => f.getStatements()))) {
    if (s.get() instanceof abaplint.Statements.ClassImplementation) implementation = s.findFirstExpression(abaplint.Expressions.ClassName).concatTokens().toUpperCase();
    if (s.get() instanceof abaplint.Statements.MethodImplementation) { method = s.findFirstExpression(abaplint.Expressions.MethodName).concatTokens().toUpperCase(); body = []; }
    else if (s.get() instanceof abaplint.Statements.EndMethod) { methods.set(`${implementation}=>${method}`, JSON.stringify(body)); method = undefined; }
    else if (method) body.push(s.getTokens().map(t => t.getStr()));
  }
  return methods;
}
function completeMethod(method) {
  const pending = [method.body], seen = new Set();
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object" || seen.has(value)) continue;
    if (value.s === "stub") return false;
    seen.add(value); pending.push(...Object.values(value));
  }
  return true;
}
function observe(input, before) {
  const started = performance.now(), reg = new abaplint.Registry(new abaplint.Config(JSON.stringify(input.config)));
  const files = input.files.map(f => ({...f, raw: before ? input.changes.find(c => c.name === f.name)?.before ?? f.raw : f.raw}));
  for (const f of files) {
    const file = new abaplint.MemoryFile(f.name, f.raw);
    if (f.dependency) reg.addDependency(file); else reg.addFile(file);
  }
  const parseStarted = performance.now(); parseObserved(reg); const parseMs = performance.now() - parseStarted;
  setCdsInputs(reg, input.cds); prepareCdsRegistry(reg, input.cds, false, new WeakMap());
  const syntaxStarted = performance.now();
  if (!Array.isArray(input.issues)) throw new Error("missing-authoritative-diagnostics");
  const issues = input.issues.map(i => new abaplint.Issue({...i, start: new abaplint.Position(...i.start), end: new abaplint.Position(...i.end)}));
  const owners = new Set(input.changes.map(c => c.owner));
  for (const owner of owners) {
    const obj = reg.getObject("CLAS", owner);
    if (!obj) throw new Error("missing-changed-owner");
    issues.push(...reg.findIssuesObject(obj));
  }
  const session = {}; prepareSession(session, reg); session.cdsInputs = cdsInputIdentity(reg); session.issues = issues;
  if (selectionDiagnostics(reg, [...owners], session).length) throw new Error("changed-owner-syntax");
  if (!sameFiles(reg, files)) throw new Error("changed-probe-scope");
  const syntaxMs = performance.now() - syntaxStarted, roundsStarted = performance.now();
  const references = [], supported = new Map(), closureContext = {round: 1};
  for (const [roundIndex, round] of input.rounds.entries()) {
    closureContext.round = roundIndex + 1;
    if (![round.wanted, round.diagnostics, round.broken, round.expanded].every(Array.isArray)) throw new Error("missing-proven-selection");
    const selection = {wanted: [...round.wanted], diagnostics: round.diagnostics, broken: new Set(round.broken)};
    Object.freeze(selection.wanted);
    const program = compileProgram({folders: [], registry: reg, objects: round.inputs, tolerant: true, session, closureContext,
      includeTests: Array.isArray(input.includeTests) ? new Set(input.includeTests) : input.includeTests,
      discoveryProbe: {owners, selection, cds: input.cds, compile(ctx, obj, lower) {
        const recorded = recordLowering(ctx.program, tracked => lower({...ctx, program: tracked}, obj));
        if (!recorded.replay) throw new Error(`unclassified-lowering-observation:${recorded.refusal}`);
        const owner = obj.getName().toUpperCase();
        supported.set(owner, new Set([...recorded.ir.methods, ...(recorded.ir.constructor ? [recorded.ir.constructor] : [])].filter(completeMethod).map(m => m.name.toUpperCase())));
        const signatures = new Set();
        for (const op of recorded.replay.ops) {
          if (op.key === "sigs") {
            if (typeof op.args?.[0] !== "string") throw new Error("unclassified-signature-observation");
            signatures.add(op.args[0]);
          } else if (["wanted", "missing", "caught", "supplied", "functionModules", "dynStatics", "interfaces"].includes(op.key))
            references.push(JSON.stringify([roundIndex, owner, op.key, op.kind, op.method, op.args, op.kind === "read" ? op.value : null]));
        }
        // Cache hits depend on duplicate calls, while discovery depends on the
        // queried slot and its availability. Compare the latter, not memoization.
        for (const key of signatures) {
          const signature = ctx.program.sigs.get(key);
          const status = signature == null ? "missing" : "params" in signature ? "typed" : "unsupported" in signature ? "unsupported" : undefined;
          if (!status) throw new Error("unclassified-signature-status");
          references.push(JSON.stringify([roundIndex, owner, "signature", key, status]));
        }
        return recorded.ir;
      }}});
    if (program.reg !== reg || !sameFiles(reg, files)) throw new Error("changed-probe-scope");
    if (JSON.stringify([...program.wanted]) !== JSON.stringify(round.expanded)) throw new Error("changed-probe-selection");
    finishSession(session, reg);
    if (program.broken.some(n => owners.has(n.toUpperCase()))) throw new Error("syntax-failure");
    if (round !== input.rounds.at(-1)) continue;
    for (const change of input.changes) {
      if (!program.wanted.has(change.owner)) continue;
      const old = methodBodies(change.before, change.name), now = methodBodies(files.find(f => f.name === change.name).raw, change.name);
      for (const [key, body] of now) if (old.get(key) !== body) {
        const [implementation, name] = key.split("=>");
        const owner = implementation === change.owner ? change.owner : `${change.owner}:${implementation}`;
        if (!supported.get(owner)?.has(name)) throw new Error("changed-method-refused");
      }
    }
  }
  // Preserve first-discovery order and repeated positions: closure consumes
  // missing dependencies in insertion order, so a reordered sequence must fail.
  return {references, phases: {parseMs: Math.round(parseMs), syntaxMs: Math.round(syntaxMs),
    roundsMs: Math.round(performance.now() - roundsStarted), totalMs: Math.round(performance.now() - started)}};
}
if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv[2] === "--probe") {
  try {
    if (!["before", "after"].includes(process.argv[3])) throw new Error("unknown-probe-variant");
    console.log(JSON.stringify(observe(JSON.parse(readFileSync(0, "utf8")), process.argv[3] === "before")));
  } catch (error) { console.log(JSON.stringify({error: error.message})); }
}
