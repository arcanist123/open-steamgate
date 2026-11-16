// Shared kernel of the dedicated read-only database user module
// (reader.mjs + reader-run.mjs): validation, quoting, the password
// generator, the ONE hdb connection-options builder, the error-code
// helpers, the consent prompt and the small catalogue reads. Split out of
// reader.mjs when the file reached the 1000-line budget (critic NOTE-6:
// "the next change must split it").
//
// SQL shape and error handling are the measured facts of E1-REPORT.md:
//
//   user names are NOT quoted (quoted -> 257 syntax error / 332 invalid user),
//   so the reader name is validated against ^OSD_[A-Z0-9_]{1,26}$ instead;
//   schema names ARE quoted as identifiers, embedded " doubled;
//   schema names in catalogue WHERE comparisons are bound parameters, never
//   concatenated;
//   the password literal is double-quoted with embedded " doubled -- and the
//   generated password contains only A-Z a-z 0-9 anyway, so nothing needs
//   escaping on the wire (E1 open question 5 answered conservatively);
//   332 after a failed create = the user is absent -- the consequence of the
//   first failure, never shown as the cause.
import {randomBytes} from "node:crypto";
import {createRequire} from "node:module";

// The reader name must be OURS, not merely well-formed: ^OSD_ followed by
// 1-26 capitals/digits/underscores. The old pattern admitted SYSTEM, SYS and
// _SYS_REPO, and DROP USER ... CASCADE is then one --yes away from the
// database's own accounts -- the validation exists for injection, but
// ownership is the stronger rule (critic M-2).
const READER_NAME_PATTERN = /^OSD_[A-Z0-9_]{1,26}$/;
export const DEFAULT_READER_NAME = "OSD_READER";

export class ReaderError extends Error {}
export class ConsentRefused extends ReaderError {}

// ---------------------------------------------------------------- quoting

// An identifier: double-quoted, embedded " doubled (E1, measured).
export function quoteIdentifier(name) {
  return `"${String(name).replace(/"/g, '""')}"`;
}

// A double-quoted literal for a password. E1 never reached this form on a live
// server; the generated password cannot contain a quote anyway, and the rule
// stays: quote it, double any embedded quote.
export function quotePasswordLiteral(password) {
  return `"${String(password).replace(/"/g, '""')}"`;
}

export function validateReaderName(name, {flag = "--reader-name"} = {}) {
  if (!READER_NAME_PATTERN.test(name)) {
    throw new ReaderError(`osd hana: invalid reader name ${JSON.stringify(name)} -- ` +
      `${flag} must match ^OSD_[A-Z0-9_]{1,26}$ (the tool's own prefix OSD_, then 1-26 capitals, digits, underscore). ` +
      `The name is sent UNQUOTED into CREATE USER, so anything else is not a name but an injection -- and a name ` +
      `that is not ours must never reach DROP USER at all.`);
  }
  return name;
}

// ------------------------------------------------------------- the schema

// C0 and C1 control characters (U+0000-U+001F, U+007F-U+009F): ESC, CR, LF,
// TAB and friends. A schema name carrying any of these is refused before any
// consent text is built (critic S-B): the name appears on the consent screen
// and in every message, and a name that can rewrite a terminal must not.
const SCHEMA_CONTROL_CHARS = /[\x00-\x1F\x7F-\x9F]/;

// HANA caps quoted identifiers at 127 characters.
const SCHEMA_MAX_LENGTH = 127;

/** The reader path's schema-name rule (critic S-B): refuse control
 *  characters outright, before any consent text exists. The conservative
 *  set a real ABAP schema name draws from is upper-case letters, digits, `_`
 *  and `/` (the SAP name rules) -- HANA itself allows any printable quoted
 *  identifier, so printable-but-unusual names (lower case, spaces, dots,
 *  quotes) are kept working through quoteIdentifier; only control characters
 *  are unprintable enough to rewrite what the operator reads. */
export function validateSchemaName(name, {flag = "--schema"} = {}) {
  if (typeof name !== "string" || name.length === 0) {
    throw new ReaderError(`osd hana: --create-reader needs the ABAP schema (--schema, or found by the probe)`);
  }
  if (name.length > SCHEMA_MAX_LENGTH) {
    throw new ReaderError(`osd hana: the schema name is ${name.length} characters; HANA identifiers stop at ` +
      `${SCHEMA_MAX_LENGTH}. Nothing was sent.`);
  }
  if (SCHEMA_CONTROL_CHARS.test(name)) {
    throw new ReaderError(`osd hana: refusing the schema name (from ${flag} or the probe): it contains control ` +
      `characters -- bytes of the C0/C1 ranges (ESC, CR, LF, TAB and the rest). The name is printed on the ` +
      `consent screen and in every message; a name that can rewrite a terminal must not get there. The exact ` +
      `bytes, escaped: ${JSON.stringify(show(name))}. Real ABAP schema names are upper-case letters, digits, ` +
      `'_' and '/' at most -- if this name came from the database itself, something else is wrong; say so in ` +
      `the report and create the reader by hand. Nothing was sent.`);
  }
  return name;
}

