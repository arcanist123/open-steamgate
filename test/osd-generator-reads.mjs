import {expect} from "chai";
import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {closeSync, existsSync, mkdirSync, mkdtempSync, openSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {runGeneratorsOf} from "../tools/osd-build-generators.mjs";
import {inspectReadRecord, makeReadRecord, markIncomplete, privacyNow, readGeneratorLog, READS, withSeedReads} from "../tools/osd-read-record.mjs";

// A synthetic generator: one road from node:fs to the bytes of a private
// tree per run, each copying or reading into gen/ the way a real one would.
const GENERATOR = `
import fs, {readFileSync, createReadStream, openSync, readSync, closeSync, copyFileSync, cpSync, linkSync, symlinkSync, renameSync, readdirSync, existsSync, statSync, writeFileSync} from "node:fs";
import {fork, spawn, spawnSync, execFileSync} from "node:child_process";
import {Worker} from "node:worker_threads";
import {readFile, open, copyFile, cp} from "node:fs/promises";
import {resolve} from "node:path";
import {pathToFileURL} from "node:url";
const [api] = process.argv.slice(2);
const one = "vault/zsentinel.txt", dir = "vault/dir", out = "gen/" + api;
const roads = {
  readFileSyncUrl: () => readFileSync(pathToFileURL(one)),
  readFileSyncBuffer: () => readFileSync(Buffer.from(one)),
  readFileCallback: () => new Promise((ok, no) => fs.readFile(one, "utf8", e => e ? no(e) : ok())),
  fsPromisesReadFile: () => fs.promises.readFile(one),
  fsPromisesModule: () => readFile(one, "utf8"),
  createReadStream: () => new Promise((ok, no) => createReadStream(one).on("data", () => {}).on("end", ok).on("error", no)),
  openSyncReadSync: () => { const fd = openSync(one, "r"); readSync(fd, Buffer.alloc(8)); closeSync(fd); },
  promisesOpen: async () => { const handle = await open(one); await handle.read(Buffer.alloc(8)); await handle.close(); },
  copyFileSync: () => copyFileSync(one, out),
  copyFileCallback: () => new Promise((ok, no) => fs.copyFile(one, out, e => e ? no(e) : ok())),
  promisesCopyFile: () => copyFile(one, out),
  cpSync: () => cpSync(dir, out, {recursive: true}),
  cpCallback: () => new Promise((ok, no) => fs.cp(dir, out, {recursive: true}, e => e ? no(e) : ok())),
  promisesCp: () => cp(dir, out, {recursive: true}),
  linkSync: () => linkSync(one, out),
  symlinkSync: () => symlinkSync(resolve(one), out),
  renameSync: () => renameSync("vault/zmove.txt", out),
  // (6) links under excluded prefixes, into a private tree outside and inside the root
  genLinkOutside: () => readFileSync("gen/zlinked.txt"),
  toolsLinkInside: () => readFileSync("tools/zlinked.txt"),
  // (3) names only, never bytes
  listPrivate: () => writeFileSync(out, readdirSync("vault").join(",")),
  existsPrivate: () => writeFileSync(out, String(existsSync("vault/zprobe.txt"))),
  statPrivate: () => writeFileSync(out, String(statSync("vault/zsentinel.txt").size)),
  listPublic: () => writeFileSync(out, readdirSync("open").join(",")),
  // (2) child processes
  nodeChild: () => spawnSync(process.execPath, ["-e", "require('fs').readFileSync('vault/zsentinel.txt')"], {stdio: "inherit"}),
  nodeChildAsync: () => new Promise(ok => spawn(process.execPath, ["-e", "require('fs').readFileSync('vault/zsentinel.txt')"]).on("exit", ok)),
  nodeChildOwnEnv: () => spawnSync(process.execPath, ["-e", "require('fs').readFileSync('vault/zsentinel.txt')"], {env: {PATH: process.env.PATH, OSD_ROOT: "/nonexistent"}}),
  catChild: () => spawnSync("cat", ["vault/zsentinel.txt"]),
  gitMetadata: () => execFileSync("git", ["rev-parse", "--show-toplevel"], {stdio: "pipe"}),
  gitListPrivate: () => execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "vault"], {stdio: "pipe"}),
  gitShow: () => spawnSync("git", ["show", "HEAD:open/zpublic.txt"]),
  worker: () => new Promise(ok => new Worker("1", {eval: true}).on("exit", ok)),
  // (r5 MUST 3) a preload runs before the recorder's --import
  requirePreload: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["--require", "./open/zbefore.cjs", "-e", "0"]); },
  requirePreloadEnv: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["-e", "0"], {env: {...process.env, NODE_OPTIONS: "--require ./open/zbefore.cjs " + (process.env.NODE_OPTIONS ?? "")}}); },
  forkPreload: () => new Promise(ok => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); writeFileSync("open/zchild.cjs", ""); fork("./open/zchild.cjs", [], {execArgv: [...process.execArgv, "--require", "./open/zbefore.cjs"]}).on("exit", ok); }),
  forkPlain: () => new Promise(ok => { writeFileSync("open/zchild.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); fork("./open/zchild.cjs").on("exit", ok); }),
  envFilePreload: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); writeFileSync("open/zpre.env", "NODE_OPTIONS=--require ./open/zbefore.cjs"); spawnSync(process.execPath, ["--env-file=open/zpre.env", "-e", "0"]); },
  nodeRun: () => { writeFileSync("open/package.json", JSON.stringify({scripts: {zleak: "cat ../vault/zsentinel.txt"}})); spawnSync(process.execPath, ["--run", "zleak"], {cwd: "open"}); },
  // (r6 3a) a value-taking flag ahead of the preload
  redirectWarnings: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["--redirect-warnings", "open/zwarn.log", "--require", "./open/zbefore.cjs", "-e", "0"]); },
  // (r6 3b) osd itself as the child, with a preload in NODE_OPTIONS
  selfHostile: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); const self = JSON.parse(process.env.OSD_SELF);
    spawnSync(self[0], [...self.slice(1), "gen", "zgen.mjs", "listPublic"], {env: {...process.env, NODE_OPTIONS: "--require ./open/zbefore.cjs " + (process.env.NODE_OPTIONS ?? "")}}); },
  quotedPreload: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["-e", "0"], {env: {...process.env, NODE_OPTIONS: '--require "./open/zbefore.cjs" ' + (process.env.NODE_OPTIONS ?? "")}}); },
  requireAfterEval: () => { writeFileSync("open/zbefore.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["-e", "0", "--require", "./open/zbefore.cjs"]); },
  scriptArgRequire: () => { writeFileSync("open/zscript.cjs", "require('fs').readFileSync('vault/zsentinel.txt')"); spawnSync(process.execPath, ["./open/zscript.cjs", "--require", "x"]); },
  // (D) a file written by the generator, then read back, is derived
  ownCache: () => { writeFileSync("open/zcache.tmp", "derived"); renameSync("open/zcache.tmp", "open/zcache.bin"); readFileSync("open/zcache.bin"); },
  oldThenOverwrite: () => { readFileSync("open/zpublic.txt"); writeFileSync("open/zpublic.txt", "rewritten"); readFileSync("open/zpublic.txt"); },
  // (S3) an append keeps the source's bytes: still a source, not derived
  appendThenRead: () => { fs.appendFileSync(one, "appended"); readFileSync(one); },
  openAppendThenRead: () => { closeSync(openSync(one, "a")); readFileSync(one); },
  promisesAppendThenRead: async () => { await fs.promises.appendFile(one, "appended"); readFileSync(one); },
  // (S4) a plain read of a private file outside the root, by its real path
  outsidePrivate: () => readFileSync(process.env.OSD_TEST_OUTSIDE),
};
await roads[api]();
`;
const APIS = ["readFileSyncUrl", "readFileSyncBuffer", "readFileCallback", "fsPromisesReadFile", "fsPromisesModule",
  "createReadStream", "openSyncReadSync", "promisesOpen", "copyFileSync", "copyFileCallback", "promisesCopyFile",
  "cpSync", "cpCallback", "promisesCp", "linkSync", "symlinkSync", "renameSync"];
const bun = (() => { try { execFileSync("bun", ["--version"], {stdio: "ignore"}); return true; } catch { return false; } })();

describe("tools/osd-generator-reads: a generator's reads decide the generation's privacy", function () {
  this.timeout(60000);
  let base, root, tools;

  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "osd-generator-reads-")));
    root = join(base, "root");
    tools = join(base, "tools");
    mkdirSync(join(root, "vault/dir"), {recursive: true});
    mkdirSync(join(root, "gen"));
    mkdirSync(tools);
    writeFileSync(join(root, "vault/.osd-source.json"), JSON.stringify({private: true}));
    writeFileSync(join(root, "vault/zsentinel.txt"), "SYNTHETIC-PRIVATE-SENTINEL\n");
    writeFileSync(join(root, "vault/zmove.txt"), "SYNTHETIC-PRIVATE-MOVED\n");
    writeFileSync(join(root, "vault/dir/zsentinel2.txt"), "SYNTHETIC-PRIVATE-SENTINEL-2\n");
    // a private tree outside the root, reached only through a link in gen/;
    // and one inside, reached through a link in tools/
    mkdirSync(join(base, "elsewhere"));
    writeFileSync(join(base, "elsewhere/.osd-layer.json"), JSON.stringify({private: true}));
    writeFileSync(join(base, "elsewhere/zfar.txt"), "SYNTHETIC-PRIVATE-FAR\n");
    symlinkSync(join(base, "elsewhere/zfar.txt"), join(root, "gen/zlinked.txt"));
    mkdirSync(join(root, "tools"));
    symlinkSync(join(root, "vault/zsentinel.txt"), join(root, "tools/zlinked.txt"));
    mkdirSync(join(root, "open"));
    writeFileSync(join(root, "open/zpublic.txt"), "SYNTHETIC-PUBLIC\n");
    const git = (...args) => execFileSync("git", ["-C", root, ...args], {stdio: "ignore"});
    git("init", "-q");
    git("add", "open");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    symlinkSync(resolve("tools/osd-generator-reads.mjs"), join(tools, "osd-generator-reads.mjs"));
    writeFileSync(join(tools, "zgen.mjs"), GENERATOR);
    // two stand-ins for a hosted binary's `gen` mode: one preloads the
    // recorder first, as bin/osd.mjs does; the other never does
    const host = preload => `${preload ? 'await import("./osd-generator-reads.mjs");\n' : ""}`
      + "const [, , , name, ...args] = process.argv;\nprocess.argv = [process.argv[0], name, ...args];\n"
      + "await import(new URL(name, import.meta.url).href);\n";
    writeFileSync(join(tools, "host-recorded.mjs"), host(true));
    writeFileSync(join(tools, "host-bare.mjs"), host(false));
  });
  afterEach(() => rmSync(base, {recursive: true, force: true}));

  const generate = (api, self) => {
    const log = join(base, `${api}.jsonl`);
    const saved = process.env.OSD_SELF;
    if (self) process.env.OSD_SELF = JSON.stringify(self);
    else delete process.env.OSD_SELF;
    try { runGeneratorsOf(tools, [["zgen.mjs", api]], () => undefined, root, () => {}, undefined, log, []); }
    finally { if (saved === undefined) delete process.env.OSD_SELF; else process.env.OSD_SELF = saved; }
    return readGeneratorLog(log);
  };
  // every read counts as declared, so only attribution decides
  const publish = log => {
    const bytes = log.entries.filter(entry => entry.kind !== "meta");
    const record = markIncomplete(makeReadRecord(root, new Map(bytes.map(entry => [entry.real, entry.sha256])), log.entries), log.incomplete);
    const generation = join(root, "build/by-input/0123456789abcdef");
    mkdirSync(generation, {recursive: true});
    writeFileSync(join(generation, READS), JSON.stringify(record));
    return () => inspectReadRecord(root, generation);
  };

  for (const api of APIS) {
    it(`records ${api} of private bytes and refuses the generation`, () => {
      const log = generate(api);
      expect(log.incomplete).to.deep.equal([]);
      expect(log.entries.map(entry => entry.path)).to.include(
        /^cp|Cp$/.test(api) ? "vault/dir/zsentinel2.txt" : api === "renameSync" ? "vault/zmove.txt" : "vault/zsentinel.txt");
      expect(log.entries.every(entry => entry.privacy === true)).to.equal(true);
      // a renamed source is gone from where the hash saw it: unverifiable, also refused
      expect(publish(log)).to.throw().with.property("code", api === "renameSync" ? "UNKNOWN_PRIVACY" : "PRIVATE_LAYER");
    });
  }

  // an fd the recorder never saw opened (inherited stdin) is named through /proc
  for (const [label, code] of [["readSync", "readSync(0, Buffer.alloc(8))"], ["readFileSync", "readFileSync(0)"]]) {
    it(`attributes ${label} on an inherited fd to the private file it names`, function () {
      if (process.platform !== "linux") this.skip();
      const log = join(base, "fd.jsonl");
      const input = openSync(join(root, "vault/zsentinel.txt"), "r");
      try {
        const child = spawnSync(process.execPath, ["--import", join(tools, "osd-generator-reads.mjs"), "--input-type=module", "-e",
          `import {readFileSync, readSync} from "node:fs"; ${code};`],
        {cwd: root, stdio: [input, "pipe", "pipe"], encoding: "utf8",
          env: {...process.env, OSD_ROOT: root, OSD_GENERATOR_READS: log, OSD_GENERATOR_READS_TOKEN: "fd"}});
        expect(child.status, child.stderr).to.equal(0);
      } finally { closeSync(input); }
      const read = readGeneratorLog(log);
      expect(read.entries.map(entry => entry.path)).to.deep.equal(["vault/zsentinel.txt"]);
      expect(publish(read)).to.throw().with.property("code", "PRIVATE_LAYER");
    });
  }

  // (6) a skip-listed prefix is skipped by where it really leads, too
  for (const [api, path, code] of [["genLinkOutside", /^external\/[0-9a-f]{16}\/zlinked.txt$|^gen\/zlinked.txt$/, "PRIVATE_LAYER"],
    ["toolsLinkInside", /^tools\/zlinked.txt$/, "PRIVATE_LAYER"]]) {
    it(`records ${api}: a link under an excluded prefix into a private tree`, () => {
      const log = generate(api);
      expect(log.incomplete).to.deep.equal([]);
      expect(log.entries.some(entry => path.test(entry.path) && entry.privacy === true)).to.equal(true);
      expect(publish(log)).to.throw().with.property("code", code);
    });
  }

  // (3) names are content: a listing, existence test or stat under a private tree
  for (const api of ["listPrivate", "existsPrivate", "statPrivate"]) {
    it(`records ${api} as a private name read and refuses the generation`, () => {
      const log = generate(api);
      expect(log.incomplete).to.deep.equal([]);
      expect(log.entries.some(entry => entry.kind === "meta" && entry.privacy === true && entry.path.startsWith("vault"))).to.equal(true);
      expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
    });
  }

  it("leaves a public listing out of the record, which stays publishable", () => {
    const log = generate("listPublic");
    expect(log.entries.filter(entry => entry.kind === "meta")).to.deep.equal([]);
    expect(log.incomplete).to.deep.equal([]);
    expect(publish(log)).not.to.throw();
  });

  // (2) children of a generator
  for (const api of ["nodeChild", "nodeChildAsync", "nodeChildOwnEnv"]) {
    it(`${api}: a node child carries the recorder and its private read is recorded`, () => {
      const log = generate(api);
      expect(log.incomplete).to.deep.equal([]);
      expect(log.children.size).to.equal(1);
      expect(log.entries.map(entry => entry.path)).to.include("vault/zsentinel.txt");
      expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
    });
  }

  for (const [api, what] of [["catChild", "child: cat vault/zsentinel.txt"], ["gitShow", "child: git show HEAD:open/zpublic.txt"],
    ["worker", "child: worker 1"]]) {
    it(`${api}: a child the recorder cannot follow makes the record incomplete`, () => {
      const log = generate(api);
      expect(log.incomplete).to.include(what);
      expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
    });
  }

  for (const api of ["requirePreload", "requirePreloadEnv", "requireAfterEval", "forkPreload", "redirectWarnings", "quotedPreload"]) {
    it(`${api}: a node child with a preload ahead of the recorder makes the record incomplete`, () => {
      const log = generate(api);
      expect(log.incomplete.some(what => /\(preload --require \.\/open\/zbefore\.cjs\)/.test(what)), log.incomplete.join("; ")).to.equal(true);
      expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
    });
  }

  it("envFilePreload: an env file that sets NODE_OPTIONS makes the record incomplete", () => {
    const log = generate("envFilePreload");
    expect(log.incomplete.some(what => what.includes("(preload --env-file=open/zpre.env)")), log.incomplete.join("; ")).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
  });

  it("nodeRun: a package script node --run starts in a shell makes the record incomplete", () => {
    const log = generate("nodeRun");
    expect(log.incomplete.some(what => what.includes("(preload --run)")), log.incomplete.join("; ")).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
  });

  it("a fork inheriting the generator's execArgv (the recorder) is recorded, not incomplete", () => {
    const log = generate("forkPlain");
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries.map(entry => entry.path)).to.include("vault/zsentinel.txt");
  });

  it("a --require after the script fails closed: node's options are not told from the script's", () => {
    const log = generate("scriptArgRequire");
    expect(log.incomplete.some(what => what.includes("(preload --require x)")), log.incomplete.join("; ")).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
  });

  it("r6 3b: osd itself as a child, with a preload in NODE_OPTIONS, makes the record incomplete", () => {
    const log = generate("selfHostile", [process.execPath, join(tools, "host-recorded.mjs")]);
    expect(log.incomplete.some(what => what.includes("(preload --require ./open/zbefore.cjs)")), log.incomplete.join("; ")).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
  });

  it("gitMetadata: an allow-listed git command in a public repository leaves the record complete", () => {
    const log = generate("gitMetadata");
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries).to.deep.equal([]);
    expect(publish(log)).not.to.throw();
  });

  it("gitListPrivate: an allow-listed ls-files over a private path is a private name read", () => {
    const log = generate("gitListPrivate");
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries.some(entry => entry.kind === "meta" && entry.path === "vault/*" && entry.privacy === true)).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
  });

  it("S2: an allow-listed git runs with the repository's fsmonitor off", () => {
    const ran = join(base, "zfsmonitor-ran");
    writeFileSync(join(base, "zfsmonitor.sh"), `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, {mode: 0o755});
    execFileSync("git", ["-C", root, "config", "core.fsmonitor", join(base, "zfsmonitor.sh")]);
    const log = generate("gitListPrivate");
    expect(log.incomplete).to.deep.equal([]);
    expect(existsSync(ran), "the repository's fsmonitor program ran").to.equal(false);
  });

  it("a file the generator wrote and reads back is derived, not a source", () => {
    const log = generate("ownCache");
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries.map(entry => entry.path)).not.to.include.members(["open/zcache.bin"]);
    expect(log.entries.map(entry => entry.path)).not.to.include.members(["open/zcache.tmp"]);
  });

  it("a file read before the generator overwrote it is still a source", () => {
    const log = generate("oldThenOverwrite");
    const reads = log.entries.filter(entry => entry.path === "open/zpublic.txt");
    expect(reads).to.have.length(1);
    expect(reads[0].sha256).to.equal(createHash("sha256").update("SYNTHETIC-PUBLIC\n").digest("hex"));
  });

  for (const api of ["appendThenRead", "openAppendThenRead", "promisesAppendThenRead"]) {
    it(`S3 ${api}: an append to a private source and a read back is still a private source`, () => {
      const log = generate(api);
      expect(log.incomplete).to.deep.equal([]);
      expect(log.entries.some(entry => entry.path === "vault/zsentinel.txt" && entry.privacy === true)).to.equal(true);
      expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
    });
  }

  it("S4: a plain read of a private file outside the root is recorded", () => {
    process.env.OSD_TEST_OUTSIDE = join(base, "elsewhere/zfar.txt");
    let log;
    try { log = generate("outsidePrivate"); } finally { delete process.env.OSD_TEST_OUTSIDE; }
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries.some(entry => entry.real === join(base, "elsewhere/zfar.txt") && entry.privacy === true)).to.equal(true);
    expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
  });

  it("an unmarked library clone's directory is unknown; a file merely named osd-lib-* is not", () => {
    mkdirSync(join(base, "osd-lib-zclone"));
    writeFileSync(join(base, "osd-lib-zclone/zcl_synthetic.clas.abap"), "synthetic\n");
    writeFileSync(join(root, "open/osd-lib-zhelper.mjs"), "export const synthetic = 1;\n");
    expect(privacyNow(join(base, "osd-lib-zclone/zcl_synthetic.clas.abap"))).to.equal(null);
    expect(privacyNow(join(root, "open/osd-lib-zhelper.mjs"))).to.equal(false);
  });

  it("a child announced by a recorder that never answers makes the record incomplete", () => {
    const log = join(base, "children.jsonl");
    writeFileSync(log, `${JSON.stringify({recorder: "parent"})}\n${JSON.stringify({child: "silent"})}\n`);
    expect(readGeneratorLog(log).incomplete).to.deep.equal(["child process silent: no recorder handshake"]);
  });

  it("G1: a hosted child that never loads the recorder makes the record incomplete", () => {
    const log = generate("readFileSyncBuffer", [process.execPath, join(tools, "host-bare.mjs")]);
    expect(log.entries).to.deep.equal([]);
    expect(log.incomplete).to.deep.equal(["zgen.mjs: no recorder handshake"]);
    expect(publish(log)).to.throw(/incomplete: zgen.mjs/).with.property("code", "UNKNOWN_PRIVACY");
  });

  it("G1: a hosted child that preloads the recorder, as `osd gen` does, is recorded", () => {
    const log = generate("readFileSyncBuffer", [process.execPath, join(tools, "host-recorded.mjs")]);
    expect(log.incomplete).to.deep.equal([]);
    expect(log.entries.map(entry => entry.path)).to.include("vault/zsentinel.txt");
    expect(publish(log)).to.throw().with.property("code", "PRIVATE_LAYER");
  });

  it("G1: under Bun, where the hooks are invisible to imports, the record is incomplete", function () {
    if (!bun) this.skip();
    const log = generate("readFileSyncBuffer", ["bun", join(tools, "host-recorded.mjs")]);
    expect(log.incomplete).to.include("recorder: node:fs hooks are not visible to imports");
    expect(log.incomplete).to.include("zgen.mjs: no recorder handshake");
    expect(publish(log)).to.throw().with.property("code", "UNKNOWN_PRIVACY");
  });

  it("the seed capture keeps the build's gaps and is itself incomplete when it recorded nothing", () => {
    const entry = generate("readFileSyncBuffer").entries.find(one => one.path === "vault/zsentinel.txt");
    const hashed = new Map([[entry.real, entry.sha256]]);
    const gap = {reads: [], incomplete: true, incompleteReads: ["zgen.mjs: no recorder handshake"]};
    expect(withSeedReads(root, hashed, gap, {entries: [entry], incomplete: []}))
      .to.include({incomplete: true}).and.to.have.deep.property("incompleteReads", ["zgen.mjs: no recorder handshake"]);
    expect(withSeedReads(root, hashed, {reads: [entry]}, {entries: [], incomplete: []})).to.have.property("incomplete", true);
    expect(withSeedReads(root, hashed, {reads: []}, {entries: [entry], incomplete: []})).not.to.have.property("incomplete");
  });
});
