// Immutable source inputs beside a generation, never in the database.
import {createHash, randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, linkSync, copyFileSync, rmSync, renameSync} from "node:fs";
import {dirname, join, relative, resolve} from "node:path";

const isSourceInput = path => /\.(abap|asddls|as[A-Za-z]+|srvdsrv|xml)$/.test(path) || path === "gen/rap/bindings.json";

// Provenance keeps the original root-relative key. Storage encodes external
// parent segments so neither snapshots nor pre-save copies escape build/.
export function sourceSnapshotPath(file) {
  const key = file.replaceAll("\\", "/");
  if (key.startsWith(".external/")) return ".external/inside/" + key;
  const absolute = /^(?:[A-Za-z]:\/|\/)/.test(key);
  if (!key.startsWith("../") && !absolute) return key;
  const parts = key.split("/");
  const name = parts.pop(); // Preserve the abapGit basename for overlay inputs.
  return (absolute ? ".external/absolute/" : ".external/outside/") + parts.map(p => p === ".." ? "%2E%2E" : p === "" ? "%00" : encodeURIComponent(p)).join("/") + "/" + name;
}

export function sourceOriginalPath(file) {
  const key = file.replaceAll("\\", "/");
  if (key.startsWith(".external/inside/")) return key.slice(".external/inside/".length);
  const prefix = key.startsWith(".external/absolute/") ? ".external/absolute/" : ".external/outside/";
  if (!key.startsWith(prefix)) return key;
  const parts = key.slice(prefix.length).split("/");
  const name = parts.pop();
  return parts.map(p => p === "%00" ? "" : decodeURIComponent(p)).join("/") + "/" + name;
}

export function logicalSourcePath(root, file, overlay) {
  const copies = resolve(root, overlay?.folder ?? "build/inactive/active").replaceAll("\\", "/") + "/";
  const path = resolve(file).replaceAll("\\", "/");
  return path.startsWith(copies) ? resolve(root, sourceOriginalPath(path.slice(copies.length))) : path;
}

// An aggregate cache hit proves these inputs too, even when an older builder
// omitted external sources from a snapshot marked complete.
export function missingSourceInputs(root, generation, digests, overlay) {
  let inputs;
  try {inputs = JSON.parse(readFileSync(join(generation, "source-inputs.json"), "utf8"));} catch {return digests;}
  if (!inputs || typeof inputs !== "object") return digests;
  return new Map([...digests].filter(([file, digest]) => {
    const key = relative(root, logicalSourcePath(root, file, overlay)).replaceAll("\\", "/");
    return isSourceInput(key) && inputs[key] !== digest;
  }));
}

// Snapshot paths may share an inode with other generations and the digest
// cache. Publish complete bytes by rename, replacing only this path's link.
export function writeSourceSnapshot(target, bytes) {
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, bytes, {flag: "wx"});
    renameSync(temp, target);
  } finally {
    rmSync(temp, {force: true});
  }
}

export function keepSourceInputs(root, generation, digests, actual = undefined, overlay = undefined, previous = undefined) {
  const rootPrefix = resolve(root).replaceAll("\\", "/") + "/";
  const inputs = {};
  const shared = join(root, "build", "source-by-digest");
  const reuse = previous && existsSync(join(previous.generation, "source-shared"));
  mkdirSync(shared, {recursive: true});
  const directories = new Set();
  const ensureDirectory = target => {
    const dir = dirname(target);
    if (!directories.has(dir)) {
      mkdirSync(dir, {recursive: true});
      directories.add(dir);
    }
  };
  for (const [file, digest] of digests) {
    const input = actual?.get(file) ?? file;
    const logical = logicalSourcePath(root, file, overlay).replaceAll("\\", "/");
    const path = logical.startsWith(rootPrefix) ? logical.slice(rootPrefix.length) : relative(root, logical);
    if (!isSourceInput(path)) continue;
    inputs[path.replaceAll("\\", "/")] = digest;
    if (reuse && previous.digests.get(file) === digest && existsSync(join(shared, digest))) continue;
    const target = join(generation, "source", sourceSnapshotPath(path));
    const prior = previous && join(previous.generation, "source", sourceSnapshotPath(path));
    if (prior && previous.digests.get(file) === digest && existsSync(prior)) {
      ensureDirectory(target);
      try {linkSync(prior, target);} catch {copyFileSync(prior, target);}
    } else {
      if (!existsSync(input)) throw changedSource(path);
      const bytes = readFileSync(input);
      if (createHash("sha256").update(bytes).digest("hex") !== digest) {
        throw changedSource(path);
      }
      ensureDirectory(target);
      writeSourceSnapshot(target, bytes);
    }
    const retained = join(shared, digest);
    if (!existsSync(retained)) {
      try {linkSync(target, retained);} catch {copyFileSync(target, retained);}
    }
  }
  // Retain the proof separately: a missing/incomplete source directory may
  // only be backfilled from bytes this generation actually read.
  const record = join(generation, "source-inputs.json");
  let known = {};
  if (reuse) {
    const prior = JSON.parse(readFileSync(join(previous.generation, "source-inputs.json"), "utf8"));
    for (const [path, digest] of Object.entries(prior)) if (path.startsWith("gen/")) inputs[path] = digest;
  } else {
    try {known = JSON.parse(readFileSync(record, "utf8"));} catch {}
  }
  mkdirSync(generation, {recursive: true});
  writeFileSync(record, JSON.stringify(Object.fromEntries(Object.entries({...known, ...inputs}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
  writeFileSync(join(generation, "source-shared"), "1\n");
  return reuse === true;
}

// gen/ is derived input, so hashOf deliberately excludes it. It is stable
// after generators finish, and warm builds cannot change it.
export function keepGeneratedSources(root, generation, read = new Map()) {
  const digests = new Map(read);
  const walk = dir => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, {withFileTypes: true})) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.isFile()) {
        const key = file.replaceAll("\\", "/");
        digests.set(key, read.get(key) ?? createHash("sha256").update(readFileSync(file)).digest("hex"));
      }
    }
  };
  walk(join(root, "gen"));
  keepSourceInputs(root, generation, digests);
}

