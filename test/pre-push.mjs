import assert from "node:assert/strict";
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {spawnSync} from "node:child_process";

const sourceHook = resolve(".githooks/pre-push");
const zero = "0".repeat(40);

describe("pre-push guards", function () {
  this.timeout(10000);
  let folder, repo, hook, log, behind, main, ahead;
  const git = (...args) => {
    const result = spawnSync("git", args, {cwd: repo, encoding: "utf8"});
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const ref = (sha = ahead, destination = "refs/heads/topic", old = zero) =>
    `refs/heads/topic ${sha} ${destination} ${old}\n`;
  const run = (input = ref(), extra = {}) => spawnSync("sh", [hook], {
    cwd: repo, input, encoding: "utf8",
    env: {...process.env, OSD_PUSH_ALLOW_EMPTY: "", SCAN_LOG: log, SCAN_EXIT: "0", ...extra},
  });
  const refused = (input, pattern, extra) => {
    const result = run(input, extra);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stderr, pattern);
    assert.equal(existsSync(log), false, "guard must run before the scanner");
  };
  const scans = () => existsSync(log)
    ? readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  const passes = (input = ref(), extra = {}) => {
    const result = run(input, extra);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return scans();
  };

  beforeEach(() => {
    folder = mkdtempSync(resolve(".pre-push-test-"));
    repo = join(folder, "repo");
    mkdirSync(repo);
    git("init", "-q", "-b", "main");
    git("config", "user.name", "Hook Test");
    git("config", "user.email", "hook@example.invalid");
    git("config", "core.hooksPath", ".githooks");
    writeFileSync(join(repo, "file"), "base\n");
    git("add", "file");
    git("commit", "-qm", "base");
    behind = git("rev-parse", "HEAD");
    git("commit", "--allow-empty", "-qm", "main advance");
    main = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/main", main);
    git("switch", "-qc", "topic");
    git("commit", "--allow-empty", "-qm", "topic advance");
    ahead = git("rev-parse", "HEAD");
    mkdirSync(join(repo, ".githooks"));
    hook = join(repo, ".githooks", "pre-push");
    copyFileSync(sourceHook, hook);
    mkdirSync(join(repo, "tools"));
    log = join(folder, "scan.log");
    // Record the existing scanner contract without scanning unrelated fixtures.
    writeFileSync(join(repo, "tools", "osd-leak-scan.mjs"),
      'import {appendFileSync} from "node:fs";\n' +
      'appendFileSync(process.env.SCAN_LOG, JSON.stringify(process.argv.slice(2)) + "\\n");\n' +
      'process.exit(Number(process.env.SCAN_EXIT));\n');
  });
  afterEach(() => rmSync(folder, {recursive: true, force: true}));

  for (const operation of ["rebase-merge", "rebase-apply", "MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
    it(`refuses ${operation} even with the empty-branch override`, () => {
      const marker = resolve(repo, git("rev-parse", "--git-path", operation));
      if (operation.startsWith("rebase-")) mkdirSync(marker);
      else writeFileSync(marker, main + "\n");
      refused(ref(), new RegExp(`unfinished Git operation \\(${operation}\\)`), {OSD_PUSH_ALLOW_EMPTY: "1"});
    });
  }

  it("refuses an unmerged index without an operation marker", () => {
    const blob = git("rev-parse", `${main}:file`);
    git("update-index", "--force-remove", "file");
    const result = spawnSync("git", ["update-index", "--index-info"], {
      cwd: repo, encoding: "utf8",
      input: [1, 2, 3].map(stage => `100644 ${blob} ${stage}\tfile\n`).join(""),
    });
    assert.equal(result.status, 0, result.stderr);
    refused(ref(), /unmerged paths/);
  });

  it("resolves rebase markers in a linked worktree", () => {
    const worktree = join(folder, "worktree");
    git("worktree", "add", "--detach", worktree, ahead);
    repo = worktree;
    mkdirSync(resolve(repo, git("rev-parse", "--git-path", "rebase-merge")));
    refused(ref(), /unfinished Git operation \(rebase-merge\)/);
  });

  for (const label of ["equal", "behind"]) {
    it(`refuses a branch ${label} to local origin/main`, () => {
      refused(ref(label === "equal" ? main : behind), /no commits over origin\/main\./);
    });
    it(`allows the explicit override for a branch ${label} to main`, () => {
      assert.equal(passes(ref(label === "equal" ? main : behind), {OSD_PUSH_ALLOW_EMPTY: "1"}).length, 1);
    });
  }

  it("allows an ahead branch and preserves the new-ref scan range", () => {
    assert.deepEqual(passes(), [[repo, "--range", ahead, "--not", "--remotes=origin"]]);
  });
  it("keeps the existing-ref scan to what origin does not have", () => {
    assert.deepEqual(passes(ref(ahead, "refs/heads/topic", main)),
      [[repo, "--range", ahead, "--not", main, "--remotes=origin"]]);
  });
  // The #875 shape: a branch that merged origin/main is pushed to a remote
  // that already has its tip. What is about to be published is only what
  // origin does not have yet — main's own commits are already public, and an
  // identifier main later removed, with its allow entries (#896), must not
  // turn every such push red. The stub scanner here walks the range the way
  // the real one does — commit by commit, every version of every file the
  // commits touched — so the verdict comes from the range itself.
  it("does not rescan origin's own commits after the branch merged main", () => {
    const flag = "flagged-value-on-old-main";
    writeFileSync(join(repo, "tools", "osd-leak-scan.mjs"), [
      'import {appendFileSync} from "node:fs";',
      'import {execFileSync} from "node:child_process";',
      'const args = process.argv.slice(2);',
      'const root = args[0];',
      'const range = args.slice(args.indexOf("--range") + 1);',
      'const git = (a) => execFileSync("git", a, {cwd: root, encoding: "utf8", maxBuffer: 1 << 24});',
      `const flag = ${JSON.stringify(flag)};`,
      'let commits = 0, hits = 0;',
      'for (const commit of git(["rev-list", ...range]).split("\\n").filter(Boolean)) {',
      '  commits++;',
      '  if (git(["log", "-1", "--format=%B", commit]).includes(flag)) hits++;',
      '  const names = git(["diff-tree", "-r", "--no-commit-id", "--name-only",',
      '    "--diff-filter=ACMR", commit]).split("\\n").filter(Boolean);',
      '  for (const name of names) {',
      '    try { if (git(["show", `${commit}:${name}`]).includes(flag)) hits++; } catch {}',
      '  }',
      '}',
      'appendFileSync(process.env.SCAN_LOG, JSON.stringify({range, commits, hits}) + "\\n");',
      'process.exit(hits ? 1 : 0);',
    ].join("\n"));
    git("switch", "main");
    writeFileSync(join(repo, "note.txt"), `${flag}\n`);
    git("add", "note.txt");
    git("commit", "-qm", "main adds the flagged value");
    writeFileSync(join(repo, "note.txt"), "clean\n");
    git("add", "note.txt");
    git("commit", "-qm", "main removes the flagged value");
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    git("switch", "topic");
    git("merge", "--no-edit", "-m", "merge main", "main");
    const merged = git("rev-parse", "HEAD");
    // The merge push must pass: the scan walks the merge commit alone, not
    // main's history back to the branch point — and the remote tip stays
    // excluded even though no local tracking ref holds it.
    const mergePush = run(ref(merged, "refs/heads/topic", ahead));
    assert.equal(mergePush.status, 0, mergePush.stdout + mergePush.stderr);
    assert.deepEqual(scans(), [{range: [merged, "--not", ahead, "--remotes=origin"], commits: 1, hits: 0}]);
    // A commit that carries the value out is still refused.
    writeFileSync(join(repo, "note.txt"), `${flag}\n`);
    git("add", "note.txt");
    git("commit", "-qm", "topic reintroduces the flagged value");
    const leakPush = run(ref(git("rev-parse", "HEAD"), "refs/heads/topic", ahead));
    assert.equal(leakPush.status, 1, leakPush.stdout + leakPush.stderr);
    assert.equal(scans().at(-1).hits > 0, true);
  });
  it("allows a destination of main even from a differently named local branch", () => {
    assert.equal(passes(ref(behind, "refs/heads/main")).length, 1);
  });
  it("checks the destination when local main is pushed to a topic", () => {
    refused(`refs/heads/main ${main} refs/heads/topic ${zero}\n`, /no commits over origin\/main/);
  });
  it("runs the rest of CI's scan job and refuses on any of its rules", () => {
    // #942: five fixture descriptions passed every local hook and failed the
    // naming rule in CI, where a red `scan` read like a leak
    const rules = ["osd-naming-scan", "osd-oo-comments", "osd-ddic-reserved"];
    for (const rule of rules) {
      writeFileSync(join(repo, "tools", `${rule}.mjs`),
        `if (process.env.FAIL_RULE === "${rule}") { console.log("${rule}: 1 finding"); process.exit(1); }\n`);
    }
    passes();
    for (const rule of rules) {
      const result = run(ref(), {FAIL_RULE: rule});
      assert.equal(result.status, 1, rule + ": " + result.stdout + result.stderr);
      assert.match(result.stderr, new RegExp(`${rule}: refused`));
      assert.match(result.stderr, /a rule of CI's scan job/);
    }
  });

  it("allows an empty ref list without scanning", () => {
    assert.deepEqual(passes(""), []);
  });
  it("allows deletions without scanning them", () => {
    assert.deepEqual(passes(ref(zero, "refs/heads/topic", main)), []);
  });
  it("checks every ref before any scan", () => {
    refused(ref() + ref(main, "refs/heads/empty"), /refs\/heads\/empty has no commits/);
  });
  it("scans every allowed ref", () => {
    assert.equal(passes(ref() + ref(ahead, "refs/heads/second")).length, 2);
  });
  it("does not treat other override values as permission", () => {
    refused(ref(main), /no commits over origin\/main/, {OSD_PUSH_ALLOW_EMPTY: "true"});
  });
  it("keeps working for repositories without origin/main", () => {
    git("update-ref", "-d", "refs/remotes/origin/main");
    assert.equal(passes().length, 1);
  });
  it("keeps leak failures blocking even with the empty-branch override", () => {
    const result = run(ref(main), {OSD_PUSH_ALLOW_EMPTY: "1", SCAN_EXIT: "1"});
    assert.equal(result.status, 1);
    assert.equal(scans().length, 1);
  });
  it("keeps scanner exit 2 nonblocking", () => {
    assert.equal(passes(ref(), {SCAN_EXIT: "2"}).length, 1);
  });
});
