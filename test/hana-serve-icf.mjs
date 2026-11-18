import {expect} from "chai";
import {spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {tenantServices} from "../tools/hana-serve-icf.mjs";
import {cut, islandObjects, identifiers} from "../tools/hana-serve-scope.mjs";
import {excludedObjectFiles, serveScopeUnreachedTables} from "../tools/hana-closure-exclusions.mjs";
import {fragments, joinFragments, mimeBytes, mimeCluster, parseCluster, SAPClusterError} from "../tools/protocols/sap-cluster.mjs";

// docs/hana-serve-icf.md: the tenant's ICF tree as routes, SMW0 objects out
// of WWWDATA clusters, and the serve scope that cuts a rescued island to
// what its roots reach. Every row and byte here is synthetic: the clusters
// come from this tree's own writer, never from a system.

const FF = "F".repeat(25);
const g = (n) => `B${String(n).padStart(24, "0")}`;
const node = (name, parent, guid, alt = "") => ({ICF_NAME: name, ICFPARGUID: parent, ICFNODGUID: guid, ICFALTNME: alt});
const handler = (name, parent, cls, order = "01", typ = "A") => ({ICF_NAME: name, ICFPARGUID: parent, ICFORDER: order, ICFTYP: typ, ICFHANDLER: cls});

describe("hana-serve-icf: the tenant's ICF tree as routes", () => {
  const ICFSERVICE = [
    node("DEFAULT_HOST", FF, g(1)), node("SAP", g(1), g(2)), node("BC", g(2), g(3)),
    node("ZB3APP", g(3), g(4)), node("ZB3SUB", g(4), g(5)),
    node("A0B3LONG", g(3), g(6), "ZB3_Long_External"),
    node("OTHER_HOST", FF, g(7)), node("ZB3ELSE", g(7), g(8)),
    node("ZB3ORPHAN", g(99), g(9)), node("ZB3PLAIN", g(3), g(10)),
  ];
  const ICFHANDLER = [
    handler("ZB3APP", g(3), "ZCL_B3_FIRST", "01"), handler("ZB3APP", g(3), "ZCL_B3_LAST", "02"),
    handler("ZB3SUB", g(4), "ZCL_B3_SUB"), handler("A0B3LONG", g(3), "ZCL_B3_LONG"),
    handler("ZB3ELSE", g(7), "ZCL_B3_ELSE"), handler("ZB3ORPHAN", g(99), "ZCL_B3_ORPHAN"),
    handler("ZB3PLAIN", g(3), "ZCL_B3_PLAIN", "01", "X"),
  ];

  it("builds each path by the parent walk below DEFAULT_HOST, external name first, longest path first", () => {
    const {services, counts} = tenantServices({ICFSERVICE, ICFHANDLER});
    expect(services.map((s) => [s.path, s.handler, s.type])).to.deep.equal([
      ["/sap/bc/zb3_long_external", "ZCL_B3_LONG", "ABAP"],
      ["/sap/bc/zb3app/zb3sub", "ZCL_B3_SUB", "ABAP"],
      ["/sap/bc/zb3plain", "ZCL_B3_PLAIN", "X"],
    ]);
    expect(services.every((s) => s.active === true)).to.equal(true);
    // the other host's node and the orphan are counted, never served; a
    // chain of two handlers is not one this host runs
    expect(counts).to.deep.include({nodes: 10, orphans: 2, withHandler: 6, inactive: 0, activation: "unknown", multiHandler: ["/sap/bc/zb3app"]});
  });

  it("honours ICFSERVLOC: a node is served when it and every node above it below the host is active", () => {
    const active = (name, parent, flag = "X") => ({ICF_NAME: name, ICFPARGUID: parent, ICFACTIVE: flag});
    const ICFSERVLOC = [active("SAP", g(1)), active("BC", g(2)), active("ZB3APP", g(3), ""), active("ZB3SUB", g(4)),
      active("A0B3LONG", g(3)), active("ZB3PLAIN", g(3))];
    const {services, counts} = tenantServices({ICFSERVICE, ICFHANDLER, ICFSERVLOC});
    // ZB3SUB is active, its parent ZB3APP is not: neither is served
    expect(services.map((s) => s.path)).to.deep.equal(["/sap/bc/zb3_long_external", "/sap/bc/zb3plain"]);
    expect(counts).to.deep.include({inactive: 2, activation: "ICFSERVLOC"});
    // no row is not active
    expect(tenantServices({ICFSERVICE, ICFHANDLER, ICFSERVLOC: []}).services).to.deep.equal([]);
  });

  it("keeps the first of two nodes on one path and counts the other", () => {
    const rows = [node("DEFAULT_HOST", FF, g(1)), node("ZB3X", g(1), g(2)), node("A0B3X", g(1), g(3), "zb3x")];
    const {services, counts} = tenantServices({ICFSERVICE: rows, ICFHANDLER: [handler("ZB3X", g(1), "ZCL_B3_ONE"), handler("A0B3X", g(1), "ZCL_B3_TWO")]});
    expect(services.map((s) => s.handler)).to.deep.equal(["ZCL_B3_ONE"]);
    expect(counts.duplicates).to.deep.equal(["/zb3x"]);
  });

  it("serves another virtual host when asked, and reads lower-case column names", () => {
    const lower = (rows) => rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
    const {services} = tenantServices({ICFSERVICE: lower(ICFSERVICE), ICFHANDLER: lower(ICFHANDLER)}, {host: "OTHER_HOST"});
    expect(services.map((s) => s.path)).to.deep.equal(["/zb3else"]);
  });

  it("gives a parent cycle no path", () => {
    const {services} = tenantServices({ICFSERVICE: [node("ZB3A", g(2), g(1)), node("ZB3B", g(1), g(2))],
      ICFHANDLER: [handler("ZB3A", g(2), "ZCL_B3_A")]});
    expect(services).to.deep.equal([]);
  });
});

describe("sap-cluster: an SMW0 MIME object in WWWDATA", () => {
  const content = Buffer.alloc(1300);
  for (let i = 0; i < content.length; i++) content[i] = (i * 13 + 5) & 255;

  for (const compress of [true, false]) {
    it(`reads back a ${compress ? "LZH-compressed" : "plain"} cluster from its fragments, cut to the file size`, async () => {
      const rows = fragments(await mimeCluster(content, {compress}), 97);
      const cluster = parseCluster(joinFragments([...rows].reverse()));
      expect(cluster).to.include({version: 6, codepage: "4103", compressed: compress});
      expect(cluster.objects.map((o) => [o.name, o.kind, o.rowLength, o.rows.length])).to.deep.equal([["MIME", "table", 255, 6]]);
      expect(mimeBytes(cluster, content.length).equals(content)).to.equal(true);
      expect(mimeBytes(cluster).length).to.equal(6 * 255);
      expect(() => mimeBytes(cluster, 6 * 255 + 1)).to.throw(SAPClusterError, /more than/);
    });
  }

  it("refuses a missing or repeated fragment, another format version and a body that is not a cluster", async () => {
    const rows = fragments(await mimeCluster(content), 97);
    expect(() => joinFragments(rows.filter((r) => r.srtf2 !== 1))).to.throw(SAPClusterError, /fragment 1 is missing/);
    expect(() => joinFragments([...rows, rows[0]])).to.throw(SAPClusterError);
    for (const clustr of [0, Number.NaN, 98, 1.5]) {
      expect(() => joinFragments(rows.map((r, i) => (i === 0 ? {...r, clustr} : r))), String(clustr)).to.throw(SAPClusterError, /CLUSTR/);
    }
    const blob = joinFragments(rows);
    const v5 = Buffer.from(blob);
    v5[1] = 5;
    expect(() => parseCluster(v5)).to.throw(SAPClusterError, /version 5/);
    expect(() => parseCluster(Buffer.from("00".repeat(20), "hex"))).to.throw(SAPClusterError, /marker/);
    expect(() => parseCluster(blob.subarray(0, 40))).to.throw();
  });
});

describe("hana-serve-scope: the island cut to what its roots reach", () => {
  let root;
  const put = (path, text) => {
    mkdirSync(join(root, path, ".."), {recursive: true});
    writeFileSync(join(root, path), text);
  };
  before(() => {
    root = mkdtempSync(join(tmpdir(), "hana-serve-scope-"));
    const a = "gen/hana-src/001-b3-a/src";
    const b = "gen/hana-src/002-b3-b/src";
    put(`${a}/zcl_b3_http.clas.abap`, "CLASS zcl_b3_http DEFINITION.\n* zcl_b3_commented is only in a comment\nENDCLASS.\nCLASS zcl_b3_http IMPLEMENTATION.\n  METHOD m.\n    DATA x TYPE zb3_tab.\n    zcl_b3_util=>go( ).\n    CALL FUNCTION 'Z_B3_FM'.\n  ENDMETHOD.\nENDCLASS.\n");
    put(`${a}/zcl_b3_http.clas.xml`, "<x/>");
    put(`${a}/zcl_b3_util.clas.abap`, "CLASS zcl_b3_util DEFINITION.\nENDCLASS.\n");
    put(`${a}/zcl_b3_commented.clas.abap`, "CLASS zcl_b3_commented DEFINITION.\nENDCLASS.\n");
    put(`${b}/zcl_b3_apc.clas.abap`, "CLASS zcl_b3_apc DEFINITION.\n  DATA y TYPE REF TO zcl_b3_llm.\nENDCLASS.\n");
    put(`${b}/zcl_b3_llm.clas.abap`, "CLASS zcl_b3_llm DEFINITION.\n  DATA c TYPE zb3_cache.\nENDCLASS.\n");
    put(`${b}/zb3_report.prog.abap`, "REPORT zb3_report.\n");
    put(`${b}/zb3_fg.fugr.xml`, "<FUNCNAME>Z_B3_FM</FUNCNAME>");
    put(`${b}/zb3_fg.fugr.z_b3_fm.abap`, "FUNCTION z_b3_fm.\nENDFUNCTION.\n");
    put(`${b}/zb3_tab.tabl.xml`, "<ROLLNAME>ZB3_DTEL</ROLLNAME>");
    put(`${b}/zb3_dtel.dtel.xml`, "<DOMNAME>ZB3_DOMA</DOMNAME>");
    put(`${b}/zb3_doma.doma.xml`, "<x/>");
    put(`${b}/zb3_cache.tabl.xml`, "<x/>");
  });
  after(() => rmSync(root, {recursive: true, force: true}));

  it("keeps what the roots name, through code, function modules and the dictionary's XML", () => {
    const result = cut(islandObjects(root), ["zcl_b3_http"], (f) => readText(root, f));
    expect(result.kept).to.deep.equal(["CLAS ZCL_B3_HTTP", "CLAS ZCL_B3_UTIL", "DOMA ZB3_DOMA", "DTEL ZB3_DTEL", "FUGR ZB3_FG", "TABL ZB3_TAB"]);
    expect(result.leftOut.map((e) => e.object)).to.deep.equal(["CLAS ZCL_B3_APC", "CLAS ZCL_B3_COMMENTED", "CLAS ZCL_B3_LLM", "PROG ZB3_REPORT"]);
    expect(result.unreachedTables).to.deep.equal(["ZB3_CACHE"]);
  });

  it("refuses a root the island does not hold", () => {
    expect(() => cut(islandObjects(root), ["ZCL_B3_TYPO"], (f) => readText(root, f))).to.throw(/ZCL_B3_TYPO/);
  });

  it("reads identifiers without comment lines", () => {
    expect([...identifiers("* zcl_x\n  zcl_y=>m( ). \" zcl_z\n")]).to.include.members(["ZCL_Y", "M", "ZCL_Z"]).and.not.include("ZCL_X");
  });

  it("puts the left-out files into the build's exclusions, and the unreached tables out of the eager set", () => {
    const result = cut(islandObjects(root), ["ZCL_B3_HTTP"], (f) => readText(root, f));
    const file = join(root, "gen", "hana-closure", "serve-scope.json");
    mkdirSync(join(root, "gen", "hana-closure"), {recursive: true});
    writeFileSync(file, JSON.stringify(result));
    const saved = process.env.OSD_HANA_CLOSURE_OUT;
    delete process.env.OSD_HANA_CLOSURE_OUT;
    try {
      expect(excludedObjectFiles(root)).to.include.members(["gen/hana-src/002-b3-b/src/zcl_b3_apc.clas.abap", "gen/hana-src/002-b3-b/src/zb3_report.prog.abap"]);
      expect(excludedObjectFiles(root)).to.not.include("gen/hana-src/001-b3-a/src/zcl_b3_http.clas.abap");
      expect(serveScopeUnreachedTables(root)).to.deep.equal(["ZB3_CACHE"]);
    } finally {
      if (saved !== undefined) process.env.OSD_HANA_CLOSURE_OUT = saved;
    }
  });
});

function readText(root, file) {
  return readFileSync(join(root, file), "utf8");
}

describe("hana-serve-scope: registrations, conversion exits, dynamic calls, collisions", function () {
  this.timeout(60000);
  let root;
  const put = (path, text) => {
    mkdirSync(join(root, path, ".."), {recursive: true});
    writeFileSync(join(root, path), text);
  };
  const tool = join(fileURLToPath(new URL("..", import.meta.url)), "tools", "hana-serve-scope.mjs");
  before(() => {
    root = mkdtempSync(join(tmpdir(), "hana-serve-scope-reg-"));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["gen/hana-src/*", "src"], output_folder: "output", libs: []}));
    mkdirSync(join(root, "src"), {recursive: true});
    const a = "gen/hana-src/001-b3-a/src";
    put(`${a}/zcl_b3_root.clas.abap`, "CLASS zcl_b3_root DEFINITION.\nENDCLASS.\nCLASS zcl_b3_root IMPLEMENTATION.\n  METHOD m.\n    DATA v TYPE zb3_dtel.\n    CALL METHOD (lv_class)=>run.\n  ENDMETHOD.\nENDCLASS.\n");
    put(`${a}/zb3_dtel.dtel.xml`, "<DOMNAME>ZB3_DOMA</DOMNAME>");
    put(`${a}/zb3_doma.doma.xml`, "<CONVEXIT>ZB3X</CONVEXIT>");
    put(`${a}/zb3_conv.fugr.xml`, "<FUNCNAME>CONVERSION_EXIT_ZB3X_OUTPUT</FUNCNAME>");
    put(`${a}/zb3_conv.fugr.conversion_exit_zb3x_output.abap`, "FUNCTION conversion_exit_zb3x_output.\nENDFUNCTION.\n");
    put(`${a}/zcl_b3_icf.clas.abap`, "CLASS zcl_b3_icf DEFINITION.\nENDCLASS.\n");
    put(`${a}/zb3_icf.sicf.xml`, "<ICFHANDLER><ICFHANDLER>ZCL_B3_ICF</ICFHANDLER></ICFHANDLER>");
    put(`${a}/zcl_b3_dpc_ext.clas.abap`, "CLASS zcl_b3_dpc_ext DEFINITION.\nENDCLASS.\n");
    put(`${a}/zb3_srv.iwsv.xml`, "<CLASS_NAME>ZCL_B3_DPC_EXT</CLASS_NAME>");
    put(`${a}/zcl_b3_push.clas.abap`, "CLASS zcl_b3_push DEFINITION.\nENDCLASS.\n");
    put(`${a}/zb3_push.sapc.xml`, "<CLASS_NAME>ZCL_B3_PUSH</CLASS_NAME>");
  });
  after(() => rmSync(root, {recursive: true, force: true}));

  it("roots the island's SICF and IWSV classes by themselves, follows a conversion exit, says a cut push channel and a dynamic call", () => {
    const run = spawnSync(process.execPath, [tool, "--root", "ZCL_B3_ROOT"], {cwd: root, env: {...process.env, OSD_ROOT: root}, encoding: "utf8"});
    expect(run.status, run.stderr).to.equal(0);
    const record = JSON.parse(readFileSync(join(root, "gen", "hana-closure", "serve-scope.json"), "utf8"));
    expect(record.automaticRoots).to.deep.equal(["ZCL_B3_DPC_EXT", "ZCL_B3_ICF"]);
    expect(record.kept).to.include.members(["CLAS ZCL_B3_ICF", "CLAS ZCL_B3_DPC_EXT", "FUGR ZB3_CONV", "DOMA ZB3_DOMA"]);
    expect(record.leftOut.map((e) => e.object)).to.deep.equal(["CLAS ZCL_B3_PUSH"]);
    expect(run.stdout).to.include("the push channel class ZCL_B3_PUSH is cut");
    expect(run.stdout).to.match(/CLAS ZCL_B3_ROOT calls by a name computed at run time .*zcl_b3_root\.clas\.abap:6/);
  });

  it("refuses, before writing, a build where a pack hides an island object -- the CLI and serve()", async () => {
    put("packs/zb3pack/osd-pack.json", JSON.stringify({name: "zb3pack"}));
    put("packs/zb3pack/src/zcl_b3_root.clas.abap", "CLASS zcl_b3_root DEFINITION.\nENDCLASS.\n");
    rmSync(join(root, "gen", "hana-closure"), {recursive: true, force: true});
    try {
      const env = {...process.env, OSD_ROOT: root};
      delete env.OSD_WEB_PACKS;
      const run = spawnSync(process.execPath, [tool, "--root", "ZCL_B3_ROOT"], {cwd: root, env, encoding: "utf8"});
      expect(run.status).to.equal(1);
      expect(run.stderr).to.match(/CLAS ZCL_B3_ROOT \(won by packs\/zb3pack\/src\)/);
      expect(existsSync(join(root, "gen", "hana-closure", "serve-scope.json")), "nothing written").to.equal(false);
      const {serve} = await import("../tools/hana-serve.mjs");
      const serveEnv = {HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", STG_RFC_DESTINATIONS: join(root, "none.json")};
      let refused;
      try { await serve({root, env: serveEnv, log: () => {}}); } catch (e) { refused = e; }
      expect(String(refused?.message)).to.match(/hana-serve refuses to build: .*ZCL_B3_ROOT/);
      // with the pack deselected the CLI writes its record
      const narrowed = spawnSync(process.execPath, [tool, "--root", "ZCL_B3_ROOT"], {cwd: root, env: {...env, OSD_WEB_PACKS: "none"}, encoding: "utf8"});
      expect(narrowed.status, narrowed.stderr).to.equal(0);
    } finally {
      rmSync(join(root, "packs"), {recursive: true, force: true});
    }
  });

  it("the closure walk refuses to run over a serve scope", async () => {
    mkdirSync(join(root, "gen", "hana-closure"), {recursive: true});
    writeFileSync(join(root, "gen", "hana-closure", "serve-scope.json"), JSON.stringify({leftOut: []}));
    const {run} = await import("../tools/hana-closure.mjs");
    let refused;
    try { await run(["--system", "B3", "--dump", "nowhere"], {root, env: {}, say: () => {}}); } catch (e) { refused = e; }
    expect(String(refused?.message)).to.match(/holds a serve scope.*--clear/);
  });

  it("refuses a record without a leftOut list rather than building the whole island", () => {
    writeFileSync(join(root, "gen", "hana-closure", "serve-scope.json"), JSON.stringify({kept: []}));
    expect(() => excludedObjectFiles(root)).to.throw(/not a serve-scope record/);
  });
});
