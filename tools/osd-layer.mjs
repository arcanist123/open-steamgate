import {publishChildEnv, devChildEnv} from './osd-env.mjs';
import {validatePack} from "./osd-layer-pack.mjs";
// Reproducible abapGit layers and ordered OCI systems (docs/oci-layers.md).
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {abapgitXml} from "./osd-abapgit-xml.mjs";
import {zipFiles} from "./osd-zip.mjs";
import {archiveFiles} from "./osd-source-zip.mjs";
import {MEDIA, JSON_LIMIT, OciError, assertPrivateTarget, client, formatRef, manifest, parseRef, pull, push, pushBlob, pushManifest, sha256, treeDigest} from "./osd-oci.mjs";
import {hostedLeakScanner, toolCommandIn} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";
import {CAPTURE, MAX_SCAN_BYTES} from "./osd-leak-scan.mjs";

const moduleDir = dirname(fileURLToPath(import.meta.url));
const toolRoot = resolve(moduleDir, "..");
const layerZip = (files) => zipFiles([...files].sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))), {method: 0});

const LAYER = "application/vnd.osd.layer.v1";
const SYSTEM = "application/vnd.osd.system.v1";
const CONFIG = "application/vnd.osd.layer.config.v1+json";
const ZIP = "application/vnd.osd.abapgit.zip";
const NAME = "org.osd.layer.name", KIND = "org.osd.layer.kind", ORDER = "org.osd.layer.order";
const PRIVATE = "org.osd.layer.private";
const jsonBytes = (value) => Buffer.from(JSON.stringify(value));
const descriptor = (mediaType, bytes) => ({mediaType, digest: sha256(bytes), size: bytes.length});
const fail = (code, message) => { throw new OciError(code, message); };

function privateContent(folder) {
  const names = new Set([".osd-source.json", ".osd-layer.json", ".osd-system.json"]);
  const read = file => {
    let value;
    try { value = JSON.parse(readFileSync(file, "utf8")); }
    catch { fail("BAD_LAYER", `invalid identity at ${file}`); }
    if (basename(file) === ".osd-source.json" && typeof value.private !== "boolean")
      fail("BAD_LAYER", `fetched identity with no recorded privacy cannot be published without --private (rerun node tools/osd-fetch.mjs; an empty-config OCI zip stays unknown): ${file}`);
    return value.private === true || value.layers?.some(layer => layer.private === true);
  };
  const walk = dir => {
    for (const item of readdirSync(dir, {withFileTypes: true})) {
      if (item.name === ".git" || item.name === "node_modules") continue;
      const path = join(dir, item.name);
      if (item.isFile() && names.has(item.name) && read(path)) return true;
      if (item.isDirectory() && walk(path)) return true;
    }
    return false;
  };
  for (let dir = resolve(folder); ; dir = dirname(dir)) {
    for (const name of names) if (existsSync(join(dir, name)) && read(join(dir, name))) return true;
    if (dir === toolRoot || dirname(dir) === dir) break;
  }
  return walk(resolve(folder));
}

// osd-build's store (build/by-input, build/source-by-digest, build/xref)
// holds the sources and output of every generation, private ones included,
// and no file in it carries an identity privateContent could read. So any
// folder inside a build store, or holding a generation manifest, is private
// unless proven otherwise: only --private builds a layer from it. Files
// copied out of the store lose that context and cannot be recognised.
const STORE = ["by-input", "source-by-digest"];
function generationManifest(file) {
  try {
    const value = JSON.parse(readFileSync(file, "utf8"));
    return typeof value?.hash === "string" && ["gen", "systemPrivate", "provenance", "builtAt"].some(key => Object.hasOwn(value, key));
  } catch { return false; }
}
function generationCache(folder) {
  const start = resolve(folder);
  for (let dir = start; ; dir = dirname(dir)) {
    if (dir === join(toolRoot, "build")) return true;
    if (basename(dir) === "build" && STORE.some(part => existsSync(join(dir, part)))) return true;
    if (generationManifest(join(dir, "manifest.json"))) return true;
    if (dirname(dir) === dir) break;
  }
  const walk = dir => readdirSync(dir, {withFileTypes: true}).some(item => {
    if (item.name === ".git" || item.name === "node_modules") return false;
    const path = join(dir, item.name);
    if (item.isFile()) return item.name === "manifest.json" && generationManifest(path);
    if (!item.isDirectory()) return false;
    return (item.name === "build" && STORE.some(part => existsSync(join(path, part)))) || walk(path);
  });
  return walk(start);
}

