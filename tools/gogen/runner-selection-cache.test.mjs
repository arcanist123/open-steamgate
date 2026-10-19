import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import ts from "typescript";
import {abaplint} from "./frontend-base.mjs";
import {discoveryProjection} from "./runner-discovery-projection.mjs";
import {syntheticCorpus} from "./cache-oracle-corpus.mjs";
import {discoveryEvidence, matchingDiscoveryEvidence} from "./runner-selection-evidence.mjs";
const source = (name, body, superclass = "") => `CLASS ${name} DEFINITION PUBLIC ${superclass ? `INHERITING FROM ${superclass}` : ""}.
PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.
CLASS ${name} IMPLEMENTATION. METHOD run. ${body} ENDMETHOD. ENDCLASS.`;
const childCode = `
import {compileClosedProgram} from ${JSON.stringify(new URL("frontend-closure.mjs", import.meta.url).href)};
import {prepareRunnerCache, finishRunnerCache} from ${JSON.stringify(new URL("runner-cache-recording.mjs", import.meta.url).href)};
import {artifactsOf} from ${JSON.stringify(new URL("cache-oracle-capture.mjs", import.meta.url).href)};
import {readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
const {input, cacheDir, objects, policy, tolerant, includeTests, forceSelection, mutateAfterPrepare, restoreAtCheck, faultModule} = JSON.parse(process.argv[1]);
const folders = [input];
const runner = prepareRunnerCache(folders, cacheDir ? {cacheDir, dependencyCache: true, provenance: false} : {}, policy);
try {
 if (faultModule) {
   process.env.GOGEN_CACHE_DIAGNOSTICS = join(cacheDir, "fault-diagnostics.ndjson");
   const {runnerSelectionCache} = await import(faultModule);
   const {readdirSync} = await import("node:fs");
   const {createHash} = await import("node:crypto");
   const {toolIdentity} = await import(${JSON.stringify(new URL("frontend-object-cache.mjs", import.meta.url).href)});
   const files = readdirSync(input).sort((a,b) => a.localeCompare(b)).map(name => ({layer: 0, name, path: join(input,name), hash: createHash("sha256").update(readFileSync(join(input,name))).digest("hex")}));
   runner.options.selectionCache = runnerSelectionCache(cacheDir, toolIdentity(), files, policy);
 }
 if (mutateAfterPrepare) {
   const file = join(input, "zentry.clas.abap"), original = readFileSync(file, "utf8");
   writeFileSync(file, mutateAfterPrepare);
   if (restoreAtCheck) {
     const check = runner.options.selectionCache.check;
     runner.options.selectionCache.check = (...args) => { writeFileSync(file, original); return check(...args); };
   }
 }
 const p = compileClosedProgram({...runner.options, folders, objects, tolerant, includeTests, ...(forceSelection ? {selectionCache: {read: () => ({selection: forceSelection, closed: forceSelection, evidence: "test-forced", rounds: []}), write() {}}} : {})});
 finishRunnerCache(runner.certificate);
 console.log(JSON.stringify({artifacts: artifactsOf(p).artifacts, wanted: [...p.wanted], rounds: p.closureRounds, evidence: p.selectionEvidence}));
} catch(e) { console.log(JSON.stringify({error: e.message})); }
`;
function capture(input, cacheDir, extra = {}, noline = false) {
  const result = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", childCode,
    JSON.stringify({input, cacheDir, objects: ["zentry"], policy: "test-v1", ...extra})],
    {encoding: "utf8", maxBuffer: 20e6, env: {...process.env, GOGEN_NOLINE: noline ? "1" : ""}});
  assert.equal(result.status, 0, result.stderr); return JSON.parse(result.stdout);
}
function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), "gogen-selection-")), input = join(root, "input"), cache = join(root, "cache");
  mkdirSync(input);
  const put = (name, text) => writeFileSync(join(input, `${name}.clas.abap`), text);
  put("zentry", source("zentry", "DATA(t5) = CONV string( |value 1| ). zleaf=>run( )."));
  put("zleaf", source("zleaf", "")); put("zother", source("zother", ""));
  try { run({input, cache, put}); } finally { rmSync(root, {recursive: true, force: true}); }
}
function oracle(input, cache, extra = {}, noline = false) {
  const warm = capture(input, cache, extra, noline), cold = capture(input, undefined, extra, noline);
  assert.ok(!warm.error, warm.error); assert.ok(!cold.error, cold.error);
  assert.deepEqual(warm.artifacts, cold.artifacts, "oracle disables object cache AND selection seed, starts from original roots");
  assert.deepEqual(warm.wanted, cold.wanted); return warm;
}
for (const noline of [false, true]) {
  test(`certified selection collapses warm and multi-edit/revert rounds; noline=${noline}`, () => fixture(({input, cache, put}) => {
    assert.equal(oracle(input, cache, {}, noline).rounds, 2);
    const warm = oracle(input, cache, {}, noline);
    assert.equal(warm.rounds, 1); assert.equal(warm.evidence, "exact-inputs");
    for (const value of [2, 3, 1]) {
      put("zentry", source("zentry", `DATA(t5) = CONV string( |value ${value}| ). zleaf=>run( ).`));
      const edited = oracle(input, cache, {}, noline);
      assert.equal(edited.rounds, 1); assert.equal(edited.evidence, "local-string-initializers");
    }
  }));
  for (const change of ["addition", "removal", "superclass", "macro", "supplied", "catch", "broken"]) {
    test(`selection falls back on ${change}; noline=${noline}`, () => fixture(({input, cache, put}) => {
      if (change === "superclass") {
        put("zoldbase", source("zoldbase", ""));
        put("zleaf", source("zleaf", "", "zoldbase"));
      }
      if (change === "macro") {
        writeFileSync(join(input, "zentry.clas.macros.abap"), "DEFINE call_hidden. zleaf=>run( ). END-OF-DEFINITION.");
        put("zentry", source("zentry", "call_hidden."));
      }
      if (change === "catch") {
        put("cx_root", source("cx_root", ""));
        for (const name of ["zcx_old", "zcx_child"]) put(name, `CLASS ${name} DEFINITION PUBLIC INHERITING FROM cx_root. ENDCLASS. CLASS ${name} IMPLEMENTATION. ENDCLASS.`);
        put("zentry", source("zentry", "TRY. RAISE EXCEPTION TYPE zcx_old. CATCH cx_root. ENDTRY."));
      }
      if (change === "supplied") {
        put("zleaf", "CLASS zleaf DEFINITION PUBLIC. PUBLIC SECTION. METHODS work IMPORTING p TYPE i OPTIONAL. ENDCLASS. CLASS zleaf IMPLEMENTATION. METHOD work. ENDMETHOD. ENDCLASS.");
        put("zother", "CLASS zother DEFINITION PUBLIC INHERITING FROM zleaf. PUBLIC SECTION. METHODS work REDEFINITION. ENDCLASS. CLASS zother IMPLEMENTATION. METHOD work. IF p IS SUPPLIED. ENDIF. ENDMETHOD. ENDCLASS.");
        put("zentry", source("zentry", "DATA o TYPE REF TO zother. CREATE OBJECT o. o->work( p = 1 )."));
      }
      oracle(input, cache, {}, noline);
      assert.equal(oracle(input, cache, {}, noline).evidence, "exact-inputs");
      if (change === "addition") put("zentry", source("zentry", "zleaf=>run( ). zother=>run( )."));
      if (change === "removal") put("zentry", source("zentry", "DATA(t5) = CONV string( |value 1| )."));
      if (change === "superclass") put("zleaf", source("zleaf", "", "zother"));
      if (change === "macro") {
        writeFileSync(join(input, "zentry.clas.macros.abap"), "DEFINE call_hidden. zother=>run( ). END-OF-DEFINITION.");
        put("zentry", source("zentry", "call_hidden."));
      }
      if (change === "supplied") put("zentry", source("zentry", "DATA o TYPE REF TO zother. CREATE OBJECT o. o->work( )."));
      if (change === "catch") put("zentry", source("zentry", "TRY. RAISE EXCEPTION TYPE zcx_child. CATCH cx_root. ENDTRY."));
      if (change === "broken") put("zleaf", source("zleaf", "DATA x TYPE any."));
      const edited = oracle(input, cache, {}, noline);
      assert.equal(edited.evidence, "discovery-from-roots");
      if (["removal", "macro"].includes(change)) assert.ok(!edited.wanted.includes("ZLEAF"), "obsolete dependency disappears");
      if (change === "superclass") assert.ok(!edited.wanted.includes("ZOLDBASE"));
      if (change === "catch") assert.ok(!edited.wanted.includes("ZCX_OLD"));
      const warm = oracle(input, cache, {}, noline);
      assert.equal(warm.evidence, "exact-inputs");
      if (change === "broken") {
        assert.equal(warm.rounds, 1, "rederive tolerant filtering while retaining diagnostics");
        assert.ok(JSON.parse(warm.artifacts.diagnostics).some(d => d.object.toUpperCase() === "ZLEAF"));
        assert.match(capture(input, cache, {objects: ["zleaf"]}, noline).error, /cannot be generic/);
      }
    }));
  }
}
for (const noline of [false, true]) test(`reordered static calls restart discovery in first-discovery order; noline=${noline}`, () => fixture(({input, cache, put}) => {
  put("zentry", source("zentry", "zleaf=>run( ). zother=>run( )."));
  const prime = oracle(input, cache, {}, noline);
  assert.deepEqual(prime.wanted, ["ZENTRY", "ZLEAF", "ZOTHER"]);
  assert.equal(capture(input, cache, {}, noline).evidence, "exact-inputs");
  put("zentry", source("zentry", "zother=>run( ). zleaf=>run( )."));
  const edited = capture(input, cache, {}, noline), cold = capture(input, undefined, {}, noline);
  assert.ok(!edited.error, edited.error); assert.ok(!cold.error, cold.error);
  assert.equal(edited.evidence, "discovery-from-roots");
  assert.ok(edited.rounds > 1, "reordered discovery references cannot reuse the one-round selection");
  assert.deepEqual(cold.wanted, ["ZENTRY", "ZOTHER", "ZLEAF"]);
  assert.deepEqual(edited.wanted, cold.wanted, "ordered selection matches independent discovery from roots");
  assert.deepEqual(edited.artifacts, cold.artifacts);
}));

