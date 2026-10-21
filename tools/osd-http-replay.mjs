// A service that is not ours, answered from what another system once said.
//
// `tools/osd-remote-service.mjs` answers a foreign OData service by asking
// the system that has it. That needs the system. This answers the same
// paths from **fixtures**: one file per request, recorded from a reference
// system, so a page this system serves can read that service on a laptop
// with no network -- the RFC capture/replay of `tools/rfc-replay.mjs`, for
// HTTP. The modes are RFC's, named the same, in the same file
// (`.local/destinations.json`), because one system should not speak two
// vocabularies for one idea:
//
//   {"destinations": {"REF": {"type": "http", "mode": "replay",
//                             "fixtures": ".local/replay/ref"}},
//    "services": {"SOME_FOREIGN_SRV": "REF"}}
//
//   live      ask the system (osd-remote-service, unchanged)
//   replay    answer from the fixtures, never the network
//   fallback  ask the system; when it cannot be reached, answer from the
//             fixtures. A read waits `timeout` ms (5000); a write is never
//             cut short, and after it went out a failure is a 504, not the
//             fixtures (replayService). A destination without a url is replay.
//   record    stage 2, refused at mount and said so
//
// A local service of the same name always wins, as it does for live: the
// fixtures are a stand-in for a system, never a shadow over this one.
//
// **Stage 1 reads.** GET, HEAD, the CSRF fetch, and `$batch` whose parts are
// GETs. A changeset, or any modifying request, is refused **explicitly**
// (501, `sap-osd-replay: refused`): writing into a replayed set means merging
// rows, `$count`, `$skiptoken` and ETags across two sources, which is another
// OData engine and its own design (stage 3), not something to fake here.
//
// **A miss is loud.** A request no fixture answers is a 404 with
// `sap-osd-replay: miss` and a line on stderr. Answering it with an empty
// collection or `$count` 0 -- what the first version of this did, in a stand
// outside this repository -- makes a hole in the recording read as "there is
// no data", which is the one wrong answer that looks right. A destination
// may ask for that softer answer with `"onMiss": "empty"`; it is still
// marked a miss and still logged.
//
// Fixture format, one JSON file per request, anywhere under a fixtures
// folder (sub-folders are only for people):
//
//   {
//     "key": {
//       "method": "GET",
//       "service": "SOME_FOREIGN_SRV",          // ;v=0002 kept, ;v=0001 dropped
//       "path": "OrderSet('42')/to_Items",      // service-relative
//       "query": "$filter=Status eq 'A'&$top=20" // normalised, see replayKey
//     },
//     "response": {
//       "status": 200,
//       "headers": {"content-type": "application/json", "dataserviceversion": "2.0"},
//       "body": {"d": {"results": []}}         // a string, or JSON, sent as JSON
//     }
//   }
//
// `key.query` may be written as the browser sent it: it is normalised on
// load the same way a request is. A body may carry the placeholders of
// RFC replay -- `{{now:YYYYMMDD}}`, `{{seq:NAME}}`, `{{param:$top}}` (a
// query option of the request), `{{sql:SELECT ...}}` -- filled per answer by
// the same code (tools/rfc-replay.mjs `substitute`), so nothing is invented
// twice.
//
// **Matching is exact, unless a destination or a fixture says otherwise.**
// A Fiori list asks for `$top` by the height of the window and for the
// `$select`/`$orderby` of the variant, so one recording is asked for in many
// spellings. `"match": {"ignore": ["$top", "$select", "$orderby"]}` on a
// destination (or on one fixture, which then overrides it) lets a request
// that differs from a recording only in those options be answered by it.
// An exact key always wins. `$skip` and `$skiptoken` are never ignored --
// page two answered with page one is the wrong answer that looks right --
// and `$skip=0` is the same request as no `$skip`; parentheses around a
// whole `$filter` are dropped from every key. When `$top` was ignored,
// the recorded rows are cut to the `$top` asked for, so a page never gets
// more rows than it asked for; among several recordings that differ only in
// `$top`, the smallest one that holds enough rows answers.
//
// **A miss names what was nearest.** The line on stderr carries the
// recording at the same path whose query differs in the fewest options, and
// the options themselves; inside a `$batch` it carries the part's number and
// request line. The misses of a run are kept (`misses()`), served as
// `/sap/bc/osd/replay/misses` by the host, and `osd replay-promote` turns one
// into a fixture from its nearest recording (tools/osd-replay-misses.mjs).
//
// Fixtures recorded from a real system carry its data. They live under
// `.local/` or a gitignored folder of a private pack and never in a tracked
// path; a fixtures folder outside `.local/` is named at mount so nobody
// finds out from a leak scan.
import {existsSync, readdirSync, readFileSync, statSync} from "node:fs";
import {randomBytes} from "node:crypto";
import {isAbsolute, join, relative, resolve, sep} from "node:path";
import {substitute} from "./rfc-replay.mjs";

export const MODES = ["live", "replay", "fallback", "record"];

