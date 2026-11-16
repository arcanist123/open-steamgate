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
// Both land in one per-request record (createHostRecord): {stubs, refused,
// tampered}, kept through AsyncLocalStorage so a provider that swallows the
// exception and answers 200 still leaves its trace. The record goes to a
// private JSON-lines file (--stub-trace), never into a response; without the
// option each event is still one line on stderr and nothing is kept.
//
// The threat model, said plainly: this covers what delivered code DOES
// through the ABAP layer and the libraries under it, and accidents; no
// in-process patch list is known to be complete. It is not a sandbox
// against hostile delivered SOURCE: a `WRITE '@KERNEL ...'` line is spliced
// into the transpiled module as JavaScript, and JavaScript in this process
// can do what this process can (write files through node:fs, for one). The
// cheap doors are locked as well -- a listener (only the host's own server
// may listen), process.dlopen, the inspector (open, SIGUSR1,
// _debugProcess), and with `lock` the hook and every patched entry point
// cannot be replaced (an attempt is ignored and recorded as tampering) --
// but what closes the rest is refusing such source at merge time and
// running the host where the operating system gives it no route out
// (docs/db-backends.md, "The host's two safety nets").
import {AsyncLocalStorage} from "node:async_hooks";
import {appendFileSync, closeSync, fchmodSync, mkdirSync, openSync} from "node:fs";
import {createRequire, syncBuiltinESMExports} from "node:module";
import {dirname} from "node:path";

const require = createRequire(import.meta.url);

export const REFUSED_CODE = "OSD_OUTBOUND_REFUSED";
export const PROBE_REASON = "OSD_STUB_TRACE_PROBE";

/** whether an error is (or wraps) one of the guard's refusals */
export const isRefusal = (e) => e?.code === REFUSED_CODE || e?.cause?.code === REFUSED_CODE;

/** what a refusal records of its target: a URL by its origin only (no
 *  user, path or query -- a service may put a credential there), anything
 *  else cut at 120 characters */
export function shortTarget(target) {
  const text = String(target ?? "");
  if (text.includes("://")) {
    try {
      const url = new URL(text);
      return `${url.protocol}//${url.host}`;
    } catch {
      // not a URL after all: cut below
    }
  }
  return text.length > 120 ? `${text.slice(0, 120)}...` : text;
}

// ------------------------------------------------------------ the record ----

/** The per-request record and the trace file. `file` undefined: nothing is
 *  kept, each event is said on stderr only (`log`). */
