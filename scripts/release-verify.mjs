#!/usr/bin/env node
// A release artefact is checked by what it contains and what it does, never
// by the exit code of the command that built it (CLAUDE.md, "Verify a built
// artefact by its code"). Three checks, one per thing a release carries that
// nothing else opened before it was published:
//
//   release-verify.mjs binary <file> <bun-target>
//       the file is an executable for that target (magic bytes and machine),
//       and its .sha256 sidecar is its digest
//   release-verify.mjs serve <file>
//       the binary, run as a user runs it (./osd up, outside any checkout,
//       with an empty data home), boots from its embedded seed, answers the
//       demo service's $metadata, names its generation, and serves this
//       checkout's source: the most recently changed ABAP file, read back
//       over ADT, byte for byte. A stale seed fails there.
//   release-verify.mjs pages <url> <commit> [--wait <seconds>]
//       a deployed preview's build.json names this commit, and its sw.js
//       carries the stamp build.json names (the CDN serves the new bundle,
//       not an old one); pages.yml runs it after each deploy
//
// The VSIX is already checked by content in release.yml (the version inside
// extension/package.json, scripts/release-version.mjs), and the Docker image
// by docker/image/smoke.sh before docker.yml publishes it.
import {execFileSync, spawn} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdtempSync, openSync, readSync, closeSync, readFileSync, rmSync, statSync, mkdirSync} from "node:fs";
import {report} from "../tools/osd-inputs.mjs";
import {assertPublicSystem} from "../tools/osd-system.mjs";
import {verifyPublicArtefact} from "../tools/osd-provenance.mjs";
import {createServer} from "node:net";
import {tmpdir} from "node:os";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ELF e_machine, Mach-O cputype, PE machine: what each release target must be
const TARGETS = {
  "bun-linux-x64-baseline": {format: "elf", machine: 0x3e},
  "bun-linux-arm64": {format: "elf", machine: 0xb7},
  "bun-darwin-arm64": {format: "macho", machine: 0x0100000c},
  "bun-darwin-x64-baseline": {format: "macho", machine: 0x01000007},
  "bun-windows-x64-baseline": {format: "pe", machine: 0x8664},
  "bun-windows-arm64": {format: "pe", machine: 0xaa64},
  "go-linux-amd64": {format: "elf", machine: 0x3e},
  "go-linux-arm64": {format: "elf", machine: 0xb7},
  "go-darwin-arm64": {format: "macho", machine: 0x0100000c},
  "go-darwin-amd64": {format: "macho", machine: 0x01000007},
  "go-windows-amd64": {format: "pe", machine: 0x8664},
  "go-windows-arm64": {format: "pe", machine: 0xaa64},
};

function head(file, length) {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(length);
    const read = readSync(fd, buffer, 0, length, 0);
    return buffer.subarray(0, read);
  } finally {
    closeSync(fd);
  }
}

/** The executable format and machine a file's header declares. */
export function executableOf(bytes) {
  if (bytes.length >= 20 && bytes.readUInt32BE(0) === 0x7f454c46) {
    // ELF: e_machine at 18, in the byte order EI_DATA names
    const machine = bytes[5] === 2 ? bytes.readUInt16BE(18) : bytes.readUInt16LE(18);
    return {format: "elf", machine};
  }
  if (bytes.length >= 8 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    return {format: "macho", machine: bytes.readUInt32LE(4)};
  }
  if (bytes.length >= 0x40 && bytes.toString("latin1", 0, 2) === "MZ") {
    const pe = bytes.readUInt32LE(0x3c);
    if (bytes.length >= pe + 6 && bytes.toString("latin1", pe, pe + 4) === "PE\0\0") {
      return {format: "pe", machine: bytes.readUInt16LE(pe + 4)};
    }
  }
  return {format: "unknown", machine: 0};
}

// What the release workflow runs on every binary before uploading it: the
// checkout it was built from must hold no private layer, installed or in the
// live generation (the OSGo binary compiles both in).
export function checkReleaseBinary(file, target, sourceRoot = root) {
  assertPublicSystem(sourceRoot);
  verifyPublicArtefact(file);
  return checkBinary(file, target);
}

