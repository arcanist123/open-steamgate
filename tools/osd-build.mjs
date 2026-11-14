import {missingLibraries, describeMissingLibraries} from "./osd-build-libraries.mjs";
export {missingLibraries, describeMissingLibraries};
import {activeSystem, assertPublicSystem, generationSystem, unrecordedGeneration, systemFile, rootWebappOf} from "./osd-system.mjs";
import {verifySystem} from "./osd-system-verify.mjs";
import {warnSystemToolchain} from "./osd-system-toolchain.mjs";
import {userLayersOf} from "./osd-source-layers.mjs";
// A generation: the transpiled system, built to the side, named by what
// went into it, made live by renaming a link.
//
// A build into output/ used to destroy the previous generation before
// succeeding. The serving process survived, but a restart could not.
// Build beside the live generation so a failed save leaves it usable.
//
// Here a build never touches anything that is live. It goes into a
// directory of its own under build/tmp, and only a complete one is renamed
// into build/by-input/<hash>, where <hash> is the sha256 of every input:
// the files in the input folders, the library trees, the config, and which
// transpiler did the work. The same inputs give the same name, so a rebuild
// with nothing changed costs nothing, and a transpiler upgrade is a new
// generation, as it should be. `build/live` is a symlink to the generation
// that serves, and `output/` at the root is a symlink to `build/live/output`,
// so the runtime child, which reads OSD_ROOT/output and nothing else, is
// switched by one rename and knows nothing about any of this.
//
// Content hashing takes 105 ms here, 170 ms for the largest library;
// generations are 44 MB. See docs/generations.md for the design.
import {keepCompileInputs} from "./osd-compile-snapshot.mjs";
import {keepSourceInputs, keepGeneratedSources, completeSourceSnapshot, materializeSourceSnapshot, keepCachedSources} from "./osd-source-snapshot.mjs";
import {gc} from "./osd-build-gc.mjs";
import {normalPath, stampOf, changedError} from "./osd-build-input-check.mjs";
export {normalPath};
export {gc};
import {createHash} from "node:crypto";
import {libraryPath} from "./osd-lib-path.mjs";
import {ensureUrlLibrary, urlLibraryPath} from "./osd-url-lib.mjs";
import {checkLayerVersions} from "./layer-version/index.mjs";
import {compareGenerations} from "./osd-generation-diff.mjs";
import {execFileSync} from "node:child_process";
import {buildVerified, generatorClosureOf, generatorIdentityOf, recordedRun, runGeneratorsOf} from "./osd-build-generators.mjs";
import {existsSync, lstatSync, mkdirSync, openSync, closeSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {buildIdentity, assertToolchain, describeBuild} from "./osd-transpiler.mjs";
import {describeDuplicates, excludePatterns, layers} from "./osd-inputs.mjs";
import {excludedObjectFiles} from "./hana-closure-exclusions.mjs";
import {transpile, selectedModules, isBinaryFilename, listFiles} from "./osd-transpile.mjs";
import {makeReadRecord, markIncomplete, readEntry, readGeneratorLog, READS, sha256, withSeedReads} from "./osd-read-record.mjs";
import {inputFoldersOf, packReadsOf, packsOf, seedsBuilt, userFoldersOf, webappsOf} from "./osd-packs.mjs";
import {describeUnfetched, unfetched} from "./osd-fetch.mjs";
import {toolCommand, hosted} from "./osd-host.mjs";
import {runsAs} from "./osd-main.mjs";
import {forPublishing} from "./osd-tmp.mjs";
import {sourceBuildOverlay} from "./osd-source-build-view.mjs";
import {assertLoadable} from "./osd-generation-check.mjs";

// the tools this build runs before the transpiler, in the order the old npm
// script ran them; each writes its part of gen/ and says so
export const GENERATORS = [
  ["osd-transpiler.mjs"],
  ["osd-inputs.mjs"],
  ["osd-ddic-binary.mjs"],
  ["cds2ddic.mjs"],
  ["rap/bdef-gen.mjs"],
  ["stg-compile.mjs", "--all"],
  ["segw-registry.mjs"],
  ["segw-shlp.mjs"],
  // BSP applications: a *.wapa.xml and its pages become a registry the ABAP
  // handler reads, so a page this system serves is an object like any other
  // rather than a file behind express
  ["osd-bsp-registry.mjs"],
  // AMDP: the bodies the transpiler cannot compile become routed calls, and
  // the SQLScript is put aside for HANA (docs/amdp-in-hana.md). Before the
  // function-module registry, because the modules it writes are what that
  // registry has to see.
  ["amdp-gen.mjs"],
  // and then the CDS table functions are checked against the methods that
  // implement them: the `returns` list is the authority and a mismatch fails
  // the build, because filling columns by position quietly is worse than not
  // building at all
  ["amdp-tablefunc.mjs"],
  ["osd-fm-registry.mjs"],
  // classic reports through open-abap-gui's converter, wired as transactions
  // (docs/gui-reports.md); before the transaction registry, which is what
  // picks up the *.tran.xml this writes
  ["osd-gui-convert.mjs"],
  ["osd-tran-registry.mjs"],
];

const TOOLS = fileURLToPath(new URL(".", import.meta.url));

export function layout(root) {
  const build = join(root, "build");
  return {
    root,
    build,
    byInput: join(build, "by-input"),
    tmp: join(build, "tmp"),
    live: join(build, "live"),
    lock: join(build, ".lock"),
    output: join(root, "output"),
    config: join(root, "abap_transpile.json"),
  };
}

// the config as the transpiler reads it: its own loader, because the file
// carries comments the JSON parser refuses, and it is the transpiler's file
export function loadConfig(root) {
  // the CLI's loader does exactly this (transpiler-cli/build/config.js:
  // parse the file when there is one, defaults when there is not), and it
  // was the last thing in the build path that reached the CLI package —
  // from inside a binary through the tree's node_modules, which is where
  // the SP4 binary first fell over
  const file = layout(root).config;
  if (existsSync(file)) {
    return JSON.parse(readFileSync(file, "utf8"));
  }
  return {
    input_folder: "src",
    input_filter: [],
    output_folder: "output",
    libs: [{url: "https://github.com/open-abap/open-abap-core"}],
    write_unit_tests: true,
    write_source_map: true,
    options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
  };
}

function walk(dir, out = [], seen = new Set()) {
  let entries;
  try {
    const real = realpathSync(dir);
    if (seen.has(real)) return out;
    seen.add(real);
    entries = readdirSync(dir, {withFileTypes: true});
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.name === ".git" || e.name === "node_modules" || e.name === ".osd-system.json") {
      continue;
    }
    const p = join(dir, e.name);
    let directory = e.isDirectory();
    let file = e.isFile();
    if (e.isSymbolicLink()) {
      try {
        const target = statSync(p);
        directory = target.isDirectory();
        file = target.isFile();
      } catch {
        directory = false;
        file = false;
      }
    }
    if (directory) {
      walk(p, out, seen);
    } else if (file) {
      out.push(p);
    }
  }
  return out;
}

