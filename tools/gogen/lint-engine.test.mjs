import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {createGoTestDir} from "./go-test-module.mjs";
import {lintBuildSpec, lintEngineGo, goLintEngineGo, lintBuildOptions, withGoLintModule} from "./lint-engine.mjs";
import {lintOrigin} from "../step3/lint-origin.mjs";
import {writeLintRegistryDouble} from "./lint-engine-fixture.mjs";

test("real ABAP facade indexes buckets, preserves transitive readers, and parses lazily without OSGo stubs", () => {
  const source = mkdtempSync(join(tmpdir(), "lint-index-source-"));
  const {dir, goRoot} = createGoTestDir("lint-index-go-");
  try {
    writeLintRegistryDouble(source);
    for (const name of ["zcl_osd_lint_engine", "zcx_osd_lint_engine"]) writeFileSync(join(source, name + ".clas.abap"),
      readFileSync(new URL(`../step3/abap/src/lint/${name}.clas.abap`, import.meta.url), "utf8"));
    const objects = readdirSync(source).filter(name => name.endsWith(".clas.abap")).map(name => name.split(".")[0].toUpperCase());
    const program = compileProgram({folders: [source], objects});
    assert.deepEqual(program.partial, [], "no unsupported statements");
    assert.deepEqual(program.skipped, [], "no unsupported methods");
    const code = emitGo(program);
    writeFileSync(join(dir, "zz_generated.go"), code);
    writeFileSync(join(dir, "index_test.go"), `package main
import ("fmt"; "strings"; "testing"; "osg/gogen/abap")
func TestIndex(t *testing.T) {
 s := &abap.Session{Statics: &abap.Statics{}}
 files := []ZCL_OSD_LINT_ENGINE__TY_FILE{
  {filename:"/zbase.clas.abap", raw:"ZBASE old"},
  {filename:"/zsub.clas.abap", raw:"ZSUB ZBASE"},
  {filename:"/zcaller.clas.abap", raw:"ZCALLER ZSUB"},
  {filename:"/zcaller.clas.locals_def.abap", raw:"ZBASE"},
  {filename:"/zother.clas.abap", raw:"ZOTHER"},
 }
 deps := []ZCL_OSD_LINT_ENGINE__TY_FILE{}
 ZCL_OSD_LINT_ENGINE_PRIME(s, &files, &deps, "{}")
 initial := ZCL_OSD_LINT_ENGINE_STATS(s)
 if initial.indexed_objects != 4 || initial.reader_visits != 0 { t.Fatal(initial) }
 // The host bridge uses a single blank for false, not an empty Go string.
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE old", " ")
 unchanged := ZCL_OSD_LINT_ENGINE_STATS(s)
 if unchanged.noops != 1 || unchanged.dirtied_objects != 0 || unchanged.indexed_objects != initial.indexed_objects || unchanged.reader_visits != 0 { t.Fatal("unchanged source was invalidated", unchanged) }
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE new", " ")
 changed := ZCL_OSD_LINT_ENGINE_STATS(s)
 if changed.dirtied_objects != 3 || changed.parse_runs != 0 { t.Fatal(changed) }
 ZCL_OSD_LINT_ENGINE_CHECK(s, "/zcaller.clas.abap")
 checked := ZCL_OSD_LINT_ENGINE_STATS(s)
 if checked.parse_runs != 1 || checked.parse_objects != 3 { t.Fatal(checked) }
 // Restore does not parse. A repeated no-op must not force that pending parse.
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE old", " ")
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE old", " ")
 restored := ZCL_OSD_LINT_ENGINE_STATS(s)
 if restored.dirtied_objects != 6 || restored.parse_runs != 1 || restored.noops != 2 { t.Fatal(restored) }
 ZCL_OSD_LINT_ENGINE_CHECK(s, "/zcaller.clas.abap")
 // Removing an include must remove only its old edges, retaining other files.
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zcaller.clas.locals_def.abap", "", "X")
 beforeInclude := ZCL_OSD_LINT_ENGINE_STATS(s)
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zsub.clas.abap", "ZSUB", " ")
 afterInclude := ZCL_OSD_LINT_ENGINE_STATS(s)
 if afterInclude.dirtied_objects-beforeInclude.dirtied_objects != 2 { t.Fatal("remaining include lost its readers", beforeInclude, afterInclude) }
 ZCL_OSD_LINT_ENGINE_CHECK(s, "/zcaller.clas.abap")
 before := ZCL_OSD_LINT_ENGINE_STATS(s)
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE isolated", " ")
 after := ZCL_OSD_LINT_ENGINE_STATS(s)
 if after.dirtied_objects-before.dirtied_objects != 1 { t.Fatal("stale reader edges", before, after) }
 // Removed/re-added objects get new identities; cycles must still terminate.
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zsub.clas.abap", "", "X")
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zsub.clas.abap", "ZSUB ZBASE ZCALLER", " ")
 before = ZCL_OSD_LINT_ENGINE_STATS(s)
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE cycle", " ")
 after = ZCL_OSD_LINT_ENGINE_STATS(s)
 if after.dirtied_objects-before.dirtied_objects != 3 { t.Fatal("new identity/cycle", before, after) }
 // Empty text is distinct from removal; new temporary objects leave no edges.
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/znew.clas.abap", "ZNEW ZBASE", " ")
 ZCL_OSD_LINT_ENGINE_CHECK(s, "/znew.clas.abap")
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/znew.clas.abap", "", " ")
 ZCL_OSD_LINT_ENGINE_CHECK(s, "/znew.clas.abap")
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/znew.clas.abap", "", "X")
 before = ZCL_OSD_LINT_ENGINE_STATS(s)
 ZCL_OSD_LINT_ENGINE_UPDATE(s, "/zbase.clas.abap", "ZBASE final", " ")
 after = ZCL_OSD_LINT_ENGINE_STATS(s)
 if after.dirtied_objects-before.dirtied_objects != 3 { t.Fatal("temporary identity leaked", before, after) }
}

func TestLargeIndexWork(t *testing.T) {
 s := &abap.Session{Statics: &abap.Statics{}}
 files := []ZCL_OSD_LINT_ENGINE__TY_FILE{{filename:"/ztarget.clas.abap", raw:"ZTARGET"}}
 // Many distinct words/readers expose a whole-corpus scan or bucket collision bug.
 for n:=0; n<300; n++ {
  var raw strings.Builder
  fmt.Fprintf(&raw, "ZOBJ_%d", n)
  for w:=0; w<100; w++ { fmt.Fprintf(&raw, " WORD_%d_%d", n, w) }
  files = append(files, ZCL_OSD_LINT_ENGINE__TY_FILE{filename:fmt.Sprintf("/zobj_%d.clas.abap",n), raw:raw.String()})
 }
 deps := []ZCL_OSD_LINT_ENGINE__TY_FILE{}
 ZCL_OSD_LINT_ENGINE_PRIME(s, &files, &deps, "{}")
 before := ZCL_OSD_LINT_ENGINE_STATS(s)
 for n:=0; n<2; n++ {
  ZCL_OSD_LINT_ENGINE_UPDATE(s, "/ztarget.clas.abap", "ZTARGET broken", " ")
  ZCL_OSD_LINT_ENGINE_CHECK(s, "/ztarget.clas.abap")
  ZCL_OSD_LINT_ENGINE_UPDATE(s, "/ztarget.clas.abap", "ZTARGET", " ")
 }
 after := ZCL_OSD_LINT_ENGINE_STATS(s)
 if after.dirtied_objects-before.dirtied_objects != 4 || after.parse_objects-before.parse_objects != 2 || after.parse_runs-before.parse_runs != 2 { t.Fatal(after) }
 visits := after.reader_visits-before.reader_visits
 if visits >= 30301 { t.Fatal("scanned the whole reader index", visits) }
 t.Logf("301 objects, 30301 edges, 2 install/check/restore overlays: dirtied=%d parse-runs=%d parse-objects=%d reader-visits=%d (old scans >=242408)",
  after.dirtied_objects-before.dirtied_objects, after.parse_runs-before.parse_runs, after.parse_objects-before.parse_objects, visits)
}
`);
    const output = execFileSync("go", ["test", "-v", "./" + dir.slice(goRoot.length + 1)], {cwd: goRoot, encoding: "utf8", env: {...process.env, GOPROXY: "off"}});
    assert.match(output, /^ok\s/m);
    console.log(output.trim());
  } finally {
    rmSync(source, {recursive: true, force: true});
    rmSync(goRoot, {recursive: true, force: true});
  }
});

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
 METHOD stats.
 rs_stats-updates = 42.
 ENDMETHOD.
