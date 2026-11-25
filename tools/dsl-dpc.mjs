#!/usr/bin/env node
// Render an imported IWPR's DPC class with its L1 provenance sidecar.
import {convertTrace, legacyTrace, traceArgs} from "./dsl-trace.mjs";
import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {randomBytes} from "node:crypto";
import {pathToFileURL} from "node:url";
import {readSpec, tableName} from "./segw-tables.mjs";

export async function renderProject(file, out, {project = `ZDSL${randomBytes(6).toString("hex").toUpperCase()}`} = {}) {
  if (!/^Z[A-Z0-9_]{1,31}$/.test(project)) throw new Error(`invalid temporary project ${project}`);
  const inputXml = readFileSync(file, "utf8");
  const persistentProject = /<PROJECT>([^<]+)<\/PROJECT>/.exec(inputXml)?.[1];
  const xml = inputXml.replace(/<PROJECT>[^<]+<\/PROJECT>/g, `<PROJECT>${project}</PROJECT>`);
  if (!xml.includes(`<PROJECT>${project}</PROJECT>`)) throw new Error("IWPR has no project rows");
  const {builtEngine} = await import("./dsl-engine.mjs");
  await builtEngine();
  const abap = globalThis.abap;
  for (const name of ["zcl_osd_dsl_dpc_templates", "zcl_osd_dsl_dpc", "zcl_osd_tpl", "zcl_osd_dsl_trace", "zcl_osd_dsl_profile", "zcl_stg_segw_gen", "zcl_stg_dispatcher"]) {
    await import(`../output/${name}.clas.mjs`);
  }
  const box = (value) => new abap.types.String().set(value);
  const db = abap.context.databaseConnections.DEFAULT;
  const existing = await db.select({select: `SELECT project FROM ${tableName("SBD_PR").toLowerCase()} WHERE project = '${project}'`});
  if (existing.rows.length) throw new Error(`project ${project} already exists`);
  try {
    const response = await abap.Classes.ZCL_STG_DISPATCHER.dispatch_decoded({
      iv_method: box("POST"),
      iv_path: box("/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet"),
      iv_body: box(JSON.stringify({Content: xml})),
    });
    const status = response.get().status.get();
    if (status !== 200 && status !== 201) throw new Error(`ImportSet ${status}: ${response.get().body.get()}`);
    const model = await abap.Classes.ZCL_STG_SEGW_GEN.build_model({iv_project: box(project)});
    const json = await abap.Classes.ZCL_OSD_DSL_DPC.project_model({is_model: model});
    const result = await abap.Classes.ZCL_OSD_DSL_DPC.render_class({is_model: model});
    const source = (await abap.Classes.ZCL_OSD_TPL.to_string({is_result: result})).get();
    const sidecar = (await abap.Classes.ZCL_OSD_DSL_TRACE.sidecar({
      iv_legacy: new abap.types.Character(1).set("X"), iv_generator: box("dsl-dpc"), iv_template: box("dpc_class"), io_model: json, is_result: result,
    })).get();
    const findings = (await abap.Classes.ZCL_OSD_DSL_PROFILE.check({
      iv_profile: box("abap"), iv_strict: new abap.types.Character(1).set(""), is_result: result, io_model: json,
    })).array().map((finding) => Object.fromEntries(Object.entries(finding.get()).map(([key, value]) => [key, value.get()])));
    const name = model.get().dpc.get().toLowerCase();
    mkdirSync(out, {recursive: true});
    const abapFile = join(out, `${name}.clas.abap`);
    const traceFile = join(out, `${name}.clas.trace.json`);
    writeFileSync(abapFile, source);
    const oldTrace = JSON.parse(sidecar);
    oldTrace.lines.forEach((e,i) => {
      e.contributors = result.get().trace.array()[i].get().contributors.array().map(c => ({
        invocation:c.get().invocation.get(),template:c.get().template.get(),template_line:c.get().template_line.get(),path:c.get().path.get(),
      }));
    });
    const traceModel = JSON.parse((await json.get().zif_ajson$stringify()).get());
    traceModel["@id"] = `project/${persistentProject}`;
    const pair = convertTrace(oldTrace, {[`${name}.clas.abap`]: source}, {model: traceModel, source: file, recipe: "src/dsl/zcl_osd_dsl_dpc.clas.abap"});
    writeFileSync(traceFile, legacyTrace() ? sidecar : pair.trace);
    if (!legacyTrace()) writeFileSync(traceFile.replace(/\.json$/, ".meta.json"), pair.meta);
    console.log(`abap profile: ${findings.length} finding(s)`);
    for (const finding of findings) console.log(`${finding.severity} ${finding.line} ${finding.rule}: ${finding.text} (${finding.node})`);
    return {abapFile, traceFile, findings, project};
  } finally {
    for (const tag of Object.keys(readSpec())) {
      await db.execute(`DELETE FROM ${tableName(tag).toLowerCase()} WHERE project = '${project}'`);
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, file, flag, out] = traceArgs(process.argv.slice(2));
  if (command !== "render" || !file || flag !== "--out" || !out) {
    console.error(`Usage: node ${basename(process.argv[1])} render <project-file.iwpr.xml> --out <dir>`);
    process.exitCode = 2;
  } else {
    try {
      const result = await renderProject(file, out);
      console.log(`${result.abapFile}\n${result.traceFile}`);
      if (result.findings.some((finding) => finding.severity === "E")) process.exitCode = 1;
    } catch (error) {
      console.error(error);
      process.exitCode = 1;
    }
  }
}
