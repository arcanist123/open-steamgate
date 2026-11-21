import {strict as assert} from "node:assert";
import {readFileSync} from "node:fs";
import {renderDiz, renderReadme, VSIX_TARGETS} from "../scripts/release-readme.mjs";

describe("release README and FILE_ID.DIZ", () => {
  it("renders start and checksum instructions for a sample release asset list", () => {
    const readme = renderReadme([
      "open-steamgate-0.1.42.vsix", "osd-linux-x64", "osd-darwin-arm64",
      "osd-windows-x64.exe", "sqlite.yml", "postgres.yml", "hana.yml",
    ]);
    assert.match(readme, /VS Code 1\.101 or newer/);
    assert.match(readme, /osd: Remove old working copies/);
    assert.match(readme, /chmod \+x osd && \.\/osd up/);
    assert.match(readme, /xattr -d com\.apple\.quarantine osd/);
    assert.match(readme, /osd\.exe doctor/);
    assert.match(readme, /self-contained Bun binary/);
    assert.match(readme, /osd up --layer <folder>/);
    assert.match(readme, /OSD_LAYERS/);
    assert.match(readme, /docker compose -f sqlite\.yml up -d/);
    assert.match(readme, /HANA_HOST.*HANA_USER.*HANA_PASSWORD/);
    assert.match(readme, /sha256sum -c/);
    assert.match(readme, /shasum -a 256 -c/);
    assert.match(readme, /Get-FileHash/);
    assert.doesNotMatch(readme, /duckdb\.yml/);
    assert.throws(() => renderReadme(["unexpected.txt"]), /unknown release asset/);
  });

  it("FILE_ID.DIZ stays within classic BBS byte and line limits", () => {
    const version = "0.1.1098";
    const bytes = renderDiz(version);
    const text = bytes.toString("ascii");
    assert.ok(text.includes(version));
    assert.match(text, /\.vsix/);
    assert.match(text, /binaries/);
    assert.match(text, /Compose/);
    assert.match(text, /  o O  _\|_____________________/);
    assert.match(text, /<\|=\|=\|    \|\|    \(o-o\)       \)/);
    assert.match(text, /\\\[_ooo_\]\//);
    assert.match(text, /\r\n$/);
    assert.equal(text.replaceAll("\r\n", "").includes("\n"), false);
    assert.equal(text.replaceAll("\r\n", "").includes("\r"), false);
    const lines = text.slice(0, -2).split("\r\n");
    assert.ok(lines.length <= 10);
    for (const line of lines) assert.ok(line.length <= 40);
    for (const line of lines.slice(-4)) assert.ok(line.length <= 31);
    for (const byte of bytes) assert.ok((byte >= 0x20 && byte <= 0x7e) || byte === 0x0d || byte === 0x0a);
    assert.throws(() => renderDiz("not-a-version"), /numeric release version/);
  });

  it("describes each OSGo asset and its health route", () => {
    const text = renderReadme(["osgo-linux-x64", "osgo-windows-x64.exe"]);
    assert.match(text, /osgo-linux-x64/);
    assert.match(text, /osgo-windows-x64\.exe/);
    assert.match(text, /\/health/);
    assert.match(text, /-home/);
    assert.match(text, /does not serve ADT yet/);
    assert.match(text, /sha256sum -c/);
  });

  it("knows the six platforms of each binary, Intel macOS and Windows on Arm included", () => {
    const text = renderReadme(["osd-darwin-x64", "osd-windows-arm64.exe", "osgo-darwin-x64", "osgo-windows-arm64.exe"]);
    assert.match(text, /## osd-darwin-x64\n\n.*mv osd-darwin-x64 osd/);
    assert.match(text, /xattr -d com\.apple\.quarantine osd/);
    assert.match(text, /## osd-windows-arm64\.exe\n\n.*osd\.exe up/);
    assert.match(text, /## osgo-windows-arm64\.exe\n\n.*osgo\.exe/);
  });

  it("allows the five platform packages beside the universal one, and nothing else named like them", () => {
    const pin = JSON.parse(readFileSync(new URL("../tools/osd-hana/sidecar.lock.json", import.meta.url), "utf8"));
    assert.deepEqual([...VSIX_TARGETS].sort(), Object.keys(pin.targets).sort());
    const names = VSIX_TARGETS.map((t) => `open-steamgate-${t}-0.7.42.vsix`);
    const text = renderReadme(["open-steamgate-0.7.42.vsix", ...names]);
    for (const t of VSIX_TARGETS) {
      assert.match(text, new RegExp(`## open-steamgate-${t}-0\\.7\\.42\\.vsix\n\nThe same extension for ${t} only, with the \`osd-hana-dump\` sidecar`));
    }
    assert.match(text, /## open-steamgate-0\.7\.42\.vsix\n\nIn VS Code 1\.101/);
    assert.match(text, /sha256sum -c/);
    assert.throws(() => renderReadme(["open-steamgate-win32-arm64-0.7.42.vsix"]), /unknown release asset/);
    assert.throws(() => renderReadme(["open-steamgate-web-0.7.42.vsix"]), /unknown release asset/);
    assert.throws(() => renderReadme(["open-steamgate-linux-x64-0.7.42.vsix.sha256"]), /unknown release asset/);
  });
});
