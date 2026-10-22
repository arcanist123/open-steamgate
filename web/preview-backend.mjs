// open-steamgate running in the browser.
//
// test/start.mjs wires the transpiled runtime into express: initializeABAP()
// opens the database (test/setup.mjs), registers the demo services and every
// request under /sap/opu/odata/sap/ goes through CL_EXPRESS_ICF_SHIM into
// ZCL_STG_HTTP_HANDLER. This module does the same with the service worker in
// the role of express and sql.js compiled to JavaScript in the role of the
// database file. The pattern is larshp/hithub's web/preview-backend.mjs (MIT).
import {previewAdtAnswer} from "./preview-continuations.mjs";
import {dialogStep, exclusive} from "../tools/osd-dialog-step.mjs";
import {apcMailbox} from "../tools/osd-apc-mailbox.mjs";
import {ensureDemoData} from "../tools/osd-demo-data.mjs";
import {realNow} from "./preview-runtime.mjs";
import {Buffer} from "buffer";
import {seed, buildId as builtId, database as builtDatabase, demoRows} from "./generated/seed.mjs";
import {odata as odataServices, packs as packRows, sid as SID} from "./generated/status.mjs";
import {registry as icfRegistry} from "./generated/icf.mjs";
import {xref} from "./generated/xref.mjs";
import {previewFields} from "./generated/preview-fields.mjs";
import {applyRows as applyXref} from "../tools/osd-xref-seed.mjs";
import {servicesFromRows, serviceForPath} from "../tools/osd-icf-routing.mjs";
import {currentRows} from "../tools/osd-icf-apply.mjs";
import {readRequest} from "./preview-runtime.mjs";

// test/setup.mjs looks for this before it touches the file system: the seed
// rows come from the bundle, the database from cache storage (or fresh).
// `env` is the only environment the browser has: the build wrote the system
// id into the bundle (scripts/build-preview.mjs), and test/setup.mjs sets
// sy-sysid / sy-mandt / sy-uname from it through tools/osd-identity.mjs, so
// the ABAP in a service worker knows which system it is exactly as the ABAP
// in a work process does (backlog G.1b).
// A host may choose the engine at run time instead of at build time: the VS
// Code web extension (editors/vscode/web/extension.mjs) carries one bundle and
// a setting, and says which before this module is imported, together with
// where the DuckDB-Wasm binary is, since a worker of the extension host is not
// beside it. The build id follows the engine, as it does in the build.
const host = globalThis.__stgPreviewHost ?? {};
const database = host.database ?? builtDatabase;
if (!["sql.js", "duckdb"].includes(database)) throw new Error(`preview database must be sql.js or duckdb, got ${database}`);
const place = host.place ?? "the service worker";
const buildId = database === builtDatabase ? builtId : `${builtId}-${database}`;
const preview = {seed, buildId, database, wasmURL: host.wasmURL, stored: undefined, db: undefined, env: {OSD_SID: SID, OSD_DEMO_ROWS: demoRows}};
globalThis.__stgPreview = preview;

const {initializeABAP} = await import("../output/init.mjs");
const {cl_express_icf_shim} = await import("../output/cl_express_icf_shim.clas.mjs");
const {services, channels} = await import("./generated/services.mjs");

// SMW0 without a disk.
//
// WWWDATA_IMPORT reads the bytes from the file beside the transpiled module,
// which is right on a checkout and impossible here: there is no fs in a
// service worker, so every page that shows a picture or plays a sound got a
// 500 from a runtime that was otherwise working. open-abap-core lets a host
// answer instead — abap.W3MI_LOADER(objid, filename) hands back the content
// as upper-case hex, which is how an xstring travels through that function.
//
// The files sit beside the bundle under media/ rather than inside sw.js, so
// a page pays for the audio only if it plays it.
const HEX = Array.from({length: 256}, (_, byte) => byte.toString(16).padStart(2, "0").toUpperCase());
const loaded = new Map();

