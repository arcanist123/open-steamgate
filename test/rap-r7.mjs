// R7: the saver, with additional save, with unmanaged save and several
// behavior pools, on the tour demo of src/rap_r7 (docs/rap-runtime.md,
// "R7"): the tour is written by the managed save and logged by the saver's
// save_modified, its stops are written by save_modified alone, and the
// stops' validation lives in a second pool. The generator half runs without
// a build; the wire half needs a transpiled tree (npm run transpile). The
// runtime half is ABAP Unit: ZCL_OSD_RAP_R7_TEST.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {parseBdef} from "../tools/rap/bdef-parse.mjs";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {lowerDerived} from "../tools/rap/lower-derived.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_TOUR`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_TOUR`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const tour = () => walk("src/rap_r7").filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
  .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const pools = files => files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename));
const build = files => {
  const {outputs, plans, bindings} = generate(files);
  return {outputs, bindings, runtime: runtimeOutputs(plans, pools(files))};
};
const swap = (files, name, from, to) => files.map(f => {
  if (f.filename !== name) return f;
  assert.ok(f.contents.includes(from), `${name}: ${from}`);
  return {...f, contents: f.contents.replace(from, to)};
});
const refusal = files => { try { build(files); } catch (error) { return error.message; } return "accepted"; };
const BDEF = "zi_rap_tour.bdef.asbdef";
const POOL = "zbp_rap_tour.clas.locals_imp.abap";

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R7 saver (generator)", () => {
  it("parses with additional / unmanaged save and their options", () => {
    const model = parseBdef(tour().find(f => f.filename === BDEF).contents);
    assert.deepEqual(model.entities.map(e => [e.implementationClass, e.options.map(o => o.kind)]),
      [[null, ["additional save"]], ["zbp_rap_stop", ["unmanaged save"]]]);
    const full = parseBdef("managed;\ndefine behavior for X with additional save with full data and cleanup\n{ }\n");
    assert.deepEqual(full.entities[0].options, [{kind: "additional save", fullData: true, cleanup: true}]);
    assert.deepEqual(full.unparsed, []);
  });

  it("writes the model: each entity's pool and handler, the save, the savers", () => {
    const {runtime} = build(tour());
    const adapter = Object.entries(runtime).find(([n, s]) => n.startsWith("zcl_rap_") && s.includes("ZI_RAP_TOUR"))[1];
    for (const text of [
      "ls_saver-name = '\\CLASS-POOL=ZBP_RAP_TOUR\\CLASS=LSC_TOUR'.\n    ls_saver-modified = abap_true.",
      "ls_entity-table = 'ZRAP_TOUR'.",
      "ls_entity-pool = 'ZBP_RAP_TOUR'.\n    ls_entity-save = 'A'.",
      // the unmanaged entity reads from its mapping table, handled in its own pool
      "ls_entity-table = 'ZRAP_TOURSTOP'.",
      "ls_entity-pool = 'ZBP_RAP_STOP'.\n    ls_entity-save = 'U'.",
      "ls_entity-handler = '\\CLASS-POOL=ZBP_RAP_STOP\\CLASS=LHC_STOP'.",
      "CALL METHOD io_saver->('SAVE_MODIFIED')",
      "CREATE DATA rr_request TYPE zif_rap_",
    ]) assert.ok(adapter.includes(text), text);
  });

  it("types the request: one table per entity, keyed entity, and binds it for every pool", () => {
    const {outputs, bindings} = build(tour());
    const iface = Object.entries(outputs).find(([n, s]) => n.startsWith("zif_rap_") && s.includes("r_change"))[1];
    assert.match(iface, /TYPES t_e0_req_change TYPE STANDARD TABLE OF e0_req_change WITH DEFAULT KEY WITH NON-UNIQUE SORTED KEY entity COMPONENTS tour_id\./);
    assert.match(iface, /TYPES t_e1_req_delete TYPE STANDARD TABLE OF e1_req_delete WITH DEFAULT KEY WITH NON-UNIQUE SORTED KEY entity COMPONENTS tour_id stop_no\./);
    assert.match(iface, /BEGIN OF r_change,\n\s+tour TYPE t_e0_req_change,\n\s+stop TYPE t_e1_req_change,/);
    for (const pool of ["ZBP_RAP_TOUR", "ZBP_RAP_STOP"]) {
      assert.match(bindings[`POOL ${pool} FOR REQUEST CHANGE`], /=>r_change$/);
      assert.match(bindings[`POOL ${pool} FOR REQUEST DELETE`], /=>r_delete$/);
    }
    assert.match(bindings["REQUEST FOR CHANGE ZI_RAP_TOUR"], /=>r_change$/);
    assert.match(bindings["RESPONSE FOR REPORTED LATE ZI_RAP_TOUR"], /=>r_reported$/);
    assert.equal(bindings["POOL ZBP_RAP_TOUR FOR MAPPING FROM ENTITY STOP"], "MAPPING place_name = place");
    assert.equal(bindings["POOL ZBP_RAP_TOUR FOR MAPPING FROM ENTITY KEYS STOP"], "%NONE");
    assert.equal(bindings["POOL ZBP_RAP_TOUR FOR MAPPING TO ENTITY STOP"], "MAPPING place = place_name");
  });

  it("lowers save_modified REDEFINITION and MAPPING FROM ENTITY", () => {
    const {bindings} = build(tour());
    const source = tour().find(f => f.filename === POOL).contents;
    const lowered = lowerDerived(source, POOL, bindings);
    assert.match(lowered, /METHODS save_modified IMPORTING create TYPE zif_rap_\w+=>r_change update TYPE zif_rap_\w+=>r_change delete TYPE zif_rap_\w+=>r_delete CHANGING reported TYPE zif_rap_\w+=>r_reported\./);
    assert.ok(lowered.includes("CORRESPONDING #( create-stop MAPPING place_name = place )"));
    // a REQUEST FOR DELETE row has the keys only
    assert.ok(lowered.includes("CORRESPONDING #( delete-stop  )"));
    // the row count stays, for the source map
    assert.equal(lowered.split("\n").length, source.split("\n").length);
    assert.throws(() => lowerDerived("x = CORRESPONDING #( create-nothing MAPPING FROM ENTITY ).\n", POOL, bindings), /names no entity/);
  });

  it("refuses what R7 does not run, each by name", () => {
    assert.match(refusal(swap(tour(), POOL, "METHODS save_modified REDEFINITION.", "")), /with additional save needs a saver with save_modified/);
    // R11: without a mapping table an unmanaged save reads through its CDS
    // view (the carrier singleton's root, docs/rap-runtime.md "R11")
    assert.equal(refusal(swap(tour(), BDEF, "  mapping for zrap_tourstop corresponding\n  {\n    place = place_name;\n  }\n", "")), "accepted");
    assert.match(refusal(swap(tour(), BDEF, "with unmanaged save\n", "with unmanaged save\npersistent table zrap_tourstop\n")), /with unmanaged save and a persistent table/);
    // a pool the BDEF names must be in the tree
    assert.match(refusal(tour().filter(f => !f.filename.startsWith("zbp_rap_stop."))), /behavior pool zbp_rap_stop not found/);
  });
});

