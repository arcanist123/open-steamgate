import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {assertPinnedTranspiler, bootstrap} from "../tools/osd-bootstrap.mjs";
import {describeVsixPreflight, githubWorkflowEnv, librariesFromLock, readLock} from "../tools/osd-lock.mjs";
import {vsixPreflightMissing} from "../tools/osd-lib-path.mjs";
import {nodeVersionProblem, requireSupportedNode} from "../tools/osd-node-version.mjs";
import {packsOf} from "../tools/osd-packs.mjs";
import {approvedLicenseAssumption, checkLockLicences} from "../docker/image/license-assumptions.mjs";

const ROOT = process.cwd();

describe("fresh checkout bootstrap", () => {
  it("reads one pinned repo and commit for each configured library", () => {
    const {lock, libraries} = librariesFromLock(ROOT);
    const config = JSON.parse(readFileSync(join(ROOT, "abap_transpile.json"), "utf8"));
    expect(lock).to.deep.equal(readLock(ROOT));
    expect(libraries.map((lib) => lib.folder)).to.deep.equal(
      config.libs.map((lib) => lib.folder.replace(/^\//, "")),
    );
    expect(libraries).to.have.length(lock.libraries.length);
    for (const lib of libraries) {
      expect(lib.ref).to.match(/^[0-9a-f]{40}$/);
      expect(lib.url).to.equal(`https://github.com/${lib.repo}.git`);
      expect(lib.path).to.equal(join(ROOT, lib.folder));
    }
  });

  it("exports the transpiler pin from the same lock for workflows", () => {
    const {transpiler} = readLock(ROOT);
    expect(githubWorkflowEnv(ROOT)).to.equal(
      `OSD_TRANSPILER_REPO=https://github.com/${transpiler.repo}.git\nOSD_TRANSPILER_REF=${transpiler.ref}\n`,
    );
  });

  it("keeps the Docker source inventory aligned with the locked library list", () => {
    const {lock} = librariesFromLock(ROOT);
    const sources = JSON.parse(readFileSync(join(ROOT, "docker", "image", "sources.json"), "utf8"));
    expect(sources.libraries.map((lib) => lib.folder).sort()).to.deep.equal(
      lock.libraries.map((lib) => lib.folder).sort(),
    );
    for (const lib of sources.libraries) {
      expect(lib).not.to.have.property("repo");
      expect(lib).not.to.have.property("ref");
    }
  });

  it("resolves the GUI examples pack to the library's locked commit", () => {
    const lock = readLock(ROOT);
    const gui = lock.libraries.find((lib) => lib.folder === "open-abap-gui");
    const pack = packsOf(ROOT).find((entry) => entry.name === "gui-examples");
    expect(pack.sources[0]).to.include({
      repo: `https://github.com/${gui.repo}.git`,
      ref: gui.ref,
    });
  });

  it("refuses Node releases missing unflagged type stripping, open-rfc or node:sqlite support", () => {
    for (const version of ["22.18.0", "22.99.0", "23.6.0", "24.0.0", "24.99.99", "26.9.0"]) {
      expect(nodeVersionProblem(version), version).to.equal(undefined);
    }
    for (const version of ["20.0.0", "22.9.0", "22.14.0", "22.17.99", "23.0.0", "23.5.99", "not-a-version"]) {
      expect(nodeVersionProblem(version), version).to.be.a("string");
    }
  });

  it("warns once and continues for Node versions outside open-rfc's tested engines", () => {
    const warnings = [];
    for (const version of ["22.18.0", "24.0.0"]) {
      expect(() => requireSupportedNode(version, "bootstrap: ", (line) => warnings.push(line))).not.to.throw();
    }
    expect(warnings).to.deep.equal([]);
    for (const version of ["23.6.0", "25.0.0", "26.9.0"]) {
      expect(() => requireSupportedNode(version, "bootstrap: ", (line) => warnings.push(line))).not.to.throw();
    }
    expect(warnings).to.deep.equal(["23.6.0", "25.0.0", "26.9.0"].map(
      (version) => `bootstrap: Node ${version} is untested with open-rfc engines ^22.14||^24`,
    ));
    expect(() => requireSupportedNode("22.9.0", "build-vsix: ", (line) => warnings.push(line)))
      .to.throw("build-vsix: Node 22.9.0 is unsupported");
    expect(warnings).to.have.length(3);
  });

  it("turns missing VSIX prerequisites into setup instructions", () => {
    const message = describeVsixPreflight(["node_modules/", ".local/lars/open-abap-core/"]);
    expect(message).to.equal(
      "build-vsix: missing node_modules/, .local/lars/open-abap-core/; run npm install and node tools/osd-libs.mjs as needed",
    );
    expect(message).not.to.contain("\n");
    expect(describeVsixPreflight([])).to.equal(undefined);
  });

  it("refuses an unpinned VSIX library even when its folder is populated", function () {
    // git init plus a commit per library in a temp root: seconds on a busy runner, not mocha's 2 s
    this.timeout(30000);
    const scratch = mkdtempSync(join(tmpdir(), "osd-vsix-preflight-"));
    try {
      // a checkout: that is where the pin gate applies (tools/osd-lib-path.mjs)
      execFileSync("git", ["init", "-q"], {cwd: scratch});
      writeFileSync(join(scratch, "libs.lock.json"), readFileSync(join(ROOT, "libs.lock.json")));
      writeFileSync(join(scratch, "abap_transpile.json"), readFileSync(join(ROOT, "abap_transpile.json")));
      mkdirSync(join(scratch, "node_modules"));
      writeFileSync(join(scratch, "node_modules", "present"), "");
      const {libraries} = librariesFromLock(scratch);
      for (const lib of libraries) {
        mkdirSync(lib.path, {recursive: true});
        writeFileSync(join(lib.path, "present"), "");
      }
      expect(() => vsixPreflightMissing(scratch)).to.throw("run node tools/osd-libs.mjs --sync");
    } finally {
      rmSync(scratch, {recursive: true, force: true});
    }
  });

  it("limits temporary image license approvals to the reviewed fork commits", () => {
    const lock = readLock(ROOT);
    const sources = JSON.parse(readFileSync(join(ROOT, "docker", "image", "sources.json"), "utf8"));
    for (const source of sources.libraries.filter((lib) => lib.licenseAssumption)) {
      const pin = lock.libraries.find((lib) => lib.folder === source.folder);
      const reviewed = {...pin, ...source};
      expect(approvedLicenseAssumption(reviewed), source.folder).to.equal(true);
      expect(approvedLicenseAssumption({...reviewed, ref: "0".repeat(40)}), source.folder).to.equal(false);
      expect(approvedLicenseAssumption({...reviewed, repo: "elsewhere/" + source.folder}), source.folder).to.equal(false);
      expect(approvedLicenseAssumption({...reviewed, licenseAssumption: {license: "Apache-2.0"}}), source.folder).to.equal(false);
    }
  });

  it("rejects an unapproved lock ref for a placeholder licence", () => {
    const scratch = mkdtempSync(join(tmpdir(), "osd-licence-pin-"));
    try {
      mkdirSync(join(scratch, "docker/image"), {recursive: true});
      writeFileSync(join(scratch, "docker/image/sources.json"), readFileSync(join(ROOT, "docker/image/sources.json")));
      const lock = readLock(ROOT);
      lock.libraries.find((lib) => lib.folder === "open-abap-gui").ref = "0".repeat(40);
      writeFileSync(join(scratch, "libs.lock.json"), JSON.stringify(lock));
      expect(() => checkLockLicences(scratch)).to.throw("needs licence approval");
    } finally { rmSync(scratch, {recursive: true, force: true}); }
  });

  it("the committed lock pins placeholder-licence libraries at approved refs", () => {
    expect(() => checkLockLicences(ROOT)).not.to.throw();
  });
});

// The pin step as bootstrap runs it: a verified fake pin clone, the published
// packages `npm ci` leaves, and a fake npm that records the transpile step.
// Everything persistent lives under .local (pinPath refuses /tmp by design).
function pinTree() {
  const base = resolve(process.env.OSD_PIN_TEST_ROOT ?? ".local");
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, "boot-pin-"));
  const clone = join(root, "cache");
  const put = (file, text) => { mkdirSync(join(clone, file, ".."), {recursive: true}); writeFileSync(join(clone, file), text); };
  for (const name of ["transpiler", "runtime", "cli"]) {
    put(`packages/${name}/package.json`, JSON.stringify({name: `@abaplint/${name}`, version: "0.0.0", devDependencies: {"@abaplint/core": "0.0.0"}}));
    put(`packages/${name}/node_modules/marker`, "installed");
    put(`packages/${name}/build/index.js`, "compiled");
  }
  put("package.json", JSON.stringify({devDependencies: {"@abaplint/core": "0.0.0"}}));
  put("packages/transpiler/build/src/index.js", "this.options?.only?.(obj) === false");
  put("packages/transpiler/build/src/types.d.ts", "only?:");
  put("packages/transpiler/build/src/validation.js", "reg.getConfig().get()) === JSON.stringify(conf.get())\nobj.setDirty()");
  for (const at of ["", "packages/transpiler/", "packages/cli/"]) {
    put(`${at}node_modules/@abaplint/core/package.json`, '{"version":"0.0.0"}');
  }
  put("packages/cli/abap_transpile", "#!/bin/sh\nexit 0\n");
  chmodSync(join(clone, "packages/cli/abap_transpile"), 0o755);
  put("node_modules/marker", "installed");
  const git = (...args) => execFileSync("git", args, {cwd: clone, encoding: "utf8"}).trim();
  git("init", "-q"); git("add", ".");
  git("-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  const ref = git("rev-parse", "HEAD");
  // the tree npm ci leaves: the published transpiler, no links
  mkdirSync(join(root, "node_modules/@abaplint/transpiler"), {recursive: true});
  writeFileSync(join(root, "node_modules/@abaplint/transpiler/package.json"), JSON.stringify({name: "@abaplint/transpiler", version: "2.14.19"}));
  // the checkout's own bootstrap inputs: an empty library closure, a pack
  // fetch that does nothing, and a fake npm recording the transpile step
  writeFileSync(join(root, "package.json"), JSON.stringify({devDependencies: {"@abaplint/core": "0.0.0"}}));
  writeFileSync(join(root, "libs.lock.json"), JSON.stringify({transpiler: {repo: "test/transpiler", ref}, libraries: []}));
  writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({libs: []}));
  mkdirSync(join(root, "tools"));
  writeFileSync(join(root, "tools", "osd-fetch.mjs"), "process.exit(0);\n");
  mkdirSync(join(root, "commands"));
  writeFileSync(join(root, "commands", "npm"), '#!/bin/sh\necho "npm $*" >> "$PIN_BOOT_LOG"\n');
  chmodSync(join(root, "commands", "npm"), 0o755);
  return {root, clone, ref, log: join(root, "npm.log")};
}

