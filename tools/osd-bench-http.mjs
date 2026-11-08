#!/usr/bin/env node
// A closed-loop HTTP load probe for one running host: N clients, each sending
// the next request as soon as its previous answer arrived, for a fixed time.
// It reports requests per second and the latency percentiles, nothing else,
// so two hosts (or two builds of one host) can be compared with one
// instrument -- the rule in CLAUDE.md "same instrument for speed".
//
//   node tools/osd-bench-http.mjs --url http://localhost:3095/health [--clients 1,4,16] [--seconds 5] [--warmup 1]
//                                 [--header 'Accept: application/json'] [--json]
//
// Each clients value is one run; the runs go one after another, never
// together. The first --warmup seconds of a run are not counted. A response
// with a status of 400 or above counts as an error and not as a request. The
// body is read and discarded, which is what a real client does too.
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
  header: {type: "string", multiple: true, default: []},
  json: {type: "boolean", default: false},
  help: {type: "boolean", default: false},
}});
if (values.help || !values.url) {
  console.log("usage: node tools/osd-bench-http.mjs --url <url> [--clients 1,4,16] [--seconds 5] [--warmup 1] [--header 'K: V'] [--json]");
  process.exit(values.help ? 0 : 2);
}
const seconds = Number(values.seconds);
const warmup = Number(values.warmup);
const headers = Object.fromEntries(values.header.map((h) => {
  const i = h.indexOf(":");
  return [h.slice(0, i).trim(), h.slice(i + 1).trim()];
}));

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[i];
}

async function run(clients) {
  const latencies = [];
  let errors = 0;
  let counted = 0;
  const start = performance.now();
  const countFrom = start + warmup * 1000;
  const end = start + (warmup + seconds) * 1000;
  const statuses = new Map();
  const worker = async () => {
    while (performance.now() < end) {
      const t0 = performance.now();
      let ok = false;
      try {
        const res = await fetch(values.url, {headers});
        await res.arrayBuffer();
        ok = res.status < 400;
        statuses.set(res.status, (statuses.get(res.status) ?? 0) + 1);
      } catch {
        statuses.set("fetch-error", (statuses.get("fetch-error") ?? 0) + 1);
      }
      const t1 = performance.now();
      if (t1 < countFrom) continue;
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
    p50_ms: Number(percentile(latencies, 50).toFixed(2)),
    p95_ms: Number(percentile(latencies, 95).toFixed(2)),
    p99_ms: Number(percentile(latencies, 99).toFixed(2)),
    max_ms: Number((latencies.at(-1) ?? NaN).toFixed(2)),
    statuses: Object.fromEntries(statuses),
  };
}

const results = [];
for (const c of values.clients.split(",").map((s) => Number(s.trim())).filter((n) => n > 0)) {
  const r = await run(c);
  results.push(r);
  if (!values.json) {
    console.log(`${values.url}  clients=${c}  rps=${r.rps}  p50=${r.p50_ms}ms  p95=${r.p95_ms}ms  p99=${r.p99_ms}ms  errors=${r.errors}`);
  }
}
if (values.json) console.log(JSON.stringify({url: values.url, results}, null, 2));
