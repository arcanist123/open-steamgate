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
import {join, resolve} from "node:path";

const root = resolve(import.meta.dirname, "..");
const extension = join(root, "editors/vscode");
const out = resolve(root, process.argv[2] ?? "build/preview/vscode-web");
const bundle = join(extension, "dist/web/extension.js");
await stat(bundle).catch(() => {
  throw new Error("editors/vscode/dist/web/extension.js is missing; run npm run web:vscode first");
});

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
console.log(`stage-vscode-web: ${out} (extension.js ${bytes} bytes, version ${manifest.version})`);