test("policy, roots, corruption and tool identity fail closed", () => fixture(({input, cache}) => {
  oracle(input, cache);
  assert.equal(oracle(input, cache, {policy: "different"}).evidence, "discovery-from-roots");
  assert.equal(oracle(input, cache, {objects: ["zother"]}).evidence, "discovery-from-roots");
  writeFileSync(join(cache, "runner-selection.json"), "corrupt");
  assert.equal(oracle(input, cache).evidence, "discovery-from-roots");
  const data = JSON.parse(readFileSync(join(cache, "runner-selection.json"), "utf8"));
  data.contents.selection.push("ZOTHER");
  data.checksum = createHash("sha256").update(JSON.stringify(data.contents)).digest("hex");
  writeFileSync(join(cache, "runner-selection.json"), JSON.stringify(data));
  assert.equal(oracle(input, cache).evidence, "discovery-from-roots", "checksummed inconsistent selection is refused");
  data.contents.key.identity = "obsolete";
  writeFileSync(join(cache, "runner-selection.json"), JSON.stringify(data));
  assert.equal(oracle(input, cache).evidence, "discovery-from-roots");
}));
test("discovery evidence excludes only plain local string initializer values", () => {
  const before = source("z", "DATA(t5) = CONV string( |value 1| ).");
  const key = text => JSON.parse(discoveryEvidence("z.clas.abap", text))[0];
  assert.equal(key(before), key(before.replace("value 1", "value 2")));
  for (const after of [before.replace("string", "zother"), before.replace("value 1", "{ zother=>run( ) }"), before.replace("value 1", "value 22"),
    before.replace("CONV string( |value 1| )", "zother=>run( )"), before.replace("DATA(t5)", "DATA(other)"),
    before.replace("value 1", "value\\n2"), before.replace("value 1", "value\n2")]) assert.notEqual(key(before), key(after));
  const constant = "CLASS z DEFINITION. PUBLIC SECTION. CONSTANTS c TYPE string VALUE 'one'. ENDCLASS.";
  assert.notEqual(key(constant), key(constant.replace("one", "two")));
});