/** Read every file, without following links or carrying fetch identity. */
function folderFiles(folder) {
  const files = [];
  const walk = (path) => {
    if (path.split("/").some((part) => part === ".git" || part === "node_modules")) {
      console.error(`osd-layer: skipping ${path}`);
      return;
    }
    const full = join(folder, path), st = lstatSync(full);
    if (path.split("/").some(p => [".osd-source.json", ".osd-layer.json", ".osd-system.json"].includes(p))) fail("RESERVED_NAME", ".osd-source.json cannot be published");
    if (st.isDirectory()) {
      for (const name of readdirSync(full).sort()) walk(path ? `${path}/${name}` : name);
    } else if (st.isFile()) files.push({path, bytes: readFileSync(full)});
    else fail("UNSAFE_ENTRY", `${path}: only regular files and directories are allowed`);
  };
  walk("");
  return files;
}

export function readClosure(file) {
  let bytes;
  try { bytes = readFileSync(file); } catch { fail("BAD_CLOSURE", `${file}: cannot read closure`); }
  if (bytes.length > JSON_LIMIT) fail("BAD_CLOSURE", `${file}: closure exceeds 4 MiB`);
  let value;
  try { value = JSON.parse(bytes); } catch { fail("BAD_CLOSURE", `${file}: invalid JSON`); }
  validateClosure(value);
  return value;
}

function validateClosure(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Number.isSafeInteger(value.unresolved) || value.unresolved < 0
    || Object.keys(value).some(key => !["unresolved", "items"].includes(key))
    || !Array.isArray(value.items) || value.items.some(item => !item || typeof item !== "object" || Array.isArray(item))
    || Buffer.byteLength(JSON.stringify(value)) > JSON_LIMIT) fail("BAD_CLOSURE", "closure needs nonnegative integer unresolved and an array of objects within 4 MiB");
}
export {assertPrivateTarget} from "./osd-oci.mjs";

export function build(folder, {name, kind, source, annotations: extraAnnotations, private: isPrivate = false, closure} = {}) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(name ?? "")) fail("BAD_NAME", "--name must be a simple filename");
  if (!["lib", "input", "pack", "customer"].includes(kind)) fail("BAD_KIND", "--kind must be lib, input, pack or customer");
  if (!lstatSync(resolve(folder)).isDirectory()) fail("UNSAFE_ENTRY", "input must be a folder");
  if (!isPrivate && generationCache(folder)) fail("PRIVATE_LAYER", "a build cache (build/, or a folder holding a generation manifest) requires --private");
  if (!isPrivate && privateContent(folder)) fail("PRIVATE_LAYER", "private input requires --private");
  let files = folderFiles(resolve(folder));
  if (kind === "pack") validatePack(files, name);
  if (!files.some((f) => f.path === ".abapgit.xml")) {
    files = [{path: ".abapgit.xml", bytes: Buffer.from(abapgitXml())}, ...(["pack", "lib"].includes(kind) ? files : files.map((f) => ({...f, path: `src/${f.path}`})))];
  }
  const config = {schema: 1, name, kind, treeDigest: treeDigest(files.map(({path, bytes}) => [path, bytes]))};
  const annotations = {[NAME]: name, [KIND]: kind};
  if (isPrivate) { config.private = true; annotations["org.osd.layer.private"] = "true"; }
  if (closure !== undefined) { validateClosure(closure); config.closure = closure; }
  if (source) {
    const m = /^(.+)@([^@:]+):(.+)$/.exec(source);
    if (!m) fail("BAD_SOURCE", "--source must be repo@commit:path");
    config.source = {repo: m[1], commit: m[2], path: m[3]};
    annotations["org.opencontainers.image.source"] = m[1];
  }
  Object.assign(annotations, extraAnnotations, {[NAME]: name, [KIND]: kind});
  if (isPrivate) annotations["org.osd.layer.private"] = "true";
  else if (annotations["org.osd.layer.private"] !== undefined) fail("BAD_LAYER", "private annotation requires --private");
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const zip = layerZip(files), configBytes = jsonBytes(config);
  if (configBytes.length > JSON_LIMIT) fail("BAD_CLOSURE", "layer config exceeds 4 MiB including closure");
  // Apply the pull reader's path, collision and size rules before publishing.
  archiveFiles(zip);
  const manifest = {schemaVersion: 2, mediaType: MEDIA.manifest, artifactType: LAYER,
    config: descriptor(CONFIG, configBytes), layers: [{...descriptor(ZIP, zip),
      annotations: {"org.opencontainers.image.title": `${name}.zip`}}], annotations};
  const manifestBytes = jsonBytes(manifest);
  return {zip, config, configBytes, manifest, manifestBytes, digest: sha256(manifestBytes), files};
}

