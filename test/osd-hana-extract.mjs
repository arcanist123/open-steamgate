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
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
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

async function runExtract(argv, {env = {}, out, list, dump, pinFile: pinFileOpt, chunk, extra = {}} = {}) {
  const from = recordLines().length;
  const lines = {out: [], err: [], from};
  const io = {out: (l) => lines.out.push(l), err: (l) => lines.err.push(l)};
  const runEnv = {
    ...process.env,
    OSD_HANA_DUMP: fakePath,
    OSD_HANA_PASSWORD: PASSWORD,
    ...env,
  };
  // `pinFile` is the TRUSTED seam (the embedding host's own pin, critic S-E);
  // the default test path names it there, a `--sidecar-pin` on ARGV is the
  // public input and must never produce a "pinned" verdict on its own.
  const argvPin = argv.includes("--sidecar-pin");
  const code = await extractMain([
    "--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA,
  ].concat(argv), {
    io,
    env: runEnv,
    stdin: {isTTY: false},
    isTTY: false,
    sidecarTimeoutMs: 500,
    // null = no trusted seam on purpose (a test of the public --sidecar-pin)
    pinFile: pinFileOpt === undefined ? pinPath : (pinFileOpt ?? undefined),
    dumpChunkSize: chunk,
    // the FAKE sidecar's scenario knobs reach the child only through the
    // seam: since the fix round the child env is the core's minimal
    // allowlist (critic S-2) -- the parent's environment never leaks in
    sidecarExtraEnv: {
      FAKE_SIDECAR_RECORD: recordPath,
      FAKE_SIDECAR_LIST: list ?? LIST_FIXTURE,
      FAKE_SIDECAR_DUMP: dump ?? DUMP_FIXTURE,
      ...env,
      ...extra,
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
    expect(rep.totals.written).to.equal(6); // DTEL, DOMA, TTYP, SHLP, VIEW, DDLS
    expect(rep.totals.writtenPartial).to.equal(7); // CLAS/INTF (component texts), 2 TABL (FKs/indexes/texts), 2 PROG + FUGR (screens not checked)
    expect(rep.totals.unsupported).to.equal(1);
    expect(rep.totals.skipped).to.equal(0);
    expect(rep.totals.written + rep.totals.writtenPartial + rep.totals.skipped + rep.totals.unsupported).to.equal(rep.totals.inScope);
    expect(rep.totals.dumped).to.equal(15);
    expect(rep.sentence).to.equal("8 objects of 14 could not be fully extracted (CLAS 1, FUGR 1, INTF 1, PROG 2, SICF 1, TABL 2)");
    const md = readFileSync(join(out, "extract-report.md"), "utf8");
    expect(md).to.match(/could not be fully extracted/);
    expect(md).to.match(/\| SICF \(unsupported\) \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
    // which DD tables were looked at is said in the report (fix round 2, SHOULD-1)
    expect(md).to.match(/DD tables read: .*DD02L/);
    expect(md).to.match(/not carried by this dump[^]*DD05S/);
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
    expect(paths.paths.get("ZTOP")).to.equal("ztop/");
    expect(paths.paths.get("ZTOP_SUB")).to.equal("ztop/sub/");
    const full = folderPaths(new Set(["$TMP", "ZTOP"]), parents, "FULL");
    expect(full.paths.get("$TMP")).to.equal("tmp/");
    expect(full.paths.get("ZTOP")).to.equal("ztop/");
    // abapGit's $ rule: a local package's folder is its name without the
    // leading $ -- so $ZPK and ZPK fold to the SAME folder zpk/. That is a
    // collision abapGit cannot hold in one repository; it comes back as a
    // per-package refusal, never an abort (fix round 2, SHOULD-3).
    expect(full.paths.get("$ZPK")).to.equal("zpk/");
    const coll = folderPaths(new Set(["TMP", "$TMP"]), new Map(), "FULL");
    expect(coll.paths.get("$TMP")).to.equal("tmp/");
    expect([...coll.collisions].sort()).to.deep.equal(["TMP", "$TMP"]);
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

// ---------------------------------------------------------------- the fix round
// The critic's probes turned into tests (CRITIC.md M/S + attack 2 + the NOTEs).
// Each guard names its mutation; the suite goes RED when the guard is removed.
describe("osd hana extract -- the fix round (critic M/S/N, attack 2)", function () {

  const readOut = (out, rel) => readFileSync(join(out, rel), "utf8");
  const readJsonl = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const writeJsonl = (dir, name, rows) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const objectsRows = (dir) => readJsonl(dir, "objects.jsonl");
  const writeObjects = (dir, rows) => writeJsonl(dir, "objects.jsonl", rows);
  const tadirRows = (dump) => readJsonl(join(dump, "tables"), "TADIR.jsonl");
  const writeTadir = (dump, rows) => writeJsonl(join(dump, "tables"), "TADIR.jsonl", rows);
  const tableRows = (dump, t) => readJsonl(join(dump, "tables"), `${t}.jsonl`);
  const writeTable = (dump, t, rows) => writeJsonl(join(dump, "tables"), `${t}.jsonl`, rows);
  // a listing row in the fixture's shape
  const row = (o) => ({type: o.type, name: o.name, package: o.package, author: "DEVUSER", class: "customer", state: "A", status: "W", files: []});
  const tadirRow = (type, name, pkg) => ({PGMID: "R3TR", OBJECT: type, OBJ_NAME: name, DEVCLASS: pkg, AUTHOR: "DEVUSER", MASTERLANG: "E", GENFLAG: "", SRCSYSTEM: "SYN"});

  // a fresh fixture pair, optionally mutated (the probe shape)
  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }

  // one synthetic PROG with source, through every channel the dump has
  function addProg(list, dump, name, pkg) {
    writeFileSync(join(dump, "src", `${name}.abap`), `REPORT ${String(name).toLowerCase().replace(/[^a-z0-9_]/g, "")}.\n`);
    writeJsonl(dump, "reposrc.jsonl", readJsonl(dump, "reposrc.jsonl").concat([{program: name, state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: `src/${name}.abap`}]));
    writeTadir(dump, tadirRows(dump).concat([tadirRow("PROG", name, pkg)]));
    writeObjects(dump, objectsRows(dump).concat([{...row({type: "PROG", name, package: pkg}), files: []}]));
    writeObjects(list, objectsRows(list).concat([row({type: "PROG", name, package: pkg})]));
  }

  const tpoolHex = (id, k, entry, len) => {
    const s = id + k.padEnd(8, " ") + entry.padEnd(len, " ");
    const b = Buffer.alloc(2 + 2 * s.length);
    b.writeUInt16BE(len, 0);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + 2 * i);
    return "0x" + b.toString("hex");
  };

  it("M1: an in-scope object missing from the dump is a ledger line, never a vanishing (mutation: the not-in-dump line removed)", async function () {
    const fx = variant((list, dump) => writeTadir(dump, tadirRows(dump).filter((r) => r.OBJ_NAME !== "ZIF_OSD_X2")));
    const out = await fresh("m1");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const missing = rep.objects.find((o) => o.name === "ZIF_OSD_X2");
    expect(missing.status).to.equal("skipped");
    expect(missing.reason).to.match(/not-in-dump/);
    const t = rep.totals;
    expect(t.inScope).to.equal(14);
    expect(t.written + t.writtenPartial + t.skipped + t.unsupported).to.equal(t.inScope);
    const totalsLine = readOut(out, "extract-report.md").split("\n").find((l) => l.startsWith("Totals:"));
    expect(totalsLine).to.match(/in scope 14 = written 6 \+ written-partial 6 \+ skipped 1 \+ unsupported 1/);
  });

  it("M2: a function module whose include is missing from the dump is a part line and the group is written-partial (mutation: the missing-include check removed)", async function () {
    const fx = variant((list, dump) => {
      writeTable(dump, "TFDIR", tableRows(dump, "TFDIR").concat([{FUNCNAME: "Z_OSD_X4_FM2", PNAME: "SAPLZOSG_X4", PNAME_MAIN: "", INCLUDE: "02", FMODE: "", UTASK: ""}]));
      writeTable(dump, "TFTIT", tableRows(dump, "TFTIT").concat([{FUNCNAME: "Z_OSD_X4_FM2", SPRAS: "E", STEXT: "Second synthetic function"}]));
    });
    const out = await fresh("m2");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const fugr = rep.objects.find((o) => o.name === "ZOSG_X4");
    expect(fugr.status).to.equal("written-partial");
    const part = fugr.parts.find((p) => /Z_OSD_X4_FM2/.test(p.part));
    expect(part, "a part line names the lost function").to.exist;
    expect(part.disposition).to.equal("not written");
    expect(part.reason).to.match(/include LZOSG_X4U02/);
    // TFDIR.INCLUDE carries the bare number ("01"); the include's PROGRAM is
    // LZOSG_X4U01 and IS in the dump -- the present function must not be
    // mourned too (measured on the real bed: both groups lost nothing, the
    // pre-fix check said "include 01 has no source" for a dumped include)
    expect(fugr.parts.find((p) => p.part === "function Z_OSD_X4_FM"),
      "the function whose include IS dumped gets no false 'not written' line").to.equal(undefined);
    expect(readOut(out, "src/osd_x/zosg_x4.fugr.xml")).to.not.match(/Z_OSD_X4_FM2/);
    expect(rep.errors).to.deep.equal([]);
  });

  it("M4: PROG and FUGR are written-partial with 'not checked' part lines for screens, GUI status and variants (mutation: the not-checked lines removed)", async function () {
    const out = await fresh("m4");
    await runExtract(["--out", out]);
    const rep = reportOf(out);
    for (const name of ["ZOSD_X3", "ZOSD_XD"]) {
      const o = rep.objects.find((x) => x.name === name);
      expect(o.status).to.equal("written-partial");
      for (const part of ["dynpros", "GUI status", "variants"]) {
        const p = o.parts.find((x) => x.part === part);
        expect(p, `${name}: ${part}`).to.exist;
        expect(p.disposition).to.equal("not checked");
      }
    }
    const fugr = rep.objects.find((x) => x.name === "ZOSG_X4");
    expect(fugr.parts.filter((p) => p.disposition === "not checked").map((p) => p.part))
      .to.deep.equal(["documentation of Z_OSD_X4_FM", "dynpros", "GUI status", "variants"]);
    const md = readOut(out, "extract-report.md");
    expect(md).to.match(/program screens, GUI statuses and variants are not checked/);
  });

  it("M3: --include-sap refuses a --dump-dir inside a git working tree (mutation: the dump-dir git-tree check removed)", async function () {
    const gitDir = await fresh("m3-git");
    mkdirSync(join(gitDir, ".git"), {recursive: true});
    const dumpInGit = join(gitDir, "dump");
    const out = await fresh("m3-out");
    const r = await runExtract(["--out", out, "--include-sap", "--package", "Z_%", "--dump-dir", dumpInGit]);
    expect(r.code).to.equal(4);
    expect(r.lines.err.join("\n")).to.match(/vendor content must not be published/);
    expect(existsSync(dumpInGit)).to.equal(false);
  });

  it("S2: --dump-dir may not be the output directory or sit inside it (mutation: the containment check removed)", async function () {
    const out = await fresh("s2");
    const same = await runExtract(["--out", out, "--dump-dir", out]);
    expect(same.code).to.equal(4);
    expect(same.lines.err.join("\n")).to.match(/dump directory.*inside the output/i);
    const out2 = await fresh("s2b");
    const inSrc = await runExtract(["--out", out2, "--dump-dir", join(out2, "src", "dump")]);
    expect(inSrc.code).to.equal(4);
    const out3 = await fresh("s2c");
    const nested = await runExtract(["--out", out3, "--dump-dir", join(out3, "elsewhere")]);
    expect(nested.code).to.equal(4);
  });

  it("S1: FULL folder logic nests subpackages under their parents, abapGit-style, three levels (mutation: FULL nests flat)", async function () {
    // the abapGit rule (zcl_abapgit_folder_logic=>package_to_path): FULL names
    // every package by its own folder, NESTED under its parent's folder -- the
    // recursion does not stop at scope boundaries inside the hierarchy.
    const parents = new Map([["ZGRAND", ""], ["ZTOP", "ZGRAND"], ["ZTOPSUB", "ZTOP"], ["ZOTHER", ""]]);
    const pkgs = new Set(["ZGRAND", "ZTOP", "ZTOPSUB", "ZOTHER"]);
    expect(decideFolderLogic(pkgs, parents)).to.equal("FULL");
    const paths = folderPaths(pkgs, parents, "FULL");
    expect(paths.get("ZGRAND")).to.equal("zgrand/");
    expect(paths.get("ZTOP")).to.equal("zgrand/ztop/");
    expect(paths.get("ZTOPSUB")).to.equal("zgrand/ztop/ztopsub/");
    expect(paths.get("ZOTHER")).to.equal("zother/");

    // end to end through the whole command, as the golden test for it
    const fx = variant((list, dump) => {
      for (const [name, pkg] of [["ZNEST_G1", "ZGRAND"], ["ZNEST_T1", "ZTOP"], ["ZNEST_S1", "ZTOPSUB"]]) addProg(list, dump, name, pkg);
      writeTable(dump, "TDEVC", tableRows(dump, "TDEVC").concat([
        {DEVCLASS: "ZGRAND", PARENTCL: "", DLVUNIT: "LOCAL"},
        {DEVCLASS: "ZTOP", PARENTCL: "ZGRAND", DLVUNIT: "LOCAL"},
        {DEVCLASS: "ZTOPSUB", PARENTCL: "ZTOP", DLVUNIT: "LOCAL"},
      ]));
    });
    const out = await fresh("s1");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    expect(existsSync(join(out, "src/zgrand/znest_g1.prog.abap"))).to.equal(true);
    expect(existsSync(join(out, "src/zgrand/ztop/znest_t1.prog.abap"))).to.equal(true);
    expect(existsSync(join(out, "src/zgrand/ztop/ztopsub/znest_s1.prog.abap"))).to.equal(true);
    expect(readOut(out, ".abapgit.xml")).to.match(/<FOLDER_LOGIC>FULL<\/FOLDER_LOGIC>/);
    const rep = reportOf(out);
    const folders = Object.fromEntries(rep.folder_logic.folders.map((f) => [f.package, f.folder]));
    expect(folders.ZTOPSUB).to.equal("src/zgrand/ztop/ztopsub/");
    expect(folders["$OSD_X"]).to.equal("src/osd_x/");
  });

  it("SHOULD-3: a local and a transportable package folding to one folder ($TMP and TMP) refuse per object, never abort (mutation: the collision aborts the run again)", async function () {
    const fx = variant((list, dump) => {
      // abapGit's $ rule strips the leading $ of a local package's folder
      // name, so $TMP and TMP both fold to tmp/ -- a pair that exists on any
      // system where someone prototyped locally and then created the real
      // package. abapGit cannot hold both in one repository; the second
      // package's objects are refused in the ledger and the run continues.
      for (const [name, pkg] of [["ZCOLL_A1", "$TMP"], ["ZCOLL_B1", "TMP"]]) addProg(list, dump, name, pkg);
      writeTable(dump, "TDEVC", tableRows(dump, "TDEVC").concat([{DEVCLASS: "$TMP", PARENTCL: "", DLVUNIT: "LOCAL"}, {DEVCLASS: "TMP", PARENTCL: "", DLVUNIT: "LOCAL"}]));
    });
    const out = await fresh("s3");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3); // partial -- NOT the internal error 6 the abort produced
    const rep = reportOf(out);
    expect(rep.internal_error).to.equal(undefined);
    expect(rep.totals.perType.PROG.skipped).to.be.at.least(1);
    // "$" sorts before "T": $TMP keeps the folder tmp/, TMP's objects lose
    expect(rep.objects.find((o) => o.name === "ZCOLL_A1").status).to.match(/^written/);
    const lost = rep.objects.find((o) => o.name === "ZCOLL_B1");
    expect(lost.status).to.equal("skipped");
    expect(lost.reason).to.match(/folder collision/).and.to.match(/\$TMP/).and.to.match(/abapGit/);
    expect(existsSync(join(out, "src", "tmp", "zcoll_a1.prog.abap"))).to.equal(true);
    expect(existsSync(join(out, "src", "tmp", "zcoll_b1.prog.abap"))).to.equal(false);
  });
  it("S3: --out naming an existing file is a usage error, not an uncaught crash (mutation: the lstat check removed)", async function () {
    const f = join(root, "out-is-a-file");
    writeFileSync(f, "x");
    const r = await runExtract(["--out", f]);
    expect(r.code).to.equal(1);
    expect(r.lines.err.join("\n")).to.match(/existing file/);
  });

  it("S4: a restart reports drift between the live listing and the reused dump (mutation: the drift report removed)", async function () {
    const out = await fresh("s4");
    const first = await runExtract(["--out", out]);
    expect(first.code).to.equal(3);
    const fx = variant((list) => {
      writeObjects(list, objectsRows(list).filter((o) => o.name !== "ZOSD_X3")
        .concat([{...row({type: "CLAS", name: "ZCL_NEW_1", package: "$OSD_X"}), files: []}]));
    });
    const second = await runExtract(["--out", out], {list: fx.list});
    expect(second.code).to.equal(3);
    expect(second.runs()).to.deep.equal(["--version", "list"]); // reused: no second dump
    const rep = reportOf(out);
    expect(rep.dump_reused).to.equal(true);
    expect(rep.drift.appeared).to.deep.equal(["CLAS:ZCL_NEW_1"]);
    expect(rep.drift.disappeared).to.deep.equal(["PROG:ZOSD_X3"]);
    const neu = rep.objects.find((o) => o.name === "ZCL_NEW_1");
    expect(neu.status).to.equal("skipped");
    expect(neu.reason).to.match(/not-in-dump/);
    // the derived repository is refreshed: no stale file for the vanished object
    expect(existsSync(join(out, "src/osd_x/zosd_x3.prog.abap"))).to.equal(false);
    expect(readOut(out, "extract-report.md")).to.match(/Drift since the dump/);
  });

  it("attack 2: a package name that traverses is refused per object and writes nothing (mutation: the unsafe-name check removed)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).map((o) => o.name === "ZIF_OSD_X2" ? {...o, package: ".."} : o));
      writeTadir(dump, tadirRows(dump).map((r) => r.OBJ_NAME === "ZIF_OSD_X2" ? {...r, DEVCLASS: ".."} : r));
    });
    const out = await fresh("a2-dotdot");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const o = rep.objects.find((x) => x.name === "ZIF_OSD_X2");
    expect(o.status).to.equal("skipped");
    expect(o.reason).to.match(/unsafe name/);
    // the naive walk would have landed this at <out> itself (src/..)
    expect(existsSync(join(out, "zif_osd_x2.intf.abap"))).to.equal(false);
  });

  it("attack 2: a backslash object name is refused (a separator on Windows) (mutation: the unsafe-name check removed)", async function () {
    const fx = variant((list, dump) => addProg(list, dump, "ZEVI\\LX1", "$OSD_X"));
    const out = await fresh("a2-backslash");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const o = reportOf(out).objects.find((x) => x.name === "ZEVI\\LX1");
    expect(o.status).to.equal("skipped");
    expect(o.reason).to.match(/unsafe name/);
    expect(existsSync(join(out, "src", "osd_x", "zevi"))).to.equal(false);
  });

  it("attack 2: a Windows-reserved name is refused per object (mutation: the unsafe-name check removed)", async function () {
    const fx = variant((list, dump) => addProg(list, dump, "CON", "$OSD_X"));
    const out = await fresh("a2-con");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const o = reportOf(out).objects.find((x) => x.name === "CON");
    expect(o.status).to.equal("skipped");
    expect(o.reason).to.match(/unsafe name/);
    expect(existsSync(join(out, "src", "osd_x", "con.prog.abap"))).to.equal(false);
  });

  it("attack 2: a case-insensitive name collision is refused with both objects listed, never last-writer-wins (mutation: the collision check removed)", async function () {
    const fx = variant((list, dump) => {
      writeObjects(list, objectsRows(list).concat([row({type: "INTF", name: "Zif_Osd_X2", package: "$OSD_X"})]));
      writeObjects(dump, objectsRows(dump).concat([row({type: "INTF", name: "Zif_Osd_X2", package: "$OSD_X"})]));
    });
    const out = await fresh("a2-case");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const original = rep.objects.find((x) => x.name === "ZIF_OSD_X2");
    const variant2 = rep.objects.find((x) => x.name === "Zif_Osd_X2");
    expect(original.status).to.equal("written");
    expect(variant2.status).to.equal("skipped");
    expect(variant2.reason).to.match(/collision/i);
    expect(existsSync(join(out, "src/osd_x/zif_osd_x2.intf.abap"))).to.equal(true);
  });

  it("attack 2: a NUL in a name is refused per object, not a crash (mutation: the unsafe-name check removed)", async function () {
    const fx = variant((list, dump) => {
      // no source on purpose: the name check must fire before the source check
      writeTadir(dump, tadirRows(dump).concat([tadirRow("PROG", "ZNU\u0000LX1", "$OSD_X")]));
      writeObjects(dump, objectsRows(dump).concat([row({type: "PROG", name: "ZNU\u0000LX1", package: "$OSD_X"})]));
      writeObjects(list, objectsRows(list).concat([row({type: "PROG", name: "ZNU\u0000LX1", package: "$OSD_X"})]));
    });
    const out = await fresh("a2-nul");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const o = reportOf(out).objects.find((x) => x.name === "ZNU\u0000LX1");
    expect(o.status).to.equal("skipped");
    expect(o.reason).to.match(/unsafe name/);
  });

  it("N3: an empty selection is a usage error, not a false 'no ABAP schema' verdict (mutation: the empty-selection branch maps to exit 5)", async function () {
    const fx = variant((list) => {
      writeObjects(list, []);
      writeFileSync(join(list, "summary.json"), JSON.stringify({ok: true, objects: 0, customer: 0, sap: 0, generated: 0, source_bytes_compressed: 0}));
    });
    const out = await fresh("n3");
    const r = await runExtract(["--out", out], {list: fx.list});
    expect(r.code).to.equal(1);
    expect(r.lines.err.join("\n")).to.match(/matched no objects/);
  });

  it("N4: the repository master language follows the dump, not a hard-coded E (mutation: master language forced to E)", async function () {
    const fx = variant((list, dump) => writeTadir(dump, tadirRows(dump).map((r) => ({...r, MASTERLANG: "D"}))));
    const out = await fresh("n4");
    await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(readOut(out, ".abapgit.xml")).to.match(/<MASTER_LANGUAGE>D<\/MASTER_LANGUAGE>/);
  });

  it("N5: a translated text pool the converter leaves out is a part line, not a silent drop (mutation: the extra-language part line removed)", async function () {
    const fx = variant((list, dump) => {
      writeTable(dump, "REPOTEXT", tableRows(dump, "REPOTEXT").concat([{PROGNAME: "ZOSD_X3", LANGUAGE: "D", R3STATE: "A", DATA: tpoolHex("I", "001", "Ueberschrift", 12)}]));
    });
    const out = await fresh("n5");
    await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    const o = reportOf(out).objects.find((x) => x.name === "ZOSD_X3");
    const p = o.parts.find((x) => /language D/.test(x.reason));
    expect(p, "a part line names the dropped translation").to.exist;
    expect(p.disposition).to.equal("not written");
  });

  it("the ledger accounts for every in-scope object exactly once, in exactly one state", async function () {
    const out = await fresh("ledger");
    await runExtract(["--out", out]);
    const rep = reportOf(out);
    expect(rep.objects.length).to.equal(rep.totals.inScope);
    expect(rep.ledger_error).to.equal(undefined);
    for (const o of rep.objects) expect(["written", "written-partial", "skipped", "unsupported"]).to.include(o.status);
  });
});

