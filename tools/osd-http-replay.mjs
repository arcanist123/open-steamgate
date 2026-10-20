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

// guid'000D3A06598…' and guid'000d3a06-5988-…' are the same key; a page
// sends whichever its model happened to hold
const guids = (text) => text.replace(/guid'([0-9a-fA-F-]{32,36})'/g, (whole, g) => {
  const hex = g.replace(/-/g, "").toLowerCase();
  if (hex.length !== 32) {
    return whole;
  }
  return `guid'${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}'`;
});

/** `SRV;v=0002;o=SID` -> `SRV;v=0002`; version 1 is the default and is
 *  dropped, the origin is routing and not part of what was asked */
export function serviceKey(segment) {
  const [name, ...matrix] = decode(segment).split(";");
  const version = matrix.map((m) => /^v=0*(\d+)$/i.exec(m)?.[1]).find(Boolean);
  return version === undefined || version === "1" ? name.toUpperCase() : `${name.toUpperCase()};v=${version.padStart(4, "0")}`;
}

/** The query as a key: decoded, `sap-*` dropped (client, language, cache
 *  buster: routing, not the question), sorted. `$skiptoken` stays -- two
 *  pages are two answers, and dropping it would serve page one for both. */
export function queryKey(query) {
  return (query ?? "").replace(/^\?/, "").split("&").filter(Boolean).map((kv) => {
    const i = kv.indexOf("=");
    return i < 0 ? [decode(kv), ""] : [decode(kv.slice(0, i)), decode(kv.slice(i + 1))];
  }).filter(([k]) => !k.toLowerCase().startsWith("sap-"))
    .map(([k, v]) => `${k}=${guids(v)}`)
    .sort()
    .join("&");
}

/** One string per request: what a fixture is found by. */
export function replayKey({method, service, path, query}) {
  const p = guids(decode(path ?? "").replace(/^\/+|\/+$/g, ""));
  return `${method.toUpperCase()} ${serviceKey(service)}/${p}?${queryKey(query)}`;
}

/** `/sap/opu/odata/sap/SRV;v=2/Set?x` -> {service, path, query}, or undefined */
export function splitUrl(url) {
  const q = url.indexOf("?");
  const [pathname, query] = q < 0 ? [url, ""] : [url.slice(0, q), url.slice(q + 1)];
  const m = /^\/sap\/opu\/odata\/sap\/([^/]+)\/?(.*)$/i.exec(pathname);
  return m === null ? undefined : {service: m[1], path: m[2], query};
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
  const last = path.replace(/\/+$/, "").split("/").pop() ?? "";
  if (last === "$count") {
    return {status: 200, headers: {"content-type": "text/plain"}, body: "0"};
  }
  if (last !== "" && !last.startsWith("$") && !last.includes("(")) {
    return {status: 200, headers: {"content-type": "application/json", "dataserviceversion": "2.0"}, body: '{"d":{"results":[]}}'};
  }
  return undefined;
}

/** A replayer over one set of fixtures. `answer` is the whole decision for
 *  one request and knows nothing of express, so `$batch` parts and plain
 *  requests go through the same door. */
export function replayer(fixtures, {onMiss = "error", say = console.error, name = "replay"} = {}) {
  async function answer({method, service, path, query}) {
    const key = replayKey({method, service, path, query});
    const fixture = fixtures.get(key);
    if (fixture === undefined) {
      say(`osd-http-replay: MISS ${name} ${key}`);
      const soft = onMiss === "empty" && method === "GET" ? emptyAnswer(path) : undefined;
      if (soft !== undefined) {
        return {...soft, outcome: "miss"};
      }
      return {status: 404, headers: {"content-type": "application/json"}, outcome: "miss",
        body: errorBody("STG/REPLAY_MISS", `not recorded: ${key}`)};
    }
    const r = fixture.response;
    let body = r.body ?? "";
    if (fixture.dynamic !== false && (typeof body === "string" ? body.includes("{{") : true)) {
      const input = Object.fromEntries((query ?? "").split("&").filter(Boolean).map((kv) => {
        const i = kv.indexOf("=");
        return i < 0 ? [decode(kv), ""] : [decode(kv.slice(0, i)), decode(kv.slice(i + 1))];
      }));
      body = await substitute(body, input);
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
    return {status: r.status, headers, body, outcome: "hit"};
  }
  return {answer, size: fixtures.size};
}

// ---------------------------------------------------------------- $batch

const splitParts = (body, boundary) => {
  const delimiter = new RegExp(`(?:^|\\r?\\n)--${boundary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(--)?[ \\t]*(?:\\r?\\n|$)`);
  const parts = body.split(delimiter);
  // split with a capture group interleaves the "--" of the closing delimiter;
  // what is before the first delimiter is the preamble
  const out = [];
  for (let i = 1; i < parts.length; i += 2) {
    if (parts[i] === "--") {
      break;
    }
    out.push(parts[i + 1] ?? "");
  }
  return out;
};

const headAndBody = (text) => {
  const m = /\r?\n\r?\n/.exec(text);
  return m === null ? [text, ""] : [text.slice(0, m.index), text.slice(m.index + m[0].length)];
};

// quoted, or a token up to `;` or white space: `boundary=b1 ; charset=x` is b1
const boundaryOf = (contentType) => {
  const m = /boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType ?? "");
  return m === null ? undefined : m[1] ?? m[2];
};