/**
 * A layer's reviewed byte/category/count exceptions, with `file` the
 * path inside the layer archive. The scan runs over neutral copies in a
 * temporary folder where the repository's list is not, so without this a
 * reviewed exception (a GUID in an upstream test vector) had no way through.
 */
export function readLeakAllow(file) {
  let raw;
  let bytes;
  try { bytes = readFileSync(file); } catch (error) { fail("BAD_ALLOW", `${file}: not readable (${error.code ?? error.name})`); }
  // measured on what was read, not on stat: a pipe stats as size 0
  if (bytes.length > 1024 * 1024) fail("BAD_ALLOW", `${file}: larger than 1 MiB`);
  try { raw = JSON.parse(bytes.toString("utf8")); } catch (error) { fail("BAD_ALLOW", `${file}: not readable JSON (${error.name})`); }
  const allow = raw?.allow;
  if (!Array.isArray(allow)) fail("BAD_ALLOW", `${file}: expected {"allow": [...]}`);
  // unknown keys are refused: a misspelled "Layer" would otherwise widen the scope
  for (const key of Object.keys(raw)) if (!["allow", "note"].includes(key)) fail("BAD_ALLOW", `${file}: unknown key ${JSON.stringify(key)}`);
  for (const [i, entry] of allow.entries()) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail("BAD_ALLOW", `${file}: entry ${i} is not an object`);
    for (const key of Object.keys(entry)) if (!["file", "fileSha256", "category", "count", "reason", "layer"].includes(key)) fail("BAD_ALLOW", `${file}: entry ${i} has unknown key ${JSON.stringify(key)}`);
    for (const key of ["file", "fileSha256", "category", "reason", "layer"]) {
      const value = Object.entries(entry).find(([name]) => name === key)?.at(1);
      if (typeof value !== "string" || !value.trim()) fail("BAD_ALLOW", `${file}: entry ${i} needs a non-empty ${key}`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(entry.fileSha256)) fail("BAD_ALLOW", `${file}: entry ${i} needs a full lowercase SHA-256 file digest`);
    if (!Number.isSafeInteger(entry.count) || entry.count < 1) fail("BAD_ALLOW", `${file}: entry ${i} needs a positive match count`);
  }
  return allow;
}

