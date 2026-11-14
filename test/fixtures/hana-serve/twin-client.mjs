// A fake DatabaseClient that answers SQL: the SQLite client of the tree
// (tools/sqlite-heap-client.mjs) over the twin's three tables, seeded here
// and then closed to writes. It stands where tools/hana-client.mjs stands in
// existing-schema mode, for the spec that drives the Fiori Elements app on
// the twin service through tools/hana-serve.mjs (test/e2e/h5x-app.spec.mjs).
//
// Why not fake-client.mjs beside it: that one answers every SELECT with the
// rows of the first table it names. A list report filters, sorts, pages and
// counts, and a join fills the address -- a fake that ignores WHERE and
// ORDER BY would let the spec pass on a filter that was never applied.
//
// What it is NOT: HANA. The SQL the runtime writes goes through the SQLite
// client's own rewrites, not through tools/hana-client.mjs's; the HANA side
// of the same request path is the bed's run of the same spec
// (docs/hana-milestone-3.md). The host says so on startup ("DATABASE IS NOT
// HANA"). Every write the request path asks for throws, as on the read-only
// HANA client; the seed below is the fixture's content, written before the
// client is handed out, the way tables.json is fake-client.mjs's.
//
// A table the fixture does not hold answers no rows (the request path reads
// a few tables of its own) and is remembered in `missing`.
import {SQLiteDatabaseClient} from "../../../tools/sqlite-heap-client.mjs";

export const CLIENT = "100";

// the DDL the generation writes for SQLite for these DDIC tables
const DDL = [
  `CREATE TABLE 'zosd_h5x_bp' ('client' NCHAR(3) COLLATE RTRIM, 'partner_id' NCHAR(10) COLLATE RTRIM, 'name' NCHAR(80) COLLATE RTRIM, 'addr_key' NCHAR(10) COLLATE RTRIM, 'changed_at' DECIMAL(21,7), PRIMARY KEY('client','partner_id'));`,
  `CREATE TABLE 'zosd_h5x_ad' ('client' NCHAR(3) COLLATE RTRIM, 'node_key' NCHAR(10) COLLATE RTRIM, 'city' NCHAR(40) COLLATE RTRIM, 'country' NCHAR(3) COLLATE RTRIM, PRIMARY KEY('client','node_key'));`,
  `CREATE TABLE 'zosd_h5x_so' ('client' NCHAR(3) COLLATE RTRIM, 'order_id' NCHAR(10) COLLATE RTRIM, 'buyer_id' NCHAR(10) COLLATE RTRIM, PRIMARY KEY('client','order_id'));`,
  `CREATE TABLE 'dummy' ('dummy' NCHAR(1));`,
];

// the twin's rows, synthetic: six partners with an address, inserted out of
// key order; a seventh without one (the inner join drops it, so the list
// has six); orders for two of them
export const PARTNERS = [
  ["0000000004", "Delta Trading", "A4", 20210304050607, "Delta City", "DD"],
  ["0000000001", "Alpha Supplies", "A1", 20200101000000, "Alpha City", "AA"],
  ["0000000006", "Zeta Works", "A6", 20220506070809, "Zeta City", "ZZ"],
  ["0000000002", "Beta Foods", "A2", 20200202000000, "Beta City", "BB"],
  ["0000000005", "Epsilon Tools", "A5", 20210405060708, "Epsilon City", "EE"],
  ["0000000003", "Gamma Metals", "A3", 20210102030405, "Gamma City", "CC"],
];
export const HOMELESS = ["0000000007", "Nowhere Ltd", "A9"];
export const ORDERS = [
  ["0500000012", "0000000001"],
  ["0500000010", "0000000001"],
  ["0500000011", "0000000001"],
  ["0500000020", "0000000002"],
];

const q = (v) => `'${String(v).replaceAll("'", "''")}'`;

function seed() {
  const rows = [];
  for (const [id, name, addr, changed, city, country] of PARTNERS) {
    rows.push(`INSERT INTO zosd_h5x_bp VALUES (${q(CLIENT)}, ${q(id)}, ${q(name)}, ${q(addr)}, ${changed});`);
    rows.push(`INSERT INTO zosd_h5x_ad VALUES (${q(CLIENT)}, ${q(addr)}, ${q(city)}, ${q(country)});`);
  }
  rows.push(`INSERT INTO zosd_h5x_bp VALUES (${q(CLIENT)}, ${q(HOMELESS[0])}, ${q(HOMELESS[1])}, ${q(HOMELESS[2])}, 20200101000000);`);
  for (const [order, partner] of ORDERS) rows.push(`INSERT INTO zosd_h5x_so VALUES (${q(CLIENT)}, ${q(order)}, ${q(partner)});`);
  rows.push(`INSERT INTO dummy VALUES ('X');`);
  return rows;
}

class WriteRefused extends Error {
  constructor(what) {
    super(`twin client: ${what} refused -- this database is read-only`);
    this.code = "FAKE_READONLY";
  }
}

const READS = new Set(["SELECT", "SET", "COMMIT", "ROLLBACK"]);
const firstWord = (sql) => (/^\s*([A-Za-z]+)/.exec(String(sql))?.[1] ?? "").toUpperCase();
const noSuchTable = (error) => /no such table/i.test(String(error?.message ?? error));

export function createClient(options = {}) {
  const inner = new SQLiteDatabaseClient({trace: false});
  const missing = new Set();
  const tolerant = async (call, sql) => {
    try {
      return await call();
    } catch (error) {
      if (!noSuchTable(error)) throw error;
      missing.add(/no such table:\s*(\S+)/i.exec(String(error.message))?.[1] ?? "?");
      return undefined;
    }
  };
  return {
    // the runtime sets sy-dbsys from the name of the DEFAULT connection;
    // this is SQLite, and it says so
    name: "sqlite",
    options,
    missing,
    async connect() {
      await inner.connect();
      // the fixture's content, before anybody else holds the client
      inner.sqlite.exec([...DDL, ...seed()].join("\n"));
    },
    async disconnect() { await inner.disconnect(); },
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    async execute(sql) {
      for (const one of (Array.isArray(sql) ? sql : [sql])) {
        if (one === "" || one === undefined) continue;
        if (!READS.has(firstWord(one))) throw new WriteRefused(firstWord(one) || "statement");
      }
    },
    async insert({table}) { throw new WriteRefused(`INSERT ${table}`); },
    async update({table}) { throw new WriteRefused(`UPDATE ${table}`); },
    async delete({table}) { throw new WriteRefused(`DELETE ${table}`); },
    async select(input) {
      return (await tolerant(() => inner.select(input), input.select)) ?? {rows: []};
    },
    async openCursor(input) {
      const cursor = await tolerant(() => inner.openCursor(input), input.select);
      return cursor ?? {fetchNextCursor: async () => ({rows: []}), closeCursor: async () => {}};
    },
  };
}