test("negative control: a closed stale superset changes bytes; from-roots oracle detects it", () => fixture(({input, cache, put}) => {
  oracle(input, cache);
  put("zentry", source("zentry", ""));
  const correct = oracle(input, cache);
  const stale = capture(input, undefined, {forceSelection: ["ZENTRY", "ZLEAF"]});
  assert.equal(stale.rounds, 1, "no missing classes does not prove selection equality");
  assert.notDeepEqual(stale.artifacts, correct.artifacts);
}));
test("seed controller continues missing-class rounds and keeps explicit roots strict", () => fixture(({input, put}) => {
  const grown = capture(input, undefined, {forceSelection: ["ZENTRY"]});
  assert.equal(grown.rounds, 2);
  assert.deepEqual(grown.artifacts, capture(input, undefined).artifacts);
  put("zentry", source("zentry", "DATA x TYPE any."));
  assert.match(capture(input, undefined, {forceSelection: ["ZENTRY", "ZLEAF"]}).error, /cannot be generic/);
}));

for (const noline of [false, true]) test(`literal width changes use the general proof; noline=${noline}`, () => fixture(({input, cache, put}) => {
  oracle(input, cache, {}, noline);
  put("zentry", source("zentry", "DATA(t5) = CONV string( |value 22| ). zleaf=>run( )."));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.evidence, "method-discovery-references");
  assert.equal(result.rounds, 1);
}));

test("literal edits must preserve the frontend's actual raw-source probe answers", () => {
  const key = text => JSON.parse(discoveryEvidence("z.clas.abap", source("z", `DATA(t5) = CONV string( |${text}| ).`)))[0];
  assert.notEqual(key("TYPES ztype1 TYPE i."), key("TYPES ztype2 TYPE i."));
  assert.notEqual(key("INTERFACE lif_one."), key("INTERFACE lif_two."));
  assert.notEqual(key("CL_AMC_CHANNEL_MANAGER"), key("ZL_AMC_CHANNEL_MANAGER"));
  assert.equal(key("add 2 to lv_foo."), key("add 3 to lv_foo."));
});
for (const noline of [false, true]) test(`current-registry expansion certifies original controller membership; noline=${noline}`, () => fixture(({input, cache, put}) => {
  put("zentry", source("zentry", "zleaf=>run( )."));
  put("zleaf", source("zleaf", "DATA x TYPE i. x = zattr=>counter."));
  put("zbase", source("zbase", ""));
  put("zattr", "CLASS zattr DEFINITION PUBLIC INHERITING FROM zbase. PUBLIC SECTION. CLASS-DATA counter TYPE i. ENDCLASS. CLASS zattr IMPLEMENTATION. ENDCLASS.");
  const cold = oracle(input, cache, {}, noline);
  assert.equal(cold.rounds, 2);
  assert.ok(cold.wanted.includes("ZATTR"));
  assert.ok(!cold.wanted.includes("ZBASE"), "reference discovery checks its retained membership, not final wanted");
  const seeded = oracle(input, cache, {}, noline);
  assert.equal(seeded.rounds, 1);
  assert.equal(seeded.evidence, "exact-inputs");
  assert.ok(!seeded.wanted.includes("ZBASE"), "seeding must not add an extra superclass absent from the reference result");
}));

