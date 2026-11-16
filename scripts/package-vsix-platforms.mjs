// Five platform packages of the extension, each carrying ONE verified
// osd-hana-dump sidecar (tools/osd-hana/README.md, "Fetching the sidecar"):
//
//   node scripts/package-vsix-platforms.mjs [--vsix <universal.vsix>] [--out <dir>]
//                                           [--target <t>]... [--offline] [--unstamped]
//
// It does what `vsce package --target <t>` does, on the package this repo
// already builds: scripts/build-vsix.mjs writes the universal .vsix itself
// (an OPC zip, not vsce), and the seed in it costs minutes to stage, so the
// five platform packages are DERIVED from that one verified universal
// package instead of staging the seed five times. Per target:
//
//   1. tools/osd-hana/fetch-sidecar.mjs puts that target's binary into
//      editors/vscode/bin/<target>/osd-hana-dump[.exe] (gitignored),
//      verified by SHA-256 against tools/osd-hana/sidecar.lock.json;
//   2. the hash is checked again here, against the same pin, on the bytes
//      that are about to be packed (no gap between fetch and pack);
//   3. a copy of the universal package gets three entries replaced or added:
//      extension/bin/<target>/<binary> (mode 0755 in the archive),
//      extension.vsixmanifest with TargetPlatform="<target>" on <Identity>
//      (what vsce --target writes, and what the Marketplace and VS Code read
//      to pick the package for a machine), and [Content_Types].xml typing
//      the binary (an extensionless file gets an OPC <Override>);
//   4. the result is read back: exactly ONE file under extension/bin/, the
//      one for this target, with the pinned hash, executable on POSIX;
//   5. the provenance sidecar (.osd-provenance.json) is the universal's
//      verified record with this package's own SHA-256 and a `sidecar`
//      entry naming what was added.
//
// The universal package keeps working without a sidecar (the extension's
// editors/vscode/hana-sidecar.js says how to get one); build-vsix never
// copies editors/vscode/bin/ into it, and this script refuses a universal
// package that has an extension/bin/ entry.
//
// Nothing is published: the packages are written under build/ and that is
// all. Signing and notarisation are out of scope.
import {execFileSync} from "node:child_process";
import {createHash} from "node:crypto";
import {chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {fetchSidecar, outputName} from "../tools/osd-hana/fetch-sidecar.mjs";
import {loadPin} from "../tools/osd-hana/sidecar.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const SIDECAR_ROOT = join(ROOT, "editors", "vscode", "bin");
const BUILD_DIR = join(ROOT, "build", "vsix");

export class PlatformPackageError extends Error {}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** vsce's own file name for a target package: <name>-<target>-<version>.vsix */
export function platformVsixName(name, target, version) {
  return `${name}-${target}-${version}.vsix`;
}

/** The archive path of the sidecar for a target. */
export function sidecarEntry(target) {
  return `extension/bin/${target}/${outputName(target)}`;
}

/** extension.vsixmanifest with TargetPlatform on <Identity>. A manifest
 *  that already names a target is refused: the input must be universal. */
export function targetManifest(xml, target) {
  const identity = /<Identity\b([^>]*?)\s*\/>/;
  const match = identity.exec(xml);
  if (match === null) throw new PlatformPackageError("package-vsix-platforms: extension.vsixmanifest has no <Identity/> element");
  if (/\bTargetPlatform=/.test(match[1])) {
    throw new PlatformPackageError("package-vsix-platforms: the input package already names a TargetPlatform -- give the universal package");
  }
  // a function replacement: a `$` in the attributes (`$&`, `$'`, `$1`) stays literal
  return xml.replace(identity, () => `<Identity${match[1]} TargetPlatform="${target}" />`);
}

/** [Content_Types].xml that types the sidecar entry: `.exe` gets a Default
 *  by extension (when missing), an extensionless binary an Override by part
 *  name, both application/octet-stream. */
export function targetContentTypes(xml, target) {
  if (!xml.includes("</Types>")) throw new PlatformPackageError("package-vsix-platforms: [Content_Types].xml has no </Types>");
  const name = outputName(target);
  let line;
  if (name.endsWith(".exe")) {
    if (/<Default\s+Extension="\.?exe"/i.test(xml)) return xml;
    line = '<Default Extension="exe" ContentType="application/octet-stream"/>';
  } else {
    line = `<Override PartName="/${sidecarEntry(target)}" ContentType="application/octet-stream"/>`;
    if (xml.includes(line)) return xml;
  }
  return xml.replace("</Types>", `${line}\n</Types>`);
}

// unzip reads an entry name as a wildcard pattern: "[Content_Types].xml"
// would be a character class and match nothing. Escape the pattern
// characters so a name is only ever itself.
const unzipLiteral = (entry) => entry.replace(/[[\]*?\\]/g, (c) => `\\${c}`);

/** The default archiver: the system zip/unzip CLIs, as build-vsix uses. */
export const defaultArchive = {
  list: (vsix) => execFileSync("unzip", ["-Z1", vsix], {encoding: "utf8", maxBuffer: 256 * 1024 * 1024}).split(/\r?\n/).filter(Boolean),
  read: (vsix, entry) => execFileSync("unzip", ["-p", vsix, unzipLiteral(entry)], {maxBuffer: 256 * 1024 * 1024}),
  // `zip` replaces an entry of the same name and adds a new one; -X keeps
  // no extra attributes but the Unix mode, which carries the 0755.
  update: (vsix, cwd, entries) => execFileSync("zip", ["-X", "-q", vsix, ...entries], {cwd}),
  // zipinfo's mode column (`-rwxr-xr-x ...`) for one entry
  mode: (vsix, entry) => execFileSync("unzip", ["-Z", vsix, unzipLiteral(entry)], {encoding: "utf8"}).trim().split(/\s+/)[0],
};

/** Read a platform package back and say what is wrong with it, or nothing.
 *  Exactly one file under extension/bin/, the one for `target`, with the
 *  pinned hash, executable on POSIX, and TargetPlatform in the manifest. */
export function inspectPlatformVsix(vsix, target, {pin, archive = defaultArchive} = {}) {
  const problems = [];
  const entries = archive.list(vsix);
  const binaries = entries.filter((entry) => entry.startsWith("extension/bin/") && !entry.endsWith("/"));
  const expected = sidecarEntry(target);
  if (binaries.length !== 1 || binaries[0] !== expected) {
    problems.push(`expected exactly ${expected} under extension/bin/, found ${binaries.length === 0 ? "nothing" : binaries.join(", ")}`);
  }
  if (entries.includes(expected)) {
    const actual = sha256(archive.read(vsix, expected));
    if (actual !== pin.targets[target]) problems.push(`${expected} has sha256 ${actual}, the pin says ${pin.targets[target]}`);
    if (!target.startsWith("win32-")) {
      const mode = archive.mode(vsix, expected);
      if (!/^-rwx.-x.-x$/.test(mode)) problems.push(`${expected} is not executable in the archive (mode ${mode})`);
    }
  }
  const manifest = archive.read(vsix, "extension.vsixmanifest").toString("utf8");
  if (!manifest.includes(`TargetPlatform="${target}"`)) problems.push(`extension.vsixmanifest does not name TargetPlatform="${target}"`);
  return {problems, binaries};
}

/** Build one platform package from the universal one. Returns
 *  {target, out, bytes, sidecar: {path, sha256, bytes}}. */
export async function packageTarget({
  target,
  universal,
  outDir,
  pin = loadPin(),
  sidecarRoot = SIDECAR_ROOT,
  offline = false,
  fetchFn = fetchSidecar,
  archive = defaultArchive,
  provenance = true,
  log = () => {},
}) {
  if (!(target in (pin.targets ?? {}))) {
    throw new PlatformPackageError(`package-vsix-platforms: the pin (${pin.version}) has no target "${target}"; it covers ${Object.keys(pin.targets ?? {}).join(", ")}`);
  }
  // 1. fetch-sidecar: download + verify against the pin (or a cached hit)
  const fetched = await fetchFn({target, outDir: sidecarRoot, pin, offline, log});
  // 2. the bytes about to be packed, against the same pin
  const bytes = readFileSync(fetched.path);
  const actual = sha256(bytes);
  if (actual !== pin.targets[target]) {
    throw new PlatformPackageError(`package-vsix-platforms: refusing ${fetched.path} for ${target}: SHA-256 mismatch.\n` +
      `  pinned: ${pin.targets[target]}\n  actual: ${actual}`);
  }

  const pkg = JSON.parse(archive.read(universal, "extension/package.json").toString("utf8"));
  const out = join(outDir, platformVsixName(pkg.name, target, pkg.version));
  mkdirSync(outDir, {recursive: true});
  rmSync(out, {force: true});
  rmSync(`${out}.osd-provenance.json`, {force: true});
  copyFileSync(universal, out);

  // 3. the three entries, staged in a temp tree and zipped into the copy
  const entry = sidecarEntry(target);
  const stage = mkdtempSync(join(tmpdir(), "osd-vsix-platform-"));
  try {
    mkdirSync(join(stage, dirname(entry)), {recursive: true});
    writeFileSync(join(stage, entry), bytes);
    chmodSync(join(stage, entry), 0o755);
    writeFileSync(join(stage, "extension.vsixmanifest"),
      targetManifest(archive.read(universal, "extension.vsixmanifest").toString("utf8"), target));
    writeFileSync(join(stage, "[Content_Types].xml"),
      targetContentTypes(archive.read(universal, "[Content_Types].xml").toString("utf8"), target));
    archive.update(out, stage, ["[Content_Types].xml", "extension.vsixmanifest", entry]);
  } catch (error) {
    rmSync(out, {force: true});
    throw error;
  } finally {
    rmSync(stage, {recursive: true, force: true});
  }

  // 4. read it back
  const {problems} = inspectPlatformVsix(out, target, {pin, archive});
  if (problems.length > 0) {
    rmSync(out, {force: true});
    throw new PlatformPackageError(`package-vsix-platforms: ${basename(out)} is wrong:\n  - ${problems.join("\n  - ")}`);
  }

  // 5. provenance: the universal's verified record, this package's hash
  if (provenance) {
    const {verifyPublicArtefact} = await import("../tools/osd-provenance.mjs");
    const record = verifyPublicArtefact(universal);
    writeFileSync(`${out}.osd-provenance.json`, `${JSON.stringify({
      ...record,
      artefact: basename(out),
      sha256: sha256(readFileSync(out)),
      derivedFrom: {artefact: record.artefact, sha256: record.sha256},
      sidecar: {name: "osd-hana-dump", target, version: pin.version, commit: pin.commit, entry, sha256: actual},
    }, null, 2)}\n`);
  }
  const size = statSync(out).size;
  log(`package-vsix-platforms: ${target} -> ${out} (${(size / 1048576).toFixed(1)} MB, sidecar ${(bytes.length / 1048576).toFixed(1)} MB, sha256 ${actual.slice(0, 12)})`);
  return {target, out, bytes: size, sidecar: {path: fetched.path, sha256: actual, bytes: bytes.length}};
}

/** Refuse a universal package that already carries a bin/ entry: the five
 *  platform packages must each hold exactly their own binary, and the
 *  universal one none. */
export function assertUniversal(universal, {archive = defaultArchive} = {}) {
  const stray = archive.list(universal).filter((entry) => entry.startsWith("extension/bin/"));
  if (stray.length > 0) {
    throw new PlatformPackageError(`package-vsix-platforms: the universal package ${basename(universal)} already carries ${stray.join(", ")} -- ` +
      "build-vsix must not ship editors/vscode/bin/");
  }
  const manifest = archive.read(universal, "extension.vsixmanifest").toString("utf8");
  if (/\bTargetPlatform=/.test(manifest)) {
    throw new PlatformPackageError(`package-vsix-platforms: ${basename(universal)} is already a platform package`);
  }
}

export async function packagePlatforms({universal, outDir, targets, pin = loadPin(), ...rest}) {
  assertUniversal(universal, rest);
  const results = [];
  for (const target of targets ?? Object.keys(pin.targets)) {
    results.push(await packageTarget({target, universal, outDir, pin, ...rest}));
  }
  return results;
}

// ------------------------------------------------------------------ the CLI

export function parseArgs(argv) {
  const args = {targets: [], offline: false, unstamped: false};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new PlatformPackageError(`package-vsix-platforms: ${flag} needs a value`);
      return next;
    };
    if (flag === "--vsix") args.vsix = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--target") args.targets.push(value());
    else if (flag === "--offline") args.offline = true;
    else if (flag === "--unstamped") args.unstamped = true;
    else if (flag === "--help" || flag === "-h") args.help = true;
    else throw new PlatformPackageError(`package-vsix-platforms: unknown argument "${flag}"`);
  }
  return args;
}

