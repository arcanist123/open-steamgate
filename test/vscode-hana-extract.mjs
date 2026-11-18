// "OSD: Extract my code from HANA" (editors/vscode/hana-extract-command.js),
// the whole command flow with a VS Code API stub, the REAL forked helper
// (hana-extract-host.mjs through test/osd-hana/vscode-test-host.mjs) and the
// REAL tools/osd-hana module against the FAKE sidecar and the FAKE hdb client
// -- no network, no database. Every guard has a named mutation beside its
// test; each was confirmed RED (see the job report).
import {expect} from "chai";
import {createHash} from "node:crypto";
import {EventEmitter} from "node:events";
import {chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {buildExtractFixtures} from "./osd-hana/extract-fixtures.mjs";
import {targetKey} from "../tools/osd-hana/sidecar.mjs";
import {CONTRACT_DIR} from "./osd-hana/harness.mjs";

const require = createRequire(import.meta.url);
const {registerHanaExtractCommand, findModuleRoot, planItems, SECRET_PREFIX} =
  require("../editors/vscode/hana-extract-command.js");

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FAKE_SIDECAR = fileURLToPath(new URL("./osd-hana/fake-sidecar.mjs", import.meta.url));
const TEST_HOST = fileURLToPath(new URL("./osd-hana/vscode-test-host.mjs", import.meta.url));
const PASSWORD = "correct-horse-battery-staple-42";
const OWNER_PASSWORD = "owner-secret-horse-77";
const HOST = "hana.example.test";

let root;
let fakePath;
let pinPath;
let recordPath;
let fixtures;
let cleanFixtures; // CLAS + INTF only: a run that exits 0

const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const makePin = (binary) => {
  const file = path.join(root, `pin-${Math.random().toString(16).slice(2)}.json`);
  writeFileSync(file, JSON.stringify({name: "osd-hana-dump", version: "v9.9.9-test", commit: "a".repeat(40),
    schema: 1, read_only: true, targets: {[targetKey()]: sha256(binary)}}));
  return file;
};
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; }
};
// tests set OSD_HANA_DUMP: hana-sidecar.js's callerPathFor then answers undefined
const noBundledSidecar = {callerPathFor: () => undefined};
const recordLines = () => {
  try { return readFileSync(recordPath, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)); }
  catch { return []; }
};

/** A scripted VS Code: every question the command asks is answered by the
 *  script, and EVERYTHING the command shows or stores is recorded, so the
 *  secret checks can read one place. */
function vscodeStub(script = {}) {
  const rec = {inputs: [], picks: [], messages: [], output: [], progress: [], commands: [], settings: [], secrets: new Map(), secretOps: [], dialogs: []};
  // the user (global) value and a workspace value, as VS Code keeps them apart
  const settings = new Map(Object.entries(script.settings ?? {}));
  const workspaceSettings = new Map(Object.entries(script.workspaceSettings ?? {}));
  const cancelHooks = [];
  const answerMessage = (kind) => async (text, ...rest) => {
    const options = typeof rest[0] === "object" && rest[0] !== null ? rest.shift() : {};
    rec.messages.push({kind, text, options, buttons: rest});
    return (script.message ?? defaultMessage)(text, rest, options);
  };
  const api = {
    Uri: {file: (fsPath) => ({scheme: "file", fsPath})},
    ProgressLocation: {Notification: 15},
    QuickPickItemKind: {Separator: -1},
    ConfigurationTarget: {Global: 1},
    window: {
      showInputBox: async (options) => { rec.inputs.push(options); return (script.input ?? defaultInput)(options); },
      showQuickPick: async (items, options) => { rec.picks.push({items, options}); return (script.pick ?? defaultPick)(items, options); },
      showOpenDialog: async (options) => { rec.dialogs.push(options); return script.folder === undefined ? undefined : [{scheme: "file", fsPath: script.folder}]; },
      showInformationMessage: answerMessage("info"),
      showWarningMessage: answerMessage("warning"),
      showErrorMessage: answerMessage("error"),
      withProgress: async (options, task) => {
        rec.progress.push(options.title);
        const token = {isCancellationRequested: false, onCancellationRequested: (fn) => { cancelHooks.push(() => { token.isCancellationRequested = true; fn(); }); }};
        return task({report: (value) => rec.progress.push(value.message)}, token);
      },
    },
    workspace: {
      getConfiguration: () => ({
        get: (key, fallback) => (workspaceSettings.has(key) ? workspaceSettings.get(key) : settings.has(key) ? settings.get(key) : fallback),
        inspect: (key) => ({key, globalValue: settings.get(key), workspaceValue: workspaceSettings.get(key)}),
        update: async (key, value, target) => { rec.settings.push({key, value, target}); (target === 1 ? settings : workspaceSettings).set(key, value); },
      }),
    },
    commands: {
      registerCommand: (name, run) => { rec.command = name; rec.run = run; return {dispose() {}}; },
      executeCommand: async (...args) => { rec.commands.push(args); },
    },
  };
  const context = {
    subscriptions: [],
    extensionUri: {fsPath: path.join(root, "no-extension")},
    extensionPath: path.join(root, "no-extension"),
    secrets: {
      get: async (key) => { rec.secretOps.push(["get", key]); return rec.secrets.get(key); },
      // SecretStorage is asynchronous (the OS keychain): the write lands a beat later
      store: async (key, value) => { rec.secretOps.push(["store", key]); await new Promise((r) => setTimeout(r, 750)); rec.secrets.set(key, value); },
      delete: async (key) => { rec.secretOps.push(["delete", key]); rec.secrets.delete(key); },
    },
  };
  const output = {appendLine: (line) => rec.output.push(line), append: (text) => rec.output.push(text), show: () => {}};
  rec.cancel = () => { for (const hook of cancelHooks.splice(0)) hook(); };
  // every string the command put anywhere a person or a file can see it
  rec.everything = () => JSON.stringify({inputs: rec.inputs, picks: rec.picks, messages: rec.messages, output: rec.output,
    progress: rec.progress, commands: rec.commands, settings: rec.settings, dialogs: rec.dialogs});
  return {api, context, output, rec};
}

