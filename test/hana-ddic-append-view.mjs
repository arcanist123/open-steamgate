import {expect} from "chai";
import * as abaplint from "@abaplint/core";
import {mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {run} from "../tools/hana-ddic-gen.mjs";

// H5d: the two refusals the first real closure run hit -- an APPEND
// structure (a customer append to a standard table) and a DDIC view (a
// domain-values view application code reads). The dump shapes are the
// measured ones: the base table's DD03L carries the include markers AND
// the included fields expanded under its own name (every copy ADMINFIELD
// '1', every plain row '0' -- the dictionary's own mark, and what the drop
// keys on); the append names its target in DD02L's SQLTAB; the view's
// fields are DD03L rows of its own.
// The fixtures are synthetic ZOSD_H5D_*; no tenant object name appears
// here (the leak list exists for a reason). No database and no HANA: the
// dump path is files in, XML out -- and the transpiler side is the tree's
// own abaplint registry over the written files.
describe("hana-ddic: APPEND structures and DDIC views from the dump (H5d)", () => {
  const dumpFixture = () => {
    const root = mkdtempSync(join(tmpdir(), "hana-ddic-h5d-"));
    mkdirSync(join(root, "tables"), {recursive: true});
    const table = (name, rows) => {
      writeFileSync(join(root, "tables", `${name}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
    };
    table("DD02L", [
      {TABNAME: "ZOSD_H5D_HEAD", TABCLASS: "TRANSP", CLIDEP: "X", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000", AS4DATE: "20260101", AS4USER: "SAP"},
      {TABNAME: "ZOSD_H5D_ADMIN", TABCLASS: "INTTAB", CLIDEP: "", MASTERLANG: "E", AS4LOCAL: "A", AS4VERS: "0000"},
      // the append: TABCLASS APPEND, its target in SQLTAB -- in the real
      // closure dump's shape the target is the INTTAB include the base
      // table's marker names, the way the fetched pack's own export spells
      // the chain
      {TABNAME: "ZOSD_H5D_APPEND", TABCLASS: "APPEND", CLIDEP: "", SQLTAB: "ZOSD_H5D_ADMIN", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"},
      // the DDIC view, the shape the dump carries (no join tables)
      {TABNAME: "ZOSD_H5D_VALUES", TABCLASS: "VIEW", CLIDEP: "", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD03L", [
      // the base table: key fields, an .INCLUDE marker, and the included
      // field AGAIN as the dump's expanded copy -- the duplication the real
      // closure dump measures. ADMINFIELD as the real DD03L carries it:
      // '1' on every expanded copy, '0' on every plain row and on the
      // markers (measured 16 of 16 copies against 265 of 265 plain rows)
      {TABNAME: "ZOSD_H5D_HEAD", POSITION: "1", FIELDNAME: "MANDT", KEYFLAG: "X", ROLLNAME: "MANDT", COMPTYPE: "E", DATATYPE: "CLNT", LENG: "3", DECIMALS: "0", INTTYPE: "C", INTLEN: "000006", NOTNULL: "X", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_HEAD", POSITION: "2", FIELDNAME: "ZOSD_H5D_KEY", KEYFLAG: "X", ROLLNAME: "", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", NOTNULL: "X", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_HEAD", POSITION: "3", FIELDNAME: ".INCLUDE", COMPTYPE: "S", PRECFIELD: "ZOSD_H5D_ADMIN", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_HEAD", POSITION: "4", FIELDNAME: "ZOSD_H5D_ADMIN_A", COMPTYPE: "", DATATYPE: "CHAR", LENG: "1", DECIMALS: "0", INTTYPE: "C", INTLEN: "000002", ADMINFIELD: "1", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_HEAD", POSITION: "5", FIELDNAME: "ZOSD_H5D_TAIL", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "4", DECIMALS: "0", INTTYPE: "C", INTLEN: "000008", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      // the include: its own field, an .INCLU--AP marker for the append,
      // and the append's field as the dump's expanded copy
      {TABNAME: "ZOSD_H5D_ADMIN", POSITION: "1", FIELDNAME: "ZOSD_H5D_ADMIN_A", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "1", DECIMALS: "0", INTTYPE: "C", INTLEN: "000002", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_ADMIN", POSITION: "2", FIELDNAME: ".INCLU--AP", COMPTYPE: "S", PRECFIELD: "ZOSD_H5D_APPEND", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_ADMIN", POSITION: "3", FIELDNAME: "ZOSD_H5D_APPEND_F", COMPTYPE: "", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", ADMINFIELD: "1", AS4LOCAL: "A", AS4VERS: "0000"},
      // the append itself: one field, DD03L order
      {TABNAME: "ZOSD_H5D_APPEND", POSITION: "1", FIELDNAME: "ZOSD_H5D_APPEND_F", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      // the view: two DD03L rows of its own, the first one key
      {TABNAME: "ZOSD_H5D_VALUES", POSITION: "1", FIELDNAME: "ZOSD_H5D_DOMNAME", KEYFLAG: "X", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "30", DECIMALS: "0", INTTYPE: "C", INTLEN: "000060", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_VALUES", POSITION: "2", FIELDNAME: "ZOSD_H5D_TEXT", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "60", DECIMALS: "0", INTTYPE: "C", INTLEN: "000120", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD02T", [
      {TABNAME: "ZOSD_H5D_HEAD", DDTEXT: "h5d fixture head", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_ADMIN", DDTEXT: "h5d fixture admin include", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_APPEND", DDTEXT: "h5d fixture append", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_VALUES", DDTEXT: "h5d fixture values view", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    return root;
  };

  it("writes the append as its own TABL and the view as a read-only structure, markers kept", async () => {
    const dump = dumpFixture();
    const out = join(dump, "out");
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(String(line));
    try {
      expect(await run(["--from-dump", dump, "--out", out])).to.equal(0);
      console.log = log;
      // what a view became and where its reads stand: the summary's own
      // view line (CRITIC-929 SHOULD 4), not a refusal of another kind
      expect(lines.join("\n")).to.include("1 view(s) written as read-only structure type(s)");
      expect(lines.join("\n")).to.include("SQL time");
      expect(lines.join("\n")).to.include("synonym");
      expect(readdirSync(out).sort()).to.deep.equal([
        "zosd_h5d_admin.tabl.xml", "zosd_h5d_append.tabl.xml", "zosd_h5d_head.tabl.xml", "zosd_h5d_values.tabl.xml"]);
      const head = readFileSync(join(out, "zosd_h5d_head.tabl.xml"), "utf8");
      expect(head).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
      expect(head).to.include(`<CLIDEP>X</CLIDEP>`);
      expect(head).to.include(`<DD09L>`);
      // the marker, spelled the way an export spells it
      expect(head).to.match(/<FIELDNAME>\.INCLUDE<\/FIELDNAME>\s*<COMPTYPE>S<\/COMPTYPE>\s*<PRECFIELD>ZOSD_H5D_ADMIN<\/PRECFIELD>\s*<MASK>      S<\/MASK>/);
      // the dump's expanded copy is dropped: the marker names the include,
      // the field rides in its expansion (the registry test below holds
      // that the TYPE gains it)
      expect(head.split("ZOSD_H5D_ADMIN_A").length - 1, "the expanded copy gone").to.equal(0);
      expect(head).to.include(`<FIELDNAME>ZOSD_H5D_TAIL</FIELDNAME>`);
      const admin = readFileSync(join(out, "zosd_h5d_admin.tabl.xml"), "utf8");
      expect(admin).to.include(`<TABCLASS>INTTAB</TABCLASS>`);
      expect(admin).to.not.include(`<DD09L>`);
      expect(admin).to.match(/<FIELDNAME>\.INCLU--AP<\/FIELDNAME>\s*<COMPTYPE>S<\/COMPTYPE>\s*<PRECFIELD>ZOSD_H5D_APPEND<\/PRECFIELD>/);
      expect(admin.split("ZOSD_H5D_APPEND_F").length - 1, "the expanded copy gone").to.equal(0);
      const append = readFileSync(join(out, "zosd_h5d_append.tabl.xml"), "utf8");
      expect(append).to.include(`<TABCLASS>APPEND</TABCLASS>`);
      expect(append).to.include(`<SQLTAB>ZOSD_H5D_ADMIN</SQLTAB>`);
      expect(append).to.not.include(`<DD09L>`);
      expect(append).to.include(`<FIELDNAME>ZOSD_H5D_APPEND_F</FIELDNAME>`);
      expect(append).to.include(`<DDTEXT>h5d fixture append</DDTEXT>`);
      const view = readFileSync(join(out, "zosd_h5d_values.tabl.xml"), "utf8");
      expect(view).to.include(`<TABCLASS>VIEW</TABCLASS>`);
      expect(view).to.not.include(`<DD09L>`);
      expect(view).to.not.include(`<CLIDEP>`);
      expect(view).to.include(`<FIELDNAME>ZOSD_H5D_DOMNAME</FIELDNAME>`);
      expect(view).to.include(`<FIELDNAME>ZOSD_H5D_TEXT</FIELDNAME>`);
      expect(view).to.include(`<DDTEXT>h5d fixture values view</DDTEXT>`);
    } finally {
      console.log = log;
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("a POOL still refuses the run by name, and the refusal is about the TABCLASS alone", async () => {
    const dump = dumpFixture();
    writeFileSync(join(dump, "tables", "DD02L.jsonl"),
      readFileSync(join(dump, "tables", "DD02L.jsonl"), "utf8") +
      JSON.stringify({TABNAME: "ZOSD_H5D_POOLX", TABCLASS: "POOL", CLIDEP: "", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"}) + "\n");
    let error;
    try {
      await run(["--from-dump", dump, "--out", join(dump, "out")]);
    } catch (thrown) {
      error = thrown;
    }
    try {
      expect(error?.message ?? "(no refusal)").to.include("ZOSD_H5D_POOLX");
      expect(error?.message ?? "(no refusal)").to.include("POOL");
      // the view sentence is the summary line's and the docs'
      // (CRITIC-929 SHOULD 4): a POOL error about another kind carries
      // neither word
      expect(error?.message ?? "(no refusal)").to.not.include("synonym");
      expect(error?.message ?? "(no refusal)").to.not.include("SQL time");
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("the transpiler sees the appended fields on the target table and the view as a structure", async () => {
    // the whole point, held in the tree's own registry: the generated files
    // load, the base table's type carries the include's field AND the
    // append's field (the markers expanded off PRECFIELD, the route the
    // fetched pack's exports take, nothing merged by the generator), and
    // the view resolves as a read-only structure with its DD03L fields --
    // not a table with keys.
    const dump = dumpFixture();
    const out = join(dump, "out");
    try {
      expect(await run(["--from-dump", dump, "--out", out])).to.equal(0);
      const reg = new abaplint.Registry();
      for (const file of readdirSync(out).sort()) {
        reg.addFile(new abaplint.MemoryFile(file, readFileSync(join(out, file), "utf8")));
      }
      reg.parse();
      const head = reg.getObject("TABL", "ZOSD_H5D_HEAD");
      const type = head.parseType(reg);
      expect(type.constructor?.name, "the base table is a structure type").to.equal("StructureType");
      const names = type.getComponents().map((c) => String(c.name).toUpperCase());
      expect(names, "the include's field, through the marker").to.include("ZOSD_H5D_ADMIN_A");
      expect(names, "the appended field, through the include's .INCLU--AP").to.include("ZOSD_H5D_APPEND_F");
      expect(names, "the field after the include").to.include("ZOSD_H5D_TAIL");
      expect(names, "no field written twice").to.have.length(5);
      expect(head.listKeys(reg)).to.deep.equal(["MANDT", "ZOSD_H5D_KEY"]);
      const view = reg.getObject("TABL", "ZOSD_H5D_VALUES");
      const viewType = view.parseType(reg);
      expect(viewType.constructor?.name, "the view is a structure type").to.equal("StructureType");
      expect(viewType.getComponents().map((c) => String(c.name).toUpperCase()))
        .to.deep.equal(["ZOSD_H5D_DOMNAME", "ZOSD_H5D_TEXT"]);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  // CRITIC-929 MUST 1 (c): the shape the name rule missed -- a .INCLU-01
  // marker and the dump's expansion rows under the suffixed names, ADMINFIELD
  // '1' as the real dump carries on every one of its 16 copies. Before the
  // mark was read (and before the generation-time refusal) the copies went
  // out beside the marker and the transpiler died with a duplicate field
  // name; now the mark drops them and the transpiler's own suffix rename
  // makes the kept marker produce the A01 name by itself.
  it("drops a .INCLU-01 marker's ADMINFIELD-'1' copies; the transpiler renames the kept marker itself", async () => {
    const root = mkdtempSync(join(tmpdir(), "hana-ddic-h5d-sfx-"));
    mkdirSync(join(root, "tables"), {recursive: true});
    const table = (name, rows) => {
      writeFileSync(join(root, "tables", `${name}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
    };
    table("DD02L", [
      {TABNAME: "ZOSD_H5D_SFX_BASE", TABCLASS: "TRANSP", CLIDEP: "", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_SFX_INC", TABCLASS: "INTTAB", CLIDEP: "", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD03L", [
      {TABNAME: "ZOSD_H5D_SFX_BASE", POSITION: "1", FIELDNAME: "ZOSD_H5D_SFX_KEY", KEYFLAG: "X", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_SFX_BASE", POSITION: "2", FIELDNAME: ".INCLU-01", COMPTYPE: "S", PRECFIELD: "ZOSD_H5D_SFX_INC", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      // the dump's expansion row: the suffixed name, the dictionary's mark
      {TABNAME: "ZOSD_H5D_SFX_BASE", POSITION: "3", FIELDNAME: "ZOSD_H5D_SFX_A01", COMPTYPE: "", DATATYPE: "CHAR", LENG: "1", DECIMALS: "0", INTTYPE: "C", INTLEN: "000002", ADMINFIELD: "1", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_SFX_BASE", POSITION: "4", FIELDNAME: "ZOSD_H5D_SFX_TAIL", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "4", DECIMALS: "0", INTTYPE: "C", INTLEN: "000008", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5D_SFX_INC", POSITION: "1", FIELDNAME: "ZOSD_H5D_SFX_A", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "1", DECIMALS: "0", INTTYPE: "C", INTLEN: "000002", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    const out = join(root, "out");
    try {
      expect(await run(["--from-dump", root, "--out", out])).to.equal(0);
      const base = readFileSync(join(out, "zosd_h5d_sfx_base.tabl.xml"), "utf8");
      expect(base).to.include(`<FIELDNAME>.INCLU-01</FIELDNAME>`);
      expect(base, "the expansion row dropped").to.not.include(`ZOSD_H5D_SFX_A01`);
      expect(base).to.include(`<FIELDNAME>ZOSD_H5D_SFX_TAIL</FIELDNAME>`);
      // the whole point, in the tree's own registry: the files load, and
      // the type carries the include's field under the renamed A01 name
      // the dump's expansion row spelled -- once
      const reg = new abaplint.Registry();
      for (const file of readdirSync(out).sort()) {
        reg.addFile(new abaplint.MemoryFile(file, readFileSync(join(out, file), "utf8")));
      }
      reg.parse();
      const type = reg.getObject("TABL", "ZOSD_H5D_SFX_BASE").parseType(reg);
      expect(type.getComponents().map((c) => String(c.name).toUpperCase()))
        .to.deep.equal(["ZOSD_H5D_SFX_KEY", "ZOSD_H5D_SFX_A01", "ZOSD_H5D_SFX_TAIL"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});
