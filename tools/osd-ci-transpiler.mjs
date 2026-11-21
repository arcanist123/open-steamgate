// Bind the copied CI transpiler tree to the checkout's pinned commit and
// an exact byte list before it is added to a public artifact.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync} from "node:fs";
import {join, relative, resolve} from "node:path";
import {GIT_SAFE, devChildEnv, isolatedGit} from "./osd-env.mjs";
import {privacyNow} from "./osd-read-record.mjs";

const fail = message => { throw Object.assign(new Error(message), {code: "CI_TRANSPILER"}); };
const digest = file => createHash("sha256").update(readFileSync(file)).digest("hex");
const marker = /(^|\/)\.osd-(source|layer)\.json$/;

const git = (dir, args) => execFileSync("git", [...GIT_SAFE, "-C", dir, ...args], {env: isolatedGit(devChildEnv()), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"]});

function filesOf(dir) {
  // a marker above the tree marks it too: public, or it is not shipped
  if (privacyNow(join(realpathSync(dir), ".")) !== false) fail("CI transpiler sits under a private or unknown source identity");
  const files = {};
  const walk = at => {
    for (const entry of readdirSync(at, {withFileTypes: true})) {
      const file = join(at, entry.name);
      const path = relative(dir, file).replaceAll("\\", "/");
      if (marker.test(path)) fail(`source identity inside CI transpiler: ${path}`);
      const stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else if (stat.isFile()) files[path] = digest(file);
      else fail(`unsupported CI transpiler entry: ${path}`);
    }
  };
  walk(dir);
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b)));
}

export function prepareCiTranspiler(root, dir = join(root, ".local/ci-artifact/transpiler")) {
  const pinned = JSON.parse(readFileSync(join(root, "libs.lock.json"), "utf8")).transpiler.ref;
  let commit;
  try { commit = git(dir, ["rev-parse", "HEAD"]).trim(); }
  catch { fail("CI transpiler has no Git commit to compare with the pin"); }
  if (commit !== pinned) fail(`CI transpiler commit differs from pinned ref`);
  try { git(dir, ["diff", "--quiet", "HEAD", "--"]); }
  catch { fail("CI transpiler tracked sources differ from the pinned commit"); }
  // what the build makes is ignored by the clone itself (node_modules,
  // build/); a file neither tracked nor ignored is no part of it
  if (git(dir, ["ls-files", "-z", "--others", "--exclude-standard"]).length) fail("CI transpiler has untracked files");
  const record = {schema: 1, commit, files: filesOf(dir)};
  writeFileSync(join(root, ".local/ci-artifact/transpiler-digests.json"), `${JSON.stringify(record, null, 2)}\n`);
  return record;
}

export function verifyCiTranspiler(root, dir = join(root, ".local/ci-artifact/transpiler")) {
  const path = join(root, ".local/ci-artifact/transpiler-digests.json");
  if (!existsSync(path)) fail("CI transpiler digest list is missing");
  let record;
  try { record = JSON.parse(readFileSync(path, "utf8")); } catch { fail("CI transpiler digest list is invalid"); }
  const pinned = JSON.parse(readFileSync(join(root, "libs.lock.json"), "utf8")).transpiler.ref;
  if (record.schema !== 1 || record.commit !== pinned || !record.files || typeof record.files !== "object")
    fail("CI transpiler digest list does not match the pinned commit");
  if (JSON.stringify(filesOf(resolve(dir))) !== JSON.stringify(record.files))
    fail("CI transpiler files differ from the digest list");
  return record;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const action = process.argv[2];
  try {
    if (action === "prepare") prepareCiTranspiler(process.cwd());
    else if (action === "verify") verifyCiTranspiler(process.cwd());
    else fail("usage: osd-ci-transpiler.mjs prepare|verify");
  } catch (error) { console.error(`${error.code ?? "CI_TRANSPILER"}: ${error.message}`); process.exitCode = 2; }
}
