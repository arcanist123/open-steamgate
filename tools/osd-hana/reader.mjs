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
function hdbConnectionOptions(connection, {user, password}) {
  return {
    host: connection.host,
    port: connection.port,
    user,
    password,
    ...(connection.database ? {databaseName: connection.database} : {}),
  };
}

// HANA driver errors carry a `code` (the native error number, e.g. 258, 332).
function errorCode(error) {
  return error?.code ?? error?.dbCode ?? undefined;
}

export function sqlErrorText(error) {
  return `${errorCode(error) !== undefined ? `${errorCode(error)} ` : ""}${error?.message ?? String(error)}`;
}

const MASKED = "***reader-password***";

export function planStatements({readerName, schema, password}) {
  // The plan shown for consent. The real password goes into the statement
  // only at execution time; the plan shows the mask.
  return [
    {
      sql: `CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(MASKED)} NO FORCE_FIRST_PASSWORD_CHANGE`,
      real: `CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(password)} NO FORCE_FIRST_PASSWORD_CHANGE`,
      why: "create the dedicated reader (no forced password change: nobody will ever type it)",
    },
    {
      sql: `ALTER USER ${readerName} DISABLE PASSWORD LIFETIME`,
      real: `ALTER USER ${readerName} DISABLE PASSWORD LIFETIME`,
      why: "the password must not expire while the extraction runs",
    },
    {
      sql: `GRANT SELECT ON SCHEMA ${quoteIdentifier(schema)} TO ${readerName}`,
      real: `GRANT SELECT ON SCHEMA ${quoteIdentifier(schema)} TO ${readerName}`,
      why: "read access to the ABAP schema, nothing else",
    },
  ];
}

