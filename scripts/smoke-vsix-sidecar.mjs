// Smoke one platform package's osd-hana-dump ON the machine it is for:
//
//   node scripts/smoke-vsix-sidecar.mjs <open-steamgate-<target>-<version>.vsix>
//
// Unpacks the package the way an install does (a zip into a folder), then,
// with the PACKAGED lookup code (extension/hana-sidecar.js, not this
// checkout's copy):
//   1. the manifest's TargetPlatform is this machine's target;
//   2. extension/bin/ holds exactly one file, this target's binary;
//   3. on POSIX it arrived executable; its execute bits are then removed and
//      the lookup's first use must restore them (ensureExecutable);
//   4. the binary answers `--version --json` from the extension folder;
//   5. the osd-hana module's own verification passes on it: SHA-256 against
//      tools/osd-hana/sidecar.lock.json (pinned: true) and the handshake
//      (schema 1, read_only, the pinned version/commit, `probe`).
// No database, no network. Exit 0 = all five held; anything else names what
// did not.
import {execFileSync, spawnSync} from "node:child_process";
import {chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync} from "node:fs";
import {createRequire} from "node:module";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {handshake, loadPin, resetVerifiedSidecars, targetKey, verifySidecar} from "../tools/osd-hana/sidecar.mjs";

const require = createRequire(import.meta.url);

function unpack(vsix, dir) {
  if (process.platform === "win32") {
    // Windows' own bsdtar reads zip; Git Bash's GNU tar earlier on PATH does not
    const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    execFileSync(tar, ["-xf", vsix, "-C", dir]);
  } else {
    execFileSync("unzip", ["-q", vsix, "-d", dir]);
  }
}

function filesUnder(dir) {
  const out = [];
  const walk = (at, rel) => {
    for (const entry of readdirSync(at, {withFileTypes: true})) {
      const next = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(at, entry.name), next);
      else out.push(next);
    }
  };
  walk(dir, "");
  return out.sort();
}

export async function smoke(vsix, {log = (line) => process.stdout.write(`${line}\n`)} = {}) {
  const target = targetKey();
  if (target === undefined) throw new Error(`smoke: ${process.platform}-${process.arch} is not a target osd-hana knows`);
  const dir = mkdtempSync(join(tmpdir(), "osd-vsix-smoke-"));
  try {
    unpack(resolve(vsix), dir);
    const ext = join(dir, "extension");
    const manifest = readFileSync(join(dir, "extension.vsixmanifest"), "utf8");
    const declared = /TargetPlatform="([^"]+)"/.exec(manifest)?.[1];
    if (declared !== target) throw new Error(`smoke: the package is for ${declared ?? "no target (universal)"}, this machine is ${target}`);
    log(`1. TargetPlatform ${declared} = this machine`);

    const bins = filesUnder(join(ext, "bin"));
    const name = target.startsWith("win32-") ? "osd-hana-dump.exe" : "osd-hana-dump";
    if (bins.length !== 1 || bins[0] !== `${target}/${name}`) throw new Error(`smoke: extension/bin/ holds ${bins.join(", ") || "nothing"}, expected only ${target}/${name}`);
    log(`2. extension/bin/ holds exactly ${bins[0]}`);

    const lookup = require(join(ext, "hana-sidecar.js"));
    const file = join(ext, "bin", target, name);
    if (process.platform !== "win32") {
      const mode = statSync(file).mode & 0o777;
      if ((mode & 0o111) !== 0o111) throw new Error(`smoke: the binary was unpacked without its execute bits (mode ${mode.toString(8)})`);
      chmodSync(file, 0o644);
    }
    const found = lookup.resolveBundledSidecar(ext);
    if (found.path !== file) throw new Error(`smoke: the lookup answered ${found.path}, expected ${file}`);
    if (process.platform !== "win32") {
      const mode = statSync(file).mode & 0o777;
      if (!found.madeExecutable || mode !== 0o755) throw new Error(`smoke: first use did not restore 0755 (mode ${mode.toString(8)})`);
      log("3. unpacked executable; with the bits stripped, first use restored 0755");
    } else {
      log("3. Windows: no mode to check");
    }
    const callerPath = lookup.callerPathFor(ext, {env: {}});

    const run = spawnSync(callerPath, ["--version", "--json"], {cwd: ext, encoding: "utf8", timeout: 60_000});
    if (run.error !== undefined || run.status !== 0) {
      throw new Error(`smoke: ${callerPath} --version --json failed: ${run.error?.message ?? `exit ${run.status}`}\n${run.stderr ?? ""}`);
    }
    const info = JSON.parse(run.stdout.trim());
    log(`4. --version --json: ${run.stdout.trim()}`);

    const pin = loadPin();
    resetVerifiedSidecars();
    const verified = await verifySidecar(callerPath, {pin, fresh: true, loud: () => {}});
    if (verified.pinned !== true || verified.target !== target) throw new Error(`smoke: the module did not verify it as pinned for ${target}: ${JSON.stringify(verified)}`);
    await handshake(callerPath, {pin, requiredCapabilities: ["probe"]});
    log(`5. osd-hana verified it: pinned ${pin.version} (${pin.commit.slice(0, 7)}), sha256 ${verified.sha256}, handshake ok`);
    return {target, path: callerPath, sha256: verified.sha256, version: info.version};
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const vsix = process.argv[2];
  if (vsix === undefined) {
    process.stderr.write("usage: node scripts/smoke-vsix-sidecar.mjs <platform.vsix>\n");
    process.exitCode = 1;
  } else {
    try {
      await smoke(vsix);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    }
  }
}
