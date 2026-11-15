// Two OData v2 JSON answers compared the way a reader of the wire would
// compare them: status, error code and message, every entry's keys and their
// order, every property value, the SET of properties an entry carries (so a
// `$select` that was not applied is a difference), `__count`, `__metadata`.
//
//   node tools/odata-read-diff.mjs <ours.body> <oracle.body> [--status <ours>,<oracle>]
//        [--expect-empty] [--normalise <rule>[,<rule>...]] [--prefix <ours>=<oracle>]
//   node tools/odata-read-diff.mjs --manifest <file> --ours <dir> --oracle <dir>
//        [--normalise ...] [--prefix ...]
//   node tools/odata-read-diff.mjs --capture <base-url> --manifest <file> --out <dir>
//   node tools/odata-read-diff.mjs --manifest-from-index <index.tsv>
//
// A capture folder holds `<id>.body` and `<id>.meta.json` ({status, method,
// url, contentType, ms}) per request; a folder without meta files may carry
// an `index.tsv` instead (first column the id, second the status: the form
// the milestone-2 oracle captures were written in). `--manifest-from-index`
// turns such an index into a manifest (origin and the sap-client /
// sap-language options taken off the URL, nothing else).
//
// The manifest (JSON):
//   {"normalise": ["uri-host"], "prefix": {"/sap/opu/odata/sap/": "/sap/opu/odata/NS/"},
//    "requests": [{"id": "03-list", "method": "GET", "url": "/sap/opu/odata/sap/S/Set?$top=5",
//                  "status": 200, "empty": false, "headers": {"accept": "application/json"}}]}
//
// Nothing is normalised unless it is declared, and every declared
// normalisation is COUNTED: the summary says how many differences each one
// removed ("normalised: uri-host 12, etag-form 0"). The rules:
//   uri-host      scheme://host:port of __metadata.uri / .id / __deferred.uri
//                 and of the uri of a __next link
//   uri-prefix    the path prefixes of `prefix` (ours -> oracle) in the same
//                 places (implied by --prefix / a manifest `prefix`)
//   etag-form     two __metadata.etag strings that are both non-empty compare
//                 equal (the form differs, the presence does not)
//   member-order  the same members in another JSON order compare equal
//                 (without it an order difference is listed: a parser does
//                 not care, a byte comparison does)
//
// Two rules that are not options, because the alternative is a false green:
//   - empty equals empty FAILS: two answers without a single entry are not
//     a match unless the request declares it expects an empty result
//     (`"empty": true`, or --expect-empty); an answer that the declaration
//     says is empty and is not, fails as well;
//   - an error answer (status >= 400 on either side, or an `error` member)
//     is compared by status, `error.code` and `error.message.value`, and only
//     those: the rest (transaction id, timestamp, inner error) is per call.
//     This is said in the output for every error comparison.
//
// Exit 0 when every request matched, 1 when one did not, 2 on usage errors.
// --capture sends GET and HEAD only and refuses a manifest naming anything
// else: it is a recorder, not a client.
import {existsSync, mkdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "./osd-main.mjs";

export const RULES = ["uri-host", "uri-prefix", "etag-form", "member-order"];

const ORIGIN = /^https?:\/\/[^/]+/;

/** The value the declared URI normalisations make of a string. */
function normaliseUri(value, opts) {
  let out = value;
  if (opts.rules.has("uri-host")) out = out.replace(ORIGIN, "<origin>");
  return out;
}

function applyPrefix(value, prefixes) {
  for (const [ours, oracle] of prefixes) {
    const at = value.indexOf(ours);
    if (at >= 0) return value.slice(0, at) + oracle + value.slice(at + ours.length);
  }
  return value;
}

const originOf = (value) => ORIGIN.exec(value)?.[0] ?? "";

const URI_KEYS = new Set(["uri", "id"]);

/** whether `path` (a JSON path) is a place where a URI normalisation applies */
function uriPlace(path, key) {
  if (key === "__next") return true;
  if (!URI_KEYS.has(key)) return false;
  return /\.__metadata$/.test(path) || /\.__deferred$/.test(path);
}

const short = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? "undefined" : (s.length > 140 ? `${s.slice(0, 137)}...` : s);
};

