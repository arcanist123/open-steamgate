// Cross-process GC protection for a generation and the verifier's scratch.
import {processIdentity} from "./osd-process-identity.mjs";
import {randomUUID} from "node:crypto";
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, renameSync, statSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {layout, lock} from "./osd-build.mjs";
import {MissingCompileInputs} from "./osd-compile-snapshot.mjs";

export async function verificationLock(root, deadlineMs = 30000) {
  const paths = layout(root), until = Date.now() + deadlineMs;
  let unlock;
  for (;;) {
    try { unlock = lock(paths); break; } catch (error) {
      if (error.code !== "BUSY") throw error;
      if (Date.now() >= until) throw Object.assign(new Error("verification build lock deadline exceeded"), {code: "VERIFY_TIMEOUT"});
      await new Promise(resolve => setTimeout(resolve, Math.min(20, Math.max(1, until - Date.now()))));
    }
  }
  return unlock;
}

export async function pinVerification(root, hash, scratch, options = {}) {
  const paths = layout(root), unlock = await verificationLock(root, options.deadlineMs);
  try {
    if (!existsSync(join(paths.byInput, hash, "manifest.json"))) {
      throw new MissingCompileInputs(`missing generation under verification: ${hash}`);
    }
    const dir = join(paths.build, "verify-pins");
    mkdirSync(dir, {recursive: true});
    const file = join(dir, `${process.pid}.${randomUUID()}.json`);
    const pin = {pid: process.pid, identity: processIdentity(process.pid), hash, scratch};
    const renew = () => {
      const tmp = `${file}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify({...pin, createdAt: Date.now()}));
        renameSync(tmp, file);
      } finally { rmSync(tmp, {force: true}); }
    };
    renew();
    const timer = setInterval(() => {
      try { renew(); } catch (error) {
        clearInterval(timer);
        console.error(`warm: verification pin renewal stopped: ${error.message}`);
      }
    }, options.renewMs ?? 60000);
    timer.unref();
    return () => { clearInterval(timer); rmSync(file, {force: true}); };
  } finally { unlock(); }
}

// Called under the build lock. Reap pins left by terminated verifiers.
export function verificationPins(root) {
  const dir = join(layout(root).build, "verify-pins"), pins = [];
  if (!existsSync(dir)) return pins;
  for (const file of readdirSync(dir)) {
    // A verifier killed between writing a renewal and renaming it leaves
    // `<pid>.<uuid>.json.tmp`. A live one holds it for microseconds, so a
    // dead owner or an age past the lease makes it litter.
    if (file.endsWith(".json.tmp")) {
      const path = join(dir, file);
      const pid = Number(file.split(".")[0]);
      let mtime;
      try { mtime = statSync(path).mtimeMs; } catch { continue; }
      let alive = Number.isInteger(pid) && pid > 0;
      if (alive) try { process.kill(pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
      if (!alive || Date.now() - mtime > 300000) rmSync(path, {force: true});
      continue;
    }
    if (!file.endsWith(".json")) continue;
    const path = join(dir, file);
    let pin;
    try { pin = JSON.parse(readFileSync(path, "utf8")); } catch (error) {
      if (error.code === "ENOENT") continue; // A finished verifier released it.
      throw error;
    }
    // A lease also bounds PID reuse and legacy pins without a timestamp.
    const identity = processIdentity(pin.pid);
    const active = pin.identity !== undefined && pin.identity === identity;
    if ((pin.identity !== undefined && pin.identity !== identity) || (!active &&
        (!Number.isFinite(pin.createdAt) || Date.now() - pin.createdAt > 300000 || pin.createdAt > Date.now()))) {
      rmSync(path, {force: true});
      continue;
    }
    try { process.kill(pin.pid, 0); } catch (error) {
      if (error.code !== "ESRCH") throw error;
      rmSync(path, {force: true});
      continue;
    }
    pins.push(pin);
  }
  return pins;
}
