#!/usr/bin/env node
// The generation swap against a running gateway (go/osgw, ADR 0010 slice 4),
// with the real osgo and the real builder behind it:
//
//   osgw -build "node tools/gogen/osgo.mjs --fast" -port N -- -adt -root . -home <dir>
//   node tools/osgw-swap-live.mjs --base http://127.0.0.1:N [--wait-ms 900000]
//
// What it proves, in order (exit 0 when all of it holds, 1 when something
// does not, 2 when the gateway could not be asked):
//   1. ABAP Unit runs the fixture's passing method in the serving generation.
//   2. Session P takes an ADT lock and stays pinned to that generation.
//   3. Session E saves a changed body of ZCL_ZOSD_TEST_DEMO and activates
//      it: the answer is a published activation whose X-OSD-Build is
//      "published; building b<n>"; right after it, ABAP Unit on the class
//      answers 409 (the class changed since this generation was built).
//   4. The next generation serves within --wait-ms: /osd/serving names
//      another generation and says X-OSD-Build "live <it>"; the next answer
//      carries it, and ABAP Unit runs the new code (the passing method now
//      fails on the changed text) instead of answering 409. This is X1 as
//      the Node host does it: activate a change, the next answer runs it.
//   5. A new session Q, in the new generation, is refused the lock P holds
//      in the old one, and gets it once P releases it; P logs off and the
//      old generation retires.
//   6. The change is reverted and activated the same way, and the third
//      generation serves the original code again (two swaps).
//   7. With --db <the sidecar's database file>: the file's schema stamp is
//      made another build's, a change is activated, and the candidate the
//      build starts refuses the file: X-OSD-Build "built; schema differs,
//      restart needed", the serving generation unchanged, every row of the
//      file as it was. The stamp and the source are restored afterwards.
import {Session} from "../test/adt-conformance/session.mjs";
import {runsAs} from "./osd-main.mjs";

const FIXTURE = "/oo/classes/zcl_zosd_test_demo";
const LOCKED = "/oo/classes/zcl_zstg_demo_dpc_ext";
const LOCK_ACCEPT = "application/*,application/vnd.sap.as+xml;charset=UTF-8;dataname=com.sap.adt.lock.result";
const unitBody = (method) => `<?xml version="1.0" encoding="UTF-8"?><aunit:runConfiguration xmlns:aunit="http://www.sap.com/adt/aunit"><external><coverage active="false"/></external><options><uriType value="semantic"/><testDeterminationStrategy sameProgram="true" assignedTests="false"/><testRiskLevels harmless="true" dangerous="true" critical="true"/><testDurations short="true" medium="true" long="true"/><withNavigationUri enabled="true"/></options><adtcore:objectSets xmlns:adtcore="http://www.sap.com/adt/core"><objectSet kind="inclusive"><adtcore:objectReferences><adtcore:objectReference adtcore:uri="/sap/bc/adt${FIXTURE}#testclass=ltcl_zosd_test_demo;testmethod=${method}"/></adtcore:objectReferences></objectSet></adtcore:objectSets></aunit:runConfiguration>`;
const activationBody = `<?xml version="1.0" encoding="UTF-8"?><adtcore:objectReferences xmlns:adtcore="http://www.sap.com/adt/core"><adtcore:objectReference adtcore:uri="/sap/bc/adt${FIXTURE}" adtcore:name="ZCL_ZOSD_TEST_DEMO"/></adtcore:objectReferences>`;

// one ABAP Unit run in a session of its own (logged on, run, logged off)
async function unit(base, method) {
  const s = await new Session(base).login();
  try {
    return await s.request({method: "POST", path: "/abapunit/testruns", timeout: 120000,
      headers: {"content-type": "application/vnd.sap.adt.abapunit.testruns.config.v4+xml", accept: "application/vnd.sap.adt.abapunit.testruns.result.v2+xml"},
      body: unitBody(method)});
  } finally {
    await s.close().catch(() => {});
  }
}
const lock = (s, path) => s.request({method: "POST", path, query: {_action: "LOCK", accessMode: "MODIFY"}, headers: {accept: LOCK_ACCEPT}});
const handleOf = (r) => /<LOCK_HANDLE>([^<]*)/.exec(r.body)?.[1] ?? "";
const unlock = (s, path, handle) => s.request({method: "POST", path, query: {_action: "UNLOCK", lockHandle: handle}});

