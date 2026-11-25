import {readJSONFile, readTraceMap} from "./trace-reader.mjs";
// The L1 DPC class is byte-identical with the string generator on every
// project admitted by the MPC bridge, with trace and profile checks.
import {expect} from "chai";
import {readFileSync, readdirSync, mkdtempSync, rmSync, mkdirSync, cpSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {resolve} from "node:path";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {embeddedSource} from "../tools/dsl-dpc-embed.mjs";
import {compile, compileFile} from "../tools/stg-compile.mjs";
import {loadFunctionGroups} from "../tools/segw-gen-mapping.mjs";
import {generate, parseIwpr} from "../tools/segw-gen.mjs";
import {readSpec, tableName} from "../tools/segw-tables.mjs";
import {renderProject} from "../tools/dsl-dpc.mjs";

const FIXTURES = [
  "test/fixtures/segw/zstg_label.iwpr.xml",
  "test/fixtures/segw/zstg_mapped.iwpr.xml",
  "test/fixtures/segw/zstg_mini.iwpr.xml",
  "src/zosd_test/segw/zosd_test.iwpr.xml",
];
function sourceSpecs(dir = "src") {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceSpecs(path) : entry.name.endsWith(".stg.yaml") ? [path] : [];
  });
}
const builtNames = new Set(readdirSync("gen/stg"));
const allCompiled = ["src", "gen/cds", "packs"].flatMap((root) => sourceSpecs(root))
  .filter((path) => builtNames.has(path.split("/").pop().replace(/\.stg\.yaml$/, "")) || /\b(?:function|searchhelp):/.test(readFileSync(path, "utf8")))
  .map((path) => ({path, xml: compileFile(path).iwpr}));
const overlong = allCompiled.filter(({xml}) =>
  parseIwpr(xml).entityTypes.some((type) => type.ABAP_STRUCT?.length > 32));
const compiled = allCompiled.filter((item) => !overlong.includes(item));

function assertData(value, path = "") {
  if (typeof value === "string") {
    if (!path.endsWith("/separator")) expect(value, `${path} contains line breaks`).not.to.match(/[\r\n]/);
    expect(value, `${path} contains ABAP code`).not.to.match(/\b(?:types?|data|constants?|methods?|class|endclass|endmethod)\b.*[.,]|->/i);
  } else if (value?.kind === "raw_token") {
    expect(value.raw_token, `${path} raw token`).to.match(/^(?:[A-Za-z_][A-Za-z0-9_]*|\/[A-Za-z0-9_]+\/[A-Za-z_][A-Za-z0-9_]*|-?[0-9]+(?:\.[0-9]+)?)$/);
    expect(value.raw_token).not.to.match(/[\r\n]/);
    expect(value).not.to.have.property("value");
    for (const [key, child] of Object.entries(value)) assertData(child, `${path}/${key}`);
  } else if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    expect(key, `${path} opaque field`).not.to.equal("opaque");
    assertData(child, `${path}/${key}`);
  }
}

