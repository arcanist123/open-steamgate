// The warm compile: one abaplint registry kept for as long as the process
// lives, so a save costs the objects it reaches and not the tree.
//
// A cold build (tools/osd-build.mjs) runs the generators and transpiles every
// object: ~11 s on this tree. Most saves are an edit to one method of one
// class, which changes that class and whatever reads it, and nothing a
// generator reads. For those, this keeps the registry of the live generation,
// replaces the changed file, and has the transpiler build only the objects the
// change reaches -- the edited ones and, transitively, their readers, taken
// from abaplint's scope references. The transpiler needs three changes for
// that, all proposed upstream (abaplint/transpiler#1898): the temporary names
// numbered per object (#1899), `only` (#1900), and a second run over the
// same registry that checks the chosen objects rather than everything
// (#1921). Without them `probe()` says so and every build stays cold.
//
// The generation it makes is an ordinary one: the live generation's files,
// hard-linked, with the rebuilt modules and the scripts written over them,
// named by the same hash of the inputs a cold build would give it and
// switched to the same way. Whether its bytes are a cold transpile's is not
// assumed: verify() transpiles the same inputs cold in a child process and
// compares, and until that has passed the generation is "warm-unverified".
// verify() reads frozen source/gen/library inputs, without running generators,
// so it checks this build, not the rule below against the generators.
//
// What is warm is decided file by file, and anything else is cold -- the
// generators read the tree too, and a change they would see has to reach
// them (see warmRule below).
import {keepCompileInputs} from "./osd-compile-snapshot.mjs";
import {verifyGeneration} from "./osd-warm-verify.mjs";
import {keepSourceInputs, linkGeneratedSources, completeSourceSnapshot, logicalSourcePath} from "./osd-source-snapshot.mjs";
import {startVerification, pruneVerification} from "./osd-warm-verification.mjs";
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, watch, writeFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve, sep} from "node:path";
import {fileURLToPath} from "node:url";
import {generatorIdentity, hashOf, inputsOf, layout, liveHash, lock, linkRoots, ownConfig, prepare, rootsWanted, switchTo} from "./osd-build.mjs";
import {sourceBuildOverlay, sourceBuildStore} from "./osd-source-build-view.mjs";
import {assertToolchain} from "./osd-transpiler.mjs";
import {mapStatementStarts} from "./osd-source-map-starts.mjs";
import {runsAs} from "./osd-main.mjs";
import {isBinaryFilename, listFiles, loadLibs, selectedModules, outputFiles, readAll} from "./osd-transpile.mjs";
import {lowerDerived, readRapBindings} from "./rap/lower-derived.mjs";
import {lowerNarrowSubmit} from "./osd-narrow-submit.mjs";
import {orderRegistry} from "./osd-warm-order.mjs";
import {updateRegistry} from "./osd-warm-update.mjs";
import {warmVerdict} from "./osd-hot.mjs";
import {interfacesLines, interfacesOf} from "./osd-warm-interfaces.mjs";
import {implementsContract} from "./osd-tran-registry.mjs";

import {checkView, checkRead} from "./osd-store-compile-view.mjs";
import {rowsFromRegistry} from "./osd-xref-seed.mjs";

export {warmVerdict};

// the tools folder, the way osd-build.mjs finds its generators: a binary
// runs `<binary> gen osd-warm.mjs` and only the basename matters there
const TOOLS = fileURLToPath(new URL(".", import.meta.url));

export class NotWarm extends Error {
  constructor(reason) {
    super(reason);
    this.code = "NOT_WARM";
  }
}

// ---------------------------------------------------------------------------
// the rule: which changed file may be built warm
//
// The generators of a cold build (osd-build.mjs GENERATORS) read the tree,
// and a change one of them would see must go through them. What they read of
// an ABAP source, found by reading each of them (2026-09-25):
//   - amdp-gen: every class with an AMDP body, and every interface as a type
//     source for those bodies;
//   - osd-tran-registry: whether a class names the transaction contract in
//     an INTERFACES line, and a report's source;
//   - osd-gui-convert (2026-09-26): a report's source (*.prog.abap), which
//     the rule below already sends cold -- only a class or an interface is
//     ever warm;
//   - rap/bdef-gen (2026-11-08, R2): a behavior pool's local handler and
//     saver classes, their methods and parameter names, which bind the
//     runtime adapter -- any class inheriting CL_ABAP_BEHAVIOR_HANDLER or
//     _SAVER is cold;
//   - cds2ddic, stg-compile, segw-*, osd-bsp-registry, osd-fm-registry:
//     other object types (DDLS, TABL, IWSV, WAPA, FUGR, YAML), and which
//     class files exist.
// So an edit is warm when it changes the content of a class or interface
// that already exists, outside gen/, with no AMDP body before or after, the
// same INTERFACES lines, and -- for an interface -- no AMDP class naming it.
// A new or removed file, any other object type, a library, the config, a
// page or a generator is cold. test/warm.mjs pins the generator list this
// was read against, so a new generator makes somebody read this again.
export const GENERATORS_READ = [
  "osd-transpiler.mjs", "osd-inputs.mjs", "osd-ddic-binary.mjs", "cds2ddic.mjs", "rap/bdef-gen.mjs", "stg-compile.mjs",
  "segw-registry.mjs", "segw-shlp.mjs", "osd-bsp-registry.mjs", "amdp-gen.mjs", "amdp-tablefunc.mjs",
  "osd-fm-registry.mjs", "osd-gui-convert.mjs", "osd-tran-registry.mjs",
];

