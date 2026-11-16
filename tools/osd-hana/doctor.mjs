// `osd hana doctor`: locate + verify + handshake the sidecar, take the
// connection from flags / env file / stdin / a hidden prompt, run the
// sidecar's `probe` (read-only, no names needed), and say the verdict plainly.
// Exit codes: 0 ready to extract, 1 usage or setup, 2 cannot connect / log on,
// 5 no ABAP schema found. `--json` prints the same findings as one JSON
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
import {UsageError, parseFlags, collectConnection} from "./connect.mjs";
import {isPublicDefaultPassword, publicDefaultWarning} from "./defaults.mjs";
import {createReader, dropReader, ConsentRefused, ReaderError, hdbClientFactory} from "./reader.mjs";
import {defaultSecretStore} from "./secret-store.mjs";
import {Sidecar, HandshakeError, SidecarVerifyError, handshake, locateSidecar, loadPin, verifySidecar, resetVerifiedSidecars, DEFAULT_PIN_PATH} from "./sidecar.mjs";
import {plainVerdict, jsonVerdict} from "./verdict.mjs";
import {resolve} from "node:path";

export const DOCTOR_EXIT = Object.freeze({
  ok: 0,
  usage: 1,
  connection: 2,
  noAbapSchema: 5,
});

const VALUE_FLAGS = ["host", "port", "database", "user", "schema", "env-file", "reader-name", "sidecar-pin"];
const BOOLEAN_FLAGS = ["password-stdin", "json", "create-reader", "drop-reader", "yes", "allow-unpinned-sidecar", "encrypt", "trust-server-certificate", "help"];

const USAGE = `Usage: osd hana doctor [--host H] [--port P] [--database NAME] [--user U]
                        [--schema NAME] [--env-file <file>] [--password-stdin]
                        [--json] [--allow-unpinned-sidecar]
                        [--create-reader | --drop-reader [--reader-name NAME] [--yes]]
                        [--encrypt | --trust-server-certificate]

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
consent; --yes answers it non-interactively). --drop-reader removes it.

The reader path talks to the database through the Node driver hdb. Without
--encrypt that connection is NOT encrypted and the new password travels in
clear text (the consent text says so): use a trusted network or --encrypt
(TLS with certificate validation, hdb's useTLS). --trust-server-certificate
encrypts without validating the server's certificate and says so loudly.
Exit codes: 0 ready to extract; 1 usage; 2 cannot connect or log on;
5 no ABAP schema.`;

export async function doctorMain(argv, {
  io = {out: (line) => process.stdout.write(`${line}\n`), err: (line) => process.stderr.write(`${line}\n`)},
  env = process.env,
  stdin = process.stdin,
  isTTY = Boolean(stdin?.isTTY),
  callerPath,
  store = defaultSecretStore(),
  clientFactory,
  prompt,
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
      loud: (line) => io.err(line.trimEnd()),
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

  // ---- connection --------------------------------------------------------
  let connection;
  try {
    connection = await collectConnection({flags, env, stdin, isTTY, prompt});
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
    loud: (line) => io.err(line.trimEnd()),
  });
  // The user and the password are credentials and travel in the child's
  // environment only (contract W0). Host, port, tenant database and an
  // explicitly chosen ABAP schema are not credentials: they are the probe's
  // connection flags.
  const probeArgs = ["--host", connection.host, "--port", String(connection.port)];
  if (connection.database !== undefined) probeArgs.push("--database", connection.database);
  if (connection.schema !== undefined) probeArgs.push("--abap-schema", connection.schema);
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
  const probe = probeRun.summary.probe ?? probeRun.summary;
  const schemas = Array.isArray(probe.schemas) ? probe.schemas : [];

  const finishReader = async (verb) => {
    const schemaName = flags.schema ?? (schemas.length === 1 ? schemas[0].name : undefined);
    if (flags.schema === undefined && schemaName === undefined) {
      io.err(`osd hana: --${verb} needs to know the ABAP schema -- pass --schema (the probe found ${schemas.length} schemas).`);
      return DOCTOR_EXIT.usage;
    }
    const readerName = flags["reader-name"] ?? "OSD_READER";
    try {
      const result = verb === "create-reader"
        ? await createReader({connection, schema: schemaName, readerName, yes: flags.yes === true, isTTY, store,
            clientFactory: clientFactory ?? hdbClientFactory(), prompt,
            encrypt: flags.encrypt === true, trustServerCertificate: flags["trust-server-certificate"] === true,
            say: (text) => io.out(text)})
        : await dropReader({connection, readerName, yes: flags.yes === true, isTTY, store,
            clientFactory: clientFactory ?? hdbClientFactory(), prompt,
            encrypt: flags.encrypt === true, trustServerCertificate: flags["trust-server-certificate"] === true,
            say: (text) => io.out(text)});
      if (flags.json === true) {
        // the create result deliberately carries no password -- the secret
        // store is its only holder (critic M-A); --json reports the facts a
        // caller can act on and nothing that unlocks anything
        io.out(JSON.stringify({
          ...jsonVerdict(probe, {connection, sidecar: describeSidecar(verified, handshakeInfo), warnings}),
          reader: verb === "create-reader"
            ? {user: result.user, schema: result.schema, stored_at: result.storedAt}
            : {dropped: result.dropped, absent: result.absent},
        }, null, 1));
      }
      return DOCTOR_EXIT.ok;
    } catch (error) {
      if (error instanceof ConsentRefused || error instanceof ReaderError) {
        io.err(error.message);
        return DOCTOR_EXIT.usage;
      }
      if (typeof error?.code === "number") {
        // The database refused: a connection or logon problem of the
        // administrator login (hdb reports native codes).
        io.err(`osd hana: the database refused (${error.code}): ${error.message}`);
        return DOCTOR_EXIT.connection;
      }
      io.err(`osd hana: ${error.message}`);
      return DOCTOR_EXIT.usage;
    }
  };

  // The doctor's exit-code contract, mapped from the sidecar's named outcomes.
  switch (probeRun.outcome) {
    case "done":
      break;
    case "connection":
      io.err(`osd hana: cannot connect or log on: ${probeRun.summary.error ?? "the sidecar said so"}`);
      return DOCTOR_EXIT.connection;
    case "unsupported":
      io.err(`osd hana: no ABAP schema found on this database${probeRun.summary.error ? ` (${probeRun.summary.error})` : ""} -- there is no ABAP code to rescue here.`);
      return DOCTOR_EXIT.noAbapSchema;
    case "usage":
      return fail(`osd hana: the sidecar refused the probe as a usage error: ${probeRun.summary.error ?? "unknown"}`);
    case "partial":
    case "refused":
      return fail(`osd hana: the sidecar ended with the outcome "${probeRun.outcome}", which a probe cannot produce: ${probeRun.summary.error ?? ""}`);
    default:
      return fail(`osd hana: unmapped sidecar outcome: ${probeRun.outcome}`);
  }

  if (schemas.length === 0) {
    // The sidecar said "done" but found nothing: same answer as its own
    // unsupported, same exit code.
    io.err("osd hana: no ABAP schema found -- there is no ABAP code to rescue from this database.");
    return DOCTOR_EXIT.noAbapSchema;
  }

  if (flags["create-reader"] === true || flags["drop-reader"] === true) {
    return finishReader(flags["create-reader"] === true ? "create-reader" : "drop-reader");
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
