// Benchmark: flock /tmp/osd-heavy.lock node_modules/.bin/mocha tools/bench-dsl-dpc.mjs
// Run after transpiling each path; DSL_BENCH_LABEL names the measured revision.
import {readFileSync} from "node:fs";
import {compile} from "../tools/stg-compile.mjs";
describe("timing", function () {
  this.timeout(600000);
  it("times", async () => {
    const load = readFileSync("/proc/loadavg", "utf8").trim();
    console.log("load before benchmark", load);
    if (Number(load.split(" ")[0]) > 4) throw new Error("Wait for a quiet machine: one-minute load must be <= 4 on this 16-CPU host");
    await import("../test/start.mjs");
    const abap = globalThis.abap;
    for (const name of ["zcl_osd_dsl_dpc_templates", "zcl_osd_dsl_dpc", "zcl_osd_dsl_mapping", "zcl_osd_dsl_dpc_map", "zcl_stg_segw_gen", "zcl_stg_segw_gen_dpc", "zcl_osd_tpl", "zcl_osd_dsl_trace", "zcl_osd_dsl_profile", "zcl_stg_dispatcher", "zcl_ajson"]) await import(`../output/${name}.clas.mjs`);
    const box = (v) => new abap.types.String().set(v);
    const xml = compile(readFileSync("src/segw/zstg_segw.stg.yaml", "utf8"), {file: "zstg_segw.stg.yaml"}).iwpr.replace(/<PROJECT>[^<]+<\/PROJECT>/g, "<PROJECT>ZTIMING</PROJECT>");
    const r = await abap.Classes.ZCL_STG_DISPATCHER.dispatch_decoded({iv_method: box("POST"), iv_path: box("/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet"), iv_body: box(JSON.stringify({Content: xml}))});
    console.log("import", r.get().status.get());
    const med = (a) => a.sort((x, y) => x - y)[a.length >> 1];
    const model = await abap.Classes.ZCL_STG_SEGW_GEN.build_model({iv_project: box("ZTIMING")});
    console.log("entity types", model.get().entity_types.array().length);
    console.log("load", readFileSync("/proc/loadavg", "utf8").trim());
    const runs = [];
    // One warm-up, then seven complete generate calls (MPC and DPC included).
    await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box("ZTIMING")});
    for (let i = 0; i < 7; i++) {
      const start = performance.now();
      await abap.Classes.ZCL_STG_SEGW_GEN.generate({iv_project: box("ZTIMING")});
      runs.push(performance.now() - start);
    }
    console.log(JSON.stringify({label: process.env.DSL_BENCH_LABEL ?? "after", project: "src/segw/zstg_segw.stg.yaml", runs_ms: runs, median_ms: med([...runs])}));
  });
});
