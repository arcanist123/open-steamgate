// A thin VS Code client of a running osd (Q2, docs/vscode-extension.md).
//
// It holds no ABAP and runs nothing itself: the Test Explorer asks the ADT
// façade which test classes an object has and runs them there, the status
// bar reads /osd/serving, and the dump list is /osd/dumps. abaplint stays
// the language server; this adds only what needs a running system.
"use strict";

const {jobsStatusBar, workerEnabled} = require("./job-worker");
const vscode = require("vscode");
const {registerKernelDiagnostics, resolveKernelObjectFile} = require("./kernel-diagnostics.js");
let kernelDiagnostics;
let kernelFindingCount = 0;
const path = require("node:path");
const fs = require("node:fs");
const crypto = require("node:crypto");
const {objectOf, adtObjectOf, breakpointMatches, fileOf, Osd, outcomes, runActionFor, osdRunCommandLine, entitySetLenses, methodAtLine, resultRows, stripMetadata, keyOf,
  readersLensLine, readersLensTitle, readersQuickPickItems, readerFilePattern,
  freestyleTableHtml, freestyleOutputItems, notebookAbapSource, notebookFromJson, notebookToJson, sqlNotebookStarter, htmlEscape,
  hotspotBucket, hotspotColor, hotspotBadge, hotspotHoverText, implementsClassrun,
  dataPreviewObjectOf, tablHasMandt, dataPreviewQuery, dataPreviewCountQuery, dataPreviewStatusText,
  dataPreviewAvailability, dataPreviewError,
  transpileLayers, classifyTestPath, needsPackageSplit, packageOf, hasTestMethods, demoFailureObjects, progRunLens,
  groupServices, serviceLabel, serviceContextValue, serviceActionContext, normalizeTransactionRow,
  transactionDetailsModel, classifyTransactionClick, transactionDetailsHtml,
  appManifestDetails, httpTestFiles, closureTestNames, dumpsForService, serviceCardModel, serviceDetailsHtml,
  serviceHttpUrl, serviceMetadataUrl, serviceMetadataExternalUrl, serviceWsUrl, serviceClassNodes, resolveImplementationMethod,
  webguiPanelHtml, runWebguiPanel,
  warmStatusText, activationBuildText, closureTestsText,
  presetSettings, isOpenSteamgateCheckout: isOpenSteamgateManifest, osdHomeChoice, osdStateContext, systemOverviewModel,
  debuggerConfiguration, debugAttachPlan, runWithDebuggerAttach, breakpointToggleText,
  runningAbapSources, breakpointWarning, taxiDefaultYear, taxiResetPrompt,
  unitRiskOf, unitDurationOf, runUnitQueue, unitPoolSize, riskWarning} = require("./lib.js");
const {Launcher, ensureMaterializedHome, materializedHomeDir, selectOldHomes, listOldHomes, cleanupOldHomes,
  hasLiveServingLock,
  detectWorkspaceLayers, layerContributions, packNameOf, databaseEnv, defaultDedicatedName, describeDatabase,
  isOpenSteamgateCheckout: isOpenSteamgatePath, decideStartTarget, classify, PORT_RANGE, isFree,
  pickInspectorPort, SEED_ID_FILE} = require("./launcher.js");
const {systemOverviewHtml} = require("./system-overview.js");
const {requestBlocks, resolveRequest, servicePathOf} = require("./http-lens.js");
const {dataPreviewHtml, openDataPreview: openDataPreviewView} = require("./data-preview-view.js");
const {
  newSqlNotebook: newSqlNotebookView, sqlNotebookController: sqlNotebookControllerView, sqlNotebookSerializer: sqlNotebookSerializerView,
} = require("./sql-notebook.js");

// Q6a "Notebook SQL, ABAP and SQLScript" (docs/vscode-extension.md): the
// notebook type a *.osdnb file opens as and the controller for its cells.
const NOTEBOOK_TYPE = "osd-sql-notebook";

// One report panel per transaction code. F8 and the CodeLens both reach the
// same command, so a second run should refresh the existing view in place.
const webguiPanels = new Map();
const MANAGED_URL_KEY = "osd.managedUrl";

const EXCLUDE = "{**/node_modules/**,**/.local/**,**/output/**,**/gen/**,**/build/**}";

function osd() {
  const url = vscode.workspace.getConfiguration("osd").get("url", "http://localhost:3030");
  if (osd.client?.url !== url.replace(/\/+$/, "")) osd.client = new Osd(url);
  return osd.client;
}

// ---- B0 "Pocket SAP" spike (docs/vscode-extension.md, "B0 spike"): the
// extension starts and stops the system itself, over editors/vscode/launcher.js
// (the pure half, unit-tested without VS Code in test/vscode-launcher.mjs).
// Everything below is the VS Code glue: which folder is osdHome, where this
// window's own storage is, the tree view, the status bar Start/Stop and
// "Open launchpad".

/** `osd.home` when set, else the workspace folder when the window has
 *  exactly one -- the task's own resolution order. `undefined` when neither
 *  applies (no workspace, or more than one folder and no setting), which
 *  every caller below treats as "nothing to start". */
function osdHomeOf() {
  const configured = vscode.workspace.getConfiguration("osd").get("home", "").trim();
  return osdHomeChoice({configuredHome: configured, workspaces: workspaceDescriptors()})?.path;
}

function workspaceDescriptors() {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => {
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(folder.uri.fsPath, "package.json"), "utf8"));
    } catch {
      manifest = undefined;
    }
    return {
      path: folder.uri.fsPath,
      isOpenSteamgate: isOpenSteamgateManifest(manifest, {
        buildScript: fs.existsSync(path.join(folder.uri.fsPath, "tools", "osd-build.mjs")),
        vscodeExtension: fs.existsSync(path.join(folder.uri.fsPath, "editors", "vscode", "package.json")),
      }),
    };
  });
}

/** Whether this install carries a bundled seed to run (a packaged .vsix,
 *  `scripts/build-vsix.mjs`'s own `extension/osd/`) -- checked by a file
 *  `test/run.mjs` itself needs, not by the directory merely existing,
 *  which a dev install (the symlink from `editors/vscode/` onto this
 *  checkout, `docs/vscode-extension.md`'s "remote/WSL note") never has. */
function bundledSeedDir(context) {
  const dir = path.join(context.extensionUri.fsPath, "osd");
  return fs.existsSync(path.join(dir, "seed.tar.br")) || fs.existsSync(path.join(dir, "test", "run.mjs")) ? dir : undefined;
}

