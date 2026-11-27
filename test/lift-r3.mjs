import {expect} from "chai";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {DatabaseSync} from "node:sqlite";
import {ABAP, types} from "@abaplint/runtime";
import {modelR3FromSource} from "../tools/lift.mjs";
import {region, render} from "../tools/dsl-regions.mjs";

const FILE = "recipes/r3-filter-into-where/sample/zcl_osd_lift_r3_probe.clas.abap";
const SOURCE = readFileSync(FILE, "utf8");
const model = (source = SOURCE) => modelR3FromSource(basename(FILE), source, "before");

describe("verified lift R3", () => {
  describe("a statement sharing a line with the cut points is refused, not dropped", () => {
    const BODY = "CONCATENATE rv_text ls_row-seq INTO rv_text.";
    const cases = [
      ["after CHECK", (s) => s.replace(`CHECK ls_row-active = 'X'.\n      ${BODY}`, `CHECK ls_row-active = 'X'. ${BODY}`)],
      ["after ENDIF of IF ... CONTINUE", (s) => s.replace(`CHECK ls_row-active = 'X'.\n      ${BODY}`,
        `IF ls_row-active <> 'X'.\n        CONTINUE.\n      ENDIF. ${BODY}`)],
      ["before ENDSELECT", (s) => s.replace(`${BODY}\n    ENDSELECT.`, `${BODY} ENDSELECT.`)],
    ];
    for (const [label, edit] of cases) {
      it(label, () => {
        const source = edit(SOURCE);
        expect(source).to.not.equal(SOURCE);
        expect(() => model(source)).to.throw(/shares its line/);
      });
    }
    it("a comment after the filter is fine", () => {
      const source = SOURCE.replace("CHECK ls_row-active = 'X'.", "CHECK ls_row-active = 'X'. \" active only");
      expect(model(source).body).to.equal(BODY);
    });
  });

  it("moves the first CHECK into WHERE and keeps ORDER BY", () => {
    const result = model();
    expect(result.select).to.equal("SELECT * FROM zosd_lift_r2 INTO ls_row WHERE kind = 'STAT' AND active = 'X' ORDER BY PRIMARY KEY.");
    expect(result.body).to.equal("CONCATENATE rv_text ls_row-seq INTO rv_text.");
    expect(result.open).to.include("ABAP and Open SQL CHAR case/collation agreement on A4H");
  });
  it("maps IF/CONTINUE by complementing the comparison", () => {
    const source = SOURCE.replace("CHECK ls_row-active = 'X'.", "IF ls_row-active <> 'X'.\n        CONTINUE.\n      ENDIF.");
    const result = model(source);
    expect(result.select).to.include("AND active = 'X' ORDER BY");
    expect(result.body).to.equal("CONCATENATE rv_text ls_row-seq INTO rv_text.");
  });
  it("models a same-width loop-invariant host value in 7.02 syntax", () => {
    const source = SOURCE.replace("DATA ls_row TYPE zosd_lift_r2.", "DATA ls_row TYPE zosd_lift_r2.\n    DATA lv_active TYPE c LENGTH 1.")
      .replace("CHECK ls_row-active = 'X'.", "CHECK ls_row-active = lv_active.");
    expect(model(source).select).to.include("AND active = lv_active ORDER BY");
    expect(model(source).open).to.include("lv_active is not changed through an alias or call during the loop");
    expect(() => model(source.replace("CONCATENATE rv_text ls_row-seq INTO rv_text.", "CLEAR lv_active.\n      CONCATENATE rv_text ls_row-seq INTO rv_text.")))
      .to.throw(/loop invariant/);
  });
  const hostSource = () => SOURCE.replace("DATA ls_row TYPE zosd_lift_r2.", "DATA ls_row TYPE zosd_lift_r2.\n    DATA lv_active TYPE c LENGTH 1.")
    .replace("CHECK ls_row-active = 'X'.", "CHECK ls_row-active = lv_active.");
  for (const [name, statement] of [
    ["assignment", "lv_active = 'Y'."], ["CONDENSE", "CONDENSE lv_active."],
    ["SHIFT", "SHIFT lv_active."], ["REPLACE", "REPLACE 'X' IN lv_active WITH 'Y'."],
    ["CHANGING call", "zcl_osd_lift_r3_probe=>change( CHANGING value = lv_active )."],
  ]) {
    it(`refuses host ${name} after CHECK`, () => {
      const source = hostSource().replace("CONCATENATE rv_text", `${statement}\n      CONCATENATE rv_text`);
      expect(() => model(source)).to.throw(/loop invariant/);
    });
  }
  it("refuses an enclosing DO with a preceding sy-subrc read", () => {
    const source = SOURCE.replace("    SELECT * FROM", "    DO 2 TIMES.\n      rv_text = sy-subrc.\n    SELECT * FROM")
      .replace("    ENDSELECT.\n  ENDMETHOD.", "    ENDSELECT.\n    ENDDO.\n  ENDMETHOD.");
    expect(() => model(source)).to.throw(/enclosing loop/);
  });
  it("lists a caller's later sy-subrc read as open", () => {
    expect(model().open).to.include("caller reads sy-subrc after the method returns");
  });
  it("keeps dollar signs in a literal predicate", () => {
    expect(model(SOURCE.replace("CHECK ls_row-active = 'X'.", () => "CHECK ls_row-active = '$'.")).select)
      .to.include("active = '$' ORDER BY");
  });
  it("preserves comments and body indentation", () => {
    const source = SOURCE.replace("      CONCATENATE rv_text ls_row-seq INTO rv_text.",
      "      \" first comment\n        CONCATENATE rv_text ls_row-seq INTO rv_text. \" tail\n      \" last comment");
    expect(model(source).body).to.equal("\" first comment\n  CONCATENATE rv_text ls_row-seq INTO rv_text. \" tail\n\" last comment");
  });
  it("renders the generated region with L0 and a line trace", async function () {
    this.timeout(120000);
    if (!existsSync("output/zcl_osd_tpl.clas.mjs")) this.skip();
    const rendered = await render(model(), "recipes/r3-filter-into-where/template.tpl");
    expect(region(SOURCE, "before")).to.equal(rendered.text);
    expect(rendered.trace.length).to.be.greaterThan(0);
  });

  const refusals = [
    ["limit", (s) => s.replace("FROM zosd_lift_r2 INTO", "FROM zosd_lift_r2 UP TO 2 ROWS INTO"), /UP TO n ROWS/],
    ["dynamic WHERE", (s) => s.replace("WHERE kind = 'STAT'", "WHERE (lv_w)"), /dynamic WHERE/],
    ["CHAR order", (s) => s.replace("CHECK ls_row-active = 'X'", "CHECK ls_row-active < 'X'"), /CHAR order/],
    ["effect before CHECK", (s) => s.replace("      CHECK ls_row-active", "      CLEAR rv_text.\n      CHECK ls_row-active"), /no side effect before the filter/],
    ["foreign row", (s) => s.replace("CHECK ls_row-active", "CHECK ls_other-active"), /reads only the row/],
    ["unknown column", (s) => s.replace("CHECK ls_row-active", "CHECK ls_row-missing"), /reads only the row/],
    ["NUMC literal", (s) => s.replace("CHECK ls_row-active = 'X'", "CHECK ls_row-seq = '1'"), /type pair/],
    ["CHAR length", (s) => s.replace("CHECK ls_row-active = 'X'", "CHECK ls_row-active = 'XX'"), /CHAR length/],
    ["CP mapping", (s) => s.replace("CHECK ls_row-active = 'X'", "CHECK ls_row-active CP 'X'"), /op mapping/],
    ["sy-dbcnt", (s) => s.replace("CONCATENATE rv_text ls_row-seq INTO rv_text.", "CONCATENATE rv_text ls_row-seq INTO rv_text.\n      rv_text = sy-dbcnt."), /sy-dbcnt/],
    ["sy-subrc after", (s) => s.replace("    ENDSELECT.\n  ENDMETHOD.", "    ENDSELECT.\n    rv_text = sy-subrc.\n  ENDMETHOD."), /sy-subrc/],
    ["table form", (s) => s.replace("SELECT * FROM zosd_lift_r2 INTO ls_row", "SELECT * FROM zosd_lift_r2 INTO TABLE lt_rows"), /shape/],
    ["OR precedence", (s) => s.replace("WHERE kind = 'STAT' ORDER", "WHERE kind = 'STAT' OR kind = 'PRIO' ORDER"), /WHERE grouping/],
    ["explicit projection", (s) => s.replace("SELECT * FROM zosd_lift_r2 INTO ls_row", "SELECT active FROM zosd_lift_r2 INTO ls_row"), /projection/],
    ["different row type", (s) => s.replace("DATA ls_row TYPE zosd_lift_r2.", "DATA ls_row TYPE zosd_lift_txt."), /row type/],
  ];
  for (const [name, change, reason] of refusals) {
    it(`refuses ${name}`, () => expect(() => model(change(SOURCE))).to.throw(reason));
  }

  it("refuses a nullable DDIC column, even for an initial value", () => {
    const s = SOURCE.replace("CHECK ls_row-active = 'X'", "CHECK ls_row-ltext = '                                        '");
    const folder = mkdtempSync(join(tmpdir(), "lift-r3-ddic-"));
    try {
      const xml = readFileSync("src/lift/zosd_lift_r2.tabl.xml", "utf8");
      writeFileSync(join(folder, "zosd_lift_r2.tabl.xml"), xml.replace(
        /(<FIELDNAME>LTEXT<\/FIELDNAME>[\s\S]*?)<NOTNULL>X<\/NOTNULL>/,
        "$1"));
      expect(() => modelR3FromSource(basename(FILE), s, "before", [folder])).to.throw(/NULL/);
    } finally {
      rmSync(folder, {recursive: true, force: true});
    }
  });

  it("differential: the accepted predicate agrees on seeded non-null rows", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE rows (seq TEXT, active TEXT)");
    const insert = db.prepare("INSERT INTO rows VALUES (?, ?)");
    for (const row of [["001", "X"], ["002", ""], ["003", "X"]]) insert.run(...row);
    const before = db.prepare("SELECT * FROM rows ORDER BY seq").all().filter((row) => row.active === "X").map((row) => row.seq);
    const after = db.prepare("SELECT * FROM rows WHERE active = 'X' ORDER BY seq").all().map((row) => row.seq);
    expect(after).to.deep.equal(before);
    db.close();
  });

  it("SQLite demonstrates that filter after limit loses a passing row", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE rows (seq INTEGER, active TEXT)");
    db.exec("INSERT INTO rows VALUES (1, ''), (2, 'X')");
    const before = db.prepare("SELECT * FROM rows ORDER BY seq LIMIT 1").all().filter((r) => r.active === "X");
    const naive = db.prepare("SELECT * FROM rows WHERE active = 'X' ORDER BY seq LIMIT 1").all();
    expect(before).to.have.length(0);
    expect(naive).to.have.length(1);
    db.close();
  });

  it("SQLite demonstrates NULL, NUMC and CHAR-length differences with seeded values", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE rows (c TEXT, n TEXT, nullable TEXT)");
    db.exec("INSERT INTO rows VALUES ('A   ', '0012', NULL)");
    const row = db.prepare("SELECT * FROM rows").get();
    expect(row.nullable ?? "").to.equal(""); // ABAP initial value after fetch
    expect(db.prepare("SELECT * FROM rows WHERE nullable = ''").all()).to.have.length(0);
    expect(row.n).to.equal("0012");
    expect(db.prepare("SELECT * FROM rows WHERE n = '12'").all()).to.have.length(0);
    expect(row.c.trimEnd()).to.equal("A");
    expect(db.prepare("SELECT * FROM rows WHERE c = 'A'").all()).to.have.length(0);
    db.close();
  });

  it("measures local ABAP comparison operators against SQLite type pairs", () => {
    const abap = new ABAP();
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE pairs (c TEXT, n TEXT, p NUMERIC, nullable TEXT)");
    db.exec("INSERT INTO pairs VALUES ('A  ', '0012', 10.5, NULL)");
    const char3 = new types.Character(3).set("A");
    const numc4 = new types.Numc({length: 4}).set("12");
    const packed = new types.Packed({length: 3, decimals: 2}).set("10.50");
    const observed = [
      ["CHAR shorter", abap.compare.eq(char3, new types.Character(1).set("A")), "c = 'A'"],
      ["CHAR longer", abap.compare.eq(char3, new types.Character(4).set("A")), "c = 'A   '"],
      ["NUMC number", abap.compare.eq(numc4, new types.Integer().set(12)), "n = 12"],
      ["NUMC literal", abap.compare.eq(numc4, new types.Character(2).set("12")), "n = '12'"],
      ["case", abap.compare.eq(new types.Character(3).set("A"), new types.Character(3).set("a")), "c = 'a  '"],
      ["packed number", abap.compare.eq(packed, new types.Integer().set(10)), "p = 10"],
      ["NULL initial", abap.compare.eq(new types.Character(1).set(""), new types.Character(1).set("")), "nullable = ''"],
    ].map(([name, abapResult, where]) => [name, abapResult, db.prepare(`SELECT * FROM pairs WHERE ${where}`).all().length > 0]);
    expect(observed).to.deep.equal([
      ["CHAR shorter", true, false], ["CHAR longer", true, false],
      // n against c compares as numbers (transpiler 2.14.38, #2216, measured on a system)
      ["NUMC number", true, false], ["NUMC literal", true, false],
      ["case", false, false], ["packed number", false, false],
      ["NULL initial", true, false],
    ]);
    db.close();
  });
});
