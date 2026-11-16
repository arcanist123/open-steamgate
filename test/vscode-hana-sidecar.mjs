// The extension's lookup of its bundled osd-hana-dump
// (editors/vscode/hana-sidecar.js): one binary per platform package at
// bin/<target>/osd-hana-dump[.exe], found by process.platform/process.arch,
// made executable at first use, and handed to the osd-hana module as its
// `callerPath` (the module verifies it). No network, no database.
//
// Mutations, each confirmed RED (see REPORT.md of the job):
//   H1 win32-arm64 added to SIDECAR_TARGETS (collapsed onto an x64 binary)
//   H2 ensureExecutable a no-op
//   H3 the .exe suffix dropped for win32
//   H4 callerPathFor ignores OSD_HANA_DUMP
//   H5 a universal install answers a path instead of OSD_HANA_NO_SIDECAR
import {expect} from "chai";
import {chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {outputName} from "../tools/osd-hana/fetch-sidecar.mjs";
import {loadPin, locateSidecar, targetKey} from "../tools/osd-hana/sidecar.mjs";

const require = createRequire(import.meta.url);
const sidecar = require("../editors/vscode/hana-sidecar.js");

const FIVE = [
  ["linux", "x64", "linux-x64", "osd-hana-dump"],
  ["linux", "arm64", "linux-arm64", "osd-hana-dump"],
  ["darwin", "x64", "darwin-x64", "osd-hana-dump"],
  ["darwin", "arm64", "darwin-arm64", "osd-hana-dump"],
  ["win32", "x64", "win32-x64", "osd-hana-dump.exe"],
];

describe("vscode: the bundled osd-hana-dump sidecar", () => {
  let ext;
  beforeEach(() => { ext = mkdtempSync(join(tmpdir(), "osd-hana-ext-")); });
  afterEach(() => rmSync(ext, {recursive: true, force: true}));

  const place = (target, mode = 0o755) => {
    const file = sidecar.bundledSidecarPath(ext, target);
    mkdirSync(join(ext, "bin", target), {recursive: true});
    writeFileSync(file, "binary");
    chmodSync(file, mode);
    return file;
  };

  for (const [platform, arch, target, name] of FIVE) {
    it(`finds bin/${target}/${name} on ${platform}/${arch}`, () => {
      const file = place(target);
      const found = sidecar.findBundledSidecar(ext, {platform, arch});
      expect(found).to.deep.equal({target, path: file});
      expect(file).to.equal(join(ext, "bin", target, name));
    });
  }

  it("agrees with the pin and the build: the same five targets, the same file names", () => {
    const pin = loadPin();
    expect([...sidecar.SIDECAR_TARGETS].sort()).to.deep.equal(Object.keys(pin.targets).sort());
    for (const target of sidecar.SIDECAR_TARGETS) expect(sidecar.sidecarFileName(target)).to.equal(outputName(target));
    // and with the module's own naming of this machine
    for (const [platform, arch, target] of FIVE) expect(targetKey(platform, arch)).to.equal(target);
  });

  for (const [platform, arch] of [["win32", "arm64"], ["linux", "ia32"], ["freebsd", "x64"], ["linux", "riscv64"]]) {
    it(`refuses ${platform}-${arch} under its own name, mapped to nothing`, () => {
      // even with every bundled binary present, nothing is picked for it
      for (const [, , target] of FIVE) place(target);
      let error;
      try { sidecar.findBundledSidecar(ext, {platform, arch}); } catch (e) { error = e; }
      expect(error, "refused").to.be.instanceOf(sidecar.HanaSidecarError);
      expect(error.code).to.equal("OSD_HANA_UNSUPPORTED_TARGET");
      expect(error.message).to.contain(`for ${platform}-${arch}`);
      expect(error.message).to.contain("linux-x64, linux-arm64, darwin-x64, darwin-arm64, win32-x64");
      expect(error.message).to.contain("not mapped");
    });
  }

  it("a universal install (no bin/) says how to get a binary and downloads nothing", () => {
    let error;
    try { sidecar.findBundledSidecar(ext, {platform: "linux", arch: "x64"}); } catch (e) { error = e; }
    expect(error).to.be.instanceOf(sidecar.HanaSidecarError);
    expect(error.code).to.equal("OSD_HANA_NO_SIDECAR");
    expect(error.message).to.contain("universal package");
    expect(error.message).to.contain("open-steamgate-linux-x64-<version>.vsix");
    expect(error.message).to.contain("OSD_HANA_DUMP");
    expect(error.message).to.contain("Nothing is downloaded");
  });

  it("a package for another target is not used for this one", () => {
    place("linux-arm64");
    expect(() => sidecar.findBundledSidecar(ext, {platform: "linux", arch: "x64"}))
      .to.throw(sidecar.HanaSidecarError).with.property("code", "OSD_HANA_NO_SIDECAR");
  });

  if (process.platform !== "win32") {
    it("makes a binary that lost its execute bits 0755 at first use, and leaves a good one alone", () => {
      const file = place("linux-x64", 0o644);
      const first = sidecar.resolveBundledSidecar(ext, {platform: "linux", arch: "x64"});
      expect(first.madeExecutable).to.equal(true);
      expect(statSync(file).mode & 0o777).to.equal(0o755);
      const second = sidecar.resolveBundledSidecar(ext, {platform: "linux", arch: "x64"});
      expect(second.madeExecutable).to.equal(false);
      expect(second.path).to.equal(file);
    });
  }

  it("never chmods on Windows", () => {
    const calls = [];
    const changed = sidecar.ensureExecutable("C:\\x\\osd-hana-dump.exe", {
      platform: "win32", stat: () => ({mode: 0o644}), chmod: (...a) => calls.push(a)});
    expect(changed).to.equal(false);
    expect(calls).to.deep.equal([]);
  });

  it("chmods a POSIX binary with any execute bit missing", () => {
    const calls = [];
    sidecar.ensureExecutable("/x/osd-hana-dump", {platform: "darwin", stat: () => ({mode: 0o744}), chmod: (...a) => calls.push(a)});
    expect(calls).to.deep.equal([["/x/osd-hana-dump", 0o755]]);
  });

  it("hands the module its callerPath, and steps aside for OSD_HANA_DUMP", () => {
    const file = place(targetKey() ?? "linux-x64");
    if (targetKey() !== undefined && sidecar.SIDECAR_TARGETS.includes(targetKey())) {
      const callerPath = sidecar.callerPathFor(ext, {env: {}});
      expect(callerPath).to.equal(file);
      // the module's locate step takes it as handed in
      expect(locateSidecar({env: {}, callerPath})).to.equal(file);
    }
    expect(sidecar.callerPathFor(ext, {env: {OSD_HANA_DUMP: "/chosen/osd-hana-dump"}})).to.equal(undefined);
    // and the module then takes the variable over the bundled path
    expect(locateSidecar({env: {OSD_HANA_DUMP: "/chosen/osd-hana-dump"}, callerPath: file, platform: "linux"}))
      .to.equal("/chosen/osd-hana-dump");
  });
});