ENDCLASS.
`);
    const code = emitGo(compileProgram({folders: [source], objects: ["ZCL_OSD_LINT_ENGINE"]}));
    writeFileSync(join(dir, "zz_generated.go"), code);
    writeFileSync(join(dir, "zz_lint.go"), lintEngineGo({config: "{}", hidden: [], files: [], guards: {}}));
    writeFileSync(join(dir, "bridge_test.go"), `package main
import ("testing"; "osg/gogen/objstore"; "osg/gogen/storecheck"; "osg/gogen/storelint")
var makeLintCompiler func(string, storecheck.Compiler) (*storelint.Compiler, string)
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
 if a.Stats().Updates != 42 { t.Fatal("stats bridge failed") }
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

test("lazy update/restore parsing preserves eager Node diagnostic tuples", async () => {
  const lint = await import("@abaplint/core");
  const {updateRegistryFiles} = await import("../osd-store-registry.mjs");
  const config = new lint.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "v702"}, rules: {check_syntax: true}}));
  const baseFile = "/src/zcl_base.clas.abap";
  const subFile = "/src/zcl_sub.clas.abap";
  const callerFile = "/src/zcl_caller.clas.abap";
  const newFile = "/src/zcl_new.clas.abap";
  const base = "CLASS zcl_base DEFINITION PUBLIC. PUBLIC SECTION. METHODS run IMPORTING iv_old TYPE i. ENDCLASS.\nCLASS zcl_base IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS.\n";
  const sub = "CLASS zcl_sub DEFINITION PUBLIC INHERITING FROM zcl_base. ENDCLASS.\nCLASS zcl_sub IMPLEMENTATION. ENDCLASS.\n";
  const caller = "CLASS zcl_caller DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS call. ENDCLASS.\nCLASS zcl_caller IMPLEMENTATION. METHOD call. DATA sub TYPE REF TO zcl_sub. CREATE OBJECT sub. sub->run( iv_old = 1 ). ENDMETHOD. ENDCLASS.\n";
  const registries = [new lint.Registry(config), new lint.Registry(config)];
  for (const registry of registries) {
    for (const [filename, raw] of [[baseFile, base], [subFile, sub], [callerFile, caller]]) registry.addFile(new lint.MemoryFile(filename, raw));
    registry.parse();
  }
  const update = (filename, source) => {
    updateRegistryFiles(registries[0], [[filename, source]]);
    const lazy = registries[1], parse = lazy.parse;
    // Keep the real Node mutation/invalidation; defer only its eager parse.
    lazy.parse = () => lazy;
    try { updateRegistryFiles(lazy, [[filename, source]]); }
    finally { lazy.parse = parse; }
  };
  const check = filename => {
    const tuples = registries.map(registry => registry.findIssuesObject(registry.findObjectForFile(registry.getFileByName(filename)))
      .map(i => [i.getKey(), i.getSeverity(), i.getFilename(), i.getStart().getRow(), i.getStart().getCol(), i.getEnd().getRow(), i.getEnd().getCol(), i.getMessage()]));
    assert.deepEqual(tuples[1], tuples[0]);
    return tuples[0];
  };
  assert.deepEqual(check(callerFile), []);
  for (let round = 0; round < 2; round++) {
    update(baseFile, base.replace("iv_old", "iv_new"));
    const changed = check(callerFile);
    assert.ok(changed.some(tuple => tuple.at(-1).toLowerCase().includes("iv_old")), JSON.stringify({round, changed}));
    update(baseFile, base);
    update(baseFile, base); // no-op must leave a pending restore intact
    assert.deepEqual(check(callerFile), []);
    update(baseFile, base.replace("METHOD run.", "METHOD run. undefined = 1."));
    assert.ok(check(baseFile).length);
    update(baseFile, base);
    assert.deepEqual(check(baseFile), []);
    update(newFile, base.replaceAll("zcl_base", "zcl_new"));
    assert.deepEqual(check(newFile), []);
    update(newFile, "");
    check(newFile);
    update(newFile, undefined);
    assert.deepEqual(check(callerFile), []);
    // Batch changes before a check, including removal and a new identity.
    update(subFile, undefined);
    update(baseFile, base.replace("iv_old", "iv_new"));
    update(subFile, sub);
    assert.ok(check(callerFile).length);
    update(baseFile, base);
    assert.deepEqual(check(callerFile), []);
  }
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


