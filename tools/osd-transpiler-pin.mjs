// Local installation uses the same build gate and direct links as CI.
import {existsSync, lstatSync, realpathSync} from "node:fs";
import {homedir, tmpdir} from "node:os";
import {dirname, isAbsolute, join, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync, spawnSync} from "node:child_process";
import {readLock} from "./osd-lock.mjs";
import {runsAs} from "./osd-main.mjs";

const tools = dirname(fileURLToPath(import.meta.url));

// The four links CI makes after it verifies the build (.github/workflows/
// tests.yml, "Verify and link the pinned transpiler"): the library the build
// calls in-process, the CLI, the runtime the generated code executes
// against, and the parser the pinned tree vendors. One list, so CI and
// bootstrap cannot drift into linking different sets.
const PIN_PACKAGES = [
  ["transpiler", "packages/transpiler"],
  ["transpiler-cli", "packages/cli"],
  ["runtime", "packages/runtime"],
  ["core", "packages/transpiler/node_modules/@abaplint/core"],
];

const within = (path, parent) => path === parent || path.startsWith(parent + sep);
function canonical(path) {
  if (existsSync(path)) return realpathSync(path);
  return join(canonical(dirname(path)), path.slice(dirname(path).length + 1));
}

export function pinPath(ref, env = process.env) {
  const path = resolve(env.TRANSPILER ?? join(homedir(), ".cache", "osd", `transpiler-${ref}`));
  const real = canonical(path);
  const temporary = ["/tmp", "/var/tmp", tmpdir(), env.TMPDIR, env.RUNNER_TEMP].filter(Boolean).map(p => canonical(resolve(p)));
  if (temporary.some(p => within(real, p)) || /(?:^|[/\\])(?:tmp|scratch(?:pad)?(?:[-_.][^/\\]*)?|session(?:s|[-_.][^/\\]+))(?:[/\\]|$)/i.test(real)) {
    throw new Error(`TRANSPILER must be persistent, outside temporary directories and session scratchpads: ${path}`);
  }
  return path;
}

// $TRANSPILER may be given relative (the CLI's `../transpiler` beside the
// checkout). Resolve it against the tree being installed, not against the
// process cwd, which a library caller such as bootstrap does not control.
function scopedEnv(root, env) {
  const given = env.TRANSPILER;
  return given !== undefined && !isAbsolute(given) ? {...env, TRANSPILER: resolve(root, given)} : env;
}

// What the link at node_modules/@abaplint/<name> resolves to, or undefined
// when there is no link: a published package is a real directory, and that
// is the state a fresh `npm ci` leaves.
function currentTarget(at) {
  try {
    if (!lstatSync(at).isSymbolicLink()) return undefined;
    return realpathSync(at);
  } catch { return undefined; }
}

function runBuilder(root, env, action, stdio = "inherit") {
  const r = spawnSync("bash", [join(tools, "osd-ci-transpiler-build.sh"), action], {cwd: root, env, stdio});
  if (r.error) throw r.error;
  return r.status === 0;
}

// The state CI's own steps leave behind: all four links into one checkout,
// that checkout clean at the pinned commit, the build verified. bootstrap
// leaves such a tree alone without resolving the pin path itself -- CI
// points TRANSPILER at runner storage, which pinPath refuses by design
// (a pin must be persistent). Anything short of this state falls through to
// installPin, which replaces whatever misses.
function linkedCheckout(root, {repo, ref}, env) {
  const targets = PIN_PACKAGES.map(([name]) => currentTarget(join(root, "node_modules", "@abaplint", name)));
  if (targets.some((target) => target === undefined)) return undefined;
  // Each target is join(clone, path) for its entry above; strip the first
  // entry's path back off to get the clone (dirname alone would stop a
  // level short and hand the builder "packages" as the checkout).
  const clone = targets[0].slice(0, targets[0].length - PIN_PACKAGES[0][1].length - sep.length);
  if (!targets.every((target) => within(target, clone))) return undefined;
  const git = (...args) => execFileSync("git", args, {cwd: clone, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
  try {
    if (git("-c", "core.fileMode=false", "status", "--porcelain", "--untracked-files=no") !== "") return undefined;
    if (git("rev-parse", "HEAD") !== ref) return undefined;
  } catch { return undefined; }
  const childEnv = {...env, TRANSPILER: clone, OSD_TRANSPILER_REPO: `https://github.com/${repo}.git`, OSD_TRANSPILER_REF: ref};
  return runBuilder(root, childEnv, "verify", "ignore") ? clone : undefined;
}

export function installPin(root = process.cwd(), env = process.env, say = console.log) {
  const {repo, ref} = readLock(root).transpiler;
  const clone = pinPath(ref, env);
  const childEnv = {...env, TRANSPILER: clone, OSD_TRANSPILER_REPO: `https://github.com/${repo}.git`, OSD_TRANSPILER_REF: ref};
  const run = (cmd, args, stdio = "inherit") => {
    const r = spawnSync(cmd, args, {cwd: root, env: childEnv, stdio});
    if (r.error) throw r.error;
    return r.status === 0;
  };
  if (!runBuilder(root, childEnv, "verify", "ignore")) {
    if (!run("bash", [join(tools, "osd-ci-transpiler-build.sh"), existsSync(clone) ? "rebuild" : "build"])) throw new Error("Pinned transpiler build failed");
  } else say(`transpiler:pin: reusing verified build ${clone}`);
  let replaced = 0;
  let kept = 0;
  for (const [name, path] of PIN_PACKAGES) {
    const at = join(resolve(root), "node_modules", "@abaplint", name);
    if (currentTarget(at) === realpathSync(join(clone, path))) { kept++; continue; } // already at the pin: left alone
    if (!run(process.execPath, [join(tools, "osd-link.mjs"), name, path])) throw new Error(`Could not link ${name}`);
    say(`transpiler:pin: @abaplint/${name} was not at the pin; linked ${clone}/${path}`);
    replaced++;
  }
  say(`transpiler:pin: ${replaced} of ${PIN_PACKAGES.length} links replaced, ${kept} already at the pin`);
  if (!run(process.execPath, [join(tools, "osd-transpiler.mjs")])) throw new Error("Could not describe pinned transpiler");
  return clone;
}

// The one place the pinned build is decided, and the one bootstrap calls
// after its setup and before its transpile. Links already at the verified
// pin stay (a release or smoke workflow links before it bootstraps, and its
// TRANSPILER may point somewhere pinPath refuses); every other state goes
// through installPin, which verifies or builds the pin and replaces what
// misses -- reported. With no usable pin it refuses, and the tree keeps the
// published packages rather than building on them. Returns the checkout the
// links resolve into.
export function ensurePinned(root = process.cwd(), env = process.env, say = console.log) {
  const at = resolve(root);
  const locked = readLock(at).transpiler;
  const env2 = scopedEnv(at, env);
  const already = linkedCheckout(at, locked, env2);
  if (already !== undefined) {
    say(`transpiler:pin: the links already point at the verified pinned build; leaving them alone (${already})`);
    return already;
  }
  installPin(at, env2, say);
  return pinPath(locked.ref, env2);
}

if (runsAs("osd-transpiler-pin.mjs")) {
  try { installPin(); } catch (error) { console.error(`transpiler:pin: ${error.message}`); process.exitCode = 1; }
}
