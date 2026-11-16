// Sidecar handling for `osd hana` (tools/osd-hana/): locate, verify, handshake,
// run the Go binary `osd-hana-dump` (contract W0, frozen; README of the binary:
// github.com/oisee/vibing-steampunk, branch feat/hana-dump, cmd/osd-hana-dump).
//
// The four rules this module exists for:
//
//   locate    OSD_HANA_DUMP (explicit path) > a path the caller handed in (the
//             extension passes its bundled binary) > a clear error that says how
//             to get it. No download lives here.
//   verify    before every first use in a process, SHA-256 of the file against
//             tools/osd-hana/sidecar.lock.json (version, commit, per-target
//             hashes). Mismatch = refuse and name both hashes. An explicit path
//             outside the pin is allowed only with --allow-unpinned-sidecar and
//             is announced loudly.
//   handshake --version --json must say schema 1, read_only true, and carry the
//             capabilities the verb needs; otherwise refuse and name what is
//             missing.
//   run       credentials reach the child only through its environment
//             (OSD_HANA_USER / OSD_HANA_PASSWORD) -- never argv, never a file.
//             Child stderr passes through a redactor; stdout's one JSON line is
//             parsed; exit codes 0-5 map to the contract's named outcomes; a
//             timeout kills the child. spawn() with an argument array, no shell.
import {createHash} from "node:crypto";
import {spawn} from "node:child_process";
import {existsSync, readFileSync} from "node:fs";
import {extname, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {makeRedactor} from "./redact.mjs";

export const SIDECAR_NAME = "osd-hana-dump";

// Exit codes exactly as the frozen contract (W0) lists them.
export const EXIT_OUTCOMES = Object.freeze({
  0: "done",
  1: "usage",
  2: "connection",
  3: "partial",
  4: "refused",
  5: "unsupported",
});

export const DEFAULT_PIN_PATH = fileURLToPath(new URL("./sidecar.lock.json", import.meta.url));

export function loadPin(path = DEFAULT_PIN_PATH) {
  let raw;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new Error(`osd-hana: cannot read the sidecar pin file ${path}: ${error.message}`);
  }
  const pin = JSON.parse(raw);
  if (typeof pin.version !== "string" || typeof pin.commit !== "string" || typeof pin.targets !== "object") {
    throw new Error(`osd-hana: the sidecar pin file ${path} has no version/commit/targets`);
  }
  return pin;
}

// The pin is keyed the way Node names platforms: linux-x64, linux-arm64,
// darwin-x64, darwin-arm64, win32-x64. Naming is honest (critic note): no
// collapsing every Windows arch to win32-x64 -- win32-arm64 gets its own
// name, is found in no pin, and is refused under that name; a combination
// this line never ships is 'unknown'.
const PLAUSIBLE_TARGETS = {linux: ["x64", "arm64"], darwin: ["x64", "arm64"], win32: ["x64", "arm64"]};
const PINNED_TARGETS = ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"];

export function targetKey(platform = process.platform, arch = process.arch) {
  if (!PLAUSIBLE_TARGETS[platform]?.includes(arch)) return undefined;
  return `${platform}-${arch}`;
}

// Kept for the pin-entry readers: which of the honest keys the pin covers.
export function isPinnedTarget(key) {
  return PINNED_TARGETS.includes(key);
}

/** Where the sidecar binary is. `callerPath` is what the embedding host hands
 *  in (the VS Code extension passes its bundled binary); OSD_HANA_DUMP wins
 *  over it, because an explicit choice is the strongest one. Neither present
 *  is a clear refusal that says how to get the binary -- this job ships no
 *  download. On Windows a path with no extension resolves to the existing
 *  `<path>.exe` (the real name of the Go binary; spawn would need it). */
export function locateSidecar({env = process.env, callerPath, platform = process.platform, exists = existsSync} = {}) {
  const pick = (candidate) => {
    if (typeof candidate !== "string" || candidate.trim() === "") return undefined;
    const resolved = resolve(candidate);
    if (platform === "win32" && extname(resolved) === "" && exists(`${resolved}.exe`)) {
      return `${resolved}.exe`;
    }
    return resolved;
  };
  const explicit = pick(env.OSD_HANA_DUMP);
  if (explicit !== undefined) return explicit;
  const handed = pick(callerPath);
  if (handed !== undefined) return handed;
  throw new Error(
    `osd hana: the sidecar binary ${SIDECAR_NAME} was not found.\n` +
    `  Set OSD_HANA_DUMP to the path of the ${SIDECAR_NAME} binary, or pass its path to the caller\n` +
    `  that starts osd hana (the osd extension bundles it).\n` +
    `  There is no download: get the binary from the osd-hana-dump release of the extension you use.`);
}

