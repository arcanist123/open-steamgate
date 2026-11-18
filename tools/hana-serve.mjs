// A minimal read-only host over a HANA schema an SAP system already holds
// (H5x-4 B3). Not the product: the milestone's honest smallest server.
//
//   STG_DB=hana HANA_EXISTING_SCHEMA=1 HANA_OWN_SCHEMA=<own> OSD_CLIENT=<client> \
//     HANA_HOST=... HANA_PORT=... HANA_USER=... HANA_PASSWORD=... HANA_SCHEMA=<tenant> \
//     [OSD_SQL_TRACE=1] [OSD_BIND=0.0.0.0] node tools/hana-serve.mjs [--port 3040] [--stub-trace <file>]
//     [--icf] [--w3mi] [--w3mi-check <OBJID>]... [--apc]
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
// What else it serves (milestone 3, so a Fiori Elements app runs on it):
//   - the static files of webapp/ under /app/ (the SAPUI5 resources come
//     from the CDN, as for every app of the tree), and `--app <name>=<dir>`
//     mounts a folder that is not in the tree at /app/<name>/ -- the way a
//     private app configuration for a real service is served on a bed.
//     A file is served only when its real path is inside the mount's real
//     path (a symlink out of the mount is not followed), never a dotfile
//     (staticFile);
//   - HEAD, answered as the GET it stands for without a body, so a CSRF
//     token fetch (`x-csrf-token: Fetch`) is answered the way the ordinary
//     server answers it;
//   - `POST .../$batch` when EVERY part is a GET: the body is read before a
//     line of ABAP runs, and a changeset or any other method in it refuses
//     the whole batch with 405 (batchRefusal), as does X-HTTP-Method(-Override)
//     on the request or a part; an absolute part URL outside the batched
//     service is refused with 400;
//   - one client: a request naming another `sap-client` (URL option,
//     header or cookie, also inside a batch part) than OSD_CLIENT is refused with 400 instead of being answered
//     out of this client's rows (clientRefusal);
//   - `--register <SERVICE>=<MPC>,<DPC>` registers a service the SEGW
//     registry does not hold (the test's twin under test/hana-m2), said on
//     startup.
//
// What it serves beyond OData, each only when asked for (docs/hana-serve-icf.md,
// tools/hana-serve-icf.mjs) -- an OData-only boot reads neither, so a user
// without SELECT on these tables and a schema without their shadow objects
// boot as before: `--icf`, the tenant's own ICF nodes whose handler class
// the generation holds, each path built from the tenant's ICFSERVICE rows,
// active per ICFSERVLOC, GET and HEAD only, through the same shim and
// dialog step; `--w3mi`, SMW0 MIME objects read out of the tenant's WWWDATA
// when the ABAP's WWWDATA_IMPORT asks for one (abap.W3MI_LOADER).
// `--w3mi-check <OBJID>` (implies --w3mi) reads one object through that
// function module at boot and prints its size and SHA-256. `--apc`, the
// tenant's push channels: each active websocket row of APC_APPL whose class
// the generation holds, mounted on this listener (tools/osd-apc.mjs), every
// event a dialog step on the same read-only connection.
// A build where a pack hides an object of the rescued island
// (tools/hana-serve-scope.mjs) is refused before it is built.
//
// What it refuses: to start outside existing-schema mode (and with the
// write guard lifted, OSD_HANA_WRITE=1), with an outbound RFC destination
// (live, record or fallback in the destinations file) or an RFC/table proxy
// configured -- read-only toward every system, not only the database -- any method but GET and HEAD
// and a GET-only $batch (405, before a line of ABAP runs), another client (400), and a boot that wrote
// anything. Every statement on
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
//
// Milestone 4 (tools/hana-host-guard.mjs, docs/db-backends.md "The host's
// two safety nets"): before the generation loads, every outbound network
// call of this process is refused -- sockets, DNS, child processes,
// workers, fetch, WebSocket -- except the database client's own connection,
// and the class library's HTTP client answers SEND with
// HTTP_COMMUNICATION_FAILURE. Every stub raise (ZCX_OSD_NOT_ACTIVATED,
// through globalThis.osdNotActivated) and every refusal is recorded per
// request; `--stub-trace <file>` writes the record as JSON lines (one per
// request under /sap/opu/odata, a `boot` line for what the load signalled),
// never into a response. The boot raises one synthetic stub and refuses to
// start with --stub-trace when the hook did not see it.
import {existsSync, mkdirSync, realpathSync, rmSync, statSync} from "node:fs";
import {createServer} from "node:http";
import {dirname, join, resolve, sep} from "node:path";
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

