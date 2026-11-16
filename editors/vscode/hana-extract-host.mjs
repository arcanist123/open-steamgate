// The forked helper behind "OSD: Extract my code from HANA"
// (hana-extract-command.js). The extension host forks this file with an IPC
// channel and never runs the osd-hana module itself: extract converts a whole
// dump (hashing, XML) and that work must not stall the extension host. Here
// the module is IMPORTED -- doctorMain / extractMain from tools/osd-hana/ --
// so there is no shell, no CLI parsing of a password and no argv secret.
//
// What crosses the channel (hana-extract-job.js is the other end):
//   in   {t: "run", verb, argv, moduleRoot, password, callerPath, secrets,
//         confirmed?}                 confirmed: {inScope, bytes} of the plan
//                                     the user confirmed (extract only)
//        {t: "answer", id, value}     an answer to one of our questions
//   out  {t: "out" | "err", line}     the module's io, line by line
//        {t: "ask", id, kind, question, plan?}
//                                     kind: "visible" | "hidden" | "consent"
//        {t: "secret-set", key, value} / {t: "secret-delete", key}
//        {t: "done", code, verdict?, plan?, consent?}
//                                     verdict: the doctor's JSON + plain lines;
//                                     consent: "given" | "declined" | undefined
//        {t: "fail", message}
//
// extract's own consent question ("extract N objects ...? [y/N]") is answered
// HERE, from the module's UNREDACTED --json plan -- never from the prompt's
// text and never from what the extension host sees, which is redacted for
// display (a short password inside a number would corrupt it). The live plan
// equal to the confirmed one is a yes; a different one is asked again
// (kind "consent"); a missing live plan, a failed ask or no answer within
// consentTimeoutMs is a no.
//
// Secrets: the login's password arrives in the run message and goes into the
// `env` OBJECT the module reads (OSD_HANA_PASSWORD) -- never into
// process.env, argv, a file or a log line. The reader the doctor may create is
// stored through the injected secret store, whose writes travel back to the
// extension host and land in VS Code SecretStorage only.
//
// This process leads its own process group (forked detached on POSIX): the
// sidecar the module spawns belongs to the group, so cancelling kills the
// group and with it the sidecar. If the extension host goes away the IPC
// channel closes, and we take the group down ourselves.
import path from "node:path";
import {PassThrough} from "node:stream";
import {pathToFileURL} from "node:url";

/** The environment the module sees: this process's own, with every HANA_* /
 *  OSD_HANA_*PASSWORD value the user's shell may carry removed (a stray
 *  HANA_DATABASE or a second login's password must not decide this run), and
 *  the one password of this run added. A plain object, never process.env. */
export function moduleEnv(base, password) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (/^HANA_/.test(key) || /^OSD_HANA_.*PASSWORD$/.test(key)) continue;
    env[key] = value;
  }
  if (typeof password === "string" && password !== "") env.OSD_HANA_PASSWORD = password;
  return env;
}

/** The answer to extract's consent question: true only when the live plan
 *  equals the confirmed one, or when the user confirms the changed listing.
 *  No live plan, a rejected ask or a timeout is false. */
export async function decideConsent({livePlan, confirmed, askConsent, timeoutMs = CONSENT_TIMEOUT_MS}) {
  if (livePlan === undefined || livePlan === null || typeof livePlan.inScope !== "number") return false;
  if (confirmed !== undefined && confirmed !== null && livePlan.inScope === confirmed.inScope && livePlan.bytes === confirmed.bytes) return true;
  let timer;
  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => askConsent({inScope: livePlan.inScope, bytes: livePlan.bytes})),
      new Promise((resolve) => { timer = setTimeout(() => resolve("no"), timeoutMs); timer.unref?.(); }),
    ]);
    return answer === "yes";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export const CONSENT_TIMEOUT_MS = 30 * 60 * 1000;

export const STORE_LOCATION = "VS Code SecretStorage (this extension's secret store, never settings)";

/** Runs one job and exits. `clientFactory`, `pinFile` and `sidecarExtraEnv`
 *  are the module's own test seams, passed through only by a test host
 *  (test/osd-hana/vscode-test-host.mjs); the production entry passes none. */
