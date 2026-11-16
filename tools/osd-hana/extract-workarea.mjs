// The extract verb's work-area and dump-restart helpers -- carved out of
// extract.mjs (fix round 5, critic N5: the file had outgrown its budget and
// the audit additions were the next straw). One home for the rules that are
// pure filesystem + manifest arithmetic, no sidecar, no scope:
//
//   dumpRequestFingerprint / reusableDump -- when a dump on disk may be
//       reused (fix round 5: never when the scope audit marked it refused);
//   foreignOutEntries -- which entries of <out> this command may touch (M-5);
//   walkFiles / clearUnprotected / pruneEmptyDirs -- the src/ refresh that
//       never touches a kept file;
//   writeMarker -- the marker, atomic (fix round 5, M-2);
//   ensureGitignoreLine -- the `.osd-hana/` line, appended, never an
//       overwrite (fix round 6, SHOULD-1);
//   sha256File / readJsonl -- small readers.
import fs from "node:fs/promises";
import {readFileSync} from "node:fs";
import {createHash} from "node:crypto";
import path from "node:path";

/** Restart rule: an existing dump whose manifest echoes the same request and
 *  whose sidecar exit was 0 (no errors in the manifest block) is reused;
 *  anything else is refused, never mixed. A dump the scope audit refused
 *  (refused.json in the dump directory, fix round 5) is never reused either:
 *  the refusal names the directory to remove. The echo is compared on the
 *  request's SELECTION (schema, flags, provenance -- canonically, so key
 *  order of a re-writing sidecar cannot refuse a reuse, NOTE-6): the explicit
 *  `names` are derived from the live listing and may drift between runs --
 *  the drift logic (S4) reports what that means for the content. A chunked
 *  dump's aggregate manifest must list parts that are all readable. */
export function dumpRequestFingerprint(request) {
  const {names, ...rest} = request ?? {};
  return stableStringify(rest);
}

function stableStringify(v) {
  if (v === null || v === undefined) return "null";
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(",")}]`;
  if (typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

export async function reusableDump(dumpDir, request) {
  // Fix round 5 (M-1): a dump the scope audit refused is marked in its own
  // directory and NEVER reused -- the next run refuses it and names the
  // directory to remove, so "just run it again" cannot walk past the refusal.
  let refused;
  try {
    refused = JSON.parse(await fs.readFile(path.join(dumpDir, "refused.json"), "utf8"));
  } catch { /* not marked */ }
  if (refused !== undefined) {
    return {exists: true, ok: false, why: `it was refused by the scope audit (${refused.why ?? "out-of-scope content"}) -- remove the directory and re-run`};
  }
  let raw;
  try {
    raw = await fs.readFile(path.join(dumpDir, "manifest.json"), "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return {exists: false, ok: false};
    return {exists: true, ok: false, why: `the manifest is unreadable (${e.message})`};
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    return {exists: true, ok: false, why: `the manifest is not JSON (${e.message})`};
  }
  const block = manifest.sidecar;
  if (block === undefined) return {exists: true, ok: false, why: "the manifest has no sidecar block (an old or partial dump)"};
  if (dumpRequestFingerprint(block.request ?? null) !== dumpRequestFingerprint(request)) {
    return {exists: true, ok: false, why: "its manifest echoes a different request"};
  }
  if ((block.errors?.length ?? 0) > 0) return {exists: true, ok: false, why: `its manifest carries ${block.errors.length} errors`};
  if (block.counts === undefined) return {exists: true, ok: false, why: "the manifest carries no counts (the dump did not finish)"};
  for (const part of block.parts ?? []) {
    try {
      await fs.access(path.join(dumpDir, part, "objects.jsonl"));
    } catch {
      return {exists: true, ok: false, why: `its part ${part} is missing (a partial chunked dump)`};
    }
  }
  return {exists: true, ok: true, errors: block.errors ?? []};
}

export async function readJsonl(file) {
  const out = [];
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return out;
    throw e;
  }
  for (const line of text.split("\n")) if (line.trim()) out.push(JSON.parse(line));
  return out;
}

// M-5: entries of <out> this command may touch. ".osd-hana" is always the
// work area; every other name counts as ours only when the marker of a
// previous run exists -- a directory holding only src/ and .abapgit.xml is
// exactly the user's project that must be refused, not cleaned.
export async function foreignOutEntries(out, claimed) {
  let entries;
  try {
    entries = await fs.readdir(out);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const ours = new Set(claimed
    ? [".osd-hana", ".abapgit.xml", ".gitignore", "src", "extract-report.json", "extract-report.md"]
    // unclaimed: the work area, and a .gitignore -- the user's own file is
    // never overwritten, only the `.osd-hana/` line appended by a writing
    // run (fix round 6, SHOULD-1), so it does not make the directory foreign
    : [".osd-hana", ".gitignore"]);
  return entries.filter((e) => !ours.has(e));
}

export function sha256File(absPath) {
  return createHash("sha256").update(readFileSync(absPath)).digest("hex");
}

// visit every file under `root` (which may not exist) as `<prefix>/<rel>`
export async function walkFiles(root, prefix, visit) {
  let entries;
  try {
    entries = await fs.readdir(root, {withFileTypes: true});
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const e of entries) {
    const abs = path.join(root, e.name);
    const rel = `${prefix}/${e.name}`;
    if (e.isDirectory()) await walkFiles(abs, rel, visit);
    else if (e.isFile()) await visit(rel, abs);
  }
}

// delete everything under `root` EXCEPT the protected relative paths, then
// prune the directories left empty (M-5: kept files are never touched)
export async function clearUnprotected(root, protectedPaths) {
  const doomed = [];
  await walkFiles(root, "src", (rel, abs) => {
    if (!protectedPaths.has(rel)) doomed.push(abs);
  });
  for (const abs of doomed) await fs.rm(abs, {force: true});
  await pruneEmptyDirs(root);
}

async function pruneEmptyDirs(root) {
  let entries;
  try {
    entries = await fs.readdir(root, {withFileTypes: true});
  } catch (e) {
    if (e.code === "ENOENT") return;
    throw e;
  }
  for (const e of entries) {
    if (e.isDirectory()) await pruneEmptyDirs(path.join(root, e.name));
  }
  const left = await fs.readdir(root);
  if (left.length === 0) await fs.rmdir(root);
}

export async function writeMarker(markerPath, doc) {
  // atomic (fix round 5, M-2): temp + rename -- a crash mid-write leaves
  // either the old or the new marker, never a truncated one
  const tmp = `${markerPath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
  await fs.writeFile(tmp, `${JSON.stringify(doc, null, 1)}\n`);
  await fs.rename(tmp, markerPath);
}

// `<out>/.gitignore` must carry `.osd-hana/` (the raw dump never belongs in
// the repository) -- but the file may be the user's (fix round 6, SHOULD-1):
// created when absent, the line appended when missing (after a newline if
// the file does not end in one), nothing done when present. Called by a
// WRITING run only, at the commit point. Returns what it did:
// "created" | "appended" | "unchanged".
export async function ensureGitignoreLine(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    await fs.writeFile(file, ".osd-hana/\n", {flag: "wx"});
    return "created";
  }
  const has = text.split(/\r?\n/).some((l) => /^\/?\.osd-hana(?:\/(?:\*{1,2})?)?$/.test(l.trim()));
  if (has) return "unchanged";
  await fs.appendFile(file, `${text === "" || text.endsWith("\n") ? "" : "\n"}.osd-hana/\n`);
  return "appended";
}