/** Deep comparison of two parsed JSON values; differences into `out`,
 *  normalisations that removed one counted into `counts`. */
function diffValue(a, b, path, key, opts, out, counts) {
  if (typeof a === "string" && typeof b === "string" && uriPlace(path, key)) {
    if (a === b) return;
    const na = applyPrefix(normaliseUri(a, opts), opts.prefixes);
    const nb = normaliseUri(b, opts);
    if (na === nb) {
      // counted per rule that was needed: a rule that changed nothing that
      // differed is not counted
      if (opts.rules.has("uri-host") && originOf(a) !== originOf(b)) counts["uri-host"] = (counts["uri-host"] ?? 0) + 1;
      if (normaliseUri(a, opts) !== na) counts["uri-prefix"] = (counts["uri-prefix"] ?? 0) + 1;
      return;
    }
    out.push(`${path}.${key}: ours ${short(a)} | oracle ${short(b)}`);
    return;
  }
  if (key === "etag" && /\.__metadata$/.test(path) && typeof a === "string" && typeof b === "string" && a !== b) {
    if (opts.rules.has("etag-form") && a !== "" && b !== "") {
      counts["etag-form"] = (counts["etag-form"] ?? 0) + 1;
      return;
    }
    out.push(`${path}.${key}: ours ${short(a)} | oracle ${short(b)}`);
    return;
  }
  const here = key === undefined ? path : `${path}.${key}`;
  if (typeof a !== typeof b || Array.isArray(a) !== Array.isArray(b) || (a === null) !== (b === null)) {
    out.push(`${here}: ours ${short(a)} | oracle ${short(b)}`);
    return;
  }
  if (Array.isArray(a)) {
    if (a.length !== b.length) out.push(`${here}: length ours ${a.length} | oracle ${b.length}`);
    for (let i = 0; i < Math.min(a.length, b.length); i++) diffValue(a[i], b[i], `${here}[${i}]`, undefined, opts, out, counts);
    return;
  }
  if (a !== null && typeof a === "object") {
    const ka = Object.keys(a);
    const kb = Object.keys(b);
    for (const k of kb) if (!(k in a)) out.push(`${here}.${k}: missing in ours (oracle ${short(b[k])})`);
    for (const k of ka) if (!(k in b)) out.push(`${here}.${k}: extra in ours (${short(a[k])})`);
    const orderA = ka.filter((k) => k in b).join(",");
    const orderB = kb.filter((k) => k in a).join(",");
    if (orderA !== orderB) {
      if (opts.rules.has("member-order")) counts["member-order"] = (counts["member-order"] ?? 0) + 1;
      else out.push(`${here}: member order ours [${orderA}] | oracle [${orderB}]`);
    }
    for (const k of ka) if (k in b) diffValue(a[k], b[k], here, k, opts, out, counts);
    return;
  }
  if (a !== b) out.push(`${here}: ours ${short(a)} | oracle ${short(b)}`);
}

/** the entries of a v2 JSON answer: d.results, d as a single entry, or [] */
export function entriesOf(json) {
  const d = json?.d;
  if (d === undefined || d === null || typeof d !== "object") return [];
  if (Array.isArray(d.results)) return d.results;
  if (Array.isArray(d)) return d;
  if (d.__metadata !== undefined) return [d];
  return [];
}

/** the key predicate of an entry, read off its __metadata.uri: Set('k') -> ('k') */
export function keyOf(entry) {
  const uri = String(entry?.__metadata?.uri ?? entry?.__metadata?.id ?? "");
  const m = /(\([^()]*\))\/?$/.exec(uri);
  return m ? m[1] : "?";
}

