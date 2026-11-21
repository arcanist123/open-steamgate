// R11: the last two walls of the flight reference scenario (docs/rap-runtime.md,
// "R11") -- the agency's interface BDEF /DMO/I_AgencyTP (`interface; use
// draft;`, run on its base) and the carrier singleton /DMO/I_CarriersLock-
// Singleton_S (a root computed from a join, every carrier below it, edited as
// one draft) with its projection, served as /DMO/UI_CARRIERS_S over V4 the
// way sap.fe drives the multi-inline edit: Edit the root, change, create and
// delete carriers below its draft, Prepare, Activate. The first half needs
// only the generators (and the pack's fetched sources, else it skips); the
// second a transpiled tree with the pack. The runtime half (EML, the
// interface BO) is ZCL_OSD_RAPFLIGHT_R11_TEST.
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {parseBdef} from "../tools/rap/bdef-parse.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {literalType} from "../tools/cds-computed.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";
import {startServer} from "./start.mjs";

const PACK = "packs/rap-flight";
const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const C = "%2FDMO%2FUI_CARRIERS_S";
const v4 = `${origin}/sap/opu/odata4/sap/${C}`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json", "if-match": "*"};
const json = {accept: "application/json"};

async function call(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body};
}

function inputs() {
  const files = [];
  for (const dir of ["src", join(PACK, "upstream"), join(PACK, "src")]) {
    for (const f of walk(dir)) {
      if (/\.(bdef\.asbdef|srvd\.srvdsrv|ddls\.(asddls|xml)|tabl\.xml|view\.xml|dtel\.xml|doma\.xml)$/.test(f)) {
        files.push({filename: f.split("/").pop(), contents: readFileSync(f, "utf8")});
      }
    }
  }
  const deps = [];
  for (const name of ["open-abap-core", "open-abap-odata"]) {
    deps.push(...walk(join(libraryPath(".", name), "src")).filter(f => /\.(tabl|view|dtel|doma)\.xml$/.test(f))
      .map(f => ({filename: f.split("/").pop(), contents: readFileSync(f, "utf8")})));
  }
  return {files, deps};
}
const pools = names => names.flatMap(n => walk(join(PACK, "src")).filter(f => f.split("/").pop().startsWith(`${n}.clas.`)))
  .map(f => ({filename: f.split("/").pop(), contents: readFileSync(f, "utf8")}));

describe("RAP R11 the BDEF grammar of the carrier singleton", () => {
  it("keeps a pragma of an entity header (##DRAFT_OP_NOT_REQUIRED) and leaves nothing unparsed", () => {
    const model = parseBdef(`managed implementation in class zbp unique;
with draft;
define behavior for ZI_S alias S
with unmanaged save
draft table zs_d
lock master
##DRAFT_OP_NOT_REQUIRED
{
  draft action Edit;
}`);
    assert.deepEqual(model.unparsed, []);
    assert.deepEqual(model.entities[0].pragmas, ["##DRAFT_OP_NOT_REQUIRED"]);
    assert.equal(model.entities[0].lock.kind, "master");
  });

  it("types a literal as a system does: the smallest integer type, CHAR of a string's length", () => {
    assert.equal(literalType("1").abap, "int1");
    assert.equal(literalType("300").abap, "int2");
    assert.equal(literalType("70000").abap, "int4");
    assert.deepEqual([literalType("'AB'").abap, literalType("'AB'").value], ["c LENGTH 2", "AB"]);
  });
});

