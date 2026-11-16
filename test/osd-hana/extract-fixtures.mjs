// The SYNTHETIC fixtures for the extract suite, built at test time into a
// temporary directory: the sidecar's dump layout is tables/*.jsonl and
// reposrc.jsonl, and tracked .jsonl files are refused by the leak scan
// (captures travel as jsonl), so the hand-made data lives HERE and the files
// materialise under the test's tmpdir. Every name is synthetic (ZCL_OSD_X1,
// TESTLOGIN-shaped authors); nothing here was ever read from a database.
import {mkdirSync, readFileSync, writeFileSync, rmSync} from "node:fs";
import {join} from "node:path";

/** Builds the `list` and `dump` fixture directories; returns their paths. */
export function buildExtractFixtures(FIX) {
const D = join(FIX, "dump");
const T = join(D, "tables");
const L = join(FIX, "list");
rmSync(D, {recursive: true, force: true});
rmSync(L, {recursive: true, force: true});
mkdirSync(T, {recursive: true});
mkdirSync(join(D, "src"), {recursive: true});
mkdirSync(L, {recursive: true});
const P = "$OSD_X"; // one top package ...
const PS = "$OSD_X_SUB"; // ... and one subpackage: PREFIX folder logic
const pad = (n) => n.padEnd(30, "=");
const jsonl = (dir, name, rows) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
const abap = (name, body) => {
  writeFileSync(join(D, "src", name), body);
  return `src/${name}`;
};

// ---- sources ---------------------------------------------------------------
const clsCS = abap("ZCL_OSD_X1=====CS.abap",
  "class ZCL_OSD_X1 definition public final create public.\n" +
  "public section.\n" +
  "methods run returning value(r) type i.\n" +
  "endclass.\n" +
  "class ZCL_OSD_X1 implementation.\n" +
  "method run.\n" +
  "r = 1.\n" +
  "endmethod.\n" +
  "endclass.\n");
const intfIU = abap("ZIF_OSD_X2=====IU.abap",
  "interface ZIF_OSD_X2 public.\nconstants co_x type i value 1.\nendinterface.\n");
const progX3 = abap("ZOSD_X3.abap", "REPORT zosd_x3.\nWRITE 'synthetic'.\n");
const progXD = abap("ZOSD_XD.abap", "REPORT zosd_xd.\nWRITE 'never activated'.\n");
const fugrMain = abap("SAPLZOSG_X4.abap", "FUNCTION-POOL zosg_x4.\n");
const fugrTop = abap("LZOSG_X4TOP.abap", "DATA g_x4 TYPE i.\n");
const fugrU01 = abap("LZOSG_X4U01.abap", "FUNCTION z_osd_x4_fm.\n  g_x4 = 1.\nENDFUNCTION.\n");
const fugrUXX = abap("LZOSG_X4UXX.abap", "INCLUDE lzosg_x4u01.\n");
const ddlsXB = "define view entity ZDDL_XB as select from ZTAB_X5 { key mandt, key travel_id }\n";

const tpoolRecord = (id, k, entry, len) => {
  const s = id + k.padEnd(8, " ") + entry.padEnd(len, " ");
  const b = Buffer.alloc(2 + 2 * s.length);
  b.writeUInt16BE(len, 0);
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + 2 * i);
  return "0x" + b.toString("hex");
};

