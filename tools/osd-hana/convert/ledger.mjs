// The ledger (the fix round, critic M1/M2/M4 -- one principle, structural):
// the report is built from it. It is driven by THE LISTING: every in-scope
// object ends in EXACTLY ONE state -- written / written-partial /
// skipped:<reason> / unsupported -- and every PART of an object the converter
// knows it cannot write (a function module include missing from the dump,
// dynpros, a GUI status, variants, documentation, a text pool it left out) is
// a LINE under that object, never a silent gap. extract.mjs refuses exit 0
// unless the ledger accounts for the listing's in-scope count exactly.

export const LEDGER_STATES = Object.freeze(["written", "written-partial", "skipped", "unsupported"]);

// A part line's disposition:
//   "not written" -- the converter knows this part did not reach the output;
//   "not checked" -- the dump cannot even tell whether the object has this
//                    part, so saying nothing would claim a completeness the
//                    run does not have (critic M4: the dump carries no screen
//                    tables at all, verified against the real manifest).
export const PART_DISPOSITIONS = Object.freeze(["not written", "not checked"]);

// ---- name safety (attack 2 / N7 / N10) --------------------------------------
// One path component -- a package or an object name AFTER abapGit's folding
// (lower case, a namespace "/" becomes "#") -- reaches the disk only when
// this returns undefined. A dump is data, not input a user typed: a hostile
// or corrupt name must not traverse out of <out>/src, must not write a
// Windows-reserved device name, must not crash the write with an oversize or
// NUL-bearing component. Objects failing here are ledger-skipped, per object;
// the run continues and the report says why.
export function unsafeComponent(component) {
  if (component === "" || component === "." || component === "..") return "empty or relative name";
  if (component.includes("\\")) return "contains a backslash (a path separator on Windows)";
  if (/[\x00-\x1f\u007f]/.test(component)) return "contains a control character";
  if (/[<>:"|?*]/.test(component)) return "contains a character Windows refuses in file names";
  if (component.endsWith(".") || component.endsWith(" ")) return "ends with a dot or a space (stripped on Windows)";
  if (Buffer.byteLength(component, "utf8") > 255) return "longer than 255 bytes (not a usable file name)";
  const base = component.replace(/\.[^.]*$/, ""); // reserved even with an extension (CON.prog.abap)
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(base)) return "a Windows-reserved device name";
  return undefined;
}

// ---- the ledger --------------------------------------------------------------
export class Ledger {
  // rows: the in-scope listing rows -- the exact set the plan counted. One
  // entry per ROW (a listing anomaly carrying the same id twice is caught by
  // the case-collision rule below, not by a map).
  constructor(rows) {
    this.entries = rows.map((r) => ({
      id: `${r.type}:${r.name}`,
      type: r.type,
      name: r.name,
      package: r.package,
      status: undefined,
      reason: undefined,
      parts: [],
      files: [],
      state: r.state ?? "A",
      generated: r.generated === true,
    }));
  }

  // The case-collision rule (attack 2): objects whose ids differ only by case
  // would fold to ONE output path on a case-insensitive file system --
  // last-writer-wins would silently drop one of them. The first listing row
  // keeps the claim; the rest are refused AND listed, so nothing is lost
  // silently and nothing overwrites anything.
  markCaseCollisions() {
    const claims = new Map(); // uppercased id -> the surviving entry
    for (const e of this.entries) {
      const k = e.id.toUpperCase();
      if (!claims.has(k)) {
        claims.set(k, e);
        continue;
      }
      e.status = "skipped";
      e.reason = `name collision: ${e.id} differs from another in-scope object only by case -- refused, the other is written`;
    }
    return claims;
  }

  // The M1 backstop: entries never marked. By construction this is empty
  // (every path below sets a status); extract.mjs treats a non-empty result
  // as an internal error and refuses exit 0.
  unaccounted() {
    return this.entries.filter((e) => e.status === undefined);
  }
}
