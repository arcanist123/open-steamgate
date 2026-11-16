// The `osd hana extract` suite, against fakes only (no network, no database):
// the FAKE sidecar serves `list` and `dump` from SYNTHETIC fixture
// directories (test/osd-hana/fixtures/ -- hand-made names like ZCL_OSD_X1,
// nothing ever read from a real system), spawned exactly like the real Go
// binary.
//
// Every guard has a named mutation behind it (listed next to the test); the
// suite goes RED when the guard is removed.
import {expect} from "chai";
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {extractMain} from "../tools/osd-hana/extract.mjs";
import {reusableDump, inGitTree} from "../tools/osd-hana/extract.mjs";
import {decideFolderLogic, folderPaths} from "../tools/osd-hana/convert/convert.mjs";
import {targetKey} from "../tools/osd-hana/sidecar.mjs";
import {buildExtractFixtures} from "./osd-hana/extract-fixtures.mjs";

const FAKE_SIDECAR = fileURLToPath(new URL("./osd-hana/fake-sidecar.mjs", import.meta.url));
const PASSWORD = "correct-horse-battery-staple-42";
const USER = "TESTLOGIN";
const HOST = "hana.example.test";
const SCHEMA = "TE" + "STSCHEMA"; // a fixture name, deliberately not any real one

const BOM = "\uFEFF";
const abapgit = (body, serializer) =>
  `${BOM}<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0"${serializer ? ` serializer="${serializer}" serializer_version="v1.0.0"` : ""}>\n <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n${body}  </asx:values>\n </asx:abap>\n</abapGit>\n`;

// ---- golden files (hand-written, abapGit's own layout: BOM, one element per
// line, one space per depth; abapGit's own tracked files are the oracle) ----
const GOLDEN_DOT_ABAPGIT = `${BOM}<?xml version="1.0" encoding="utf-8"?>\n<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n <asx:values>\n  <DATA>\n   <MASTER_LANGUAGE>E</MASTER_LANGUAGE>\n   <STARTING_FOLDER>/src/</STARTING_FOLDER>\n   <FOLDER_LOGIC>PREFIX</FOLDER_LOGIC>\n  </DATA>\n </asx:values>\n</asx:abap>\n`;
const GOLDEN_CLAS_ABAP = "class ZCL_OSD_X1 definition public final create public.\npublic section.\nmethods run returning value(r) type i.\nendclass.\nclass ZCL_OSD_X1 implementation.\nmethod run.\nr = 1.\nendmethod.\nendclass.\n";
const GOLDEN_CLAS_XML = abapgit(
  `   <VSEOCLASS>\n    <CLSNAME>ZCL_OSD_X1</CLSNAME>\n    <LANGU>E</LANGU>\n    <DESCRIPT>Synthetic extract class</DESCRIPT>\n    <STATE>1</STATE>\n    <CLSCCINCL>X</CLSCCINCL>\n    <FIXPT>X</FIXPT>\n    <UNICODE>X</UNICODE>\n   </VSEOCLASS>\n   <TPOOL>\n    <item>\n     <ID>I</ID>\n     <KEY>A01</KEY>\n     <ENTRY>Synthetic label</ENTRY>\n     <LENGTH>15</LENGTH>\n    </item>\n   </TPOOL>\n`,
  "LCL_OBJECT_CLAS");
const GOLDEN_INTF_ABAP = "interface ZIF_OSD_X2 public.\nconstants co_x type i value 1.\nendinterface.\n";
const GOLDEN_INTF_XML = abapgit(
  `   <VSEOINTERF>\n    <CLSNAME>ZIF_OSD_X2</CLSNAME>\n    <LANGU>E</LANGU>\n    <DESCRIPT>Synthetic extract interface</DESCRIPT>\n    <EXPOSURE>2</EXPOSURE>\n    <STATE>1</STATE>\n    <UNICODE>X</UNICODE>\n   </VSEOINTERF>\n`,
  "LCL_OBJECT_INTF");
const GOLDEN_PROG_ABAP = "REPORT zosd_x3.\nWRITE 'synthetic'.\n";
const GOLDEN_PROG_XML = abapgit(
  `   <PROGDIR>\n    <NAME>ZOSD_X3</NAME>\n    <DBAPL>S</DBAPL>\n    <DBNA>D$</DBNA>\n    <SUBC>1</SUBC>\n    <APPL>S</APPL>\n    <FIXPT>X</FIXPT>\n    <LDBNAME>D$S</LDBNAME>\n    <UCCHECK>X</UCCHECK>\n   </PROGDIR>\n   <TPOOL>\n    <item>\n     <ID>I</ID>\n     <KEY>001</KEY>\n     <ENTRY>Synthetic prog text</ENTRY>\n     <LENGTH>19</LENGTH>\n    </item>\n   </TPOOL>\n`,
  "LCL_OBJECT_PROG");
