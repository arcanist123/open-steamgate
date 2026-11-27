"use strict";
// The osd-hana-dump sidecar a platform package of the extension carries
// (tools/osd-hana/README.md "How the doctor runs the sidecar", step 1
// "Locate": the path the caller hands in). Each platform .vsix
// (scripts/package-vsix-platforms.mjs) holds exactly ONE binary, at
//
//     <extension>/bin/<target>/osd-hana-dump[.exe]
//
// where <target> is Node's own platform-arch name (linux-x64, linux-arm64,
// darwin-x64, darwin-arm64, win32-x64) -- the keys of
// tools/osd-hana/sidecar.lock.json. The universal package carries none.
//
// This module only FINDS the file and makes it executable. It does not
// verify it: the path is handed to the osd-hana module as `callerPath`, and
// the module hashes it against its pin before the first use and again before
// every spawn (the build checked it too, in fetch-sidecar). One verifier,
// not two that could disagree.
//
// No download lives here, by the module's rule: a universal install says how
// to get a binary instead.
const fs = require("node:fs");
const path = require("node:path");

const SIDECAR_NAME = "osd-hana-dump";

// The pin's targets. A platform/arch pair not listed is refused under its
// own name -- never mapped to a neighbour (win32-arm64 is not win32-x64,
// even where x64 emulation would start it: the module refuses it the same
// way, so the two agree).
const SIDECAR_TARGETS = Object.freeze(["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]);

class HanaSidecarError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HanaSidecarError";
    this.code = code;
  }
}

function sidecarFileName(target) {
  return target.startsWith("win32-") ? `${SIDECAR_NAME}.exe` : SIDECAR_NAME;
}

/** The pin target for this machine, or OSD_HANA_UNSUPPORTED_TARGET. */
function sidecarTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!SIDECAR_TARGETS.includes(target)) {
    throw new HanaSidecarError("OSD_HANA_UNSUPPORTED_TARGET",
      `osd hana: there is no ${SIDECAR_NAME} for ${target}. ` +
      `The pinned release covers ${SIDECAR_TARGETS.join(", ")}; ` +
      `a ${target} machine is not mapped to any of them. ` +
      `Run osd hana from one of those machines, or set OSD_HANA_DUMP to a binary you built for ${target} ` +
      `(it then runs only with --allow-unpinned-sidecar, announced as unpinned).`);
  }
  return target;
}

/** Where a platform package keeps its binary for `target`. */
function bundledSidecarPath(extensionPath, target) {
  return path.join(extensionPath, "bin", target, sidecarFileName(target));
}

/** The bundled binary for this machine: {target, path}. A universal
 *  install (no bin/<target>/) is OSD_HANA_NO_SIDECAR with the two ways on;
 *  an unsupported machine is OSD_HANA_UNSUPPORTED_TARGET. */
function findBundledSidecar(extensionPath, {platform = process.platform, arch = process.arch, exists = fs.existsSync} = {}) {
  const target = sidecarTarget(platform, arch);
  const file = bundledSidecarPath(extensionPath, target);
  if (!exists(file)) {
    throw new HanaSidecarError("OSD_HANA_NO_SIDECAR",
      `osd hana: this install of the extension carries no ${SIDECAR_NAME} (it is the universal package). ` +
      `Install the ${target} package of the same release (open-steamgate-${target}-<version>.vsix), ` +
      `or set OSD_HANA_DUMP to the ${sidecarFileName(target)} of the release pinned in ` +
      `tools/osd-hana/sidecar.lock.json -- osd hana checks its SHA-256 either way. Nothing is downloaded.`);
  }
  return {target, path: file};
}

/** A file unpacked from a zip may arrive without its execute bits (an
 *  installer that drops the archive's modes). On POSIX, make it 0755 when
 *  any execute bit is missing; on Windows there is nothing to do. Returns
 *  whether it changed the mode. */
function ensureExecutable(file, {platform = process.platform, stat = fs.statSync, chmod = fs.chmodSync} = {}) {
  if (platform === "win32") return false;
  const mode = stat(file).mode & 0o777;
  if ((mode & 0o111) === 0o111) return false;
  chmod(file, 0o755);
  return true;
}

/** What the extension hands the osd-hana module: the bundled binary's path,
 *  executable. The module verifies it (`callerPath`). OSD_HANA_DUMP, when
 *  set, wins in the module itself -- this function is not asked then. */
function resolveBundledSidecar(extensionPath, options = {}) {
  const found = findBundledSidecar(extensionPath, options);
  const madeExecutable = ensureExecutable(found.path, options);
  return {...found, madeExecutable};
}

/** The `callerPath` for doctorMain / the extract verb. OSD_HANA_DUMP set =
 *  the person chose a binary: undefined here, the module takes the
 *  variable (its own precedence) and verifies it. Otherwise the bundled
 *  binary, or the actionable error of findBundledSidecar. */
function callerPathFor(extensionPath, {env = process.env, ...options} = {}) {
  if (typeof env.OSD_HANA_DUMP === "string" && env.OSD_HANA_DUMP.trim() !== "") return undefined;
  return resolveBundledSidecar(extensionPath, options).path;
}

module.exports = {
  SIDECAR_NAME,
  callerPathFor,
  SIDECAR_TARGETS,
  HanaSidecarError,
  sidecarFileName,
  sidecarTarget,
  bundledSidecarPath,
  findBundledSidecar,
  ensureExecutable,
  resolveBundledSidecar,
};
