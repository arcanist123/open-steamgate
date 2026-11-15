import {expect} from "chai";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {createServer} from "node:http";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {capture, compareAnswers, compareFolders, main, manifestFromIndex, normalisedLine, options, readAnswer} from "../tools/odata-read-diff.mjs";

// tools/odata-read-diff.mjs on small synthetic bodies. Every case is a way
// the comparison could call two different answers equal, or hide a
// difference inside a normalisation nobody declared.
//
// Mutation, measured when this was written: the "empty equal to empty"
// check in compareAnswers removed (the `else if (emptyOurs && emptyOracle)`
// branch) -> "two empty answers do not match" and "compares two files from
// the command line" go red (2 failing); with it back, green.
// The index fixes (measured pass, 2026-11-14), each checked red against the
// previous tools/odata-read-diff.mjs: the status by column name, and the
// derived manifest keeping language, client, HEAD and request headers.
const entry = (origin, key, extra = {}) => ({
  __metadata: {id: `${origin}/sap/opu/odata/sap/ZOSD_H5X_SRV/PartnerSet('${key}')`, uri: `${origin}/sap/opu/odata/sap/ZOSD_H5X_SRV/PartnerSet('${key}')`, type: "ZOSD_H5X.Partner"},
  PartnerID: key, Name: `Name ${key}`, ...extra,
});
const list = (origin, keys, extra) => JSON.stringify({d: {results: keys.map((k) => entry(origin, k, extra))}});
const OURS = "http://127.0.0.1:3040";
const ORACLE = "https://oracle.invalid:44300";

