// Source bytes observed while constructing one generation. Publishing checks
// this record against the declared hash inputs; an unaccounted read is unknown.
import {createHash} from "node:crypto";
import {existsSync, readFileSync, realpathSync} from "node:fs";
import {basename, dirname, isAbsolute, join, relative, resolve, sep} from "node:path";

export const READS = "reads.json";
export const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = (message, code = "READ_RECORD") => { throw Object.assign(new Error(message), {code}); };
const inside = (root, path) => { const rel = relative(root, path); return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel); };
// The identity markers of one directory: [{name, marker, privacy, sha256}].
const markersIn = at => {
  const found = [];
  for (const name of [".osd-source.json", ".osd-layer.json"]) {
    const marker = join(at, name);
    if (!existsSync(marker)) continue;
    let bytes, data;
    try { bytes = readFileSync(marker); data = JSON.parse(bytes.toString("utf8")); } catch { fail(`invalid source identity: ${marker}`); }
    const privacy = name === ".osd-layer.json" ? data.private === true
      : typeof data.private === "boolean" ? data.private : null;
    found.push({name, marker, privacy, sha256: sha256(bytes)});
  }
  return found;
};
// memo: a Map from directory to its markers, for a caller that reads many
// files in one short life (a recorded generator); a gate passes none
const privateValue = (file, identity, memo) => {
  let value = false;
  let sourceIdentity = false;
  for (let at = dirname(file); ; at = dirname(at)) {
    let markers = memo?.get(at);
    if (markers === undefined) { markers = markersIn(at); memo?.set(at, markers); }
    for (const {name, marker, privacy, sha256: digest} of markers) {
      if (name === ".osd-source.json") sourceIdentity = true;
      identity.push({path: marker, sha256: digest});
      if (privacy === true) value = true;
      else if (privacy === null && value === false) value = null;
    }
    if (dirname(at) === at) break;
  }
  const cacheAt = file.indexOf(`${sep}.local${sep}url-libs${sep}`);
  if (cacheAt >= 0) {
    const before = file.slice(0, cacheAt + `${sep}.local${sep}url-libs${sep}`.length);
    const id = file.slice(before.length).split(sep)[0];
    if (!existsSync(join(before, id, ".osd-source.json"))) return value === true ? true : null;
  } else if (!sourceIdentity && dirname(file).split(sep).some(part => part.startsWith("osd-lib-"))) // a clone's directory, never a file's name
    return value === true ? true : null;
  return value;
};

export function readEntry(root, file, bytes, memo) {
  const real = realpathSync(file);
  const identities = [];
  const privacy = privateValue(real, identities, memo);
  const lexical = inside(root, resolve(file)) ? relative(root, resolve(file)).split(sep).join("/") : `external/${sha256(resolve(file)).slice(0, 16)}/${basename(file)}`;
  return {path: lexical, real, sha256: sha256(bytes), privacy, identities};
}

// The privacy of a real path's ancestry as it is now: for a gate, never cached.
export const privacyNow = real => privateValue(real, []);

// The privacy of a real path's ancestry, without recording its identities.
const ancestry = new Map();
// the markers of each directory, for the same process-long cache: a recorded
// generator is one short process, and a gate uses privacyNow instead
export const markerMemo = new Map();
export function privacyOf(real) {
  if (!ancestry.has(real)) ancestry.set(real, privateValue(real, [], markerMemo));
  return ancestry.get(real);
}

// The real path of a file that may not exist: its nearest existing ancestor's
// real path, and the rest as written.
export function realOf(file) {
  const path = resolve(file);
  if (existsSync(path)) return realpathSync(path);
  return dirname(path) === path ? path : join(realOf(dirname(path)), basename(path));
}

// A name seen rather than bytes read: a listing, a stat, an existence test.
// Nothing hashes it, so it never covers anything; it is written only when the
// ancestry is private or unknown, and then it only ever refuses.
export function metaEntry(root, file, seen, memo) {
  const real = realOf(file);
  const identities = [];
  const privacy = privateValue(real, identities, memo);
  const lexical = inside(root, resolve(file)) ? relative(root, resolve(file)).split(sep).join("/") : `external/${sha256(resolve(file)).slice(0, 16)}/${basename(file)}`;
  return {kind: "meta", path: lexical || ".", real, sha256: sha256(seen), privacy, identities};
}

// A generator child's log (tools/osd-generator-reads.mjs): source reads,
// reads it could not attribute, and the handshakes of recorded children.
export function readGeneratorLog(file) {
  const log = {entries: [], incomplete: [], tokens: new Set(), children: new Set()};
  if (!existsSync(file)) return log;
  // what a recorded process wrote before it is read again is derived (its
  // sources are recorded); in log order, so an older file's bytes still count
  const written = new Set();
  for (const line of readFileSync(file, "utf8").split("\n").filter(Boolean)) {
    const item = JSON.parse(line);
    if (typeof item.wrote === "string") written.add(item.wrote);
    else if (item.kind !== "meta" && typeof item.real === "string" && written.has(item.real)) continue;
    else if (typeof item.recorder === "string") log.tokens.add(item.recorder);
    else if (typeof item.child === "string") log.children.add(item.child);
    else if (item.incomplete === true) log.incomplete.push(String(item.path));
    else log.entries.push(item);
  }
  // a child process announced by a recorder owes its own handshake
  for (const child of log.children) if (!log.tokens.has(child)) log.incomplete.push(`child process ${child}: no recorder handshake`);
  return log;
}

