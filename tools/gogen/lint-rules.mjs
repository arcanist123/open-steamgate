// Fixed compiled generation policy. Node discovery is build-time only.
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {delimiter, join, relative, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {packAt} from "../osd-packs.mjs";
import {rootsOf} from "../osd-store.mjs";
import {withTmp} from "../osd-store-tmp.mjs";
import {tmpDisabled} from "../osd-tmp.mjs";
import {userLayersOf, rootPackageInfo} from "../osd-source-layers.mjs";
import {libraryFiles} from "../osd-inputs.mjs";
import {activeSystem, layerDir, layerSource, logicalSystemPath} from "../osd-system.mjs";

const rel = (root, file) => relative(root, file).replaceAll("\\", "/");
const hash = file => existsSync(file) ? createHash("sha256").update(readFileSync(file)).digest("hex") : "missing";
const kind = file => {
  try { return statSync(file).isDirectory() ? "directory" : "other"; }
  catch (e) { if (["ENOENT", "ENOTDIR"].includes(e.code)) return "missing"; throw e; }
};

export function lintRules(root, facts, packs) {
  const cfg = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
  const system = activeSystem(root) ?? null;
  const configuredLibraries = (cfg.libs ?? []).filter(l => l.folder !== undefined && l.folder !== "");
  const libraries = libraryFiles(root, cfg, {includeMissing: true}).map((lib, index) => {
    const configured = configuredLibraries[index];
    return {folder: lib.folder, dir: rel(root, lib.dir), logical: rel(root, logicalSystemPath(root, lib.dir, system)),
      patterns: (typeof configured.files === "string" && configured.files !== "" ? [configured.files]
        : Array.isArray(configured.files) ? configured.files : ["/src/**"]).map(String),
      excludeTestclasses: true,
      excluded: (configured.exclude_filter ?? []).map(p => new RegExp(p, "i").source)};
  });
  const selected = packs.map(p => ({name: p.name, package: p.package,
    default: JSON.parse(readFileSync(join(p.dir, "osd-pack.json"), "utf8")).abap === undefined,
    abapCandidates: p.abapCandidates.map(c => rel(root, c))}));
  const keys = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY",
    ...Object.keys(process.env).filter(k => k.startsWith("OSD_LIB_"))];
  const environment = Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]));
  const guards = {...facts.guards};
  const guard = file => { guards[rel(root, file)] = hash(file); };
  guard(join(root, ".local/system/.osd-system.json"));
  for (const l of system?.layers ?? []) {
    guard(join(layerDir(root, l), ".osd-layer.json"));
    guard(join(layerDir(root, l), ".abapgit.xml"));
  }
  for (const input of (process.env.OSD_LAYERS ?? "").split(delimiter).filter(Boolean)) {
    const file = resolve(root, input);
    if (/\.zip$/i.test(file)) {
      guard(file);
      const id = hash(file);
      guard(join(root, "build/source-layers", id, ".osd-source-id"));
      guard(join(root, "build/source-layers", id, ".abapgit.xml"));
      guard(join(root, "local/overlays", id + ".meta.txt"));
    } else guard(join(file, ".abapgit.xml"));
  }
  for (const r of facts.store.roots) {
    guard(join(root, r.path, ".abapgit.xml"));
  }
  for (const p of packs) for (const s of p.sources) guard(join(s.dir, ".osd-source.json"));
  const states = {"local/tmp": kind(join(root, "local/tmp"))};
  const manifests = {};
  for (const place of facts.places) {
    const dir = resolve(root, place);
    if (kind(dir) !== "directory") continue;
    const candidates = existsSync(join(dir, "osd-pack.json")) ? [dir] : readdirSync(dir).map(n => join(dir, n));
    for (const c of candidates) if (existsSync(join(c, "osd-pack.json"))) {
      manifests[rel(root, join(c, "osd-pack.json"))] = hash(join(c, "osd-pack.json"));
      // packsOf validates unselected packs too, before applying selection.
      const pack = packAt(root, c);
      for (const dir of pack.directoryRequirements) states[rel(root, dir)] = kind(dir);
      for (const source of pack.sources) guard(join(source.dir, ".osd-source.json"));
    }
  }
  // Keep pack insertion slots even when no candidate currently exists. Listed
  // roots stay fixed; only discovered pack roots depend on candidate type.
  const listed = [cfg.input_folder ?? []].flat();
  const descriptor = r => ({path: r.path, writable: r.writable !== false, library: false,
    imported: r.imported === true, package: r.package ?? "", tmp: r.tmp === true,
    abapgit: r.abapgit, overlay: r.overlay ?? "", overlayOf: r.overlayOf ?? ""});
  const overrides = system ? [] : userLayersOf(root).map(descriptor);
  let plan;
  if (!system) {
    const fixed = withTmp(rootsOf(root, {...process.env, OSD_WEB_PACKS: ""}), root).map(descriptor);
    const effectiveListed = listed.filter(path => !tmpDisabled() || path !== "local/tmp");
    const before = effectiveListed.lastIndexOf("gen") < 0 ? effectiveListed.length : effectiveListed.lastIndexOf("gen");
    plan = fixed.map(r => ({root: r}));
    plan.splice(before, 0, ...selected.map(pack => ({pack, listed})));
  } else {
    plan = system.layers.flatMap(l => {
      if (l.kind === "pack") return [{pack: selected.find(p => p.name === l.name)}];
      if (!["input", "customer"].includes(l.kind)) return [];
      const path = rel(root, layerSource(root, l));
      return [{root: facts.store.roots.find(r => r.path === path)}];
    });
    plan.push({root: facts.store.roots.find(r => r.path === "gen")});
  }
  const metadataDirs = [...new Set([...facts.store.roots, ...plan.flatMap(s => s.root ? [s.root] : [])]
    .filter(r => r.abapgit?.declared).map(r => r.path))];
  const metadata = {};
  const inference = {};
  for (const dir of metadataDirs) if (kind(resolve(root, dir)) === "directory") {
    const names = readdirSync(resolve(root, dir));
    const decision = rootPackageInfo(resolve(root, dir), "__OSGO_FALLBACK__");
    if (decision.inferred) inference[dir] = decision.package;
    for (const name of names) if (name.endsWith(".devc.xml")) {
      const file = join(dir, name); metadata[file] = hash(resolve(root, file));
    }
  }
  const mappings = [];
  for (const l of system?.layers ?? []) {
    const dir = layerDir(root, l);
    if (["input", "customer"].includes(l.kind)) mappings.push({physical: rel(root, layerSource(root, l)), logical: l.name});
    mappings.push({physical: rel(root, dir), logical: rel(root, logicalSystemPath(root, dir, system))});
  }
  const rules = {version: 1, config: facts.config, roots: facts.store.roots, plan, overrides, excluded: facts.store.excluded,
    libraries, packs: selected, places: facts.places, factGuards: facts.guards, guards, environment, metadataDirs, metadata, inference, states, manifests, mappings, system: !!system};
  // Actually compile in Go RE2 as part of the build. Unsupported JS constructs
  // fail here, before a binary with silently different exclusions can be made.
  execFileSync("go", ["run", "./cmd/lintresolve", "--validate"], {
    cwd: fileURLToPath(new URL("./go/", import.meta.url)), input: JSON.stringify(rules),
    env: {...process.env, GOWORK: "off", GOPROXY: "off"}, stdio: ["pipe", "pipe", "pipe"],
  });
  return rules;
}
