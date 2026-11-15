// OSD on a real HANA: the eleven-method DatabaseClient of the runtime seam
// (docs/db-backends.md), over the npm driver `hdb`.
//
// Why this exists, decided 2026-09-18: HANA is the mode you switch into when
// the work is AMDP. The procedure and the tables are then in one database, so
// nothing has to be mirrored, and `sy-dbsys` says HDB the way a real system
// does. It is a mode and not a default, because the cost is per statement --
// measured against SQLite in this process, a single-row SELECT is 52x and an
// INSERT 146x, while a 200-row SELECT is only 3.8x. Set-wise ABAP ports
// nearly free; row-at-a-time ABAP does not.
//
// Three things cost work when DuckDB was added, and here two of them are
// cheaper, all measured rather than assumed:
//
//   DDL         free. HANA takes the PostgreSQL schema the transpiler already
//               writes, unchanged -- all 77 CREATE TABLE of this tree.
//   blanks      the same problem DuckDB had. ABAP CHAR is blank-padded and the
//               runtime pads its literals; HANA neither pads nor ignores the
//               padding, so `WHERE K = 'A         '` finds nothing where SQLite
//               (NCHAR ... COLLATE RTRIM) finds the row. The literals are
//               trimmed here, quote-aware, exactly as in the DuckDB client.
//   savepoints  not needed. The runtime expects a failed statement to leave the
//               transaction usable; DuckDB aborts it and our client there
//               replays the LUW. HANA behaves as the runtime expects -- a
//               duplicate-key INSERT is refused and the next INSERT is
//               accepted -- so there is no replay machinery at all.
//
// One prerequisite that is easy to miss: the session must have autocommit off,
// or COMMIT and ROLLBACK mean nothing.
import {createRequire} from "node:module";
import {bindValue} from "./abap-types.mjs";
import {readFileSync, existsSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";

const require = createRequire(import.meta.url);
import {trimLiterals} from "./sql-literals.mjs";
import {abapSelectToSql} from "./osd-sql-literals.mjs";
import {osqlSemanticsError} from "./osql-error.mjs";
import {ensureShadow, ensureShadowFor, shadowDdlSchema, tableFrom259} from "./hana-shadow-schema.mjs";


/** Every identifier this client sends goes to HANA quoted in UPPER case.
 *
 *  The schema is created that way (see hanaSchema), and it has to be, because
 *  a column called `cross` is a reserved word and cannot be created unquoted.
 *  The SQL reaching the client comes in two shapes: most references are
 *  written **unquoted and lower case**, which HANA folds to upper by itself
 *  and which therefore already match, and some arrive **quoted and lower
 *  case**, like `INSERT INTO "cross" ("type", ...)`, which do not and fail
 *  with `Could not find table/view cross`. Folding the contents of every
 *  double-quoted identifier to upper case makes both shapes land on one name.
 *
 *  **A double quote is not always an identifier**, which cost a test: a
 *  column holding the JSON `{"draft":"kept"}` is a *value*, inside single
 *  quotes, and folding it turned the data into `{"DRAFT":"KEPT"}`. So this
 *  walks the statement instead of running a regular expression over it, and
 *  copies anything inside a single-quoted literal verbatim, `''` included. */
function foldIdentifiers(sql) {
  let out = "";
  let plainRun = "";
  const flush = () => {
    // Outside any literal: the runtime builds a WHERE out of
    // `true AND true AND ...` when it has no real condition, which SQLite
    // takes and HANA answers with `incorrect syntax near "AND"`. This is the
    // one genuine dialect rewrite the client needs.
    out += plainRun.replace(/\btrue\b/gi, "1 = 1").replace(/\bfalse\b/gi, "1 = 0");
    plainRun = "";
  };
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {                       // a value: copy it exactly
      let j = i + 1;
      while (j < sql.length) {
        if (sql[j] === "'" && sql[j + 1] === "'") { j += 2; continue; }
        if (sql[j] === "'") { j += 1; break; }
        j += 1;
      }
      flush();
      out += sql.slice(i, j);
      i = j;
    } else if (c === '"') {                // an identifier: fold it
      const close = sql.indexOf('"', i + 1);
      if (close === -1) { plainRun += sql.slice(i); break; }
      const id = sql.slice(i + 1, close);
      flush();
      out += /^[A-Za-z_][A-Za-z_0-9]*$/.test(id) ? '"' + id.toUpperCase() + '"' : sql.slice(i, close + 1);
      i = close + 1;
    } else {
      plainRun += c;
      i += 1;
    }
  }
  flush();
  return out;
}

/** The first word of the statement, read outside the single-quoted literals.
 *
 *  The read-only guard refuses by kind, never by text: the text may carry
 *  data, and a message quoting it would put that data into a log. A word
 *  read from inside a literal is not a kind -- `statementKind("'INSERT …'")`
 *  is empty, and empty is refused like any kind that is not allowed. */
export function statementKind(sql) {
  let i = 0;
  let quoted = false;
  while (i < sql.length) {
    const c = sql[i];
    if (quoted) {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else quoted = false;
      }
      i += 1;
      continue;
    }
    if (c === "'") { quoted = true; i += 1; continue; }
    if (/[A-Za-z]/.test(c)) break;
    i += 1;
  }
  return (/^[A-Za-z]+/.exec(sql.slice(i))?.[0] ?? "").toUpperCase();
}

/** A top-level `;`: the text carries more than the one statement.
 *
 *  A kind is the first word of the first statement, so
 *  `SELECT 1; DROP TABLE "T"` reads as a SELECT and walks past the guard --
 *  measured, the critic round's smuggle probe, over exec and prepare. HANA
 *  itself answers a multi-statement string with a syntax error, so nothing
 *  executed; but this client's promise is to refuse before the driver sees
 *  anything at all, and the separator is what breaks it. Quote- and
 *  comment-aware, like foldIdentifiers above: a `;` counts only outside the
 *  single-quoted literals ('' an escaped quote), outside the double-quoted
 *  identifiers, and outside SQL's line and block comments. The guard
 *  refuses such a text as kind "multi" before the kind of its first word
 *  is read. */
