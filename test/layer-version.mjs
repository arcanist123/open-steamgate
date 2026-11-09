import {expect} from "chai";
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {parseVersion, parseMinimum, compareVersions, packagedVersion, writeVersionMarker, checkLayerVersions} from "../tools/layer-version/index.mjs";
import {build, liveHash} from "../tools/osd-build.mjs";
import {layerList} from "../tools/osd-host.mjs";
import {brotliCompressSync} from "node:zlib";
import {finalizeSystemSeed, stampStagedPackage} from "../scripts/build-vsix.mjs";
const require = createRequire(import.meta.url);
const {writeTar, ensureMaterializedHome, classify, ensureWorkspacePacks} = require("../editors/vscode/launcher.js");

const current = packagedVersion(resolve("."));
const diagnostic = (kind, minimum, version = current) =>
  `osd: ${kind} osg-demo needs osd >= ${minimum}; this system is ${version} — update the extension (or the binary)`;

describe("layer version requirements (U11)", function () {
  this.timeout(120000);
  let root, oldEnv;
  const write = (file, text) => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  };
  const manifest = (file, osd) => write(file, JSON.stringify({name: "osg-demo", ...(osd === undefined ? {} : {osd})}));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "layer-version-"));
    oldEnv = {...process.env};
    delete process.env.OSD_LAYERS;
    delete process.env.OSD_PACKS;
    delete process.env.OSD_WEB_PACKS;
    process.env.OSD_TMP = "off";
    write("abap_transpile.json", JSON.stringify({input_folder: ["src"], output_folder: "output"}));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    write("src/zcl_one.clas.abap", "CLASS zcl_one DEFINITION PUBLIC. ENDCLASS. CLASS zcl_one IMPLEMENTATION. ENDCLASS.\n");
    writeVersionMarker(root, current);
  });
  afterEach(() => {
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
    rmSync(root, {recursive: true, force: true});
  });

  it("parses only plain versions and >= minima", () => {
    expect(parseVersion("0.6.1650")).to.deep.equal([0n, 6n, 1650n]);
    expect(parseMinimum(">=0.6.1650")).to.equal("0.6.1650");
    for (const bad of ["0.6", "v0.6.1650", "0.6.1650-beta", "01.6.1650", null, 7])
      expect(() => parseVersion(bad)).to.throw(/invalid osd version/);
    for (const bad of ["0.6.1650", "^0.6.1650", ">0.6.1650", ">= 0.6.1650", ">=0.6.1650 <1.0.0", null])
      expect(() => parseMinimum(bad)).to.throw();
  });

  it("compares all components numerically, including equality and large patches", () => {
    for (const [left, right, expected] of [
      ["0.6.1650", "0.5.1467", 1], ["0.6.9", "0.6.10", -1],
      ["1.0.0", "0.99.9999", 1], ["0.6.1650", "0.6.1650", 0],
      ["0.6.9007199254740993", "0.6.9007199254740992", 1],
    ]) expect(compareVersions(left, right)).to.equal(expected);
  });

  it("stamps the build commit into the seed, so a seeded binary does not answer commit unknown", () => {
    const stage = (commit) => {
      const seed = join(root, `seed-${commit}`);
      mkdirSync(join(seed, "packs"), {recursive: true});
      const {seedId} = finalizeSystemSeed(seed, [], {version: current, transpilerRef: "test-ref", commit});
      return {seed, seedId};
    };
    const one = stage("1111111111111111111111111111111111111111");
    const two = stage("2222222222222222222222222222222222222222");
    // tools/adt-facade.mjs sourceCommit reads release.json in the home
    expect(JSON.parse(readFileSync(join(one.seed, "release.json"), "utf8")).commit)
      .to.equal("1111111111111111111111111111111111111111");
    // the commit is part of the seed id: another commit, another home
    expect(one.seedId).to.not.equal(two.seedId);
    // default: the workflow's GITHUB_SHA, never "unknown"
    process.env.GITHUB_SHA = "3333333333333333333333333333333333333333";
    const seed = join(root, "seed-env");
    mkdirSync(join(seed, "packs"), {recursive: true});
    finalizeSystemSeed(seed, [], {version: current, transpilerRef: "test-ref"});
    expect(JSON.parse(readFileSync(join(seed, "release.json"), "utf8")).commit)
      .to.equal("3333333333333333333333333333333333333333");
  });

  it("stages and extracts the marker with the exact VSIX version for both hosts", async () => {
    write("staged-package.json", readFileSync("editors/vscode/package.json"));
    const {pkg} = stampStagedPackage(join(root, "staged-package.json"));
    expect(pkg.version).to.equal(current);
    const seed = join(root, "seed");
    mkdirSync(join(seed, "packs"), {recursive: true});
    // The narrow real staging function called by stageSystemSeed for both
    // buildVsix and build-binary --seed; no test-side marker writer.
    const {seedId} = finalizeSystemSeed(seed, [], {version: pkg.version, transpilerRef: "test-ref"});
    const tar = join(root, "seed.tar");
    writeTar(seed, tar);
    write("archive/.seed-id", `${seedId}\n`);
    write("archive/seed.tar.br", brotliCompressSync(readFileSync(tar)));
    const vsixHome = await ensureMaterializedHome(join(root, "archive"), join(root, "vsix-storage"));
    expect(JSON.parse(readFileSync(join(vsixHome, "osd-version.json"), "utf8"))).to.deep.equal({version: pkg.version});

    const archive = join(root, "seed.tar.gz");
    execFileSync("tar", ["-czf", archive, "-C", seed, "."]);
    const child = spawnSync("bun", ["--no-install", "--input-type=module", "-e", `
      import {ensureBinaryHome} from ${JSON.stringify(resolve("tools/osd-host.mjs"))};
      console.log(await ensureBinaryHome(process.argv[1], process.argv[2]));
    `, archive, join(root, "binary-storage")], {encoding: "utf8"});
    expect(child.status, child.stderr).to.equal(0);
    const binaryHome = child.stdout.trim();
    expect(JSON.parse(readFileSync(join(binaryHome, "osd-version.json"), "utf8"))).to.deep.equal({version: pkg.version});
    for (const home of [vsixHome, binaryHome]) {
      writeFileSync(join(home, "osd-pack.json"), JSON.stringify({name: "osg-demo", osd: ">=99.0.0"}));
      expect(() => checkLayerVersions(home, [], [home])).to.throw(diagnostic("layer", "99.0.0", pkg.version));
    }
  });

  for (const source of ["--layer", "OSD_LAYERS"]) {
    it(`refuses a nested declared ABAP folder supplied by ${source}`, async () => {
      write("workspace/osd-pack.json", JSON.stringify({name: "osg-demo", abap: "abap/src", osd: ">=99.0.0"}));
      // An unrelated nearer manifest must not stop ancestor discovery.
      write("workspace/abap/osd-pack.json", JSON.stringify({abap: "other"}));
      write("workspace/abap/src/zcl_bad.clas.abap", "invalid ABAP");
      const folder = join(root, "workspace/abap/src");
      process.env.OSD_LAYERS = source === "--layer"
        ? layerList(["--layer", folder], {}, root).folders.join(process.platform === "win32" ? ";" : ":")
        : folder;
      let error;
      try { await build({root}); } catch (caught) { error = caught; }
      expect(error?.code).to.equal("OSD_VERSION_MISMATCH");
      expect(error.message).to.equal(diagnostic("layer", "99.0.0"));
      expect(existsSync(join(root, "build"))).to.equal(false);
      expect(existsSync(join(root, "gen"))).to.equal(false);
    });
  }

  it("refuses --layer before any generator or transpile, with one line and live untouched", async () => {
    const first = await build({root, generators: false});
    const generations = readdirSync(join(root, "build/by-input"));
    manifest("workspace/osd-pack.json", ">=99.0.0");
    write("workspace/src/zcl_bad.clas.abap", "invalid ABAP would generate syntax errors");
    const {folders} = layerList(["--layer", join(root, "workspace/src")], {}, root);
    process.env.OSD_LAYERS = folders.join(process.platform === "win32" ? ";" : ":");
    const child = spawnSync(process.execPath, [resolve("tools/osd-build.mjs")], {
      cwd: root, env: {...process.env, OSD_ROOT: root}, encoding: "utf8",
    });
    expect(child.status).to.equal(1);
    expect(child.stderr.trim()).to.equal(diagnostic("layer", "99.0.0"));
    expect(child.stdout).not.to.match(/check_syntax|transpil|generator/);
    expect(liveHash(root)).to.equal(first.hash);
    expect(readdirSync(join(root, "build/by-input"))).to.deep.equal(generations);
    expect(existsSync(join(root, "gen"))).to.equal(false);
  });

  it("builds a workspace layer requiring the current version", async () => {
    manifest("workspace/osd-pack.json", `>=${current}`);
    write("workspace/src/zcl_two.clas.abap", "CLASS zcl_two DEFINITION PUBLIC. ENDCLASS. CLASS zcl_two IMPLEMENTATION. ENDCLASS.\n");
    process.env.OSD_LAYERS = join(root, "workspace/src");
    const result = await build({root, generators: false});
    expect(result.objects).to.equal(2);
    expect(liveHash(root)).to.equal(result.hash);
  });

  it("checks packs, including VS Code's projected workspace manifest", async () => {
    manifest("workspace/osd-pack.json", ">=99.0.0");
    mkdirSync(join(root, "workspace/src"), {recursive: true});
    process.env.OSD_PACKS = ensureWorkspacePacks(join(root, "storage"), [{
      folder: join(root, "workspace"), srcDir: join(root, "workspace/src"), manifest: join(root, "workspace/osd-pack.json"),
    }]);
    let error;
    try { await build({root}); } catch (caught) { error = caught; }
    expect(error?.code).to.equal("OSD_VERSION_MISMATCH");
    expect(error.message).to.equal(diagnostic("pack", "99.0.0"));
    expect(existsSync(join(root, "build"))).to.equal(false);
  });

  it("allows an absent requirement", () => {
    manifest("workspace/osd-pack.json");
    checkLayerVersions(root, [], ["workspace"]);
  });

  it("skips an unmarked source checkout with a debug line", () => {
    rmSync(join(root, "osd-version.json"));
    manifest("workspace/osd-pack.json", ">=99.0.0");
    const logs = [];
    checkLayerVersions(root, [], ["workspace"], line => logs.push(line));
    expect(logs).to.deep.equal(["debug: no osd-version.json; layer version check skipped in source checkout"]);
  });

  it("refuses malformed requirements and version markers", () => {
    manifest("workspace/osd-pack.json", "^0.6.1650");
    expect(() => checkLayerVersions(root, [], ["workspace"])).to.throw(/osd-pack.json: invalid osd requirement/);
    manifest("workspace/osd-pack.json", ">=0.6.1650");
    write("osd-version.json", JSON.stringify({version: "broken"}));
    expect(() => checkLayerVersions(root, [], ["workspace"])).to.throw(/invalid osd version/);
  });

  it("classifies the refusal verbatim even when the build error wraps the log", () => {
    const text = diagnostic("layer", "0.6.1650", "0.5.1467");
    expect(classify("", new Error(`build failed (exit 1): ${text}\nosd-build: live generation untouched`)))
      .to.deep.equal({kind: "version-mismatch", message: text, actions: ["Update"]});
  });

  for (const source of ["launcher", "warm rebuild"]) {
    it(`shows the exact ${source} diagnostic once and opens the extension on Update`, async () => {
      const text = diagnostic("pack", "0.6.1650", "0.5.1467");
      const errors = [], commands = [];
      const subscribe = () => ({dispose() {}});
      const api = {
        TreeItem: class {},
        EventEmitter: class { event = subscribe; fire() {} dispose() {} },
        debug: {onDidTerminateDebugSession: subscribe},
        workspace: {onDidChangeWorkspaceFolders: subscribe,
          getConfiguration: () => ({get: (_key, fallback) => fallback})},
        window: {showErrorMessage: async (...args) => { errors.push(args); return "Update"; }},
        commands: {executeCommand: async (...args) => { commands.push(args); }},
      };
      const Module = require("node:module"), original = Module._load;
      const file = require.resolve("../editors/vscode/extension.js");
      delete require.cache[file];
      let SystemController;
      let activations = 0;
      Module._load = function (name, ...args) {
        if (name === "vscode") return api;
        const loaded = original.call(this, name, ...args);
        if (name === "./lib.js") return {...loaded, Osd: class {
          constructor(url) { this.url = url; }
          async serving() { return {warm: {state: "primed"}}; }
          async changed() { return {objects: [{type: "CLAS", name: "ZCL_ONE"}]}; }
          async activateMany() {
            activations++;
            return {ok: false, issues: [{objDescr: "ZCL_ONE", message: text}]};
          }
        }};
        return loaded;
      };
      try { ({SystemController} = require(file)); } finally { Module._load = original; }
      try {
        const controller = new SystemController({subscriptions: [], workspaceState: {get() {}}}, {show() {}, appendLine() {}});
        controller.ensureLauncher = async () => ({state: "stopped", lastLog: `${text}\nosd-build: live generation untouched`,
          async start() { throw new Error("build failed (exit 1)"); }});
        if (source === "launcher") {
          expect(await controller.rebuild()).to.equal(false);
        } else {
          controller.launcher = {state: "running"};
          controller.rebuild = async () => { throw new Error("unexpected full rebuild"); };
          await controller.rebuildWarm();
          expect(activations).to.equal(1);
        }
        expect(errors).to.deep.equal([[text, "Update"]]);
        expect(commands).to.deep.equal([["extension.open", "oisee.open-steamgate"]]);
      } finally { delete require.cache[file]; }
    });
  }
});