const GOLDEN_TABL_XML = abapgit(
  `   <DD02V>\n    <TABNAME>ZTAB_X5</TABNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <TABCLASS>TRANSP</TABCLASS>\n    <CLIDEP>X</CLIDEP>\n    <DDTEXT>Synthetic table</DDTEXT>\n    <MAINFLAG>X</MAINFLAG>\n    <CONTFLAG>A</CONTFLAG>\n    <EXCLASS>1</EXCLASS>\n   </DD02V>\n   <DD09L>\n    <TABNAME>ZTAB_X5</TABNAME>\n    <AS4LOCAL>A</AS4LOCAL>\n    <TABKAT>0</TABKAT>\n    <TABART>APPL1</TABART>\n    <BUFALLOW>N</BUFALLOW>\n   </DD09L>\n   <DD03P_TABLE>\n    <DD03P>\n     <FIELDNAME>MANDT</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n     <ROLLNAME>MANDT</ROLLNAME>\n     <ADMINFIELD>0</ADMINFIELD>\n     <COMPTYPE>E</COMPTYPE>\n    </DD03P>\n    <DD03P>\n     <FIELDNAME>TRAVEL_ID</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n     <ADMINFIELD>0</ADMINFIELD>\n     <INTTYPE>C</INTTYPE>\n     <INTLEN>000016</INTLEN>\n     <NOTNULL>X</NOTNULL>\n     <DATATYPE>CHAR</DATATYPE>\n     <LENG>000008</LENG>\n    </DD03P>\n    <DD03P>\n     <FIELDNAME>STATUS</FIELDNAME>\n     <ROLLNAME>ZDTL_X6</ROLLNAME>\n     <ADMINFIELD>0</ADMINFIELD>\n     <COMPTYPE>E</COMPTYPE>\n    </DD03P>\n   </DD03P_TABLE>\n`,
  "LCL_OBJECT_TABL");
const GOLDEN_DTEL_XML = abapgit(
  `   <DD04V>\n    <ROLLNAME>ZDTL_X6</ROLLNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <DOMNAME>ZDOM_X7</DOMNAME>\n    <HEADLEN>10</HEADLEN>\n    <SCRLEN1>10</SCRLEN1>\n    <SCRLEN2>15</SCRLEN2>\n    <SCRLEN3>20</SCRLEN3>\n    <DDTEXT>Synthetic element</DDTEXT>\n    <REPTEXT>Element</REPTEXT>\n    <SCRTEXT_S>Elem</SCRTEXT_S>\n    <SCRTEXT_M>Element</SCRTEXT_M>\n    <SCRTEXT_L>Element long</SCRTEXT_L>\n    <DTELMASTER>E</DTELMASTER>\n    <DATATYPE>CHAR</DATATYPE>\n    <LENG>000001</LENG>\n    <OUTPUTLEN>000001</OUTPUTLEN>\n   </DD04V>\n`,
  "LCL_OBJECT_DTEL");
const GOLDEN_DOMA_XML = abapgit(
  `   <DD01V>\n    <DOMNAME>ZDOM_X7</DOMNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <DATATYPE>CHAR</DATATYPE>\n    <LENG>000001</LENG>\n    <OUTPUTLEN>000001</OUTPUTLEN>\n    <VALEXI>X</VALEXI>\n    <DDTEXT>Synthetic domain</DDTEXT>\n   </DD01V>\n   <DD07V_TAB>\n    <DD07V>\n     <DOMNAME>ZDOM_X7</DOMNAME>\n     <VALPOS>0001</VALPOS>\n     <DDLANGUAGE>E</DDLANGUAGE>\n     <DOMVALUE_L>A</DOMVALUE_L>\n     <DDTEXT>Alpha</DDTEXT>\n    </DD07V>\n    <DD07V>\n     <DOMNAME>ZDOM_X7</DOMNAME>\n     <VALPOS>0002</VALPOS>\n     <DDLANGUAGE>E</DDLANGUAGE>\n     <DOMVALUE_L>B</DOMVALUE_L>\n    </DD07V>\n   </DD07V_TAB>\n`,
  "LCL_OBJECT_DOMA");
