"use strict";
// The extension-host end of hana-extract-host.mjs: fork it, hand it one job,
// answer its questions, carry its secret-store writes into SecretStorage, and
// stop it -- with the sidecar it started -- when the user cancels.
//
// The house pattern for long work (job-worker.js, abapgit-zip.js): a child
// Node from process.execPath (the extension host already is one), no shell,
// and on POSIX its own process group, so one signal to the group reaches the
// grandchild sidecar too (job-worker.js's signalGroup). Windows has no
// groups: `taskkill /T /F` ends the tree.
const path = require("node:path");
const {fork, spawn} = require("node:child_process");

const HOST_SCRIPT = path.join(__dirname, "hana-extract-host.mjs");
const KILL_GRACE_MS = 2000;

function signalGroup(pid, signal) {
  try { process.kill(process.platform === "win32" ? pid : -pid, signal); }
  catch (e) { if (e.code !== "ESRCH") throw e; }
}

/** Every secret of this command run, masked wherever text leaves us: the
 *  output channel, a message, an error. The module redacts its own output;
 *  this is the second fence, for whatever the module did not see. Values
 *  shorter than 3 characters are ignored, as the module's redactor does. */
function makeRedactor() {
  const secrets = new Set();
  const redact = (text) => {
    let result = String(text ?? "");
    for (const secret of [...secrets].sort((a, b) => b.length - a.length)) {
      result = result.split(secret).join("***");
    }
    return result;
  };
  redact.add = (value) => { if (typeof value === "string" && value.length >= 3) secrets.add(value); };
  return redact;
}

/** One job in the forked host. Resolves {code, verdict?, plan?} or
 *  {cancelled: true}; rejects on a host failure (message redacted).
 *  `onAsk({kind, question})` answers a module question (may resolve
 *  undefined = declined); `onSecretSet(key, value)` / `onSecretDelete(key)`
 *  are awaited before the job resolves; `onLine(stream, line)` sees the
 *  module's io. `token` is a VS Code CancellationToken. */
function runHostJob(message, {
  hostScript = HOST_SCRIPT,
  execPath = process.execPath,
  env = process.env,
  onLine = () => {},
  onAsk = async () => undefined,
  onSecretSet = async () => {},
  onSecretDelete = async () => {},
  onChild = () => {},
  token,
  redact = (text) => text,
} = {}) {
  return new Promise((resolve, reject) => {
    const child = fork(hostScript, [], {
      execPath,
      execArgv: [],
      // the extension host runs Electron as Node; a forked child needs the
      // same switch to be a plain Node. No secret is in this environment.
      env: {...env, ELECTRON_RUN_AS_NODE: "1"},
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      detached: process.platform !== "win32",
      serialization: "json",
      windowsHide: true,
    });
    // the stdin channel extract's consent question reads from
    child.answerConsent = (text) => { if (child.connected) child.send({t: "stdin", text}); };
    onChild(child);
    const secretWrites = [];
    let settled = false;
    let cancelled = false;
    let result;
    const settle = (fn, value) => { if (!settled) { settled = true; fn(value); } };
    const stray = (chunk) => { for (const line of String(chunk).split(/\r?\n/)) if (line.trim()) onLine("err", redact(line)); };
    child.stdout.on("data", stray);
    child.stderr.on("data", stray);
    child.on("message", (m) => {
      if (m?.t === "out" || m?.t === "err") onLine(m.t, redact(m.line));
      else if (m?.t === "ask") {
        Promise.resolve(onAsk({kind: m.kind, question: m.question})).then((value) => {
          if (child.connected) child.send({t: "answer", id: m.id, value: value ?? ""});
        }, () => { if (child.connected) child.send({t: "answer", id: m.id, value: ""}); });
      } else if (m?.t === "secret-set") secretWrites.push(Promise.resolve(onSecretSet(m.key, m.value)));
      else if (m?.t === "secret-delete") secretWrites.push(Promise.resolve(onSecretDelete(m.key)));
      else if (m?.t === "done") result = {code: m.code, verdict: m.verdict, plan: m.plan};
      else if (m?.t === "fail") result = {failure: redact(m.message)};
    });
    child.on("error", (error) => settle(reject, new Error(redact(error.message))));
    child.on("exit", async (code, signal) => {
      try { await Promise.all(secretWrites); } catch (error) { return settle(reject, new Error(redact(error.message))); }
      if (cancelled) return settle(resolve, {cancelled: true});
      if (result?.failure !== undefined) return settle(reject, new Error(result.failure));
      if (result === undefined) return settle(reject, new Error(`the extract helper ended without an answer (exit ${code ?? signal})`));
      settle(resolve, result);
    });
    const cancel = () => {
      if (cancelled || child.exitCode !== null || child.signalCode !== null) return;
      cancelled = true;
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {stdio: "ignore", windowsHide: true}).on("error", () => child.kill());
        return;
      }
      signalGroup(child.pid, "SIGTERM");
      const timer = setTimeout(() => signalGroup(child.pid, "SIGKILL"), KILL_GRACE_MS);
      timer.unref?.();
      child.once("exit", () => {
        // the group may still hold the sidecar if it ignored SIGTERM
        clearTimeout(timer);
        signalGroup(child.pid, "SIGKILL");
      });
    };
    token?.onCancellationRequested?.(cancel);
    if (token?.isCancellationRequested) cancel();
    child.send(message);
  });
}

module.exports = {runHostJob, makeRedactor, signalGroup, HOST_SCRIPT};
