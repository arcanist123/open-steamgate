import {readTraceMap} from "./trace-reader.mjs";
import {expect} from "chai";
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync} from "node:fs";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {join} from "node:path";
import {DDIC_DIR, SPEC_FILE, YAML_FILE, derive, generated, iwprTables, readSpec} from "../tools/segw-tables.mjs";
import {DEFAULT_URL, exportIwpr, generateFiles, importIwpr, projectOf, pull, pullFile, push, pushFile, pushFunctionGroups, readData, repoFiles, repoZip, writeData, admitRepo, main as segwTree} from "../tools/segw-tree.mjs";
import {loadFunctionGroups} from "../tools/segw-gen-mapping.mjs";
import {dirname} from "node:path";
import {startServer} from "./start.mjs";
import {generate} from "../tools/segw-gen.mjs";
import {compile} from "../tools/stg-compile.mjs";

// The SEGW project tree as our tables: the spec derived from real SEGW
// projects, the tables and the service generated from it, and the IWPR
// round trip through those tables.
// the untracked corpus of SEGW projects, when this machine has it
const corpus = [".local/corpus", ".local/corpus-sap", ".local/lars"].filter((d) => existsSync(d));
const files = [];
const walk = (folder) => {
  for (const name of readdirSync(folder)) {
    const p = join(folder, name);
    if (name === "node_modules" || name === ".git") {
      continue;
    }
    if (statSync(p).isDirectory()) {
      walk(p);
    } else if (name.endsWith(".iwpr.xml")) {
      files.push(p);
    }
  }
};
corpus.forEach(walk);

