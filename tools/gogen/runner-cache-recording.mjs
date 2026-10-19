// Avoid observing a whole registry again on an unchanged runner invocation.
// This certificate controls metadata recording only. Every IR hit still passes
// the ordinary content key and atomic replay guards, even if this file is stale.
import {createHash, randomUUID} from "node:crypto";
import {mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {join} from "node:path";
import {runnerSelectionCache} from "./runner-selection-cache.mjs";
const require = createRequire(import.meta.url);
export function prepareRunnerCache(folders, options, selectionPolicy) {
  if (!options.cacheDir) return {options};
  try {
    const hash = createHash("sha256"), files = [];
    const walk = (dir, prefix, layer) => {
      for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = join(dir, entry.name), name = prefix + entry.name;
        if (entry.isDirectory()) walk(path, name + "/", layer);
        else if ([".abap", ".xml", ".asddls"].some((suffix) => entry.name.toLowerCase().endsWith(suffix))) {
          const fingerprint = createHash("sha256").update(readFileSync(path)).digest("hex");
          hash.update(JSON.stringify([layer, name, fingerprint]));
          files.push({layer, name, path, hash: fingerprint});
        }
      }
    };
    folders.forEach((folder, layer) => walk(folder, "", layer));
    const contents = {identity: require("./frontend-object-cache.mjs").toolIdentity(), inputs: hash.digest("hex")};
    const file = join(options.cacheDir, "runner-profile.json");
    let previous;
    try { previous = JSON.parse(readFileSync(file, "utf8")); } catch { /* First build or unavailable certificate. */ }
    const unchanged = previous?.identity === contents.identity && previous?.inputs === contents.inputs;
    const selectionCache = selectionPolicy ? runnerSelectionCache(options.cacheDir, contents.identity, files, selectionPolicy) : undefined;
    return {options: {...options, dependencyCache: !unchanged, ...(selectionCache ? {selectionCache} : {})}, certificate: {file, contents}};
  } catch { return {options}; } // Recording is the conservative fallback.
}
export function finishRunnerCache(certificate) {
  if (!certificate) return;
  const {file, contents} = certificate, temp = `${file}.${randomUUID()}.pending`;
  try {
    mkdirSync(join(file, ".."), {recursive: true});
    writeFileSync(temp, JSON.stringify(contents)); renameSync(temp, file);
  } catch { /* Recording next time is safe. */ }
  finally { try { rmSync(temp, {force: true}); } catch { /* Unavailable root. */ } }
}