const SOURCE = /\.(clas(\.(locals_imp|locals_def|testclasses|macros))?\.abap|intf\.abap|prog\.abap)$/i;
const AMDP = /BY\s+DATABASE\s+(PROCEDURE|FUNCTION)/i;

/** why a content edit may not be built warm, or undefined when it may */
export function warmRule({path, before, after, amdpText = ""}) {
  const name = basename(path);
  if (path.split(sep).includes("gen")) {
    return `${name}: a generated file`;
  }
  if (!SOURCE.test(name)) {
    return `${name}: not the source of a class, interface or include`;
  }
  if (/\.prog\.abap$/i.test(name) && /^\s*(REPORT|PROGRAM|FUNCTION-POOL|MODULE-POOL)\b/im.test(before + "\n" + after)) {
    return `${name}: a program declaration (report generators read it)`;
  }
  if (/\bSUBMIT\b/i.test(before + "\n" + after)) {
    return `${name}: a SUBMIT source is lowered during a cold build`;
  }
  if (/\bTYPE\s+(TABLE|STRUCTURE|RESPONSE|REQUEST)\s+FOR\b/i.test(before + "\n" + after)) {
    return `${name}: RAP derived types are lowered during a cold build`;
  }
  if (/\bINHERITING\s+FROM\s+cl_abap_behavior_(handler|saver)\b/i.test(before + "\n" + after)) {
    return `${name}: a behavior pool's handler or saver (rap-runtime-gen reads its methods)`;
  }
  if (AMDP.test(before) || AMDP.test(after)) {
    return `${name}: an AMDP body (amdp-gen reads it)`;
  }
  if (interfacesOf(before) !== interfacesOf(after) || interfacesLines(before) !== interfacesLines(after)
    || implementsContract(before) !== implementsContract(after)) {
    return `${name}: its INTERFACES lines changed (osd-tran-registry reads them)`;
  }
  if (/\.intf\.abap$/i.test(name)) {
    const intf = name.replace(/\.intf\.abap$/i, "");
    if (new RegExp(`\\b${intf.replace(/[^a-z0-9_]/gi, "\\$&")}\\b`, "i").test(amdpText)) {
      return `${name}: an AMDP class names it (amdp-gen reads it as a type source)`;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the import graph of a generation: which module imports which, by the
// specifiers the transpiler writes ("./x.clas.mjs"). A module a rebuild does
// not replace keeps its binding to the old instance of anything it imported,
// so a warm build refuses unless every importer of a rebuilt module is
// rebuilt as well -- the scope references are the plan, this is the check.
const SCRIPTS = new Set(["init.mjs", "_init.mjs", "index.mjs", "_unit_open.mjs", "_top.mjs"]);

export function importsOf(text) {
  const out = [];
  for (const m of text.matchAll(/\bimport\(\s*"(\.\/[^"]+\.mjs)"\s*\)|\bfrom\s+"(\.\/[^"]+\.mjs)"/g)) {
    out.push(decodeURIComponent((m[1] ?? m[2]).slice(2)));
  }
  return out;
}

/** why a set of rebuilt modules may not be swapped in: a module left in place imports one */
export function importerRefusal(importers, rebuiltFiles) {
  const rebuilt = new Set(rebuiltFiles);
  for (const m of rebuilt) {
    // the scripts are written by every build and loaded by no swap: the
    // process keeps the ones it started with, as their importers do
    if (SCRIPTS.has(m)) continue;
    for (const importer of importers.get(m) ?? []) {
      if (!rebuilt.has(importer)) {
        return `${importer} imports ${m} and is not rebuilt with it`;
      }
    }
  }
  return undefined;
}

export function importersOf(dir) {
  const importers = new Map();
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".mjs") || SCRIPTS.has(file)) continue;
    for (const target of importsOf(readFileSync(join(dir, file), "utf8"))) {
      if (!importers.has(target)) importers.set(target, new Set());
      importers.get(target).add(file);
    }
  }
  return importers;
}

// ---------------------------------------------------------------------------

export {probe} from "./osd-warm-capabilities.mjs";
import {probe} from "./osd-warm-capabilities.mjs";

const key = (o) => o.getType() + " " + o.getName();
const warmDiffers = (generationDir) => {
  try {
    return JSON.parse(readFileSync(`${generationDir}.warm.json`, "utf8")).differs !== undefined;
  } catch {
    return false;
  }
};
const statKey = (file) => {
  try {
    const st = statSync(file);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return "absent";
  }
};

// The modules tools/osd-serve.mjs imports itself and holds for the life of
// the process: a swap cannot reach its bindings, so a build that rebuilds one
// is recycled rather than swapped. test/warm.mjs keeps this list and the
// imports of osd-serve.mjs the same.
export const HOST_HELD = ["init.mjs", "cl_express_icf_shim.clas.mjs", "zcl_stg_segw_registry.clas.mjs",
  "zcl_stg_shlp_registry.clas.mjs", "zcl_apc_host.clas.mjs", "zcl_osd_status.clas.mjs", "zcl_osd_demo_data.clas.mjs",
  // held by a reference-case server (OSD_REFERENCE_CASES) for its UUID hook
  "cl_system_uuid.clas.mjs"];

// A generation's unchanged files are hard links of the live one's, which is
// what makes a warm build cost what it rebuilds. Where the filesystem will
// not link -- another device, a Windows volume that refuses, a file at its
// link limit -- the file is copied: slower, the same bytes.
const COPY_INSTEAD = new Set(["EXDEV", "EPERM", "ENOTSUP", "EMLINK", "EACCES", "ENOSYS"]);
export function linkOrCopy(from, to, link = linkSync) {
  try {
    link(from, to);
    return "link";
  } catch (error) {
    if (!COPY_INSTEAD.has(error?.code)) throw error;
    copyFileSync(from, to);
    return "copy";
  }
}

export class WarmCompiler {
  constructor(options = {}) {
    this.root = resolve(options.root ?? process.cwd());
    // the link a build makes the unchanged files with; a test can hand in one
    // that refuses, to take the copy path on a filesystem that would link
    this.link = options.link ?? linkSync;
    this.copies = 0;
    this.log = options.log ?? (() => {});
    this.modules = options.modules;
    // generations this made that verify() has not yet compared with a cold
    // transpile of the same inputs
    this.unverified = new Set();
    this.verifyDeadlineMs = options.verifyDeadlineMs ?? Number(process.env.OSD_WARM_VERIFY_LIFETIME_MS ?? 180000);
    // the same, on disk beside the generation (<hash>.warm.json), so a warm
    // generation found again later is still known to be unchecked
    this.swaps = 0;
    // **The build view, not the raw tree** (#460): the store keeps inactive
    // objects out of every build -- each as its last active copy, or absent
    // when it never had one -- and names the generation by that view. The
    // registry is primed from the same view, and an activation of a set S is
    // a warm edit of it: S's saved sources replace their copies, every other
    // inactive object keeps serving its copy. `overlay(S)` is the store's
    // (ObjectStore#overlay); without a caller's store, load the persistent one.
    this.overlayOf = options.overlay ?? (() => undefined);
    this.storeViewMissing = options.overlay === undefined;
    // the object a file belongs to, "TYPE NAME" (ObjectStore#objectKeyOf)
    this.keyOf = options.keyOf ?? (() => undefined);
    // the inactive objects and their copies (ObjectStore#inactiveSources)
    this.inactiveSources = options.inactiveSources ?? (() => []);
  }

  // A file is known by where it lives in the tree, whichever copy the view
  // reads it from: an inactive object's active copy under
  // build/inactive/active/<file> and its promoted source at <file> are one
  // file whose contents changed, which is what makes a promotion warm.
  #logical(path, overlay) {
    return logicalSourcePath(this.root, path, overlay);
  }

  // the view's files by their logical path: {actual: logical -> path, digests}
  #view(overlay, digests, config, stack) {
    const listing = ownConfig(this.root, config, stack, join(layout(this.root).tmp, "warm", "output"), overlay);
    const {wanted} = listFiles(this.root, listing);
    const actual = new Map(wanted.map((p) => [this.#logical(p, overlay), p]));
    const logicalDigests = new Map([...digests].map(([p, d]) => [this.#logical(p, overlay), d]));
    return {wanted, actual, digests: logicalDigests};
  }

  get primed() {
    return this.reg !== undefined;
  }

  async loadStoreView() {
    if (this.storeViewMissing) {
      const store = await sourceBuildStore(this.root);
      this.overlayOf = activating => store.overlay(activating);
      this.keyOf = file => store.objectKeyOf(file);
      this.inactiveSources = activating => store.inactiveSources(activating);
      this.storeViewMissing = false;
    }
  }

  // Load the live generation's inputs into a registry and transpile them
  // once, which is what makes the next save cheap. Refuses unless the tree
  // on disk is the live generation's and the result reproduces its files.
  async prime() {
    await this.loadStoreView();
    const started = Date.now();
    this.reg = undefined;
    const root = this.root;
    const loaded = selectedModules(root, this.modules);
    const transpiler = assertToolchain(root, loaded);
    this.loaded = loaded;
    const {Transpiler, Chunk, core, plugin} = loaded;
    mapStatementStarts(Chunk);
    if (plugin !== undefined) {
      throw new NotWarm("a transpiler plugin is installed, and `only` is ignored with one");
    }
    const missing = await probe(Transpiler, core);
    if (missing !== undefined) {
      throw Object.assign(new NotWarm(missing), {pinMissing: true});
    }
    const live = liveHash(root);
    if (live === undefined) {
      throw new NotWarm("there is no live generation to start from");
    }
    const {config, stack} = prepare(root);
    // the libraries are pinned clones and most of the inputs; a watcher per
    // library lets a build reuse their walk until something moves in one
    this.#watchLibraries(inputsOf(root, config).libs);
    const overlay = this.overlayOf(new Set());
    checkView(root, this.compileView, overlay);
    const raw = new Map();
    const hash = hashOf(root, inputsOf(root, config), {digests: raw, folders: this.folders, transpiler, overlay});
    // the view names the generation it would build; one saved since the live
    // generation was built names it differently (an object now inactive is
    // read from its active copy, the bytes the live generation was built
    // from, under another path) -- so a name that differs is only a reason
    // to look closer when inactive objects are read from copies, and the
    // full run below, byte for byte, is the premise either way
    const copied = overlay?.folder !== undefined;
    const proved = hash === live;
    if (!proved && !copied) {
      throw new NotWarm(`the tree is not the live generation (${hash} on disk, ${live} live); a cold build comes first`);
    }
    const paths = layout(root);
    // the output folder the source maps are relative to: the same depth as a
    // cold build's build/tmp/<hash>.<pid>/output, so the paths come out alike
    const own = ownConfig(root, config, stack, join(paths.tmp, "warm", "output"));
    if ((config.libs ?? []).some((l) => l.folder === undefined || l.folder === "" || !existsSync(root + l.folder))) {
      throw new NotWarm("a library is cloned from its URL rather than read from a folder");
    }
    const view = this.#view(overlay, raw, config, stack);
    const wanted = view.wanted;
    const digests = view.digests;
    const rapBindings = readRapBindings(root, checkRead(this.compileView));
    const read = await readAll(wanted, resolve(root, own.output_folder),
      (source, filename) => lowerDerived(lowerNarrowSubmit(source, filename, core), filename, rapBindings), checkRead(this.compileView));
    this.files = new Map(wanted.map((path, i) => [this.#logical(path, overlay), read[i]]));
    this.actual = new Map(view.actual);
    // where the live generation read each copied file from: its copy, when
    // the object was inactive at that build, or its source in the tree, when
    // it was saved since -- read off the live source map, so the full run
    // reproduces it and the next build that reads the copy rebuilds it
    const liveOut = join(paths.byInput, live, "output");
    const copiesAt = relative(resolve(root, own.output_folder), resolve(root, overlay?.folder ?? join("build", "inactive", "active")));
    for (const [logical, path] of view.actual) {
      if (logical === path) continue;
      const name = basename(logical).split(".").slice(0, 2).join(".");
      let map = "";
      try {
        map = readFileSync(join(liveOut, `${name}.mjs.map`), "utf8");
      } catch {
        // no map: where it was read from names nothing
      }
      if (map.includes(copiesAt.split(sep).join("/"))) continue;
      this.actual.set(logical, logical);
      this.files.get(logical).relative = relative(resolve(root, own.output_folder), dirname(logical));
    }
    // A view that names the live generation differently is primed only on
    // proof that the difference is the saves since and nothing else: the
    // live view rebuilt -- those objects read from the tree, as live read
    // them, each file counted with the digest of its active copy, the bytes
    // live was built from -- must hash to the live name exactly. Every other
    // input is in that hash as it is now: a YAML or any other generator
    // input changed since, a library, the config, the generators. A full run
    // of the registry could not see those (it transpiles today's gen/), and
    // neither can the comparison, so without this a corrupt .stg.yaml was
    // built warm over (critic on ab4ded7c).
    if (!proved) {
      const keys = new Set();
      const substitute = new Map();
      for (const [logical, path] of view.actual) {
        if (this.actual.get(logical) !== logical || logical === path) continue;
        const key = this.keyOf(relative(root, logical));
        if (key === undefined) throw new NotWarm(`${relative(root, logical)} is read from a copy and belongs to no object`);
        keys.add(key);
        substitute.set(resolve(logical), createHash("sha256").update(readFileSync(path)).digest("hex"));
      }
      // Includes created since live have no active copy. Putting a saved
      // object's existing files back must also remove those new files from
      // this proof, just as the ordinary inactive view excludes them.
      const absent = this.inactiveSources(new Set()).filter(entry => keys.has(entry.key)).flatMap(entry => entry.files)
        .map(file => resolve(root, file.file)).filter(file => !view.actual.has(file));
      const restored = this.overlayOf(keys);
      const back = hashOf(root, inputsOf(root, config), {transpiler,
        overlay: {...restored, exclude: [...(restored?.exclude ?? []), ...absent]}, substitute});
      if (back !== live) {
        throw new NotWarm(`the tree is not the live generation (${hash} on disk, ${live} live, ${back} with the saves since put back); a cold build comes first`);
      }
      // and in the order live read them: a file read from its copy is listed
      // after the tree, and the order the registry holds its objects in is
      // the order init.mjs loads them
      const order = listFiles(root, ownConfig(root, config, stack, join(paths.tmp, "warm", "output"), this.overlayOf(keys))).wanted;
      const files = new Map();
      for (const p of order) {
        const logical = this.#logical(p, overlay);
        if (this.files.has(logical)) files.set(logical, this.files.get(logical));
      }
      for (const [logical, f] of this.files) if (!files.has(logical)) files.set(logical, f);
      this.files = files;
    }
    const libs = await loadLibs(root, own, undefined, checkRead(this.compileView));
    const reg = new core.Registry();
    for (const f of this.files.values()) reg.addFile(new core.MemoryFile(f.filename, f.contents));
    for (const l of libs) reg.addDependency(new core.MemoryFile(l.filename, l.contents));
    orderRegistry(reg, core, this.files.values(), libs);
    const settings = {...own.options};
    if (own.write_source_map !== true) settings.ignoreSourceMap = true;
    const output = await new Transpiler(settings).run(reg);

    // the premise, checked rather than assumed: this registry gives the live
    // generation's bytes
    const differing = outputFiles(output, own, liveOut, [...this.files.values()])
      .filter((f) => !existsSync(f.path) || readFileSync(f.path, isBinaryFilename(f.path) ? "latin1" : "utf8") !== f.contents)
      .map((f) => basename(f.path));
    if (differing.length > 0) {
      throw new NotWarm(`a full run of the kept registry differs from the live generation in ${differing.length} files (${differing.slice(0, 3).join(", ")})`);
    }

    this.libs = libs;
    this.Transpiler = Transpiler;
    this.core = core;
    this.config = config;
    this.own = own;
    this.settings = settings;
    this.hash = live;
    this.identity = {config: readFileSync(layout(root).config, "utf8"), transpiler, generators: generatorIdentity(root), layers: JSON.stringify(inputsOf(root, config))};
    this.amdpText = [...this.files.values()].filter((f) => AMDP.test(f.contents)).map((f) => f.contents).join("\n");
    this.pending = new Set();
    // a file's text in the registry, where it differs from the last
    // generation's (an edit the transpiler refused)
    this.held = new Map();
    this.digests = digests;
    this.reg = reg;
    this.#index();
    this.importers = importersOf(liveOut);
    this.wanted = rootsWanted(join(paths.byInput, live), config);
    this.log(`warm: primed ${this.files.size} files in ${Date.now() - started} ms`);
    return {ms: Date.now() - started, files: this.files.size, objects: output.objects.length};
  }

  // Advance after a cold publication; a failed proof invalidates the registry.
  async update(activating = new Set()) {
    try {
      return await updateRegistry(this, activating, {
        viewOf: (...args) => this.#view(...args), closure: objects => this.#closure(objects),
        index: () => this.#index(), rule: warmRule, importersOf, NotWarm,
      });
    } catch (error) {
      this.log(`warm: re-prime: ${error.message}`);
      this.drop();
      throw error;
    }
  }

  // A library folder's walk is kept for as long as its watcher has heard
  // nothing. A folder whose watcher cannot be set up, or reports an error,
  // is walked every time, which is only slower.
  #watchLibraries(libs) {
    this.close();
    this.folders = new Map();
    this.watchers = [];
    const kept = new Set();
    for (const dir of libs) {
      try {
        const w = watch(dir, {recursive: true, persistent: false}, () => this.folders.delete(dir));
        w.on("error", () => {
          kept.delete(dir);
          this.folders.delete(dir);
        });
        this.watchers.push(w);
        kept.add(dir);
      } catch {
        // walked every time
      }
    }
    // only the watched folders are kept; the rest is forgotten after each use
    const folders = this.folders;
    const set = folders.set.bind(folders);
    folders.set = (dir, entries) => (kept.has(dir) ? set(dir, entries) : folders);
  }

  // What an edit of this object would rebuild: the object and, transitively,
  // everything that reads it, from the reverse index -- without building.
  // What the tests of an edit are (B1) is this list filtered to the classes
  // that carry tests. undefined when the registry is not primed or does not
  // hold the object.
  closureOf(type, name) {
    if (!this.primed) return undefined;
    const obj = this.reg.getObject(type, name);
    if (obj === undefined) return undefined;
    return [...this.#closure([obj])].map((o) => ({type: o.getType(), name: o.getName()}));
  }

  // Who reads this object directly, from the reverse index the last build
  // left. The serving child refreshes its derived rows under the swap lock;
  // this index also works before a runtime starts. undefined when the
  // registry is not primed or does not hold the object.
  readersOf(type, name) {
    if (!this.primed) return undefined;
    const obj = this.reg.getObject(type, name);
    if (obj === undefined) return undefined;
    return [...(this.readers.get(key(obj)) ?? [])].map((o) => ({type: o.getType(), name: o.getName()}));
  }

  // The issues the checked registry holds for these objects, with the line
  // and column of each, for a client that shows them on the dependent's own
  // file rather than as one "activation failed"
  #issuesOf(objects) {
    const out = [];
    for (const o of objects) {
      const issues = this.reg.findIssuesObject(o).map((i) => ({
        message: i.getMessage(), key: i.getKey(), severity: String(i.getSeverity?.() ?? "Error"),
        file: i.getFilename(), line: i.getStart().getRow(), column: i.getStart().getCol(),
      }));
      if (issues.length > 0) out.push({type: o.getType(), name: o.getName(), issues});
    }
    return out;
  }

  // Borrow the live registry for a check, without changing its build view,
  // publishing a generation or retaining the editor's text. Invalidate the
  // readers as well: checking a renamed method against cached callers lies.
  async check({type, name, source, include = "main"}) {
    if (!this.primed) throw new NotWarm("not primed");
    if (liveHash(this.root) !== this.hash || this.#changes().edits.length) throw new NotWarm("the active sources changed");
    const object = this.reg.getObject(type === "INCL" ? "PROG" : type, name.toUpperCase());
    if (!object) throw new NotWarm("the check object is not in the live registry");
    const suffix = {definitions: "locals_def", implementations: "locals_imp"}[include] ?? include;
    const ending = type === "CLAS" && include !== "main" ? `.clas.${suffix}.abap` : `.${type === "INTF" ? "intf" : type === "CLAS" ? "clas" : "prog"}.abap`;
    const file = [...this.files.values()].find(f => basename(f.filename).toLowerCase() === name.toLowerCase() + ending);
    if (!file) throw new NotWarm("the check source is not in the live registry");
    const before = this.reg.getFileByName(file.filename);
    const affected = [...this.#closure([object])];
    try {
      this.reg.updateFile(new this.core.MemoryFile(file.filename, source));
      for (const o of affected) o.setDirty();
      this.reg.parse();
      const found = this.#issuesOf(affected);
      return {type, name, warm: true, issues: found.flatMap(entry => entry.issues.map(issue => ({...issue, type: entry.type, name: entry.name, severity: "E",
        message: entry.name === name.toUpperCase() ? issue.message : `${entry.type} ${entry.name}: ${issue.message}`})))};
    } finally {
      this.reg.updateFile(before);
      for (const o of affected) o.setDirty();
      this.reg.parse();
    }
  }

  // forget the registry; the next build is cold, and prime() starts again
  drop() {
    this.reg = undefined;
    this.unverified.clear();
    this.close();
  }

  close() {
    for (const w of this.watchers ?? []) w.close();
    this.watchers = [];
  }

  // who reads whom, from the scope references abaplint resolved
  #index(only) {
    const core = this.core;
    if (this.owner === undefined || only === undefined) {
      this.owner = new Map();
      for (const o of this.reg.getObjects()) for (const f of o.getFiles()) this.owner.set(f.getFilename(), o);
      this.reads = new Map();
      this.readers = new Map();
      this.unresolved = new Set();
    }
    const objects = only === undefined ? [...this.reg.getObjects()] : only;
    for (const o of objects) {
      if (!(o instanceof core.ABAPObject)) continue;
      this.unresolved.delete(o);
      for (const t of this.reads.get(key(o)) ?? []) this.readers.get(t)?.delete(o);
      const reads = new Set();
      // INCLUDE is a dependency even when its body declares no identifier
      // the consumer references (for example, it only writes a literal).
      for (const file of o.getABAPFiles()) for (const statement of file.getStatements()) {
        if (!(statement.get() instanceof core.Statements.Include)) continue;
        const name = statement.findFirstExpression(core.Expressions.IncludeName)?.concatTokens();
        const included = name && this.reg.getObject("PROG", name);
        if (included && included !== o) reads.add(key(included));
      }
      const top = new core.SyntaxLogic(this.reg, o).run().spaghetti?.getTop();
      const stack = top === undefined ? [] : [top];
      while (stack.length > 0) {
        const n = stack.pop();
        for (const r of n.getData().references) {
          if (r.resolved === undefined) this.unresolved.add(o);
          const t = this.owner.get(r.resolved?.getFilename?.());
          if (t !== undefined && t !== o) reads.add(key(t));
        }
        stack.push(...n.getChildren());
      }
      this.reads.set(key(o), reads);
      for (const t of reads) {
        if (!this.readers.has(t)) this.readers.set(t, new Set());
        this.readers.get(t).add(o);
      }
    }
  }

  #closure(objects) {
    const set = new Set(objects);
    const todo = [...objects];
    while (todo.length > 0) {
      for (const r of this.readers.get(key(todo.pop())) ?? []) {
        if (!set.has(r)) {
          set.add(r);
          todo.push(r);
        }
      }
    }
    return set;
  }

  // what changed on disk since the registry was last brought in line with it,
  // and whether all of it may be built warm; throws NotWarm with the reason
  #changes(activating = new Set()) {
    const root = this.root;
    const {config, stack} = prepare(root);
    // the transpiler that builds this is the one loaded when it was primed;
    // one relinked on disk since would name a generation it did not build
    const transpiler = assertToolchain(root, this.loaded);
    // the view this build makes live: S promoted, every other inactive
    // object as its copy -- the overlay a cold build of S would read
    const overlay = this.overlayOf(activating);
    checkView(root, this.compileView, overlay);
    const raw = new Map();
    const hash = hashOf(root, inputsOf(root, config), {digests: raw, folders: this.folders, transpiler, overlay});
    const view = this.#view(overlay, raw, config, stack);
    const digests = view.digests;
    // First save into a ZIP overlay relocates an existing complete object.
    // Retain its registry file and old digest while rebuilding source maps
    // for the new physical source. Other additions still require cold build.
    let relocated = false;
    for (const layer of inputsOf(root, config).sourceLayers ?? []) {
      if (!layer.overlayOf) continue;
      for (const path of view.actual.keys()) {
        const prefix = resolve(root, layer.path) + sep;
        if (!path.startsWith(prefix) || this.files.has(path)) continue;
        const base = resolve(root, layer.overlayOf, relative(prefix, path));
        if (!this.files.has(base) || view.actual.has(base)) continue;
        relocated = true;
        this.files.set(path, this.files.get(base)); this.files.delete(base);
        if (this.digests.has(base)) this.digests.set(path, this.digests.get(base));
        if (this.actual.has(base)) this.actual.set(path, this.actual.get(base));
        this.actual.delete(base);
        if (this.held.has(base)) {this.held.set(path, this.held.get(base)); this.held.delete(base);}
      }
    }
    if (relocated) {
      // Enumeration determines init script order. Match a fresh registry's
      // input walk while retaining parsed objects and their dependency links.
      const ordered = new Map();
      for (const path of view.wanted) {
        const file = this.files.get(this.#logical(path, overlay));
        const object = file && this.owner.get(file.filename);
        if (object) ordered.set(key(object), object);
      }
      for (const object of this.reg.getObjects()) if (!ordered.has(key(object))) ordered.set(key(object), object);
      this.reg.getObjects = function* () {yield* ordered.values();};
    }
    // what the digests say changed, and what the registry holds ahead of the
    // generation (an edit refused, since reverted: the same digest again)
    const changed = [...new Set([...[...digests.keys()].filter((p) => this.digests.get(p) !== digests.get(p)), ...this.held.keys()])];
    for (const p of this.digests.keys()) {
      if (!digests.has(p)) throw new NotWarm(`${relative(root, p)} is gone`);
    }
    const identity = {config: readFileSync(layout(root).config, "utf8"), transpiler, generators: generatorIdentity(root), layers: JSON.stringify(inputsOf(root, config))};
    for (const k of Object.keys(identity)) {
      if (identity[k] !== this.identity[k]) throw new NotWarm(`the ${k} changed`);
    }
    if (stack.duplicates.length > 0) throw new NotWarm("duplicates");
    const now = new Set(view.actual.keys());
    for (const path of now) if (!this.files.has(path)) throw new NotWarm(`${relative(root, path)} is new`);
    for (const path of this.files.keys()) if (!now.has(path)) throw new NotWarm(`${relative(root, path)} is gone`);
    const edits = [];
    // a file the view now reads from elsewhere -- an inactive object's copy
    // in place of its source, or its source again -- with the same bytes:
    // nothing to compile differently, but its source map points where it is
    // read from, and a cold build of this view would say the copy
    for (const [path, now] of view.actual) {
      const known = this.files.get(path);
      if (known === undefined || changed.includes(path) || this.actual.get(path) === now) continue;
      edits.push({path, file: known, after: known.contents, held: this.held.get(path) ?? known.contents, moved: true});
    }
    for (const path of changed) {
      const known = this.files.get(path);
      if (known === undefined) {
        throw new NotWarm(`${relative(root, path)} changed, and it is not a source the transpiler reads`);
      }
      // the bytes the generation is named by are the bytes it is built from:
      // read once, and refused when a save landed between the hash and here
      const bytes = readFileSync(view.actual.get(path));
      if (createHash("sha256").update(bytes).digest("hex") !== digests.get(path)) {
        throw new NotWarm(`${relative(root, path)} changed while it was read`);
      }
      const after = bytes.toString("utf8");
      // what the registry holds may be ahead of the last generation: an edit
      // the transpiler refused stays in it, and a revert of that edit is a
      // change to the registry although it is none to the generation
      const held = this.held.get(path) ?? known.contents;
      if (after === known.contents && after === held) continue;
      const reason = warmRule({path: relative(root, path), before: known.contents, after, amdpText: this.amdpText});
      if (reason !== undefined) throw new NotWarm(reason);
      edits.push({path, file: known, after, held});
    }
    return {hash, edits, digests, transpiler, overlay, actual: view.actual};
  }

  // The build: the edited objects and their readers, into a generation of
  // the new inputs' name, under the build lock from the first read to the
  // switch. Throws NotWarm when the change is not one this may build (the
  // caller builds cold, and drops the registry); throws an Error with
  // `check: true` and `output` when the transpiler refuses the change, and
  // then nothing is switched and the registry keeps the edit to build with
  // the next save. What this knows about the tree -- the files' contents, the
  // digests, the live hash -- changes only once the new generation is live.
  async build(activating = new Set()) {
    const started = Date.now();
    if (!this.primed) throw new NotWarm("not primed");
    const root = this.root;
    const paths = layout(root);
    // a cold build holding the lock is refused with BUSY and nothing changed
    const unlock = lock(paths);
    let settled = false;
    let mutated = false;
    let preserve = false;
    try {
      const from = liveHash(root);
      if (from !== this.hash) {
        throw new NotWarm(`the live generation moved under the warm registry (${from}, not ${this.hash})`);
      }
      const marks = [];
      const mark = (what) => marks.push([what, Date.now()]);
      mark("start");
      const {hash, edits, digests, transpiler, overlay, actual} = this.#changes(activating);
      mark("changes");
      const changed = [];
      mutated = true;
      for (const {path, file, after, held} of edits) {
        if (after !== held) {
          this.reg.updateFile(new this.core.MemoryFile(file.filename, after));
          this.held.set(path, after);
        }
        changed.push(this.owner.get(file.filename));
      }
      // where each file is read from in this view: a promoted file from the
      // tree, an inactive one from its copy -- what its source map names,
      // as a cold build of the view would
      const out = resolve(root, this.own.output_folder);
      const located = (path, f) => (actual.has(path) ? {...f, path: actual.get(path), relative: relative(out, dirname(actual.get(path)))} : f);
      const commit = () => {
        for (const {path, file, after} of edits) {
          file.contents = after;
          file.sourceDigest = digests.get(path);
          file.relative = located(path, file).relative;
          this.held.delete(path);
        }
        this.digests = digests;
        this.actual = actual;
        this.pending = new Set();
      };
      const stale = this.#closure([...changed, ...this.pending]);
      if (hash === from && stale.size === 0) {
        commit();
        settled = true;
        const unverified = warmVerdict(join(paths.byInput, hash)) === false;
        if (unverified) this.unverified.add(hash);
        this.pruneVerification();
        return {ok: true, hash, cached: true, warm: true, unverified, live: true, ms: Date.now() - started, modules: [], hostHeld: [], stale: 0, from,
          closure: [], xrefRows: {CROSS: [], WBCROSSGT: [], WBCROSSGTX: [], D010INC: []}};
      }
      const files = new Map([...actual.keys()].map(path => [path, this.files.get(path)]));
      orderRegistry(this.reg, this.core, files.values(), this.libs);
      const sources = [...files].map(([path, f]) => {
        const edit = edits.find(e => e.path === path);
        return located(path, edit ? {...f, contents: edit.after, sourceDigest: digests.get(path)} : f);
      });
      const names = new Set([...stale].map(key));
      let output;
      try {
        output = await new this.Transpiler({...this.settings, only: (o) => names.has(key(o))}).run(this.reg);
      } catch (error) {
        // the registry holds the edit and the rest stays as it was, so the
        // next save sees this file as changed again and builds all of it
        this.pending = stale;
        error.check = true;
        error.output = String(error.message);
        error.issues = this.#issuesOf([...stale]);
        settled = true;
        throw error;
      }
      mark("transpile");
      this.#index([...stale]);
      mark("index");
      const closure = [...stale].map(o => ({type: o.getType(), name: o.getName()}));
      const xrefRows = await rowsFromRegistry(this.reg, closure);
      mark("xref");

      // the modules this replaces, and the check that nothing else holds one
      const liveOut = join(paths.byInput, from, "output");
      const written = outputFiles(output, this.own, liveOut, sources);
      const modules = written.map((f) => basename(f.path))
        .filter((f) => f.endsWith(".mjs") && !SCRIPTS.has(f) && !f.endsWith(".testclasses.mjs"));
      const refusal = importerRefusal(this.importers, written.map((f) => basename(f.path)));
      if (refusal !== undefined) throw new NotWarm(refusal);
      mark("outputs");

      const target = join(paths.byInput, hash);
      // a generation a cold transpile was found to differ from is never
      // taken again: it is built anew (it cannot be the live one here, which
      // the store has rebuilt cold)
      if (hash !== from && warmDiffers(target)) {
        rmSync(target, {recursive: true, force: true});
        rmSync(`${target}.warm.json`, {force: true});
      }
      let cached = existsSync(join(target, "manifest.json"));
      // the roots the modules name: the live generation's, and whatever a
      // rebuilt module names that it did not
      const wanted = new Set(this.wanted);
      for (const f of written) {
        for (const m of f.contents.matchAll(/["'`]\.\.\/([^/"'`]+)\//g)) wanted.add(m[1]);
      }
      if (!cached) {
        const tmp = join(paths.tmp, `${hash}.${process.pid}.warm`);
        try {
          rmSync(tmp, {recursive: true, force: true});
          mkdirSync(join(tmp, "output"), {recursive: true});
          const replaced = new Set(written.map((f) => basename(f.path)));
          for (const f of readdirSync(liveOut)) {
            if (!replaced.has(f) && linkOrCopy(join(liveOut, f), join(tmp, "output", f), this.link) === "copy") this.copies++;
          }
          for (const f of written) {
            writeFileSync(join(tmp, "output", basename(f.path)), f.contents, isBinaryFilename(f.path) ? {encoding: "latin1"} : undefined);
          }
          linkOrCopy(join(paths.byInput, from, "abap_transpile.json"), join(tmp, "abap_transpile.json"), this.link);
          assertToolchain(root, this.loaded);
          const manifest = JSON.parse(readFileSync(join(paths.byInput, from, "manifest.json"), "utf8"));
          writeFileSync(join(tmp, "manifest.json"), JSON.stringify({
            hash, builtAt: new Date().toISOString(), ms: Date.now() - started, objects: manifest.objects,
            transpiler, toolchain: this.loaded.identity, inputs: manifest.inputs, gen: manifest.gen, overridden: manifest.overridden,
          }, null, 2));
          const sharedSources = keepSourceInputs(root, tmp, digests, actual, overlay,
            {generation: join(paths.byInput, from), digests: this.digests});
          if (!sharedSources) linkGeneratedSources(root, join(paths.byInput, from), tmp);
          keepCompileInputs(root, tmp, this.own, sources, this.libs, overlay);
          completeSourceSnapshot(tmp);
          linkRoots(root, tmp, this.config, undefined, {wanted});
          mkdirSync(paths.byInput, {recursive: true});
          // the note first: a generation must never be on disk under its name
          // without saying that nobody has compared it yet
          writeFileSync(`${target}.warm.json`, JSON.stringify({hash, from, builtAt: new Date().toISOString(), verified: false}, null, 2));
          renameSync(tmp, target);
        } catch (error) {
          rmSync(tmp, {recursive: true, force: true});
          throw error;
        }
      }
      mark("generation");
      const unverified = warmVerdict(target) === false;
      if (unverified) this.unverified.add(hash);
      this.pruneVerification();
      if (this.switch !== false) switchTo(root, hash, undefined, {wanted});
      mark("switch");
      commit();
      this.hash = hash;
      this.wanted = wanted;
      for (const m of written.map((f) => basename(f.path)).filter((f) => f.endsWith(".mjs") && !SCRIPTS.has(f))) {
        const text = readFileSync(join(target, "output", m), "utf8");
        for (const set of this.importers.values()) set.delete(m);
        for (const t of importsOf(text)) {
          if (!this.importers.has(t)) this.importers.set(t, new Set());
          this.importers.get(t).add(m);
        }
      }
      // the init script's order is the order modules can be loaded in
      const init = readFileSync(join(target, "output", "init.mjs"), "utf8");
      const order = new Map(importsOf(init).map((m, i) => [m, i]));
      modules.sort((a, b) => (order.get(a) ?? Infinity) - (order.get(b) ?? Infinity) || a.localeCompare(b));
      mark("importers");
      settled = true;
      const steps = Object.fromEntries(marks.slice(1).map(([w, t], i) => [w, t - marks[i][1]]));
      return {ok: true, hash, cached, warm: true, live: true, ms: Date.now() - started, objects: this.files.size,
        // Program modules execute at import time. Compile their closure warm,
        // but let a fresh runtime load it instead of executing it in a swap.
        modules, hostHeld: modules.filter((m) => HOST_HELD.includes(m) || m.endsWith(".prog.mjs")), stale: stale.size, from, steps,
        closure, xrefRows, unverified};
    } catch (error) {
      preserve = !mutated && error.code === "NOT_WARM";
      throw error;
    } finally {
      unlock();
      // anything that went wrong after the registry took the edit, other than
      // the transpiler's refusal, leaves nothing this can trust: prime again
      if (!settled && !preserve && this.reg !== undefined) {
        this.drop();
      }
    }
  }

  pruneVerification() { pruneVerification(this); }
  retainVerification(hashes) { pruneVerification(this, new Set(hashes)); }

  // Explicit shutdown only; cold publications cannot invalidate frozen inputs.
  cancelVerify(keep, why) {
    const child = this.verifying;
    if (!why || child === undefined || child.osdHash === keep || child.exitCode !== null) return false;
    child.osdCancelled = why;
    child.kill("SIGTERM");
    return true;
  }

  // Compare the generation with a fresh cold registry of its frozen inputs.
  verify(hash) {
    return startVerification(this, hash, join(TOOLS, "osd-warm.mjs"));
  }
}

if (runsAs("osd-warm.mjs") && process.argv[2] === "verify") {
  verifyGeneration(process.argv[3]).then((r) => {
    console.log(JSON.stringify(r));
    process.exit(0);
  }, (error) => {
    console.log(JSON.stringify({verdict: "failed", output: String(error?.stack ?? error)}));
    process.exit(1);
  });
}
