import {readJSONFile} from "./trace-reader.mjs";
import {expect} from "chai";
import {existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import vm from "node:vm";
import yaml from "js-yaml";
import {DatabaseSync} from "node:sqlite";
import {compileSet, checkSet, SetError} from "../tools/dsl-l3.mjs";
import {compile, writeCompiled} from "../tools/stg-compile.mjs";
import {buildApp} from "../tools/osd-bsp-app.mjs";
import {admit, loadManifest, unitFor} from "../tools/osd-deploy-manifest.mjs";
import {compileCockpit} from "../tools/dsl-l3-cockpit.mjs";
import {cockpitActions, cockpitService} from "../tools/dsl-l3-cockpit-service.mjs";
import {daemonHost} from "../tools/osd-daemon-host.mjs";
import {loadCockpitMutant} from "./helpers/dsl-cockpit-mutant.mjs";
const SET = "src/l2demo/fleet2.l3.yaml", SERVICE = "ZL3C_FLEET2_SRV";
const BASE = `http://localhost:${process.env.STG_PORT ?? 3030}/sap/opu/odata/sap/${SERVICE}`;
const trim = (v) => typeof v === "string" ? v.trim() : v;
function series(source = readFileSync("recipes/l3-cockpit/Series.js", "utf8")) {
  const context = {module: {exports: {}}, Date, Set}; vm.runInNewContext(source, context); return context.module.exports;
}
describe("DSL L3 run cockpit", function () {
  this.timeout(900000);
  it("regenerates byte for byte, including the unopted set", async () => {
    expect(await checkSet(SET, "src/l2demo")).deep.equal([]);
    expect(await checkSet("src/l2demo/fleet.l3.yaml", "src/l2demo")).deep.equal([]);
  });
  it("refuses long BSP names, unknown keys and missing stages at the cockpit line", () => {
    const dir = mkdtempSync(join(tmpdir(), "cockpit-compile-"));
    const text = readFileSync(SET, "utf8").replace(/rule: ([a-z_]+\.l2\.yaml)/g, (_, r) => `rule: ${join(process.cwd(), "src/l2demo", r)}`);
    try {
      for (const [source, pattern] of [[text.replace("app: zosd_fleet2", "app: z1234567890123456"), /at most 15/], [text.replace("title: Fleet run cockpit", "typo: Fleet run cockpit"), /unknown cockpit key/],
        [text.replace("app: zosd_fleet2,", "app: zosd_fleet2_ck,"), /set_app is required/],
        [text.replace("title: Fleet run cockpit", "title: Fleet run cockpit, set_app: zosd_fleet2"), /second app/],
        [readFileSync("src/l2demo/fleet.l3.yaml", "utf8").replace(/rule: ([a-z_]+\.l2\.yaml)/g, (_, r) => `rule: ${join(process.cwd(), "src/l2demo", r)}`) + "\ncockpit: {app: ztest, service: ZTEST, title: Test}\n", /requires stages/]]) {
        const file = join(dir, "set.l3.yaml"); writeFileSync(file, source);
        expect(() => compileSet(file)).throw(SetError).and.match(pattern).and.match(/:\d+:/);
      }
    } finally {rmSync(dir, {recursive: true, force: true});}
  });
  it("the service compiler owns the base classes, annotations, read-only flags and all functions", () => {
    const compiled = compile(readFileSync("src/l2demo/zl3c_fleet2.stg.yaml", "utf8"));
    expect(compiled.model.functions).length(14);
    expect(compiled.model.entities.some((e) => e.name === "RunStat")).equal(true);
    expect(compiled.model.entities.every((e) => !e.creatable && !e.updatable && !e.deletable)).equal(true);
    expect(compiled.classes["zcl_zl3c_fleet2_mpc_ann.clas.abap"]).include("to_Pile/@com.sap.vocabularies.UI.v1.LineItem");
    const lines = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8").trimEnd().split("\n");
    const trace = readJSONFile("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap.trace.json", "utf8");
    expect(trace.lines).length(lines.length);
    const at = compileSet(SET).cockpit.set_line;
    expect(trace.lines.every((t) => t.set_line === at)).equal(true);
  });
  it("handles long set names and exposes the optional simulation runner seam", () => {
    const m = compileSet(SET);
    const c = compileCockpit({cockpit: {app: "ztest", service: "ZTEST_SRV", title: "Test"}}, {...m, set: "abcdefghijklmnop"}, {line: () => 1, fail: (_, message) => {throw new Error(message);}});
    expect(`ZCL_${c.project}_MPC_EXT`.length).at.most(30);
    const start = cockpitActions({...m, simulate: {}}).find((a) => a.name === "StartRun");
    expect(start.params.Work).equal("String(4)");
    expect(start.call).include("iv_bind = lv_work").and.include("work={ lv_work }");
    // 5d's public DDIC contract adds RUN_BIND to the stage, not a table.
    const bound = cockpitService(m, {tableSource: (table) => {
      const xml = readFileSync(`src/dsl/${table}.tabl.xml`, "utf8");
      return table === "zosd_l3_stage" ? xml.replace("</DD03P_TABLE>", "<DD03P><FIELDNAME>RUN_BIND</FIELDNAME><DATATYPE>CHAR</DATATYPE><LENG>000255</LENG></DD03P></DD03P_TABLE>") : xml;
    }});
    expect(bound.doc.entities.Stage.properties.RunBind.type).equal("String(255)");
    expect(bound.doc.entities.Stage.keys).deep.equal(["RunId", "StageNo"]);
    expect(bound.doc.annotations.Stage.lineItem.some((c) => c.value === "RunBind")).equal(true);
  });
  it("packages the generated service, BSP and ICF node under deploy unit l3demo", () => {
    const out = mkdtempSync(join(tmpdir(), "cockpit-deploy-"));
    try {
      writeCompiled(compile(readFileSync("src/l2demo/zl3c_fleet2.stg.yaml", "utf8")), out);
      writeFileSync(join(out, "zcl_zl3c_fleet2_dpc_ext.clas.abap"), readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap"));
      // both apps, each with the file list its cockpit.json names
      for (const app of ["zosd_fleet2", "zosd_fleet2_s"]) {
        const declared = readJSONFile(`src/l2demo/cockpit/${app}/cockpit.json`, "utf8");
        buildApp({from: `src/l2demo/cockpit/${app}`, app: app.toUpperCase(), out, service: SERVICE, only: declared.files});
      }
      const files = readdirSync(out), unit = unitFor(loadManifest(), out, "l3demo");
      expect(files.filter((f) => f.endsWith(".sicf.xml"))).length(2);
      expect(files).include("zosd_fleet2.wapa.xml").and.include("zosd_fleet2_s.wapa.xml").and.include("zl3c_fleet2.iwpr.xml");
      expect(admit({files, read: (f) => readFileSync(join(out, f), "utf8"), unit})).deep.equal([]);
    } finally {rmSync(out, {recursive: true, force: true});}
  });
  it("generates two apps: the run app with its start dialog and Live, the Set app with its tabs, and their tiles", () => {
    const base = "src/l2demo/cockpit", read = (f) => readFileSync(`${base}/${f}`, "utf8");
    const runs = JSON.parse(read("zosd_fleet2/cockpit.json")), set = JSON.parse(read("zosd_fleet2_s/cockpit.json"));
    expect([runs.title, set.title]).deep.equal(["Runs fleet2", "Set fleet2"]);
    expect(runs.tile.type).equal("dynamic");
    expect(runs.tile.serviceUrl.replaceAll("%20", " ")).equal("/sap/opu/odata/sap/ZL3C_FLEET2_SRV/RunSet/$count?$filter=" +
      ["DONE", "PARTIAL", "FAILED", "NOT-RUN"].map((x) => `Status ne '${x}'`).join(" and "));
    for (const [app, d] of [["zosd_fleet2", runs], ["zosd_fleet2_s", set]]) for (const f of d.files) expect(existsSync(`${base}/${app}/${f}`), `${app}/${f}`).equal(true);
    // the start dialog: a date, the mode as a choice, the twin as a switch (fleet2 has simulate:)
    const dialog = read("zosd_fleet2/StartRun.fragment.xml");
    expect(dialog).include('<DatePicker id="startDate" value="{start>/date}" valueFormat="yyyyMMdd"').and.include('<SegmentedButtonItem key="P"')
      .and.include('<SegmentedButtonItem key="S"').and.include('<Switch id="startSim"').and.include('id="startOpen"');
    const list = read("zosd_fleet2/List.controller.js");
    expect(list).include('callFunction("/StartRun"').and.include("navigateInternal").and.include("MessageBox.error").and.include('"simulate": true');
    expect(list).not.include("JSON.stringify");
    expect(read("zosd_fleet2/Live.js")).include("var INTERVAL = 5000;").and.include('document.visibilityState === "hidden"');
    const manifest = JSON.parse(read("zosd_fleet2/manifest.json")), ext = manifest["sap.ui5"].extends.extensions["sap.ui.controllerExtensions"];
    const op = ext["sap.suite.ui.generic.template.ObjectPage.view.Details"]["sap.ui.generic.app"].RunSet;
    expect(op.Header.Actions.ContinueGlass.applicablePath).equal("CanContinue");
    expect(op.Header.Actions.Resume.applicablePath).equal("CanResume");
    expect(op.Sections.Pile.Actions.ReleasePile).include({requiresSelection: true, applicablePath: "CanRelease"});
    expect(Object.keys(ext["sap.suite.ui.generic.template.ListReport.view.ListReport"]["sap.ui.generic.app"].RunSet.Actions)).deep.equal(["StartRun"]);
    expect(manifest["sap.ui.generic.app"].pages["ListReport|Run"].component.settings.variantManagementHidden).equal(true);
    // the run page keeps the run; the set's actions moved to the Set app
    expect(read("zosd_fleet2/Cockpit.fragment.xml")).not.include("cockpitSettings").and.not.include("cockpitActions");
    const view = read("zosd_fleet2_s/Set.view.xml");
    for (const key of ["settings", "schedule", "kill", "doctor"]) expect(view).include(`key="${key}"`);
    const config = read("zosd_fleet2_s/Set.controller.js");
    for (const name of ["SetSetting", "ResetSetting", "SetKill", "ClearKill", "Doctor", "Schedule", "Unschedule"]) expect(config).include(`"name": "${name}"`);
    expect(config).not.include('"name": "StartRun"');
  });
  it("annotations: a label for every property, criticality, fixed value lists and micro chart facets", () => {
    // from the generator itself (the byte-for-byte test ties it to the file in src/)
    const doc = cockpitService(compileSet(SET)).doc;
    for (const [name, e] of Object.entries(doc.entities)) for (const [p, spec] of Object.entries(e.properties)) {
      if (name === "Answer") continue;
      expect(spec.label, `${name}/${p}`).a("string").not.equal(p.toUpperCase());
      expect(doc.annotations[`${name}/${p}`]?.label, `${name}/${p}`).equal(spec.label);
    }
    expect(doc.entities.Run.properties.CheckDate.label).equal("Check date");
    for (const [name, p] of [["Run", "Open"], ["Run", "Title"], ["Run", "PilesDone"], ["Pile", "CanRelease"], ["Stage", "StatusCriticality"], ["Budget", "StateCriticality"]]) {
      expect(doc.entities[name].properties[p], `${name}/${p}`).include({filterable: false, sortable: false});
    }
    expect(doc.entities.Run.properties.CheckDate.filterable).not.equal(false);
    expect(doc.entities.Tally.properties.RunId.filterable).equal(true);
    const ann = compile(yaml.dump(doc, {lineWidth: -1, noRefs: true})).classes["zcl_zl3c_fleet2_mpc_ann.clas.abap"], UI = "com.sap.vocabularies.UI.v1.";
    for (const target of [`@${UI}DataPoint#Status`, `@${UI}Chart#Final`, `@${UI}Chart#Budget`, `to_Tally/@${UI}Chart#Tally`]) {
      expect(ann).include(`set_annotation_path( '${target}' )`);
    }
    for (const type of ["Donut", "Bullet", "BarStacked"]) expect(ann).include(`set_enum_member_by_name( '${UI}ChartType/${type}' )`);
    expect(ann.match(/create_property\( 'Criticality' \)->create_simple_value\( \)->set_path\( 'StatusCriticality' \)/g)).length.at.least(4);
    expect(ann).include("create_property( 'Criticality' )->create_simple_value( )->set_path( 'StateCriticality' )");
    expect(ann).include("create_property( 'ToleranceRangeHighValue' )->create_simple_value( )->set_path( 'WarnLevel' )");
    expect(ann).include("create_property( 'DeviationRangeHighValue' )->create_simple_value( )->set_path( 'NarrowLevel' )");
    expect(ann).include(`create_annotation( '${UI}Hidden' )->create_simple_value( )->set_path( 'HideEvent' )`);
    expect(ann).include("'ZL3C_FLEET2_SRV.Run/Status' ).").and.include("ValueListWithFixedValues");
    expect(ann).include("set_string( 'StatusVHSet' )");
  });
  it("keeps every generated line under 255 characters, the limit a system's BSP and source cut at", () => {
    const files = [];
    const walk = (dir) => {for (const f of readdirSync(dir)) {const p = join(dir, f); if (statSync(p).isDirectory()) walk(p); else if (!/\.trace(?:\.meta)?\.json$/.test(f)) files.push(p);}};
    walk("src/l2demo/cockpit");
    expect(files.filter((f) => f.includes("zosd_fleet2_s/")).length).at.least(7);
    const texts = files.map((f) => [f, readFileSync(f, "utf8")]);
    texts.push(["src/l2demo/zl3c_fleet2.stg.yaml", readFileSync("src/l2demo/zl3c_fleet2.stg.yaml", "utf8")],
      ["src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8")]);
    const compiled = compile(readFileSync("src/l2demo/zl3c_fleet2.stg.yaml", "utf8"));
    for (const [name, text] of Object.entries({...compiled.files, ...compiled.classes, ...compiled.ext})) texts.push([name, text]);
    const long = texts.flatMap(([f, text]) => text.split(/\r?\n/).map((l, i) => [f, i + 1, l.length]).filter(([, , n]) => n >= 255));
    expect(long).deep.equal([]);
  });
  // Live.js in a stub UI5: controls that remember, timers that can be counted
  function liveModule(source = readFileSync("recipes/l3-cockpit/Live.js", "utf8")) {
    const timers = new Map(); let next = 1, Live;
    class Control {
      constructor(id, props = {}) {Object.assign(this, {id, props, state: !!props.state, text: "", destroyed: false});}
      setState(v) {this.state = v; return this;} getState() {return this.state;}
      setText(t) {this.text = t; return this;}
      destroy() {this.destroyed = true;}
    }
    const context = {Promise, Date, document: {visibilityState: "visible"},
      setTimeout: (f) => {const id = next++; timers.set(id, f); return id;}, clearTimeout: (id) => {timers.delete(id);},
      sap: {ui: {define: (deps, factory) => {Live = factory(Control, Control, Control, Control);}}}};
    vm.runInNewContext(source, context);
    return {Live, timers};
  }
  it("Live: a page destroyed while a refresh is in flight schedules nothing and writes nothing", async () => {
    const run = async (source) => {
      const {Live, timers} = liveModule(source);
      let release, reads = 0;
      const live = new Live({id: (n) => n, text: (k) => k, final: () => false,
        refresh: () => {reads++; return new Promise((r) => {release = r;});}});
      live.set(true);
      expect(timers.size, "one timer while on").equal(1);
      const [[id, fire]] = [...timers]; timers.delete(id); fire();
      expect(reads).equal(1);
      live.destroy();
      release();
      await new Promise((r) => setTimeout(r, 10));
      return {timers: timers.size, reads, stamp: live.stamp.text};
    };
    expect(await run()).deep.equal({timers: 0, reads: 1, stamp: ""});
    // the same without the destroyed guard: the late answer schedules the next read
    const unguarded = readFileSync("recipes/l3-cockpit/Live.js", "utf8").replace("this.destroyed = true;", "");
    let failed = false;
    try {expect(await run(unguarded)).deep.equal({timers: 0, reads: 1, stamp: ""});} catch {failed = true;}
    expect(failed, "mutant: destroy without the flag").equal(true);
  });
  it("plots piles, stage planning and event capacities at their actual timestamps", () => {
    const rows = [{StageNo: 1, Status: "DONE", Ended: "20261001000002"}, {StageNo: 1, Status: "HELD", Ended: "20261001000003"}, {StageNo: 2, Status: "DONE", Ended: "20261001000005"}];
    const stages = [{StageNo: 1, Opened: "20261001000001"}, {StageNo: 2, Opened: "20261001000004"}];
    const events = [{Seq: 1, Acted: "20261001000002", Reserved: 2, Glass: 10}, {Seq: 2, Acted: "20261001000005", Reserved: 3, Glass: 20}];
    const api = series(), s = api.compute(rows, events, stages, {WarnAt: 7000, NarrowAt: 8000}, Date.UTC(2026, 9, 1, 0, 0, 6));
    expect(api.time(new Date(s.start))).equal(s.start);
    expect(s.plan.map((p) => [p.planned, p.done])).deep.equal([[2, 0], [2, 1], [2, 1], [3, 1], [3, 2], [3, 2]]);
    expect(s.capacity.map((p) => [p.reserved, p.glass, p.warn, p.narrow])).deep.equal([[2, 10, 7, 8], [3, 20, 14, 16], [3, 20, 14, 16]]);
    const currentOnly = api.compute(rows, [], stages, {Reserved: 4, Glass: 20, WarnAt: 7000, NarrowAt: 8000}, s.end);
    expect(currentOnly.capacity.map((p) => [p.at, p.reserved])).deep.equal([[s.end, 4]]);
    const mutant = series(readFileSync("recipes/l3-cockpit/Series.js", "utf8").replace('}).length};', '}).length + 1};'));
    expect(() => expect(mutant.compute(rows, events, stages, {}, s.end).plan.at(-1).done).equal(2)).throw();
    const chart = api.svg(s, s.plan, ["planned", "done"], ["Plan", "Done"]);
    expect(chart).include("viewBox").and.include("00:00:01").and.include("00:00:06");
    // One second out of five spans 130 pixels, and one of three piles
    // spans one third of the 175-pixel vertical plot, rather than equal
    // spacing for events of unequal duration.
    expect(chart).match(/H185V131\.666/).and.match(/H575V73\.333/);
    const historical = api.compute(rows, events, stages.map((s) => ({...s, Status: "DONE", Ended: "20261001000005"})), {}, Date.UTC(2026, 9, 2));
    expect(historical.end).equal(Date.UTC(2026, 9, 1, 0, 0, 5));
    const instant = api.compute([rows[0]], [], [{StageNo: 1, Status: "DONE", Opened: rows[0].Ended, Ended: rows[0].Ended}], null, Date.UTC(2026, 9, 2));
    expect(instant.plan.map((p) => p.done)).deep.equal([1, 1]);
    expect(instant.end - instant.start).equal(1000);
  });
  describe("Gateway, file DB, real runners and jobs", () => {
    let server, dir, dbPath, prior, context, abap, client, dialogStep, store, drainJobOutbox, workQueuedBatch, clock;
    const tables = ["alert", "pile", "run", "stage", "work", "doctor", "kill", "conf", "conf_log", "run_conf", "budget", "event", "object", "runstat", "watch", "snap"].map((t) => `zosd_l3_${t}`);
    const sources = ["ship", "voy", "crew", "cargo"].map((t) => `zosd_l2_${t}`);
    const read = (sql, ...args) => {const db = new DatabaseSync(dbPath); try {return db.prepare(sql).all(...args).map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, trim(v)])));} finally {db.close();}};
    const exec = (sqls) => dialogStep(async () => {for (const sql of sqls) await client.execute(sql);});
    const get = async (path) => {const r = await fetch(`${BASE}/${path}`); expect(r.status, await r.clone().text()).equal(200); return (await r.json()).d;};
    const action = async (name, params = {}) => {const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(typeof v === "number" ? String(v) : "'" + v.replaceAll("'", "''") + "'")}`).join("&");
      const r = await fetch(`${BASE}/${name}?${query}`, {method: name === "ScheduleStatus" ? "GET" : "POST"}); expect(r.status, await r.clone().text()).equal(200); return (await r.json()).d;};
    async function drain() {for (let i = 0; i < 150; i++) {await drainJobOutbox(store); const out = await workQueuedBatch(process.cwd(), store); expect(out.kind).not.equal("failed"); if (!["completed", "step", "running"].includes(out.kind)) break;}}
    before(async () => {
      dir = mkdtempSync(join(tmpdir(), "cockpit-db-")); dbPath = join(dir, "business.sqlite");
      prior = Object.fromEntries(["STG_DB", "STG_DB_PATH", "OSD_OPERATIONS_DB"].map((k) => [k, process.env[k]]));
      const start = await import("./start.mjs");
      const existing = globalThis.abap;
      if (existing?.context) context = {databaseConnections: {...existing.context.databaseConnections}, RFCDestinations: {...existing.context.RFCDestinations}, osdGeneration: existing.context.osdGeneration};
      process.env.STG_DB = "file"; process.env.STG_DB_PATH = dbPath; process.env.OSD_OPERATIONS_DB = join(dir, "operations.sqlite");
      await (await import("../output/init.mjs")).initializeABAP(); abap = globalThis.abap; client = abap.context.databaseConnections.DEFAULT;
      ({dialogStep} = await import("../tools/osd-dialog-step.mjs"));
      const jobs = await import("../tools/osd-batch-runs.mjs"); store = new jobs.BatchRuns(process.cwd(), process.env); workQueuedBatch = jobs.workQueuedBatch;
      ({drainJobOutbox} = await import("../tools/osd-job-outbox.mjs"));
      const scheduler = await import("../tools/osd-job-scheduler.mjs"); clock = scheduler.installAbapClock(abap, scheduler.manualClock("2026-10-01T00:00:00Z"));
      server = start.startServer(true);
    });
    beforeEach(async () => {
      await daemonHost(abap).close();
      await exec([...tables, "zosd_l3_snapk", "zosd_l3_run_snap", ...sources].map((t) => `DELETE FROM ${t}`));
      await exec(["INSERT INTO zosd_l2_ship (mandt, ship_id, name, status) VALUES ('123','S001','Maintenance','M'), ('123','S002','Active','A')",
        "INSERT INTO zosd_l2_voy (mandt, voyage_id, ship_id, dep_date) VALUES ('123','V00001','S001','20261005'), ('123','V00002','S002','20261005')"]);
    });
    after(async () => {await drain().catch(() => {}); await daemonHost(abap).close(); await server?.close(); store?.close(); clock?.(); await client?.disconnect();
      if (context) Object.assign(abap.context, context);
      for (const [k, v] of Object.entries(prior ?? {})) {if (v === undefined) delete process.env[k]; else process.env[k] = v;}
      if (dir) rmSync(dir, {recursive: true, force: true});});
    it("entity sets enforce their fixed set filter, keys and navigation; writes are 405", async () => {
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "S"}); expect(r.Answer).equal("DONE");
      await action("Doctor");
      await action("SetSetting", {Param: "budget.glass", Value: "20", Note: "isolation fixture"});
      await action("SetKill", {Reason: "isolation fixture"});
      // A successful synchronous run need not emit a governor event.
      await exec(["INSERT INTO zosd_l3_event (mandt,run_id,seq,set_name,kind,reason) VALUES ('','FIXTURE',1,'fleet2','WARN','isolation fixture')"]);
      for (const table of tables.filter((t) => !["zosd_l3_work", "zosd_l3_object", "zosd_l3_alert"].includes(t))) {
        await exec([`INSERT OR REPLACE INTO ${table} SELECT ${read(`PRAGMA table_info(${table})`).map((f) => f.name === "set_name" ? "'other'" : f.name === "run_id" ? "'OTHER'" : f.name === "mandt" ? "'999'" : f.name).join(",")} FROM ${table} WHERE set_name='fleet2'`]);
      }
      const model = compileSet(SET);
      const {cockpitService} = await import("../tools/dsl-l3-cockpit-service.mjs");
      const service = cockpitService(model);
      for (const e of service.entities) {
        const set = service.doc.entities[e.name].set;
        expect(read(`SELECT * FROM ${e.table} WHERE set_name='other'`), e.name + " other fixture").not.length(0);
        const rows = (await get(set)).results;
        expect(rows.every((r) => r.SetName === "fleet2"), e.name).equal(true);
        expect((await get(set + "?$filter=SetName eq 'other'")).results, e.name).length(0);
        const write = await fetch(`${BASE}/${set}`, {method: "POST", headers: {"Content-Type": "application/json"}, body: "{}"}); expect(write.status).equal(405);
      }
      expect((await get(`RunSet('${r.RunId}')/to_Pile`)).results).length(7);
      for (const method of ["MERGE", "PATCH", "DELETE"]) {
        const response = await fetch(`${BASE}/RunSet('${r.RunId}')`, {method, headers: {"Content-Type": "application/json"}, body: method === "DELETE" ? undefined : '{"Status":"DONE"}'});
        expect(response.status, method).equal(405);
      }
      expect((await fetch(`${BASE}/RunSet('OTHER')`)).status).equal(404);
    });
    it("settings change and reset through runner audit, bounds and missing notes refuse", async () => {
      expect((await action("SetSetting", {Param: "budget.glass", Value: "20", Note: "more capacity"})).Answer).equal("OK");
      expect(read("SELECT * FROM zosd_l3_conf_log WHERE note_text='more capacity'")).length(1);
      expect((await action("SetSetting", {Param: "budget.glass", Value: "0", Note: "too small"})).Answer).match(/^REFUSED: SetSetting: .*outside its range/);
      expect((await action("SetSetting", {Param: "budget.glass", Value: "30", Note: ""})).Answer).match(/^REFUSED: SetSetting: .*note is empty/);
      expect((await action("ResetSetting", {Param: "budget.glass", Note: "restore capacity"})).Answer).equal("OK");
      expect((await get("ChangeSet")).results.some((r) => r.NoteText === "restore capacity")).equal(true);
    });
    it("chaos settings through the cockpit: a profile from the manifest, and outcome shares that total over 1000 are refused in words", async () => {
      try {
        expect((await action("SetSetting", {Param: "simulate.dump", Value: "700", Note: "a rough night"})).Answer).equal("OK");
        const over = (await action("SetSetting", {Param: "simulate.hang", Value: "400", Note: "too rough"})).Answer;
        expect(over).match(/^REFUSED: SetSetting: .*simulate dump \+ hang \+ slow above 1000/);
        expect(over.length, "an ABAP literal holds 255 characters").lessThan(255);
        expect((await action("SetSetting", {Param: "simulate.hang", Value: "300", Note: "just fits"})).Answer).equal("OK");
        expect((await action("SetSetting", {Param: "simulate.profile", Value: "typhoon", Note: "no such profile"})).Answer).match(/^REFUSED: SetSetting:/);
        expect((await action("SetSetting", {Param: "simulate.profile", Value: "storm", Note: "weather"})).Answer).equal("OK");
        const stored = Object.fromEntries((await get("SettingSet")).results.map((r) => [trim(r.ParamName), trim(r.ParamVal)]));
        expect([stored["simulate.dump"], stored["simulate.hang"], stored["simulate.profile"]]).deep.equal(["700", "300", "storm"]);
      } finally {
        for (const Param of ["simulate.dump", "simulate.hang", "simulate.profile"]) expect((await action("ResetSetting", {Param, Note: "back to the manifest"})).Answer).equal("OK");
      }
    });
    // Work is String(4) in the model (the variants are real and sim), so the
    // unknown variant fits and reaches the runner; a longer one never does.
    it("returns the runner refusal text for an unknown work variant", async () => {
      expect((await action("StartRun", {CheckDate: "20261001", Mode: "S", Work: "nope"})).Answer)
        .include("REFUSED:").and.include("no such variant for the port");
    });
    it("refuses a work variant longer than its MaxLength before the runner sees it", async () => {
      const r = await fetch(`${BASE}/StartRun?CheckDate='20261001'&Mode='S'&Work='bogus'`, {method: "POST"});
      expect(r.status).equal(400);
      expect(await r.text()).include("VALUE_TOO_LONG").and.include("MaxLength 4");
    });
    async function simulatedDump() {
      await action("SetSetting", {Param: "simulate.time_scale", Value: "0", Note: "instant dump fixture"});
      const uuid = abap.Classes.CL_SYSTEM_UUID, priorCrypto = uuid.CRYPTO;
      const fixed = [0, 0, 0x4000, 0x8000, 1].map((n, i) => n.toString(16).padStart([8, 4, 4, 4, 12][i], "0")).join("-");
      uuid.CRYPTO = {randomUUID: () => fixed};
      try {
        expect((await action("StartRun", {CheckDate: "20261001", Mode: "S", Work: "sim"})).Answer)
          .include("REFUSED:").and.include("SIM: the simulated work ends abnormally, as a dump does");
      } finally {uuid.CRYPTO = priorCrypto;}
    }
    it("returns a synchronous simulated dump as an answer", simulatedDump);
    it("explains how to work a submitted parallel run on a plain serving host", async () => {
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "P"});
      expect(r.Answer).include("SUBMITTED").and.include("node tools/osd-batch-runs.mjs worker");
      expect((await get(`PileSet?$filter=RunId eq '${r.RunId}'`)).results.every((p) => p.Status === "PLANNED")).equal(true);
      await drain();
      expect((await get(`RunSet('${r.RunId}')/to_Stage`)).results.every((s) => s.Status === "DONE")).equal(true);
    });
    it("mutant: removing the dispatch catch makes both refusal oracles red", async () => {
      const real = abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT;
      const original = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8");
      const source = original.replace("    TRY.\n        CASE iv_action_name.", "        CASE iv_action_name.")
        .replace(/      CATCH cx_root INTO lx_error\.[\s\S]*?    ENDTRY\.\n/, "");
      expect(source).not.equal(original);
      const mutant = await loadCockpitMutant("zcl_cockpit_catch_mut", source.replaceAll("zcl_zl3c_fleet2_dpc_ext", "zcl_cockpit_catch_mut"), join(dir, "catch-mutant"));
      abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = mutant;
      try {
        for (const oracle of [async () => {
          expect((await action("StartRun", {CheckDate: "20261001", Mode: "S", Work: "nope"})).Answer).include("no such variant for the port");
        }, simulatedDump]) {
          let failed = false;
          try {await oracle();} catch {failed = true;}
          expect(failed).equal(true);
        }
      } finally {abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = real;}
    });
    it("computes the run page's fields: title, label, piles, tally, open and actions, hidden sections, the status list", async () => {
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "S"});
      const run = await get(`RunSet('${r.RunId}')`);
      expect(run).include({Title: "fleet2 / 2026-10-01", RunLabel: "2026-10-01 / Now", Mode: "S", Twin: false, Open: false, Piles: 7,
        PilesDone: 7, PilesFinal: 7, PctFinal: 100, StatusCriticality: 3, CanContinue: false, CanResume: false, HidePile: false, HideStage: false});
      for (const [section, set] of [["Event", "EventSet"], ["Doctor", "DoctorSet"], ["Snapshot", "ConfSnapSet"]]) {
        expect(run[`Hide${section}`], section).equal((await get(`${set}?$filter=RunId eq '${r.RunId}'`)).results.length === 0);
      }
      expect(run.HideEvent || run.HideDoctor).equal(true);
      // the list carries the same fields as the page
      expect((await get("RunSet")).results.find((x) => x.RunId === r.RunId)).include({Title: run.Title, Piles: 7, Open: false});
      expect((await get(`RunSet('${r.RunId}')/to_Tally`)).results.map((t) => [t.Status, t.Piles, t.StatusCriticality])).deep.equal([["DONE", 7, 3]]);
      const statuses = (await get("StatusVHSet")).results.map((x) => x.Status);
      expect(statuses).include("GLASS").and.include("DONE").and.include("WAITING").and.length(9);
      // a run in jobs holds its date until the jobs are done; the tile counts it
      const p = await action("StartRun", {CheckDate: "20261002", Mode: "P"});
      expect(await get(`RunSet('${p.RunId}')`)).include({RunLabel: "2026-10-02 / In jobs", Mode: "P", Open: true, CanResume: true, CanContinue: false});
      const count = async () => +(await (await fetch(`${BASE}/RunSet/$count?$filter=${encodeURIComponent(["DONE", "PARTIAL", "FAILED", "NOT-RUN"].map((x) => `Status ne '${x}'`).join(" and "))}`)).text());
      expect(await count()).equal(1);
      await drain();
      expect(await get(`RunSet('${p.RunId}')`)).include({Open: false, CanResume: false, Piles: 7, PilesDone: 7});
      expect(await count()).equal(0);
    });
    // a computed field is filled after the read: $metadata says it cannot be filtered or sorted
    // on, and a filter on it is refused in words rather than ignored (count and paging included)
    async function refusesComputedFilters() {
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "S"});
      const status = async (path) => {const x = await fetch(`${BASE}/${path}`); return [x.status, x.status === 200 ? null : (await x.json()).error.message.value];};
      for (const [path, name] of [["RunSet?$filter=Open eq true", "Open"], ["RunSet/$count?$filter=Open eq false", "Open"],
        ["RunSet?$filter=substringof('fleet2', Title)", "Title"], ["RunSet?$filter=Status eq 'DONE' or PilesDone gt 3", "PilesDone"], ["RunSet?$top=1&$filter=PilesDone gt 3", "PilesDone"],
        ["PileSet?$filter=CanRelease eq true", "CanRelease"], ["StageSet?$filter=StatusCriticality eq 3", "StatusCriticality"],
        ["BudgetSet?$filter=StateCriticality eq 1", "StateCriticality"], [`TallySet?$filter=RunId eq '${r.RunId}' and Piles gt 1`, "Piles"]]) {
        const [code, message] = await status(path);
        expect(code, path).equal(400);
        expect(message, path).equal(`${name} is computed after the read and cannot be filtered on`);
      }
      for (const [path, name] of [["RunSet?$orderby=PilesDone desc&$top=1", "PilesDone"], ["PileSet?$orderby=CanRelease", "CanRelease"],
        ["StageSet?$orderby=StatusCriticality desc", "StatusCriticality"], ["BudgetSet?$orderby=StateCriticality", "StateCriticality"]]) {
        const [code, message] = await status(path);
        expect(code, path).equal(400);
        expect(message, path).equal(`${name} is computed after the read and cannot be sorted on`);
      }
      expect((await get("RunSet?$orderby=Started desc&$top=1")).results).length(1);
      // the list report's own filters, and a value that spells a computed field, still work
      expect((await get("RunSet?$filter=Status eq 'GLASS'")).results).length(0);
      expect((await get("RunSet?$filter=CheckDate eq datetime'2026-10-01T00:00:00' and Status eq 'DONE'")).results.map((x) => x.RunId)).include(r.RunId);
      expect((await get(`TallySet?$filter=RunId eq '${r.RunId}'`)).results.map((t) => t.Status)).deep.equal(["DONE"]);
      expect((await get(`PileSet?$filter=RunId eq '${r.RunId}' and Status eq 'DONE'`)).results).length(7);
      const metadata = await (await fetch(`${BASE}/$metadata`)).text();
      expect(metadata).match(/<Property Name="Open" [^>]*sap:sortable="false" sap:filterable="false"/);
      expect(metadata).match(/<Property Name="CheckDate" [^>]*sap:sortable="true" sap:filterable="true"/);
    }
    it("refuses a filter on a computed field in words and keeps the real filters", refusesComputedFilters);
    it("matches a computed name as a whole identifier, never inside a longer one", async () => {
      const box = (v) => new abap.types.String().set(v);
      const names = async (text, name) => (await abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT.names({iv_text: box(text), iv_name: box(name)})).get().trim();
      expect(await names("( PILES_DONE > 3 )", "PILES_DONE")).equal("X");
      expect(await names("OPEN_ALERTS > 0", "OPEN")).equal("");
      expect(await names("(OpenAlerts gt 0)", "Open")).equal("");
      expect(await names("Open eq true", "Open")).equal("X");
      expect(await names("PILES_DONE > 3", "PILES")).equal("");
      // mutant: a substring match finds OPEN in OPEN_ALERTS
      const original = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8");
      const cs = original.replace("    FIND FIRST OCCURRENCE OF REGEX lv_regex IN iv_text.\n    IF sy-subrc = 0.", "    IF iv_text CS iv_name.");
      expect(cs).not.equal(original);
      const mutant = await loadCockpitMutant("zcl_cockpit_names_mut", cs.replaceAll("zcl_zl3c_fleet2_dpc_ext", "zcl_cockpit_names_mut"), join(dir, "names-mutant"));
      expect((await mutant.names({iv_text: box("OPEN_ALERTS > 0"), iv_name: box("OPEN")})).get(), "mutant").equal("X");
    });
    it("mutant: a DPC that ignores computed filters turns the refusal oracle red", async () => {
      const real = abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT, original = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8");
      const source = original.replace("    IF lv_name IS NOT INITIAL.\n      RAISE EXCEPTION", "    IF lv_name = 'never'.\n      RAISE EXCEPTION");
      expect(source).not.equal(original);
      abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = await loadCockpitMutant("zcl_cockpit_refuse_mut", source.replaceAll("zcl_zl3c_fleet2_dpc_ext", "zcl_cockpit_refuse_mut"), join(dir, "refuse-mutant"));
      let failed = false;
      try {await refusesComputedFilters();} catch {failed = true;} finally {abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = real;}
      expect(failed).equal(true);
    });
    it("retains history from stage plans, orders newest first and filters the derived run state", async () => {
      await exec([
        "INSERT INTO zosd_l3_stage (mandt,run_id,stage_no,set_name,check_date,status,opened) VALUES ('','OLD',1,'fleet2','20260930','DONE',20260930000000), ('','OLD',2,'fleet2','20260930','DONE',20260930000001)",
      ]);
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "S"});
      const runs = (await get("RunSet")).results;
      expect(runs.map((s) => [s.RunId, s.Status])).deep.equal([[r.RunId, "DONE"], ["OLD", "DONE"]]);
      expect((await get("RunSet('OLD')")).Status).equal("DONE");
      expect((await get("RunSet?$filter=CheckDate eq datetime'2026-09-30T00:00:00' and Status eq 'DONE'")).results.map((s) => s.RunId)).deep.equal(["OLD"]);
      expect((await get("RunSet?$filter=Status eq 'GLASS'")).results).length(0);
    });
    it("a real governed GLASS run continues through the service and finishes with a visible CONTINUE", async () => {
      await action("SetSetting", {Param: "budget.glass", Value: "1", Note: "one alert"});
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "P"}); await drain();
      expect((await get(`BudgetSet('${r.RunId}')`)).State).equal("GLASS");
      const glass = await get(`RunSet('${r.RunId}')`);
      expect(glass).include({Status: "GLASS", StatusCriticality: 1, Open: true, CanContinue: true, CanResume: false, Glass: 1});
      expect(glass.PilesHeld).above(0);
      expect((await get(`RunSet('${r.RunId}')/to_Tally`)).results.find((t) => t.Status === "GLASS")).include({StatusCriticality: 2});  // in the bar only FAILED is red
      expect((await action("Resume", {RunId: r.RunId})).Answer).include("GLASS");
      expect((await action("ContinueGlass", {RunId: r.RunId, NewGlass: 100, Reason: ""})).Answer).match(/^REFUSED: ContinueGlass: /);
      expect((await action("ContinueGlass", {RunId: r.RunId, NewGlass: 100, Reason: "staff available"})).Answer).equal("OK");
      // fleet2 releases by event: the continued piles wait for the daemon's next pass (its tick, not run
      // here on the manual clock); the Doctor action is that pass now, and each pile's tail releases the next
      await action("Doctor");
      await drain();
      const events = (await get(`EventSet?$filter=RunId eq '${r.RunId}'`)).results;
      expect(events.some((e) => e.Kind === "CONTINUE" && e.Reason === "staff available")).equal(true);
      const stages = (await get(`RunSet('${r.RunId}')/to_Stage`)).results;
      expect(stages.every((s) => s.Status === "DONE")).equal(true);
      const piles = (await get(`RunSet('${r.RunId}')/to_Pile`)).results;
      const budget = await get(`BudgetSet('${r.RunId}')`);
      const plot = series().compute(piles, events, stages, budget, Date.now());
      expect(plot.plan.at(-1).done).equal(piles.filter((p) => p.Status === "DONE").length);
      expect(plot.capacity.at(-1).glass).equal(+budget.Glass);
      expect(plot.capacity.at(-1).reserved).equal(+budget.Reserved);
    });
    it("a HELD pile released with a reason audits RELEASE and resumes", async () => {
      await exec(["INSERT INTO zosd_l2_ship (mandt,ship_id,name,status) VALUES ('123','S003','Also active','A')", "INSERT INTO zosd_l2_voy (mandt,voyage_id,ship_id,dep_date) VALUES ('123','V00003','S003','20261005')"]);
      await action("SetSetting", {Param: "budget.per_pile", Value: "1", Note: "small cap"});
      await action("SetSetting", {Param: "piles.checks.size", Value: "3", Note: "three keys per pile"});
      const r = await action("StartRun", {CheckDate: "20261001", Mode: "S"});
      const held = (await get(`PileSet?$filter=RunId eq '${r.RunId}' and Status eq 'HELD'`)).results;
      expect(held.length).above(0);
      const p = held[0], args = {RunId: r.RunId, RuleName: p.RuleName, PileNo: +p.PileNo, PerPile: 100};
      expect(held.every((h) => h.CanRelease === true && h.StatusCriticality === 2)).equal(true);
      const others = (await get(`PileSet?$filter=RunId eq '${r.RunId}' and Status ne 'HELD'`)).results;
      expect(others.length).above(0);
      expect(others.some((o) => o.CanRelease)).equal(false);
      expect((await get(`RunSet('${r.RunId}')`)).PilesHeld).equal(held.length);
      expect((await action("ReleasePile", {...args, Reason: ""})).Answer).match(/^REFUSED: ReleasePile: /);
      expect((await action("ReleasePile", {...args, Reason: "reviewed pile"})).Answer).equal("OK");
      expect((await get(`EventSet?$filter=RunId eq '${r.RunId}'`)).results.some((e) => e.Kind === "RELEASE" && e.Reason === "reviewed pile")).equal(true);
      await action("Resume", {RunId: r.RunId}); await drain();
    });
    it("daemon start/stop actions expose state and DoctorSet audit", async () => {
      await action("StartRun", {CheckDate: "20261001", Mode: "P"});
      expect((await action("StartDaemon")).Answer).equal("OK");
      expect((await action("ScheduleStatus")).Answer).include("RUNNING since");
      expect((await action("StopDaemon")).Answer).equal("OK");
      await daemonHost(abap).idle();
      expect((await get("DoctorSet")).results.map((r)=>r.DocAction)).include("DMN-START").and.include("DMN-STOP");
      expect((await action("ScheduleStatus")).Answer).include("STOPPED since");
    });
    it("kill, doctor and schedule actions return the runner answers and audit", async () => {
      expect((await action("SetKill", {Reason: "stop work"})).Answer).equal("OK");
      expect((await action("StartRun", {CheckDate: "20261001", Mode: "S"})).Answer).equal("KILLED");
      expect((await action("ClearKill", {Reason: "ready again"})).Answer).equal("OK");
      expect((await get("DoctorSet")).results.map((r) => r.DocAction)).include("SET-KILL").and.include("CLEAR-KILL");
      await action("Doctor");
      const scheduled = await action("Schedule"); expect(scheduled.Answer).match(/\d+/);
      await drainJobOutbox(store);
      const waiting = (await action("ScheduleStatus")).Answer;
      expect(waiting.split(" / ")[0], waiting).match(/^SCHEDULED /);
      expect(waiting).include("UNSCHEDULED").and.include("since");
      expect((await action("Unschedule")).Answer).match(/^deleted [1-9][0-9]*, refused 0$/);
      expect((await action("ScheduleStatus")).Answer).match(/^UNSCHEDULED \/ UNSCHEDULED \/.* since /);
    });
    it("mutants: each computed field of the run page turns its oracle red", async () => {
      const real = abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT, original = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8");
      // an open run at the glass with a held pile and no events
      await exec(["INSERT INTO zosd_l3_run (mandt,set_name,check_date,run_id,status,started) VALUES ('','fleet2','20261003','MUTRUN','HELD',20261003000000)",
        "INSERT INTO zosd_l3_stage (mandt,run_id,stage_no,set_name,check_date,stage_name,status,opened) VALUES ('','MUTRUN',1,'fleet2','20261003','candidates','OPEN',20261003000000)",
        "INSERT INTO zosd_l3_stage (mandt,run_id,stage_no,set_name,check_date,stage_name,status) VALUES ('','MUTRUN',2,'fleet2','20261003','checks','WAITING')",
        "INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,stage_no,status,check_date) VALUES ('','MUTRUN','x',1,'fleet2',1,'DONE','20261003'), ('','MUTRUN','x',2,'fleet2',1,'HELD','20261003'), ('','MUTRUN','x',4,'fleet2',1,'FAILED','20261003')",
        // a pile RUNNING in a job that is gone: the doctor's case, shown before the doctor runs
        "INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,stage_no,status,check_date,job_name,job_count) VALUES ('','MUTRUN','x',3,'fleet2',1,'RUNNING','20261003','L3_GONE','99999999')",
        "INSERT INTO zosd_l3_budget (mandt,run_id,set_name,state,glass,reserved,warn_at,narrow_at) VALUES ('','MUTRUN','fleet2','GLASS',10,5,7000,8000)"]);
      const pile = async (status) => (await get(`PileSet?$filter=RunId eq 'MUTRUN' and Status eq '${status}'`)).results[0];
      const oracles = {
        open: async () => expect((await get("RunSet('MUTRUN')")).Open).equal(true),
        continue: async () => expect((await get("RunSet('MUTRUN')")).CanContinue).equal(true),
        hidden: async () => expect((await get("RunSet('MUTRUN')")).HideEvent).equal(true),
        release: async () => expect((await pile("HELD")).CanRelease).equal(true),
        criticality: async () => expect((await pile("DONE")).StatusCriticality).equal(3),
        tally: async () => expect((await get("RunSet('MUTRUN')/to_Tally")).results.map((t) => [t.Status, t.Label])).deep.equal([["DONE", "DONE 1"], ["RUNNING", "RUNNING 1"], ["HELD", "HELD 1"], ["FAILED", "FAILED 1"]]),
        orphaned: async () => expect((await get("RunSet('MUTRUN')")).PilesOrphaned).equal(1),
        done: async () => expect((await get("RunSet('MUTRUN')")).PctFinal).equal(25),
        levels: async () => expect((await get("RunSet('MUTRUN')")).WarnLevel).equal(7),
      };
      for (const oracle of Object.values(oracles)) await oracle();
      const variants = [
        ["open", original.replace("      cs_run-is_open = abap_true.\n", "")],
        ["continue", original.replace("      cs_run-can_continue = abap_true.\n", "")],
        ["hidden", original.replaceAll("IF lv_count = 0.", "IF lv_count < 0.")],
        ["release", original.replaceAll("can_release = abap_true.", "can_release = abap_false.")],
        ["criticality", original.replace("rv_criticality = 3.", "rv_criticality = 0.")],
        ["tally", original.replace("        DELETE lt_counts WHERE status = lv_status.\n", "")],
        ["orphaned", original.replace("cs_run-piles_orphaned = cs_run-piles_orphaned + 1.", "CLEAR cs_run-piles_orphaned.")],
        ["done", original.replace("cs_run-pct_final = cs_run-piles_done * 100 / cs_run-piles.", "cs_run-pct_final = cs_run-piles_final * 100 / cs_run-piles.")],
        ["levels", original.replace("cs_run-warn_level = ls_budget-glass * ls_budget-warn_at / 10000.", "cs_run-warn_level = ls_budget-glass.")],
      ];
      for (const [name, text] of variants) {
        expect(text, name).not.equal(original);
        const cls = `zcl_cockpit_${name}_mut`;
        abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = await loadCockpitMutant(cls, text.replaceAll("zcl_zl3c_fleet2_dpc_ext", cls), join(dir, cls));
        let failed = false;
        try {await oracles[name]();} catch {failed = true;} finally {abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = real;}
        expect(failed, name).equal(true);
      }
    });
    it("mutants: removed set filter, direct table action and accepted missing audited reason each turn red", async () => {
      const real = abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT, original = readFileSync("src/l2demo/zcl_zl3c_fleet2_dpc_ext.clas.abap", "utf8");
      await exec(["INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,status) VALUES ('','OTHER','x',1,'other','DONE')"]);
      const variants = [
        ["zcl_cockpit_filter_mut", original.replaceAll("lv_where = |SET_NAME = 'fleet2'|.", "lv_where = |SET_NAME <> ' '|."), async () => expect((await get("RunSet")).results.every((r) => r.SetName === "fleet2")).equal(true)],
        ["zcl_cockpit_write_mut", original.replace("lv_ok = zcl_l3_fleet2=>set_setting( iv_param = lv_param iv_value = lv_value iv_note = lv_note ).", "UPDATE zosd_l3_conf SET param_val = lv_value WHERE set_name = 'fleet2' AND param_name = lv_param.\n        lv_ok = abap_true."), async () => {await action("SetSetting", {Param: "budget.glass", Value: "20", Note: "mutant audit"}); expect(read("SELECT * FROM zosd_l3_conf_log WHERE note_text='mutant audit'")).length(1);}],
        ["zcl_cockpit_reason_mut", original.replace("iv_per_pile = lv_cap iv_reason = lv_reason", "iv_per_pile = lv_cap iv_reason = 'invented reason'"), async () => expect((await action("ReleasePile", {RunId: "HELD", RuleName: "x", PileNo: 1, PerPile: 0, Reason: ""})).Answer).match(/^REFUSED: ReleasePile: /)],
      ];
      await exec(["INSERT INTO zosd_l3_run (mandt,set_name,check_date,run_id,status,started) VALUES ('','other','20261001','OTHER','RELEASED',20261001000000)",
        "INSERT INTO zosd_l3_run (mandt,set_name,check_date,run_id,status) VALUES ('','fleet2','20261002','HELD','HELD')",
        "INSERT INTO zosd_l3_budget (mandt,run_id,set_name,state,glass) VALUES ('','HELD','fleet2','RUNNING',100)",
        "INSERT INTO zosd_l3_pile (mandt,run_id,rule_name,pile_no,set_name,status,check_date) VALUES ('','HELD','x',1,'fleet2','HELD','20261002')"]);
      for (const [name, text, oracle] of variants) {
        let failed = false;
        abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = await loadCockpitMutant(name, text.replaceAll("zcl_zl3c_fleet2_dpc_ext", name), join(dir, name));
        try {await oracle();} catch {failed = true;} finally {abap.Classes.ZCL_ZL3C_FLEET2_DPC_EXT = real;}
        expect(failed, name).equal(true);
      }
      expect((await get("RunSet")).results.every((r) => r.SetName === "fleet2")).equal(true);
    });
  });
});
