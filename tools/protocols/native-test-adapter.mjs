// Existing wire-suite assertions run unchanged; only server construction is
// substituted by native-launcher processes, including synchronous validation.
import {EventEmitter} from "node:events";
import {spawn, spawnSync} from "node:child_process";
import {resolve} from "node:path";

const host = resolve("tools/gogen/.out/native-protocol-test-host");
function rfcEnv(o = {}, port = o.port ?? 0) {
  return {STG_RFC_PORT: String(port), STG_RFC_AUTH_MODE: o.rfcAuthMode ?? "demo",
    STG_RFC_USER: o.rfcUser, STG_RFC_PASSWORD: o.rfcPassword, STG_RFC_CLIENT: o.rfcClient,
    STG_ADT_USER: o.backendUser, STG_ADT_PASSWORD: o.backendPassword,
    STG_ADT_CLIENT: o.backendClient, STG_ADT_LANGUAGE: o.backendLanguage};
}
const children = new Set();
process.on("exit", () => { for (const child of children) child.kill(); });

class NativeServer extends EventEmitter {
  constructor(kind, options = {}) { super(); this.kind = kind; this.options = options; }
  listen(port, _host, done) {
    const o = this.options;
    const source = o.env ?? process.env;
    const env = this.kind === "diag"
      ? {OSD_SID: o.sid ?? source.OSD_SID, STG_ADT_SID: source.STG_ADT_SID, STG_DIAG_PORT: String(port)}
      : rfcEnv(o, port);
    this.child = spawn(host, [], {stdio: ["pipe", "pipe", "pipe"]});
    children.add(this.child);
    this.child.once("exit", () => children.delete(this.child));
    this.child.stdin.end(JSON.stringify({Kind: this.kind, Env: env, Backend: o.backend ?? "http://127.0.0.1:1"}));
    let output = "", errors = "", pending = "", ready = false;
    this.child.stderr.on("data", b => errors += b);
    this.child.stdout.on("data", b => {
      output += b;
      pending += b;
      const lines = pending.split("\n");
      pending = lines.pop();
      for (const line of lines) {
        // Translate actual native diagnostics into the JS factory callbacks.
        if (line.includes("RFC authentication failed")) o.log?.({error: "RFC authentication failed"});
        if (line.includes("protocol-error:")) o.logger?.("protocol-error", line);
      }
      const match = /listening on 127\.0\.0\.1:(\d+)/.exec(output);
      if (!ready && match) { ready = true; this.port = Number(match[1]); done?.(); this.emit("listening"); }
    });
    this.child.on("error", e => this.emit("error", e));
    this.child.on("exit", () => { if (!ready) this.emit("error", new Error(errors || output)); });
    return this;
  }
  address() { return {address: "127.0.0.1", port: this.port}; }
  close(done) { this.child.once("exit", () => done?.()); this.child.kill(); }
}
export function createDiagTapeServer(options) { return new NativeServer("diag", options); }
export async function listenDiagTape(options = {}) {
  const server = createDiagTapeServer(options);
  await new Promise((resolve, reject) => server.once("error", reject).listen(options.port ?? 0, "127.0.0.1", resolve));
  return server;
}
export function createRfcAdtServer(options = {}) {
  const check = spawnSync(host, [], {input: JSON.stringify({Kind: "check-rfc", Env: rfcEnv(options)}), encoding: "utf8"});
  if (check.error) throw check.error;
  if (check.status !== 0) throw new Error(check.stderr || check.stdout);
  const server = new NativeServer("rfc", options);
  return {server, listen: () => new Promise((resolve, reject) => server.once("error", reject).listen(options.port ?? 0, "127.0.0.1", resolve))};
}
export async function listenProtocols(env) {
  const diag = await listenDiagTape({port: Number(env.STG_DIAG_PORT ?? 0), env});
  const bridge = createRfcAdtServer({port: Number(env.STG_RFC_PORT ?? 0)});
  await bridge.listen();
  return {diag, rfc: bridge.server};
}
export async function closeProtocols(servers) {
  await Promise.all(Object.values(servers).map(s => new Promise(r => s.close(r))));
}
