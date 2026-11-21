import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, lstatSync, readdirSync, readFileSync} from "node:fs";
import {join, relative, resolve, sep} from "node:path";
import {verifyPublicArtefact} from "./osd-provenance.mjs";
import {readEntry} from "./osd-read-record.mjs";
import {GIT_SAFE, devChildEnv, isolatedGit} from "./osd-env.mjs";

const git = (args, options = {}) => execFileSync("git", [...GIT_SAFE, ...args], {env: isolatedGit(devChildEnv()), stdio: ["ignore", "pipe", "pipe"], ...options});
// the bytes on disk as a Git blob id: skip-worktree and assume-unchanged
// hide a change from git's own diff, never from the bytes
const blobOf = (bytes, length) => createHash(length === 64 ? "sha256" : "sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
const fail = message => { const error = new Error(message); error.code = "BAD_PROVENANCE"; throw error; };

export function assertPublicExtensionIdentity(extension, part) {
  const visit = path => {
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail(`extension source link is unreviewed: ${path}`);
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name));
    else if (!stat.isFile() || readEntry(extension, path, readFileSync(path)).privacy !== false)
      fail(`extension source identity is private or unknown: ${path}`);
  };
  visit(resolve(extension, part));
}

/** Static extension files must be in a reviewed Git closure or a verified
 * directory artefact. Generated dist/web is checked by its own sidecar. */
export function assertExtensionSources(extension, parts) {
  const privacy = readEntry(extension, join(extension, "package.json"), readFileSync(join(extension, "package.json"))).privacy;
  if (privacy !== false) fail(`extension source identity is ${privacy === true ? "private" : "unknown"}`);
  if (existsSync(join(extension, ".osd-provenance.json"))) {
    verifyPublicArtefact(extension);
    assertPublicExtensionIdentity(extension, ".");
    return;
  }
  let top, tracked;
  try {
    top = git(["-C", extension, "rev-parse", "--show-toplevel"], {encoding: "utf8"}).trim();
    const prefix = relative(top, extension) || ".";
    if (prefix === ".." || prefix.startsWith(`..${sep}`)) fail("extension leaves Git checkout");
    tracked = new Map(git(["-C", top, "ls-tree", "-r", "-z", "HEAD", "--", prefix]).toString().split("\0").filter(Boolean)
      .map(line => { const tab = line.indexOf("\t"); return [line.slice(tab + 1), line.slice(0, tab).split(" ")]; })
      .filter(([, [, type]]) => type === "blob").map(([path, [mode, , id]]) => [path, {mode, id}]));
    const paths = parts.map(part => relative(top, resolve(extension, part)).split(sep).join("/"));
    git(["-C", top, "diff", "--quiet", "HEAD", "--", ...paths]);
    for (const flags of [["--others", "--exclude-standard"], ["--others", "--ignored", "--exclude-standard"]]) {
      const extra = git(["-C", top, "ls-files", ...flags, "-z", "--", ...paths]);
      if (extra.length) fail("extension contains untracked or ignored files");
    }
  } catch { fail("extension static files need a verified directory or Git tracked closure"); }
  const visit = path => {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink()) fail(`extension source link is unreviewed: ${path}`);
    if (entry.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
    } else {
      const blob = tracked.get(relative(top, path).split(sep).join("/"));
      if (!entry.isFile() || blob === undefined || blob.mode === "120000") fail(`extension source is untracked: ${path}`);
      if (blobOf(readFileSync(path), blob.id.length) !== blob.id) fail(`extension source differs from HEAD: ${path}`);
      if (readEntry(extension, path, readFileSync(path)).privacy !== false)
        fail(`extension source identity is private or unknown: ${path}`);
    }
  };
  for (const part of parts) visit(resolve(extension, part));
}