const GOLDEN_TTYP_XML = abapgit(
  `   <DD40V>\n    <TYPENAME>ZTTY_X8</TYPENAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <ROWTYPE>ZTAB_X5</ROWTYPE>\n    <ROWKIND>S</ROWKIND>\n    <DATATYPE>STRU</DATATYPE>\n    <ACCESSMODE>T</ACCESSMODE>\n    <KEYDEF>D</KEYDEF>\n    <KEYKIND>N</KEYKIND>\n    <DDTEXT>Synthetic rows</DDTEXT>\n   </DD40V>\n`,
  "LCL_OBJECT_TTYP");
const GOLDEN_SHLP_XML = abapgit(
  `   <DD30V>\n    <SHLPNAME>ZSHL_X9</SHLPNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <DDTEXT>Synthetic help</DDTEXT>\n    <ISSIMPLE>X</ISSIMPLE>\n    <SELMETHOD>ZTAB_X5</SELMETHOD>\n    <SELMTYPE>T</SELMTYPE>\n    <DIALOGTYPE>D</DIALOGTYPE>\n   </DD30V>\n   <DD32P_TABLE>\n    <DD32P>\n     <SHLPNAME>ZSHL_X9</SHLPNAME>\n     <FIELDNAME>TRAVEL_ID</FIELDNAME>\n     <FLPOSITION>0001</FLPOSITION>\n     <ROLLNAME>ZDTL_X6</ROLLNAME>\n     <SHLPINPUT>X</SHLPINPUT>\n     <SHLPOUTPUT>X</SHLPOUTPUT>\n     <SHLPSELPOS>01</SHLPSELPOS>\n     <SHLPLISPOS>01</SHLPLISPOS>\n    </DD32P>\n   </DD32P_TABLE>\n`,
  "LCL_OBJECT_SHLP");
const GOLDEN_VIEW_XML = abapgit(
  `   <DD25V>\n    <VIEWNAME>ZVW_XA</VIEWNAME>\n    <AS4LOCAL>A</AS4LOCAL>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <AGGTYPE>V</AGGTYPE>\n    <ROOTTAB>ZTAB_X5</ROOTTAB>\n    <DDTEXT>Synthetic view</DDTEXT>\n    <VIEWCLASS>D</VIEWCLASS>\n   </DD25V>\n   <DD26V_TABLE>\n    <DD26V>\n     <VIEWNAME>ZVW_XA</VIEWNAME>\n     <TABNAME>ZTAB_X5</TABNAME>\n     <TABPOS>0001</TABPOS>\n     <FORTABNAME>ZTAB_X5</FORTABNAME>\n    </DD26V>\n   </DD26V_TABLE>\n   <DD27P_TABLE>\n    <DD27P>\n     <VIEWFIELD>MANDT</VIEWFIELD>\n     <TABNAME>ZTAB_X5</TABNAME>\n     <FIELDNAME>MANDT</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n    </DD27P>\n    <DD27P>\n     <VIEWFIELD>TRAVEL_ID</VIEWFIELD>\n     <TABNAME>ZTAB_X5</TABNAME>\n     <FIELDNAME>TRAVEL_ID</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n     <VALEXI>X</VALEXI>\n    </DD27P>\n   </DD27P_TABLE>\n`,
  "LCL_OBJECT_VIEW");
const GOLDEN_DDLS_ABAP = "define view entity ZDDL_XB as select from ZTAB_X5 { key mandt, key travel_id }\n";
const GOLDEN_DDLS_XML = abapgit(
  `   <DDLS>\n    <DDLNAME>ZDDL_XB</DDLNAME>\n    <LANGU>E</LANGU>\n    <SOURCE_TYPE>V</SOURCE_TYPE>\n   </DDLS>\n`,
  "LCL_OBJECT_DDLS");