// what a generation is made of, and the hash that names it. A listed folder
// is an input only while it holds a file the hash would count (the
// NOT_AN_INPUT rule folder() applies): the base leaves gen/hana-ddic empty
// on every build, and an empty folder was never read
export function inputsOf(root, config = loadConfig(root)) {
  // a listed folder is an input while it holds any file: an empty one
  // (gen/hana-ddic before hana-ddic-gen writes it) was never read, and a
  // folder of media alone is still read by the transpiler
  const folders = inputFoldersOf(root, config).map((f) => join(root, f)).filter((f) => existsSync(f) && walk(f).length > 0);
  const libs = (config.libs ?? []).map((l) => {
    const cached = urlLibraryPath(root, l);
    if (cached) {
      if (!existsSync(cached)) throw Object.assign(new Error(`pinned URL library is not cached: ${l.url}; run the build first`), {code: "MISSING_URL_LIB"});
      return cached;
    }
    if (l.folder === undefined || l.folder === "") return undefined;
    return (activeSystem(root) || existsSync(join(root, "libs.lock.json"))) ? libraryPath(root, basename(l.folder)) : join(root, l.folder);
  }).filter(Boolean);
  // BSP pages are generator inputs too. In particular, Component.js lives
  // outside the ABAP input folders and the ABAP-only filter below excludes
  // JavaScript. Omitting it reused a generation whose registry named a page
  // but whose Web Repository object was not in the transpiled runtime.
  const bspFolders = [rootWebappOf(root), ...webappsOf(root).map((app) => app.dir)].filter(existsSync);
  // **A pack that brings nothing is not an input.** The VS Code extension
  // always hands the build an empty notebook-scratch pack in its own storage
  // (editors/vscode/launcher.js ensureWorkspacePacks), so its manifest's path,
  // which differs per machine, named every generation -- and a generation
  // prebuilt into the .vsix could never be reused (T2). An empty pack builds
  // nothing, so it names nothing; the moment it holds an input file (the same
  // rule hashOf applies to a folder: NOT_AN_INPUT files do not count) it is
  // an input. A data, ddic or webapp folder, or a tile, keeps it one anyway.
  // Rows the build captured (seedsBuilt, makePackSeeds) are output, not input.
  const data = (pack) => seedsBuilt(pack.data) ? undefined : pack.data;
  const packs = packsOf(root).filter((pack) => data(pack) !== undefined || pack.ddic !== undefined ||
    pack.webapp !== undefined || pack.tiles.length > 0 ||
    pack.abap.some((dir) => existsSync(dir) && walk(dir).some((f) => !NOT_AN_INPUT.test(f) || isBinaryFilename(f))));
  const packFiles = packs.map((pack) => join(pack.dir, "osd-pack.json"));
  const packFolders = packs.flatMap((pack) => [data(pack), pack.ddic].filter(Boolean));
  const sourceLayers = userLayersOf(root);
  const rootInputs = ["data", "abaplint.jsonc"].map((name) => join(root, name)).filter(existsSync);
  return {folders, libs, bspFolders, packFiles, packFolders, packReads: packReadsOf(root), sourceLayers, rootInputs, config: layout(root).config};
}

// What the transpiler and the generators read, and nothing else: a mocha
// test or a note beside the ABAP is not an input, and a hash that counted
// it would spend ten seconds building the same output again after an edit
// to a .mjs. Everything in an input folder counts except these.
// Optional DSL navigation metadata is generated beside the source, carries
// volatile provenance, and is excluded by the transpiler and BSP generator.
// Creating it (for example in dsl-l2's setup) must not invalidate live code.
const TRACE_METADATA = /\.trace\.meta\.json$/i;
const NOT_AN_INPUT = /\.(mjs|cjs|js|ts|py|md|txt|log|lock|snap|trace\.meta\.json)$/i;

export const generatorClosure = (toolsDir = TOOLS, generators = GENERATORS) => generatorClosureOf(toolsDir, generators);
export const runGenerators = (root, log = () => {}, overlay, readsLog, external) => {
  // the generated-input folder the config lists (H3: gen/hana-ddic) exists
  // from the first build on, empty until hana-ddic-gen --from-build writes it
  mkdirSync(join(root, "gen", "hana-ddic"), {recursive: true});
  return runGeneratorsOf(TOOLS, GENERATORS, activeOverlay, root, log, overlay, readsLog, external);
};
export const generatorIdentity = () => generatorIdentityOf(TOOLS, GENERATORS);

/** what `gen/` holds right now, by content: 196 files, milliseconds */
export function genHash(root) {
  const dir = join(root, "gen");
  if (!existsSync(dir)) return "";
  const h = createHash("sha256");
  for (const f of walk(dir).sort()) {
    h.update(relative(root, f)).update("\0").update(readFileSync(f)).update("\0");
  }
  return h.digest("hex").slice(0, 16);
}

// a file's content, as a digest kept for as long as its stat says it has not
// changed: the name of a generation is then a walk and a stat per input,
// which is what lets a warm build (tools/osd-warm.mjs) name the generation it
// makes in milliseconds rather than reading the whole tree again. The key
// holds ctime as well as mtime, so a write that restores an mtime is seen
const DIGESTS = new Map();
function digestOf(file) {
  const st = statSync(file);
  const key = `${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`;
  let hit = DIGESTS.get(file);
  if (hit === undefined || hit.key !== key) {
    hit = {key, digest: createHash("sha256").update(readFileSync(file)).digest("hex")};
    // git's rule for a racy entry: a file written in the last two seconds
    // may be written again within the resolution of its timestamps and keep
    // its size, so its digest is not kept -- it is read again next time
    if (Date.now() - st.mtimeMs > 2000) {
      DIGESTS.set(file, hit);
    } else {
      DIGESTS.delete(file);
    }
  }
  return hit.digest;
}

