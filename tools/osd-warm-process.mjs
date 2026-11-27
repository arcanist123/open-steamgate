// Retain the registry off the HTTP front's event loop. Verification remains
// a front-owned child, comparing each generation's frozen compiler inputs.
import {WarmCompiler} from "./osd-warm.mjs";
import {spawn} from "./osd-child-process.mjs";
import {toolCommand} from "./osd-host.mjs";
import {compilerEnv} from "./osd-warm-env.mjs";
import {sendIPC, onIPCFailure} from "./osd-ipc.mjs";
import {fileURLToPath} from "node:url";
import {join} from "node:path";
import {holdExit, exitHolds} from "./osd-exit-holds.mjs";

const CHILD = fileURLToPath(new URL("./osd-warm-worker.mjs", import.meta.url));
// Every compiler worker and every frozen-input verifier this process started.
// A verifier writes into build/ (lock, verify-pins, tmp): left running after
// the front is gone, it outlives the process that owns that tree and races
// whoever removes or rebuilds it (test/vscode-warm-ready.mjs, ENOTEMPTY).
const children = new Set();
let reaper = false;
let stopping = false;
function reapOnExit() {
  if (reaper) return;
  reaper = true;
  const reap = () => {
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        holdExit(new Promise(resolve => child.once("exit", resolve)));
      }
      child.osdWarmStop();
      child.kill("SIGKILL");
    }
  };
  process.on("exit", reap);
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      stopping = true;
      reap();
      // The runtime supervisor has its own graceful signal handler; it
      // awaits these exits (tools/osd-exit-holds.mjs) before it leaves.
      if (process.listenerCount(signal) === 1) exitHolds().then(() => process.exit(0));
    });
  }
}
function track(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  reapOnExit();
  child.osdWarmStop ??= () => { child.osdCancelled ??= "the front is closing"; };
  children.add(child);
  child.once("exit", () => children.delete(child));
}

export class WarmCompilerProcess extends WarmCompiler {
  #child;
  #closed;
  #pending = new Map();
  #serial = 0;
  #primed = false;
  #readers = new Map();
  #epoch = 0;
  #closing = false;

  constructor(options = {}) {
    super(options);
    this.worker = options.worker ?? CHILD;
    this.onMessage = options.onMessage;
  }