const REQUEST_LINE = /^(\w+)\s+(\S+)\s+HTTP\/\d\.\d/;

/** A $batch body as a list of requests and changesets:
 *  [{method, url, body} | {changeset: [{method, url, body}]}] */
export function parseBatch(body, contentType) {
  const boundary = boundaryOf(contentType);
  if (boundary === undefined) {
    throw new Error("Content-Type of a $batch request must carry a boundary");
  }
  const request = (part) => {
    // a part normally has its own MIME headers before the request; one
    // written without them begins with the request line, or a blank line
    const trimmed = part.replace(/^(?:\r?\n)+/, "");
    const http = REQUEST_LINE.test(trimmed) ? trimmed : headAndBody(part)[1].replace(/^(?:\r?\n)+/, "");
    const [head, payload] = headAndBody(http);
    const m = REQUEST_LINE.exec(head.split(/\r?\n/)[0] ?? "");
    return m === null ? {method: "?", url: "", body: payload} : {method: m[1].toUpperCase(), url: m[2], body: payload};
  };
  return splitParts(body, boundary).map((part) => {
    const [head, inner] = headAndBody(part);
    const type = /content-type:\s*([^\r\n]+)/i.exec(head)?.[1] ?? "";
    if (/^multipart\/mixed/i.test(type)) {
      const inside = boundaryOf(type);
      // a changeset without a boundary cannot be read, and is refused as
      // one rather than failing the whole batch on a TypeError
      return {changeset: inside === undefined ? [] : splitParts(inner, inside).map(request)};
    }
    return request(part);
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
    throw Object.assign(new Error(`${service}: a $batch with no readable part (boundary ${boundaryOf(contentType)}, ${body.length} bytes)`), {status: 400});
  }
  counter += 1;
  const boundary = `batchresponse_stg_replay_${counter}`;
  const outcomes = [];
  let out = "";
  for (const item of items) {
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
      : await replay.answer({method: "GET", ...target});
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
    if (!(url.toUpperCase().startsWith(prefix) && /^[/;?]|^$/.test(url.slice(prefix.length))) || known(name)) {
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
        const root = target.path.replace(/\/+$/, "") === "";
        if (root || String(req.headers["x-csrf-token"] ?? "").toLowerCase() === "fetch") {
          send({status: 200, headers: {"content-type": "application/json"}, body: ""}, "hit");
          return;
        }
        const a = await replay.answer({method: "GET", ...target});
        send(a, a.outcome);
        return;
      }
      const body = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : typeof req.body === "string" ? req.body : "";
      if (req.method === "POST" && /^\$batch$/i.test(target.path.replace(/\/+$/, ""))) {
        const a = await answerBatch(replay, target.service, body, req.headers["content-type"]);
        send(a, worst(a.outcomes));
        return;
      }
      if (req.method !== "GET") {
        console.error(`osd-http-replay: REFUSED ${name} ${req.method} ${url}`);
        send({status: 501, headers: {"content-type": "application/json"},
          body: errorBody("STG/REPLAY_READ_ONLY", `${name}: ${req.method} is not replayed; a replayed service answers reads`)}, "refused");
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
