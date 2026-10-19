// Real runner, copied inputs, serial memory-capped builds and artifact hashes.
import assert from "node:assert/strict";
import {abaplint} from "./frontend-base.mjs";
import {discoveryEvidence, matchingDiscoveryEvidence} from "./runner-selection-evidence.mjs";
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync, openSync, closeSync} from "node:fs";
import {join, resolve} from "node:path";
const [source, destination, inputDestination, ...flags] = process.argv.slice(2);
let baseline;
for (let i = 0; i < flags.length; i++) {
  if (flags[i] === "--baseline" && flags[i + 1]) baseline = resolve(flags[++i]);
  else if (flags[i] !== "--build") throw new Error(`unknown proof flag: ${flags[i]}`);
}
if (!source || !destination || !inputDestination)
  throw new Error("usage: cache-runner-proof.mjs <zlnt-system> <fresh-evidence-dir> <fresh-input-copy> [--build] [--baseline <source-copy>]");
const work = resolve(destination), input = resolve(inputDestination), buildBinary = flags.includes("--build");
for (const folder of [work, input]) {
  if (existsSync(folder)) throw new Error(`${folder} must be fresh`);
  mkdirSync(folder, {recursive: true});
}
const cache = join(work, "frontend");
for (const folder of ["libs/zlnt-core/src", "inputs/zlnt-tests-statements/src", "inputs/zlnt-tests-base/src"])
  cpSync(join(resolve(source), folder), join(input, folder), {recursive: true, dereference: true});