export function createHostRecord({file, log = (line) => console.error(line)} = {}) {
  const store = new AsyncLocalStorage();
  const boot = {stubs: [], refused: [], tampered: []};
  let booting = true;
  if (file !== undefined) {
    // a directory this creates is its owner's only
    mkdirSync(dirname(file), {recursive: true, mode: 0o700});
    // this run's requests only, readable by its owner only: it names the
    // classes and the addresses a delivered service tried. The mode is set
    // on the open file, because open() keeps an existing file's own mode
    const fd = openSync(file, "w", 0o600);
    try {
      fchmodSync(fd, 0o600);
    } finally {
      closeSync(fd);
    }
  }
  const write = (entry) => {
    if (file !== undefined) appendFileSync(file, JSON.stringify(entry) + "\n");
  };
  const target = () => store.getStore()?.record ?? (booting ? boot : undefined);
  return {
    file,
    tracing: file !== undefined,
    /** one event: `kind` is "stubs", "refused" or "tampered" */
    note(kind, entry) {
      const ctx = store.getStore();
      if (ctx?.quiet !== true) {
        log(kind === "stubs" ? `not activated: ${entry.class ?? "?"}=>${entry.method ?? "?"}: ${entry.reason}`
          : kind === "tampered" ? `hana-serve: TAMPERING: ${entry.what}`
            : `hana-serve: refused outbound ${entry.kind} ${entry.target ?? ""}`.trimEnd());
      }
      const record = target();
      if (record !== undefined) (record[kind] ??= []).push(entry);
      else if (file !== undefined) write({outside: true, stubs: [], refused: [], tampered: [], [kind]: [entry]});
    },
    /** run `work` with its own record; the record is returned beside the result */
    async within(record, work, extra = {}) {
      return store.run({...extra, record}, work);
    },
    /** a request: run it under its record and write its line -- when the
     *  response ends, before the client can have it, or when the work
     *  settles without ending it */
    async request({method, path, res}, work) {
      if (file === undefined) return work();
      const record = {method, path, status: undefined, stubs: [], refused: [], tampered: []};
      let written = false;
      const finish = () => {
        if (written === true) return;
        written = true;
        record.status = res.statusCode;
        write(record);
      };
      const end = res.end;
      res.end = function (...args) {
        finish();
        return end.apply(this, args);
      };
      try {
        return await store.run({record}, work);
      } finally {
        finish();
      }
    },
    /** the end of the boot: the load-time signals as one `boot` line */
    endBoot(extra = {}) {
      booting = false;
      write({boot: true, ...extra, stubs: boot.stubs, refused: boot.refused, tampered: boot.tampered});
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

/** Put `value` on `object[name]` so it stays: an accessor that answers it,
 *  not configurable, whose setter ignores an assignment and calls `onTamper`
 *  (a `delete` throws in strict code and does nothing otherwise). */
export function lockProperty(object, name, value, onTamper) {
  const enumerable = Object.getOwnPropertyDescriptor(object, name)?.enumerable ?? false;
  Object.defineProperty(object, name, {
    configurable: false,
    enumerable,
    get: () => value,
    set: () => onTamper(name),
  });
}

/** Install globalThis.osdNotActivated: every stub raise (and every stubbed
 *  class constructor's signal) becomes a `stubs` entry of the current
 *  record. The stack is read only when a stub raises. With `lock` the hook
 *  cannot be replaced afterwards: an assignment is ignored and recorded as
 *  tampering. Returns the hook. */
export function installStubHook(record, {global = globalThis, lock = false} = {}) {
  const hook = (missing) => {
    const limit = Error.stackTraceLimit;
    Error.stackTraceLimit = 50;
    const stack = new Error().stack;
    Error.stackTraceLimit = limit;
    const site = stubSite(stack);
    record.note("stubs", {class: site?.class, method: site?.method, reason: String(missing ?? "")});
  };
  hook.osdHost = true;
  if (lock === true) lockProperty(global, "osdNotActivated", hook, (name) => record.note("tampered", {what: `assignment to globalThis.${name}, ignored`}));
  else global.osdNotActivated = hook;
  return hook;
}

/** What of the host's safety is no longer what it installed: the hook and
 *  the guard's entry points, by identity. Cheap; the host asks it per
 *  request. */
export function integrity({global = globalThis, hook, guard} = {}) {
  const broken = [];
  if (hook !== undefined && global.osdNotActivated !== hook) broken.push("globalThis.osdNotActivated");
  if (guard !== undefined) broken.push(...guard.intact());
  return broken;
}

/** The per-request check: when integrity() names anything, the request is
 *  answered 500 without running, and its record says tampered. */
export function tamperGate(record, check) {
  return (req, res, next) => {
    const broken = check();
    if (broken.length === 0) return next();
    record.note("tampered", {what: `not intact: ${broken.join(", ")}`});
    res.status(500).type("application/json").send(JSON.stringify({error: {code: "OSD/TAMPERED",
      message: {lang: "en", value: "hana-serve: the host's guard is no longer the one it installed; nothing is answered"}}}));
    return undefined;
  };
}

/** The positive control of the hook: raise one synthetic stub through the
 *  exception class the generation loaded -- the same constructor a stubbed
 *  method runs -- and see whether the record received it. `abap` is the
 *  runtime (globalThis.abap). Returns {ok, why}. */
export async function probeStubHook(abap, record) {
  const cx = abap?.Classes?.ZCX_OSD_NOT_ACTIVATED;
  if (cx === undefined) return {ok: false, why: "the generation has no ZCX_OSD_NOT_ACTIVATED: no stub can raise, and none can be traced"};
  const seen = {stubs: [], refused: [], tampered: []};
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
const BINDINGS = new Set(["tcp_wrap", "udp_wrap", "pipe_wrap", "tls_wrap", "cares_wrap", "process_wrap", "spawn_sync", "stream_wrap", "js_stream", "inspector"]);
const DEBUG_SIGNALS = new Set(["SIGUSR1", "10"]);

/** Install the guard in this process. `record` receives every refusal.
 *  Returns {asOwnDatabase, denyAll, allowListener, intact, own, uninstall}.
 *  With `lock` every patched entry point is locked (lockProperty): an
 *  assignment is ignored and recorded as tampering, and there is no
 *  uninstall -- the host's way; without it (tests in a shared process)
 *  uninstall gives everything back. Install once per process. */
export function installOutboundGuard(record, {lock = false} = {}) {
  const context = new AsyncLocalStorage();
  const own = {endpoints: new Set(), hosts: new Set()};
  const listeners = new WeakSet();
  const window = {open: false};
  const undo = [];
  const installed = [];
  const tampered = (name) => record.note("tampered", {what: `assignment to the guarded ${name}, ignored`});
  const patch = (object, name, make) => {
    const original = object[name];
    if (typeof original !== "function") return;
    const patched = make(original);
    if (lock === true) lockProperty(object, name, patched, tampered);
    else {
      object[name] = patched;
      undo.push(() => { object[name] = original; });
    }
    installed.push({object, name, patched});
  };
  const refuse = (kind, rawTarget, extra = {}) => {
    const ctx = context.getStore();
    const target = rawTarget === undefined ? undefined : shortTarget(rawTarget);
    const entry = {kind, target, ...extra};
    if (ctx?.entry !== undefined) {
      // inside a wrapped HTTP client send: its entry carries the address
      ctx.entry.target ??= target;
      ctx.entry.socket = "refused before it opened";
    } else {
      record.note("refused", entry);
    }
    // the message names the kind only: an error can travel into a response
    // (GET_LAST_ERROR, a 500's text), the target stays in the record
    const error = new Error(`hana-serve refuses outbound network calls (${kind})`);
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
  // a listener is a way in, and an accepted connection a way out: only the
  // server the host itself marked (allowListener) may listen. http, https,
  // tls and http2 servers all listen through net.Server
  patch(net.Server.prototype, "listen", (original) => function (...args) {
    if (listeners.has(this) === false && window.open !== true) throw refuse("listen", describe(connectTarget(args)));
    // a server admitted by the start window stays admitted: its bind
    // (_listen2, below) runs a tick later, after the window has closed
    listeners.add(this);
    return original.apply(this, args);
  });
  // and the step below it: listen() hands every variant -- a port, a path
  // (a local socket), a handle, {fd}, a cluster worker's handle -- to
  // _listen2, which binds by itself through the internal TCP/pipe wrap
  // (no process.binding on the way). Called directly it is a listener on
  // all interfaces, so it gets the same check (critic round 2)
  patch(net.Server.prototype, "_listen2", (original) => function (address, port, ...rest) {
    if (listeners.has(this) === false && window.open !== true) throw refuse("listen", `${address ?? "*"}:${port ?? "?"}`);
    return original.call(this, address, port, ...rest);
  });
  // UDP: no connection to refuse, so every datagram is, and every bind
  const dgram = require("node:dgram");
  for (const name of ["send", "connect", "bind"]) {
    patch(dgram.Socket.prototype, name, () => function (...args) {
      throw refuse("udp", name === "send" ? `${args.at(-2) ?? "?"}:${args.at(-3) ?? "?"}` : `${typeof args[1] === "string" ? args[1] : "*"}:${typeof args[0] === "object" ? args[0]?.port : args[0]}`);
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
  // a native addon opens what it likes below every seam here
  patch(process, "dlopen", () => function (module, file) {
    throw refuse("dlopen", String(file));
  });
  // the inspector: a debugger that listens is somebody else taking the
  // process; SIGUSR1 (to any node process) and _debugProcess open one
  const inspector = require("node:inspector");
  patch(inspector, "open", () => function (port) {
    throw refuse("inspector", `port ${port ?? "default"}`);
  });
  patch(process, "_debugProcess", () => function (pid) {
    throw refuse("inspector", `pid ${pid}`);
  });
  patch(process, "kill", (original) => function (pid, signal) {
    if (DEBUG_SIGNALS.has(String(signal))) throw refuse("signal", `SIGUSR1 to pid ${pid}`);
    return original.call(this, pid, signal);
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
    /** the host's own server: the one listener allowed */
    allowListener: (server) => { listeners.add(server); return server; },
    /** admit any listen until the returned function is called: the host's
     *  own start, for a listener it does not hold (osd-bind's ::1 twin) */
    openListenWindow: () => {
      window.open = true;
      return () => { window.open = false; };
    },
    /** the patched entry points that are no longer the patched function */
    intact: () => installed.filter(({object, name, patched}) => object[name] !== patched).map(({name}) => name),
    /** run `work` with every connection refused, the database's included;
     *  a refusal fills `entry` instead of adding one of its own */
    denyAll: (work, entry) => context.run({deny: true, entry}, work),
    uninstall() {
      if (lock === true) throw new Error("hana-host-guard: a locked guard is not uninstalled; it ends with the process");
      for (const one of undo.reverse()) one();
      undo.length = 0;
      installed.length = 0;
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
