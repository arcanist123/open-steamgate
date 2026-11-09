// R2c: the managed RAP demo served over OData (docs/rap-runtime.md, "Serving").
// The service definition src/rap_demo/zui_rap_note.srvd.srvdsrv becomes the
// service ZUI_RAP_NOTE (tools/rap/srvd-gen.mjs -> stg-compile); reads go
// through the CDS view, writes and the action through ZCL_OSD_RAP_RUNTIME
// (ZCL_OSD_RAP_SADL behind ZCL_STG_SADL_DPC). V2 is read-write, V4 read-only
// until the V4 write slice lands. Needs a transpiled tree (npm run transpile).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {parseSrvd} from "../tools/rap/srvd-gen.mjs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const v2 = `${origin}/sap/opu/odata/sap/ZUI_RAP_NOTE`;
const v4 = `${origin}/sap/opu/odata4/sap/ZUI_RAP_NOTE`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const demo = () => walk("src/rap_demo").filter(f => /\.(abap|xml|asbdef|asddls|srvdsrv)$/.test(f))
  .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  return {status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers};
}
const notes = async () => (await call(`${v2}/Note?$format=json`)).body.d.results;
const create = text => call(`${v2}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: text})});

describe("RAP service definitions (R2c generator)", () => {
  it("reads define service / expose ... as", () => {
    const srvd = parseSrvd("@EndUserText.label: 'A label'\ndefine service Zs {\n  expose ZI_A as A;\n  expose ZI_B;\n}\n");
    assert.deepEqual(srvd, {name: "ZS", label: "A label", exposed: [{entity: "ZI_A", alias: "A"}, {entity: "ZI_B", alias: "ZI_B"}]});
  });

  it("refuses what it does not read", () => {
    assert.throws(() => parseSrvd("define service Zs { }"), /exposes nothing/);
    assert.throws(() => parseSrvd("define service Zs { expose ZI_A as A }"), /expected ;/);
    assert.throws(() => parseSrvd("define service Zs { @UI.x: true expose ZI_A; }"), /element annotations/);
    assert.throws(() => parseSrvd("define service Zs { expose ZI_A; } extra"), /text after/);
  });

  it("writes a writable entity with the behavior's field control and actions", () => {
    const {outputs} = generate(demo());
    const yaml = outputs["zui_rap_note.stg.yaml"];
    assert.ok(yaml, Object.keys(outputs).join(", "));
    for (const line of [
      "service: ZUI_RAP_NOTE",
      "    set: Note",
      "    source: {cds: ZI_RAP_NOTE, struct: \"ZCL_STG_CDS_ZI_RAP_NOTE=>TY_ROW\"}",
      "    keys: [NoteId]",
      "    operations: [C, R, Q, U, D]",
      "      NoteId: {type: String(32), field: NOTEID, readonly: true, label: \"NoteId\"}",
      "      NoteText: {type: String(60), field: NOTETEXT, label: \"NoteText\"}",
      "      Status: {type: String(1), field: STATUS, readonly: true, label: \"Status\"}",
      "  Approve:",
      "    for: NoteType",
      "    parameters: {NoteId: String(32)}",
    ]) assert.ok(yaml.split("\n").includes(line), `${line}\n---\n${yaml}`);
  });

  it("gives services sharing a 12-character prefix classes of their own", () => {
    const files = demo().filter(f => !f.filename.endsWith(".srvd.srvdsrv") && !f.filename.endsWith(".srvd.xml"));
    for (const name of ["Z123456789012345678A", "Z123456789012345678B", "ZUI_RAP_NOTE"]) {
      files.push({filename: `${name.toLowerCase()}.srvd.srvdsrv`, contents: `define service ${name} { expose ZI_RAP_NOTE as Note; }`});
    }
    const {outputs} = generate(files);
    const classes = Object.entries(outputs).filter(([f]) => f.endsWith(".stg.yaml"))
      .map(([, yaml]) => yaml.split("\n").find(l => l.startsWith("classes: ")));
    assert.equal(classes.length, 3);
    assert.equal(new Set(classes).size, 3, classes.join("\n"));
    assert.ok(classes.includes("classes: {mpc: ZCL_ZUI_RAP_NOTE_MPC, mpc_ext: ZCL_ZUI_RAP_NOTE_MPC_EXT, dpc: ZCL_ZUI_RAP_NOTE_DPC, dpc_ext: ZCL_ZUI_RAP_NOTE_DPC_EXT}"));
    for (const c of classes) for (const name of c.match(/ZCL_\w+/g)) assert.ok(name.length <= 30, name);
  });

  it("serves an entity without behavior read-only", () => {
    const files = demo().filter(f => !f.filename.includes(".bdef.") && !f.filename.startsWith("zbp_"));
    const yaml = generate(files).outputs["zui_rap_note.stg.yaml"];
    assert.ok(yaml.includes("    operations: [R, Q]"));
    assert.ok(!yaml.includes("functions:"));
  });
});

describe("RAP managed BO over OData (R2c wire)", function () {
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

  it("describes the set and the action in V2 $metadata", async () => {
    const res = await fetch(`${v2}/$metadata`);
    assert.equal(res.status, 200);
    const xml = await res.text();
    assert.match(xml, /<EntitySet Name="Note" EntityType="ZUI_RAP_NOTE\.NoteType"/);
    assert.match(xml, /<FunctionImport Name="Approve"[^>]*m:HttpMethod="POST"/);
    assert.match(xml, /sap:action-for="ZUI_RAP_NOTE\.NoteType"/);
  });

  it("creates through the runtime: managed key, default status, normalized text", async () => {
    const before = (await notes()).length;
    const res = await create("  first   note ");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const note = res.body.d;
    assert.match(note.NoteId, /^[0-9A-F]{32}$/);
    assert.equal(note.Status, "N");
    assert.equal(note.NoteText, "first note");
    assert.equal((await notes()).length, before + 1);
    const one = await call(`${v2}/Note('${note.NoteId}')?$format=json`);
    assert.equal(one.status, 200);
    assert.deepEqual([one.body.d.NoteText, one.body.d.Status], ["first note", "N"]);
  });

  it("refuses a failing validation with the RAP message and writes nothing", async () => {
    const before = await notes();
    const res = await create("ab");
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "A note text needs at least three characters");
    assert.deepEqual(await notes(), before);
  });

  it("refuses a read-only field on create and on update", async () => {
    const before = await notes();
    let res = await call(`${v2}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: "valid text", Status: "A"})});
    assert.equal(res.status, 400);
    assert.match(res.body.error.message.value, /STATUS is read-only/);
    assert.deepEqual(await notes(), before);
    const id = (await create("read-only target")).body.d.NoteId;
    res = await call(`${v2}/Note('${id}')`, {method: "PATCH", headers: write, body: JSON.stringify({Status: "A"})});
    assert.equal(res.status, 400);
    assert.match(res.body.error.message.value, /STATUS is read-only/);
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.Status, "N");
  });

  it("updates with PATCH and MERGE, validating on save", async () => {
    const id = (await create("to be changed")).body.d.NoteId;
    let res = await call(`${v2}/Note('${id}')`, {method: "PATCH", headers: write, body: JSON.stringify({NoteText: "  patched   text "})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.NoteText, "patched text");
    res = await call(`${v2}/Note('${id}')`, {method: "MERGE", headers: write, body: JSON.stringify({NoteText: "x"})});
    assert.equal(res.status, 400);
    assert.equal(res.body.error.message.value, "A note text needs at least three characters");
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.NoteText, "patched text");
    // PUT sends the read-only fields as they are, which is no write to them
    const current = (await call(`${v2}/Note('${id}')?$format=json`)).body.d;
    res = await call(`${v2}/Note('${id}')`, {method: "PUT", headers: write,
      body: JSON.stringify({NoteId: id, NoteText: "put text", Status: current.Status})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.NoteText, "put text");
  });

  it("replaces on PUT: an omitted editable field is initial, so the mandatory text is refused", async () => {
    const id = (await create("original text")).body.d.NoteId;
    for (const body of [{NoteId: id, Status: "N"}, {}]) {
      const res = await call(`${v2}/Note('${id}')`, {method: "PUT", headers: write, body: JSON.stringify(body)});
      assert.equal(res.status, 400, JSON.stringify(body));
      assert.match(res.body.error.message.value, /NOTETEXT is mandatory/);
      const row = (await call(`${v2}/Note('${id}')?$format=json`)).body.d;
      assert.deepEqual([row.NoteText, row.Status], ["original text", "N"]);
    }
    // the read-only status, omitted, keeps its value
    const res = await call(`${v2}/Note('${id}')`, {method: "PUT", headers: write, body: JSON.stringify({NoteText: "replaced text"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    const row = (await call(`${v2}/Note('${id}')?$format=json`)).body.d;
    assert.deepEqual([row.NoteText, row.Status], ["replaced text", "N"]);
  });

  it("runs the instance action as a V2 function import", async () => {
    const id = (await create("approve me")).body.d.NoteId;
    const res = await call(`${v2}/Approve?NoteId='${id}'`, {method: "POST", headers: write});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual([res.body.d.NoteId, res.body.d.Status], [id, "A"]);
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.Status, "A");
    const missing = await call(`${v2}/Approve?NoteId='${"0".repeat(32)}'`, {method: "POST", headers: write});
    assert.equal(missing.status, 400);
    assert.match(missing.body.error.message.value, /not found/);
  });

  it("deletes through the runtime", async () => {
    const id = (await create("short lived")).body.d.NoteId;
    const res = await call(`${v2}/Note('${id}')`, {method: "DELETE", headers: write});
    assert.equal(res.status, 204);
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).status, 404);
  });

  it("reads and creates the same instances over V4", async () => {
    const id = (await create("seen over V4")).body.d.NoteId;
    const meta = await fetch(`${v4}/$metadata`);
    assert.equal(meta.status, 200);
    assert.match(await meta.text(), /<EntityType Name="NoteType"/);
    const list = await call(`${v4}/Note?$filter=NoteId eq '${id}'`);
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.value, [{NoteId: id, NoteText: "seen over V4", Status: "N"}]);
    const one = await call(`${v4}/Note('${id}')`);
    assert.equal(one.body.Status, "N");
    // a V4 write reaches the same behavior: numbering and the determination
    // fill what the body left out
    const post = await call(`${v4}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: "v4 write"})});
    assert.equal(post.status, 201, JSON.stringify(post.body));
    assert.equal(post.body.NoteText, "v4 write");
    assert.equal(post.body.Status, "N");
    assert.ok(post.body.NoteId);
    const key = `${v4}/Note('${post.body.NoteId}')`;
    const patch = await call(key, {method: "PATCH", headers: write, body: JSON.stringify({NoteText: "v4 edit"})});
    assert.ok([200, 204].includes(patch.status), `${patch.status} ${JSON.stringify(patch.body)}`);
    assert.equal((await call(key)).body.NoteText, "v4 edit");
    const action = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
    // the V4 facade knows a bound action path (#862) but serves only the
    // draft actions of sticky editing; a BDEF action is named, not run
    assert.equal(action.status, 501, JSON.stringify(action.body));
    assert.match(JSON.stringify(action.body), /Approve is not implemented/);
    const del = await call(key, {method: "DELETE", headers: write});
    assert.equal(del.status, 204);
    assert.equal((await call(key)).status, 404);
  });
});
