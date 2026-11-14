// A store build waits a bounded time for the build lock instead of refusing
// at once. adt-lifecycle on #946 (2026-11-14, a fast runner): an explicit
// activation answered "a build is already running" 0.8 s after a frozen
// verification settled, because a verification takes the same lock for a
// few milliseconds to pin and to settle its generation.
import {expect} from "chai";
import {mkdtempSync, mkdirSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {layout, lock} from "../tools/osd-build.mjs";
import {BUILD_LOCK_WAIT_MS, whenLockFree} from "../tools/osd-store-build.mjs";

describe("store builds wait for the build lock", () => {
  let root, paths;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-lock-wait-"));
    mkdirSync(join(root, "build"), {recursive: true});
    paths = layout(root);
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));

  // what transpileStore hands it: a build that takes the lock first thing
  const building = () => async () => { const unlock = lock(paths); unlock(); return "built"; };

  it("builds once a short holder (a verification settling) lets go", async () => {
    const release = lock(paths);
    setTimeout(release, 300);
    const started = Date.now();
    expect(await whenLockFree({buildLockWaitMs: 5000}, building())).to.equal("built");
    expect(Date.now() - started).to.be.within(250, 3000);
  });

  it("still answers BUSY when the holder keeps the lock past the bound", async () => {
    const release = lock(paths);
    try {
      const started = Date.now();
      const error = await whenLockFree({buildLockWaitMs: 400}, building()).then(() => undefined, e => e);
      expect(error?.code).to.equal("BUSY");
      expect(Date.now() - started).to.be.within(350, 3000);
    } finally { release(); }
  });

  it("passes any other failure through at once", async () => {
    let calls = 0;
    const error = await whenLockFree({buildLockWaitMs: 5000}, async () => { calls++; throw Object.assign(new Error("x"), {code: "NOT_WARM"}); })
      .then(() => undefined, e => e);
    expect(error?.code).to.equal("NOT_WARM");
    expect(calls).to.equal(1);
  });

  it("is what both of transpileStore's builds go through, with a bound of seconds", () => {
    const source = readFileSync(new URL("../tools/osd-store-build.mjs", import.meta.url), "utf8");
    expect(source).to.contain("whenLockFree(store, () => w.compiler.build(activating, view))");
    expect(source).to.contain("whenLockFree(store, () => build({");
    expect(BUILD_LOCK_WAIT_MS).to.be.within(5000, 30000);
  });
});
