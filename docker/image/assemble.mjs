import {cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, writeFileSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import {approvedLicenseAssumption} from "./license-assumptions.mjs";
import {imagePacks} from "./packs.mjs";
import {generationHanaSrcProblem, privateGenFolder, segwPrivateGen} from "../../tools/osd-tmp.mjs";
import {writePublicArtefact} from "../../tools/osd-public-tree.mjs";

const out = resolve(process.argv[2] ?? "/image");
if (existsSync(out)) throw new Error(`Output must not exist: ${out}`);
// One serving generation; the checkout's build/ holds many older generations,
// binaries, browser previews and temporary files.
const live = readlinkSync("build/live");
if (!/^by-input\/[a-f0-9]{16}$/.test(live)) throw new Error(`Unexpected live generation: ${live}`);
// gen/hana-src (H4) is the tenant's sources: a generation built with it is
// private, and is never assembled into an image (tools/osd-tmp.mjs). Guarded
// here, before anything is copied: a refusal must not leave the layers
// half-copied behind it.
const hanaProblem = generationHanaSrcProblem(join("build", live));
if (hanaProblem) throw new Error(hanaProblem);
mkdirSync(out, {recursive: true});
// Explicit roots: never copy .env, .git, local credentials, captures or databases.
const roots = ["src", "gen", "data", "webapp", "test", "tools", "bin", "scripts", "docker/image",
  "abap_transpile.json", "abaplint.jsonc", "libs.lock.json", "package.json", "package-lock.json", "LICENSE", "node_modules"];
const testOnly = new Set([
  "tools/adt-vsp-consume.go",
  "docker/image/rfc-probe.go",
  "docker/image/Dockerfile.probes",
  "docker/image/probe-sources.mjs",
]);
// The browser preview bundles DuckDB-Wasm and Arrow into sw.js and copies its
// Wasm module to the static deployment. None of those packages is used by the
// Node server. Keep them out of the runtime image: in particular, Arrow's
// json-bignum dependency has no declared npm license and must not be shipped
// under an invented license assumption merely because preview builds need it.
const browserOnlyPackages = new Set([
  "node_modules/@duckdb/duckdb-wasm",
  "node_modules/apache-arrow",
  "node_modules/json-bignum",
]);
function browserOnly(path) {
  const normalized = path.replaceAll("\\", "/");
  return [...browserOnlyPackages].some((name) => normalized === name || normalized.endsWith("/" + name));
}
// gen/hana-src and gen/hana-ddic (H4) are the tenant's content: never in the
// image, manifest or not -- an older generation that predates the folders
// must not drag them in. tools/osd-tmp.mjs holds the one list of the two
// prefixes; these copies run against the checkout root, so cpSync's filter
// paths are already relative.
const selectedPacks = imagePacks(process.cwd(), process.env.OSD_IMAGE_PACKS ?? "");
for (const pack of selectedPacks) {
  cpSync(pack.dir, join(out, "packs", pack.name), {recursive: true, verbatimSymlinks: true});
  if (pack.missing.length) throw new Error(`Pack ${pack.name} has unfetched sources`);
}
for (const entry of roots) {
  cpSync(entry, join(out, entry), {recursive: true,
    ...(entry === "node_modules" ? {dereference: true} : {verbatimSymlinks: true}),
    filter: path => ![".git", "e2e", "test-results", "playwright-report"].includes(basename(path)) &&
      !testOnly.has(path.replaceAll("\\", "/")) && !browserOnly(path) && !privateGenFolder(path) &&
      // and gen/segw while its manifest names a dump (H5b, tools/osd-tmp.mjs):
      // this copy runs against the checkout root, so the filter paths are
      // already relative
      !segwPrivateGen(path, process.cwd())});
}
mkdirSync(join(out, "build", "by-input"), {recursive: true});
cpSync(join("build", live), join(out, "build", live), {recursive: true, verbatimSymlinks: true});
symlinkSync(live, join(out, "build", "live"));
symlinkSync("build/live/output", join(out, "output"));
const sources = JSON.parse(readFileSync("docker/image/sources.json", "utf8"));
const lock = JSON.parse(readFileSync("libs.lock.json", "utf8"));
const pins = new Map(lock.libraries.map((source) => [source.folder, source]));
const runtimeLibraries = sources.libraries.map((source) => {
  const pin = pins.get(source.folder);
  if (pin === undefined) throw new Error(`No libs.lock.json entry for ${source.folder}`);
  return {...pin, ...source};
});
const report = {
  sources: {transpiler: lock.transpiler, libraries: runtimeLibraries},
  packs: selectedPacks.map((pack) => ({name: pack.name, sources: pack.sources.map((source) => ({repo: source.repo, ref: source.ref, path: source.path}))})),
  libraries: [], npm: [], blockers: [], assumptions: [],
};
for (const source of runtimeLibraries) {
  const dir = `.local/lars/${source.folder}`;
  cpSync(dir, join(out, dir), {recursive: true, verbatimSymlinks: true, filter: path => ![".git", "node_modules"].includes(basename(path))});
  const files = readdirSync(dir).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name));
  const texts = files.map(file => readFileSync(join(dir, file), "utf8")).join("\n");
  const recognized = /^(?:The )?MIT License(?: \(MIT\))?\s*$/im.test(texts) && /Permission is hereby granted, free of charge/i.test(texts);
  report.libraries.push({...source, licenseFiles: files});
  if (source.licenseAssumption) {
    if (!approvedLicenseAssumption(source)) {
      throw new Error("Unapproved license assumption");
    }
    report.assumptions.push({repo: source.repo, ref: source.ref, ...source.licenseAssumption});
  }
  else if (!recognized) report.blockers.push(`Unrecognized source license: ${source.repo}@${source.ref}`);
}
// The transpiler checkout is outside this source tree during build. Its three
// shipped packages are copied through node_modules; extras is build-only and
// must never slip into the runtime image without a separate license review.
report.transpiler = {...lock.transpiler, packages: []};
for (const name of ["runtime", "transpiler", "cli"]) {
  const dir = `../transpiler/packages/${name}`;
  const meta = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const licenseFile = readdirSync(dir).find(file => /^LICENSE(?:\.[^/]*)?$/i.test(file));
  const licenseText = licenseFile ? readFileSync(join(dir, licenseFile), "utf8") : "";
  report.transpiler.packages.push({name: meta.name, license: meta.license, licenseFile});
  if (meta.license !== "MIT" || !/Permission is hereby granted, free of charge/i.test(licenseText)) {
    report.blockers.push(`Review transpiler source license: ${meta.name}@${lock.transpiler.ref}`);
  }
}
if (existsSync(join(out, "node_modules/@abaplint/transpiler-extras"))) {
  report.blockers.push("Build-only transpiler-extras must not be included in the runtime image");
}
// Retain actual installed license declarations, including nested dependency copies.
const allowed = new Set(["MIT", "ISC", "Apache-2.0", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "CC0-1.0", "Unlicense", "BlueOak-1.0.0", "Python-2.0", "CC-BY-4.0", "(MIT OR CC0-1.0)", "(MIT AND Zlib)", "(MIT OR Apache-2.0)", "(MIT AND BSD-3-Clause)"]);
function inventory(dir) {
  for (const entry of readdirSync(dir, {withFileTypes: true})) {
    if (!entry.isDirectory() || entry.name === ".bin") continue;
    const at = join(dir, entry.name);
    if (entry.name.startsWith("@")) { inventory(at); continue; }
    const file = join(at, "package.json");
    if (existsSync(file)) {
      const p = JSON.parse(readFileSync(file, "utf8"));
      const license = typeof p.license === "string" ? p.license : p.license?.type;
      report.npm.push({name: p.name, version: p.version, license: license ?? "UNKNOWN"});
      if (!allowed.has(license)) report.blockers.push(`Review npm license: ${p.name}@${p.version}: ${license ?? "UNKNOWN"}`);
    }
    if (existsSync(join(at, "node_modules"))) inventory(join(at, "node_modules"));
  }
}
inventory(join(out, "node_modules"));
writeFileSync(join(out, "image-licenses.json"), JSON.stringify(report, null, 2) + "\n");
writeFileSync(join(out, "release.json"), JSON.stringify({commit: process.env.OSD_IMAGE_REVISION ?? "local", builtAt: new Date().toISOString()}, null, 2) + "\n");
console.log(`Image tree assembled; ${report.blockers.length} license items need review; ${report.assumptions.length} declared assumption(s).`);
writePublicArtefact(out, process.cwd());
