// The AMDP destination: `CALL FUNCTION ... DESTINATION 'AMDP'` reaches HANA.
//
// tools/amdp-gen.mjs rewrites every AMDP body into such a call, and the
// runtime hands a routed call to abap.context.RFCDestinations[name].call(fm,
// signature) -- the same contract tools/rfc-replay.mjs implements for
// captured RFC. So this is a client of a dozen lines around the deploy and
// call that tools/amdp-run.mjs already does, not a new mechanism.
//
// Values come back through fromJson() of rfc-replay, which walks the
// runtime's typed values and ends at target.set(), so the ABAP type does its
// own converting -- CHAR gets its padding back, which matters because HANA's
// NVARCHAR has none.
import {readFileSync, existsSync, writeFileSync, mkdirSync} from "node:fs";
import {randomBytes, createHash} from "node:crypto";
import {hostname} from "node:os";
import {join, dirname} from "node:path";
import {fromJson} from "./rfc-replay.mjs";
import {childBodies} from "./sqlscript-blocks.mjs";
// **Not a static import.** The preview bundle ignores `amdp-run.mjs` on
// purpose (it pulls in `hdb` and `fileURLToPath`), and webpack turns a static
// import of an ignored module into a `webpackMissingModule` that throws the
// moment the binding is touched -- before any guard below can run. So the
// browser got `Error: Cannot find module './amdp-run.mjs'` as a 500 page,
// while the comment beside the IgnorePlugin said "the destination itself says
// so when it is called". It did not: an intention written next to the code
// that was supposed to carry it, and not carried.
//
// Loaded where it is used instead, so that "there is no driver here" is an
// answer rather than a crash.
async function hanaSettings() {
  try {
    const {connection} = await import("./amdp-run.mjs");
    return typeof connection === "function" ? connection() : undefined;
  } catch {
    return undefined;
  }
}

const SCHEMA = process.env.HANA_SCHEMA ?? process.env.HXE_SCHEMA ?? "OSD";

function lostConnection(error) {
  return ["EHDBCLOSE", "EHDBCONNECT", "EHDBOPENCONN", "EHDBTIMEOUT", "EHDBINIT",
    "ECONNRESET", "ECONNABORTED", "EPIPE"].includes(error?.code) ||
    /connection closed|socket hang up|connection reset|broken pipe/i.test(String(error?.message ?? ""));
}

