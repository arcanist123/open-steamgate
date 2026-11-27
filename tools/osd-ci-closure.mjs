// The shared build caches a CI archive carries: only what the public live
// generation reaches, each entry with its digest.
//
// build/source-by-digest and build/xref are shared by every generation the
// store keeps, private ones included, so neither is archived whole. The
// swap job's fast path (tools/gogen/osgo-fast.mjs, `osgo.mjs --fast`) reads
// exactly two things of them: the bytes of live's source inputs by digest
// (live's source-inputs.json) and live's cross-reference rows
// (build/xref/<cacheKey(root, {hash: live})>.json). Those, and nothing else,
// go into the archive, listed in CLOSURE and checked again where it is
// unpacked: a listed file must hold its digest, an unlisted one is refused.
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readdirSync, realpathSync} from "node:fs";
import {join, sep} from "node:path";
import {cacheKey} from "./osd-xref-seed.mjs";
import {sourceSnapshotPath} from "./osd-source-snapshot.mjs";

export const CLOSURE = ".local/ci-artifact/closure.json";
const SHARED = ["build/source-by-digest", "build/xref"];
const sha = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const fail = (message, code = "BAD_PROVENANCE") => { const error = new Error(`CI closure: ${message}`); error.code = code; throw error; };
// a shared cache reached through a link out of the tree is not the tree's
function insideRoot(root) {
  const top = realpathSync(root);
  for (const dir of ["build", ...SHARED]) {
    if (existsSync(join(root, dir)) && !`${realpathSync(join(root, dir))}${sep}`.startsWith(`${top}${sep}`)) fail(`${dir} leaves the tree`);
  }
}

/** {schema, generation, files: {path: sha256}} for the live generation `hash`.
 *  Fails with CLOSURE_INCOMPLETE when the fast path would lose an input:
 *  a source of live's in neither the shared store nor live's own snapshot,
 *  or (requireXref) live's cross-reference rows. */
export async function ciClosure(root, hash, {requireXref = false} = {}) {
  insideRoot(root);
  const files = {};
  let inputs;
  try { inputs = JSON.parse(readFileSync(join(root, "build/by-input", hash, "source-inputs.json"), "utf8")); }
  catch { fail("live's source-inputs.json is missing or malformed", "CLOSURE_INCOMPLETE"); }
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
    fail("live's source-inputs.json is malformed", "CLOSURE_INCOMPLETE");
  for (const [key, digest] of Object.entries(inputs ?? {}).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) fail(`invalid source digest in live's source-inputs.json: ${digest}`);
    const path = `build/source-by-digest/${digest}`;
    if (Object.hasOwn(files, path)) continue;
    if (!existsSync(join(root, path))) {
      // live's own snapshot under source/ travels with the generation
      const snapshot = join(root, "build/by-input", hash, "source", sourceSnapshotPath(key));
      if (existsSync(snapshot)) {
        if (sha(snapshot) !== digest) fail(`live's snapshot for ${key} differs from its digest`, "CLOSURE_INCOMPLETE");
        continue;
      }
      fail(`${key} (${digest}) is in neither build/source-by-digest nor live's snapshot: the fast path would lose it`, "CLOSURE_INCOMPLETE");
    }
    if (sha(join(root, path)) !== digest) fail(`${path} does not hold the bytes it is named by`);
    files[path] = digest;
  }
  const key = await cacheKey(root, {hash});
  const xref = key === undefined ? undefined : `build/xref/${key}.json`;
  if (xref !== undefined && existsSync(join(root, xref))) files[xref] = sha(join(root, xref));
  else if (requireXref) fail(`live's cross-reference rows (${xref ?? "no cache key"}) are missing: the fast path would parse the tree`, "CLOSURE_INCOMPLETE");
  return {schema: 1, generation: hash, files};
}

/** where the archive was unpacked: exactly the listed files, each its digest */
export function verifyCiClosure(root, live) {
  let closure;
  try { closure = JSON.parse(readFileSync(join(root, CLOSURE), "utf8")); }
  catch { fail(`${CLOSURE} is missing or invalid`); }
  if (closure?.schema !== 1 || typeof closure.files !== "object" || closure.files === null) fail(`${CLOSURE} is incomplete`);
  if (closure.generation !== live) fail(`listed for generation ${closure.generation}, live is ${live}`);
  insideRoot(root);
  for (const [path, digest] of Object.entries(closure.files)) {
    if (!SHARED.some(dir => path.startsWith(`${dir}/`)) || path.includes("..")) fail(`unexpected listed path ${path}`);
    if (!existsSync(join(root, path)) || sha(join(root, path)) !== digest) fail(`${path} differs from its listed digest`);
  }
  for (const dir of SHARED) {
    if (!existsSync(join(root, dir))) continue;
    for (const name of readdirSync(join(root, dir))) {
      if (!Object.hasOwn(closure.files, `${dir}/${name}`)) fail(`${dir}/${name} is not in the public closure`);
    }
  }
  return closure;
}