// ---- objects.jsonl ----------------------------------------------------------
const W = "written", S = "skipped";
const file = (path, bytes) => ({path, state: "A", sha256: "0".repeat(64), bytes});
const objects = [
  {type: "CLAS", name: "ZCL_OSD_X1", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: [file(clsCS, 300)]},
  {type: "INTF", name: "ZIF_OSD_X2", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: [file(intfIU, 100)]},
  {type: "PROG", name: "ZOSD_X3", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: [file(progX3, 30)]},
  {type: "FUGR", name: "ZOSG_X4", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: [file(fugrMain, 27), file(fugrTop, 17), file(fugrU01, 76), file(fugrUXX, 22)]},
  {type: "TABL", name: "ZTAB_X5", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "DTEL", name: "ZDTL_X6", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "DOMA", name: "ZDOM_X7", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "TTYP", name: "ZTTY_X8", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "SHLP", name: "ZSHL_X9", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "VIEW", name: "ZVW_XA", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "DDLS", name: "ZDDL_XB", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "TABL", name: "/NS/ZTAB_Y1", package: P, author: "DEVUSER", class: "customer", state: "A", status: W, files: []},
  {type: "PROG", name: "ZOSD_XD", package: P, author: "DEVUSER", class: "customer", state: "I", status: W, files: [{path: progXD, state: "I", sha256: "0".repeat(64), bytes: 30}]},
  {type: "SICF", name: "ZSICF_XC", package: PS, author: "DEVUSER", class: "customer", status: S, reason: "unsupported"},
  {type: "CLAS", name: "ZCL_SAP_XE", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: S, reason: "excluded"},
];
jsonl(D, "objects.jsonl", objects);
jsonl(L, "objects.jsonl", objects);
writeFileSync(join(L, "summary.json"), JSON.stringify({ok: true, objects: objects.length, customer: objects.filter((o) => o.class !== "sap").length, sap: 1, generated: 0, source_bytes_compressed: 2000}));
writeFileSync(join(D, "summary.json"), JSON.stringify({ok: true, objects: objects.length, written: 13, skipped: 2, files: 8, bytes: 600, errors: 0, seconds: 1}));
writeFileSync(join(D, "counts.json"), JSON.stringify({written: 13, skipped: 2, skipped_excluded: 1, skipped_unsupported: 1}));


// a manifest skeleton; the fake sidecar rewrites the sidecar block per run
writeFileSync(join(D, "manifest.json"), JSON.stringify({
  tool: "osd-hana-dump v9.9.9-test", started: "2026-11-16T00:00:00Z", finished: "2026-11-16T00:00:01Z",
  provenance: "synthetic extract fixture", schema: "TESTSCHEMA", inactive: true, catalog: true,
  counts: {package_objects: objects.length, sources: 8},
}, null, 1) + "\n");

// ---- reposrc.jsonl ----------------------------------------------------------
const repoSrc = [
  {program: pad("ZCL_OSD_X1") + "CS", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 9, sha256: "1".repeat(64), file: clsCS},
  {program: pad("ZIF_OSD_X2") + "IU", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 3, sha256: "1".repeat(64), file: intfIU},
  {program: "ZOSD_X3", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file: progX3},
  {program: "ZOSD_XD", state: "I", changed_by: "DEVUSER", changed_on: "20261102", max_line: 0, lines: 2, sha256: "1".repeat(64), file: progXD},
  {program: "SAPLZOSG_X4", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: fugrMain},
  {program: "LZOSG_X4TOP", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: fugrTop},
  {program: "LZOSG_X4U01", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 3, sha256: "1".repeat(64), file: fugrU01},
  {program: "LZOSG_X4UXX", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: fugrUXX},
];
jsonl(D, "reposrc.jsonl", repoSrc);
// the DDL source row (active)
jsonl(T, "DDDDLSRC.jsonl", [{DDLNAME: "ZDDL_XB", AS4LOCAL: "A", SOURCE_TYPE: "V", SOURCE: ddlsXB}]);

// ---- TADIR / TDEVC -----------------------------------------------------------
const tadir = (type, name, pkg, genfl = "", mlang = "E") =>
  ({PGMID: "R3TR", OBJECT: type, OBJ_NAME: name, DEVCLASS: pkg, AUTHOR: "DEVUSER", MASTERLANG: mlang, GENFLAG: genfl, SRCSYSTEM: "SYN"});
