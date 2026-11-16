// `osd hana doctor`: locate + verify + handshake the sidecar, take the
// connection from flags / env file / stdin / a hidden prompt, run the
// sidecar's `probe` (read-only, no names needed), and say the verdict plainly.
// Exit codes: 0 ready to extract, 1 usage or setup, 2 cannot connect / log on,
// 5 no ABAP schema readable by this login (or the sidecar could not examine
// the database -- the message says which). `--json` prints the same findings as one JSON
// document.
//
// The doctor never refuses a login because it is powerful (task B.3): the
// sidecar's sessions are READ ONLY at the database level, so extraction is
// safe with any login. When the login can write, the safety sentence is said
// exactly once, and a password that equals a public trial-image default is
// warned about loudly -- and nothing else changes.
//
// This module holds no SQL of its own except through ./reader.mjs (the only
// place a non-SELECT statement exists) and opens no listening socket (task
// B.5).
import {UsageError, parseFlags, collectConnection, promptHidden as defaultPromptHidden, promptVisible as defaultPromptVisible} from "./connect.mjs";
import {readFileSync} from "node:fs";
import {isPublicDefaultPassword, publicDefaultWarning} from "./defaults.mjs";
import {makeRedactor} from "./redact.mjs";
import {createReader, dropReader, ConsentRefused, ReaderError, hdbClientFactory, describeNeitherRole, lookupSchemaOwnerLogin} from "./reader.mjs";
import {defaultSecretStore} from "./secret-store.mjs";
import {Sidecar, HandshakeError, SidecarVerifyError, handshake, locateSidecar, loadPin, verifySidecar, resetVerifiedSidecars, DEFAULT_PIN_PATH} from "./sidecar.mjs";
import {plainVerdict, jsonVerdict, readerRoleFromProbe, ipSansExplanation} from "./verdict.mjs";
import {ownsAbapSchema, readProbe, saysNoAbapSchema} from "./probe-doc.mjs";
import {resolve} from "node:path";

export const DOCTOR_EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  connection: 2,
  noAbapSchema: 5,
});

const VALUE_FLAGS = ["host", "port", "database", "user", "schema", "env-file", "reader-name", "sidecar-pin", "ca-file", "tls-server-name", "owner-user", "admin-user"];
const BOOLEAN_FLAGS = ["password-stdin", "json", "create-reader", "drop-reader", "yes", "allow-unpinned-sidecar", "encrypt", "trust-server-certificate", "no-catalog-read", "help"];

const USAGE = `Usage: osd hana doctor [--host H] [--port P] [--database NAME] [--user U]
                        [--schema NAME] [--env-file <file>] [--password-stdin]
                        [--json] [--allow-unpinned-sidecar]
                        [--create-reader | --drop-reader [--reader-name NAME] [--yes]]
                        [--no-catalog-read] [--owner-user U | --admin-user U]
                        [--encrypt | --trust-server-certificate [--ca-file F] [--tls-server-name N]]

Checks a HANA database and says, plainly, whether your ABAP code can be
rescued out of it: reachable? tenant or system database? ABAP schema found?
release, clients, repository size; whether an ABAP server is still attached;
what kind of login this is and whether it can do more than read.

Connection: --host --port --database --user, or --env-file with keys
HANA_HOST, HANA_PORT, HANA_DATABASE, HANA_USER, HANA_PASSWORD, HANA_SCHEMA.
The password comes from --password-stdin, then HANA_PASSWORD in the env file,
then $OSD_HANA_PASSWORD, then a hidden prompt on a terminal. There is no
--password flag, by design: argv is visible to every user of the machine.

The sidecar binary osd-hana-dump is taken from OSD_HANA_DUMP (or the path the
caller hands in), verified against tools/osd-hana/sidecar.lock.json, and
hand-shaken before use. A binary outside the pin needs --allow-unpinned-sidecar.

--create-reader sets up a dedicated read-only database user (asks for
consent; --yes answers it non-interactively). The flow is guided by which
role the present login has: an administrator creates the user and the doctor
then asks for the SCHEMA OWNER's login (--owner-user; the catalogue suggests
the name; its password comes from $OSD_HANA_OWNER_PASSWORD or a hidden
prompt); the schema owner is asked for an ADMINISTRATOR login the same way
(--admin-user, $OSD_HANA_ADMIN_PASSWORD). One login that can do both does it
in one step; a login that can do neither gets an explanation and nothing is
sent. --no-catalog-read leaves GRANT CATALOG READ out (the reader then cannot
extract database procedures). --drop-reader removes the reader -- also when
the probe cannot succeed (a removed ABAP schema does not block a teardown).

TLS: with a sidecar that has the "tls" capability, --encrypt /
--trust-server-certificate / --ca-file / --tls-server-name are passed to the
sidecar as well; without the capability a TLS ask is refused -- the doctor
never connects in clear text when TLS was asked for. --ca-file and
--tls-server-name need --encrypt: TLS is one consistent set for BOTH
connections (the sidecar's and the reader path's).

The reader path talks to the database through the Node driver hdb. Without
--encrypt that connection is NOT encrypted and the new password travels in
clear text (the consent text says so): use a trusted network or --encrypt
(TLS with certificate validation, hdb's useTLS). --trust-server-certificate
encrypts without validating the server's certificate and says so loudly.
Exit codes: 0 ready to extract; 1 usage; 2 cannot connect or log on;
5 no ABAP schema readable by this login, or the database could not be examined.`;

