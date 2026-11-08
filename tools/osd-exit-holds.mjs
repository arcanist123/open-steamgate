// What a signal handler started and the process must see finished before it
// exits. Several modules handle SIGTERM in one process, but only the runtime
// supervisor calls process.exit (tools/osd-runtime.mjs): another handler that
// kills children of its own registers their exit here, and the supervisor
// awaits it, so nothing it started is still running once the process is gone.
const holds = new Set();

export function holdExit(promise) {
  const held = Promise.resolve(promise).catch(() => undefined);
  holds.add(held);
  held.finally(() => holds.delete(held));
  return held;
}

/** resolves when every hold has settled, or after `ms` at the latest */
export async function exitHolds(ms = 10000) {
  let timer;
  try {
    await Promise.race([Promise.all([...holds]), new Promise((resolve) => { timer = setTimeout(resolve, ms); })]);
  } finally { clearTimeout(timer); }
}
