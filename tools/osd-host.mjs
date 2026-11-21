import {readEnvironment} from './osd-env.mjs';
// What the process is running in: Node over a checkout, or one compiled
// binary (bin/osd.mjs through scripts/build-binary.mjs, SP4).
//
// Inside a compiled Bun binary every bundled module has the same
// import.meta.url (file:///$bunfs/root/<binary>), process.execPath is the
// binary itself, and no file of tools/ exists on disk. So a tool that starts
// another tool by path — the supervisor its child, the builder its
// generators, the unit runner its detached run — asks here for the command
// instead, and gets `<binary> <mode> …` when compiled and `node <path> …`
// when not. bin/osd.mjs dispatches the modes.
//
// The transpiler and the core it was built against are the other thing a
// binary must hand over deliberately: bundled, they are static imports of
// the entry, registered here, and tools/osd-transpile.mjs asks before it
// resolves them from a node_modules that is not there.
import {basename, delimiter, isAbsolute, join, resolve} from "node:path";
import {existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from "node:fs";
import {homedir} from "node:os";

// Bun uses /$bunfs/ on Unix and a virtual B:/~BUN/root path on Windows.
export const compiled = typeof Bun !== "undefined" && /(?:\/\$bunfs\/|\/(?:~|%7E)BUN\/)/i.test(import.meta.url);

// How this very program is started again, as [command, ...args]: set by
// bin/osd.mjs for whichever host it finds itself on (a Bun binary, a Node
// single executable, a bundle under node, the source under node), so a
// tool that starts a tool never has to know. Unset means the plain
// checkout, where a tool is a file and node runs it.
function self() {
  const me = process.env.OSD_SELF;
  return me === undefined || me === "" ? undefined : JSON.parse(me);
}
export function hosted() {
  return self() !== undefined;
}

// [command, ...args] that runs a tool script with arguments
export function toolCommand(script, args = []) {
  return toolCommandIn(process.env, script, args);
}

// Select the host from the environment the child will actually receive.
export function toolCommandIn(env, script, args = []) {
  const value = env.OSD_SELF;
  const me = value === undefined || value === "" ? undefined : JSON.parse(value);
  return me !== undefined ? [...me, "gen", basename(script), ...args] : [process.execPath, script, ...args];
}

// An external Node script is not a tool of this tree, so `gen` cannot
// dispatch it (the dump->layers converter of tools/hana-src-gen.mjs
// --from-dump: OSD_HANA_CONVERTER names a path outside). The same
// [command, ...args] shape as toolCommand, but the interpreter is resolved
// for real: in a checkout and in a bundle under node process.execPath is
// node, as for a tool; inside a compiled binary or a SEA build
// process.execPath is the executable itself, so the interpreter is OSD_NODE
// when set, else "node" off the PATH (Bun.which, where Bun exists), and a
// named refusal when neither is there.
export function scriptCommandIn(env, script, args = []) {
  const value = env.OSD_SELF;
  const me = value === undefined || value === "" ? undefined : JSON.parse(value);
  if (me === undefined || me.length > 1) return [process.execPath, script, ...args];
  const node = env.OSD_NODE;
  if (node !== undefined && node !== "") {
    if (existsSync(node) === false) throw new Error(`osd-host: OSD_NODE=${node} is not there -- set it to a node executable that can run ${script}`);
    return [node, script, ...args];
  }
  const which = typeof Bun !== "undefined" && typeof Bun.which === "function" ? Bun.which("node") : undefined;
  if (which !== undefined && which !== "") return [which, script, ...args];
  throw new Error(`osd-host: ${script} is an external script and process.execPath is this binary -- set OSD_NODE to a node executable (or put node on the PATH)`);
}

// the serving runtime (tools/osd-serve.mjs) as a child of the supervisor
export function serveCommand(child) {
  const me = self();
  return me !== undefined ? [...me, "serve"] : [process.execPath, child];
}

// a detached ABAP Unit run (tools/osd-unit.mjs main)
export function unitCommand(script, args) {
  const me = self();
  return me !== undefined ? [...me, "unit", ...args] : [process.execPath, script, ...args];
}

// The compiler protocol child, hosted by the binary or the checkout.
export function compilerCommand(script, args = ["--stdio"]) {
  const me = self();
  return me !== undefined ? [...me, "compiler", ...args] : [process.execPath, script, ...args];
}

let modules;
export function setHostModules(m) {
  modules = m;
}
export function hostModules() {
  return modules;
}

// The embedded system seed and caller layers for the standalone binary.
export function dataDirOf(platform = process.platform, env = readEnvironment(["LOCALAPPDATA", "XDG_DATA_HOME"]), home = homedir()) {
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "open-steamgate");
  if (platform === "darwin") return join(home, "Library", "Application Support", "open-steamgate");
  return join(env.XDG_DATA_HOME || join(home, ".local", "share"), "open-steamgate");
}

