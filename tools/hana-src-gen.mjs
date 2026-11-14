#!/usr/bin/env node
// The tenant's sources as input layers (H4 A): a converter output directory
// becomes the input folders gen/hana-src/<NNN>-<name>/, in the converter's
// plan.json order, and gen/hana-src/manifest.json records where they came
// from. No decoder and no dumper live here: the dump is made by `vsp hana
// dump` (the a4h sibling's private binary, credentials of its own) and the
// layers by the dump->layers converter; --from-dump runs the converter
// (OSD_HANA_CONVERTER names its path) on a dump directory, into a temp dir,
// and nothing ever reads the dump's tables/*.jsonl -- the provenance this
// tool records is what plan.json copied from the dump manifest.
//
//   node tools/hana-src-gen.mjs --layers <dir> [--layers <dir>]... [--packages <LIKE>]... [--check] [--out <dir>]
//   node tools/hana-src-gen.mjs --from-dump --dump <dir> --system <prefix> [--packages <LIKE>]... [--check] [--out <dir>]
//
//   --layers <dir>      a converter output directory: plan.json +
//                       layers/<name>/{.abapgit.xml, src/}. Repeatable
//                       (H5c round 4): the output is the UNION of the
//                       plans -- one folder per layer name (the same
//                       <system>-<package> layer in two dumps is ONE
//                       folder), each file from the LATER dir that
//                       carries it, later wins per object (reported),
//                       folders renumbered 0..n in the flags' order so
//                       the names sort the way the flags read. One
//                       --layers behaves as before: the plan's own
//                       orders, unchanged.
//   --from-dump         run the converter on --dump first, into a temp dir;
//                       the dumper itself is not run (its credentials are
//                       the dump track's own)
//   --dump <dir>        the dump directory
//   --system <prefix>   the converter names layers <system>-<package> and
//                       requires the prefix, so --from-dump does too
//   --packages <LIKE>   repeatable; the converter's own glob over plan.json's
//                       package (% or * is any run of characters, _ is one).
//                       A cycle group rides in when any member matches: its
//                       members cannot be ordered against each other, so it
//                       is one folder or none
//   --check             compare an existing --out with what would be
//                       written; exit 1 on drift (generated_at is not
//                       compared: every run would drift on the clock)
//   --out <dir>         default gen/hana-src
//
// Refusals, named: a layer folder without .abapgit.xml; a folder beside a
// layer's src/ or a nested one inside it (a converter layer is .abapgit.xml
// and a flat src/, nothing else -- a file beside src/ is ignored, not
// copied); a plan.json folder path that leaves the layers directory; a
// plan.json schema this tool does not read; --layers inside this tree unless
// under gen/ or .local/ (dumps hold a real tenant's sources, and both of
// those are untracked); an --out held to the same rule (an --out inside the
// tree lands the manifest on a tracked path); an --out that exists without
// this tool's manifest.json in it. An --out WITH the manifest is replaced
// wholesale: stale children of a previous dump must not linger beside the
// new ones.
//
// The NNN is the plan's order, zero-padded to the widest order the plan
// names, three at least, so the folder names sort in dependency order -- the
// same order the "gen/hana-src/*" entry of abap_transpile.json reads them
// in (tools/osd-packs.mjs expandedFolders; the later folder wins, so the
// real system's sources lose to a hand-written src/ override only on
// purpose).
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join, relative, resolve, sep} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {scriptCommandIn} from "./osd-host.mjs";

