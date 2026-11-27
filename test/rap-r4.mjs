// R4: the flight scenario's behavior constructs beside its compositions, on
// the trip demo of src/rap_r4 (docs/rap-runtime.md, "R4"): `etag master`
// served as the entity's ETag (428 / 412 on PATCH and on actions), instance
// features through a FOR INSTANCE FEATURES method (a disabled update,
// delete or action is refused), early numbering through a FOR NUMBERING
// method, the @Semantics administrative fields stamped by the runtime.
// The generator half runs without a build; the wire half needs a transpiled
// tree (npm run transpile).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs} from "../tools/rap/rap-runtime-gen.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_TRIP`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_TRIP`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const trip = () => walk("src/rap_r4").filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
  .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R4 constructs (generator)", () => {
  it("serves the etag master element as the entity type's ETag", () => {
    const yaml = generate(trip()).outputs["zui_rap_trip.stg.yaml"];
    assert.ok(yaml.split("\n").includes('      last_changed_at: {type: "Decimal(21,7)", field: LAST_CHANGED_AT, readonly: true, etag: true, label: "last_changed_at"}'), yaml);
    assert.equal(yaml.split("etag: true").length, 2, "one ETag property");
  });

  it("writes features, numbering and the administrative fields into the model", () => {
    const files = trip();
    const {plans} = generate(files);
    const outputs = runtimeOutputs(plans, files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename)));
    const adapter = Object.entries(outputs).find(([n, s]) => n.startsWith("zcl_rap_") && s.includes("ZI_RAP_TRIP"))[1];
    for (const text of [
      "ls_entity-etag = 'LAST_CHANGED_AT'.",
      "ls_entity-feat_update = abap_true.",
      "ls_entity-feat_delete = abap_true.",
      "ls_entity-numbering = 'E'.",
      "ls_entity-features = abap_true.",
      "ls_callable-features = abap_true.",
      "ls_field-admin = 'CREATED_BY'.",
      "ls_field-admin = 'LOCAL_CHANGED_AT'.",
      "WHEN 'ZI_RAP_TRIP~%FEATURES'.",
      "WHEN 'ZI_RAP_TRIP~%NUMBERING'.",
      "CALL METHOD io_handler->('GET_FEATURES')",
      "requested_features = ls_request",
      "CALL METHOD io_handler->('EARLYNUMBERING_CREATE')",
      "ls_request-%action-accept = if_abap_behv=>mk-on.",
    ]) assert.ok(adapter.includes(text), text);
  });
});