export function layerList(args, env = readEnvironment(["OSD_LAYERS"]), cwd = process.cwd()) {
  const cli = [];
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    if (args.at(i) === "--layer") {
      if (!args.at(i + 1) || args.at(i + 1).startsWith("--")) throw new Error("--layer needs a folder or ZIP");
      cli.push(args.at(++i));
    } else {
      rest.push(args.at(i));
    }
  }
  const folders = [...(env.OSD_LAYERS || "").split(delimiter).filter(Boolean), ...cli]
    .map((folder) => isAbsolute(folder) ? resolve(folder) : resolve(cwd, folder));
  for (const folder of folders) {
    if (!existsSync(folder) || !(statSync(folder).isDirectory() || statSync(folder).isFile() && /\.zip$/i.test(folder))) throw new Error(`layer is not a folder or ZIP: ${folder}`);
  }
  return {folders, rest};
}

// The system homes a seeded binary has materialized under a data directory:
// each osd-home-<seed id> whose marker names the same id, the way
// ensureBinaryHome accepts one. `osd doctor` prints them, so "where did my
// edits go" has an answer without reading this file.
export function homesIn(dataDir) {
  if (!existsSync(dataDir)) return [];
  return readdirSync(dataDir).sort()
    .map((name) => ({name, id: /^osd-home-([0-9a-f]{64})$/.exec(name)?.[1]}))
    .filter(({id}) => id !== undefined)
    .map(({name, id}) => join(dataDir, name))
    .filter((home) => {
      const marker = join(home, ".osd-materialized");
      return existsSync(marker) && readFileSync(marker, "utf8").trim() === home.slice(-64);
    });
}

export function isCheckout(dir) {
  return !existsSync(join(dir, ".osd-materialized")) && existsSync(join(dir, "abap_transpile.json"))
    && existsSync(join(dir, "src")) && existsSync(join(dir, "tools"));
}

export async function ensureBinaryHome(archivePath, dataDir) {
  const archiveBytes = await Bun.file(archivePath).bytes();
  const archive = new Bun.Archive(archiveBytes);
  const files = await archive.files();
  const idFile = files.get(".seed-id") || files.get("./.seed-id");
  if (!idFile) throw new Error("binary has no system seed ID");
  const id = (await idFile.text()).trim();
  if (!/^[0-9a-f]{64}$/.test(id)) throw new Error("binary has an invalid system seed ID");
  const target = join(dataDir, `osd-home-${id}`);
  const marker = join(target, ".osd-materialized");
  mkdirSync(dataDir, {recursive: true});
  if (existsSync(target)) {
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== id) {
      throw new Error(`materialized home has no matching seed marker: ${target}`);
    }
    return target;
  }
  const staging = join(dataDir, `.osd-home-${id}-${process.pid}`);
  rmSync(staging, {recursive: true, force: true});
  try {
    await archive.extract(staging);
    writeFileSync(join(staging, ".osd-materialized"), `${id}\n`);
    // A concurrent first start can win the rename. Preserve that copy and
    // never merge into an existing (possibly edited) working tree.
    if (!existsSync(target)) {
      try {
        renameSync(staging, target);
      } catch (error) {
        if ((error?.code !== "EEXIST" && error?.code !== "ENOTEMPTY") || !existsSync(target)) throw error;
      }
    }
    if (!existsSync(marker) || readFileSync(marker, "utf8").trim() !== id) {
      throw new Error(`materialized home has no matching seed marker: ${target}`);
    }
  } finally {
    rmSync(staging, {recursive: true, force: true});
  }
  return target;
}

// A compiled host registers its scanner invocation at startup. Plain Node
// publication uses the fixed first-party script in osd-layer, never OSD_SELF.
export let hostedLeakScanner;
export function setHostedLeakScanner(run) {
  hostedLeakScanner = run;
}
