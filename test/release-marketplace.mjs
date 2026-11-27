// scripts/publish-marketplace.mjs: which packages go to the Marketplace, in
// which order, with which flags, and what a rerun on the same tag does. No
// network and no vsce: the archive and the process runner are injected.
import {expect} from "chai";
import {
  checkNewVersion, collectPackages, EXTENSION_ID, main, MarketplaceError, pinnedTargets, planPublish,
  PRERELEASE_PROPERTY, publishAll, publishArgs, readPackage,
} from "../scripts/publish-marketplace.mjs";

const TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
const VERSION = "0.7.3200";
const DIR = "/rel";

function manifest({version = VERSION, target, prerelease}) {
  return `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011">
  <Metadata>
    <Identity Language="en-US" Id="open-steamgate" Version="${version}" Publisher="oisee"${target ? ` TargetPlatform="${target}"` : ""} />
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="^1.101.0" />
${prerelease ? `      <Property Id="${PRERELEASE_PROPERTY}" Value="true" />\n` : ""}    </Properties>
  </Metadata>
</PackageManifest>`;
}

/** A fake archive over a map path -> {target, prerelease, version}. */
function fakeRelease({prerelease = true, override = {}} = {}) {
  const files = new Map();
  const add = (path, target) => files.set(path, {target, prerelease, version: VERSION, ...(override[target ?? "universal"] ?? {})});
  for (const t of TARGETS) add(`${DIR}/platforms/open-steamgate-${t}-${VERSION}.vsix`, t);
  add(`${DIR}/open-steamgate-${VERSION}.vsix`, undefined);
  const archive = {
    read(path, entry) {
      const f = files.get(path);
      if (entry === "extension/package.json") return Buffer.from(JSON.stringify({name: "open-steamgate", publisher: "oisee", version: f.version}));
      if (entry === "extension.vsixmanifest") return Buffer.from(manifest(f));
      throw new Error(`no ${entry}`);
    },
  };
  return {files, archive, exists: (p) => files.has(p)};
}

/** A fake spawnSync: records calls, answers `show` with `versions`, fails a publish when told. */
function fakeRun({versions = [], failOn} = {}) {
  const calls = [];
  const envs = [];
  const run = (cmd, args, opts = {}) => {
    calls.push([cmd, ...args]);
    envs.push({args, env: opts.env});
    if (args.includes("show")) return {status: 0, stdout: JSON.stringify({versions}), stderr: ""};
    if (args.includes("publish")) {
      const path = args[args.indexOf("--packagePath") + 1];
      return {status: failOn !== undefined && path.includes(failOn) ? 1 : 0};
    }
    return {status: 2};
  };
  return {run, calls, envs, publishes: () => calls.filter((c) => c.includes("publish")).map((c) => c.at(-1))};
}

const prereleaseProps = [{key: PRERELEASE_PROPERTY, value: "true"}];

