// The read-only host's two safety nets (milestone 4), for tools/hana-serve.mjs:
//
//   1. Outbound calls are refused. A service delivered by somebody else runs
//      in this process, and nothing it does may reach another machine. The
//      seam is the lowest one the host controls: Node's own socket, DNS,
//      process and worker entry points, patched in this process before the
//      generation loads (installOutboundGuard). Whatever the ABAP or a library
//      under it uses -- the class library's HTTP client (`https.request`),
//      `fetch`, a WebSocket, http2, a raw `net`/`tls` socket, UDP, a child
//      process -- ends in one of them, and every one refuses. Above it, the
//      class library's HTTP client is wrapped (installHttpClientGuard) so the
//      refusal surfaces the way a real system says it: the classic exception
//      HTTP_COMMUNICATION_FAILURE out of SEND, GET_LAST_ERROR naming why, and
//      CREATE_BY_DESTINATION answering a client instead of the library's
//      todo-assert. The only connections left are the database's own: what
//      the host's database client opens inside `asOwnDatabase` (its connect)
//      and later reconnects to that same endpoint. An HTTP client's send is
//      refused even toward that endpoint.
//
//   2. Stub raises are traced. A method the closure stubbed raises
//      ZCX_OSD_NOT_ACTIVATED, whose constructor calls
//      globalThis.osdNotActivated before any CATCH can see the exception
//      (src/hana/zcx_osd_not_activated.clas.abap); a stubbed class
//      constructor calls the same hook from its load. installStubHook puts
//      the hook in, naming the class and method off the stack.
//
// Both land in one per-request record (createHostRecord): {stubs, refused},
// kept through AsyncLocalStorage so a provider that swallows the exception
// and answers 200 still leaves its trace. The record goes to a private
// JSON-lines file (--stub-trace), never into a response; without the option
// each event is still one line on stderr and nothing is kept.
import {AsyncLocalStorage} from "node:async_hooks";
import {appendFileSync, mkdirSync, openSync, closeSync} from "node:fs";
import {createRequire, syncBuiltinESMExports} from "node:module";
import {dirname} from "node:path";

const require = createRequire(import.meta.url);

export const REFUSED_CODE = "OSD_OUTBOUND_REFUSED";
export const PROBE_REASON = "OSD_STUB_TRACE_PROBE";

// ------------------------------------------------------------ the record ----

/** The per-request record and the trace file. `file` undefined: nothing is
 *  kept, each event is said on stderr only (`log`). */
export function createHostRecord({file, log = (line) => console.error(line)} = {}) {
  const store = new AsyncLocalStorage();
  const boot = {stubs: [], refused: []};
  let booting = true;
  if (file !== undefined) {
    mkdirSync(dirname(file), {recursive: true});
    // this run's requests only, readable by its owner only: it names the
    // classes and the addresses a delivered service tried
    closeSync(openSync(file, "w", 0o600));
  }
  const write = (entry) => {
    if (file !== undefined) appendFileSync(file, JSON.stringify(entry) + "\n");
  };
  const target = () => store.getStore()?.record ?? (booting ? boot : undefined);
  return {
    file,
    tracing: file !== undefined,
    /** one event: `kind` is "stubs" or "refused" */
    note(kind, entry) {
      const ctx = store.getStore();
      if (ctx?.quiet !== true) log(kind === "stubs" ? `not activated: ${entry.class ?? "?"}=>${entry.method ?? "?"}: ${entry.reason}` : `hana-serve: refused outbound ${entry.kind} ${entry.target ?? ""}`.trimEnd());
      const record = target();
      if (record !== undefined) record[kind].push(entry);
      else if (file !== undefined) write({outside: true, stubs: kind === "stubs" ? [entry] : [], refused: kind === "refused" ? [entry] : []});
    },
    /** run `work` with its own record; the record is returned beside the result */
    async within(record, work, extra = {}) {
      return store.run({...extra, record}, work);
    },
    /** a request: run it under its record and write its line */
    async request({method, path}, work, statusOf) {
      if (file === undefined) return work();
      const record = {method, path, status: undefined, stubs: [], refused: []};
      try {
        return await store.run({record}, work);
      } finally {
        record.status = statusOf();
        write(record);
      }
    },
    /** the end of the boot: the load-time signals as one `boot` line */
    endBoot(extra = {}) {
      booting = false;
      write({boot: true, ...extra, stubs: boot.stubs, refused: boot.refused});
      return boot;
    },
    boot,
    store,
  };
}