// WRITE has nowhere to go in a service worker. The runtime's default console
// writes to process.stdout, which the browser polyfill of process does not
// have, so the first WRITE threw "Cannot read properties of undefined
// (reading 'write')" inside the APC handler and the channel closed with
// 1011: the demo's send_frame writes a debug line per frame, and the demo
// said "Disconnected" the moment it started while Zork, which never
// writes, played on (Alice, 2026-09-17). A console that keeps the tail of
// what was written, so a WRITE costs nothing and SKIP, which reads the
// console back, still works.
class TailConsole {
  #data = "";
  add(data) {
    this.#data = (this.#data + data).slice(-8192);
  }
  get() {
    return this.#data;
  }
  isEmpty() {
    return this.#data === "";
  }
  clear() {
    this.#data = "";
  }
  getTrimmed() {
    return this.#data.split("\n").map((a) => a.trimEnd()).join("\n");
  }
}
globalThis.abap.console = new TailConsole();
globalThis.abap.context.console = globalThis.abap.console;

globalThis.abap.W3MI_LOADER = async (objid, filename) => {
  const already = loaded.get(filename);
  if (already !== undefined) {
    return already;
  }
  // the per cent in an abapGit media name (zork-mini%2ez3.w3mi.data.z3) is a
  // character of the name, not an escape, so it has to reach the host as %25
  // or the file asked for is a different one
  const url = new URL(`media/${encodeURIComponent(filename)}`, self.location.href);
  const response = await fetch(url, {cache: "force-cache"});
  if (response.ok === false) {
    throw new Error(`W3MI ${objid}: ${filename} is ${response.status} here`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // in slices: four megabytes of audio is eight million hex digits, and
  // growing one string by two characters eight million times is the quadratic
  // shape that made this take minutes on the Node side
  const parts = [];
  for (let at = 0; at < bytes.length; at += 8192) {
    let part = "";
    for (const byte of bytes.subarray(at, at + 8192)) {
      part += HEX[byte];
    }
    parts.push(part);
  }
  const hex = parts.join("");
  loaded.set(filename, hex);
  return hex;
};

// which service answers a path: the longest prefix that matches, so a service
// mounted below another is found before its parent. Nothing here knows what
// any of them do.
const odataFront = services.filter((s) => s.path === "/sap/opu/odata/sap")
  .map((s) => ({...s, type: "ABAP"}));
let registryServices = [];
function serviceFor(path) {
  return serviceForPath([...registryServices, ...odataFront], path);
}
const {zcl_osd_status} = await import("../output/zcl_osd_status.clas.mjs");
const {zcl_stg_segw_registry} = await import("../output/zcl_stg_segw_registry.clas.mjs");
const {zcl_stg_shlp_registry} = await import("../output/zcl_stg_shlp_registry.clas.mjs");
const {zcl_osd_demo_data} = await import("../output/zcl_osd_demo_data.clas.mjs");

// CL_EXPRESS_ICF_SHIM keeps request and response on one static server object;
// overlapping fetch events would answer each other's requests. Serialize.
let queue = Promise.resolve();

function serialized(work) {
  const result = queue.then(work, work);
  queue = result.then(() => undefined, () => undefined);
  return result;
}

function toBytes(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  return new TextEncoder().encode(String(value ?? ""));
}

async function registerServices() {
  // generated from the IWSV/IWMO objects by tools/segw-registry.mjs
  await zcl_stg_segw_registry.register();
  // the search help objects, generated by tools/segw-shlp.mjs
  await zcl_stg_shlp_registry.register();
}

async function invoke({method, path, search = "", headers = {}, body}) {
  const responseHeaders = new Headers();
  let status = 200;
  let data = new Uint8Array(0);
  const res = {
    append(name, value) {
      responseHeaders.append(name, value);
    },
    status(code) {
      status = Number(code);
      return res;
    },
    send(payload) {
      data = toBytes(payload);
    },
  };
  const service = serviceFor(path);
  if (service === undefined) return {status: 404, headers: responseHeaders, body: data};
  // The service worker shares this entry. Host continuations still answer
  // today's 500 for every kind; see preview-continuations.mjs for the stub.
  if (String(service.handler).toUpperCase() === "ZCL_OSD_ADT_HANDLER") {
    return dialogStep(() => previewAdtAnswer(abap.Classes.ZCL_OSD_ADT_HANDLER,
      {method, path, search, headers, body}), "preview ADT");
  }
  // a read of the status service takes the snapshot that answers it, which is
  // what keeps snap_at honest; it costs a few object reads and nothing else
  // pays for it
  if (STATUS_SERVICE.test(path)) {
    await refreshStatus();
  }
  // the kernel's end of a dialog step, the same one the served hosts use:
  // commit when the work is done, roll back when it ends in an exception
  // nobody declared. There is no process to recycle here, so a request that
  // dumped used to leave its rows pending for the next write to adopt
  // (tools/osd-dialog-step.mjs)
  await dialogStep(() => cl_express_icf_shim.run({
    req: {
      body: Buffer.from(body ?? new Uint8Array(0)),
      headers,
      method: String(method || "GET").toUpperCase(),
      path,
      url: `${path}${search}`,
    },
    res,
    class: service.handler,
    base: new abap.types.String().set(service.path),
  }));
  return {status, headers: responseHeaders, body: data};
}

// A push channel, driven where the runtime already is.
//
// The page has a WebSocket-shaped object (web/preview-socket.mjs) and no
// runtime; this end has the runtime and no socket. One zcl_apc_host per
// conversation, because a stateful handler is one object per connection,
// and the messages it pushed come back through drain( ) after every
// callback — on_start is allowed to speak first and usually does.
const hosts = new Map();

// Each APC event is a dialog step (tools/osd-dialog-step.mjs): it waits for
// the one work process, commits when done, rolls back when it dumps.
export async function openChannel(id, channel, send) {
  const mailbox = apcMailbox();
  const entry = {mailbox};
  hosts.set(id, entry);
  return mailbox.enqueue(async () => {
    const {zcl_apc_host} = await import("../output/zcl_apc_host.clas.mjs");
    const host = new zcl_apc_host();
    entry.host = host;
    const drain = async () => {
      const pushed = await host.drain();
      for (const row of pushed.array()) {
        if (mailbox.closed) return;
        send({apc: "message", text: row.get()});
      }
    };
    const accepted = await dialogStep(async () => {
      await host.constructor_({
        iv_handler: new abap.types.String().set(channel.handler),
        it_fields: zcl_apc_host.METHODS.CONSTRUCTOR.parameters.IT_FIELDS.type(),
      });
      return host.open();
    });
    if (accepted.get() !== "X") {
      throw new Error("the handler refused the connection");
    }
    entry.drain = drain;
    if (mailbox.closed) return;
    // open first, then whatever on_start pushed.
    //
    // The other order looks harmless and is not: a handler that speaks first —
    // and a stateful one usually does — delivers a message while the page's
    // socket is still CONNECTING, so the page's onmessage runs before its
    // onopen and any send( ) from it is refused as "the socket is not open".
    // The page is right and the ordering was wrong.
    send({apc: "open"});
    await dialogStep(drain);
  }).catch(error => {
    hosts.delete(id);
    throw error;
  });
}

export async function channelMessage(id, text, send) {
  const entry = hosts.get(id);
  if (entry === undefined) {
    throw new Error(`no channel ${id}`);
  }
  await entry.mailbox.enqueue(() => dialogStep(async () => {
    if (entry.mailbox.closed) return;
    await entry.host.message({iv_text: new abap.types.String().set(text)});
    await entry.drain();
  }));
  void send;
}

export async function closeChannel(id) {
  const entry = hosts.get(id);
  hosts.delete(id);
  if (entry !== undefined) {
    await entry.mailbox.closeTurn(() => dialogStep(() => entry.host?.close({
      iv_reason: new abap.types.String().set("closed by the page"),
      iv_code: new abap.types.Integer().set(1000),
    })));
  }
}

// What this deployment is, said by the thing that is answering.
//
// On a server the facade takes the snapshot, because it is the only process
// that can see the pool, the listeners and /proc (tools/osd-status.mjs).
// Here there is no pool, no listener and no process: there is one service
// worker, and the honest snapshot is small. So it is written rather than
// faked -- host_kind "browser", one row in the process table with no pid and
// no port, one port row that says there is no port and why -- and the parts
// the worker cannot see are the build's, generated into ./generated/status.mjs
// (the OData services, the packs, the system id). The JSON is the same
// contract ZCL_OSD_STATUS=>REFRESH parses on a server; nothing about the
// shape is special here, only the values.
//
// The generation is the worker's own stamp, the digest the build wrote into
// the bundle, so gen_live and gen_serving are the same by construction: a
// bundle cannot be serving anything but itself.
// The two readers of the five status tables: the status service itself, and
// the Easy Access menu, which builds its tree out of the same rows
// (src/webgui/, docs/webgui.md). Both take the snapshot that answers them.
const STATUS_SERVICE = /^(\/sap\/opu\/odata\/sap\/ZOSD_STATUS_SRV|\/sap\/bc\/gui\/sap\/its\/webgui)(\/|$)/i;
// the real clock, not the pinned one the rest of the bundle sees
const bootedAt = realNow();
// the worker fills these in when it starts the backend; the fallbacks are for
// a host that does not (a test importing this module directly)
let identity = {stamp: buildId, rootHint: "preview", mount: ""};

function statusSnapshot() {
  const since = bootedAt.toISOString();
  // every path a person can click is written from outside this system's
  // root, because in the browser preview that root is not the origin's
  const outside = (path) => (path.startsWith("/") ? `${identity.mount}${path}` : path);
  const rows = [
    ...services.map((s) => ({path: outside(s.path), kind: "ICF", handler: s.handler ?? "", text: s.text ?? "", pack: s.pack ?? ""})),
    ...channels.map((c) => ({path: outside(c.path), kind: "APC", handler: c.handler ?? "", text: c.text ?? "", pack: c.pack ?? ""})),
    ...odataServices.map((o) => ({...o, path: outside(o.path)})),
  ].sort((a, b) => a.path.localeCompare(b.path));
  return {
    system: {
      sid: SID,
      host_kind: "browser",
      gen_live: identity.stamp,
      gen_serving: identity.stamp,
      synced: true,
      workers: 1,
      started_at: since,
      snap_at: realNow().toISOString(),
      root_hint: identity.rootHint,
      // no pid: a service worker is not a process anybody can number, so the
      // screen prints the system without one rather than printing a zero
      // that looks like a session (src/webgui/)
      pid: 0,
    },
    // one row, and the two columns it cannot fill are left empty rather than
    // invented: a service worker has no pid and no port, and nothing in a
    // worker can read its own resident size. The sockets are the push
    // channels open right now, which is a count this end does know.
    processes: [{
      pid: 0,
      role: "worker",
      port: 0,
      generation: identity.stamp,
      epoch: 0,
      since,
      sockets: hosts.size,
      rss_mb: 0,
      alive: true,
    }],
    // One row saying there is none, not an empty table. "No ports" and "the
    // snapshot forgot to look" are the same picture when the section is
    // empty, and this deployment has a real answer: the requests arrive
    // through the fetch handler, so there is nothing listening anywhere.
    // The port column is 0 because it is the key, and 0 is the only number
    // here that is not a guess.
    ports: [{
      port: 0,
      protocol: "HTTP",
      purpose: "OData, apps and channels, intercepted",
      state: "absent",
      note: "a service worker has no socket: requests are intercepted in the browser",
    }],
    services: rows,
    packs: packRows,
    database: [
      {section: "Platform", name: "Architecture", value: "browser", note: "service worker; device details not collected"},
      {section: "Database", name: "Engine", value: database === "duckdb" ? "duckdb" : "sql.js",
        note: database === "duckdb" ? `DuckDB-Wasm in ${place}` : "browser SQLite-compatible backend"},
      {section: "Database", name: "Storage", value: "memory",
        note: database === "duckdb" ? `volatile; reseeded when ${place} restarts` : "service-worker database; rebuilt with the preview"},
    ],
  };
}

// Into the five tables, through the same door the facade uses. A refresh that
// fails never fails the read it was taken for: the rows from the last one are
// still there, and a status page a few seconds stale beats a 500.
async function refreshStatus() {
  try {
    await zcl_osd_status.refresh({iv_json: JSON.stringify(statusSnapshot())});
  } catch (error) {
    console.error(`status refresh: ${error?.message?.get?.() ?? error?.message ?? error}`);
  }
}

export async function startBackend(stored, options = {}) {
  preview.stored = stored;
  identity = {
    stamp: String(options.stamp ?? buildId),
    // the deployment's own directory (main, pr-7), which is all of the
    // location this may say; never a path from anybody's disk
    rootHint: String(options.mount ?? "").split("/").filter((p) => p !== "").pop() ?? "preview",
    // **Where this system sits on the origin, because here it is not the
    // root.** On a server `/app/flp.html` is a working address; on GitHub
    // Pages the deployment lives under /open-steamgate/main/ and the same
    // string sends a browser to oisee.github.io/app/flp.html, which is not
    // a page. Alice clicked one and got GitHub's 404.
    //
    // The status rows are a snapshot regenerated on every read, so an
    // outside-view address in them costs nothing and is not carried
    // anywhere: this is the same correction `x-forwarded-prefix` already
    // makes to the absolute URLs the OData front writes, applied to the
    // one kind of address that is data rather than a header.
    mount: String(options.mount ?? "").replace(/\/$/, ""),
  };
  await initializeABAP();
  // **The ICF registry, from rows the build computed.** On a server
  // `applyAtStartup` reads the `*.sicf.xml` objects off disk; a service
  // worker has no disk, so nothing was applied here and the screen at
  // /sap/bc/osd/sicf/ published "0 nodes" about a system serving eighteen
  // paths. The rows are data, so the build writes them into the bundle
  // (scripts/build-preview.mjs) and this applies them by the same rule --
  // an inventory that contradicts what it inventories is worse than none.
  const {applyTo} = await import("../tools/osd-icf-apply.mjs");
  await applyTo(abap.context.databaseConnections.DEFAULT, icfRegistry, {say: console.log});
  registryServices = servicesFromRows(await currentRows(abap.context.databaseConnections.DEFAULT));
  // the cross-reference the build derived from the files, applied by the
  // module every host uses (tools/osd-xref-seed.mjs); replaces, so a stored
  // database from an older build ends with this build's rows
  await applyXref(abap.context.databaseConnections.DEFAULT, xref);
  await registerServices();
  // the synthetic taxi facts, made by ZCL_OSD_DEMO_DATA (tools/osd-demo-data.mjs)
  await ensureDemoData(zcl_osd_demo_data, {env: preview.env});
  await refreshStatus();
}

// serialized() around the step as well as the step's own lock: a WAIT in
// an HTTP step gives the work process to an APC event, never to the next
// request, which waits here for the shim's static server
export function handleRequest(request) {
  return serialized(async () => await readRequest(abap.context.databaseConnections.DEFAULT, request, previewFields) ?? invoke(request));
}

// Back to the seeded state: the transpiled runtime is kept, only the database
// is rebuilt through the same setup that opened it.
export function resetBackend() {
  return serialized(async () => {
    // the connection is replaced: no step (an APC event) may be half-way
    // through it. The demo data below is a dialog step of its own and takes
    // the work process itself, so it comes after, as it does at start
    await exclusive(async () => {
      if (preview.database === "duckdb") await preview.db?.disconnect();
      preview.stored = undefined;
      const setup = await import("../test/setup.mjs");
      await setup.setup(globalThis.abap, preview.schemas, preview.insert);
      const {applyTo} = await import("../tools/osd-icf-apply.mjs");
      await applyTo(abap.context.databaseConnections.DEFAULT, icfRegistry);
      registryServices = servicesFromRows(await currentRows(abap.context.databaseConnections.DEFAULT));
      await applyXref(abap.context.databaseConnections.DEFAULT, xref);
    });
    // and so did the synthetic taxi facts
    await ensureDemoData(zcl_osd_demo_data, {env: preview.env});
    // the status tables went with the database; fill them again rather than
    // leaving the app empty until somebody opens it
    await refreshStatus();
  });
}

export function exportDatabase() {
  return serialized(() => exclusive(() => preview.database === "duckdb" ? undefined : preview.db.export()));
}

export {buildId, database};