test("exact source and AST certificate encodings have distinct evidence domains", () => {
  const valid = source("z", "DATA(t5) = CONV string( |x| ).");
  const unrelated = JSON.stringify([valid.replace("|x|", "|<local-string-value:3>|"), [], [], false]);
  assert.notEqual(discoveryEvidence("z.clas.abap", valid), discoveryEvidence("z.clas.abap", unrelated));
});

for (const noline of [false, true]) for (const restoreAtCheck of [false, true]) test(`loaded-input scope rejects a scan/load race; noline=${noline}, revert=${restoreAtCheck}`, () => fixture(({input, cache}) => {
  oracle(input, cache, {}, noline);
  const result = capture(input, cache, {mutateAfterPrepare: source("zentry", ""), restoreAtCheck}, noline);
  const cold = capture(input, undefined, {}, noline);
  assert.ok(!result.error, result.error);
  assert.deepEqual(result.artifacts, cold.artifacts);
  assert.deepEqual(result.wanted, cold.wanted);
  assert.equal(result.evidence, "discovery-from-roots");
  assert.ok(result.rounds > cold.rounds, "discarded seeded work is counted and discovery restarts from original roots");
}));

for (const noline of [false, true]) for (const edited of [false, true]) test(`coherent forged ledger restarts from current roots; edited=${edited}, noline=${noline}`, () => fixture(({input, cache, put}) => {
  oracle(input, cache, {}, noline);
  const file = join(cache, "runner-selection.json"), data = JSON.parse(readFileSync(file, "utf8"));
  const saved = data.contents;
  assert.equal(saved.rounds.length, 2);
  // Keep inputs[0] and the request key intact, forge every later row
  // consistently, and recompute integrity just as a local writer can.
  saved.rounds[0].wanted.push("ZOTHER");
  saved.rounds[1].inputs = ["ZENTRY", "ZOTHER", "ZLEAF"];
  saved.rounds[1].wanted = [...saved.rounds[1].inputs];
  saved.selection = [...saved.rounds[1].inputs];
  data.checksum = createHash("sha256").update(JSON.stringify(saved)).digest("hex");
  writeFileSync(file, JSON.stringify(data));
  if (edited) put("zentry", source("zentry", "DATA(t5) = CONV string( |value 2| ). zleaf=>run( )."));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.evidence, "discovery-from-roots");
  assert.equal(result.rounds, 3, "discard the seeded attempt, then execute the two reference rounds");
  assert.ok(!result.wanted.includes("ZOTHER"));
}));

for (const noline of [false, true]) test(`current selection handles duplicate/namespace roots; noline=${noline}`, () => fixture(({input, cache, put}) => {
  put("#demo#root", source("/demo/root", ""));
  const extra = {objects: ["zEntry", "zentry", "#demo#root"]};
  const cold = oracle(input, cache, extra, noline);
  assert.equal(cold.rounds, 2);
  const warm = oracle(input, cache, extra, noline);
  assert.equal(warm.rounds, 1);
  assert.equal(warm.evidence, "exact-inputs");
}));

for (const noline of [false, true]) test(`replay validates later wanted, inputs, additions, order and termination; noline=${noline}`, () => fixture(({input, cache}) => {
  oracle(input, cache, {}, noline);
  const file = join(cache, "runner-selection.json"), valid = JSON.parse(readFileSync(file, "utf8"));
  for (const mutate of [
    s => { s.rounds[1].wanted.push("ZOTHER"); },
    s => { s.rounds[1].inputs.reverse(); },
    s => { s.rounds[0].added = []; },
    s => { s.rounds[0].added.push("ZABSENT"); },
    s => { s.selection.reverse(); },
    s => { s.rounds.pop(); s.selection = s.key.roots; },
  ]) {
    const saved = structuredClone(valid); mutate(saved.contents);
    saved.checksum = createHash("sha256").update(JSON.stringify(saved.contents)).digest("hex");
    writeFileSync(file, JSON.stringify(saved));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.evidence, "discovery-from-roots", "checksummed inconsistent derivation fails closed");
  }
}));

