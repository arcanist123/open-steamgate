// Every cold entry uses the persistent store view. A captured activation
// overlay is authoritative even when undefined (all drafts are being built).
export async function sourceBuildOverlay(root, options = {}) {
  if (Object.hasOwn(options, "overlay")) return options.overlay;
  return (await sourceBuildStore(root)).overlay();
}
export async function sourceBuildStore(root) {
  const {ObjectStore} = await import("./osd-store.mjs");
  return new ObjectStore({root});
}

// Hosts that load the default output prepare it before importing modules.
// A supervised child is pinned to a generation its source host published;
// rebuilding there would discard an activation still awaiting completion.
const starting = new Map();
export async function ensureSourceBuild(root, env = process.env) {
  if (env.OSD_OUTPUT || env.OSD_GENERATION) return;
  if (starting.has(root)) return starting.get(root);
  const {build, layout} = await import("./osd-build.mjs");
  const {whenLockFree} = await import("./osd-build-lock-wait.mjs");
  // Another start may have reached the import while it was loading.
  if (starting.has(root)) return starting.get(root);
  // a start that meets a verifier's momentary lock waits for it, as a save does
  const work = whenLockFree({}, held => build({root, ...held}), {paths: layout(root)});
  starting.set(root, work);
  try { return await work; }
  finally { if (starting.get(root) === work) starting.delete(root); }
}