/** whether a JSON answer is empty: no entries, and no single value either */
function isEmptyAnswer(json, text) {
  if (json === undefined) return String(text ?? "").trim() === "";
  // a $count: zero is empty, any other number is a value
  if (typeof json === "number") return json === 0;
  if (json === null || typeof json !== "object") return false;
  if (json?.error !== undefined) return false;
  const d = json?.d;
  if (d === undefined || d === null) return true;
  if (Array.isArray(d.results)) return d.results.length === 0;
  if (Array.isArray(d.EntitySets)) return d.EntitySets.length === 0;
  return Object.keys(d).length === 0;
}

function parse(text) {
  try { return JSON.parse(text); } catch { return undefined; }
}

/** Compare one request's two answers.
 *  ours/oracle: {status, body (string)}; request: {id, empty}; opts from options(). */
export function compareAnswers(ours, oracle, request = {}, opts = options()) {
  const out = [];
  const counts = {};
  const notes = [];
  if (ours.status !== undefined && oracle.status !== undefined && Number(ours.status) !== Number(oracle.status)) {
    out.push(`status: ours ${ours.status} | oracle ${oracle.status}`);
  }
  if (request.status !== undefined && oracle.status !== undefined && Number(request.status) !== Number(oracle.status)) {
    out.push(`status: the manifest expects ${request.status}, the oracle answered ${oracle.status}`);
  }
  const ja = parse(ours.body);
  const jb = parse(oracle.body);
  const isError = Number(ours.status) >= 400 || Number(oracle.status) >= 400 || ja?.error !== undefined || jb?.error !== undefined;
  if (isError) {
    notes.push("error body: status, error.code and error.message.value compared, the rest of it is per call and is not");
    const ea = ja?.error;
    const eb = jb?.error;
    if (ea === undefined || eb === undefined) {
      if (ours.body !== oracle.body) out.push(`error body: ours ${ea === undefined ? "has no error member" : "has one"}, oracle ${eb === undefined ? "has no error member" : "has one"} (ours ${short(String(ours.body).slice(0, 200))} | oracle ${short(String(oracle.body).slice(0, 200))})`);
    } else {
      if (ea.code !== eb.code) out.push(`error.code: ours ${short(ea.code)} | oracle ${short(eb.code)}`);
      const ma = ea.message?.value ?? ea.message;
      const mb = eb.message?.value ?? eb.message;
      if (ma !== mb) out.push(`error.message: ours ${short(ma)} | oracle ${short(mb)}`);
    }
    return {ok: out.length === 0, differences: out, counts, notes, keys: {ours: [], oracle: []}};
  }
  const emptyOurs = isEmptyAnswer(ja, ours.body);
  const emptyOracle = isEmptyAnswer(jb, oracle.body);
  if (request.empty === true) {
    if (!emptyOracle) out.push("empty: the request is declared empty and the oracle answered entries");
    if (!emptyOurs) out.push("empty: the request is declared empty and ours answered entries");
  } else if (emptyOurs && emptyOracle) {
    out.push("empty: both answers are empty and the request does not declare an empty result -- empty equal to empty is not a match");
  }
  if (jb === undefined || ja === undefined) {
    if (jb === undefined && ja === undefined) {
      if (String(ours.body).trim() !== String(oracle.body).trim()) out.push(`text: ours ${short(String(ours.body).slice(0, 200))} | oracle ${short(String(oracle.body).slice(0, 200))}`);
    } else {
      out.push(`${ja === undefined ? "ours" : "the oracle's"} answer is not JSON and the other one is: ${short(String((ja === undefined ? ours : oracle).body).slice(0, 200))}`);
    }
    return {ok: out.length === 0, differences: out, counts, notes, keys: {ours: [], oracle: []}};
  }
  const keys = {ours: entriesOf(ja).map(keyOf), oracle: entriesOf(jb).map(keyOf)};
  if (keys.ours.join() !== keys.oracle.join()) {
    const same = [...keys.ours].sort().join() === [...keys.oracle].sort().join();
    out.push(same ? `keys: the same keys in another order: ours [${keys.ours.join(" ")}] | oracle [${keys.oracle.join(" ")}]`
      : `keys: ours [${keys.ours.join(" ")}] | oracle [${keys.oracle.join(" ")}]`);
  }
  diffValue(ja, jb, "$", undefined, opts, out, counts);
  return {ok: out.length === 0, differences: out, counts, notes, keys};
}

