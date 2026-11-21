// R2c: the managed RAP demo served over OData (docs/rap-runtime.md, "Serving").
// The service definition src/rap_demo/zui_rap_note.srvd.srvdsrv becomes the
// service ZUI_RAP_NOTE (tools/rap/srvd-gen.mjs -> stg-compile); reads go
// through the CDS view, writes and the action through ZCL_OSD_RAP_RUNTIME
// (ZCL_OSD_RAP_SADL behind ZCL_STG_SADL_DPC). V2 and V4 are read-write, and
// the action runs over both (V2 function import, V4 bound action). Needs a
// transpiled tree (npm run transpile).
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename} from "node:path";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {parseSrvd} from "../tools/rap/srvd-gen.mjs";
import {compile, KEY_WIDTH} from "../tools/stg-compile.mjs";
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

  it("reads a service definition behind a namespace (abapGit's #ns# file name)", () => {
    const files = demo().filter(f => !f.filename.endsWith(".srvd.srvdsrv") && !f.filename.endsWith(".srvd.xml"));
    files.push({filename: "#dmo#note.srvd.srvdsrv", contents: "define service /DMO/NOTE { expose ZI_RAP_NOTE as Note; }"});
    files.push({filename: "#dmo#ui_travel_processor_m.srvd.srvdsrv", contents: "define service /DMO/UI_TRAVEL_Processor_M { expose ZI_RAP_NOTE as Note; }"});
    const {outputs} = generate(files);
    const yaml = outputs["#dmo#note.stg.yaml"];
    assert.ok(yaml, Object.keys(outputs).join(", "));
    assert.ok(yaml.split("\n").includes("service: /DMO/NOTE"));
    // the namespace moves to the front of the class names, not out of them
    assert.ok(yaml.split("\n").includes("classes: {mpc: /DMO/CL_NOTE_MPC, mpc_ext: /DMO/CL_NOTE_MPC_EXT, dpc: /DMO/CL_NOTE_DPC, dpc_ext: /DMO/CL_NOTE_DPC_EXT}"));
    const long = outputs["#dmo#ui_travel_processor_m.stg.yaml"].split("\n").find(l => l.startsWith("classes: "));
    assert.match(long, /mpc: \/DMO\/CL_UI_TRAVE[A-Z0-9]{6}_MPC/);
    for (const name of long.match(/\/DMO\/CL_\w+/g)) assert.ok(name.length <= 30, name);
    // the file must still name the service it defines, decoded or not
    files.push({filename: "#dmo#other.srvd.srvdsrv", contents: "define service /DMO/NOTE { expose ZI_RAP_NOTE as Note; }"});
    assert.throws(() => generate(files), /#dmo#other\.srvd\.srvdsrv: defines \/DMO\/NOTE/);
    // and the yaml compiles: every object file name abapGit-encodes the
    // namespace, a `/` in a file name being a directory
    const compiled = compile(yaml, {file: "#dmo#note.stg.yaml", functionModules: {}});
    const names = Object.keys({...compiled.files, ...compiled.classes, ...compiled.ext});
    assert.ok(names.includes("#dmo#cl_note_mpc.clas.abap"), names.join(", "));
    assert.ok(names.includes("#dmo#note".padEnd(KEY_WIDTH[".iwsv.xml"], " ") + "0001.iwsv.xml"), names.join(", "));
    for (const name of names) assert.ok(!name.includes("/"), name);
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
    const del = await call(key, {method: "DELETE", headers: write});
    assert.equal(del.status, 204);
    assert.equal((await call(key)).status, 404);
  });

  it("runs the BDEF action as a V4 bound action and answers the entity", async () => {
    const meta = await (await fetch(`${v4}/$metadata`)).text();
    assert.match(meta, /<Action Name="Approve" IsBound="true" EntitySetPath="_it"><Parameter Name="_it" Type="ZUI_RAP_NOTE\.NoteType" Nullable="false"\/><ReturnType Type="ZUI_RAP_NOTE\.NoteType"\/><\/Action>/);
    const id = (await call(`${v4}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: "approve over v4"})})).body.NoteId;
    const key = `${v4}/Note('${id}')`;
    assert.equal((await call(key)).body.Status, "N");
    // the behavior's FOR MODIFY ... FOR ACTION handler sets the status
    const res = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.match(res.body["@odata.context"], /\$metadata#Note\/\$entity$/);
    assert.deepEqual([res.body.NoteId, res.body.NoteText, res.body.Status], [id, "approve over v4", "A"]);
    assert.equal((await call(key)).body.Status, "A");
    // the same instances over V2
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.Status, "A");
    // an empty body is an empty parameter object
    const again = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write});
    assert.equal(again.status, 200, JSON.stringify(again.body));
    await call(key, {method: "DELETE", headers: write});
  });

  it("refuses over V4 what the BDEF does not declare or the request gets wrong", async () => {
    const id = (await call(`${v4}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: "refuse over v4"})})).body.NoteId;
    const key = `${v4}/Note('${id}')`;
    const status = async () => (await call(key)).body.Status;
    // an action the BDEF does not declare is not an operation of the service
    let res = await call(`${key}/ZUI_RAP_NOTE.Reject`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 404, JSON.stringify(res.body));
    assert.match(res.body.error.message, /Unknown operation ZUI_RAP_NOTE\.Reject/);
    // an action takes POST
    res = await call(`${key}/ZUI_RAP_NOTE.Approve`, {headers: write});
    assert.equal(res.status, 405, JSON.stringify(res.body));
    assert.equal(res.headers.get("allow"), "POST");
    // bound to an entity: the set alone is no binding
    res = await call(`${v4}/Note/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    // a key nobody has
    res = await call(`${v4}/Note('${"0".repeat(32)}')/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 404, JSON.stringify(res.body));
    // a key or parameter longer than its MaxLength (NoteId is String(32))
    res = await call(`${v4}/Note('${id}0')/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.code, /VALUE_TOO_LONG/);
    res = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: JSON.stringify({NoteId: `${id}0`})});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.match(res.body.error.code, /VALUE_TOO_LONG/);
    // an unknown parameter, a body that is no JSON object
    res = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: JSON.stringify({Reason: "x"})});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    res = await call(`${key}/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "[]"});
    assert.equal(res.status, 400, JSON.stringify(res.body));
    assert.equal(await status(), "N");
    await call(key, {method: "DELETE", headers: write});
  });

  // A $batch changeset or atomicity group is one LUW, and a RAP action in it
  // joins that LUW: its save writes but does not COMMIT, so a later failing
  // member rolls it back with the group (ZCL_OSD_LUW_HOLD=>HELD).
  const CRLF = "\r\n";
  const httpPart = (method, url, body) => ["Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
    `${method} ${url} HTTP/1.1`, "Content-Type: application/json", "Accept: application/json", "", body ?? ""].join(CRLF);
  const multipart = (url, version, parts) => fetch(`${url}/$batch`, {method: "POST",
    headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "open-steamgate", ...version},
    body: ["--b", "Content-Type: multipart/mixed; boundary=cs", "",
      ...parts.map((p, i) => `--cs${CRLF}Content-ID: ${i}${CRLF}${p}`), "--cs--", "--b--", ""].join(CRLF)});
  const statusOf = async (id) => (await call(`${v4}/Note('${id}')`)).body.Status;
  const v4Note = async (text) => (await call(`${v4}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: text})})).body.NoteId;

  it("rolls a V4 bound action back with its failing JSON atomicity group", async () => {
    const id = await v4Note("atomic action target");
    const group = (second) => call(`${v4}/$batch`, {method: "POST", headers: write, body: JSON.stringify({requests: [
      {id: "approve", atomicityGroup: "g", method: "POST", url: `Note('${id}')/ZUI_RAP_NOTE.Approve`, body: {}},
      {id: "second", atomicityGroup: "g", method: "POST", url: "Note", body: second},
    ]})});
    let res = await group({NoteText: "x"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.responses.map(r => r.status), [424, 400], JSON.stringify(res.body));
    assert.equal(await statusOf(id), "N");
    // a later successful write does not carry the action's change in with it
    const other = await v4Note("after the failed group");
    assert.equal(await statusOf(id), "N");
    // the same group with a valid second member commits both
    res = await group({NoteText: "valid second member"});
    assert.deepEqual(res.body.responses.map(r => r.status), [200, 201], JSON.stringify(res.body));
    assert.equal(await statusOf(id), "A");
    const created = res.body.responses[1].body.NoteId;
    assert.equal(await statusOf(created), "N");
    for (const n of [id, other, created]) await call(`${v4}/Note('${n}')`, {method: "DELETE", headers: write});
  });

  it("rolls a V4 bound action back with its failing multipart change set", async () => {
    const id = await v4Note("multipart action target");
    const res = await multipart(v4, {"odata-version": "4.0"}, [
      httpPart("POST", `Note('${id}')/ZUI_RAP_NOTE.Approve`, "{}"),
      httpPart("POST", "Note", JSON.stringify({NoteText: "x"})),
    ]);
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /HTTP\/1\.1 400/, text);
    assert.doesNotMatch(text, /HTTP\/1\.1 200/, text);
    assert.equal(await statusOf(id), "N");
    await call(`${v4}/Note('${id}')`, {method: "DELETE", headers: write});
  });

  it("rolls a V2 function import back with its failing changeset", async () => {
    const id = (await create("v2 changeset target")).body.d.NoteId;
    const res = await multipart(v2, {}, [
      httpPart("POST", `Approve?NoteId='${id}'`),
      httpPart("POST", "Note", JSON.stringify({NoteText: "x"})),
    ]);
    assert.equal(res.status, 202);
    const text = await res.text();
    assert.match(text, /HTTP\/1\.1 400/, text);
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.Status, "N");
    // outside a changeset the action still commits on its own
    assert.equal((await call(`${v2}/Approve?NoteId='${id}'`, {method: "POST", headers: write})).status, 200);
    assert.equal((await call(`${v2}/Note('${id}')?$format=json`)).body.d.Status, "A");
    await call(`${v2}/Note('${id}')`, {method: "DELETE", headers: write});
  });

  // A group that unwinds by a dump (ASSERT) or an exception nobody catches
  // never reaches its own reset of the LUW hold, and the flag is a static that
  // outlives the request. The next request must still start with no group
  // holding the LUW: a plain Approve then ends its own LUW (IV_END_LUW = X).
  // Its persisted status alone cannot tell, because the ICF bracket commits
  // after it either way, so the test watches the runtime's COMMIT.
  it("does not carry a dumped group's LUW hold into the next request", async () => {
    const C = globalThis.abap.Classes;
    const runtime = C.ZCL_OSD_RAP_RUNTIME.prototype;
    const handler = C["CLAS-ZBP_RAP_NOTE-LHC_NOTE"].prototype;
    const held = async () => (await C.ZCL_OSD_LUW_HOLD.held()).get().trim();
    const endLuw = [];
    const commit = runtime.commit;
    const construct = handler.constructor_;
    let fail;
    runtime.commit = async function (input) {
      endLuw.push(input?.iv_end_luw?.get?.().trim() ?? "default");
      return commit.call(this, input);
    };
    handler.constructor_ = async function (input) {
      const result = await construct.call(this, input);
      const approve = this.FRIENDS_ACCESS_INSTANCE.approve;
      this.FRIENDS_ACCESS_INSTANCE.approve = async (i) => fail ? fail(i, approve) : approve(i);
      return result;
    };
    const v2Note = async (text) => (await create(text)).body.d.NoteId;
    const groups = {
      "V4 JSON": (a, b) => call(`${v4}/$batch`, {method: "POST", headers: write, body: JSON.stringify({requests: [
        {id: "a", atomicityGroup: "g", method: "POST", url: `Note('${a}')/ZUI_RAP_NOTE.Approve`, body: {}},
        {id: "b", atomicityGroup: "g", method: "POST", url: `Note('${b}')/ZUI_RAP_NOTE.Approve`, body: {}},
      ]})}),
      "V4 multipart": (a, b) => multipart(v4, {"odata-version": "4.0"}, [
        httpPart("POST", `Note('${a}')/ZUI_RAP_NOTE.Approve`, "{}"), httpPart("POST", `Note('${b}')/ZUI_RAP_NOTE.Approve`, "{}")]),
      "V2 changeset": (a, b) => multipart(v2, {}, [
        httpPart("POST", `Approve?NoteId='${a}'`), httpPart("POST", `Approve?NoteId='${b}'`)]),
    };
    const created = [];
    try {
      for (const [name, group] of Object.entries(groups)) {
        for (const mode of ["dump", "exception"]) {
          const [a, b, plain] = [await v2Note(`${name} ${mode} a`), await v2Note(`${name} ${mode} b`), await v2Note(`${name} ${mode} plain`)];
          created.push(a, b, plain);
          let count = 0;
          fail = async (input, approve) => {
            if (++count < 2) return approve(input);
            if (mode === "dump") abap.statements.assert(false);
            throw await new C.CX_SY_NO_HANDLER().constructor_();
          };
          await group(a, b).catch(() => undefined);
          fail = undefined;
          // the very next request, with nothing in between
          endLuw.length = 0;
          const res = await call(`${v4}/Note('${plain}')/ZUI_RAP_NOTE.Approve`, {method: "POST", headers: write, body: "{}"});
          assert.equal(res.status, 200, JSON.stringify(res.body));
          assert.deepEqual(endLuw, ["X"], `${name} ${mode}: a plain Approve ends its own LUW`);
          assert.equal(await held(), "", `${name} ${mode}: no group holds the LUW after it`);
          assert.equal(await statusOf(plain), "A");
          assert.equal(await statusOf(a), "N", `${name} ${mode}: the group is undone`);
        }
      }
    } finally {
      fail = undefined;
      runtime.commit = commit;
      handler.constructor_ = construct;
      await C.ZCL_OSD_LUW_HOLD.hold({iv_held: abap.builtin.abap_false});
      for (const n of created) await call(`${v4}/Note('${n}')`, {method: "DELETE", headers: write});
    }
  });

  it("checks If-Match on a V4 bound action as a PATCH does", async () => {
    const id = (await call(`${v4}/Note`, {method: "POST", headers: write, body: JSON.stringify({NoteText: "if-match over v4"})})).body.NoteId;
    const key = `${v4}/Note('${id}')`;
    const action = `${key}/ZUI_RAP_NOTE.Approve`;
    // NoteType has no ETag (the BDEF has no etag master): an If-Match names
    // a tag the entity does not have, 412, and the behavior does not run
    let res = await call(action, {method: "POST", headers: {...write, "if-match": "W/\"anything\""}, body: "{}"});
    assert.equal(res.status, 412, JSON.stringify(res.body));
    assert.equal((await call(key)).body.Status, "N");
    // the same answer a PATCH gets
    res = await call(key, {method: "PATCH", headers: {...write, "if-match": "W/\"anything\""}, body: JSON.stringify({NoteText: "never"})});
    assert.equal(res.status, 412, JSON.stringify(res.body));
    // without an ETag on the type no If-Match is required (no 428) ...
    res = await call(action, {method: "POST", headers: write, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    // ... and If-Match: * matches any entity that exists
    res = await call(action, {method: "POST", headers: {...write, "if-match": "*"}, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.Status, "A");
    await call(key, {method: "DELETE", headers: write});
  });
});