// `options`, all optional, are for a warm build (tools/osd-warm.mjs):
//   digests    filled with every input and its digest, which is what the warm
//              build compares with the inputs it was primed on;
//   folders    per input folder, the (file, digest) list of an earlier walk,
//              for a folder a watcher says has not changed since -- the
//              libraries are 4400 of this tree's 5100 inputs;
//   transpiler buildIdentity(root), when the caller has it already.
// None of them changes the name: it is the same hash over the same list.
//   overlay    the inactive objects an ObjectStore keeps out of the build
//              (overlayOf below); an empty or absent one changes nothing.
export function hashOf(root, inputs = inputsOf(root), options = {}) {
  const digests = options instanceof Map ? options : options.digests;
  const overlay = options instanceof Map ? undefined : activeOverlay(options.overlay);
  // a folder walk cached for a tree without an overlay is not this list
  const folders = options instanceof Map || overlay !== undefined || options.substitute !== undefined ? undefined : options.folders;
  const kept = overlay === undefined ? () => true : (f) => !overlay.exclude.has(resolve(f));
  const transpilerReads = new Set(listFiles(root, loadConfig(root)).wanted.map(file => resolve(file)));
  const sourceInput = file => (!NOT_AN_INPUT.test(file) || isBinaryFilename(file) || transpilerReads.has(resolve(file))) && kept(file);
  // a proof, not a build: these files counted with these digests (a warm
  // prime asking whether its view is the live generation with saves since
  // put back to the bytes they replaced, tools/osd-warm.mjs)
  const substitute = options instanceof Map ? undefined : options.substitute;
  const hash = createHash("sha256");
  // Optional audit of the exact framed inputs, in hashing order.
  const h = {update(value) {
    options.trace?.(value);
    hash.update(value);
    return this;
  }, digest: (...args) => hash.digest(...args)};
  for (const entry of ((options instanceof Map ? undefined : options.exclusions) ?? []).slice().sort()) h.update("excluded\0").update(entry).update("\0");
  h.update("transpiler\0").update(String(options.transpiler ?? buildIdentity(root))).update("\0");
  h.update("layers\0later-wins\0");
  const system = activeSystem(root);
  if (system) h.update("system\0").update(system.digest).update("\0");
  for (const name of generationSystem(root, inputs).provenance.filter(input => input.private !== false).map(input => `${input.kind}:${input.path}${input.private === null ? ":unknown" : ""}`).sort()) h.update("private-input\0").update(name).update("\0"); // unknown privacy names a generation too
  for (const layer of inputs.sourceLayers ?? []) {
    h.update("source-layer\0").update(JSON.stringify(layer)).update("\0");
    // the ZIP is named by archiveId (its sha256) above; listing its digest
    // lets the read record count the build's read of it as hashed
    if (layer.archiveFile && existsSync(layer.archiveFile)) digests?.set(layer.archiveFile, digestOf(layer.archiveFile));
  }
  // written by inputsOf from the source layers just hashed, so its bytes are a
  // function of them: listed for the read record, not hashed again
  const mounts = join(root, "local/overlays/.osd-mounts.txt");
  if (existsSync(mounts)) digests?.set(mounts, digestOf(mounts));
  h.update("config\0").update(readFileSync(inputs.config)).update("\0");
  const lockFile = join(root, "libs.lock.json");
  if (existsSync(lockFile)) {
    const lockDigest = digestOf(lockFile);
    digests?.set(lockFile, lockDigest);
    h.update("libraries-lock\0").update(lockDigest).update("\0");
  }
  const folder = (label, dir, list) => {
    let entries = folders?.get(dir);
    if (entries === undefined) {
      entries = list().map((f) => [f, substitute?.get(resolve(f)) ?? digestOf(f)]);
      folders?.set(dir, entries);
    }
    // an empty folder builds nothing, so its path does not name the generation
    if (entries.length === 0) return;
    h.update(`${label} ${relative(root, dir)} ${entries.length}\0`);
    for (const [f, digest] of entries) {
      digests?.set(f, digest);
      h.update(relative(root, f)).update("\0").update(digest).update("\0");
    }
  };
  for (const dir of inputs.folders) {
    // **`gen/` is an OUTPUT and is left out.** It is written by this build
    // from the folders above and the generators below, so hashing it made
    // the name a function of the tree AND of how many times the tree had
    // been built. What decides its content is hashed instead.
    if (relative(root, dir) === "gen") continue;
    folder("dir", dir, () => (existsSync(dir) ? walk(dir).filter(sourceInput).sort() : []));
  }
  // a locked library is read whole, by the generators too (open-abap-gui's
  // converter is code that decides gen/); the lock pins every byte of it
  for (const dir of inputs.libs) folder("dir", dir, () => (existsSync(dir) ? walk(dir).filter((f) => !TRACE_METADATA.test(f) && kept(f)).sort() : []));
  // tracked root files the generators read: table rows, the lint config
  for (const path of inputs.rootInputs ?? []) {
    if (statSync(path).isDirectory()) folder("root", path, () => walk(path).filter((f) => !TRACE_METADATA.test(f)).sort());
    else { digests?.set(path, digestOf(path)); h.update(`root ${relative(root, path)}\0`).update(digestOf(path)).update("\0"); }
  }
  // the last active versions of the objects whose saved version is kept
  // out: a generation built from them is another generation
  if (overlay?.folder !== undefined) {
    const dir = join(root, overlay.folder);
    folder("active", dir, () => (existsSync(dir) ? walk(dir).filter(sourceInput).sort() : []));
  }
  for (const dir of inputs.bspFolders ?? []) {
    folder("bsp", dir, () => walk(dir).filter((f) => !TRACE_METADATA.test(f)).sort());
  }
  for (const dir of inputs.packFolders ?? []) {
    folder("pack", dir, () => walk(dir).filter((f) => !TRACE_METADATA.test(f)).sort());
  }
  for (const file of inputs.packFiles ?? []) {
    h.update(`manifest ${relative(root, file)}\0`).update(digestOf(file)).update("\0");
    digests?.set(file, digestOf(file));
    const fetched = join(dirname(file), ".osd-fetched.json");
    if (existsSync(fetched)) {
      const fetchedDigest = digestOf(fetched);
      digests?.set(fetched, fetchedDigest);
      h.update(`fetched ${relative(root, fetched)}\0`).update(fetchedDigest).update("\0");
      // and the identity each fetched folder carries, read even when it brought no files
      let names = [];
      try { names = Object.keys(JSON.parse(readFileSync(fetched, "utf8"))).sort(); } catch { /* digested above; inputsOf refuses it */ }
      for (const marker of names.map((name) => join(dirname(file), name, ".osd-source.json")).filter(existsSync)) {
        digests?.set(marker, digestOf(marker));
        h.update(`identity ${relative(root, marker)}\0`).update(digestOf(marker)).update("\0");
      }
    }
  }
  // what finding the packs reads, an unselected pack's manifest too
  for (const file of (inputs.packReads ?? []).filter((f) => !(inputs.packFiles ?? []).includes(f))) {
    digests?.set(file, digestOf(file));
    h.update(`pack-read ${relative(root, file)}\0`).update(digestOf(file)).update("\0");
  }
  // the generators that will actually run -- the files under node, the
  // binary itself when it is the binary, because it executes its own copies
  h.update("generators\0").update(generatorIdentity(root)).update("\0");
  return h.digest("hex").slice(0, 16);
}

