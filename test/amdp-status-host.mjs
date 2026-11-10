import {expect} from "chai";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ServingRuntime} from "../tools/osd-runtime.mjs";
import {snapshot, childAmdpFacts} from "../tools/osd-status.mjs";
import {acceptAmdpFacts, amdpFactRows, amdpFacts, methodRows, unknownAmdpFacts} from "../tools/amdp-status.mjs";
import {AmdpDestination} from "../tools/amdp-destination.mjs";
import {runtimeRootFixture} from "./helpers/runtime-root.mjs";

// Where each AMDP body runs, said by the process that would run it
// (docs/amdp-engine-status.md). The first block is the host module on its
// own, with a destination whose session is set by hand; the second crosses
// the child boundary on SQLite and on DuckDB and reads the answer back out
// of AmdpMethodSet, so what the page shows is what the destination would do.
describe("tools/amdp-status: the facts a destination gives about itself", () => {
  const procedures = new Map([
    ["Z_AMDP_1", {module: "Z_AMDP_1", class: "ZCL_ONE", method: "GOOD", kind: "procedure", portable: {body: []}}],
    ["Z_AMDP_2", {module: "Z_AMDP_2", class: "ZCL_ONE", method: "BAD", kind: "function",
      portableRefusal: {code: "UNSUPPORTED_SQLSCRIPT", message: "TO_NCLOB  has no\nmeasured portable rendering"}}],
  ]);
  const settings = {host: "hana.example", port: 39041, user: "secret-user", password: "secret-password"};
  const destination = (configured) => new AmdpDestination({procedures, settings: async () => configured, database: () => undefined});

  it("lists every method once, upper-case, with the compiler's refusal cut to a column", () => {
    expect(methodRows(procedures)).to.deep.equal([
      {clsname: "ZCL_ONE", mtdname: "BAD", kind: "function", portable: false, refusal: "TO_NCLOB has no measured portable rendering"},
      {clsname: "ZCL_ONE", mtdname: "GOOD", kind: "procedure", portable: true, refusal: ""},
    ]);
    expect(methodRows(undefined)).to.deep.equal([]);
  });

  it("carries DuckDB's refusal of a compiled body, so the label cannot say portable-duckdb", () => {
    const refused = new Map([["Z_AMDP_3", {module: "Z_AMDP_3", class: "ZCL_ONE", method: "FLOORS", kind: "procedure",
      portable: {body: []}, portableDuckdbRefusal: {code: "UNSUPPORTED_DIALECT", message: "the function FLOOR has no measured rendering on duckdb"}}]]);
    expect(methodRows(refused)).to.deep.equal([{clsname: "ZCL_ONE", mtdname: "FLOORS", kind: "procedure", portable: true,
      refusal: "the function FLOOR has no measured rendering on duckdb"}]);
  });

  it("says 'not known' when a work process did not answer, and guesses nothing", () => {
    const facts = unknownAmdpFacts();
    expect(facts.unknown).to.equal(true);
    const rows = amdpFactRows(facts);
    expect(rows.map((r) => r.value)).to.deep.equal(["not known", "not known"]);
    expect(JSON.stringify(rows)).not.to.include("no HANA driver").and.not.to.include("0 AMDP method");
  });

  it("reads the session off the destination, not off its configuration", async () => {
    const target = destination(settings);
    const client = {name: "sqlite", sqlite: {}};
    let facts = await amdpFacts({destination: target, client});
    expect(facts).to.include({db: "sqlite", driver: true, configured: true, session: "none"});
    target.client = {readyState: "connected"};
    facts = await amdpFacts({destination: target, client});
    expect(facts.session).to.equal("connected");
    // the socket the server dropped: still a client object, no longer connected
    target.client = {readyState: "closed"};
    facts = await amdpFacts({destination: target, client});
    expect(facts.session).to.equal("closed");
    // nothing of the settings leaves
    expect(JSON.stringify(facts)).not.to.include("hana.example").and.not.to.include("secret");
  });

  it("says no driver and not configured apart", async () => {
    expect(await amdpFacts({destination: destination(undefined), client: {name: "duckdb", connected: true}}))
      .to.include({db: "duckdb", driver: false, configured: false, session: "none"});
    expect(await amdpFacts({destination: destination({...settings, password: ""}), client: {name: "duckdb", connected: true}}))
      .to.include({db: "duckdb", driver: true, configured: false});
    expect(await amdpFacts({destination: undefined, client: undefined})).to.deep.equal({db: "unknown", driver: false, configured: false, session: "none", methods: []});
  });

  it("accepts a child's answer only inside the vocabulary", () => {
    const good = {db: "duckdb", driver: true, configured: false, session: "none",
      methods: [{clsname: "ZCL_ONE", mtdname: "GOOD", kind: "procedure", portable: true, refusal: ""}]};
    expect(acceptAmdpFacts(good)).to.deep.equal(good);
    for (const bad of [undefined, null, "x", {...good, db: "constructor"}, {...good, session: "open"}, {...good, driver: "yes"},
      {...good, methods: "none"}, {...good, methods: [{...good.methods[0], clsname: "../etc"}]},
      {...good, methods: [{...good.methods[0], kind: "view"}]}, {...good, methods: [{...good.methods[0], portable: 1}]}]) {
      expect(acceptAmdpFacts(bad), JSON.stringify(bad)).to.equal(undefined);
    }
    const long = acceptAmdpFacts({...good, methods: [{...good.methods[0], refusal: "a\u0000b".padEnd(500, "x")}]});
    expect(long.methods[0].refusal).to.have.length(240).and.not.to.include("\u0000");
  });

  it("turns the facts into two Environment rows", () => {
    const rows = amdpFactRows({db: "duckdb", driver: true, configured: false, session: "none", methods: [1, 2]});
    expect(rows.map((r) => [r.section, r.name, r.value])).to.deep.equal([
      ["AMDP", "pAMDP portable engine", "duckdb"], ["AMDP", "eAMDP HANA destination", "not configured"]]);
    expect(rows[1].note).to.include("2 AMDP method(s)");
    expect(amdpFactRows({db: "sqlite", driver: true, configured: true, session: "closed", methods: []})[1].value).to.equal("session closed (stale)");
    expect(amdpFactRows({db: "sqlite", driver: false, configured: false, session: "none", methods: []})[1].value).to.equal("no HANA driver in this build");
    expect(amdpFactRows({db: "sqlite", driver: true, configured: true, session: "connected", methods: []})[1].value).to.equal("session connected");
  });

  it("reads the child's facts the way it reads its database facts", async () => {
    const runtime = {url: "http://127.0.0.1:45678", generation: "abc"};
    const body = {ready: true, generation: "abc", amdp: {db: "duckdb", driver: true, configured: false, session: "none", methods: []}};
    const read = (answer) => childAmdpFacts(runtime, {fetcher: async (url) => {
      expect(url.pathname).to.equal("/osd/serving");
      return {ok: true, json: async () => answer};
    }});
    expect(await read(body)).to.deep.equal(body.amdp);
    expect(await read({...body, generation: "old"})).to.equal(undefined);
    expect(await read({...body, amdp: undefined})).to.equal(undefined);
    expect(await childAmdpFacts({...runtime, url: "http://example.test"}, {fetcher: () => { throw new Error("must not fetch"); }})).to.equal(undefined);
  });
});

