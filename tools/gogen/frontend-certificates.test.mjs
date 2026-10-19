import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createHash} from "node:crypto";
import {serialize, deserialize} from "node:v8";
import {deflateRawSync, inflateRawSync} from "node:zlib";
import {compileProgram} from "./frontend.mjs";
import {compileClosedProgram} from "./frontend-closure.mjs";
import {compareArtifacts, artifactsOf} from "./cache-oracle-capture.mjs";
import {runOracle, syntheticCorpus} from "./cache-oracle.mjs";
import {queryCoverage, recordingPlan, certificateValidator} from "./frontend-certificates.mjs";
import {hashV3} from "./frontend-v3-key.mjs";
import {toolIdentity} from "./frontend-object-cache.mjs";
import {provenanceGraph, recordProvenance, compilationProvenanceOf, inheritStoredProvenance,
  beginProvenanceCompile, withArtifact, withRole, enumerateObjects, semanticQuery, auditedBookkeeping, auditBuiltArtifacts, scopedProvenance} from "./frontend-provenance.mjs";
import {rttiProjection, selectionHas, indexFrozenSelection} from "./frontend-queries.mjs";
import {core, parseObserved, finishInputs} from "./frontend-inventory.mjs";
import {readRecordingPlan, writeRecordingPlan} from "./frontend-v3-shadow.mjs";

const source = (name, body) => `CLASS ${name} DEFINITION PUBLIC. PUBLIC SECTION.
CLASS-METHODS run RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS ${name} IMPLEMENTATION. METHOD run. ${body} ENDMETHOD. ENDCLASS.`;
function fixture(run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-certificates-"));
  try {
    const put = (name, body) => writeFileSync(join(dir, `${name.toLowerCase()}.clas.abap`), source(name, body));
    put("ZBASE", "rv = 1."); put("ZREADER", "rv = zbase=>run( )."); put("ZOTHER", "rv = 3.");
    const options = {folders: [dir], objects: ["ZBASE", "ZOTHER", "ZREADER"], cacheDir: join(dir, "cache"), dependencyCache: true, provenance: false};
    const build = (extra = {}) => compileProgram({...options, ...extra});
    run({dir, put, build, options});
  } finally { rmSync(dir, {recursive: true, force: true}); }
}
const equalCold = (p, build) => assert.deepEqual(compareArtifacts(artifactsOf(p), artifactsOf(build({cacheDir: undefined}))), {equal: true});

test("scoped misses publish complete new dependencies across a later edit and revert", () => fixture(({put, build, options}) => {
  build();
  put("ZBASE", "rv = zother=>run( ).");
  const changed = build(); equalCold(changed, build);
  assert.deepEqual(changed.frontendCounts.loweredClasses, ["ZBASE", "ZREADER"]);
  const trace = provenanceGraph(changed.reg);
  assert.deepEqual([...trace.lowerings.keys()].sort(), ["CLAS ZBASE", "CLAS ZREADER"], "reused roots must not open lowering frames");
  assert.equal(trace.global.queries.size, 0, "preparation must not acquire global rows");
  for (const row of changed.frontendCounts.shadowV3.entries.filter((r) => r.actuallyLowered))
    assert.equal(row.currentComplete, true, JSON.stringify(row));
  const plan = readRecordingPlan(options.cacheDir);
  assert.ok(plan.nodes["CLAS ZBASE"].edges.includes("CLAS ZOTHER"), "new provider edge must survive publication");
  put("ZOTHER", "rv = 4.");
  const later = build(); equalCold(later, build);
  assert.deepEqual(later.frontendCounts.loweredClasses, ["ZBASE", "ZOTHER", "ZREADER"]);
  put("ZBASE", "rv = 1."); put("ZOTHER", "rv = 3.");
  equalCold(build(), build);
}));

test("scoped miss lowering rows include the same selection dependencies as full recording", () => fixture(({dir, put, build, options}) => {
  writeFileSync(join(dir, "zother.clas.abap"), source("ZOTHER", "rv = 3.")
    .replace("PUBLIC SECTION.", "PUBLIC SECTION. CLASS-DATA value TYPE i."));
  put("ZBASE", "rv = zother=>value."); build();
  put("ZBASE", "rv = zother=>value + 1.");
  let scoped;
  recordProvenance(() => { scoped = build(); assert.equal(scopedProvenance(), true); }, {expose:false, cacheDir:options.cacheDir});
  const full = build({cacheDir: undefined, provenance: true});
  assert.ok(scoped.frontendCounts.loweredClasses.includes("ZBASE"));
  const rows = (p) => [...provenanceGraph(p.reg).lowerings.get("CLAS ZBASE").queries.values()];
  assert.ok(rows(scoped).some((q) => q.phase === "selection" && q.kind === "getObject"
    && q.result.includes("CLAS ZOTHER")), "static attribute selection must contribute its provider");
  assert.deepEqual(rows(scoped), rows(full));
  assert.deepEqual([...provenanceGraph(scoped.reg).lowerings.get("CLAS ZBASE").edges].sort(),
    [...provenanceGraph(full.reg).lowerings.get("CLAS ZBASE").edges].sort());
}));

