// The five platform packages (scripts/package-vsix-platforms.mjs), against a
// small universal package built here and a FAKE fetcher: each package holds
// exactly its own target's binary, verified against the (injected) pin; the
// universal one holds none. Needs the zip/unzip CLIs build-vsix uses too.
// No network.
//
// Mutations, each confirmed RED (see REPORT.md of the job):
//   P1 "bin" dropped from UNSTAGED_EXTENSION_ENTRIES (universal ships bin/)
//   P2 the re-hash of the bytes about to be packed skipped
//   P3 every fetched binary packed into every package (inspection catches it)
//   P4 P3 with the read-back inspection disabled (this file's listing catches it)
//   P5 TargetPlatform not written into the manifest
//   P6 the extensionless binary left untyped in [Content_Types].xml
//   P7 assertUniversal a no-op
//   P8 the 0755 mode not set on the staged binary
import {expect} from "chai";
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {contentTypesXml, extensionStaticParts, vsixManifestXml} from "../scripts/build-vsix.mjs";
import {
  assertUniversal, defaultArchive, inspectPlatformVsix, main, packagePlatforms, packageTarget,
  platformVsixName, PlatformPackageError, sidecarEntry, targetContentTypes, targetManifest,
} from "../scripts/package-vsix-platforms.mjs";
import {outputName} from "../tools/osd-hana/fetch-sidecar.mjs";
import {verifyPublicArtefact, writeArtefactProvenance} from "../tools/osd-provenance.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
const fakeBytes = (target) => Buffer.from(`fake osd-hana-dump for ${target}\n`);
const PIN = {
  name: "osd-hana-dump", version: "v0.0.0-test", commit: "0".repeat(40), schema: 1, read_only: true,
  targets: Object.fromEntries(TARGETS.map((t) => [t, sha256(fakeBytes(t))])),
};

const hasZip = (() => {
  try { execFileSync("zip", ["-v"], {stdio: "ignore"}); execFileSync("unzip", ["-v"], {stdio: "ignore"}); return true; } catch { return false; }
})();

/** fetch-sidecar's contract, faked: place <outDir>/<target>/<name>, return its path. */
function fakeFetcher({bytesFor = fakeBytes, calls = []} = {}) {
  return async ({target, outDir, offline}) => {
    calls.push({target, outDir, offline});
    const path = join(outDir, target, outputName(target));
    mkdirSync(join(outDir, target), {recursive: true});
    writeFileSync(path, bytesFor(target), {mode: 0o755});
    return {path, sha256: sha256(bytesFor(target)), cached: false};
  };
}

function makeUniversal(dir, {extra = []} = {}) {
  const stage = join(dir, "universal-stage");
  const pkg = {name: "open-steamgate", version: "0.7.1234", publisher: "oisee", icon: "resources/icon.png", engines: {vscode: "^1.101.0"}};
  mkdirSync(join(stage, "extension", "resources"), {recursive: true});
  writeFileSync(join(stage, "extension", "package.json"), JSON.stringify(pkg));
  writeFileSync(join(stage, "extension", "hana-sidecar.js"), "// bundled lookup\n");
  writeFileSync(join(stage, "extension", "resources", "icon.png"), "png");
  for (const [rel, text] of extra) {
    mkdirSync(join(stage, rel, ".."), {recursive: true});
    writeFileSync(join(stage, rel), text);
  }
  writeFileSync(join(stage, "extension.vsixmanifest"), vsixManifestXml(pkg));
  writeFileSync(join(stage, "[Content_Types].xml"), contentTypesXml(["json", "js", "png"]));
  const out = join(dir, "open-steamgate-0.7.1234.vsix");
  execFileSync("zip", ["-X", "-q", "-r", out, "[Content_Types].xml", "extension.vsixmanifest", "extension"], {cwd: stage});
  return out;
}