const runtimeFixture = runtimeRootFixture();

describe("AmdpMethodSet: the engine of each AMDP method across the child boundary", function () {
  this.timeout(90000);
  for (const [backend, engine] of [["file", "sqlite"], ["duckdb", "duckdb"]]) {
    it(`${backend}: the page says what the destination would do`, async () => {
      const root = mkdtempSync(join(tmpdir(), "osd-amdp-host-"));
      const database = join(root, "isolated.db");
      const runtime = new ServingRuntime({root: runtimeFixture.root, database, env: {STG_DB: backend, STG_TLS: "0"}});
      try {
        expect(await childAmdpFacts(runtime)).to.equal(undefined);
        await runtime.ensure();
        const res = await fetch(`${runtime.url}/osd/serving`);
        expect(res.status).to.equal(200);
        const body = await res.json();
        expect(body.amdp.db).to.equal(engine);
        expect(body.amdp.session).to.equal("none");
        const squares = body.amdp.methods.find((m) => m.clsname === "ZCL_OSD_AMDP_DEMO" && m.mtdname === "SQUARES");
        expect(squares, JSON.stringify(body.amdp.methods)).to.include({kind: "procedure", portable: true});
        expect(JSON.stringify(body.amdp)).not.to.include(root);

        const state = await snapshot(process.cwd(), {runtime, env: {STG_DB: "hana"}});
        expect(state.amdp).to.deep.equal(body.amdp);
        expect(state.database.find((f) => f.section === "AMDP" && f.name === "pAMDP portable engine").value)
          .to.equal(engine === "duckdb" ? "duckdb" : "off");
        const posted = await fetch(`${runtime.url}/sap/bc/osd/status/`, {
          method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify(state),
        });
        expect(posted.status, await posted.text()).to.equal(200);

        const response = await fetch(`${runtime.url}/sap/opu/odata/sap/ZOSD_STATUS_SRV/AmdpMethodSet?$format=json`);
        const text = await response.text();
        expect(response.status, text).to.equal(200);
        const rows = JSON.parse(text).d.results;
        const row = rows.find((r) => r.ClassName === "ZCL_OSD_AMDP_DEMO" && r.MethodName === "SQUARES");
        expect(row, text.slice(0, 400)).to.not.equal(undefined);
        expect(row.Portable).to.equal("X");
        if (engine === "duckdb") {
          // the one engine a developer gets without a HANA: pAMDP on the system connection
          expect(row.Engine).to.equal("portable-duckdb");
        } else {
          // on SQLite the destination dials HANA or refuses; which of the two
          // depends on this machine's HANA settings, so only the family is fixed
          expect(row.Engine).to.match(/^(unavailable|hdb-idle|hdb|hdb-stale)$/);
          expect(row.Reason).to.include("portable subset: yes");
        }
        expect(text).not.to.include(root);
        const expanded = await fetch(`${runtime.url}/sap/opu/odata/sap/ZOSD_STATUS_SRV/SystemSet?$expand=to_Amdp&$format=json`);
        expect(expanded.status).to.equal(200);
        expect(await expanded.text()).to.include("SQUARES");
      } finally {
        await runtime.stop();
        rmSync(root, {recursive: true, force: true});
      }
    });
  }
});
