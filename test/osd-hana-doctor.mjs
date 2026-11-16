// The osd-hana module, against fakes only (no network, no database, no SAP
// system): a FAKE sidecar (test/osd-hana/fake-sidecar.mjs, spawned for real,
// verified against a generated test pin) and a FAKE hdb client injected
// through the reader's clientFactory seam, scripted with the E1 answers
// (258 on create, 258 on grant, 332, success).
//
// Every guard here has a named mutation behind it: the test goes red when the
// guard is removed. The mutations are listed in REPORT.md next to each test.
import {expect} from "chai";
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {doctorMain} from "../tools/osd-hana/doctor.mjs";
import {EXIT_OUTCOMES, HandshakeError, Sidecar, SidecarRunError, handshake, loadPin, locateSidecar, targetKey, verifySidecar} from "../tools/osd-hana/sidecar.mjs";
import {UsageError, parseFlags, readEnvFile} from "../tools/osd-hana/connect.mjs";
import {isPublicDefaultPassword, publicDefaultWarning} from "../tools/osd-hana/defaults.mjs";
import {makeRedactor} from "../tools/osd-hana/redact.mjs";
import {
  DEFAULT_READER_NAME, ConsentRefused, ReaderError,
  createReader, dropReader, generateReaderPassword, quoteIdentifier, validateReaderName,
} from "../tools/osd-hana/reader.mjs";
import {fileSecretStore} from "../tools/osd-hana/secret-store.mjs";
import {SAFETY_NOTE, canWrite} from "../tools/osd-hana/verdict.mjs";

const FAKE_SIDECAR = fileURLToPath(new URL("./osd-hana/fake-sidecar.mjs", import.meta.url));
const PASSWORD = "correct-horse-battery-staple-42";
const USER = "TESTLOGIN";
const HOST = "hana.example.test";
const SCHEMA = "TE" + "STSCHEMA"; // a fixture name, deliberately not any real one

// ---------------------------------------------------------------- fixtures

let root;
let fakePath;
let pinPath;
let recordPath;
let out;
let err;

function captureIo() {
  const lines = {out: [], err: []};
  return {lines, io: {
    out: (line) => lines.out.push(line),
    err: (line) => lines.err.push(line),
  }};
}

