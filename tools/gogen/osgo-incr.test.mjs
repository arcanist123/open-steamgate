// The per-object front-end cache (osgo-incr.mjs) over a small tree: a fast
// build -- the live generation's cache plus fresh lowerings of the edited
// objects and their dependents -- must produce the same program a full front
// end produces of the same tree, byte for byte where the build embeds it
// (the emitted Go), and the refusals must be the doubtful cases.
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {emitGo} from "./emit-go.mjs";
import {columnRegistry} from "./frontend.mjs";
import {dbCacheWrite, dbContributions, incrAssemble, incrRecorder, objectOf, registryFiles} from "./osgo-incr.mjs";
import {sealCache} from "./osgo-incr-meta.mjs";

const xml = (body) => `<?xml version="1.0"?><abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${body}</asx:values></asx:abap></abapGit>`;

const sources = {
  // a CDS view source: its entity name and its SQL view name reach the
  // program's cdsViews map, which the closure registry cannot rebuild (its
  // walk takes .abap/.xml files only) -- the cache must replay the map
  "app/zv_incr_src.ddls.asddls": `@AbapCatalog.sqlViewName: 'ZVINCRV'
@AccessControl.authorizationCheck: #NOT_REQUIRED
define view Zv_Incr_Src as select from zcl_incr_hot { key travelid as Id }`,
  // a function group whose module is typed with a dictionary structure:
  // compileProgram reads the signature before any class lowers, so the
  // structure is the first one the full build writes -- a merge that put
  // the global passes after every object moved it behind the classes' own
  "app/zincr_line.tabl.xml": xml(`<DD02V><TABNAME>ZINCR_LINE</TABNAME><TABCLASS>INTTAB</TABCLASS></DD02V><DD03P_TABLE>
<DD03P><FIELDNAME>TDFORMAT</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000002</LENG></DD03P>
<DD03P><FIELDNAME>TDLINE</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000072</LENG></DD03P></DD03P_TABLE>`),
  "app/zincr_group.fugr.xml": xml(`<INCLUDES><SOBJ_NAME>LZINCR_GROUPTOP</SOBJ_NAME><SOBJ_NAME>SAPLZINCR_GROUP</SOBJ_NAME></INCLUDES>
<FUNCTIONS><item><FUNCNAME>ZINCR_FUNCTION</FUNCNAME><IMPORT><RSIMP><PARAMETER>IS_LINE</PARAMETER><TYP>ZINCR_LINE</TYP></RSIMP></IMPORT><EXPORT><RSEXP><PARAMETER>EV_VALUE</PARAMETER><TYP>I</TYP></RSEXP></EXPORT></item></FUNCTIONS>`),
  "app/zincr_group.fugr.saplzincr_group.abap": "INCLUDE lzincr_grouptop.\n",
  "app/zincr_group.fugr.lzincr_grouptop.abap": "FUNCTION-POOL zincr_group.\n",
  "app/zincr_group.fugr.zincr_function.abap": "FUNCTION zincr_function. ev_value = strlen( is_line-tdline ). ENDFUNCTION.\n",
  "app/zif_incr_types.intf.abap": `INTERFACE zif_incr_types PUBLIC.
  TYPES: BEGIN OF ty_pair, a TYPE i, b TYPE i, END OF ty_pair.
  TYPES ty_nr TYPE i.
  TYPES ty_range TYPE RANGE OF i.
  CONSTANTS co_version TYPE i VALUE 3.
  METHODS half IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.
  METHODS clip IMPORTING it TYPE zif_incr_types=>ty_range RETURNING VALUE(r) TYPE i.
ENDINTERFACE.`,
  "app/zcl_incr_base.clas.abap": `CLASS zcl_incr_base DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_incr_types.
    METHODS compute IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_base IMPLEMENTATION.
  METHOD compute.
    r = n.
    IF r > 10.
      r = r - 1.
    ENDIF.
  ENDMETHOD.
  METHOD zif_incr_types~half.
    r = n.
    WHILE r > 1.
      r = r - 2.
    ENDWHILE.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_impl.clas.abap": `CLASS zcl_incr_impl DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_incr_types.
    METHODS pairsum IMPORTING is_pair TYPE zif_incr_types=>ty_pair RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_impl IMPLEMENTATION.
  METHOD zif_incr_types~half.
    DATA base TYPE REF TO zcl_incr_base.
    CREATE OBJECT base.
    r = base->zif_incr_types~half( n ).
  ENDMETHOD.
  METHOD pairsum.
    r = is_pair-a + is_pair-b + zif_incr_types=>co_version.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_caller.clas.abap": `CLASS zcl_incr_caller DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run IMPORTING n TYPE i RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_caller IMPLEMENTATION.
  METHOD run.
    DATA impl TYPE REF TO zcl_incr_impl.
    DATA pair TYPE zif_incr_types=>ty_pair.
    DATA range TYPE zif_incr_types=>ty_range.
    DATA intf TYPE REF TO zif_incr_types.
    CREATE OBJECT impl TYPE zcl_incr_impl.
    pair-a = impl->pairsum( pair ).
    DATA wa LIKE LINE OF range.
    wa-sign = 'I'.
    wa-option = 'EQ'.
    wa-low = n.
    APPEND wa TO range.
    CREATE OBJECT intf TYPE zcl_incr_impl.
    r = |{ intf->half( n ) }/{ intf->clip( range ) }/{ zif_incr_types=>co_version }|.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_hot.clas.abap": `CLASS zcl_incr_hot DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS key IMPORTING travelid TYPE string RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_hot IMPLEMENTATION.
  METHOD key.
    IF travelid IS INITIAL.
      r = 'Key TravelId missing'.
    ENDIF.
    r = |hot:{ travelid }|.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_witness.clas.abap": `CLASS zcl_incr_witness DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row, a TYPE i, END OF ty_row.
    TYPES tt_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    METHODS seen RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_witness IMPLEMENTATION.
  METHOD seen.
    r = 1.
  ENDMETHOD.
ENDCLASS.`,
  // an exception class of the run-time library shape: a parseable
  // definition under a resolvable superclass, and a body that does not parse,
  // so it is broken and leaves `wanted` while staying resolvable for the
  // syntax pass and for the subclass below -- which is wanted but referenced
  // by nobody the closure walks, so a fast build's registry does not hold it
  "app/zcl_incr_root.clas.abap": `CLASS zcl_incr_root DEFINITION PUBLIC FINAL CREATE PUBLIC.
ENDCLASS.
CLASS zcl_incr_root IMPLEMENTATION.
ENDCLASS.`,
  "app/zcx_incr_lib.clas.abap": `CLASS zcx_incr_lib DEFINITION PUBLIC INHERITING FROM zcl_incr_root.
  PUBLIC SECTION.
    METHODS mark RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcx_incr_lib IMPLEMENTATION.
  METHOD mark.
    FROBNICATE r.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_sub.clas.abap": `CLASS zcl_incr_sub DEFINITION PUBLIC INHERITING FROM zcx_incr_lib.
  PUBLIC SECTION.
    METHODS own RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_sub IMPLEMENTATION.
  METHOD own.
    r = 1.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_top.clas.abap": `CLASS zcl_incr_top DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run IMPORTING rows TYPE zcl_incr_witness=>tt_rows RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_incr_top IMPLEMENTATION.
  METHOD run.
    DATA hot TYPE REF TO zcl_incr_hot.
    FIELD-SYMBOLS <row> LIKE LINE OF rows.
    CREATE OBJECT hot.
    TRY.
      rv = |x:{ hot->key( 'x' ) }|.
    CATCH zcx_incr_lib.
      rv = |c|.
    ENDTRY.
    LOOP AT rows ASSIGNING <row>.
      rv = |top:{ hot->key( 'x' ) }:{ <row>-a }|.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.`,
};

const edit = (root, file, from, to) => writeFileSync(join(root, file), readFileSync(join(root, file), "utf8").replace(from, to));

/** a canonical text of any lowered value: v8 bytes differ across a
 *  serialize/deserialize round trip for equal data, this does not */
function canon(value, depth = 0) {
  if (value === null || ["undefined", "string", "number", "boolean"].includes(typeof value)) return [typeof value, String(value)];
  if (typeof value === "bigint") return ["bigint", String(value)];
  if (depth > 200) return ["deep", ""]; // a guard only: lowered values are acyclic
  if (Array.isArray(value)) return ["array", value.map((v) => canon(v, depth + 1))];
  if (value instanceof Map) return ["map", [...value].map(([k, v]) => [canon(k, depth + 1), canon(v, depth + 1)])];
  if (value instanceof Set) return ["set", [...value].map((v) => canon(v, depth + 1))];
  return ["object", Object.keys(value).sort().map((k) => [k, canon(value[k], depth + 1)])];
}
const text = (value) => JSON.stringify(canon(value));

function tree(extra = {}) {
  const root = mkdtempSync(join(tmpdir(), "osgo-incr-"));
  for (const [file, text] of Object.entries({...sources, ...extra})) {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  }
  return root;
}

const objectNames = (root) => [...registryFiles([join(root, "app")], new Set(), new Set()).values()].map((k) => k.slice(5).toLowerCase());

/** the program a full front end makes of the tree as it is now */
// (the ABAP Unit owners as osgo passes them, a Set: every class runs the
// local discovery then, which is a pass of its own in the write sequence)
const fullProgram = (root, includeTests = new Set()) => compileProgram({folders: [join(root, "app")], objects: objectNames(root), tolerant: true, includeTests});

/** a cache of the tree as it is now, the way a full build records it: the
 *  recorder's entries and index, then (osgDatabase's part) the database
 *  record and the stamp -- `{db: false}` stops after the index, as a build
 *  interrupted between the two does */
const writeCache = (root, gen = "live1", includeTests = new Set(), {db = true} = {}) => {
  const folders = [join(root, "app")];
  const recorder = incrRecorder({root, folders, hidden: new Set(), objects: objectNames(root), includeTests});
  const program = compileProgram({folders, objects: objectNames(root), tolerant: true, includeTests, incr: recorder});
  const written = recorder.finish({gen});
  if (db) dbCacheWrite(written.dir, dbContributions(program.reg));
  return {program, written, gen};
};

const emitted = (program) => emitGo(program);

test("objectOf maps a file of an object to its kind", () => {
  assert.deepEqual(objectOf("src/zcl_a.clas.abap"), ["CLAS", "ZCL_A"]);
  assert.deepEqual(objectOf("src/zcl_a.clas.locals_imp.abap"), ["CLAS", "ZCL_A"]);
  assert.deepEqual(objectOf("src/zif_b.intf.abap"), ["INTF", "ZIF_B"]);
  assert.deepEqual(objectOf("src/zstg_t.tabl.xml"), ["DDIC", "ZSTG_T"]);
  assert.deepEqual(objectOf("src/zfg.fugr.xml"), ["FUGR", "ZFG"]);
  // the ABAP type pool of a library: ABAP the syntax pass resolves
  assert.deepEqual(objectOf(".local/lars/open-abap-core/src/abap/abap.type.abap"), ["DDIC", "ABAP"]);
  assert.deepEqual(objectOf("src/readme.md"), ["OTHER", "README"]);
});

for (const [name, change] of [
  ["a method body (a literal in the edited class)", (root) => edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'")],
  ["a new method, defined and implemented", (root) => {
    edit(root, "app/zcl_incr_hot.clas.abap", "METHODS key IMPORTING", "METHODS twin RETURNING VALUE(r) TYPE i.\n    METHODS key IMPORTING");
    edit(root, "app/zcl_incr_hot.clas.abap", "METHOD key.", "METHOD twin.\n    r = 2.\n  ENDMETHOD.\n  METHOD key.");
  }],
  ["an interface constant read by other objects", (root) => edit(root, "app/zif_incr_types.intf.abap", "VALUE 3.", "VALUE 4.")],
  ["an interface gains a method an implementer provides", (root) => {
    edit(root, "app/zif_incr_types.intf.abap", "METHODS half", "METHODS third IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.\n  METHODS half");
    edit(root, "app/zcl_incr_base.clas.abap", "METHOD zif_incr_types~half.", "METHOD zif_incr_types~third.\n    r = n.\n  ENDMETHOD.\n  METHOD zif_incr_types~half.");
  }],
]) {
  test(`a fast build is the full build: ${name}`, () => {
    const root = tree();
    try {
      writeCache(root);
      change(root);
      const reference = fullProgram(root);
      const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
        proof: {ok: true, base: "live1", changed: changedFiles(root)}});
      assert.equal(attempt.ok, true, attempt.reason);
      assert.ok(attempt.lowered.includes("CLAS ZCL_INCR_HOT") || attempt.lowered.includes("INTF ZIF_INCR_TYPES"));
      assert.equal(attempt.program.classes.length, reference.classes.length);
      assert.equal(text(attempt.program.classes), text(reference.classes));
      assert.equal(text([...attempt.program.structs]), text([...reference.structs]));
      assert.equal(text([...attempt.program.consts]), text([...reference.consts]));
      assert.equal(text([...attempt.program.interfaceMethods]), text([...reference.interfaceMethods]));
      assert.equal(text([...attempt.program.events]), text([...reference.events]));
      assert.equal(text(attempt.program.exceptionSupers), text(reference.exceptionSupers));
      assert.equal(text([...attempt.program.rtti.structs]), text([...reference.rtti.structs]));
      assert.equal(JSON.stringify(columnRegistry(attempt.program)), JSON.stringify(columnRegistry(reference)));
      // the CDS view map of the record, not of the closure registry (empty)
      assert.deepEqual({...attempt.program.cdsViews}, {...reference.cdsViews});
      assert.ok(Object.keys(reference.cdsViews).length > 0, "the fixture must carry a CDS view");
      assert.equal(emitted(attempt.program), emitted(reference));
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

test("a class a re-lowered dependent names only in a signature is in the registry", () => {
  // The lowering never asks the registry for a class another class's table
  // type in a signature comes from, so `reads` does not carry it; abaplint's
  // syntax pass resolves the chain anyway, against whatever the registry
  // holds, and a LOOP over the parameter needs the type resolved. The real
  // tree refused exactly here first (ZCL_ZL3C_FLEET2_MPC, the model class
  // behind a redefined method's signature of ZCL_ZL3C_FLEET2_DPC_EXT, a
  // dependent two recorded edges from the edit) until the closure walked
  // `deps` as well, for every object the registry holds.
  const root = tree();
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'");
    const reference = fullProgram(root);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(attempt.lowered.includes("CLAS ZCL_INCR_TOP"));
    assert.ok(!attempt.lowered.includes("CLAS ZCL_INCR_WITNESS"));
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a CATCH whose chain leaves the partial registry answers from the recorded supers", () => {
  // caughtPresence decides whether a CATCH also takes the raised objects of
  // the classes it names (emit-go.mjs catchCond: abap.IsA against "false"),
  // and the index it reads is built from the superclass chains of everything
  // in `wanted`. A wanted class the closure registry does not hold (the
  // subclass of a library exception, referenced by nothing the closure walks)
  // has no chain there, so a partial-registry walk would drop it from the
  // index and emit the CATCH as dead. The read side answers over the
  // recorded `wanted` from the superclass map the write-time build recorded
  // off the full registry.
  const root = tree();
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'");
    const reference = fullProgram(root);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(!attempt.lowered.includes("CLAS ZCL_INCR_SUB"), "the subclass must stay cached");
    assert.match(emitted(attempt.program), /abap\.IsA\(xRX\.Class, "ZCX_INCR_LIB"\)/);
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

/** the files this test edited (the cache's proof names root-relative files) */
function changedFiles(root, extra = {}, includeTests = new Set()) {
  const all = {...sources, ...extra};
  return [...registryFiles([join(root, "app")], new Set(), includeTests).keys()]
    .map((f) => f.slice(root.length + 1))
    .filter((f) => readFileSync(join(root, f), "utf8") !== all[f]);
}

// A class with local classes compiled (the ABAP Unit owners osgo passes, or
// LOCAL_CLASSES): the full build lowers them in a pass of their own AFTER
// every class, so the structures their types make come after every class's.
// The real tree's LCL_STACK__TY_DATA moved to its owner's slot under a merge
// that grouped an object's writes per object rather than per pass.
const withLocals = {
  "app/zcl_incr_aaa.clas.abap": `CLASS zcl_incr_aaa DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS one RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_aaa IMPLEMENTATION.
  METHOD one.
    r = 1.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_aaa.clas.testclasses.abap": `CLASS ltcl_aaa DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_loc, x TYPE i, y TYPE string, END OF ty_loc.
    METHODS run FOR TESTING.
ENDCLASS.
CLASS ltcl_aaa IMPLEMENTATION.
  METHOD run.
    DATA s TYPE ty_loc.
    s-x = 1.
    s-y = |{ s-x }|.
  ENDMETHOD.
ENDCLASS.`,
};

for (const [name, file] of [["cached", "app/zcl_incr_hot.clas.abap"], ["re-lowered", "app/zcl_incr_aaa.clas.testclasses.abap"]]) {
  test(`the local classes' writes keep their pass after every class (owner ${name})`, () => {
    const units = new Set(["ZCL_INCR_AAA"]);
    const root = tree(withLocals);
    try {
      writeCache(root, "live1", units);
      if (file.includes("hot")) edit(root, file, "'Key TravelId missing'", "'Key TravelId missing (edited)'");
      else edit(root, file, "s-x = 1.", "s-x = 2.");
      const reference = fullProgram(root, units);
      const local = [...reference.structs.keys()].findIndex((k) => /TY_LOC/.test(k));
      const pair = [...reference.structs.keys()].findIndex((k) => /TY_PAIR/.test(k));
      assert.ok(local > pair && pair >= 0, `the fixture must write the local type after the classes' (${[...reference.structs.keys()]})`);
      const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: units,
        proof: {ok: true, base: "live1", changed: changedFiles(root, withLocals, units)}});
      assert.equal(attempt.ok, true, attempt.reason);
      assert.equal(attempt.lowered.includes("CLAS ZCL_INCR_AAA"), name === "re-lowered");
      assert.deepEqual([...attempt.program.structs.keys()], [...reference.structs.keys()]);
      assert.equal(text([...attempt.program.consts]), text([...reference.consts]));
      assert.equal(text(attempt.program.classes), text(reference.classes));
      assert.equal(emitted(attempt.program), emitted(reference));
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