function bundledHomeDir(context, seedDir) {
  const seedId = fs.readFileSync(path.join(seedDir, SEED_ID_FILE), "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(seedId)) throw new Error(`Invalid packaged seed ID in ${seedDir}`);
  return materializedHomeDir(context.globalStorageUri.fsPath, seedId);
}

function materializeBundledHome(context, seedDir, launcher) {
  return ensureMaterializedHome(seedDir, context.globalStorageUri.fsPath, {
    previousHome: launcher?.osdHome,
    onNotice: (line) => { void vscode.window.showInformationMessage(`osd: ${line}`); },
  });
}

const BUNDLED_HOME_PREFERENCE = "osd.startHomePreference";
const START_HOME_PROMPT = "Run the system from this folder? (edits go to your files and git)";
const START_HOME_YES = "Yes";
const START_HOME_NO = "No, use the bundled copy (remembered)";
const START_HOME_ALWAYS_ASK = "Always ask";

/** The remembered "use the bundled copy" answer, as the visible workspace
 *  setting osd.startSource. An answer an older build kept in workspace
 *  storage is moved there once, so it can be seen and undone in Settings. */
async function startSourcePreference(context) {
  if (context.workspaceState.get(BUNDLED_HOME_PREFERENCE) === "bundled") {
    await setStartSource("bundled");
    await context.workspaceState.update(BUNDLED_HOME_PREFERENCE, undefined);
  }
  return vscode.workspace.getConfiguration("osd").get("startSource", "ask") === "bundled" ? "bundled" : undefined;
}

async function setStartSource(value) {
  const target = vscode.workspace.workspaceFolders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  await vscode.workspace.getConfiguration("osd").update("startSource", value, target);
}

/** osd: Choose which system Start runs -- the one place to leave "always
 *  bundled", point Start at a checkout, or go back to asking. */
async function chooseStartSystem(context, controller) {
  const config = vscode.workspace.getConfiguration("osd");
  const folders = vscode.workspace.workspaceFolders;
  const workspaceFolder = folders?.length === 1 ? folders[0].uri.fsPath : undefined;
  const checkout = workspaceFolder !== undefined && isOpenSteamgatePath(workspaceFolder);
  const scope = folders?.length ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
  const home = config.get("home", "").trim();
  const source = config.get("startSource", "ask");
  const items = [];
  if (bundledSeedDir(context)) {
    items.push({label: "$(package) Bundled copy", description: home === "" && source === "bundled" ? "current" : "",
      detail: "The system packaged in this extension, in its own working copy.", pick: "bundled"});
  }
  if (checkout) {
    items.push({label: "$(folder) This workspace folder", description: home === workspaceFolder ? "current" : "",
      detail: workspaceFolder, pick: "workspace"});
  }
  items.push({label: "$(folder-opened) Another open-steamgate checkout...", description: home !== "" && home !== workspaceFolder ? `current: ${home}` : "",
    detail: "Pick a folder; it needs npm install and npm run bootstrap.", pick: "other"});
  items.push({label: "$(question) Ask each time", description: home === "" && source === "ask" ? "current" : "",
    detail: "Start asks when the open folder is an open-steamgate checkout; otherwise it runs the bundled copy.", pick: "ask"});
  const chosen = await vscode.window.showQuickPick(items, {placeHolder: "Which system should osd: Start run?"});
  if (!chosen) return;
  if (chosen.pick === "bundled") {
    await config.update("home", "", scope);
    await setStartSource("bundled");
  } else if (chosen.pick === "workspace") {
    await config.update("home", workspaceFolder, vscode.ConfigurationTarget.Workspace);
    await setStartSource("ask");
  } else if (chosen.pick === "other") {
    const picked = await vscode.window.showOpenDialog({canSelectFolders: true, canSelectFiles: false, canSelectMany: false,
      openLabel: "Run this checkout"});
    if (!picked?.length) return;
    const dir = picked[0].fsPath;
    if (!isOpenSteamgatePath(dir)) {
      void vscode.window.showErrorMessage(`osd: ${dir} is not an open-steamgate checkout (no abap_transpile.json or tools/osd-build.mjs).`);
      return;
    }
    await config.update("home", dir, scope);
    await setStartSource("ask");
  } else {
    await config.update("home", "", scope);
    await setStartSource("ask");
  }
  const restart = "Restart now";
  const answer = await vscode.window.showInformationMessage("osd: the next Start runs the chosen system.", restart);
  if (answer === restart) {
    await controller.stop();
    await controller.start();
  }
}

/** Resolve the pure launcher decision against this VS Code window. A
 *  workspace checkout gets a choice only when a packaged bundled system is
 *  available; development installs without one already run the open folder
 *  as their system. Choosing the bundle is remembered in workspace storage,
 *  while Always ask uses it this time and clears that preference. */
async function resolveStartTarget(context, launcher) {
  const configured = vscode.workspace.getConfiguration("osd").get("home", "").trim();
  const folders = vscode.workspace.workspaceFolders;
  const workspaceFolder = folders?.length === 1 ? folders[0].uri.fsPath : undefined;
  const descriptor = workspaceDescriptors().find((folder) => folder.path === workspaceFolder);
  const checkout = workspaceFolder !== undefined &&
    (isOpenSteamgatePath(workspaceFolder) || descriptor?.isOpenSteamgate === true);
  const seedDir = bundledSeedDir(context);
  const preference = await startSourcePreference(context);
  const facts = {configuredHome: configured, workspaceFolder, workspaceIsOpenSteamgate: checkout,
    bundledHome: seedDir, rememberedChoice: preference};
  let target = decideStartTarget(facts);

  if (target.kind === "prompt") {
    const answer = await vscode.window.showInformationMessage(
      START_HOME_PROMPT, START_HOME_YES, START_HOME_NO, START_HOME_ALWAYS_ASK);
    if (answer === undefined) return {kind: "cancelled"};
    if (answer === START_HOME_YES) {
      await vscode.workspace.getConfiguration("osd").update("home", workspaceFolder, vscode.ConfigurationTarget.Workspace);
      target = decideStartTarget({...facts, configuredHome: workspaceFolder});
    } else {
      if (answer === START_HOME_NO) {
        await setStartSource("bundled");
      } else if (answer === START_HOME_ALWAYS_ASK) {
        await setStartSource("ask");
      } else {
        return {kind: "cancelled"};
      }
      // Always ask still needs a source for this Start. Use the bundle for
      // this run; because the choice was cleared, the next Start asks again.
      target = decideStartTarget({...facts, rememberedChoice: "bundled"});
    }
  }

  if (target.kind === "ready" && target.source === "bundled") {
    target.osdHome = await materializeBundledHome(context, seedDir, launcher);
  }
  return target;
}

function homeSourceText(source) {
  if (source === "workspace") return "from workspace";
  if (source === "bundled") return "bundled copy";
  return undefined;
}

/** Selected home and its visible source. A packaged extension chooses the
 *  bundled copy, except when the open-steamgate checkout itself is open;
 *  DX2 uses that checkout as osd.home so edits reach the system in view. */
function osdHomeChoiceFor(context, homeMode = "auto") {
  const configured = vscode.workspace.getConfiguration("osd").get("home", "").trim();
  const folders = workspaceDescriptors();
  const seedDir = bundledSeedDir(context);
  const bundledHome = seedDir === undefined ? undefined : bundledHomeDir(context, seedDir);
  return {...(osdHomeChoice({configuredHome: configured, workspaces: folders, bundledHome, bundledAvailable: seedDir !== undefined, homeMode}) ?? {}), seedDir};
}

/** Mainline's first-start choice takes precedence in auto mode for a packaged
 *  install opened on the checkout. Other preset modes use DX2's pure choice. */
async function resolveStartChoice(context, homeMode = "auto", launcher) {
  if (homeMode === "auto") {
    const folders = vscode.workspace.workspaceFolders;
    const workspaceFolder = folders?.length === 1 ? folders[0].uri.fsPath : undefined;
    const descriptor = workspaceDescriptors().find((folder) => folder.path === workspaceFolder);
    const checkout = workspaceFolder !== undefined &&
      (isOpenSteamgatePath(workspaceFolder) || descriptor?.isOpenSteamgate === true);
    if (checkout && bundledSeedDir(context) !== undefined) {
      const target = await resolveStartTarget(context, launcher);
      if (target.kind === "cancelled") return target;
      if (target.kind === "ready") {
        return {
          path: target.osdHome,
          kind: target.source === "bundled" ? "bundled copy" : "osd.home",
          source: target.source,
          materialized: target.source === "bundled",
        };
      }
    }
  }

  const choice = osdHomeChoiceFor(context, homeMode);
  if (choice.path === undefined) return undefined;
  const folders = vscode.workspace.workspaceFolders;
  const workspaceFolder = folders?.length === 1 ? folders[0].uri.fsPath : undefined;
  const source = choice.kind === "bundled copy" ? "bundled"
    : choice.path === workspaceFolder ? "workspace" : "configured";
  return {...choice, source};
}

/** Explicit cleanup only: the selection and modal confirmation both finish
 *  before any directory is removed. Re-read the current launcher afterward. */
async function removeOldWorkingCopies(context, controller) {
  const storageDir = context.globalStorageUri.fsPath;
  const sizeLabel = (bytes) => bytes < 1024 * 1024
    ? `${Math.ceil(bytes / 1024)} KiB` : `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
  const currentHome = () => {
    const seedDir = bundledSeedDir(context);
    return seedDir === undefined ? undefined : bundledHomeDir(context, seedDir);
  };
  const servedHome = () => controller.launcher?.state !== "stopped" ? controller.launcher?.osdHome : undefined;
  try {
    const homes = listOldHomes(storageDir, currentHome(), servedHome())
      .filter((home) => !hasLiveServingLock(home.path));
    if (homes.length === 0) {
      await vscode.window.showInformationMessage("osd: No old working copies found.");
      return;
    }
    const picked = await vscode.window.showQuickPick(homes.map((home) => ({
      label: path.basename(home.path),
      description: `${sizeLabel(home.size)} · edited: ${home.edited ? "yes or unknown" : "no"}`,
      detail: home.path,
      home,
    })), {canPickMany: true, placeHolder: "Select old working copies to remove"});
    if (!picked?.length) return;
    const selected = picked.map((item) => item.home.path);
    const answer = await vscode.window.showWarningMessage(
      `Delete ${selected.length} old working ${selected.length === 1 ? "copy" : "copies"}?`,
      {modal: true, detail: selected.join("\n")}, "Delete selected");
    if (answer !== "Delete selected") return;

    const entries = fs.readdirSync(storageDir).map((name) => {
      const home = path.join(storageDir, name);
      return {path: home, isDirectory: fs.lstatSync(home).isDirectory()};
    });
    const eligible = selectOldHomes(entries, currentHome(), servedHome(), selected);
    let removed = 0;
    for (const home of eligible) {
      if (hasLiveServingLock(home.path)) continue;
      fs.rmSync(home.path, {recursive: true});
      removed++;
    }
    await vscode.window.showInformationMessage(`osd: Removed ${removed} old working ${removed === 1 ? "copy" : "copies"}.`);
  } catch (error) {
    await vscode.window.showErrorMessage(`osd: Could not remove old working copies: ${error.message}`);
  }
}

/** Every byte a launch needs beyond osdHome's own tracked files lives here:
 *  the extension's own global storage, one subdirectory per osdHome (a
 *  short hash of its path, so two different checkouts never share a
 *  database or a TLS folder) -- never under osdHome and never under a
 *  workspace folder. */
function storageDirFor(context, osdHome) {
  const hash = crypto.createHash("sha1").update(osdHome).digest("hex").slice(0, 16);
  return path.join(context.globalStorageUri.fsPath, "osd-instance", hash);
}

/** `osd.warm`'s own setting (T7, docs/vscode-extension.md "Warm"): "auto",
 *  "on" or "off", read fresh on every launch the way osd.home is. */
function osdWarmModeOf() {
  return vscode.workspace.getConfiguration("osd").get("warm", "auto");
}

/** Whether to open the inspector **at start** rather than on demand. The
 *  debugger needs no setting any more: the first breakpoint in an .abap
 *  file or "Run with debugger" opens it in the running system
 *  (SystemController.attachSystemDebugger). `osd.debug` is gone from the
 *  settings UI and an existing `"osd.debug": true` is still honoured, for
 *  one release, silently (VS Code returns an undeclared key); the escape
 *  hatch is OSD_INSPECT=1 in the environment VS Code was started from. */
function osdDebugEnabled() {
  return vscode.workspace.getConfiguration("osd").get("debug", false) === true
    || /^(1|true)$/.test(process.env.OSD_INSPECT ?? "");
}

/** waitForDebuggerReady's answer when the person cancelled the wait: the
 *  command then sends nothing (a give-up after the timeout still sends). */
const WAIT_CANCELLED = "cancelled";
/** How long one queued debugger step may hold the next (#inspectorStep). */
const INSPECTOR_STEP_ESCAPE_MS = 150000;

/** The enabled source breakpoints in .abap files: while there is one, the
 *  debugger is wanted (docs/debugging-abap.md, "On demand"). */
function abapBreakpoints(breakpoints = vscode.debug.breakpoints ?? [], {enabledOnly = true} = {}) {
  return breakpoints.filter((bp) => bp instanceof vscode.SourceBreakpoint && (bp.enabled || !enabledOnly)
    && bp.location?.uri?.scheme === "file" && /\.abap$/i.test(bp.location.uri.fsPath));
}

/** The workspace folders to offer as layers, minus osdHome itself -- a
 *  workspace that IS the open-steamgate checkout (the common case while
 *  developing this extension) must never be layered on top of itself. */
function workspaceFoldersFor(osdHome) {
  const resolvedHome = osdHome === undefined ? undefined : path.resolve(osdHome);
  return (vscode.workspace.workspaceFolders ?? [])
    .map((f) => f.uri.fsPath)
    .filter((f) => path.resolve(f) !== resolvedHome);
}

// ---- databases (docs/vscode-extension.md, "Databases") -------------------
//
// `osd.database.system` picks what the running system itself sits on;
// `osd.database.tests` (default "same") lets a detached ABAP Unit run sit
// on a DIFFERENT one -- system=sqlite, tests=hana runs a live Fiori session
// on SQLite while the Test Explorer proves the same DPC against a real
// HANA. Connection settings (host/port/user/database or schema) are plain
// `settings.json`, per kind; a password is never one of them -- it lives in
// `context.secrets`, put there by "osd: Set database password (HANA)" /
// "(PostgreSQL)", and is read back only right before it is handed to a
// process's own environment (launcher.js `databaseEnv`, never argv, never a
// tracked file).

const HANA_PASSWORD_SECRET = "osd.database.hana.password";
const POSTGRES_PASSWORD_SECRET = "osd.database.postgres.password";

/** `{kind, host, port, user, database, schema, password, fresh}` for
 *  `kind` (one of DATABASE_KINDS), read from `osd.database.<kind>.*` and
 *  `context.secrets`. `osdHome` names the dedicated schema/database this
 *  window defaults to when the setting is left empty (launcher.js
 *  `defaultDedicatedName`), so two windows on two different checkouts never
 *  collide in one shared HANA or PostgreSQL by accident. */
async function databaseConfigFor(context, kind, osdHome) {
  const config = vscode.workspace.getConfiguration("osd");
  if (kind === "sqlite" || kind === "duckdb") {
    return {kind};
  }
  const dedicated = defaultDedicatedName(osdHome ?? "");
  if (kind === "postgres") {
    return {
      kind,
      host: config.get("database.postgres.host", "").trim() || undefined,
      port: config.get("database.postgres.port", 0) || undefined,
      user: config.get("database.postgres.user", "").trim() || undefined,
      database: config.get("database.postgres.database", "").trim() || `osd_${dedicated}`,
      password: await context.secrets.get(POSTGRES_PASSWORD_SECRET),
    };
  }
  if (kind === "hana") {
    return {
      kind,
      host: config.get("database.hana.host", "").trim() || undefined,
      port: config.get("database.hana.port", 0) || undefined,
      user: config.get("database.hana.user", "").trim() || undefined,
      schema: config.get("database.hana.schema", "").trim() || `OSD_${dedicated.toUpperCase()}`,
      fresh: config.get("database.hana.fresh", false) === true,
      password: await context.secrets.get(HANA_PASSWORD_SECRET),
    };
  }
  throw new Error(`osd.database: unknown kind "${kind}"`);
}

/** `osd.database.system`'s own config -- what the launcher starts on. */
async function systemDatabaseConfig(context, osdHome) {
  const kind = vscode.workspace.getConfiguration("osd").get("database.system", "sqlite");
  return databaseConfigFor(context, kind, osdHome);
}

/** `osd.database.tests`'s own config, or `undefined` for "same" (the
 *  default) -- exactly the façade route's own default when no `dbEnv` is
 *  sent at all (tools/adt-facade.mjs, tools/osd-unit.mjs `unitChildEnv`):
 *  a detached run's usual throwaway SQLite file. */
async function testsDatabaseConfig(context, osdHome) {
  const kind = vscode.workspace.getConfiguration("osd").get("database.tests", "same");
  if (kind === "same") {
    return undefined;
  }
  return databaseConfigFor(context, kind, osdHome);
}

/** The `env: {STG_DB, HANA_..., PG...}` a run of tests should carry with it
 *  over `Osd#run`'s own request body, whatever `osd.database.tests` is
 *  right now -- `undefined` for "same", which sends no body at all (the
 *  route's default, unchanged). */
async function testsDbEnv(context, osdHome) {
  const config = await testsDatabaseConfig(context, osdHome);
  return config === undefined ? undefined : databaseEnv(config);
}

async function setDatabasePassword(context, kind) {
  const secretKey = kind === "hana" ? HANA_PASSWORD_SECRET : POSTGRES_PASSWORD_SECRET;
  const value = await vscode.window.showInputBox({
    title: `osd: ${kind === "hana" ? "HANA" : "PostgreSQL"} password`,
    password: true,
    ignoreFocusOut: true,
    placeHolder: "leave empty to clear the stored password",
  });
  if (value === undefined) {
    return; // cancelled
  }
  if (value === "") {
    await context.secrets.delete(secretKey);
    vscode.window.setStatusBarMessage(`osd: ${kind} password cleared`, 4000);
    return;
  }
  await context.secrets.store(secretKey, value);
  vscode.window.setStatusBarMessage(`osd: ${kind} password stored`, 4000);
}

/** Owns the one Launcher this window may have running, and the config
 *  update that makes every other feature (Test Explorer, the lenses, the
 *  notebook, hotspots, the existing status bar) follow it: setting `osd.url`
 *  to the launched address. `onDidChange` fires on every state change, for
 *  the tree view and the ▶/■ status bar item to redraw from. */
class SystemController {
  constructor(context, output) {
    this.context = context;
    this.output = output;
    this.launcher = undefined;
    this.managedUrl = context.workspaceState?.get(MANAGED_URL_KEY);
    this.homeSource = undefined;
    this.homeMode = "auto";
    this.homeKind = undefined;
    this.overviewPanel = undefined;
    this.overviewListener = undefined;
    this.overviewRender = 0;
    this.debuggerState = {};
    this.debuggerStarts = new Map();
    this.debuggerTransition = Promise.resolve();
    // the bounds of the attach path's VS Code calls, in ms (INSPECTOR_STEP_ESCAPE_MS adds them up)
    this.debuggerBounds = {start: 35000, stop: 10000};
    this.debuggerOutputPattern = undefined;
    this.activeSystemSessionId = undefined;
    // The stable VS Code API has no list of running debug sessions (only
    // start/terminate events), so the controller keeps its own.
    this.debugSessions = new Set();
    this.retiredDebugSessionIds = new Set();
    if (typeof vscode.debug.onDidStartDebugSession === "function") {
      context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
        this.debugSessions.add(session);
        if (session.name === `OSD: ABAP (${this.launcher?.inspectPort})`)
          this.activeSystemSessionId = session.id;
        if (/^OSD: /.test(session.name ?? "") || this.#inFamilyOfOsd(session)) {
          this.#debugLog(`session started: ${session.name} (${session.id})` +
            (session.parentSession ? ` under ${session.parentSession.name} (${session.parentSession.id})` : ""));
        }
      }));
    }
    this.terminatedSessionIds = new Set();
    context.subscriptions.push(vscode.debug.onDidTerminateDebugSession((session) => {
      this.debugSessions.delete(session);
      this.terminatedSessionIds.add(session.id);
      if (this.terminatedSessionIds.size > 64) this.terminatedSessionIds.delete(this.terminatedSessionIds.values().next().value);
      if (this.retiredDebugSessionIds.delete(session.id)) return;
      if (this.activeSystemSessionId !== undefined && session.id === this.activeSystemSessionId &&
          session.name === `OSD: ABAP (${this.debuggerState.systemPort})`) {
        this.activeSystemSessionId = undefined;
        this.debuggerState = debugAttachPlan(this.debuggerState,
          {type: "system-session-ended", port: this.debuggerState.systemPort}).state;
        // the debug session ended: an inspector opened on demand closes
        // once no .abap breakpoint wants it either
        this.releaseDebugger({sessionEnded: true}).catch((e) => this.output.appendLine(`osd debugger: ${String(e?.message ?? e)}`));
      }
    }));
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.stopEmitter = new vscode.EventEmitter();
    this.onWillStop = this.stopEmitter.event;
    context.subscriptions.push(this.stopEmitter);
    context.subscriptions.push(vscode.workspace.onDidChangeWorkspaceFolders(() => {
      if (this.launcher !== undefined) {
        this.launcher.workspaceFolders = workspaceFoldersFor(this.launcher.osdHome);
      }
      this.emitter.fire();
    }));
  }

  /** Builds (or rebuilds, if osdHome or the workspace folders changed) the
   *  one Launcher this controller drives. Throws when there is no osdHome
   *  to build -- callers show that as an error rather than starting nothing
   *  silently. */
  async ensureLauncher(forceDebug = false) {
    const choice = await resolveStartChoice(this.context, this.homeMode, this.launcher);
    if (choice?.kind === "cancelled") return undefined;
    if (choice?.path === undefined) {
      throw new Error("osd.home is not set, and this window has no single workspace folder to default to");
    }
    const osdHome = choice.kind === "bundled copy" && choice.materialized !== true
      ? await materializeBundledHome(this.context, choice.seedDir, this.launcher)
      : choice.path;
    this.homeSource = choice.source;
    if (this.launcher !== undefined && this.launcher.osdHome === osdHome && this.launcher.state !== "stopped") {
      return this.launcher;
    }
    const database = await systemDatabaseConfig(this.context, osdHome);
    if (this.launcher === undefined || this.launcher.osdHome !== osdHome) {
      if (this.launcher !== undefined && this.launcher.state !== "stopped") {
        await this.launcher.stop();
      }
      // another home is another system: the old one's pages are gone
      if (this.launcher !== undefined) closePageTabs();
      const launcher = new Launcher({
        osdHome,
        storageDir: storageDirFor(this.context, osdHome),
        workspaceFolders: workspaceFoldersFor(osdHome),
        database,
        jobsWorker: vscode.workspace.getConfiguration("osd").get("jobs.worker", "auto"),
        warm: osdWarmModeOf(),
        debug: osdDebugEnabled() || forceDebug,
      });
      launcher.on("jobsLog", line => this.jobsOutput?.append(line));
      launcher.on("jobsUnavailable", () => {
        if (this.jobsWarningShown) return;
        this.jobsWarningShown = true;
        vscode.window.showWarningMessage("OSD background jobs need the file SQLite database for now.", "Use file database")
          .then(async choice => {
            if (choice === "Use file database") {
              await vscode.workspace.getConfiguration("osd").update("database.system", "sqlite", vscode.ConfigurationTarget.Global);
              this.launcher.database = {kind:"sqlite"};
              await this.launcher.rebuild();
            }
          });
      });
      launcher.homeKind = choice.kind;
      this.attachLauncher(launcher);
    } else {
      // Same osdHome, stopped: pick up current folders and settings before
      // the launcher's next projection and build.
      this.launcher.workspaceFolders = workspaceFoldersFor(osdHome);
      this.launcher.jobsWorkerMode = vscode.workspace.getConfiguration("osd").get("jobs.worker", "auto");
      this.launcher.database = database;
      this.launcher.databaseLabel = describeDatabase(database);
      this.launcher.warmMode = osdWarmModeOf();
      this.launcher.homeKind = choice.kind;
      this.launcher.debug = osdDebugEnabled() || forceDebug;
    }
    this.homeKind = choice.kind;
    return this.launcher;
  }

  /** runningAbapSources() of the serving home, read again only when the
   *  live generation changes; undefined when there is none. */
  runningSources() {
    const launcher = this.launcher;
    if (launcher?.osdHome === undefined) return undefined;
    let generation;
    try { generation = fs.realpathSync(path.join(launcher.osdHome, "output")); } catch { return undefined; }
    if (this.runningSourcesCache?.generation !== generation) {
      try {
        this.runningSourcesCache = runningAbapSources(launcher.osdHome, {storageDir: launcher.storageDir, layers: launcher.layers});
      } catch {
        this.runningSourcesCache = undefined;
      }
    }
    return this.runningSourcesCache;
  }

  /** A line on the "OSD: System log" channel, from a command outside the class. */
  debugNote(line) {
    this.#debugLog(line);
  }

  #debugLog(line) {
    try { this.output?.appendLine?.(`osd debugger: ${line}`); } catch { /* a closed channel */ }
  }

  #inFamilyOfOsd(session) {
    for (let one = session?.parentSession; one !== undefined; one = one.parentSession) {
      if (/^OSD: /.test(one.name ?? "")) return true;
    }
    return false;
  }

  /** `promise`, or `undefined` once `ms` have passed: no await on the debug
   *  path may hang a command for good (osg-demo, 0.5.1467: a command stopped
   *  after "inspector opened" and logged nothing). Logs the start, the end and
   *  a give-up to the "OSD: System log" channel. */
  async #bounded(promise, ms, label) {
    const started = Date.now();
    this.#debugLog(`${label}: waiting (at most ${ms} ms)`);
    let timer;
    const timedOut = Symbol("timeout");
    try {
      const value = await Promise.race([Promise.resolve(promise),
        new Promise((resolve) => { timer = setTimeout(() => resolve(timedOut), ms); })]);
      if (value === timedOut) {
        this.#debugLog(`${label}: gave up after ${ms} ms`);
        return undefined;
      }
      this.#debugLog(`${label}: done in ${Date.now() - started} ms`);
      return value;
    } catch (error) {
      this.#debugLog(`${label}: failed after ${Date.now() - started} ms: ${String(error?.message ?? error)}`);
      return undefined;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Resolves true once `session` has terminated (or its stop resolved). */
  #sessionGone(session, stopping) {
    return new Promise((resolve) => {
      const check = setInterval(() => {
        const sessions = Array.isArray(vscode.debug.sessions) ? vscode.debug.sessions : [...this.debugSessions];
        if (!sessions.some((one) => one.id === session.id) || this.terminatedSessionIds?.has(session.id)) {
          clearInterval(check);
          resolve(true);
        }
      }, 100);
      stopping.then(() => { clearInterval(check); resolve(true); }, () => undefined);
      setTimeout(() => clearInterval(check), 20000);
    });
  }

  #describeConfig(config) {
    return `${config.name}: outFiles ${JSON.stringify(config.outFiles)}, ` +
      `resolveSourceMapLocations ${JSON.stringify(config.resolveSourceMapLocations)}`;
  }

  /** The OSD session named `name` and every session js-debug started under
   *  it. js-debug's attach session is only a parent: the target is a child
   *  session ("Remote Process [0]"), and only the child ever verifies a
   *  breakpoint -- asking the parent alone waits forever. */
  #sessionFamily(name) {
    const sessions = this.runningDebugSessions();
    const roots = sessions.filter((one) => one.name === name);
    const inFamily = (session) => {
      for (let one = session; one !== undefined; one = one.parentSession) {
        if (roots.some((root) => root === one || root.id === one.id)) return true;
      }
      return false;
    };
    return {root: roots.at(-1), members: sessions.filter(inFamily)};
  }

  /** Running debug sessions: VS Code's own list where a runtime has one,
   *  otherwise the sessions this controller saw start and not yet end. */
  runningDebugSessions() {
    const sessions = Array.isArray(vscode.debug.sessions) ? vscode.debug.sessions : [...this.debugSessions];
    return sessions.filter((session) => !this.retiredDebugSessionIds.has(session.id));
  }

  async applyDebuggerEvent(event) {
    if (event.type === "system-started" && this.debuggerState.systemPort !== undefined) {
      const name = `OSD: ABAP (${this.debuggerState.systemPort})`;
      if (!this.runningDebugSessions().some((session) => session.name === name) && !this.debuggerStarts.has(name)) {
        this.debuggerState = debugAttachPlan(this.debuggerState,
          {type: "system-session-ended", port: this.debuggerState.systemPort}).state;
      }
    }
    const plan = debugAttachPlan(this.debuggerState, event);
    this.debuggerState = plan.state;
    for (const action of plan.actions) {
      const root = this.launcher?.osdHome ?? osdHomeOf();
      const config = debuggerConfiguration(action.port, {target: action.target, restart: action.restart, root,
        storageDir: this.launcher?.storageDir, layers: this.launcher?.layers});
      const name = config.name;
      if (action.type === "stop") {
        const session = this.runningDebugSessions().find((candidate) => candidate.name === name);
        if (session !== undefined) {
          // VS Code can deliver terminate after a new process has reused the
          // port. Retire this exact session before requesting its stop.
          this.retiredDebugSessionIds.add(session.id);
          this.debugSessions.delete(session);
          if (session.id === this.activeSystemSessionId) this.activeSystemSessionId = undefined;
          await this.#bounded(vscode.debug.stopDebugging(session), this.debuggerBounds.stop, `stop ${name}`);
        }
        this.debuggerStarts.delete(name);
        this.debuggerOutputPattern = undefined;
        continue;
      }
      if (this.runningDebugSessions().some((candidate) => candidate.name === name)) {
        this.#debugLog(`${name} is already attached`);
        if (action.target === "system") {
          this.debuggerState = debugAttachPlan(this.debuggerState, {type: "system-attached", port: action.port}).state;
          this.debuggerOutputPattern = config.outFiles[0];
        }
        continue;
      }
      if (this.debuggerStarts.has(name)) {
        if (await this.#bounded(this.debuggerStarts.get(name), this.debuggerBounds.start, `the attach already in flight for ${name}`) !== true) return false;
        continue;
      }
      this.#debugLog(`attaching ${this.#describeConfig(config)}`);
      const starting = Promise.resolve(vscode.debug.startDebugging(undefined, config));
      this.debuggerStarts.set(name, starting);
      // The entry goes when the start itself settles, not when this caller
      // stops waiting for it: a later attach must find a start still in
      // flight and not begin a second one beside it.
      const forget = () => { if (this.debuggerStarts.get(name) === starting) this.debuggerStarts.delete(name); };
      starting.then(forget, forget);
      const started = await this.#bounded(starting, this.debuggerBounds.start, `startDebugging ${name}`);
      if (started !== true) {
        this.output.appendLine(`debugger did not start for ${name}`);
        vscode.window.showErrorMessage(`osd: VS Code could not attach to ${name}`);
        return false;
      }
      if (action.target === "system") {
        this.debuggerState = debugAttachPlan(this.debuggerState, {type: "system-attached", port: action.port}).state;
        this.debuggerOutputPattern = config.outFiles[0];
      }
    }
    return true;
  }

  /** A debug session keeps its outFiles after a warm swap or a supervised
   *  restart. Reattach it once the serving output link names another build. */
  async refreshDebuggerGeneration() {
    return this.#inspectorStep(() => this.#refreshDebuggerGeneration());
  }

  async #refreshDebuggerGeneration() {
    if (this.launcher?.state !== "running") return;
    const port = this.debuggerState.systemPort;
    if (port === undefined) return;
    const session = this.runningDebugSessions().find((one) => one.name === `OSD: ABAP (${port})`);
    if (session === undefined) return;
    const config = debuggerConfiguration(port, {root: this.launcher.osdHome,
      storageDir: this.launcher.storageDir, layers: this.launcher.layers});
    if (this.debuggerOutputPattern === undefined) {
      this.debuggerOutputPattern = config.outFiles[0];
      return;
    }
    if (this.debuggerOutputPattern === config.outFiles[0]) return;
    try {
      // Clear the old session before stopping it so its termination event
      // cannot close an inspector opened on demand for the replacement.
      this.debuggerState = {systemPort: undefined};
      this.retiredDebugSessionIds.add(session.id);
      this.debugSessions.delete(session);
      if (session.id === this.activeSystemSessionId) this.activeSystemSessionId = undefined;
      this.#debugLog(`generation changed (${this.debuggerOutputPattern} -> ${config.outFiles[0]}): reattaching`);
      const stopping = Promise.resolve(vscode.debug.stopDebugging(session)).then(() => true);
      if (await this.#bounded(stopping, this.debuggerBounds.stop, `stop ${session.name} for the new generation`) !== true) {
        // Two sessions on one inspector port fight over the target. Give the
        // old one a second bound to go before starting the new one.
        this.#debugLog(`${session.name} (${session.id}) did not stop within ${this.debuggerBounds.stop} ms; waiting once more before reattaching`);
        if (await this.#bounded(this.#sessionGone(session, stopping), this.debuggerBounds.stop, `${session.name} (${session.id}) to go`) !== true) {
          this.#debugLog(`${session.name} (${session.id}) is still there; reattaching anyway`);
        }
      }
      this.debuggerOutputPattern = undefined;
      this.#debugLog(`attaching ${this.#describeConfig(config)}`);
      if (await this.#bounded(vscode.debug.startDebugging(undefined, config), this.debuggerBounds.start, `startDebugging ${config.name}`) === true) {
        this.debuggerState = {systemPort: port};
        this.debuggerOutputPattern = config.outFiles[0];
        return true;
      } else {
        this.output.appendLine(`osd debugger: could not reattach to generation ${config.outFiles[0]}`);
      }
    } catch (error) {
      this.output.appendLine(`osd debugger: ${String(error?.message ?? error)}`);
    }
  }

  /** Attaches VS Code's debugger to the running system. With `onDemand`,
   *  a system started without an inspector has it opened now, in the
   *  running process (Launcher.openInspector -> /osd/inspector): no
   *  osd.debug, no restart. Without it, attaches only to an inspector that
   *  is already open. The reason a debugger could not attach is left in
   *  `debuggerError` for the caller to show. */
  // opening and closing the inspector one after another, in the order they
  // were asked: a close in flight and a new breakpoint's open would otherwise
  // reach the system on two connections, in either order
  #inspectorStep(step) {
    // One at a time, but a step that never ends must not hold every later
    // attach for good. The escape sits above the longest a legitimate step
    // can take, the sum of its own bounds. An attach: open the inspector
    // (15 s, Launcher inspectorOnce), then the previous system stop (15 s).
    // Then a generation refresh: stop the old session (10 s), wait for it to
    // go (10 s), start the new one (35 s). If that fails, the plain attach
    // starts one (35 s). 15 + 15 + 10 + 10 + 35 + 35 = 120 s. A release is
    // 15 + 10 + 15 = 40 s. So 150 s.
    const previous = this.inspectorSteps ?? Promise.resolve();
    let timer;
    const next = Promise.race([previous, new Promise((resolve) => {
      timer = setTimeout(() => {
        this.#debugLog(`the previous debugger step did not finish within ${INSPECTOR_STEP_ESCAPE_MS / 1000} s; going on without it`);
        resolve();
      }, INSPECTOR_STEP_ESCAPE_MS);
    })]).finally(() => clearTimeout(timer)).then(step, step);
    this.inspectorSteps = next.catch(() => undefined);
    return next;
  }

  async attachSystemDebugger(options = {}) {
    return this.#inspectorStep(() => this.#attachSystemDebugger(options));
  }

  /** startDebugging resolves before js-debug has finished attaching and
   *  applying source maps. A request sent then can pass a loaded DPC before
   *  its breakpoint binds. Ask VS Code for this session's DAP breakpoint,
   *  which is the same verified state shown by the filled editor glyph. */
  /** true once ready, false when the wait gave up (the caller goes on),
   *  WAIT_CANCELLED when the person cancelled it (the caller sends nothing). */
  async waitForDebuggerReady(file, timeoutMs = 15000, {reportMissingBreakpoint = false, output = this.output} = {}) {
    const wait = (token) => this.#waitForDebuggerReady(file, timeoutMs, token, reportMissingBreakpoint, output);
    if (typeof vscode.window.withProgress === "function") {
      return vscode.window.withProgress({location: vscode.ProgressLocation.Notification,
        title: "osd: waiting for debugger breakpoints", cancellable: true}, (_, token) => wait(token));
    }
    return wait();
  }

  async #waitForDebuggerReady(file, timeoutMs, token, reportMissingBreakpoint, output) {
    const port = this.launcher?.inspectPort;
    const name = `OSD: ABAP (${port})`;
    const target = file && path.resolve(file);
    // The breakpoint's URI and the file the command acts on need not be
    // spelled alike: the same file through a link, or the same object in the
    // copy the running generation was compiled from (lib.js
    // breakpointMatches). A shadowed copy of the object never binds and is
    // not waited for. Matched, and said why.
    const enabled = abapBreakpoints();
    const breakpoints = [];
    const matches = target === undefined ? []
      : breakpointMatches(enabled.map((bp) => bp.location.uri.fsPath), target, this.runningSources());
    for (const bp of enabled) {
      const match = matches.find((one) => one.file === bp.location.uri.fsPath);
      if (match === undefined) continue;
      this.#debugLog(`breakpoint ${bp.location.uri.fsPath}:${(bp.location.range?.start?.line ?? -1) + 1} ` +
        `${match.counts ? "matches" : "is ignored for"} ${target} (${match.why})`);
      if (match.counts) breakpoints.push(bp);
    }
    // ready once one breakpoint of each object is verified: a second
    // breakpoint in a line that never compiles must not hold the call
    const objectOfBreakpoint = (bp) => {
      const object = adtObjectOf(bp.location.uri.fsPath);
      return object ? `${object.type}:${object.name}:${object.include}` : path.resolve(bp.location.uri.fsPath);
    };
    if (target !== undefined && breakpoints.length === 0) {
      this.#debugLog(`no enabled breakpoint matches ${target}; ${enabled.length} enabled .abap breakpoint(s): ` +
        (enabled.map((bp) => bp.location.uri.fsPath).join(", ") || "none"));
    }
    const generation = (() => {
      if (this.launcher?.osdHome === undefined) return "?";
      try { return path.basename(path.dirname(fs.realpathSync(path.join(this.launcher.osdHome, "output")))); } catch { return "?"; }
    })();
    this.#debugLog(`waiting up to ${timeoutMs} ms for ${name} and ${breakpoints.length} verified breakpoint(s) (live generation ${generation})`);
    const status = vscode.window.setStatusBarMessage?.("osd: waiting for the debugger…");
    const started = Date.now();
    const deadline = started + timeoutMs;
    let cancelled = token?.isCancellationRequested === true;
    const subscription = token?.onCancellationRequested?.(() => { cancelled = true; });
    let last = "no debug session yet";
    const pause = () => new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - Date.now()))));
    try {
      while (!cancelled && Date.now() < deadline) {
        const {root, members} = this.#sessionFamily(name);
        if (root !== undefined) {
          if (breakpoints.length === 0) {
            if (reportMissingBreakpoint && target !== undefined)
              output.appendLine(`osd debugger: no enabled breakpoint in ${target}; calling without a verified breakpoint`);
            this.#debugLog(`ready after ${Date.now() - started} ms (no breakpoint to verify)`);
            return true;
          }
          const askable = members.filter((one) => typeof one.getDebugProtocolBreakpoint === "function");
          // js-debug verifies in the child session it starts for the target,
          // not in the attach session the name belongs to: a breakpoint is
          // ready once any session of the family says so.
          const check = Promise.all(breakpoints.map((bp) => Promise.all(askable.map(async (one) => {
            try { return await one.getDebugProtocolBreakpoint(bp); } catch { return undefined; }
          }))));
          // A DAP request can remain pending after the session disappears.
          // Race each check against the remaining deadline and cancellation.
          let timer;
          const states = await Promise.race([check, new Promise((resolve) => {
            timer = setTimeout(() => resolve(undefined), Math.min(50, Math.max(0, deadline - Date.now())));
          })]);
          clearTimeout(timer);
          if (cancelled || Date.now() >= deadline) break;
          const alive = this.runningDebugSessions().some((one) => one.id === root.id);
          if (states !== undefined) {
            last = `sessions ${askable.map((one) => `${one.name} (${one.id})`).join(", ") || "none"}; verified: ` +
              breakpoints.map((bp, i) => states[i].some((dap) => dap?.verified === true)).join(", ");
          }
          const verifiedObjects = new Set(breakpoints.filter((bp, i) => states?.[i]?.some((dap) => dap?.verified === true))
            .map(objectOfBreakpoint));
          if (alive && states !== undefined && breakpoints.every((bp) => verifiedObjects.has(objectOfBreakpoint(bp)))) {
            this.#debugLog(`ready after ${Date.now() - started} ms (${last})`);
            return true;
          }
          if (states !== undefined) await pause();
          continue;
        }
        await pause();
      }
      if (cancelled) {
        this.#debugLog(`wait cancelled after ${Date.now() - started} ms: ${last}`);
        return WAIT_CANCELLED;
      }
      this.#debugLog(`gave up waiting after ${timeoutMs} ms: ${last}`);
      return false;
    } finally {
      subscription?.dispose();
      status?.dispose();
    }
  }

  async #attachSystemDebugger({onDemand = false} = {}) {
    const launcher = this.launcher;
    this.debuggerError = undefined;
    if (launcher === undefined || launcher.state !== "running") {
      this.debuggerError = "the system is not running; start it with osd: Start";
      return false;
    }
    const open = launcher.inspectPort !== undefined && (launcher.debug === true || launcher.inspectorOpen === true);
    if (!open) {
      if (!onDemand) return false;
      try {
        await launcher.openInspector();
      } catch (e) {
        this.debuggerError = `could not open the inspector: ${String(e?.message ?? e)}`;
        return false;
      }
      this.output.appendLine(`--- osd debugger: inspector opened on 127.0.0.1:${launcher.inspectPort} ---`);
    }
    await this.#bounded(this.debuggerTransition, 15000, "the previous system stop");
    // Attach and call must inspect the serving link now, while this attach
    // owns the inspector queue; the status bar's periodic refresh can be late.
    if (await this.#refreshDebuggerGeneration() === true) return true;
    return this.applyDebuggerEvent({type: "system-started", enabled: true, port: launcher.inspectPort});
  }

  /** The other half of on demand: once no enabled .abap breakpoint is left
   *  **and** the OSD: ABAP session has ended, close an inspector this window
   *  opened. Removing the last breakpoint while the session is attached (a
   *  paused request, a Run with debugger) leaves it attached; ending the
   *  session then closes it. One opened at start (OSD_INSPECT=1, osd.debug)
   *  stays. `sessionEnded` is said by the session's own end. */
  async releaseDebugger(options = {}) {
    return this.#inspectorStep(() => this.#releaseDebugger(options));
  }

  async #releaseDebugger({sessionEnded = false} = {}) {
    const launcher = this.launcher;
    if (launcher === undefined || launcher.debug === true || launcher.inspectorOpen !== true) return false;
    if (abapBreakpoints().length > 0) return false;
    const name = `OSD: ABAP (${launcher.inspectPort})`;
    if (this.runningDebugSessions().some((session) => session.name === name)) return false;
    await this.#bounded(this.debuggerTransition, 15000, "the previous system stop (release)");
    await this.applyDebuggerEvent({type: "system-detach"});
    const closed = await launcher.closeInspector();
    if (closed) this.output.appendLine("--- osd debugger: inspector closed (no .abap breakpoint left) ---");
    return closed;
  }

  /** `osd.url` follows a launch: every existing feature that calls osd()
   *  above reads that setting fresh on every call, so this alone is what
   *  makes them all reach the instance this controller just started. A
   *  single workspace folder gets the Workspace target so the setting does
   *  not leak into the user's global settings across unrelated projects. */
  async #pointUrlAt(port) {
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace
      : vscode.ConfigurationTarget.Global;
    try {
      await vscode.workspace.getConfiguration("osd").update("url", `http://localhost:${port}`, target);
      this.managedUrl = `http://localhost:${port}`;
      try {
        await this.context.workspaceState?.update(MANAGED_URL_KEY, this.managedUrl);
      } catch (error) {
        this.output.appendLine(`osd: could not remember the managed URL: ${String(error.message ?? error)}`);
      }
    } catch (error) {
      vscode.window.showErrorMessage(`osd: running on :${port}, but could not update osd.url: ${String(error.message ?? error)}`);
    }
  }

  async applyPreset(name) {
    const preset = presetSettings(name);
    this.homeMode = preset.home ?? "auto";
    const target = vscode.workspace.workspaceFolders?.length
      ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
    const config = vscode.workspace.getConfiguration("osd");
    await Promise.all([
      config.update("database.system", preset.database, target),
      config.update("warm", preset.warm, target),
      config.update("keymap", preset.keymap, target),
    ]);
  }

  async start(options = {}) {
    const forceDebug = options === true || options.forceDebug === true;
    const launchOptions = options === true ? {} : options;
    if (this.launcher !== undefined && this.launcher.state !== "stopped") {
      if (this.launcher.state === "running") return true;
      vscode.window.showInformationMessage(`osd: already ${this.launcher.state}`);
      return false;
    }
    let launcher;
    try {
      launcher = await this.ensureLauncher(forceDebug);
    } catch (e) {
      vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
      return;
    }
    if (launcher === undefined) return false;
    if (launcher.state !== "stopped") {
      if (launcher.state === "running") return true;
      vscode.window.showInformationMessage(`osd: already ${launcher.state}`);
      return false;
    }
    this.output.show(true);
    this.output.appendLine(`--- osd start: ${launcher.osdHome} (${launcher.databaseLabel}) ---`);
    return this.#launch(launcher, launchOptions, "osd start");
  }

  /** Everything this controller listens to on its launcher, in one place
   *  (so a test can drive a real Launcher through it). */
  attachLauncher(launcher) {
    launcher.on("log", (line) => this.output.append(line));
    wirePageTabs(launcher);
    launcher.on("state", (state) => {
      if (state === "stopped") {
        this.debuggerTransition = this.debuggerTransition.then(() => this.applyDebuggerEvent({type: "system-stopped"}));
      }
      this.emitter.fire();
    });
    launcher.on("exit", ({code, signal}) => {
      this.output.appendLine(`\n--- osd exited on its own (code ${code ?? "?"}, signal ${signal ?? "?"}) ---`);
      vscode.window.showWarningMessage(`osd: the system stopped unexpectedly (code ${code ?? "?"}, signal ${signal ?? "?"})`);
    });
    this.launcher = launcher;
  }

  async stop({shutdown = false} = {}) {
    const pending = [];
    this.stopEmitter.fire({shutdown, waitUntil: promise => pending.push(promise)});
    await Promise.all(pending);
    if (this.launcher === undefined) {
      return;
    }
    await this.launcher.stop();
    // Stop means the pages are gone; a rebuild (stop, then start) keeps them
    closePageTabs();
    this.emitter.fire();
  }

  async rebuild(options = {}) {
    return this.#rebuild(options);
  }

  async fullRebuild() {
    return this.#rebuild({force: true});
  }

  async #rebuild(options = {}) {
    const force = options.force === true || options.forceBuild === true;
    let launcher;
    try {
      launcher = await this.ensureLauncher();
    } catch (e) {
      vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
      return false;
    }
    if (launcher.state !== "stopped" && launcher.state !== "running") {
      vscode.window.showInformationMessage(`osd: already ${launcher.state}`);
      return false;
    }
    this.output.show(true);
    this.output.appendLine(force
      ? "--- osd full rebuild (force: stop, build, start) ---"
      : "--- osd rebuild (full: stop, build, start) ---");
    try {
      const result = launcher.state === "running"
        ? await launcher.rebuild({...options, force})
        : await launcher.start({...options, force});
      if (result === undefined) return false;
      await this.#pointUrlAt(launcher.port);
      this.emitter.fire();
      return true;
    } catch (e) {
      await this.#launcherError(launcher, e, "osd rebuild");
      this.emitter.fire();
      return false;
    }
  }

  async #launch(launcher, options, label) {
    let result;
    try {
      result = await launcher.start(options);
    } catch (error) {
      await this.#launcherError(launcher, error, label);
      this.emitter.fire();
      return false;
    }
    if (result === undefined) return false;
    await this.#pointUrlAt(result.port);
    vscode.window.setStatusBarMessage(
      `osd: running on :${result.port} · ${launcher.databaseLabel}, generation ${String(result.generation).slice(0, 8)}`, 5000);
    this.emitter.fire();
    return true;
  }

  async #launcherError(launcher, error, label) {
    const errorLog = typeof error?.logText === "string" ? error.logText : "";
    const lastLog = typeof launcher?.lastLog === "string" ? launcher.lastLog : "";
    const logText = errorLog.trim() ? errorLog : lastLog.trim() ? lastLog : "";
    const message = String(error?.message ?? error);
    if (/STG_DB_FRESH/.test(message) && launcher.database?.kind === "hana") {
      const choice = await vscode.window.showErrorMessage(`${label}: ${message}`, "Set osd.database.hana.fresh and retry");
      if (choice !== undefined) {
        await vscode.workspace.getConfiguration("osd").update("database.hana.fresh", true, vscode.ConfigurationTarget.Workspace);
        await this.start();
      }
      return;
    }
    const issue = classify(logText, error);
    const action = await vscode.window.showErrorMessage(
      issue.kind === "version-mismatch" ? issue.message : `${label}: ${issue.message}`, ...issue.actions);
    if (action === "Update") {
      await vscode.commands.executeCommand("extension.open", "oisee.open-steamgate");
    } else if (action === "Open log") {
      this.output.show(true);
    } else if (action === "Full rebuild") {
      await this.rebuild({forceBuild: true});
    } else if (action === "Fetch packs") {
      this.output.show(true);
      this.output.appendLine("--- osd fetch packs ---");
      try {
        await launcher.fetchPacks();
        this.output.appendLine("--- osd restart after fetching packs ---");
        await this.#launch(launcher, {}, "osd start after fetching packs");
      } catch (fetchError) {
        await this.#launcherError(launcher, fetchError, "osd fetch packs");
      }
    } else if (action === "Pick another port") {
      const failureText = [logText, error?.code, error?.message ?? error].filter(Boolean).join(" ");
      await this.#pickAnotherPort(launcher, failureText);
    }
  }

  async #pickAnotherPort(launcher, logText) {
    const previous = launcher.lastAttemptedPort ?? Number(logText.match(/(?:127\.0\.0\.1|localhost|\*|::):([0-9]+)/)?.[1]);
    const choices = [];
    for (let port = PORT_RANGE.from; port <= PORT_RANGE.to; port++) {
      if (port !== previous && await isFree(port)) {
        choices.push({label: `:${port}`, description: "available", port});
      }
    }
    if (choices.length === 0) {
      vscode.window.showErrorMessage(`osd: no other free port in ${PORT_RANGE.from}-${PORT_RANGE.to}`);
      return;
    }
    const selected = await vscode.window.showQuickPick(choices, {placeHolder: "Pick another port for osd"});
    if (selected === undefined) return;
    this.output.show(true);
    this.output.appendLine(`--- osd start on :${selected.port} ---`);
    await this.#launch(launcher, {port: selected.port}, "osd start");
  }

  async quickStart(name = "defaults") {
    const state = this.launcher?.state ?? "stopped";
    if (state !== "stopped" && state !== "running") {
      vscode.window.showInformationMessage(`osd: already ${state}`);
      return;
    }
    await this.applyPreset(name);
    // A running launcher has already captured its database and warm settings.
    // Stop it so start() rebuilds the Launcher from the selected preset.
    if (state === "running") await this.stop();
    const started = await this.start();
    if (started) await this.openSystemOverview();
  }

  openLog() {
    this.output.show(true);
  }

  async #overviewModel() {
    let state = this.launcher?.state ?? "stopped";
    const launcher = this.launcher;
    const choice = osdHomeChoiceFor(this.context, this.homeMode);
    const homePath = this.launcher?.osdHome ?? choice.path;
    const layerFolders = this.launcher?.layers ?? (homePath === undefined ? [] : detectWorkspaceLayers(workspaceFoldersFor(homePath)));
    const keymap = vscode.workspace.getConfiguration("osd").get("keymap", "abap");
    let serving;
    let status;
    const baseUrl = state === "running" && this.launcher?.port !== undefined
      ? `http://localhost:${this.launcher.port}` : undefined;
    if (baseUrl !== undefined) {
      const client = new Osd(baseUrl);
      [serving, status] = await Promise.all([
        client.serving().catch(() => undefined),
        client.systemStatus().catch(() => undefined),
      ]);
    }
    if (state === "running" && (launcher !== this.launcher || launcher.state !== "running"
        || !launcher.ownsServing?.(serving))) {
      state = "stopped";
      serving = undefined;
      status = undefined;
    }
    const model = systemOverviewModel({
      state,
      launcher: this.launcher,
      serving,
      status,
      homeKind: this.launcher?.homeKind ?? choice.kind,
      homePath,
      layers: layerFolders,
      keymap,
      baseUrl,
      extensionVersion: require("./package.json").version,
    });
    let sysinfoUrl;
    if (state === "running" && baseUrl !== undefined) {
      try {
        sysinfoUrl = (await vscode.env.asExternalUri(vscode.Uri.parse(`${baseUrl}${model.sources.sysinfo}`))).toString();
      } catch {
        sysinfoUrl = `${baseUrl}${model.sources.sysinfo}`;
      }
      if (model.launchpadUrl) {
        try {
          model.launchpadUrl = (await vscode.env.asExternalUri(vscode.Uri.parse(model.launchpadUrl))).toString();
        } catch {
          // The host URL remains useful for local windows.
        }
      }
    }
    return {model, sysinfoUrl};
  }

  async openSystemOverview() {
    if (this.overviewPanel === undefined) {
      const panel = vscode.window.createWebviewPanel("osdSystemOverview", "System overview", vscode.ViewColumn.Beside, {
        enableScripts: false,
        retainContextWhenHidden: true,
        enableCommandUris: ["osd.start", "workbench.action.openSettings", "osd.openLaunchpad", "osd.openLaunchpadExternal"],
      });
      this.overviewPanel = panel;
      panel.onDidDispose(() => {
        this.overviewPanel = undefined;
        this.overviewListener?.dispose();
        this.overviewListener = undefined;
      });
      this.overviewListener = this.onDidChange(() => { this.refreshOverview(); });
    } else {
      this.overviewPanel.reveal(vscode.ViewColumn.Beside);
    }
    await this.refreshOverview();
  }

  async refreshOverview() {
    const panel = this.overviewPanel;
    if (panel === undefined) return;
    const render = ++this.overviewRender;
    const {model, sysinfoUrl} = await this.#overviewModel();
    if (this.overviewPanel === panel && this.overviewRender === render) {
      panel.webview.html = systemOverviewHtml(model, {sysinfoUrl});
    }
  }

  /** T7 "Rebuild (warm)" (docs/vscode-extension.md "Warm", the $(tools)
   *  icon in the view's own title bar): activate every CLAS/INTF whose
   *  source changed since the serving generation, in one call
   *  (tools/adt-facade.mjs `core/http/changed`, Osd#activateMany above) --
   *  the fast path a cold "Full rebuild" (the "..." menu, still stop +
   *  build + start) is the fallback for whenever this cannot tell what
   *  changed: not running yet, the warm registry not primed, or the route
   *  itself saying so. Never dumps or hangs on that: every branch below
   *  either falls back to rebuild() or reports and returns, and the try
   *  around the live calls falls back too, on the chance of a transient
   *  network failure between "primed" and the next request. */
  async rebuildWarm() {
    if (this.launcher === undefined || this.launcher.state !== "running") {
      this.output.appendLine("--- osd rebuild (warm): not running -- falling back to a full rebuild ---");
      return this.rebuild();
    }
    this.output.show(true);
    try {
      const serving = await osd().serving();
      const warm = serving.warm;
      if (warm?.state !== "primed") {
        const reason = warm?.reason ?? (warm?.state === "off" ? "osd.warm is off" : `warm: ${warm?.state ?? "unknown"}`);
        this.output.appendLine(`--- osd rebuild (warm): not primed (${reason}) -- falling back to a full rebuild ---`);
        vscode.window.setStatusBarMessage(`osd: warm not primed (${reason}) -- full rebuild instead`, 5000);
        return this.rebuild();
      }
      const changed = await osd().changed();
      if (changed.objects === undefined) {
        this.output.appendLine(`--- osd rebuild (warm): ${changed.reason ?? "could not tell what changed"} -- falling back to a full rebuild ---`);
        return this.rebuild();
      }
      if (changed.objects.length === 0) {
        vscode.window.setStatusBarMessage("osd: nothing changed since the serving generation", 5000);
        return undefined;
      }
      this.output.appendLine(`--- osd rebuild (warm): activating ${changed.objects.map((o) => o.name).join(", ")} ---`);
      const result = await osd().activateMany(changed.objects);
      const build = activationBuildText(result);
      const tests = closureTestsText(result);
      if (result.ok) {
        await this.refreshDebuggerGeneration();
        vscode.window.setStatusBarMessage(
          `osd: ${changed.objects.length} object(s) activated${build ? ` (${build})` : ""}${tests ? `, ${tests}` : ""}`, 5000);
      } else {
        this.output.appendLine(`osd rebuild (warm): ${result.issues.map((i) => `${i.objDescr || "?"}: ${i.message}`).join("; ")}`);
        const logText = result.issues.map((i) => i.message).join("\n");
        if (classify(logText).kind === "version-mismatch") {
          await this.#launcherError(this.launcher, {logText}, "osd rebuild (warm)");
        } else {
          vscode.window.showErrorMessage(`osd rebuild (warm): ${result.issues.length} issue(s), see the output channel`);
        }
      }
      this.emitter.fire();
      return undefined;
    } catch (e) {
      this.output.appendLine(`osd rebuild (warm): ${String(e.message ?? e)} -- falling back to a full rebuild`);
      return this.rebuild();
    }
  }

  async openLaunchpad(where = "default") {
    if (this.launcher?.state !== "running") {
      vscode.window.showInformationMessage("osd: not running -- osd.start first");
      return;
    }
    await openPage(`http://localhost:${this.launcher.port}/app/flp.html`, {title: "Fiori Launchpad", panelType: "osdLaunchpad", where});
  }

  /** "osd: Open launchpad inside VS Code" (the palette): always a VS Code
   *  tab, whatever `osd.openIn` says -- the way to get the tab once when the
   *  setting is "browser". openLaunchpad() follows the setting, and
   *  osd.openLaunchpadExternal always uses the browser. */
  async openLaunchpadInVsCode() {
    if (this.launcher?.state !== "running") {
      vscode.window.showInformationMessage("osd: not running -- osd.start first");
      return;
    }
    await openPage(`http://localhost:${this.launcher.port}/app/flp.html`, {title: "Fiori Launchpad", panelType: "osdLaunchpad", where: "vscode"});
  }
}

