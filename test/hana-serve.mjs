import {expect} from "chai";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {HanaDatabaseClient} from "../tools/hana-client.mjs";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {batchParts, batchRefusal, checkTrace, clientRefusal, countWrites, isShadowDdl, parseApps, parseRegistrations, refusal, rfcRefusal, runtimeText, staticFile, TRACE_PROBE_SQL} from "../tools/hana-serve.mjs";
import {installBindStructureLog} from "../tools/osd-bind-structure-log.mjs";
import {installSqlTrace, readTrace} from "../tools/osd-sql-trace.mjs";

// tools/hana-serve.mjs, the minimal read-only host over an existing HANA
// schema, without a HANA: the host runs as a child over the generation in
// output/ with a FAKE DatabaseClient (test/fixtures/hana-serve/
// fake-client.mjs: reads from tables.json, every write throws). The
// service is the demo's ZSTG_DEMO_SRV, registered by the generated SEGW
// registry like any other.
//
// What the host promises, each checked here:
//   - $metadata and a GET under /sap/opu/odata/sap/ AND under a namespace
//     prefix, answered by the ABAP request path, the entries naming the
//     prefix they were read under;
//   - 405 for anything but GET, HEAD and a $batch of GETs; a $batch with
//     any other part refused whole, before the ABAP;
//   - HEAD answered like the GET (a CSRF fetch gets its token), no body;
//   - another sap-client than OSD_CLIENT refused with 400;
//   - the static files of webapp/ under /app/;
//   - a boot that writes nothing (the fake would throw; the host counts);
//   - OSD_SQL_TRACE=1 writes a trace that carries its positive control,
//     and --check-trace fails one that does not.
// Mutation, measured when this was written: one write added to the boot
// (a db.insert after the registry) and this suite goes red at "boots".
// Mutation (milestone 3 fix round), measured: the realpath containment in
// staticFile removed -> the symlink cases of "serves a static file only
// from inside the mount's real path" and of the live --app mount go red.
// Mutation (milestone 3), measured: the batchRefusal check in serve()
// removed -> "refuses a $batch with a POST part ... before the ABAP" goes
// red (the batch is answered and its GET part reached the database).
const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "output");
const tool = join(root, "tools", "hana-serve.mjs");

