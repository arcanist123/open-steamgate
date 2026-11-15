// A transpiler DatabaseClient over a real SQLite file — the rows on disk
// while the process runs, not exported when it exits.
//
// The shape is @abaplint/database-sqlite's to the letter: the same SQL
// rewrites, the same LUW (a modifying statement opens the transaction,
// COMMIT WORK and ROLLBACK WORK end it), subrc 4 on a refused statement,
// changes() for dbcnt. What differs is underneath: node:sqlite (Node's
// own binding, no native module to install) over a file in WAL mode, so a
// write is on disk at COMMIT, a crash loses nothing committed, and a
// second connection — a data preview, a fork about to be taken — reads
// the last committed state without blocking the writer.
//
// This is B4 of docs/generations.md. sql.js stays for the in-memory case
// and the browser; DuckDB stays where it is. Same eleven methods, so
// nothing above the seam knows which of the three it is talking to.
import {DatabaseSync} from "node:sqlite";
import {bindValue, abapTypeLetter} from "./abap-types.mjs";
import {trimLiterals} from "./sql-literals.mjs";
import {abapSelectToSql} from "./osd-sql-literals.mjs";
import {existsSync, mkdirSync, renameSync, rmSync} from "node:fs";
import {dirname} from "node:path";
import {fingerprintOf} from "./osd-persist.mjs";
import {osqlSemanticsError} from "./osql-error.mjs";
import {prepareOperationsFileChange} from "./osd-operations-files.mjs";

import {setupSqliteConnection, setupSqliteBusyTimeout} from "./sqlite-connection.mjs";

const STAMP = "osd_schema";

// Where the rows live when nobody says: beside the tree, out of git. One
// expression, so the supervisor that names the database and the child that
// opens it cannot disagree about which file that is.
//
// **It follows the port, and that is not cosmetic.** `STG_PORT` isolates the
// socket so two sessions can run side by side -- CLAUDE.md says so in as many
// words -- but the database file was one constant, so the second instance
// opened the file the first one was writing and got `SQLITE_IOERR_SHORT_READ`
// (errcode 522), which surfaces as "disk I/O error" and names nothing. Found
// 2026-09-19 by running `npm run example` on port 3141 while a deployment
// held 3030. The port isolated the socket and nothing isolated the data.
//
// The default port keeps the plain name, so an existing database is still
// found and nobody's rows move.
export const DEFAULT_DATABASE = (() => {
  const port = process.env.STG_PORT;
  return port === undefined || port === "3030"
    ? ".local/db/osd.sqlite"
    : `.local/db/osd-${port}.sqlite`;
})();

// where a seeded database is kept once per DDIC, so the next instance copies
// it instead of seeding again: .local/db/base/<schema-hash>.sqlite
export const BASE_DIR = process.env.STG_DB_BASE ?? ".local/db/base";

// A WAL database is three files and only one of them is the database.
// Moving `x.sqlite` aside and leaving `x.sqlite-shm` where it was leaves a
// shared-memory WAL index named after a database that is no longer there,
// and the next process to open a fresh `x.sqlite` maps it: the index says
// the database has a thousand pages, the file has one, and the read past
// the end comes back as `SQLITE_IOERR_SHORT_READ` (522), which prints as
// "disk I/O error" and names nothing.
//
// That is not a theory. It took the i7 deployment down for eight hours on
// 2026-09-19: the drift path moved a database aside at 10:28 while a
// runtime from the previous night still had it open, so SQLite's own rule
// -- the last connection to close deletes the -wal and the -shm -- did not
// fire, because that connection never closed. The -wal was unlinked and the
// -shm was not, and every runtime that booted afterwards died on
// `PRAGMA journal_mode = WAL` before answering anything.
//
// So the sidecars travel with the database, and a caller that only wants
// the database gone says so by passing no destination.
export const SIDECARS = ["-wal", "-shm"];

export function setAsideDatabase(path, aside) {
  prepareOperationsFileChange(path);
  if (aside !== undefined) prepareOperationsFileChange(aside);
  if (aside === undefined) {
    rmSync(path, {force: true});
  } else {
    renameSync(path, aside);
  }
  for (const suffix of SIDECARS) {
    if (existsSync(`${path}${suffix}`) === false) {
      continue;
    }
    if (aside === undefined) {
      rmSync(`${path}${suffix}`, {force: true});
    } else {
      renameSync(`${path}${suffix}`, `${aside}${suffix}`);
    }
  }
  return aside;
}