export function checkBinary(file, target) {
  const want = TARGETS[target];
  if (want === undefined) throw new Error(`unknown release target ${target}`);
  const got = executableOf(head(file, 4096));
  if (got.format !== want.format || got.machine !== want.machine) {
    throw new Error(`${file} is ${got.format} machine 0x${got.machine.toString(16)}, ` +
      `not the ${want.format} machine 0x${want.machine.toString(16)} ${target} builds`);
  }
  const digest = createHash("sha256").update(readFileSync(file)).digest("hex");
  let sidecar;
  try {
    sidecar = readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0];
  } catch {
    throw new Error(`${file}.sha256 is missing`);
  }
  if (sidecar !== digest) throw new Error(`${file}.sha256 says ${sidecar}, the file is ${digest}`);
  return {file, target, bytes: statSync(file).size, sha256: digest};
}

const freePort = () => new Promise((done, fail) => {
  const server = createServer();
  server.unref();
  server.on("error", fail);
  server.listen(0, "127.0.0.1", () => {
    const {port} = server.address();
    server.close(() => done(port));
  });
});

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

// the ABAP source this checkout changed last that the system serves as it
// is on disk: the file a stale seed would get wrong first. A file renamed or
// deleted since, or hidden by a later layer (gen/, a pack), is not what the
// binary serves under that name, so the walk goes on to the next.
function newestAbap() {
  const hidden = new Set(report(undefined, {root}).clashes.flatMap((clash) => clash.hidden));
  const out = execFileSync("git", ["log", "-n", "200", "--format=", "--name-only", "--diff-filter=AM", "--",
    "src/*.clas.abap", "src/**/*.clas.abap", "src/*.prog.abap", "src/**/*.prog.abap"],
  {cwd: root, encoding: "utf8"}).split("\n").filter(Boolean);
  for (const file of out) {
    const match = /([^/]+)\.(clas|prog)\.abap$/.exec(file);
    if (match && !hidden.has(file) && existsSync(join(root, file))) return {file, name: match[1], kind: match[2]};
  }
  throw new Error("no ABAP class or program in this checkout's recent history is served as it is on disk");
}

// The ADT URL that serves an ABAP source file. abapGit names a file after
// its object with each "/" of a namespace written "#"
// (src/gateway/compat/#iwbep#cx_mgw_base_exception.clas.abap is
// /IWBEP/CX_MGW_BASE_EXCEPTION), so the name in the URL is the object's, "/"
// back in place, and the whole of it is one percent-encoded segment: the
// router splits the path before it decodes a segment.
export function adtSourcePath(file) {
  const match = /([^/]+)\.(clas|prog)\.abap$/.exec(file);
  if (!match) throw new Error(`${file} is not an ABAP class or program source`);
  const name = match[1].replaceAll("#", "/");
  const collection = match[2] === "clas" ? "oo/classes" : "programs/programs";
  return `/sap/bc/adt/${collection}/${encodeURIComponent(name)}/source/main`;
}

