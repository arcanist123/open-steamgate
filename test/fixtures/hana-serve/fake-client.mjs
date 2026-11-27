// A fake DatabaseClient for test/hana-serve.mjs: the eleven members of
// docs/db-backends.md, reads answered from tables.json beside this file,
// every write thrown. It stands where tools/hana-client.mjs stands in
// existing-schema mode, so the host's boot and request path run against a
// database that cannot be written to and that has no HANA behind it.
//
// Not a SQL engine: a SELECT is answered with the rows of the first table
// named after FROM (the fixture's own small tables, in their order); the
// positive control of tools/hana-serve.mjs is answered as HANA would. A
// table the fixture does not hold answers no rows and is remembered, so the
// test can say which reads the request path made.
import {readFileSync, appendFileSync} from "node:fs";

const tables = JSON.parse(readFileSync(new URL("./tables.json", import.meta.url), "utf8"));

class WriteRefused extends Error {
  constructor(what) {
    super(`fake client: ${what} refused -- this database is read-only`);
    this.code = "FAKE_READONLY";
  }
}

const firstWord = (sql) => (/^\s*([A-Za-z]+)/.exec(String(sql))?.[1] ?? "").toUpperCase();

export function createClient(options = {}) {
  const asked = [];
  const note = (line) => {
    if (process.env.FAKE_CLIENT_LOG) appendFileSync(process.env.FAKE_CLIENT_LOG, `${line}\n`);
  };
  const rowsFor = (sql) => {
    if (String(sql).includes("'OSD_TRACE_PROBE'")) return [{probe: "OSD_TRACE_PROBE"}];
    // a schema-qualified name ("SCHEMA"."TABLE") answers from the table
    const table = /\bFROM\s+(?:"?[A-Za-z0-9_/]+"?\.)?"?([A-Za-z0-9_/]+)"?/i.exec(String(sql))?.[1]?.toLowerCase();
    asked.push(table);
    note(`select ${table}`);
    return (tables[table] ?? []).map((row) => ({...row}));
  };
  return {
    name: "HDB",
    asked,
    options,
    async connect() {},
    async disconnect() {},
    async beginTransaction() {},
    async commit() {},
    async rollback() {},
    async execute(sql) {
      for (const one of (Array.isArray(sql) ? sql : [sql])) {
        if (one === "" || one === undefined) continue;
        const kind = firstWord(one);
        if (kind !== "SELECT" && kind !== "SET" && kind !== "COMMIT" && kind !== "ROLLBACK") throw new WriteRefused(kind || "statement");
      }
    },
    async insert({table}) { throw new WriteRefused(`INSERT ${table}`); },
    async update({table}) { throw new WriteRefused(`UPDATE ${table}`); },
    async delete({table}) { throw new WriteRefused(`DELETE ${table}`); },
    async select({select}) {
      return {rows: rowsFor(select)};
    },
    async openCursor({select}) {
      const rows = rowsFor(select);
      return {
        fetchNextCursor: async (n) => ({rows: rows.splice(0, n)}),
        closeCursor: async () => {},
      };
    },
  };
}