/** The Activity Bar tree: state, the layers (base osdHome plus every
 *  detected workspace layer), and the Services this instance registers,
 *  grouped by kind (docs/vscode-extension.md, "Services tree") -- lib.js's
 *  Osd#services() answers whichever of the two sources exists (the
 *  composing route, docs/ideas.md T8, or ZOSD_STATUS_SRV's own ServiceSet),
 *  already normalized; groupServices()/serviceLabel()/serviceClassNodes()
 *  do the rest without needing to know which one it was. */
class OsdTreeProvider {
  constructor(controller, discoverCapabilities = serviceCapabilities) {
    this.controller = controller;
    this.discoverCapabilities = discoverCapabilities;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.groups = [];
    this.rows = [];
    this.capabilitiesByRow = new Map();
    this.transactions = [];
    this.transactionsLoaded = false;
    const saved = controller.context?.workspaceState;
    this.labelBy = saved?.get("osd.services.labelBy") === "description" ? "description" : "name";
    this.sortBy = ["name", "path", "description"].includes(saved?.get("osd.services.sortBy")) ? saved.get("osd.services.sortBy") : "name";
    this.groupBy = saved?.get("osd.services.groupBy") === "layer" ? "layer" : "kind";
    this.hideBase = saved?.get("osd.services.hideBase") === true;
    // T7 (docs/vscode-extension.md "Warm"): /osd/serving's own `warm` field,
    // shown on the state row the way the status bar shows it.
    this.warm = undefined;
    const refresh = () => this.refresh(true).then(() => this.emitter.fire(), () => this.emitter.fire());
    controller.onDidChange(refresh);
    // the prime finishing, or a swap happening, is not a controller state
    // change (start/stop/rebuild) -- nothing else tells this the row is
    // stale, so it polls the same way the status bar does, and only while
    // there is something running to ask.
    this.timer = setInterval(() => {
      if (this.controller.launcher?.state === "running") this.refresh().then(() => this.emitter.fire(), () => this.emitter.fire());
    }, 5000);
  }

  dispose() {
    clearInterval(this.timer);
  }

