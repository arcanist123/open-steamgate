// bin/osd.mjs as one executable, build/osd (SP4, docs/bun-spike.md part three).
//
// Run with bun: `bun scripts/build-binary.mjs [--seed] [outfile] [target]`. Two things the bundler is
// told: DuckDB stays outside (native, optional), and @abaplint/core is ONE
// module — the transpiler resolves its own copy from where it lives and the
// entry another from here, same version, different files, and the
// transpiler checks its registry with instanceof.
import {buildIdentity} from "../tools/osd-transpiler.mjs";
import {createRequire} from "node:module";
import {execFileSync} from "node:child_process";
import {mkdirSync, rmSync} from "node:fs";
import {resolve} from "node:path";
import {stageSystemSeed} from "./build-vsix.mjs";
import {assertPublicSystem} from "../tools/osd-system.mjs";
import {assertPublicTree, writePublicArtefact} from "../tools/osd-public-tree.mjs";
import {describeVsixPreflight} from "../tools/osd-lock.mjs";
import {vsixPreflightMissing} from "../tools/osd-lib-path.mjs";

const require = createRequire(import.meta.url);
const root = resolve(import.meta.dir, "..");
const core = require.resolve("@abaplint/core");
const sqljs = require.resolve("sql.js");
const sqlWasm = require.resolve("sql.js/dist/sql-wasm.wasm");
const args = process.argv.slice(2).filter((arg) => arg !== "--seed" && arg !== "--unstamped");
const seeded = process.argv.includes("--seed") || process.env.OSD_BINARY_SEED === "1";
// --unstamped: a TEST-ONLY checkout binary, built before any generation exists
// (tests.yml checks a fresh clone builds). It gets no provenance sidecar, and
// every path that ships a binary (make-release, make-download-bundle,
// release-verify) verifies one, so it cannot be published. A seed or a
// release target is what ships: neither may be unstamped.
const unstamped = process.argv.includes("--unstamped");
if (args.length > 2) throw new Error("Usage: bun scripts/build-binary.mjs [--seed | --unstamped] [outfile] [target]");
const outfile = args[0] ?? resolve(root, "build", "osd");
const target = args[1];
const releaseTargets = new Set([
  "bun-linux-x64-baseline", "bun-linux-arm64", "bun-windows-x64-baseline", "bun-windows-arm64",
  "bun-darwin-arm64", "bun-darwin-x64-baseline",
]);
if (target !== undefined && !releaseTargets.has(target)) {
  throw new Error(`Unsupported release target ${target}; expected one of ${[...releaseTargets].join(", ")}`);
}
if (unstamped && (seeded || target !== undefined)) {
  throw new Error("build-binary: --unstamped is for a test-only checkout binary; a seeded or release-target binary is always stamped");
}
const started = Date.now();
let archive;
let seedId;
if (seeded) {
  // no private installed system or fetched source, before anything else
  assertPublicSystem(root);
  // a checkout without its libraries hears that first, in one line (it has
  // no generation either); the preflight reads and writes nothing
  const preflight = describeVsixPreflight(vsixPreflightMissing(root));
  if (preflight !== undefined) {
    console.error(preflight.replace(/^build-vsix: missing (.*); run npm install and node tools\/osd-libs\.mjs as needed$/,
      "build-binary --seed: missing $1; run npm run bootstrap"));
    process.exit(1);
  }
  // the seed is the tree: it must be the public live generation, before staging
  assertPublicTree(root);
  const stage = resolve(root, "build", "binary-seed");
  const seedRoot = resolve(stage, "osd-seed");
  archive = resolve(stage, "osd-seed.tar.gz");
  let staged;
  try {
    staged = await stageSystemSeed(seedRoot);
  } catch (error) {
    console.error(String(error.message).replace(/^build-vsix: missing (.*); run npm install and node tools\/osd-libs\.mjs as needed$/,
      "build-binary --seed: missing $1; run npm run bootstrap"));
    process.exit(1);
  }
  seedId = staged.seedId;
  mkdirSync(stage, {recursive: true});
  rmSync(archive, {force: true});
  execFileSync("tar", ["-czf", archive, "-C", seedRoot, "."]);
}
const result = await Bun.build({
  entrypoints: [resolve(root, "bin", "osd.mjs")],
  target: "bun",
  define: {__OSD_BINARY_SEEDED__: JSON.stringify(seeded), __OSD_TOOLCHAIN_IDENTITY__: JSON.stringify(buildIdentity(root))},
  compile: {...(target ? {target} : {}), outfile, ...(archive ? {assets: [archive]} : {})},
  plugins: [{
    name: "one-core",
    setup(build) {
      build.onResolve({filter: /^@abaplint\/core$/}, () => ({path: core}));
      // sql.js defaults to __dirname/sql-wasm.wasm, which Bun bakes into
      // the bundle as the build machine's node_modules path. Wrap every
      // bundled init (including database-sqlite's connect) at this boundary.
      // Node/dev and the preview still import the original package.
      build.onResolve({filter: /^sql\.js$/}, () => ({path: "sqljs-embedded", namespace: "osd-sqljs"}));
      build.onLoad({filter: /.*/, namespace: "osd-sqljs"}, () => ({
        contents: `
          import initSqlJs from ${JSON.stringify(sqljs)};
          import wasm from ${JSON.stringify(sqlWasm)} with { type: "file" };
          export default async function init(options = {}) {
            return initSqlJs({...options, wasmBinary: await Bun.file(wasm).bytes()});
          }
        `,
        loader: "js",
      }));
      if (!seeded) {
        build.onResolve({filter: /\/\.local\/lars\/open-abap-gui\/converter\/src\/api\.mjs$/},
          () => ({path: "gui-converter-on-checkout", namespace: "osd-stub"}));
      }
      // DuckDB is native and optional, and a compiled bundle evaluates every
      // import at start, even one behind a dynamic import; the binary ships
      // without it and says so when asked for it
      build.onResolve({filter: /^@duckdb\/node-api$/}, () => ({path: "duckdb-absent", namespace: "osd-stub"}));
      build.onLoad({filter: /^gui-converter-on-checkout$/, namespace: "osd-stub"}, () => ({
        contents: "export {};", loader: "js",
      }));
      build.onLoad({filter: /^duckdb-absent$/, namespace: "osd-stub"}, () => ({
        contents: 'export const DuckDBInstance = {create() { throw new Error("DuckDB is not part of the binary"); }}; export default {DuckDBInstance};',
        loader: "js",
      }));
      // web/generated/amdp.mjs is written by scripts/build-preview.mjs for
      // the service worker only: test/setup.mjs imports it on the
      // globalThis.__stgPreview branch, which no binary ever takes (the
      // binary answers AMDP through tools/amdp-destination.mjs and
      // gen/amdp/procedures.json at run time). Bun still resolves the
      // dynamic import at build time, so without this the binary build
      // depended on a preview build having run first in the same tree.
      build.onResolve({filter: /\/web\/generated\/amdp\.mjs$/}, () => ({path: "preview-amdp-absent", namespace: "osd-preview-stub"}));
      build.onLoad({filter: /.*/, namespace: "osd-preview-stub"}, () => ({
        contents: "// the preview's AMDP list; the binary is not a preview (scripts/build-binary.mjs)\nexport const procedures = [];",
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
if (unstamped) {
  // no sidecar, not even a stale one that once matched other bytes
  rmSync(`${outfile}.osd-provenance.json`, {force: true});
  console.log("unstamped: a test-only binary with no provenance; no publishing path accepts it");
} else {
  writePublicArtefact(outfile, root);
}
const size = (await Bun.file(outfile).size) / 1e6;
console.log(`built ${outfile}${target ? ` for ${target}` : ""}: ${size.toFixed(1)} MB in ${Date.now() - started} ms`);
console.log(seeded ? `system seed: ${seedId}` : "checkout mode: no embedded system seed");
