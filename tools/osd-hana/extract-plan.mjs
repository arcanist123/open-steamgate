// The extract plan document and the consent gate -- carved out of extract.mjs
// (the size budget named the file) so the plan's rules have one home:
//
//   buildPlan     -- the listing becomes the plan: per type, per package, per
//                    AUTHOR for local objects (fix round 3, part B), the
//                    biggest packages, the byte estimate;
//   printPlan     -- the plan on the terminal, names escaped (SHOULD-6);
//   consentGate   -- nothing is dumped without the user having seen the plan
//                    (fix round 3, part B): on a terminal the command asks;
//                    a non-interactive run needs --yes; a LARGE plan needs
//                    --yes-large; --dry-run never asks (extract.mjs returns
//                    before this runs).
//
// LARGE_PLAN is the ONE place the large-plan numbers live: the prompt, the
// refusal messages and the README all quote it -- change it here or nowhere.
import {createInterface} from "node:readline";
import {SUPPORTED_TYPES} from "./convert/convert.mjs";
import {mainProgram} from "./convert/program.mjs";
import {sanitizeText} from "./report.mjs";

// A plan "above 5 000 objects or 200 MB" is LARGE (fix round 3, part B):
// strictly above -- 5 000 objects / 200 MB exactly still consent with --yes.
export const LARGE_PLAN = Object.freeze({objects: 5000, bytes: 200 * 1_000_000});

export const isLargePlan = (plan) =>
  plan.inScope > LARGE_PLAN.objects || plan.bytes > LARGE_PLAN.bytes;

const thousands = (n) => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
export const largePlanNumbers = () =>
  `${thousands(LARGE_PLAN.objects)} objects / ${thousands(LARGE_PLAN.bytes / 1_000_000)} MB`;

export const mbText = (b) => `${(b / 1_000_000).toFixed(1)} MB`;

// A listing row is LOCAL the way the sidecar's own classification is visible
// in the listing: a `$` package (TDEVC-DLVUNIT-LOCAL transportable packages
// are classified server-side and carry no `$`; the author table's subject is
// the scratch space, `$TMP` and friends -- exactly where several people's
// untransported work lives).
const isLocalRow = (r) => String(r.package ?? "").trim().toUpperCase().startsWith("$");

export function buildPlan(rows, allRows, unknownClassRows = []) {
  const perType = new Map();
  const perPackage = new Map();
  const perAuthor = new Map(); // local objects only (part B)
  const byType = new Map();
  const unknownSet = new Set(unknownClassRows);
  let bytes = 0;
  // the unknown-class rows are part of the selection and are accounted in the
  // plan's in-scope counts (the ledger will carry them as skipped), but they
  // contribute no bytes and are never dumped
  for (const r of [...rows, ...unknownClassRows]) {
    const t = perType.get(r.type) ?? {type: r.type, inScope: 0, bytes: 0, unsupported: 0, unknownClass: 0};
    t.inScope++;
    if (!SUPPORTED_TYPES.has(r.type)) t.unsupported++;
    if (unknownSet.has(r)) t.unknownClass++;
    perType.set(r.type, t);
    if (!rows.includes(r)) continue; // per-package/per-author/bytes stay classified-only
    const b = Number(r.source_bytes_compressed ?? 0);
    t.bytes += b;
    bytes += b;
    byType.set(r.type, (byType.get(r.type) ?? 0) + 1);
    const p = perPackage.get(r.package) ?? {package: r.package, objects: 0, bytes: 0};
    p.objects++;
    p.bytes += b;
    perPackage.set(r.package, p);
    if (isLocalRow(r)) {
      const a = String(r.author ?? "");
      const pa = perAuthor.get(a) ?? {author: a, objects: 0, bytes: 0};
      pa.objects++;
      pa.bytes += b;
      perAuthor.set(a, pa);
    }
  }
  return {
    onSystem: allRows.length,
    customer: allRows.filter((r) => r.class === "customer").length,
    sap: allRows.filter((r) => r.class === "sap").length,
    unknownClass: unknownClassRows.length,
    inScope: rows.length + unknownClassRows.length,
    bytes,
    perType: [...perType.values()].sort((a, b) => a.type.localeCompare(b.type)),
    perPackage: [...perPackage.values()].sort((a, b) => a.package.localeCompare(b.package)),
    // part B: the local objects' authors (the people whose scratch space the
    // default scope reads), and the three biggest packages -- the two views
    // the consent question is answered against
    perAuthor: [...perAuthor.values()].sort((a, b) => a.author.localeCompare(b.author)),
    localAuthors: perAuthor.size,
    biggest: [...perPackage.values()]
      .sort((a, b) => b.bytes - a.bytes || b.objects - a.objects || String(a.package).localeCompare(String(b.package)))
      .slice(0, 3),
    unsupportedTypes: [...perType.values()].filter((t) => t.unsupported > 0).map((t) => t.type),
  };
}

