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
