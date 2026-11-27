import {expect} from "chai";
import {readFileSync} from "node:fs";
import {createRequire} from "node:module";
import path from "node:path";
import {entitySetMapFor, entitySetsOf} from "../tools/segw-entityset-map.mjs";

const {requestBlocks, resolveRequest} = createRequire(import.meta.url)("../editors/vscode/http-lens.js");
const require = createRequire(import.meta.url);
// The demo DPC's METHOD line (1-based), read off the source rather than
// hardcoded, so an edit above a method does not break a test about lenses.
const demoDpcLine = (method) => {
  const lines = readFileSync("src/demo/zcl_zstg_demo_dpc_ext.clas.abap", "utf8").split("\n");
  const at = lines.findIndex((line) => line.trim().toLowerCase() === `method ${method}.`);
  if (at < 0) throw new Error(`no METHOD ${method} in the demo DPC`);
  return at + 1;
};
const Module = require("node:module");
const {Osd} = require("../editors/vscode/lib.js");
const cls = (name) => `src/demo/${name.toLowerCase()}.clas.abap`;
const names = ["ZCL_ZSTG_DEMO_DPC_EXT", "ZCL_ZSTG_DEMO_DPC", "ZCL_ZSTG_DEMO_MPC_EXT", "ZCL_ZSTG_DEMO_MPC"];
const sources = Object.fromEntries(names.map((name) => [name, {path: cls(name), source: readFileSync(cls(name), "utf8")}]));
const registration = {external: "ZSTG_DEMO_SRV", dpc: names[0], mpc: names[2]};
const map = entitySetMapFor(names[0], [registration], (name) => sources[name]?.source);
const rows = [{kind: "ODATA", name: registration.external, handler: registration.dpc}];

