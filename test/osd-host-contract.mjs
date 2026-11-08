// tools/osd-host-contract.mjs: the one check both hosts answer to. Here it
// is run against answers made by hand -- a conforming host, and each way a
// host can fall short -- so the check is known to fail before it is trusted
// against the Node facade (test/osd-child.mjs) and the osgo binary (the
// osgo-host CI job).
import {expect} from "chai";
import {checkHostContract, timeDrain} from "../tools/osd-host-contract.mjs";

const answer = (status, body, headers = {}) => new Response(typeof body === "string" ? body : JSON.stringify(body), {
  status, headers: {"content-type": "application/json; charset=utf-8", ...headers}});
const servingBody = {ready: true, pid: 4242, launcherPid: 4242, since: 1794139200000, generation: "go:0123456789abcdef",
  hot: {swaps: 0, unverified: false}, root: "/tree", database: ":memory:"};
const host = (overrides = {}) => async (url) => {
  const path = new URL(url).pathname;
  const gen = overrides.header ?? overrides.body?.generation ?? servingBody.generation;
  if (path === "/osd/serving") {
    return answer(overrides.status ?? 200, {...servingBody, ...(overrides.body ?? {})}, overrides.noHeader ? {} : {"x-osd-generation": gen});
  }
  if (!path.startsWith("/sap/opu/odata/sap/ZSTG_NO_SUCH_SRV_")) return answer(404, "<pre>Cannot GET</pre>");
  return answer(overrides.missingStatus ?? 404, {error: {code: "STG/SERVICE_NOT_FOUND"}}, overrides.noHeaderOn404 ? {} : {"x-osd-generation": gen});
};

describe("tools/osd-host-contract.mjs", function () {
  it("accepts a host that answers like the Node child and returns the serving body", async () => {
    const body = await checkHostContract("http://host.invalid/", {fetchAnswer: host()});
    expect(body.generation).to.equal("go:0123456789abcdef");
    expect(body.pid).to.equal(4242);
  });
  it("accepts the warm-unverified label when header and body carry it alike", async () => {
    const body = await checkHostContract("http://host.invalid", {fetchAnswer: host({body: {generation: "abc123 warm-unverified"}})});
    expect(body.generation).to.equal("abc123 warm-unverified");
  });
  for (const [what, overrides, message] of [
    ["ready false", {body: {ready: false}}, /ready is true/],
    ["a 503", {status: 503}, /answers 200/],
    ["no generation", {body: {generation: ""}}, /not empty/],
    ["no pid", {body: {pid: undefined}}, /pid is the serving/],
    ["no launcherPid", {body: {launcherPid: undefined}}, /launcherPid/],
    ["hot missing", {body: {hot: undefined}}, /hot describes/],
    ["since as an ISO string", {body: {since: "2026-11-08T12:00:00.000Z"}}, /epoch milliseconds/],
    ["no header", {noHeader: true}, /X-OSD-Generation equals/],
    ["a header that differs from the body", {header: "go:other"}, /X-OSD-Generation equals/],
    ["no header on the 404", {noHeaderOn404: true}, /every answer/],
    ["an unknown service that is not 404", {missingStatus: 200}, /404/],
  ]) {
    it(`refuses ${what}`, async () => {
      let error;
      try { await checkHostContract("http://host.invalid", {fetchAnswer: host(overrides)}); } catch (e) { error = e; }
      expect(error, "an assertion").to.be.an("error");
      expect(error.message).to.match(message);
    });
  }
  it("times a drain: SIGTERM, then the wait until the pid is gone", async () => {
    let t = 1000, alive = 3, sent;
    const kill = (pid, signal) => {
      if (signal === 0) { if (alive-- > 0) return true; const e = new Error("gone"); e.code = "ESRCH"; throw e; }
      sent = [pid, signal];
    };
    const ms = await timeDrain(77, {kill, now: () => t, sleep: async () => { t += 20; }});
    expect(sent).to.deep.equal([77, "SIGTERM"]);
    expect(ms).to.equal(60);
  });
  it("gives up on a drain past the grace", async () => {
    let t = 0;
    const kill = (pid, signal) => { if (signal === 0) return true; };
    let error;
    try { await timeDrain(77, {kill, graceMs: 100, now: () => t, sleep: async () => { t += 50; }}); } catch (e) { error = e; }
    expect(error?.message).to.match(/still alive/);
  });
});