export async function checkServe(file, {timeoutSeconds = 600} = {}) {
  const port = await freePort();
  const scratch = mkdtempSync(join(tmpdir(), "osd-release-serve-"));
  const cwd = join(scratch, "cwd");
  mkdirSync(cwd);
  const log = [];
  const child = spawn(resolve(file), ["up"], {
    cwd,
    env: {...process.env, XDG_DATA_HOME: join(scratch, "data"), STG_PORT: String(port), OSD_BINARY_HOME: ""},
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (d) => log.push(String(d)));
  child.stderr.on("data", (d) => log.push(String(d)));
  let exited;
  child.on("exit", (code, signal) => { exited = {code, signal}; });
  // a path that cannot start is an answer, not an unhandled event
  child.on("error", (error) => { exited = {code: error.code ?? "error", signal: null}; log.push(String(error.message)); });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let metadata;
    while (Date.now() < deadline && exited === undefined) {
      try {
        const response = await fetch(`${base}/sap/opu/odata/sap/ZSTG_DEMO_SRV/$metadata`);
        if (response.ok) {
          metadata = {generation: response.headers.get("x-osd-generation"), text: await response.text()};
          break;
        }
      } catch {
        // not listening yet
      }
      await sleep(2000);
    }
    if (metadata === undefined) {
      throw new Error(`the binary did not answer within ${timeoutSeconds} s` +
        (exited ? ` (exited ${exited.code ?? exited.signal})` : "") + `\n${log.join("").slice(-2000)}`);
    }
    if (!/EntitySet Name="TravelSet"/.test(metadata.text)) {
      throw new Error("the demo service's $metadata has no TravelSet");
    }
    if (!/^[0-9a-f]{16}$/.test(metadata.generation ?? "")) {
      throw new Error(`no generation named in X-OSD-Generation (${metadata.generation})`);
    }
    const newest = newestAbap();
    const served = await fetch(`${base}${adtSourcePath(newest.file)}`);
    const text = await served.text();
    const expected = readFileSync(join(root, newest.file), "utf8");
    if (served.status !== 200 || text !== expected) {
      throw new Error(`the binary serves ${newest.file} ` +
        (served.status !== 200 ? `as ${served.status}` : "with other content") +
        ": its seed is not this checkout's source");
    }
    return {port, generation: metadata.generation, checked: newest.file};
  } finally {
    // our own child only
    if (exited === undefined) {
      child.kill("SIGTERM");
      for (let i = 0; i < 50 && exited === undefined; i++) await sleep(200);
      if (exited === undefined) child.kill("SIGKILL");
    }
    rmSync(scratch, {recursive: true, force: true});
  }
}

export async function checkPages(url, commit, {waitSeconds = 600} = {}) {
  const base = url.endsWith("/") ? url : `${url}/`;
  // the CDN keeps a file 10 min (max-age=600); a query of its own per try
  // asks it for the origin's copy rather than its cached one
  const fresh = (name) => fetch(new URL(`${name}?t=${Date.now()}`, base), {cache: "no-store"});
  const deadline = Date.now() + waitSeconds * 1000;
  let last = "";
  while (true) {
    try {
      const build = await (await fresh("build.json")).json();
      if (build.commit === commit) {
        const worker = await (await fresh("sw.js")).text();
        // the two files are cached apart: a mismatch may be the CDN catching
        // up, so it is retried until the deadline and only then an error
        if (worker.includes(build.stamp)) return {url: base, commit, stamp: build.stamp, buildId: build.buildId};
        last = `sw.js does not carry the stamp ${build.stamp} that build.json names`;
      } else {
        last = `build.json names ${build.commit}`;
      }
    } catch (error) {
      last = error.message;
    }
    if (Date.now() >= deadline) {
      throw new Error(`${base} does not serve ${commit} after ${waitSeconds} s: ${last}`);
    }
    await sleep(10000);
  }
}

const isMain = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  const option = (name, fallback) => {
    const at = args.indexOf(name);
    return at < 0 ? fallback : Number(args[at + 1]);
  };
  try {
    let result;
    if (command === "binary" && args.length >= 2) result = checkReleaseBinary(args[0], args[1]);
    else if (command === "serve" && args.length >= 1) result = await checkServe(args[0], {timeoutSeconds: option("--timeout", 600)});
    else if (command === "pages" && args.length >= 2) result = await checkPages(args[0], args[1], {waitSeconds: option("--wait", 600)});
    else {
      console.error("usage: release-verify.mjs binary <file> <target> | serve <file> [--timeout s] | pages <url> <commit> [--wait s]");
      process.exit(2);
    }
    console.log(`release-verify ${command}: ok ${JSON.stringify(result)}`);
  } catch (error) {
    console.error(`release-verify ${command}: ${error.message}`);
    process.exit(["PRIVATE_LAYER", "BAD_PROVENANCE"].includes(error.code) ? 2 : 1);
  }
}