// Verified once per process per path ("verify before every first use in a
// process"): path -> {sha256, pinned, target}. Tests reset it.
const verifiedInProcess = new Map();
export function resetVerifiedSidecars() {
  verifiedInProcess.clear();
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** SHA-256 against the pin. A file that is not in the pin at all is "unpinned";
 *  a file whose hash differs from the pin's hash for this target is a
 *  "mismatch" and is refused outright -- naming both hashes -- even with
 *  --allow-unpinned-sidecar, because that flag says "I know what I am running",
 *  and a mismatch says the opposite.
 *
 *  `fresh: true` skips the per-process cache and hashes again -- the re-check
 *  immediately before a spawn (critic S-3): no gap between the verified bytes
 *  and the executed bytes. The binary is ~7 MB, so a re-read is milliseconds;
 *  that is the whole cost of closing the window in which a swapped file would
 *  otherwise run under a cached "pinned: true". */
export async function verifySidecar(path, {
  pin = loadPin(),
  allowUnpinned = false,
  platform = process.platform,
  arch = process.arch,
  loud = (line) => process.stderr.write(line),
  digest = sha256File,
  fresh = false,
} = {}) {
  const cached = fresh ? undefined : verifiedInProcess.get(path);
  if (cached !== undefined) return cached;
  const target = targetKey(platform, arch);
  const expected = target === undefined ? undefined : pin.targets[target];
  let actual;
  try {
    actual = digest(path);
  } catch (error) {
    throw new SidecarVerifyError(`osd-hana: cannot read the sidecar at ${path}: ${error.message}`);
  }
  let result;
  if (expected !== undefined && expected === actual) {
    result = {path, sha256: actual, pinned: true, target};
  } else if (expected === undefined || pin.targets[target] === undefined) {
    if (!allowUnpinned) {
      throw new SidecarVerifyError(`osd-hana: the sidecar at ${path} is not covered by the pin file\n` +
        `  (no pinned hash for target ${target ?? "unknown"}). Refusing.\n` +
        `  The pinned ${SIDECAR_NAME} is ${pin.version} (${pin.commit.slice(0, 7)}).\n` +
        `  To run an unpinned sidecar deliberately, pass --allow-unpinned-sidecar.`);
    }
    result = {path, sha256: actual, pinned: false, target};
    loud(`osd-hana: WARNING -- running an UNPINNED sidecar at ${path} (sha256 ${actual}, target ${target ?? "unknown"}).\n` +
      `  It is not the pinned ${SIDECAR_NAME} ${pin.version}; its output is not covered by any checksum.\n`);
  } else {
    throw new SidecarVerifyError(`osd-hana: refusing the sidecar at ${path}: checksum mismatch.\n` +
      `  pinned (${target}): ${expected}\n` +
      `  actual         : ${actual}\n` +
      `  The binary on disk is not the pinned ${SIDECAR_NAME} ${pin.version}. Get the pinned build,\n` +
      `  or pass a different OSD_HANA_DUMP. Nothing was run.`);
  }
  verifiedInProcess.set(path, result);
  return result;
}

export class HandshakeError extends Error {}

// A verification refusal (checksum mismatch, unpinned without the flag, unreadable
// file) -- a setup failure, so the doctor maps it to exit 1, not 'cannot connect'.
export class SidecarVerifyError extends Error {}

/** `--version --json`, then the three questions: schema 1? read_only? does it
 *  carry the capabilities this verb needs? A pinned binary additionally has to
 *  say the pinned version and commit -- the hash and the self-description must
 *  agree. */
export async function handshake(path, {
  requiredCapabilities = [],
  pin,
  env = process.env,
  extraEnv,
  runFn = runSidecarRaw,
} = {}) {
  let line;
  try {
    const answer = await runFn(path, ["--version", "--json"], {env, extraEnv});
    // The real runner resolves {code, stdout, stderr}; an injected one may
    // hand over the line itself.
    line = typeof answer === "string" ? answer : answer.stdout;
  } catch (error) {
    throw new HandshakeError(`osd-hana: ${SIDECAR_NAME} at ${path} did not answer --version --json: ${error.message}`);
  }
  let info;
  try {
    info = JSON.parse(line);
  } catch {
    throw new HandshakeError(`osd-hana: ${SIDECAR_NAME} at ${path} printed no JSON version document: ${String(line).slice(0, 200)}`);
  }
  const missing = [];
  if (info.schema !== 1) missing.push(`schema 1 (got ${JSON.stringify(info.schema)})`);
  if (info.read_only !== true) missing.push(`read_only: true (got ${JSON.stringify(info.read_only)})`);
  const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
  const absent = requiredCapabilities.filter((c) => !capabilities.includes(c));
  if (absent.length > 0) missing.push(`capability: ${absent.join(", ")}`);
  if (pin !== undefined && (info.version !== pin.version || info.commit !== pin.commit)) {
    missing.push(`pinned version ${pin.version} / commit ${pin.commit.slice(0, 7)} (it says ${info.version} / ${String(info.commit ?? "?").slice(0, 7)})`);
  }
  if (missing.length > 0) {
    throw new HandshakeError(`osd-hana: refusing the sidecar at ${path} -- the handshake failed:\n  - ${missing.join("\n  - ")}`);
  }
  return info;
}

// One child run: [path, ...args], no shell, credentials in the environment
// only. Resolves with {code, stdout, stderr}.
//
// The child's environment is MINIMAL, by rule (critic S-2): an allowlist of
// operational variables plus the two credential variables -- never the
// parent's whole environment, where a shell may hold cloud keys, tokens or
// another system's HANA_PASSWORD. The sidecar README (cmd/osd-hana-dump, vsp
// branch feat/hana-dump) names no proxy or SSL variables and the binary's
// source reads only OSD_HANA_USER / OSD_HANA_PASSWORD, so none are forwarded;
// if a future build documents one, it enters this list by name.
const CHILD_ENV_ALLOWLIST = ["PATH", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "SystemRoot", "LANG"];
const LC_PATTERN = /^LC_/;

function minimalChildEnv(env, {credentials, extraEnv}) {
  const childEnv = {};
  for (const key of CHILD_ENV_ALLOWLIST) {
    if (typeof env[key] === "string" && env[key] !== "") childEnv[key] = env[key];
  }
  for (const key of Object.keys(env)) {
    if (LC_PATTERN.test(key)) childEnv[key] = env[key];
  }
  if (credentials !== undefined) {
    // The contract's only channel: environment, never argv, never a temp file.
    if (credentials.user !== undefined) childEnv.OSD_HANA_USER = credentials.user;
    if (credentials.password !== undefined) childEnv.OSD_HANA_PASSWORD = credentials.password;
  }
  if (extraEnv !== undefined) {
    // The test/extension seam: the doctor never passes this, the tests use it
    // to hand the FAKE sidecar its scenario knobs.
    Object.assign(childEnv, extraEnv);
  }
  return childEnv;
}

// The contract promises one JSON line on stdout; a chatty or hostile sidecar
// is capped anyway -- accumulated child output beyond this is stopped with a
// clear error, not held in memory until the timeout (critic note).
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;

export function runSidecarRaw(path, args, {
  env = process.env,
  credentials,
  timeoutMs = 60_000,
  onStderr,
  extraEnv,
} = {}) {
  const childEnv = minimalChildEnv(env, {credentials, extraEnv});
  const redact = makeRedactor([
    credentials?.password, credentials?.user, credentials?.host, credentials?.schema,
  ]);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(path, args, {
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false, // an argument array and no shell, by rule
    });
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    const settle = (error, result) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      if (error !== undefined) reject(error);
      else resolvePromise(result);
    };
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        child.kill("SIGKILL");
        settle(new Error(`osd-hana: ${SIDECAR_NAME} did not finish within ${timeoutMs} ms and was stopped (args: ${args.join(" ")})`));
      }, timeoutMs)
      : undefined;
    const take = (chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > MAX_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        settle(new Error(`osd-hana: ${SIDECAR_NAME} produced more than ${MAX_OUTPUT_BYTES} bytes (8 MB) of output and was stopped`));
        return undefined;
      }
      return chunk;
    };
    child.stdout.on("data", (chunk) => {
      const kept = take(chunk);
      if (kept !== undefined) stdout += kept;
    });
    child.stderr.on("data", (chunk) => {
      const kept = take(chunk);
      if (kept === undefined) return;
      const text = redact(kept.toString("utf8"));
      stderr += text;
      if (onStderr !== undefined) onStderr(text);
    });
    child.on("error", (error) => {
      settle(new Error(`osd-hana: cannot start ${path}: ${error.message}`));
    });
    child.on("close", (code) => {
      settle(undefined, {code: code ?? -1, stdout, stderr});
    });
  });
}

