// R10: the flight reference scenario's draft BOs (docs/rap-runtime.md, "R10")
// -- the supplement (/DMO/I_SUPPLEMENT under /DMO/C_SUPPLEMENT: use draft,
// field ( modify ) and the projection's augment writing the text child, path
// elements) and the agency (/DMO/R_AGENCYTP under /DMO/C_AGENCYTP: namespaced
// aliases, late numbering) -- generated from the fetched BDEFs and served
// over V4 (and V2 data requests), driven the way sap.fe drives a draft:
// create a draft, change it, Prepare and Activate, Edit, Discard. The first
// half needs only the generators (and the pack's fetched sources, else it
// skips); the second a transpiled tree with the pack. The runtime half is
// ZCL_OSD_RAPFLIGHT_R10_TEST.
import assert from "node:assert/strict";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {lowerDerived} from "../tools/rap/lower-derived.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";
import {startServer} from "./start.mjs";

const PACK = "packs/rap-flight";
const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const S = "%2FDMO%2FUI_SUPPLEMENT", A = "%2FDMO%2FUI_AGENCY";
const v4s = `${origin}/sap/opu/odata4/sap/${S}`, v4a = `${origin}/sap/opu/odata4/sap/${A}`;
const v2s = `${origin}/sap/opu/odata/sap/${S}`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json", "if-match": "*"};
const json = {accept: "application/json"};

async function call(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body};
}

// the files the build hands bdef-gen: the pack's layers over src/ and the
// libraries' DDIC
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

