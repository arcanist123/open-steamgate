// R9: draft for a real Fiori Elements V4 app, on the trip demo of src/rap_r8
// (docs/rap-runtime.md, "R9"): the SiblingEntity and DraftAdministrativeData
// navigations, the admin data served from ZOSD_DRAFT_ADM, Core.Computed on
// what the client may not set, the owner of a draft (InProcessByUser: another
// user is refused, the owner goes on, nobody else sees the draft) and the
// "Editing Status" filters. The requests below are the ones SAPUI5 1.120's
// sap.fe sends (captured from webapp/trip4, listed in the doc). Needs a
// transpiled tree (npm run transpile); the app itself is
// test/e2e/trip4.spec.mjs, the runtime half ZCL_OSD_RAP_R9_TEST.
import assert from "node:assert/strict";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_DTRIP`;
// a request's user is the user name of its Basic credential (src/logon);
// the password is not checked
const as = user => ({authorization: `Basic ${Buffer.from(`${user}:any`).toString("base64")}`});
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json", "if-match": "*"};
const ADMIN = "DraftAdministrativeData($select=DraftIsCreatedByMe,DraftUUID,InProcessByUser)";
const SELECT = "HasActiveEntity,HasDraftEntity,IsActiveEntity,description,status,trip_uuid";
// the Editing Status values of the list report's filter bar, as sap.fe spells them
const STATUS = {
  all: "(IsActiveEntity eq false or SiblingEntity/IsActiveEntity eq null)",
  hidingDrafts: "IsActiveEntity eq true",
  unchanged: "IsActiveEntity eq true and HasDraftEntity eq false",
  ownDraft: "IsActiveEntity eq false",
  lockedByOther: "IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser ne '' and DraftAdministrativeData/InProcessByUser ne null",
  unsavedByOther: "IsActiveEntity eq true and SiblingEntity/IsActiveEntity eq null and DraftAdministrativeData/InProcessByUser eq ''",
};

async function call(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body};
}

describe("RAP R9 draft for Fiori Elements V4", function () {
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

  const key = (id, active) => `(trip_uuid='${id}',IsActiveEntity=${active})`;
  const get = (path, user = "alice") => call(`${v4}/${path}`, {headers: {accept: "application/json", ...as(user)}});
  const act = (id, active, action, user = "alice", body = "{}") => call(`${v4}/Trip${key(id, active)}/ZUI_RAP_DTRIP.${action}`,
    {method: "POST", headers: {...write, ...as(user)}, body});
  const patch = (id, description, user = "alice") => call(`${v4}/Trip${key(id, false)}`,
    {method: "PATCH", headers: {...write, ...as(user)}, body: JSON.stringify({description})});
  const discard = (id, user = "alice") => call(`${v4}/Trip${key(id, false)}`, {method: "DELETE", headers: {...write, ...as(user)}});
  const newDraft = async (description, user = "alice") => {
    const res = await call(`${v4}/Trip`, {method: "POST", headers: {...write, ...as(user)}, body: JSON.stringify({description})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.trip_uuid;
  };
  // an active trip of alice's, and (edit) her draft of it
  const activeTrip = async (description, edit = false) => {
    const id = await newDraft(description);
    assert.equal((await act(id, false, "Activate")).status, 200);
    if (edit) assert.equal((await act(id, true, "Edit", "alice", JSON.stringify({PreserveChanges: true}))).status, 200);
    return id;
  };
  const list = async (status, user, extra) => {
    const filter = extra ? `${status} and ${extra}` : status;
    const res = await get(`Trip?$count=true&$filter=${encodeURIComponent(filter)}&$select=${SELECT}&$expand=${ADMIN}`, user);
    assert.equal(res.status, 200, `${filter}: ${JSON.stringify(res.body)}`);
    return res.body.value;
  };

  it("$metadata: SiblingEntity, DraftAdministrativeData and its type, Core.Computed on what the client may not set", async () => {
    const {status, body} = await call(`${v4}/$metadata`);
    assert.equal(status, 200);
    assert.match(body, /<NavigationProperty Name="SiblingEntity" Type="ZUI_RAP_DTRIP.TripType"\/>/, "nullable, no partner of itself");
    assert.match(body, /<NavigationProperty Name="DraftAdministrativeData" Type="ZUI_RAP_DTRIP.DraftAdministrativeDataType"\/>/);
    assert.match(body, /<NavigationProperty Name="SiblingEntity" Type="ZUI_RAP_DTRIP.LegType"\/>/);
    assert.match(body, /<EntityType Name="DraftAdministrativeDataType"><Key><PropertyRef Name="DraftUUID"\/><\/Key>/);
    for (const p of ["InProcessByUser", "CreatedByUser", "LastChangedByUser", "InProcessByUserDescription"]) assert.match(body, new RegExp(`<Property Name="${p}" Type="Edm.String"`), p);
    for (const p of ["DraftIsCreatedByMe", "DraftIsProcessedByMe", "DraftIsLastChangedByMe"]) assert.match(body, new RegExp(`<Property Name="${p}" Type="Edm.Boolean"`), p);
    assert.match(body, /<Property Name="LastChangeDateTime" Type="Edm.DateTimeOffset"/);
    assert.match(body, /<EntitySet Name="Trip" EntityType="ZUI_RAP_DTRIP.TripType">.*?<NavigationPropertyBinding Path="SiblingEntity" Target="Trip"\/><NavigationPropertyBinding Path="DraftAdministrativeData" Target="DraftAdministrativeData"\/>/);
    // the managed key and the draft flags: sap.fe asks for no key when it creates a draft
    for (const p of ["trip_uuid", "IsActiveEntity", "HasDraftEntity", "status"]) {
      assert.match(body, new RegExp(`<Annotations Target="ZUI_RAP_DTRIP.TripType/${p}"><Annotation Term="Core.Computed" Bool="true"/></Annotations>`), p);
    }
    assert.doesNotMatch(body, /TripType\/description"><Annotation Term="Core.Computed"/);
  });

  it("the requests sap.fe sends on the object page: the draft with its admin data, the legs", async () => {
    const id = await newDraft("Fjords");
    let res = await get(`Trip${key(id, false)}?$select=${SELECT}&$expand=${ADMIN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.DraftAdministrativeData, {DraftIsCreatedByMe: true, DraftUUID: res.body.DraftAdministrativeData.DraftUUID, InProcessByUser: "ALICE"});
    assert.match(res.body.DraftAdministrativeData.DraftUUID, /^[0-9A-F]{32}$/);
    // after Activate sap.fe asks again, with the navigation in $select
    res = await act(id, false, "Activate");
    assert.equal(res.status, 200);
    res = await get(`Trip${key(id, true)}?$select=DraftAdministrativeData&$expand=${ADMIN}`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.DraftAdministrativeData, null, "an active instance without a draft has none");
    res = await get(`Trip${key(id, true)}/to_Legs?$count=true&$select=HasActiveEntity,IsActiveEntity,destination,leg_uuid&$skip=0&$top=10`);
    assert.equal(res.status, 200);
    assert.equal(res.body["@odata.count"], 0);
  });

  it("DraftAdministrativeData: read through the navigation, the admin row of the draft (also from its active instance)", async () => {
    const id = await activeTrip("Lakes", true);
    let res = await get(`Trip${key(id, false)}/DraftAdministrativeData`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.CreatedByUser, res.body.InProcessByUser, res.body.LastChangedByUser, res.body.DraftEntityType],
      ["ALICE", "ALICE", "ALICE", "ZI_RAP_DTRIP"]);
    assert.deepEqual([res.body.InProcessByUserDescription, res.body.DraftIsProcessedByMe, res.body.DraftIsLastChangedByMe], ["ALICE", true, true]);
    assert.match(res.body.LastChangeDateTime, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/);
    const draftUuid = res.body.DraftUUID;
    res = await get(`Trip${key(id, true)}/DraftAdministrativeData`);
    assert.equal(res.body.DraftUUID, draftUuid, "the active instance names its draft's admin data");
    res = await get(`DraftAdministrativeData('${draftUuid}')`, "bob");
    assert.deepEqual([res.status, res.body.InProcessByUser, res.body.DraftIsProcessedByMe, res.body.DraftIsCreatedByMe], [200, "ALICE", false, false]);
    assert.equal((await discard(id)).status, 204);
    assert.equal((await get(`Trip${key(id, true)}/DraftAdministrativeData`)).status, 204, "no draft, no admin data");
  });

  it("SiblingEntity: the other version, as sap.fe reads it before it discards; nothing when there is none", async () => {
    const id = await activeTrip("Coast", true);
    let res = await get(`Trip${key(id, false)}/SiblingEntity`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.trip_uuid, res.body.IsActiveEntity, res.body.HasDraftEntity], [id, true, true]);
    res = await get(`Trip${key(id, true)}/SiblingEntity`);
    assert.deepEqual([res.body.IsActiveEntity, res.body.HasActiveEntity], [false, true]);
    res = await get(`Trip${key(id, true)}?$expand=SiblingEntity($select=IsActiveEntity)&$select=trip_uuid`);
    assert.equal(res.body.SiblingEntity.IsActiveEntity, false);
    assert.equal((await discard(id)).status, 204);
    assert.equal((await get(`Trip${key(id, true)}/SiblingEntity`)).status, 204);
    const fresh = await newDraft("New");
    assert.equal((await get(`Trip${key(fresh, false)}/SiblingEntity`)).status, 204, "a new draft has no active instance");
    assert.equal((await discard(fresh)).status, 204);
  });

  it("the owner: another user does not see the draft, cannot change, activate, discard or edit it; the owner goes on", async () => {
    const id = await activeTrip("Owned", true);
    assert.equal((await get(`Trip${key(id, false)}`, "bob")).status, 404, "another user's draft is not served");
    assert.equal((await get(`Trip${key(id, true)}/SiblingEntity`, "bob")).status, 204, "nor reached from the active instance");
    for (const res of [await patch(id, "Bob was here", "bob"), await act(id, false, "Activate", "bob"),
      await act(id, false, "Prepare", "bob"), await discard(id, "bob")]) {
      assert.equal(res.status, 404, JSON.stringify(res.body));
    }
    let res = await act(id, true, "Edit", "bob", JSON.stringify({PreserveChanges: true}));
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.message, /locked by user ALICE/);
    res = await get(`Trip${key(id, true)}?$select=HasDraftEntity&$expand=${ADMIN}`, "bob");
    assert.deepEqual([res.body.HasDraftEntity, res.body.DraftAdministrativeData.InProcessByUser, res.body.DraftAdministrativeData.DraftIsCreatedByMe],
      [true, "ALICE", false], "bob sees who holds it");
    // without a credential the request is the system's own user, not ALICE
    res = await call(`${v4}/Trip${key(id, false)}`, {method: "PATCH", headers: write, body: JSON.stringify({description: "x"})});
    assert.equal(res.status, 404);
    // the owner resumes and saves
    assert.equal((await patch(id, "Owned and changed")).status, 204);
    assert.equal((await act(id, false, "Resume")).status, 200);
    res = await act(id, false, "Activate");
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.description, "Owned and changed");
    // and the instance is free again for bob
    res = await act(id, true, "Edit", "bob", JSON.stringify({PreserveChanges: true}));
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal((await get(`Trip${key(id, false)}/DraftAdministrativeData`, "bob")).body.InProcessByUser, "BOB");
    assert.equal((await discard(id, "bob")).status, 204);
  });

  it("the Editing Status filters, for the owner and for another user", async () => {
    const tag = `F${Date.now()}`;
    const plain = await activeTrip(`${tag} plain`);
    const edited = await activeTrip(`${tag} edited`, true);
    const fresh = await newDraft(`${tag} new`);
    const only = `startswith(description,'${tag}')`;
    const rows = async (status, user) => (await list(status, user, only))
      .map(t => [t.description.slice(tag.length + 1), t.IsActiveEntity]).sort();
    // alice: her two drafts in place of what they edit
    assert.deepEqual(await rows(STATUS.all, "alice"), [["edited", false], ["new", false], ["plain", true]]);
    assert.deepEqual(await rows(STATUS.ownDraft, "alice"), [["edited", false], ["new", false]]);
    assert.deepEqual(await rows(STATUS.hidingDrafts, "alice"), [["edited", true], ["plain", true]]);
    assert.deepEqual(await rows(STATUS.unchanged, "alice"), [["plain", true]]);
    assert.deepEqual(await rows(STATUS.lockedByOther, "alice"), []);
    assert.deepEqual(await rows(STATUS.unsavedByOther, "alice"), []);
    // bob: no drafts of his, alice's edit locks the active instance
    assert.deepEqual(await rows(STATUS.all, "bob"), [["edited", true], ["plain", true]]);
    assert.deepEqual(await rows(STATUS.ownDraft, "bob"), []);
    assert.deepEqual(await rows(STATUS.lockedByOther, "bob"), [["edited", true]]);
    assert.deepEqual(await rows(STATUS.unchanged, "bob"), [["plain", true]]);
    // no expiry here: a held draft never becomes "unsaved changes"
    assert.deepEqual(await rows(STATUS.unsavedByOther, "bob"), []);
    const locked = (await list(STATUS.lockedByOther, "bob", only))[0];
    assert.equal(locked.DraftAdministrativeData.InProcessByUser, "ALICE");
    // the same conditions inside parentheses AND-ed with another field
    const res = await get(`Trip?$filter=${encodeURIComponent(`(${STATUS.lockedByOther}) and (${only})`)}`, "bob");
    assert.deepEqual(res.body.value.map(t => t.trip_uuid), [edited]);
    for (const id of [edited, fresh]) assert.equal((await discard(id)).status, 204);
    assert.ok(plain);
  });

  it("a navigation from a source that is not there, or is another user's draft, is 404 (critic MUST 2 on #915)", async () => {
    const fresh = await newDraft("Only a draft");
    for (const nav of ["SiblingEntity", "DraftAdministrativeData"]) {
      assert.equal((await get(`Trip${key(fresh, true)}/${nav}`)).status, 404, `no active instance: ${nav}`);
      assert.equal((await get(`Trip${key(fresh, false)}/${nav}`, "bob")).status, 404, `another user's draft: ${nav}`);
    }
    assert.equal((await get(`Trip${key(fresh, false)}/SiblingEntity`)).status, 204, "the owner's draft without an active instance");
    assert.equal((await get(`Trip${key(fresh, false)}/DraftAdministrativeData`)).status, 200);
    const id = await activeTrip("Held by alice", true);
    assert.equal((await get(`Trip${key(id, false)}/SiblingEntity`, "bob")).status, 404, "bob does not reach alice's draft's sibling");
    assert.equal((await get(`Trip${key(id, true)}/SiblingEntity`, "bob")).status, 204, "the active instance is there, its sibling is not bob's");
    for (const x of [fresh, id]) assert.equal((await discard(x)).status, 204);
  });

  it("keeps the blanks of a filter literal, with and without the draft conditions (critic MUST 1 on #915)", async () => {
    const text = `A  /  B ${Date.now()}`;
    const id = await newDraft(text);
    const ids = async (filter, user = "alice") => {
      const res = await get(`Trip?$filter=${encodeURIComponent(filter)}`, user);
      assert.equal(res.status, 200, `${filter}: ${JSON.stringify(res.body)}`);
      return res.body.value.map(t => t.trip_uuid);
    };
    assert.deepEqual(await ids(`description eq '${text}'`), [id]);
    assert.deepEqual(await ids(`${STATUS.all} and description eq '${text}'`), [id]);
    assert.deepEqual(await ids(`description eq '${text}' and ${STATUS.all}`), [id]);
    assert.deepEqual(await ids(`${STATUS.ownDraft} and description eq '${text}'`), [id]);
    assert.equal((await act(id, false, "Activate")).status, 200);
    assert.equal((await act(id, true, "Edit", "alice", JSON.stringify({PreserveChanges: true}))).status, 200);
    assert.deepEqual(await ids(`${STATUS.lockedByOther} and description eq '${text}'`, "bob"), [id]);
    assert.deepEqual(await ids(`(${STATUS.lockedByOther}) and (description eq '${text}')`, "bob"), [id]);
    assert.equal((await discard(id)).status, 204);
  });

  it("the request's user ends with the request: a call outside one is SY-UNAME again (critic on #915)", async () => {
    const abap = globalThis.abap;
    assert.ok(abap?.Classes?.ZCL_OSD_LOGON, "the server runs inline in this process");
    assert.equal((await get("Trip?$top=1", "bob")).status, 200);
    const user = String((await abap.Classes.ZCL_OSD_LOGON.user()).get()).trim();
    assert.equal(user, String(abap.builtin.sy.get().uname.get()).trim());
    assert.notEqual(user, "BOB");
  });

  it("refuses the draft navigations in a filter it cannot keep (501)", async () => {
    for (const filter of [
      "DraftAdministrativeData/InProcessByUser ne ''",
      "IsActiveEntity eq true or DraftAdministrativeData/InProcessByUser ne null",
      "DraftAdministrativeData/CreatedByUser eq 'ALICE'",
      "SiblingEntity/description eq 'x'",
    ]) {
      const res = await get(`Trip?$filter=${encodeURIComponent(filter)}`);
      assert.equal(res.status, 501, `${filter}: ${JSON.stringify(res.body)}`);
    }
  });
});
