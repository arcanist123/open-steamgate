// The control group for SP4 (docs/bun-spike.md part four): the same entry,
// bundled for Node and, from that, a Node single executable (SEA).
//
//   bun scripts/build-sea.mjs bundle   → build/osd-node/osd.mjs  (node build/osd-node/osd.mjs up)
//   bun scripts/build-sea.mjs sea      → build/osd-sea            (a Node SEA executable)
import {buildIdentity} from "../tools/osd-transpiler.mjs";
import {createRequire} from "node:module";
import {resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {writeFileSync} from "node:fs";
import {writePublicArtefact} from "../tools/osd-public-tree.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dir, "..");
const core = require.resolve("@abaplint/core");
const step = process.argv[2] ?? "bundle";
const bundle = resolve(root, "build", "osd-node", "osd.mjs");

const result = await Bun.build({
  entrypoints: [resolve(root, "bin", "osd.mjs")],
  target: "node",
  define: {__OSD_TOOLCHAIN_IDENTITY__: JSON.stringify(buildIdentity(root))},
  format: "esm",
  outdir: resolve(root, "build", "osd-node"),
  naming: "osd.mjs",
  plugins: [{
    name: "one-core",
    setup(build) {
      build.onResolve({filter: /^@abaplint\/core$/}, () => ({path: core}));
      build.onResolve({filter: /^@duckdb\/node-api$/}, () => ({path: "duckdb-absent", namespace: "osd-stub"}));
      build.onLoad({filter: /.*/, namespace: "osd-stub"}, () => ({
        contents: 'export const DuckDBInstance = {create() { throw new Error("DuckDB is not part of the bundle"); }}; export default {DuckDBInstance};',
        loader: "js",
      }));
    },
  }],
});
for (const log of result.logs) {
  console.log(String(log).split("\n")[0]);
}
if (!result.success) {
  process.exit(1);
}
console.log(`bundled ${bundle}: ${((await Bun.file(bundle).size) / 1e6).toFixed(1)} MB`);
writePublicArtefact(bundle, root);
if (step === "sea") {
  // The bundle itself is the main script, as an ES module inside the
  // executable's virtual file system. That needs Node 26.9 or later: before
  // it, a SEA's injected main could not import() a file outside the
  // executable at all (ERR_UNKNOWN_BUILTIN_MODULE out of the builtin-only
  // embedder loader), and every generation OSD builds is exactly such a
  // file. On 26.9 a plain import of one works, with top-level await, a
  // relative dependency and a namespaced name — measured by
  // scripts/sea-speedrun.sh. OSD_NODE names the Node that goes inside.
  const node = process.env.OSD_NODE ?? "node";
  const exe = resolve(root, "build", "osd-sea");
  const config = resolve(root, "build", "osd-node", "sea-config.json");
  writeFileSync(config, JSON.stringify({main: bundle, output: exe, mainFormat: "module", useVfs: true, disableExperimentalSEAWarning: true}, null, 2));
  execFileSync(node, ["--build-sea", config], {encoding: "utf8", cwd: root});
  writePublicArtefact(exe, root);
  console.log(`built ${exe}: ${((await Bun.file(exe).size) / 1e6).toFixed(1)} MB, carrying ${execFileSync(node, ["--version"], {encoding: "utf8"}).trim()}`);
}
