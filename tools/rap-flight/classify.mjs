#!/usr/bin/env node
// The measurement behind docs/rap-flight-pack.md, as a script: what the
// document's tables printed when it was written is what this prints when it
// runs, so every number in them is re-derivable instead of trusted.
//
//   node tools/rap-flight/classify.mjs
//
// What it does, which is what the document says was done:
//
// 1. fetches the scenario's src/ at the commit the manifest pins, with NO
//    exclude list at all, into .local/rap-flight-classify/ (gitignored);
//    the four other scenarios (draft/, colldraft/, hierarchy/, unmanaged/)
//    are counted from that clone and then left out of everything below, as
//    the pack's manifest leaves them out;
// 2. classifies every object of the kept folders with abaplint, over the
//    fetched tree with the pack's own src/ layered over it the way the
//    build layers it and the build's libraries as dependencies: a parser
//    error first, else a syntax or unknown-type issue, else clean -- the
//    document's first table;
// 3. runs tools/rap/bdef-gen.mjs's own generate() once per BDEF and prints
//    each refusal verbatim (the document's table refines which construct
//    it was by eye, and its "also in it" column is a reading of each BDEF);
// 4. the same generate() once per service definition (the srvd half, R3),
//    which is the service definitions table;
// 5. runs tools/cds2ddic.mjs's own parseDDLS() per view and keeps the skip
//    reason, which is the views table.
//
// The pinned transpiler's @abaplint/core is imported the way bdef-gen
// imports it, so the classification is the build's own reading. A run takes
// a couple of minutes (fifteen registries for the fifteen BDEFs).
import {basename, join, resolve} from "node:path";
import {existsSync, mkdirSync, readFileSync} from "node:fs";
import * as core from "@abaplint/core";
import {fetchSource} from "../osd-fetch.mjs";
import {loadLibs} from "../osd-transpile.mjs";
import {parseBdef} from "../rap/bdef-parse.mjs";
import {generate} from "../rap/bdef-gen.mjs";
import {parseDDLS} from "../cds2ddic.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {runsAs} from "../osd-main.mjs";
import {walk} from "../rap/bdef-gen.mjs";

const root = resolve(process.env.OSD_ROOT ?? process.cwd());
const manifest = JSON.parse(readFileSync(join(root, "packs/rap-flight/osd-pack.json"), "utf8"));
const [source] = manifest.sources;
const SCENARIOS = /^(draft|colldraft|hierarchy|unmanaged)\//;
const dir = join(root, ".local", "rap-flight-classify");

// the whole src/ of the pinned commit, no excludes: the counts of the four
// other scenarios come out of it, and everything else is classified after
// they are left out
async function fetchedTree(log) {
  const already = join(dir, "upstream");
  if (!existsSync(already)) {
    mkdirSync(dir, {recursive: true});
    await fetchSource({name: "rap-flight-classify", dir, root},
      {...source, exclude: [], folder: "upstream", dir: already}, {log});
  } else {
    log(`${already} is already fetched (delete it to fetch again)`);
  }
  return walk(already).map((path) => ({path, filename: basename(path), contents: readFileSync(path, "utf8")}));
}

// the object type abaplint reads a file as, for counting
const TYPE_OF = [
  ["bdef", /\.bdef\.asbdef$/], ["ddls", /\.ddls\.asddls$/], ["ddlx", /\.ddlx\.asddlxs$/],
  ["dcls", /\.dcls\.acdls$/], ["srvd", /\.srvd\./], ["srvb", /\.srvb\./],
  ["tabl", /\.tabl\.xml$/], ["ttyp", /\.ttyp\.xml$/], ["dtel", /\.dtel\.xml$/], ["doma", /\.doma\.xml$/],
  // the includes of a class pool are the same object as the class: an issue
  // anywhere in the pool counts for the object
  ["clas", /\.clas\.(locals_def\.|locals_imp\.|testclasses\.)?(abap|xml)$/],
  ["intf", /\.intf\.(abap|xml)$/], ["fugr", /\.fugr\.xml$/],
  ["msag", /\.msag\.xml$/], ["nrob", /\.nrob\.xml$/], ["enho", /\.enho\.xml$/], ["enhs", /\.enhs\.xml$/],
  ["auth", /\.auth\.xml$/], ["suso", /\.suso\.xml$/], ["enqu", /\.enqu\.xml$/], ["devc", /\.devc\.xml$/],
];
const typeOf = (filename) => TYPE_OF.find(([, re]) => re.test(filename))?.[0];

function libraryDdic() {
  const deps = [];
  for (const name of ["open-abap-core", "open-abap-odata"]) {
    const libDir = join(libraryPath(root, name), "src");
    deps.push(...walk(libDir).filter((f) => /\.(tabl|view|dtel|doma)\.xml$/.test(f))
      .map((f) => ({filename: basename(f), contents: readFileSync(f, "utf8")})));
  }
  return deps;
}