test("Go library bridge links only on request and shares CHECKRUN lifecycle with a small external package", () => {
  const lib = mkdtempSync(join(tmpdir(), "lint-external-go-"));
  const {dir, goRoot} = createGoTestDir("lint-go-bridge-");
  const modBefore = readFileSync(join(goRoot, "go.mod"), "utf8");
  const sumBefore = readFileSync(join(goRoot, "go.sum"), "utf8");
  try {
    writeFileSync(join(lib, "go.mod"), "module zabaplint\n\ngo 1.26.0\n");
    writeFileSync(join(lib, "library.go"), `package deliberately_different
 type File struct { Filename, Raw string }
 type Issue struct { Filename, Key, Severity, Message string; Row, Column, EndRow, EndColumn int32 }
 type Stats struct { Updates, Noops, IndexedObjects, ReaderVisits, DirtiedObjects, ParseRuns, ParseObjects int32 }
 type Checker struct { files map[string]string; stats Stats }
 func (c *Checker) Prime(files, deps []File, config string) {
  if config != "{}" || len(deps) != 0 { panic("bad inputs") }
  c.files = map[string]string{}
  for _, f := range files { c.files[f.Filename] = f.Raw }
 }
 func (c *Checker) Update(file string, raw *string) {
  c.stats.Updates++
  if raw == nil { delete(c.files, file) } else { c.files[file] = *raw }
 }
 func (c *Checker) Check(file string) []Issue {
  raw, found := c.files[file]
  if !found { panic("missing file") }
  if raw == "throw" { panic("refused test body") }
  return []Issue{{Filename:file, Key:"syntax", Severity:"warning", Message:raw, Row:12, Column:5}}
 }
 type Pos struct { Row,Col int32 }
 type Token struct { Str string; Start,End Pos; Pragma bool }
 type Node struct { Kind string; Statement bool; Start,End Pos; Tokens []Token; Children []Node; FirstStatement *Node }
 type FileTree struct { Filename string; Structure *Node; Statements []Node }
 func (c *Checker) CheckObject(typ,name string) ([]Issue,bool) { return nil,false }
 func (c *Checker) Tree(typ,name string) ([]FileTree,bool) { return nil,false }
 type OSGExpression struct { Kind,Text string; Children []OSGExpression }
 type OSGFile struct { Filename,Raw string }
 type OSGObject struct { Found bool; SQLView string; Components,Keys []string; Files []OSGFile; Tree *OSGExpression }
 func (c *Checker) OSGInspect(typ,name string) OSGObject { return OSGObject{} }
 func (c *Checker) Stats() Stats { return c.stats }
`);
    assert.deepEqual(lintBuildOptions([]), {engine: "abap", lib: undefined});
    assert.deepEqual(lintBuildOptions(["--lint-engine=go", "--lint-lib", lib]), {engine: "go", lib});
    for (const args of [["--lint-engine", "go"], ["--lint-lib"], ["--lint-lib="], ["--lint-engine", "automatic"], ["--echo", "--lint-lib", lib]]) {
      assert.throws(() => lintBuildOptions(args));
    }
    writeFileSync(join(dir, "zz_lint.go"), goLintEngineGo({config: "{}"}));
    writeFileSync(join(dir, "bridge_test.go"), `package main
 import("context";"strings";"testing";"osg/gogen/objstore";"osg/gogen/storecheck";"osg/gogen/storelint")
 var makeGoLintCompiler func(string, storecheck.Compiler) (*storelint.Compiler, string)
 func TestBridge(t *testing.T) {
  c, config := makeGoLintCompiler("/tree", nil)
  file := "/src/#x#ztest.clas.locals_def.abap"
  snapshot := objstore.LintSnapshot{Root:"/tree", Digest:"one", Files:[]objstore.LintFile{{Filename:file, Raw:"original"}}}
  c.Capture = func() (objstore.LintSnapshot,error) { copy := snapshot; copy.Files = append([]objstore.LintFile{},snapshot.Files...); return copy,nil }
  var logs []string
  c.Logf = func(format string, _ ...any) { logs = append(logs,format) }
  if err := c.Prime(config); err != nil { t.Fatal(err) }
  in := storecheck.Input{CheckRun:true, Root:"/tree", Type:"CLAS", Name:"/X/ZTEST", Include:"definitions", Logical:[]string{file}}
  check := func(want string) {
   t.Helper()
   issues,err := c.Check(context.Background(),in)
   if err != nil || len(issues)!=1 || issues[0].MESSAGE!=want || issues[0].LINE!=12 || issues[0].COL!=5 || issues[0].Severity!="E" || issues[0].URI!="/sap/bc/adt/oo/classes/%2Fx%2Fztest/includes/definitions" { t.Fatal(issues,err) }
  }
  check("original");check("original")
  // Separate instances retain independent registries.
  other := newGoLintEngine()
  other.Prime([]objstore.LintFile{{Filename:file, Raw:"other"}},"{}")
  check("original")
  snapshot.Digest="two";snapshot.Files[0].Raw="saved"
  check("saved")
  for _,raw:=range []string{"buffer","","throw"} {
   in.Source=&raw
   if raw=="throw" { if _,err:=c.Check(context.Background(),in);err==nil||!strings.Contains(err.Error(),"refused test body"){t.Fatal(err)} } else { check(raw) }
   in.Source=nil;check("saved")
  }
  // A new overlay is removed, including after a refused body.
  in.Name="ZNEW";in.Include="";in.Logical=nil;in.Target="/src/znew.clas.abap"
  raw:="throw";in.Source=&raw
  if _,err:=c.Check(context.Background(),in);err==nil{t.Fatal("expected refusal")}
  in.Source=nil;in.Logical=[]string{in.Target}
  if _,err:=c.Check(context.Background(),in);err==nil||!strings.Contains(err.Error(),"missing file"){t.Fatal("new overlay leaked",err)}
  if c.Engine.Name!="go" || c.Engine.Stats().Updates!=9 { t.Fatal(c.Engine.Name,c.Engine.Stats()) }
  if len(logs)==0 { t.Fatal("missing origin logs") }
 }
`);
    let temporaryMod;
    withGoLintModule(goRoot, lib, modArgs => {
      temporaryMod = modArgs[0].slice("-modfile=".length);
      const output = execFileSync("go", ["test", ...modArgs, "./" + dir.slice(goRoot.length + 1)], {cwd: goRoot, encoding: "utf8", env: {...process.env, GOPROXY: "off", GOWORK: "off"}});
      assert.match(output, /^ok\s/m);
    });
    assert.throws(() => readFileSync(temporaryMod));
    assert.equal(readFileSync(join(goRoot, "go.mod"), "utf8"), modBefore);
    assert.equal(readFileSync(join(goRoot, "go.sum"), "utf8"), sumBefore);
    assert.deepEqual(withGoLintModule(goRoot, undefined, args => args), []);
    // Existing CLI output must be rejected before starting the OSG build.
    writeFileSync(join(lib, "library.go"), "package main\n");
    assert.throws(() => lintBuildOptions(["--lint-engine", "go", "--lint-lib", lib]), /library output/);
  } finally {
    rmSync(lib, {recursive: true, force: true});
    rmSync(goRoot, {recursive: true, force: true});
  }
});


test("differential origin gate counts completed checks for the selected engine", () => {
  for (const engine of ["abap", "go"]) {
    const prime = `lint-engine=${engine} prime=1 files=5 elapsed=1s\n`;
    const entered = `lint-engine=${engine} check=1 target=/a entered=checker\n`;
    const completed = `lint-engine=${engine} check=1 issues=2 elapsed=1ms\n`;
    assert.deepEqual(lintOrigin(prime + entered), {engine, checks: 0});
    assert.deepEqual(lintOrigin(prime + entered + completed, engine), {engine, checks: 1});
    assert.throws(() => lintOrigin(prime + prime), /exactly one/);
    assert.throws(() => lintOrigin(completed), /exactly one/);
    assert.throws(() => lintOrigin(prime, engine === "abap" ? "go" : "abap"), /engine changed/);
    assert.throws(() => lintOrigin(prime + completed.replace(`=${engine}`, engine === "abap" ? "=go" : "=abap")), /mixed engines/);
  }
});
