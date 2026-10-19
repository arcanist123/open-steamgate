import {parseObserved} from "./frontend-inventory.mjs";
import {projectionAnswer} from "./frontend-query-contract.mjs";
import {caughtIndex, chainHas, currentCaughtAnswer} from "./frontend-hierarchy.mjs";
import {copyReplayProgram} from "./frontend-replay.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {compileProgram} from "./frontend.mjs";
import {classSource, syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {compareArtifacts, artifactsOf} from "./cache-oracle-capture.mjs";
import {provenanceOf, provenanceGraph, beginProvenanceCompile, recordProvenance, withArtifact, semanticQuery} from "./frontend-provenance.mjs";
import {core} from "./frontend-inventory.mjs";
import {keyComputer, sealDependencyGraph, hashV3} from "./frontend-v3-key.mjs";

function scratch(run) {
  const dir = mkdtempSync(join(tmpdir(), "gogen-v3-"));
  const previous = process.env.GOGEN_CACHE_SHADOW_VALIDATE;
  process.env.GOGEN_CACHE_SHADOW_VALIDATE = "1";
  try { return run(dir); }
  finally {
    if (previous === undefined) delete process.env.GOGEN_CACHE_SHADOW_VALIDATE;
    else process.env.GOGEN_CACHE_SHADOW_VALIDATE = previous;
    rmSync(dir, {recursive: true, force: true});
  }
}
const put = (dir, files) => { for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name), raw); };
const build = (dir, objects, extra = {}) => compileProgram({folders: [dir], objects, cacheDir: join(dir, "cache"), tolerant: true, ...extra});
const report = (p) => p.frontendCounts.shadowV3;
const row = (p, name) => report(p).entries.find((e) => e.name === name);
const reuse = (p) => report(p).entries.filter((e) => e.wouldReuseV3).length;

test("the CATCH index preserves the twenty-member walk, cycles and local names", () => {
  const parents = new Map(Array.from({length: 22}, (_, i) => [`C${i}`, `C${i + 1}`]));
  parents.set("A", "B"); parents.set("B", "A"); parents.set("OWNER:LOCAL", "C19");
  const wanted = new Set(["C0", "A", "OWNER:LOCAL"]), reg = {}, owner = {};
  const step = (name) => parents.get(name), index = caughtIndex(reg, wanted, step);
  for (const ancestor of ["C0", "C19", "C20", "C21", "A", "B", "OWNER:LOCAL"])
    assert.equal(index.get(JSON.stringify([ancestor])), [...wanted].some((name) => chainHas(owner, reg, name, ancestor, step)));
  for (const method of ["set", "delete", "clear"]) assert.equal(method in index, false, `the caught index has no ${method}`);
  assert.equal(copyReplayProgram({caught: index}).caught, index, "isolated replay shares the immutable derived index");
});