// what a fixture's headers may put on an answer: the ones a UI5 model reads.
// A recorded set-cookie or CSRF token belongs to a session that is gone.
const FROM_FIXTURE = ["content-type", "dataserviceversion", "etag", "sap-message", "location"];

const REASONS = {200: "OK", 201: "Created", 202: "Accepted", 204: "No Content", 206: "Partial Content",
  304: "Not Modified", 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found",
  405: "Method Not Allowed", 409: "Conflict", 412: "Precondition Failed", 428: "Precondition Required",
  500: "Internal Server Error", 501: "Not Implemented", 502: "Bad Gateway", 503: "Service Unavailable",
  504: "Gateway Timeout"};

export const ON_MISS = ["error", "empty"];

// percent-decoding only: a `+` is a `+`. A page sends a space as %20 and a
// plus as %2B, and a fixture written readably -- `Set('A+B')`, `$filter=N eq
// 'A+B'` -- must mean what it says rather than turn into a space
const decode = (s) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

const isHex = (c) => (c >= 48 && c <= 57) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

// guid'000D3A06598…' and guid'000d3a06-5988-…' are the same key; a page
// sends whichever its model happened to hold. Scanned, not matched: each
// `guid'` literal is read to its closing quote and rewritten only when it
// is 32 hex digits with or without dashes
function guids(text) {
  const lower = text.toLowerCase();
  let out = "";
  let from = 0;
  for (let at = lower.indexOf("guid'"); at >= 0; at = lower.indexOf("guid'", from)) {
    const start = at + 5;
    const end = text.indexOf("'", start);
    if (end < 0) {
      break;
    }
    let hex = "";
    let ok = true;
    for (let i = start; i < end && ok; i += 1) {
      const c = text.charCodeAt(i);
      if (isHex(c)) {
        hex += text[i].toLowerCase();
      } else if (c !== 45) {
        ok = false;
      }
    }
    out += text.slice(from, at);
    out += ok && hex.length === 32
      ? `guid'${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}'`
      : text.slice(at, end + 1);
    from = end + 1;
  }
  return out + text.slice(from);
}

/** `SRV;v=0002;o=SID` -> `SRV;v=0002`; version 1 is the default and is
 *  dropped, the origin is routing and not part of what was asked */
export function serviceKey(segment) {
  const [name, ...matrix] = decode(segment).split(";");
  let version;
  for (const m of matrix) {
    const [k, v = ""] = m.split("=");
    const digits = v.trim();
    if (k.trim().toLowerCase() === "v" && digits !== "" && [...digits].every((c) => c >= "0" && c <= "9")) {
      version = String(Number(digits));
    }
  }
  return version === undefined || version === "1" ? name.toUpperCase() : `${name.toUpperCase()};v=${version.padStart(4, "0")}`;
}

/** A query string as [name, value] pairs, split at `&` and at the first `=`
 *  -- but never inside a single-quoted OData literal, where a hand-written
 *  fixture may well have `$filter=Name eq 'A&B'` (a page sends %26). An
 *  escaped quote inside a literal is two quotes, which toggles twice. */
