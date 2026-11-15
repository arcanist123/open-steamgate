// Browser DatabaseClient for the same DuckDB connection used by Open SQL,
// OData and Portable AMDP. The blocking binding runs inside the existing
// service worker: creating a nested Worker is forbidden there.
import {createDuckDB, BROWSER_RUNTIME, VoidLogger} from "@duckdb/duckdb-wasm/blocking";
import {bindValue} from "./abap-types.mjs";
import {trimLiterals} from "./sql-literals.mjs";
import {abapSelectToSql} from "./osd-sql-literals.mjs";
import {osqlSemanticsError} from "./osql-error.mjs";

function plain(value) {
  if (typeof value === "bigint") return Number(value);
  if (value === null || value === undefined || value instanceof Date) return value;
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return value;
}

function rowsOf(table) {
  return table.toArray().map((record) => Object.fromEntries(
    Object.entries(record.toJSON()).map(([key, value]) => [key, plain(value)])));
}

export class DuckDBWasmClient {
  constructor({wasmURL, trace = false} = {}) {
    this.name = "duckdb";
    this.engine = "duckdb-wasm";
    this.wasmURL = wasmURL ?? new URL("duckdb-mvp.wasm", self.location.href).href;
    this.trace = trace;
    this.connected = false;
    this.inTransaction = false;
    this.luw = [];
    this.relationCount = 0;
  }

  async connect() {
    this.bindings = await createDuckDB({mvp: {mainModule: this.wasmURL, mainWorker: ""}},
      new VoidLogger(), BROWSER_RUNTIME);
    await this.bindings.instantiate(() => undefined);
    this.bindings.open({path: ":memory:", query: {castBigIntToDouble: true}});
    this.connection = this.bindings.connect();
    this.connected = true;
    if (globalThis.abap?.context?.databaseConnections?.DEFAULT === this) {
      globalThis.abap.builtin.sy.get().dbsys?.set(this.name);
    }
  }

  async disconnect() {
    await this.commit();
    this.connection?.close();
    this.bindings?.reset();
    this.connection = undefined;
    this.bindings = undefined;
    this.connected = false;
  }

  async missingTables(expected) {
    const found = new Set((await this.query("SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'"))
      .map((row) => String(row.table_name).toUpperCase()));
    return expected.filter((name) => !found.has(String(name).toUpperCase()));
  }

  async execute(sql) {
    if (Array.isArray(sql)) {
      for (const one of sql) await this.execute(one);
      return;
    }
    if (!sql) return;
    const statement = /^\s*INSERT/i.test(sql) ? trimLiterals(sql) : sql;
    if (this.trace) console.log(statement);
    this.connection.query(statement);
  }

  async beginTransaction() {
    if (this.inTransaction) return;
    this.connection.query("BEGIN TRANSACTION");
    this.inTransaction = true;
    this.luw = [];
  }

  async commit() {
    if (!this.inTransaction) return;
    this.connection.query("COMMIT");
    this.inTransaction = false;
    this.luw = [];
  }

  async rollback() {
    if (!this.inTransaction) return;
    this.connection.query("ROLLBACK");
    this.inTransaction = false;
    this.luw = [];
  }

  async modifying(sql) {
    await this.beginTransaction();
    try {
      const result = rowsOf(this.connection.query(sql));
      this.luw.push(sql);
      return result.length ? Number(Object.values(result[0])[0] ?? 0) : 0;
    } catch (error) {
      // DuckDB has no SAVEPOINT. Preserve successful statements in the LUW.
      this.connection.query("ROLLBACK");
      this.connection.query("BEGIN TRANSACTION");
      for (const done of this.luw) this.connection.query(done);
      throw error;
    }
  }

  async delete(options) {
    const sql = trimLiterals(`DELETE FROM ${options.table}${options.where ? ` WHERE ${options.where}` : ""}`);
    try {
      const dbcnt = await this.modifying(sql);
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch { return {subrc: 4, dbcnt: 0}; }
  }

  async update(options) {
    const sql = trimLiterals(`UPDATE ${options.table} SET ${options.set.join(", ")} WHERE ${options.where}`);
    try {
      const dbcnt = await this.modifying(sql);
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch { return {subrc: 4, dbcnt: 0}; }
  }

  async insert(options) {
    const sql = trimLiterals(`INSERT INTO ${options.table} (${options.columns.map((column) => `"${column}"`).join(",")}) VALUES (${options.values.join(",")})`);
    try {
      return {subrc: 0, dbcnt: await this.modifying(sql)};
    } catch { return {subrc: 4, dbcnt: 0}; }
  }

  rewrite(select, primaryKey) {
    // on the code only: a value is sent as it was written (osd-sql-literals)
    return trimLiterals(abapSelectToSql(select, {primaryKey}));
  }

  async query(sql) {
    if (this.trace) console.log(sql);
    try {
      return rowsOf(this.connection.query(sql));
    } catch (error) {
      throw await osqlSemanticsError(error);
    }
  }

  get supportsNative() { return true; }

  async native({sql, params = [], expect = "rows"}) {
    if (this.trace) console.log("native:", sql, params.length);
    const statement = this.connection.prepare(sql);
    try {
      const table = statement.query(...params.map((p) => p.isNull ? null : bindValue(p)));
      if (expect === "none") return {rowCount: undefined};
      const columns = table.schema.fields.map((field) => ({name: field.name, type: String(field.type)}));
      const rows = rowsOf(table);
      if (expect === "scalar") {
        const first = rows[0];
        return {value: first === undefined ? undefined : first[Object.keys(first)[0]], columns};
      }
      return {rows, columns, rowCount: rows.length};
    } finally {
      statement.close();
    }
  }

  async defineRelation({name = "rel", sql, params = [], materialise}) {
    if (params.length && materialise === undefined) {
      throw new Error("defineRelation: params require materialisation");
    }
    const ident = `OSD_${String(name).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}_${++this.relationCount}`;
    const handle = {ident, ref: `"${ident}"`, kind: materialise === undefined ? "definition" : "materialised", reason: materialise};
    if (materialise === undefined) await this.execute(`CREATE VIEW ${handle.ref} AS ${sql}`);
    else await this.native({sql: `CREATE TABLE ${handle.ref} AS ${sql}`, params, expect: "none"});
    return handle;
  }

  relationRef(handle) { return handle.ref; }
  relationKind(handle) { return {kind: handle.kind, reason: handle.reason}; }
  async dropRelation(handle) {
    await this.execute(`DROP ${handle.kind === "definition" ? "VIEW" : "TABLE"} ${handle.ref}`).catch(() => undefined);
  }

  async select(options) { return {rows: await this.query(this.rewrite(options.select, options.primaryKey))}; }

  async openCursor(options) {
    const rows = await this.query(this.rewrite(options.select, options.primaryKey));
    let offset = 0;
    return {
      fetchNextCursor: async (packageSize) => {
        const slice = rows.slice(offset, offset + packageSize);
        offset += packageSize;
        return {rows: slice};
      },
      closeCursor: async () => undefined,
    };
  }
}

export function duckdbSchema(schemas) {
  return schemas.pg.map((statement) => statement.replace(/NCHAR\((\d+)\)/g, "VARCHAR($1)"));
}

export function duckdbInserts(inserts) {
  return inserts.map((statement) => statement.replace(/^(INSERT INTO \S+ \()([^)]*)\)/i, (match, head, columns) =>
    head + columns.replace(/'([A-Za-z_0-9]+)'/g, (whole, column) => `"${column.toLowerCase()}"`) + ")"));
}
