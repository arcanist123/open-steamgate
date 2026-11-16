// The dedicated read-only database user: `osd hana doctor --create-reader` /
// `--drop-reader`. This is the ONLY code in the module that sends a statement
// that is not a SELECT, and it goes through the Node driver `hdb` directly --
// never through the sidecar, which is read-only by construction and whose
// statement gate refuses anything but SELECT (contract W0).
//
// SQL shape and error handling are the measured facts of E1-REPORT.md:
//
//   user names are NOT quoted (quoted -> 257 syntax error / 332 invalid user),
//   so the reader name is validated against ^[A-Z][A-Z0-9_]{0,30}$ instead;
//   schema names ARE quoted as identifiers, embedded " doubled;
//   schema names in catalogue WHERE comparisons are bound parameters, never
//   concatenated;
//   the password literal is double-quoted with embedded " doubled -- and the
//   generated password contains only A-Z a-z 0-9 anyway, so nothing needs
//   escaping on the wire (E1 open question 5 answered conservatively);
//   258 on CREATE USER  = this login may not create users (two ways on);
//   258 on GRANT        = this login may not grant the schema (the owner can);
//   332 after a failed create = the user is absent -- the consequence of the
//   first failure, never shown as the cause.
//
// Every failure after CREATE USER succeeded drops the user again and says what
// happened: the module must not leave a half-set-up reader behind.
import {randomBytes} from "node:crypto";
import {createRequire} from "node:module";
import {makeRedactor} from "./redact.mjs";

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
function hdbConnectionOptions(connection, {user, password, encrypt = false, trustServerCertificate = false, ca, tlsServerName}) {
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
function errorCode(error) {
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
 *  run on the same connection. */
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
    group(`as THIS login (it is both the administrator and the schema owner) -- ${logins.admin.user}`, plan);
  } else {
    group(`as the ADMINISTRATOR login ${logins.admin.user}`, plan.filter((p) => p.role === "admin"));
    group(`as the SCHEMA OWNER login ${logins.owner.user}`, plan.filter((p) => p.role === "owner"));
  }
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
async function lookupSchemaOwner(client, schema) {
  try {
    const {rows} = await client.exec(
      `SELECT OWNER_NAME FROM SYS.SCHEMAS WHERE UPPER(SCHEMA_NAME) = UPPER(?)`, [schema]);
    return rows[0]?.OWNER_NAME ?? undefined;
  } catch {
    return undefined; // informational only; never blocks
  }
}

/** The schema owner's login name, read by the ADMINISTRATOR connection before
 *  the consent screen so the guided flow can suggest it (measured fact: the
 *  doctor asks for the owner's login with the name shown from the catalogue).
 *  Informational: a read that fails yields no suggestion, never an error. */
export async function lookupSchemaOwnerLogin({connection, schema, user, password, clientFactory, encrypt = false, trustServerCertificate = false, ca, tlsServerName}) {
  const client = await clientFactory(hdbConnectionOptions(connection, {user, password, encrypt, trustServerCertificate, ca, tlsServerName}));
  try {
    return await lookupSchemaOwner(client, schema);
  } finally {
    await client.disconnect();
  }
}

async function countUsersNamed(client, name) {
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
async function readSystemIdentity(client) {
  const {rows} = await client.exec(`SELECT SYSTEM_ID, DATABASE_NAME FROM SYS.M_DATABASE`);
  const row = rows[0] ?? {};
  return {system_id: row.SYSTEM_ID, database_name: row.DATABASE_NAME};
}

function sameSystemIdentity(a, b) {
  return a?.system_id === b?.system_id && a?.database_name === b?.database_name;
}

// Best-effort cleanup. A 332 here means the user is absent (E1: after a
// failed create every statement about the reader answers 332 invalid user
// name) -- that is the success case for a cleanup, not an error.
async function dropUserQuietly(client, readerName) {
  try {
    await client.exec(`DROP USER ${readerName} CASCADE`);
    return {dropped: true};
  } catch (error) {
    if (errorCode(error) === 332) return {dropped: false, absent: true};
    return {dropped: false, absent: false, error};
  }
}

// ------------------------------------------------------------- create path

export function describe258OnCreate() {
  return [
    `osd hana: this login may not create users (HANA error 258, insufficient privilege).`,
    `  Two ways on:`,
    `  1. Run 'osd hana doctor --create-reader' with a login that holds USER ADMIN`,
    `     (on trial images the administrator login usually does).`,
    `  2. Go on without a dedicated reader: the extraction works with the present login,`,
    `     because every session the sidecar opens is READ ONLY at the database level --`,
    `     the database itself refuses any write, whoever logs on.`,
  ].join("\n");
}

export function describe412OnCreate() {
  return [
    `osd hana: the database's password policy rejected the generated password (HANA error 412, password policy violation).`,
    `  The generated password is 28 characters over letters and digits with upper + lower + digit; some systems' policies`,
    `  demand e.g. a special character. This run created nothing and removed nothing.`,
    `  Ask the database administrator to relax the policy for the OSD_ users, or create the reader by hand.`,
  ].join("\n");
}

// The name is taken (critic M-B): a user with this name already exists --
// ours from an earlier run (maybe in use by a running extract) or somebody
// else's. Neither is CREATEd over, neither is dropped by the create path;
// the message points at the two honest ways on.
export function describeNameTaken(readerName) {
  return [
    `osd hana: the name ${readerName} is taken -- a user with that name already exists on this database.`,
    `  This tool will not create over it, and it will not drop it: the user is not this run's.`,
    `  If it is a reader this tool created earlier, remove it explicitly (that path drops only a reader it can prove is its own):`,
    `    osd hana doctor --drop-reader --reader-name ${readerName}`,
    `  If it is somebody else's, pick a different name (must match ^OSD_[A-Z0-9_]{1,26}$):`,
    `    --reader-name ${readerName}_2`,
    `  Nothing was sent that changes any user.`,
  ].join("\n");
}

/** The present login is neither an administrator nor the schema owner (the
 *  probe's "other" class): the guided flow explains what the two logins must
 *  do and sends nothing. */
export function describeNeitherRole(schema) {
  return [
    `osd hana: this login is neither an administrator (USER ADMIN) nor the ABAP schema's owner, so it can`,
    `  neither create the reader nor grant it access. Nothing was sent.`,
    `  The two-login flow needs:`,
    `  - an ADMINISTRATOR login (USER ADMIN), which runs:`,
    `      CREATE USER <reader> PASSWORD ... NO FORCE_FIRST_PASSWORD_CHANGE`,
    `      ALTER USER <reader> DISABLE PASSWORD LIFETIME`,
    `      GRANT CATALOG READ TO <reader>   (needed for database procedures, AMDP)`,
    `  - the SCHEMA OWNER login, which runs:`,
    `      GRANT SELECT ON SCHEMA "${show(schema)}" TO <reader>`,
    `  On the measured systems no single login can do both; on some, one login holds both roles.`,
    `  Two ways on:`,
    `  1. re-run 'osd hana doctor --create-reader' with an administrator login -- the doctor then asks for`,
    `     the schema owner's login (the catalogue suggests it) and its password,`,
    `  2. re-run with the schema owner's login -- the doctor asks for an administrator login the same way.`,
    `  Or go on read-only with the present login: every session the sidecar opens is READ ONLY at the`,
    `  database level -- the database itself refuses any write, whoever logs on.`,
  ].join("\n");
}

export function describe258OnGrant(schema, owner) {
  return [
    `osd hana: this login may not grant the schema (HANA error 258, insufficient privilege).`,
    `  The reader was created and is now dropped again; nothing was left behind.`,
    `  The login that CAN grant SELECT on schema ${show(schema)} is its owner${owner ? `: ${owner}` : " (the owner lookup did not answer -- it is the user named like the schema on a classic ABAP stack)"}.`,
    `  Run 'osd hana doctor --create-reader' with that login, or go on read-only with the present login.`,
  ].join("\n");
}

/** Create the reader, end to end -- the guided TWO-LOGIN flow. `clientFactory(options)`
 *  opens an hdb connection (the seam the tests inject a fake into).
 *
 *  `role` is what the PRESENT login is (the doctor works it out from the
 *  probe): "admin" (USER ADMIN, not the owner), "owner" (the schema's owner),
 *  "both" (one login that can do both -- one step, as it always was), or the
 *  doctor refuses "neither" before ever calling here. When the present login
 *  has only one of the roles, `secondLogin` = {user, password} of the login
 *  holding the other; the doctor collected it with --owner-user /
 *  --admin-user and OSD_HANA_OWNER_PASSWORD / OSD_HANA_ADMIN_PASSWORD (or a
 *  hidden prompt on a terminal). Neither extra password is stored: each is
 *  used for its statements and dropped.
 *
 *  Returns {user, schema, storedAt} -- the generated password is NOT part of
 *  it: the secret store is its only holder (critic M-A). `onCreated({user,
 *  password, schema, catalogRead})` runs once, after the proofs succeeded and
 *  the secret is stored (the doctor runs the sidecar's probe AS THE READER
 *  through it); it must never throw -- a probe hiccup must not drop a proven
 *  reader. Throws ReaderError with a person-shaped message on every refusal;
 *  on any failure after CREATE the user is dropped again by the ADMINISTRATOR
 *  connection -- the only one that can -- and the message names which login
 *  failed at which statement. */
export async function createReader({
  connection,        // {host, port, user, password, database?} of the PRESENT login
  schema,
  readerName = DEFAULT_READER_NAME,
  yes = false,
  isTTY = false,
  store,
  clientFactory = hdbClientFactory(),
  prompt,
  say = () => {},
  generatePassword = generateReaderPassword,
  encrypt = false,               // --encrypt: TLS with certificate validation (hdb useTLS)
  trustServerCertificate = false, // --trust-server-certificate: TLS without validation, said loudly
  ca = undefined,                // the CA certificate's CONTENT (hdb's `ca` option), with --ca-file (critic S-1)
  tlsServerName = undefined,     // --tls-server-name: hdb's `servername`
  role = "both",                 // the PRESENT login's role: "admin" | "owner" | "both"
  secondLogin = undefined,       // {user, password} of the OTHER login when role !== "both"
  catalogRead = true,            // --no-catalog-read leaves the CATALOG READ grant out
  onCreated = undefined,
} = {}) {
  validateReaderName(readerName);
  // Before any consent text is built: a name that carries control characters
  // rewrites the screen the operator reads (critic S-B). validateSchemaName
  // also covers the missing-schema case.
  validateSchemaName(schema);
  if (role !== "both" && (secondLogin === undefined || typeof secondLogin.user !== "string" || typeof secondLogin.password !== "string")) {
    throw new ReaderError(`osd hana: the ${role === "admin" ? "schema owner's" : "administrator's"} login and password are missing -- ` +
      `the present login holds only the ${role === "admin" ? "administrator" : "schema owner"} role, so the other login must run its statements. ` +
      `Nothing was sent.`);
  }
  const logins = {
    admin: role === "owner" ? {user: secondLogin.user, password: secondLogin.password} : {user: connection.user, password: connection.password},
    owner: role === "admin" ? {user: secondLogin.user, password: secondLogin.password} : {user: connection.user, password: connection.password},
  };
  const password = generatePassword();
  const plan = createPlan({readerName, schema, password, catalogRead});
  say(consentText({
    readerName, schema, plan, logins, store, connection,
    transport: transportLines({encrypt, trustServerCertificate, host: connection.host, port: connection.port}),
  }));
  await askConsent({yes, isTTY, prompt});

  // Driver texts pass through a redactor holding ALL of this run's passwords
  // (critic note): HANA does not echo the literal for 331/412/258 and the
  // generated alphabet cannot cause a syntax error 'near' itself -- but that
  // is an assumption, and one line of redaction retires it. The second
  // login's password is a credential of this run too, for the minutes it
  // lives in memory.
  const redact = makeRedactor([password, connection.password, secondLogin?.password]);

  return runCreatePlan({connection, role, secondLogin, readerName, schema, password, plan, catalogRead, store, clientFactory, say, encrypt, trustServerCertificate, ca, tlsServerName, redact, onCreated, logins});
}

async function runCreatePlan({connection, role, secondLogin, readerName, schema, password, plan, catalogRead, store, clientFactory, say, encrypt = false, trustServerCertificate = false, ca = undefined, tlsServerName = undefined, redact = (text) => text, onCreated = undefined, logins}) {
  // The ADMINISTRATOR login runs CREATE / ALTER / CATALOG READ; the SCHEMA
  // OWNER login runs the GRANT SELECT. The administrator connection is also
  // the ONLY one that can drop the reader again -- every cleanup below goes
  // through it, whoever failed.
  const adminLogin = logins.admin;
  const ownerLogin = logins.owner;
  const grantSelect = plan[plan.length - 1];
  const adminClient = await clientFactory(hdbConnectionOptions(connection,
    {user: adminLogin.user, password: adminLogin.password, encrypt, trustServerCertificate, ca, tlsServerName}));
  let ownerClient;
  // Best-effort cleanup by the administrator connection: a 332 means the
  // user is absent (the consequence of a failed create) -- that is success
  // for a cleanup, not an error.
  const dropAgain = async () => {
    try {
      await adminClient.exec(`DROP USER ${readerName} CASCADE`);
      return {dropped: true};
    } catch (error) {
      if (errorCode(error) === 332) return {dropped: false, absent: true};
      return {dropped: false, absent: false, error};
    }
  };
  // The one cleanup message: which login failed at which statement, and what
  // happened to the half-set-up reader (task: "a failed GRANT by the owner --
  // 258, wrong password, logon failure -- = reader dropped, clear message
  // naming which login failed at which statement").
  const refused = async ({label, user, item, error}) => {
    const cleanup = await dropAgain();
    const note = cleanup.dropped
      ? `  The reader ${readerName} was dropped again by the administrator connection; nothing was left behind.`
      : cleanup.absent
        ? `  The reader ${readerName} is absent (HANA said 332 -- the drop found nothing to remove).`
        : `  ${redact(cleanupDropFailedText(cleanup))} Remove it by hand: DROP USER ${readerName} CASCADE.`;
    throw new ReaderError(`osd hana: the ${label} login ${user} failed at: ${item.sql}\n` +
      `  the database said: ${redact(sqlErrorText(error))}\n${note}`);
  };
  try {
    // 0. Existence guard (critic M-B), on the ADMINISTRATOR connection: a
    // user that already exists -- ours from an earlier run and maybe in use
    // by a running extract, or somebody else's -- is never CREATEd over and
    // never dropped: the create path may drop ONLY a user its own CREATE
    // USER created in this very run.
    let existing;
    try {
      existing = await countUsersNamed(adminClient, readerName);
    } catch (error) {
      throw new ReaderError(`osd hana: could not check whether ${readerName} already exists -- ${redact(sqlErrorText(error))}\n` +
        `  Refusing to run CREATE USER without that check: the tool may not create over a user it did not verify, ` +
        `and it never removes a user this run did not create.`);
    }
    if (existing !== 0) {
      throw new ReaderError(describeNameTaken(readerName));
    }

    // 0b. Record the installation identity BEFORE anything is created: the
    // entry stored below carries it, and --drop-reader compares it back
    // (critic S-A). A read failure here is a refusal, not a half-created
    // reader: nothing exists yet, so there is nothing to clean up.
    let systemIdentity;
    try {
      systemIdentity = await readSystemIdentity(adminClient);
    } catch (error) {
      throw new ReaderError(`osd hana: could not read the system's identity from SYS.M_DATABASE -- ${redact(sqlErrorText(error))}\n` +
        `  Refusing to create the reader without it: --drop-reader would have no identity to compare against, ` +
        `and an entry without one is how a drop lands on the wrong system. Nothing was created.`);
    }

    // 1. CREATE USER ... -- the one statement with the password on the wire.
    // Executed from the consent plan: the printed statement and the sent
    // statement are ONE source, the mask applied at print time only
    // (critic S-C). The CREATE itself failing -- 258 (no USER ADMIN), 331
    // (the name existed after all: the guard raced), 412 (password policy),
    // a network error, anything -- means this run created nothing, so it may
    // drop NOTHING. Only failures AFTER a successful CREATE may drop (below).
    try {
      await adminClient.exec(plan[0].real);
    } catch (error) {
      const code = errorCode(error);
      if (code === 258) throw new ReaderError(describe258OnCreate());
      if (code === 331) throw new ReaderError(describeNameTaken(readerName));
      if (code === 412) throw new ReaderError(describe412OnCreate());
      throw new ReaderError(`osd hana: setting up the reader failed -- ${redact(sqlErrorText(error))}\n` +
        `  The CREATE USER itself failed (the administrator login ${adminLogin.user}): this run created nothing ` +
        `and removed nothing -- a user that may exist under this name is not this run's to touch.`);
    }

    // From here on any failure drops the user again, by the administrator
    // connection. Every statement is named in the failure message (critic
    // S-2): which login failed at which statement, and the database's code.
    try {
      // 2. ALTER USER ... DISABLE PASSWORD LIFETIME (administrator login)
      try {
        await adminClient.exec(plan[1].real);
      } catch (error) {
        await refused({label: "administrator", user: adminLogin.user, item: plan[1], error});
      }

      // 3. GRANT CATALOG READ TO <reader> (administrator login; only with
      // it can the reader's dump see database procedures / AMDP). A 258 here
      // has its own ways-on (critic S-2): leave the grant out, or use an
      // administrator login that may grant CATALOG READ.
      if (catalogRead) {
        try {
          await adminClient.exec(plan[2].real);
        } catch (error) {
          if (errorCode(error) === 258) {
            const cleanup = await dropAgain();
            const note = cleanup.dropped
              ? `  The reader ${readerName} was dropped again by the administrator connection; nothing was left behind.`
              : cleanup.absent
                ? `  The reader ${readerName} is absent (HANA said 332 -- the drop found nothing to remove).`
                : `  ${redact(cleanupDropFailedText(cleanup))} Remove it by hand: DROP USER ${readerName} CASCADE.`;
            throw new ReaderError(`osd hana: the administrator login ${adminLogin.user} failed at: ${plan[2].sql}\n` +
              `  the database said: ${redact(sqlErrorText(error))}\n` +
              `  This login holds USER ADMIN but may not GRANT CATALOG READ (HANA error 258, insufficient privilege) --\n` +
              `  granting it needs CATALOG READ itself, with grant option. Two ways on:\n` +
              `  1. re-run with --no-catalog-read: the reader is created without the grant, but then the database\n` +
              `     procedures (AMDP) cannot be extracted -- the dump reports them as an error;\n` +
              `  2. use an administrator login that may grant CATALOG READ.\n${note}`);
          }
          await refused({label: "administrator", user: adminLogin.user, item: plan[2], error});
        }
      }

      // 4. GRANT SELECT ON SCHEMA "<schema>" TO <reader> -- the SCHEMA OWNER
      // login's statement. In the one-login case (role "both") it runs on the
      // same connection; a 258 there keeps the measured two-ways-on message.
      if (role === "both") {
        try {
          await adminClient.exec(grantSelect.real);
        } catch (error) {
          if (errorCode(error) === 258) {
            const owner = await lookupSchemaOwner(adminClient, schema);
            const cleanup = await dropAgain();
            throw new ReaderError(describe258OnGrant(schema, owner) + (cleanup.dropped || cleanup.absent ? "" : redact(cleanupDropFailedText(cleanup))));
          }
          await refused({label: "administrator", user: adminLogin.user, item: grantSelect, error});
        }
      } else {
        // The second connection, AS the login holding the other role. A
        // logon failure (wrong password, locked login, whatever) is the same
        // class of failure as a refused GRANT: the reader was created, so it
        // is dropped again, and the message names the login.
        const label = role === "admin" ? "schema-owner" : "administrator";
        try {
          ownerClient = await clientFactory(hdbConnectionOptions(connection,
            {user: ownerLogin.user, password: ownerLogin.password, encrypt, trustServerCertificate, ca, tlsServerName}));
        } catch (error) {
          await refused({label, user: ownerLogin.user, item: {sql: `log on as ${ownerLogin.user}`}, error});
        }
        try {
          await ownerClient.exec(grantSelect.real);
        } catch (error) {
          await refused({label, user: ownerLogin.user, item: grantSelect, error});
        }
      }

      // 5. Prove the reader works, twice: a real SELECT on the repository
      // table, and a REFUSED write -- the write probe changes nothing even if
      // wrongly allowed (WHERE 1 = 0), but it must be refused (measured: 258).
      const readerPassword = password;
      let proofClient;
      try {
        proofClient = await clientFactory(hdbConnectionOptions(connection, {user: readerName, password: readerPassword, encrypt, trustServerCertificate, ca, tlsServerName}));
        const {rows} = await proofClient.exec(`SELECT COUNT(*) AS N FROM ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")}`, []);
        say(`osd hana: the reader ${readerName} connected and read ${rows[0]?.N ?? "?"} rows of ${show(schema)}."TADIR" -- proof it works.`);
        let refusedText;
        try {
          await proofClient.exec(`UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")} SET "PGMID" = "PGMID" WHERE 1 = 0`, []);
          // NOT refused (the probe SUCCEEDED): the reader can write. Drop it
          // and fail loudly -- a reader that can write is not the reader this
          // tool promised.
          const cleanup = await dropAgain();
          const note = cleanup.dropped
            ? `  The reader ${readerName} was dropped again; nothing was left behind.`
            : cleanup.absent
              ? `  The reader ${readerName} is absent (HANA said 332 -- the drop found nothing to remove).`
              : `  ${redact(cleanupDropFailedText(cleanup))} Remove it by hand: DROP USER ${readerName} CASCADE.`;
          throw new ReaderError(`osd hana: THE READER CAN WRITE -- the write probe\n` +
            `    UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")} SET "PGMID" = "PGMID" WHERE 1 = 0\n` +
            `  was NOT refused by the database. This tool refuses to hand out a reader that can write.\n${note}`);
        } catch (error) {
          if (error instanceof ReaderError) throw error;
          // ONLY the insufficient-privilege code (258) proves the refusal
          // (critic M-1). Anything else -- another SQL error, a lost
          // connection -- proves NOTHING about the reader's privileges: a
          // syntax error says the statement was wrong, a socket hang-up says
          // the wire died. Neither may stand in for "the database refuses the
          // reader's writes", so the reader is dropped and the run fails,
          // naming which of the three outcomes it was.
          const code = errorCode(error);
          if (code !== 258) {
            const outcome = code === undefined
              ? `the connection to the database was LOST before an SQL error could arrive -- no SQL error arrived (${redact(sqlErrorText(error))})`
              : `the database answered a DIFFERENT error -- an SQL error, not an insufficient-privilege refusal (${redact(sqlErrorText(error))})`;
            const cleanup = await dropAgain();
            const note = cleanup.dropped
              ? `  The reader ${readerName} was dropped again; nothing was left behind.`
              : cleanup.absent
                ? `  The reader ${readerName} is absent (HANA said 332 -- the drop found nothing to remove).`
                : `  ${redact(cleanupDropFailedText(cleanup))} Remove it by hand: DROP USER ${readerName} CASCADE.`;
            throw new ReaderError(`osd hana: COULD NOT PROVE that the reader cannot write -- the write probe\n` +
              `    UPDATE ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")} SET "PGMID" = "PGMID" WHERE 1 = 0\n` +
              `  did not come back with HANA error 258 (insufficient privilege): ${outcome}.\n` +
              `  Only 258 proves the database refuses this reader's writes; this outcome proves nothing, so the reader is\n` +
              `  not handed out and no secret is stored. Re-run the doctor to try again.\n${note}`);
          }
          refusedText = redact(sqlErrorText(error));
        }
        say(`osd hana: proof the reader cannot write: the UPDATE probe on ${show(schema)}."TADIR" was refused by the database` +
            `${refusedText !== "" ? ` (${refusedText})` : ""}.`);
      } finally {
        if (proofClient !== undefined) await proofClient.disconnect();
      }

      // 6. Store the reader's credentials, keyed by this exact connection and
      // name -- --drop-reader demands the same key back before it will drop.
      // The entry is the password's only resting place: the return value of
      // this function deliberately carries none of it (critic M-A -- the
      // --json document must never hold it). The EXTRA passwords (the second
      // login's) are not stored anywhere: they were used for their statements
      // above and dropped with their connections.
      const storedAt = new Date().toISOString();
      store.set(
        {user: readerName, password, schema, host: connection.host, port: connection.port,
          database: connection.database, stored_at: storedAt, system_identity: systemIdentity,
          catalog_read: catalogRead},
        readerStoreKey(connection, readerName));
      say(`osd hana: the reader's credentials are stored in ${store.location(readerName)}.`);

      // 7. The doctor's hook (the sidecar's probe run AS THE READER): called
      // after the proofs and the store, never allowed to drop what is proven.
      if (onCreated !== undefined) {
        await onCreated({user: readerName, password, schema, catalogRead});
      }
      return {user: readerName, schema, storedAt};
    } catch (error) {
      // The catch-all cleanup: the user exists, the setup did not finish.
      // (A ReaderError has already done its own cleanup and carries its own
      // message -- dropping again would only bury the cause under a 332.)
      if (error instanceof ReaderError) throw error;
      const cleanup = await dropAgain();
      const causedBy = redact(sqlErrorText(error));
      const note = cleanup.dropped
        ? `The reader ${readerName} was dropped again; nothing was left behind.`
        : cleanup.absent
          ? `The reader ${readerName} is absent (HANA said 332, invalid user name -- that is "user absent", not the cause).`
          : `${redact(cleanupDropFailedText(cleanup))} Remove it by hand: DROP USER ${readerName} CASCADE.`;
      throw new ReaderError(`osd hana: setting up the reader failed -- ${causedBy}\n` +
        `  (the administrator login ${adminLogin.user} ran the statements up to here)\n  ${note}`);
    }
  } finally {
    await adminClient.disconnect();
    if (ownerClient !== undefined) await ownerClient.disconnect();
  }
}

function cleanupDropFailedText(cleanup) {
  return `The drop of the reader failed too: ${sqlErrorText(cleanup.error)}.`;
}

// A refused drop always says the same three things: why the proof failed,
// that the secret stays in the store, and the one statement an administrator
// can run by hand when they KNOW the user is theirs (critic S-A: a failed
// proof never costs the owner their record).
function refuseDropText(readerName, why, connection) {
  return `osd hana: refusing to drop ${readerName}: ${why}.\n` +
    `  The stored secret stays in the store -- it costs nothing and it is removed the moment a drop is allowed.\n` +
    `  If you are sure the user ${readerName} on ${connection.host}:${connection.port}` +
    `${connection.database ? `/${connection.database}` : ""} is yours to remove, run this one statement by hand, ` +
    `as a database administrator:\n` +
    `  DROP USER ${readerName} CASCADE`;
}

// --------------------------------------------------------------- drop path

/** Drop the reader: prove ownership, DROP USER <name> CASCADE, prove
 *  absence, remove the stored secret. The guards and proofs, in order, and
 *  each before anything is sent (critics M-2, S-A):
 *
 *  1. the name must match ^OSD_[A-Z0-9_]{1,26}$ -- a name that is not ours
 *     never reaches DROP USER;
 *  2. the name must not BE the login this run is connected as -- the current
 *     login is necessarily in SYS.USERS, so dropping it would drop the
 *     administrator itself;
 *  3. the secret store must hold an entry for exactly this host + port +
 *     database + name -- the record --create-reader wrote. Otherwise the tool
 *     refuses and prints the one SQL line an administrator can run by hand.
 *     There is deliberately no force flag;
 *  4. the stored password must log on AS THE READER to this host/port/
 *     database (proof the user is the one this store created) and the system
 *     identity recorded at create time must match SYS.M_DATABASE now --
 *     host + port + database is an address, not an identity. An entry that
 *     carries NO identity (written before identities were recorded) is
 *     refused with the hand-run line: the logon proof alone says the
 *     password works on whatever now answers this address, not that it is
 *     the same system the entry was written on (critic round-2 NOTE-1).
 *     A failed proof refuses, prints the hand-run line and KEEPS the secret;
 *  5. then consent, the DROP with the administrator login, the absence proof,
 *     and the store entry goes.
 *
 *  A 332 from the DROP means the user was already absent -- still prove it,
 *  still remove the secret, and say so. */
export async function dropReader({
  connection,
  readerName = DEFAULT_READER_NAME,
  yes = false,
  isTTY = false,
  store,
  clientFactory = hdbClientFactory(),
  prompt,
  say = () => {},
  encrypt = false,
  trustServerCertificate = false,
  ca = undefined,
  tlsServerName = undefined,
} = {}) {
  validateReaderName(readerName);
  if (readerName === String(connection.user).toUpperCase()) {
    throw new ReaderError(`osd hana: refusing to drop ${readerName}: that is the login this run is connected as ` +
      `(it is necessarily in SYS.USERS) -- dropping it would drop the administrator itself. Nothing was sent.`);
  }
  const key = readerStoreKey(connection, readerName);
  const stored = store.get(key);
  const ours = stored !== undefined
    && stored.user === readerName
    && stored.host === connection.host
    && Number(stored.port) === Number(connection.port)
    && (stored.database ?? "") === (connection.database ?? "");
  if (!ours) {
    throw new ReaderError(`osd hana: refusing to drop ${readerName}: the secret store holds no entry for this ` +
      `host, port and database -- this tool did not create a reader here, and it never drops a user it does not ` +
      `own. If a reader ${readerName} really exists on ${connection.host}${connection.database ? `, database ${connection.database}` : ""} ` +
      `and you are sure it is yours to remove, run this one statement by hand, as a database administrator:\n` +
      `  DROP USER ${readerName} CASCADE`);
  }

  // Driver texts here pass through a redactor holding both passwords of this
  // run (critic note) -- the same one-line assumption retirement as create.
  const redact = makeRedactor([stored.password, connection.password]);

  // Ownership proof, part 1 (critic S-A): log on AS THE READER with the
  // stored password, to this exact host/port/database. Success proves a user
  // of this name with this password lives on the system the entry was
  // written for; failure means this tool cannot prove the user is the one
  // its store created, and it must not drop it.
  let proofClient;
  try {
    proofClient = await clientFactory(hdbConnectionOptions(connection, {user: readerName, password: stored.password, encrypt, trustServerCertificate, ca, tlsServerName}));
    await proofClient.exec(`SELECT 1 AS ONE FROM DUMMY`);
  } catch (error) {
    throw new ReaderError(refuseDropText(readerName,
      `the stored password did not log on as ${readerName} on this host, port and database ` +
      `(${redact(sqlErrorText(error))}) -- whatever user carries this name here, this tool cannot prove it is the one its store created`,
      connection));
  } finally {
    if (proofClient !== undefined) await proofClient.disconnect();
  }

  const lines = [
    `osd hana: about to drop the dedicated reader ${readerName} (DROP USER ${readerName} CASCADE),`,
    `  prove its absence in SYS.USERS, and remove its stored secret`,
    `  from ${store.location(readerName)}.`,
    `  The stored password just logged on as ${readerName} on this host, port and database -- the user`,
    `  is the one this tool's store created. The system identity recorded at create time will be`,
    `  compared before the DROP, and the DROP itself runs with the administrator login.`,
    ...transportLines({
      encrypt, trustServerCertificate, host: connection.host, port: connection.port,
      secret: "the administrator's password and these statements travel",
    }),
  ].join("\n");
  say(lines);
  await askConsent({yes, isTTY, prompt});

  const client = await clientFactory(hdbConnectionOptions(connection, {user: connection.user, password: connection.password, encrypt, trustServerCertificate, ca, tlsServerName}));
  try {
    // Ownership proof, part 2 (critic S-A): the installation identity recorded
    // at create time must match what the catalogue says now -- a matching
    // host + port + database triple is NOT an identity (every HXE container
    // is localhost:39017/HXE; a tunnel puts any system behind localhost:<port>).
    // An entry without an identity (legacy, written before identities were
    // recorded) is refused here, not dropped on the logon proof alone: the
    // logon proves the PASSWORD works on whatever answers, not that the
    // system is the one the entry was written for (critic round-2 NOTE-1).
    if (stored.system_identity === undefined) {
      throw new ReaderError(refuseDropText(readerName,
        `the stored entry carries no system identity -- it was written before this tool recorded one, so it ` +
        `cannot be proved to belong to the system now answering ${connection.host}:${connection.port}` +
        `${connection.database ? `/${connection.database}` : ""} (the reader logon alone proves the password, ` +
        `not the system)`, connection));
    }
    let now;
    try {
      now = await readSystemIdentity(client);
    } catch (error) {
      throw new ReaderError(refuseDropText(readerName,
        `the system's identity could not be read from SYS.M_DATABASE (${redact(sqlErrorText(error))}), ` +
        `so it cannot be compared with the one recorded at create time`, connection));
    }
    if (!sameSystemIdentity(now, stored.system_identity)) {
      throw new ReaderError(refuseDropText(readerName,
        `the system now answering identifies as ${now.system_id}/${now.database_name}, but the entry was ` +
        `written on ${stored.system_identity.system_id}/${stored.system_identity.database_name} -- the same ` +
        `address now leads to a different system`, connection));
    }
    let alreadyAbsent = false;
    try {
      await client.exec(`DROP USER ${readerName} CASCADE`);
      say(`osd hana: ${readerName} dropped.`);
    } catch (error) {
      if (errorCode(error) !== 332) throw error;
      alreadyAbsent = true;
      say(`osd hana: ${readerName} was already absent (HANA said 332, invalid user name).`);
    }
    const remaining = await countUsersNamed(client, readerName);
    if (remaining !== 0) throw new ReaderError(`osd hana: ${readerName} still exists (SYS.USERS has ${remaining} row(s)) -- the drop did not take effect`);
    if (!alreadyAbsent) say(`osd hana: absence proved -- SYS.USERS has no row for ${readerName}.`);
    store.delete(key);
    say(`osd hana: the stored secret was removed from ${store.location(readerName)}.`);
    return {dropped: !alreadyAbsent, absent: true};
  } finally {
    await client.disconnect();
  }
}