export function queryPairs(query) {
  const text = query.startsWith("?") ? query.slice(1) : query;
  const pieces = [];
  let current = "";
  let quoted = false;
  for (const ch of text) {
    if (ch === "'") {
      quoted = !quoted;
    }
    if (ch === "&" && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  pieces.push(current);
  return pieces.filter((p) => p !== "").map((kv) => {
    const i = kv.indexOf("=");
    return i < 0 ? [decode(kv), ""] : [decode(kv.slice(0, i)), decode(kv.slice(i + 1))];
  });
}

/** The query as a key: decoded, `sap-*` dropped (client, language, cache
 *  buster: routing, not the question), sorted. `$skiptoken` stays -- two
 *  pages are two answers, and dropping it would serve page one for both. */
export function queryKey(query, ignore = NOTHING) {
  return queryEntries(query, ignore).map(([k, v]) => `${k}=${v}`).sort().join("&");
}

const NOTHING = new Set();

/** The query as normalised [name, value] pairs, in request order: `sap-*`
 *  dropped, guids in one spelling, `$skip=0` dropped (it is no `$skip`),
 *  and the options named in `ignore` (lower case) dropped. */
export function queryEntries(query, ignore = NOTHING) {
  return queryPairs(query ?? "")
    .filter(([k, v]) => {
      const name = k.toLowerCase();
      return !name.startsWith("sap-") && !ignore.has(name) && !(name === "$skip" && v.trim() === "0");
    })
    .map(([k, v]) => [k, k.toLowerCase() === "$filter" ? outerParens(guids(v)) : guids(v)]);
}

/** `(A or B)` -> `A or B`: parentheses around the whole of a `$filter` say
 *  nothing, and pages differ in whether they send them. Scanned, quotes
 *  respected (a `'` inside a literal is two); a pair is dropped only when
 *  the first `(` closes at the very end -- `(A) or (B)` keeps both. */
function outerParens(text) {
  let t = text.trim();
  for (;;) {
    if (!t.startsWith("(") || !t.endsWith(")")) {
      return t;
    }
    let depth = 0;
    let quoted = false;
    let closes = -1;
    for (let i = 0; i < t.length && closes < 0; i += 1) {
      const c = t[i];
      if (c === "'") {
        quoted = !quoted;
      } else if (!quoted && c === "(") {
        depth += 1;
      } else if (!quoted && c === ")") {
        depth -= 1;
        if (depth === 0) {
          closes = i;
        }
      }
    }
    if (closes !== t.length - 1) {
      return t;
    }
    t = t.slice(1, -1).trim();
  }
}

/** `/a/b/` -> `a/b` */
function trimSlashes(path) {
  let start = 0;
  let end = path.length;
  while (start < end && path[start] === "/") {
    start += 1;
  }
  while (end > start && path[end - 1] === "/") {
    end -= 1;
  }
  return path.slice(start, end);
}

/** One string per request: what a fixture is found by. */
export function replayKey({method, service, path, query}, ignore = NOTHING) {
  return `${pathKey({method, service, path})}?${queryKey(query, ignore)}`;
}

/** The part of the key before the query: method, service and path. */
export function pathKey({method, service, path}) {
  return `${method.toUpperCase()} ${serviceKey(service)}/${guids(trimSlashes(decode(path ?? "")))}`;
}

export const ODATA_ROOT = "/sap/opu/odata/sap/";

/** `/sap/opu/odata/sap/SRV;v=2/Set?x` -> {service, path, query}, or undefined */
export function splitUrl(url) {
  const q = url.indexOf("?");
  const [pathname, query] = q < 0 ? [url, ""] : [url.slice(0, q), url.slice(q + 1)];
  if (!pathname.toLowerCase().startsWith(ODATA_ROOT)) {
    return undefined;
  }
  const rest = pathname.slice(ODATA_ROOT.length);
  const slash = rest.indexOf("/");
  const service = slash < 0 ? rest : rest.slice(0, slash);
  return service === "" ? undefined : {service, path: slash < 0 ? "" : rest.slice(slash + 1), query};
}

function* jsonFiles(dir) {
  for (const entry of readdirSync(dir).sort()) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) {
      yield* jsonFiles(p);
    } else if (entry.endsWith(".json")) {
      yield p;
    }
  }
}

/** Every fixture under the folders, keyed. The first folder wins, so a newer
 *  recording listed first shadows an older one; within one folder a second
 *  file for the same key is named and ignored rather than silently won. */
export function loadFixtures(folders, {say = console.error} = {}) {
  const out = new Map();
  for (const folder of [].concat(folders)) {
    if (!existsSync(folder)) {
      say(`osd-http-replay: fixtures folder ${folder} does not exist`);
      continue;
    }
    const mine = new Set();
    for (const file of jsonFiles(folder)) {
      let fixture;
      try {
        fixture = JSON.parse(readFileSync(file, "utf8"));
      } catch (error) {
        say(`osd-http-replay: ${file}: ${error.message} -- skipped`);
        continue;
      }
      if (fixture?.key?.method === undefined || fixture.key.service === undefined || fixture.response?.status === undefined) {
        say(`osd-http-replay: ${file} has no key.method, key.service or response.status -- skipped`);
        continue;
      }
      const key = replayKey(fixture.key);
      if (mine.has(key)) {
        say(`osd-http-replay: ${file} repeats ${key} within ${folder} -- the first file wins`);
        continue;
      }
      mine.add(key);
      if (!out.has(key)) {
        // whether the body has placeholders is decided once, here: walking a
        // large JSON body on every answer to find none costs more than the
        // answer (measured, 290 ms for 20k rows)
        const body = fixture.response.body ?? "";
        const dynamic = (typeof body === "string" ? body : JSON.stringify(body)).includes("{{");
        out.set(key, {...fixture, file, dynamic});
      }
    }
  }
  return out;
}

const errorBody = (code, value) => JSON.stringify({error: {code, message: {lang: "en", value}}});

/** The answer the soft `onMiss: "empty"` gives: an empty set, a zero count,
 *  and still a 404 for one entity, because an entity that is not there is
 *  not an empty entity. */
function emptyAnswer(path) {
  const last = trimSlashes(path).split("/").pop() ?? "";
  if (last === "$count") {
    return {status: 200, headers: {"content-type": "text/plain"}, body: "0"};
  }
  if (last !== "" && !last.startsWith("$") && !last.includes("(")) {
    return {status: 200, headers: {"content-type": "application/json", "dataserviceversion": "2.0"}, body: '{"d":{"results":[]}}'};
  }
  return undefined;
}

// options a match may never ignore: two pages are two answers
const NEVER_IGNORED = ["$skip", "$skiptoken"];

/** a `match` as the set of options it ignores, lower case; what it may not
 *  ignore is dropped and said, so a stand cannot quietly serve page one for
 *  page two */