describe("tools/segw-tables + tools/segw-tree: the project tree as tables", () => {
  const spec = readSpec();

  it("the tables and the service under src/segw are what the spec says", () => {
    for (const [file, text] of Object.entries(generated(spec))) {
      expect(readFileSync(file, "utf8"), file).to.equal(text);
    }
    const tracked = readdirSync(DDIC_DIR).map((f) => join(DDIC_DIR, f));
    expect(tracked.filter((f) => !(f in generated(spec)))).to.deep.equal([]);
    expect(existsSync(SPEC_FILE) && existsSync(YAML_FILE)).to.equal(true);
  });

  it("the key of every table is a prefix of its fields with PROJECT and NODE_UUID, SYLANGU for texts", () => {
    for (const [tag, t] of Object.entries(spec)) {
      const fields = Object.keys(t.fields);
      expect(fields.slice(0, t.keys.length), tag).to.deep.equal(t.keys);
      expect(t.keys, tag).to.include("PROJECT");
      if (fields.includes("NODE_UUID")) {
        expect(t.keys, tag).to.include("NODE_UUID");
      }
      if (fields.includes("SYLANGU")) {
        expect(t.keys, tag).to.include("SYLANGU");
      }
    }
    expect(spec.SBD_MR.keys).to.deep.equal(["PROJECT", "NODE_UUID", "DS_ATT_PATH"]);
    expect(spec.SBD_MAP.keys).to.deep.equal(["PROJECT", "NODE_HASH", "NODE_UUID"]);
    expect(spec.SBO_PRT.keys).to.deep.equal(["SYLANGU", "PROJECT", "NODE_UUID"]);
  });

  it("entity names differ in their first 16 characters, SEGW's method name budget", () => {
    const names = Object.values(spec).map((t) => t.entity.slice(0, 16).toUpperCase());
    expect(new Set(names).size).to.equal(names.length);
  });

  // the fixture was written by hand: the same rows, but its table blocks
  // and the fields of SBO_PR are not in the order SEGW writes them
  it("round trip of the mapped fixture keeps every table, row and field", () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8");
    const tables = importIwpr(xml, spec);
    expect(projectOf(tables)).to.equal("ZSTG_MAPPED");
    const back = exportIwpr(tables, "ZSTG_MAPPED", spec);
    const rows = (text) => [...iwprTables(text)].map(([tag, list]) => [tag, list.map((r) => Object.entries(r).sort())]).sort();
    expect(rows(back)).to.deep.equal(rows(xml));
    // alphabetical table blocks, fields in DDIC order, so a second trip is identical
    expect(exportIwpr(importIwpr(back, spec), "ZSTG_MAPPED", spec)).to.equal(back);
  });

  it("rows keep their position and initial fields stay out", () => {
    const tables = importIwpr(readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"), spec);
    const mp = tables.get("SBD_MP");
    expect(mp.map((r) => r.stg_seq)).to.deep.equal(mp.map((_, i) => i + 1));
    expect(mp.every((r) => r.mandt === "123" && r.project === "ZSTG_MAPPED")).to.equal(true);
    const ds = tables.get("SBD_DS");
    expect(ds[0].rfc_dest).to.equal("NONE");
    expect(ds[1]).to.not.have.property("rfc_dest");
    expect(exportIwpr(tables, "ZSTG_MAPPED", spec)).to.not.contain("<RFC_DEST></RFC_DEST>");
  });

  it("a field SEGW never writes is refused", () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mini.iwpr.xml", "utf8").replace("<NAME>Travel</NAME>", "<NAME>Travel</NAME>\n     <MADE_UP>x</MADE_UP>");
    expect(() => importIwpr(xml, spec)).to.throw("SBO_ET.MADE_UP: not in the spec");
  });

  it("importing a project replaces its rows and leaves other projects alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "segw-tree-"));
    try {
      const mapped = importIwpr(readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"), spec);
      const mini = importIwpr(readFileSync("test/fixtures/segw/zstg_mini.iwpr.xml", "utf8"), spec);
      writeData(dir, mapped, "ZSTG_MAPPED", spec);
      writeData(dir, mini, "ZSTG_MINI", spec);
      writeData(dir, mapped, "ZSTG_MAPPED", spec);
      const data = readData(dir, spec);
      expect(data.get("SBO_ET").filter((r) => r.project === "ZSTG_MAPPED")).to.have.length(mapped.get("SBO_ET").length);
      expect(data.get("SBO_ET").filter((r) => r.project === "ZSTG_MINI")).to.have.length(mini.get("SBO_ET").length);
      expect(exportIwpr(data, "ZSTG_MINI", spec)).to.equal(exportIwpr(mini, "ZSTG_MINI", spec));
      expect(exportIwpr(data, "NOBODY", spec)).to.not.contain("<_-IWBEP_-I_");
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("data/ holds the mapped fixture, as the unit tests and the demo expect", () => {
    const mapped = importIwpr(readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"), spec);
    const data = readData("data", spec);
    for (const [tag, rows] of mapped) {
      expect(data.get(tag).filter((r) => r.project === "ZSTG_MAPPED"), tag).to.deep.equal(rows);
    }
  });

  // the strong claim, on the untracked corpus: every IWPR file a SEGW
  // system wrote comes back **byte for byte**, and the byte order mark is
  // not an aside. Every real IWPR in the corpus begins `ef bb bf`; the
  // writer emits one; and this test used to strip it from the input and
  // then demand output without it, which is the one place the corpus is
  // strongest and the comparison was weakest.
  (files.length === 0 ? it.skip : it)(`the SEGW-written IWPR files of the corpus round trip byte for byte (${files.length} files)`, () => {
    for (const file of files) {
      const xml = readFileSync(file, "utf8");
      const tables = importIwpr(xml, spec);
      expect(exportIwpr(tables, projectOf(tables), spec), file).to.equal(xml);
    }
  });

  // **A partial corpus is not a small corpus, it is another question.**
  //
  // These were one test, guarded by `files.length === 0`. The round trip is
  // true of any file taken one at a time, so one file passes that guard --
  // and the line below needs the WHOLE corpus the tracked spec was derived
  // from (21 projects). Measured in a fresh worktree, where `.local/corpus`
  // and `.local/corpus-sap` do not exist and `.local/lars` contributes one
  // IWPR: the guard let it through and the comparison failed, naming 21
  // tables against 52. On a differently partial machine it could instead
  // have PASSED, having derived the spec from almost nothing.
  //
  // So the two claims are separated and the second says what it needs.
  (existsSync(".local/corpus") ? it : it.skip)("and the spec is what the corpus says (needs .local/corpus)", () => {
    expect(derive(corpus).spec).to.deep.equal(spec);
  });
});

// the same round trip through the gateway and the generic CRUD of
// ZSTG_SEGW_SRV: rows in the database, not in a JSON file
describe("tools/segw-tree push / pull through ZSTG_SEGW_SRV", function () {
  this.timeout(120000);
  const spec = readSpec();
  let server;

  before(() => {
    server = startServer(true);
  });

  after(() => server.close());

  it("pulls the seeded project as the file it was imported from", async () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8");
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MAPPED", spec), "ZSTG_MAPPED", spec)).to.equal(xml);
  });

  it("pushes a file and pulls it back byte for byte, twice, without doubling rows", async () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mini.iwpr.xml", "utf8");
    const tables = importIwpr(xml, spec);
    const first = await push(DEFAULT_URL, tables, "ZSTG_MINI", spec);
    expect(first.deleted).to.equal(0);
    expect(first.posted).to.equal([...tables.values()].reduce((n, r) => n + r.length, 0));
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MINI", spec), "ZSTG_MINI", spec)).to.equal(xml);
    const second = await push(DEFAULT_URL, tables, "ZSTG_MINI", spec);
    expect(second.deleted).to.equal(first.posted);
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MINI", spec), "ZSTG_MINI", spec)).to.equal(xml);
    // the other project is untouched
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MAPPED", spec), "ZSTG_MAPPED", spec)).to.equal(readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"));
  });

  // the file as one POST to ImportSet: zcl_stg_segw_import parses it in ABAP
  it("POST ImportSet takes the file and the pull gives it back byte for byte", async () => {
    for (const name of ["zstg_mini", "zstg_mapped"]) {
      const xml = readFileSync(`test/fixtures/segw/${name}.iwpr.xml`, "utf8");
      const tables = importIwpr(xml, spec);
      const rows = [...tables.values()].reduce((n, r) => n + r.length, 0);
      const result = await pushFile(DEFAULT_URL, xml);
      expect(result, name).to.deep.equal({project: projectOf(tables), posted: rows, tables: tables.size});
      expect(exportIwpr(await pull(DEFAULT_URL, result.project, spec), result.project, spec), name).to.equal(xml);
      // and the file the service writes itself (GET ExportSet, zcl_stg_segw_export)
      expect(await pullFile(DEFAULT_URL, result.project), name).to.equal(xml);
    }
  });

  // DELETE NodeSet: the operation op-1, its mapping header mh-2, the header's
  // properties mp-4..mp-7 and the rules that share mp-4's NODE_UUID (SBD_MR)
  it("DELETE NodeSet takes a node with its subtree, the way SEGW deletes", async () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8");
    await pushFile(DEFAULT_URL, xml);
    const res = await fetch(`${DEFAULT_URL}/sap/opu/odata/sap/ZSTG_SEGW_SRV/NodeSet(Project='ZSTG_MAPPED',NodeUuid='op-1')`, {method: "DELETE"});
    expect(res.status).to.equal(204);
    const gone = new Set(["op-1", "mh-2", "mp-4", "mp-5", "mp-6", "mp-7"]);
    const expected = new Map([...importIwpr(xml, spec)].map(([tag, rows]) => [tag, rows.filter((r) => !gone.has(r.node_uuid))]));
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MAPPED", spec), "ZSTG_MAPPED", spec)).to.equal(exportIwpr(expected, "ZSTG_MAPPED", spec));
    expect(expected.get("SBD_MR").length).to.equal(0);
    // put the seeded project back for the tests after this one
    await pushFile(DEFAULT_URL, xml);
    expect(await pullFile(DEFAULT_URL, "ZSTG_MAPPED")).to.equal(xml);
  });

  // **A twin comparison cannot tell "both right" from "both blind."**
  //
  // The label of an action was not read from SBO_FIT by either generator,
  // and `stg-compile` wrote FI_LABEL equal to the name, so all three agreed
  // and all three were unaware. The byte test below stayed green through the
  // whole of it -- correctly, because it asks whether the two agree and not
  // whether either is right.
  //
  // So the label is asserted against the text a person typed, once, here,
  // where it goes red if the reading is removed from EITHER side. Checked
  // failing before it was kept.
  it("an action and a parameter are pooled under the label a person typed, not their names", () => {
    const g = generate(readFileSync("test/fixtures/segw/zstg_label.iwpr.xml", "utf8"),
      {functionModules: new Map(), warnings: []});
    const xml = {...g.files, ...g.ext}["zcl_zstg_label_mpc.clas.xml"];
    expect(xml, "the MPC is generated").to.be.a("string");
    const pool = /<TPOOL>[\s\S]*?<\/TPOOL>/.exec(xml)?.[0] ?? "";
    expect(pool, "the action's own label").to.contain("<ENTRY>Cancel this travel</ENTRY>");
    expect(pool, "the parameter's own label").to.contain("<ENTRY>Travel number</ENTRY>");
    // and the names are NOT what was pooled, which is what the fixture is for
    expect(pool, "the name is not the label here").to.not.contain("<ENTRY>CancelTravel</ENTRY>");
    expect(pool, "nor the parameter's").to.not.contain("<ENTRY>TravelId</ENTRY>");
  });

  // segw-gen in ABAP: for every project we have, the classes GenerateSet
  // returns are the bytes tools/segw-gen.mjs makes of the same tree
  it("GenerateSet gives segw-gen's files byte for byte for the fixtures, the compiled demo and the corpus", async () => {
    // a project with its folder: the *.fugr.xml next to it are the module
    // signatures, for segw-gen (--lib) and for the service (FunctionGroupSet)
    const sources = [
      ["zstg_mapped", readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"), "test/fixtures/segw"],
      ["zstg_mini", readFileSync("test/fixtures/segw/zstg_mini.iwpr.xml", "utf8"), "test/fixtures/segw"],
      // An action and a parameter with labels of their own. Not one of the
      // other fixtures has a function import at all, which is why the label
      // gap survived: the byte comparison was comparing two implementations
      // over trees that could not express the thing they both ignored.
      ["zstg_label", readFileSync("test/fixtures/segw/zstg_label.iwpr.xml", "utf8"), "test/fixtures/segw"],
      // An action and no labelled property: the action's text element still
      // needs GC_INCL_NAME declared, in both generators
      ["zstg_incl (compiled)", compile("project: ZSTG_INCL\nservice: ZSTG_INCL_SRV\nentities:\n  Thing:\n    keys: [Id]\n    properties:\n      Id: String(4)\n"
        + "functions:\n  Touch:\n    method: POST\n    returns: {entity: Thing}\n    parameters: {Id: String(4)}\n", {file: "zstg_incl.stg.yaml"}).iwpr, "test/fixtures/segw"],
      ["zstg_demo (compiled)", compile(readFileSync("src/demo/zstg_demo.stg.yaml", "utf8"), {file: "zstg_demo.stg.yaml", functionModules: loadFunctionGroups(["src/demo"])}).iwpr, "src/demo"],
      // this service itself: 55 SADL sets, the SADL definition built in pieces
      ["zstg_segw (compiled)", compile(readFileSync("src/segw/zstg_segw.stg.yaml", "utf8"), {file: "zstg_segw.stg.yaml"}).iwpr, "src/segw"],
      ...files.map((f) => [f, readFileSync(f, "utf8").replace(/^\uFEFF/, ""), dirname(f)]),
    ];
    let checked = 0;
    for (const [name, xml, folder] of sources) {
      const oracle = generate(xml, {functionModules: loadFunctionGroups([folder]), warnings: []});
      if (oracle.skipped) {
        continue;
      }
      await pushFunctionGroups(DEFAULT_URL, folder);
      const {project} = await pushFile(DEFAULT_URL, xml);
      const made = await generateFiles(DEFAULT_URL, project);
      const expected = {...oracle.files, ...oracle.ext};
      const traceName = Object.keys(made).find((file) => file.endsWith("_mpc.clas.trace.json"));
      expect(traceName, `${name}: MPC trace sidecar`).to.be.a("string");
      const sidecar = readTraceMap(made, traceName);
      const mpcName = traceName.replace(".clas.trace.json", ".clas.abap");
      expect(sidecar.lines.length, `${name}: one trace per MPC line`).to.equal(made[mpcName].trimEnd().split("\n").length);
      expect(sidecar.lines.every((line, index) => line.line === index + 1 && line.node), `${name}: named trace lines`).to.equal(true);
      const dpcTraceName = Object.keys(made).find((file) => file.endsWith("_dpc.clas.trace.json"));
      if (Object.keys(expected).some((file) => file.endsWith("_dpc.clas.abap"))) {
        expect(dpcTraceName, `${name}: DPC trace sidecar`).to.be.a("string");
        const dpcSidecar = readTraceMap(made, dpcTraceName);
        expect(dpcSidecar.generator, `${name}: DPC sidecar from the DSL`).to.equal("dsl-dpc");
        expect(dpcSidecar.lines.length, `${name}: one trace per DPC line`).to.equal(made[dpcTraceName.replace(".clas.trace.json", ".clas.abap")].trimEnd().split("\n").length);
      }
      // The ABAP generator adds provenance; the JS twin still supplies the class oracle.
      expect(Object.keys(made).filter((file) => file !== traceName && file !== dpcTraceName && !file.endsWith(".trace.meta.json")).sort(), name).to.deep.equal(Object.keys(expected).sort());
      for (const [file, content] of Object.entries(expected)) {
        const a = content.split("\n");
        const b = made[file].split("\n");
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) {
          i++;
        }
        expect(made[file], `${name}: ${file} differs at line ${i + 1}\n  segw-gen: ${JSON.stringify(a[i])}\n  ABAP:     ${JSON.stringify(b[i])}`).to.equal(content);
      }
      checked++;
    }
    expect(checked).to.be.greaterThan(2);
    // put the seeded project back
    await pushFile(DEFAULT_URL, readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"));
  });

  it("GenerateSet without a Project filter is 400", async () => {
    const res = await fetch(`${DEFAULT_URL}/sap/opu/odata/sap/ZSTG_SEGW_SRV/GenerateSet`);
    expect(res.status).to.equal(400);
    expect(await res.text()).to.contain("GenerateSet needs $filter=Project eq");
  });

  // the abapGit repository of a project: what a system pulls to have it.
  // The registration objects are stg-compile's oracle, the tree is the file
  // that went in, the classes are segw-gen's.
  it("RepoFileSet is the abapGit repository of a project, IWSV and IWMO as stg-compile writes them", async () => {
    const compiled = compile(readFileSync("src/demo/zstg_demo.stg.yaml", "utf8"), {file: "zstg_demo.stg.yaml", functionModules: loadFunctionGroups(["src/demo"])});
    await pushFunctionGroups(DEFAULT_URL, "src/demo");
    await pushFile(DEFAULT_URL, compiled.iwpr);
    const repo = await repoFiles(DEFAULT_URL, "ZSTG_DEMO");
    expect(Object.keys(repo).some((name) => /\.clas\.trace(?:\.meta)?\.json$/.test(name))).to.equal(false);

    expect(Object.keys(repo)).to.include(".abapgit.xml");
    expect(Object.keys(repo)).to.include("src/package.devc.xml");
    expect(repo[".abapgit.xml"]).to.contain("<STARTING_FOLDER>/src/</STARTING_FOLDER>");
    // the tree, byte for byte what the import took in
    expect(repo["src/zstg_demo.iwpr.xml"]).to.equal(compiled.iwpr);
    // the registration objects, byte for byte what stg-compile writes
    for (const [name, content] of Object.entries(compiled.files)) {
      if (name.endsWith(".iwpr.xml")) {
        continue;
      }
      expect(repo["src/" + name], name).to.equal(content);
    }
    // the classes, byte for byte what segw-gen writes
    const oracle = generate(compiled.iwpr, {functionModules: loadFunctionGroups(["src/demo"]), warnings: []});
    for (const [name, content] of Object.entries({...oracle.files, ...oracle.ext})) {
      expect(repo["src/" + name], name).to.equal(content);
    }
    expect(Object.keys(repo).length).to.equal(2 + Object.keys(compiled.files).length + Object.keys(oracle.files).length + Object.keys(oracle.ext).length);

    // it is a route to a system, so it passes the deploy manifest like a zip:
    // the demo unit lists every object, and one SAP-named file refuses it
    expect(admitRepo(repo, "ZSTG_DEMO").name).to.equal("demo");
    expect(() => admitRepo({...repo, "src/cl_http_client.clas.abap": "x"}, "ZSTG_DEMO"))
      .to.throw(/CLAS CL_HTTP_CLIENT[\s\S]*not-in-manifest[\s\S]*sap-api-name/);
    expect(() => admitRepo(repo, "ZSTG_MAPPED")).to.throw(/no deploy unit .* lists IWPR ZSTG_MAPPED/);
    expect(() => admitRepo({...repo, "README.md": "x"}, "ZSTG_DEMO")).to.throw(/README\.md[\s\S]*outside src\//);

    // the command's zip is made of the admitted files, entry for entry
    const tmp = mkdtempSync(join(tmpdir(), "segw-repo-zip-"));
    try {
      expect(await segwTree(["repo", "ZSTG_DEMO", "--zip", join(tmp, "r.zip"), "--url", DEFAULT_URL])).to.equal(0);
      const listed = execFileSync("unzip", ["-Z1", join(tmp, "r.zip")], {encoding: "utf8"})
        .split("\n").filter((n) => n !== "" && !n.endsWith("/"));
      expect(listed.sort()).to.deep.equal(Object.keys(repo).sort());
    } finally {
      rmSync(tmp, {recursive: true, force: true});
    }
  });

  it("RepoSet is the same repository as one zip", async () => {
    const {zip, files} = await repoZip(DEFAULT_URL, "ZSTG_DEMO");
    const repo = await repoFiles(DEFAULT_URL, "ZSTG_DEMO");
    expect(files).to.equal(Object.keys(repo).length);
    // a zip: PK\x03\x04 at the start, the end of central directory at the end,
    // and the local file header of every entry carries its name
    expect(zip.subarray(0, 4).toString("latin1")).to.equal("PK\u0003\u0004");
    expect(zip.subarray(-22, -18).toString("latin1")).to.equal("PK\u0005\u0006");
    const text = zip.toString("latin1");
    for (const name of Object.keys(repo)) {
      expect(text, name).to.contain(name);
    }
    // put the seeded project back for whatever runs after
    await pushFile(DEFAULT_URL, readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"));
  });

  it("GET ExportSet of a project nobody imported is 400", async () => {
    const res = await fetch(`${DEFAULT_URL}/sap/opu/odata/sap/ZSTG_SEGW_SRV/ExportSet('NOBODY')`);
    expect(res.status).to.equal(400);
    expect(await res.text()).to.contain("no project NOBODY");
  });

  it("POST ImportSet refuses a field SEGW never writes and leaves the tables alone", async () => {
    const xml = readFileSync("test/fixtures/segw/zstg_mini.iwpr.xml", "utf8");
    const res = await fetch(`${DEFAULT_URL}/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet`, {
      method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({Content: xml.replace("<NAME>Travel</NAME>", "<NAME>Travel</NAME>\n     <MADE_UP>x</MADE_UP>")}),
    });
    expect(res.status).to.equal(400);
    expect(await res.text()).to.contain("SBO_ET.MADE_UP: not a field of ZSTG_SBO_ET");
    expect(exportIwpr(await pull(DEFAULT_URL, "ZSTG_MINI", spec), "ZSTG_MINI", spec)).to.equal(xml);
  });
});