  /** Both live reads this row and the Services tree depend on: osd.refreshTree
   *  (view/title's own $(refresh)) calls this by name, and so does the
   *  constructor's own timer and controller listener. */
  async refresh(forceTransactions = false) {
    if (forceTransactions) this.capabilitiesByRow.clear();
    await Promise.all([this.refreshServices(), this.refreshTransactions(forceTransactions), this.#refreshWarm()]);
  }

  async #refreshWarm() {
    if (this.controller.launcher?.state !== "running") {
      this.warm = undefined;
      return;
    }
    try {
      this.warm = (await osd().serving()).warm;
    } catch {
      this.warm = undefined;
    }
  }

  async refreshServices() {
    if (this.controller.launcher?.state !== "running") {
      this.rows = [];
      this.groups = [];
      this.capabilitiesByRow.clear();
      return;
    }
    try {
      const workspacePacks = new Map();
      for (const layer of this.controller.launcher?.layers ?? []) {
        const label = `workspace ${path.basename(layer.folder)}`;
        workspacePacks.set(packNameOf(layer.folder), label);
        if (layer.manifest) {
          const manifest = JSON.parse(fs.readFileSync(layer.manifest, "utf8"));
          workspacePacks.set(String(manifest.name ?? path.basename(layer.folder)).toLowerCase(), label);
        }
      }
      this.rows = (await osd().services()).map((row) => ({...row, layer: workspacePacks.get(row.pack) ?? row.pack ?? "base"}));
      for (const row of this.rows) {
        const saved = this.capabilitiesByRow.get(serviceRowKey(row));
        if (saved !== undefined) row.detailsCapabilities = saved;
      }
      this.regroupServices();
    } catch {
      this.rows = [];
      this.groups = [];
    }
  }

  async refreshTransactions(force = false) {
    if (this.controller.launcher?.state !== "running") {
      this.transactions = [];
      this.transactionsLoaded = false;
      return;
    }
    if (this.transactionsLoaded && !force) return;
    try {
      this.transactions = await osd().transactions();
    } catch {
      this.transactions = [];
    }
    this.transactionsLoaded = true;
  }

  regroupServices() {
    this.groups = groupServices(this.rows, this.groupBy, this.sortBy, this.hideBase);
  }

  async setServiceOption(option, value) {
    const allowed = {labelBy: ["name", "description"], sortBy: ["name", "path", "description"], groupBy: ["kind", "layer"], hideBase: [true, false]};
    if (!allowed[option]?.includes(value)) return;
    this[option] = value;
    await this.controller.context.workspaceState.update(`osd.services.${option}`, value);
    this.regroupServices();
    this.emitter.fire();
  }

  getTreeItem(element) {
    return element;
  }

  getChildren(element) {
    if (element === undefined) {
      return this.rootItems();
    }
    if (element.contextValue === "osd-layers") {
      return this.layerItems();
    }
    if (element.contextValue === "osd-services") {
      return this.serviceGroupItems();
    }
    if (element instanceof SystemGroupItem) {
      return systemDoorItems();
    }
    if (element instanceof TransactionGroupItem) {
      return this.transactionItems();
    }
    if (element instanceof ServiceGroupItem) {
      return element.group.groupBy === "layer" ? element.group.groups.map((group) => new ServiceGroupItem(group)) : this.serviceRowItems(element.group);
    }
    if (element instanceof ServiceRowItem) {
      return this.serviceClassItems(element.row);
    }
    return [];
  }

  rootItems() {
    const launcher = this.controller.launcher;
    const state = launcher?.state ?? "stopped";
    const source = homeSourceText(this.controller.homeSource);
    const sourceSuffix = source === undefined ? "" : ` · ${source}`;
    const warmText = warmStatusText(this.warm);
    const swaps = this.warm?.swaps ?? 0;
    const label = state === "running"
      ? `Running on :${launcher.port} · ${launcher.databaseLabel}, generation ${String(launcher.generation).slice(0, 8)}` +
        (warmText ? ` · ${warmText}` : "") + (swaps ? ` +${swaps}` : "") + sourceSuffix
      : state === "stopped" ? `Stopped (click here!)${sourceSuffix}`
        : `${state[0].toUpperCase()}${state.slice(1)}…${sourceSuffix}`;
    const stateItem = new vscode.TreeItem(label);
    stateItem.iconPath = new vscode.ThemeIcon(
      state === "running" ? "pass-filled" : state === "stopped" ? "circle-large-outline" : "sync~spin");
    stateItem.contextValue = osdStateContext(state);
    stateItem.command = treeClick(stateItem);
    if (this.warm !== undefined) {
      const lastVerify = this.warm.lastVerify === undefined ? "never"
        : `${this.warm.lastVerify.verdict ?? "?"} at ${this.warm.lastVerify.at ?? "?"}`;
      stateItem.tooltip = `warm: ${this.warm.state}${this.warm.reason ? ` (${this.warm.reason})` : ""}\n` +
        `generation: ${this.warm.generation ?? "n/a"}\nunverified: ${(this.warm.unverified ?? []).join(", ") || "none"}\n` +
        `swaps: ${this.warm.swaps ?? 0}\ncopies: ${this.warm.copies ?? 0}\nlast verify: ${lastVerify}`;
    }

    const launchpad = new vscode.TreeItem("▶ Open Fiori Launchpad");
    launchpad.contextValue = "osd-launchpad";
    launchpad.iconPath = new vscode.ThemeIcon("link-external");
    launchpad.tooltip = openTooltip("the Fiori Launchpad");
    launchpad.command = treeClick(launchpad);

    const layers = new vscode.TreeItem("Layers", vscode.TreeItemCollapsibleState.Expanded);
    layers.contextValue = "osd-layers";
    layers.iconPath = new vscode.ThemeIcon("layers");
    layers.command = treeClick(layers);

    const services = new vscode.TreeItem("Services", vscode.TreeItemCollapsibleState.Collapsed);
    services.contextValue = "osd-services";
    services.iconPath = new vscode.ThemeIcon("plug");
    services.command = treeClick(services);

    const system = new SystemGroupItem();
    const transactions = new TransactionGroupItem(this.transactions);
    this.regroupServices();

    system.command = treeClick(system);
    transactions.command = treeClick(transactions);
    return [stateItem, launchpad, system, transactions, layers, services];
  }

  layerItems() {
    const launcher = this.controller.launcher;
    const choice = osdHomeChoiceFor(this.controller.context, this.controller.homeMode);
    const osdHome = launcher?.osdHome ?? choice.path;
    const base = new vscode.TreeItem(osdHome === undefined ? "(osd.home not set, no single workspace folder)" : `base: ${osdHome}`);
    base.iconPath = new vscode.ThemeIcon("folder-library");
    base.contextValue = "osd-layer-base";
    base.command = treeClick(base);
    const items = [base];
    const layers = launcher?.layers ?? (osdHome === undefined ? [] : detectWorkspaceLayers(workspaceFoldersFor(osdHome)));
    for (const layer of layers) {
      const item = new vscode.TreeItem(`workspace: ${layer.folder}`);
      const parts = layerContributions(layer);
      item.description = [`ABAP ${parts.abap} objects`,
        ...(layer.manifest ? [`data ${parts.data} tables`, `ddic ${parts.ddic}`,
          ...(parts.webapp ? [`webapp ${parts.webapp}`] : []), `tiles ${parts.tiles}`] : [])].join(" · ");
      item.tooltip = `${layer.folder}\n${item.description}`;
      item.iconPath = new vscode.ThemeIcon("folder");
      item.contextValue = "osd-layer-workspace";
      item.command = treeClick(item);
      items.push(item);
    }
    return items;
  }

  serviceGroupItems() {
    if (this.controller.launcher?.state !== "running") {
      return [treePlaceholder("(start the system to see its services)")];
    }
    if (this.groups.length === 0) {
      return [treePlaceholder("(none, or nothing answered yet -- osd.refreshTree)")];
    }
    return this.groups.map((group) => new ServiceGroupItem(group));
  }

  async serviceRowItems(group) {
    return Promise.all(group.rows.map(async (row) => {
      const key = serviceRowKey(row);
      let capabilities = row.detailsCapabilities ?? this.capabilitiesByRow.get(key);
      if (capabilities === undefined) {
        try {
          capabilities = await this.discoverCapabilities(row);
        } catch {
          capabilities = {sources: {}, testClasses: []};
        }
        this.capabilitiesByRow.set(key, capabilities);
      }
      row.detailsCapabilities = capabilities;
      return new ServiceRowItem(row, this.labelBy);
    }));
  }

  transactionItems() {
    if (this.controller.launcher?.state !== "running") return [treePlaceholder("(start the system to see transactions)")];
    if (this.transactions.length === 0) return [treePlaceholder("(no transactions registered)")];
    return this.transactions.map((tran) => new TransactionItem(tran));
  }

  refreshItem(item) {
    this.emitter.fire(item);
  }

  rememberCapabilities(row, capabilities) {
    this.capabilitiesByRow.set(serviceRowKey(row), capabilities);
  }

  async serviceClassItems(row) {
    const items = serviceClassNodes(row).map((node) => new ServiceClassItem(node));
    if (row.kind !== "ODATA" || !row.handler) return items;
    // Q2b's own map (tools/adt-facade.mjs core/http/segw/entitysets), lazily
    // -- fetched only once this row is actually expanded, never eagerly for
    // every OData row the group happens to list.
    let map;
    try {
      map = await osd().entitySets(row.handler);
    } catch {
      return items;
    }
    if (map === undefined || !Array.isArray(map.sets) || map.sets.length === 0) return items;
    const root = serviceSourceRoot();
    const ext = row.handler.toUpperCase();
    const base = ext.replace(/_EXT$/, "");
    const sources = {};
    for (const name of new Set([ext, base])) {
      const beside = name === base && row.handlerSource
        ? sourcePath(root, path.join(path.dirname(row.handlerSource), `${base.toLowerCase()}.clas.abap`)) : undefined;
      const file = beside ?? await classSourcePath(name === ext ? row : {handler: name}, "dpc", root);
      try { if (file) sources[name] = {path: file, source: fs.readFileSync(file, "utf8")}; } catch {}
    }
    for (const set of map.sets) {
      const method = resolveImplementationMethod(row.handler, set.method, sources);
      items.push(new EntitySetItem(method?.owner ?? row.handler, set, method?.line, method?.path ?? sources[ext]?.path));
    }
    return items;
  }
}

function serviceRowKey(row) {
  return `${row.kind}\n${row.path}\n${row.handler ?? ""}`;
}

class SystemGroupItem extends vscode.TreeItem {
  constructor() {
    super("System", vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "osd-system-group";
    this.iconPath = new vscode.ThemeIcon("server-environment");
  }
}

function treeClick(item) {
  const kind = item.contextValue?.split(";")[0];
  const leaf = item.collapsibleState === vscode.TreeItemCollapsibleState.None || item.collapsibleState === undefined;
  const title = !leaf ? "Details"
    : kind === "osd-launchpad" ? "Open Fiori Launchpad"
      : kind === "osd-host-open" ? "Open endpoint"
        : kind === "osd-host-dumps" ? "Show short dumps"
          : kind === "osd-service-class" || kind === "osd-service-entityset" ? "Open source"
            : kind === "osd-service-app" && item.row?.path ? "Open app"
              : kind?.startsWith("osd-service-") && item.row?.path && item.row.kind !== "APC" ? "Open service"
                : kind?.startsWith("osd-state-") ? "Open system overview" : "Details";
  return {command: "osd.clickTreeNode", title, arguments: [item]};
}

function treePlaceholder(label) {
  const item = new vscode.TreeItem(label);
  item.contextValue = "osd-placeholder";
  item.command = treeClick(item);
  return item;
}

function systemDoorItems() {
  return [
    new HostDoorItem("Serving", "/osd/serving", "Generation and warm state", "open"),
    new HostDoorItem("Short dumps", "/osd/dumps", "Runtime errors collected by this system", "dumps"),
    new HostDoorItem("SQL", "/osd/sql", "Bounded SELECT door", "sql"),
  ];
}

class HostDoorItem extends vscode.TreeItem {
  constructor(label, route, description, action) {
    super(`${label}  ${route}`, vscode.TreeItemCollapsibleState.None);
    this.route = route;
    this.contextValue = `osd-host-${action}`;
    this.description = description;
    if (action === "open") this.tooltip = openTooltip("this endpoint");
    this.iconPath = new vscode.ThemeIcon(action === "dumps" ? "warning" : action === "sql" ? "database" : "pulse");
    this.command = action === "sql"
      ? {command: "osd.newSqlNotebook", title: "Open SQL notebook"}
      : treeClick(this);
  }
}

class TransactionGroupItem extends vscode.TreeItem {
  constructor(transactions) {
    super(`TRAN (${transactions.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.contextValue = "osd-transactions";
    this.iconPath = new vscode.ThemeIcon("list-tree");
  }
}

class TransactionItem extends vscode.TreeItem {
  constructor(transaction) {
    const label = transaction.text ? `${transaction.tcode} · ${transaction.text}` : transaction.tcode;
    super(label, vscode.TreeItemCollapsibleState.None);
    this.transaction = transaction;
    this.contextValue = transaction.runnable ? "osd-transaction-runnable" : "osd-transaction";
    this.description = `${transaction.kind}${transaction.runnable ? " · runnable" : ""}`;
    this.tooltip = transaction.reason || transaction.source || transaction.tcode;
    this.iconPath = new vscode.ThemeIcon(transaction.kind === "REPORT" ? "symbol-file" : "play");
    this.command = {command: "osd.clickTransaction", title: transaction.runnable ? "Run transaction" : "Transaction details", arguments: [this]};
  }
}

/** One kind's own node ("OData (n)", "Apps (n)", ...), collapsed, its rows
 *  fetched from `group.rows` -- no server round trip of its own, since
 *  refreshServices() above already asked once for the whole tree. */
class ServiceGroupItem extends vscode.TreeItem {
  constructor(group) {
    super(`${group.label} (${group.rows?.length ?? group.groups.reduce((count, child) => count + child.rows.length, 0)})`, vscode.TreeItemCollapsibleState.Collapsed);
    this.group = group;
    this.contextValue = "osd-service-group";
    this.iconPath = new vscode.ThemeIcon(group.groupBy === "layer" ? "layers" : "folder");
    this.command = treeClick(this);
  }
}

/** One service row: an expandable click selects its details panel, and capability flags
 *  control the context actions package.json contributes. A row expands when
 *  serviceClassItems() can produce a class or entity-set child. */
class ServiceRowItem extends vscode.TreeItem {
  constructor(row, labelBy = "name") {
    const {label, description} = serviceLabel(row, labelBy);
    const expandable = serviceClassNodes(row).length > 0;
    super(label, expandable ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
    this.row = row;
    this.description = description;
    this.tooltip = `${label}\n${row.path}`;
    this.contextValue = serviceActionContext(row, row.detailsCapabilities);
    this.iconPath = new vscode.ThemeIcon(
      row.kind === "APP" ? "browser" : row.kind === "ODATA" ? "database" : row.kind === "APC" ? "broadcast" : "plug");
    if (!expandable && row.kind !== "APC" && row.path) {
      this.tooltip = `${row.path}\n${openTooltip("this page")}`;
    }
    this.command = treeClick(this);
  }
}

/** A DPC/MPC/handler class node under a service row, or an entity set under
 *  an OData row's own DPC (EntitySetItem below) -- both leaves, both a
 *  click away from the source they name. */
class ServiceClassItem extends vscode.TreeItem {
  constructor(node) {
    super(node.name, vscode.TreeItemCollapsibleState.None);
    this.node = node;
    this.contextValue = "osd-service-class";
    this.iconPath = new vscode.ThemeIcon("symbol-class");
    this.description = node.role.toUpperCase();
    this.command = treeClick(this);
  }
}

/** One entity set under an OData row's DPC, from `map.sets` (Osd#entitySets)
 *  -- `line` is the mapped method's own line in the DPC EXT or generated base
 *  when it was found in the running base system or a workspace layer,
 *  `undefined` when it was not (the class opens at its top instead, rather
 *  than the node doing nothing at all). */
class EntitySetItem extends vscode.TreeItem {
  constructor(dpcName, set, line, sourceFile) {
    super(set.set, vscode.TreeItemCollapsibleState.None);
    this.dpcName = dpcName;
    this.set = set;
    this.line = line;
    this.sourceFile = sourceFile;
    this.contextValue = "osd-service-entityset";
    this.iconPath = new vscode.ThemeIcon("symbol-field");
    this.description = set.kind;
    this.command = treeClick(this);
  }
}

/** The system browser half of openPage() below (`vscode.env.openExternal`),
 *  used when `osd.openIn` is "browser" or the person chose "Open in External
 *  Browser". The other half is a webview tab inside VS Code, the same
 *  iframe-over-CSP pattern openDataPreview() and, for a running
 *  system's own pages, the gui-reports spike's openWebguiTransaction()
 *  already use: the panel carries no copy of the page, it iframes the
 *  running osd's own URL, so whatever that page does (a click inside the
 *  Fiori launchpad, a $batch request) runs exactly as it does in a
 *  browser tab. `vscode.env.asExternalUri` is asked first either way --
 *  under Remote-WSL/Remote-SSH a bare `http://localhost:<port>` is a
 *  coincidence when it works and a dead port otherwise, the same reasoning
 *  openWebguiTransaction's own comment gives. */
async function openExternalOrOwn(url) {
  let external;
  try {
    external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  } catch {
    external = vscode.Uri.parse(url);
  }
  await vscode.env.openExternal(external);
}

async function openInWebview(url, panelType, title) {
  let external;
  try {
    external = await vscode.env.asExternalUri(vscode.Uri.parse(url));
  } catch {
    external = vscode.Uri.parse(url);
  }
  const panel = vscode.window.createWebviewPanel(panelType, title, vscode.ViewColumn.Beside, {
    enableScripts: true,
    retainContextWhenHidden: true,
  });
  panel.webview.html = iframePanelHtml(external.toString(), title);
  return panel;
}

/** Where a page of the running system opens (Q7): `osd.openIn`, whose
 *  default is a tab inside VS Code, unless the caller names a place -- the
 *  inline $(link-external) action and "Open in External Browser" always say
 *  "browser". A tree item's command gets no modifier keys, so Ctrl/Shift+
 *  click cannot mean "outside"; the explicit action is the only way. */
function openTarget(where = "default") {
  if (where === "browser" || where === "vscode") return where;
  return vscode.workspace.getConfiguration("osd").get("openIn", "vscode") === "browser" ? "browser" : "vscode";
}

// one tab per URL: a second click reveals the tab it already has
const pageTabs = new Map();

/** Stop (or an exit nobody asked for): every page tab shows a page that is
 *  gone, so they close with the system. A rebuild does not come here. */
function closePageTabs() {
  for (const panel of [...pageTabs.values()]) panel.dispose();
  pageTabs.clear();
}

/** What a launcher's life means for the page tabs: an exit nobody asked for
 *  closes them; "running" again (after a rebuild, which is stop-then-start
 *  and keeps them) reloads them. Stop closes them in SystemController.stop(). */
function wirePageTabs(launcher) {
  launcher.on("state", (state) => {
    if (state === "running") void reloadPageTabs(launcher.port);
  });
  launcher.on("exit", () => closePageTabs());
}

/** The details panel's "$metadata" / "in browser" links. */
async function openDetailsMetadata(item, message) {
  await openServiceMetadata(item, message?.where === "browser" ? "browser" : "default");
}

/** The system is serving again after a rebuild: each open page tab loads its
 *  page anew (the new generation), moved to the new port if the port
 *  changed, the way a person would reload a browser tab. */
async function reloadPageTabs(port) {
  for (const [url, panel] of [...pageTabs]) {
    // closed (a Stop, or the person) since the snapshot: nothing to reload
    if (pageTabs.get(url) !== panel) continue;
    let next = url;
    try {
      const u = new URL(url);
      if ((u.hostname === "localhost" || u.hostname === "127.0.0.1") && port !== undefined && u.port !== String(port)) {
        u.port = String(port);
        next = u.toString();
      }
    } catch {
      continue;
    }
    if (next !== url) {
      const there = pageTabs.get(next);
      pageTabs.delete(url);
      if (there !== undefined && there !== panel) {
        // two tabs would now show one page: keep the one already there
        panel.dispose();
        continue;
      }
      pageTabs.set(next, panel);
    }
    let external;
    try {
      external = await vscode.env.asExternalUri(vscode.Uri.parse(next));
    } catch {
      external = vscode.Uri.parse(next);
    }
    // a Stop while that was awaited closed it
    if (pageTabs.get(next) !== panel) continue;
    try {
      panel.webview.html = iframePanelHtml(external.toString(), panel.title ?? next);
    } catch {
      // disposed under us: forget it
      if (pageTabs.get(next) === panel) pageTabs.delete(next);
    }
  }
}

/** The commands that open a page of the running system, registered in one
 *  place so the routing can be tested without activating the extension. */
function registerOpenCommands(context, controller) {
  const register = (command, handler) => context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  register("osd.openLaunchpad", () => controller.openLaunchpad());
  register("osd.openLaunchpadInVsCode", () => controller.openLaunchpadInVsCode());
  register("osd.openLaunchpadExternal", () => controller.openLaunchpad("browser"));
  register("osd.openServiceRow", (item) => openServiceRow(item));
  register("osd.openServiceRowExternal", (item) => openServiceRowExternal(item));
  register("osd.openHostDoor", (route) => openHostDoor(route?.route ?? route));
  register("osd.openHostDoorExternal", (item) => openHostDoor(item?.route ?? item, "browser"));
  register("osd.openServiceMetadata", (item) => openServiceMetadata(item));
  register("osd.openServiceMetadataExternal", (item) => openServiceMetadata(item, "browser"));
}

/** Every tree node that opens a URL comes through here. */
async function openPage(url, {title, panelType = "osdPage", where = "default"} = {}) {
  if (openTarget(where) === "browser") {
    await openExternalOrOwn(url);
    return undefined;
  }
  const open = pageTabs.get(url);
  if (open !== undefined) {
    if (title !== undefined) open.title = title;
    open.reveal();
    return open;
  }
  const panel = await openInWebview(url, panelType, title ?? url);
  pageTabs.set(url, panel);
  panel.onDidDispose(() => {
    // by panel, not by URL: a rebuild may have moved it to another port
    for (const [key, open] of pageTabs) if (open === panel) pageTabs.delete(key);
  });
  return panel;
}

/** The tooltip of a node that opens a page, saying where a click goes. */
function openTooltip(what) {
  return openTarget() === "vscode"
    ? `Single click opens ${what} in a VS Code tab; the link-external action opens it in your browser.`
    : `Single click opens ${what} in your browser (osd.openIn).`;
}

let serviceDetailsPanel;
let serviceDetailsSelection = 0;
let serviceDetailsItem;
let serviceCardTargets = new Map();
let transactionProgramSource;
let transactionClicks = new Map();

function serviceSourceRoot() {
  return activeController?.launcher?.osdHome ?? osdHomeOf() ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function sourcePath(root, relativePath, allowAbsolute = false) {
  if (!relativePath) return undefined;
  const rootPath = path.resolve(root ?? process.cwd());
  if (path.isAbsolute(relativePath) && !allowAbsolute) return undefined;
  const absolute = path.isAbsolute(relativePath) ? path.resolve(relativePath) : path.resolve(rootPath, relativePath);
  if (!path.isAbsolute(relativePath) && (path.relative(rootPath, absolute) === ".." || path.relative(rootPath, absolute).startsWith(`..${path.sep}`))) {
    return undefined;
  }
  return fs.existsSync(absolute) ? absolute : undefined;
}

function testSourcesForService(root, row) {
  const collected = [];
  const seen = new Set();
  const readTree = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        readTree(file);
      } else if (/\.(?:mjs|cjs|js|ts|abap)$/i.test(entry.name) && !seen.has(file)) {
        seen.add(file);
        try { collected.push({path: path.relative(root, file).replaceAll(path.sep, "/"), source: fs.readFileSync(file, "utf8")}); } catch {}
      }
    }
  };
  readTree(path.join(root, "test"));
  return httpTestFiles(collected, row.path, row.name);
}

function serviceCardFiles(root, layers = []) {
  const files = [];
  const seen = new Set();
  const visit = (dir, pack) => {
    let entries;
    try { entries = fs.readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "build") continue;
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(absolute, pack);
      else if (/\.(?:clas\.abap|stg\.yaml|iwpr\.xml|shlp\.xml|ddls\.asddls)$/i.test(entry.name)) {
        if (seen.has(absolute)) continue;
        seen.add(absolute);
        try { files.push({path: pack ? absolute : path.relative(root, absolute).replaceAll(path.sep, "/"),
          source: fs.readFileSync(absolute, "utf8"), pack}); } catch {}
      }
    }
  };
  for (const folder of ["src", "gen", "packs"]) visit(path.join(root, folder));
  for (const layer of layers) {
    let manifest;
    try { if (layer.manifest) manifest = JSON.parse(fs.readFileSync(layer.manifest, "utf8")); } catch {}
    const pack = String(manifest?.name ?? packNameOf(layer.folder)).toLowerCase();
    const folders = manifest ? [manifest.abap ?? (fs.existsSync(path.join(layer.folder, "src")) ? "src" : ".")].flat()
      : [layer.srcDir ?? path.join(layer.folder, "src")];
    for (const folder of folders) {
      if (folder === false) continue;
      const absolute = path.resolve(layer.folder, folder);
      if (absolute === layer.folder || absolute.startsWith(layer.folder + path.sep)) visit(absolute, pack);
    }
  }
  return files;
}

async function classSourcePath(row, role, root) {
  const direct = sourcePath(root, role === "dpc" || role === "handler" ? row.handlerSource : row.mpcSource);
  if (direct) return direct;
  const name = role === "mpc" ? row.mpc : row.handler;
  if (!name) return undefined;
  try {
    const files = await vscode.workspace.findFiles(readerFilePattern({type: "CLAS", name}), EXCLUDE, 1);
    return files[0]?.fsPath;
  } catch { return undefined; }
}

/** Resolve menu targets as the kind group is expanded, before a row can be
 *  right-clicked. The full details panel can still fetch its richer data
 *  only when selected. */
async function serviceCapabilities(row) {
  const root = serviceSourceRoot();
  const sources = {};
  const classes = row.kind === "ODATA"
    ? [{role: "dpc", name: row.handler}, {role: "mpc", name: row.mpc}]
    : row.kind === "APP" ? [] : [{role: "handler", name: row.handler}];
  const closures = await Promise.all(classes.filter(({name}) => name).map(async ({role, name}) => {
    const found = await classSourcePath(row, role, root);
    if (found) sources[role] = {path: found};
    try { return await osd().closure("CLAS", name); } catch { return undefined; }
  }));
  if (row.kind === "APP") {
    const folder = sourcePath(root, row.source);
    if (folder) sources.app = {path: folder};
  } else if (row.kind !== "ODATA") {
    const declaration = sourcePath(root, row.source);
    if (declaration) sources.service = {path: declaration};
  }
  return {sources, testClasses: closureTestNames(...closures)};
}

async function serviceDetailsData(item, provider) {
  const row = item.row;
  const root = serviceSourceRoot();
  const details = {row, sources: {}, metadataUrl: row.kind === "ODATA"
    ? await serviceMetadataExternalUrl(row, osd().url, (url) => vscode.env.asExternalUri(vscode.Uri.parse(url)))
    : undefined};
  if (row.kind === "ODATA") {
    const names = [{role: "dpc", name: row.handler}, {role: "mpc", name: row.mpc}].filter((one) => one.name);
    const settled = await Promise.all(names.map(async ({role, name}) => {
      const [readers, closure] = await Promise.allSettled([osd().readers("CLAS", name), osd().closure("CLAS", name)]);
      details.readers ??= {};
      details.closures ??= {};
      details.readers[role] = readers.status === "fulfilled" ? readers.value : undefined;
      details.closures[role] = closure.status === "fulfilled" ? closure.value : undefined;
      const source = await classSourcePath(row, role, root);
      details.sources[role] = source ? {path: source} : undefined;
      return closure.status === "fulfilled" ? closure.value : undefined;
    }));
    try {
      const map = row.handler ? await osd().entitySets(row.handler) : undefined;
      details.entitySets = map?.sets ?? [];
    } catch (e) {
      details.entitySets = [];
      details.entitySetsError = String(e.message ?? e);
    }
    details.card = serviceCardModel(row, details.entitySets, serviceCardFiles(root, activeController?.launcher?.layers ?? []));
    const [serving, dumps] = await Promise.allSettled([osd().serving(), osd().dumps()]);
    details.serving = serving.status === "fulfilled" ? serving.value : undefined;
    details.dumps = dumpsForService(dumps.status === "fulfilled" ? dumps.value : [], row);
    details.httpTests = testSourcesForService(root, row);
    item.row.detailsCapabilities = {
      sources: details.sources,
      testClasses: closureTestNames(...settled),
    };
  } else if (row.kind === "APP") {
    const folder = sourcePath(root, row.source);
    if (folder) {
      try {
        const manifest = JSON.parse(fs.readFileSync(path.join(folder, "manifest.json"), "utf8"));
        details.app = appManifestDetails(manifest, row, provider.rows);
      } catch {
        details.app = appManifestDetails({}, row, provider.rows);
      }
    } else {
      details.app = appManifestDetails({}, row, provider.rows);
    }
    details.sources.app = folder ? {path: folder} : undefined;
    item.row.detailsCapabilities = {sources: details.sources, testClasses: []};
  } else {
    const handler = await classSourcePath(row, "handler", root);
    const declaration = sourcePath(root, row.source);
    details.sources.handler = handler ? {path: handler} : undefined;
    details.sources.service = declaration ? {path: declaration} : undefined;
    let closure;
    if (row.handler) {
      const [readers, found] = await Promise.allSettled([osd().readers("CLAS", row.handler), osd().closure("CLAS", row.handler)]);
      details.readers = readers.status === "fulfilled" ? readers.value : undefined;
      closure = found.status === "fulfilled" ? found.value : undefined;
      details.closure = closure;
    }
    item.row.detailsCapabilities = {sources: details.sources, testClasses: closureTestNames(closure)};
  }
  item.contextValue = serviceActionContext(row, item.row.detailsCapabilities);
  provider.rememberCapabilities(row, item.row.detailsCapabilities);
  provider.refreshItem(item);
  return details;
}

async function showServiceDetails(item, provider, output) {
  if (!item?.row) return;
  ensureDetailsPanel(output);
  serviceDetailsItem = item;
  serviceCardTargets = new Map();
  transactionProgramSource = undefined;
  const selection = ++serviceDetailsSelection;
  serviceDetailsPanel.title = `${serviceLabel(item.row).label} · Details`;
  serviceDetailsPanel.webview.html = serviceDetailsHtml({row: item.row}, "loading");
  try {
    const details = await serviceDetailsData(item, provider);
    if (selection === serviceDetailsSelection && serviceDetailsPanel !== undefined) {
      const nonce = crypto.randomBytes(16).toString("base64");
      serviceCardTargets = new Map([
        ...details.card?.model ?? [],
        ...details.card?.generic ?? [],
        ...details.card?.entitySets.flatMap((set) => [...set.sources, ...set.operations.map((op) => op.link).filter(Boolean)]) ?? [],
        ...details.card?.functionImports.map((item) => item.link).filter(Boolean) ?? [],
      ].map((target) => [`${target.path}:${target.line}`, target]));
      serviceDetailsPanel.webview.html = serviceDetailsHtml(details, nonce);
    }
  } catch (e) {
    output?.appendLine(`osd service details ${item.row.name ?? item.row.path}: ${String(e.message ?? e)}`);
    if (selection === serviceDetailsSelection && serviceDetailsPanel !== undefined) {
      serviceDetailsPanel.webview.html = serviceDetailsHtml({row: item.row, entitySetsError: String(e.message ?? e)}, crypto.randomBytes(16).toString("base64"));
    }
  }
}

function ensureDetailsPanel(output) {
  if (serviceDetailsPanel !== undefined) return;
  serviceDetailsPanel = vscode.window.createWebviewPanel("osdDetails", "Details",
    {viewColumn: vscode.ViewColumn.Beside, preserveFocus: true},
    {enableScripts: true, retainContextWhenHidden: false});
  serviceDetailsPanel.webview.onDidReceiveMessage(async (message) => {
    if (message?.command === "openCardPath") {
      const target = serviceCardTargets.get(`${message.path}:${message.line}`);
      const absolute = target && sourcePath(serviceSourceRoot(), target.path, path.isAbsolute(target.path));
      if (!absolute) return;
      const editor = await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.file(absolute)));
      const at = new vscode.Position(Math.max(0, target.line - 1), 0);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at));
      return;
    }
    if (message?.command === "openMetadata") {
      await openDetailsMetadata(serviceDetailsItem, message);
      return;
    }
    if (message?.command !== "openSource") return;
    if (message.role === "program") await openTransactionProgram(transactionProgramSource, output);
    else await openServiceSource(serviceDetailsItem, message.role, output);
  });
  serviceDetailsPanel.onDidDispose(() => {
    serviceDetailsPanel = undefined;
    serviceDetailsItem = undefined;
    serviceCardTargets = new Map();
    transactionProgramSource = undefined;
    serviceDetailsSelection += 1;
  });
}

/** Resolve the winning ABAP object path returned by the transaction route.
 *  A stale or missing file never gets a link in the details panel. */
function transactionProgramPath(row) {
  const source = sourcePath(serviceSourceRoot(), row?.programSource);
  if (!source) return undefined;
  try { return fs.statSync(source).isFile() ? source : undefined; } catch { return undefined; }
}

function showTransactionDetails(item, output) {
  if (!item?.transaction) return;
  ensureDetailsPanel(output);
  serviceDetailsItem = undefined;
  const root = serviceSourceRoot();
  const absolute = transactionProgramPath(item.transaction);
  transactionProgramSource = absolute;
  const relative = absolute && root ? path.relative(root, absolute).replaceAll(path.sep, "/") : undefined;
  const details = transactionDetailsModel(item.transaction, relative);
  serviceDetailsSelection += 1;
  serviceDetailsPanel.title = `${details.tcode} · Details`;
  serviceDetailsPanel.webview.html = transactionDetailsHtml(details, crypto.randomBytes(16).toString("base64"));
}