// the converter's --package glob: % and * are any run of characters, _ is one
function likeToRegExp(pattern) {
  return new RegExp("^" + [...pattern.toUpperCase()].map((c) =>
    c === "%" || c === "*" ? ".*" : c === "_" ? "." : c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("") + "$");
}

// the island's test-code rule (H5c round 7, the same rule
// tools/hana-closure-merge.mjs's object count applies): a test-classes
// include (any object's *.testclasses.abap) and a *_TEST class are not
// island content -- the dumper's --skip-test-includes keeps the closure
// from pulling test frameworks (the bed run pulled SAP's unit-test
// assertion class through a facade's test include), and a dump that
// carries them anyway does not stage them into gen/hana-src; findings in
// them are not island findings. One rule, exported from here since H5x-1
// (S-7.2): the merge's object count and the loop test's fake host import
// it, so the loop scenario proves the real predicate.
// An exception class is not test code whatever its name ends in: it is
// raised by the code that names it, and staging it out left the bed's test
// utilities (RAISING cx_..._test) red for good while the closure asked for
// it every round (H5x-4 B4).
export const islandTestCode = (name) =>
  /\.testclasses\.abap$/i.test(name) === true ||
  (/^[^.]*_test\.clas\./i.test(name) === true && /^(?:#[^#]+#)?[yz]?cx_/i.test(name) === false);
const isTestCode = islandTestCode;

/** the plan checks, said once: schema 1, a layers array, every layer named
 *  and ordered. */
function checkedPlan(plan) {
  if (plan.schema !== 1) {
    throw new Error(`hana-src-gen: plan.json schema ${JSON.stringify(plan.schema)} is not understood; this tool reads schema 1`);
  }
  if (Array.isArray(plan.layers) === false) {
    throw new Error("hana-src-gen: plan.json carries no layers array");
  }
  for (const layer of plan.layers) {
    if (typeof layer?.name !== "string" || typeof layer?.order !== "number") {
      throw new Error("hana-src-gen: plan.json has a layer without a name or an order");
    }
  }
  return plan;
}

/** the write plan: one group per folder, in order, the cycle members merged
 *  into one group at their smallest order. Pure. Throws when a pattern names
 *  no package (the converter refuses the same way) or the plan is not one
 *  this tool reads -- except with checkMissing false: the union of several
 *  --layers dirs checks the patterns against ALL of them (mergedIntended). */
export function selectGroups(plan, patterns = [], options = {}) {
  checkedPlan(plan);
  const regexps = patterns.map(likeToRegExp);
  const packages = plan.layers.map((layer) => layer.package).filter((p) => p !== null && p !== undefined);
  if (options.checkMissing !== false) {
    for (const [i, re] of regexps.entries()) {
      if (packages.some((p) => re.test(p)) === false) {
        throw new Error(`hana-src-gen: no layer matches --packages ${patterns[i]}`);
      }
    }
  }
  const byName = new Map(plan.layers.map((layer) => [layer.name, layer]));
  const cycleOf = new Map();
  for (const cycle of plan.cycles ?? []) {
    if (Array.isArray(cycle) === false || cycle.length === 0) continue;
    for (const name of cycle) cycleOf.set(name, cycle);
  }
  const selected = (layer) => regexps.length === 0 || regexps.some((re) => layer.package !== null && layer.package !== undefined && re.test(layer.package));
  const done = new Set();
  const groups = [];
  for (const layer of plan.layers) {
    if (done.has(layer.name)) continue;
    const cycle = cycleOf.get(layer.name);
    const members = cycle === undefined ? [layer]
      : cycle.map((name) => byName.get(name)).filter(Boolean);
    for (const member of members) done.add(member.name);
    if (members.some(selected) === false) continue;
    groups.push({layers: members, cycle, order: Math.min(...members.map((m) => m.order))});
  }
  return groups.sort((a, b) => a.order - b.order);
}

// the zero-padded order: wide enough that the names sort in plan order
const padWidth = (plan) => Math.max(3, ...plan.layers.map((layer) => String(layer.order).length));

function groupFolder(group, width) {
  const pad = String(group.order).padStart(width, "0");
  return group.cycle === undefined ? `${pad}-${group.layers[0].name}` : `${pad}-cycle-${group.cycle.join("+")}`;
}

/** one layer folder of the layers directory: the files to copy, relative to
 *  the folder, in name order. Refuses what the converter never writes: a
 *  missing .abapgit.xml, a folder beside src/ (a converter layer is
 *  .abapgit.xml and a flat src/, nothing else), a nested folder inside src/,
 *  a src/ that is not there, a folder path that leaves the layers directory.
 *  A file beside a layer folder (a package.devc.xml, when the converter
 *  grows one) is ignored, not copied. */
function layerFiles(layersDir, layer) {
  const base = resolve(layersDir);
  const folder = resolve(base, layer.folder ?? `layers/${layer.name}`);
  if (folder !== base && folder.startsWith(base + sep) === false) {
    throw new Error(`hana-src-gen: plan.json folder ${JSON.stringify(layer.folder)} leaves the layers directory`);
  }
  const marker = join(folder, ".abapgit.xml");
  if (existsSync(marker) === false || statSync(marker).isFile() === false) {
    throw new Error(`hana-src-gen: layer ${layer.name} (${layer.folder}) has no .abapgit.xml -- not a converter layer`);
  }
  for (const entry of readdirSync(folder, {withFileTypes: true})) {
    if (entry.isDirectory() && entry.name !== "src") {
      throw new Error(`hana-src-gen: layer ${layer.name} (${layer.folder}) holds ${entry.name}/ beside src/ -- a converter layer is .abapgit.xml and a flat src/ only`);
    }
  }
  let entries;
  try {
    entries = readdirSync(join(folder, "src"), {withFileTypes: true});
  } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes(error?.code)) {
      throw new Error(`hana-src-gen: layer ${layer.name} (${layer.folder}) has no src/ -- not a converter layer`);
    }
    throw error;
  }
  const files = [];
  for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.isDirectory()) {
      throw new Error(`hana-src-gen: ${layer.folder}/src/${entry.name} is a folder -- a converter layer's src/ is flat`);
    }
    if (entry.name === ".abapgit.xml") continue;
    if (isTestCode(entry.name) === true) {
      console.log(`hana-src-gen: ${layer.name}: ${entry.name} skipped (test code)`);
      continue;
    }
    files.push(`src/${entry.name}`);
  }
  return files;
}

