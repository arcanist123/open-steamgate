// Q4 "Hotspots": ZOSD_DUMP, the table -- written by the same host tools/osd-serve.mjs
// keeps the in-memory ring in, checked here through the real process rather
// than a synthetic dumpOf() object, so the wiring in dump() is what is under
// test and not a description of it. Modelled on test/mocha.mjs's own "a
// request that dumps leaves nothing behind" and test/osd-runtime.mjs's own
// use of ServingRuntime for a cheap, isolated (in-memory database) process.
import {expect} from "chai";
import {ServingRuntime, liveChildren} from "../tools/osd-runtime.mjs";
import {objectOf, rowOf} from "../tools/osd-dumps.mjs";
import {runtimeRootFixture} from "./helpers/runtime-root.mjs";

const runtimeFixture = runtimeRootFixture();

describe("tools/osd-dumps: ZOSD_DUMP, written after the rollback", function () {
  this.timeout(180000);

  afterEach(() => {
    for (const child of liveChildren()) child.kill("SIGKILL");
  });

  it("names the object and include off an abapGit file the way ST22 would", () => {
    expect(objectOf("zcl_stg_dispatcher.clas.abap")).to.deep.equal({type: "CLAS", name: "ZCL_STG_DISPATCHER", include: "main"});
    expect(objectOf("/x/zcl_a.clas.testclasses.abap")).to.deep.equal({type: "CLAS", name: "ZCL_A", include: "testclasses"});
    expect(objectOf("zif_a.intf.abap")).to.deep.equal({type: "INTF", name: "ZIF_A", include: "main"});
    expect(objectOf("zosd_rfc.fugr.lzosd_rfctop.abap")).to.deep.equal({type: "FUGR", name: "ZOSD_RFC", include: "lzosd_rfctop"});
    expect(objectOf(undefined)).to.deep.equal({type: "", name: "", include: ""});
  });

  it("turns dumpOf()'s shape into one row, the request truncated and the frame named", () => {
    const d = {
      name: "CX_SY_ZERODIVIDE", message: "Division by zero",
      frames: [{file: "zcl_stg_dispatcher.clas.abap", line: 119, text: "lv = 1 / lv_zero."}],
    };
    const row = rowOf(d, {id: "X", now: 1000, request: `POST /sap/opu/odata/sap/${"X".repeat(200)}`, generation: "abc123"});
    expect(row).to.include({dump_id: "X", created_at: 1000, runtime_error: "CX_SY_ZERODIVIDE", message: "Division by zero",
      objtype: "CLAS", objname: "ZCL_STG_DISPATCHER", include: "main", line: 119, req_method: "POST", generation: "abc123"});
    expect(row.req_path).to.have.length(120);
  });

  it("a request that dumps writes one ZOSD_DUMP row with the right object and line, and the LUW's own rows are still rolled back", async () => {
    const runtime = new ServingRuntime({root: runtimeFixture.root});
    try {
      await runtime.start();
      const base = `${runtime.url}/sap/opu/odata/sap/ZSTG_DEMO_SRV`;
      const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};

      // written before the dump, in the same changeset, so a rollback is
      // provable (not just "the row that dumped never existed")
      const crlf = "\r\n";
      const part = (body) => ["--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "POST TravelSet HTTP/1.1", "Content-Type: application/json", "", JSON.stringify(body)].join(crlf);
      const body = ["--b", "Content-Type: multipart/mixed; boundary=cs", "",
        part({TravelId: "H001", Description: "written before the dump", Seats: 1}),
        // Seats is a number; "abc" is not one, so the entry provider raises
        // CX_SY_CONVERSION_NO_NUMBER -- none of the four gateway families
        // the dispatcher catches, so it unwinds past the ROLLBACK WORK of
        // the changeset and reaches osd-serve.mjs's own app.all() catch
        part({TravelId: "H002", Description: "dumps on Seats", Seats: "abc"}),
        "--cs--", "", "--b--", ""].join(crlf);
      const res = await fetch(`${base}/$batch`, {method: "POST",
        headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "open-steamgate"}, body});
      expect(res.status, "the dump is the host's to answer").to.equal(500);

      expect((await fetch(`${base}/TravelSet('H001')`)).status, "rolled back with the rest of the changeset").to.equal(404);

      const query = async (sql) => {
        const answer = await fetch(`${runtime.url}/osd/sql`, {method: "POST", headers: {"content-type": "application/json"},
          body: JSON.stringify({sql})});
        expect(answer.status, sql).to.equal(200);
        return answer.json();
      };

      // persistDump() commits through its own dialogStep(), a fresh one --
      // not the step that just rolled back -- so the row is there to read
      // straight away, with no wait and no retry
      const rows = (await query("SELECT * FROM zosd_dump")).rows;
      expect(rows, "exactly the one dump the batch above raised").to.have.length(1);
      const row = rows[0];
      expect(row.mandt).to.equal("123");
      expect(row.runtime_error, "the ABAP exception, not the JavaScript one").to.match(/CONVERSION_NO_NUMBER/i);
      expect(row.objtype, "an ABAP position, not a generated one").to.equal("CLAS");
      expect(row.objname).to.match(/^ZCL_/);
      expect(Number(row.line), "a real line in that object").to.be.greaterThan(0);
      expect(row.req_method).to.equal("POST");
      expect(row.req_path).to.contain("/$batch");
      expect(row.generation, "the generation this request was served by").to.have.length.greaterThan(0);

      // the heat query the extension runs through the same freestyle door
      // (editors/vscode/lib.js HOTSPOTS_SQL): one line, one dump on it
      const heat = await query(
        `SELECT objname, line, COUNT(*) AS n FROM zosd_dump GROUP BY objname, line`,
      );
      expect(heat.rows).to.have.length(1);
      expect(Number(heat.rows[0].n)).to.equal(1);
      expect(heat.rows[0].objname).to.equal(row.objname);

      // the request after the dump still works -- nothing left pending on
      // the shared connection by either the failed step or the dump write
      const next = await fetch(`${base}/TravelSet`, {method: "POST", headers, body: JSON.stringify({TravelId: "H003", Description: "after", Seats: 1})});
      expect(next.status).to.equal(201);
      // Travel declares an ETag, so its DELETE takes If-Match
      await fetch(`${base}/TravelSet('H003')`, {method: "DELETE", headers: {...headers, "if-match": "*"}});
    } finally {
      await runtime.stop();
    }
  });

  it("the table is capped: only the last OSD_DUMP_CAP rows are kept", async () => {
    // A small cap, its own process (env var read once at module load): fast
    // to prove without waiting on a thousand real dumps.
    const runtime = new ServingRuntime({root: runtimeFixture.root, env: {OSD_DUMP_CAP: "3"}});
    try {
      await runtime.start();
      const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
      for (let i = 0; i < 5; i++) {
        const res = await fetch(`${runtime.url}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet`, {method: "POST", headers,
          body: JSON.stringify({TravelId: `C${i}`, Description: "cap", Seats: "abc"})});
        expect(res.status).to.equal(500);
      }
      const answer = await fetch(`${runtime.url}/osd/sql`, {method: "POST", headers: {"content-type": "application/json"},
        body: JSON.stringify({sql: "SELECT COUNT(*) AS n FROM zosd_dump"})});
      const rows = (await answer.json()).rows;
      expect(Number(rows[0].n), "capped rather than growing without bound").to.equal(3);
    } finally {
      await runtime.stop();
    }
  });
});