function ignoreOf(match, where, say) {
  if (match === undefined) {
    return undefined;
  }
  const list = match?.ignore;
  if (!Array.isArray(list) || list.some((o) => typeof o !== "string")) {
    say(`osd-http-replay: ${where} has a match without an ignore list of option names -- matching stays exact`);
    return NOTHING;
  }
  const out = new Set();
  for (const option of list) {
    const name = option.trim().toLowerCase();
    if (NEVER_IGNORED.includes(name)) {
      say(`osd-http-replay: ${where} asks to ignore ${option}, which is never ignored (two pages are two answers)`);
    } else if (name !== "") {
      out.add(name);
    }
  }
  return out;
}

const signatureOf = (ignore) => [...ignore].sort().join(",");

/** `$top` of a query as a number, or undefined when there is none, it is
 *  not a count, or the query names it more than once */
function topOf(entries) {
  const all = entries.filter(([k]) => k.toLowerCase() === "$top");
  const v = all.length === 1 ? all[0][1].trim() : undefined;
  return v !== undefined && v !== "" && [...v].every((c) => c >= "0" && c <= "9") ? Number(v) : undefined;
}

/** Of several recordings that answer one request once options are ignored:
 *  the smallest that holds the rows asked for, else the largest; without a
 *  `$top` asked for, the one recorded without a `$top`, else the largest.
 *  Ties go to load order (the first folder's). */
function choose(candidates, asked) {
  const size = (c) => c.top ?? Infinity;
  let best;
  for (const c of candidates) {
    if (best === undefined) {
      best = c;
      continue;
    }
    const enough = (x) => asked === undefined ? x.top === undefined : size(x) >= asked;
    if (enough(c) && !enough(best)) {
      best = c;
    } else if (enough(c) === enough(best) && (enough(c) && asked !== undefined ? size(c) < size(best) : size(c) > size(best))) {
      best = c;
    }
  }
  return best;
}

/** a collection's rows cut to `top`, in V2 (`d.results`) or V4 (`value`)
 *  shape; anything else is returned as it was. The fixture's own body is
 *  never changed: it answers the next request too. A recorded next link is
 *  dropped with the rows: it points past the recorded page, and a client
 *  following it would skip every row between the cut and that page. */
function cutRows(body, top) {
  let doc = body;
  if (typeof body === "string") {
    const t = body.trimStart();
    if (!t.startsWith("{")) {
      return body;
    }
    try {
      doc = JSON.parse(body);
    } catch {
      return body;
    }
  }
  let out;
  if (Array.isArray(doc?.d?.results) && doc.d.results.length > top) {
    const {__next, ...d} = doc.d;
    out = {...doc, d: {...d, results: doc.d.results.slice(0, top)}};
  } else if (Array.isArray(doc?.value) && doc.value.length > top) {
    const {"@odata.nextLink": next, ...rest} = doc;
    out = {...rest, value: doc.value.slice(0, top)};
  } else {
    return body;
  }
  return typeof body === "string" ? JSON.stringify(out) : out;
}

/** how two normalised queries differ, option by option: [{option, asked,
 *  recorded}], undefined where one side lacks the option */
export function differences(asked, recorded) {
  const a = new Map(asked);
  const r = new Map(recorded);
  const out = [];
  for (const option of [...new Set([...a.keys(), ...r.keys()])].sort()) {
    if (a.get(option) !== r.get(option)) {
      out.push({option, asked: a.get(option), recorded: r.get(option)});
    }
  }
  return out;
}

const MISSES_KEPT = 500;

/** A replayer over one set of fixtures. `answer` is the whole decision for
 *  one request and knows nothing of express, so `$batch` parts and plain
 *  requests go through the same door. `match` is the destination's (see the
 *  head of this file); a fixture's own `match` overrides it. */