/** comparison options from declared rules and prefixes */
export function options({normalise = [], prefix = {}} = {}) {
  const rules = new Set(normalise);
  for (const rule of rules) if (!RULES.includes(rule)) throw new Error(`unknown normalisation ${rule}; the rules are ${RULES.join(", ")}`);
  const prefixes = Object.entries(prefix);
  if (prefixes.length > 0) rules.add("uri-prefix");
  return {rules, prefixes};
}

/** the summary line: every declared rule, with the differences it removed */
export function normalisedLine(opts, counts) {
  const declared = [...opts.rules];
  if (declared.length === 0) return "normalised: nothing (no rule declared)";
  return `normalised: ${declared.map((rule) => `${rule} ${counts[rule] ?? 0}`).join(", ")}`;
}

/** a capture folder's answer to one request: the body and its status */
export function readAnswer(dir, id) {
  const bodyFile = join(dir, `${id}.body`);
  if (!existsSync(bodyFile)) return undefined;
  const body = readFileSync(bodyFile, "utf8");
  const metaFile = join(dir, `${id}.meta.json`);
  if (existsSync(metaFile)) {
    const meta = JSON.parse(readFileSync(metaFile, "utf8"));
    return {status: meta.status, body};
  }
  const index = join(dir, "index.tsv");
  if (existsSync(index)) {
    const {rows, column} = readIndex(readFileSync(index, "utf8"));
    const row = rows.find((cols) => cols[column.id] === id);
    if (row !== undefined) return {status: column.status < 0 ? undefined : Number(row[column.status]), body};
  }
  return {status: undefined, body};
}

/** An index.tsv: its rows and its columns BY HEADER NAME. Two layouts
 *  exist (milestone 2: n, status, wall_s, bytes, accept, url; milestone 3:
 *  n, method, status, wall_s, bytes, request_headers, url), so a position
 *  is never assumed: a status read from the second column of the second
 *  layout is the method, and every status is NaN. */
export function readIndex(text) {
  const lines = String(text).replace(/\r/g, "").split("\n").filter((l) => l !== "");
  const header = lines[0].split("\t");
  const at = (name) => header.indexOf(name);
  const column = {id: Math.max(at("n"), at("id"), 0), method: at("method"), status: at("status"), url: at("url"),
    accept: at("accept"), headers: at("request_headers")};
  if (column.url < 0) throw new UsageError(`index.tsv has no url column (columns: ${header.join(", ")})`);
  return {header, column, rows: lines.slice(1).map((l) => l.split("\t"))};
}

/** The value of sap-client / sap-language most requests of an index use:
 *  the logon the capture ran with. A request with that value loses the
 *  option (the host under test has its own logon); one with ANOTHER value
 *  keeps it, because that value is what the request is about. */
function dominant(urls, name) {
  const counts = new Map();
  for (const url of urls) {
    const value = new RegExp(`[?&]${name}=([^&]*)`).exec(url)?.[1];
    if (value !== undefined) counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()].sort((x, y) => y[1] - x[1])[0]?.[0];
}

/** A manifest out of an index.tsv. Kept: the method (HEAD included), the
 *  request headers (`request_headers` as JSON, or the older `accept`
 *  column), the status by its column name, and every query option but a
 *  sap-client / sap-language equal to the capture's own logon. A request
 *  --capture cannot send (anything but GET and HEAD) is not dropped
 *  silently: it is listed under `left_out` with the reason. */