for (const noline of [false, true]) test(`cold compiler expansions certify local and function-group identities; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const corpus = syntheticCorpus({classes: 4});
  for (const [name, text] of Object.entries(corpus.files)) if (name.startsWith("zoracle_group.")) writeFileSync(join(input, name), text);
  put("zentry", source("zentry", "CALL FUNCTION 'ZORACLE_FUNCTION' EXPORTING iv_value = 7."));
  put("cl_abap_unit_assert", source("cl_abap_unit_assert", ""));
  writeFileSync(join(input, "cl_abap_unit_assert.clas.locals_imp.abap"), "CLASS lcl_dump DEFINITION. ENDCLASS. CLASS lcl_dump IMPLEMENTATION. ENDCLASS.");
  const extra = {objects: ["zentry", "cl_abap_unit_assert"]};
  assert.equal(oracle(input, cache, extra, noline).rounds, 1, "a closed first round keeps its raw compile inputs and expanded membership distinct");
  const ledger = JSON.parse(readFileSync(join(cache, "runner-selection.json"), "utf8")).contents;
  for (const name of ["ZORACLE_GROUP", "FUGR:ZORACLE_GROUP", "CL_ABAP_UNIT_ASSERT:LCL_DUMP"]) assert.ok(ledger.rounds[0].wanted.includes(name), name);
  const warm = oracle(input, cache, extra, noline);
  assert.equal(warm.rounds, 1);
  assert.equal(warm.evidence, "exact-inputs");
}));

for (const noline of [false, true]) test(`local integer logic, declaration, multi-edit and revert certify; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA counter TYPE i. counter = 1. IF counter > 2. counter = counter + 1. ENDIF. zleaf=>run( ).";
  put("zentry", source("zentry", body));
  oracle(input, cache, {}, noline);
  for (const after of [body.replace("counter > 2", "counter >= 3"),
    body.replace("counter = 1.", "counter = 2. counter = counter + 1."),
    body + " DATA another TYPE i. another = 4.",
    body.replace("DATA counter TYPE i. counter = 1.", "DATA counter TYPE i VALUE 2. ADD 1 TO counter."), body]) {
    put("zentry", source("zentry", after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.rounds, 1);
    assert.equal(result.evidence, "discovery-references");
  }
}));
for (const noline of [false, true]) for (const kind of ["type-ref", "catch-new", "constant", "interface", "dynamic-literal", "include"]) {
  test(`reference boundary ${kind} restarts roots; noline=${noline}`, () => fixture(({input, cache, put}) => {
    let before = "", after = "";
    if (kind === "type-ref") { before = "DATA o TYPE REF TO zleaf."; after = "DATA o TYPE REF TO zother."; }
    if (kind === "constant") {
      for (const n of ["zleaf", "zother"]) put(n, `CLASS ${n} DEFINITION PUBLIC. PUBLIC SECTION. CONSTANTS c TYPE i VALUE 1. ENDCLASS. CLASS ${n} IMPLEMENTATION. ENDCLASS.`);
      before = "DATA x TYPE i. x = zleaf=>c."; after = "DATA x TYPE i. x = zother=>c.";
    }
    if (kind === "catch-new") {
      put("cx_root", source("cx_root", ""));
      for (const n of ["zcx_old", "zcx_new"]) put(n, `CLASS ${n} DEFINITION PUBLIC INHERITING FROM cx_root. ENDCLASS. CLASS ${n} IMPLEMENTATION. ENDCLASS.`);
      before = "TRY. CATCH zcx_old. ENDTRY."; after = "TRY. CATCH zcx_new. ENDTRY.";
    }
    if (kind === "dynamic-literal") { before = "CALL METHOD ('ZLEAF')=>('RUN')."; after = "CALL METHOD ('ZOTHER')=>('RUN')."; }
    if (kind === "include") {
      writeFileSync(join(input, "zfirst.prog.abap"), "DATA x TYPE i.");
      writeFileSync(join(input, "zsecond.prog.abap"), "DATA y TYPE i.");
      before = "INCLUDE zfirst."; after = "INCLUDE zsecond.";
    }
    const make = body => kind === "interface" ? source("zentry", "").replace("PUBLIC SECTION.", `PUBLIC SECTION. ${body}`) : source("zentry", body);
    if (kind === "interface") {
      writeFileSync(join(input, "zif_a.intf.abap"), "INTERFACE zif_a PUBLIC. ENDINTERFACE.");
      writeFileSync(join(input, "zif_b.intf.abap"), "INTERFACE zif_b PUBLIC. ENDINTERFACE.");
      before = "INTERFACES zif_a."; after = "INTERFACES zif_b.";
    }
    put("zentry", make(before)); oracle(input, cache, {}, noline);
    put("zentry", make(after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.evidence, "discovery-from-roots");
  }));
}
test("AST candidates still exclude changed named references, includes and macros", () => {
  const proof = body => discoveryEvidence("z.clas.abap", source("z", body));
  const matches = (a, b) => matchingDiscoveryEvidence(proof(a), proof(b));
  for (const [a, b] of [
    ["DATA x TYPE i. x = 1.", "DATA x TYPE ztype. x = 1."],
    ["INCLUDE zfirst.", "INCLUDE zfirst. DATA x TYPE i."],
    ["DEFINE m. END-OF-DEFINITION.", "DEFINE m. END-OF-DEFINITION. DATA x TYPE i."],
    ["not an abap statement.", "not an abap statement. DATA x TYPE i."],
  ]) assert.equal(matches(a, b), undefined, `${a} -> ${b}`);
});

test("negative control: omitting static-call references really certifies a stale superset caught by the roots oracle", () => fixture(({input, cache, put}) => {
  // Clone only the host certification chain. No production fault-injection flag,
  // no forced selection: the deliberately faulty certifier must accept the edit.
  const directory = join(cache, "fault"); mkdirSync(directory, {recursive: true});
  const modules = ["runner-method-projection.mjs", "runner-selection-evidence.mjs", "runner-method-discovery.mjs", "runner-selection-scope.mjs", "runner-selection-cache.mjs"];
  for (const name of modules) {
    let text = readFileSync(new URL(name, import.meta.url), "utf8");
    text = text.replace("createRequire(import.meta.url)", `createRequire(${JSON.stringify(new URL(name, import.meta.url).href)})`);
    if (name === "runner-method-projection.mjs") text = text.replace("  const retained =", '  statements = statements.filter(s => !staticDiscoveryReferences(s, core).some(r => r.owner.toUpperCase() === "ZLEAF"));\n  const retained =');
    if (name === "runner-method-discovery.mjs") text = text.replace("return {references, phases:", 'return {references: references.filter(r => !r.includes("ZLEAF")), phases:');
    const ast = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS), edits = [];
    for (const node of ast.statements) if (ts.isImportDeclaration(node) && node.moduleSpecifier.text.startsWith(".")) {
      const spec = node.moduleSpecifier.text, leaf = spec.slice(2);
      if (!modules.includes(leaf)) edits.push([node.moduleSpecifier.getStart(ast), node.moduleSpecifier.getEnd(), JSON.stringify(new URL(spec, import.meta.url).href)]);
    }
    const visit = node => {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === "require" && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text.startsWith(".")) {
        const arg = node.arguments[0]; edits.push([arg.getStart(ast), arg.getEnd(), JSON.stringify(new URL(arg.text, import.meta.url).pathname)]);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
    for (const [start,end,value] of edits.sort((a,b) => b[0]-a[0])) text = text.slice(0,start) + value + text.slice(end);
    writeFileSync(join(directory,name), text);
  }
  const faultModule = new URL(`file://${join(directory, "runner-selection-cache.mjs")}`).href;
  put("zentry", source("zentry", "zleaf=>run( )."));
  const prime = capture(input, cache, {faultModule}); assert.ok(!prime.error, prime.error);
  put("zentry", source("zentry", ""));
  const stale = capture(input, cache, {faultModule}), reference = capture(input, undefined);
  assert.ok(!stale.error, stale.error); assert.ok(!reference.error, reference.error);
  assert.equal(stale.rounds, 1); assert.equal(stale.evidence, "method-discovery-references", "faulty certifier actually accepts the missing reference: " + readFileSync(join(cache, "fault-diagnostics.ndjson"), "utf8"));
  assert.deepEqual(stale.wanted, prime.wanted);
  assert.notDeepEqual(stale.wanted, reference.wanted);
  assert.notDeepEqual(stale.artifacts, reference.artifacts, "independent oracle detects the omitted static reference kind");
}));
test("concurrent edited readers publish atomic compatible selection proofs", async () => {
  const root = mkdtempSync(join(tmpdir(), "gogen-selection-concurrent-")), input = join(root, "input"), cache = join(root, "cache");
  mkdirSync(input);
  try {
    const file = join(input, "zentry.clas.abap");
    writeFileSync(file, source("zentry", "DATA(counter) = 1. zleaf=>run( )."));
    writeFileSync(join(input, "zleaf.clas.abap"), source("zleaf", ""));
    oracle(input, cache);
    writeFileSync(file, source("zentry", "DATA(counter) = 1. counter = counter + 2. zleaf=>run( )."));
    const reference = capture(input, undefined);
    const captures = await Promise.all([1, 2, 3].map(() => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e", childCode,
        JSON.stringify({input, cacheDir: cache, objects: ["zentry"], policy: "test-v1"})]);
      let stdout = "", stderr = "";
      child.stdout.on("data", b => { stdout += b; }); child.stderr.on("data", b => { stderr += b; });
      child.on("error", reject); child.on("close", code => code ? reject(new Error(stderr)) : resolve(JSON.parse(stdout)));
    })));
    for (const result of captures) {
      assert.deepEqual(result.artifacts, reference.artifacts); assert.deepEqual(result.wanted, reference.wanted);
      assert.equal(result.rounds, 1); assert.ok(["method-discovery-references", "exact-inputs"].includes(result.evidence));
    }
    assert.equal(oracle(input, cache).evidence, "exact-inputs");
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("the loaded syntax scope certifies primitive TYPE i despite an inherited same-name type", () => fixture(({input, cache, put}) => {
  put("zparent", "CLASS zparent DEFINITION PUBLIC. PUBLIC SECTION. TYPES i TYPE string. ENDCLASS. CLASS zparent IMPLEMENTATION. ENDCLASS.");
  put("zentry", source("zentry", "DATA counter TYPE i.", "zparent"));
  oracle(input, cache);
  put("zentry", source("zentry", "DATA counter TYPE i. counter = 1.", "zparent"));
  const result = oracle(input, cache);
  assert.equal(result.evidence, "discovery-references");
  assert.equal(result.rounds, 1);
}));