const report = join(input, "inputs/zlnt-tests-base/src/zlnt_tests_run.prog.abap");
const libs = ["libs/zlnt-core/src", "inputs/zlnt-tests-statements/src"].flatMap((folder) => ["--lib", join(input, folder)]);
const results = {buildBinary, baseline, rows: [], comparisons: []};
const artifactFolders = new WeakMap(), capturedSelections = new WeakMap();
const save = () => writeFileSync(join(work, "report.json"), JSON.stringify(results, null, 2) + "\n");
const logicPlan = realisticEdit(); // Fail before expensive builds if no eligible edit exists.
function capture(label, enabled, cwd = process.cwd()) {
  const build = join(work, `.build-${label}`), diagnostics = join(work, `${label}.ndjson`);
  const env = {...process.env, NODE_OPTIONS: "--max-old-space-size=24576", OSABAP_BUILD_ROOT: build,
    OSABAP_TIMING: "1", OSABAP_EMIT_ONLY: buildBinary ? "" : "1", OSD_GOGEN_CACHE: enabled ? cache : "",
    GOGEN_CACHE_DIAGNOSTICS: diagnostics, OSG_HOME: cwd};
  if (cwd === baseline && enabled) env.OSD_GOGEN_CACHE = join(work, "baseline-frontend");
  const start = performance.now(), log = join(work, `${label}.log`), fd = openSync(log, "w");
  let child;
  try {
    child = spawnSync("systemd-run", ["--user", "--scope", "-q", "-p", "MemoryMax=70G", "-p", "MemorySwapMax=0",
      process.execPath, "--preserve-symlinks", "tools/gogen/osabap.mjs", report, ...libs], {cwd, env, stdio: ["ignore", fd, fd]});
  } finally { closeSync(fd); }
  if (child.status !== 0) {
    results.failure = {label, status: child.status, signal: child.signal, error: child.error?.message,
      elapsedMs: Math.round(performance.now() - start), log}; save();
    throw new Error(`${label}: build failed: ${log}`);
  }
  const phases = {}, phaseRounds = [];
  let counts, closureRounds, selectionEvidence, selection;
  for (const line of readFileSync(log, "utf8").split("\n")) if (line.startsWith("OSABAP_TIMING ")) {
    const row = JSON.parse(line.slice("OSABAP_TIMING ".length));
    if (row.round > 0) { phaseRounds.push(row); phases[row.phase] = (phases[row.phase] ?? 0) + row.ms; }
    else phases[row.phase] = row.ms;
    if (row.phase === "frontend") {
      counts = {lowered: row.lowered, reused: row.reused};
      closureRounds = row.closureRounds; selectionEvidence = row.selectionEvidence; selection = row.selection;
    }
  }
  for (const name of ["frontend", "emit", "goBuild", "total"]) assert.ok(Number.isFinite(phases[name]), `missing ${name}`);
  if (cwd !== baseline) assert.ok(Array.isArray(selection) && selection.every(n => typeof n === "string"), "missing ordered selection");
  const generated = join(build, "go/cmd/osabap");
  const hashes = Object.fromEntries(readdirSync(generated).filter((name) => name.startsWith("zz_") || name === "symbols.json").sort()
    .map((name) => [name, createHash("sha256").update(readFileSync(join(generated, name))).digest("hex")]));
  for (const name of ["zz_app.go", "zz_generated.go", "zz_db.json", "symbols.json"]) assert.ok(hashes[name], `missing ${name}`);
  const reasons = {}, loweredClasses = [], roundCounts = new Map(), allClasses = new Set(), invalidation = [], recordingScopes = [], methodDiscovery = [];
  if (existsSync(diagnostics)) for (const line of readFileSync(diagnostics, "utf8").split("\n")) if (line) {
    const row = JSON.parse(line);
    if (row.event === "method-discovery") methodDiscovery.push(row);
    if (row.event === "certificate-validation") invalidation.push(row);
    if (row.event === "recording-scope") recordingScopes.push(row);
    if (row.event === "class") {
      if (!roundCounts.has(row.round)) roundCounts.set(row.round, {round: row.round, lowered: 0, reused: 0});
      const round = roundCounts.get(row.round);
      allClasses.add(row.name); round[row.hit ? "reused" : "lowered"]++;
      if (!row.hit) {
        const reason = [row.reason, row.key, row.method].filter(Boolean).join(":");
        reasons[reason] = (reasons[reason] ?? 0) + 1; loweredClasses.push(row.name);
      }
    }
  }
  const rounds = [...roundCounts.values()];
  if (enabled) assert.equal(allClasses.size, counts.lowered + counts.reused, "diagnostics must cover the final class universe");
  results.rows.push({label, enabled, closureRounds, selectionEvidence, selection, phases, phaseRounds, invalidation, recordingScopes, methodDiscovery, counts, reasons, loweredClasses, rounds,
    uniqueClasses: allClasses.size || counts.lowered + counts.reused,
    uniqueLowered: enabled ? [...new Set(loweredClasses)].sort() : undefined,
    manifestHash: createHash("sha256").update(JSON.stringify(hashes)).digest("hex"),
    wallMs: Math.round(performance.now() - start), hashes});
  save(); console.error(JSON.stringify(results.rows.at(-1)));
  artifactFolders.set(hashes, generated); capturedSelections.set(hashes, selection);
  return hashes;
}
function equal(left, right, label) {
  assert.deepEqual(right, left, `${label}: generated artifacts differ`);
  for (const name of ["zz_app.go", "zz_generated.go", "zz_db.json", "symbols.json"])
    assert.deepEqual(readFileSync(join(artifactFolders.get(right), name)), readFileSync(join(artifactFolders.get(left), name)), `${label}: ${name} bytes`);
  const a = capturedSelections.get(left), b = capturedSelections.get(right);
  // Every comparison must carry an ordered selection: the runner emits it only
  // under OSABAP_TIMING=1, and without this assert that guarantee can be lost
  // silently (GLM review note 2026-10-20).
  assert.ok(a && b, `${label}: ordered selection missing (run the proof with OSABAP_TIMING=1)`);
  assert.deepEqual(b, a, `${label}: ordered selections differ`);
  results.comparisons.push({label, equal: true, selectionEqual: true, byteFiles: 4}); save();
}
const recorded = capture("cold-enabled", true);
if (baseline) {
  const prime = capture("baseline-cold-enabled", true, baseline);
  equal(prime, capture("baseline-warm-enabled", true, baseline), "baseline warm = recorded");
}
equal(recorded, capture("warm-enabled", true), "unchanged warm = recorded");
const cold = capture("cold-disabled", false);
equal(cold, recorded, "cold enabled = disabled");
equal(cold, capture("warm-disabled", false), "disabled control = cold");
const file = join(input, "inputs/zlnt-tests-statements/src/zcl_lnt_add_module.clas.abap");
const before = readFileSync(file, "utf8"), after = before.replace("|add 2 to lv_foo.|", "|add 3 to lv_foo.|");
assert.notEqual(after, before); writeFileSync(file, after);
results.edit = {file: "zcl_lnt_add_module.clas.abap", before: "|add 2 to lv_foo.|", after: "|add 3 to lv_foo.|"}; save();
const editedWarm = capture("edited-enabled", true), editedCold = capture("edited-disabled", false);
equal(editedCold, editedWarm, "edited warm = edited cold");
assert.notDeepEqual(editedCold, cold, "edit must change generated artifacts");
const warm = results.rows.find((r) => r.label === "warm-enabled"), disabled = results.rows.find((r) => r.label === "warm-disabled");
results.reuseRatio = 1 - warm.uniqueLowered.length / warm.uniqueClasses;
results.finalRoundReuseRatio = warm.counts.reused / (warm.counts.reused + warm.counts.lowered);
results.minimumRoundReuseRatio = Math.min(...warm.rounds.map((r) => r.reused / (r.reused + r.lowered)));
results.reuseBudgetMet = results.reuseRatio >= 0.99 && results.minimumRoundReuseRatio >= 0.99;
results.editedNewlyLowered = results.rows.find((r) => r.label === "edited-enabled").uniqueLowered.filter((n) => !warm.uniqueLowered.includes(n));
results.unchangedWarmRatio = warm.phases.total / disabled.phases.total;
const edited = results.rows.find((r) => r.label === "edited-enabled"), editedDisabled = results.rows.find((r) => r.label === "edited-disabled");
results.editedBudgetMet = edited.phases.total < editedDisabled.phases.total;
results.editedPlanningBudgetMet = edited.phases.total <= 450000;
const baselineWarm = results.rows.find((r) => r.label === "baseline-warm-enabled");
if (baselineWarm) {
  results.unchangedWarmBaselineRatio = warm.phases.total / baselineWarm.phases.total;
  results.unchangedBaselineBudgetMet = warm.phases.total <= baselineWarm.phases.total;
}
save();

