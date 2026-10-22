import {createRequire} from "node:module";
import {resolve, join} from "node:path";
import {cp, mkdir, readFile, readdir, rm, stat, writeFile} from "node:fs/promises";
import {spawn} from "node:child_process";
import {gzipSync} from "node:zlib";
import {packAt, tilesOf, webappsOf} from "../tools/osd-packs.mjs";
import {packApplications} from "../tools/osd-bsp-registry.mjs";
import {rootWebappOf} from "../tools/osd-system.mjs";
import {SANDBOX_CONFIG_PATH, SANDBOX_CONFIG_BODY} from "../tools/osd-sandbox-config.mjs";
import {describeUnfetched} from "../tools/osd-fetch.mjs";
import {mediaFileName} from "../editors/vscode/web/page-host.mjs";

const root = resolve(import.meta.dirname, "..");
// Trimmed like build-vsix: a whitespace-only selection means no packs, not an invalid name.
const selection = String(process.env.OSD_WEB_PACKS ?? process.env.OSD_VSIX_PACKS ?? "zork").trim();
const names = selection === "all" || selection === "" ? [] : selection.split(",").map((name) => name.trim()).filter(Boolean);
const selected = [];
for (const name of names) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error(`build-vscode-web: invalid pack name: ${JSON.stringify(name)}`);
  const pack = packAt(root, join(root, "packs", name));
  if (pack?.name !== name) throw new Error(`build-vscode-web: unknown pack: ${name}`);
  if (!selected.some((other) => other.name === name)) selected.push(pack);
}
const missing = selected.flatMap((pack) => pack.missing.map((source) => ({
  pack: pack.name, folder: source.folder, repo: source.repo, ref: source.ref, oci: source.oci,
})));
if (missing.length) throw new Error(describeUnfetched(missing));
const env = {...process.env, OSD_WEB_PACKS: selection};
console.log(`VS Code web packs: ${selection === "" ? "core (none)" : selection === "zork" ? "core+zork" : selection}`);
async function run(command, args) {
  const child = spawn(command, args, {cwd: root, env, stdio: "inherit"});
  const code = await new Promise((done, reject) => {
    child.on("error", reject);
    child.on("close", done);
  });
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (exit ${code})`);
}
await run("npm", ["run", "transpile"]);
env.OSD_PREVIEW_GENERATE_ONLY = "1";
await run("node", ["scripts/build-preview.mjs"]);
for (const file of ["output/init.mjs", "web/generated/seed.mjs", "web/generated/services.mjs"]) {
  await stat(resolve(root, file)).catch(() => {
    throw new Error(`${file} is missing; run npm run web:vscode to transpile and generate the gateway first`);
  });
}
const require = createRequire(import.meta.url);
const webpack = require("webpack");
const config = require(resolve(root, "editors/vscode/web/webpack.config.cjs"));
const result = await new Promise((resolveBuild, reject) => webpack(config, (error, stats) => {
  if (error) reject(error);
  else if (stats.hasErrors()) reject(new Error(stats.toString({colors: false, errorDetails: true})));
  else resolveBuild(stats);
}));
console.log(result.toString({colors: false, preset: "minimal"}));
const file = resolve(root, "editors/vscode/dist/web/extension.js");
const bytes = (await stat(file)).size;
const gzipBytes = gzipSync(await readFile(file)).byteLength;
console.log(`VS Code web bundle (${selection === "" ? "core" : selection === "zork" ? "core+zork" : selection}): raw ${bytes} bytes (${(bytes / 1048576).toFixed(2)} MiB), gzip ${gzipBytes} bytes (${(gzipBytes / 1048576).toFixed(2)} MiB)`);

// DuckDB-Wasm for osd.web.database = duckdb: the engine's 39 MB binary goes
// beside extension.js, not into it, and the extension fetches it only when the
// setting asks for DuckDB. Copied after webpack, whose output.clean empties
// dist/web. The JavaScript half (the blocking bundle) is already in the bundle,
// as it is in the preview's sw.js.
const wasm = require.resolve("@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm");
await cp(wasm, resolve(root, "editors/vscode/dist/web/duckdb-mvp.wasm"));
const wasmBytes = (await stat(wasm)).size;
console.log(`VS Code web DuckDB-Wasm: duckdb-mvp.wasm beside the bundle, ${wasmBytes} bytes (${(wasmBytes / 1048576).toFixed(2)} MiB), loaded only for osd.web.database = duckdb`);

// The Fiori apps for the webview (docs/vscode-web.md): the root webapp and the
// selected packs' pages, laid out as the preview lays out build/app, so that
// the pages' relative URLs mean the same thing. Copied after webpack, whose
// output.clean empties dist/web. osd-web-apps.json maps each UI5 component to
// its folder; the webview loads the component from there instead of the BSP
// path the gateway serves, because script tags cannot cross the message bridge.
const app = resolve(root, "editors/vscode/dist/web/app");
await cp(rootWebappOf(root, env), app, {recursive: true});
for (const pack of webappsOf(root, env)) await cp(pack.dir, join(app, pack.name), {recursive: true});
await writeFile(join(app, "packs.json"), JSON.stringify({tiles: tilesOf(root, env), applications: packApplications(root, env)}, undefined, 2) + "\n");
const components = {};
async function manifests(dir, prefix) {
  for (const entry of (await readdir(dir, {withFileTypes: true})).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory()) await manifests(join(dir, entry.name), `${prefix}${entry.name}/`);
    else if (entry.name === "manifest.json") {
      const id = JSON.parse(await readFile(join(dir, entry.name), "utf8"))["sap.app"]?.id;
      if (typeof id === "string" && components[id] === undefined) components[id] = prefix;
    }
  }
}
await manifests(app, "");
await writeFile(join(app, "osd-web-apps.json"), JSON.stringify({components, sandboxConfigPath: SANDBOX_CONFIG_PATH,
  sandboxConfigBody: SANDBOX_CONFIG_BODY}, undefined, 2) + "\n");
// The SMW0 media (W3MI objects: the Zork story file, the demos' pictures and
// audio), beside the bundle as the preview keeps them beside sw.js. The web
// entry's W3MI loader reads them from the extension's own files; output/ only
// holds the selected packs' objects. The copy's name is mediaFileName (an
// injective spelling without "%", editors/vscode/web/page-host.mjs); the
// loader asks for the same spelling.
const media = resolve(root, "editors/vscode/dist/web/media");
// emptied first: a file of an earlier spelling or pack would ship otherwise
await rm(media, {recursive: true, force: true});
await mkdir(media, {recursive: true});
let mediaBytes = 0;
let mediaFiles = 0;
for (const entry of (await readdir(resolve(root, "output"))).sort()) {
  if (!/\.w3mi\.data\./.test(entry)) continue;
  await cp(resolve(root, "output", entry), join(media, mediaFileName(entry)));
  mediaBytes += (await stat(join(media, mediaFileName(entry)))).size;
  mediaFiles++;
}
console.log(`VS Code web media: ${mediaFiles} W3MI objects, ${mediaBytes} bytes (${(mediaBytes / 1048576).toFixed(2)} MiB)`);
let appBytes = 0;
let appFiles = 0;
async function measure(dir) {
  for (const entry of await readdir(dir, {withFileTypes: true})) {
    if (entry.isDirectory()) await measure(join(dir, entry.name));
    else { appBytes += (await stat(join(dir, entry.name))).size; appFiles++; }
  }
}
await measure(app);
console.log(`VS Code web apps: ${appFiles} files, ${appBytes} bytes (${(appBytes / 1048576).toFixed(2)} MiB), ${Object.keys(components).length} UI5 components`);
