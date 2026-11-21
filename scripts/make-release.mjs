// A directory someone can copy to a machine with nothing installed.
//
//   bun scripts/make-release.mjs [outdir]
//
// What goes in, and why each part is there — every line of this was learned
// by deploying to a second machine and watching it fail (2026-09-16):
//
//   osd            the Bun binary. Self-contained: it hands the generated
//                  code its own @abaplint/runtime through a plugin, so it
//                  needs no node_modules at all.
//   osd-sea        a Node single executable (Node 26.9 inside).
//   osd.mjs        the bundle, for the private ./node or a system Node >= 22.
//   node/          a private Node, because a machine's own may be too old.
//   node_modules/  the runtime closure — @abaplint/runtime, its database
//                  adapter, sql.js. The NODE hosts need it: generated code
//                  imports "@abaplint/runtime" by name and test/setup.mjs
//                  imports the adapter, and neither is bundled outside Bun.
//                  Leaving it out is the failure that looks like the system
//                  working: the launchpad serves, every app answers 503.
//   src/ gen/ data/ webapp/ test/ tools/ abap_transpile.json
//                  OSD's own content, which is not yet a pack (backlog B.11)
//   packs/         the content packs, read at start (backlog E.2)
//   build/         one prebuilt generation, so nothing transpiles to serve
//   output         the link the runtime loads the generation through
import {cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {basename, dirname, join, relative, resolve} from "node:path";
import {fileURLToPath, pathToFileURL} from "node:url";
import {assertPublicTree, verifyTreeArtefact, writePublicArtefact} from "../tools/osd-public-tree.mjs";
import {runsAs} from "../tools/osd-main.mjs";
import {generationHanaSrcProblem, privateGenFolder, segwPrivateGen} from "../tools/osd-tmp.mjs";

// main(argv, {root}) is the testable entry: the command line runs it against
// the checkout, and test/hana-src-gen.mjs runs the same body against a fake
// tree -- a generation whose manifest lists a tenant layer must refuse, and
// a clean one must copy the tree without the private gen/ folders.
export async function main(argv = process.argv.slice(2), {root = resolve(dirname(fileURLToPath(import.meta.url)), "..")} = {}) {
  const out = resolve(argv[0] ?? join(root, ".local", "release"));
  const say = (m) => console.log(`  ${m}`);
  // the tree is what is copied: it must be the public live generation now,
  // before anything else is read from it
  assertPublicTree(root);

  // one generation, and the link the runtime loads it through. Read before
  // anything is copied or removed: a refusal must not leave the release
  // half-copied behind it.
  const live = readlinkSync(join(root, "build", "live"));
  // gen/hana-src and gen/hana-ddic (H4) are the tenant's content: a
  // generation built with either is private, and is never released
  // (tools/osd-tmp.mjs)
  const hanaProblem = generationHanaSrcProblem(join(root, "build", live));
  if (hanaProblem) throw new Error(hanaProblem);

  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});

  // the tree's own content, minus everything a machine does not need to serve
  const TREE = ["src", "gen", "data", "webapp", "test", "tools", "bin", "scripts", "abap_transpile.json", "package.json", "abaplint.jsonc"];
  for (const entry of TREE) {
    if (existsSync(join(root, entry))) {
      cpSync(join(root, entry), join(out, entry), {recursive: true, dereference: true, filter: (p) => basename(p) !== "e2e" && !privateGenFolder(relative(root, p)) &&
        // and gen/segw while its manifest names a dump (H5b, tools/osd-tmp.mjs)
        !segwPrivateGen(relative(root, p), root)});
    }
  }
  say(`content: ${TREE.filter((e) => existsSync(join(root, e))).join(", ")}`);

  // **The libraries, because a system that can edit has to be able to check.**
  //
  // The build reads six library folders (abap_transpile.json `libs`), and so
  // does the object store since 2026-09-19 -- that is what makes a check
  // truthful. A release without them answered `Super class
  // "cl_apc_wsp_ext_stateful_base" not found or contains errors` for a class
  // that is perfectly fine, which is the same lie the store's own hand-written
  // list used to tell, one layer further out. Found by deploying and reading
  // what was served rather than by the suite, which runs in a checkout.
  //
  // Only the files the build actually reads are copied, by the same body that
  // decides that for the store: abapGit is configured file by file, and its
  // folder is 11 MB against the 97 files wanted.
  const {libraryFiles} = await import(pathToFileURL(join(root, "tools", "osd-inputs.mjs")).href);
  let libFiles = 0;
  for (const {folder, files} of libraryFiles(root)) {
    for (const file of files) {
      const target = join(out, relative(root, file));
      mkdirSync(dirname(target), {recursive: true});
      cpSync(file, target);
      libFiles += 1;
    }
    say(`library: ${folder}`);
  }
  say(`${libFiles} library files, so a check in the release sees the system the build compiled`);

  // **The hosts are copied, not built -- so a stale one is refused.**
  //
  // This cost an evening on 2026-09-19. `make-release` writes a `release.json`
  // with the current commit and the time it ran, and copies `build/osd` beside
  // it. The metadata was honest and the binary was four hours old, so a
  // container built from that release ran code from before every fix made that
  // afternoon -- and every conclusion drawn from it was wrong: an explainer
  // that "never fired" was not in the binary, a seed defect "still present
  // after the fix" had never had the fix, and four candidate causes were
  // excluded by reading the CURRENT tree while an OLD one executed.
  //
  // The checksum told the truth in one line (`.local/release/osd` was byte for
  // byte `build/osd`) and nothing else did. So the freshness is checked here,
  // by mtime against the sources the binary is built from, and a stale host is
  // a refusal rather than a warning: a release that quietly ships yesterday's
  // binary is worse than one that will not build.
  const newestSource = () => {
    let newest = 0;
    let name = "";
    const walk = (dir) => {
      for (const entry of readdirSync(dir, {withFileTypes: true})) {
        if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) { walk(full); continue; }
        if (/\.(mjs|js|json|cjs)$/.test(entry.name) === false) continue;
        const at = statSync(full).mtimeMs;
        if (at > newest) { newest = at; name = relative(root, full); }
      }
    };
    for (const dir of ["bin", "tools", "scripts"]) {
      const full = join(root, dir);
      if (existsSync(full)) walk(full);
    }
    return {at: newest, name};
  };

  const source = newestSource();

  /** Copy one built host, and refuse it if it is older than the code.
   *
   *  **Every host goes through here**, which is the point. The first version of
   *  this guard covered `osd` and `osd-sea` and left `osd-node/osd.mjs`, copied
   *  fifteen lines further down -- the same defect, in the same file, fixed for
   *  the case and not for the class, on the same day we caught that shape three
   *  times in each other's work. */
  const host = (relativePath, name, how) => {
    const from = join(root, relativePath);
    if (existsSync(from) === false) return;
    const built = statSync(from).mtimeMs;
    if (built < source.at) {
      throw new Error(
        `${relativePath} is older than the code it is built from: it was made ` +
        `${new Date(built).toISOString()} and ${source.name} changed ` +
        `${new Date(source.at).toISOString()}. Copying it would put a release ` +
        `together whose release.json names this commit and whose host does not ` +
        `contain it -- which is how an evening was spent testing code that was ` +
        `not running. Build it first: ${how}`);
    }
    verifyTreeArtefact(from, root);
    cpSync(from, join(out, name));
    say(`host: ${name}, built ${new Date(built).toISOString()}`);
  };

  host("build/osd", "osd", "npm run binary");
  host("build/osd-sea", "osd-sea", "npm run binary:sea");
  host("build/osd-node/osd.mjs", "osd.mjs", "npm run binary:bundle");
  const node = process.env.OSD_NODE_DIR ?? join(root, ".local", "node", "node-v26.9.0-linux-x64");
  if (existsSync(node)) {
    cpSync(node, join(out, "node"), {recursive: true, dereference: true});
    say(`host: a private ${execFileSync(join(node, "bin", "node"), ["--version"], {encoding: "utf8"}).trim()}`);
  }

  // The closure the Node hosts resolve from disk.
  //
  // **Derived, not listed.** The four names used to be written here by hand,
  // and the hand was wrong: `temporal-polyfill` came without `temporal-utils`
  // and `temporal-spec`, so the Node host died on
  // `Cannot find package 'temporal-utils'` the moment anything asked for a
  // date (measured in the container, 2026-09-19). A list of roots is a fine
  // thing to write; a list of a closure is not, because the closure changes
  // when somebody else's package.json does and nothing tells us.
  const ROOTS = ["@abaplint/runtime", "@abaplint/database-sqlite", "sql.js", "temporal-polyfill"];

  function closureOf(roots) {
    const seen = new Set();
    const queue = [...roots];
    while (queue.length > 0) {
      const pkg = queue.shift();
      if (seen.has(pkg)) continue;
      const from = join(root, "node_modules", pkg);
      if (!existsSync(from)) continue;
      seen.add(pkg);
      try {
        const own = JSON.parse(readFileSync(join(from, "package.json"), "utf8"));
        // `dependencies` only: devDependencies are not needed to run, and
        // optionalDependencies that are absent are absent on purpose.
        queue.push(...Object.keys(own.dependencies ?? {}));
      } catch {
        // a package without a readable package.json is a leaf as far as we care
      }
    }
    return [...seen].sort();
  }

  const closure = closureOf(ROOTS);
  mkdirSync(join(out, "node_modules", "@abaplint"), {recursive: true});
  for (const pkg of closure) {
    if (pkg.includes("/")) mkdirSync(join(out, "node_modules", pkg.split("/")[0]), {recursive: true});
    cpSync(join(root, "node_modules", pkg), join(out, "node_modules", pkg), {recursive: true, dereference: true});
  }
  say(`runtime closure for the Node hosts: ${closure.length} packages from ${ROOTS.length} roots` +
    ` (${closure.filter((p) => !ROOTS.includes(p)).join(", ") || "no transitive ones"})`);

  // **hdb goes in as one pre-bundled file, and the package directory does not
  // work.** A compiled Bun binary resolves the top-level bare specifier from
  // the cwd's node_modules, and relative FILE paths on disk -- and nothing that
  // the required module then asks for by name. So copying `hdb` plus
  // `iconv-lite` gets as far as
  // `Cannot find package 'iconv-lite' from .../hdb/lib/util/convert.js`, and
  // every rewrite of that require fails at the next bare specifier after it
  // (measured, five variants, 2026-09-19). One CJS file has no bare specifiers
  // left to resolve.
  //
  // Without this the image carries no HANA driver at all and `STG_DB=hana`
  // answers 503 `Cannot find package 'hdb'` -- honestly, but uselessly.
  if (existsSync(join(root, "node_modules", "hdb"))) {
    const target = join(out, "node_modules", "hdb");
    mkdirSync(target, {recursive: true});
    execFileSync("bun", ["build", "--target=node", "--format=cjs",
      join(root, "node_modules", "hdb", "index.js"), `--outfile=${join(target, "index.js")}`],
    {stdio: "pipe"});
    writeFileSync(join(target, "package.json"), JSON.stringify(
      {name: "hdb", version: JSON.parse(readFileSync(join(root, "node_modules", "hdb", "package.json"), "utf8")).version,
       main: "index.js", license: "MIT"}, undefined, 2) + "\n");
    say(`HANA driver: hdb bundled to one file, ${(statSync(join(target, "index.js")).size / 1024 / 1024).toFixed(2)} MB`);
  }

  // the packs: the same places a served system reads them from, the tree's
  // packs/ first and then whatever OSD_PACKS names, a pack found twice kept
  // from the first place (tools/osd-packs.mjs). A fetched folder inside a
  // pack (packs/o4d/upstream/) is a directory on disk and travels with it.
  // It used to copy .local/packs alone, which shipped an older demo than the
  // tree served (2026-09-17).
  const {packsOf} = await import(pathToFileURL(join(root, "tools", "osd-packs.mjs")).href);
  for (const pack of packsOf(root)) {
    cpSync(pack.dir, join(out, "packs", pack.name), {recursive: true, dereference: true});
    say(`pack ${pack.name}: ${pack.dir}`);
  }

  mkdirSync(join(out, "build", "by-input"), {recursive: true});
  cpSync(join(root, "build", live), join(out, "build", live), {recursive: true});
  symlinkSync(live, join(out, "build", "live"));
  symlinkSync(join("build", "live", "output"), join(out, "output"));
  say(`generation: ${basename(live)}`);

  // **The commit the release was built from, written down here because the
  // release is the one place that cannot work it out.**
  //
  // `/sap/bc/adt/core/http/build` answers `commit` by asking git, and a
  // release directory is not a checkout -- so a deployment reported
  // `"unknown"` and the rule the two targets are supposed to share ("the i7
  // follows Pages, both show the same commit", docs/backlog/pages-preview.md) could not be
  // checked on the half that matters. It was not checked for weeks, because
  // the field existed and read like a measurement.
  const commit = (process.env.GITHUB_SHA ?? execFileSync("git", ["rev-parse", "HEAD"],
    {cwd: root, encoding: "utf8"}).trim());
  writeFileSync(join(out, "release.json"), `${JSON.stringify({
    commit,
    generation: basename(live),
    builtAt: new Date().toISOString(),
  }, undefined, 2)}\n`);
  say(`commit: ${commit.slice(0, 7)}`);

  writeFileSync(join(out, "run.sh"), `#!/bin/sh
# OSD on a machine that has none of this installed.
#
#   ./run.sh          the Bun binary       (needs nothing)
#   ./run.sh sea      a Node single executable
#   ./run.sh node     the bundle on the private Node in ./node
#   ./run.sh system   the bundle on the system node (Node 22 or newer)
#
# Then open http://<this machine>:3030/ — the launchpad, with the demos on it.
set -e
here=$(cd "$(dirname "$0")" && pwd)
cd "$here"
export OSD_PACKS="\${OSD_PACKS:-$here/packs}"
export STG_PORT="\${STG_PORT:-3030}"
export STG_DB_PATH="\${STG_DB_PATH:-$here/.osd.sqlite}"
# work processes: one per core up to four, unless told otherwise (backlog B.12)
cores=$(nproc 2>/dev/null || echo 1)
export OSD_WORKERS="\${OSD_WORKERS:-$([ "$cores" -gt 4 ] && echo 4 || echo "$cores")}"
case "\${1:-bun}" in
  bun)    exec ./osd up ;;
  sea)    exec ./osd-sea up ;;
  node)   exec ./node/bin/node ./osd.mjs up ;;
  system) exec node ./osd.mjs up ;;
  *) echo "usage: run.sh [bun|sea|node|system]"; exit 2 ;;
esac
`);
  execFileSync("chmod", ["+x", join(out, "run.sh")]);
  // checked again now that it is copied: a fetch while this ran is refused
  writePublicArtefact(out, root);
  verifyTreeArtefact(out, root);
  const size = execFileSync("du", ["-sh", out], {encoding: "utf8"}).split(/\s+/)[0];
  console.log(`${out}: ${size}`);
}

if (runsAs("make-release.mjs")) await main();
