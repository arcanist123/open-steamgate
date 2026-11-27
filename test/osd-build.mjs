import {expect} from "chai";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {execFileSync, spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {pathToFileURL} from "node:url";
import {dirname, join, relative, resolve} from "node:path";
import {build, genHash, hashOf, inputsOf, liveHash, missingLibraries} from "../tools/osd-build.mjs";
import {packsOf} from "../tools/osd-packs.mjs";
import {CLOSURE, ciClosure} from "../tools/osd-ci-closure.mjs";
import {publicProvenance} from "../tools/osd-public-tree.mjs";
import {transpile} from "../tools/osd-transpile.mjs";
import {syntheticCiTranspiler, syntheticReads} from "./helpers/fix7-fixtures.mjs";
import {makeReadRecord, sha256} from "../tools/osd-read-record.mjs";

// The builder over a tree of its own. What is cheap to check here is what
// it refuses before it does anything: a full generation takes the real
// transpiler and lives in test/osd-child.mjs and the workbench.
describe("tools/osd-build: the layers, refused before a lock is taken", function () {
  this.timeout(30000);
  let root;
  const write = (file, text = "") => {
    mkdirSync(join(root, file, ".."), {recursive: true});
    writeFileSync(join(root, file), text);
  };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-build-"));
    // the config loader is the transpiler's own, resolved from the tree
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "local/used"], output_folder: "output"}));
  });

  afterEach(() => rmSync(root, {recursive: true, force: true}));

  it("compiles source without entering transient Git metadata", async () => {
    write("src/zmetadata.prog.abap", "REPORT zmetadata. WRITE 'ok'.\n");
    mkdirSync(join(root, "src/.git"));
    // A vanished metadata target must not abort discovery of real ABAP.
    symlinkSync(join(root, "removed-index-lock"), join(root, "src/.git/index.lock"));
    const config = {input_folder: ["src"], output_folder: "output", options: {unknownTypes: "compileError"}};
    const made = await transpile({root, config});
    expect(made.objects).to.equal(1);
    expect(readFileSync(join(root, "output/zmetadata.prog.mjs"), "utf8")).to.include("abap.statements.write");
  });

  it("CI restore verification accepts matching inputs and refuses a stale generation", async () => {
    write("src/zcl_archive.clas.abap", "CLASS zcl_archive DEFINITION PUBLIC. ENDCLASS. CLASS zcl_archive IMPLEMENTATION. ENDCLASS.\n");
    const built = await build({root, generators: false});
    const verify = () => spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "verify"], {cwd: root, encoding: "utf8"});
    // unpacked without its closure list: refused, fail closed
    const unlisted = verify();
    expect(unlisted.status, unlisted.stdout + unlisted.stderr).to.equal(2);
    expect(unlisted.stderr).to.include("closure.json is missing");
    // a real build's shared sources are what live reaches, each by its digest
    const closure = await ciClosure(root, built.hash);
    expect(Object.keys(closure.files).length).to.be.greaterThan(0);
    write(CLOSURE, JSON.stringify(closure));
    const fresh = verify();
    expect(fresh.status, fresh.stdout + fresh.stderr).to.equal(0);
    expect(JSON.parse(fresh.stdout.split("generation: ")[1])).to.include({live: built.hash, tree: built.hash});
    write("src/zcl_archive.clas.abap", "* changed source\n");
    const stale = verify();
    expect(stale.status, stale.stdout + stale.stderr).to.equal(1);
    expect(liveHash(root)).to.equal(built.hash);
  });

  it("records generator source reads and flags bytes outside the declared hash", () => {
    write("src/zrecord.prog.abap", "REPORT zrecord.\n");
    const file = join(root, "src/zrecord.prog.abap");
    const log = join(root, "reads.jsonl");
    const child = spawnSync(process.execPath, ["--import", resolve("tools/osd-generator-reads.mjs"), "--input-type=module", "-e",
      "import {readFileSync} from 'node:fs'; readFileSync(process.env.OSD_TEST_READ);"],
    {cwd: root, env: {...process.env, OSD_ROOT: root, OSD_GENERATOR_READS: log, OSD_TEST_READ: file}, encoding: "utf8"});
    expect(child.status, child.stderr).to.equal(0);
    const entries = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
    expect(entries.map(entry => entry.path)).to.deep.equal(["src/zrecord.prog.abap"]);
    expect(makeReadRecord(root, new Map([[file, sha256(readFileSync(file))]]), entries).uncovered).to.deep.equal([]);
    expect(makeReadRecord(root, new Map(), entries).uncovered).to.deep.equal(["src/zrecord.prog.abap"]);
    write("build/inactive/active/src/zrecord.prog.abap", "REPORT active.\n");
    const overlayLog = join(root, "overlay-reads.jsonl");
    const overlay = {exclude: [file], folder: "build/inactive/active"};
    const projected = spawnSync(process.execPath, ["--import", resolve("tools/osd-generator-view.mjs"),
      "--import", resolve("tools/osd-generator-reads.mjs"), "--input-type=module", "-e",
      "import {readFileSync} from 'node:fs'; readFileSync(process.env.OSD_TEST_READ);"],
    {cwd: root, env: {...process.env, OSD_ROOT: root, OSD_GENERATOR_READS: overlayLog,
      OSD_ACTIVE_BUILD_OVERLAY: JSON.stringify(overlay), OSD_TEST_READ: file}, encoding: "utf8"});
    expect(projected.status, projected.stderr).to.equal(0);
    expect(JSON.parse(readFileSync(overlayLog, "utf8").trim()).path).to.equal("build/inactive/active/src/zrecord.prog.abap");
  });

  // FIX7c: what the generators read is hashed whole -- a locked library's
  // code (open-abap-gui's converter), the root's table rows and lint config
  it("hashes a library's code, root data and the lint config that generators read", () => {
    write("abap_transpile.json", JSON.stringify({input_folder: ["src"], output_folder: "output", libs: [{folder: "zlib"}]}));
    write("src/zhash.prog.abap", "REPORT zhash.\n");
    write("zlib/src/zcl_zlib.clas.abap", "CLASS zcl_zlib DEFINITION PUBLIC. ENDCLASS. CLASS zcl_zlib IMPLEMENTATION. ENDCLASS.\n");
    write("zlib/converter/src/zconvert.mjs", "export const synthetic = 1;\n");
    write("data/zsynthetic.tabu.json", "[]\n");
    write("abaplint.jsonc", "{}\n");
    const named = new Map();
    const before = hashOf(root, inputsOf(root), {digests: named});
    for (const file of ["zlib/converter/src/zconvert.mjs", "data/zsynthetic.tabu.json", "abaplint.jsonc"]) {
      expect(named.has(join(root, file)), file).to.equal(true);
    }
    write("zlib/converter/src/zconvert.mjs", "export const synthetic = 2;\n");
    expect(hashOf(root, inputsOf(root))).not.to.equal(before);
  });

  it("hashes the identity of a fetched folder that brought no files", () => {
    const oci = `localhost:5000/synthetic/pack@sha256:${"b".repeat(64)}`;
    write("src/zident.prog.abap", "REPORT zident.\n");
    write("packs/test/osd-pack.json", JSON.stringify({abap: ["src"], sources: [{folder: "empty", oci}]}));
    write("packs/test/src/ztest.prog.abap", "REPORT ztest.\n");
    const identity = {oci, path: "src", exclude: [], files: 0, private: false};
    write("packs/test/.osd-fetched.json", JSON.stringify({empty: identity}));
    write("packs/test/empty/.osd-source.json", JSON.stringify(identity));
    const named = new Map();
    hashOf(root, inputsOf(root), {digests: named});
    expect(named.has(join(root, "packs/test/empty/.osd-source.json"))).to.equal(true);
  });

  // FIX8 M2: finding the packs reads every manifest before OSD_WEB_PACKS
  // narrows what is built
  it("hashes what finding the packs reads, a pack the selection leaves out too", () => {
    const oci = `localhost:5000/synthetic/left@sha256:${"c".repeat(64)}`;
    write("src/zsel.prog.abap", "REPORT zsel.\n");
    write("packs/zleft/osd-pack.json", JSON.stringify({abap: ["src"], sources: [{folder: "upstream", oci}]}));
    write("packs/zleft/src/zleft.prog.abap", "REPORT zleft.\n");
    write("packs/zleft/upstream/.osd-source.json", JSON.stringify({oci, path: "src", exclude: [], private: false}));
    const saved = process.env.OSD_WEB_PACKS;
    process.env.OSD_WEB_PACKS = "";
    try {
      const log = join(root, "packs-reads.jsonl");
      const child = spawnSync(process.execPath, ["--import", resolve("tools/osd-generator-reads.mjs"), "--input-type=module", "-e",
        `import {packsOf} from ${JSON.stringify(pathToFileURL(resolve("tools/osd-packs.mjs")).href)}; packsOf(process.env.OSD_ROOT);`],
      {cwd: root, env: {...process.env, OSD_ROOT: root, OSD_GENERATOR_READS: log}, encoding: "utf8"});
      expect(child.status, child.stderr).to.equal(0);
      const entries = readFileSync(log, "utf8").trim().split("\n").map(JSON.parse);
      expect(entries.map(entry => entry.path)).to.include("packs/zleft/osd-pack.json");
      // an identity carries a fetch time: a left-out pack's is not read at all
      expect(entries.map(entry => entry.path)).not.to.include("packs/zleft/upstream/.osd-source.json");
      const inputs = inputsOf(root);
      expect(inputs.packFiles).to.deep.equal([]);
      const named = new Map();
      const before = hashOf(root, inputs, {digests: named});
      expect(makeReadRecord(root, named, entries).uncovered).to.deep.equal([]);
      write("packs/zleft/osd-pack.json", JSON.stringify({abap: ["src"], sources: [{folder: "upstream", oci}], description: "edited"}));
      expect(hashOf(root, inputsOf(root))).not.to.equal(before);
    } finally {
      if (saved === undefined) delete process.env.OSD_WEB_PACKS; else process.env.OSD_WEB_PACKS = saved;
    }
  });

  // P2-4: a checkout fetched before privacy was recorded still builds; only
  // publishing refuses it, and says to rerun osd-fetch
  it("builds over a fetched identity without recorded privacy and refuses to publish it", async () => {
    const oci = `localhost:5000/synthetic/pack@sha256:${"a".repeat(64)}`;
    write("src/zdev.prog.abap", "REPORT zdev.\n");
    write("packs/test/osd-pack.json", JSON.stringify({abap: ["upstream"], sources: [{folder: "upstream", oci}]}));
    write("packs/test/upstream/ztest.prog.abap", "REPORT ztest.\n");
    const identity = {oci, path: "src", exclude: [], files: 1};
    write("packs/test/.osd-fetched.json", JSON.stringify({upstream: identity}));
    write("packs/test/upstream/.osd-source.json", JSON.stringify(identity));
    const built = await build({root, generators: false});
    expect(liveHash(root)).to.equal(built.hash);
    const manifest = JSON.parse(readFileSync(join(root, "build/live/manifest.json"), "utf8"));
    expect(manifest.provenance.find(input => input.path === "packs/test/upstream").private).to.equal(null);
    expect(() => publicProvenance(root)).to.throw(/rerun node tools\/osd-fetch.mjs/);
  });

  it("records a private W3MI media link even when its extension is normally skipped", async () => {
    const privateTree = mkdtempSync(join(tmpdir(), "osd-media-private-"));
    try {
      write("src/zmedia.prog.abap", "REPORT zmedia.\n");
      mkdirSync(join(privateTree, "media"));
      writeFileSync(join(privateTree, ".osd-source.json"), JSON.stringify({private: true}));
      writeFileSync(join(privateTree, "media/zmedia.w3mi.data.txt"), "synthetic media");
      write("packs/media/osd-pack.json", JSON.stringify({abap: ["src"]}));
      mkdirSync(join(root, "packs/media/src"), {recursive: true});
      symlinkSync(join(privateTree, "media/zmedia.w3mi.data.txt"), join(root, "packs/media/src/zmedia.w3mi.data.txt"));
      const inputs = inputsOf(root);
      const named = new Map();
      hashOf(root, inputs, {digests: named});
      expect(named.has(join(root, "packs/media/src/zmedia.w3mi.data.txt"))).to.equal(true);
      const built = await build({root, generators: false});
      const manifest = JSON.parse(readFileSync(join(root, "build/live/manifest.json"), "utf8"));
      expect(manifest.systemPrivate).to.equal(true);
      expect(JSON.parse(readFileSync(join(root, "build/live/reads.json"), "utf8")).reads.some(entry => entry.privacy === true)).to.equal(true);
      expect(() => publicProvenance(root)).to.throw().with.property("code", "PRIVATE_LAYER");
      expect(built.hash).to.match(/^[0-9a-f]{16}$/);
    } finally { rmSync(privateTree, {recursive: true, force: true}); }
  });

  it("records a gen/ link into a private tree that the transpiler reads", async () => {
    const privateTree = mkdtempSync(join(tmpdir(), "osd-gen-link-"));
    try {
      writeFileSync(join(privateTree, ".osd-source.json"), JSON.stringify({private: true}));
      writeFileSync(join(privateTree, "zlinked.prog.abap"), "REPORT zlinked.\n");
      write("abap_transpile.json", JSON.stringify({input_folder: ["src", "gen"], output_folder: "output"}));
      write("src/zplain.prog.abap", "REPORT zplain.\n");
      mkdirSync(join(root, "gen"), {recursive: true});
      symlinkSync(join(privateTree, "zlinked.prog.abap"), join(root, "gen/zlinked.prog.abap"));
      await build({root, generators: false});
      const record = JSON.parse(readFileSync(join(root, "build/live/reads.json"), "utf8"));
      expect(record.reads.some(entry => entry.path === "gen/zlinked.prog.abap" && entry.privacy === true)).to.equal(true);
      expect(() => publicProvenance(root)).to.throw().with.property("code").that.is.oneOf(["PRIVATE_LAYER", "UNKNOWN_PRIVACY"]);
    } finally { rmSync(privateTree, {recursive: true, force: true}); }
  });

  it("records a URL-only library's private clone identity", async () => {
    const repo = mkdtempSync(join(tmpdir(), "osd-url-lib-"));
    try {
      mkdirSync(join(repo, "src"));
      writeFileSync(join(repo, ".osd-source.json"), JSON.stringify({private: true}));
      writeFileSync(join(repo, "src/zcl_synthetic.clas.abap"), "CLASS zcl_synthetic DEFINITION PUBLIC. ENDCLASS. CLASS zcl_synthetic IMPLEMENTATION. ENDCLASS.\n");
      execFileSync("git", ["init", "-q", repo]);
      execFileSync("git", ["-C", repo, "add", "."]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
      const commit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
      write("abap_transpile.json", JSON.stringify({input_folder: ["src"], output_folder: "output", libs: [{url: `file://${repo}`, commit}]}));
      write("src/zurl.prog.abap", "REPORT zurl.\n");
      await build({root, generators: false});
      const manifest = JSON.parse(readFileSync(join(root, "build/live/manifest.json"), "utf8"));
      expect(manifest.systemPrivate).to.equal(true);
      expect(manifest.provenance.some(entry => entry.kind === "source-real" && entry.private === true)).to.equal(true);
      expect(() => publicProvenance(root)).to.throw().with.property("code", "PRIVATE_LAYER");
      rmSync(join(repo, ".osd-source.json"));
      execFileSync("git", ["-C", repo, "add", "-u"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "public fixture"]);
      const next = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
      write("abap_transpile.json", JSON.stringify({input_folder: ["src"], output_folder: "output", libs: [{url: `file://${repo}`, commit: next}]}));
      await build({root, generators: false});
      const unknown = JSON.parse(readFileSync(join(root, "build/live/manifest.json"), "utf8"));
      expect(unknown.systemPrivate).to.equal(null);
      expect(() => publicProvenance(root)).to.throw();
      writeFileSync(join(repo, ".osd-source.json"), JSON.stringify({private: false}));
      execFileSync("git", ["-C", repo, "add", ".osd-source.json"]);
      execFileSync("git", ["-C", repo, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "public identity"]);
      const publicCommit = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"], {encoding: "utf8"}).trim();
      write("abap_transpile.json", JSON.stringify({input_folder: ["src"], output_folder: "output", libs: [{url: `file://${repo}`, commit: publicCommit}]}));
      await build({root, generators: false});
      const publicRecord = JSON.parse(readFileSync(join(root, "build/live/reads.json"), "utf8"));
      expect(publicRecord.uncovered).to.deep.equal([]);
      expect(() => publicProvenance(root)).not.to.throw();
      const cache = inputsOf(root).libs[0];
      writeFileSync(join(cache, "src/unlisted.prog.abap"), "REPORT unlisted.\n");
      let rejected;
      try { await build({root, generators: false}); } catch (error) { rejected = error; }
      expect(rejected?.message).to.include("outside its pinned commit");
    } finally { rmSync(repo, {recursive: true, force: true}); }
  });

  it("hardening 1: CI pack and tar restore retain fetched source markers", () => {
    const oci = `ghcr.io/example/pack@sha256:${"a".repeat(64)}`;
    write("packs/test/osd-pack.json", JSON.stringify({abap: ["upstream"], sources: [{folder: "upstream", oci}]}));
    write("packs/test/upstream/ztest.prog.abap", "REPORT ztest.");
    const marker = JSON.stringify({upstream: {oci, path: "src", exclude: [], files: 1, private: false}});
    write("packs/test/.osd-fetched.json", marker);
    write("packs/test/upstream/.osd-source.json", JSON.stringify(JSON.parse(marker).upstream));
    for (const path of ["gen", "build", ".local/lars", ".local/ci-artifact/transpiler"]) mkdirSync(join(root, path), {recursive: true});
    syntheticCiTranspiler(root);
    // osd-ci-artifact derives live's cross-reference rows from the tree's own config
    write("abaplint.jsonc", readFileSync(resolve("abaplint.jsonc")));
    const hash = hashOf(root, inputsOf(root));
    write(`build/by-input/${hash}/manifest.json`, JSON.stringify({hash, systemDigest: null, systemPrivate: false,
      provenance: [{kind: "pack-oci", path: "packs/test/upstream", private: false}], gen: genHash(root)}));
    syntheticReads(root, hash);
    write(`build/by-input/${hash}/source-inputs.json`, "{}");
    mkdirSync(join(root, `build/by-input/${hash}/output`));
    symlinkSync(`by-input/${hash}`, join(root, "build/live"));
    symlinkSync("build/live/output", join(root, "output"));
    const archive = join(root, "artifact.tar");
    const packed = spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root, encoding: "utf8"});
    expect(packed.status, packed.stderr).to.equal(0);
    rmSync(join(root, "packs/test/upstream"), {recursive: true});
    rmSync(join(root, "packs/test/.osd-fetched.json"));
    execFileSync("tar", ["-xf", archive], {cwd: root});
    expect(existsSync(join(root, "packs/test/.osd-fetched.json"))).to.equal(true);
    expect(JSON.parse(readFileSync(join(root, "packs/test/upstream/.osd-source.json")))).to.deep.equal(JSON.parse(marker).upstream);
    expect(readFileSync(join(root, "packs/test/.osd-fetched.json"), "utf8")).to.equal(marker);
    expect(packsOf(root, {})[0].missing).to.deep.equal([]);
    // Removing a marker changes the declared input closure; the old
    // generation cannot be relabelled as the new tree.
    rmSync(join(root, "packs/test/.osd-fetched.json"));
    expect(spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root}).status).not.to.equal(0);
  });

  it("refuses to pack a CI artifact from a private live generation", () => {
    for (const path of ["gen", "output", "packs", ".local/lars", ".local/ci-artifact/transpiler", "build/by-input/fixture"]) mkdirSync(join(root, path), {recursive: true});
    write("build/by-input/fixture/manifest.json", JSON.stringify({systemDigest: null, systemPrivate: true}));
    symlinkSync("by-input/fixture", join(root, "build/live"));
    const archive = join(root, "artifact.tar");
    const packed = spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root, encoding: "utf8"});
    expect(packed.status, packed.stderr).to.not.equal(0);
    expect(packed.stderr).to.match(/private live generation cannot be published/);
    expect(existsSync(archive)).to.equal(false);
  });

  // The archive carries only the live generation. Older cache entries stay out.
  it("packs only the live generation beside older private or unrecorded cache entries", () => {
    for (const path of ["gen", "packs", ".local/lars", ".local/ci-artifact/transpiler", "build/by-input/older"]) mkdirSync(join(root, path), {recursive: true});
    syntheticCiTranspiler(root);
    write("abaplint.jsonc", readFileSync(resolve("abaplint.jsonc")));
    const hash = hashOf(root, inputsOf(root));
    write(`build/by-input/${hash}/manifest.json`, JSON.stringify({hash, systemDigest: null, systemPrivate: false, provenance: [], gen: genHash(root)}));
    syntheticReads(root, hash);
    write(`build/by-input/${hash}/source-inputs.json`, "{}");
    mkdirSync(join(root, `build/by-input/${hash}/output`));
    symlinkSync(`by-input/${hash}`, join(root, "build/live"));
    symlinkSync("build/live/output", join(root, "output"));
    const archive = join(root, "artifact.tar");
    const pack = () => spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root, encoding: "utf8"});
    for (const older of [{systemDigest: `sha256:${"a".repeat(64)}`, systemPrivate: true}, {hash: "older"}]) {
      write("build/by-input/older/manifest.json", JSON.stringify(older));
      const packed = pack();
      expect(packed.status, packed.stderr).to.equal(0);
      const names = execFileSync("tar", ["-tf", archive], {encoding: "utf8"});
      expect(names).not.to.include("build/by-input/older/");
    }
    expect(existsSync(archive)).to.equal(true);
  });

  it("records the system a generation was built from and rebuilds a generation without that record", async () => {
    write("src/zcl_recorded.clas.abap", "CLASS zcl_recorded DEFINITION PUBLIC. ENDCLASS. CLASS zcl_recorded IMPLEMENTATION. ENDCLASS.\n");
    const first = await build({root, generators: false});
    const file = join(root, "build", "by-input", first.hash, "manifest.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).to.include({systemDigest: null, systemPrivate: false});
    const {systemDigest, systemPrivate, ...old} = JSON.parse(readFileSync(file, "utf8"));
    writeFileSync(file, JSON.stringify(old));
    const again = await build({root, generators: false});
    expect(again.hash).to.equal(first.hash);
    expect(again.cached).to.equal(false);
    expect(JSON.parse(readFileSync(file, "utf8"))).to.include({systemDigest: null, systemPrivate: false});
    expect((await build({root, generators: false})).cached).to.equal(true);
  });

  it("freezes identical compiler metadata across build locations and processes", async () => {
    write("src/zcl_frozen.clas.abap", "CLASS zcl_frozen DEFINITION PUBLIC. ENDCLASS. CLASS zcl_frozen IMPLEMENTATION. ENDCLASS.\n");
    const first = await build({root, generators: false});
    const frozen = readFileSync(join(root, "build", "by-input", first.hash, "compile-inputs.json"), "utf8");
    rmSync(join(root, "build"), {recursive: true, force: true});
    renameSync(root, `${root}-elsewhere`);
    root = `${root}-elsewhere`;
    const script = `import {build} from ${JSON.stringify(new URL("../tools/osd-build.mjs", import.meta.url).href)}; await build({root: process.cwd(), generators: false});`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script], {cwd: root});
    expect(readFileSync(join(root, "build", "by-input", first.hash, "compile-inputs.json"), "utf8")).to.equal(frozen);
    expect(JSON.parse(frozen).config.output_folder).to.equal("output");
  });

  // The builder starts a generator through tools/osd-host.mjs, which inside a
  // compiled binary becomes "osd gen <name>" and is answered from a map in
  // bin/osd.mjs. A generator the build runs and the map does not know exits
  // 2 there and nowhere else, so the two lists are compared rather than
  // remembered: osd-fm-registry.mjs had been missing from the map since it
  // was added, and no test would have said so.
  it("hands the binary every generator the build runs", () => {
    const named = (file, re) => [...readFileSync(file, "utf8").matchAll(re)].map((m) => m[1]);
    const runs = named("tools/osd-build.mjs", /^\s*\["([a-z0-9-]+\.mjs)"/gm);
    const known = named("bin/osd.mjs", /"([a-z0-9-]+\.mjs)": \(\) => import/g);
    expect(runs.length, "the build runs generators").to.be.greaterThan(5);
    expect(runs.filter((one) => known.includes(one) === false)).to.deep.equal([]);
  });

  it("renames a generation when a BSP page changes, including JavaScript", () => {
    write("src/bsp/apps.json", JSON.stringify({ZOSD_TAXI_ANAL: {folder: "webapp/taxi"}}));
    write("webapp/taxi/Component.js", "first");
    const first = hashOf(root);
    write("webapp/taxi/Component.js", "second");
    expect(hashOf(root)).not.to.equal(first);
  });

  it("hashes library content reached through a symlinked directory", () => {
    write("src/zcl_one.clas.abap", "");
    write("library-source/src/if_library.intf.abap", "INTERFACE if_library. ENDINTERFACE.\n");
    mkdirSync(join(root, ".local/lars/library"), {recursive: true});
    symlinkSync(join(root, "library-source", "src"), join(root, ".local/lars/library/src"), "dir");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["src"],
      output_folder: "output",
      libs: [{folder: "/.local/lars/library"}],
    }));
    const first = hashOf(root);
    write("library-source/src/if_library.intf.abap", "INTERFACE if_library. CONSTANTS changed TYPE abap_bool VALUE abap_true. ENDINTERFACE.\n");
    expect(hashOf(root)).not.to.equal(first);
  });

  it("refuses a name twice inside one input, naming both files, and builds nothing", async () => {
    write("src/a/zcl_two.clas.abap", "");
    write("src/b/zcl_two.clas.abap", "");
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("DUPLICATE");
    expect(refused.message).to.contain("src/a/zcl_two.clas.abap, src/b/zcl_two.clas.abap");
    expect(refused.duplicates).to.deep.equal([{object: "CLAS ZCL_TWO", folder: "src", files: ["src/a/zcl_two.clas.abap", "src/b/zcl_two.clas.abap"]}]);
    // nothing was started: no lock, no tmp, no generation
    expect(existsSync(join(root, "build"))).to.equal(false);
  });

  it("refuses a pack whose declared source is not fetched, and builds nothing", async () => {
    write("src/zcl_one.clas.abap", "");
    write("packs/theirs/osd-pack.json", JSON.stringify({sources: [{folder: "upstream", repo: "https://example.invalid/theirs", ref: "abcdef0123456789", path: "src"}]}));
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("UNFETCHED");
    expect(refused.message).to.contain("pack theirs fetches upstream from https://example.invalid/theirs at abcdef012345");
    expect(refused.message).to.contain("node tools/osd-fetch.mjs");
    expect(existsSync(join(root, "build"))).to.equal(false);
  });

  it("refuses an incomplete library closure and leaves the live generation untouched", async () => {
    write("src/zcl_one.clas.abap", "");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["src"],
      output_folder: "output",
      libs: [{
        url: "https://github.com/open-abap/open-abap-core",
        folder: "/.local/lars/open-abap-core",
      }],
    }));
    write("build/by-input/known-good/output/init.mjs", "export const good = true;\n");
    symlinkSync(join("by-input", "known-good"), join(root, "build", "live"));

    expect(missingLibraries(root)).to.deep.equal([{
      url: "https://github.com/open-abap/open-abap-core",
      folder: "/.local/lars/open-abap-core",
    }]);
    let refused;
    try {
      await build({root});
    } catch (error) {
      refused = error;
    }
    expect(refused?.code).to.equal("MISSING_LIBRARIES");
    expect(refused.message).to.contain("npm run osd:worktree");
    expect(readlinkSync(join(root, "build", "live"))).to.equal(join("by-input", "known-good"));
    expect(existsSync(join(root, "build", ".lock"))).to.equal(false);
    expect(existsSync(join(root, "build", "tmp"))).to.equal(false);
  });

  // N3: the transpile is a library call. The CLI is the oracle, run over the
  // same tree into a folder of its own, and the two outputs are compared
  // file by file. The CLI now groups project objects in project/, whereas
  // OSG keeps its flat module layout. Resolve map sources and normalize only
  // those module paths and the transpiler temporary counter before comparing.
  it("matches CLI code and source mappings across output layouts", async function () {
    this.timeout(120000);
    const CLASS = (name, method) => `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.\n  PUBLIC SECTION.\n    METHODS ${method}.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD ${method}.\n  ENDMETHOD.\nENDCLASS.\n`;
    write("src/zcl_one.clas.abap", CLASS("zcl_one", "first"));
    write("src/zcl_one.clas.xml", "");
    write("src/zosd_report.prog.abap", "REPORT zosd_report.\nWRITE 'hi'.\n");
    write("local/used/zcl_two.clas.abap", CLASS("zcl_two", "second"));
    const config = {input_folder: ["src", "local/used"], output_folder: "output-cli", write_unit_tests: true, write_source_map: true,
                    options: {addFilenames: true, addCommonJS: true, unknownTypes: "compileError"}};
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify(config));
    const cli = process.env.OSD_TEST_TRANSPILE_CLI ? resolve(process.env.OSD_TEST_TRANSPILE_CLI) : join(root, "node_modules", ".bin", "abap_transpile");
    execFileSync(process.execPath, [cli], {cwd: root, stdio: "pipe"});
    const made = await transpile({root, config: {...config, output_folder: "output-lib"}});
    expect(made.objects).to.equal(3);
    const list = (dir) => readdirSync(join(root, dir), {recursive: true, withFileTypes: true})
      .filter(entry => entry.isFile())
      .map(entry => relative(join(root, dir), join(entry.parentPath, entry.name)).replaceAll("\\", "/")).sort();
    const flat = name => name.replace(/^project\//, "");
    expect(list("output-lib")).to.deep.equal(list("output-cli").map(flat).sort());
    const norm = (dir, name) => {
      const file = join(root, dir, name);
      const text = readFileSync(file, "utf8");
      if (name.endsWith(".map")) {
        const map = JSON.parse(text);
        map.sources = map.sources.map(source => resolve(dirname(file), decodeURIComponent(source)));
        const sourceText = map.sources.map(source => readFileSync(source, "utf8"));
        // CLI embeds source text; OSG maps point at the checkout's files.
        if (dir === "output-cli") expect(map.sourcesContent).to.be.an("array");
        if (dir === "output-cli" || map.sourcesContent) expect(map.sourcesContent).to.deep.equal(sourceText);
        delete map.sourcesContent;
        return map;
      }
      return text.replace(/unique\d+/g, "uniqueN")
        .replace(/"\.\/project\//g, '"./').replace(/"\.\.\/_init\.mjs"/g, '"./_init.mjs"');
    };
    for (const name of list("output-cli")) {
      expect(norm("output-lib", flat(name)), name).to.deep.equal(norm("output-cli", name));
    }
    // and the map names its source the way the CLI names it, relative to the output
    expect(readFileSync(join(root, "output-lib", "zcl_one.clas.mjs.map"), "utf8")).to.contain("../src/zcl_one.clas.abap");
  });
});

