// "OSD: Extract my code from HANA" (editors/vscode/hana-extract-command.js),
// the whole command flow with a VS Code API stub, the REAL forked helper
// (hana-extract-host.mjs through test/osd-hana/vscode-test-host.mjs) and the
// REAL tools/osd-hana module against the FAKE sidecar and the FAKE hdb client
// -- no network, no database. Every guard has a named mutation beside its
// test; each was confirmed RED (see the job report).
import {expect} from "chai";
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import path from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";

import {buildExtractFixtures} from "./osd-hana/extract-fixtures.mjs";
import {targetKey} from "../tools/osd-hana/sidecar.mjs";

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
  const settings = new Map(Object.entries(script.settings ?? {}));
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
        get: (key, fallback) => (settings.has(key) ? settings.get(key) : fallback),
        update: async (key, value, target) => { rec.settings.push({key, value, target}); settings.set(key, value); },
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
function startCommand(script = {}, {sidecarExtraEnv = {}, pin = pinPath, dump = fakePath, clientLog} = {}) {
  const stub = vscodeStub(script);
  const env = {
    ...process.env,
    OSD_HANA_DUMP: dump,
    OSD_HANA_VSCODE_TEST: JSON.stringify({pinFile: pin, clientLog, sidecarExtraEnv: {
      FAKE_SIDECAR_RECORD: recordPath, FAKE_SIDECAR_LIST: fixtures.list, FAKE_SIDECAR_DUMP: fixtures.dump, ...sidecarExtraEnv}}),
  };
  delete env.OSD_HANA_PASSWORD;
  registerHanaExtractCommand(stub.api, stub.context, stub.output, () => [ROOT], {hostScript: TEST_HOST, env, tmpdir: root, sidecar: noBundledSidecar});
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
  copyFileSync(FAKE_SIDECAR, fakePath);
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
    expect(Object.keys(setting.items.properties)).to.deep.equal(["host", "port", "database", "user"]);
    expect(setting.items.additionalProperties).to.equal(false);
  });

  it("plan rows: actions first, then the plan read-only; names from the database are escaped", () => {
    const items = planItems({inScope: 3, bytes: 2_500_000, localAuthors: 2,
      perType: [{type: "CLAS", inScope: 2, bytes: 2_000_000, unsupported: 0}, {type: "SICF", inScope: 1, bytes: 0, unsupported: 1}],
      perAuthor: [{author: "A\u001b[2K", objects: 1, bytes: 1}, {author: "B", objects: 2, bytes: 2}], biggest: []});
    expect(items[0]).to.include({label: "$(cloud-download) Extract 3 objects (2.5 MB)"});
    expect(items.filter((i) => i.action?.kind === "narrow").map((i) => i.label)).to.deep.equal([
      "$(person) Only the local objects of A\\x1b[2K", "$(person) Only the local objects of B", "$(filter) Leave local packages ($...) out"]);
    expect(items.find((i) => i.label === "SICF").detail).to.match(/cannot be written yet/);
    expect(JSON.stringify(items)).to.not.include("\u001b");
  });
});
