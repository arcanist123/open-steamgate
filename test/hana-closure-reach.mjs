import {expect} from "chai";
import {spawnSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import * as abaplint from "@abaplint/core";
import {BINDING, ENTRY_TABLE, WRITE_CALLS, callsIn, reach, summaryLines} from "../tools/hana-closure-reach.mjs";
import {libraryFiles} from "../tools/osd-inputs.mjs";

// The reads frontier's analysis (milestone 4, phase 1) over a synthetic
// island: one service (DPC/DPC_EXT, MPC/MPC_EXT) and the shapes the rules
// have to tell apart. The Gateway contract the island implements is a
// two-object stand-in, loaded as a dependency (outside the island).
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const CONFIG = {global: {files: "/**/*.*"}, syntax: {version: abaplint.Version.OpenABAP, errorNamespace: "."}, rules: {}};

const CONTRACT = {
  "#iwbep#if_mgw_appl_srv_runtime.intf.abap": `INTERFACE /iwbep/if_mgw_appl_srv_runtime PUBLIC.
  METHODS get_entityset.
  METHODS get_entity.
  METHODS create_entity.
ENDINTERFACE.`,
  "#iwbep#cl_mgw_push_abs_model.clas.abap": `CLASS /iwbep/cl_mgw_push_abs_model DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS define.
    METHODS get_last_modified.
ENDCLASS.
CLASS /iwbep/cl_mgw_push_abs_model IMPLEMENTATION.
  METHOD define.
  ENDMETHOD.
  METHOD get_last_modified.
  ENDMETHOD.
ENDCLASS.`,
};

const cls = (name, def, impl = "", head = "") => `CLASS ${name} DEFINITION PUBLIC ${head} CREATE PUBLIC.
  PUBLIC SECTION.
${def}
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
${impl}
ENDCLASS.`;
const intf = (name, body) => `INTERFACE ${name} PUBLIC.
${body}
ENDINTERFACE.`;

const ISLAND = {
  "zcl_osd_h5x_r_dpc.clas.abap": cls("zcl_osd_h5x_r_dpc", `    INTERFACES /iwbep/if_mgw_appl_srv_runtime.
  PROTECTED SECTION.
    METHODS items_get_entityset.
    METHODS items_get_entity.
    METHODS items_create_entity.`, `  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    items_get_entityset( ).
  ENDMETHOD.
  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entity.
    items_get_entity( ).
  ENDMETHOD.
  METHOD /iwbep/if_mgw_appl_srv_runtime~create_entity.
    items_create_entity( ).
  ENDMETHOD.
  METHOD items_get_entityset.
  ENDMETHOD.
  METHOD items_get_entity.
  ENDMETHOD.
  METHOD items_create_entity.
    zcl_osd_h5x_r_writer=>save( ).
    zcl_osd_h5x_r_nobody=>call( ).
  ENDMETHOD.`),
  "zcl_osd_h5x_r_dpc_ext.clas.abap": cls("zcl_osd_h5x_r_dpc_ext", `    METHODS constructor.
    DATA mo_bare TYPE REF TO zif_osd_h5x_r_bare.
    DATA mo_gone TYPE REF TO zif_osd_h5x_r_missing.
    DATA mo_used TYPE REF TO zif_osd_h5x_r_absent.
    DATA ms_row TYPE zif_osd_h5x_r_types=>ty_row.
    DATA ms_fw TYPE /osdfw/s_missing.
  PROTECTED SECTION.
    METHODS items_get_entityset REDEFINITION.
    METHODS items_get_entity REDEFINITION.
    METHODS check RAISING zcx_osd_h5x_r_error.`, `  METHOD constructor.
    super->constructor( ).
  ENDMETHOD.
  METHOD items_get_entityset.
    DATA lo_reader TYPE REF TO zif_osd_h5x_r_reader.
    DATA lo_base TYPE REF TO zcl_osd_h5x_r_base.
    DATA lo_x TYPE REF TO zcl_osd_h5x_r_gone.
    DATA lv_name TYPE string.
    DATA ls_t TYPE zosd_h5x_r_tabl.
    lo_reader = zcl_osd_h5x_r_factory=>create( ).
    lo_reader->read( ).
    CALL METHOD lo_reader->(lv_name).
    CREATE OBJECT lo_base TYPE zcl_osd_h5x_r_sub.
    lo_base->run( ).
    lo_x->get_it( ).
    lo_x->helper2( ).
    zcl_osd_h5x_r_util=>helper( ).
    zcl_osd_h5x_r_ping=>hit( ).
    mo_used->absent_go( ).
  ENDMETHOD.
  METHOD items_get_entity.
    DATA lo_leaf TYPE REF TO zcl_osd_h5x_r_leaf.
    CREATE OBJECT lo_leaf.
    lo_leaf->step( ).
  ENDMETHOD.
  METHOD check.
  ENDMETHOD.`, "INHERITING FROM zcl_osd_h5x_r_dpc"),
  "zcl_osd_h5x_r_mpc.clas.abap": cls("zcl_osd_h5x_r_mpc", `    METHODS define REDEFINITION.
    METHODS get_last_modified REDEFINITION.
    METHODS define_items.`, `  METHOD define.
    define_items( ).
  ENDMETHOD.
  METHOD get_last_modified.
  ENDMETHOD.
  METHOD define_items.
  ENDMETHOD.`, "INHERITING FROM /iwbep/cl_mgw_push_abs_model"),
  "zcl_osd_h5x_r_mpc_ext.clas.abap": cls("zcl_osd_h5x_r_mpc_ext", "    METHODS define REDEFINITION.", `  METHOD define.
    super->define( ).
  ENDMETHOD.`, "INHERITING FROM zcl_osd_h5x_r_mpc"),
  "zif_osd_h5x_r_reader.intf.abap": intf("zif_osd_h5x_r_reader", "  METHODS read.\n  METHODS fetch."),
  "zcl_osd_h5x_r_reader_a.clas.abap": cls("zcl_osd_h5x_r_reader_a", `    INTERFACES zif_osd_h5x_r_reader.
    ALIASES get_it FOR zif_osd_h5x_r_reader~fetch.`, `  METHOD zif_osd_h5x_r_reader~read.
  ENDMETHOD.
  METHOD zif_osd_h5x_r_reader~fetch.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_reader_b.clas.abap": cls("zcl_osd_h5x_r_reader_b", "    INTERFACES zif_osd_h5x_r_reader.", `  METHOD zif_osd_h5x_r_reader~read.
  ENDMETHOD.
  METHOD zif_osd_h5x_r_reader~fetch.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_reader_c.clas.abap": cls("zcl_osd_h5x_r_reader_c", "    INTERFACES zif_osd_h5x_r_reader.", `  METHOD zif_osd_h5x_r_reader~read.
  ENDMETHOD.
  METHOD zif_osd_h5x_r_reader~fetch.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_factory.clas.abap": cls("zcl_osd_h5x_r_factory", "    CLASS-METHODS create RETURNING VALUE(ro) TYPE REF TO zif_osd_h5x_r_reader.", `  METHOD create.
    DATA lo_a TYPE REF TO zcl_osd_h5x_r_reader_a.
    DATA lo_b TYPE REF TO zcl_osd_h5x_r_reader_b.
    IF sy-uname = 'A'.
      CREATE OBJECT lo_a.
      ro = lo_a.
    ELSE.
      CREATE OBJECT lo_b.
      ro = lo_b.
    ENDIF.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_base.clas.abap": cls("zcl_osd_h5x_r_base", "    METHODS run.\n    METHODS other.", `  METHOD run.
  ENDMETHOD.
  METHOD other.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_sub.clas.abap": cls("zcl_osd_h5x_r_sub", "    METHODS run REDEFINITION.", `  METHOD run.
  ENDMETHOD.`, "INHERITING FROM zcl_osd_h5x_r_base"),
  "zcl_osd_h5x_r_sub2.clas.abap": cls("zcl_osd_h5x_r_sub2", "    METHODS run REDEFINITION.", `  METHOD run.
  ENDMETHOD.`, "INHERITING FROM zcl_osd_h5x_r_base"),
  "zcl_osd_h5x_r_mid.clas.abap": cls("zcl_osd_h5x_r_mid", `    CONSTANTS c_listener TYPE i VALUE zcl_osd_h5x_r_listener=>c_one.
    METHODS step.
    EVENTS changed.
    EVENTS other.`, `  METHOD step.
    RAISE EVENT changed.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_leaf.clas.abap": cls("zcl_osd_h5x_r_leaf", "    METHODS step REDEFINITION.", `  METHOD step.
    super->step( ).
  ENDMETHOD.`, "INHERITING FROM zcl_osd_h5x_r_mid"),
  "zcl_osd_h5x_r_listener.clas.abap": cls("zcl_osd_h5x_r_listener", `    CONSTANTS c_one TYPE i VALUE 1.
    METHODS on_changed FOR EVENT changed OF zcl_osd_h5x_r_mid.
    METHODS on_other FOR EVENT other OF zcl_osd_h5x_r_mid.`, `  METHOD on_changed.
  ENDMETHOD.
  METHOD on_other.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_util.clas.abap": cls("zcl_osd_h5x_r_util", `    CLASS-METHODS class_constructor.
    CLASS-METHODS helper.
    CLASS-METHODS helper2.
    CLASS-METHODS unused.
    CLASS-METHODS deep.`, `  METHOD class_constructor.
    zcl_osd_h5x_r_registry=>init( ).
  ENDMETHOD.
  METHOD helper.
  ENDMETHOD.
  METHOD helper2.
  ENDMETHOD.
  METHOD unused.
    DATA lo TYPE REF TO object.
    DATA lv TYPE string.
    deep( ).
    CALL METHOD lo->(lv).
  ENDMETHOD.
  METHOD deep.
    zcl_osd_h5x_r_deep_only=>touch( ).
  ENDMETHOD.`),
  "zcl_osd_h5x_r_registry.clas.abap": cls("zcl_osd_h5x_r_registry", "    CLASS-METHODS init.\n    CLASS-METHODS other.", `  METHOD init.
  ENDMETHOD.
  METHOD other.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_deep_only.clas.abap": cls("zcl_osd_h5x_r_deep_only", "    CLASS-METHODS touch.", `  METHOD touch.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_writer.clas.abap": cls("zcl_osd_h5x_r_writer", "    CLASS-METHODS save.", `  METHOD save.
  ENDMETHOD.`),
  "zcl_osd_h5x_r_ping.clas.abap": cls("zcl_osd_h5x_r_ping", `    CONSTANTS c_ping TYPE i VALUE 1.
    CONSTANTS c_other TYPE i VALUE zcl_osd_h5x_r_pong=>c_pong.
    CLASS-METHODS hit.`, `  METHOD hit.
    zcl_osd_h5x_r_pong=>hit( ).
  ENDMETHOD.`),
  "zcl_osd_h5x_r_pong.clas.abap": cls("zcl_osd_h5x_r_pong", `    CONSTANTS c_pong TYPE i VALUE 2.
    CONSTANTS c_back TYPE i VALUE zcl_osd_h5x_r_ping=>c_ping.
    CLASS-METHODS hit.`, `  METHOD hit.
    zcl_osd_h5x_r_ping=>hit( ).
  ENDMETHOD.`),
  "zif_osd_h5x_r_bare.intf.abap": intf("zif_osd_h5x_r_bare", "  METHODS never."),
  "zif_osd_h5x_r_types.intf.abap": intf("zif_osd_h5x_r_types", "  TYPES: BEGIN OF ty_row,\n           a TYPE i,\n         END OF ty_row."),
  "zcx_osd_h5x_r_error.clas.abap": cls("zcx_osd_h5x_r_error", "    METHODS constructor.", `  METHOD constructor.
  ENDMETHOD.`),
};
const SERVICES = [{service: "ZOSD_H5X_R_SRV", dpc: "ZCL_OSD_H5X_R_DPC_EXT", mpc: "ZCL_OSD_H5X_R_MPC_EXT"}];

function registry(island = ISLAND, order = Object.keys(island)) {
  const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify(CONFIG)));
  for (const [name, source] of Object.entries(CONTRACT)) reg.addDependency(new abaplint.MemoryFile(name, source));
  for (const name of order) reg.addFile(new abaplint.MemoryFile(name, island[name]));
  return reg.parse();
}
const run = (options = {}, island = ISLAND, order = undefined) =>
  reach(registry(island, order), SERVICES, {frameworkNamespaces: ["/OSDFW/"], ...options});