async function main() {
  const log = (line) => console.log(`classify: ${line}`);
  const tree = await fetchedTree(log);
  const kept = tree.filter((f) => !SCENARIOS.test(f.path.slice(join(dir, "upstream").length + 1)));
  const counted = {};
  for (const f of tree) {
    const rel = f.path.slice(join(dir, "upstream").length + 1);
    const scenario = /^([a-z]+)\//.exec(rel)?.[1];
    if (scenario && SCENARIOS.test(`${scenario}/`)) counted[scenario] = (counted[scenario] ?? 0) + 1;
  }
  console.log(`\nthe other scenarios, by file count (the pack fetches none of them): ${
    Object.entries(counted).sort().map(([k, v]) => `${k} ${v}`).join(", ")}`);

  // ---- the classification: abaplint over the kept folders, deps = libs + src/
  const srcDir = join(root, "packs/rap-flight/src");
  const overlay = walk(srcDir).map((f) => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
  const libs = await loadLibs(root, JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8")));
  const reg = new core.Registry(new core.Config(JSON.stringify(
    {global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."},
      // the classification the document describes: a parser error first, else
      // a syntax or unknown-type issue, else clean -- abaplint ships each of
      // those as a rule, so the rules are those two and nothing else
      rules: {parser_error: true, check_syntax: true}})));
  // the pack's own src/ layers over the fetched tree the way the build
  // layers it: the overlay's copies win their object (the two data
  // generators), the stand-ins resolve what upstream only names, and
  // anything the tree does not hold is a plain extra. The libraries stay
  // dependencies, as they are for the build.
  const overlayNames = new Set(overlay.map((f) => f.filename));
  const main = [...kept.filter((f) => !overlayNames.has(f.filename)), ...overlay];
  for (const f of main) reg.addFile(new core.MemoryFile(f.filename, f.contents));
  for (const f of libs) reg.addDependency(new core.MemoryFile(f.filename, f.contents));
  const byObject = new Map();
  for (const issue of reg.findIssues()) {
    const filename = issue.getFilename();
    const type = typeOf(filename ?? "");
    if (type === undefined) continue;
    const key = /parser_error/.test(issue.getKey()) ? "parser" : "needs";
    byObject.set(filename, byObject.get(filename) === "parser" ? "parser" : key);
  }
  // one row per OBJECT, not per file: the .xml beside the .abap is the same object
  const objects = new Map();
  for (const f of kept) {
    const type = typeOf(f.filename);
    if (type === undefined || type === "devc") continue;
    const name = f.filename.split(".")[0].replace(/#/g, "/").toUpperCase();
    const id = `${type} ${name}`;
    const verdict = byObject.get(f.filename);
    const row = objects.get(id) ?? {type, verdict: "clean"};
    if (verdict === "parser" || (verdict === "needs" && row.verdict === "clean")) row.verdict = verdict;
    objects.set(id, row);
  }
  const rows = {};
  for (const {type, verdict} of objects.values()) {
    rows[type] ??= {objects: 0, clean: 0, parser: 0, needs: 0};
    rows[type].objects++;
    rows[type][verdict === "clean" ? "clean" : verdict]++;
  }
  console.log("\n## The scenario, by object type (kept folders)");
  console.log("| type | objects | lint-clean | refused (parser) | needs a feature or an object |");
  console.log("| --- | ---: | ---: | ---: | ---: |");
  for (const type of Object.keys(rows).sort()) {
    console.log(`| ${type} | ${rows[type].objects} | ${rows[type].clean} | ${rows[type].parser} | ${rows[type].needs} |`);
  }

  // ---- the BDEFs: bdef-gen's own refusal per file, which is the first wall
  const ddic = kept.filter((f) => /\.(ddls\.(asddls|xml)|tabl\.xml|view\.xml|dtel\.xml|doma\.xml)$/.test(f.filename));
  const libDdic = libraryDdic();
  console.log("\n## The behavior definitions against bdef-gen.mjs (first wall)");
  console.log("| BDEF | kind | first wall |");
  console.log("| --- | --- | --- |");
  for (const bdef of kept.filter((f) => f.filename.endsWith(".bdef.asbdef")).sort((a, b) => a.filename.localeCompare(b.filename))) {
    const model = parseBdef(bdef.contents);
    const kind = model.unparsed?.length ? "unparsed" : `${model.implementationType ?? "?"}`;
    try {
      generate([bdef, ...ddic], libDdic);
      console.log(`| ${bdef.filename.split(".")[0].replace(/#/g, "/").toUpperCase()} | ${kind} | accepted |`);
    } catch (error) {
      console.log(`| ${bdef.filename.split(".")[0].replace(/#/g, "/").toUpperCase()} | ${kind} | ${String(error.message).split("\n")[0]} |`);
    }
  }

  // ---- the service definitions: bdef-gen's srvd half per file (R3). A
  // service definition is served whole, never parsed for types alone, so
  // the wall is the first exposed entity the view layer cannot give the
  // generator (a view the pack does not fetch, or one cds2ddic skips)
  console.log("\n## The service definitions against bdef-gen.mjs (srvd half)");
  console.log("| SRVD | verdict |");
  console.log("| --- | --- |");
  for (const srvd of kept.filter((f) => f.filename.endsWith(".srvd.srvdsrv")).sort((a, b) => a.filename.localeCompare(b.filename))) {
    try {
      const {outputs} = generate([...ddic, srvd], libDdic);
      console.log(`| ${srvd.filename.split(".")[0].replace(/#/g, "/").toUpperCase()} | served (${Object.keys(outputs).filter((n) => n.endsWith(".stg.yaml")).length} service) |`);
    } catch (error) {
      console.log(`| ${srvd.filename.split(".")[0].replace(/#/g, "/").toUpperCase()} | ${String(error.message).split("\n")[0]} |`);
    }
  }

  // ---- the views: cds2ddic's own reading per view
  console.log("\n## The CDS views against cds2ddic.mjs");
  const skips = new Map();
  let generated = 0;
  for (const o of reg.getObjectsByType("DDLS")) {
    const view = parseDDLS(o, reg);
    if (view === undefined || view.skip === undefined) generated++;
    else skips.set(view.skip, (skips.get(view.skip) ?? 0) + 1);
  }
  console.log(`| verdict | views |`);
  console.log(`| --- | ---: |`);
  console.log(`| generated | ${generated} |`);
  for (const [reason, count] of [...skips.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`| ${reason} | ${count} |`);
  }
  return 0;
}

if (runsAs("classify.mjs")) {
  main().then((code) => process.exit(code), (error) => { console.error(error); process.exit(1); });
}
