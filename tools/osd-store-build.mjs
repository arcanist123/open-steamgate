import {transpileIssues, withoutHostPaths} from "./osd-build-issues.mjs";
import {acceptView, captureView} from "./osd-store-compile-view.mjs";
import {genHash, liveHash} from "./osd-build.mjs";
import {forgetRegistry} from "./osd-store-registry.mjs";
import {relative, sep} from "node:path";
import {warmOperation} from "./osd-store-warm.mjs";
import {describe, measureSpeed, saveWait} from "./warm-deadline/warm-deadline.mjs";
const WARM_REPRIME_MS = Number(process.env.OSD_WARM_REPRIME_MS ?? 5000);
// How long a build waits for the build lock before it answers BUSY. The
// store builds one at a time, so what holds the lock under it is a frozen
// verification pinning or settling its generation (milliseconds), the GC, or
// a build from another process (minutes). Refusing at once failed an
// explicit activation in adt-lifecycle (2026-11-14, #946) because a
// verification settled in the same second.
export const BUILD_LOCK_WAIT_MS = 10000;

// Run work, which takes the build lock first thing and throws BUSY before it
// changes anything, again while the lock stays held, up to the bound.
export async function whenLockFree(store, work) {
  const bound = Number(store.buildLockWaitMs ?? process.env.OSD_BUILD_LOCK_WAIT_MS ?? BUILD_LOCK_WAIT_MS);
  const until = Date.now() + bound;
  for (let waited = false; ; waited = true) {
    try {
      const r = await work();
      if (waited) console.log("build: the build lock came free; building");
      return r;
    } catch (error) {
      if (error?.code !== "BUSY" || Date.now() >= until) throw error;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, Math.max(1, until - Date.now()))));
    }
  }
}

