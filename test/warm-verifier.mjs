import {expect} from "chai";
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {pathToFileURL} from "node:url";
import {generationIdentity, settleVerification, startVerification, VERIFY_HISTORY_LIMIT} from "../tools/osd-warm-verification.mjs";
import {verifyNext} from "../tools/osd-store-verify.mjs";
import {warmVerdict} from "../tools/osd-hot.mjs";
import {spawn} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {build, gc, layout, lock} from "../tools/osd-build.mjs";
import {WarmCompiler, warmRule} from "../tools/osd-warm.mjs";
import {WarmCompilerProcess} from "../tools/osd-warm-process.mjs";
import {closeWarm} from "../tools/osd-store-warm.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";
import {pinVerification, verificationPins} from "../tools/osd-verify-pin.mjs";
import {registryClass, transactions} from "../tools/osd-tran-registry.mjs";

const source = n => `CLASS zcl_guard DEFINITION PUBLIC CREATE PUBLIC. PUBLIC SECTION.
CLASS-METHODS get RETURNING VALUE(rv) TYPE i. ENDCLASS.
CLASS zcl_guard IMPLEMENTATION. METHOD get. rv = ${n}. ENDMETHOD. ENDCLASS.`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const bounded = (work, ms = 4000) => {
  let timer;
  return Promise.race([work, new Promise((_, reject) => { timer = setTimeout(() => reject(Error("test deadline exceeded")), ms); })])
    .finally(() => clearTimeout(timer));
};

