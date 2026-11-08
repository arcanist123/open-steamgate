#!/usr/bin/env node
// The supervised-host contract, checked over HTTP against any host -- the
// Node facade (test/start.mjs), the Node child alone, or the osgo binary --
// so the two hosts are held to the same answer by one check rather than by
// two descriptions of it (go/serving/README.md, docs/osgo-release.md):
//
//   node tools/osd-host-contract.mjs --base http://127.0.0.1:3095
//       GET /osd/serving is 200 JSON with ready: true, a generation, a pid,
//       launcherPid, root, database and hot; X-OSD-Generation is on that
//       answer and on the OData front's 404 for an unknown service (an answer
//       the same ABAP gives on both hosts, so the header is checked on an
//       ABAP answer and not on a route one host lacks), equal to the body's
//       generation.
//   node tools/osd-host-contract.mjs --base <url> --drain <pid> [--grace-ms 55000]
//       also sends SIGTERM to <pid> and times its exit: it must be gone
//       within the grace (the launcher's SIGKILL follows at 60 s).
//
// Exit 0 when every assertion holds, 1 on the first that does not, 2 when the
// host could not be asked at all.
import assert from "node:assert/strict";
import {runsAs} from "./osd-main.mjs";

export async function checkHostContract(base, {fetchAnswer = fetch} = {}) {
  const url = base.replace(/\/+$/, "");
  const serving = await fetchAnswer(`${url}/osd/serving`);
  assert.equal(serving.status, 200, "GET /osd/serving answers 200 while serving");
  assert.match(serving.headers.get("content-type") ?? "", /^application\/json/, "/osd/serving is JSON");
  const body = await serving.json();
  assert.equal(body.ready, true, "ready is true");
  assert.equal(typeof body.generation, "string", "generation is a string");
  assert.ok(body.generation.length > 0, "generation is not empty");
  assert.ok(Number.isInteger(body.pid) && body.pid > 0, "pid is the serving process");
  assert.ok(Number.isInteger(body.launcherPid) && body.launcherPid > 0, "launcherPid is the process a launcher owns");
  assert.equal(typeof body.root, "string", "root names the tree");
  assert.equal(typeof body.database, "string", "database names the file or :memory:");
  assert.ok(body.hot && typeof body.hot === "object", "hot describes the warm swaps");
  assert.ok(Number.isInteger(body.hot.swaps), "hot.swaps counts");
  assert.equal(typeof body.hot.unverified, "boolean", "hot.unverified is a flag");
  // the Node child answers Date.now() at its start (tools/osd-serve.mjs)
  assert.ok(Number.isInteger(body.since) && body.since > 0, "since is the start in epoch milliseconds");
  // Node labels an unverified warm generation "<hash> warm-unverified" in the
  // header and in the body alike, so the two are equal as strings
  const header = serving.headers.get("x-osd-generation");
  assert.equal(header, body.generation, "X-OSD-Generation equals the body's generation");
  const missing = await fetchAnswer(`${url}/sap/opu/odata/sap/ZSTG_NO_SUCH_SRV_${Date.now().toString(36).toUpperCase()}/`);
  assert.equal(missing.status, 404, "an unknown OData service is 404 (STG/SERVICE_NOT_FOUND)");
  assert.equal(missing.headers.get("x-osd-generation"), body.generation, "X-OSD-Generation is on every answer, the 404 included");
  return body;
}

/** SIGTERM to pid, then the time until it is gone; throws past the grace. */
export async function timeDrain(pid, {graceMs = 55000, signal = "SIGTERM", kill = process.kill, now = Date.now, sleep} = {}) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const alive = () => { try { kill(pid, 0); return true; } catch (e) { return e?.code === "EPERM"; } };
  const started = now();
  kill(pid, signal);
  while (alive()) {
    if (now() - started > graceMs) throw new Error(`pid ${pid} still alive ${now() - started} ms after ${signal} (grace ${graceMs} ms)`);
    await wait(20);
  }
  return now() - started;
}

async function main(argv) {
  const arg = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const base = arg("--base");
  if (!base) { console.error("usage: node tools/osd-host-contract.mjs --base <url> [--drain <pid>] [--grace-ms <ms>]"); return 2; }
  let body;
  try {
    body = await checkHostContract(base);
  } catch (e) {
    if (e instanceof assert.AssertionError) { console.error(`host contract: ${e.message}`); return 1; }
    console.error(`host contract: ${base} could not be asked: ${e?.message ?? e}`); return 2;
  }
  console.log(`host contract: ${base} serves generation ${body.generation} (pid ${body.pid}, root ${body.root}, database ${body.database})`);
  const drain = arg("--drain");
  if (drain !== undefined) {
    const pid = Number(drain);
    if (!Number.isInteger(pid) || pid <= 0) { console.error(`--drain: not a pid: ${drain}`); return 2; }
    const graceMs = Number(arg("--grace-ms") ?? 55000);
    try {
      const ms = await timeDrain(pid, {graceMs});
      console.log(`host contract: pid ${pid} left ${ms} ms after SIGTERM (grace ${graceMs} ms)`);
    } catch (e) { console.error(`host contract: ${e?.message ?? e}`); return 1; }
  }
  return 0;
}

if (runsAs("osd-host-contract.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
