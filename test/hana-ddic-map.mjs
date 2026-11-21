import {expect} from "chai";
import {ddicFields, ddicFieldsWithIncludes, domaXml, dtelXml, mandtFirstKey, tablXml} from "../tools/hana-ddic-map.mjs";

// The DD03L -> our *.tabl.xml shape mapping (tools/hana-ddic-map.mjs), as a
// pure function: fixture rows with made-up names, no database.
//
// The rows are shaped exactly as a HANA read hands them to query(): keys in
// lower case (the client folds them on the way out), LENG/DECIMALS/POSITION
// as the dictionary holds them. The names are invented for this test; a real
// system's table names must never appear here (the leak list exists for a
// reason).
describe("the DD03L to abapGit TABL mapping", () => {
  // one table carrying every type this slice maps, a key with MANDT first,
  // and one field typed only through its data element and one through that
  // element's domain, so the DD04L and DD01L hops are exercised too.
  const dd03l = [
    {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", notnull: "X"},
    {position: "2", fieldname: "ZOSD_H1_KEY", keyflag: "X", rollname: "", datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", notnull: "X"},
    {position: "3", fieldname: "ZOSD_H1_CODE", keyflag: "", rollname: "", datatype: "NUMC", leng: "4", decimals: "0", inttype: "N", notnull: ""},
    {position: "4", fieldname: "ZOSD_H1_DATE", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", notnull: ""},
    {position: "5", fieldname: "ZOSD_H1_TIME", keyflag: "", rollname: "", datatype: "TIMS", leng: "6", decimals: "0", inttype: "T", notnull: ""},
    {position: "6", fieldname: "ZOSD_H1_AMT", keyflag: "", rollname: "", datatype: "DEC", leng: "15", decimals: "2", inttype: "P", notnull: ""},
    {position: "7", fieldname: "ZOSD_H1_COUNT", keyflag: "", rollname: "", datatype: "INT4", leng: "10", decimals: "0", inttype: "I", notnull: ""},
    {position: "8", fieldname: "ZOSD_H1_HASH", keyflag: "", rollname: "", datatype: "RAW", leng: "4", decimals: "0", inttype: "X", notnull: ""},
    {position: "9", fieldname: "ZOSD_H1_MEMO", keyflag: "", rollname: "", datatype: "STRG", leng: "0", decimals: "0", inttype: "g", notnull: ""},
    {position: "10", fieldname: "ZOSD_H1_ELEM", keyflag: "", rollname: "ZOSD_H1_DTEL_CHAR", datatype: "", leng: "", decimals: "", inttype: "", notnull: ""},
    {position: "11", fieldname: "ZOSD_H1_VIA_DOMA", keyflag: "", rollname: "ZOSD_H1_DTEL_DOMA", datatype: "", leng: "", decimals: "", inttype: "", notnull: ""},
  ];
  // DD04L and DD01L rows, shaped as the measured column lists read them:
  // DATATYPE, LENG, DECIMALS (and DD04L's DOMNAME). No INTTYPE anywhere --
  // that column lives on DD03L only, which is what the probe's first run
  // against a real system taught (test/hana-ddic-probe.mjs pins the lists)
  const elements = new Map([
    ["ZOSD_H1_DTEL_CHAR", {datatype: "CHAR", leng: "3", decimals: "0"}],
    // a data element usually has no type of its own: it names a domain, and
    // the domain carries the type (the same hop tools/adt-documents.mjs makes)
    ["ZOSD_H1_DTEL_DOMA", {datatype: "", leng: "", decimals: "", domname: "ZOSD_H1_DOMA_DEC"}],
  ]);
  const domains = new Map([
    ["ZOSD_H1_DOMA_DEC", {datatype: "DEC", leng: "9", decimals: "2"}],
  ]);

  it("maps every field, in POSITION order", () => {
    const fields = ddicFields(dd03l, {elements, domains});
    expect(fields.map((f) => f.fieldname)).to.deep.equal([
      "MANDT", "ZOSD_H1_KEY", "ZOSD_H1_CODE", "ZOSD_H1_DATE", "ZOSD_H1_TIME",
      "ZOSD_H1_AMT", "ZOSD_H1_COUNT", "ZOSD_H1_HASH", "ZOSD_H1_MEMO",
      "ZOSD_H1_ELEM", "ZOSD_H1_VIA_DOMA",
    ]);
  });

  it("keeps the key flags: MANDT first, one CHAR key beside it, the rest open", () => {
    const fields = ddicFields(dd03l, {elements, domains});
    expect(fields[0].key).to.equal(true);
    expect(fields[1].key).to.equal(true);
    expect(fields[1].notnull).to.equal(true);
    expect(fields[2].key, "a non-key field stays non-key").to.equal(false);
    expect(fields[2].notnull).to.equal(false);
  });

  it("maps the built-in types, INTLEN included", () => {
    const byName = new Map(ddicFields(dd03l, {elements, domains}).map((f) => [f.fieldname, f]));
    // CHAR/NUMC are two bytes a character in the dictionary's internal length
    expect(byName.get("ZOSD_H1_KEY")).to.include({datatype: "CHAR", leng: "000010", intlen: "000020", inttype: "C"});
    expect(byName.get("ZOSD_H1_CODE")).to.include({datatype: "NUMC", leng: "000004", intlen: "000008", inttype: "N"});
    // DATS 16 and TIMS 12, as every tabl.xml of this tree spells them
    expect(byName.get("ZOSD_H1_DATE")).to.include({datatype: "DATS", leng: "000008", intlen: "000016"});
    expect(byName.get("ZOSD_H1_TIME")).to.include({datatype: "TIMS", leng: "000006", intlen: "000012"});
    // packed: (digits + 1) / 2 rounded up, decimals kept
    expect(byName.get("ZOSD_H1_AMT")).to.include({datatype: "DEC", leng: "000015", intlen: "000008", decimals: "000002"});
    expect(byName.get("ZOSD_H1_COUNT")).to.include({datatype: "INT4", leng: "000010", intlen: "000004"});
    // raw: the length is the byte count
    expect(byName.get("ZOSD_H1_HASH")).to.include({datatype: "RAW", leng: "000004", intlen: "000004"});
    // a string has no length: zero, and an 8-byte reference
    expect(byName.get("ZOSD_H1_MEMO")).to.include({datatype: "STRG", leng: "000000", intlen: "000008", inttype: "g"});
    // where each half came from: these rows carry DD03L's own INTTYPE and
    // leave its INTLEN blank, so only the INTLEN was derived
    expect(byName.get("ZOSD_H1_CODE").inttypeFrom).to.equal("dd03l");
    expect(byName.get("ZOSD_H1_CODE").intlenFrom).to.equal("derived");
  });

  it("resolves a field typed only by its data element, and through the domain", () => {
    const byName = new Map(ddicFields(dd03l, {elements, domains}).map((f) => [f.fieldname, f]));
    expect(byName.get("ZOSD_H1_ELEM")).to.include({datatype: "CHAR", leng: "000003", intlen: "000006", rollname: "ZOSD_H1_DTEL_CHAR"});
    expect(byName.get("ZOSD_H1_VIA_DOMA")).to.include({datatype: "DEC", leng: "000009", intlen: "000005", decimals: "000002", rollname: "ZOSD_H1_DTEL_DOMA"});
  });

  it("prefers DD03L's own INTTYPE and INTLEN; derives only what it leaves blank", () => {
    const byName = new Map(ddicFields([
      // CHAR leng 10 would derive C and 000020; DD03L's own pair is what the
      // system says, and it wins
      {position: "1", fieldname: "ZOSD_H1_OWN", keyflag: "", rollname: "", datatype: "CHAR", leng: "10", decimals: "0", inttype: "N", intlen: "000008", notnull: ""},
      // the pair blank: derived from the DATATYPE and the type rules, and
      // said to be derived
      {position: "2", fieldname: "ZOSD_H1_BLANK", keyflag: "", rollname: "", datatype: "DEC", leng: "9", decimals: "2", inttype: "", intlen: "", notnull: ""},
    ]).map((f) => [f.fieldname, f]));
    expect(byName.get("ZOSD_H1_OWN")).to.include({inttype: "N", intlen: "000008", inttypeFrom: "dd03l", intlenFrom: "dd03l"});
    expect(byName.get("ZOSD_H1_BLANK")).to.include({inttype: "P", intlen: "000005", inttypeFrom: "derived", intlenFrom: "derived"});
  });

  it("refuses a field whose type resolves to nothing, by name", () => {
    const orphan = [{position: "1", fieldname: "ZOSD_H1_ORPHAN", keyflag: "", rollname: "ZOSD_H1_NO_DTEL", datatype: "", leng: "", decimals: "", inttype: "", notnull: ""}];
    let error;
    try { ddicFields(orphan, {elements, domains}); } catch (e) { error = e; }
    expect(error?.message).to.include("ZOSD_H1_ORPHAN");
    expect(error?.message).to.include("ZOSD_H1_NO_DTEL");
  });

  it("carries a CURR/QUAN field's reference as DD03L says it: REFTABLE, PRECFIELD, REFFIELD", () => {
    // a currency amount points at the CUKY field its currency is read from,
    // a quantity at the UNIT field; DD03L carries the reference as REFTABLE
    // plus REFFIELD, and PRECFIELD beside it as DD03L's own position marker.
    // Without them the emitted XML is a packed field with no reference: it
    // does not round-trip against what a system's own abapGit export writes,
    // and --diff cannot see reference drift on the most common SAP field
    // kinds (the critic round's SHOULD 3). The rows are keyed as query()
    // hands them over -- column names folded to lower case, so DD03L's
    // PRECFIELD arrives as `precfield`. Round 2's fixtures spelled the key
    // `preffield`, the same misspelling the map read, and passed without a
    // value ever moving.
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", notnull: "X"},
      {position: "2", fieldname: "ZOSD_H1_AMT", keyflag: "", rollname: "", datatype: "CURR", leng: "13", decimals: "2", inttype: "P", intlen: "000007", notnull: "", reftable: "ZOSD_H1_REF", reffield: "ZOSD_H1_WAERS"},
      {position: "3", fieldname: "ZOSD_H1_WAERS", keyflag: "", rollname: "", datatype: "CUKY", leng: "5", decimals: "0", inttype: "C", notnull: ""},
      {position: "4", fieldname: "ZOSD_H1_QTY", keyflag: "", rollname: "", datatype: "QUAN", leng: "13", decimals: "3", inttype: "P", intlen: "000007", notnull: "", reftable: "ZOSD_H1_REF", precfield: "ZOSD_H1_AMT", reffield: "ZOSD_H1_UNIT"},
      {position: "5", fieldname: "ZOSD_H1_UNIT", keyflag: "", rollname: "", datatype: "UNIT", leng: "3", decimals: "0", inttype: "C", notnull: ""},
    ];
    const byName = new Map(ddicFields(rows).map((f) => [f.fieldname, f]));
    expect(byName.get("ZOSD_H1_AMT")).to.include({datatype: "CURR", intlen: "000007", reftable: "ZOSD_H1_REF", reffield: "ZOSD_H1_WAERS"});
    expect(byName.get("ZOSD_H1_QTY")).to.include({datatype: "QUAN", reftable: "ZOSD_H1_REF", precfield: "ZOSD_H1_AMT", reffield: "ZOSD_H1_UNIT"});
    // what the row leaves blank stays absent: an empty tag would drift from
    // what a system's own export writes
    expect(byName.get("ZOSD_H1_WAERS")).to.not.have.property("reffield");
    expect(byName.get("ZOSD_H1_WAERS")).to.not.have.property("precfield");
    // the XML, in DD03P's own component order: INTLEN, then the reference,
    // then NOTNULL
    const xml = tablXml({name: "ZOSD_H1_REF", text: "reference fixture table", fields: ddicFields(rows)});
    expect(xml).to.match(/<FIELDNAME>ZOSD_H1_AMT<\/FIELDNAME>[\s\S]*?<INTLEN>000007<\/INTLEN>\s*<REFTABLE>ZOSD_H1_REF<\/REFTABLE>\s*<REFFIELD>ZOSD_H1_WAERS<\/REFFIELD>/);
    expect(xml).to.match(/<FIELDNAME>ZOSD_H1_QTY<\/FIELDNAME>[\s\S]*?<REFTABLE>ZOSD_H1_REF<\/REFTABLE>\s*<PRECFIELD>ZOSD_H1_AMT<\/PRECFIELD>\s*<REFFIELD>ZOSD_H1_UNIT<\/REFFIELD>/);
  });

  it("names an .INCLUDE row's structure in the refusal, from DD03L's PRECFIELD", () => {
    // ddicFields reads PRECFIELD for the include's name -- the same column
    // the mapping carries for ordinary rows, and the one
    // tools/dsl-ddic.mjs reads for key includes. The row is keyed as the
    // client delivers it: until fix round 3 the map read `row.preffield`,
    // an ff spelling that matches neither the column nor what query()
    // hands over, and the refusal said "(no name)" against a real DD03L.
    const rows = [{position: "1", fieldname: ".INCLUDE", precfield: "ZOSD_H1_SUB"}];
    let error;
    try { ddicFields(rows); } catch (e) { error = e; }
    expect(error?.message).to.include("ZOSD_H1_SUB");
  });

  it("says which tables have MANDT as the first key field", () => {
    expect(mandtFirstKey(ddicFields(dd03l, {elements, domains}))).to.equal(true);
    const noClient = ddicFields([
      {position: "1", fieldname: "ZOSD_H1_PLAIN_KEY", keyflag: "X", rollname: "", datatype: "CHAR", leng: "4", decimals: "0", inttype: "C", notnull: "X"},
      {position: "2", fieldname: "ZOSD_H1_MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", notnull: "X"},
    ], {elements, domains});
    // MANDT as a key is not MANDT as the FIRST key field
    expect(mandtFirstKey(noClient)).to.equal(false);
  });

  it("emits the abapGit TABL XML of this tree", () => {
    const xml = tablXml({name: "ZOSD_H1_HEAD", text: "H1 probe fixture table", clidep: true,
      fields: ddicFields(dd03l, {elements, domains})});
    expect(xml).to.include(`<?xml version="1.0" encoding="utf-8"?>`);
    expect(xml).to.include(`<TABNAME>ZOSD_H1_HEAD</TABNAME>`);
    expect(xml).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
    expect(xml).to.include(`<CLIDEP>X</CLIDEP>`);
    expect(xml).to.include(`<DDTEXT>H1 probe fixture table</DDTEXT>`);
    expect(xml).to.include(`<DD09L>`);
    // the client field, in the shape every table of this tree writes it
    expect(xml).to.include(`<FIELDNAME>MANDT</FIELDNAME>
     <KEYFLAG>X</KEYFLAG>
     <ROLLNAME>MANDT</ROLLNAME>
     <ADMINFIELD>0</ADMINFIELD>
     <NOTNULL>X</NOTNULL>
     <COMPTYPE>E</COMPTYPE>`);
    // the decimal field, resolved and spelled out to the end
    expect(xml).to.match(/<FIELDNAME>ZOSD_H1_AMT<\/FIELDNAME>[\s\S]*?<DATATYPE>DEC<\/DATATYPE>[\s\S]*?<LENG>000015<\/LENG>[\s\S]*?<DECIMALS>000002<\/DECIMALS>/);
    // a non-key field carries neither KEYFLAG nor NOTNULL
    expect(xml).to.not.match(/<FIELDNAME>ZOSD_H1_CODE<\/FIELDNAME>\s*<KEYFLAG/);
    expect(xml).to.include(`<MASK>  DEC</MASK>`);
  });

  // the dump path (H5d): a dump carries every DD02L table's DD03L, so an
  // .INCLUDE row goes out as the marker a system's own export spells --
  // the transpiler expands it off PRECFIELD -- and the included fields'
  // expanded copies the dump also carries under the base table's own name
  // are dropped by the dictionary's own mark: every expanded copy carries
  // ADMINFIELD '1', every plain row '0' (measured on the real closure
  // dump: 16 copies against 265 plain rows, the 7 markers '0' as well,
  // the first copy one position after its marker). The rule is the mark's
  // value space, abapGit's `adminfield <> '0'` -- the '1' is what the
  // dumps measure, not the rule.
  it("keeps an .INCLUDE row as the marker and drops the ADMINFIELD-'1' copies (H5d)", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X", adminfield: "0"},
      {position: "3", fieldname: ".INCLUDE", precfield: "ZOSD_H1_STAMP", adminfield: "0"},
      // the dump's expanded copy of the include's field, one position on,
      // carrying the dictionary's mark
      {position: "4", fieldname: "ZOSD_H1_STAMP_A", keyflag: "", rollname: "", datatype: "TIMS", leng: "6", decimals: "0", inttype: "T", intlen: "000012", notnull: "", adminfield: "1"},
      {position: "5", fieldname: "ZOSD_H1_TAIL", keyflag: "", rollname: "", datatype: "CHAR", leng: "2", decimals: "0", inttype: "C", intlen: "000004", notnull: "", adminfield: "0"},
    ];
    const includes = new Map([["ZOSD_H1_STAMP", [
      // the include's own positions decide inside it, here 2 then 1
      {position: "2", fieldname: "ZOSD_H1_STAMP_A", keyflag: "", rollname: "", datatype: "TIMS", leng: "6", decimals: "0", inttype: "T", intlen: "000012", notnull: ""},
      {position: "1", fieldname: "ZOSD_H1_STAMP_D", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", intlen: "000016", notnull: ""},
    ]]]);
    const fields = ddicFieldsWithIncludes(rows, {}, includes);
    expect(fields.map((f) => f.fieldname)).to.deep.equal(["MANDT", ".INCLUDE", "ZOSD_H1_TAIL"]);
    expect(fields[1]).to.deep.equal({fieldname: ".INCLUDE", key: false, marker: true, precfield: "ZOSD_H1_STAMP"});
  });

  it("an include whose DD03L is not in the dump is refused by name, and a cycle too", () => {
    const row = {position: "1", fieldname: ".INCLUDE", precfield: "ZOSD_H1_ABSENT"};
    let error;
    try { ddicFieldsWithIncludes([row], {}, new Map()); } catch (e) { error = e; }
    expect(error?.message).to.include(".INCLUDE");
    expect(error?.message).to.include("ZOSD_H1_ABSENT");
    const cycle = new Map([["ZOSD_H1_A", [{position: "1", fieldname: ".INCLUDE", precfield: "ZOSD_H1_B"}]],
      ["ZOSD_H1_B", [{position: "1", fieldname: ".INCLUDE", precfield: "ZOSD_H1_A"}]]]);
    error = undefined;
    try {
      ddicFieldsWithIncludes(cycle.get("ZOSD_H1_A"), {}, cycle);
    } catch (e) { error = e; }
    expect(error?.message).to.match(/cycle/);
  });

  // CRITIC-926 SHOULD 5: every .INCLU- form names its structure in
  // PRECFIELD -- abaplint reads it there for every form (table.js) and
  // applies the suffix rename itself, so the marker passes through as the
  // dictionary spells it; an append goes out as .INCLU--AP (the
  // dictionary's spelling, the transpiler's no-rename form) whatever the
  // row called itself.
  it("keeps .INCLU-01 and .INCLU--AP markers as spelled, .APPEND spelled as the dictionary spells an append", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X"},
      {position: "2", fieldname: ".INCLU-01", precfield: "ZOSD_H1_STAMP"},
      // the suffix rename the transpiler applies: a copy of a suffixed
      // marker sits under the suffixed name, so the fallback's name set
      // has to know it (these rows carry no ADMINFIELD column -- the name
      // rule is what keeps the copies out when the mark is absent)
      {position: "3", fieldname: "ZOSD_H1_STAMP_A01", keyflag: "", rollname: "", datatype: "TIMS", leng: "6", decimals: "0", inttype: "T", intlen: "000012", notnull: ""},
      {position: "4", fieldname: ".APPEND", precfield: "ZOSD_H1_APPEND"},
      {position: "5", fieldname: ".INCLU--AP", precfield: "ZOSD_H1_DEEP"},
      // the append form renames nothing: the copy keeps the plain name
      {position: "6", fieldname: "ZOSD_H1_DEEP_D", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", intlen: "000016", notnull: ""},
      {position: "7", fieldname: "ZOSD_H1_TAIL", keyflag: "", rollname: "", datatype: "CHAR", leng: "2", decimals: "0", inttype: "C", intlen: "000004", notnull: ""},
    ];
    const includes = new Map([
      ["ZOSD_H1_STAMP", [
        {position: "1", fieldname: "ZOSD_H1_STAMP_A", keyflag: "", rollname: "", datatype: "TIMS", leng: "6", decimals: "0", inttype: "T", intlen: "000012", notnull: ""},
      ]],
      ["ZOSD_H1_APPEND", [
        {position: "1", fieldname: "ZOSD_H1_AP_F1", keyflag: "", rollname: "", datatype: "CHAR", leng: "4", decimals: "0", inttype: "C", intlen: "000008", notnull: ""},
      ]],
      ["ZOSD_H1_DEEP", [
        {position: "1", fieldname: "ZOSD_H1_DEEP_D", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", intlen: "000016", notnull: ""},
      ]],
    ]);
    const fields = ddicFieldsWithIncludes(rows, {}, includes);
    expect(fields.map((f) => f.fieldname)).to.deep.equal(["MANDT", ".INCLU-01", ".INCLU--AP", ".INCLU--AP", "ZOSD_H1_TAIL"]);
    // the suffix rename is the transpiler's, off the marker it reads; each
    // marker keeps the structure it names
    expect(fields.filter((f) => f.marker === true).map((f) => f.precfield))
      .to.deep.equal(["ZOSD_H1_STAMP", "ZOSD_H1_APPEND", "ZOSD_H1_DEEP"]);
  });

  it("refuses a dot row by its marker when PRECFIELD is blank, and names both otherwise", () => {
    let error;
    try { ddicFieldsWithIncludes([{position: "1", fieldname: ".INCLU-02"}], {}, new Map()); } catch (e) { error = e; }
    expect(error?.message).to.include(".INCLU-02");
    error = undefined;
    try { ddicFieldsWithIncludes([{position: "1", fieldname: ".INCLU-05", precfield: "ZOSD_H1_ABSENT"}], {}, new Map()); } catch (e) { error = e; }
    expect(error?.message).to.include(".INCLU-05");
    expect(error?.message).to.include("ZOSD_H1_ABSENT");
  });

  // CRITIC-929 MUST 1, the shape the bare name rule missed: a .INCLU-01
  // marker and the dump's expansion rows under the suffixed names, carrying
  // ADMINFIELD '1' as the real dump's 16 copies all do. The mark decides,
  // not the name -- and the kept marker makes the transpiler's own suffix
  // rename produce the A01/B01 names by itself.
  it("drops a .INCLU-01 marker's ADMINFIELD-'1' copies whatever they are named (H5d)", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X", adminfield: "0"},
      {position: "2", fieldname: "ZOSD_H1_SFX_KEY", keyflag: "X", rollname: "", datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X", adminfield: "0"},
      {position: "3", fieldname: ".INCLU-01", precfield: "ZOSD_H1_SFX_INC", adminfield: "0"},
      // the dump's expansion rows: suffixed names, the dictionary's mark
      {position: "4", fieldname: "ZOSD_H1_SFX_A01", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: "", adminfield: "1"},
      {position: "5", fieldname: "ZOSD_H1_SFX_B01", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", intlen: "000016", notnull: "", adminfield: "1"},
      {position: "6", fieldname: "ZOSD_H1_SFX_TAIL", keyflag: "", rollname: "", datatype: "CHAR", leng: "2", decimals: "0", inttype: "C", intlen: "000004", notnull: "", adminfield: "0"},
    ];
    const includes = new Map([["ZOSD_H1_SFX_INC", [
      {position: "1", fieldname: "ZOSD_H1_SFX_A", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: ""},
      {position: "2", fieldname: "ZOSD_H1_SFX_B", keyflag: "", rollname: "", datatype: "DATS", leng: "8", decimals: "0", inttype: "D", intlen: "000016", notnull: ""},
    ]]]);
    const fields = ddicFieldsWithIncludes(rows, {}, includes);
    expect(fields.map((f) => f.fieldname)).to.deep.equal(["MANDT", "ZOSD_H1_SFX_KEY", ".INCLU-01", "ZOSD_H1_SFX_TAIL"]);
    // what the XML makes of it: the marker in, no copy name anywhere
    const xml = tablXml({name: "ZOSD_H1_SFX_BASE", text: "", clidep: false, fields});
    expect(xml).to.include(`<FIELDNAME>.INCLU-01</FIELDNAME>`);
    expect(xml).to.not.include("ZOSD_H1_SFX_A01");
    expect(xml).to.not.include("ZOSD_H1_SFX_B01");
    expect(xml.split("ZOSD_H1_SFX_A").length - 1).to.equal(0);
  });

  // CRITIC-929-r2 SHOULD 1: the mark decides, and here a test can see it.
  // Every copy fixture above carries the name the name rule computes, so
  // there mark and name agree; this row carries the mark and a name NO
  // include brings -- the only shape where the mark alone decides. The
  // name-only mutant keeps it and goes red here.
  it("drops an ADMINFIELD-'1' row whose name no include brings -- the mark, not the name (H5d r2)", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X", adminfield: "0"},
      {position: "2", fieldname: ".INCLUDE", precfield: "ZOSD_H1_MARK_INC", adminfield: "0"},
      // the dictionary's mark is what drops this row: its name is in no
      // include's rows, so the name rule alone would keep it
      {position: "3", fieldname: "ZOSD_H1_MARK_GHOST", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: "", adminfield: "1"},
      {position: "4", fieldname: "ZOSD_H1_TAIL", keyflag: "", rollname: "", datatype: "CHAR", leng: "2", decimals: "0", inttype: "C", intlen: "000004", notnull: "", adminfield: "0"},
    ];
    const includes = new Map([["ZOSD_H1_MARK_INC", [
      {position: "1", fieldname: "ZOSD_H1_MARK_REAL", keyflag: "", rollname: "", datatype: "CHAR", leng: "4", decimals: "0", inttype: "C", intlen: "000008", notnull: ""},
    ]]]);
    const fields = ddicFieldsWithIncludes(rows, {}, includes);
    expect(fields.map((f) => f.fieldname)).to.deep.equal(["MANDT", ".INCLUDE", "ZOSD_H1_TAIL"]);
  });

  // CRITIC-929-r2 SHOULD 2: the mark's value space is abapGit's own rule,
  // `adminfield <> '0'`, not `= '1'` -- both dumps measure only '0' and
  // '1', but the rule decides by the mark, not by the value the dumps
  // happen to carry. Under the old `=== "1"` skip this row is written
  // beside the marker and dies in the transpiler; the rule drops it.
  it("drops a row carrying a mark other than '0' or '1' -- abapGit's rule is <> '0' (H5d r2)", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X", adminfield: "0"},
      {position: "2", fieldname: ".INCLUDE", precfield: "ZOSD_H1_MARK_INC", adminfield: "0"},
      {position: "3", fieldname: "ZOSD_H1_MARK_ODD", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: "", adminfield: "2"},
      {position: "4", fieldname: "ZOSD_H1_TAIL", keyflag: "", rollname: "", datatype: "CHAR", leng: "2", decimals: "0", inttype: "C", intlen: "000004", notnull: "", adminfield: "0"},
    ];
    const includes = new Map([["ZOSD_H1_MARK_INC", [
      {position: "1", fieldname: "ZOSD_H1_MARK_REAL", keyflag: "", rollname: "", datatype: "CHAR", leng: "4", decimals: "0", inttype: "C", intlen: "000008", notnull: ""},
    ]]]);
    const fields = ddicFieldsWithIncludes(rows, {}, includes);
    expect(fields.map((f) => f.fieldname)).to.deep.equal(["MANDT", ".INCLUDE", "ZOSD_H1_TAIL"]);
  });

  // CRITIC-929-r2 SHOULD 2: a plain row ('0') named like an include's
  // flattened field. Plain by its mark, round 1 kept it -- tablXml's
  // refusal cannot see the collision, because the include's fields are
  // not in the final list: the kept marker makes the transpiler expand
  // them in, and the duplicate died in cds2ddic later. It is refused
  // here, at generation, naming the table (the row's own TABNAME) and
  // the field, like the raw duplicate's refusal beside it.
  it("refuses a plain row that repeats an include's field, naming table and field (H5d r2)", () => {
    const rows = [
      {position: "1", fieldname: "MANDT", keyflag: "X", rollname: "MANDT", datatype: "CLNT", leng: "3", decimals: "0", inttype: "C", intlen: "000006", notnull: "X", tabname: "ZOSD_H1_DUPREF", adminfield: "0"},
      {position: "2", fieldname: ".INCLUDE", precfield: "ZOSD_H1_DUPREF_INC", tabname: "ZOSD_H1_DUPREF", adminfield: "0"},
      {position: "3", fieldname: "ZOSD_H1_DUPREF_F", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: "", tabname: "ZOSD_H1_DUPREF", adminfield: "0"},
    ];
    const includes = new Map([["ZOSD_H1_DUPREF_INC", [
      {position: "1", fieldname: "ZOSD_H1_DUPREF_F", keyflag: "", rollname: "", datatype: "CHAR", leng: "1", decimals: "0", inttype: "C", intlen: "000002", notnull: ""},
    ]]]);
    let error;
    try { ddicFieldsWithIncludes(rows, {}, includes); } catch (e) { error = e; }
    expect(error?.message, "the table").to.include("ZOSD_H1_DUPREF");
    expect(error?.message, "the field").to.include("ZOSD_H1_DUPREF_F");
  });

  // CRITIC-929 MUST 1 (b): a raw duplicate -- two plain rows of one table
  // carrying the same FIELDNAME, no include in sight -- is refused before
  // anything is written, naming table and field, where it used to be
  // written twice and die in cds2ddic later. Two markers naming two
  // appends are the dictionary's own spelling and stay legal.
  it("refuses a field list that repeats a FIELDNAME, naming table and field (H5d)", () => {
    let error;
    try {
      tablXml({name: "ZOSD_H1_DUP", text: "", clidep: false, fields: [
        {fieldname: "ZOSD_H1_DUP_F", key: false, datatype: "CHAR", leng: "000002", intlen: "000004", inttype: "C"},
        {fieldname: "ZOSD_H1_DUP_F", key: false, datatype: "CHAR", leng: "000002", intlen: "000004", inttype: "C"},
      ]});
    } catch (e) { error = e; }
    expect(error?.message, "the table").to.include("ZOSD_H1_DUP");
    expect(error?.message, "the field").to.include("ZOSD_H1_DUP_F");
    expect(() => tablXml({name: "ZOSD_H1_TWO_AP", text: "", clidep: false, fields: [
      {fieldname: ".INCLU--AP", key: false, marker: true, precfield: "ZOSD_H1_AP_ONE"},
      {fieldname: ".INCLU--AP", key: false, marker: true, precfield: "ZOSD_H1_AP_TWO"},
    ]}), "two appends stay legal").to.not.throw();
  });

  it("a structured component carries its own COMPTYPE (H5a: DD03L COMPTYPE S)", () => {
    const fields = ddicFields([
      {position: "1", fieldname: "ZOSD_H1_ADDR", keyflag: "", rollname: "ZOSD_H1_STRUCT", comptype: "S", datatype: "STRU", leng: "000000", decimals: "000000", inttype: "", intlen: "000000", notnull: ""},
    ], {});
    expect(fields[0]).to.include({rollname: "ZOSD_H1_STRUCT", comptype: "S", datatype: "STRU"});
    // a structure is not a TRANSP table: the dump's INTTAB rows go out in the
    // include shape, no DD09L and no client
    const xml = tablXml({name: "ZOSD_H1_WITH_STRUCT", text: "h1 fixture structure", clidep: false, tabclass: "INTTAB", fields});
    expect(xml).to.include(`<TABCLASS>INTTAB</TABCLASS>`);
    expect(xml).to.not.include(`<DD09L>`);
    expect(xml).to.include(`<ROLLNAME>ZOSD_H1_STRUCT</ROLLNAME>
     <COMPTYPE>S</COMPTYPE>`);
    // a structured component's DD03L row carries INTTYPE blank: an empty
    // tag is the drift the module refuses everywhere else, so the tag only
    // goes out when there is a letter (CRITIC-926 SHOULD 2). MASK spells
    // the component kind the way a system's own export does -- "      S",
    // not "  STRU" (abaplint reads neither for COMPTYPE S)
    expect(xml).to.not.include(`<INTTYPE></INTTYPE>`);
    expect(xml).to.include(`<MASK>      S</MASK>`);
    // the live path's tables, with no TABCLASS named, stay TRANSP
    expect(tablXml({name: "ZOSD_H1_HEAD", text: "", clidep: true, fields: []})).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
  });

  // CRITIC-926 SHOULD 3: TABCLASS was reduced to a boolean, and a POOL
  // row went out silently as an INTTAB structure -- a type that holds no
  // rows. H5d lifted the two refusals the real closure run hit (APPEND and
  // VIEW); POOL and CLUSTER stay refused by name, and the refusal is about
  // the TABCLASS alone (CRITIC-929 SHOULD 4): the view sentence lives in
  // the dump run's summary line and the docs, not in this error.
  it("refuses a TABCLASS this path does not write, by name", () => {
    for (const tabclass of ["POOL", "CLUSTER"]) {
      let error;
      try { tablXml({name: `ZOSD_H1_${tabclass}`, text: "", clidep: true, tabclass, fields: []}); } catch (e) { error = e; }
      expect(error?.message, tabclass).to.include(`ZOSD_H1_${tabclass}`);
      expect(error?.message, tabclass).to.include(tabclass);
    }
    expect(tablXml({name: "ZOSD_H1_TRANSP", text: "", clidep: true, tabclass: "TRANSP", fields: []})).to.include(`<TABCLASS>TRANSP</TABCLASS>`);
    expect(tablXml({name: "ZOSD_H1_INTTAB", text: "", clidep: false, tabclass: "INTTAB", fields: []})).to.include(`<TABCLASS>INTTAB</TABCLASS>`);
  });

  // H5d, the two refusals the real closure run hit, now written: an APPEND
  // as its own TABL -- TABCLASS APPEND, the SQLTAB target, no DD09L, no
  // client -- and a VIEW as a read-only structure type, the shape the
  // transpiler resolves the name through.
  it("writes an APPEND with its SQLTAB target and a VIEW as a read-only structure (H5d)", () => {
    const append = tablXml({name: "ZOSD_H1_APPEND", text: "h1 fixture append", clidep: false, tabclass: "APPEND",
      sqltab: "ZOSD_H1_BASE", fields: []});
    expect(append).to.include(`<TABCLASS>APPEND</TABCLASS>`);
    expect(append).to.include(`<SQLTAB>ZOSD_H1_BASE</SQLTAB>`);
    expect(append).to.not.include(`<DD09L>`);
    expect(append).to.not.include(`<CLIDEP>`);
    // no target named, no tag: an empty SQLTAB is drift, as everywhere
    expect(tablXml({name: "ZOSD_H1_APPEND_NT", text: "", clidep: false, tabclass: "APPEND", fields: []}))
      .to.not.include(`<SQLTAB>`);
    const view = tablXml({name: "ZOSD_H1_VIEW", text: "h1 fixture view", clidep: false, tabclass: "VIEW",
      fields: [
        {fieldname: "ZOSD_H1_VKEY", key: true, datatype: "CHAR", leng: "000004", intlen: "000008", inttype: "C"},
        {fieldname: "ZOSD_H1_VTEXT", key: false, datatype: "CHAR", leng: "000030", intlen: "000060", inttype: "C"},
      ]});
    expect(view).to.include(`<TABCLASS>VIEW</TABCLASS>`);
    expect(view).to.not.include(`<DD09L>`);
    expect(view).to.not.include(`<CLIDEP>`);
    expect(view).to.include(`<FIELDNAME>ZOSD_H1_VTEXT</FIELDNAME>`);
    // the POOL refusal is about the TABCLASS alone (CRITIC-929 SHOULD 4):
    // the view sentence is the summary line's and the docs', not this
    // error's tail
    let error;
    try { tablXml({name: "ZOSD_H1_POOL", text: "", clidep: true, tabclass: "POOL", fields: []}); } catch (e) { error = e; }
    expect(error?.message).to.include("ZOSD_H1_POOL");
    expect(error?.message).to.not.include("synonym");
    expect(error?.message).to.not.include("SQL time");
  });

  // the marker's DD03P, as the fetched pack's own exports spell it: KEYFLAG
  // when the marker is a key include, COMPTYPE S, the structure in
  // PRECFIELD, the component kind in MASK -- and none of the type tags a
  // plain field carries
  it("an include marker goes out as the export spells it (H5d)", () => {
    const xml = tablXml({name: "ZOSD_H1_WITH_MARKER", text: "h1 fixture", clidep: false,
      fields: [
        {fieldname: "MANDT", key: true, notnull: true, mandt: true, datatype: "CLNT", leng: "000003",
          tags: {KEYFLAG: "X", ROLLNAME: "MANDT", ADMINFIELD: "0", NOTNULL: "X", COMPTYPE: "E"}},
        {fieldname: ".INCLU--AP", key: false, marker: true, precfield: "ZOSD_H1_APPEND"},
      ]});
    expect(xml).to.match(/<FIELDNAME>\.INCLU--AP<\/FIELDNAME>\s*<COMPTYPE>S<\/COMPTYPE>\s*<PRECFIELD>ZOSD_H1_APPEND<\/PRECFIELD>\s*<MASK>      S<\/MASK>/);
    // a key include carries its KEYFLAG on the marker
    const keyed = tablXml({name: "ZOSD_H1_KEYED", text: "", clidep: false,
      fields: [{fieldname: ".INCLUDE", key: true, marker: true, precfield: "ZOSD_H1_KEYS"}]});
    expect(keyed).to.match(/<FIELDNAME>\.INCLUDE<\/FIELDNAME>\s*<KEYFLAG>X<\/KEYFLAG>\s*<COMPTYPE>S<\/COMPTYPE>/);
  });

  // CRITIC-926 SHOULD 4: the TABL header's DDLANGUAGE was a hard-coded E
  // while the DDTEXT was picked in the master language. The language rides
  // with the text, and a table with no text in that language goes out
  // without the DDTEXT, not with an empty tag.
  it("the TABL header carries the master language, and drops an empty DDTEXT", () => {
    const german = tablXml({name: "ZOSD_H1_LANG", text: "h1 fixture (de)", clidep: true, tabclass: "TRANSP", language: "D", fields: []});
    expect(german).to.include(`<DDLANGUAGE>D</DDLANGUAGE>`);
    expect(german).to.include(`<DDTEXT>h1 fixture (de)</DDTEXT>`);
    const noText = tablXml({name: "ZOSD_H1_NOTEXT", text: "", clidep: false, fields: []});
    expect(noText).to.include(`<DDLANGUAGE>E</DDLANGUAGE>`);
    expect(noText).to.not.include(`<DDTEXT>`);
  });
});

