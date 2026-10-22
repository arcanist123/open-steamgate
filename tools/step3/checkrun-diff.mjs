#!/usr/bin/env node
// Actual ADT reports, including URI/coordinate mapping and the ABAP serializer.
import assert from "node:assert/strict";
import {readFileSync, mkdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {parseArgs} from "node:util";
import {Session} from "../../test/adt-conformance/session.mjs";
import {responseElements} from "../../test/adt-conformance/xml.mjs";

const {values} = parseArgs({options: {
  abap: {type: "string"}, node: {type: "string"}, objects: {type: "string"},
  variant: {type: "string", default: "clean"}, "abap-log": {type: "string"},
  out: {type: "string"}, repeat: {type: "string", default: "2"},
}});
assert.ok(values.abap && values.node && values["abap-log"],
  "usage: checkrun-diff.mjs --abap URL --node URL --abap-log FILE [--objects JSON] [--variant clean|broken] [--out DIR] [--repeat 2]");
assert.ok(["clean", "broken"].includes(values.variant), "variant must be clean or broken");
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
  return {status: attr(r, "status"), issues, ...(attr(r, "status") === "notProcessed" ? {statusText: attr(r, "statusText")} : {})};
}
const readOrigin = () => {
  const log = readFileSync(values["abap-log"], "utf8");
  assert.equal((log.match(/lint-engine=abap prime=1 files=/g) ?? []).length, 1, "origin gate: expected exactly one successful prime in this server's log");
  return (log.match(/lint-engine=abap check=\d+ issues=\d+ elapsed=/g) ?? []).length;
};
const sessions = [new Session(values.abap), new Session(values.node)];
let mismatches = 0;
if (values.out) mkdirSync(values.out, {recursive: true});
try {
  for (const session of sessions) await session.login();
  for (let round = 1; round <= repeat; round++) {
    for (const [i, c] of cases.entries()) {
      const before = readOrigin();
      const body = `<chkrun:checkObjectList xmlns:chkrun="${ns}" xmlns:adtcore="http://www.sap.com/adt/core"><chkrun:checkObject adtcore:uri="${xmlEscape(c.uri)}"/></chkrun:checkObjectList>`;
      const results = [];
      for (const [engine, session] of sessions.entries()) {
        const response = await session.request({method: "POST", path: "/checkruns", headers: {"content-type": "application/xml"}, body});
        assert.equal(response.status, 200, `${engine === 0 ? "ABAP" : "Node"} HTTP status: ${response.body}`);
        results.push(report(response.body, c.uri));
        if (values.out) writeFileSync(join(values.out, `${values.variant}-${round}-${i}-${engine === 0 ? "abap" : "node"}.xml`), response.body);
      }
      assert.equal(readOrigin(), before + 1, "origin gate: request did not complete exactly one ABAP facade check (use an otherwise idle server)");
      try {
        for (const result of results) {
          assert.equal(result.status, "processed", JSON.stringify(result));
          if (c.issues !== undefined) assert.equal(result.issues.length, c.issues);
          if (c.minIssues !== undefined) assert.ok(result.issues.length >= c.minIssues);
          if (c.uri === logoff) {
            if (values.variant === "clean") assert.equal(result.issues.length, 0, "clean logoff must have zero diagnostics");
            else assert.ok(result.issues.some(issue => issue.message.includes("step3_undefined")), "broken logoff must diagnose step3_undefined");
          }
        }
        assert.deepEqual(results[0], results[1], "ordered report differs");
        console.log(`PASS ${values.variant} round=${round} ${c.uri} issues=${results[0].issues.length}`);
      } catch (error) {
        mismatches++;
        console.error(`FAIL ${values.variant} round=${round} ${c.uri}: ${error.message}\n${JSON.stringify({abap: results[0], node: results[1]}, null, 2)}`);
      }
      if (values.out) writeFileSync(join(values.out, `${values.variant}-${round}-${i}.json`), JSON.stringify({uri: c.uri, abap: results[0], node: results[1]}, null, 2) + "\n");
    }
  }
} finally {
  for (const session of sessions) await session.close();
}
if (mismatches) process.exitCode = 1;
