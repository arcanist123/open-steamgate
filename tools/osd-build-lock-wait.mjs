// A build that finds the build lock held waits a bounded time for it instead
// of answering BUSY at once. In one serving process the store builds one at a
// time, so what holds the lock under it is a frozen verification pinning or
// settling its generation (microseconds), or a build of another process
// (minutes). Refusing at once failed an explicit activation in adt-lifecycle
// (2026-11-14, #946) because a verification settled in the same second.
import {lock} from "./osd-build.mjs";

export const BUILD_LOCK_WAIT_MS = 10000;
const POLL_MS = 100;

let said;
// store.buildLockWaitMs, then OSD_BUILD_LOCK_WAIT_MS, then the default; a value
// that is not a positive number (an empty variable) is the default, not zero
export function buildLockWait(store = {}, env = process.env) {
  for (const [value, source] of [[store.buildLockWaitMs, "store.buildLockWaitMs"], [env.OSD_BUILD_LOCK_WAIT_MS, "OSD_BUILD_LOCK_WAIT_MS"]]) {
    if (value === undefined || value === "") continue;
    const n = Number(value);
    if (Number.isFinite(n) && n > 0) return {ms: n, source};
    if (said !== `${source}=${value}`) {
      said = `${source}=${value}`;
      console.log(`build: ${source}=${JSON.stringify(String(value))} is not a positive number; waiting ${BUILD_LOCK_WAIT_MS} ms for the build lock`);
    }
  }
  return {ms: BUILD_LOCK_WAIT_MS, source: "default"};
}

// work(options) is a build. The first attempt is the build as it always was:
// its own read-only preamble, then its own lock take. Only when that answers
// BUSY does this wait, and then for the lock alone:
// - with `paths`, the lock is polled here, and once taken the build runs once
//   more with {lockHeld: true}, under it -- its preamble (a whole-tree hash for
//   a cold build) runs a second time, never once per poll;
// - without `paths` the build is retried as it is, which is right only for a
//   build whose first statement is the lock take (the warm compiler's).
// After the bound the last BUSY is thrown, naming the holder.
export async function whenLockFree(store, work, {paths, env = process.env} = {}) {
  try {
    return await work({});
  } catch (error) {
    if (error?.code !== "BUSY") throw error;
    const until = Date.now() + buildLockWait(store, env).ms;
    let busy = error;
    while (Date.now() < until) {
      await new Promise(resolve => setTimeout(resolve, Math.min(POLL_MS, Math.max(1, until - Date.now()))));
      if (paths === undefined) {
        try {
          return await work({});
        } catch (again) {
          if (again?.code !== "BUSY") throw again;
          busy = again;
        }
        continue;
      }
      let unlock;
      try {
        unlock = lock(paths);
      } catch (again) {
        if (again?.code !== "BUSY") throw again;
        busy = again;
        continue;
      }
      try {
        console.log("build: the build lock came free; building");
        return await work({lockHeld: true});
      } finally {
        unlock();
      }
    }
    throw busy;
  }
}