/** The universal package `npm run vsix` just wrote, by the staged version. */
export function defaultUniversal(buildDir = BUILD_DIR) {
  const staged = join(buildDir, "stage", "extension", "package.json");
  if (!existsSync(staged)) {
    throw new PlatformPackageError(`package-vsix-platforms: no universal package to derive from (${staged} is missing) -- run npm run vsix first, or pass --vsix`);
  }
  const {name, version} = JSON.parse(readFileSync(staged, "utf8"));
  return join(buildDir, `${name}-${version}.vsix`);
}

const HELP = `Usage: node scripts/package-vsix-platforms.mjs [--vsix <universal.vsix>] [--out <dir>]
                                         [--target <t>]... [--offline] [--unstamped]

Derives one platform package per target from the universal .vsix
(default: the one npm run vsix wrote), each carrying exactly that target's
pinned osd-hana-dump (tools/osd-hana/fetch-sidecar.mjs, verified by SHA-256).

  --vsix <file>  the universal package (default build/vsix/<name>-<version>.vsix)
  --out <dir>    where to write (default build/vsix/platforms)
  --target <t>   one of the pin's targets (repeatable; default all five)
  --offline      fetch nothing; only a cached binary with the pinned hash is used
  --unstamped    the universal package has no provenance (a local dev build);
                 the platform packages then get none either`;

export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  try {
    const args = parseArgs(argv);
    if (args.help) {
      out(HELP);
      return 0;
    }
    const universal = resolve(args.vsix ?? defaultUniversal());
    const outDir = resolve(args.out ?? join(BUILD_DIR, "platforms"));
    const results = await packagePlatforms({
      universal, outDir,
      targets: args.targets.length > 0 ? args.targets : undefined,
      offline: args.offline,
      provenance: !args.unstamped,
      log: out,
      ...deps.packaging,
    });
    for (const r of results) out(`${basename(r.out)}\t${r.bytes}`);
    return 0;
  } catch (error) {
    err(error instanceof PlatformPackageError || error?.name === "FetchError" || error?.constructor?.name === "FetchError"
      ? error.message : `package-vsix-platforms: ${error?.message ?? error}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