// What a record could not see makes it incomplete, and stays so when remade.
export function markIncomplete(record, paths) {
  const all = [...new Set([...(record.incompleteReads ?? []), ...paths])].sort();
  return all.length ? Object.assign(record, {incomplete: true, incompleteReads: all}) : record;
}

// The seed capture's reads join the build's record: the build's own gaps
// stay, and a capture that recorded nothing was not recorded at all.
export function withSeedReads(root, hashed, old, seed) {
  return markIncomplete(makeReadRecord(root, hashed, [...old.reads, ...seed.entries]),
    [...old.incomplete ? old.incompleteReads ?? ["build"] : [], ...seed.incomplete, ...seed.entries.length ? [] : ["seed-capture.mjs: no reads"]]);
}

export function makeReadRecord(root, hashed, entries) {
  const byReal = new Map();
  for (const [file, digest] of hashed) {
    if (!existsSync(file)) continue;
    const real = realpathSync(file);
    const old = byReal.get(real);
    if (old !== undefined && old !== digest) fail(`conflicting hash for ${file}`);
    byReal.set(real, digest);
  }
  const unique = new Map();
  for (const entry of entries) unique.set(`${entry.path}\0${entry.real}`, entry);
  const reads = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path) || a.real.localeCompare(b.real));
  const uncovered = reads.filter(entry => entry.kind !== "meta" && byReal.get(entry.real) !== entry.sha256).map(entry => entry.path);
  return {schema: 1, root: resolve(root), reads, uncovered: [...new Set(uncovered)].sort()};
}

export function verifyReadRecord(root, generation, hashed) {
  const record = inspectReadRecord(root, generation);
  const current = new Map();
  for (const [file, digest] of hashed) if (existsSync(file)) current.set(realpathSync(file), digest);
  for (const entry of record.reads) {
    if (entry.kind === "meta") continue;
    if (current.get(readLocation(root, record.root, entry)) !== entry.sha256)
      fail(`generation read is not in current hash: ${entry.path}`, "UNKNOWN_PRIVACY");
  }
  return record;
}

function readLocation(root, priorRoot, entry) {
  const path = entry.path.startsWith("external/") ? entry.real : join(root, entry.path);
  if (!existsSync(path)) fail(`generation read is missing: ${entry.path}`, "UNKNOWN_PRIVACY");
  const actual = realpathSync(path);
  if (resolve(root) === priorRoot && actual !== entry.real)
    fail(`generation read target changed: ${entry.path}`, "UNKNOWN_PRIVACY");
  if (resolve(root) !== priorRoot && inside(priorRoot, entry.real) && !inside(root, actual))
    fail(`generation read target left its relocated tree: ${entry.path}`, "UNKNOWN_PRIVACY");
  return actual;
}

export function inspectReadRecord(root, generation) {
  let record;
  try { record = JSON.parse(readFileSync(join(generation, READS), "utf8")); }
  catch { fail("generation read record is missing or invalid"); }
  if (record.schema !== 1 || typeof record.root !== "string" || !isAbsolute(record.root)
      || !Array.isArray(record.reads) || !Array.isArray(record.uncovered)) fail("generation read record is invalid");
  if (record.incomplete) fail(`generation read record is incomplete${record.incompleteReads?.length ? `: ${record.incompleteReads.join(", ")}` : ""}`, "UNKNOWN_PRIVACY");
  if (record.uncovered.length) fail(`generation has reads outside its declared hash: ${record.uncovered.join(", ")}`, "UNKNOWN_PRIVACY");
  for (const entry of record.reads) {
    if (typeof entry.path !== "string" || entry.path === "" || isAbsolute(entry.path)
      || entry.path.split("/").some(part => part === ".." || part === ".")
      || typeof entry.real !== "string" || !isAbsolute(entry.real) || !/^[0-9a-f]{64}$/.test(entry.sha256)
      || ![true, false, null].includes(entry.privacy) || !Array.isArray(entry.identities)
      || ![undefined, "meta"].includes(entry.kind)) fail("generation read record is invalid");
    if (entry.privacy === true) fail(`generation read is private: ${entry.path}`, "PRIVATE_LAYER");
    if (entry.privacy === null) fail(`generation read has unknown privacy: ${entry.path}; rerun node tools/osd-fetch.mjs and rebuild before publishing`, "UNKNOWN_PRIVACY");
    const actual = readLocation(root, record.root, entry);
    if (existsSync(actual)) {
      const now = privateValue(actual, []);
      if (now === true) fail(`generation read is private: ${entry.path}`, "PRIVATE_LAYER");
      if (now === null) fail(`generation read has unknown privacy: ${entry.path}; rerun node tools/osd-fetch.mjs and rebuild before publishing`, "UNKNOWN_PRIVACY");
    }
    for (const identity of entry.identities) {
      if (typeof identity.path !== "string" || !isAbsolute(identity.path) || !/^[0-9a-f]{64}$/.test(identity.sha256))
        fail("generation read record is invalid");
      const path = resolve(root) !== record.root && inside(record.root, identity.path)
        ? join(root, relative(record.root, identity.path)) : identity.path;
      if (!existsSync(path) || sha256(readFileSync(path)) !== identity.sha256)
        fail(`source identity changed for ${entry.path}`, "UNKNOWN_PRIVACY");
    }
  }
  return record;
}