test("CATCH dependency replay ignores unrelated bodies but observes changed and newly selected subclasses", () => scratch((dir) => {
  const cx = (name, parent) => `CLASS ${name} DEFINITION PUBLIC INHERITING FROM ${parent}. ENDCLASS. CLASS ${name} IMPLEMENTATION. ENDCLASS.`;
  put(dir, {"zcx_base.clas.abap": cx("zcx_base", "cx_static_check"),
    "zcx_other.clas.abap": cx("zcx_other", "cx_static_check"),
    "zcx_hidden.clas.abap": cx("zcx_hidden", "zcx_base"),
    "zreader.clas.abap": classSource("ZREADER", "TRY. rv = 1. CATCH zcx_base. rv = 2. ENDTRY."),
    "zunrelated.clas.abap": classSource("ZUNRELATED", "rv = 3.")});
  const names = ["ZCX_OTHER", "ZCX_HIDDEN", "ZREADER", "ZUNRELATED", "CX_ROOT", "CX_STATIC_CHECK"];
  const options = {folders: [dir, join(libraryPath(process.cwd(), "open-abap-core"), "src")], objects: names,
    cacheDir: join(dir, "cache"), dependencyCache: true, provenance: false, tolerant: true};
  const run = (extra = {}) => compileProgram({...options, ...extra});
  run();
  put(dir, {"zunrelated.clas.abap": classSource("ZUNRELATED", "rv = 9.")});
  const isolated = run();
  assert.ok(isolated.frontendCounts.reusedClasses.includes("ZREADER"), JSON.stringify(row(isolated, "ZREADER")));
  assert.equal(compareArtifacts(artifactsOf(isolated), artifactsOf(run({cacheDir: undefined}))).equal, true);
  put(dir, {"zcx_hidden.clas.abap": cx("zcx_hidden", "zcx_other")});
  const hierarchy = run();
  assert.ok(hierarchy.frontendCounts.loweredClasses.includes("ZREADER"));
  assert.equal(compareArtifacts(artifactsOf(hierarchy), artifactsOf(run({cacheDir: undefined}))).equal, true);
  const additionCache = join(dir, "addition-cache"); run({cacheDir: additionCache});
  put(dir, {"zcx_added.clas.abap": cx("zcx_added", "zcx_base")});
  const added = {objects: [...names, "ZCX_ADDED"], cacheDir: additionCache}, selected = run(added);
  assert.ok(selected.frontendCounts.loweredClasses.includes("ZREADER"));
  assert.equal(compareArtifacts(artifactsOf(selected), artifactsOf(run({...added, cacheDir: undefined}))).equal, true);
}));

test("a later unknown hierarchy observation makes the CATCH projection incomplete", () => recordProvenance(() => {
  const config = core.Config.getDefault().get(); config.rules = {check_syntax: true, parser_error: true};
  const reg = new core.Registry(new core.Config(JSON.stringify(config)));
  for (const name of ["ZCL_A", "ZCL_B"]) reg.addFile(new core.MemoryFile(`${name.toLowerCase()}.clas.abap`, classSource(name)));
  reg.parse(); reg.findIssues();
  const index = caughtIndex(reg, new Set(["ZCL_A", "ZCL_B"]), () => undefined);
  assert.equal(currentCaughtAnswer(index, ["ZCL_A"]).complete, true);
  withArtifact({reg}, reg.getObject("CLAS", "ZCL_B"), () => semanticQuery(reg, "unknown-scan", ["hierarchy-test"], []), "artifact-read");
  assert.equal(currentCaughtAnswer(index, ["ZCL_A"]).complete, false);
  index.get(JSON.stringify(["ZCL_A"]));
  assert.ok([...provenanceOf(reg).values()].some((manifest) => manifest.hits.some((q) => q.kind === "caught" && q.complete === false)));
}));

test("300-class shadow predictions: ten-class closure, isolated edit, unrelated addition; production stays global", () => scratch((dir) => {
  const names = Array.from({length: 300}, (_, i) => `ZC${String(i).padStart(4, "0")}`);
  const files = Object.fromEntries(names.map((n, i) => [`${n.toLowerCase()}.clas.abap`, classSource(n,
    i > 0 && i < 10 ? `rv = ${names[i - 1]}=>run( ).` : "rv = 1.")]));
  put(dir, files);
  const cold = build(dir, names);
  assert.equal(report(cold).entries.filter((e) => e.currentComplete).length, 300);
  assert.equal(provenanceOf(cold).size, 0, "internal recording does not expose expanded manifests");
  const warm = build(dir, names);
  assert.equal(reuse(warm), 300); assert.equal(report(warm).validated, 300);
  assert.equal(warm.frontendCounts.lowered, 0);
  writeFileSync(join(dir, "zc0000.clas.abap"), classSource(names[0], "rv = 9."));
  const chain = build(dir, names);
  assert.equal(reuse(chain), 290);
  assert.deepEqual(report(chain).entries.filter((e) => !e.wouldReuseV3).map((e) => e.name), names.slice(0, 10));
  assert.equal(chain.frontendCounts.lowered, 300, "production lookup still uses the global version");
  assert.equal(report(chain).entries.filter((e) => e.actuallyLowered).length, 300);
  assert.equal(compareArtifacts(artifactsOf(chain), artifactsOf(build(dir, names, {cacheDir: undefined}))).equal, true);
  writeFileSync(join(dir, "zc0250.clas.abap"), classSource(names[250], "rv = 7."));
  const isolated = build(dir, names);
  assert.equal(reuse(isolated), 299, JSON.stringify(report(isolated).entries.filter((e) => !e.wouldReuseV3))); assert.equal(row(isolated, names[250]).wouldReuseV3, false);
  put(dir, {"zunrelated.clas.abap": classSource("ZUNRELATED")});
  const added = build(dir, [...names, "ZUNRELATED"]);
  assert.equal(reuse(added), 300); assert.equal(row(added, "ZUNRELATED").wouldReuseV3, false);
}));