// ------------------------------------------------------- 2. the stub hook ----

/** the ABAP name of a transpiled method: `$iwbep$if_x$m` is
 *  /IWBEP/IF_X~M, `if_x$m` is IF_X~M, `m` is M */
export function abapMethodName(js) {
  let name = String(js ?? "");
  let namespace = "";
  const ns = /^\$([a-z0-9_]+)\$(.*)$/i.exec(name);
  if (ns !== null && ns[2].includes("$")) {
    namespace = `/${ns[1]}/`;
    name = ns[2];
  }
  const at = name.lastIndexOf("$");
  const method = at < 0 ? name : `${name.slice(0, at)}~${name.slice(at + 1)}`;
  return (namespace + method).toUpperCase();
}

/** The class and method a stub raise came from, read off a V8 stack: the
 *  first frame in a transpiled class module (`<name>.clas.mjs`) that is not
 *  the exception class itself. The class is the module's (a `#ns#` file name
 *  is /NS/); the method is the frame's function name. undefined when no
 *  frame is in a class module (the host's own probe). */
export function stubSite(stack) {
  for (const line of String(stack ?? "").split("\n")) {
    const m = /^\s*at (?:async )?(?:(\S+?) \()?(?:file:\/\/)?[^\s()]*\/([^/\s()]+)\.clas\.mjs:\d+(?::\d+)?\)?\s*$/.exec(line);
    if (m === null) continue;
    const cls = decodeURIComponent(m[2]).replace(/#/g, "/").toUpperCase();
    if (cls === "ZCX_OSD_NOT_ACTIVATED") continue;
    const fn = String(m[1] ?? "");
    const method = fn.includes(".") ? fn.slice(fn.lastIndexOf(".") + 1) : fn;
    return {class: cls, method: method === "" ? undefined : abapMethodName(method)};
  }
  return undefined;
}

/** Install globalThis.osdNotActivated: every stub raise (and every stubbed
 *  class constructor's signal) becomes a `stubs` entry of the current
 *  record. The stack is read only when a stub raises. Returns the hook. */
export function installStubHook(record, {global = globalThis} = {}) {
  const hook = (missing) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    const site = stubSite(stack);
    record.note("stubs", {class: site?.class, method: site?.method, reason: String(missing ?? "")});
  };
  hook.osdHost = true;
  global.osdNotActivated = hook;
  return hook;
}

/** The positive control of the hook: raise one synthetic stub through the
 *  exception class the generation loaded -- the same constructor a stubbed
 *  method runs -- and see whether the record received it. `abap` is the
 *  runtime (globalThis.abap). Returns {ok, why}. */
export async function probeStubHook(abap, record) {
  const cx = abap?.Classes?.ZCX_OSD_NOT_ACTIVATED;
  if (cx === undefined) return {ok: false, why: "the generation has no ZCX_OSD_NOT_ACTIVATED: no stub can raise, and none can be traced"};
  const seen = {stubs: [], refused: []};
  await record.within(seen, async () => {
    await new cx().constructor_({missing: new abap.types.String().set(PROBE_REASON)});
  }, {quiet: true});
  if (seen.stubs.some((s) => s.reason === PROBE_REASON) === true) return {ok: true};
  return {ok: false, why: "a synthetic stub raise did not reach the host's hook (globalThis.osdNotActivated): the trace would miss every stub"};
}

// ----------------------------------------------- 1. the outbound guard ----

/** What a socket's connect() arguments address: "host:port" or the path of
 *  a local socket. The internal callers hand over normalized arguments. */
export function connectTarget(args) {
  let first = args[0];
  if (Array.isArray(first)) first = first[0];
  if (first !== null && typeof first === "object") {
    // an HTTP agent's options carry `path: null` beside host and port
    if ((first.port === undefined || first.port === null) && first.path !== undefined && first.path !== null) return {path: String(first.path)};
    return {host: String(first.host ?? "localhost"), port: Number(first.port)};
  }
  if (typeof first === "string" && Number.isNaN(Number(first))) return {path: first};
  return {host: String(typeof args[1] === "string" ? args[1] : "localhost"), port: Number(first)};
}

