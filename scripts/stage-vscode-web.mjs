// Stage the VS Code web extension as a plain directory that vscode.dev can
// install with "Developer: Install Extension From Location...": the
// extension's package.json at the root of an HTTPS URL that answers CORS,
// with the files the browser entry needs beside it. GitHub Pages serves
// both, so the preview deployment publishes this directory at
// <preview>/vscode-web/ (docs/vscode-web.md "Try in vscode.dev").
//
// Run `npm run web:vscode` first; this script only copies and stamps.
// Usage: node scripts/stage-vscode-web.mjs [<out dir>]   (default build/preview/vscode-web)
import {cp, mkdir, readFile, rm, stat, writeFile} from "node:fs/promises";
import {existsSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
import {verifyPublicArtefact, writeArtefactProvenance} from "../tools/osd-provenance.mjs";
import {assertExtensionSources, assertPublicExtensionIdentity} from "../tools/osd-extension-sources.mjs";

export async function stageVscodeWeb(extension, out) {
const bundle = join(extension, "dist/web/extension.js");
await stat(bundle).catch(() => {
  throw new Error("editors/vscode/dist/web/extension.js is missing; run npm run web:vscode first");
});
const bundleProvenance = verifyPublicArtefact(join(extension, "dist/web"));
assertPublicExtensionIdentity(extension, "dist/web");
assertExtensionSources(extension, ["resources", "walkthrough", "media", "README.md", "CHANGELOG.md", "package.json"]);
const parent = dirname(out);
const parentProvenance = existsSync(join(parent, ".osd-provenance.json")) ? verifyPublicArtefact(parent) : undefined;

await rm(out, {recursive: true, force: true});
await mkdir(out, {recursive: true});
// dist/web holds the bundle and whatever the web entry loads beside it
// (the Fiori app files for its webview). Only the browser's own files go:
// none of the desktop's Node modules, osd/ seed or examples are reachable
// from the web entry.
for (const part of ["dist/web", "resources", "walkthrough", "media", "README.md", "CHANGELOG.md"]) {
  await cp(join(extension, part), join(out, part), {recursive: true});
}

// The desktop `main` is not shipped here, so a host that would pick it must
// not see it: the web manifest names only `browser`. Everything else (the
// commands, views and `when` clauses) is the one manifest both entries share.
const manifest = JSON.parse(await readFile(join(extension, "package.json"), "utf8"));
delete manifest.main;
await writeFile(join(out, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);

const bytes = (await stat(join(out, "dist/web/extension.js"))).size;
writeArtefactProvenance(out, bundleProvenance);
if (parentProvenance) writeArtefactProvenance(parent, {
  generation: parentProvenance.generation, systemDigest: parentProvenance.systemDigest,
  systemPrivate: parentProvenance.systemPrivate || bundleProvenance.systemPrivate,
  inputs: [...parentProvenance.inputs, ...bundleProvenance.inputs],
});
console.log(`stage-vscode-web: ${out} (extension.js ${bytes} bytes, version ${manifest.version})`);
}

if (resolve(process.argv[1] ?? "") === resolve(import.meta.filename)) {
  const root = resolve(import.meta.dirname, "..");
  try { await stageVscodeWeb(join(root, "editors/vscode"), resolve(root, process.argv[2] ?? "build/preview/vscode-web")); }
  catch (error) { console.error(`${error.code ?? "ERROR"}: ${error.message}`); process.exitCode = ["PRIVATE_LAYER", "BAD_PROVENANCE"].includes(error.code) ? 2 : 1; }
}
