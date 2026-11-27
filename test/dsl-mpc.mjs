import {readJSONFile} from "./trace-reader.mjs";
// Every _MPC method body rendered from L1 equals the SEGW generator's bytes.
// The fixture trees are imported through ImportSet under this suite's names.
import {expect} from "chai";
import {readFileSync, readdirSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {renderProject} from "../tools/dsl-mpc.mjs";
import {compile, compileFile} from "../tools/stg-compile.mjs";
import {readSpec, tableName} from "../tools/segw-tables.mjs";
import {parseIwpr} from "../tools/segw-gen.mjs";

const FIXTURES = [
  "test/fixtures/segw/zstg_label.iwpr.xml",
  "test/fixtures/segw/zstg_mapped.iwpr.xml",
  "test/fixtures/segw/zstg_mini.iwpr.xml",
  "src/zosd_test/segw/zosd_test.iwpr.xml",
];
const METHODS = ["DEFINE", "DEFINE_COMPLEXTYPES", "DEFINE_ASSOCIATIONS", "DEFINE_ACTIONS", "GET_LAST_MODIFIED", "LOAD_TEXT_ELEMENTS"];
function sourceSpecs(dir = "src") {
  return readdirSync(dir, {withFileTypes: true}).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sourceSpecs(path) : entry.name.endsWith(".stg.yaml") ? [path] : [];
  });
}
const builtNames = new Set(readdirSync("gen/stg"));
const ALL_COMPILED = ["src", "gen/cds", "packs"].flatMap((root) => sourceSpecs(root))
  .filter((path) => builtNames.has(path.split("/").pop().replace(/\.stg\.yaml$/, "")))
  .map((path) => ({path, xml: compileFile(path).iwpr}));
// ImportSet enforces SBO_ET.ABAP_STRUCT CHAR 32. Three generated CDS trees
// carry a longer class=>type reference and cannot enter the SEGW tables.
const OVERLONG = ALL_COMPILED.filter(({xml}) =>
  parseIwpr(xml).entityTypes.some((type) => type.ABAP_STRUCT?.length > 32));
const COMPILED = ALL_COMPILED.filter((item) => !OVERLONG.includes(item));

