// A minimal read-only host over a HANA schema an SAP system already holds
// (H5x-4 B3). Not the product: the milestone's honest smallest server.
//
//   STG_DB=hana HANA_EXISTING_SCHEMA=1 HANA_OWN_SCHEMA=<own> OSD_CLIENT=<client> \
//     HANA_HOST=... HANA_PORT=... HANA_USER=... HANA_PASSWORD=... HANA_SCHEMA=<tenant> \
//     [OSD_SQL_TRACE=1] [OSD_BIND=0.0.0.0] node tools/hana-serve.mjs [--port 3040]
//   HANA_OWN_SCHEMA=<own> node tools/hana-serve.mjs --check-trace <trace.ndjson> [--own-schema <own>]
//
// --check-trace needs the own schema the host ran with: shadow DDL is
// admitted only on that schema, and with none given there is no shadow DDL
// at all -- every schema-qualified CREATE/DROP is then a write (fail closed).
//
// test/start.mjs cannot boot in existing-schema mode, and this is why it is
// not used: its boot writes -- the ICF registry (ICFSERVICE/ICFHANDLER),
// the cross-reference seed, the demo data, the status tables -- and the
// read-only guard refuses every one of them, and several of our tables
// carry the tenant's own names. So this host does only what reading a
// service needs:
//
//   1. the transpiled generation (output/), booted through the same
//      test/setup.mjs, which in this mode connects and returns before any
//      DDL or seed (docs/db-backends.md, "Existing schema, read-only");
//   2. the services, registered by the generated SEGW registry
//      (gen/segw/zcl_stg_segw_registry -- with the registration read out of
//      the dump when gen/hana-segw holds one), and the value helps by
//      the generated search help registry (gen/segw/zcl_stg_shlp_registry,
//      tools/segw-shlp.mjs over every layer, the dump's *.shlp.xml among
//      them) -- registering a provider reads and writes nothing;
//   3. OData v2 GETs through the request path every host uses:
//      ZCL_STG_HTTP_HANDLER behind CL_EXPRESS_ICF_SHIM, one dialog step per
//      request (tools/osd-dialog-step.mjs), under /sap/opu/odata/sap/<SRV>
//      and /sap/opu/odata/<namespace>/<SRV> (ZCL_STG_URL reads both).
//
// What it refuses: to start outside existing-schema mode (and with the
// write guard lifted, OSD_HANA_WRITE=1), with an outbound RFC destination
// (live, record or fallback in the destinations file) or an RFC/table proxy
// configured -- read-only toward every system, not only the database -- any method but GET (405, before a
// line of ABAP runs), and a boot that wrote anything. Every statement on
// the DatabaseClient interface is counted; a write during the boot -- which
// would have been refused by the guard, or swallowed somewhere as subrc 4 --
// stops the host before it listens. It binds to loopback unless OSD_BIND
// says otherwise.
//
// OSD_SQL_TRACE=1 records every statement into OSD_SQL_TRACE_FILE (default
// .local/hana-serve/sql-trace.ndjson; it may carry data, keep it local):
// the interface (STG_SQL_TRACE, test/setup.mjs) and, for HANA, the text the
// driver is handed, connect()'s own SET SCHEMA and shadow DDL included. The
// boot sends one known SELECT (TRACE_PROBE_SQL) through the connection the
// ABAP reads through; `--check-trace` fails a trace that does not carry it
// on every channel, because a trace that was off and a trace that saw no
// write look the same.
//
// `--client-module <file>` replaces the HANA client with the module's
// `createClient(options)` -- a fake DatabaseClient for the test
// (test/hana-serve.mjs); it is said on startup, loudly.
import {existsSync, mkdirSync, rmSync} from "node:fs";
import {createServer} from "node:http";
import {dirname, join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {runsAs} from "./osd-main.mjs";
import {readTrace} from "./osd-sql-trace.mjs";
import {isMultiStatement, statementKind} from "./hana-client.mjs";
import {shadowDdlSchema} from "./hana-shadow-schema.mjs";

export const TRACE_PROBE_MARKER = "OSD_TRACE_PROBE";
/** the positive control: valid on HANA (DUMMY), answerable by a fake */
export const TRACE_PROBE_SQL = `SELECT '${TRACE_PROBE_MARKER}' AS probe FROM dummy`;

const READ_KINDS = new Set(["SELECT", "SET", "COMMIT", "ROLLBACK"]);

/** the kind the read-only guard would read off this text */
export function kindOf(sql) {
  return isMultiStatement(String(sql)) ? "MULTI" : (statementKind(String(sql)) || "?");
}

/** shadow DDL of our own schema: the one DDL the mode admits. Fail closed:
 *  without an own schema (HANA_OWN_SCHEMA unset, the H1 shape, the session in
 *  the tenant's schema) there is no shadow DDL, so nothing is admitted. */
export function isShadowDdl(sql, ownSchema) {
  const own = String(ownSchema ?? "").trim().toUpperCase();
  if (own === "") return false;
  const kind = kindOf(sql);
  if (kind !== "CREATE" && kind !== "DROP") return false;
  return shadowDdlSchema(sql) === own;
}

/** Why this environment may not run the host, or undefined. */
export function refusal(env = process.env) {
  if (env.HANA_EXISTING_SCHEMA !== "1") return "hana-serve runs only in existing-schema mode: set HANA_EXISTING_SCHEMA=1 (docs/db-backends.md); for any other database start the ordinary server (npm start)";
  if (env.STG_DB !== undefined && env.STG_DB !== "" && env.STG_DB !== "hana") return `hana-serve runs over HANA only, and STG_DB is ${env.STG_DB}`;
  if (String(env.OSD_CLIENT ?? "") === "") return "hana-serve needs OSD_CLIENT, the logon client: without it every client-dependent table reads empty";
  if (env.OSD_HANA_WRITE === "1") return "hana-serve is read-only and refuses OSD_HANA_WRITE=1";
  if (env.STG_DB_FRESH === "1") return "hana-serve refuses STG_DB_FRESH=1: fresh means DROP SCHEMA";
  for (const name of ["STG_RFC_PROXY", "STG_TABLE_PROXY"]) {
    if (String(env[name] ?? "") !== "") return `hana-serve refuses ${name}: a proxy reaches another system, and this host promises to send nothing anywhere but reads`;
  }
  return undefined;
}

/** The RFC half of the promise: CALL FUNCTION ... DESTINATION reaches
 *  another system through a live, record or fallback destination
 *  (tools/rfc-replay.mjs). This host refuses to start with one configured;
 *  local and replay stay (they never leave the box). `destinations` is the
 *  parsed destinations file. */
export function rfcRefusal(destinations = {}) {
  const outbound = Object.entries(destinations)
    .filter(([, entry]) => ["live", "record", "fallback"].includes(entry?.kind))
    .map(([name, entry]) => `${name} (${entry.kind})`);
  if (outbound.length === 0) return undefined;
  return `hana-serve refuses outbound RFC destinations: ${outbound.join(", ")}. The host is read-only toward every system, not only the database; point STG_RFC_DESTINATIONS at a file with local or replay entries only`;
}

/** Count the writes a client is asked for, in place (the way
 *  installSqlTrace wraps: test/setup.mjs wraps the same instance after
 *  this). insert/update/delete are writes; execute and native are writes
 *  unless the statement reads -- or is the shadow DDL of our own schema,
 *  which connect() sends. */
export function countWrites(client, {ownSchema, stats = {statements: 0, writes: []}} = {}) {
  // a write is counted when it is asked for -- an attempt the client then
  // refused is still an attempt, and is marked as refused when it throws
  const note = (method, kind) => {
    stats.statements += 1;
    if (kind === undefined) return undefined;
    const write = {method, kind};
    stats.writes.push(write);
    return write;
  };
  const marked = (write, answer) => {
    if (write === undefined || typeof answer?.then !== "function") return answer;
    return answer.catch((error) => {
      write.refused = String(error?.code ?? "error");
      throw error;
    });
  };
  for (const method of ["insert", "update", "delete"]) {
    const original = client[method];
    if (typeof original !== "function") continue;
    client[method] = function (...args) {
      return marked(note(method, method.toUpperCase()), original.apply(this, args));
    };
  }
  for (const method of ["execute", "native"]) {
    const original = client[method];
    if (typeof original !== "function") continue;
    client[method] = function (...args) {
      const texts = method === "native" ? [String(args[0]?.sql ?? "")] : (Array.isArray(args[0]) ? args[0] : [args[0]]);
      let write;
      for (const sql of texts) {
        if (sql === "" || sql === undefined) continue;
        const kind = kindOf(sql);
        write = note(method, READ_KINDS.has(kind) || isShadowDdl(sql, ownSchema) ? undefined : kind) ?? write;
      }
      return marked(write, original.apply(this, args));
    };
  }
  for (const method of ["select", "openCursor"]) {
    const original = client[method];
    if (typeof original !== "function") continue;
    client[method] = function (...args) {
      note(method, undefined);
      return original.apply(this, args);
    };
  }
  return stats;
}

/** Judge a trace (the entries of tools/osd-sql-trace.mjs, plus the driver
 *  lines test/setup.mjs adds for HANA): the positive control on every
 *  channel the trace has, and every statement that is not a read.
 *
 *  The two channels record different things: the api channel records what
 *  was ASKED of the client (an attempt the guard refused carries `error`,
 *  and is listed under `refused`, not `writes`); the driver channel records
 *  what was SENT. A refused attempt still fails the verdict -- the code
 *  tried to write -- but it is never read as a statement that reached the
 *  database. */
export function checkTrace(entries, {ownSchema} = {}) {
  const channelOf = (entry) => (entry.op === "driver" ? "driver" : "api");
  const own = String(ownSchema ?? "").trim();
  const channels = {};
  const writes = [];
  const refused = [];
  let shadowDdl = 0;
  let unownedDdl = 0;
  for (const entry of entries) {
    if (entry.sql === "" || entry.sql === undefined) continue; // LUW markers
    const channel = channelOf(entry);
    const seen = (channels[channel] ??= {statements: 0, probe: false});
    seen.statements += 1;
    const kind = ["insert", "update", "delete"].includes(entry.op) ? entry.op.toUpperCase() : kindOf(entry.sql);
    if (kind === "SELECT" && String(entry.sql).includes(TRACE_PROBE_MARKER)) seen.probe = true;
    if (READ_KINDS.has(kind)) continue;
    if (isShadowDdl(entry.sql, own)) { shadowDdl += 1; continue; }
    if (own === "" && (kind === "CREATE" || kind === "DROP") && shadowDdlSchema(entry.sql) !== undefined) unownedDdl += 1;
    const write = {channel, op: entry.op, kind, table: entry.table};
    if (channel === "api" && entry.error !== undefined) refused.push({...write, error: entry.error});
    else writes.push(write);
  }
  const problems = [];
  if (Object.keys(channels).length === 0) problems.push("the trace holds no statement: it was not on");
  if (channels.api === undefined) problems.push("no statement on the DatabaseClient interface: the trace did not see the ABAP's connection");
  for (const [channel, seen] of Object.entries(channels)) {
    if (seen.probe !== true) problems.push(`the positive control (${TRACE_PROBE_MARKER}) is missing on channel ${channel}: this trace cannot show that nothing else was missed`);
  }
  if (unownedDdl > 0) problems.push(`${unownedDdl} schema-qualified CREATE/DROP and no own schema given (HANA_OWN_SCHEMA or --own-schema): without it there is no shadow DDL, so each is counted as a write`);
  if (writes.length > 0) problems.push(`${writes.length} statement(s) that are not reads: ${writes.slice(0, 5).map((w) => `${w.kind}${w.table ? " " + w.table : ""}`).join(", ")}`);
  if (refused.length > 0) problems.push(`${refused.length} write attempt(s) refused by the client (${[...new Set(refused.map((r) => r.error))].join(", ")}): asked for, not sent`);
  return {ok: problems.length === 0, problems, channels, writes, refused, shadowDdl};
}

/** Boot the generation and listen. Returns {server, url, close, stats, bindLog}. */
export async function serve({root = process.cwd(), port = 3040, clientModule, env = process.env, log = console.log} = {}) {
  const refused = refusal(env);
  if (refused !== undefined) throw new Error(refused);
  const {loadDestinations} = await import("./rfc-replay.mjs");
  const rfc = rfcRefusal(loadDestinations(env.STG_RFC_DESTINATIONS === undefined ? undefined : resolve(root, env.STG_RFC_DESTINATIONS)));
  if (rfc !== undefined) throw new Error(rfc);
  env.STG_DB = "hana";
  const ownSchema = env.HANA_OWN_SCHEMA;

  // the trace: the interface through STG_SQL_TRACE (test/setup.mjs wraps
  // whichever client it builds), the driver through the client's sqlTrace
  let traceFile;
  if (env.OSD_SQL_TRACE === "1") {
    traceFile = resolve(root, env.OSD_SQL_TRACE_FILE ?? join(".local", "hana-serve", "sql-trace.ndjson"));
    mkdirSync(dirname(traceFile), {recursive: true});
    rmSync(traceFile, {force: true}); // this run's statements only
    env.STG_SQL_TRACE = traceFile;
  }

  // The client, built by test/setup.mjs through this seam: the real HANA
  // client, or the module's fake, and either way counted.
  // one tally for every client the seam builds (one in this mode; a
  // second caller adds to it rather than replacing it)
  const stats = {statements: 0, writes: []};
  let built = 0;
  let factory;
  if (clientModule !== undefined) {
    const mod = await import(pathToFileURL(resolve(root, clientModule)).href);
    log(`hana-serve: DATABASE IS NOT HANA -- the client is createClient() of ${clientModule}`);
    factory = (options) => mod.createClient(options);
  } else {
    const {HanaDatabaseClient} = await import("./hana-client.mjs");
    factory = (options) => new HanaDatabaseClient(options);
  }
  globalThis.__osdHanaClientFactory = async (options) => {
    const client = await factory(options);
    countWrites(client, {ownSchema, stats});
    built += 1;
    return client;
  };

  const output = env.OSD_OUTPUT ?? join(root, "output");
  if (env.OSD_OUTPUT === undefined) {
    const {ensureSourceBuild} = await import("./osd-source-build-view.mjs");
    await ensureSourceBuild(root, env);
  }
  if (!existsSync(join(output, "init.mjs"))) throw new Error(`hana-serve: no generation at ${output} (npm run transpile first)`);
  // an import cycle hangs this boot rather than failing it: the open
  // connection keeps the event loop alive. Refuse first, naming the cycle.
  const {assertLoadable} = await import("./osd-generation-check.mjs");
  assertLoadable(output, {log: (m) => console.error(`hana-serve: ${m}`)});
  const from = (file) => import(pathToFileURL(join(output, file)).href);
  const {initializeABAP} = await from("init.mjs");
  const {cl_express_icf_shim} = await from("cl_express_icf_shim.clas.mjs");
  const {zcl_stg_segw_registry} = await from("zcl_stg_segw_registry.clas.mjs");
  const {zcl_stg_shlp_registry} = await from("zcl_stg_shlp_registry.clas.mjs");
  const abap = globalThis.abap;
  const {installBindStructureLog} = await import("./osd-bind-structure-log.mjs");
  const bindLog = installBindStructureLog(abap);
  const {dialogStep} = await import("./osd-dialog-step.mjs");

  await initializeABAP();
  if (built === 0) throw new Error("hana-serve: test/setup.mjs did not build the client through the factory seam -- is STG_DB=hana reaching it?");
  await dialogStep(() => zcl_stg_segw_registry.register(), "hana-serve: the SEGW registry");
  await dialogStep(() => zcl_stg_shlp_registry.register(), "hana-serve: the search help registry");

  // the positive control, through the ABAP's own connection
  const db = abap.context.databaseConnections.DEFAULT;
  const probe = await dialogStep(() => db.select({select: TRACE_PROBE_SQL}), "hana-serve: the trace probe");
  const answered = probe?.rows?.[0]?.probe ?? probe?.rows?.[0]?.PROBE;
  if (answered !== TRACE_PROBE_MARKER) throw new Error(`hana-serve: the probe SELECT answered ${JSON.stringify(probe?.rows?.[0])}, not ${TRACE_PROBE_MARKER}`);

  // the boot wrote nothing, or the host does not start
  if (stats.writes.length > 0) {
    throw new Error(`hana-serve: the boot asked for ${stats.writes.length} write(s) (${stats.writes.map((w) => `${w.method} ${w.kind}${w.refused ? ` [refused: ${w.refused}]` : ""}`).join(", ")}); a read-only host does not start after that`);
  }
  log(`hana-serve: booted over client ${env.OSD_CLIENT}, ${stats.statements} statement(s), 0 writes${traceFile ? `; trace ${traceFile}` : "; trace off (OSD_SQL_TRACE=1)"}`);

  const {default: express} = await import("express");
  const {listenBound, describeBind, bindHint} = await import("./osd-bind.mjs");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.raw({type: "*/*", limit: "1mb"}));
  app.all(/^\/sap\/opu\/odata\/[^/]+\/[^/]+/, async (req, res) => {
    if (req.method !== "GET") {
      res.status(405).set("allow", "GET").type("application/json")
        .send(JSON.stringify({error: {code: "OSD/READ_ONLY", message: {lang: "en", value: `hana-serve is read-only and answers GET only, not ${req.method}`}}}));
      return;
    }
    const before = stats.writes.length;
    try {
      await dialogStep(() => cl_express_icf_shim.run({
        req,
        res,
        class: "ZCL_STG_HTTP_HANDLER",
        base: new abap.types.String().set("/sap/opu/odata"),
      }), "hana-serve: a GET");
    } catch (e) {
      if (!res.headersSent) {
        res.status(500).type("application/json").send(JSON.stringify({error: {code: "OSD/RUNTIME", message: {lang: "en", value: String(e?.message?.get?.() ?? e?.message ?? e)}}}));
      }
      console.error("hana-serve: runtime error:", e);
    }
    if (stats.writes.length > before) {
      console.error(`hana-serve: a GET of ${req.path} asked for ${stats.writes.length - before} write(s): ${stats.writes.slice(before).map((w) => `${w.method} ${w.kind}${w.refused ? ` [refused: ${w.refused}]` : ""}`).join(", ")}`);
    }
    if (/\/\$metadata\/?$/.test(req.path)) log(bindLog.line());
  });
  app.all("*", (req, res) => {
    res.status(404).type("text/plain").send("hana-serve answers /sap/opu/odata/<namespace or sap>/<SERVICE>/... only\n");
  });

  const server = createServer(app);
  await new Promise((done, fail) => {
    server.once("error", fail);
    listenBound(server, port, env, done);
  });
  const address = server.address();
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  log(`hana-serve: listening on ${url}/sap/opu/odata/  (bound to ${describeBind(env)})`);
  if (bindHint(env) !== undefined) log(bindHint(env));
  const close = () => new Promise((done) => server.close(() => done()));
  return {server, url, close, stats, bindLog, traceFile};
}

