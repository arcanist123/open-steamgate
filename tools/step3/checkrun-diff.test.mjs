import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

for (const engine of ["abap", "go"]) test(`${engine}: CHECKRUN diff enforces nonzero broken parity, ordered tuples and execution origin`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkrun-diff-"));
  const log = join(dir, "abap.log");
  let broken = false, mismatch = false, executed = true;
  const servers = [true, false].map(abap => createServer(async (req, res) => {
    for await (const _ of req) { /* consume body */ }
    if (req.method === "HEAD") {
      res.setHeader("x-csrf-token", "test-token");
      res.setHeader("set-cookie", "session=test; Path=/");
      res.end(); return;
    }
    if (req.url.includes("logoff")) { res.end(); return; }
    assert.equal(req.headers["x-csrf-token"], "test-token");
    assert.equal(req.headers.cookie, "session=test");
    if (abap && executed) appendFileSync(log, `lint-engine=${engine} check=1 issues=1 elapsed=1ms\n`);
    const uri = "/sap/bc/adt/oo/classes/zcl_osd_adt_logoff";
    const message = broken ? `<c:checkMessage c:uri="${uri}/source/main#start=12,5" c:type="E" c:shortText="&quot;step3_undefined&quot; not found, Target${mismatch && !abap ? " different" : ""}"/>` : "";
    res.setHeader("content-type", "application/vnd.sap.adt.checkmessages+xml");
    res.end(`<c:checkRunReports xmlns:c="http://www.sap.com/adt/checkrun"><c:checkReport c:triggeringUri="${uri}" c:status="processed"><c:checkMessageList>${message}</c:checkMessageList></c:checkReport></c:checkRunReports>`);
  }));
  try {
    for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    const run = async variant => {
      writeFileSync(log, `lint-engine=${engine} prime=1 files=1 elapsed=1ms\n`);
      const child = spawn(process.execPath, [fileURLToPath(new URL("./checkrun-diff.mjs", import.meta.url)),
        "--abap", `http://127.0.0.1:${servers[0].address().port}`, "--node", `http://127.0.0.1:${servers[1].address().port}`,
        "--abap-log", log, "--variant", variant], {stdio: ["ignore", "pipe", "pipe"]});
      let output = "";
      child.stdout.on("data", data => { output += data; });
      child.stderr.on("data", data => { output += data; });
      const [code] = await once(child, "close");
      return {code, output};
    };
    assert.equal((await run("clean")).code, 0);
    broken = true;
    const match = await run("broken");
    assert.equal(match.code, 0, match.output);
    assert.equal((match.output.match(/PASS/g) ?? []).length, 2, "repeat must check twice");
    mismatch = true;
    const diff = await run("broken");
    assert.equal(diff.code, 1, diff.output);
    assert.match(diff.output, /ordered report differs/);
    mismatch = false; executed = false;
    const origin = await run("broken");
    assert.equal(origin.code, 1);
    assert.match(origin.output, /origin gate/);
    broken = false; executed = true;
    const falseClean = await run("broken");
    assert.equal(falseClean.code, 1);
    assert.match(falseClean.output, /broken logoff must diagnose/);
  } finally {
    for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    rmSync(dir, {recursive: true, force: true});
  }
});