// An anonymous structure (a structured constant of an interface) reached by
// several classes is one abaplint type instance, named after the FIRST class
// of the full build's order to reach it; another constant of the same shape
// is another instance with another name, so the shape alone does not say
// which. A fast build that re-lowers a later reacher while the first one
// stays cached must still give it the first reacher's name (the real tree:
// ZCL_STG_SADL_DPC__S_MSGID_... where the full build has
// ZCL_OSD_RAP_SADL__S_MSGID_...).
const withAnon = {
  "app/zif_incr_msg.intf.abap": `INTERFACE zif_incr_msg PUBLIC.
  CONSTANTS: BEGIN OF co_err, msgid TYPE c LENGTH 20 VALUE 'M1', msgno TYPE c LENGTH 3 VALUE '001', END OF co_err.
ENDINTERFACE.`,
  "app/zif_incr_msg2.intf.abap": `INTERFACE zif_incr_msg2 PUBLIC.
  CONSTANTS: BEGIN OF co_other, msgid TYPE c LENGTH 20 VALUE 'M2', msgno TYPE c LENGTH 3 VALUE '002', END OF co_other.
ENDINTERFACE.`,
  "app/zcl_incr_a1.clas.abap": `CLASS zcl_incr_a1 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_a1 IMPLEMENTATION.
  METHOD m.
    DATA e LIKE zif_incr_msg=>co_err.
    e = zif_incr_msg=>co_err.
    r = e-msgid.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_b2.clas.abap": `CLASS zcl_incr_b2 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_b2 IMPLEMENTATION.
  METHOD m.
    DATA e LIKE zif_incr_msg2=>co_other.
    e = zif_incr_msg2=>co_other.
    r = e-msgno.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_z9.clas.abap": `CLASS zcl_incr_z9 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_z9 IMPLEMENTATION.
  METHOD m.
    DATA e LIKE zif_incr_msg=>co_err.
    e = zif_incr_msg=>co_err.
    r = |z9:{ e-msgno }|.
  ENDMETHOD.
ENDCLASS.`,
};

test("a re-lowered later reacher of a shared anonymous structure keeps the first reacher's name", () => {
  const root = tree(withAnon);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_z9.clas.abap", "|z9:{ e-msgno }|", "|z9!{ e-msgno }|");
    const reference = fullProgram(root);
    const names = [...reference.structs.keys()].filter((k) => /S_MSGID_MSGNO/.test(k));
    assert.ok(names.some((k) => k.startsWith("ZCL_INCR_A1__")) && names.some((k) => k.startsWith("ZCL_INCR_B2__")),
      `the fixture must name one shape twice (${names})`);
    assert.ok(!names.some((k) => k.startsWith("ZCL_INCR_Z9__")), `z9 must reuse a1's name in the full build (${names})`);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, withAnon)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(attempt.lowered.includes("CLAS ZCL_INCR_Z9") && !attempt.lowered.includes("CLAS ZCL_INCR_A1"));
    assert.deepEqual([...attempt.program.structs.keys()], [...reference.structs.keys()]);
    assert.equal(text([...attempt.program.consts]), text([...reference.consts]));
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("an edit that newly reaches a declared anonymous structure takes the name the full build gives it", () => {
  // hot never reached the shape; the structure it now reaches is a member
  // of zif_incr_msg2 that b2 (cached, earlier in the full build's order)
  // named: the full build names it after b2, and so must the fast one --
  // by the declaration, not by the shape, which a1's constant shares
  const root = tree(withAnon);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "r = |hot:{ travelid }|.", "DATA e LIKE zif_incr_msg2=>co_other.\n    e = zif_incr_msg2=>co_other.\n    r = |hot:{ travelid }{ e-msgid }|.");
    const reference = fullProgram(root);
    assert.ok([...reference.structs.keys()].some((k) => k.startsWith("ZCL_INCR_B2__S_MSGID")));
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, withAnon)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(!attempt.lowered.includes("CLAS ZCL_INCR_B2"));
    assert.deepEqual([...attempt.program.structs.keys()], [...reference.structs.keys()]);
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a re-lowered object that reached its own and another class's structure of one shape keeps both names", () => {
  // the real tree's case: ZCL_STG_SADL_DPC mints a name for its own message
  // structure and reaches ZCL_OSD_RAP_SADL's of the same shape under that
  // class's name -- one object, one shape, two names, told apart only by
  // the declaration each instance belongs to
  const root = tree({...withAnon,
    "app/zcl_incr_z9.clas.abap": `CLASS zcl_incr_z9 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS: BEGIN OF co_mine, msgid TYPE c LENGTH 20 VALUE 'M9', msgno TYPE c LENGTH 3 VALUE '009', END OF co_mine.
    METHODS m RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_incr_z9 IMPLEMENTATION.
  METHOD m.
    DATA e LIKE zif_incr_msg=>co_err.
    DATA f LIKE co_mine.
    e = zif_incr_msg=>co_err.
    f = co_mine.
    r = |z9:{ e-msgno }{ f-msgno }|.
  ENDMETHOD.
ENDCLASS.`});
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_z9.clas.abap", "|z9:{ e-msgno }{ f-msgno }|", "|z9!{ e-msgno }{ f-msgno }|");
    const reference = fullProgram(root);
    const names = [...reference.structs.keys()].filter((k) => /S_MSGID_MSGNO/.test(k));
    assert.ok(names.some((k) => k.startsWith("ZCL_INCR_A1__")) && names.some((k) => k.startsWith("ZCL_INCR_Z9__")), `fixture (${names})`);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, withAnon)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.deepEqual([...attempt.program.structs.keys()], [...reference.structs.keys()]);
    assert.equal(text([...attempt.program.consts]), text([...reference.consts]));
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a cache of another generation is refused, and so is an unreadable entry", async () => {
  const root = tree();
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'x'");
    const wrong = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "other", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(wrong.ok, false);
    assert.match(wrong.reason, /no per-object cache/);
    rmSync(join(root, "build", "osgo-incr", "live1", "e"), {recursive: true, force: true});
    const gone = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(gone.ok, false);
    assert.match(gone.reason, /unreadable/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("a syntax error in the edited object refuses the fast build", () => {
  const root = tree();
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "r = |hot:{ travelid }|.", "r = zcl_incr_hot=>nope( ).");
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /syntax errors in re-lowered objects/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("the cache is refused when the front end itself changed (tool identity)", () => {
  const root = tree();
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'x'");
    const file = join(root, "build", "osgo-incr", "live1", "index.json");
    const index = JSON.parse(readFileSync(file, "utf8"));
    index.tool = "something-else";
    writeFileSync(file, JSON.stringify(index));
    sealCache(join(root, "build", "osgo-incr", "live1"));
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /front end changed/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// The interfaces used as reference types are declared in the emitted Go in
// the order the full build's final pass walks them, which is the order the
// lowering first used them. A fast build's own walk sees the cache's
// pre-seed first and the fresh lowering's uses after it: an edited class
// that used an interface BEFORE a cached class used another must still
// declare it first (the real tree: ZIF_STG_SADL_BEHAVIOR and
// IF_SADL_EXIT_CALC_ELEMENT_READ swapped in app.go).
const withRefs = {
  "app/zif_incr_ia.intf.abap": `INTERFACE zif_incr_ia PUBLIC.
  METHODS a RETURNING VALUE(r) TYPE i.
ENDINTERFACE.`,
  "app/zif_incr_ib.intf.abap": `INTERFACE zif_incr_ib PUBLIC.
  METHODS b RETURNING VALUE(r) TYPE i.
ENDINTERFACE.`,
  "app/zcl_incr_e1.clas.abap": `CLASS zcl_incr_e1 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m IMPORTING io TYPE REF TO zif_incr_ia RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_e1 IMPLEMENTATION.
  METHOD m.
    r = io->a( ) + 1.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_incr_e2.clas.abap": `CLASS zcl_incr_e2 DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS m IMPORTING io TYPE REF TO zif_incr_ib RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_e2 IMPLEMENTATION.
  METHOD m.
    r = io->b( ) + 2.
  ENDMETHOD.
ENDCLASS.`,
};

test("the interfaces keep the full build's declaration order when an earlier user is re-lowered", () => {
  const root = tree(withRefs);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_e1.clas.abap", "io->a( ) + 1", "io->a( ) + 3");
    const reference = fullProgram(root);
    const order = [...reference.interfaceMethods.keys()];
    assert.ok(order.indexOf("ZIF_INCR_IA") >= 0 && order.indexOf("ZIF_INCR_IA") < order.indexOf("ZIF_INCR_IB"), `fixture order (${order})`);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, withRefs)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(attempt.lowered.includes("CLAS ZCL_INCR_E1") && !attempt.lowered.includes("CLAS ZCL_INCR_E2"));
    assert.deepEqual([...attempt.program.interfaces], [...reference.interfaces]);
    assert.deepEqual([...attempt.program.interfaceMethods.keys()], order);
    assert.deepEqual([...attempt.program.interfaceAttrs.keys()], [...reference.interfaceAttrs.keys()]);
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// The lists (skipped, partial) are not pre-seeded: a cached object's entries
// come back only through the merge. The real tree refused here first ("the
// merged skipped holds other entries than the fresh build's") once the final
// analyses ran over the merged state; a cached class with a method outside
// the subset must keep its entry, in the full build's place.
test("a cached object's skipped methods stay in the merged list, in order", () => {
  const extra = {
    "app/zcl_incr_aa_skip.clas.abap": `CLASS zcl_incr_aa_skip DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS odd IMPORTING x TYPE decfloat34 RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_aa_skip IMPLEMENTATION.
  METHOD odd.
    r = 1.
  ENDMETHOD.
ENDCLASS.`,
    "app/zcl_incr_zz_skip.clas.abap": `CLASS zcl_incr_zz_skip DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS odd IMPORTING x TYPE utclong RETURNING VALUE(r) TYPE i.
ENDCLASS.
CLASS zcl_incr_zz_skip IMPLEMENTATION.
  METHOD odd.
    r = 1.
  ENDMETHOD.
ENDCLASS.`,
  };
  const root = tree(extra);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'");
    const reference = fullProgram(root);
    assert.equal(reference.skipped.length, 2, `fixture (${reference.skipped})`);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, extra)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(!attempt.lowered.includes("CLAS ZCL_INCR_AA_SKIP"));
    assert.deepEqual(attempt.program.skipped, reference.skipped);
    assert.deepEqual(attempt.program.partial, reference.partial);
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// The emission resolves the constructor DEFAULTs of EVERY class through the
// registry (emit-constructors.ts: CREATE OBJECT ... TYPE (name) passes no
// arguments). A cached class nobody references is outside the closure, so
// its DEFAULT (its own constant) did not resolve and the adapter panicked
// where the full build constructs (the real tree: CL_GUI_DOCKING_CONTAINER).
test("a cached class whose constructor has DEFAULTs keeps its CREATE OBJECT by name", () => {
  const extra = {
    "app/zcl_incr_ctor.clas.abap": `CLASS zcl_incr_ctor DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS co_left TYPE i VALUE 1.
    DATA side TYPE i.
    METHODS constructor IMPORTING iv_side TYPE i DEFAULT co_left iv_ext TYPE i DEFAULT 50.
ENDCLASS.
CLASS zcl_incr_ctor IMPLEMENTATION.
  METHOD constructor.
    side = iv_side + iv_ext.
  ENDMETHOD.
ENDCLASS.`,
  };
  const root = tree(extra);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'");
    const reference = fullProgram(root);
    assert.match(emitted(reference), /return New_ZCL_INCR_CTOR\(s, /);
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, extra)}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.ok(!attempt.lowered.includes("CLAS ZCL_INCR_CTOR"));
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// abaplint enumerates a registry's objects in the order a NAME first
// appeared, and the table pass writes its row types in that order. A
// non-class object the closure dropped (the real tree: the behaviour
// definition ZI_RAP_NOTE in src/, whose view is in gen/) moved a table's
// row type behind the others.
test("every non-class file of the full registry is in the fast one (name order of the table pass)", () => {
  const xmlOf = (name) => xml(`<DD02V><TABNAME>${name}</TABNAME><TABCLASS>TRANSP</TABCLASS></DD02V><DD03P_TABLE>
<DD03P><FIELDNAME>K</FIELDNAME><KEYFLAG>X</KEYFLAG><DATATYPE>CHAR</DATATYPE><LENG>000004</LENG></DD03P>
<DD03P><FIELDNAME>V</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000010</LENG></DD03P></DD03P_TABLE>`);
  const root = tree({
    "early/zincr_tz.nrob.xml": xml(`<V_TNRO><OBJECT>ZINCR_TZ</OBJECT></V_TNRO>`),
    "late/zincr_ta.tabl.xml": xmlOf("ZINCR_TA"),
    "late/zincr_tz.tabl.xml": xmlOf("ZINCR_TZ"),
  });
  const folders = ["early", "app", "late"].map((f) => join(root, f));
  const names = () => [...registryFiles(folders, new Set(), new Set()).values()].map((k) => k.slice(5).toLowerCase());
  try {
    const recorder = incrRecorder({root, folders, hidden: new Set(), objects: names(), includeTests: new Set()});
    const recorded = compileProgram({folders, objects: names(), tolerant: true, includeTests: new Set(), incr: recorder});
    dbCacheWrite(recorder.finish({gen: "live1"}).dir, dbContributions(recorded.reg));
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'Key TravelId missing (edited)'");
    const reference = compileProgram({folders, objects: names(), tolerant: true, includeTests: new Set()});
    const rows = [...reference.structs.keys()].filter((k) => /^ZINCR_T[AZ]$/.test(k));
    assert.deepEqual(rows, ["ZINCR_TZ", "ZINCR_TA"], "the fixture must order the tables by the first appearance of their names");
    const attempt = incrAssemble({root, folders, objects: names(), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(attempt.ok, true, attempt.reason);
    assert.deepEqual([...attempt.program.structs.keys()], [...reference.structs.keys()]);
    assert.equal(emitted(attempt.program), emitted(reference));
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// A TYPES alias of a primitive lowers to the primitive itself: the user's IR
// keeps no name of the class or interface that declares it, and its
// lowering never asks the registry for that object. The dependency is the
// syntax pass's (osgo-incr-deps.mjs); without it the edit re-lowered the
// provider only and the cached user kept `x int32` against the full build's
// `x string`.
for (const [kind, provider, file] of [
  ["class", "app/zcl_incr_aliases.clas.abap", `CLASS zcl_incr_aliases DEFINITION PUBLIC. PUBLIC SECTION. TYPES ty_num TYPE i. ENDCLASS.
CLASS zcl_incr_aliases IMPLEMENTATION. ENDCLASS.`],
  ["interface", "app/zif_incr_aliases.intf.abap", "INTERFACE zif_incr_aliases PUBLIC. TYPES ty_num TYPE i. ENDINTERFACE."],
]) {
  test(`an edit of a ${kind}'s primitive type alias re-lowers the object that uses it`, () => {
    const name = provider.split("/").at(-1).split(".")[0];
    const extra = {[provider]: file,
      "app/zcl_incr_reader.clas.abap": `CLASS zcl_incr_reader DEFINITION PUBLIC. PUBLIC SECTION.
    METHODS run IMPORTING x TYPE ${name}=>ty_num RETURNING VALUE(r) TYPE ${name}=>ty_num.
ENDCLASS.
CLASS zcl_incr_reader IMPLEMENTATION. METHOD run. r = x. ENDMETHOD. ENDCLASS.`};
    const root = tree(extra);
    try {
      writeCache(root);
      edit(root, provider, "ty_num TYPE i", "ty_num TYPE string");
      const reference = fullProgram(root);
      const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
        proof: {ok: true, base: "live1", changed: changedFiles(root, extra)}});
      assert.equal(attempt.ok, true, attempt.reason);
      assert.ok(attempt.lowered.includes("CLAS ZCL_INCR_READER"), `the user re-lowers (${attempt.lowered})`);
      assert.match(emitted(reference), /RUN\(s \*abap\.Session, x string\)/);
      assert.equal(emitted(attempt.program), emitted(reference));
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

test("an edit that makes an earlier object the first reacher of a shared anonymous structure refuses", () => {
  // a1 named zif_incr_msg=>co_err's structure first; a0, earlier in the full
  // build's order, now reaches it too, so the full build names it after a0
  // -- the pinned a1 name would be another generation
  const extra = {...withAnon, "app/zcl_incr_a0.clas.abap": `CLASS zcl_incr_a0 DEFINITION PUBLIC. PUBLIC SECTION. METHODS m RETURNING VALUE(r) TYPE string. ENDCLASS.
CLASS zcl_incr_a0 IMPLEMENTATION. METHOD m. r = 'old'. ENDMETHOD. ENDCLASS.`};
  const root = tree(extra);
  try {
    writeCache(root);
    edit(root, "app/zcl_incr_a0.clas.abap", "r = 'old'.", "DATA e LIKE zif_incr_msg=>co_err. e = zif_incr_msg=>co_err. r = e-msgno.");
    const reference = fullProgram(root);
    assert.ok([...reference.structs.keys()].some((k) => k.startsWith("ZCL_INCR_A0__S_MSGID")), "fixture: the full build names it after a0");
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: changedFiles(root, extra)}});
    assert.ok(!attempt.ok || emitted(attempt.program) === emitted(reference), "a fast build that differs from the full build");
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /first object to reach the anonymous structure/);
  } finally { rmSync(root, {recursive: true, force: true}); }
});

