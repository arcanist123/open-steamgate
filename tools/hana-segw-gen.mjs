#!/usr/bin/env node
// Service registration out of a tenant's Gateway tables (H5b).
//
// The registration facts a SEGW project leaves behind live in a real
// system as one row each: the service exists (its URL name and its DPC),
// its model is Y, model Y's MPC class. The XML path reads the same facts
// out of abapGit's *.iwsv.xml / *.iwmo.xml (tools/segw-registry.mjs); this
// tool reads them out of a dump the way the dumper wrote it --
// tables/<name with / as #>.jsonl -- and hands them to the SAME writer, so
// there is one generated registry and no second writer:
//
//   node tools/hana-segw-gen.mjs --from-dump <dir> [--service <NAME>[:<VERSION>]]... [--check]
//
//   --from-dump <dir>   the dump directory (manifest.json, reposrc.jsonl,
//                       tables/*.jsonl); it is only ever read
//   --service <NAME>[:<VERSION>]  repeatable; a technical name as the SRH
//                       table carries it, with an optional version, also as
//                       the tables carry it ("0001"). Default: every service
//                       row of the dump
//   --seed              the selection is the closure's seed (milestone 4,
//                       tools/hana-closure-seed.mjs): from-dump.json says
//                       `selection: "seed"`, and the seed guard protects
//                       the skipped services' classes too
//   --check             compare the facts folder (gen/hana-segw) and the
//                       registry class with what would be written; exit 1
//                       on drift (the manifest carries no clock:
//                       gen/hana-segw is hashed as an input folder, and a
//                       clock in it would rename every generation)
//
// The facts live at <root>/gen/hana-segw and nowhere else -- the folder is
// not an option. A folder of their own, NOT gen/segw, for two reasons the
// build dictates: it is an input folder entry (gen/hana-ddic's rule), so
// writing the facts renames the generation and the rebuild actually
// happens -- while the class under gen/segw is generator output the build
// itself rewrites mid-build, which a hashed folder must never hold (the
// build refuses: the bytes the generation is named by are the bytes it is
// built from). And it is private the way gen/hana-src is: a prefix in the
// one list (tools/osd-tmp.mjs), refused by generationHanaSrcProblem,
// dropped by every publisher's gen/ copy filter. Fixed is what that buys:
// segwPrivateGen's mark is gen/hana-segw/from-dump.json, so a registry
// fed from a dump is marked whatever the invocation -- the class at
// gen/segw cannot be written without the mark beside it.
//
// The join is the tables' own: SRH.TECHNICAL_NAME+VERSION ->
// SRG.GROUP_TECH_NAME+GROUP_VERSION -> SRG.MODEL_TECH_NAME+MODEL_VERSION ->
// OHD.TECHNICAL_NAME+VERSION. The service text comes from the SRT table
// (the language the XML DESCRIPTION element stands for: E, else the first
// by language); the OHT is not read, because the XML side has no consumer
// for the model description either. A class counts as present when the
// dump's reposrc.jsonl names its class pool (the name padded with '=' to
// 30, then CP) or SEOCLASS names it, or when gen/hana-src holds its source
// -- the classes ride into the build through H4's layers. A service whose
// DPC or MPC class is absent is reported and skipped, never emitted.
//
// What lands where: the facts (from-dump.json: the joined services, the
// skips, the XML overrides; manifest.json: source, dump, provenance) in
// gen/hana-segw, and the registry class itself at gen/segw, where it always
// lived -- merged under the XML objects (a service both sources name keeps
// its XML registration, reported as an override) through
// tools/segw-registry.mjs's one writer. The build's own segw-registry run
// produces the same bytes from the facts, so the class on disk is stable
// across builds; during a dump-fed phase it carries tenant service names,
// so the publishers' gen/ copy filters drop gen/segw while the facts
// exist (segwPrivateGen, tools/osd-tmp.mjs).
import {existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {generatorFoldersOf} from "./osd-packs.mjs";
import {mergeRegistrations, registryClass, segwRegistrations} from "./segw-registry.mjs";

const str = (v) => String(v ?? "").trim();
const key = (technical, version) => `${str(technical)}/${str(version)}`;

// one JSONL table of the dump, by its real name (the dumper writes <name
// with / as #>); a table the dump does not carry reads as empty
function readTable(dumpDir, table) {
  return jsonlLines(join(dumpDir, "tables", `${table.replaceAll("/", "#")}.jsonl`));
}

function jsonlLines(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  return text.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
}

// the classes the dump itself knows: reposrc names a class by its pool
// program (the class name padded with '=' to 30, then CP -- the padding is
// what a namespaced or long name spends), SEOCLASS names it directly
function dumpClasses(dumpDir) {
  const names = new Set();
  for (const row of jsonlLines(join(dumpDir, "reposrc.jsonl"))) {
    if (str(row.state).toUpperCase() !== "A") continue;
    const program = str(row.program);
    if (program.endsWith("CP") === false) continue;
    names.add(program.slice(0, -2).replace(/=+$/, "").toUpperCase());
  }
  for (const row of readTable(dumpDir, "SEOCLASS")) {
    if (str(row.CLSNAME) !== "") names.add(str(row.CLSNAME).toUpperCase());
  }
  return names;
}

// the classes gen/hana-src holds (H4): abapGit names a class source
// <lower name, / as #>.clas.abap. A real closure layer's flat src/ holds
// interfaces, programs and function groups beside them; exec() returns
// null -- never undefined -- for every file that is not one, and those
// are skipped
function layerClasses(root) {
  const names = new Set();
  const base = join(root, "gen", "hana-src");
  let folders;
  try {
    folders = readdirSync(base, {withFileTypes: true});
  } catch {
    return names;
  }
  for (const folder of folders) {
    if (folder.isDirectory() === false) continue;
    let files;
    try {
      files = readdirSync(join(base, folder.name, "src"), {withFileTypes: true});
    } catch {
      continue;
    }
    for (const file of files) {
      const m = /^(.+)\.clas\.abap$/i.exec(file.name);
      if (m === null) continue;
      let name = m[1];
      try {
        name = decodeURIComponent(name);
      } catch {
        // as it stands
      }
      names.add(name.toUpperCase().replaceAll("#", "/"));
    }
  }
  return names;
}

// the service text: the SRT row in E -- the language the XML DESCRIPTION
// element stands for -- else the first by language
function describe(rows) {
  if (rows === undefined || rows.length === 0) return "";
  const inE = rows.find((r) => str(r.LANGUAGE).toUpperCase() === "E");
  const row = inE ?? [...rows].sort((a, b) => str(a.LANGUAGE).localeCompare(str(b.LANGUAGE)))[0];
  return str(row.DESCRIPTION);
}

// --service <NAME>[:<VERSION>], repeatable; a selection nothing matches is
// a typo and refuses -- the default selection is where versions that fail
// the join are reported, not here
function selectServices(rows, selections) {
  if (selections.length === 0) return rows;
  const picked = new Map();
  for (const sel of selections) {
    const at = sel.indexOf(":");
    const name = (at < 0 ? sel : sel.slice(0, at)).toUpperCase();
    const version = at < 0 ? undefined : sel.slice(at + 1).toUpperCase();
    const hits = rows.filter((r) => str(r.TECHNICAL_NAME).toUpperCase() === name &&
      (version === undefined || str(r.VERSION).toUpperCase() === version));
    if (hits.length === 0) {
      throw new Error(`hana-segw-gen: --service ${sel} names no service row in the dump`);
    }
    for (const hit of hits) picked.set(key(hit.TECHNICAL_NAME, hit.VERSION), hit);
  }
  return [...picked.values()];
}

/** the join: SRH -> SRG -> OHD on the keys the tables carry, descriptions
 *  from SRT, classes checked against the dump and gen/hana-src. Pure over
 *  its inputs. A service whose model or class is missing is reported in
 *  skipped, never in entries. */
export function joinServices({srh, srg, ohd, srt}, classes, selections = []) {
  const srgOf = new Map(srg.filter((r) => str(r.GROUP_TECH_NAME) !== "").map((r) => [key(r.GROUP_TECH_NAME, r.GROUP_VERSION), r]));
  const ohdOf = new Map(ohd.filter((r) => str(r.TECHNICAL_NAME) !== "").map((r) => [key(r.TECHNICAL_NAME, r.VERSION), r]));
  const srtOf = new Map();
  for (const r of srt) {
    const k = key(r.TECHNICAL_NAME, r.VERSION);
    srtOf.set(k, [...(srtOf.get(k) ?? []), r]);
  }
  const entries = [];
  const skipped = [];
  for (const row of selectServices(srh.filter((r) => str(r.TECHNICAL_NAME) !== "" && str(r.VERSION) !== ""), selections)) {
    const service = str(row.TECHNICAL_NAME);
    const version = str(row.VERSION);
    const k = key(service, version);
    const group = srgOf.get(k);
    const dpc = str(row.CLASS_NAME).toUpperCase();
    if (group === undefined) {
      skipped.push({service, version, dpc, reason: `no model registration for ${k}`});
      continue;
    }
    const model = ohdOf.get(key(group.MODEL_TECH_NAME, group.MODEL_VERSION));
    if (model === undefined) {
      skipped.push({service, version, dpc, reason: `no MPC registration for model ${str(group.MODEL_TECH_NAME)}/${str(group.MODEL_VERSION)}`});
      continue;
    }
    const mpc = str(model.CLASS_NAME).toUpperCase();
    if (classes.has(dpc) === false) {
      skipped.push({service, version, dpc, mpc, reason: `class ${dpc} is not in the dump or gen/hana-src`});
      continue;
    }
    if (mpc === "" || classes.has(mpc) === false) {
      skipped.push({service, version, dpc, mpc, reason: `class ${mpc === "" ? str(group.MODEL_TECH_NAME) : mpc} is not in the dump or gen/hana-src`});
      continue;
    }
    entries.push({
      service, version,
      external: str(row.EXTERNAL_NAME) || service,
      dpc, mpc,
      model: str(group.MODEL_TECH_NAME), modelVersion: str(group.MODEL_VERSION),
      description: describe(srtOf.get(k)),
    });
  }
  entries.sort((a, b) => a.service.localeCompare(b.service));
  skipped.sort((a, b) => a.service.localeCompare(b.service) || a.version.localeCompare(b.version));
  return {entries, skipped};
}

function loadDump(dumpDir, selections, root) {
  try {
    readdirSync(dumpDir);
  } catch (error) {
    throw new Error(`hana-segw-gen: cannot read the dump directory ${dumpDir} (${error.message})`);
  }
  let provenance;
  try {
    const manifest = JSON.parse(readFileSync(join(dumpDir, "manifest.json"), "utf8"));
    if (str(manifest.provenance) !== "") provenance = str(manifest.provenance);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error(`hana-segw-gen: ${join(dumpDir, "manifest.json")} is not readable as JSON (${error.message})`);
    }
  }
  const classes = dumpClasses(dumpDir);
  for (const name of layerClasses(root)) classes.add(name);
  const {entries, skipped} = joinServices({
    srh: readTable(dumpDir, "/IWBEP/I_MGW_SRH"),
    srg: readTable(dumpDir, "/IWBEP/I_MGW_SRG"),
    ohd: readTable(dumpDir, "/IWBEP/I_MGW_OHD"),
    srt: readTable(dumpDir, "/IWBEP/I_MGW_SRT"),
  }, classes, selections);
  return {entries, skipped, provenance};
}