/** Why a request names a client this host does not serve, or undefined.
 *  The host serves ONE client (OSD_CLIENT, fixed at boot): a system would
 *  log the request on to the client it names, this host cannot, and
 *  answering out of its own client's rows is the silent wrong answer. An
 *  empty value is no value (the logon default). */
export function clientRefusal({query = {}, headers = {}} = {}, client) {
  const asked = [];
  const fromQuery = query["sap-client"];
  for (const value of Array.isArray(fromQuery) ? fromQuery : [fromQuery]) if (value !== undefined) asked.push(String(value));
  if (headers["sap-client"] !== undefined) asked.push(String(headers["sap-client"]));
  // a system also takes the client from a cookie; nothing here reads one,
  // and a request that names another client in one is still refused
  for (const pair of String(headers.cookie ?? "").split(";")) {
    const at = pair.indexOf("=");
    if (at > 0 && pair.slice(0, at).trim().toLowerCase() === "sap-client") asked.push(decodeURIComponent(pair.slice(at + 1).trim()));
  }
  const other = asked.map((v) => v.trim()).filter((v) => v !== "" && v !== String(client));
  if (other.length === 0) return undefined;
  return `hana-serve serves client ${client} only and this request names sap-client=${other[0]}: it is not answered out of client ${client}'s rows`;
}

/** the headers that would make a request another method than it says */
export const METHOD_OVERRIDES = ["x-http-method", "x-http-method-override"];

/** The parts of a multipart/mixed $batch body: for an application/http
 *  part its request line and the request's own headers (names lower case).
 *  A changeset is a part whose content type is multipart/mixed itself. */
export function batchParts(contentType, body) {
  const boundary = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(String(contentType ?? ""));
  if (boundary === null) return undefined;
  const marker = `--${boundary[1] ?? boundary[2]}`;
  const text = String(body ?? "");
  const pieces = text.split(marker).slice(1);
  const parts = [];
  for (const piece of pieces) {
    if (piece.startsWith("--")) break; // the closing delimiter
    const at = piece.search(/\r?\n\r?\n/);
    const head = at < 0 ? piece : piece.slice(0, at);
    const rest = at < 0 ? "" : piece.slice(at).replace(/^\r?\n\r?\n/, "");
    const type = /^content-type:\s*([^\r\n]*)/im.exec(head)?.[1]?.trim() ?? "";
    if (/^multipart\/mixed/i.test(type)) {
      parts.push({changeset: true, type});
      continue;
    }
    const lines = rest.split(/\r?\n/);
    const first = lines.findIndex((l) => l.trim() !== "");
    const [method = "", url = ""] = (first < 0 ? "" : lines[first]).trim().split(/\s+/);
    const headers = {};
    for (const l of first < 0 ? [] : lines.slice(first + 1)) {
      if (l.trim() === "") break;
      const colon = l.indexOf(":");
      if (colon > 0) headers[l.slice(0, colon).trim().toLowerCase()] = l.slice(colon + 1).trim();
    }
    parts.push({changeset: false, type, method: method.toUpperCase(), url, headers});
  }
  return parts;
}

/** Why a $batch may not reach the ABAP, or undefined: {status, message}.
 *  Only a batch of GET parts is a read; one part that is not -- a
 *  changeset, a POST, a method override, anything unreadable -- refuses
 *  the whole batch, so nothing of it runs. `client` also checks each part's
 *  own sap-client (URL option, header, cookie); `servicePath` (the batched
 *  service, "/sap/opu/odata/sap/<SRV>") confines an absolute part URL to
 *  that service, as a system does. */
