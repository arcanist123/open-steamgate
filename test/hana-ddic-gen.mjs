import {expect} from "chai";
import {createRequire} from "node:module";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {run, tablesFromValidation} from "../tools/hana-ddic-gen.mjs";
import {layers} from "../tools/osd-inputs.mjs";

// DDIC from the real DD03L for the build (tools/hana-ddic-gen.mjs, H3 A).
//
// Two seams are tested without a HANA. The transpile side is pure: the names
// the generation references but no input folder defines surface in the
// transpiler's own validation error, and extracting them is parsing that
// output, not ABAP. The database side is the probe's mapping behind a fake
// driver: the fixture tables are ZOSD_H3_*, and the XML written is the tree's
// own abapGit TABL shape, asserted piece by piece.
describe("hana-ddic-gen: DDIC from the real DD03L for the build", () => {
  it("reads the unresolved table names out of the transpile's own words", () => {
    // the two shapes a missing DDIC name surfaces in, verbatim from a thrown
    // transpiler validation (measured in .local/h3-exp1.mjs, 2026-11-11): a
    // check_syntax line naming the table of a SELECT, an unknown_types line
    // naming the type of a variable. Everything else in the same error --
    // here a made-up third issue -- names no table and is ignored.
    const message = [
      `check_syntax, Database table or view "zosd_h3_head" not found, zcl_h3_ref.clas.abap:8`,
      `unknown_types, Variable "LT_FLAT" contains unknown: ZOSD_H3_FLAT not found, lookup, zcl_h3_ref.clas.abap:9`,
      `check_syntax, Database table or view "scarr" not found, zcl_h3_ref.clas.abap:12`,
      `check_datasets, Open ABAP Cloud shapes only, zcl_h3_ref.clas.abap:3`,
    ].join("\n");
    expect(tablesFromValidation(message)).to.deep.equal(["SCARR", "ZOSD_H3_FLAT", "ZOSD_H3_HEAD"]);
  });

  it("an empty validation names nothing", () => {
    expect(tablesFromValidation("")).to.deep.equal([]);
  });

  it("a /-namespaced name is extracted with its namespace", () => {
    // critic SHOULD 4 at f0a248af1: the filter admitted `/`, the captures
    // refused it -- a dead branch. Both shapes of the validation line now
    // carry a /ZOSD/ namespace through.
    const message = [
      `check_syntax, Database table or view "/zosd/carrier" not found, zcl_h3_ref.clas.abap:8`,
      `unknown_types, Variable "LT_FLAT" contains unknown: /ZOSD/H3_FLAT not found, lookup, zcl_h3_ref.clas.abap:9`,
    ].join("\n");
    expect(tablesFromValidation(message)).to.deep.equal(["/ZOSD/CARRIER", "/ZOSD/H3_FLAT"]);
  });

  // the fake answers what the probe's reads ask, the way HANA answers: the
  // rows of the table the statement names, projected to the columns it
  // selected, filtered to the TABNAME the WHERE pinned. ZOSD_H3_* fixtures;
  // ZOSD_H3_HEAD carries MANDT as the first key, ZOSD_H3_FLAT is
  // client-independent.
  const ROWS = {
    DD02L: [
      {TABNAME: "ZOSD_H3_HEAD", TABCLASS: "TRANSP", CLIDEP: "X"},
      {TABNAME: "ZOSD_H3_FLAT", TABCLASS: "TRANSP", CLIDEP: ""},
    ],
    DD03L: [
      {TABNAME: "ZOSD_H3_HEAD", POSITION: "1", FIELDNAME: "MANDT", KEYFLAG: "X", ROLLNAME: "MANDT", DATATYPE: "CLNT", LENG: "3", DECIMALS: "0", INTTYPE: "C", INTLEN: "000006", NOTNULL: "X"},
      {TABNAME: "ZOSD_H3_HEAD", POSITION: "2", FIELDNAME: "ZOSD_H3_KEY", KEYFLAG: "X", ROLLNAME: "", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "000020", NOTNULL: "X"},
      {TABNAME: "ZOSD_H3_FLAT", POSITION: "1", FIELDNAME: "ZOSD_H3_NAME", KEYFLAG: "", ROLLNAME: "", DATATYPE: "CHAR", LENG: "30", DECIMALS: "0", INTTYPE: "C", INTLEN: "000060", NOTNULL: ""},
    ],
    DD04L: [],
    DD01L: [],
    DD02T: [
      {TABNAME: "ZOSD_H3_HEAD", DDTEXT: "gen fixture head"},
      {TABNAME: "ZOSD_H3_FLAT", DDTEXT: "gen fixture flat"},
    ],
  };
  const rowsFor = (sql) => {
    const table = /^\s*SELECT\s+.+?\s+FROM\s+"?[A-Za-z_][A-Za-z_0-9]*"?(\s|$)/i.exec(sql)?.[0] === undefined ? undefined
      : /FROM\s+"?([A-Za-z_][A-Za-z_0-9]*)"?/i.exec(sql)?.[1]?.toUpperCase();
    if (table === undefined || table === "DUMMY") return [];
    const pinned = /TABNAME\s*=\s*'([A-Z0-9_]+)'/.exec(sql)?.[1];
    return (ROWS[table] ?? []).filter((row) => pinned === undefined || row.TABNAME === pinned);
  };
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
    const require = createRequire(import.meta.url);
    const path = require.resolve("hdb");
    require.cache[path] = {
      id: path, filename: path, loaded: true,
      exports: {createClient: () => ({
        connect: (cb) => cb(undefined),
        setAutoCommit: () => undefined,
        exec: (sql, cb) => {
          sent.push(sql);
          if (/^\s*SELECT/i.test(sql) === false) return cb(undefined, 1); // SET SCHEMA
          cb(undefined, rowsFor(sql));
        },
        commit: (cb) => cb(undefined),
        rollback: (cb) => cb(undefined),
        end: () => undefined,
      })},
    };
    return sent;
  };

  it("--tables runs the probe's mapping and writes the tree's TABL XML", async () => {
    const sent = fakeHdb();
    const out = mkdtempSync(join(tmpdir(), "hana-ddic-gen-"));
    process.env.OSD_CLIENT = "001";
    let code;
    try {
      code = await run(["--tables", "ZOSD_H3_HEAD,ZOSD_H3_FLAT", "--out", out]);
    } finally {
      delete process.env.OSD_CLIENT;
    }
    try {
      expect(code, "the run is clean").to.equal(0);
      expect(existsSync(join(out, "zosd_h3_head.tabl.xml")), "the head table was written").to.equal(true);
      expect(existsSync(join(out, "zosd_h3_flat.tabl.xml")), "the flat table was written").to.equal(true);
      const head = readFileSync(join(out, "zosd_h3_head.tabl.xml"), "utf8");
      expect(head).to.include(`<TABNAME>ZOSD_H3_HEAD</TABNAME>`);
      expect(head).to.include(`<CLIDEP>X</CLIDEP>`);
      expect(head).to.include(`<DDTEXT>gen fixture head</DDTEXT>`);
      expect(head).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
      // MANDT in the shape this tree writes it everywhere, as the first key
      expect(head).to.match(/<FIELDNAME>MANDT<\/FIELDNAME>\s*<KEYFLAG>X<\/KEYFLAG>\s*<ROLLNAME>MANDT<\/ROLLNAME>/);
      expect(head).to.match(/<FIELDNAME>ZOSD_H3_KEY<\/FIELDNAME>[\s\S]*?<DATATYPE>CHAR<\/DATATYPE>[\s\S]*?<LENG>000010<\/LENG>/);
      const flat = readFileSync(join(out, "zosd_h3_flat.tabl.xml"), "utf8");
      expect(flat).to.include(`<TABNAME>ZOSD_H3_FLAT</TABNAME>`);
      expect(flat).to.not.include(`<CLIDEP>X</CLIDEP>`);
      expect(flat).to.include(`<FIELDNAME>ZOSD_H3_NAME</FIELDNAME>`);
      // the run read the DD* tables, never wrote: the mode is a reader
      expect(sent.some((s) => /^\s*(CREATE|DROP|INSERT|UPDATE|DELETE)/i.test(s)), "no write reached the driver").to.equal(false);
    } finally {
      rmSync(out, {recursive: true, force: true});
    }
  });

  // CRITIC-929 SHOULD 1: the live read hands TABCLASS/SQLTAB to the shared
  // writer, the dump path's equality -- --tables on an append or a view
  // used to write TABCLASS TRANSP with a DD09L, silently.
  it("--tables writes an APPEND and a VIEW with the TABCLASS the DD02L row carries", async () => {
    ROWS.DD02L.push(
      {TABNAME: "ZOSD_H3_APND", TABCLASS: "APPEND", CLIDEP: "", SQLTAB: "ZOSD_H3_HEAD"},
      {TABNAME: "ZOSD_H3_VIEW", TABCLASS: "VIEW", CLIDEP: ""});
    ROWS.DD03L.push(
      {TABNAME: "ZOSD_H3_APND", POSITION: "1", FIELDNAME: "ZOSD_H3_AP_F", KEYFLAG: "", ROLLNAME: "", DATATYPE: "CHAR", LENG: "4", DECIMALS: "0", INTTYPE: "C", INTLEN: "000008", NOTNULL: ""},
      {TABNAME: "ZOSD_H3_VIEW", POSITION: "1", FIELDNAME: "ZOSD_H3_V_KEY", KEYFLAG: "X", ROLLNAME: "", DATATYPE: "CHAR", LENG: "4", DECIMALS: "0", INTTYPE: "C", INTLEN: "000008", NOTNULL: ""},
      {TABNAME: "ZOSD_H3_VIEW", POSITION: "2", FIELDNAME: "ZOSD_H3_V_TXT", KEYFLAG: "", ROLLNAME: "", DATATYPE: "CHAR", LENG: "30", DECIMALS: "0", INTTYPE: "C", INTLEN: "000060", NOTNULL: ""});
    fakeHdb();
    const out = mkdtempSync(join(tmpdir(), "hana-ddic-gen-tab-"));
    process.env.OSD_CLIENT = "001";
    let code;
    try {
      code = await run(["--tables", "ZOSD_H3_APND,ZOSD_H3_VIEW", "--out", out]);
    } finally {
      delete process.env.OSD_CLIENT;
    }
    try {
      expect(code, "the run is clean").to.equal(0);
      const append = readFileSync(join(out, "zosd_h3_apnd.tabl.xml"), "utf8");
      expect(append).to.include(`<TABCLASS>APPEND</TABCLASS>`);
      expect(append).to.include(`<SQLTAB>ZOSD_H3_HEAD</SQLTAB>`);
      expect(append).to.not.include(`<DD09L>`);
      const view = readFileSync(join(out, "zosd_h3_view.tabl.xml"), "utf8");
      expect(view).to.include(`<TABCLASS>VIEW</TABCLASS>`);
      expect(view).to.not.include(`<DD09L>`);
      expect(view).to.not.include(`<CLIDEP>`);
    } finally {
      rmSync(out, {recursive: true, force: true});
    }
  });

  it("gen/hana-ddic is an input the hand-written src/ shadows, and the gen walk does not swallow it", () => {
    // the layering decision of H3 A, held as a test: gen/hana-ddic goes FIRST
    // in input_folder, so a hand-written src/**/<same>.tabl.xml -- a later
    // folder -- wins, and the real system's DDIC loses to an override only on
    // purpose. The plain "gen" walk must not pick the same files up a second
    // time: the owner would flip to gen and the build would hide both copies.
    const root = mkdtempSync(join(tmpdir(), "hana-ddic-layers-"));
    const write = (rel, body) => {
      mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), {recursive: true});
      writeFileSync(join(root, rel), body);
    };
    try {
      write("abap_transpile.json", JSON.stringify({input_folder: ["gen/hana-ddic", "src", "gen"]}));
      write("gen/hana-ddic/zosd_h3_a.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_A</TABNAME></abapGit>");
      write("src/zosd_h3_a.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_A</TABNAME><DDTEXT>hand-written wins</DDTEXT></abapGit>");
      write("gen/hana-ddic/zosd_h3_b.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_B</TABNAME></abapGit>");
      write("gen/zosd_h3_keep.tabl.xml", "<abapGit><TABNAME>ZOSD_H3_KEEP</TABNAME></abapGit>");
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const stack = layers(root, config);
      expect(stack.owner.get("TABL ZOSD_H3_A"), "the hand-written file wins").to.equal("src");
      expect(stack.hidden, "only the generated copy is hidden").to.deep.equal(["gen/hana-ddic/zosd_h3_a.tabl.xml"]);
      expect(stack.duplicates).to.deep.equal([]);
      expect(stack.total, "each object counted once: the gen walk skipped its nested input").to.equal(3);
      expect(stack.owner.get("TABL ZOSD_H3_B")).to.equal("gen/hana-ddic");
      expect(stack.owner.get("TABL ZOSD_H3_KEEP")).to.equal("gen");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

// ---------------------------------------------------------------- dump ----
// DDIC from the dump's DD* JSONL (tools/hana-ddic-gen.mjs --from-dump, H5a).
// The fixture is a dump directory the way `vsp hana dump --ddic` writes it:
// manifest.json, src/ and tables/*.jsonl -- one JSON object per line, the
// DD* table's full measured column set, the keys as HANA stores them. The
// key sets here are the real files' (measured on the H5 probe dump,
// 2026-11-12), reduced to the columns this tool reads; the objects are
// synthetic ZOSD_H5_*. No database and no HANA involved: the dump path is
// files in, XML out, the same mapper as the live read.
describe("hana-ddic-gen: DDIC from the dump's DD* tables", () => {
  const dumpFixture = ({omit = []} = {}) => {
    const root = mkdtempSync(join(tmpdir(), "hana-ddic-dump-"));
    mkdirSync(join(root, "tables"), {recursive: true});
    const table = (name, rows) => {
      if (omit.includes(name)) return;
      writeFileSync(join(root, "tables", `${name}.jsonl`),
        rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : ""));
    };
    table("DD02L", [
      {TABNAME: "ZOSD_H5_HEAD", TABCLASS: "TRANSP", CLIDEP: "X", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000", AS4DATE: "20260101", AS4USER: "SAP"},
      {TABNAME: "ZOSD_H5_STRUCT", TABCLASS: "INTTAB", CLIDEP: "", MASTERLANG: "D", AS4LOCAL: "A", AS4VERS: "0000", AS4DATE: "20260101", AS4USER: "SAP"},
      // an inactive version of the same table: the live read pins
      // AS4LOCAL 'A' and AS4VERS '0000', so the dump path drops it the same way
      {TABNAME: "ZOSD_H5_HEAD", TABCLASS: "TRANSP", CLIDEP: "X", AS4LOCAL: "I", AS4VERS: "0000"},
    ]);
    table("DD03L", [
      {TABNAME: "ZOSD_H5_HEAD", POSITION: "1", FIELDNAME: "MANDT", KEYFLAG: "X", ROLLNAME: "MANDT", COMPTYPE: "E", DATATYPE: "CLNT", LENG: "3", DECIMALS: "0", INTTYPE: "C", INTLEN: "000006", NOTNULL: "X", AS4LOCAL: "A", AS4VERS: "0000", SRS_ID: 0},
      {TABNAME: "ZOSD_H5_HEAD", POSITION: "2", FIELDNAME: "ZOSD_H5_KEY", KEYFLAG: "X", ROLLNAME: "", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "10", DECIMALS: "0", INTTYPE: "C", INTLEN: "", NOTNULL: "X", AS4LOCAL: "A", AS4VERS: "0000", SRS_ID: 0},
      // typed only through its data element, and through that element's domain
      {TABNAME: "ZOSD_H5_HEAD", POSITION: "3", FIELDNAME: "ZOSD_H5_ELEM", KEYFLAG: "", ROLLNAME: "ZOSD_H5_DTEL_CHAR", COMPTYPE: "E", DATATYPE: "", LENG: "", DECIMALS: "", INTTYPE: "", INTLEN: "", NOTNULL: "", AS4LOCAL: "A", AS4VERS: "0000", SRS_ID: 0},
      {TABNAME: "ZOSD_H5_HEAD", POSITION: "4", FIELDNAME: "ZOSD_H5_VIA_DOMA", KEYFLAG: "", ROLLNAME: "ZOSD_H5_DTEL_DOMA", COMPTYPE: "E", DATATYPE: "", LENG: "", DECIMALS: "", INTTYPE: "", INTLEN: "", NOTNULL: "", AS4LOCAL: "A", AS4VERS: "0000", SRS_ID: 0},
      // a structured component: DD03L carries DATATYPE STRU and no INTTYPE
      {TABNAME: "ZOSD_H5_HEAD", POSITION: "5", FIELDNAME: "ZOSD_H5_ADDR", KEYFLAG: "", ROLLNAME: "ZOSD_H5_STRUCT", COMPTYPE: "S", DATATYPE: "STRU", LENG: "000000", DECIMALS: "000000", INTTYPE: "", INTLEN: "000000", NOTNULL: "", AS4LOCAL: "A", AS4VERS: "0000", SRS_ID: 0},
      {TABNAME: "ZOSD_H5_STRUCT", POSITION: "1", FIELDNAME: "ZOSD_H5_NAME", KEYFLAG: "", ROLLNAME: "", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "30", DECIMALS: "0", INTTYPE: "C", INTLEN: "000060", NOTNULL: "", AS4LOCAL: "A", AS4VERS: "0000"},
      // an inactive field version: dropped like its table's
      {TABNAME: "ZOSD_H5_STRUCT", POSITION: "2", FIELDNAME: "ZOSD_H5_EXTRA", KEYFLAG: "", ROLLNAME: "", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "5", DECIMALS: "0", INTTYPE: "C", INTLEN: "000010", NOTNULL: "", AS4LOCAL: "I", AS4VERS: "0000"},
    ]);
    table("DD04L", [
      // the real dump's shape (measured 2026-11-12, 8 of 10 rows): a
      // domain-typed element is REFKIND D with DOMNAME and the domain's own
      // type copied onto the element row -- the copy must not reach the XML
      // (CRITIC-926 SHOULD 1)
      {ROLLNAME: "ZOSD_H5_DTEL_DOMA", DOMNAME: "ZOSD_H5_DOMA", DATATYPE: "CHAR", LENG: "000001", DECIMALS: "000000", OUTPUTLEN: "000001", HEADLEN: "12", SCRLEN1: "10", SCRLEN2: "12", SCRLEN3: "12", DTELMASTER: "E", REFKIND: "D", AS4LOCAL: "A", AS4VERS: "0000"},
      // the real other 2: REFKIND blank, the element's own DATATYPE
      {ROLLNAME: "ZOSD_H5_DTEL_CHAR", DATATYPE: "CHAR", LENG: "000010", DECIMALS: "000000", OUTPUTLEN: "000020", HEADLEN: "30", SCRLEN1: "10", SCRLEN2: "15", SCRLEN3: "20", DTELMASTER: "E", REFKIND: "", AS4LOCAL: "A", AS4VERS: "0000"},
      // like the real string element: zeros the writer must drop
      {ROLLNAME: "ZOSD_H5_DTEL_STRG", DATATYPE: "STRG", LENG: "000000", DECIMALS: "000000", OUTPUTLEN: "000000", HEADLEN: "11", SCRLEN1: "10", DTELMASTER: "E", REFKIND: "", AS4LOCAL: "A", AS4VERS: "0000"},
      {ROLLNAME: "ZOSD_H5_DTEL_OLD", DATATYPE: "CHAR", LENG: "000001", AS4LOCAL: "I", AS4VERS: "0000"},
    ]);
    table("DD01L", [
      {DOMNAME: "ZOSD_H5_DOMA", DATATYPE: "CHAR", LENG: "000001", DECIMALS: "000000", OUTPUTLEN: "000001", LOWERCASE: "X", VALEXI: "X", DOMMASTER: "E", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD07L", [
      {DOMNAME: "ZOSD_H5_DOMA", VALPOS: "0001", DOMVALUE_L: "N", DOMVALUE_H: "", AS4LOCAL: "A", AS4VERS: "0000"},
      {DOMNAME: "ZOSD_H5_DOMA", VALPOS: "0002", DOMVALUE_L: "O", DOMVALUE_H: "", AS4LOCAL: "A", AS4VERS: "0000"},
      {DOMNAME: "ZOSD_H5_DOMA", VALPOS: "0003", DOMVALUE_L: "C", DOMVALUE_H: "Z", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    // the texts, in two languages: the master language wins, not the first row
    table("DD02T", [
      {TABNAME: "ZOSD_H5_HEAD", DDTEXT: "h5 fixture head (de)", DDLANGUAGE: "D", AS4LOCAL: "A", AS4VERS: "0000"},
      {TABNAME: "ZOSD_H5_HEAD", DDTEXT: "h5 fixture head", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
      // the struct's text exists only in its master language (CRITIC-926
      // SHOULD 4: the TABL header's DDLANGUAGE follows it)
      {TABNAME: "ZOSD_H5_STRUCT", DDTEXT: "h5 fixture struct (de)", DDLANGUAGE: "D", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD04T", [
      {ROLLNAME: "ZOSD_H5_DTEL_CHAR", DDTEXT: "h5 fixture element (de)", DDLANGUAGE: "D", AS4LOCAL: "A", AS4VERS: "0000"},
      {ROLLNAME: "ZOSD_H5_DTEL_CHAR", DDTEXT: "h5 fixture element", REPTEXT: "Elem", SCRTEXT_S: "El", SCRTEXT_M: "Elem", SCRTEXT_L: "Element", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD01T", [
      {DOMNAME: "ZOSD_H5_DOMA", DDTEXT: "h5 fixture domain", DDLANGUAGE: "E", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    table("DD40L", [
      {TYPENAME: "ZOSD_H5_TTYPE", AS4LOCAL: "A", AS4VERS: "0000"},
    ]);
    return root;
  };

  it("writes the tables, structures, elements and domains of the dump", async () => {
    const dump = dumpFixture();
    const out = join(dump, "out");
    try {
      expect(await run(["--from-dump", dump, "--out", out])).to.equal(0);
      expect(readdirSync(out).sort()).to.deep.equal([
        "zosd_h5_doma.doma.xml", "zosd_h5_dtel_char.dtel.xml", "zosd_h5_dtel_doma.dtel.xml",
        "zosd_h5_dtel_strg.dtel.xml", "zosd_h5_head.tabl.xml", "zosd_h5_struct.tabl.xml"]);
      const head = readFileSync(join(out, "zosd_h5_head.tabl.xml"), "utf8");
      expect(head).to.include(`<TABNAME>ZOSD_H5_HEAD</TABNAME>`);
      expect(head).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
      expect(head).to.include(`<CLIDEP>X</CLIDEP>`);
      expect(head).to.include(`<DD09L>`);
      expect(head).to.include(`<DDTEXT>h5 fixture head</DDTEXT>`);
      // the client field, in the shape every table of this tree writes it
      expect(head).to.match(/<FIELDNAME>MANDT<\/FIELDNAME>\s*<KEYFLAG>X<\/KEYFLAG>\s*<ROLLNAME>MANDT<\/ROLLNAME>/);
      // the field typed only by its data element resolves CHAR 000010
      expect(head).to.match(/<FIELDNAME>ZOSD_H5_ELEM<\/FIELDNAME>[\s\S]*?<DATATYPE>CHAR<\/DATATYPE>[\s\S]*?<LENG>000010<\/LENG>/);
      // the element -> domain hop resolves CHAR 000001
      expect(head).to.match(/<FIELDNAME>ZOSD_H5_VIA_DOMA<\/FIELDNAME>[\s\S]*?<DATATYPE>CHAR<\/DATATYPE>[\s\S]*?<LENG>000001<\/LENG>/);
      // the structured component carries its own COMPTYPE
      expect(head).to.match(/<FIELDNAME>ZOSD_H5_ADDR<\/FIELDNAME>\s*<ROLLNAME>ZOSD_H5_STRUCT<\/ROLLNAME>\s*<COMPTYPE>S<\/COMPTYPE>/);
      const struct = readFileSync(join(out, "zosd_h5_struct.tabl.xml"), "utf8");
      expect(struct).to.include(`<TABCLASS>INTTAB</TABCLASS>`);
      expect(struct).to.not.include(`<DD09L>`);
      expect(struct).to.not.include(`<CLIDEP>X</CLIDEP>`);
      // the header's DDLANGUAGE is the master language the text was picked
      // in, not a hard-coded E (CRITIC-926 SHOULD 4)
      expect(struct).to.include(`<DDLANGUAGE>D</DDLANGUAGE>`);
      expect(struct).to.include(`<DDTEXT>h5 fixture struct (de)</DDTEXT>`);
      expect(struct).to.include(`<FIELDNAME>ZOSD_H5_NAME</FIELDNAME>`);
      expect(struct).to.not.include(`ZOSD_H5_EXTRA`);
      const dtel = readFileSync(join(out, "zosd_h5_dtel_char.dtel.xml"), "utf8");
      expect(dtel).to.include(`serializer="LCL_OBJECT_DTEL"`);
      expect(dtel).to.include(`<ROLLNAME>ZOSD_H5_DTEL_CHAR</ROLLNAME>`);
      // a predefined-typed element: the type block stands after DTELMASTER
      // (abapGit's DD04V order), DECIMALS 0 dropped (CRITIC-926 SHOULD 1)
      expect(dtel).to.match(/<DTELMASTER>E<\/DTELMASTER>\s*<DATATYPE>CHAR<\/DATATYPE>\s*<LENG>000010<\/LENG>\s*<OUTPUTLEN>000020<\/OUTPUTLEN>/);
      expect(dtel).to.not.include(`<DECIMALS>`);
      expect(dtel).to.include(`<DDTEXT>h5 fixture element</DDTEXT>`);
      expect(dtel).to.include(`<SCRTEXT_S>El</SCRTEXT_S>`);
      expect(dtel).to.include(`<DTELMASTER>E</DTELMASTER>`);
      expect(dtel).to.not.include(`h5 fixture element (de)`);
      // like the real dump's string element: LENG/DECIMALS/OUTPUTLEN all
      // zero, none of them written
      const strg = readFileSync(join(out, "zosd_h5_dtel_strg.dtel.xml"), "utf8");
      expect(strg).to.include(`<DATATYPE>STRG</DATATYPE>`);
      expect(strg).to.not.include(`<LENG>`);
      expect(strg).to.not.include(`<DECIMALS>`);
      expect(strg).to.not.include(`<OUTPUTLEN>`);
      // a domain-typed element (REFKIND D): DOMNAME right after the
      // language, none of the copied type tags (CRITIC-926 SHOULD 1)
      const viaDoma = readFileSync(join(out, "zosd_h5_dtel_doma.dtel.xml"), "utf8");
      expect(viaDoma).to.match(/<DDLANGUAGE>E<\/DDLANGUAGE>\s*<DOMNAME>ZOSD_H5_DOMA<\/DOMNAME>/);
      expect(viaDoma).to.not.include(`<DATATYPE>`);
      expect(viaDoma).to.not.include(`<LENG>`);
      expect(viaDoma).to.not.include(`<DECIMALS>`);
      expect(viaDoma).to.not.include(`<OUTPUTLEN>`);
      expect(viaDoma).to.include(`<REFKIND>D</REFKIND>`);
      const doma = readFileSync(join(out, "zosd_h5_doma.doma.xml"), "utf8");
      expect(doma).to.include(`serializer="LCL_OBJECT_DOMA"`);
      expect(doma).to.include(`<DOMNAME>ZOSD_H5_DOMA</DOMNAME>`);
      expect(doma).to.include(`<LOWERCASE>X</LOWERCASE>`);
      expect(doma).to.include(`<VALEXI>X</VALEXI>`);
      expect(doma).to.include(`<DDTEXT>h5 fixture domain</DDTEXT>`);
      expect(doma).to.match(/<VALPOS>0001<\/VALPOS>[\s\S]*?<DOMVALUE_L>N<\/DOMVALUE_L>/);
      expect(doma).to.match(/<VALPOS>0003<\/VALPOS>[\s\S]*?<DOMVALUE_L>C<\/DOMVALUE_L>[\s\S]*?<DOMVALUE_H>Z<\/DOMVALUE_H>/);
      expect(existsSync(join(out, "zosd_h5_ttype.ttyp.xml")), "DD40L is not covered").to.equal(false);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("reports what it wrote and the kinds the dump does not cover", async () => {
    const dump = dumpFixture();
    const out = join(dump, "out");
    const lines = [];
    const log = console.log;
    console.log = (line) => lines.push(String(line));
    let code;
    try {
      code = await run(["--from-dump", dump, "--out", out]);
    } finally {
      console.log = log;
      rmSync(dump, {recursive: true, force: true});
    }
    expect(code).to.equal(0);
    const said = lines.join("\n");
    expect(said).to.match(/2 table\(s\), 3 data element\(s\), 1 domain\(s\)/);
    expect(said).to.match(/not covered/);
    expect(said).to.match(/SHLP/);
    expect(said).to.match(/MSAG/);
    expect(said).to.match(/1 table type\(s\)/);
  });

  it("--check matches its own output and refuses drift", async () => {
    const dump = dumpFixture();
    const out = join(dump, "out");
    try {
      expect(await run(["--from-dump", dump, "--out", out])).to.equal(0);
      expect(await run(["--from-dump", dump, "--out", out, "--check"])).to.equal(0);
      // a file edited in place drifts
      writeFileSync(join(out, "zosd_h5_head.tabl.xml"),
        readFileSync(join(out, "zosd_h5_head.tabl.xml"), "utf8").replace("h5 fixture head", "hand-edited"));
      expect(await run(["--from-dump", dump, "--out", out, "--check"])).to.equal(1);
      // a missing file drifts
      rmSync(join(out, "zosd_h5_dtel_char.dtel.xml"));
      expect(await run(["--from-dump", dump, "--out", out, "--check"])).to.equal(1);
      // a file the plan does not write drifts
      writeFileSync(join(out, "zosd_h5_stray.tabl.xml"), "<abapGit/>");
      expect(await run(["--from-dump", dump, "--out", out, "--check"])).to.equal(1);
      // no out at all says so instead of comparing nothing
      expect(await run(["--from-dump", dump, "--out", join(dump, "never"), "--check"])).to.equal(1);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("--names writes exactly the named objects of the dump", async () => {
    // the loop's per-name fill (H5c round 7): a DDIC name the dumps RESOLVED
    // but the converter's TADIR selection did not write is written by
    // --from-dump --names for exactly that name
    const dump = dumpFixture();
    try {
      const out = join(dump, "out");
      expect(await run(["--from-dump", dump, "--out", out, "--names", "ZOSD_H5_HEAD,zosd_h5_doma"])).to.equal(0);
      expect(readdirSync(out).sort()).to.deep.equal(["zosd_h5_doma.doma.xml", "zosd_h5_head.tabl.xml"]);
      // a name the dump's rows do not carry writes nothing and still exits 0:
      // the fill tries the dumps newest-first and stops when nothing is left
      const out2 = join(dump, "out2");
      expect(await run(["--from-dump", dump, "--out", out2, "--names", "ZOSD_H5_ABSENT"])).to.equal(0);
      expect(readdirSync(out2).sort()).to.deep.equal([]);
      // the selection is refused where it makes no sense
      const refuse = async (promise, pattern) => {
        let error;
        try {
          await promise;
        } catch (thrown) {
          error = thrown;
        }
        expect(error?.message ?? "(no refusal)", `expected a refusal matching ${pattern}`).to.match(pattern);
      };
      await refuse(run(["--from-dump", dump, "--out", join(dump, "out3"), "--names", "ZOSD_H5_HEAD", "--check"]), /--check/);
      await refuse(run(["--names", "ZOSD_H5_HEAD", "--out", join(dump, "out4")]), /--names/);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("a DD* file the dump does not carry is no rows, not an error", async () => {
    const dump = dumpFixture({omit: ["DD07L", "DD40L", "DD01T"]});
    const out = join(dump, "out");
    try {
      expect(await run(["--from-dump", dump, "--out", out])).to.equal(0);
      const doma = readFileSync(join(out, "zosd_h5_doma.doma.xml"), "utf8");
      expect(doma).to.include(`<DD01V>`);
      expect(doma).to.not.include(`<DD07V`);
      expect(doma).to.not.include(`<DDTEXT>`);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  it("refuses a mixed invocation, and a folder that is not a dump", async () => {
    const refuse = async (promise, pattern) => {
      let error;
      try {
        await promise;
      } catch (thrown) {
        error = thrown;
      }
      expect(error?.message ?? "(no refusal)", `expected a refusal matching ${pattern}`).to.match(pattern);
    };
    const dump = dumpFixture({omit: ["DD02L"]});
    try {
      await refuse(run(["--from-dump", dump, "--tables", "ZOSD_H5_HEAD"]), /choose --from-dump/);
      await refuse(run(["--from-build", "--check"]), /--check/);
      await refuse(run(["--from-dump", dump, "--out", join(dump, "out")]), /tables\/DD02L\.jsonl/);
      await refuse(run(["--from-dump", dump, "--nonsense"]), /unknown option/);
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  // CRITIC-926 SHOULD 3, after H5d: a POOL row in the dump's DD02L is not
  // a table this path writes; the run refuses and names it instead of
  // writing a type that holds no rows. APPEND and VIEW are written since
  // H5d (test/hana-ddic-append-view.mjs has the shapes).
  it("refuses a DD02L TABCLASS the dump path does not write, by name", async () => {
    const dump = dumpFixture();
    writeFileSync(join(dump, "tables", "DD02L.jsonl"),
      readFileSync(join(dump, "tables", "DD02L.jsonl"), "utf8") +
      JSON.stringify({TABNAME: "ZOSD_H5_POOLX", TABCLASS: "POOL", CLIDEP: "", MASTERLANG: "", AS4LOCAL: "A", AS4VERS: "0000"}) + "\n");
    let error;
    try {
      await run(["--from-dump", dump, "--out", join(dump, "out")]);
    } catch (thrown) {
      error = thrown;
    }
    try {
      expect(error?.message ?? "(no refusal)").to.include("ZOSD_H5_POOLX");
      expect(error?.message ?? "(no refusal)").to.include("POOL");
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });

  // CRITIC-929 MUST 1 (b): a raw duplicate -- two of a table's own DD03L
  // rows carrying the same FIELDNAME -- is refused at generation, naming
  // table and field, where it used to be written twice and die in
  // cds2ddic later.
  it("refuses a TABL whose field list repeats a FIELDNAME, naming table and field", async () => {
    const dump = dumpFixture();
    writeFileSync(join(dump, "tables", "DD03L.jsonl"),
      readFileSync(join(dump, "tables", "DD03L.jsonl"), "utf8") +
      JSON.stringify({TABNAME: "ZOSD_H5_STRUCT", POSITION: "3", FIELDNAME: "ZOSD_H5_NAME", KEYFLAG: "", ROLLNAME: "", COMPTYPE: "E", DATATYPE: "CHAR", LENG: "30", DECIMALS: "0", INTTYPE: "C", INTLEN: "000060", NOTNULL: "", ADMINFIELD: "0", AS4LOCAL: "A", AS4VERS: "0000"}) + "\n");
    let error;
    try {
      await run(["--from-dump", dump, "--out", join(dump, "out")]);
    } catch (thrown) {
      error = thrown;
    }
    try {
      expect(error?.message ?? "(no refusal)", "the table").to.include("ZOSD_H5_STRUCT");
      expect(error?.message ?? "(no refusal)", "the field").to.include("ZOSD_H5_NAME");
    } finally {
      rmSync(dump, {recursive: true, force: true});
    }
  });
});
