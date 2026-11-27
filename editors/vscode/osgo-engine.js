"use strict";
// `osd.engine: "osgo"` (ADR 0010 slice 8, docs/vscode-extension.md
// "Engine"): the extension runs the Go executable of a release instead of
// `node test/run.mjs`. The executable is never in the .vsix (six platforms
// of about 85 MB each): it is downloaded once from the release tag the
// extension was built with, checked against the `.sha256` beside it
// (docs/osgo-release.md), and kept in the extension's global storage, where
// the next start re-uses it after checking it again. Everything here is
// pure or takes its I/O as an option, so test/vscode-launcher.mjs drives it
// against a local HTTP server and a stub executable.
const {createHash, randomBytes} = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");
const path = require("node:path");

const RELEASE_BASE = "https://github.com/oisee/open-steamgate/releases/download";

// process.platform-process.arch -> the asset name release.yml uploads
const ASSETS = {
  "linux-x64": "osgo-linux-x64",
  "linux-arm64": "osgo-linux-arm64",
  "darwin-arm64": "osgo-darwin-arm64",
  "darwin-x64": "osgo-darwin-x64",
  "win32-x64": "osgo-windows-x64.exe",
  "win32-arm64": "osgo-windows-arm64.exe",
};

const ENGINES = ["node", "osgo"];

/** An error a person can act on. `code` is one of OSGO_NO_ASSET,
 *  OSGO_NOT_RELEASED, OSGO_NETWORK, OSGO_HTTP, OSGO_CHECKSUM, OSGO_DATABASE;
 *  the launcher's classify() turns any of them into the "osgo" issue. */
class OsgoEngineError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OsgoEngineError";
    this.code = code;
  }
}

function engineOf(value) {
  return ENGINES.includes(value) ? value : "node";
}

/** The release asset for this machine, or OSGO_NO_ASSET. */
function osgoAssetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (asset === undefined) {
    throw new OsgoEngineError("OSGO_NO_ASSET",
      `osd.engine "osgo": there is no osgo release asset for ${platform}-${arch} ` +
      `(the releases carry ${Object.keys(ASSETS).join(", ")}); set osd.engine to "node"`);
  }
  return asset;
}

/** The tags to look in, in order: the setting's tag when one is set, else
 *  the prerelease tag of the extension's own version and then the stable
 *  one (release.yml tags one commit as vscode-v<version> or
 *  vscode-stable-v<version>; the version is stamped from that commit, so
 *  both carry the same executables). */
function releaseTagsFor(version, override) {
  if (typeof override === "string" && override.trim() !== "") {
    const tag = override.trim();
    if (!/^[A-Za-z0-9._-]+$/.test(tag)) {
      throw new OsgoEngineError("OSGO_NOT_RELEASED", `osd.osgo.releaseTag "${tag}" is not a tag name`);
    }
    return [tag];
  }
  if (!/^\d+\.\d+\.\d+$/.test(String(version ?? ""))) {
    throw new OsgoEngineError("OSGO_NOT_RELEASED",
      `osd.engine "osgo": this extension's version "${version}" is not a release version; set osd.osgo.releaseTag (e.g. vscode-v0.7.2382)`);
  }
  return [`vscode-v${version}`, `vscode-stable-v${version}`];
}

/** `<hex>  <name>` (sha256sum's line) -> the hex; the name, when there is
 *  one, must be the asset's. */
function parseSha256(text, asset) {
  const match = String(text).trim().match(/^([0-9a-fA-F]{64})(?:\s+\*?(\S+))?\s*$/m);
  if (!match) throw new OsgoEngineError("OSGO_CHECKSUM", `${asset}.sha256 is not a sha256sum line`);
  if (match[2] !== undefined && path.basename(match[2]) !== asset) {
    throw new OsgoEngineError("OSGO_CHECKSUM", `${asset}.sha256 names ${match[2]}, not ${asset}`);
  }
  return match[1].toLowerCase();
}