export function printPlan(io, plan) {
  // SHOULD-6: names from the database never reach the terminal raw -- a
  // control character in a package name could rewrite the plan the user is
  // about to act on. They are printed escaped, never interpreted.
  io.out(`plan: ${plan.inScope} objects in scope (system holds ${plan.onSystem}: ${plan.customer} customer, ${plan.sap} sap${plan.unknownClass ? `, ${plan.unknownClass} unknown class` : ""})`);
  io.out("  per type:");
  for (const t of plan.perType) {
    const mark = SUPPORTED_TYPES.has(t.type) ? "" : "  (unsupported -- will be listed, not written)";
    io.out(`    ${sanitizeText(t.type).padEnd(8)} ${String(t.inScope).padStart(6)}  ${mbText(t.bytes).padStart(10)}${mark}`);
  }
  io.out("  per package:");
  for (const p of plan.perPackage) io.out(`    ${sanitizeText(p.package).padEnd(32)} ${String(p.objects).padStart(6)}  ${mbText(p.bytes).padStart(10)}`);
  if (plan.perAuthor.length > 0) {
    io.out("  per author (local objects):");
    for (const a of plan.perAuthor) io.out(`    ${sanitizeText(a.author).padEnd(32)} ${String(a.objects).padStart(6)}  ${mbText(a.bytes).padStart(10)}`);
  }
  if (plan.biggest.length > 0) {
    io.out(`  biggest packages: ${plan.biggest.map((p) => `${sanitizeText(p.package)} (${p.objects}, ${mbText(p.bytes)})`).join(", ")}`);
  }
  if (plan.localAuthors > 1) {
    io.out(`  local objects of ${plan.localAuthors} authors are in scope; narrow with --author <name> or --no-local`);
  }
}

// ---- the dump request (fix round 3, part A: one function, measured) --------
// M-2 (critic round 2): nothing of the vendor's is fetched unless asked --
// the dump request NAMES the in-scope objects of the listing (exact names,
// LIKE-escaped, sorted, de-duplicated), never the user's patterns; the
// unknown-class rows are not fetched at all.
//
// THE COMPOSITE-SOURCE RULE, measured on the real bed and CONFIRMED there
// (fix round 3, w3fix3 run, sidecar v2.60.0-19-g0d5767b, pinned): an exact
// name fetches the TADIR row, the DDIC rows and a flat program's source --
// but NO sources for a class, interface or function group (11 052 objects
// came back `no-source` in the round-2 measurement; the round-3 run with
// these patterns brought every source back, 104 .abap files byte-identical
// to the first extract round, 0 `no-source` on objects that had sources).
// The sidecar's source fetch matches REPOSRC program names with the same
// patterns, and the sources hide behind:
//
//   CLAS / INTF / BDEF  -- the 30-character '='-padded name plus a suffix
//                          (ZCL_X==========================CS): send
//                          `<name padded to 30 with =>%`;
//   FUGR                -- the main program SAPL<grp> and the includes
//                          L<grp><suffix> -- sent as exact / shape patterns
//                          (round 5: see below; no bare `%` prefix).
//
// TADIR selection stays exact: a padded prefix names exactly one object, so
// the selection cannot widen.
//
// Fix round 5 (SHOULD-1): the include patterns are SHAPES, not bare
// prefixes. `L<grp>%` also prefixes a longer sibling group's includes
// (`LZA%` pulls `LZAB...`), and a source fetched for a sibling is foreign
// code on disk even when the converter would never write it. What was
// chosen, and why: the main program is sent EXACTLY (`SAPL<grp>` -- the main
// program IS that name, no `%` needed), and the includes are sent as their
// known shapes -- `L<grp>TOP`, `L<grp>UXX`, and `<letter>` + 2 or 3 LIKE
// wildcard characters (`L<grp>U__`, `L<grp>U___`) for the letters
// convert/program.mjs's groupSuffix accepts (U F I O P $ V T E). A shape
// cannot cross into a longer group's name: the letter position and the total
// length pin the match, so `ZOSG_X4`'s patterns cannot pull `ZOSG_X4_SUB`'s
// includes (their first character after the group name differs, or their
// length does). The price is request size -- 21 names per group instead of
// 3 -- which the 500-name chunking absorbs; the day the sidecar gains an
// exact `objects: [{type, name}]` request field (asked of its owner --
// schema 1 refuses the field today), the patterns go away and ONLY this
// function changes.
//
// `_` and `%` inside REAL object names never act as wildcards unnoticed:
// every literal is LIKE-escaped (`\_`, `\%`, `\\`) -- the real sidecar
// matches with `LIKE ? ESCAPE '\'` (checked in its binary's strings; the
// fake mirrors it), so an escaped underscore matches exactly that name.
// Only the wildcard `_`s appended HERE match one arbitrary character.
const GROUP_SUFFIX_LETTERS = Object.freeze(["U", "F", "I", "O", "P", "$", "V", "T", "E"]); // keep in step with convert/program.mjs groupSuffix
const exactNamePattern = (name) => String(name).trim().replace(/([%_\\])/g, "\\$1");

