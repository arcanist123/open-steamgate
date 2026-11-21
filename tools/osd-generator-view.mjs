// Generators run in a separate process. Give their filesystem reads the
// same active view as the transpiler, while writes still target gen/.
import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {dirname, join, relative, resolve} from "node:path";
import {logicalSourcePath} from "./osd-source-snapshot.mjs";

export function installGeneratorView(env = process.env) {
  if (!env.OSD_ACTIVE_BUILD_OVERLAY) return;
  const overlay = JSON.parse(env.OSD_ACTIVE_BUILD_OVERLAY);
  delete env.OSD_ACTIVE_BUILD_OVERLAY;
  const root = resolve(env.OSD_ROOT ?? process.cwd());
  // A generator's read-only ObjectStore already sees this projected tree.
  // Loading/reconciling draft metadata here would persist active-view digests.
  env.OSD_GENERATOR_ACTIVE_VIEW = "1";
  const original = {readFileSync: fs.readFileSync, readdirSync: fs.readdirSync,
    existsSync: fs.existsSync, statSync: fs.statSync, lstatSync: fs.lstatSync};
  const replaced = new Map((overlay.exclude ?? []).map(file => [resolve(file), undefined]));
  const additions = new Map();
  const folder = overlay.folder && resolve(root, overlay.folder);
  const walk = dir => {
    if (!original.existsSync(dir)) return;
    for (const entry of original.readdirSync(dir, {withFileTypes: true})) {
      const copy = join(dir, entry.name);
      if (entry.isDirectory()) walk(copy);
      else if (!replaced.has(copy)) {
        const file = logicalSourcePath(root, copy, overlay);
        replaced.set(file, copy);
        const parent = dirname(file);
        if (!additions.has(parent)) additions.set(parent, []);
        additions.get(parent).push({name: entry.name, copy});
      }
    }
  };
  if (folder) walk(folder);
  const pathOf = file => typeof file === "string" || Buffer.isBuffer(file) ? resolve(String(file)) : undefined;
  const readPath = file => {
    const path = pathOf(file);
    // A missing active file must look absent, including direct reads.
    return replaced.has(path) ? replaced.get(path) ?? join(root, "build", "inactive", ".absent", relative(root, path)) : file;
  };
  globalThis[Symbol.for("osd.generator.readPath")] = readPath;
  for (const method of ["readFileSync", "existsSync", "statSync", "lstatSync"]) {
    fs[method] = (file, ...args) => original[method](readPath(file), ...args);
  }
  fs.readdirSync = (dir, options) => {
    const parent = pathOf(dir);
    const entries = original.readdirSync(dir, options).filter(entry => {
      const name = typeof entry === "object" && !Buffer.isBuffer(entry) ? entry.name : String(entry);
      const path = join(parent, String(name));
      return !replaced.has(path) || replaced.get(path) !== undefined;
    });
    for (const {name, copy} of additions.get(parent) ?? []) {
      if (entries.some(entry => String(entry.name ?? entry) === name)) continue;
      entries.push(options?.withFileTypes ? original.readdirSync(dirname(copy), options).find(entry => entry.name === name)
        : options === "buffer" || options?.encoding === "buffer" ? Buffer.from(name) : name);
    }
    return entries;
  };
  syncBuiltinESMExports();
}

installGeneratorView();
