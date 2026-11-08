// The workbench shape, end to end: the way a server is started (test/run.mjs)
// puts the system in a child, and this process holds no ABAP. Everything a
// client reaches must still be there — through a proxy or a door.
import {expect} from "chai";
import {spawn} from "node:child_process";
import {randomUUID} from "node:crypto";
import {once} from "node:events";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {services} from "../tools/osd-icf.mjs";
import {createRequire} from "node:module";
import {ServingRuntime, liveChildren} from "../tools/osd-runtime.mjs";
import {DatabaseSync} from "node:sqlite";
import {BatchRuns} from "../tools/osd-batch-runs.mjs";
import {checkHostContract} from "../tools/osd-host-contract.mjs";
import {runtimeRootFixture} from "./helpers/runtime-root.mjs";

const runtimeFixture = runtimeRootFixture();

const {Osd, objectOf, outcomes, unitRiskOf, unitDurationOf, runUnitQueue} = createRequire(import.meta.url)("../editors/vscode/lib.js");

const PORT = Number(process.env.STG_PORT ?? 3091) + 7;
const BASE = `http://localhost:${PORT}`;
const ADT = `${BASE}/sap/bc/adt`;

describe("test/run.mjs: the workbench shape, one generation and one database", function () {
  this.timeout(180000);
  let child;
  let token;
  let cookie;
  let databaseDir;
  let testIdentity;
  let monitorToken;
  let operationsDb;
  const log = [];

  before(async () => {
    databaseDir = mkdtempSync(join(tmpdir(), "osd-child-"));
    testIdentity = `osd-child-${randomUUID()}`;
    monitorToken = randomUUID().replaceAll("-", "");
    operationsDb = join(databaseDir, "osd-operations.sqlite");
    const backend = process.env.STG_DB === "duckdb" ? "duckdb" : "file";
    child = spawn(process.execPath, ["test/run.mjs"], {
      cwd: runtimeFixture.root,
      // Always use a private file, never an inherited HANA connection.
      env: {...process.env, STG_DB: backend, STG_PORT: String(PORT), STG_TLS: "0", STG_SERVE: undefined,
        OSD_ADT_ONE_RUNTIME: "1", OSD_USER_FULL: testIdentity, STG_DB_BASE: join(databaseDir, "base"),
        STG_DB_PATH: join(databaseDir, backend === "duckdb" ? "osd.duckdb" : "osd.sqlite"),
        OSD_OPERATIONS_DB: operationsDb, OSD_BATCH_READ_TOKEN: monitorToken},
      stdio: ["ignore", "pipe", "pipe"],
    });
    delete child.spawnargs; // keep the env clean: STG_SERVE unset means run.mjs picks child
    child.stdout.on("data", (d) => log.push(String(d)));
    child.stderr.on("data", (d) => log.push(String(d)));
    for (let i = 0; i < 120; i++) {
      try {
        const res = await fetch(`${ADT}/core/discovery`, {method: "HEAD", headers: {"x-csrf-token": "fetch"}});
        if (res.status === 200) {
          token = res.headers.get("x-csrf-token");
          cookie = (res.headers.getSetCookie?.() ?? []).join("; ").match(/sap-contextid=[^;]+/)?.[0];
          break;
        }
      } catch {
        // not up yet
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(token, `the façade came up: ${log.join("").slice(-800)}`).to.be.a("string");
    // A fixed test port can already belong to another OSD. Never send the
    // write below until this listener proves it is the process we spawned.
    const build = await (await call("/core/http/build")).json();
    expect(build.identity?.userFullName, `port ${PORT} belongs to this test process`)
      .to.equal(testIdentity);
    expect(child.exitCode, "the spawned façade is still running").to.equal(null);
  });
  after(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, "exit");
      child.kill("SIGTERM");
      await stopped;
    }
    if (databaseDir) rmSync(databaseDir, {recursive: true, force: true});
  });

  const call = (path, options = {}) => fetch(ADT + path, {...options, headers: {cookie, "x-csrf-token": token, ...(options.headers ?? {})}});

  for (const door of ["adt-step", "adt-sessions", "adt-resume"]) {
    it(`the parent's public port does not mount the internal ${door} door`, async () => {
      const response = await fetch(BASE + "/osd/" + door, {method: "POST", headers: {"content-type": "application/json"}, body: "{}"});
      expect(response.status, door).to.equal(404);
    });
  }

  it("this process holds no ABAP: the build endpoint says the rows are read through the door", async () => {
    // the child starts at the first request that needs it; ask for one
    await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
    const body = await (await call("/core/http/build")).json();
    expect(body.system, "three names and a database").to.include.keys("source", "live", "serving", "database");
    expect(body.system.database.preview, "the preview reads through the runtime's door").to.equal("serving");
    expect(body.system.serving, "the child runs the live build").to.equal(body.system.live);
    // a tree with unbuilt edits is honestly not synchronized; the flag must
    // say so, and say the opposite when there are none
    expect(body.system.synchronized).to.equal(body.system.source === body.system.live);
  });

  it("OData is proxied to the child, which names its generation", async () => {
    const res = await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
    expect(res.status).to.equal(200);
    expect(res.headers.get("x-osd-generation")).to.match(/^[0-9a-f]{16}$/);
  });

  it("F8 on a table reads the rows the application serves", async () => {
    const res = await call("/datapreview/ddic?rowNumber=3&ddicEntityName=ZSTG_DEMO", {method: "POST",
      body: "SELECT ZSTG_DEMO~TRAVEL_ID FROM ZSTG_DEMO"});
    expect(res.status).to.equal(200);
    const xml = await res.text();
    expect((xml.match(/<dataPreview:data>/g) ?? []).length, "rows through the door").to.be.greaterThan(0);
    const wrong = await call("/datapreview/freestyle", {method: "POST", body: "DROP TABLE zstg_demo"});
    expect(wrong.status, "a refusal keeps its code across the door").to.equal(400);
  });

  it("an OData write is immediately visible in F8 and the SQL Pane without a restart", async () => {
    const id = "T0898";
    const description = "Live OData to ADT";
    const odata = `${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet`;
    const sql = `SELECT travel_id, description FROM zstg_demo WHERE travel_id = '${id}'`;
    const preview = (path, query) => call(path, {method: "POST", body: query});
    const before = await preview("/datapreview/freestyle?rowNumber=2", sql);
    expect(before.status).to.equal(200);
    expect(await before.text(), "the isolated database has no test row yet")
      .to.contain("<dataPreview:totalRows>0</dataPreview:totalRows>");

    const buildBefore = await (await call("/core/http/build")).json();
    expect(buildBefore.identity?.userFullName, "the write target is still our isolated OSD").to.equal(testIdentity);
    const generation = buildBefore.system?.serving;
    expect(generation).to.match(/^[0-9a-f]{16}$/);
    const workProcess = async () => {
      const response = await fetch(`${BASE}/sap/opu/odata/sap/ZOSD_STATUS_SRV/ProcessSet?$format=json`);
      expect(response.status, await response.clone().text()).to.equal(200);
      const work = (await response.json()).d.results.find((row) => row.Role === "work");
      expect(work, "the live runtime is in the status snapshot").to.include.keys("Pid", "Since");
      return {pid: work.Pid, since: work.Since};
    };
    const workerBefore = await workProcess();
    const created = await fetch(odata, {
      method: "POST",
      headers: {"content-type": "application/json", "x-csrf-token": "open-steamgate"},
      body: JSON.stringify({Project: "ZSTG_MAPPED", TravelId: id, Description: description, Status: "O", Seats: 2}),
    });
    expect(created.status, await created.text()).to.equal(201);

    const read = await fetch(`${odata}('${id}')?$format=json`);
    expect(read.status).to.equal(200);
    expect((await read.json()).d.Description).to.equal(description);

    const f8 = await preview("/datapreview/ddic?rowNumber=2&ddicEntityName=ZSTG_DEMO",
      `SELECT ZSTG_DEMO~TRAVEL_ID, ZSTG_DEMO~DESCRIPTION FROM ZSTG_DEMO WHERE ZSTG_DEMO~TRAVEL_ID = '${id}'`);
    expect(f8.status, await f8.clone().text()).to.equal(200);
    const f8Xml = await f8.text();
    expect(f8Xml).to.contain("<dataPreview:totalRows>1</dataPreview:totalRows>");
    expect(f8Xml).to.contain(`<dataPreview:data>${id}</dataPreview:data>`);
    expect(f8Xml).to.contain(`<dataPreview:data>${description}</dataPreview:data>`);

    const pane = await preview("/datapreview/freestyle?rowNumber=2", sql);
    expect(pane.status, await pane.clone().text()).to.equal(200);
    const paneXml = await pane.text();
    expect(paneXml).to.contain("<dataPreview:totalRows>1</dataPreview:totalRows>");
    expect(paneXml).to.contain(`<dataPreview:data>${id}</dataPreview:data>`);
    expect(paneXml).to.contain(`<dataPreview:data>${description}</dataPreview:data>`);
    expect(pane.headers.get("x-osd-generation"), "the same build answered after the write").to.equal(generation);
    const buildAfter = await (await call("/core/http/build")).json();
    expect(buildAfter.started, "the façade did not restart").to.equal(buildBefore.started);
    expect(await workProcess(), "the work process did not restart").to.deep.equal(workerBefore);
  });

  it("every ICF service the tree declares is reachable through the parent", async () => {
    const declared = services(process.cwd()).filter((s) => s.handler !== undefined && !s.path.startsWith("/sap/opu/odata") && !s.path.startsWith("/sap/bc/adt"));
    expect(declared.length, "the tree declares services").to.be.greaterThan(0);
    for (const service of declared) {
      const res = await fetch(BASE + service.path);
      // whatever the handler answers to a bare GET is its business; what
      // matters is that the child answered it, which its header proves
      expect(res.headers.get("x-osd-generation"), `${service.path} (${service.handler}) answered by the child, status ${res.status}`).to.match(/^[0-9a-f]{16}$/);
    }
  });

  it("the ADT front shares the child database and ENQ table, and a lock outlives a recycle", async () => {
    // B1/B2: the child owns the front, session rows and lock table.
    const logon = async (user) => {
      const res = await fetch(`${ADT}/core/discovery`, {method: "HEAD", headers: {"x-csrf-token": "fetch",
        "x-sap-adt-sessiontype": "stateful", authorization: "Basic " + Buffer.from(`${user}:x`).toString("base64")}});
      // discovery is an ABAP row since A1; the front answered either way
      expect(res.headers.get("x-osd-served-by"), "the front answered").to.equal("ABAP");
      return {cookie: res.headers.getSetCookie().join("; ").match(/sap-contextid=[^;]+/)?.[0], token: res.headers.get("x-csrf-token")};
    };
    const as = (client, method, path) => fetch(ADT + path, {method,
      headers: {cookie: client.cookie, "x-csrf-token": client.token, "x-sap-adt-sessiontype": "stateful"}});
    const sysinfo = await call("/core/http/systeminformation");
    expect(sysinfo.headers.get("x-osd-served-by"), "an ABAP row is ABAP's").to.equal("ABAP");
    const one = await logon("CHILDONE");
    const two = await logon("CHILDTWO");
    const object = "/oo/classes/ZCL_OSD_ADT_HANDLER";
    const locked = await as(one, "POST", `${object}?_action=LOCK&accessMode=MODIFY`);
    expect(locked.status, await locked.clone().text()).to.equal(200);
    expect(locked.headers.get("x-osd-served-by")).to.equal("ABAP");
    const handle = /<LOCK_HANDLE>([^<]+)<\/LOCK_HANDLE>/.exec(await locked.text())?.[1];
    const readRows = async (sql) => {
      const response = await fetch(`${BASE}/osd/sql`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({sql})});
      expect(response.status).to.equal(200);
      return (await response.json()).rows;
    };
    expect((await readRows("SELECT handle FROM zosd_adt_shdl")).map(r => r.handle)).to.include(handle);
    expect((await readRows("SELECT id FROM zosd_adt_sess")).length).to.be.greaterThan(0);
    const firstProbe = await fetch(`${BASE}/osd/classrun`, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({name: "ZCL_OSD_ADT_ENQ_PROBE"})});
    expect((await firstProbe.json()).text.trim(), "the first child already sees ADT's one lock").to.equal("1");
    // Start it explicitly so this case also runs alone for its red proof.
    expect((await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`)).status).to.equal(200);
    // the serving child goes away and comes back
    const before = await (await fetch(`${BASE}/osd/serving`)).json();
    process.kill(before.pid, "SIGKILL");
    let after;
    for (let i = 0; i < 120 && (after === undefined || after.pid === before.pid); i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch(`${BASE}/osd/serving`);
        if (res.status === 200) after = await res.json();
      } catch {
        // not back yet
      }
    }
    expect(after?.pid, "a new serving child").to.not.equal(before.pid);
    const probe = await fetch(`${BASE}/osd/classrun`, {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({name: "ZCL_OSD_ADT_ENQ_PROBE"})});
    expect((await probe.json()).text.trim(), "ENQUEUE_READ in the new child sees the ADT lock").to.equal("1");
    const refused = await as(two, "POST", `${object}?_action=LOCK&accessMode=MODIFY`);
    expect(refused.status, "the lock outlived the child").to.equal(403);
    expect(await refused.text()).to.contain("CHILDONE");
    expect((await as(one, "POST", `${object}?_action=UNLOCK&lockHandle=${handle}`)).status).to.equal(200);
    for (const client of [one, two]) await fetch(`${BASE}/sap/public/bc/icf/logoff`, {headers: {cookie: client.cookie}});
  });

  it("the child's own doors (/osd/serving, /osd/dumps, /osd/sql) answer through the parent", async () => {
    const serving = await fetch(`${BASE}/osd/serving`);
    expect(serving.status, "/osd/serving").to.equal(200);
    expect(await serving.json()).to.be.an("object");
    const dumps = await fetch(`${BASE}/osd/dumps`);
    expect(dumps.status, "/osd/dumps").to.equal(200);
    expect(await dumps.json()).to.be.an("array");
    const sql = await fetch(`${BASE}/osd/sql`, {method: "POST", headers: {"content-type": "application/json"},
      body: JSON.stringify({sql: "SELECT COUNT(*) AS n FROM zstg_demo"})});
    expect(sql.status, `/osd/sql: ${await sql.clone().text()}`).to.equal(200);
  });

  it("answers the supervised-host contract the osgo binary is held to as well (tools/osd-host-contract.mjs)", async () => {
    // the same assertions the osgo-host CI job runs against the Go binary:
    // one check for both hosts, so /osd/serving and X-OSD-Generation cannot
    // drift apart by description (go/serving/README.md)
    const body = await checkHostContract(BASE);
    expect(body.generation).to.equal(((await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`)).headers.get("x-osd-generation")));
  });

  it("forwards the authorized batch monitor without exposing selection values", async () => {
    const store = new BatchRuns(process.cwd(), {OSD_OPERATIONS_DB: operationsDb});
    const queued = store.enqueue({program: "ZGG_EX_012", input: [{name: "P_DATE", value: "private-value"}]});
    store.close();
    expect((await fetch(`${BASE}/osd/batch-runs`)).status).to.equal(401);
    const response = await fetch(`${BASE}/osd/batch-runs`, {
      headers: {Authorization: `Bearer ${monitorToken}`},
    });
    expect(response.status, await response.clone().text()).to.equal(200);
    expect(response.headers.get("x-osd-generation")).to.match(/^[0-9a-f]{16}$/);
    const body = await response.json();
    expect(body.runs.some((run) => run.id === queued.id)).to.equal(true);
    expect(JSON.stringify(body)).not.to.include("private-value");
  });

  it("the VS Code extension's client discovers and runs one method through the parent", async () => {
    const client = new Osd(BASE);
    expect((await client.serving()).generation).to.be.a("string");
    const object = objectOf("test/unit/zcl_osd_form_test.clas.testclasses.abap");
    const found = await client.discover(object);
    const testClass = found.classes.find((c) => c.name === "LTCL_FORM");
    expect(testClass.methods.map((m) => m.name)).to.include("A_PAIR");
    const results = outcomes(await client.run(object, "LTCL_FORM", "A_PAIR"));
    expect(results.map((r) => [r.method, r.passed])).to.deep.equal([["A_PAIR", true]]);
  });

  // The Test Explorer's queue by RISK LEVEL (tools/osd-unit-risk.mjs,
  // editors/vscode/lib.js runUnitQueue), end to end: the façade says what
  // each class is scheduled as, two HARMLESS objects run at once, the one
  // that writes runs alone after them, and every outcome is what a serial
  // run gives
  it("runs HARMLESS test objects in parallel and the rest alone, with the results of a serial run", async () => {
    const client = new Osd(BASE);
    const names = ["ZCL_OSD_DEMO_RANDOM", "ZCL_OSD_ABAP_TOKENS", "ZCL_OSD_ICF_TEST"];
    const described = {};
    for (const name of names) {
      const found = await client.discover({type: "CLAS", name});
      described[name] = {found, schedules: found.classes.filter((c) => c.methods.length > 0)
        .map((c) => ({schedule: c.schedule, duration: c.durationCategory}))};
    }
    expect(unitRiskOf(described.ZCL_OSD_DEMO_RANDOM.schedules)).to.equal("harmless");
    expect(unitRiskOf(described.ZCL_OSD_ABAP_TOKENS.schedules)).to.equal("harmless");
    // ICF tests write the service registry and declare CRITICAL; the
    // conservative reachability check still names the write.
    const icf = described.ZCL_OSD_ICF_TEST.found;
    // The queue has two lanes: HARMLESS, then DANGEROUS/CRITICAL together.
    expect(unitRiskOf(described.ZCL_OSD_ICF_TEST.schedules)).to.equal("dangerous");
    expect(icf.classes.some((c) => c.riskLevel === "critical" && c.riskLevelDeclared && c.schedule === "critical")).to.equal(true);
    expect(icf.writes[0]).to.include({object: "ZCL_OSD_ICF_TEST"});

    const outcome = async (pooled) => {
      let running = 0;
      const seen = [];
      const results = {};
      const units = names.map((name) => ({
        key: name,
        risk: pooled ? unitRiskOf(described[name].schedules) : "dangerous",
        duration: unitDurationOf(described[name].schedules),
        run: async () => {
          running += 1;
          seen.push([name, running]);
          try {
            const answer = await client.run({type: "CLAS", name});
            results[name] = answer.testClasses.map((c) => [c.name, c.testMethods.map((m) => [m.name, m.alerts.map((a) => a.title)])]);
          } finally {
            running -= 1;
          }
        },
      }));
      await runUnitQueue(units, {poolSize: pooled ? 2 : 1});
      return {seen, results};
    };
    const pooled = await outcome(true);
    const serial = await outcome(false);
    expect(Math.max(...pooled.seen.filter(([name]) => name !== "ZCL_OSD_ICF_TEST").map(([, n]) => n)), "two HARMLESS at once").to.equal(2);
    expect(pooled.seen.find(([name]) => name === "ZCL_OSD_ICF_TEST")[1], "the CRITICAL one alone").to.equal(1);
    expect(pooled.seen.at(-1)[0], "and after them").to.equal("ZCL_OSD_ICF_TEST");
    expect(pooled.results).to.deep.equal(serial.results);
  });

  it("an ADT answer names the same generation the child runs", async () => {
    const adt = await call("/core/discovery");
    const odata = await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
    expect(adt.headers.get("x-osd-generation")).to.equal(odata.headers.get("x-osd-generation"));
  });

  // the debugger on demand (tools/osd-inspector.mjs): no osd.debug, no
  // OSD_INSPECT, no restart -- the running child opens its inspector when
  // asked, on 127.0.0.1 only, and closes it again
  it("opens the serving child's inspector on request, on 127.0.0.1 only, and closes it", async () => {
    await fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
    const {createServer, connect} = await import("node:net");
    const {networkInterfaces} = await import("node:os");
    const port = await new Promise((resolve) => {
      const probe = createServer().listen(0, "127.0.0.1", () => {
        const free = probe.address().port;
        probe.close(() => resolve(free));
      });
    });
    const door = (body, headers = {}) => fetch(`${BASE}/osd/inspector`,
      {method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify(body)});
    // a web page, or anything that is not a program on this machine, is
    // refused before anything opens: an Origin, a text/plain body (a CORS
    // simple request), a Host that is not a loopback name (DNS rebinding)
    const {request: httpRequest} = await import("node:http");
    const rawPost = (headers) => new Promise((resolve, reject) => {
      const req = httpRequest({hostname: "127.0.0.1", port: PORT, path: "/osd/inspector", method: "POST", headers}, (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode));
      });
      req.on("error", reject);
      req.end(JSON.stringify({open: true, port}));
    });
    expect(await rawPost({"content-type": "application/json", origin: "http://evil.example"}), "Origin").to.equal(403);
    expect(await rawPost({"content-type": "text/plain"}), "text/plain").to.equal(403);
    expect(await rawPost({"content-type": "application/json", host: `rebound.example:${PORT}`}), "rebound Host").to.equal(403);
    expect(await rawPost({"content-type": "application/json", "sec-fetch-site": "cross-site"}), "Sec-Fetch-Site").to.equal(403);
    expect(await (await fetch(`${BASE}/osd/inspector`)).json()).to.deep.equal({open: false});
    const opened = await door({open: true, port});
    const answer = await opened.json();
    expect(opened.status, JSON.stringify(answer)).to.equal(200);
    expect(answer, "the port, never the inspector's URL").to.deep.equal({open: true, port});
    // a debugger finds it, and the target is the serving child, not the facade
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    expect(targets).to.have.length(1);
    expect(targets[0].webSocketDebuggerUrl).to.match(new RegExp(`^ws://127\\.0\\.0\\.1:${port}/`));
    expect(targets[0].title).to.match(/osd-serve|serve/);
    expect(await (await fetch(`${BASE}/osd/inspector`)).json()).to.deep.equal({open: true, port});
    // and a breakpoint set through it stops a real request: CDP, the protocol
    // VS Code's js-debug speaks, on the gateway's URL parser, which every
    // OData request passes through
    const {readFileSync} = await import("node:fs");
    const generated = readFileSync(join(process.cwd(), "output", "zcl_stg_url.clas.mjs"), "utf8").split("\n");
    const lineNumber = generated.findIndex((line) => line.includes("static async parse(")) + 1;
    expect(lineNumber, "the parser's first statement").to.be.greaterThan(0);
    const cdp = new WebSocket(targets[0].webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { cdp.onopen = resolve; cdp.onerror = reject; });
    let seq = 0;
    const waiting = new Map();
    const events = [];
    cdp.onmessage = ({data}) => {
      const message = JSON.parse(data);
      const reply = Number.isSafeInteger(message.id) && waiting.get(message.id);
      if (reply) reply(message);
      else events.push(message);
    };
    const send = (method, params = {}) => new Promise((resolve) => {
      const id = ++seq;
      waiting.set(id, resolve);
      cdp.send(JSON.stringify({id, method, params}));
    });
    await send("Debugger.enable");
    const set = await send("Debugger.setBreakpointByUrl", {urlRegex: "zcl_stg_url\\.clas\\.mjs$", lineNumber});
    expect(set.result?.locations, JSON.stringify(set)).to.have.length(1);
    const request = fetch(`${BASE}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
    let paused;
    for (let i = 0; i < 100 && paused === undefined; i++) {
      await new Promise((r) => setTimeout(r, 100));
      paused = events.find((e) => e.method === "Debugger.paused");
    }
    expect(paused?.params?.hitBreakpoints, "the request stopped on the breakpoint").to.deep.equal([set.result.breakpointId]);
    await send("Debugger.removeBreakpoint", {breakpointId: set.result.breakpointId});
    await send("Debugger.resume");
    expect((await request).status, "and went on when resumed").to.equal(200);
    // detached the way a debugger detaches, the close handshake finished.
    // (Closing the inspector while it was still in flight froze the child
    // inside node:inspector's close(), the CI flake of 2026-10-02; the
    // runtime now recycles the child instead of closing, so this is order,
    // not a guard: tools/osd-runtime.mjs inspector())
    await new Promise((resolve) => {
      cdp.onclose = resolve;
      cdp.close();
    });
    // and nothing answers on this machine's other addresses
    const others = Object.values(networkInterfaces()).flat().filter((i) => i && !i.internal && i.family === "IPv4");
    for (const {address} of others) {
      const refused = await new Promise((resolve) => {
        const socket = connect({host: address, port}, () => { socket.destroy(); resolve(false); });
        socket.on("error", () => resolve(true));
      });
      expect(refused, `the inspector does not answer on ${address}`).to.equal(true);
    }
    const closed = await door({open: false});
    const closedAnswer = await closed.json();
    expect(closedAnswer, JSON.stringify(closedAnswer)).to.include({open: false});
    let reachable = true;
    try {
      await fetch(`http://127.0.0.1:${port}/json/list`);
    } catch {
      reachable = false;
    }
    expect(reachable, "closed means closed").to.equal(false);
    const invalid = await door({open: true, port: 70000});
    expect(invalid.status).to.equal(409);
    expect((await invalid.json()).error).to.match(/invalid inspector port/);
  });
});