// an empty build lock younger than this is still being written by its owner
export const LOCK_WRITE_GRACE_MS = 5000;

// one build at a time: the generators write gen/ at the root, and two of
// them at once would race over it. A stale lock from a process that died is
// taken over, not obeyed.
export function lock(paths) {
  mkdirSync(paths.build, {recursive: true});
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(paths.lock, "wx");
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try {
          unlinkSync(paths.lock);
        } catch {
          // already gone
        }
      };
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }
      const pid = Number(readFileSync(paths.lock, "utf8"));
      let alive = false;
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      } else {
        // No pid: the owner was killed between openSync and writeFileSync
        // above. Number("") is 0, and kill(0, 0) asks the caller's own process
        // group, so this used to read as "a build is already running (pid 0)",
        // for good. A lock that is being written right now is only
        // microseconds old: refuse it for a short grace, then take it over.
        let age = Infinity;
        try { age = Date.now() - statSync(paths.lock).mtimeMs; } catch { /* gone: retry */ }
        alive = age < LOCK_WRITE_GRACE_MS;
      }
      if (alive) {
        const e = new Error(`a build is already running (pid ${pid})`);
        e.code = "BUSY";
        throw e;
      }
      unlinkSync(paths.lock);
    }
  }
  throw new Error("could not take the build lock");
}

// The transpiled modules reach outside output/ for one thing: the setup
// hook the config names as "../test/setup.mjs" (and whatever else a config
// may point at with "../"). Node resolves a relative import from the real
// path of the importing file, not through the symlink at the root, so from
// build/by-input/<hash>/output that path lands beside the generation, where
// nothing is. A relative symlink per such directory makes the generation
// self-contained in the way the old output/ was by accident of sitting at
// the root. Idempotent, and run on switch as well as on build, so a
// generation made before this existed gets its links the first time it
// goes live.
// the directories beside output/ that the modules of a generation name with
// "../<dir>/": the setup hook, and whatever else a module points at. `files`
// narrows the scan to some modules (a warm build's rebuilt ones)
export function rootsWanted(generation, config, files = undefined) {
  const wanted = new Set();
  const setup = config?.options?.setup?.filename;
  if (typeof setup === "string") {
    const m = /^\.\.\/([^/]+)/.exec(setup);
    if (m) {
      wanted.add(m[1]);
    }
  }
  const out = join(generation, "output");
  const names = files ?? (existsSync(out) ? readdirSync(out).filter((n) => n.endsWith(".mjs")).slice(0, 4000) : []);
  for (const f of names) {
    const text = readFileSync(join(out, f), "utf8");
    for (const m of text.matchAll(/["'`]\.\.\/([^/"'`]+)\//g)) {
      wanted.add(m[1]);
    }
  }
  return wanted;
}

// A link to a directory: a relative symlink where anyone may make one, a
// junction on Windows, where a symlink needs an administrator or Developer
// Mode and a junction needs neither. A junction's target is absolute, and
// OSD_DIR_LINK=junction takes that form anywhere, so the path Windows takes
// is tested on Linux too. `target` is relative to the link's own folder.
export function dirLinkMode(env = process.env) {
  return env.OSD_DIR_LINK ?? (process.platform === "win32" ? "junction" : "symlink");
}
export function linkDir(target, path) {
  if (dirLinkMode() === "junction") {
    symlinkSync(resolve(dirname(path), target), path, "junction");
  } else {
    symlinkSync(target, path, "dir");
  }
}
// a link replaced by another: one rename where the platform renames over an
// existing link, and where it refuses (a junction on Windows), the old link
// removed first -- a moment without it, which a reader that finds nothing
// retries
function replaceLink(from, to) {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!["EPERM", "EEXIST", "EISDIR", "ENOTEMPTY", "EACCES"].includes(error?.code)) throw error;
    unlinkSync(to);
    renameSync(from, to);
  }
}

export function linkRoots(root, generation, config = loadConfig(root), log = () => {}, options = {}) {
  // `wanted`: the names, when the caller knows them already (a warm build:
  // the live generation's plus whatever the modules it rebuilt name)
  const wanted = new Set(options.wanted ?? rootsWanted(generation, config));
  for (const name of wanted) {
    // a string that merely looks like a path ("../sap/bc/…" in a literal)
    // names nothing at the root, and a link to nothing is worse than none
    if (!existsSync(join(root, name)) || !statSync(join(root, name)).isDirectory()) {
      wanted.delete(name);
      continue;
    }
    const link = join(generation, name);
    const target = relative(generation, join(root, name));
    let kind;
    try {
      kind = lstatSync(link);
    } catch {
      kind = undefined;
    }
    if (kind === undefined) {
      linkDir(target, link);
      log(`${basename(generation)}/${name} -> ${target}`);
    }
  }
  return [...wanted];
}

export function liveHash(root) {
  // a store that is not over a tree (a test's stand-in) has no generation
  if (root === undefined || root === null || root === "") {
    return undefined;
  }
  const paths = layout(root);
  try {
    // a junction reads back absolute, on Windows with a trailing separator
    return basename(readlinkSync(paths.live).replace(/[\\/]+$/, "").replace(/\\/g, "/"));
  } catch {
    return undefined;
  }
}

/** Read-only proof using the builder's own hash, including generator identity. */
export function generationStateSnapshot(root = process.cwd(), {hashTree = true} = {}) {
  const live = liveHash(root);
  return {root, live: live ?? null, ...(hashTree ? {tree: live === undefined ? null : hashOf(root)} : {})};
}