test("new selected IS SUPPLIED redefinition changes the saved query answer", () => scratch((dir) => {
  put(dir, {
    "zbase.clas.abap": "CLASS zbase DEFINITION PUBLIC. PUBLIC SECTION. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDCLASS. CLASS zbase IMPLEMENTATION. METHOD work. r = iv. ENDMETHOD. ENDCLASS.",
    "zreader.clas.abap": classSource("ZREADER", "DATA obj TYPE REF TO zbase. CREATE OBJECT obj. rv = obj->work( )."),
  });
  build(dir, ["ZBASE", "ZREADER"]);
  assert.equal(row(build(dir, ["ZBASE", "ZREADER"]), "ZREADER").wouldReuseV3, true);
  put(dir, {"zchild.clas.abap": "CLASS zchild DEFINITION PUBLIC INHERITING FROM zbase. PUBLIC SECTION. METHODS work REDEFINITION. ENDCLASS. CLASS zchild IMPLEMENTATION. METHOD work. IF iv IS SUPPLIED. r = iv. ENDIF. ENDMETHOD. ENDCLASS."});
  const changed = build(dir, ["ZBASE", "ZCHILD", "ZREADER"]);
  assert.equal(row(changed, "ZREADER").wouldReuseV3, false);
  assert.match(row(changed, "ZREADER").reason, /query:supplied/);
}));

test("new interface implementor changes the saved contribution query", () => scratch((dir) => {
  const intf = "INTERFACE zif_supply PUBLIC. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(r) TYPE i. ENDINTERFACE.";
  const impl = (name, body) => `CLASS ${name} DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_supply. ENDCLASS. CLASS ${name} IMPLEMENTATION. METHOD zif_supply~work. ${body} ENDMETHOD. ENDCLASS.`;
  put(dir, {"zif_supply.intf.abap": intf, "zimpl.clas.abap": impl("zimpl", "r = iv."),
    "zreader.clas.abap": classSource("ZREADER", "DATA obj TYPE REF TO zif_supply. CREATE OBJECT obj TYPE zimpl. rv = obj->work( ).")});
  const names = ["ZIMPL", "ZREADER"];
  build(dir, names); assert.equal(row(build(dir, names), "ZREADER").wouldReuseV3, true);
  put(dir, {"zimpl2.clas.abap": impl("zimpl2", "IF iv IS SUPPLIED. r = iv. ENDIF.")});
  const changed = build(dir, [...names, "ZIMPL2"]);
  assert.equal(row(changed, "ZREADER").wouldReuseV3, false);
  assert.match(row(changed, "ZREADER").reason, /query:supplied/);
}));

