#!/usr/bin/env node
// BUILD-time fetcher for the pinned `osd-hana-dump` sidecar
// (tools/osd-hana/fetch-sidecar.mjs):
//
//   node tools/osd-hana/fetch-sidecar.mjs --target linux-x64 --out <dir>
//   node tools/osd-hana/fetch-sidecar.mjs --all --out <dir>
//
// Downloads the pinned release asset for a target from the release URL in
// tools/osd-hana/sidecar.lock.json, verifies SHA-256 against THAT PIN (never
// against a downloaded checksum file -- the pin is what this repo stands
// behind), and writes it atomically (temp file + rename) as
// `<out>/<target>/osd-hana-dump[.exe]` with mode 0755.
//
// This is a BUILD tool, deliberately not part of the runtime:
//   - nothing here runs at import time (the main block is the only runner);
//   - no `osd hana` verb imports this module -- the runtime locates and
//     verifies a binary that is already on disk (sidecar.mjs "locate");
//     the packaging job (the VS Code extension per target) calls this script
//     at build time and bundles its output;
//   - no new dependency: node's own fetch, manual redirects.
//
// Host rules: the fetch goes to the pin's release URL and nowhere else;
// every hop (the first request and each redirect) must land on an allowed
// host -- GitHub and GitHub's asset hosts. A redirect off that list is
// refused before it is followed. `http://` is refused except on the loopback,
// which exists for the tests (a local server, the URL base injected through
// the pin seam).
//
// Caching: a file already on disk with the pin's hash for this target is
// kept and NO request is made. `--offline` refuses to download (a cached
// hit still succeeds). A hash mismatch deletes the temp file, exits
// non-zero and names both hashes -- a bad download never reaches the output
// path.
import {createHash} from "node:crypto";
import {createWriteStream} from "node:fs";
import {chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, unlinkSync} from "node:fs";
import {join} from "node:path";
import {pipeline} from "node:stream/promises";
import {Readable} from "node:stream";
import {fileURLToPath} from "node:url";
import {loadPin, SIDECAR_NAME} from "./sidecar.mjs";
import {compiled} from "../osd-host.mjs";

export const DEFAULT_PIN_PATH = fileURLToPath(new URL("./sidecar.lock.json", import.meta.url));

// Where a release asset may travel: the pin's release host plus GitHub's
// asset hosts (a release download redirects from github.com onto one of
// these). Anything else -- including a redirect -- is refused under its own
// host name.
const GITHUB_ASSET_HOSTS = ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"];
const MAX_REDIRECTS = 8;

export class FetchError extends Error {}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "::1" || hostname === "[::1]" || /^127\./.test(hostname);
}

/** The asset file name on disk for a target: the Go binary's own name,
 *  `.exe` on Windows. */
export function outputName(target) {
  return target === "win32-x64" ? `${SIDECAR_NAME}.exe` : SIDECAR_NAME;
}

/** The URL the pin names for this target (pin.release.base_url + "/" + the
 *  asset name). A target the pin does not cover -- or one with no release
 *  entry -- is refused under its own name, never mapped to another target. */
export function releaseUrl(pin, target) {
  const targets = pin?.targets ?? {};
  const assets = pin?.release?.assets ?? {};
  if (!(target in targets) || !(target in assets)) {
    throw new FetchError(`fetch-sidecar: no pinned release asset for target "${target}".\n` +
      `  The pin (${pin?.version ?? "?"}) covers: ${Object.keys(targets).join(", ")}.`);
  }
  return `${pin.release.base_url.replace(/\/$/, "")}/${assets[target]}`;
}