// Exercise the carry where B1 will own the rows, without moving the front.
describe("B0 child-owned ADT carry", function () {
  this.timeout(180000);
  const id = "b00000000000000000000001";
  const state = () => ({version: 1,
    zosd_adt_sess: [{mandt: "123", id, username: "B0USER", token: "b0-token", stateful: "X",
      created: "20261002000000", touched: "20261002000000"}],
    zosd_adt_shdl: [{mandt: "123", id, handle: "b0-handle", objtype: "CLAS", objname: "ZCL_B0"}],
  });
  for (const backend of ["sqlite", "duckdb", "file"]) {
    it(`${backend}: clean carry and boot rebuild; crash uses only database rows`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "osd-b0-"));
      const database = backend === "file" ? join(dir, "osd.sqlite") : undefined;
      const runtime = new ServingRuntime({root: runtimeFixture.root, database, grace: 10000, env: {OSD_ADT_ONE_RUNTIME: "1", STG_DB: backend, OSD_CLIENT: "123", STG_DB_PATH: database ?? "",
        STG_DB_BASE: join(dir, "base"), OSD_DEMO_ROWS: "0"}, adtSnapshot: state});
      const read = async () => {
        const response = await fetch(runtime.url + "/osd/classrun", {method: "POST",
          headers: {"content-type": "application/json"}, body: JSON.stringify({name: "ZCL_OSD_ADT_ENQ_PROBE"})});
        const answer = await response.json();
        expect(answer.ok, JSON.stringify(answer)).to.equal(true);
        return answer.text.trim();
      };
      const token = async () => {
        const response = await fetch(runtime.url + "/osd/sql", {method: "POST",
          headers: {"content-type": "application/json"}, body: JSON.stringify({sql: "SELECT token FROM zosd_adt_sess"})});
        return JSON.stringify(await response.json());
      };
      try {
        await runtime.start();
        runtime.adtSnapshot = undefined;
        expect(await read()).to.equal("1");
        await runtime.recycle();
        expect(await read()).to.equal("1");
        expect(await token()).to.contain("b0-token");
        if (backend === "file") {
          await runtime.stop();
          const db = new DatabaseSync(database);
          db.exec("UPDATE osd_schema SET fingerprint = 'b0-schema-drift'");
          db.close();
          await runtime.start();
          expect(await read(), "schema drift carry").to.equal("1");
          expect(await token(), "schema drift token").to.contain("b0-token");
        }
        const child = liveChildren().find((c) => c.pid === runtime.child.pid);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        await runtime.ensure();
        expect(await read(), "no stale clean carry after a crash").to.equal(backend === "file" ? "1" : "0");
      } finally {
        await runtime.stop();
        rmSync(dir, {recursive: true, force: true});
      }
    });
  }
});
