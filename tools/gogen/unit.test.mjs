import {test} from "node:test";
import assert from "node:assert/strict";
import {spawn, spawnSync} from "node:child_process";
import {chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {fileURLToPath} from "node:url";
import {dirname, join} from "node:path";
import {reconcile} from "./unit-results.mjs";
import {runUnit} from "./unit-process.mjs";
import {compileProgram, columnRegistry} from "./frontend.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const staticsArgs = [join(here, "unit.mjs"), "--fixture", "test/fixtures/unit-statics", "--class", "ZCL_OSD_STATICS_TEST", "--jobs", "2"];
const unitRun = (argv, env = {}) => new Promise((resolveRun) => {
  const child = spawn("node", argv, {cwd: root, env: {...process.env, ...env}});
  let stdout = "", stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.on("close", (status) => resolveRun({status, stdout, stderr, result: stdout ? JSON.parse(stdout) : null}));
});
test("UTF-16 lengths, sections and surrogate halves run through ABAP Unit", {timeout: 120000}, async () => {
  const run = await unitRun([join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-utf16"), "--no-cache"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.result.classes, 1);
  assert.equal(run.result.compiled, 1);
  assert.equal(run.result.rows.length, 28);
  assert.ok(run.result.rows.every((row) => row.status === "SUCCESS"), run.stdout);
});
test("a reused frontend registry keeps CDS to SQL view names", () => {
  const args = {folders: [join(here, "testdata")], objects: []};
  const first = compileProgram(args);
  const reused = compileProgram({...args, registry: first.reg});
  const expected = {ZGOGEN_T_DBWC: "ZGOGEN_T_DBWV"};
  assert.deepEqual(first.cdsViews, expected);
  assert.deepEqual(reused.cdsViews, expected);
  assert.deepEqual(columnRegistry(reused).cdsViews, expected);
  assert.equal(reused.tables.find((table) => table.name === "ZGOGEN_T_DBWC")?.sqlView, "ZGOGEN_T_DBWV");
});

test("a missing method fails the run", () => {
  const expected = [{class: "OWNER", testclass: "LOCAL", method: "ONE", status: "READY", message: ""},
    {class: "OWNER", testclass: "LOCAL", method: "TWO", status: "READY", message: ""}];
  const rows = reconcile(expected, [{...expected[0], status: "SUCCESS"}]);
  assert.deepEqual(rows.map((r) => r.status), ["SUCCESS", "FAILED"]);
  assert.match(rows[1].message, /dropped this method/);
});

test("comparison fails for each selected owner without a runnable method and for zero SAME rows", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-compare-"));
  const row = (owner, status, message = "") => ({class: owner, testclass: "LTCL_TEST", method: "TEST", status, message});
  const compare = (nodeRows, goRows, owners) => {
    writeFileSync(join(dir, "node.json"), JSON.stringify(nodeRows));
    writeFileSync(join(dir, "go.json"), JSON.stringify({rows: goRows}));
    const run = spawnSync("node", [join(here, "unit-compare.mjs"), "--node-json", join(dir, "node.json"),
      "--go-json", join(dir, "go.json"), ...owners.flatMap((owner) => ["--class", owner])],
    {encoding: "utf8", timeout: 10000});
    assert.equal(run.error, undefined, run.stderr);
    return {status: run.status, summary: JSON.parse(run.stdout)};
  };
  try {
    for (const [label, goRows] of [
      ["all skipped", [row("OWNER", "SKIPPED")]],
      ["absent rows", []],
      ["not compiled", [row("OWNER", "NOT_COMPILED", "compile error")]],
      ["reached tolerant stub", [row("OWNER", "FAILED", "NOT_COMPILED in OWNER=>TEST: unsupported")]],
      ["needs db", [row("OWNER", "NEEDS_DB", "database unavailable")]],
    ]) {
      const result = compare([row("OWNER", "SUCCESS")], goRows, ["OWNER"]);
      assert.equal(result.status, 1, label);
      assert.deepEqual(result.summary.classes.compiled, [], label);
      assert.equal(result.summary.classes.notCompiled.length, 1, label);
    }
    const noSame = compare([row("OWNER", "SUCCESS")], [row("OWNER", "FAILED")], ["OWNER"]);
    assert.equal(noSame.status, 1);
    assert.equal(noSame.summary.methods.same.length, 0);
    const stub = row("OWNER", "FAILED", "NOT_COMPILED in OWNER=>TEST: unsupported");
    const matchingStub = compare([stub], [stub], ["OWNER"]);
    assert.equal(matchingStub.status, 1);
    assert.equal(matchingStub.summary.methods.same.length, 0);
    assert.equal(matchingStub.summary.methods.nodeOnly.length, 1);
    const mixed = compare([row("GOOD", "SUCCESS"), row("EMPTY", "SUCCESS")], [row("GOOD", "SUCCESS")], ["GOOD", "EMPTY"]);
    assert.equal(mixed.status, 1);
    assert.deepEqual(mixed.summary.methods.same, ["GOOD/LTCL_TEST/TEST"]);
    assert.deepEqual(mixed.summary.classes.notCompiled.map((r) => r.class), ["EMPTY"]);
    assert.equal(compare([row("OWNER", "SUCCESS")], [row("OWNER", "SUCCESS")], ["OWNER"]).status, 0);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a different assertion in a known anomaly method remains DIFFERENT", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-anomaly-compare-"));
  const key = {class: "ZCL_STG_GATEWAY_TEST", testclass: "LTCL_DISPATCH", method: "ENTITY_SET"};
  const node = {...key, status: "SUCCESS", message: ""};
  const reviewed = {...key, status: "FAILED", message: "Expected abap_true at zcl_stg_gateway_test.clas.testclasses.abap:383"};
  const unrelated = {...reviewed, message: "Expected abap_true at zcl_stg_gateway_test.clas.testclasses.abap:380"};
  try {
    writeFileSync(join(dir, "node.json"), JSON.stringify([node]));
    for (const [go, expected] of [[reviewed, "nodeAnomaly"], [unrelated, "different"]]) {
      writeFileSync(join(dir, "go.json"), JSON.stringify({rows: [go]}));
      const run = spawnSync("node", [join(here, "unit-compare.mjs"), "--node-json", join(dir, "node.json"),
        "--go-json", join(dir, "go.json")], {encoding: "utf8", timeout: 10000});
      assert.equal(run.error, undefined, run.stderr);
      const methods = JSON.parse(run.stdout).methods;
      assert.deepEqual(methods.nodeAnomaly.map((row) => row.key), expected === "nodeAnomaly" ? ["ZCL_STG_GATEWAY_TEST/LTCL_DISPATCH/ENTITY_SET"] : []);
      assert.deepEqual(methods.different.map((row) => row.key), expected === "different" ? ["ZCL_STG_GATEWAY_TEST/LTCL_DISPATCH/ENTITY_SET"] : []);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("ABAP Unit class statics and constructor restart for each Go test class", {timeout: 120000}, () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-shards-"));
  const argv = [join(here, "unit.mjs"), "--fixture", "test/fixtures/unit-statics", "--class", "ZCL_OSD_STATICS_TEST", "--out", dir];
  const run = spawnSync("node", [...argv, "--jobs", "1"], {
    cwd: join(here, "..", ".."), encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message || run.stdout);
  const rows = JSON.parse(run.stdout).rows;
  assert.deepEqual(rows.map(({testclass, method, status}) => [testclass, method, status]), [
    ["LTC_A", "M1_FIRST", "SUCCESS"], ["LTC_A", "M2_SECOND", "SUCCESS"],
    ["LTC_B", "M1_FIRST", "SUCCESS"], ["LTC_B", "M2_SECOND", "SUCCESS"],
  ]);
  const sharded = spawnSync("node", [...argv, "--jobs", "2"], {
    cwd: join(here, "..", ".."), encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
  });
  assert.equal(sharded.status, 0, sharded.stderr || sharded.error?.message || sharded.stdout);
  assert.deepEqual(JSON.parse(sharded.stdout).rows, rows);
  const buildDir = JSON.parse(sharded.stdout).buildDir;
  assert.ok(existsSync(join(buildDir, "cmd", "unit", "zz_generated.go")));
  assert.equal(existsSync(join(dirname(buildDir), "shards")), false);
  rmSync(dir, {recursive: true, force: true});
});

test("overlapping unit runs isolate generated Go and shard files, even with one output directory", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-overlap-"));
  try {
    for (const shared of [false, true]) {
      const outA = join(dir, shared ? "shared" : "a");
      const outB = join(dir, shared ? "shared" : "b");
      const [a, b] = await Promise.all([unitRun([...staticsArgs, "--out", outA]), unitRun([...staticsArgs, "--out", outB])]);
      for (const run of [a, b]) {
        assert.equal(run.status, 0, run.stderr || run.stdout);
        assert.deepEqual(run.result.rows.map((row) => row.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
        assert.equal(existsSync(join(dirname(run.result.buildDir), "shards")), false);
      }
      assert.notEqual(a.result.buildDir, b.result.buildDir);
      assert.ok(existsSync(join(a.result.buildDir, "cmd", "unit", "zz_generated.go")));
      assert.ok(existsSync(join(b.result.buildDir, "cmd", "unit", "zz_generated.go")));
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("overlapping runs merge distinct class timings in one output directory", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-timings-"));
  try {
    const [a, b] = await Promise.all([
      unitRun([...staticsArgs, "--out", dir]),
      unitRun([join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit"), "--jobs", "2", "--out", dir]),
    ]);
    assert.equal(a.status, 0, a.stderr || a.stdout);
    assert.equal(b.status, 1, b.stderr || b.stdout);
    const timings = JSON.parse(readFileSync(join(dir, "class-timings.json"), "utf8"));
    assert.ok(Object.keys(timings).some((key) => key.includes("ZCL_OSD_STATICS_TEST")), JSON.stringify(timings));
    assert.ok(Object.keys(timings).some((key) => key.includes("ZCL_GOGEN_UNIT_FIXTURE")), JSON.stringify(timings));
    assert.equal(existsSync(join(dir, "class-timings.json.lock")), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a stale timing lock with a dead owner is recovered", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-stale-lock-"));
  const lock = join(dir, "class-timings.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), "999999999\n");
  try {
    const run = await unitRun([...staticsArgs, "--out", dir]);
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(run.result.rows.map((row) => row.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
    assert.ok(Object.keys(JSON.parse(readFileSync(join(dir, "class-timings.json"), "utf8"))).length > 0);
    assert.equal(existsSync(lock), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a live timing lock times out without hiding the JSON report", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-live-lock-"));
  const lock = join(dir, "class-timings.json.lock");
  mkdirSync(lock);
  writeFileSync(join(lock, "pid"), `${process.pid}\n`);
  try {
    const run = await unitRun([...staticsArgs, "--out", dir], {GOGEN_UNIT_TIMING_LOCK_TIMEOUT_MS: "50"});
    assert.equal(run.status, 0, run.stderr || run.stdout);
    assert.deepEqual(run.result.rows.map((row) => row.status), ["SUCCESS", "SUCCESS", "SUCCESS", "SUCCESS"]);
    assert.match(run.stderr, /warning: class timings were not saved: timing lock timed out/);
    assert.equal(existsSync(join(dir, "class-timings.json")), false);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("signals, nonzero exits and incomplete JSON isolate pending classes and keep completed failures", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-incomplete-"));
  const wrapper = join(dir, "runner.mjs");
  const method = (owner) => ({class: owner, testclass: "LOCAL", method: "CHECK", status: "READY", message: ""});
  const ready = [method("DONE"), method("DEAD"), method("PASS")];
  const groups = ready.map((row) => ({key: `${row.class}:LOCAL`, methods: [row]}));
  writeFileSync(wrapper, `#!/usr/bin/env node
import {readFileSync, writeFileSync} from "node:fs";
const args = process.argv.slice(2);
const row = (owner, status, message = "") => ({class: owner, testclass: "LOCAL", method: "CHECK", status, message});
if (!/retry-/.test(process.cwd())) {
  writeFileSync(args[args.indexOf("--results-out") + 1], JSON.stringify({rows: [null, row("DONE", "FAILED", "class_teardown: expected failure")]}));
  if (process.env.GOGEN_UNIT_TEST_FAULT === "incomplete") { console.log("[]"); process.exit(0); }
} else if (JSON.parse(readFileSync(args[args.indexOf("--classes-file") + 1], "utf8"))[0] === "PASS:LOCAL") {
  console.log(JSON.stringify([row("PASS", "SUCCESS")])); process.exit(0);
}
if (process.env.GOGEN_UNIT_TEST_FAULT === "signal") process.kill(process.pid, "SIGTERM");
else { process.stderr.write("own fatal reason\\nmore stderr\\n"); process.exit(7); }
`);
  chmodSync(wrapper, 0o755);
  const oldRunner = process.env.GOGEN_UNIT_RUNNER, oldFault = process.env.GOGEN_UNIT_TEST_FAULT;
  try {
    process.env.GOGEN_UNIT_RUNNER = wrapper;
    for (const fault of ["signal", "nonzero", "incomplete"]) {
      process.env.GOGEN_UNIT_TEST_FAULT = fault;
      const out = join(dir, fault); mkdirSync(out);
      const result = await runUnit({bin: wrapper, groups, ready, jobs: 1, out, runDir: out});
      assert.deepEqual(reconcile(ready, result.actual).map((row) => [row.status, row.message]), [
        ["FAILED", "class_teardown: expected failure"],
        ["FAILED", `runner died: ${fault === "signal" ? "terminated by SIGTERM" : "own fatal reason"}`],
        ["SUCCESS", ""],
      ]);
      assert.deepEqual(reconcile(ready, result.actual).map((row) => row.source), [undefined, "harness", undefined]);
      assert.equal(result.runDetail.retries, 2);
    }
  } finally {
    if (oldRunner === undefined) delete process.env.GOGEN_UNIT_RUNNER; else process.env.GOGEN_UNIT_RUNNER = oldRunner;
    if (oldFault === undefined) delete process.env.GOGEN_UNIT_TEST_FAULT; else process.env.GOGEN_UNIT_TEST_FAULT = oldFault;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("fatal recursion retries only unfinished classes once, in single and sharded runs", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-crash-"));
  const wrapper = join(dir, "runner.mjs");
  // Log actual processes, rather than trusting the scheduling counters.
  writeFileSync(wrapper, `#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {appendFileSync, readFileSync} from "node:fs";
const args = process.argv.slice(2);
if (!args.includes("--seed-image-out")) {
  const selected = args.includes("--classes-file") ? JSON.parse(readFileSync(args[args.indexOf("--classes-file") + 1], "utf8")) : null;
  appendFileSync(process.env.GOGEN_UNIT_TEST_LOG, JSON.stringify({selected, retry: /retry-/.test(process.cwd())}) + "\\n");
}
const run = spawnSync(process.env.GOGEN_UNIT_BINARY, args, {stdio: "inherit"});
process.exit(run.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  try {
    for (const jobs of [1, 2]) {
      const log = join(dir, `processes-${jobs}.ndjson`);
      const run = await unitRun([join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-crash"),
        "--jobs", String(jobs), "--no-cache", "--out", join(dir, `out-${jobs}`)],
      {GOGEN_UNIT_MAX_STACK: "65536", GOGEN_UNIT_RUNNER: wrapper, GOGEN_UNIT_TEST_LOG: log});
      assert.equal(run.status, 1, run.stderr || run.stdout);
      assert.deepEqual(run.result.rows.map((r) => r.status), ["SUCCESS", "FAILED", "SUCCESS", "SUCCESS"]);
      assert.match(run.result.rows[1].message, /^runner died: runtime: goroutine stack exceeds 65536-byte limit/);
      assert.equal(run.result.rows[1].message.includes("\n"), false, "only the first stderr line");
      const processes = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      const retries = processes.filter((p) => p.retry);
      assert.equal(processes.length, 4, "test processes (excluding the seed image process)");
      assert.equal(retries.length, jobs === 1 ? 3 : 2);
      assert.equal(run.result.timingMs.runDetail.retries, retries.length);
      assert.ok(retries.every((p) => p.selected.length === 1), "each retry has its own process");
      assert.equal(retries.filter((p) => p.selected[0] === "ZCL_GOGEN_CRASH_B_RECUR:LTCL_TEST").length, 1);
      assert.ok(retries.every((p) => !p.selected[0].includes("A_PASS")), "completed class was not re-run");
      if (jobs === 2) assert.ok(retries.every((p) => !p.selected[0].includes("C_PASS")), "completed shard was not re-run");
      assert.equal(existsSync(join(dirname(run.result.buildDir), "single")), false);
      assert.equal(existsSync(join(dirname(run.result.buildDir), "shards")), false);
      assert.ok(!Object.keys(JSON.parse(readFileSync(join(dir, `out-${jobs}`, "class-timings.json"), "utf8")))
        .some((key) => key.includes("B_RECUR")), "dead classes have no completed timing");
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a missing or corrupt seed image and a killed shard fail every assigned method", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-faults-"));
  const wrapper = join(dir, "runner.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node
import {spawn, spawnSync} from "node:child_process";
import {rmSync, writeFileSync} from "node:fs";
const args = process.argv.slice(2);
const image = args[args.indexOf("--seed-image") + 1];
if (args.includes("--classes-file")) {
  if (process.env.GOGEN_UNIT_TEST_FAULT === "limit") {
    process.stderr.write("earlier stderr\\n");
    spawn(process.execPath, ["-e", "process.stdout.write('x'.repeat(21e6)); setTimeout(() => require('node:fs').writeFileSync(process.env.GOGEN_UNIT_TEST_MARKER, 'survived'), 500)"],
      {stdio: ["ignore", "inherit", "inherit"], env: process.env});
    process.exit(0);
  }
}
if (process.env.GOGEN_UNIT_TEST_FAULT === "signal" && args.includes("--seed-image-out")) {
  process.stderr.write("earlier stderr\\n");
  process.kill(process.pid, "SIGTERM");
}
const run = spawnSync(process.env.GOGEN_UNIT_BINARY, args, {stdio: "inherit"});
if (args.includes("--seed-image-out") && run.status === 0) {
  const target = args[args.indexOf("--seed-image-out") + 1];
  if (process.env.GOGEN_UNIT_TEST_FAULT === "missing") rmSync(target);
  if (process.env.GOGEN_UNIT_TEST_FAULT === "corrupt") writeFileSync(target, "not a SQLite database");
}
process.exit(run.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  try {
    for (const fault of ["missing", "corrupt", "limit", "signal"]) {
      const marker = join(dir, "survived");
      const run = await unitRun([...staticsArgs, "--out", join(dir, fault)],
        {GOGEN_UNIT_RUNNER: wrapper, GOGEN_UNIT_TEST_FAULT: fault, GOGEN_UNIT_TEST_MARKER: marker});
      assert.equal(run.status, 1, run.stderr || run.stdout);
      assert.deepEqual(run.result.rows.map((row) => row.status), ["FAILED", "FAILED", "FAILED", "FAILED"]);
      assert.ok(run.result.rows.every((row) => row.source === "harness"));
      const messages = run.result.rows.map((row) => row.message);
      if (fault === "limit") {
        assert.ok(messages.every((msg) => /stdout limit exceeded/.test(msg)), messages.join("\n"));
        assert.ok(messages.every((msg) => !/earlier stderr/.test(msg)));
        await new Promise((resolveWait) => setTimeout(resolveWait, 700));
        assert.equal(existsSync(marker), false, "the runner's descendant survived the output limit");
      } else if (fault === "signal") {
        assert.ok(messages.every((msg) => /seed image: terminated by SIGTERM/.test(msg)), messages.join("\n"));
        assert.ok(messages.every((msg) => !/earlier stderr/.test(msg)));
      } else assert.ok(messages.every((msg) => /seed image:/.test(msg)));
      assert.equal(existsSync(join(dirname(run.result.buildDir), "shards")), false);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("runner errors and signals take precedence over earlier stderr", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-run-errors-"));
  const wrapper = join(dir, "runner.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node
process.stderr.write("earlier stderr\\n");
process.kill(process.pid, "SIGTERM");
`);
  chmodSync(wrapper, 0o755);
  try {
    for (const [label, jobs, runner, expected] of [
      ["single-signal", "1", wrapper, "runner died: terminated by SIGTERM: earlier stderr"],
      ["seed-error", "2", join(dir, "absent"), "seed image: spawnSync"],
      ["single-error", "1", join(dir, "absent"), "runner died: spawn"],
    ]) {
      const run = await unitRun([...staticsArgs.slice(0, -2), "--jobs", jobs, "--out", join(dir, label)], {GOGEN_UNIT_RUNNER: runner});
      assert.equal(run.status, 1, run.stderr || run.stdout);
      assert.ok(run.result.rows.every((row) => row.message.includes(expected)), JSON.stringify(run.result.rows));
      assert.equal(run.result.timingMs.runDetail.retries, label === "single-error" ? 0 : label === "single-signal" ? 1 : undefined);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("interrupting a multi-class single run exits without retry processes", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-interrupt-"));
  const wrapper = join(dir, "runner.mjs");
  writeFileSync(wrapper, `#!/usr/bin/env node
import {appendFileSync} from "node:fs";
appendFileSync(process.env.GOGEN_UNIT_TEST_LOG, process.cwd() + "\\n");
process.stderr.write("earlier stderr\\n");
setTimeout(() => process.kill(process.ppid, process.env.GOGEN_UNIT_TEST_SIGNAL), 50);
setInterval(() => {}, 1000);
`);
  chmodSync(wrapper, 0o755);
  try {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const log = join(dir, `${signal}.ndjson`);
      const run = await unitRun([join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-crash"),
        "--jobs", "1", "--out", join(dir, signal)],
      {GOGEN_UNIT_RUNNER: wrapper, GOGEN_UNIT_TEST_LOG: log, GOGEN_UNIT_TEST_SIGNAL: signal});
      assert.equal(run.status, 1, run.stderr || run.stdout);
      assert.equal(run.result.rows.length, 4);
      assert.ok(run.result.rows.every((row) => row.status === "FAILED" && row.message === "runner died: interrupted"));
      assert.equal(run.result.timingMs.runDetail.retries, 0);
      assert.equal(readFileSync(log, "utf8").trim().split("\n").length, 1, "only the original process started");
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("an invalid stack limit stops after exactly one retry", {timeout: 120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-startup-"));
  const wrapper = join(dir, "runner.mjs"), log = join(dir, "processes.ndjson");
  writeFileSync(wrapper, `#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {appendFileSync} from "node:fs";
appendFileSync(process.env.GOGEN_UNIT_TEST_LOG, process.cwd() + "\\n");
const run = spawnSync(process.env.GOGEN_UNIT_BINARY, process.argv.slice(2), {stdio: "inherit"});
process.exit(run.status ?? 1);
`);
  chmodSync(wrapper, 0o755);
  try {
    const run = await unitRun([join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-crash"),
      "--jobs", "1", "--out", join(dir, "out")],
    {GOGEN_UNIT_MAX_STACK: "invalid", GOGEN_UNIT_RUNNER: wrapper, GOGEN_UNIT_TEST_LOG: log});
    assert.equal(run.status, 1, run.stderr || run.stdout);
    assert.equal(run.result.rows.length, 4);
    assert.ok(run.result.rows.every((row) => row.status === "FAILED"
      && row.message === "runner died: panic: invalid GOGEN_UNIT_MAX_STACK"));
    assert.equal(run.result.timingMs.runDetail.retries, 1);
    const processes = readFileSync(log, "utf8").trim().split("\n");
    assert.equal(processes.length, 2);
    assert.equal(processes.filter((line) => /retry-/.test(line)).length, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("shard end timings include recovery from a repeated startup failure", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-retry-timing-"));
  const wrapper = join(dir, "runner.mjs");
  const ready = ["A", "B", "C", "D"].map((owner) =>
    ({class: owner, testclass: "LOCAL", method: "CHECK", status: "READY", message: ""}));
  const groups = ready.map((row) => ({key: `${row.class}:LOCAL`, methods: [row]}));
  writeFileSync(wrapper, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";
const args = process.argv.slice(2);
if (args.includes("--seed-image-out")) { writeFileSync(args[args.indexOf("--seed-image-out") + 1], ""); process.exit(0); }
setTimeout(() => { process.stderr.write("startup panic\\n"); process.exit(7); }, /retry-/.test(process.cwd()) ? 200 : 0);
`);
  chmodSync(wrapper, 0o755);
  const oldRunner = process.env.GOGEN_UNIT_RUNNER;
  try {
    process.env.GOGEN_UNIT_RUNNER = wrapper;
    const result = await runUnit({bin: wrapper, groups, ready, jobs: 2, out: dir, runDir: dir});
    assert.equal(result.runDetail.retries, 2, "one retry for each dead shard");
    assert.ok(result.actual.every((row) => row.message === "runner died: startup panic"));
    assert.equal(result.actual.length, 4);
    for (const phase of result.runDetail.shards) assert.ok(phase.endMs - phase.startMs >= 200, JSON.stringify(phase));
  } finally {
    if (oldRunner === undefined) delete process.env.GOGEN_UNIT_RUNNER; else process.env.GOGEN_UNIT_RUNNER = oldRunner;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("unit statics parity labels only reviewed Node assertions as nodeAnomaly", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-statics-compare-"));
  const base = {class: "ZCL_OSD_STATICS_TEST", testclass: "LTC_B", method: "M1_FIRST"};
  const go = {...base, status: "SUCCESS", message: ""};
  try {
    writeFileSync(join(dir, "go.json"), JSON.stringify({rows: [go]}));
    for (const [message, category] of [["Expected '1', got '3'", "nodeAnomaly"], ["Expected '1', got '5'", "different"]]) {
      writeFileSync(join(dir, "node.json"), JSON.stringify([{...base, status: "FAILED", message}]));
      const run = spawnSync("node", [join(here, "unit-compare.mjs"), "--node-json", join(dir, "node.json"), "--go-json", join(dir, "go.json")], {encoding: "utf8", timeout: 10000});
      assert.equal(run.error, undefined, run.stderr);
      assert.deepEqual(JSON.parse(run.stdout).methods[category].map((row) => row.key), ["ZCL_OSD_STATICS_TEST/LTC_B/M1_FIRST"]);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("ABAP fixture runs pass, fail, exception, and teardown after failures", {timeout: 120000}, () => {
  const run = spawnSync("node", [join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit"), "--no-cache"], {
    cwd: join(here, "..", ".."), encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
  });
  assert.equal(run.status, 1, run.stderr || run.error?.message);
  const summary = JSON.parse(run.stdout);
  const rows = summary.rows;
  assert.ok(summary.timingMs.frontendClosureRounds.length > 0);
  for (const phase of ["emit", "goBuild", "run"]) assert.ok(summary.timingMs[phase] >= 0, phase);
  assert.deepEqual(rows.map((r) => r.method), ["PASS", "FAIL", "EXCEPTION", "AFTER_FAILURE", "DECIMAL_OUTSIDE", "FIRST", "SECOND", "THIRD", "FIRST", "SECOND", "FIRST", "SECOND"]);
  assert.deepEqual(rows.map((r) => r.status), ["SUCCESS", "FAILED", "FAILED", "SUCCESS", "SUCCESS", "FAILED", "FAILED", "SKIPPED", "FAILED", "SKIPPED", "FAILED", "SUCCESS"]);
  assert.equal(rows[1].message, "intentional failure");
  assert.match(rows[2].message, /CX_SY_ZERODIVIDE/);
  // abapiti 10-09: an error that is not an assertion names its ABAP source line
  assert.equal(rows[2].where, "zcl_gogen_unit_fixture.clas.testclasses.abap:81");
  assert.equal(rows[1].where, undefined);
  assert.equal(rows[6].message, "teardown: stop second");
  assert.match(rows[7].message, /stopped after teardown failure/);
  assert.match(rows[9].message, /stopped after teardown failure/);
  assert.equal(rows[10].message, "teardown: teardown continue");
});

test("class setup and class teardown errors name their ABAP site in where", {timeout: 120000}, () => {
  const run = spawnSync("node", [join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-where"), "--no-cache"], {
    cwd: join(here, "..", ".."), encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
  });
  assert.equal(run.status, 1, run.stderr || run.error?.message);
  const rows = Object.fromEntries(JSON.parse(run.stdout).rows.map((r) => [`${r.testclass}/${r.method}`, r]));
  const divide = "zcl_gogen_unit_where.clas.abap:8";
  assert.equal(rows["LTCL_SETUP/FIRST"].where, divide);
  assert.equal(rows["LTCL_TEARDOWN/PASSES"].where, divide);
  assert.equal(rows["LTCL_TEARDOWN/FAILS"].where, `zcl_gogen_unit_where.clas.testclasses.abap:30 class_teardown: ${divide}`);
});

test("byte section replacement, bounded FIND and memory spans run through ABAP Unit", async () => {
  const run = await unitRun([join(here, "unit.mjs"), "--fixture", "tools/gogen/testdata",
    "--class", "ZCL_GOGEN_T_BYTESECTION", "--class", "ZCL_GOGEN_T_BYTEMEM",
    "--class", "ZCL_ABAPITI_REPRO_BYTES", "--class", "ZCL_ABAPITI_REPRO_MEM",
    "--class", "ZCL_GOGEN_T_BYTEORACLE", "--jobs", "2"]);
  assert.equal(run.status, 0, run.stderr || run.stdout);
  assert.equal(run.result.classes, 5);
  assert.equal(run.result.compiled, 5);
  assert.equal(run.result.rows.length, 57);
  assert.ok(run.result.rows.every((row) => row.status === "SUCCESS"), run.stdout);
});

test("GENERATE SUBROUTINE POOL is refused with sy-subrc 8 and its method still runs", {timeout: 120000}, () => {
  const run = spawnSync("node", [join(here, "unit.mjs"), "--fixture", join(here, "testdata-unit-generate"), "--no-cache"], {
    cwd: join(here, "..", ".."), encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
  });
  assert.equal(run.status, 0, run.stderr || run.error?.message);
  const rows = JSON.parse(run.stdout).rows;
  assert.deepEqual(rows.map((r) => `${r.method}:${r.status}`), ["REFUSED:SUCCESS", "NAME_ONLY:SUCCESS", "NAME_COMPONENT:SUCCESS"]);
});

test("a Go compiler refusal is retried without losing unrelated Unit methods", {timeout:120000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-retry-"));
  try {
    writeFileSync(join(dir,"zcl_unit_retry.clas.abap"), `CLASS zcl_unit_retry DEFINITION PUBLIC FINAL CREATE PUBLIC. ENDCLASS.
CLASS zcl_unit_retry IMPLEMENTATION. ENDCLASS.\n`);
    // SIGN over int8 is accepted by the existing IR but refused by Go's
    // float helper signature. Exercise the real compiler recovery path.
    writeFileSync(join(dir,"zcl_unit_retry.clas.testclasses.abap"), `CLASS ltcl_retry DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
PRIVATE SECTION. METHODS good FOR TESTING. METHODS bad FOR TESTING. ENDCLASS.
CLASS ltcl_retry IMPLEMENTATION.
METHOD good. ASSERT 1 = 1. ENDMETHOD.
METHOD bad. DATA wide TYPE int8 VALUE 1. wide = sign( wide ). ENDMETHOD.
ENDCLASS.\n`);
    const run = await unitRun([join(here,"unit.mjs"),"--fixture",dir,"--no-cache","--out",join(dir,"out")]);
    assert.equal(run.status,2,run.stderr || run.stdout);
    const good = run.result.rows.find((row)=>row.method === "GOOD");
    const bad = run.result.rows.find((row)=>row.method === "BAD");
    assert.equal(good.status,"SUCCESS",run.stdout);
    assert.equal(bad.status,"NOT_COMPILED",run.stdout);
    assert.match(bad.message,/Go compiler:/);
  } finally {rmSync(dir,{recursive:true,force:true});}
});

test("integer power and numeric/logical built-ins run through ABAP Unit", {timeout:120000}, async () => {
  const run = await unitRun([join(here,"unit.mjs"),"--fixture",join(here,"testdata"),
    "--class","ZCL_GOGEN_T_IPOW","--no-cache"]);
  assert.equal(run.status,0,run.stderr || run.stdout);
  assert.equal(run.result.compiled,1);
  assert.equal(run.result.rows.length,10);
  assert.ok(run.result.rows.every((row)=>row.status === "SUCCESS"),run.stdout);
});

test("GOGEN_UNIT_TIMEOUT_MS bounds a test process, and a value that is not a positive whole number is refused", {timeout: 60000}, async () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-unit-timeout-"));
  const wrapper = join(dir, "runner.mjs");
  writeFileSync(wrapper, "#!/usr/bin/env node\nsetTimeout(() => {}, 60000);\n");
  chmodSync(wrapper, 0o755);
  const ready = [{class: "SLOW", testclass: "LOCAL", method: "CHECK", status: "READY", message: ""}];
  const groups = [{key: "SLOW:LOCAL", methods: ready}];
  const oldRunner = process.env.GOGEN_UNIT_RUNNER, oldTimeout = process.env.GOGEN_UNIT_TIMEOUT_MS;
  try {
    process.env.GOGEN_UNIT_RUNNER = wrapper;
    process.env.GOGEN_UNIT_TIMEOUT_MS = "300";
    const out = join(dir, "run"); mkdirSync(out);
    const started = Date.now();
    const result = await runUnit({bin: wrapper, groups, ready, jobs: 1, out, runDir: out});
    assert.ok(Date.now() - started < 20000);
    assert.deepEqual(reconcile(ready, result.actual).map((row) => row.message), ["runner died: timeout after 300 ms"]);
    for (const bad of ["0", "-5", "1.5", "abc", "", "2147483648"]) {
      process.env.GOGEN_UNIT_TIMEOUT_MS = bad;
      await assert.rejects(runUnit({bin: wrapper, groups, ready, jobs: 1, out, runDir: out}), /GOGEN_UNIT_TIMEOUT_MS/);
    }
  } finally {
    if (oldRunner === undefined) delete process.env.GOGEN_UNIT_RUNNER; else process.env.GOGEN_UNIT_RUNNER = oldRunner;
    if (oldTimeout === undefined) delete process.env.GOGEN_UNIT_TIMEOUT_MS; else process.env.GOGEN_UNIT_TIMEOUT_MS = oldTimeout;
    rmSync(dir, {recursive: true, force: true});
  }
});

test("failed casts preserve ABAP get_text and add diagnostics only to uncaught reports", {timeout: 120000}, () => {
  const dir = mkdtempSync(join(tmpdir(), "cast-diagnostics-"));
  try {
    writeFileSync(join(dir, "zcl_cast_diag.clas.abap"), `CLASS zcl_cast_diag DEFINITION PUBLIC. ENDCLASS.
CLASS zcl_cast_diag IMPLEMENTATION. ENDCLASS.`);
    writeFileSync(join(dir, "zcl_cast_target.clas.abap"), `CLASS zcl_cast_target DEFINITION PUBLIC. ENDCLASS. CLASS zcl_cast_target IMPLEMENTATION. ENDCLASS.`);
    writeFileSync(join(dir, "zcl_cast_diag.clas.testclasses.abap"), `CLASS ltcl_cast DEFINITION FOR TESTING.
  PRIVATE SECTION.
    METHODS caught FOR TESTING.
    METHODS uncaught FOR TESTING.
    METHODS create_wrong FOR TESTING.
ENDCLASS.
CLASS ltcl_cast IMPLEMENTATION.
  METHOD caught.
    DATA source TYPE REF TO object.
    DATA target TYPE REF TO zcl_cast_target.
    CREATE OBJECT source TYPE zcl_cast_diag.
    TRY.
      target ?= source.
      cl_abap_unit_assert=>fail( ).
    CATCH cx_sy_move_cast_error INTO DATA(error).
      cl_abap_unit_assert=>assert_equals( act = error->get_text( ) exp = 'CX_SY_MOVE_CAST_ERROR in ?=' ).
    ENDTRY.
  ENDMETHOD.
  METHOD uncaught.
    DATA source TYPE REF TO object.
    DATA target TYPE REF TO zcl_cast_target.
    CREATE OBJECT source TYPE zcl_cast_diag.
    target ?= source.
  ENDMETHOD.
  METHOD create_wrong.
    DATA target TYPE REF TO zcl_cast_target.
    DATA name TYPE string VALUE 'ZCL_CAST_DIAG'.
    CREATE OBJECT target TYPE (name).
  ENDMETHOD.
ENDCLASS.`);
    const run = spawnSync("node", [join(here, "unit.mjs"), "--fixture", dir, "--no-cache"], {
      cwd: root, encoding: "utf8", timeout: 110000, maxBuffer: 5e6,
    });
    assert.equal(run.status, 1, run.stderr || run.stdout || run.error?.message);
    const rows = Object.fromEntries(JSON.parse(run.stdout).rows.map(row => [row.method, row]));
    assert.equal(rows.CAUGHT.status, "SUCCESS", JSON.stringify(rows));
    for (const [method, op] of [["UNCAUGHT", "?="], ["CREATE_WRONG", "CREATE OBJECT TYPE (ZCL_CAST_DIAG)"]]) {
      assert.equal(rows[method].status, "FAILED");
      assert.ok(rows[method].message.startsWith(`CX_SY_MOVE_CAST_ERROR in ${op} [`), rows[method].message);
      assert.match(rows[method].message, /\*main\.ZCL_CAST_DIAG -> \*main\.ZCL_CAST_TARGET at .*zcl_cast_diag\.clas\.testclasses\.abap:\d+\]$/);
    }
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
