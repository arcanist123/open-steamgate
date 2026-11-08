import {test} from "node:test";
import assert from "node:assert/strict";
import {buildManifest, driverInputs} from "./corpus-inputs.mjs";
import {compareOutputs, declarations, declKey, ownerOf, reachCount} from "./corpus-report.mjs";

const go = (body) => Buffer.from(["// Code generated", "", "package main", "", ...body, ""].join("\n"));
const REF = ["type ZCL_A struct {", "\tX int", "}", "", "func (me *ZCL_A) RUN() {", "\treturn", "}", "",
  "type statics_ZCL_B struct{}", "var slot_ZCL_B = 1", "func ZCL_B_GET() int { return 1 }", "", "func helper() {}"];

test("declaration keys", () => {
  assert.equal(declKey("func (me *ZCL_A) RUN() {"), "ZCL_A.RUN");
  assert.equal(declKey("func ZCL_B_GET() int {"), "ZCL_B_GET");
  assert.equal(declKey("type ZCL_A struct {"), "ZCL_A");
  assert.equal(declKey("var slot_ZCL_B = 1"), "slot_ZCL_B");
  assert.equal(declarations(go(REF).toString()).length, 7);
});

test("owner attribution takes the longest Go name", () => {
  const owner = ownerOf(["zcl_a", "zcl_a_b", "ZCL_B"]);
  assert.equal(owner("ZCL_A_B.RUN"), "ZCL_A_B");
  assert.equal(owner("ZCL_A.RUN"), "ZCL_A");
  assert.equal(owner("slot_ZCL_B"), "ZCL_B");
  assert.equal(owner("helper"), "(program)");
});

test("equal bytes pass, one changed byte fails and names its object", () => {
  const same = compareOutputs(go(REF), go(REF), ["ZCL_A", "ZCL_B"]);
  assert.equal(same.equal, true);
  assert.deepEqual(same.objects, {"(program)": "equal", ZCL_A: "equal", ZCL_B: "equal"});
  const changed = REF.map((l) => (l === "\treturn" ? "\treturn " : l));
  const diff = compareOutputs(go(REF), go(changed), ["ZCL_A", "ZCL_B"]);
  assert.equal(diff.equal, false);
  assert.equal(diff.objects.ZCL_A, "diff");
  assert.equal(diff.objects.ZCL_B, "equal");
  assert.equal(diff.firstDifference.line, 10);
});

test("a dropped declaration is missing, an empty output misses everything", () => {
  const dropped = compareOutputs(go(REF), go(REF.filter((l) => !l.startsWith("func ZCL_B_GET"))), ["ZCL_A", "ZCL_B"]);
  assert.equal(dropped.equal, false);
  assert.equal(dropped.objects.ZCL_A, "equal");
  assert.ok(["missing", "diff"].includes(dropped.objects.ZCL_B));
  assert.ok(dropped.decls.missing >= 1);
  const empty = compareOutputs(go(REF), Buffer.alloc(0), ["ZCL_A", "ZCL_B"]);
  assert.equal(empty.equal, false);
  assert.equal(empty.firstDifference.out, "EOF");
});

test("reordered declarations are a difference even when every declaration matches", () => {
  const swapped = [...REF.slice(8), "", ...REF.slice(0, 8)];
  const r = compareOutputs(go(REF), go(swapped), ["ZCL_A", "ZCL_B"]);
  assert.equal(r.equal, false);
});

test("reach count and manifest", () => {
  assert.deepEqual(reachCount({spans: [{executed: true}, {executed: false}, {executed: true}]}), {executed: 2, bodies: 3});
  const files = {"/r/src": ["/r/src/a.clas.abap", "/r/src/b.clas.abap"], "/lib/x": ["/lib/x/c.intf.abap"]};
  const args = {folders: ["/r/src", "/lib/x"], objects: ["A", "C"], hidden: new Set(["/r/src/b.clas.abap", "/elsewhere/z"]), root: "/r",
    filesOf: (f) => files[f], read: (f) => Buffer.from(f)};
  const m = buildManifest(args);
  assert.deepEqual(m.files.map((f) => [f.path, f.role]), [["src/a.clas.abap", "input"], ["src/b.clas.abap", "skipped"], ["/lib/x/c.intf.abap", "input"]]);
  assert.deepEqual(m.skipped, ["src/b.clas.abap"]);
  assert.equal(m.manifestSha256, buildManifest(args).manifestSha256);
  assert.notEqual(m.manifestSha256, buildManifest({...args, read: (f) => Buffer.from(f + "!")}).manifestSha256);
  assert.deepEqual(driverInputs(args).skippedPaths, ["/r/src/b.clas.abap"]);
});

test("trap classification by kind and module", async () => {
  const {classifyTraps} = await import("./corpus-report.mjs");
  const tsv = ["location\tkind: message\thits\troot-or-cascade\tmethod\tevidence",
    "tools/a.mjs:1:1\tbody: lowering trap: method map on dynamic is not lowered\t3\troot\tx\tblock",
    "tools/a.mjs:9:1\tbody: lowering trap: not supported in the Go prototype: JavaScript regexp /x/i\t1\troot\tx\tblock",
    "tools/b.mjs:2:1\tbody: something new\t1\troot\tx\tblock", ""].join("\n");
  assert.deepEqual(classifyTraps(tsv), {byKind: {"A regexp feature": 1, "G untyped value (dynamic/void)": 1, other: 1}, byModule: {"tools/a.mjs": 2, "tools/b.mjs": 1}});
});