// the folders this run would write: folder base name -> (relative path ->
// absolute source), and the groups for the manifest
function intended(layersDir, plan, patterns) {
  const groups = selectGroups(plan, patterns);
  const width = padWidth(plan);
  const tree = new Map();
  for (const group of groups) {
    const name = groupFolder(group, width);
    const files = new Map([[".abapgit.xml", resolve(layersDir, group.layers[0].folder ?? `layers/${group.layers[0].name}`, ".abapgit.xml")]]);
    for (const layer of group.layers) {
      for (const rel of layerFiles(layersDir, layer)) {
        if (files.has(rel)) {
          throw new Error(`hana-src-gen: ${name}: ${rel} is in two members of the cycle`);
        }
        files.set(rel, resolve(layersDir, layer.folder ?? `layers/${layer.name}`, rel));
      }
    }
    tree.set(name, files);
  }
  return {tree, groups};
}

// several --layers dirs (round 4): the UNION of their plans -- one folder
// per layer name (the same <system>-<package> layer in two dumps is one
// folder), every file from the LATER dir that carries it (later wins per
// object), the .abapgit.xml of the later dir, folders renumbered 0..n in
// the flags' order (each plan's own order kept inside it) so the names
// sort the way the flags read -- a cross-dump object that lands in two
// differently named folders is won by the later dump. Same {tree, groups}
// shape intended() returns; the later-wins takeovers are reported.
function mergedIntended(dirs, patterns) {
  const merged = new Map();
  const packages = [];
  let order = 0;
  for (const dir of dirs) {
    const plan = checkedPlan(JSON.parse(readFileSync(join(dir, "plan.json"), "utf8")));
    for (const layer of plan.layers) {
      if (layer.package !== null && layer.package !== undefined) packages.push(layer.package);
    }
    for (const group of selectGroups(plan, patterns, {checkMissing: false})) {
      const key = group.cycle === undefined ? group.layers[0].name : `cycle-${group.cycle.join("+")}`;
      let entry = merged.get(key);
      if (entry === undefined) {
        entry = {key, order: order++, package: group.cycle === undefined ? group.layers[0].package : null,
          cycle: group.cycle, objects: {}, files: new Map(), taken: 0};
        merged.set(key, entry);
      }
      for (const layer of group.layers) {
        for (const rel of layerFiles(dir, layer)) {
          if (entry.files.has(rel)) entry.taken++;
          entry.files.set(rel, resolve(dir, layer.folder ?? `layers/${layer.name}`, rel));
        }
        for (const [kind, count] of Object.entries(layer.objects ?? {})) entry.objects[kind] = count;
      }
      entry.files.set(".abapgit.xml", resolve(dir, group.layers[0].folder ?? `layers/${group.layers[0].name}`, ".abapgit.xml"));
    }
  }
  for (const [i, re] of patterns.map(likeToRegExp).entries()) {
    if (packages.some((p) => re.test(p)) === false) {
      throw new Error(`hana-src-gen: no layer matches --packages ${patterns[i]}`);
    }
  }
  const width = Math.max(3, String(Math.max(0, order - 1)).length);
  const tree = new Map();
  const groups = [];
  for (const entry of merged.values()) {
    const folder = groupFolder({order: entry.order, cycle: entry.cycle, layers: [{name: entry.key}]}, width);
    tree.set(folder, entry.files);
    groups.push({name: entry.key, package: entry.package, order: entry.order, objects: entry.objects,
      ...(entry.cycle === undefined ? {} : {cycle: entry.cycle})});
    if (entry.taken > 0) console.log(`hana-src-gen: ${folder}: ${entry.taken} file(s) from a later dump kept (later wins)`);
  }
  return {tree, groups};
}