export function isMultiStatement(sql) {
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    if (c === "'") {                       // a literal: skip it whole
      i += 1;
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") { i += 2; continue; }
        if (sql[i] === "'") { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (c === '"') {                       // a quoted identifier
      const close = sql.indexOf('"', i + 1);
      i = close === -1 ? sql.length : close + 1;
      continue;
    }
    if (c === "-" && sql[i + 1] === "-") { // a line comment, to its end
      const nl = sql.indexOf("\n", i);
      i = nl === -1 ? sql.length : nl + 1;
      continue;
    }
    if (c === "/" && sql[i + 1] === "*") { // a block comment
      const end = sql.indexOf("*/", i + 2);
      i = end === -1 ? sql.length : end + 2;
      continue;
    }
    if (c === ";") return true;
    i += 1;
  }
  return false;
}

/** a row of the seam is flat: number | string | Uint8Array | null */
function plain(value, dataType) {
  if (typeof value === "bigint") return Number(value);
  if (value === null || value === undefined) return value;
  // node-hdb returns both binary LOBs and character LOBs as Buffer. The
  // value alone cannot distinguish them: RAW/XSTRING must cross the ABAP
  // DatabaseClient seam as hexadecimal text, while CLOB/NCLOB are ordinary
  // text and must be decoded. Use HANA's declared result metadata, never a
  // payload guess. Without metadata we retain the conservative binary rule.
  if (Buffer.isBuffer(value)) {
    return [25, 26, 29, 30].includes(dataType)
      ? value.toString("utf8")
      : value.toString("hex").toUpperCase();
  }
  if (value instanceof Date) return value;
  if (typeof value === "object" && typeof value.toString === "function") return value.toString();
  return value;
}

// HANA Express in docker (saplabs/hanaexpress): 3<nn>13 is the nameserver
// (no SQL), 3<nn>17 is SYSTEMDB's SQL port, and the first tenant, HXE --
// where the application's schemas belong -- answers on 3<nn>41. Measured
// 2026-09-27 on the lab HXE: 39017 answers M_DATABASE = SYSTEMDB, 39041
// answers HXE. On a VM install the tenant is 3<nn>15; set HANA_PORT there.
export const HANA_TENANT_PORT = 39041;

export function hanaConnection(input = {}) {
  // the same search as tools/amdp-run.mjs, and for the same reason: a
  // deployment is rebuilt by rsync --delete and a bundled module has no url
  // of its own, so the password lives outside both
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const candidates = [];
  if (process.env.OSD_HANA_PASSWORD_FILE) candidates.push(process.env.OSD_HANA_PASSWORD_FILE);
  if (home !== "") candidates.push(join(home, ".osd", "hxe-password"));
  try {
    candidates.push(fileURLToPath(new URL("../.local/hxe-password", import.meta.url)));
  } catch { /* bundled: the two above are the answer */ }
  const passwordFile = candidates.find((f) => existsSync(f)) ?? "";
  const connection = {
    host: input.host ?? process.env.HANA_HOST ?? process.env.HXE_HOST ?? "localhost",
    port: Number(input.port ?? process.env.HANA_PORT ?? process.env.HXE_PORT ?? HANA_TENANT_PORT),
    user: input.user ?? process.env.HANA_USER ?? process.env.HXE_USER ?? "SYSTEM",
    password: input.password ?? process.env.HANA_PASSWORD ?? process.env.HXE_PASSWORD
      ?? (passwordFile === "" ? undefined : readFileSync(passwordFile, "utf8").trim()),
    // node-hdb defaults to a 128 KB packet and refuses a statement that does
    // not fit with "Packet size limit exceeded". The transpiler's seed puts
    // whole ABAP sources into reposrc and SMW0 media into wwwdata as hex, so
    // a single INSERT is megabytes. The driver's own maximum is 2^30-1.
    packetSize: Number(input.packetSize ?? process.env.HANA_PACKET_SIZE ?? 1024 * 1024 * 64),
    packetSizeLimit: Number(input.packetSize ?? process.env.HANA_PACKET_SIZE ?? 1024 * 1024 * 64),
  };
  // H3: the logon client rides the CONNECT, not a SET -- HANA refuses
  // `SET 'CLIENT'` (455, predefined, measured on the bed), and node-hdb moves
  // a SESSIONVARIABLE: key into the client info at connect. The same client
  // is the sy-mandt the ABAP reads, set at boot by tools/osd-identity.mjs
  // (bootIdentity).
  const client = input.client ?? process.env.OSD_CLIENT;
  if (client !== undefined && client !== "") {
    connection["SESSIONVARIABLE:CLIENT"] = client;
  }
  return connection;
}

/** HANA has no multi-row `VALUES`, so `INSERT INTO t (a,b) VALUES (1,2),(3,4)`
 *  becomes `INSERT INTO t (a,b) SELECT 1,2 FROM DUMMY UNION ALL SELECT 3,4
 *  FROM DUMMY`. Measured on HANA Express 2026-09-19: the first form is
 *  refused with `incorrect syntax near ","`, the second is accepted and the
 *  rows land.
 *
 *  **This is the second genuine dialect rewrite in this client**, after
 *  `WHERE true AND true`, and it appeared without anybody touching HANA: the
 *  seed was batched into 500-row statements to cut the unit run from 6793
 *  statements to 1711, which is a large win on SQLite and a syntax error
 *  here. Nothing caught it because the HANA suite needs a container and does
 *  not run in CI -- a pair that must agree, with the disagreement deferred
 *  to whoever next asked for HANA.
 *
 *  One pass and quote-aware, because `),(` inside a string literal is data.
 *  Doing this as a regular expression over the joined statement is the exact
 *  mistake items 7 and 8 of the list in docs/db-backends.md were: a
 *  transformation that has to tell a literal from the rest cannot be done in
 *  two passes.
 *
 *  A statement that is not a multi-row INSERT comes back unchanged, so the
 *  single-row path everything else uses is untouched. */
export function multiRowInsert(sql) {
  if (/^\s*INSERT\s+INTO\b/i.test(sql) === false) return sql;
  let quoted = false;
  let depth = 0;
  let valuesAt = -1;
  let start = -1;
  let lastEnd = -1;
  const tuples = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (quoted) {
      // '' inside a literal is an escaped quote, not the end of one
      if (ch === "'") {
        if (sql[i + 1] === "'") i++;
        else quoted = false;
      }
      continue;
    }
    if (ch === "'") {
      quoted = true;
      continue;
    }
    if (valuesAt < 0) {
      if (depth === 0 && (ch === "V" || ch === "v") && /^values\b/i.test(sql.slice(i, i + 7))) {
        valuesAt = i;
        i += 5;
      } else if (ch === "(") depth++;
      else if (ch === ")") depth--;
      continue;
    }
    if (ch === "(") {
      if (depth === 0) start = i + 1;
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        tuples.push(sql.slice(start, i));
        lastEnd = i + 1;
      }
    }
  }
  // one tuple is the ordinary INSERT and needs no help; none means this is
  // an INSERT ... SELECT, which HANA takes as written
  if (valuesAt < 0 || tuples.length < 2) return sql;
  const head = sql.slice(0, valuesAt).trimEnd();
  const tail = sql.slice(lastEnd);
  return `${head} ${tuples.map((t) => `SELECT ${t} FROM DUMMY`).join(" UNION ALL ")}${tail}`;
}

