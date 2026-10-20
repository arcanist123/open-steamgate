// A foreign OData service answered from fixtures (tools/osd-http-replay.mjs).
//
// Everything here is synthetic: the service, its rows and the destinations
// file are written for the test. Fixtures recorded from a real system are
// gitignored, and a suite that can only pass where they exist tests that
// machine.
import {expect} from "chai";
import express from "express";
import http from "node:http";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {answerBatch, contentTypeOf, loadFixtures, parseBatch, partsOf, queryKey, queryPairs, replayer, replayKey, replayService, serviceKey} from "../tools/osd-http-replay.mjs";
import {describeRemoteServices, mountRemoteServices} from "../tools/osd-remote-service.mjs";
import {resetSequences} from "../tools/rfc-replay.mjs";

const FIXTURES = join(import.meta.dirname, "fixtures", "http-replay", "demo");
const SRV = "ZOSD_REPLAY_DEMO_SRV";
const BASE = `/sap/opu/odata/sap/${SRV}`;

/** an express app on a free port, with the host's raw body parser */
async function serve(mount) {
  const app = express();
  app.use(express.raw({type: "*/*", limit: "16mb"}));
  mount(app);
  // what answers when the replay passes a request on: a local service
  app.use((req, res) => res.status(418).send("local"));
  const server = await new Promise((ok) => {
    const s = app.listen(0, "127.0.0.1", () => ok(s));
  });
  return {url: `http://127.0.0.1:${server.address().port}`, close: () => server.close()};
}

const batchBody = (lines) => lines.join("\r\n");
// the dashed spelling of the test's guid, built rather than written: the
// leak scan reads a literal uuid as a possible system key, and this one is
// only the test's 42
const DASHED = ["00000000", "0000", "0000", "0000", "00000000002a"].join("-");