for (const kind of ["named", "semantic", "scan", "enumeration"]) test(`idle scoped global ${kind} read refuses reuse and the next recording plan`, () => fixture(({build, options}) => {
  const prime = build();
  const reg = prime.reg;
  const namespace = readdirSync(join(options.cacheDir, "v3"))[0], directory = join(options.cacheDir, "v3", namespace);
  const unpack = (path) => deserialize(inflateRawSync(readFileSync(path).subarray(65)));
  const index = unpack(join(directory, readdirSync(directory).find((n) => n.endsWith(".certificates"))));
  const key = Object.keys(index.roots).find((k) => index.roots[k].root === "lowering:CLAS ZBASE");
  const candidate = unpack(join(directory, hashV3(["CLAS ZBASE", "ZBASE"]), `${key}.bin`));
  const value = deserialize(candidate.valueBytes);
  recordProvenance(() => {
    beginProvenanceCompile(reg);
    assert.equal(scopedProvenance(), true);
    const validator = certificateValidator(index, reg), program = {...prime, reg};
    validator.round(program);
    assert.equal(validator.entry(key, candidate.root, value, namespace), true);
    const before = provenanceGraph(reg).unknownVersion;
    if (kind === "named") reg.getObject("CLAS", "ZNEW_GLOBAL_MISS");
    if (kind === "semantic") semanticQuery(reg, "function-module-owner", ["ZNEW_GLOBAL"], []);
    if (kind === "scan") [...reg.getObjects()];
    if (kind === "enumeration") enumerateObjects(reg, "test-global-enumeration", [], "artifact");
    const trace = provenanceGraph(reg);
    assert.ok(trace.unknownVersion > before);
    validator.round(program);
    assert.equal(validator.entry(key, candidate.root, value, namespace), false);
    assert.ok([...trace.global.queries.values()].some((q) => q.kind === "unknown-scan"));
  }, {expose:false, cacheDir:options.cacheDir});
  assert.equal(readRecordingPlan(options.cacheDir).fullOnly, true);
  recordProvenance(() => {
    beginProvenanceCompile(reg);
    assert.equal(scopedProvenance(), false);
  }, {expose:false, cacheDir:options.cacheDir});
}));

test("retained closure rounds preserve provider syntax when local discovery is refreshed", () => fixture(({put, options}) => {
  const run = (extra = {}) => compileClosedProgram({...options, objects: ["ZREADER"], includeTests: true, ...extra});
  put("ZBASE", "rv = zother=>run( ).");
  run(); put("ZBASE", "rv = zother=>run( ) + 17.");
  const edited = run(), cold = run({cacheDir: undefined});
  assert.deepEqual(compareArtifacts(artifactsOf(edited), artifactsOf(cold)), {equal: true});
  for (const owner of ["CLAS ZBASE", "CLAS ZREADER"]) {
    const rows = [...provenanceGraph(edited.reg).artifacts.get(owner).queries.values()];
    assert.ok(rows.some((q) => q.phase === "syntax"), `${owner}: retained syntax observations disappeared`);
  }
}));

test("successful stateless DDIC typing remains trusted without a parsedType field", () => fixture(({dir, put, build, options}) => {
  const corpus = syntheticCorpus({classes:4});
  for (const [name, raw] of Object.entries(corpus.files)) if (name.endsWith(".doma.xml") || name.endsWith(".dtel.xml"))
    writeFileSync(join(dir, name), raw);
  writeFileSync(join(dir, "zother.clas.abap"), source("ZOTHER", "rv = 3.").replace("TYPE i.", "TYPE zoracle_num."));
  const p = build(), saved = readRecordingPlan(options.cacheDir);
  assert.equal(saved.nodes["DOMA ZORACLE_NUM"].trusted, true);
  put("ZBASE", "rv = 7.");
  const edited = build(); equalCold(edited, build);
  assert.equal(recordingPlan(p.reg, saved, toolIdentity(true)).refresh.has("DOMA ZORACLE_NUM"), false);
}));

