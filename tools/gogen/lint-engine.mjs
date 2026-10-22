// Optional TS-HA/TS-HG checker linkage. Generated core sources stay external.
import {createHash} from "node:crypto";
import {copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, relative, resolve} from "node:path";

export function lintFolders(root, lib) {
  if (!lib) return [];
  const path = resolve(lib);
  if (!existsSync(join(path, "zcl_lnt_registry.clas.abap"))) throw new Error(`--lint-lib must name the full generated native/lib directory: ${path}`);
  return [path, join(root, "tools/step3/abap/src/lint")];
}

export async function lintBuildSpec(root) {
  const {ObjectStore} = await import("../osd-store.mjs");
  const {configuredRegistry, walkStoreFiles} = await import("../osd-store-registry.mjs");
  const {layers} = await import("../osd-inputs.mjs");
  const {storeConfig} = await import("./store.mjs");
  const {packsOf, placesOf} = await import("../osd-packs.mjs");
  const store = new ObjectStore({root});
  const hidden = layers(root, {input_folder: store.roots.map(r => r.path)}, process.env, {discoveryOnly: true}).hidden;
  const skip = new Set(hidden);
  const files = [...store.roots, ...store.libs].flatMap(r => r.files ?? walkStoreFiles(store, r.path, []))
    .filter(file => !skip.has(file) && /\.(abap|xml|asddls)$/.test(file)).map(file => "/" + file);
  // The same effective JSON as lint-oracle --export-adt-config, not lint rules.
  const config = JSON.stringify(configuredRegistry(store).registry.getConfig().get());
  const guards = {};
  for (const file of ["abaplint.jsonc", "abap_transpile.json", "libs.lock.json",
    ...packsOf(root).map(pack => relative(root, join(pack.dir, "osd-pack.json")))]) {
    guards[file] = createHash("sha256").update(readFileSync(join(root, file))).digest("hex");
  }
  const facts = await storeConfig(root, {store, storeModule: new URL("../osd-store.mjs", import.meta.url).href});
  // Active-version proofs are unrelated to checker inputs.
  const {roots, libs, excluded} = facts;
  const places = placesOf(root).map(path => relative(root, path));
  return {config, hidden, files, guards, places, store: {roots, libs, excluded}};
}

// Typed calls stay in package main beside the generated ABAP classes.
export function lintEngineGo(spec) {
  if (!spec) return "package main\n// ABAP lint not requested in this build.\n";
  return `package main
import (
 "encoding/json"
 "osg/gogen/lintinput"
 "osg/gogen/abap"
 "osg/gogen/objstore"
 "osg/gogen/storecheck"
 "osg/gogen/storelint"
)
func newLintEngine() storelint.Engine {
 // Private statics retain only this checker registry, never HTTP class state.
 s := &abap.Session{Statics: &abap.Statics{}}
 return storelint.Engine{
  Prime: func(files []objstore.LintFile, config string) {
   input := make([]ZCL_OSD_LINT_ENGINE__TY_FILE, 0, len(files))
   deps := []ZCL_OSD_LINT_ENGINE__TY_FILE{}
   for _, f := range files { input = append(input, ZCL_OSD_LINT_ENGINE__TY_FILE{filename: f.Filename, raw: f.Raw}) }
   ZCL_OSD_LINT_ENGINE_PRIME(s, &input, &deps, config)
  },
  Update: func(target string, raw *string) {
   text, remove := "", " "
   if raw == nil { remove = "X" } else { text = *raw }
   ZCL_OSD_LINT_ENGINE_UPDATE(s, target, text, remove)
  },
  Check: func(target string) []storelint.Issue {
   issues := ZCL_OSD_LINT_ENGINE_CHECK(s, target)
   out := make([]storelint.Issue, 0, len(issues))
   for _, i := range issues { out = append(out, storelint.Issue{Filename: i.filename, Key: i.key, Message: i.message, Row: i.start_row, Column: i.start_col}) }
   return out
  },
  Stats: func() storelint.Stats {
   r := ZCL_OSD_LINT_ENGINE_STATS(s)
   return storelint.Stats{Updates: r.updates, Noops: r.noops, IndexedObjects: r.indexed_objects,
    ReaderVisits: r.reader_visits, DirtiedObjects: r.dirtied_objects, ParseRuns: r.parse_runs, ParseObjects: r.parse_objects}
  },
 }
}
func init() {
 var spec lintinput.Spec
 if err := json.Unmarshal([]byte(${JSON.stringify(JSON.stringify(spec))}), &spec); err != nil { panic(err) }
 makeLintCompiler = func(root string, other storecheck.Compiler) (*storelint.Compiler, string) {
  return lintinput.New(root, other, newLintEngine(), spec), spec.Config
 }
}
`;
}

