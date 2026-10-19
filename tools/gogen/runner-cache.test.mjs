import {spawnSync} from "node:child_process";
import {cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {test} from "node:test";
import assert from "node:assert/strict";
import {join, resolve} from "node:path";
import {prepareRunnerCache, finishRunnerCache} from "./runner-cache-recording.mjs";
import {frontendCacheDir, runnerCacheOptions} from "./runner-cache.mjs";
test("runner object cache is off unless explicitly requested", () => {
  assert.equal(frontendCacheDir("/checkout", {}), undefined);
  assert.equal(frontendCacheDir("/checkout", {OSD_GOGEN_CACHE: ""}), undefined);
  assert.equal(frontendCacheDir("/checkout", {OSD_GOGEN_CACHE: "1"}), "/checkout/.local/osd-run/frontend");
  assert.equal(frontendCacheDir("/checkout", {OSD_GOGEN_CACHE: "1", OSD_RUN_CACHE: "/runs"}), "/runs/frontend");
  assert.equal(frontendCacheDir("/checkout", {OSD_GOGEN_CACHE: "objects"}), resolve("objects"));
});

test("runner cache keeps global guards without implicit v3 recording", () => {
  assert.deepEqual(runnerCacheOptions("/checkout", {}), {});
  assert.deepEqual(runnerCacheOptions("/checkout", {GOGEN_PROVENANCE: "1"}), {});
  assert.deepEqual(runnerCacheOptions("/checkout", {OSD_GOGEN_CACHE: "/objects"}), {cacheDir: resolve("/objects"), provenance: false, dependencyCache: true});
  assert.deepEqual(runnerCacheOptions("/checkout", {OSD_GOGEN_CACHE: "/objects", GOGEN_PROVENANCE: "1"}), {cacheDir: resolve("/objects"), provenance: true, dependencyCache: true});
});

test("Go Unit fresh processes use object entries with snapshot caching bypassed", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-unit-"));
  try {
    const cache = join(dir, "frontend");
    const run = (enabled) => {
      const env = {...process.env, OSD_GOGEN_CACHE: enabled ? cache : ""};
      const child = spawnSync(process.execPath, [join(import.meta.dirname, "unit.mjs"),
        "--fixture", "test/fixtures/unit-statics", "--class", "ZCL_OSD_STATICS_TEST",
        "--no-cache", "--unlayered", "--out", join(dir, "out")], {env, encoding: "utf8", maxBuffer: 20e6});
      assert.equal(child.status, 0, child.stderr || child.stdout);
      const result = JSON.parse(child.stdout);
      assert.equal(result.cache.status, "bypass");
      assert.ok(result.rows.every((row) => row.status === "SUCCESS"));
      return result;
    };
    const cold = run(false), recorded = run(true), warm = run(true);
    assert.deepEqual(warm.rows, cold.rows);
    assert.equal(recorded.timingMs.frontendClosureCounts[0].reused, 0);
    assert.ok(warm.timingMs.frontendClosureCounts[0].reused > 0);
    const generated = (result) => readFileSync(join(result.buildDir, "cmd/unit/zz_generated.go"));
    assert.deepEqual(generated(recorded), generated(cold));
    assert.deepEqual(generated(warm), generated(cold));
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


const source = (name, body, type = "i") => `CLASS ${name} DEFINITION PUBLIC.
PUBLIC SECTION. CLASS-METHODS run RETURNING VALUE(rv) TYPE ${type}.
ENDCLASS. CLASS ${name} IMPLEMENTATION. METHOD run. ${body} ENDMETHOD. ENDCLASS.`;
function capture(options) {
  const code = `
    import {createHash} from "node:crypto";
    import {compileProgram} from ${JSON.stringify(new URL("frontend.mjs", import.meta.url).href)};
    import {artifactsOf} from ${JSON.stringify(new URL("cache-oracle-capture.mjs", import.meta.url).href)};
    const p = compileProgram(JSON.parse(process.argv[1]));
    console.log(JSON.stringify({hash: createHash("sha256").update(JSON.stringify(artifactsOf(p).artifacts)).digest("hex"), counts: p.frontendCounts}));
  `;
  const child = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", code, JSON.stringify(options)], {encoding: "utf8", maxBuffer: 4e6});
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout);
}

test("runner dependency mode reuses unchanged classes across paths and invalidates an edited provider's closure", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-dependencies-"));
  try {
    const input = join(dir, "input"), relocated = join(dir, ".build-another-pid"), cacheDir = join(dir, "cache"); mkdirSync(input);
    writeFileSync(join(input, "zbase.clas.abap"), source("zbase", "rv = 1."));
    writeFileSync(join(input, "zreader.clas.abap"), source("zreader", "rv = zbase=>run( )."));
    writeFileSync(join(input, "zother.clas.abap"), source("zother", "rv = 3."));
    const options = {folders: [input], objects: ["ZBASE", "ZOTHER", "ZREADER"], cacheDir, dependencyCache: true, provenance: false};
    const cold = capture({...options, cacheDir: undefined}), recorded = capture(options);
    assert.equal(recorded.hash, cold.hash);
    cpSync(input, relocated, {recursive: true});
    const moved = {...options, folders: [relocated]}, warm = capture(moved);
    assert.equal(warm.hash, cold.hash); assert.equal(warm.counts.lowered, 0);
    writeFileSync(join(relocated, "zbase.clas.abap"), source("zbase", "rv = 9."));
    const edited = capture(moved);
    assert.equal(edited.hash, capture({...moved, cacheDir: undefined}).hash);
    assert.notEqual(edited.hash, cold.hash);
    assert.deepEqual(edited.counts.loweredClasses, ["ZBASE", "ZREADER"]);
    assert.deepEqual(edited.counts.reusedClasses, ["ZOTHER"]);
    const next = capture({...moved, dependencyCache: false});
    assert.equal(next.hash, edited.hash);
    assert.equal(next.counts.lowered, 0, "validated dependency hits were promoted for the recording-off warm run");
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

for (const dependency of ["type pool", "include macro"]) test(`runner dependency mode guards a resolved ${dependency}`, () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-hidden-"));
  try {
    const input = join(dir, "input"); mkdirSync(input);
    const pool = dependency === "type pool";
    writeFileSync(join(input, "zreader.clas.abap"), source("zreader", pool ? "rv = 1." : "read_value.", pool ? "zpool_number" : "i"));
    writeFileSync(join(input, "zother.clas.abap"), source("zother", "rv = 3."));
    const file = join(input, pool ? "zpool.type.abap" : "zbody.prog.abap");
    const before = pool ? "TYPE-POOL zpool. TYPES zpool_number TYPE i." : "DEFINE read_value. rv = 1. END-OF-DEFINITION.";
    writeFileSync(file, before);
    if (!pool) writeFileSync(join(input, "zreader.clas.macros.abap"), "INCLUDE zbody.");
    const options = {folders: [input], objects: ["ZOTHER", "ZREADER"], cacheDir: join(dir, "cache"), dependencyCache: true, provenance: false};
    const cold = capture(options);
    assert.equal(capture(options).counts.lowered, 0);
    writeFileSync(file, before.replace(pool ? "TYPE i" : "rv = 1", pool ? "TYPE int8" : "rv = 9"));
    const edited = capture(options);
    assert.equal(edited.hash, capture({...options, cacheDir: undefined}).hash);
    assert.notEqual(edited.hash, cold.hash);
    assert.deepEqual(edited.counts.loweredClasses, ["ZREADER"]);
    assert.deepEqual(edited.counts.reusedClasses, ["ZOTHER"]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("a generated class with thousands of repeated calls is stored and reused in a fresh process", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-repeated-"));
  try {
    writeFileSync(join(dir, "zbase.clas.abap"), source("zbase", "rv = 1."));
    writeFileSync(join(dir, "zbig.clas.abap"), source("zbig", "rv = zbase=>run( ).".repeat(5000)));
    const options = {folders: [dir], objects: ["ZBASE", "ZBIG"], cacheDir: join(dir, "cache"), provenance: false};
    const cold = capture(options), warm = capture(options);
    assert.equal(warm.hash, cold.hash); assert.equal(warm.counts.lowered, 0);
    writeFileSync(join(dir, "zbase.clas.abap"), source("zbase", "rv = 9."));
    const edited = capture(options);
    assert.deepEqual(edited.counts.loweredClasses, options.objects);
    assert.equal(edited.hash, capture({...options, cacheDir: undefined}).hash);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("the runner recording certificate is content based, portable, and never enables a default-off cache", () => {
  assert.deepEqual(prepareRunnerCache(["/absent"], {}), {options: {}});
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-recording-"));
  try {
    const input = join(dir, "input"), moved = join(dir, ".build-other"), cacheDir = join(dir, "cache"); mkdirSync(input);
    const file = join(input, "zother.clas.abap"); writeFileSync(file, source("zother", "rv = 3."));
    const options = {cacheDir, dependencyCache: true, provenance: false};
    const first = prepareRunnerCache([input], options);
    assert.equal(first.options.dependencyCache, true); finishRunnerCache(first.certificate);
    cpSync(input, moved, {recursive: true});
    assert.equal(prepareRunnerCache([moved], options).options.dependencyCache, false);
    writeFileSync(join(moved, "zother.clas.abap"), source("zother", "rv = 9."));
    assert.equal(prepareRunnerCache([moved], options).options.dependencyCache, true);
    writeFileSync(join(cacheDir, "runner-profile.json"), "broken");
    assert.equal(prepareRunnerCache([input], options).options.dependencyCache, true);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});


test("generated tool output cannot change the compiler identity", () => {
  const output = join(import.meta.dirname, ".out", "runner-identity-test"); mkdirSync(output, {recursive: true});
  const identity = () => {
    const child = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e",
      `import {toolIdentity} from ${JSON.stringify(new URL("frontend-object-cache.mjs", import.meta.url).href)}; console.log(toolIdentity());`], {encoding: "utf8"});
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  };
  try {
    const file = join(output, "symbols.json"); writeFileSync(file, JSON.stringify({build: "first"}));
    const first = identity(); writeFileSync(file, JSON.stringify({build: "another-run"}));
    assert.equal(identity(), first);
  } finally { rmSync(output, {recursive: true, force: true}); }
});


test("real runner timing exposes ordered selection for the emit-only independent roots oracle", () => {
  const dir = mkdtempSync(join(tmpdir(), "gogen-runner-selection-timing-"));
  try {
    const run = (label, enabled) => {
      const build = join(dir, label), child = spawnSync(process.execPath,
        ["--preserve-symlinks", join(import.meta.dirname, "osabap.mjs")], {
          encoding: "utf8", maxBuffer: 20e6, env: {...process.env, OSABAP_BUILD_ROOT: build,
            OSABAP_EMIT_ONLY: "1", OSABAP_TIMING: "1", OSD_GOGEN_CACHE: enabled ? join(dir, "cache") : ""},
        });
      assert.equal(child.status, 0, child.stderr);
      const rows = child.stderr.split("\n").filter(s => s.startsWith("OSABAP_TIMING ")).map(s => JSON.parse(s.slice(14)));
      const frontend = rows.find(r => r.phase === "frontend");
      assert.ok(frontend.selection.includes("ZCL_OSABAP_HELLO"));
      assert.equal(rows.find(r => r.phase === "goBuild").skipped, true);
      const artifacts = ["zz_app.go", "zz_generated.go", "zz_db.json", "symbols.json"].map(name => readFileSync(join(build, "go/cmd/osabap", name)));
      return {frontend, artifacts};
    };
    const reference = run("roots", false), recorded = run("recorded", true), warm = run("warm", true);
    assert.deepEqual(recorded.artifacts, reference.artifacts); assert.deepEqual(warm.artifacts, reference.artifacts);
    assert.deepEqual(recorded.frontend.selection, reference.frontend.selection);
    assert.deepEqual(warm.frontend.selection, reference.frontend.selection);
    assert.equal(warm.frontend.closureRounds, 1);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});