async function openTransactionProgram(source, output) {
  if (!source || !fs.existsSync(source)) return;
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(source));
    await vscode.window.showTextDocument(document);
  } catch (e) {
    output?.appendLine(`osd open transaction source ${source}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

function clickTransaction(item, output) {
  if (!item?.transaction) return;
  if (item.collapsibleState === vscode.TreeItemCollapsibleState.None) {
    if (item.transaction.runnable) return openWebguiTransaction(item.transaction.tcode, output, undefined, {type: item.transaction.className ? "CLAS" : "PROG", name: item.transaction.className || item.transaction.program});
    return showTransactionDetails(item, output);
  }
  const classified = classifyTransactionClick(transactionClicks, item.transaction.tcode, Date.now());
  transactionClicks = classified.clicks;
  if (classified.action === "double") {
    if (item.transaction.runnable) return openWebguiTransaction(item.transaction.tcode, output, undefined, {type: item.transaction.className ? "CLAS" : "PROG", name: item.transaction.className || item.transaction.program});
    return;
  }
  showTransactionDetails(item, output);
}

let treeClicks = new Map();

/** Leaf actions are immediate; only rows with children use the classifier. */
async function clickTreeNode(item, provider, output) {
  if (!item) return;
  const kind = item.contextValue?.split(";")[0] ?? "";
  if (item.collapsibleState === vscode.TreeItemCollapsibleState.None || item.collapsibleState === undefined) {
    if (kind === "osd-launchpad") return provider.controller.openLaunchpad();
    if (kind === "osd-host-open") return openHostDoor(item.route);
    if (kind === "osd-host-dumps") return showDumps(output);
    if (kind.startsWith("osd-service-") && item.row?.path && item.row.kind !== "APC") return openServiceRow(item);
    if (kind === "osd-service-class") return openServiceClass(item.node, output);
    if (kind === "osd-service-entityset") return openEntitySetMethod(item.dpcName, item.set, item.line, output, item.sourceFile);
    if (kind.startsWith("osd-state-")) return provider.controller.openSystemOverview();
    if (item.row) return showServiceDetails(item, provider, output);
    return showTreeNodeDetails(item, output);
  }
  const identity = item.route ?? item.row?.path ?? item.node?.name ??
    (item.dpcName ? `${item.dpcName}/${item.set?.set}/${item.set?.kind}` : undefined) ?? item.group?.label ?? item.label;
  const key = `${kind}:${identity}`;
  const classified = classifyTransactionClick(treeClicks, key, Date.now());
  treeClicks = classified.clicks;
  if (classified.action === "double") {
    if (kind === "osd-launchpad") return provider.controller.openLaunchpad();
    if (kind === "osd-host-open") return openHostDoor(item.route);
    if (kind === "osd-host-dumps") return showDumps(output);
    if (kind.startsWith("osd-service-") && item.row) return openServiceRow(item);
    if (kind === "osd-service-class") return openServiceClass(item.node, output);
    if (kind === "osd-service-entityset") return openEntitySetMethod(item.dpcName, item.set, item.line, output, item.sourceFile);
  }
  if (item.row) return showServiceDetails(item, provider, output);
  showTreeNodeDetails(item, output);
}

function showTreeNodeDetails(item, output) {
  ensureDetailsPanel(output);
  serviceDetailsItem = undefined;
  transactionProgramSource = undefined;
  serviceDetailsSelection += 1;
  const kind = item.contextValue?.split(";")[0] ?? "";
  const title = String(item.label ?? "OSD tree");
  const explanation = kind === "osd-launchpad" ? "Fiori Launchpad for the running system. Click to open it."
    : kind === "osd-host-open" ? "Serving status, generation, database, and warm build state. Click to open the endpoint."
      : kind === "osd-host-dumps" ? "Short dumps collected from runtime errors. Click to list them in Output."
        : kind === "osd-system-group" ? "System endpoints for serving state, short dumps, and SQL. Expand to inspect them."
          : kind === "osd-transactions" ? "Registered transactions. Expand to inspect each transaction and run runnable ones."
            : kind === "osd-layers" ? "The base system and workspace layers that compose this instance."
              : kind === "osd-layer-base" ? "Base system source folder used by this instance."
                : kind === "osd-layer-workspace" ? "Workspace source layered over the base system."
                  : kind === "osd-services" ? "Services registered by the running system, grouped by kind or pack."
                    : kind === "osd-service-group" ? `Services in the ${item.group.label} group. Expand to inspect each service.`
                      : kind === "osd-service-class" ? `${item.node.role.toUpperCase()} class ${item.node.name}. Click to open its source file.`
                        : kind === "osd-service-entityset" ? `Entity set ${item.set.set} (${item.set.kind}) in ${item.dpcName}. Click to open its implementation method.`
                          : "This row describes the current tree state. Expand its parent or refresh the tree when the system changes.";
  serviceDetailsPanel.title = `${title} · Details`;
  serviceDetailsPanel.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';"><style>body{font:13px var(--vscode-font-family);color:var(--vscode-foreground);padding:0 20px;max-width:1000px}h1{font-size:20px}</style></head><body><h1>${htmlEscape(title)}</h1><p>${htmlEscape(explanation)}</p></body></html>`;
}

async function openServiceSource(item, role, output) {
  const source = item?.row?.detailsCapabilities?.sources?.[role]?.path ??
    (role === "service" || role === "app" ? item?.row?.source : undefined);
  const root = serviceSourceRoot();
  const target = sourcePath(root, source, path.isAbsolute(source ?? ""));
  if (!target) {
    vscode.window.showWarningMessage(`osd: ${role} source was not found for ${item?.row?.name ?? item?.row?.path ?? "service"}`);
    return;
  }
  try {
    if (role === "app") {
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(target));
    } else {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
      await vscode.window.showTextDocument(document);
    }
  } catch (e) {
    output?.appendLine(`osd open service source ${target}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

/** frame-src names the one origin this panel is allowed to embed; nothing
 *  else in the page runs a script of its own, so a strict default-src
 *  'none' beside it costs nothing (the gui-reports spike's own
 *  webguiPanelHtml, reused verbatim in shape). */
function iframePanelHtml(url, title) {
  const origin = new URL(url).origin;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${xmlEscapeHtml(origin)}; style-src 'unsafe-inline';">
<style>html,body{margin:0;height:100%;background:#1f4e79}iframe{border:0;width:100%;height:100%;display:block}</style>
</head>
<body><iframe src="${xmlEscapeHtml(url)}" title="${xmlEscapeHtml(title)}"></iframe></body>
</html>`;
}

async function openServiceRow(item, where = "default") {
  const row = item?.row ?? item;
  if (row === undefined || row.kind === "APC" || !row.path) return;
  await openPage(serviceHttpUrl(row, osd().url), {title: serviceLabel(row).label, panelType: "osdService", where});
}

async function openServiceRowExternal(item) {
  await openServiceRow(item, "browser");
}

async function openHostDoor(route, where = "default") {
  if (!route) return;
  await openPage(`${osd().url}${route}`, {title: route, panelType: "osdEndpoint", where});
}

async function copyServiceUrl(item) {
  const row = item?.row ?? item;
  if (row === undefined) return;
  await vscode.env.clipboard.writeText(serviceHttpUrl(row, osd().url));
  vscode.window.setStatusBarMessage(`osd: copied ${row.path}`, 3000);
}

async function copyServiceWsUrl(item) {
  const row = item?.row ?? item;
  if (row === undefined) return;
  await vscode.env.clipboard.writeText(serviceWsUrl(row, osd().url));
  vscode.window.setStatusBarMessage(`osd: copied ${row.path} (ws://)`, 3000);
}

async function copyServiceMetadata(item) {
  const row = item?.row ?? item;
  if (!row?.path || row.kind !== "ODATA") return;
  const url = serviceMetadataUrl(row, osd().url);
  await vscode.env.clipboard.writeText(url);
  vscode.window.setStatusBarMessage(`osd: copied ${row.path}/$metadata`, 3000);
}

async function openServiceMetadata(item, where = "default") {
  const row = item?.row ?? item;
  if (!row?.path || row.kind !== "ODATA") return;
  await openPage(serviceMetadataUrl(row, osd().url), {title: `${serviceLabel(row).label} $metadata`, panelType: "osdServiceMetadata", where});
}

async function testServiceClosure(item, output) {
  const row = item?.row;
  const names = row?.detailsCapabilities?.testClasses ?? [];
  if (names.length === 0) return;
  output.appendLine(`osd service tests ${row.name ?? row.path}: ${names.join(", ")}`);
  let methods = 0;
  let failures = 0;
  for (const name of names) {
    try {
      if (kernelDiagnostics && !(await kernelDiagnostics.allow(undefined, {type: "CLAS", name}))) { failures += 1; continue; }
      const run = await osd().run({type: "CLAS", name});
      const results = outcomes(run);
      methods += results.length;
      failures += results.filter((result) => result.passed !== true).length;
      output.appendLine(`  ${name}: ${results.length} method(s), ${results.filter((result) => result.passed !== true).length} failed`);
    } catch (e) {
      failures += 1;
      output.appendLine(`  ${name}: ${String(e.message ?? e)}`);
    }
  }
  const summary = `${methods} test method(s), ${failures} failed`;
  output.appendLine(`osd service tests: ${summary}`);
  vscode.window.setStatusBarMessage(`osd: service tests ${summary}`, 5000);
}

/** A DPC/MPC/handler class node's own click: a workspace glob on the name
 *  (readerFilePattern, the same lookup Q3's "read by" quick pick already
 *  uses), open at the top -- the composing route's own `handlerUri` names
 *  the class the same way Check/Activate do, but this extension opens by
 *  file, not by ADT uri, so the file glob is what every source path here
 *  goes through regardless of which of the two sources answered. */
async function openServiceClass(node, output) {
  if (node?.name === undefined) return;
  const direct = sourcePath(serviceSourceRoot(), node.source);
  if (direct) {
    try {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(direct));
      await vscode.window.showTextDocument(document);
      return;
    } catch (e) {
      output?.appendLine(`osd open service class ${node.name}: ${String(e.message ?? e)}`);
    }
  }
  const pattern = readerFilePattern({type: "CLAS", name: node.name});
  try {
    const files = await vscode.workspace.findFiles(pattern, EXCLUDE, 1);
    if (files.length === 0) {
      vscode.window.showWarningMessage(`osd: ${node.name}'s file was not found in this workspace`);
      return;
    }
    await vscode.window.showTextDocument(files[0]);
  } catch (e) {
    output?.appendLine(`osd open service class ${node.name}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

/** An entity set node's own click: use the DPC source found while building
 *  the node, including the running base system outside the open workspace.
 *  The method line is optional; absent it, the class opens at its top. */
async function openEntitySetMethod(dpcName, set, line, output, sourceFile) {
  try {
    const target = sourceFile && fs.existsSync(sourceFile) ? sourceFile
      : await classSourcePath({handler: dpcName}, "dpc", serviceSourceRoot());
    if (!target) {
      vscode.window.showWarningMessage(`osd: ${dpcName}'s source file was not found in the running system or workspace`);
      return;
    }
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const editor = await vscode.window.showTextDocument(document);
    if (typeof line === "number") {
      const at = new vscode.Position(line - 1, 0);
      editor.selection = new vscode.Selection(at, at);
      editor.revealRange(new vscode.Range(at, at));
    }
  } catch (e) {
    output?.appendLine(`osd open entity set ${dpcName} ${set?.set}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

/** Keep launch state separate from the serving generation and job counts:
 *  each is labelled, and the system/jobs clicks share the same actions. */
function runningParts(controller) {
  const launcher = controller.launcher;
  const state = launcher?.state ?? "stopped";
  const items = [{label: "OSD system", description: state,
    detail: state === "stopped" ? "Start system" : "Show overview",
    command: state === "stopped" ? "osd.start" : "osd.openSystemOverview"}];
  if (workerEnabled(launcher?.jobsWorkerMode, launcher?.env)) {
    const worker = launcher.jobWorker;
    const other = worker?.otherWindow;
    items.push({label: "Job worker", description: other ? "running in another window" : worker?.running ? "running" : "stopped",
      detail: other || worker?.running ? "Show jobs" : state === "running" ? "Start worker" : state === "stopped" ? "Start system" : "Show overview",
      command: other || worker?.running ? "osd.showJobs" : state === "running" ? "osd.startJobWorker" : state === "stopped" ? "osd.start" : "osd.openSystemOverview"});
  }
  if (workerEnabled(launcher?.jobsWorkerMode, launcher?.env)) {
    items.push({label: "Show raw job log", detail: "Worker JSON events and diagnostics", command: "osd.showRawJobLog"});
  }
  items.push({label: "Open sample", detail: "Choose a notebook or hello class", command: "osd.openSample"});
  items.push({label: "System overview", detail: "Show overview", command: "osd.openSystemOverview"});
  return items;
}

async function showRunning(controller) {
  const picked = await vscode.window.showQuickPick(runningParts(controller), {title: "OSD: What is running?"});
  if (picked) await vscode.commands.executeCommand(picked.command);
}

function startStopStatusBar(context, controller) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 11);
  item.command = "osd.showRunning";
  const refresh = () => {
    const state = controller.launcher?.state ?? "stopped";
    const source = homeSourceText(controller.homeSource);
    item.text = state === "running" ? "$(server) OSD running"
      : state === "stopped" ? "$(play) OSD stopped" : `$(sync~spin) OSD ${state}`;
    item.tooltip = `OSD system: ${state}${source === undefined ? "" : ` · ${source}`}\n` +
      (state === "running" ? `Port ${controller.launcher.port} · ${controller.launcher.databaseLabel}\n` : "") +
      "Click for system and worker actions";
  };
  refresh();
  const off = controller.onDidChange(refresh);
  item.show();
  context.subscriptions.push(vscode.commands.registerCommand("osd.showRunning", () => showRunning(controller)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.startJobWorker", () => {
    const launcher = controller.launcher;
    if (launcher?.state === "running" && workerEnabled(launcher.jobsWorkerMode, launcher.env)) {
      launcher.jobWorker?.start();
    }
  }));
  context.subscriptions.push({dispose: () => {
    off.dispose();
    item.dispose();
  }});
  return item;
}

/** One click delegates to VS Code's own breakpoint activation switch. */
function breakpointToggleStatusBar(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 12);
  item.text = breakpointToggleText();
  item.tooltip = "Toggle whether VS Code reacts to breakpoints; markers stay set";
  item.command = "osd.toggleBreakpoints";
  const command = vscode.commands.registerCommand("osd.toggleBreakpoints", async () => {
    try {
      await vscode.commands.executeCommand("workbench.debug.viewlet.action.toggleBreakpointsActivatedAction");
    } catch (e) {
      vscode.window.showErrorMessage(`osd: could not toggle breakpoints: ${String(e.message ?? e)}`);
    }
  });
  item.show();
  context.subscriptions.push(command, {dispose: () => item.dispose()});
  return item;
}

/** A breakpoint binds only in the file the running generation's source maps
 *  name (docs/debugging-abap.md, "Which copy"). A checkout opened beside the
 *  bundled copy, an `osd.home` pointing elsewhere, or an object a later
 *  layer overrides all look like the right file and never stop. Checked when
 *  an OSD debug session starts and when a breakpoint is added during one;
 *  each file is named once per generation. */
function breakpointGuard(context) {
  let cached;
  const warned = new Set();
  const osdSessionActive = () => [...(activeController?.debugSessions ?? [])].some((session) => session.name.startsWith("OSD:"));
  const running = () => {
    const launcher = activeController?.launcher;
    if (launcher === undefined || launcher.osdHome === undefined) return undefined;
    let generation;
    try {
      generation = fs.realpathSync(path.join(launcher.osdHome, "output"));
    } catch {
      return undefined;
    }
    if (cached?.generation !== generation) {
      cached = runningAbapSources(launcher.osdHome, {storageDir: launcher.storageDir, layers: launcher.layers});
      warned.clear();
    }
    return cached;
  };
  const check = (breakpoints) => {
    const files = breakpoints
      .filter((bp) => bp instanceof vscode.SourceBreakpoint && bp.enabled && bp.location.uri.scheme === "file")
      .map((bp) => bp.location.uri.fsPath)
      .filter((file) => /\.abap$/i.test(file));
    if (files.length === 0) return;
    const sources = running();
    for (const file of new Set(files)) {
      const warning = breakpointWarning(file, sources, {home: activeController?.launcher?.osdHome});
      if (warning === undefined || warned.has(file)) continue;
      warned.add(file);
      const actions = warning.counterpart === undefined ? [] : ["Open the running copy"];
      vscode.window.showWarningMessage(`osd: ${warning.message}`, ...actions).then((picked) => {
        if (picked !== undefined) return vscode.window.showTextDocument(vscode.Uri.file(warning.counterpart));
        return undefined;
      }).then(undefined, (e) => {
        vscode.window.showErrorMessage(`osd: could not open ${warning.counterpart}: ${String(e?.message ?? e)}`);
      });
    }
  };
  if (typeof vscode.debug.onDidChangeBreakpoints === "function") {
    context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((event) => {
      if (osdSessionActive()) check(event.added);
    }));
  }
  if (typeof vscode.debug.onDidStartDebugSession === "function") {
    context.subscriptions.push(vscode.debug.onDidStartDebugSession((session) => {
      if (session.name.startsWith("OSD:")) check(vscode.debug.breakpoints ?? []);
    }));
  }
}

/** Explain the independent debuggers once per workspace, including while stopped. */
function debugOnboarding(context) {
  if (!vscode.debug.onDidChangeBreakpoints) return;
  const workspace = vscode.workspace.workspaceFile?.toString() ??
    (vscode.workspace.workspaceFolders ?? []).map(folder => folder.uri.toString()).sort().join("|");
  const key = `osd.debugOnboarding.v1:${workspace}`;
  let seen = context.globalState.get(key, false);
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints(event => {
    if (seen || !(event.added ?? []).some(bp => bp instanceof vscode.SourceBreakpoint &&
      /\.abap$/i.test(bp.location?.uri?.path ?? bp.location?.uri?.fsPath ?? "") &&
      (!vscode.workspace.getWorkspaceFolder || vscode.workspace.getWorkspaceFolder(bp.location.uri)))) return;
    seen = true;
    void context.globalState.update(key, true);
    void vscode.window.showInformationMessage("osd debugs without a launch configuration: set a breakpoint and press F9 or ▷. 'Attach to server' / 'ABAP on server' belong to the ABAP-FS extension and SAP systems.", "Got it");
  }));
}

/** The debugger on demand, driven by breakpoints: one set (or enabled) in
 *  an .abap file while the system runs opens its inspector and attaches;
 *  the last one removed (or disabled) closes it again once the debug
 *  session has ended (releaseDebugger). Start needs no setting for any of it. */
function debugOnDemand(context, controllerOf = () => activeController) {
  if (typeof vscode.debug.onDidChangeBreakpoints !== "function") return;
  context.subscriptions.push(vscode.debug.onDidChangeBreakpoints((event) => {
    const controller = controllerOf();
    if (controller?.launcher?.state !== "running") return;
    const log = (e) => controller.output.appendLine(`osd debugger: ${String(e?.message ?? e)}`);
    if (abapBreakpoints([...(event.added ?? []), ...(event.changed ?? [])]).length > 0) {
      controller.attachSystemDebugger({onDemand: true}).then((attached) => {
        if (attached !== true && controller.debuggerError !== undefined) log(controller.debuggerError);
      }, log);
      return;
    }
    if (abapBreakpoints([...(event.removed ?? []), ...(event.changed ?? [])], {enabledOnly: false}).length > 0) {
      controller.releaseDebugger().catch(log);
    }
  }));
}

/** Title run and test actions follow the active object independently. */
function editorRunContext(context) {
  const refresh = () => {
    const document = vscode.window.activeTextEditor?.document;
    const object = document && adtObjectOf(document.fileName);
    let source = document?.getText() ?? "", tests = false;
    if (object?.type === "CLAS") {
      const dir = path.dirname(document.fileName);
      try {
        if (object.include !== "main") source = fs.readFileSync(fileOf(dir, object, "main"), "utf8");
        tests = hasTestMethods(fs.readFileSync(fileOf(dir, object, "testclasses"), "utf8"));
      } catch { /* Missing includes carry no test methods. */ }
    }
    void vscode.commands.executeCommand("setContext", "osd.editorClassrun", object?.type === "CLAS" && implementsClassrun(source));
    void vscode.commands.executeCommand("setContext", "osd.editorTests", tests);
  };
  refresh();
  for (const subscribe of [vscode.window.onDidChangeActiveTextEditor, vscode.workspace.onDidChangeTextDocument,
    vscode.workspace.onDidSaveTextDocument]) {
    if (subscribe) context.subscriptions.push(subscribe(refresh));
  }
}

function desktopOutputs(context) {
  const definitions = [
    ["OSD", "extension diagnostics and command/debugger activity."],
    ["OSD: Console", "classrun (F9/▷) output and Check/Activate results."],
    ["OSD: System log", "server builds, runtime and debugger attachment diagnostics."],
  ];
  return definitions.map(([name, purpose]) => {
    const channel = vscode.window.createOutputChannel(name);
    channel.appendLine(`${name}: ${purpose}`);
    context.subscriptions.push(channel);
    return channel;
  });
}

function activate(context) {
  const [output, classrunOutput, systemOutput] = desktopOutputs(context);
  require("./abapgit-zip-command.js").registerAbapgitZipCommand(vscode, context, output, osdHomeOf, isOpenSteamgatePath);
  // The cleanup is synchronous and precedes this window's own launcher.
  // A live lock from another window protects its home.
  try {
    const seedDir = bundledSeedDir(context);
    if (seedDir !== undefined) {
      const seedId = fs.readFileSync(path.join(seedDir, SEED_ID_FILE), "utf8").trim();
      const cleaned = cleanupOldHomes(context.globalStorageUri.fsPath, seedId, {onSaved: (saved) => {
        void vscode.window.showInformationMessage(
          `osd: Saved edits from an old working copy at ${saved}`, "Open saved edits")
          .then((action) => {
            if (action === "Open saved edits") return vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(saved));
          }).catch((error) => output.appendLine(`Could not open saved edits ${saved}: ${error.message}`));
      }});
      for (const {home, error} of cleaned.kept) output.appendLine(`Kept old working copy ${home}: ${error.message}`);
    }
  } catch (error) {
    output.appendLine(`Old working copy cleanup skipped: ${error.message}`);
  }
  const controller = new SystemController(context, systemOutput);
  activeController = controller;
  kernelDiagnostics = registerKernelDiagnostics(vscode, context, output, {
    onCount: (count) => { kernelFindingCount = count; },
    resolveFile: (object) => resolveKernelObjectFile(object, {
      running: controller.runningSources(),
      home: controller.launcher?.osdHome ?? osdHomeOf(),
      layers: controller.launcher?.layers ?? detectWorkspaceLayers(workspaceFoldersFor(osdHomeOf())),
    }),
  });
  void require("./abapfs-bridge.js").registerAbapFsBridge(vscode, context, controller).catch(() => {});
  context.subscriptions.push(statusBar(context));
  require("./jobs-view.js").registerJobsView(vscode, context, controller);
  jobsStatusBar(vscode, context, controller);
  breakpointToggleStatusBar(context);
  breakpointGuard(context);
  debugOnboarding(context);
  debugOnDemand(context);
  context.subscriptions.push(testExplorer(context, output));
  context.subscriptions.push(vscode.commands.registerCommand("osd.showDumps", () => showDumps(output)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.setHanaPassword", () => setDatabasePassword(context, "hana")));
  context.subscriptions.push(vscode.commands.registerCommand("osd.setPostgresPassword", () => setDatabasePassword(context, "postgres")));

  // Q4 "Hotspots" (docs/vscode-extension.md): line decorations and an
  // explorer badge off ZOSD_DUMP, refreshed by command, by a timer and
  // after osd.run / osd.activate (both registered below, which call
  // refreshHotspots() themselves once their own work is done).
  context.subscriptions.push(hotspots(context, output));
  context.subscriptions.push(vscode.commands.registerCommand("osd.refreshHotspots", () => refreshHotspots(output)));

  // Ctrl+F2 / Ctrl+F3 (docs/vscode-extension.md): one diagnostic collection
  // for both, so an activation that passes clears what a check had left, and
  // the other way round.
  registerCheckActivateCommands(context, output, classrunOutput);
  editorRunContext(context);
  context.subscriptions.push(vscode.commands.registerCommand("osd.runTitle", () => run(output, classrunOutput)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.runUnit", () => vscode.commands.executeCommand("testing.runCurrentFile")));
  context.subscriptions.push(vscode.commands.registerCommand("osd.run", () => run(output, classrunOutput)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.runWithDebugger", () => run(output, classrunOutput, true)));

  // Q6b "Classrun" (docs/vscode-extension.md): F9, "Run as ABAP Application
  // (Console)" -- osd.classrun on the current class, standalone (F9's own
  // binding) or reached through F8's dispatch (run(), above) when the class
  // implements IF_OO_ADT_CLASSRUN, regardless of ABAP Unit tests.
  context.subscriptions.push(vscode.commands.registerCommand("osd.classrun", () => classrunCurrent(classrunOutput)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.generateTaxiData", generateTaxiData));
  context.subscriptions.push(vscode.commands.registerCommand("osd.resetTaxiData", resetTaxiData));
  context.subscriptions.push(vscode.commands.registerCommand("osd.classrunWithDebugger", () => classrunCurrent(classrunOutput, true)));

  // Q2b "Runner" (docs/vscode-extension.md): a lens over each
  // `<set>_get_entityset` / `<set>_get_entity` method of a SEGW _DPC_EXT
  // class, and the command it (and F8, above) both call.
  registerEntitySetCommands(context, output, classrunOutput, controller);
  context.subscriptions.push(entitySetLensProvider(output));
  context.subscriptions.push(vscode.commands.registerCommand("osd.httpLensInfo", () => {}));
  // gui-reports spike: "Open in VS Code" for a converted report, the same
  // action F8 (RUN_TABLE.PROG) reaches, placed as a lens above its own
  // REPORT line rather than asked for by name.
  context.subscriptions.push(vscode.commands.registerCommand("osd.openWebguiTransaction", (args) => openWebguiTransaction(args?.tcode, output, args?.file)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.clickTransaction", (item) => clickTransaction(item, output)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.runTransaction", (item) =>
    item?.transaction?.runnable ? openWebguiTransaction(item.transaction.tcode, output, undefined, {type: item.transaction.className ? "CLAS" : "PROG", name: item.transaction.className || item.transaction.program}) : undefined));
  context.subscriptions.push(progLensProvider());

  // Q3 "Readers" (docs/vscode-extension.md): a lens "read by N · tests M ·
  // services K" over a class's or an interface's own definition line, and
  // the quick pick a click on it opens.
  context.subscriptions.push(vscode.commands.registerCommand("osd.showReaders", (found) => showReaders(found, output)));
  context.subscriptions.push(readersLensProvider(output));

  // Q6a "Notebook SQL" (docs/vscode-extension.md): a *.osdnb notebook of SQL
  // cells over the ADT façade's freestyle data preview.
  context.subscriptions.push(vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, sqlNotebookSerializer()));
  context.subscriptions.push(sqlNotebookController(output));
  context.subscriptions.push(vscode.commands.registerCommand("osd.newSqlNotebook", newSqlNotebook));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openSample", () => openSample(context, controller)));

  // The controller is available to the Test Explorer and lenses from their
  // registration onward, including before the first Start.
  context.subscriptions.push(httpLensProvider(output, controller));
  context.subscriptions.push(vscode.commands.registerCommand("osd.gettingStarted", () => {
    const {publisher, name} = context.extension.packageJSON;
    return vscode.commands.executeCommand("workbench.action.openWalkthrough", `${publisher}.${name}#gettingStarted`, false);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("osd.quickStart", (preset) => controller.quickStart(preset ?? "defaults")));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openSystemOverview", () => controller.openSystemOverview()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.removeOldWorkingCopies",
    () => removeOldWorkingCopies(context, controller)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.chooseStartSystem",
    () => chooseStartSystem(context, controller)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.start", () => controller.start()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.stop", () => controller.stop()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.rebuild", () => controller.rebuild()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.rebuildWarm", () => controller.rebuildWarm()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.fullRebuild", () => controller.fullRebuild()));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openSystemLog", () => controller.openLog()));
  registerOpenCommands(context, controller);
  const treeProvider = new OsdTreeProvider(controller);
  // the tooltips of page nodes say where a click goes: redraw them when that changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("osd.openIn")) treeProvider.emitter.fire();
  }));
  context.subscriptions.push(vscode.commands.registerCommand("osd.clickTreeNode", (item) => clickTreeNode(item, treeProvider, output)));
  context.subscriptions.push(treeProvider);
  context.subscriptions.push(vscode.window.registerTreeDataProvider("osdTree", treeProvider));
  context.subscriptions.push(vscode.commands.registerCommand("osd.refreshTree",
    () => treeProvider.refresh(true).then(() => treeProvider.emitter.fire(), () => treeProvider.emitter.fire())));
  for (const [command, option, values] of [
    ["osd.toggleServiceLabel", "labelBy", ["name", "description"]],
    ["osd.cycleServiceSort", "sortBy", ["name", "path", "description"]],
    ["osd.toggleServiceGrouping", "groupBy", ["kind", "layer"]],
    ["osd.toggleServiceBase", "hideBase", [false, true]],
  ]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, () =>
      treeProvider.setServiceOption(option, values[(values.indexOf(treeProvider[option]) + 1) % values.length])));
  }

  // Services tree (docs/vscode-extension.md, "Services tree"): a row's own
  // click shows the reusable details webview (on a leaf it opens the row).
  // Open uses osd.openIn (a VS Code tab by default); the link-external
  // action and "Open in External Browser" always use the system browser.
  context.subscriptions.push(vscode.commands.registerCommand("osd.showServiceDetails", (item) => showServiceDetails(item, treeProvider, output)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openServiceSource", (item, role) => openServiceSource(item, role, output)));
  for (const [command, role] of [["osd.openServiceSourceDpc", "dpc"], ["osd.openServiceSourceMpc", "mpc"],
    ["osd.openServiceSourceHandler", "handler"], ["osd.openServiceSourceApp", "app"],
    ["osd.openServiceSourceDeclaration", "service"]]) {
    context.subscriptions.push(vscode.commands.registerCommand(command, (item) => openServiceSource(item, role, output)));
  }
  context.subscriptions.push(vscode.commands.registerCommand("osd.testServiceClosure", (item) => testServiceClosure(item, output)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.copyServiceUrl", (item) => copyServiceUrl(item)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.copyServiceWsUrl", (item) => copyServiceWsUrl(item)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.copyServiceMetadata", (item) => copyServiceMetadata(item)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openServiceClass", (node) => openServiceClass(node, output)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.openEntitySetMethod",
    (dpcName, set, line, sourceFile) => openEntitySetMethod(dpcName, set, line, output, sourceFile)));
  context.subscriptions.push({dispose: () => {
    serviceDetailsPanel?.dispose();
    serviceDetailsPanel = undefined;
    serviceDetailsItem = undefined;
    transactionProgramSource = undefined;
    transactionClicks = new Map();
    treeClicks = new Map();
  }});
  context.subscriptions.push(startStopStatusBar(context, controller));
}

// the one controller this window's deactivate() stops, if any -- a plain
// module-level slot rather than a class of its own, because there is never
// more than one activate() per window
let activeController;
const servingAvailabilityListeners = new Set();
let servingAvailable;

function setServingAvailability(available) {
  if (available === servingAvailable) return;
  servingAvailable = available;
  for (const listener of servingAvailabilityListeners) listener();
}

// ---- status bar: which generation the system serves, or that it is down

// /osd/serving's own `databaseIdentity.engine` (tools/osd-database-identity.mjs):
// a public, bounded vocabulary, never the connection -- read straight off
// whatever osd.url points to, which need not be an instance this window
// itself started (docs/vscode-extension.md, "Databases").
const DB_ENGINE_LABEL = {sqlite: "SQLite", duckdb: "DuckDB", HDB: "HANA", postgres: "PostgreSQL"};

function statusBar(context, findingCount = () => kernelFindingCount, controller = activeController) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 10);
  item.command = "osd.showDumps";
  item.show();
  let dumpsSeen;
  let disposed = false, pollEpoch = 0, observedLauncher, observedState;
  let awaitingServing = false, misses = 0, firstMiss;
  const resetMisses = () => { misses = 0; firstMiss = undefined; };
  const kernelTooltip = text => {
    let count;
    try { count = findingCount(); } catch { count = "unknown"; }
    return `${text}\nOSD kernel: ${count} finding(s)`;
  };
  const transitioning = () => ["building", "starting", "stopping"].includes(controller?.launcher?.state);
  const visibility = () => {
    if (disposed) return;
    const launcher = controller?.launcher;
    if (launcher !== observedLauncher || launcher?.state !== observedState) {
      observedLauncher = launcher; observedState = launcher?.state; pollEpoch++;
      resetMisses();
      if (["building", "starting", "running"].includes(observedState)) awaitingServing = true;
      else if (["stopped", "failed"].includes(observedState)) {
        awaitingServing = false;
        item.text = "$(debug-disconnect) osd down";
        item.tooltip = kernelTooltip(`System ${observedState}`);
        item.backgroundColor = undefined;
      }
    }
    if (transitioning()) item.hide();
    else {
      if (awaitingServing) {
        item.text = "$(sync~spin) OSD generation: awaiting serving";
        item.tooltip = kernelTooltip("Waiting for the first serving response after Start");
        item.backgroundColor = undefined;
      }
      item.show();
    }
  };
  const onState = controller?.onDidChange(visibility);
  const tick = async () => {
    if (disposed) return;
    visibility();
    if (transitioning()) return;
    if (controller?.launcher && controller.launcher.state !== "running") {
      setServingAvailability(false);
      return;
    }
    const epoch = pollEpoch;
    const client = osd(), url = client.url;
    const current = () => !disposed && epoch === pollEpoch && osd() === client && client.url === url;
    try {
      const serving = await client.serving();
      if (!current()) return;
      if (controller?.launcher && !controller.launcher.ownsServing?.(serving)) {
        awaitingServing = false;
        throw new Error("serving instance mismatch");
      }
      setServingAvailability(true);
      await activeController?.launcher?.refreshJobsGeneration(serving);
      await activeController?.refreshDebuggerGeneration().catch((error) =>
        activeController.output.appendLine(`osd debugger: ${String(error?.message ?? error)}`));
      const dumps = await client.dumps().catch(() => []);
      if (!current()) return;
      awaitingServing = false; resetMisses();
      const generation = String(serving.generation ?? "?").slice(0, 8);
      const warm = serving.warm;
      // T7 (docs/vscode-extension.md "Warm"): the swap count from the warm
      // field when it is there (this façade carries it, #108), else the
      // older `serving.hot.swaps` a system without it still answers with
      const swaps = warm?.swaps ?? serving.hot?.swaps ?? 0;
      const warmText = warmStatusText(warm);
      const engine = serving.databaseIdentity?.engine;
      const dbLabel = DB_ENGINE_LABEL[engine] ?? engine;
      item.text = `$(server) OSD generation ${generation}${dbLabel ? ` · ${dbLabel}` : ""}${warmText ? ` · ${warmText}` : ""}${swaps ? ` +${swaps}` : ""}${dumps.length ? `  $(bug) ${dumps.length}` : ""}`;
      const lastVerify = warm?.lastVerify === undefined ? "never"
        : `${warm.lastVerify.verdict ?? "?"} at ${warm.lastVerify.at ?? "?"}`;
      item.tooltip = `${url}\ngeneration ${serving.generation}\ndatabase ${dbLabel ?? "unknown"}\npid ${serving.pid}` +
        (warm === undefined ? "" : `\nwarm: ${warm.state}${warm.reason ? ` (${warm.reason})` : ""}` +
          `\nwarm generation: ${warm.generation ?? "n/a"}\nunverified: ${(warm.unverified ?? []).join(", ") || "none"}` +
          `\nswaps: ${warm.swaps ?? 0}\ncopies: ${warm.copies ?? 0}\nlast verify: ${lastVerify}`) +
        `\n${dumps.length} short dump(s) -- click to list`;
      item.backgroundColor = dumpsSeen !== undefined && dumps.length > dumpsSeen
        ? new vscode.ThemeColor("statusBarItem.errorBackground") : undefined;
      dumpsSeen ??= dumps.length;
    } catch {
      if (!current()) return;
      if (awaitingServing) {
        firstMiss ??= Date.now(); misses++;
        // Match the jobs grace: require both repeated misses and elapsed time.
        if (misses < 3 || Date.now() - firstMiss < 15000) { visibility(); return; }
        awaitingServing = false;
      }
      setServingAvailability(false);
      item.text = "$(debug-disconnect) osd down";
      item.tooltip = `nothing answers /osd/serving at ${url} (setting osd.url)`;
      item.backgroundColor = undefined;
    }
    item.tooltip = kernelTooltip(item.tooltip);
    // A poll begun before Start may finish after the launcher changes state.
    visibility();
  };
  tick();
  const timer = setInterval(tick, 5000);
  context.subscriptions.push({dispose: () => { disposed = true; clearInterval(timer); onState?.dispose(); }});
  return item;
}

