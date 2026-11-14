// How long the front lets the warm compiler work before it calls it silent,
// kills it and builds cold. See README.md beside this file.
import {createHash} from "node:crypto";

// A save, a check, an update: one object and its readers. Measured at
// ~0.5 s on a workstation; 30 s has been the bound since warm compile began.
export const OPERATION_MS = 30000;
// The full prime is a whole-tree transpile, and it costs per input file:
// 37.8 s for 6924 input files (5.5 ms each) on the reference machine
// (README.md). Three times that, so a hung compiler is still caught.
export const PRIME_MS_PER_FILE = 16;
// Never below the bound every host had before the prime was sized. The
// prime runs in the background, so its own ceiling is long; what a person
// waits for is bounded separately (SAVE_WAIT_MS, OPERATION_CEILING_MS).
export const PRIME_FLOOR_MS = 30000;
export const CEILING_MS = 15 * 60000;
export const OPERATION_CEILING_MS = 2 * 60000;
// How long a save waits for a running prime before it builds cold and lets
// the prime go on: about 1.6x a normal prime of today's tree.
export const SAVE_WAIT_MS = 60000;
export const SAVE_WAIT_CEILING_MS = 3 * 60000;
// The calibration below takes this long, as the best of three rounds, on the
// machine PRIME_MS_PER_FILE was measured on. A runner that needs longer for
// the same work is that much slower, and so is its prime.
export const REFERENCE_CALIBRATION_MS = 60;
export const FACTOR_FLOOR = 1;
export const FACTOR_CEILING = 8;

const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const positive = value => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
};

// A fixed single-threaded workload of the kind a prime is made of: strings
// built and split, small objects allocated, JSON and a hash. It reads the
// speed the host gives this process now, contention included, which is what
// the prime will get. Best of three rounds, so a GC pause or the JIT warming
// up does not count as a slow machine. A round is ten chunks of ~6 ms.
const CHUNKS = 10;
let sink = 0;
function chunk(k) {
  const started = performance.now();
  const parts = [];
  for (let i = 0; i < 2000; i++) parts.push(`DATA lv_${i} TYPE i VALUE ${i * 7 + k}.`);
  const text = parts.join("\n");
  const tokens = text.split(/\s+/).map((s, i) => ({s, i, u: s.toUpperCase()}));
  sink += JSON.parse(JSON.stringify(tokens)).length + createHash("sha1").update(text).digest()[0];
  return performance.now() - started;
}

// For a process that serves nothing (a test harness): all at once.
export function calibrate(rounds = 3) {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    let round = 0;
    for (let k = 0; k < CHUNKS; k++) round += chunk(k);
    best = Math.min(best, round);
  }
  return best;
}

// For the HTTP front: the same work, yielding to the event loop after every
// chunk, so a request waits at most one chunk (~6 ms, more on a slow host).
// Only the chunks' own time is counted, not the requests served in between.
export async function calibrateAsync(rounds = 3) {
  let best = Infinity;
  for (let r = 0; r < rounds; r++) {
    let round = 0;
    for (let k = 0; k < CHUNKS; k++) {
      round += chunk(k);
      await new Promise(resolve => setImmediate(resolve));
    }
    best = Math.min(best, round);
  }
  return best;
}

