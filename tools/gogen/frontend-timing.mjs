// @ts-check
// Runtime-only opt-in counters; importing the compiler performs no host action.
/** @typedef {{round: number, enabled: boolean, phases: Map<string, number>, active: Set<string>}} TimingState */
/** @type {TimingState | undefined} */
let current;
export function frontendRound() { return current?.round ?? 1; }
export function timingEnabled() {
  return process.env.OSABAP_TIMING === "1" || !!process.env.GOGEN_CACHE_DIAGNOSTICS;
}
export function beginFrontendRound(round = 1) {
  /** @type {Map<string, number>} */ const phases = new Map();
  /** @type {Set<string>} */ const active = new Set();
  current = {round, enabled: timingEnabled(), phases, active};
}
/** @template T @param {string} phase @param {() => T} run @returns {T} */
export function timedFrontend(phase, run) {
  if (!current?.enabled || current.active.has(phase)) return run();
  const state = current, start = performance.now(); state.active.add(phase);
  try { return run(); }
  finally {
    state.active.delete(phase);
    state.phases.set(phase, (state.phases.get(phase) ?? 0) + performance.now() - start);
  }
}
/** @param {number} value @returns {number} */ function roundedMillis(value) {
  const fraction = value % 1;
  if (value === 0 || fraction !== fraction) return value;
  const whole = value - fraction;
  if (fraction >= 0.5) return whole + 1;
  if (fraction < -0.5) return whole - 1;
  return value < 0 && whole === 0 ? -0 : whole;
}
export function finishFrontendRound() {
  if (!current?.enabled) return [];
  const rows = ["graphLoading", "certificateValidation", "observation", "replay", "finalization"]
    // @ts-expect-error -- abapiti form pending
    .map((phase) => ({phase, round: current.round, ms: roundedMillis(current.phases.get(phase) ?? 0)}));
  if (process.env.OSABAP_TIMING === "1") for (const row of rows)
    console.error(`OSABAP_TIMING ${JSON.stringify(row)}`);
  return rows;
}