function sha256OfFile(file) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(file).on("data", (d) => hash.update(d)).on("error", reject)
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const NETWORK_CODES = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT",
  "ENETUNREACH", "EHOSTUNREACH", "ENETDOWN", "EPIPE", "ECONNABORTED", "OSGO_TIMEOUT"]);

/** GET `url`, following redirects (a release download is a 302 to a CDN);
 *  resolves the 200 response, or rejects with `status` set. */
function get(url, {signal, timeoutMs = 30000, redirects = 5} = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("download cancelled"), {code: "ABORT_ERR"}));
      return;
    }
    const lib = url.startsWith("https:") ? https : http;
    const req = lib.get(url, {headers: {"user-agent": "open-steamgate-vscode"}, signal}, (res) => {
      const status = res.statusCode ?? 0;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirects <= 0) {
          reject(Object.assign(new Error(`too many redirects at ${url}`), {status}));
          return;
        }
        get(new URL(res.headers.location, url).href, {signal, timeoutMs, redirects: redirects - 1}).then(resolve, reject);
        return;
      }
      if (status !== 200) {
        res.resume();
        reject(Object.assign(new Error(`HTTP ${status} for ${url}`), {status}));
        return;
      }
      resolve(res);
    });
    req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error(`no answer within ${timeoutMs} ms`), {code: "OSGO_TIMEOUT"})));
    req.on("error", reject);
  });
}

async function getText(url, options) {
  const res = await get(url, options);
  let body = "";
  res.setEncoding("utf8");
  for await (const chunk of res) {
    body += chunk;
    if (body.length > 4096) throw new OsgoEngineError("OSGO_CHECKSUM", `${url} is not a .sha256 file (too long)`);
  }
  return body;
}

/** Streams `url` into `file` (through a temporary name in the same folder,
 *  renamed into place only when the hash matches), returning the hex. */
async function downloadTo(url, file, expected, {signal, timeoutMs, log}) {
  const res = await get(url, {signal, timeoutMs});
  const total = Number(res.headers["content-length"]) || undefined;
  const part = `${file}.part-${process.pid}-${randomBytes(4).toString("hex")}`;
  const hash = createHash("sha256");
  let received = 0;
  let nextReport = 16 * 1024 * 1024;
  try {
    await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(part, {mode: 0o755});
      res.on("data", (d) => {
        hash.update(d);
        received += d.length;
        if (received >= nextReport) {
          nextReport += 16 * 1024 * 1024;
          log?.(`osgo: ${Math.round(received / 1048576)} MB${total ? ` of ${Math.round(total / 1048576)} MB` : ""}\n`);
        }
      });
      res.on("error", reject);
      out.on("error", reject);
      out.on("finish", resolve);
      res.pipe(out);
    });
    const actual = hash.digest("hex");
    if (actual !== expected) {
      throw new OsgoEngineError("OSGO_CHECKSUM",
        `osd.engine "osgo": the downloaded ${path.basename(file)} does not match its .sha256 ` +
        `(expected ${expected}, got ${actual}); it was not kept and is not run`);
    }
    if (process.platform !== "win32") fs.chmodSync(part, 0o755);
    fs.renameSync(part, file);
    return actual;
  } finally {
    fs.rmSync(part, {force: true});
  }
}

function asEngineError(error, what, url) {
  if (error instanceof OsgoEngineError) return error;
  if (error?.code === "ABORT_ERR" || error?.name === "AbortError") return error;
  if (NETWORK_CODES.has(error?.code)) {
    return new OsgoEngineError("OSGO_NETWORK",
      `osd.engine "osgo": could not download ${what} (${error.code}: ${error.message}) -- no network? ` +
      `The first start with osgo needs ${new URL(url).host}; later starts re-use the verified copy, ` +
      `and osd.engine "node" needs no download at all`);
  }
  return new OsgoEngineError("OSGO_HTTP", `osd.engine "osgo": could not download ${what} from ${url}: ${error?.message ?? error}`);
}