export function manifestFromIndex(text) {
  const {column, rows} = readIndex(text);
  const urls = rows.map((cols) => cols[column.url]);
  const logon = {"sap-client": dominant(urls, "sap-client"), "sap-language": dominant(urls, "sap-language")};
  const requests = [];
  const leftOut = [];
  for (const cols of rows) {
    const [path, query = ""] = cols[column.url].replace(ORIGIN, "").split("?");
    const kept = query.split("&").filter((p) => {
      if (p === "") return false;
      const [name, value = ""] = p.split("=");
      return !(name in logon) || value !== logon[name];
    }).join("&");
    const request = {id: cols[column.id], method: column.method < 0 ? "GET" : String(cols[column.method]).toUpperCase(),
      url: `${path}${kept === "" ? "" : "?" + kept}`};
    if (column.status >= 0) request.status = Number(cols[column.status]);
    const headers = {};
    if (column.accept >= 0 && cols[column.accept] !== "-" && cols[column.accept] !== "") headers.accept = cols[column.accept];
    if (column.headers >= 0 && cols[column.headers] !== "-" && cols[column.headers] !== "") {
      Object.assign(headers, JSON.parse(cols[column.headers]));
    }
    if (Object.keys(headers).length > 0) request.headers = headers;
    if (request.method !== "GET" && request.method !== "HEAD") leftOut.push({...request, reason: "--capture sends GET and HEAD only"});
    else requests.push(request);
  }
  return {normalise: [], logon, requests, ...(leftOut.length > 0 ? {left_out: leftOut} : {})};
}

/** Compare a manifest's requests across two capture folders. */
export function compareFolders(manifest, oursDir, oracleDir, opts) {
  const results = [];
  const counts = {};
  for (const request of manifest.requests) {
    const ours = readAnswer(oursDir, request.id);
    const oracle = readAnswer(oracleDir, request.id);
    if (ours === undefined || oracle === undefined) {
      results.push({id: request.id, ok: false, differences: [`missing capture: ${ours === undefined ? "ours" : ""}${ours === undefined && oracle === undefined ? " and " : ""}${oracle === undefined ? "oracle" : ""}`], counts: {}, notes: [], keys: {ours: [], oracle: []}});
      continue;
    }
    const verdict = compareAnswers(ours, oracle, request, opts);
    for (const [rule, n] of Object.entries(verdict.counts)) counts[rule] = (counts[rule] ?? 0) + n;
    results.push({id: request.id, status: {ours: ours.status, oracle: oracle.status}, ...verdict});
  }
  return {results, counts, ok: results.every((r) => r.ok)};
}