if (runsAs("hana-serve.mjs")) {
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const check = flag("check-trace");
  if (check !== undefined) {
    const ownSchema = flag("own-schema") ?? process.env.HANA_OWN_SCHEMA;
    if (String(ownSchema ?? "") === "") console.log("own schema: none given (HANA_OWN_SCHEMA / --own-schema) -- no DDL is admitted as shadow DDL");
    else console.log(`own schema: ${ownSchema}`);
    const verdict = checkTrace(readTrace(check), {ownSchema});
    for (const [channel, seen] of Object.entries(verdict.channels)) {
      console.log(`${channel}: ${seen.statements} statement(s), positive control ${seen.probe ? "present" : "MISSING"}`);
    }
    console.log(`shadow DDL of our own schema: ${verdict.shadowDdl}; writes: ${verdict.writes.length}; refused attempts: ${verdict.refused.length}`);
    for (const w of verdict.writes) console.log(`  write: ${w.channel} ${w.op} ${w.kind}${w.table ? " " + w.table : ""}`);
    for (const w of verdict.refused) console.log(`  refused (not sent): ${w.op} ${w.kind}${w.table ? " " + w.table : ""} [${w.error}]`);
    for (const p of verdict.problems) console.error(`FAIL: ${p}`);
    console.log(verdict.ok ? "trace OK: the control is there and nothing but reads was sent" : "trace FAILED");
    process.exit(verdict.ok ? 0 : 1);
  }
  const portFlag = flag("port");
  try {
    await serve({port: Number(portFlag ?? process.env.STG_PORT ?? 3040), clientModule: flag("client-module")});
  } catch (e) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}