/** The verified executable for this machine, downloading it first when the
 *  cache has none (or one that no longer matches its .sha256). Resolves
 *  `{binary, tag, asset, sha256, downloaded}`.
 *
 *  options: storageDir (the extension's global storage), version (the
 *  extension's own), releaseTag (osd.osgo.releaseTag), baseUrl (tests),
 *  platform/arch (tests), signal, log. */
async function ensureOsgoBinary(options = {}) {
  const {storageDir, version, releaseTag, baseUrl = RELEASE_BASE, signal, log, timeoutMs} = options;
  if (typeof storageDir !== "string" || storageDir === "") throw new Error("storageDir is required");
  const asset = osgoAssetFor(options.platform, options.arch);
  const tags = releaseTagsFor(version, releaseTag);

  // a copy downloaded before, checked again: the file in storage is
  // writable by anything that runs as this user
  for (const tag of tags) {
    const dir = path.join(storageDir, "osgo", tag);
    const binary = path.join(dir, asset);
    const sumFile = `${binary}.sha256`;
    if (!fs.existsSync(binary) || !fs.existsSync(sumFile)) continue;
    let expected;
    try { expected = parseSha256(fs.readFileSync(sumFile, "utf8"), asset); } catch { continue; }
    if (await sha256OfFile(binary) === expected) {
      log?.(`osgo: using ${tag}/${asset} (sha256 ${expected.slice(0, 12)}, verified)\n`);
      return {binary, tag, asset, sha256: expected, downloaded: false};
    }
    log?.(`osgo: the kept ${tag}/${asset} no longer matches its .sha256; downloading it again\n`);
    fs.rmSync(binary, {force: true});
  }

  let lastMissing;
  for (const tag of tags) {
    const base = `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(tag)}`;
    const sumUrl = `${base}/${asset}.sha256`;
    let expected;
    try {
      expected = parseSha256(await getText(sumUrl, {signal, timeoutMs}), asset);
    } catch (error) {
      if (error?.status === 404) {
        lastMissing = tag;
        continue;
      }
      throw asEngineError(error, `${asset}.sha256`, sumUrl);
    }
    const dir = path.join(storageDir, "osgo", tag);
    fs.mkdirSync(dir, {recursive: true});
    const binary = path.join(dir, asset);
    const url = `${base}/${asset}`;
    log?.(`osgo: downloading ${asset} from release ${tag}\n`);
    try {
      await downloadTo(url, binary, expected, {signal, timeoutMs, log});
    } catch (error) {
      if (error?.status === 404) {
        throw new OsgoEngineError("OSGO_NOT_RELEASED", `osd.engine "osgo": release ${tag} has ${asset}.sha256 but not ${asset}`);
      }
      throw asEngineError(error, asset, url);
    }
    // the .sha256 goes in after the executable, so a kept pair is complete
    fs.writeFileSync(`${binary}.sha256`, `${expected}  ${asset}\n`);
    log?.(`osgo: ${tag}/${asset} downloaded and verified (sha256 ${expected.slice(0, 12)})\n`);
    return {binary, tag, asset, sha256: expected, downloaded: true};
  }
  throw new OsgoEngineError("OSGO_NOT_RELEASED",
    `osd.engine "osgo": no release ${tags.join(" or ")} with ${asset} ` +
    `(${lastMissing === undefined ? "" : "not found; "}a development build has no release of its own: set osd.osgo.releaseTag, or osd.engine "node")`);
}

/** The command line the launcher starts (docs/osgo-release.md):
 *  `<binary> -port N -root <tree> -home <dir> -adt`. */
function osgoArgs({port, root, home}) {
  return ["-port", String(port), "-root", root, "-home", home, "-adt"];
}

module.exports = {
  RELEASE_BASE, ASSETS, ENGINES, OsgoEngineError,
  engineOf, osgoAssetFor, releaseTagsFor, parseSha256, sha256OfFile, ensureOsgoBinary, osgoArgs,
};