export class SidecarRunError extends Error {
  constructor(message, {exit, outcome, summary, stderr} = {}) {
    super(message);
    this.exit = exit;
    this.outcome = outcome;
    this.summary = summary;
    this.stderr = stderr;
  }
}

/** A verified, hand-shaken sidecar that one CLI run talks to. The context
 *  carries the credentials of the run; every child gets them only through its
 *  environment, and every byte the child writes passes through the redactor
 *  (password, user, host, schema masked): stderr because a progress or error
 *  line may repeat a connection value, stdout because a buggy or unpinned
 *  binary that repeats a credential in its JSON answer must not get it echoed
 *  by us (critic S-1). stdout must be the one JSON line the contract
 *  promises; anything else is an error, not a guess. */
export class Sidecar {
  constructor(path, {credentials, timeoutMs = 120_000, onStderr, env = process.env, extraEnv, beforeSpawn} = {}) {
    this.path = path;
    this.credentials = credentials;
    this.timeoutMs = timeoutMs;
    this.onStderr = onStderr;
    this.env = env;
    this.extraEnv = extraEnv;
    this.beforeSpawn = beforeSpawn;
  }

  /** Returns {exit, outcome, summary} where outcome is the contract's named
   *  outcome ("done", "usage", "connection", "partial", "refused",
   *  "unsupported"). The caller decides what an outcome means for its verb;
   *  this layer only refuses to invent one for an unknown exit code.
   *  `beforeSpawn`, when given, runs first and its rejection stops the spawn:
   *  the doctor wires it to a fresh (uncached) re-hash so the bytes about to
   *  run are the bytes that were verified (critic S-3). */
  async run(verb, {args = [], timeoutMs} = {}) {
    if (this.beforeSpawn !== undefined) await this.beforeSpawn(verb);
    const {code, stdout, stderr} = await runSidecarRaw(this.path, [verb, ...args], {
      env: this.env,
      credentials: this.credentials,
      timeoutMs: timeoutMs ?? this.timeoutMs,
      onStderr: this.onStderr,
      extraEnv: this.extraEnv,
    });
    // The whole stdout passes the redactor BEFORE the JSON line is picked and
    // parsed: the summary is data we print and embed (error text, the probe
    // document in --json), so it must arrive already masked. The values are
    // the credential and the DSN parts the contract says are never printed
    // (password, user, host) -- not the schema: the probe document
    // legitimately carries ABAP schema names and the verdict displays them,
    // they are object names, not secrets.
    const redact = makeRedactor([
      this.credentials?.password, this.credentials?.user, this.credentials?.host,
    ]);
    const safeStdout = redact(stdout);
    const outcome = EXIT_OUTCOMES[code];
    if (outcome === undefined) {
      throw new SidecarRunError(`osd-hana: ${SIDECAR_NAME} ${verb} exited ${code}, which the contract does not define`, {exit: code, stderr});
    }
    const lines = safeStdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    let summary;
    if (lines.length > 1) {
      // one JSON line or an error, not a guess: two lines are a refusal
      throw new SidecarRunError(`osd-hana: ${SIDECAR_NAME} ${verb} printed ${lines.length} lines on stdout where the contract promises one JSON line -- refusing to guess which line matters`, {exit: code, outcome, stderr});
    }
    const line = lines[0];
    if (line !== undefined) {
      try {
        summary = JSON.parse(line);
      } catch {
        throw new SidecarRunError(`osd-hana: ${SIDECAR_NAME} ${verb} printed no one-line JSON summary on stdout (contract W0); last line: ${line.slice(0, 200)}`, {exit: code, outcome, stderr});
      }
    } else {
      throw new SidecarRunError(`osd-hana: ${SIDECAR_NAME} ${verb} printed nothing on stdout (the contract promises one JSON line)`, {exit: code, outcome, stderr});
    }
    return {exit: code, outcome, summary, stderr};
  }
}