function checkUrl(urlString, allowedHosts) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    throw new FetchError(`fetch-sidecar: not a URL: ${urlString}`);
  }
  if (url.protocol === "http:" && !isLoopbackHost(url.hostname)) {
    throw new FetchError(`fetch-sidecar: refusing an insecure URL (http is only ever allowed on the loopback for tests): ${url.origin}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new FetchError(`fetch-sidecar: refusing a non-HTTP(S) URL: ${url.origin}`);
  }
  if (!allowedHosts.includes(url.hostname)) {
    throw new FetchError(`fetch-sidecar: refusing host "${url.hostname}" -- it is not on the allowlist (${allowedHosts.join(", ")}).\n` +
      `  The sidecar is fetched from the pin's release URL and GitHub's asset hosts only.`);
  }
  return url;
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** Download, verify and place one target. Returns
 *  {path, sha256, cached, bytes} -- cached=true says the file was already
 *  on disk with the right hash and no request was made. */
export async function fetchSidecar({
  target,
  outDir,
  pin = loadPin(),
  offline = false,
  fetchFn = fetch,
  log = () => {},
  allowedHosts,
} = {}) {
  if (typeof outDir !== "string" || outDir.trim() === "") {
    throw new FetchError("fetch-sidecar: --out <dir> is required (the directory to place the binary in)");
  }
  const url = new URL(releaseUrl(pin, target)); // unknown target -> refusal, before anything else
  const hosts = allowedHosts ?? [...new Set([...GITHUB_ASSET_HOSTS, url.hostname])];
  const outPath = join(outDir, target, outputName(target));

  // Cached: an existing file with the pin's hash is kept, no network.
  if (existsSync(outPath)) {
    const actual = sha256File(outPath);
    if (actual === pin.targets[target]) {
      log(`fetch-sidecar: ${outPath} already has the pinned hash for ${target} (${pin.version}) -- keeping it, no request made.`);
      return {path: outPath, sha256: actual, cached: true, bytes: statSync(outPath).size};
    }
    log(`fetch-sidecar: ${outPath} exists but its hash is not the pin's -- fetching ${pin.version} again.`);
  }

  if (offline) {
    throw new FetchError(`fetch-sidecar: --offline and no cached binary with the pinned hash at ${outPath} -- refusing to download.`);
  }

  mkdirSync(join(outDir, target), {recursive: true});
  const tempPath = `${outPath}.${process.pid}.tmp`;
  rmSync(tempPath, {force: true});
  try {
    const {bytes} = await downloadTo(url, tempPath, {hosts, fetchFn});
    const actual = sha256File(tempPath);
    if (actual !== pin.targets[target]) {
      // The bad bytes never reach the output path: temp deleted, both
      // hashes named, non-zero exit (FetchError -> main returns 1).
      throw new FetchError(`fetch-sidecar: refusing the download for ${target}: SHA-256 mismatch.\n` +
        `  pinned (${target}, ${pin.version}): ${pin.targets[target]}\n` +
        `  downloaded            : ${actual}\n` +
        `  The file was deleted; nothing was written to ${outPath}.`);
    }
    chmodSync(tempPath, 0o755);
    renameSync(tempPath, outPath); // same directory: atomic
    log(`fetch-sidecar: ${target} -> ${outPath} (${bytes} bytes, sha256 ${actual}, pinned ${pin.version}).`);
    return {path: outPath, sha256: actual, cached: false, bytes};
  } catch (error) {
    rmSync(tempPath, {force: true}); // a failure of any kind leaves no temp file behind
    throw error;
  }
}

// One HTTP(S) fetch with manual redirect handling: every hop is checked
// against the allowlist BEFORE it is followed, and the body streams straight
// to the temp file (a 7 MB binary is not held in memory). A body that ends
// short of its promised Content-Length is a truncated download -- refused,
// the hash check would catch it too, but the error should say what happened.
async function downloadTo(url, tempPath, {hosts, fetchFn}) {
  let current = url;
  for (let hops = 0; hops <= MAX_REDIRECTS; hops++) {
    checkUrl(current.href, hosts);
    const response = await fetchFn(current, {redirect: "manual"});
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location === null) {
        throw new FetchError(`fetch-sidecar: ${current.origin} answered ${response.status} with no Location header`);
      }
      current = new URL(location, current);
      continue;
    }
    if (!response.ok) {
      throw new FetchError(`fetch-sidecar: the release answered ${response.status} ${response.statusText} for ${current.href}`);
    }
    const promised = response.headers.get("content-length");
    let bytes;
    try {
      await pipeline(Readable.fromWeb(response.body), createWriteStream(tempPath, {flags: "wx", mode: 0o644}));
    } catch (error) {
      // a body cut mid-flight surfaces here (undici: "terminated"); whatever
      // arrived is incomplete -- refused under that name, the hash check
      // would refuse it too but should not have to explain it
      throw new FetchError(`fetch-sidecar: the download was interrupted or truncated (${error.message}) -- refusing it.`);
    }
    bytes = statSync(tempPath).size;
    if (promised !== null && Number(promised) !== bytes) {
      throw new FetchError(`fetch-sidecar: the download was truncated (${bytes} of ${promised} bytes arrived) -- refusing it.`);
    }
    return {bytes};
  }
  throw new FetchError(`fetch-sidecar: more than ${MAX_REDIRECTS} redirects -- refusing to follow`);
}