// Change a real condition in a method of an existing mid-size test class.
// Token positions come from the parser; only the fresh input copy is edited.
function realisticEdit() {
  const folder = join(input, "inputs/zlnt-tests-statements/src");
  for (const name of readdirSync(folder).sort()) {
    if (!name.endsWith(".clas.abap") || name === "zcl_lnt_add_module.clas.abap") continue;
    const file = join(folder, name), before = readFileSync(file, "utf8"), lines = before.split("\n");
    if (lines.length < 80 || lines.length > 800) continue;
    const reg = new abaplint.Registry(); reg.addFile(new abaplint.MemoryFile(name, before)); reg.parse();
    const statements = [...reg.getObjects()].flatMap(o => o.getABAPFiles().flatMap(f => f.getStatements()));
    let method;
    for (const statement of statements) {
      if (statement.get() instanceof abaplint.Statements.MethodImplementation) method = statement.concatTokens();
      if (statement.get() instanceof abaplint.Statements.EndMethod) method = undefined;
      if (!method?.startsWith("METHOD test_initialize_") || !(statement.get() instanceof abaplint.Statements.If)) continue;
      const token = statement.getTokens().find(t => t.getStr() === "=");
      if (!token) continue;
      const start = token.getStart(), offset = lines.slice(0, start.getRow() - 1).reduce((n, line) => n + line.length + 1, 0) + start.getCol() - 1;
      assert.equal(before.slice(offset, offset + 1), "=");
      const after = before.slice(0, offset) + "<>" + before.slice(offset + 1);
      if (matchingDiscoveryEvidence(discoveryEvidence(name, before), discoveryEvidence(name, after)) !== "method-discovery-candidate") continue;
      return {apply: () => writeFileSync(file, after), file: name, lines: lines.length, method, statement: statement.concatTokens(), before: "=", after: "<>"};
    }
  }
  throw new Error("no reference-preserving condition in a mid-size test class");
}
logicPlan.apply(); results.realisticEdit = logicPlan; save();
const realistic = capture("realistic-enabled", true), realisticCold = capture("realistic-disabled", false);
equal(realisticCold, realistic, "realistic edit enabled = independent roots disabled");
assert.notDeepEqual(realisticCold, editedCold, "realistic edit must change generated artifacts");
const realisticOn = results.rows.find(r => r.label === "realistic-enabled"), realisticOff = results.rows.find(r => r.label === "realistic-disabled");
results.realisticBudgetMet = realisticOn.closureRounds === 1 && realisticOn.phases.total < realisticOff.phases.total;
save();
assert.equal(realisticOn.selectionEvidence, "method-discovery-references", "realistic edit must exercise the general proof");
assert.equal(realisticOn.closureRounds, 1, "realistic edit must use the certified one-round path");
assert.ok(results.realisticBudgetMet, "realistic edit must beat cache-off");
