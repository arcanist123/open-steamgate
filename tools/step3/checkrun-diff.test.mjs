import {test} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {once} from "node:events";
import {spawn} from "node:child_process";
import {appendFileSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";

test("CHECKRUN diff enforces nonzero broken parity, ordered tuples and execution origin", async () => {
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
    if (abap && executed) appendFileSync(log, "lint-engine=abap check=1 issues=1 elapsed=1ms\n");
    const uri = "/sap/bc/adt/oo/classes/zcl_osd_adt_logoff";
    const message = broken ? `<c:checkMessage c:uri="${uri}/source/main#start=12,5" c:type="E" c:shortText="&quot;step3_undefined&quot; not found, Target${mismatch && !abap ? " different" : ""}"/>` : "";
    res.setHeader("content-type", "application/vnd.sap.adt.checkmessages+xml");
    res.end(`<c:checkRunReports xmlns:c="http://www.sap.com/adt/checkrun"><c:checkReport c:triggeringUri="${uri}" c:status="processed"><c:checkMessageList>${message}</c:checkMessageList></c:checkReport></c:checkRunReports>`);
  }));
  try {
    for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    const run = async variant => {
      writeFileSync(log, "lint-engine=abap prime=1 files=1 elapsed=1ms\n");
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
