// Assemble one PRIVATE TEST archive from an already-built Bun host.
// No GitHub release is created here: full dependency-notice review is pending.
// Usage: node scripts/make-download-bundle.mjs linux-amd64
import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {basename, dirname, join, relative, resolve} from "node:path";
import {libraryFiles} from "../tools/osd-inputs.mjs";
import {unfetched, describeUnfetched} from "../tools/osd-fetch.mjs";
import {generationHanaSrcProblem, privateGenFolder, segwPrivateGen} from "../tools/osd-tmp.mjs";
import {runsAs} from "../tools/osd-main.mjs";
import {fileURLToPath} from "node:url";
import {assertPublicSystem} from "../tools/osd-system.mjs";
import {verifyPublicArtefact} from "../tools/osd-provenance.mjs";
import {assertPublicTree, verifyTreeArtefact, writePublicArtefact} from "../tools/osd-public-tree.mjs";

// gen/hana-src and gen/hana-ddic (H4) are the tenant's content: the staged
// gen/ never carries them, manifest or not. tools/osd-tmp.mjs holds the one
// list of the two prefixes; cpSync hands its filter absolute paths, so the
// decision is made on relative(root, path).
const targets = {
  "linux-amd64": {bun: "osd", archive: ".tar.gz"},
  "linux-arm64": {bun: "osd", archive: ".tar.gz"},
  "windows-x64": {bun: "osd.exe", archive: ".zip"},
  "macos-arm64": {bun: "osd", archive: ".tar.gz"},
};