for (const noline of [false, true]) test(`multiple owners edit and revert; static-call additions/removals restart; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const entry = "DATA counter TYPE i. counter = 1. zleaf=>run( ).", leaf = "DATA counter TYPE i. counter = 1.";
  put("zentry", source("zentry", entry)); put("zleaf", source("zleaf", leaf)); oracle(input, cache, {}, noline);
  for (const value of [2, 1]) {
    put("zentry", source("zentry", entry.replace("= 1", `= ${value}`)));
    put("zleaf", source("zleaf", leaf.replace("= 1", `= ${value}`)));
    assert.equal(oracle(input, cache, {}, noline).rounds, 1);
  }
  put("zentry", source("zentry", entry + " zother=>run( )."));
  const added = oracle(input, cache, {}, noline); assert.equal(added.evidence, "discovery-from-roots"); assert.ok(added.wanted.includes("ZOTHER"));
  put("zentry", source("zentry", entry));
  const removed = oracle(input, cache, {}, noline); assert.equal(removed.evidence, "discovery-from-roots"); assert.ok(!removed.wanted.includes("ZOTHER"));
}));

for (const noline of [false, true]) test(`general method logic uses actual frontend discovery references; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA(text) = CONV string( |hello| ). IF strlen( text ) > 1. text = to_upper( text ). ENDIF. zleaf=>run( ).";
  put("zentry", source("zentry", body)); oracle(input, cache, {}, noline);
  for (const after of [body.replace("> 1", ">= 2"), body.replace("text = to_upper( text ).", "text = to_lower( text ). text = text && text."), body + " DATA added TYPE string. added = text.", body]) {
    put("zentry", source("zentry", after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.rounds, 1); assert.equal(result.evidence, "method-discovery-references");
  }
}));