function safeError(error, settings = {}) {
  let message = String(error?.AMDP_REASON ?? error?.message ?? error);
  // Driver errors may echo a URL, a DSN, or a connection string. Remove the
  // credential fields of those (a SQL diagnostic's `x=1` stays readable),
  // then the known credentials wherever they occur elsewhere.
  message = message.replace(/(\b(?:password|passwd|pwd|user|uid|userid|username|secret|token)\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;&]+)/gi, "$1[redacted]");
  message = message.replace(/(\/\/)[^/\s:@]+:[^/\s@]+@/g, "$1[redacted]@");
  for (const secret of [settings.password, settings.user, ...(settings.secrets ?? [])].filter(Boolean)) {
    for (const spelling of [String(secret), encodeURIComponent(String(secret)), encodeURI(String(secret))]) {
      if (spelling) message = message.replace(new RegExp(spelling.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[redacted]");
    }
  }
  return `AMDP: HANA ${settings.host ?? "destination"}:${settings.port ?? ""}, schema ${SCHEMA} failed: ${message.slice(0, 200)}`;
}

export const amdpSessionSchema = (schema = SCHEMA) => [
  `CREATE SCHEMA "${schema}"`,
  `SET SCHEMA "${schema}"`,
];


/**
 * Fail in a way the calling ABAP can catch.
 *
 * `CALL FUNCTION ... DESTINATION 'AMDP'` is ABAP, and the ABAP around it
 * guards itself with `CATCH cx_root`. A JavaScript `Error` thrown from here
 * goes straight past that CATCH and out of the request, so a page that asks
 * an honest question -- "does anything here speak SQLScript?" -- and is
 * written to handle "no" gets a crash page instead of an answer. That is how
 * the AMDP tile answered 500 in the browser preview (osg-osd-i7, E.5,
 * 2026-09-19), and it is the same family as ANOMALY-2026-09-14: **an ABAP
 * program cannot defend itself against a runtime throw.**
 *
 * `CX_SY_DYN_CALL_ILLEGAL_FUNC` is what a system raises when a dynamically
 * called function cannot be called here, which is exactly the situation, and
 * our own `src/` already catches it. When there is no runtime at all -- a
 * tool importing this module directly -- a plain Error is right and is what
 * happens.
 */
async function refuse(message, name = "AMDP") {
  const classes = globalThis.abap?.Classes;
  const cx = classes?.["CX_SY_DYN_CALL_ILLEGAL_FUNC"];
  if (cx === undefined) throw new Error(message);
  const raised = await new cx().constructor_({function: name});
  // **And it has to SAY the reason, or it is the other half of the defect.**
  //
  // The ABAP that catches this does `lv_error = lx_root->get_text( )`, and
  // `get_text()` on a transpiled exception reads the class's textid -- it
  // returns "An exception was raised." and knows nothing of a property set
  // on the object. Measured, not assumed: constructed through the real
  // runtime, that is exactly the string it gives back.
  //
  // So the page would have answered `engine: "none"` with a reason that says
  // nothing, which is ANOMALY-2026-09-14 over again -- an exception with no
  // message is a 500 that has learnt to return 200. The method is replaced
  // on the instance so the CATCH reads the sentence a developer needs.
  const text = globalThis.abap?.types?.String;
  const carried = text === undefined ? {get: () => message} : new text().set(message);
  raised.get_text = async () => carried;
  raised.AMDP_REASON = message;
  throw raised;
}

/** what amdp-gen wrote: one entry per AMDP method, keyed by module name */
export function loadProcedures(folder = "gen/amdp") {
  // **There is no disk in a service worker.** `node:fs` is polyfilled in the
  // preview bundle to something without `existsSync`, so this threw a
  // TypeError out of the constructor and the browser got a crash page for a
  // question whose answer is "there is no HANA here". Third layer of the same
  // onion: each fix uncovered the next node-only call, which is what a guard
  // written at the bottom rather than at the boundary does.
  if (typeof existsSync !== "function") return new Map();
  const file = join(folder, "procedures.json");
  if (!existsSync(file)) return new Map();
  const {procedures} = JSON.parse(readFileSync(file, "utf8"));
  return new Map(procedures.map((p) => [p.module.toUpperCase(), p]));
}

function statement(p) {
  const name = `"${SCHEMA}"."${p.class}=>${p.method.toUpperCase()}"`;
  if (p.kind === "function") {
    // A table function is a view with arguments: its rows are its return
    // value, not an OUT parameter, so the RETURNING parameter of the ABAP
    // method becomes RETURNS TABLE(...) here.
    const returning = p.parameters.find((x) => x.direction === "RETURNING");
    const args = p.parameters.filter((x) => x.direction === "IN")
      .map((x) => `${x.name} ${x.hanaType}`).join(", ");
    return [`CREATE FUNCTION ${name} (${args})`,
      `  RETURNS ${returning?.hanaType ?? "TABLE()"}`,
      `  LANGUAGE ${p.language}`, `  READS SQL DATA`, "AS BEGIN", p.body, "END;"].join("\n");
  }
  const args = p.parameters.map((x) =>
    `${x.direction === "INOUT" ? "INOUT" : x.direction} ${x.name} ${x.hanaType}`).join(", ");
  return [`CREATE PROCEDURE ${name} (${args})`, `  LANGUAGE ${p.language}`, `  SQL SECURITY INVOKER`,
    p.readOnly ? "  READS SQL DATA" : "", "AS BEGIN", p.body, "END;"]
    .filter((x) => x !== "").join("\n");
}

export function nestedProcedures(program, found = new Set()) {
  const visit = (body) => {
    for (const one of body ?? []) {
      if (one.stmt === "call-procedure") found.add(String(one.procedure).toUpperCase());
      childBodies(one).forEach(visit);
    }
  };
  visit(program?.body);
  return found;
}

/** lines the sandbox wrapper puts in front of a typed body (see #sandbox) */
const SANDBOX_OFFSET = 1;

/** The restricted sandbox user's password: made once and kept beside the
 *  other one, outside the deployment directory, because a release is rebuilt
 *  by `rsync --delete` on every deploy. It is not a secret anybody types --
 *  nothing but this process ever uses it -- but it has to be the same across
 *  restarts or the user would have to be dropped and recreated. */
function sandboxPassword() {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const file = process.env.OSD_AMDP_SANDBOX_PASSWORD_FILE
    ?? (home === "" ? undefined : join(home, ".osd", "amdp-sandbox-password"));
  if (process.env.OSD_AMDP_SANDBOX_PASSWORD) return process.env.OSD_AMDP_SANDBOX_PASSWORD;
  if (file === undefined) return "Sbx" + randomBytes(12).toString("hex") + "A1";
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  // HANA's default policy wants length, a digit and mixed case
  const made = "Sbx" + randomBytes(12).toString("hex") + "A1";
  mkdirSync(dirname(file), {recursive: true});
  writeFileSync(file, made + "\n", {mode: 0o600});
  return made;
}

/** The sandbox user's name, which has to differ per machine.
 *
 *  The password is generated once and kept in `~/.osd/amdp-sandbox-password`
 *  so a restart does not have to drop and recreate the user. That is right
 *  for one machine and wrong the moment two share one HANA: whoever creates
 *  `OSD_SBX` first owns it, the second machine finds it already there, does
 *  not create it, and connects with a password that was never set on it.
 *  What it gets back is `authentication failed` -- measured 2026-09-19, five
 *  of them in one run, and nothing in the message says the user belongs to
 *  somebody else.
 *
 *  The shape is the day's: **a decision about a shared thing, taken in code
 *  that can only see one participant.** A per-machine secret needs a
 *  per-machine name, so the host is in the name and the two do not collide.
 *  Hashed rather than spelled out: a host name is an identifier and this one
 *  is written into a database other people can read.
 *
 *  `OSD_AMDP_SANDBOX_USER` still overrides, which is how two sessions on one
 *  machine get a sandbox each. */
function defaultSandboxUser() {
  return "OSD_SBX_" + createHash("sha1").update(hostname()).digest("hex").slice(0, 6).toUpperCase();
}

export class AmdpDestination {
  constructor(options = {}) {
    this.folder = options.folder ?? "gen/amdp";
    this.trace = options.trace === true;
    this.procedures = options.procedures ?? loadProcedures(this.folder);
    this.client = undefined;
    this.settingsProvider = options.settings ?? hanaSettings;
    this.createClient = options.createClient;
    // The application database is looked up at call time: setup installs the
    // destination before every backend branch has connected. Keeping this a
    // provider also proves that portable AMDP uses the caller's connection,
    // not a second DuckDB beside the ABAP LUW.
    this.database = options.database ?? (() => globalThis.abap?.context?.databaseConnections?.DEFAULT);
    // the source hash of what is deployed, so a body is created once and a
    // changed body is redeployed without anyone remembering to
    this.deployed = new Map();
    this.deploying = new Map();
    this.generation = 0;
    this.connecting = undefined;
  }

  async #connect() {
    if (this.client !== undefined && this.client.readyState === "connected") return this.client;
    if (this.connecting !== undefined) return this.connecting;
    if (this.client !== undefined) this.#forgetClient();
    const generation = ++this.generation;
    const pending = this.#openClient(generation);
    this.connecting = pending;
    try { return await pending; } finally {
      if (this.connecting === pending) this.connecting = undefined;
    }
  }

  async #openClient(generation) {
    // A host that was built without a HANA driver -- the browser preview,
    // where the bundle leaves hdb and tools/amdp-run.mjs out -- still has this
    // destination, because a developer needs "there is no HANA here" rather
    // than "unknown destination AMDP". Say that, rather than fail on an
    // undefined import.
    const settings = await this.settingsProvider();
    if (settings === undefined) {
      await refuse("AMDP: this build has no HANA driver (the browser preview); an AMDP method needs a " +
        "database that speaks SQLScript");
    }
    // **Configured, before dialled.** With a driver present and no HANA
    // configured, this used to dial `localhost:39017` and hand the driver's
    // rejection straight out -- a plain JavaScript Error, which is the one
    // thing the ABAP `CATCH cx_root` around the CALL FUNCTION cannot catch.
    // The page came back 500 "Connection closed", and `test/amdp-sandbox.mjs`
    // was red for everybody who did not have `~/.osd/hxe-password`. It was
    // green here, which is the whole shape of the defect: the suite was
    // passing on the author's machine and on no other.
    if (settings.password === undefined || settings.password === "") {
      await refuse("AMDP: no HANA is configured here -- set HXE_HOST / HXE_PASSWORD, or put the " +
        "password in ~/.osd/hxe-password. An AMDP method needs a database that speaks SQLScript");
    }
    this.settings = settings;
    try {
      const createClient = this.createClient ?? (await import("hdb")).default.createClient;
      const client = createClient(settings);
      try {
        await new Promise((resolve, reject) => client.connect((e) => (e ? reject(e) : resolve())));
        const [createSchema, setSchema] = amdpSessionSchema();
        await this.#exec(createSchema, client).catch(() => undefined);
        await this.#exec(setSchema, client);
        if (this.generation !== generation) throw new Error("session replaced while connecting");
        this.client = client;
      } catch (error) {
        try { client.end(); } catch { /* already closed */ }
        throw error;
      }
    } catch (reason) {
      if (this.generation === generation) this.#forgetClient();
      await refuse(safeError(reason, settings));
    }
    // This is a separate HANA session from the system DatabaseClient. An
    // AMDP body names DDIC tables without a schema, just as it does on ABAP;
    // SQL SECURITY INVOKER resolves those names in this session's current
    // schema. Without SET SCHEMA it is the login user's schema (SYSTEM), and
    // a perfectly deployed procedure cannot see the system's own tables.
    // The privileged settings are also used by the restricted-user path below.
    return this.client;
  }

  #forgetClient(expected = this.client) {
    if (this.client !== expected) return;
    try { this.client?.end(); } catch { /* already closed */ }
    this.client = undefined;
    this.generation++;
    // A server restart may have removed the procedures; rebuild them on the new session.
    this.deployed.clear();
    this.deploying.clear();
  }

  #exec(sql, client = this.client) {
    return new Promise((resolve, reject) =>
      client.exec(sql, (err, ...rest) => (err ? reject(err) : resolve(rest))));
  }

  async #deploy(p, client, generation, stack = new Set()) {
    const identity = `${p.class}=>${p.method}`.toUpperCase();
    if (stack.has(identity)) throw new Error(`AMDP: cyclic native dependency at ${identity}`);
    const next = new Set(stack).add(identity);
    // A parent can remain byte-identical while a child changes. Check and
    // deploy dependencies before the parent's own hash fast-path, otherwise
    // invoking only the parent would keep calling a stale HANA procedure.
    for (const dependency of nestedProcedures(p.portable)) {
      const child = [...this.procedures.values()].find((one) =>
        `${one.class}=>${one.method}`.toUpperCase() === dependency);
      if (child === undefined) throw new Error(`AMDP: native dependency ${dependency} is absent from the manifest`);
      await this.#deploy(child, client, generation, next);
    }
    if (generation !== this.generation || client !== this.client) throw new Error("AMDP: session replaced during deployment");
    if (this.deployed.get(p.module) === p.hash) return;
    const active = this.deploying.get(p.module);
    if (active?.generation === generation && active.hash === p.hash) return active.promise;
    const promise = this.#deployOne(p, client, generation);
    this.deploying.set(p.module, {generation, hash: p.hash, promise});
    try { await promise; } finally {
      if (this.deploying.get(p.module)?.promise === promise) this.deploying.delete(p.module);
    }
  }

  async #deployOne(p, client, generation) {
    const name = `"${SCHEMA}"."${p.class}=>${p.method.toUpperCase()}"`;
    await this.#exec(`CREATE SCHEMA "${SCHEMA}"`, client).catch(() => undefined);
    await this.#exec(`DROP ${p.kind === "function" ? "FUNCTION" : "PROCEDURE"} ${name}`, client).catch(() => undefined);
    await this.#exec(statement(p), client);
    if (generation !== this.generation || client !== this.client) throw new Error("AMDP: session replaced during deployment");
    this.deployed.set(p.module, p.hash);
    if (this.trace) console.log(`AMDP: deployed ${name}`);
  }

  /** Where an eAMDP call would go right now, read off the destination rather
   *  than off its configuration (docs/amdp-engine-status.md). Three facts and
   *  nothing else leaves: whether this build has a HANA driver, whether a
   *  HANA is configured, and the state of the session this destination holds
   *  -- `none` (never dialled), `connected`, or `closed` (a socket the server
   *  or a proxy dropped, which the next call reconnects once). No host, port,
   *  user or schema: the status page is served to anyone who can reach it. */
  async sessionState() {
    let settings;
    try { settings = await this.settingsProvider(); } catch { settings = undefined; }
    const driver = settings !== undefined;
    const configured = driver && settings.password !== undefined && settings.password !== "";
    const session = this.client === undefined ? "none"
      : this.client.readyState === "connected" ? "connected" : "closed";
    return {driver, configured, session};
  }

  /** Let go of the connection. An open socket keeps Node's event loop alive,
   *  so a suite that touched HANA passes and then does not exit. */
  async close() {
    // both of them: the privileged connection and the restricted one the
    // sandbox runs on. Closing only the first left a socket open, which keeps
    // Node's event loop alive, so a suite passed and then hung -- the same
    // failure this method was added to fix, reintroduced by giving the
    // sandbox a connection of its own.
    for (const key of ["client", "sbx"]) {
      const held = key === "sbx" ? this.sbx?.client : this.client;
      if (held === undefined) continue;
      try { held.end(); } catch { /* already gone */ }
    }
    this.client = undefined;
    this.sbx = undefined;
    this.generation++;
    this.deployed.clear();
    this.deploying.clear();
  }

  /** The sandbox (backlog G.8): a body typed on a screen, run now.
   *
   *  Everything else here routes a *generated* module whose signature the
   *  transpiler resolved at transpile time. The sandbox has no signature to
   *  resolve: it takes text and gives back text, which is what lets one
   *  function module stand for any body a person types.
   *
   *  The body is deployed under a throwaway name and dropped again, so
   *  nothing a visitor types survives the call. The name carries the process
   *  and a counter rather than a random word, so two sandboxes open at once
   *  cannot collide and a leftover object says who left it.
   *
   *  The interesting half is the failure: HANA answers a bad body with a
   *  message that names the line and the column. Keep that position and text
   *  while removing any credentials echoed by the driver.
   */
  /** The connection a typed body runs on, which is **not** the one the bridge
   *  deploys generated procedures with.
   *
   *  A sandbox reachable from a page must not execute as the database's
   *  superuser: `SQL SECURITY INVOKER` means the body runs with the rights of
   *  whoever called it, and as SYSTEM that is everything -- reading any
   *  schema, creating users, dropping the system's own tables. The default is
   *  therefore a user of its own, `OSD_SBX`, owning one schema and holding no
   *  grant outside it: a body can create, fill and read its own tables and
   *  can see nothing else. A fresh HANA user starts with no privileges, so
   *  the restriction is the absence of grants rather than a list of denials,
   *  which is the kind that cannot be got wrong by forgetting one.
   *
   *  `OSD_AMDP_SUPERUSER=1` runs as the privileged user instead. It is an
   *  environment variable and not a switch on the page on purpose: a flag in
   *  a URL would let anyone who can reach the sandbox grant themselves the
   *  rights it is there to withhold.
   */
  async #sandboxClient() {
    if (process.env.OSD_AMDP_SUPERUSER === "1") {
      await this.#connect();
      return {client: this.client, user: this.settings.user, schema: SCHEMA, restricted: false};
    }
    if (this.sbx !== undefined) return this.sbx;

    const user = process.env.OSD_AMDP_SANDBOX_USER ?? defaultSandboxUser();
    const password = sandboxPassword();
    // errors of the sandbox connection must hide this password too
    this.sandboxPassword = password;
    // provisioning needs the privileged connection, and only the first time
    await this.#connect();
    const exists = await this.#exec(
      `SELECT COUNT(*) AS N FROM SYS.USERS WHERE USER_NAME = '${user}'`).catch(() => undefined);
    const n = Number((exists?.find(Array.isArray) ?? [])[0]?.N ?? 0);
    if (n === 0) {
      await this.#exec(`CREATE USER ${user} PASSWORD "${password}" NO FORCE_FIRST_PASSWORD_CHANGE`);
      // a schema of its own, owned by it; nothing else is granted
      await this.#exec(`CREATE SCHEMA ${user} OWNED BY ${user}`).catch(() => undefined);
      if (this.trace) console.log(`AMDP: created the restricted sandbox user ${user}`);
    }
    const hdb = (await import("hdb")).default;
    const client = hdb.createClient({...this.settings, user, password});
    await new Promise((resolve, reject) => client.connect((e) => (e ? reject(e) : resolve())))
      .catch((e) => {
        // "authentication failed" against a user that is plainly there is the
        // least informative thing this can say, and it is exactly what one
        // host gets when another host made the user. Say which of the two it
        // is, because the fix differs: a wrong password is a password, and a
        // foreign user is a name.
        if (n !== 0) {
          throw new Error(
            `AMDP: the sandbox user ${user} exists on this HANA but the password held here does ` +
            `not open it. It was most likely created by another host, since the password is ` +
            `generated per machine (~/.osd/amdp-sandbox-password). Set OSD_AMDP_SANDBOX_USER to a ` +
            `name of your own, or OSD_AMDP_SANDBOX_PASSWORD to the one that made it. (${e.message})`);
        }
        throw e;
      });
    this.sbx = {client, user, schema: user, restricted: true};
    return this.sbx;
  }

  async #sandbox(signature) {
    // The transpiler writes the parameter names of a CALL FUNCTION in the
    // case they were typed in, which for ABAP source is lower; the function
    // group declares them upper. Look either up without caring, or the call
    // arrives, runs and answers into nothing -- which on the screen is a page
    // with no result and no error, the least informative outcome possible.
    const pick = (bag, name) => {
      if (bag === undefined) return undefined;
      const key = Object.keys(bag).find((k) => k.toUpperCase() === name);
      return key === undefined ? undefined : bag[key];
    };
    const given = pick(signature.exporting, "IV_BODY");
    const body = String(given?.get?.() ?? given ?? "");
    const say = (field, text) => {
      const target = pick(signature.importing, field);
      if (target?.set !== undefined) target.set(String(text));
    };
    if (body.trim() === "") {
      say("EV_ERROR", "nothing to run");
      return;
    }
    const run = await this.#sandboxClient();
    const exec = (sql) => new Promise((resolve, reject) =>
      run.client.exec(sql, (err, ...rest) => (err ? reject(err) : resolve(rest))));
    say("EV_USER", run.user);
    say("EV_SCHEMA", run.schema);
    say("EV_RESTRICTED", run.restricted === true ? "X" : "");
    this.sandboxCount = (this.sandboxCount ?? 0) + 1;
    const name = `"${run.schema}"."OSD_SANDBOX_${process.pid}_${this.sandboxCount}"`;
    const started = Date.now();
    await exec(`DROP PROCEDURE ${name}`).catch(() => undefined);
    // The wrapper is **one fixed line**, and that is not a matter of taste:
    // the engine reports "line N col M" against the statement it was given,
    // so every line the wrapper adds is a line the person's own numbering is
    // wrong by. One line in front, one behind, and the correction is a
    // subtraction that cannot drift (SANDBOX_OFFSET). A second CREATE shape
    // tried on failure would make the offset depend on which attempt spoke.
    const preamble = `CREATE PROCEDURE ${name} () LANGUAGE SQLSCRIPT SQL SECURITY INVOKER AS BEGIN`;
    try {
      await exec(`${preamble}\n${body}\nEND`);
      const out = await exec(`CALL ${name}`);
      const rows = out.find(Array.isArray) ?? [];
      const plain = rows.slice(0, 200).map((row) => Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, Buffer.isBuffer(v) ? v.toString("utf8") : v])));
      say("EV_RESULT", JSON.stringify(plain));
      say("EV_ROWS", String(rows.length));
      say("EV_MS", String(Date.now() - started));
    } catch (e) {
      // The engine's words, with credentials removed. EV_ERROR carries the position moved
      // back into the person's own line numbering. EV_RAW retains the engine's
      // original line numbers for diagnostics.
      const raw = safeError(e, {...this.settings, secrets: [this.sandboxPassword]});
      say("EV_RAW", raw);
      say("EV_ERROR", raw.replace(/line (\d+)/g, (m, n) => `line ${Number(n) - SANDBOX_OFFSET}`));
    } finally {
      await exec(`DROP PROCEDURE ${name}`).catch(() => undefined);
    }
  }

  /** the destination contract: (function module name, typed signature) */
  async call(name, signature) {
    try {
      return await this.#call(name, signature);
    } catch (error) {
      await refuse(safeError(error, {...this.settings, secrets: [this.sandboxPassword]}), name);
    }
  }

  async #call(name, signature) {
    if (String(name).trimEnd().toUpperCase() === "ZOSD_AMDP_SANDBOX") {
      return this.#sandbox(signature);
    }
    const p = this.procedures.get(String(name).trimEnd().toUpperCase());
    if (p === undefined) {
      await refuse(`AMDP: no procedure known for ${name}. Run 'node tools/amdp-gen.mjs' ` +
        "so gen/amdp/procedures.json carries it.", name);
    }
    const database = this.database?.();
    if (database?.name === "duckdb") {
      return this.#portable(p, signature, database);
    }
    const {call} = await import("./amdp-run.mjs");
    const inputs = {};
    for (const x of p.parameters) {
      if (x.direction === "OUT") continue;
      const given = signature.exporting?.[x.name] ?? signature.changing?.[x.name] ?? signature.tables?.[x.name];
      if (given === undefined) continue;
      // the runtime's typed value -> plain JSON the runner can bind
      inputs[x.name] = typeof given.array === "function" ? given.array().map((row) => plainRow(row)) : given.get();
    }
    // A visibly closed cached session already spends this call's one reconnect.
    // A socket can also die while still reporting "connected"; that case gets
    // the retry below after the first operation fails.
    const reconnecting = this.client !== undefined && this.client.readyState !== "connected";
    let attemptClient;
    const invoke = async () => {
      const client = await this.#connect();
      attemptClient = client;
      const generation = this.generation;
      await this.#deploy(p, client, generation);
      if (p.kind === "function") {
        // a table function is queried, not called
        const args = p.parameters.filter((x) => x.direction === "IN")
          .map((x) => `${x.name} => ${literal(inputs[x.name])}`).join(", ");
        const rows = await this.#exec(
          `SELECT * FROM "${SCHEMA}"."${p.class}=>${p.method.toUpperCase()}"(${args})`, client);
        const returning = p.parameters.find((x) => x.direction === "RETURNING");
        return {[returning?.name ?? "rt"]: (rows.find(Array.isArray) ?? []).map((row) =>
          Object.fromEntries(Object.entries(row).map(([k, v]) =>
            [k.toLowerCase(), abapDateTime(Buffer.isBuffer(v) ? v.toString("utf8") : v)])))};
      }
      const method = {name: p.method, parameters: p.parameters.map((x) => ({...x, abapType: x.hanaType}))};
      return call(client, `"${SCHEMA}"."${p.class}=>${p.method.toUpperCase()}"`, method, inputs, undefined);
    };
    let result;
    try {
      result = await invoke();
    } catch (error) {
      if (!lostConnection(error)) throw error;
      // A failed dial was already shared by its waiters. Only an operation on
      // an established client can spend this call's reconnect attempt.
      if (attemptClient === undefined) throw error;
      if (reconnecting) throw error;
      this.#forgetClient(attemptClient);
      try {
        result = await invoke();
      } catch (retryError) {
        throw retryError;
      }
    }

    for (const x of p.parameters) {
      if (x.direction === "IN") continue;
      const target = signature.importing?.[x.name] ?? signature.changing?.[x.name] ?? signature.tables?.[x.name];
      if (target === undefined) continue;
      fromJson(target, withAbapDates(result[x.name] ?? result[x.name.toUpperCase()]));
    }
    if (this.trace) console.log(`AMDP: ${p.class}=>${p.method} returned ${Object.keys(result).join(", ")}`);
  }

  /** Execute precompiled typed IR on the system's own DuckDB connection.
   *
   * The generator owns parsing and typing. This path owns only runtime value
   * transfer and orchestration; the final relation still runs in DuckDB.
   * There is intentionally no HANA fallback here: selecting DuckDB and then
   * reaching a hidden HANA would make a passing unit test meaningless.
   */
  async #portable(p, signature, database) {
    if (p.portable === undefined) {
      await refuse(`AMDP: ${p.class}=>${p.method} is not in the portable SQLScript subset: ` +
        `${p.portableRefusal?.message ?? "no compiled portable program"}`, p.module);
    }
    const pick = (bag, name) => {
      if (bag === undefined) return undefined;
      const key = Object.keys(bag).find((one) => one.toUpperCase() === String(name).toUpperCase());
      return key === undefined ? undefined : bag[key];
    };
    // `null` is a real SQLScript input, while `undefined` means that the
    // parameter is absent from this signature section. Nullish coalescing
    // would accidentally turn a supplied NULL into an omitted argument.
    const firstPresent = (...values) => values.find((value) => value !== undefined);
    const inputs = {};
    for (const parameter of p.portable.parameters ?? []) {
      const given = firstPresent(pick(signature.exporting, parameter.name),
        pick(signature.changing, parameter.name), pick(signature.tables, parameter.name));
      if (given === undefined) continue;
      inputs[parameter.name] = typeof given.get === "function" ? given.get() : given;
    }
    const relationInputs = {};
    // IN tables the client holds as host relations (tools/ir-host-relation.mjs),
    // dropped when the call ends however it ends
    const hosted = [];
    try {
      await this.#relationInputs(p, signature, database, relationInputs, hosted, pick, firstPresent);
      await this.#runPortable(p, signature, database, inputs, relationInputs, pick, firstPresent);
    } finally {
      for (const handle of hosted) await database.dropRelation(handle);
    }
  }

  /** each IN table as a relation: a host relation where the client can hold
   *  one, the union of single-row selects where it cannot */
  async #relationInputs(p, signature, database, relationInputs, hosted, pick, firstPresent) {
    if ((p.portable.relationParameters ?? []).length > 0) {
      const {scan, project, union, filter, lit, T} = await import("./sqlscript-ir.mjs");
      const {hostRelation, hostPlan, abapTableRows} = await import("./ir-host-relation.mjs");
      for (const parameter of p.portable.relationParameters) {
        const given = firstPresent(pick(signature.exporting, parameter.name),
          pick(signature.changing, parameter.name), pick(signature.tables, parameter.name));
        if (given === undefined || typeof given.array !== "function") {
          await refuse(`AMDP: portable table input ${parameter.name} is missing or is not an ABAP table`, p.module);
        }
        let handle;
        try {
          handle = await hostRelation(database, "duckdb", {name: parameter.name, schema: parameter.schema, rows: abapTableRows(given)});
        } catch (error) {
          await refuse(`AMDP: portable table input ${parameter.name}: ${String(error?.message ?? error)}`, p.module);
        }
        if (handle !== undefined) {
          hosted.push(handle);
          relationInputs[parameter.name] = hostPlan(handle, parameter.schema);
          continue;
        }
        const columns = Object.entries(parameter.schema);
        const rows = given.array().map(plainRow);
        // Build-time IR budgets protect the interpreter, but constructing a
        // million-branch UNION before handing it over would spend the memory
        // first and refuse afterwards. Bound the ABAP boundary itself.
        if (rows.length > 2000 || rows.length * Math.max(columns.length, 1) > 10000) {
          await refuse(`AMDP: portable table input ${parameter.name} exceeds 2000 rows or 10000 cells`, p.module);
        }
        const rowPlan = (row) => project(scan("DUMMY"), columns.map(([name, type]) => ({
          as: name,
          expr: lit(row[name.toLowerCase()] ?? null, type),
        })));
        // An empty relation still has the signature's schema. The false
        // filter is executed by the database, and every projected NULL is
        // typed by the IR; no inferred JavaScript-array schema exists.
        relationInputs[parameter.name] = rows.length === 0
          ? project(filter(scan("DUMMY"), lit(false, T.bool)), columns.map(([name, type]) => ({
            as: name, expr: lit(null, type),
          })))
          : (rows.length === 1 ? rowPlan(rows[0]) : union(rows.map(rowPlan), true));
      }
    }
  }

  async #runPortable(p, signature, database, inputs, relationInputs, pick, firstPresent) {
    const {runProcedure} = await import("./sqlscript-procedure-ir.mjs");
    let answer;
    try {
      const procedures = new Map([...this.procedures.values()]
        .filter((one) => one.portable !== undefined)
        .map((one) => [`${one.class}=>${one.method}`.toUpperCase(), one.portable]));
      answer = await runProcedure(p.portable, {
        client: database, dialect: "duckdb", inputs, relationInputs, procedures,
        inputCatalogue: p.portable.catalogue,
      });
    } catch (error) {
      await refuse(`AMDP: portable ${p.class}=>${p.method} refused: ${String(error?.message ?? error)}`, p.module);
    }
    // one OUT, or several (each written to its own target, by name)
    const targets = Array.isArray(p.portable.outputs)
      ? p.portable.outputs.map((one) => ({name: one.name,
        value: one.scalar !== undefined ? answer.outputs?.[one.name]?.value : answer.outputs?.[one.name]?.rows}))
      : [{name: p.portable.output, value: p.portable.outputType === undefined ? answer.rows : answer.value}];
    // every target resolved before any is written: a missing one refuses
    // the call with nothing half-written
    const resolved = [];
    for (const {name: output, value} of targets) {
      const target = firstPresent(pick(signature.importing, output),
        pick(signature.changing, output), pick(signature.tables, output));
      if (target === undefined) {
        await refuse(`AMDP: portable ${p.class}=>${p.method} has no runtime target for ${output}`, p.module);
      }
      resolved.push({target, value});
    }
    for (const {target, value} of resolved) fromJson(target, withAbapDates(value));
    if (this.trace) {
      console.log(`AMDP: portable ${p.class}=>${p.method} on DuckDB; ` +
        `${answer.trace?.databaseStatements ?? 0} database statement(s)`);
    }
  }
}

