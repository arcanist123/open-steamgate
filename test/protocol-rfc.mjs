import {expect} from "chai";
import {createServer as createHttpServer} from "node:http";
import {connect} from "node:net";
import {
  decodeAdtRequest,
  decodeRfcLogon,
  decodeRfcFieldChain,
  encodeAdtCutResponse,
  encodeAdtHttpResponse,
  encodeRfcFieldChain,
  encodeUtf16le,
  parseAdtHttpRequest,
  wrapRfcResponse,
  unscrambleRfcPassword,
} from "../tools/protocols/rfc.mjs";
import {createRfcAdtServer} from "../tools/protocols/rfc-server.mjs";
import {encodeNIFrame, NIFrameDecoder} from "../tools/protocols/ni.mjs";
import {bxmlPayload, decodeBxml, encodeAdtBxmlResponse, encodeBxml, parseAdtBxmlRequest} from "../tools/protocols/bxml.mjs";
import {fieldInfoResponse} from "../tools/protocols/rfc-metadata.mjs";
import {closeProtocols, listenProtocols} from "../tools/protocols/server.mjs";

import {cutRequest, eclipseRequest, eclipseCompactRequest, requestXml, appc, dataRecord, logonPacket, responseXml} from "../tools/protocols/test-rfc-wire.mjs";

