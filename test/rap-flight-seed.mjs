import {expect} from "chai";
import {existsSync, mkdtempSync, readFileSync, renameSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";
import {build, liveHash, switchTo} from "../tools/osd-build.mjs";

// The round-two and round-three fixes of the pack's seed capture, each as a
// behaviour that fails without it: the rows reach a build the CLI never sees
// (a first start's ensureSourceBuild calls the same build(), cache hits
// included); a selection that leaves the pack out neither needs nor makes
// them; a --no-switch build captures from the generation it built rather
// than from the live pointer; and a capture due while the asking process is
// serving a persistent DuckDB file still runs, on a database of its own. The
// rows are put back exactly as they were, so a later build of this tree
// reuses the generation it already has.
const ROOT = process.cwd();
const PACK = join(ROOT, "packs", "rap-flight");
const DATA = join(PACK, "data");
const rows = (file) => JSON.parse(readFileSync(join(DATA, file), "utf8"));
const tail = (child) => `\n${(child.stdout ?? "").slice(-800)}${(child.stderr ?? "").slice(-800)}`;

describe("packs/rap-flight: the build makes the seed rows", function () {
  if (!existsSync(join(PACK, "upstream"))) {
    it.skip("the pack is not fetched here (node tools/osd-fetch.mjs rap-flight)", () => {});
    return;
  }

  it("a build() the CLI never sees makes them, a cache hit included", async function () {
    this.timeout(600000);
    const aside = `${DATA}.aside`;
    const live = liveHash(ROOT);
    renameSync(DATA, aside);
    try {
      // the first build names the generation without the rows (they are one
      // of its inputs) and the capture writes them; the second finds that
      // generation cached with the rows away again -- the case that used to
      // reuse the generation and leave the pack empty
      const first = await build({root: ROOT, log: () => {}});
      expect(first.ok).to.equal(true);
      expect(rows("#dmo#carrier.tabu.json").length, "the generator ran").to.be.greaterThan(0);
      rmSync(DATA, {recursive: true, force: true});
      const second = await build({root: ROOT, log: () => {}});
      expect(second.ok).to.equal(true);
      expect(second.cached, "the second build reused the generation").to.equal(true);
      expect(rows("#dmo#carrier.tabu.json").length, "and still made the rows").to.be.greaterThan(0);
    } finally {
      rmSync(DATA, {recursive: true, force: true});
      renameSync(aside, DATA);
      if (live !== undefined && liveHash(ROOT) !== live) switchTo(ROOT, live);
    }
  });

  it("a selection without the pack builds clean and makes no rows", function () {
    this.timeout(600000);
    const aside = `${DATA}.aside`;
    const had = existsSync(DATA);
    if (had) renameSync(DATA, aside);
    const live = liveHash(ROOT);
    try {
      // the documented core+zork web build (scripts/build-vscode-web.mjs):
      // the pack is fetched, so its directory is there, but it is not one of
      // this build's inputs -- and the guard used to ask the directory
      const child = spawnSync(process.execPath, [resolve("tools", "osd-build.mjs")], {
        cwd: ROOT, encoding: "utf8", timeout: 540000,
        env: {...process.env, OSD_ROOT: ROOT, OSD_WEB_PACKS: "zork"},
      });
      expect(child.status, `its output:${tail(child)}`).to.equal(0);
      expect(existsSync(join(DATA, "#dmo#carrier.tabu.json")), "an excluded pack makes no rows").to.equal(false);
    } finally {
      rmSync(DATA, {recursive: true, force: true}); // only what a wrong build would have made
      if (had) renameSync(aside, DATA);
      if (live !== undefined) switchTo(ROOT, live); // the zork build went live; back to this tree's own
    }
  });

  it("a --no-switch build captures from the generation it built, not the live output", function () {
    this.timeout(300000);
    const dataAside = `${DATA}.aside`;
    const output = join(ROOT, "output");
    const outputAside = `${output}.aside`;
    const hadOutput = existsSync(output);
    const live = liveHash(ROOT);
    renameSync(DATA, dataAside);
    if (hadOutput) renameSync(output, outputAside); // no live pointer at all, the harder case
    try {
      const child = spawnSync(process.execPath, [resolve("tools", "osd-build.mjs"), "--no-switch"], {
        cwd: ROOT, encoding: "utf8", timeout: 240000, env: {...process.env, OSD_ROOT: ROOT},
      });
      expect(child.status, `its output:${tail(child)}`).to.equal(0);
      expect(liveHash(ROOT), "nothing went live").to.equal(live);
      expect(rows("#dmo#travel_m.tabu.json").length, "the captured generation's rows").to.be.greaterThan(0);
    } finally {
      if (hadOutput) renameSync(outputAside, output);
      rmSync(DATA, {recursive: true, force: true});
      renameSync(dataAside, DATA);
    }
  });

  it("a capture due while this process serves a persistent DuckDB still makes the rows", async function () {
    this.timeout(600000);
    // The build the capture belongs to runs inside whatever process asked
    // for a generation, and that process may be serving a persistent DuckDB
    // file at the time: DuckDB locks such a file for the lifetime of the
    // process that opened it, so a capture child that inherited the host's
    // STG_DB/STG_DB_PATH was refused the file and the build failed instead
    // of making the rows. The lock here is real, not simulated: this
    // process opens the file and keeps it open across the build.
    const {DuckDBDatabaseClient} = await import("../tools/duckdb-client.mjs");
    const scratch = mkdtempSync(join(tmpdir(), "osd-rap-flight-seed-"));
    const held = new DuckDBDatabaseClient({path: join(scratch, "live.duckdb")});
    await held.connect();
    const aside = `${DATA}.aside`;
    const had = existsSync(DATA);
    const inherited = {STG_DB: process.env.STG_DB, STG_DB_PATH: process.env.STG_DB_PATH};
    process.env.STG_DB = "duckdb";
    process.env.STG_DB_PATH = held.path;
    if (had) renameSync(DATA, aside);
    try {
      const built = await build({root: ROOT, log: () => {}, switch: false});
      expect(built.ok).to.equal(true);
      expect(rows("#dmo#carrier.tabu.json").length, "the capture ran on a database of its own").to.be.greaterThan(0);
      expect((await held.query("SELECT COUNT(*) AS tables FROM information_schema.tables")).length,
        "and the held file stayed this process's").to.equal(1);
    } finally {
      if (had) {
        rmSync(DATA, {recursive: true, force: true});
        renameSync(aside, DATA);
      }
      for (const name of ["STG_DB", "STG_DB_PATH"]) {
        if (inherited[name] === undefined) delete process.env[name];
        else process.env[name] = inherited[name];
      }
      await held.disconnect();
      rmSync(scratch, {recursive: true, force: true});
    }
  });
});