describe("bootstrap runs the pin step before it transpiles", function () {
  this.timeout(60000);

  it("refuses to continue on the published package when the pin cannot be built", () => {
    const f = pinTree();
    try {
      rmSync(f.clone, {recursive: true, force: true});
      writeFileSync(join(f.root, "commands", "git"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(f.root, "commands", "git"), 0o755);
      const said = [];
      const env = {...process.env, TRANSPILER: f.clone, PATH: `${join(f.root, "commands")}:${process.env.PATH}`};
      expect(() => bootstrap(f.root, (line) => said.push(line), env)).to.throw(/Pinned transpiler build failed/);
      expect(existsSync(f.log), "the transpile step must not run").to.equal(false);
      expect(lstatSync(join(f.root, "node_modules/@abaplint/transpiler")).isSymbolicLink(),
        "the published package must not be linked over").to.equal(false);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("with the pin present, it links and then transpiles (npm faked)", () => {
    const f = pinTree();
    try {
      const said = [];
      const env = {...process.env, TRANSPILER: f.clone, PATH: `${join(f.root, "commands")}:${process.env.PATH}`, PIN_BOOT_LOG: f.log};
      const result = bootstrap(f.root, (line) => said.push(line), env);
      expect(result).to.include({libraries: 0, cloned: 0});
      expect(realpathSync(join(f.root, "node_modules/@abaplint/transpiler"))).to.equal(join(f.clone, "packages/transpiler"));
      expect(readFileSync(f.log, "utf8").trim()).to.equal("npm run transpile");
      expect(() => assertPinnedTranspiler(f.root, f.clone)).not.to.throw();
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("assertPinnedTranspiler names the fix when the link is missing or published", () => {
    const f = pinTree();
    try {
      expect(() => assertPinnedTranspiler(f.root, f.clone)).to.throw(/osd-transpiler-pin\.mjs/);
      expect(() => assertPinnedTranspiler(f.root, f.clone)).to.throw(/pinned build/);
      rmSync(join(f.root, "node_modules/@abaplint/transpiler"), {recursive: true});
      expect(() => assertPinnedTranspiler(f.root, f.clone)).to.throw(/pinned build/);
      symlinkSync(join(f.clone, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"), "dir");
      expect(() => assertPinnedTranspiler(f.root, f.clone)).not.to.throw();
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
});
