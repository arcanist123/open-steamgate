// Optional TS-HA checker linkage. No generated zlnt sources are copied or tracked.
import {createHash} from "node:crypto";
import {existsSync, readFileSync} from "node:fs";
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
 }
}
func init() {
 var spec lintSpec
 if err := json.Unmarshal([]byte(${JSON.stringify(JSON.stringify(spec))}), &spec); err != nil { panic(err) }
 makeLintCompiler = func(root string, other storecheck.Compiler) (*storelint.Compiler, string) {
  return configuredLintCompiler(root, other, newLintEngine(), spec), spec.Config
 }
}
`;
}
