// Fixed compiled generation policy. Node discovery is build-time only.
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readdirSync, statSync} from "node:fs";
import {delimiter, join, relative, resolve} from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
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
  const libraries = libraryFiles(root, cfg, {includeMissing: true}).map(lib => {
    const configured = cfg.libs.find(l => l.folder === lib.folder);
    return {folder: lib.folder, dir: rel(root, lib.dir), logical: rel(root, logicalSystemPath(root, lib.dir, system)),
      patterns: typeof configured.files === "string" && configured.files !== "" ? [configured.files]
        : Array.isArray(configured.files) ? configured.files : ["/src/**"],
      excluded: (configured.exclude_filter ?? []).map(p => new RegExp(p, "i").source)};
  });
  const selected = packs.map(p => ({name: p.name, package: p.package,
    default: JSON.parse(readFileSync(join(p.dir, "osd-pack.json"), "utf8")).abap === undefined,
    abapCandidates: p.abapCandidates.map(c => rel(root, c) || ".")}));
  const keys = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY",
    ...Object.keys(process.env).filter(k => k.startsWith("OSD_LIB_"))];
  const environment = Object.fromEntries(keys.map(k => [k, process.env[k] ?? null]));
  const guards = {...facts.guards};
  const guard = file => { guards[rel(root, file)] = hash(file); };
  guard(join(root, ".local/system/.osd-system.json"));
  for (const l of system?.layers ?? []) guard(join(layerDir(root, l), ".osd-layer.json"));
  for (const input of (process.env.OSD_LAYERS ?? "").split(delimiter).filter(Boolean)) {
    const file = resolve(root, input);
    if (/\.zip$/i.test(file)) guard(file);
    else guard(join(file, ".abapgit.xml"));
  }
  for (const r of facts.store.roots) {
    guard(join(root, r.path, ".abapgit.xml"));
    // Root-package inference is build policy: guard existing package metadata.
    if (existsSync(join(root, r.path))) for (const n of readdirSync(join(root, r.path))) {
      if (n.endsWith(".devc.xml")) guard(join(root, r.path, n));
    }
  }
  for (const p of packs) for (const s of p.sources) guard(join(s.dir, ".osd-source.json"));
  const manifests = {};
  for (const place of facts.places) {
    const dir = resolve(root, place);
    if (kind(dir) !== "directory") continue;
    const candidates = existsSync(join(dir, "osd-pack.json")) ? [dir] : readdirSync(dir).map(n => join(dir, n));
    for (const c of candidates) if (existsSync(join(c, "osd-pack.json"))) manifests[rel(root, join(c, "osd-pack.json"))] = hash(join(c, "osd-pack.json"));
  }
  // Keep pack insertion slots even when no candidate currently exists. Listed
  // roots stay fixed; only discovered pack roots depend on candidate type.
  const listed = [cfg.input_folder ?? []].flat();
  let plan;
  if (!system) {
    const packPaths = new Set(packs.flatMap(p => p.abap.map(f => rel(root, f))));
    const base = facts.store.roots.filter(r => !packPaths.has(r.path) || listed.includes(r.path));
    const before = listed.lastIndexOf("gen") < 0 ? listed.length : listed.lastIndexOf("gen");
    const slots = selected.map(pack => ({pack, listed}));
    plan = base.map(r => ({root: r}));
    plan.splice(before, 0, ...slots);
  }
  const mappings = [];
  for (const l of system?.layers ?? []) {
    const dir = layerDir(root, l);
    if (["input", "customer"].includes(l.kind)) mappings.push({physical: rel(root, layerSource(root, l)), logical: l.name});
    mappings.push({physical: rel(root, dir), logical: rel(root, logicalSystemPath(root, dir, system))});
  }
  const rules = {version: 1, config: facts.config, roots: facts.store.roots, plan, excluded: facts.store.excluded,
    libraries, packs: selected, places: facts.places, factGuards: facts.guards, guards, environment, states: {"local/tmp": kind(join(root, "local/tmp"))}, manifests, mappings, system: !!system};
  // Actually compile in Go RE2 as part of the build. Unsupported JS constructs
  // fail here, before a binary with silently different exclusions can be made.
  execFileSync("go", ["run", "./cmd/lintresolve", "--validate"], {
    cwd: fileURLToPath(new URL("./go/", import.meta.url)), input: JSON.stringify(rules),
    env: {...process.env, GOWORK: "off", GOPROXY: "off"}, stdio: ["pipe", "pipe", "pipe"],
  });
  return rules;
}