export async function transpileStore(store, options, activating, built) {
  const started = Date.now();
  const w = store.warm();
  // A cold publication may leave a prime due. Await its catch-up before
  // taking a build snapshot; saves remain available throughout.
  if (w.on === true && !w.disabled && options.force !== true && w.primeDue === true && w.priming === undefined &&
      (store.served?.recycling ?? store.served?.starting) === undefined) {
    // started here, awaited below within the save's bound
    store.warmUp();
  }
  // true: the prime is still running, so the compiler is busy with it and
  // this build is cold (a warm call would queue behind the prime)
  const past = await waitForPrime(store, w);
  let superseded = 0;
  for (;;) {
    clearTimeout(w.reprime);
    let view;
    try { view = await captureView(store, activating); }
    catch (error) { return failedBuild(store, error, started); }
    const overlay = view.overlay;
    if (w.on === true && !w.disabled && options.force !== true && !past) {
      if (w.compiler?.primed === true) {
        try {
          const r = await warmOperation(store, () => whenLockFree(store, () => w.compiler.build(activating, view)));
          await acceptView(store, view, activating, r);
          if (w.compiler.recycleDue) w.primeDue = true;
          return {ok: true, ms: Date.now() - started, objects: r.objects, hash: r.hash, cached: r.cached, warm: true,
            built: built(w.compiler.digests),
            modules: r.modules, hostHeld: r.hostHeld, from: r.from, stale: r.stale, steps: r.steps,
            closure: r.closure, xrefRows: r.xrefRows, unverified: r.unverified ?? w.compiler.unverified.has(r.hash), superseded};
        } catch (error) {
          try { await acceptView(store, view, activating); } catch (changed) { error = changed; }
          if (["CHANGED", "INPUT_CHANGED"].includes(error.code)) {
            superseded++;
            if (!w.compiler.primed || w.compiler.hash !== liveHash(store.root)) await w.compiler.drop();
            continue;
          }
          if (!["NOT_WARM", "WARM_UNAVAILABLE"].includes(error.code)) {
            // `check`: the transpiler refused the change; anything else
            // (BUSY, a disk that failed) is a build that did not happen
            return {ok: false, ms: Date.now() - started, objects: 0, warm: true, check: error.check === true,
              issues: error.issues, output: withoutHostPaths(String(error.output || error.message).slice(-2000), store.root),
              error: withoutHostPaths(error.message, store.root)};
          }
          w.reason = error.message;
          if (error.code !== "NOT_WARM") await w.compiler.drop();
          console.log(`warm: a cold build: ${error.message}`);
        }
      }
    }
    let generatedRefreshed = false;
    try {
      const {build} = await import("./osd-build.mjs");
      const r = await whenLockFree(store, () => build({...store.buildOptions, root: store.root, force: options.force === true, replace: options.replace === true, overlay, switch: false, expectedHash: view.hash}));
      let updated;
      if (genHash(store.root) !== view.gen || w.on === true && !w.disabled && w.compiler?.primed) {
        updated = await captureView(store, activating);
        const before = new Map(view.digests), after = new Map(updated.digests);
        const changed = [...new Set([...before.keys(), ...after.keys()])]
          .filter(file => before.get(file) !== after.get(file))
          .map(file => relative(store.root, file))
          .filter(file => file.startsWith("gen" + sep));
        // gen/ is not watched. Queue its exact delta for the synchronous
        // validator, using the same post-generator view as the compiler.
        if (changed.length) forgetRegistry(store, changed);
      }
      generatedRefreshed = true;
      await acceptView(store, view, activating, r);
      // only a build that made a generation live is one to prime on: after
      // a failed one the tree is not the live generation, and a prime on
      // demand would parse it to be told so
      if (w.on === true && !w.disabled && w.compiler?.primed && !past) {
        try {
          // Generators may have rewritten gen/ during cold compilation.
          if (updated.hash !== r.hash) throw new Error("inputs moved after cold publication");
          // sized like a prime, and a timeout drops the registry to be primed
          // again rather than turning warm off (osd-store-warm.mjs)
          await warmOperation(store, () => w.compiler.update(activating, updated), {kind: "update", files: updated.digests?.length ?? 0});
        } catch (error) {
          if (error.code !== "NOT_WARM") console.log(`warm: re-prime: ${error.message}`);
          await w.compiler.drop();
        }
      }
      w.primeDue = w.on === true && !w.disabled && w.compiler?.primed !== true;
      return {ok: true, ms: Date.now() - started, objects: r.objects, hash: r.hash, cached: r.cached, built: built(r.digests), superseded};
    } catch (error) {
      try { await acceptView(store, view, activating); } catch (changed) { error = changed; }
      if (["CHANGED", "INPUT_CHANGED"].includes(error.code)) { superseded++; continue; }
      return failedBuild(store, error, started);
    } finally {
      // Generators can rewrite files even when compilation/publication fails.
      // Without a completed delta, the next validation must parse afresh.
      if (!generatedRefreshed && genHash(store.root) !== view.gen) forgetRegistry(store);
      // a cold build is a new start for the warm registry, primed once the
      // saves have stopped for a while; coalesce a burst of cold saves
      if (w.on === true && !w.disabled && w.compiler?.primed !== true) {
        clearTimeout(w.reprime);
        w.reprime = setTimeout(() => store.warmUp(), WARM_REPRIME_MS);
        w.reprime.unref?.();
      }
    }
  }
}

// A save waits for a running prime only so long: a prime of a large tree on
// a slow host may take minutes, and a hung one is caught only by its own,
// longer deadline. After the bound this save builds cold (the compiler is
// not primed, so the warm path is skipped) while the prime goes on; a prime
// whose view a cold publication changed rebuilds its baseline (warmUp).
async function waitForPrime(store, w) {
  const priming = w.priming;
  if (priming === undefined) return false;
  // one save has waited its bound for this prime; the next ones do not
  if (w.outwaited === priming) return true;
  await measureSpeed();
  const bound = saveWait({store});
  let timer;
  const expired = Symbol("expired");
  const r = await Promise.race([priming.then(() => undefined, () => undefined), new Promise(resolve => {
    timer = setTimeout(() => resolve(expired), bound.ms);
  })]);
  clearTimeout(timer);
  if (r !== expired) return false;
  w.outwaited = priming;
  console.log(`warm: a save stopped waiting for the prime after ${describe(bound)}; it builds cold`);
  return true;
}

function failedBuild(store, error, started) {
  // the transpiler's refusal names each object and line; the rest of
  // the log is for the host's console and never for a client: it
  // carries absolute paths of the machine that built it
  const issues = transpileIssues(error.message);
  console.log(`build failed: ${String(error.message).slice(0, 2000)}${error.output ? `\n${String(error.output).slice(-2000)}` : ""}`);
  return {ok: false, ms: Date.now() - started, objects: 0, check: issues.length > 0, issues,
    output: withoutHostPaths(String(error.output || error.message).slice(-2000), store.root),
    error: withoutHostPaths(String(error.message).split("\n")[0], store.root)};
}