jsonl(T, "TADIR.jsonl", [
  tadir("CLAS", "ZCL_OSD_X1", P),
  tadir("INTF", "ZIF_OSD_X2", P),
  tadir("PROG", "ZOSD_X3", P),
  tadir("FUGR", "ZOSG_X4", P),
  tadir("TABL", "ZTAB_X5", P),
  tadir("DTEL", "ZDTL_X6", P),
  tadir("DOMA", "ZDOM_X7", P),
  tadir("TTYP", "ZTTY_X8", P),
  tadir("SHLP", "ZSHL_X9", P),
  tadir("VIEW", "ZVW_XA", P),
  tadir("DDLS", "ZDDL_XB", P),
  tadir("TABL", "/NS/ZTAB_Y1", P),
  tadir("PROG", "ZOSD_XD", P),
  tadir("SICF", "ZSICF_XC", PS),
  tadir("CLAS", "ZCL_SAP_XE", "SAP_PK"),
]);
jsonl(T, "TDEVC.jsonl", [
  {DEVCLASS: P, PARENTCL: "", DLVUNIT: "LOCAL"},
  {DEVCLASS: PS, PARENTCL: P, DLVUNIT: "LOCAL"},
  {DEVCLASS: "SAP_PK", PARENTCL: "", DLVUNIT: "SAP"},
]);

// ---- TRDIR / TFDIR / TLIBG / FUPARAREF / TFTIT --------------------------------
const trdir = (name, subc) => ({NAME: name, SUBC: subc, DBAPL: "S", DBNA: "D$", APPL: "S", FIXPT: "X", LDBNAME: "D$S", UCCHECK: "X"});
jsonl(T, "TRDIR.jsonl", [
  trdir("ZOSD_X3", "1"),
  trdir("SAPLZOSG_X4", "F"),
  trdir("LZOSG_X4TOP", "I"),
  trdir("ZOSD_XD", "1"),
]);
jsonl(T, "TFDIR.jsonl", [{FUNCNAME: "Z_OSD_X4_FM", PNAME: "SAPLZOSG_X4", PNAME_MAIN: "", INCLUDE: "01", FMODE: "", UTASK: ""}]);
jsonl(T, "TLIBG.jsonl", [{AREA: "ZOSG_X4", UNAME: "DEVUSER"}]);
jsonl(T, "FUPARAREF.jsonl", [
  {FUNCNAME: "Z_OSD_X4_FM", R3STATE: "A", PARAMETER: "IV_IN", PARAMTYPE: "I", PPOSITION: "1", STRUCTURE: "ZTAB_X5-TRAVEL_ID", DEFAULTVAL: "", OPTIONAL: "X", REFERENCE: "", TYPE: "", REF_CLASS: ""},
]);
jsonl(T, "TFTIT.jsonl", [{FUNCNAME: "Z_OSD_X4_FM", SPRAS: "E", STEXT: "Synthetic function"}]);

// ---- SEOCLASSDF / SEOCLASSTX / REPOTEXT ----------------------------------------
jsonl(T, "SEOCLASSDF.jsonl", [
  {CLSNAME: "ZCL_OSD_X1", VERSION: "1", CLSCCINCL: "X", FIXPT: "X", UNICODE: "X", WITH_UNIT_TESTS: "", MSG_ID: ""},
  {CLSNAME: "ZIF_OSD_X2", VERSION: "1", EXPOSURE: "2", UNICODE: "X"},
]);
jsonl(T, "SEOCLASSTX.jsonl", [
  {CLSNAME: "ZCL_OSD_X1", LANGU: "E", DESCRIPT: "Synthetic extract class"},
  {CLSNAME: "ZIF_OSD_X2", LANGU: "E", DESCRIPT: "Synthetic extract interface"},
]);
jsonl(T, "REPOTEXT.jsonl", [
  {PROGNAME: "ZOSD_X3", LANGUAGE: "E", R3STATE: "A", DATA: tpoolRecord("I", "001", "Synthetic prog text", 19)},
  {PROGNAME: pad("ZCL_OSD_X1") + "CP", LANGUAGE: "E", R3STATE: "A", DATA: tpoolRecord("I", "A01", "Synthetic label", 15)},
]);

