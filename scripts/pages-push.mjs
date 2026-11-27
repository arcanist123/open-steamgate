// Apply one Pages change on the latest gh-pages tip. Separate PR and main
// workflows can race; a rejected push must rebuild its commit from a fresh
// fetch so it retains every other preview and the current index.
import {cp, mkdtemp, rm, writeFile} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {promisify} from "node:util";
import {execFile} from "node:child_process";
import {renderPreviewIndex} from "./pages-index.mjs";
import {assertPublicSystem} from "../tools/osd-system.mjs";
import {verifyPublicArtefact} from "../tools/osd-provenance.mjs";

const exec = promisify(execFile);
const repository = process.cwd();
const [operation, directory, source] = process.argv.slice(2);
const attempts = 3;

function git(where, ...args) {
  return exec("git", ["-C", where, ...args]);
}

async function applyChange(pages) {
  if (operation === "publish") {
    await rm(join(pages, directory), {recursive: true, force: true});
    await cp(resolve(source), join(pages, directory), {recursive: true});
    await git(pages, "add", "-A", "--", directory);
    return `Deploy ${directory} from ${process.env.GITHUB_SHA ?? "local"}`;
  }
  if (operation === "remove") {
    await rm(join(pages, directory), {recursive: true, force: true});
    const {stdout: tracked} = await git(pages, "ls-files", "--", directory);
    if (tracked.trim()) await git(pages, "add", "-A", "--", directory);
  }
  await writeFile(join(pages, "index.html"), await renderPreviewIndex(pages));
  await git(pages, "add", "index.html");
  return operation === "remove" ? `Remove ${directory}` : "Refresh preview index";
}

async function main() {
  if (!["publish", "index", "remove"].includes(operation)
      || ((operation === "publish" || operation === "remove") && !/^(main|pr-[1-9][0-9]*)$/.test(directory))
      || (operation === "publish" && !source)
      || (operation === "index" && (directory || source))) {
    throw new Error("Usage: pages-push.mjs publish <main|pr-N> <build-dir> | index | remove <main|pr-N>");
  }
  if (operation === "publish") { assertPublicSystem(repository); verifyPublicArtefact(resolve(source)); }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    // FETCH_HEAD is the actual fetched commit even in a shallow checkout;
    // fetching only to FETCH_HEAD would not refresh origin/gh-pages.
    await git(repository, "fetch", "--no-tags", "origin", "gh-pages");
    const {stdout: tip} = await git(repository, "rev-parse", "FETCH_HEAD");
    const temporary = await mkdtemp(join(tmpdir(), "osd-pages-push-"));
    const pages = join(temporary, "pages");
    let added = false;
    let retry = false;
    try {
      await git(repository, "worktree", "add", "--detach", pages, tip.trim());
      added = true;
      const message = await applyChange(pages);
      const {stdout: changes} = await git(pages, "diff", "--cached", "--name-only");
      if (!changes.trim()) {
        console.log(`Pages ${operation}: already current`);
        return;
      }
      await git(pages, "config", "user.name", "github-actions[bot]");
      await git(pages, "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com");
      await git(pages, "commit", "-q", "-m", message);
      try {
        await git(pages, "push", "origin", "HEAD:refs/heads/gh-pages");
        console.log(`Pages ${operation}: pushed on attempt ${attempt}/${attempts}`);
        return;
      } catch (error) {
        // Check the remote tip rather than parsing Git's rejection text: a
        // server-side ref lock race may say "remote rejected" instead.
        if (attempt === attempts) throw error;
        const {stdout: remote} = await git(repository, "ls-remote", "origin", "refs/heads/gh-pages");
        if (remote.split(/\s+/)[0] === tip.trim()) throw error;
        retry = true;
        console.log(`Pages ${operation}: gh-pages advanced; retrying (${attempt + 1}/${attempts})`);
      }
    } finally {
      if (added) await git(repository, "worktree", "remove", "--force", pages);
      await rm(temporary, {recursive: true, force: true});
    }
    if (retry) await new Promise((done) => setTimeout(done, 250 * attempt));
  }
}

try { await main(); }
catch (error) { console.error(`${error.code ?? "ERROR"}: ${error.message}`); process.exitCode = ["PRIVATE_LAYER", "BAD_PROVENANCE"].includes(error.code) ? 2 : 1; }