// the manifest of a union: the sources are all the dirs, the dump
// provenance is the LAST dir that carries one (the current dump's -- the
// generation hash the request reads), no_source and the converter commit
// merged from the last plan that carries each
function mergedManifest(dirs, groups) {
  const noSource = {};
  let dump;
  let converterCommit;
  for (const dir of dirs) {
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    for (const [kind, count] of Object.entries(plan.no_source ?? {})) noSource[kind] = count;
    if (plan.dump !== undefined) dump = plan.dump;
    if (plan.converter_commit !== undefined) converterCommit = plan.converter_commit;
  }
  return {
    source: [...dirs],
    ...(dump !== undefined ? {dump} : {}),
    ...(converterCommit !== undefined ? {converter_commit: converterCommit} : {}),
    layers: groups,
    no_source: noSource,
    generated_at: new Date().toISOString(),
  };
}

function manifestFor(source, plan, groups, system) {
  const width = padWidth(plan);
  return {
    source,
    ...(system !== undefined ? {system} : {}),
    ...(plan.dump !== undefined ? {dump: plan.dump} : {}),
    ...(plan.converter_commit !== undefined ? {converter_commit: plan.converter_commit} : {}),
    layers: groups.map((group) => {
      const objects = {};
      for (const layer of group.layers) {
        for (const [kind, count] of Object.entries(layer.objects ?? {})) {
          objects[kind] = (objects[kind] ?? 0) + count;
        }
      }
      return {
        name: group.cycle === undefined ? group.layers[0].name : `cycle-${group.cycle.join("+")}`,
        package: group.cycle === undefined ? group.layers[0].package : null,
        order: group.order,
        objects,
        ...(group.cycle === undefined ? {} : {cycle: group.cycle}),
      };
    }),
    no_source: plan.no_source ?? {},
    generated_at: new Date().toISOString(),
  };
}

// the tree this file lives in, resolved on first use (tools/osd-inputs.mjs's
// rule: a call at module scope is evaluated by the bundler's target whether
// or not anybody calls the function)
let TREE;
const treeRoot = () => TREE ??= decodeURIComponent(new URL("../", import.meta.url).pathname);

/** a layers directory inside this tree holds a real tenant's sources where a
 *  commit could reach them, and an --out inside the tree lands the manifest
 *  on a tracked path: both refused, unless they sit under gen/ or .local/
 *  (both untracked). options.root stands in for the tree in tests. */
