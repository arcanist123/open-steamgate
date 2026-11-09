import {expect} from "chai";
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createRequire} from "node:module";
import {childDatabaseFacts, databaseFacts, hostKind, packsInfo, platformFacts, portsOf, serviceTree, servicesOf, snapshot, socketsOn} from "../tools/osd-status.mjs";
import {databaseDescriptor} from "../tools/osd-database-identity.mjs";
import {registryClass, segwRegistrations} from "../tools/segw-registry.mjs";
const {groupServices} = createRequire(import.meta.url)("../editors/vscode/lib.js");

// The snapshot the facade posts to ZCL_OSD_STATUS=>REFRESH. The contract is
// the JSON below and the Fiori app is built against it, so these tests say
// the shape out loud rather than only that nothing threw. Everything the
// snapshot cannot know without a real system — the pool, the listeners, the
// generation — is injected, which is what makes it testable at all.
describe("tools/osd-status: the system as one JSON object", () => {
  it("exposes only safe connected descriptor fields", () => {
    expect(databaseDescriptor({name: "HDB", connected: true, password: "secret", path: "/private/db", host: "private"}))
      .to.deep.equal({engine: "HDB", storage: "server", connected: true});
    expect(databaseDescriptor({name: "sqlite", sqlite: {}}).connected).to.equal(true);
    expect(databaseDescriptor({name: "sqlite"}).connected).to.equal(false);
    expect(databaseDescriptor({name: "postgres", connected: true, host: "private", password: "secret"}))
      .to.deep.equal({engine: "postgres", storage: "server", connected: true});
  });

  it("reads child facts and rejects unavailable, stale or invalid descriptors", async () => {
    const runtime = {url: "http://127.0.0.1:45678", generation: "abc"};
    const good = {ready: true, generation: "abc", databaseIdentity: {engine: "duckdb", storage: "file", connected: true, password: "secret"}};
    const read = (body) => childDatabaseFacts(runtime, {fetcher: async (url, options) => {
      expect(url.pathname).to.equal("/osd/serving");
      expect(options.signal).to.be.instanceOf(AbortSignal);
      expect(options.redirect).to.equal("error");
      return {ok: true, json: async () => body};
    }});
    expect((await read(good))[0]).to.include({value: "duckdb", note: "connected backend"});
    const pg = {...good, databaseIdentity: {engine: "postgres", storage: "server", connected: true}};
    expect((await read(pg))[0]).to.include({value: "postgres", note: "connected backend"});
    expect(JSON.stringify(await read(good))).not.to.include("secret");
    for (const body of [{}, {...good, generation: "old"}, {...good, ready: false},
      {...good, databaseIdentity: {...good.databaseIdentity, connected: false}},
      {...good, databaseIdentity: {...good.databaseIdentity, engine: "constructor"}},
      {...good, databaseIdentity: {...good.databaseIdentity, storage: "/private/path"}}]) {
      expect(await read(body)).to.equal(undefined);
    }
    expect(await childDatabaseFacts({})).to.equal(undefined);
    expect(await childDatabaseFacts(runtime, {fetcher: async () => { throw new Error("unavailable"); }})).to.equal(undefined);
    expect(await childDatabaseFacts({...runtime, url: "http://example.test"}, {fetcher: () => { throw new Error("must not fetch"); }})).to.equal(undefined);
  });

  it("bounds a stalled child request", async () => {
    const result = await childDatabaseFacts({url: "http://127.0.0.1:1", generation: "abc"}, {
      timeoutMs: 20,
      fetcher: (_url, {signal}) => new Promise((_resolve, reject) => {
        const keepAlive = setTimeout(() => reject(new Error("test timeout")), 500);
        signal.addEventListener("abort", () => { clearTimeout(keepAlive); reject(signal.reason); });
      }),
    });
    expect(result).to.equal(undefined);
  });
  let root;
  const write = (file, text = "") => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  };

  // a supervisor's two children, as tools/osd-pool.mjs holds them
  const pool = (n) => ({
    generation: "gen-live",
    runtimes: Array.from({length: n}, (_, i) => ({
      child: {pid: 90001 + i},
      port: 38810 + i,
      generation: "gen-live",
      epoch: i + 1,
      running: true,
    })),
  });

  const listeners = [
    {port: 3060, protocol: "HTTP", purpose: "OData, apps, ADT"},
    {port: 44360, protocol: "HTTPS", purpose: "the same, for a client that refuses plain HTTP"},
  ];

  const take = (options = {}) => snapshot(root, {
    client: null,
    runtime: pool(2),
    listeners,
    env: {},
    genLive: "gen-live",
    startedAt: new Date("2026-09-17T09:00:00.000Z"),
    now: new Date("2026-09-17T09:00:30.000Z"),
    rss: 120 * 1048576,
    hostKind: "node",
    platform: [],
    instances: [{pid: 90001, since: "2026-09-17T09:00:01.000Z"}],
    ...options,
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-status-"));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "gen"]}));
    write("src/zcl_ours.clas.abap", "CLASS zcl_ours DEFINITION PUBLIC CREATE PUBLIC.\nENDCLASS.\n");
    write("src/zsrv.sicf.xml", "<abapGit><URL>/sap/bc/zsrv/</URL><ICFHANDLER>ZCL_SRV_HANDLER</ICFHANDLER></abapGit>");
    write("src/zchan.sapc.xml", "<abapGit><PATH>/sap/bc/apc/sap/zchan</PATH><CLASS_NAME>ZCL_CHAN</CLASS_NAME></abapGit>");
    write("src/zdemo_mdl                       0001.iwmo.xml",
      "<abapGit><_-IWBEP_-I_MGW_OHD><TECHNICAL_NAME>ZDEMO_MDL</TECHNICAL_NAME><VERSION>0001</VERSION><CLASS_NAME>ZCL_ZDEMO_MPC_EXT</CLASS_NAME></_-IWBEP_-I_MGW_OHD></abapGit>");
    write("src/zdemo_srv                          0001.iwsv.xml",
      "<abapGit><_-IWBEP_-I_MGW_SRG><MODEL_TECH_NAME>ZDEMO_MDL</MODEL_TECH_NAME><MODEL_VERSION>0001</MODEL_VERSION></_-IWBEP_-I_MGW_SRG>" +
      "<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>ZDEMO_SRV</TECHNICAL_NAME><VERSION>0001</VERSION><EXTERNAL_NAME>ZDEMO_SRV</EXTERNAL_NAME>" +
      "<CLASS_NAME>ZCL_ZDEMO_DPC_EXT</CLASS_NAME></_-IWBEP_-I_MGW_SRH><DESCRIPTION>a demo</DESCRIPTION></abapGit>");
    write("packs/vibes/osd-pack.json", JSON.stringify({order: 60, description: "the worked example"}));
    write("packs/vibes/src/zcl_theirs.clas.abap", "CLASS zcl_theirs DEFINITION PUBLIC CREATE PUBLIC.\nENDCLASS.\n");
    write("packs/vibes/src/zpack.sicf.xml", "<abapGit><URL>/sap/bc/zvibes/</URL><ICFHANDLER>ZCL_VIBES</ICFHANDLER></abapGit>");
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  // ZOSD_SYS-SID is the one system id (tools/osd-identity.mjs): the setting
  // OSD_SID, its alias STG_ADT_SID, else OSD
  it("names the system by the one system id: the setting, else OSD", async () => {
    expect((await take({env: {OSD_SID: "qrs"}})).system.sid).to.equal("QRS");
    expect((await take({env: {STG_ADT_SID: "osx"}})).system.sid).to.equal("OSX");
    expect((await take()).system.sid).to.equal("OSD");
  });

  it("names the system, the generation and the tree, and nothing above it", async () => {
    const s = await take();
    expect(s.system).to.deep.equal({
      sid: "OSD",
      host_kind: "node",
      gen_live: "gen-live",
      gen_serving: "gen-live",
      synced: true,
      workers: 2,
      started_at: "2026-09-17T09:00:00.000Z",
      snap_at: "2026-09-17T09:00:30.000Z",
      root_hint: s.system.root_hint,
      // the process these tables are written in: the child the snapshot is
      // posted to, which is the one that will answer the read
      pid: 90001,
    });
    // the basename of the tree, never a path anyone could walk back
    expect(s.system.root_hint).to.match(/^osd-status-/);
    expect(JSON.stringify(s)).to.not.include(root);
  });

  // SAP Easy Access prints this where SAP GUI prints the session number
  // (src/webgui/), so it has to be the process that answers rather than any
  // process: the one the façade posts the snapshot to, found by the port of
  // the address it posts to
  it("names the work process the snapshot is posted to, and this process when there is no child", async () => {
    const two = pool(2);
    const s = await take({runtime: {...two, url: "http://127.0.0.1:38811/"}});
    expect(s.system.pid).to.equal(90002);
    // inline (a test, the binary, the preview): the façade holds the ABAP
    const inline = await take({runtime: undefined});
    expect(inline.system.pid).to.equal(process.pid);
  });

  it("says so when the generation built is not the generation serving", async () => {
    const s = await take({runtime: {...pool(1), generation: "gen-old"}});
    expect(s.system.gen_live).to.equal("gen-live");
    expect(s.system.gen_serving).to.equal("gen-old");
    expect(s.system.synced).to.equal(false);
  });

  it("has a row per work process, plus the facade itself", async () => {
    const s = await take();
    expect(s.processes.map((p) => p.role)).to.deep.equal(["facade", "work", "work"]);
    expect(s.processes[0].pid).to.equal(process.pid);
    expect(s.processes[0].port).to.equal(3060);
    expect(s.processes[0].rss_mb).to.equal(120);
    expect(s.processes[1]).to.include({pid: 90001, role: "work", port: 38810, generation: "gen-live", epoch: 1, alive: true});
    // the registry knows when that child came up; the facade's own start is the fallback
    expect(s.processes[1].since).to.equal("2026-09-17T09:00:01.000Z");
    expect(s.processes[2].since).to.equal("2026-09-17T09:00:00.000Z");
    for (const one of s.processes) {
      expect(one.sockets).to.be.a("number");
      expect(one.rss_mb).to.be.a("number");
    }
  });

  it("reports a runtime that has not started as no process at all", async () => {
    const s = await take({runtime: {generation: "", runtimes: [{port: undefined, epoch: 0, running: false}]}});
    expect(s.processes).to.have.length(1);
    expect(s.processes[0].role).to.equal("facade");
  });

  it("carries the listeners it was given, and reports inactive built-in RFC and DIAG", async () => {
    const s = await take();
    const byPort = new Map(s.ports.map((p) => [p.port, p]));
    expect(byPort.get(3060).protocol).to.equal("HTTP");
    expect(byPort.get(44360).protocol).to.equal("HTTPS");
    // the instance is the listener's number, the way the TLS port is
    expect(byPort.get(3360).protocol).to.equal("RFC");
    expect(byPort.get(3260).protocol).to.equal("DIAG");
    expect(byPort.get(3360).state).to.equal("absent");
    expect(byPort.get(3360).note).to.include("built-in JS");
    expect(byPort.get(3260).note).to.include("built-in JS");
    expect(s.ports.map((p) => p.port)).to.deep.equal([...s.ports.map((p) => p.port)].sort((a, b) => a - b));
  });

  it("uses the configured Docker instance for the DIAG and RFC rows", async () => {
    const s = await take({env: {INSTANCE: "11"}});
    expect(s.ports.find((p) => p.port === 3211)?.protocol).to.equal("DIAG");
    expect(s.ports.find((p) => p.port === 3311)?.protocol).to.equal("RFC");
    expect(s.ports.find((p) => p.port === 3230)).to.equal(undefined);
  });

  it("reports explicitly overridden built-in protocol ports", async () => {
    const s = await take({env: {INSTANCE: "11", STG_DIAG_PORT: "41232", STG_RFC_PORT: "41233"}});
    expect(s.ports.find((p) => p.port === 41232)?.protocol).to.equal("DIAG");
    expect(s.ports.find((p) => p.port === 41233)?.protocol).to.equal("RFC");
    expect(s.ports.find((p) => p.port === 3211)).to.equal(undefined);
    expect(s.ports.find((p) => p.port === 3311)).to.equal(undefined);
  });

  it("distinguishes container OS, optional host OS and Raspberry Pi model without leaking paths", async () => {
    const files = new Map([
      ["/etc/os-release", 'NAME="Debian GNU/Linux"\nVERSION_ID="12"\nVERSION_CODENAME=bookworm\n'],
      ["/run/host/os-release", 'NAME="Debian GNU/Linux"\nVERSION_ID="13"\nVERSION_CODENAME=trixie\n'],
      ["/run/host/device-model", "Raspberry Pi 4 Model B Rev 1.5\0"],
    ]);
    const facts = platformFacts({read: (path) => {
      if (!files.has(path)) throw new Error("not mounted");
      return files.get(path);
    }, platform: "linux", arch: "arm64", kernel: "6.12.1+rpt-rpi-v8"});
    expect(facts.map(({name, value}) => [name, value])).to.deep.equal([
      ["Architecture", "linux/arm64"], ["Kernel", "6.12.1+rpt-rpi-v8"],
      ["Runtime OS", "Debian GNU/Linux 12 (bookworm)"],
      ["Host OS", "Debian GNU/Linux 13 (trixie)"],
      ["Device", "Raspberry Pi 4 Model B Rev 1.5"],
    ]);
    // Engine and Storage, then the two AMDP rows (tools/amdp-status.mjs), then the platform
    const database = (await take({platform: facts})).database;
    expect(database.slice(2, 4).map((row) => row.section)).to.deep.equal(["AMDP", "AMDP"]);
    expect(database.slice(4)).to.deep.equal(facts);
    expect(JSON.stringify(facts)).not.to.include("/run/host");
    expect(platformFacts({read: () => { throw new Error("absent"); }, platform: "linux", arch: "arm64", kernel: "6.12"})
      .map((fact) => fact.name)).to.deep.equal(["Architecture", "Kernel"]);
  });

  it("lists the OData, ICF and APC services, each with the pack it came from", async () => {
    const found = servicesOf(root, {});
    expect(found).to.deep.include({path: "/sap/opu/odata/sap/ZDEMO_SRV", kind: "ODATA", handler: "ZCL_ZDEMO_DPC_EXT", text: "a demo", pack: ""});
    expect(found).to.deep.include({path: "/sap/bc/zsrv", kind: "ICF", handler: "ZCL_SRV_HANDLER", text: "", pack: ""});
    expect(found).to.deep.include({path: "/sap/bc/zvibes", kind: "ICF", handler: "ZCL_VIBES", text: "", pack: "vibes"});
    expect(found).to.deep.include({path: "/sap/bc/apc/sap/zchan", kind: "APC", handler: "ZCL_CHAN", text: "", pack: ""});
  });

  it("keeps a base registration visible when its handler is overridden by a workspace pack", () => {
    write("src/zcl_zdemo_dpc_ext.clas.abap", "CLASS zcl_zdemo_dpc_ext DEFINITION PUBLIC CREATE PUBLIC. ENDCLASS.");
    write("packs/workspace/osd-pack.json", JSON.stringify({name: "workspace-pack"}));
    write("packs/workspace/src/zcl_zdemo_dpc_ext.clas.abap", "CLASS zcl_zdemo_dpc_ext DEFINITION PUBLIC CREATE PUBLIC. ENDCLASS.");
    const service = servicesOf(root, {}).find((row) => row.kind === "ODATA" && row.path.endsWith("/ZDEMO_SRV"));
    expect(service.pack).to.equal("workspace-pack");
    expect(groupServices([service], "layer", "name", true).flatMap((group) => group.groups.flatMap((kind) => kind.rows)))
      .to.deep.equal([service]);
  });

  it("lists one OData endpoint when two registration files declare the same external service", () => {
    write("gen/second.iwsv.xml",
      "<abapGit><_-IWBEP_-I_MGW_SRG><MODEL_TECH_NAME>ZDEMO_MDL</MODEL_TECH_NAME><MODEL_VERSION>0001</MODEL_VERSION></_-IWBEP_-I_MGW_SRG>" +
      "<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>ZDEMO_SRV</TECHNICAL_NAME><VERSION>0001</VERSION>" +
      "<EXTERNAL_NAME>ZDEMO_SRV</EXTERNAL_NAME><CLASS_NAME>ZCL_NEW_DPC_EXT</CLASS_NAME></_-IWBEP_-I_MGW_SRH></abapGit>");
    const found = servicesOf(root, {}).filter((row) => row.kind === "ODATA" && row.path.endsWith("/ZDEMO_SRV"));
    expect(found).to.have.length(1);
    expect(found[0].handler).to.equal("ZCL_NEW_DPC_EXT");
  });

  it("chooses the later layer for an endpoint even when its technical name sorts first", () => {
    const registration = (technical, handler) =>
      `<abapGit><_-IWBEP_-I_MGW_SRG><MODEL_TECH_NAME>ZDEMO_MDL</MODEL_TECH_NAME><MODEL_VERSION>0001</MODEL_VERSION></_-IWBEP_-I_MGW_SRG>` +
      `<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>${technical}</TECHNICAL_NAME><VERSION>0001</VERSION>` +
      `<EXTERNAL_NAME>ZSHARED_SRV</EXTERNAL_NAME><CLASS_NAME>${handler}</CLASS_NAME></_-IWBEP_-I_MGW_SRH></abapGit>`;
    write("src/zzz_base.iwsv.xml", registration("ZZZ_BASE", "ZCL_BASE_DPC"));
    write("gen/aaa_override.iwsv.xml", registration("AAA_OVERRIDE", "ZCL_OVERRIDE_DPC"));
    const found = servicesOf(root, {}).filter((row) => row.kind === "ODATA" && row.path.endsWith("/ZSHARED_SRV"));
    expect(found).to.have.length(1);
    expect(found[0].handler).to.equal("ZCL_OVERRIDE_DPC");
  });

  it("keeps the registered src handler when a later endpoint has a missing model", () => {
    const registration = (technical, model, handler) =>
      `<abapGit><_-IWBEP_-I_MGW_SRG><MODEL_TECH_NAME>${model}</MODEL_TECH_NAME><MODEL_VERSION>0001</MODEL_VERSION></_-IWBEP_-I_MGW_SRG>` +
      `<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>${technical}</TECHNICAL_NAME><VERSION>0001</VERSION>` +
      `<EXTERNAL_NAME>ZSHARED_SRV</EXTERNAL_NAME><CLASS_NAME>${handler}</CLASS_NAME></_-IWBEP_-I_MGW_SRH></abapGit>`;
    write("src/good.iwsv.xml", registration("ZGOOD", "ZDEMO_MDL", "ZCL_GOOD_DPC"));
    write("gen/bad.iwsv.xml", registration("ZBAD", "ZMISSING_MDL", "ZCL_BAD_DPC"));
    const entries = segwRegistrations([join(root, "src"), join(root, "gen")]);
    const registry = registryClass(entries);
    expect(registry).to.contain("iv_service = 'ZSHARED_SRV'");
    expect(registry).to.contain("iv_dpc     = 'ZCL_GOOD_DPC'");
    expect(registry).not.to.contain("iv_dpc     = 'ZCL_BAD_DPC'");
    const found = serviceTree(root, {}).filter((row) => row.kind === "ODATA" && row.name === "ZSHARED_SRV");
    expect(found).to.have.length(1);
    expect(found[0]).to.include({handler: "ZCL_GOOD_DPC", mpc: "ZCL_ZDEMO_MPC_EXT", source: "src/good.iwsv.xml"});
  });

  // The UI5 apps of the tree come out of their own manifests, so the menu
  // and the status app read one list: `sap.app.id` is the component that
  // answers, `title` is what it is called, and the path is the launchpad
  // with the app's own inbound intent, because that is where the launchpad
  // opens it (webapp/booking has no page of its own at all).
  it("lists a UI5 app by its manifest, at the intent the launchpad opens it with", async () => {
    write("webapp/manifest.json", JSON.stringify({"sap.app": {
      id: "stg.travel", title: "Travels",
      crossNavigation: {inbounds: {"Travel-manage": {semanticObject: "Travel", action: "manage"}}},
    }}));
    write("webapp/booking/manifest.json", JSON.stringify({"sap.app": {
      id: "stg.booking", title: "Bookings",
      crossNavigation: {inbounds: {"Booking-display": {semanticObject: "Booking", action: "display"}}},
    }}));
    write("webapp/nothing/index.html", "<html></html>");
    const found = servicesOf(root, {});
    expect(found).to.deep.include({path: "/app/flp.html#Travel-manage", kind: "APP", handler: "stg.travel", text: "Travels", pack: ""});
    expect(found).to.deep.include({path: "/app/flp.html#Booking-display", kind: "APP", handler: "stg.booking", text: "Bookings", pack: ""});
    // a folder with no manifest in it is not an app
    expect(found.filter((one) => one.kind === "APP")).to.have.length(2);
  });

  it("counts the objects a pack owns", async () => {
    const packs = packsInfo(root, {});
    expect(packs).to.deep.equal([{
      name: "vibes",
      order: 60,
      objects: 2,
      folders: "packs/vibes/src",
      description: "the worked example",
    }]);
  });

  it("is JSON the ABAP side can parse: every value a string, a number or a boolean", async () => {
    const s = await take();
    const flat = (row) => {
      for (const value of Object.values(row)) {
        expect(["string", "number", "boolean"]).to.include(typeof value);
      }
    };
    flat(s.system);
    for (const key of ["processes", "ports", "services", "packs", "database"]) {
      expect(s[key]).to.be.an("array");
      s[key].forEach(flat);
    }
    expect(s.database).to.deep.equal([
      {section: "Database", name: "Engine", value: "sqlite", note: "configured backend; connection not observed"},
      {section: "Database", name: "Storage", value: "file", note: "persistent database storage"},
      // the pool's work processes do not answer /osd/serving here, so where
      // an AMDP body runs is not known -- and is said so, not guessed
      {section: "AMDP", name: "pAMDP portable engine", value: "not known",
        note: "the work process holding the AMDP destination did not answer; nothing is guessed"},
      {section: "AMDP", name: "eAMDP HANA destination", value: "not known",
        note: "the work process holding the AMDP destination did not answer; nothing is guessed"},
    ]);
    expect(Object.keys(s)).to.deep.equal(["system", "processes", "ports", "services", "packs", "database", "amdp"]);
    expect(s.amdp).to.deep.equal({db: "unknown", driver: false, configured: false, session: "none", methods: [], unknown: true});
    expect(Object.keys(s.processes[0])).to.deep.equal(["pid", "role", "port", "generation", "epoch", "since", "sockets", "rss_mb", "alive"]);
    expect(Object.keys(s.ports[0])).to.deep.equal(["port", "protocol", "purpose", "state", "note"]);
    expect(Object.keys(s.packs[0])).to.deep.equal(["name", "order", "objects", "folders", "description"]);
  });

  it("reports facts from a connected client without exposing its path", () => {
    const facts = databaseFacts({client: {name: "duckdb", path: "/private/stack/osd.duckdb", connected: true}, env: {STG_DB: "file"}});
    expect(facts).to.deep.equal([
      {section: "Database", name: "Engine", value: "duckdb", note: "connected backend"},
      {section: "Database", name: "Storage", value: "file", note: "persistent database storage"},
    ]);
    expect(JSON.stringify(facts)).to.not.include("private");
  });

  it("does not reflect an unknown backend label", () => {
    for (const name of ["constructor", "__proto__", "toString"]) {
      expect(databaseFacts({client: null, env: {STG_DB: name}})[0].value).to.equal("unknown");
    }
    const facts = databaseFacts({client: null, env: {STG_DB: "password-looking-value"}});
    expect(facts[0].value).to.equal("unknown");
    expect(JSON.stringify(facts)).to.not.include("password-looking-value");
  });

  it("marks configuration unobserved when the child has not started", async () => {
    const state = await take({runtime: {generation: "abc"}, env: {STG_DB: "hana"}});
    expect(state.database[0]).to.include({value: "HDB", note: "configured backend; connection not observed"});
  });

  it("does not replace a pathless SQLite client's facts with file configuration", () => {
    const facts = databaseFacts({client: {name: "sqlite", connected: true}, env: {STG_DB: "file", STG_DB_PATH: "/private/not-used.sqlite"}});
    expect(facts[1].value).to.equal("memory");
  });

  it("counts sockets rather than naming peers", () => {
    const rows = [
      {port: 3060, state: "01"}, {port: 3060, state: "01"}, {port: 3060, state: "0A"}, {port: 3061, state: "01"},
    ];
    expect(socketsOn(3060, rows)).to.equal(2);
    expect(socketsOn(3062, rows)).to.equal(0);
  });

  it("knows which host it is running on", () => {
    expect(["node", "bun", "sea"]).to.include(hostKind());
  });

  it("keeps a listener it was given even when nothing is listening on it", async () => {
    const ports = await portsOf([{port: 65533, protocol: "HTTP", purpose: "a port nobody opened"}], {instance: 33});
    const one = ports.find((p) => p.port === 65533);
    expect(one.state).to.equal("absent");
    expect(one.purpose).to.equal("a port nobody opened");
  });
});