test("new ENQU changes a saved named lock miss", () => scratch((dir) => {
  const c = syntheticCorpus({classes: 4});
  put(dir, Object.fromEntries(Object.entries(c.files).filter(([n]) => /\.(tabl|dtel|doma)\.xml$/.test(n))));
  put(dir, {"zlocker.clas.abap": classSource("ZLOCKER", "CALL FUNCTION 'ENQUEUE_EZLOCK'. rv = 1.")});
  build(dir, ["ZLOCKER"]);
  assert.equal(row(build(dir, ["ZLOCKER"]), "ZLOCKER").wouldReuseV3, true);
  put(dir, {"ezlock.enqu.xml": '<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values><DD25V><VIEWNAME>EZLOCK</VIEWNAME><ROOTTAB>ZORACLE_TAB</ROOTTAB></DD25V></asx:values></asx:abap></abapGit>'});
  const changed = build(dir, ["ZLOCKER"]);
  assert.equal(row(changed, "ZLOCKER").wouldReuseV3, false);
  assert.match(row(changed, "ZLOCKER").reason, /query:lock/);
}));

test("candidate index is bounded and corrupt payloads fail closed", () => scratch((dir) => {
  for (let i = 0; i < 7; i++) {
    put(dir, {"z.clas.abap": classSource("Z", `rv = ${i}.`)}); build(dir, ["Z"]);
  }
  const indexes = readdirSync(join(dir, "cache/v3"), {recursive: true}).filter((f) => f.endsWith("index.json"));
  assert.equal(indexes.length, 1);
  const indexPath = join(dir, "cache/v3", indexes[0]), keys = JSON.parse(readFileSync(indexPath, "utf8"));
  assert.equal(keys.length, 4);
  for (const key of keys) writeFileSync(join(indexPath, "..", `${key}.bin`), "corrupt");
  const p = build(dir, ["Z"]);
  assert.equal(row(p, "Z").wouldReuseV3, false); assert.equal(row(p, "Z").reason, "corrupt-candidate");
}));

test("explicit recording opt-out stays global only", () => scratch((dir) => {
  put(dir, {"z.clas.abap": classSource("Z")});
  const p = build(dir, ["Z"], {provenance: false});
  assert.equal(report(p), undefined);
  assert.ok(!readdirSync(join(dir, "cache")).includes("v3"));
}));

test("a stored complete candidate refuses a current unknown observation", () => scratch((dir) => {
  put(dir, {"z.clas.abap": classSource("Z")});
  build(dir, ["Z"]); assert.equal(reuse(build(dir, ["Z"])), 1);
  const p = recordProvenance(() => {
    // Match the folder compiler's config exactly, so this tests completeness
    // rather than a config/namespace miss.
    const config = core.Config.getDefault().get();
    config.syntax = {...config.syntax, version: "v758", errorNamespace: "."};
    config.rules = {check_syntax: true, parser_error: true};
    const reg = new core.Registry(new core.Config(JSON.stringify(config)));
    reg.addFile(new core.MemoryFile("z.clas.abap", classSource("Z"))); parseObserved(reg);
    [...reg.getObjects()]; // Deliberately unaudited caller observation.
    return build(dir, ["Z"], {registry: reg});
  });
  assert.equal(row(p, "Z").wouldReuseV3, false);
  assert.match(row(p, "Z").reason, /current-unknown-scan/);
}));

test("completeness is recomputed: every dependency/raw hash and unknown marker matters; non-artifact roles do not", () => {
  const reg = new core.Registry(); reg.addFile(new core.MemoryFile("z.clas.abap", classSource("Z"))); parseObserved(reg);
  const program = {reg, supplied: new Map(), lockObjects: new Map()}, value = {name: "Z", replay: {ops: []}};
  const node = {owner: "CLAS Z", digest: "owner-digest", dependencies: [], rows: []};
  const graph = {nodes: {"CLAS Z": node}};
  const compute = keyComputer(reg, "namespace", program), baseline = compute(graph, "CLAS Z", value);
  assert.equal(baseline.complete, true);
  for (const role of ["scheduling", "final-output"]) {
    node.rows.push({role, kind: "test-inventory", args: [], result: ["UNRELATED"]});
    assert.equal(compute(graph, "CLAS Z", value).key, baseline.key); node.rows.pop();
  }
  graph.nodes["INTF ZDEP"] = {owner: "INTF ZDEP", digest: null, dependencies: [], rows: []};
  node.dependencies.push("INTF ZDEP");
  assert.match(compute(graph, "CLAS Z", value).reason, /missing-digest:INTF ZDEP/); node.dependencies.pop();
  for (const marker of ["unknown", "untraced-artifact", "artifact-built-before-recording", "lowering-built-before-recording", "retained-registry-edit", "retained-registry-config-edit"]) {
    node.rows.push({role: "artifact", kind: "unknown-scan", args: [marker], result: []});
    assert.equal(compute(graph, "CLAS Z", value).complete, false, marker); node.rows.pop();
  }
  node.rows.push({role: "artifact", kind: "getFileByName", args: ["z.clas.abap"], result: ["z.clas.abap"]});
  assert.match(compute(graph, "CLAS Z", value).reason, /missing-raw-hash/);
});