// the manifest: source, the dump, the provenance the dump manifest carried.
// No clock: gen/hana-segw is hashed as an input folder of its own
// (abap_transpile.json; the gen/ folder itself is skipped from the hash,
// tools/osd-build.mjs), and a clock in a hashed file renames every
// generation
function manifestFor(dumpDir, entries, skipped, provenance) {
  return {
    tool: "hana-segw-gen",
    source: "dump",
    dump: resolve(dumpDir),
    ...(provenance !== undefined ? {provenance} : {}),
    services: entries.length,
    skipped: skipped.length,
  };
}

// drift, one line per difference: a file missing or changed. gen/segw is a
// shared folder (the XML writer and segw-shlp write beside this tool), so
// an extra file that is not this tool's is no drift here
function driftOf(out, files) {
  if (existsSync(out) === false) {
    return [`${out} does not exist (write it first, without --check)`];
  }
  const drift = [];
  for (const [name, content] of Object.entries(files)) {
    const at = join(out, name);
    if (existsSync(at) === false) drift.push(`${name}: missing`);
    else if (readFileSync(at, "utf8") !== content) drift.push(`${name}: differs`);
  }
  return drift;
}

function take(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`hana-segw-gen: ${name} needs a value`);
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
  const root = options.root ?? process.env.OSD_ROOT ?? process.cwd();
  // the facts folder is not an option: the mark the publishers' filters
  // read is gen/hana-segw/from-dump.json, and the class at gen/segw
  // carries tenant names exactly while it exists -- a registry fed from a
  // dump is marked whatever the invocation
  const facts = join(root, "gen", "hana-segw");
  const out = join(root, "gen", "segw");
  const dumpDir = take(args, "--from-dump");
  const selections = [];
  while (args.includes("--service")) selections.push(take(args, "--service"));
  const check = has(args, "--check");
  const seed = has(args, "--seed");
  const log = options.log ?? console.log;
  if (args.length > 0) throw new Error(`unknown option ${args.find((a) => a.startsWith("--")) ?? args[0]}`);
  if (dumpDir === undefined) {
    throw new Error("hana-segw-gen: --from-dump <dir> names the dump directory");
  }
  // the dump holds a tenant's registration rows: read once, never written
  const {entries, skipped, provenance} = loadDump(dumpDir, selections, root);
  // the same folders the build's segw-registry run reads, so the class on
  // disk is the bytes the build writes from the facts
  const xmlEntries = segwRegistrations(generatorFoldersOf(root).map((folder) => join(root, folder)));
  const merged = mergeRegistrations(xmlEntries, entries);
  const manifest = manifestFor(dumpDir, entries, skipped, provenance);
  const files = {
    "from-dump.json": JSON.stringify({...(seed === true ? {selection: "seed"} : {}), services: entries, skipped, overridden: merged.overrides}, undefined, 2) + "\n",
    "manifest.json": JSON.stringify(manifest, undefined, 2) + "\n",
  };
  const abap = registryClass(merged.entries);
  if (check === true) {
    const drift = [...driftOf(facts, files), ...driftOf(out, {"zcl_stg_segw_registry.clas.abap": abap})];
    if (drift.length === 0) {
      log(`hana-segw-gen: ${facts} matches ${resolve(dumpDir)} (${entries.length} service(s), ${skipped.length} skipped, ${merged.overrides.length} overridden)`);
      return 0;
    }
    for (const line of drift) log(`hana-segw-gen: ${line}`);
    log(`hana-segw-gen: ${facts} has drifted from ${resolve(dumpDir)}: ${drift.length} difference(s)`);
    return 1;
  }
  mkdirSync(facts, {recursive: true});
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(facts, name), content);
  }
  mkdirSync(out, {recursive: true});
  writeFileSync(join(out, "zcl_stg_segw_registry.clas.abap"), abap);
  for (const e of entries) {
    log(`hana-segw-gen: ${e.external} -> MPC ${e.mpc}, DPC ${e.dpc}${e.description ? " (" + e.description + ")" : ""}`);
  }
  for (const s of skipped) {
    log(`hana-segw-gen: ${s.service}/${s.version}: skipped, ${s.reason}`);
  }
  log(`hana-segw-gen: ${entries.length} service(s), ${skipped.length} skipped, ${merged.overrides.length} overridden -> ${facts}`);
  return 0;
}

if (runsAs("hana-segw-gen.mjs")) {
  run().then((code) => process.exit(code)).catch((error) => {
    console.error(`hana-segw-gen: ${error?.message ?? error}`);
    process.exit(2);
  });
}