describe("odata-read-diff: one answer against another", () => {
  it("calls two equal answers equal, and nothing is normalised unless declared", () => {
    const same = compareAnswers({status: 200, body: list(OURS, ["1", "2"])}, {status: 200, body: list(OURS, ["1", "2"])});
    expect(same.ok).to.equal(true);
    // another host is a difference until uri-host is declared ...
    const hosts = compareAnswers({status: 200, body: list(OURS, ["1", "2"])}, {status: 200, body: list(ORACLE, ["1", "2"])});
    expect(hosts.ok).to.equal(false);
    expect(hosts.differences.join("\n")).to.contain("__metadata.uri");
    // ... and declared, it is counted: two entries, uri and id each
    const opts = options({normalise: ["uri-host"]});
    const declared = compareAnswers({status: 200, body: list(OURS, ["1", "2"])}, {status: 200, body: list(ORACLE, ["1", "2"])}, {}, opts);
    expect(declared.ok).to.equal(true);
    expect(declared.counts).to.deep.equal({"uri-host": 4});
    expect(normalisedLine(opts, declared.counts)).to.equal("normalised: uri-host 4");
  });

  it("does not let uri-host eat a difference in the path", () => {
    const opts = options({normalise: ["uri-host"]});
    const ours = list(OURS, ["1"]);
    const oracle = list(ORACLE, ["1"]).replaceAll("/sap/opu/odata/sap/", "/sap/opu/odata/NS/");
    const verdict = compareAnswers({status: 200, body: ours}, {status: 200, body: oracle}, {}, opts);
    expect(verdict.ok).to.equal(false);
    expect(verdict.counts).to.deep.equal({});
    // the prefix is its own declared rule, and counted apart from the host
    const both = options({normalise: ["uri-host"], prefix: {"/sap/opu/odata/sap/": "/sap/opu/odata/NS/"}});
    const fixed = compareAnswers({status: 200, body: ours}, {status: 200, body: oracle}, {}, both);
    expect(fixed.ok).to.equal(true);
    expect(fixed.counts).to.deep.equal({"uri-host": 2, "uri-prefix": 2});
    expect(normalisedLine(both, fixed.counts)).to.equal("normalised: uri-host 2, uri-prefix 2");
  });

  it("finds a changed value, a missing and an extra property (an unapplied $select)", () => {
    const ours = JSON.stringify({d: {results: [entry(OURS, "1", {City: "A"}), entry(OURS, "2")]}});
    const oracle = JSON.stringify({d: {results: [{...entry(OURS, "1"), Name: "Other"}, entry(OURS, "2")]}});
    const verdict = compareAnswers({status: 200, body: ours}, {status: 200, body: oracle});
    expect(verdict.differences).to.deep.equal([
      "$.d.results[0].City: extra in ours (\"A\")",
      "$.d.results[0].Name: ours \"Name 1\" | oracle \"Other\"",
    ]);
  });

  it("reports the keys, and the same keys in another order as an order difference", () => {
    const verdict = compareAnswers({status: 200, body: list(OURS, ["2", "1"])}, {status: 200, body: list(OURS, ["1", "2"])});
    expect(verdict.ok).to.equal(false);
    expect(verdict.keys).to.deep.equal({ours: ["('2')", "('1')"], oracle: ["('1')", "('2')"]});
    expect(verdict.differences[0]).to.equal("keys: the same keys in another order: ours [('2') ('1')] | oracle [('1') ('2')]");
  });

  it("compares __count and the status", () => {
    const withCount = (n) => JSON.stringify({d: {__count: String(n), results: [entry(OURS, "1")]}});
    const verdict = compareAnswers({status: 200, body: withCount(5)}, {status: 200, body: withCount(4)});
    expect(verdict.differences).to.deep.equal(["$.d.__count: ours \"5\" | oracle \"4\""]);
    const status = compareAnswers({status: 200, body: list(OURS, ["1"])}, {status: 201, body: list(OURS, ["1"])});
    expect(status.differences).to.deep.equal(["status: ours 200 | oracle 201"]);
  });

  it("two empty answers do not match unless the request says it expects an empty result", () => {
    const empty = JSON.stringify({d: {results: []}});
    const verdict = compareAnswers({status: 200, body: empty}, {status: 200, body: empty});
    expect(verdict.ok).to.equal(false);
    expect(verdict.differences[0]).to.match(/both answers are empty .* not a match/);
    expect(compareAnswers({status: 200, body: empty}, {status: 200, body: empty}, {empty: true}).ok).to.equal(true);
    // declared empty, and one side is not
    const notEmpty = compareAnswers({status: 200, body: list(OURS, ["1"])}, {status: 200, body: empty}, {empty: true});
    expect(notEmpty.differences).to.include("empty: the request is declared empty and ours answered entries");
    // a $count of 0 is empty too; 3 against 3 is a value
    expect(compareAnswers({status: 200, body: "0"}, {status: 200, body: "0"}).ok).to.equal(false);
    expect(compareAnswers({status: 200, body: "3"}, {status: 200, body: "3"}).ok).to.equal(true);
  });

  it("compares an error by status, code and message, and says that is all it compares", () => {
    const error = (code, value, extra = {}) => JSON.stringify({error: {code, message: {lang: "en", value}, innererror: {transactionid: String(Math.random()), ...extra}}});
    const same = compareAnswers({status: 404, body: error("X/1", "not found")}, {status: 404, body: error("X/1", "not found")});
    expect(same.ok).to.equal(true);
    expect(same.notes[0]).to.match(/error.code and error.message.value compared/);
    const other = compareAnswers({status: 400, body: error("STG/BUSINESS", "Business exception raised by the data provider")}, {status: 400, body: error("X/007", "Filter not supported")});
    expect(other.differences).to.deep.equal([
      "error.code: ours \"STG/BUSINESS\" | oracle \"X/007\"",
      "error.message: ours \"Business exception raised by the data provider\" | oracle \"Filter not supported\"",
    ]);
    // a 200 against an error is a status difference and an error-body difference
    const half = compareAnswers({status: 200, body: list(OURS, ["1"])}, {status: 400, body: error("X/1", "no")});
    expect(half.ok).to.equal(false);
    expect(half.differences[0]).to.equal("status: ours 200 | oracle 400");
  });

  it("counts etag-form and member-order only when declared", () => {
    const tagged = (etag) => JSON.stringify({d: {results: [{...entry(OURS, "1"), __metadata: {...entry(OURS, "1").__metadata, etag}}], __count: "1"}});
    const reordered = JSON.stringify({d: {__count: "1", results: JSON.parse(tagged("W/\"datetime'2020-05-29T05%3A05%3A42.0000000'\"")).d.results}});
    const ours = {status: 200, body: tagged("W/\"2020-05-29T05%3a05%3a42.0000000Z\"")};
    const strict = compareAnswers(ours, {status: 200, body: reordered});
    expect(strict.differences.length).to.equal(2);
    const opts = options({normalise: ["etag-form", "member-order"]});
    const loose = compareAnswers(ours, {status: 200, body: reordered}, {}, opts);
    expect(loose.ok).to.equal(true);
    expect(normalisedLine(opts, loose.counts)).to.equal("normalised: etag-form 1, member-order 1");
    // an etag on one side only is not a form
    const missing = compareAnswers(ours, {status: 200, body: tagged("")}, {}, opts);
    expect(missing.ok).to.equal(false);
    expect(() => options({normalise: ["everything"]})).to.throw(/unknown normalisation everything/);
  });

  it("compares a text answer ($metadata) byte for byte", () => {
    expect(compareAnswers({status: 200, body: "<a/>"}, {status: 200, body: "<a/>"}).ok).to.equal(true);
    expect(compareAnswers({status: 200, body: "<a/>"}, {status: 200, body: "<b/>"}).ok).to.equal(false);
    expect(compareAnswers({status: 200, body: "<a/>"}, {status: 200, body: list(OURS, ["1"])}).differences[0]).to.match(/ours answer is not JSON/);
  });
});

