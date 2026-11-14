// The data of OSD: what a client reads when it asks for table contents.
//
// vsp does not ask for a table, it asks for SQL, through
// /sap/bc/adt/datapreview/freestyle. So this is one method, query, and the
// rows come from the same database the ABAP runtime uses: the schema the
// transpiler generated from the DDIC in src/ and the libraries, the rows
// the seed put there, the dialect the database client knows. One place
// knows about all three, and it is this one, not the façade.
//
// Booting the transpiled runtime is how we get that database rather than a
// second one beside it: OSD has exactly one system, and a read through the
// façade sees what a program running inside sees.
import {singleSelect, selectSQLiteOne} from './adt-single-select.mjs';
import {abapSelectToSql} from './osd-sql-literals.mjs';
import {existsSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "./osd-main.mjs";

// What a client sends is Open SQL, and the database speaks SQL. The one
// difference that reaches this door: Eclipse's data preview writes the
// field list of a table the way a 7.x report does, blank-separated and
// without commas ("SELECT T~A T~B FROM T"), which SQLite refuses as a
// syntax error; the A4H oracle of the same request has commas, because a
// newer release writes them. Both are Open SQL, so both are accepted here:
// a list with no comma in it is split on blanks and joined with commas.
// The tilde is the database client's to translate. "UP TO n ROWS" is the
// Open SQL row limit and becomes the SQL one. Nothing else is rewritten;
// a WHERE clause the client writes travels as written.
/** A read through a door of the serving child, retried once when the pooled
 *  keep-alive socket was closed under it (undici UND_ERR_SOCKET, "other side
 *  closed"). Only for doors that do not write: /osd/sql runs one SELECT. */
export async function readDoor(url, init, fetchImpl = fetch) {
  try {
    return await fetchImpl(url, init);
  } catch (error) {
    if (error?.cause?.code !== "UND_ERR_SOCKET") throw error;
    return fetchImpl(url, init);
  }
}

export function openSqlToSql(text) {
  let out = text;
  const head = /^(select\s+(?:distinct\s+)?)(.+?)(\s+from\s+)/is.exec(out);
  if (head !== null) {
    const [, keyword, list, from] = head;
    // Only a sequence of plain field names is the old comma-less syntax.
    // Eclipse's row-count query is COUNT( * ); splitting inside the function
    // turned it into COUNT(, *, ) and made F8 counts fail on every backend.
    if (!list.includes(",") && /^[A-Za-z_/$][\w/$~]*(?:\s+[A-Za-z_/$][\w/$~]*)+$/.test(list.trim())) {
      out = keyword + list.trim().split(/\s+/).join(", ") + from + out.slice(head[0].length);
    }
  }
  const upTo = /\s+up\s+to\s+(\d+)\s+rows\b/i.exec(out);
  if (upTo !== null) {
    out = out.replace(upTo[0], "") + ` LIMIT ${upTo[1]}`;
  }
  return out;
}

export class Data {
  constructor(options = {}) {
    this.root = options.root ?? process.cwd();
    // a caller that already has the runtime up, a server serving requests,
    // hands its connection in rather than letting a second runtime boot and
    // re-seed the database underneath it
    this.client = options.client;
    // or hands the supervised runtime, and every query goes through its
    // door (POST /osd/sql on tools/osd-serve.mjs): the rows a preview shows
    // are then the rows the application serves, from one connection, and
    // this process loads no ABAP at all
    this.runtime = options.runtime;
    this.booted = this.client === undefined ? undefined : Promise.resolve(this.client);
  }

  // where the rows come from, for a caller that reports it
  get source() {
    return this.runtime !== undefined ? "serving" : this.client !== undefined ? "injected" : "in-process";
  }

  // the runtime, once; every later call reuses it
  boot() {
    if (this.booted !== undefined) {
      return this.booted;
    }
    // a host that holds only the ADT kernel (tools/adt-abap-kernel.mjs, the
    // child-mode parent) must not boot the whole system over it: init.mjs
    // installs a new runtime and the ADT sessions and locks would go with it
    if (globalThis.__osdAdtKernel !== undefined) {
      return Promise.reject(new Error("this process holds the ADT kernel; the system's ABAP runs in the serving child, not here"));
    }
    this.booted = (async () => {
      const init = join(this.root, "output", "init.mjs");
      if (existsSync(init) === false) {
        throw new NotBuilt();
      }
      const {initializeABAP} = await import(init);
      await initializeABAP();
      const client = globalThis.abap?.context?.databaseConnections?.DEFAULT;
      if (client === undefined) {
        throw new NotBuilt("the runtime came up without a database connection");
      }
      // a runtime booted here is a host like any other: its cross-reference
      // tables are filled by the module every host calls
      const {seedAtStartup} = await import("./osd-xref-seed.mjs");
      await seedAtStartup(client, {root: this.root, quiet: true});
      return client;
    })();
    return this.booted;
  }

  // SQL in, rows out. The row limit is the one the client asked for, and it
  // is applied here rather than trusted to the statement, because a client
  // that forgets it should not be able to read a million rows.
  async query(sql, options = {}) {
    sql = singleSelect(sql, word => new NotAllowed(word));
    const max = options.max ?? 100;
    if (this.runtime !== undefined) {
      return this.#throughTheDoor(sql, max);
    }
    const client = await this.boot();
    const text = openSqlToSql(String(sql).trim().replace(/;$/, ""));
    if (/^select\b/i.test(text) === false) {
      throw new NotAllowed(text.split(/\s+/)[0] ?? "");
    }
    const limited = / LIMIT \d+/i.test(text) ? text : `${text} LIMIT ${max}`;
    let answer;
    if (client.selectOne) answer = await client.selectOne(limited, max);
    else if (client.name === 'sqlite' && client.openCursor) answer = await selectSQLiteOne(client, limited, max);
    else answer = await client.select({select: limited});
    const rows = (answer.rows ?? []).slice(0, max);
    return {
      sql: limited,
      columns: rows.length > 0 ? Object.keys(rows[0]) : [],
      rows: rows.map((row) => Object.fromEntries(Object.entries(row).map(([k, v]) => [k, typeof v === "string" ? v.trimEnd() : v]))),
      count: rows.length,
      truncated: rows.length === max,
    };
  }

  // Compile a read through the active backend without fetching its rows.
  // This is deliberately a separate seam: LIMIT 0 is an ABAP Open SQL idiom
  // that the runtime adapters erase, so query(..., {max: 0}) is not a safe
  // substitute for prepare-only validation.
  async check(sql) {
    sql = singleSelect(sql, word => new NotAllowed(word));
    if (this.runtime !== undefined) {
      await this.runtime.ensure();
      const answer = await readDoor(`${this.runtime.url}/osd/sql`, {
        method: "POST",
        headers: {"content-type": "application/json"},
        body: JSON.stringify({sql: String(sql), check: true}),
      });
      const body = await answer.json().catch(() => ({}));
      if (!answer.ok) {
        const e = new Error(body?.error?.message ?? `the serving runtime answered ${answer.status}`);
        e.code = body?.error?.code ?? "FAILED";
        throw e;
      }
      return;
    }
    const client = await this.boot();
    const text = openSqlToSql(String(sql).trim().replace(/;$/, ""));
    if (/^select\b/i.test(text) === false) {
      throw new NotAllowed(text.split(/\s+/)[0] ?? "");
    }
    if (typeof client.checkSelect === "function") {
      await client.checkSelect(text);
      return;
    }
    // The browser/in-memory runtime uses the published sql.js adapter. It
    // predates this optional seam, but exposes SQLite's prepare primitive;
    // mirror its SELECT rewrites and free the compiled statement immediately.
    if (client.name === "sqlite" && typeof client.sqlite?.prepare === "function") {
      const sqlite = abapSelectToSql(text, {substr: true});
      const statement = client.sqlite.prepare(sqlite);
      statement.free?.();
      return;
    }
    const e = new Error("the active database does not expose prepare-only SQL checking");
    e.code = "CHECK_UNAVAILABLE";
    throw e;
  }

  async #throughTheDoor(sql, max) {
    await this.runtime.ensure();
    const answer = await readDoor(`${this.runtime.url}/osd/sql`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({sql: String(sql), max}),
    });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) {
      // the child's refusal, with its code, so the façade answers the
      // client the way it would have from its own connection
      const e = new Error(body?.error?.message ?? `the serving runtime answered ${answer.status}`);
      e.code = body?.error?.code ?? "FAILED";
      throw e;
    }
    return body;
  }

  // Q6b's own door: a served (child) runtime holds the live connection, so
  // a classrun runs there -- tools/osd-serve.mjs `/osd/classrun`, the same
  // shape as `#throughTheDoor` above for SQL. The façade still does the
  // "does this class implement IF_OO_ADT_CLASSRUN" check itself
  // (tools/osd-classrun.mjs `ClassRun#run`, off the source it already has),
  // so the door only ever runs a class already known to be one.
  async classrun(name, options = {}) {
    if (this.runtime === undefined) {
      const {runClassrun} = await import("./osd-classrun.mjs");
      return runClassrun(this.root, name, options);
    }
    await this.runtime.ensure();
    const answer = await fetch(`${this.runtime.url}/osd/classrun`, {
      method: "POST",
      headers: {"content-type": "application/json"},
      body: JSON.stringify({name}),
    });
    const body = await answer.json().catch(() => ({}));
    if (!answer.ok) {
      const e = new Error(body?.error?.message ?? `the serving runtime answered ${answer.status}`);
      e.code = body?.error?.code ?? "FAILED";
      throw e;
    }
    return body;
  }

  // what a table read is when the client names a table instead of writing SQL
  async table(name, options = {}) {
    const where = options.where === undefined || options.where === "" ? "" : ` WHERE ${options.where}`;
    return this.query(`SELECT * FROM ${String(name).toLowerCase()}${where}`, options);
  }

  // the tables the system has, so a client can be told what it may read
  async tables() {
    const answer = await this.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name", {max: 1000});
    return answer.rows.map((r) => String(r.name).toUpperCase());
  }
}

export class NotBuilt extends Error {
  constructor(message = "there is no output/ yet: run the transpile first") {
    super(message);
    this.code = "NOT_BUILT";
  }
}

export class NotAllowed extends Error {
  constructor(word) {
    super(`only SELECT is allowed here, not ${word.toUpperCase()}`);
    this.code = "NOT_ALLOWED";
  }
}

async function main(args) {
  const data = new Data();
  if (args[0] === "--tables") {
    const tables = await data.tables();
    console.log(`${tables.length} tables: ${tables.join(", ")}`);
    return 0;
  }
  if (args.length === 0) {
    console.log("usage: osd-data.mjs --tables | \"SELECT ...\" [max]");
    return 2;
  }
  const answer = await data.query(args[0], {max: Number(args[1] ?? 20)});
  console.log(answer.columns.join(" | "));
  for (const row of answer.rows) {
    console.log(Object.values(row).join(" | "));
  }
  console.log(`${answer.count} rows${answer.truncated ? ", truncated" : ""}`);
  return 0;
}

if (runsAs("osd-data.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(1);
  });
}
