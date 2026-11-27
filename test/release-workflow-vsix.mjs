// .github/workflows/release.yml, the VS Code packages: the five platform
// packages reach the GitHub release and the Marketplace only behind the
// sidecar smoke and the gates the universal package goes through, and every
// list of them (README allowlist, upload, publish check) names the same five
// targets as the sidecar pin.
import {expect} from "chai";
import {readFileSync} from "node:fs";
import {load} from "js-yaml";

const workflow = load(readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8"));
const jobs = workflow.jobs;
const pin = JSON.parse(readFileSync(new URL("../tools/osd-hana/sidecar.lock.json", import.meta.url), "utf8"));
const TARGETS = Object.keys(pin.targets);
const runOf = (job) => jobs[job].steps.map((s) => s.run ?? "").join("\n");
const needsOf = (job) => [jobs[job].needs].flat();
const step = (job, name) => jobs[job].steps.find((s) => s.name === name);

describe("release workflow: the platform VS Code packages", () => {
  it("uploads them to the release only after the smoke, and publication waits for that upload", () => {
    expect(needsOf("vsix_platforms_release")).to.include.members(["vsix", "vsix_platforms", "vsix_platform_smoke"]);
    expect(needsOf("publish")).to.include("vsix_platforms_release");
    const marketplace = needsOf("marketplace");
    expect(marketplace).to.include.members(["publish", "vsix_platform_smoke"]);
  });

  it("the release upload runs the same gates as the other uploads", () => {
    const run = runOf("vsix_platforms_release");
    expect(jobs.vsix_platforms_release.env.FULL_SCAN).to.equal("${{ needs.vsix.outputs.full_scan }}");
    expect(run).to.contain('if [[ "$release_is_draft" != true && "$FULL_SCAN" != true ]]');
    expect(run).to.contain("node tools/osd-ci-wait-tests.mjs");
    expect(run).to.contain("node scripts/release-version.mjs --check-target");
    expect(run).to.contain('node tools/osd-provenance.mjs verify "$vsix"');
    expect(run).to.contain('sha256sum "$asset" > "$asset.sha256"');
    expect(run).to.match(/gh release upload "\$RELEASE_TAG" --clobber "\$\{assets\[@\]\}"/);
    expect(run).to.contain(`for target in ${TARGETS.join(" ")}; do`);
    // the smoked artifact, not a rebuild
    const download = jobs.vsix_platforms_release.steps.find((s) => s.uses?.startsWith("actions/download-artifact"));
    expect(download.with.name).to.equal("vsix-platforms");
  });

  it("the README allowlist and the publish check name the universal package and all five targets", () => {
    const leak = step("vsix", "Generate and scan CHANGELOG, README and FILE_ID.DIZ").run;
    const publish = step("publish", "Publish completed release").run;
    for (const text of [leak, publish]) {
      expect(text).to.contain('"open-steamgate-$version.vsix"');
      for (const t of TARGETS) expect(text).to.contain(`"open-steamgate-${t}-$version.vsix"`);
    }
    expect(publish).to.contain('grep -Fxq "$asset.sha256"');
  });

  it("the Marketplace job derives, verifies and smokes its own five, then publishes through one script", () => {
    const derive = step("marketplace", "Derive and verify the Marketplace platform packages").run;
    expect(derive).to.contain('node scripts/package-vsix-platforms.mjs --vsix "$vsix" --out build/vsix/platforms');
    expect(derive).to.contain('test "$count" -eq 5');
    expect(derive).to.contain("node scripts/smoke-vsix-sidecar.mjs");
    const names = jobs.marketplace.steps.map((s) => s.name);
    expect(names.indexOf("Derive and verify the Marketplace platform packages"))
      .to.be.greaterThan(names.indexOf("Build the Marketplace VSIX"))
      .and.lessThan(names.indexOf("Publish the built VSIX packages to Visual Studio Marketplace"));
    const pub = step("marketplace", "Publish the built VSIX packages to Visual Studio Marketplace");
    expect(pub.env.VSCE_PAT).to.equal("${{ secrets.VSCE_PAT }}");
    expect(pub.run).to.contain('node scripts/publish-marketplace.mjs publish "$RELEASE_TAG" --channel "$RELEASE_CHANNEL" --dir build/vsix');
    expect(pub.run).to.not.match(/vsce publish/);
    // only the tag push publishes, as before
    expect(jobs.marketplace.if).to.match(/github\.event_name == 'push'/);
  });

  it("the stable early check is the script's, so an interrupted stable publish can resume", () => {
    expect(step("vsix", "Require a new Marketplace version").run)
      .to.equal('node scripts/publish-marketplace.mjs check-new "$RELEASE_VERSION" --channel stable');
  });
});
