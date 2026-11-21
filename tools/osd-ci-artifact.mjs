// Archive the output of this run for the suite and browser jobs.
import {readFileSync, readdirSync, existsSync, readlinkSync, realpathSync, lstatSync, mkdirSync, writeFileSync, mkdtempSync, rmSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {verifyPublicArtefact, writeArtefactProvenance} from "./osd-provenance.mjs";
import {publicProvenance} from "./osd-public-tree.mjs";
import {CLOSURE, ciClosure, verifyCiClosure} from "./osd-ci-closure.mjs";
import {verifyCiTranspiler} from "./osd-ci-transpiler.mjs";

if (process.argv[2] === "verify") {
  const {generationStateSnapshot} = await import("./osd-build.mjs");
  const state = generationStateSnapshot();
  // the shared caches unpacked beside it are exactly live's public closure
  try {
    const closure = verifyCiClosure(process.cwd(), state.live);
    console.log(`osd-ci-artifact: closure: ${Object.keys(closure.files).length} shared cache files verified`);
  } catch (error) {
    console.error(`osd-ci-artifact: ${error.message}`);
    process.exit(2);
  }
  console.log(`osd-ci-artifact: generation: ${JSON.stringify(state)}`);
  process.exit(state.live !== null && state.live === state.tree ? 0 : 1);
}

const archive = process.argv[2] === "pack" ? process.argv[3] : undefined;
if (!archive) {
  console.error("usage: node tools/osd-ci-artifact.mjs pack <tar-file> | verify");
  process.exit(2);
}
// the tree is archived, so the tree must be the public live generation
const provenance = publicProvenance(process.cwd());
verifyCiTranspiler(process.cwd());
const live = readlinkSync("build/live");
if (!/^by-input\/[0-9a-f]{16}$/.test(live) || live !== `by-input/${provenance.generation}`) throw new Error("invalid live generation link");
if (!lstatSync("output").isSymbolicLink() || readlinkSync("output") !== "build/live/output"
    || realpathSync("output") !== realpathSync(`build/${live}/output`))
  throw new Error("output must link to the verified live generation");
const generation = JSON.parse(readFileSync(`build/${live}/manifest.json`, "utf8"));
const {genHash} = await import("./osd-build.mjs");
if (typeof generation.gen !== "string" || generation.gen !== genHash(process.cwd()))
  throw new Error("generated sources differ from the public live generation");
const paths = ["gen", "output", "build/live", `build/${live}`, ".local/ci-artifact/transpiler", ".local/ci-artifact/transpiler-digests.json"];
for (const lib of generation.inputs?.libs ?? []) {
  if (!/^\.local\/lars\/[a-zA-Z0-9._-]+$/.test(lib) && !/^\.local\/url-libs\/[0-9a-f]{24}$/.test(lib))
    throw new Error(`library path is outside the public archive closure: ${lib}`);
  paths.push(lib);
}
for (const pack of readdirSync("packs")) {
  const manifest = `packs/${pack}/osd-pack.json`;
  if (!existsSync(manifest)) continue;
  const marker = `packs/${pack}/.osd-fetched.json`;
  if (existsSync(marker)) paths.push(marker);
  for (const source of JSON.parse(readFileSync(manifest, "utf8")).sources ?? []) {
    if (typeof source.folder !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(source.folder)
        || source.folder === "." || source.folder === "..") throw new Error(`unsafe fetched source folder in ${manifest}`);
    const folder = `packs/${pack}/${source.folder}`;
    const identity = `${folder}/.osd-source.json`;
    if (!existsSync(identity)) throw new Error(`missing fetched identity: ${identity}`);
    const entry = JSON.parse(readFileSync(identity, "utf8"));
    if (typeof entry.private !== "boolean" || entry.private) throw new Error(`private or unrecorded fetched source: ${folder}`);
    paths.push(folder);
  }
}
for (const path of paths) {
  if (!existsSync(path)) {
    console.error(`osd-ci-artifact: missing ${path}`);
    process.exit(2);
  }
}
// build/source-by-digest and build/xref: what live reaches, listed with digests
// live's cross-reference rows are the swap job's fast-path input: derived here
// from the (checked public) tree when no host has written them yet, and then
// required -- a distinct exit, 3, says the archive would lose that coverage
const {cacheKey, rows} = await import("./osd-xref-seed.mjs");
const xrefKey = await cacheKey(process.cwd(), {hash: provenance.generation});
if (xrefKey !== undefined && !existsSync(`build/xref/${xrefKey}.json`)) {
  try { await rows(process.cwd()); } catch (error) { console.error(`osd-ci-artifact: cross-reference rows could not be derived: ${error.message}`); }
}
let closure;
try { closure = await ciClosure(process.cwd(), provenance.generation, {requireXref: true}); }
catch (error) {
  console.error(`osd-ci-artifact: ${error.message}`);
  process.exit(error.code === "CLOSURE_INCOMPLETE" ? 3 : 2);
}
mkdirSync(".local/ci-artifact", {recursive: true});
writeFileSync(CLOSURE, `${JSON.stringify(closure, null, 2)}\n`);
const scratch = mkdtempSync(join(tmpdir(), "osd-ci-closure-"));
let result;
try {
  const list = join(scratch, "files");
  writeFileSync(list, Object.keys(closure.files).map(path => `${path}\n`).join(""));
  result = spawnSync("tar", ["-cf", archive, ...paths, CLOSURE, "-T", list], {stdio: "inherit"});
} finally { rmSync(scratch, {recursive: true, force: true}); }
if (result.status !== 0) process.exit(result.status ?? 1);
writeArtefactProvenance(archive, provenance);
verifyPublicArtefact(archive);