function defaultInput(options) {
  const title = options.title ?? "";
  if (/host/.test(title)) return HOST;
  if (/port/.test(title)) return "39015";
  if (/tenant database/.test(title)) return "";
  if (/user \(4\/4\)/.test(title)) return "TESTLOGIN";
  if (/password for TESTLOGIN/.test(title)) return PASSWORD;
  return undefined;
}
function defaultPick(items) {
  return items.find((item) => item.action?.kind === "extract") ?? items[0];
}
function defaultMessage(text, buttons) {
  if (/is ready to extract/.test(text)) return buttons[0];
  if (/^Extract \d+ objects/.test(text)) return "Extract";
  return undefined;
}

/** Registers the command against the stub and starts it; `done` settles
 *  when the command does. */
function startCommand(script = {}, {sidecarExtraEnv = {}, pin = pinPath, dump = fakePath, clientLog, homes = [ROOT], consentTimeoutMs} = {}) {
  const stub = vscodeStub(script);
  const env = {
    ...process.env,
    OSD_HANA_DUMP: dump,
    OSD_HANA_VSCODE_TEST: JSON.stringify({pinFile: pin, clientLog, consentTimeoutMs, sidecarExtraEnv: {
      FAKE_SIDECAR_RECORD: recordPath, FAKE_SIDECAR_LIST: fixtures.list, FAKE_SIDECAR_DUMP: fixtures.dump, ...sidecarExtraEnv}}),
  };
  delete env.OSD_HANA_PASSWORD;
  registerHanaExtractCommand(stub.api, stub.context, stub.output, () => homes, {hostScript: TEST_HOST, env, tmpdir: root, sidecar: noBundledSidecar});
  const from = recordLines().length;
  stub.runs = () => recordLines().slice(from).map((r) => r.argv[0]);
  stub.done = stub.rec.run();
  return stub;
}

async function runCommand(script, options) {
  const stub = startCommand(script, options);
  await stub.done;
  return stub;
}

/** A copy of a list fixture whose objects.jsonl the test may rewrite. */
const listCopy = (from, name) => {
  const dir = path.join(root, name);
  rmSync(dir, {recursive: true, force: true});
  cpSync(from, dir, {recursive: true});
  return dir;
};
const keepRows = (dir, names) => {
  const file = path.join(dir, "objects.jsonl");
  writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => l && names.includes(JSON.parse(l).name)).join("\n") + "\n");
};

const REAL_MODULE = path.join(ROOT, "tools", "osd-hana");
/** A home whose tools/osd-hana is a FAKE module: the helpers the command
 *  imports re-exported from the real one, doctor.mjs / extract.mjs given. */
function fakeModuleHome(name, {doctor = "export async function doctorMain() { return 1; }\n", extract = "export async function extractMain() { return 1; }\n"} = {}) {
  const home = path.join(root, name);
  const dir = path.join(home, "tools", "osd-hana");
  rmSync(home, {recursive: true, force: true});
  mkdirSync(dir, {recursive: true});
  for (const file of ["reader-shared.mjs", "extract-plan.mjs", "verdict.mjs"]) {
    writeFileSync(path.join(dir, file), `export * from ${JSON.stringify(pathToFileURL(path.join(REAL_MODULE, file)).href)};\n`);
  }
  writeFileSync(path.join(dir, "doctor.mjs"), doctor);
  writeFileSync(path.join(dir, "extract.mjs"), extract);
  return home;
}

const freshOut = (name) => {
  const out = path.join(root, name);
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  return out;
};

before(function () {
  root = mkdtempSync(path.join(tmpdir(), "osd-vscode-hana-"));
  fixtures = buildExtractFixtures(path.join(root, "fixtures"));
  const clean = buildExtractFixtures(path.join(root, "fixtures-clean"));
  for (const dir of [clean.list, clean.dump]) {
    const file = path.join(dir, "objects.jsonl");
    writeFileSync(file, readFileSync(file, "utf8").split("\n").filter((l) => l && ["ZCL_OSD_X1", "ZIF_OSD_X2"].includes(JSON.parse(l).name)).join("\n") + "\n");
  }
  cleanFixtures = clean;
  fakePath = path.join(root, "fake-sidecar");
  // the fake serves the RECORDED contracts (test/osd-hana/contract/); a copy
  // outside test/ gets the directory baked in, as the doctor harness does
  writeFileSync(fakePath, readFileSync(FAKE_SIDECAR, "utf8").replace("__CONTRACT_DIR__", CONTRACT_DIR.replaceAll("\\", "\\\\")));
  chmodSync(fakePath, 0o755);
  pinPath = makePin(fakePath);
  recordPath = path.join(root, "record.ndjson");
});

after(function () {
  rmSync(root, {recursive: true, force: true});
});