describe("warm verifier settlement, lifetime and retained history (#625 round 7)", function () {
  this.timeout(15000);
  let root, compiler, store, hung;
  const input = () => join(root, "src", "zcl_guard.clas.abap");
  beforeEach(async () => {
    compiler = store = hung = undefined;
    root = mkdtempSync(join(tmpdir(), "osd-verifier-"));
    mkdirSync(join(root, "src"));
    writeFileSync(input(), source(1));
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: "src", output_folder: "output", libs: [],
      write_source_map: true, options: {ignoreSyntaxCheck: false, unknownTypes: "compileError"}}));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    await build({root, generators: false});
  });
  afterEach(async () => {
    if (hung?.exitCode === null && hung?.signalCode === null) {
      const exited = new Promise(resolve => hung.once("exit", resolve));
      hung.kill("SIGKILL"); await exited;
    }
    if (store) await closeWarm(store);
    await compiler?.shutdown?.();
    await compiler?.drop();
    rmSync(root, {recursive: true, force: true});
  });

  it("reaps a verifier that really never exits before priming and cold publication", async () => {
    store = new ObjectStore({root, roots: [{path: "src", writable: true}], libs: [], build: {generators: false}});
    store.warmState = {on: true}; store.warmVerifyDeadlineMs = 80; store.warmDeadlineMs = 10000;
    compiler = new WarmCompilerProcess({root}); store.warmState.compiler = compiler;
    hung = spawn(process.execPath, ["-e", "process.stdout.write('ready'); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio: ["ignore", "pipe", "pipe"]});
    await new Promise(resolve => hung.stdout.once("data", resolve));
    compiler.verifying = hung;
    const priming = store.warmUp();
    const publication = store.publish({force: true});
    await bounded(new Promise(resolve => hung.once("exit", resolve)), 1000);
    const result = await bounded(publication, 12000);
    await priming;
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(hung.signalCode).to.equal("SIGKILL");
    expect(store.warmState.priming).to.equal(undefined);
  });

  it("bounds pin acquisition while a real build lock remains busy", async () => {
    const hash = JSON.parse(readFileSync(join(root, "build", "live", "manifest.json"))).hash;
    const unlock = lock(layout(root));
    try {
      const error = await bounded(pinVerification(root, hash, "scratch", {deadlineMs: 60}).then(() => undefined, e => e), 1000);
      expect(error?.code).to.equal("VERIFY_TIMEOUT");
    } finally { unlock(); }
  });

  it("rejects adjacent INTERFACES edits that independently change the cold transaction registry", () => {
    const tran = join(root, "src", "zguard.tran.xml");
    writeFileSync(tran, `<abapGit><TSTC><TCODE>ZGUARD</TCODE></TSTC><TSTCP><PARAM>\\CLASS=ZCL_GUARD\\METHOD=GET</PARAM></TSTCP></abapGit>`);
    const before = source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. INTERFACES zif_marker.");
    const after = before.replace("INTERFACES zif_marker.", "INTERFACES zif_marker. INTERFACES zif_osd_transaction.");
    writeFileSync(input(), before);
    const coldBefore = registryClass(transactions([join(root, "src")]));
    writeFileSync(input(), after);
    const coldAfter = registryClass(transactions([join(root, "src")]));
    expect(coldAfter).to.not.equal(coldBefore);
    expect(warmRule({path: input(), before, after})).to.match(/INTERFACES/);
    expect(warmRule({path: input(), before: after, after: before})).to.match(/INTERFACES/);
  });

  it("guards the full INTERFACES statement across comment periods and literal periods", () => {
    writeFileSync(join(root, "src", "zguard.tran.xml"), `<abapGit><TSTC><TCODE>ZGUARD</TCODE></TSTC><TSTCP><PARAM>\\CLASS=ZCL_GUARD\\METHOD=GET</PARAM></TSTCP></abapGit>`);
    for (const comment of ['" comment with period. note', '\n* full-line comment with period. note']) {
      const before = source(1).replace("PUBLIC SECTION.", `PUBLIC SECTION. INTERFACES: zif_marker, ${comment}\n zif_one.`);
      const after = before.replace("zif_one.", "zif_one. INTERFACES zif_osd_transaction.");
      writeFileSync(input(), before); const first = registryClass(transactions([join(root, "src")]));
      writeFileSync(input(), after); const second = registryClass(transactions([join(root, "src")]));
      expect(second).to.not.equal(first);
      expect(warmRule({path: input(), before, after})).to.match(/INTERFACES/);
      expect(warmRule({path: input(), before, after: before.replace("zif_one", "zif_two")})).to.match(/INTERFACES/);
      expect(warmRule({path: input(), before, after: before.replace("period. note", "period. changed")})).to.match(/INTERFACES/);
    }
    for (const literal of ["'escaped '' period. INTERFACES zif_fake.'", "`escaped `` period. INTERFACES zif_fake.`", "|period. INTERFACES zif_fake.| "]) {
      const before = source(1).replace("PUBLIC SECTION.", `PUBLIC SECTION. CONSTANTS c TYPE string VALUE ${literal}.\n" leading comment.\n INTERFACES zif_one.`);
      expect(warmRule({path: input(), before, after: before.replace("zif_one", "zif_two")})).to.match(/INTERFACES/);
      // the cold generator matches raw text, literals included: conservative
      expect(warmRule({path: input(), before, after: before.replace("zif_fake", "zif_changed")})).to.match(/INTERFACES/);
    }
  });

  it("guards INTERFACES past a pragma holding a quote, and literal text the generator reads raw", () => {
    writeFileSync(join(root, "src", "zguard.tran.xml"), `<abapGit><TSTC><TCODE>ZGUARD</TCODE></TSTC><TSTCP><PARAM>\\CLASS=ZCL_GUARD\\METHOD=GET</PARAM></TSTCP></abapGit>`);
    const cases = [
      // a backtick inside pragma brackets opens no literal
      source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. CONSTANTS c TYPE i VALUE 1 ##NEEDED[`]. INTERFACES zif_one."),
      // the generator reads a literal's raw text
      source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. CONSTANTS c TYPE string VALUE `period. INTERFACES zif_one.`.\n INTERFACES: zif_marker."),
    ];
    for (const before of cases) {
      const after = before.replace("zif_one", "zif_osd_transaction");
      writeFileSync(input(), before); const first = registryClass(transactions([join(root, "src")]));
      writeFileSync(input(), after); const second = registryClass(transactions([join(root, "src")]));
      expect(second, before).to.not.equal(first);
      expect(warmRule({path: input(), before, after}), before).to.match(/INTERFACES/);
    }
    // a chained statement continued past the pragma's line changes the
    // interface list: refused (the generator does not read this form, the
    // compiled class does)
    const chained = source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. CONSTANTS c TYPE i VALUE 1 ##NEEDED[`]. INTERFACES: zif_marker,\n zif_one.");
    expect(warmRule({path: input(), before: chained, after: chained.replace("zif_one", "zif_two")})).to.match(/INTERFACES/);
    // the generator's match may span lines: a comment naming INTERFACES
    // above a data object renamed to the contract
    const spanning = source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. DATA zif_one TYPE i.\n DATA zif_osd_transaction TYPE i.\n METHODS m.")
      .replace(/(CLASS zcl_guard IMPLEMENTATION\.)/i, "$1\n METHOD m.\n \" INTERFACES\n zif_one = 1.\n ENDMETHOD.");
    const spanAfter = spanning.replace(" zif_one = 1.", " zif_osd_transaction = 1.");
    writeFileSync(input(), spanning); const spanFirst = registryClass(transactions([join(root, "src")]));
    writeFileSync(input(), spanAfter); const spanSecond = registryClass(transactions([join(root, "src")]));
    expect(spanSecond, "the generator reads the spanning match").to.not.equal(spanFirst);
    expect(warmRule({path: input(), before: spanning, after: spanAfter})).to.match(/INTERFACES/);
    // a method-body edit that touches no INTERFACES text stays warm
    const plain = source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. CONSTANTS c TYPE i VALUE 1 ##NEEDED[`].\n INTERFACES zif_one.");
    expect(warmRule({path: input(), before: plain, after: plain.replace("VALUE 1", "VALUE 2")})).to.equal(undefined);
  });

  it("retains a known mismatch past the settlement lock deadline and recovers cold", async () => {
    compiler = new WarmCompiler({root}); await compiler.prime();
    writeFileSync(input(), source(2)); const {hash} = await compiler.build();
    const generation = join(root, "build", "by-input", hash), side = `${generation}.warm.json`;
    writeFileSync(join(generation, "output", "zcl_guard.clas.mjs"), "// deliberately wrong");
    const {verifyGeneration} = await import("../tools/osd-warm-verify.mjs");
    const mismatch = await verifyGeneration(hash, root);
    expect(mismatch.verdict).to.equal("differs");
    const identity = generationIdentity(generation), unlock = lock(layout(root));
    compiler.settleDeadlineMs = 60;
    compiler.verify = async () => settleVerification(compiler, hash, identity, mismatch);
    const w = {on: true, compiler, next: new Set([hash])};
    let recovered = false;
    const host = {root, warm: () => w, publish: async options => {
      // Recovery must reach the publication path while the original lock is
      // still held. Release it here so the real cold build can take its turn.
      expect(existsSync(layout(root).lock)).to.equal(true);
      expect(JSON.parse(readFileSync(side, "utf8")).verified).to.equal(false);
      unlock(); recovered = true;
      return build({root, generators: false, ...options});
    }, warmUp: async () => compiler.prime()};
    try {
      verifyNext(host); await bounded(w.verifying);
      expect(w.last.verdict).to.equal("differs");
      expect(w.last.settlementError).to.match(/lock deadline/);
      expect(recovered).to.equal(true);
      expect(readFileSync(join(generation, "output", "zcl_guard.clas.mjs"), "utf8")).to.include("IntegerFactory.get(2)");
      expect(existsSync(side)).to.equal(false); // A cold publication needs no warm certification sidecar.
    } finally { if (!recovered) unlock(); }
  });

  it("stops pin renewal after an I/O error without losing the verifier", async () => {
    const hash = JSON.parse(readFileSync(join(root, "build", "live", "manifest.json"))).hash;
    const release = await pinVerification(root, hash, "scratch", {renewMs: 20});
    const pin = verificationPins(root)[0], original = fs.renameSync;
    let attempts = 0;
    fs.renameSync = function(from, to) {
      if (String(to).includes("verify-pins")) {
        attempts++; throw Object.assign(Error("injected renewal EIO"), {code: "EIO"});
      }
      return original.call(this, from, to);
    };
    syncBuiltinESMExports();
    try {
      await sleep(90);
      expect(attempts).to.equal(1);
      expect(verificationPins(root)).to.deep.equal([pin]);
      expect(fs.readdirSync(join(root, "build", "verify-pins"))).to.have.length(1);
    } finally { fs.renameSync = original; syncBuiltinESMExports(); release(); }
    expect(verificationPins(root)).to.deep.equal([]);
  });

  it("observes the worker verified IPC acknowledgement with disk pruning unavailable", async () => {
    const worker = join(root, "ack-worker.mjs"), messages = [];
    writeFileSync(worker, `import {WarmCompiler} from ${JSON.stringify(new URL("../tools/osd-warm.mjs", import.meta.url).href)};
import {main} from ${JSON.stringify(new URL("../tools/osd-warm-worker.mjs", import.meta.url).href)};
WarmCompiler.prototype.pruneVerification = () => {};
main();`);
    compiler = new WarmCompilerProcess({root, worker, onMessage: m => messages.push(m)});
    await compiler.prime();
    writeFileSync(input(), source(2)); const result = await compiler.build();
    expect((await compiler.verify(result.hash)).verdict).to.equal("same");
    await compiler.check({type: "CLAS", name: "ZCL_GUARD", source: source(2)});
    expect(messages.filter(m => m.type === "verified").map(m => m.hash)).to.deep.equal([result.hash]);
    expect(messages.filter(m => m.state).at(-1).state.unverified).to.deep.equal([]);
    expect(compiler.unverified.size).to.equal(0);
  });

  it("bounds compiler worker and parent history before any queue or GC pruning", async () => {
    const states = [];
    compiler = new WarmCompilerProcess({root, onMessage: m => { if (m.state) states.push(m.state); }});
    await compiler.prime();
    for (let n = 2; n < 10; n++) {
      writeFileSync(input(), source(n)); const {hash} = await compiler.build();
      expect(compiler.unverified.size).to.be.at.most(VERIFY_HISTORY_LIMIT);
      expect(states.at(-1).unverified.length).to.be.at.most(VERIFY_HISTORY_LIMIT);
      if (n % 2 === 0) {
        rmSync(join(root, "build", "by-input", hash, "compile-inputs.json"), {force: true});
        // Missing frozen compiler metadata is an actual inconclusive outcome.
        const result = await compiler.verify(hash);
        expect(result.verdict).to.equal("inconclusive");
      } else {
        compiler.verifyDeadlineMs = 1;
        expect((await compiler.verify(hash)).verdict).to.equal("cancelled");
        compiler.verifyDeadlineMs = 180000;
      }
      expect(compiler.unverified.size).to.be.at.most(VERIFY_HISTORY_LIMIT);
    }
    expect(compiler.unverified.size).to.equal(VERIFY_HISTORY_LIMIT);
  });

  it("bounds worker and parent history under queue drops without GC, preserving unchecked disk notes", async () => {
    const states = [], hashes = [];
    compiler = new WarmCompilerProcess({root, onMessage: m => { if (m.state) states.push(m.state); }});
    await compiler.prime();
    const w = {on: true, compiler, next: new Set(), verifying: Promise.resolve(), verifyingHash: "in-flight"};
    const host = {root, warm: () => w, served: {}};
    for (let n = 2; n < 12; n++) {
      writeFileSync(input(), source(n)); const result = await compiler.build();
      hashes.push(result.hash); host.served.generation = result.hash;
      w.next.add(result.hash); verifyNext(host);
      expect(w.next.size).to.be.at.most(2);
      expect(compiler.unverified.size).to.be.at.most(VERIFY_HISTORY_LIMIT);
      expect(states.at(-1).unverified.length).to.be.at.most(VERIFY_HISTORY_LIMIT);
    }
    await compiler.check({type: "CLAS", name: "ZCL_GUARD", source: source(11)});
    expect(compiler.unverified.size).to.be.at.most(2);
    expect(states.at(-1).unverified.length).to.be.at.most(2);
    for (const hash of hashes) {
      const generation = join(root, "build", "by-input", hash);
      expect(existsSync(join(generation, "manifest.json"))).to.equal(true);
      expect(warmVerdict(generation)).to.equal(false);
    }
    // A revisit uses the disk verdict after memory history was discarded.
    writeFileSync(input(), source(2));
    expect((await build({root, generators: false})).cached).to.equal(false);
    await compiler.drop(); expect(compiler.unverified.size).to.equal(0);
  });

  it("recovers unchecked status on a no-op revisit after history was discarded", async () => {
    compiler = new WarmCompilerProcess({root}); await compiler.prime();
    writeFileSync(input(), source(2)); const first = await compiler.build();
    compiler.retainVerification(new Set());
    await compiler.check({type: "CLAS", name: "ZCL_GUARD", source: source(2)});
    expect(compiler.unverified.size).to.equal(0);
    const again = await compiler.build();
    expect(again).to.include({hash: first.hash, cached: true, unverified: true});
    expect(compiler.unverified.has(first.hash)).to.equal(true);
  });

  it("settles cancellation after the front has removed its verification queue", async () => {
    const w = {on: true, next: new Set(["hash"]), compiler: {hash: "hash", retainVerification: () => {}, verify: async () => {
      w.next = undefined; w.on = false;
      return {verdict: "cancelled", why: "test complete"};
    }}};
    const host = {warm: () => w};
    verifyNext(host); await w.verifying;
    expect(w.verifying).to.equal(undefined);
    expect(w.last.verdict).to.equal("cancelled");
  });

  it("refuses a colon rewrite whose regenerated cold transaction registry differs", () => {
    writeFileSync(join(root, "src", "zguard.tran.xml"), `<abapGit><TSTC><TCODE>ZGUARD</TCODE></TSTC><TSTCP><PARAM>\\CLASS=ZCL_GUARD\\METHOD=GET</PARAM></TSTCP></abapGit>`);
    const before = source(1).replace("PUBLIC SECTION.", "PUBLIC SECTION. INTERFACES zif_marker. INTERFACES zif_osd_transaction.");
    const after = before.replace("INTERFACES zif_marker. INTERFACES zif_osd_transaction.", "INTERFACES: zif_marker, zif_osd_transaction.");
    writeFileSync(input(), before); const first = registryClass(transactions([join(root, "src")]));
    writeFileSync(input(), after); const second = registryClass(transactions([join(root, "src")]));
    expect(second).to.not.equal(first);
    expect(warmRule({path: input(), before, after})).to.match(/INTERFACES/);
    expect(warmRule({path: input(), before: after, after: before})).to.match(/INTERFACES/);
  });

  it("treats a malformed warm sidecar as unchecked and rebuilds cold", async () => {
    compiler = new WarmCompiler({root}); await compiler.prime();
    writeFileSync(input(), source(2)); const {hash} = await compiler.build();
    const generation = join(root, "build", "by-input", hash);
    writeFileSync(`${generation}.warm.json`, '{"verified":');
    writeFileSync(join(generation, "output", "zcl_guard.clas.mjs"), "// incorrect output");
    expect(warmVerdict(generation)).to.equal(false);
    const cold = await build({root, generators: false});
    expect(cold.cached).to.equal(false);
    expect(readFileSync(join(generation, "output", "zcl_guard.clas.mjs"), "utf8")).to.include("IntegerFactory.get(2)");
  });

  for (const verdict of ["same", "differs"]) {
    it(`supersedes ${verdict} when the sidecar is replaced with identical bytes`, async () => {
      compiler = new WarmCompiler({root}); await compiler.prime();
      writeFileSync(input(), source(2)); const {hash} = await compiler.build();
      const generation = join(root, "build", "by-input", hash), side = `${generation}.warm.json`;
      const identity = generationIdentity(generation), bytes = readFileSync(side), inode = statSync(side).ino;
      writeFileSync(`${side}.replacement`, bytes); renameSync(`${side}.replacement`, side);
      expect(statSync(side).ino).to.not.equal(inode);
      expect((await settleVerification(compiler, hash, identity, {verdict, differing: ["wrong.mjs"]})).verdict).to.equal("superseded");
      expect(readFileSync(side).equals(bytes)).to.equal(true);
      expect(compiler.unverified.has(hash)).to.equal(true);
    });
    it(`settles ${verdict} with the build lock held and an atomic sidecar rename`, async () => {
      compiler = new WarmCompiler({root}); await compiler.prime();
      writeFileSync(input(), source(2)); const {hash} = await compiler.build();
      const generation = join(root, "build", "by-input", hash), side = `${generation}.warm.json`;
      const identity = generationIdentity(generation), writes = [];
      const original = fs.writeFileSync;
      fs.writeFileSync = function(path, ...args) {
        if (String(path).startsWith(side)) {
          writes.push(String(path));
          let busy = false;
          try { const release = lock(layout(root)); release(); } catch (error) { busy = error.code === "BUSY"; }
          expect(busy, "settlement owns the build lock").to.equal(true);
          expect(JSON.parse(readFileSync(side, "utf8")).verified).to.equal(false);
        }
        return original.call(this, path, ...args);
      };
      syncBuiltinESMExports();
      try {
        expect((await settleVerification(compiler, hash, identity, {verdict, differing: ["zcl_guard.clas.mjs"]})).verdict).to.equal(verdict);
        expect(writes).to.have.length(1);
        expect(writes[0]).to.not.equal(side);
        expect(existsSync(writes[0])).to.equal(false);
        const note = JSON.parse(readFileSync(side, "utf8"));
        expect(note.verified).to.equal(verdict === "same");
        if (verdict === "differs") expect(note.differs).to.deep.equal(["zcl_guard.clas.mjs"]);
      } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
    });

    for (const replacement of ["vanished", "replaced"]) {
      it(`parent independently supersedes ${verdict} for a ${replacement} generation`, async () => {
        compiler = new WarmCompiler({root}); await compiler.prime();
        writeFileSync(input(), source(2)); const {hash} = await compiler.build();
        const generation = join(root, "build", "by-input", hash), side = `${generation}.warm.json`;
        const script = join(root, "verdict.mjs"), release = join(root, "release");
        writeFileSync(script, `import {existsSync} from 'node:fs';
while (!existsSync('release')) await new Promise(r => setTimeout(r, 10));
console.log(JSON.stringify({verdict: ${JSON.stringify(verdict)}, differing: ['wrong.mjs']}));`);
        const work = startVerification(compiler, hash, script);
        rmSync(generation, {recursive: true}); rmSync(side);
        if (replacement === "replaced") {
          mkdirSync(generation); writeFileSync(join(generation, "manifest.json"), JSON.stringify({hash}));
        }
        writeFileSync(release, "ready");
        const result = await bounded(work);
        expect(result.verdict).to.equal("superseded");
        expect(existsSync(side)).to.equal(false);
      });
    }
  }

  it("parent read failure after identity checking settles instead of rejecting or hanging", async () => {
    compiler = new WarmCompiler({root}); await compiler.prime();
    writeFileSync(input(), source(2)); const {hash} = await compiler.build();
    const generation = join(root, "build", "by-input", hash), side = `${generation}.warm.json`;
    const identity = generationIdentity(generation), original = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function(path, ...args) {
      if (String(path) === side && ++reads === 2) {
        throw Object.assign(Error("sidecar read failed after identity check"), {code: "EIO"});
      }
      return original.call(this, path, ...args);
    };
    syncBuiltinESMExports();
    try {
      const result = await bounded(settleVerification(compiler, hash, identity, {verdict: "same"}));
      expect(reads).to.equal(2);
      expect(result).to.include({verdict: "failed", why: "sidecar read failed after identity check"});
      expect(compiler.unverified.has(hash)).to.equal(true);
    } finally { fs.readFileSync = original; syncBuiltinESMExports(); }
    const unlock = lock(layout(root)); unlock();
  });

  it("GC removes orphan crash sidecars while preserving a pinned orphan", async () => {
    const paths = layout(root), orphan = join(paths.byInput, "orphan.warm.json"), pinned = join(paths.byInput, "pinned.warm.json");
    writeFileSync(orphan, '{"verified": false}'); writeFileSync(pinned, '{"verified": false}');
    const pins = join(paths.build, "verify-pins"); mkdirSync(pins);
    writeFileSync(join(pins, "live.json"), JSON.stringify({pid: process.pid, hash: "pinned", createdAt: Date.now()}));
    gc(root, {keep: 0});
    expect(existsSync(orphan)).to.equal(false);
    expect(existsSync(pinned)).to.equal(true);
  });

  it("allows a healthy real verifier past the short wait deadline with a separately configured lifetime", async () => {
    store = new ObjectStore({root, roots: [{path: "src", writable: true}], libs: [], build: {generators: false}});
    store.warmState = {on: true}; store.warmVerifyWaitMs = 80; store.warmVerifyLifetimeMs = 8000;
    compiler = new WarmCompilerProcess({root}); store.warmState.compiler = compiler;
    await store.warmUp();
    expect(compiler.verifyDeadlineMs).to.equal(8000);
    writeFileSync(input(), source(2)); const {hash} = await compiler.build();
    const preload = join(root, "slow.mjs"), ready = join(root, "ready"), release = join(root, "release");
    writeFileSync(preload, `import {modulesOf} from ${JSON.stringify(new URL("../tools/osd-transpile.mjs", import.meta.url).href)};
import {existsSync, writeFileSync} from 'node:fs';
if (process.argv[2] === 'verify') {
 const {Transpiler} = modulesOf(${JSON.stringify(root)}), run = Transpiler.prototype.run;
 Transpiler.prototype.run = async function(...args) {
  writeFileSync('ready', 'ready');
  while (!existsSync('release')) await new Promise(r => setTimeout(r, 10));
  return run.apply(this, args);
 };
}`);
    const previous = process.env.NODE_OPTIONS;
    process.env.NODE_OPTIONS = `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
    let work;
    try {
      work = compiler.verify(hash);
      for (let n = 0; n < 300 && !existsSync(ready); n++) await sleep(10);
      expect(existsSync(ready)).to.equal(true);
      await sleep(3 * store.warmVerifyWaitMs);
      expect(compiler.verifying?.signalCode).to.equal(null);
      writeFileSync(release, "resume");
      expect((await work).verdict).to.equal("same");
      expect(warmVerdict(join(root, "build", "by-input", hash))).to.equal(true);
    } finally {
      if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
      writeFileSync(release, "resume"); await work;
    }
  });

  it("requeues a real verifier cancelled by priming, leaving its disk hash unchecked until retry", async () => {
    store = new ObjectStore({root, roots: [{path: "src", writable: true}], libs: [], build: {generators: false}});
    compiler = new WarmCompilerProcess({root}); store.warmState = {on: true, compiler};
    store.warmVerifyWaitMs = 80; store.warmVerifyLifetimeMs = 8000;
    await store.warmUp(); writeFileSync(input(), source(2)); const {hash} = await compiler.build();
    const preload = join(root, "pause.mjs"), ready = join(root, "ready");
    writeFileSync(preload, `import {modulesOf} from ${JSON.stringify(new URL("../tools/osd-transpile.mjs", import.meta.url).href)};
import {writeFileSync} from 'node:fs';
if (process.argv[2] === 'verify') {
 const {Transpiler} = modulesOf(${JSON.stringify(root)});
 Transpiler.prototype.run = async function() { writeFileSync('ready', 'ready'); await new Promise(() => setInterval(() => {}, 1000)); };
}`);
    const previous = process.env.NODE_OPTIONS;
    try {
      process.env.NODE_OPTIONS = `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
      store.warmState.next = new Set([hash]); verifyNext(store);
      const first = store.warmState.verifying;
      for (let n = 0; n < 300 && !existsSync(ready); n++) await sleep(10);
      expect(existsSync(ready)).to.equal(true);
      if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
      const priming = store.warmUp();
      await first;
      expect(store.warmState.last.verdict).to.equal("cancelled");
      expect(store.warmState.next.has(hash)).to.equal(true);
      expect(warmVerdict(join(root, "build", "by-input", hash))).to.equal(false);
      await priming;
      while (store.warmState.verifying) await store.warmState.verifying;
      expect(store.warmState.last).to.include({hash, verdict: "same"});
      expect(warmVerdict(join(root, "build", "by-input", hash))).to.equal(true);
    } finally { if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous; }
  });

  it("GC removes unpinned warm sidecars along with their generations", async () => {
    compiler = new WarmCompiler({root}); await compiler.prime();
    writeFileSync(input(), source(2)); const old = (await compiler.build()).hash;
    writeFileSync(input(), source(3)); await compiler.build();
    const side = join(root, "build", "by-input", `${old}.warm.json`);
    expect(existsSync(side)).to.equal(true);
    expect(gc(root, {keep: 0})).to.include(old);
    expect(existsSync(side)).to.equal(false);
  });

  it("expires a stale pin even when its PID belongs to a live process and GC reaps scratch", async () => {
    const paths = layout(root), pins = join(paths.build, "verify-pins");
    mkdirSync(pins); mkdirSync(join(paths.tmp, "stale-scratch"), {recursive: true});
    const stale = join(pins, "stale.json");
    writeFileSync(stale, JSON.stringify({pid: process.pid, hash: "old", scratch: "stale-scratch", createdAt: Date.now() - 300001}));
    expect(verificationPins(root)).to.deep.equal([]);
    expect(existsSync(stale)).to.equal(false);
    gc(root, {keep: 0});
    expect(existsSync(join(paths.tmp, "stale-scratch"))).to.equal(false);
    const hash = JSON.parse(readFileSync(join(root, "build", "live", "manifest.json"))).hash;
    const release = await pinVerification(root, hash, "live-scratch");
    try { expect(verificationPins(root)).to.have.length(1); } finally { release(); }
  });
});

