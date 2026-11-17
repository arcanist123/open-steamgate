// The sidecar's dictionary closure (manifest `closure.resolved`, v2.62.1):
// what the scope audit allows beyond the scope, and what it refuses. The
// closure is bounded -- only dictionary kinds, as rows without source files
// (the W0 contract: "DDIC kinds add their closure"; MSAG is fetched by name).

/** The closure allowance of a dump: TYPE:NAME for every name the sidecar's
 *  dictionary closure resolved (manifest `closure.resolved`, per kind). A
 *  manifest without the block allows nothing extra. */
export function closureAllowance(manifest) {
  const allowed = new Set();
  const resolved = manifest?.closure?.resolved;
  if (resolved === null || typeof resolved !== "object") return allowed;
  for (const [kind, names] of Object.entries(resolved)) {
    if (!Array.isArray(names) || !CLOSURE_KINDS.includes(String(kind).trim().toUpperCase())) continue;
    for (const n of names) allowed.add(`${String(kind).trim().toUpperCase()}:${String(n ?? "").trim().toUpperCase()}`);
  }
  return allowed;
}

/** The kinds a dictionary closure may add (W0 contract: "DDIC kinds add
 *  their closure"; MSAG is fetched by name, never by the closure). */
export const CLOSURE_KINDS = ["DOMA", "DTEL", "TABL", "TTYP", "SHLP", "VIEW"];

/** Every closure entry whose kind the closure may not add, as TYPE:NAME. */
export function closureOutOfBounds(manifest) {
  const bad = [];
  const resolved = manifest?.closure?.resolved;
  if (resolved === null || typeof resolved !== "object") return bad;
  for (const [kind, names] of Object.entries(resolved)) {
    const k = String(kind).trim().toUpperCase();
    if (CLOSURE_KINDS.includes(k)) continue;
    for (const n of Array.isArray(names) ? names : [names]) bad.push(`${k}:${String(n ?? "").trim().toUpperCase()}`);
  }
  return bad;
}

/** The parts' closures, merged per kind (sorted, no duplicates). */
export function mergeResolved(closures) {
  const merged = {};
  for (const c of closures) {
    for (const [kind, names] of Object.entries(c?.resolved ?? {})) {
      if (!Array.isArray(names)) continue;
      const set = new Set(merged[kind] ?? []);
      for (const n of names) set.add(n);
      merged[kind] = [...set].sort();
    }
  }
  return merged;
}