test("idle scoped validation preserves unknown markers from audited provider builds", () => fixture(({dir, build, options}) => {
  build();
  const saved = readRecordingPlan(options.cacheDir), reg = new core.Registry(new core.Config(saved.inputs.config));
  for (const name of readdirSync(dir).filter((n) => n.endsWith(".abap"))) reg.addFile(new core.MemoryFile(name, readFileSync(join(dir, name), "utf8")));
  recordProvenance(() => {
    beginProvenanceCompile(reg); parseObserved(reg);
    assert.equal(scopedProvenance(), true);
    const obj = withRole("scheduling", () => reg.getObject("CLAS", "ZBASE"));
    auditedBookkeeping("test-idle-build", () => new core.SyntaxLogic(reg, obj).run());
    assert.equal(auditBuiltArtifacts(reg), true);
    assert.ok([...provenanceGraph(reg).artifacts.get("CLAS ZBASE").queries.values()].some((q) => q.kind === "unknown-scan" && q.args[0] === "untraced-artifact"));
  }, {expose:false, cacheDir:options.cacheDir});
  assert.equal(readRecordingPlan(options.cacheDir).nodes["CLAS ZBASE"].trusted, false);
}));

test("unrecorded inventory growth requires full recording", () => fixture(({options}) => {
  let p;
  recordProvenance(() => {
    p = compileProgram({...options, includeTests:true});
    // Model an input synthesized after the recorder's last inventory boundary.
    p.reg.addFile(new core.MemoryFile("zlate.clas.abap", source("ZLATE", "rv = 0.")));
    finishInputs(p.reg);
  }, {expose:false, cacheDir:options.cacheDir});
  const saved = readRecordingPlan(options.cacheDir);
  assert.equal(saved.fullOnly, true, "unrecorded inventory changes require full observation");
  recordProvenance(() => {
    beginProvenanceCompile(p.reg);
    assert.equal(scopedProvenance(), false, "a changed observation scope must restore full recording");
  }, {expose:false, cacheDir:options.cacheDir});
}));

test("discarding retained provider rows marks the prebuilt artifact incomplete", () => fixture(({build, options}) => {
  const p = build({includeTests:true}), saved = readRecordingPlan(options.cacheDir);
  p.reg.setConfig(new core.Config(saved.inputs.config));
  recordProvenance(() => {
    beginProvenanceCompile(p.reg);
    assert.equal(scopedProvenance(), true);
    const rows = [...provenanceGraph(p.reg).artifacts.get("CLAS ZBASE").queries.values()];
    assert.ok(rows.some((q) => q.kind === "unknown-scan" && q.args[0] === "provider-built-before-scope-refresh"));
  }, {expose:false, cacheDir:options.cacheDir});
}));

for (const fault of ["reverse", "global"]) test(`recording plan with ${fault} damage restores full observation`, () => fixture(({dir, put, build, options}) => {
  build();
  const plan = readRecordingPlan(options.cacheDir);
  if (fault === "reverse") plan.reverse["CLAS ZBASE"] = [];
  else plan.fullOnly = true;
  writeRecordingPlan(options.cacheDir, plan);
  const diagnostic = join(dir, "diagnostics.ndjson"), previous = process.env.GOGEN_CACHE_DIAGNOSTICS;
  try {
    process.env.GOGEN_CACHE_DIAGNOSTICS = diagnostic;
    put("ZBASE", "rv = 6.");
    const p = build(); equalCold(p, build);
    const scopes = readFileSync(diagnostic, "utf8").trim().split("\n").map(JSON.parse).filter((r) => r.event === "recording-scope");
    assert.ok(scopes.some((r) => r.mode === "full"), JSON.stringify(scopes));
  } finally {
    if (previous === undefined) delete process.env.GOGEN_CACHE_DIAGNOSTICS;
    else process.env.GOGEN_CACHE_DIAGNOSTICS = previous;
  }
}));

test("compact proofs reuse an unrelated root through multi-edits/revert; affected roots use full validation", () => fixture(({put, build}) => {
  build();
  for (const literal of [9, 5, 1]) {
    put("ZBASE", `rv = ${literal}.`);
    const p = build(); equalCold(p, build);
    if (literal !== 1) {
      const other = p.frontendCounts.shadowV3.entries.find((r) => r.name === "ZOTHER");
      assert.equal(other.certificate, true, JSON.stringify(other));
      assert.deepEqual(p.frontendCounts.loweredClasses, ["ZBASE", "ZREADER"]);
    }
  }
}));

