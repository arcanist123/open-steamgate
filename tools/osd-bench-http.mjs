#!/usr/bin/env node
// A closed-loop HTTP load probe for one running host: N clients, each sending
// the next request as soon as its previous answer arrived, for a fixed time.
// It reports requests per second and the latency percentiles, nothing else,
// so two hosts (or two builds of one host) can be compared with one
// instrument -- the rule in CLAUDE.md "same instrument for speed".
//
//   node tools/osd-bench-http.mjs --url http://localhost:3095/health [--clients 1,4,16] [--seconds 5] [--warmup 1]
//                                 [--timeout 30] [--header 'Accept: application/json'] [--method GET] [--data '<body>'] [--json]
//
// --method and --data are the write mix of ADR 0010 slice 5: the same
// closed loop over a modifying request (a MERGE with its CSRF token and
// session cookie in --header, fetched once before the run).
//
// Each clients value is one run; the runs go one after another, never
// together. The measurement window is [warmup, warmup + seconds) from the
// run's start, and a request is counted by the time its answer **completed**:
// completions before the window are warm-up, completions after it are
// discarded, and rps = counted / seconds. Every request has a deadline
// (--timeout seconds, default 30): a host that accepts and never answers
// ends the request as an error instead of holding the run open. A response
// with a status of 400 or above is an error and not a request. The body is
// read and discarded, which is what a real client does too. The statuses
// map counts answers inside the window only, so it adds up with requests
// plus errors.
//
// It was written for the osgo work-process ADR (docs/adr/0010): one ADT GET
// and one OData GET at 1, 4 and 16 clients against a host whose dialog steps
// take one mutex. The numbers it printed are in that ADR with the exact
// commands. It has no dependency beyond Node's own fetch.
import {parseArgs} from "node:util";

const {values} = parseArgs({options: {
  url: {type: "string"},
  clients: {type: "string", default: "1,4,16"},
  seconds: {type: "string", default: "5"},
  warmup: {type: "string", default: "1"},
  timeout: {type: "string", default: "30"},
  header: {type: "string", multiple: true, default: []},
  method: {type: "string", default: "GET"},
  data: {type: "string"},
  json: {type: "boolean", default: false},
  help: {type: "boolean", default: false},
}});
const usage = "usage: node tools/osd-bench-http.mjs --url <url> [--clients 1,4,16] [--seconds 5] [--warmup 1] [--timeout 30] [--header 'K: V'] [--method GET] [--data '<body>'] [--json]";
if (values.help) {
  console.log(usage);
  process.exit(0);
}
function fail(message) {
  console.error(`osd-bench-http: ${message}\n${usage}`);
  process.exit(2);
}
if (!values.url) fail("--url is required");
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const timeoutMs = Number(values.timeout) * 1000;
if (!Number.isFinite(seconds) || seconds <= 0) fail(`--seconds must be a positive number, got ${values.seconds}`);
if (!Number.isFinite(warmup) || warmup < 0) fail(`--warmup must be a non-negative number, got ${values.warmup}`);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) fail(`--timeout must be a positive number of seconds, got ${values.timeout}`);
const clientCounts = values.clients.split(",").map((s) => s.trim()).filter((s) => s !== "").map((s) => Number(s));
if (clientCounts.length === 0 || clientCounts.some((n) => !Number.isInteger(n) || n <= 0)) {
  fail(`--clients must be positive integers separated by commas, got ${values.clients}`);
}
const method = values.method.toUpperCase();
if (!["GET", "HEAD", "POST", "PUT", "MERGE", "PATCH", "DELETE"].includes(method)) {
  fail(`--method must be an HTTP method the hosts answer, got ${values.method}`);
}
const body = values.data;
const headers = Object.fromEntries(values.header.map((h) => {
  const i = h.indexOf(":");
  if (i <= 0) fail(`--header must be 'Name: value', got ${h}`);
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}));

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}
const ms = (n) => Number.isFinite(n) ? Number(n.toFixed(2)) : null;

async function run(clients) {
  const latencies = [];
  let errors = 0;
  let counted = 0;
  const start = performance.now();
  const countFrom = start + warmup * 1000;
  const end = countFrom + seconds * 1000;
  const statuses = new Map();
  const worker = async () => {
    while (performance.now() < end) {
      const t0 = performance.now();
      let ok = false;
      let status;
      try {
        const res = await fetch(values.url, {method, headers, body: body === undefined ? undefined : body, signal: AbortSignal.timeout(timeoutMs)});
        await res.arrayBuffer();
        ok = res.status < 400;
        status = res.status;
      } catch (error) {
        status = error?.name === "TimeoutError" ? "timeout" : "fetch-error";
      }
      const t1 = performance.now();
      // counted by completion time, inside the window only
      if (t1 < countFrom || t1 >= end) continue;
      statuses.set(status, (statuses.get(status) ?? 0) + 1);
      if (ok) {
        latencies.push(t1 - t0);
        counted++;
      } else {
        errors++;
      }
    }
  };
  await Promise.all(Array.from({length: clients}, worker));
  latencies.sort((a, b) => a - b);
  return {
    clients,
    seconds,
    requests: counted,
    errors,
    rps: Number((counted / seconds).toFixed(1)),
    p50_ms: ms(percentile(latencies, 50)),
    p95_ms: ms(percentile(latencies, 95)),
    p99_ms: ms(percentile(latencies, 99)),
    max_ms: ms(latencies.at(-1) ?? NaN),
    statuses: Object.fromEntries(statuses),
  };
}

const results = [];
for (const c of clientCounts) {
  const r = await run(c);
  results.push(r);
  if (!values.json) {
    console.log(`${values.url}  clients=${c}  rps=${r.rps}  p50=${r.p50_ms}ms  p95=${r.p95_ms}ms  p99=${r.p99_ms}ms  errors=${r.errors}`);
  }
}
if (values.json) console.log(JSON.stringify({url: values.url, results}, null, 2));