/** Scan the exact publishable tree and metadata, before the first write. */
export function leakGate(trees, metadata, documents = [], allow = [], layerNames = [], privateLayer = false) {
  const temp = mkdtempSync(join(tmpdir(), "osd-layer-scan-"));
  try {
    const paths = [], archivePaths = [], labels = new Map(), archive = [];
    mkdirSync(join(temp, "content"));
    const content = (bytes, label) => {
      if (bytes.length > MAX_SCAN_BYTES) fail("LEAK", `publish refused: ${label} exceeds scanner size limit (${MAX_SCAN_BYTES} bytes)`);
      const file = join(temp, "content", `${String(paths.length + 1).padStart(6, "0")}.txt`);
      writeFileSync(file, bytes);
      paths.push(file);
      labels.set(`content/${basename(file)}`, label);
    };
    for (const [i, files] of trees.entries()) {
      for (const {path, bytes} of files) {
        // the scanner refuses captures by name, which the neutral names below would hide
        if (CAPTURE.test(path)) fail("LEAK", `publish refused: ${path} is a capture file (*.pcap, *.pcapng, *.jsonl are never published)`);
        content(bytes, path);
        // recorded here, not inferred from labels: an archive file may be
        // called "OCI metadata", and its exception must not reach the documents
        archive.push({bytes, name: `content/${basename(paths.at(-1))}`, path, layer: layerNames.at(i)});
        archivePaths.push(path);
      }
    }
    // Scan the original JSON bytes too: parsing can discard duplicate keys.
    for (const bytes of documents) content(bytes, "OCI metadata");
    for (const [name, bytes] of [["paths.txt", archivePaths.join("\n")], ["meta.json", JSON.stringify(metadata, null, 2)]]) {
      if (Buffer.byteLength(bytes) > MAX_SCAN_BYTES) fail("LEAK", `publish refused: ${name} exceeds scanner size limit (${MAX_SCAN_BYTES} bytes)`);
      const file = join(temp, name);
      writeFileSync(file, bytes);
      paths.push(file);
    }
    // An entry naming a path the layer does not have is refused, not ignored:
    // a stale exception is how an allow list stops meaning anything.
    // Only archive files: the metadata documents are ours, not the layer's. An
    // entry with a `layer` applies to that layer of a system only.
    // a layer name is what the layer's config says, so two layers of one
    // system may carry the same one; a scope naming such a name is ambiguous
    const repeated = new Set(layerNames.filter((name, i) => layerNames.indexOf(name) !== i));
    const translated = allow.flatMap((entry) => {
      // allow files are concatenated, so in a system an unscoped entry reviewed
      // for one layer would excuse the same path and value in every other
      if (entry.layer === undefined && trees.length > 1) fail("BAD_ALLOW", `allow entry for ${entry.file}: a system needs "layer" on every entry`);
      if (entry.layer !== undefined && repeated.has(entry.layer)) fail("BAD_ALLOW", `allow entry for ${entry.layer}:${entry.file}: more than one layer is called ${entry.layer}`);
      const hits = archive.filter(({path, layer}) => path === entry.file && (entry.layer === undefined || layer === entry.layer));
      if (!hits.length) fail("BAD_ALLOW", `allow entry for ${entry.layer ? `${entry.layer}:` : ""}${entry.file}: no such file in the layer`);
      return hits.map(({name, bytes}) => {
        if (sha256(bytes) !== entry.fileSha256) fail("BAD_ALLOW", `allow entry for ${entry.layer}:${entry.file}: file content SHA-256 changed`);
        return {file: name, category: entry.category, count: entry.count};
      });
    });
    writeFileSync(join(temp, ".leak-publication-allow.json"), JSON.stringify({allow: translated}));
    // run from the scan directory, which is in no checkout: the list is then
    // the explicit list path or this tool's own checkout's, never the caller's cwd
    const identifierArgs = process.env.OSD_LEAK_IDENTIFIERS ? ["--identifiers", resolve(process.env.OSD_LEAK_IDENTIFIERS)] : [];
    const scannerEnv = publishChildEnv();
    const [scannerCommand, ...scannerArgs] = toolCommandIn(scannerEnv, join(toolRoot, "tools/osd-leak-scan.mjs"), [...identifierArgs, ...(privateLayer ? ["--private-layer"] : []), "--redact", "--publication-allow", "--paths", ...paths]);
    const result = hostedLeakScanner ? hostedLeakScanner(temp, paths, privateLayer) : spawnSync(scannerCommand, scannerArgs, {cwd: temp, env: scannerEnv, encoding: "utf8", maxBuffer: 4 * 1024 * 1024});
    const reason = result.error?.message ?? result.stderr?.trim() ?? result.stdout?.trim();
    const named = (reason ?? "").replace(/content\/\d{6}\.txt/g, (n) => labels.get(n) ?? n);
    if (result.status === 3) fail("BAD_ALLOW", named);
    if (result.error || result.status !== 0 && result.status !== 1) fail("SCAN_FAILED", `SCAN_FAILED: ${reason || `scanner exit ${result.status}, signal ${result.signal}`}`);
    // name what leaked by its archive path, not by the neutral file it was scanned as
    if (result.status === 1) fail("LEAK", `publish refused: ${named || "scanner found identifiers"}`);
  } finally { rmSync(temp, {recursive: true, force: true}); }
}