// Windows: a symlink to a directory needs an administrator or Developer Mode
// there, a junction needs neither, so build/live, output/ and a generation's
// roots are junctions on Windows (tools/osd-build.mjs linkDir). A junction's
// target is absolute; OSD_DIR_LINK=junction takes that form here too, so the
// path Windows takes is the path this test takes.
describe("tools/osd-build: the links a generation is reached through, as junctions", function () {
  this.timeout(120000);
  let root;
  let previous;
  const clas = (n) => `CLASS zcl_junction DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    CLASS-METHODS n RETURNING VALUE(rv) TYPE i.\nENDCLASS.\nCLASS zcl_junction IMPLEMENTATION.\n  METHOD n.\n    rv = ${n}.\n  ENDMETHOD.\nENDCLASS.\n`;

  before(() => {
    previous = process.env.OSD_DIR_LINK;
    process.env.OSD_DIR_LINK = "junction";
    root = realpathSync(mkdtempSync(join(tmpdir(), "osd-junction-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "zcl_junction.clas.abap"), clas(1));
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: "src", input_filter: [], output_folder: "output", libs: [], write_unit_tests: true,
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }));
    writeFileSync(join(root, "package.json"), "{}");
    symlinkSync(resolve("node_modules"), join(root, "node_modules"), "dir");
  });
  after(() => {
    if (previous === undefined) delete process.env.OSD_DIR_LINK;
    else process.env.OSD_DIR_LINK = previous;
    rmSync(root, {recursive: true, force: true});
  });

  it("builds, switches and resolves through absolute links", async () => {
    const first = await build({root, generators: false});
    const live = readlinkSync(join(root, "build", "live"));
    expect(live.startsWith("/"), live).to.equal(true);
    expect(live.endsWith(join("by-input", first.hash))).to.equal(true);
    expect(liveHash(root)).to.equal(first.hash);
    expect(readlinkSync(join(root, "output")).startsWith("/")).to.equal(true);
    expect(readFileSync(join(root, "output", "zcl_junction.clas.mjs"), "utf8")).to.include("IntegerFactory.get(1)");

    writeFileSync(join(root, "src", "zcl_junction.clas.abap"), clas(2));
    const second = await build({root, generators: false});
    expect(second.hash).to.not.equal(first.hash);
    expect(liveHash(root)).to.equal(second.hash);
    expect(readFileSync(join(root, "output", "zcl_junction.clas.mjs"), "utf8")).to.include("IntegerFactory.get(2)");
  });

  it("reads the live generation off a link with a trailing separator, as a junction reads back", () => {
    const at = join(root, "build", "live");
    rmSync(at);
    symlinkSync(join(root, "build", "by-input", "abc123") + "/", at);
    expect(liveHash(root)).to.equal("abc123");
  });
});
