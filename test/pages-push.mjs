import {expect} from "chai";
import {chmod, mkdir, mkdtemp, readFile, rm, writeFile} from "node:fs/promises";
import {execFile} from "node:child_process";
import {join, resolve} from "node:path";
import {promisify} from "node:util";
import {writeArtefactProvenance} from "../tools/osd-provenance.mjs";

const exec = promisify(execFile);
const script = resolve("scripts/pages-push.mjs");
const realGit = (await exec("which", ["git"])).stdout.trim();

describe("GitHub Pages concurrent pushes", function () {
  this.timeout(15000);
  let root;
  let bare;
  let source;
  let competitor;
  let marker;
  let bin;

  async function git(...args) {
    return exec(realGit, args);
  }

  async function published(path) {
    return (await git("--git-dir", bare, "show", `gh-pages:${path}`)).stdout;
  }

  async function runWithRace(args) {
    const {stdout} = await exec(process.execPath, [script, ...args], {
      cwd: source,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        TMPDIR: root,
        PAGES_TEST_REAL_GIT: realGit,
        PAGES_TEST_COMPETITOR: competitor,
        PAGES_TEST_MARKER: marker,
        PAGES_TEST_RACE_FILE: "pr-9/app/flp.html",
      },
    });
    expect(stdout).to.include("gh-pages advanced; retrying (2/3)");
    expect(stdout).to.include("pushed on attempt 2/3");
    expect(await readFile(marker, "utf8")).to.equal("");
  }

  beforeEach(async () => {
    root = await mkdtemp(join(process.cwd(), ".pages-push-test-"));
    bare = join(root, "remote.git");
    source = join(root, "source");
    competitor = join(root, "competitor");
    bin = join(root, "bin");
    marker = join(root, "race-fired");
    await git("init", "--bare", "--initial-branch=gh-pages", bare);
    await git("clone", bare, source);
    await git("-C", source, "config", "user.name", "test");
    await git("-C", source, "config", "user.email", "test@example.invalid");
    for (const directory of ["main", "pr-4"]) {
      await mkdir(join(source, directory, "app"), {recursive: true});
      await writeFile(join(source, directory, "app", "flp.html"), directory);
    }
    await writeFile(join(source, "index.html"), "stale index");
    await writeFile(join(source, "main", "old.txt"), "old build");
    await git("-C", source, "add", "-A");
    await git("-C", source, "commit", "-m", "seed");
    await git("-C", source, "push", "origin", "HEAD:gh-pages");
    await git("clone", bare, competitor);
    await git("-C", competitor, "config", "user.name", "other writer");
    await git("-C", competitor, "config", "user.email", "other@example.invalid");
    await mkdir(bin);
    const wrapper = join(bin, "git");
    await writeFile(wrapper, [
      "#!/bin/sh",
      'if [ "$1" = "-C" ] && [ "$3" = "push" ] && [ ! -e "$PAGES_TEST_MARKER" ]; then',
      '  : > "$PAGES_TEST_MARKER"',
      '  mkdir -p "$(dirname "$PAGES_TEST_COMPETITOR/$PAGES_TEST_RACE_FILE")"',
      '  printf "competing preview\\n" > "$PAGES_TEST_COMPETITOR/$PAGES_TEST_RACE_FILE"',
      '  "$PAGES_TEST_REAL_GIT" -C "$PAGES_TEST_COMPETITOR" add -A',
      '  "$PAGES_TEST_REAL_GIT" -C "$PAGES_TEST_COMPETITOR" commit -q -m "competing PR"',
      '  "$PAGES_TEST_REAL_GIT" -C "$PAGES_TEST_COMPETITOR" push -q origin HEAD:gh-pages',
      "fi",
      'exec "$PAGES_TEST_REAL_GIT" "$@"',
      "",
    ].join("\n"));
    await chmod(wrapper, 0o755);
  });

  afterEach(async () => {
    if (root) await rm(root, {recursive: true, force: true});
  });

  it("replays a publish without losing another PR or retaining old build files", async () => {
    const build = join(root, "build");
    await mkdir(join(build, "app"), {recursive: true});
    await writeFile(join(build, "app", "flp.html"), "new main");
    writeArtefactProvenance(build, {generation: "pages-fixture", systemDigest: null, systemPrivate: false, inputs: []});
    await runWithRace(["publish", "main", build]);
    expect(await published("main/app/flp.html")).to.equal("new main");
    expect(await published("pr-9/app/flp.html")).to.equal("competing preview\n");
    const {stdout: files} = await git("--git-dir", bare, "ls-tree", "-r", "--name-only", "gh-pages");
    expect(files).not.to.include("main/old.txt");
  });

  it("rerenders the index after a competing publish", async () => {
    await runWithRace(["index"]);
    const index = await published("index.html");
    expect(index).to.include("pr-4/app/flp.html");
    expect(index).to.include("pr-9/app/flp.html");
  });

  it("replays removal and index refresh after a competing publish", async () => {
    await runWithRace(["remove", "pr-4"]);
    const index = await published("index.html");
    expect(index).not.to.include("pr-4/app/flp.html");
    expect(index).to.include("pr-9/app/flp.html");
    const {stdout: files} = await git("--git-dir", bare, "ls-tree", "-r", "--name-only", "gh-pages");
    expect(files).not.to.include("pr-4/app/flp.html");
    expect(files).to.include("pr-9/app/flp.html");
  });
});
