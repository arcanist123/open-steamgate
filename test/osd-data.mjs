import {expect} from "chai";
import initSqlJs from "sql.js";
import {SQLiteDatabaseClient} from "@abaplint/database-sqlite";
import {Data, NotAllowed, openSqlToSql, readDoor} from "../tools/osd-data.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";
import {tableFieldsOf} from "../tools/adt-documents.mjs";
import {cdsEntityOf} from "../tools/adt-cds.mjs";

// The data of OSD: the rows a client sees when it asks for table contents,
// out of the same database the ABAP runtime uses.
describe("tools/osd-data: the rows of the local system", function () {
  this.timeout(120000);
  const data = new Data();

  // the cross-reference rows are derived from the files and seeded by the
  // runtime this suite boots (tools/osd-xref-seed.mjs), so they are there
  // in a fresh checkout without anybody generating anything first

  it("the system has its tables: ours, the runtime's own, and the cross-reference", async () => {
    const tables = await data.tables();
    expect(tables).to.include("ZSTG_DEMO");
    expect(tables).to.include("CROSS");
    expect(tables).to.include("WBCROSSGT");
    // the runtime carries a system's own catalogue too
    expect(tables).to.include("TADIR");
    expect(tables.length).to.be.greaterThan(50);
  });

  it("reads a table, with the trailing blanks of a CHAR column gone", async () => {
    const answer = await data.table("zstg_demo", {max: 10});
    expect(answer.columns).to.include("travel_id");
    expect(answer.rows.length).to.be.greaterThan(2);
    const first = answer.rows.find((r) => r.travel_id === "T0001");
    expect(first.description).to.equal("Berlin to Copenhagen");
  });

  it("answers the query vsp's graph tools make, word for word", async () => {
    const answer = await data.query("SELECT INCLUDE, NAME FROM WBCROSSGT WHERE NAME LIKE 'CL_ABAP_Z%'");
    expect(answer.rows.map((r) => `${r.name} <- ${r.include}`)).to.include("CL_ABAP_ZIP <- ZCL_STG_SEGW_REPO");
    const calls = await data.query("SELECT INCLUDE FROM CROSS WHERE TYPE = 'F' AND NAME = 'BAPI_TRANSACTION_COMMIT'");
    expect(calls.rows.length).to.be.greaterThan(0);
  });

  it("Open SQL in, SQL out: a comma-less field list and UP TO n ROWS, the way Eclipse writes them", async () => {
    // recorded from Eclipse ADT 3.60 on F8 (.local/capture/live): the
    // preview writes the field list without commas, as a 7.x report does
    expect(openSqlToSql("SELECT T~A T~B FROM T")).to.equal("SELECT T~A, T~B FROM T");
    expect(openSqlToSql("SELECT A, B FROM T"), "commas stay").to.equal("SELECT A, B FROM T");
    expect(openSqlToSql("SELECT * FROM T"), "a star is not a list").to.equal("SELECT * FROM T");
    expect(openSqlToSql("SELECT A FROM T"), "one field is not a list").to.equal("SELECT A FROM T");
    expect(openSqlToSql("SELECT A B FROM T UP TO 5 ROWS")).to.equal("SELECT A, B FROM T LIMIT 5");
    const rows = await data.query("SELECT WBCROSSGT~INCLUDE WBCROSSGT~NAME FROM WBCROSSGT UP TO 2 ROWS");
    expect(rows.rows.length).to.equal(2);
  });

  it("the row limit is applied here, not trusted to the statement", async () => {
    const two = await data.query("SELECT * FROM wbcrossgt", {max: 2});
    expect(two.rows.length).to.equal(2);
    expect(two.truncated).to.equal(true);
    expect(two.sql).to.contain("LIMIT 2");
    // a statement that carries its own limit keeps it
    const own = await data.query("SELECT * FROM wbcrossgt LIMIT 3", {max: 100});
    expect(own.rows.length).to.equal(3);
  });

  it("only a read is allowed through here", async () => {
    for (const sql of ["DELETE FROM zstg_demo", "UPDATE zstg_demo SET status = 'X'", "DROP TABLE zstg_demo"]) {
      let error;
      try {
        await data.query(sql);
      } catch (e) {
        error = e;
      }
      expect(error, sql).to.be.instanceOf(NotAllowed);
      expect(error.code).to.equal("NOT_ALLOWED");
    }
    // and nothing was deleted
    expect((await data.table("zstg_demo")).rows.length).to.be.greaterThan(2);
  });

  it("checks a SELECT by preparing it without fetching rows", async () => {
    await data.check("SELECT travel_id FROM zstg_demo");
    await data.check("SELECT travel_id FROM zstg_demo ORDER BY travel_id DESCENDING");
    await data.check("SELECT travel_id FROM zstg_demo ORDER BY PRIMARY KEY");
    let error;
    try {
      await data.check("SELECT definitely_missing FROM zstg_demo");
    } catch (e) {
      error = e;
    }
    expect(error).to.be.instanceOf(Error);
  });

  it("keeps spaces inside a COUNT expression instead of inventing commas", async () => {
    expect(openSqlToSql("SELECT COUNT( * ) FROM zstg_demo"))
      .to.equal("SELECT COUNT( * ) FROM zstg_demo");
    expect(Object.values((await data.query("SELECT COUNT( * ) FROM zstg_demo")).rows[0])[0])
      .to.be.greaterThan(0);
  });

  it("the store hands out the same data layer, so the façade has one door", async () => {
    const store = new ObjectStore();
    expect(store.data()).to.equal(store.data());
    const answer = await store.data().query("SELECT status, status_text FROM zstg_status");
    expect(answer.rows.map((r) => r.status)).to.include("A");
  });

  it("a caller that already has a runtime hands in its connection", async () => {
    const client = await data.boot();
    const second = new Data({client});
    // no second boot: the same connection answers
    expect(await second.boot()).to.equal(client);
    expect((await second.query("SELECT status FROM zstg_status")).rows.length).to.be.greaterThan(0);
  });
});