export function replayer(fixtures, {onMiss = "error", say = console.error, name = "replay", match} = {}) {
  const fallbackIgnore = ignoreOf(match, `destination ${name}`, say) ?? NOTHING;
  // per ignore set, the relaxed key -> the recordings it reaches
  const relaxed = new Map();
  // per method + service + path, every recording there (for the nearest)
  const byPath = new Map();
  for (const fixture of fixtures.values()) {
    const entries = queryEntries(fixture.key.query);
    const at = pathKey(fixture.key);
    const one = {fixture, entries, top: topOf(entries)};
    if (!byPath.has(at)) {
      byPath.set(at, []);
    }
    byPath.get(at).push(one);
    const ignore = ignoreOf(fixture.match, fixture.file ?? at, say) ?? fallbackIgnore;
    if (ignore.size === 0) {
      continue;
    }
    const signature = signatureOf(ignore);
    if (!relaxed.has(signature)) {
      relaxed.set(signature, {ignore, keys: new Map()});
    }
    const key = `${at}?${queryKey(fixture.key.query, ignore)}`;
    const keys = relaxed.get(signature).keys;
    if (!keys.has(key)) {
      keys.set(key, []);
    }
    keys.get(key).push(one);
  }

  /** the recording a request reaches once options are ignored, and the
   *  ignore set that reached it */
  function near(request, entries) {
    const at = pathKey(request);
    const asked = topOf(entries);
    const malformed = asked === undefined && entries.some(([k]) => k.toLowerCase() === "$top");
    for (const {ignore, keys} of relaxed.values()) {
      if (malformed && ignore.has("$top")) {
        // a $top that is not a count cannot be cut to: no relaxed answer
        continue;
      }
      const candidates = keys.get(`${at}?${queryKey(request.query, ignore)}`);
      if (candidates !== undefined) {
        return {...choose(candidates, asked), ignore};
      }
    }
    return undefined;
  }

  /** the recording at the same path whose query differs least */
  function nearest(request, entries) {
    let best;
    for (const one of byPath.get(pathKey(request)) ?? []) {
      const diff = differences(entries, one.entries);
      if (best === undefined || diff.length < best.differences.length) {
        best = {file: one.fixture.file, key: replayKey(one.fixture.key), differences: diff};
      }
    }
    return best;
  }

  const misses = new Map();
  function remember(key, request, closest, context) {
    let miss = misses.get(key);
    if (miss === undefined) {
      if (misses.size >= MISSES_KEPT) {
        misses.delete(misses.keys().next().value);
      }
      miss = {destination: name, key, request: {method: request.method, service: request.service, path: request.path ?? "", query: request.query ?? ""},
        closest, count: 0, first: new Date().toISOString(), parts: []};
      misses.set(key, miss);
    }
    miss.count += 1;
    miss.last = new Date().toISOString();
    if (context?.part !== undefined && miss.parts.length < 10) {
      miss.parts.push({part: context.part, line: context.line});
    }
  }

  const describe = (d) => `${d.option} asked ${d.asked ?? "(none)"}, recorded ${d.recorded ?? "(none)"}`;

  async function answer({method, service, path, query}, context) {
    const request = {method, service, path, query};
    const key = replayKey(request);
    let fixture = fixtures.get(key);
    let cut;
    if (fixture === undefined) {
      const entries = queryEntries(query);
      const reached = near(request, entries);
      if (reached !== undefined) {
        fixture = reached.fixture;
        const asked = topOf(entries);
        if (reached.ignore.has("$top") && asked !== undefined && (reached.top === undefined || reached.top > asked)) {
          cut = asked;
        }
      } else {
        const closest = nearest(request, entries);
        remember(key, request, closest, context);
        const where = context?.part === undefined ? "" : ` (batch part ${context.part}: ${context.line})`;
        const hint = closest === undefined
          ? " -- nothing recorded at this path"
          : ` -- closest ${closest.file ?? closest.key}: ${closest.differences.map(describe).join("; ")}`;
        say(`osd-http-replay: MISS ${name} ${key}${where}${hint}`);
        const soft = onMiss === "empty" && method === "GET" ? emptyAnswer(path) : undefined;
        if (soft !== undefined) {
          return {...soft, outcome: "miss"};
        }
        return {status: 404, headers: {"content-type": "application/json"}, outcome: "miss",
          body: errorBody("STG/REPLAY_MISS", `not recorded: ${key}`)};
      }
    }
    const r = fixture.response;
    let body = r.body ?? "";
    if (fixture.dynamic !== false && (typeof body === "string" ? body.includes("{{") : true)) {
      const input = Object.fromEntries(queryPairs(query ?? ""));
      body = await substitute(body, input);
    }
    if (cut !== undefined) {
      body = cutRows(body, cut);
    }
    const headers = {};
    for (const [h, v] of Object.entries(r.headers ?? {})) {
      if (FROM_FIXTURE.includes(h.toLowerCase())) {
        headers[h.toLowerCase()] = v;
      }
    }
    if (typeof body !== "string") {
      body = JSON.stringify(body);
      headers["content-type"] ??= "application/json";
    }
    return {status: r.status, headers, body, outcome: "hit", file: fixture.file};
  }
  return {answer, size: fixtures.size, name, misses: () => [...misses.values()],
    nearest: (request) => nearest(request, queryEntries(request.query))};
}

// ---------------------------------------------------------------- $batch
//
// **Read by a scanner, not by regular expressions** (Alice's rule for
// structured input). A $batch is a nested format -- batch, changeset, part,
// headers, body -- and a delimiter pattern run over the whole text also
// finds `--boundary` inside a part's body. So it is read line by line: a
// delimiter is a delimiter only as a whole line, headers are lines up to an
// empty one (folded continuations joined), and a Content-Type's parameters
// are split at `;` outside quotes.

