// Uses the readiness poll that osd: Start resolves on, followed immediately
// by the two requests a user makes. The full-tree prime must still be busy.
import {expect} from "chai";
import {spawn} from "node:child_process";
import {once} from "node:events";
import {readFileSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {randomUUID} from "node:crypto";
import {build} from "../tools/osd-build.mjs";
import {copyRuntimeRoot} from "./helpers/runtime-root.mjs";
import {scaled, speed} from "../tools/warm-deadline/warm-deadline.mjs";

const {waitForServing} = createRequire(import.meta.url)("../editors/vscode/launcher.js");
const {Osd} = createRequire(import.meta.url)("../editors/vscode/lib.js");

describe("warm startup: ready means the front answers during priming", function () {
  // The host start and the full prime both scale with the runner's speed.
  console.log(`runner speed factor ${speed().factor.toFixed(2)} (${speed().source})`);
  this.timeout(scaled(180000));
  it("answers serving within 1 s and a classrun within 2 s immediately after Start resolves", async () => {
    const dir = copyRuntimeRoot();
    const port = Number(process.env.STG_PORT ?? 3030);
    const base = `http://127.0.0.1:${port}`;
    const identity = randomUUID();
    let child;
    let log = "";
    try {
      // Own the cold baseline: earlier suites may leave checkout live/gen
      // on another tree. Neither readiness nor cleanup should depend on that.
      await build({root: dir});
      child = spawn(process.execPath, [join(dir, "test", "run.mjs")], {
        cwd: dir,
        env: {...process.env, OSD_ROOT: dir, OSD_WARM: "1", OSD_LAUNCHER_IDENTITY: identity,
          STG_SERVE: "child", STG_PORT: String(port), STG_TLS: "0", STG_DB: "file",
          STG_DB_BASE: join(dir, "base"), STG_DB_PATH: join(dir, "osd.sqlite"),
          OSD_OPERATIONS_DB: join(dir, "operations.sqlite")},
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", d => { log += d; });
      child.stderr.on("data", d => { log += d; });
      await waitForServing(port, {launcherPid: child.pid, launcherIdentity: identity, intervalMs: 20});
      const started = performance.now();
      const serving = await fetch(`${base}/osd/serving`, {signal: AbortSignal.timeout(2000)});
      const body = await serving.json();
      const latency = performance.now() - started;
      console.log(`first /osd/serving answer ${(latency / 1000).toFixed(3)} s after Start resolved`);
      expect(body.ready).to.equal(true);
      expect(latency).to.be.lessThan(1000);
      expect(body.warm.state, log.slice(-2000)).to.equal("priming");
      const runStarted = performance.now();
      const client = new Osd(base, (url, options) => fetch(url, {...options, signal: AbortSignal.timeout(2000)}));
      const result = await client.classrun("ZCL_OSD_CLASSRUN_DEMO");
      console.log(`first classrun answer ${((performance.now() - runStarted) / 1000).toFixed(3)} s`);
      expect(result.text).to.include("hello from classrun");
      expect(performance.now() - runStarted).to.be.lessThan(2000);
      const still = await fetch(`${base}/osd/serving`).then(r => r.json());
      expect(still.warm.state, "requests finished while the prime was running").to.equal("priming");
      // Keep checking through the full run, including its CPU-bound section.
      // Otherwise a delayed blocking prime could start after these requests.
      let final = still;
      while (final.warm.state === "priming") {
        await new Promise(resolve => setTimeout(resolve, 100));
        final = await fetch(`${base}/osd/serving`, {signal: AbortSignal.timeout(2000)}).then(r => r.json());
      }
      // The prime's own time against its deadline: a runner that grows
      // slower shows here as a shrinking margin before it shows as a failure.
      for (const line of log.split("\n").filter(l => /warm: (prime |primed )/.test(l))) console.log(line.trim());
      expect(final.warm.state, final.warm.reason ?? log.slice(-2000)).to.equal("primed");
      // A performance signal apart from the (generous) availability deadline:
      // the prime's time per input file per unit of measured slowdown. Seen
      // 2.9 (CI), 5.4 (4-core workstation), 5.7 (same, one contended core);
      // twice the worst of those fails, so a compiler regression still shows.
      const timing = log.match(/warm: prime took \d+ ms of its \d+ ms deadline \(\d+ input files, speed factor [\d.]+, ([\d.]+) ms per file per factor\)/);
      expect(timing, "the front logs the prime's time against its deadline").to.not.equal(null);
      expect(Number(timing[1]), timing[0]).to.be.lessThan(11.5);
      // The first classrun imported its module before the swap. A later run
      // must execute the live class table, rather than that cached export.
      const file = join(dir, "src/classrun/zcl_osd_classrun_demo.clas.abap");
      const before = readFileSync(file, "utf8");
      const marker = `hello from classrun ${randomUUID()}`;
      writeFileSync(file, before.replace("hello from classrun", marker));
      const editing = new Osd(base);
      const activated = await editing.activate({type: "CLAS", name: "ZCL_OSD_CLASSRUN_DEMO", base: "zcl_osd_classrun_demo"});
      expect(activated.ok, JSON.stringify(activated)).to.equal(true);
      expect(activated.build).to.equal("warm");
      expect((await editing.classrun("ZCL_OSD_CLASSRUN_DEMO")).text).to.include(marker);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, "exit");
        child.kill("SIGTERM");
        await stopped;
      }
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
