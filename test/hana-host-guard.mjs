import {expect} from "chai";
import {spawn as spawnChild} from "node:child_process";
import * as childProcess from "node:child_process";
import dns from "node:dns";
import http from "node:http";
import net from "node:net";
import {existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {abapMethodName, connectTarget, createHostRecord, installOutboundGuard, installStubHook, integrity, isRefusal, lockProperty, probeStubHook, PROBE_REASON, REFUSED_CODE, shortTarget, stubSite, tamperGate} from "../tools/hana-host-guard.mjs";
import {closureSummary, serviceClasses, superClassOf} from "../tools/hana-closure-report.mjs";
import {seedClasses} from "../tools/hana-closure-stubs.mjs";

// Milestone 4, the read-only host's safety (tools/hana-host-guard.mjs, wired
// into tools/hana-serve.mjs): every outbound network call of the process is
// refused, the class library's HTTP client answers SEND with
// HTTP_COMMUNICATION_FAILURE, and every stub raise and refusal lands in a
// per-request record that --stub-trace writes, never the response.
//
// The twin service for the live part is ZOSD_M4G_SRV: the twin's model
// (test/hana-m2) over ZCL_OSD_M4G_DPC (test/hana-m4), whose partner set
// takes a case from a filter on Name and swallows what happens.
//
// Mutations, measured when this was written (each turns its test red):
//   - the net.Socket connect patch removed from installOutboundGuard: the
//     listener receives the HTTP client's request ("refuses the HTTP client
//     by URL ... the listener receives nothing");
//   - installStubHook(record) removed from tools/hana-serve.mjs: the host
//     with --stub-trace refuses to start ("hana-serve: refuses to start: a
//     synthetic stub raise did not reach the host's hook"), so the live
//     suite's before() fails; the pure probe test below holds the same
//     verdict without a host;
//   - `services` dropped from closureSummary's --require-unstubbed: the
//     hand-written and inherited cases below pass where they must fail;
//   - (critic round) the net.Server listen patch removed: M4LISTEN answers
//     200 and the trace has no `listen` refusal; isRefusal() dropped from
//     the host's 500 text: M4RAW's body would carry the refusal (the
//     message no longer names a target, the record does); lockProperty
//     not used for the hook: M4TAMPER replaces it and the stub after it
//     goes untraced, and the per-request gate answers 500.
const root = fileURLToPath(new URL("..", import.meta.url));
const output = join(root, "output");
const tool = join(root, "tools", "hana-serve.mjs");

/** a TCP listener that counts what reaches it */
async function listener() {
  const seen = {connections: 0, bytes: 0};
  const server = net.createServer((socket) => {
    seen.connections += 1;
    socket.on("data", (d) => { seen.bytes += d.length; });
    socket.on("error", () => undefined);
    socket.end();
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {seen, port: server.address().port, close: () => new Promise((done) => server.close(done))};
}

const settle = () => new Promise((done) => setTimeout(done, 150));

/** an express-shaped response that only remembers */
const fakeResponse = () => ({
  statusCode: 200, body: undefined, ended: false,
  status(code) { this.statusCode = code; return this; },
  type() { return this; },
  send(body) { this.body = body; this.end(); return this; },
  end() { this.ended = true; },
});

describe("hana-host-guard: names off the stack", () => {
  it("reads an ABAP method name out of a transpiled one", () => {
    expect(abapMethodName("get_entity")).to.equal("GET_ENTITY");
    expect(abapMethodName("if_http_client$send")).to.equal("IF_HTTP_CLIENT~SEND");
    expect(abapMethodName("$iwbep$if_mgw_appl_srv_runtime$get_entityset")).to.equal("/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_ENTITYSET");
  });

  it("finds the stubbed class and method, past the exception class's own frames", () => {
    const stack = [
      "Error",
      "    at hook (file:///x/tools/hana-host-guard.mjs:10:5)",
      "    at zcx_osd_not_activated.signal (file:///x/output/zcx_osd_not_activated.clas.mjs:40:5)",
      "    at async zcx_osd_not_activated.constructor_ (file:///x/output/zcx_osd_not_activated.clas.mjs:20:5)",
      "    at async zcl_osd_m4g_gap.not_here (file:///x/output/zcl_osd_m4g_gap.clas.mjs:31:11)",
      "    at async zcl_osd_m4g_dpc.$iwbep$if_mgw_appl_srv_runtime$get_entityset (file:///x/output/zcl_osd_m4g_dpc.clas.mjs:80:7)",
    ].join("\n");
    expect(stubSite(stack)).to.deep.equal({class: "ZCL_OSD_M4G_GAP", method: "NOT_HERE"});
    expect(stubSite("    at Function.class_constructor (file:///x/output/%23ns%23cl_x.clas.mjs:3:1)")).to.deep.equal({class: "/NS/CL_X", method: "CLASS_CONSTRUCTOR"});
    expect(stubSite("    at probe (file:///x/tools/hana-serve.mjs:1:1)")).to.equal(undefined);
  });

  it("reads what a connect addresses, normalized or not", () => {
    expect(connectTarget([[{host: "h", port: 1}]])).to.deep.equal({host: "h", port: 1});
    expect(connectTarget([[{host: "h", port: 1, path: null}]])).to.deep.equal({host: "h", port: 1});
    expect(connectTarget([{port: 2}])).to.deep.equal({host: "localhost", port: 2});
    expect(connectTarget([3, "a"])).to.deep.equal({host: "a", port: 3});
    expect(connectTarget(["/run/x.sock"])).to.deep.equal({path: "/run/x.sock"});
  });
});

describe("hana-host-guard: the record and the hook's positive control", () => {
  it("writes one line per request, nothing without a file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-guard-record-"));
    try {
      const file = join(dir, "trace", "stubs.ndjson");
      const lines = [];
      const record = createHostRecord({file, log: (l) => lines.push(l)});
      record.note("stubs", {class: "ZCL_X", method: "CLASS_CONSTRUCTOR", reason: "LOAD"});
      record.endBoot({probe: "seen"});
      const res = fakeResponse();
      await record.request({method: "GET", path: "/a", res}, async () => {
        await Promise.resolve();
        record.note("refused", {kind: "connect", target: "127.0.0.1:9"});
        // the line is on disk when the response ends, before the client has it
        res.status(200).end();
        expect(readFileSync(file, "utf8").trim().split("\n")).to.have.length(2);
        record.note("stubs", {class: "ZCL_X", method: "LATE", reason: "after the end"});
      });
      const written = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      expect(written).to.deep.equal([
        {boot: true, probe: "seen", stubs: [{class: "ZCL_X", method: "CLASS_CONSTRUCTOR", reason: "LOAD"}], refused: [], tampered: []},
        {method: "GET", path: "/a", status: 200, stubs: [], refused: [{kind: "connect", target: "127.0.0.1:9"}], tampered: []},
      ]);
      expect(lines).to.deep.equal(["not activated: ZCL_X=>CLASS_CONSTRUCTOR: LOAD", "hana-serve: refused outbound connect 127.0.0.1:9", "not activated: ZCL_X=>LATE: after the end"]);
      // no file: the request runs as it is, and only stderr hears of it
      const quiet = createHostRecord({log: () => undefined});
      expect(await quiet.request({method: "GET", path: "/b", res: fakeResponse()}, async () => 7)).to.equal(7);
      expect(readdirSync(join(dir, "trace"))).to.deep.equal(["stubs.ndjson"]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("makes the trace its owner's only, a file left by an earlier run and a directory it creates", () => {
    const dir = mkdtempSync(join(tmpdir(), "host-guard-mode-"));
    try {
      const old = join(dir, "old.ndjson");
      writeFileSync(old, "earlier run\n", {mode: 0o644});
      expect(statSync(old).mode & 0o777).to.equal(0o644);
      createHostRecord({file: old, log: () => undefined});
      expect(statSync(old).mode & 0o777).to.equal(0o600);
      expect(readFileSync(old, "utf8")).to.equal("");
      const fresh = join(dir, "made", "trace.ndjson");
      createHostRecord({file: fresh, log: () => undefined});
      expect(statSync(join(dir, "made")).mode & 0o777).to.equal(0o700);
      expect(statSync(fresh).mode & 0o777).to.equal(0o600);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("keeps a URL target to its origin and cuts a long one", () => {
    expect(shortTarget("https://user:secret@example.invalid:8443/p?token=x")).to.equal("https://example.invalid:8443");
    expect(shortTarget("x".repeat(200))).to.equal(`${"x".repeat(120)}...`);
    expect(shortTarget("127.0.0.1:9")).to.equal("127.0.0.1:9");
    expect(isRefusal({code: REFUSED_CODE})).to.equal(true);
    expect(isRefusal(new TypeError("fetch failed", {cause: {code: REFUSED_CODE}}))).to.equal(true);
    expect(isRefusal(new Error("other"))).to.equal(false);
  });

  it("locks the hook: an assignment is ignored and recorded as tampering", async () => {
    const scope = {};
    const lines = [];
    const record = createHostRecord({log: (l) => lines.push(l)});
    const hook = installStubHook(record, {lock: true, global: scope});
    scope.osdNotActivated = () => undefined;
    expect(scope.osdNotActivated).to.equal(hook);
    expect(() => { "use strict"; delete scope.osdNotActivated; }).to.throw(TypeError);
    expect(scope.osdNotActivated).to.equal(hook);
    expect(record.boot.tampered).to.deep.equal([{what: "assignment to globalThis.osdNotActivated, ignored"}]);
    expect(integrity({global: scope, hook})).to.deep.equal([]);
    const plain = {};
    lockProperty(plain, "f", 1, () => lines.push("tamper f"));
    plain.f = 2;
    expect(plain.f).to.equal(1);
    expect(lines).to.include("tamper f");
  });

  it("answers 500 and records tampering when the hook is not the installed one (the per-request check)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "host-guard-gate-"));
    try {
      const file = join(dir, "t.ndjson");
      const scope = {};
      const record = createHostRecord({file, log: () => undefined});
      record.endBoot();
      const hook = installStubHook(record, {global: scope});
      const gate = tamperGate(record, () => integrity({global: scope, hook}));
      let ran = 0;
      const ok = fakeResponse();
      await record.request({method: "GET", path: "/ok", res: ok}, () => gate({}, ok, () => { ran += 1; ok.end(); }));
      expect(ran).to.equal(1);
      scope.osdNotActivated = () => undefined; // unlocked: replaced
      const bad = fakeResponse();
      await record.request({method: "GET", path: "/bad", res: bad}, () => gate({}, bad, () => { ran += 1; }));
      expect(ran).to.equal(1);
      expect(bad.statusCode).to.equal(500);
      expect(JSON.parse(bad.body).error.code).to.equal("OSD/TAMPERED");
      const last = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l)).at(-1);
      expect(last).to.deep.include({path: "/bad", status: 500});
      expect(last.tampered).to.deep.equal([{what: "not intact: globalThis.osdNotActivated"}]);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });

  it("sees a synthetic stub only when the hook is in (the boot probe)", async () => {
    // a runtime stand-in whose exception class calls the hook the way
    // ZCX_OSD_NOT_ACTIVATED's constructor does
    const scope = {};
    const abap = {
      types: {String: class { set(v) { this.v = v; return this; } get() { return this.v; } }},
      Classes: {ZCX_OSD_NOT_ACTIVATED: class { async constructor_({missing}) { await Promise.resolve(); scope.osdNotActivated?.(missing.get()); return this; } }},
    };
    const record = createHostRecord({log: () => undefined});
    expect(await probeStubHook(abap, record)).to.deep.include({ok: false});
    installStubHook(record, {global: scope});
    expect(await probeStubHook(abap, record)).to.deep.equal({ok: true});
    expect(record.boot.stubs.map((s) => s.reason)).to.not.include(PROBE_REASON);
    expect((await probeStubHook({}, record)).why).to.match(/no ZCX_OSD_NOT_ACTIVATED/);
  });
});

describe("hana-host-guard: the outbound guard in this process", function () {
  this.timeout(20000);
  let guard;
  let target;
  const lines = [];
  const record = createHostRecord({log: (l) => lines.push(l)});

  before(async () => {
    target = await listener();
    guard = installOutboundGuard(record);
  });

  after(async () => {
    guard?.uninstall();
    await target?.close();
  });

  it("refuses a socket, an HTTP request, fetch, DNS, a child process, a worker, a listener, dlopen and the inspector", async () => {
    let error;
    try { net.connect(target.port, "127.0.0.1"); } catch (e) { error = e; }
    expect(error?.code).to.equal(REFUSED_CODE);
    error = undefined;
    try { http.get(`http://127.0.0.1:${target.port}/x`); } catch (e) { error = e; }
    expect(error?.code).to.equal(REFUSED_CODE);
    const fetched = await fetch(`http://127.0.0.1:${target.port}/y`).then(() => undefined, (e) => e);
    expect(fetched?.cause?.code).to.equal(REFUSED_CODE);
    const looked = await dns.promises.lookup("m4.example.invalid").then(() => undefined, (e) => e);
    expect(looked?.code).to.equal(REFUSED_CODE);
    const viaCallback = await new Promise((done) => dns.lookup("m4.example.invalid", (e) => done(e)));
    expect(viaCallback?.code).to.equal(REFUSED_CODE);
    // the ESM named export imported before the guard went in is patched too
    expect(() => spawnChild("true")).to.throw(/refuses outbound network calls \(process\)/);
    expect(() => childProcess.execSync("true")).to.throw(/\(process\)/);
    const {Worker} = await import("node:worker_threads");
    expect(() => new Worker("data:text/javascript,0")).to.throw(/\(worker\)/);
    // the ways in: a listener (http's too), UDP, an addon, the inspector
    expect(() => net.createServer().listen(0, "127.0.0.1")).to.throw(/\(listen\)/);
    expect(() => http.createServer().listen(0)).to.throw(/\(listen\)/);
    const {default: dgram} = await import("node:dgram");
    const udp = dgram.createSocket("udp4");
    expect(() => udp.bind(0)).to.throw(/\(udp\)/);
    udp.close?.();
    expect(() => process.dlopen({exports: {}}, "/nonexistent/m4.node")).to.throw(/\(dlopen\)/);
    const inspector = await import("node:inspector");
    expect(() => inspector.open(0)).to.throw(/\(inspector\)/);
    expect(() => process.kill(process.pid, "SIGUSR1")).to.throw(/\(signal\)/);
    // the message never names a target; the record does
    expect(error.message).to.not.contain(String(target.port));
    // the host's own listener is allowed by the server object, not a port
    const own = guard.allowListener(net.createServer());
    await new Promise((done) => own.listen(0, "127.0.0.1", done));
    await new Promise((done) => own.close(done));
    await settle();
    expect(target.seen.connections).to.equal(0);
    expect(lines.filter((l) => l.startsWith("hana-serve: refused outbound")).length).to.equal(14);
    expect(guard.intact()).to.deep.equal([]);
  });

  it("lets the database client's own connection through, and its endpoint again later -- but not for an HTTP send", async () => {
    const opened = guard.asOwnDatabase(() => net.connect(target.port, "127.0.0.1"));
    await new Promise((done) => opened.once("close", done).once("error", done));
    await settle();
    expect(target.seen.connections).to.equal(1);
    // a reconnect of the database client to its own endpoint
    const again = net.connect(target.port, "127.0.0.1");
    await new Promise((done) => again.once("close", done).once("error", done));
    await settle();
    expect(target.seen.connections).to.equal(2);
    // the HTTP client's send is refused even toward that endpoint, and
    // fills the entry it was given instead of adding one
    const entry = {kind: "http"};
    expect(() => guard.denyAll(() => net.connect(target.port, "127.0.0.1"), entry)).to.throw(/refuses/);
    expect(entry).to.deep.equal({kind: "http", target: `127.0.0.1:${target.port}`, socket: "refused before it opened"});
    await settle();
    expect(target.seen.connections).to.equal(2);
  });

  it("gives everything back on uninstall (unlocked; the host's is locked)", async () => {
    guard.uninstall();
    guard = undefined;
    const socket = net.connect(target.port, "127.0.0.1");
    await new Promise((done) => socket.once("close", done).once("error", done));
    await settle();
    expect(target.seen.connections).to.equal(3);
    expect(() => spawnChild(process.execPath, ["-e", "0"]).kill()).to.not.throw();
  });
});

describe("hana-host-guard: the locked guard in a process of its own (the host's install)", function () {
  this.timeout(30000);
  // The critic's reproducer (round 2): net.Server.prototype._listen2 binds by
  // itself, below listen(); called directly it listened on all interfaces
  // and an external process delivered data. The child installs the guard
  // exactly as the host does ({lock: true}) and reports what opened; this
  // process is the outside that tries to connect.
  const child = (body, onData = () => undefined) => new Promise((resolve) => {
    const script = `const {installOutboundGuard, installStubHook, createHostRecord} = await import(${JSON.stringify(new URL("../tools/hana-host-guard.mjs", import.meta.url).href)});
const lines = [];
const record = createHostRecord({log: (l) => lines.push(l)});
installOutboundGuard(record, {lock: true});
installStubHook(record, {lock: true});
const net = await import("node:net");
const report = (name, f) => { try { console.log(name + " OPEN " + (f() ?? "")); } catch (e) { console.log(name + " REFUSED " + (e.code ?? e.message)); } };
${body}
setTimeout(() => { for (const l of lines) console.log("LOG " + l); process.exit(0); }, 1500);`;
    const proc = spawnChild(process.execPath, ["--input-type=module", "-e", script], {stdio: ["ignore", "pipe", "pipe"]});
    let out = "";
    proc.stdout.on("data", (c) => { out += c; onData(out); });
    proc.stderr.on("data", (c) => { out += c; });
    proc.on("exit", () => resolve(out));
  });

  it("refuses _listen2 called directly: no port, nothing an outside process can reach, the record says listen", async () => {
    // the outside: connect to whatever port the child says it opened
    let connected = false;
    const out = await child(`report("_listen2", () => { const s = new net.Server((c) => c.on("data", (d) => console.log("ACCEPTED " + d))); s._listen2(0); console.log("PORT=" + s.address().port); });`,
      (text) => {
        const m = /PORT=(\d+)/.exec(text);
        if (m === null || connected === true) return;
        connected = true;
        const socket = net.connect(Number(m[1]), "127.0.0.1", () => socket.end("exfil-marker"));
        socket.on("error", () => undefined);
      });
    expect(out).to.not.match(/ACCEPTED/);
    expect(out).to.not.match(/PORT=/);
    expect(connected).to.equal(false);
    expect(out).to.match(/_listen2 REFUSED OSD_OUTBOUND_REFUSED/);
    expect(out).to.match(/LOG hana-serve: refused outbound listen/);
  });

  it("refuses the siblings: listen(path), listen({fd}), http2 (plain and secure), cluster.fork, dgram bind, a subclass's own listen", async () => {
    const out = await child(`
report("path", () => net.createServer().listen(${JSON.stringify(join(tmpdir(), `m4-guard-${process.pid}.sock`))}));
report("fd", () => net.createServer().listen({fd: 0}));
const http2 = await import("node:http2");
report("http2", () => http2.createServer().listen(0));
report("http2s", () => http2.createSecureServer({}).listen(0));
const cluster = (await import("node:cluster")).default;
report("cluster", () => { cluster.setupPrimary({exec: "/dev/null"}); cluster.fork(); });
const dgram = (await import("node:dgram")).default;
report("udp", () => dgram.createSocket("udp4").bind(0));
const http = (await import("node:http")).default;
Object.defineProperty(http.Server.prototype, "listen", {configurable: true, writable: true, value: function () { return this._listen2(null, 0, 4, 511); }});
report("shadow", () => http.createServer().listen());
http.Server.prototype.listen = undefined;
`);
    for (const name of ["path", "fd", "http2", "http2s", "cluster", "udp", "shadow"]) expect(out, name).to.match(new RegExp(`^${name} REFUSED OSD_OUTBOUND_REFUSED$`, "m"));
    expect(out).to.not.match(/ OPEN /);
  });
});

describe("hana-serve with the guard and the stub trace (twin ZOSD_M4G_SRV)", function () {
  this.timeout(180000);
  let dir;
  let target;
  const hosts = [];

  const boot = async (args, env) => {
    const lines = [];
    const child = spawnChild(process.execPath, [tool, "--port", "0", "--client-module", "test/fixtures/hana-serve/twin-client.mjs",
      "--register", "ZOSD_M4G_SRV=ZCL_OSD_H5X_APP_MPC,ZCL_OSD_M4G_DPC", ...args], {cwd: root, env, stdio: ["ignore", "pipe", "pipe"]});
    hosts.push(child);
    const base = await new Promise((resolve, reject) => {
      const take = (chunk) => {
        for (const line of String(chunk).split("\n")) {
          if (line === "") continue;
          lines.push(line);
          const m = /listening on (http:\/\/\S+?)\/sap\/opu\/odata\//.exec(line);
          if (m) resolve(m[1]);
        }
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      child.on("exit", (code) => reject(new Error(`hana-serve exited ${code} before listening:\n${lines.join("\n")}`)));
    });
    return {base, lines, child};
  };
  const hostEnv = () => {
    const env = {...process.env};
    for (const name of ["STG_DB", "STG_SQL_TRACE", "STG_DB_TRACE", "OSD_HANA_WRITE", "STG_DB_FRESH", "OSD_BIND", "STG_TABLE_PROXY", "STG_RFC_PROXY", "HANA_OWN_SCHEMA", "OSD_SQL_TRACE"]) delete env[name];
    return Object.assign(env, {HANA_EXISTING_SCHEMA: "1", OSD_CLIENT: "100", HANA_SCHEMA: "OSDM4TENANT", OSD_OUTPUT: output});
  };
  const partners = (base, name) => fetch(`${base}/sap/opu/odata/sap/ZOSD_M4G_SRV/PartnerSet?$format=json&$filter=${encodeURIComponent(`Name eq '${name}'`)}`);
  const traceOf = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  /** the trace lines, once `count` lines match `pred` (the line is written
   *  when the response ends; this waits rather than reads the last line) */
  const linesFor = async (pred, count = 1) => {
    for (let i = 0; i < 40; i += 1) {
      const found = traceOf(file).filter(pred);
      if (found.length >= count) return found;
      await new Promise((done) => setTimeout(done, 50));
    }
    return traceOf(file).filter(pred);
  };
  let seenLines = 0;
  /** the request lines written since the last call */
  const nextLines = async (count) => {
    const all = await linesFor((l) => l.boot !== true, seenLines + count);
    const fresh = all.slice(seenLines);
    seenLines = all.length;
    return fresh;
  };

  let traced;
  let file;

  before(async function () {
    if (!existsSync(join(output, "init.mjs")) || !existsSync(join(output, "zcl_osd_m4g_dpc.clas.mjs"))) this.skip();
    dir = mkdtempSync(join(tmpdir(), "host-guard-serve-"));
    file = join(dir, "private", "stub-trace.ndjson");
    target = await listener();
    traced = await boot(["--stub-trace", file], hostEnv());
  });

  after(async () => {
    for (const child of hosts) {
      if (child.exitCode === null) {
        const gone = new Promise((done) => child.once("exit", done));
        child.kill("SIGTERM");
        await gone;
      }
    }
    await target?.close();
    if (dir !== undefined) rmSync(dir, {recursive: true, force: true});
  });

  it("boots with the probe seen and the load-time stub signal on the boot line", () => {
    expect(traced.lines.join("\n")).to.match(/outbound calls refused .*; \d+ stub signal\(s\) at load; stub trace .*stub-trace\.ndjson/);
    const [first] = traceOf(file);
    expect(first).to.deep.include({boot: true, probe: "seen"});
    expect(first.stubs).to.deep.include({class: "ZCL_OSD_M4G_GAP", method: "CLASS_CONSTRUCTOR", reason: "ZOSD_M4G_LOAD_GAP (test fixture, test/hana-m4)"});
    expect(first.stubs.some((s) => s.reason === PROBE_REASON)).to.equal(false);
  });

  it("refuses the HTTP client by URL and by destination: 200 on the wire, the listener receives nothing, the trace names it", async () => {
    const url = `http://127.0.0.1:${target.port}/m4`;
    for (const name of [`M4URL:${url}`, "M4DEST:ZOSD_M4_DEST", `M4ROOT:${url}`]) {
      const answer = await partners(traced.base, name);
      expect(answer.status, name).to.equal(200);
      const text = await answer.text();
      expect(JSON.parse(text).d.results, name).to.deep.equal([]);
      // never in the response, header or body
      expect(text).to.not.match(/refus|OSD_OUTBOUND|ZOSD_M4_DEST/);
      expect([...answer.headers.keys()].join(" ")).to.not.match(/trace|stub|refus/i);
      await settle();
      expect(target.seen, name).to.deep.equal({connections: 0, bytes: 0});
    }
    await settle();
    expect(target.seen).to.deep.equal({connections: 0, bytes: 0});
    const requests = await nextLines(3);
    expect(requests.map((l) => [l.method, l.status])).to.deep.equal([["GET", 200], ["GET", 200], ["GET", 200]]);
    expect(requests[0].refused).to.deep.equal([{kind: "http", via: "CL_HTTP_CLIENT=>CREATE_BY_URL", target: `127.0.0.1:${target.port}`, socket: "refused before it opened"}]);
    expect(requests[1].refused).to.have.length(1);
    expect(requests[1].refused[0]).to.deep.include({kind: "http", via: "CL_HTTP_CLIENT=>CREATE_BY_DESTINATION", destination: "ZOSD_M4_DEST", target: "destination ZOSD_M4_DEST"});
    // the provider that caught cx_root hid nothing from the record
    expect(requests[2].refused).to.deep.equal(requests[0].refused);
  });

  it("traces a stub raise the provider catches: 200 on the wire, the stub on the line", async () => {
    const answer = await partners(traced.base, "M4STUB");
    expect(answer.status).to.equal(200);
    expect(await answer.text()).to.not.contain("ZOSD_M4G_REQUEST_GAP");
    const [last] = await nextLines(1);
    expect(last).to.deep.include({method: "GET", path: "/sap/opu/odata/sap/ZOSD_M4G_SRV/PartnerSet", status: 200, refused: []});
    expect(last.stubs).to.deep.equal([{class: "ZCL_OSD_M4G_GAP", method: "NOT_HERE", reason: "ZOSD_M4G_REQUEST_GAP"}]);
  });

  it("writes a line for a request refused before the ABAP too, and the twin's own reads still answer", async () => {
    expect((await fetch(`${traced.base}/sap/opu/odata/sap/ZOSD_M4G_SRV/PartnerSet`, {method: "DELETE"})).status).to.equal(405);
    expect((await nextLines(1))[0]).to.deep.include({method: "DELETE", status: 405, stubs: [], refused: []});
    const plain = await fetch(`${traced.base}/sap/opu/odata/sap/ZOSD_M4G_SRV/PartnerSet?$format=json&$top=1`);
    expect(plain.status).to.equal(200);
    expect((await plain.json()).d.results).to.have.length(1);
    await nextLines(1);
  });

  it("keeps a refusal that crosses the ABAP as a plain error out of the 500's body (S1)", async () => {
    for (const [name, kind, target] of [["M4RAW", "dns", "m4-raw-target.invalid"], ["M4LISTEN", "listen", "127.0.0.1:0"]]) {
      const answer = await partners(traced.base, name);
      expect(answer.status, name).to.equal(500);
      const text = await answer.text();
      expect(JSON.parse(text).error.code, name).to.equal("OSD/REFUSED");
      expect(text, name).to.not.contain("m4-raw-target");
      expect(text, name).to.not.match(/127\.0\.0\.1|dns|listen/);
      const [line] = await nextLines(1);
      expect(line, name).to.deep.include({status: 500});
      expect(line.refused, name).to.deep.equal([{kind, target}]);
    }
  });

  it("ignores and records an assignment to the stub hook, and still traces the next stub", async () => {
    const answer = await partners(traced.base, "M4TAMPER");
    expect(answer.status).to.equal(200);
    const [line] = await nextLines(1);
    expect(line.tampered).to.deep.equal([{what: "assignment to globalThis.osdNotActivated, ignored"}]);
    expect((await partners(traced.base, "M4STUB")).status).to.equal(200);
    const [after] = await nextLines(1);
    expect(after.stubs).to.deep.equal([{class: "ZCL_OSD_M4G_GAP", method: "NOT_HERE", reason: "ZOSD_M4G_REQUEST_GAP"}]);
    expect(after.tampered).to.deep.equal([]);
  });

  it("without --stub-trace: no file, the same answers, the events on stderr only", async () => {
    const before = readdirSync(dir).sort();
    const quiet = await boot([], hostEnv());
    expect(quiet.lines.join("\n")).to.contain("stub trace off (--stub-trace <file>)");
    expect((await partners(quiet.base, "M4STUB")).status).to.equal(200);
    expect((await partners(quiet.base, `M4URL:http://127.0.0.1:${target.port}/quiet`)).status).to.equal(200);
    await settle();
    expect(target.seen.connections).to.equal(0);
    expect(quiet.lines).to.include("not activated: ZCL_OSD_M4G_GAP=>NOT_HERE: ZOSD_M4G_REQUEST_GAP");
    expect(quiet.lines.some((l) => l.startsWith(`hana-serve: refused outbound http 127.0.0.1:${target.port}`))).to.equal(true);
    expect(readdirSync(dir).sort()).to.deep.equal(before);
    expect(existsSync(join(root, ".local", "hana-serve", "stub-trace.ndjson"))).to.equal(false);
  });
});

describe("hana-closure-report: --require-unstubbed over every class a service runs", () => {
  let top;
  const island = (...parts) => join(top, "gen", "hana-src", "000-m4", "src", ...parts);
  const clas = (name, superName) => {
    writeFileSync(island(`${name}.clas.abap`), `CLASS ${name} DEFINITION PUBLIC${superName ? ` INHERITING FROM ${superName}` : ""} CREATE PUBLIC.\n  PUBLIC SECTION.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\nENDCLASS.\n`);
  };
  const iwsv = (srv, dpc, model) => writeFileSync(island(`${srv.toLowerCase().padEnd(36)}0001.iwsv.xml`),
    `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWSV" serializer_version="v1.0.0">\n <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n   <_-IWBEP_-I_MGW_SRG>\n    <_-IWBEP_-I_MGW_SRG>\n     <GROUP_TECH_NAME>${srv}</GROUP_TECH_NAME>\n     <GROUP_VERSION>0001</GROUP_VERSION>\n     <MODEL_TECH_NAME>${model}</MODEL_TECH_NAME>\n     <MODEL_VERSION>0001</MODEL_VERSION>\n    </_-IWBEP_-I_MGW_SRG>\n   </_-IWBEP_-I_MGW_SRG>\n   <_-IWBEP_-I_MGW_SRH>\n    <_-IWBEP_-I_MGW_SRH>\n     <TECHNICAL_NAME>${srv}</TECHNICAL_NAME>\n     <VERSION>0001</VERSION>\n     <EXTERNAL_NAME>${srv}</EXTERNAL_NAME>\n     <CLASS_NAME>${dpc}</CLASS_NAME>\n    </_-IWBEP_-I_MGW_SRH>\n   </_-IWBEP_-I_MGW_SRH>\n  </asx:values>\n </asx:abap>\n</abapGit>\n`);
  const iwmo = (model, mpc) => writeFileSync(island(`${model.toLowerCase().padEnd(33)}0001.iwmo.xml`),
    `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWMO" serializer_version="v1.0.0">\n <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n  <asx:values>\n   <_-IWBEP_-I_MGW_OHD>\n    <_-IWBEP_-I_MGW_OHD>\n     <TECHNICAL_NAME>${model}</TECHNICAL_NAME>\n     <VERSION>0001</VERSION>\n     <CLASS_NAME>${mpc}</CLASS_NAME>\n    </_-IWBEP_-I_MGW_OHD>\n   </_-IWBEP_-I_MGW_OHD>\n  </asx:values>\n </asx:abap>\n</abapGit>\n`);

  before(() => {
    top = mkdtempSync(join(tmpdir(), "closure-services-"));
    mkdirSync(island(), {recursive: true});
    // A's DPC inherits from B's _EXT; B has a SEGW project of its own
    iwsv("ZOSD_M4A_SRV", "ZCL_OSD_M4A_DPC_EXT", "ZOSD_M4A_MDL");
    iwmo("ZOSD_M4A_MDL", "ZCL_OSD_M4A_MPC_EXT");
    iwsv("ZOSD_M4B_SRV", "ZCL_OSD_M4B_DPC_EXT", "ZOSD_M4B_MDL");
    iwmo("ZOSD_M4B_MDL", "ZCL_OSD_M4B_MPC_EXT");
    clas("zcl_osd_m4a_dpc_ext", "zcl_osd_m4b_dpc_ext");
    clas("zcl_osd_m4b_dpc_ext", "zcl_osd_m4b_dpc");
    clas("zcl_osd_m4b_dpc", "/iwbep/cl_mgw_push_abs_data");
    clas("zcl_osd_m4a_mpc_ext", "zcl_osd_m4a_mpc");
    clas("zcl_osd_m4a_mpc", "/iwbep/cl_mgw_push_abs_model");
    clas("zcl_osd_m4b_mpc_ext", "zcl_osd_m4b_mpc");
    clas("zcl_osd_m4b_mpc", "/iwbep/cl_mgw_push_abs_model");
    // C: hand-written, no SEGW project and no suffix, registered by the dump
    clas("zcl_osd_m4c_data", "zcl_osd_m4c_base");
    clas("zcl_osd_m4c_base", "/iwbep/cl_mgw_abs_data");
    clas("zcl_osd_m4c_model", "/iwbep/cl_mgw_push_abs_model");
    mkdirSync(join(top, "gen", "hana-segw"), {recursive: true});
    writeFileSync(join(top, "gen", "hana-segw", "manifest.json"), JSON.stringify({source: "test"}));
    writeFileSync(join(top, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
      {service: "ZOSD_M4C_SRV", version: "0001", external: "ZOSD_M4C_SRV", dpc: "ZCL_OSD_M4C_DATA", mpc: "ZCL_OSD_M4C_MODEL", model: "ZOSD_M4C_MDL", modelVersion: "0001"},
    ]}));
  });

  after(() => rmSync(top, {recursive: true, force: true}));

  it("reads a superclass with abaplint", () => {
    expect(superClassOf("zcl_osd_m4a_dpc_ext.clas.abap", readFileSync(island("zcl_osd_m4a_dpc_ext.clas.abap"), "utf8"))).to.equal("ZCL_OSD_M4B_DPC_EXT");
  });

  it("follows each registered class's chain through the island, from the registration", () => {
    expect(serviceClasses(top)).to.deep.equal([
      {service: "ZOSD_M4A_SRV", dpc: "ZCL_OSD_M4A_DPC_EXT", mpc: "ZCL_OSD_M4A_MPC_EXT", classes: ["ZCL_OSD_M4A_DPC_EXT", "ZCL_OSD_M4B_DPC_EXT", "ZCL_OSD_M4B_DPC", "ZCL_OSD_M4A_MPC_EXT", "ZCL_OSD_M4A_MPC"]},
      {service: "ZOSD_M4B_SRV", dpc: "ZCL_OSD_M4B_DPC_EXT", mpc: "ZCL_OSD_M4B_MPC_EXT", classes: ["ZCL_OSD_M4B_DPC_EXT", "ZCL_OSD_M4B_DPC", "ZCL_OSD_M4B_MPC_EXT", "ZCL_OSD_M4B_MPC"]},
      {service: "ZOSD_M4C_SRV", dpc: "ZCL_OSD_M4C_DATA", mpc: "ZCL_OSD_M4C_MODEL", classes: ["ZCL_OSD_M4C_DATA", "ZCL_OSD_M4C_BASE", "ZCL_OSD_M4C_MODEL"]},
    ]);
  });

  const summarize = (extra) => {
    const seeds = seedClasses(top);
    return closureSummary({iterations: 1, islandObjects: 10, seeds: seeds.all, named: seeds.named, present: () => true, excluded: [],
      stubs: [
        {object: "ZCL_OSD_M4B_DPC", class: "ZCL_OSD_M4B_DPC", method: "GET_ENTITY"},
        {object: "ZCL_OSD_M4C_BASE", class: "ZCL_OSD_M4C_BASE", method: "READ_ROWS"},
      ],
      gaps: [], ...extra});
  };

  it("fails a hand-written DPC's base stubbed, which the seeds alone never saw", () => {
    const blind = summarize({requireUnstubbed: ["READ_*"]});
    expect(blind.failures).to.deep.equal([]);
    const seeing = summarize({requireUnstubbed: ["READ_*"], services: serviceClasses(top)});
    expect(seeing.failures).to.deep.equal(["--require-unstubbed READ_*: 1 service method(s) stubbed: ZCL_OSD_M4C_BASE=>READ_ROWS (ZOSD_M4C_SRV)"]);
  });

  it("names every service an inherited stub reaches, and lists per service which classes carry stubs", () => {
    const summary = summarize({requireUnstubbed: ["GET_ENTITY"], services: serviceClasses(top)});
    expect(summary.failures).to.deep.equal(["--require-unstubbed GET_ENTITY: 1 service method(s) stubbed: ZCL_OSD_M4B_DPC=>GET_ENTITY (ZOSD_M4A_SRV, ZOSD_M4B_SRV)"]);
    expect(summary.services.map((s) => [s.service, s.stubbed])).to.deep.equal([
      ["ZOSD_M4A_SRV", [{class: "ZCL_OSD_M4B_DPC", methods: ["GET_ENTITY"]}]],
      ["ZOSD_M4B_SRV", [{class: "ZCL_OSD_M4B_DPC", methods: ["GET_ENTITY"]}]],
      ["ZOSD_M4C_SRV", [{class: "ZCL_OSD_M4C_BASE", methods: ["READ_ROWS"]}]],
    ]);
    // without services the summary is what it was
    expect(summarize({}).services).to.equal(undefined);
  });
});