/** Schemas already dropped for this run, so the drop happens once.
 *
 *  `STG_DB_FRESH=1` says **this run** starts from nothing. It was read by
 *  **every** `connect()` instead, and a run opens more than one connection:
 *  the database client, and the AMDP destination, which holds its own.
 *
 *  What that cost, measured 2026-09-19: the wire suite on HANA did not run
 *  at all. Not slowly -- 21 minutes, 2 seconds of CPU, no output. HANA named
 *  it when asked rather than guessed at:
 *
 *      blocked 115923, owner 115920, OSD_ALICE.ZSTG_DEMO, OBJECT_LOCK
 *
 *  The first connection was seeding with autocommit off, holding every table
 *  it had written. The second ran `DROP SCHEMA ... CASCADE`, which needs an
 *  exclusive lock on each of them, and waited. Forever, and silently: the
 *  `.catch()` below cannot fire on a statement that never returns, so the
 *  suite looked like a slow database instead of a deadlock of our own making.
 *
 *  The general shape is the one this tree keeps finding: **a rule about the
 *  run, executed by each participant.** Same as the dialog step written next
 *  to one host out of three, and as the seed fix that lived outside the
 *  driver. "Fresh" is a property of the run; a connection is not the run.
 *
 *  Per process, which is what a run is here. `STG_SERVE=child` puts the
 *  runtime in a second process, and there this set is a second copy -- the
 *  spawner has to clear `STG_DB_FRESH` for the child, because by then the
 *  schema is already fresh. Not needed by anything measured today, and
 *  written down rather than guessed at. */
const freshened = new Set();

export class HanaDatabaseClient {
  constructor(input = {}) {
    // what sy-dbsys reports; a real system running on HANA says HDB
    this.name = "HDB";
    this.trace = input.trace === true;
    // upper once, here: execute() folds quoted identifiers to upper and the
    // catalog literals and SET SCHEMA go out exactly as built, so one
    // normalisation at construction keeps DDL, catalog and session in one
    // schema instead of three spellings of it (critic SHOULD 5 at f0a248af1)
    this.schema = String(input.schema ?? process.env.HANA_SCHEMA ?? "OSD").toUpperCase();
    this.droppedSchema = false;
    /** did *this* connection make the schema fresh? see `freshened` */
    this.droppedSchema = false;
    this.options = input;
    this.client = undefined;
    this.connected = false;
    this.inTransaction = false;
    // HANA_EXISTING_SCHEMA=1: the schema is an SAP system's, already there,
    // with its data. The mode only skips -- no DROP SCHEMA, no CREATE, no
    // seed (test/setup.mjs returns straight after connect) -- and it is
    // read-only unless OSD_HANA_WRITE=1 says otherwise
    // (docs/db-backends.md, "Existing schema, read-only").
    this.existingSchema = input.existingSchema ?? process.env.HANA_EXISTING_SCHEMA === "1";
    this.readOnly = input.readOnly ?? (this.existingSchema && process.env.OSD_HANA_WRITE !== "1");
    // H3: the logon client (OSD_CLIENT) and our own schema (HANA_OWN_SCHEMA).
    // In existing-schema mode connect() refuses to start without a client:
    // each shadow view filters its table's DD03L client column on
    // SESSION_CONTEXT('CLIENT'); a NULL client reads every one as empty.
    this.logonClient = input.client ?? process.env.OSD_CLIENT ?? "";
    this.ownSchema = String(input.ownSchema ?? process.env.HANA_OWN_SCHEMA ?? "").toUpperCase();
    this.shadowTables = input.shadowTables ?? [];
    // Seeded from generated DDIC on every process start, then augmented from
    // DDL. Open SQL writes RAW values as quoted hex; HANA needs X'...'. A
    // persisted schema executes no CREATE TABLE after restart, so DDL alone
    // cannot be the source of this runtime type fact.
    this.binaryColumns = new Set();
    for (const [table, columns] of Object.entries(input.ddicBinary ?? {})) {
      for (const column of Object.keys(columns ?? {})) {
        this.binaryColumns.add(`${table.toUpperCase()}.${column.toUpperCase()}`);
      }
    }
  }

  /** inside ensureShadowFor right now. Its DD02L / SYS.VIEWS / SYS.SYNONYMS
   *  reads go through query() -- the same 259-retrying path -- so a 259 on
   *  one of them must not re-enter the fallback (critic MUST 1 at f0a248af1;
   *  the probe counted 199 DD02L reads before the flag). */
  #inShadowFor = false;