export function validateLayer(layer) {
  const m = layer.manifest.json, c = layer.config;
  if (m.schemaVersion !== 2 || m.mediaType !== MEDIA.manifest || m.artifactType !== LAYER || m.config?.mediaType !== CONFIG
    || m.layers?.length !== 1 || m.layers[0].mediaType !== ZIP || c?.schema !== 1
    || !["lib", "input", "pack", "customer"].includes(c.kind) || typeof c.name !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(c.name)
    || m.annotations?.["org.osd.layer.name"] !== c.name || m.annotations?.["org.osd.layer.kind"] !== c.kind
    || m.layers[0].annotations?.["org.opencontainers.image.title"] !== `${c.name}.zip`) fail("BAD_LAYER", "invalid OSD layer");
  if (c.private !== undefined && c.private !== true || m.annotations?.["org.osd.layer.private"] !== (c.private === true ? "true" : undefined)) fail("BAD_LAYER", "private marker differs from layer config");
  if (c.closure !== undefined) validateClosure(c.closure);
  const files = [...archiveFiles(layer.layers[0].bytes)].map(([path, bytes]) => ({path, bytes}));
  if (!files.some(f => f.path === ".abapgit.xml")) fail("BAD_LAYER", "a layer needs root .abapgit.xml");
  if (c.kind === "pack") validatePack(files, c.name);
  if (!layerZip(files).equals(layer.layers[0].bytes)) fail("NOT_CANONICAL", "layer ZIP is not canonical");
  if (files.some(({path}) => path.split("/").some((part) => part === ".git" || part === "node_modules" || part === ".osd-layer.json" || part === ".osd-system.json"))) fail("RESERVED_NAME", ".git and node_modules cannot be published");
  if (files.some(({path}) => path.split("/").includes(".osd-source.json"))) fail("RESERVED_NAME", ".osd-source.json cannot be published");
  if (treeDigest(files.map(({path, bytes}) => [path, bytes])) !== c.treeDigest) fail("TREE_MISMATCH", "layer treeDigest does not match its ZIP");
  return files;
}

/** Sort by declared order, refusing gaps, duplicates and ambiguous ordering. */
export function systemLayers(index) {
  if (index.schemaVersion !== 2 || index.mediaType !== MEDIA.index || index.artifactType !== SYSTEM || !Array.isArray(index.manifests)) fail("BAD_SYSTEM", "expected an OSD system index");
  const layers = [...index.manifests].sort((a, b) => Number(a.annotations?.["org.osd.layer.order"]) - Number(b.annotations?.["org.osd.layer.order"]));
  layers.forEach((d, i) => {
    if (d.annotations?.["org.osd.layer.order"] !== String(i) || d.mediaType !== MEDIA.manifest || !d.annotations?.["org.osd.layer.name"] || !d.annotations?.["org.osd.layer.kind"]
      || !/^sha256:[0-9a-f]{64}$/.test(d.digest ?? "") || !Number.isSafeInteger(d.size) || d.size <= 0) fail("BAD_ORDER", "system layer orders must be contiguous starting at 0");
  });
  return layers;
}