export async function doctorMain(argv, {
  io = {out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`)},
  env = process.env,
  stdin = process.stdin,
  isTTY = Boolean(stdin?.isTTY),
  callerPath,
  store = defaultSecretStore(),
  clientFactory,
  prompt, // combined override of BOTH prompts below -- the test seam the injected-prompt tests use
  promptVisible, // a visible line question (login NAMES, consent): default is readline over stdin + stderr
  promptHidden, // the hidden password question (never echoes): default is connect.mjs's raw-mode prompt
  stderr = process.stderr, // the stream the default prompts write to and check isTTY on -- the doctor asks only when stdin AND stderr are a terminal (critic M-2)
  pinFile, // the TRUSTED seam for the embedding host / tests to name a pin file; the CLI flag --sidecar-pin is a public input and never 'pins' by itself (critic S-E)
  sidecarExtraEnv, // the test seam: extra child-env for the sidecar; the CLI never sets it
  sidecarTimeoutMs = 120_000,
} = {}) {
  resetVerifiedSidecars(); // one CLI run verifies once; a long-lived host re-verifies per run
  let flags;
  let parse;
  try {
    parse = parseFlags(argv, {valueFlags: VALUE_FLAGS, booleanFlags: BOOLEAN_FLAGS});
    flags = parse.flags;
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${error.message}\n\n${USAGE}`);
      return DOCTOR_EXIT.usage;
    }
    throw error;
  }
  const fail = (message) => {
    io.err(message);
    return DOCTOR_EXIT.usage;
  };
  // The TWO prompt seams of the guided flow (critic M-2), each with a
  // PRODUCTION default wired here -- in the real CLI no test injects anything,
  // and the doctor really asks: a VISIBLE line question for a login NAME (the
  // answer echoes), the HIDDEN prompt for a password (raw mode, nothing
  // echoed). One function for both used to mean the login name was typed
  // blind or the password echoed, depending on the seam; two functions, two
  // defaults, one rule. `prompt`, when a caller injects it, overrides both
  // (the test seam the older tests use). The defaults run over `stdin` and
  // `stderr`, and canPrompt checks the SAME two streams: the doctor asks only
  // when stdin AND stderr are a terminal -- what is checked is what would be
  // used.
  const promptVisibleFn = promptVisible ?? prompt ?? ((question) => defaultPromptVisible(question, {input: stdin, output: stderr}));
  const promptHiddenFn = promptHidden ?? prompt ?? ((question) => defaultPromptHidden(question, {input: stdin, output: stderr}));
  const canPrompt = isTTY === true && stderr?.isTTY === true;
  // critic round-2 NOTE-4: the unpinned/foreign-pin WARNING used to fire on
  // the initial verify AND again on every per-spawn re-verification -- the
  // same first line twice or more per run. Warn ONCE per run: a set of first
  // lines, local to this doctor run (not per process -- a long-lived host
  // runs many runs and each must warn its own once).
  const warned = new Set();
  const loudOnce = (line) => {
    const key = line.trimEnd().split("\n")[0];
    if (warned.has(key)) return;
    warned.add(key);
    io.err(line.trimEnd());
  };
  if (flags.help === true) {
    io.out(USAGE);
    return DOCTOR_EXIT.ok;
  }
  if (parse.rest.length > 0) {
    // `--double-dash` flags only: a bare `-host` or a stray word is refused,
    // never guessed at.
    return fail(`osd hana: unexpected positional argument(s): ${parse.rest.join(" ")} -- doctor takes --double-dash flags only`);
  }

  if (flags["create-reader"] === true && flags["drop-reader"] === true) {
    return fail("osd hana: --create-reader and --drop-reader cannot be used together");
  }

  // ---- TLS is ONE consistent set for BOTH transports (critic S-1) --------
  // --ca-file / --tls-server-name shape TLS for the sidecar's connection AND
  // for the reader path's hdb connection alike. Without --encrypt they would
  // mean TLS on one path while the other -- the one that carries the new
  // reader's password in CREATE USER -- goes out in clear text. Refused as a
  // usage error, before anything connects. (--trust-server-certificate alone
  // stays valid: it IS an encryption request, just without validation.)
  if ((flags["ca-file"] !== undefined || flags["tls-server-name"] !== undefined) && flags.encrypt !== true) {
    return fail(`osd hana: --ca-file and --tls-server-name need --encrypt -- these flags shape TLS for BOTH connections ` +
      `(the sidecar's and the reader path's), and encrypting one while the other carries the new password in clear ` +
      `text is not a thing this tool does.\n` +
      `  To encrypt with certificate validation: --encrypt, plus --ca-file / --tls-server-name as needed.\n` +
      `  To encrypt WITHOUT certificate validation: --trust-server-certificate alone (it says so loudly).`);
  }

  // ---- sidecar: locate, verify, handshake -------------------------------
  let path;
  try {
    path = locateSidecar({env, callerPath});
  } catch (error) {
    return fail(error.message);
  }
  let pin;
  let foreignPin = false;
  try {
    // Two ways to name a pin: `pinFile`, the trusted seam the embedding host
    // (the extension, the tests) uses to substitute its own pin; and the CLI
    // flag --sidecar-pin, a public input. A pin file that is not the
    // module's own sidecar.lock.json never makes a binary 'pinned' -- it can
    // check bytes, but every pinned claim stays false and the run needs
    // --allow-unpinned-sidecar (critic S-E).
    const pinPath = pinFile ?? flags["sidecar-pin"] ?? DEFAULT_PIN_PATH;
    pin = loadPin(pinPath);
    // pinFile is the embedding host's own substitution (the extension names
    // its bundled pin, the tests name a generated one): trusted. Only a
    // --sidecar-pin the CLI user supplied is 'foreign' (critic S-E).
    foreignPin = pinFile === undefined && resolve(pinPath) !== resolve(DEFAULT_PIN_PATH);
  } catch (error) {
    return fail(error.message);
  }
  let verified;
  try {
    verified = await verifySidecar(path, {
      pin,
      allowUnpinned: flags["allow-unpinned-sidecar"] === true,
      foreignPin,
      loud: loudOnce,
    });
  } catch (error) {
    return fail(error.message);
  }
  let handshakeInfo;
  try {
    handshakeInfo = await handshake(path, {requiredCapabilities: ["probe"], pin: verified.pinned ? pin : undefined, env, extraEnv: sidecarExtraEnv});
  } catch (error) {
    if (error instanceof HandshakeError) return fail(error.message);
    return fail(`osd-hana: the sidecar handshake could not run: ${error.message}`);
  }

  // ---- TLS (W0-contract "Additions") --------------------------------------
  // The sidecar advertises the `tls` capability; the reader path (hdb) has
  // its own TLS story. When the user asked for TLS and the pinned sidecar
  // cannot do it, the run REFUSES -- never a silent fall-back to clear text.
  const tlsCapability = Array.isArray(handshakeInfo.capabilities) && handshakeInfo.capabilities.includes("tls");
  const wantsTls = flags.encrypt === true || flags["trust-server-certificate"] === true
    || flags["ca-file"] !== undefined || flags["tls-server-name"] !== undefined;
  if (wantsTls && !tlsCapability) {
    return fail(`osd hana: this sidecar (${handshakeInfo.version ?? "unknown version"}) does not list the "tls" capability -- ` +
      `it cannot encrypt its connection, and you asked it to (--encrypt / --trust-server-certificate / --ca-file).\n` +
      `  Refusing: the doctor will NOT connect in clear text when TLS was asked for. Use a sidecar build with the ` +
      `tls capability (a newer pin), or re-run without the TLS flags on a network you trust.`);
  }
  // The TLS flags reach the sidecar's own connection as well (the probe and
  // every later run of this doctor ride the sidecar's session, not hdb's):
  // flags as the W0-contract "Additions" section defines them.
  const sidecarTlsArgs = [];
  if (tlsCapability) {
    if (flags.encrypt === true) sidecarTlsArgs.push("--encrypt");
    if (flags["trust-server-certificate"] === true) sidecarTlsArgs.push("--trust-server-certificate");
    if (flags["ca-file"] !== undefined) sidecarTlsArgs.push("--ca-file", flags["ca-file"]);
    if (flags["tls-server-name"] !== undefined) sidecarTlsArgs.push("--tls-server-name", flags["tls-server-name"]);
  }
  // The reader path's TLS (hdb), from the same flags -- critic S-1 / probe
  // P8: with --encrypt --ca-file the CA used to reach the sidecar but never
  // hdb, so a private CA failed closed on the reader path while the sidecar
  // verified. hdb's documented `ca` option carries the CA file's CONTENT
  // (hdb passes it to tls.connect); --tls-server-name becomes hdb's
  // `servername`. Read once, here, before anything connects.
  let caContent;
  if (flags.encrypt === true && flags["ca-file"] !== undefined) {
    try {
      caContent = readFileSync(flags["ca-file"], "utf8");
    } catch (error) {
      return fail(`osd hana: --ca-file: could not read ${flags["ca-file"]}: ${error.message}`);
    }
  }
  const tlsServerName = flags["tls-server-name"];

  // ---- connection --------------------------------------------------------
  let connection;
  try {
    connection = await collectConnection({flags, env, stdin, isTTY, prompt: promptHiddenFn});
  } catch (error) {
    if (error instanceof UsageError) return fail(`osd hana: ${error.message.replace(/^osd hana: /, "")}`);
    return fail(`osd hana: taking the password failed: ${error.message}`);
  }

  const warnings = [];
  if (isPublicDefaultPassword(connection.password)) {
    const warning = publicDefaultWarning();
    io.err(warning);
    warnings.push("the password is a public default of a HANA trial image -- change it (ALTER USER ...); the doctor changed nothing");
  }

  // ---- probe --------------------------------------------------------------
  const sidecar = new Sidecar(path, {
    credentials: {user: connection.user, password: connection.password, host: connection.host, schema: connection.schema},
    timeoutMs: sidecarTimeoutMs,
    onStderr: (text) => io.err(text.trimEnd()),
    env,
    extraEnv: sidecarExtraEnv,
    // A pin in play means every spawn re-verifies the bytes first (fresh,
    // uncached -- Sidecar's default): after the initial verify the doctor may
    // sit at a password prompt for minutes, and a swap in that window must
    // not run unaudited bytes under the cached verdict (critic S-3). The
    // binary is ~7 MB; a fresh sha256 read is milliseconds.
    pin,
    allowUnpinned: flags["allow-unpinned-sidecar"] === true,
    foreignPin,
    loud: loudOnce,
  });
  // The user and the password are credentials and travel in the child's
  // environment only (contract W0). Host, port, tenant database and an
  // explicitly chosen ABAP schema are not credentials: they are the probe's
  // connection flags.
  const probeArgs = ["--host", connection.host, "--port", String(connection.port)];
  if (connection.database !== undefined) probeArgs.push("--database", connection.database);
  if (connection.schema !== undefined) probeArgs.push("--abap-schema", connection.schema);
  probeArgs.push(...sidecarTlsArgs);
  let readerProbeDocument; // the sidecar's probe answer, when run AS THE READER (create path)

  const finishReader = async (verb) => {
    // --create-reader grants on an ABAP schema, so it needs one: from --schema
    // or, when the probe found exactly one, that one. --drop-reader needs NO
    // schema at all (round-2 NOTE-5: tearing a reader down after the ABAP
    // schema was removed is exactly when --drop-reader is wanted) -- and it
    // runs BEFORE the probe (below), because it must not be gated behind a
    // successful probe of the main login either: the drop path proves
    // ownership through the secret store and the reader logon, not through
    // the probe.
    const schemaName = verb === "create-reader"
      ? (flags.schema ?? (schemas.length === 1 ? schemas[0].name : undefined))
      : flags.schema;
    if (verb === "create-reader" && flags.schema === undefined && schemaName === undefined) {
      io.err(`osd hana: --${verb} needs to know the ABAP schema -- pass --schema (the probe found ${schemas.length} schemas).`);
      return DOCTOR_EXIT.usage;
    }
    const readerName = flags["reader-name"] ?? "OSD_READER";
    // Declared here, not inside the try: the catch below must know which
    // logins were in play (critic S-4 -- the redactor covers the second
    // login's password too, and the message says which logins were used).
    let role = "both";
    let secondLogin;
    try {
      if (verb === "create-reader") {
        // The guided TWO-LOGIN flow: which role the present login has, the
        // doctor works out from the probe (task item 1). "neither" explains
        // what is needed and sends nothing; the other single-role cases ask
        // for the login holding the other role, from the catalogue-suggested
        // owner name / the flags / a hidden prompt, with the password from
        // OSD_HANA_OWNER_PASSWORD / OSD_HANA_ADMIN_PASSWORD (there is
        // deliberately no --owner-password-stdin: non-interactive use names
        // the login with the flag and brings the password through the env).
        role = readerRoleFromProbe(probe);
        if (role === "unknown") {
          // the sidecar could not read the system privileges: ask, never assume
          role = await askAdministratorRole({owns: ownsAbapSchema(probe), flags, canPrompt, promptVisible: promptVisibleFn});
        }
        if (role === "neither") {
          io.err(describeNeitherRole(schemaName));
          return DOCTOR_EXIT.usage;
        }
        if (role === "admin" || role === "owner") {
          let suggest;
          if (role === "admin") {
            // the owner's name, shown from the catalogue as a suggestion
            // (informational: a failed lookup yields no suggestion)
            try {
              suggest = await lookupSchemaOwnerLogin({connection, schema: schemaName,
                user: connection.user, password: connection.password,
                clientFactory: clientFactory ?? hdbClientFactory(),
                encrypt: flags.encrypt === true, trustServerCertificate: flags["trust-server-certificate"] === true,
                ca: caContent, tlsServerName});
            } catch {
              suggest = undefined;
            }
          }
          secondLogin = await collectSecondLogin({role, flags, env, canPrompt, promptVisible: promptVisibleFn, promptHidden: promptHiddenFn, suggest});
        }
      }
      const catalogRead = flags["no-catalog-read"] !== true;
      const result = verb === "create-reader"
        ? await createReader({connection, schema: schemaName, readerName, yes: flags.yes === true, isTTY, store,
            clientFactory: clientFactory ?? hdbClientFactory(), prompt: promptVisibleFn,
            encrypt: flags.encrypt === true, trustServerCertificate: flags["trust-server-certificate"] === true,
            ca: caContent, tlsServerName,
            role, secondLogin, catalogRead,
            say: (text) => io.out(text),
            // the sidecar's probe, run AS THE READER (task item 3): shown as
            // the reader's own verdict; a failure here is reported, never a
            // drop -- the reader was already proven by a real connection
            onCreated: async ({user, password}) => {
              try {
                const readerSidecar = new Sidecar(path, {
                  credentials: {user, password, host: connection.host, schema: connection.schema},
                  timeoutMs: sidecarTimeoutMs,
                  onStderr: (text) => io.err(text.trimEnd()),
                  env,
                  extraEnv: sidecarExtraEnv,
                  pin,
                  allowUnpinned: flags["allow-unpinned-sidecar"] === true,
                  foreignPin,
                  loud: loudOnce,
                });
                const run = await readerSidecar.run("probe", {args: probeArgs});
                readerProbeDocument = run.summary;
                const view = {host: connection.host, port: connection.port, database: connection.database, user};
                io.out(`osd hana: the reader's own probe -- the sidecar run as ${user}:`);
                for (const line of plainVerdict(readerProbeDocument, {connection: view, sidecar: describeSidecar(verified, handshakeInfo)})) {
                  io.out(`  ${line}`);
                }
              } catch (error) {
                io.err(`osd hana: the reader's own probe could not run: ${error.message}`);
              }
            }})
        : await dropReader({connection, readerName, yes: flags.yes === true, isTTY, store,
            clientFactory: clientFactory ?? hdbClientFactory(), prompt: promptVisibleFn,
            encrypt: flags.encrypt === true, trustServerCertificate: flags["trust-server-certificate"] === true,
            ca: caContent, tlsServerName,
            say: (text) => io.out(text)});
      if (verb === "create-reader" && flags["no-catalog-read"] === true) {
        io.err(`osd hana: without GRANT CATALOG READ this reader CANNOT extract database procedures (AMDP) --\n` +
          `  the dump will report them as an error (the sidecar exits 3, "empty catalog"). Re-run\n` +
          `  --create-reader without --no-catalog-read to add the grant.`);
      }
      if (flags.json === true) {
        // the create result deliberately carries no password -- the secret
        // store is its only holder (critic M-A); --json reports the facts a
        // caller can act on and nothing that unlocks anything. For drop the
        // probe has NOT run (NOTE-5: the drop is not gated behind it), so
        // the document carries the drop facts without a probe verdict.
        io.out(JSON.stringify(verb === "create-reader"
          ? {
            ...jsonVerdict(probe, {connection, sidecar: describeSidecar(verified, handshakeInfo), warnings}),
            reader: {user: result.user, schema: result.schema, stored_at: result.storedAt},
            ...(readerProbeDocument !== undefined ? {reader_probe: readerProbeDocument} : {}),
          }
          : {
            command: "osd hana doctor",
            sidecar: describeSidecar(verified, handshakeInfo),
            connection: {
              host: connection.host, port: connection.port, database: connection.database,
              user: connection.user, schema: connection.schema,
            },
            reader: {dropped: result.dropped, absent: result.absent},
            warnings,
          }, null, 1));
      }
      return DOCTOR_EXIT.ok;
    } catch (error) {
      if (error instanceof ConsentRefused || error instanceof ReaderError) {
        io.err(error.message);
        return DOCTOR_EXIT.usage;
      }
      if (typeof error?.code === "number") {
        // The database refused: a connection or logon problem (hdb reports
        // native codes). The driver message is quoted -- through the redactor
        // holding EVERY password in play (critic S-4: the second login's
        // password too -- a driver text can repeat a value verbatim), because
        // a driver text can repeat a value verbatim.
        const redact = makeRedactor([connection.password, secondLogin?.password]);
        const text = redact(`osd hana: the database refused (${error.code}): ${error.message}`);
        io.err(text);
        // and the logins this run actually connected with are named (critic
        // S-4: a wrong $OSD_HANA_ADMIN_PASSWORD used to read as "the database
        // refused" with no hint that it was the second login)
        io.err(secondLogin !== undefined
          ? `  Logins this run connected with: ${connection.user} and the ${role === "admin" ? "schema-owner" : "administrator"} login ${secondLogin.user} -- the message above says which one the database refused.`
          : `  The login this run connected with: ${connection.user}.`);
        // the "no IP SANs" TLS failure, explained the same way as on the
        // sidecar's path (the hdb connection fails with the same fact)
        if (/IP SAN/i.test(text)) io.err(ipSansExplanation());
        return DOCTOR_EXIT.connection;
      }
      io.err(`osd hana: ${error.message}`);
      return DOCTOR_EXIT.usage;
    }
  };

  // ---- --drop-reader runs BEFORE the probe (round-2 NOTE-5) --------------
  // Tearing a reader down after the ABAP schema was removed (probe exits 5)
  // -- or when the main login cannot probe at all -- is exactly when
  // --drop-reader is wanted, and the drop path needs no schema and no probe:
  // its proofs are the store entry and the reader logon. --create-reader,
  // in contrast, reads its roles off the probe, so it runs behind it.
  if (flags["drop-reader"] === true) {
    return finishReader("drop-reader");
  }


  let probeRun;
  try {
    probeRun = await sidecar.run("probe", {args: probeArgs});
  } catch (error) {
    if (error instanceof SidecarVerifyError) {
      // The re-verification immediately before the spawn refused (a swap in
      // the window after the first verify): a setup failure, not a connect
      // problem -- the message names both hashes.
      return fail(error.message);
    }
    // A timeout or a child that could not start: it is a cannot-connect, not
    // a usage error -- the binary itself was verified and hand-shaken.
    io.err(error.message);
    return DOCTOR_EXIT.connection;
  }
  // The probe document is the REAL binary's flat one-line answer, read in one
  // place (probe-doc.mjs; recorded contracts in test/osd-hana/contract/).
  const probe = readProbe(probeRun.summary);
  const schemas = probe.schemas;


  // ---- --create-reader and the verdict follow; the drop ran above ----
  // The doctor's exit-code contract, mapped from the sidecar's named outcomes.
  switch (probeRun.outcome) {
    case "done":
      break;
    case "connection": {
      const errorText = probeRun.summary.error ?? "";
      io.err(`osd hana: cannot connect or log on: ${errorText || "the sidecar said so"}`);
      // The measured trial-image failure gets its own explanation (W0
      // "Additions"): a verified TLS connection to an IP address is refused
      // because the self-signed certificate carries no IP SANs.
      if (/IP SAN/i.test(errorText)) io.err(ipSansExplanation());
      return DOCTOR_EXIT.connection;
    }
    case "unsupported": {
      // Exit 5 comes in two shapes, and only one of them is a finding. The
      // real binary prints its probe document with `abap_schemas: null` when
      // no ABAP schema is readable by this login -- that POSITIVELY says so.
      // An error line instead ("M_DATABASE: ...", "looking for ABAP
      // schemas: ...") means the sidecar could not examine the database at
      // all: that is not "no ABAP schema", and is not reported as one.
      if (saysNoAbapSchema(probe)) {
        io.err("osd hana: no ABAP schema readable by this login was found on this database -- there is no ABAP code to rescue here with this login.");
        if (connection.schema !== undefined) {
          io.err(`  (the probe looked only for the schema named with --schema / HANA_SCHEMA; run without it to see every ABAP schema this login can read.)`);
        }
        io.err("  A login without SELECT on the ABAP schema sees none: try the schema's owner, or an administrator.");
        for (const note of probe.notes) io.err(`  Note from the sidecar: ${note}`);
      } else {
        io.err(`osd hana: the sidecar could not examine this database (unsupported system): ${probe.error ?? "it gave no reason"}`);
        io.err("  This is NOT a finding that the database holds no ABAP schema -- the examination itself failed.");
      }
      return DOCTOR_EXIT.noAbapSchema;
    }
    case "usage":
      return fail(`osd hana: the sidecar refused the probe as a usage error: ${probeRun.summary.error ?? "unknown"}`);
    case "partial":
    case "refused":
      return fail(`osd hana: the sidecar ended with the outcome "${probeRun.outcome}", which a probe cannot produce: ${probeRun.summary.error ?? ""}`);
    default:
      return fail(`osd hana: unmapped sidecar outcome: ${probeRun.outcome}`);
  }

  if (!probe.schemasReported) {
    // "done", but the answer carries no abap_schemas list at all: the binary
    // and this module disagree about the document. Said as exactly that --
    // never as "no ABAP schema" (the defect this guard exists for: an
    // invented field name read as an empty list on a healthy system).
    return fail(`osd hana: the sidecar's probe answered without an ABAP schema list (the field "abap_schemas" is missing) -- ` +
      `this is NOT a finding that there is none: the sidecar binary and this module disagree about the probe document ` +
      `(sidecar ${handshakeInfo?.version ?? "?"}). Nothing was assumed.`);
  }
  if (schemas.length === 0) {
    // "done" with a list that is positively empty: same answer as the
    // sidecar's own exit 5, same exit code.
    io.err("osd hana: no ABAP schema readable by this login was found -- there is no ABAP code to rescue from this database with this login.");
    return DOCTOR_EXIT.noAbapSchema;
  }

  if (flags["create-reader"] === true) {
    return finishReader("create-reader");
  }

  if (flags.json === true) {
    io.out(JSON.stringify(jsonVerdict(probe, {connection, sidecar: describeSidecar(verified, handshakeInfo), warnings}), null, 1));
  } else {
    for (const line of plainVerdict(probe, {connection, sidecar: describeSidecar(verified, handshakeInfo)})) io.out(line);
    for (const warning of warnings) io.out(`  WARNING: ${warning}`);
  }
  return DOCTOR_EXIT.ok;
}

