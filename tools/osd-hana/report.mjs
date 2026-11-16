// The extract report: <out>/extract-report.md (the plain form a person reads)
// and the JSON document extract.mjs writes beside it. One source for both.
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

export function renderMdReport(doc) {
  const lines = [];
  const t = doc.totals;
  lines.push("# extract report");
  lines.push("");
  lines.push(`- out: \`${doc.out}\``);
  lines.push(`- dump: \`${doc.dump_dir}\`${doc.dump_reused ? " (reused: same request, sidecar exit 0)" : ""}`);
  lines.push(`- sidecar: ${doc.sidecar.version} (${String(doc.sidecar.commit).slice(0, 7)}), ${doc.sidecar.pinned ? "pinned" : "UNPINNED"}, sha256 ${doc.sidecar.sha256.slice(0, 12)}`);
  lines.push(`- request: \`${JSON.stringify(doc.request)}\``);
  lines.push(`- folder logic: ${doc.folder_logic.logic} -- ${doc.folder_logic.folders.map((f) => `${f.package} -> ${f.folder}`).join(", ")}`);
  lines.push(`- duration: ${(doc.duration_ms / 1000).toFixed(1)} s`);
  lines.push("");
  if (doc.notice) {
    lines.push(`> ${doc.notice}`);
    lines.push("");
  }
  lines.push("## per object type");
  lines.push("");
  lines.push("| type | in scope | written | skipped | unsupported |");
  lines.push("|---|---|---|---|---|");
  const types = new Map();
  for (const [type, v] of Object.entries(t.perType)) types.set(type, v);
  for (const p of doc.plan.perType) if (!types.has(p.type)) types.set(p.type, {inScope: p.inScope, written: 0, skipped: 0, unsupported: p.unsupported});
  for (const [type, v] of [...types.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const inScope = v.written + v.skipped + v.unsupported || v.inScope;
    lines.push(`| ${type}${SUPPORTED_TYPES.has(type) ? "" : " (unsupported)"} | ${inScope} | ${v.written ?? 0} | ${v.skipped ?? 0} | ${v.unsupported ?? 0} |`);
  }
  lines.push(`| total | ${t.inScope} | ${t.written} | ${t.skipped} | ${t.unsupported} |`);
  lines.push("");
  lines.push(`Totals: on the system ${t.onSystem}, dumped ${t.dumped}, in scope ${t.inScope} = written ${t.written} + skipped ${t.skipped} + unsupported ${t.unsupported}.`);
  lines.push("");
  lines.push(doc.sentence[0].toUpperCase() + doc.sentence.slice(1) + ".");
  if (t.notExtracted.length > 0) {
    lines.push("");
    lines.push("Not extracted, by type: " + t.notExtracted.map((x) => `${x.type} (${x.count})`).join(", ") + ".");
  }
  if (doc.objects.some((o) => o.status !== "written")) {
    lines.push("");
    lines.push("## objects not written");
    lines.push("");
    lines.push("| type | name | package | status | reason | state | generated |");
    lines.push("|---|---|---|---|---|---|---|");
    for (const o of doc.objects.filter((o) => o.status !== "written")) {
      lines.push(`| ${o.type} | ${o.name} | ${o.package} | ${o.status} | ${o.reason ?? ""} | ${o.state} | ${o.generated ? "yes" : ""} |`);
    }
  }
  if (doc.objects.some((o) => o.state !== "A")) {
    lines.push("");
    lines.push("Inactive content: " + doc.objects.filter((o) => o.state !== "A").map((o) => `${o.type} ${o.name} (${o.state})`).join(", ") + ".");
  }
  if (doc.errors.length > 0) {
    lines.push("");
    lines.push("## errors");
    lines.push("");
    for (const e of doc.errors) lines.push(`- ${JSON.stringify(e)}`);
  }
  if (doc.tpool_errors.length > 0) {
    lines.push("");
    lines.push("## text-pool problems");
    lines.push("");
    for (const e of doc.tpool_errors) lines.push(`- ${JSON.stringify(e)}`);
  }
  lines.push("");
  return lines.join("\n");
}
