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

const READER_NAME_PATTERN = /^[A-Z][A-Z0-9_]{0,30}$/;
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
      `${flag} must match ^[A-Z][A-Z0-9_]{0,30}$ (capital letter first, then capitals, digits, underscore). ` +
      `The name is sent UNQUOTED into CREATE USER, so anything else is not a name but an injection.`);
  }
  return name;
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

export function describe258OnCreate(login) {
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

export function describe258OnGrant(schema, owner) {
  return [
    `osd hana: this login may not grant the schema (HANA error 258, insufficient privilege).`,
    `  The reader was created and is now dropped again; nothing was left behind.`,
    `  The login that CAN grant SELECT on schema ${schema} is its owner${owner ? `: ${owner}` : " (the owner lookup did not answer -- it is the user named like the schema on a classic ABAP stack)"}.`,
    `  Run 'osd hana doctor --create-reader' with that login, or go on read-only with the present login.`,
  ].join("\n");
}

/** Create the reader, end to end. `clientFactory(options)` opens an hdb
 *  connection (the seam the tests inject a fake into). Returns the stored
 *  secret for the caller to mention. Throws ReaderError with a person-shaped
 *  message on every refusal; on any failure after CREATE the user is dropped
 *  again first. */
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

  const adminClient = await clientFactory({
    host: connection.host, port: connection.port, user: connection.user,
    password: connection.password,
    ...(connection.database ? {databaseName: connection.database} : {}),
  });
  return runCreatePlan({adminClient, connection, readerName, schema, password, store, clientFactory, say});
}

async function runCreatePlan({adminClient, connection, readerName, schema, password, store, clientFactory, say}) {
  try {
    // 1. CREATE USER ... -- the one statement with the password on the wire.
    await adminClient.exec(`CREATE USER ${readerName} PASSWORD ${quotePasswordLiteral(password)} NO FORCE_FIRST_PASSWORD_CHANGE`);

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
        proofClient = await clientFactory({
          host: connection.host, port: connection.port, user: readerName,
          password: readerPassword,
        });
        const {rows} = await proofClient.exec(`SELECT COUNT(*) AS N FROM ${quoteIdentifier(schema)}.${quoteIdentifier("TADIR")}`, []);
        say(`osd hana: the reader ${readerName} connected and read ${rows[0]?.N ?? "?"} rows of ${schema}."TADIR" -- proof it works.`);
      } finally {
        if (proofClient !== undefined) await proofClient.disconnect();
      }

      // 5. Store the reader's credentials.
      store.set({user: readerName, password, schema}, readerName);
      say(`osd hana: the reader's credentials are stored in ${store.location(readerName)}.`);
      return {user: readerName, password, schema};
    } catch (error) {
      // The catch-all cleanup: the user exists, the setup did not finish.
      // (A ReaderError has already done its own cleanup and carries its own
      // message -- dropping again would only bury the cause under a 332.)
      if (error instanceof ReaderError) throw error;
      const cleanup = await dropUserQuietly(adminClient, readerName);
      if (error instanceof ReaderError) throw error;
      const causedBy = sqlErrorText(error);
      const note = cleanup.dropped
        ? `The reader ${readerName} was dropped again; nothing was left behind.`
        : cleanup.absent
          ? `The reader ${readerName} is absent (HANA said 332, invalid user name -- that is "user absent", not the cause).`
          : `${cleanupDropFailedText(cleanup)} Remove it by hand: DROP USER ${readerName} CASCADE.`;
      throw new ReaderError(`osd hana: setting up the reader failed -- ${causedBy}\n  ${note}`);
    }
  } catch (error) {
    if (error instanceof ReaderError) throw error;
    if (errorCode(error) === 258) {
      throw new ReaderError(describe258OnCreate());
    }
    // The CREATE itself failed -- usually no user exists. Prove it anyway
    // (E1: a leftover reader is dropped before every cycle), and when the
    // drop answers 332, that is "user absent", never the cause.
    const cleanup = await dropUserQuietly(adminClient, readerName);
    const cause = sqlErrorText(error);
    const note = cleanup.dropped
      ? `A reader ${readerName} existed anyway; it was dropped now.`
      : cleanup.absent
        ? `The reader ${readerName} is absent (HANA said 332, invalid user name -- that is "user absent", not the cause).`
        : cleanupDropFailedText(cleanup);
    throw new ReaderError(`osd hana: setting up the reader failed -- ${cause}\n  ${note}`);
  } finally {
    await adminClient.disconnect();
  }
}

function cleanupDropFailedText(cleanup) {
  return `The drop of the reader failed too: ${sqlErrorText(cleanup.error)}.`;
}

// --------------------------------------------------------------- drop path

/** Drop the reader: DROP USER <name> CASCADE, prove absence, remove the
 *  stored secret. A 332 from the DROP means the user was already absent --
 *  still prove it, still remove the secret, and say so. */
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
  const lines = [
    `osd hana: about to drop the dedicated reader ${readerName} (DROP USER ${readerName} CASCADE),`,
    `  prove its absence in SYS.USERS, and remove its stored secret`,
    `  from ${store.location(readerName)}.`,
  ].join("\n");
  say(lines);
  await askConsent({yes, isTTY, prompt});

  const client = await clientFactory({
    host: connection.host, port: connection.port, user: connection.user, password: connection.password,
  });
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
    store.delete(readerName);
    say(`osd hana: the stored secret was removed from ${store.location(readerName)}.`);
    return {dropped: !alreadyAbsent, absent: true};
  } finally {
    await client.disconnect();
  }
}
