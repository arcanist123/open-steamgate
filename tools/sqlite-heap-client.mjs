import {SQLiteDatabaseClient as UpstreamClient} from "@abaplint/database-sqlite";
import {setupSqliteConnection} from "./sqlite-connection.mjs";
import {abapSelectToSql} from "./osd-sql-literals.mjs";
import {osqlSemanticsError} from "./osql-error.mjs";

// ANOMALY-2026-10-03-sqlite-execute-stack: sql.js run(string) copies SQL
// onto the fixed WASM stack. exec(string) allocates it on the growable heap
// and frees it in finally. Keep this seam shared by Node and the preview
// until database-sqlite ships the equivalent fix.
export class SQLiteDatabaseClient extends UpstreamClient {
  async connect(data) {
    await super.connect(data);
    setupSqliteConnection(this.sqlite);
  }

  export() {
    const data = super.export();
    if (this.sqlite) setupSqliteConnection(this.sqlite);
    return data;
  }

  async execute(sql) {
    if (typeof sql === "string") {
      if (sql !== "") this.sqlite.exec(sql);
    } else {
      for (const statement of sql) await this.execute(statement);
    }
  }

  // ANOMALY-2026-11-14-sql-literals-statement-text: the published select()
  // and openCursor() rewrite the whole statement, literals included ('a~b'
  // was sent as 'a.b', 'x UP TO 9 ROWS' as 'x' plus a LIMIT 9), and rewrite
  // and run in one method, so the rewrite cannot be wrapped. Both are done
  // here with the same rewrites on the code only, until the package ships
  // the fix carried on the pinned transpiler fork.
  async select(options) {
    const sql = abapSelectToSql(options.select, {primaryKey: options.primaryKey, substr: true});
    if (this.trace === true) console.log(sql);
    let result;
    try {
      result = this.sqlite.exec(sql);
    } catch (error) {
      throw await osqlSemanticsError(error);
    }
    return {rows: this.convert(result)};
  }

  // the published cursor rewrote UP TO only, so a cursor over an aliased
  // join (b~name) was a syntax error here and nowhere else: it gets the
  // rewrites the SQLite file client's cursor has always had
  async openCursor(options) {
    const statement = this.sqlite.prepare(abapSelectToSql(options.select, {primaryKey: options.primaryKey, substr: true}), null);
    return {
      fetchNextCursor: (packageSize) => this.fetchNextCursor(packageSize, statement),
      closeCursor: () => this.closeCursor(statement),
    };
  }
}