  /** One statement, and **the statement is in the failure**.
   *
   *  Without this, HANA's own message is all you get: `sql syntax error:
   *  incorrect syntax near ",": line 2 col 88 (at pos 223)`. It names a
   *  position in a statement it does not show you, and finding the statement
   *  then needs a trace -- which in a container needs `STG_DB_TRACE=1` to
   *  reach a child process, and `STG_SERVE=inline` to put it in one. Both
   *  failed on 2026-09-19 and the seed defect stayed undiagnosed for it.
   *
   *  A position without its text is a measurement of nothing, so the text
   *  travels with the error: the first 400 characters, plus the line and
   *  column HANA named, marked. Truncated because a batched INSERT can be
   *  hundreds of kilobytes and the useful part is where it broke. */
  #run(sql) {
    this.#sent(sql);
    return new Promise((resolve, reject) =>
      this.client.exec(sql, (err, result) => (err ? reject(this.#explain(err, sql)) : resolve(result))));
  }

  /** every text handed to the driver, to the `sqlTrace` option (STG_SQL_TRACE,
   *  tools/hana-serve.mjs); a tracer must never break what it traces */
  #sent(sql) { try { this.options.sqlTrace?.(sql); } catch { /* ignored */ } }

  #explain(err, sql) {
    if (err === undefined || err === null) return err;
    const at = /line (\d+) col (\d+)/i.exec(String(err.message ?? ""));
    let where = "";
    if (at !== null) {
      const line = sql.split("\n")[Number(at[1]) - 1];
      if (line !== undefined) {
        const col = Number(at[2]);
        where = `\n  line ${at[1]}: ${line.slice(Math.max(0, col - 60), col + 60)}` +
          `\n  ${" ".repeat(Math.min(col, 60) + 10)}^ col ${col}`;
      }
    }
    err.message = `${err.message}\n  statement: ${sql.length > 400 ? sql.slice(0, 400) + ` … (${sql.length} chars)` : sql}${where}`;
    return err;
  }

  /** The one door every statement the eleven DatabaseClient methods send
   *  passes through (and the native channel beside them, which is refused
   *  the same way: a lowered SQLScript write is a write). In the
   *  existing-schema mode, read-only unless `OSD_HANA_WRITE=1`, everything
   *  that is not a SELECT is refused here, before it reaches the driver:
   *
   *  - `SET` is allowed: it is connect()'s own session statement, and
   *    pointing the session at the configured schema is not a write.
   *  - `COMMIT` and `ROLLBACK` are allowed -- decided and written down in
   *    docs/db-backends.md. They are the LUW bracket the runtime calls
   *    unconditionally (disconnect() commits), and under this guard no
   *    refused statement can open a transaction -- the guard runs before
   *    beginTransaction() -- so they degenerate to the no-op the early
   *    return in commit()/rollback() already is.
   *  - everything else -- INSERT, UPDATE, DELETE, MERGE, UPSERT, CREATE,
   *    DROP, ALTER, TRUNCATE, CALL, and any word not on the allowed list --
   *    is refused with code `HANA_READONLY` and the kind in the message.
   *    The statement text never travels with it: it may carry data.
   *  - and a text carrying a top-level `;` is refused as kind "multi"
   *    before the kind of its first word is even read: a kind is the first
   *    word of the FIRST statement, and that word says nothing about the
   *    second one (`SELECT 1; DROP TABLE "T"` measured walking past as a
   *    SELECT -- the critic round's smuggle probe, exec and prepare).
   *
   *  Without the mode this is a pass-through: STG_DB=hana's own path has to
   *  keep issuing CREATE TABLE and the seed. */
  #guard(sql) {
    if (this.readOnly !== true) return;
    const kind = isMultiStatement(sql) ? "multi" : statementKind(sql);
    if (kind === "SELECT" || kind === "SET" || kind === "COMMIT" || kind === "ROLLBACK") return;
    // H3: shadow-schema DDL is our own schema's business and is allowed
    // there -- and only there. tools/hana-shadow-schema.mjs owns the four
    // shapes; the check is the owning schema read off the statement, never a
    // parse of it, and the tenant schema never matches.
    if ((kind === "CREATE" || kind === "DROP") && this.ownSchema !== "") {
      const target = shadowDdlSchema(sql);
      if (target !== undefined && target === this.ownSchema) return; // upper by construction
    }
    const error = new Error(`HANA_READONLY: ${kind === "" ? "statement" : kind} refused in read-only mode (HANA_EXISTING_SCHEMA=1 without OSD_HANA_WRITE=1); the statement was not sent to the database`);
    error.code = "HANA_READONLY";
    throw error;
  }

  async connect() {
    // Refused before a socket is even opened: STG_DB_FRESH=1 means "start
    // from nothing", which is exactly what this mode must never mean against
    // a schema somebody else owns.
    if (this.existingSchema === true && process.env.STG_DB_FRESH === "1") {
      throw new Error(`HANA_EXISTING_SCHEMA=1 and STG_DB_FRESH=1 refuse each other: the mode runs over a schema an SAP system already holds, and fresh means DROP SCHEMA over it. Drop the STG_DB_FRESH, or point HANA_SCHEMA at a schema of your own.`);
    }
    // Refused before a socket is even opened, the way fresh-and-existing is:
    // without a logon client the shadow views filter on a NULL
    // SESSION_CONTEXT('CLIENT') and every client-dependent table reads empty
    // -- a silently wrong run is worse than no run.
    if (this.existingSchema === true && this.logonClient === "") {
      throw new Error(`HANA_EXISTING_SCHEMA=1 refuses to start without OSD_CLIENT: the mode isolates the logon client in HANA (docs/db-backends.md, "Shadow schema: the client lives in HANA"), and a session without a client sees every client-dependent table empty. Set OSD_CLIENT to the logon client.`);
    }
    // Refused before a socket is even opened, like the two above: our own
    // schema spelled as the tenant's would create the shadow views over the
    // tenant's own tables -- and the guard, reading the owning schema off the
    // statement, would admit them (critic MUST 2 at f0a248af1). Both names
    // are upper at construction, so this is the case-folded compare.
    if (this.existingSchema === true && this.ownSchema !== "" && this.ownSchema === this.schema) {
      throw new Error(`HANA_OWN_SCHEMA refuses to equal HANA_SCHEMA ("${this.schema}"): the shadow views would sit on the tenant's own tables, and the read-only guard would admit DDL on them. Point HANA_OWN_SCHEMA at a schema of our own.`);
    }
    const hdb = require("hdb");
    this.client = hdb.createClient(hanaConnection(this.options));
    await new Promise((resolve, reject) => this.client.connect((err) => (err ? reject(err) : resolve())));
    // COMMIT and ROLLBACK are meaningless while the session autocommits, and
    // the LUW of docs/db-backends.md depends on them meaning something
    this.client.setAutoCommit(false);
    // The mode only skips: the schema and its tables are already there, so
    // neither the drop of STG_DB_FRESH nor the CREATE SCHEMA happens, and
    // the seed that test/setup.mjs would run is skipped with it. H1: without
    // HANA_OWN_SCHEMA the session sits in the tenant's schema, as it always
    // did. H3: with it, the session sits in our own schema behind the shadow
    // objects, created idempotently first -- a second connect finds them in
    // the catalog and sends nothing.
    if (this.existingSchema === true) {
      if (this.ownSchema !== "") {
        await ensureShadow(this, {own: this.ownSchema, tenant: this.schema, tables: this.shadowTables});
        this.#guard(`SET SCHEMA "${this.ownSchema}"`);
        await this.#run(`SET SCHEMA "${this.ownSchema}"`);
      } else {
        this.#guard(`SET SCHEMA "${this.schema}"`);
        await this.#run(`SET SCHEMA "${this.schema}"`);
      }
      globalThis.abap?.builtin?.sy?.get()?.dbsys?.set(this.name);
      // sy-mandt is set at boot from OSD_CLIENT by tools/osd-identity.mjs
      // (bootIdentity); saying it again here keeps a directly-constructed
      // client as honest as the dbsys line above.
      if (this.logonClient !== "") {
        globalThis.abap?.builtin?.sy?.get()?.mandt?.set(this.logonClient);
      }
      this.connected = true;
      return;
    }
    // STG_DB_FRESH=1 means start from nothing; without it a second run meets
    // the tables the first one left and dies on "duplicate table name"
    if (process.env.STG_DB_FRESH === "1" && freshened.has(this.schema) === false) {
      // Marked **before** the await, not after: two connects racing here
      // would both see "not yet dropped" and both issue the DROP.
      freshened.add(this.schema);
      this.droppedSchema = true;
      // and the caller needs to know which connection did it: the one that
      // dropped is the one that has to seed, and every other one must not
      this.droppedSchema = true;
      await this.#run(`DROP SCHEMA "${this.schema}" CASCADE`).catch(() => undefined);
      await new Promise((resolve, reject) => this.client.commit((e) => (e ? reject(e) : resolve())));
    }
    await this.#run(`CREATE SCHEMA "${this.schema}"`).catch(() => undefined);
    this.#guard(`SET SCHEMA "${this.schema}"`);
    await this.#run(`SET SCHEMA "${this.schema}"`);
    globalThis.abap?.builtin?.sy?.get()?.dbsys?.set(this.name);
    this.connected = true;
  }

  async disconnect() {
    await this.commit();
    this.client?.end();
    this.client = undefined;
    this.connected = false;
  }

  /** a persisted schema already carries the tables. The name is upper case
   *  because that is how hanaSchema creates it; asking for 'zstg_demo' finds
   *  nothing and the setup then tries to create everything a second time. */
  async hasSchema() {
    const rows = await this.query(
      `SELECT COUNT(*) AS N FROM SYS.TABLES WHERE SCHEMA_NAME = '${this.schema}' AND TABLE_NAME = 'ZSTG_DEMO'`);
    // query() folds the keys of a row to lower case, which is the rule the
    // runtime needs -- so the alias comes back as `n`, not `N`. Reading it as
    // `N` made this answer false against a schema that was plainly there, and
    // the setup then tried to create every table a second time.
    return Number(rows[0]?.n ?? 0) > 0;
  }

  async missingTables(expected) {
    const rows = await this.query(
      `SELECT TABLE_NAME FROM SYS.TABLES WHERE SCHEMA_NAME = '${this.schema}'`);
    const found = new Set(rows.map((row) => String(row.table_name).toUpperCase()));
    return expected.filter((name) => found.has(String(name).toUpperCase()) === false);
  }

  async execute(sql) {
    if (Array.isArray(sql)) {
      for (const s of sql) await this.execute(s);
      return;
    }
    if (sql === "") return;
    // the guard runs before beginTransaction(): a refused statement must
    // leave no transaction open behind it
    this.#guard(sql);
    // A statement opens the LUW here exactly as a modifying one does. Without
    // this the flag stayed false, `commit()` returned early -- it begins with
    // `if (this.inTransaction === false) return` -- and with autocommit off
    // the whole seed lived inside the session that wrote it. Invisible with
    // one connection, because a session sees its own uncommitted rows; a
    // second connection reads an empty schema and the suite fails on the
    // seeded rows it cannot see (measured 2026-09-19).
    await this.beginTransaction();
    const identified = foldIdentifiers(sql);
    this.#rememberBinaryColumns(identified);
    const folded = multiRowInsert(binaryLiterals(identified, this.binaryColumns));
    if (this.trace) console.log(folded);
    await this.#run(folded);
  }

  async beginTransaction() {
    // hdb opens one implicitly on the first statement once autocommit is off;
    // the flag is what commit() and rollback() read
    this.inTransaction = true;
  }

  async commit() {
    if (this.inTransaction === false) return;
    await new Promise((resolve, reject) => this.client.commit((err) => (err ? reject(err) : resolve())));
    this.inTransaction = false;
  }

  async rollback() {
    if (this.inTransaction === false) return;
    await new Promise((resolve, reject) => this.client.rollback((err) => (err ? reject(err) : resolve())));
    this.inTransaction = false;
  }

  /** one modifying statement; the count of rows it touched */
  async #modifying(sql) {
    this.#guard(sql);
    await this.beginTransaction();
    const folded = binaryLiterals(foldIdentifiers(sql), this.binaryColumns);
    if (this.trace) console.log(folded);
    const affected = await this.#run(folded);
    return typeof affected === "number" ? affected : Number(affected ?? 0);
  }