function describeSidecar(verified, handshakeInfo) {
  return {
    path: verified.path,
    pinned: verified.pinned,
    target: verified.target,
    sha256: verified.sha256.slice(0, 12) + "...",
    version: handshakeInfo?.version,
    commit: handshakeInfo?.commit,
  };
}

/** The probe said "system privileges not readable": whether the present
 *  login is an administrator is UNKNOWN, so the role is asked, not assumed
 *  (ownership is known either way). On a terminal one yes/no question; off a
 *  terminal the second-login flag answers it -- --admin-user names the
 *  administrator, so this login acts as the schema owner, --owner-user names
 *  the owner, so this login acts as the administrator -- and without one the
 *  doctor refuses with the reason. Nothing has been sent at that point. */
async function askAdministratorRole({owns, flags, canPrompt, promptVisible}) {
  if (owns && flags["admin-user"] !== undefined) return "owner";
  if (!owns && flags["owner-user"] !== undefined) return "admin";
  const why = "the sidecar could not read this login's system privileges, so whether it is an administrator (USER ADMIN) is not known";
  if (!canPrompt) {
    throw new ReaderError(`osd hana: ${why}.\n` +
      (owns
        ? "  This login owns the ABAP schema. Name an administrator login with --admin-user (its password in $OSD_HANA_ADMIN_PASSWORD), or re-run on a terminal to be asked.\n"
        : "  If this login is an administrator, name the schema owner's login with --owner-user (its password in $OSD_HANA_OWNER_PASSWORD), or re-run on a terminal to be asked;\n" +
          "  otherwise re-run with an administrator or the schema owner's login.\n") +
      "  Nothing was sent.");
  }
  const answer = String(await promptVisible(`osd hana: ${why}. Is this login an administrator (holds USER ADMIN)? [y/n]: `)).trim().toLowerCase();
  if (answer === "y" || answer === "yes") return owns ? "both" : "admin";
  if (answer === "n" || answer === "no") return owns ? "owner" : "neither";
  throw new ReaderError("osd hana: no answer to whether this login is an administrator (y or n). Nothing was sent.");
}

