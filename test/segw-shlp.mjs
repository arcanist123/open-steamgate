import {expect} from "chai";
import {mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {dictionary, generate, searchHelps, parseSearchHelp, shlpRegistryClass} from "../tools/segw-shlp.mjs";

describe("tools/segw-shlp: search help objects -> value help providers", () => {
  it("selects the later search help before deciding whether to register it", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-shlp-layers-"));
    try {
      for (const layer of ["first", "second"]) mkdirSync(join(root, layer));
      const xml = (simple, method) => `<abapGit><DD30V><SHLPNAME>ZSHARED</SHLPNAME><ISSIMPLE>${simple}</ISSIMPLE><SELMETHOD>${method}</SELMETHOD></DD30V></abapGit>`;
      writeFileSync(join(root, "first", "zshared.shlp.xml"), xml("X", "ZOLD"));
      writeFileSync(join(root, "second", "zshared.shlp.xml"), xml("", "ZNEW"));
      const helps = searchHelps([join(root, "first"), join(root, "second")]);
      expect(helps).to.have.length(1);
      expect(helps[0]).to.include({selmethod: "ZNEW", simple: false});
      expect(shlpRegistryClass(helps)).not.to.contain("iv_shlp_name = 'ZSHARED'");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  it("reads the demo's search help", () => {
    const helps = searchHelps(["src"]);
    const sh = helps.find((h) => h.name === "ZSTG_STATUS_SH");
    expect(sh).to.include({selmethod: "ZSTG_STATUS", selmexit: "", simple: true, collective: false});
    expect(sh.parameters.map((p) => p.name)).to.deep.equal(["STATUS", "STATUS_TEXT"]);
    expect(sh.parameters[1]).to.include({input: true, output: true, listPosition: 2, selectPosition: 2});
    const abap = shlpRegistryClass(helps);
    expect(abap).to.contain("iv_shlp_name = 'ZSTG_STATUS_SH'");
    expect(abap).to.contain("iv_selmethod = 'ZSTG_STATUS'");
    expect(abap).to.contain("iv_name            = 'STATUS_TEXT'");
    expect(abap).to.contain("lo_shlp->register( ).");
  });

  it("registers exit search helps by their exit, skips collective ones, survives an empty repository", () => {
    const exit = parseSearchHelp(`<abapGit><asx:values><DD30V><SHLPNAME>ZSTG_SH_PROD_TYPE</SHLPNAME>
<ISSIMPLE>X</ISSIMPLE><SELMTYPE>F</SELMTYPE><SELMEXIT>ZSTG_SHEXIT_TYPECODE</SELMEXIT></DD30V>
<DD32P_TABLE><DD32P><FIELDNAME>TYPE_CODE</FIELDNAME><SHLPINPUT>X</SHLPINPUT><SHLPOUTPUT>X</SHLPOUTPUT><SHLPLISPOS>01</SHLPLISPOS></DD32P></DD32P_TABLE>
</asx:values></abapGit>`, "x.shlp.xml");
    expect(exit).to.include({selmexit: "ZSTG_SHEXIT_TYPECODE", selmethod: ""});
    const collective = parseSearchHelp(`<abapGit><asx:values><DD30V><SHLPNAME>ZCOLL</SHLPNAME></DD30V>
<DD31S_TABLE><DD31S><SUBSHLP>ZSTG_STATUS_SH</SUBSHLP></DD31S></DD31S_TABLE></asx:values></abapGit>`, "c.shlp.xml");
    expect(collective.collective).to.equal(true);
    const abap = shlpRegistryClass([exit, collective]);
    expect(abap).to.contain("iv_selmexit  = 'ZSTG_SHEXIT_TYPECODE'");
    expect(abap).to.contain("* ZCOLL: collective search help, not registered");
    expect(abap).not.to.contain("iv_shlp_name = 'ZCOLL'");
    expect(shlpRegistryClass([])).to.contain("    RETURN.");
  });
});

describe("tools/segw-shlp: text tables and help views (milestone 3 B5.2)", () => {
  const TWIN = "test/hana-m2";

  it("generates exactly the twin's registry and join classes (test/hana-m2 holds them as written)", () => {
    // the twin's value help sets run on these classes in ABAP Unit
    // (zcl_osd_h5x_test, ltcl_value_help); this keeps them the generator's
    const {files} = generate([TWIN], {className: "zcl_osd_h5x_shlp_registry"});
    expect([...files.keys()].sort()).to.deep.equal([
      "zcl_osd_h5x_shlp_registry.clas.abap", "zcl_osd_shlp_zosd_h5x_cty.clas.abap", "zcl_osd_shlp_zosd_h5x_uv.clas.abap"]);
    for (const [name, abap] of files) expect(abap, name).to.equal(readFileSync(join(TWIN, name), "utf8"));
  });

  it("reads the converter's shape: the self-row in DD31V, an entity-quoted literal default, a list field that is no export", () => {
    const help = parseSearchHelp(readFileSync(join(TWIN, "zosd_h5x_sh_un.shlp.xml"), "utf8"), "x");
    expect(help).to.include({simple: true, collective: false, selmtype: "H", selmethod: "ZOSD_H5X_UV"});
    expect(help.parameters.find((p) => p.name === "DIM")).to.include({default: "MASS", defaultType: "L", output: false});
    expect(help.parameters.find((p) => p.name === "LTXT")).to.include({output: false, listPosition: 2});
    const abap = shlpRegistryClass([help], {dict: dictionary([TWIN])});
    expect(abap).to.contain("iv_default         = 'MASS'");
    expect(abap).to.contain("CREATE OBJECT lo_source TYPE zcl_osd_shlp_zosd_h5x_uv.");
  });

  const layer = (files) => {
    const root = mkdtempSync(join(tmpdir(), "osd-shlp-join-"));
    for (const [name, xml] of Object.entries(files)) writeFileSync(join(root, name), xml);
    return root;
  };
  const tabl = (name, fields) => `<abapGit><asx:values><DD02V><TABNAME>${name}</TABNAME><CLIDEP>X</CLIDEP></DD02V><DD03P_TABLE>${
    fields.map(([f, key, type, lang]) => `<DD03P><FIELDNAME>${f}</FIELDNAME>${key ? "<KEYFLAG>X</KEYFLAG>" : ""}${lang ? "<LANGUFLAG>X</LANGUFLAG>" : ""}<DATATYPE>${type}</DATATYPE></DD03P>`).join("")
  }</DD03P_TABLE></asx:values></abapGit>`;
  const shlp = (name, method, params, more = "") => `<abapGit><asx:values><DD30V><SHLPNAME>${name}</SHLPNAME><ISSIMPLE>X</ISSIMPLE><SELMETHOD>${method}</SELMETHOD>${more}</DD30V><DD32P_TABLE>${
    params.map((p) => `<DD32P><FIELDNAME>${p}</FIELDNAME><SHLPOUTPUT>X</SHLPOUTPUT><SHLPLISPOS>01</SHLPLISPOS></DD32P>`).join("")
  }</DD32P_TABLE></asx:values></abapGit>`;

  it("joins a check table (FORDIR E) and its text table, and leaves out the two when they give no field", () => {
    // the base's DIM is checked by ZDIM; ZDIMT is ZDIM's text table
    const view = (fields) => `<abapGit><asx:values><DD25V><VIEWNAME>ZHV</VIEWNAME><VIEWCLASS>H</VIEWCLASS></DD25V><DD26V_TABLE>
<DD26V><TABNAME>ZBASE</TABNAME><TABPOS>0001</TABPOS><FORTABNAME>ZBASE</FORTABNAME></DD26V>
<DD26V><TABNAME>ZDIM</TABNAME><TABPOS>0002</TABPOS><FORTABNAME>ZBASE</FORTABNAME><FORFIELD>DIM</FORFIELD><FORDIR>E</FORDIR></DD26V>
<DD26V><TABNAME>ZDIMT</TABNAME><TABPOS>0003</TABPOS><FORTABNAME>ZDIM</FORTABNAME><FORFIELD>DIMID</FORFIELD><FORDIR>I</FORDIR></DD26V>
</DD26V_TABLE><DD27P_TABLE>${fields}</DD27P_TABLE></asx:values></abapGit>`;
    const field = (v, t, f, pos) => `<DD27P><VIEWFIELD>${v}</VIEWFIELD><TABNAME>${t}</TABNAME><FIELDNAME>${f}</FIELDNAME><OBJPOS>${pos}</OBJPOS></DD27P>`;
    const tables = {
      "zbase.tabl.xml": tabl("ZBASE", [["MANDT", true, "CLNT"], ["UNIT", true, "CHAR"], ["DIM", false, "CHAR"]]),
      "zdim.tabl.xml": tabl("ZDIM", [["MANDT", true, "CLNT"], ["DIMID", true, "CHAR"]]),
      "zdimt.tabl.xml": tabl("ZDIMT", [["MANDT", true, "CLNT"], ["SPRAS", true, "LANG", true], ["DIMID", true, "CHAR"], ["TXT", false, "CHAR"]]),
      "zh.shlp.xml": shlp("ZH", "ZHV", ["UNIT"], "<SELMTYPE>H</SELMTYPE>"),
    };
    const pruned = layer({...tables, "zhv.view.xml": view(field("UNIT", "ZBASE", "UNIT", "0001") + field("TXT", "ZDIMT", "TXT", "0002"))});
    const used = layer({...tables, "zh.shlp.xml": shlp("ZH", "ZHV", ["UNIT", "TXT"], "<SELMTYPE>H</SELMTYPE>"),
      "zhv.view.xml": view(field("UNIT", "ZBASE", "UNIT", "0001") + field("TXT", "ZDIMT", "TXT", "0002"))});
    try {
      const only = [...generate([pruned]).files.values()].find((a) => a.includes("INTERFACES zif_oao_shlp_source"));
      expect(only).not.to.contain("zdim");
      const both = [...generate([used]).files.values()].find((a) => a.includes("INTERFACES zif_oao_shlp_source"));
      expect(both).to.contain("LEFT OUTER JOIN zdim AS t2\n          ON t2~mandt = t1~mandt\n         AND t2~dimid = t1~dim");
      expect(both).to.contain("LEFT OUTER JOIN zdimt AS t3\n          ON t3~mandt = t2~mandt\n         AND t3~spras = iv_langu\n         AND t3~dimid = t2~dimid");
      expect(both).to.contain("rv_column = 't3~txt'");
    } finally {
      rmSync(pruned, {recursive: true, force: true});
      rmSync(used, {recursive: true, force: true});
    }
  });

  it("does not register a help view whose definition is not in the build, and says why", () => {
    const root = layer({"zh.shlp.xml": shlp("ZH", "ZHV", ["UNIT"], "<SELMTYPE>H</SELMTYPE>")});
    try {
      const abap = generate([root]).files.get("zcl_stg_shlp_registry.clas.abap");
      expect(abap).to.contain("* ZH: not registered, help view ZHV has no definition (.view.xml) in the build");
      expect(abap).not.to.contain("iv_shlp_name = 'ZH'");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });


  it("removes a help view from the transpiler's registry and keeps a database view", async () => {
    const {dropHelpViews} = await import("../tools/osd-warm-order.mjs");
    const core = await import("@abaplint/core");
    const reg = new core.Registry();
    const view = (name, cls) => `<?xml version="1.0" encoding="utf-8"?><abapGit version="v1.0.0" serializer="LCL_OBJECT_VIEW" serializer_version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DD25V><VIEWNAME>${name}</VIEWNAME><VIEWCLASS>${cls}</VIEWCLASS></DD25V></asx:values></asx:abap></abapGit>`;
    reg.addFile(new core.MemoryFile("zhelp.view.xml", view("ZHELP", "H")));
    reg.addFile(new core.MemoryFile("zdb.view.xml", view("ZDB", "D")));
    expect(dropHelpViews(reg, core)).to.deep.equal(["ZHELP"]);
    expect([...reg.getObjects()].map((o) => o.getName())).to.deep.equal(["ZDB"]);
  });

  // PR #952 critic round
  const viewXml = (conditions, fields = ["CODE", "EXT", "DIM"]) => `<abapGit><asx:values><DD25V><VIEWNAME>ZHV</VIEWNAME><VIEWCLASS>H</VIEWCLASS></DD25V><DD26V_TABLE>
<DD26V><TABNAME>ZBASE</TABNAME><TABPOS>0001</TABPOS><FORTABNAME>ZBASE</FORTABNAME></DD26V></DD26V_TABLE><DD27P_TABLE>${
    fields.map((f, i) => `<DD27P><VIEWFIELD>${f}</VIEWFIELD><TABNAME>ZBASE</TABNAME><FIELDNAME>${f}</FIELDNAME><OBJPOS>000${i + 1}</OBJPOS></DD27P>`).join("")
  }</DD27P_TABLE><DD28V_TABLE>${
    conditions.map(([f, c, andOr], i) => `<DD28V><POSITION>000${i + 1}</POSITION><TABNAME>ZBASE</TABNAME><FIELDNAME>${f}</FIELDNAME><OPERATOR>EQ</OPERATOR><CONSTANTS>${c}</CONSTANTS><AND_OR>${andOr ?? ""}</AND_OR></DD28V>`).join("")
  }</DD28V_TABLE></asx:values></abapGit>`;
  const base = tabl("ZBASE", [["MANDT", true, "CLNT"], ["CODE", true, "CHAR"], ["EXT", false, "CHAR"], ["DIM", false, "CHAR"]]);
  const viewHelp = (conditions, fields) => layer({"zbase.tabl.xml": base, "zhv.view.xml": viewXml(conditions, fields),
    "zh.shlp.xml": shlp("ZH", "ZHV", ["CODE"], "<SELMTYPE>H</SELMTYPE>")});
  const registryOf = (root) => generate([root]).files.get("zcl_stg_shlp_registry.clas.abap");
  const joinOf = (root) => [...generate([root]).files.values()].find((a) => a.includes("INTERFACES zif_oao_shlp_source"));

  it("refuses a name that is no dictionary identifier instead of writing it into ABAP (MUST-2)", () => {
    const root = layer({
      "zt.tabl.xml": tabl("ZT", [["MANDT", true, "CLNT"], ["CODE'", true, "CHAR"]]),
      "ztt.tabl.xml": tabl("ZTT", [["MANDT", true, "CLNT"], ["SPRAS", true, "LANG", true], ["CODE'", true, "CHAR"], ["TXT", false, "CHAR"]]),
      "zh.shlp.xml": shlp("ZH", "ZT", ["CODE'"], "<TEXTTAB>ZTT</TEXTTAB>"),
    });
    try {
      const abap = registryOf(root);
      expect(abap).to.contain("* ZH: not registered, parameter \"CODE'\" is not a dictionary name");
      expect(joinOf(root)).to.equal(undefined);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("refuses a condition constant or field that is not one literal or one name (MUST-2)", () => {
    const constant = viewHelp([["CODE", "'A' OR mandt <> '999'"]]);
    const field = viewHelp([["CODE OR 'X' = '", "'A'"]]);
    const fine = viewHelp([["EXT", "'it''s'"]]);
    try {
      expect(registryOf(constant)).to.contain("not registered, help view ZHV: condition constant");
      expect(joinOf(constant)).to.equal(undefined);
      expect(registryOf(field)).to.contain("not registered, condition field");
      expect(joinOf(field)).to.equal(undefined);
      expect(joinOf(fine)).to.contain("WHERE ( t1~ext = 'it''s' ) AND (lv_where)");
    } finally {
      for (const r of [constant, field, fine]) rmSync(r, {recursive: true, force: true});
    }
  });

  it("pairs text table key fields by name, not by position, and refuses what pairs with nothing (MUST-3)", () => {
    const crossed = layer({
      "zb.tabl.xml": tabl("ZB", [["MANDT", true, "CLNT"], ["A", true, "CHAR"], ["B", true, "CHAR"]]),
      "zbt.tabl.xml": tabl("ZBT", [["MANDT", true, "CLNT"], ["B", true, "CHAR"], ["A", true, "CHAR"], ["SPRAS", true, "LANG", true], ["TXT", false, "CHAR"]]),
      "zh.shlp.xml": shlp("ZH", "ZB", ["A", "TXT"], "<TEXTTAB>ZBT</TEXTTAB>"),
    });
    const unpaired = layer({
      "zb.tabl.xml": tabl("ZB", [["MANDT", true, "CLNT"], ["A", true, "CHAR"], ["B", true, "CHAR"]]),
      "zbt.tabl.xml": tabl("ZBT", [["MANDT", true, "CLNT"], ["X", true, "CHAR"], ["Y", true, "CHAR"], ["SPRAS", true, "LANG", true], ["TXT", false, "CHAR"]]),
      "zh.shlp.xml": shlp("ZH", "ZB", ["A", "TXT"], "<TEXTTAB>ZBT</TEXTTAB>"),
    });
    try {
      const abap = joinOf(crossed);
      expect(abap).to.contain("AND t2~b = t1~b");
      expect(abap).to.contain("AND t2~a = t1~a");
      expect(registryOf(unpaired)).to.contain("* ZH: not registered, ZBT: key field(s) X, Y pair with no key field of ZB by name");
    } finally {
      rmSync(crossed, {recursive: true, force: true});
      rmSync(unpaired, {recursive: true, force: true});
    }
  });

  it("joins AND-linked conditions with AND and refuses a sequence with an OR (MUST-4)", () => {
    const and = viewHelp([["CODE", "'A'", "AND"], ["EXT", "'X'"]]);
    const or = viewHelp([["CODE", "'A'", "OR"], ["EXT", "'X'", "AND"], ["DIM", "'MASS'"]]);
    try {
      expect(joinOf(and)).to.contain("WHERE ( t1~code = 'A' AND t1~ext = 'X' ) AND (lv_where)");
      expect(registryOf(or)).to.contain("* ZH: not registered, help view ZHV: selection conditions linked by OR are not served");
      expect(joinOf(or)).to.equal(undefined);
    } finally {
      rmSync(and, {recursive: true, force: true});
      rmSync(or, {recursive: true, force: true});
    }
  });

  it("drops a help view on every path that orders a registry: cold, warm and the warm verifier (MUST-1)", async () => {
    const {orderRegistry} = await import("../tools/osd-warm-order.mjs");
    const core = await import("@abaplint/core");
    const reg = new core.Registry();
    const files = [
      {filename: "zhelp.view.xml", contents: `<?xml version="1.0" encoding="utf-8"?><abapGit version="v1.0.0" serializer="LCL_OBJECT_VIEW" serializer_version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DD25V><VIEWNAME>ZHELP</VIEWNAME><VIEWCLASS>H</VIEWCLASS></DD25V></asx:values></asx:abap></abapGit>`},
      {filename: "zcl_keep.clas.abap", contents: "CLASS zcl_keep DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_keep IMPLEMENTATION.\nENDCLASS."},
    ];
    for (const f of files) reg.addFile(new core.MemoryFile(f.filename, f.contents));
    expect(orderRegistry(reg, core, files)).to.deep.equal(["ZHELP"]);
    expect([...reg.getObjects()].map((o) => o.getName())).to.deep.equal(["ZCL_KEEP"]);
    // ordering an already ordered registry again (the warm compiler does) keeps it out
    expect(orderRegistry(reg, core, files)).to.deep.equal([]);
    expect([...reg.getObjects()].map((o) => o.getName())).to.deep.equal(["ZCL_KEEP"]);
  });
});