const describe = (t) => (t.path !== undefined ? `local socket ${t.path}` : `${t.host}:${t.port}`);

const DNS_METHODS = ["lookup", "lookupService", "resolve", "resolve4", "resolve6", "resolveAny", "resolveCaa", "resolveCname", "resolveMx",
  "resolveNaptr", "resolveNs", "resolvePtr", "resolveSoa", "resolveSrv", "resolveTxt", "reverse"];
const PROCESS_METHODS = ["spawn", "exec", "execFile", "fork", "spawnSync", "execSync", "execFileSync"];
const BINDINGS = new Set(["tcp_wrap", "udp_wrap", "pipe_wrap", "tls_wrap", "cares_wrap", "process_wrap", "spawn_sync", "stream_wrap", "js_stream"]);

/** Install the guard in this process. `record` receives every refusal.
 *  Returns {asOwnDatabase, denyAll, own, uninstall}. Idempotent per process
 *  is NOT promised: install once, uninstall to give everything back. */
export function installOutboundGuard(record) {
  const context = new AsyncLocalStorage();
  const own = {endpoints: new Set(), hosts: new Set()};
  const undo = [];
  const patch = (object, name, make) => {
    const original = object[name];
    if (typeof original !== "function") return;
    object[name] = make(original);
    undo.push(() => { object[name] = original; });
  };
  const refuse = (kind, target, extra = {}) => {
    const ctx = context.getStore();
    const entry = {kind, target, ...extra};
    if (ctx?.entry !== undefined) {
      // inside a wrapped HTTP client send: its entry carries the address
      ctx.entry.target ??= target;
      ctx.entry.socket = "refused before it opened";
    } else {
      record.note("refused", entry);
    }
    const error = new Error(`hana-serve refuses outbound network calls: ${kind} ${target ?? ""}`.trimEnd());
    error.code = REFUSED_CODE;
    return error;
  };
  const allowedConnect = (t) => {
    const ctx = context.getStore();
    if (ctx?.deny === true) return false;
    if (ctx?.ownDatabase === true) {
      own.endpoints.add(describe(t));
      if (t.host !== undefined) own.hosts.add(t.host.toLowerCase());
      return true;
    }
    return own.endpoints.has(describe(t));
  };
  // an address literal is no query (the host's own listen() looks one up)
  const literal = (name) => require("node:net").isIP(String(name)) !== 0 || String(name).toLowerCase() === "localhost";
  const allowedName = (name) => {
    if (literal(name) === true) return true;
    const ctx = context.getStore();
    if (ctx?.deny === true) return false;
    if (ctx?.ownDatabase === true) {
      own.hosts.add(String(name).toLowerCase());
      return true;
    }
    return own.hosts.has(String(name).toLowerCase());
  };

  // the socket every TCP, TLS, HTTP(S), http2, fetch and WebSocket client
  // and every local (unix) socket connects through
  const net = require("node:net");
  patch(net.Socket.prototype, "connect", (original) => function (...args) {
    const t = connectTarget(args);
    if (allowedConnect(t) === false) throw refuse("connect", describe(t));
    return original.apply(this, args);
  });
  // UDP: no connection to refuse, so every datagram is
  const dgram = require("node:dgram");
  for (const name of ["send", "connect"]) {
    patch(dgram.Socket.prototype, name, () => function (...args) {
      throw refuse("udp", name === "connect" ? `${args[1] ?? "localhost"}:${args[0]}` : `${args.at(-2) ?? "?"}:${args.at(-3) ?? "?"}`);
    });
  }
  // a name lookup is itself a packet to a resolver, and a name can carry data
  const dns = require("node:dns");
  const guardDns = (object, promised) => {
    for (const name of DNS_METHODS) {
      patch(object, name, (original) => function (host, ...rest) {
        if (allowedName(host) === true) return original.call(this, host, ...rest);
        const error = refuse("dns", String(host));
        if (promised === true) return Promise.reject(error);
        const callback = rest.findLast?.((x) => typeof x === "function");
        if (typeof callback === "function") { process.nextTick(callback, error); return undefined; }
        throw error;
      });
    }
  };
  guardDns(dns, false);
  guardDns(dns.Resolver.prototype, false);
  guardDns(dns.promises, true);
  guardDns(dns.promises.Resolver.prototype, true);
  // a child process can do anything the host can: there is none to start
  const childProcess = require("node:child_process");
  for (const name of PROCESS_METHODS) {
    patch(childProcess, name, () => function (command) {
      throw refuse("process", String(command));
    });
  }
  // a worker has module instances of its own, which nothing here patched
  const workers = require("node:worker_threads");
  patch(workers, "Worker", () => function Worker(file) {
    throw refuse("worker", String(file));
  });
  // the raw bindings under net and child_process, where a runtime offers them
  patch(process, "binding", (original) => function (name) {
    if (BINDINGS.has(String(name))) throw refuse("binding", String(name));
    return original.call(this, name);
  });
  // fetch and WebSocket refuse at their socket already; this names the URL
  patch(globalThis, "fetch", (original) => function (input, ...rest) {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    if (context.getStore()?.ownDatabase !== true) return Promise.reject(new TypeError("fetch failed", {cause: refuse("fetch", url)}));
    return original.call(this, input, ...rest);
  });
  if (typeof globalThis.WebSocket === "function") {
    patch(globalThis, "WebSocket", () => function WebSocket(url) {
      throw refuse("websocket", String(url));
    });
  }
  // ESM imports of these builtins see the patched functions too
  syncBuiltinESMExports();

  return {
    own,
    /** run the database client's connect: what it opens is the host's own */
    asOwnDatabase: (work) => context.run({ownDatabase: true}, work),
    /** run `work` with every connection refused, the database's included;
     *  a refusal fills `entry` instead of adding one of its own */
    denyAll: (work, entry) => context.run({deny: true, entry}, work),
    uninstall() {
      for (const one of undo.reverse()) one();
      undo.length = 0;
      syncBuiltinESMExports();
    },
  };
}