async function showDumps(output) {
  try {
    const dumps = await osd().dumps();
    output.clear();
    if (dumps.length === 0) output.appendLine("No short dumps.");
    for (const d of dumps) {
      output.appendLine(JSON.stringify(d, undefined, 2));
      output.appendLine("");
    }
  } catch (e) {
    output.appendLine(String(e.message ?? e));
  }
  output.show(true);
}

// ---- Q4 "Hotspots" (docs/vscode-extension.md): ZOSD_DUMP as heat -- line
// decorations in an .abap editor and a dump-count badge in the explorer, off
// the counts osd().hotspots() reads through the freestyle SQL door Q6a's
// notebook already uses. `state.data` is the one place the numbers live
// (`{byLine, byFile}`, lib.js `hotspotsFromRows`'s own shape); everything
// below reads it rather than asking the server again.

/** One `vscode.TextEditorDecorationType` per intensity bucket (lib.js
 *  `hotspotBucket`, 1-4), built once and kept for the life of the
 *  extension -- a decoration type is a VS Code resource, and a fresh set
 *  per refresh would leak one on every tick. */
function hotspotDecorationTypes() {
  if (hotspotDecorationTypes.types === undefined) {
    hotspotDecorationTypes.types = [1, 2, 3, 4].map((bucket) => vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: hotspotColor(bucket),
      overviewRulerColor: hotspotColor(bucket),
      overviewRulerLane: vscode.OverviewRulerLane.Right,
    }));
  }
  return hotspotDecorationTypes.types;
}

function decorateEditor(editor, state) {
  if (editor === undefined || !/\.abap$/i.test(editor.document.fileName)) return;
  const object = adtObjectOf(editor.document.fileName);
  const types = hotspotDecorationTypes();
  if (object === undefined) {
    types.forEach((t) => editor.setDecorations(t, []));
    return;
  }
  // perBucket[0] is bucket 1 (one dump), ... perBucket[3] bucket 4 (10+)
  const perBucket = [[], [], [], []];
  for (const entry of state.data.byLine) {
    if (entry.objname !== object.name || entry.include !== object.include) continue;
    const range = new vscode.Range(entry.line - 1, 0, entry.line - 1, 0);
    perBucket[hotspotBucket(entry.count) - 1].push({range, hoverMessage: hotspotHoverText(entry)});
  }
  types.forEach((type, i) => editor.setDecorations(type, perBucket[i]));
}

function decorateVisibleEditors(state) {
  for (const editor of vscode.window.visibleTextEditors) decorateEditor(editor, state);
}

/** `vscode.FileDecorationProvider`: the dump-count badge on an .abap file
 *  in the explorer, off `state.data.byFile` (summed over every include of
 *  the object -- an explorer badge is on the file, not on a class's one
 *  main include). Undefined (no badge) for a file with no dumps, rather
 *  than a "0" nobody asked to see. */
function hotspotFileDecorationProvider(state) {
  return {
    onDidChangeFileDecorations: state.emitter.event,
    provideFileDecoration(uri) {
      if (!/\.abap$/i.test(uri.fsPath)) return undefined;
      const object = adtObjectOf(uri.fsPath);
      const count = object === undefined ? undefined : state.data.byFile[object.name];
      if (!count) return undefined;
      return {
        badge: hotspotBadge(count),
        color: new vscode.ThemeColor("problemsErrorIcon.foreground"),
        tooltip: `${count} dump${count === 1 ? "" : "s"} (osd: Refresh hotspots)`,
      };
    },
  };
}

async function refreshHotspots(output, state) {
  const target = state ?? refreshHotspots.state;
  if (target === undefined) return;
  try {
    target.data = await osd().hotspots();
  } catch (e) {
    output.appendLine(`osd hotspots: ${String(e.message ?? e)}`);
    target.data = {byLine: [], byFile: {}};
  }
  decorateVisibleEditors(target);
  target.emitter.fire(undefined); // every explorer badge this provider owns
}

/** Wires Q4 up: the state `refreshHotspots`/`decorateEditor` share, the
 *  FileDecorationProvider, a refresh on every visible-editor change (a
 *  newly opened editor has had no `setDecorations` call yet) and the timer
 *  (`osd.hotspots.refreshSeconds`, default 30, 0 = off; re-read on a
 *  settings change rather than only at startup). */
function hotspots(context, output) {
  const state = {data: {byLine: [], byFile: {}}, emitter: new vscode.EventEmitter()};
  refreshHotspots.state = state;
  const provider = vscode.window.registerFileDecorationProvider(hotspotFileDecorationProvider(state));
  const onVisible = vscode.window.onDidChangeVisibleTextEditors(() => decorateVisibleEditors(state));

  let timer;
  const restartTimer = () => {
    if (timer !== undefined) clearInterval(timer);
    const seconds = vscode.workspace.getConfiguration("osd").get("hotspots.refreshSeconds", 30);
    timer = seconds > 0 ? setInterval(() => refreshHotspots(output, state), seconds * 1000) : undefined;
  };
  restartTimer();
  const onConfig = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration("osd.hotspots.refreshSeconds")) restartTimer();
  });

  refreshHotspots(output, state);
  return {
    dispose: () => {
      if (timer !== undefined) clearInterval(timer);
      provider.dispose();
      onVisible.dispose();
      onConfig.dispose();
      state.emitter.dispose();
      for (const t of hotspotDecorationTypes()) t.dispose();
      refreshHotspots.state = undefined;
    },
  };
}

// ---- Ctrl+F2 / Ctrl+F3: check and activate the object of the current editor
// (docs/vscode-extension.md), over the ADT façade's checkruns and activation
// routes (tools/adt-facade.mjs). Both keys apply to the whole object, not
// only the include that happens to be open, so an edit in the definitions
// part is checked and activated along with the implementations beside it.

function currentObject() {
  const editor = vscode.window.activeTextEditor;
  if (editor === undefined) return undefined;
  const object = adtObjectOf(editor.document.fileName);
  return object === undefined ? undefined : {editor, object};
}