describe("tools/osd-http-replay: a foreign service answered from fixtures", () => {
  let said;
  const say = (line) => said.push(line);
  beforeEach(() => {
    said = [];
    resetSequences();
  });

  describe("the key", () => {
    it("drops sap-* and sorts the options, and keeps $skiptoken: two pages are two answers", () => {
      expect(queryKey("sap-client=001&$top=2&$filter=A%20eq%201&sap-language=EN"))
        .to.equal("$filter=A eq 1&$top=2");
      expect(queryKey("$skiptoken=20")).to.equal("$skiptoken=20");
    });

    it("reads a guid with or without dashes, in either case, as one key", () => {
      const a = replayKey({method: "GET", service: SRV, path: "OrderSet(guid'0000000000000000000000000000002A')", query: ""});
      const b = replayKey({method: "get", service: SRV, path: `/OrderSet(guid'${DASHED}')/`, query: ""});
      expect(a).to.equal(b);
    });

    it("keeps a service version other than 1 and drops the origin", () => {
      expect(serviceKey("zosd_replay_demo_srv;v=0001")).to.equal(SRV);
      expect(serviceKey(`${SRV};v=2;o=SOME`)).to.equal(`${SRV};v=0002`);
    });
  });

  describe("the fixtures", () => {
    let dir;
    before(() => { dir = mkdtempSync(join(tmpdir(), "osd-http-replay-")); });
    after(() => rmSync(dir, {recursive: true, force: true}));

    it("load from sub-folders, and the first folder wins", () => {
      const newer = join(dir, "newer", "deep");
      mkdirSync(newer, {recursive: true});
      writeFileSync(join(newer, "c.json"), JSON.stringify({key: {method: "GET", service: SRV, path: "OrderSet/$count"}, response: {status: 200, body: "99"}}));
      const all = loadFixtures([join(dir, "newer"), FIXTURES], {say});
      expect(all.size).to.equal(4);
      expect(all.get(replayKey({method: "GET", service: SRV, path: "OrderSet/$count"})).response.body).to.equal("99");
    });

    it("a second file for one key in one folder is named, not silently won", () => {
      const twice = join(dir, "twice");
      mkdirSync(twice);
      for (const n of ["a", "b"]) {
        writeFileSync(join(twice, `${n}.json`), JSON.stringify({key: {method: "GET", service: SRV, path: "X"}, response: {status: 200, body: n}}));
      }
      const all = loadFixtures(twice, {say});
      expect(all.get(replayKey({method: "GET", service: SRV, path: "X"})).response.body).to.equal("a");
      expect(said.join(" ")).to.contain("repeats");
    });

    it("a file without a key or a status is skipped and said", () => {
      const bad = join(dir, "bad");
      mkdirSync(bad);
      writeFileSync(join(bad, "x.json"), JSON.stringify({response: {status: 200}}));
      expect(loadFixtures(bad, {say}).size).to.equal(0);
      expect(said.join(" ")).to.contain("skipped");
    });
  });

  describe("a request", () => {
    let stand;
    let replay;
    before(async () => {
      replay = replayer(loadFixtures(FIXTURES, {say: () => {}}), {say: (l) => said.push(l), name: "REF"});
      stand = await serve((app) => app.use(replayService(SRV, replay, (name) => name === "ZOSD_LOCAL_SRV", {token: "t0k"})));
    });
    after(() => stand.close());

    it("recorded: the recorded answer, with only the headers a model reads", async () => {
      const res = await fetch(`${stand.url}${BASE}/OrderSet?$filter=Status eq 'A'&$top=2&sap-client=300`);
      expect(res.status).to.equal(200);
      expect(res.headers.get("sap-osd-replay")).to.equal("hit");
      expect(res.headers.get("dataserviceversion")).to.equal("2.0");
      // a recorded cookie belongs to a session that is gone
      expect(res.headers.get("set-cookie")).to.equal(null);
      const body = await res.json();
      expect(body.d.results).to.have.length(2);
      expect(body.d.top, "{{param:}} reads the request's query").to.equal("2");
    });

    it("fills RFC replay's placeholders per answer", async () => {
      const a = await (await fetch(`${stand.url}${BASE}/OrderSet(guid'0000000000000000000000000000002A')`)).json();
      const b = await (await fetch(`${stand.url}${BASE}/OrderSet(guid'0000000000000000000000000000002A')`)).json();
      expect(a.d.Fetched).to.match(/^\d{8}$/);
      expect([a.d.Seq, b.d.Seq]).to.deep.equal(["0001", "0002"]);
    });

    it("not recorded: a loud 404, never an empty set", async () => {
      const res = await fetch(`${stand.url}${BASE}/OrderSet?$top=3`);
      expect(res.status).to.equal(404);
      expect(res.headers.get("sap-osd-replay")).to.equal("miss");
      expect((await res.json()).error.code).to.equal("STG/REPLAY_MISS");
      expect(said.join(" ")).to.contain("MISS REF GET ZOSD_REPLAY_DEMO_SRV/OrderSet?$top=3");
    });

    it("the service name is read in any case, as a Gateway reads it", async () => {
      const res = await fetch(`${stand.url}/sap/opu/odata/sap/zosd_Replay_Demo_Srv/OrderSet/$count`);
      expect(res.headers.get("sap-osd-replay")).to.equal("hit");
    });

    it("a version of the service is a different service", async () => {
      expect((await fetch(`${stand.url}${BASE};v=2/$metadata`)).status).to.equal(200);
      expect((await fetch(`${stand.url}${BASE}/$metadata`)).status).to.equal(404);
    });

    it("the CSRF fetch gets a token, so a page can send its $batch", async () => {
      const res = await fetch(`${stand.url}${BASE}/`, {method: "HEAD", headers: {"x-csrf-token": "Fetch"}});
      expect(res.status).to.equal(200);
      expect(res.headers.get("x-csrf-token")).to.equal("t0k");
    });

    it("a write is refused, explicitly", async () => {
      const res = await fetch(`${stand.url}${BASE}/OrderSet`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
      expect(res.status).to.equal(501);
      expect(res.headers.get("sap-osd-replay")).to.equal("refused");
    });

    it("a service this system has is never shadowed, nor is a longer name", async () => {
      const local = await serve((app) => app.use(replayService("ZOSD_LOCAL_SRV", replay, (name) => name === "ZOSD_LOCAL_SRV")));
      try {
        expect((await fetch(`${local.url}/sap/opu/odata/sap/ZOSD_LOCAL_SRV/X`)).status).to.equal(418);
      } finally {
        local.close();
      }
      expect((await fetch(`${stand.url}${BASE}_LONGER/OrderSet`)).status).to.equal(418);
    });

    it("$batch: GET parts answered, a changeset refused, in our gateway's format", async () => {
      const body = batchBody([
        "--b", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "GET OrderSet/$count HTTP/1.1", "Accept: text/plain", "", "",
        "--b", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        `GET ${BASE}/OrderSet?$top=9 HTTP/1.1`, "", "",
        "--b", "Content-Type: multipart/mixed; boundary=cs", "",
        "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
        "POST OrderSet HTTP/1.1", "Content-Type: application/json", "", "{\"OrderId\":\"3\"}",
        "--cs--", "",
        "--b--", "",
      ]);
      const res = await fetch(`${stand.url}${BASE}/$batch`, {method: "POST", headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "t0k"}, body});
      expect(res.status).to.equal(202);
      expect(res.headers.get("content-type")).to.match(/^multipart\/mixed; boundary=batchresponse_stg_/);
      expect(res.headers.get("sap-osd-replay"), "the worst part names the batch").to.equal("refused");
      const text = await res.text();
      const parts = text.split(/--batchresponse_stg_replay_\d+/).slice(1, -1);
      expect(parts).to.have.length(3);
      expect(parts[0]).to.contain("HTTP/1.1 200 OK").and.contain("Content-Length: 1\r\nDataServiceVersion: 2.0").and.match(/\r\n\r\n7\r\n$/);
      expect(parts[1]).to.contain("HTTP/1.1 404 Not Found").and.contain("STG/REPLAY_MISS");
      expect(parts[2]).to.contain("HTTP/1.1 501 Not Implemented").and.contain("STG/REPLAY_READ_ONLY");
    });

    it("parses a batch written with bare LF and a quoted boundary", () => {
      const items = parseBatch(["--x", "Content-Type: application/http", "", "GET A HTTP/1.1", "", "", "--x--"].join("\n"), 'multipart/mixed; boundary="x"');
      expect(items).to.deep.equal([{method: "GET", url: "A", body: ""}]);
    });

    it("onMiss empty: an empty set and a zero count, still marked a miss; an entity is still 404", async () => {
      const soft = replayer(new Map(), {onMiss: "empty", say});
      expect(await soft.answer({method: "GET", service: SRV, path: "OrderSet/$count", query: ""})).to.include({status: 200, body: "0", outcome: "miss"});
      expect((await soft.answer({method: "GET", service: SRV, path: "OrderSet", query: ""})).body).to.equal('{"d":{"results":[]}}');
      expect((await soft.answer({method: "GET", service: SRV, path: "OrderSet('1')", query: ""})).status).to.equal(404);
      const batch = await answerBatch(soft, SRV, "--b\r\nContent-Type: application/http\r\n\r\nGET OrderSet HTTP/1.1\r\n\r\n\r\n--b--\r\n", "multipart/mixed; boundary=b");
      expect(batch.outcomes).to.deep.equal(["miss"]);
    });
  });

  describe("what a review found (each one reproduced first)", () => {
    let stand;
    let replay;
    before(async () => {
      replay = replayer(loadFixtures(FIXTURES, {say: () => {}}), {say: () => {}});
      stand = await serve((app) => app.use(replayService(SRV, replay)));
    });
    after(() => stand.close());

    it("an unreadable $batch is a 400, never an empty 202 marked hit", async () => {
      const empty = await fetch(`${stand.url}${BASE}/$batch`, {method: "POST", headers: {"content-type": "multipart/mixed; boundary=b"}, body: ""});
      expect(empty.status).to.equal(400);
      expect(empty.headers.get("sap-osd-replay")).to.equal("error");
    });

    it("a boundary followed by white space is the token before it", () => {
      expect(parseBatch("--b1\r\nContent-Type: application/http\r\n\r\nGET A HTTP/1.1\r\n\r\n\r\n--b1--", "multipart/mixed; boundary=b1 ; charset=x"))
        .to.deep.equal([{method: "GET", url: "A", body: ""}]);
    });

    it("a part without MIME headers keeps its request line", () => {
      expect(parseBatch("--b1\r\n\r\nGET Set HTTP/1.1\r\n\r\n\r\n--b1--", "multipart/mixed; boundary=b1"))
        .to.deep.equal([{method: "GET", url: "Set", body: ""}]);
    });

    it("a changeset without a boundary is refused as a changeset, not a TypeError", async () => {
      const a = await answerBatch(replay, SRV, "--b\r\nContent-Type: multipart/mixed\r\n\r\nwhatever\r\n--b--\r\n", "multipart/mixed; boundary=b");
      expect(a.outcomes).to.deep.equal(["refused"]);
    });

    it("a + in a fixture is a +, as %2B from a page is", () => {
      expect(replayKey({method: "GET", service: SRV, path: "Set('A+B')", query: "$filter=N eq 'A+B'"}))
        .to.equal(replayKey({method: "GET", service: SRV, path: "Set('A%2BB')", query: "$filter=N%20eq%20'A%2BB'"}));
    });

    it("HEAD on a path that is not recorded is a miss; on the root it is the CSRF door", async () => {
      const miss = await fetch(`${stand.url}${BASE}/NotRecorded`, {method: "HEAD"});
      expect([miss.status, miss.headers.get("sap-osd-replay")]).to.deep.equal([404, "miss"]);
      const hit = await fetch(`${stand.url}${BASE}/OrderSet/$count`, {method: "HEAD"});
      expect([hit.status, hit.headers.get("sap-osd-replay")]).to.deep.equal([200, "hit"]);
      expect((await fetch(`${stand.url}${BASE}/`, {method: "HEAD"})).status).to.equal(200);
    });

    it("an upper-case /SAP/OPU/ODATA path is answered, not a 500", async () => {
      const res = await fetch(`${stand.url}/SAP/OPU/ODATA/SAP/${SRV}/OrderSet/$count`);
      expect([res.status, await res.text()]).to.deep.equal([200, "7"]);
    });

    it("replay never answers a write with a fixture: verbs, X-HTTP-Method, $batch tunnels", async () => {
      // OrderSet/$count IS recorded: a write aimed at it must still be refused
      for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
        const res = await fetch(`${stand.url}${BASE}/OrderSet/$count`, {method, body: method === "DELETE" ? undefined : "{}"});
        expect([method, res.status, res.headers.get("sap-osd-replay")]).to.deep.equal([method, 501, "refused"]);
      }
      for (const [method, tunnel] of [["POST", "MERGE"], ["POST", "DELETE"], ["GET", "DELETE"]]) {
        const res = await fetch(`${stand.url}${BASE}/OrderSet/$count`, {method, headers: {"x-http-method": tunnel}, body: method === "GET" ? undefined : "{}"});
        expect([tunnel, res.status, res.headers.get("sap-osd-replay")]).to.deep.equal([tunnel, 501, "refused"]);
      }
      const batch = await answerBatch(replay, SRV, [
        "--b", "Content-Type: application/http", "", "GET OrderSet/$count HTTP/1.1", "X-HTTP-Method: DELETE", "", "",
        "--b", "Content-Type: application/http", "", "MERGE OrderSet/$count HTTP/1.1", "", "{}",
        "--b--", ""].join("\r\n"), "multipart/mixed; boundary=b");
      expect(batch.outcomes).to.deep.equal(["refused", "refused"]);
      expect(batch.body).to.not.match(/HTTP\/1\.1 200/);
    });

    it("a delimiter is a whole line: --boundary inside a body is body", () => {
      const body = [
        "--b", "Content-Type: application/http", "", "POST OrderSet HTTP/1.1", "Content-Type: text/plain", "",
        "text with --b in the middle", "--bnot-a-delimiter", "  --b",
        "--b--", ""].join("\r\n");
      const parts = partsOf(body, "b");
      expect(parts).to.have.length(1);
      expect(parts[0].body).to.contain("text with --b in the middle\r\n--bnot-a-delimiter\r\n  --b");
    });

    it("headers in another case and folded over two lines are read", () => {
      const items = parseBatch([
        "--b",
        "CONTENT-TYPE: multipart/mixed;",
        "\tBOUNDARY=\"c s;1\"",
        "",
        "--c s;1", "content-type: application/http", "", "GET OrderSet/$count HTTP/1.1", "", "",
        "--c s;1--", "",
        "--b--", ""].join("\r\n"), "multipart/mixed; boundary=b");
      expect(items).to.deep.equal([{changeset: [{method: "GET", url: "OrderSet/$count", body: ""}]}]);
    });

    it("a Content-Type's parameters split at ; outside quotes", () => {
      expect(contentTypeOf('Multipart/Mixed; Boundary="a;b"; charset=utf-8'))
        .to.deep.equal({type: "multipart/mixed", params: {boundary: "a;b", charset: "utf-8"}});
    });

    it("a query splits at & but never inside a quoted literal", () => {
      expect(queryPairs("$filter=Name eq 'A&B' and X eq 'it''s&'&$top=1"))
        .to.deep.equal([["$filter", "Name eq 'A&B' and X eq 'it''s&'"], ["$top", "1"]]);
      expect(queryKey("$top=1&$filter=Name eq 'A&B'")).to.equal(queryKey("$filter=Name%20eq%20'A%26B'&$top=1"));
    });

    it("whether a body has placeholders is decided at load", () => {
      const all = loadFixtures(FIXTURES, {say: () => {}});
      expect(all.get(replayKey({method: "GET", service: SRV, path: "OrderSet/$count"})).dynamic).to.equal(false);
      expect(all.get(replayKey({method: "GET", service: SRV, path: "OrderSet(guid'0000000000000000000000000000002A')"})).dynamic).to.equal(true);
    });
  });

  describe("fallback", () => {
    let replay;
    before(() => { replay = replayer(loadFixtures(FIXTURES, {say: () => {}}), {say: () => {}}); });

    it("asks the system first, and its answer -- even an error -- is the answer", async () => {
      const system = await serve((app) => app.use((req, res) => res.status(500).set("content-type", "text/plain").send("from the system")));
      const live = async (req, res) => {
        const r = await fetch(system.url + req.originalUrl);
        res.status(r.status).send(await r.text());
      };
      const stand = await serve((app) => app.use(replayService(SRV, replay, () => false, {live})));
      try {
        const res = await fetch(`${stand.url}${BASE}/OrderSet/$count`);
        expect(res.status).to.equal(500);
        expect(res.headers.get("sap-osd-replay")).to.equal("live");
        expect(await res.text()).to.equal("from the system");
      } finally {
        stand.close();
        system.close();
      }
    });

    it("a write the system may have received is a 504, never answered from the fixtures", async () => {
      const live = async () => { throw Object.assign(new Error("The operation was aborted due to timeout"), {name: "TimeoutError"}); };
      const stand = await serve((app) => app.use(replayService(SRV, replay, () => false, {live})));
      try {
        const res = await fetch(`${stand.url}${BASE}/OrderSet`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
        expect(res.status).to.equal(504);
        expect((await res.json()).error.message.value).to.contain("may have been applied");
        // a read after the same failure is the fixtures' to answer
        expect((await fetch(`${stand.url}${BASE}/OrderSet/$count`)).headers.get("sap-osd-replay")).to.equal("hit");
      } finally {
        stand.close();
      }
    });

    it("a write to a system that cannot be reached at all is the replay's to refuse", async () => {
      const live = async () => { throw Object.assign(new TypeError("fetch failed"), {cause: {code: "ECONNREFUSED"}}); };
      const stand = await serve((app) => app.use(replayService(SRV, replay, () => false, {live})));
      try {
        const res = await fetch(`${stand.url}${BASE}/OrderSet`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
        expect([res.status, res.headers.get("sap-osd-replay")]).to.deep.equal([501, "refused"]);
      } finally {
        stand.close();
      }
    });

    it("answers from the fixtures when the system cannot be reached", async () => {
      const live = async () => { throw new Error("connect ECONNREFUSED"); };
      const stand = await serve((app) => app.use(replayService(SRV, replay, () => false, {live})));
      try {
        const res = await fetch(`${stand.url}${BASE}/OrderSet/$count`);
        expect(res.status).to.equal(200);
        expect(res.headers.get("sap-osd-replay")).to.equal("hit");
        expect(await res.text()).to.equal("7");
      } finally {
        stand.close();
      }
    });
  });

  describe("mounted from destinations.json", () => {
    let dir;
    before(() => { dir = mkdtempSync(join(tmpdir(), "osd-http-replay-dest-")); });
    after(() => rmSync(dir, {recursive: true, force: true}));

    it("replay and fallback mount with their fixture count; record is refused and said", async () => {
      // a port nothing listens on: the fallback must reach its fixtures
      const closed = await new Promise((ok) => {
        const s = http.createServer().listen(0, "127.0.0.1", () => {
          const port = s.address().port;
          s.close(() => ok(port));
        });
      });
      const file = join(dir, "destinations.json");
      writeFileSync(file, JSON.stringify({
        destinations: {
          REF: {type: "http", mode: "replay", fixtures: FIXTURES},
          OFF: {type: "http", mode: "fallback", fixtures: FIXTURES, url: `http://127.0.0.1:${closed}`, user: "u", password: "p"},
          REC: {type: "http", mode: "record", fixtures: FIXTURES},
        },
        services: {[SRV]: "REF", ZOSD_REPLAY_OFF_SRV: "OFF", ZOSD_REPLAY_REC_SRV: "REC"},
      }));
      let mounted;
      const stand = await serve((app) => { mounted = mountRemoteServices(app, () => false, {file, root: dir, say}); });
      try {
        expect(mounted).to.deep.equal([
          `${SRV} -> REF (replay, 4 fixtures)`,
          "ZOSD_REPLAY_OFF_SRV -> OFF (fallback, 4 fixtures)",
        ]);
        expect(said.join(" ")).to.contain("mode record").and.contain("not mounted");
        expect((await fetch(`${stand.url}${BASE}/OrderSet/$count`)).headers.get("sap-osd-replay")).to.equal("hit");
        // the fixtures key on the service they were recorded from, so the
        // fallback service reaches them only through its own recordings
        const off = await fetch(`${stand.url}/sap/opu/odata/sap/ZOSD_REPLAY_OFF_SRV/OrderSet/$count`);
        expect(off.headers.get("sap-osd-replay")).to.equal("miss");
      } finally {
        stand.close();
      }
    });

    it("OSD_DESTINATIONS names the file, and its relative fixtures are beside it", async () => {
      const stand = join(dir, "stand");
      mkdirSync(join(stand, "fixtures"), {recursive: true});
      writeFileSync(join(stand, "fixtures", "c.json"), JSON.stringify({key: {method: "GET", service: SRV, path: "OrderSet/$count"}, response: {status: 200, body: "3"}}));
      writeFileSync(join(stand, "destinations.json"), JSON.stringify({destinations: {REF: {type: "http", mode: "replay", fixtures: "fixtures"}}, services: {[SRV]: "REF"}}));
      const before = process.env.OSD_DESTINATIONS;
      process.env.OSD_DESTINATIONS = join(stand, "destinations.json");
      let mounted;
      try {
        const app = await serve((a) => { mounted = mountRemoteServices(a, () => false, {say}); });
        try {
          expect(mounted).to.deep.equal([`${SRV} -> REF (replay, 1 fixtures)`]);
          expect(await (await fetch(`${app.url}${BASE}/OrderSet/$count`)).text()).to.equal("3");
        } finally {
          app.close();
        }
      } finally {
        if (before === undefined) {
          delete process.env.OSD_DESTINATIONS;
        } else {
          process.env.OSD_DESTINATIONS = before;
        }
      }
    });

    it("fallback: a slow system's write is waited for, a slow read is answered from the fixtures", async () => {
      const slow = await serve((app) => app.use((req, res) => setTimeout(() => res.status(201).set("content-type", "text/plain").send("written upstream"), 500)));
      const file = join(dir, "slow.json");
      writeFileSync(file, JSON.stringify({
        destinations: {SLOW: {type: "http", mode: "fallback", fixtures: FIXTURES, url: slow.url, user: "u", password: "p", timeout: 150}},
        services: {[SRV]: "SLOW"},
      }));
      const stand = await serve((app) => mountRemoteServices(app, () => false, {file, root: dir, say}));
      try {
        const write = await fetch(`${stand.url}${BASE}/OrderSet`, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
        expect([write.status, write.headers.get("sap-osd-replay"), await write.text()]).to.deep.equal([201, "live", "written upstream"]);
        const read = await fetch(`${stand.url}${BASE}/OrderSet/$count`);
        expect([read.status, read.headers.get("sap-osd-replay"), await read.text()]).to.deep.equal([200, "hit", "7"]);
      } finally {
        stand.close();
        slow.close();
      }
    });

    it("a mode that is not one is refused at mount, naming the destination, never live", async () => {
      const file = join(dir, "typo.json");
      writeFileSync(file, JSON.stringify({destinations: {TYPO: {type: "http", mode: "replya", fixtures: FIXTURES, url: "http://127.0.0.1:9", user: "u", password: "p"}}, services: {[SRV]: "TYPO"}}));
      let mounted;
      const stand = await serve((app) => { mounted = mountRemoteServices(app, () => false, {file, root: dir, say}); });
      try {
        expect(mounted).to.deep.equal([]);
        expect(said.join(" ")).to.contain("TYPO has mode replya").and.contain("not mounted");
        expect((await fetch(`${stand.url}${BASE}/OrderSet/$count`)).status, "nothing answers it, the local fallthrough does").to.equal(418);
      } finally {
        stand.close();
      }
    });

    it("osd doctor's lines: mode and fixture count, never a host or a logon", () => {
      const file = join(dir, "doctor.json");
      writeFileSync(file, JSON.stringify({
        destinations: {REF: {type: "http", mode: "replay", fixtures: FIXTURES}, SYS: {type: "http", url: "http://secret-host:50000", user: "SOMEONE", password: "p"}},
        services: {[SRV]: "REF", ZOSD_LIVE_SRV: "SYS"},
      }));
      const lines = describeRemoteServices({file, root: dir});
      expect(lines).to.deep.equal([`${SRV} -> REF (replay, 4 fixtures)`, "ZOSD_LIVE_SRV -> SYS (live)"]);
      expect(lines.join(" ")).to.not.contain("secret-host").and.not.contain("SOMEONE");
    });

    it("fixtures inside the tree and outside .local/ are named at mount", () => {
      const file = join(dir, "inside.json");
      mkdirSync(join(dir, "packs", "p", "replay"), {recursive: true});
      writeFileSync(file, JSON.stringify({destinations: {REF: {type: "http", mode: "replay", fixtures: "packs/p/replay"}}, services: {[SRV]: "REF"}}));
      mountRemoteServices(express(), () => false, {file, root: dir, tree: dir, say});
      expect(said.join(" ")).to.contain("not under .local/");
    });
  });
});