// A fork: a consistent single-file copy of a database, taken while it is
// open and even while its writer holds an open LUW — the copy carries the
// last commit and nothing of the open transaction. VACUUM INTO does that on
// one connection, which is why a fork is not a cp of a file with a WAL
// beside it. Written to a temporary name and renamed, so a fork that exists
// is whole.
export function forkDatabase(from, to) {
  mkdirSync(dirname(to), {recursive: true});
  const temporary = `${to}.forking`;
  const src = new DatabaseSync(from, {readOnly: true});
  try {
    setupSqliteBusyTimeout(src);
    src.exec(`VACUUM INTO '${temporary.replace(/'/g, "''")}'`);
  } finally {
    src.close();
  }
  prepareOperationsFileChange(to);
  renameSync(temporary, to);
  return to;
}

// the reference client's rewrites, on the code only: a value is sent as it
// was written (osd-sql-literals)
function rewriteSelect(select, primaryKey) {
  return abapSelectToSql(select, {primaryKey, substr: true});
}

// node:sqlite hands integers back as numbers (or bigints past 2^53) and
// everything else as the text the schema stores; the runtime wants numbers
function plain(row) {
  for (const k of Object.keys(row)) {
    if (typeof row[k] === "bigint") {
      row[k] = Number(row[k]);
    }
  }
  return row;
}

export class FileSqliteClient {
  constructor(input = {}) {
    this.name = "sqlite";
    this.path = input.path ?? ":memory:";
    this.connected = false;
    this.readOnly = input.readOnly === true;
    this.trace = input.trace === true;
    this.db = undefined;
    this.inTransaction = false;
  }

