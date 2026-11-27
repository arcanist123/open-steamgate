import {layerEnvironment} from './osd-layer-env.mjs';
// One installed index supplies the complete source closure. No Git or network here.
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {dirname, isAbsolute, join, relative, resolve} from "node:path";
import {repositoryConfig, sourceFolder} from "./osd-abapgit-config.mjs";
import {inspectReadRecord} from "./osd-read-record.mjs";

export const SYSTEM_ID = ".osd-system.json";
export const LAYER_ID = ".osd-layer.json";
export const systemPath = (kind, name) => `${kind === "lib" ? "libs" : kind === "pack" ? "packs" : "inputs"}/${name}`;
const digest = /^sha256:[0-9a-f]{64}$/;
const name = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;
const fail = (message) => { const e = new Error(`system mode: ${message}`); e.code = "BAD_SYSTEM"; throw e; };

export function activeSystem(root, env) {
  const file = join(root, ".local/system", SYSTEM_ID);
  if (!existsSync(file)) return undefined;
  const system = JSON.parse(readFileSync(file, "utf8"));
  if (!digest.test(system.digest) || !Array.isArray(system.layers)) fail("invalid installed identity");
  const paths = new Set();
  system.layers.forEach((layer, order) => {
    if (layer.order !== order || typeof layer.name !== "string" || !name.test(layer.name) || !["lib", "input", "pack", "customer"].includes(layer.kind)
      || !digest.test(layer.digest) || !digest.test(layer.treeDigest) || layer.path !== systemPath(layer.kind, layer.name)
      || paths.has(layer.path)) fail("invalid installed layer identity/order");
    paths.add(layer.path);
    const identity = join(root, ".local/system", layer.path, LAYER_ID);
    if (!existsSync(identity) || JSON.stringify(JSON.parse(readFileSync(identity, "utf8"))) !== JSON.stringify(layer)) fail(`layer identity differs: ${layer.name}`);
  });
  env ??= layerEnvironment(root, system.layers.filter(layer => layer.kind === "lib").map(layer => layer.name));
  for (const [key, value] of Object.entries(env)) {
    if (["OSD_PACKS", "OSD_WEB_PACKS", "OSD_LAYERS"].includes(key) || key.startsWith("OSD_LIB_")) {
      if (value !== undefined) fail(`${key} is refused; the system digest supplies all layers`);
    }
  }
  if (existsSync(join(root, "local/tmp"))) fail("$TMP layer (local/tmp) is refused; the system digest supplies all layers");
  return system;
}

// What publishing says about an input whose privacy is not recorded.
export const unknownPrivacy = path => `input ${path} has no recorded privacy; rerun node tools/osd-fetch.mjs `
  + "and rebuild with node tools/osd-build.mjs before publishing (a foreign OCI zip with an empty config stays unknown and cannot be published)";

export function assertPublicSystem(root) {
  const system = activeSystem(root);
  const layer = system?.layers.find(layer => layer.private === true);
  if (layer) {
    const error = new Error(`private layer ${layer.name} cannot be published to a public destination`);
    error.code = "PRIVATE_LAYER";
    throw error;
  }
  // The live generation records the system it was compiled from
  // (generationSystem, written by osd-build and osd-warm). A generation built
  // while a private system was installed stays private after that system is
  // replaced; one without a record, or from another system, is refused too.
  const liveManifest = join(root, "build/live/manifest.json");
  if (existsSync(liveManifest)) {
    let generation;
    try { generation = JSON.parse(readFileSync(liveManifest, "utf8")); }
    catch { fail("invalid live generation manifest"); }
    if (generation?.systemPrivate === true) {
      const error = new Error("private live generation cannot be published to a public destination");
      error.code = "PRIVATE_LAYER";
      throw error;
    }
    if (!existsSync(join(root, "build/live/reads.json"))) {
      const error = new Error("live generation read record is missing; rebuild with node tools/osd-build.mjs");
      error.code = "READ_RECORD";
      throw error;
    }
    inspectReadRecord(root, join(root, "build/live"));
    const unknown = generation?.provenance?.find?.(input => input.private === null);
    if (unknown) fail(unknownPrivacy(unknown.path));
    if (generation?.systemPrivate !== false || !Array.isArray(generation.provenance)
      || generation.provenance.some(input => typeof input.private !== "boolean" || input.private)
      || generation.systemDigest !== (system?.digest ?? null))
      fail("live generation has no matching public system identity; rebuild with node tools/osd-build.mjs");
  }
  // A pack fetched after the build is not in the live record. The fetched
  // identities under packs/ are cheap to read here; the full check of the
  // tree against the live generation (hash and every current input) is
  // tools/osd-public-tree.mjs, which every artefact writer and verifier uses.
  const late = generationSystem(root).provenance.find(input => input.private === true);
  if (late) {
    const error = new Error(`private input ${late.path} cannot be published to a public destination`);
    error.code = "PRIVATE_LAYER";
    throw error;
  }
}

