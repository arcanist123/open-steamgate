import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {execFileSync} from "node:child_process";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {createGoTestDir} from "./go-test-module.mjs";
import {lintEngineGo} from "./lint-engine.mjs";

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
}
`);
    const output = execFileSync("go", ["test", "./" + dir.slice(goRoot.length + 1)], {cwd: goRoot, encoding: "utf8", env: {...process.env, GOPROXY: "off"}});
    assert.match(output, /^ok\s/m);
  } finally {
    rmSync(source, {recursive: true, force: true});
    rmSync(goRoot, {recursive: true, force: true});
  }
});
