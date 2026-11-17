#!/usr/bin/env node
// Publish one release's VS Code packages to the Visual Studio Marketplace:
// the five platform packages (scripts/package-vsix-platforms.mjs, each
// carrying its own osd-hana-dump) first, the universal package last.
//
//   node scripts/publish-marketplace.mjs publish <tag> --channel prerelease|stable --dir <dir>
//   node scripts/publish-marketplace.mjs check-new <version> --channel stable
//
// How the Marketplace chooses (both read 2026-11-17):
//   * VS Code docs, "Platform-specific extensions"
//     (https://code.visualstudio.com/api/working-with-extensions/publishing-extension#platformspecific-extensions):
//     "Starting with version 1.61.0, VS Code looks for the extension package
//     that matches the current platform", and a package published without a
//     target "will be used as a fallback for all platforms that have no
//     platform-specific package" -- web, win32-arm64, alpine-*, linux-armhf.
//     The docs also say a platform-specific extension that should run in the
//     browser "must target the web platform"; ours does not need to, because
//     the universal package (the one with the browser entry) is the fallback.
//   * vsce 4.0.0, out/publish.js: `publish --packagePath` reads TargetPlatform
//     from each package's <Identity> and publishes it as that target; its
//     duplicate check is `v.version === manifest.version && v.targetPlatform
//     === options.target`, so a universal package (target undefined) and the
//     platform packages of the SAME version are distinct entries and may all
//     be published. `--pre-release` is refused for a package without the
//     Microsoft.VisualStudio.Code.PreRelease property, and applies per package.
//
// Order and reruns. The universal package goes last, so its presence on the
// Marketplace means the version is complete. Before publishing, the existing
// entries are read (`vsce show --json`) and every (version, target) already
// there is SKIPPED with a notice; the rest are published without
// --skip-duplicate, so a package that appears between the read and the
// publish still fails loudly. The Marketplace does not expose a package's
// bytes to vsce, so a skipped target keeps the bytes of the run that
// published it: a rerun can complete a version, it cannot replace one. A
// failed publish stops the run at once (the universal package is then never
// published) and the job is red.
import {execFileSync, spawnSync} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {basename, dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const EXTENSION_ID = "oisee.open-steamgate";
export const VSCE = ["npm", "exec", "--yes", "--package=@vscode/vsce@4.0.0", "--", "vsce"];
export const PRERELEASE_PROPERTY = "Microsoft.VisualStudio.Code.PreRelease";

export class MarketplaceError extends Error {}

/** The platform targets: the sidecar pin's, in its order. */
export function pinnedTargets(root = ROOT) {
  const pin = JSON.parse(readFileSync(join(root, "tools", "osd-hana", "sidecar.lock.json"), "utf8"));
  return Object.keys(pin.targets);
}

const unzipLiteral = (entry) => entry.replace(/[[\]*?\\]/g, (c) => `\\${c}`);
export const defaultArchive = {
  read: (vsix, entry) => execFileSync("unzip", ["-p", vsix, unzipLiteral(entry)], {maxBuffer: 64 * 1024 * 1024}),
};

/** What a package says about itself: name, publisher and version from
 *  extension/package.json, target and pre-release from the manifest. */
export function readPackage(path, {archive = defaultArchive} = {}) {
  const pkg = JSON.parse(archive.read(path, "extension/package.json").toString("utf8"));
  const manifest = archive.read(path, "extension.vsixmanifest").toString("utf8");
  const identity = /<Identity\b([^>]*)>/.exec(manifest);
  if (identity === null) throw new MarketplaceError(`${basename(path)}: extension.vsixmanifest has no <Identity>`);
  const target = /\bTargetPlatform="([^"]*)"/.exec(identity[1])?.[1];
  const manifestVersion = /\bVersion="([^"]*)"/.exec(identity[1])?.[1];
  const prerelease = new RegExp(`Id="${PRERELEASE_PROPERTY.replaceAll(".", "\\.")}"\\s+Value="true"`).test(manifest);
  return {path, name: pkg.name, publisher: pkg.publisher, version: pkg.version, manifestVersion, target, prerelease};
}

/** The release's packages, checked against each other and the channel:
 *  every pinned target once, named the way vsce names it, one version,
 *  pre-release exactly when the channel is. Platforms in pin order, the
 *  universal package last. */
export function collectPackages({dir, version, channel, targets, archive = defaultArchive, exists = existsSync}) {
  if (channel !== "prerelease" && channel !== "stable") throw new MarketplaceError(`unknown channel "${channel}"`);
  const paths = [
    ...targets.map((target) => ({target, path: join(dir, "platforms", `open-steamgate-${target}-${version}.vsix`)})),
    {target: undefined, path: join(dir, `open-steamgate-${version}.vsix`)},
  ];
  const problems = [];
  const packages = [];
  for (const {target, path} of paths) {
    if (!exists(path)) {
      problems.push(`missing ${path}`);
      continue;
    }
    const info = readPackage(path, {archive});
    const label = basename(path);
    if (info.target !== target) problems.push(`${label}: TargetPlatform is ${info.target ?? "absent"}, expected ${target ?? "absent (universal)"}`);
    if (info.version !== version || info.manifestVersion !== version) problems.push(`${label}: version ${info.version}/${info.manifestVersion}, expected ${version}`);
    if (`${info.publisher}.${info.name}` !== EXTENSION_ID) problems.push(`${label}: is ${info.publisher}.${info.name}, expected ${EXTENSION_ID}`);
    if (info.prerelease !== (channel === "prerelease")) {
      problems.push(`${label}: ${info.prerelease ? "carries" : "lacks"} the ${PRERELEASE_PROPERTY} property on the ${channel} channel`);
    }
    packages.push(info);
  }
  if (problems.length > 0) throw new MarketplaceError(`the Marketplace packages are not one release:\n  - ${problems.join("\n  - ")}`);
  return packages;
}