// What a generation records about the system it was compiled from.
export function generationSystem(root, inputs = {}, reads = [], readRecord = undefined) {
  const system = activeSystem(root);
  // An installed layer is private only when marked (absent = public, the
  // byte-identical old format); activeSystem checked each identity.
  const provenance = (system?.layers ?? []).map(layer => ({kind: layer.kind, path: layer.path, digest: layer.digest, private: layer.private === true}));
  const folders = [...(inputs.folders ?? []), ...(inputs.libs ?? []), ...(inputs.bspFolders ?? []),
    ...(inputs.packFolders ?? []), ...(inputs.packFiles ?? []), ...(inputs.sourceLayers ?? []).map(layer => layer.path)];
  const seen = new Set();
  const inspect = (path, kind, onlySensitive = false) => {
    const dir = resolve(root, path);
    if (seen.has(dir) || !existsSync(dir)) return;
    seen.add(dir);
    let privacy = false;
    for (let parent = dir; ; parent = dirname(parent)) {
      for (const file of [".osd-source.json", LAYER_ID]) {
        const at = join(parent, file);
        if (existsSync(at)) {
          let identity;
          try { identity = JSON.parse(readFileSync(at, "utf8")); } catch { fail(`invalid input identity: ${at}`); }
          // A layer identity without the key is public (the old format). A
          // fetched identity without a boolean is unknown: one fetched before
          // the field existed, or a foreign OCI zip with an empty config
          // (null). Development hashes and builds it; publishing refuses it.
          const value = file === LAYER_ID ? identity.private === true
            : typeof identity.private === "boolean" ? identity.private : null;
          if (value === true) privacy = true;
          else if (value === null && privacy === false) privacy = null;
        }
      }
      if (parent === root || dirname(parent) === parent) break;
    }
    const logical = relative(root, dir);
    if (!onlySensitive || privacy !== false) provenance.push({kind, path: logical === ".." || logical.startsWith("../") ? `external/${dir.split(/[\\/]/).at(-1)}` : logical,
      private: privacy});
  };
  folders.forEach(path => inspect(path, "source"));
  // The build supplies the exact real files its readers consumed. A symlink
  // target's identity is taken from that real ancestry, including URL clones
  // that have since been removed from their temporary checkout.
  for (const entry of reads) {
    if (entry.privacy === false) continue;
    provenance.push({kind: "source-real", path: entry.path, private: entry.privacy});
  }
  const packDirs = new Set([...(inputs.packFiles ?? []).map(file => dirname(resolve(root, file)))]);
  for (const pack of (existsSync(join(root, "packs")) ? readdirSync(join(root, "packs"), {withFileTypes: true}) : []).filter(entry => entry.isDirectory()))
    packDirs.add(join(root, "packs", pack.name));
  for (const dir of packDirs) {
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      if (entry.isDirectory() && existsSync(join(dir, entry.name, ".osd-source.json"))) inspect(join(dir, entry.name), "pack-oci");
    }
  }
  const systemPrivate = provenance.some(input => input.private === true) ? true
    : readRecord?.incomplete || readRecord?.uncovered?.length || provenance.some(input => input.private === null) ? null : false;
  return {systemDigest: system?.digest ?? null, systemPrivate, provenance};
}

