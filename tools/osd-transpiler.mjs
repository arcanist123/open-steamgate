// Which transpiler built this.
//
// We sometimes run a locally built transpiler rather than the published one,
// because a fix we need is not released yet. That is a reasonable thing to
// do and a terrible thing to forget: a tree that quietly differs from a
// clean clone is how "it works here and not in CI" happens, and we have paid
// for that once already.
//
// So every transpile says which one it used, and it says it in the build log
// rather than in somebody's memory. A green run here and a red run in CI is
// then one line apart from being explained.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {transpilerLocation} from "./osd-transpile.mjs";
import {existsSync, lstatSync, readFileSync, realpathSync, readdirSync, statSync} from "node:fs";
import {dirname, join, relative, sep} from "node:path";
import {createRequire} from "node:module";
import {runsAs} from "./osd-main.mjs";

const require = createRequire(import.meta.url);

// Two packages decide what a tree does, and only one of them is usually
// linked: the transpiler writes the code, the runtime executes it. A fix in
// one arrives on a rebuild and a fix in the other does not, and from the
// outside they look the same, so both are reported rather than the one we
// happen to have linked.
export function packageInUse(root, name, at = join(root, "node_modules", "@abaplint", name)) {
  if (existsSync(at) === false) {
    return {kind: "missing", where: at};
  }

  const real = realpathSync(at);
  // a link, or a package that lives outside this tree's node_modules
  // altogether (the transpiler library reached through the CLI's own
  // location, tools/osd-transpile.mjs): either way a local build
  const linked = lstatSync(at).isSymbolicLink() || real.startsWith(join(realpathSync(root), "node_modules")) === false;
  const version = JSON.parse(readFileSync(join(real, "package.json"), "utf8")).version;

  if (linked === false) {
    return {kind: "published", version, where: real};
  }

  // a linked build is a working tree, so the interesting part is which
  // commit of it, not which version it calls itself
  let branch;
  let commit;
  let fullCommit;
  let dirty;
  try {
    const git = (...args) => execFileSync("git", args, {cwd: real, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]}).trim();
    branch = git("rev-parse", "--abbrev-ref", "HEAD");
    commit = git("rev-parse", "--short", "HEAD");
    fullCommit = git("rev-parse", "HEAD");
    // only tracked changes count: an untracked note beside the checkout
    // does not change what the build does, and saying it does would train
    // everyone to ignore the warning
    dirty = git("-c", "core.fileMode=false", "status", "--porcelain", "--untracked-files=no").length > 0;
  } catch {
    // not a git tree, or git is not there: the path is still the answer
  }
  return {kind: "linked", version, where: real, branch, commit, fullCommit, dirty};
}

// the transpiler is the library, since the build calls it in-process (N3);
// where the library is not installed in this tree it is found the way the
// CLI finds it, and described from there
export function transpilerInUse(root = process.cwd()) {
  const installed = join(root, "node_modules", "@abaplint", "transpiler");
  if (existsSync(installed)) {
    return withPinnedRef(packageInUse(root, "transpiler"), root);
  }
  try {
    return withPinnedRef(packageInUse(root, "transpiler", transpilerLocation(root)), root);
  } catch {
    return {kind: "missing", where: installed};
  }
}

// the build `npm run transpiler:pin` makes is the intended one, not a local
// experiment: same commit as libs.lock.json and no tracked changes
function withPinnedRef(found, root) {
  if (found.kind !== "linked" || found.dirty) return found;
  let pinned;
  try {
    pinned = JSON.parse(readFileSync(join(root, "libs.lock.json"), "utf8")).transpiler;
  } catch {
    return found;
  }
  return pinned && found.fullCommit === pinned.ref ? {...found, pinnedRepo: pinned.repo} : found;
}

export function runtimeInUse(root = process.cwd()) {
  return withPinnedRef(packageInUse(root, "runtime"), root);
}

