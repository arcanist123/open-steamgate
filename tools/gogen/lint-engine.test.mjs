import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {createGoTestDir} from "./go-test-module.mjs";
import {lintBuildSpec, lintEngineGo} from "./lint-engine.mjs";

test("typed lint bridge calls compiled ABAP with private persistent statics, without zlnt", () => {
  const source = mkdtempSync(join(tmpdir(), "lint-bridge-source-"));
  const {dir, goRoot} = createGoTestDir("lint-bridge-go-");
  try {
    // Use the actual public facade contract. Replace only the implementation
    // and private zlnt references so this is a cheap ABI/lifecycle test.
    const publicPart = readFileSync(new URL("../step3/abap/src/lint/zcl_osd_lint_engine.clas.abap", import.meta.url), "utf8").split("  PRIVATE SECTION.")[0];
    writeFileSync(join(source, "zcl_osd_lint_engine.clas.abap"), publicPart + `
 PRIVATE SECTION.
 CLASS-DATA saved TYPE string.
ENDCLASS.
CLASS zcl_osd_lint_engine IMPLEMENTATION.
 METHOD prime.
 DATA ls_file TYPE ty_file.
 ASSERT it_deps IS INITIAL.
 LOOP AT it_files INTO ls_file.
 saved = ls_file-raw && iv_config.
 ENDLOOP.
 ENDMETHOD.
 METHOD check.
 DATA issue TYPE ty_issue.
 issue-filename = iv_filename.
 issue-message = saved.
 issue-start_row = 12.
 issue-start_col = 5.
 APPEND issue TO rt_issues.
 ENDMETHOD.
 METHOD update.
 IF iv_remove = abap_true.
 CLEAR saved.
 ELSE.
 saved = iv_raw.
 ENDIF.
 ENDMETHOD.
ENDCLASS.
`);
    const code = emitGo(compileProgram({folders: [source], objects: ["ZCL_OSD_LINT_ENGINE"]}));
    writeFileSync(join(dir, "zz_generated.go"), code);
    writeFileSync(join(dir, "zz_lint.go"), lintEngineGo({config: "{}", hidden: [], files: [], guards: {}}));
    writeFileSync(join(dir, "bridge_test.go"), `package main
import ("testing"; "osg/gogen/objstore"; "osg/gogen/storecheck"; "osg/gogen/storelint")
type lintSpec struct {Config string; Hidden, Files []string; Guards map[string]string}
var makeLintCompiler func(string, storecheck.Compiler) (*storelint.Compiler, string)
func configuredLintCompiler(string, storecheck.Compiler, storelint.Engine, lintSpec) *storelint.Compiler { return nil }
func TestBridge(t *testing.T) {
 a, b := newLintEngine(), newLintEngine()
 a.Prime([]objstore.LintFile{{Filename: "/a", Raw: "first"}}, "{}")
 b.Prime([]objstore.LintFile{{Filename: "/a", Raw: "second"}}, "{}")
 for n := 0; n < 2; n++ {
  issues := a.Check("/a")
  if len(issues) != 1 || issues[0].Message != "first{}" || issues[0].Row != 12 || issues[0].Column != 5 || issues[0].Filename != "/a" { t.Fatal(issues) }
 }
 if b.Check("/b")[0].Message != "second{}" { t.Fatal("private statics leaked") }
 raw := "overlay"
 a.Update("/a", &raw)
 if a.Check("/a")[0].Message != raw { t.Fatal("update bridge failed") }
 a.Update("/a", nil)
 if a.Check("/a")[0].Message != "" { t.Fatal("remove bridge failed") }
 raw = ""
 b.Update("/b", &raw)
 if b.Check("/b")[0].Message != "" { t.Fatal("empty source failed") }
}
`);
    const output = execFileSync("go", ["test", "./" + dir.slice(goRoot.length + 1)], {cwd: goRoot, encoding: "utf8", env: {...process.env, GOPROXY: "off"}});
    assert.match(output, /^ok\s/m);
  } finally {
    rmSync(source, {recursive: true, force: true});
    rmSync(goRoot, {recursive: true, force: true});
  }
});