// save a new main source and activate it in one session; the activation's answer
async function saveAndActivate(base, source) {
  const e = await new Session(base).login();
  try {
    const l = await lock(e, FIXTURE);
    if (l.status !== 200) throw new Error(`LOCK ${FIXTURE}: ${l.status} ${l.body.slice(0, 200)}`);
    const handle = handleOf(l);
    const put = await e.request({method: "PUT", path: `${FIXTURE}/source/main`, query: {lockHandle: handle},
      headers: {"content-type": "text/plain; charset=utf-8"}, body: source});
    if (put.status !== 200) throw new Error(`PUT: ${put.status} ${put.body.slice(0, 200)}`);
    await unlock(e, FIXTURE, handle);
    return await e.request({method: "POST", path: "/activation", query: {method: "activate", preauditRequested: "true"}, timeout: 300000,
      headers: {"content-type": "application/xml", accept: "application/xml"}, body: activationBody});
  } finally {
    await e.close().catch(() => {});
  }
}

export async function swapLive(base, {log = console.log, waitMs = 900000} = {}) {
  const fails = [];
  const check = (ok, what) => { if (!ok) fails.push(what); log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  const serving = async () => {
    const r = await fetch(`${base}/osd/serving`);
    return {build: r.headers.get("x-osd-build") ?? "", ...(await r.json().catch(() => ({})))};
  };
  const waitGeneration = async (from) => {
    const t0 = Date.now();
    let s = {};
    while (Date.now() - t0 < waitMs) {
      s = await serving();
      if (s.ready && s.generation && s.generation !== from) return {...s, ms: Date.now() - t0};
      if (/^build failed|schema differs/.test(s.build)) return {...s, ms: Date.now() - t0};
      await new Promise((r) => setTimeout(r, 500));
    }
    return {...s, ms: Date.now() - t0};
  };

  const start = await serving();
  log(`serving ${start.generation} (sidecar pid ${start.pid})`);
  const reader = await new Session(base).login();
  const original = (await reader.request({path: `${FIXTURE}/source/main`})).body;
  await reader.close();
  check(original.includes("rv_text = 'Open'."), "the fixture has the text the passing test expects");

  const before = await unit(base, "greeting_passes");
  check(before.status === 200 && !/<alert /.test(before.body), "1. ABAP Unit passes in the serving generation");

  const p = await new Session(base).login();
  const lp = await lock(p, LOCKED);
  check(lp.status === 200 && handleOf(lp) !== "", "2. session P takes an ADT lock");

  const changed = original.replace("rv_text = 'Open'.", "rv_text = 'Opened'.");
  const t0 = Date.now();
  const act = await saveAndActivate(base, changed);
  const header = act.headers.get("x-osd-build") ?? "";
  log(`activation: ${act.status} X-OSD-Build: ${header}`);
  check(act.status === 200 && /activationExecuted="true"/.test(act.body) && /generationExecuted="false"/.test(act.body),
    "3. the changed class is published");
  check(/^published; building b\d+/.test(header), "3. the activation answer names the build");
  const stale = await unit(base, "greeting_passes");
  check(stale.status === 409, `3. ABAP Unit refuses the changed class before the swap (${stale.status})`);

  const next = await waitGeneration(start.generation);
  log(`after ${next.ms} ms: serving ${next.generation} (pid ${next.pid}), X-OSD-Build: ${next.build}`);
  check(next.generation && next.generation !== start.generation, "4. another generation serves");
  check(next.build === `live ${next.generation}`, "4. X-OSD-Build says live");
  const probe = await fetch(`${base}/sap/bc/adt${FIXTURE}/source/main`);
  check(probe.headers.get("x-osd-generation") === next.generation, "4. the next answer carries the new generation");
  const after = await unit(base, "greeting_passes");
  check(after.status === 200 && /failedAssertion/.test(after.body) && /Opened/.test(after.body),
    `4. ABAP Unit runs the new code: 409 gone, the changed text fails the test (${after.status})`);
  const sidecars = next.gateway?.sidecars ?? [];
  const old = sidecars.find((s) => s.generation === start.generation && s.pid === start.pid);
  check(old?.state === "draining", `5. the old generation drains while P is pinned (${old?.state})`);

  const q = await new Session(base).login();
  const lq = await lock(q, LOCKED);
  check(lq.status !== 200, `5. session Q in the new generation is refused P's lock (${lq.status})`);
  await unlock(p, LOCKED, handleOf(lp));
  const lq2 = await lock(q, LOCKED);
  check(lq2.status === 200, `5. Q gets the lock once P released it (${lq2.status})`);
  await unlock(q, LOCKED, handleOf(lq2));
  await q.close();
  await p.close();
  // the logoff unpins P (the gateway ends a session at the ICF logoff), so
  // the old generation drains at once and exits 0, not killed at the grace
  let gone;
  for (const t = Date.now(); Date.now() - t < 30000 && !gone;) {
    const s = await serving();
    gone = (s.gateway?.sidecars ?? []).find((x) => x.pid === start.pid && x.state === "retired");
    if (!gone) await new Promise((r) => setTimeout(r, 250));
  }
  check(gone?.why === "exit 0", `5. the old generation retires after P logged off, drained, not killed (${gone?.why ?? "still there"})`);

  const back = await saveAndActivate(base, original);
  check(/^published; building b\d+/.test(back.headers.get("x-osd-build") ?? ""), "6. the revert is published and builds");
  const third = await waitGeneration(next.generation);
  log(`after ${third.ms} ms: serving ${third.generation}, X-OSD-Build: ${third.build}, swaps ${third.hot?.swaps}`);
  check(third.generation && third.generation !== next.generation, "6. a third generation serves");
  const again = await unit(base, "greeting_passes");
  check(again.status === 200 && !/<alert /.test(again.body), "6. ABAP Unit passes again on the reverted code");
  check(third.hot?.swaps === 2, "6. two swaps counted");
  log(`edit to the new generation serving: ${next.ms} ms after the activation (${Date.now() - t0} ms for the whole run)`);
  return {fails, firstSwapMs: next.ms, secondSwapMs: third.ms};
}

// 7: a candidate whose schema is not the file's refuses the swap
export async function schemaRefusal(base, db, {log = console.log, waitMs = 900000} = {}) {
  const {DatabaseSync} = await import("node:sqlite");
  const fails = [];
  const check = (ok, what) => { if (!ok) fails.push(what); log(`${ok ? "ok  " : "FAIL"} ${what}`); };
  const serving = async () => {
    const r = await fetch(`${base}/osd/serving`);
    return {build: r.headers.get("x-osd-build") ?? "", ...(await r.json().catch(() => ({})))};
  };
  const file = new DatabaseSync(db);
  file.exec("PRAGMA busy_timeout = 10000");
  const rows = () => file.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all()
    .map(({name}) => `${name}:${file.prepare(`SELECT count(*) AS n FROM "${name}"`).get().n}`).join(",");
  const stamp = file.prepare("SELECT fingerprint FROM osd_schema").get()?.fingerprint;
  check(/^[0-9a-f]{16}$/.test(String(stamp).trim()), `7. the file carries a schema stamp (${stamp})`);
  file.prepare("UPDATE osd_schema SET fingerprint = 'ffffffffffffffff'").run();
  const before = await serving();
  const counts = rows();
  const reader = await new Session(base).login();
  const original = (await reader.request({path: `${FIXTURE}/source/main`})).body;
  await reader.close();
  try {
    const act = await saveAndActivate(base, original.replace("rv_text = 'Open'.", "rv_text = 'Opened'."));
    check(/^published; building b\d+/.test(act.headers.get("x-osd-build") ?? ""), "7. the change is published and builds");
    let s = {};
    for (const t = Date.now(); Date.now() - t < waitMs;) {
      s = await serving();
      if (s.gateway?.build?.state === "refused" || s.gateway?.build?.state === "failed" || s.gateway?.build?.state === "live") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    log(`build: ${JSON.stringify(s.gateway?.build)}`);
    check(s.build === "built; schema differs, restart needed", `7. X-OSD-Build says the schema differs (${s.build})`);
    check(s.generation === before.generation && s.pid === before.pid, "7. the generation that served serves on");
    check(rows() === counts, "7. every table of the file has the rows it had");
  } finally {
    file.prepare("UPDATE osd_schema SET fingerprint = ?").run(String(stamp).trim());
    file.close();
    const back = await saveAndActivate(base, original);
    check(/generationExecuted="true"/.test(back.body) && !back.headers.get("x-osd-build"), "7. the reverted source is the serving build's again: nothing to build");
  }
  return fails;
}

async function main(argv) {
  const opt = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const base = opt("--base")?.replace(/\/+$/, "");
  if (!base) { console.error("usage: node tools/osgw-swap-live.mjs --base <gateway url> [--wait-ms N] [--db <sidecar database file>]"); return 2; }
  let result;
  try {
    result = await swapLive(base, {waitMs: Number(opt("--wait-ms") ?? 900000)});
  } catch (e) {
    console.error(`osgw-swap-live: ${base}: ${e?.stack ?? e}`);
    return 2;
  }
  const db = opt("--db");
  if (db) {
    try {
      result.fails.push(...await schemaRefusal(base, db, {waitMs: Number(opt("--wait-ms") ?? 900000)}));
    } catch (e) {
      console.error(`osgw-swap-live: the schema refusal: ${e?.stack ?? e}`);
      return 2;
    }
  }
  console.log(result.fails.length ? `osgw-swap-live: FAILED (${result.fails.length})` : "osgw-swap-live: the generation swap: ok");
  return result.fails.length ? 1 : 0;
}

if (runsAs("osgw-swap-live.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(e); process.exit(2); });
}