describe("vsix platform packages: one verified sidecar each", function () {
  this.timeout(30_000);
  let dir;
  beforeEach(function () {
    if (!hasZip) this.skip();
    dir = mkdtempSync(join(tmpdir(), "osd-vsix-platforms-"));
  });
  afterEach(() => { if (dir) rmSync(dir, {recursive: true, force: true}); });

  it("the universal package never stages editors/vscode/bin/", () => {
    expect(extensionStaticParts(["extension.js", "bin", "osd", "dist", ".osd-provenance.json", "package.json"]))
      .to.deep.equal(["extension.js", "package.json"]);
  });

  it("builds five packages, each with exactly its own target's binary; the universal one stays without", async () => {
    const universal = makeUniversal(dir);
    const before = readFileSync(universal);
    const calls = [];
    const sidecarRoot = join(dir, "editors-vscode-bin");
    const results = await packagePlatforms({
      universal, outDir: join(dir, "out"), pin: PIN, sidecarRoot, fetchFn: fakeFetcher({calls}), provenance: false,
    });
    expect(results.map((r) => r.target)).to.deep.equal(TARGETS);
    expect(calls.map((c) => c.target)).to.deep.equal(TARGETS);
    expect(calls.every((c) => c.outDir === sidecarRoot)).to.equal(true);
    for (const {target, out} of results) {
      expect(out).to.equal(join(dir, "out", platformVsixName("open-steamgate", target, "0.7.1234")));
      const entries = defaultArchive.list(out);
      const bins = entries.filter((e) => e.startsWith("extension/bin/") && !e.endsWith("/"));
      expect(bins, target).to.deep.equal([sidecarEntry(target)]);
      expect(defaultArchive.read(out, sidecarEntry(target)).equals(fakeBytes(target))).to.equal(true);
      const manifest = defaultArchive.read(out, "extension.vsixmanifest").toString("utf8");
      expect(manifest).to.match(new RegExp(`<Identity [^>]*TargetPlatform="${target}" />`));
      const types = defaultArchive.read(out, "[Content_Types].xml").toString("utf8");
      if (target === "win32-x64") {
        expect(types).to.contain('<Default Extension="exe" ContentType="application/octet-stream"/>');
      } else {
        expect(types).to.contain(`<Override PartName="/extension/bin/${target}/osd-hana-dump" ContentType="application/octet-stream"/>`);
        expect(defaultArchive.mode(out, sidecarEntry(target))).to.match(/^-rwxr-xr-x$/);
      }
      // the rest of the universal package is still there
      expect(entries).to.include.members(["extension/package.json", "extension/hana-sidecar.js", "extension/resources/icon.png"]);
      expect(inspectPlatformVsix(out, target, {pin: PIN}).problems).to.deep.equal([]);
    }
    // the input is untouched and still carries no binary
    expect(readFileSync(universal).equals(before)).to.equal(true);
    expect(defaultArchive.list(universal).filter((e) => e.startsWith("extension/bin/"))).to.deep.equal([]);
  });

  it("refuses bytes whose hash is not the pin's, and writes no package", async () => {
    const universal = makeUniversal(dir);
    let error;
    try {
      await packageTarget({
        target: "linux-x64", universal, outDir: join(dir, "out"), pin: PIN, sidecarRoot: join(dir, "bin"), provenance: false,
        // a fetcher that lies: it returns, but the bytes on disk are wrong
        fetchFn: fakeFetcher({bytesFor: () => Buffer.from("tampered")}),
      });
    } catch (e) { error = e; }
    expect(error).to.be.instanceOf(PlatformPackageError);
    expect(error.message).to.contain("SHA-256 mismatch");
    expect(error.message).to.contain(PIN.targets["linux-x64"]);
    expect(existsSync(join(dir, "out", platformVsixName("open-steamgate", "linux-x64", "0.7.1234")))).to.equal(false);
  });

  it("refuses a target the pin does not cover, before fetching anything", async () => {
    const calls = [];
    const universal = makeUniversal(dir);
    let error;
    try {
      await packageTarget({target: "win32-arm64", universal, outDir: join(dir, "out"), pin: PIN, sidecarRoot: join(dir, "bin"),
        fetchFn: fakeFetcher({calls}), provenance: false});
    } catch (e) { error = e; }
    expect(error).to.be.instanceOf(PlatformPackageError);
    expect(error.message).to.contain('no target "win32-arm64"');
    expect(calls).to.deep.equal([]);
  });

  it("refuses a universal package that already carries a bin/ entry or a TargetPlatform", () => {
    const stray = makeUniversal(dir, {extra: [["extension/bin/linux-x64/osd-hana-dump", "x"]]});
    expect(() => assertUniversal(stray)).to.throw(PlatformPackageError, "already carries extension/bin/linux-x64/osd-hana-dump");
    expect(() => targetManifest(targetManifest(vsixManifestXml({name: "n", version: "1"}), "linux-x64"), "darwin-x64"))
      .to.throw(PlatformPackageError, "already names a TargetPlatform");
  });

  it("types the binary once, whatever the input", () => {
    const xml = contentTypesXml(["json"]);
    const once = targetContentTypes(xml, "linux-arm64");
    expect(targetContentTypes(once, "linux-arm64")).to.equal(once);
    const withExe = contentTypesXml(["exe"]);
    expect(targetContentTypes(withExe, "win32-x64")).to.equal(withExe);
  });

  it("derives provenance from the verified universal record, with its own hash and the sidecar named", async () => {
    const universal = makeUniversal(dir);
    writeArtefactProvenance(universal, {generation: "g-test", systemDigest: "d", systemPrivate: false, inputs: []});
    const [result] = await packagePlatforms({
      universal, outDir: join(dir, "out"), pin: PIN, sidecarRoot: join(dir, "bin"), fetchFn: fakeFetcher(), targets: ["darwin-arm64"],
    });
    const record = verifyPublicArtefact(result.out);
    expect(record.generation).to.equal("g-test");
    expect(record.sidecar).to.include({target: "darwin-arm64", version: PIN.version, sha256: PIN.targets["darwin-arm64"]});
    expect(record.derivedFrom.sha256).to.equal(sha256(readFileSync(universal)));
  });

  it("the CLI builds the targets asked for and says so; a bad flag is exit 1", async () => {
    const universal = makeUniversal(dir);
    const lines = [];
    const code = await main(["--vsix", universal, "--out", join(dir, "cli"), "--target", "linux-x64", "--unstamped"], {
      out: (l) => lines.push(l), err: (l) => lines.push(l),
      packaging: {pin: PIN, sidecarRoot: join(dir, "bin"), fetchFn: fakeFetcher()},
    });
    expect(code, lines.join("\n")).to.equal(0);
    expect(lines.at(-1)).to.match(/^open-steamgate-linux-x64-0\.7\.1234\.vsix\t\d+$/);
    expect(await main(["--bogus"], {out: () => {}, err: () => {}})).to.equal(1);
  });
});