test("Node registry oracle dirties transitive cached readers and restores after a thrown overlay check", async () => {
  const lint = await import("@abaplint/core");
  const {updateRegistryFiles, withSource} = await import("../osd-store-registry.mjs");
  const registry = new lint.Registry(new lint.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "v702"}, rules: {check_syntax: true}})));
  const baseFile = "/src/zcl_base.clas.abap";
  const base = "CLASS zcl_base DEFINITION PUBLIC. PUBLIC SECTION. METHODS run IMPORTING iv_old TYPE i. ENDCLASS.\nCLASS zcl_base IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS.\n";
  for (const [filename, raw] of [[baseFile, base],
    ["/src/zcl_sub.clas.abap", "CLASS zcl_sub DEFINITION PUBLIC INHERITING FROM zcl_base. ENDCLASS.\nCLASS zcl_sub IMPLEMENTATION. ENDCLASS.\n"],
    ["/src/zcl_caller.clas.abap", "CLASS zcl_caller DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS call. ENDCLASS.\nCLASS zcl_caller IMPLEMENTATION. METHOD call. DATA sub TYPE REF TO zcl_sub. CREATE OBJECT sub. sub->run( iv_old = 1 ). ENDMETHOD. ENDCLASS.\n"]]) registry.addFile(new lint.MemoryFile(filename, raw));
  registry.parse();
  const check = () => registry.findIssuesObject(registry.getObject("CLAS", "ZCL_CALLER"));
  assert.deepEqual(check(), []);
  const events = [];
  for (const method of ["updateFile", "addFile", "removeFile", "parse"]) {
    const original = registry[method].bind(registry);
    registry[method] = (...args) => {events.push(method); return original(...args);};
  }
  const broken = base.replace("iv_old", "iv_new");
  updateRegistryFiles(registry, [[baseFile, broken]]);
  assert.ok(check().some(i => i.getMessage().toLowerCase().includes("iv_old")), "cached transitive caller survived edit");
  updateRegistryFiles(registry, [[baseFile, base]]);
  assert.deepEqual(check(), [], "reader did not recover after saved restore");
  events.length = 0;
  const store = {registry: () => registry};
  assert.throws(() => withSource(store, baseFile.slice(1), broken, () => {
    events.push("check");
    assert.ok(check().length);
    throw new Error("thrown check");
  }), /thrown check/);
  assert.deepEqual(events, ["updateFile", "parse", "check", "updateFile", "parse"]);
  assert.equal(registry.getFileByName(baseFile).getRaw(), base);
  assert.deepEqual(check(), []);
  events.length = 0;
  assert.throws(() => withSource(store, "src/osd/znew.prog.abap", "REPORT znew.", () => {
    events.push("check");
    assert.ok(registry.getObject("PROG", "ZNEW"));
    throw new Error("new check failed");
  }), /new check failed/);
  assert.deepEqual(events, ["addFile", "parse", "check", "removeFile", "parse"]);
  assert.equal(registry.getFileByName("/src/osd/znew.prog.abap"), undefined);
});

test("structural resolver exports effective syntax, new/removed packs and layer winners without checking", async () => {
  const root = mkdtempSync(join(tmpdir(), "lint-inputs-"));
  const write = (file, raw) => {mkdirSync(join(root, file, ".."), {recursive: true}); writeFileSync(join(root, file), raw);};
  try {
    write("abap_transpile.json", JSON.stringify({input_folder: ["src"], libs: []}));
    write("abaplint.jsonc", JSON.stringify({syntax: {version: "v702"}}));
    write("libs.lock.json", '{"libraries":[]}');
    write("src/ztest.prog.abap", "REPORT ztest.");
    const initial = await lintBuildSpec(root);
    assert.ok(initial.files.includes("/src/ztest.prog.abap"));
    assert.equal(JSON.parse(initial.config).syntax.version, "v702");
    assert.ok(initial.places.includes("packs"));
    write("packs/new/osd-pack.json", JSON.stringify({name: "new", abap: "src"}));
    write("packs/new/src/ztest.prog.abap", "REPORT ztest. WRITE 'override'.");
    write("abaplint.jsonc", JSON.stringify({syntax: {version: "v750"}}));
    const changed = await lintBuildSpec(root);
    assert.ok(changed.hidden.includes("src/ztest.prog.abap"));
    assert.ok(!changed.files.includes("/src/ztest.prog.abap"));
    assert.ok(changed.files.includes("/packs/new/src/ztest.prog.abap"));
    assert.ok(changed.store.roots.some(r => r.path === "packs/new/src"));
    assert.equal(JSON.parse(changed.config).syntax.version, "v750");
    rmSync(join(root, "packs/new"), {recursive: true});
    const removed = await lintBuildSpec(root);
    assert.ok(removed.files.includes("/src/ztest.prog.abap"));
    assert.deepEqual(removed.hidden, initial.hidden);
  } finally {rmSync(root, {recursive: true, force: true});}
});
