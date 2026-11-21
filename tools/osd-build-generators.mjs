// The source and hosted-binary generator identities, and the child process
// that records generator reads while it writes gen/.
import {createHash, randomUUID} from "node:crypto";
import {appendFileSync, existsSync, readFileSync} from "node:fs";
import {dirname, join, relative, resolve, sep} from "node:path";
import {toolCommand, hosted} from "./osd-host.mjs";
import {run} from "./osd-build-command.mjs";
import {readGeneratorLog} from "./osd-read-record.mjs";
import {readLock} from "./osd-lock.mjs";
import {libraryPath} from "./osd-lib-path.mjs";
import {describeBuild} from "./osd-transpiler.mjs";

export function generatorClosureOf(toolsDir, generators) {
  const seen = new Set();
  const walk = file => {
    const abs = resolve(file);
    if (seen.has(abs) || !existsSync(abs)) return;
    seen.add(abs);
    const source = readFileSync(abs, "utf8");
    for (const match of source.matchAll(/from\s+"(\.[^"]+)"/g)) walk(join(dirname(abs), match[1]));
    for (const match of source.matchAll(/import\("(\.[^"]+)"\)/g)) walk(join(dirname(abs), match[1]));
  };
  for (const [script] of generators) walk(join(toolsDir, script));
  walk(join(toolsDir, "rap-flight/seed-capture.mjs"));
  walk(join(toolsDir, "osd-generator-view.mjs"));
  return [...seen].sort();
}

// What this build has checked already, handed to its recorded children: a
// child that ran `git status` again would read file content the record
// cannot see (tools/osd-generator-children.mjs refuses it as incomplete).
export function buildVerified(root) {
  const libs = {};
  let lock = {libraries: []};
  try { lock = readLock(root); } catch { /* no lock: nothing verified */ }
  for (const {folder} of lock.libraries) try { libs[folder] = libraryPath(root, folder); } catch { /* the child checks, and fails, itself */ }
  return JSON.stringify({toolchain: describeBuild(root), libs});
}

export function runGeneratorsOf(toolsDir, generators, activeOverlay, root, log = () => {}, overlay, readsLog, external = []) {
  let output = "";
  const verified = readsLog ? buildVerified(root) : undefined;
  for (const [script, ...args] of generators) {
    log(`${script} ${args.join(" ")}`.trim());
    const [cmd, ...argv] = toolCommand(join(toolsDir, script), args);
    const view = activeOverlay(overlay);
    const env = {...process.env, OSD_ROOT: root};
    if (readsLog) {
      env.OSD_READ_EXTERNAL = JSON.stringify(external);
      env.OSD_BUILD_VERIFIED = verified;
      if (!hosted()) argv.unshift("--import", join(toolsDir, "osd-generator-reads.mjs"));
    }
    delete env.OSD_ACTIVE_BUILD_OVERLAY;
    if (view) {
      env.OSD_ACTIVE_BUILD_OVERLAY = JSON.stringify({...view, exclude: [...view.exclude]});
      if (!hosted()) argv.unshift("--import", join(toolsDir, "osd-generator-view.mjs"));
    }
    output += recordedRun(cmd, argv, root, env, readsLog, script);
  }
  return output;
}

// A child is recorded only if its recorder says so, under a token of this
// run: one where it was not installed (a host that does not preload it) or
// could not take effect (a Bun binary) leaves no handshake, and the read
// record of the generation it feeds is incomplete -- unknown, not public.
export function recordedRun(cmd, argv, root, env, readsLog, label) {
  if (!readsLog) return run(cmd, argv, root, env);
  const token = randomUUID();
  const output = run(cmd, argv, root, {...env, OSD_GENERATOR_READS: readsLog, OSD_GENERATOR_READS_TOKEN: token});
  if (!readGeneratorLog(readsLog).tokens.has(token))
    appendFileSync(readsLog, `${JSON.stringify({incomplete: true, path: `${label}: no recorder handshake`})}\n`);
  return output;
}

let binaryIdentity;
export function generatorIdentityOf(toolsDir, generators) {
  const dispatch = hosted() ? JSON.parse(process.env.OSD_SELF) : undefined;
  const embedded = typeof __OSD_TOOLCHAIN_IDENTITY__ !== "undefined";
  if (dispatch && (embedded || dispatch.length === 1)) {
    if (binaryIdentity === undefined) {
      const executable = dispatch.length === 1 ? dispatch[0] : dispatch[1];
      binaryIdentity = "binary:" + createHash("sha256").update(readFileSync(executable)).digest("hex").slice(0, 16);
    }
    return binaryIdentity;
  }
  const h = createHash("sha256");
  const closure = generatorClosureOf(toolsDir, generators);
  h.update(`generators ${closure.length}\0`);
  for (const file of closure) {
    h.update(relative(toolsDir, file).split(sep).join("/")).update(readFileSync(file)).update("\0");
  }
  return "tools:" + h.digest("hex").slice(0, 16);
}