export function batchRefusal(contentType, body, client, servicePath) {
  const parts = batchParts(contentType, body);
  if (parts === undefined) return {status: 400, message: "hana-serve: a $batch needs a multipart/mixed content type with a boundary"};
  if (parts.length === 0) return {status: 400, message: "hana-serve: a $batch without a part"};
  for (const [i, part] of parts.entries()) {
    if (part.changeset) return {status: 405, message: `hana-serve is read-only: part ${i + 1} of this $batch is a changeset, and a changeset writes; the whole batch is refused`};
    if (part.method !== "GET") return {status: 405, message: `hana-serve is read-only: part ${i + 1} of this $batch is ${part.method || "not a request"}, not GET; the whole batch is refused`};
    const override = METHOD_OVERRIDES.find((name) => part.headers?.[name] !== undefined);
    if (override !== undefined) return {status: 405, message: `hana-serve is read-only: part ${i + 1} of this $batch carries ${override}, which makes a GET another method; the whole batch is refused`};
    if (servicePath !== undefined && /^(\/|[a-z]+:)/i.test(part.url)) {
      const path = part.url.replace(/^[a-z]+:\/\/[^/]*/i, "").split("?")[0];
      const own = String(servicePath).replace(/\/$/, "");
      if (path !== own && !path.startsWith(`${own}/`)) return {status: 400, message: `hana-serve: part ${i + 1} of this $batch addresses ${path}, outside the batched service ${own}; the whole batch is refused`};
    }
    if (client !== undefined) {
      const query = Object.fromEntries(new URLSearchParams(part.url.split("?")[1] ?? ""));
      const other = clientRefusal({query, headers: part.headers}, client);
      if (other !== undefined) return {status: 400, message: `${other} (part ${i + 1} of the $batch)`};
    }
  }
  return undefined;
}

/** The file a static request under a mount may be answered with, or
 *  undefined. `rel` is the request path below the mount, still encoded.
 *  Refused: a NUL, a segment that starts with a dot (dotfiles, `..`), and
 *  -- the reason this is not express.static -- any file whose REAL path is
 *  not inside the mount's real path: a symlink in the mounted folder that
 *  points out of it is not followed out. Directories are not listed. */
export function staticFile(mount, rel) {
  let decoded;
  try { decoded = decodeURIComponent(String(rel)); } catch { return undefined; }
  if (decoded.includes("\0") || decoded.includes("\\")) return undefined;
  const segments = decoded.split("/").filter((s) => s !== "");
  if (segments.length === 0 || segments.some((s) => s.startsWith("."))) return undefined;
  let root;
  let real;
  try {
    root = realpathSync(mount);
    real = realpathSync(resolve(root, ...segments));
  } catch {
    return undefined;
  }
  if (real !== root && !real.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
  try {
    if (!statSync(real).isFile()) return undefined;
  } catch {
    return undefined;
  }
  return real;
}

/** an express middleware serving a mount through staticFile, GET and HEAD */
function mountStatic(mount) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") { next(); return; }
    const file = staticFile(mount, req.path);
    if (file === undefined) { next(); return; }
    res.sendFile(file, {dotfiles: "allow"}, (error) => { if (error && !res.headersSent) next(); });
  };
}

/** What a runtime error says: its message, or -- a transpiled ABAP
 *  exception carries none -- its class name, never an empty string */
export function runtimeText(e) {
  const text = String(e?.message?.get?.() ?? e?.message ?? "").trim();
  if (text !== "") return text;
  const name = e?.constructor?.name;
  if (name && name !== "Object" && name !== "Error") return `${name.toUpperCase()} raised and not caught`;
  return String(e ?? "an unknown runtime error");
}