describe("VS Code: Extract my code from HANA", function () {
  this.timeout(60000);

  it("the sidecar comes from hana-sidecar.js's callerPathFor(context.extensionPath, {env}) and reaches the module as callerPath", async () => {
    const calls = [];
    const stub = vscodeStub({message: () => undefined});
    const env = {...process.env, OSD_HANA_VSCODE_TEST: JSON.stringify({pinFile: pinPath, sidecarExtraEnv: {FAKE_SIDECAR_LIST: fixtures.list, FAKE_SIDECAR_DUMP: fixtures.dump}})};
    delete env.OSD_HANA_DUMP;
    // a "bundled" binary: the fake, handed in as callerPath (no OSD_HANA_DUMP anywhere)
    registerHanaExtractCommand(stub.api, stub.context, stub.output, () => [ROOT], {hostScript: TEST_HOST, env, tmpdir: root,
      sidecar: {callerPathFor: (extensionPath, options) => { calls.push([extensionPath, options.env]); return fakePath; }}});
    await stub.rec.run();
    expect(calls).to.have.lengthOf(1);
    expect(calls[0][0]).to.equal(stub.context.extensionPath);
    expect(calls[0][1]).to.equal(env);
    expect(stub.rec.messages.find((m) => /is ready to extract/.test(m.text)), "the doctor ran on the handed-in binary").to.not.equal(undefined);
  });

  for (const code of ["OSD_HANA_UNSUPPORTED_TARGET", "OSD_HANA_NO_SIDECAR"]) {
    it(`${code} is shown as its plain message and nothing is asked (mutation: the locator's errors rethrown / the locator not consulted)`, async () => {
      const stub = vscodeStub();
      const failing = {callerPathFor: () => { throw Object.assign(new Error(`osd hana: plain text for ${code}`), {code}); }};
      registerHanaExtractCommand(stub.api, stub.context, stub.output, () => [ROOT], {hostScript: TEST_HOST, env: {PATH: process.env.PATH}, tmpdir: root, sidecar: failing});
      await stub.rec.run();
      expect(stub.rec.inputs).to.have.lengthOf(0);
      expect(stub.rec.messages.map((m) => [m.kind, m.text])).to.deep.equal([["error", `osd hana: plain text for ${code}`]]);
    });
  }

  it("finds the module in the first home that carries both verbs", () => {
    expect(findModuleRoot([undefined, "/nowhere", ROOT])).to.equal(path.join(ROOT, "tools", "osd-hana"));
    expect(findModuleRoot(["/nowhere"])).to.equal(undefined);
  });

  it("happy path: doctor, plan, folder, consent, extract; exit 0 opens the report, remembers the connection without a password (mutation: the plan's numbers not shown)", async () => {
    const out = freshOut("happy");
    const stub = await runCommand({folder: out, message: (text, buttons) => (/Remember/.test(text) ? "Remember" : defaultMessage(text, buttons))},
      {sidecarExtraEnv: {FAKE_SIDECAR_LIST: cleanFixtures.list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}});
    const texts = stub.rec.messages.map((m) => m.text);
    expect(stub.runs(), texts.join("\n")).to.deep.equal(["--version", "probe", "--version", "list", "--version", "list", "dump"]);
    const ready = stub.rec.messages.find((m) => /is ready to extract/.test(m.text));
    expect(ready.options.modal).to.equal(true);
    expect(ready.options.detail).to.match(/Verdict for the ABAP rescue/).and.match(/Ready to extract: yes/);
    const plan = stub.rec.picks.find((p) => /^Plan: 2 objects/.test(p.options.title));
    expect(plan, "the plan quick pick").to.not.equal(undefined);
    expect(plan.items.map((i) => i.label)).to.include.members(["Per type", "CLAS", "INTF", "Per author (local objects)", "DEVUSER"]);
    expect(texts).to.include(`Extract 2 objects (0.0 MB) into ${out}?`);
    const done = stub.rec.messages.find((m) => /^osd: Extracted into/.test(m.text));
    expect(done.kind).to.equal("info");
    expect(done.text).to.match(/2 objects written/);
    expect(stub.rec.commands).to.deep.include(["markdown.showPreview", {scheme: "file", fsPath: path.join(out, "extract-report.md")}]);
    expect(existsSync(path.join(out, ".abapgit.xml"))).to.equal(true);
    expect(stub.rec.settings).to.deep.equal([{key: "hanaExtract.connections", value: [{host: HOST, port: 39015, user: "TESTLOGIN"}], target: 1}]);
    expect(stub.rec.everything()).to.not.include(PASSWORD);
    const dialog = stub.rec.dialogs[0];
    expect(dialog).to.include({canSelectFolders: true, canSelectFiles: false});
  });

  it("Only package…: the pattern asked in an input box narrows the listing and the run to --package, without the default local scope (mutation: the step removed / the pattern not passed)", async () => {
    const out = freshOut("only-package");
    let asked = false;
    const stub = await runCommand({
      folder: out,
      pick: (items, options) => {
        if (/^Plan:/.test(options.title) && !asked) { asked = true; return items.find((i) => i.action?.askPackage); }
        return defaultPick(items);
      },
      input: (options) => (/only package/.test(options.title ?? "") ? " $osd_x* " : defaultInput(options)),
    }, {sidecarExtraEnv: {FAKE_SIDECAR_LIST: cleanFixtures.list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}});
    const box = stub.rec.inputs.find((o) => /only package/.test(o.title ?? ""));
    expect(box, "the input box was shown").to.not.equal(undefined);
    expect(box.validateInput("")).to.be.a("string");
    expect(box.validateInput("$ZORK%")).to.equal(undefined);
    const lists = recordLines().filter((r) => r.argv[0] === "list").slice(-2).map((r) => r.request);
    expect(lists[0].packages, "the narrowed listing and the run").to.deep.equal(["$OSD_X%"]);
    expect(lists[0].local).to.equal(undefined);
    expect(lists[1].packages).to.deep.equal(["$OSD_X%"]);
    expect(stub.runs()).to.include("dump");
    expect(stub.rec.picks.filter((p) => /^Plan:/.test(p.options.title))).to.have.lengthOf(2);
  });

  it("partial (exit 3) is a WARNING carrying the report's top sentence, not an error (mutation: exit 3 mapped to the error path)", async () => {
    const out = freshOut("partial");
    const stub = await runCommand({folder: out});
    const report = readFileSync(path.join(out, "extract-report.md"), "utf8").split("\n")[2];
    const partial = stub.rec.messages.find((m) => /Extracted only in part/.test(m.text));
    expect(partial, stub.rec.messages.map((m) => m.text).join("\n")).to.not.equal(undefined);
    expect(partial.kind).to.equal("warning");
    expect(partial.text).to.include(report);
    expect(stub.rec.messages.some((m) => m.kind === "error")).to.equal(false);
  });

  it("declining the extract consent sends no dump: the sidecar never sees `dump`, nothing is written (mutation: the consent modal's answer ignored)", async () => {
    const out = freshOut("declined");
    const stub = await runCommand({folder: out, message: (text, buttons) => (/^Extract \d+ objects/.test(text) ? undefined : defaultMessage(text, buttons))});
    expect(stub.runs()).to.not.include("dump");
    expect(readdirSync(out), "the dry-run lists into a scratch folder; the chosen folder is untouched").to.deep.equal([]);
  });

  it("the dry-run's scratch folder is removed; the plan never lands in the user's folder", async () => {
    const before = readdirSync(root).filter((n) => n.startsWith("osd-hana-plan-"));
    await runCommand({folder: undefined});
    expect(readdirSync(root).filter((n) => n.startsWith("osd-hana-plan-"))).to.deep.equal(before);
  });

  it("exit 2 and exit 5 each say their plain message (mutation: one generic failure text)", async () => {
    const connect = await runCommand({}, {sidecarExtraEnv: {FAKE_SIDECAR_PROBE: "connect-error"}});
    expect(connect.rec.messages.at(-1)).to.include({kind: "error"});
    expect(connect.rec.messages.at(-1).text).to.match(/^osd: Cannot connect or log on to the database: cannot connect or log on: logon failed/);
    const none = await runCommand({}, {sidecarExtraEnv: {FAKE_SIDECAR_PROBE: "unsupported"}});
    expect(none.rec.messages.at(-1).text).to.equal("osd: No ABAP schema was found on this database -- there is no ABAP code to rescue here.");
  });

  it("an extract refused output folder (exit 4) says so plainly (mutation: exit 4 shown as a generic stop)", async () => {
    const out = freshOut("foreign");
    writeFileSync(path.join(out, "somebody-elses.txt"), "x\n");
    const stub = await runCommand({folder: out});
    expect(stub.rec.messages.at(-1).text).to.match(/^osd: That output folder was refused/);
    expect(stub.runs()).to.not.include("dump");
    expect(readFileSync(path.join(out, "somebody-elses.txt"), "utf8")).to.equal("x\n");
  });

  it("a login that can write gets the module's read-only sentence and the reader offer; declining the SQL consent sends NOTHING (mutation: the consent answer hard-wired to yes)", async () => {
    const clientLog = path.join(root, "client-decline.ndjson");
    const stub = await runCommand({
      message: (text, buttons) => {
        if (/is ready to extract/.test(text)) return "Create a read-only user first…";
        if (/Run these statements/.test(text)) return "No";
        return undefined;
      },
    }, {sidecarExtraEnv: {FAKE_SIDECAR_PROBE: "roles"}, clientLog});
    const ready = stub.rec.messages.find((m) => /is ready to extract/.test(m.text));
    expect(ready.options.detail).to.include("Extraction is safe with this login even though it can write");
    expect(ready.buttons).to.deep.equal(["Extract with this login", "Create a read-only user first…"]);
    const consent = stub.rec.messages.find((m) => /Run these statements/.test(m.text));
    expect(consent.options.modal).to.equal(true);
    expect(consent.options.detail).to.include("CREATE USER OSD_READER PASSWORD \"***reader-password***\"");
    expect(consent.options.detail).to.include("GRANT SELECT ON SCHEMA \"TESTSCHEMA\" TO OSD_READER");
    const statements = readFileSync(clientLog, "utf8").split("\n").filter(Boolean).flatMap((l) => JSON.parse(l).statements.map((s) => s.sql));
    expect(statements.filter((sql) => /^(CREATE|ALTER|GRANT|DROP)/.test(sql))).to.deep.equal([]);
    expect(stub.rec.messages.some((m) => m.text === "osd: Declined -- nothing was sent to the database.")).to.equal(true);
    expect([...stub.rec.secrets.keys()]).to.deep.equal([]);
  });

  it("creating the reader: the generated password goes to SecretStorage ONLY, and the extraction then logs on as the reader (mutation: the store write not awaited / store not injected)", async () => {
    const clientLog = path.join(root, "client-create.ndjson");
    const out = freshOut("as-reader");
    const stub = await runCommand({
      folder: out,
      message: (text, buttons) => {
        if (/is ready to extract/.test(text)) return "Create a read-only user first…";
        if (/Run these statements/.test(text)) return "Yes";
        return defaultMessage(text, buttons);
      },
    }, {sidecarExtraEnv: {FAKE_SIDECAR_PROBE: "roles", FAKE_SIDECAR_LIST: cleanFixtures.list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}, clientLog});
    const key = `${SECRET_PREFIX}${HOST}/39015//OSD_READER`;
    expect([...stub.rec.secrets.keys()]).to.deep.equal([key]);
    const entry = JSON.parse(stub.rec.secrets.get(key));
    expect(entry.user).to.equal("OSD_READER");
    expect(entry.password).to.match(/^[A-Za-z0-9]{28}$/);
    const create = readFileSync(clientLog, "utf8").split("\n").filter(Boolean).flatMap((l) => JSON.parse(l).statements).find((s) => /^CREATE USER/.test(s.sql));
    expect(create.sql).to.include(entry.password); // the stored one is the one the database got
    expect(stub.rec.messages.some((m) => /logs on as OSD_READER/.test(m.text))).to.equal(true);
    expect(stub.rec.messages.find((m) => /^osd: Extracted into/.test(m.text))).to.not.equal(undefined);
    const everything = stub.rec.everything();
    expect(everything).to.not.include(PASSWORD);
    expect(everything).to.not.include(entry.password);
    expect(JSON.stringify(stub.rec.settings)).to.not.match(/password/i);
  });

  it("the two-login flow asks the second login in input boxes (the password box hidden) and never shows or stores that password (mutation: the hidden prompt answered by a visible box)", async () => {
    const stub = await runCommand({
      input: (options) => {
        if (/schema owner login/.test(options.title)) return "SCHEMA_OWNER_LOGIN";
        if (/schema owner password/.test(options.title)) return OWNER_PASSWORD;
        return defaultInput(options);
      },
      message: (text) => {
        if (/is ready to extract/.test(text)) return "Create a read-only user first…";
        if (/Run these statements/.test(text)) return "Yes";
        return undefined;
      },
    }, {sidecarExtraEnv: {FAKE_SIDECAR_PROBE: "admin-system"}});
    const name = stub.rec.inputs.find((o) => /schema owner login/.test(o.title));
    expect(name.password).to.not.equal(true);
    const hidden = stub.rec.inputs.find((o) => /schema owner password/.test(o.title));
    expect(hidden.password).to.equal(true);
    expect(stub.rec.everything()).to.not.include(OWNER_PASSWORD);
    const consent = stub.rec.messages.find((m) => /Run these statements/.test(m.text));
    expect(consent.options.detail).to.include("as the ADMINISTRATOR login TESTLOGIN").and.include("as the SCHEMA OWNER login SCHEMA_OWNER_LOGIN");
    expect([...stub.rec.secrets.keys()], "the reader was created and stored").to.have.lengthOf(1);
    const secrets = [...stub.rec.secrets.values()].join("\n");
    expect(secrets).to.not.include(OWNER_PASSWORD);
    expect(secrets).to.not.include(PASSWORD);
  });

  it("cancelling the extraction stops the sidecar child cleanly: the sidecar process is gone and the command says so (mutation: cancel kills only the helper, not its group)", async () => {
    const out = freshOut("cancel");
    const mark = path.join(root, "hang.pid");
    rmSync(mark, {force: true});
    const hang = path.join(root, "hang-sidecar");
    writeFileSync(hang, `#!/usr/bin/env node\nimport {writeFileSync} from "node:fs";\n` +
      `if (process.argv[2] === "dump") { writeFileSync(process.env.HANG_MARK, String(process.pid)); setInterval(() => {}, 1000); }\n` +
      `else { await import(${JSON.stringify(pathToFileURL(FAKE_SIDECAR).href)}); }\n`);
    chmodSync(hang, 0o755);
    const stub = startCommand({folder: out}, {dump: hang, pin: makePin(hang), sidecarExtraEnv: {HANG_MARK: mark}});
    for (let i = 0; i < 800 && !existsSync(mark); i++) await new Promise((r) => setTimeout(r, 25));
    expect(existsSync(mark), "the hanging dump started").to.equal(true);
    const sidecarPid = Number(readFileSync(mark, "utf8"));
    expect(alive(sidecarPid)).to.equal(true);
    stub.rec.cancel();
    await stub.done;
    for (let i = 0; i < 200 && alive(sidecarPid); i++) await new Promise((r) => setTimeout(r, 25));
    expect(alive(sidecarPid), "the sidecar child is gone").to.equal(false);
    const last = stub.rec.messages.at(-1);
    expect(last.kind).to.equal("warning");
    expect(last.text).to.match(/^osd: Cancelled; the reader was stopped/);
    expect(last.text, "a late cancel may leave converted files: said so").to.match(/may hold .*files it had already converted/);
  });

  // ---- the module's own consent, answered from the LIVE plan (critic MUST) --
  for (const [answer, dumped] of [["Extract", true], [undefined, false], ["throw", false]]) {
    it(`the listing changes between the plan and the run: asked again; ${answer === "throw" ? "a failing modal" : answer === undefined ? "dismissing it" : "Extract"} ${dumped ? "dumps" : "sends no dump"} (mutation: the live plan not compared / always yes)`, async () => {
      const out = freshOut(`changed-${String(answer)}`);
      const list = listCopy(cleanFixtures.list, `list-changed-${String(answer)}`);
      const stub = await runCommand({
        folder: out,
        pick: (items, options) => {
          // the plan was shown: the next listing (the real run's) has one object less
          if (/^Plan:/.test(options.title)) keepRows(list, ["ZCL_OSD_X1"]);
          return defaultPick(items);
        },
        message: (text, buttons) => {
          if (/listing changed/.test(text)) {
            if (answer === "throw") throw new Error("the modal failed");
            return answer;
          }
          return defaultMessage(text, buttons);
        },
      }, {sidecarExtraEnv: {FAKE_SIDECAR_LIST: list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}});
      const again = stub.rec.messages.find((m) => /listing changed/.test(m.text));
      expect(again, stub.rec.messages.map((m) => m.text).join("\n")).to.not.equal(undefined);
      expect(again.text).to.match(/now 1 objects/);
      expect(again.options.modal).to.equal(true);
      if (dumped) {
        expect(stub.runs()).to.include("dump");
      } else {
        expect(stub.runs()).to.not.include("dump");
        expect(stub.rec.messages.at(-1).text).to.equal("osd: Declined -- nothing was dumped.");
      }
    });
  }

  it("the same listing is answered without asking again (positive control for the test above)", async () => {
    const out = freshOut("unchanged");
    const stub = await runCommand({folder: out}, {sidecarExtraEnv: {FAKE_SIDECAR_LIST: cleanFixtures.list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}});
    expect(stub.rec.messages.some((m) => /listing changed/.test(m.text))).to.equal(false);
    expect(stub.runs()).to.include("dump");
  });

  // The real module redacts the SIDECAR's stdout with the run's password before
  // it parses it (tools/osd-hana/sidecar.mjs), so a three-character password
  // that occurs in the fake sidecar's own numbers breaks the module before the
  // command is reached. This test therefore runs a FAKE module (doctor + extract
  // speaking the module's --json and consent protocol) and checks the
  // command's side alone: the plan 1234 objects / 1 234 000 bytes carries both
  // passwords, unredacted in the helper and redacted on display.
  const SHORT_DOCTOR = "export async function doctorMain(argv, {io}) { io.out(JSON.stringify({verdict: {abapSchemas: ['S'], canWrite: false}})); return 0; }\n";
  const SHORT_EXTRACT = [
    "import {writeFileSync} from 'node:fs';",
    "import {join} from 'node:path';",
    "const plan = {inScope: 1234, bytes: 1234000, onSystem: 1234, customer: 1234, sap: 0, localAuthors: 1,",
    "  perType: [{type: 'CLAS', inScope: 1234, bytes: 1234000, unsupported: 0}], perAuthor: [], biggest: []};",
    "export async function extractMain(argv, {io, stdin}) {",
    "  const out = argv[argv.indexOf('--out') + 1];",
    "  io.out(JSON.stringify({plan}, null, 1));",
    "  if (argv.includes('--dry-run')) return 0;",
    "  io.out(`extract 1234 objects (1.2 MB) into ${out}? [y/N]`);",
    "  const line = await new Promise((resolve) => { let buf = ''; stdin.on('data', (d) => { buf += d; if (buf.includes('\\n')) resolve(buf.split('\\n')[0]); }); stdin.on('end', () => resolve(buf)); });",
    "  io.out(`answer=${line}`);",
    "  if (line !== 'yes') { io.err('osd hana extract: declined -- nothing was dumped'); return 0; }",
    "  writeFileSync(join(out, 'extract-report.md'), '# report\\n\\n1234 objects written.\\n');",
    "  return 0;",
    "}",
  ].join("\n");
  for (const shortPassword of ["000", "123"]) {
    it(`a short password (${shortPassword}) inside the plan's numbers (1234 objects) does not decide the consent: answered yes, no hang, no false Declined (mutation: the consent read off redacted lines)`, async function () {
      this.timeout(30000);
      const home = fakeModuleHome(`fake-short-${shortPassword}`, {doctor: SHORT_DOCTOR, extract: SHORT_EXTRACT});
      const out = freshOut(`short-${shortPassword}`);
      const stub = await runCommand({
        folder: out,
        input: (options) => (/password for TESTLOGIN/.test(options.title) ? shortPassword : defaultInput(options)),
      }, {homes: [home]});
      const texts = stub.rec.messages.map((m) => m.text);
      expect(texts).to.include(`Extract 1234 objects (1.2 MB) into ${out}?`);
      expect(texts.some((t) => /listing changed/.test(t)), texts.join("\n")).to.equal(false);
      expect(texts).to.not.include("osd: Declined -- nothing was dumped.");
      expect(stub.rec.output).to.include("answer=yes");
      expect(texts.at(-1)).to.match(/^osd: Extracted into/);
      // the display is still redacted: the plan's numbers show masked there
      expect(stub.rec.output.join("\n")).to.include("***");
    });
  }

  // ---- the second redaction fence and database text in notifications --------
  it("the module's own output carrying the password is masked in the output channel and every notification; database text cannot form a link or an icon (mutation: redact.add(login.password) removed)", async () => {
    const home = fakeModuleHome("fake-leaky", {doctor: [
      "export async function doctorMain(argv, {io, env}) {",
      "  io.out(`connecting with ${env.OSD_HANA_PASSWORD}`);",
      "  io.err(`osd hana: refused [open](command:workbench.action.reloadWindow) $(gear) ${env.OSD_HANA_PASSWORD}`);",
      "  return 2;",
      "}",
    ].join("\n")});
    const stub = await runCommand({}, {homes: [home]});
    expect(stub.rec.output.join("\n")).to.include("connecting with ***");
    expect(stub.rec.everything()).to.not.include(PASSWORD);
    const error = stub.rec.messages.at(-1);
    expect(error.kind).to.equal("error");
    expect(error.text).to.equal("osd: Cannot connect or log on to the database: refused \uff3bopen\uff3d(command:workbench.action.reloadWindow) \\$(gear) ***");
  });

  it("an error escaping the flow is redacted before the output channel and the notification (mutation: the catch not redacted)", async () => {
    const stub = await runCommand({message: (text) => {
      if (/is ready to extract/.test(text)) throw new Error(`boom with ${PASSWORD}`);
      return undefined;
    }}, {sidecarExtraEnv: {FAKE_SIDECAR_LIST: cleanFixtures.list, FAKE_SIDECAR_DUMP: cleanFixtures.dump}});
    expect(stub.rec.output.at(-1)).to.equal("osd: boom with ***");
    expect(stub.rec.messages.at(-1)).to.include({kind: "error", text: "osd: boom with ***"});
    expect(stub.rec.everything()).to.not.include(PASSWORD);
  });

  // ---- remembered connections: the user's value only (critic, attack path) --
  it("a workspace value of the connections is ignored and never copied into the user's settings; a stored schema is not read (mutation: get() instead of inspect().globalValue / schema read)", async () => {
    const evil = {host: "evil.example.test", port: 1, user: "EVIL", schema: "EVIL_SCHEMA"};
    // 1. a remembered (global) entry with a schema, and a workspace entry
    const first = await runCommand({
      settings: {"hanaExtract.connections": [{host: HOST, port: 39015, user: "TESTLOGIN", schema: "EVIL_SCHEMA"}]},
      workspaceSettings: {"hanaExtract.connections": [evil]},
    });
    const connections = first.rec.picks.find((p) => /connection/.test(p.options.title ?? ""));
    expect(connections.items.map((i) => i.label)).to.deep.equal([`$(database) TESTLOGIN@${HOST}:39015`, "$(add) New connection…"]);
    expect(recordLines().map((r) => r.argv).flat()).to.not.include("EVIL_SCHEMA");
    expect(first.rec.settings).to.deep.equal([]);
    // 2. nothing global, a workspace entry: the new connection is remembered alone
    const second = await runCommand({
      workspaceSettings: {"hanaExtract.connections": [evil]},
      message: (text, buttons) => (/Remember/.test(text) ? "Remember" : undefined),
    });
    expect(second.rec.inputs[0].title).to.match(/host/);
    expect(second.rec.settings).to.deep.equal([{key: "hanaExtract.connections", value: [{host: HOST, port: 39015, user: "TESTLOGIN"}], target: 1}]);
    expect(JSON.stringify(second.rec.settings)).to.not.include("evil");
  });
});