describe("hana-closure-reach: which methods a read can reach (milestone 4, phase 1)", () => {
  let r;
  let R;
  let K;
  before(() => {
    r = run();
    R = new Map(r.reachable.map((m) => [m.method, m]));
    K = new Map(r.kept.map((k) => [k.object, k]));
  });

  it("entry points: the DPC chain's read implementations, the MPC_EXT's DEFINE, the DPC_EXT's constructor -- never a write", () => {
    const has = (m) => r.entries.find((e) => e.method === m)?.implementation;
    expect(has("/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_ENTITYSET")).to.equal("ZCL_OSD_H5X_R_DPC=>/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_ENTITYSET");
    expect(has("DEFINE")).to.equal("ZCL_OSD_H5X_R_MPC_EXT=>DEFINE");
    expect(R.get("ZCL_OSD_H5X_R_DPC_EXT=>CONSTRUCTOR").rule).to.equal("entry");
    expect(R.has("ZCL_OSD_H5X_R_DPC=>/IWBEP/IF_MGW_APPL_SRV_RUNTIME~CREATE_ENTITY")).to.equal(false);
    expect(r.entries.some((e) => e.method.endsWith("EXECUTE_ACTION"))).to.equal(false);
    expect(run({functionImports: true}).entries.some((e) => e.method.endsWith("EXECUTE_ACTION"))).to.equal(true);
    expect([...K.values()].filter((k) => k.rule === "seed").map((k) => k.object).sort())
      .to.deep.equal(["ZCL_OSD_H5X_R_DPC", "ZCL_OSD_H5X_R_DPC_EXT", "ZCL_OSD_H5X_R_MPC", "ZCL_OSD_H5X_R_MPC_EXT"]);
  });

  it("a generated DPC's own call reaches the _EXT redefinition; a redefinition in a kept subclass is reachable, one in an unkept subclass is not", () => {
    expect(R.get("ZCL_OSD_H5X_R_DPC_EXT=>ITEMS_GET_ENTITYSET").rule).to.equal("redefinition");
    expect(R.get("ZCL_OSD_H5X_R_BASE=>RUN").rule).to.equal("call");
    expect(R.get("ZCL_OSD_H5X_R_SUB=>RUN").rule).to.equal("redefinition");
    expect(K.has("ZCL_OSD_H5X_R_SUB2")).to.equal(false);
    expect(R.has("ZCL_OSD_H5X_R_SUB2=>RUN")).to.equal(false);
    expect(R.has("ZCL_OSD_H5X_R_BASE=>OTHER")).to.equal(false);
  });

  it("interface dispatch: both kept implementers are reachable, the implementer nobody names is not kept", () => {
    expect(R.get("ZCL_OSD_H5X_R_READER_A=>ZIF_OSD_H5X_R_READER~READ").rule).to.equal("interface");
    expect(R.get("ZCL_OSD_H5X_R_READER_B=>ZIF_OSD_H5X_R_READER~READ").rule).to.equal("interface");
    expect(K.has("ZCL_OSD_H5X_R_READER_C")).to.equal(false);
    expect(r.notKept).to.include("ZCL_OSD_H5X_R_READER_C");
  });

  it("a super call reaches the parent's implementation and only that", () => {
    expect(R.get("ZCL_OSD_H5X_R_MPC=>DEFINE").rule).to.equal("super");
    expect(R.has("ZCL_OSD_H5X_R_MPC=>DEFINE_ITEMS")).to.equal(true);
    expect(R.has("ZCL_OSD_H5X_R_MPC=>GET_LAST_MODIFIED")).to.equal(false);
    expect(R.get("ZCL_OSD_H5X_R_MID=>STEP").rule).to.equal("super");
  });

  it("an unresolved receiver: by method name over kept classes, an alias to the method it stands for", () => {
    expect(R.get("ZCL_OSD_H5X_R_READER_A=>ZIF_OSD_H5X_R_READER~FETCH").rule).to.equal("alias");
    expect(R.has("ZCL_OSD_H5X_R_READER_B=>ZIF_OSD_H5X_R_READER~FETCH")).to.equal(false);
    expect(R.get("ZCL_OSD_H5X_R_UTIL=>HELPER2").rule).to.equal("by-name");
  });

  it("the class constructor of a kept class runs, with what it calls", () => {
    expect(R.get("ZCL_OSD_H5X_R_UTIL=>CLASS_CONSTRUCTOR").rule).to.equal("class-constructor");
    expect(K.get("ZCL_OSD_H5X_R_REGISTRY").rule).to.equal("body");
    expect(R.get("ZCL_OSD_H5X_R_REGISTRY=>INIT").by).to.equal("ZCL_OSD_H5X_R_UTIL=>CLASS_CONSTRUCTOR");
    expect(R.has("ZCL_OSD_H5X_R_REGISTRY=>OTHER")).to.equal(false);
  });

  it("a bare TYPE REF TO is a shell, a qualified type and a RAISING are hard; a dereferenced shell is promoted", () => {
    const shells = new Map(r.shells.map((s) => [s.name, s]));
    expect(shells.get("ZIF_OSD_H5X_R_BARE")?.present).to.equal(true);
    expect(shells.get("ZIF_OSD_H5X_R_MISSING")?.present).to.equal(false);
    expect(K.has("ZIF_OSD_H5X_R_BARE")).to.equal(false);
    expect(K.get("ZIF_OSD_H5X_R_TYPES").rule).to.equal("qualified");
    expect(K.get("ZCX_OSD_H5X_R_ERROR").rule).to.equal("raising");
    const bare = r.definitionDependencies.find((d) => d.to === "ZIF_OSD_H5X_R_BARE");
    expect(bare).to.include({from: "ZCL_OSD_H5X_R_DPC_EXT", carrier: "ref", hard: false, file: "zcl_osd_h5x_r_dpc_ext.clas.abap", line: 4});
    expect(r.promoted.map((p) => p.name)).to.deep.equal(["ZIF_OSD_H5X_R_ABSENT"]);
    const would = r.asks.would.map((a) => a.name);
    expect(would).to.include("ZIF_OSD_H5X_R_ABSENT");
    expect(would).to.not.include("ZIF_OSD_H5X_R_MISSING");
    expect(r.asks.wouldNot.find((a) => a.name === "ZIF_OSD_H5X_R_MISSING").evidence[0].why).to.equal("shell");
  });

  it("names in a reachable body are asked eagerly, code and DDIC; a library namespace is never asked", () => {
    const would = new Map(r.asks.would.map((a) => [a.name, a]));
    expect(would.get("ZCL_OSD_H5X_R_GONE")).to.include({class: "code"});
    expect(would.get("ZCL_OSD_H5X_R_GONE").evidence[0].level).to.equal("method");
    expect(would.get("ZOSD_H5X_R_TABL")).to.include({class: "ddic"});
    expect(would.has("/OSDFW/S_MISSING")).to.equal(false);
    expect(r.asks.framework.map((a) => a.name)).to.deep.equal(["/OSDFW/S_MISSING"]);
  });

  it("dynamic constructs and events on read paths are recorded, never followed; off the read path they are not", () => {
    expect(r.dynamic.map((d) => `${d.kind} ${d.method}`)).to.deep.equal([
      "dynamic method call ZCL_OSD_H5X_R_DPC_EXT=>ITEMS_GET_ENTITYSET",
      "event ZCL_OSD_H5X_R_MID=>STEP",
    ]);
    expect(R.get("ZCL_OSD_H5X_R_LISTENER=>ON_CHANGED").rule).to.equal("event");
    expect(R.has("ZCL_OSD_H5X_R_LISTENER=>ON_OTHER")).to.equal(false);
  });

  it("a method only an unreachable method calls stays unreachable, and its names are not asked", () => {
    for (const m of ["ZCL_OSD_H5X_R_UTIL=>UNUSED", "ZCL_OSD_H5X_R_UTIL=>DEEP", "ZCL_OSD_H5X_R_DPC=>ITEMS_CREATE_ENTITY"]) {
      expect(R.has(m), m).to.equal(false);
    }
    expect(K.has("ZCL_OSD_H5X_R_DEEP_ONLY")).to.equal(false);
    expect(K.has("ZCL_OSD_H5X_R_WRITER")).to.equal(false);
    expect(r.unreachable.ZCL_OSD_H5X_R_UTIL).to.deep.equal(["ZCL_OSD_H5X_R_UTIL=>DEEP", "ZCL_OSD_H5X_R_UTIL=>UNUSED"]);
    expect(r.asks.would.map((a) => a.name)).to.not.include("ZCL_OSD_H5X_R_NOBODY");
    expect(r.asks.wouldNot.find((a) => a.name === "ZCL_OSD_H5X_R_NOBODY").evidence[0].why).to.equal("unreachable method");
  });

  it("cycles close: two classes that name and call each other are both kept, both calls reachable", () => {
    expect(K.has("ZCL_OSD_H5X_R_PING")).to.equal(true);
    expect(K.has("ZCL_OSD_H5X_R_PONG")).to.equal(true);
    expect(R.has("ZCL_OSD_H5X_R_PING=>HIT")).to.equal(true);
    expect(R.get("ZCL_OSD_H5X_R_PONG=>HIT").by).to.equal("ZCL_OSD_H5X_R_PING=>HIT");
  });

  it("is deterministic: the island added in any order gives the same result", () => {
    const names = Object.keys(ISLAND);
    const shuffled = [names.slice().reverse(), names.slice(7).concat(names.slice(0, 7)), names.filter((_, i) => i % 2).concat(names.filter((_, i) => i % 2 === 0))];
    const base = JSON.stringify(r);
    for (const order of shuffled) expect(JSON.stringify(run({}, ISLAND, order))).to.equal(base);
  });

  it("the tripwire and the alarm are reported, never applied", () => {
    const tight = run({cap: 3, alarms: [{label: "tooling", pattern: "_PING$"}]});
    expect(tight.tripwire).to.include({keptCodeObjects: tight.kept.length, cap: 3, overCap: true});
    expect(tight.kept.length).to.equal(r.kept.length);
    expect(tight.alarms.map((a) => a.object)).to.deep.equal(["ZCL_OSD_H5X_R_PING"]);
    expect(tight.alarms[0].chain.at(-1)).to.match(/seed/);
    expect(summaryLines(tight).some((l) => l.startsWith("frontier alarm: ZCL_OSD_H5X_R_PING"))).to.equal(true);
  });
});