export function generations(root) {
  const paths = layout(root);
  if (!existsSync(paths.byInput)) {
    return [];
  }
  const live = liveHash(root);
  return readdirSync(paths.byInput)
    .map((hash) => {
      try {
        const manifest = JSON.parse(readFileSync(join(paths.byInput, hash, "manifest.json"), "utf8"));
        return {...manifest, hash, live: hash === live};
      } catch {
        return undefined;
      }
    })
    .filter(Boolean)
    .sort((a, b) => String(a.builtAt).localeCompare(String(b.builtAt)));
}

// point live at a generation, and output at live. Two renames, each atomic;
// nothing between them is a state a reader can see as "no output".
export function switchTo(root, hash, log = () => {}, options = {}) {
  const paths = layout(root);
  const target = join(paths.byInput, hash);
  if (!existsSync(join(target, "output"))) {
    const e = new Error(`generation ${hash} is not built`);
    e.code = "NOT_BUILT";
    throw e;
  }
  linkRoots(root, target, undefined, log, options);
  const tmpLink = paths.live + ".tmp";
  try {
    unlinkSync(tmpLink);
  } catch {
    // nothing to remove
  }
  linkDir(join("by-input", hash), tmpLink);
  replaceLink(tmpLink, paths.live);

  // output/ at the root: a symlink to build/live/output. A real directory
  // there is what every tree had before this existed; it is moved aside once
  // and reclaimed by gc, never deleted underneath a process that may still
  // be loading from it.
  let kind;
  try {
    kind = lstatSync(paths.output);
  } catch {
    kind = undefined;
  }
  if (kind !== undefined && !kind.isSymbolicLink()) {
    const aside = join(paths.build, `legacy-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    renameSync(paths.output, aside);
    log(`output/ was a directory: moved to ${relative(root, aside)}`);
    kind = undefined;
  }
  if (kind === undefined) {
    linkDir(join("build", "live", "output"), paths.output);
  }
  log(`live -> ${hash}`);
  return hash;
}

// the build: hash, then either the cached generation or a fresh one to the
// side, then the switch. Every failure leaves live untouched.
// what every build refuses before it takes a lock or runs a generator, and
// the layers it builds from: shared by the cold build below and the warm one
// (tools/osd-warm.mjs), so the two cannot disagree about what a tree is
export function prepare(root, log = () => {}) {
  const system = activeSystem(root);
  verifySystem(root, system, log);
  const config = loadConfig(root);
  for (const lib of config.libs ?? []) ensureUrlLibrary(root, lib);
  warnSystemToolchain(root, system, log);
  checkLayerVersions(root, packsOf(root), userFoldersOf(root), log);
  const missingLibs = missingLibraries(root, config);
  if (missingLibs.length > 0) {
    const e = new Error(`the build refuses: ${describeMissingLibraries(missingLibs)}`);
    e.code = "MISSING_LIBRARIES";
    e.missing = missingLibs;
    throw e;
  }
  if (existsSync(join(root, "libs.lock.json"))) {
    for (const lib of config.libs ?? []) if (lib.folder) libraryPath(root, basename(lib.folder));
  }
  // the layers, resolved before anything else (tools/osd-inputs.mjs): the
  // same file name twice inside one folder is a refusal naming both files,
  // never a guess, and it is refused before a lock is taken or a generator
  // runs; an object an earlier layer hides is said, and hidden below
  // a pack that fetches a folder and has not: a smaller system than the
  // manifest describes, refused before it is built (tools/osd-fetch.mjs)
  const missing = unfetched(root);
  if (missing.length > 0) {
    const e = new Error(`the build refuses: ${describeUnfetched(missing)}`);
    e.code = "UNFETCHED";
    e.missing = missing;
    throw e;
  }
  const stack = layers(root, config);
  if (stack.duplicates.length > 0) {
    const e = new Error(`the build refuses: ${describeDuplicates(stack.duplicates)}`);
    e.code = "DUPLICATE";
    e.duplicates = stack.duplicates;
    throw e;
  }
  for (const {object, winner, hidden} of stack.overridden) {
    log(`overridden: ${object}: ${hidden.join(", ")} hidden by ${winner}`);
  }
  return {config, stack};
}

// the config a build hands the transpiler: the same config, aimed at the
// build's own directory. The path is root-relative because the transpiler
// joins it to its working directory. The transpiler is handed the winner of
// every name only: a class in two inputs is "already defined" to it, not an
// override, so the files an earlier layer hides are kept from it here
export function ownConfig(root, config, stack, outputFolder, overlay = undefined) {
  const kept = activeOverlay(overlay);
  return {
    ...config,
    // the packs are layers of this build, so the transpiler is handed them
    // with the tree's own folders (backlog E.2); the last active versions of
    // inactive objects come last, and their saved files are excluded
    input_folder: [...inputFoldersOf(root, config), ...(kept?.folder === undefined ? [] : [kept.folder])],
    output_folder: relative(root, outputFolder),
    exclude_filter: [...(config.exclude_filter ?? []), ...excludePatterns(stack.hidden),
      // the closure walk's definition-level exclusions (H5x-1): objects the
      // walk found unresolvable at the definition level, recorded in
      // gen/hana-closure/closure-stubs.json -- the file stays in its layer
      // on disk, the build is kept from it here, through the same seam
      ...excludePatterns(excludedObjectFiles(root)),
      ...[...(kept?.exclude ?? [])].sort().map((file) => `^${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`)],
  };
}

// **An inactive object is not built** (vsp-i7's abapGit spike, 2026-10-02).
// The tree is the working area: a save lands in its file before anyone
// activates it, so a build of the folders alone built every saved-but-failed
// source too, and one broken object failed every later activation of
// anything until it was deleted. The store says which objects are inactive
// (ObjectStore#overlay): their files are excluded by absolute path, and the
// last active version of each, when it had one, comes from `folder` instead.
// {exclude: [absolute files], folder: root-relative folder | undefined}
const overlayFilesOf = (root, overlay) => {
  const dir = activeOverlay(overlay)?.folder === undefined ? undefined : join(root, overlay.folder);
  return dir !== undefined && existsSync(dir) ? walk(dir).map((f) => relative(root, f).split(sep).join("/")).sort() : [];
};

export function activeOverlay(overlay) {
  if (overlay === undefined || overlay === null) return undefined;
  const exclude = new Set([...(overlay.exclude ?? [])].map((f) => resolve(f)));
  if (exclude.size === 0 && overlay.folder === undefined) return undefined;
  return {exclude, folder: overlay.folder};
}

export async function build(options = {}) {
  const root = resolve(options.root ?? process.env.OSD_ROOT ?? process.cwd());
  options = {...options, overlay: await sourceBuildOverlay(root, options)};
  const log = options.log ?? (() => {});
  const paths = layout(root);
  const started = Date.now();
  const {config, stack} = prepare(root, log);
  const inputs = inputsOf(root, config);
  // what each input held when the generation was named: the bytes it is
  // built from (checked as the transpiler reads them, below), and what an
  // activation's completion compares with (ObjectStore#completeActivations)
  const loaded = selectedModules(root);
  const identity = assertToolchain(root, loaded);
  const named = new Map();
  const hash = hashOf(root, inputs, {overlay: options.overlay, digests: named, transpiler: identity, exclusions: excludedObjectFiles(root)});
  named.set(inputs.config, sha256(readFileSync(inputs.config)));
  // one spelling of a path for every comparison: a native one from the walk,
  // a forward-slash one from the transpiler's reads on Windows
  const digests = new Map([...named].map(([file, digest]) => [normalPath(file), digest]));
  // **What the generators read is verified as well as what the transpiler
  // reads.** A CDS view or a table is no transpiler input -- a generator
  // reads it -- so a save between the hash and the generators' read, put
  // back before the completion, built a generation of other bytes under
  // this name. Every non-library input is stamped (size, times, inode) here,
  // checked against the hash's digest once stamped (closing the gap between
  // the hash's read and the stamp), and stamped again after the build: any
  // write in between, even one that restores the bytes, changes the stamp.
  const libraries = inputs.libs.map((dir) => normalPath(dir) + "/");
  const watched = [...named.keys()].filter((file) => !libraries.some((lib) => normalPath(file).startsWith(lib)));
  const stamps = new Map(watched.map((file) => [file, stampOf(file)]));
  const moved = watched.filter((file) => (existsSync(file) ? digestOf(file) : undefined) !== named.get(file));
  if (moved.length > 0) throw changedError(root, moved);
  if (options.expectedHash !== undefined && hash !== options.expectedHash) throw changedError(root, []);
  const target = join(paths.byInput, hash);
  // a generation a warm build made (tools/osd-warm.mjs) is not a cache hit
  // until a cold transpile has been compared with it: it is built again,
  // compared, and replaced if it differs
  const warmSide = `${target}.warm.json`;
  let warmUnchecked = false;
  try {
    warmUnchecked = JSON.parse(readFileSync(warmSide, "utf8")).verified !== true;
  } catch (error) {
    warmUnchecked = error.code !== "ENOENT";
  }
  if (warmUnchecked || options.force !== true && unrecordedGeneration(target)) { // publishers refuse one without its system record
    options = {...options, force: true, replace: true};
    log(warmUnchecked ? `generation ${hash} was made warm and nobody has compared it yet: building it cold` : `generation ${hash} does not record its system: building it again`);
  }

  if (options.force !== true && existsSync(join(target, "manifest.json"))) {
    const manifest = JSON.parse(readFileSync(join(target, "manifest.json"), "utf8"));
    // **A cache hit must not leave `gen/` holding somebody else's edit.**
    // The generation is reused because the INPUTS match; `gen/` is an output
    // and is written by the generators, which a cache hit skips. If what is
    // on disk is not what this generation was made from, the generators run
    // again -- the transpile still does not.
    if (manifest.gen !== undefined && manifest.gen !== genHash(root)) {
      log(`generation ${hash} is already built, but gen/ has drifted from it -- regenerating`);
      const unlockAgain = lock(paths);
      try {
        runGenerators(root, log, options.overlay);
      } finally {
        unlockAgain();
      }
    } else {
      log(`generation ${hash} is already built`);
    }
    keepCachedSources(root, target, digests, options.overlay);
    if (options.switch !== false && liveHash(root) !== hash) {
      switchTo(root, hash, log);
    }
    await makePackSeeds(root, inputs, hash, log, named);
    return {ok: true, hash, cached: true, live: liveHash(root) === hash, ms: Date.now() - started, objects: manifest.objects, digests};
  }

  const unlock = lock(paths);
  const tmp = join(paths.tmp, `${hash}.${process.pid}`);
  const readsLog = join(tmp, "generator-reads.jsonl");
  const readEntries = [];
  let output = "";
  let built;
  try {
    rmSync(tmp, {recursive: true, force: true});
    mkdirSync(join(tmp, "output"), {recursive: true});
    // generators: false is for a tree with nothing to generate (a test's
    // tree of a few classes); every real build runs them
    if (options.generators !== false) {
      output += runGenerators(root, log, options.overlay, readsLog,
        [...inputs.folders, ...inputs.libs, ...inputs.bspFolders, ...inputs.packFolders].filter(path => !normalPath(path).startsWith(normalPath(root) + "/")));
    }
    await options.onStep?.("generated");
    // **The layers are read again once gen/ is written.** gen/ is a layer, and
    // an object it holds hides the one in src/ it was generated from (the AMDP
    // bridge: gen/amdp/zcl_osd_amdp_demo over src/amdp/). Reading the layers
    // only before the generators ran gave a fresh checkout's first build no
    // such hiding -- gen/amdp did not exist yet -- so the transpiler got both
    // copies of the class, and the same inputs built different bytes on the
    // first build than on every later one (found by the warm build's premise
    // check, tools/osd-warm.mjs prime, 2026-09-26).
    const after = options.generators !== false ? layers(root, config) : stack;
    if (after.duplicates.length > 0) {
      const e = new Error(`the build refuses: ${describeDuplicates(after.duplicates)}`);
      e.code = "DUPLICATE";
      e.duplicates = after.duplicates;
      throw e;
    }
    for (const {object, winner, hidden} of after.overridden) {
      if (!stack.overridden.some((o) => o.object === object)) {
        log(`overridden: ${object}: ${hidden.join(", ")} hidden by ${winner}`);
      }
    }
    const own = ownConfig(root, config, after, join(tmp, "output"), options.overlay);
    writeFileSync(join(tmp, "abap_transpile.json"), JSON.stringify(own, null, 2));
    // the transpile itself is a library call in this process (N3,
    // tools/osd-transpile.mjs): no node_modules/.bin, no second process,
    // no parsing a count out of its output
    log("transpile");
    // **The bytes the generation is named by are the bytes it is built
    // from.** A save that lands between the hash above and the transpiler's
    // read would build other bytes under this name; it is refused instead,
    // and the next build names what is there then
    const changed = [];
    const generatedDigests = new Map();
    const made = await transpile({root, modules: loaded, config: own, log: (m) => { output += m + "\n"; },
      onInputs: (files, libs) => keepCompileInputs(root, tmp, own, files, libs, options.overlay),
      onRead: (file, bytes) => {
        const generated = normalPath(file).startsWith(normalPath(join(root, "gen")) + "/");
        if (generated) generatedDigests.set(normalPath(file), createHash("sha256").update(bytes).digest("hex"));
        // a link in gen/ to elsewhere is read from elsewhere, and judged there
        if (!generated || !normalPath(realpathSync(file)).startsWith(normalPath(realpathSync(join(root, "gen"))) + "/")) readEntries.push(readEntry(root, file, bytes));
        const known = digests.get(normalPath(file));
        if (known !== undefined && createHash("sha256").update(bytes).digest("hex") !== known) throw changedError(root, [file]);
      }});
    // and nothing the generators or the transpiler read was written since
    // it was named
    assertToolchain(root, loaded);
    changed.push(...watched.filter((file) => stampOf(file) !== stamps.get(file)));
    if (changed.length > 0) throw changedError(root, changed);
    keepSourceInputs(root, tmp, digests, undefined, options.overlay);
    keepGeneratedSources(root, tmp, generatedDigests);
    materializeSourceSnapshot(root, tmp); // Include compiler-only inputs such as $TMP's tadir.json on every build.
    completeSourceSnapshot(tmp);
    const objects = made.objects;
    assertLoadable(join(tmp, "output"), {log}); // exit 0 is not a generation that loads: never named unless it parses, no import cycle

    const generated = readGeneratorLog(readsLog);
    readEntries.push(...generated.entries);
    rmSync(readsLog, {force: true});
    // The config is read by hashOf and controls the transpiler's own input
    // list. Keep it in the same record as the source bytes.
    readEntries.push(readEntry(root, inputs.config, readFileSync(inputs.config)));
    const readRecord = markIncomplete(makeReadRecord(root, named, readEntries), generated.incomplete);
    writeFileSync(join(tmp, READS), `${JSON.stringify(readRecord, null, 2)}\n`);

    const manifest = {
      sourceLayers: inputs.sourceLayers ?? [], ...generationSystem(root, inputs, readRecord.reads, readRecord),
      hash,
      builtAt: new Date().toISOString(),
      ms: Date.now() - started,
      objects,
      transpiler: describeBuild(root),
      toolchain: identity,
      inputs: {folders: inputs.folders.map((f) => relative(root, f)), libs: inputs.libs.map((f) => relative(root, f)),
        bspFolders: inputs.bspFolders.map(f => relative(root, f)), packFiles: inputs.packFiles.map(f => relative(root, f)), packFolders: inputs.packFolders.map(f => relative(root, f)),
        // the active copies an overlay added: a publisher reads them too (osd-tmp.mjs)
        overlay: overlayFilesOf(root, options.overlay)},
      // What `gen/` held when this generation was made. `gen/` is an OUTPUT
      // and is out of the hash (it used to be in it, which made the name
      // self-referential) -- and taking it out removed an accidental
      // protection: a cache hit skips the generators, so `gen/` on disk can
      // be left holding a previous edit's output while `src/` says
      // otherwise. Measured: edit a view, build, restore the source, build
      // again -- the second build reuses the generation and three files
      // under `gen/` still hold the edit (2026-09-19). The served system is
      // right; the working tree is not, and the next thing to read `gen/`
      // believes it.
      gen: genHash(root),
      overridden: after.overridden,
    };
    writeFileSync(join(tmp, "manifest.json"), JSON.stringify(manifest, null, 2));
    // **The generation's own copy of the config described the process that
    // made it.** `output_folder` held the build's tmp path, pid and all, so
    // two builds of one generation differed in exactly one of 2249 files --
    // and the difference was a process id. An artefact addressed by the hash
    // of its inputs must not carry the number of the process that wrote it.
    // Nothing reads this copy after the build (every reader takes the root's
    // one), so it is rewritten to describe ITSELF: the output is at `output`,
    // relative to the generation (2026-09-19, B.9).
    writeFileSync(join(tmp, "abap_transpile.json"),
      JSON.stringify({...own, output_folder: "output"}, null, 2));
    linkRoots(root, tmp, config, log);

    mkdirSync(paths.byInput, {recursive: true});
    if (existsSync(target) && options.force === true) {
      // **Build, compare, report -- never both keep the name and change the
      // bytes** (backlog B.9). A generation is addressed by the hash of its
      // inputs so that a name means one set of bytes; a forced build that
      // replaced the directory gave a consumer pinned to `<hash>` different
      // content under an unchanged name, which is the thing immutability was
      // for.
      materializeSourceSnapshot(root, target);
      const verdict = compareGenerations(target, tmp);
      if (verdict.same) {
        log(`generation ${hash} rebuilt byte for byte: ${verdict.files} files` +
          (verdict.collapsed.length > 0 ? `, after ${verdict.collapsed.join("; ")}` : ""));
        rmSync(tmp, {recursive: true, force: true});
      } else if (options.replace === true) {
        // asked for, in so many words. Two renames rather than a remove and
        // a rename, so there is no moment at which the live link points at
        // nothing.
        const changed = [...verdict.differing, ...verdict.onlyInA, ...verdict.onlyInB];
        log(`generation ${hash} REPLACED, ${changed.length} files differ: ${changed.slice(0, 5).join(", ")}`);
        const replaced = `${target}.replaced.${process.pid}`;
        renameSync(target, replaced);
        renameSync(tmp, target);
        rmSync(replaced, {recursive: true, force: true});
      } else {
        // The interesting case, and it is a FINDING rather than a nuisance:
        // the same inputs produced different output, so the transpiler or the
        // builder changed under them. Saying so is the point; overwriting
        // would hide it.
        const changed = [...verdict.differing, ...verdict.onlyInA, ...verdict.onlyInB];
        rmSync(tmp, {recursive: true, force: true});
        const error = new Error(
          `generation ${hash} is NOT reproducible: ${changed.length} of ${verdict.files} files differ ` +
          `(${changed.slice(0, 5).join(", ")}${changed.length > 5 ? ", …" : ""}). The same inputs gave ` +
          "different output, so the transpiler or the builder changed under them -- which is a finding, " +
          "not a nuisance. Nothing was overwritten: a name that keeps its bytes is what a generation is " +
          "for. Pass --replace to take the new bytes under the same name anyway.");
        error.notReproducible = {hash, changed, files: verdict.files};
        throw error;
      }
    } else if (existsSync(target)) {
      // a build of the same inputs finished while this one ran (a race the
      // lock did not cover); theirs is as good as ours
      rmSync(tmp, {recursive: true, force: true});
    } else {
      renameSync(tmp, target);
    }
    if (warmUnchecked) {
      // the bytes under the name are a cold build's now
      rmSync(warmSide, {force: true});
    }
    if (options.switch !== false) {
      switchTo(root, hash, log);
    }
    built = {ok: true, hash, cached: false, live: liveHash(root) === hash, ms: manifest.ms, objects, output: options.verbose ? output : undefined, digests};
  } catch (error) {
    rmSync(tmp, {recursive: true, force: true});
    error.output = (error.output ?? "") || output;
    throw error;
  } finally {
    unlock();
  }
  // the pack's seed rows are made with the lock given back: the generation
  // is in place, and the capture is a child process
  await makePackSeeds(root, inputs, hash, log, named);
  return built;
}

// Packs whose seed rows are generator output make them here, as part of the
// build itself rather than of one caller of it: the command line is only one
// of the paths that end in a generation (a first start's ensureSourceBuild
// and a store's activation build are two more), and every one of them hands
// the runtime a pack whose rows the start then reads from data/ -- so the
// build makes them, a cache hit included (the rows are not tracked, and a
// reused generation is not a seeded one). Not tracked; the licence decision
// of 2026-11-09.
//
// Two things the call site owes the capture:
//   - the pack has to be one of THIS build's inputs, not a directory that
//     happens to sit beside them. OSD_WEB_PACKS builds a smaller system on
//     purpose (the VS Code web build's core+zork), and a pack the selection
//     left out has no generator in the output: it neither needs nor could
//     make its rows.
//   - the capture runs as a child, through osd-host the way every tool a
//     tool starts does. It boots the runtime of the generation it is handed
//     (--output, the one this build just made, so a --no-switch build and a
//     store's non-live one capture their own bytes and not the live
//     pointer's), and no process that is already serving or fronting a
//     system has a second runtime installed over it
//     (tools/adt-abap-kernel.mjs). Synchronous, as the generators above are.
//   - the child works on a database of its own. The environment it inherits
//     is the caller's, and the caller may be serving a persistent DuckDB
//     file that a second process cannot open at all -- seed-capture.mjs
//     clears STG_DB/STG_DB_PATH before it boots, so a capture is always the
//     runtime's throwaway in-memory SQLite and never the host's database,
//     whichever of the three roads started it.
async function makePackSeeds(root, inputs, hash, log, named) {
  if (inputs.packFiles.includes(join(root, "packs", "rap-flight", "osd-pack.json")) === false) return;
  // the tree's copy (its bytes are in the seed digest); a root that is only
  // sources (a test's scratch tree) has none, and then this checkout's is it
  const own = join(root, "tools", "rap-flight", "seed-capture.mjs");
  const script = existsSync(own) ? own : join(TOOLS, "rap-flight", "seed-capture.mjs");
  const {seedsDue} = await import(pathToFileURL(script).href);
  if (seedsDue(root) === false) return;
  const [cmd, ...argv] = toolCommand(script, ["--ensure", "--output", join(layout(root).byInput, hash, "output")]);
  const generation = join(layout(root).byInput, hash);
  const readsLog = join(generation, "seed-reads.jsonl");
  // the capture boots a runtime: its activation lock owner's pid and the
  // database image cache (.local/db/base, keyed by the digest of what made
  // it) are its own state, never source bytes of the rows it writes
  const env = {...process.env, OSD_ROOT: root, OSD_READ_EXCLUDE_PREFIXES: JSON.stringify([join(root, "packs/rap-flight/data"), join(root, ".local/activation"), join(root, ".local/db/base")]), OSD_BUILD_VERIFIED: buildVerified(root)};
  if (!hosted()) argv.unshift("--import", join(TOOLS, "osd-generator-reads.mjs"));
  for (const line of recordedRun(cmd, argv, root, env, readsLog, "seed-capture.mjs").split("\n")) {
    if (line.trim() !== "") log(line);
  }
  const seed = readGeneratorLog(readsLog);
  rmSync(readsLog, {force: true});
  const old = JSON.parse(readFileSync(join(generation, READS), "utf8"));
  const record = withSeedReads(root, named, old, seed);
  writeFileSync(join(generation, READS), `${JSON.stringify(record, null, 2)}\n`);
  const file = join(generation, "manifest.json");
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  Object.assign(manifest, generationSystem(root, inputs, record.reads, record));
  writeFileSync(file, JSON.stringify(manifest, null, 2));
}

export async function main(args) {
  const root = process.env.OSD_ROOT ?? process.cwd();
  // a build for publishing leaves $TMP out (tools/osd-tmp.mjs)
  if (args.includes("--publish")) { assertPublicSystem(root); forPublishing(process.env); }
  const say = (m) => console.log(`osd-build: ${m}`);
  const cmd = args.find((a) => !a.startsWith("--")) ?? "build";
  if (cmd === "list") {
    const all = generations(root);
    if (all.length === 0) {
      say("no generations yet");
    }
    for (const g of all) {
      say(`${g.live ? "*" : " "} ${g.hash}  ${g.builtAt}  ${g.objects} objects  ${g.ms} ms`);
    }
    return 0;
  }
  if (cmd === "switch") {
    const hash = args[args.indexOf("switch") + 1];
    switchTo(root, hash, say);
    return 0;
  }
  if (cmd === "gc") {
    const at = args.indexOf("--keep");
    const removed = gc(root, {keep: at >= 0 ? Number(args[at + 1]) : undefined});
    say(removed.length === 0 ? "nothing to remove" : `removed ${removed.join(", ")}`);
    return 0;
  }
  if (cmd === "hash") {
    say(hashOf(root));
    return 0;
  }
  try {
    const r = await build({root, force: args.includes("--force"), replace: args.includes("--replace"),
      switch: !args.includes("--no-switch"), log: say});
    say(`${r.cached ? "reused" : "built"} ${r.hash} in ${r.ms} ms, ${r.objects} objects${r.live ? ", live" : ""}`);
    return 0;
  } catch (error) {
    if (error.code === "OSD_VERSION_MISMATCH") console.error(error.message);
    else say(`${error.code ?? "FAILED"}: ${error.message}`);
    if (error.output) {
      console.error(String(error.output).slice(-3000));
    }
    say("live generation untouched");
    return 1;
  }
}

if (runsAs("osd-build.mjs")) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