/** The class library's HTTP client (open-abap-core CL_HTTP_CLIENT), made to
 *  answer the way a system without a route out does: CREATE_BY_URL and
 *  CREATE_BY_DESTINATION hand out a client (creating one opens nothing),
 *  SEND is refused -- the classic exception HTTP_COMMUNICATION_FAILURE the
 *  real class raises when it cannot reach the partner, GET_LAST_ERROR
 *  saying why -- and the refusal is one `refused` entry of the request's
 *  record, whatever the provider does with the exception. */
export function installHttpClientGuard(abap, guard, record) {
  const client = abap?.Classes?.CL_HTTP_CLIENT;
  if (client === undefined) return {installed: false};
  const send = client.prototype.if_http_client$send;
  const destinations = new WeakMap();
  // the library's own CREATE_BY_DESTINATION is a todo-assert; a system
  // reads the destination and hands out a client for it
  client.create_by_destination = async function (INPUT) {
    const name = String(INPUT?.destination?.get?.() ?? INPUT?.destination ?? "").trim();
    const created = await new abap.Classes.CL_HTTP_CLIENT().constructor_({url: new abap.types.String().set("http://destination.invalid/")});
    destinations.set(created, name);
    INPUT?.client?.set?.(created);
    abap.builtin.sy.get().subrc.set(0);
  };
  client.prototype.if_http_client$send = async function (INPUT) {
    const destination = destinations.get(this);
    const entry = destination === undefined ? {kind: "http", via: "CL_HTTP_CLIENT=>CREATE_BY_URL"} : {kind: "http", via: "CL_HTTP_CLIENT=>CREATE_BY_DESTINATION", destination};
    if (destination !== undefined) entry.target = `destination ${destination}`;
    try {
      await guard.denyAll(() => send.call(this, INPUT), entry);
    } finally {
      record.note("refused", entry);
    }
    // the send above cannot have reached anybody; if it says it did, it
    // did not reach the socket at all -- refuse it all the same
    await this.if_http_client$close?.();
    throw new abap.ClassicError({classic: "http_communication_failure"});
  };
  return {installed: true};
}