for (const engine of ["abap", "go"]) test(`${engine}: overlay and saved-edit gates exercise clean/broken/clean, new objects and cleanup`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "checkrun-edits-"));
  const log = join(dir, "abap.log");
  const uri = "/sap/bc/adt/oo/classes/zcl_osd_adt_logoff";
  const clean = "CLASS zcl_osd_adt_logoff IMPLEMENTATION.\n  METHOD valid_id.\n    rv_valid = boolc( 1 = 1 ).\n  ENDMETHOD.\nENDCLASS.\n";
  const states = [];
  let mismatch = false, failCheck = false;
  const servers = [true, false].map(abap => {
    const state = {saved: clean, locked: false, puts: [], overlays: [], checks: []};
    states.push(state);
    return createServer(async (req, res) => {
      let body = "";
      for await (const data of req) body += data;
      const url = new URL(req.url, "http://localhost");
      if (req.method === "HEAD") {
        res.setHeader("x-csrf-token", "test-token"); res.setHeader("set-cookie", "session=test; Path=/"); res.end(); return;
      }
      if (url.pathname.includes("logoff") && !url.pathname.includes("zcl_osd_adt_logoff")) {res.end(); return;}
      assert.equal(req.headers["x-csrf-token"], "test-token");
      if (url.pathname.endsWith("zcl_step3_overlay_new")) {res.statusCode = 404; res.end(); return;}
      if (url.pathname === uri && req.method === "POST") {
        if (url.searchParams.get("_action") === "LOCK") {state.locked = true; res.end("<LOCK_HANDLE>test-handle</LOCK_HANDLE>");}
        else {assert.equal(url.searchParams.get("lockHandle"), "test-handle"); state.locked = false; res.end();}
        return;
      }
      if (url.pathname === uri + "/source/main") {
        if (req.method === "PUT") {
          assert.equal(state.locked, true); assert.equal(url.searchParams.get("lockHandle"), "test-handle");
          state.saved = body; state.puts.push(body); res.end();
        } else res.end(state.saved);
        return;
      }
      assert.equal(url.pathname, "/sap/bc/adt/checkruns");
      const target = /adtcore:uri="([^"]+)"/.exec(body)[1];
      const content = /<chkrun:content>([^<]*)<\/chkrun:content>/.exec(body);
      const source = content ? Buffer.from(content[1], "base64").toString("utf8") : state.saved;
      if (content) state.overlays.push({target, source});
      state.checks.push({target, source});
      if (abap) appendFileSync(log, `lint-engine=${engine} check=1 issues=1 elapsed=1ms\n`);
      const broken = source.includes("step3_undefined");
      if (broken && abap && failCheck) {res.statusCode = 503; res.end("thrown check"); return;}
      const message = broken ? `<c:checkMessage c:uri="${target}/source/main#start=3,5" c:type="E" c:shortText="step3_undefined${mismatch && !abap ? " different" : ""}"/>` : "";
      res.end(`<c:checkRunReports xmlns:c="http://www.sap.com/adt/checkrun"><c:checkReport c:triggeringUri="${target}" c:status="processed"><c:checkMessageList>${message}</c:checkMessageList></c:checkReport></c:checkRunReports>`);
    });
  });
  try {
    for (const server of servers) {server.listen(0, "127.0.0.1"); await once(server, "listening");}
    const run = async mode => {
      writeFileSync(log, `lint-engine=${engine} prime=1 files=1 elapsed=1ms\n`);
      const child = spawn(process.execPath, [fileURLToPath(new URL("./checkrun-diff.mjs", import.meta.url)), "--abap", `http://127.0.0.1:${servers[0].address().port}`, "--node", `http://127.0.0.1:${servers[1].address().port}`, "--abap-log", log, "--mode", mode], {stdio: ["ignore", "pipe", "pipe"]});
      let output = "";
      child.stdout.on("data", d => {output += d;}); child.stderr.on("data", d => {output += d;});
      const [code] = await once(child, "close"); return {code, output};
    };
    const overlay = await run("overlay");
    assert.equal(overlay.code, 0, overlay.output);
    assert.equal((overlay.output.match(/PASS/g) ?? []).length, 14);
    for (const state of states) {
      assert.equal(state.saved, clean); assert.equal(state.puts.length, 0);
      assert.equal(state.overlays.filter(o => o.target.endsWith("zcl_step3_overlay_new")).length, 2);
    }
    for (const state of states) {state.overlays = []; state.checks = [];}
    const saved = await run("saved-edit");
    assert.equal(saved.code, 0, saved.output);
    assert.equal((saved.output.match(/PASS/g) ?? []).length, 6);
    for (const state of states) {
      assert.equal(state.saved, clean); assert.equal(state.locked, false); assert.equal(state.overlays.length, 0);
      assert.deepEqual(state.puts.map(s => s.includes("step3_undefined")), [false, true, false, false, true, false, false]);
    }
    mismatch = true;
    const failed = await run("saved-edit");
    assert.equal(failed.code, 1, failed.output);
    assert.match(failed.output, /ordered report differs/);
    for (const state of states) {assert.equal(state.saved, clean); assert.equal(state.locked, false);}
    mismatch = false; failCheck = true;
    const thrown = await run("saved-edit");
    assert.equal(thrown.code, 1, thrown.output);
    assert.match(thrown.output, /HTTP status: thrown check/);
    for (const state of states) {assert.equal(state.saved, clean); assert.equal(state.locked, false);}
  } finally {
    for (const server of servers) {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));}
    rmSync(dir, {recursive: true, force: true});
  }
});