/** Register services the SEGW registry does not hold: "SRV=MPC,DPC". */
export function parseRegistrations(values = []) {
  return values.map((value) => {
    const m = /^([^=\s]+)=([^,\s]+),([^,\s]+)$/.exec(String(value));
    if (m === null) throw new Error(`--register takes <SERVICE>=<MPC>,<DPC>, not ${value}`);
    return {service: m[1].toUpperCase(), mpc: m[2].toUpperCase(), dpc: m[3].toUpperCase()};
  });
}

/** Extra app folders: "name=dir", served at /app/<name>/. */
export function parseApps(values = []) {
  return values.map((value) => {
    const m = /^([A-Za-z0-9_-]+)=(.+)$/.exec(String(value));
    if (m === null) throw new Error(`--app takes <name>=<dir>, not ${value}`);
    return {name: m[1], dir: m[2]};
  });
}

/** Boot the generation and listen. Returns {server, url, close, stats, bindLog}. */
export async function serve({root = process.cwd(), port = 3040, clientModule, env = process.env, log = console.log,
  register = [], apps = [], stubTrace, icf: serveIcf = false, w3mi: serveW3mi = false, apc: serveApc = false, w3miCheck = []} = {}) {
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
  // milestone 4: installed below, before the generation loads; the
  // database client's connect is the one place a connection may open
  let guard;
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
    const connect = client.connect;
    if (typeof connect === "function") {
      client.connect = function (...args) {
        return guard === undefined ? connect.apply(this, args) : guard.asOwnDatabase(() => connect.apply(this, args));
      };
    }
    built += 1;
    return client;
  };

  const output = env.OSD_OUTPUT ?? join(root, "output");
  if (env.OSD_OUTPUT === undefined) {
    // a pack layered after the island would win its names: the tenant's
    // code served out of our copy of it (tools/hana-serve-scope.mjs)
    const {packsHidingTenant, describeHiding} = await import("./hana-serve-scope.mjs");
    const hiding = await packsHidingTenant(root, env);
    if (hiding.length > 0) throw new Error(`hana-serve refuses to build: ${describeHiding(hiding)}`);
    const {ensureSourceBuild} = await import("./osd-source-build-view.mjs");
    await ensureSourceBuild(root, env);
  }
  if (!existsSync(join(output, "init.mjs"))) throw new Error(`hana-serve: no generation at ${output} (npm run transpile first)`);
  // an import cycle hangs this boot rather than failing it: the open
  // connection keeps the event loop alive. Refuse first, naming the cycle.
  const {assertLoadable} = await import("./osd-generation-check.mjs");
  assertLoadable(output, {log: (m) => console.error(`hana-serve: ${m}`)});
  // milestone 4: the guard and the stub hook go in before a class module
  // loads -- a class constructor runs at load and may reach for either
  const {createHostRecord, installStubHook, installOutboundGuard, installHttpClientGuard, probeStubHook, integrity, tamperGate, isRefusal} = await import("./hana-host-guard.mjs");
  const record = createHostRecord({file: stubTrace === undefined ? undefined : resolve(root, stubTrace)});
  // locked: generated code that assigns either is ignored and recorded as
  // tampering, and the guard ends with the process (there is no uninstall)
  guard = installOutboundGuard(record, {lock: true});
  const hook = installStubHook(record, {lock: true});
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
  if (installHttpClientGuard(abap, guard, record).installed !== true) log("hana-serve: the generation has no CL_HTTP_CLIENT; outbound calls stay refused at the socket");
  await dialogStep(() => zcl_stg_segw_registry.register(), "hana-serve: the SEGW registry");
  await dialogStep(() => zcl_stg_shlp_registry.register(), "hana-serve: the search help registry");
  for (const one of register) {
    const string = (v) => new abap.types.String().set(v);
    await dialogStep(() => abap.Classes.ZCL_OAO_REGISTRY.register({iv_service: string(one.service), iv_mpc: string(one.mpc), iv_dpc: string(one.dpc)}),
      `hana-serve: register ${one.service}`);
    log(`hana-serve: registered ${one.service} -> MPC ${one.mpc}, DPC ${one.dpc} (--register, not from the SEGW registry)`);
  }

  // the positive control, through the ABAP's own connection
  const db = abap.context.databaseConnections.DEFAULT;
  // the tenant's ICF tree and its SMW0 objects (tools/hana-serve-icf.mjs):
  // reads, on that same connection, inside a step like every other
  const icf = await import("./hana-serve-icf.mjs");
  const tenant = serveIcf !== true ? undefined
    : await dialogStep(() => icf.readTenantServices(db, {tenantSchema: env.HANA_SCHEMA}), "hana-serve: the tenant's ICF tree");
  const icfServices = (tenant?.services ?? []).filter((s) => abap.Classes[s.handler] !== undefined);
  const w3mi = serveW3mi !== true && w3miCheck.length === 0 ? undefined
    : await dialogStep(() => icf.installW3mi(abap, db, {output, log}), "hana-serve: the tenant's MIME objects");
  // the tenant's push channels (APC_APPL, --apc): a channel whose class the
  // generation holds is mounted on the listener below; a tenant without the
  // table serves none and says why
  let tenantApc;
  if (serveApc === true) {
    try {
      tenantApc = await dialogStep(() => icf.readTenantChannels(db), "hana-serve: the tenant's APC applications");
    } catch (e) {
      log(`hana-serve: APC: APC_APPL not read (${runtimeText(e)}); no push channel is served`);
    }
  }
  const apcChannels = (tenantApc?.channels ?? []).filter((c) => abap.Classes[c.handler] !== undefined);
  const probe = await dialogStep(() => db.select({select: TRACE_PROBE_SQL}), "hana-serve: the trace probe");
  const answered = probe?.rows?.[0]?.probe ?? probe?.rows?.[0]?.PROBE;
  if (answered !== TRACE_PROBE_MARKER) throw new Error(`hana-serve: the probe SELECT answered ${JSON.stringify(probe?.rows?.[0])}, not ${TRACE_PROBE_MARKER}`);

  // the boot wrote nothing, or the host does not start
  if (stats.writes.length > 0) {
    throw new Error(`hana-serve: the boot asked for ${stats.writes.length} write(s) (${stats.writes.map((w) => `${w.method} ${w.kind}${w.refused ? ` [refused: ${w.refused}]` : ""}`).join(", ")}); a read-only host does not start after that`);
  }
  log(`hana-serve: booted over client ${env.OSD_CLIENT}, ${stats.statements} statement(s), 0 writes${traceFile ? `; trace ${traceFile}` : "; trace off (OSD_SQL_TRACE=1)"}`);
  if (tenant !== undefined) {
    const c = tenant.counts;
    log(`hana-serve: ICF: ${c.nodes} node(s) read, ${c.withHandler} with a handler, ${c.inactive} of them inactive, ${c.orphans} not under the host, `
      + `${icfServices.length} servable with their handler class in the generation`);
    if (c.activation === "unknown") console.error(`hana-serve: WARNING: ICF activation unknown (${tenant.activationError}): every node present with a handler counts as active`);
    if (c.multiHandler.length > 0) log(`hana-serve: ICF: ${c.multiHandler.length} node(s) with a chain of several handlers not mounted (a system runs the chain in ICFORDER; this host does not): ${c.multiHandler.slice(0, 5).join(", ")}`);
    if (c.duplicates.length > 0) log(`hana-serve: ICF: ${c.duplicates.length} node(s) on a path another node already serves, the first kept: ${c.duplicates.slice(0, 5).join(", ")}`);
  } else log("hana-serve: ICF: the tenant's nodes are not served (--icf)");
  if (w3mi !== undefined) log(`hana-serve: W3MI: ${w3mi.objects} MIME object(s) in the tenant's WWWPARAMS, read from WWWDATA when asked for`);
  if (tenantApc !== undefined) log(`hana-serve: APC: ${tenantApc.counts.rows} application(s) in APC_APPL, ${tenantApc.counts.websocket} active websocket one(s), ${apcChannels.length} with a class in the generation`);
  else if (serveApc !== true) log("hana-serve: APC: the tenant's push channels are not served (--apc)");
  for (const objid of w3miCheck) {
    const lines = await dialogStep(() => icf.importThroughAbap(abap, objid), `hana-serve: --w3mi-check ${objid}`);
    const read = w3mi.served.at(-1);
    if (read?.objid !== objid) throw new Error(`hana-serve: --w3mi-check ${objid}: WWWDATA_IMPORT did not read it from the tenant's WWWDATA`);
    const {createHash} = await import("node:crypto");
    const same = createHash("sha256").update(lines.subarray(0, read.bytes)).digest("hex") === read.sha256;
    log(`hana-serve: --w3mi-check ${objid}: ${read.bytes} byte(s) from the tenant's WWWDATA, SHA-256 ${read.sha256}; `
      + `WWWDATA_IMPORT handed the ABAP ${lines.length} byte(s) in 255-byte lines, ${same ? "the same bytes" : "NOT the same bytes"}`);
    if (same === false) throw new Error(`hana-serve: --w3mi-check ${objid}: the ABAP got other bytes than the loader read`);
  }

  // the stub hook's positive control: one synthetic raise through the
  // exception class the generation loaded; a trace asked for and a hook
  // that did not see it is a trace that would read clean and be blind
  const hookProbe = await probeStubHook(abap, record);
  const broken = integrity({hook, guard});
  if (broken.length > 0) throw new Error(`hana-serve: refuses to start: not intact after the boot: ${broken.join(", ")}`);
  if (hookProbe.ok !== true) {
    if (record.tracing) throw new Error(`hana-serve: refuses to start: ${hookProbe.why} (--stub-trace asked for the trace)`);
    console.error(`hana-serve: WARNING: ${hookProbe.why}`);
  }
  const boot = record.endBoot({probe: hookProbe.ok === true ? "seen" : "missing"});
  log(`hana-serve: outbound calls refused (sockets, DNS, processes, workers, fetch, WebSocket; the database's own connection excepted); `
    + `${boot.stubs.length} stub signal(s) at load; stub trace ${record.tracing ? record.file : "off (--stub-trace <file>)"}`);

  const {default: express} = await import("express");
  const {listenBound, describeBind, bindHint} = await import("./osd-bind.mjs");
  const app = express();
  app.disable("x-powered-by");
  app.use(express.raw({type: "*/*", limit: "1mb"}));
  const refuse = (res, status, code, message, headers = {}) => {
    res.status(status).set(headers).type("application/json")
      .send(JSON.stringify({error: {code, message: {lang: "en", value: message}}}));
  };
  // the static files: an app folder named by --app first, then webapp/
  const {rootWebappOf} = await import("./osd-system.mjs");
  for (const one of apps) {
    app.use(`/app/${one.name}`, mountStatic(resolve(root, one.dir)));
    log(`hana-serve: /app/${one.name}/ is ${resolve(root, one.dir)} (--app)`);
  }
  app.use("/app", mountStatic(rootWebappOf(root, env)));
  // one record per request, the refusals before the ABAP included: its
  // line names the status the client got, and nothing of it goes back
  // and before each, the identity of the hook and of every guarded entry
  // point: a host whose guard is not the one it installed answers nothing
  const gate = tamperGate(record, () => integrity({hook, guard}));
  app.all(/^\/sap\/opu\/odata\/[^/]+\/[^/]+/, (req, res) => record.request({method: req.method, path: req.path, res},
    () => gate(req, res, () => odata(req, res))));
  async function odata(req, res) {
    const client = String(env.OSD_CLIENT);
    const otherClient = clientRefusal({query: req.query, headers: req.headers}, client);
    if (otherClient !== undefined) {
      refuse(res, 400, "OSD/CLIENT", otherClient);
      return;
    }
    const isBatch = /\/\$batch\/?$/.test(req.path);
    const override = METHOD_OVERRIDES.find((name) => req.headers[name] !== undefined);
    if (override !== undefined) {
      refuse(res, 405, "OSD/READ_ONLY", `hana-serve is read-only and refuses ${override}: it makes a request another method than it says`, {allow: "GET, HEAD"});
      return;
    }
    if (req.method === "POST" && isBatch) {
      const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
      const batch = batchRefusal(req.headers["content-type"], body, client, req.path.replace(/\/\$batch\/?$/, ""));
      if (batch !== undefined) {
        refuse(res, batch.status, batch.status === 405 ? "OSD/READ_ONLY" : (batch.status === 400 && /client/.test(batch.message) ? "OSD/CLIENT" : "OSD/BAD_BATCH"), batch.message, {allow: "GET, HEAD, POST"});
        return;
      }
    } else if (req.method !== "GET" && req.method !== "HEAD") {
      refuse(res, 405, "OSD/READ_ONLY", `hana-serve is read-only and answers GET, HEAD and a $batch of GETs only, not ${req.method}`, {allow: "GET, HEAD"});
      return;
    }
    // HEAD is the GET without its body: the ABAP sees a GET (the dispatcher
    // knows no HEAD), node's response to a HEAD drops the body
    const asked = req.method === "HEAD" ? Object.create(req, {method: {value: "GET"}}) : req;
    const before = stats.writes.length;
    try {
      await dialogStep(() => cl_express_icf_shim.run({
        req: asked,
        res,
        class: "ZCL_STG_HTTP_HANDLER",
        base: new abap.types.String().set("/sap/opu/odata"),
      }), `hana-serve: a ${isBatch ? "$batch of GETs" : req.method}`);
    } catch (e) {
      if (!res.headersSent) {
        // a refusal that crossed the ABAP as a plain error says so and no
        // more: its target is the record's, never the response's
        const text = isRefusal(e) ? "hana-serve: an outbound call was refused; the host's trace names it" : runtimeText(e);
        res.status(500).type("application/json").send(JSON.stringify({error: {code: isRefusal(e) ? "OSD/REFUSED" : "OSD/RUNTIME", message: {lang: "en", value: text}}}));
      }
      console.error("hana-serve: runtime error:", e);
    }
    if (stats.writes.length > before) {
      console.error(`hana-serve: a ${req.method} of ${req.path} asked for ${stats.writes.length - before} write(s): ${stats.writes.slice(before).map((w) => `${w.method} ${w.kind}${w.refused ? ` [refused: ${w.refused}]` : ""}`).join(", ")}`);
    }
    if (/\/\$metadata\/?$/.test(req.path)) log(bindLog.line());
  }
  // the tenant's ICF nodes (tools/hana-serve-icf.mjs): read-only like the
  // OData front -- another client, a method override and anything but GET
  // and HEAD are refused before a line of ABAP runs -- one record and one
  // dialog step per request, the handler class the tenant's row names
  const {mountServices} = await import("./osd-icf.mjs");
  const icfMounted = mountServices(app, ({req, res, class: handler, base}) => record.request({method: req.method, path: req.path, res}, async () => {
    let intact = false;
    gate(req, res, () => { intact = true; });
    if (intact === false) return;
    const otherClient = clientRefusal({query: req.query, headers: req.headers}, String(env.OSD_CLIENT));
    const override = METHOD_OVERRIDES.find((name) => req.headers[name] !== undefined);
    if (otherClient !== undefined) return refuse(res, 400, "OSD/CLIENT", otherClient);
    if (override !== undefined || (req.method !== "GET" && req.method !== "HEAD")) {
      return refuse(res, 405, "OSD/READ_ONLY", `hana-serve is read-only and answers GET and HEAD on an ICF node, not ${override ?? req.method}`, {allow: "GET, HEAD"});
    }
    const asked = req.method === "HEAD" ? Object.create(req, {method: {value: "GET"}}) : req;
    const before = stats.writes.length;
    try {
      await dialogStep(() => cl_express_icf_shim.run({req: asked, res, class: handler, base: new abap.types.String().set(base)}), `hana-serve: ICF ${base}`);
    } catch (e) {
      // as on the OData front: a refusal's target is the record's, never the response's
      if (!res.headersSent) {
        res.status(500).type("text/plain").send(isRefusal(e) ? "hana-serve: an outbound call was refused; the host's trace names it\n" : `${handler}: ${runtimeText(e)}\n`);
      }
      console.error(`hana-serve: ICF ${base} (${handler}): runtime error:`, e);
    }
    if (stats.writes.length > before) console.error(`hana-serve: a ${req.method} of ${req.path} asked for ${stats.writes.length - before} write(s)`);
  }), {from: icfServices, claimed: ["/sap/opu/odata", "/app"], say: (m) => log(`hana-serve: ${m}`)});
  for (const one of icfMounted) log(`hana-serve: ICF ${one.path}/ -> ${one.handler} (the tenant's node, GET and HEAD only)`);
  app.all("*", (req, res) => {
    res.status(404).type("text/plain").send("hana-serve answers /sap/opu/odata/<namespace or sap>/<SERVICE>/..., the tenant's ICF nodes whose handler the generation holds, and the static files under /app/ only\n");
  });

  const server = guard.allowListener(createServer(app));
  // osd-bind opens a second loopback listener (::1) from the primary's
  // "listening" event, a server this host never holds: the guard admits a
  // listen for exactly that window, closed in the same event, before any
  // connection can be read
  const closeWindow = guard.openListenWindow();
  await new Promise((done, fail) => {
    server.once("error", (error) => { closeWindow(); fail(error); });
    listenBound(server, port, env, () => { closeWindow(); done(); });
  });
  // the tenant's push channels on the same loopback listener. Every event
  // (on_start, each message, on_close) is a dialog step of its own: it
  // takes the one work process, commits or rolls back at its end, and runs
  // on the same read-only connection, so a write is refused there and
  // counted like an HTTP request's. An upgrade from another client, or to a
  // host whose guard is no longer intact, is refused before any ABAP runs.
  if (apcChannels.length > 0) {
    const {mountChannels} = await import("./osd-apc.mjs");
    const {zcl_apc_host} = await from("zcl_apc_host.clas.mjs");
    const mounted = mountChannels(server, apcChannels, {
      host: zcl_apc_host, root,
      log: (line) => console.error(`hana-serve: ${line}`),
      admit: (req) => {
        const broken = integrity({hook, guard});
        if (broken.length > 0) {
          record.note("tampered", {what: `not intact: ${broken.join(", ")}`});
          return {status: 500, reason: "Internal Server Error", text: "hana-serve: the host's guard is no longer the one it installed; nothing is answered"};
        }
        const query = Object.fromEntries(new URL(req.url, "ws://loopback").searchParams);
        const otherClient = clientRefusal({query, headers: req.headers}, String(env.OSD_CLIENT));
        if (otherClient !== undefined) return {status: 400, reason: "Bad Request", text: otherClient};
        return undefined;
      },
    });
    for (const one of mounted) log(`hana-serve: APC ${one.path} -> ${one.handler}${one.stateful ? " (stateful)" : ""} (the tenant's APC_APPL row, a websocket on this listener)`);
  }
  const address = server.address();
  const url = `http://${address.family === "IPv6" ? `[${address.address}]` : address.address}:${address.port}`;
  log(`hana-serve: listening on ${url}/sap/opu/odata/  (bound to ${describeBind(env)})`);
  if (bindHint(env) !== undefined) log(bindHint(env));
  // the guard stays: it is locked and ends with the process, so a serve()
  // started again in the same process runs under the same guard -- and
  // cannot install a second one (its listener is the first serve's only)
  const close = () => new Promise((done) => server.close(() => done()));
  return {server, url, close, stats, bindLog, traceFile, record};
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
    const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
    await serve({port: Number(portFlag ?? process.env.STG_PORT ?? 3040), clientModule: flag("client-module"),
      register: parseRegistrations(all("register")), apps: parseApps(all("app")), stubTrace: flag("stub-trace"),
      icf: argv.includes("--icf"), w3mi: argv.includes("--w3mi"), apc: argv.includes("--apc"), w3miCheck: all("w3mi-check")});
  } catch (e) {
    console.error(e?.message ?? e);
    process.exit(1);
  }
}