function registerCheckActivateCommands(context, output, consoleOutput = output) {
  // check and activation keep separate collections: activation clears the
  // documents it no longer reports, which must never erase a check's findings
  const diagnostics = vscode.languages.createDiagnosticCollection("osd-abap");
  const activation = vscode.languages.createDiagnosticCollection("osd-activation");
  const activationDiagnostics = new Map();
  context.subscriptions.push(diagnostics, activation);
  context.subscriptions.push(vscode.commands.registerCommand("osd.check", () => check(diagnostics, output, consoleOutput)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.activate", () => activateCurrent(activation, output, activationDiagnostics, consoleOutput)));
}

// severity -> vscode.DiagnosticSeverity; A and X are ABAP's abort/exception
// levels and read as errors the same as E
function severityOf(code) {
  if (code === "W") return vscode.DiagnosticSeverity.Warning;
  if (code === "I" || code === "S") return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

function diagnosticAt(line, column, message, severity) {
  const at = new vscode.Position(Math.max(0, (line ?? 1) - 1), Math.max(0, (column ?? 1) - 1));
  return new vscode.Diagnostic(new vscode.Range(at, at.translate(0, 1)), message, severityOf(severity));
}

async function check(diagnostics, output, consoleOutput) {
  const current = currentObject();
  if (current === undefined) return;
  const {editor, object} = current;
  try {
    const reports = await osd().check(object, object.include, editor.document.getText());
    const issues = reports.flatMap((r) => r.issues);
    diagnostics.set(editor.document.uri, issues.map((i) => diagnosticAt(i.line, i.column, i.message, i.severity)));
    const failed = reports.filter((r) => r.status === "notProcessed");
    if (failed.length > 0) {
      vscode.window.showErrorMessage(`osd check: ${failed.map((r) => r.statusText).join("; ")}`);
    } else {
      consoleOutput.appendLine(`osd check ${object.name}: ${issues.length === 0 ? "no findings" : `${issues.length} findings`}`);
      consoleOutput.show?.(true);
      vscode.window.setStatusBarMessage(`osd check: ${issues.length === 0 ? "no errors" : `${issues.length} issue(s)`}`, 5000);
    }
  } catch (e) {
    output.appendLine(`osd check ${object.name}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd check: ${String(e.message ?? e)}`);
  }
}

async function activateCurrent(diagnostics, output, activationDiagnostics, consoleOutput) {
  const current = currentObject();
  if (current === undefined) return;
  const {editor, object} = current;
  if (editor.document.isDirty) await editor.document.save();
  try {
    // Includes share an activation scope; other objects, source directories
    // and systems have distinct scopes. Each URI belongs to the last scope
    // that wrote it, so another scope's retry cannot clear newer diagnostics.
    const scope = JSON.stringify([osd().url, path.dirname(editor.document.fileName), object.type, object.name]);
    const writeDiagnostics = (byFile) => {
      for (const [file, owner] of activationDiagnostics) {
        if (owner.scope === scope && !byFile.has(file)) {
          diagnostics.set(owner.uri, []);
          activationDiagnostics.delete(file);
        }
      }
      for (const [file, {uri, issues}] of byFile) {
        diagnostics.set(uri, issues);
        activationDiagnostics.set(file, {scope, uri});
      }
    };
    const result = await osd().activate(object);
    if (result.ok) {
      writeDiagnostics(new Map());
      await activeController?.refreshDebuggerGeneration();
      try {
        const reports = await osd().check(object, object.include, editor.document.getText());
        writeDiagnostics(new Map([[editor.document.fileName, {uri: editor.document.uri,
          issues: reports.flatMap((r) => r.issues).map((i) => diagnosticAt(i.line, i.column, i.message, i.severity)),
        }]]));
      } catch (error) {
        output.appendLine(`osd activate ${object.name}: post-activation check: ${String(error.message ?? error)}`);
      }
      const generation = String(result.generation ?? "?").slice(0, 8);
      // T7 (docs/vscode-extension.md "Warm"): what the build behind this
      // activation was, off X-OSD-Build/X-OSD-Swap-Ms -- "hot-swapped in
      // <ms> ms (warm)", "warm, already live" or "cold build:
      // <reason>" -- plus the closure-tests count (kept on the result for
      // B1, shown here as the line the task asks for).
      const build = activationBuildText(result);
      const tests = closureTestsText(result);
      const extra = [build, tests].filter(Boolean).join(", ");
      consoleOutput.appendLine(`osd activate ${object.name}: activated, generation ${generation}${extra ? ` (${extra})` : ""}`);
      consoleOutput.show?.(true);
      vscode.window.setStatusBarMessage(
        `osd: ${object.name} activated, generation ${generation}${extra ? ` (${extra})` : ""}`, 5000);
    } else {
      // Descriptions are display text ("Class ZCL_A"). Source ownership and
      // include-relative positions come from href, including other objects
      // in the same activation. A location-less message is only a summary.
      const byFile = new Map([[editor.document.fileName, {uri: editor.document.uri, issues: []}]]);
      let located = 0;
      for (const issue of result.issues) {
        const uri = await activationDiagnosticUri(issue.href, editor, object);
        if (uri === undefined) {
          output.appendLine(`osd activate ${object.name}: ${issue.objDescr ? `${issue.objDescr}: ` : ""}${issue.message}`);
          continue;
        }
        if (!byFile.has(uri.fsPath)) byFile.set(uri.fsPath, {uri, issues: []});
        byFile.get(uri.fsPath).issues.push(diagnosticAt(issue.line, issue.column, issue.message, issue.severity));
        located++;
      }
      writeDiagnostics(byFile);
      vscode.window.showErrorMessage(`osd: ${object.name} did not activate (${located || "no"} issue(s), see ${located ? "Problems" : "Output"})`);
    }
    // Q4: an activation is the point a class's own line numbers can have
    // moved, so the heat this object's decorations show is worth a refresh
    // even when nothing has dumped -- and if something had, this is also
    // the soonest an editor open on it would see the new count.
    void refreshHotspots(output);
  } catch (e) {
    output.appendLine(`osd activate ${object.name}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd activate: ${String(e.message ?? e)}`);
  }
}

async function activationDiagnosticUri(href, editor, current) {
  if (!href) return undefined;
  const source = new URL(href, osd().url).pathname;
  const match = /^\/sap\/bc\/adt\/(oo\/classes|oo\/interfaces|programs\/programs)\/([^/]+)(?:\/includes\/([^/]+))?(?:\/source\/main)?\/?$/i.exec(source);
  if (match === null) return undefined;
  const type = {"oo/classes": "clas", "oo/interfaces": "intf", "programs/programs": "prog"}[match[1].toLowerCase()];
  const object = adtObjectOf(`${decodeURIComponent(match[2]).replaceAll("/", "#")}.${type}.abap`);
  if (object === undefined) return undefined;
  let main;
  if (object.type === current.type && object.name === current.name) {
    main = editor.document.fileName;
  } else {
    main = await resolveKernelObjectFile(object, {
      running: activeController?.runningSources(),
      home: activeController?.launcher?.osdHome,
      layers: activeController?.launcher?.layers,
    });
    main ??= (await vscode.workspace.findFiles(readerFilePattern(object), EXCLUDE, 1))[0]?.fsPath;
  }
  return main === undefined ? undefined : vscode.Uri.file(fileOf(path.dirname(main), object, match[3] ?? "main"));
}

// ---- F8: SE80's own key, dispatched by object type (lib.js RUN_TABLE).
// Classrun, reports, data preview and SEGW entity methods reach a run
// action. ABAP Unit runs only through the testing commands.

async function requireDebugSystem(output, action, controller = activeController) {
  controller?.debugNote?.(`${action} with debugger: attaching`);
  const attached = await controller?.attachSystemDebugger({onDemand: true});
  controller?.debugNote?.(`${action} with debugger: attach ${attached === true ? "done" : "failed"}`);
  if (attached === true) return true;
  const reason = controller?.debuggerError ?? "the system is not running; start it with osd: Start";
  const message = `${action} with debugger: ${reason}`;
  output.appendLine(`osd debugger: ${message}`);
  vscode.window.showWarningMessage(`osd: ${message}`);
  return false;
}

async function run(output, classrunOutput, forceDebugger = false) {
  const current = currentObject();
  if (current === undefined) {
    // Q7: a TABL or a DDLS -- adtObjectOf (currentObject's own) knows
    // neither type (Check/Activate do not reach them), so they are found
    // here instead, off the file F8 was pressed on.
    const editor = vscode.window.activeTextEditor;
    const preview = editor === undefined ? undefined : dataPreviewObjectOf(editor.document.fileName);
    if (preview === undefined) return;
    const hasMandt = preview.type === "TABL" && tablHasMandt(editor.document.getText());
    const action = runActionFor(preview);
    if (action.kind === "data-preview") {
      if (forceDebugger && !(await requireDebugSystem(output, "Run"))) return;
      await openDataPreview(action.objectType, action.name, hasMandt, output);
    } else {
      output.appendLine(`osd run ${preview.name}: ${action.text}`);
      vscode.window.showInformationMessage(`osd: ${action.text}`);
    }
    return;
  }
  const {editor, object} = current;
  if (kernelDiagnostics && !(await kernelDiagnostics.allow(editor.document.fileName))) return;
  // Q6b: read straight off the buffer VS Code already has, not necessarily
  // saved -- the same "the editor's own text" Ctrl+F2 already does for a
  // check. Only asked for a CLAS; the regex would never match anything
  // else, but there is no reason to run it over a table or a CDS view.
  const hasClassrun = object.type === "CLAS" && implementsClassrun(editor.document.getText());
  let entitySet;
  if (object.type === "CLAS" && /_DPC_EXT$/i.test(object.name)) {
    const method = methodAtLine(editor.document.getText(), editor.selection.active.line);
    if (method !== undefined) {
      try {
        const map = await osd().entitySets(object.name);
        const found = map?.sets.find((s) => s.method === method);
        if (found !== undefined) entitySet = {service: map.service, set: found.set, entityKind: found.kind};
      } catch (e) {
        // osd down, or the class is not a registered service's DPC: F8
        // falls back to the "not yet" text rather than failing silently
        output.appendLine(`osd run ${object.name}: ${String(e.message ?? e)}`);
      }
    }
  }
  const action = runActionFor(object, {hasClassrun, entitySet, forceDebugger, file: editor.document.fileName});
  // Q4: a run is server work, so it is a point the table this object's own
  // heat comes from may have changed -- fire-and-forget, the same as the
  // timer, so F8 does not wait on it.
  void refreshHotspots(output);
  if (action.kind === "call-entityset") {
    await callEntitySet({service: action.service, set: action.set, kind: action.entityKind,
      file: editor.document.fileName, withDebugger: forceDebugger}, output);
    return;
  }
  if (action.kind === "classrun") {
    await classrunObject(object.name, classrunOutput, forceDebugger, editor.document.fileName);
    return;
  }
  if (action.kind === "webgui") {
    await openWebguiTransaction(action.tcode, output);
    return;
  }
  if (action.kind === "cli") {
    if (await runReportInTerminal(object.name, editor, output) === false) {
      const fallback = runActionFor(object, {forceDebugger: true});
      if (fallback.kind === "webgui") await openWebguiTransaction(fallback.tcode, output);
    }
    return;
  }
  output.appendLine(`osd run ${object.name}: ${action.text}`);
  vscode.window.showInformationMessage(action.kind === "nothing-to-run" ? action.text : `osd: ${action.text}`);
}

// ---- 0.5 O: F8 on a report -- `osd run` (tools/osd-run.mjs) builds it
// with osabap into a native command, kept by the hash of its sources, and
// runs it in a terminal of its own. The arguments are asked for first, the
// last ones offered again; left empty, the command presents its own
// selection screen in the terminal. The build reads the file, so the
// buffer is saved first; it needs a checkout (Go, tools/gogen), not the
// bundled copy.
const reportArgs = new Map();
async function runReportInTerminal(name, editor, output) {
  const home = osdHomeOf();
  if (home === undefined || !isOpenSteamgatePath(home)) {
    // no checkout to build in: the converted report in Easy Access, as F8
    // did before osd run
    output.appendLine(`osd run ${name}: no open-steamgate checkout (osd.home or the workspace folder) to build the report in; opening it in Easy Access`);
    return false;
  }
  const file = editor.document.fileName;
  const typed = await vscode.window.showInputBox({
    title: `Run ${name}`,
    prompt: "Report options as --name value, host flags as -db FILE (paths from the checkout); empty opens the selection screen",
    value: reportArgs.get(file) ?? "",
  });
  if (typed === undefined) return;
  reportArgs.set(file, typed);
  if (editor.document.isDirty) await editor.document.save();
  // the line is quoted for PowerShell on Windows, so the terminal is one
  const terminal = vscode.window.createTerminal({name: `osd run ${name}`, cwd: home,
    ...(process.platform === "win32" ? {shellPath: "powershell.exe"} : {})});
  terminal.show();
  terminal.sendText(`${osdRunCommandLine({home, file})}${typed.trim() === "" ? "" : ` -- ${typed.trim()}`}`);
  return true;
}

// ---- gui-reports spike (docs/gui-reports.md): F8 on a converted report
// opens SAP Easy Access, at that report's transaction, in a webview panel
// beside the editor rather than in the system browser "Open launchpad"
// uses -- the ask was a panel inside VS Code, and a webview is the one VS
// Code has.
//
// The panel does not carry a copy of the page: it iframes the running
// osd's own URL, so the sapevent round trip (docs/webgui.md) runs exactly
// as it does in a browser tab, clicks and all. The one real constraint is
// what a webview's default Content-Security-Policy blocks by default (no
// origin at all, same as any other webview until the page's own CSP names
// one) and what "localhost" even means from inside the panel: under
// Remote-WSL and Remote-SSH the webview itself renders in the local UI
// process, on the other side of the remote/local boundary from the osd
// server it is asking for, so a bare `http://localhost:<port>` is a
// coincidence when it works (Remote-WSL's own automatic port forwarding)
// and a dead port otherwise (Remote-SSH forwards nothing unless asked).
// `vscode.env.asExternalUri` is VS Code's own answer to exactly that: it
// hands back the URL this window's UI can actually reach, forwarding the
// port first if that remote needs it, and is a no-op when nothing is
// remote at all -- so this asks it rather than assuming osd's configured
// URL already is the right one.
async function openWebguiTransaction(tcode, output, file, object) {
  if (kernelDiagnostics && !(await kernelDiagnostics.allow(file, object?.name ? object : undefined))) return;
  const baseUri = vscode.Uri.parse(osd().url);
  await runWebguiPanel(tcode, baseUri, webguiPanels, {
    createPanel: (name) => vscode.window.createWebviewPanel("osdWebgui", `Easy Access: ${name}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      retainContextWhenHidden: true,
    }),
    // Resolve only the listener; the resource path and transaction command
    // are added to the transport address after VS Code has forwarded it.
    resolveBase: (uri) => vscode.env.asExternalUri(uri),
    panelHtml: webguiPanelHtml,
    onResolveError: (e) => output.appendLine(`osd webgui ${tcode}: asExternalUri failed, using ${baseUri.toString()} as typed (${String(e.message ?? e)})`),
  });
}

// ---- Q6b "Classrun": F9, ADT's "Run as ABAP Application (Console)" --
// tools/adt-facade.mjs `oo/classrun`, one class at a time, its own output
// channel so a run is not lost among the status bar's and F8's lines. A
// dump still shows: the route answers 200 with what the class wrote and
// then a trace, so the channel shows both rather than an error dialog with
// nothing behind it.

async function classrunCurrent(classrunOutput, withDebugger = false) {
  const current = currentObject();
  if (current === undefined) return;
  const {object} = current;
  if (object.type !== "CLAS") {
    vscode.window.showInformationMessage(`osd: ${object.name} is not a class`);
    return;
  }
  await classrunObject(object.name, classrunOutput, withDebugger, current.editor.document.fileName);
}

// ---- the taxi demo's sample data (ZOSD_TAXI_SRV, src/demo_data/): nothing
// is generated when the system starts; a year is made on request, from the
// taxi app's own buttons, from here, or from the OSD tree's service node.

async function taxiYears() {
  const answer = await osd().odata("ZOSD_TAXI_SRV", "YearSet?$format=json");
  if (answer.status !== 200) throw new Error(`ZOSD_TAXI_SRV/YearSet: HTTP ${answer.status}`);
  return answer.body?.d?.results ?? [];
}

async function generateTaxiData() {
  try {
    const years = await taxiYears();
    const text = await vscode.window.showInputBox({
      title: "osd: Generate taxi data",
      prompt: "A year of synthetic NYC taxi trips, about 20 000 rows, made up and not TLC figures. " +
        (years.length ? `Loaded: ${years.map((y) => y.Year).join(", ")}.` : "No sample data yet."),
      value: String(taxiDefaultYear(years)),
      validateInput: (value) => /^(19|20)\d\d$/.test(value.trim()) ? undefined : "A year from 1900 to 2099",
    });
    if (text === undefined) return;
    const report = await osd().odataAction("ZOSD_TAXI_SRV", "GenerateYear", {Year: text.trim()});
    vscode.window.showInformationMessage(`osd: ${String(report).replace(/^taxi: /, "")}`);
  } catch (e) {
    vscode.window.showErrorMessage(`osd: taxi data: ${String(e.message ?? e)}`);
  }
}

async function resetTaxiData() {
  try {
    const question = taxiResetPrompt(await taxiYears());
    if (question === undefined) {
      vscode.window.showInformationMessage("osd: No synthetic year is loaded; there is nothing to remove.");
      return;
    }
    const picked = await vscode.window.showWarningMessage(question, {modal: true}, "Remove");
    if (picked !== "Remove") return;
    const report = await osd().odataAction("ZOSD_TAXI_SRV", "ResetData");
    vscode.window.showInformationMessage(`osd: ${String(report).replace(/^taxi: /, "")}`);
  } catch (e) {
    vscode.window.showErrorMessage(`osd: taxi data: ${String(e.message ?? e)}`);
  }
}

async function classrunObject(name, classrunOutput, withDebugger = false, file,
  {attach = requireDebugSystem, controller = activeController, client = osd} = {}) {
  withDebugger ||= abapBreakpoints().length > 0;
  if (kernelDiagnostics && !(await kernelDiagnostics.allow(file, {type: "CLAS", name}))) return;
  if (withDebugger && !(await attach(classrunOutput, "Classrun"))) return;
  // A wait that gives up says so and runs anyway, as 0.4 did: an unattended
  // run must never end with nothing sent and nothing said (osg-demo, 0.5.1467).
  const ready = withDebugger ? await controller.waitForDebuggerReady(file) : true;
  if (ready === WAIT_CANCELLED) {
    controller.debugNote?.(`classrun ${name}: the wait was cancelled; nothing sent`);
    return;
  }
  if (ready !== true) {
    controller.debugNote?.(`classrun ${name}: running without a verified breakpoint`);
    void vscode.window.showWarningMessage(`osd: the breakpoints for ${name} were not verified within 15 s; running anyway`);
  }
  if (withDebugger) controller.debugNote?.(`classrun ${name}: sending the run`);
  classrunOutput.show(true);
  const document = vscode.window.activeTextEditor?.document;
  if (file && document && path.resolve(document.fileName) === path.resolve(file)) {
    let changed = document.isDirty;
    const available = controller?.launcher ? controller.launcher.state === "running" : servingAvailable === true;
    if (!changed && available && typeof document.getText === "function") {
      try {
        const object = adtObjectOf(file);
        const source = await client().activeSource(object);
        const normalize = text => text.replace(/\r\n/g, "\n").replace(/\n+$/, "");
        changed = normalize(source) !== normalize(document.getText());
      } catch { /* An unavailable active source leaves the dirty-only hint. */ }
    }
    if (changed) classrunOutput.appendLine("osd: running the active version; your editor changes are not activated yet (Ctrl+F3)");
  }
  classrunOutput.appendLine(`--- classrun ${name} ---`);
  try {
    const {text, ms, generation} = await client().classrun(name);
    classrunOutput.appendLine(text);
    classrunOutput.appendLine(`(${ms} ms${generation ? `, ${generation}` : ""})`);
  } catch (e) {
    classrunOutput.appendLine(`osd classrun ${name}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd classrun: ${String(e.message ?? e)}`);
  }
}

// ---- Q7 "F8 on a table or a CDS view" (docs/vscode-extension.md): a
// webview of the rows, over the façade's own datapreview/ddic (TABL) /
// datapreview/cds (DDLS) route (lib.js Osd#dataPreview) -- the same door
// ADT's own Data Preview uses, so the name resolution (a DDLS's own CDS
// name, not its @AbapCatalog.sqlViewName) and the DDIC field labels are
// the façade's, not guessed here. A row's own count, when the fetch came
// back at the row cap, is one more query through the plain freestyle
// route -- the one door this whole feature is told to prefer, and the one
// that already exists for exactly "run this SQL and hand back a number".

async function openDataPreview(objectType, name, hasMandt, output, options = {}) {
  return openDataPreviewView(objectType, name, hasMandt, {
    vscode, output,
    client: options.client ?? (() => osd()),
    // Read on every (re)load, as before the extraction: Start creates the
    // launcher, and activeController can change, after the panel opened.
    systemState: () => {
      const controller = options.controller ?? activeController;
      return {
        launcher: Object.hasOwn(options, "launcher") ? options.launcher : controller?.launcher,
        managedUrl: Object.hasOwn(options, "managedUrl") ? options.managedUrl : controller?.managedUrl,
      };
    },
    openNotebook: newSqlNotebook,
    lib: require("./lib.js"),
  });
}

// ---- Q2b "Runner": a CodeLens "▶ Call <Set>" above each
// `<set>_get_entityset` / `<set>_get_entity` method of a SEGW _DPC_EXT
// class, and the GET it and F8 (above) both run -- the URL, the status,
// the time and the row count in a webview table, a "raw JSON" toggle
// beside it. lib.js entitySetLenses does the placement (a plain text scan,
// tested without VS Code); this asks the server for the class's own map
// (tools/adt-facade.mjs `core/http/segw/entitysets`) and turns what it
// finds into `vscode.CodeLens`es.

function httpLensProvider(output, controller = activeController) {
  const emitter = new vscode.EventEmitter();
  const registration = vscode.languages.registerCodeLensProvider({pattern: "**/*.http"}, {
    onDidChangeCodeLenses: emitter.event,
    async provideCodeLenses(document) {
      const requests = requestBlocks(document.getText());
      if (!requests.length) return [];
      let rows;
      try { rows = await osd().services(); } catch {
        return requests.map(({line}) => new vscode.CodeLens(new vscode.Range(line - 1, 0, line - 1, 0),
          {title: "start the system to resolve", command: "osd.httpLensInfo"}));
      }
      const maps = new Map();
      const sources = new Map();
      const root = serviceSourceRoot();
      const lenses = [];
      for (const request of requests) {
        const service = servicePathOf(request.url ?? "")?.service;
        const row = rows.find((one) => one.kind === "ODATA" &&
          String(one.name ?? /\/sap\/opu\/odata\/sap\/([^/]+)/i.exec(one.path ?? "")?.[1] ?? "").toUpperCase() === service?.toUpperCase());
        let map;
        const sourceByClass = {};
        if (request.method === "GET" && row?.handler) {
          if (!maps.has(row.handler)) {
            try { maps.set(row.handler, await osd().entitySets(row.handler)); }
            catch (e) { output.appendLine(`osd http lens ${row.handler}: ${String(e.message ?? e)}`); maps.set(row.handler, undefined); }
          }
          map = maps.get(row.handler);
          if (map) {
            const ext = row.handler.toUpperCase();
            const base = ext.replace(/_EXT$/, "");
            for (const name of new Set([ext, base])) {
              if (!sources.has(name)) {
                const beside = name === base && row.handlerSource
                  ? sourcePath(root, path.join(path.dirname(row.handlerSource), `${base.toLowerCase()}.clas.abap`)) : undefined;
                const file = beside ?? await classSourcePath(name === ext ? row : {handler: name}, "dpc", root);
                let source;
                try { if (file) source = fs.readFileSync(file, "utf8"); } catch {}
                sources.set(name, source === undefined ? undefined : {path: file, source});
              }
              sourceByClass[name] = sources.get(name);
            }
          }
        }
        const lens = resolveRequest(request, rows, map, sourceByClass);
        const command = lens.path ? {title: lens.title, command: "osd.openEntitySetMethod",
          arguments: [lens.owner, lens.set, lens.methodLine, lens.path]} : {title: lens.title, command: "osd.httpLensInfo"};
        lenses.push(new vscode.CodeLens(new vscode.Range(lens.line - 1, 0, lens.line - 1, 0), command));
      }
      return lenses;
    },
  });
  const onState = controller?.onDidChange(() => emitter.fire());
  const onServing = () => emitter.fire();
  servingAvailabilityListeners.add(onServing);
  const onConfig = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration("osd.url")) emitter.fire();
  });
  return {dispose: () => { registration.dispose(); onState?.dispose(); onConfig.dispose(); servingAvailabilityListeners.delete(onServing); emitter.dispose(); }};
}

function entitySetLensProvider(output) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeCodeLenses: emitter.event,
    async provideCodeLenses(document) {
      const object = adtObjectOf(document.fileName);
      if (object === undefined || object.type !== "CLAS" || !/_DPC_EXT$/i.test(object.name)) return [];
      let map;
      try {
        map = await osd().entitySets(object.name);
      } catch (e) {
        output.appendLine(`osd entitysets ${object.name}: ${String(e.message ?? e)}`);
        return [];
      }
      return entitySetLenses(document.getText(), map).flatMap((lens) => {
        const range = new vscode.Range(lens.line - 1, 0, lens.line - 1, 0);
        const args = {service: lens.service, set: lens.set, kind: lens.kind, file: document.fileName};
        return [new vscode.CodeLens(range, {
          title: lens.title,
          command: "osd.callEntitySet",
          arguments: [args],
        }), new vscode.CodeLens(range, {
          title: `$(debug) Attach debugger and call ${lens.set}`,
          command: "osd.callEntitySetWithDebugger",
          arguments: [args],
        })];
      });
    },
  };
  const registration = vscode.languages.registerCodeLensProvider({pattern: "**/*.abap"}, provider);
  // a save can add, redefine or rename an entity-set method: the class's
  // map the next provideCodeLenses asks for may have changed under it
  const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
    if (/_dpc_ext\.clas\.abap$/i.test(doc.fileName)) emitter.fire();
  });
  return {dispose: () => { registration.dispose(); onSave.dispose(); }};
}

// ---- gui-reports spike: a CodeLens "▶ Run in Easy Access (ZGUI_...)"
// above a *.prog.abap's own REPORT line -- "Open in VS Code" for a
// converted report, symmetric to F8 (RUN_TABLE.PROG in lib.js) rather than
// a second way of deciding what to do. lib.js progRunLens does the
// placement, tested without VS Code the same way entitySetLenses is; this
// never asks the server whether the report was actually converted, for the
// reason openWebguiTransaction's own comment gives.

function progLensProvider() {
  const provider = {
    provideCodeLenses(document) {
      const object = adtObjectOf(document.fileName);
      if (object === undefined || object.type !== "PROG") return [];
      const lens = progRunLens(document.getText(), object.name);
      if (lens === undefined) return [];
      const range = new vscode.Range(lens.line - 1, 0, lens.line - 1, 0);
      return [new vscode.CodeLens(range, {
        title: lens.title,
        command: "osd.openWebguiTransaction",
        arguments: [{tcode: lens.tcode, file: document.fileName}],
      })];
    },
  };
  const registration = vscode.languages.registerCodeLensProvider({pattern: "**/*.prog.abap"}, provider);
  return {dispose: () => registration.dispose()};
}

/** `{service, set, kind}` (a lens's own command arguments, or F8's) into
 *  the GET and the webview: `get_entityset` calls the set with `$top=20`;
 *  `get_entity` first asks the set for one row to default the key prompt
 *  to (lib.js `keyOf`, off `__metadata.uri` -- this client does not
 *  otherwise know the entity type's key properties), then calls the one
 *  entity. Cancelling the prompt leaves nothing called. */
function registerEntitySetCommands(context, output, classrunOutput, controller) {
  context.subscriptions.push(vscode.commands.registerCommand("osd.callEntitySet", (args) => callEntitySet(args, output, controller)));
  context.subscriptions.push(vscode.commands.registerCommand("osd.callEntitySetWithDebugger", (args) =>
    args === undefined ? run(output, classrunOutput, true) : callEntitySet({...args, withDebugger: true}, output, controller)));
}

async function callEntitySet({service, set, kind, file, withDebugger = false}, output, controller = activeController) {
  const source = file ?? vscode.window.activeTextEditor?.document?.fileName;
  if (kernelDiagnostics && !(await kernelDiagnostics.allow(source))) return;
  // Never a prompt that waits for an answer: an unattended run (a test, a
  // screenshot suite) has nobody to click it. The breakpoint is matched by
  // path, real path or the running copy of the ABAP object (lib.js
  // breakpointMatches; a shadowed copy never binds and does not count), and a miss is
  // said and the call goes on.
  if (withDebugger && !(source && breakpointMatches(abapBreakpoints().map((bp) => bp.location.uri.fsPath), source,
    controller?.runningSources?.()).some((match) => match.counts))) {
    controller?.debugNote?.(`call ${set}: no enabled breakpoint matches ${source ?? "the DPC file"}; calling without stopping`);
    void vscode.window.showWarningMessage(`osd: no enabled breakpoint in ${source ?? "the DPC file"}; ${set} runs without stopping`);
  }
  if (withDebugger && !(await requireDebugSystem(output, "Call EntitySet", controller))) return;
  if (withDebugger) {
    const ready = await controller.waitForDebuggerReady(source, 15000, {reportMissingBreakpoint: true, output});
    if (ready === WAIT_CANCELLED) {
      controller.debugNote?.(`call ${set}: the wait was cancelled; nothing sent`);
      return;
    }
    if (ready !== true) {
      controller.debugNote?.(`call ${set}: calling without a verified breakpoint`);
      void vscode.window.showWarningMessage(`osd: the breakpoints for ${set} were not verified within 15 s; calling anyway`);
    }
    controller.debugNote?.(`call ${set}: sending the request`);
  }
  try {
    if (kind === "get_entity") {
      const probe = await osd().odata(service, `${set}?$top=1&$format=json`);
      const defaultKey = keyOf(resultRows(probe.body)[0]);
      const key = await vscode.window.showInputBox({
        prompt: `Key for ${set}`,
        value: defaultKey ?? "",
        placeHolder: "e.g. 'T0001', or TravelID='T0001',BookingID='0001'",
      });
      if (key === undefined) return;
      const call = await osd().odata(service, `${set}(${key})?$format=json`);
      showEntitySetResult(`${set}(${key})`, call);
    } else {
      const call = await osd().odata(service, `${set}?$top=20&$format=json`);
      showEntitySetResult(set, call);
    }
  } catch (e) {
    output.appendLine(`osd call ${set}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

function showEntitySetResult(title, call) {
  const panel = vscode.window.createWebviewPanel("osdEntitySet", title, vscode.ViewColumn.Beside, {enableScripts: true});
  const rows = resultRows(call.body).map(stripMetadata);
  panel.webview.html = entitySetHtml(title, call, rows);
}

function xmlEscapeHtml(text) {
  return String(text ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellText(value) {
  if (value === null || value === undefined) return "";
  return typeof value === "object" ? JSON.stringify(value) : String(value);
}

function entitySetHtml(title, call, rows) {
  const columns = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const thead = columns.map((c) => `<th>${xmlEscapeHtml(c)}</th>`).join("");
  const tbody = rows.map((row) => `<tr>${columns.map((c) => `<td>${xmlEscapeHtml(cellText(row[c]))}</td>`).join("")}</tr>`).join("");
  const rawJson = xmlEscapeHtml(JSON.stringify(call.body !== undefined ? call.body : call.text, undefined, 2));
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  body { font-family: var(--vscode-font-family, sans-serif); font-size: 13px; padding: 8px; color: var(--vscode-foreground); }
  .meta { margin-bottom: 8px; opacity: 0.85; }
  .meta div { margin: 2px 0; }
  table { border-collapse: collapse; width: 100%; }
  th, td { border: 1px solid var(--vscode-panel-border, #555); padding: 4px 8px; text-align: left; white-space: nowrap; }
  th { background: var(--vscode-editor-lineHighlightBackground, #2a2a2a); }
  pre { white-space: pre-wrap; word-break: break-word; display: none; }
  label { user-select: none; cursor: pointer; }
</style>
</head>
<body>
  <div class="meta">
    <div>${xmlEscapeHtml(call.url)}</div>
    <div>HTTP ${call.status} -- ${call.ms} ms -- ${rows.length} row(s)</div>
    <label><input type="checkbox" id="raw-toggle"> raw JSON</label>
  </div>
  <table id="rows-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table>
  <pre id="raw-json">${rawJson}</pre>
  <script>
    const toggle = document.getElementById("raw-toggle");
    const table = document.getElementById("rows-table");
    const raw = document.getElementById("raw-json");
    toggle.addEventListener("change", () => {
      table.style.display = toggle.checked ? "none" : "";
      raw.style.display = toggle.checked ? "block" : "none";
    });
  </script>
</body>
</html>`;
}

// ---- Q3 "Readers": a CodeLens "read by N · tests M · services K" over a
// class's own `CLASS <name> DEFINITION` line or an interface's own
// `INTERFACE <name>` line (tools/adt-facade.mjs `core/http/xref/readers`,
// the reverse of Q2b's own class-to-service map). lib.js readersLensLine
// does the placement (a plain text scan, tested without VS Code); this asks
// the server for the object's own readers and turns what it finds into one
// `vscode.CodeLens`. A click opens a quick pick of the readers (Test /
// Service tagged) and opens the file of the one chosen.

function readersLensProvider(output, controller = activeController) {
  const emitter = new vscode.EventEmitter();
  const provider = {
    onDidChangeCodeLenses: emitter.event,
    async provideCodeLenses(document) {
      const object = adtObjectOf(document.fileName);
      if (object === undefined || (object.type !== "CLAS" && object.type !== "INTF") || object.include !== "main") return [];
      const line = readersLensLine(document.getText(), object);
      if (line === undefined) return [];
      let found;
      try {
        found = await osd().readers(object.type, object.name);
      } catch (e) {
        output.appendLine(`osd readers ${object.name}: ${String(e.message ?? e)}`);
        return [];
      }
      if (found === undefined) return [];
      const range = new vscode.Range(line - 1, 0, line - 1, 0);
      return [new vscode.CodeLens(range, {
        title: readersLensTitle(found.counts),
        command: "osd.showReaders",
        arguments: [found],
      })];
    },
  };
  const registration = vscode.languages.registerCodeLensProvider({pattern: "**/*.abap"}, provider);
  // a save can add, rename or remove a reference this class's readers count
  // depends on, in this file or in whichever other file did the referencing
  const onSave = vscode.workspace.onDidSaveTextDocument(() => emitter.fire());
  const onState = controller?.onDidChange(() => emitter.fire());
  return {dispose: () => { registration.dispose(); onSave.dispose(); onState?.dispose(); }};
}

async function showReaders(found, output) {
  if (found === undefined) return;
  if (found.readers.length === 0) {
    vscode.window.showInformationMessage(`osd: nothing reads ${found.name}`);
    return;
  }
  const picked = await vscode.window.showQuickPick(readersQuickPickItems(found.readers), {placeHolder: `Readers of ${found.name}`});
  if (picked === undefined) return;
  const pattern = readerFilePattern(picked.reader);
  if (pattern === undefined) {
    vscode.window.showInformationMessage(`osd: ${picked.reader.name} (${picked.reader.type}) has no source file this extension knows how to open`);
    return;
  }
  try {
    const files = await vscode.workspace.findFiles(pattern, EXCLUDE, 1);
    if (files.length === 0) {
      vscode.window.showWarningMessage(`osd: ${picked.reader.name}'s file was not found in this workspace`);
      return;
    }
    await vscode.window.showTextDocument(files[0]);
  } catch (e) {
    output.appendLine(`osd show readers ${found.name}: ${String(e.message ?? e)}`);
    vscode.window.showErrorMessage(`osd: ${String(e.message ?? e)}`);
  }
}

// ---- Test Explorer: Project / Packs / Workspace layers / System groups,
// each object's test classes and methods below it (docs/vscode-extension.md,
// "Test Explorer groups"). lib.js's transpileLayers()/classifyTestPath() do
// the pure half (which of the four a file falls under, and which package
// inside it); everything here is the tree built around that, and, below the
// object level, unchanged from before this: same object/class/method ids
// (so a run's history still matches them), same discover()/run() shape.

function testExplorer(context, output, {
  attachUnitDebugger = (event) => activeController?.applyDebuggerEvent(event),
  pickUnitInspectorPort = pickInspectorPort,
  systemController = activeController,
} = {}) {
  const controller = vscode.tests.createTestController("osd-abap-unit", "ABAP Unit (osd)");
  const objects = new Map(); // object item id -> {object, dir} -- unchanged meaning, any tree depth
  const groupNodes = new Map(); // group/subgroup/package id -> its TestItem

  const GROUP_LABEL = {project: "Project", packs: "Packs", workspace: "Workspace layers", system: "System"};
  const GROUP_ORDER = ["project", "packs", "workspace", "system"];

  function readTranspileConfig(root) {
    if (root === undefined) return {};
    try {
      return JSON.parse(fs.readFileSync(path.join(root, "abap_transpile.json"), "utf8"));
    } catch {
      return {};
    }
  }

  function ensureGroupNode(id, label, parent) {
    let node = groupNodes.get(id);
    if (node === undefined) {
      node = controller.createTestItem(id, label);
      groupNodes.set(id, node);
      if (parent === undefined) controller.items.add(node);
      else parent.children.add(node);
    }
    return node;
  }

  function objectItemFor(entry) {
    const id = `${entry.object.type}:${entry.object.name}`;
    if (objects.has(id)) return undefined; // the same object found twice (two scans overlapping) -- keep the first
    const mainFile = entry.object.type === "CLAS" ? fileOf(entry.dir, entry.object, "main") : undefined;
    const uri = mainFile !== undefined && fs.existsSync(mainFile) ? vscode.Uri.file(mainFile) : entry.uri;
    const item = controller.createTestItem(id, entry.object.name, uri);
    item.canResolveChildren = true;
    objects.set(id, {object: entry.object, dir: entry.dir});
    return item;
  }

  // one bucket per bucketKey holds the object items directly: Project's own
  // top node (Project has no sub-node of its own), else the one mandatory
  // sub-node a pack / lib / workspace layer always gets. Split further by
  // packageOf() once the bucket clears PACKAGE_SPLIT_THRESHOLD -- the
  // "~15" the task named, read off lib.js so a test and this agree on it.
  function placeEntries(containerNode, entries) {
    if (!needsPackageSplit(entries.length)) {
      for (const entry of entries) {
        const item = objectItemFor(entry);
        if (item !== undefined) containerNode.children.add(item);
      }
      return;
    }
    const byPackage = new Map();
    for (const entry of entries) {
      const pkg = packageOf(entry.classification.relInGroup);
      if (!byPackage.has(pkg)) byPackage.set(pkg, []);
      byPackage.get(pkg).push(entry);
    }
    for (const [pkg, pkgEntries] of byPackage) {
      const target = pkg === undefined ? containerNode : ensureGroupNode(`${containerNode.id}:pkg:${pkg}`, pkg, containerNode);
      for (const entry of pkgEntries) {
        const item = objectItemFor(entry);
        if (item !== undefined) target.children.add(item);
      }
    }
  }

  // Item 5 (docs/vscode-extension.md): a class's own testclasses include,
  // or a PROG's local test classes -- abapGit keeps those inline in the
  // program's own `*.prog.abap` (or an include it reaches the same way),
  // never split out the way a class's `.testclasses.abap` is. Both routes
  // land on the same generic server side (tools/adt-facade.mjs
  // `core/http/unit/object[/run]`, `type=CLAS` or `type=PROG`; FUGR is not
  // accepted there -- refused with 400, so a function group's own `FOR
  // TESTING` is never listed, a gap named in the doc rather than guessed
  // at silently).
  const TEST_FILE_GLOB = "**/{*.clas.testclasses.abap,*.prog.abap}";

  // findFiles() the way the four groups actually differ: Project and Packs
  // sit under the repo root and stay behind EXCLUDE (never .local, gen,
  // node_modules, output, build -- the same exclude every other feature
  // here uses); a lib's own folder and a running workspace layer's own
  // folder are asked for directly, RelativePattern-scoped, bypassing
  // EXCLUDE on purpose -- that is the one thing that lets System (`.local/
  // lars/*`, today) be found at all, without also walking the dozens of
  // other clones and worktrees `.local/**` carries that are neither.
  async function scanAll(root, layers, workspaceLayers, showSystem) {
    const uris = [...await vscode.workspace.findFiles(TEST_FILE_GLOB, EXCLUDE)];
    if (showSystem) {
      for (const lib of layers.libs) {
        const base = path.join(root, lib.folder);
        if (!fs.existsSync(base)) continue;
        const pattern = new vscode.RelativePattern(vscode.Uri.file(base), TEST_FILE_GLOB);
        uris.push(...await vscode.workspace.findFiles(pattern));
      }
    }
    for (const wl of workspaceLayers) {
      const folder = typeof wl.folder === "string" ? wl.folder : wl.srcDir;
      if (typeof folder !== "string" || !fs.existsSync(folder)) continue;
      const pattern = new vscode.RelativePattern(vscode.Uri.file(folder), TEST_FILE_GLOB);
      uris.push(...await vscode.workspace.findFiles(pattern));
    }
    return uris;
  }

  // Bugs 1/2/6 (docs/vscode-extension.md): `vscode.workspace.findFiles`
  // above walks every open workspace folder, which is not necessarily
  // osdHome -- a packaged install's osdHome is a materialized copy of the
  // bundled seed in globalStorage, while the window's own workspace folder
  // (the checkout a person actually opened and edits) is a different tree
  // entirely. Classifying a file found there against osdHome's own
  // abap_transpile.json made `path.relative` climb out of one tree and back
  // down into the other, so every project/packs file landed in one "`..`"
  // sub-node holding everything (and Packs, whose own prefix check can
  // never match a path that starts "`..`", held nothing at all). Each
  // file's OWN workspace folder is read once and cached, and that folder's
  // OWN config -- never osdHome's -- is what its packages and its System/
  // Packs membership are read against. A lib's own folder and a running
  // workspace layer's own folder are found by an explicit RelativePattern
  // rooted at `root` (osdHome) or the layer's own absolute folder
  // respectively (see scanAll above), so they are always already under the
  // root they are classified against and need no lookup here; a file with
  // no owning workspace folder at all (that is exactly this case) falls
  // back to `root`.
  const configCache = new Map(); // workspace-folder root -> {layers, demoObjects}
  const layersFor = (folderRoot) => {
    if (!configCache.has(folderRoot)) {
      const config = readTranspileConfig(folderRoot);
      configCache.set(folderRoot, {layers: transpileLayers(config), demoObjects: demoFailureObjects(config)});
    }
    return configCache.get(folderRoot);
  };

  // what each test class is scheduled as (the façade's check of its RISK
  // LEVEL, tools/osd-unit-risk.mjs), by class item id; and a warning on the
  // RISK LEVEL of a class that declares HARMLESS and reaches a write
  const classSchedules = new Map();
  const riskDiagnostics = vscode.languages?.createDiagnosticCollection?.("osd ABAP Unit risk");
  const scanTree = async () => {
    // a rebuilt tree starts with no verdicts: an object is described again
    // when it is expanded or run, and a deleted file keeps no warning
    classSchedules.clear();
    riskDiagnostics?.clear();
    const root = systemController?.launcher?.osdHome ?? osdHomeOf();
    const layers = transpileLayers(readTranspileConfig(root));
    const workspaceLayers = systemController?.launcher?.layers ?? [];
    const showSystem = vscode.workspace.getConfiguration("osd").get("tests.showSystem", true);

    controller.items.replace([]);
    groupNodes.clear();
    objects.clear();
    configCache.clear();
    if (root === undefined) return;

    const placed = [];
    for (const uri of await scanAll(root, layers, workspaceLayers, showSystem)) {
      let source;
      try {
        source = fs.readFileSync(uri.fsPath, "utf8");
      } catch {
        continue;
      }
      // the cheap filter, done up front: a testclasses include (or a PROG
      // with no local test class at all) never becomes an item only to be
      // found empty once expanded (lib.js hasTestMethods -- discover()'s
      // own server round trip still filters per class/method the same way,
      // below)
      if (!hasTestMethods(source)) continue;
      const object = objectOf(uri.fsPath);
      if (object === undefined) continue;
      // the file's OWN workspace folder, not osdHome -- bugs 1/2/6 above
      const ownRoot = vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ?? root;
      const {layers: ownLayers, demoObjects} = layersFor(ownRoot);
      const classification = classifyTestPath(ownRoot, uri.fsPath, ownLayers, workspaceLayers);
      // outside every known root, or hidden by that root's own
      // exclude_filter (test/fixtures/, deploy/ is not a layer at all,
      // a lib's own excluded corner) -- not part of the system, not listed
      if (classification === undefined) continue;
      // Item 4: a class or program abap_transpile.json's own `options.skip`
      // already marks as deliberately failing gets its own sub-node under
      // Project, so "Run" there stays green while the demo itself still
      // runs and still fails when asked for on purpose.
      if (classification.group === "project" && demoObjects.has(object.name)) {
        classification.subgroup = "Demos (fail on purpose)";
      }
      placed.push({uri, object, dir: path.dirname(uri.fsPath), classification});
    }

    const groupsPresent = new Set(["project", "packs"]);
    if (showSystem) groupsPresent.add("system");
    if (workspaceLayers.length > 0) groupsPresent.add("workspace");
    for (const group of GROUP_ORDER) {
      if (groupsPresent.has(group)) ensureGroupNode(`group:${group}`, GROUP_LABEL[group], undefined);
    }

    const buckets = new Map(); // bucketKey -> {group, subgroup, entries}
    for (const entry of placed) {
      const {group, subgroup} = entry.classification;
      if (!groupsPresent.has(group)) continue; // e.g. a workspace-layer file with no active layer known right now
      const bucketKey = subgroup === undefined ? `group:${group}` : `group:${group}:${subgroup}`;
      if (!buckets.has(bucketKey)) buckets.set(bucketKey, {group, subgroup, entries: []});
      buckets.get(bucketKey).entries.push(entry);
    }
    for (const [bucketKey, bucket] of buckets) {
      const topNode = groupNodes.get(`group:${bucket.group}`);
      const containerNode = bucket.subgroup === undefined ? topNode : ensureGroupNode(bucketKey, bucket.subgroup, topNode);
      placeEntries(containerNode, bucket.entries);
    }
  };

  // A file scan yields to VS Code. Keep the old scan and any newer request
  // in order, so the last request always publishes the latest layer list.
  let building;
  let dirty = false;
  const buildTree = () => {
    dirty = true;
    if (building !== undefined) return building;
    building = (async () => {
      do {
        dirty = false;
        await scanTree();
      } while (dirty);
    })().finally(() => { building = undefined; });
    return building;
  };

  const runningObjects = new Map();
  const pendingDiscovery = new Map();
  const discover = async (item) => {
    if (runningObjects.has(item.id)) {
      pendingDiscovery.set(item.id, item);
      return;
    }
    const {object, dir} = objects.get(item.id);
    item.busy = true;
    try {
      const found = await osd().discover(object);
      const classes = [];
      const warnings = new Map();
      // a class without test methods (the global class of a test-only
      // object is listed too) has nothing to run
      for (const testClass of (found.classes ?? []).filter((c) => (c.methods ?? []).length > 0)) {
        const file = vscode.Uri.file(fileOf(dir, object, testClass.include));
        const classItem = controller.createTestItem(`${item.id}/${testClass.name}`, testClass.name, file);
        classItem.range = new vscode.Range(Math.max(0, testClass.line - 1), 0, Math.max(0, testClass.line - 1), 0);
        classSchedules.set(classItem.id, {schedule: testClass.schedule, duration: testClass.durationCategory});
        const warning = riskWarning(testClass, found);
        if (warning !== undefined && riskDiagnostics !== undefined) {
          const range = new vscode.Range(Math.max(0, testClass.line - 1), 0, Math.max(0, testClass.line - 1), 200);
          const diagnostic = new vscode.Diagnostic(range, warning, vscode.DiagnosticSeverity?.Warning ?? 1);
          diagnostic.source = "osd";
          if (!warnings.has(file.fsPath)) warnings.set(file.fsPath, {uri: file, list: []});
          warnings.get(file.fsPath).list.push(diagnostic);
        }
        for (const m of testClass.methods ?? []) {
          const methodItem = controller.createTestItem(`${classItem.id}/${m.name}`, m.name, file);
          methodItem.range = new vscode.Range(Math.max(0, m.line - 1), 0, Math.max(0, m.line - 1), 0);
          classItem.children.add(methodItem);
        }
        classes.push(classItem);
      }
      if (runningObjects.has(item.id)) {
        pendingDiscovery.set(item.id, item);
        return;
      }
      item.children.replace(classes);
      item.error = undefined;
      // this object's files: the warnings found now, and none left from before
      for (const testClass of found.classes ?? []) {
        const file = vscode.Uri.file(fileOf(dir, object, testClass.include));
        riskDiagnostics?.set(file, warnings.get(file.fsPath)?.list ?? []);
      }
    } catch (e) {
      item.error = String(e.message ?? e);
    } finally {
      item.busy = false;
    }
  };

  controller.resolveHandler = async (item) => {
    if (item === undefined) {
      await buildTree();
      return;
    }
    await discover(item);
  };

  // narrowly scoped, so an unrelated edit never disturbs another object's
  // own expansion: onDidChange only re-runs discover() for an object
  // already found and already expanded (the tree's own shape did not
  // change); a create or a delete can change which bucket exists or
  // whether a group is now empty, so those go through buildTree() again --
  // debounced, so a burst of saves (a checkout, a branch switch) rebuilds
  // once rather than once per file
  let rebuildTimer;
  const scheduleRebuild = () => {
    clearTimeout(rebuildTimer);
    rebuildTimer = setTimeout(() => { buildTree().catch((e) => output.appendLine(String(e.message ?? e))); }, 300);
  };
  const layerKey = () => JSON.stringify((systemController?.launcher?.layers ?? []).map(({folder, srcDir}) => [folder, srcDir]));
  let lastLayerKey = layerKey();
  let lastState = systemController?.launcher?.state;
  const onState = systemController?.onDidChange(() => {
    const state = systemController?.launcher?.state;
    const key = layerKey();
    const layersChanged = key !== lastLayerKey;
    lastLayerKey = key;
    const reachedRunning = state === "running" && lastState !== "running";
    lastState = state;
    // Layer discovery during Start happens in "building". The running
    // notification covers it, after the server can answer the test lenses.
    if (reachedRunning || (layersChanged && state === "running")) scheduleRebuild();
  });
  const watcher = vscode.workspace.createFileSystemWatcher(TEST_FILE_GLOB);
  watcher.onDidCreate(() => scheduleRebuild());
  watcher.onDidDelete(() => scheduleRebuild());
  watcher.onDidChange((uri) => {
    const object = objectOf(uri.fsPath);
    const item = object === undefined ? undefined : controllerFind(`${object.type}:${object.name}`);
    if (item !== undefined && item.children.size > 0) discover(item);
  });

  // objects.has(id) is not enough on its own to find a TestItem anywhere in
  // the tree (controller.items is top-level groups only, now) -- walk every
  // group down to the object items once, for the rare watcher onDidChange
  function controllerFind(id) {
    const walk = (collection) => {
      for (const [, child] of collection) {
        if (child.id === id) return child;
        const found = walk(child.children);
        if (found !== undefined) return found;
      }
      return undefined;
    };
    return walk(controller.items);
  }

  // the ancestor object item of `item` (itself, if `item` already is one),
  // or undefined when `item` sits above every object (a group, a pack/lib/
  // workspace-layer sub-node, or a package split inside one)
  function objectAncestorOf(item) {
    let node = item;
    while (node !== undefined && !objects.has(node.id)) node = node.parent;
    return node;
  }

  // every object item under `item`, itself included when it already is one
  // -- "running a group runs all of its children", the way the Testing API
  // does by default: a group/pack/lib/workspace-layer/package node handed
  // to the run handler (Run on the group, or "Run All") expands to every
  // object it holds, each run in full
  function objectDescendantsOf(item) {
    if (objects.has(item.id)) return [item];
    const out = [];
    for (const [, child] of item.children) out.push(...objectDescendantsOf(child));
    return out;
  }

  const runHandler = async (request, token, forceDebugger = false) => {
    const run = controller.createTestRun(request);
    let subscription;
    const runObjectIds = new Set();
    try {
      const useDebugger = forceDebugger || osdDebugEnabled() || abapBreakpoints().length > 0;
      // `osd.database.tests` (docs/vscode-extension.md, "Databases"): read
      // once per run, not once per object -- it does not change mid-run, and
      // a per-object read would mean one call to context.secrets per object.
      // `undefined` for "same" sends no dbEnv at all, exactly the route's own
      // default.
      const dbEnv = await testsDbEnv(context, activeController?.launcher?.osdHome ?? osdHomeOf());
      // what was asked, expanded down to (or across) actual objects, then
      // grouped by object: the server runs one object at a time
      const asked = request.include ?? [...gather(controller.items)];
      const selections = [];
      for (const item of asked) {
        if (objects.has(item.id)) {
          selections.push({item, objectItem: item, testClass: undefined, method: undefined});
          continue;
        }
        const ancestor = objectAncestorOf(item);
        if (ancestor !== undefined) {
          const suffix = item.id.slice(ancestor.id.length).replace(/^\//, "");
          const [testClass, method] = suffix === "" ? [undefined, undefined] : suffix.split("/");
          selections.push({item, objectItem: ancestor, testClass, method});
          continue;
        }
        for (const objItem of objectDescendantsOf(item)) {
          selections.push({item: objItem, objectItem: objItem, testClass: undefined, method: undefined});
        }
      }
      const byObject = new Map();
      for (const sel of selections) {
        if (!byObject.has(sel.objectItem.id)) byObject.set(sel.objectItem.id, []);
        byObject.get(sel.objectItem.id).push(sel);
      }
      // Cancel reaches the request in flight: an ordinary run used to pass no
      // signal, so a cancelled Test Explorer run waited for the child it had
      // already started (the façade kills the child when the request aborts)
      const cancellation = new AbortController();
      const cancelled = () => token.isCancellationRequested || cancellation.signal.aborted;
      subscription = token.onCancellationRequested?.(() => cancellation.abort());
      const runSelection = async (sel, object, dir) => {
        const methods = leaves(sel.item);
        if (!runObjectIds.has(sel.objectItem.id)) {
          runningObjects.set(sel.objectItem.id, (runningObjects.get(sel.objectItem.id) ?? 0) + 1);
          runObjectIds.add(sel.objectItem.id);
        }
        methods.forEach((m) => run.started(m));
        try {
          const source = fileOf(dir, object, "main");
          if (kernelDiagnostics && !(await kernelDiagnostics.allow(source))) {
            methods.forEach((m) => run.errored(m, new vscode.TestMessage("Kernel strict mode refused this object; see osd output for the finding and support link.")));
            return;
          }
          const inspectPort = useDebugger ? await pickUnitInspectorPort() : undefined;
          if (cancelled()) {
            methods.forEach((m) => run.skipped(m));
            return;
          }
          const execute = (signal) => osd().run(object, sel.testClass, sel.method, dbEnv, inspectPort,
            inspectPort !== undefined, signal);
          const answer = inspectPort === undefined ? await execute(cancellation.signal) : await runWithDebuggerAttach(
            () => attachUnitDebugger({type: "unit-started", port: inspectPort}), execute, token);
          const results = outcomes(answer, methods.map((m) => ({testClass: m.id.split("/")[1], method: m.id.split("/")[2]})));
          for (const m of methods) {
            const [, testClass, method] = m.id.split("/");
            const result = results.find((r) => r.testClass === testClass && r.method === method);
            if (result === undefined) {
              run.skipped(m);
            } else if (result.passed) {
              run.passed(m, result.ms);
            } else {
              run.failed(m, result.alerts.map((a) => message(a, dir, m)), result.ms);
            }
          }
          run.appendOutput(`${object.name}: ${answer.counts?.passed ?? 0} passed, ${answer.counts?.failed ?? 0} failed in ${answer.ms ?? 0} ms\r\n`);
        } catch (e) {
          const text = new vscode.TestMessage(String(e.message ?? e));
          methods.forEach((m) => run.errored(m, text));
          output.appendLine(String(e.message ?? e));
        }
      };
      // one unit per object: its selections in the order asked, its risk and
      // duration from the classes it runs (what discover() learned)
      const units = [];
      for (const [objectId, sels] of byObject) {
        if (cancelled()) break;
        const objectItemOf = sels[0].objectItem;
        if (objectItemOf.children.size === 0) await discover(objectItemOf);
        const {object, dir} = objects.get(objectId);
        const classIds = new Set();
        for (const sel of sels) {
          if (sel.testClass !== undefined) classIds.add(`${objectId}/${sel.testClass}`);
          else for (const [, child] of objectItemOf.children) classIds.add(child.id);
        }
        const schedules = [...classIds].map((id) => classSchedules.get(id));
        units.push({
          key: objectId,
          risk: unitRiskOf(schedules),
          duration: unitDurationOf(schedules),
          run: async () => {
            for (const sel of sels) {
              if (cancelled()) break;
              await runSelection(sel, object, dir);
            }
          },
        });
      }
      // a debug run stays one at a time: one debugger, one child. So does a
      // run on a shared database (osd.database.tests = HANA or PostgreSQL):
      // every child there uses the one schema, and even a HARMLESS one
      // writes while it boots (the cross-reference and the pack rows are
      // reseeded), so two at once would delete each other's rows
      const sharedDatabase = dbEnv?.STG_DB === "hana" || dbEnv?.STG_DB === "postgres";
      await runUnitQueue(units, {poolSize: useDebugger || sharedDatabase ? 1 : unitPoolSize(), cancelled});
    } finally {
      subscription?.dispose?.();
      run.end();
      for (const id of runObjectIds) {
        const count = runningObjects.get(id) - 1;
        if (count > 0) runningObjects.set(id, count);
        else runningObjects.delete(id);
      }
      // All selections in this run have finished; publish discoveries only
      // after VS Code has received terminal states for the original items.
      for (const [id] of pendingDiscovery) {
        if (runningObjects.has(id)) continue;
        pendingDiscovery.delete(id);
        const item = controllerFind(id);
        if (item === undefined || !objects.has(id)) continue;
        void discover(item).catch(e => output.appendLine(String(e.message ?? e)));
      }
    }
  };
  controller.createRunProfile("Run", vscode.TestRunProfileKind.Run, runHandler, true);
  controller.createRunProfile("Debug", vscode.TestRunProfileKind.Debug,
    (request, token) => runHandler(request, token, true), false);
  const debugCurrentTests = vscode.commands.registerCommand("osd.debugCurrentTests", async (object) => {
    await buildTree();
    const item = controllerFind(`${object.type}:${object.name}`);
    if (item === undefined) {
      vscode.window.showWarningMessage(`osd: no Test Explorer item for ${object.name}`);
      return;
    }
    if (item.children.size === 0) await discover(item);
    const cancellation = new vscode.CancellationTokenSource();
    try {
      await runHandler(new vscode.TestRunRequest([item]), cancellation.token, true);
    } finally {
      cancellation.dispose();
    }
  });
  controller.refreshHandler = async () => {
    await buildTree();
  };
  return {dispose: () => { clearTimeout(rebuildTimer); onState?.dispose(); watcher.dispose(); debugCurrentTests.dispose(); riskDiagnostics?.dispose(); controller.dispose(); }};
}

function* gather(collection) {
  for (const [, item] of collection) yield item;
}

// the methods under an item, or the item itself when it is one
function leaves(item) {
  if (item.id.split("/").length === 3) return [item];
  const out = [];
  for (const [, child] of item.children) out.push(...leaves(child));
  return out;
}

function message(alert, dir, item) {
  const text = new vscode.TestMessage([alert.title, ...alert.details].join("\n"));
  const expected = alert.details.find((d) => d.startsWith("Expected ["));
  const actual = alert.details.find((d) => d.startsWith("Actual ["));
  if (expected !== undefined && actual !== undefined) {
    text.expectedOutput = expected.slice("Expected [".length, -1);
    text.actualOutput = actual.slice("Actual [".length, -1);
  }
  text.location = alert.frame !== undefined
    ? new vscode.Location(vscode.Uri.file(path.join(dir, alert.frame.file)), new vscode.Position(alert.frame.line - 1, Math.max(0, alert.frame.column - 1)))
    : new vscode.Location(item.uri, item.range ?? new vscode.Position(0, 0));
  return text;
}

// ---- Q6a notebooks: a *.osdnb file holds SQL, ABAP, SQLScript, and markdown
// cells (lib.js notebookFromJson / notebookToJson handles the JSON format).
// SQL uses ADT freestyle preview, ABAP uses the notebook classrun route, and
// SQLScript uses the AMDP sandbox. All run in the same serving osd.

function sqlNotebookSerializer() {
  return sqlNotebookSerializerView(vscode, (text) => Buffer.from(text, "utf8"));
}

/** Bundled notebooks work against the demo seed. The book's hello class
 *  is offered only when its source is in this workspace and is a classrun. */
async function sampleItems(context) {
  const dir = path.join(context.extensionUri.fsPath, "examples");
  const items = fs.readdirSync(dir).filter((name) => name.endsWith(".osdnb")).sort().map((name) => ({
    label: name, description: "Bundled notebook", detail: "Open and run a cell",
    uri: vscode.Uri.file(path.join(dir, name)), notebook: true,
  }));
  const classes = await vscode.workspace.findFiles("**/zosd_demo_hello.clas.abap", EXCLUDE);
  for (const uri of classes) {
    const document = await vscode.workspace.openTextDocument(uri);
    if (implementsClassrun(document.getText())) {
      items.push({label: "ZOSD_DEMO_HELLO", description: "Workspace classrun", detail: "Open and press F9 to run", uri});
    }
  }
  return items;
}

async function openSample(context, controller) {
  try {
    const picked = await vscode.window.showQuickPick(await sampleItems(context), {title: "OSD: Open sample"});
    if (!picked) return;
    if (picked.notebook) {
      const document = await vscode.workspace.openNotebookDocument(picked.uri);
      await vscode.window.showNotebookDocument(document);
    } else {
      await vscode.window.showTextDocument(picked.uri);
    }
    // Also accept a system started outside this window, at osd.url.
    if (controller.launcher?.state === "running") return;
    try { await osd().json("/osd/serving", {signal: AbortSignal.timeout(3000)}); return; }
    catch { /* Offer the existing Start action below. */ }
    if (controller.launcher && controller.launcher.state !== "stopped") return;
    const action = await vscode.window.showInformationMessage("Start OSD to run this sample.", "Start system");
    if (action === "Start system") await vscode.commands.executeCommand("osd.start");
  } catch (error) {
    vscode.window.showErrorMessage(`osd: could not open sample: ${String(error.message ?? error)}`);
  }
}

async function newSqlNotebook(statement) {
  return newSqlNotebookView(vscode, NOTEBOOK_TYPE, statement);
}

function sqlNotebookController(output) {
  return sqlNotebookControllerView(vscode, {output, client: () => osd()});
}

// B0: a window that started the system stops it on the way out, rather than
// leaving a build's server as an orphan the way closing a terminal would
// not (VS Code awaits a returned promise here).
async function deactivate() {
  await activeController?.stop({shutdown: true});
}

module.exports = {desktopOutputs, debugOnboarding, editorRunContext, WAIT_CANCELLED, INSPECTOR_STEP_ESCAPE_MS, activate, deactivate, runReportInTerminal, SystemController, classrunObject, registerEntitySetCommands, debugOnDemand, testExplorer, readersLensProvider, OsdTreeProvider, TransactionItem, EntitySetItem,
  httpLensProvider, openEntitySetMethod, statusBar, registerCheckActivateCommands, startStopStatusBar, runningParts, showRunning, sampleItems, openSample,
  openDataPreview,
  transactionProgramPath, clickTransaction, clickTreeNode, openPage, registerOpenCommands, closePageTabs, reloadPageTabs,
  wirePageTabs, openDetailsMetadata, serviceCardFiles};