function systemAnnotations(root, release = false) {
  const out = {};
  try { out["org.osd.osg.commit"] = execFileSync("git", ["rev-parse", "HEAD"], {env: release ? publishChildEnv('git') : devChildEnv(), cwd: toolRoot, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim(); }
  catch { /* A source distribution can have no Git metadata. */ }
  const lock = join(root, "libs.lock.json");
  if (existsSync(lock)) {
    const {transpiler} = JSON.parse(readFileSync(lock, "utf8"));
    if (transpiler) out["org.osd.transpiler"] = `${transpiler.repo}@${transpiler.ref}`;
  }
  return out;
}

export function prepareSystem(target, layers, options = {}) {
  assertPrivateTarget(target, layers.map(({layer}) => layer), options.env);
  if (options.annotations?.["org.osd.system.unresolved"] !== undefined) fail("BAD_SYSTEM", "system unresolved annotation is computed from layer closures");
  if (layers.length > 1 && options.allow?.some(entry => entry.layer === undefined)) fail("BAD_ALLOW", "a system needs layer on every allow entry");
  const names = layers.map(({layer}) => layer.config.name);
  if (options.allow?.some(entry => names.filter(name => name === entry.layer).length > 1)) fail("BAD_ALLOW", "an allow entry names more than one system layer");
  for (const entry of options.allow ?? []) if (entry.layer !== undefined && !layers.some(({layer}) => layer.config.name === entry.layer)) fail("BAD_ALLOW", `allow entry names no system layer: ${entry.layer}`);
  const index = {schemaVersion: 2, mediaType: MEDIA.index, artifactType: SYSTEM,
    manifests: layers.map(({layer}, i) => ({...descriptor(MEDIA.manifest, layer.manifest.bytes),
      annotations: {[NAME]: layer.config.name, [KIND]: layer.config.kind, [ORDER]: String(i), ...(layer.config.private ? {[PRIVATE]: "true"} : {})}})),
    annotations: {...systemAnnotations(options.root ?? process.env.OSD_ROOT ?? process.cwd(), options.release), ...options.annotations}};
  const withClosure = layers.filter(({layer}) => layer.config.closure !== undefined);
  if (withClosure.length) {
    const sum = withClosure.reduce((n, {layer}) => n + layer.config.closure.unresolved, 0);
    if (!Number.isSafeInteger(sum)) fail("BAD_CLOSURE", "system unresolved count exceeds safe integer range");
    index.annotations["org.osd.system.unresolved"] = String(sum);
  }
  for (const {layer, files} of layers) leakGate([files], {destination: target, config: layer.config, manifest: layer.manifest.json},
    [layer.configBytes, layer.manifest.bytes], options.allow?.filter(e => e.layer === undefined || e.layer === layer.config.name), [layer.config.name], layer.config.private === true);
  leakGate([], {destination: target, index}, [jsonBytes(index)], [], []);
  return index;
}

export async function pushSystem(target, refs, options = {}) {
  if (!refs.length) fail("BAD_SYSTEM", "a system needs at least one layer");
  const dest = parseRef(target), layers = [];
  for (const ref of refs) {
    if (!parseRef(ref).digest) fail("TAG_ONLY", "system layers must be digest references");
    const layer = await pull(ref, options);
    assertPrivateTarget(target, [layer], options.env);
    layers.push({ref, layer, files: validateLayer(layer)});
  }
  assertPrivateTarget(target, layers.map(({layer}) => layer), options.env);
  const index = prepareSystem(target, layers, options);
  const c = client(target, {...options, push: true});
  for (const {ref, layer} of layers) {
    const src = parseRef(ref);
    if (src.registry === dest.registry && src.repository === dest.repository) continue;
    for (const bytes of [layer.configBytes, ...layer.layers.map((l) => l.bytes)]) {
      await pushBlob(target, bytes, {...options, client: c, from: src.registry === dest.registry ? src.repository : undefined});
    }
    await pushManifest(formatRef({...dest, digest: layer.manifest.digest}), layer.manifest.bytes, options);
  }
  return pushManifest(target, jsonBytes(index), {...options, client: c});
}

export async function inspect(ref, options = {}) {
  const m = await manifest(ref, {...options, resolve: true});
  const layerSummary = async (ref, expectedSize) => {
    const layer = await pull(ref, options);
    validateLayer(layer);
    if (expectedSize !== undefined && layer.manifest.bytes.length !== expectedSize) fail("SIZE_MISMATCH", "index manifest descriptor size differs from layer manifest");
    const {closure, ...config} = layer.config;
    return {digest: layer.manifest.digest, ...config, ...(closure === undefined ? {} : {closure: {unresolved: closure.unresolved}})};
  };
  if (m.json.mediaType !== MEDIA.index) return layerSummary(formatRef({...parseRef(ref), digest: m.digest}));
  const layers = [];
  for (const d of systemLayers(m.json)) {
    const summary = await layerSummary(formatRef({...parseRef(ref), digest: d.digest}), d.size);
    if (summary.name !== d.annotations["org.osd.layer.name"] || summary.kind !== d.annotations["org.osd.layer.kind"]) fail("BAD_LAYER", "index identity differs from layer config");
    if (d.annotations["org.osd.layer.private"] !== (summary.private ? "true" : undefined)) fail("BAD_LAYER", "index private marker differs from layer config");
    layers.push(summary);
  }
  const closures = layers.filter(layer => layer.closure !== undefined);
  const total = closures.reduce((sum, layer) => sum + layer.closure.unresolved, 0);
  if (!Number.isSafeInteger(total) || m.json.annotations?.["org.osd.system.unresolved"] !== (closures.length ? String(total) : undefined)) fail("BAD_SYSTEM", "system unresolved annotation differs from layer closures");
  return {digest: m.digest, artifactType: SYSTEM, annotations: m.json.annotations, layers};
}

export function unresolvedLines(summary) {
  const layers = summary.layers ?? [summary];
  const lines = layers.filter(layer => layer.closure !== undefined).map(layer => `layer ${layer.name}: unresolved ${layer.closure.unresolved}`);
  if (summary.layers && lines.length) lines.push(`system: unresolved ${layers.reduce((sum, layer) => sum + (layer.closure?.unresolved ?? 0), 0)}`);
  return lines;
}

function readAnnotations(file) {
  const annotations = JSON.parse(readFileSync(file, "utf8"));
  if (!annotations || Array.isArray(annotations) || typeof annotations !== "object" || Object.values(annotations).some(value => typeof value !== "string")) fail("USAGE", "annotations must be a JSON object of strings");
  return annotations;
}

export async function main(args) {
  const [command, ...rest] = args;
  if (command === "inspect" && rest.length === 1) {
    const summary = await inspect(rest[0]);
    console.log(JSON.stringify(summary, null, 2));
    for (const line of unresolvedLines(summary)) console.log(line);
    return 0;
  }
  if (command === "system" && rest[0] === "push") {
    const refs = [], options = {};
    for (let i = 1; i < rest.length; i++) {
      if (rest.at(i) === "--leak-allow" && rest.at(i + 1) && !rest.at(i + 1).startsWith("--")) (options.allow ??= []).push(...readLeakAllow(rest.at(++i)));
      else if (rest.at(i) === "--annotations" && rest.at(i + 1)) {
        options.annotations = readAnnotations(rest.at(++i));
      }
      else if (rest.at(i).startsWith("--")) fail("USAGE", `invalid option ${rest.at(i)}`);
      else refs.push(rest.at(i));
    }
    const digest = await pushSystem(refs[0], refs.slice(1), options);
    console.log(formatRef({...parseRef(refs[0]), digest}));
    return 0;
  }
  if (!["build", "push"].includes(command)) fail("USAGE", "expected build, push, system push or inspect");
  const positionals = [], options = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest.at(i).startsWith("--")) {
      const key = rest.at(i).slice(2);
      if (key === "private") { options.private = true; continue; }
      if (!["name", "kind", "source", "out", "leak-allow", "annotations", "closure"].includes(key) || !rest.at(i + 1) || rest.at(i + 1).startsWith("--")) fail("USAGE", `invalid option ${rest.at(i)}`);
      if (key === "leak-allow" && command === "build") fail("USAGE", "build has no leak gate; --leak-allow belongs to push");
      if (key === "leak-allow") (options.allow ??= []).push(...readLeakAllow(rest.at(++i)));
      else if (key === "annotations") options.annotations = readAnnotations(rest.at(++i));
      else if (key === "closure") options.closure = readClosure(rest.at(++i));
      else Object.assign(options, {[key]: rest.at(++i)});
    } else positionals.push(rest.at(i));
  }
  if (positionals.length !== (command === "push" ? 2 : 1)) fail("USAGE", "expected a folder (and a destination for push)");
  if (command === "build" && !options.out) fail("USAGE", "build needs --out");
  const layer = build(positionals.at(-1), options);
  if (command === "build") {
    mkdirSync(options.out, {recursive: true});
    for (const [name, bytes] of [[`${options.name}.zip`, layer.zip], ["config.json", layer.configBytes], ["manifest.json", layer.manifestBytes]]) writeFileSync(join(options.out, name), bytes);
    console.log(`treeDigest ${layer.config.treeDigest}\nmanifest ${layer.digest}`);
  } else {
    assertPrivateTarget(positionals[0], [layer]);
    leakGate([layer.files], {destination: positionals[0], config: layer.config, manifest: layer.manifest}, [layer.configBytes, layer.manifestBytes],
      options.allow, [layer.config.name], layer.config.private === true);
    const digest = await push(positionals[0], layer);
    console.log(formatRef({...parseRef(positionals[0]), digest}));
  }
  return 0;
}

if (runsAs("osd-layer.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (error) => {
    console.error(`osd-layer: ${error.code ?? "ERROR"}: ${error.message}`);
    process.exit(["LEAK", "PRIVATE_LAYER"].includes(error.code) ? 2 : 1);
  });
}