export function withinTree(dir, root = treeRoot(), flag = "--layers") {
  const base = resolve(root);
  const at = resolve(dir);
  if (at === base || at.startsWith(base + sep) === false) return;
  const rel = relative(base, at);
  const allowed = rel === "gen" || rel.startsWith(`gen${sep}`) || rel === ".local" || rel.startsWith(`.local${sep}`);
  if (allowed) return;
  if (flag === "--layers") {
    throw new Error(`hana-src-gen: --layers ${dir} is inside this tree, and dumps hold a real tenant's sources -- keep it under gen/ or .local/ (both untracked), or outside the repository`);
  }
  throw new Error(`hana-src-gen: --out ${dir} is inside this tree -- keep it under gen/ or .local/ (both untracked) so neither the layers nor the manifest is ever committed, or outside the repository`);
}

const sameFile = (a, b) => readFileSync(a).equals(readFileSync(b));

function writeTree(out, tree, manifest) {
  if (existsSync(out)) {
    if (existsSync(join(out, "manifest.json")) === false) {
      throw new Error(`hana-src-gen: ${out} exists and holds no manifest.json -- it was not written by this tool; remove it or pass --out`);
    }
    rmSync(out, {recursive: true, force: true});
  }
  mkdirSync(out, {recursive: true});
  let count = 0;
  for (const [name, files] of [...tree].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    mkdirSync(join(out, name, "src"), {recursive: true});
    for (const [rel, source] of files) {
      copyFileSync(source, join(out, name, rel));
      count++;
    }
    console.log(`hana-src-gen: ${name}: ${files.size} file(s)`);
  }
  writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`hana-src-gen: ${tree.size} layer folder(s), ${count} file(s), no_source ${Object.keys(manifest.no_source).length} kind(s) -> ${join(out, "manifest.json")}`);
}

// drift, one line per difference: a folder or file missing, an extra one,
// a content difference, a manifest beyond its clock
function driftOf(out, tree, manifest) {
  const drift = [];
  if (existsSync(join(out, "manifest.json")) === false) {
    return [`${out} does not exist (write it first, without --check)`];
  }
  const disk = new Map();
  for (const entry of [...readdirSync(out, {withFileTypes: true})].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    if (entry.name === "manifest.json") continue;
    if (entry.isDirectory() === false) {
      drift.push(`${entry.name}: not a folder this tool writes`);
      continue;
    }
    const files = new Map();
    const walk = (dir, rel) => {
      for (const e of [...readdirSync(dir, {withFileTypes: true})].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
        const at = rel === "" ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) walk(join(dir, e.name), at);
        else files.set(at, join(dir, e.name));
      }
    };
    walk(join(out, entry.name), "");
    disk.set(entry.name, files);
  }
  for (const [name, files] of tree) {
    const onDisk = disk.get(name);
    if (onDisk === undefined) {
      drift.push(`${name}: missing`);
      continue;
    }
    disk.delete(name);
    for (const rel of new Set([...files.keys(), ...onDisk.keys()])) {
      const want = files.get(rel);
      const have = onDisk.get(rel);
      if (want === undefined) drift.push(`${name}/${rel}: not written by this plan`);
      else if (have === undefined) drift.push(`${name}/${rel}: missing`);
      else if (sameFile(want, have) === false) drift.push(`${name}/${rel}: differs`);
    }
  }
  for (const [name] of disk) drift.push(`${name}: not written by this plan`);
  let recorded;
  try {
    recorded = JSON.parse(readFileSync(join(out, "manifest.json"), "utf8"));
  } catch {
    drift.push("manifest.json: not readable as JSON");
    return drift;
  }
  delete recorded.generated_at;
  const fresh = JSON.parse(JSON.stringify(manifest));
  delete fresh.generated_at;
  if (JSON.stringify(recorded) !== JSON.stringify(fresh)) {
    drift.push("manifest.json: differs (beyond generated_at)");
  }
  return drift;
}