// Warm builds cannot change generated input. Reuse its retained digest map;
// legacy snapshots are migrated to the shared copies once.
export function linkGeneratedSources(root, previous, generation) {
  const record = join(generation, "source-inputs.json");
  const inputs = JSON.parse(readFileSync(record, "utf8"));
  let prior = {};
  try {prior = JSON.parse(readFileSync(join(previous, "source-inputs.json"), "utf8"));} catch {}
  const walk = (from, to) => {
    mkdirSync(to, {recursive: true});
    for (const entry of readdirSync(from, {withFileTypes: true})) {
      const input = join(from, entry.name), target = join(to, entry.name);
      if (entry.isDirectory()) walk(input, target);
      else if (entry.isFile()) {
        try {linkSync(input, target);} catch {copyFileSync(input, target);}
        const path = relative(join(generation, "source"), target).replaceAll("\\", "/");
        inputs[path] = prior[path] ?? createHash("sha256").update(readFileSync(input)).digest("hex");
        const shared = join(root, "build", "source-by-digest", inputs[path]);
        if (!existsSync(shared)) {try {linkSync(input, shared);} catch {copyFileSync(input, shared);}}
      }
    }
  };
  if (existsSync(join(previous, "source-shared"))) {
    for (const [path, digest] of Object.entries(prior)) if (path.startsWith("gen/")) inputs[path] = digest;
  } else {
    const from = join(previous, "source", "gen");
    if (!existsSync(from)) return;
    walk(from, join(generation, "source", "gen"));
  }
  writeFileSync(record, JSON.stringify(Object.fromEntries(Object.entries(inputs).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))));
}

export function completeSourceSnapshot(generation) {
  mkdirSync(join(generation, "source"), {recursive: true});
  writeFileSync(join(generation, "source", ".complete"), "1\n");
}

// Cold reproducibility comparisons use ordinary files, including when the
// generation being compared retained unchanged sources by shared digest.
export function materializeSourceSnapshot(root, generation) {
  if (!existsSync(join(generation, "source-shared"))) return;
  const inputs = JSON.parse(readFileSync(join(generation, "source-inputs.json"), "utf8"));
  const directories = new Set();
  for (const [path, digest] of Object.entries(inputs)) {
    const target = join(generation, "source", sourceSnapshotPath(path));
    if (existsSync(target)) continue;
    const shared = join(root, "build", "source-by-digest", digest);
    if (!existsSync(shared)) continue;
    const dir = dirname(target);
    if (!directories.has(dir)) {mkdirSync(dir, {recursive: true}); directories.add(dir);}
    try {linkSync(shared, target);} catch {copyFileSync(shared, target);}
  }
}

export function gcSourceInputs(root) {
  const shared = join(root, "build", "source-by-digest");
  if (!existsSync(shared)) return;
  const retained = new Set();
  const byInput = join(root, "build", "by-input");
  for (const entry of readdirSync(byInput, {withFileTypes: true})) {
    if (!entry.isDirectory()) continue;
    const generation = join(byInput, entry.name);
    if (!existsSync(join(generation, "source-shared"))) continue;
    try {
      for (const digest of Object.values(JSON.parse(readFileSync(join(generation, "source-inputs.json"), "utf8")))) retained.add(digest);
    } catch {return;} // Unreadable provenance must never make GC delete it.
  }
  for (const entry of readdirSync(shared)) if (!retained.has(entry)) rmSync(join(shared, entry));
}

function changedSource(path) {
  const error = new Error(`source changed while retaining generation input: ${path}`);
  error.code = "INPUT_CHANGED";
  return error;
}

// a generation that is already built keeps the source snapshot complete: the
// whole snapshot when it never finished, else only inputs it lacks
export function keepCachedSources(root, target, digests, overlay) {
  if (!existsSync(join(target, "source", ".complete"))) {
    keepSourceInputs(root, target, digests, undefined, overlay);
    keepGeneratedSources(root, target);
    completeSourceSnapshot(target);
  } else {
    const missing = missingSourceInputs(root, target, digests, overlay);
    if (missing.size) keepSourceInputs(root, target, missing, undefined, overlay);
  }
}