describe("DSL L1: MPC methods from the model, byte for byte", function () {
  this.timeout(120000);
  let abap;
  let demoXml;
  let complexXml;
  const box = (value) => new abap.types.String().set(value);

  before(async () => {
    demoXml = compileFile("src/demo/zstg_demo.stg.yaml").iwpr;
    complexXml = compile(`
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
    await import("./start.mjs");
    abap = globalThis.abap;
    await import("../output/zcl_osd_dsl_mpc.clas.mjs");
    await import("../output/zcl_stg_segw_gen.clas.mjs");
    await import("../output/zcl_osd_tpl.clas.mjs");
    await import("../output/zcl_osd_dsl_trace.clas.mjs");
    await import("../output/zcl_osd_dsl_profile.clas.mjs");
    await import("../output/zcl_stg_dispatcher.clas.mjs");
  });

  // Each fixture is imported under a project name of this test's own, so the
  // projects other suites seed or push (ZSTG_MAPPED, ZSTG_MINI, ...) are not
  // touched, and every row it wrote is deleted afterwards.
  const OWN = "ZUTDSL";
  let imported = 0;
  after(async () => {
    const db = abap.context.databaseConnections.DEFAULT;
    for (const tag of Object.keys(readSpec())) {
      await db.execute(`DELETE FROM ${tableName(tag).toLowerCase()} WHERE project LIKE '${OWN}%'`);
    }
  });

  async function importProject(path, suppliedXml) {
    const project = `${OWN}${++imported}`;
    const xml = (suppliedXml ?? readFileSync(path, "utf8")).replace(/<PROJECT>[^<]+<\/PROJECT>/g, `<PROJECT>${project}</PROJECT>`);
    const response = await abap.Classes.ZCL_STG_DISPATCHER.dispatch_decoded({
      iv_method: box("POST"),
      iv_path: box("/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet"),
      iv_body: box(JSON.stringify({Content: xml})),
    });
    const status = response.get().status.get();
    expect([200, 201], `${path}: ${response.get().body.get().slice(0, 300)}`).to.include(status);
    return project;
  }

  it("names the compiled projects excluded by the SEGW table width", () => {
    expect(OVERLONG.map(({path}) => path).sort()).to.deep.equal([
      "gen/cds/zc_osd_taxicube_cds.stg.yaml",
      "gen/cds/zc_stg_flightcube_cds.stg.yaml",
      "gen/cds/zc_stg_travelcube_cds.stg.yaml",
    ]);
  });

  // The ZUT_DSL ABAP Unit fixture alone reaches entity semantics, media,
  // and the association default-set line (no explicit association set).
  // The compiled complex project reaches both complex binding variants.
  const needles = {
    creatable: "set_creatable( abap_true )", updatable: "set_updatable( abap_true )",
    sortable: "set_sortable( abap_true )", key: "set_is_key( )",
    label: "set_label_from_text_element(", sets: "create_entity_set(",
    dispatcher: "define_associations( ).", complexDispatcher: "define_complextypes( ).",
    complexType: "model->create_complex_type(", complexProperty: "lo_complex_type->create_property(",
    complexDdic: "lo_complex_type->bind_structure( iv_structure_name   = 'ZSTG_MONEY'",
    complexClass: "lo_complex_type->bind_structure( iv_structure_name = '",
    association: "create_association(", constraint: "create_ref_constraint( )",
    associationSet: "create_association_set(", navigation: "create_navigation_property(",
    action: "create_action(", actionParameter: "create_input_parameter(",
    actionFor: "set_action_for(", actionReturnEntity: "set_return_entity_type(",
    actionReturnComplex: "set_return_complex_type(", actionHttp: "set_http_method(",
    parameterLength: "lo_parameter->/iwbep/if_mgw_odata_property~set_maxlength(",
    text: "ls_text_element-artifact_name", emptyText: "CLEAR ls_text_element.",
    stamp: "lc_gen_date_time",
  };
  const seen = Object.fromEntries(Object.keys(needles).map((key) => [key, 0]));

  for (const path of [...FIXTURES, "compiled demo", "compiled complex", ...COMPILED.map(({path}) => path)]) {
    it(`every method of ${path.split("/").pop()}`, async () => {
      const project = await importProject(path, path === "compiled demo" ? demoXml : path === "compiled complex" ? complexXml : COMPILED.find((item) => item.path === path)?.xml);
      const model = await abap.Classes.ZCL_STG_SEGW_GEN.build_model({iv_project: box(project)});
      const source = (await abap.Classes.ZCL_STG_SEGW_GEN.mpc_source({is_model: model})).get();
      const legacy = (await abap.Classes.ZCL_STG_SEGW_GEN.mpc_source_legacy({is_model: model})).get();
      const projectJson = await abap.Classes.ZCL_OSD_DSL_MPC.project_model({is_model: model});
      const data = JSON.parse((await abap.Classes.ZCL_OSD_DSL_MPC.project_model_json({is_model: model})).get());
      const inspect = (value, path = "$") => {
        if (typeof value === "string") {
          expect(value, `${project} ${path} contains a line break`).not.to.match(/[\r\n]/);
          expect(value, `${project} ${path} contains ABAP code`).not.to.match(/\b(?:types?|data|constants?|methods?|class|endclass|endmethod)\b.*[.,]|->/i);
        } else if (Array.isArray(value)) value.forEach((item, i) => inspect(item, `${path}[${i}]`));
        else if (value && typeof value === "object") Object.entries(value).forEach(([key, item]) => inspect(item, `${path}.${key}`));
      };
      inspect(data);
      expect(source, `${project} DSL versus legacy`).to.equal(legacy);
      const whole = await abap.Classes.ZCL_OSD_DSL_MPC.render_class({is_model: model});
      const wholeText = (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: whole})).get();
      const mismatch = [...wholeText].findIndex((ch, i) => ch !== source[i]);
      expect(wholeText, `${project} whole class at ${mismatch}: ${JSON.stringify(wholeText.slice(mismatch - 70, mismatch + 120))} vs ${JSON.stringify(source.slice(mismatch - 70, mismatch + 120))}`).to.equal(source);
      const wholeTraces = whole.get().trace.array();
      const wholeLines = whole.get().lines.array().map((line) => line.get());
      expect(wholeTraces.length, `${project} whole trace count`).to.equal(whole.get().lines.array().length);
      for (const trace of wholeTraces) {
        const path = trace.get().path.get();
        const node = (await abap.Classes.ZCL_OSD_DSL_TRACE.node_of({io_model: projectJson, iv_path: box(path)})).get();
        expect(node, `${project} whole trace ${path}`).to.not.equal("");
      }
      for (const block of [...data.first_type, ...data.other_types]) {
        expect(block.kind, `${project} ${block["@id"]} type kind`).to.be.oneOf(["ddic", "inline"]);
        expect(block.name, `${project} ${block["@id"]} type name`).to.be.a("string").and.not.empty;
        if (block.kind === "ddic") expect(block.ddic, `${project} ${block["@id"]} DDIC reference`).to.be.a("string").and.not.empty;
        for (const component of block.components) {
          expect(component["@id"], `${project} ${block["@id"]} component id`).to.match(/\/(property|parameter)\//);
          const line = `${component.name} type ${component.abap_type},`;
          const matches = wholeLines.flatMap((text, i) => text.trim() === line ? [i] : []);
          expect(matches.length, `${project} type component ${component["@id"]}`).to.be.greaterThan(0);
          const traced = await Promise.all(matches.map(async (i) =>
            (await abap.Classes.ZCL_OSD_DSL_TRACE.node_of({io_model: projectJson, iv_path: box(wholeTraces[i].get().path.get())})).get()));
          expect(traced, `${project} type line ${line}`).to.include(component["@id"]);
          expect(traced, `${project} type line ${line} must not trace only to its parent`).not.to.include(block["@id"]);
        }
      }
      const findings = (await abap.Classes.ZCL_OSD_DSL_PROFILE.check({iv_profile: box("abap"), iv_strict: box(""), is_result: whole, io_model: projectJson})).array();
      expect(findings.filter((f) => f.get().severity.get() === "E"), `${project} profile errors`).to.deep.equal([]);
      for (const [what, needle] of Object.entries(needles)) if (source.includes(needle)) seen[what]++;
      for (const method of METHODS) {
        const start = source.indexOf(`  method ${method}.\n`);
        if (start < 0) {
          expect(["DEFINE_COMPLEXTYPES", "DEFINE_ASSOCIATIONS", "DEFINE_ACTIONS"]).to.include(method);
          continue;
        }
        const end = source.indexOf("  endmethod.\n", start) + "  endmethod.\n".length;
        const expected = source.slice(start, end);
        const result = await abap.Classes.ZCL_OSD_DSL_MPC.render_method({is_model: model, iv_method: box(method)});
        const actual = (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: result})).get();
        expect(actual, `${project} ${method}`).to.equal(expected);
        const traces = result.get().trace.array();
        expect(traces.length, `${project} ${method} trace count`).to.equal(result.get().lines.array().length);
        for (const trace of traces) {
          const path = trace.get().path.get();
          if (path !== "/") expect((await projectJson.get().exists({iv_path: box(path)})).get(), `${method} ${path}`).to.equal("X");
          const node = (await abap.Classes.ZCL_OSD_DSL_TRACE.node_of({io_model: projectJson, iv_path: box(path)})).get();
          expect(node, `${method} ${path} node`).to.not.equal("");
        }
      }
      const types = model.get().entity_types.array();
      expect(types.length, `${project} has entity types`).to.be.greaterThan(0);
      for (const type of types) {
        const stem = type.get().define_stem.get();
        const start = source.indexOf(`  method DEFINE_${stem}.\n`);
        expect(start, `DEFINE_${stem} in the generated source`).to.be.at.least(0);
        const end = source.indexOf("  endmethod.\n", start) + "  endmethod.\n".length;
        const expected = source.slice(start, end);
        const result = await abap.Classes.ZCL_OSD_DSL_MPC.render_entity({is_type: type, iv_mpc: model.get().mpc});
        const actual = (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: result})).get();
        expect(actual, `${project} ${type.get().name.get()}`).to.equal(expected);
        const unified = await abap.Classes.ZCL_OSD_DSL_MPC.render_method({is_model: model, iv_method: box(`DEFINE_${stem}`)});
        expect((await abap.Classes.ZCL_OSD_TPL.to_string({is_result: unified})).get(), `${project} DEFINE_${stem}`).to.equal(expected);
      }
    });
  }

  // The byte comparison only covers what the fixtures exercise; this names it,
  // so a fixture that loses a case fails here rather than going quiet.
  it("the fixtures together exercise every optional line", () => {
    expect(Object.keys(seen).filter((what) => seen[what] === 0), "optional lines no fixture reaches").to.deep.equal([]);
  });

  it("refuses a rendered 256-character ABAP line with its position", async () => {
    const project = await importProject("long rendered line", readFileSync(FIXTURES[2], "utf8"));
    // generate renders through render_model (one model, built once)
    const renderer = abap.Classes.ZCL_OSD_DSL_MPC.render_model;
    abap.Classes.ZCL_OSD_DSL_MPC.render_model = async (...args) => {
      const result = await renderer.call(abap.Classes.ZCL_OSD_DSL_MPC, ...args);
      result.get().lines.array()[0].set("X".repeat(256));
      return result;
    };
    try {
      let error;
      try {
        await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box(project)});
      } catch (caught) {
        error = caught;
      }
      expect(error?.message?.get(), "GenerateSet must reject the profile error").to.match(
        /line_length.*line 1, template line \d+, node [^:]+: Line exceeds 255 characters/);
    } finally {
      abap.Classes.ZCL_OSD_DSL_MPC.render_model = renderer;
    }
  });

  it("returns non-ASCII comment warnings beside generated files", async () => {
    const project = await importProject("warning line", readFileSync(FIXTURES[2], "utf8"));
    // generate renders through render_model (one model, built once)
    const renderer = abap.Classes.ZCL_OSD_DSL_MPC.render_model;
    abap.Classes.ZCL_OSD_DSL_MPC.render_model = async (...args) => {
      const result = await renderer.call(abap.Classes.ZCL_OSD_DSL_MPC, ...args);
      result.get().lines.array()[0].set("*é");
      return result;
    };
    try {
      const files = (await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box(project)})).array();
      const warningsFile = files.find((file) => file.get().name.get().endsWith(".clas.warnings.json"));
      expect(warningsFile, "warnings artifact").to.exist;
      const warnings = JSON.parse(warningsFile.get().content.get()).warnings;
      expect(warnings).to.deep.include({line: 1, template_line: 1, node: `project/${project}`, rule: "non_ascii", text: "Character outside 7-bit ASCII"});
    } finally {
      abap.Classes.ZCL_OSD_DSL_MPC.render_model = renderer;
    }
  });

  it("writes the class and one trace entry per line", async () => {
    const folder = mkdtempSync(join(tmpdir(), "dsl-mpc-"));
    try {
      const {abapFile, traceFile, findings, project} = await renderProject(FIXTURES[0], folder);
      expect(project).to.match(/^ZDSL[0-9A-F]{12}$/);
      const source = readFileSync(abapFile, "utf8");
      const sidecar = readJSONFile(traceFile, "utf8");
      expect(sidecar.generator).to.equal("dsl-mpc");
      expect(sidecar.template).to.equal("mpc_class");
      expect(sidecar.model).to.match(/^sha256:[0-9a-f]{64}$/);
      expect(sidecar.lines.length).to.equal(source.trimEnd().split("\n").length);
      expect(sidecar.lines.every((line, index) => line.line === index + 1 && line.node)).to.equal(true);
      expect(findings.filter((finding) => finding.severity === "E")).to.deep.equal([]);
    } finally {
      rmSync(folder, {recursive: true, force: true});
    }
  });

  it("refuses a temporary project name already in use", async () => {
    const project = await importProject(FIXTURES[2]);
    const folder = mkdtempSync(join(tmpdir(), "dsl-mpc-collision-"));
    try {
      let error;
      try { await renderProject(FIXTURES[2], folder, {project}); }
      catch (caught) { error = caught; }
      expect(error?.message).to.equal(`project ${project} already exists`);
    } finally {
      rmSync(folder, {recursive: true, force: true});
    }
  });
});