// A signal to the front used to reap only the compiler worker. The frozen-input
// verifier kept running after the front had exited and wrote into build/
// (lock, verify-pins, tmp) while the owner removed it: the ENOTEMPTY of
// test/vscode-warm-ready.mjs. The front now kills it and leaves after it exits.
describe("warm verifier on a signal to the front", function () {
  this.timeout(20000);
  it("kills the running verifier and exits only after it is gone", async () => {
    const script = `
      import {spawn} from "node:child_process";
      import {WarmCompiler} from ${JSON.stringify(pathToFileURL(resolve("tools/osd-warm.mjs")).href)};
      import {WarmCompilerProcess} from ${JSON.stringify(pathToFileURL(resolve("tools/osd-warm-process.mjs")).href)};
      import {exitHolds} from ${JSON.stringify(pathToFileURL(resolve("tools/osd-exit-holds.mjs")).href)};
      // a verifier that would outlive its front: it ignores SIGTERM
      WarmCompiler.prototype.verify = function () {
        const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"], {stdio: "ignore"});
        this.verifying = child;
        return new Promise(resolve => child.once("exit", () => resolve({verdict: child.osdCancelled ? "cancelled" : "failed", why: child.osdCancelled})));
      };
      // the supervisor's handler, as tools/osd-runtime.mjs has it
      process.on("SIGTERM", async () => { await exitHolds(); process.exit(0); });
      const compiler = new WarmCompilerProcess({root: process.cwd()});
      compiler.verify("0123456789abcdef");
      console.log(JSON.stringify({verifier: compiler.verifying.pid}));
      setTimeout(() => process.kill(process.pid, "SIGTERM"), 200);
    `;
    const front = spawn(process.execPath, ["--input-type=module", "-e", script], {stdio: ["ignore", "pipe", "inherit"]});
    let out = "";
    front.stdout.on("data", d => { out += d; });
    const code = await bounded(new Promise(resolve => front.once("exit", resolve)), 15000);
    const lines = out.trim().split("\n").map(line => JSON.parse(line));
    const pid = lines[0].verifier;
    let alive = true;
    try { process.kill(pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
    if (alive) process.kill(pid, "SIGKILL");
    expect(code).to.equal(0);
    expect(alive, "the verifier outlived the front").to.equal(false);
  });
});
