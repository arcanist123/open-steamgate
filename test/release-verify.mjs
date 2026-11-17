// scripts/release-verify.mjs reads an artefact's header, not its name: a
// binary for another target, or one whose sidecar digest is not its own, is
// refused before a release uploads it. The serve and pages checks run in the
// release and preview workflows against the real artefacts.
import {expect} from "chai";
import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {adtSourcePath, checkBinary, checkReleaseBinary, executableOf} from "../scripts/release-verify.mjs";
import {verifyPublicArtefact, writeArtefactProvenance} from "../tools/osd-provenance.mjs";
import {hashOf, inputsOf} from "../tools/osd-build.mjs";
import {stageVscodeWeb} from "../scripts/stage-vscode-web.mjs";
import {assertExtensionSources} from "../tools/osd-extension-sources.mjs";
import {verifiedWebBundle} from "../scripts/build-vsix.mjs";
import {syntheticCiTranspiler, syntheticReads} from "./helpers/fix7-fixtures.mjs";
import {prepareCiTranspiler, verifyCiTranspiler} from "../tools/osd-ci-transpiler.mjs";

const elf = (machine) => {
  const b = Buffer.alloc(64);
  b.writeUInt32BE(0x7f454c46, 0);
  b[4] = 2; b[5] = 1; // 64-bit, little endian
  b.writeUInt16LE(machine, 18);
  return b;
};
const macho = (cpu) => {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
};
const pe = (machine) => {
  const b = Buffer.alloc(256);
  b.write("MZ", 0, "latin1");
  b.writeUInt32LE(0x80, 0x3c);
  b.write("PE\0\0", 0x80, "latin1");
  b.writeUInt16LE(machine, 0x84);
  return b;
};

