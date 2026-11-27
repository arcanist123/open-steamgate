// Deterministic compiler IPC races and failures, over real built generations.
import {expect} from "chai";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {pathToFileURL} from "node:url";
import {ObjectStore} from "../tools/osd-store.mjs";
import {WarmCompilerProcess} from "../tools/osd-warm-process.mjs";
import {closeWarm, warmOperation} from "../tools/osd-store-warm.mjs";
import {verifyNext} from "../tools/osd-store-verify.mjs";
import {sendIPC} from "../tools/osd-ipc.mjs";
import {EventEmitter} from "node:events";

const source = (name, n) => `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.
 PUBLIC SECTION.
 CLASS-METHODS v RETURNING VALUE(rv) TYPE i.
ENDCLASS.
CLASS ${name} IMPLEMENTATION.
 METHOD v.
 rv = ${n}.
 ENDMETHOD.
ENDCLASS.\n`;
const repo = resolve(".");
const sleep = ms => new Promise(r => setTimeout(r, ms));

describe("warm compiler process: source isolation and bounded cold fallback", function () {
  this.timeout(30000);
  let root, store, compiler, child, paused, environment;
  const mode = text => writeFileSync(join(root, "control"), text);
  const out = name => readFileSync(join(root, "output", `${name}.clas.mjs`), "utf8");
  const save = (name, n) => store.write("CLAS", name.toUpperCase(), source(name, n));
  const activate = () => store.publish({activate: [{type: "CLAS", name: "ZCL_A"}]});
  const waitPaused = async () => {
    for (let i = 0; i < 200 && !paused; i++) await sleep(10);
    expect(paused, "worker reached the dispatch/hash pause").to.equal(true);
  };
  // A save while the compiler is paused must not wait for it. The store API
  // is synchronous unless a source-lock turn is held (tools/osd-store-source-lock.mjs),
  // and then it returns a promise that settles only after that turn. The
  // worker stays paused until the test resumes it, so a save that has to wait
  // for the compile can never settle here: "returned synchronously" is the
  // event, independent of the machine's speed. The 200 ms budget is CPU time,
  // what the save's own code spends: its wall time is mostly fsync
  // (tools/osd-durable.mjs), and on a shared 4-core host the first save after
  // a publication took 0.3-1.3 s of wall time for 1-3 ms of CPU.
  const saveWhilePaused = (name, n, what) => {
    const cpu = process.cpuUsage();
    const result = save(name, n);
    const spent = process.cpuUsage(cpu);
    const ms = (spent.user + spent.system) / 1000;
    expect(result instanceof Promise, `save of ${name} waited for ${what}`).to.equal(false);
    expect(ms, `CPU time of a save during ${what}`).to.be.lessThan(200);
    return result;
  };
  const gone = () => {
    expect(child?.exitCode !== null || child?.signalCode !== null, "compiler was reaped before fallback returned").to.equal(true);
  };
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "osd-warm-ipc-"));
    writeFileSync(join(root, "abaplint.jsonc"), JSON.stringify({syntax: {version: "OpenABAP"}}));
    mkdirSync(join(root, "src", "demo"), {recursive: true});
    writeFileSync(join(root, "src", "demo", "package.devc.xml"), "<abapGit><asx:abap><asx:values><DEVC><CTEXT>demo</CTEXT></DEVC></asx:values></asx:abap></abapGit>");
    for (const name of ["zcl_a", "zcl_b"]) writeFileSync(join(root, "src", `${name}.clas.abap`), source(name, 1));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: "src", input_filter: [], output_folder: "output", libs: [], write_unit_tests: true, write_source_map: true,
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }));
    writeFileSync(join(root, "package.json"), "{}");
    symlinkSync(join(repo, "node_modules"), join(root, "node_modules"));
    mode("normal");
    const worker = join(root, "worker.mjs");
    writeFileSync(worker, `import {main} from ${JSON.stringify(pathToFileURL(join(repo, "tools/osd-warm-worker.mjs")).href)};
import {readFileSync} from "node:fs";
import {sendIPC} from ${JSON.stringify(pathToFileURL(join(repo, "tools/osd-ipc.mjs")).href)};
main({heapLimit: ${512 * 1048576}, beforeCompile: async ({method}) => {
 sendIPC(process, {type: "environment", credentials: ["OSD_ADT_TOKEN", "OSD_BATCH_READ_TOKEN", "PGPASSWORD", "HANA_PASSWORD", "FIXTURE_SECRET"]
  .filter(key => process.env[key] !== undefined), root: process.env.OSD_ROOT, path: process.env.PATH});
 const mode = readFileSync("control", "utf8");
 if (mode === "hang-" + method) { sendIPC(process, {type: "paused"}); while (true) {} }
 if (mode === "exit-" + method) process.exit(23);
 if (mode === "disconnect-" + method) {
  process.removeAllListeners("disconnect"); process.disconnect();
  await new Promise(() => setInterval(() => {}, 1000));
 }
 if (mode === "pause-" + method) {
  sendIPC(process, {type: "paused"});
  await new Promise(resolve => process.once("message", resolve));
 }
}, afterCompile: async ({method}) => {
 if (readFileSync("control", "utf8") === "pause-finished-" + method) {
  sendIPC(process, {type: "paused"});
  await new Promise(resolve => process.once("message", resolve));
 }
}});`);
    store = new ObjectStore({root, roots: [{path: "src", writable: true}], libs: [], build: {generators: false}});
    expect((await store.publish()).ok).to.equal(true);
    paused = false; child = undefined;
    compiler = new WarmCompilerProcess({root, worker,
      overlay: s => store.overlay(s), keyOf: f => store.objectKeyOf(f), inactiveSources: s => store.inactiveSources(s),
      onMessage: (message, process) => { child = process; if (message.type === "paused") paused = true;
        if (message.type === "environment") environment = message; },
    });
    store.warmState = {on: true, compiler};
    expect(await store.warmUp()).to.not.equal(undefined, store.warmState.reason);
  });
  afterEach(async () => { await closeWarm(store); rmSync(root, {recursive: true, force: true}); });

  it("primes through osd-host without inheriting bridge, database or arbitrary secrets", async () => {
    await compiler.drop();
    const keys = ["OSD_ADT_TOKEN", "OSD_BATCH_READ_TOKEN", "PGPASSWORD", "HANA_PASSWORD", "FIXTURE_SECRET"];
    const previous = keys.map(key => process.env[key]);
    try {
      for (const key of keys) process.env[key] = "fixture-secret";
      environment = undefined;
      expect(await store.warmUp()).to.not.equal(undefined, store.warmState.reason);
      expect(environment).to.include({root, path: process.env.PATH});
      expect(environment.credentials).to.deep.equal([]);
    } finally {
      keys.forEach((key, i) => { if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i]; });
    }
  });

  it("keeps one prime through create, cold publication, and edits of new and existing classes", async () => {
    const logs = [];
    compiler.log = text => logs.push(text);
    const coldStart = performance.now();
    await store.create("CLAS", "ZCL_NEW", {package: "$STG_DEMO", source: source("zcl_new", 1)});
    const created = store.warmActivation("CLAS", "ZCL_NEW");
    const cold = await store.publish({activate: [{type: "CLAS", name: "ZCL_NEW"}]});
    expect(store.completeActivation(created, cold.transpile.built)).to.equal(true);
    expect(cold.ok, JSON.stringify(cold)).to.equal(true);
    expect(cold.transpile.warm).to.not.equal(true);
    expect(compiler.primed).to.equal(true);
    expect(store.warmState.primeDue).to.equal(false);
    expect(logs.some(line => line.includes("warm: updated")), logs.join("\n")).to.equal(true);
    for (const name of ["zcl_new", "zcl_a"]) {
      await save(name, 4);
      const checked = store.warmActivation("CLAS", name.toUpperCase());
      const next = await store.publish({activate: [{type: "CLAS", name: name.toUpperCase()}]});
      expect(store.completeActivation(checked, next.transpile.built)).to.equal(true);
      expect(next.ok, JSON.stringify(next)).to.equal(true);
      expect(next.transpile.warm).to.equal(true);
      expect(next.transpile.superseded).to.equal(0);
      expect(out(name)).to.include("IntegerFactory.get(4)");
      expect((await compiler.verify(next.transpile.hash)).verdict).to.equal("same");
      console.log(`create/edit loop: ${name} warm ${next.transpile.ms} ms`);
    }
    expect(logs.filter(line => line.includes("warm: primed") || line.includes("warm: re-prime"))).to.deep.equal([]);
    console.log(`create/edit loop including cold and two verifications: ${(performance.now() - coldStart).toFixed(0)} ms`);
  });

  it("logs a re-prime for a config/layer change and warms the next edit", async () => {
    const logs = [];
    compiler.log = text => logs.push(text);
    mkdirSync(join(root, "layer"));
    writeFileSync(join(root, "layer", "zcl_layer.clas.abap"), source("zcl_layer", 1));
    const path = join(root, "abap_transpile.json");
    const config = JSON.parse(readFileSync(path, "utf8"));
    config.input_folder = ["src", "layer"];
    writeFileSync(path, JSON.stringify(config));
    const cold = await store.publish();
    expect(cold.ok, JSON.stringify(cold)).to.equal(true);
    expect(logs.join("\n")).to.include("warm: re-prime: the config changed");
    expect(compiler.primed).to.equal(false);
    expect(store.warmState.primeDue).to.equal(true);
    await save("zcl_a", 5);
    const next = await activate();
    expect(next.ok).to.equal(true);
    expect(next.transpile.warm).to.equal(true);
    expect(logs.filter(line => line.includes("warm: primed"))).to.have.length(1);
  });

  it("finishes mismatch recovery with a ready compiler and warms the next activation", async () => {
    await save("zcl_a", 2);
    const activation = store.warmActivation("CLAS", "ZCL_A");
    const warm = await activate();
    expect(store.completeActivation(activation, warm.transpile.built)).to.equal(true);
    const hash = warm.transpile.hash;
    writeFileSync(join(root, "build", "by-input", hash, "output", "zcl_a.clas.mjs"), "// deliberate mismatch\n");
    store.warmState.next = new Set([hash]);
    verifyNext(store);
    await store.warmState.verifying;
    expect(store.warmState.last.verdict).to.equal("differs");
    expect(out("zcl_a")).to.include("IntegerFactory.get(2)");
    expect(compiler.primed, "recovery includes priming, without another activation or a timer").to.equal(true);
    await save("zcl_a", 3);
    const next = await activate();
    expect(next.ok, JSON.stringify(next)).to.equal(true);
    expect(next.transpile.warm).to.equal(true);
    expect((await compiler.verify(next.transpile.hash)).verdict).to.equal("same");
  });

  it("finishes a frozen comparison before bounded priming and resumes queued verification afterwards", async () => {
    await compiler.drop();
    const verifier = Object.assign(new EventEmitter(), {exitCode: null});
    compiler.verifying = verifier;
    let compares = 0;
    compiler.verify = async () => { compares++; return {verdict: "same", files: 0, ms: 0}; };
    const priming = store.warmUp();
    const hash = store.served?.generation ?? compiler.hash;
    store.warmState.next = new Set([hash]);
    verifyNext(store);
    await sleep(20);
    expect(compiler.primed).to.equal(false);
    expect(compares).to.equal(0);
    expect(store.warmState.next.has(hash)).to.equal(true);
    // A save can finish while the background work yields; prime then sees
    // the active copy rather than certifying the newly saved draft.
    await save("zcl_a", 12);
    compiler.verifying = undefined;
    verifier.exitCode = 0;
    verifier.emit("exit", 0);
    expect(await priming, store.warmState.reason).to.not.equal(undefined);
    await store.warmState.verifying;
    expect(compiler.primed).to.equal(true);
    expect(compares).to.equal(1);
    expect(store.warmState.last).to.include({hash, verdict: "same"});
    expect((await activate()).transpile.warm).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(12)");
  });

  it("ignores a retired child's late IPC failure while its replacement is priming", async () => {
    const retired = child;
    await compiler.drop();
    paused = false;
    mode("pause-finished-prime");
    const priming = store.warmUp();
    await waitPaused();
    const replacement = child;
    expect(replacement).to.not.equal(retired);
    // Close and disconnect are separate events; either can be delivered
    // after a drop and must reject only that child's requests.
    retired.emit("disconnect");
    mode("normal");
    sendIPC(replacement, {resume: true});
    expect(await priming, store.warmState.reason).to.not.equal(undefined);
    expect(compiler.primed).to.equal(true);
    expect(store.warmState.disabled).to.not.equal(true);
  });

  it("discarding a busy baseline requests cold fallback without disabling its replacement", async () => {
    mode("pause-build");
    const building = warmOperation(store, () => compiler.build()).catch(error => error);
    await waitPaused();
    await compiler.drop();
    expect((await building).code).to.equal("NOT_WARM");
    expect(store.warmState.disabled).to.not.equal(true);
    mode("normal");
    expect(await store.warmUp(), store.warmState.reason).to.not.equal(undefined);
    expect(compiler.primed).to.equal(true);
    await save("zcl_a", 2);
    expect((await activate()).transpile.warm).to.equal(true);
  });

  it("saves an unrelated object within 200 ms after dispatch, before hashing; B stays inactive", async () => {
    await save("zcl_a", 2);
    const checked = store.warmActivation("CLAS", "ZCL_A");
    mode("pause-build");
    const publishing = activate();
    await waitPaused();
    saveWhilePaused("zcl_b", 20, "a paused build");
    const beforeResume = store.read("CLAS", "ZCL_B").source;
    mode("normal");
    sendIPC(child, {method: "resume"});
    const result = await publishing;
    expect(result).to.include({ok: true});
    expect(result.transpile.warm).to.equal(true);
    expect(store.completeActivation(checked, result.transpile.built)).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(2)");
    expect(out("zcl_b"), "an unrelated save must never enter A's live generation").to.include("IntegerFactory.get(1)").and.not.include("get(20)");
    expect(beforeResume).to.include("rv = 20.");
    expect(store.stateOf(store.find("CLAS", "ZCL_B")).version).to.equal("inactive");
    // The superseded dispatch was discarded; only the current isolated view is certified.
    expect(result.transpile.superseded).to.equal(1);
    expect((await compiler.verify(result.transpile.hash)).verdict).to.equal("same");
    mode("normal");
    const b = await store.publish({activate: [{type: "CLAS", name: "ZCL_B"}]});
    expect(b.ok).to.equal(true);
    expect(out("zcl_b")).to.include("IntegerFactory.get(20)");
    expect((await compiler.verify(b.transpile.hash)).verdict).to.equal("same");
  });


  it("saves within 200 ms during priming and catches up before warm becomes available", async () => {
    await compiler.drop();
    mode("pause-prime"); paused = false;
    const priming = store.warmUp();
    await waitPaused();
    saveWhilePaused("zcl_a", 7, "a paused prime");
    expect(out("zcl_a")).to.include("IntegerFactory.get(1)");
    mode("normal"); sendIPC(child, {method: "resume"});
    expect(await priming).to.not.equal(undefined, store.warmState.reason);
    expect(compiler.primed).to.equal(true);
    const result = await activate();
    expect(result.ok).to.equal(true);
    expect(result.transpile.warm).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(7)");
  });

  it("supersedes a changed compile input and recompiles without publishing stale bytes", async () => {
    await save("zcl_a", 2);
    mode("pause-build");
    const publishing = activate();
    await waitPaused();
    saveWhilePaused("zcl_a", 8, "a paused build");
    expect(out("zcl_a")).to.include("IntegerFactory.get(1)");
    mode("normal"); sendIPC(child, {method: "resume"});
    const result = await publishing;
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.transpile.superseded).to.equal(1);
    expect(out("zcl_a")).to.include("IntegerFactory.get(8)").and.not.include("get(2)");
  });

  it("saves within 200 ms during a cold compile, discards its result and retries", async () => {
    let release, reached;
    const pausedBuild = new Promise(r => { reached = r; });
    const gate = new Promise(r => { release = r; });
    let builds = 0;
    store.buildOptions.onStep = async () => { if (++builds === 1) { reached(); await gate; } };
    await save("zcl_a", 2);
    const publishing = store.publish({force: true, activate: [{type: "CLAS", name: "ZCL_A"}]});
    await pausedBuild;
    try {
      saveWhilePaused("zcl_a", 9, "a paused cold compile");
      expect(out("zcl_a")).to.include("IntegerFactory.get(1)");
    } finally { release(); }
    const result = await publishing;
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.transpile.superseded).to.equal(1);
    expect(builds).to.equal(2);
    expect(out("zcl_a")).to.include("IntegerFactory.get(9)").and.not.include("get(2)");
  });

  it("rejects a completed warm generation if a save lands before publication", async () => {
    await save("zcl_a", 2);
    mode("pause-finished-build");
    const publishing = activate();
    await waitPaused();
    saveWhilePaused("zcl_a", 10, "a finished build before its publication");
    saveWhilePaused("zcl_b", 20, "a finished build before its publication");
    expect(out("zcl_a")).to.include("IntegerFactory.get(1)");
    let release, reached;
    const gate = new Promise(r => { release = r; });
    const retry = new Promise(r => { reached = r; });
    store.buildOptions.onStep = async () => { reached(); await gate; };
    mode("normal"); sendIPC(child, {method: "resume"});
    await retry;
    expect(out("zcl_a"), "the superseded warm generation was never made live").to.include("IntegerFactory.get(1)");
    expect(out("zcl_b")).to.include("IntegerFactory.get(1)");
    release();
    const result = await publishing;
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.transpile.superseded).to.equal(1);
    expect(out("zcl_a")).to.include("IntegerFactory.get(10)").and.not.include("get(2)");
    expect(out("zcl_b")).to.include("IntegerFactory.get(1)").and.not.include("get(20)");
  });

  it("catches up a prime whose frozen inputs were already loaded when the save landed", async () => {
    await compiler.drop(); paused = false;
    mode("pause-finished-prime");
    const priming = store.warmUp();
    await waitPaused();
    saveWhilePaused("zcl_a", 11, "a loaded, paused prime");
    mode("normal"); sendIPC(child, {method: "resume"});
    expect(await priming).to.not.equal(undefined, store.warmState.reason);
    expect(compiler.primed).to.equal(true);
    const result = await activate();
    expect(result.ok).to.equal(true);
    expect(result.transpile.warm).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(11)");
  });

  it("kills and awaits a hung mid-prime child, activates cold within the deadline, and leaves subsequent publications available", async () => {
    // Re-prime the running child rather than a fresh one: the deadline is
    // counted from dispatch, and a fresh worker spends ~600 ms starting and
    // loading the compiler before it can reach the hang, so a 500 ms
    // deadline killed it there and the pause was never reported. The hang
    // under test is the prime itself; start-up is not what it bounds.
    await save("zcl_a", 3);
    mode("hang-prime");
    store.warmDeadlineMs = 500;
    const priming = store.warmUp();
    await waitPaused();
    const started = performance.now();
    const result = await activate();
    await priming;
    expect(performance.now() - started).to.be.lessThan(5000);
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.transpile.warm).to.not.equal(true);
    expect(store.warmState.disabled).to.equal(true);
    expect(store.warmState.reason).to.include("exceeded 500 ms");
    gone();
    await save("zcl_a", 4);
    expect((await activate()).ok).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(4)");
    console.log(`hung prime: cold activation ${(performance.now() - started).toFixed(0)} ms including the subsequent publication`);
  });

  it("lets a save stop waiting for a slow prime and build cold, leaving the prime running", async () => {
    // The prime's own deadline is long (a whole tree on a slow host); the
    // save's wait for it is bounded on its own (tools/warm-deadline/).
    await save("zcl_a", 3);
    mode("hang-prime");
    store.warmDeadlineMs = 60000;
    store.warmSaveWaitMs = 500;
    const priming = store.warmUp();
    await waitPaused();
    const started = performance.now();
    const result = await activate();
    expect(performance.now() - started).to.be.lessThan(5000);
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.transpile.warm).to.not.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(3)");
    expect(store.warmState.disabled, "a slow prime is not a dead compiler").to.not.equal(true);
    expect(store.warmState.priming, "the prime goes on").to.equal(priming);
    // the next save does not wait the bound again for the same prime
    await save("zcl_a", 4);
    const again = performance.now();
    expect((await activate()).ok).to.equal(true);
    expect(performance.now() - again).to.be.lessThan(store.warmSaveWaitMs + 4000);
    expect(out("zcl_a")).to.include("IntegerFactory.get(4)");
    await closeWarm(store);
  });

  it("reaps a compiler that exceeds its own heap growth limit, retaining the published warm generation", async () => {
    await compiler.drop();
    const worker = join(root, "worker.mjs");
    writeFileSync(worker, readFileSync(worker, "utf8").replace("heapLimit: 536870912", "heapLimit: -1e12"));
    await store.warmUp();
    let swapVerified, scheduled;
    store.served = {running: true, generation: compiler.hash, swaps: 0, async hot(options) {
      swapVerified = options.verified;
      this.generation = options.generation;
      return {hot: true, generation: options.generation, ms: 1, heaps: [1]};
    }};
    const verify = compiler.verify.bind(compiler);
    compiler.verify = hash => { scheduled = hash; return verify(hash); };
    await save("zcl_a", 6);
    const checked = store.warmActivation("CLAS", "ZCL_A");
    const result = await activate();
    expect(result.ok).to.equal(true);
    expect(result.transpile.warm).to.equal(true);
    expect(result.transpile.unverified).to.equal(true);
    expect(swapVerified, "runtime must be told this generation is unchecked").to.equal(false);
    expect(scheduled, "comparison must be scheduled after compiler recycling").to.equal(result.transpile.hash);
    await store.warmState.verifying;
    expect(store.warmState.last.verdict).to.equal("same");
    expect(compiler.recycleDue).to.equal(true);
    expect(compiler.primed).to.equal(false);
    expect(compiler.memory.rss).to.be.greaterThan(0);
    expect(store.warmState.primeDue).to.equal(true);
    gone();
    expect(out("zcl_a")).to.include("IntegerFactory.get(6)");
    expect(store.completeActivation(checked, result.transpile.built)).to.equal(true);
    // Direct compiler users need readiness again after recycling. The ADT
    // publication path instead primes on demand, under its bounded deadline.
    const error = await compiler.build().then(() => undefined, error => error);
    expect(error).to.include({code: "NOT_WARM", message: "not primed"});
    await save("zcl_a", 7);
    const next = await activate();
    expect(next.ok, JSON.stringify(next)).to.equal(true);
    expect(next.transpile.warm).to.equal(true);
    expect(out("zcl_a")).to.include("IntegerFactory.get(7)");
  });

  for (const fault of ["exit", "disconnect"]) {
    it(`falls back cold after compiler ${fault} during a build, reaping the child first`, async () => {
      mode(`${fault}-build`);
      store.warmDeadlineMs = 2000;
      await save("zcl_a", 5);
      const started = performance.now();
      const result = await activate();
      expect(result.ok, JSON.stringify(result)).to.equal(true);
      expect(result.transpile.warm).to.not.equal(true);
      expect(store.warmState.disabled).to.equal(true);
      gone();
      expect(out("zcl_a")).to.include("IntegerFactory.get(5)");
      expect(performance.now() - started).to.be.lessThan(5000);
    });
  }
});
