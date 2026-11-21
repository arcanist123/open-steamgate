// The processes a recorded generator starts (tools/osd-generator-reads.mjs).
// A node child -- the seed capture's runtime among them -- carries the
// recorder through NODE_OPTIONS and owes a handshake under a token of its
// own: the {"child": token} line is written before it starts, so one that
// never answers (crashed, not node, the recorder not loadable) leaves the
// record incomplete (tools/osd-read-record.mjs readGeneratorLog). git runs
// only for exact metadata argv, and its repository counts as a name seen.
// Anything else -- a shell, another program, a worker thread, a detached
// child -- is incomplete when it starts.
import cp from "node:child_process";
import {randomUUID} from "node:crypto";
import {basename, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {realpathSync as liveRealpath} from "node:fs";
import wt from "node:worker_threads";
import {GIT_SAFE, devChildEnv, isolatedGit} from "./osd-env.mjs";

const CARRIED = ["OSD_GENERATOR_READS", "OSD_READ_ROOT", "OSD_READ_EXTERNAL", "OSD_READ_EXCLUDE_PREFIXES", "OSD_BUILD_VERIFIED"];
// metadata of .git, never file content: the argv after any `-C <dir>`
const GIT = [["rev-parse", "HEAD"], ["rev-parse", "--show-toplevel"], ["rev-parse", "--show-prefix"],
  ["rev-parse", "--short", "HEAD"], ["rev-parse", "--abbrev-ref", "HEAD"], ["rev-list", "--count", "HEAD"], ["ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"]];

export function gitMetadata(args) {
  let at = 0;
  let dir;
  while (args[at] === "-C" && typeof args[at + 1] === "string") { dir = resolve(dir ?? "", args[at + 1]); at += 2; }
  const rest = args.slice(at);
  const pattern = GIT.find(one => one.every((word, i) => rest[i] === word));
  if (!pattern) return undefined;
  const tail = rest.slice(pattern.length);
  // only ls-files takes paths, after its "--"
  if (pattern[0] !== "ls-files" ? tail.length !== 0 : tail.some(word => typeof word !== "string" || word.startsWith("-"))) return undefined;
  return {dir, paths: pattern[0] === "ls-files" ? tail : []};
}

// the unhooked one: syncBuiltinESMExports later rebinds the named export
const realpathSync = liveRealpath;
// ESM loads a module by its real path, so the recorder's URL names the link's target
const realOr = value => { try { return realpathSync(value.startsWith("file:") ? fileURLToPath(value) : resolve(value)); } catch { return resolve(value); } };
const unquote = value => /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;
const PRELOAD = /^(-r|--require|--import|--loader|--experimental-loader)(?:=(.*))?$/;
// an env or config file can set NODE_OPTIONS (and so a preload) itself; node
// starts the children of --run, --test and --watch* past the hooked
// child_process; a snapshot runs its own entry before any preload
const UNRECORDED = /^(--env-file(?:-if-exists)?|--experimental-config-file|--experimental-default-config-file|--run|--test|--watch|--watch-path|--watch-preserve-output|--snapshot-blob|--build-snapshot|--build-snapshot-config)(?:=|$)/;

// Preloads a node child runs: --require modules run before any --import, so
// one ahead of the recorder reads unrecorded. Any preload other than the
// recorder itself, and any flag in UNRECORDED, makes the child incomplete --
// in node's argv, NODE_OPTIONS or a fork's execArgv. Every word is scanned,
// the script's own argv too: telling node's options from the script's needs
// node's whole list of flags that take a value, so a script argument that
// looks like one fails closed. Returns what was found.
export function preloadsOf(args, nodeOptions, execArgv, recorder) {
  const found = [];
  const scan = list => {
    for (let i = 0; i < list.length; i++) {
      const word = unquote(String(list[i]));
      if (UNRECORDED.test(word)) { found.push(word); continue; }
      const m = PRELOAD.exec(word);
      if (!m) continue;
      const value = unquote(m[2] ?? String(list[++i] ?? ""));
      if (!recorder || value !== recorder && realOr(value) !== fileURLToPath(recorder)) found.push(`${m[1]} ${value}`);
    }
  };
  scan(args.map(String));
  scan(String(nodeOptions ?? "").split(/\s+/).filter(Boolean));
  scan(execArgv ?? []);
  return found;
}

export function installChildHooks({write, recorder, meta, listed}) {
  const o = {...cp};
  const OriginalWorker = wt.Worker;
  const self = (() => { try { return JSON.parse(process.env.OSD_SELF || "null") ?? undefined; } catch { return undefined; } })();
  const incomplete = what => write({incomplete: true, path: `child: ${what}`.slice(0, 300)});
  const carry = (env = process.env, kind) => {
    const token = randomUUID();
    write({child: token});
    const out = {...env};
    for (const name of CARRIED) if (process.env[name] !== undefined) out[name] = process.env[name];
    out.OSD_GENERATOR_READS_TOKEN = token;
    // `osd` itself (bin/osd.mjs) loads the recorder when it sees the log
    if (kind === "node") out.NODE_OPTIONS = `${out.NODE_OPTIONS ?? ""} --import=${recorder}`.trim();
    return out;
  };
  // the options to start a child with; incomplete is written for what is not recorded
  const plan = (file, args, options, forked = false) => {
    const command = [file, ...args].map(String).join(" ");
    const name = basename(String(file));
    if (options?.shell) return void incomplete(`${command} (shell)`) ?? options;
    const kind = self && file === self[0] && (self.length === 1 || args[0] === self[1]) ? "self"
      : forked || file === process.execPath || /^node(\.exe)?$/i.test(name) ? "node"
      : /^git(\.exe)?$/i.test(name) && gitMetadata(args) ? "git" : "other";
    if (kind === "git") {
      const {dir, paths} = gitMetadata(args);
      const repository = resolve(String(options?.cwd ?? process.cwd()), dir ?? ".");
      meta(repository, command);
      // ls-files names what is under its paths
      for (const path of paths) listed(resolve(repository, path), command);
      return {...options, env: isolatedGit(options?.env ?? devChildEnv()), git: true};
    }
    if (kind === "other") return void incomplete(command) ?? options;
    if (options?.detached) incomplete(`${command} (detached)`);
    if (kind === "node" && !recorder) incomplete(`${command} (recorder is not a file)`);
    // osd itself (kind "self") gets the same NODE_OPTIONS through carry(); its
    // argv is osd's own, never node's
    const preloads = preloadsOf(kind === "node" && !forked ? args : [], (options?.env ?? process.env).NODE_OPTIONS,
      forked ? options?.execArgv ?? process.execArgv : [], recorder);
    if (preloads.length) incomplete(`${command} (preload ${preloads.join(", ")})`);
    return {...options, env: carry(options?.env, kind)};
  };
  // file, [args], [options], [callback]
  const normal = (name, forked = false) => (file, ...rest) => {
    const args = Array.isArray(rest[0]) ? rest.shift() : [];
    const options = rest[0] !== null && typeof rest[0] === "object" ? rest.shift() : undefined;
    const planned = plan(file, args, options, forked);
    if (planned?.git !== true) return o[name](file, args, planned, ...rest);
    const {git, ...safe} = planned;
    return o[name](file, [...GIT_SAFE, ...args], safe, ...rest);
  };
  for (const name of ["spawn", "spawnSync", "execFile", "execFileSync"]) cp[name] = normal(name);
  cp.fork = normal("fork", true);
  // a command line is a shell's to read
  cp.exec = (command, ...rest) => { incomplete(`${command} (shell)`); return o.exec(command, ...rest); };
  cp.execSync = (command, ...rest) => { incomplete(`${command} (shell)`); return o.execSync(command, ...rest); };
  // a worker does not run --import preloads
  wt.Worker = class Worker extends OriginalWorker {
    constructor(file, options) { incomplete(`worker ${String(file).slice(0, 80)}`); super(file, options); }
  };
  return [[cp, o, "node:child_process"], [wt, {Worker: OriginalWorker}, "node:worker_threads"]];
}
