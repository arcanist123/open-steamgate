// A build waits a bounded time for the build lock instead of refusing at
// once. adt-lifecycle on #946 (2026-11-14, a fast runner): an explicit
// activation answered "a build is already running" 0.8 s after a frozen
// verification settled, because a verification takes the same lock for a
// moment to pin and to settle its generation. The wait polls the lock alone:
// a cold build's preamble hashes the whole tree, and it must not run once per
// poll (critic of #955: ~0.6 s each, ~8 s over a 10 s wait).
import {expect} from "chai";
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {build, layout, lock, liveHash} from "../tools/osd-build.mjs";
import {BUILD_LOCK_WAIT_MS, buildLockWait, whenLockFree} from "../tools/osd-build-lock-wait.mjs";

describe("builds wait for the build lock", function () {
  this.timeout(30000);
  let root, paths;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-lock-wait-"));
    mkdirSync(join(root, "build"), {recursive: true});
    paths = layout(root);
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  // a build as transpileStore's cold one is shaped: an expensive preamble,
  // then its own lock take unless it is told the lock is held
  function coldBuild() {
    const calls = {preamble: 0, held: 0};
    const work = async ({lockHeld} = {}) => {
      calls.preamble++;
      if (lockHeld) { calls.held++; expect(readFileSync(paths.lock, "utf8")).to.equal(String(process.pid)); return "built"; }
      const unlock = lock(paths); unlock(); return "built";
    };
    return {work, calls};
  }

  it("runs a cold build's preamble twice at most while the lock is held for a second", async () => {
    const release = lock(paths);
    setTimeout(release, 1000);
    const {work, calls} = coldBuild();
    const started = Date.now();
    expect(await whenLockFree({buildLockWaitMs: 5000}, work, {paths})).to.equal("built");
    expect(Date.now() - started).to.be.within(900, 4000);
    // the first attempt, then one under the lock -- not once per 100 ms poll
    expect(calls).to.deep.equal({preamble: 2, held: 1});
    expect(existsSync(paths.lock), "the lock taken for the build is released").to.equal(false);
  });

  it("keeps the first attempt as it was: no wait, no lock taken for it, when the lock is free", async () => {
    const {work, calls} = coldBuild();
    expect(await whenLockFree({buildLockWaitMs: 5000}, work, {paths})).to.equal("built");
    expect(calls).to.deep.equal({preamble: 1, held: 0});
  });

  it("still answers BUSY, naming the holder, when the lock stays held past the bound", async () => {
    const release = lock(paths);
    try {
      const {work, calls} = coldBuild();
      const started = Date.now();
      const error = await whenLockFree({buildLockWaitMs: 400}, work, {paths}).then(() => undefined, e => e);
      expect(error?.code).to.equal("BUSY");
      expect(error?.message).to.include(`pid ${process.pid}`);
      expect(Date.now() - started).to.be.within(350, 3000);
      expect(calls.preamble).to.equal(1);
    } finally { release(); }
  });

  it("retries a build whose first statement is the lock take (the warm compiler's) as it is", async () => {
    const release = lock(paths);
    setTimeout(release, 300);
    let calls = 0;
    const work = async () => { calls++; const unlock = lock(paths); unlock(); return "warm"; };
    expect(await whenLockFree({buildLockWaitMs: 5000}, work)).to.equal("warm");
    expect(calls).to.be.within(2, 6);
  });

  it("passes any other failure through at once", async () => {
    let calls = 0;
    const error = await whenLockFree({buildLockWaitMs: 5000}, async () => { calls++; throw Object.assign(new Error("x"), {code: "NOT_WARM"}); }, {paths})
      .then(() => undefined, e => e);
    expect(error?.code).to.equal("NOT_WARM");
    expect(calls).to.equal(1);
  });

  it("takes an empty or non-positive setting as the default, not as zero", () => {
    expect(buildLockWait({}, {OSD_BUILD_LOCK_WAIT_MS: ""}).ms).to.equal(BUILD_LOCK_WAIT_MS);
    expect(buildLockWait({}, {OSD_BUILD_LOCK_WAIT_MS: "0"}).ms).to.equal(BUILD_LOCK_WAIT_MS);
    expect(buildLockWait({}, {OSD_BUILD_LOCK_WAIT_MS: "x"}).ms).to.equal(BUILD_LOCK_WAIT_MS);
    expect(buildLockWait({}, {OSD_BUILD_LOCK_WAIT_MS: "2500"}).ms).to.equal(2500);
    expect(buildLockWait({buildLockWaitMs: 7}, {OSD_BUILD_LOCK_WAIT_MS: "2500"}).ms).to.equal(7);
    expect(BUILD_LOCK_WAIT_MS).to.be.within(5000, 30000);
  });

  it("builds a real tree under a lock its caller holds (lockHeld), and is BUSY without it", async () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "zcl_lock_wait.clas.abap"),
      "CLASS zcl_lock_wait DEFINITION PUBLIC FINAL CREATE PUBLIC.\n  PUBLIC SECTION.\n    CLASS-METHODS run RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_lock_wait IMPLEMENTATION.\n  METHOD run.\n    rv = 1.\n  ENDMETHOD.\nENDCLASS.\n");
    writeFileSync(join(root, "package.json"), "{}");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: "src", output_folder: "output", libs: [],
      options: {ignoreSyntaxCheck: false, unknownTypes: "compileError"}}));
    symlinkSync(resolve("node_modules"), join(root, "node_modules"));
    const release = lock(paths);
    try {
      const busy = await build({root, generators: false}).then(() => undefined, e => e);
      expect(busy?.code).to.equal("BUSY");
      const r = await build({root, generators: false, lockHeld: true});
      expect(r.ok, JSON.stringify(r)).to.equal(true);
      expect(liveHash(root)).to.equal(r.hash);
      expect(readFileSync(paths.lock, "utf8"), "a held lock is the caller's to release").to.equal(String(process.pid));
    } finally { release(); }
  });

  it("is what transpileStore's builds and a host's start build go through", () => {
    const store = readFileSync(new URL("../tools/osd-store-build.mjs", import.meta.url), "utf8");
    expect(store).to.contain("whenLockFree(store, () => w.compiler.build(activating, view))");
    expect(store).to.match(/whenLockFree\(store, held => build\(\{[^}]*\.\.\.held\}\),\s*\{paths: layout\(store\.root\)\}\)/);
    const start = readFileSync(new URL("../tools/osd-source-build-view.mjs", import.meta.url), "utf8");
    expect(start).to.contain("whenLockFree({}, held => build({root, ...held}), {paths: layout(root)})");
  });
});
