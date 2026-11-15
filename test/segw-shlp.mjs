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

  it("refuses a key field of a help view's base table that no view field names (MUST-2, round 2)", () => {
    // the ORDER BY writes the base table's key fields whether or not DD27P
    // names them; such a name used to reach the generated SELECT unchecked
    for (const bad of ["CODE' OR '1'='1", "A. ENDMETHOD."]) {
      const root = layer({
        "zb.tabl.xml": tabl("ZB", [["MANDT", true, "CLNT"], ["CODE", true, "CHAR"], [bad, true, "CHAR"]]),
        "zhv.view.xml": `<abapGit><asx:values><DD25V><VIEWNAME>ZHV</VIEWNAME><VIEWCLASS>H</VIEWCLASS></DD25V><DD26V_TABLE><DD26V><TABNAME>ZB</TABNAME><TABPOS>0001</TABPOS><FORTABNAME>ZB</FORTABNAME></DD26V></DD26V_TABLE><DD27P_TABLE><DD27P><VIEWFIELD>CODE</VIEWFIELD><TABNAME>ZB</TABNAME><FIELDNAME>CODE</FIELDNAME><OBJPOS>0001</OBJPOS></DD27P></DD27P_TABLE></asx:values></abapGit>`,
        "zh.shlp.xml": shlp("ZH", "ZHV", ["CODE"], "<SELMTYPE>H</SELMTYPE>"),
      });
      try {
        expect(registryOf(root), bad).to.contain(`* ZH: not registered, table field ${JSON.stringify(bad)} is not a dictionary name`);
        expect(joinOf(root), bad).to.equal(undefined);
      } finally {
        rmSync(root, {recursive: true, force: true});
      }
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
  // milestone 3: the help view as the dump converter writes it (DD25V with
  // AS4LOCAL, DD26V with VIEWNAME and the first table's own FORTABNAME,
  // DD27P without OBJPOS, DD28V keyed by CONDNAME with an entity-quoted
  // constant, no DD28J) -- the shape of the real file, synthetic names: a unit
  // table, its text table, its dimension check table and that one's texts;
  // three helps over the one view, as on the sample service
  const converterView = ({joins = ""} = {}) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_VIEW" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD25V><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><AS4LOCAL>A</AS4LOCAL><DDLANGUAGE>E</DDLANGUAGE><AGGTYPE>V</AGGTYPE><ROOTTAB>ZOSD_H5X_CU</ROOTTAB><DDTEXT>help view</DDTEXT><VIEWCLASS>H</VIEWCLASS><VIEWGRANT>R</VIEWGRANT></DD25V>
   <DD26V_TABLE>
    <DD26V><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><TABNAME>ZOSD_H5X_CU</TABNAME><TABPOS>0001</TABPOS><FORTABNAME>ZOSD_H5X_CU</FORTABNAME></DD26V>
    <DD26V><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><TABNAME>ZOSD_H5X_CUT</TABNAME><TABPOS>0002</TABPOS><FORTABNAME>ZOSD_H5X_CU</FORTABNAME><FORFIELD>UNIT</FORFIELD><FORDIR>I</FORDIR></DD26V>
    <DD26V><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><TABNAME>ZOSD_H5X_CD</TABNAME><TABPOS>0003</TABPOS><FORTABNAME>ZOSD_H5X_CU</FORTABNAME><FORFIELD>DIM</FORFIELD><FORDIR>E</FORDIR></DD26V>
    <DD26V><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><TABNAME>ZOSD_H5X_CDT</TABNAME><TABPOS>0004</TABPOS><FORTABNAME>ZOSD_H5X_CD</FORTABNAME><FORFIELD>DIMID</FORFIELD><FORDIR>I</FORDIR></DD26V>
   </DD26V_TABLE>
   <DD27P_TABLE>
    <DD27P><VIEWFIELD>MANDT</VIEWFIELD><TABNAME>ZOSD_H5X_CU</TABNAME><FIELDNAME>MANDT</FIELDNAME><KEYFLAG>X</KEYFLAG><CHECKTABLE>ZOSD_H5X_CL</CHECKTABLE><SHLPORIGIN>P</SHLPORIGIN></DD27P>
    <DD27P><VIEWFIELD>SHORT</VIEWFIELD><TABNAME>ZOSD_H5X_CUT</TABNAME><FIELDNAME>SHORT</FIELDNAME></DD27P>
    <DD27P><VIEWFIELD>UNIT</VIEWFIELD><TABNAME>ZOSD_H5X_CU</TABNAME><FIELDNAME>UNIT</FIELDNAME><KEYFLAG>X</KEYFLAG></DD27P>
    <DD27P><VIEWFIELD>LTXT</VIEWFIELD><TABNAME>ZOSD_H5X_CUT</TABNAME><FIELDNAME>LTXT</FIELDNAME></DD27P>
    <DD27P><VIEWFIELD>DIM</VIEWFIELD><TABNAME>ZOSD_H5X_CU</TABNAME><FIELDNAME>DIM</FIELDNAME><CHECKTABLE>ZOSD_H5X_CD</CHECKTABLE><SHLPORIGIN>P</SHLPORIGIN></DD27P>
   </DD27P_TABLE>${joins}
   <DD28V_TABLE>
    <DD28V><CONDNAME>ZOSD_H5X_CV</CONDNAME><POSITION>0001</POSITION><TABNAME>ZOSD_H5X_CU</TABNAME><FIELDNAME>EXT</FIELDNAME><OPERATOR>EQ</OPERATOR><CONSTANTS>&apos;X&apos;</CONSTANTS></DD28V>
   </DD28V_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
  const unitHelp = (name, dim) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_SHLP" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD30V><SHLPNAME>${name}</SHLPNAME><DDLANGUAGE>E</DDLANGUAGE><DDTEXT>units</DDTEXT><ISSIMPLE>X</ISSIMPLE><SELMETHOD>ZOSD_H5X_CV</SELMETHOD><SELMTYPE>H</SELMTYPE><DIALOGTYPE>D</DIALOGTYPE></DD30V>
   <DD31V_TABLE><DD31V><SHLPNAME>${name}</SHLPNAME><SUBSHLP>${name}</SUBSHLP><SHPOSITION>0001</SHPOSITION></DD31V></DD31V_TABLE>
   <DD32P_TABLE>
    <DD32P><SHLPNAME>${name}</SHLPNAME><FIELDNAME>UNIT</FIELDNAME><FLPOSITION>0001</FLPOSITION><SHLPINPUT>X</SHLPINPUT><SHLPOUTPUT>X</SHLPOUTPUT><SHLPSELPOS>01</SHLPSELPOS><SHLPLISPOS>01</SHLPLISPOS></DD32P>
    <DD32P><SHLPNAME>${name}</SHLPNAME><FIELDNAME>LTXT</FIELDNAME><FLPOSITION>0002</FLPOSITION><SHLPSELPOS>02</SHLPSELPOS><SHLPLISPOS>02</SHLPLISPOS></DD32P>
    <DD32P><SHLPNAME>${name}</SHLPNAME><FIELDNAME>DIM</FIELDNAME><FLPOSITION>0003</FLPOSITION><SHLPSELPOS>03</SHLPSELPOS>${dim ? `<DEFAULTVAL>&apos;${dim}&apos;</DEFAULTVAL><DEFAULTTYP>L</DEFAULTTYP>` : ""}</DD32P>
   </DD32P_TABLE>
   <DD33V_TABLE><DD33V><SHLPNAME>${name}</SHLPNAME><FIELDNAME>UNIT</FIELDNAME><SUBSHLP>${name}</SUBSHLP><SUBFIELD>UNIT</SUBFIELD><VALUEDIREC>C</VALUEDIREC></DD33V></DD33V_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
  const unitLayer = (view) => layer({
    "zosd_h5x_cu.tabl.xml": tabl("ZOSD_H5X_CU", [["MANDT", true, "CLNT"], ["UNIT", true, "CHAR"], ["DIM", false, "CHAR"], ["EXT", false, "CHAR"]]),
    "zosd_h5x_cut.tabl.xml": tabl("ZOSD_H5X_CUT", [["MANDT", true, "CLNT"], ["SPRAS", true, "LANG", true], ["UNIT", true, "CHAR"], ["SHORT", false, "CHAR"], ["LTXT", false, "CHAR"]]),
    "zosd_h5x_cd.tabl.xml": tabl("ZOSD_H5X_CD", [["MANDT", true, "CLNT"], ["DIMID", true, "CHAR"]]),
    "zosd_h5x_cdt.tabl.xml": tabl("ZOSD_H5X_CDT", [["MANDT", true, "CLNT"], ["SPRAS", true, "LANG", true], ["DIMID", true, "CHAR"], ["TXT", false, "CHAR"]]),
    "zosd_h5x_cv.view.xml": view,
    "zosd_h5x_ch.shlp.xml": unitHelp("ZOSD_H5X_CH"),
    "zosd_h5x_ch_ma.shlp.xml": unitHelp("ZOSD_H5X_CH_MA", "MASS"),
    "zosd_h5x_ch_le.shlp.xml": unitHelp("ZOSD_H5X_CH_LE", "LENGTH"),
  });

  it("registers three helps over the converter's help-view file alone: one join class, no hand-written view XML (milestone 3)", async () => {
    const root = unitLayer(converterView());
    try {
      const {files} = generate([root]);
      const registry = files.get("zcl_stg_shlp_registry.clas.abap");
      for (const name of ["ZOSD_H5X_CH", "ZOSD_H5X_CH_MA", "ZOSD_H5X_CH_LE"]) {
        expect(registry).to.contain(`iv_shlp_name = '${name}'`);
      }
      expect(registry.match(/CREATE OBJECT lo_source TYPE zcl_osd_shlp_zosd_h5x_cv\./g)).to.have.length(3);
      expect(registry).to.contain("iv_default         = 'MASS'");
      expect(registry).to.contain("iv_default         = 'LENGTH'");
      expect(registry).not.to.contain("not registered");
      const join = files.get("zcl_osd_shlp_zosd_h5x_cv.clas.abap");
      // the text table on its key, the language to the session's; the check
      // table and its texts give no help field and leave the read
      expect(join).to.contain("FROM zosd_h5x_cu AS t1\n        LEFT OUTER JOIN zosd_h5x_cut AS t2\n          ON t2~mandt = t1~mandt\n         AND t2~spras = iv_langu\n         AND t2~unit = t1~unit");
      expect(join).not.to.contain("zosd_h5x_cd");
      // the DD28V row, its &apos; constant decoded
      expect(join).to.contain("WHERE ( t1~ext = 'X' ) AND (lv_where)");
      // and the file leaves the transpiler's registry: no database object
      const {dropHelpViews} = await import("../tools/osd-warm-order.mjs");
      const core = await import("@abaplint/core");
      const reg = new core.Registry();
      reg.addFile(new core.MemoryFile("zosd_h5x_cv.view.xml", converterView()));
      expect(dropHelpViews(reg, core)).to.deep.equal(["ZOSD_H5X_CV"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("takes a view's joins from its DD28J rows when it has any, and refuses one that names no join of a table", () => {
    const row = (pos, ltab, lfield, rtab, rfield) => `<DD28J><VIEWNAME>ZOSD_H5X_CV</VIEWNAME><POSITION>${pos}</POSITION><LTAB>${ltab}</LTAB><LFIELD>${lfield}</LFIELD><OPERATOR>EQ</OPERATOR><RTAB>${rtab}</RTAB><RFIELD>${rfield}</RFIELD></DD28J>`;
    const all = `\n   <DD28J_TABLE>${row("0001", "ZOSD_H5X_CU", "MANDT", "ZOSD_H5X_CUT", "MANDT")}${row("0002", "ZOSD_H5X_CU", "UNIT", "ZOSD_H5X_CUT", "UNIT")}${
      row("0003", "ZOSD_H5X_CU", "MANDT", "ZOSD_H5X_CD", "MANDT")}${row("0004", "ZOSD_H5X_CU", "DIM", "ZOSD_H5X_CD", "DIMID")}${
      row("0005", "ZOSD_H5X_CD", "MANDT", "ZOSD_H5X_CDT", "MANDT")}${row("0006", "ZOSD_H5X_CD", "DIMID", "ZOSD_H5X_CDT", "DIMID")}</DD28J_TABLE>`;
    const joined = unitLayer(converterView({joins: all}));
    const short = unitLayer(converterView({joins: `\n   <DD28J_TABLE>${row("0001", "ZOSD_H5X_CU", "UNIT", "ZOSD_H5X_CUT", "UNIT")}</DD28J_TABLE>`}));
    const notEq = unitLayer(converterView({joins: all.replace("<OPERATOR>EQ</OPERATOR><RTAB>ZOSD_H5X_CD</RTAB><RFIELD>DIMID</RFIELD>", "<OPERATOR>GT</OPERATOR><RTAB>ZOSD_H5X_CD</RTAB><RFIELD>DIMID</RFIELD>")}));
    try {
      const join = generate([joined]).files.get("zcl_osd_shlp_zosd_h5x_cv.clas.abap");
      expect(join).to.contain("ON t2~mandt = t1~mandt\n         AND t2~unit = t1~unit\n         AND t2~spras = iv_langu");
      expect(generate([short]).files.get("zcl_stg_shlp_registry.clas.abap"))
        .to.contain("* ZOSD_H5X_CH: not registered, help view ZOSD_H5X_CV: ZOSD_H5X_CD: the view's DD28J rows join it to no table before it");
      expect(generate([notEq]).files.get("zcl_stg_shlp_registry.clas.abap"))
        .to.contain("* ZOSD_H5X_CH: not registered, help view ZOSD_H5X_CV: ZOSD_H5X_CD: DD28J operator GT is not served");
    } finally {
      rmSync(joined, {recursive: true, force: true});
      rmSync(short, {recursive: true, force: true});
      rmSync(notEq, {recursive: true, force: true});
    }
  });
});