  async insert(options) {
    const sql = trimLiterals(
      `INSERT INTO ${options.table} (${options.columns.join(",")}) VALUES (${options.values.join(",")})`);
    try {
      const dbcnt = await this.#modifying(sql);
      return {subrc: 0, dbcnt};
    } catch (e) {
      // a refusal is not a row-count answer: subrc 4 says "no such row" to
      // an ABAP caller, and hiding the guard behind it would make a
      // read-only run look like one whose rows never matched
      if (e?.code === "HANA_READONLY") throw e;
      if (this.trace) console.error(e);
      return {subrc: 4, dbcnt: 0};
    }
  }

  #rememberBinaryColumns(sql) {
    const table = /^\s*CREATE\s+TABLE\s+"?([A-Za-z_][A-Za-z_0-9]*)"?/i.exec(sql)?.[1]?.toUpperCase();
    if (table === undefined) return;
    for (const match of sql.matchAll(/"([A-Za-z_][A-Za-z_0-9]*)"\s+(?:VARBINARY|BLOB)\b/gi)) {
      this.binaryColumns.add(`${table}.${match[1].toUpperCase()}`);
    }
  }

  async update(options) {
    const sql = trimLiterals(`UPDATE ${options.table} SET ${options.set.join(", ")} WHERE ${options.where}`);
    try {
      const dbcnt = await this.#modifying(sql);
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch (e) {
      if (e?.code === "HANA_READONLY") throw e;
      if (this.trace) console.error(e);
      return {subrc: 4, dbcnt: 0};
    }
  }

  async delete(options) {
    let sql = `DELETE FROM ${options.table}`;
    if (options.where !== "") sql += ` WHERE ${options.where}`;
    try {
      const dbcnt = await this.#modifying(trimLiterals(sql));
      return {subrc: dbcnt === 0 ? 4 : 0, dbcnt};
    } catch (e) {
      if (e?.code === "HANA_READONLY") throw e;
      if (this.trace) console.error(e);
      return {subrc: 4, dbcnt: 0};
    }
  }

  /** ABAP SQL as the runtime emits it, into what HANA takes */
  rewrite(select, primaryKey) {
    // on the code only: a value is sent as it was written (osd-sql-literals)
    return trimLiterals(abapSelectToSql(select, {primaryKey}));
  }

  async query(sql) {
    return this.#queryWithShadow(sql, false);
  }

  /** the lazy half of the shadow schema: a statement that fails with HANA's
   *  error 259 (invalid table name) carries the table in the error; when the
   *  tenant's DD02L holds that name, the shadow object is made and the
   *  caller retries. False means the error is somebody else's problem. */
  async #shadowFor(error) {
    if (this.existingSchema !== true || this.ownSchema === "" || this.connected !== true) return false;
    if (this.#inShadowFor === true) return false; // never re-enter the fallback
    const name = tableFrom259(error);
    if (name === undefined) return false;
    this.#inShadowFor = true;
    try {
      return await ensureShadowFor(this, {own: this.ownSchema, tenant: this.schema, name});
    } catch (fallbackError) {
      if (fallbackError?.code === "HANA_NO_CLIENT_COLUMN") throw fallbackError; // ours, no CLNT key: refused by name
      // otherwise the fallback's own DD* / SYS read failed: the statement keeps
      // its 259. The flag above stopped the recursion (probe at f0a248af1: 199
      // DD02L reads); this is logged, not swallowed silent.
      if (this.trace) console.error(`shadow fallback for ${name} failed: ${fallbackError?.message ?? fallbackError}`);
      return false;
    } finally {
      this.#inShadowFor = false;
    }
  }

  async #queryWithShadow(sql, retried) {
    this.#guard(sql);
    const folded = foldIdentifiers(sql);
    if (this.trace) console.log(folded);
    let stmt;
    try {
      let rows;
      let metadata = [];
      if (typeof this.client.prepare === "function") {
        this.#sent(folded);
        stmt = await new Promise((resolve, reject) =>
          this.client.prepare(folded, (err, prepared) =>
            (err ? reject(this.#explain(err, folded)) : resolve(prepared))));
        rows = await new Promise((resolve, reject) =>
          stmt.exec([], (err, result) =>
            (err ? reject(this.#explain(err, folded)) : resolve(result))));
        metadata = stmt.resultSetMetadata ?? [];
      } else {
        // Small test doubles written before metadata-aware LOB handling.
        rows = await this.#run(folded);
      }
      const types = new Map(metadata.map((column) => [
        String(column.columnDisplayName ?? column.columnName).toUpperCase(), column.dataType,
      ]));
      // The names come back the way HANA holds them, which is upper case,
      // and the runtime looks a column up by the lower-case name it asked
      // for -- `rowsToTarget` reads row[field] and calls set() on what it
      // finds, so an upper-case key gives it undefined and it dies inside
      // Character.set with "Cannot read properties of undefined". Folding up
      // on the way out and down on the way back is one rule, applied twice.
      return (rows ?? []).map((r) => {
        const row = {};
        for (const k of Object.keys(r)) row[k.toLowerCase()] = plain(r[k], types.get(k.toUpperCase()));
        return row;
      });
    } catch (error) {
      if (retried === false && await this.#shadowFor(error) === true) {
        return this.#queryWithShadow(sql, true); // once, and only once
      }
      throw await osqlSemanticsError(error);
    } finally {
      // A prepared SELECT owns a server-side statement even after its rows
      // have been collected. Do not leak one per Open SQL read.
      stmt?.drop?.(() => undefined);
    }
  }

  async checkSelect(sql) {
    this.#guard(sql);
    const checked = foldIdentifiers(this.rewrite(sql));
    this.#sent(checked);
    const prepared = await new Promise((resolve, reject) =>
      this.client.prepare(checked, (err, stmt) => err ? reject(err) : resolve(stmt)));
    await new Promise((resolve, reject) =>
      prepared.drop((err) => err ? reject(err) : resolve()));
  }

  async select(options) {
    options.select = this.rewrite(options.select, options.primaryKey);
    return {rows: await this.query(options.select)};
  }

  // ---------------------------------------------------------------------
  // The native channel (docs/db-seam-native.md). Four methods beside the
  // eleven, for one caller only: the SQLScript splitter's lowering.
  //
  // **Nothing transpiled from ABAP may reach these.** Open SQL goes through
  // select()/insert()/update()/delete(), which rewrite and fold and trim; a
  // statement arriving here is sent to the engine untouched, which is the
  // whole point and also the reason it must never carry ABAP SQL.
  // ---------------------------------------------------------------------

  /** this client can carry a lowered plan */
  get supportsNative() {
    return true;
  }

  /** ABAP's type letters into what hdb wants to bind. The caller knows the
   *  ABAP type and nothing about HANA; the mapping belongs here. */
  #bind(params = []) {
    return params.map((p) => {
      if (p.isNull === true) return null;
      return bindValue(p, {hex: (s) => Buffer.from(s, "hex")});
    });
  }

  /** One lowered statement, sent as written, with its values bound. */
  async native({sql, params = [], expect = "rows"}) {
    this.#guard(sql);
    if (this.trace) console.log("native:", sql, params.length ? JSON.stringify(params) : "");
    this.#sent(sql);
    const stmt = await new Promise((resolve, reject) =>
      this.client.prepare(sql, (err, s) => (err ? reject(err) : resolve(s))));
    try {
      if (expect === "none") {
        const affected = await new Promise((resolve, reject) =>
          stmt.exec(this.#bind(params), (err, r) => (err ? reject(err) : resolve(r))));
        return {rowCount: typeof affected === "number" ? affected : undefined};
      }
      const rows = await new Promise((resolve, reject) =>
        stmt.exec(this.#bind(params), (err, r) => (err ? reject(err) : resolve(r))));
      // the engine's declared column types, not a guess from the value:
      // blank padding, decimals and dates are exactly where guessing hurts
      const columns = (stmt.resultSetMetadata ?? []).map((c) => ({
        name: c.columnDisplayName ?? c.columnName,
        type: c.dataType,
      }));
      const plainRows = (rows ?? []).map((r) => {
        const row = {};
        const types = new Map((stmt.resultSetMetadata ?? []).map((column) => [
          String(column.columnDisplayName ?? column.columnName).toUpperCase(), column.dataType,
        ]));
        for (const k of Object.keys(r)) row[k] = plain(r[k], types.get(k.toUpperCase()));
        return row;
      });
      if (expect === "scalar") {
        const first = plainRows[0];
        return {value: first === undefined ? undefined : first[Object.keys(first)[0]], columns};
      }
      return {rows: plainRows, columns, rowCount: plainRows.length};
    } finally {
      stmt.drop?.(() => undefined);
    }
  }

  /** A named relation later statements may refer to. The name is **ours**:
   *  the caller may not invent one, because quoting and escaping are the
   *  engine's business and this is the only place that knows them. */
  /** what a statement will produce, without running it: HANA works the types
   *  out at prepare time, parameters and all */
  #resultMetadata(sql) {
    this.#sent(sql);
    return new Promise((resolve, reject) =>
      this.client.prepare(sql, (err, stmt) => {
        if (err) return reject(err);
        const metadata = stmt.resultSetMetadata;
        stmt.drop?.(() => undefined);
        if (metadata === undefined || metadata.length === 0) {
          return reject(new Error("defineRelation: that statement produces no columns to materialise"));
        }
        resolve(metadata);
      }));
  }

  async defineRelation({name = "rel", sql, params = [], materialise}) {
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
    const handle = {
      ident,
      ref: `"${this.schema}"."${ident}"`,
      kind: materialise === undefined ? "definition" : "materialised",
      reason: materialise,
    };
    if (materialise === undefined) {
      // a view is HANA's cheapest definition, and it keeps the relation
      // inside the engine rather than becoming rows on the way through us
      this.#guard(`CREATE VIEW ${handle.ref} AS ${sql}`);
      await this.#run(`CREATE VIEW ${handle.ref} AS ${sql}`);
    } else {
      // A materialised relation is a **column table**, not a local temporary
      // one: HANA insists a local temporary name begins with '#', which is
      // not a name a schema-qualified reference can carry, and the splitter
      // needs a reference it can splice anywhere. The client drops it.
      handle.ref = `"${this.schema}"."${ident}"`;
      if (params.length === 0) {
        this.#guard(`CREATE COLUMN TABLE ${handle.ref}`);
        await this.#run(`CREATE COLUMN TABLE ${handle.ref} AS (${sql}) WITH DATA`);
      } else {
        // HANA takes no parameter in a DDL statement -- measured, it answers
        // `param is not allowed in DDL statement` -- so the one statement the
        // other two engines manage becomes two here: the table, and then a
        // bound INSERT, which is DML and may carry values.
        //
        // **The table's columns come from HANA's own inference on the real
        // statement**, read off a prepare. The first version of this built a
        // shape query instead, with every placeholder standing in as a typed
        // NULL taken from the parameter's declared type -- and fable-osd
        // named the hazard before it was shipped: the column would then be
        // typed by the STAND-IN while the rows arrive from the VALUE, and an
        // expression around the parameter can widen the type between them.
        // Measured, and worse than expected, because it is silent: with an
        // INTEGER stand-in, `? + 1` over 1.5 stored 2 where the fused run
        // answers 2.5. The forced half would have carried a divergence the
        // instrument invented. Asking the engine to type the real statement
        // removes the guess rather than improving it.
        const metadata = await this.#resultMetadata(sql);
        this.#guard(`CREATE COLUMN TABLE ${handle.ref}`);
        await this.#run(`CREATE COLUMN TABLE ${handle.ref} (${columnsFromMetadata(metadata).join(", ")})`);
        await this.native({sql: `INSERT INTO ${handle.ref} (${sql})`, params, expect: "none"});
      }
    }
    return handle;
  }

  /** what to splice into a statement: quoted and escaped for this engine */
  relationRef(handle) {
    return handle.ref;
  }

  /** what the client actually did, and why -- materialising is not a
   *  performance hint here, it changes whether an exception happens
   *  (docs/sqlscript-hana-observed.md) */
  relationKind(handle) {
    return {kind: handle.kind, reason: handle.reason};
  }

  async dropRelation(handle) {
    const what = handle.kind === "definition" ? "VIEW" : "TABLE";
    this.#guard(`DROP ${what} ${handle.ref}`);
    await this.#run(`DROP ${what} ${handle.ref}`).catch(() => undefined);
  }

  /** the seam allows a cursor to be served by reading everything and slicing,
   *  which is what the DuckDB client does and what this does */
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

/** HANA takes the PostgreSQL DDL the transpiler writes, with every identifier
 *  quoted in UPPER case.
 *
 *  Three shapes were tried and only the third works, measured rather than
 *  reasoned about:
 *
 *  - **as written**, quoted lower case: HANA accepts all 77 CREATE TABLE, and
 *    then nothing can be read. The SQL the runtime emits names tables and
 *    columns unquoted, HANA folds an unquoted name to upper case, and
 *    ITEM_ID is not "item_id". Error: `invalid column name:
 *    zosd_test_item.ITEM_ID`.
 *  - **unquoted**: both sides fold alike and it very nearly works -- until a
 *    column is called `cross`, which is one of HANA's reserved words. Error:
 *    `incorrect syntax near "cross"`. `SYS.RESERVED_KEYWORDS` also holds END,
 *    GROUP, ORDER and START, all plausible ABAP field names.
 *  - **quoted upper case**: an unquoted reference folds to upper and finds
 *    it, and a reserved word is safe behind its quotes. This one.
 */
export function hanaSchema(schemas, ddic = {}) {
  const binary = new Map();
  for (const [table, definition] of Object.entries(ddic ?? {})) {
    if (definition !== null && typeof definition === "object" && definition.objectType === undefined) {
      for (const [column, hanaType] of Object.entries(definition)) {
        binary.set(`${table.toUpperCase()}.${column.toUpperCase()}`, String(hanaType));
      }
      continue;
    }
    if (definition?.objectType !== "TABL" || typeof definition.type !== "function") continue;
    let fields;
    try { fields = definition.type().get(); } catch { continue; }
    for (const [column, value] of Object.entries(fields ?? {})) {
      if (value?.constructor?.name === "Hex") {
        binary.set(`${table.toUpperCase()}.${column.toUpperCase()}`, `VARBINARY(${value.getLength()})`);
      } else if (value?.constructor?.name === "XString") {
        binary.set(`${table.toUpperCase()}.${column.toUpperCase()}`, "BLOB");
      }
    }
  }
  return schemas.pg.map((source) => {
    let sql = source.replace(/"([A-Za-z_][A-Za-z_0-9]*)"/g, (m, id) => '"' + id.toUpperCase() + '"');
    const table = /^\s*CREATE\s+TABLE\s+"([A-Z_][A-Z_0-9]*)"/i.exec(sql)?.[1]?.toUpperCase();
    if (table === undefined) return sql;
    for (const [key, hanaType] of binary) {
      const [owner, column] = key.split(".");
      if (owner !== table) continue;
      sql = sql.replace(new RegExp(`("${column}"\\s+)(?:N?CHAR\\(\\d+\\)|TEXT)`, "i"), `$1${hanaType}`);
    }
    return sql;
  });
}

function splitSqlList(source) {
  const out = [];
  let start = 0;
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quoted) {
      if (ch === "'") {
        if (source[i + 1] === "'") i++;
        else quoted = false;
      }
    } else if (ch === "'") quoted = true;
    else if (ch === "(") depth++;
    else if (ch === ")") depth--;
    else if (ch === "," && depth === 0) {
      out.push(source.slice(start, i));
      start = i + 1;
    }
  }
  out.push(source.slice(start));
  return out;
}

const identifier = (value) => value.trim().replace(/^"|"$/g, "").toUpperCase();
const asBinary = (value) => {
  const match = /^\s*'([0-9A-Fa-f]*)'\s*$/.exec(value);
  return match === null ? value : `X'${match[1].toUpperCase()}'`;
};

/** Convert only literals assigned to known VARBINARY/BLOB columns. A text
 * value made solely of hex digits must remain text. */
export function binaryLiterals(sql, columns) {
  if (!(columns instanceof Set) || columns.size === 0) return sql;
  const insert = /^\s*INSERT\s+INTO\s+("?[A-Za-z_][A-Za-z_0-9]*"?)\s*\(([^)]*)\)\s*VALUES\s*/i.exec(sql);
  if (insert !== null) {
    const table = identifier(insert[1]);
    const names = splitSqlList(insert[2]).map(identifier);
    const tail = sql.slice(insert[0].length);
    let out = "";
    let i = 0;
    while (i < tail.length) {
      if (tail[i] !== "(") { out += tail[i++]; continue; }
      let quoted = false;
      let depth = 1;
      let j = i + 1;
      for (; j < tail.length && depth > 0; j++) {
        const ch = tail[j];
        if (quoted) {
          if (ch === "'") {
            if (tail[j + 1] === "'") j++;
            else quoted = false;
          }
        } else if (ch === "'") quoted = true;
        else if (ch === "(") depth++;
        else if (ch === ")") depth--;
      }
      if (depth !== 0) return sql;
      const values = splitSqlList(tail.slice(i + 1, j - 1));
      const converted = values.map((value, index) =>
        columns.has(`${table}.${names[index]}`) ? asBinary(value) : value);
      out += `(${converted.join(",")})`;
      i = j;
    }
    return sql.slice(0, insert[0].length) + out;
  }

  const update = /^\s*UPDATE\s+("?[A-Za-z_][A-Za-z_0-9]*"?)\s+SET\s+(.+?)(\s+WHERE\s+.+)$/is.exec(sql);
  if (update !== null) {
    const table = identifier(update[1]);
    const assignments = splitSqlList(update[2]).map((assignment) => {
      const match = /^\s*("?[A-Za-z_][A-Za-z_0-9]*"?)\s*=\s*(.*)$/s.exec(assignment);
      if (match === null || !columns.has(`${table}.${identifier(match[1])}`)) return assignment;
      return assignment.slice(0, assignment.indexOf("=") + 1) + asBinary(match[2]);
    });
    return `UPDATE ${update[1]} SET ${assignments.join(",")}${update[3]}`;
  }
  return sql;
}

/** The seed INSERTs reach us in two shapes and both need the same treatment
 *  the schema got: identifiers quoted in UPPER case.
 *
 *  Some name their columns in single quotes, which HANA reads as string
 *  literals rather than identifiers -- the shape DuckDB also has to fix. The
 *  rest arrive already double-quoted and in **lower** case, which is the
 *  shape that produced `invalid column name: pgmid` against a table whose
 *  column is "PGMID". Both are folded here; a value is in single quotes and
 *  is never touched, because only an identifier is in double quotes. */
export function hanaInserts(inserts) {
  return inserts.map((s) => {
    const withColumns = s.replace(/^(INSERT INTO \S+ \()([^)]*)\)/i, (m, head, cols) =>
      (/'/.test(cols) ? head + cols.replace(/'([A-Za-z_0-9]+)'/g, (mm, c) => '"' + c.toUpperCase() + '"') + ")" : m));
    return foldIdentifiers(withColumns)
      .replace(/^INSERT INTO ([A-Za-z_][A-Za-z_0-9]*) /i, (m, t) => `INSERT INTO "${t.toUpperCase()}" `);
  });
}

/** HANA's wire type codes, as a name a `CREATE TABLE` will accept.
 *
 *  These are the protocol's own numbers and they do not move; hdb carries the
 *  same table internally, but reaching into a dependency's `lib/` for it would
 *  make this break on one of its releases for no gain. Anything not here is
 *  refused by name rather than guessed at -- a column created with the wrong
 *  type is the silent-wrong-answer shape this whole file exists to avoid. */
const TYPE_CODES = {
  1: "TINYINT", 2: "SMALLINT", 3: "INTEGER", 4: "BIGINT", 5: "DECIMAL",
  6: "REAL", 7: "DOUBLE", 8: "CHAR", 9: "VARCHAR", 10: "NCHAR", 11: "NVARCHAR",
  12: "BINARY", 13: "VARBINARY", 14: "DATE", 15: "TIME", 16: "TIMESTAMP",
  25: "CLOB", 26: "NCLOB", 27: "BLOB", 28: "BOOLEAN", 29: "STRING",
  30: "NSTRING", 47: "SMALLDECIMAL", 62: "SECONDDATE", 63: "DAYDATE",
  64: "SECONDTIME",
};

/** one column of a prepared statement's result, as DDL spells it */
export function hanaColumnType({dataType, length, fraction}) {
  const name = TYPE_CODES[dataType];
  if (name === undefined) throw new Error(`hanaColumnType: no name for HANA type code ${dataType}`);
  if (name === "DECIMAL" || name === "SMALLDECIMAL") return `DECIMAL(${length ?? 15},${fraction ?? 0})`;
  if (["CHAR", "VARCHAR", "NCHAR", "NVARCHAR", "BINARY", "VARBINARY"].includes(name)) {
    return `${name}(${length ?? 5000})`;
  }
  // STRING and NSTRING are how the protocol names an unbounded character
  // column; a table wants a bounded one
  if (name === "STRING") return "VARCHAR(5000)";
  if (name === "NSTRING") return "NVARCHAR(5000)";
  return name;
}

/** the columns a statement will produce, as HANA itself works them out */
export function columnsFromMetadata(metadata) {
  return (metadata ?? []).map((c, i) => {
    const name = c.columnDisplayName ?? c.columnName ?? `C${i + 1}`;
    return `"${String(name).replace(/"/g, '""')}" ${hanaColumnType(c)}`;
  });
}
