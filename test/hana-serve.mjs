import {expect} from "chai";
import {spawn} from "node:child_process";
import {createRequire} from "node:module";
import {HanaDatabaseClient} from "../tools/hana-client.mjs";
import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {checkTrace, countWrites, isShadowDdl, refusal, rfcRefusal, TRACE_PROBE_SQL} from "../tools/hana-serve.mjs";
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
//   - 405 for anything but GET;
//   - a boot that writes nothing (the fake would throw; the host counts);
//   - OSD_SQL_TRACE=1 writes a trace that carries its positive control,
//     and --check-trace fails one that does not.
// Mutation, measured when this was written: one write added to the boot
// (a db.insert after the registry) and this suite goes red at "boots".
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

describe("hana-serve over a fake DatabaseClient", function () {
  this.timeout(180000);
  let child;
  let base;
  let lines = [];
  let dir;
  let traceFile;

  before(async function () {
    if (!existsSync(join(output, "init.mjs"))) this.skip();
    dir = mkdtempSync(join(tmpdir(), "hana-serve-"));
    traceFile = join(dir, "trace.ndjson");
    const env = {...process.env};
    for (const name of ["STG_DB", "STG_SQL_TRACE", "STG_DB_TRACE", "OSD_HANA_WRITE", "STG_DB_FRESH", "OSD_BIND", "STG_TABLE_PROXY", "STG_RFC_PROXY"]) delete env[name];
    Object.assign(env, {
      HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", HANA_SCHEMA: "OSDB3TENANT", HANA_OWN_SCHEMA: "OSDB3OWN",
      OSD_SQL_TRACE: "1", OSD_SQL_TRACE_FILE: traceFile, OSD_OUTPUT: output,
    });
    child = spawn(process.execPath, [tool, "--port", "0", "--client-module", "test/fixtures/hana-serve/fake-client.mjs"],
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

  it("refuses anything but GET with 405, before the ABAP", async () => {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "MERGE"]) {
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