describe("hana-closure-reach: the entry table is what src/gateway calls on a GET", function () {
  this.timeout(120000);
  it("ENTRY_TABLE + WRITE_CALLS are exactly the DPC, model and registry calls of the binding classes", () => {
    const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify(CONFIG)));
    const add = (file, dep) => {
      const f = new abaplint.MemoryFile(file.split("/").pop(), readFileSync(file, "utf8"));
      if (dep) reg.addDependency(f);
      else reg.addFile(f);
    };
    const libs = libraryFiles(ROOT).filter((l) => /open-abap-(odata|core)$/.test(l.folder));
    expect(libs.map((l) => l.folder).sort(), "the binding needs the odata and core libraries cloned (.local/lars)").to.have.length(2);
    for (const lib of libs) for (const f of lib.files) if (/\.(abap|xml)$/.test(f)) add(f, true);
    for (const f of spawnSync("git", ["ls-files", "src/gateway"], {cwd: ROOT, encoding: "utf8"}).stdout.split("\n")) {
      if (/\.(abap|xml)$/.test(f) && /testclasses/.test(f) === false) add(join(ROOT, f), false);
    }
    reg.parse();
    const found = new Set();
    for (const [name, b] of Object.entries(BINDING)) {
      for (const c of callsIn(reg, name, b.targets, b.methods)) found.add(`${c.target}|${c.call ?? c.method}|${c.caller}`);
    }
    const table = new Set();
    for (const row of [...ENTRY_TABLE, ...WRITE_CALLS]) {
      for (const caller of row.callers) table.add(`${row.via}|${row.call ?? row.method}|${caller}`);
    }
    expect([...found].sort()).to.deep.equal([...table].sort());
  });
});