test("component keys ignore traversal numbering and guard every member of a dependency cycle", () => {
  const reg = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
  const program = {reg, supplied: new Map()}, value = {name: "A", replay: {ops: []}};
  const node = (owner, digest, dependencies = []) => ({owner, digest, dependencies, rows: []});
  const nodes = {"CLAS A": node("CLAS A", "a", ["CLAS B"]), "CLAS B": node("CLAS B", "b", ["CLAS A"]),
    "CLAS OTHER": node("CLAS OTHER", "other")};
  const compute = keyComputer(reg, "components-test", program);
  const before = compute({nodes}, "CLAS A", value);
  const reordered = compute({nodes: Object.fromEntries(Object.entries(nodes).reverse())}, "CLAS A", value);
  assert.equal(before.complete, true); assert.equal(reordered.key, before.key);
  const changed = {nodes: {...nodes, "CLAS B": node("CLAS B", "changed", ["CLAS A"])}};
  assert.notEqual(compute(changed, "CLAS A", value).key, before.key);
  const other = compute({nodes}, "CLAS OTHER", {...value, name: "OTHER"});
  assert.equal(compute(changed, "CLAS OTHER", {...value, name: "OTHER"}).key, other.key);
});

test("thousands of consumers share a cyclic certificate instead of rewalking global inventories", () => {
  const reg = {getObjects: () => [], getConfig: () => ({get: () => ({})})};
  const count = 3000, nodes = {}, roots = [];
  const globalRows = Array.from({length: count}, (_, i) => ({role: "final-output", kind: "test-inventory", args: [], result: [String(i)]}));
  for (let i = 0; i < count; i++) {
    const owner = `CLAS K${i}`, root = `lowering:${owner}`; roots.push(root);
    nodes[owner] = {owner, digest: `digest-${i}`, dependencies: [`CLAS K${(i + 1) % count}`], rows: globalRows};
    nodes[root] = {owner, digest: `digest-${i}`, dependencies: [owner], rows: globalRows};
  }
  const graph = sealDependencyGraph({nodes}), compute = keyComputer(reg, "large-components", {reg, supplied: new Map()});
  const started = performance.now(), keys = new Set();
  for (const root of roots) {
    const result = compute(graph, root, {name: root, replay: {ops: []}});
    assert.equal(result.complete, true); keys.add(result.key);
  }
  assert.equal(keys.size, count);
  assert.ok(performance.now() - started < 10000, "shared closure hashing must not revisit every inventory per consumer");
});


test("supplied projection certificates observe mutable data and ignore contributor ordering", () => {
  const providers = ["CLAS B", "CLAS A"], answer = {providers, result: providers, parameters: ["IV"]};
  const before = hashV3(projectionAnswer(answer));
  assert.equal(hashV3(projectionAnswer({...answer, providers: [...providers].reverse(), result: [...providers].reverse()})), before);
  providers[0] = "CLAS CHANGED";
  assert.notEqual(hashV3(projectionAnswer(answer)), before);
  const nested = {value: 1}, shallow = Object.freeze([nested]);
  const old = hashV3(projectionAnswer({result: shallow})); nested.value = 2;
  assert.notEqual(hashV3(projectionAnswer({result: shallow})), old);
});