for (const noline of [false, true]) test(`general inferred locals and branch insertion certify; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA(x) = 1. zleaf=>run( ).";
  put("zentry", source("zentry", body)); oracle(input, cache, {}, noline);
  for (const after of ["DATA(x) = 2. IF x > 0. x = x / 2. ENDIF. zleaf=>run( ).", body]) {
    put("zentry", source("zentry", after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.rounds, 1); assert.equal(result.evidence, "method-discovery-references");
  }
}));
for (const noline of [false, true]) test(`general unknown lowering and refusal boundaries restart roots; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA(text) = CONV string( |hello| ). zleaf=>run( ).";
  put("zentry", source("zentry", body)); oracle(input, cache, {}, noline);
  put("zentry", source("zentry", "DATA(text) = CONV string( |hello| ). BREAK-POINT. zleaf=>run( )."));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.evidence, "discovery-from-roots");
}));

for (const noline of [false, true]) for (const create of [false, true]) test(`lowering-derived CREATE dependency changes despite identical named AST set; create=${create}, noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA o TYPE REF TO zleaf.";
  put("zentry", source("zentry", body + (create ? " CREATE OBJECT o." : "")));
  oracle(input, cache, {}, noline);
  put("zentry", source("zentry", body + (create ? "" : " CREATE OBJECT o.")));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.evidence, "discovery-from-roots");
}));

for (const noline of [false, true]) test(`SUPPLIED uses the frontend comparison reader while unrelated logic edits certify; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "IF p IS SUPPLIED AND p > 1. DATA(x) = 1. ENDIF. zleaf=>run( ).";
  const make = body => source("zentry", body).replace("CLASS-METHODS run.", "CLASS-METHODS run IMPORTING p TYPE i OPTIONAL.");
  put("zentry", make(body)); oracle(input, cache, {}, noline);
  for (const after of [body.replace("p > 1", "p > 2"), body.replace("p IS SUPPLIED", "p IS NOT SUPPLIED"), body]) {
    put("zentry", make(after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.rounds, 1); assert.equal(result.evidence, "method-discovery-references");
  }
}));

