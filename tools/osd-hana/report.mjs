// The extract report: <out>/extract-report.md (the plain form a person reads)
// and the JSON document extract.mjs writes beside it. One source for both --
// the LEDGER: per object exactly one state, per unwritten/unchecked part a
// line under its object (critic M1/M2/M4, structural).
import {SUPPORTED_TYPES} from "./convert/convert.mjs";

/** The `--json` plan document (also the skeleton of the full report). */
export function planDocuments({plan, request, sidecar, out, dumpDir}) {
  return {
    schema: 1,
    out,
    dump_dir: dumpDir,
    request,
    sidecar,
    plan,
  };
}

const MB = 1_000_000;
const mb = (b) => `${(b / MB).toFixed(1)} MB`;

/** SHOULD-6 (critic round 2): names and reasons reach the report from the
 *  database and the dump; a control character must never land raw in the md
 *  (or on the terminal) where it could rewrite what the reader sees. Printed
 *  escaped, never interpreted. */
export const sanitizeText = (s) => String(s ?? "").replace(/[\x00-\x1f\x7f\x80-\x9f]/g, (c) => `\\x${c.charCodeAt(0).toString(16)}`);

export function renderMdReport(doc) {
  const lines = [];
  const t = doc.totals;
  lines.push("# extract report");
  lines.push("");
  lines.push(`- out: \`${doc.out}\``);
  lines.push(`- dump: \`${doc.dump_dir}\`${doc.dump_reused ? " (reused: same request, sidecar exit 0)" : ""}`);
  lines.push(`- sidecar: ${doc.sidecar.version} (${String(doc.sidecar.commit).slice(0, 7)}), ${doc.sidecar.pinned ? "pinned" : "UNPINNED"}, sha256 ${doc.sidecar.sha256.slice(0, 12)}`);
  lines.push(`- request: \`${JSON.stringify(doc.request)}\``);
  lines.push(`- folder logic: ${sanitizeText(doc.folder_logic.logic)} -- ${doc.folder_logic.folders.map((f) => `${sanitizeText(f.package)} -> ${sanitizeText(f.folder)}`).join(", ")}`);
  lines.push(`- duration: ${(doc.duration_ms / 1000).toFixed(1)} s`);
  lines.push("");
  if (doc.notice) {
    lines.push(`> ${doc.notice}`);
    lines.push("");
  }
  if (doc.unknown_class > 0) {
    lines.push(`> ${doc.unknown_class} listed objects have an unknown classification and were left out -- only the sidecar's exact customer class is in scope; the sidecar may be newer than this module.`);
    lines.push("");
  }
  lines.push("## per object type");
  lines.push("");
  lines.push("| type | in scope | written | written-partial | skipped | unsupported |");
  lines.push("|---|---|---|---|---|---|");
  const types = new Map();
  for (const p of doc.plan.perType) types.set(p.type, {inScope: p.inScope, written: 0, writtenPartial: 0, skipped: 0, unsupported: 0});
  for (const [type, v] of Object.entries(t.perType ?? {})) {
    const slot = types.get(type) ?? {inScope: 0, written: 0, writtenPartial: 0, skipped: 0, unsupported: 0};
    slot.written = v.written;
    slot.writtenPartial = v.writtenPartial;
    slot.skipped = v.skipped;
    slot.unsupported = v.unsupported;
    types.set(type, slot);
  }
  for (const [type, v] of [...types.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${type}${SUPPORTED_TYPES.has(type) ? "" : " (unsupported)"} | ${v.inScope} | ${v.written} | ${v.writtenPartial} | ${v.skipped} | ${v.unsupported} |`);
  }
  lines.push(`| total | ${t.inScope} | ${t.written} | ${t.writtenPartial} | ${t.skipped} | ${t.unsupported} |`);
  lines.push("");
  lines.push(`Totals: on the system ${t.onSystem}, dumped ${t.dumped}${t.dumped_in_scope !== undefined ? ` (${t.dumped_in_scope} of them in scope)` : ""}, in scope ${t.inScope} = written ${t.written} + written-partial ${t.writtenPartial} + skipped ${t.skipped} + unsupported ${t.unsupported}.`);
  lines.push("");
  if (doc.sentence) lines.push(doc.sentence[0].toUpperCase() + doc.sentence.slice(1) + ".");
  if (t.writtenPartial > 0) {
    lines.push("");
    lines.push("Note: program screens, GUI statuses and variants are not checked: the dump carries no screen/CUA/variant tables, so on every PROG/FUGR these parts read `not checked` rather than claiming completeness. Table CONTENTS are not extracted in this job; translated text pools and function documentation are part lines under their objects.");
  }
  if (doc.ddic_tables) {
    lines.push("");
    lines.push(`DD tables read: ${doc.ddic_tables.looked.join(", ")}.`);
    if (doc.ddic_tables.notCarried?.length > 0) lines.push(`not carried by this dump (their aspects read "not checked"): ${doc.ddic_tables.notCarried.join(", ")}.`);
  }
  if (t.notExtracted?.length > 0) {
    lines.push("");
    lines.push("Not fully extracted, by type: " + t.notExtracted.map((x) => `${x.type} (${x.count})`).join(", ") + ".");
  }
  const partial = doc.objects.filter((o) => o.status === "written-partial");
  if (partial.length > 0) {
    lines.push("");
    lines.push("## partially written objects");
    lines.push("");
    lines.push("The files are on disk; the parts below are what the dump could not give.");
    lines.push("");
    for (const o of partial) {
      lines.push(`- ${sanitizeText(o.type)} ${sanitizeText(o.name)} (${sanitizeText(o.package)}):`);
      for (const p of o.parts) lines.push(`  - ${sanitizeText(p.part)} -- ${sanitizeText(p.disposition)}: ${sanitizeText(p.reason)}`);
    }
  }
  const notWritten = doc.objects.filter((o) => o.status === "skipped" || o.status === "unsupported");
  if (notWritten.length > 0) {
    lines.push("");
    lines.push("## objects not written");
    lines.push("");
    lines.push("| type | name | package | status | reason | state | generated |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const o of notWritten) {
      lines.push(`| ${sanitizeText(o.type)} | ${sanitizeText(o.name)} | ${sanitizeText(o.package)} | ${o.status} | ${sanitizeText(o.reason ?? "")} | ${o.state} | ${o.generated ? "yes" : ""} |`);
    }
  }
  if (doc.drift && (doc.drift.appeared.length > 0 || doc.drift.disappeared.length > 0)) {
    lines.push("");
    lines.push("## Drift since the dump");
    lines.push("");
    lines.push("The dump was reused; the live listing differs from the dump's own object list:");
    lines.push("");
    if (doc.drift.appeared.length > 0) lines.push(`- appeared since the dump (listed, not in the dump -- skipped as not-in-dump): ${doc.drift.appeared.map(sanitizeText).join(", ")}`);
    if (doc.drift.disappeared.length > 0) lines.push(`- disappeared since the dump (in the dump, no longer listed -- not written): ${doc.drift.disappeared.map(sanitizeText).join(", ")}`);
  }
  if (doc.dump_errors?.length > 0 || doc.dump_partial === true) {
    lines.push("");
    lines.push("## dump errors");
    lines.push("");
    lines.push("The sidecar itself reported errors on this dump -- nothing is claimed complete; the named objects carry the error as a part line.");
    lines.push("");
    for (const e of doc.dump_errors ?? []) lines.push(`- ${typeof e === "string" ? e : JSON.stringify(e)}`);
    if (doc.dump_partial === true && (doc.dump_errors?.length ?? 0) === 0) lines.push("- the sidecar ended with exit 3 (partial) without naming objects");
  }
  if (doc.kept?.length > 0) {
    lines.push("");
    lines.push("## kept: files this run did not touch");
    lines.push("");
    lines.push("These files are on disk under `src/` (or as `.abapgit.xml`) and the marker of the last run does not vouch for them, so this run kept every byte and refused the objects that would have overwritten them. If they are yours, keep them; if they are leftovers of an interrupted run, remove the output directory and re-run.");
    lines.push("");
    for (const k of doc.kept) lines.push(`- ${k.path} -- ${k.why}`);
  }
  if (doc.errors.length > 0) {
    lines.push("");
    lines.push("## errors");
    lines.push("");
    for (const e of doc.errors) lines.push(`- ${JSON.stringify(e)}`);
  }
  if (doc.internal_error !== undefined) {
    lines.push("");
    lines.push("## internal error");
    lines.push("");
    lines.push(doc.internal_error);
  }
  if (doc.ledger_error !== undefined) {
    lines.push("");
    lines.push(`> LEDGER INVARIANT BROKEN: ${doc.ledger_error}`);
    lines.push("");
  }
  if (doc.objects.some((o) => o.state !== "A")) {
    lines.push("");
    lines.push("Inactive content: " + doc.objects.filter((o) => o.state !== "A").map((o) => `${sanitizeText(o.type)} ${sanitizeText(o.name)} (${o.state})`).join(", ") + ".");
  }
  lines.push("");
  return lines.join("\n");
}