// ------------------------------------------------------- fix round 2
// CRITIC.md round 2 (../w3fix2/CRITIC.md) and the coordinator's decisions.
// Each test names the mutation that must turn it RED.
describe("osd hana extract -- fix round 2 (CRITIC round 2)", function () {

  const readJsonl = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const writeJsonl = (dir, name, rows) => writeFileSync(join(dir, name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const objectsRows = (dir) => readJsonl(dir, "objects.jsonl");
  const writeObjects = (dir, rows) => writeJsonl(dir, "objects.jsonl", rows);
  const writeTable = (dump, t, rows) => writeJsonl(join(dump, "tables"), `${t}.jsonl`, rows);
  const tableRows = (dump, t) => readJsonl(join(dump, "tables"), `${t}.jsonl`);
  const reposrcRows = (dump) => readJsonl(dump, "reposrc.jsonl");
  const writeReposrc = (dump, rows) => writeJsonl(dump, "reposrc.jsonl", rows);
  const row = (o) => ({type: o.type, name: o.name, package: o.package, author: "DEVUSER", class: o.class ?? "customer", state: "A", status: o.status ?? "W", files: o.files ?? []});
  const tadirRow = (type, name, pkg) => ({PGMID: "R3TR", OBJECT: type, OBJ_NAME: name, DEVCLASS: pkg, AUTHOR: "DEVUSER", MASTERLANG: "E", GENFLAG: "", SRCSYSTEM: "SYN"});
  const pad = (n) => n.padEnd(30, "=");

  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx2-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }
  function addProg(list, dump, name, pkg) {
    writeFileSync(join(dump, "src", `${name}.abap`), `REPORT zprog.\n`);
    writeReposrc(dump, reposrcRows(dump).concat([{program: name, state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 1, sha256: "1".repeat(64), file: `src/${name}.abap`}]));
    writeTable(dump, "TADIR", tableRows(dump, "TADIR").concat([tadirRow("PROG", name, pkg)]));
    writeObjects(dump, objectsRows(dump).concat([{...row({type: "PROG", name, package: pkg}), files: []}]));
    writeObjects(list, objectsRows(list).concat([row({type: "PROG", name, package: pkg})]));
  }
  // dump-runs seen by the fake sidecar (verb -> parsed request records)
  const dumpRequests = (from = 0) => recordLines().slice(from)
    .map((l) => JSON.parse(l)).filter((e) => e.argv[0] === "dump").map((e) => e.request);

  it("M-1: the scope fails CLOSED -- a class that is not exactly the customer value is left out as unknown-class (mutation: any non-sap class value is trusted)", async function () {
    for (const value of ["SAP", "Sap", undefined, "vendor"]) {
      const fx = variant((list, dump) => {
        for (const dir of [list, dump]) {
          writeObjects(dir, objectsRows(dir).map((o) => o.name === "ZCL_OSD_X1" ? {...o, class: value} : o));
        }
      });
      const out = await fresh("m1x");
      const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
      expect(r.code, `class=${JSON.stringify(value)}: exit`).to.equal(3);
      const rep = reportOf(out);
      const e = rep.objects.find((o) => o.name === "ZCL_OSD_X1");
      expect(e.status, `class=${JSON.stringify(value)}: status`).to.equal("skipped");
      expect(e.reason).to.match(/unknown-class/);
      expect(e.reason).to.match(/newer than this module/);
      expect(e.files).to.deep.equal([]);
      expect(existsSync(join(out, "src/osd_x/zcl_osd_x1.clas.abap")), `class=${JSON.stringify(value)}: not written`).to.equal(false);
      expect(rep.totals.written + rep.totals.writtenPartial + rep.totals.skipped + rep.totals.unsupported).to.equal(rep.totals.inScope);
    }
    // --include-sap admits the exact sap class only -- "SAP" stays out
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) {
        writeObjects(dir, objectsRows(dir).map((o) => o.name === "ZCL_OSD_X1" ? {...o, class: "SAP"} : o));
      }
    });
    const out = await fresh("m1y");
    const r = await runExtract(["--out", out, "--include-sap", "--name", "Z%"], {list: fx.list, dump: fx.dump});
    expect(reportOf(out).objects.find((o) => o.name === "ZCL_OSD_X1").status).to.equal("skipped");
  });

  it("M-1: the run says the sidecar may be newer than this module, in the plan and in the report (mutation: the notice removed)", async function () {
    const fx = variant((list, dump) => {
      writeObjects(list, objectsRows(list).map((o) => o.name === "ZCL_OSD_X1" ? {...o, class: "SAP"} : o));
    });
    const out = await fresh("m1z");
    const dry = await runExtract(["--out", join(root, "m1z-dry"), "--dry-run", "--json"], {list: fx.list});
    const doc = JSON.parse(dry.lines.out.join("\n"));
    expect(doc.plan.unknownClass).to.equal(1);
    expect(dry.lines.out.join("\n")).to.not.match(/\u001b/);
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.lines.err.join("\n")).to.match(/unknown classification/).and.to.match(/newer than this module/);
    expect(readOutReport(out)).to.match(/newer than this module/);
  });
  const readOutReport = (out) => readFileSync(join(out, "extract-report.md"), "utf8");

  it("M-2a: the dump request names the in-scope objects, not the user's patterns (mutation: the raw patterns go to the dump)", async function () {
    const out = await fresh("m2a");
    const from = recordLines().length;
    const r = await runExtract(["--out", out, "--name", "Z%"], {});
    expect(r.code).to.equal(3);
    const reqs = dumpRequests(from);
    expect(reqs.length).to.equal(1);
    const req = reqs[0];
    expect(req.packages).to.equal(undefined); // no pattern travels to the dump
    expect(req.names).to.not.include("Z%");
    expect(req.names).to.not.include("ZCL_SAP_XE"); // nothing of the vendor's
    // exact names, LIKE-escaped (the sidecar matches with ESCAPE '\\')
    expect(req.names).to.include("ZOSD\\_X3");
    expect(req.names).to.include("ZCL\\_OSD\\_X1");
    // every in-scope name is there, nothing else
    const unescaped = new Set(req.names.map((n) => n.replace(/\\(.)/g, "$1")));
    expect(unescaped.has("ZCL_SAP_XE")).to.equal(false);
    expect(unescaped.size).to.equal(14);
  });

  it("M-2b: a dump that delivers objects outside the scope fails the run and names the dump directory (mutation: the audit removed)", async function () {
    const fx = variant((list, dump) => {
      // the vendor source sits in the fixture dump, as the sidecar would have
      // written it for a matched pattern
      writeFileSync(join(dump, "src", "ZCL_SAP_XX=====CS.abap"), "class ZCL_SAP_XX definition. \"VENDOR SOURCE\nendclass.\n");
      writeObjects(dump, objectsRows(dump).concat([{type: "CLAS", name: "ZCL_SAP_XX", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W", files: [{path: "src/ZCL_SAP_XX=====CS.abap", state: "A", sha256: "0".repeat(64), bytes: 60}]}]));
    });
    const out = await fresh("m2b");
    const r = await runExtract(["--out", out, "--name", "Z%"], {list: fx.list, dump: fx.dump});
    expect(r.code, "the run fails, not an ordinary partial").to.equal(4);
    expect(r.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/ZCL_SAP_XX/).and.to.match(/dump directory/);
    // nothing of the repository was built from it
    expect(existsSync(join(out, "src"))).to.equal(false);
    expect(r.lines.err.join("\n") + r.lines.out.join("\n")).to.not.match(/VENDOR SOURCE/);
    // excluded closure rows do NOT trip the audit: the normal fixture dump
    // carries the excluded sap row and the run proceeds
    const ok = await fresh("m2b-ok");
    const r2 = await runExtract(["--out", ok]);
    expect(r2.code).to.equal(3);
  });

  it("M-2c: <out>/.gitignore carries .osd-hana/ -- the raw dump never belongs in the repository (mutation: the gitignore removed)", async function () {
    const out = await fresh("m2c");
    await runExtract(["--out", out]);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).to.match(/\.osd-hana\//);
  });

  it("M-2d: a scope larger than one chunk is dumped in parts, one request per part, and converts as one repository (mutation: chunking dropped)", async function () {
    const out = await fresh("m2d");
    const from = recordLines().length;
    const r = await runExtract(["--out", out], {chunk: 5});
    expect(r.code).to.equal(3);
    const reqs = dumpRequests(from);
    expect(reqs.length).to.equal(3); // ceil(14 / 5)
    const dumpDir = join(out, ".osd-hana", "dump");
    for (const part of ["part-00001", "part-00002", "part-00003"]) {
      expect(existsSync(join(dumpDir, part, "objects.jsonl")), part).to.equal(true);
      expect(existsSync(join(dumpDir, part, "manifest.json")), part).to.equal(true);
    }
    // the aggregate manifest echoes the whole request and is what reuse reads
    const aggregate = JSON.parse(readFileSync(join(dumpDir, "manifest.json"), "utf8"));
    expect(aggregate.sidecar.parts.length).to.equal(3);
    expect(aggregate.sidecar.errors).to.deep.equal([]);
    // the repository is complete across the parts
    expect(existsSync(join(out, "src/osd_x/zcl_osd_x1.clas.abap"))).to.equal(true);
    expect(existsSync(join(out, "src/osd_x/zddl_xb.ddls.asddls"))).to.equal(true);
    // a restart reuses the chunked dump without re-running any dump
    const from2 = recordLines().length;
    const r2 = await runExtract(["--out", out], {chunk: 5});
    expect(r2.code).to.equal(3);
    expect(dumpRequests(from2).length).to.equal(0);
    expect(reportOf(out).dump_reused).to.equal(true);
  });

  it("M-3: the sidecar's own errors are ledger lines and exit 3, never 'all written' (mutation: partial treated as done, errors dropped)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).filter((o) => ["CLAS", "INTF", "DTEL"].includes(o.type) && o.class === "customer"));
    });
    const out = await fresh("m3");
    const r = await runExtract(["--out", out], {
      list: fx.list, dump: fx.dump,
      extra: {FAKE_SIDECAR_EXIT: "3", FAKE_SIDECAR_ERRORS: JSON.stringify([{name: "ZCL_OSD_X1=>M", error: "definition hidden"}, {error: "catalog read failed"}])},
    });
    expect(r.code, "a sidecar error is exit 3").to.equal(3);
    const rep = reportOf(out);
    expect(rep.sentence ?? "").to.not.match(/^all .* written/);
    expect(rep.dump_partial).to.equal(true);
    // the named error is a ledger line on its object
    const clas = rep.objects.find((o) => o.name === "ZCL_OSD_X1");
    const part = clas.parts.find((p) => p.part === "dump error");
    expect(part, "the error names its object").to.exist;
    expect(part.disposition).to.equal("not written");
    expect(part.reason).to.match(/definition hidden/);
    expect(clas.status).to.equal("written-partial");
    // the unnamed error is a run-level line
    expect(rep.dump_errors).to.be.an("array");
    expect(rep.dump_errors.map((e) => e.error ?? e)).to.deep.equal(["catalog read failed"]);
    const md = readOutReport(out);
    expect(md).to.match(/dump errors/).and.to.match(/catalog read failed/);
  });

  it("M-4: a source the dump could not deliver is a part line and written-partial, exit 3 (mutation: the error row goes to errors only)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).filter((o) => o.name === "ZCL_OSD_X1"));
      writeReposrc(dump, reposrcRows(dump).concat([
        {program: pad("ZCL_OSD_X1") + "CCIMP", state: "A", error: "decompress: unexpected end of stream"},
        {program: pad("ZCL_OSD_X1") + "CCAU", state: "A", file: "/etc/hostname"},
      ]));
    });
    const out = await fresh("m4");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code, "not exit 0").to.equal(3);
    const rep = reportOf(out);
    const e = rep.objects.find((o) => o.name === "ZCL_OSD_X1");
    expect(e.status).to.equal("written-partial");
    const ccimp = e.parts.find((p) => /CCIMP/.test(p.part));
    expect(ccimp, "the failed include is named").to.exist;
    expect(ccimp.disposition).to.equal("not written");
    expect(ccimp.reason).to.match(/decompress/);
    const ccau = e.parts.find((p) => /CCAU/.test(p.part));
    expect(ccau, "the unusable path is named").to.exist;
    expect(ccau.disposition).to.equal("not written");
    expect(rep.errors.length).to.be.at.least(1);
  });

  it("M-4b: local classes in both CL and CCIMP leave a part line, not silence (mutation: the CCIMP drop is silent again)", async function () {
    const fx = variant((list, dump) => {
      writeFileSync(join(dump, "src", "ZCL_OSD_X1=====CL.abap"), "class lcl_local definition.\nendclass.\n");
      writeFileSync(join(dump, "src", "ZCL_OSD_X1=====CCIMP.abap"), "class lcl_other definition.\nendclass.\n");
      writeReposrc(dump, reposrcRows(dump).concat([
        {program: pad("ZCL_OSD_X1") + "CL", state: "A", file: "src/ZCL_OSD_X1=====CL.abap"},
        {program: pad("ZCL_OSD_X1") + "CCIMP", state: "A", file: "src/ZCL_OSD_X1=====CCIMP.abap"},
      ]));
    });
    const out = await fresh("m4b");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const e = reportOf(out).objects.find((o) => o.name === "ZCL_OSD_X1");
    expect(e.status).to.equal("written-partial");
    expect(e.parts.some((p) => /CCIMP/.test(JSON.stringify(p)))).to.equal(true);
  });

  it("M-5a: a foreign directory is refused even when it holds only src/ and .abapgit.xml (mutation: the fixed fresh-list counts as ours again)", async function () {
    const out = await fresh("m5a");
    mkdirSync(join(out, "src"), {recursive: true});
    writeFileSync(join(out, "src", "my-only-copy.abap"), "REPORT zmine.\n");
    writeFileSync(join(out, ".abapgit.xml"), "<mine/>\n");
    const r = await runExtract(["--out", out]);
    expect(r.code).to.equal(4);
    expect(r.lines.err.join("\n")).to.match(/not created by this command|marker/);
    expect(readFileSync(join(out, "src", "my-only-copy.abap"), "utf8")).to.equal("REPORT zmine.\n");
    expect(readFileSync(join(out, ".abapgit.xml"), "utf8")).to.equal("<mine/>\n");
  });

  it("M-5b: a run marks .osd-hana/ as ours and lists what it wrote, with hashes (mutation: the marker not written)", async function () {
    const out = await fresh("m5b");
    await runExtract(["--out", out]);
    const marker = JSON.parse(readFileSync(join(out, ".osd-hana", "marker.json"), "utf8"));
    expect(marker.tool).to.match(/extract/);
    const listed = new Map(marker.files.map((f) => [f.path, f.sha256]));
    expect(listed.has(".abapgit.xml")).to.equal(true);
    expect(listed.has(".gitignore")).to.equal(true);
    const sha = (p) => createHash("sha256").update(readFileSync(join(out, p))).digest("hex");
    for (const [p, h] of listed) expect(h, p).to.equal(sha(p));
    expect(listed.has("src/osd_x/zcl_osd_x1.clas.abap")).to.equal(true);
  });

  it("M-5c: on restart only marker-listed unchanged files are replaced; a file the user changed is kept and reported (mutation: the hash check removed)", async function () {
    const out = await fresh("m5c");
    await runExtract(["--out", out]);
    const userCopy = "REPORT zmine_edited.\n* my local fix, do not lose\n";
    writeFileSync(join(out, "src/osd_x/zosd_x3.prog.abap"), userCopy);
    const r2 = await runExtract(["--out", out]);
    expect(r2.code).to.equal(3);
    // the user's file is still there, byte for byte
    expect(readFileSync(join(out, "src/osd_x/zosd_x3.prog.abap"), "utf8")).to.equal(userCopy);
    const rep = reportOf(out);
    const prog = rep.objects.find((o) => o.name === "ZOSD_X3");
    expect(prog.status).to.equal("skipped");
    expect(prog.reason).to.match(/kept/).and.to.match(/zosd_x3\.prog\.abap/);
    expect(rep.kept).to.be.an("array");
    expect(rep.kept.map((k) => k.path)).to.include("src/osd_x/zosd_x3.prog.abap");
    const md = readOutReport(out);
    expect(md).to.match(/kept/);
    // everything else was refreshed normally
    expect(rep.objects.find((o) => o.name === "ZCL_OSD_X1").status).to.equal("written-partial");
  });

  it("SHOULD-2: --sidecar-pin is a foreign pin -- refused without the flag, unpinned with it (mutation: the foreign pin is trusted)", async function () {
    const out = await fresh("s2pin");
    const r1 = await runExtract(["--out", out, "--sidecar-pin", pinPath], {pinFile: null});
    expect(r1.code).to.equal(1);
    expect(r1.lines.err.join("\n")).to.match(/not the module's own pin/).and.to.match(/--allow-unpinned-sidecar/);
    const out2 = await fresh("s2pin2");
    const r2 = await runExtract(["--out", out2, "--sidecar-pin", pinPath, "--allow-unpinned-sidecar"], {pinFile: null});
    expect(r2.code).to.equal(3);
    expect(reportOf(out2).sidecar.pinned).to.equal(false);
  });

  it("SHOULD-4: two objects planning the same repo path refuse each other, never last-writer-wins (mutation: the path-collision check removed)", async function () {
    const fx = variant((list, dump) => {
      // /NS/COLLX and #NS#COLLX are different ids but the SAME file name
      for (const name of ["/NS/COLLX", "#NS#COLLX"]) {
        writeTable(dump, "DD02L", tableRows(dump, "DD02L").concat([{TABNAME: name, AS4LOCAL: "A", TABCLASS: "TRANSP", DDTEXT: "collide"}]));
        writeTable(dump, "DD02T", tableRows(dump, "DD02T").concat([{TABNAME: name, AS4LOCAL: "A", DDLANGUAGE: "E", DDTEXT: "collide"}]));
        writeTable(dump, "DD03L", tableRows(dump, "DD03L").concat([{TABNAME: name, AS4LOCAL: "A", FIELDNAME: "MANDT", POSITION: "0001", KEYFLAG: "X", ROLLNAME: "MANDT", COMPTYPE: "E", ADMINFIELD: "0", DEPTH: "00"}]));
        writeTable(dump, "TADIR", tableRows(dump, "TADIR").concat([tadirRow("TABL", name, "$OSD_X")]));
        for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).concat([row({type: "TABL", name, package: "$OSD_X"})]));
      }
    });
    const out = await fresh("s4c");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const a = rep.objects.find((o) => o.name === "/NS/COLLX");
    const b = rep.objects.find((o) => o.name === "#NS#COLLX");
    expect(a.status).to.equal("skipped");
    expect(b.status).to.equal("skipped");
    expect(a.reason).to.match(/output path collision/);
    expect(b.reason).to.match(/output path collision/);
    expect(rep.totals.written + rep.totals.writtenPartial + rep.totals.skipped + rep.totals.unsupported).to.equal(rep.totals.inScope);
  });

  it("SHOULD-5: an exact duplicate listing row is de-duplicated, not mourned as a case collision (mutation: the dedupe removed)", async function () {
    const fx = variant((list) => {
      const rows = objectsRows(list);
      writeObjects(list, [...rows, rows.find((o) => o.name === "ZIF_OSD_X2")]);
    });
    const out = await fresh("s5");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    expect(rep.totals.inScope).to.equal(14);
    expect(rep.objects.filter((o) => /differs from another in-scope object only by case/.test(o.reason ?? ""))).to.deep.equal([]);
    expect(rep.objects.filter((o) => o.name === "ZIF_OSD_X2").length).to.equal(1);
    expect(rep.ledger_error).to.equal(undefined);
  });

  it("SHOULD-6: control characters in names never reach the terminal or the report raw (mutation: the sanitizer removed)", async function () {
    const fx = variant((list, dump) => {
      writeObjects(list, objectsRows(list).map((o) => o.type === "SICF" ? {...o, package: "$OSD_X\u001b[2K\u001b[1A\rplan: 0 objects in scope"} : o));
      writeObjects(dump, objectsRows(dump).map((o) => o.type === "SICF" ? {...o, package: "$OSD_X\u001b[2K\u001b[1A\rplan: 0 objects in scope"} : o));
    });
    const out = await fresh("s6");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    expect(r.lines.out.some((l) => l.includes("\u001b")), "stdout plan clean").to.equal(false);
    const md = readOutReport(out);
    expect(md.includes("\u001b")).to.equal(false);
    expect(md).to.match(/x1b/); // the name is still there, escaped, findable
  });

  it("SHOULD-7: a user include carrying the generated-marker comment is not written and gets its line (mutation: the silent skip restored)", async function () {
    const fx = variant((list, dump) => {
      writeFileSync(join(dump, "src", "LZOSG_X4F01.abap"), "* copied header: generated by the function library\nFORM my_real_code.\nENDFORM.\n");
      writeReposrc(dump, reposrcRows(dump).concat([{program: "LZOSG_X4F01", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 3, sha256: "1".repeat(64), file: "src/LZOSG_X4F01.abap"}]));
    });
    const out = await fresh("s7");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const fugr = rep.objects.find((o) => o.name === "ZOSG_X4");
    const part = fugr.parts.find((p) => /F01/i.test(p.part));
    expect(part, "the include gets its line").to.exist;
    expect(part.disposition).to.equal("not written");
    expect(part.reason).to.match(/generated/i);
    expect(existsSync(join(out, "src/osd_x/zosg_x4.fugr.lzosg_x4f01.abap"))).to.equal(false);
  });

  it("SHOULD-1: TABL foreign keys, indexes, search-help assignments and component texts are part lines; the object is written-partial (mutation: the TABL claims stay silent)", async function () {
    const out = await fresh("sh1");
    const r = await runExtract(["--out", out]);
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const tabl = rep.objects.find((o) => o.name === "ZTAB_X5");
    expect(tabl.status).to.equal("written-partial");
    // the dump CARRIES the foreign keys (DD05S/DD08L): "not extracted"
    const fks = tabl.parts.find((p) => /foreign key/i.test(p.part));
    expect(fks.disposition).to.equal("not extracted");
    expect(fks.reason).to.match(/DD05S|DD08L/);
    // the dump carries no index tables: "not checked"
    const idx = tabl.parts.find((p) => /index/i.test(p.part));
    expect(idx.disposition).to.equal("not checked");
    expect(tabl.parts.some((p) => /search-help/i.test(p.part))).to.equal(true);
    expect(tabl.parts.some((p) => /component text/i.test(p.part))).to.equal(true);
    const namespaced = rep.objects.find((o) => o.name === "/NS/ZTAB_Y1");
    expect(namespaced.status).to.equal("written-partial");
  });

  it("SHOULD-1: CLAS and INTF component texts are 'not checked'; other-language class texts are 'not extracted' (mutation: the CLAS claims stay silent)", async function () {
    const fx = variant((list, dump) => {
      writeTable(dump, "SEOCLASSTX", tableRows(dump, "SEOCLASSTX").concat([{CLSNAME: "ZCL_OSD_X1", LANGU: "D", DESCRIPT: "Synthetische Klasse"}]));
    });
    const out = await fresh("sh1c");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const clas = rep.objects.find((o) => o.name === "ZCL_OSD_X1");
    expect(clas.status).to.equal("written-partial");
    expect(clas.parts.some((p) => p.disposition === "not checked" && /component text/i.test(p.reason))).to.equal(true);
    expect(clas.parts.some((p) => p.disposition === "not extracted" && /language D/.test(p.reason))).to.equal(true);
    const intf = rep.objects.find((o) => o.name === "ZIF_OSD_X2");
    expect(intf.status).to.equal("written-partial");
  });

  it("NOTE-3: a working tree whose .git is a symlink is still a git tree (mutation: lstat only)", async function () {
    const s = variant();
    const real = await fresh("n3-realgit");
    execFileSync("git", ["init", "-q", real]);
    const wt = await fresh("n3-wt");
    symlinkSync(join(real, ".git"), join(wt, ".git"));
    const r = await runExtract(["--out", join(wt, "x"), "--include-sap", "--name", "Z%"], {list: s.list, dump: s.dump});
    expect(r.code).to.equal(4);
    expect(r.lines.err.join("\n")).to.match(/vendor content must not be published/);
  });

  it("NOTE-5: a symlink inside the dump is not followed out of the dump directory (mutation: the containment check removed)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).filter((o) => o.name === "ZCL_OSD_X1"));
      symlinkSync("/etc/hostname", join(dump, "src", "ZCL_OSD_X1=====CCAU.abap"));
      writeReposrc(dump, reposrcRows(dump).concat([{program: pad("ZCL_OSD_X1") + "CCAU", state: "A", file: "src/ZCL_OSD_X1=====CCAU.abap"}]));
    });
    const out = await fresh("n5");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const e = reportOf(out).objects.find((o) => o.name === "ZCL_OSD_X1");
    expect(e.status).to.equal("written-partial");
    const part = e.parts.find((p) => /CCAU/.test(p.part));
    expect(part, "the symlinked include is a part line").to.exist;
    expect(part.disposition).to.equal("not written");
    expect(part.reason).to.match(/dump directory/);
    expect(readOutReport(out)).to.not.match(/hostname/);
  });
});
