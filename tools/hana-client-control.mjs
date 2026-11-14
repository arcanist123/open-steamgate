#!/usr/bin/env node
// The client-filter control of the existing-schema mode: does a read through
// our own schema see exactly the logon client's rows of a table, and nothing
// of the other clients'? (docs/db-backends.md, "Shadow schema: the client
// lives in HANA").
//
//   node tools/hana-client-control.mjs --table <T> --clients 000,001 [--json]
//
// For each client it opens a session the way the runtime does --
// HanaDatabaseClient in existing-schema mode with HANA_OWN_SCHEMA and that
// client as the logon client, the table in its shadow set -- and counts the
// table's rows through the session's own schema: the same view and the same
// SESSION_CONTEXT('CLIENT') every generated read goes through. Then it asks
// the tenant directly, read-only, for the rows per client column value (the
// column read off DD03L, never assumed to be MANDT) and the total.
//
// It passes when, for every client, the shadow count equals the tenant's
// count for that client, the shadow object is a view (a synonym does not
// filter), and the clients' counts differ from each other and from the
// unfiltered total. A table that holds rows for one client only cannot pass:
// a missing filter would give the same numbers, and the tool says so instead
// of reporting a green that proves nothing. Exit 0 pass, 1 fail, 2 refused.
//
// It refuses anything but the shadow-schema mode (HANA_EXISTING_SCHEMA=1 with
// HANA_OWN_SCHEMA set and different from HANA_SCHEMA): without the shadow
// schema there is no client filter to check. The only statements beyond
// SELECTs are the shadow objects the client itself creates in our own schema
// at connect, as every run of the mode does.
import {runsAs} from "./osd-main.mjs";
import {HanaDatabaseClient} from "./hana-client.mjs";
import {clientField} from "./hana-ddic-map.mjs";
import {nameList} from "./hana-ddic-probe.mjs";

const CLIENT = /^[0-9]{3}$/;

/** the refusals before any socket opens; a message, or undefined */
export function refusal({table, clients, env}) {
  if (env.HANA_EXISTING_SCHEMA !== "1") return "HANA_EXISTING_SCHEMA=1 is required: the control checks the shadow schema's client filter, which only that mode has";
  const own = String(env.HANA_OWN_SCHEMA ?? "").toUpperCase();
  if (own === "") return "HANA_OWN_SCHEMA is required: without our own schema there is no shadow view and no client filter to check";
  if (own === String(env.HANA_SCHEMA ?? "").toUpperCase()) return "HANA_OWN_SCHEMA equals HANA_SCHEMA: refused, as the client refuses it";
  if (table === undefined || table === "") return "--table <name> is required";
  if (clients.length < 2) return "--clients needs at least two clients (e.g. 000,001): one client cannot show a filter";
  const bad = clients.filter((c) => CLIENT.test(c) === false);
  if (bad.length > 0) return `not a client: ${bad.join(", ")}`;
  if (new Set(clients).size !== clients.length) return "--clients names a client twice";
  return undefined;
}

const count = (rows) => Number(rows[0]?.n ?? 0);

/** the control itself, over a `open(client)` that returns a connected
 *  database ({query(sql), disconnect()}) for that logon client. Pure apart
 *  from the queries; the tests hand it a fake. */
export async function clientControl({table, clients, own, tenant, open}) {
  const result = {table, clients: {}, tenant: {column: undefined, perClient: {}, total: 0}, view: undefined, checks: [], pass: false};
  for (const client of clients) {
    const db = await open(client);
    try {
      if (result.view === undefined) {
        // what the session reads: a view in our schema, not a synonym
        result.view = count(await db.query(
          `SELECT COUNT(*) AS N FROM SYS.VIEWS WHERE SCHEMA_NAME = '${own}' AND VIEW_NAME = '${table}'`)) === 1;
      }
      result.clients[client] = count(await db.query(`SELECT COUNT(*) AS N FROM "${table}"`));
      if (result.tenant.column === undefined) {
        const keys = await db.query(
          `SELECT TABNAME, POSITION, FIELDNAME, KEYFLAG, DATATYPE FROM "${tenant}"."DD03L" WHERE TABNAME = '${table}' AND AS4LOCAL = 'A' AND AS4VERS = '0000' AND KEYFLAG = 'X'`);
        const column = clientField(keys);
        result.tenant.column = column ?? null;
        if (column !== undefined) {
          for (const row of await db.query(
            `SELECT "${column}" AS C, COUNT(*) AS N FROM "${tenant}"."${table}" GROUP BY "${column}" ORDER BY "${column}"`)) {
            result.tenant.perClient[String(row.c)] = Number(row.n);
          }
        }
        result.tenant.total = count(await db.query(`SELECT COUNT(*) AS N FROM "${tenant}"."${table}"`));
      }
    } finally {
      await db.disconnect();
    }
  }
  const check = (ok, text) => result.checks.push({ok, text});
  check(result.tenant.column !== null, result.tenant.column === null
    ? `${table} has no CLNT key field in DD03L: not client-dependent, nothing to control`
    : `client column ${result.tenant.column}`);
  check(result.view === true, result.view === true ? "the shadow object is a view" : "the shadow object is not a view (a synonym reads every client)");
  for (const client of clients) {
    const tenantCount = result.tenant.perClient[client] ?? 0;
    check(result.clients[client] === tenantCount, `client ${client}: shadow ${result.clients[client]}, tenant ${tenantCount}`);
    check(result.clients[client] !== result.tenant.total, `client ${client}: shadow ${result.clients[client]} differs from the unfiltered total ${result.tenant.total}`);
  }
  const values = clients.map((c) => result.clients[c]);
  check(new Set(values).size === values.length, `the clients' counts differ from each other (${values.join(", ")})`);
  result.pass = result.checks.every((c) => c.ok);
  return result;
}

async function main(argv, env) {
  const arg = (name) => (argv.indexOf(name) >= 0 ? argv[argv.indexOf(name) + 1] : undefined);
  let table;
  try {
    table = arg("--table") === undefined ? undefined : nameList(arg("--table"))[0];
  } catch (error) {
    console.error(`hana-client-control: ${error.message}`);
    return 2;
  }
  const clients = (arg("--clients") ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "");
  const refused = refusal({table, clients, env});
  if (refused !== undefined) {
    console.error(`hana-client-control: ${refused}`);
    return 2;
  }
  const own = String(env.HANA_OWN_SCHEMA).toUpperCase();
  const tenant = String(env.HANA_SCHEMA ?? "").toUpperCase();
  const open = async (client) => {
    const db = new HanaDatabaseClient({existingSchema: true, client, ownSchema: own, shadowTables: [table]});
    await db.connect();
    return db;
  };
  const result = await clientControl({table, clients, own, tenant, open});
  if (argv.includes("--json")) {
    console.log(JSON.stringify(result));
  } else {
    for (const c of result.checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.text}`);
    console.log(result.pass ? "client control: PASS" : "client control: FAILED");
  }
  return result.pass ? 0 : 1;
}

if (runsAs("hana-client-control.mjs")) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code), (error) => {
    console.error(`hana-client-control: ${error?.message ?? error}`);
    process.exit(2);
  });
}
