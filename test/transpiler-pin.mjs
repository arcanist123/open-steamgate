import {strict as assert} from "node:assert";
import {execFileSync} from "node:child_process";
import {chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {tmpdir} from "node:os";
import {ensurePinned, installPin, pinPath} from "../tools/osd-transpiler-pin.mjs";
import {doctorWarmPin, probe, WARM_PIN_WARNING} from "../tools/osd-warm-capabilities.mjs";
import {hashOf, inputsOf} from "../tools/osd-build.mjs";
import {warmUp} from "../tools/osd-store-warm.mjs";
import {describeTranspiler, packageInUse} from "../tools/osd-transpiler.mjs";
import {selectedModules} from "../tools/osd-transpile.mjs";

describe("installed transpiler/parser compatibility", () => {
  it("compiles CREATE DATA TYPE HANDLE with the selected parser", async () => {
    const {core, Transpiler} = selectedModules(process.cwd());
    const reg = new core.Registry().addFile(new core.MemoryFile("zhandle.prog.abap", `
DATA ref TYPE REF TO data.
DATA handle TYPE REF TO object.
CREATE DATA ref TYPE HANDLE handle.`));
    const output = await new Transpiler({skipVersionCheck: true, unknownTypes: "runtimeError"}).run(reg);
    assert.match(output.objects[0].chunk.getCode(), /call\(\{handle: handle, dref: ref\}\)/);
  });
});

function fixture() {
  // Checkouts used for shard validation may themselves be temporary. The
  // fixture's explicit pins must still live outside temporary storage.
  const base = resolve(process.env.OSD_PIN_TEST_ROOT ?? ".local");
  mkdirSync(base, {recursive: true});
  const root = mkdtempSync(join(base, "pin-test-"));
  const clone = join(root, "persistent");
  mkdirSync(clone);
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
  writeFileSync(join(root, "package.json"), JSON.stringify({devDependencies: {"@abaplint/core": "0.0.0"}}));
  writeFileSync(join(root, "libs.lock.json"), JSON.stringify({transpiler: {repo: "test/transpiler", ref}, libraries: []}));
  return {root, clone, ref};
}

describe("local transpiler pin", function () {
  // These run git and fake npm synchronously; on a loaded CI runner one case
  // took over mocha's default 2 s three times on 2026-11-08 (#859, #861, #865).
  this.timeout(30000);
  it("refuses temporary paths, scratchpads and symlinks into temporary storage", () => {
    assert.throws(() => pinPath("ref", {TRANSPILER: "/tmp/transpiler"}), /persistent/);
    assert.throws(() => pinPath("ref", {TRANSPILER: resolve("scratchpad/transpiler")}), /persistent/);
    const f = fixture();
    try {
      symlinkSync(tmpdir(), join(f.root, "alias"));
      assert.throws(() => pinPath(f.ref, {TRANSPILER: join(f.root, "alias", "pin")}), /persistent/);
      assert(pinPath(f.ref, {}).endsWith(`.cache/osd/transpiler-${f.ref}`));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("reuses a verified checkout without building and links all four CI packages", () => {
    const f = fixture();
    try {
      // No install/compile scripts exist: attempting a rebuild would fail.
      const before = readFileSync(join(f.clone, "packages/transpiler/build/src/index.js"), "utf8");
      installPin(f.root, {...process.env, TRANSPILER: f.clone});
      for (const [name, path] of [["transpiler", "packages/transpiler"], ["transpiler-cli", "packages/cli"],
        ["runtime", "packages/runtime"], ["core", "packages/transpiler/node_modules/@abaplint/core"]]) {
        assert.equal(realpathSync(join(f.root, "node_modules/@abaplint", name)), join(f.clone, path));
      }
      assert.equal(readFileSync(join(f.clone, "packages/transpiler/build/src/index.js"), "utf8"), before);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("refuses a checkout at the wrong ref before linking", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "libs.lock.json"), JSON.stringify({transpiler: {repo: "test/transpiler", ref: "0".repeat(40)}, libraries: []}));
      assert.throws(() => installPin(f.root, {...process.env, TRANSPILER: f.clone}), /build failed/);
      assert(!existsSync(join(f.root, "node_modules")));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("refuses a cached build whose parser differs from OSG before linking", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.root, "package.json"), JSON.stringify({devDependencies: {"@abaplint/core": "1.0.0"}}));
      assert.throws(() => installPin(f.root, {...process.env, TRANSPILER: f.clone}), /build failed/);
      assert(!existsSync(join(f.root, "node_modules")));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("describes a linked build at the locked ref as pinned", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.root, "node_modules/@abaplint"), {recursive: true});
      symlinkSync(join(f.clone, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"));
      assert.equal(describeTranspiler(f.root),
        `transpiler: the pinned build of test/transpiler ${f.ref.slice(0, 8)} (libs.lock.json), at ${join(f.clone, "packages/transpiler")}, calling itself 0.0.0`);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("ignores file-mode-only changes in a linked build", () => {
    const f = fixture();
    const executable = join(f.clone, "packages/cli/abap_transpile");
    try {
      mkdirSync(join(f.root, "node_modules/@abaplint"), {recursive: true});
      symlinkSync(join(f.clone, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"));
      chmodSync(executable, 0o644);
      assert.equal(packageInUse(f.root, "transpiler").dirty, false);
      writeFileSync(executable, "#!/bin/sh\nexit 1\n");
      chmodSync(executable, 0o755);
      assert.equal(packageInUse(f.root, "transpiler").dirty, true);
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  for (const fresh of [true, false]) {
    it(fresh ? "builds a missing pin through CI with fake npm" : "repairs an incomplete clean pin through CI with fake npm", () => {
      const f = fixture();
      try {
        const commands = join(f.root, "commands");
        mkdirSync(commands);
        writeFileSync(join(commands, "npm"), '#!/bin/sh\n echo "$*" >> "$PIN_TEST_LOG"\n');
        chmodSync(join(commands, "npm"), 0o755);
        const log = join(f.root, "npm.log");
        const clone = fresh ? join(f.root, "new-pin") : f.clone;
        if (!fresh) {
          execFileSync("git", ["config", "core.filemode", "false"], {cwd: clone});
          chmodSync(join(clone, "packages/cli/abap_transpile"), 0o644);
        }
        installPin(f.root, {...process.env, TRANSPILER: clone, PATH: `${commands}:${process.env.PATH}`, PIN_TEST_LOG: log,
          GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: `url.${f.clone}.insteadOf`, GIT_CONFIG_VALUE_0: "https://github.com/test/transpiler.git"});
        const calls = readFileSync(log, "utf8").trim().split("\n");
        assert.equal(calls.length, 7);
        assert.equal(calls.filter(line => line.endsWith("run compile")).length, 3);
        assert.equal(realpathSync(join(f.root, "node_modules/@abaplint/runtime")), join(clone, "packages/runtime"));
      } finally { rmSync(f.root, {recursive: true, force: true}); }
    });
  }
});

describe("the link decision bootstrap calls", function () {
  this.timeout(30000);
  // CI's four links (tests.yml "Verify and link the pinned transpiler").
  const LINKS = [["transpiler", "packages/transpiler"], ["transpiler-cli", "packages/cli"],
    ["runtime", "packages/runtime"], ["core", "packages/transpiler/node_modules/@abaplint/core"]];
  // the tree `npm ci` leaves behind: published packages as real directories
  const published = (root, name) => {
    mkdirSync(join(root, "node_modules/@abaplint", name), {recursive: true});
    writeFileSync(join(root, "node_modules/@abaplint", name, "package.json"),
      JSON.stringify({name: `@abaplint/${name}`, version: "2.14.19"}));
  };
  // a checkout the links can point at that is NOT the pin
  const otherCheckout = (root) => {
    const at = join(root, "other-checkout");
    for (const [, path] of LINKS) {
      mkdirSync(join(at, path), {recursive: true});
      writeFileSync(join(at, path, "package.json"), JSON.stringify({name: "other", version: "0.0.0"}));
    }
    writeFileSync(join(at, "marker"), "another build");
    const git = (...args) => execFileSync("git", args, {cwd: at, encoding: "utf8"});
    git("init", "-q"); git("add", ".");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "another build");
    return at;
  };
  const linkId = (root, name) => {
    const st = lstatSync(join(root, "node_modules/@abaplint", name));
    return `${st.dev}:${st.ino}`;
  };

  it("links a tree that npm ci left on the published packages", () => {
    const f = fixture();
    try {
      published(f.root, "transpiler");
      const said = [];
      assert.equal(ensurePinned(f.root, {...process.env, TRANSPILER: f.clone}, (line) => said.push(line)), f.clone);
      assert.equal(realpathSync(join(f.root, "node_modules/@abaplint/transpiler")), join(f.clone, "packages/transpiler"));
      assert(said.some((line) => line.includes("reusing verified build")), said.join("\n"));
      assert(said.some((line) => line.includes("replaced")), said.join("\n"));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("leaves links that already point at the verified pin untouched", () => {
    const f = fixture();
    try {
      installPin(f.root, {...process.env, TRANSPILER: f.clone});
      const before = Object.fromEntries(LINKS.map(([name]) => [name, linkId(f.root, name)]));
      const said = [];
      assert.equal(ensurePinned(f.root, {...process.env, TRANSPILER: f.clone}, (line) => said.push(line)), f.clone);
      for (const [name] of LINKS) assert.equal(linkId(f.root, name), before[name], name);
      assert(said.some((line) => line.includes("already") && line.includes("leaving")), said.join("\n"));
      assert(!said.some((line) => line.includes("replaced")), said.join("\n"));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("replaces links that point at another commit and reports the replacement", () => {
    const f = fixture();
    try {
      const other = otherCheckout(f.root);
      mkdirSync(join(f.root, "node_modules/@abaplint"), {recursive: true});
      for (const [name, path] of LINKS) symlinkSync(join(other, path), join(f.root, "node_modules/@abaplint", name), "dir");
      const said = [];
      ensurePinned(f.root, {...process.env, TRANSPILER: f.clone}, (line) => said.push(line));
      assert.equal(realpathSync(join(f.root, "node_modules/@abaplint/transpiler")), join(f.clone, "packages/transpiler"));
      assert(said.some((line) => line.includes("replaced")), said.join("\n"));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("repairs only the links that are not at the pin", () => {
    const f = fixture();
    try {
      installPin(f.root, {...process.env, TRANSPILER: f.clone});
      const other = otherCheckout(f.root);
      rmSync(join(f.root, "node_modules/@abaplint/transpiler"));
      symlinkSync(join(other, "packages/transpiler"), join(f.root, "node_modules/@abaplint/transpiler"), "dir");
      rmSync(join(f.root, "node_modules/@abaplint/runtime"));
      const untouched = {["transpiler-cli"]: linkId(f.root, "transpiler-cli"), ["core"]: linkId(f.root, "core")};
      const said = [];
      ensurePinned(f.root, {...process.env, TRANSPILER: f.clone}, (line) => said.push(line));
      assert.equal(realpathSync(join(f.root, "node_modules/@abaplint/transpiler")), join(f.clone, "packages/transpiler"));
      assert(lstatSync(join(f.root, "node_modules/@abaplint/runtime")).isSymbolicLink());
      for (const [name, id] of Object.entries(untouched)) assert.equal(linkId(f.root, name), id, name);
      assert(said.some((line) => line.includes("2 of 4 links replaced") && line.includes("2 already at the pin")), said.join("\n"));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });

  it("refuses loudly when the pinned build is absent, and links nothing", () => {
    const f = fixture();
    try {
      published(f.root, "transpiler");
      const commands = join(f.root, "commands");
      mkdirSync(commands);
      writeFileSync(join(commands, "git"), "#!/bin/sh\nexit 1\n");
      chmodSync(join(commands, "git"), 0o755);
      const said = [];
      assert.throws(
        () => ensurePinned(f.root, {...process.env, TRANSPILER: join(f.root, "absent-cache"), PATH: `${commands}:${process.env.PATH}`}, (line) => said.push(line)),
        /Pinned transpiler build failed/);
      assert(!lstatSync(join(f.root, "node_modules/@abaplint/transpiler")).isSymbolicLink());
      assert(!said.some((line) => line.includes("replaced")), said.join("\n"));
    } finally { rmSync(f.root, {recursive: true, force: true}); }
  });
});

// A small behavioral fake distinguishes only, registry reuse and config invalidation.
function modules({only = true, reuse = true, config = true} = {}) {
  class Registry {
    objects = [];
    addFile(file) { this.objects.push({getName: () => file.name.split(".")[0].toUpperCase()}); }
    getObject(type, name) { return this.objects.find(o => o.getName() === name); }
  }
  class Transpiler {
    constructor(options) { this.options = options; }
    async run(reg) {
      const changed = reg.last !== this.options.ignoreSyntaxCheck;
      for (const o of reg.objects) {
        if (!reuse || !this.options.only || this.options.only(o) || (changed && config)) o.syntaxResult = {};
      }
      reg.last = this.options.ignoreSyntaxCheck;
      return {objects: reg.objects.filter(o => !only || !this.options.only || this.options.only(o))};
    }
  }
  return {Transpiler, core: {Registry, MemoryFile: class { constructor(name) { this.name = name; } }}};
}

describe("warm pin startup warning", () => {
  for (const [label, options, warning] of [["no only", {only: false}, true], ["no registry reuse", {reuse: false}, true],
    ["no config check", {config: false}, true], ["pinned capabilities", {}, false]]) {
    it(label, async () => {
      const {Transpiler, core} = modules(options);
      const reason = await probe(Transpiler, core);
      const doctor = [];
      await doctorWarmPin(Transpiler, core, line => doctor.push(line), {OSD_WARM: "1"});
      assert.equal(doctor.includes(WARM_PIN_WARNING), warning);
      await doctorWarmPin(Transpiler, core, () => assert.fail("warm is off"), {});
      const lines = [];
      const original = console.log, oldWarm = process.env.OSD_WARM;
      console.log = line => lines.push(line); process.env.OSD_WARM = "1";
      const w = {on: true, compiler: {prime: async () => {
        if (reason) throw Object.assign(new Error(reason), {code: "NOT_WARM", pinMissing: true});
      }, drop: async () => {}}};
      // The real startup fallback, with the expensive compiler replaced.
      const f = fixture();
      writeFileSync(join(f.root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"], libs: [], options: {}}));
      mkdirSync(join(f.root, "src"));
      const store = {root: f.root, warm: () => w, overlay: () => undefined, inactiveSources: () => [],
        sourceKey: () => hashOf(f.root, inputsOf(f.root))};
      try {
        await warmUp(store);
        assert.equal(lines.filter(line => line === WARM_PIN_WARNING).length, warning ? 1 : 0);
        if (warning) assert(lines.includes(`warm: builds stay cold: ${reason}`));
        await warmUp(store);
        assert.equal(lines.filter(line => line === WARM_PIN_WARNING).length, warning ? 1 : 0);
      } finally {
        rmSync(f.root, {recursive: true, force: true});
        console.log = original;
        if (oldWarm === undefined) delete process.env.OSD_WARM; else process.env.OSD_WARM = oldWarm;
      }
    });
  }
});