// A group's source patterns: the namespaced shape too -- /NS/GRP's main
// program is /NS/SAPLGRP and its includes /NS/LGRP... (the converter knows
// this; mainProgram is its helper) -- a group name carries its namespace.
function fugrSourcePatterns(rawName) {
  const m = /^(\/[^/]+\/)?(.+)$/.exec(rawName);
  const inc = `${m?.[1] ?? ""}L${m?.[2] ?? rawName}`;
  return [
    exactNamePattern(mainProgram(rawName)),
    exactNamePattern(`${inc}TOP`),
    exactNamePattern(`${inc}UXX`),
    ...GROUP_SUFFIX_LETTERS.flatMap((l) => [
      `${exactNamePattern(`${inc}${l}`)}__`,
      `${exactNamePattern(`${inc}${l}`)}___`,
    ]),
  ];
}

export function buildDumpRequest({rows, inactive = false}) {
  const sourcePatterns = [];
  const exactNames = [];
  for (const r of rows) {
    const name = String(r.name).trim().toUpperCase();
    exactNames.push(exactNamePattern(name));
    if (r.type === "CLAS" || r.type === "INTF" || r.type === "BDEF") {
      sourcePatterns.push(exactNamePattern(name.padEnd(30, "=")) + "%");
    } else if (r.type === "FUGR") {
      sourcePatterns.push(...fugrSourcePatterns(name));
    }
  }
  return {
    schema: 1,
    names: [...new Set(exactNames.concat(sourcePatterns))].sort(),
    inactive,
    catalog: true,
    ddic: true,
    provenance: "osd hana extract", // stable: the reuse fingerprint is the whole request, so nothing per-run may enter it
  };
}

// ---- consent (fix round 3, part B) -----------------------------------------
// Returns undefined to go on (consent given), or "declined" / "refused" --
// extract.mjs maps them to its own exit codes (0 / 1); the symbolic result
// keeps this module free of extract.mjs's constants.
//
//   terminal    -- ask: `extract N objects (S MB) into <out>? [y/N]`; y/yes
//                  proceeds, anything else (EOF included) declines. A LARGE
//                  plan says so in the question and needs the full "yes".
//   non-TTY     -- needs --yes; a LARGE plan needs --yes-large instead
//                  (a plain --yes is refused).
export async function consentGate({flags, io, stdin, isTTY, plan, out}) {
  const large = isLargePlan(plan);
  const size = `${plan.inScope} objects (${mbText(plan.bytes)})`;
  if (isTTY) {
    io.out(`extract ${size} into ${out}? [y/N]` + (large
      ? ` -- this plan is LARGE: above ${largePlanNumbers()}; answer "yes" (in full) to proceed, or abort and re-run non-interactively with --yes-large`
      : ""));
    const answer = String(await readAnswer(stdin) ?? "").trim().toLowerCase();
    if (!(large ? answer === "yes" : answer === "y" || answer === "yes")) {
      io.err(`osd hana extract: declined -- nothing was dumped (the output directory ${out} holds only this command's work area; the plan above stands).`);
      return "declined";
    }
    return undefined;
  }
  if (large && flags["yes-large"] !== true) {
    io.err(`osd hana extract: the plan is LARGE (${size} -- above ${largePlanNumbers()}): a non-interactive run needs --yes-large; a plain --yes is refused above ${largePlanNumbers()}.`);
    return "refused";
  }
  if (flags["yes"] === true || flags["yes-large"] === true) return undefined;
  io.err(`osd hana extract: nothing is dumped without consent: on a terminal the command asks after the plan; a non-interactive run needs --yes (--dry-run stops at the plan and never asks). The plan above is ${size} into ${out}.`);
  return "refused";
}

function readAnswer(stdin) {
  return new Promise((resolve) => {
    const rl = createInterface({input: stdin, terminal: false});
    let answered = false;
    rl.once("line", (l) => {
      answered = true;
      rl.close();
      resolve(l);
    });
    rl.once("close", () => {
      if (!answered) resolve(""); // EOF is a decline, never a dump
    });
  });
}
