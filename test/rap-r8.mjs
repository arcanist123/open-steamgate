// R8: draft, on the trip demo of src/rap_r8 (docs/rap-runtime.md, "R8"): a
// draft-enabled root with one composition child, created as a draft,
// changed, prepared, activated, edited and discarded over OData V4 the way
// Fiori Elements V4 sends it. The generator half runs without a build; the
// wire half needs a transpiled tree (npm run transpile). The runtime half,
// EML with %is_draft, is ABAP Unit: ZCL_OSD_RAP_R8_TEST.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {parseBdef} from "../tools/rap/bdef-parse.mjs";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_DTRIP`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_DTRIP`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const LATEST = encodeURIComponent("IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null");
const LATEST_AND = rest => encodeURIComponent(`(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null) and ${rest}`);
// the draft tables and the admin table of src/rap the demo's BDEF needs
const trip = () => [...walk("src/rap_r8"), "src/rap/zosd_draft_adm.tabl.xml", "src/rap_draftadm/zosd_i_draftadm.ddls.asddls", "src/rap_draftadm/zosd_i_draftadm.ddls.xml"].filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
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
const BDEF = "zi_rap_dtrip.bdef.asbdef";

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R8 draft (generator)", () => {
  it("parses with draft, draft table, total etag, draft actions and with draft associations", () => {
    const model = parseBdef(trip().find(f => f.filename === BDEF).contents);
    assert.equal(model.withDraft, true);
    const [root, leg] = model.entities;
    assert.deepEqual([root.draftTable, root.totalEtag, leg.draftTable], ["zrap_dtrip_d", "last_changed_at", "zrap_dleg_d"]);
    assert.deepEqual(root.actions.map(a => [a.name, a.modifiers]), [["Edit", ["draft"]], ["Activate", ["draft"]], ["Discard", ["draft"]], ["Resume", ["draft"]]]);
    assert.equal(root.actions[1].optimized, true);
    assert.deepEqual(root.determineActions.map(a => [a.name, a.modifiers, a.triggers.map(t => t.name)]), [["Prepare", ["draft"], ["CheckDescription"]]]);
    assert.deepEqual([root.associations[0].withDraft, leg.associations[0].withDraft], [true, true]);
    assert.deepEqual(model.unparsed, []);
  });

  it("types %is_draft into %tky and the draft actions' import and result", () => {
    const {outputs, bindings} = build(trip());
    const iface = Object.entries(outputs).find(([n, s]) => n.startsWith("zif_rap_") && s.includes("zrap") === false && s.includes("trip_uuid"))[1];
    assert.match(iface, /INCLUDE TYPE e0_pky AS %pky\.\n  TYPES %is_draft TYPE x LENGTH 1\./);
    for (const action of ["EDIT", "ACTIVATE", "RESUME"]) assert.ok(bindings[`TABLE FOR ACTION RESULT ZI_RAP_DTRIP~${action}`], action);
    assert.ok(bindings["TABLE FOR ACTION IMPORT ZI_RAP_DTRIP~DISCARD"]);
    assert.equal(bindings["TABLE FOR ACTION RESULT ZI_RAP_DTRIP~DISCARD"], undefined);
    assert.ok(bindings["TABLE FOR ACTION IMPORT ZI_RAP_DTRIP~PREPARE"]);
  });

  it("writes the model: draft tables, total etag, draft actions, Prepare's members, the union classes", () => {
    const {runtime} = build(trip());
    const adapter = Object.entries(runtime).find(([n, s]) => /^zcl_rap_[0-9a-f]+\.clas\.abap$/.test(n) && s.includes("ZI_RAP_DTRIP"))[1];
    for (const text of [
      "rs_model-draft = abap_true.",
      "ls_entity-draft_table = 'ZRAP_DTRIP_D'.\n    ls_entity-draft_source = 'ZCL_STG_TAB_ZRAP_DTRIP_D'.",
      "ls_entity-total_etag = 'LAST_CHANGED_AT'.",
      "ls_callable-kind = 'E'.\n    ls_callable-name = 'EDIT'.",
      "ls_callable-kind = 'E'.\n    ls_callable-name = 'DISCARD'.",
      "ls_callable-kind = 'X'.\n    ls_callable-name = 'PREPARE'.\n    CLEAR ls_member.\n    ls_member-kind = 'V'.\n    ls_member-name = 'CHECKDESCRIPTION'.",
      "ls_entity-draft_table = 'ZRAP_DLEG_D'.",
    ]) assert.ok(adapter.includes(text), text);
    const unions = Object.entries(runtime).filter(([n]) => /_d[01]\.clas\.abap$/.test(n));
    assert.equal(unions.length, 2);
    assert.match(unions[0][1], /INCLUDE TYPE zi_rap_dtrip\.\n    TYPES: isactiveentity  TYPE c LENGTH 1,/);
    assert.match(unions[0][1], /SELECT \* FROM zrap_dtrip_d INTO TABLE lt_draft WHERE \(lv_where\)\./);
    assert.match(unions[0][1], /INTERFACES zif_stg_cds_draft_source\./);
  });

  it("serves the key IsActiveEntity, the flags, the draft actions and DraftRoot (service YAML)", () => {
    const {outputs} = build(trip());
    const yaml = outputs["zui_rap_dtrip.stg.yaml"];
    assert.match(yaml, /keys: \[trip_uuid, IsActiveEntity\]/);
    assert.match(yaml, /IsActiveEntity: \{type: Boolean, field: ISACTIVEENTITY, readonly: true/);
    assert.match(yaml, /HasDraftEntity: \{type: Boolean/);
    assert.match(yaml, /struct: "ZCL_RAP_[0-9A-F]+_D0=>TY_ROW"/);
    assert.match(yaml, /  Edit:\n.*\n.*\n.*\n    parameters: \{trip_uuid: String\(32\), IsActiveEntity: Boolean, PreserveChanges: Boolean\}/);
    assert.match(yaml, /  Activate:/);
    assert.match(yaml, /  Prepare:/);
    assert.doesNotMatch(yaml, /  Discard:/, "Discard is the DELETE of the draft root");
    assert.match(yaml, /draftRoot: \{set: Trip, activation: ZUI_RAP_DTRIP\.Activate, edit: ZUI_RAP_DTRIP\.Edit, prepare: ZUI_RAP_DTRIP\.Prepare\}/);
    assert.match(yaml, /draftNode: \{set: Leg\}/);
  });

  it("refuses what R8 does not run, each by name", () => {
    assert.match(refusal(swap(trip(), BDEF, "draft table zrap_dtrip_d\n", "")), /with draft needs a draft table/);
    assert.match(refusal(swap(trip(), BDEF, "draft table zrap_dtrip_d", "draft table zrap_dtrip")), /draft table zrap_dtrip has no admin column/);
    assert.match(refusal(swap(trip(), BDEF, "  draft action Discard;\n", "")), /a draft root declares draft action Discard/);
    assert.match(refusal(swap(trip(), BDEF, "draft action Resume;", "draft action Resume with additional implementation;")), /with additional implementation is outside R8/);
    assert.match(refusal(swap(trip(), BDEF, "draft action Edit;", "draft action ( features : instance ) Edit;")), /draft action options \(features : instance\) are outside R8/);
    assert.match(refusal(swap(trip(), BDEF, "with draft;", "with collaborative draft;")), /with collaborative draft is outside R8/);
    assert.match(refusal(swap(trip(), BDEF, "association _Trip { with draft; }", "association _Trip;")), /declared \{ with draft; \}/);
    assert.match(refusal(swap(trip(), BDEF, "with draft;\n", "")), /in a behavior definition without with draft/);
  });
});