test("an implementation body edit does not invalidate every reader of an interface's supplied projection", () => scratch((dir) => {
  put(dir, {"zif_work.intf.abap": "INTERFACE zif_work PUBLIC. METHODS work IMPORTING iv TYPE i OPTIONAL RETURNING VALUE(rv) TYPE i. ENDINTERFACE.",
    "zreader.clas.abap": "CLASS zreader DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS run IMPORTING obj TYPE REF TO zif_work RETURNING VALUE(rv) TYPE i. ENDCLASS. CLASS zreader IMPLEMENTATION. METHOD run. rv = obj->work( ). ENDMETHOD. ENDCLASS."});
  const implementation = (body) => `CLASS zprovider DEFINITION PUBLIC. PUBLIC SECTION. INTERFACES zif_work. ENDCLASS. CLASS zprovider IMPLEMENTATION. METHOD zif_work~work. ${body} ENDMETHOD. ENDCLASS.`;
  const names = ["ZREADER"];
  for (let i = 0; i < 32; i++) {
    const name = `ZP${String(i).padStart(2, "0")}`; names.push(name);
    put(dir, {[`${name.toLowerCase()}.clas.abap`]: implementation("rv = 1.").replaceAll("zprovider", name.toLowerCase())});
  }
  const options = {dependencyCache: true, provenance: false};
  build(dir, names, options);
  assert.equal(build(dir, names, options).frontendCounts.lowered, 0);
  put(dir, {"zp00.clas.abap": implementation("rv = 2.").replaceAll("zprovider", "zp00")});
  const edited = build(dir, names, options);
  assert.deepEqual(edited.frontendCounts.loweredClasses, ["ZP00"]);
  assert.equal(compareArtifacts(artifactsOf(edited), artifactsOf(build(dir, names, {cacheDir: undefined}))).equal, true);
  put(dir, {"zp00.clas.abap": implementation("IF iv IS SUPPLIED. rv = iv. ELSE. rv = 2. ENDIF.").replaceAll("zprovider", "zp00")});
  const supplied = build(dir, names, options);
  assert.ok(supplied.frontendCounts.loweredClasses.includes("ZREADER"));
  assert.equal(compareArtifacts(artifactsOf(supplied), artifactsOf(build(dir, names, {cacheDir: undefined}))).equal, true);
}));

for (const global of [false, true]) test(`key computer refreshes replaced ${global ? "global" : "artifact"} provenance maps between rounds`, () => {
  const reg = new core.Registry(); reg.addFile(new core.MemoryFile("z.clas.abap", classSource("Z")));
  const program = {reg, supplied: new Map()}, value = {name: "Z", replay: {ops: []}};
  const graph = sealDependencyGraph({nodes: {"CLAS Z": {owner: "CLAS Z", digest: "saved", dependencies: [], rows: []}}});
  let compute, before;
  recordProvenance(() => {
    beginProvenanceCompile(reg); parseObserved(reg);
    compute = keyComputer(reg, "round-map-replacement", program); before = provenanceGraph(reg);
    assert.equal(compute(graph, "CLAS Z", value, {current:true}).complete, true);
  });
  // Internal recording copies exposed state, replacing both provenance maps.
  recordProvenance(() => {
    beginProvenanceCompile(reg);
    const after = provenanceGraph(reg);
    assert.notEqual(after.global, before.global); assert.notEqual(after.artifacts, before.artifacts);
    if (global) semanticQuery(reg, "unknown-scan", ["new-round-global"], []);
    else withArtifact({reg}, reg.getObject("CLAS", "Z"), () =>
      semanticQuery(reg, "unknown-scan", ["new-round-provider"], []), "syntax");
    compute.round({...program});
    const result = compute(graph, "CLAS Z", value, {current:true});
    assert.equal(result.complete, false); assert.match(result.reason, /current-unknown-scan/);
  }, {expose:false});
});
