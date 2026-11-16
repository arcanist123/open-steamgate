// The closure on a second service (milestone 4): the five iterator defects
// the five-service family run and the second-service run measured, and the
// kernel-splice refusal, each as a fake-dumper loop scenario
// (test/helpers/hana-closure-fakes.mjs: the real hana-src-gen, a fake dumper
// answering from a staged tenant folder). Synthetic names only.
import {expect} from "chai";
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import * as abaplint from "@abaplint/core";
import {Transpiler} from "@abaplint/transpiler";
import {run} from "../tools/hana-closure.mjs";
import {buildCheck} from "../tools/hana-closure-merge.mjs";
import {cycleName} from "../tools/hana-src-gen.mjs";
import {kernelSplices} from "../tools/hana-closure-intake.mjs";
import {objectNameInFinding} from "../tools/hana-closure-framework.mjs";
import {seedServices} from "../tools/hana-closure-seed.mjs";
import {dumperRequests, outFile, readJson, scratchClosure} from "./helpers/hana-closure-fakes.mjs";

const cls = (name, publicSection, methods) => [
  `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.`,
  `  PUBLIC SECTION.`,
  ...publicSection.map((l) => `    ${l}`),
  `ENDCLASS.`,
  `CLASS ${name} IMPLEMENTATION.`,
  ...Object.entries(methods).flatMap(([m, body]) => [`  METHOD ${m}.`, ...body.map((l) => `    ${l}`), `  ENDMETHOD.`]),
  `ENDCLASS.`,
  ``,
].join("\n");

const DEP = cls("zcl_osd_h5x_dep", ["CLASS-METHODS run."], {run: ["RETURN."]});
const SEED_NEEDS_DEP = cls("zcl_osd_h5x_seed", ["METHODS run_it."], {run_it: ["DATA lo_dep TYPE REF TO zcl_osd_h5x_dep.", "CREATE OBJECT lo_dep."]});
const ARGS = (seedDump) => ["--dump", seedDump, "--system", "h5x", "--stub-unresolved"];
const requestedOf = (root) => dumperRequests(root).map((r) => r.requested);
const allRequested = (root) => requestedOf(root).flatMap((r) => Object.values(r).flat());