describe("RAP R11 the flight's interface BDEF and carrier singleton (generators)", function () {
  this.timeout(120000);
  let out, runtime;
  before(function () {
    if (!existsSync(join(PACK, "upstream"))) this.skip();
    const {files, deps} = inputs();
    out = generate(files, deps);
    // the flight's BDEFs only: the tree's other BOs need pools of src/
    runtime = runtimeOutputs(out.plans.filter(p => p.root.startsWith("/DMO/")), pools(["#dmo#bp_i_carrierslocksingle_s", "#dmo#bp_r_agencytp", "#dmo#bp_i_supplement",
      "#dmo#bp_c_supplement", "#dmo#bp_travel_m", "#dmo#bp_booking_m", "#dmo#bp_bookingsupplement_m"]));
  });
  const plan = root => out.plans.find(p => p.root === root);
  const iface = root => out.outputs[`${plan(root).iface}.intf.abap`];
  const adapter = root => runtime[`${plan(root).iface.replace(/^zif_/, "zcl_")}.clas.abap`];

  it("runs the interface BDEF on its base: typed as a projection, %pid of the late base in %pky", () => {
    const p = plan("/DMO/I_AGENCYTP");
    assert.equal(p.projection, true);
    assert.equal(p.interface, true);
    assert.equal(p.base.root, "/DMO/R_AGENCYTP");
    assert.match(iface("/DMO/I_AGENCYTP"), /INCLUDE TYPE e0_key AS %key\.\n {2}TYPES %pid TYPE x LENGTH 16\./);
    assert.equal(out.bindings["TABLE FOR CREATE /DMO/I_AGENCYTP"], `${p.iface}=>t_e0_create`);
    const registry = runtime["zcl_osd_rap_registry.clas.abap"];
    assert.match(registry, /METHOD zif_osd_rap_registry~projections\.[\s\S]*WHEN '\/DMO\/I_AGENCYTP'\.\n\s+ls_projection = zif_osd_rap_registry~projection\( '\/DMO\/I_AGENCYTP' \)\./);
  });

  it("reads the singleton root through its computed view, the carriers' CarrierSingletonID as a constant", () => {
    const a = adapter("/DMO/I_CARRIERSLOCKSINGLETON_S");
    assert.match(a, /ls_entity-name = '\/DMO\/I_CARRIERSLOCKSINGLETON_S'\.[\s\S]*?ls_entity-table = ''\.\n\s+ls_entity-source = 'ZCL_STG_CDS_DMO_I_CARRIER_9A8E'\./, "no table: the view's source class");
    assert.match(a, /ls_field-name = 'CARRIERSINGLETONID'\.\n\s+ls_field-column = 'CARRIERSINGLETONID'\.\n(\s+ls_field-readonly = 'X'\.\n)?\s+ls_field-constant = '1'\./);
    assert.match(a, /ls_member-name = 'VALIDATENAME'\.\n\s+ls_member-entity = '\/DMO\/I_CARRIER_S'\./, "the root's Prepare runs the carrier's validation");
  });

  it("serves the singleton as a draft root: the literal key typed Byte, the carriers created through _Airline", () => {
    const yaml = out.outputs["#dmo#ui_carriers_s.stg.yaml"];
    assert.match(yaml, /keys: \[CarrierSingletonID, IsActiveEntity\]/);
    assert.match(yaml, /CarrierSingletonID: \{type: Byte, field: CARRIERSINGLETONID, readonly: true/);
    assert.match(yaml, /CarrierType:\n\s+set: Carrier\n[\s\S]*?creatable: true/);
    assert.match(yaml, /draftRoot: \{set: CarriersSingleton, activation: \/DMO\/UI_CARRIERS_S\.Activate/);
  });

  it("reads the active rows of a view with a constant, and of the computed root, through their source class", () => {
    const unions = Object.entries(runtime).filter(([f]) => f.startsWith(plan("/DMO/I_CARRIERSLOCKSINGLETON_S").iface.replace(/^zif_/, "zcl_") + "_d"));
    assert.equal(unions.length, 2);
    for (const [, abap] of unions) {
      assert.match(abap, /CREATE OBJECT li_view TYPE zcl_stg_cds_/);
      assert.doesNotMatch(abap, /SELECT \* FROM \/dmo\/i_carrier/i);
    }
  });
});

describe("RAP R11 the carrier singleton over OData V4", function () {
  this.timeout(300000);
  let server;
  before(async function () {
    if (!existsSync(join(PACK, "upstream"))) this.skip();
    server = startServer(true);
    for (let i = 0; i < 1200; i++) {
      try {
        if ((await fetch(`${v4}/$metadata`)).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
  });
  after(() => server?.close());

  const root = active => `${v4}/CarriersSingleton(CarrierSingletonID=1,IsActiveEntity=${active})`;
  const carrier = (id, active) => `${v4}/Carrier(AirlineID='${id}',IsActiveEntity=${active})`;
  const act = (active, action, body = "{}") => call(`${root(active)}/${C}.${action}`, {method: "POST", headers: write, body});
  const get = url => call(url, {headers: json});
  const patch = (url, body) => call(url, {method: "PATCH", headers: write, body: JSON.stringify(body)});

  it("$metadata: the literal key, the draft actions, the composition", async () => {
    const res = await call(`${v4}/$metadata`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<Property Name="CarrierSingletonID" Type="Edm.Byte"/);
    assert.match(res.body, /<Action Name="Edit" IsBound="true"/);
    assert.match(res.body, /<NavigationProperty Name="to_Airline"/, "the composition, named as every navigation of this registry");
    assert.match(res.body, /Common\.v1\.DraftRoot/);
  });

  it("answers the one root instance, every carrier below it", async () => {
    let res = await get(`${v4}/CarriersSingleton`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.value.map(v => [v.CarrierSingletonID, v.IsActiveEntity]), [[1, true]]);
    res = await get(`${root(true)}/to_Airline`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.ok(res.body.value.length > 3, "the seeded carriers");
    assert.ok(res.body.value.every(v => v.CarrierSingletonID === 1 && v.IsActiveEntity === true));
    // a navigation and an $expand of a namespaced service (its name escaped
    // in the path the provider builds for the target, R11)
    const expanded = await get(`${root(true)}?$expand=to_Airline`);
    assert.equal(expanded.status, 200, JSON.stringify(expanded.body));
    assert.equal(expanded.body.to_Airline.length, res.body.value.length);
  });

  it("edits the singleton: changes a carrier, creates one below the draft, activates them together", async () => {
    const carriers = (await get(`${root(true)}/to_Airline`)).body.value;
    const first = carriers[0];
    let res = await act(true, "Edit", JSON.stringify({PreserveChanges: true}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, false);
    res = await get(`${root(false)}/to_Airline`);
    assert.equal(res.body.value.length, carriers.length, "a draft of every carrier");
    res = await patch(carrier(first.AirlineID, false), {Name: "R11 renamed"});
    assert.ok([200, 204].includes(res.status), JSON.stringify(res.body));
    res = await call(`${root(false)}/to_Airline`, {method: "POST", headers: write,
      body: JSON.stringify({AirlineID: "ZY", Name: "R11 airline", CurrencyCode: first.CurrencyCode})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.CarrierSingletonID, 1, "below the root");
    assert.equal((await get(carrier(first.AirlineID, true))).body.Name, first.Name, "the active carrier is unchanged while drafting");
    assert.equal((await act(false, "Prepare")).status, 200);
    res = await act(false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, true);
    assert.equal((await get(carrier(first.AirlineID, true))).body.Name, "R11 renamed");
    assert.equal((await get(carrier("ZY", true))).body.Name, "R11 airline");
    assert.equal((await get(root(false))).status, 404, "the draft is gone");
    // back as it was: the name restored, the new carrier deleted, in one more draft
    assert.equal((await act(true, "Edit", JSON.stringify({PreserveChanges: true}))).status, 200);
    assert.ok([200, 204].includes((await patch(carrier(first.AirlineID, false), {Name: first.Name})).status));
    assert.equal((await call(carrier("ZY", false), {method: "DELETE", headers: write})).status, 204);
    assert.equal((await act(false, "Activate")).status, 200);
    assert.equal((await get(carrier("ZY", true))).status, 404);
    assert.equal((await get(carrier(first.AirlineID, true))).body.Name, first.Name);
  });

  it("refuses to activate a carrier without a name (Carrier~validateName in the root's Prepare); discards the draft", async () => {
    const first = (await get(`${root(true)}/to_Airline`)).body.value[0];
    assert.equal((await act(true, "Edit", JSON.stringify({PreserveChanges: true}))).status, 200);
    assert.ok([200, 204].includes((await patch(carrier(first.AirlineID, false), {Name: ""})).status));
    const res = await act(false, "Activate");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((await get(root(false))).status, 200, "the draft stays");
    assert.equal((await call(root(false), {method: "DELETE", headers: write})).status, 204, "Discard");
    assert.equal((await get(root(false))).status, 404);
    assert.equal((await get(carrier(first.AirlineID, true))).body.Name, first.Name);
    // the active root has no delete: only its draft takes a DELETE (Discard)
    const res2 = await call(root(true), {method: "DELETE", headers: write});
    assert.ok(res2.status >= 400 && res2.status < 500, JSON.stringify(res2));
    assert.equal((await get(root(true))).status, 200);
  });
});
