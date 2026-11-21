import {warnWarmPin} from "./osd-warm-capabilities.mjs";
import {acceptView, captureView} from "./osd-store-compile-view.mjs";
import {waitVerifier} from "./osd-warm-verification.mjs";
import {verifyNext} from "./osd-store-verify.mjs";
import {describe, measureSpeed, warmDeadline} from "./warm-deadline/warm-deadline.mjs";
// Background priming belongs to the compiler process, never the HTTP front.
export function warmUp(store) {
  const w = store.warm();
  if (w.on !== true || w.closed === true || w.disabled === true) return undefined;
  if (w.priming !== undefined) return w.priming;
  // Keep the source baseline stable until the runtime finishes changing hands.
  const changing = store.served?.recycling ?? store.served?.starting;
  if (changing !== undefined) {
    return changing.catch(() => undefined).then(() => store.warmUp());
  }
  w.primeDue = false;
  clearTimeout(w.reprime);
  w.priming = (async () => {
    // The runner's speed sizes the prime's deadline. Measured here, in
    // chunks that yield to requests, before the compiler competes for CPU.
    await measureSpeed();
    const {WarmCompilerProcess} = await import("./osd-warm-process.mjs");
    if (w.closed === true) { w.priming = undefined; return undefined; }
    // primed on the build view: inactive objects as their active copies
    w.compiler ??= new WarmCompilerProcess({root: store.root, log: (m) => console.log(m), overlay: (activating) => store.overlay(activating),
      keyOf: (file) => store.objectKeyOf(file), inactiveSources: (activating) => store.inactiveSources(activating)});
    w.compiler.verifyDeadlineMs = store.warmVerifyLifetimeMs ?? Number(process.env.OSD_WARM_VERIFY_LIFETIME_MS ?? 180000);
    try {
      // Let an already running frozen comparison finish before the bounded
      // full prime. New comparisons wait below; saves still take their turns.
      const verifier = w.compiler.verifying;
      await waitVerifier(verifier, store.warmVerifyDeadlineMs ?? store.warmVerifyWaitMs ?? Number(process.env.OSD_WARM_VERIFY_WAIT_MS ?? 30000));
      for (;;) {
        const view = await captureView(store);
        try {
          const r = await warmOperation(store, () => w.compiler.prime(view), {kind: "prime", files: view.digests?.length ?? 0});
          await acceptView(store, view, new Set(), undefined, true);
          // The synchronous activation validator keeps its own publication
          // registry in the source host. Prime it before admitting hot edits;
          // it is also built on demand by the first activation, so a tree it
          // cannot read yet (no abaplint.jsonc) defers it, never the compiler.
          try { store.registry(); }
          catch (error) { console.log(`warm: activation validator deferred: ${error.message}`); }
          w.reason = undefined;
          return r;
        } catch (error) {
          try { await acceptView(store, view, new Set(), undefined, true); } catch (changed) { error = changed; }
          if (!["CHANGED", "INPUT_CHANGED"].includes(error.code) || w.closed || w.disabled) throw error;
          // Saves landed during prime. Rebuild the baseline from their active
          // copies before advertising the registry as available.
          console.log(`warm: ${error.message}`);
          await w.compiler.drop();
        }
      }
    } catch (error) {
      if (w.closed === true || w.compiler.closing === true) return undefined;
      w.reason = error.message;
      await w.compiler.drop?.();
      if (error.pinMissing === true && !w.pinWarned) {
        warnWarmPin(error.message);
        w.pinWarned = true;
      }
      console.log(`warm: builds stay cold: ${error.message}`);
      return undefined;
    } finally {
      w.priming = undefined;
      verifyNext(store);
    }
  })();
  return w.priming;
}

export async function closeWarm(store) {
  const w = store.warmState;
  if (!w) return;
  w.closed = true;
  clearTimeout(w.reprime);
  clearTimeout(w.timer);
  w.quietArmed = false;
  await w.compiler?.shutdown?.();
  await w.priming;
}

// A dead/silent compiler is an optimization failure. Reap it before a cold
// build takes over the shared build lock, and keep later publications cold.
// The deadline is sized to the work and to the host's measured speed
// (tools/warm-deadline/README.md); the prime logs what it took against it,
// so a real slowdown shows as a shrinking margin rather than as nothing.
export async function warmOperation(store, work, {kind = "operation", files = 0} = {}) {
  const w = store.warm();
  let timer;
  await measureSpeed();
  const deadline = warmDeadline({kind, files, store});
  const ms = deadline.ms;
  if (kind === "prime") console.log(`warm: prime deadline ${describe(deadline)} for ${files} input files`);
  const started = performance.now();
  try {
    const result = await Promise.race([Promise.resolve().then(work), new Promise((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`warm compiler exceeded ${describe(deadline)}`),
        {code: "WARM_UNAVAILABLE"})), ms);
    })]);
    if (kind === "prime") {
      const took = performance.now() - started;
      // per input file and per unit of speed factor: comparable across
      // runners and tree sizes (test/vscode-warm-ready.mjs bounds it)
      const normal = files > 0 ? took / (files * (deadline.factor ?? 1)) : 0;
      console.log(`warm: prime took ${Math.round(took)} ms of its ${ms} ms deadline` +
        ` (${files} input files, speed factor ${(deadline.factor ?? 1).toFixed(2)}, ${normal.toFixed(2)} ms per file per factor)`);
    }
    return result;
  } catch (error) {
    // The update after a cold publication is a catch-up nobody saves into:
    // its timeout drops the compiler (killed above all else) and the caller
    // schedules a prime, whose own deadline turns warm off if the compiler is
    // really silent. Turning warm off here left the host reporting "cold"
    // for good while the log said "re-prime" (adt-lifecycle, 2026-11-14).
    if (error.code === "WARM_UNAVAILABLE" && kind === "update") {
      w.reason = error.message;
      await w.compiler?.drop?.();
    } else if (error.code === "WARM_UNAVAILABLE") {
      w.disabled = true;
      w.primeDue = false;
      w.reason = error.message;
      clearTimeout(w.reprime);
      await w.compiler?.drop?.();
    }
    throw error;
  } finally { clearTimeout(timer); }
}