for (const corruption of ["reverse edge", "query coverage", "owner"]) test(`checksummed compact index with corrupt ${corruption} falls back to the full graph`, () => fixture(({dir, put, build}) => {
  build();
  const namespaces = join(dir, "cache/v3");
  for (const ns of readdirSync(namespaces)) for (const name of readdirSync(join(namespaces, ns))) {
    if (!name.endsWith(".certificates")) continue;
    const file = join(namespaces, ns, name), index = deserialize(inflateRawSync(readFileSync(file).subarray(65)));
    if (corruption === "reverse edge") index.reverse["CLAS ZBASE"] = [];
    if (corruption === "query coverage") index.queries[0].coverage = "CORRUPT";
    if (corruption === "owner") index.nodes["CLAS ZBASE"].owner = "CLAS ZOTHER";
    const payload = deflateRawSync(serialize(index));
    writeFileSync(file, Buffer.concat([Buffer.from(createHash("sha256").update(payload).digest("hex") + "\n"), payload]));
  }
  put("ZBASE", "rv = 8.");
  const p = build(); equalCold(p, build);
  assert.deepEqual(p.frontendCounts.loweredClasses, ["ZBASE", "ZREADER"]);
  assert.ok(p.frontendCounts.shadowV3.entries.every((r) => !r.certificate));
}));

test("a changed member invalidates its entire SCC while an unrelated component keeps its proof", () => fixture(({put, build}) => {
  put("ZBASE", "rv = zreader=>run( ).");
  build();
  put("ZBASE", "rv = zreader=>run( ) + 1.");
  const p = build(); equalCold(p, build);
  assert.deepEqual(p.frontendCounts.loweredClasses, ["ZBASE", "ZREADER"]);
  assert.equal(p.frontendCounts.shadowV3.entries.find((r) => r.name === "ZOTHER").certificate, true);
}));

test("an added inventory owner disables compact proofs for every entry", () => fixture(({put, build}) => {
  build(); put("ZADDED", "rv = 7.");
  const p = build(); equalCold(p, build);
  assert.ok(p.frontendCounts.shadowV3.entries.every((r) => !r.certificate));
}));

test("closed-program rounds retain immutable validation while rebuilding the selected program", () => fixture(({put, options}) => {
  put("ZOTHER", "rv = zreader=>run( ).");
  const run = (extra = {}) => compileClosedProgram({...options, objects: ["ZOTHER"], ...extra});
  const cold = run();
  const global = [...provenanceGraph(cold.reg).global.queries.values()];
  assert.ok(!global.some((q) => q.kind === "getObject" && q.args[0] === "CLAS"
    && ["ZBASE", "ZOTHER", "ZREADER"].includes(q.args[1])), "closure discovery must not become global artifact dependencies");
  put("ZBASE", "rv = 19.");
  const edited = run(), oracle = run({cacheDir: undefined});
  assert.deepEqual(compareArtifacts(artifactsOf(edited), artifactsOf(oracle)), {equal: true});
  assert.notEqual(artifactsOf(cold).artifacts.emitGo, artifactsOf(edited).artifacts.emitGo);
  assert.deepEqual([...edited.wanted], [...oracle.wanted]);
}));

test("unknown query contracts have no certificate invalidation coverage", () => {
  for (const q of [{kind: "unknown-scan"}, ...["supplied", "locals", "ownershipSafety", "getObject", "function-module-owner"]
    .map((kind) => ({kind, policy: "uncovered"})), {kind: "new-query"}])
    assert.equal(queryCoverage({role: "artifact", args: [], result: [], ...q}), null);
  assert.equal(queryCoverage({role: "artifact", kind: "supplied", policy: "selected-contributions", args: [], result: []}), "round");
  assert.equal(queryCoverage({role: "artifact", kind: "locals", policy: "ordered-qualified-definitions", args: ["ZLOCAL", true], result: []}), "round");
  assert.deepEqual(queryCoverage({role: "artifact", kind: "function-module-owner", args: [], result: []}), ["type:FUGR", "type:PROG"]);
});

test("pure RTTI reporting projections run only for explicit public reports", () => {
  for (const expose of [false, true]) {
    const reg = new core.Registry(), obj = {getName: () => "ZREPORT", getType: () => "CLAS"};
    let calls = 0;
    recordProvenance(() => rttiProjection(reg, obj, () => { calls++; return [["ZREPORT"], []]; }), {expose});
    assert.equal(calls, Number(expose));
    assert.equal(compilationProvenanceOf(reg).finalOutput.some((q) => q.kind === "rtti-owner"), expose);
  }
});

