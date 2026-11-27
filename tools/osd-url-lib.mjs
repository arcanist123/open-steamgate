// A pinned URL library has a stable local path. The build materializes it
// before naming a generation, so its source bytes and identity enter hashOf.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, mkdtempSync, renameSync, rmSync} from "node:fs";
import {dirname, join} from "node:path";

export function urlLibraryPath(root, lib) {
  if (typeof lib.url !== "string" || !/^[0-9a-f]{40}$/.test(lib.commit ?? "")) return undefined;
  const id = createHash("sha256").update(lib.url).update("\0").update(lib.commit).digest("hex").slice(0, 24);
  return join(root, ".local/url-libs", id);
}

export function ensureUrlLibrary(root, lib) {
  const target = urlLibraryPath(root, lib);
  if (!target) return undefined;
  if (!existsSync(target)) {
    mkdirSync(dirname(target), {recursive: true});
    const scratch = mkdtempSync(`${target}.tmp-`);
    try {
      execFileSync("git", ["clone", "--quiet", "--depth", "1", "--", lib.url, "."], {cwd: scratch, stdio: "pipe"});
      try { execFileSync("git", ["checkout", "--quiet", "--detach", lib.commit], {cwd: scratch, stdio: "pipe"}); }
      catch {
        execFileSync("git", ["fetch", "--quiet", "--depth", "1", "origin", lib.commit], {cwd: scratch, stdio: "pipe"});
        execFileSync("git", ["checkout", "--quiet", "--detach", lib.commit], {cwd: scratch, stdio: "pipe"});
      }
      renameSync(scratch, target);
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  }
  const actual = execFileSync("git", ["-C", target, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
  if (actual !== lib.commit) throw new Error(`URL library cache differs from configured commit: ${lib.url}`);
  execFileSync("git", ["-C", target, "diff", "--quiet", "HEAD", "--"]);
  for (const flags of [["--others", "--exclude-standard"], ["--others", "--ignored", "--exclude-standard"]]) {
    if (execFileSync("git", ["-C", target, "ls-files", ...flags, "-z"]).length)
      throw new Error(`URL library cache has files outside its pinned commit: ${lib.url}`);
  }
  return target;
}