// Incomplete or damaged metadata is a miss of the whole cache (the full
// front end runs), never a partial replay or an abort later on.
for (const [name, damage, reason] of [
  ["the build stopped before the database record (no stamp)", null, /no completion stamp/],
  ["db.json is gone", (dir) => rmSync(join(dir, "db.json")), /no database record/],
  ["db.json does not parse", (dir) => writeFileSync(join(dir, "db.json"), "{"), /stamp does not match/],
  ["index.json is valid JSON null", (dir) => writeFileSync(join(dir, "index.json"), "null"), /stamp does not match/],
  ["index.json is null under a matching stamp", (dir) => { writeFileSync(join(dir, "index.json"), "null"); sealCache(dir); }, /index\.json: it is not an object/],
  ["an entry lost its fields under a matching stamp", (dir) => {
    const index = JSON.parse(readFileSync(join(dir, "index.json"), "utf8"));
    index.entries["CLAS ZCL_INCR_TOP"] = {};
    writeFileSync(join(dir, "index.json"), JSON.stringify(index));
    sealCache(dir);
  }, /entries is not of the recorded shape/],
  ["db.json lost its order under a matching stamp", (dir) => { writeFileSync(join(dir, "db.json"), "{}"); sealCache(dir); }, /db\.json: it is not of the recorded shape/],
]) {
  test(`the cache is a miss when its metadata is incomplete: ${name}`, () => {
    const root = tree();
    try {
      const {written} = writeCache(root, "live1", new Set(), {db: damage !== null});
      if (damage) damage(written.dir);
      edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'x'");
      const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
        proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
      assert.equal(attempt.ok, false);
      assert.match(attempt.reason, reason);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
}

test("a generation written again is not usable until its database record is", () => {
  const root = tree();
  try {
    const {written} = writeCache(root);
    writeCache(root, "live1", new Set(), {db: false}); // the stamp of the first write must not certify the second
    edit(root, "app/zcl_incr_hot.clas.abap", "'Key TravelId missing'", "'x'");
    const attempt = incrAssemble({root, folders: [join(root, "app")], objects: objectNames(root), hidden: new Set(), includeTests: new Set(),
      proof: {ok: true, base: "live1", changed: ["app/zcl_incr_hot.clas.abap"]}});
    assert.equal(attempt.ok, false);
    assert.match(attempt.reason, /no completion stamp/);
    assert.ok(written.dir.endsWith("live1"));
  } finally { rmSync(root, {recursive: true, force: true}); }
});