function describeOne(label, pkg, found) {
  switch (found.kind) {
    case "missing":
      return `${label}: none installed at ${found.where}`;
    case "published":
      return `${label}: @abaplint/${pkg} ${found.version}, published`;
    default:
      if (found.pinnedRepo) {
        return `${label}: the pinned build of ${found.pinnedRepo} ${found.fullCommit.slice(0, 8)} (libs.lock.json), at ${found.where}, calling itself ${found.version}`;
      }
      return `${label}: a LOCAL BUILD, ${found.where}`
        + (found.branch ? ` (${found.branch} ${found.commit}${found.dirty ? ", uncommitted changes" : ""})` : "")
        + `, calling itself ${found.version}. A clean clone will not build this way.`;
  }
}

export function describeTranspiler(root = process.cwd()) {
  return describeOne("transpiler", "transpiler", transpilerInUse(root));
}

export function describeRuntime(root = process.cwd()) {
  return describeOne("runtime", "runtime", runtimeInUse(root));
}

export function describeBuild(root = process.cwd()) {
  return describeTranspiler(root) + "\n" + describeRuntime(root);
}

// Diagnostics describe the checkout; identity describes the code. A git
// commit alone misses rebuilt/untracked distribution files in a checkout.
// Use the same content identity for linked and materialised packages.
const CONTENT_DIGESTS = new Map();
const PUBLISHED_IDENTITIES = new Map();
function contentDigest(file) {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  const cached = CONTENT_DIGESTS.get(file);
  if (cached?.key === key) return cached.digest;
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  if (Date.now() - st.mtimeMs > 2000) CONTENT_DIGESTS.set(file, {key, digest});
  else CONTENT_DIGESTS.delete(file);
  return digest;
}

export function packageIdentity(at, name) {
  if (!existsSync(at)) return {name, missing: true};
  const real = realpathSync(at);
  // An installed release is immutable for this process. A package symlink
  // or a realpath outside node_modules is a local build:
  // continue checking its files on every call.
  const published = !lstatSync(at).isSymbolicLink()
    && real.split(sep).includes("node_modules");
  if (published && PUBLISHED_IDENTITIES.has(real)) return PUBLISHED_IDENTITIES.get(real);
  const meta = JSON.parse(readFileSync(join(at, "package.json"), "utf8"));
  const h = createHash("sha256");
  const walk = dir => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      // Distribution maps and TypeScript declarations are not executed;
      // packaging drops maps, so they must not change the identity.
      else if (!entry.name.endsWith(".map") && !entry.name.endsWith(".d.ts")) {
        h.update(relative(at, file).split(sep).join("/")).update("\0").update(contentDigest(file)).update("\0");
      }
    }
  };
  if (existsSync(join(at, "build"))) walk(join(at, "build"));
  const identity = {name: meta.name ?? name, version: meta.version, main: meta.main, exports: meta.exports, type: meta.type,
    content: h.digest("hex")};
  if (published) PUBLISHED_IDENTITIES.set(real, identity);
  return identity;
}

export function buildIdentity(root = process.cwd()) {
  const installed = join(root, "node_modules", "@abaplint", "transpiler");
  let transpiler = installed;
  if (!existsSync(transpiler)) {
    try { transpiler = transpilerLocation(root); } catch { /* missing, reported without a location */ }
  }
  return JSON.stringify([
    packageIdentity(transpiler, "@abaplint/transpiler"),
    packageIdentity(join(root, "node_modules", "@abaplint", "runtime"), "@abaplint/runtime"),
  ]);
}

if (runsAs("osd-transpiler.mjs")) {
  // as a build's generator, the build's own description: describing it here
  // runs `git status` over the transpiler checkout, outside the read record
  let verified;
  try { verified = JSON.parse(process.env.OSD_BUILD_VERIFIED ?? "{}").toolchain; } catch { verified = undefined; }
  console.log(process.env.OSD_GENERATOR_READS && typeof verified === "string" ? verified : describeBuild());
  process.exit(0);
}

// This is a hard build refusal, not NotWarm: a cold fallback in this same
// process would still execute the cached old modules under a new name.
export function assertToolchain(root, loaded) {
  if (loaded.identity !== buildIdentity(root)) {
    const error = new Error("the transpiler/runtime changed since this process started; restart the server (or run `osd build`)");
    error.code = "TOOLCHAIN_CHANGED";
    throw error;
  }
  return loaded.identity;
}