describe("web worker read engine", function () {
  this.timeout(120000);
  let readQuery;
  let readRequest;
  let db;
  let client;
  let previewFields;
  before(async () => {
    globalThis.__stgPreviewFreezeTime = false;
    ({readQuery, readRequest} = await import("../web/preview-runtime.mjs"));
    const SQL = await initSqlJs();
    db = new SQL.Database();
    db.run("CREATE TABLE zstg_demo (travel_id TEXT, amount INTEGER, optional TEXT)");
    for (let i = 1; i <= 12; i++) db.run("INSERT INTO zstg_demo VALUES (?, ?, ?)", [`T${i}`, i * 10, i === 1 ? null : "hello  "]);
    db.run("CREATE VIEW zc_stg_demo AS SELECT travel_id, amount FROM zstg_demo");
    const store = new ObjectStore();
    previewFields = {ddic: {ZSTG_DEMO: tableFieldsOf(store, store.read("TABL", "ZSTG_DEMO")).fields},
      cds: {ZC_STG_BOOKING: cdsEntityOf(store, "ZC_STG_BOOKING").fields}};
    client = {select: async ({select}) => {
      const result = db.exec(select.replace(/~/g, "."));
      return {rows: result.length ? result[0].values.map((values) => Object.fromEntries(result[0].columns.map((name, i) => [name, values[i]]))) : []};
    }};
  });
  after(() => db.close());

  it("rewrites UP TO and retains typed values including null", async () => {
    const result = await readQuery(client, "SELECT travel_id amount optional FROM zstg_demo UP TO 5 ROWS", 100);
    expect(result.rows).to.have.length(5);
    expect(result.rows[0]).to.deep.equal({travel_id: "T1", amount: 10, optional: null});
    expect(result.rows[1].optional).to.equal("hello");
  });

  it("answers DDIC and CDS routes in the desktop preview XML shape", async () => {
    for (const [kind, name] of [["ddic", "ddicEntityName"], ["cds", "ddlSourceName"]]) {
      const object = kind === "ddic" ? "ZSTG_DEMO" : "ZC_STG_DEMO";
      const answer = await readRequest(client, {method: "POST", path: `/sap/bc/adt/datapreview/${kind}`,
        search: `?${name}=${object}&rowNumber=2`, body: new TextEncoder().encode("")});
      const xml = new TextDecoder().decode(answer.body);
      expect(answer.status).to.equal(200);
      expect(xml).to.contain('<dataPreview:metadata dataPreview:name="TRAVEL_ID"');
      expect(xml).to.contain("<dataPreview:totalRows>2</dataPreview:totalRows>");
      expect(xml).to.contain("<dataPreview:data>T1</dataPreview:data>");
    }
  });

  it("uses dictionary keys, types and labels, and CDS element names", async () => {
    const ddic = await readRequest(client, {method: "POST", path: "/sap/bc/adt/datapreview/ddic",
      search: "?ddicEntityName=ZSTG_DEMO", body: new Uint8Array()}, previewFields);
    const xml = new TextDecoder().decode(ddic.body);
    expect(xml).to.match(/dataPreview:name="TRAVEL_ID"[^/]*dataPreview:keyAttribute="true"[^/]*dataPreview:colType="CHAR"[^/]*dataPreview:length="8"/);
    const cdsClient = {select: async () => ({rows: [{TRAVELID: "T1"}]})};
    const cds = await readRequest(cdsClient, {method: "POST", path: "/sap/bc/adt/datapreview/cds",
      search: "?ddlSourceName=ZC_STG_BOOKING", body: new Uint8Array()}, previewFields);
    expect(new TextDecoder().decode(cds.body)).to.match(/dataPreview:name="TRAVELID" dataPreview:camelCaseName="TravelId"[^/]*dataPreview:keyAttribute="true"/);
  });

  it("answers the SQLScript cell door with Portable AMDP on DuckDB only", async () => {
    const {DuckDBDatabaseClient} = await import("../tools/duckdb-client.mjs");
    const duck = new DuckDBDatabaseClient({path: ":memory:"});
    await duck.connect();
    const cell = (on) => readRequest(on, {method: "POST", path: "/sap/bc/osd/amdp/cell",
      body: new TextEncoder().encode("lt = SELECT 6*7 AS answer FROM dummy;\nSELECT * FROM :lt;")});
    try {
      const answer = await cell(duck);
      const json = JSON.parse(new TextDecoder().decode(answer.body));
      expect(answer.status).to.equal(200);
      expect(json).to.include({status: "ok", rows: "1", engine: "Portable AMDP (limited) on duckdb", system_db: "duckdb"});
      expect(JSON.parse(json.result)[0]).to.deep.equal({ANSWER: 42});
    } finally {
      await duck.disconnect();
    }
    // sql.js falls through to the ABAP sandbox and its HANA refusal
    expect(await cell(client)).to.equal(undefined);
  });

  it("returns no rows for SQL zero limits with the actual SQLite adapter", async () => {
    const actual = new SQLiteDatabaseClient();
    const previousAbap = globalThis.abap;
    globalThis.abap = {context: {}};
    await actual.connect();
    try {
      await actual.execute("CREATE TABLE zero_test (value INTEGER); INSERT INTO zero_test VALUES (1)");
      for (const sql of ["SELECT * FROM zero_test LIMIT 0", "SELECT * FROM zero_test UP TO 0 ROWS"]) {
        const result = await readQuery(actual, sql, 10);
        expect(result.rows, sql).to.deep.equal([]);
        expect(result.count, sql).to.equal(0);
      }
    } finally {
      await actual.disconnect();
      globalThis.abap = previousAbap;
    }
  });

  it("enforces the cap and returns a clear refusal", async () => {
    expect((await readQuery(client, "SELECT * FROM zstg_demo", 2)).rows).to.have.length(2);
    expect((await readQuery(client, "SELECT * FROM zstg_demo", 100000)).sql).to.match(/LIMIT 1000$/);
    const refused = await readRequest(client, {method: "POST", path: "/osd/sql",
      body: new TextEncoder().encode(JSON.stringify({sql: "DELETE FROM zstg_demo"}))});
    expect(refused.status).to.equal(400);
    expect(JSON.parse(new TextDecoder().decode(refused.body)).error.code).to.equal("NOT_ALLOWED");
  });
});