  get primed() { return this.#primed; }
  get closing() { return this.#closing; }

  #start() {
    if (this.#child) return this.#child;
    reapOnExit();
    const [cmd, ...args] = toolCommand(this.worker);
    const child = spawn(cmd, args, {cwd: this.root, stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {...compilerEnv(), OSD_ROOT: this.root}});
    this.#child = child;
    child.osdWarmStop = () => { this.#closing = true; };
    children.add(child);
    child.stdout.on("data", d => this.log(String(d).trimEnd()));
    child.stderr.on("data", d => this.log(String(d).trimEnd()));
    const fail = error => {
      error.code = "WARM_UNAVAILABLE";
      if (this.#child === child) {
        this.#primed = false;
      }
      for (const [id, pending] of this.#pending) {
        if (pending.child !== child) continue;
        pending.reject(error);
        this.#pending.delete(id);
      }
    };
    onIPCFailure(child, fail);
    this.#closed = new Promise(resolve => child.once("close", (code, signal) => {
      children.delete(child);
      fail(new Error(`warm compiler exited (${signal ?? code})`));
      if (this.#child === child) this.#child = undefined;
      resolve();
    }));
    child.on("message", message => {
      this.onMessage?.(message, child);
      if (message.type === "log") { this.log(message.text); return; }
      const pending = this.#pending.get(message.id);
      if (!pending || this.#child !== child) return;
      this.#pending.delete(message.id);
      const s = message.state;
      this.#primed = s.primed;
      this.memory = s.memory;
      this.recycleDue = s.recycleDue;
      this.hash = s.hash;
      this.files = new Map(Array.from({length: s.files}, (_, i) => [i, undefined]));
      this.digests = new Map(s.digests);
      this.unverified = new Set([...this.unverified, ...s.unverified]);
      this.pruneVerification();
      this.#readers = new Map(s.readers);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message), message.error));
      else pending.resolve(message.result);
    });
    return child;
  }

  async #call(method, activating = new Set(), view = undefined, check = undefined) {
    await this.loadStoreView();
    // A drop may still be reaping the old compiler. Never start its replacement
    // before it exits, or let its exit reject the replacement's requests.
    const epoch = this.#epoch;
    if (!this.#child) await this.#closed;
    if (this.#closing || epoch !== this.#epoch) {
      throw Object.assign(new Error("warm compiler stopped"), {code: "CLOSED"});
    }
    const child = this.#start();
    const id = ++this.#serial;
    const inactive = view?.inactive ?? this.inactiveSources(new Set());
    const folder = view?.folder ?? this.overlayOf(new Set())?.folder ?? join("build", "inactive", "active");
    return new Promise((resolve, reject) => {
      this.#pending.set(id, {resolve, reject, child});
      sendIPC(child, {id, method, activating: [...activating], inactive, folder, view, check}, error => {
        if (error) { this.#pending.delete(id); reject(Object.assign(error, {code: "WARM_UNAVAILABLE"})); }
      });
    });
  }

  async update(activating = new Set(), view = undefined) {
    const result = await this.#call("update", activating, view);
    if (this.recycleDue) await this.drop();
    return result;
  }
  prime(view) { return this.#call("prime", new Set(), view); }
  async check(object, view) {
    const result = await this.#call("check", new Set(), view, object);
    if (this.recycleDue) await this.drop();
    return result;
  }
  async build(activating = new Set(), snapshot = undefined) {
    const result = await this.#call("build", activating, snapshot);
    result.unverified ??= this.unverified.has(result.hash);
    if (this.recycleDue) await this.drop();
    if (result.unverified) this.unverified.add(result.hash);
    this.pruneVerification();
    return result;
  }
  async verify(hash) {
    // A signal has stopped this front: no new child may start after the reap.
    if (stopping) return {verdict: "cancelled", why: "the front is closing"};
    const running = super.verify(hash);
    track(this.verifying);
    const result = await running;
    if (result.verdict === "same" && this.#child) {
      sendIPC(this.#child, {method: "verified", hash}, () => {});
    }
    this.pruneVerification();
    return result;
  }
  retainVerification(hashes) {
    super.retainVerification(hashes);
    if (this.#child) sendIPC(this.#child, {method: "retainVerification", hashes: [...hashes]}, () => {});
  }
  readersOf(type, name) {
    if (!this.primed) return undefined;
    return this.#readers.get(`${type} ${name.toUpperCase()}`);
  }
  closureOf(type, name) {
    const first = this.readersOf(type, name);
    if (first === undefined) return undefined;
    const found = new Map([[`${type} ${name.toUpperCase()}`, {type, name: name.toUpperCase()}]]);
    const todo = [...first];
    while (todo.length) {
      const object = todo.pop();
      const key = `${object.type} ${object.name}`;
      if (found.has(key)) continue;
      found.set(key, object);
      todo.push(...(this.#readers.get(key) ?? []));
    }
    return [...found.values()];
  }
  drop() {
    this.#epoch++;
    this.#primed = false;
    this.unverified.clear();
    // Kill even during a CPU-bound prime; a polite IPC stop would wait for it.
    const child = this.#child;
    this.#child = undefined;
    // Discarding a baseline during mismatch recovery is an ordinary cold
    // fallback. Reject its requests before disconnect can label them as an
    // unavailable compiler and permanently disable warm builds.
    for (const [id, pending] of this.#pending) {
      if (pending.child !== child) continue;
      pending.reject(Object.assign(new Error("warm compiler baseline discarded"),
        {code: this.#closing ? "CLOSED" : "NOT_WARM"}));
      this.#pending.delete(id);
    }
    child?.kill("SIGKILL");
    return this.#closed;
  }
  async shutdown() {
    this.#closing = true;
    const verifying = this.verifying;
    const verifiedExit = verifying?.exitCode === null && verifying?.signalCode === null && new Promise(resolve => verifying.once("exit", resolve));
    if (verifiedExit) { verifying.osdCancelled = "the front is closing"; verifying.kill("SIGKILL"); }
    await this.drop();
    await verifiedExit;
  }
}