export function consentText({readerName, schema, planLines, store}) {
  return [
    `osd hana: about to create the dedicated read-only database user ${readerName}`,
    `  and grant it SELECT on schema ${schema}. The exact statements:`,
    "",
    ...planLines.map((line) => `    ${line.sql}   -- ${line.why}`),
    "",
    `  (the password is generated, 28 characters, never printed; it will be stored in`,
    `   ${store.location(readerName)})`,
    "",
    `  Your login will be used for these statements only; the password you gave is not stored.`,
  ].join("\n");
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

async function countUsersNamed(client, name) {
  const {rows} = await client.exec(`SELECT COUNT(*) AS N FROM SYS.USERS WHERE USER_NAME = ?`, [name]);
  return Number(rows[0]?.N ?? 0);
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

export function describe258OnGrant(schema, owner) {
  return [
    `osd hana: this login may not grant the schema (HANA error 258, insufficient privilege).`,
    `  The reader was created and is now dropped again; nothing was left behind.`,
    `  The login that CAN grant SELECT on schema ${schema} is its owner${owner ? `: ${owner}` : " (the owner lookup did not answer -- it is the user named like the schema on a classic ABAP stack)"}.`,
    `  Run 'osd hana doctor --create-reader' with that login, or go on read-only with the present login.`,
  ].join("\n");
}

/** Create the reader, end to end. `clientFactory(options)` opens an hdb
 *  connection (the seam the tests inject a fake into). Returns
 *  {user, schema, storedAt} -- the generated password is NOT part of it: the
 *  secret store is its only holder (critic M-A). Throws ReaderError with a
 *  person-shaped message on every refusal; on any failure after CREATE the
 *  user is dropped again first. */
export async function createReader({
  connection,        // {host, port, user, password, database?} of the ADMINISTRATOR login
  schema,
  readerName = DEFAULT_READER_NAME,
  yes = false,
  isTTY = false,
  store,
  clientFactory = hdbClientFactory(),
  prompt,
  say = () => {},
  generatePassword = generateReaderPassword,
} = {}) {
  validateReaderName(readerName);
  if (!schema || typeof schema !== "string") throw new ReaderError("osd hana: --create-reader needs the ABAP schema (--schema, or found by the probe)");
  const password = generatePassword();
  const plan = planStatements({readerName, schema, password});
  say(consentText({readerName, schema, planLines: plan, store}));
  await askConsent({yes, isTTY, prompt});

  const adminClient = await clientFactory(hdbConnectionOptions(connection, {user: connection.user, password: connection.password}));
  return runCreatePlan({adminClient, connection, readerName, schema, password, store, clientFactory, say});
}

async function runCreatePlan({adminClient, connection, readerName, schema, password, store, clientFactory, say}) {
  try {
    // 0. Existence guard (critic M-B): a user that already exists -- ours
    // from an earlier run and maybe in use by a running extract, or somebody
    // else's -- is never CREATEd over and never dropped: the create path may
    // drop ONLY a user its own CREATE USER created in this very run.
    let existing;
    try {
      existing = await countUsersNamed(adminClient, readerName);
    } catch (error) {
      throw new ReaderError(`osd hana: could not check whether ${readerName} already exists -- ${sqlErrorText(error)}\n` +
        `  Refusing to run CREATE USER without that check: the tool may not create over a user it did not verify, ` +
        `and it never removes a user this run did not create.`);
    }
    if (existing !== 0) {
      throw new ReaderError(describeNameTaken(readerName));
    }

    // 1. CREATE USER ... -- the one statement with the password on the wire.
    try {
      await adminClient.exec(`CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(password)} NO FORCE_FIRST_PASSWORD_CHANGE`);
    } catch (error) {
      // The CREATE itself failed -- 258 (no USER ADMIN), 331 (the name
      // existed after all: the guard raced), 412 (password policy), a
      // network error, anything: this run created nothing, so it may drop
      // NOTHING. Only failures AFTER a successful CREATE may drop (below).
      const code = errorCode(error);
      if (code === 258) throw new ReaderError(describe258OnCreate());
      if (code === 331) throw new ReaderError(describeNameTaken(readerName));
      if (code === 412) throw new ReaderError(describe412OnCreate());
      throw new ReaderError(`osd hana: setting up the reader failed -- ${sqlErrorText(error)}\n` +
        `  The CREATE USER itself failed: this run created nothing and removed nothing -- a user that may ` +
        `exist under this name is not this run's to touch.`);
    }

    // From here on any failure drops the user again.
    try {
      // 2. ALTER USER ... DISABLE PASSWORD LIFETIME
      await adminClient.exec(`ALTER USER ${readerName} DISABLE PASSWORD LIFETIME`);

      // 3. GRANT SELECT ON SCHEMA "<schema>" TO <reader>
      try {
        await adminClient.exec(`GRANT SELECT ON SCHEMA ${quoteIdentifier(schema)} TO ${readerName}`);
      } catch (error) {
        if (errorCode(error) === 258) {
          const owner = await lookupSchemaOwner(adminClient, schema);
          const cleanup = await dropUserQuietly(adminClient, readerName);
          throw new ReaderError(describe258OnGrant(schema, owner) + (cleanup.dropped || cleanup.absent ? "" : cleanupDropFailedText(cleanup)));
        }
        throw error;
      }

      // 4. Prove the reader works: connect as the reader, one SELECT.
      const readerPassword = password;
      let proofClient;
      try {
        proofClient = await clientFactory(hdbConnectionOptions(connection, {user: readerName, password: readerPassword}));
        const {rows} = await proofClient.exec(`SELECT COUNT(*) AS N FROM ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")}`, []);
        say(`osd hana: the reader ${readerName} connected and read ${rows[0]?.N ?? "?"} rows of ${schema}."TADIR" -- proof it works.`);
      } finally {
        if (proofClient !== undefined) await proofClient.disconnect();
      }

      // 5. Store the reader's credentials, keyed by this exact connection and
      // name -- --drop-reader demands the same key back before it will drop.
      // The entry is the password's only resting place: the return value of
      // this function deliberately carries none of it (critic M-A -- the
      // --json document must never hold it).
      const storedAt = new Date().toISOString();
      store.set(
        {user: readerName, password, schema, host: connection.host, port: connection.port,
          database: connection.database, stored_at: storedAt},
        readerStoreKey(connection, readerName));
      say(`osd hana: the reader's credentials are stored in ${store.location(readerName)}.`);
      return {user: readerName, schema, storedAt};
    } catch (error) {
      // The catch-all cleanup: the user exists, the setup did not finish.
      // (A ReaderError has already done its own cleanup and carries its own
      // message -- dropping again would only bury the cause under a 332.)
      if (error instanceof ReaderError) throw error;
      const cleanup = await dropUserQuietly(adminClient, readerName);
      const causedBy = sqlErrorText(error);
      const note = cleanup.dropped
        ? `The reader ${readerName} was dropped again; nothing was left behind.`
        : cleanup.absent
          ? `The reader ${readerName} is absent (HANA said 332, invalid user name -- that is "user absent", not the cause).`
          : `${cleanupDropFailedText(cleanup)} Remove it by hand: DROP USER ${readerName} CASCADE.`;
      throw new ReaderError(`osd hana: setting up the reader failed -- ${causedBy}\n  ${note}`);
    }
  } finally {
    await adminClient.disconnect();
  }
}

function cleanupDropFailedText(cleanup) {
  return `The drop of the reader failed too: ${sqlErrorText(cleanup.error)}.`;
}

// --------------------------------------------------------------- drop path

/** Drop the reader: DROP USER <name> CASCADE, prove absence, remove the
 *  stored secret. The guards, in order, and each before anything is sent
 *  (critic M-2):
 *
 *  1. the name must match ^OSD_[A-Z0-9_]{1,26}$ -- a name that is not ours
 *     never reaches DROP USER;
 *  2. the name must not BE the login this run is connected as -- the current
 *     login is necessarily in SYS.USERS, so dropping it would drop the
 *     administrator itself;
 *  3. the secret store must hold an entry for exactly this host + port +
 *     database + name -- the record --create-reader wrote. Otherwise the tool
 *     refuses and prints the one SQL line an administrator can run by hand.
 *     There is deliberately no force flag.
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
  const lines = [
    `osd hana: about to drop the dedicated reader ${readerName} (DROP USER ${readerName} CASCADE),`,
    `  prove its absence in SYS.USERS, and remove its stored secret`,
    `  from ${store.location(readerName)}.`,
    `  This is allowed because the secret store holds the entry this tool wrote for exactly`,
    `  this host, port and database -- the only user it will ever drop.`,
  ].join("\n");
  say(lines);
  await askConsent({yes, isTTY, prompt});

  const client = await clientFactory(hdbConnectionOptions(connection, {user: connection.user, password: connection.password}));
  try {
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