describe("DSL L1: full DPC class from typed model", function () {
  this.timeout(120000);
  let abap;
  let count = 0;
  let mutationProject;
  let mappingProject;
  const coverage = new Set();
  const reached = new Set();
  const report = [];
  const seen = {mapped: 0, missingRfc: 0, sadl: 0, odc: 0};
  const box = (value) => new abap.types.String().set(value);

  before(async () => {
    await import("./start.mjs");
    abap = globalThis.abap;
    for (const name of ["zcl_osd_dsl_dpc_templates", "zcl_osd_dsl_dpc", "zcl_osd_dsl_mapping", "zcl_osd_dsl_dpc_map", "zcl_stg_segw_fugr", "zcl_stg_segw_gen",
      "zcl_stg_segw_gen_dpc", "zcl_osd_tpl", "zcl_osd_dsl_trace", "zcl_osd_dsl_profile",
      "zcl_stg_dispatcher", "zcl_ajson"]) await import(`../output/${name}.clas.mjs`);
    for (const file of ["test/fixtures/segw/zstg_rfc.fugr.xml", "test/fixtures/dsl-dpc/zl1_mapping.fugr.xml"]) {
      await abap.Classes.ZCL_STG_SEGW_FUGR.import({iv_content: box(readFileSync(file, "utf8"))});
    }
  });

  after(async () => {
    const db = abap.context.databaseConnections.DEFAULT;
    for (const tag of Object.keys(readSpec())) {
      await db.execute(`DELETE FROM ${tableName(tag).toLowerCase()} WHERE project LIKE 'ZUTDPC%'`);
    }
  });

  async function imported(path, suppliedXml) {
    const project = `ZUTDPC${++count}`;
    const xml = (suppliedXml ?? readFileSync(path, "utf8"))
      .replace(/<PROJECT>[^<]+<\/PROJECT>/g, `<PROJECT>${project}</PROJECT>`);
    const response = await abap.Classes.ZCL_STG_DISPATCHER.dispatch_decoded({
      iv_method: box("POST"),
      iv_path: box("/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet"),
      iv_body: box(JSON.stringify({Content: xml})),
    });
    const status = response.get().status.get();
    expect([200, 201], `${path}: ${response.get().body.get().slice(0, 300)}`).to.include(status);
    return abap.Classes.ZCL_STG_SEGW_GEN.build_model({iv_project: box(project)});
  }

  it("keeps the same documented SEGW width exclusion as the MPC bridge", () => {
    expect(overlong.map(({path}) => path).sort()).to.deep.equal([
      "gen/cds/zc_osd_taxicube_cds.stg.yaml",
      "gen/cds/zc_stg_flightcube_cds.stg.yaml",
      "gen/cds/zc_stg_travelcube_cds.stg.yaml",
    ]);
  });

  it("keeps the ABAP embedded templates in sync with their sources", () => {
    expect(readFileSync("src/dsl/zcl_osd_dsl_dpc_templates.clas.abap", "utf8")).to.equal(embeddedSource());
  });

  it("the embed --check command detects a dirty embed and passes after restoration", () => {
    const dir = mkdtempSync(join(tmpdir(), "dsl-dpc-embed-"));
    const target = "src/dsl/zcl_osd_dsl_dpc_templates.clas.abap";
    const clean = readFileSync(target, "utf8");
    const check = () => spawnSync(process.execPath, [resolve("tools/dsl-dpc-embed.mjs"), "--check"], {cwd: dir, encoding: "utf8"});
    try {
      mkdirSync(join(dir, "src/dsl"), {recursive: true});
      cpSync("src/dsl/dpc-templates", join(dir, "src/dsl/dpc-templates"), {recursive: true});
      writeFileSync(join(dir, target), clean);
      expect(check().status).to.equal(0);
      writeFileSync(join(dir, target), clean + "* dirty embed\n");
      const dirty = check();
      expect(dirty.status).not.to.equal(0);
      expect(dirty.stderr).to.include("differs from templates");
      writeFileSync(join(dir, target), clean);
      expect(check().status).to.equal(0);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  const complexXml = compile(`
project: ZSTG_CT
service: ZSTG_CT_SRV
complexTypes:
  Address:
    properties:
      Street: String(40)
      City: String(40)
  Money:
    source: {struct: ZSTG_MONEY}
    properties:
      Amount: Decimal(15,2)
      Currency: String(5)
entities:
  Customer:
    keys: [CustomerId]
    properties:
      CustomerId: String(10)
      Address: Address
functions:
  Quote:
    method: GET
    returns: {complexType: Money}
    parameters:
      CustomerId: String(10)
`, {file: "zstg_ct.stg.yaml"}).iwpr;
  const mappingXml = compileFile("test/fixtures/dsl-dpc/zl1_mapping.stg.yaml").iwpr;
  const bopXml = mappingXml.replace(/^   <\/_-IWBEP_-I_SBD_GA>/m, `<_-IWBEP_-I_SBD_GA><PROJECT>ZL1_MAPPING</PROJECT><NODE_UUID>l1-bop</NODE_UUID><NAME>ZIF_L1_MAP</NAME><GEN_ART_TYPE>BOP</GEN_ART_TYPE><RFC_NAME>Z_L1_MAP</RFC_NAME></_-IWBEP_-I_SBD_GA></_-IWBEP_-I_SBD_GA>`).replace("<SEMANTICS>H</SEMANTICS>", "<SEMANTICS>Z</SEMANTICS>");
  const projects = [
    ...FIXTURES.map((path) => ({path})),
    {path: "compiled complex", xml: complexXml},
    ...compiled,
    {path: "test/fixtures/dsl-dpc/zl1_mapping.stg.yaml", xml: mappingXml},
    {path: "compiled mapping with BOP artifact and custom range semantics", xml: bopXml},
  ];

  for (const {path, xml} of projects) {
    it(`compares ${path}`, async () => {
      const model = await imported(path, xml);
      if (path === "src/zosd_test/segw/zosd_test.iwpr.xml") mutationProject = model;
      if (path === "test/fixtures/dsl-dpc/zl1_mapping.stg.yaml") mappingProject = model;
      const oracleXml = (xml ?? readFileSync(path, "utf8")).replace(/<PROJECT>[^<]+<\/PROJECT>/g, `<PROJECT>${model.get().project.get()}</PROJECT>`);
      const twin = generate(oracleXml, {functionModules: loadFunctionGroups(["test/fixtures/segw", "test/fixtures/dsl-dpc"])});
      const expected = (await abap.Classes.ZCL_STG_SEGW_GEN_DPC.dpc_source_legacy({is_model: model})).get();
      expect(expected, `${path} ABAP versus JS oracle`).to.equal(twin.files[`${model.get().dpc.get().toLowerCase()}.clas.abap`]);
      const shape = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: model})).get());
      seen.mapped += shape.impls.filter((impl) => impl.mapping).length;
      assertData(shape);
      seen.missingRfc += shape.impls.filter((impl) => impl.missing_rfc).length;
      seen.sadl += shape.impls.filter((impl) => impl.sadl_get_dpc).length;
      seen.odc += shape.impls.filter((impl) => impl.odc_q || impl.odc_r).length;
      const data = await abap.Classes.ZCL_OSD_DSL_DPC.project_model({is_model: model});
      const result = await abap.Classes.ZCL_OSD_DSL_DPC.render_class({is_model: model});
      const actual = (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: result})).get();
      const mismatch = [...actual].findIndex((ch, i) => ch !== expected[i]);
      expect(actual, `${path} at byte ${mismatch}: ${JSON.stringify(actual.slice(mismatch - 50, mismatch + 100))} versus ${JSON.stringify(expected.slice(mismatch - 50, mismatch + 100))}`).to.equal(expected);
      // The production path: generate() ships the DSL class, its trace sidecar
      // (one node per line) and no legacy bytes.
      if (model.get().mpc.get() && model.get().dpc.get()) {
        const files = new Map();
        for (const file of (await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box(model.get().project.get())})).array()) {
          files.set(file.get().name.get(), file.get().content.get());
        }
        const dpcName = model.get().dpc.get().toLowerCase();
        expect(files.get(`${dpcName}.clas.abap`), `${path} generate() DPC equals dpc_source_legacy`).to.equal(expected);
        const shipped = readTraceMap(files, `${dpcName}.clas.trace.json`);
        expect(shipped.generator, `${path} DPC sidecar shipped`).to.equal("dsl-dpc");
        expect(shipped.lines?.length, `${path} one trace node per DPC line`).to.equal(expected.trimEnd().split("\n").length);
        expect(shipped.lines.every((line) => line.node), `${path} shipped trace nodes`).to.equal(true);
      }
      const traces = result.get().trace.array();
      const lines = result.get().lines.array();
      expect(traces.length, `${path} trace count`).to.equal(lines.length);
      const sidecar = JSON.parse((await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({
        iv_legacy: new abap.types.Character(1).set("X"), iv_generator: box("dsl-dpc"), iv_template: box("dpc_class"), io_model: data, is_result: result,
      })).get());
      expect(sidecar.lines.length).to.equal(lines.length);
      expect(sidecar.lines.every((line) => line.node && line.path && line.template_line > 0),
        `${path} trace nodes`).to.equal(true);
      const findings = (await abap.Classes.ZCL_OSD_DSL_PROFILE.check({
        iv_profile: box("abap"), iv_strict: box(""), is_result: result, io_model: data,
      })).array();
      expect(findings, `${path} clean ABAP profile`).to.deep.equal([]);
      for (const trace of traces) reached.add(trace.get().template.get());
      const operations = shape.impls.filter((impl) => impl.mapping).map((impl) => {
        const m = impl.mapping;
        if (impl.shlp_mapped) coverage.add("search help");
        else {
          coverage.add("exceptions");
          if (m.inputs.length) coverage.add("IN");
          if (m.outputs.length) coverage.add("OUT");
          if (m.parameters.some((p) => p.is_tables)) coverage.add("TABLES");
          if (m.filters.some((f) => f.ranges.length)) coverage.add("RANGES");
          if (m.constants.length) coverage.add("CONSTANTS");
        }
        const node = impl["@id"];
        const start = lines.findIndex((line) => line.get() === `  method ${impl.name}.`);
        const end = lines.findIndex((line, i) => i > start && line.get() === "  endmethod.");
        expect(start, `${impl.name} body exists`).to.be.at.least(0);
        expect(sidecar.lines.slice(start, end + 1).every((line) => line.node === node || line.node.startsWith(`${node}/`)), `${impl.name} own trace`).to.equal(true);
        const bodyLines = end - start + 1;
        return {method: impl.name, lines: bodyLines};
      });
      report.push({path, lines: lines.length, operations});
      console.log(`${path}: ${lines.length} DPC lines${operations.length ? `; ${operations.map((op) => `${op.method}=${op.lines}`).join(", ")}` : ""}`);
    });
  }

  it("refuses a planted DPC profile error with the same message shape as MPC", async () => {
    const model = await imported("profile error", readFileSync(FIXTURES[2], "utf8"));
    // Plant an actual rendered line error, keeping its original trace position.
    // Checking both consumers holds the DPC error contract to the MPC's.
    for (const consumer of ["MPC", "DPC"]) {
      const klass = abap.Classes[`ZCL_OSD_DSL_${consumer}`];
      const renderer = klass.render_model;
      klass.render_model = async (...args) => {
        const result = await renderer.call(klass, ...args);
        result.get().lines.array()[0].set("X".repeat(256));
        return result;
      };
      try {
        let error;
        try {
          await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box(model.get().project.get())});
        } catch (caught) { error = caught; }
        expect(error, `${consumer}: GenerateSet must report the planted error`)
          .to.be.instanceOf(abap.Classes["/IWBEP/CX_MGW_BUSI_EXCEPTION"]);
        const className = model.get()[consumer.toLowerCase()].get();
        expect(error.message.get()).to.match(new RegExp(
          `^${className}: line_length at line 1, template line \\d+, node [^:]+: Line exceeds 255 characters$`));
      } finally {
        klass.render_model = renderer;
      }
    }
    // The real renderer is restored and the same project generates cleanly.
    await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box(model.get().project.get())});
  });

  it("constant spellings match both oracles and each assignment owns its trace node", async () => {
    const json = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: mappingProject})).get());
    assertData(json);
    const output = await rendered(json);
    const spellings = {R: "abap_true", C: "007", U: "1.5", D: "-7", Q: "'O''Brien'"};
    const ids = new Set();
    for (const [op, token] of Object.entries(spellings)) {
      const mapping = json.impls.find((impl) => impl.rfc_mapped && impl.mapping[`is_${op.toLowerCase()}`] && impl.mapping.constants.some((item) => item.parameter === "iv_count")).mapping;
      const constant = mapping.constants.find((item) => item.parameter === "iv_count");
      const raw = ["R", "C", "U"].includes(op);
      expect(constant.kind).to.equal(raw ? "raw_token" : "literal");
      if (raw) {
        expect(constant.raw_token).to.equal(token);
        expect(constant).not.to.have.property("value");
      } else expect(constant["value@type"].built_in).to.equal(op === "D" ? "INT4" : "CHAR");
      const owned = output.lines.filter((_, i) => output.trace[i].node === constant["@id"]);
      expect(owned).to.deep.equal([` iv_count = ${token}.`]);
      ids.add(constant["@id"]);
    }
    expect(ids.size).to.equal(5);
    const expected = (await abap.Classes.ZCL_STG_SEGW_GEN_DPC.dpc_source_legacy({is_model: mappingProject})).get();
    expect(output.text).to.equal(expected);
  });

  it("refuses constants containing source fragments instead of one token", async () => {
    const source = readFileSync("test/fixtures/dsl-dpc/zl1_mapping.stg.yaml", "utf8");
    for (const token of ["abap true", "abap_true + 1", "abap_true. WRITE x", "'broken", "a\nb", "abap_true\n", "abap_true\r"]) {
      const xml = compile(source.replace('IV_COUNT: "abap_true"', `IV_COUNT: ${JSON.stringify(token)}`)).iwpr;
      const model = await imported(`unsafe constant ${JSON.stringify(token)}`, xml);
      let error;
      try { await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: model}); }
      catch (caught) { error = caught; }
      expect(error, `reject ${JSON.stringify(token)}`).to.exist;
    }
  });

  it("rejects routing every constant through literal, then restores green", async () => {
    const json = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: mappingProject})).get());
    const path = "src/dsl/dpc-templates/rfc-constant_lines.tpl";
    const dir = mkdtempSync(join(tmpdir(), "dsl-dpc-mutant-"));
    try {
      cpSync(path, join(dir, "original.tpl"));
      const original = readFileSync(join(dir, "original.tpl"), "utf8");
      const mutant = original.replace("{{#raw_token}}{{raw_token}}{{/raw_token}}{{^raw_token}}{{value | literal}}{{/raw_token}}", "{{value | literal}}");
      expect(mutant).not.to.equal(original);
      let error;
      try { await rendered(json, {"rfc-constant_lines": mutant}); }
      catch (caught) { error = caught; }
      expect(error, "all constants through literal must go red").to.exist;
      // Also reproduce the old INT4 classification: identifiers/decimals
      // throw, while leading zeroes silently change the oracle's bytes.
      for (const op of ["r", "c", "u"]) {
        const changed = structuredClone(json);
        const constant = changed.impls.find((impl) => impl.rfc_mapped && impl.mapping[`is_${op}`]).mapping.constants.find((item) => item.parameter === "iv_count");
        const token = constant.raw_token;
        delete constant.raw_token;
        constant.kind = "literal";
        constant.value = token;
        constant["value@type"] = {"@id": constant["@id"] + "/type", built_in: "INT4", length: "255"};
        let failed;
        let result;
        try { result = await rendered(changed); } catch (caught) { failed = caught; }
        if (op === "c") {
          expect(failed).not.to.exist;
          expect(result.text).to.include(" iv_count = 7.");
          expect(result.text).not.to.include(" iv_count = 007.");
        } else expect(failed, `${token} through INT4 literal goes red`).to.exist;
      }
      const expected = (await abap.Classes.ZCL_STG_SEGW_GEN_DPC.dpc_source_legacy({is_model: mappingProject})).get();
      expect((await rendered(json)).text, "original restored green").to.equal(expected);
      console.log("mutant every constant through literal: RED; original restored GREEN");
    } finally { rmSync(dir, {recursive: true, force: true}); }
  });

  it("the corpus reaches mapped, SADL and ODC branches", () => {
    expect(seen.mapped).to.be.greaterThan(0);
    expect(seen.missingRfc).to.be.greaterThan(0);
    expect(seen.sadl).to.be.greaterThan(0);
    expect(seen.odc).to.be.greaterThan(0);
    expect([...coverage].sort()).to.deep.equal(["CONSTANTS", "IN", "OUT", "RANGES", "TABLES", "exceptions", "search help"]);
    for (const name of readdirSync("src/dsl/dpc-templates").filter((name) => /^(rfc|shlp)-.*\.tpl$/.test(name))) {
      expect(reached.has(name.slice(0, -4)), `${name} has traced output`).to.equal(true);
    }
    console.log(`Mapping coverage: ${[...coverage].sort().join(", ")}`);
    console.log(`Byte bridge: ${report.length} cases, ${report.reduce((n, p) => n + p.operations.length, 0)} mapped operations, ${report.reduce((n, p) => n + p.lines, 0)} class lines`);
  });

  it("mutations change only lines traced to their model node", async () => {
    const json = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: mutationProject})).get());
    const parse = (value) => abap.Classes.ZCL_AJSON.parse({iv_json: box(JSON.stringify(value))});
    const baseModel = await parse(json);
    const base = await abap.Classes.ZCL_OSD_DSL_DPC.render_model({io_model: baseModel});
    const baseLines = base.get().lines.array().map((line) => line.get());
    const sidecar = JSON.parse((await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({
      iv_legacy: new abap.types.Character(1).set("X"), iv_generator: box("dsl-dpc"), iv_template: box("dpc_class"), io_model: baseModel, is_result: base,
    })).get());
    // exact counts measured 2026-10-01 (5/1/1/1): a mutation that starts touching more or fewer lines fails
    const changes = [
      {count: 5, node: json["@id"], edit: (data) => { data.generated_on = "02.10.2026"; }},
      {count: 1, node: json.declarations[0]["@id"], edit: (data) => { data.declarations[0].method += "_ALT"; }},
      {count: 1, node: json.sadl_sources[0]["@id"], edit: (data) => { data.sadl_sources[0].binding += "_ALT"; }},
      {count: 1, node: json.sadl_structures[0].properties[0]["@id"],
        edit: (data) => { data.sadl_structures[0].properties[0].abap_field += "_ALT"; }},
    ];
    for (const {count, node, edit} of changes) {
      const changed = structuredClone(json);
      edit(changed);
      const result = await abap.Classes.ZCL_OSD_DSL_DPC.render_model({io_model: await parse(changed)});
      const lines = result.get().lines.array().map((line) => line.get());
      expect(lines.length, `${node} line count`).to.equal(baseLines.length);
      const indices = lines.flatMap((line, i) => line !== baseLines[i] ? [i] : []);
      expect(indices.length, `${node} changed lines`).to.equal(count);
      expect(indices.every((i) => sidecar.lines[i].node === node), `${node} changed only own lines`).to.equal(true);
      expect(sidecar.lines.filter((line) => line.node === node).length, `${node} has traced lines`).to.be.greaterThan(0);
    }
  });

  const parse = (value) => abap.Classes.ZCL_AJSON.parse({iv_json: box(JSON.stringify(value))});
  async function rendered(json, overrides = {}) {
    const data = await parse(json);
    let result;
    if (Object.keys(overrides).length) {
      const partials = new abap.types.Table(new abap.types.Structure({name: new abap.types.String(), template: new abap.types.String()}));
      for (const file of readdirSync("src/dsl/dpc-templates").filter((file) => file.endsWith(".tpl") && file !== "class.tpl")) {
        const name = file.slice(0, -4);
        partials.append(new abap.types.Structure({name: box(name), template: box(overrides[name] ?? readFileSync(`src/dsl/dpc-templates/${file}`, "utf8"))}));
      }
      result = await abap.Classes.ZCL_OSD_TPL.render({iv_template: box(readFileSync("src/dsl/dpc-templates/class.tpl", "utf8")), ii_data: data, it_partials: partials});
    } else result = await abap.Classes.ZCL_OSD_DSL_DPC.render_model({io_model: data});
    const sidecar = JSON.parse((await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({
      iv_legacy: new abap.types.Character(1).set("X"), iv_generator: box("dsl-dpc"), iv_template: box("dpc_class"), io_model: data, is_result: result,
    })).get());
    const lines = result.get().lines.array().map((line) => line.get());
    return {data, result, lines, trace: sidecar.lines, text: (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: result})).get()};
  }

  it("five mapped model mutations touch only their nodes, including insertion and reorder", async () => {
    const json = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: mappingProject})).get());
    const base = await rendered(json);
    const read = (data) => data.impls.find((impl) => impl.rfc_mapped && impl.mapping.is_r).mapping;
    const query = (data) => data.impls.find((impl) => impl.rfc_mapped && impl.mapping.is_q && impl.mapping.has_filters).mapping;
    const help = (data) => data.impls.find((impl) => impl.shlp_mapped && impl.mapping.is_r && impl.mapping.has_inputs).mapping;
    const range = {...query(json).filters.find((f) => f.has_ranges).ranges[0], "@id": "mutation/range/HIGH2", component: "high2"};
    const changes = [
      {name: "rename module parameter mapping", nodes: [read(json).inputs[0]["@id"]], count: 1,
        edit: (data) => { read(data).inputs[0].parameter = "iv_alt"; }},
      {name: "constant value", nodes: [read(json).constants[0]["@id"]], count: 1,
        edit: (data) => { read(data).constants[0].value = "Changed'Value"; }},
      {name: "add range mapping", nodes: [range["@id"]], count: 1,
        edit: (data) => { query(data).filters.find((f) => f.has_ranges).ranges.push(range); }},
      {name: "search help name", nodes: [help(json).module["@id"]], count: 3,
        edit: (data) => { help(data).module.name = "ZL1_ALTERNATE"; }},
      {name: "swap IN mappings", nodes: read(json).inputs.map((item) => item["@id"]), count: 2,
        edit: (data) => { read(data).inputs.reverse(); }},
    ];
    for (const {name, nodes, count, edit} of changes) {
      const changed = structuredClone(json);
      edit(changed);
      const after = await rendered(changed);
      const outside = (r) => r.lines.filter((_, i) => !nodes.includes(r.trace[i].node));
      expect(outside(after), `${name}: other nodes byte-identical`).to.deep.equal(outside(base));
      const own = (r) => r.lines.filter((_, i) => nodes.includes(r.trace[i].node));
      expect(own(after), `${name}: own lines change`).not.to.deep.equal(own(base));
      if (after.lines.length === base.lines.length) {
        const indices = after.lines.flatMap((line, i) => line === base.lines[i] ? [] : [i]);
        expect(indices.length, name).to.equal(count);
        expect(indices.every((i) => nodes.includes(base.trace[i].node) && nodes.includes(after.trace[i].node)), name).to.equal(true);
      } else {
        expect(after.lines.length - base.lines.length, name).to.equal(count);
        expect(own(after).length - own(base).length, name).to.equal(count);
      }
      const findings = (await abap.Classes.ZCL_OSD_DSL_PROFILE.check({iv_profile: box("abap"), iv_strict: box(""), is_result: after.result, io_model: after.data})).array();
      expect(findings.filter((f) => f.get().severity.get() === "E"), name).to.deep.equal([]);
      console.log(`mutation ${name}: ${count} own line(s)`);
    }
  });

  const mutants = [
    {name: "drops one OUT mapping", partial: "rfc-read", edit: (text) => text.replace("{{#outputs}}", "{{#outputs}}{{^@first}}").replace("{{/outputs}}", "{{/@first}}{{/outputs}}")},
    {name: "reverses IN mapping order", partial: "rfc-read", edit: (text) => text.replace(/{{#inputs}}[\s\S]*?{{\/inputs}}/, " {{inputs.2.parameter}}-{{inputs.2.component}} = ls_converted_keys-{{inputs.2.field}}.\n {{inputs.1.parameter}} = ls_converted_keys-{{inputs.1.field}}.\n")},
    {name: "constant loses literal quotes", partial: "rfc-constant_lines", edit: (text) => text.replace("value | literal", "value")},
    {name: "search-help method keeps opaque text", partial: "shlp-read", opaque: true, edit: () => "{{{opaque}}}"},
  ];
  for (const {name, partial, edit, opaque} of mutants) {
    it(`rejects template mutant: ${name}`, async () => {
      const json = JSON.parse((await abap.Classes.ZCL_OSD_DSL_DPC.project_model_json({is_model: mappingProject})).get());
      const expected = (await abap.Classes.ZCL_STG_SEGW_GEN_DPC.dpc_source_legacy({is_model: mappingProject})).get();
      const text = readFileSync(`src/dsl/dpc-templates/${partial}.tpl`, "utf8");
      const changed = structuredClone(json);
      if (opaque) {
        // A pre-rendered body can be byte-identical and still violate L1.
        for (const impl of changed.impls.filter((impl) => impl.shlp_mapped && impl.mapping.is_r)) {
          const start = expected.indexOf(`  method ${impl.name}.\n`);
          const end = expected.indexOf("  endmethod.\n", start) + "  endmethod.\n".length;
          impl.mapping.opaque = expected.slice(start, end);
        }
      }
      const mutant = await rendered(changed, {[partial]: edit(text)});
      if (opaque) {
        expect(mutant.text, "opaque byte equality alone would pass").to.equal(expected);
        expect(() => assertData(changed), `${name} data-only bridge red`).to.throw();
        const mapping = changed.impls.find((impl) => impl.shlp_mapped && impl.mapping.is_r && impl.mapping.has_inputs).mapping;
        expect(mutant.trace.some((line) => line.node === mapping.inputs[0]["@id"]), "opaque input trace disappears").to.equal(false);
      } else {
        expect(mutant.text, `${name} must change output`).not.to.equal(expected);
        expect(() => expect(mutant.text).to.equal(expected), `${name} byte bridge red`).to.throw();
      }
      // The override is scoped to one render. Re-render the unmodified named path green.
      expect((await rendered(json)).text, `${name} restored green`).to.equal(expected);
      console.log(`mutant ${name}: RED; original restored GREEN`);
    });
  }

  it("the render command writes the DPC source and complete trace sidecar", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dsl-dpc-"));
    try {
      const {abapFile, traceFile, findings} = await renderProject("test/fixtures/segw/zstg_mapped.iwpr.xml", dir, {project: "ZUTDPCCLI"});
      const source = readFileSync(abapFile, "utf8");
      const trace = readJSONFile(traceFile, "utf8");
      expect(source).to.include("/IWBEP/CL_MGW_PUSH_ABS_DATA");
      expect(trace.generator).to.equal("dsl-dpc");
      expect(trace.lines.length).to.equal(source.trimEnd().split("\n").length);
      expect(trace.lines.every((line) => line.node)).to.equal(true);
      expect(findings.filter((finding) => finding.severity === "E")).to.deep.equal([]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