describe(".http forward CodeLens", () => {
  it("activates for a .http-only workspace and an opened .http editor", () => {
    const manifest = JSON.parse(readFileSync("editors/vscode/package.json", "utf8"));
    expect(manifest.activationEvents).to.include("workspaceContains:**/*.http").and.to.include("onLanguage:http");
  });

  it("reads each block's request line, including a host variable", () => {
    const blocks = requestBlocks("# @osd.clock 1\n### first\n# label\nGET {{baseUrl}}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet HTTP/1.1\n\n###\nPOST /x\n");
    expect(blocks).to.deep.equal([
      {line: 4, method: "GET", url: "{{baseUrl}}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet"},
      {line: 7, method: "POST", url: "/x"},
    ]);
  });

  it("resolves collection and keyed GETs to the owning implementation", () => {
    for (const [url, kind, expectedLine] of [
      ["{{baseUrl}}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet", "GET_ENTITYSET", demoDpcLine("travelset_get_entityset")],
      ["https://example.invalid/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('1')", "GET_ENTITY", demoDpcLine("travelset_get_entity")],
    ]) {
      const lens = resolveRequest({line: 2, method: "GET", url}, rows, map, sources);
      expect(lens).to.include({owner: names[0], methodLine: expectedLine, path: cls(names[0])});
      expect(lens.title).to.include(`TravelSet › ${kind}`).and.to.include("(static)");
    }
  });

  it("uses the base DPC when EXT does not implement a mapped method", () => {
    const onlyBase = {...sources, [names[0]]: {...sources[names[0]], source: "CLASS zcl_zstg_demo_dpc_ext IMPLEMENTATION.\nENDCLASS."}};
    const lens = resolveRequest({line: 1, method: "GET", url: "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet"}, rows, map, onlyBase);
    expect(lens).to.include({owner: names[1], methodLine: 661});
  });

  it("leaves unsupported shapes and unknown services without a handler", () => {
    for (const [method, url] of [
      ["POST", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet"],
      ["GET", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/$batch"],
      ["GET", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet?$expand=BookingSet"],
      ["GET", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('1')/BookingSet"],
      ["GET", "/sap/opu/odata/sap/ZSTG_DEMO_SRV/PhotoSet('1')/$value"],
      ["GET", "/sap/opu/odata/sap/UNKNOWN_SRV/TravelSet"],
    ]) {
      const lens = resolveRequest({line: 1, method, url}, rows, map, sources);
      expect(lens.title).to.match(/^unresolved: /);
      expect(lens).not.to.have.property("path");
    }
  });

  it("does not resolve a service path in a query value or fragment", () => {
    for (const url of [
      "https://example.invalid/health?next=/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet",
      "https://example.invalid/health#/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet",
    ]) {
      const lens = resolveRequest({line: 1, method: "GET", url}, rows, map, sources);
      expect(lens.title).to.equal("unresolved: not a service entity-set URL");
      expect(lens).not.to.have.property("path");
    }
  });

  it("maps a uniquely truncated SEGW prefix and rejects ambiguous ones", () => {
    const dpc = "METHOD verylongentityse_get_entityset.";
    const mpc = "CONSTANTS gc_one TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'VeryLongEntitySetName'.";
    expect(entitySetsOf(dpc, mpc)).to.deep.equal([{method: "VERYLONGENTITYSE_GET_ENTITYSET", kind: "get_entityset", set: "VeryLongEntitySetName"}]);
    expect(entitySetsOf(dpc, `${mpc}\nCONSTANTS gc_two TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'VeryLongEntitySetOther'.`))
      .to.deep.equal([]);
    const exact = "CONSTANTS gc_one TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'abcdefghijklmnop'.";
    const longer = "CONSTANTS gc_two TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name VALUE 'abcdefghijklmnopMore'.";
    expect(entitySetsOf("METHOD abcdefghijklmnop_get_entityset.", exact))
      .to.deep.equal([{method: "ABCDEFGHIJKLMNOP_GET_ENTITYSET", kind: "get_entityset", set: "abcdefghijklmnop"}]);
    expect(entitySetsOf("METHOD abcdefghijklmnop_get_entityset.", `${exact}\n${longer}`)).to.deep.equal([]);
  });

  it("looks up source files, refreshes on state changes, and opens the resolved line", async () => {
    const originalServices = Osd.prototype.services;
    const originalEntitySets = Osd.prototype.entitySets;
    const originalServing = Osd.prototype.serving;
    const originalDumps = Osd.prototype.dumps;
    const originalLoad = Module._load;
    const originalInterval = globalThis.setInterval;
    const extensionPath = require.resolve("../editors/vscode/extension.js");
    const found = [];
    const opened = [];
    const revealed = [];
    let stateListener;
    let configListener;
    let provider;
    let statusTick;
    let servingUp = true;
    const vscode = {
      EventEmitter: class {
        listeners = [];
        event = (listener) => { this.listeners.push(listener); return {dispose() {}}; };
        fire() { this.listeners.forEach((listener) => listener()); }
        dispose() {}
      },
      CodeLens: class { constructor(range, command) { this.range = range; this.command = command; } },
      Range: class { constructor(start) { this.start = start; } },
      Position: class { constructor(line, character) { this.line = line; this.character = character; } },
      Selection: class { constructor(start) { this.active = start; } },
      TreeItem: class {},
      ThemeIcon: class {},
      StatusBarAlignment: {Left: 1},
      Uri: {file: (fsPath) => ({fsPath})},
      languages: {registerCodeLensProvider: (selector, registered) => {
        expect(selector).to.deep.equal({pattern: "**/*.http"});
        provider = registered;
        return {dispose() {}};
      }},
      workspace: {
        workspaceFolders: [{uri: {fsPath: process.cwd()}}],
        getConfiguration: () => ({get: () => "http://localhost:3030"}),
        onDidChangeConfiguration: (listener) => { configListener = listener; return {dispose() {}}; },
        findFiles: async (pattern) => {
          found.push(pattern);
          const name = /zcl_zstg_demo_dpc_ext/i.test(pattern) ? names[0] : names[1];
          return [{fsPath: path.resolve(cls(name))}];
        },
        openTextDocument: async (uri) => { opened.push(uri.fsPath); return uri; },
      },
      window: {
        createStatusBarItem: () => ({show() {}}),
        showTextDocument: async () => ({revealRange: (range) => revealed.push(range.start.line)}),
        showWarningMessage: () => { throw new Error("source should be found"); },
        showErrorMessage: (message) => { throw new Error(message); },
      },
    };
    try {
      Osd.prototype.services = async () => { if (!servingUp) throw new Error("down"); return rows; };
      Osd.prototype.entitySets = async () => map;
      Osd.prototype.serving = async () => { if (!servingUp) throw new Error("down"); return {generation: "test", pid: 1}; };
      Osd.prototype.dumps = async () => [];
      globalThis.setInterval = (callback) => { statusTick = callback; return 1; };
      Module._load = function (request, parent, isMain) {
        if (request === "vscode") return vscode;
        return originalLoad.call(this, request, parent, isMain);
      };
      delete require.cache[extensionPath];
      const {httpLensProvider, openEntitySetMethod, statusBar} = require(extensionPath);
      const controller = {onDidChange: (listener) => { stateListener = listener; return {dispose() {}}; }};
      const registration = httpLensProvider({appendLine() {}}, controller);
      let refreshes = 0;
      provider.onDidChangeCodeLenses(() => { refreshes++; });
      const document = {getText: () => "### travel\nGET {{baseUrl}}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet"};
      const [lens] = await provider.provideCodeLenses(document);
      expect(found).to.have.length(2);
      expect(lens.command.command).to.equal("osd.openEntitySetMethod");
      expect(lens.command.arguments.slice(0, 3)).to.deep.equal([names[0], map.sets.find((set) => set.set === "TravelSet" && set.kind === "get_entityset"), demoDpcLine("travelset_get_entityset")]);
      const [owner, set, line, sourceFile] = lens.command.arguments;
      await openEntitySetMethod(owner, set, line, {appendLine() {}}, sourceFile);
      expect(opened).to.deep.equal([path.resolve(cls(names[0]))]);
      expect(revealed).to.deep.equal([demoDpcLine("travelset_get_entityset") - 1]);
      stateListener(); // start or stop
      configListener({affectsConfiguration: (name) => name === "osd.url"});
      expect(refreshes).to.equal(2);
      const context = {subscriptions: []};
      servingUp = false;
      statusBar(context);
      await new Promise((resolve) => setImmediate(resolve));
      expect((await provider.provideCodeLenses(document))[0].command.title).to.equal("start the system to resolve");
      const beforeExternalChange = refreshes;
      servingUp = true; // external npm start, unchanged osd.url
      await statusTick();
      expect((await provider.provideCodeLenses(document))[0].command.command).to.equal("osd.openEntitySetMethod");
      servingUp = false; // external stop
      await statusTick();
      expect((await provider.provideCodeLenses(document))[0].command.title).to.equal("start the system to resolve");
      expect(refreshes).to.equal(beforeExternalChange + 2);
      registration.dispose();
    } finally {
      Osd.prototype.services = originalServices;
      Osd.prototype.entitySets = originalEntitySets;
      Osd.prototype.serving = originalServing;
      Osd.prototype.dumps = originalDumps;
      globalThis.setInterval = originalInterval;
      Module._load = originalLoad;
      delete require.cache[extensionPath];
    }
  });
});