// Library output from abapiti --target go --go-package abaplint. Validate early,
// before the expensive OSG frontend. The module path is fixed by abapiti; its
// package name may vary, so the bridge always imports it with an explicit alias.
export function goLintLibrary(lib) {
  const path = resolve(lib);
  const mod = readFileSync(join(path, "go.mod"), "utf8");
  const api = readFileSync(join(path, "library.go"), "utf8");
  if (!/^module\s+zabaplint\s*$/m.test(mod) || !/^package\s+(?!main\b)\w+\s*$/m.test(api)) {
    throw new Error("--lint-lib for go requires abapiti's library output: --target go --go-package abaplint (module zabaplint)");
  }
  return path;
}

export function lintBuildOptions(args) {
  const option = name => {
    const at = args.indexOf(name);
    const value = at < 0 ? args.find(a => a.startsWith(name + "="))?.slice(name.length + 1) : args[at + 1];
    if ((at >= 0 || value !== undefined) && (!value || value.startsWith("--"))) throw new Error(`${name} requires a value`);
    return value;
  };
  const lib = option("--lint-lib");
  const engine = option("--lint-engine") ?? "abap";
  if (!["abap", "go"].includes(engine)) throw new Error("build --lint-engine must be abap or go");
  if (args.includes("--echo") && lib) throw new Error("--lint-lib requires the full OSGo build, not --echo");
  if (engine === "go" && !lib) throw new Error("--lint-engine go requires --lint-lib PATH");
  return {engine, lib: lib && (engine === "go" ? goLintLibrary(lib) : lib)};
}

// Run a build against a disposable modfile. Neither go.mod/go.sum nor the
// generated external library is copied into OSG or changed by this linkage.
export function withGoLintModule(goRoot, lib, build) {
  if (!lib) return build([]);
  const dir = mkdtempSync(join(tmpdir(), "osd-go-lint-module-"));
  const mod = join(dir, "go.mod");
  try {
    copyFileSync(join(goRoot, "go.mod"), mod);
    if (existsSync(join(goRoot, "go.sum"))) copyFileSync(join(goRoot, "go.sum"), join(dir, "go.sum"));
    execFileSync("go", ["mod", "edit", `-modfile=${mod}`, "-require=zabaplint@v0.0.0", `-replace=zabaplint=${lib}`], {cwd: goRoot, env: {...process.env, GOWORK: "off", GOPROXY: "off"}});
    return build([`-modfile=${mod}`]);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
}

export function goLintEngineGo(spec) {
  return `package main
import (
 "encoding/json"
 "osg/gogen/lintinput"
 lint "zabaplint"
 "osg/gogen/objstore"
 "osg/gogen/storecheck"
 "osg/gogen/storelint"
)
type goLintLibrary struct { checker lint.Checker }
func (l *goLintLibrary) Prime(files, deps []objstore.LintFile, config string) {
 convert := func(input []objstore.LintFile) []lint.File {
  out := make([]lint.File, 0, len(input))
  for _, f := range input { out = append(out, lint.File{Filename: f.Filename, Raw: f.Raw}) }
  return out
 }
 l.checker.Prime(convert(files), convert(deps), config)
}
func (l *goLintLibrary) Update(target string, raw *string) { l.checker.Update(target, raw) }
func (l *goLintLibrary) Check(target string) []storelint.Issue {
 issues := l.checker.Check(target)
 out := make([]storelint.Issue, 0, len(issues))
 for _, i := range issues { out = append(out, storelint.Issue{Filename: i.Filename, Key: i.Key, Message: i.Message, Row: i.Row, Column: i.Column}) }
 return out
}
func (l *goLintLibrary) Stats() storelint.Stats {
 r := l.checker.Stats()
 return storelint.Stats{Updates: r.Updates, Noops: r.Noops, IndexedObjects: r.IndexedObjects,
  ReaderVisits: r.ReaderVisits, DirtiedObjects: r.DirtiedObjects, ParseRuns: r.ParseRuns, ParseObjects: r.ParseObjects}
}
func newGoLintEngine() storelint.Engine { return storelint.NewGoEngine(&goLintLibrary{}) }
func init() {
 var spec lintinput.Spec
 if err := json.Unmarshal([]byte(${JSON.stringify(JSON.stringify(spec))}), &spec); err != nil { panic(err) }
 makeGoLintCompiler = func(root string, other storecheck.Compiler) (*storelint.Compiler, string) {
  return lintinput.New(root, other, newGoLintEngine(), spec), spec.Config
 }
}
`;
}