describe("hana-closure milestone 4: the closure on a second service", function () {
  this.timeout(300000);
  const roots = [];
  const make = (opts) => {
    const s = scratchClosure(opts);
    roots.push(s.root);
    return s;
  };
  const lines = [];
  const say = (m) => lines.push(m);
  after(() => {
    for (const root of roots) rmSync(root, {recursive: true, force: true});
  });

  it("1: a 40-package cycle is one layer of a bounded name, its members in members.json", async () => {
    const {root, env, seedDump} = make({seed: {"zcl_osd_h5x_seed.clas.abap": SEED_NEEDS_DEP},
      tenant: {"zcl_osd_h5x_dep.clas.abap": DEP}, env: {H5X_CYCLE: "40"}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    const folders = readdirSync(join(root, "gen", "hana-src")).filter((f) => f !== "manifest.json");
    const cycle = folders.find((f) => f.includes("-cycle-"));
    expect(cycle, folders.join(", ")).to.not.equal(undefined);
    expect(cycle.length, "a bounded name").to.be.below(80);
    expect(cycle).to.match(/^001-cycle-osg-zosd-h5x-basis-package-with-a-long-n-40-[0-9a-f]{10}$/);
    const members = readJson(join(root, "gen", "hana-src", cycle, "members.json"));
    expect(members.cycle).to.have.lengthOf(40);
    expect(members.name).to.equal(cycle.replace(/^\d+-/, ""));
    expect(readdirSync(join(root, "gen", "hana-src", cycle, "src"))).to.include("zcl_osd_h5x_dep.clas.abap");
    const manifest = readJson(join(root, "gen", "hana-src", "manifest.json"));
    expect(manifest.layers.find((l) => l.cycle !== undefined).cycle).to.have.lengthOf(40);
    // the name is the members' and nothing else's: order does not move it
    expect(cycleName(["b", "a", "c"])).to.equal(cycleName(["c", "b", "a"]));
  });

  it("2: names of a library namespace are framework gaps, never asked, never merged from a dump", async () => {
    const lib = {"#zosdh5x#cl_provided.clas.abap": cls("/zosdh5x/cl_provided", ["CLASS-METHODS run."], {run: ["RETURN."]})};
    const seed = cls("zcl_osd_h5x_seed", ["METHODS a.", "METHODS b.", "METHODS c.", "METHODS d."], {
      a: ["/zosdh5x/cl_absent=>run( )."],
      b: ["DATA lo_x TYPE REF TO /zosdh5x/if_absent.", "CLEAR lo_x."],
      c: ["DATA lt_x TYPE /zosdh5x/tt_absent.", "CLEAR lt_x."],
      d: ["/zosdh5x/cl_provided=>run( )."],
    });
    // the seed dump carries one framework-namespace object anyway: refused
    const absent = cls("/zosdh5x/cl_absent", ["CLASS-METHODS run."], {run: ["RETURN."]});
    const {root, env, seedDump} = make({lib, seed: {"zcl_osd_h5x_seed.clas.abap": seed, "#zosdh5x#cl_absent.clas.abap": absent}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    expect(allRequested(root).filter((n) => n.startsWith("/ZOSDH5X/")), "never asked").to.deep.equal([]);
    const gaps = readJson(outFile(root, "framework-gaps.json"));
    const named = gaps.filter((g) => g.name !== undefined);
    expect(named.map((g) => g.name)).to.include.members(["/ZOSDH5X/CL_ABSENT", "/ZOSDH5X/IF_ABSENT", "/ZOSDH5X/TT_ABSENT"]);
    expect(named.find((g) => g.name === "/ZOSDH5X/CL_ABSENT").refused_from_dump).to.equal(true);
    expect(named.find((g) => g.name === "/ZOSDH5X/IF_ABSENT").used_by[0].file).to.equal("zcl_osd_h5x_seed.clas.abap");
    expect(named.find((g) => g.name === "/ZOSDH5X/TT_ABSENT").used_by).to.not.be.empty;
    const layer = readdirSync(join(root, "gen", "hana-src")).find((f) => f !== "manifest.json");
    expect(readdirSync(join(root, "gen", "hana-src", layer, "src")), "refused at the merge").to.deep.equal(["zcl_osd_h5x_seed.clas.abap"]);
    const stubbed = readJson(outFile(root, "closure-stubs.json")).stubs.map((s) => s.method).sort();
    expect(stubbed).to.deep.equal(["A", "B", "C"]);
  });

  it("3: the object-naming wordings a classifier leaves nameless carry their name", () => {
    expect(objectNameInFinding(`Class or type "cl_osd_h5x_helper" not found`)).to.deep.equal({name: "CL_OSD_H5X_HELPER", kind: "clas"});
    expect(objectNameInFinding("Loop, not a table type, Could not resolve top /ZOSDH5X/IF_X")).to.deep.equal({name: "/ZOSDH5X/IF_X", kind: "intf"});
    expect(objectNameInFinding(`Method "get_x" not found`)).to.equal(undefined);
  });

  it("3: a class named only by a static call in a method body is asked first, and the body stays", async () => {
    const seed = cls("zcl_osd_h5x_seed", ["METHODS constructor."], {constructor: ["zcl_osd_h5x_helper=>check( )."]});
    const helper = cls("zcl_osd_h5x_helper", ["CLASS-METHODS check."], {check: ["RETURN."]});
    const {root, env, seedDump} = make({seed: {"zcl_osd_h5x_seed.clas.abap": seed}, tenant: {"zcl_osd_h5x_helper.clas.abap": helper}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    expect(requestedOf(root)[0].CLAS, "asked in the first request").to.include("ZCL_OSD_H5X_HELPER");
    expect(readJson(outFile(root, "closure-stubs.json")).stubs, "the dumper brought it: nothing stubbed").to.deep.equal([]);
    const request = readJson(outFile(root, "closure-request.json"));
    expect(request.deferred.CLAS).to.deep.equal([]);
  });

  it("3: answered missing, the method is stubbed with the name in its raise", async () => {
    const seed = cls("zcl_osd_h5x_seed", ["METHODS constructor."], {constructor: ["zcl_osd_h5x_helper=>check( )."]});
    const {root, env, seedDump} = make({seed: {"zcl_osd_h5x_seed.clas.abap": seed}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    expect(requestedOf(root)[0].CLAS).to.include("ZCL_OSD_H5X_HELPER");
    const stubs = readJson(outFile(root, "closure-stubs.json")).stubs;
    expect(stubs.map((s) => [s.method, s.missing])).to.deep.equal([["CONSTRUCTOR", ["ZCL_OSD_H5X_HELPER"]]]);
    expect(readJson(outFile(root, "closure-gaps.json")).gaps.map((g) => g.name)).to.include("ZCL_OSD_H5X_HELPER");
  });

  // a family seed: two services (one SEGW pair, one hand-written DPC) of the
  // seed package, and a registration row of a service outside it
  const FAMILY = (() => {
    const tadir = (name) => ({PGMID: "R3TR", OBJECT: "CLAS", OBJ_NAME: name, DEVCLASS: "$ZOSD_H5X_FAM"});
    return {
      seedManifest: {packages: ["$ZOSD_H5X_FAM"]},
      seedTables: {
        TADIR: ["ZCL_ZOSD_H5X_A_DPC_EXT", "ZCL_ZOSD_H5X_A_MPC_EXT", "ZCL_OSD_H5X_GW_DP", "ZCL_OSD_H5X_GW_MP"].map(tadir),
        "/IWBEP/I_MGW_SRH": [
          {TECHNICAL_NAME: "ZOSD_H5X_A_SRV", VERSION: "0001", CLASS_NAME: "ZCL_ZOSD_H5X_A_DPC_EXT", EXTERNAL_NAME: "ZOSD_H5X_A_SRV"},
          {TECHNICAL_NAME: "ZOSD_H5X_W", VERSION: "0001", CLASS_NAME: "ZCL_OSD_H5X_GW_DP", EXTERNAL_NAME: "ZOSD_H5X_W"},
          {TECHNICAL_NAME: "ZOSD_H5X_OTHER_SRV", VERSION: "0001", CLASS_NAME: "ZCL_ZOSD_H5X_OTHER_DPC_EXT", EXTERNAL_NAME: "ZOSD_H5X_OTHER_SRV"},
        ],
        "/IWBEP/I_MGW_SRG": [
          {GROUP_TECH_NAME: "ZOSD_H5X_A_SRV", GROUP_VERSION: "0001", MODEL_TECH_NAME: "ZOSD_H5X_A_MDL", MODEL_VERSION: "0001"},
          {GROUP_TECH_NAME: "ZOSD_H5X_W", GROUP_VERSION: "0001", MODEL_TECH_NAME: "ZOSD_H5X_W_MDL", MODEL_VERSION: "0001"},
          {GROUP_TECH_NAME: "ZOSD_H5X_OTHER_SRV", GROUP_VERSION: "0001", MODEL_TECH_NAME: "ZOSD_H5X_OTHER_MDL", MODEL_VERSION: "0001"},
        ],
        "/IWBEP/I_MGW_OHD": [
          {TECHNICAL_NAME: "ZOSD_H5X_A_MDL", VERSION: "0001", CLASS_NAME: "ZCL_ZOSD_H5X_A_MPC_EXT"},
          {TECHNICAL_NAME: "ZOSD_H5X_W_MDL", VERSION: "0001", CLASS_NAME: "ZCL_OSD_H5X_GW_MP"},
          {TECHNICAL_NAME: "ZOSD_H5X_OTHER_MDL", VERSION: "0001", CLASS_NAME: "ZCL_ZOSD_H5X_OTHER_MPC_EXT"},
        ],
      },
      src: {"zif_osd_h5x_runtime.intf.abap": "INTERFACE zif_osd_h5x_runtime PUBLIC.\n  METHODS get_entityset.\nENDINTERFACE.\n"},
      seed: {
        "zcl_zosd_h5x_a_dpc_ext.clas.abap": cls("zcl_zosd_h5x_a_dpc_ext", ["METHODS run."], {run: ["RETURN."]}),
        "zcl_zosd_h5x_a_mpc_ext.clas.abap": cls("zcl_zosd_h5x_a_mpc_ext", ["METHODS define."], {define: ["RETURN."]}),
        "zcl_osd_h5x_gw_dp.clas.abap": cls("zcl_osd_h5x_gw_dp", ["INTERFACES zif_osd_h5x_runtime."],
          {"zif_osd_h5x_runtime~get_entityset": ["zcl_osd_h5x_gone=>run( )."]}),
        "zcl_osd_h5x_gw_mp.clas.abap": cls("zcl_osd_h5x_gw_mp", ["METHODS define."], {define: ["RETURN."]}),
      },
    };
  })();

  it("4: the seed's services are derived from its own rows -- a hand-written DPC among them, another service's row not", async () => {
    const {root, env, seedDump} = make(FAMILY);
    expect(seedServices(seedDump).map((s) => s.service)).to.deep.equal(["ZOSD_H5X_A_SRV", "ZOSD_H5X_W"]);
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    const facts = readJson(join(root, "gen", "hana-segw", "from-dump.json"));
    expect(facts.selection).to.equal("seed");
    expect(facts.services.map((s) => s.dpc)).to.deep.equal(["ZCL_ZOSD_H5X_A_DPC_EXT", "ZCL_OSD_H5X_GW_DP"]);
    const summary = readJson(outFile(root, "closure-summary.json"));
    expect(summary.seed.classes).to.include.members(["ZCL_OSD_H5X_GW_DP", "ZCL_OSD_H5X_GW_MP", "ZCL_ZOSD_H5X_A_DPC_EXT", "ZCL_ZOSD_H5X_A_MPC_EXT"]);
    expect(summary.seed.classes).to.not.include("ZCL_ZOSD_H5X_OTHER_DPC_EXT");
    // the interface-method implementation of the hand-written DPC is a seed
    // method the guard sees, `~` and all
    expect(summary.seed.stubbed_methods).to.deep.include({class: "ZCL_OSD_H5X_GW_DP", method: "ZIF_OSD_H5X_RUNTIME~GET_ENTITYSET"});
    expect(summary.seed_services.map((s) => s.service)).to.deep.equal(["ZOSD_H5X_A_SRV", "ZOSD_H5X_W"]);
  });

  it("5: function modules are findings: counted, FUNC gaps, the caller stubbed with the module named, never asked", async () => {
    const fugr = {
      "zosd_h5x_fg.fugr.xml": `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_FUGR" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>
 <AREAT>h5x</AREAT>
 <INCLUDES><SOBJ_NAME>SAPLZOSD_H5X_FG</SOBJ_NAME></INCLUDES>
 <FUNCTIONS><item><FUNCNAME>ZOSD_H5X_PRESENT_FM</FUNCNAME><SHORT_TEXT>h5x</SHORT_TEXT></item></FUNCTIONS></asx:values></asx:abap>
</abapGit>
`,
      "zosd_h5x_fg.fugr.saplzosd_h5x_fg.abap": "FUNCTION-POOL zosd_h5x_fg.\n",
      "zosd_h5x_fg.fugr.zosd_h5x_present_fm.abap": "FUNCTION zosd_h5x_present_fm.\n  RETURN.\nENDFUNCTION.\n",
    };
    const seed = cls("zcl_osd_h5x_seed", ["METHODS absent.", "METHODS present.", "METHODS dynamic."], {
      absent: ["CALL FUNCTION 'ZOSD_H5X_ABSENT_FM'."],
      present: ["CALL FUNCTION 'ZOSD_H5X_PRESENT_FM'."],
      dynamic: ["DATA lv_name TYPE string.", "lv_name = 'ZOSD_H5X_PRESENT_FM'.", "CALL FUNCTION lv_name."],
    });
    const {root, env, seedDump} = make({src: fugr, seed: {"zcl_osd_h5x_seed.clas.abap": seed}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    const fm = readJson(outFile(root, "closure-summary.json")).function_modules;
    expect([fm.called, fm.present, fm.absent, fm.dynamic]).to.deep.equal([2, 1, 1, 1]);
    expect(fm.by_name.find((m) => m.name === "ZOSD_H5X_ABSENT_FM")).to.deep.include({present: false});
    const funcGap = readJson(outFile(root, "closure-gaps.json")).gaps.find((g) => g.kind === "FUNC");
    expect(funcGap.name).to.equal("ZOSD_H5X_ABSENT_FM");
    expect(funcGap.used_by).to.deep.equal([{file: "zcl_osd_h5x_seed.clas.abap", line: 9}]);
    const stubs = readJson(outFile(root, "closure-stubs.json")).stubs;
    expect(stubs.map((s) => s.method)).to.deep.equal(["ABSENT"]);
    const layer = readdirSync(join(root, "gen", "hana-src")).find((f) => f !== "manifest.json");
    expect(readFileSync(join(root, "gen", "hana-src", layer, "src", "zcl_osd_h5x_seed.clas.abap"), "utf8"))
      .to.include("missing = 'function module ZOSD_H5X_ABSENT_FM not in the island'");
    expect(allRequested(root), "the dumper is not asked for function groups").to.deep.equal([]);
  });

  it("6: a delivered class with a kernel splice is refused at the merge, reported, and never reaches the generated module", async () => {
    const spliced = cls("zcl_osd_h5x_dep", ["CLASS-METHODS run."], {run: ["WRITE '@KERNEL globalThis.h5xSplice = 1;'."]});
    expect(kernelSplices("zcl_osd_h5x_dep.clas.abap", spliced)).to.deep.equal([{line: 7, text: "WRITE '@KERNEL globalThis.h5xSplice = 1;'."}]);
    expect(kernelSplices("zcl_osd_h5x_dep.clas.abap", spliced.replace("'@KERNEL", "'@kernel")), "a superset of the transpiler's case-sensitive test").to.have.lengthOf(1);
    expect(kernelSplices("zcl_osd_h5x_dep.clas.abap", spliced.replace("WRITE '@KERNEL", "DATA(lv) = '@KERNEL")), "a literal outside WRITE is no splice").to.deep.equal([]);
    // and a delivered object named like the runtime's own kernel classes
    const kernelLock = cls("kernel_lock", ["CLASS-METHODS run."], {run: ["RETURN."]});
    const {root, env, seedDump} = make({seed: {"zcl_osd_h5x_seed.clas.abap": SEED_NEEDS_DEP, "kernel_lock.clas.abap": kernelLock},
      tenant: {"zcl_osd_h5x_dep.clas.abap": spliced}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    const gap = readJson(outFile(root, "closure-gaps.json")).gaps.find((g) => g.name === "ZCL_OSD_H5X_DEP");
    expect(gap).to.deep.include({reason: "kernel splice", first_finding: "kernel splice, zcl_osd_h5x_dep.clas.abap:7"});
    expect(readJson(outFile(root, "closure-summary.json")).refused.map((r) => [r.name, r.reason]))
      .to.deep.equal([["KERNEL_LOCK", "kernel name"], ["ZCL_OSD_H5X_DEP", "kernel splice"]]);
    const delivered = readdirSync(join(root, "gen", "hana-src")).filter((f) => f !== "manifest.json")
      .flatMap((f) => readdirSync(join(root, "gen", "hana-src", f, "src")));
    expect(delivered).to.deep.equal(["zcl_osd_h5x_seed.clas.abap"]);
    // what the build would transpile: the island and this tree's src --
    // the splice is in no generated module
    const reg = new abaplint.Registry();
    const walk = (dir) => {
      for (const e of readdirSync(dir, {withFileTypes: true})) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else if (/\.abap$/.test(e.name)) reg.addFile(new abaplint.MemoryFile(e.name, readFileSync(join(dir, e.name), "utf8")));
      }
    };
    walk(join(root, "gen", "hana-src"));
    walk(join(root, "src"));
    const output = await new Transpiler({ignoreSyntaxCheck: true, unknownTypes: "runtimeError"}).run(reg);
    const js = output.objects.map((o) => o.chunk?.raw ?? o.js?.contents ?? "").join("\n");
    expect(js).to.include("osdNotActivated", "the tree's own splice is honoured (the positive control)");
    expect(js).to.not.include("h5xSplice");
  });

  it("6: a delivered layer already on disk with a kernel splice fails the build closed", () => {
    const {root, env} = make({});
    const dir = join(root, "gen", "hana-src", "000-h5x-old", "src");
    mkdirSync(dir, {recursive: true});
    writeFileSync(join(dir, "zcl_osd_h5x_old.clas.abap"), cls("zcl_osd_h5x_old", ["CLASS-METHODS run."], {run: ["WRITE '@KERNEL globalThis.h5xSplice = 1;'."]}));
    expect(() => buildCheck({root, env, say})).to.throw(/refused: kernel splice in a delivered layer -- gen\/hana-src\/000-h5x-old\/src\/zcl_osd_h5x_old\.clas\.abap:7/);
    expect(existsSync(join(root, "output")), "the build never ran").to.equal(false);
  });
});
