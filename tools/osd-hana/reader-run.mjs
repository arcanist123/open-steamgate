// The create path of the dedicated read-only database user:
// `osd hana doctor --create-reader` -- the ONE code that sends a statement
// that is not a SELECT, through the Node driver `hdb` directly -- never
// through the sidecar, which is read-only by construction and whose statement
// gate refuses anything but SELECT (contract W0). Split out of reader.mjs
// when the file reached the 1000-line budget (critic NOTE-6: "the next
// change must split it"); the shared kernel lives in reader-shared.mjs, the
// drop path and the doctor-facing message builders stay in reader.mjs.
//
// 258 on CREATE USER = this login may not create users (two ways on);
// 258 on GRANT        = this login may not grant the schema (the owner can).
//
// Every failure after CREATE USER succeeded drops the user again and says
// what happened: the module must not leave a half-set-up reader behind.
import {makeRedactor} from "./redact.mjs";
import {
  DEFAULT_READER_NAME, READER_PASSWORD_MASK, ReaderError,
  askConsent, consentText, countUsersNamed, createPlan, dropUserQuietly,
  errorCode, generateReaderPassword, hdbClientFactory, hdbConnectionOptions,
  lookupSchemaOwner, readSystemIdentity, readerStoreKey, show, sqlErrorText,
  transportLines, validateReaderName, validateSchemaName,
} from "./reader-shared.mjs";

export {DEFAULT_READER_NAME, READER_PASSWORD_MASK};

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

/** The one-login 258-on-GRANT message. `cleanupFailedNote` is "" when the
 *  cleanup DROP succeeded (the "nothing was left behind" sentence is then
 *  true); when the drop FAILED, the caller passes a note that says so --
 *  with a line break and the hand-run SQL line -- and the false claim is
 *  never printed (critic NOTE-1 / probe P3). */
export function describe258OnGrant(schema, owner, cleanupFailedNote = "") {
  return [
    `osd hana: this login may not grant the schema (HANA error 258, insufficient privilege).`,
    cleanupFailedNote === ""
      ? `  The reader was created and is now dropped again; nothing was left behind.`
      : cleanupFailedNote,
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
 *  the secret is stored -- OUTSIDE the cleanup scope, so a throwing hook can
 *  never drop the proven reader nor orphan its stored secret (critic S-5):
 *  the hook's error propagates to the caller unchanged (the doctor catches
 *  its own hook's errors; any other caller owns its hook). Throws
 *  ReaderError with a person-shaped message on every refusal; on any failure
 *  after CREATE the user is dropped again by the ADMINISTRATOR connection --
 *  the only one that can -- and the message names which login failed at
 *  which statement. */
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
  let storedAt; // set at store time (inside the guarded region), read after the hook -- see step 6/7
  // The ADMINISTRATOR login runs CREATE / ALTER / CATALOG READ; the SCHEMA
  // OWNER login runs the GRANT SELECT. The administrator connection is also
  // the ONLY one that can drop the reader again -- every cleanup below goes
  // through it, whoever failed.
  const adminLogin = logins.admin;
  const ownerLogin = logins.owner;
  const grantSelect = plan.find((p) => p.role === "owner");
  const readerProofs = plan.filter((p) => p.role === "reader");
  const proofSelect = readerProofs[0];
  const proofWrite = readerProofs[1];
  let adminClient;
  try {
    adminClient = await clientFactory(hdbConnectionOptions(connection,
      {user: adminLogin.user, password: adminLogin.password, encrypt, trustServerCertificate, ca, tlsServerName}));
  } catch (error) {
    // The ADMINISTRATOR login's logon failure names that login (critic S-4):
    // before this, the raw driver error escaped to the caller's top level,
    // which redacted only the PRESENT login's password and did not say which
    // login had failed. The driver's code is PRESERVED -- a logon/connect
    // failure stays a cannot-connect error for the caller (exit 2, the IP
    // SANs explanation still fires), it just says which login it was now.
    // CREATE has not run yet: nothing to clean up.
    throw Object.assign(new Error(`osd hana: the administrator login ${adminLogin.user} failed to log on -- ${redact(sqlErrorText(error))}\n` +
      `  The CREATE USER had not run yet: nothing was created and nothing needs cleaning up.`), {code: error.code});
  }
  let ownerClient;
  // Best-effort cleanup by the administrator connection: a 332 means the
  // user is absent (the consequence of a failed create) -- that is success
  // for a cleanup, not an error. (critic NOTE-7: the same rules as
  // dropUserQuietly, so there is ONE implementation -- this closure binds
  // the administrator client, the one connection that can drop.)
  const dropAgain = () => dropUserQuietly(adminClient, readerName);
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
            // The "nothing was left behind" sentence is printed only when it
            // is true (critic NOTE-1 / probe P3: a failed cleanup DROP used
            // to be glued on after the false claim, with no line break and
            // no hand-run SQL line).
            const cleanupFailedNote = cleanup.dropped
              ? ""
              : cleanup.absent
                ? "\n  The reader was created and the cleanup drop found nothing to remove (HANA said 332) -- the reader is gone."
                : `\n  ${redact(cleanupDropFailedText(cleanup))}\n  Remove it by hand: DROP USER ${readerName} CASCADE.`;
            throw new ReaderError(describe258OnGrant(schema, owner, cleanupFailedNote));
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
        const {rows} = await proofClient.exec(proofSelect.real, []);
        say(`osd hana: the reader ${readerName} connected and read ${rows[0]?.N ?? "?"} rows of ${show(schema)}."TADIR" -- proof it works.`);
        let refusedText;
        try {
          await proofClient.exec(proofWrite.real, []);
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
            `    ${proofWrite.sql}\n` +
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
              `    ${proofWrite.sql}\n` +
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
      storedAt = new Date().toISOString();
      store.set(
        {user: readerName, password, schema, host: connection.host, port: connection.port,
          database: connection.database, stored_at: storedAt, system_identity: systemIdentity,
          catalog_read: catalogRead},
        readerStoreKey(connection, readerName));
      say(`osd hana: the reader's credentials are stored in ${store.location(readerName)}.`);
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

    // 7. The doctor's hook (the sidecar's probe run AS THE READER) runs
    // OUTSIDE the cleanup scope, AFTER the proofs and the store (critic
    // S-5): at this point the reader is proven and its secret is stored --
    // a consistent pair -- and a throwing hook can never turn that pair
    // into "a stored secret for a dropped reader" (the old bug: the hook
    // sat inside the cleanup try, so its throw triggered the catch-all,
    // which dropped the reader and left the secret behind). The hook's
    // failure propagates to the caller unchanged; the doctor catches its
    // own hook's errors, and any OTHER caller of createReader owns its
    // hook -- this module guarantees only that the hook is called at a
    // consistent point, never that a proven reader is dropped for it.
    if (onCreated !== undefined) {
      await onCreated({user: readerName, password, schema, catalogRead});
    }
    return {user: readerName, schema, storedAt};
  } finally {
    if (adminClient !== undefined) await adminClient.disconnect();
    if (ownerClient !== undefined) await ownerClient.disconnect();
  }
}

function cleanupDropFailedText(cleanup) {
  return `The drop of the reader failed too: ${sqlErrorText(cleanup.error)}.`;
}