// ---- DDIC ------------------------------------------------------------------------
jsonl(T, "DD02L.jsonl", [
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", TABCLASS: "TRANSP", CLIDEP: "X", DDTEXT: "Synthetic table", MAINFLAG: "X", CONTFLAG: "A", EXCLASS: "1"},
  {TABNAME: "/NS/ZTAB_Y1", AS4LOCAL: "A", TABCLASS: "TRANSP", CLIDEP: "X", DDTEXT: "Namespaced synthetic", CONTFLAG: "A"},
]);
jsonl(T, "DD02T.jsonl", [
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic table"},
  {TABNAME: "/NS/ZTAB_Y1", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Namespaced synthetic"},
]);
jsonl(T, "DD09L.jsonl", [{TABNAME: "ZTAB_X5", AS4LOCAL: "A", TABKAT: "0", TABART: "APPL1", BUFALLOW: "N", ROWORCOLST: "C"}]);
jsonl(T, "DD03L.jsonl", [
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", FIELDNAME: "MANDT", POSITION: "0001", KEYFLAG: "X", ROLLNAME: "MANDT", COMPTYPE: "E", ADMINFIELD: "0", DEPTH: "00"},
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", FIELDNAME: "TRAVEL_ID", POSITION: "0002", KEYFLAG: "X", ADMINFIELD: "0", INTTYPE: "C", INTLEN: "000016", NOTNULL: "X", DATATYPE: "CHAR", LENG: "000008", DEPTH: "00"},
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", FIELDNAME: "STATUS", POSITION: "0003", ROLLNAME: "ZDTL_X6", COMPTYPE: "E", ADMINFIELD: "0", DEPTH: "00"},
  {TABNAME: "/NS/ZTAB_Y1", AS4LOCAL: "A", FIELDNAME: "MANDT", POSITION: "0001", KEYFLAG: "X", ROLLNAME: "MANDT", COMPTYPE: "E", ADMINFIELD: "0", DEPTH: "00"},
  {TABNAME: "/NS/ZTAB_Y1", AS4LOCAL: "A", FIELDNAME: "ID", POSITION: "0002", KEYFLAG: "X", ADMINFIELD: "0", INTTYPE: "C", INTLEN: "000010", DATATYPE: "CHAR", LENG: "000005", DEPTH: "00"},
]);
jsonl(T, "DD04L.jsonl", [{ROLLNAME: "ZDTL_X6", AS4LOCAL: "A", DOMNAME: "ZDOM_X7", HEADLEN: "10", SCRLEN1: "10", SCRLEN2: "15", SCRLEN3: "20", DDTEXT: "Synthetic element", REPTEXT: "Element", SCRTEXT_S: "Elem", SCRTEXT_M: "Element", SCRTEXT_L: "Element long", DTELMASTER: "E", DATATYPE: "CHAR", LENG: "000001", OUTPUTLEN: "000001"}]);
jsonl(T, "DD04T.jsonl", [{ROLLNAME: "ZDTL_X6", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic element"}]);
jsonl(T, "DD01L.jsonl", [{DOMNAME: "ZDOM_X7", AS4LOCAL: "A", DATATYPE: "CHAR", LENG: "000001", OUTPUTLEN: "000001", VALEXI: "X", DDTEXT: "Synthetic domain"}]);
jsonl(T, "DD01T.jsonl", [{DOMNAME: "ZDOM_X7", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic domain"}]);
jsonl(T, "DD07L.jsonl", [
  {DOMNAME: "ZDOM_X7", AS4LOCAL: "A", VALPOS: "0001", DOMVALUE_L: "A"},
  {DOMNAME: "ZDOM_X7", AS4LOCAL: "A", VALPOS: "0002", DOMVALUE_L: "B"},
]);
jsonl(T, "DD07T.jsonl", [{DOMNAME: "ZDOM_X7", AS4LOCAL: "A", VALPOS: "0001", DDLANGUAGE: "E", DDTEXT: "Alpha"}]);
jsonl(T, "DD40L.jsonl", [{TYPENAME: "ZTTY_X8", AS4LOCAL: "A", ROWTYPE: "ZTAB_X5", ROWKIND: "S", DATATYPE: "STRU", ACCESSMODE: "T", KEYDEF: "D", KEYKIND: "N", DDTEXT: "Synthetic rows"}]);
jsonl(T, "DD40T.jsonl", [{TYPENAME: "ZTTY_X8", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic rows"}]);
jsonl(T, "DD30L.jsonl", [{SHLPNAME: "ZSHL_X9", AS4LOCAL: "A", ISSIMPLE: "X", SELMTYPE: "T", SELMETHOD: "ZTAB_X5", DIALOGTYPE: "D"}]);
jsonl(T, "DD30T.jsonl", [{SHLPNAME: "ZSHL_X9", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic help"}]);
jsonl(T, "DD32S.jsonl", [{SHLPNAME: "ZSHL_X9", AS4LOCAL: "A", FIELDNAME: "TRAVEL_ID", FLPOSITION: "0001", ROLLNAME: "ZDTL_X6", SHLPINPUT: "X", SHLPOUTPUT: "X", SHLPSELPOS: "01", SHLPLISPOS: "01"}]);
jsonl(T, "DD25L.jsonl", [{VIEWNAME: "ZVW_XA", AS4LOCAL: "A", AGGTYPE: "V", ROOTTAB: "ZTAB_X5", VIEWCLASS: "D", DDTEXT: "Synthetic view"}]);
jsonl(T, "DD25T.jsonl", [{VIEWNAME: "ZVW_XA", AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "Synthetic view"}]);
jsonl(T, "DD26S.jsonl", [{VIEWNAME: "ZVW_XA", AS4LOCAL: "A", TABNAME: "ZTAB_X5", TABPOS: "0001", FORTABNAME: "ZTAB_X5"}]);
jsonl(T, "DD27S.jsonl", [
  {VIEWNAME: "ZVW_XA", AS4LOCAL: "A", OBJPOS: "0001", VIEWFIELD: "MANDT", TABNAME: "ZTAB_X5", FIELDNAME: "MANDT", ROLLNAME: "MANDT", KEYFLAG: "X"},
  {VIEWNAME: "ZVW_XA", AS4LOCAL: "A", OBJPOS: "0002", VIEWFIELD: "TRAVEL_ID", TABNAME: "ZTAB_X5", FIELDNAME: "TRAVEL_ID", ROLLNAME: "ZDTL_X6", KEYFLAG: "X"},
]);
jsonl(T, "DD28S.jsonl", []);
jsonl(T, "DD31S.jsonl", []);
jsonl(T, "DD33S.jsonl", []);
// foreign keys ARE in the dump shape (DD05S/DD08L); the converter does not
// write them -- the TABL part lines name them as "not extracted" (fix round 2)
jsonl(T, "DD05S.jsonl", [
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", FIELDNAME: "TRAVEL_ID", CHECKTABLE: "ZTAB_X5", FRKART: "KEY", NOBYTES: "", SEMKEY: ""},
]);
jsonl(T, "DD08L.jsonl", [
  {TABNAME: "ZTAB_X5", AS4LOCAL: "A", CHECKTABLE: "ZTAB_X5", FRKART: "KEY", ARBGB: ""},
]);

  return {list: L, dump: D};
}

/** Appends a NAMESPACED function group /NS/GRP_Y2 to built fixtures -- the
 *  round-5 golden case (SHOULD-2): its main program is /NS/SAPLGRP_Y2 and its
 *  includes are /NS/LGRP_Y2TOP and /NS/LGRP_Y2U01 (a function Z_OSD_Y2_FM
 *  lives in the U01 include). The base fixtures stay byte-identical; only the
 *  tests that ask for the namespaced group pay for it. */
export function addNamespacedFunctionGroup({list, dump}) {
  const T = join(dump, "tables");
  const readJsonl = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const appendJsonl = (dir, name, rows) => writeFileSync(join(dir, name), readJsonl(dir, name).concat(rows).map((r) => JSON.stringify(r)).join("\n") + "\n");
  const P = "$OSD_X";
  const objFile = (path, bytes) => ({path, state: "A", sha256: "0".repeat(64), bytes});
  mkdirSync(join(dump, "src", "NS"), {recursive: true});
  const abap = (name, body) => {
    writeFileSync(join(dump, "src", name), body);
    return `src/${name}`;
  };
  const mainSrc = abap("/NS/SAPLGRP_Y2.abap", "FUNCTION-POOL nsgrp_y2.\n");
  const topSrc = abap("/NS/LGRP_Y2TOP.abap", "DATA g_y2 TYPE i.\n");
  const u01Src = abap("/NS/LGRP_Y2U01.abap", "FUNCTION z_osd_y2_fm.\n  g_y2 = 1.\nENDFUNCTION.\n");
  const objects = [
    {type: "FUGR", name: "/NS/GRP_Y2", package: P, author: "DEVUSER", class: "customer", state: "A", status: "W",
      files: [objFile(mainSrc, mainSrc.length), objFile(topSrc, topSrc.length), objFile(u01Src, u01Src.length)]},
  ];
  appendJsonl(dump, "objects.jsonl", objects);
  appendJsonl(list, "objects.jsonl", objects);
  appendJsonl(dump, "reposrc.jsonl", [
    {program: "/NS/SAPLGRP_Y2", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: mainSrc},
    {program: "/NS/LGRP_Y2TOP", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: topSrc},
    {program: "/NS/LGRP_Y2U01", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 3, sha256: "1".repeat(64), file: u01Src},
  ]);
  const tadir = (type, name) => ({PGMID: "R3TR", OBJECT: type, OBJ_NAME: name, DEVCLASS: P, AUTHOR: "DEVUSER", MASTERLANG: "E", GENFLAG: "", SRCSYSTEM: "SYN"});
  appendJsonl(T, "TADIR.jsonl", [tadir("FUGR", "/NS/GRP_Y2")]);
  appendJsonl(T, "TRDIR.jsonl", [
    {NAME: "/NS/SAPLGRP_Y2", SUBC: "F", DBAPL: "S", DBNA: "D$", APPL: "S", FIXPT: "X", LDBNAME: "D$S", UCCHECK: "X"},
    {NAME: "/NS/LGRP_Y2TOP", SUBC: "I", DBAPL: "S", DBNA: "D$", APPL: "S", FIXPT: "X", LDBNAME: "D$S", UCCHECK: "X"},
  ]);
  appendJsonl(T, "TFDIR.jsonl", [{FUNCNAME: "Z_OSD_Y2_FM", PNAME: "/NS/SAPLGRP_Y2", PNAME_MAIN: "", INCLUDE: "01", FMODE: "", UTASK: ""}]);
  appendJsonl(T, "TLIBG.jsonl", [{AREA: "/NS/GRP_Y2", UNAME: "DEVUSER"}]);
  appendJsonl(T, "FUPARAREF.jsonl", [
    {FUNCNAME: "Z_OSD_Y2_FM", R3STATE: "A", PARAMETER: "IV_Y", PARAMTYPE: "I", PPOSITION: "1", STRUCTURE: "ZTAB_X5-TRAVEL_ID", DEFAULTVAL: "", OPTIONAL: "", REFERENCE: "", TYPE: "", REF_CLASS: ""},
  ]);
  appendJsonl(T, "TFTIT.jsonl", [{FUNCNAME: "Z_OSD_Y2_FM", SPRAS: "E", STEXT: "Namespaced synthetic function"}]);
}

/** Appends TWO function groups whose names are prefixes of each other --
 *  `<ns>ZA` and `<ns>ZAU` (fix round 6, CRITIC round 4 MUST-2) -- to built
 *  fixtures. Their includes overlap by shape: ZA's are LZA + 3 characters
 *  (LZATOP, LZAU01, LZAUXX), ZAU's are LZAU + 3 (LZAUTOP, LZAUU01,
 *  LZAUUXX), so a 4-character split of ZAU's would hand them to ZA. Both
 *  groups are in the dump; the LISTING decides which one is in scope:
 *  `inScope` is "ZA" or "ZAU", the other is listed as the vendor's (class
 *  sap -- excluded without --include-sap) and its sources carry a marker
 *  line ("SIBLING_SECRET") that must never reach the repository. */
export function addSiblingFunctionGroups({list, dump}, {ns = "", inScope = "ZA"} = {}) {
  const T = join(dump, "tables");
  const readJsonl = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const appendJsonl = (dir, name, rows) => writeFileSync(join(dir, name), readJsonl(dir, name).concat(rows).map((r) => JSON.stringify(r)).join("\n") + "\n");
  const P = "$OSD_X";
  const objFile = (path, bytes) => ({path, state: "A", sha256: "0".repeat(64), bytes});
  if (ns) mkdirSync(join(dump, "src", ns), {recursive: true});
  const abap = (name, body) => {
    writeFileSync(join(dump, "src", name), body);
    return `src/${name}`;
  };
  const trdirRow = (name, subc) => ({NAME: name, SUBC: subc, DBAPL: "S", DBNA: "D$", APPL: "S", FIXPT: "X", LDBNAME: "D$S", UCCHECK: "X"});
  const srcRow = (program, file) => ({program, state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file});
  const listedRows = [];
  const dumpRows = [];
  for (const g of ["ZA", "ZAU"]) {
    const own = g === inScope;
    const group = `${ns}${g}`;
    const tag = own ? `own ${g}` : "SIBLING_SECRET";
    const main = `${ns}SAPL${g}`;
    const inc = `${ns}L${g}`;
    const fm = `Z_${g}_FM`;
    const files = [
      [main, abap(`${main}.abap`, `FUNCTION-POOL ${g.toLowerCase()}. "${tag}\n`)],
      [`${inc}TOP`, abap(`${inc}TOP.abap`, `DATA g_${g.toLowerCase()} TYPE i. "${tag}\n`)],
      [`${inc}U01`, abap(`${inc}U01.abap`, `FUNCTION ${fm.toLowerCase()}. "${tag}\nENDFUNCTION.\n`)],
    ];
    const row = {type: "FUGR", name: group, package: own ? P : "SAP_PK", author: own ? "DEVUSER" : "SAP", class: own ? "customer" : "sap", state: "A", status: "W",
      files: files.map(([, f]) => objFile(f, 40))};
    listedRows.push(row);
    dumpRows.push(row);
    appendJsonl(dump, "reposrc.jsonl", files.map(([p, f]) => srcRow(p, f)));
    appendJsonl(T, "TADIR.jsonl", [{PGMID: "R3TR", OBJECT: "FUGR", OBJ_NAME: group, DEVCLASS: own ? P : "SAP_PK", AUTHOR: own ? "DEVUSER" : "SAP", MASTERLANG: "E", GENFLAG: "", SRCSYSTEM: "SYN"}]);
    appendJsonl(T, "TRDIR.jsonl", [trdirRow(main, "F"), trdirRow(`${inc}TOP`, "I")]);
    appendJsonl(T, "TFDIR.jsonl", [{FUNCNAME: fm, PNAME: main, PNAME_MAIN: "", INCLUDE: "01", FMODE: "", UTASK: ""}]);
    appendJsonl(T, "TLIBG.jsonl", [{AREA: group, UNAME: own ? "DEVUSER" : "SAP"}]);
    appendJsonl(T, "TFTIT.jsonl", [{FUNCNAME: fm, SPRAS: "E", STEXT: `Synthetic ${g}`}]);
  }
  appendJsonl(dump, "objects.jsonl", dumpRows);
  appendJsonl(list, "objects.jsonl", listedRows);
}