describe("odata-read-diff: capture folders and a manifest", () => {
  let dir;
  let server;
  let base;
  const seen = [];

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "read-diff-"));
    server = createServer((req, res) => {
      seen.push(`${req.method} ${req.url}`);
      if (req.url.includes("$count")) { res.writeHead(200, {"content-type": "text/plain"}); res.end("2"); return; }
      res.writeHead(200, {"content-type": "application/json"});
      res.end(req.method === "HEAD" ? undefined : list("http://x", ["1", "2"]));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise((done) => server.close(done));
    rmSync(dir, {recursive: true, force: true});
  });

  it("records GET and HEAD with their status and the URL as written, and refuses anything else", async () => {
    const manifest = {requests: [
      {id: "01-list", method: "GET", url: "/sap/opu/odata/sap/S/PartnerSet?$top=2&$format=json"},
      {id: "02-count", url: "/sap/opu/odata/sap/S/PartnerSet/$count"},
      {id: "03-head", method: "HEAD", url: "/sap/opu/odata/sap/S/", headers: {"x-csrf-token": "Fetch"}},
    ]};
    const out = join(dir, "ours");
    const written = await capture(base, manifest, out);
    expect(written.map((w) => [w.id, w.status])).to.deep.equal([["01-list", 200], ["02-count", 200], ["03-head", 200]]);
    expect(seen).to.deep.equal(["GET /sap/opu/odata/sap/S/PartnerSet?$top=2&$format=json", "GET /sap/opu/odata/sap/S/PartnerSet/$count", "HEAD /sap/opu/odata/sap/S/"]);
    expect(JSON.parse(readFileSync(join(out, "01-list.meta.json"), "utf8"))).to.include({status: 200, method: "GET"});
    let refused;
    await capture(base, {requests: [{id: "x", method: "POST", url: "/x"}]}, join(dir, "never")).catch((e) => { refused = e; });
    expect(refused?.message).to.match(/GET and HEAD only; x is POST/);
    expect(seen.length).to.equal(3);
  });

  it("compares a manifest across two folders, a missing capture and a declared empty set included", () => {
    const put = (folder, id, status, body) => {
      writeFileSync(join(folder, `${id}.body`), body);
      writeFileSync(join(folder, `${id}.meta.json`), JSON.stringify({status}));
    };
    const [o, r] = [mkdtempSync(join(dir, "o-")), mkdtempSync(join(dir, "r-"))];
    put(o, "a", 200, list(OURS, ["1"]));
    put(r, "a", 200, list(ORACLE, ["1"]));
    put(o, "empty", 200, JSON.stringify({d: {results: []}}));
    put(r, "empty", 200, JSON.stringify({d: {results: []}}));
    put(o, "gone", 200, "{}");
    const manifest = {requests: [{id: "a"}, {id: "empty", empty: true}, {id: "gone"}]};
    const verdict = compareFolders(manifest, o, r, options({normalise: ["uri-host"]}));
    expect(verdict.results.map((x) => [x.id, x.ok])).to.deep.equal([["a", true], ["empty", true], ["gone", false]]);
    expect(verdict.results[2].differences[0]).to.equal("missing capture: oracle");
    expect(verdict.counts).to.deep.equal({"uri-host": 2});
  });

  it("reads an index.tsv oracle and makes a manifest of it without the logon options", async () => {
    const index = "n\tstatus\twall_s\tbytes\taccept\turl\n03-list\t200\t0.1\t10\t-\thttps://oracle.invalid:44300/sap/opu/odata/NS/S/PartnerSet?$top=5&$format=json&sap-client=001&sap-language=EN\n";
    expect(manifestFromIndex(index)).to.deep.equal({normalise: [], logon: {"sap-client": "001", "sap-language": "EN"},
      requests: [{id: "03-list", method: "GET", url: "/sap/opu/odata/NS/S/PartnerSet?$top=5&$format=json", status: 200}]});
    const r = mkdtempSync(join(dir, "idx-"));
    const o = mkdtempSync(join(dir, "idx-ours-"));
    writeFileSync(join(r, "index.tsv"), index);
    writeFileSync(join(r, "03-list.body"), list(ORACLE, ["1"]));
    writeFileSync(join(o, "03-list.body"), list(OURS, ["1"]));
    writeFileSync(join(o, "03-list.meta.json"), JSON.stringify({status: 200}));
    const manifestFile = join(dir, "m.json");
    writeFileSync(manifestFile, JSON.stringify({...manifestFromIndex(index), normalise: ["uri-host"]}));
    const lines = [];
    const code = await main(["--manifest", manifestFile, "--ours", o, "--oracle", r], (l) => lines.push(l));
    expect(code).to.equal(0);
    expect(lines).to.include("normalised: uri-host 2");
    expect(lines).to.include("1 of 1 equal");
    // without the declaration the same folders differ, and the CLI says so
    writeFileSync(manifestFile, JSON.stringify(manifestFromIndex(index)));
    const strict = [];
    expect(await main(["--manifest", manifestFile, "--ours", o, "--oracle", r], (l) => strict.push(l))).to.equal(1);
    expect(strict).to.include("normalised: nothing (no rule declared)");
  });

  // the milestone-3 capture layout: method in the second column, the
  // status in the third, request headers as JSON (the measured pass found
  // the status read off the method column -- every status NaN -- and the
  // derived manifest losing what changes a request)
  const m3Index = [
    "n\tmethod\tstatus\twall_s\tbytes\trequest_headers\turl",
    "01-list\tGET\t200\t0.1\t10\t{}\thttps://oracle.invalid/sap/opu/odata/NS/S/PartnerSet?$top=5&sap-client=001&sap-language=EN",
    "02-list\tGET\t200\t0.1\t10\t{}\thttps://oracle.invalid/sap/opu/odata/NS/S/OrderSet?sap-client=001&sap-language=EN",
    "03-de\tGET\t200\t0.1\t10\t{}\thttps://oracle.invalid/sap/opu/odata/NS/S/$metadata?sap-client=001&sap-language=DE",
    "04-client\tGET\t401\t0.1\t10\t{}\thttps://oracle.invalid/sap/opu/odata/NS/S/PartnerSet?$top=1&sap-client=002&sap-language=EN",
    "05-head\tHEAD\t200\t0.1\t0\t{\"x-csrf-token\": \"Fetch\"}\thttps://oracle.invalid/sap/opu/odata/NS/S/?sap-client=001&sap-language=EN",
    "06-etag\tGET\t304\t0.1\t0\t{\"If-None-Match\": \"W/\\\"x\\\"\"}\thttps://oracle.invalid/sap/opu/odata/NS/S/PartnerSet('1')?sap-client=001&sap-language=EN",
    "07-batch\tPOST\t202\t0.1\t10\t{\"Content-Type\": \"multipart/mixed; boundary=b\"}\thttps://oracle.invalid/sap/opu/odata/NS/S/$batch?sap-client=001&sap-language=EN",
  ].join("\n") + "\n";

  it("reads the status of an index by its column name, in either layout", () => {
    const folder = mkdtempSync(join(dir, "m3-"));
    writeFileSync(join(folder, "index.tsv"), m3Index);
    writeFileSync(join(folder, "04-client.body"), "{}");
    writeFileSync(join(folder, "01-list.body"), "{}");
    expect(readAnswer(folder, "04-client").status).to.equal(401);
    expect(readAnswer(folder, "01-list").status).to.equal(200);
  });

  it("keeps in a derived manifest what changes the request: another language or client, HEAD, request headers", () => {
    const manifest = manifestFromIndex(m3Index);
    expect(manifest.logon).to.deep.equal({"sap-client": "001", "sap-language": "EN"});
    const byId = Object.fromEntries(manifest.requests.map((r) => [r.id, r]));
    // the capture's own logon is dropped, another value is kept
    expect(byId["01-list"]).to.deep.equal({id: "01-list", method: "GET", url: "/sap/opu/odata/NS/S/PartnerSet?$top=5", status: 200});
    expect(byId["03-de"].url).to.equal("/sap/opu/odata/NS/S/$metadata?sap-language=DE");
    expect(byId["04-client"].url).to.equal("/sap/opu/odata/NS/S/PartnerSet?$top=1&sap-client=002");
    expect(byId["04-client"].status).to.equal(401);
    expect(byId["05-head"]).to.deep.include({method: "HEAD", headers: {"x-csrf-token": "Fetch"}});
    expect(byId["06-etag"].headers).to.deep.equal({"If-None-Match": "W/\"x\""});
    // a POST is not sent by --capture and not dropped silently either
    expect(byId["07-batch"]).to.equal(undefined);
    expect(manifest.left_out.map((r) => [r.id, r.method, r.reason])).to.deep.equal([["07-batch", "POST", "--capture sends GET and HEAD only"]]);
  });

  it("compares two files from the command line", async () => {
    const a = join(dir, "a.body");
    const b = join(dir, "b.body");
    writeFileSync(a, JSON.stringify({d: {results: []}}));
    writeFileSync(b, JSON.stringify({d: {results: []}}));
    const lines = [];
    expect(await main([a, b, "--status", "200,200"], (l) => lines.push(l))).to.equal(1);
    expect(await main([a, b, "--status", "200,200", "--expect-empty"], () => undefined)).to.equal(0);
  });
});