describe("RAP R4 constructs over OData", function () {
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

  const create = (description) => call(`${v2}/Trip`, {method: "POST", headers: write, body: JSON.stringify({description})});
  const read = async (id) => call(`${v2}/Trip('${id}')?$format=json`, {headers: {accept: "application/json"}});

  it("draws the key in the pool's FOR NUMBERING method and stamps the administrative fields", async () => {
    const a = await create("first trip");
    assert.equal(a.status, 201, JSON.stringify(a.body));
    const b = await create("second trip");
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.match(a.body.d.trip_id, /^\d{8}$/);
    assert.equal(Number(b.body.d.trip_id), Number(a.body.d.trip_id) + 1);
    assert.equal(a.body.d.status, "O", "the determination on create");
    assert.ok(Number(a.body.d.last_changed_at) > 0, "stamped on create");
    assert.ok(Number(b.body.d.last_changed_at) > Number(a.body.d.last_changed_at), "a later write has a later stamp");
    assert.notEqual(a.body.d.created_by.trim(), "");
  });

  it("answers the ETag and wants it back on V2: 428 without If-Match, 412 on a stale one", async () => {
    const id = (await create("etag trip")).body.d.trip_id;
    const one = await read(id);
    const etag = one.headers.get("etag");
    assert.match(etag ?? "", /^W\/"/, "ETag header");
    assert.equal(one.body.d.__metadata.etag, etag);
    let res = await call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: write, body: JSON.stringify({description: "no tag"})});
    assert.equal(res.status, 428, JSON.stringify(res.body));
    res = await call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: {...write, "if-match": 'W/"0"'}, body: JSON.stringify({description: "wrong tag"})});
    assert.equal(res.status, 412, JSON.stringify(res.body));
    res = await call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: {...write, "if-match": etag}, body: JSON.stringify({description: "right tag"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const after = await read(id);
    assert.equal(after.body.d.description, "right tag");
    assert.notEqual(after.headers.get("etag"), etag, "the write moved the ETag");
    // the old tag is stale now
    res = await call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: {...write, "if-match": etag}, body: JSON.stringify({description: "stale"})});
    assert.equal(res.status, 412);
    res = await call(`${v2}/Trip('${id}')`, {method: "DELETE", headers: write});
    assert.equal(res.status, 428);
  });

  // Two writes inside one millisecond: the runtime's stamps are 100 ns apart,
  // but the database seam writes a DEC(21,7) as a double, which resolves about
  // 4 ms at that size (ANOMALY-2026-10-08-dec-sqlite-real). Before the stamp
  // stepped past that, both writes stored the same value, the ETag did not
  // move, and a PATCH with the tag of the first write overwrote the second.
  // The clock is held still so the window is hit every time, not by chance.
  it("moves the ETag on every write, also two writes inside one millisecond (V2 and V4)", async () => {
    const id = (await create("same millisecond")).body.d.trip_id;
    const RealDate = Date;
    const still = RealDate.now();
    globalThis.Date = class extends RealDate {
      constructor(...args) { if (args.length) super(...args); else super(still); }
      static now() { return still; }
    };
    try {
      const tagV2 = async () => (await read(id)).headers.get("etag");
      const patchV2 = (tag, description) => call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({description})});
      const t0 = await tagV2();
      assert.equal((await patchV2(t0, "first")).status, 204);
      const t1 = await tagV2();
      assert.equal((await patchV2(t1, "second")).status, 204);
      const t2 = await tagV2();
      assert.notEqual(t1, t0, "the first write moved the ETag");
      assert.notEqual(t2, t1, "the second write moved the ETag");
      const stale = await patchV2(t1, "lost update");
      assert.equal(stale.status, 412, "the first write's tag is stale after the second");
      assert.equal((await read(id)).body.d.description, "second");

      const key = `${v4}/Trip('${id}')`;
      const tagV4 = async () => (await call(key)).body["@odata.etag"];
      const patchV4 = (tag, description) => call(key, {method: "PATCH", headers: {...write, "if-match": tag}, body: JSON.stringify({description})});
      const u0 = await tagV4();
      // each protocol its own form of the same value (M3 B3, option B): V2
      // writes the property's URI literal, as a system's V2 tag is (a one-
      // property tag; an Edm.Decimal literal ends in m), V4 the bare value
      assert.equal(t2, u0.replace(/"$/, 'm"'), "V2 and V4 name the same ETag value, each in its own form");
      assert.ok([200, 204].includes((await patchV4(u0, "third")).status));
      const u1 = await tagV4();
      assert.ok([200, 204].includes((await patchV4(u1, "fourth")).status));
      const u2 = await tagV4();
      assert.notEqual(u1, u0);
      assert.notEqual(u2, u1);
      assert.equal((await patchV4(u1, "lost update")).status, 412);
      assert.equal((await call(key)).body.description, "fourth");
    } finally {
      globalThis.Date = RealDate;
    }
  });

  it("refuses an operation the instance features disable, with the runtime's message", async () => {
    const id = (await create("features trip")).body.d.trip_id;
    const tagOf = async (key) => (await read(key)).headers.get("etag");
    const action = async (name, key) => call(`${v2}/${name}?trip_id='${key}'`, {method: "POST", headers: {...write, "if-match": await tagOf(key)}});
    let res = await action("accept", id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.status, "A");
    // accepted: no second accept, no delete
    res = await action("accept", id);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "Action ACCEPT of trip is disabled");
    let etag = (await read(id)).headers.get("etag");
    res = await call(`${v2}/Trip('${id}')`, {method: "DELETE", headers: {...write, "if-match": etag}});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "Delete of trip is disabled");
    assert.equal((await read(id)).status, 200);
    // an accepted trip may still be changed and rejected; a rejected one not changed
    res = await action("reject", id);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    etag = (await read(id)).headers.get("etag");
    res = await call(`${v2}/Trip('${id}')`, {method: "PATCH", headers: {...write, "if-match": etag}, body: JSON.stringify({description: "frozen"})});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "Update of trip is disabled");
    assert.equal((await read(id)).body.d.description, "features trip");
    // an open trip is deleted
    const open = (await create("deletable trip")).body.d.trip_id;
    etag = (await read(open)).headers.get("etag");
    res = await call(`${v2}/Trip('${open}')`, {method: "DELETE", headers: {...write, "if-match": etag}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await read(open)).status, 404);
  });

  it("wants If-Match on a V2 action of an entity with an ETag, also inside a changeset", async () => {
    const id = (await create("v2 action trip")).body.d.trip_id;
    const before = await read(id);
    let res = await call(`${v2}/accept?trip_id='${id}'`, {method: "POST", headers: write});
    assert.equal(res.status, 428, JSON.stringify(res.body));
    res = await call(`${v2}/accept?trip_id='${id}'`, {method: "POST", headers: {...write, "if-match": 'W/"stale"'}});
    assert.equal(res.status, 412, JSON.stringify(res.body));
    const unchanged = await read(id);
    assert.equal(unchanged.body.d.status, "O");
    assert.equal(unchanged.headers.get("etag"), before.headers.get("etag"));
    // the same rule for the action as a changeset member
    const boundary = "batch_r4", changeset = "changeset_r4";
    const part = (ifMatch) => [
      `--${boundary}`, `Content-Type: multipart/mixed; boundary=${changeset}`, "",
      `--${changeset}`, "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      `POST accept?trip_id='${id}' HTTP/1.1`, "Accept: application/json", ...(ifMatch ? [`If-Match: ${ifMatch}`] : []), "", "",
      `--${changeset}--`, `--${boundary}--`, ""].join("\r\n");
    const batch = (ifMatch) => fetch(`${v2}/$batch`, {method: "POST",
      headers: {"content-type": `multipart/mixed; boundary=${boundary}`, "x-csrf-token": "open-steamgate"}, body: part(ifMatch)}).then(r => r.text());
    assert.match(await batch(), /HTTP\/1\.1 428/);
    assert.match(await batch('W/"stale"'), /HTTP\/1\.1 412/);
    assert.equal((await read(id)).body.d.status, "O");
    assert.match(await batch(before.headers.get("etag")), /HTTP\/1\.1 200/);
    assert.equal((await read(id)).body.d.status, "A");
  });

  it("does the same over V4: numbering, ETag on PATCH and on the bound action, features", async () => {
    const post = await call(`${v4}/Trip`, {method: "POST", headers: write, body: JSON.stringify({description: "v4 trip"})});
    assert.equal(post.status, 201, JSON.stringify(post.body));
    const id = post.body.trip_id;
    assert.match(id, /^\d{8}$/);
    const key = `${v4}/Trip('${id}')`;
    const one = await call(key);
    const etag = one.body["@odata.etag"];
    assert.match(etag ?? "", /^W\/"/);
    let res = await call(key, {method: "PATCH", headers: write, body: JSON.stringify({description: "v4 no tag"})});
    assert.equal(res.status, 428);
    res = await call(key, {method: "PATCH", headers: {...write, "if-match": 'W/"0"'}, body: JSON.stringify({description: "v4 wrong"})});
    assert.equal(res.status, 412);
    res = await call(`${key}/ZUI_RAP_TRIP.accept`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 428, "a bound action on an entity with an ETag wants If-Match");
    res = await call(`${key}/ZUI_RAP_TRIP.accept`, {method: "POST", headers: {...write, "if-match": etag}, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.status, "A");
    const now = (await call(key)).body["@odata.etag"];
    assert.notEqual(now, etag, "the action moved the ETag");
    res = await call(`${key}/ZUI_RAP_TRIP.accept`, {method: "POST", headers: {...write, "if-match": etag}, body: "{}"});
    assert.equal(res.status, 412, "the tag from before the action is stale");
    res = await call(`${key}/ZUI_RAP_TRIP.accept`, {method: "POST", headers: {...write, "if-match": now}, body: "{}"});
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /Action ACCEPT of trip is disabled/);
  });
});