/** The second login of the guided two-login flow. `role` is the PRESENT
 *  login's role; when it holds only one, the login holding the OTHER role is
 *  asked for here: the name from --owner-user / --admin-user (or the VISIBLE
 *  prompt on a terminal, with the catalogue's suggestion as the default), the
 *  password from $OSD_HANA_OWNER_PASSWORD / $OSD_HANA_ADMIN_PASSWORD or the
 *  HIDDEN prompt (nothing echoed). Two separate seams -- one function for
 *  both questions used to mean the login name was typed blind or the password
 *  echoed (critic M-2). `canPrompt` comes from doctorMain: stdin AND stderr
 *  are a terminal. There is deliberately no --owner-password-stdin (task: the
 *  non-interactive shape is --owner-user + the env variable), and no
 *  --password flag anywhere: argv is visible to every user of the machine.
 *  Neither extra password is stored; createReader uses it for its statements
 *  and drops it. Throws ReaderError -- a setup refusal -- when no channel
 *  gives what is needed; nothing has been sent at that point. */
async function collectSecondLogin({role, flags, env, canPrompt, promptVisible, promptHidden, suggest}) {
  const askOwner = role === "admin"; // the OTHER login is the schema owner
  const label = askOwner ? "schema owner" : "administrator";
  const userFlag = askOwner ? "--owner-user" : "--admin-user";
  const envVar = askOwner ? "OSD_HANA_OWNER_PASSWORD" : "OSD_HANA_ADMIN_PASSWORD";
  let user = flags[askOwner ? "owner-user" : "admin-user"];
  if (user === undefined && canPrompt) {
    user = String(await promptVisible(`${label} login${suggest !== undefined ? ` [${suggest}]` : ""}: `)).trim();
    if (user === "" && suggest !== undefined) user = suggest;
  }
  if (user === undefined || user === "") {
    throw new ReaderError(`osd hana: this flow needs TWO logins -- the present one is ${role === "admin" ? "the administrator, not the schema owner" : "the schema owner, not an administrator"}, ` +
      `so the ${label}'s login must run its statement.\n` +
      `  Give the login with ${userFlag}${suggest !== undefined ? ` (the catalogue suggests the owner login: ${suggest})` : ""}\n` +
      `  and its password in $${envVar} for non-interactive use; on a terminal the doctor asks instead.\n` +
      `  The password is used for its statements only and is never stored. Nothing was sent.`);
  }
  let password = typeof env[envVar] === "string" && env[envVar] !== "" ? env[envVar] : undefined;
  if (password === undefined) {
    if (!canPrompt) {
      throw new ReaderError(`osd hana: the password for the ${label} login ${user} is missing -- set $${envVar} ` +
        `(non-interactive use takes ${userFlag} plus the environment variable), or re-run on a terminal for a hidden prompt.\n` +
        `  There is deliberately no --${askOwner ? "owner" : "admin"}-password-stdin and no --password flag: argv is visible to every user of the machine.\n` +
        `  Nothing was sent.`);
    }
    password = await promptHidden(`${label} password for ${user} (hidden): `);
    if (typeof password !== "string" || password === "") {
      throw new ReaderError(`osd hana: the ${label} login's password is empty -- refused, like every empty password. Nothing was sent.`);
    }
  }
  return {user, password};
}
