import {expect} from "chai";
import {acceptKey, frame, mountChannels, unframe, ProtocolError} from "../tools/osd-apc.mjs";
import {randomBytes} from "node:crypto";
import {createServer, request} from "node:http";

// The websocket half of a push channel. The framing is written out here
// rather than taken from a package, so it is tested rather than trusted.
describe("tools/osd-apc: frames, and the handshake that starts them", () => {

  // RFC 6455 §1.3's own example. It exists so a server cannot answer a
  // handshake by accident, which makes it the one value worth pinning.
  it("the accept key is the one the standard's example gives", () => {
    expect(acceptKey("dGhlIHNhbXBsZSBub25jZQ==")).to.equal("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
  });

  // A client frame, out of a server one: set the mask bit, insert the key,
  // and mask the payload alone. The header is two, four or ten bytes
  // depending on the length, and an earlier version of this helper assumed
  // two — so it masked the length bytes of a long frame and the reader
  // rightly refused what came out. The helper was wrong, not the reader.
  const mask = (buffer) => {
    const length = buffer[1] & 0x7f;
    const header = length < 126 ? 2 : (length === 126 ? 4 : 10);
    const key = randomBytes(4);
    const body = Buffer.from(buffer.subarray(header));
    for (let i = 0; i < body.length; i = i + 1) {
      body[i] = body[i] ^ key[i % 4];
    }
    const head = Buffer.from(buffer.subarray(0, header));
    head[1] = head[1] | 0x80;
    return Buffer.concat([head, key, body]);
  };

  it("a frame written and read back is the text that went in", () => {
    const text = "the quick brown fox";
    expect(unframe(mask(frame(text))).payload.toString()).to.equal(text);
  });

  // the three length encodings, because a client only has to understand the
  // shortest one that fits and a server that always writes the longest is
  // still wrong when it writes the wrong one
  for (const size of [1, 125, 126, 200, 65535, 65536, 70000]) {
    it(`a payload of ${size} bytes survives the round trip`, () => {
      const text = "x".repeat(size);
      expect(unframe(mask(frame(text))).payload.toString()).to.equal(text);
    });
  }

  it("unmasking is its own inverse, so the payload is not the masked bytes", () => {
    const masked = mask(frame("secret"));
    expect(masked.includes(Buffer.from("secret"))).to.equal(false);
    expect(unframe(masked).payload.toString()).to.equal("secret");
  });

  // a socket delivers bytes, not messages: half a frame must be waited for
  // rather than guessed at
  it("half a frame is not a frame, and says so by returning nothing", () => {
    const whole = mask(frame("hello world"));
    expect(unframe(whole.subarray(0, whole.length - 3))).to.equal(undefined);
    expect(unframe(whole).payload.toString()).to.equal("hello world");
  });

  it("two frames in one chunk are read one at a time, with the rest kept", () => {
    const both = Buffer.concat([mask(frame("one")), mask(frame("two"))]);
    const first = unframe(both);
    expect(first.payload.toString()).to.equal("one");
    expect(unframe(first.rest).payload.toString()).to.equal("two");
  });

  it("a server frame is never masked, which is what a client requires", () => {
    expect((frame("x")[1] & 0x80)).to.equal(0);
  });

  it("the opcode survives, so a close is not read as text", () => {
    expect(unframe(mask(frame("bye", 0x8))).opcode).to.equal(0x8);
  });

  // refusing is the point: a length this host cannot address would otherwise
  // be truncated into a frame boundary somewhere else in the stream
  it("a frame longer than this host can carry is refused, not truncated", () => {
    const head = Buffer.alloc(10);
    head[0] = 0x81;
    head[1] = 127;
    head.writeBigUInt64BE(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 2);
    expect(() => unframe(head)).to.throw(ProtocolError);
  });
});

// hana-serve refuses an upgrade before any ABAP runs (another client, a
// guard no longer intact): the refusal is an HTTP answer on the upgrade,
// and the handler is never created
describe("tools/osd-apc: a host may refuse an upgrade", () => {
  it("answers the admit refusal and creates no handler", async () => {
    const saved = globalThis.abap;
    globalThis.abap = saved ?? {Classes: {}};
    let created = 0;
    class Host { constructor() { created += 1; } }
    const server = createServer();
    mountChannels(server, [{path: "/sap/bc/apc/sap/zb3", handler: "ZCL_B3", stateful: true}], {
      host: Host,
      admit: (req) => (new URL(req.url, "ws://x").searchParams.get("sap-client") === "999" ? {status: 400, reason: "Bad Request", text: "another client"} : undefined),
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const answer = await new Promise((done, fail) => {
        const req = request({host: "127.0.0.1", port: server.address().port, path: "/sap/bc/apc/sap/zb3?sap-client=999",
          headers: {Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", "Sec-WebSocket-Version": "13"}});
        req.on("response", (res) => {
          let body = "";
          res.on("data", (c) => { body += c; });
          res.on("end", () => done({status: res.statusCode, body}));
        });
        req.on("upgrade", () => fail(new Error("upgraded")));
        req.on("error", fail);
        req.end();
      });
      expect(answer).to.deep.equal({status: 400, body: "another client"});
      expect(created).to.equal(0);
    } finally {
      server.close();
      globalThis.abap = saved;
    }
  });
});

// every event runs through the host's wrapper (hana-serve: the guard's
// integrity, a trace record); a wrapper that refuses with OSD_TAMPERED
// closes a live socket 1011 and the handler's event never runs
describe("tools/osd-apc: the host's wrapper around every event", () => {
  it("names each event, and a tampered one closes the socket 1011 without running it", async () => {
    const saved = globalThis.abap;
    const text = (v = "") => ({value: v, set(x) { this.value = x; return this; }, get() { return this.value; }});
    globalThis.abap = {Classes: {}, context: {databaseConnections: {DEFAULT: {commit: async () => {}, rollback: async () => {}}}},
      types: {String: function () { return text(); }, Integer: function () { return text(0); }}};
    const ran = [];
    const pushed = [];
    class Host {
      static METHODS = {CONSTRUCTOR: {parameters: {IT_FIELDS: {type: () => ({})}}}};
      async constructor_() {}
      async open() { ran.push("on_start"); pushed.push("ready"); return {get: () => "X"}; }
      async drain() { const rows = pushed.splice(0).map((t) => ({get: () => t})); return {array: () => rows}; }
      async message({iv_text}) { ran.push(`on_message ${iv_text.get()}`); pushed.push(`echo ${iv_text.get()}`); }
      async close() { ran.push("on_close"); }
    }
    const events = [];
    const server = createServer();
    mountChannels(server, [{path: "/sap/bc/apc/sap/zb3", handler: "ZCL_B3", stateful: false}], {
      host: Host,
      event: (name, work, channel) => {
        events.push(`${channel.path} ${name}`);
        if (events.length === 3) {
          const e = new Error("guard broken");
          e.code = "OSD_TAMPERED";
          return Promise.reject(e);
        }
        return work();
      },
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    try {
      const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/sap/bc/apc/sap/zb3`);
      const got = [];
      const closed = new Promise((done) => { ws.onclose = (e) => done({code: e.code, reason: e.reason}); });
      ws.onmessage = (m) => {
        got.push(String(m.data));
        if (got.length === 1) ws.send("one");
        else if (got.length === 2) ws.send("two");
      };
      expect(await closed).to.deep.equal({code: 1011, reason: "host guard not intact"});
      expect(got).to.deep.equal(["ready", "echo one"]);
      expect(ran).to.deep.equal(["on_start", "on_message one"]);
      expect(events).to.deep.equal(["/sap/bc/apc/sap/zb3 on_start", "/sap/bc/apc/sap/zb3 on_message", "/sap/bc/apc/sap/zb3 on_message"]);
    } finally {
      server.close();
      globalThis.abap = saved;
    }
  });
});