test("main-method edits with same-named local include methods reject stubs and include changes", () => fixture(({input, cache, put}) => {
  const body = "DATA(text) = CONV string( |hello| ). zleaf=>run( ).";
  writeFileSync(join(input, "zentry.clas.locals_def.abap"), "CLASS lcl_aux DEFINITION. PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.");
  const local = "CLASS lcl_aux IMPLEMENTATION. METHOD run. DATA(counter) = 1. ENDMETHOD. ENDCLASS.";
  writeFileSync(join(input, "zentry.clas.locals_imp.abap"), local);
  put("zentry", source("zentry", body)); oracle(input, cache, {includeTests: true});
  const after = body + " text = to_upper( text ).";
  put("zentry", source("zentry", after));
  const changed = oracle(input, cache, {includeTests: true});
  assert.equal(changed.rounds, 1); assert.equal(changed.evidence, "method-discovery-references");
  put("zentry", source("zentry", after + " BREAK-POINT."));
  assert.equal(oracle(input, cache, {includeTests: true}).evidence, "discovery-from-roots");
  put("zentry", source("zentry", after));
  writeFileSync(join(input, "zentry.clas.locals_imp.abap"), local.replace("= 1", "= 2"));
  assert.equal(oracle(input, cache, {includeTests: true}).evidence, "discovery-from-roots");
}));
test("importing the host checker with an unrelated --probe argument performs no CLI work", () => {
  const child = spawnSync(process.execPath, ["--preserve-symlinks", "--input-type=module", "-e",
    `process.argv = [process.execPath, "unrelated.mjs", "--probe"]; await import(${JSON.stringify(new URL("runner-method-discovery.mjs", import.meta.url).href)}); console.log("imported");`],
    {encoding: "utf8", input: "{}"});
  assert.equal(child.status, 0, child.stderr); assert.equal(child.stdout, "imported\n");
});
for (const noline of [false, true]) for (const special of ["literal", "integer"]) test(`general edit composes with an independently certified partial-method ${special} edit; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = (special === "literal" ? "DATA(t5) = CONV string( |value 1| )." : "DATA counter TYPE i. counter = 1.") + " BREAK-POINT. zleaf=>run( ).";
  const logic = "DATA(text) = CONV string( |hello| ). IF strlen( text ) > 1. text = to_upper( text ). ENDIF.";
  put("zentry", source("zentry", body)); put("zleaf", source("zleaf", logic));
  oracle(input, cache, {}, noline);
  put("zentry", source("zentry", body.replace(special === "literal" ? "value 1" : "= 1", special === "literal" ? "value 2" : "= 2")));
  put("zleaf", source("zleaf", logic.replace("> 1", "> 2")));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.rounds, 1); assert.equal(result.evidence, "method-discovery-references");
}));
for (const noline of [false, true]) test(`unchanged broken-owner diagnostics remain authoritative in every historical context; noline=${noline}`, () => fixture(({input, cache, put}) => {
  put("zbroken", source("zbroken", "DATA x TYPE any."));
  const before = "DATA(text) = CONV string( |hello| ). IF strlen( text ) > 1. text = to_upper( text ). ENDIF. zleaf=>run( ).";
  const options = {objects: ["zentry", "zbroken"], tolerant: true};
  put("zentry", source("zentry", before)); oracle(input, cache, options, noline);
  put("zentry", source("zentry", before.replace("> 1", "> 2")));
  const result = oracle(input, cache, options, noline);
  assert.equal(result.rounds, 1); assert.equal(result.evidence, "method-discovery-references");
}));

for (const noline of [false, true]) test(`general method edits preserve the actual loaded CDS mapping and reject raw CDS changes; noline=${noline}`, () => fixture(({input, cache, put}) => {
  for (const name of ["zgogen_t_dbw.tabl.xml", "zgogen_t_dbwc.view.xml", "zgogen_t_dbwv.view.xml"])
    writeFileSync(join(input, name), readFileSync(new URL(`./testdata/${name}`, import.meta.url)));
  const file = join(input, "zgogen_t_dbwc.ddls.asddls"), ddls = "@AbapCatalog.sqlViewName: 'ZGOGEN_T_DBWV'\ndefine view ZGOGEN_T_DBWC as select from zgogen_t_dbw { key id, val as amount }";
  writeFileSync(file, ddls);
  const before = "SELECT id FROM zgogen_t_dbwv INTO TABLE @DATA(rows). DATA(text) = CONV string( |hello| ). IF strlen( text ) > 1. text = to_upper( text ). ENDIF. zleaf=>run( ).";
  put("zentry", source("zentry", before));
  const initial = oracle(input, cache, {}, noline);
  assert.deepEqual(JSON.parse(initial.artifacts.partial), []); assert.deepEqual(JSON.parse(initial.artifacts.skipped), []);
  put("zentry", source("zentry", before.replace("> 1", "> 2")));
  const result = oracle(input, cache, {}, noline);
  assert.equal(result.rounds, 1, JSON.stringify({evidence: result.evidence, partial: result.artifacts.partial, skipped: result.artifacts.skipped})); assert.equal(result.evidence, "method-discovery-references");
  assert.deepEqual(JSON.parse(result.artifacts.cdsViews), {ZGOGEN_T_DBWC: "ZGOGEN_T_DBWV"});
  writeFileSync(file, ddls + "\n// raw CDS edit");
  assert.equal(oracle(input, cache, {}, noline).evidence, "discovery-from-roots");
}));

for (const noline of [false, true]) test(`duplicate static-call insertion restarts roots and revert reuses exact inputs; noline=${noline}`, () => fixture(({input, cache, put}) => {
  const body = "DATA(text) = CONV string( |hello| ). zleaf=>run( ).";
  put("zentry", source("zentry", body)); oracle(input, cache, {}, noline);
  for (const after of [body + " zleaf=>run( ).", body]) {
    put("zentry", source("zentry", after));
    const result = oracle(input, cache, {}, noline);
    assert.equal(result.rounds, after === body ? 1 : 3);
    assert.equal(result.evidence, after === body ? "exact-inputs" : "discovery-from-roots");
  }
}));
