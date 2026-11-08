// The whole osgo input set, frozen: what tools/gogen/osgo.mjs hands the front
// end (osg-build.mjs osgCompileInputs), as the step-4 driver's inputs JSON plus
// a manifest of every file with its role and SHA-256.
//
//   node tools/selfhost/corpus-inputs.mjs --out <dir> [--stale-gen] [--objects A,B]
//
// Writes <dir>/inputs.json (driver schema: folders, objects, skippedPaths) and
// <dir>/manifest.json. Refuses an unfetched pack (osgCompileInputs) and a gen/
// that is not the generation of the tree (staleGen), as osgo.mjs does.
// --objects narrows the object list to a slice (for bisecting a difference);
// the folders and the skipped files stay those of the whole build.
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, relative} from "node:path";
import {home} from "../gogen/home.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const walk = (d) => readdirSync(d, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  .flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));

/** a path as the manifest names it: relative to the checkout, else absolute */
export function logical(path, root = home) {
  const rel = relative(root, path);
  return rel.startsWith("..") ? path : rel;
}

/**
 * The manifest of one input set. Pure over its arguments so the test can
 * build one without a checkout: folders (layer order), objects, hidden (Set
 * of absolute paths), files per folder.
 */
export function buildManifest({folders, objects, hidden, root, pins = {}, filesOf = walk, read = (f) => readFileSync(f)}) {
  const entries = [];
  for (const [layer, folder] of folders.entries()) {
    for (const file of filesOf(folder)) {
      entries.push({path: logical(file, root), folder: layer, role: hidden.has(file) ? "skipped" : "input", sha256: sha(read(file))});
    }
  }
  const body = {schema: 1, ...pins, folders: folders.map((f) => logical(f, root)), objects: [...objects],
    skipped: [...hidden].filter((f) => folders.some((d) => f.startsWith(`${d}/`))).map((f) => logical(f, root)).sort(),
    files: entries};
  return {...body, manifestSha256: sha(JSON.stringify(body))};
}

/** the driver's inputs: the exact folders, objects and skip set compileOsg uses */
export function driverInputs({folders, objects, hidden}) {
  return {schema: "osg-selfhost-corpus/1", folders, objects: [...objects],
    // only files under a compiled folder can be asked about; sorted for a stable file
    skippedPaths: [...hidden].filter((f) => folders.some((d) => f.startsWith(`${d}/`))).sort()};
}

function pinsOf(root) {
  const git = (...a) => { try { return execFileSync("git", a, {cwd: root, encoding: "utf8"}).trim(); } catch { return ""; } };
  const pkg = (name) => { try { return JSON.parse(readFileSync(join(root, "node_modules", name, "package.json"), "utf8")).version; } catch { return null; } };
  return {
    osgCommit: git("rev-parse", "HEAD"),
    osgDirty: git("status", "--porcelain", "--untracked-files=no") !== "",
    libsLockSha256: existsSync(join(root, "libs.lock.json")) ? sha(readFileSync(join(root, "libs.lock.json"))) : null,
    packages: {"@abaplint/core": pkg("@abaplint/core"), "@abaplint/transpiler": pkg("@abaplint/transpiler"), typescript: pkg("typescript")},
    node: process.version,
  };
}

async function main(argv) {
  const at = argv.indexOf("--out");
  if (at < 0 || !argv[at + 1]) throw new Error("usage: corpus-inputs.mjs --out <dir> [--stale-gen] [--objects A,B]");
  const out = argv[at + 1];
  const {osgCompileInputs, staleGen} = await import("../gogen/osg-build.mjs");
  const stale = await staleGen();
  if (stale && !argv.includes("--stale-gen")) {
    console.error(`corpus-inputs: refused: ${stale} (or pass --stale-gen)`);
    process.exit(2);
  }
  const whole = osgCompileInputs();
  let objects = whole.objects;
  const slice = argv.indexOf("--objects");
  if (slice >= 0) {
    const wanted = new Set(String(argv[slice + 1] ?? "").split(",").filter(Boolean).map((o) => o.toLowerCase()));
    objects = objects.filter((o) => wanted.has(o.toLowerCase()));
    const unknown = [...wanted].filter((w) => !objects.some((o) => o.toLowerCase() === w));
    if (unknown.length) throw new Error(`not objects of the osgo build: ${unknown.join(", ")}`);
  }
  for (const f of whole.folders) if (!existsSync(f)) throw new Error(`missing input folder: ${f}`);
  const inputs = driverInputs({...whole, objects});
  const {hashOf} = await import("../osd-build.mjs");
  const manifest = buildManifest({...whole, objects, root: home,
    pins: {...pinsOf(home), inputHash: hashOf(home), staleGen: stale ?? null, slice: slice >= 0, inputsSha256: sha(JSON.stringify(inputs, null, 1) + "\n")}});
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, "inputs.json"), JSON.stringify(inputs, null, 1) + "\n");
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 1) + "\n");
  const counts = manifest.files.reduce((n, f) => ((n[f.role] = (n[f.role] ?? 0) + 1), n), {});
  console.log(`corpus-inputs: ${inputs.folders.length} folders, ${inputs.objects.length} objects, ${counts.input ?? 0} files in, ${counts.skipped ?? 0} skipped; manifest ${manifest.manifestSha256.slice(0, 16)}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main(process.argv.slice(2));