describe("hana-serve: the pure parts", () => {
  it("refuses every environment that is not read-only existing-schema mode", () => {
    const ok = {HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100"};
    expect(refusal(ok)).to.equal(undefined);
    expect(refusal({...ok, STG_DB: "hana"})).to.equal(undefined);
    expect(refusal({OSD_CLIENT: "100"})).to.match(/existing-schema mode/);
    expect(refusal({HANA_EXISTING_SCHEMA: "1"})).to.match(/OSD_CLIENT/);
    expect(refusal({...ok, STG_DB: "sqlite"})).to.match(/STG_DB is sqlite/);
    expect(refusal({...ok, OSD_HANA_WRITE: "1"})).to.match(/read-only/);
    expect(refusal({...ok, STG_DB_FRESH: "1"})).to.match(/DROP SCHEMA/);
    expect(refusal({...ok, STG_RFC_PROXY: "ZOSD_B3_DEST"})).to.match(/STG_RFC_PROXY/);
    expect(refusal({...ok, STG_TABLE_PROXY: "ZOSD_B3_DEST"})).to.match(/STG_TABLE_PROXY/);
  });

  it("refuses an outbound RFC destination, keeps local and replay", () => {
    expect(rfcRefusal({})).to.equal(undefined);
    expect(rfcRefusal({ZOSD_B3_LOCAL: {kind: "local"}, ZOSD_B3_REPLAY: {kind: "replay"}})).to.equal(undefined);
    for (const kind of ["live", "record", "fallback"]) {
      expect(rfcRefusal({ZOSD_B3_OUT: {kind}}), kind).to.match(new RegExp(`ZOSD_B3_OUT \\(${kind}\\)`));
    }
  });

  it("admits shadow DDL only on the own schema, and none without one (fail closed)", () => {
    const own = `CREATE SYNONYM "OSDB3OWN"."ZOSD_B3_T" FOR "OSDB3TENANT"."ZOSD_B3_T"`;
    const tenant = `CREATE VIEW "OSDB3TENANT"."ZOSD_B3_T_SH" AS SELECT * FROM "OSDB3TENANT"."ZOSD_B3_T"`;
    expect(isShadowDdl(own, "OSDB3OWN")).to.equal(true);
    expect(isShadowDdl(own, "osdb3own")).to.equal(true);
    expect(isShadowDdl(tenant, "OSDB3OWN")).to.equal(false);
    for (const none of [undefined, "", "  "]) {
      expect(isShadowDdl(own, none)).to.equal(false);
      expect(isShadowDdl(tenant, none)).to.equal(false);
    }
  });

  it("counts writes on the interface, and our shadow DDL is not one", async () => {
    const client = {
      async execute() {}, async insert() {}, async update() {}, async delete() {}, async select() { return {rows: []}; },
    };
    const stats = countWrites(client, {ownSchema: "OSDB3OWN"});
    await client.select({select: "SELECT 1 FROM dummy"});
    await client.execute(`CREATE VIEW "OSDB3OWN"."ZOSD_B3_T" AS SELECT * FROM "OSDB3TENANT"."ZOSD_B3_T"`);
    await client.execute("SET SCHEMA \"OSDB3OWN\"");
    expect(stats.writes).to.deep.equal([]);
    await client.execute(`CREATE VIEW "OSDB3TENANT"."ZOSD_B3_T" AS SELECT 1 FROM dummy`);
    await client.insert({table: "zosd_b3_t", columns: [], values: []});
    await client.execute("SELECT 1 FROM dummy; DELETE FROM zosd_b3_t");
    expect(stats.writes.map((w) => w.kind)).to.deep.equal(["CREATE", "INSERT", "MULTI"]);
  });

  it("judges a trace by its positive control on every channel, and by its writes", () => {
    const probe = {op: "select", sql: TRACE_PROBE_SQL};
    expect(checkTrace([]).ok).to.equal(false);
    expect(checkTrace([]).problems[0]).to.match(/not on/);
    // a trace with reads and no control proves nothing
    const noControl = checkTrace([{op: "select", sql: "SELECT * FROM zosd_b3_t"}]);
    expect(noControl.ok).to.equal(false);
    expect(noControl.problems.join(" ")).to.match(/positive control .* missing on channel api/);
    expect(checkTrace([probe, {op: "commit", sql: ""}]).ok).to.equal(true);
    // the driver channel needs its own control
    const driverBlind = checkTrace([probe, {op: "driver", sql: "SET SCHEMA \"OSDB3OWN\""}]);
    expect(driverBlind.ok).to.equal(false);
    expect(driverBlind.problems.join(" ")).to.match(/missing on channel driver/);
    const both = checkTrace([probe, {op: "driver", sql: TRACE_PROBE_SQL},
      {op: "driver", sql: `CREATE SYNONYM "OSDB3OWN"."ZOSD_B3_T" FOR "OSDB3TENANT"."ZOSD_B3_T"`}], {ownSchema: "OSDB3OWN"});
    expect(both).to.include({ok: true, shadowDdl: 1});
    const wrote = checkTrace([probe, {op: "insert", sql: "INSERT INTO zosd_b3_t", table: "ZOSD_B3_T"}]);
    expect(wrote.ok).to.equal(false);
    expect(wrote.writes).to.deep.equal([{channel: "api", op: "insert", kind: "INSERT", table: "ZOSD_B3_T"}]);
    // an attempt the client refused: asked for, not sent -- listed apart,
    // and still a failed verdict
    const tried = checkTrace([probe, {op: "insert", sql: "INSERT INTO zosd_b3_t", table: "ZOSD_B3_T", error: "HANA_READONLY"}]);
    expect(tried.writes).to.deep.equal([]);
    expect(tried.refused).to.deep.equal([{channel: "api", op: "insert", kind: "INSERT", table: "ZOSD_B3_T", error: "HANA_READONLY"}]);
    expect(tried.ok).to.equal(false);
    expect(tried.problems.join(" ")).to.match(/1 write attempt\(s\) refused by the client \(HANA_READONLY\): asked for, not sent/);
  });

  it("records a refused call in the interface trace with its error code", async () => {
    const entries = [];
    const client = installSqlTrace({
      async insert() { const e = new Error("refused"); e.code = "HANA_READONLY"; throw e; },
      async select() { return {rows: [{probe: "OSD_TRACE_PROBE"}]}; },
    }, (entry) => entries.push(entry));
    await client.select({select: TRACE_PROBE_SQL});
    await client.insert({table: "zosd_b3_t", columns: ["mandt"], values: ["'100'"]}).catch(() => undefined);
    expect(entries.map((e) => [e.op, e.error])).to.deep.equal([["select", undefined], ["insert", "HANA_READONLY"]]);
    const verdict = checkTrace(entries);
    expect(verdict.writes).to.deep.equal([]);
    expect(verdict.refused.map((r) => r.error)).to.deep.equal(["HANA_READONLY"]);
  });

  it("marks a refused write in the boot tally, and keeps one tally across clients", async () => {
    const refusing = () => ({async insert() { const e = new Error("no"); e.code = "FAKE_READONLY"; throw e; }, async select() { return {rows: []}; }});
    const stats = {statements: 0, writes: []};
    const a = refusing();
    const b = refusing();
    countWrites(a, {stats});
    countWrites(b, {stats});
    await a.insert({table: "zosd_b3_t"}).catch(() => undefined);
    await b.select({select: "SELECT 1 FROM dummy"});
    expect(stats).to.deep.equal({statements: 2, writes: [{method: "insert", kind: "INSERT", refused: "FAKE_READONLY"}]});
  });

  it("judges a trace with tenant DDL a write, own schema given or not (the critic's reproducer, synthetic names)", async () => {
    const fixture = join(root, "test", "fixtures", "hana-serve", "tenant-ddl-trace.ndjson");
    const entries = readTrace(fixture);
    for (const ownSchema of [undefined, "OSDB3OWN"]) {
      const verdict = checkTrace(entries, {ownSchema});
      expect(verdict.ok, String(ownSchema)).to.equal(false);
      expect(verdict.writes.map((w) => w.kind), String(ownSchema)).to.deep.equal(["CREATE"]);
      expect(verdict.shadowDdl).to.equal(0);
    }
    const bare = await traceCli(fixture, {});
    expect(bare.code).to.equal(1);
    expect(bare.out).to.contain("own schema: none given");
    expect(bare.err).to.match(/no own schema given/);
    const withEnv = await traceCli(fixture, {HANA_OWN_SCHEMA: "OSDB3OWN"});
    expect(withEnv.code).to.equal(1);
    expect(withEnv.out).to.contain("write: driver driver CREATE");
  });

  it("admits own-schema shadow DDL only when the own schema is given", async () => {
    const fixture = join(root, "test", "fixtures", "hana-serve", "own-ddl-trace.ndjson");
    expect(checkTrace(readTrace(fixture), {ownSchema: "OSDB3OWN"})).to.include({ok: true, shadowDdl: 1});
    expect(checkTrace(readTrace(fixture), {}).ok).to.equal(false);
    expect((await traceCli(fixture, {HANA_OWN_SCHEMA: "OSDB3OWN"})).code).to.equal(0);
    expect((await traceCli(fixture, {}, ["--own-schema", "OSDB3OWN"])).code).to.equal(0);
    expect((await traceCli(fixture, {})).code).to.equal(1);
  });
});

describe("hana-serve: the driver channel of the HANA client", () => {
  // the real HanaDatabaseClient over a fake hdb driver (the stand-in of
  // test/hana-shadow-schema.mjs, through the CJS cache, given back after):
  // the sqlTrace option sees what the driver is handed -- connect()'s own
  // shadow DDL and SET SCHEMA, which no wrapper of the eleven members sees,
  // and the folded text of a read -- and never a statement the guard refused
  afterEach(() => {
    const req = createRequire(import.meta.url);
    delete req.cache[req.resolve("hdb")];
  });

  it("traces what reaches the driver, the probe included, and nothing the guard refused", async () => {
    const req = createRequire(import.meta.url);
    const path = req.resolve("hdb");
    const sent = [];
    req.cache[path] = {id: path, filename: path, loaded: true, exports: {createClient: () => ({
      connect: (cb) => cb(undefined),
      setAutoCommit: () => undefined,
      exec: (sql, cb) => {
        sent.push(sql);
        if (/^\s*SELECT/i.test(sql) === false) return cb(undefined, 1);
        // the tenant's catalog holds the one table; our own schema is empty
        if (/FROM SYS\.TABLES/i.test(sql)) return cb(undefined, /'ZOSD_B3_T'/.test(sql) ? [{TABLE_NAME: "ZOSD_B3_T"}] : []);
        if (/SYS\.(VIEWS|SYNONYMS)/i.test(sql)) return cb(undefined, []);
        // the client column is the table's own key field of type CLNT (DD03L)
        if (/"DD03L"/i.test(sql)) return cb(undefined, [{TABNAME: "ZOSD_B3_T", POSITION: "0001", FIELDNAME: "MANDT", KEYFLAG: "X", DATATYPE: "CLNT"}]);
        if (/DD02L/i.test(sql)) return cb(undefined, [{TABNAME: "ZOSD_B3_T", CLIDEP: "X"}]);
        if (sql.includes("OSD_TRACE_PROBE")) return cb(undefined, [{PROBE: "OSD_TRACE_PROBE"}]);
        return cb(undefined, []);
      },
      commit: (cb) => cb(undefined),
      rollback: (cb) => cb(undefined),
      end: () => undefined,
    })}};
    const driver = [];
    // connect() says sy-mandt and sy-dbsys to the runtime it finds on
    // globalThis -- in a shard that also loads the inline server
    // (test/mocha.mjs) that is a live system, so it must not find one
    const runtime = globalThis.abap;
    globalThis.abap = undefined;
    const db = new HanaDatabaseClient({existingSchema: true, readOnly: true, schema: "OSDB3TENANT", ownSchema: "OSDB3OWN",
      client: "100", shadowTables: ["ZOSD_B3_T"], sqlTrace: (sql) => driver.push(sql)});
    await db.connect();
    try {
      const probe = await db.select({select: TRACE_PROBE_SQL});
      expect(probe.rows).to.deep.equal([{probe: "OSD_TRACE_PROBE"}]);
      let refused;
      await db.insert({table: "zosd_b3_t", columns: ["mandt"], values: ["'100'"]}).catch((e) => { refused = e; });
      expect(refused?.code).to.equal("HANA_READONLY");
    } finally {
      await db.disconnect();
      globalThis.abap = runtime;
    }
    // the trace is exactly what the driver was handed
    expect(driver).to.deep.equal(sent);
    expect(driver).to.include(`SET SCHEMA "OSDB3OWN"`);
    expect(driver.some((s) => /^CREATE VIEW "OSDB3OWN"\."ZOSD_B3_T"/.test(s))).to.equal(true);
    expect(driver.some((s) => /INSERT/i.test(s))).to.equal(false);
    // and as a trace, beside its api line, it passes the check
    const entries = [{op: "select", sql: TRACE_PROBE_SQL}, ...driver.map((sql) => ({op: "driver", sql}))];
    const verdict = checkTrace(entries, {ownSchema: "OSDB3OWN"});
    expect(verdict.problems).to.deep.equal([]);
    expect(verdict.shadowDdl).to.equal(1);
    expect(verdict.channels.driver.probe).to.equal(true);
  });
});

describe("bind_structure made loud (tools/osd-bind-structure-log.mjs)", () => {
  // a runtime stand-in: two model classes and a describe_by_name that
  // knows one structure, one element and nothing else
  const fakeAbap = () => {
    const calls = [];
    class Entity {
      async $iwbep$if_mgw_odata_entity_typ$bind_structure(INPUT) { calls.push(`entity ${INPUT.iv_structure_name}`); return "kept"; }
    }
    class Complex {
      async $iwbep$if_mgw_odata_cmplx_type$bind_structure(INPUT) { calls.push(`complex ${INPUT.iv_structure_name}`); }
    }
    const known = {ZOSD_B3_STRUCT: "S", ZOSD_B3_ELEM: "E"};
    return {
      calls,
      types: {String: class { set(v) { this.v = v; return this; } get() { return this.v; } }},
      Classes: {
        ZCL_OAO_ENTITY_TYP: Entity,
        ZCL_OAO_CMPLX_TYPE: Complex,
        CL_ABAP_TYPEDESCR: {
          async describe_by_name({p_name}) {
            const kind = known[p_name.get()];
            if (kind === undefined) throw {classic: "TYPE_NOT_FOUND"};
            return {get: () => ({kind: {get: () => kind}})};
          },
        },
      },
    };
  };

  it("changes nothing for the caller and counts what is not found", async () => {
    const abap = fakeAbap();
    const log = installBindStructureLog(abap);
    expect(log.installed).to.deep.equal(["ZCL_OAO_ENTITY_TYP", "ZCL_OAO_CMPLX_TYPE"]);
    const entity = new abap.Classes.ZCL_OAO_ENTITY_TYP();
    // found: the original runs and answers as before
    expect(await entity.$iwbep$if_mgw_odata_entity_typ$bind_structure({iv_structure_name: "ZOSD_B3_STRUCT"})).to.equal("kept");
    expect(log.line()).to.equal("bind_structure: 0 of 1 not found");
    await entity.$iwbep$if_mgw_odata_entity_typ$bind_structure({iv_structure_name: "zosd_b3_missing"});
    await new abap.Classes.ZCL_OAO_CMPLX_TYPE().$iwbep$if_mgw_odata_cmplx_type$bind_structure({iv_structure_name: "ZOSD_B3_ELEM"});
    // a second bind of a known name is not a second entry
    await entity.$iwbep$if_mgw_odata_entity_typ$bind_structure({iv_structure_name: "ZOSD_B3_STRUCT"});
    expect(abap.calls).to.deep.equal(["entity ZOSD_B3_STRUCT", "entity zosd_b3_missing", "complex ZOSD_B3_ELEM", "entity ZOSD_B3_STRUCT"]);
    expect(log.calls).to.equal(4);
    expect(log.line()).to.equal("bind_structure: 2 of 3 not found: ZOSD_B3_MISSING (type_not_found), ZOSD_B3_ELEM (kind E, not a structure)");
    // idempotent: a second install does not wrap twice
    expect(installBindStructureLog(abap)).to.equal(log);
  });
});

describe("hana-serve: one client, GET-only $batch (the pure parts)", () => {
  const batch = (parts, boundary = "batch_1") => `${parts.map((p) => `--${boundary}\r\n${p}`).join("")}--${boundary}--\r\n`;
  const get = (url) => `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ${url} HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n`;
  const post = (url) => `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nPOST ${url} HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{}\r\n`;
  const changeset = (inner) => `Content-Type: multipart/mixed; boundary=changeset_1\r\n\r\n${batch([inner], "changeset_1")}\r\n`;
  const type = "multipart/mixed; boundary=batch_1";

  it("refuses another client, by URL option or header, and lets this one and none through", () => {
    expect(clientRefusal({query: {}}, "100")).to.equal(undefined);
    expect(clientRefusal({query: {"sap-client": "100"}}, "100")).to.equal(undefined);
    expect(clientRefusal({query: {"sap-client": ""}}, "100")).to.equal(undefined);
    expect(clientRefusal({query: {"sap-client": "200"}}, "100")).to.match(/serves client 100 only .* sap-client=200/);
    expect(clientRefusal({query: {"sap-client": ["100", "200"]}}, "100")).to.match(/sap-client=200/);
    expect(clientRefusal({headers: {"sap-client": "999"}}, "100")).to.match(/sap-client=999/);
    expect(clientRefusal({headers: {cookie: "a=1; sap-client=200"}}, "100")).to.match(/sap-client=200/);
    expect(clientRefusal({headers: {cookie: "a=1; SAP-CLIENT=100"}}, "100")).to.equal(undefined);
  });

  it("reads the parts of a batch, a changeset as one part", () => {
    expect(batchParts(type, batch([get("PartnerSet?$top=2"), get("PartnerSet/$count")]))).to.deep.equal([
      {changeset: false, type: "application/http", method: "GET", url: "PartnerSet?$top=2", headers: {accept: "application/json"}},
      {changeset: false, type: "application/http", method: "GET", url: "PartnerSet/$count", headers: {accept: "application/json"}},
    ]);
    expect(batchParts(type, batch([changeset(post("PartnerSet"))])).map((p) => p.changeset)).to.deep.equal([true]);
    expect(batchParts("multipart/mixed", "")).to.equal(undefined);
    // a quoted boundary, LF line ends
    expect(batchParts("multipart/mixed; boundary=\"b q\"", "--b q\nContent-Type: application/http\n\nGET A HTTP/1.1\n\n--b q--\n")).to.deep.equal([
      {changeset: false, type: "application/http", method: "GET", url: "A", headers: {}},
    ]);
  });

  it("admits a batch of GETs only: a POST part, a changeset, no part or no boundary refuse the whole", () => {
    expect(batchRefusal(type, batch([get("PartnerSet?$top=2"), get("PartnerSet/$count")]), "100")).to.equal(undefined);
    expect(batchRefusal(type, batch([get("PartnerSet"), post("PartnerSet")]), "100")).to.deep.equal({status: 405, message: "hana-serve is read-only: part 2 of this $batch is POST, not GET; the whole batch is refused"});
    expect(batchRefusal(type, batch([changeset(get("PartnerSet"))]), "100").message).to.match(/part 1 of this \$batch is a changeset/);
    expect(batchRefusal(type, "--batch_1--\r\n", "100")).to.deep.equal({status: 400, message: "hana-serve: a $batch without a part"});
    expect(batchRefusal("application/json", "{}", "100").status).to.equal(400);
    expect(batchRefusal(type, batch([get("PartnerSet?sap-client=200")]), "100")).to.deep.include({status: 400});
    // a part's own headers: another client, a method override
    const withHeader = (name, value) => `Content-Type: application/http\r\n\r\nGET PartnerSet HTTP/1.1\r\n${name}: ${value}\r\n\r\n\r\n`;
    expect(batchRefusal(type, batch([withHeader("SAP-CLIENT", "200")]), "100")).to.deep.include({status: 400});
    expect(batchRefusal(type, batch([withHeader("Cookie", "sap-client=200")]), "100")).to.deep.include({status: 400});
    expect(batchRefusal(type, batch([withHeader("sap-client", "100")]), "100")).to.equal(undefined);
    for (const name of ["X-HTTP-Method", "X-HTTP-Method-Override"]) {
      expect(batchRefusal(type, batch([withHeader(name, "DELETE")]), "100").message).to.match(/carries x-http-method/);
    }
    // an absolute part URL stays inside the batched service
    const own = "/sap/opu/odata/sap/ZOSD_H5X_APP_SRV";
    expect(batchRefusal(type, batch([get("PartnerSet")]), "100", own)).to.equal(undefined);
    expect(batchRefusal(type, batch([get(`${own}/PartnerSet`)]), "100", own)).to.equal(undefined);
    expect(batchRefusal(type, batch([get("/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$top=1")]), "100", own).message).to.match(/outside the batched service/);
    expect(batchRefusal(type, batch([get(`${own}X/PartnerSet`)]), "100", own).status).to.equal(400);
    expect(batchRefusal(type, batch([get("http://elsewhere/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet")]), "100", own).status).to.equal(400);
  });

  it("serves a static file only from inside the mount's real path, never a dotfile", () => {
    const top = mkdtempSync(join(tmpdir(), "hana-serve-static-"));
    try {
      const mount = join(top, "mount");
      mkdirSync(join(mount, "sub"), {recursive: true});
      writeFileSync(join(mount, "index.html"), "in");
      writeFileSync(join(mount, "sub", "a.json"), "{}");
      writeFileSync(join(mount, ".secret"), "dot");
      writeFileSync(join(top, "outside.txt"), "SECRET");
      symlinkSync(join(top, "outside.txt"), join(mount, "escape.txt"));
      symlinkSync(top, join(mount, "up"));
      symlinkSync(join(mount, "sub", "a.json"), join(mount, "inner.json"));
      expect(staticFile(mount, "/index.html")).to.match(/index\.html$/);
      expect(staticFile(mount, "/sub/a.json")).to.match(/a\.json$/);
      // a symlink that stays inside is followed
      expect(staticFile(mount, "/inner.json")).to.match(/sub.a\.json$/);
      // out of the mount: refused, by file and by directory link
      expect(staticFile(mount, "/escape.txt")).to.equal(undefined);
      expect(staticFile(mount, "/up/outside.txt")).to.equal(undefined);
      // dotfiles, dot segments, encodings, NUL, directories, nothing
      for (const rel of ["/.secret", "/../outside.txt", "/%2e%2e/outside.txt", "/sub/%2E%2E/%2E%2E/outside.txt", "/index.html%00", "/sub", "/", "/%zz"]) {
        expect(staticFile(mount, rel), rel).to.equal(undefined);
      }
    } finally {
      rmSync(top, {recursive: true, force: true});
    }
  });

  it("says what a runtime error was, an ABAP exception without a message included", () => {
    expect(runtimeText(new Error("boom"))).to.equal("boom");
    class cx_sy_dynamic_osql_semantics {}
    expect(runtimeText(new cx_sy_dynamic_osql_semantics())).to.equal("CX_SY_DYNAMIC_OSQL_SEMANTICS raised and not caught");
  });

  it("parses --register and --app", () => {
    expect(parseRegistrations(["zosd_x_srv=ZCL_X_MPC,zcl_x_dpc"])).to.deep.equal([{service: "ZOSD_X_SRV", mpc: "ZCL_X_MPC", dpc: "ZCL_X_DPC"}]);
    expect(() => parseRegistrations(["ZOSD_X_SRV=ZCL_X_MPC"])).to.throw(/--register takes/);
    expect(parseApps(["bed=../private/app"])).to.deep.equal([{name: "bed", dir: "../private/app"}]);
    expect(() => parseApps(["../x"])).to.throw(/--app takes/);
  });
});

describe("hana-serve over a fake DatabaseClient", function () {
  this.timeout(180000);
  let child;
  let base;
  let lines = [];
  let dir;
  let traceFile;
  let fakeLog;

  before(async function () {
    if (!existsSync(join(output, "init.mjs"))) this.skip();
    dir = mkdtempSync(join(tmpdir(), "hana-serve-"));
    traceFile = join(dir, "trace.ndjson");
    fakeLog = join(dir, "fake.log");
    // an --app mount with a symlink pointing out of it
    mkdirSync(join(dir, "bed"));
    writeFileSync(join(dir, "bed", "index.html"), "bed page");
    writeFileSync(join(dir, "bed", ".hidden"), "dot");
    writeFileSync(join(dir, "outside.txt"), "OUTSIDE-SECRET");
    symlinkSync(join(dir, "outside.txt"), join(dir, "bed", "escape.txt"));
    const env = {...process.env};
    for (const name of ["STG_DB", "STG_SQL_TRACE", "STG_DB_TRACE", "OSD_HANA_WRITE", "STG_DB_FRESH", "OSD_BIND", "STG_TABLE_PROXY", "STG_RFC_PROXY"]) delete env[name];
    Object.assign(env, {
      HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", HANA_SCHEMA: "OSDB3TENANT", HANA_OWN_SCHEMA: "OSDB3OWN",
      OSD_SQL_TRACE: "1", OSD_SQL_TRACE_FILE: traceFile, OSD_OUTPUT: output, FAKE_CLIENT_LOG: fakeLog,
    });
    child = spawn(process.execPath, [tool, "--port", "0", "--client-module", "test/fixtures/hana-serve/fake-client.mjs", "--app", `bed=${join(dir, "bed")}`],
      {cwd: root, env, stdio: ["ignore", "pipe", "pipe"]});
    base = await new Promise((resolve, reject) => {
      const take = (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (line === "") continue;
          lines.push(line);
          const m = /listening on (http:\/\/\S+?)\/sap\/opu\/odata\//.exec(line);
          if (m) resolve(m[1]);
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("exit", (code) => reject(new Error(`hana-serve exited ${code} before listening:\n${lines.join("\n")}`)));
    });
  });

  after(async () => {
    if (child !== undefined && child.exitCode === null) {
      const gone = new Promise((done) => child.once("exit", done));
      child.kill("SIGTERM");
      await gone;
    }
    if (dir !== undefined) rmSync(dir, {recursive: true, force: true});
  });

  it("boots without a write and says it is not HANA", () => {
    expect(lines.join("\n")).to.contain("DATABASE IS NOT HANA");
    expect(lines.join("\n")).to.match(/booted over client 100, \d+ statement\(s\), 0 writes/);
    expect(base).to.match(/^http:\/\/127\.0\.0\.1:\d+$/); // loopback by default
  });

  for (const prefix of ["/sap/opu/odata/sap", "/sap/opu/odata/OSDNS"]) {
    it(`answers $metadata and a GET under ${prefix}/`, async () => {
      const metadata = await fetch(`${base}${prefix}/ZSTG_DEMO_SRV/$metadata`);
      expect(metadata.status).to.equal(200);
      const xml = await metadata.text();
      expect(xml).to.contain(`<EntitySet Name="TravelSet" EntityType="ZSTG_DEMO_SRV.Travel"`);
      const list = await fetch(`${base}${prefix}/ZSTG_DEMO_SRV/TravelSet?$format=json&$select=TravelId,Description`);
      expect(list.status).to.equal(200);
      const body = await list.json();
      expect(body.d.results.map((r) => r.TravelId)).to.deep.equal(["T0101", "T0102"]);
      expect(body.d.results[0].Description).to.equal("Fixture trip one");
      // the entry names the address it was read under
      expect(body.d.results[0].__metadata.uri).to.equal(`${base}${prefix}/ZSTG_DEMO_SRV/TravelSet('T0101')`);
    });
  }

  it("prints the bind_structure count after a $metadata", () => {
    // the demo binds four structures and every one resolves (the first run
    // of this log found TS_STATUS_VH bound where the type is TS_STATUSVH)
    expect(lines).to.include("bind_structure: 0 of 4 not found");
  });

  it("refuses to boot with an outbound RFC destination configured", async () => {
    const file = join(dir, "destinations.json");
    writeFileSync(file, JSON.stringify({ZOSD_B3_OUT: {kind: "live"}}));
    const env = {...process.env, HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", OSD_OUTPUT: output, STG_RFC_DESTINATIONS: file};
    delete env.STG_DB;
    const answer = await new Promise((resolve) => {
      const child = spawn(process.execPath, [tool, "--port", "0", "--client-module", "test/fixtures/hana-serve/fake-client.mjs"], {cwd: root, env});
      let err = "";
      child.stderr.on("data", (c) => { err += c; });
      child.on("exit", (code) => resolve({code, err}));
    });
    expect(answer.code).to.equal(1);
    expect(answer.err).to.match(/refuses outbound RFC destinations: ZOSD_B3_OUT \(live\)/);
  });

  const demoReads = () => (existsSync(fakeLog) ? readFileSync(fakeLog, "utf8").split("\n").filter((l) => l === "select zstg_demo").length : 0);
  const boundary = "batch_b6";
  const batchOf = (parts) => `${parts.map((p) => `--${boundary}\r\n${p}`).join("")}--${boundary}--\r\n`;
  const getPart = (url) => `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nGET ${url} HTTP/1.1\r\nAccept: application/json\r\n\r\n\r\n`;
  const postBatch = (body) => fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$batch`, {method: "POST", headers: {"content-type": `multipart/mixed; boundary=${boundary}`, "x-csrf-token": "open-steamgate"}, body});

  it("answers HEAD with a CSRF fetch like the ordinary server: the token, no body", async () => {
    const answer = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/`, {method: "HEAD", headers: {"x-csrf-token": "Fetch"}});
    expect(answer.status).to.equal(200);
    expect(answer.headers.get("x-csrf-token")).to.equal("open-steamgate");
    expect(await answer.text()).to.equal("");
    const set = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet`, {method: "HEAD"});
    expect(set.status).to.equal(200);
  });

  it("answers a $batch whose parts are all GETs, through the ABAP", async () => {
    const before = demoReads();
    const answer = await postBatch(batchOf([getPart("TravelSet?$top=1&$format=json"), getPart("TravelSet/$count")]));
    expect(answer.status).to.equal(202);
    const text = await answer.text();
    expect(text.match(/HTTP\/1\.1 200/g)?.length).to.equal(2);
    expect(text).to.contain("T0101");
    expect(demoReads()).to.be.greaterThan(before);
  });

  it("refuses a $batch with a POST part or a changeset whole, before the ABAP", async () => {
    const before = demoReads();
    const post = `Content-Type: application/http\r\nContent-Transfer-Encoding: binary\r\n\r\nPOST TravelSet HTTP/1.1\r\nContent-Type: application/json\r\n\r\n{"TravelId":"T0999"}\r\n`;
    const mixed = await postBatch(batchOf([getPart("TravelSet?$top=1"), post]));
    expect(mixed.status).to.equal(405);
    expect((await mixed.json()).error).to.deep.include({code: "OSD/READ_ONLY"});
    const changeset = `Content-Type: multipart/mixed; boundary=cs_b6\r\n\r\n--cs_b6\r\n${post}--cs_b6--\r\n\r\n`;
    const cs = await postBatch(batchOf([getPart("TravelSet?$top=1"), changeset]));
    expect(cs.status).to.equal(405);
    // the GET part beside it never ran: the database saw no read of it
    expect(demoReads()).to.equal(before);
  });

  it("answers a GET function import as a read and refuses a POST one before the ABAP", async () => {
    // TravelCount is the demo's GET import (a SELECT COUNT); CancelTravel
    // writes and is a POST, refused by the method rule, never dispatched
    const count = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelCount?Status='A'&$format=json`);
    expect(count.status).to.equal(200);
    const before = demoReads();
    const cancel = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/CancelTravel?TravelId='T0101'`, {method: "POST", headers: {"x-csrf-token": "open-steamgate"}});
    expect(cancel.status).to.equal(405);
    const inBatch = `Content-Type: application/http\r\n\r\nPOST CancelTravel?TravelId='T0101' HTTP/1.1\r\n\r\n\r\n`;
    expect((await postBatch(batchOf([inBatch]))).status).to.equal(405);
    expect(demoReads()).to.equal(before);
  });

  it("refuses a method override on a request or in a batch part, and a part outside the service", async () => {
    const override = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet`, {headers: {"x-http-method": "DELETE"}});
    expect(override.status).to.equal(405);
    const before = demoReads();
    const part = `Content-Type: application/http\r\n\r\nGET TravelSet?$top=1 HTTP/1.1\r\nX-HTTP-Method-Override: MERGE\r\n\r\n\r\n`;
    expect((await postBatch(batchOf([part]))).status).to.equal(405);
    const elsewhere = await postBatch(batchOf([getPart("/sap/opu/odata/sap/ZSTG_SADL_SRV/SomeSet")]));
    expect(elsewhere.status).to.equal(400);
    expect(demoReads()).to.equal(before);
  });

  it("refuses another sap-client with 400 and answers its own", async () => {
    const other = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json&sap-client=200`);
    expect(other.status).to.equal(400);
    expect((await other.json()).error).to.deep.include({code: "OSD/CLIENT"});
    const header = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json`, {headers: {"sap-client": "999"}});
    expect(header.status).to.equal(400);
    const cookie = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json`, {headers: {cookie: "sap-client=200"}});
    expect(cookie.status).to.equal(400);
    const part = `Content-Type: application/http\r\n\r\nGET TravelSet?$top=1 HTTP/1.1\r\nSAP-CLIENT: 200\r\n\r\n\r\n`;
    expect((await postBatch(batchOf([part]))).status).to.equal(400);
    const own = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$format=json&sap-client=100`);
    expect(own.status).to.equal(200);
  });

  it("serves the static files of webapp/ under /app/, and an --app mount without following a symlink out of it", async () => {
    const manifest = await fetch(`${base}/app/h5x/manifest.json`);
    expect(manifest.status).to.equal(200);
    expect((await manifest.json())["sap.app"].id).to.equal("osd.h5x");
    expect((await fetch(`${base}/app/h5x/none.json`)).status).to.equal(404);
    expect((await fetch(`${base}/app/bed/index.html`)).status).to.equal(200);
    expect(await (await fetch(`${base}/app/bed/index.html`)).text()).to.equal("bed page");
    const escape = await fetch(`${base}/app/bed/escape.txt`);
    expect(escape.status).to.equal(404);
    expect(await escape.text()).not.to.contain("OUTSIDE-SECRET");
    expect((await fetch(`${base}/app/bed/.hidden`)).status).to.equal(404);
  });

  it("refuses anything but GET with 405, before the ABAP", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "MERGE", "OPTIONS"]) {
      const answer = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet`, {method, body: method === "DELETE" ? undefined : "{}"});
      expect(answer.status, method).to.equal(405);
    }
  });

  it("wrote a trace that carries its positive control and no write", () => {
    const entries = readTrace(traceFile);
    const verdict = checkTrace(entries, {ownSchema: "OSDB3OWN"});
    expect(verdict.problems).to.deep.equal([]);
    expect(verdict.channels.api.probe).to.equal(true);
    // the GETs above are in it: the trace saw the request path, not only the boot
    expect(entries.some((e) => e.op === "select" && /zstg_demo/i.test(e.sql))).to.equal(true);
    // and the CLI agrees, and fails the same trace without its control
    const cut = join(dir, "no-control.ndjson");
    writeFileSync(cut, readFileSync(traceFile, "utf8").split("\n").filter((l) => !l.includes("OSD_TRACE_PROBE")).join("\n"));
    return Promise.all([traceCli(traceFile, {HANA_OWN_SCHEMA: "OSDB3OWN"}), traceCli(cut, {HANA_OWN_SCHEMA: "OSDB3OWN"})]).then(([good, bad]) => {
      expect(good.code).to.equal(0);
      expect(bad.code).to.equal(1);
      expect(bad.err).to.match(/positive control .* missing/);
    });
  });
});

function traceCli(file, extra = {}, args = []) {
  return new Promise((resolve) => {
    const env = {...process.env, ...extra};
    if (extra.HANA_OWN_SCHEMA === undefined) delete env.HANA_OWN_SCHEMA;
    const child = spawn(process.execPath, [tool, "--check-trace", file, ...args], {env});
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => { out += c; });
    child.stderr.on("data", (c) => { err += c; });
    child.on("exit", (code) => resolve({code, out, err}));
  });
}
