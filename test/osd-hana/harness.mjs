// Shared fixtures for the osd-hana test files (test/osd-hana-doctor.mjs and
// test/osd-hana-reader.mjs): the FAKE sidecar bed, the io capture and the
// constants. Fakes only -- no network, no database.
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

import {doctorMain} from "../../tools/osd-hana/doctor.mjs";
import {targetKey} from "../../tools/osd-hana/sidecar.mjs";
import {fileSecretStore} from "../../tools/osd-hana/secret-store.mjs";
import {readerStoreKey} from "../../tools/osd-hana/reader.mjs";

export const FAKE_SIDECAR = fileURLToPath(new URL("./fake-sidecar.mjs", import.meta.url));
export const PASSWORD = "correct-horse-battery-staple-42";
export const USER = "TESTLOGIN";
export const HOST = "hana.example.test";
export const SCHEMA = "TE" + "STSCHEMA"; // a fixture name, deliberately not any real one

// One harness per test file: its own tmpdir, fake sidecar copy, pin and
// captured io. `out`/`err` are refreshed by every runDoctor call.
export function makeHarness() {
  const h = {
    root: undefined,
    fakePath: undefined,
    pinPath: undefined,
    recordPath: undefined,
    out: [],
    err: [],
  };

  h.captureIo = () => {
    const lines = {out: [], err: []};
    return {lines, io: {
      out: (line) => lines.out.push(line),
      err: (line) => lines.err.push(line),
    }};
  };

  h.allText = () => `${h.out.join("\n")}\n${h.err.join("\n")}`;

  h.sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

  h.makePin = ({targets = {[targetKey()]: h.sha256(h.fakePath)}, ...rest} = {}) => {
    const path = join(h.root, `pin-${Math.random().toString(16).slice(2)}.json`);
    writeFileSync(path, JSON.stringify({
      name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40),
      schema: 1, read_only: true, targets, ...rest,
    }));
    return path;
  };

  h.before = function () {
    h.root = mkdtempSync(join(tmpdir(), "osd-hana-test-"));
    h.fakePath = join(h.root, "fake-sidecar");
    // The fake must be spawnable directly, like the real Go binary.
    copyFileSync(FAKE_SIDECAR, h.fakePath);
    chmodSync(h.fakePath, 0o755);
    h.pinPath = h.makePin();
    h.recordPath = join(h.root, "record.ndjson");
  };

  h.after = function () {
    rmSync(h.root, {recursive: true, force: true});
  };

  // The full doctor run against the fake sidecar: real spawn, real sha256 --
  // only the database behind the fake is not real. The generated test pin
  // rides the trusted `pinFile` seam (S-E: a pin handed to the CLI as
  // --sidecar-pin is never "the module's own"); `argvPin` exists for the
  // tests that exercise exactly that CLI path.
  h.runDoctor = async (argv, {
    scenario = "owner-tenant",
    handshakePatch,
    env = {},
    isTTY = false,
    deps = {},
    pin = h.pinPath,
    argvPin,
  } = {}) => {
    const capturedIo = h.captureIo();
    h.out = capturedIo.lines.out;
    h.err = capturedIo.lines.err;
    const runEnv = {
      // the child is a shebang script: it needs the real PATH to find node
      ...process.env,
      OSD_HANA_DUMP: h.fakePath,
      OSD_HANA_PASSWORD: PASSWORD,
      FAKE_SIDECAR_PROBE: scenario,
      ...(handshakePatch !== undefined ? {FAKE_SIDECAR_HANDSHAKE: JSON.stringify(handshakePatch)} : {}),
      ...env,
    };
    // The fake sidecar's knobs are TEST-ONLY env vars; with the child
    // environment now an allowlist (critic S-2) they reach the child only
    // through the doctor's explicit extraEnv seam -- the production doctor
    // passes none.
    const sidecarExtraEnv = {
      FAKE_SIDECAR_PROBE: scenario,
      ...(handshakePatch !== undefined ? {FAKE_SIDECAR_HANDSHAKE: JSON.stringify(handshakePatch)} : {}),
      ...(env.FAKE_SIDECAR_RECORD !== undefined ? {FAKE_SIDECAR_RECORD: env.FAKE_SIDECAR_RECORD} : {}),
      ...(env.FAKE_SIDECAR_ECHO_SCHEMA !== undefined ? {FAKE_SIDECAR_ECHO_SCHEMA: env.FAKE_SIDECAR_ECHO_SCHEMA} : {}),
    };
    return doctorMain([
      "--host", HOST, "--port", "39015", "--user", USER, "--schema", SCHEMA,
      ...(argvPin !== undefined ? ["--sidecar-pin", argvPin] : []),
    ].concat(argv), {
      io: capturedIo.io,
      env: runEnv,
      stdin: {isTTY},
      isTTY,
      sidecarTimeoutMs: 500,
      sidecarExtraEnv,
      ...(argvPin !== undefined ? {} : {pinFile: pin}),
      ...deps,
    });
  };

  // A fresh file-backed secret store per call.
  h.store = () => fileSecretStore(join(h.root, `secrets-${Math.random().toString(16).slice(2)}`));

  // A store seeded with the entry drop-reader demands: an exact match of
  // host + port + database + name, the record this tool would have written.
  h.seedStore = (secretStore, connection, name = "OSD_READER", password = "gone-soon-42", extra = {}) => {
    secretStore.set(
      {user: name, password, schema: SCHEMA, host: connection.host, port: connection.port, database: connection.database, ...extra},
      readerStoreKey(connection, name));
  };

  return h;
}
