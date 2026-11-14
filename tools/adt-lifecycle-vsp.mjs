import {spawn} from "node:child_process";
import {createInterface} from "node:readline";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {speed} from "./warm-deadline/warm-deadline.mjs";

// The params.timeout, in seconds, that a VSP WriteSource/Activate call gets
// when the operation needs no special margin.
export const CALL_TIMEOUT_S = 90;
// DDLS activation re-runs the CDS generator and a cold build inside one call:
// ~50 s per DDLS update on a green CI runner, but 79-92 s on the loaded runner
// classes that failed -- CI #922/#908 failed on the 90 s budget, every full
// rerun passed, and the failing activations were cut at the budget (an
// ABAP-FS activation-edit measured 98.1 s on the slowest of those runners;
// #926's failure was the job's 40-minute cap, not a DDLS timeout). The
// warm-deadline factor tracks this cost poorly: the calibration runs idle in
// the harness while the activation builds under the lifecycle's own load, so
// across those runs the factor moved 1.00-1.29 while the DDLS cost moved
// 1.7-2x. The measured-speed factor (tools/warm-deadline, docs/warm-compile.md)
// therefore scales a 240 s floor -- about 4x the CI median -- never below it,
// never above 480 s.
export function ddlsCallTimeoutS(env = process.env) {
  return Math.min(480, Math.max(240, Math.round(240 * speed(env).factor)));
}

// The wait for the warm compiler to be primed again (adt-lifecycle.mjs
// warmReady) is the same kind of cost: a cold baseline activation, the
// verification comparisons queued before a prime may start, then the prime
// itself. Green CI: ~54 s (baseline 29-37 s, prime 15-30 s). On the slow runner
// that failed #942 (speed factor 1.19) the interface create overran the warm
// deadline, the compiler re-primed behind two 29-36 s comparisons, and the
// fixed 90 s ran out with no prime started. Same floor, factor and clamp as
// the DDLS family.
export function warmReadyTimeoutS(env = process.env) {
  return ddlsCallTimeoutS(env);
}

export async function vspClient(url) {
  // Empty cwd and an empty home prevent VSP from finding a workstation
  // connection/config; a developer's ~/.vsp.json pins a real system and its
  // identity check refuses the OSD logon before any call is made.
  const cwd = mkdtempSync(join(tmpdir(), "osd-lifecycle-vsp-"));
  const child = spawn(process.env.VSP ?? "vsp", ["--url", url, "--user", "OSD", "--password", "any", "--client", "001", "--mode", "focused"], {cwd, env:{...process.env, HOME:cwd, USERPROFILE:cwd}, stdio:["pipe", "pipe", "pipe"]});
  const pending = new Map();
  let serial = 0, exited = false;
  const rl = createInterface({input:child.stdout});
  const fail = error => { for (const p of pending.values()) { clearTimeout(p.timer); p.reject(error); } pending.clear(); };
  rl.on("line", line => {
    let r; try { r = JSON.parse(line); } catch { return; }
    const p = pending.get(r.id);
    if (!p) return;
    clearTimeout(p.timer); pending.delete(r.id);
    r.error ? p.reject(Error(r.error.message)) : p.resolve(r.result);
  });
  child.stderr.on("data", () => {});
  // A VSP that died mid-call must fail its pending rpc, not crash the
  // harness with an unhandled EPIPE before any report row exists.
  child.stdin.on("error", fail);
  child.on("error", fail);
  child.on("exit", () => { exited = true; fail(Error("VSP exited")); });
  // The ceiling only catches a dead or silent VSP; it must never be the
  // binding budget, so it rides above the widest params.timeout the lifecycle
  // sends (the DDLS budget) by a minute of readback slack. With the DDLS
  // budget at [240, 480] s this is 300-540 s.
  const ceilingMs = Math.max(120000, (ddlsCallTimeoutS() + 60) * 1000);
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++serial;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`${method} timed out`)); }, ceilingMs);
    pending.set(id, {resolve, reject, timer});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0", id, method, params}) + "\n", error => { if (error) fail(error); });
  });
  const close = async () => {
    fail(Error("VSP closed"));
    if (!exited) await new Promise(resolve => {
      const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
      child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM");
    });
    rl.close(); rmSync(cwd, {recursive:true, force:true});
  };
  try {
    await rpc("initialize", {protocolVersion:"2024-11-05", capabilities:{}, clientInfo:{name:"osd-lifecycle", version:"1"}});
    child.stdin.write(JSON.stringify({jsonrpc:"2.0", method:"notifications/initialized"}) + "\n");
    return {close, tool:async (name, args) => {
      const r = await rpc("tools/call", {name, arguments:args});
      if (r.isError) throw Error(r.content?.map(b=>b.text ?? "").join("\n") ?? "VSP error");
      return r;
    }};
  } catch (error) { await close(); throw error; }
}