test("inherited observations retain current unknown markers at every round", () => {
  const reg = new core.Registry(); reg.addFile(new core.MemoryFile("zmemo.clas.abap", source("ZMEMO", "rv = 1.")));
  const obj = reg.getObject("CLAS", "ZMEMO"), epochs = [];
  const stored = {rows: [{role: "artifact", artifact: "CLAS ZMEMO", phase: "lowering", kind: "getObject", args: ["CLAS", "ZMISSING"], result: []},
    {role: "artifact", artifact: "CLAS ZMEMO", phase: "lowering", kind: "unknown-scan", args: ["saved-gap"], result: []}], edges: []};
  recordProvenance(() => {
    for (const round of [1, 2]) {
      beginProvenanceCompile(reg);
      withArtifact({reg}, obj, () => {
        if (round === 2) semanticQuery(reg, "unknown-scan", ["current-gap"], []);
        inheritStoredProvenance(reg, obj, stored);
      });
      epochs.push(provenanceGraph(reg).unknownVersion);
    }
  }, {expose: false});
  const rows = [...provenanceGraph(reg).lowerings.get("CLAS ZMEMO").queries.values()];
  assert.deepEqual(rows.filter((q) => q.kind === "unknown-scan").map((q) => q.args[0]).sort(), ["current-gap", "saved-gap"]);
  assert.equal(epochs[1] - epochs[0], 2, "both current and inherited gaps advance the refusal epoch");
});

test("mutable inherited observations keep their ordinary round validation", () => {
  const reg = new core.Registry(); reg.addFile(new core.MemoryFile("zmemo.clas.abap", source("ZMEMO", "rv = 1.")));
  const obj = reg.getObject("CLAS", "ZMEMO"), result = [];
  const stored = {rows: [{role: "artifact", artifact: "CLAS ZMEMO", phase: "lowering", kind: "getObject", args: ["CLAS", "ZPROVIDER"], result}], edges: []};
  recordProvenance(() => {
    beginProvenanceCompile(reg); withArtifact({reg}, obj, () => inheritStoredProvenance(reg, obj, stored));
    result.push("CLAS ZPROVIDER");
    beginProvenanceCompile(reg); withArtifact({reg}, obj, () => {
      inheritStoredProvenance(reg, obj, stored);
      semanticQuery(reg, "getObject", ["CLAS", "ZPROVIDER"], []);
    });
  }, {expose: false});
  assert.deepEqual([...provenanceGraph(reg).lowerings.get("CLAS ZMEMO").queries.values()].filter((q) => q.kind === "getObject").map((q) => q.result), [result, []]);
});

test("selection membership indexes registered frozen arrays and preserves mutable reads", () => {
  const mutable = ["a", "b"]; assert.equal(selectionHas(mutable, "a"), true);
  mutable[0] = "c"; assert.equal(selectionHas(mutable, "a"), false); assert.equal(selectionHas(mutable, "c"), true);
  const frozen = Object.freeze(["b", "a", "b"]);
  indexFrozenSelection(frozen);
  for (const name of ["a", "b", "c", "A"]) assert.equal(selectionHas(frozen, name), frozen.includes(name));
  assert.deepEqual(frozen, ["b", "a", "b"]);
});

test("NEGATIVE: dropping a reverse edge after integrity checks is caught by the fresh-process cold oracle", {timeout: 60_000}, () => {
  const mutation = syntheticCorpus({classes: 4}).mutations.find((m) => m.kind === "class-constant");
  const result = runOracle({classes: 4, seed: 719, scenarios: [{name: "certificate-reverse-fault", steps: [mutation]}],
    // This control tests the outer byte oracle; the inner checker is covered
    // separately below so CI cannot intercept the fault before comparison.
    env: {...process.env, GOGEN_CACHE_SHADOW_VALIDATE: "", GOGEN_CACHE_ORACLE_DEPENDENCY: "1", GOGEN_CACHE_CERTIFICATE_FAULT: "drop-reverse:CLAS ZCL_DEFAULTS"}});
  assert.equal(result.mismatches, 2, "stale constant readers must differ in both line modes");
  assert.ok(result.rows.every((r) => r.artifact === "emitGo"));
});

test("NEGATIVE: the inner shadow validator also catches a dropped reverse edge", {timeout: 60_000}, () => {
  const mutation = syntheticCorpus({classes: 4}).mutations.find((m) => m.kind === "class-constant");
  assert.throws(() => runOracle({classes: 4, seed: 719, scenarios: [{name: "certificate-reverse-shadow", steps: [mutation]}],
    env: {...process.env, GOGEN_CACHE_SHADOW_VALIDATE: "1", GOGEN_CACHE_ORACLE_DEPENDENCY: "1", GOGEN_CACHE_CERTIFICATE_FAULT: "drop-reverse:CLAS ZCL_DEFAULTS"}}),
  /SHADOW V3 DISAGREEMENT: ZCL_CONSTANT_READER/);
});