/** the lines of a body; a line ends at LF, and a CR before it is dropped */
function linesOf(text) {
  const out = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      out.push(text.slice(start, i > start && text.charCodeAt(i - 1) === 13 ? i - 1 : i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

const isBlank = (c) => c === 32 || c === 9;

/** transport padding after a delimiter (RFC 2046) is allowed */
function trimRight(line) {
  let end = line.length;
  while (end > 0 && isBlank(line.charCodeAt(end - 1))) {
    end -= 1;
  }
  return line.slice(0, end);
}

/** header lines -> {name (lower case): value}; a line beginning with a
 *  blank continues the one before it */
function headersOf(lines) {
  const out = {};
  let last;
  for (const line of lines) {
    if (line.length > 0 && isBlank(line.charCodeAt(0)) && last !== undefined) {
      out[last] = `${out[last]} ${line.trim()}`;
      continue;
    }
    const colon = line.indexOf(":");
    if (colon <= 0) {
      continue;
    }
    last = line.slice(0, colon).trim().toLowerCase();
    out[last] = line.slice(colon + 1).trim();
  }
  return out;
}

/** `multipart/mixed; boundary="b 1"; x=y` -> {type, params} */
export function contentTypeOf(value) {
  const pieces = [];
  let current = "";
  let quoted = false;
  for (const ch of value ?? "") {
    if (ch === '"') {
      quoted = !quoted;
      current += ch;
    } else if (ch === ";" && !quoted) {
      pieces.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  pieces.push(current);
  const params = {};
  for (const piece of pieces.slice(1)) {
    const eq = piece.indexOf("=");
    if (eq <= 0) {
      continue;
    }
    let v = piece.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1);
    }
    params[piece.slice(0, eq).trim().toLowerCase()] = v;
  }
  return {type: pieces[0].trim().toLowerCase(), params};
}

/** One multipart body -> [{headers, body}], by states: preamble, headers,
 *  body, epilogue. A line is a delimiter only when it is exactly `--b` or
 *  `--b--` (plus padding); the CRLF before it belongs to it, which is what
 *  joining the body's lines with CRLF gives. */
export function partsOf(text, boundary) {
  const open = `--${boundary}`;
  const close = `--${boundary}--`;
  const parts = [];
  let state = "preamble";
  let part;
  const finish = () => {
    if (part !== undefined) {
      parts.push({headers: headersOf(part.head), headLines: part.head, body: part.body.join("\r\n")});
    }
  };
  for (const raw of linesOf(text)) {
    const line = trimRight(raw);
    if (line === close && state !== "epilogue") {
      finish();
      part = undefined;
      state = "epilogue";
      continue;
    }
    if (line === open && state !== "epilogue") {
      finish();
      part = {head: [], body: []};
      state = "headers";
      continue;
    }
    if (state === "headers") {
      if (raw === "") {
        state = "body";
      } else {
        part.head.push(raw);
      }
    } else if (state === "body") {
      part.body.push(raw);
    }
  }
  // a body that ends without its close delimiter still has its last part
  if (state === "headers" || state === "body") {
    finish();
  }
  return parts;
}

/** `GET OrderSet?$top=2 HTTP/1.1` -> {method, url}, or undefined */
function requestLineOf(line) {
  const words = line.trim().split(" ").filter((w) => w !== "");
  if (words.length !== 3 || !words[2].toUpperCase().startsWith("HTTP/")) {
    return undefined;
  }
  return {method: words[0].toUpperCase(), url: words[1]};
}

/** an HTTP request as a part carries it: request line, headers, empty
 *  line, body. Leading empty lines are skipped. */
function requestOf(text) {
  const lines = linesOf(text);
  let i = 0;
  while (i < lines.length && lines[i] === "") {
    i += 1;
  }
  const line = requestLineOf(lines[i] ?? "");
  if (line === undefined) {
    return {method: "?", url: "", body: ""};
  }
  const head = [];
  i += 1;
  while (i < lines.length && lines[i] !== "") {
    head.push(lines[i]);
    i += 1;
  }
  // a part may tunnel its real method the way a request does; the tunnel
  // is what the gateway would execute, so it is what is judged
  const tunnel = headersOf(head)["x-http-method"];
  return {method: (tunnel ?? line.method).toUpperCase(), url: line.url, body: lines.slice(i + 1).join("\r\n")};
}

/** a part's request: its body, or -- for a part written without MIME
 *  headers, whose request line the scanner read as a header line -- the
 *  whole part */
function partRequest(part) {
  if (part.headers["content-type"] === undefined && part.headLines.length > 0 && requestLineOf(part.headLines[0]) !== undefined) {
    return requestOf([...part.headLines, "", part.body].join("\r\n"));
  }
  return requestOf(part.body);
}

/** A $batch body as a list of requests and changesets:
 *  [{method, url, body} | {changeset: [{method, url, body}]}] */
export function parseBatch(body, contentType) {
  const boundary = contentTypeOf(contentType).params.boundary;
  if (boundary === undefined || boundary === "") {
    throw Object.assign(new Error("Content-Type of a $batch request must carry a boundary"), {status: 400});
  }
  return partsOf(body, boundary).map((part) => {
    const type = contentTypeOf(part.headers["content-type"]);
    if (type.type === "multipart/mixed") {
      // a changeset without a boundary cannot be read, and is refused as
      // one rather than failing the whole batch
      const inside = type.params.boundary;
      return {changeset: inside === undefined || inside === "" ? [] : partsOf(part.body, inside).map(partRequest)};
    }
    return partRequest(part);
  });
}

let counter = 0;

// one part, written the way src/gateway/zcl_stg_batch.clas.abap format_part
// writes it, so a page cannot tell a replayed batch from one of ours
const formatPart = ({status, headers, body}) => {
  const crlf = "\r\n";
  let out = `Content-Type: application/http${crlf}Content-Transfer-Encoding: binary${crlf}${crlf}` +
    `HTTP/1.1 ${status} ${REASONS[status] ?? "OK"}${crlf}`;
  const {"content-type": type, ...rest} = headers ?? {};
  if (type !== undefined) {
    out += `Content-Type: ${type}${crlf}`;
  }
  out += `Content-Length: ${Buffer.byteLength(body ?? "")}${crlf}DataServiceVersion: 2.0${crlf}`;
  for (const [h, v] of Object.entries(rest)) {
    if (h !== "dataserviceversion") {
      out += `${h}: ${v}${crlf}`;
    }
  }
  return out + crlf + (body ?? "") + crlf;
};

/** A whole $batch answered: GET parts from the fixtures, every changeset
 *  refused with one error part, as a failing changeset is answered by the
 *  gateway. Returns {status, headers, body, outcomes}. */
export async function answerBatch(replay, service, body, contentType) {
  const items = parseBatch(body, contentType);
  if (items.length === 0) {
    // an empty answer to an unreadable batch would read as "all answered";
    // it is the request that is wrong, and that is said
    throw Object.assign(new Error(`${service}: a $batch with no readable part (boundary ${contentTypeOf(contentType).params.boundary}, ${body.length} bytes)`), {status: 400});
  }
  counter += 1;
  const boundary = `batchresponse_stg_replay_${counter}`;
  const outcomes = [];
  let out = "";
  for (const [index, item] of items.entries()) {
    if (item.changeset !== undefined) {
      outcomes.push("refused");
      out += `--${boundary}\r\n` + formatPart({status: 501, headers: {"content-type": "application/json"},
        body: errorBody("STG/REPLAY_READ_ONLY", `${service}: a replayed service answers reads; this changeset of ${item.changeset.length} request(s) was not applied`)});
      continue;
    }
    if (item.method !== "GET") {
      outcomes.push("refused");
      out += `--${boundary}\r\n` + formatPart({status: 501, headers: {"content-type": "application/json"},
        body: errorBody("STG/REPLAY_READ_ONLY", `${service}: ${item.method} outside a changeset is not replayed`)});
      continue;
    }
    // a part's URL is relative to the service, or absolute from the root
    const target = item.url.startsWith("/") ? splitUrl(item.url) : (() => {
      const q = item.url.indexOf("?");
      return {service, path: q < 0 ? item.url : item.url.slice(0, q), query: q < 0 ? "" : item.url.slice(q + 1)};
    })();
    const a = target === undefined
      ? {status: 404, headers: {"content-type": "application/json"}, body: errorBody("STG/REPLAY_MISS", `not an OData path: ${item.url}`), outcome: "miss"}
      : await replay.answer({method: "GET", ...target}, {part: index + 1, line: `GET ${item.url}`});
    outcomes.push(a.outcome);
    out += `--${boundary}\r\n` + formatPart(a);
  }
  out += `--${boundary}--\r\n`;
  return {status: 202, headers: {"content-type": `multipart/mixed; boundary=${boundary}`}, body: out, outcomes};
}

// ---------------------------------------------------------------- express

// what tells "the system could not be reached" from "the system was reached
// and has not answered yet": only the first may be answered from fixtures
// for a request that writes, because the second may already have written
const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT"]);
const unreachable = (error) => UNREACHABLE.has(error?.cause?.code ?? error?.code);
const reads = (req) => req.method === "GET" || req.method === "HEAD";

/** the worst outcome of a batch, for its one header: a miss anywhere is a miss */
const worst = (outcomes) => ["refused", "miss", "hit"].find((o) => outcomes.includes(o)) ?? "hit";

/** Express middleware answering one service from fixtures. `live`, when
 *  given, is tried first and the fixtures answer only when it throws; an
 *  answer from the system, even an error (a 502 of a proxy in front of it
 *  included), is the system's answer and is passed on.
 *
 *  A read falls back on any failure, a timeout included. A request that may
 *  write -- POST, `$batch`, anything not GET/HEAD -- falls back only when
 *  the system could not be reached at all; a timeout or a reset after it
 *  went out is a 504 that says the outcome is unknown, because answering it
 *  from the fixtures would tell the page "not applied" about a write the
 *  system may have done (found by review: a POST that took 800 ms against a
 *  300 ms timeout was applied upstream and refused here). */
export function replayService(name, replay, known = () => false, {live, token = randomBytes(16).toString("hex")} = {}) {
  // a Gateway reads a service name in any case, and pages differ in which
  // they send (a recording of one is how this was found)
  const prefix = `/sap/opu/odata/sap/${name}`.toUpperCase();
  return async function (req, res, next) {
    const url = req.originalUrl;
    // the name, then the end or one of / ; ? -- not a longer name it begins
    const after = url.charAt(prefix.length);
    if (!(url.toUpperCase().startsWith(prefix) && (after === "" || after === "/" || after === ";" || after === "?")) || known(name)) {
      next();
      return;
    }
    if (live !== undefined) {
      try {
        res.set("sap-osd-replay", "live");
        await live(req, res);
        return;
      } catch (error) {
        const why = error?.cause?.code ?? error?.name ?? error?.message ?? String(error);
        if (res.headersSent) {
          // the system's answer was already going out; nothing better can be
          // sent, and a throw from here would be an unhandled rejection
          console.error(`osd-http-replay: ${name} failed mid-answer (${why})`);
          res.end();
          return;
        }
        if (!reads(req) && !unreachable(error)) {
          console.error(`osd-http-replay: ${name} ${req.method} ${url}: ${why} after the request went out -- outcome unknown, not replayed`);
          res.status(504).set("sap-osd-replay", "live").json({error: {code: "STG/DESTINATION_TIMEOUT",
            message: {lang: "en", value: `${name}: the system did not answer (${why}); the request may have been applied`}}});
          return;
        }
        // fall through to the fixtures; said once per request so a page
        // that silently went offline is visible in the log
        console.error(`osd-http-replay: ${name} unreachable (${why}), answering from fixtures`);
      }
    }
    const send = ({status, headers, body}, outcome) => {
      res.status(status);
      for (const [h, v] of Object.entries(headers)) {
        res.set(h, v);
      }
      res.set("sap-osd-replay", outcome);
      // what a CSRF fetch asks for, on any request: stage 1 never writes, so
      // the token only has to exist for the page to send its $batch
      if (String(req.headers["x-csrf-token"] ?? "").toLowerCase() === "fetch") {
        res.set("x-csrf-token", token);
      }
      res.send(req.method === "HEAD" ? undefined : body);
    };
    const target = splitUrl(url);
    try {
      if (req.method === "HEAD") {
        // the service root, and a CSRF fetch anywhere, are what a model asks
        // HEAD for; any other path is the GET it stands for, minus the body
        const root = trimSlashes(target.path) === "";
        if (root || String(req.headers["x-csrf-token"] ?? "").toLowerCase() === "fetch") {
          send({status: 200, headers: {"content-type": "application/json"}, body: ""}, "hit");
          return;
        }
        const a = await replay.answer({method: "GET", ...target});
        send(a, a.outcome);
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
      if (req.method === "POST" && trimSlashes(target.path).toLowerCase() === "$batch") {
        const a = await answerBatch(replay, target.service, body, req.headers["content-type"]);
        send(a, worst(a.outcomes));
        return;
      }
      // X-HTTP-Method tunnels MERGE, PUT or DELETE through a POST (or
      // anything); the tunnelled method is the request, and a GET carrying
      // one is not a read
      const method = String(req.headers["x-http-method"] ?? req.method).toUpperCase();
      if (req.method !== "GET" || method !== "GET") {
        console.error(`osd-http-replay: REFUSED ${name} ${method} ${url}`);
        send({status: 501, headers: {"content-type": "application/json"},
          body: errorBody("STG/REPLAY_READ_ONLY", `${name}: ${method} is not replayed; a replayed service answers reads`)}, "refused");
        return;
      }
      const a = await replay.answer({method: "GET", ...target});
      send(a, a.outcome);
    } catch (error) {
      console.error(`osd-http-replay: ERROR ${name} ${req.method} ${url}: ${error?.message ?? error}`);
      send({status: error?.status ?? 500, headers: {"content-type": "application/json"},
        body: errorBody("STG/REPLAY", `${name}: ${error?.message ?? error}`)}, "error");
    }
  };
}

/** The fixtures folders of a destination, resolved against `root`. Each
 *  one inside the checkout `tree` and outside its `.local/` is named once:
 *  recorded fixtures carry a system's data, and a folder git can see is one
 *  push from public. */
export function fixtureFolders(destination, {root = process.cwd(), tree = process.cwd(), say = console.error} = {}) {
  const folders = [].concat(destination.fixtures ?? []).map((f) => (isAbsolute(f) ? f : resolve(root, f)));
  for (const f of folders) {
    const rel = relative(tree, f);
    if (!rel.startsWith("..") && !isAbsolute(rel) && rel.split(sep)[0] !== ".local") {
      say(`osd-http-replay: fixtures ${rel} are inside the tree and not under .local/ -- make sure git ignores them`);
    }
  }
  return folders;
}
