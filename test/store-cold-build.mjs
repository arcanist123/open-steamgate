import {expect} from "chai";
import {mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, existsSync, readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {execFileSync, spawn} from "node:child_process";
import {ObjectStore} from "../tools/osd-store.mjs";
import {build} from "../tools/osd-build.mjs";
import {StoreDestination, withSystem} from "../tools/osd-store-destination.mjs";
import {ActivationJournal} from "../tools/osd-activation-journal.mjs";
import {WarmCompiler} from "../tools/osd-warm.mjs";
import {WarmCompilerProcess} from "../tools/osd-warm-process.mjs";
import {closeWarm} from "../tools/osd-store-warm.mjs";
import {cpSync} from "node:fs";
import {once} from "node:events";
import {ServingRuntime} from "../tools/osd-runtime.mjs";
import {scaled, speed} from "../tools/warm-deadline/warm-deadline.mjs";

const repo = resolve(".");
const source = value => `CLASS zcl_cold_draft DEFINITION PUBLIC. PUBLIC SECTION.
CLASS-METHODS answer RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS zcl_cold_draft IMPLEMENTATION. METHOD answer. rv = ${value}. ENDMETHOD. ENDCLASS.\n`;

describe("STORE cold builds after a source-host restart", function () {
  this.timeout(120000);
  let root, store, destination, warm;
  const open = () => new ObjectStore({root, libs: [], build: {generators: false}});
  const execute = async (command, extra = {}) => {
    const answer = await withSystem(() => {}, () => destination.execute({IV_COMMAND: command,
      IV_TYPE: "CLAS", IV_NAME: "ZCL_COLD_DRAFT", ...extra}), {store, repositoryUser: "DRAFTTEST"});
    expect(answer.EV_ERROR ?? "").to.equal("");
    return answer;
  };
  const create = async value => JSON.parse((await execute("CREATE", {IV_SOURCE: source(value)})).EV_JSON);
  // A fresh process takes no in-memory store state or caller-supplied overlay.
  const restartBuild = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {build} from ${JSON.stringify(join(repo, "tools/osd-build.mjs"))};
    const result = await build({root: process.cwd(), generators: false, force: true});
    console.log(JSON.stringify({ok: result.ok, hash: result.hash}));
  `], {cwd: root, encoding: "utf8"}).trim());
  const run = () => JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", `
    import {pathToFileURL} from 'node:url';
    await import(pathToFileURL(process.cwd() + '/output/init.mjs'));
    const file = process.cwd() + '/output/zcl_cold_draft.clas.mjs';
    const {existsSync} = await import('node:fs');
    if (existsSync(file)) await import(pathToFileURL(file));
    console.log(JSON.stringify(globalThis.abap.Classes.ZCL_COLD_DRAFT
      ? (await globalThis.abap.Classes.ZCL_COLD_DRAFT.answer()).get() : null));
  `], {cwd: root, encoding: "utf8"}).trim());
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "store-cold-build-"));
    mkdirSync(join(root, "src"));
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "src/zcl_boot.clas.abap"), "CLASS zcl_boot DEFINITION PUBLIC. ENDCLASS. CLASS zcl_boot IMPLEMENTATION. ENDCLASS.\n");
    writeFileSync(join(root, "abaplint.jsonc"), JSON.stringify({syntax: {version: "v702"}}));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"], output_folder: "output", libs: [],
      options: {ignoreSyntaxCheck: false, addCommonJS: true, unknownTypes: "compileError"}}));
    store = open();
    destination = new StoreDestination({store: () => store});
    await build({root, generators: false});
  });
  afterEach(async () => {
    await warm?.drop(); warm = undefined;
    await closeWarm(store);
    rmSync(root, {recursive: true, force: true});
  });

  it("keeps a never-activated syntax error out, preserves READ, and later publishes the draft", async () => {
    const made = await create("lv_undefined");
    expect(made.version).to.equal("inactive");
    expect(restartBuild().ok).to.equal(true);
    expect(run()).to.equal(null);
    store = open();
    expect((await execute("READ")).EV_SOURCE).to.equal(source("lv_undefined"));
    await execute("WRITE", {IV_SOURCE: source(42)});
    // A serving context confirms the built generation without sharing its modules.
    store.served = {running: true, generation: "old", epoch: 1, recycle: async () => {
      const {liveHash} = await import("../tools/osd-build.mjs");
      store.served.generation = liveHash(root);
      return {generation: store.served.generation};
    }};
    const published = JSON.parse((await execute("ACTIVATE")).EV_JSON);
    expect(published).to.include({state: "published", active: true, live: true});
    expect(run()).to.equal(42);
    const generation = join(root, "build", "by-input", published.generation_id);
    const frozen = JSON.parse(readFileSync(join(generation, "source-inputs.json"), "utf8"));
    expect(readFileSync(join(generation, "source/local/tmp/tadir.json"), "utf8"))
      .to.equal(readFileSync(join(root, "build/source-by-digest", frozen["local/tmp/tadir.json"]), "utf8"));
    expect(restartBuild().ok).to.equal(true);
    expect(run()).to.equal(42);
  });

  for (const stage of ["build", "promotion", "revision", "step", "recovery"]) it(`does not run valid CREATE after ACTIVATE fails at ${stage} and restart`, async () => {
    await create(7);
    let operation;
    if (stage === "step" || stage === "recovery") {
      let continuation;
      const pending = await withSystem(() => {}, () => destination.execute({IV_COMMAND: "ACTIVATE",
        IV_TYPE: "CLAS", IV_NAME: "ZCL_COLD_DRAFT"}), {store, deferActivate: work => {continuation = work;}});
      operation = JSON.parse(pending.EV_JSON);
      if (stage === "step") continuation.fail("forced step failure");
    } else {
      store.publish = async () => {
        // Fail after a successful compile has moved build/live. Restart must
        // still reconstruct the active view rather than trust that pointer.
        const transpile = await store.transpile({activating: new Set(["CLAS ZCL_COLD_DRAFT"])});
        expect(transpile.ok).to.equal(true);
        return stage === "build" ? {ok: false, transpile, error: "forced build failure"}
          : stage === "promotion" ? {ok: true, transpile} : {ok: true, transpile, generation: "unconfirmed-revision"};
      };
      if (stage === "revision") store.completeActivation = () => false;
      operation = JSON.parse((await execute("ACTIVATE")).EV_JSON);
      expect(operation).to.include({state: "failed", active: false, live: false, failure_stage: stage});
      expect(existsSync(join(root, "output/zcl_cold_draft.clas.mjs"))).to.equal(true);
    }
    expect(restartBuild().ok).to.equal(true);
    expect(run()).to.equal(null);
    store = open();
    const journal = new ActivationJournal(root, {host: `http-${process.env.STG_PORT ?? `process-${process.pid}`}`});
    expect(journal.lookup(operation.op_id)).to.include({state: "failed", active: false, live: false, failure_stage: stage});
    expect((await execute("READ")).EV_SOURCE).to.equal(source(7));
  });

  it("serves the active copy of an existing class with a broken inactive edit", async () => {
    const made = await create(19);
    const checked = store.activate("CLAS", "ZCL_COLD_DRAFT");
    expect(checked.active).to.equal(true);
    await build({root, generators: false, overlay: store.overlay(new Set(["CLAS ZCL_COLD_DRAFT"]))});
    expect(store.completeActivation(checked)).to.equal(true);
    await execute("WRITE", {IV_SOURCE: source("lv_undefined")});
    expect(existsSync(join(root, "build/inactive/active", made.file))).to.equal(true);
    expect(restartBuild().ok).to.equal(true);
    expect(run()).to.equal(19);
    store = open();
    expect((await execute("READ")).EV_SOURCE).to.equal(source("lv_undefined"));
    warm = new WarmCompiler({root});
    await warm.prime();
    expect(warm.primed).to.equal(true);
    expect(warm.reg.getObject("CLAS", "ZCL_COLD_DRAFT")).to.not.equal(undefined);
    await warm.drop();
    warm = new WarmCompilerProcess({root});
    await warm.prime();
    expect(warm.primed).to.equal(true);
  });

  it("DELETE of a never-activated object removes files, intent, and future build input", async () => {
    const made = await create("lv_undefined");
    await execute("DELETE");
    expect(existsSync(join(root, made.file))).to.equal(false);
    expect(readFileSync(join(root, "build/inactive/inactive.json"), "utf8")).to.not.include("ZCL_COLD_DRAFT");
    expect(restartBuild().ok).to.equal(true);
    expect(run()).to.equal(null);
    store = open();
    expect(store.find("CLAS", "ZCL_COLD_DRAFT")).to.equal(undefined);
    expect(store.overlay()).to.equal(undefined);
  });

  it("generators read active copies and exclude new drafts without rewriting their metadata", async () => {
    const made = await create(19);
    const checked = store.activate("CLAS", "ZCL_COLD_DRAFT");
    await build({root, generators: false, overlay: store.overlay(new Set(["CLAS ZCL_COLD_DRAFT"]))});
    expect(store.completeActivation(checked)).to.equal(true);
    await execute("WRITE", {IV_SOURCE: source("lv_undefined")});
    const other = store.create("CLAS", "ZCL_COLD_NEW", {package: "$TMP"});
    const metadata = readFileSync(join(root, "build/inactive/inactive.json"), "utf8");
    const overlay = store.overlay();
    const read = JSON.parse(execFileSync(process.execPath, ["--import", join(repo, "tools/osd-generator-view.mjs"),
      "--input-type=module", "-e", `
      import {readFileSync, existsSync, readdirSync} from 'node:fs';
      import {ObjectStore} from ${JSON.stringify(join(repo, "tools/osd-store.mjs"))};
      const store = new ObjectStore({root: process.cwd()});
      console.log(JSON.stringify({source: readFileSync(${JSON.stringify(made.file)}, 'utf8'),
        draftExists: existsSync(${JSON.stringify(other.file)}),
        draftListed: readdirSync('local/tmp').includes('zcl_cold_new.clas.abap'),
        objects: store.list('CLAS').map(o => o.name)}));
    `], {cwd: root, encoding: "utf8", env: {...process.env, OSD_ROOT: root,
      OSD_ACTIVE_BUILD_OVERLAY: JSON.stringify({...overlay, exclude: [...overlay.exclude]})}}));
    expect(read.source).to.equal(source(19));
    expect(read).to.include({draftExists: false, draftListed: false});
    expect(read.objects).to.include("ZCL_COLD_DRAFT").and.not.include("ZCL_COLD_NEW");
    expect(readFileSync(join(root, "build/inactive/inactive.json"), "utf8")).to.equal(metadata);
  });
});

describe("cold source view in real server hosts", function () {
  // A host start plus its warm prime: on a slower runner both take longer,
  // and by the factor the prime's own deadline is scaled with.
  console.log(`runner speed factor ${speed().factor.toFixed(2)} (${speed().source})`);
  this.timeout(scaled(240000));
  let root, store, runtime, child, hostLog = "";
  const draft = "CLASS zcl_cold_host DEFINITION PUBLIC. PUBLIC SECTION.\n" +
    "INTERFACES if_oo_adt_classrun. ENDCLASS.\n" +
    "CLASS zcl_cold_host IMPLEMENTATION. METHOD if_oo_adt_classrun~main.\n" +
    "out->write( lv_undefined ). ENDMETHOD. ENDCLASS.\n";
  const waitFor = async work => {
    const deadline = Date.now() + scaled(180000);
    while (Date.now() < deadline) {
      if (child && (child.exitCode !== null || child.signalCode !== null)) throw new Error(hostLog);
      try { if (await work()) return; } catch (error) { if (child && (child.exitCode !== null || child.signalCode !== null)) throw error; }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    throw new Error(`host did not become ready: ${hostLog.slice(-4000)}`);
  };
  before(async () => {
    root = mkdtempSync(join(tmpdir(), "store-cold-host-"));
    for (const dir of ["src", "test", "webapp", "packs", "data"]) cpSync(join(repo, dir), join(root, dir), {recursive: true});
    for (const file of ["package.json", "abap_transpile.json", "abaplint.jsonc", "libs.lock.json"]) {
      if (existsSync(join(repo, file))) cpSync(join(repo, file), join(root, file));
    }
    for (const dir of ["node_modules", "tools", "bin"]) symlinkSync(join(repo, dir), join(root, dir));
    mkdirSync(join(root, ".local"));
    symlinkSync(join(repo, ".local/lars"), join(root, ".local/lars"));
    store = new ObjectStore({root});
    await withSystem(() => {}, () => new StoreDestination({store}).execute({IV_COMMAND: "CREATE",
      IV_TYPE: "CLAS", IV_NAME: "ZCL_COLD_HOST", IV_SOURCE: draft}), {store, repositoryUser: "DRAFTTEST"});
  });
  const stop = async () => {
    await runtime?.stop(); runtime = undefined;
    if (child) {
      const gone = child.exitCode !== null || child.signalCode !== null ? Promise.resolve() : once(child, "exit");
      child.kill("SIGTERM");
      const timer = setTimeout(() => child?.kill("SIGKILL"), 5000);
      await gone; clearTimeout(timer); child = undefined;
    }
  };
  afterEach(async function () {
    if (this.currentTest.state === "failed") console.log(this.currentTest.err?.stack, hostLog.slice(-5000));
    await stop();
  });
  after(async () => { await stop(); if (root) rmSync(root, {recursive: true, force: true}); });
  const start = async (args, extra = {}) => {
    hostLog = "";
    child = spawn(process.execPath, args, {cwd: root, env: {...process.env, OSD_ROOT: root,
      OSD_WARM: "1", STG_DB: "sqlite", STG_DB_PATH: "", STG_TLS: "0", OSD_BIND: "127.0.0.1", ...extra},
      stdio: ["ignore", "pipe", "pipe"]});
    child.stdout.on("data", data => {hostLog += data; writeFileSync(join(root, "host.log"), hostLog);});
    child.stderr.on("data", data => {hostLog += data; writeFileSync(join(root, "host.log"), hostLog);});
    const base = `http://127.0.0.1:${process.env.STG_PORT}`;
    await waitFor(async () => {
      const ready = await fetch(base + "/osd/ready", {signal: AbortSignal.timeout(2000)});
      if (ready.status === 200) return true;
      const serving = await fetch(base + "/osd/serving", {signal: AbortSignal.timeout(2000)});
      return serving.status === 200 && (await serving.json()).ready;
    });
    return base;
  };
  const absent = async base => {
    const response = await fetch(base + "/osd/classrun", {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({name: "ZCL_COLD_HOST"}), signal: AbortSignal.timeout(10000)});
    const body = await response.text();
    expect(response.status, body).to.be.oneOf([500, 503]);
    expect(JSON.parse(body).error.code).to.be.oneOf(["ERR_MODULE_NOT_FOUND", "NOT_BUILT"]);
    expect(existsSync(join(root, "output/zcl_cold_host.clas.mjs"))).to.equal(false);
    expect(new ObjectStore({root}).read("CLAS", "ZCL_COLD_HOST").source).to.equal(draft);
  };
  it("standalone serving entry cold-builds active source", async () => {
    await absent(await start([join(repo, "tools/osd-serve.mjs"), process.env.STG_PORT]));
  });
  it("test/start inline prepares active source before loading modules", async () => {
    const base = await start(["--input-type=module", "-e", "const {startServer} = await import('./test/start.mjs'); startServer(true);"], {STG_SERVE: "inline"});
    expect((await fetch(base + "/sap/bc/adt/core/discovery")).status).to.equal(200);
    expect(existsSync(join(root, "output/zcl_cold_host.clas.mjs"))).to.equal(false);
  });
  it("test/start one-runtime child and warm prime keep the draft absent", async () => {
    const base = await start([join(root, "test/run.mjs")], {STG_SERVE: "child", OSD_ADT_ONE_RUNTIME: "1"});
    await absent(base);
    await waitFor(async () => {
      const status = await (await fetch(base + "/osd/serving", {signal: AbortSignal.timeout(2000)})).json();
      return status.warm?.state === "primed";
    });
    expect(hostLog).to.not.include("builds stay cold");
  });
  it("bin/osd up uses the same source build and serving child", async () => {
    await absent(await start([join(repo, "bin/osd.mjs"), "up"], {OSD_ADT_ONE_RUNTIME: "1"}));
  });
  it("lifecycle server start uses the same one-runtime warm source view", async () => {
    // CI shards provide STG_PORT without the workstation heavy-slot marker.
    await absent(await start(["--input-type=module", "-e", `
      const {startLifecycleServer} = await import(${JSON.stringify(join(repo, "tools/adt-lifecycle-server.mjs"))});
      await startLifecycleServer({port: Number(process.env.STG_PORT)});
    `], {OSD_HEAVY_SLOT: ""}));
    await waitFor(() => hostLog.includes("warm: primed"));
  });
  it("supervisor recovery builds active source and recycle keeps the published generation", async () => {
    runtime = new ServingRuntime({root, env: {STG_DB: "sqlite", STG_DB_PATH: "", OSD_ADT_ONE_RUNTIME: "1"}});
    runtime.storeDestination = new StoreDestination({store});
    await runtime.start(); await absent(runtime.url);
    await runtime.stop();
    runtime = new ServingRuntime({root, env: {STG_DB: "sqlite", STG_DB_PATH: "", OSD_ADT_ONE_RUNTIME: "1"}});
    runtime.storeDestination = new StoreDestination({store});
    await runtime.start(); await absent(runtime.url);
    store.served = runtime;
    store.write("CLAS", "ZCL_COLD_HOST", draft.replace("lv_undefined", "'published'"));
    const result = JSON.parse((await new StoreDestination({store}).execute({IV_COMMAND: "ACTIVATE",
      IV_TYPE: "CLAS", IV_NAME: "ZCL_COLD_HOST"})).EV_JSON);
    expect(result).to.include({state: "published", active: true, live: true});
    const response = await fetch(runtime.url + "/osd/classrun", {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({name: "ZCL_COLD_HOST"})});
    expect(response.status, await response.text()).to.equal(200);
  });
});
