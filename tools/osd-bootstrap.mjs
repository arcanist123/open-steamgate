#!/usr/bin/env node
import {spawnSync} from "node:child_process";
import {existsSync, realpathSync} from "node:fs";
import {join, resolve} from "node:path";
import {librariesFromLock} from "./osd-lock.mjs";
import {requireSupportedNode} from "./osd-node-version.mjs";
import {materialise} from "./osd-libs.mjs";
import {runsAs} from "./osd-main.mjs";
import {ensurePinned} from "./osd-transpiler-pin.mjs";

function run(root, command, args, env, label) {
  const result = spawnSync(command, args, {cwd: root, stdio: "inherit", env});
  if (result.error) throw new Error(`${label}: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`${label} failed (exit ${result.status ?? "unknown"})`);
}

// The build resolves @abaplint/transpiler through node_modules. Before the
// transpile runs, that path must be the pinned build, not the published
// package `npm ci` put there: a fresh clone of main measured 2026-11-12
// failed with `osd-build: FAILED: Statement CommitEntities not supported`
// under the published 2.14.19, and built fine once the links CI makes were
// in place. This check is what turns a silent fall-back into a refusal.
export function assertPinnedTranspiler(root, pin) {
  const at = join(resolve(root), "node_modules", "@abaplint", "transpiler");
  const want = realpathSync(join(pin, "packages", "transpiler"));
  let got;
  try { got = realpathSync(at); } catch { got = at; }
  if (got !== want) {
    throw new Error(`bootstrap: node_modules/@abaplint/transpiler resolves to ${got}, not the pinned build (${want}); run node tools/osd-transpiler-pin.mjs`);
  }
}

export function bootstrap(root = process.cwd(), say = (line) => console.log(line), env = process.env) {
  requireSupportedNode(process.versions.node, "bootstrap: ");
  const at = resolve(root);
  if (!existsSync(join(at, "node_modules"))) {
    throw new Error("bootstrap: node_modules/ is missing; run npm install, then npm run bootstrap");
  }
  // The pin step, before anything is fetched or built: verify or build the
  // transpiler this tree is pinned to and link it (with the CLI, runtime and
  // core) the way CI does. tests.yml does this by hand ahead of the build;
  // bootstrap runs it here, so `npm ci && npm run bootstrap` is the whole
  // fresh-clone recipe, and a pin that cannot be built refuses loudly
  // instead of transpiling on the published package.
  const pin = ensurePinned(at, env, say);
  assertPinnedTranspiler(at, pin);
  const {libraries} = librariesFromLock(at);
  const cloned = materialise(at, say);
  say(cloned.length === 0
    ? "bootstrap: every library clone is already at its locked ref"
    : `bootstrap: cloned ${cloned.length} ${cloned.length === 1 ? "library" : "libraries"}`);
  run(at, process.execPath, [join(at, "tools", "osd-fetch.mjs")], env, "bootstrap: pack fetch");
  run(at, "npm", ["run", "transpile"], env, "bootstrap: transpile");
  return {libraries: libraries.length, cloned: cloned.length, pin};
}

if (runsAs("osd-bootstrap.mjs")) {
  try {
    bootstrap();
  } catch (error) {
    const message = String(error.message ?? error).split(/\r?\n/)[0];
    console.error(message.startsWith("bootstrap:") ? message : `bootstrap: ${message}`);
    process.exitCode = 1;
  }
}