// ------------------------------------------------------------------ the CLI

export function parseArgs(argv) {
  const args = {targets: [], out: undefined, offline: false, help: false};
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === "--target") {
      const value = argv[++i];
      if (value === undefined) throw new FetchError("fetch-sidecar: --target needs a value (e.g. --target linux-x64)");
      args.targets.push(value);
    } else if (flag === "--out") {
      args.out = argv[++i];
      if (args.out === undefined) throw new FetchError("fetch-sidecar: --out needs a directory");
    } else if (flag === "--all") {
      args.all = true;
    } else if (flag === "--offline") {
      args.offline = true;
    } else if (flag === "--help" || flag === "-h") {
      args.help = true;
    } else {
      throw new FetchError(`fetch-sidecar: unknown argument "${flag}" -- see --help`);
    }
  }
  return args;
}

const HELP = `Usage: node tools/osd-hana/fetch-sidecar.mjs --target <t> --out <dir>
       node tools/osd-hana/fetch-sidecar.mjs --all --out <dir>

Downloads the pinned ${SIDECAR_NAME} release asset for a target from the
release URL in tools/osd-hana/sidecar.lock.json, verifies SHA-256 against the
pin, and writes <dir>/<target>/osd-hana-dump[.exe] (mode 0755, atomic).
A file already on disk with the pinned hash is kept without a request.

  --target <t>   one of the pin's targets (repeatable)
  --all          every target the pin covers
  --out <dir>    output directory (required)
  --offline      refuse to download; only a cached hit succeeds
  --help         this text

This is a BUILD tool (the packaging job bundles its output); the osd hana
verbs never download anything at runtime.`;

/** The script's entry. Returns an exit code (0 / 1); the main block turns it
 *  into process.exitCode. `deps` is the test seam: the pin (with its release
 *  base URL -- the tests point it at a local server), the fetch function and
 *  the log sink are injectable without any CLI flag. */
export async function main(argv, deps = {}) {
  const out = deps.out ?? ((line) => process.stdout.write(`${line}\n`));
  const err = deps.err ?? ((line) => process.stderr.write(`${line}\n`));
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    err(`${error.message}\n`);
    return 1;
  }
  if (args.help) {
    out(HELP);
    return 0;
  }
  const pin = deps.pin ?? loadPin();
  const targets = args.all ? Object.keys(pin.targets) : args.targets;
  if (targets.length === 0) {
    err("fetch-sidecar: give --target <t> (or --all) and --out <dir>\n");
    return 1;
  }
  if (args.out === undefined) {
    err("fetch-sidecar: --out <dir> is required\n");
    return 1;
  }
  let failed = false;
  for (const target of targets) {
    try {
      await fetchSidecar({target, outDir: args.out, pin, offline: args.offline, fetchFn: deps.fetchFn, log: out, allowedHosts: deps.allowedHosts});
    } catch (error) {
      failed = true;
      err(`${error.message}\n`);
    }
  }
  return failed ? 1 : 0;
}

// A tool run directly -- and only then: importing this module runs nothing.
// In the compiled osd binary every bundled module shares the entry's
// import.meta.url, so this guard would fire on import there (CLAUDE.md, the
// binary's traps): compiled, bin/osd.mjs is the only way in.
if (!compiled && process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exitCode = await main(process.argv.slice(2));
}