// main(argv, {root}) is the testable entry: the command line runs it against
// the checkout, and test/hana-src-gen.mjs runs the same body against a fake
// tree -- a generation whose manifest lists a tenant layer must refuse, and
// a clean one must stage the tree without the private gen/ folders.
export async function main(argv = process.argv.slice(2), {root = resolve(dirname(fileURLToPath(import.meta.url)), "..")} = {}) {
  // the tree is what is staged: it must be the public live generation now,
  // before anything else is read from it
  assertPublicSystem(root);
  assertPublicTree(root);
  const name = argv[0];
  const target = targets[name];
  if (!target) throw new Error(`Expected one of ${Object.keys(targets).join(", ")}`);
  const missing = unfetched(root);
  if (missing.length) throw new Error(describeUnfetched(missing));
  const generation = readlinkSync(join(root, "build", "live"));
  if (!generation.startsWith("by-input/") || !existsSync(join(root, "build", generation))) {
    throw new Error(`Invalid or missing build/live target: ${generation}`);
  }
  // gen/hana-src (H4) is the tenant's sources: a generation built with it is
  // private, and is never bundled for download (tools/osd-tmp.mjs)
  const hanaProblem = generationHanaSrcProblem(join(root, "build", generation));
  if (hanaProblem) throw new Error(hanaProblem);
  const probe = join(root, ".local", "release-probe", name);
  for (const file of [target.bun]) {
    if (!existsSync(join(probe, file))) throw new Error(`Build ${join(probe, file)} first`);
  }
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {cwd: root, encoding: "utf8"}).trim();
  const sourceFingerprint = createHash("sha256");
  for (const file of ["bin/osd.mjs", "tools/osd-host.mjs", "scripts/release/run.sh", "scripts/release/run.ps1", "scripts/make-download-bundle.mjs", "LICENSE"]) {
    sourceFingerprint.update(readFileSync(join(root, file)));
  }
  for (const file of [target.bun]) sourceFingerprint.update(readFileSync(join(probe, file)));
  const revision = sourceFingerprint.digest("hex").slice(0, 8);
  const folder = `osd-bun-${commit.slice(0, 12)}-${basename(generation)}-${revision}-${name}`;
  const stage = join(probe, folder);
  const archive = join(probe, `${folder}${target.archive}`);
  if (existsSync(stage) || existsSync(archive)) {
    if (!existsSync(stage) || !existsSync(archive)) throw new Error(`Incomplete existing bundle: ${stage}`);
    verifyPublicArtefact(join(probe, target.bun));
    verifyTreeArtefact(stage, root);
    verifyTreeArtefact(archive, root);
    const manifest = JSON.parse(readFileSync(join(stage, "release.json"), "utf8"));
    for (const file of [target.bun]) {
      const digest = createHash("sha256").update(readFileSync(join(probe, file))).digest("hex");
      if (manifest.binaries?.[file] !== digest) throw new Error(`Existing ${stage} uses different ${file}`);
    }
    const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
    if (readFileSync(`${archive}.sha256`, "utf8").trim() !== `${digest}  ${basename(archive)}`) {
      throw new Error(`Checksum mismatch in existing ${archive}`);
    }
    console.log(`${archive} (${Math.round(statSync(archive).size / 1e6)} MB, sha256 ${digest}, existing)`);
    return archive;
  }
  mkdirSync(stage, {recursive: true});

  // The compiled binary still reads source, generated DDIC, UI and its library
  // inputs from disk for ADT edits and generation rebuilds. Keep the same layout
  // as make-release.mjs, but omit Node/SEA hosts and node_modules.
  const content = ["src", "gen", "data", "webapp", "test", "tools", "bin", "scripts", "LICENSE",
    "abap_transpile.json", "package.json", "abaplint.jsonc"];
  for (const item of content) {
    if (existsSync(join(root, item))) {
      cpSync(join(root, item), join(stage, item), {recursive: true, dereference: true,
        filter: (path) => basename(path) !== "e2e" && !path.endsWith(".go") && !privateGenFolder(relative(root, path)) &&
          // and gen/segw while its manifest names a dump (H5b, tools/osd-tmp.mjs)
          !segwPrivateGen(relative(root, path), root)});
    }
  }
  for (const {files} of libraryFiles(root)) {
    for (const file of files) {
      const path = relative(root, file);
      if (path.startsWith("..")) throw new Error(`Library escapes repository: ${file}`);
      mkdirSync(dirname(join(stage, path)), {recursive: true});
      cpSync(file, join(stage, path));
    }
  }
  for (const pack of ["lsd", "o4d", "zork"]) {
    const source = join(root, "packs", pack);
    if (!existsSync(join(source, "osd-pack.json"))) throw new Error(`Missing pack ${pack}`);
    cpSync(source, join(stage, "packs", pack), {recursive: true, dereference: true});
  }
  mkdirSync(join(stage, "build", "by-input"), {recursive: true});
  cpSync(join(root, "build", generation), join(stage, "build", generation), {recursive: true});
  symlinkSync(generation, join(stage, "build", "live"));
  symlinkSync(join("build", "live", "output"), join(stage, "output"));
  verifyPublicArtefact(join(probe, target.bun));
  cpSync(join(probe, target.bun), join(stage, target.bun));
  const launcher = name === "windows-x64" ? "run.ps1" : "run.sh";
  cpSync(join(root, "scripts", "release", launcher), join(stage, launcher));
  if (name !== "windows-x64") {
    for (const file of [target.bun, launcher]) chmodSync(join(stage, file), 0o755);
  }
  const manifest = {
    status: "PRIVATE_TEST_ONLY", reason: "Full dependency-notice review and release provenance are pending",
    commit, generation: basename(generation), sourceRevision: revision, target: name,
    sourceDirty: execFileSync("git", ["status", "--porcelain"], {cwd: root, encoding: "utf8"}).trim().length > 0,
    bunVersion: execFileSync("bun", ["--version"], {encoding: "utf8"}).trim(),
    protocols: "built-in MIT JavaScript",
    licenseNotices: ["LICENSE"],
    packs: ["lsd", "o4d", "zork"],
    binaries: Object.fromEntries([target.bun].map((file) => [file,
      createHash("sha256").update(readFileSync(join(stage, file))).digest("hex")])),
  };
  writeFileSync(join(stage, "release.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(stage, "PRIVATE-TEST-ONLY.txt"),
    "Private test artifact. Do not redistribute before dependency-notice and provenance review.\n" +
    "Mini-Zork public-domain claim: https://www.inform-fiction.org/zmachine/standards/z1point1/appf.html\n" +
    "SQLite data is stored outside this directory by run.sh or run.ps1.\n");
  writePublicArtefact(stage, root);
  if (target.archive === ".zip") {
    execFileSync("zip", ["-q", "-r", archive, folder], {cwd: probe, stdio: "inherit"});
  } else {
    execFileSync("tar", ["-czf", archive, "-C", probe, folder], {stdio: "inherit"});
  }
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  writeFileSync(`${archive}.sha256`, `${digest}  ${basename(archive)}\n`);
  writePublicArtefact(archive, root);
  console.log(`${archive} (${Math.round(statSync(archive).size / 1e6)} MB, sha256 ${digest})`);
  return archive;
}

if (runsAs("make-download-bundle.mjs")) await main();
