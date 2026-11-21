import {expect} from "chai";
import {writeFileSync, readFileSync, readdirSync, rmSync, mkdirSync, mkdtempSync, cpSync, symlinkSync, utimesSync, realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {execFileSync} from "node:child_process";
import {dirname, join} from "node:path";
import {createRequire} from "node:module";
import {build, liveHash, hashOf, inputsOf, generatorClosure, generatorIdentity, genHash} from "../tools/osd-build.mjs";
import {SEEDS_MARKER} from "../tools/osd-packs.mjs";

import {WarmCompiler} from "../tools/osd-warm.mjs";
import {modulesOf} from "../tools/osd-transpile.mjs";
import {buildIdentity, packageIdentity} from "../tools/osd-transpiler.mjs";

// **A generation's name was a function of the tree AND of how many times the
// tree had been built.**
//
// `gen/` was one of the hashed input folders and is written BY the build, so
// the first build of a fresh tree hashed an empty `gen/` and the second
// hashed the one the first had just written. Two builds, no edit between
// them, two different names -- measured from both sessions independently:
//
//   before   build 1 -> 134909ac…, build 2 -> 910a2f11…, build 3 -> cache
//   after    build 1 -> 93addd64…, build 2 -> cache (0.16 s)
//
// The cause was `NOT_AN_INPUT` excluding `.mjs`: a generator's own code was
// not an input while its output was, so the hash watched the representative
// and not the thing represented. The representative is gone and the thing
// represented -- the generators and everything they import -- is hashed.
describe("a generation's name is a function of the tree, not of its build history", () => {
  it("interpreted osd dispatch and a standalone builder hash the same generator inputs", () => {
    const saved = process.env.OSD_SELF;
    try {
      delete process.env.OSD_SELF;
      const direct = generatorIdentity(), hash = hashOf(process.cwd());
      process.env.OSD_SELF = JSON.stringify([process.execPath, join(process.cwd(), 'bin/osd.mjs')]);
      expect(generatorIdentity()).to.equal(direct);
      expect(hashOf(process.cwd())).to.equal(hash);
      // A genuinely embedded host still hashes its executable, not sources.
      process.env.OSD_SELF = JSON.stringify([process.execPath]);
      expect(generatorIdentity()).to.match(/^binary:/);
      expect(generatorIdentity()).not.to.equal(direct);
    } finally {
      if (saved === undefined) delete process.env.OSD_SELF; else process.env.OSD_SELF = saved;
    }
  });
  it("a change under gen/ does not rename the generation, because gen/ is an output", () => {
    const before = hashOf(process.cwd());
    const probe = join("gen", "osd-hash-probe.tmp.abap");
    mkdirSync("gen", {recursive: true});
    writeFileSync(probe, "* written by a test, and gen/ is an output\n");
    try {
      expect(hashOf(process.cwd()), "gen/ is written by the build; hashing it made the name self-referential")
        .to.equal(before);
    } finally {
      rmSync(probe, {force: true});
    }
  });

  it("but a change to a generator DOES, because that is what decides gen/", () => {
    const before = hashOf(process.cwd());
    const closure = generatorClosure();
    const victim = closure.find((f) => f.endsWith("cds2ddic.mjs"));
    expect(victim, "cds2ddic is a generator").to.be.a("string");
    const original = readFileSync(victim);
    try {
      writeFileSync(victim, Buffer.concat([original, Buffer.from("\n// probe\n")]));
      expect(hashOf(process.cwd()), "the thing represented has to be watched").to.not.equal(before);
    } finally {
      writeFileSync(victim, original);
    }
    expect(hashOf(process.cwd()), "and restored is restored").to.equal(before);
  });

  it("the closure is the generators and what they import, not every tool there is", () => {
    const closure = generatorClosure();
    const names = closure.map((f) => f.split("/").pop());
    expect(names, "a listed generator").to.contain("cds2ddic.mjs");
    expect(names, "something a generator imports").to.contain("osd-packs.mjs");
    expect(names, "the source-map shim changes generated JavaScript").to.contain("osd-source-map-starts.mjs");
    // editing a tool no generator reaches must not rename every generation
    expect(names).to.not.contain("osd-sql-trace-buffer.mjs");
    expect(closure.length, "a subset, computed rather than approximated by `all of tools/`")
      .to.be.lessThan(readdirSync("tools").filter((name) => name.endsWith(".mjs")).length);
  });

  it("and the closure is stable, so the hash does not depend on the order it was read", () => {
    expect(generatorClosure()).to.deep.equal(generatorClosure());
    expect([...generatorClosure()], "sorted").to.deep.equal([...generatorClosure()].sort());
  });
});

// **Taking `gen/` out of the hash removed an accidental protection.**
//
// A cache hit skips the generators -- reasonably, since the generation is
// reused because its INPUTS match. `gen/` is an output. So after
//
//   edit a view -> build -> restore the source -> build again
//
// the second build reused the generation and three files under `gen/` still
// held the edit. The served system was right; the working tree was not, and
// the next thing to read `gen/` -- the object store, the ADT façade, the
// next build's own generators -- believes it (measured 2026-09-19, and the
// defect was mine, introduced the same afternoon).
//
// So the manifest records what `gen/` held when the generation was made, and
// a cache hit that finds it different runs the generators again. Measured
// after: the reuse takes 2.4 s instead of 0.12 s, against 9.7 s for a full
// build, and `gen/` comes out consistent.
// **An empty pack named every generation it was near.** The VS Code
// extension always adds an empty notebook-scratch pack from its own storage,
// whose path differs per machine; hashing that path meant a generation built
// anywhere else could never be reused (T2, the prebuilt .vsix generation).
describe("a pack that brings nothing does not name the generation", () => {
  const withPacks = (dir, fn) => {
    const saved = process.env.OSD_PACKS;
    process.env.OSD_PACKS = dir;
    try {
      return fn();
    } finally {
      if (saved === undefined) delete process.env.OSD_PACKS;
      else process.env.OSD_PACKS = saved;
    }
  };

  it("an empty pack under any path leaves the name as it was, and one file in it changes it", () => {
    const before = withPacks("", () => hashOf(process.cwd()));
    const storage = mkdtempSync(join(tmpdir(), "osd-empty-pack-"));
    try {
      const scratch = join(storage, "notebook-scratch");
      mkdirSync(join(scratch, "src"), {recursive: true});
      writeFileSync(join(scratch, "osd-pack.json"), JSON.stringify({name: "notebook-scratch", order: 10000}));
      expect(withPacks(storage, () => hashOf(process.cwd())), "empty: builds nothing, names nothing").to.equal(before);
      writeFileSync(join(scratch, "src", "zcl_cell.clas.abap"), "CLASS zcl_cell DEFINITION PUBLIC. ENDCLASS.\n");
      expect(withPacks(storage, () => hashOf(process.cwd())), "with a class it is an input").to.not.equal(before);
    } finally {
      rmSync(storage, {recursive: true, force: true});
    }
  });

  // **Rows the build captures do not rename what it built.** The rap-flight
  // pack's data/ is written after the generation is in place, by running it
  // (tools/rap-flight/seed-capture.mjs). Hashed as an input, it renamed the
  // tree the moment the build finished, and every host then started by
  // building again (PR #880: e2e's web server, osgo's "no build of that
  // exists", the bind and ICF hosts all timed out on it).
  it("a data folder the build wrote (its seed marker) does not change the name; a hand-written one does", () => {
    const storage = mkdtempSync(join(tmpdir(), "osd-seeded-pack-"));
    try {
      const pack = join(storage, "seeded");
      mkdirSync(join(pack, "src"), {recursive: true});
      writeFileSync(join(pack, "osd-pack.json"), JSON.stringify({name: "seeded", order: 10000}));
      writeFileSync(join(pack, "src", "zcl_seeded.clas.abap"), "CLASS zcl_seeded DEFINITION PUBLIC. ENDCLASS.\n");
      const before = withPacks(storage, () => hashOf(process.cwd()));
      mkdirSync(join(pack, "data"));
      writeFileSync(join(pack, "data", "zseeded.tabu.json"), "[]\n");
      expect(withPacks(storage, () => hashOf(process.cwd())), "hand-written rows are an input").to.not.equal(before);
      writeFileSync(join(pack, "data", SEEDS_MARKER), "{}\n");
      expect(withPacks(storage, () => hashOf(process.cwd())), "rows the build made are its output").to.equal(before);
    } finally {
      rmSync(storage, {recursive: true, force: true});
    }
  });
});

describe("a cache hit does not leave gen/ holding somebody else's edit", () => {
  it("genHash reads the content, so a changed file changes it", async () => {
    const {writeFileSync, rmSync, mkdirSync} = await import("node:fs");
    const before = genHash(process.cwd());
    expect(before, "gen/ exists and is hashed").to.match(/^[0-9a-f]{16}$/);
    mkdirSync("gen", {recursive: true});
    writeFileSync("gen/osd-genhash-probe.tmp.abap", "* a probe\n");
    try {
      expect(genHash(process.cwd()), "a file under gen/ must move it").to.not.equal(before);
    } finally {
      rmSync("gen/osd-genhash-probe.tmp.abap", {force: true});
    }
    expect(genHash(process.cwd()), "and removing it must bring it back").to.equal(before);
  });

  it("and it is NOT the generation hash, which is the whole point", () => {
    expect(genHash(process.cwd()), "one is the output, the other the inputs")
      .to.not.equal(hashOf(process.cwd()));
  });

  it("the live manifest carries what gen/ held when it was built", async () => {
    const {readFileSync, existsSync} = await import("node:fs");
    if (!existsSync("build/live/manifest.json")) return;
    const manifest = JSON.parse(readFileSync("build/live/manifest.json", "utf8"));
    expect(manifest.gen, "without it a cache hit cannot tell that gen/ drifted").to.be.a("string");
  });
});

describe("a generation identifies content regardless of location", () => {
  let scratch, first, second;
  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "osd-tree-identity-"));
    first = join(scratch, "first");
    second = join(scratch, "elsewhere", "deeper", "second");
    mkdirSync(join(first, "src"), {recursive: true});
    writeFileSync(join(first, "abap_transpile.json"), JSON.stringify({input_folder: "src", libs: []}));
    writeFileSync(join(first, "src", "zcl_identity.clas.abap"), "* original source\n");
    for (const name of ["transpiler", "runtime"]) {
      const pkg = join(first, "local", name);
      mkdirSync(join(pkg, "build"), {recursive: true});
      writeFileSync(join(pkg, "package.json"), JSON.stringify({name: `@abaplint/${name}`, version: "1.0.0", main: "build/index.js"}));
      writeFileSync(join(pkg, "build", "index.js"), "module.exports = {};\n");
      mkdirSync(join(first, "node_modules", "@abaplint"), {recursive: true});
      symlinkSync(join("..", "..", "local", name), join(first, "node_modules", "@abaplint", name));
    }
    mkdirSync(join(scratch, "elsewhere", "deeper"), {recursive: true});
    cpSync(first, second, {recursive: true, verbatimSymlinks: true});
  });
  afterEach(() => rmSync(scratch, {recursive: true, force: true}));

  it("refuses warm and cold builds after a linked transpiler was rebuilt in this process", async () => {
    const pkg = join(first, "local", "transpiler");
    const real = realpathSync(join(process.cwd(), "node_modules", "@abaplint", "transpiler"));
    mkdirSync(join(pkg, "build", "src", "statements"), {recursive: true});
    writeFileSync(join(pkg, "build", "src", "statements", "call_function.js"),
      `module.exports = require(${JSON.stringify(join(real, "build", "src", "statements", "call_function.js"))});\n`);
    mkdirSync(join(pkg, "node_modules", "@abaplint"), {recursive: true});
    const fromTranspiler = createRequire(join(real, "package.json"));
    symlinkSync(dirname(fromTranspiler.resolve("@abaplint/core/package.json")), join(pkg, "node_modules", "@abaplint", "core"));
    const file = join(pkg, "build", "index.js");
    const compiler = name => `const real = require(${JSON.stringify(real)}); module.exports = {...real, Transpiler: class ${name} extends real.Transpiler {}};\n`;
    writeFileSync(file, compiler("Before"));
    writeFileSync(join(first, "abap_transpile.json"), JSON.stringify({
      input_folder: "src", output_folder: "output", libs: [], write_source_map: true,
      options: {addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }));
    writeFileSync(join(first, "src", "zcl_identity.clas.abap"),
      "CLASS zcl_identity DEFINITION PUBLIC. ENDCLASS. CLASS zcl_identity IMPLEMENTATION. ENDCLASS.\n");
    const before = buildIdentity(first);
    const loaded = modulesOf(first);
    expect(loaded.Transpiler.name).to.equal("Before");
    const baseline = await build({root: first, generators: false});
    expect(baseline.ok).to.equal(true);
    const warm = new WarmCompiler({root: first});
    try {
      await warm.prime();
      writeFileSync(file, compiler("After"));
      expect(buildIdentity(first)).not.to.equal(before);
      expect(modulesOf(first).Transpiler).to.equal(loaded.Transpiler);
      expect(modulesOf(first).identity).to.equal(before);
      for (const attempt of [() => warm.build(), () => warm.prime(), () => build({root: first, generators: false})]) {
        let refused;
        try { await attempt(); } catch (error) { refused = error; }
        expect(refused?.code).to.equal("TOOLCHAIN_CHANGED");
        expect(refused.message).to.contain("restart the server (or run `osd build`)");
      }
      expect(liveHash(first)).to.equal(baseline.hash);
      expect(readdirSync(join(first, "build", "by-input"))).to.deep.equal([baseline.hash]);
      expect(JSON.parse(readFileSync(join(first, "build", "live", "manifest.json"))).toolchain).to.equal(before);
    } finally { warm.drop(); }
  });

  it("caches a published identity for the process lifetime", () => {
    const installed = join(first, "node_modules", "@abaplint", "transpiler");
    rmSync(installed);
    cpSync(join(first, "local", "transpiler"), installed, {recursive: true});
    const before = packageIdentity(installed, "@abaplint/transpiler");
    writeFileSync(join(installed, "build", "index.js"), "module.exports = {changed: true};\n");
    expect(packageIdentity(installed, "@abaplint/transpiler")).to.equal(before);
  });

  it("copies with linked packages have the same hash", () => {
    const a = [], b = [];
    const firstHash = hashOf(first, undefined, {trace: value => a.push(String(value))});
    expect(hashOf(second, undefined, {trace: value => b.push(String(value))})).to.equal(firstHash);
    expect(b, "the exact hashed inputs also match").to.deep.equal(a);
    expect(a.join(""), "locations never enter the hash").not.to.contain(scratch);
  });
  it("a source edit changes the hash", () => {
    const before = hashOf(first);
    writeFileSync(join(first, "src", "zcl_identity.clas.abap"), "* changed source\n");
    expect(hashOf(first)).not.to.equal(before);
  });
  for (const folder of ["src", "webapp", "pack-data"]) it(`${folder}: navigation trace metadata does not rename a generation`, () => {
    mkdirSync(join(first, folder), {recursive: true});
    const inputs = inputsOf(first);
    inputs.packFolders = [join(first, "pack-data")];
    const before = hashOf(first, inputs);
    const file = join(first, folder, "zcl_identity.clas.trace.meta.json");
    writeFileSync(file, JSON.stringify({generatedAt: "first", navigation: {line: 1}}));
    expect(hashOf(first, inputs), "optional navigation metadata is not compiler input").to.equal(before);
    writeFileSync(file, JSON.stringify({generatedAt: "second", navigation: {line: 2}}));
    expect(hashOf(first, inputs), "editing metadata leaves generated code unchanged").to.equal(before);
  });
  it("a tar/untar and package relink preserve every framed hash input", () => {
    const trace = root => {
      const inputs = [];
      const hash = hashOf(root, undefined, {trace: value => inputs.push(String(value))});
      return {hash, inputs};
    };
    const before = trace(first);
    const archive = join(scratch, "built-tree.tar");
    execFileSync("tar", ["--exclude=node_modules", "-cf", archive, "-C", first, "."]);
    rmSync(second, {recursive: true});
    mkdirSync(second);
    execFileSync("tar", ["-xf", archive, "-C", second]);
    mkdirSync(join(second, "node_modules", "@abaplint"), {recursive: true});
    for (const name of ["transpiler", "runtime"]) {
      symlinkSync(join(second, "local", name), join(second, "node_modules", "@abaplint", name));
    }
    expect(trace(second)).to.deep.equal(before);
  });
  for (const name of ["transpiler", "runtime"]) {
    it(`a ${name} build edit changes the hash even with the same version`, () => {
      const before = hashOf(first);
      writeFileSync(join(first, "local", name, "build", "index.js"), "module.exports = {changed: true};\n");
      expect(hashOf(first)).not.to.equal(before);
    });
    it(`a ${name} edit with restored mtime still changes identity`, () => {
      const before = hashOf(first);
      const file = join(first, "local", name, "build", "index.js");
      writeFileSync(file, "module.exports = [];\n");
      utimesSync(file, new Date(0), new Date(0));
      expect(hashOf(first)).not.to.equal(before);
    });
    it(`a ${name} version edit changes the hash`, () => {
      const before = hashOf(first);
      const file = join(first, "local", name, "package.json");
      const meta = JSON.parse(readFileSync(file, "utf8"));
      writeFileSync(file, JSON.stringify({...meta, version: "1.0.1"}));
      expect(hashOf(first)).not.to.equal(before);
    });
    it(`materialising ${name} and changing timestamps preserves identity`, () => {
      const before = hashOf(first);
      const installed = join(first, "node_modules", "@abaplint", name);
      rmSync(installed);
      cpSync(join(first, "local", name), installed, {recursive: true});
      utimesSync(join(installed, "build", "index.js"), new Date(0), new Date(0));
      writeFileSync(join(installed, "build", "index.js.map"), "packaging may remove this map");
      writeFileSync(join(installed, "build", "index.d.ts"), "export {};");
      expect(hashOf(first)).to.equal(before);
    });
  }
});
