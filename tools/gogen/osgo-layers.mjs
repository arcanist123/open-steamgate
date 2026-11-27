// The tiers of the osgo build (go-layers.mjs): which generated Go package a
// class, interface or DDIC type of OSG starts in.
//
//   core  the libraries (open-abap-core, the shim, open-abap-odata, ...):
//         change when a library pin moves, cached by Go across builds
//   app   the layers of the tree (src/, gen/, the packs): the system
//   main  the objects being edited, beside cmd/osgo itself: what a save
//         recompiles, together with whatever references them (promoted)
//
// "Being edited" is read off git: an object one of whose files under a layer
// folder is modified or untracked (`git status`), plus OSGO_HOT (comma list
// of object names). The tiers decide only how the Go is packaged; the program
// and its generation are the same for every choice (osgo.mjs hashes the
// unlayered emission).
import {execFileSync} from "node:child_process";
import {existsSync, readdirSync} from "node:fs";
import {join, relative} from "node:path";

const walk = (d) => !existsSync(d) ? [] : readdirSync(d, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
/** the object a file belongs to: zcl_x.clas.locals_imp.abap -> ZCL_X, #ui2#cl_json.clas.abap -> /UI2/CL_JSON */
export const objectOfFile = (file) => file.split("/").at(-1).split(".")[0].replaceAll("#", "/").toUpperCase();
// any file of such an object: zcl_x.clas.abap, .clas.locals_imp.abap,
// .clas.testclasses.abap, .clas.macros.abap, .clas.xml, zfg.fugr.lzfgu01.abap
const OBJECT_FILE = /^[^/.]+\.(clas|intf|fugr|tabl|ttyp|dtel|doma)\.([^/]+\.)?(abap|xml)$/;
const isObjectFile = (path) => OBJECT_FILE.test(path.split("/").at(-1));

/** the objects of the layer folders with a modified or untracked file */
export function editedObjects(home, layerFolders, env = process.env) {
  const rels = layerFolders.map((f) => relative(home, f)).filter((r) => r && !r.startsWith(".."));
  const hot = new Set(String(env.OSGO_HOT ?? "").split(",").map((x) => x.trim().toUpperCase()).filter(Boolean));
  if (rels.length === 0) return hot;
  let status = "";
  try {
    status = execFileSync("git", ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames", "--", ...rels],
      {cwd: home, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 26});
  } catch { return hot; } // not a git checkout: nothing is known to be edited
  for (const entry of status.split("\0")) {
    if (entry.length < 4 || entry[0] === "D" || entry[1] === "D") continue;
    const path = entry.slice(3);
    if (isObjectFile(path)) hot.add(objectOfFile(path));
  }
  return hot;
}

/**
 * The tier functions planLayers takes, for the osgo build.
 * @param {{home: string, layers: string[], libs: string[], hidden: Set<string>, hot: Set<string>}} o
 *   layers: the tree's folders; libs: the library folders (and extra ones,
 *   such as the lint engine's); hidden: files the build leaves out
 */
export function osgoTiers({layers, libs, hidden, hot}) {
  const fileOf = new Map();
  for (const f of [...layers, ...libs].flatMap(walk)) {
    if (hidden.has(f) || !isObjectFile(f)) continue;
    const name = objectOfFile(f);
    if (!fileOf.has(name)) fileOf.set(name, f);
  }
  const isLib = (file) => libs.some((dir) => file.startsWith(dir + "/"));
  const tierOf = (name, fallback) => {
    const file = fileOf.get(name);
    if (!file) return fallback;
    return isLib(file) ? 0 : hot.has(name) ? 2 : 1;
  };
  return {
    names: ["core", "app", "main"],
    // the tree's objects a library uses (DDIC, interfaces) go into core with it
    pullDown: true,
    // OWNER:LOCAL is its owner's, FUGR:NAME the function group's; a class
    // with no file of its own (converted, synthetic) starts in app
    classTier: (name) => tierOf(name.startsWith("FUGR:") ? name.slice(5).split(":")[0] : name.split(":")[0], 1),
    interfaceTier: (name) => tierOf(name, 1),
    ddicTier: (name) => fileOf.has(name) ? tierOf(name, 0) : undefined,
  };
}