// CRITIC-926 SHOULD 1 + 6: the DTEL/DOMA writers pinned whole-file, tag
// order and all -- swapping two tags (the critic's mutations) has to go
// red. The element rows are shaped like the real dump's DD04L (measured
// 2026-11-12): a domain-typed row is REFKIND D with DOMNAME and the
// domain's own DATATYPE/LENG/DECIMALS/OUTPUTLEN copied onto the element
// row -- abapGit clears the copy and resolves the type through the domain
// -- and a predefined row is REFKIND blank with its own DATATYPE, the
// initial values dropped.
describe("dtelXml/domaXml: the abapGit file byte for byte", () => {
  const envelope = (serializer, values) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_${serializer}" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
${values}  </asx:values>
 </asx:abap>
</abapGit>
`;

  it("a domain-typed element: DOMNAME third, none of the type tags", () => {
    const xml = dtelXml({
      name: "ZOSD_H1_DTEL_DOM",
      // the copied type fields sit on the row and must not reach the XML;
      // the keys are the dumpRows-folded lower-case ones the generator
      // hands the writer
      row: {rollname: "ZOSD_H1_DTEL_DOM", domname: "ZOSD_H1_DOMA", datatype: "CHAR",
        leng: "000001", decimals: "000000", outputlen: "000001",
        headlen: "12", scrlen1: "10", scrlen2: "12", scrlen3: "12",
        dtelmaster: "E", refkind: "D"},
      trow: {ddtext: "h1 fixture element", reptext: "Elem", scrtext_s: "El", scrtext_m: "Elem", scrtext_l: "Element"},
      masterLanguage: "E",
    });
    expect(xml).to.equal(`${envelope("DTEL", `   <DD04V>
    <ROLLNAME>ZOSD_H1_DTEL_DOM</ROLLNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <DOMNAME>ZOSD_H1_DOMA</DOMNAME>
    <HEADLEN>12</HEADLEN>
    <SCRLEN1>10</SCRLEN1>
    <SCRLEN2>12</SCRLEN2>
    <SCRLEN3>12</SCRLEN3>
    <DDTEXT>h1 fixture element</DDTEXT>
    <REPTEXT>Elem</REPTEXT>
    <SCRTEXT_S>El</SCRTEXT_S>
    <SCRTEXT_M>Elem</SCRTEXT_M>
    <SCRTEXT_L>Element</SCRTEXT_L>
    <DTELMASTER>E</DTELMASTER>
    <REFKIND>D</REFKIND>
   </DD04V>
`)}`);
  });

  it("a predefined-typed element: the type tags after DTELMASTER, the zeros dropped", () => {
    const xml = dtelXml({
      name: "ZOSD_H1_DTEL_STRG",
      // the real dump's one string element: LENG/DECIMALS/OUTPUTLEN all
      // zero, and the export spells DATATYPE alone
      row: {rollname: "ZOSD_H1_DTEL_STRG", datatype: "STRG", leng: "000000",
        decimals: "000000", outputlen: "000000", headlen: "11",
        scrlen1: "10", scrlen2: "11", scrlen3: "11", dtelmaster: "E", refkind: ""},
      trow: {ddtext: "h1 fixture string"},
      masterLanguage: "E",
    });
    expect(xml).to.equal(`${envelope("DTEL", `   <DD04V>
    <ROLLNAME>ZOSD_H1_DTEL_STRG</ROLLNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <HEADLEN>11</HEADLEN>
    <SCRLEN1>10</SCRLEN1>
    <SCRLEN2>11</SCRLEN2>
    <SCRLEN3>11</SCRLEN3>
    <DDTEXT>h1 fixture string</DDTEXT>
    <DTELMASTER>E</DTELMASTER>
    <DATATYPE>STRG</DATATYPE>
   </DD04V>
`)}`);
  });

  it("a domain with values: the DD01V and the DD07V_TAB", () => {
    const xml = domaXml({
      name: "ZOSD_H1_DOMA",
      row: {domname: "ZOSD_H1_DOMA", datatype: "CHAR", leng: "000001",
        decimals: "000000", outputlen: "000001", lowercase: "X", valexi: "X", dommaster: "E"},
      text: "h1 fixture domain",
      masterLanguage: "E",
      // given out of VALPOS order: the writer sorts
      values: [
        {domname: "ZOSD_H1_DOMA", valpos: "0002", domvalue_l: "C", domvalue_h: "Z", ddtext: "custom"},
        {domname: "ZOSD_H1_DOMA", valpos: "0001", domvalue_l: "N", domvalue_h: "", ddtext: "no"},
      ],
    });
    expect(xml).to.equal(`${envelope("DOMA", `   <DD01V>
    <DOMNAME>ZOSD_H1_DOMA</DOMNAME>
    <DDLANGUAGE>E</DDLANGUAGE>
    <DATATYPE>CHAR</DATATYPE>
    <LENG>000001</LENG>
    <DECIMALS>000000</DECIMALS>
    <OUTPUTLEN>000001</OUTPUTLEN>
    <LOWERCASE>X</LOWERCASE>
    <VALEXI>X</VALEXI>
    <DDTEXT>h1 fixture domain</DDTEXT>
   </DD01V>
   <DD07V_TAB>
    <DD07V>
     <DOMNAME>ZOSD_H1_DOMA</DOMNAME>
     <VALPOS>0001</VALPOS>
     <DDLANGUAGE>E</DDLANGUAGE>
     <DOMVALUE_L>N</DOMVALUE_L>
     <DDTEXT>no</DDTEXT>
    </DD07V>
    <DD07V>
     <DOMNAME>ZOSD_H1_DOMA</DOMNAME>
     <VALPOS>0002</VALPOS>
     <DDLANGUAGE>E</DDLANGUAGE>
     <DOMVALUE_L>C</DOMVALUE_L>
     <DOMVALUE_H>Z</DOMVALUE_H>
     <DDTEXT>custom</DDTEXT>
    </DD07V>
   </DD07V_TAB>
`)}`);
  });
});