describe("Marketplace publish of the platform packages and the universal one", () => {
  it("covers the sidecar pin's five targets", () => {
    expect(pinnedTargets()).to.have.members(TARGETS).and.have.length(5);
  });

  it("reads target, version and pre-release off each package", () => {
    const {archive} = fakeRelease();
    expect(readPackage(`${DIR}/platforms/open-steamgate-win32-x64-${VERSION}.vsix`, {archive}))
      .to.include({target: "win32-x64", version: VERSION, manifestVersion: VERSION, prerelease: true, name: "open-steamgate"});
    expect(readPackage(`${DIR}/open-steamgate-${VERSION}.vsix`, {archive}).target).to.equal(undefined);
  });

  it("collects the five platform packages first and the universal one last", () => {
    const {archive, exists} = fakeRelease();
    const packages = collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, archive, exists});
    expect(packages.map((p) => p.target)).to.deep.equal([...TARGETS, undefined]);
  });

  it("refuses a release whose packages disagree: missing target, wrong TargetPlatform, version, channel", () => {
    const missing = fakeRelease();
    missing.files.delete(`${DIR}/platforms/open-steamgate-darwin-x64-${VERSION}.vsix`);
    expect(() => collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, ...missing}))
      .to.throw(MarketplaceError, /missing .*open-steamgate-darwin-x64-/);
    const wrong = fakeRelease({override: {"linux-arm64": {target: "linux-x64"}, "darwin-arm64": {version: "0.7.1"}}});
    expect(() => collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, ...wrong}))
      .to.throw(MarketplaceError, /linux-arm64-.*TargetPlatform is linux-x64[\s\S]*darwin-arm64-.*version 0\.7\.1/);
    const stableBuilt = fakeRelease({prerelease: false});
    expect(() => collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, ...stableBuilt}))
      .to.throw(MarketplaceError, /lacks the Microsoft\.VisualStudio\.Code\.PreRelease property on the prerelease channel/);
    const prereleaseBuilt = fakeRelease({override: {universal: {prerelease: true}}, prerelease: false});
    expect(() => collectPackages({dir: DIR, version: VERSION, channel: "stable", targets: TARGETS, ...prereleaseBuilt}))
      .to.throw(MarketplaceError, /open-steamgate-0\.7\.3200\.vsix: carries/);
  });

  it("passes --pre-release to every package exactly on the prerelease channel", () => {
    const pkg = {path: "/p.vsix", target: "linux-x64"};
    expect(publishArgs(pkg, "prerelease")).to.include("--pre-release");
    expect(publishArgs(pkg, "stable")).to.not.include("--pre-release");
    expect(publishArgs(pkg, "stable").slice(-2)).to.deep.equal(["--packagePath", "/p.vsix"]);
    expect(publishArgs(pkg, "stable")).to.not.include("--skip-duplicate");
  });

  it("a first run publishes all six, platforms first, universal last", () => {
    const {archive, exists} = fakeRelease();
    const packages = collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, archive, exists});
    const fake = fakeRun();
    const result = publishAll({packages, channel: "prerelease", existingVersions: [], run: fake.run, log: () => {}});
    expect(result.published).to.deep.equal([...TARGETS, "universal"]);
    expect(fake.publishes().at(-1)).to.equal(`${DIR}/open-steamgate-${VERSION}.vsix`);
    expect(fake.calls.every((c) => c.includes("--pre-release"))).to.equal(true);
  });

  it("a failed platform publish stops the run before the universal package, loudly", () => {
    const {archive, exists} = fakeRelease();
    const packages = collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, archive, exists});
    const fake = fakeRun({failOn: "darwin-x64"});
    expect(() => publishAll({packages, channel: "prerelease", existingVersions: [], run: fake.run, log: () => {}}))
      .to.throw(MarketplaceError, /darwin-x64.*failed.*universal one included, were not published/);
    expect(fake.publishes().map((p) => p.split("/").at(-1))).to.deep.equal([
      `open-steamgate-linux-x64-${VERSION}.vsix`, `open-steamgate-linux-arm64-${VERSION}.vsix`, `open-steamgate-darwin-x64-${VERSION}.vsix`,
    ]);
  });

  it("a rerun skips each (version, target) already there and publishes only the rest", () => {
    const {archive, exists} = fakeRelease();
    const packages = collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, archive, exists});
    const existing = [
      {version: VERSION, targetPlatform: "linux-x64", properties: prereleaseProps},
      {version: VERSION, targetPlatform: "linux-arm64", properties: prereleaseProps},
      // an older version's universal entry does not count for this one
      {version: "0.7.3100", properties: prereleaseProps},
    ];
    const {publish, skip} = planPublish(packages, existing, "prerelease");
    expect(skip.map((p) => p.target)).to.deep.equal(["linux-x64", "linux-arm64"]);
    expect(publish.map((p) => p.target ?? "universal")).to.deep.equal(["darwin-x64", "darwin-arm64", "win32-x64", "universal"]);
    const lines = [];
    const fake = fakeRun();
    publishAll({packages, channel: "prerelease", existingVersions: existing, run: fake.run, log: (l) => lines.push(l)});
    expect(fake.publishes()).to.have.length(4);
    expect(lines.filter((l) => l.startsWith("::notice::"))).to.have.length(2);
    // a complete version: everything skipped, nothing published, green
    const all = packages.map((p) => ({version: VERSION, targetPlatform: p.target, properties: prereleaseProps}));
    const again = fakeRun();
    expect(publishAll({packages, channel: "prerelease", existingVersions: all, run: again.run, log: () => {}}).published).to.deep.equal([]);
    expect(again.publishes()).to.deep.equal([]);
  });

  it("the stable early check refuses a pre-release or complete version, and lets an interrupted one resume", () => {
    expect(checkNewVersion([], VERSION)).to.equal(null);
    expect(checkNewVersion([{version: "0.7.1", properties: []}], VERSION)).to.equal(null);
    expect(checkNewVersion([{version: VERSION, targetPlatform: "win32-x64", properties: prereleaseProps}], VERSION))
      .to.match(/already exists as a pre-release/);
    expect(checkNewVersion([{version: VERSION, properties: []}], VERSION)).to.match(/universal package included/);
    expect(checkNewVersion([{version: VERSION, targetPlatform: "linux-x64"}], VERSION)).to.match(/unreadable properties/);
    expect(checkNewVersion([{version: VERSION, targetPlatform: "linux-x64", properties: []}], VERSION)).to.equal(null);
  });

  it("the CLI: check-new is exit 1 with an ::error:: on a refusal; publish checks the tag against the channel", () => {
    const lines = [];
    const refused = fakeRun({versions: [{version: VERSION, properties: prereleaseProps}]});
    expect(main(["check-new", VERSION, "--channel", "stable"], {run: refused.run, log: (l) => lines.push(l), targets: TARGETS})).to.equal(1);
    expect(lines.join("\n")).to.match(/::error::Marketplace version 0\.7\.3200 already exists/);
    expect(refused.calls[0]).to.include.members(["show", EXTENSION_ID, "--json"]);
    expect(main(["check-new", VERSION, "--channel", "stable"], {run: fakeRun().run, log: () => {}, targets: TARGETS})).to.equal(0);
    const {archive} = fakeRelease();
    expect(main(["publish", `vscode-stable-v${VERSION}`, "--channel", "prerelease", "--dir", DIR], {run: fakeRun().run, log: () => {}, archive, targets: TARGETS}))
      .to.equal(1);
    const happy = fakeRelease();
    const ok = fakeRun();
    expect(main(["publish", `vscode-v${VERSION}`, "--channel", "prerelease", "--dir", DIR], {run: ok.run, log: () => {}, ...happy, targets: TARGETS}))
      .to.equal(0);
    expect(ok.publishes()).to.have.length(6);
    expect(main(["publish", "v1", "--channel", "prerelease", "--dir", DIR], {run: fakeRun().run, log: () => {}, archive, targets: TARGETS})).to.equal(1);
  });

  it("skips an existing entry only on the same channel; the other channel is a loud failure", () => {
    const pre = fakeRelease();
    const prePackages = collectPackages({dir: DIR, version: VERSION, channel: "prerelease", targets: TARGETS, ...pre});
    // a stable entry of this version+target, met by a prerelease run
    const stableThere = [{version: VERSION, targetPlatform: "darwin-x64", properties: []}];
    expect(() => planPublish(prePackages, stableThere, "prerelease"))
      .to.throw(MarketplaceError, /darwin-x64 v0\.7\.3200 is on the Marketplace as stable, this run is prerelease/);
    const fake = fakeRun();
    expect(() => publishAll({packages: prePackages, channel: "prerelease", existingVersions: stableThere, run: fake.run, log: () => {}}))
      .to.throw(MarketplaceError);
    expect(fake.publishes()).to.deep.equal([]);
    // a prerelease entry met by a stable run
    const st = fakeRelease({prerelease: false});
    const stPackages = collectPackages({dir: DIR, version: VERSION, channel: "stable", targets: TARGETS, ...st});
    const preThere = [{version: VERSION, targetPlatform: "linux-x64", properties: prereleaseProps}];
    expect(() => planPublish(stPackages, preThere, "stable"))
      .to.throw(MarketplaceError, /linux-x64 v0\.7\.3200 is on the Marketplace as prerelease, this run is stable/);
    // same channel: skipped; unreadable properties: refused
    expect(planPublish(stPackages, [{version: VERSION, targetPlatform: "linux-x64", properties: []}], "stable").skip.map((p) => p.target))
      .to.deep.equal(["linux-x64"]);
    expect(() => planPublish(stPackages, [{version: VERSION, targetPlatform: "linux-x64"}], "stable"))
      .to.throw(MarketplaceError, /unreadable properties/);
  });

  it("a stable publish re-runs the version-is-new check on the entries it is about to publish against", () => {
    const st = fakeRelease({prerelease: false});
    const lines = [];
    // a prerelease universal of the version appeared after the early check
    const fake = fakeRun({versions: [{version: VERSION, properties: prereleaseProps}]});
    expect(main(["publish", `vscode-stable-v${VERSION}`, "--channel", "stable", "--dir", DIR],
      {run: fake.run, log: (l) => lines.push(l), ...st, targets: TARGETS})).to.equal(1);
    expect(lines.join("\n")).to.match(/already exists as a pre-release/);
    expect(fake.publishes()).to.deep.equal([]);
    // interrupted stable publish: platform entries only, resumes
    const resume = fakeRun({versions: [{version: VERSION, targetPlatform: "linux-x64", properties: []}]});
    expect(main(["publish", `vscode-stable-v${VERSION}`, "--channel", "stable", "--dir", DIR],
      {run: resume.run, log: () => {}, ...st, targets: TARGETS})).to.equal(0);
    expect(resume.publishes()).to.have.length(5);
  });

  it("hands VSCE_PAT to vsce publish only, never to vsce show", () => {
    const pre = fakeRelease();
    const fake = fakeRun();
    const env = {PATH: "/bin", VSCE_PAT: "secret-pat"};
    expect(main(["publish", `vscode-v${VERSION}`, "--channel", "prerelease", "--dir", DIR],
      {run: fake.run, log: () => {}, ...pre, targets: TARGETS, env})).to.equal(0);
    const show = fake.envs.filter((e) => e.args.includes("show"));
    const publish = fake.envs.filter((e) => e.args.includes("publish"));
    expect(show).to.have.length(1);
    expect(show[0].env).to.be.an("object").that.does.not.have.property("VSCE_PAT");
    expect(show[0].env.PATH).to.equal("/bin");
    expect(publish).to.have.length(6);
    for (const p of publish) expect(p.env.VSCE_PAT).to.equal("secret-pat");
    const checkNew = fakeRun();
    main(["check-new", VERSION, "--channel", "stable"], {run: checkNew.run, log: () => {}, targets: TARGETS, env});
    expect(checkNew.envs[0].env).to.not.have.property("VSCE_PAT");
  });
});
