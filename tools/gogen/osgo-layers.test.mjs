// The layered osgo build (go-layers.mjs, osgo-layers.mjs) on a small tree:
// which tier each object lands in, and that the three packages compile and
// run as one program.
import {test} from "node:test";
import assert from "node:assert/strict";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {planLayers, writeLayers} from "./go-layers.mjs";
import {editedObjects, objectOfFile, osgoTiers} from "./osgo-layers.mjs";
import {createGoTestDir} from "./go-test-module.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {home} from "./home.mjs";

const sources = {
  // a library class that uses a type the tree defines (a DDIC stub would do the same)
  "lib/zcl_lyr_lib.clas.abap": `CLASS zcl_lyr_lib DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS twice IMPORTING is_in TYPE zif_lyr_types=>ty_pair RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_lyr_lib IMPLEMENTATION.
 METHOD twice.
 rv = zcl_lyr_util=>sum( is_in ) * 2.
 ENDMETHOD.
ENDCLASS.`,
  "app/zif_lyr_types.intf.abap": `INTERFACE zif_lyr_types PUBLIC.
 TYPES: BEGIN OF ty_pair, a TYPE i, b TYPE i, END OF ty_pair.
ENDINTERFACE.`,
  // a class of the tree a library calls: it comes down to core with it
  "app/zcl_lyr_util.clas.abap": `CLASS zcl_lyr_util DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS sum IMPORTING is_pair TYPE zif_lyr_types=>ty_pair RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS zcl_lyr_util IMPLEMENTATION.
 METHOD sum.
 rv = is_pair-a + is_pair-b.
 ENDMETHOD.
ENDCLASS.`,
  "app/zcl_lyr_app.clas.abap": `CLASS zcl_lyr_app DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 TYPES: BEGIN OF ty_row, name TYPE string, value TYPE i, END OF ty_row.
 CLASS-METHODS value RETURNING VALUE(rs) TYPE ty_row.
ENDCLASS.
CLASS zcl_lyr_app IMPLEMENTATION.
 METHOD value.
 DATA ls_pair TYPE zif_lyr_types=>ty_pair.
 ls_pair-a = 1.
 ls_pair-b = 2.
 rs-name = 'app'.
 rs-value = zcl_lyr_lib=>twice( ls_pair ).
 ENDMETHOD.
ENDCLASS.`,
  // the edited class
  "app/zcl_lyr_hot.clas.abap": `CLASS zcl_lyr_hot DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_lyr_hot IMPLEMENTATION.
 METHOD run.
 DATA ls_row TYPE zcl_lyr_app=>ty_row.
 ls_row = zcl_lyr_app=>value( ).
 rv = |{ ls_row-name }={ ls_row-value }|.
 ENDMETHOD.
ENDCLASS.`,
  // calls the edited class, so it has to sit above it
  "app/zcl_lyr_top.clas.abap": `CLASS zcl_lyr_top DEFINITION PUBLIC FINAL CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_lyr_top IMPLEMENTATION.
 METHOD run.
 rv = |top:{ zcl_lyr_hot=>run( ) }|.
 ENDMETHOD.
ENDCLASS.`,
};

test("objectOfFile names the object of any of its files", () => {
  assert.equal(objectOfFile("src/x/zcl_a.clas.locals_imp.abap"), "ZCL_A");
  assert.equal(objectOfFile("#ui2#cl_json.clas.abap"), "/UI2/CL_JSON");
});

test("OSGO_HOT adds to the edited objects; a folder outside git edits nothing", () => {
  const dir = mkdtempSync(join(tmpdir(), "osgo-layers-"));
  try {
    assert.deepEqual([...editedObjects(dir, [join(dir, "src")], {OSGO_HOT: "zcl_a, ZCL_B"})].sort(), ["ZCL_A", "ZCL_B"]);
  } finally { rmSync(dir, {recursive: true, force: true}); }
});

test("tiers: libraries and what they use in core, the tree in app, the edited class and its callers in main; the packages run", () => {
  const root = mkdtempSync(join(tmpdir(), "osgo-layers-"));
  const {dir: mainDir, goRoot} = createGoTestDir("osgo-layers-go-");
  try {
    for (const [f, text] of Object.entries(sources)) { mkdirSync(join(root, f, ".."), {recursive: true}); writeFileSync(join(root, f), text); }
    const lib = join(root, "lib");
    const app = join(root, "app");
    const program = compileProgram({folders: [app, lib, libraryPath(home, "open-abap-core")], objects: Object.keys(sources).map(objectOfFile)});
    const plan = planLayers(program, osgoTiers({layers: [app], libs: [lib], hidden: new Set(), hot: new Set(["ZCL_LYR_HOT"])}));
    const tier = (name) => plan.names[plan.layer.get(name)];
    assert.equal(tier("ZCL_LYR_LIB"), "core");
    assert.equal(plan.names[plan.structLayer.get("ZIF_LYR_TYPES__TY_PAIR")], "core", "a type of the tree a library uses comes down to core");
    assert.equal(plan.names[plan.structLayer.get("ZCL_LYR_APP__TY_ROW")], "app");
    assert.equal(tier("ZCL_LYR_APP"), "app");
    assert.equal(tier("ZCL_LYR_HOT"), "main");
    assert.equal(tier("ZCL_LYR_TOP"), "main", "a caller of the edited class rises above it");
    assert.equal(tier("ZCL_LYR_UTIL"), "core", "a class of the tree a library calls comes down to core");
    assert.equal(plan.info.lowered, 1);
    assert.deepEqual(plan.info.promoted.map((p) => [p.class, p.from, p.to]), [["ZCL_LYR_TOP", "app", "main"]]);

    const pkg = `osg/gogen/cmd/${basename(mainDir)}/layers`;
    const sourcesOut = writeLayers(program, plan, {mainDir, pkgDir: (i) => join(mainDir, "layers", plan.names[i]),
      importPath: (i) => `${pkg}/${plan.names[i]}`, unitBuild: false});
    assert.equal(sourcesOut.length, 3);
    assert.match(sourcesOut[0], /^package core/m);
    assert.match(sourcesOut[2], /\. "osg\/gogen\/cmd\/.*\/layers\/app"/);
    writeFileSync(join(mainDir, "main.go"), `package main
import ("fmt"; "osg/gogen/abap")
func main() { fmt.Print(ZCL_LYR_TOP_RUN(&abap.Session{})) }
`);
    const run = spawnSync("go", ["run", `./cmd/${basename(mainDir)}`], {cwd: goRoot, encoding: "utf8", timeout: 300000, env: {...process.env, GOWORK: "off", GOFLAGS: "-buildvcs=false"}});
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stdout, "top:app=6");
  } finally {
    rmSync(root, {recursive: true, force: true});
    rmSync(goRoot, {recursive: true, force: true});
  }
});