describe("the built-in MIT RFC-to-ADT bridge", () => {
  it("starts DIAG and RFC together without an external sidecar", async () => {
    const servers = await listenProtocols({INSTANCE: "11", STG_DIAG_PORT: "0", STG_RFC_PORT: "0", STG_PORT: "3030"});
    expect(servers.diag.address().port).to.be.greaterThan(0);
    expect(servers.rfc.address().port).to.be.greaterThan(0);
    const held = connect(servers.diag.address().port, "127.0.0.1");
    await new Promise((resolve, reject) => held.once("connect", resolve).once("error", reject));
    const heldClosed = new Promise((resolve) => held.once("close", resolve));
    await closeProtocols(servers, {graceMs: 10});
    await heldClosed;
    expect(held.destroyed).to.equal(true);
  });

  it("closes SADT DDIC metadata over IHTTPNVP_TAB when ALL_TYPES is requested", () => {
    const cut = fieldInfoResponse({
      requestedOutputs: ["DDOBJTYPE"],
      imports: new Map([
        ["TABNAME", encodeUtf16le("SADT_REST_REQUEST", 30)],
        ["ALL_TYPES", encodeUtf16le("X", 1)],
      ]),
      tables: [{name: "DFIES_TAB", id: Buffer.from([0, 0, 0, 2]), rowLength: 1338, rows: []}],
      eclipse: true,
      sessionGUID: Buffer.alloc(16, 7),
    });
    const chain = decodeRfcFieldChain(cut.subarray(4), 0x0500);
    const outputs = chain.fields.filter((field) => field.tag === 0x0205).map((field) => field.value.toString("utf16le"));
    const xml = Buffer.concat(chain.fields.filter((field) => field.tag === 0x3c05).map((field) => field.value)).toString();
    expect(outputs).to.deep.equal(["DDOBJTYPE", "LINES_DESCR"]);
    expect(xml).to.include("<TYPENAME>IHTTPNVP</TYPENAME><TYPEKIND>STRU</TYPEKIND>");
    expect(xml).to.include("<TYPENAME>IHTTPNVP_TAB</TYPENAME><TYPEKIND>TTYP</TYPEKIND>");
    expect(xml).to.include("<ROLLNAME>IHTTPNVP</ROLLNAME>");
    expect(xml).to.include("<AUTHORID>TKN</AUTHORID>");
    expect(chain.fields.filter((field) => field.tag === 0x0303)).to.have.length(6);
  });

  it("decodes the bounded classic xRFC request profile", () => {
    const decoded = decodeAdtRequest(cutRequest(requestXml("/sap/bc/adt/discovery")));
    expect(decoded.functionName).to.equal("SADT_REST_RFC_ENDPOINT");
    expect(parseAdtHttpRequest(decoded.xml)).to.deep.include({method: "GET", url: "/sap/bc/adt/discovery"});
    const eclipse = decodeAdtRequest(eclipseRequest(requestXml("/sap/bc/adt/discovery")));
    expect(eclipse).to.include({functionName: "SADT_REST_RFC_ENDPOINT", eclipse: true});
    expect(parseAdtHttpRequest(eclipse.xml)).to.deep.include({method: "GET", url: "/sap/bc/adt/discovery"});
  });

  it("decodes and writes Eclipse compact BXML without treating bodies as text", () => {
    const leaf = (name, text) => ({name, text});
    const document = encodeBxml({name: "REQUEST", children: [
      {name: "REQUEST_LINE", children: [leaf("METHOD", "POST"), leaf("URI", "/sap/bc/adt/test"), leaf("VERSION", "HTTP/1.1")]},
      {name: "HEADER_FIELDS", children: [{name: "IHTTPNVP", children: [leaf("NAME", "Content-Type"), leaf("VALUE", "application/octet-stream")]}]},
      {name: "MESSAGE_BODY", body: Buffer.from([0, 0xff, 1])},
    ]});
    const call = decodeAdtRequest(eclipseCompactRequest(document));
    const request = parseAdtBxmlRequest(call.compact);
    expect(request).to.deep.include({method: "POST", url: "/sap/bc/adt/test", version: "HTTP/1.1"});
    expect(request.body.equals(Buffer.from([0, 0xff, 1]))).to.equal(true);
    const response = bxmlPayload(decodeBxml(encodeAdtBxmlResponse({status: 200, reason: "OK", body: Buffer.from([0xfe, 0])})));
    expect(response.name).to.equal("RESPONSE");
    expect(response.children.find((node) => node.name === "MESSAGE_BODY").body.equals(Buffer.from([0xfe, 0]))).to.equal(true);
  });

  it("keeps RFC logon bytes binary until their declared fields are decoded", () => {
    const logon = decodeRfcLogon(logonPacket());
    expect(logon).to.include({client: "001", user: "DEVELOPER", language: "E"});
    expect(logon.passwordField.toString("hex")).to.equal("150000008981dc9b914e");
    expect(unscrambleRfcPassword(logon.passwordField)).to.equal("secret");
    expect(decodeRfcLogon(logonPacket(undefined, "jco"))).to.include({client: "001", user: "DEVELOPER", language: "E"});
  });

  it("rejects tunneled authority escapes and header injection", () => {
    expect(() => parseAdtHttpRequest(requestXml("//outside.test/adt"))).to.throw("request line");
    const bad = requestXml().replace("*/*", "ok&#10;Injected: yes");
    expect(() => parseAdtHttpRequest(bad)).to.throw("header");
  });

  it("fails startup when either authentication boundary is incomplete", () => {
    expect(() => createRfcAdtServer({backend: "http://127.0.0.1:3030", port: 0, rfcAuthMode: "static"}))
      .to.throw("STG_RFC_USER and STG_RFC_PASSWORD");
    expect(() => createRfcAdtServer({backend: "http://127.0.0.1:3030", port: 0, backendPassword: "orphan"}))
      .to.throw("STG_ADT_USER");
  });

  it("encodes a classic response and its gateway APPC envelope", () => {
    const xml = encodeAdtHttpResponse({status: 200, reason: "OK", headers: [["Content-Type", "text/plain"]], body: Buffer.from("hello")});
    const cut = encodeAdtCutResponse(xml);
    const request = appc(0xcb);
    request.writeUInt16BE(23, 4);
    request.writeUInt16BE(9, 78);
    const record = wrapRfcResponse(cut, request);
    expect(record.subarray(40, 48).toString()).to.equal("00000001");
    expect(record.readUInt16BE(4)).to.equal(23);
    expect(record.readUInt16BE(78)).to.equal(9);
    expect(responseXml(record)).to.equal(xml);
  });

  it("rejects a wrong RFC password before contacting the ADT backend", async () => {
    let backendRequests = 0;
    const backend = createHttpServer((_request, response) => {
      backendRequests++;
      response.end();
    });
    await new Promise((resolve, reject) => backend.once("error", reject).listen(0, "127.0.0.1", resolve));
    let reportFailure;
    const rejected = new Promise((resolve) => { reportFailure = resolve; });
    const bridge = createRfcAdtServer({
      backend: `http://127.0.0.1:${backend.address().port}`,
      rfcAuthMode: "static", rfcUser: "DEVELOPER", rfcPassword: "secret", rfcClient: "001",
      host: "127.0.0.1", port: 0, timeoutMs: 2000,
      log: (event) => { if (event.error) reportFailure(event.error); },
    });
    await bridge.listen();
    const socket = connect(bridge.server.address().port, "127.0.0.1");
    socket.on("error", () => {});
    try {
      await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      const gateway = Buffer.alloc(64);
      const init = appc(0x01, 453);
      init.writeUInt16BE(3, 76);
      for (const frame of [gateway, init, appc(0x0f, 224), appc(0x05), dataRecord(logonPacket("150000008981dc9b914f"))]) {
        socket.write(encodeNIFrame(frame));
      }
      expect(await rejected).to.equal("RFC authentication failed");
      expect(backendRequests).to.equal(0);
    } finally {
      socket.destroy();
      await Promise.all([
        new Promise((resolve) => bridge.server.close(resolve)),
        new Promise((resolve) => backend.close(resolve)),
      ]);
    }
  });

  it("forwards two calls and keeps backend cookies per RFC connection", async () => {
    let calls = 0;
    let probes = 0;
    const backend = createHttpServer((request, response) => {
      expect(request.headers.authorization).to.equal(`Basic ${Buffer.from("BACKEND:secret").toString("base64")}`);
      expect(new URL(request.url, "http://backend").searchParams.get("sap-client")).to.equal("777");
      expect(new URL(request.url, "http://backend").searchParams.get("sap-language")).to.equal("DE");
      if (request.url.startsWith("/sap/public/bc/icf/logoff")) {
        expect(request.headers.cookie).to.equal("bridge-cookie=present");
        response.end();
        return;
      }
      expect(request.headers["x-sap-adt-sessiontype"]).to.equal("stateful");
      if (request.url.startsWith("/sap/bc/adt/core/discovery")) {
        probes++;
        expect(request.headers["x-csrf-token"]).to.equal("fetch");
        response.setHeader("Set-Cookie", "bridge-cookie=present; Path=/; HttpOnly");
        response.setHeader("X-CSRF-Token", `token-${probes}`);
        response.end();
        return;
      }
      calls++;
      expect(request.headers.cookie).to.equal("bridge-cookie=present");
      if (calls === 1) {
        expect(request.headers["x-csrf-token"]).to.equal("token-1");
        response.statusCode = 403;
        response.setHeader("X-CSRF-Token", "Required");
        response.end("stale");
        return;
      }
      expect(request.headers["x-csrf-token"]).to.equal(calls === 2 ? "token-2" : "token-rotated");
      if (calls === 2) response.setHeader("X-CSRF-Token", "token-rotated");
      response.setHeader("Content-Type", "text/plain");
      response.end(`answer-${calls - 1}`);
    });
    await new Promise((resolve, reject) => backend.once("error", reject).listen(0, "127.0.0.1", resolve));
    const bridge = createRfcAdtServer({
      backend: `http://127.0.0.1:${backend.address().port}`,
      backendUser: "BACKEND", backendPassword: "secret", backendClient: "777", backendLanguage: "DE",
      rfcAuthMode: process.env.OSD_PROTOCOL_TEST_AUTH_MODE ?? "static", rfcUser: "DEVELOPER", rfcPassword: "secret", rfcClient: "001",
      host: "127.0.0.1", port: 0, timeoutMs: 2000,
    });
    await bridge.listen();
    const socket = connect(bridge.server.address().port, "127.0.0.1");
    const decoder = new NIFrameDecoder();
    const received = [];
    socket.on("data", (chunk) => received.push(...decoder.push(chunk)));
    const waitFor = (count) => new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error(`timed out waiting for ${count} RFC frames`)), 2000);
      const poll = () => received.length >= count ? (clearTimeout(deadline), resolve()) : setTimeout(poll, 5);
      poll();
    });
    try {
      await new Promise((resolve, reject) => socket.once("connect", resolve).once("error", reject));
      const gateway = Buffer.alloc(64);
      const init = appc(0x01, 453);
      init.writeUInt16BE(3, 76);
      const partner = appc(0x0f, 224);
      const allocate = appc(0x05);
      const logon = dataRecord(logonPacket());
      for (const frame of [gateway, init, partner, allocate, logon]) socket.write(encodeNIFrame(frame));
      await waitFor(4);
      expect(received.map((frame) => frame.length)).to.deep.equal([64, 80, 80, 746]);
      const capabilityMarker = Buffer.from([0x01, 0x06, 0x00, 0x0b]);
      const capabilityAt = received[3].indexOf(capabilityMarker);
      expect(received[3].subarray(capabilityAt + 4, capabilityAt + 15).toString("hex")).to.equal("0401000301030200000023");

      socket.write(encodeNIFrame(dataRecord(cutRequest(requestXml("/first", "POST")))));
      await waitFor(5);
      expect(responseXml(received[4])).to.include("YW5zd2VyLTE=");

      socket.write(encodeNIFrame(dataRecord(cutRequest(requestXml("/second", "POST")))));
      await waitFor(6);
      expect(responseXml(received[5])).to.include("YW5zd2VyLTI=");
      expect(calls).to.equal(3);
      expect(probes).to.equal(2);
    } finally {
      socket.destroy();
      await Promise.all([
        new Promise((resolve) => bridge.server.close(resolve)),
        new Promise((resolve) => backend.close(resolve)),
      ]);
    }
  });
});