const GOLDEN_NS_TABL_XML = abapgit(
  `   <DD02V>\n    <TABNAME>/NS/ZTAB_Y1</TABNAME>\n    <DDLANGUAGE>E</DDLANGUAGE>\n    <TABCLASS>TRANSP</TABCLASS>\n    <CLIDEP>X</CLIDEP>\n    <DDTEXT>Namespaced synthetic</DDTEXT>\n    <CONTFLAG>A</CONTFLAG>\n   </DD02V>\n   <DD03P_TABLE>\n    <DD03P>\n     <FIELDNAME>MANDT</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n     <ROLLNAME>MANDT</ROLLNAME>\n     <ADMINFIELD>0</ADMINFIELD>\n     <COMPTYPE>E</COMPTYPE>\n    </DD03P>\n    <DD03P>\n     <FIELDNAME>ID</FIELDNAME>\n     <KEYFLAG>X</KEYFLAG>\n     <ADMINFIELD>0</ADMINFIELD>\n     <INTTYPE>C</INTTYPE>\n     <INTLEN>000010</INTLEN>\n     <DATATYPE>CHAR</DATATYPE>\n     <LENG>000005</LENG>\n    </DD03P>\n   </DD03P_TABLE>\n`,
  "LCL_OBJECT_TABL");
const GOLDEN_FUGR_XML = abapgit(
  `   <FUGR>\n    <INCLUDES>\n     <SOBJ_NAME>LZOSG_X4TOP</SOBJ_NAME>\n     <SOBJ_NAME>SAPLZOSG_X4</SOBJ_NAME>\n    </INCLUDES>\n    <FUNCTIONS>\n     <item>\n      <FUNCNAME>Z_OSD_X4_FM</FUNCNAME>\n      <SHORT_TEXT>Synthetic function</SHORT_TEXT>\n      <IMPORT>\n       <RSIMP>\n        <PARAMETER>IV_IN</PARAMETER>\n        <DBFIELD>ZTAB_X5-TRAVEL_ID</DBFIELD>\n        <OPTIONAL>X</OPTIONAL>\n       </RSIMP>\n      </IMPORT>\n     </item>\n    </FUNCTIONS>\n   </FUGR>\n`,
  "LCL_OBJECT_FUGR");
const GOLDEN_INCLUDE_XML = abapgit(
  `   <PROGDIR>\n    <NAME>SAPLZOSG_X4</NAME>\n    <DBAPL>S</DBAPL>\n    <DBNA>D$</DBNA>\n    <SUBC>F</SUBC>\n    <APPL>S</APPL>\n    <FIXPT>X</FIXPT>\n    <LDBNAME>D$S</LDBNAME>\n    <UCCHECK>X</UCCHECK>\n   </PROGDIR>\n`);
const GOLDEN_FUGR_FM_ABAP = "FUNCTION z_osd_x4_fm.\n  g_x4 = 1.\nENDFUNCTION.\n";

// ---------------------------------------------------------------- fixtures

