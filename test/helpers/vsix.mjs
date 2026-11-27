import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {createRequire, Module} from "node:module";
import {mkdirSync, mkdtempSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {homedir} from "node:os";
import {brotliDecompressSync} from "node:zlib";
import {buildVsix} from "../../scripts/build-vsix.mjs";

export const root = process.cwd();
const trackedVersion = JSON.parse(readFileSync(join(root, "editors", "vscode", "package.json"), "utf8")).version;
const versionParts = /^(\d+)\.(\d+)\.\d+$/.exec(trackedVersion);
if (versionParts === null) throw new Error(`expected a plain major.minor.patch version, got ${trackedVersion}`);
const commitCount = execFileSync("git", ["rev-list", "--count", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
export const currentVsixFile = `open-steamgate-${versionParts[1]}.${versionParts[2]}.${commitCount}.vsix`;

export function packagedSeedEntries(archive) {
  expect(execFileSync("unzip", ["-Z1", archive], {encoding: "utf8"})).to.contain("extension/osd/seed.tar.br");
  const compressed = execFileSync("unzip", ["-p", archive, "extension/osd/seed.tar.br"], {maxBuffer: 32 * 1024 * 1024});
  return execFileSync("tar", ["-tf", "-"], {
    input: brotliDecompressSync(compressed), encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  });
}

export function packagedPacks(archive) {
  const entries = packagedSeedEntries(archive);
  return [...new Set(entries.split("\n").map((entry) => /^packs\/([^/]+)\//.exec(entry)?.[1])
    .filter((name) => name !== undefined))].sort();
}

// **Outside the checkout, on purpose.** A scratch folder under this tree
// resolves a bare import by walking up into the checkout's own node_modules,
// so a package the .vsix forgot (js-yaml, found by the first real install,
// 2026-09-26) still loads here and the test is green for a package that fails
// in a user's globalStorage. Not /tmp either: it is a small tmpfs.
const SCRATCH = join(process.env.OSD_VSIX_SCRATCH ?? join(homedir(), ".cache", "osd-vsix-test"));
export function testScratch(name) {
  mkdirSync(SCRATCH, {recursive: true});
  return mkdtempSync(join(SCRATCH, `${name}-`));
}
// OSD_VSIX_PREBUILT=0 unless a test asks: the prebuilt generation costs a
// cold build (~20 s) per package, and only one test here is about it.
// Without a prebuilt generation these packages copy a checkout the tests
// change on purpose (a source file, a scratch pack), so they are test-only and
// unstamped: no release path accepts a .vsix without its provenance. A
// prebuilt one is stamped from its own seed, as a release is.
export function buildTestVsix(outputDir, env = {}) {
  const merged = {OSD_VSIX_PREBUILT: "0", ...env, OSD_VSIX_BROTLI_QUALITY: "4"};
  return buildVsix(merged, outputDir, {stamp: merged.OSD_VSIX_PREBUILT !== "0"});
}
export function packagedController(extensionDir, workspace, home) {
  class EventEmitter {
    listeners = new Set();
    event = (listener) => { this.listeners.add(listener); return {dispose: () => this.listeners.delete(listener)}; };
    fire() { for (const listener of this.listeners) listener(); }
  }
  const folderEvents = new EventEmitter();
  const api = {
    EventEmitter,
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    ConfigurationTarget: {Workspace: 1, Global: 2},
    workspace: {
      workspaceFolders: [{uri: {fsPath: workspace}}],
      onDidChangeWorkspaceFolders: folderEvents.event,
      getConfiguration: () => ({get: (key, fallback) => key === "home" ? home : fallback, update: async () => {}}),
    },
    debug: {onDidStartDebugSession: () => ({dispose() {}}), onDidTerminateDebugSession: () => ({dispose() {}})},
    window: {setStatusBarMessage() {}, showInformationMessage() {}, showErrorMessage() {}, showWarningMessage() {}},
  };
  const requirePackaged = createRequire(import.meta.url);
  const originalLoad = Module._load;
  Module._load = function (request, parent, isMain) {
    if (request === "vscode") return api;
    return originalLoad.call(this, request, parent, isMain);
  };
  let SystemController;
  try { ({SystemController} = requirePackaged(join(extensionDir, "extension.js"))); }
  finally { Module._load = originalLoad; }
  return {api, SystemController};
}
export function timeVsixTests() {
  beforeEach(function () {
    this.currentTest.vsixStartedAt = performance.now();
  });
  afterEach(function () {
    console.log(`vsix test wall: ${this.currentTest.fullTitle()} ${((performance.now() - this.currentTest.vsixStartedAt) / 1000).toFixed(3)} s`);
  });
}
