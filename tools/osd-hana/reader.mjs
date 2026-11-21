// The dedicated read-only database user: `osd hana doctor --create-reader` /
// `--drop-reader`. This is the ONLY module family that sends a statement that
// is not a SELECT, and it goes through the Node driver `hdb` directly --
// never through the sidecar, which is read-only by construction and whose
// statement gate refuses anything but SELECT (contract W0).
//
// This file holds the ONE statement source of the create flow (the plan and
// the consent screen), the doctor-facing refusal builders, the schema-owner
// lookup and the drop path. The shared kernel (validation, quoting, the hdb
// options, the error helpers, the small catalogue reads) lives in
// reader-shared.mjs; the create execution (createReader / runCreatePlan) in
// reader-run.mjs. The split honours the 1000-line budget (critic NOTE-6:
// "the next change must split it") -- every public name of the old
// reader.mjs is still exported HERE, so the doctor, the tests and the
// probes import from this module unchanged.
import {makeRedactor} from "./redact.mjs";
import {
  ReaderError,
  askConsent, countUsersNamed, errorCode, hdbClientFactory, hdbConnectionOptions,
  lookupSchemaOwner, readSystemIdentity, readerStoreKey, sameSystemIdentity,
  show, sqlErrorText, transportLines, validateReaderName,
} from "./reader-shared.mjs";
import {
  DEFAULT_READER_NAME, READER_PASSWORD_MASK,
  createReader, describe258OnCreate, describe258OnGrant, describe412OnCreate, describeNameTaken,
} from "./reader-run.mjs";

// ---------------------------------------------------------------- re-exports
// The public surface is unchanged: everything reader.mjs always exported is
// still exported from here (the kernel and the create path re-exported).

export {DEFAULT_READER_NAME, READER_PASSWORD_MASK};
export {createReader, describe258OnCreate, describe258OnGrant, describe412OnCreate, describeNameTaken};
export {
  ConsentRefused, ReaderError,
  askConsent, consentText, createPlan, generateReaderPassword, hdbClientFactory, quoteIdentifier,
  quotePasswordLiteral, readerStoreKey, show, sqlErrorText, transportLines,
  validateReaderName, validateSchemaName,
} from "./reader-shared.mjs";

// ------------------------------------------------- the doctor-facing refusals

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
