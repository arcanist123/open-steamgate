// The osd-hana doctor module against fakes only (no network, no database, no
// SAP system): sidecar handling (locate / verify / handshake / run / minimal
// child env / per-spawn re-verification) and the doctor's verdicts, exit
// codes and connection input. The dedicated-reader tests live in
// test/osd-hana-reader.mjs; the shared fixtures in test/osd-hana/harness.mjs.
//
// Every guard here has a named mutation behind it: the test goes red when the
// guard is removed. The mutations are listed in REPORT.md next to each test.
import {expect} from "chai";
import {chmodSync, copyFileSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";

import {doctorMain} from "../tools/osd-hana/doctor.mjs";
import {EXIT_OUTCOMES, HandshakeError, Sidecar, SidecarRunError, handshake, loadPin, locateSidecar, resetVerifiedSidecars, runSidecarRaw, targetKey, verifySidecar} from "../tools/osd-hana/sidecar.mjs";
import {UsageError, parseFlags, readEnvFile} from "../tools/osd-hana/connect.mjs";
import {isPublicDefaultPassword, publicDefaultWarning} from "../tools/osd-hana/defaults.mjs";
import {makeRedactor} from "../tools/osd-hana/redact.mjs";
import {SAFETY_NOTE, canWrite} from "../tools/osd-hana/verdict.mjs";
import {FAKE_SIDECAR, HOST, PASSWORD, SCHEMA, USER, makeHarness} from "./osd-hana/harness.mjs";

const h = makeHarness();

before(h.before);
after(h.after);

describe("tools/osd-hana: the osd hana doctor", function () {
  this.timeout(20_000);

  // ------------------------------------------------- sidecar handling
  describe("sidecar handling", function () {
    it("locates the sidecar: OSD_HANA_DUMP wins over the caller's path; neither is a clear refusal", function () {
      // explicit environment wins (mutation: prefer callerPath -> red)
      expect(locateSidecar({env: {OSD_HANA_DUMP: h.fakePath}, callerPath: "/caller/owned/binary"})).to.equal(h.fakePath);
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
      const other = join(h.root, "tampered-sidecar");
      writeFileSync(other, "not the pinned bytes");
      const pin = h.makePin({targets: {[targetKey()]: "f".repeat(64)}});
      let message = "";
      try {
        await verifySidecar(other, {pin: loadPin(pin)});
        expect.fail("should refuse");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("f".repeat(64));
      expect(message).to.include(h.sha256(other));
      expect(message).to.include("refusing");
    });

    it("runs an unpinned sidecar only with --allow-unpinned-sidecar, and says so loudly", async function () {
      const emptyPin = h.makePin({targets: {}});
      await verifySidecar(h.fakePath, {pin: loadPin(emptyPin)}).then(
        () => expect.fail("should refuse"),
        (error) => expect(error.message).to.include("--allow-unpinned-sidecar"));
      const loud = [];
      const result = await verifySidecar(h.fakePath, {
        pin: loadPin(emptyPin), allowUnpinned: true, loud: (line) => loud.push(line),
        // the module caches per process; a fresh path keeps the cache honest
      });
      expect(result.pinned).to.equal(false);
      expect(loud.join("\n")).to.include("UNPINNED");
    });

    it("refuses a handshake that says read_only: false (mutation: drop the check -> red)", async function () {
      await handshake(h.fakePath, {runFn: async () => JSON.stringify({schema: 1, read_only: false, capabilities: ["probe"]})}).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(HandshakeError);
          expect(error.message).to.include("read_only");
        });
    });

    it("refuses a handshake that lacks a capability the verb needs, and names it (mutation: drop the check -> red)", async function () {
      await handshake(h.fakePath, {requiredCapabilities: ["probe"], runFn: async () => JSON.stringify({schema: 1, read_only: true, capabilities: ["list", "dump"]})}).then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(HandshakeError);
          expect(error.message).to.include("probe");
        });
    });

    it("refuses a handshake with the wrong schema, and a pinned binary that says another version", async function () {
      await handshake(h.fakePath, {runFn: async () => JSON.stringify({schema: 2, read_only: true, capabilities: ["probe"]})}).then(
        () => expect.fail("should refuse"),
        (error) => expect(error.message).to.include("schema"));
      const pin = loadPin(h.makePin({version: "v1.2.3", commit: "b".repeat(40)}));
      await handshake(h.fakePath, {pin, runFn: async () => JSON.stringify({schema: 1, read_only: true, capabilities: ["probe"], version: "v9.9.9-test", commit: "a".repeat(40)})}).then(
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
        const sidecar = new Sidecar(h.fakePath, {credentials: {user: USER, password: PASSWORD}, env: process.env, extraEnv: {FAKE_SIDECAR_PROBE: scenario}});
        const run = await sidecar.run("probe");
        expect(run.exit, scenario).to.equal(exit);
        expect(run.outcome, scenario).to.equal(outcome);
      }
    });

    it("hands the child a MINIMAL environment: allowlist plus credentials, never the parent's env (critic S-2; mutation: childEnv = {...env} -> red)", async function () {
      // a child that dumps its whole environment; the marker stands in for
      // every unrelated secret exported in the parent's shell (cloud keys,
      // tokens, another system's HANA_PASSWORD)
      const dumpPath = join(h.root, "env-dump.mjs");
      const dumpOut = join(h.root, "env-dump.json");
      writeFileSync(dumpPath, `#!/usr/bin/env node
import {writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(dumpOut)}, JSON.stringify(process.env));
process.stdout.write(JSON.stringify({ok: true, exit: 0}) + "\\n");
`, {mode: 0o755});
      await runSidecarRaw(dumpPath, ["probe"], {
        env: {...process.env, PARENTS_UNRELATED_SECRET: "sk-live-marker-abcdef123456"},
        credentials: {user: USER, password: PASSWORD},
      });
      const childEnv = JSON.parse(readFileSync(dumpOut, "utf8"));
      expect(childEnv.PARENTS_UNRELATED_SECRET).to.equal(undefined);
      // the two credential variables are the contract's only channel and do arrive
      expect(childEnv.OSD_HANA_PASSWORD).to.equal(PASSWORD);
      expect(childEnv.OSD_HANA_USER).to.equal(USER);
      // the operational allowlist still reaches the child (PATH: the fake
      // sidecar is a shebang script that must find node)
      expect(childEnv.PATH).to.equal(process.env.PATH);
    });

    it("re-verifies the sidecar immediately before EVERY spawn: a swap after verification is refused (critic S-3; mutation: verify once, then spawn the path -> red)", async function () {
      // verify, then overwrite the file in the window before the spawn (the
      // doctor sits at a password prompt for minutes in that window) -- the
      // swapped bytes must not run under the cached 'pinned: true' verdict
      const path = join(h.root, "toctou-sidecar");
      const original = "#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify({ok:true,exit:0})+\"\\n\");\n";
      const swapped = "#!/usr/bin/env node\nprocess.stderr.write(\"RAN THE SWAPPED BINARY\\n\");\n";
      writeFileSync(path, original, {mode: 0o755});
      const pin = h.makePin({targets: {[targetKey()]: h.sha256(path)}});
      resetVerifiedSidecars();
      const verified = await verifySidecar(path, {pin: loadPin(pin)});
      expect(verified.pinned).to.equal(true);
      writeFileSync(path, swapped, {mode: 0o755});
      // a pin in play means every spawn re-verifies the bytes first -- the
      // same wiring doctorMain relies on
      const sidecar = new Sidecar(path, {
        credentials: {user: USER, password: PASSWORD},
        env: process.env,
        pin: loadPin(pin),
      });
      await sidecar.run("probe").then(
        () => expect.fail("the swapped binary ran -- nothing pins the verified bytes to the executed bytes"),
        (error) => expect(error.message).to.include("checksum mismatch"));
    });

    it("stdout must be exactly one JSON line or a refusal, never a guess (critic note; mutation: take the last line -> red)", async function () {
      const sidecar = new Sidecar(h.fakePath, {credentials: {user: USER, password: PASSWORD}, env: process.env, extraEnv: {FAKE_SIDECAR_PROBE: "two-lines"}});
      await sidecar.run("probe").then(
        () => expect.fail("two JSON lines must be refused, not guessed at"),
        (error) => {
          expect(error).to.be.an.instanceof(SidecarRunError);
          expect(error.message).to.include("one JSON line");
        });
    });

    it("caps the child's accumulated output (8 MB) with a clear error (critic note; mutation: no cap -> red)", async function () {
      const sidecar = new Sidecar(h.fakePath, {credentials: {user: USER, password: PASSWORD}, env: process.env, extraEnv: {FAKE_SIDECAR_PROBE: "chatty"}, timeoutMs: 15_000});
      await sidecar.run("probe").then(
        () => expect.fail("a chatty child must be stopped by the cap"),
        (error) => expect(error.message).to.include("8 MB"));
    }).timeout(30_000);

    it("on win32 appends .exe when the given path has no extension and that file exists (critic note; mutation: return the path as given -> red)", function () {
      const base = join(h.root, "win32-sidecar");
      writeFileSync(`${base}.exe`, "fake bytes\n", {mode: 0o755});
      expect(locateSidecar({env: {OSD_HANA_DUMP: base}, platform: "win32"})).to.equal(`${base}.exe`);
      // a path that already has an extension is left alone
      expect(locateSidecar({env: {OSD_HANA_DUMP: `${base}.exe`}, platform: "win32"})).to.equal(`${base}.exe`);
      // and on other platforms nothing is appended
      expect(locateSidecar({env: {OSD_HANA_DUMP: base}, platform: "linux"})).to.equal(base);
    });

    it("names an unsupported target honestly instead of collapsing Windows to win32-x64 (critic note; mutation: collapse -> red)", async function () {
      expect(targetKey("win32", "x64")).to.equal("win32-x64");
      expect(targetKey("win32", "arm64")).to.equal("win32-arm64");
      expect(targetKey("linux", "arm64")).to.equal("linux-arm64");
      expect(targetKey("linux", "ppc64")).to.equal(undefined);
      // a target with no pin is a clear refusal that NAMES it (a fresh path:
      // the verify cache is per path and other tests already hold fakePath)
      const armPath = join(h.root, "sidecar-for-arm-refusal");
      copyFileSync(FAKE_SIDECAR, armPath);
      chmodSync(armPath, 0o755);
      const message = await verifySidecar(armPath, {pin: loadPin(h.pinPath), platform: "win32", arch: "arm64"}).then(
        () => expect.fail("win32-arm64 has no pin and must be refused"),
        (error) => error.message);
      expect(message).to.include("win32-arm64");
      expect(message).to.include("Refusing");
    });

    it("refuses an exit code the contract does not define", async function () {
      const sidecar = new Sidecar(h.fakePath, {credentials: {user: USER, password: PASSWORD}, env: process.env, extraEnv: {FAKE_SIDECAR_PROBE: "weird-exit"}});
      await sidecar.run("probe").then(
        () => expect.fail("should refuse"),
        (error) => {
          expect(error).to.be.an.instanceof(SidecarRunError);
          expect(error.message).to.include("9");
        });
    });

    it("kills a sidecar that never answers (timeout)", async function () {
      const sidecar = new Sidecar(h.fakePath, {credentials: {user: USER, password: PASSWORD}, env: process.env, extraEnv: {FAKE_SIDECAR_PROBE: "hang"}, timeoutMs: 300});
      await sidecar.run("probe").then(
        () => expect.fail("should time out"),
        (error) => expect(error.message).to.include("did not finish within 300 ms"));
    }).timeout(5000);
  });

  // --------------------------------- the doctor: verdicts and exit codes
  describe("the doctor against the fake sidecar", function () {
    it("says the plain verdict for a ready tenant database (exit 0)", async function () {
      const code = await h.runDoctor([], {scenario: "owner-tenant"});
      expect(code).to.equal(0);
      const text = h.allText();
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
      const code = await h.runDoctor([], {scenario: "writer"});
      expect(code).to.equal(0);
      const text = h.allText();
      expect(text.split(SAFETY_NOTE).length - 1).to.equal(1);
      // and for an administrator the class alone is enough to say it
      const code2 = await h.runDoctor([], {scenario: "admin-system", env: {FAKE_SIDECAR_PROBE: "admin-system"}});
      expect(code2).to.equal(0);
      expect(h.allText().split(SAFETY_NOTE).length - 1).to.equal(1);
    });

    it("prints the same findings as one JSON document with --json, and the password is nowhere in it", async function () {
      const code = await h.runDoctor(["--json"], {scenario: "writer"});
      expect(code).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.command).to.equal("osd hana doctor");
      expect(document.verdict.readyToExtract).to.equal(true);
      expect(document.verdict.canWrite).to.equal(true);
      expect(document.connection.user).to.equal(USER);
      expect(document.connection.password).to.equal(undefined);
      expect(JSON.stringify(document)).to.not.include(PASSWORD);
    });

    it("exits 2 when the database cannot be reached or logged on", async function () {
      const code = await h.runDoctor([], {scenario: "connect-error"});
      expect(code).to.equal(2);
      expect(h.allText()).to.include("cannot connect");
    });

    it("exits 5 when there is no ABAP schema (the sidecar says unsupported)", async function () {
      const code = await h.runDoctor([], {scenario: "unsupported"});
      expect(code).to.equal(5);
      const code2 = await h.runDoctor([], {scenario: "no-schema"});
      expect(code2).to.equal(5);
    });

    it("takes the password from the env file when no other channel gives one (critic M-1; mutation: ignore file.HANA_PASSWORD -> red)", async function () {
      // HANA_PASSWORD in --env-file is a documented password channel; a run
      // whose only channel is the env file must work, not refuse
      const envPath = join(h.root, "m1-bed.env");
      const filePassword = "env-file-password-99";
      writeFileSync(envPath, [
        "# M-1: the env file alone must feed the whole connection",
        `HANA_HOST=${HOST}`,
        "HANA_PORT=39015",
        "HANA_DATABASE=TEN",
        `HANA_USER=${USER}`,
        `HANA_PASSWORD=${filePassword}`,
      ].join("\n"));
      const code = await h.runDoctor(["--env-file", envPath], {env: {OSD_HANA_PASSWORD: ""}});
      expect(code, h.allText()).to.equal(0);
      expect(h.allText()).to.not.include(filePassword);
    });

    it("the env file's HANA_PASSWORD ranks above OSD_HANA_PASSWORD (order: --password-stdin > env file > environment > prompt)", async function () {
      // the courtesy check names the password it saw: an env-file password
      // that IS a public default warns even when OSD_HANA_PASSWORD is set
      const envPath = join(h.root, "m1-order.env");
      writeFileSync(envPath, [
        `HANA_HOST=${HOST}`,
        "HANA_PORT=39015",
        `HANA_USER=${USER}`,
        "HANA_PASSWORD=HXEHana1",
      ].join("\n"));
      const code = await h.runDoctor(["--env-file", envPath]);
      expect(code).to.equal(0);
      expect(h.allText()).to.include("public default");
    });

    it("exits 1 on usage errors: no password channel, a stray positional, an unknown flag", async function () {
      // no OSD_HANA_PASSWORD and stdin not a TTY: the doctor refuses instead
      // of hanging, and names the ways a password may arrive
      const code = await h.runDoctor([], {
        env: {OSD_HANA_PASSWORD: ""},
      });
      expect(code).to.equal(1);
      expect(h.allText()).to.include("password");
      expect(h.allText()).to.include("--password-stdin");
      // a stray positional word: the doctor takes --double-dash flags only
      const code2 = await h.runDoctor(["stray-argument"]);
      expect(code2).to.equal(1);
      expect(h.allText()).to.include("--double-dash");
      expect(() => parseFlags(["--nosuchflag"], {valueFlags: [], booleanFlags: []})).to.throw(UsageError);
    });

    it("takes the password from --password-stdin, never from argv", async function () {
      const stdinPassword = "stdin-fed-password-13";
      const {lines, io} = h.captureIo();
      const {PassThrough} = await import("node:stream");
      const stdin = new PassThrough();
      stdin.write(`${stdinPassword}\n`);
      stdin.end();
      const code = await doctorMain(
        ["--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA, "--password-stdin"],
        {io, env: {...process.env, OSD_HANA_DUMP: h.fakePath, FAKE_SIDECAR_PROBE: "owner-tenant"}, stdin, isTTY: false, sidecarTimeoutMs: 500, pinFile: h.pinPath});
      expect(code).to.equal(0);
      expect(JSON.stringify({out: lines.out, err: lines.err})).to.not.include(stdinPassword);
    });

    it("delivers the credentials to the child through the environment only (mutation: put them on argv -> red)", async function () {
      rmSync(h.recordPath, {force: true});
      const code = await h.runDoctor([], {env: {FAKE_SIDECAR_RECORD: h.recordPath}});
      expect(code).to.equal(0);
      const records = readFileSync(h.recordPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
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
      const code = await h.runDoctor([], {
        scenario: "echo-stderr",
        env: {FAKE_SIDECAR_ECHO_SCHEMA: SCHEMA},
      });
      expect(code).to.equal(0);
      // the child's stderr (the err channel) repeats every value of this run;
      // every one of them arrives masked
      const childSide = h.err.join("\n");
      expect(childSide).to.include("***");
      expect(childSide).to.not.include(PASSWORD);
      expect(childSide).to.not.include(USER);
      expect(childSide).to.not.include(HOST);
      expect(childSide).to.not.include(SCHEMA);
      // the password is nowhere in the doctor's own output either (user and
      // host may be, in the verdict -- they are the caller's own input)
      expect(h.allText()).to.not.include(PASSWORD);
    });

    it("redacts everything read from the sidecar's stdout before it is printed or embedded (critic S-1; mutation: redact stderr only -> red)", async function () {
      // the fake repeats the password inside its stdout JSON -- once in the
      // error text, once inside the probe document -- with stderr clean, so
      // stderr-only redaction protects nothing
      const code = await h.runDoctor([], {scenario: "stdout-leak"});
      expect(code).to.equal(2);
      expect(h.allText()).to.include("cannot connect");
      expect(h.allText()).to.not.include(PASSWORD);
      // and the probe document embedded by --json is redacted at the source
      const code2 = await h.runDoctor(["--json"], {scenario: "stdout-leak-doc"});
      expect(code2).to.equal(0);
      expect(h.out.join("\n")).to.not.include(PASSWORD);
      expect(h.err.join("\n")).to.not.include(PASSWORD);
    });

    it("warns loudly when the password is a public trial-image default, and changes nothing", async function () {
      expect(isPublicDefaultPassword("HXEHana1")).to.equal(true);
      expect(isPublicDefaultPassword(PASSWORD)).to.equal(false);
      const code = await h.runDoctor([], {env: {OSD_HANA_PASSWORD: "HXEHana1"}});
      expect(code).to.equal(0);
      expect(h.allText()).to.include("public default");
      expect(h.allText()).to.include("changed nothing");
      expect(publicDefaultWarning()).to.include("ALTER USER");
    });

    it("refuses an unpinned sidecar without the flag, runs it loudly with it", async function () {
      const emptyPin = h.makePin({targets: {}});
      const code = await h.runDoctor([], {pin: emptyPin});
      expect(code).to.equal(1);
      expect(h.allText()).to.include("--allow-unpinned-sidecar");
      const code2 = await h.runDoctor(["--allow-unpinned-sidecar"], {pin: emptyPin});
      expect(code2).to.equal(0);
      expect(h.allText()).to.include("UNPINNED");
    });

    it("with an unpinned sidecar the read-only claim is qualified, in text and in --json (critic S-4; mutation: state the pinned sentence unconditionally -> red)", async function () {
      // the writer scenario makes the probe say the login can write; the
      // binary saying so was NEVER checksum-verified, so the doctor must not
      // state the database-level read-only guarantee as fact
      const emptyPin = h.makePin({targets: {}});
      const code = await h.runDoctor(["--allow-unpinned-sidecar"], {scenario: "writer", pin: emptyPin});
      expect(code).to.equal(0);
      expect(h.allText()).to.include("not checksum-verified");
      expect(h.allText()).to.not.include(SAFETY_NOTE);
      const code2 = await h.runDoctor(["--allow-unpinned-sidecar", "--json"], {scenario: "writer", pin: emptyPin});
      expect(code2).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.verdict.safetyNote).to.include("not checksum-verified");
    });

    it("S-E: a --sidecar-pin other than the module's own never makes a binary 'pinned' -- refused without the flag even when the hash matches (critic S-E; mutation: trust the foreign pin -> red)", async function () {
      // the pin MATCHES the binary byte for byte -- and still must not
      // produce a 'pinned: true': a pin the caller supplies is the caller's
      // claim, not this module's pinning
      const code = await h.runDoctor(["--create-reader"], {
        argvPin: h.pinPath,
      });
      expect(code).to.equal(1);
      expect(h.allText()).to.include("not the module's own pin");
      expect(h.allText()).to.include("--allow-unpinned-sidecar");
    });

    it("S-E: with --allow-unpinned-sidecar a foreign pin runs UNPINNED and the read-only claim stays qualified (mutation: report pinned -> red)", async function () {
      // writer scenario: the login can write; the binary saying so was
      // verified against a CALLER-SUPPLIED pin -- the safety sentence must
      // stay qualified exactly as for any unpinned binary
      const code = await h.runDoctor(["--allow-unpinned-sidecar", "--json"], {
        scenario: "writer",
        argvPin: h.pinPath,
      });
      expect(code).to.equal(0);
      const document = JSON.parse(h.out.join("\n"));
      expect(document.sidecar.pinned).to.equal(false);
      expect(h.allText()).to.include("UNPINNED");
      expect(document.verdict.safetyNote).to.include("not checksum-verified");
    });

    it("exits 2 with the timeout message when the sidecar hangs", async function () {
      const code = await h.runDoctor([], {scenario: "hang"});
      expect(code).to.equal(2);
      expect(h.allText()).to.include("did not finish within");
    }).timeout(5000);
  });

  // ---------------------------------------- redactor and defaults, directly
  describe("the redactor and the courtesy check", function () {
    it("ignores secrets shorter than 3 characters (critic note; mutation: keep 1-char secrets -> red)", function () {
      // user "U" must not turn every capital U in the output into ***
      const redact = makeRedactor(["U", "P", "AB", "secret-password-1"]);
      expect(redact("user U connected to P with AB")).to.equal("user U connected to P with AB");
      expect(redact("logon secret-password-1 accepted")).to.not.include("secret-password-1");
    });

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
