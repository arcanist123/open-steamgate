#!/usr/bin/env node
// A small start guide for the assets on this release. Render from the asset
// list so a release cannot describe a target it did not intend to upload.
import {resolve} from "node:path";
import {fileURLToPath} from "node:url";

const binaries = new Set(["osd-linux-x64", "osd-linux-arm64", "osd-darwin-arm64", "osd-darwin-x64",
  "osd-windows-x64.exe", "osd-windows-arm64.exe"]);
const goBinaries = new Set(["osgo-linux-x64", "osgo-linux-arm64", "osgo-darwin-arm64", "osgo-darwin-x64",
  "osgo-windows-x64.exe", "osgo-windows-arm64.exe"]);
const compose = new Set(["sqlite.yml", "duckdb.yml", "postgres.yml", "hana.yml"]);
// The platform packages (scripts/package-vsix-platforms.mjs): vsce's naming,
// <name>-<target>-<version>.vsix, for the five targets the sidecar pin covers.
export const VSIX_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];
const universalVsix = /^open-steamgate-\d+\.\d+\.\d+\.vsix$/;
const platformVsix = new RegExp(`^open-steamgate-(${VSIX_TARGETS.join("|")})-\\d+\\.\\d+\\.\\d+\\.vsix$`);

export function renderReadme(assets) {
  const names = [...new Set(assets)];
  if (names.length === 0) throw new Error("pass at least one release asset");
  for (const name of names) {
    if (!universalVsix.test(name) && !platformVsix.test(name) && !binaries.has(name) && !goBinaries.has(name) && !compose.has(name)) {
      throw new Error(`unknown release asset: ${name}`);
    }
  }
  const lines = [
    "# Start here",
    "",
    "Pick the VSIX for VS Code, a self-contained Bun binary, a static OSGo binary, or a Compose file for Docker. SQLite is the default Compose database.",
    "",
  ];
  for (const name of names) {
    lines.push(`## ${name}`, "");
    const platform = platformVsix.exec(name)?.[1];
    if (platform !== undefined) {
      lines.push(
        `The same extension for ${platform} only, with the \`osd-hana-dump\` sidecar bundled for **OSD: Extract my code from HANA**. Install it like the universal VSIX (**Extensions: Install from VSIX...**); use it on ${platform} only. The Marketplace serves this package to ${platform} automatically.`,
        "",
      );
    } else if (name.endsWith(".vsix")) {
      lines.push(
        "In VS Code 1.101 or newer, run **Extensions: Install from VSIX...** and select this file. Then run **osd: Start (build + run this system)** from the Command Palette. If asked whether to run an open-steamgate checkout, choose the bundled copy to use the packaged system. Its first start copies and builds the system; allow time for that build.",
        "",
        "The bundled working copy lives at `<globalStorageUri>/osd-home-<seedId>/`; the database lives under `<globalStorageUri>/osd-instance/<home-hash>/db/osd.sqlite`. VS Code owns the actual global storage path. After an update, run **osd: Remove old working copies** to review and remove stale bundled copies.",
        "",
      );
    } else if (goBinaries.has(name)) {
      const executable = name.endsWith(".exe") ? ".\\osgo.exe" : "./osgo";
      lines.push(`OSGo is a single static Go executable with SQLite built in. Download and verify this file, rename it to \`${name.endsWith(".exe") ? "osgo.exe" : "osgo"}\`, then run \`${executable} -home <data-directory> -port 3095\`. Check \`http://127.0.0.1:3095/health\` for readiness. A new home directory starts a newly seeded database; \`-db <file>\` overrides its database path. Run \`${executable} -version\` for the tag and commit. OSGo does not serve ADT yet. See docs/osgo-release.md for CI usage.`, "");
    } else if (binaries.has(name)) {
      if (name.endsWith(".exe")) {
        lines.push(
          "Download this file into any folder, rename it to `osd.exe`, and run `.\\osd.exe up` in PowerShell. Run `.\\osd.exe doctor` to check the bundled runtime.",
          "",
        );
      } else {
        lines.push(
          `Download this file into any folder. Run \`mv ${name} osd && chmod +x osd && ./osd up\`; run \`./osd doctor\` to check the bundled runtime.`,
          "",
        );
      }
      if (name.startsWith("osd-darwin-")) {
        lines.push("If macOS Gatekeeper quarantines the download, run `xattr -d com.apple.quarantine osd` after checking its checksum.", "");
      }
      if (name === "osd-linux-x64") {
        lines.push("Measured Linux x64 executable size: 109.5 MB (decimal, local Bun 1.4.2 build).", "");
      }
      lines.push(
        "Open `http://localhost:3030/`. On first start outside a checkout, the binary copies its bundled system into a content-keyed `osd-home-<seedId>` under the user data directory: `$XDG_DATA_HOME/open-steamgate` or `~/.local/share/open-steamgate` on Linux, `~/Library/Application Support/open-steamgate` on macOS, `%LOCALAPPDATA%\\open-steamgate` on Windows. Later releases keep earlier working copies and user edits. The SQLite database lives in that working copy under `.local/db/`.",
        "To override an ABAP object, copy its file from the materialized home's `src/` or `packs/` into your own folder, retaining its abapGit filename, then run `osd up --layer <folder>`. Repeat `--layer` for more folders, or set `OSD_LAYERS` to a platform path-list. Later layers win, and the build logs each override. A binary started inside a source checkout uses that checkout directly.",
        "",
      );
    } else {
      if (name === "postgres.yml") {
        lines.push("Set `POSTGRES_PASSWORD` in your environment, then run `docker compose -f postgres.yml up -d`. Open `http://localhost:3030/`. PostgreSQL rows live in the `pg-data` Docker volume.", "");
      } else if (name === "hana.yml") {
        lines.push("Set `HANA_HOST`, `HANA_USER`, and `HANA_PASSWORD` in your environment for an existing HANA tenant, then run `docker compose -f hana.yml up -d`. Open `http://localhost:3030/`. HANA data stays on the external tenant; `HANA_PORT` and `HANA_SCHEMA` are optional.", "");
      } else {
        lines.push(`Run \`docker compose -f ${name} up -d\`, then open \`http://localhost:3030/\`. ${name === "sqlite.yml" ? "SQLite rows" : "DuckDB rows"} live in the \`osd-data\` Docker volume.`, "");
      }
      lines.push("The file uses `ghcr.io/oisee/open-steamgate:draft` by default; set `OSD_TAG` to a tested Docker image tag to pin it.", "");
    }
  }
  const checksummed = names.filter((name) => name.endsWith(".vsix") || binaries.has(name) || goBinaries.has(name));
  if (checksummed.length) {
    lines.push(
      "## Check downloads",
      "",
      "Each VSIX and executable has a matching `<asset>.sha256` file. Download the file and its checksum into one directory. On Linux run `sha256sum -c <asset>.sha256`; on macOS run `shasum -a 256 -c <asset>.sha256`. On Windows run `Get-FileHash .\\<asset> -Algorithm SHA256` in PowerShell and compare its Hash with the first value in `<asset>.sha256` (`Get-Content .\\<asset>.sha256`).",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

// Classic BBS FILE_ID.DIZ: printable 7-bit ASCII and CRLF only.
export function renderDiz(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? "")) throw new Error("pass a numeric release version");
  const lines = [
    `Open Steamgate ${version}`,
    "Local OData v2 runtime for ABAP services",
    "VS Code extension: .vsix",
    "OSD binaries: Linux, macOS, Windows",
    "Docker Compose: four database choices",
    "",
    "  o O  _|_____________________",
    " <|=|=|    ||    (o-o)       )",
    "  \\___________________________/",
    "          \\[_ooo_]/",
  ];
  if (lines.length > 10 || lines.some((line) => line.length > 40 || !/^[\x20-\x7e]*$/.test(line))) {
    throw new Error("release version does not fit FILE_ID.DIZ limits");
  }
  return Buffer.from(`${lines.join("\r\n")}\r\n`, "ascii");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    process.stdout.write(args[0] === "--diz" ? renderDiz(args[1]) : renderReadme(args));
  }
  catch (error) { console.error(`release-readme: ${error.message}`); process.exitCode = 1; }
}