let measured;
let measuring;
const factorOf = ms => ({factor: clamp(ms / REFERENCE_CALIBRATION_MS, FACTOR_FLOOR, FACTOR_CEILING), source: "calibration", calibrationMs: ms});
const forcedOf = env => {
  const forced = positive(env.OSD_WARM_SPEED_FACTOR);
  return forced === undefined ? undefined : {factor: clamp(forced, FACTOR_FLOOR, FACTOR_CEILING), source: "OSD_WARM_SPEED_FACTOR"};
};
// The runner-speed factor: 1 on a machine like the reference or faster,
// above 1 on a slower one, clamped to [FACTOR_FLOOR, FACTOR_CEILING].
// OSD_WARM_SPEED_FACTOR sets it outright (a CI job that knows its runner).
// Measured once per process; synchronously only if nothing measured it yet.
export function speed(env = process.env, measure = calibrate) {
  const forced = forcedOf(env);
  if (forced !== undefined) return forced;
  if (measure === calibrate && measured !== undefined) return measured;
  const result = factorOf(measure());
  if (measure === calibrate) measured = result;
  return result;
}
// The front's way: measured off the event loop's critical path, then cached
// for the synchronous speed() and warmDeadline() calls that follow.
export async function measureSpeed(env = process.env) {
  const forced = forcedOf(env);
  if (forced !== undefined) return forced;
  if (measured !== undefined) return measured;
  measuring ??= calibrateAsync().then(ms => (measured = factorOf(ms)));
  return measuring;
}
// A test harness that waits for a host to start and prime scales its own
// timeouts by the same factor, so the warm deadline is never the longer wait.
export function scaled(ms, env = process.env) {
  return Math.round(ms * speed(env).factor);
}

// The deadline for one warm operation. `kind` is "prime" (sized by `files`),
// "update" (the registry's catch-up after a cold publication: it re-transpiles
// the closure of what the cold build changed -- 209 objects in 13-29 s on CI
// after an interface is created -- so it is sized like the prime it can at
// most be, never like one save) or anything else (one save). An explicit store.warmDeadlineMs wins for
// every kind (tests that want a hang caught fast), then the environment:
// OSD_WARM_PRIME_DEADLINE_MS for the prime, OSD_WARM_DEADLINE_MS for the
// rest. Otherwise the default times the speed factor, within the bounds.
export function warmDeadline({kind, files = 0, store = {}, env = process.env, measure = calibrate} = {}) {
  const explicit = positive(store.warmDeadlineMs);
  if (explicit !== undefined) return {ms: explicit, source: "store.warmDeadlineMs"};
  const fixed = positive(kind === "prime" ? env.OSD_WARM_PRIME_DEADLINE_MS : env.OSD_WARM_DEADLINE_MS);
  if (fixed !== undefined) return {ms: fixed, source: kind === "prime" ? "OSD_WARM_PRIME_DEADLINE_MS" : "OSD_WARM_DEADLINE_MS"};
  const s = speed(env, measure);
  const prime = kind === "prime" || kind === "update";
  const base = prime ? Math.max(PRIME_FLOOR_MS, files * PRIME_MS_PER_FILE) : OPERATION_MS;
  return {ms: Math.round(clamp(base * s.factor, prime ? PRIME_FLOOR_MS : OPERATION_MS, prime ? CEILING_MS : OPERATION_CEILING_MS)),
    source: s.source, factor: s.factor, calibrationMs: s.calibrationMs, base};
}

// How long a save waits for a running prime before it gives up on warm for
// this build and builds cold; the prime goes on and serves later saves.
// store.warmSaveWaitMs, then OSD_WARM_SAVE_WAIT_MS, then 60 s x factor
// within [60 s, 3 min].
export function saveWait({store = {}, env = process.env, measure = calibrate} = {}) {
  const explicit = positive(store.warmSaveWaitMs);
  if (explicit !== undefined) return {ms: explicit, source: "store.warmSaveWaitMs"};
  const fixed = positive(env.OSD_WARM_SAVE_WAIT_MS);
  if (fixed !== undefined) return {ms: fixed, source: "OSD_WARM_SAVE_WAIT_MS"};
  const s = speed(env, measure);
  return {ms: Math.round(clamp(SAVE_WAIT_MS * s.factor, SAVE_WAIT_MS, SAVE_WAIT_CEILING_MS)),
    source: s.source, factor: s.factor, calibrationMs: s.calibrationMs, base: SAVE_WAIT_MS};
}

export function describe(d) {
  if (d.factor === undefined) return `${d.ms} ms (${d.source})`;
  const cal = d.calibrationMs === undefined ? "" : `, calibration ${d.calibrationMs.toFixed(1)} ms against ${REFERENCE_CALIBRATION_MS}`;
  return `${d.ms} ms (base ${d.base} ms x speed factor ${d.factor.toFixed(2)} from ${d.source}${cal})`;
}