/** Record a manifest's answers from a running service: GET and HEAD only. */
export async function capture(base, manifest, outDir, {fetchImpl = fetch} = {}) {
  for (const request of manifest.requests) {
    const method = String(request.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") throw new Error(`capture sends GET and HEAD only; ${request.id} is ${method}`);
  }
  mkdirSync(outDir, {recursive: true});
  const written = [];
  for (const request of manifest.requests) {
    const method = String(request.method ?? "GET").toUpperCase();
    const t0 = Date.now();
    // the URL as written: no re-serialisation (URLSearchParams writes $top as %24top)
    const answer = await fetchImpl(`${base.replace(/\/$/, "")}${request.url}`, {method, headers: request.headers ?? {}});
    const body = method === "HEAD" ? "" : await answer.text();
    const ms = Date.now() - t0;
    writeFileSync(join(outDir, `${request.id}.body`), body);
    writeFileSync(join(outDir, `${request.id}.meta.json`), `${JSON.stringify({id: request.id, method, url: request.url,
      status: answer.status, contentType: answer.headers.get("content-type") ?? "", ms}, null, 1)}\n`);
    written.push({id: request.id, status: answer.status, bytes: body.length, ms});
  }
  return written;
}

function printResult(result, log) {
  const keys = result.keys.ours.length + result.keys.oracle.length > 0 ? `; keys ours ${result.keys.ours.length}, oracle ${result.keys.oracle.length}` : "";
  const status = result.status ? `ours ${result.status.ours}, oracle ${result.status.oracle}` : "";
  log(`== ${result.id}: ${result.ok ? "EQUAL" : "DIFFERENT"}${status ? ` (${status})` : ""}${keys}; ${result.differences.length} difference(s)`);
  for (const note of result.notes) log(`   (${note})`);
  for (const line of result.differences.slice(0, 60)) log(`   ${line}`);
  if (result.differences.length > 60) log(`   ... ${result.differences.length - 60} more`);
}

export async function main(argv, log = console.log) {
  const flag = (name) => { const i = argv.indexOf(`--${name}`); return i < 0 ? undefined : argv[i + 1]; };
  const all = (name) => argv.flatMap((a, i) => (a === `--${name}` ? [argv[i + 1]] : []));
  const fromIndex = flag("manifest-from-index");
  if (fromIndex !== undefined) {
    log(JSON.stringify(manifestFromIndex(readFileSync(fromIndex, "utf8")), null, 1));
    return 0;
  }
  const manifestFile = flag("manifest");
  const manifest = manifestFile === undefined ? undefined : JSON.parse(readFileSync(manifestFile, "utf8"));
  const base = flag("capture");
  if (base !== undefined) {
    if (manifest === undefined || flag("out") === undefined) throw new UsageError("--capture needs --manifest and --out");
    for (const w of await capture(base, manifest, flag("out"))) log(`captured ${w.id}: ${w.status}, ${w.bytes} bytes, ${w.ms} ms`);
    return 0;
  }
  const declared = [...(manifest?.normalise ?? []), ...all("normalise").flatMap((v) => String(v).split(",")).filter((v) => v !== "")];
  const prefix = {...(manifest?.prefix ?? {})};
  for (const pair of all("prefix")) {
    const at = String(pair).indexOf("=");
    if (at <= 0) throw new UsageError(`--prefix takes <ours>=<oracle>, not ${pair}`);
    prefix[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const opts = options({normalise: [...new Set(declared)], prefix});
  let verdict;
  if (manifest !== undefined) {
    if (flag("ours") === undefined || flag("oracle") === undefined) throw new UsageError("--manifest needs --ours <dir> and --oracle <dir> (or --capture)");
    verdict = compareFolders(manifest, flag("ours"), flag("oracle"), opts);
  } else {
    const files = positional(argv, ["status", "normalise", "prefix", "manifest", "ours", "oracle", "out", "capture"]);
    if (files.length !== 2) throw new UsageError("two answer files, or --manifest with --ours and --oracle");
    const [sa, sb] = String(flag("status") ?? ",").split(",");
    const ours = {status: sa === "" ? undefined : Number(sa), body: readFileSync(files[0], "utf8")};
    const oracle = {status: sb === "" || sb === undefined ? undefined : Number(sb), body: readFileSync(files[1], "utf8")};
    const one = compareAnswers(ours, oracle, {empty: argv.includes("--expect-empty")}, opts);
    verdict = {results: [{id: `${files[0]} vs ${files[1]}`, ...one}], counts: one.counts, ok: one.ok};
  }
  for (const result of verdict.results) printResult(result, log);
  const failed = verdict.results.filter((r) => !r.ok).length;
  log(normalisedLine(opts, verdict.counts));
  log(`${verdict.results.length - failed} of ${verdict.results.length} equal${failed > 0 ? `, ${failed} different` : ""}`);
  return verdict.ok ? 0 : 1;
}

export class UsageError extends Error {}

/** the arguments that are neither a flag nor a flag's value */
function positional(argv, valued) {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) {
      if (valued.includes(argv[i].slice(2))) i += 1;
      continue;
    }
    out.push(argv[i]);
  }
  return out;
}

if (runsAs("odata-read-diff.mjs")) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e?.message ?? e);
    process.exitCode = 2;
  }
}
