#!/usr/bin/env node
// Actual ADT reports, including URI/coordinate mapping and the ABAP serializer.
import assert from "node:assert/strict";
import {lintOrigin} from "./lint-origin.mjs";
import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {parseArgs} from "node:util";
import {Session} from "../../test/adt-conformance/session.mjs";
import {responseElements} from "../../test/adt-conformance/xml.mjs";

const {values} = parseArgs({options: {
  abap: {type: "string"}, node: {type: "string"}, objects: {type: "string"},
  variant: {type: "string", default: "clean"}, "abap-log": {type: "string"},
  mode: {type: "string", default: "saved"},
  out: {type: "string"}, repeat: {type: "string", default: "2"},
}});
assert.ok(values.abap && values.node && values["abap-log"],
  "usage: checkrun-diff.mjs --abap URL --node URL --abap-log FILE [--objects JSON] [--variant clean|broken] [--mode saved|overlay|saved-edit] [--out DIR] [--repeat 2]");
assert.ok(["clean", "broken"].includes(values.variant), "variant must be clean or broken");
assert.ok(["saved", "overlay", "saved-edit"].includes(values.mode), "invalid mode");
const repeat = Number(values.repeat);
assert.ok(Number.isSafeInteger(repeat) && repeat > 0, "repeat must be a positive integer");
const logoff = "/sap/bc/adt/oo/classes/zcl_osd_adt_logoff";
const objects = values.objects ? JSON.parse(readFileSync(values.objects, "utf8")) : [];
assert.ok(Array.isArray(objects), "objects must be an array of URIs or {uri, issues?, minIssues?}");
const cases = objects.map(o => typeof o === "string" ? {uri: o} : o);
if (!cases.some(o => o.uri === logoff)) cases.push({uri: logoff});
for (const c of cases) assert.ok(typeof c.uri === "string" && c.uri.startsWith("/sap/bc/adt/"), "expected absolute ADT object URI");
const xmlEscape = s => s.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const ns = "http://www.sap.com/adt/checkrun";
function report(xml, uri) {
  const elements = responseElements(xml);
  const attr = (e, local) => e.attributes.find(a => a.uri === ns && a.local === local)?.value;
  const reports = elements.filter(e => e.uri === ns && e.local === "checkReport");
  assert.equal(reports.length, 1, "expected one checkReport");
  const r = reports[0];
  assert.equal(attr(r, "triggeringUri"), uri);
  const issues = elements.filter(e => e.uri === ns && e.local === "checkMessage").map(e => {
    const location = attr(e, "uri");
    const at = /^(.*)#start=(\d+),(\d+)$/.exec(location ?? "");
    assert.ok(at, `missing diagnostic coordinates: ${location}`);
    return {severity: attr(e, "type"), line: Number(at[2]), column: Number(at[3]), message: attr(e, "shortText"), uri: at[1]};
  });
  return {status: attr(r, "status"), issues, ...(attr(r, "statusText") !== undefined ? {statusText: attr(r, "statusText")} : {})};
}
let originEngine;
const readOrigin = () => {
  const origin = lintOrigin(readFileSync(values["abap-log"], "utf8"), originEngine);
  originEngine = origin.engine;
  return origin.checks;
};
const sessions = [new Session(values.abap), new Session(values.node)];
let mismatches = 0;
if (values.out) mkdirSync(values.out, {recursive: true});
async function compare(c, label) {
  const before = readOrigin();
  const content = c.source === undefined ? "" : `<chkrun:content>${Buffer.from(c.source, "utf8").toString("base64")}</chkrun:content>`;
  const body = `<chkrun:checkObjectList xmlns:chkrun="${ns}" xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="${xmlEscape(c.uri)}">${content}</chkrun:checkObject></chkrun:checkObjectList>`;
  const results = [];
  for (const [engine, session] of sessions.entries()) {
    const response = await session.request({method: "POST", path: "/checkruns", headers: {"content-type": "application/xml"}, body});
    assert.equal(response.status, 200, `${engine === 0 ? "ABAP" : "Node"} HTTP status: ${response.body}`);
    results.push(report(response.body, c.uri));
    if (values.out) writeFileSync(join(values.out, `${label}-${engine === 0 ? "abap" : "node"}.xml`), response.body);
  }
  assert.equal(readOrigin(), before + 1, "origin gate: request did not complete exactly one in-process engine check (use an otherwise idle server)");
  try {
    for (const result of results) {
      assert.equal(result.status, "processed", JSON.stringify(result));
      if (c.issues !== undefined) assert.equal(result.issues.length, c.issues);
      if (c.minIssues !== undefined) assert.ok(result.issues.length >= c.minIssues);
      if (c.broken) assert.ok(result.issues.some(issue => issue.message.includes("step3_undefined")), "broken logoff must diagnose step3_undefined");
    }
    assert.deepEqual(results[0], results[1], "ordered report differs");
    console.log(`PASS ${label} ${c.uri} issues=${results[0].issues.length}`);
  } catch (error) {
    mismatches++;
    console.error(`FAIL ${label} ${c.uri}: ${error.message}\n${JSON.stringify({abap: results[0], node: results[1]}, null, 2)}`);
  }
  if (values.out) writeFileSync(join(values.out, `${label}.json`), JSON.stringify({uri: c.uri, abap: results[0], node: results[1]}, null, 2) + "\n");
}
async function savedSource(session) {
  const r = await session.request({path: `${logoff}/source/main`, query: {version: "inactive"}});
  assert.equal(r.status, 200, "read saved logoff source");
  return r.body;
}
async function put(session, handle, source) {
  const r = await session.request({method: "PUT", path: `${logoff}/source/main`, query: {lockHandle: handle}, headers: {"content-type": "text/plain"}, body: source});
  assert.equal(r.status, 200, `PUT saved logoff: ${r.body}`);
}
try {
  for (const session of sessions) await session.login();
  if (values.mode === "saved") {
    for (let round = 1; round <= repeat; round++) for (const [i, c] of cases.entries()) {
      await compare({...c, ...(c.uri === logoff ? values.variant === "clean" ? {issues: 0} : {broken: true} : {})}, `${values.variant}-${round}-${i}`);
    }
  } else {
    const originals = await Promise.all(sessions.map(savedSource));
    assert.equal(originals[0], originals[1], "hosts must start with identical saved logoff source");
    const clean = originals[0];
    assert.ok(!clean.includes("step3_undefined"), "edits gate requires a clean saved logoff");
    const anchor = "    rv_valid = boolc(";
    assert.ok(clean.includes(anchor), "logoff mutation anchor missing");
    const broken = clean.replace(anchor, "    step3_undefined = 1.\n" + anchor);
    if (values.mode === "overlay") {
      const newUri = "/sap/bc/adt/oo/classes/zcl_step3_overlay_new";
      const newSource = "CLASS zcl_step3_overlay_new DEFINITION PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS zcl_step3_overlay_new IMPLEMENTATION.\nENDCLASS.\n";
      const absent = async () => {
        for (const session of sessions) assert.equal((await session.request({path: newUri})).status, 404, "new overlay object must remain absent on disk");
      };
      await absent();
      for (let round = 1; round <= repeat; round++) {
        for (const [phase, source] of [["clean", clean], ["broken", broken], ["clean-again", clean]]) {
          await compare({uri: logoff, source, ...(phase === "broken" ? {broken: true} : {issues: 0})}, `overlay-${round}-${phase}`);
          // Inspect the saved registry after EACH restoration, especially broken.
          await compare({uri: logoff, issues: 0}, `overlay-${round}-${phase}-restored`);
        }
        await compare({uri: newUri, source: newSource, issues: 0}, `overlay-${round}-new`);
        await absent();
        for (const session of sessions) assert.equal(await savedSource(session), clean, "overlay changed saved bytes");
      }
    } else {
      const held = [];
      try {
        for (const session of sessions) {
          const r = await session.request({method: "POST", path: logoff, query: {_action: "LOCK", accessMode: "MODIFY"}, headers: {accept: "application/vnd.sap.as+xml;dataname=com.sap.adt.lock.Result"}});
          assert.equal(r.status, 200, `LOCK logoff: ${r.body}`);
          const handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(r.body)?.[1];
          assert.ok(handle, "LOCK_HANDLE missing");
          held.push({session, handle});
        }
        for (let round = 1; round <= repeat; round++) for (const [phase, source] of [["clean", clean], ["broken", broken], ["clean-again", clean]]) {
          for (const {session, handle} of held) await put(session, handle, source);
          await compare({uri: logoff, ...(phase === "broken" ? {broken: true} : {issues: 0})}, `saved-edit-${round}-${phase}`);
        }
      } finally {
        // Attempt every restore/unlock even when another host's cleanup fails.
        const cleanup = await Promise.allSettled(held.map(async ({session, handle}) => {
          try { await put(session, handle, clean); }
          finally {
            const r = await session.request({method: "POST", path: logoff, query: {_action: "UNLOCK", lockHandle: handle}});
            assert.equal(r.status, 200, `UNLOCK logoff: ${r.body}`);
          }
        }));
        const failed = cleanup.filter(r => r.status === "rejected");
        if (failed.length) throw new AggregateError(failed.map(r => r.reason), "saved-edit cleanup failed");
      }
    }
  }
} finally {
  const closed = await Promise.allSettled(sessions.map(session => session.close()));
  for (const r of closed) if (r.status === "rejected") { console.error(r.reason); process.exitCode = 1; }
}
if (mismatches) process.exitCode = 1;
