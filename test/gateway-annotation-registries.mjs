// The two build-time registries the Gateway's $metadata annotations read
// (milestone 3 B4): text pools out of <TPOOL>/<I18N_TPOOL>, dictionary field
// information out of TABL/DTEL/DOMA. The run-time side is ABAP Unit
// (test/unit/zcl_osd_h5x_test, ltcl_annotations) on the twin in
// test/hana-m2.
import {expect} from "chai";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {abapText, parsePool, registryClass as poolClass, textPools} from "../tools/osd-textpool-registry.mjs";
import {ddicInfo, parseDtel, parseTabl, registryClass as ddicClass} from "../tools/osd-ddic-info-registry.mjs";

const wrap = (inner) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${inner}</asx:values></asx:abap></abapGit>`;
const tpoolItem = (id, key, entry) => `<item><ID>${id}</ID>${key ? `<KEY>${key}</KEY>` : ""}<ENTRY>${entry}</ENTRY><LENGTH>40</LENGTH></item>`;

describe("tools/osd-textpool-registry: text pools for the run time", () => {
  it("reads the master language and the translations of a class", () => {
    const pool = parsePool(wrap(`<VSEOCLASS><CLSNAME>ZCL_X_MPC</CLSNAME><LANGU>E</LANGU></VSEOCLASS>
      <TPOOL>${tpoolItem("I", "001", "Line Item")}${tpoolItem("I", "002", "Price ")}</TPOOL>
      <I18N_TPOOL><item><LANGUAGE>D</LANGUAGE><TEXTPOOL>${tpoolItem("I", "002", "Preis")}</TEXTPOOL></item></I18N_TPOOL>`), "zcl_x_mpc.clas.xml");
    expect(pool.program).to.equal("ZCL_X_MPC");
    expect(pool.rows).to.deep.equal([
      {langu: "E", id: "I", key: "001", entry: "Line Item"},
      {langu: "E", id: "I", key: "002", entry: "Price"},
      {langu: "D", id: "I", key: "002", entry: "Preis"},
    ]);
  });

  it("reads a program's pool, which abapGit writes without a language", () => {
    const pool = parsePool(wrap(`<PROGDIR><NAME>ZREPORT</NAME></PROGDIR><TPOOL>${tpoolItem("R", "", "A report")}</TPOOL>`), "zreport.prog.xml");
    expect(pool).to.deep.include({program: "ZREPORT", master: "E"});
    expect(pool.rows).to.deep.equal([{langu: "E", id: "R", key: "", entry: "A report"}]);
  });

  it("writes no text that is not 7-bit ASCII into the ABAP, and no line over 255", () => {
    // a German entry of the full 132 characters: 264 bytes of UTF-8 at most
    // here, so two hex chunks; ABAP source stays ASCII
    const long = "Maßeinheit ".repeat(12);
    const abap = poolClass([{program: "ZCL_X", rows: [{langu: "D", id: "I", key: "001", entry: long}]}]);
    expect(abap).to.match(/^[\x00-\x7f]*$/);
    expect(abap.split("\n").every((line) => line.length <= 255)).to.equal(true);
    expect(abap).to.contain("iv_hex1 = '4D61C39F");
    expect(abap).to.contain("iv_hex2 = '");
    expect(abapText("it's")).to.equal("'it''s'");
  });

  it("reads the twin's pool from the input folders", () => {
    const pools = textPools(["test/hana-m2"]);
    const twin = pools.find((p) => p.program === "ZCL_OSD_H5X_MPC");
    expect(twin.rows.map((r) => `${r.langu}/${r.key}/${r.entry}`)).to.deep.equal(
      ["E/001/Line Item", "E/002/Item to Release", "D/002/Freizugebende Position"]);
    expect(poolClass(pools)).to.contain("WHEN 'ZCL_OSD_H5X_MPC'.");
  });

  it("lets the later folder win a class file", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-tpool-"));
    try {
      for (const [layer, text] of [["a", "Old"], ["b", "New"]]) {
        mkdirSync(join(root, layer));
        writeFileSync(join(root, layer, "zcl_y.clas.xml"), wrap(`<VSEOCLASS><CLSNAME>ZCL_Y</CLSNAME><LANGU>E</LANGU></VSEOCLASS><TPOOL>${tpoolItem("I", "001", text)}</TPOOL>`));
      }
      const pools = textPools([join(root, "a"), join(root, "b")]);
      expect(pools.map((p) => p.rows[0].entry)).to.deep.equal(["New"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

describe("tools/osd-ddic-info-registry: dictionary field information for the run time", () => {
  it("resolves an include, a data element's type and its translated labels (the twin)", () => {
    const info = ddicInfo(["test/hana-m2"]);
    const item = info.structures.find((s) => s.name === "ZOSD_H5X_S_ITEM");
    expect(item.fields.map((f) => f.fieldname)).to.deep.equal(
      ["ITEM_NO", "NOTE", "AMOUNT", "CURRENCY", "QUANTITY", "UNIT", "DELIV_DATE", "CHANGED_BY"]);
    expect(item.fields.find((f) => f.fieldname === "AMOUNT")).to.deep.equal(
      {fieldname: "AMOUNT", rollname: "ZOSD_H5X_AMOUNT", datatype: "CURR", reftable: "ZOSD_H5X_S_ITEM", reffield: "CURRENCY"});
    expect(item.fields.find((f) => f.fieldname === "NOTE")).to.include({rollname: "", datatype: "CHAR"});
    const unit = info.elements.find((d) => d.name === "ZOSD_H5X_UNIT");
    expect(unit.labels.map((l) => `${l.langu}:${l.medium}`)).to.deep.equal(["E:Unit", "D:Maßeinheit"]);
    // the structures that bind nothing (no data element, no reference field)
    // stay out
    expect(info.structures.map((s) => s.name)).not.to.include("ZOSD_H5X_BP");
    // the types a model reads, by data element, for a type RTTI names
    expect(info.types).to.deep.include({name: "ZOSD_H5X_CURRENCY", datatype: "CUKY"});
    expect(info.types.map((t) => t.name)).not.to.include("ZOSD_H5X_ITEM_NO");
    expect(ddicClass(info)).to.contain("WHEN 'ZOSD_H5X_CURRENCY'.\n        rv_datatype = 'CUKY'.");
  });

  it("takes the type from the domain when the data element names one", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-ddic-"));
    try {
      writeFileSync(join(root, "zs.tabl.xml"), wrap(`<DD02V><TABNAME>ZS</TABNAME></DD02V><DD03P_TABLE><DD03P><FIELDNAME>F</FIELDNAME><ROLLNAME>ZE</ROLLNAME><COMPTYPE>E</COMPTYPE></DD03P></DD03P_TABLE>`));
      writeFileSync(join(root, "ze.dtel.xml"), wrap(`<DD04V><ROLLNAME>ZE</ROLLNAME><DDLANGUAGE>E</DDLANGUAGE><DOMNAME>ZD</DOMNAME><SCRTEXT_M>Field</SCRTEXT_M></DD04V>`));
      writeFileSync(join(root, "zd.doma.xml"), wrap(`<DD01V><DOMNAME>ZD</DOMNAME><DATATYPE>CUKY</DATATYPE></DD01V>`));
      const info = ddicInfo([root]);
      expect(info.structures[0].fields[0]).to.include({rollname: "ZE", datatype: "CUKY"});
      const abap = ddicClass(info);
      expect(abap).to.contain("WHEN 'ZS'.");
      expect(abap).to.contain("iv_medium  = 'Field'");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("refuses a dictionary name that is not one, rather than quoting around it", () => {
    const evil = wrap(`<DD02V><TABNAME>ZS</TABNAME></DD02V><DD03P_TABLE><DD03P><FIELDNAME>EVIL';DELETE FROM USERS;--</FIELDNAME><DATATYPE>CHAR</DATATYPE></DD03P></DD03P_TABLE>`);
    expect(() => parseTabl(evil)).to.throw(/is not a dictionary name/);
    expect(() => parsePool(wrap(`<VSEOCLASS><CLSNAME>ZCL_X' OR</CLSNAME><LANGU>E</LANGU></VSEOCLASS><TPOOL>${tpoolItem("I", "001", "x")}</TPOOL>`), "x.clas.xml"))
      .to.throw(/program name/);
  });

  it("keeps a label set only when it has a text", () => {
    const d = parseDtel(wrap(`<DD04V><ROLLNAME>ZE</ROLLNAME><DDLANGUAGE>E</DDLANGUAGE><DATATYPE>CHAR</DATATYPE></DD04V>`));
    expect(d.labels).to.deep.equal([]);
  });
});