function take(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`hana-src-gen: ${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function has(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

export async function run(args = process.argv.slice(2), options = {}) {
  const out = take(args, "--out") ?? join("gen", "hana-src");
  const layers = [];
  while (args.includes("--layers")) layers.push(take(args, "--layers"));
  const dump = take(args, "--dump");
  const system = take(args, "--system");
  const packages = [];
  while (args.includes("--packages")) packages.push(take(args, "--packages"));
  const check = has(args, "--check");
  const fromDump = has(args, "--from-dump");
  if (args.length > 0) throw new Error(`unknown option ${args.find((a) => a.startsWith("--")) ?? args[0]}`);
  if (fromDump === true && layers.length > 0) throw new Error("hana-src-gen: choose --layers or --from-dump, not both");
  if (fromDump === false && layers.length === 0) {
    throw new Error("hana-src-gen: --layers <dir> (repeatable) names converter output directories, or --from-dump --dump <dir> --system <prefix>");
  }
  if (fromDump === true) {
    if (dump === undefined || system === undefined) {
      throw new Error("hana-src-gen: --from-dump needs --dump <dir> and --system <prefix> (the converter names its layers <system>-<package>)");
    }
    const converter = process.env.OSD_HANA_CONVERTER;
    if (converter === undefined || converter === "") {
      throw new Error("hana-src-gen: OSD_HANA_CONVERTER names the dump->layers converter (a path to dump-to-layers.mjs)");
    }
    const temp = mkdtempSync(join(tmpdir(), "hana-src-layers-"));
    try {
      // the converter's argv is pinned by test: <dump> --out <temp> --system
      // <prefix>. It is an external script, not a tool of this tree, so it
      // starts through tools/osd-host.mjs like every other spawn of another
      // tool: scriptCommandIn with this process's environment -- the env is
      // forwarded HERE, not through a second wrapper on the host, whose lint
      // pins exactly one whole-environment forward.
      const [command, ...argv] = scriptCommandIn(process.env, converter, [dump, "--out", temp, "--system", system]);
      const child = spawnSync(command, argv, {stdio: "inherit"});
      if (child.status !== 0) throw new Error(`hana-src-gen: the converter exited ${child.status ?? "on a signal"}`);
      layers.push(temp);
      // the manifest's provenance is the dump, not this temp dir: a fresh
      // mkdtemp every run would make --from-dump --check drift on the path
      // alone, and point at a directory that no longer exists
      return await generate(layers, out, packages, check, options, {source: resolve(dump), system});
    } finally {
      rmSync(temp, {recursive: true, force: true});
    }
  }
  return generate(layers, out, packages, check, options);
}

async function generate(layersDirs, out, packages, check, options, provenance = {}) {
  for (const dir of layersDirs) withinTree(dir, options.root);
  withinTree(out, options.root, "--out");
  let tree;
  let groups;
  let manifest;
  if (layersDirs.length === 1) {
    const layersDir = layersDirs[0];
    const plan = JSON.parse(readFileSync(join(layersDir, "plan.json"), "utf8"));
    ({tree, groups} = intended(layersDir, plan, packages));
    manifest = manifestFor(provenance.source ?? layersDir, plan, groups, provenance.system);
  } else {
    // the union (round 4): the loop merges every dump so far, later wins
    ({tree, groups} = mergedIntended(layersDirs, packages));
    manifest = mergedManifest(layersDirs, groups);
  }
  const source = provenance.source ?? (layersDirs.length === 1 ? layersDirs[0] : `${layersDirs.length} layers dir(s)`);
  if (check === true) {
    const drift = driftOf(out, tree, manifest);
    if (drift.length === 0) {
      const files = [...tree.values()].reduce((n, f) => n + f.size, 0);
      console.log(`hana-src-gen: ${out} matches ${source} (${tree.size} folder(s), ${files} file(s))`);
      return 0;
    }
    for (const line of drift) console.log(`hana-src-gen: ${line}`);
    console.log(`hana-src-gen: ${out} has drifted from ${source}: ${drift.length} difference(s)`);
    return 1;
  }
  writeTree(out, tree, manifest);
  return 0;
}

if (runsAs("hana-src-gen.mjs")) {
  run().then((code) => process.exit(code)).catch((error) => {
    console.error(`hana-src-gen: ${error?.message ?? error}`);
    process.exit(2);
  });
}