describe("scripts/release-verify: an artefact by its content", () => {
  let dir;
  before(() => { dir = mkdtempSync(join(tmpdir(), "osd-release-verify-")); });
  after(() => rmSync(dir, {recursive: true, force: true}));

  const write = (name, bytes, digest) => {
    const file = join(dir, name);
    writeFileSync(file, bytes);
    writeFileSync(`${file}.sha256`, `${digest ?? createHash("sha256").update(bytes).digest("hex")}  ${name}\n`);
    return file;
  };

  // vscode-v0.7.3126 failed here: the newest changed source was
  // src/gateway/compat/#iwbep#cx_mgw_base_exception.clas.abap, and the
  // check asked ADT for a class named "#iwbep#cx_mgw_base_exception"
  it("asks ADT for a namespaced source by its object name, not its abapGit file name", () => {
    expect(adtSourcePath("src/gateway/compat/#iwbep#cx_mgw_base_exception.clas.abap"))
      .to.equal("/sap/bc/adt/oo/classes/%2Fiwbep%2Fcx_mgw_base_exception/source/main");
    expect(adtSourcePath("src/demo/zcl_zstg_demo_dpc_ext.clas.abap"))
      .to.equal("/sap/bc/adt/oo/classes/zcl_zstg_demo_dpc_ext/source/main");
    expect(adtSourcePath("packs/x/src/#dmo#flight report.prog.abap"))
      .to.equal("/sap/bc/adt/programs/programs/%2Fdmo%2Fflight%20report/source/main");
    expect(adtSourcePath("src/z%odd.clas.abap")).to.equal("/sap/bc/adt/oo/classes/z%25odd/source/main");
    expect(() => adtSourcePath("src/zfoo.intf.abap")).to.throw(/not an ABAP class or program/);
  });

  it("reads the format and machine of each release target's header", () => {
    expect(executableOf(elf(0x3e))).to.deep.equal({format: "elf", machine: 0x3e});
    expect(executableOf(elf(0xb7))).to.deep.equal({format: "elf", machine: 0xb7});
    expect(executableOf(macho(0x0100000c))).to.deep.equal({format: "macho", machine: 0x0100000c});
    expect(executableOf(pe(0x8664))).to.deep.equal({format: "pe", machine: 0x8664});
    expect(executableOf(macho(0x01000007))).to.deep.equal({format: "macho", machine: 0x01000007});
    expect(executableOf(pe(0xaa64))).to.deep.equal({format: "pe", machine: 0xaa64});
    expect(executableOf(Buffer.from("#!/bin/sh\n")).format).to.equal("unknown");
  });

  it("accepts a binary built for its target, with its own digest beside it", () => {
    expect(checkBinary(write("osd-linux-x64", elf(0x3e)), "bun-linux-x64-baseline").target).to.equal("bun-linux-x64-baseline");
    expect(checkBinary(write("osd-darwin-arm64", macho(0x0100000c)), "bun-darwin-arm64").bytes).to.equal(32);
    expect(checkBinary(write("osd-windows-x64.exe", pe(0x8664)), "bun-windows-x64-baseline").sha256).to.have.length(64);
    expect(checkBinary(write("osd-darwin-x64", macho(0x01000007)), "bun-darwin-x64-baseline").target).to.equal("bun-darwin-x64-baseline");
    expect(checkBinary(write("osd-windows-arm64.exe", pe(0xaa64)), "bun-windows-arm64").target).to.equal("bun-windows-arm64");
  });

  it("tells the two architectures of one format apart", () => {
    expect(() => checkBinary(write("e", macho(0x0100000c)), "bun-darwin-x64-baseline")).to.throw(/not the macho machine 0x1000007/);
    expect(() => checkBinary(write("f", pe(0x8664)), "bun-windows-arm64")).to.throw(/not the pe machine 0xaa64/);
    expect(() => checkBinary(write("g", macho(0x01000007)), "go-darwin-arm64")).to.throw(/not the macho machine 0x100000c/);
    expect(() => checkBinary(write("h", pe(0xaa64)), "go-windows-amd64")).to.throw(/not the pe machine 0x8664/);
  });

  it("refuses to release a binary built from a private live generation, OSGo included", () => {
    const source = join(dir, "private-source");
    mkdirSync(join(source, "build/by-input/fixture"), {recursive: true});
    writeFileSync(join(source, "abap_transpile.json"), JSON.stringify({input_folder: [], libs: []}));
    const generation = (record) => {
      writeFileSync(join(source, "build/by-input/fixture/manifest.json"), JSON.stringify(record));
      syntheticReads(source, "fixture");
    };
    symlinkSync("by-input/fixture", join(source, "build/live"));
    const binary = write("osgo-private", elf(0x3e));
    writeArtefactProvenance(binary, {generation: "old-private", systemDigest: null, systemPrivate: true, inputs: [{kind: "input", private: true}]});
    generation({systemDigest: null, systemPrivate: true});
    expect(() => checkReleaseBinary(binary, "go-linux-amd64", source)).to.throw().with.property("code", "PRIVATE_LAYER");
    generation({systemDigest: null});
    expect(() => checkReleaseBinary(binary, "go-linux-amd64", source)).to.throw(/no matching public system identity/);
    generation({hash: hashOf(source, inputsOf(source)), systemDigest: null, systemPrivate: false, provenance: []});
    expect(() => checkReleaseBinary(binary, "go-linux-amd64", source)).to.throw().with.property("code", "PRIVATE_LAYER");
    writeArtefactProvenance(binary, {generation: "public", systemDigest: null, systemPrivate: false, inputs: []});
    expect(checkReleaseBinary(binary, "go-linux-amd64", source).target).to.equal("go-linux-amd64");
    // the CLI the release workflow runs: test/osd-layer.mjs, "public entry points"
  });

  it("checks Go release formats by the bytes they contain", () => {
    expect(checkBinary(write("osgo-linux-x64", elf(0x3e)), "go-linux-amd64").bytes).to.equal(64);
    expect(checkBinary(write("osgo-linux-arm64", elf(0xb7)), "go-linux-arm64").target).to.equal("go-linux-arm64");
    expect(checkBinary(write("osgo-darwin-arm64", macho(0x0100000c)), "go-darwin-arm64").sha256).to.have.length(64);
    expect(checkBinary(write("osgo-windows-x64.exe", pe(0x8664)), "go-windows-amd64").bytes).to.equal(256);
    expect(checkBinary(write("osgo-darwin-x64", macho(0x01000007)), "go-darwin-amd64").target).to.equal("go-darwin-amd64");
    expect(checkBinary(write("osgo-windows-arm64.exe", pe(0xaa64)), "go-windows-arm64").target).to.equal("go-windows-arm64");
  });

  it("binds public provenance to exact file and directory bytes", () => {
    const source = {generation: "synthetic-public", systemDigest: null, systemPrivate: false, inputs: [{kind: "lib", private: false}]};
    const binary = join(dir, "provenance-binary");
    writeFileSync(binary, "public");
    expect(() => verifyPublicArtefact(binary)).to.throw().with.property("code", "BAD_PROVENANCE");
    writeArtefactProvenance(binary, source);
    expect(verifyPublicArtefact(binary).generation).to.equal("synthetic-public");
    writeFileSync(binary, "changed");
    expect(() => verifyPublicArtefact(binary)).to.throw().with.property("code", "BAD_PROVENANCE");
    unlinkSync(`${binary}.osd-provenance.json`);
    const preview = join(dir, "provenance-preview");
    mkdirSync(preview);
    writeFileSync(join(preview, "index.html"), "public");
    writeArtefactProvenance(preview, source);
    expect(verifyPublicArtefact(preview).files).to.have.property("index.html");
    writeFileSync(join(preview, "extra.txt"), "private bytes");
    expect(() => verifyPublicArtefact(preview)).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  it("records internal links and refuses links that escape a directory artefact", () => {
    const source = {generation: "links", systemDigest: null, systemPrivate: false, inputs: []};
    const artifact = join(dir, "linked-artifact");
    mkdirSync(join(artifact, "build/live/output"), {recursive: true});
    writeFileSync(join(artifact, "build/live/output/init.mjs"), "public");
    symlinkSync("build/live/output", join(artifact, "output"));
    writeArtefactProvenance(artifact, source);
    expect(verifyPublicArtefact(artifact).files.output.link).to.equal("build/live/output");
    symlinkSync("../outside", join(artifact, "escape"));
    expect(() => writeArtefactProvenance(artifact, source)).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  it("refuses to stage an unproven VS Code web bundle", async () => {
    const extension = join(dir, "extension");
    mkdirSync(join(extension, "dist/web"), {recursive: true});
    writeFileSync(join(extension, "dist/web/extension.js"), "synthetic bundle");
    let error;
    try { await stageVscodeWeb(extension, join(dir, "staged-extension")); } catch (caught) { error = caught; }
    expect(error?.code).to.equal("BAD_PROVENANCE");
  });

  it("stages a public VS Code web bundle with byte-bound provenance", async () => {
    const extension = join(dir, "public-extension");
    for (const part of ["dist/web", "resources", "walkthrough", "media"]) mkdirSync(join(extension, part), {recursive: true});
    writeFileSync(join(extension, "dist/web/extension.js"), "synthetic public bundle");
    for (const file of ["README.md", "CHANGELOG.md"]) writeFileSync(join(extension, file), "synthetic\n");
    writeFileSync(join(extension, "package.json"), JSON.stringify({name: "synthetic", version: "1.0.0", main: "desktop.js", browser: "dist/web/extension.js"}));
    const publicSource = {generation: "synthetic-public-web", systemDigest: null, systemPrivate: false, inputs: []};
    writeArtefactProvenance(join(extension, "dist/web"), publicSource);
    writeArtefactProvenance(extension, publicSource);
    const preview = join(dir, "public-preview");
    mkdirSync(preview);
    writeFileSync(join(preview, "index.html"), "synthetic preview");
    writeArtefactProvenance(preview, publicSource);
    const out = join(preview, "vscode-web");
    await stageVscodeWeb(extension, out);
    expect(verifyPublicArtefact(out).generation).to.equal("synthetic-public-web");
    expect(verifyPublicArtefact(preview).files).to.have.property("vscode-web/dist/web/extension.js");
  });

  it("refuses changed static web extension files outside the verified bundle", async () => {
    const extension = join(dir, "tampered-extension");
    for (const part of ["dist/web", "resources", "walkthrough", "media"]) mkdirSync(join(extension, part), {recursive: true});
    for (const file of ["README.md", "CHANGELOG.md"]) writeFileSync(join(extension, file), "synthetic\n");
    writeFileSync(join(extension, "package.json"), JSON.stringify({name: "synthetic", version: "1.0.0"}));
    writeFileSync(join(extension, "dist/web/extension.js"), "synthetic bundle");
    const source = {generation: "synthetic", systemDigest: null, systemPrivate: false, inputs: []};
    writeArtefactProvenance(join(extension, "dist/web"), source);
    writeArtefactProvenance(extension, source);
    writeFileSync(join(extension, "media/private.txt"), "synthetic private marker");
    let error;
    try { await stageVscodeWeb(extension, join(dir, "tampered-stage")); } catch (caught) { error = caught; }
    expect(error?.code).to.equal("BAD_PROVENANCE");
  });

  it("accepts only Git tracked static VSIX files when no directory record exists", () => {
    const extension = join(dir, "tracked-extension");
    mkdirSync(extension);
    writeFileSync(join(extension, "package.json"), "{}");
    execFileSync("git", ["init", "-q", extension]);
    execFileSync("git", ["-C", extension, "add", "package.json"]);
    execFileSync("git", ["-C", extension, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
    expect(() => assertExtensionSources(extension, ["package.json"])).not.to.throw();
    writeFileSync(join(extension, "private.txt"), "synthetic private marker");
    expect(() => assertExtensionSources(extension, ["private.txt"])).to.throw().with.property("code", "BAD_PROVENANCE");
    writeFileSync(join(extension, "staged.txt"), "staged only");
    execFileSync("git", ["-C", extension, "add", "staged.txt"]);
    expect(() => assertExtensionSources(extension, ["staged.txt"])).to.throw().with.property("code", "BAD_PROVENANCE");
    writeFileSync(join(extension, "package.json"), "{\"changed\":true}");
    expect(() => assertExtensionSources(extension, ["package.json"])).to.throw().with.property("code", "BAD_PROVENANCE");
    execFileSync("git", ["-C", extension, "checkout", "--", "package.json"]);
    writeFileSync(join(extension, ".gitignore"), "ignored.txt\n");
    writeFileSync(join(extension, "ignored.txt"), "ignored");
    expect(() => assertExtensionSources(extension, ["ignored.txt"])).to.throw().with.property("code", "BAD_PROVENANCE");
    writeFileSync(join(extension, ".osd-source.json"), JSON.stringify({private: true}));
    expect(() => assertExtensionSources(extension, ["package.json"])).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  // FIX8 S1/S2: index flags hide a worktree change from git's diff, never
  // from the bytes; a repository's fsmonitor program never runs
  it("refuses a change behind skip-worktree or assume-unchanged and never runs an fsmonitor", () => {
    const extension = join(dir, "flagged-extension");
    mkdirSync(extension);
    writeFileSync(join(extension, "package.json"), "{}");
    writeFileSync(join(extension, "zmedia.txt"), "synthetic public");
    const git = (...args) => execFileSync("git", ["-C", extension, ...args], {stdio: "pipe"});
    execFileSync("git", ["init", "-q", extension]);
    git("add", ".");
    git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture");
    expect(() => assertExtensionSources(extension, ["package.json", "zmedia.txt"])).not.to.throw();
    for (const flag of ["skip-worktree", "assume-unchanged"]) {
      git("update-index", `--${flag}`, "zmedia.txt");
      writeFileSync(join(extension, "zmedia.txt"), "synthetic change behind the flag");
      expect(() => assertExtensionSources(extension, ["zmedia.txt"])).to.throw(/differs from HEAD/).with.property("code", "BAD_PROVENANCE");
      git("update-index", `--no-${flag}`, "zmedia.txt");
      git("checkout", "--", "zmedia.txt");
    }
    const ran = join(dir, "zfsmonitor-ran");
    writeFileSync(join(dir, "zfsmonitor.sh"), `#!/bin/sh\ntouch '${ran}'\nexit 1\n`, {mode: 0o755});
    git("config", "core.fsmonitor", join(dir, "zfsmonitor.sh"));
    expect(() => assertExtensionSources(extension, ["package.json", "zmedia.txt"])).not.to.throw();
    expect(existsSync(ran), "the repository's fsmonitor program ran").to.equal(false);
  });

  it("checks every byte of an extension with a root provenance sidecar", () => {
    const extension = join(dir, "stamped-extension");
    mkdirSync(extension);
    writeFileSync(join(extension, "package.json"), "{}");
    writeArtefactProvenance(extension, {generation: "synthetic", systemDigest: null, systemPrivate: false, inputs: []});
    expect(() => assertExtensionSources(extension, ["package.json"])).not.to.throw();
    writeFileSync(join(extension, "extra.txt"), "unrecorded");
    expect(() => assertExtensionSources(extension, ["package.json"])).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  // FIX8 S5: a marker above the tree marks it too; a stray file is no build output
  it("refuses a CI transpiler under a private marker or with untracked files", () => {
    const root = join(dir, "ci-transpiler-above");
    syntheticCiTranspiler(root);
    const stray = join(root, ".local/ci-artifact/transpiler/zstray.txt");
    writeFileSync(stray, "untracked");
    expect(() => prepareCiTranspiler(root)).to.throw(/untracked/).with.property("code", "CI_TRANSPILER");
    rmSync(stray);
    expect(() => prepareCiTranspiler(root)).not.to.throw();
    writeFileSync(join(root, ".local/.osd-source.json"), JSON.stringify({private: true}));
    expect(() => verifyCiTranspiler(root)).to.throw(/private or unknown/).with.property("code", "CI_TRANSPILER");
    expect(() => prepareCiTranspiler(root)).to.throw(/private or unknown/).with.property("code", "CI_TRANSPILER");
  });

  it("binds CI transpiler files to its pinned commit and refuses additions or source markers", () => {
    const root = join(dir, "ci-transpiler-record");
    syntheticCiTranspiler(root);
    expect(() => verifyCiTranspiler(root)).not.to.throw();
    writeFileSync(join(root, ".local/ci-artifact/transpiler/unlisted.txt"), "extra");
    expect(() => verifyCiTranspiler(root)).to.throw().with.property("code", "CI_TRANSPILER");
    unlinkSync(join(root, ".local/ci-artifact/transpiler/unlisted.txt"));
    writeFileSync(join(root, ".local/ci-artifact/transpiler/.osd-source.json"), JSON.stringify({private: true}));
    expect(() => verifyCiTranspiler(root)).to.throw().with.property("code", "CI_TRANSPILER");
  });

  it("refuses a prebuilt VSIX web bundle whose bytes lack verified public provenance", () => {
    const extension = join(dir, "vsix-web-bundle");
    mkdirSync(join(extension, "dist/web"), {recursive: true});
    writeFileSync(join(extension, "dist/web/extension.js"), "synthetic bundle");
    expect(() => verifiedWebBundle(extension)).to.throw().with.property("code", "BAD_PROVENANCE");
    writeArtefactProvenance(join(extension, "dist/web"), {generation: "synthetic", systemDigest: null, systemPrivate: false, inputs: []});
    expect(() => verifiedWebBundle(extension)).not.to.throw();
    writeFileSync(join(extension, "dist/web/extension.js"), "changed synthetic bundle");
    expect(() => verifiedWebBundle(extension)).to.throw().with.property("code", "BAD_PROVENANCE");
    writeFileSync(join(extension, "dist/web/.osd-source.json"), JSON.stringify({private: true}));
    writeArtefactProvenance(join(extension, "dist/web"), {generation: "synthetic", systemDigest: null, systemPrivate: false, inputs: []});
    expect(() => verifiedWebBundle(extension)).to.throw().with.property("code", "BAD_PROVENANCE");
  });

  // FIX5: the shared caches travel when the public live generation reaches
  // them -- the swap job's fast path reads exactly these -- and nothing else
  it("archives only the public live CI generation and the shared cache entries it reaches", async () => {
    const root = join(dir, "ci-tree");
    for (const path of ["build/tmp", "build/source-by-digest", "build/xref", "gen", "packs", ".local/lars", ".local/ci-artifact/transpiler"])
      mkdirSync(join(root, path), {recursive: true});
    syntheticCiTranspiler(root);
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: [], libs: []}));
    const {genHash} = await import("../tools/osd-build.mjs");
    const {cacheKey} = await import("../tools/osd-xref-seed.mjs");
    const {verifyCiClosure} = await import("../tools/osd-ci-closure.mjs");
    const currentHash = hashOf(root, inputsOf(root));
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    const publicSource = "REPORT zpublic.\n", privateSource = "REPORT zsecret.\n";
    const generation = (hash, record, inputs) => {
      mkdirSync(join(root, "build/by-input", hash, "output"), {recursive: true});
      writeFileSync(join(root, "build/by-input", hash, "manifest.json"), JSON.stringify({hash, ...record}));
      syntheticReads(root, hash);
      writeFileSync(join(root, "build/by-input", hash, "source-inputs.json"), JSON.stringify(inputs));
    };
    generation(currentHash, {systemDigest: null, systemPrivate: false, provenance: [], gen: genHash(root)}, {"src/zpublic.prog.abap": sha(publicSource)});
    // an older generation from a private system: its sources share the store
    generation("fedcba9876543210", {systemDigest: `sha256:${"a".repeat(64)}`, systemPrivate: true, provenance: []}, {"src/zsecret.prog.abap": sha(privateSource)});
    writeFileSync(join(root, "build/by-input", currentHash, "output/init.mjs"), "public");
    writeFileSync(join(root, "build/source-by-digest", sha(publicSource)), publicSource);
    writeFileSync(join(root, "build/source-by-digest", sha(privateSource)), privateSource);
    const key = await cacheKey(root, {hash: currentHash});
    expect(key).to.match(/^[0-9a-f]{16}$/);
    writeFileSync(join(root, "build/xref", `${key}.json`), JSON.stringify({CROSS: [], WBCROSSGT: [], WBCROSSGTX: [], D010INC: []}));
    writeFileSync(join(root, "build/xref/0000000000000000.json"), JSON.stringify({CROSS: [{NAME: "ZSECRET"}]}));
    writeFileSync(join(root, "build/tmp/private.bin"), "private");
    writeFileSync(join(root, "build/source-by-digest/private.bin"), "private");
    symlinkSync(`by-input/${currentHash}`, join(root, "build/live"));
    symlinkSync("build/live/output", join(root, "output"));
    const archive = join(dir, "ci-tree.tar");
    execFileSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root});
    const members = execFileSync("tar", ["-tf", archive], {encoding: "utf8"}).split("\n");
    expect(members).to.include(`build/by-input/${currentHash}/output/init.mjs`);
    expect(members).to.include.members([`build/source-by-digest/${sha(publicSource)}`, `build/xref/${key}.json`, ".local/ci-artifact/closure.json"]);
    for (const left of ["private.bin", sha(privateSource), "0000000000000000", "fedcba9876543210"])
      expect(members.filter(member => member.includes(left)), left).to.deep.equal([]);
    expect(verifyPublicArtefact(archive).generation).to.equal(currentHash);
    const consumer = join(dir, "ci-consumer");
    mkdirSync(consumer);
    execFileSync("tar", ["-xf", archive, "-C", consumer]);
    expect(readFileSync(join(consumer, "output/init.mjs"), "utf8")).to.equal("public");
    expect(readFileSync(join(consumer, "build/live/manifest.json"), "utf8")).to.include(currentHash);
    // listed with digests, and checked where it is unpacked
    const closure = verifyCiClosure(consumer, currentHash);
    expect(closure.files).to.deep.equal({[`build/source-by-digest/${sha(publicSource)}`]: sha(publicSource),
      [`build/xref/${key}.json`]: sha(readFileSync(join(root, "build/xref", `${key}.json`)))});
    // the fast path's inputs: live's sources by digest, live's xref rows by the key osgo-fast asks for
    for (const digest of Object.values(JSON.parse(readFileSync(join(consumer, "build/live/source-inputs.json"), "utf8"))))
      expect(readFileSync(join(consumer, "build/source-by-digest", digest), "utf8")).to.equal(publicSource);
    expect(readFileSync(join(consumer, "build/xref", `${await cacheKey(consumer, {hash: currentHash})}.json`), "utf8")).to.include("CROSS");
    writeFileSync(join(consumer, "build/source-by-digest", sha(publicSource)), "changed");
    expect(() => verifyCiClosure(consumer, currentHash)).to.throw(/differs from its listed digest/);
    writeFileSync(join(consumer, "build/source-by-digest", sha(publicSource)), publicSource);
    writeFileSync(join(consumer, "build/xref/0000000000000000.json"), "{}");
    expect(() => verifyCiClosure(consumer, currentHash)).to.throw(/not in the public closure/);
  });

  // the fast path's inputs are never silently lost: live's xref rows are
  // derived when absent and then required (exit 3), so is every live source
  // in the store or in live's snapshot, and a store reached through a link
  // out of the tree is refused
  it("packs live's fast-path inputs or fails with a distinct exit", async function () {
    // Spawns osd-ci-artifact pack several times: past mocha's 2 s default.
    this.timeout(60000);
    const {genHash} = await import("../tools/osd-build.mjs");
    const {cacheKey} = await import("../tools/osd-xref-seed.mjs");
    const {verifyCiClosure} = await import("../tools/osd-ci-closure.mjs");
    const sha = (text) => createHash("sha256").update(text).digest("hex");
    const source = "REPORT zfast.\n";
    const tree = (name, {config = true} = {}) => {
      const root = join(dir, name);
      for (const path of ["build/source-by-digest", "gen", "packs", ".local/lars", ".local/ci-artifact/transpiler"]) mkdirSync(join(root, path), {recursive: true});
      syntheticCiTranspiler(root);
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: [], libs: []}));
      if (config) writeFileSync(join(root, "abaplint.jsonc"), readFileSync(resolve("abaplint.jsonc")));
      const hash = hashOf(root, inputsOf(root));
      mkdirSync(join(root, "build/by-input", hash, "output"), {recursive: true});
      writeFileSync(join(root, "build/by-input", hash, "manifest.json"), JSON.stringify({hash, systemDigest: null, systemPrivate: false, provenance: [], gen: genHash(root)}));
      syntheticReads(root, hash);
      writeFileSync(join(root, "build/by-input", hash, "source-inputs.json"), JSON.stringify({"src/zfast.prog.abap": sha(source)}));
      writeFileSync(join(root, "build/source-by-digest", sha(source)), source);
      symlinkSync(`by-input/${hash}`, join(root, "build/live"));
      symlinkSync("build/live/output", join(root, "output"));
      return {root, hash};
    };
    const pack = (root, archive = join(dir, `${root.split("/").at(-1)}.tar`)) =>
      ({...spawnSync(process.execPath, [resolve("tools/osd-ci-artifact.mjs"), "pack", archive], {cwd: root, encoding: "utf8"}), archive});
    // no host wrote live's rows: pack derives and carries them
    const derived = tree("fast-derived");
    const made = pack(derived.root);
    expect(made.status, made.stderr).to.equal(0);
    const key = await cacheKey(derived.root, {hash: derived.hash});
    expect(execFileSync("tar", ["-tf", made.archive], {encoding: "utf8"})).to.include(`build/xref/${key}.json`);
    rmSync(join(derived.root, "output"));
    mkdirSync(join(derived.root, "output"));
    writeFileSync(join(derived.root, "output/old-private.mjs"), "synthetic private marker");
    expect(pack(derived.root).status).not.to.equal(0);
    rmSync(join(derived.root, "output"), {recursive: true});
    symlinkSync("build/live/output", join(derived.root, "output"));
    const record = join(derived.root, "build/live/source-inputs.json");
    const saved = readFileSync(record);
    rmSync(record);
    expect(pack(derived.root).status).to.equal(3);
    writeFileSync(record, "{");
    expect(pack(derived.root).status).to.equal(3);
    writeFileSync(record, saved);
    // they cannot be derived: exit 3, nothing stamped
    const underived = tree("fast-underived", {config: false});
    const refused = pack(underived.root);
    expect(refused.status, refused.stderr).to.equal(3);
    expect(refused.stderr).to.match(/cross-reference rows .* are missing/);
    expect(existsSync(`${refused.archive}.osd-provenance.json`)).to.equal(false);
    // a live source in neither the store nor live's snapshot: exit 3; in the snapshot only: carried with live
    const lost = tree("fast-lost");
    rmSync(join(lost.root, "build/source-by-digest", sha(source)));
    const lostPack = pack(lost.root);
    expect(lostPack.status, lostPack.stderr).to.equal(3);
    expect(lostPack.stderr).to.match(/src\/zfast\.prog\.abap .* is in neither build\/source-by-digest nor live's snapshot/);
    mkdirSync(join(lost.root, "build/live/source/src"), {recursive: true});
    writeFileSync(join(lost.root, "build/live/source/src/zfast.prog.abap"), source);
    expect(pack(lost.root).status).to.equal(0);
    writeFileSync(join(lost.root, "build/live/source/src/zfast.prog.abap"), "wrong synthetic bytes");
    expect(pack(lost.root).status).to.equal(3);
    // a shared store linked out of the tree
    const linked = tree("fast-linked");
    const outside = join(dir, "fast-outside-store");
    renameSync(join(linked.root, "build/source-by-digest"), outside);
    symlinkSync(outside, join(linked.root, "build/source-by-digest"));
    const linkedPack = pack(linked.root);
    expect(linkedPack.status, linkedPack.stderr).not.to.equal(0);
    expect(linkedPack.stderr).to.include("build/source-by-digest leaves the tree");
    const consumer = join(dir, "fast-consumer");
    mkdirSync(consumer);
    execFileSync("tar", ["-xf", made.archive, "-C", consumer]);
    expect(verifyCiClosure(consumer, derived.hash).files).to.have.property(`build/xref/${key}.json`);
    renameSync(join(consumer, "build/source-by-digest"), join(dir, "fast-consumer-store"));
    symlinkSync(join(dir, "fast-consumer-store"), join(consumer, "build/source-by-digest"));
    expect(() => verifyCiClosure(consumer, derived.hash)).to.throw(/build\/source-by-digest leaves the tree/);
  });

  it("refuses a binary for another target, a script, and a sidecar that is not its digest", () => {
    expect(() => checkBinary(write("a", elf(0x3e)), "bun-linux-arm64")).to.throw(/not the elf machine 0xb7/);
    expect(() => checkBinary(write("b", Buffer.from("#!/bin/sh\n")), "bun-linux-x64-baseline")).to.throw(/is unknown/);
    expect(() => checkBinary(write("c", elf(0x3e), "0".repeat(64)), "bun-linux-x64-baseline")).to.throw(/\.sha256 says/);
    expect(() => checkBinary(write("d", elf(0x3e)), "bun-freebsd")).to.throw(/unknown release target/);
  });
});