export function runHost({clientFactory, pinFile, sidecarExtraEnv, proc = process, onFinish = async () => {}, consentTimeoutMs = CONSENT_TIMEOUT_MS} = {}) {
  const pending = [];
  const post = (message) => {
    pending.push(new Promise((resolve) => {
      if (!proc.connected) return resolve();
      proc.send(message, () => resolve());
    }));
  };
  const waiting = new Map();
  let nextId = 0;
  const ask = (kind, extra = {}) => (question) => new Promise((resolve) => {
    nextId += 1;
    waiting.set(nextId, resolve);
    post({t: "ask", id: nextId, kind, question: String(question), ...extra});
  });
  let finished = false;
  const finish = async (message) => {
    await Promise.all(pending.splice(0));
    await onFinish();
    post(message);
    await Promise.all(pending.splice(0));
    finished = true; // our own disconnect below is not the host going away
    if (proc.connected) proc.disconnect();
  };

  proc.on("disconnect", () => {
    // the extension host is gone mid-run: nothing of ours must outlive it
    if (!finished) killOwnGroup(proc);
  });
  proc.on("message", (message) => {
    if (message?.t === "answer") {
      const resolve = waiting.get(message.id);
      waiting.delete(message.id);
      resolve?.(message.value ?? "");
    } else if (message?.t === "run") {
      run(message).then(
        (done) => finish({t: "done", ...done}),
        (error) => finish({t: "fail", message: String(error?.message ?? error)}));
    }
  });

  async function run({verb, argv, moduleRoot, password, callerPath, secrets = {}, confirmed}) {
    const outs = [];
    let onOut = () => {};
    const io = {
      out: (line) => { outs.push(String(line)); post({t: "out", line: String(line)}); onOut(String(line)); },
      err: (line) => post({t: "err", line: String(line)}),
    };
    const store = {
      kind: "vscode",
      location: () => STORE_LOCATION,
      get: (key) => secrets[key],
      set: (value, key) => { secrets[key] = value; post({t: "secret-set", key, value}); },
      delete: (key) => { delete secrets[key]; post({t: "secret-delete", key}); },
    };
    const env = moduleEnv(proc.env, password);
    const seams = {
      ...(pinFile !== undefined ? {pinFile} : {}),
      ...(sidecarExtraEnv !== undefined ? {sidecarExtraEnv} : {}),
    };
    if (verb === "doctor") {
      const {doctorMain} = await import(pathToFileURL(path.join(moduleRoot, "doctor.mjs")).href);
      const {plainVerdict} = await import(pathToFileURL(path.join(moduleRoot, "verdict.mjs")).href);
      const empty = new PassThrough();
      empty.end();
      const code = await doctorMain(argv, {
        io, env, stdin: empty, isTTY: true, stderr: {isTTY: true}, callerPath, store,
        promptVisible: ask("visible"), promptHidden: ask("hidden"),
        ...(clientFactory !== undefined ? {clientFactory} : {}),
        ...seams,
      });
      // --json: the module prints its document as one io.out call
      const json = outs.find((line) => line.trimStart().startsWith("{"));
      let doc;
      try { doc = json === undefined ? undefined : JSON.parse(json); } catch { doc = undefined; }
      const plain = doc?.probe !== undefined ? plainVerdict(doc.probe, {connection: doc.connection, sidecar: doc.sidecar}) : undefined;
      return {code, verdict: doc === undefined ? undefined : {doc, plain}};
    }
    if (verb === "extract") {
      const {extractMain} = await import(pathToFileURL(path.join(moduleRoot, "extract.mjs")).href);
      const stdin = new PassThrough();
      stdin.isTTY = true;
      const parsePlan = () => {
        const json = outs.find((line) => line.trimStart().startsWith("{"));
        try { return json === undefined ? undefined : JSON.parse(json); } catch { return undefined; }
      };
      let consent;
      let answered = false;
      onOut = (line) => {
        if (answered || !/\? \[y\/N\]/.test(line)) return;
        answered = true;
        // the plan this run printed before its question, as the module wrote it
        decideConsent({livePlan: parsePlan()?.plan, confirmed, timeoutMs: consentTimeoutMs,
          askConsent: (live) => ask("consent", {plan: live})(`extract ${live.inScope} objects?`)})
          .catch(() => false)
          .then((yes) => {
            consent = yes ? "given" : "declined";
            stdin.write(yes ? "yes\n" : "no\n");
          });
      };
      const code = await extractMain(argv, {io, env, stdin, isTTY: true, callerPath, ...seams});
      stdin.end();
      return {code, plan: parsePlan(), consent};
    }
    throw new Error(`hana-extract-host: unknown verb ${verb}`);
  }
}

export function killOwnGroup(proc = process) {
  try {
    if (process.platform === "win32") proc.exit(1);
    else process.kill(-proc.pid, "SIGKILL");
  } catch {
    proc.exit(1);
  }
}

// The production entry: forked by hana-extract-job.js with no seams.
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runHost();
}