describe("hana-closure-reach: the CLI", function () {
  this.timeout(180000);
  it("reads an island folder and a registration, prints the summary and writes sorted JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "osd-reach-"));
    try {
      mkdirSync(join(dir, "island", "pkg"), {recursive: true});
      for (const [name, source] of Object.entries(ISLAND)) writeFileSync(join(dir, "island", "pkg", name), source);
      writeFileSync(join(dir, "services.json"), JSON.stringify({services: SERVICES}));
      const out = spawnSync(process.execPath, [join(ROOT, "tools", "hana-closure-reach.mjs"), "--island", join(dir, "island"),
        "--services", join(dir, "services.json"), "--json", join(dir, "out.json"), "--framework-namespace", "/OSDFW/"], {encoding: "utf8"});
      expect(out.status, out.stderr).to.equal(0);
      expect(out.stdout).to.match(/^reads frontier: 1 service\(s\)/);
      const json = JSON.parse(readFileSync(join(dir, "out.json"), "utf8"));
      expect(json.reachable.map((m) => m.method)).to.include("ZCL_OSD_H5X_R_READER_B=>ZIF_OSD_H5X_R_READER~READ");
      expect(json.kept.find((k) => k.object === "ZCL_OSD_H5X_R_PING").package).to.equal("pkg");
      expect(json.namespaceSource).to.equal("--framework-namespace");
      expect(spawnSync(process.execPath, [join(ROOT, "tools", "hana-closure-reach.mjs")], {encoding: "utf8"}).status).to.equal(2);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