describe("RAP R10 the flight's draft BOs (generators)", function () {
  this.timeout(120000);
  let out;
  before(function () {
    if (!existsSync(join(PACK, "upstream"))) this.skip();
    const {files, deps} = inputs();
    out = generate(files, deps);
  });
  const plan = root => out.plans.find(p => p.root === root);
  const flight = () => out.plans.filter(p => /^\/DMO\/(I|C)_SUPPLEMENT$|^\/DMO\/(R|C)_AGENCYTP$/.test(p.root));
  const iface = root => out.outputs[`${plan(root).iface}.intf.abap`];

  it("types a namespaced alias as a response component, and MAPPED LATE of the late-numbered agency", () => {
    const t = iface("/DMO/R_AGENCYTP");
    assert.match(t, /TYPES: BEGIN OF r_failed,\n\s+\/dmo\/agency TYPE t_e0_failed,/);
    assert.match(t, /INCLUDE TYPE e0_key AS %key\.\n {2}TYPES %pid TYPE x LENGTH 16\./, "%pid in %pky");
    assert.match(t, /TYPES BEGIN OF e0_mapped_late\.\n {2}INCLUDE TYPE e0_pre AS %pre\.\n {2}INCLUDE TYPE e0_key AS %key\./);
    assert.match(t, /BEGIN OF e0_pre,\n\s+%pid TYPE x LENGTH 16,\n\s+%tmp TYPE e0_key,/);
    assert.match(t, /BEGIN OF r_mapped_late,\n\s+\/dmo\/agency TYPE t_e0_mapped_late,/);
    assert.equal(out.bindings["RESPONSE FOR MAPPED LATE /DMO/R_AGENCYTP"], `${plan("/DMO/R_AGENCYTP").iface}=>r_mapped_late`);
    assert.equal(out.bindings["RESPONSE FOR MAPPED EARLY /DMO/R_AGENCYTP"], `${plan("/DMO/R_AGENCYTP").iface}=>r_mapped`);
  });

  it("lowers the saver's adjust_numbers REDEFINITION to MAPPED LATE and REPORTED", () => {
    const src = readFileSync(join(PACK, "src", "#dmo#bp_r_agencytp.clas.locals_imp.abap"), "utf8");
    const lowered = lowerDerived(src, "#dmo#bp_r_agencytp.clas.locals_imp.abap", out.bindings);
    const ifc = plan("/DMO/R_AGENCYTP").iface;
    assert.match(lowered, new RegExp(`METHODS adjust_numbers CHANGING mapped TYPE ${ifc}=>r_mapped_late reported TYPE ${ifc}=>r_reported`));
  });

  it("writes the late numbering into the model, and the saver that draws it", () => {
    const gen = runtimeOutputs(flight(), pools(["#dmo#bp_r_agencytp", "#dmo#bp_i_supplement", "#dmo#bp_c_supplement"]));
    const cls = gen[`${plan("/DMO/R_AGENCYTP").iface.replace(/^zif_/, "zcl_")}.clas.abap`];
    assert.match(cls, /ls_entity-numbering = 'L'\./);
    assert.match(cls, /ls_saver-adjust = abap_true\./);
    assert.match(cls, /CALL METHOD io_saver->\('ADJUST_NUMBERS'\)/);
    assert.match(cls, /WHEN 'MAPPED LATE'\./);
  });

  it("serves a projection of a draft BO from a union of its own, with its augment and its calculated elements", () => {
    const gen = runtimeOutputs(flight(), pools(["#dmo#bp_r_agencytp", "#dmo#bp_i_supplement", "#dmo#bp_c_supplement"]));
    const c = plan("/DMO/C_SUPPLEMENT");
    const cls = c.iface.replace(/^zif_/, "zcl_");
    const union = gen[`${cls}_d0.clas.abap`];
    assert.ok(union, "the projection's union class");
    assert.match(union, /INCLUDE TYPE \/dmo\/c_supplement\./);
    assert.match(union, /supplementdescription TYPE /, "the path element is a component of the row");
    assert.match(union, /FROM \/dmo\/suppl_d /, "the base's draft table");
    const augment = gen[`${cls}.clas.abap`];
    assert.match(augment, /INTERFACES zif_osd_rap_augment\./);
    assert.match(augment, /CALL METHOD lo_handler->\('AUGMENT'\)/);
    assert.match(augment, /entities_create = lt_create_e0/);
    const registry = gen["zcl_osd_rap_registry.clas.abap"];
    assert.match(registry, /WHEN '\/DMO\/C_SUPPLEMENT'\.[\s\S]*?APPEND 'SUPPLEMENTDESCRIPTION' TO rs_projection-modify\.[\s\S]*?rs_projection-union = 'ZCL_RAP_\w+_D0'\.[\s\S]*?rs_projection-augment = 'ZCL_RAP_\w+'\./);
    assert.match(registry, /APPEND 'SUPPLEMENTCATEGORYTEXT' TO rs_projection-readonly\./, "a calculated element without modify is read-only");
  });

  it("serves the projections as draft roots: IsActiveEntity, the draft actions bound, Discard as DELETE", () => {
    const yaml = out.outputs["#dmo#ui_supplement.stg.yaml"];
    assert.match(yaml, /keys: \[SupplementID, IsActiveEntity\]/);
    assert.match(yaml, /struct: "ZCL_RAP_\w+_D0=>TY_ROW"/);
    assert.match(yaml, /SupplementDescription: \{type: String, field: SUPPLEMENTDESCRIPTION, label/, "field ( modify ): not read-only");
    assert.match(yaml, /SupplementCategoryText: \{type: String, field: SUPPLEMENTCATEGORYTEXT, readonly: true/);
    assert.match(yaml, /draftRoot: \{set: Supplement, activation: \/DMO\/UI_SUPPLEMENT\.Activate/);
    assert.doesNotMatch(yaml, /^ {2}Discard:/m);
    const agency = out.outputs["#dmo#ui_agency.stg.yaml"];
    assert.match(agency, /keys: \[AgencyID, IsActiveEntity\]/);
    assert.match(agency, /Attachment: \{type: Binary/);
  });
});

describe("RAP R10 the flight's draft BOs over OData V4", function () {
  this.timeout(300000);
  let server;
  before(async function () {
    if (!existsSync(join(PACK, "upstream"))) this.skip();
    server = startServer(true);
    for (let i = 0; i < 1200; i++) {
      try {
        if ((await fetch(`${v4s}/$metadata`)).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
  });
  after(() => server?.close());

  const sKey = (id, active) => `(SupplementID='${id}',IsActiveEntity=${active})`;
  const aKey = (id, active) => `(AgencyID='${id}',IsActiveEntity=${active})`;
  const sAct = (id, active, action, body = "{}") => call(`${v4s}/Supplement${sKey(id, active)}/${S}.${action}`, {method: "POST", headers: write, body});
  const aAct = (id, active, action, body = "{}") => call(`${v4a}/Agency${aKey(id, active)}/${A}.${action}`, {method: "POST", headers: write, body});
  const get = url => call(url, {headers: json});

  it("$metadata: the projection's key, the draft actions, its calculated elements", async () => {
    const res = await call(`${v4s}/$metadata`);
    assert.equal(res.status, 200);
    assert.match(res.body, /<PropertyRef Name="IsActiveEntity"\/>/);
    assert.match(res.body, /<Property Name="SupplementDescription"/);
    assert.match(res.body, /<Action Name="Activate" IsBound="true"/);
    assert.match(res.body, /Common\.v1\.DraftRoot/);
  });

  it("creates a supplement draft with its description (augment), changes it, activates it", async () => {
    let res = await call(`${v4s}/Supplement`, {method: "POST", headers: write,
      body: JSON.stringify({SupplementCategory: "ML", Price: 3.5, CurrencyCode: "EUR", SupplementDescription: "R10 snack"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.SupplementID;
    assert.match(id, /^ML-\d{4}$/, "the pool's early numbering");
    assert.equal(res.body.IsActiveEntity, false);
    res = await get(`${v4s}/Supplement${sKey(id, false)}`);
    assert.equal(res.body.SupplementDescription, "R10 snack", "the augment created the draft's text, the path element reads it");
    res = await call(`${v4s}/Supplement${sKey(id, false)}`, {method: "PATCH", headers: write, body: JSON.stringify({SupplementDescription: "R10 meal"})});
    assert.ok([200, 204].includes(res.status), JSON.stringify(res.body));
    assert.equal((await get(`${v4s}/Supplement${sKey(id, false)}`)).body.SupplementDescription, "R10 meal", "the augment updated the draft text");
    assert.equal((await sAct(id, false, "Prepare")).status, 200);
    res = await sAct(id, false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, true);
    res = await get(`${v4s}/Supplement${sKey(id, true)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.SupplementDescription, "R10 meal", "the text was activated with the supplement");
    assert.equal(res.body.Price, 3.5);
    assert.equal((await get(`${v4s}/Supplement${sKey(id, false)}`)).status, 404, "the draft is gone");
  });

  it("refuses to activate a supplement draft without a price (validatePrice); the draft stays", async () => {
    let res = await call(`${v4s}/Supplement`, {method: "POST", headers: write,
      body: JSON.stringify({SupplementCategory: "ML", CurrencyCode: "EUR", SupplementDescription: "R10 free"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.SupplementID;
    res = await sAct(id, false, "Activate");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((await get(`${v4s}/Supplement${sKey(id, false)}`)).status, 200);
    assert.equal((await call(`${v4s}/Supplement${sKey(id, false)}`, {method: "DELETE", headers: write})).status, 204, "Discard");
    assert.equal((await get(`${v4s}/Supplement${sKey(id, false)}`)).status, 404);
  });

  it("edits an active supplement, changes the draft, discards it: the active one is unchanged", async () => {
    const list = await get(`${v4s}/Supplement?$filter=IsActiveEntity eq true and HasDraftEntity eq false&$top=1`);
    assert.equal(list.status, 200, JSON.stringify(list.body));
    const s = list.body.value[0];
    let res = await sAct(s.SupplementID, true, "Edit", JSON.stringify({PreserveChanges: true}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.IsActiveEntity, false);
    res = await call(`${v4s}/Supplement${sKey(s.SupplementID, false)}`, {method: "PATCH", headers: write, body: JSON.stringify({Price: 999})});
    assert.ok([200, 204].includes(res.status), JSON.stringify(res.body));
    res = await get(`${v4s}/Supplement?$filter=(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null) and SupplementID eq '${s.SupplementID}'`);
    assert.deepEqual(res.body.value.map(v => [v.IsActiveEntity, v.Price]), [[false, 999]], "the list shows the draft in place of the active one");
    assert.equal((await call(`${v4s}/Supplement${sKey(s.SupplementID, false)}`, {method: "DELETE", headers: write})).status, 204);
    assert.equal((await get(`${v4s}/Supplement${sKey(s.SupplementID, true)}`)).body.Price, s.Price);
  });

  it("serves the supplements over V2 with the version in the key", async () => {
    const res = await get(`${v2s}/Supplement?$top=2&$format=json`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.results.length, 2);
    assert.ok("IsActiveEntity" in res.body.d.results[0]);
  });

  it("creates an agency draft under a preliminary key; Activate answers the final one (late numbering)", async () => {
    const before = (await get(`${v4a}/Agency?$filter=IsActiveEntity eq true&$orderby=AgencyID desc&$top=1`)).body.value[0];
    let res = await call(`${v4a}/Agency`, {method: "POST", headers: write,
      body: JSON.stringify({Name: "R10 agency", CountryCode: before.CountryCode, EMailAddress: "r10@agency.example"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const pre = res.body.AgencyID;
    assert.match(pre, /^9999\d\d$/, "the preliminary key, from the top of the range");
    res = await call(`${v4a}/Agency${aKey(pre, false)}`, {method: "PATCH", headers: write, body: JSON.stringify({City: "Walldorf"})});
    assert.ok([200, 204].includes(res.status), JSON.stringify(res.body));
    assert.equal((await aAct(pre, false, "Prepare")).status, 200);
    res = await aAct(pre, false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const final = String(Number(before.AgencyID) + 1).padStart(6, "0");
    assert.equal(res.body.AgencyID, final, "adjust_numbers drew the highest saved + 1");
    assert.equal(res.body.IsActiveEntity, true);
    res = await get(`${v4a}/Agency${aKey(final, true)}`);
    assert.equal(res.status, 200);
    assert.equal(res.body.City, "Walldorf");
    assert.equal((await get(`${v4a}/Agency${aKey(pre, false)}`)).status, 404, "the draft is gone");
  });

  it("refuses to activate an agency whose e-mail address the validation refuses; discards it", async () => {
    const any = (await get(`${v4a}/Agency?$filter=IsActiveEntity eq true&$top=1`)).body.value[0];
    let res = await call(`${v4a}/Agency`, {method: "POST", headers: write,
      body: JSON.stringify({Name: "R10 bad", CountryCode: any.CountryCode, EMailAddress: "no-at-sign"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const pre = res.body.AgencyID;
    res = await aAct(pre, false, "Activate");
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal((await call(`${v4a}/Agency${aKey(pre, false)}`, {method: "DELETE", headers: write})).status, 204);
  });
});