describe("VS Code: Extract my code from HANA -- the helper answers the module's consent", function () {
  this.timeout(20000);
  const CONSENT_EXTRACT = [
    "export async function extractMain(argv, {io, stdin}) {",
    "  const i = argv.indexOf('--with-plan');",
    "  if (i !== -1) io.out(JSON.stringify({plan: {inScope: Number(argv[i + 1]), bytes: 1000}}));",
    "  io.out('extract 2 objects (0.0 MB) into /x? [y/N]');",
    "  const line = await new Promise((resolve) => { let buf = ''; stdin.on('data', (d) => { buf += d; if (buf.includes('\\n')) resolve(buf.split('\\n')[0]); }); stdin.on('end', () => resolve(buf)); });",
    "  io.out(`answer=${line}`);",
    "  return 0;",
    "}",
  ].join("\n");

  const runExtract = async (argv, {answer, consentTimeoutMs = 10000} = {}) => {
    const {runHost} = await import("../editors/vscode/hana-extract-host.mjs");
    const home = fakeModuleHome("fake-consent", {extract: CONSENT_EXTRACT});
    const proc = new EventEmitter();
    proc.connected = true;
    proc.env = {PATH: process.env.PATH};
    proc.pid = process.pid;
    proc.sent = [];
    const done = new Promise((resolve) => {
      proc.send = (message, callback) => {
        proc.sent.push(message);
        if (message.t === "ask" && answer !== undefined) setImmediate(() => proc.emit("message", {t: "answer", id: message.id, value: answer}));
        if (message.t === "done" || message.t === "fail") resolve(message);
        callback?.();
      };
    });
    proc.disconnect = () => { proc.connected = false; };
    runHost({proc, consentTimeoutMs});
    proc.emit("message", {t: "run", verb: "extract", argv, moduleRoot: path.join(home, "tools", "osd-hana"), password: PASSWORD, confirmed: {inScope: 2, bytes: 1000}});
    const result = await done;
    return {result, sent: proc.sent, asks: proc.sent.filter((m) => m.t === "ask"), lines: proc.sent.filter((m) => m.t === "out").map((m) => m.line)};
  };

  it("no live JSON plan: \"no\" is sent and nobody is asked (mutation: a missing plan answered yes / asked)", async () => {
    const {result, asks, lines} = await runExtract([]);
    expect(lines).to.include("answer=no");
    expect(asks).to.deep.equal([]);
    expect(result).to.include({t: "done", code: 0, consent: "declined"});
  });

  it("the live plan equals the confirmed one: \"yes\" without asking", async () => {
    const {result, asks, lines} = await runExtract(["--with-plan", "2"]);
    expect(lines).to.include("answer=yes");
    expect(asks).to.deep.equal([]);
    expect(result.consent).to.equal("given");
  });

  it("a changed live plan is asked with its numbers; \"yes\" answers yes, anything else no", async () => {
    const yes = await runExtract(["--with-plan", "3"], {answer: "yes"});
    expect(yes.asks).to.have.lengthOf(1);
    expect(yes.asks[0]).to.deep.include({kind: "consent", plan: {inScope: 3, bytes: 1000}});
    expect(yes.lines).to.include("answer=yes");
    const other = await runExtract(["--with-plan", "3"], {answer: ""});
    expect(other.lines).to.include("answer=no");
    expect(other.result.consent).to.equal("declined");
  });

  it("an ask nobody answers times out as \"no\": the helper never waits forever (mutation: the timeout removed)", async () => {
    const {result, asks, lines} = await runExtract(["--with-plan", "3"], {consentTimeoutMs: 300});
    expect(asks).to.have.lengthOf(1);
    expect(lines).to.include("answer=no");
    expect(result.consent).to.equal("declined");
  });

  it("a failing ask is a no", async () => {
    const {decideConsent} = await import("../editors/vscode/hana-extract-host.mjs");
    expect(await decideConsent({livePlan: {inScope: 3, bytes: 1}, confirmed: {inScope: 2, bytes: 1}, askConsent: () => { throw new Error("x"); }})).to.equal(false);
    expect(await decideConsent({livePlan: {inScope: 3, bytes: 1}, confirmed: {inScope: 2, bytes: 1}, askConsent: async () => { throw new Error("x"); }})).to.equal(false);
  });
});