describe("RAP R8 draft over OData V4", function () {
  this.timeout(120000);
  let server;
  before(async () => {
    server = startServer(true);
    for (let i = 0; i < 600; i++) {
      try {
        if ((await fetch(`${v4}/$metadata`)).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
  });
  after(() => server.close());

  const get = url => call(url, {headers: {accept: "application/json"}});
  const key = (id, active) => `(trip_uuid='${id}',IsActiveEntity=${active})`;
  const act = (id, active, action, body = "{}") => call(`${v4}/Trip${key(id, active)}/ZUI_RAP_DTRIP.${action}`,
    {method: "POST", headers: {...write, "if-match": "*"}, body});
  const newDraft = async (description) => {
    const res = await call(`${v4}/Trip`, {method: "POST", headers: write, body: JSON.stringify({description})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, false, "a POST to a draft root's set makes a draft");
    return res.body.trip_uuid;
  };

  it("$metadata: the key IsActiveEntity, the flags, the bound draft actions, DraftRoot on the set", async () => {
    const res = await call(`${v4}/$metadata`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<Key><PropertyRef Name="trip_uuid"\/><PropertyRef Name="IsActiveEntity"\/><\/Key>/);
    assert.match(res.body, /<Property Name="IsActiveEntity" Type="Edm.Boolean" Nullable="false"\/>/);
    assert.match(res.body, /<Property Name="HasActiveEntity" Type="Edm.Boolean"\/>/);
    assert.match(res.body, /<Action Name="Edit" IsBound="true" EntitySetPath="_it"><Parameter Name="_it" Type="ZUI_RAP_DTRIP.TripType" Nullable="false"\/><Parameter Name="PreserveChanges" Type="Edm.Boolean"\/>/);
    assert.match(res.body, /<Action Name="Activate" IsBound="true"/);
    assert.match(res.body, /<Annotations[^>]*Target="ZUI_RAP_DTRIP.Container\/Trip">\s*<Annotation Term="com.sap.vocabularies.Common.v1.DraftRoot">\s*<Record Type="com.sap.vocabularies.Common.v1.DraftRootType">\s*<PropertyValue Property="ActivationAction" String="ZUI_RAP_DTRIP.Activate"\/>\s*<PropertyValue Property="EditAction" String="ZUI_RAP_DTRIP.Edit"\/>\s*<PropertyValue Property="PreparationAction" String="ZUI_RAP_DTRIP.Prepare"\/>/);
    assert.match(res.body, /Target="ZUI_RAP_DTRIP.Container\/Leg">\s*<Annotation Term="com.sap.vocabularies.Common.v1.DraftNode">/);
  });

  it("creates a draft, a draft child below it, changes it, prepares and activates it", async () => {
    const id = await newDraft("Alps");
    let res = await get(`${v4}/Trip${key(id, false)}`);
    assert.equal(res.status, 200);
    assert.deepEqual([res.body.status, res.body.IsActiveEntity, res.body.HasActiveEntity, res.body.HasDraftEntity], ["N", false, false, false]);
    assert.equal((await get(`${v4}/Trip${key(id, true)}`)).status, 404, "no active instance yet");
    res = await call(`${v4}/Trip${key(id, false)}/to_Legs`, {method: "POST", headers: write, body: JSON.stringify({destination: "Zermatt"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, false, "a child of a draft is a draft");
    res = await call(`${v4}/Trip${key(id, false)}`, {method: "PATCH", headers: {...write, "if-match": "*"}, body: JSON.stringify({description: "Alps and lakes"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    res = await act(id, false, "Prepare");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    res = await act(id, false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.trip_uuid, res.body.IsActiveEntity, res.body.description], [id, true, "Alps and lakes"]);
    assert.ok(res.body.last_changed_at > 0, "the total ETag is stamped on the active instance");
    assert.equal((await get(`${v4}/Trip${key(id, false)}`)).status, 404, "the draft is gone");
    res = await get(`${v4}/Trip${key(id, true)}/to_Legs`);
    assert.deepEqual(res.body.value.map(l => [l.destination, l.IsActiveEntity]), [["Zermatt", true]]);
  });

  it("refuses to activate a draft whose validation fails (Prepare says so first); the draft stays", async () => {
    const id = await newDraft("INVALID plan");
    let res = await act(id, false, "Prepare");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.message, /may not say INVALID/);
    res = await act(id, false, "Activate");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((await get(`${v4}/Trip${key(id, false)}`)).status, 200, "the draft stays");
    assert.equal((await get(`${v4}/Trip${key(id, true)}`)).status, 404);
  });

  it("edits an active instance: the draft holds it, the list shows each instance once, Discard deletes the draft", async () => {
    const id = await newDraft("Coast");
    assert.equal((await act(id, false, "Activate")).status, 200);
    let res = await act(id, true, "Edit", JSON.stringify({PreserveChanges: true}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.IsActiveEntity, res.body.HasActiveEntity], [false, true]);
    assert.equal((await act(id, true, "Edit", JSON.stringify({PreserveChanges: true}))).status, 400, "one draft per instance");
    res = await call(`${v4}/Trip${key(id, true)}`, {method: "PATCH", headers: {...write, "if-match": "*"}, body: JSON.stringify({description: "x"})});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.message, /has a draft/);
    // the list report's "All": each instance once, its draft when it has one
    res = await get(`${v4}/Trip?$filter=${LATEST}&$count=true`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const mine = res.body.value.filter(t => t.trip_uuid === id);
    assert.deepEqual(mine.map(t => t.IsActiveEntity), [false]);
    assert.equal(res.body["@odata.count"], res.body.value.length);
    // without it, both versions, the active one with HasDraftEntity
    res = await get(`${v4}/Trip?$filter=trip_uuid eq '${id}'`);
    assert.deepEqual(res.body.value.map(t => [t.IsActiveEntity, t.HasDraftEntity, t.HasActiveEntity]), [[true, true, false], [false, false, true]]);
    res = await get(`${v4}/Trip?$filter=trip_uuid eq '${id}' and IsActiveEntity eq false`);
    assert.deepEqual(res.body.value.map(t => t.IsActiveEntity), [false]);
    // Fiori Elements V4 discards by deleting the draft root
    res = await call(`${v4}/Trip${key(id, false)}`, {method: "DELETE", headers: {...write, "if-match": "*"}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    res = await get(`${v4}/Trip?$filter=trip_uuid eq '${id}'`);
    assert.deepEqual(res.body.value.map(t => [t.IsActiveEntity, t.HasDraftEntity, t.description]), [[true, false, "Coast"]]);
  });

  it("knows an active instance has a draft whether or not the draft matches the filter (critic W2 on #913)", async () => {
    const id = await newDraft("Coast W2");
    assert.equal((await act(id, false, "Activate")).status, 200);
    assert.equal((await act(id, true, "Edit", JSON.stringify({PreserveChanges: true}))).status, 200);
    assert.equal((await call(`${v4}/Trip${key(id, false)}`, {method: "PATCH", headers: {...write, "if-match": "*"},
      body: JSON.stringify({description: "Coast W2 changed"})})).status, 204);
    // only the active instance matches; it still has its draft
    let res = await get(`${v4}/Trip?$filter=${encodeURIComponent("description eq 'Coast W2'")}`);
    assert.deepEqual(res.body.value.map(t => [t.IsActiveEntity, t.HasDraftEntity]), [[true, true]]);
    // the list shows the draft in its place, and the draft does not match
    res = await get(`${v4}/Trip?$filter=${LATEST_AND("description eq 'Coast W2'")}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.value, []);
    res = await get(`${v4}/Trip?$filter=${LATEST_AND("description eq 'Coast W2 changed'")}`);
    assert.deepEqual(res.body.value.map(t => [t.IsActiveEntity, t.description]), [[false, "Coast W2 changed"]]);
    assert.equal((await call(`${v4}/Trip${key(id, false)}`, {method: "DELETE", headers: {...write, "if-match": "*"}})).status, 204);
  });

  it("takes the list filter in its own spelling only, and refuses other SiblingEntity filters (501)", async () => {
    const latest = "IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null";
    // SiblingEntity/IsActiveEntity eq null alone is an Editing Status condition since R9 (test/rap-r9.mjs)
    for (const filter of [latest.replace("SiblingEntity", "siblingentity"), `description ne 'x' and ${latest}`,
      `(${latest}) or description eq 'x'`]) {
      const res = await get(`${v4}/Trip?$filter=${encodeURIComponent(filter)}`);
      assert.equal(res.status, 501, `${filter}: ${JSON.stringify(res.body)}`);
    }
    assert.equal((await get(`${v4}/Trip?$filter=${encodeURIComponent(`description ne 'x' and (${latest})`)}`)).status, 200);
    // in the middle of two others: the AND on one side of it goes with it
    const id = await newDraft("Middle W2");
    const res = await get(`${v4}/Trip?$filter=${encodeURIComponent(`description ne 'x' and (${latest}) and description eq 'Middle W2'`)}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.value.map(t => [t.trip_uuid, t.IsActiveEntity]), [[id, false]]);
    assert.equal((await call(`${v4}/Trip${key(id, false)}`, {method: "DELETE", headers: {...write, "if-match": "*"}})).status, 204);
  });

  it("edits, changes the draft and activates: the active instance takes the change", async () => {
    const id = await newDraft("Islands");
    assert.equal((await act(id, false, "Activate")).status, 200);
    assert.equal((await act(id, true, "Edit", JSON.stringify({PreserveChanges: true}))).status, 200);
    let res = await call(`${v4}/Trip${key(id, false)}`, {method: "PATCH", headers: {...write, "if-match": "*"}, body: JSON.stringify({description: "Islands by ferry"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await get(`${v4}/Trip${key(id, true)}`)).body.description, "Islands", "the active instance waits for Activate");
    res = await act(id, false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await get(`${v4}/Trip${key(id, true)}`)).body.description, "Islands by ferry");
  });

  it("serves the same instances over V2 with the version in the key", async () => {
    const id = await newDraft("Desert");
    const res = await get(`${v2}/Trip?$filter=trip_uuid eq '${id}'&$format=json`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.results.length, 1);
    assert.match(res.body.d.results[0].__metadata.uri, /Trip\(trip_uuid='[0-9A-F]{32}',IsActiveEntity=false\)$/);
  });
});