describe("RAP R7 saver over OData", function () {
  this.timeout(120000);
  let server;
  before(async () => {
    server = startServer(true);
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${v2}/$metadata`)).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
  });
  after(() => server.close());

  const get = url => call(url, {headers: {accept: "application/json"}});
  const logOf = async (id) => (await get(`${v2}/Log?$filter=tour_id eq '${id}'&$format=json`)).body.d.results
    .map(r => `${r.operation} ${r.field_name}=${r.new_value}`).sort();
  const create = async (description) => {
    const res = await call(`${v2}/Tour`, {method: "POST", headers: write, body: JSON.stringify({description})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.d.tour_id;
  };
  const stop = (id, place, nights) => call(`${v2}/Tour('${id}')/to_Stops`, {method: "POST", headers: write, body: JSON.stringify({place, nights})});

  it("creates a tour and its stops: the managed write, the log and the saver's stops (V2)", async () => {
    const id = await create("coast");
    assert.equal((await stop(id, "Porto", 2)).status, 201);
    const res = await stop(id, "Lisbon", 3);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.d.stop_no, "0002");
    const stops = (await get(`${v2}/Tour('${id}')/to_Stops?$format=json`)).body.d.results;
    assert.deepEqual(stops.map(s => [s.stop_no, s.place, s.nights]), [["0001", "Porto", 2], ["0002", "Lisbon", 3]]);
    assert.deepEqual(await logOf(id), ["CREATE description=coast"]);
  });

  it("refuses a stop without nights in the second pool's validation, and writes nothing", async () => {
    const id = await create("short");
    const res = await stop(id, "Nowhere", 0);
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /at least one night/);
    assert.equal((await get(`${v2}/Tour('${id}')/to_Stops?$format=json`)).body.d.results.length, 0);
  });

  it("updates a stop through the saver and logs an update of the tour (V2)", async () => {
    const id = await create("hills");
    await stop(id, "Sintra", 1);
    let tag = (await get(`${v2}/Stop(tour_id='${id}',stop_no='0001')?$format=json`)).headers.get("etag");
    let res = await call(`${v2}/Stop(tour_id='${id}',stop_no='0001')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({nights: 4})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const s = (await get(`${v2}/Stop(tour_id='${id}',stop_no='0001')?$format=json`)).body.d;
    assert.deepEqual([s.place, s.nights], ["Sintra", 4]);
    tag = (await get(`${v2}/Tour('${id}')?$format=json`)).headers.get("etag");
    res = await call(`${v2}/Tour('${id}')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({description: "high hills"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.deepEqual(await logOf(id), ["CREATE description=hills", "UPDATE description=high hills"]);
  });

  it("runs the action and the delete through the saver (V2)", async () => {
    const id = await create("river");
    await stop(id, "Douro", 2);
    let tag = (await get(`${v2}/Tour('${id}')?$format=json`)).headers.get("etag");
    let res = await call(`${v2}/close?tour_id='${id}'`, {method: "POST", headers: {...write, "if-match": tag}});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.status, "C");
    tag = (await get(`${v2}/Tour('${id}')?$format=json`)).headers.get("etag");
    res = await call(`${v2}/Tour('${id}')`, {method: "DELETE", headers: {...write, "if-match": tag}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await get(`${v2}/Tour('${id}')?$format=json`)).status, 404);
    assert.equal((await get(`${v2}/Stop?$filter=tour_id eq '${id}'&$format=json`)).body.d.results.length, 0, "the saver deleted the stops");
    assert.deepEqual(await logOf(id), ["CREATE description=river", "DELETE =", "UPDATE status=C"]);
  });

  it("answers a saver's failure in the save as a business error with its text, and writes nothing", async () => {
    const res = await call(`${v2}/Tour`, {method: "POST", headers: write, body: JSON.stringify({description: "unsaveable"})});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(JSON.stringify(res.body), /The tour log refuses an unsaveable tour/);
    const tours = (await get(`${v2}/Tour?$filter=description eq 'unsaveable'&$format=json`)).body.d.results;
    assert.equal(tours.length, 0);
  });

  it("does the same over V4", async () => {
    let res = await call(`${v4}/Tour`, {method: "POST", headers: write, body: JSON.stringify({description: "lakes"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.tour_id;
    // early numbering draws MAX + 1, so a deleted tour's number comes back:
    // the log is compared with what it held before this tour
    const before = await logOf(id);
    assert.ok(before.includes("CREATE description=lakes"));
    res = await call(`${v4}/Tour('${id}')/to_Stops`, {method: "POST", headers: write, body: JSON.stringify({place: "Geres", nights: 2})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    let tag = (await call(`${v4}/Stop(tour_id='${id}',stop_no='0001')`)).body["@odata.etag"];
    res = await call(`${v4}/Stop(tour_id='${id}',stop_no='0001')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({nights: 5})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await call(`${v4}/Stop(tour_id='${id}',stop_no='0001')`)).body.nights, 5);
    tag = (await call(`${v4}/Tour('${id}')`)).body["@odata.etag"];
    res = await call(`${v4}/Tour('${id}')/ZUI_RAP_TOUR.close`, {method: "POST", headers: {...write, "if-match": tag}, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    tag = (await call(`${v4}/Tour('${id}')`)).body["@odata.etag"];
    res = await call(`${v4}/Tour('${id}')`, {method: "DELETE", headers: {...write, "if-match": tag}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await call(`${v4}/Stop?$filter=tour_id eq '${id}'`)).body.value.length, 0);
    const count = (log, entry) => log.filter(x => x === entry).length;
    const after = await logOf(id);
    assert.equal(after.length, before.length + 2, after.join("; "));
    assert.equal(count(after, "UPDATE status=C"), count(before, "UPDATE status=C") + 1);
    assert.equal(count(after, "DELETE ="), count(before, "DELETE =") + 1);
  });
});