describe("VS Code: Extract my code from HANA -- the helper's environment", function () {
  it("the module env is a copy: stray HANA_* and second-login passwords removed, this run's password added, process.env untouched (mutation: the strip removed)", async () => {
    const {moduleEnv} = await import("../editors/vscode/hana-extract-host.mjs");
    const base = {PATH: "/bin", HANA_DATABASE: "OTHER", HANA_PASSWORD: "stray", OSD_HANA_OWNER_PASSWORD: "stray2", OSD_HANA_DUMP: "/x"};
    const env = moduleEnv(base, PASSWORD);
    expect(env).to.deep.equal({PATH: "/bin", OSD_HANA_DUMP: "/x", OSD_HANA_PASSWORD: PASSWORD});
    expect(base).to.not.have.property("OSD_HANA_PASSWORD");
    expect(process.env.OSD_HANA_PASSWORD).to.not.equal(PASSWORD);
  });
});

describe("VS Code: Extract my code from HANA -- manifest", function () {
  it("contributes the command under the OSD category, with its activation event and a desktop-only palette entry", () => {
    const manifest = JSON.parse(readFileSync(path.join(ROOT, "editors/vscode/package.json"), "utf8"));
    expect(manifest.contributes.commands).to.deep.include({command: "osd.hanaExtract", title: "Extract my code from HANA", category: "OSD"});
    expect(manifest.activationEvents).to.include("onCommand:osd.hanaExtract");
    expect(manifest.contributes.menus.commandPalette).to.deep.include({command: "osd.hanaExtract", when: "!isWeb && !osd.web"});
    const setting = manifest.contributes.configuration.properties["osd.hanaExtract.connections"];
    expect(setting.scope, "a workspace cannot set it").to.equal("application");
    expect(Object.keys(setting.items.properties)).to.deep.equal(["host", "port", "database", "user"]);
    expect(setting.items.additionalProperties).to.equal(false);
  });

  it("plan rows: actions first, then the plan read-only; names from the database are escaped", () => {
    const items = planItems({inScope: 3, bytes: 2_500_000, localAuthors: 2,
      perType: [{type: "CLAS", inScope: 2, bytes: 2_000_000, unsupported: 0}, {type: "SICF", inScope: 1, bytes: 0, unsupported: 1}],
      perAuthor: [{author: "A\u001b[2K", objects: 1, bytes: 1}, {author: "B", objects: 2, bytes: 2}], biggest: [{package: "$(gear)[x](command:y)", objects: 1, bytes: 1}]});
    expect(items[0]).to.include({label: "$(cloud-download) Extract 3 objects (2.5 MB)"});
    expect(items.filter((i) => i.action?.kind === "narrow").map((i) => i.label)).to.deep.equal([
      "$(package) Only package…", "$(person) Only the local objects of A\\x1b\uff3b2K", "$(person) Only the local objects of B", "$(filter) Leave local packages ($...) out"]);
    expect(planItems({inScope: 1, bytes: 1}, {packagePattern: "$Z%"}).some((i) => i.action?.askPackage), "asked once, not offered again").to.equal(false);
    expect(items.find((i) => i.label === "SICF").detail).to.match(/cannot be written yet/);
    expect(JSON.stringify(items)).to.not.include("\u001b");
    expect(items.at(-1).label, "no icon, no link out of a package name").to.equal("\\$(gear)\uff3bx\uff3d(command:y)");
  });
});