// Node 22 closed an idle keep-alive socket to the serving child just as the
// parent reused it for /osd/sql ("other side closed"): osg-demo's CI saw a
// CDS data preview answer 400 "fetch failed" after three table previews.
describe("tools/osd-data: a read door survives a closed keep-alive socket", () => {
  const closed = () => Object.assign(new TypeError("fetch failed"), {cause: {code: "UND_ERR_SOCKET"}});
  it("retries once when the pooled socket was closed under it", async () => {
    let calls = 0;
    const answer = await readDoor("http://x/osd/sql", {}, async () => { calls += 1; if (calls === 1) throw closed(); return "ok"; });
    expect(answer).to.equal("ok");
    expect(calls).to.equal(2);
  });
  it("does not retry any other failure, and gives up after one retry", async () => {
    let calls = 0;
    const other = await readDoor("http://x", {}, async () => { calls += 1; throw new TypeError("fetch failed"); }).catch((e) => e);
    expect(other).to.be.instanceOf(TypeError);
    expect(calls).to.equal(1);
    calls = 0;
    const twice = await readDoor("http://x", {}, async () => { calls += 1; throw closed(); }).catch((e) => e);
    expect(twice.cause.code).to.equal("UND_ERR_SOCKET");
    expect(calls).to.equal(2);
  });
});
