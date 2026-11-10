#!/usr/bin/env node
// A sidecar crash against a running gateway (go/osgw, ADR 0010 slice 3),
// with the real osgo behind it:
//
//   node tools/osgw-live.mjs --base http://127.0.0.1:<port>
//
// Session A takes an ADT lock on a class, session B is refused it; the
// sidecar that serves is killed -9 while eight source reads are in flight.
// Each of those answers 200 (done before the kill) or 503 (lost with it,
// never a dropped connection), a replacement serves within the start timeout,
// the gateway's lock table is empty (A's session died with the process that
// held it), and a fresh session C gets the lock. Exit 0 when all of that
// holds, 1 when something does not, 2 when the gateway could not be asked.
import {Session} from "../test/adt-conformance/session.mjs";
import {runsAs} from "./osd-main.mjs";

const CLASS = "/oo/classes/zcl_zstg_demo_dpc_ext";

export async function crashWithLocks(base, {log = console.log, waitMs = 60000} = {}) {
  const serving = async () => (await fetch(`${base}/osd/serving`)).json().catch(() => ({}));
  const lock = (s) => s.request({method: "POST", path: CLASS, query: {_action: "LOCK", accessMode: "MODIFY"},
    headers: {accept: "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result"}});
  const fails = [];
  const check = (ok, what) => { if (!ok) fails.push(what); };
  const a = await new Session(base).login();
  const la = await lock(a);
  log(`A LOCK ${la.status}`);
  check(la.status === 200 && /LOCK_HANDLE/.test(la.body), "session A takes the lock");
  const b = await new Session(base).login();
  const lb = await lock(b);
  log(`B LOCK while A holds it: ${lb.status}`);
  check(lb.status !== 200, "session B is refused while A holds it");
  const before = await serving();
  log(`before: sidecar pid ${before.pid}, ${before.gateway?.locks} lock row(s)`);
  check(Number.isInteger(before.gateway?.locks) && before.gateway.locks >= 1, "the gateway's table holds A's lock");
  check(Number.isInteger(before.pid) && before.pid !== before.launcherPid, "pid is the sidecar, not the gateway");
  const reads = Array.from({length: 8}, () => fetch(`${base}/sap/bc/adt${CLASS}/source/main`)
    .then((r) => String(r.status), (e) => `error ${e.cause?.code ?? e.message}`));
  await new Promise((r) => setTimeout(r, 40));
  process.kill(before.pid, "SIGKILL");
  const statuses = await Promise.all(reads);
  log(`in flight during the kill: ${statuses.join(" ")}`);
  check(statuses.every((s) => s === "200" || s === "503"), "every request in flight answers 200 or 503");
  check(statuses.includes("503"), "a request lost with the sidecar answers 503");
  let after = {};
  for (const t0 = Date.now(); Date.now() - t0 < waitMs;) {
    after = await serving();
    if (after.ready && after.pid !== before.pid) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  log(`after: sidecar pid ${after.pid}, ${after.gateway?.locks} lock row(s), restarts ${after.gateway?.restarts}`);
  check(after.ready === true && after.pid !== before.pid, "a replacement sidecar serves");
  check(after.gateway?.locks === 0, "the dead sidecar's locks are released");
  const c = await new Session(base).login();
  const lc = await lock(c);
  log(`C LOCK after the crash: ${lc.status}`);
  check(lc.status === 200 && /LOCK_HANDLE/.test(lc.body), "a new session takes the lock");
  await c.request({method: "POST", path: CLASS, query: {_action: "UNLOCK", lockHandle: /<LOCK_HANDLE>([^<]*)/.exec(lc.body)?.[1] ?? ""}});
  await c.close();
  return fails;
}

async function main(argv) {
  const at = argv.indexOf("--base");
  const base = at >= 0 ? argv[at + 1]?.replace(/\/+$/, "") : undefined;
  if (!base) { console.error("usage: node tools/osgw-live.mjs --base <gateway url>"); return 2; }
  let fails;
  try {
    fails = await crashWithLocks(base);
  } catch (e) {
    console.error(`osgw-live: ${base} could not be asked: ${e?.message ?? e}`);
    return 2;
  }
  for (const f of fails) console.error(`osgw-live: failed: ${f}`);
  console.log(fails.length ? "osgw-live: FAILED" : "osgw-live: crash with locks held: ok");
  return fails.length ? 1 : 0;
}

if (runsAs("osgw-live.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