// Everything under build/ for an archive of the whole store: every kept
// generation, not only the live one, must be recorded public, since
// build/source-by-digest and build/xref are shared by all of them. A
// generation without a manifest or without the record is refused too.
export function assertPublicGenerations(root) {
  assertPublicSystem(root);
  const byInput = join(root, "build/by-input");
  if (!existsSync(byInput)) return;
  for (const entry of readdirSync(byInput, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    let generation;
    try { generation = JSON.parse(readFileSync(join(byInput, entry.name, "manifest.json"), "utf8")); } catch { generation = undefined; }
    if (generation?.systemPrivate === false) {
      inspectReadRecord(root, join(byInput, entry.name));
      continue;
    }
    const error = new Error(`generation ${entry.name} is ${generation?.systemPrivate === true ? "from a private system" : "not recorded public"}; remove it or rebuild before publishing build/`);
    error.code = "PRIVATE_LAYER";
    throw error;
  }
}

// A built generation from before that record: osd-build builds it again.
export function unrecordedGeneration(dir) {
  const file = join(dir, "manifest.json");
  if (!existsSync(file)) return false;
  // null is a recorded answer (privacy unknown: refused for publishing), not
  // a missing one -- building again would only record it again. A warm
  // generation (tools/osd-warm.mjs, its `.warm.json` beside it) is a serving
  // artefact with no read record of its own: it is reused for serving, and
  // publishing refuses it (READ_RECORD) until a cold build makes the record.
  const warm = existsSync(`${dir}.warm.json`);
  try { const record = JSON.parse(readFileSync(file, "utf8")); return !warm && !existsSync(join(dir, "reads.json")) || ![true, false, null].includes(record.systemPrivate) || !Array.isArray(record.provenance); } catch { return true; }
}

export const layerDir = (root, layer) => join(root, ".local/system", layer.path);
export const layerSource = (root, layer) => sourceFolder(layerDir(root, layer), repositoryConfig(layerDir(root, layer)));

// Logical paths preserve source-map paths and existing config selection rules.
export function logicalSystemPath(root, file, system = activeSystem(root) ?? null) {
  if (!system) return file;
  for (const layer of system.layers) {
    const dir = layerDir(root, layer);
    const rel = relative(dir, file).replaceAll("\\", "/");
    if (rel === ".." || rel.startsWith("../")) continue;
    if (layer.kind === "lib") return join(root, ".local/lars", layer.name, rel);
    if (layer.kind === "pack") return join(root, "packs", layer.name, rel);
    const src = relative(layerSource(root, layer), file).replaceAll("\\", "/");
    if (src !== ".." && !src.startsWith("../")) return join(root, layer.name, src);
    // The src repository layer can also carry its seed data and static pages.
    if (layer.kind === "input" && layer.name === "src") return join(root, rel);
  }
  return file;
}

export function systemFile(root, logical, env) {
  const system = activeSystem(root, env);
  if (!system) return resolve(root, logical);
  const actual = resolve(root, logical);
  if (isAbsolute(logical) || logical.startsWith(".local/system/") || logical.startsWith("gen/")) {
    const inside = dir => { const rel = relative(dir, actual); return rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel); };
    if (system.layers.some(layer => inside(layerDir(root, layer))) || inside(join(root, "gen"))) return actual;
    fail(`content path is outside the installed system: ${logical}`);
  }
  if (logical.split("/").includes("..") || logical.includes("\\")) fail(`unsafe content path: ${logical}`);
  for (const layer of [...system.layers].reverse()) {
    const prefix = layer.kind === "pack" ? `packs/${layer.name}/`
      : layer.kind === "lib" ? `.local/lars/${layer.name}/` : undefined;
    if (prefix && logical.startsWith(prefix)) return join(layerDir(root, layer), logical.slice(prefix.length));
  }
  for (const layer of [...system.layers].reverse()) {
    if (!["input", "customer"].includes(layer.kind)) continue;
    const prefix = `${layer.name}/`;
    const file = logical.startsWith(prefix) ? join(layerSource(root, layer), logical.slice(prefix.length))
      : layer.kind === "input" && layer.name === "src" ? join(layerDir(root, layer), logical) : undefined;
    if (file && existsSync(file)) return file;
  }
  return join(root, ".local/system/.absent", logical);
}


// Pass the build's resolved system (null for a checkout), never probe per file.
export function matchesSourcePath(root, file, patterns, system = null) {
  const logical = logicalSystemPath(root, file, system);
  return patterns.some(rule => rule.test(logical));
}

/** Resolve a source-map's logical checkout path beside its generated module. */
export function sourceMapFile(generated, source) {
  const logical = resolve(dirname(generated), source);
  for (let root = dirname(generated); ; root = dirname(root)) {
    if (existsSync(join(root, ".local/system", SYSTEM_ID))) {
      const path = relative(root, logical);
      // A frame can name output/ through its symlink while the map is relative
      // to the real generation. An unavailable source must not break a dump.
      if (path === ".." || path.startsWith("../") || isAbsolute(path)) return undefined;
      return systemFile(root, path);
    }
    if (dirname(root) === root) return logical;
  }
}

/** The root launchpad belongs to the src input repository. */
export const rootWebappOf = (root, env) => systemFile(root, "webapp", env);