function allText() {
  return `${out.join("\n")}\n${err.join("\n")}`;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function makePin({targets = {[targetKey()]: sha256(fakePath)}, ...rest} = {}) {
  const path = join(root, `pin-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(path, JSON.stringify({
    name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40),
    schema: 1, read_only: true, targets, ...rest,
  }));
  return path;
}

// The full doctor run against the fake sidecar: real spawn, real sha256, real
// pin file -- only the database behind the fake is not real.
async function runDoctor(argv, {
  scenario = "owner-tenant",
  handshakePatch,
  env = {},
  isTTY = false,
  deps = {},
  pin = pinPath,
} = {}) {
  const capturedIo = captureIo();
  out = capturedIo.lines.out;
  err = capturedIo.lines.err;
  const runEnv = {
    // the child is a shebang script: it needs the real PATH to find node
    ...process.env,
    OSD_HANA_DUMP: fakePath,
    OSD_HANA_PASSWORD: PASSWORD,
    FAKE_SIDECAR_PROBE: scenario,
    ...(handshakePatch !== undefined ? {FAKE_SIDECAR_HANDSHAKE: JSON.stringify(handshakePatch)} : {}),
    ...env,
  };
  return doctorMain([
    "--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA,
    "--sidecar-pin", pin,
  ].concat(argv), {
    io: capturedIo.io,
    env: runEnv,
    stdin: {isTTY},
    isTTY,
    sidecarTimeoutMs: 500,
    ...deps,
  });
}

before(function () {
  root = mkdtempSync(join(tmpdir(), "osd-hana-test-"));
  fakePath = join(root, "fake-sidecar");
  // The fake must be spawnable directly, like the real Go binary.
  copyFileSync(FAKE_SIDECAR, fakePath);
  chmodSync(fakePath, 0o755);
  pinPath = makePin();
  recordPath = join(root, "record.ndjson");
});

after(function () {
  rmSync(root, {recursive: true, force: true});
});

// ------------------------------------------------------------ fake client

/** A FAKE hdb client factory, scripted with E1's answers. Rules are matched
 *  against the SQL; the log records every connection and every statement with
 *  its bound parameters -- that log is what the assertions read. */
function fakeClientFactory(rules = []) {
  const log = {connections: [], statements: []};
  const factory = async (options) => {
    log.connections.push(options);
    return {
      exec: async (sql, params = []) => {
        log.statements.push({sql, params});
        for (const rule of rules) {
          if (typeof rule.match === "string" ? sql.includes(rule.match) : rule.match.test(sql)) {
            if (rule.error !== undefined) {
              throw Object.assign(new Error(rule.message ?? `db error ${rule.error}`), {code: rule.error});
            }
            return {rows: rule.rows ?? []};
          }
        }
        return {rows: []};
      },
      disconnect: async () => {},
    };
  };
  return {log, factory};
}

// Rules for the success path, E1's SQL shapes.
const SUCCESS_RULES = [
  {match: /CREATE USER/, rows: []},
  {match: /ALTER USER/, rows: []},
  {match: /GRANT SELECT/, rows: []},
  {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
  {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
  {match: /"TADIR"/, rows: [{N: 42}]},
  {match: /DROP USER/, rows: []},
];

describe("tools/osd-hana: the osd hana doctor", function () {
  this.timeout(20_000);

  // ------------------------------------------------- sidecar handling
  describe("sidecar handling", function () {
    it("locates the sidecar: OSD_HANA_DUMP wins over the caller's path; neither is a clear refusal", function () {
      // explicit environment wins (mutation: prefer callerPath -> red)
      expect(locateSidecar({env: {OSD_HANA_DUMP: fakePath}, callerPath: "/caller/owned/binary"})).to.equal(fakePath);
      expect(locateSidecar({env: {}, callerPath: "/caller/owned/binary"})).to.equal("/caller/owned/binary");
      // the refusal says how to get the binary -- there is no download here
      let message = "";
      try {
        locateSidecar({env: {}});
        expect.fail("should refuse");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("OSD_HANA_DUMP");
      expect(message).to.include("osd-hana-dump");
    });

    it("refuses a checksum mismatch and names both hashes (mutation: drop the sha comparison -> red)", async function () {
      const other = join(root, "tampered-sidecar");
      writeFileSync(other, "not the pinned bytes");
      const pin = makePin({targets: {[targetKey()]: "f".repeat(64)}});
      let message = "";
      try {
        await verifySidecar(other, {pin: loadPin(pin)});
        expect.fail("should refuse");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("f".repeat(64));
      expect(message).to.include(sha256(other));
      expect(message).to.include("refusing");
    });

    it("runs an unpinned sidecar only with --allow-unpinned-sidecar, and says so loudly", async function () {
      const emptyPin = makePin({targets: {}});
      await verifySidecar(fakePath, {pin: loadPin(emptyPin)}).then(
        () => expect.fail("should refuse"),
        (error) => expect(error.message).to.include("--allow-unpinned-sidecar"));
      const loud = [];
      const result = await verifySidecar(fakePath, {
        pin: loadPin(emptyPin), allowUnpinned: true, loud: (line) => loud.push(line),
        // the module caches per process; a fresh path keeps the cache honest
      });
      expect(result.pinned).to.equal(false);
      expect(loud.join("\n")).to.include("UNPINNED");
    });

    it("refuses a handshake that says read_only: false (mutation: drop the check -> red)", async function () {
      await handshake(fakePath, {runFn: async () => JSON.stringify({schema: 1, read_only: false, capabilities: ["probe"]})}).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(HandshakeError);
          expect(error.message).to.include("read_only");
        });
    });

    it("refuses a handshake that lacks a capability the verb needs, and names it (mutation: drop the check -> red)", async function () {
      await handshake(fakePath, {requiredCapabilities: ["probe"], runFn: async () => JSON.stringify({schema: 1, read_only: true, capabilities: ["list", "dump"]})}).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(HandshakeError);
          expect(error.message).to.include("probe");
        });
    });

    it("refuses a handshake with the wrong schema, and a pinned binary that says another version", async function () {
      await handshake(fakePath, {runFn: async () => JSON.stringify({schema: 2, read_only: true, capabilities: ["probe"]})}).then(
        () => expect.fail("should refuse"),
        (error) => expect(error.message).to.include("schema"));
      const pin = loadPin(makePin({version: "v1.2.3", commit: "b".repeat(40)}));
      await handshake(fakePath, {pin, runFn: async () => JSON.stringify({schema: 1, read_only: true, capabilities: ["probe"], version: "v9.9.9-test", commit: "a".repeat(40)})}).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error.message).to.include("v1.2.3");
          expect(error.message).to.include("v9.9.9-test");
        });
    });

    it("maps the sidecar's exit codes to the contract's named outcomes (mutation: collapse the map -> red)", async function () {
      expect(EXIT_OUTCOMES[0]).to.equal("done");
      expect(EXIT_OUTCOMES[1]).to.equal("usage");
      expect(EXIT_OUTCOMES[2]).to.equal("connection");
      expect(EXIT_OUTCOMES[3]).to.equal("partial");
      expect(EXIT_OUTCOMES[4]).to.equal("refused");
      expect(EXIT_OUTCOMES[5]).to.equal("unsupported");
      const cases = [["owner-tenant", 0, "done"], ["usage-error", 1, "usage"], ["connect-error", 2, "connection"], ["partial", 3, "partial"], ["refused", 4, "refused"], ["unsupported", 5, "unsupported"]];
      for (const [scenario, exit, outcome] of cases) {
        const sidecar = new Sidecar(fakePath, {credentials: {user: USER, password: PASSWORD}, env: {...process.env, FAKE_SIDECAR_PROBE: scenario}});
        const run = await sidecar.run("probe");
        expect(run.exit, scenario).to.equal(exit);
        expect(run.outcome, scenario).to.equal(outcome);
      }
    });

    it("refuses an exit code the contract does not define", async function () {
      const sidecar = new Sidecar(fakePath, {credentials: {user: USER, password: PASSWORD}, env: {...process.env, FAKE_SIDECAR_PROBE: "weird-exit"}});
      await sidecar.run("probe").then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(SidecarRunError);
          expect(error.message).to.include("9");
        });
    });

    it("kills a sidecar that never answers (timeout)", async function () {
      const sidecar = new Sidecar(fakePath, {credentials: {user: USER, password: PASSWORD}, env: {...process.env, FAKE_SIDECAR_PROBE: "hang"}, timeoutMs: 300});
      await sidecar.run("probe").then(
        () => expect.fail("should time out"),
        (error) => expect(error.message).to.include("did not finish within 300 ms"));
    }).timeout(5000);
  });

  // --------------------------------- the doctor: verdicts and exit codes
  describe("the doctor against the fake sidecar", function () {
    it("says the plain verdict for a ready tenant database (exit 0)", async function () {
      const code = await runDoctor([], {scenario: "owner-tenant"});
      expect(code).to.equal(0);
      const text = allText();
      expect(text).to.include("tenant database");
      expect(text).to.include("TESTSCHEMA");
      expect(text).to.include("release 7.57");
      expect(text).to.include("clients 100, 200");
      expect(text).to.include("1234 source rows");
      expect(text).to.include("2345 repository objects");
      expect(text).to.include("schema's owner");
      expect(text).to.include("Ready to extract: yes");
    });

    it("says the read-only safety sentence exactly once when the login can write (mutation: sentence per finding -> red)", async function () {
      const code = await runDoctor([], {scenario: "writer"});
      expect(code).to.equal(0);
      const text = allText();
      expect(text.split(SAFETY_NOTE).length - 1).to.equal(1);
      // and for an administrator the class alone is enough to say it
      const code2 = await runDoctor([], {scenario: "admin-system", env: {FAKE_SIDECAR_PROBE: "admin-system"}});
      expect(code2).to.equal(0);
      expect(allText().split(SAFETY_NOTE).length - 1).to.equal(1);
    });

    it("prints the same findings as one JSON document with --json, and the password is nowhere in it", async function () {
      const code = await runDoctor(["--json"], {scenario: "writer"});
      expect(code).to.equal(0);
      const document = JSON.parse(out.join("\n"));
      expect(document.command).to.equal("osd hana doctor");
      expect(document.verdict.readyToExtract).to.equal(true);
      expect(document.verdict.canWrite).to.equal(true);
      expect(document.connection.user).to.equal(USER);
      expect(document.connection.password).to.equal(undefined);
      expect(JSON.stringify(document)).to.not.include(PASSWORD);
    });

    it("exits 2 when the database cannot be reached or logged on", async function () {
      const code = await runDoctor([], {scenario: "connect-error"});
      expect(code).to.equal(2);
      expect(allText()).to.include("cannot connect");
    });

    it("exits 5 when there is no ABAP schema (the sidecar says unsupported)", async function () {
      const code = await runDoctor([], {scenario: "unsupported"});
      expect(code).to.equal(5);
      const code2 = await runDoctor([], {scenario: "no-schema"});
      expect(code2).to.equal(5);
    });

    it("exits 1 on usage errors: no password channel, a stray positional, an unknown flag", async function () {
      // no OSD_HANA_PASSWORD and stdin not a TTY: the doctor refuses instead
      // of hanging, and names the ways a password may arrive
      const code = await runDoctor([], {
        env: {OSD_HANA_PASSWORD: ""},
      });
      expect(code).to.equal(1);
      expect(allText()).to.include("password");
      expect(allText()).to.include("--password-stdin");
      // a stray positional word: the doctor takes --double-dash flags only
      const code2 = await runDoctor(["stray-argument"]);
      expect(code2).to.equal(1);
      expect(allText()).to.include("--double-dash");
      expect(() => parseFlags(["--nosuchflag"], {valueFlags: [], booleanFlags: []})).to.throw(UsageError);
    });

    it("takes the password from --password-stdin, never from argv", async function () {
      const stdinPassword = "stdin-fed-password-13";
      const {lines, io} = captureIo();
      const {PassThrough} = await import("node:stream");
      const stdin = new PassThrough();
      stdin.write(`${stdinPassword}\n`);
      stdin.end();
      const code = await doctorMain(
        ["--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA, "--password-stdin", "--sidecar-pin", pinPath],
        {io, env: {...process.env, OSD_HANA_DUMP: fakePath, FAKE_SIDECAR_PROBE: "owner-tenant"}, stdin, isTTY: false, sidecarTimeoutMs: 500});
      expect(code).to.equal(0);
      expect(JSON.stringify({out: lines.out, err: lines.err})).to.not.include(stdinPassword);
    });

    it("delivers the credentials to the child through the environment only (mutation: put them on argv -> red)", async function () {
      rmSync(recordPath, {force: true});
      const code = await runDoctor([], {env: {FAKE_SIDECAR_RECORD: recordPath}});
      expect(code).to.equal(0);
      const records = readFileSync(recordPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      const probeRecords = records.filter((r) => r.argv[0] === "probe");
      expect(probeRecords.length).to.be.at.least(1);
      for (const record of probeRecords) {
        expect(JSON.stringify(record.argv)).to.not.include(PASSWORD);
        expect(JSON.stringify(record.argv)).to.not.include(USER);
        expect(record.env.hadPassword).to.equal(true);
        expect(record.env.hadUser).to.equal(true);
      }
      // the flags carry only the connection, not the credentials
      const probeRecord = records.find((r) => r.argv[0] === "probe");
      expect(probeRecord.argv).to.include("--host");
      expect(probeRecord.argv.join(" ")).to.not.include(PASSWORD);
    });

    it("masks password, user, host and schema in the child's stderr (mutation: identity redactor -> red)", async function () {
      const code = await runDoctor([], {
        scenario: "echo-stderr",
        env: {FAKE_SIDECAR_ECHO_SCHEMA: SCHEMA},
      });
      expect(code).to.equal(0);
      // the child's stderr (the err channel) repeats every value of this run;
      // every one of them arrives masked
      const childSide = err.join("\n");
      expect(childSide).to.include("***");
      expect(childSide).to.not.include(PASSWORD);
      expect(childSide).to.not.include(USER);
      expect(childSide).to.not.include(HOST);
      expect(childSide).to.not.include(SCHEMA);
      // the password is nowhere in the doctor's own output either (user and
      // host may be, in the verdict -- they are the caller's own input)
      expect(allText()).to.not.include(PASSWORD);
    });

    it("warns loudly when the password is a public trial-image default, and changes nothing", async function () {
      expect(isPublicDefaultPassword("HXEHana1")).to.equal(true);
      expect(isPublicDefaultPassword(PASSWORD)).to.equal(false);
      const code = await runDoctor([], {env: {OSD_HANA_PASSWORD: "HXEHana1"}});
      expect(code).to.equal(0);
      expect(allText()).to.include("public default");
      expect(allText()).to.include("changed nothing");
      expect(publicDefaultWarning()).to.include("ALTER USER");
    });

    it("refuses an unpinned sidecar without the flag, runs it loudly with it", async function () {
      const emptyPin = makePin({targets: {}});
      const code = await runDoctor([], {pin: emptyPin});
      expect(code).to.equal(1);
      expect(allText()).to.include("--allow-unpinned-sidecar");
      const code2 = await runDoctor(["--allow-unpinned-sidecar"], {pin: emptyPin});
      expect(code2).to.equal(0);
      expect(allText()).to.include("UNPINNED");
    });

    it("exits 2 with the timeout message when the sidecar hangs", async function () {
      const code = await runDoctor([], {scenario: "hang"});
      expect(code).to.equal(2);
      expect(allText()).to.include("did not finish within");
    }).timeout(5000);
  });

  // -------------------------------------------- the dedicated reader
  describe("the dedicated reader", function () {
    function store() {
      return fileSecretStore(join(root, `secrets-${Math.random().toString(16).slice(2)}`));
    }

    it("validates the reader name: no injection, no quotes, capital first (mutation: drop validation -> red)", function () {
      expect(validateReaderName(DEFAULT_READER_NAME)).to.equal("OSD_READER");
      for (const bad of ["X; DROP USER Y", 'AB"C', "1ABC", "osd_reader", "TOO_LONG_NAME_OVER_THIRTY_ONE_XY", "", "A-B"]) {
        expect(() => validateReaderName(bad), bad).to.throw(ReaderError);
      }
      expect(validateReaderName("OSD_READER_1")).to.equal("OSD_READER_1");
      // and createReader itself refuses a bad name before anything is built
      // or sent -- the entry point is the guard, not the helper alone
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      return createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, readerName: "X; DROP USER Y", yes: true,
        store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(ReaderError);
          expect(error.message).to.include("UNQUOTED");
        }).then(() => {
          expect(log.statements).to.have.length(0);
          expect(log.connections).to.have.length(0);
        });
    });

    it("quotes identifiers as measured: \" doubled, ' passing through", async function () {
      expect(quoteIdentifier('AB"S')).to.equal('"AB""S"');
      expect(quoteIdentifier("O'A")).to.equal("\"O'A\"");
      // and the GRANT statement the plan shows carries the doubled form
      const {factory} = fakeClientFactory(SUCCESS_RULES);
      const seen = [];
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: 'AB"S', readerName: DEFAULT_READER_NAME, yes: true, store: store(),
        clientFactory: async (options) => {
          const client = await factory(options);
          const exec = client.exec.bind(client);
          client.exec = async (sql, params) => {
            seen.push({sql, params});
            return exec(sql, params);
          };
          return client;
        },
      }).then(() => {
        const grant = seen.find((s) => s.sql.includes("GRANT SELECT"));
        expect(grant.sql).to.include('ON SCHEMA "AB""S"');
      });
    });

    it("requires consent: no --yes and no TTY means nothing is sent (mutation: consent always given -> red)", async function () {
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: false, isTTY: false,
        store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => expect(error).to.be.an.instanceof(ConsentRefused));
      expect(log.statements).to.have.length(0);
      expect(log.connections).to.have.length(0);
    });

    it("asks on a TTY and proceeds on 'yes'", async function () {
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      const result = await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: false, isTTY: true,
        prompt: async () => "yes",
        store: store(), clientFactory: factory,
      });
      expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(true);
      expect(result.user).to.equal(DEFAULT_READER_NAME);
      // a declined prompt sends nothing
      const log2 = fakeClientFactory(SUCCESS_RULES);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: false, isTTY: true, prompt: async () => "no",
        store: store(), clientFactory: log2.factory,
      }).then(() => expect.fail("should refuse"), (error) => expect(error).to.be.an.instanceof(ConsentRefused));
      expect(log2.log.statements).to.have.length(0);
    });

    it("runs the E1 statement sequence and proves a SELECT as the reader; the generated password never shows in any message (mutation: print it -> red)", async function () {
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      const said = [];
      const secretStore = store();
      const result = await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, readerName: DEFAULT_READER_NAME, yes: true,
        store: secretStore, clientFactory: factory, say: (text) => said.push(text),
      });
      const statements = log.statements.map((s) => s.sql);
      // exact shapes, in order (E1: user unquoted, schema quoted as identifier)
      expect(statements[0]).to.equal(`CREATE USER OSD_READER PASSWORD "${result.password}" NO FORCE_FIRST_PASSWORD_CHANGE`);
      expect(statements[1]).to.equal("ALTER USER OSD_READER DISABLE PASSWORD LIFETIME");
      expect(statements[2]).to.equal(`GRANT SELECT ON SCHEMA "${SCHEMA}" TO OSD_READER`);
      expect(statements.some((s) => s.includes(`FROM "${SCHEMA}"."TADIR"`))).to.equal(true);
      // the proof ran as the reader, with the reader's own password
      const proofConnection = log.connections.find((c) => c.user === "OSD_READER");
      expect(proofConnection.password).to.equal(result.password);
      // the generated password: >= 24 chars, upper + lower + digit, nothing to escape
      expect(result.password.length).to.be.at.least(24);
      expect(result.password).to.match(/^[A-Za-z0-9]+$/);
      expect(result.password).to.match(/[A-Z]/).and.to.match(/[a-z]/).and.to.match(/[0-9]/);
      expect(generateReaderPassword()).to.not.equal(generateReaderPassword());
      // and it is in none of the messages, in no thrown error -- only the mask
      const everything = said.join("\n");
      expect(everything).to.not.include(result.password);
      expect(everything).to.include("***");
      // the secret is stored where the doctor says
      expect(said.join("\n")).to.include(secretStore.location(DEFAULT_READER_NAME));
      expect(secretStore.get(DEFAULT_READER_NAME).password).to.equal(result.password);
    });

    it("binds catalogue comparisons, never concatenates them (mutation: concatenate -> red)", async function () {
      // the SYS.USERS absence proof of drop-reader takes the reader name as a
      // bound parameter
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      await dropReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        yes: true, store: store(), clientFactory: factory,
      });
      const sysUsers = log.statements.find((s) => s.sql.includes("FROM SYS.USERS"));
      expect(sysUsers.sql).to.include("USER_NAME = ?");
      expect(sysUsers.params).to.deep.equal([DEFAULT_READER_NAME]);
      // the schema owner lookup (run when the GRANT is refused) takes the
      // schema as a bound parameter too
      const log2 = fakeClientFactory([
        {match: /CREATE USER/, rows: []},
        {match: /ALTER USER/, rows: []},
        {match: /GRANT SELECT/, error: 258, message: "insufficient privilege"},
        {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
        {match: /DROP USER/, rows: []},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: store(), clientFactory: log2.factory,
      }).catch(() => {}); // the 258 message is asserted elsewhere
      const schemas = log2.log.statements.find((s) => s.sql.includes("FROM SYS.SCHEMAS"));
      expect(schemas.sql).to.include("UPPER(SCHEMA_NAME) = UPPER(?)");
      expect(schemas.params).to.deep.equal([SCHEMA]);
      expect(schemas.sql).to.not.include(SCHEMA);
    });

    it("explains 258 on CREATE USER and sends no DROP (nothing was created)", async function () {
      const {log, factory} = fakeClientFactory([
        {match: /CREATE USER/, error: 258, message: "insufficient privilege"},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(ReaderError);
          expect(error.message).to.include("may not create users");
          expect(error.message).to.include("USER ADMIN");
          expect(error.message).to.include("READ ONLY");
        });
      expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(false);
    });

    it("explains 258 on GRANT, names the schema owner, and drops the reader it had created (mutation: no cleanup -> red)", async function () {
      const {log, factory} = fakeClientFactory([
        {match: /CREATE USER/, rows: []},
        {match: /ALTER USER/, rows: []},
        {match: /GRANT SELECT/, error: 258, message: "insufficient privilege"},
        {match: /FROM SYS\.SCHEMAS/, rows: [{OWNER_NAME: "SCHEMA_OWNER_LOGIN"}]},
        {match: /DROP USER/, rows: []},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(ReaderError);
          expect(error.message).to.include("may not grant the schema");
          expect(error.message).to.include("SCHEMA_OWNER_LOGIN");
        });
      expect(log.statements.some((s) => s.sql.startsWith("DROP USER OSD_READER CASCADE"))).to.equal(true);
    });

    it("drops the reader on a later failure and reports the real cause (mutation: keep the half reader -> red)", async function () {
      const {log, factory} = fakeClientFactory([
        {match: /CREATE USER/, rows: []},
        {match: /ALTER USER/, error: 421, message: "phase failed"},
        {match: /DROP USER/, rows: []},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(ReaderError);
          expect(error.message).to.include("421");
          expect(error.message).to.include("dropped again");
        });
      expect(log.statements.some((s) => s.sql.startsWith("DROP USER OSD_READER CASCADE"))).to.equal(true);
    });

    it("treats a 332 after a failed create as 'user absent', never as the cause", async function () {
      const {log, factory} = fakeClientFactory([
        {match: /CREATE USER/, error: 421, message: "the create failed"},
        {match: /DROP USER/, error: 332, message: "invalid user name"},
      ]);
      await createReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        schema: SCHEMA, yes: true, store: store(), clientFactory: factory,
      }).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error.message).to.include("the create failed");
          expect(error.message).to.include("user absent");
        });
      expect(log.statements.some((s) => s.sql.startsWith("DROP USER"))).to.equal(true);
    });

    it("enforces the secret file modes: dir 0700, file 0600, fchmod even when they existed (mutation: drop fchmod -> red)", function () {
      const dir = join(root, `modes-${Math.random().toString(16).slice(2)}`);
      const secretPath = join(dir, "reader-secret.json");
      // a loose pre-existing store: the store must tighten it, not keep it
      mkdirSync(dir, {recursive: true, mode: 0o755});
      writeFileSync(secretPath, `{"OTHER": {"x": 1}}\n`, {mode: 0o644});
      chmodSync(secretPath, 0o644);
      const s = fileSecretStore(dir);
      s.set({user: "OSD_READER", password: "not-a-real-password-42"}, "OSD_READER");
      expect(statSync(dir).mode & 0o777).to.equal(0o700);
      expect(statSync(secretPath).mode & 0o777).to.equal(0o600);
      expect(s.get("OSD_READER").password).to.equal("not-a-real-password-42");
      expect(s.get("OTHER")).to.deep.equal({x: 1});
      s.delete("OSD_READER");
      expect(s.get("OSD_READER")).to.equal(undefined);
      expect(s.get("OTHER")).to.deep.equal({x: 1}); // another reader's secret stays
    });

    it("drop-reader: DROP ... CASCADE, absence proved, secret removed (mutation: skip store.delete -> red)", async function () {
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      const secretStore = store();
      secretStore.set({user: "OSD_READER", password: "gone-soon-42"}, "OSD_READER");
      const said = [];
      const result = await dropReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        readerName: DEFAULT_READER_NAME, yes: true, store: secretStore,
        clientFactory: factory, say: (text) => said.push(text),
      });
      expect(result.dropped).to.equal(true);
      expect(result.absent).to.equal(true);
      expect(log.statements.some((s) => s.sql === "DROP USER OSD_READER CASCADE")).to.equal(true);
      expect(log.statements.some((s) => s.sql.includes("FROM SYS.USERS"))).to.equal(true);
      expect(secretStore.get(DEFAULT_READER_NAME)).to.equal(undefined);
      expect(said.join("\n")).to.include("absence proved");
    });

    it("drop-reader on an absent user: 332 is fine, the secret still goes", async function () {
      const {log, factory} = fakeClientFactory([
        {match: /DROP USER/, error: 332, message: "invalid user name"},
        {match: /FROM SYS\.USERS/, rows: [{N: 0}]},
      ]);
      const secretStore = store();
      secretStore.set({user: "OSD_READER", password: "gone-soon-42"}, "OSD_READER");
      const result = await dropReader({
        connection: {host: HOST, port: 39015, user: USER, password: PASSWORD},
        yes: true, store: secretStore, clientFactory: factory,
      });
      expect(result.dropped).to.equal(false);
      expect(result.absent).to.equal(true);
      expect(secretStore.get(DEFAULT_READER_NAME)).to.equal(undefined);
    });

    it("through the doctor: --create-reader runs the whole path and exits 0", async function () {
      const {log, factory} = fakeClientFactory(SUCCESS_RULES);
      const secretStore = store();
      const code = await runDoctor(["--create-reader", "--yes"], {
        scenario: "owner-tenant",
        deps: {clientFactory: factory, store: secretStore},
      });
      expect(code).to.equal(0);
      expect(log.statements.some((s) => s.sql.startsWith("CREATE USER"))).to.equal(true);
      expect(secretStore.get(DEFAULT_READER_NAME)).to.not.equal(undefined);
    });

    it("the env file feeds the connection, unknown keys are refused", function () {
      const envPath = join(root, "bed.env");
      writeFileSync(envPath, ["# a test bed", "HANA_HOST=bed.example.test", "HANA_PORT=39015", "HANA_DATABASE=TEN", "HANA_USER=BEDUSER", "HANA_PASSWORD=bed-password-1", "HANA_SCHEMA=BEDSCHEMA"].join("\n"));
      const {flags} = parseFlags(["--env-file", envPath], {valueFlags: ["env-file"], booleanFlags: []});
      expect(flags["env-file"]).to.equal(envPath);
      const badPath = join(root, "bad.env");
      writeFileSync(badPath, "HANA_HOSTNAME=x\n");
      expect(() => readEnvFile(badPath)).to.throw(UsageError);
      expect(() => readEnvFile(join(root, "no-such.env"))).to.throw(UsageError);
    });
  });

  // ---------------------------------------- redactor and defaults, directly
  describe("the redactor and the courtesy check", function () {
    it("masks all four values in every shape they travel", function () {
      const redact = makeRedactor(["secret-password-1", "TESTLOGIN", HOST, SCHEMA]);
      expect(redact("logon secret-password-1 accepted")).to.not.include("secret-password-1");
      expect(redact(`user "TESTLOGIN" connected`)).to.not.include("TESTLOGIN");
      expect(redact(`host ${HOST} refused`)).to.not.include(HOST);
      expect(redact(`schema ${SCHEMA} scanned`)).to.not.include(SCHEMA);
      expect(redact(`{"user":"TESTLOGIN"}`)).to.equal(`{"user":"***"}`);
      expect(redact(`WHERE S = '${SCHEMA}'`)).to.not.include(SCHEMA);
      expect(redact("nothing secret here")).to.equal("nothing secret here");
      expect(canWrite({non_select_on_schema: {kinds: ["USER ADMIN"]}})).to.equal(true);
      expect(canWrite({non_select_on_schema: false})).to.equal(false);
    });
  });
});