// ONE display form for a schema name in a message: control characters become
// their escaped form (critic S-B) -- every name a human reads goes through
// here, so nothing unprintable reaches the screen even if a future path
// forgets the validation.
export function show(name) {
  return String(name).replace(/[\x00-\x1F\x7F-\x9F]/g,
    (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);
}

/** The secret-store key: host, port, database and reader name together.
 *  --drop-reader is allowed to drop only when an entry exists for exactly
 *  this connection and name -- the record --create-reader wrote (critic M-2,
 *  M-3). An older entry that matches nothing is not a licence: it is ignored,
 *  and the refusal names the one statement an administrator can run by hand. */
export function readerStoreKey(connection, readerName) {
  return [connection.host, String(connection.port), connection.database ?? "", readerName].join("/");
}

// ------------------------------------------------------------ the password

// >= 24 characters, upper + lower + digit, only characters that need no
// escaping anywhere on the HANA wire: letters and digits. CSPRNG; the value
// lives in memory until it is sent in the one CREATE statement and stored in
// the secret store; it is never printed, logged or put on argv.
export function generateReaderPassword({random = randomBytes, length = 28} = {}) {
  if (length < 24) throw new ReaderError("osd-hana: reader password length must be >= 24");
  const upper = "ABCDEFGHJKLMNPQRSTUVWXYZ"; // no I/O: they are too easily confused when a human must copy one
  const lower = "abcdefghijkmnpqrstuvwxyz";
  const digits = "23456789";
  const alphabet = upper + lower + digits;
  for (;;) {
    const bytes = random(length);
    const chars = [...bytes].map((b) => alphabet[b % alphabet.length]);
    const has = (set) => chars.some((c) => set.includes(c));
    if (has(upper) && has(lower) && has(digits)) return chars.join("");
  }
}

// ------------------------------------------------------------------- hdb

/** The real client factory. `hdb` is already in the dependency tree; the seam
 *  (a `clientFactory` argument everywhere below) exists so the tests script a
 *  fake instead of a database -- this job has no database by rule. */
export function hdbClientFactory({require = createRequire(import.meta.url)} = {}) {
  const hdb = require("hdb");
  return async function connect(options) {
    const client = hdb.createConnection(options);
    await new Promise((resolvePromise, reject) => {
      client.connect((error) => (error ? reject(error) : resolvePromise()));
    });
    return {
      options,
      exec(sql, params = []) {
        return new Promise((resolvePromise, reject) => {
          client.exec(sql, params, (error, rows) => (error ? reject(error) : resolvePromise({rows: rows ?? []})));
        });
      },
      disconnect() {
        return new Promise((resolvePromise) => client.disconnect(() => resolvePromise()));
      },
    };
  };
}

// ---------------------------------------------------------------- helpers

// ONE place builds the driver's connection options -- the administrator
// connect, the reader proof connect and the drop-reader connect all go
// through here, so the tenant database cannot be lost on one path while
// present on another (critic M-3: a proof or an absence check against the
// wrong database reports success and leaves the user behind).
//
// Encryption (critic S-D, S-1), from hdb's documented options (node-hdb
// README, "Encrypted network communication"): `useTLS: true` opens a TLS
// socket with certificate validation (the options reach tls.connect, Node's
// default trust store applies, and hdb sets servername to the host);
// `rejectUnauthorized: false` is the documented tls.connect escape hatch,
// passed through by hdb, for "encrypt, but do not authenticate the server".
// `ca` is the CA certificate's CONTENT (hdb passes it to tls.connect) and
// `servername` overrides the SNI/hostname check -- the reader path gets the
// SAME --ca-file / --tls-server-name the sidecar gets (critic S-1: one
// consistent TLS set for both transports; the doctor reads the CA file once).
export function hdbConnectionOptions(connection, {user, password, encrypt = false, trustServerCertificate = false, ca, tlsServerName}) {
  return {
    host: connection.host,
    port: connection.port,
    user,
    password,
    ...(connection.database ? {databaseName: connection.database} : {}),
    ...(trustServerCertificate
      ? {useTLS: true, rejectUnauthorized: false}
      : encrypt
        ? {useTLS: true}
        : {}),
    ...(ca !== undefined ? {ca} : {}),
    ...(tlsServerName !== undefined ? {servername: tlsServerName} : {}),
  };
}

// The consent text's encryption lines (critic S-D). Said ALWAYS, in every
// mode -- an unencrypted run must never stay silent about the new password
// crossing the network inside CREATE USER.
export function transportLines({encrypt, trustServerCertificate, host, port, secret = "the new password travels"}) {
  if (trustServerCertificate) {
    return [
      `  WARNING -- --trust-server-certificate: the connection to ${host}:${port} is ENCRYPTED, but the server's`,
      `  certificate is NOT validated -- a machine that can intercept the traffic can impersonate the server.`,
      `  Use this only on a network you trust.`,
    ];
  }
  if (encrypt) {
    return [
      `  The connection to ${host}:${port} is encrypted (TLS; the server certificate is validated against the trust store,`,
      `  or against the CA given with --ca-file).`,
    ];
  }
  return [
    `  WARNING -- the connection to ${host}:${port} is NOT encrypted: ${secret} in clear text.`,
    `  Use a trusted network, or pass --encrypt (TLS, certificate validated); on a trusted network whose`,
    `  certificate cannot be checked, --trust-server-certificate encrypts without validation and says so.`,
  ];
}

// HANA driver errors carry a `code` (the native error number, e.g. 258, 332).
export function errorCode(error) {
  return error?.code ?? error?.dbCode ?? undefined;
}

export function sqlErrorText(error) {
  return `${errorCode(error) !== undefined ? `${errorCode(error)} ` : ""}${error?.message ?? String(error)}`;
}

// The mask shown in the consent text in place of the generated password.
// Exported for the test that asserts the printed plan and the executed
// statements are one source (critic S-C).
export const READER_PASSWORD_MASK = "***reader-password***";
const MASKED = READER_PASSWORD_MASK;

/** The ONE statement source of the create flow (critic S-C): every statement
 *  the flow may send, tagged with the role that must run it. The consent
 *  screen prints `item.sql` (mask applied); the execution runs `item.real`.
 *  Roles, per the measured facts: the ADMINISTRATOR (USER ADMIN) creates the
 *  user, disables the password lifetime and grants CATALOG READ (needed to
 *  dump database procedures / AMDP); the SCHEMA OWNER grants SELECT. On the
 *  measured systems no single login holds both; where one does, both roles
 *  run on the same connection. The two proof statements at the end run AS
 *  THE NEW READER after the setup (critic S-3 -- they are on the consent
 *  screen too, under "run as the new reader, changes nothing"): one SELECT
 *  proving the reader works, and the no-row UPDATE that MUST be refused with
 *  HANA error 258 -- it changes nothing even if wrongly allowed, and its
 *  refusal is what proves the reader cannot write. */
export function createPlan({readerName, schema, password, catalogRead = true}) {
  const plan = [
    {
      role: "admin",
      sql: `CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(MASKED)} NO FORCE_FIRST_PASSWORD_CHANGE`,
      real: `CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(password)} NO FORCE_FIRST_PASSWORD_CHANGE`,
      why: "create the dedicated reader (no forced password change: nobody will ever type it)",
    },
    {
      role: "admin",
      sql: `ALTER USER ${readerName} DISABLE PASSWORD LIFETIME`,
      real: `ALTER USER ${readerName} DISABLE PASSWORD LIFETIME`,
      why: "the password must not expire while the extraction runs",
    },
  ];
  if (catalogRead) {
    plan.push({
      role: "admin",
      sql: `GRANT CATALOG READ TO ${readerName}`,
      real: `GRANT CATALOG READ TO ${readerName}`,
      why: "let the reader see procedure definitions -- without it the database procedures (AMDP) cannot be extracted",
    });
  }
  plan.push({
    role: "owner",
    sql: `GRANT SELECT ON SCHEMA ${quoteIdentifier(schema)} TO ${readerName}`,
    real: `GRANT SELECT ON SCHEMA ${quoteIdentifier(schema)} TO ${readerName}`,
    why: "read access to the ABAP schema, nothing else",
  });
  plan.push({
    role: "reader",
    sql: `SELECT COUNT(*) AS N FROM ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")}`,
    real: `SELECT COUNT(*) AS N FROM ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")}`,
    why: "proof the reader works: it can read the repository tables",
  });
  plan.push({
    role: "reader",
    sql: `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")} SET "PGMID" = "PGMID" WHERE 1 = 0`,
    real: `UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")} SET "PGMID" = "PGMID" WHERE 1 = 0`,
    why: "proof the reader CANNOT write: the database must refuse this with error 258 -- it changes nothing even if wrongly allowed",
  });
  return plan;
}

// The consent screen: ALL statements of BOTH logins, before anything is sent,
// grouped by who runs them, from the one statement source above.
export function consentText({readerName, schema, plan, logins, store, connection, transport}) {
  const sameLogin = logins.admin.user === logins.owner.user;
  const lines = [
    `osd hana: about to create the dedicated read-only database user ${readerName}`,
    `  on ${connection.host}:${connection.port}${connection.database ? `/${connection.database}` : ""}`,
    `  and grant it SELECT on schema ${show(schema)}. The exact statements, grouped by the login that runs each:`,
    "",
  ];
  const group = (label, items) => {
    lines.push(`  ${label}:`);
    for (const item of items) lines.push(`    ${item.sql}   -- ${item.why}`);
    lines.push("");
  };
  if (sameLogin) {
    group(`as THIS login (it is both the administrator and the schema owner) -- ${logins.admin.user}`,
      plan.filter((p) => p.role === "admin" || p.role === "owner"));
  } else {
    group(`as the ADMINISTRATOR login ${logins.admin.user}`, plan.filter((p) => p.role === "admin"));
    group(`as the SCHEMA OWNER login ${logins.owner.user}`, plan.filter((p) => p.role === "owner"));
  }
  // The reader's own proof statements are on the screen too (critic S-3):
  // they are real statements sent as the reader, and the screen promised
  // exactness.
  group("run as the new reader, changes nothing:", plan.filter((p) => p.role === "reader"));
  lines.push(`  If any statement fails after the reader is created, the reader is dropped again`);
  lines.push(`  (DROP USER ${readerName} CASCADE, run by the administrator login) -- nothing is left behind.`);
  lines.push("");
  lines.push(...(transport ?? []));
  lines.push(`  (the password is generated, 28 characters, never printed; it will be stored in`);
  lines.push(`   ${store.location(readerName)})`);
  lines.push("");
  if (sameLogin) {
    lines.push(`  Your login will be used for these statements only; the password you gave is not stored.`);
  } else {
    lines.push(`  Each login runs only the statements shown under it; the passwords you gave are used for`);
    lines.push(`  their statements and dropped -- neither extra password is stored.`);
  }
  return lines.join("\n");
}

export async function askConsent({yes, isTTY, prompt = defaultPrompt}) {
  if (yes === true) return;
  if (!isTTY) {
    throw new ConsentRefused("osd hana: creating a database user needs consent -- re-run with --yes for non-interactive use");
  }
  const answer = await prompt("Type 'yes' to run these statements: ");
  if (answer.trim().toLowerCase() !== "yes") throw new ConsentRefused("osd hana: declined -- nothing was sent to the database");
}

async function defaultPrompt(question) {
  const {createInterface} = await import("node:readline");
  const rl = createInterface({input: process.stdin, output: process.stderr});
  return new Promise((resolvePromise) => rl.question(question, (answer) => {
    rl.close();
    resolvePromise(answer);
  }));
}

// The catalogue reads here are plain SELECTs through the hdb client, with the
// schema/user names as bound parameters (E1: a name in a WHERE *value*
// position is a string literal, never concatenated SQL).
export async function lookupSchemaOwner(client, schema) {
  try {
    const {rows} = await client.exec(
      `SELECT OWNER_NAME FROM SYS.SCHEMAS WHERE UPPER(SCHEMA_NAME) = UPPER(?)`, [schema]);
    return rows[0]?.OWNER_NAME ?? undefined;
  } catch {
    return undefined; // informational only; never blocks
  }
}

export async function countUsersNamed(client, name) {
  const {rows} = await client.exec(`SELECT COUNT(*) AS N FROM SYS.USERS WHERE USER_NAME = ?`, [name]);
  return Number(rows[0]?.N ?? 0);
}

// The installation identity, read at create time and compared at drop time
// (critic S-A): SYSTEM_ID identifies the HANA installation uniquely and
// survives restarts; DATABASE_NAME names the tenant. HOST and START_TIME are
// deliberately NOT compared -- HOST is whichever node answered (it moves in a
// scale-out or after a failover) and START_TIME is the last restart (it
// changes every boot); neither identifies the system, and comparing them
// would refuse every legitimate drop after an ordinary restart.
export async function readSystemIdentity(client) {
  const {rows} = await client.exec(`SELECT SYSTEM_ID, DATABASE_NAME FROM SYS.M_DATABASE`);
  const row = rows[0] ?? {};
  return {system_id: row.SYSTEM_ID, database_name: row.DATABASE_NAME};
}

export function sameSystemIdentity(a, b) {
  return a?.system_id === b?.system_id && a?.database_name === b?.database_name;
}

// Best-effort cleanup. A 332 here means the user is absent (E1: after a
// failed create every statement about the reader answers 332 invalid user
// name) -- that is the success case for a cleanup, not an error.
export async function dropUserQuietly(client, readerName) {
  try {
    await client.exec(`DROP USER ${readerName} CASCADE`);
    return {dropped: true};
  } catch (error) {
    if (errorCode(error) === 332) return {dropped: false, absent: true};
    return {dropped: false, absent: false, error};
  }
}
