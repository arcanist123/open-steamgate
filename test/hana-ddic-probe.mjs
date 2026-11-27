import {expect} from "chai";
import {createRequire} from "node:module";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {run} from "../tools/hana-ddic-probe.mjs";
import {giveBackHdb} from "./hdb-stub.mjs";

// The DDIC probe's reads, against the columns a real schema actually has.
//
// Fix round 1: the first run of tools/hana-ddic-probe.mjs against a real
// system died on its first DD04L read with `invalid column name: INTTYPE` --
// the DD* column lists had been guessed. INTTYPE and INTLEN live on DD03L
// only; DD04L and DD01L carry DATATYPE, LENG, DECIMALS. The fixture below is
// the measured list (SYS.TABLE_COLUMNS of a real schema, **column names
// only** -- DD* table and column names are public SAP DDIC documentation, so
// they may live here; no data rows from any system do). The fake driver
// reads that list before it answers a statement and refuses any column the
// list does not carry, with HANA's own words -- so a guessed column fails
// here instead of on a system somebody owns.
describe("the DDIC probe's reads name only measured columns", () => {
  // the stand-in is given back after every test, so the next hdb consumer in
  // the shard's process meets the real driver (test/hdb-stub.mjs)
  afterEach(giveBackHdb);

  // the measured lists, in the order the measurement recorded them
  const DD_COLUMNS = {
    DD02L: [
      "TABNAME", "AS4LOCAL", "AS4VERS", "TABCLASS", "SQLTAB", "DATMIN", "DATMAX",
      "DATAVG", "CLIDEP", "BUFFERED", "COMPRFLAG", "LANGDEP", "ACTFLAG", "APPLCLASS",
      "AUTHCLASS", "AS4USER", "AS4DATE", "AS4TIME", "MASTERLANG", "MAINFLAG",
      "CONTFLAG", "RESERVETAB", "GLOBALFLAG", "PROZPUFF", "VIEWCLASS", "VIEWGRANT",
      "MULTIPLEX", "SHLPEXI", "PROXYTYPE", "EXCLASS", "WRONGCL", "ALWAYSTRP",
      "ALLDATAINCL", "WITH_PARAMETERS", "EXVIEW_INCLUDED", "KEYMAX_FEATURE",
      "KEYLEN_FEATURE", "TABLEN_FEATURE", "NONTRP_INCLUDED", "VIEWREF",
      "VIEWREF_ERR", "VIEWREF_POS_CHG", "TBFUNC_INCLUDED", "IS_GTT",
      "SESSION_VAR_EX", "FROM_ENTITY", "PK_IS_INVHASH", "USED_SESSION_VARS",
      "ABAP_LANGUAGE_VERSION", "HDB_ONLY_ENTITY_INCLUDED", "FIELD_SUFFIX",
      "QUOTA_MAX_FIELDS", "QUOTA_MAX_BYTES", "QUOTA_SHARE_PARTNER",
      "QUOTA_SHARE_CUSTOMER",
    ],
    DD03L: [
      "TABNAME", "FIELDNAME", "AS4LOCAL", "AS4VERS", "POSITION", "KEYFLAG",
      "MANDATORY", "ROLLNAME", "CHECKTABLE", "ADMINFIELD", "INTTYPE", "INTLEN",
      "REFTABLE", "PRECFIELD", "REFFIELD", "CONROUT", "NOTNULL", "DATATYPE",
      "LENG", "DECIMALS", "DOMNAME", "SHLPORIGIN", "TABLETYPE", "DEPTH",
      "COMPTYPE", "REFTYPE", "LANGUFLAG", "DBPOSITION", "ANONYMOUS",
      "OUTPUTSTYLE", "SRS_ID",
    ],
    DD04L: [
      "ROLLNAME", "AS4LOCAL", "AS4VERS", "DOMNAME", "ROUTPUTLEN", "MEMORYID",
      "LOGFLAG", "HEADLEN", "SCRLEN1", "SCRLEN2", "SCRLEN3", "ACTFLAG",
      "APPLCLASS", "AUTHCLASS", "AS4USER", "AS4DATE", "AS4TIME", "DTELMASTER",
      "RESERVEDTE", "DTELGLOBAL", "SHLPNAME", "SHLPFIELD", "DEFFDNAME",
      "DATATYPE", "LENG", "DECIMALS", "OUTPUTLEN", "LOWERCASE", "SIGNFLAG",
      "CONVEXIT", "VALEXI", "ENTITYTAB", "REFKIND", "REFTYPE", "PROXYTYPE",
      "LTRFLDDIS", "BIDICTRLC", "NOHISTORY", "ABAP_LANGUAGE_VERSION",
    ],
    DD01L: [
      "DOMNAME", "AS4LOCAL", "AS4VERS", "DATATYPE", "LENG", "OUTPUTLEN",
      "DECIMALS", "LOWERCASE", "SIGNFLAG", "LANGFLAG", "VALEXI", "ENTITYTAB",
      "CONVEXIT", "MASK", "MASKLEN", "ACTFLAG", "APPLCLASS", "AUTHCLASS",
      "AS4USER", "AS4DATE", "AS4TIME", "DOMMASTER", "RESERVEDOM", "DOMGLOBAL",
      "APPENDNAME", "APPEXIST", "PROXYTYPE", "OUTPUTSTYLE", "AMPMFORMAT",
      "ABAP_LANGUAGE_VERSION",
    ],
    DD02T: ["TABNAME", "DDLANGUAGE", "AS4LOCAL", "AS4VERS", "DDTEXT"],
    DD09L: [
      "TABNAME", "AS4LOCAL", "AS4VERS", "TABKAT", "TABART", "PUFFERUNG",
      "SCHFELDANZ", "PROTOKOLL", "SPEICHPUFF", "AS4USER", "AS4DATE", "AS4TIME",
      "TRANSPFLAG", "RESERVE", "UEBERSETZ", "ACTFLAG", "BUFALLOW", "JAVAONLY",
      "ROWORCOLST", "SHARINGTYPE", "LOAD_UNIT",
    ],
  };
  // what the measurement counted; a transcription slip in the fixture above
  // fails here, by name, instead of passing quietly
  const DD_COLUMN_COUNTS = {DD02L: 55, DD03L: 31, DD04L: 39, DD01L: 30, DD02T: 5, DD09L: 21};

  // `SELECT A, B FROM T WHERE ...` -- every DD* read the probe sends is a
  // plain column list; a future read that is not should fail here loudly
  // rather than parse half-way.
  const selectOf = (sql) => {
    const match = /^\s*SELECT\s+(.+?)\s+FROM\s+([A-Za-z_][A-Za-z_0-9]*)(\s|$)/i.exec(sql);
    if (match === null) return undefined;
    return {
      table: match[2].toUpperCase(),
      columns: match[1].split(",").map((c) => c.trim().toUpperCase()),
    };
  };

  // invented rows (ZOSD_H1_*), projected to the columns the statement named:
  // the fake answers what was asked, the way HANA does. ZOSD_H1_ELEM is typed
  // only through its data element and that element's domain, so the DD04L and
  // DD01L reads -- the ones the guess broke -- are exercised on every run.
  const DD_ROWS = {
    DD02L: [{TABNAME: "ZOSD_H1_PROBE", TABCLASS: "TRANSP", CLIDEP: "X"}],
    DD03L: [
      {POSITION: "1", FIELDNAME: "MANDT", KEYFLAG: "X", ROLLNAME: "MANDT", DATATYPE: "CLNT", LENG: "3", DECIMALS: "0", INTTYPE: "C", INTLEN: "000006", NOTNULL: "X"},
      {POSITION: "2", FIELDNAME: "ZOSD_H1_KEY", KEYFLAG: "X", ROLLNAME: "", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", NOTNULL: "X"},
      {POSITION: "3", FIELDNAME: "ZOSD_H1_ELEM", KEYFLAG: "", ROLLNAME: "ZOSD_H1_DTEL", DATATYPE: "", LENG: "", DECIMALS: "", INTTYPE: "", INTLEN: "", NOTNULL: ""},
      // a QUAN with its reference, keyed as a real DD03L row is: the three
      // reference columns travel through query(), which folds every key to
      // lower case on the way out -- PRECFIELD arrives at the map as
      // `precfield`, not as the `preffield` the map read until fix round 3
      {POSITION: "4", FIELDNAME: "ZOSD_H1_QTY", KEYFLAG: "", ROLLNAME: "", DATATYPE: "QUAN", LENG: "13", DECIMALS: "3", INTTYPE: "P", INTLEN: "000007", NOTNULL: "", REFTABLE: "ZOSD_H1_REF", PRECFIELD: "ZOSD_H1_ELEM", REFFIELD: "ZOSD_H1_UNIT"},
    ],
    DD04L: [{ROLLNAME: "ZOSD_H1_DTEL", DOMNAME: "ZOSD_H1_DOMA", DATATYPE: "", LENG: "", DECIMALS: ""}],
    DD01L: [{DOMNAME: "ZOSD_H1_DOMA", DATATYPE: "DEC", LENG: "9", DECIMALS: "2"}],
    DD02T: [{TABNAME: "ZOSD_H1_PROBE", DDTEXT: "probe fixture table"}],
  };
  const rowsFor = (select) => (DD_ROWS[select.table] ?? []).map((row) => {
    const projected = {};
    for (const column of select.columns) projected[column] = row[column] ?? "";
    return projected;
  });

  // connect() reaches the driver through createRequire("hdb"); the same CJS
  // cache a real require would use is pointed at a stand-in first (the way
  // test/hana-existing-schema.mjs does it). No prepare: query() takes the
  // plain exec path.
  // the fake stands in through the CJS cache a real require uses; the
  // suites runner runs a shard's files in ONE process, so the stand-in is
  // given back after every test -- the next hdb consumer in the shard
  // otherwise gets a driver without prepare (FIX-4, the sqlscript suites).
  // the give-back is a DELETE, not a restore: at the first fakeHdb call the
  // real driver has never been required (hana-client loads hdb inside
  // connect()), so a saved original would be undefined and every restore
  // would return early -- the stand-in then survived the suite (the second
  // hold's GREEN 3: sqlscript-eager connected through it, prepare missing).
  // The next require after the delete loads the real driver fresh.
  afterEach(() => {
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve("hdb")];
  });

  const fakeHdb = () => {
    const sent = [];
    const refused = [];
    const require = createRequire(import.meta.url);
    const path = require.resolve("hdb");
    require.cache[path] = {
      id: path,
      filename: path,
      loaded: true,
      exports: {createClient: () => ({
        connect: (cb) => cb(undefined),
        setAutoCommit: () => undefined,
        exec: (sql, cb) => {
          sent.push(sql);
          const select = selectOf(sql);
          if (select === undefined) return cb(undefined, 1); // SET SCHEMA
          const known = DD_COLUMNS[select.table];
          if (known === undefined) {
            refused.push(`${select.table} (whole table outside the measured list)`);
            return cb(new Error(`table ${select.table} is not in this test's measured list`));
          }
          const unknown = select.columns.find((c) => known.includes(c) === false);
          if (unknown !== undefined) {
            refused.push(`${select.table}.${unknown}`);
            return cb(new Error(`invalid column name: ${unknown}`));
          }
          cb(undefined, rowsFor(select));
        },
        commit: (cb) => cb(undefined),
        rollback: (cb) => cb(undefined),
        end: () => undefined,
      })},
    };
    return {sent, refused};
  };

  it("the fixture is the measured list: the measured counts, no duplicate names", () => {
    for (const [table, count] of Object.entries(DD_COLUMN_COUNTS)) {
      expect(DD_COLUMNS[table], table).to.have.lengthOf(count);
      expect(new Set(DD_COLUMNS[table]).size, `${table}: duplicate names`).to.equal(count);
    }
  });

  it("the fake refuses a guessed column the way HANA refused INTTYPE", () => {
    // the check that would have caught fix round 1's failure, demonstrated on
    // its own: INTTYPE is not among DD04L's measured columns, so the read
    // that asked DD04L for it is refused before any row moves
    fakeHdb();
    const require = createRequire(import.meta.url);
    const client = require.cache[require.resolve("hdb")].exports.createClient();
    let error;
    client.exec(`SELECT INTTYPE FROM DD04L WHERE ROLLNAME = 'ZOSD_H1_DTEL'`, (e) => { error = e; });
    expect(error?.message).to.equal("invalid column name: INTTYPE");
  });

  it("reads the DD* tables naming only measured columns, active versions only", async () => {
    const fake = fakeHdb();
    const out = mkdtempSync(join(tmpdir(), "hana-ddic-probe-"));
    const lines = [];
    const say = console.log;
    console.log = (line) => lines.push(String(line));
    let code;
    process.env.OSD_CLIENT = "001"; // the mode refuses to start without a logon client (H3)
    try {
      code = await run(["--tables", "ZOSD_H1_PROBE", "--out", out, "--mandt"]);
    } finally {
      delete process.env.OSD_CLIENT;
      console.log = say;
    }
    try {
      expect(code, "the probe exits clean").to.equal(0);
      expect(fake.refused, "the fake refused nothing").to.deep.equal([]);
      // one read per DD* table, in the order the probe makes them
      const selects = fake.sent.map(selectOf).filter((s) => s !== undefined);
      expect(selects.map((s) => s.table), "the reads")
        .to.deep.equal(["DD02L", "DD03L", "DD04L", "DD01L", "DD02T"]);
      // TABCLASS/SQLTAB ride in the DD02L read, for the shared writer's
      // APPEND/VIEW shapes (CRITIC-929 SHOULD 1)
      expect(selects[0].columns, "the DD02L read").to.include("SQLTAB");
      for (const select of selects) {
        const outside = select.columns.filter((c) => DD_COLUMNS[select.table].includes(c) === false);
        expect(outside, `${select.table}: columns outside the measured list`).to.deep.equal([]);
      }
      // pinned to the active version: a table carrying an inactive version
      // would otherwise yield its fields twice
      for (const sql of fake.sent.filter((s) => /FROM DD/i.test(s))) {
        expect(sql, sql).to.include(`AS4LOCAL = 'A'`);
        expect(sql, sql).to.include(`AS4VERS = '0000'`);
      }
      // the run was the real run: XML written, MANDT answered
      expect(existsSync(join(out, "zosd_h1_probe.tabl.xml")), "--out wrote the table").to.equal(true);
      expect(lines.join("\n")).to.include("MANDT as the first key field: yes");
      // the reference columns travel from DD03L through the client into the
      // XML: PRECFIELD was read misspelled (`row.preffield`) until fix
      // round 3, so the tag never appeared however the row arrived
      const xmlText = readFileSync(join(out, "zosd_h1_probe.tabl.xml"), "utf8");
      expect(xmlText, "--out carries PRECFIELD from the client's row").to.include("<PRECFIELD>ZOSD_H1_ELEM</PRECFIELD>");
      expect(xmlText, "--out carries REFTABLE from the client's row").to.include("<REFTABLE>ZOSD_H1_REF</REFTABLE>");
      // where INTTYPE/INTLEN came from, said out loud: ZOSD_H1_ELEM's DD03L
      // row leaves both blank, so they were derived and the probe says so;
      // the other two fields carry DD03L's own values and are not mentioned
      const said = lines.join("\n");
      expect(said).to.match(/ZOSD_H1_ELEM.*derived/);
      expect(said).to.not.match(/MANDT.*derived/);
      expect(said).to.not.match(/ZOSD_H1_KEY.*derived/);
    } finally {
      rmSync(out, {recursive: true, force: true});
    }
  });

  // the file side of a --diff run. The clean fixture is what a system's own
  // abapGit export writes: every field resolved, and MANDT's block carrying
  // DATATYPE/LENG the way an export does (this tree's own writer spells the
  // client field shorter -- the --out output of the run above). The drift
  // fixture plants one wrong PRECFIELD into it and changes nothing else.
  const CLEAN_XML = `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V><TABNAME>ZOSD_H1_PROBE</TABNAME><TABCLASS>TRANSP</TABCLASS><DDTEXT>probe fixture table</DDTEXT></DD02V>
   <DD03P_TABLE>
    <DD03P><FIELDNAME>MANDT</FIELDNAME><KEYFLAG>X</KEYFLAG><ROLLNAME>MANDT</ROLLNAME><ADMINFIELD>0</ADMINFIELD><NOTNULL>X</NOTNULL><COMPTYPE>E</COMPTYPE><DATATYPE>CLNT</DATATYPE><LENG>000003</LENG><MASK>  CLNT</MASK></DD03P>
    <DD03P><FIELDNAME>ZOSD_H1_KEY</FIELDNAME><KEYFLAG>X</KEYFLAG><ADMINFIELD>0</ADMINFIELD><INTTYPE>C</INTTYPE><INTLEN>000020</INTLEN><NOTNULL>X</NOTNULL><DATATYPE>CHAR</DATATYPE><LENG>000010</LENG><MASK>  CHAR</MASK></DD03P>
    <DD03P><FIELDNAME>ZOSD_H1_ELEM</FIELDNAME><ROLLNAME>ZOSD_H1_DTEL</ROLLNAME><ADMINFIELD>0</ADMINFIELD><INTTYPE>P</INTTYPE><INTLEN>000005</INTLEN><DATATYPE>DEC</DATATYPE><LENG>000009</LENG><DECIMALS>000002</DECIMALS><MASK>  DEC</MASK></DD03P>
    <DD03P><FIELDNAME>ZOSD_H1_QTY</FIELDNAME><ADMINFIELD>0</ADMINFIELD><INTTYPE>P</INTTYPE><INTLEN>000007</INTLEN><REFTABLE>ZOSD_H1_REF</REFTABLE><PRECFIELD>ZOSD_H1_ELEM</PRECFIELD><REFFIELD>ZOSD_H1_UNIT</REFFIELD><DATATYPE>QUAN</DATATYPE><LENG>000013</LENG><DECIMALS>000003</DECIMALS><MASK>  QUAN</MASK></DD03P>
   </DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
  // the drift fixture plants one wrong PRECFIELD and nothing else. Its
  // MANDT block is spelled the way this tree's own writer does (no
  // DATATYPE), so the file side leaves the client field unresolved and the
  // run reaches the planted drift instead of dying in the MANDT compare the
  // clean fixture below exercises.
  const DRIFT_XML = CLEAN_XML
    .replace(
      `<DD03P><FIELDNAME>MANDT</FIELDNAME><KEYFLAG>X</KEYFLAG><ROLLNAME>MANDT</ROLLNAME><ADMINFIELD>0</ADMINFIELD><NOTNULL>X</NOTNULL><COMPTYPE>E</COMPTYPE><DATATYPE>CLNT</DATATYPE><LENG>000003</LENG><MASK>  CLNT</MASK></DD03P>`,
      `<DD03P><FIELDNAME>MANDT</FIELDNAME><KEYFLAG>X</KEYFLAG><ROLLNAME>MANDT</ROLLNAME><ADMINFIELD>0</ADMINFIELD><NOTNULL>X</NOTNULL><COMPTYPE>E</COMPTYPE></DD03P>`)
    .replace(
      "<PRECFIELD>ZOSD_H1_ELEM</PRECFIELD>",
      "<PRECFIELD>ZOSD_H1_WRONG</PRECFIELD>");

  // a --diff run over a planted src file. The probe walks src/ under
  // process.cwd(), so the run happens in the fixture's own directory, with
  // console.log captured the way the reads test does and the cwd restored
  // before any assertion runs.
  const diffRun = async (tablXml) => {
    fakeHdb(); // its own stand-in: no test may rely on a previous test's (the give-back deletes it, FIX-4)
    const root = mkdtempSync(join(tmpdir(), "hana-ddic-diff-"));
    const cwd = process.cwd();
    const lines = [];
    const say = console.log;
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "src", "zosd_h1_probe.tabl.xml"), tablXml);
    let code;
    process.env.OSD_CLIENT = "001"; // the mode refuses to start without a logon client (H3)
    try {
      // this run's own stand-in: the --diff tests never installed one and ran
      // on the previous test's leftover, which the give-back in afterEach now
      // deletes -- a test that needs the fake installs it (test/hdb-stub.mjs)
      fakeHdb();
      console.log = (line) => lines.push(String(line));
      process.chdir(root);
      code = await run(["--tables", "ZOSD_H1_PROBE", "--diff"]);
    } finally {
      delete process.env.OSD_CLIENT;
      process.chdir(cwd);
      console.log = say;
      rmSync(root, {recursive: true, force: true});
    }
    return {code, lines};
  };

  it("names a planted PRECFIELD drift: the file says X, DDIC says what the client delivered", async () => {
    // the drift line must carry DDIC's own value, not "(none)": until fix
    // round 3 the map dropped the client's precfield on the floor (it read
    // the column misspelled), so a planted wrong one said "DDIC says (none)"
    // and a planted-consistent file read as drift
    const {code, lines} = await diffRun(DRIFT_XML);
    expect(code, "the probe exits 1 on drift").to.equal(1);
    expect(lines.join("\n"), "the planted PRECFIELD drift is named with DDIC's value")
      .to.include("ZOSD_H1_QTY: preceding field: the file says ZOSD_H1_WRONG, DDIC says ZOSD_H1_ELEM");
    expect(lines.filter((l) => l.includes("DDIC says")), "exactly the one planted drift").to.have.lengthOf(1);
  });

  it("a clean fixture matches -- MANDT first key included", async () => {
    // MANDT's file block carries DATATYPE/LENG the way an export does, so
    // the diff compares the client field fully. That compare is where the
    // round-3 fix bit: the MANDT descriptor carried no leng, and
    // `one.leng.replace` died with a TypeError before any comparison -- on
    // the probe's main path, most real tables being client-dependent.
    const {code, lines} = await diffRun(CLEAN_XML);
    expect(code, "the clean fixture exits clean").to.equal(0);
    expect(lines.filter((l) => l.includes("DDIC says")), "no drift line besides").to.deep.equal([]);
    expect(lines.join("\n"), "the probe says matches").to.include("matches");
  });
});