  async connect() {
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), {recursive: true});
    }
    this.db = new DatabaseSync(this.path, {readOnly: this.readOnly});
    setupSqliteBusyTimeout(this.db);
    if (this.path !== ":memory:" && !this.readOnly) {
      // WAL: readers do not block the writer and see the last commit;
      // NORMAL: durable at checkpoint, which is what a local system wants
      this.db.exec("PRAGMA journal_mode = WAL");
      this.db.exec("PRAGMA synchronous = NORMAL");
    }
    setupSqliteConnection(this.db);
    if (globalThis.abap?.context?.databaseConnections?.DEFAULT === this) {
      globalThis.abap.builtin.sy.get().dbsys?.set(this.name);
    }
    this.connected = true;
  }

  async disconnect() {
    await this.commit();
    this.db?.close();
    this.db = undefined;
    this.connected = false;
  }

  async execute(sql) {
    if (Array.isArray(sql)) {
      for (const s of sql) {
        await this.execute(s);
      }
      return;
    }
    if (sql === "") {
      return;
    }
    if (this.trace) {
      console.log(sql);
    }
    this.db.exec(/^\s*INSERT/i.test(sql) ? trimLiterals(sql) : sql);
  }

  async beginTransaction() {
    if (this.inTransaction) {
      return;
    }
    this.db.exec("BEGIN TRANSACTION");
    this.inTransaction = true;
  }

  /** A write a SQLScript body makes: in the LUW like an Open SQL write, so
   *  a ROLLBACK WORK takes it back */
  async write({sql, params = []}) {
    await this.beginTransaction();
    await this.native({sql, params, expect: "none"});
  }

  async commit() {
    this.#end("COMMIT");
  }

  async rollback() {
    this.#end("ROLLBACK");
  }

  #end(sql) {
    if (!this.inTransaction) {
      return;
    }
    this.db.exec(sql);
    this.inTransaction = false;
  }

  #changes(sql) {
    if (this.trace) {
      console.log(sql);
    }
    return Number(this.db.prepare(sql).run().changes ?? 0);
  }

  async delete(options) {
    await this.beginTransaction();
    let sql = `DELETE FROM ${options.table}`;
    if (options.where !== "") {
      sql += trimLiterals(` WHERE ${options.where}`);
    }
    try {
      const dbcnt = this.#changes(sql);
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch {
      return {subrc: 4, dbcnt: 0};
    }
  }

  async update(options) {
    await this.beginTransaction();
    const sql = trimLiterals(`UPDATE ${options.table} SET ${options.set.join(", ")} WHERE ${options.where}`);
    try {
      const dbcnt = this.#changes(sql);
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch {
      return {subrc: 4, dbcnt: 0};
    }
  }

  async insert(options) {
    await this.beginTransaction();
    // The padding goes no further than here. ABAP hands over a CHAR padded
    // to its field length, a real system does not keep the blanks (measured
    // on A4H: a CHAR(30) holding '$TMP' answers LENGTH 4), and the DuckDB
    // and HANA clients have trimmed since they were written. This one did
    // not, so the same ABAP INSERT stored three characters there and ten
    // here -- on the engine the deployed showcase runs. SQLite got away with
    // it because its columns are COLLATE RTRIM and comparisons therefore
    // ignore the blanks; LENGTH, SUBSTR and || do not (2026-09-19).
    const sql = trimLiterals(`INSERT INTO ${options.table} (${options.columns.map((c) => "'" + c + "'").join(",")}) VALUES (${options.values.join(",")})`);
    try {
      this.#changes(sql);
      return {subrc: 0, dbcnt: 1};
    } catch (error) {
      if (this.trace) {
        console.dir(error);
      }
      return {subrc: 4, dbcnt: 0}; // a UNIQUE constraint, as the reference answers it
    }
  }

  async query(sql) {
    if (this.trace) {
      console.log(sql);
    }
    try {
      return this.db.prepare(sql).all().map(plain);
    } catch (error) {
      throw await osqlSemanticsError(error);
    }
  }

  async checkSelect(sql) {
    const statement = this.db.prepare(rewriteSelect(sql));
    // Node 26 can finalize explicitly; Node 22/24 leave it to the database
    // connection/GC and expose neither close nor Symbol.dispose.
    statement.close?.();
  }

  // ---------------------------------------------------------------------
  // The native channel (docs/db-seam-native.md), for one caller: the
  // SQLScript splitter's lowering. **Nothing transpiled from ABAP may reach
  // these** -- Open SQL goes through select()/insert()/update()/delete(),
  // which rewrite and trim; a statement arriving here is sent untouched.
  // ---------------------------------------------------------------------

  get supportsNative() {
    return true;
  }

  #bind(params = []) {
    return params.map((p) => {
      if (p.isNull === true) {
        return null;
      }
      const value = bindValue(p);
      // node:sqlite binds every JavaScript number as REAL, so an INTEGER
      // parameter read back as text was '1.0' where HANA (and sql.js, which
      // binds an integral number as INTEGER) give '1' -- measured 2026-09-24.
      // An integer type's integral value goes as a BigInt, which binds as INTEGER
      if (typeof value === "number" && Number.isSafeInteger(value) && ["I", "B", "S"].includes(abapTypeLetter(p.type))) {
        return BigInt(value);
      }
      return value;
    });
  }

  async native({sql, params = [], expect = "rows"}) {
    if (this.trace) {
      console.log("native:", sql, params.length ? JSON.stringify(params) : "");
    }
    const stmt = this.db.prepare(sql);
    const bound = this.#bind(params);
    if (expect === "none") {
      const info = stmt.run(...bound);
      return {rowCount: Number(info?.changes ?? 0)};
    }
    const rows = stmt.all(...bound).map(plain);
    // SQLite has no declared type for an expression, and node:sqlite does not
    // report one for a column either, so `columns` carries names with an
    // undefined type rather than a guess. A caller that needs the type has to
    // get it from the lowering, which knows it -- this engine cannot say.
    const columns = rows.length === 0 ? [] : Object.keys(rows[0]).map((name) => ({name, type: undefined}));
    if (expect === "scalar") {
      const first = rows[0];
      return {value: first === undefined ? undefined : first[Object.keys(first)[0]], columns};
    }
    return {rows, columns, rowCount: rows.length};
  }

  async defineRelation({name = "rel", sql, params = [], materialise, ddl}) {
    // A **definition** carrying bind values would have to keep them alive for
    // the life of the relation, which is why this refuses. A **materialised**
    // relation would not: `CREATE TABLE ... AS <select>` consumes the values
    // once, at creation, and the table that remains carries rows and no
    // parameters. The refusal used to cover both, and so was wider than its
    // own reason by exactly the case the divergence instrument needs -- a
    // literal is in almost every real body, so forcing a step that carried one
    // was impossible and "no divergences found" would have been a statement
    // about how little we forced (fable-osd, 2026-09-19).
    if (params.length > 0 && materialise === undefined) {
      throw new Error("defineRelation: params are not supported on a definition; materialise it, or bind at use");
    }
    this.relationCount = (this.relationCount ?? 0) + 1;
    const ident = `OSD_${String(name).replace(/[^A-Za-z0-9_]/g, "_").toUpperCase()}_${process.pid}_${this.relationCount}`;
    const handle = {ident, ref: `"${ident}"`,
      kind: materialise === undefined ? "definition" : "materialised", reason: materialise};
    // an ordinary table, not a temporary one: the reference has to be
    // spliceable anywhere, and the client drops it itself
    if (ddl !== undefined) {
      // a table the caller fills (tools/ir-host-relation.mjs): created from
      // the caller's column list, empty, and dropped like any materialised one
      if (materialise === undefined) throw new Error("defineRelation: a ddl relation is materialised");
      // a process that died left its tables in a persistent file, and a
      // later one with the same pid would collide with them
      this.db.exec(`DROP TABLE IF EXISTS ${handle.ref}`);
      this.db.exec(ddl(handle.ref));
    } else if (materialise === undefined) {
      this.db.exec(`CREATE VIEW ${handle.ref} AS ${sql}`);
    } else {
      await this.native({sql: `CREATE TABLE ${handle.ref} AS ${sql}`, params, expect: "none"});
    }
    return handle;
  }

  /** defineRelation takes `ddl`: host relations can be created here */
  get relationDdl() { return true; }

  relationRef(handle) {
    return handle.ref;
  }

  relationKind(handle) {
    return {kind: handle.kind, reason: handle.reason};
  }

  async dropRelation(handle) {
    try {
      this.db.exec(`DROP ${handle.kind === "definition" ? "VIEW" : "TABLE"} ${handle.ref}`);
    } catch {
      // already gone
    }
  }

  async select(options) {
    options.select = rewriteSelect(options.select, options.primaryKey);
    return {rows: await this.query(options.select)};
  }

  async openCursor(options) {
    const statement = this.db.prepare(rewriteSelect(options.select, options.primaryKey));
    const iterator = statement.iterate();
    let done = false;
    return {
      fetchNextCursor: async (packageSize) => {
        const rows = [];
        while (!done && rows.length < packageSize) {
          const next = iterator.next();
          if (next.done) {
            done = true;
            break;
          }
          rows.push(plain(next.value));
        }
        return {rows};
      },
      closeCursor: async () => {
        done = true;
        iterator.return?.();
      },
    };
  }

  // a fork of this database, from this connection: committed rows only
  fork(to) {
    mkdirSync(dirname(to), {recursive: true});
    const temporary = `${to}.forking`;
    this.db.exec(`VACUUM INTO '${temporary.replace(/'/g, "''")}'`);
    renameSync(temporary, to);
    return to;
  }

  // The stamp: which DDIC these rows were made for. The same table and the
  // same fingerprint tools/osd-persist.mjs writes into an exported file, so
  // the two kinds of file say the same thing about themselves.
  async stampedSchema() {
    try {
      return this.db.prepare(`SELECT fingerprint FROM ${STAMP} LIMIT 1`).get()?.fingerprint;
    } catch {
      return undefined; // no such table: nobody recorded a schema
    }
  }

  async stamp(schema) {
    const fingerprint = fingerprintOf(schema);
    this.db.exec(`CREATE TABLE IF NOT EXISTS ${STAMP} ('fingerprint' NCHAR(16), 'at' NCHAR(32));`);
    this.db.exec(`DELETE FROM ${STAMP};`);
    this.db.exec(`INSERT INTO ${STAMP} ('fingerprint', 'at') VALUES ('${fingerprint}', '${new Date().toISOString()}');`);
    return fingerprint;
  }
}