let root;
let fakePath;
let pinPath;
let recordPath;

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makePin() {
  const path = join(root, `pin-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40),
    schema: 1, read_only: true, targets: {[targetKey()]: sha256(fakePath)},
  }));
  return path;
}

async function runExtract(argv, {env = {}, out} = {}) {
  const from = recordLines().length;
  const lines = {out: [], err: [], from};
  const io = {out: (l) => lines.out.push(l), err: (l) => lines.err.push(l)};
  const runEnv = {
    ...process.env,
    OSD_HANA_DUMP: fakePath,
    OSD_HANA_PASSWORD: PASSWORD,
    ...env,
  };
  const code = await extractMain([
    "--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA,
    "--sidecar-pin", pinPath,
  ].concat(argv), {
    io,
    env: runEnv,
    stdin: {isTTY: false},
    isTTY: false,
    sidecarTimeoutMs: 500,
    // the FAKE sidecar's scenario knobs reach the child only through the
    // seam: since the fix round the child env is the core's minimal
    // allowlist (critic S-2) -- the parent's environment never leaks in
    sidecarExtraEnv: {
      FAKE_SIDECAR_RECORD: recordPath,
      FAKE_SIDECAR_LIST: LIST_FIXTURE,
      FAKE_SIDECAR_DUMP: DUMP_FIXTURE,
      ...env,
    },
  });
  return {code, lines, out, runs: () => sidecarRuns(from)};
}

const recordLines = () => {
  try {
    return readFileSync(recordPath, "utf8").split("\n").filter((l) => l.trim());
  } catch {
    return [];
  }
};
const sidecarRuns = (from = 0) => recordLines().slice(from).map((l) => JSON.parse(l).argv[0]);
const requestOf = (out) => JSON.parse(readFileSync(join(out, ".osd-hana", "request.json"), "utf8"));
const reportOf = (out) => JSON.parse(readFileSync(join(out, "extract-report.json"), "utf8"));

let LIST_FIXTURE;
let DUMP_FIXTURE;

before(function () {
  root = mkdtempSync(join(tmpdir(), "osd-hana-extract-test-"));
  ({list: LIST_FIXTURE, dump: DUMP_FIXTURE} = buildExtractFixtures(join(root, "fixtures")));
  fakePath = join(root, "fake-sidecar");
  copyFileSync(FAKE_SIDECAR, fakePath);
  chmodSync(fakePath, 0o755);
  pinPath = makePin();
  recordPath = join(root, "record.ndjson");
});

after(function () {
  rmSync(root, {recursive: true, force: true});
});

async function fresh(name) {
  const out = join(root, name);
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  return out;
}

// ---------------------------------------------------------------- tests

describe("osd hana extract", function () {

  it("writes one abapGit file set per supported type, byte-identical to the goldens (mutation: BOM dropped, namespace mapping)", async function () {
    const out = await fresh("golden");
    const r = await runExtract(["--out", out]);
    expect(r.code, r.lines.err.join("\n")).to.equal(3); // the SICF is unsupported: partial
    const read = (name) => readFileSync(join(out, name), "utf8");
    expect(read(".abapgit.xml")).to.equal(GOLDEN_DOT_ABAPGIT);
    expect(read("src/osd_x/zcl_osd_x1.clas.abap")).to.equal(GOLDEN_CLAS_ABAP);
    expect(read("src/osd_x/zcl_osd_x1.clas.xml")).to.equal(GOLDEN_CLAS_XML);
    expect(read("src/osd_x/zif_osd_x2.intf.abap")).to.equal(GOLDEN_INTF_ABAP);
    expect(read("src/osd_x/zif_osd_x2.intf.xml")).to.equal(GOLDEN_INTF_XML);
    expect(read("src/osd_x/zosd_x3.prog.abap")).to.equal(GOLDEN_PROG_ABAP);
    expect(read("src/osd_x/zosd_x3.prog.xml")).to.equal(GOLDEN_PROG_XML);
    expect(read("src/osd_x/ztab_x5.tabl.xml")).to.equal(GOLDEN_TABL_XML);
    expect(read("src/osd_x/zdtl_x6.dtel.xml")).to.equal(GOLDEN_DTEL_XML);
    expect(read("src/osd_x/zdom_x7.doma.xml")).to.equal(GOLDEN_DOMA_XML);
    expect(read("src/osd_x/ztty_x8.ttyp.xml")).to.equal(GOLDEN_TTYP_XML);
    expect(read("src/osd_x/zshl_x9.shlp.xml")).to.equal(GOLDEN_SHLP_XML);
    expect(read("src/osd_x/zvw_xa.view.xml")).to.equal(GOLDEN_VIEW_XML);
    expect(read("src/osd_x/zddl_xb.ddls.asddls")).to.equal(GOLDEN_DDLS_ABAP);
    expect(read("src/osd_x/zddl_xb.ddls.xml")).to.equal(GOLDEN_DDLS_XML);
    // /NS/ -> # (mutation: filename keeps the slash)
    expect(read("src/osd_x/#ns#ztab_y1.tabl.xml")).to.equal(GOLDEN_NS_TABL_XML);
    // FUGR: FM file without PROGDIR xml; includes and the main program with the plain <abapGit version="v1.0.0">
    expect(read("src/osd_x/zosg_x4.fugr.z_osd_x4_fm.abap")).to.equal(GOLDEN_FUGR_FM_ABAP);
    expect(read("src/osd_x/zosg_x4.fugr.xml")).to.equal(GOLDEN_FUGR_XML);
    expect(read("src/osd_x/zosg_x4.fugr.saplzosg_x4.xml")).to.equal(GOLDEN_INCLUDE_XML);
    expect(read("src/osd_x/zosg_x4.fugr.lzosg_x4top.xml")).to.equal(GOLDEN_INCLUDE_XML.replace("SAPLZOSG_X4", "LZOSG_X4TOP").replace("<SUBC>F</SUBC>", "<SUBC>I</SUBC>"));
    // the UXX include (generated by the function library) is not written
    expect(existsSync(join(out, "src/osd_x/zosg_x4.fugr.lzosg_x4uxx.abap"))).to.equal(false);
    // sha256 in the report matches the files on disk
    const rep = reportOf(out);
    const clas = rep.objects.find((o) => o.name === "ZCL_OSD_X1");
    expect(clas.status).to.equal("written");
    for (const f of clas.files) {
      expect(f.sha256).to.equal(sha256(join(out, f.path)));
      expect(f.bytes).to.equal(statSync(join(out, f.path)).size);
    }
  });

  it("plan first: --dry-run stops after the plan (exit 0), nothing written, no dump run (mutation: dry-run ignored)", async function () {
    const out = await fresh("dry");
    const r = await runExtract(["--out", out, "--dry-run"]);
    expect(r.code).to.equal(0);
    expect(r.lines.out.join("\n")).to.match(/per type/).and.to.match(/CLAS/);
    expect(existsSync(join(out, "src"))).to.equal(false);
    expect(existsSync(join(out, ".osd-hana", "dump"))).to.equal(false);
    expect(r.runs()).to.deep.equal(["--version", "list"]);
    expect(r.lines.out.join("\n")).to.not.match(new RegExp(PASSWORD));
  });

  it("--json prints the plan as one document (with the request and the sidecar)", async function () {
    const out = await fresh("json");
    const r = await runExtract(["--out", out, "--dry-run", "--json"]);
    expect(r.code).to.equal(0);
    const doc = JSON.parse(r.lines.out.join("\n"));
    expect(doc.request.schema).to.equal(1);
    expect(doc.plan.inScope).to.equal(14);
    expect(doc.sidecar.version).to.equal("v9.9.9-test");
    expect(JSON.stringify(doc)).to.not.match(new RegExp(PASSWORD));
  });

  it("the request carries the scope: local by default, --no-local drops it, --author narrows it, --package/--name add patterns (mutation: local.authors mapping)", async function () {
    let out = await fresh("req1");
    await runExtract(["--out", out, "--dry-run"]);
    expect(requestOf(out)).to.deep.include({local: {all: true}, inactive: false, catalog: true, ddic: true});

    out = await fresh("req2");
    await runExtract(["--out", out, "--dry-run", "--no-local", "--inactive", "--package", "ZOSD_%", "--name", "ZCL_%"]);
    expect(requestOf(out)).to.deep.include({packages: ["ZOSD_%"], names: ["ZCL_%"], inactive: true});
    expect(requestOf(out).local).to.equal(undefined);

    out = await fresh("req3");
    await runExtract(["--out", out, "--dry-run", "--author", "DEVUSER"]);
    expect(requestOf(out).local).to.deep.equal({authors: ["DEVUSER"]});
  });

  it("scope: customer objects only by the sidecar's class; --include-sap without --package/--name is refused; SAP content in a git tree is refused (exit 4)", async function () {
    const out = await fresh("scope");
    const r = await runExtract(["--out", out, "--dry-run", "--json"]);
    expect(r.code).to.equal(0);
    const doc = JSON.parse(r.lines.out.join("\n"));
    expect(doc.plan.sap).to.equal(1);
    expect(doc.plan.customer).to.equal(14);
    expect(doc.plan.inScope).to.equal(14);

    const refused = await runExtract(["--out", join(root, "sap1"), "--include-sap", "--dry-run"]);
    expect(refused.code).to.equal(1);
    expect(refused.lines.err.join("\n")).to.match(/--include-sap needs an explicit --package or --name/);

    const gitDir = join(root, "sap-git");
    mkdirSync(join(gitDir, ".git"), {recursive: true});
    const inTree = await runExtract(["--out", join(gitDir, "out"), "--include-sap", "--package", "SAP_%", "--dry-run"]);
    expect(inTree.code).to.equal(4);
    expect(inTree.lines.err.join("\n")).to.match(/vendor content must not be published/);
    // the refusal happens before anything is written
    expect(existsSync(join(gitDir, "out"))).to.equal(false);
  });

  it("restart: the same request reuses the dump; a foreign dump is refused, never mixed (mutation: reuse skipped)", async function () {
    const out = await fresh("restart");
    const first = await runExtract(["--out", out]);
    expect(first.code).to.equal(3);
    expect(first.runs()).to.deep.equal(["--version", "list", "dump"]);
    expect(reportOf(out).dump_reused).to.equal(false);

    const second = await runExtract(["--out", out]);
    expect(second.code).to.equal(3);
    expect(second.runs()).to.deep.equal(["--version", "list"]); // the handshake, the plan -- but no second dump
    expect(reportOf(out).dump_reused).to.equal(true);

    // a foreign dump (different request echo) is refused
    const foreign = join(root, "foreign");
    mkdirSync(join(foreign, ".osd-hana", "dump"), {recursive: true});
    writeFileSync(join(foreign, ".osd-hana", "dump", "manifest.json"), JSON.stringify({sidecar: {request: {schema: 1, packages: ["OTHER_%"]}, counts: {written: 1, skipped: 0}}}));
    const refused = await runExtract(["--out", foreign]);
    expect(refused.code).to.equal(1);
    expect(refused.lines.err.join("\n")).to.match(/echoes a different request/).and.to.match(/never mixed/);
  });

  it("an unreadable or unfinished dump directory is refused", async function () {
    const broken = join(root, "broken-dump");
    mkdirSync(join(broken, ".osd-hana", "dump"), {recursive: true});
    writeFileSync(join(broken, ".osd-hana", "dump", "manifest.json"), "{not json");
    const r1 = await runExtract(["--out", broken]);
    expect(r1.code).to.equal(1);
    expect(r1.lines.err.join("\n")).to.match(/not JSON/);

    const unfinished = join(root, "unfinished-dump");
    mkdirSync(join(unfinished, ".osd-hana", "dump"), {recursive: true});
    writeFileSync(join(unfinished, ".osd-hana", "dump", "manifest.json"), JSON.stringify({sidecar: {request: requestOf(broken), errors: ["table TFDIR: boom"]}}));
    const r2 = await runExtract(["--out", unfinished]);
    expect(r2.code).to.equal(1);
    expect(r2.lines.err.join("\n")).to.match(/carries 1 errors/);
  });

  it("an unsupported type is listed and the exit code is 3; the report totals add up (mutation: unsupported written anyway)", async function () {
    const out = await fresh("partial");
    const r = await runExtract(["--out", out]);
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    expect(rep.totals.inScope).to.equal(14);
    expect(rep.totals.written).to.equal(13);
    expect(rep.totals.unsupported).to.equal(1);
    expect(rep.totals.skipped).to.equal(0);
    expect(rep.totals.written + rep.totals.skipped + rep.totals.unsupported).to.equal(rep.totals.inScope);
    expect(rep.totals.dumped).to.equal(15);
    expect(rep.sentence).to.equal("1 objects of 14 could not be extracted (SICF 1)");
    const md = readFileSync(join(out, "extract-report.md"), "utf8");
    expect(md).to.match(/could not be extracted/);
    expect(md).to.match(/\| SICF \(unsupported\) \| 1 \| 0 \| 0 \| 1 \|/);
  });

  it("--inactive: inactive versions are dumped and flagged in the report (mutation: state not reported)", async function () {
    const out = await fresh("inactive");
    const r = await runExtract(["--out", out, "--inactive"]);
    expect(r.code).to.equal(3);
    expect(requestOf(out).inactive).to.equal(true);
    const rep = reportOf(out);
    const inactive = rep.objects.find((o) => o.name === "ZOSD_XD");
    expect(inactive.state).to.equal("I");
    const md = readFileSync(join(out, "extract-report.md"), "utf8");
    expect(md).to.match(/Inactive content: PROG ZOSD_XD \(I\)/);
    // without --inactive the request says so
    const out2 = await fresh("inactive-off");
    await runExtract(["--out", out2]);
    expect(requestOf(out2).inactive).to.equal(false);
  });

  it("the password never reaches argv and never appears in any output (mutation: --password flag accepted)", async function () {
    const out = await fresh("secret");
    const r = await runExtract(["--out", out]);
    for (const verb of r.runs()) {
      expect(verb).to.not.match(/PASSWORD|password/);
    }
    const all = `${r.lines.out.join("\n")}\n${r.lines.err.join("\n")}\n${readFileSync(join(out, "extract-report.json"), "utf8")}\n${readFileSync(join(out, "extract-report.md"), "utf8")}\n${readFileSync(join(out, ".osd-hana", "request.json"), "utf8")}`;
    expect(all).to.not.match(new RegExp(PASSWORD));
    expect(all).to.not.match(new RegExp(USER));
  });

  it("usage: no --out is exit 1; a non-empty output directory is refused (exit 4)", async function () {
    const r = await runExtract([]);
    expect(r.code).to.equal(1);
    expect(r.lines.err.join("\n")).to.match(/--out is required/);

    const full = join(root, "nonempty");
    mkdirSync(full, {recursive: true});
    writeFileSync(join(full, "something.txt"), "x");
    const r2 = await runExtract(["--out", full]);
    expect(r2.code).to.equal(4);
    expect(r2.lines.err.join("\n")).to.match(/non-empty output directory/);
  });

  it("exit 2 when the sidecar cannot connect; exit 5 when there is no ABAP schema", async function () {
    const out = await fresh("conn");
    const r = await runExtract(["--out", out], {env: {FAKE_SIDECAR_EXIT: "2"}});
    expect(r.code).to.equal(2);
    expect(r.lines.err.join("\n")).to.match(/cannot connect or log on/);

    const out2 = await fresh("noschema");
    const r2 = await runExtract(["--out", out2], {env: {FAKE_SIDECAR_EXIT: "5"}});
    expect(r2.code).to.equal(5);
    expect(r2.lines.err.join("\n")).to.match(/no ABAP schema/);
  });

  it("folder logic: PREFIX where the names allow it, FULL otherwise; the report says which (mutation: always PREFIX)", function () {
    const parents = new Map([["ZTOP", ""], ["ZTOP_SUB", "ZTOP"], ["ZOTHER", ""]]);
    expect(decideFolderLogic(new Set(["ZTOP", "ZTOP_SUB"]), parents)).to.equal("PREFIX");
    expect(decideFolderLogic(new Set(["ZTOP", "ZTOP_SUB", "ZOTHER"]), parents)).to.equal("FULL");
    expect(decideFolderLogic(new Set(["ZTOP", "ZTOP_NOT_CHILD"]), parents)).to.equal("FULL");
    const paths = folderPaths(new Set(["ZTOP", "ZTOP_SUB"]), parents, "PREFIX");
    expect(paths.get("ZTOP")).to.equal("ztop/");
    expect(paths.get("ZTOP_SUB")).to.equal("ztop/sub/");
    const full = folderPaths(new Set(["$TMP", "ZTOP"]), parents, "FULL");
    expect(full.get("$TMP")).to.equal("tmp/");
    expect(full.get("ZTOP")).to.equal("ztop/");
    // a collision refuses instead of mixing two packages into one folder
    expect(() => folderPaths(new Set(["TMP", "$TMP"]), new Map(), "FULL")).to.throw(/collision/);
  });

  it("reusableDump: no dump dir, unreadable manifest, missing sidecar block, mismatched request, errors, missing counts", async function () {
    const dumpDir = join(root, "reuse-unit");
    rmSync(dumpDir, {recursive: true, force: true});
    expect((await reusableDump(dumpDir, {schema: 1})).exists).to.equal(false);
    mkdirSync(dumpDir, {recursive: true});
    writeFileSync(join(dumpDir, "manifest.json"), "{");
    expect((await reusableDump(dumpDir, {schema: 1})).why).to.match(/not JSON/);
    writeFileSync(join(dumpDir, "manifest.json"), "{}");
    expect((await reusableDump(dumpDir, {schema: 1})).why).to.match(/no sidecar block/);
    writeFileSync(join(dumpDir, "manifest.json"), JSON.stringify({sidecar: {request: {schema: 2}, errors: [], counts: {}}}));
    expect((await reusableDump(dumpDir, {schema: 1})).why).to.match(/different request/);
    writeFileSync(join(dumpDir, "manifest.json"), JSON.stringify({sidecar: {request: {schema: 1}, errors: ["x"], counts: {}}}));
    expect((await reusableDump(dumpDir, {schema: 1})).why).to.match(/errors/);
    writeFileSync(join(dumpDir, "manifest.json"), JSON.stringify({sidecar: {request: {schema: 1}, errors: []}}));
    expect((await reusableDump(dumpDir, {schema: 1})).why).to.match(/no counts/);
    writeFileSync(join(dumpDir, "manifest.json"), JSON.stringify({sidecar: {request: {schema: 1}, errors: [], counts: {written: 1, skipped: 0}}}));
    expect((await reusableDump(dumpDir, {schema: 1})).ok).to.equal(true);
  });

  it("inGitTree finds both the directory and the gitfile form", async function () {
    const dir = join(root, "git-dir");
    mkdirSync(join(dir, ".git"), {recursive: true});
    expect(await inGitTree(join(dir, "deep", "deeper"))).to.equal(dir);
    const file = join(root, "git-file");
    mkdirSync(file, {recursive: true});
    writeFileSync(join(file, ".git"), "gitdir: elsewhere");
    expect(await inGitTree(file)).to.equal(file);
    expect(await inGitTree(root)).to.equal(undefined);
  });
});