/** HANA's own date and time types, in ABAP's spelling.
 *
 *  Measured 2026-09-18 rather than assumed: node-hdb hands DATE, TIME,
 *  TIMESTAMP and SECONDDATE back as **strings**, not Date objects --
 *  "2026-09-18", "14:30:05", "2026-09-18T14:30:05.123". ABAP holds a date as
 *  CHAR(8) "20260918" and a time as CHAR(6) "143005", so the separators come
 *  out. Without this `set()` would store "2026-09-" into a CHAR(8) date and
 *  be quietly wrong, which is the failure mode this whole file keeps meeting.
 *
 *  Our own tables never hit this path: the transpiler writes ABAP D and T as
 *  NCHAR(8) and NCHAR(6), so they come back as "20260918" already. It matters
 *  when an AMDP body returns a real HANA date, `SELECT CURRENT_DATE` being
 *  the obvious one. */
export function abapDateTime(value) {
  if (typeof value !== "string") return value;
  let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (m) return m[1] + m[2] + m[3];
  m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (m) return m[1] + m[2] + m[3];
  m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})/.exec(value);
  if (m) return m.slice(1).join("");            // ABAP timestamp: YYYYMMDDHHMMSS
  return value;
}

/** a value as SQL text; only scalars reach here, a table parameter of a table
 *  function is not a thing HANA has */
function literal(v) {
  return typeof v === "number" ? String(v) : `'${String(v ?? "").replace(/'/g, "''")}'`;
}

/** the same, through a table of rows or a single value */
function withAbapDates(value) {
  if (Array.isArray(value)) return value.map(withAbapDates);
  if (value !== null && typeof value === "object" && !Buffer.isBuffer(value)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, withAbapDates(v)]));
  }
  return abapDateTime(value);
}

/** a runtime structure as plain JSON, lower-cased field names */
function plainRow(row) {
  const inner = typeof row.get === "function" ? row.get() : row;
  if (inner === null || typeof inner !== "object") return inner;
  const out = {};
  for (const [k, v] of Object.entries(inner)) out[k.toLowerCase()] = typeof v?.get === "function" ? v.get() : v;
  return out;
}
