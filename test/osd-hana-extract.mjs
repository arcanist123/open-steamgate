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
import {PassThrough} from "node:stream";

import {extractMain, accountsFor} from "../tools/osd-hana/extract.mjs";
import {reusableDump, inGitTree} from "../tools/osd-hana/extract.mjs";
import {buildDumpRequest, isLargePlan, largePlanNumbers} from "../tools/osd-hana/extract-plan.mjs";
import {decideFolderLogic, folderPaths} from "../tools/osd-hana/convert/convert.mjs";
import {targetKey} from "../tools/osd-hana/sidecar.mjs";
import {buildExtractFixtures, addNamespacedFunctionGroup, addSiblingFunctionGroups} from "./osd-hana/extract-fixtures.mjs";
import {resolveProgramOwner} from "../tools/osd-hana/convert/ownership.mjs";

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

async function runExtract(argv, {env = {}, out, list, dump, pinFile: pinFileOpt, chunk, extra = {}, yes = true, tty = false, answers} = {}) {
  const from = recordLines().length;
  const lines = {out: [], err: [], from};
  const io = {out: (l) => lines.out.push(l), err: (l) => lines.err.push(l)};
  const runEnv = {
    ...process.env,
    OSD_HANA_DUMP: fakePath,
    OSD_HANA_PASSWORD: PASSWORD,
    ...env,
  };
  // the consent seam (fix round 3): the suite's runs are non-interactive by
  // default and carry --yes, so the round-2 tests keep meaning "the run went
  // all the way"; a test of the consent gate passes yes:false (and tty/answers
  // for the terminal form).
  const stdin = tty ? (() => { const s = new PassThrough(); s.isTTY = true; s.end(`${answers ?? "n"}\n`); return s; })() : {isTTY: false};
  // `pinFile` is the TRUSTED seam (the embedding host's own pin, critic S-E);
  // the default test path names it there, a `--sidecar-pin` on ARGV is the
  // public input and must never produce a "pinned" verdict on its own.
  const argvPin = argv.includes("--sidecar-pin");
  const code = await extractMain([
    "--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA,
  ].concat(yes ? ["--yes"] : []).concat(argv), {
    io,
    env: runEnv,
    stdin,
    isTTY: tty,
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
    expect(clas.status).to.equal("written"); // component texts are only 'not checked' -- written, carrying its unchecked list (round 4)
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

    // a dump whose sidecar ended with errors: the manifest says so, the run
    // refuses the directory, never mixes (M-3 makes the FIRST run loud too)
    const unfinished = await fresh("unfinished-dump");
    await runExtract(["--out", unfinished]);
    const manifestPath = join(unfinished, ".osd-hana", "dump", "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.sidecar.errors = ["table TFDIR: boom"];
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 1));
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
    expect(rep.totals.written).to.equal(12); // DTEL, DOMA, TTYP, SHLP, VIEW, DDLS + CLAS/INTF (component texts) + 2 PROG + FUGR + /NS/ZTAB_Y1 (round 5: no foreign keys OF ITS OWN)
    expect(rep.totals.writtenPartial).to.equal(1); // ZTAB_X5: the dump carries ITS foreign keys and they are not written
    expect(rep.totals.unsupported).to.equal(1);
    expect(rep.totals.skipped).to.equal(0);
    expect(rep.totals.written + rep.totals.writtenPartial + rep.totals.skipped + rep.totals.unsupported).to.equal(rep.totals.inScope);
    expect(rep.totals.dumped).to.equal(15);
    expect(rep.sentence).to.match(/^2 objects of 14 could not be fully extracted \(SICF 1, TABL 1\)\./);
    expect(rep.sentence).to.match(/12 objects written\. For 6 of them this tool could not check: /);
    expect(rep.sentence).to.match(/component texts \(SEOCOMPOTX\) 2/).and.to.match(/dynpros 3/).and.to.match(/variants 3/);
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
    expect(r2.lines.err.join("\n")).to.match(/does not exist to say this command created/);
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
    const zpk = folderPaths(new Set(["$ZPK", "ZPK"]), new Map([["ZPK", ""], ["$ZPK", ""]]), "FULL");
    expect(zpk.paths.get("$ZPK")).to.equal("zpk/");
    expect(zpk.paths.get("ZPK")).to.equal("zpk/");
    expect([...zpk.collisions].sort()).to.deep.equal(["$ZPK", "ZPK"]); // plain sort: '$' sorts before letters
    const coll = folderPaths(new Set(["TMP", "$TMP"]), new Map(), "FULL");
    expect(coll.paths.get("$TMP")).to.equal("tmp/");
    expect([...coll.collisions].sort()).to.deep.equal(["$TMP", "TMP"]);
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
    expect(totalsLine).to.match(/in scope 14 = written 11 \+ written-partial 1 \+ skipped 1 \+ unsupported 1/);
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
    expect(part.disposition).to.equal("not extracted");
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

  it("M4: PROG and FUGR are written carrying 'not checked' parts for screens, GUI status and variants -- not written-partial (mutation: the not-checked lines removed; round 4: unchecked counted as partial)", async function () {
    const out = await fresh("m4");
    const r = await runExtract(["--out", out]);
    const rep = reportOf(out);
    for (const name of ["ZOSD_X3", "ZOSD_XD"]) {
      const o = rep.objects.find((x) => x.name === name);
      expect(o.status, `${name}: only not-checked parts`).to.equal("written");
      expect(r.code).to.equal(3); // the SICF and the TABLs still make this run partial
      for (const part of ["dynpros", "GUI status", "variants"]) {
        const p = o.unchecked.find((x) => x.part === part);
        expect(p, `${name}: ${part}`).to.exist;
        expect(p.disposition).to.equal("not checked");
      }
      expect(o.parts, `${name}: no not-extracted part`).to.deep.equal([]);
    }
    const fugr = rep.objects.find((x) => x.name === "ZOSG_X4");
    expect(fugr.unchecked.map((p) => p.part))
      .to.deep.equal(["documentation of Z_OSD_X4_FM", "dynpros", "GUI status", "variants"]);
    const md = readOut(out, "extract-report.md");
    expect(md).to.match(/program screens, GUI statuses and variants are not checked/);
    // the per-object unchecked lists sit in a collapsed section, not in the top sentence
    expect(md).to.match(/<details>/).and.to.match(/could not check/);
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
    expect(paths.paths.get("ZGRAND")).to.equal("zgrand/");
    expect(paths.paths.get("ZTOP")).to.equal("zgrand/ztop/");
    expect(paths.paths.get("ZTOPSUB")).to.equal("zgrand/ztop/ztopsub/");
    expect(paths.paths.get("ZOTHER")).to.equal("zother/");

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

  it("S4: a restart reports drift for objects that appeared since the dump (mutation: the drift report removed)", async function () {
    const out = await fresh("s4");
    const first = await runExtract(["--out", out]);
    expect(first.code).to.equal(3);
    const fx = variant((list) => {
      writeObjects(list, objectsRows(list).concat([{...row({type: "CLAS", name: "ZCL_NEW_1", package: "$OSD_X"}), files: []}]));
    });
    const second = await runExtract(["--out", out], {list: fx.list});
    expect(second.code).to.equal(3);
    expect(second.runs()).to.deep.equal(["--version", "list"]); // reused: no second dump
    const rep = reportOf(out);
    expect(rep.dump_reused).to.equal(true);
    expect(rep.drift.appeared).to.deep.equal(["CLAS:ZCL_NEW_1"]);
    expect(rep.drift.disappeared).to.deep.equal([]);
    const neu = rep.objects.find((o) => o.name === "ZCL_NEW_1");
    expect(neu.status).to.equal("skipped");
    expect(neu.reason).to.match(/not-in-dump/);
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
    expect(original.status).to.equal("written"); // INTF component texts are only 'not checked' (SHOULD-1, round 4)
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
    expect(p.disposition).to.equal("not extracted");
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
    // composite objects carry the include-name pattern their sources hide
    // behind: a class's REPOSRC names are the 30-character '='-padded name
    // plus a suffix; a group's are the main program EXACTLY (SAPL<grp>) and
    // the includes as L<grp> + exactly 3 wildcard characters (round 6) -- no
    // bare `L<grp>%`, which would also prefix a longer sibling group's
    // includes). TADIR selection stays exact (the padded prefix names exactly
    // one object).
    expect(req.names).to.include("ZCL\\_OSD\\_X1" + "=".repeat(20) + "%");
    expect(req.names).to.include("SAPLZOSG\\_X4");
    expect(req.names).to.not.include("SAPLZOSG\\_X4%");
    // round 6 (CRITIC round 4 MUST-2): an include is EXACTLY L<grp> + 3
    // characters -- one pattern, three single-character wildcards, no letter
    expect(req.names).to.include("LZOSG\\_X4___");
    expect(req.names.filter((n) => n.startsWith("LZOSG\\_X4") && n !== "LZOSG\\_X4___")).to.deep.equal([]);
    expect(req.names).to.not.include("LZOSG\\_X4%");
    // every in-scope name is there; the vendor's is not, in no spelling
    const unescaped = req.names.map((n) => n.replace(/\\(.)/g, "$1"));
    expect(unescaped.filter((n) => n.includes("SAP_XE"))).to.deep.equal([]);
    for (const inScope of ["ZCL_OSD_X1", "ZOSD_X3", "ZOSG_X4", "ZTAB_X5", "ZSICF_XC"]) {
      expect(unescaped).to.include(inScope);
    }
    expect(req.names.length).to.equal(37); // 14 exact + 2 padded class patterns + the group's 21 shape patterns
  });

  it("M-2b: a dump that delivers objects outside the scope fails the run and names the dump directory (mutation: the audit removed)", async function () {
    const fx = variant((list, dump) => {
      // the vendor source sits in the fixture dump, as the sidecar would have
      // written it for a matched pattern
      writeFileSync(join(dump, "src", "ZCL_SAP_XX=====CS.abap"), "class ZCL_SAP_XX definition. \"VENDOR SOURCE\nendclass.\n");
    });
    // ... and the sidecar over-delivers: the row lands in the dump's
    // objects.jsonl AFTER the request filter (FAKE_SIDECAR_DUMP_APPEND)
    const appendPath = join(root, `append-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendPath, JSON.stringify({type: "CLAS", name: "ZCL_SAP_XX", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W", files: [{path: "src/ZCL_SAP_XX=====CS.abap", state: "A", sha256: "0".repeat(64), bytes: 60}]}) + "\n");
    const out = await fresh("m2b");
    const r = await runExtract(["--out", out, "--name", "Z%"], {list: fx.list, dump: fx.dump, extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
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
    expect(reqs.length).to.equal(8); // ceil(37 / 5): 14 exact + 2 padded class patterns + the group's 21 shape patterns
    const dumpDir = join(out, ".osd-hana", "dump");
    for (const part of ["part-00001", "part-00002", "part-00003", "part-00004", "part-00005", "part-00006", "part-00007", "part-00008"]) {
      expect(existsSync(join(dumpDir, part, "objects.jsonl")), part).to.equal(true);
      expect(existsSync(join(dumpDir, part, "manifest.json")), part).to.equal(true);
    }
    // the aggregate manifest echoes the whole request and is what reuse reads
    const aggregate = JSON.parse(readFileSync(join(dumpDir, "manifest.json"), "utf8"));
    expect(aggregate.sidecar.parts.length).to.equal(8);
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
    expect(part.disposition).to.equal("not extracted");
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
    expect(ccimp.disposition).to.equal("not extracted");
    expect(ccimp.reason).to.match(/decompress/);
    const ccau = e.parts.find((p) => /CCAU/.test(p.part));
    expect(ccau, "the unusable path is named").to.exist;
    expect(ccau.disposition).to.equal("not extracted");
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
    // everything else was refreshed normally (the CLAS is written-partial for
    // its own reasons -- SHOULD-1 --, not because of the kept file)
    expect(rep.objects.find((o) => o.name === "ZCL_OSD_X1").status).to.match(/^written/);
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

  it("SHOULD-4: the accounts gate compares the listing's in-scope ids with the ledger keys as sets (mutation: accounts always true)", async function () {
    expect(accountsFor(new Set(["CLAS:A", "PROG:B"]), [{id: "CLAS:A"}, {id: "PROG:B"}]).accounts).to.equal(true);
    expect(accountsFor(new Set(["CLAS:A"]), [{id: "CLAS:A"}, {id: "CLAS:A"}]).accounts, "duplicate ledger key").to.equal(false);
    expect(accountsFor(new Set(["CLAS:A", "PROG:B"]), [{id: "CLAS:A"}]).accounts, "missing key").to.equal(false);
    expect(accountsFor(new Set(["CLAS:A"]), [{id: "CLAS:A"}, {id: "PROG:B"}]).accounts, "extra key").to.equal(false);
    expect(accountsFor(new Set(["CLAS:A"]), [{id: "CLAS:a"}]).accounts, "ids are exact").to.equal(false);
    const out = await fresh("s4g");
    await runExtract(["--out", out]);
    expect(reportOf(out).totals.accounts).to.equal(true);
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
    expect(part.disposition).to.equal("not extracted");
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
    // the dump CARRIES the foreign keys (DD05S/DD08L): "not extracted" --
    // the only kind of part that makes the object written-partial (round 4)
    const fks = tabl.parts.find((p) => /foreign key/i.test(p.part));
    expect(fks.disposition).to.equal("not extracted");
    expect(fks.reason).to.match(/DD05S|DD08L/);
    // the dump carries no index tables: "not checked" -- carried on the
    // object's unchecked list, never counting toward written-partial
    const idx = tabl.unchecked.find((p) => /index/i.test(p.part));
    expect(idx, "the index blind spot is on the unchecked list").to.exist;
    expect(idx.disposition).to.equal("not checked");
    expect(tabl.unchecked.some((p) => /search-help/i.test(p.part))).to.equal(true);
    expect(tabl.unchecked.some((p) => /component text/i.test(p.part))).to.equal(true);
    const namespaced = rep.objects.find((o) => o.name === "/NS/ZTAB_Y1");
    // round 5 (SHOULD-3): the dump carries DD05S/DD08L, but holds NO rows for
    // THIS table -- the table has no foreign keys the dump shows, so it is
    // written, not partial (the DD tables existing is not a loss)
    expect(namespaced.status).to.equal("written");
    expect(namespaced.parts.some((p) => /foreign key/i.test(p.part))).to.equal(false);
    expect(namespaced.unchecked.some((p) => /foreign key/i.test(p.part))).to.equal(false);
    // its blind spots (the aspects the dump carries no files for) are unchanged
    expect(namespaced.unchecked.some((p) => /index/i.test(p.part))).to.equal(true);
    expect(namespaced.unchecked.some((p) => /search-help/i.test(p.part))).to.equal(true);
    expect(namespaced.unchecked.some((p) => /component text/i.test(p.part))).to.equal(true);
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
    expect(clas.status).to.equal("written-partial"); // the language-D class text EXISTS in the dump and is not written
    expect(clas.unchecked.some((p) => p.disposition === "not checked" && /component text/i.test(p.reason))).to.equal(true);
    expect(clas.parts.some((p) => p.disposition === "not extracted" && /language D/.test(p.reason))).to.equal(true);
    const intf = rep.objects.find((o) => o.name === "ZIF_OSD_X2");
    expect(intf.status).to.equal("written"); // only the component-text blind spot
    expect(intf.unchecked.some((p) => /component text/i.test(p.reason))).to.equal(true);
  });

  it("NOTE-1: a run whose only parts are 'not checked' exits 0 and says so -- a signal that is always on is no signal (round 4; mutation: unchecked-only kept at exit 3)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).filter((o) => ["PROG", "FUGR"].includes(o.type) && o.class === "customer"));
    });
    const out = await fresh("n1");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(0); // every non-checked part is a blind spot, not a loss
    const rep = reportOf(out);
    expect(rep.sentence).to.match(/^3 objects written\. For 3 of them this tool could not check: /).and.to.match(/not checked|could not check/);
    // and where something is really lost, the sentence says "could not be fully extracted" as before
    const out2 = await fresh("n1b");
    await runExtract(["--out", out2]);
    expect(reportOf(out2).sentence).to.match(/could not be fully extracted/);
  });

  it("NOTE-4: a function name from TFDIR that is not a usable file name is a part line, not a run-ending throw (mutation: the component check removed)", async function () {
    const fx = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects(dir, objectsRows(dir).filter((o) => o.type === "FUGR"));
      // the hostile name reaches a file name through TFDIR.FUNCNAME; its
      // include resolves through TFDIR.INCLUDE like any function's
      writeFileSync(join(dump, "src", "LZOSG_X4U02.abap"), "FUNCTION z_evil.\nENDFUNCTION.\n");
      writeReposrc(dump, reposrcRows(dump).concat([{program: "LZOSG_X4U02", state: "A", changed_by: "DEVUSER", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file: "src/LZOSG_X4U02.abap"}]));
      writeTable(dump, "TFDIR", tableRows(dump, "TFDIR").concat([{FUNCNAME: "Z_E\\VIL", PNAME: "SAPLZOSG_X4", PNAME_MAIN: "", INCLUDE: "02", FMODE: "", UTASK: ""}]));
    });
    const out = await fresh("n4");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3); // the run continues -- not the internal error the backstop throw produced
    const rep = reportOf(out);
    expect(rep.internal_error).to.equal(undefined);
    const fugr = rep.objects.find((o) => o.name === "ZOSG_X4");
    expect(fugr.parts.some((p) => /usable file name/.test(p.reason ?? "") && /VIL/.test(p.part))).to.equal(true);
    expect(readdirSync(join(out, "src", "osd_x")).some((f) => f.includes("\\"))).to.equal(false);
  });

  it("NOTE-7: DDIC texts prefer the master language over E, and carry its language key (mutation: E preferred again)", async function () {
    const fx = variant((list, dump) => {
      writeTable(dump, "TADIR", tableRows(dump, "TADIR").map((r) => ({...r, MASTERLANG: "D"})));
      writeTable(dump, "DD02T", tableRows(dump, "DD02T").concat([{TABNAME: "ZTAB_X5", AS4LOCAL: "A", DDLANGUAGE: "D", DDTEXT: "Synthetische Tabelle"}]));
    });
    const out = await fresh("n7");
    await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    const xml = readFileSync(join(out, "src/osd_x/ztab_x5.tabl.xml"), "utf8");
    expect(xml).to.match(/<DDLANGUAGE>D<\/DDLANGUAGE>/);
    expect(xml).to.match(/<DDTEXT>Synthetische Tabelle<\/DDTEXT>/);
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
    expect(part.disposition).to.equal("not extracted");
    expect(part.reason).to.match(/dump directory/);
    expect(readOutReport(out)).to.not.match(/hostname/);
  });
});

// ------------------------------------------------------- fix round 3
// Part B (the coordinator's decision): local objects stay IN the default
// scope, but nothing is dumped without the user having seen the plan --
// consent, the real numbers in the question, the per-author table, and a
// large plan that needs --yes-large. Each test names the mutation that must
// turn it RED.
describe("osd hana extract -- fix round 3 (the default scope must not surprise)", function () {

  const outText = (lines) => lines.out.join("\n");
  const readJsonlL = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const objectsRowsL = (dir) => readJsonlL(dir, "objects.jsonl");
  const writeObjectsL = (dir, rows) => writeFileSync(join(dir, "objects.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const rowL = (o) => ({type: o.type, name: o.name, package: o.package, author: o.author ?? "DEVUSER", class: "customer", state: "A", status: "W", files: []});
  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx3-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }
  const dumpRequests = (from = 0) => recordLines().slice(from)
    .map((l) => JSON.parse(l)).filter((e) => e.argv[0] === "dump").map((e) => e.request);

  it("B: no dump without consent -- a terminal 'n' after the plan leaves nothing (mutation: the consent gate removed)", async function () {
    const out = await fresh("r3-tty-n");
    const r = await runExtract(["--out", out], {yes: false, tty: true, answers: "n"});
    expect(r.code, "a decline is not an error").to.equal(0);
    expect(r.runs()).to.deep.equal(["--version", "list"]); // the plan ran, the dump did not
    expect(existsSync(join(out, "src"))).to.equal(false);
    expect(existsSync(join(out, ".osd-hana", "dump"))).to.equal(false);
    expect(r.lines.err.join("\n")).to.match(/declined/);
  });

  it("B: an accepted terminal answer dumps (the question was the only gate)", async function () {
    const out = await fresh("r3-tty-y");
    const r = await runExtract(["--out", out], {yes: false, tty: true, answers: "y"});
    expect(r.code).to.equal(3);
    expect(r.runs()).to.deep.equal(["--version", "list", "dump"]);
  });

  it("B: the consent question carries the REAL numbers of this plan (mutation: the numbers hard-coded or dropped)", async function () {
    // a plan whose real numbers no constant could guess: 14 objects, 2.0 MB
    const fx = variant((list) => {
      writeObjectsL(list, objectsRowsL(list).map((o) =>
        o.name === "ZCL_OSD_X1" ? {...o, source_bytes_compressed: 1_500_000}
          : o.name === "ZOSD_X3" ? {...o, source_bytes_compressed: 500_000}
            : o));
    });
    const out = await fresh("r3-numbers");
    const r = await runExtract(["--out", out], {yes: false, tty: true, answers: "n", list: fx.list});
    expect(r.code).to.equal(0); // declined
    const question = r.lines.out.find((l) => l.includes("into"));
    expect(question, "the question stands between the plan and the dump").to.exist;
    expect(question).to.match(/extract 14 objects \(2\.0 MB\) into /);
    expect(question).to.match(new RegExp(out.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    expect(question.endsWith("[y/N]")).to.equal(true);
  });

  it("B: a non-interactive run without --yes dumps nothing and says so (mutation: the consent gate removed)", async function () {
    const out = await fresh("r3-no-yes");
    const r = await runExtract(["--out", out], {yes: false});
    expect(r.code).to.equal(1);
    expect(r.lines.err.join("\n")).to.match(/--yes/).and.to.match(/consent/);
    expect(r.runs()).to.deep.equal(["--version", "list"]);
    expect(existsSync(join(out, "src"))).to.equal(false);
    expect(existsSync(join(out, ".osd-hana", "dump"))).to.equal(false);
  });

  it("B: --yes-large -- a LARGE plan refuses a plain --yes and proceeds with --yes-large (mutation: --yes accepted for a large plan)", async function () {
    // a LARGE selection: 5001 in-scope objects (one above the named number)
    const fx = variant((list) => {
      const rows = objectsRowsL(list);
      const extra = [];
      for (let i = 0; i < 5001; i++) {
        extra.push(rowL({type: "PROG", name: `ZBIG_${String(i).padStart(5, "0")}`, package: "$OSD_X"}));
      }
      writeObjectsL(list, rows.concat(extra));
    });
    const out = await fresh("r3-large-yes");
    const from = recordLines().length;
    const r = await runExtract(["--out", out], {yes: true, list: fx.list, dump: fx.dump});
    expect(r.code, "a plain --yes is not consent for a large plan").to.equal(1);
    expect(r.lines.err.join("\n")).to.match(/--yes-large/).and.to.match(/LARGE/).and.to.match(/5 000 objects \/ 200 MB/);
    expect(dumpRequests(from).length).to.equal(0); // refused before any dump

    const out2 = await fresh("r3-large-yeslarge");
    const from2 = recordLines().length;
    const r2 = await runExtract(["--out", out2, "--yes-large"], {yes: false, list: fx.list, dump: fx.dump});
    expect(r2.code).to.equal(3); // the selection runs; most rows are not in the dump fixture
    expect(dumpRequests(from2).length).to.be.at.least(10); // chunked, 5015 names
  });

  it("B: the plan carries a per-author table for local objects, the biggest packages, and the multi-author hint (mutation: the table removed)", async function () {
    const fx = variant((list, dump) => {
      writeObjectsL(list, objectsRowsL(list).map((o) =>
        o.name === "ZCL_OSD_X1" ? {...o, author: "SECONDDEV", source_bytes_compressed: 1_500_000}
          : o.name === "ZOSD_X3" ? {...o, author: "SECONDDEV", source_bytes_compressed: 500_000}
            : o));
    });
    const out = await fresh("r3-authors");
    const r = await runExtract(["--out", out, "--dry-run", "--json"], {list: fx.list});
    expect(r.code).to.equal(0);
    const doc = JSON.parse(r.lines.out.join("\n"));
    expect(doc.plan.localAuthors).to.equal(2);
    expect(doc.plan.perAuthor).to.deep.equal([
      {author: "DEVUSER", objects: 12, bytes: 0},
      {author: "SECONDDEV", objects: 2, bytes: 2_000_000},
    ]);
    expect(doc.plan.bytes).to.equal(2_000_000);
    expect(doc.plan.biggest[0]).to.deep.equal({package: "$OSD_X", objects: 13, bytes: 2_000_000});
    expect(doc.plan.biggest.length).to.be.at.least(2);

    // the terminal plan shows the same: the table, the biggest packages, the hint
    const out2 = await fresh("r3-authors-tty");
    const r2 = await runExtract(["--out", out2, "--dry-run"], {yes: false, tty: true, answers: "n", list: fx.list});
    const text = outText(r2.lines);
    expect(text).to.match(/per author \(local objects\):/);
    expect(text).to.match(/SECONDDEV\s+2\s+2\.0 MB/);
    expect(text).to.match(/DEVUSER\s+12\s+0\.0 MB/);
    expect(text).to.match(/biggest packages: \$OSD_X \(13, 2\.0 MB\), \$OSD_X_SUB \(1, 0\.0 MB\)/);
    expect(text).to.match(/local objects of 2 authors are in scope; narrow with --author <name> or --no-local/);

    // one author in scope: the hint is gone, the table shows one row
    const out3 = await fresh("r3-authors-narrow");
    const r3 = await runExtract(["--out", out3, "--dry-run", "--author", "SECONDDEV"], {list: fx.list});
    const text3 = outText(r3.lines);
    expect(text3).to.match(/SECONDDEV\s+2\s+2\.0 MB/);
    expect(text3).to.not.match(/local objects of .* authors are in scope/);
    expect(text3).to.not.match(/DEVUSER\s+\d/);
  });

  it("A: the audit catches a foreign object the include-pattern shapes COULD fetch (mutation: the audit trusts pattern-named rows)", async function () {
    // The FUGR include pattern LZOSG_X4% also PREFIXES a longer group's
    // includes (LZOSG_X4_SUBTOP...): if the sidecar resolves such a REPOSRC
    // hit to its TADIR object and reports it WITH sources, that is
    // over-delivery -- the run refuses and names the dump directory.
    // (The append seam is the filter's AFTER: exactly what a sidecar that
    // over-delivers would produce for a pattern-matched object.)
    const fx = variant((list, dump) => {
      writeFileSync(join(dump, "src", "LZOSG_X4_SUBTOP.abap"), "FUNCTION-POOL zosg_x4_sub. \"SAP-DELIVERED GROUP SOURCE\n");
    });
    const appendPath = join(root, `append-r3-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendPath, JSON.stringify({type: "FUGR", name: "ZOSG_X4_SUB", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W", files: [{path: "src/LZOSG_X4_SUBTOP.abap", state: "A", sha256: "0".repeat(64), bytes: 60}]}) + "\n");
    const out = await fresh("r3-a-audit");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump, extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(r.code, "over-delivery fails the run, not an ordinary partial").to.equal(4);
    expect(r.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/ZOSG_X4_SUB/).and.to.match(/Remove the dump directory/);
    expect(existsSync(join(out, "src")), "nothing was written").to.equal(false);
    // the twin shape: the same pattern shapes fetch a foreign INCLUDE's
    // source WITHOUT its TADIR object -- no in-scope owner resolves. Round 5
    // (SHOULD-1): the audit reads the SOURCES too, so this refuses the run
    // exactly like the reported object above -- foreign code on disk is
    // foreign code whether the sidecar reported it or not (with the
    // exact-shape request patterns this should not even be fetched any more;
    // the audit is the backstop for a sidecar that fetches it anyway).
    const fx2 = variant((list, dump) => {
      writeFileSync(join(dump, "src", "LZOSG_X4SUBF01.abap"), "FUNCTION z_foreign.\nENDFUNCTION.\n");
    });
    // the twin's REPOSRC row arrives AFTER the request filter (the seam for
    // "a sidecar fetched a source the request cannot justify") -- the same
    // shape FAKE_SIDECAR_DUMP_APPEND has for objects
    const appendSrcPath = join(root, `append-src-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendSrcPath, JSON.stringify({program: "LZOSG_X4SUBF01", state: "A", changed_by: "SAP", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file: "src/LZOSG_X4SUBF01.abap"}) + "\n");
    const out2 = await fresh("r3-a-ownerless");
    const r2 = await runExtract(["--out", out2], {list: fx2.list, dump: fx2.dump, extra: {FAKE_SIDECAR_REPOSRC_APPEND: appendSrcPath}});
    expect(r2.code, "an ownerless source refuses the run").to.equal(4);
    expect(r2.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/LZOSG_X4SUBF01/);
    expect(existsSync(join(out2, "src")), "nothing was written").to.equal(false);
    expect(existsSync(join(out2, ".osd-hana", "dump", "refused.json")), "the dump is marked refused").to.equal(true);
  });

  it("A: buildDumpRequest is the ONE place the request is built -- exact names, the measured pattern shapes (mutation: a pattern shape lost or a raw pattern sent)", async function () {
    const rows = [
      {type: "CLAS", name: "ZCL_A", package: "$OSD_X"},
      {type: "INTF", name: "ZIF_B", package: "$OSD_X"},
      {type: "FUGR", name: "ZOSG_C", package: "$OSD_X"},
      {type: "PROG", name: "ZOSD_D", package: "$OSD_X"},
      {type: "TABL", name: "ZTAB_E", package: "$OSD_X"},
      {type: "DDLS", name: "ZDDL_F", package: "$OSD_X"},
    ];
    const req = buildDumpRequest({rows, inactive: false});
    expect(req).to.deep.equal({
      schema: 1,
      names: [
        "LZOSG\\_C___",
        "SAPLZOSG\\_C",
        "ZCL\\_A", "ZCL\\_A" + "=".repeat(25) + "%",
        "ZDDL\\_F",
        "ZIF\\_B", "ZIF\\_B" + "=".repeat(25) + "%",
        "ZOSD\\_D",
        "ZOSG\\_C",
        "ZTAB\\_E",
      ],
      inactive: false,
      catalog: true,
      ddic: true,
      provenance: "osd hana extract",
    });
    // inactive travels; a user pattern never does
    expect(buildDumpRequest({rows: [rows[0]], inactive: true}).inactive).to.equal(true);
    expect(JSON.stringify(buildDumpRequest({rows}))).to.not.match(/ZOSD_%/);
    // the LARGE-plan rule, at the named boundaries (one place: LARGE_PLAN)
    expect(isLargePlan({inScope: 5000, bytes: 0})).to.equal(false);
    expect(isLargePlan({inScope: 5001, bytes: 0})).to.equal(true);
    expect(isLargePlan({inScope: 0, bytes: 200_000_000})).to.equal(false);
    expect(isLargePlan({inScope: 0, bytes: 200_000_001})).to.equal(true);
    expect(largePlanNumbers()).to.equal("5 000 objects / 200 MB");
  });
});


// ------------------------------------------------------- fix round 4
// "not checked" is not "partial" (the coordinator's decision): the two part
// kinds are kept apart everywhere -- ledger, json, md, console.
//   not-extracted = the dump shows the part exists and it was not written
//   (a failed include, foreign keys carried but not serialised, a text pool
//   left out, a sidecar error on the object);
//   not-checked   = the dump cannot tell whether the part exists.
// written-partial ONLY for not-extracted; only-unchecked objects are
// `written`, carrying their unchecked list; exit 3 only for not-extracted
// parts, skipped/unsupported objects, or errors. The summary never says
// "all"/"completely" while any unchecked part exists. Each test names the
// mutation that must turn it RED.
describe("osd hana extract -- fix round 4 ('not checked' is not 'partial')", function () {

  const readJsonl4 = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const objectsRows4 = (dir) => readJsonl4(dir, "objects.jsonl");
  const writeObjects4 = (dir, rows) => writeFileSync(join(dir, "objects.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const writeTable4 = (dump, t, rows) => writeFileSync(join(dump, "tables", `${t}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tableRows4 = (dump, t) => readJsonl4(join(dump, "tables"), `${t}.jsonl`);
  const noOverclaim = (s) => !/\b(all|completely)\b/i.test(s);

  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx4-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }
  // only the two PROGs: both convert, and their only part lines are the
  // screen/GUI/variant blind spots the dump cannot even check
  const progOnly = (list, dump) => {
    for (const dir of [list, dump]) writeObjects4(dir, objectsRows4(dir).filter((o) => o.type === "PROG"));
  };
  const tpoolHex4 = (id, k, entry, len) => {
    const s = id + k.padEnd(8, " ") + entry.padEnd(len, " ");
    const b = Buffer.alloc(2 + 2 * s.length);
    b.writeUInt16BE(len, 0);
    for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + 2 * i);
    return "0x" + b.toString("hex");
  };
  // ZOSD_X3 gains a German text pool: the dump SHOWS it exists, so leaving it
  // out is a not-extracted part -- a real loss, not a blind spot
  const withLoss = (list, dump) => {
    progOnly(list, dump);
    writeTable4(dump, "REPOTEXT", tableRows4(dump, "REPOTEXT").concat([{PROGNAME: "ZOSD_X3", LANGUAGE: "D", R3STATE: "A", DATA: tpoolHex4("I", "001", "Ueberschrift", 12)}]));
  };

  it("R4-1: an object with only not-checked parts is written, the run exits 0, and the top sentence carries the counts (mutation: unchecked parts still count as written-partial)", async function () {
    const fx = variant(progOnly);
    const out = await fresh("r4-unchecked-only");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code, "no not-extracted part, no skipped, no error: exit 0").to.equal(0);
    const rep = reportOf(out);
    for (const o of rep.objects) {
      expect(o.status, `${o.name}`).to.equal("written");
      expect(o.unchecked.length, `${o.name}: the blind spots are on the unchecked list`).to.be.at.least(3);
    }
    // the two counters (the ledger's set accounting is unchanged)
    expect(rep.totals.uncheckedObjects).to.equal(2);
    expect(rep.totals.uncheckedParts).to.equal(6);
    expect(rep.totals.notExtractedParts).to.equal(0);
    expect(rep.totals.unchecked).to.deep.equal([
      {kind: "dynpros", count: 2}, {kind: "GUI status", count: 2}, {kind: "variants", count: 2},
    ]);
    // the sentence: the coordinator's exact wording, once, with kinds + counts
    expect(rep.sentence).to.equal("2 objects written. For 2 of them this tool could not check: dynpros 2, GUI status 2, variants 2.");
    // on the console, once
    expect(r.lines.out.filter((l) => l.includes("could not check")).length, "once on the console").to.equal(1);
    // at the TOP of the md (before the metadata), and never "all"/"completely"
    const md = readFileSync(join(out, "extract-report.md"), "utf8");
    const top = md.indexOf("2 objects written. For 2 of them this tool could not check:");
    expect(top, "the sentence is at the top of the md").to.be.at.least(0);
    expect(top).to.be.below(md.indexOf("- out:"));
    expect(noOverclaim(md.slice(0, md.indexOf("\n", top)))).to.equal(true);
    // the per-object lists stay in the json and in a collapsed md section
    expect(md).to.match(/<details>/).and.to.match(/ZOSD_X3/);
  });

  it("R4-2: one not-extracted part makes the object written-partial and the run exit 3 (mutation: a known-missing part counted as merely unchecked)", async function () {
    const fx = variant(withLoss);
    const out = await fresh("r4-one-loss");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code, "the dump SHOWS the D text pool exists: a real loss").to.equal(3);
    const rep = reportOf(out);
    const lost = rep.objects.find((o) => o.name === "ZOSD_X3");
    expect(lost.status).to.equal("written-partial");
    const p = lost.parts.find((x) => /language D/.test(x.reason));
    expect(p, "the not-extracted part is a parts line").to.exist;
    expect(p.disposition).to.equal("not extracted");
    const fine = rep.objects.find((o) => o.name === "ZOSD_XD");
    expect(fine.status).to.equal("written");
    expect(rep.totals.notExtractedParts).to.equal(1);
    expect(rep.totals.writtenPartial).to.equal(1);
    expect(rep.sentence).to.match(/^1 object of 2 could not be fully extracted \(PROG 1\)\./);
    expect(rep.sentence).to.match(/1 object written\. For 1 of them this tool could not check: /);
    expect(noOverclaim(rep.sentence)).to.equal(true);
  });

  it("R4-3: the never-says-all rule -- both cases stay silent about completeness, the clean run may claim it (mutation: the 'all objects were written' sentence restored while unchecked parts exist)", async function () {
    // case A: only unchecked parts -- no sentence may say "all" or "completely"
    const fxA = variant(progOnly);
    const outA = await fresh("r4-all-a");
    await runExtract(["--out", outA], {list: fxA.list, dump: fxA.dump});
    const repA = reportOf(outA);
    expect(noOverclaim(repA.sentence), `sentence A: ${repA.sentence}`).to.equal(true);
    const mdA = readFileSync(join(outA, "extract-report.md"), "utf8");
    const topA = mdA.slice(0, mdA.indexOf("\n", mdA.indexOf("objects written")));
    expect(noOverclaim(topA), `md top A: ${topA}`).to.equal(true);

    // case B: one loss plus unchecked parts -- same rule
    const fxB = variant(withLoss);
    const outB = await fresh("r4-all-b");
    await runExtract(["--out", outB], {list: fxB.list, dump: fxB.dump});
    const repB = reportOf(outB);
    expect(noOverclaim(repB.sentence), `sentence B: ${repB.sentence}`).to.equal(true);

    // the clean run (nothing unchecked, nothing lost) MAY say "all"
    const fxC = variant((list, dump) => {
      for (const dir of [list, dump]) writeObjects4(dir, objectsRows4(dir).filter((o) => ["DTEL", "DOMA", "TTYP", "SHLP", "VIEW", "DDLS"].includes(o.type)));
    });
    const outC = await fresh("r4-all-clean");
    const rC = await runExtract(["--out", outC], {list: fxC.list, dump: fxC.dump});
    expect(rC.code).to.equal(0);
    expect(reportOf(outC).sentence).to.equal("all 6 objects in scope were written");
  });
});

// ------------------------------------------------------- fix round 5
// CRITIC round 3 (../w3fix5/CRITIC.md beside the task): MUST-1 (the audit
// skipped on a reused dump), MUST-2 (plan-only runs emptied the marker's
// file list) and the three SHOULDs (sources audited, namespaced groups,
// per-table written-partial). Each test names the mutation that must turn
// it RED.
describe("osd hana extract -- fix round 5 (the audit always; the marker never shrinks)", function () {

  const readJsonl5 = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const objectsRows5 = (dir) => readJsonl5(dir, "objects.jsonl");
  const writeObjects5 = (dir, rows) => writeFileSync(join(dir, "objects.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  const writeTable5 = (dump, t, rows) => writeFileSync(join(dump, "tables", `${t}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const tableRows5 = (dump, t) => readJsonl5(join(dump, "tables"), `${t}.jsonl`);
  const reposrcRows5 = (dump) => readJsonl5(dump, "reposrc.jsonl");
  const writeReposrc5 = (dump, rows) => writeFileSync(join(dump, "reposrc.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  const row5 = (o) => ({type: o.type, name: o.name, package: o.package, author: "DEVUSER", class: o.class ?? "customer", state: "A", status: o.status ?? "W", files: []});

  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx5-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }

  // a dump-side over-delivery row (the sidecar reported an object the scope
  // does not cover, WITH sources) -- the M-2b probe shape
  function vendorAppend(path) {
    writeFileSync(path, JSON.stringify({type: "CLAS", name: "CL_VENDOR_THING", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W",
      files: [{path: "src/CL_VENDOR.abap", state: "A", sha256: "0".repeat(64), bytes: 10}]}) + "\n");
    return path;
  }

  it("M-1: the scope audit runs on a REUSED dump too -- the refused command cannot succeed on its second try (mutation: the audit skipped when the dump is reused)", async function () {
    const appendPath = vendorAppend(join(root, `append-r5-${Math.random().toString(16).slice(2)}.jsonl`));
    const out = await fresh("r5-audit-rerun");
    const run1 = await runExtract(["--out", out], {extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(run1.code, "the fresh dump is audited and refused").to.equal(4);
    expect(run1.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/CL_VENDOR_THING/);
    const dumpDir = join(out, ".osd-hana", "dump");
    expect(existsSync(join(dumpDir, "refused.json")), "the dump is marked refused in its own directory").to.equal(true);

    // the SAME command again: the dump still sits there, but it is refused
    // dump material now -- the run must not reuse it and must name the
    // directory to remove
    const run2 = await runExtract(["--out", out], {extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(run2.code, "the refused dump is never reused").to.equal(1);
    expect(run2.lines.err.join("\n")).to.match(/refused by the scope audit/).and.to.match(/Remove the directory/).and.to.match(/dump/);
    expect(run2.runs()).to.not.include("dump"); // refused before a new dump is taken
    expect(existsSync(join(out, "src")), "nothing was written").to.equal(false);
    // and a third try cannot walk past it either
    const run3 = await runExtract(["--out", out], {extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(run3.code).to.equal(1);
    expect(run3.lines.err.join("\n")).to.match(/refused by the scope audit/);
  });

  it("M-1: reusableDump refuses a dump carrying the audit's refused flag (mutation: the flag ignored)", async function () {
    const dumpDir = join(root, "r5-refused-unit");
    rmSync(dumpDir, {recursive: true, force: true});
    mkdirSync(dumpDir, {recursive: true});
    writeFileSync(join(dumpDir, "manifest.json"), JSON.stringify({sidecar: {request: {schema: 1}, errors: [], counts: {written: 1, skipped: 0}}}));
    expect((await reusableDump(dumpDir, {schema: 1})).ok, "unmarked: reusable").to.equal(true);
    writeFileSync(join(dumpDir, "refused.json"), JSON.stringify({schema: 1, tool: "osd hana extract", refused_by: "scope audit", why: "1 objects outside the scope"}));
    const r = await reusableDump(dumpDir, {schema: 1});
    expect(r.ok).to.equal(false);
    expect(r.why).to.match(/refused by the scope audit/).and.to.match(/remove/i);
  });

  it("M-2: --dry-run, a declined prompt, a refused non-interactive run and a refusal before conversion leave the marker byte-identical (mutation: the provisional marker written before the plan)", async function () {
    const out = await fresh("r5-marker");
    const run1 = await runExtract(["--out", out]);
    expect(run1.code).to.equal(3);
    const markerPath = join(out, ".osd-hana", "marker.json");
    const before = readFileSync(markerPath, "utf8");
    expect(JSON.parse(before).files.length, "the marker lists this run's files").to.be.at.least(10);
    const identical = (label) => expect(readFileSync(markerPath, "utf8"), label).to.equal(before);

    await runExtract(["--out", out, "--dry-run"]);
    identical("after --dry-run");
    const declined = await runExtract(["--out", out], {yes: false, tty: true, answers: "n"});
    expect(declined.code).to.equal(0);
    identical("after a declined prompt");
    const refusedRun = await runExtract(["--out", out], {yes: false});
    expect(refusedRun.code).to.equal(1);
    identical("after a refused non-interactive run");
    // a refusal before conversion: a dump echoing a different request
    // (--inactive changes the dump request, so the reuse fingerprint differs)
    const mismatch = await runExtract(["--out", out, "--inactive"]);
    expect(mismatch.code).to.equal(1);
    identical("after a refusal before conversion");

    // and the next REAL run refreshes everything -- nothing is kept (this is
    // what a plan-only run used to break: the emptied marker made every
    // object "not overwritten ... the marker does not list it")
    const run3 = await runExtract(["--out", out]);
    expect(run3.code).to.equal(3);
    const rep = reportOf(out);
    expect(rep.kept, "nothing kept: the last run's marker still vouches for its files").to.deep.equal([]);
    const prog = rep.objects.find((o) => o.name === "ZOSD_X3");
    expect(prog.status, "objects are refreshed, not skipped").to.equal("written");
  });

  it("M-2: the marker is replaced atomically and no write temp is ever left behind (mutation: an in-place or temp-leaving write)", async function () {
    const out = await fresh("r5-marker-atomic");
    await runExtract(["--out", out]);
    await runExtract(["--out", out]);
    const entries = readdirSync(join(out, ".osd-hana"));
    expect(entries.filter((e) => e.startsWith("marker.json.tmp-")), "no temp file left").to.deep.equal([]);
    // a run that stops at the plan leaves no temp either
    await runExtract(["--out", out, "--dry-run"]);
    expect(readdirSync(join(out, ".osd-hana")).filter((e) => e.startsWith("marker.json.tmp-"))).to.deep.equal([]);
    JSON.parse(readFileSync(join(out, ".osd-hana", "marker.json"), "utf8")); // still valid JSON
  });

  it("M-1/SHOULD-1: the source-level audit -- a source the dump fetched for no in-scope owner refuses the run, on a reused dump too (mutation: the audit reads objects.jsonl only)", async function () {
    // fresh: a foreign include's source fetched (the row arrives AFTER the
    // request filter -- the seam for a sidecar that fetched wider), and no
    // owner resolves: group ZAB is not in scope, its shape does not match
    const fx = variant((list, dump) => {
      writeFileSync(join(dump, "src", "LZAB_F01.abap"), "FUNCTION z_foreign.\nENDFUNCTION.\n");
    });
    const orphanPath = join(root, `orphan-src-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(orphanPath, JSON.stringify({program: "LZAB_F01", state: "A", changed_by: "SAP", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file: "src/LZAB_F01.abap"}) + "\n");
    const out = await fresh("r5-src-audit");
    const r1 = await runExtract(["--out", out], {list: fx.list, dump: fx.dump, extra: {FAKE_SIDECAR_REPOSRC_APPEND: orphanPath}});
    expect(r1.code, "the orphan source refuses the fresh run").to.equal(4);
    expect(r1.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/LZAB_F01/);
    expect(existsSync(join(out, "src"))).to.equal(false);
    expect(existsSync(join(out, ".osd-hana", "dump", "refused.json"))).to.equal(true);

    // reused: the same refusal does not depend on the dump being fresh --
    // a clean dump is reused, but the source audit runs on it as well (the
    // listing narrowed: ZOSD_X3 left the scope, its source is in the dump)
    const out2 = await fresh("r5-src-audit-reuse");
    const base = await runExtract(["--out", out2]);
    expect(base.code).to.equal(3);
    const narrowed = variant((list) => writeObjects5(list, objectsRows5(list).filter((o) => o.name !== "ZOSD_X3")));
    const r2 = await runExtract(["--out", out2], {list: narrowed.list});
    expect(r2.code, "the reused dump is audited against the LIVE scope").to.equal(4);
    expect(r2.lines.err.join("\n")).to.match(/outside the scope/).and.to.match(/ZOSD_X3/);
    expect(r2.runs()).to.not.include("dump");
  });

  it("SHOULD-2: the namespaced group's request carries /NS/SAPLGRP and /NS/LGRP patterns (mutation: the raw group name in the pattern)", async function () {
    const req = buildDumpRequest({rows: [{type: "FUGR", name: "/NS/GRP_Y2"}], inactive: false});
    expect(req.names, "the main program is /NS/SAPLGRP_Y2, exact").to.include("/NS/SAPLGRP\\_Y2");
    expect(req.names, "the includes are /NS/LGRP_Y2 + exactly 3 characters (round 6)").to.include("/NS/LGRP\\_Y2___");
    expect(req.names).to.not.include("SAPL/NS/GRP\\_Y2%");
    expect(req.names.filter((n) => n.includes("%")), "no bare prefixes").to.deep.equal([]);
  });

  it("SHOULD-2: a namespaced function group's sources come back (golden fixture; mutation: the request cannot name the programs)", async function () {
    const fx = variant((list, dump) => addNamespacedFunctionGroup({list, dump}));
    const out = await fresh("r5-ns-fugr");
    const from = recordLines().length;
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
    expect(r.code).to.equal(3);
    const reqs = recordLines().slice(from).map((l) => JSON.parse(l)).filter((e) => e.argv[0] === "dump").map((e) => e.request);
    expect(reqs.length).to.equal(1);
    expect(reqs[0].names).to.include("/NS/SAPLGRP\\_Y2");
    expect(reqs[0].names).to.include("/NS/LGRP\\_Y2___");
    const rep = reportOf(out);
    const fugr = rep.objects.find((o) => o.name === "/NS/GRP_Y2");
    expect(fugr.status, "the namespaced group's sources were fetched").to.equal("written");
    expect(readFileSync(join(out, "src/osd_x/#ns#grp_y2.fugr.xml"), "utf8")).to.match(/\/NS\/LGRP_Y2TOP/).and.to.match(/Z_OSD_Y2_FM/);
    expect(existsSync(join(out, "src/osd_x/#ns#grp_y2.fugr.#ns#saplgrp_y2.xml"))).to.equal(true);
    expect(existsSync(join(out, "src/osd_x/#ns#grp_y2.fugr.#ns#lgrp_y2top.xml"))).to.equal(true);
    expect(existsSync(join(out, "src/osd_x/#ns#grp_y2.fugr.z_osd_y2_fm.abap"))).to.equal(true);
  });

  it("SHOULD-3: a TABL is written-partial only for unwritten parts OF ITS OWN (mutation: the dump-level file check)", async function () {
    // base fixture: DD05S/DD08L carry rows for ZTAB_X5 only
    const out = await fresh("r5-tabl-own");
    const r = await runExtract(["--out", out]);
    expect(r.code).to.equal(3);
    const rep = reportOf(out);
    const withFk = rep.objects.find((o) => o.name === "ZTAB_X5");
    expect(withFk.status).to.equal("written-partial");
    const fks = withFk.parts.find((p) => /foreign key/i.test(p.part));
    expect(fks.disposition).to.equal("not extracted");
    expect(fks.reason).to.match(/2 rows/).and.to.match(/DD05S|DD08L/);

    // one more foreign-key row, for the namespaced table: it becomes partial too
    const fx = variant((list, dump) => {
      writeTable5(dump, "DD08L", tableRows5(dump, "DD08L").concat([{TABNAME: "/NS/ZTAB_Y1", AS4LOCAL: "A", CHECKTABLE: "ZTAB_X5", FRKART: "KEY"}]));
    });
    const out2 = await fresh("r5-tabl-own-ns");
    await runExtract(["--out", out2], {list: fx.list, dump: fx.dump});
    const ns = reportOf(out2).objects.find((o) => o.name === "/NS/ZTAB_Y1");
    expect(ns.status).to.equal("written-partial");
    expect(ns.parts.some((p) => /foreign key/i.test(p.part) && p.disposition === "not extracted")).to.equal(true);

    // and when the dump carries no aspect files at all, the aspect is
    // "not checked" for BOTH tables -- never a false partial
    const fx2 = variant((list, dump) => {
      for (const t of ["DD05S", "DD08L"]) rmSync(join(dump, "tables", `${t}.jsonl`));
    });
    const out3 = await fresh("r5-tabl-own-absent");
    const r3 = await runExtract(["--out", out3], {list: fx2.list, dump: fx2.dump});
    expect(r3.code, "no not-extracted part on the tables; only the SICF").to.equal(3);
    for (const name of ["ZTAB_X5", "/NS/ZTAB_Y1"]) {
      const o = reportOf(out3).objects.find((x) => x.name === name);
      expect(o.status, name).to.equal("written");
      expect(o.unchecked.some((p) => /foreign key/i.test(p.part) && p.disposition === "not checked")).to.equal(true);
    }
  });
});

// ------------------------------------------------------- fix round 6
// CRITIC round 4 (../w3crit4/CRITIC.md beside the task): MUST-1 (a refusal
// emptied src/ and said "Nothing was written"), MUST-2 (a sibling function
// group's includes were fetched and written under the shorter group's name)
// and SHOULD-1 (the user's .gitignore overwritten, by a --dry-run).
describe("osd hana extract -- fix round 6 (a refusal touches nothing; a group owns exactly its includes)", function () {
  const readJsonl6 = (dir, name) => readFileSync(join(dir, name), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  const writeObjects6 = (dir, rows) => writeFileSync(join(dir, "objects.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
  function variant(mutate) {
    const built = buildExtractFixtures(join(root, `fx6-${Math.random().toString(16).slice(2)}`));
    if (mutate) mutate(built.list, built.dump);
    return built;
  }
  // the REPOSITORY a refusal must leave byte-identical: every file of <out>
  // with its hash -- except the work area's scratch (the listing, the request
  // files, the dump: a refusal after the dump necessarily leaves the dump and
  // its refused.json there), whose one repository-relevant file, the
  // marker, is in the snapshot
  function snapshot(out) {
    const files = {};
    const walk = (abs, rel) => {
      for (const e of readdirSync(abs, {withFileTypes: true})) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(abs, e.name), r);
        else if (!r.startsWith(".osd-hana/") || r === ".osd-hana/marker.json") files[r] = createHash("sha256").update(readFileSync(join(abs, e.name))).digest("hex");
      }
    };
    walk(out, "");
    return files;
  }
  const errText = (r) => r.lines.err.join("\n");

  it("MUST-1: an object deleted in the system -- the restart over the reused dump is refused, src/ and the marker stay byte-identical; a re-dump replaces them (mutation: src/ cleared before the audit)", async function () {
    const out = await fresh("r6-shrink");
    const run1 = await runExtract(["--out", out]);
    expect(run1.code).to.equal(3);
    const before = snapshot(out);
    expect(Object.keys(before).filter((f) => f.startsWith("src/")).length, "a repository to protect").to.be.at.least(10);
    const narrowed = variant((list) => writeObjects6(list, readJsonl6(list, "objects.jsonl").filter((o) => o.name !== "ZOSD_X3")));
    const run2 = await runExtract(["--out", out], {list: narrowed.list});
    expect(run2.code, "the reused dump holds an object that left the scope").to.equal(4);
    expect(snapshot(out), "the repository is byte-identical after the refusal").to.deep.equal(before);
    expect(errText(run2)).to.not.match(/Nothing was written/);
    expect(errText(run2)).to.match(/repository in .* is unchanged/);
    // the honest restart: remove the dump, re-dump; only now is src/ replaced
    rmSync(join(out, ".osd-hana", "dump"), {recursive: true, force: true});
    const run3 = await runExtract(["--out", out], {list: narrowed.list});
    expect(run3.code).to.equal(3);
    expect(existsSync(join(out, "src", "osd_x", "zosd_x3.prog.abap")), "the deleted object's files are gone after a NEW conversion").to.equal(false);
    expect(existsSync(join(out, "src", "osd_x", "zcl_osd_x1.clas.abap"))).to.equal(true);
  });

  it("MUST-1: over-delivery on a re-dump over a good repository -- refused, the repository byte-identical (mutation: src/ cleared before the audit)", async function () {
    const out = await fresh("r6-overdeliver");
    expect((await runExtract(["--out", out])).code).to.equal(3);
    const before = snapshot(out);
    rmSync(join(out, ".osd-hana", "dump"), {recursive: true, force: true});
    const appendPath = join(root, `append-r6-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendPath, JSON.stringify({type: "CLAS", name: "CL_VENDOR_THING", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W",
      files: [{path: "src/CL_VENDOR.abap", state: "A", sha256: "0".repeat(64), bytes: 10}]}) + "\n");
    const r = await runExtract(["--out", out], {extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(r.code).to.equal(4);
    expect(snapshot(out)).to.deep.equal(before);
    expect(errText(r)).to.not.match(/Nothing was written/);
    expect(existsSync(join(out, ".osd-hana", "refused-report.md")), "the refusal report lives in the work area").to.equal(true);
  });

  it("MUST-1: every other refusal and plan-only stop leaves the repository byte-identical (mutation: .gitignore written before the listing)", async function () {
    const out = await fresh("r6-every-refusal");
    expect((await runExtract(["--out", out])).code).to.equal(3);
    // the user's own edit to the .gitignore this command once created
    writeFileSync(join(out, ".gitignore"), ".osd-hana/\nmy-notes/\n");
    const before = snapshot(out);
    const same = (label) => expect(snapshot(out), label).to.deep.equal(before);
    expect((await runExtract(["--out", out, "--dry-run"])).code).to.equal(0);
    same("--dry-run");
    expect((await runExtract(["--out", out], {yes: false, tty: true, answers: "n"})).code).to.equal(0);
    same("a declined prompt");
    expect((await runExtract(["--out", out], {yes: false})).code).to.equal(1);
    same("a non-interactive run without --yes");
    expect((await runExtract(["--out", out, "--inactive"])).code).to.equal(1);
    same("a dump echoing a different request");
    const empty = variant((list) => writeObjects6(list, []));
    expect((await runExtract(["--out", out], {list: empty.list})).code).to.equal(1);
    same("an empty selection");
    writeFileSync(join(out, "notes.txt"), "mine\n");
    rmSync(join(out, ".osd-hana", "marker.json"));
    const beforeForeign = snapshot(out);
    expect((await runExtract(["--out", out])).code).to.equal(4);
    expect(snapshot(out), "a foreign directory").to.deep.equal(beforeForeign);
  });

  it("MUST-1: a first-ever run refused by the audit leaves only the work area -- and the re-run after removing the dump is not refused the directory (mutation: the refusal report written into <out>)", async function () {
    const out = await fresh("r6-first-refusal");
    const appendPath = join(root, `append-r6f-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendPath, JSON.stringify({type: "CLAS", name: "CL_VENDOR_THING", package: "SAP_PK", author: "SAP", class: "sap", state: "A", status: "W",
      files: [{path: "src/CL_VENDOR.abap", state: "A", sha256: "0".repeat(64), bytes: 10}]}) + "\n");
    const r = await runExtract(["--out", out], {extra: {FAKE_SIDECAR_DUMP_APPEND: appendPath}});
    expect(r.code).to.equal(4);
    expect(readdirSync(out), "nothing but the work area").to.deep.equal([".osd-hana"]);
    expect(existsSync(join(out, ".osd-hana", "marker.json")), "no claim on a directory nothing was written to").to.equal(false);
    rmSync(join(out, ".osd-hana", "dump"), {recursive: true, force: true});
    expect((await runExtract(["--out", out])).code).to.equal(3);
  });

  it("MUST-1: the work area ignores itself -- the raw dump is never committable, even before the first .gitignore line exists (mutation: the work-area .gitignore not written)", async function () {
    const out = await fresh("r6-workarea-ignore");
    await runExtract(["--out", out, "--dry-run"]);
    expect(readFileSync(join(out, ".osd-hana", ".gitignore"), "utf8")).to.equal("*\n");
    expect(existsSync(join(out, ".gitignore")), "a dry-run creates no repository file").to.equal(false);
  });

  // ---- MUST-2: a function group owns exactly L<grp> + 3 characters --------
  for (const ns of ["", "/NSX/"]) {
    for (const inScope of ["ZA", "ZAU"]) {
      const other = inScope === "ZA" ? "ZAU" : "ZA";
      it(`MUST-2: groups ${ns}ZA and ${ns}ZAU both in the dump, only ${ns}${inScope} in scope -- ${ns}${other}'s includes are never requested, fetched or written (mutation: the letter + 3 shapes / the 4-character split)`, async function () {
        const fx = variant((list, dump) => addSiblingFunctionGroups({list, dump}, {ns, inScope}));
        const out = await fresh(`r6-sibling-${ns ? "ns-" : ""}${inScope}`);
        const from = recordLines().length;
        const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump});
        expect(r.code, errText(r)).to.equal(3);
        const req = recordLines().slice(from).map((l) => JSON.parse(l)).find((e) => e.argv[0] === "dump").request;
        const esc = (s) => s.replace(/_/g, "\\_");
        expect(req.names).to.include(`${esc(`${ns}L${inScope}`)}___`);
        expect(req.names).to.include(esc(`${ns}SAPL${inScope}`));
        expect(req.names.filter((n) => n.startsWith(esc(`${ns}L${inScope}`)) && n !== `${esc(`${ns}L${inScope}`)}___`), "no letter shapes").to.deep.equal([]);
        const fetched = readJsonl6(join(out, ".osd-hana", "dump"), "reposrc.jsonl").map((x) => x.program);
        expect(fetched.filter((p) => p.startsWith(`${ns}L${other}`) && p.length === `${ns}L${other}`.length + 3), "the sibling's includes are not fetched").to.deep.equal([]);
        const written = [];
        const walk = (d) => { for (const e of readdirSync(d, {withFileTypes: true})) { if (e.isDirectory()) walk(join(d, e.name)); else written.push(readFileSync(join(d, e.name), "utf8")); } };
        walk(join(out, "src"));
        expect(written.filter((t) => t.includes("SIBLING_SECRET")), "no sibling code in the repository").to.deep.equal([]);
        const fugr = reportOf(out).objects.find((o) => o.name === `${ns}${inScope}`);
        expect(fugr.status, "the in-scope group is complete").to.equal("written");
        expect(written.some((t) => t.includes(`own ${inScope}`) && /DATA g_/.test(t)), "its own TOP include is there").to.equal(true);
      });
    }
  }

  it("MUST-2: the resolver assigns an include by exact length only -- a 4-character suffix is never split off (mutation: n = 4 tried)", function () {
    for (const ns of ["", "/NSX/"]) {
      const za = {id: `FUGR:${ns}ZA`, type: "FUGR", name: `${ns}ZA`};
      const maps = {objects: new Map([[za.id, za]]), groupByProgram: new Map([[`${ns}SAPLZA`, za]]), groupByName: new Map([[`${ns}ZA`, za]])};
      for (const own of ["LZATOP", "LZAU01", "LZAUXX", "LZAF01", "LZAD01"]) expect(resolveProgramOwner(`${ns}${own}`, maps), own).to.equal(za);
      for (const foreign of ["LZAUTOP", "LZAUU01", "LZAUUXX", "LZAUF01", "LZATO", "LZA"]) expect(resolveProgramOwner(`${ns}${foreign}`, maps), foreign).to.equal(null);
    }
  });

  it("MUST-2: a sibling include the sidecar delivers anyway is ownerless -- the audit refuses the run, the repository untouched (mutation: the 4-character split)", async function () {
    const fx = variant((list, dump) => addSiblingFunctionGroups({list, dump}, {inScope: "ZA"}));
    const appendSrc = join(root, `sibling-src-${Math.random().toString(16).slice(2)}.jsonl`);
    writeFileSync(appendSrc, ["LZAUTOP", "LZAUU01"].map((p) => JSON.stringify({program: p, state: "A", changed_by: "OTHER", changed_on: "20261101", max_line: 0, lines: 2, sha256: "1".repeat(64), file: `src/${p}.abap`})).join("\n") + "\n");
    const out = await fresh("r6-sibling-audit");
    const r = await runExtract(["--out", out], {list: fx.list, dump: fx.dump, extra: {FAKE_SIDECAR_REPOSRC_APPEND: appendSrc}});
    expect(r.code).to.equal(4);
    expect(errText(r)).to.match(/LZAUTOP/).and.to.match(/LZAUU01/);
    expect(existsSync(join(out, "src"))).to.equal(false);
  });

  // ---- SHOULD-1: the user's .gitignore is appended to, never overwritten ---
  it("SHOULD-1: a user's .gitignore -- untouched by --dry-run and a refused run, the .osd-hana/ line appended by a writing run, and the report says so (mutation: the .gitignore overwritten)", async function () {
    const out = await fresh("r6-user-gitignore");
    const mine = "node_modules/\nmy-secrets/";
    writeFileSync(join(out, ".gitignore"), mine);
    expect((await runExtract(["--out", out, "--dry-run"])).code).to.equal(0);
    expect(readFileSync(join(out, ".gitignore"), "utf8"), "--dry-run").to.equal(mine);
    expect((await runExtract(["--out", out], {yes: false})).code).to.equal(1);
    expect(readFileSync(join(out, ".gitignore"), "utf8"), "a refused run").to.equal(mine);
    const w = await runExtract(["--out", out]);
    expect(w.code).to.equal(3);
    expect(readFileSync(join(out, ".gitignore"), "utf8"), "appended, the user's lines kept").to.equal(`${mine}\n.osd-hana/\n`);
    expect(reportOf(out).gitignore).to.deep.equal({action: "appended"});
    expect(readFileSync(join(out, "extract-report.md"), "utf8")).to.match(/\.gitignore.*appended/);
    const marker = JSON.parse(readFileSync(join(out, ".osd-hana", "marker.json"), "utf8"));
    expect(marker.files.map((f) => f.path), "the user's file is not listed as ours").to.not.include(".gitignore");
    // a second writing run: the line is there -- nothing changes
    expect((await runExtract(["--out", out])).code).to.equal(3);
    expect(readFileSync(join(out, ".gitignore"), "utf8")).to.equal(`${mine}\n.osd-hana/\n`);
    expect(reportOf(out).gitignore).to.deep.equal({action: "unchanged"});
    // a fresh directory: created, and listed as ours
    const out2 = await fresh("r6-gitignore-created");
    await runExtract(["--out", out2]);
    expect(readFileSync(join(out2, ".gitignore"), "utf8")).to.equal(".osd-hana/\n");
    expect(reportOf(out2).gitignore).to.deep.equal({action: "created"});
  });
});