const isPrereleaseEntry = (entry) =>
  (entry.properties ?? []).some((p) => p.key === PRERELEASE_PROPERTY && String(p.value) === "true");

/** Split the packages into what to publish and what the Marketplace already
 *  has for this version (same target; the universal entry has none). */
export function planPublish(packages, existingVersions) {
  const publish = [];
  const skip = [];
  for (const pkg of packages) {
    const present = existingVersions.some((v) => v.version === pkg.version && (v.targetPlatform ?? undefined) === pkg.target);
    (present ? skip : publish).push(pkg);
  }
  return {publish, skip};
}

/** The stable early check, before anything is built: refuse a version that
 *  exists as a pre-release in any target (a pre-release cannot become
 *  stable), or whose universal package is already there (the version is
 *  complete; universal goes last). Stable platform entries without the
 *  universal one are an interrupted publish, which a rerun may complete. */
export function checkNewVersion(existingVersions, version) {
  const same = existingVersions.filter((v) => v.version === version);
  if (same.some(isPrereleaseEntry) || same.some((v) => v.properties === undefined)) {
    return `Marketplace version ${version} already exists as a pre-release (or with unreadable properties). A prerelease cannot be republished as stable; release a new commit with a new stamped version.`;
  }
  if (same.some((v) => (v.targetPlatform ?? undefined) === undefined)) {
    return `Marketplace version ${version} already exists, universal package included. Release a new commit with a new stamped version.`;
  }
  return null;
}

/** `vsce show --json`: the extension's versions, [] when it is not there. */
export function showVersions({run = spawnSync} = {}) {
  const result = run(VSCE[0], [...VSCE.slice(1), "show", EXTENSION_ID, "--json"], {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
  if (result.status !== 0) throw new MarketplaceError(`vsce show ${EXTENSION_ID} failed (exit ${result.status}): ${result.stderr ?? ""}`);
  const data = JSON.parse(result.stdout);
  if (!Array.isArray(data?.versions)) throw new MarketplaceError(`vsce show ${EXTENSION_ID} --json has no versions array`);
  return data.versions;
}

export function publishArgs(pkg, channel) {
  return [...VSCE.slice(1), "publish", ...(channel === "prerelease" ? ["--pre-release"] : []), "--packagePath", pkg.path];
}

export function publishAll({packages, channel, existingVersions, run = spawnSync, log = console.log}) {
  const {publish, skip} = planPublish(packages, existingVersions);
  for (const pkg of skip) {
    log(`::notice::${EXTENSION_ID} ${pkg.target ?? "universal"} v${pkg.version} is already on the Marketplace; skipped (it keeps the bytes of the run that published it)`);
  }
  for (const pkg of publish) {
    log(`publishing ${basename(pkg.path)} (${pkg.target ?? "universal"}${channel === "prerelease" ? ", pre-release" : ""})`);
    const result = run(VSCE[0], publishArgs(pkg, channel), {stdio: "inherit"});
    if (result.status !== 0) {
      throw new MarketplaceError(`vsce publish ${basename(pkg.path)} failed (exit ${result.status ?? result.signal}); ` +
        `${publish.indexOf(pkg) + 1 < publish.length ? "the remaining packages, the universal one included, were not published" : "nothing after it was attempted"}`);
    }
  }
  return {published: publish.map((p) => p.target ?? "universal"), skipped: skip.map((p) => p.target ?? "universal")};
}

function option(argv, flag) {
  const at = argv.indexOf(flag);
  if (at === -1 || argv[at + 1] === undefined) throw new MarketplaceError(`${flag} <value> is required`);
  return argv[at + 1];
}

export function main(argv, {run = spawnSync, log = console.log, archive = defaultArchive, exists = existsSync, targets} = {}) {
  const [command, subject] = argv;
  try {
    if (command === "check-new") {
      if (option(argv, "--channel") !== "stable") throw new MarketplaceError("check-new is the stable channel's check");
      const refusal = checkNewVersion(showVersions({run}), subject);
      if (refusal) {
        log(`::error::${refusal}`);
        return 1;
      }
      return 0;
    }
    if (command === "publish") {
      const version = /^vscode-(?:stable-)?v(\d+\.\d+\.\d+)$/.exec(subject ?? "")?.[1];
      if (!version) throw new MarketplaceError(`publish needs a vscode-v<version> or vscode-stable-v<version> tag, got "${subject}"`);
      const channel = option(argv, "--channel");
      if ((channel === "stable") !== subject.startsWith("vscode-stable-v")) throw new MarketplaceError(`tag ${subject} is not on the ${channel} channel`);
      const packages = collectPackages({dir: option(argv, "--dir"), version, channel, targets: targets ?? pinnedTargets(), archive, exists});
      const {published, skipped} = publishAll({packages, channel, existingVersions: showVersions({run}), run, log});
      log(`Marketplace ${version}: published ${published.join(", ") || "nothing"}; already there ${skipped.join(", ") || "nothing"}`);
      return 0;
    }
    throw new MarketplaceError("usage: publish-marketplace.mjs publish <tag> --channel <c> --dir <dir> | check-new <version> --channel stable");
  } catch (error) {
    log(`::error::publish-marketplace: ${error.message}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
