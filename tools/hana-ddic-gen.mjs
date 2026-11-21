#!/usr/bin/env node
// DDIC from the real DD03L for the build (H3 A): the tables the generation
// references but no input folder defines, as abapGit *.tabl.xml in
// gen/hana-ddic/, which abap_transpile.json lists as an input folder BEFORE
// src/ -- a hand-written src/**/<table>.tabl.xml of the same name is a later
// folder and wins, so the real system's DDIC loses to an override only on
// purpose (docs/db-backends.md, "Shadow schema: the client lives in HANA").
//
//   node tools/hana-ddic-gen.mjs --tables <A,B,C> [--out <dir>]
//   node tools/hana-ddic-gen.mjs --from-build [--out <dir>]
//   node tools/hana-ddic-gen.mjs --from-dump <dir> [--names A,B,C] [--check] [--out <dir>]
//
//   --tables A,B,C   read these tables from the configured schema
//   --from-build     find them yourself: run the transpile's validation over
//                    the tree and read the names out of its own error output
//                    (a missing DDIC name surfaces as
//                    `check_syntax, Database table or view "x" not found` or
//                    `unknown_types, Variable ... contains unknown: X not
//                    found`) -- the transpiler's words, never a parse of ABAP
//   --from-dump <dir>  (H5a) read the DD* tables out of a dump directory
//                    `vsp hana dump --ddic` wrote (tables/*.jsonl, one row
//                    per line, the full measured column set), with no
//                    database behind it: *.tabl.xml for every active DD02L
//                    row and -- what the live read never needed --
//                    *.dtel.xml and *.doma.xml for the DD04L and DD01L rows,
//                    with the texts of the master language (DD02T/DD04T/
//                    DD01T) and a domain's fixed values (DD07L). The rows
//                    feed the SAME mapper as the live read, one mapping;
//                    their keys arrive as HANA stores them (upper case) and
//                    are folded and trimmed here, the way the hana-client
//                    folds and trims on its way out. Search helps (DD30L-
//                    DD33L) and messages are not in --ddic and are reported;
//                    DD40L rows are counted, not written.
//   --names A,B,C   with --from-dump: write only these objects (H5c round
//                    7's per-name fill -- a name the dumps resolved that the
//                    converter's TADIR selection skipped); a name the dump's
//                    rows do not carry writes nothing and still exits 0.
//                    --check refuses it: the check compares the whole plan.
//   --check          compare an existing --out with what --from-dump would
//                    write; exit 1 on drift (the live read has no plan to
//                    compare against, so --check refuses it)
//   --out <dir>      where the XML lands; default gen/hana-ddic
//
// The DD03L -> shape mapping is tools/hana-ddic-map.mjs and the reads are
// tools/hana-ddic-probe.mjs's readTables: one mapping, one measured-column
// discipline, no second copy here. Like the probe, this tool constructs the
// client in the existing-schema mode, so it is a reader; on the bed it runs
// with OSD_CLIENT set like everything else in the mode.
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {HanaDatabaseClient} from "./hana-client.mjs";
import {nameList, readTables} from "./hana-ddic-probe.mjs";
import {abapGitFileName, ddicFields, ddicFieldsWithIncludes, domaXml, dtelXml, tablXml} from "./hana-ddic-map.mjs";
import {excludePatterns, layers} from "./osd-inputs.mjs";
import {excludedObjectFiles} from "./hana-closure-exclusions.mjs";
import {loadFiles, loadLibs, selectedModules} from "./osd-transpile.mjs";
import {orderRegistry} from "./osd-warm-order.mjs";

/** the table names out of a thrown transpiler validation: the two shapes a
 *  missing DDIC name surfaces in, upper-cased, de-duplicated, anything else in
 *  the same error ignored. A SAP namespace (/ZOSD/CARRIER) is carried -- the
 *  filter below already admitted it; the captures were what refused it, a
 *  dead branch (critic SHOULD 4 at f0a248af1). Pure, so the contract is
 *  testable without a database or a full build. */
export function tablesFromValidation(message) {
  const names = new Set();
  for (const match of String(message ?? "").matchAll(/Database table or view "([A-Za-z0-9_/]+)" not found/g)) {
    names.add(match[1].toUpperCase());
  }
  for (const match of String(message ?? "").matchAll(/contains unknown: ([A-Za-z0-9_/]+) not found/g)) {
    names.add(match[1].toUpperCase());
  }
  return [...names].filter((name) => /^[A-Z0-9_\/#$]+$/.test(name)).sort();
}

/** run the build's own validation over the tree and return its error text --
 *  an empty string when the tree validates clean (nothing unresolved). The
 *  registry is built exactly the way tools/osd-transpile.mjs builds it, hidden
 *  layers excluded, so the names are the ones the build is missing and not
 *  artifacts of a different file selection. Heavy: it loads the libraries,
 *  like the transpile it stands in for. */
/** exported for tools/hana-closure.mjs (H5c), which reads the same channel
 *  and classifies more of it; this file reads the two DDIC shapes only.
 *  stubsFile -- where the closure walk's exclusion record lives when the
 *  loop keeps it outside gen/hana-closure (--out); default: the seam's rule. */
/** the file selection of the validation: the same seam the build's
 *  ownConfig applies (H5x-1) -- every file of each excluded object (B4: with
 *  only the .clas.abap kept out, the validation still saw the object through
 *  its XML and the build did not, so a FRIENDS clause naming it failed only
 *  the build). */
export function validationListing(root, config, stack, stubsFile = undefined) {
  return {...config, exclude_filter: [...(config.exclude_filter ?? []), ...excludePatterns(stack.hidden),
    ...excludePatterns(excludedObjectFiles(root, stubsFile))]};
}

export async function validationMessage(root, stubsFile = undefined) {
  const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
  const listing = validationListing(root, config, layers(root, config), stubsFile);
  const loaded = selectedModules(root);
  const {files} = await loadFiles(root, listing, loaded.core);
  const libs = await loadLibs(root, listing);
  const reg = new loaded.core.Registry();
  for (const file of files) reg.addFile(new loaded.core.MemoryFile(file.filename, file.contents));
  for (const lib of libs) reg.addDependency(new loaded.core.MemoryFile(lib.filename, lib.contents));
  orderRegistry(reg, loaded.core, files, libs);
  const settings = {...config.options};
  if (config.write_source_map !== true) settings.ignoreSourceMap = true;
  try {
    new loaded.Transpiler(settings, loaded.plugin).validate(reg);
  } catch (error) {
    return String(error?.message ?? "");
  }
  return "";
}

// ------------------------------------------------------------ the dump ----
// H5a: the dump's tables/*.jsonl as the same mapper's input, pure, so the
// contract is testable without a dump directory in hand.

/** the rows of one DD* JSONL file, shaped the way the live read hands rows
 *  to the mapper: keys folded to lower case (the hana-client folds on the
 *  way out of HANA) and the string values trimmed (its literal trim). A line
 *  that is not JSON is refused with its line number, not skipped. */
export function dumpRows(text) {
  const rows = [];
  for (const [index, line] of String(text ?? "").split("\n").entries()) {
    if (line.trim() === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`hana-ddic-gen: line ${index + 1} of a DD* JSONL is not JSON: ${error.message}`);
    }
    const folded = {};
    for (const [key, value] of Object.entries(row)) {
      folded[key.toLowerCase()] = typeof value === "string" ? value.trim() : value;
    }
    rows.push(folded);
  }
  return rows;
}

/** the dump's DD* tables, active versions only -- the same pin the live
 *  read's WHERE carries (AS4LOCAL 'A', AS4VERS '0000'), so a table dumped
 *  with an inactive version does not yield its fields twice. A DD* file the
 *  dump does not carry is no rows, not an error: DD07L and DD40L arrive
 *  empty on a dump whose package holds none. */
export function readDumpDdic(dir) {
  const tables = join(dir, "tables");
  if (existsSync(join(tables, "DD02L.jsonl")) === false) {
    throw new Error(`hana-ddic-gen: ${dir} holds no tables/DD02L.jsonl -- not a dump of --ddic shape`);
  }
  const read = (name) => {
    const file = join(tables, `${name}.jsonl`);
    return dumpRows(existsSync(file) ? readFileSync(file, "utf8") : "");
  };
  const active = (rows) => rows.filter((row) =>
    String(row.as4local ?? "").toUpperCase() === "A" && String(row.as4vers ?? "").trim() === "0000");
  return {
    dd02l: active(read("DD02L")),
    dd03l: active(read("DD03L")),
    dd04l: active(read("DD04L")),
    dd01l: active(read("DD01L")),
    dd02t: active(read("DD02T")),
    dd04t: active(read("DD04T")),
    dd01t: active(read("DD01T")),
    dd07l: active(read("DD07L")),
    dd40l: active(read("DD40L")),
  };
}

/** what --from-dump writes, as abapGit file name -> XML. The rows go through
 *  the live read's mapper: ddicFieldsWithIncludes for the tables (the dump
 *  carries every DD02L table's DD03L, so an include row goes out as the
 *  marker a system's own export spells and the included fields' expanded
 *  copies are dropped -- H5d), then tablXml / dtelXml / domaXml. An
 *  object's text is its T table's row in the L row's master language, E
 *  when none is named -- the live read's DDLANGUAGE 'E', said per object
 *  instead of per query; the TABL header's DDLANGUAGE carries that language
 *  too, TABCLASS APPEND carries the SQLTAB target its DD02L row names,
 *  POOL and CLUSTER refuse the run, and the summary line says what a VIEW
 *  became and where its reads stand (H5d). options.names -- a Set of
 *  upper-case object names -- writes only those objects, the loop's
 *  per-name fill (H5c round 7). */
export function dumpGeneration(dd, options = {}) {
  const elements = new Map(dd.dd04l.map((row) => [String(row.rollname ?? "").toUpperCase(), row]));
  const domains = new Map(dd.dd01l.map((row) => [String(row.domname ?? "").toUpperCase(), row]));
  const includes = new Map();
  for (const row of dd.dd03l) {
    const table = String(row.tabname ?? "").toUpperCase();
    if (includes.has(table) === false) includes.set(table, []);
    includes.get(table).push(row);
  }
  const trowOf = (rows, key, name, language) => {
    const wanted = (String(language ?? "").trim() || "E").toUpperCase();
    return rows.find((candidate) =>
      String(candidate[key] ?? "").toUpperCase() === String(name).toUpperCase() &&
      String(candidate.ddlanguage ?? "").toUpperCase() === wanted);
  };
  const textOf = (rows, key, name, language) => String(trowOf(rows, key, name, language)?.ddtext ?? "").trim();
  const byName = (rows, key) => [...rows].sort((a, b) =>
    String(a[key] ?? "").localeCompare(String(b[key] ?? "")));
  const files = new Map();
  const counts = {tabl: 0, dtel: 0, doma: 0, view: 0};
  const wanted = (name) => options.names === undefined || options.names.has(name) === true;
  for (const head of byName(dd.dd02l, "tabname")) {
    const name = String(head.tabname ?? "").toUpperCase();
    if (wanted(name) === false) continue;
    files.set(abapGitFileName(name, "tabl"), tablXml({
      name,
      text: textOf(dd.dd02t, "tabname", name, head.masterlang),
      clidep: String(head.clidep ?? "").toUpperCase() === "X",
      tabclass: String(head.tabclass ?? "").trim() || "TRANSP",
      sqltab: String(head.sqltab ?? "").trim(),
      language: head.masterlang,
      fields: ddicFieldsWithIncludes(includes.get(name) ?? [], {elements, domains}, includes),
    }));
    if (String(head.tabclass ?? "").trim().toUpperCase() === "VIEW") counts.view++;
    counts.tabl++;
  }
  for (const row of byName(dd.dd04l, "rollname")) {
    const name = String(row.rollname ?? "").toUpperCase();
    if (wanted(name) === false) continue;
    files.set(abapGitFileName(name, "dtel"), dtelXml({
      name, row,
      trow: trowOf(dd.dd04t, "rollname", name, row.dtelmaster),
      masterLanguage: row.dtelmaster,
    }));
    counts.dtel++;
  }
  for (const row of byName(dd.dd01l, "domname")) {
    const name = String(row.domname ?? "").toUpperCase();
    if (wanted(name) === false) continue;
    files.set(abapGitFileName(name, "doma"), domaXml({
      name, row,
      text: textOf(dd.dd01t, "domname", name, row.dommaster),
      masterLanguage: row.dommaster,
      values: dd.dd07l.filter((value) => String(value.domname ?? "").toUpperCase() === name),
    }));
    counts.doma++;
  }
  return {files, counts, notCovered: {ttyp: dd.dd40l.length}};
}

// the drift of an existing --out against what the dump generation would
// write, one line per difference: a file missing, a content difference, a
// file the plan does not write, or no --out at all (said, not compared)
function driftOf(out, files) {
  if (existsSync(out) === false) {
    return [`${out} does not exist (write it first, without --check)`];
  }
  const drift = [];
  for (const [file, xml] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
    const at = join(out, file);
    if (existsSync(at) === false) drift.push(`${file}: missing`);
    else if (readFileSync(at, "utf8") !== xml) drift.push(`${file}: differs`);
  }
  const wanted = new Set(files.keys());
  for (const entry of readdirSync(out).sort()) {
    if (wanted.has(entry) === false) drift.push(`${entry}: not written by this plan`);
  }
  return drift;
}

function take(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`hana-ddic-gen: ${name} needs a value`);
  args.splice(at, 2);
  return value;
}

function has(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

export async function run(args = process.argv.slice(2)) {
  const out = take(args, "--out") ?? join("gen", "hana-ddic");
  const tables = take(args, "--tables");
  const fromBuild = has(args, "--from-build");
  const dump = take(args, "--from-dump");
  const selectNames = take(args, "--names");
  const check = has(args, "--check");
  if (args.length > 0) throw new Error(`unknown option ${args.find((a) => a.startsWith("--")) ?? args[0]}`);
  if (dump !== undefined && (tables !== undefined || fromBuild === true)) {
    throw new Error("hana-ddic-gen: choose --from-dump or the live read (--tables/--from-build), not both");
  }
  if (selectNames !== undefined && dump === undefined) {
    throw new Error("hana-ddic-gen: --names selects objects of --from-dump; the live read has no --names");
  }
  if (selectNames !== undefined && check === true) {
    throw new Error("hana-ddic-gen: --check compares the whole dump plan; --names writes a subset");
  }
  if (check === true && dump === undefined) {
    throw new Error("hana-ddic-gen: --check compares what --from-dump would write; the live read has no plan to compare against");
  }

  if (dump !== undefined) {
    const names = selectNames === undefined ? undefined
      : new Set(selectNames.split(",").map((n) => n.trim().toUpperCase()).filter(Boolean));
    const {files, counts, notCovered} = dumpGeneration(readDumpDdic(dump), {names});
    if (check === true) {
      const drift = driftOf(out, files);
      if (drift.length > 0) {
        for (const line of drift) console.log(`hana-ddic-gen: ${line}`);
        console.log(`hana-ddic-gen: ${out} has drifted from ${dump}: ${drift.length} difference(s)`);
        return 1;
      }
      console.log(`hana-ddic-gen: ${out} matches ${dump} (${files.size} file(s))`);
      return 0;
    }
    mkdirSync(out, {recursive: true});
    for (const [file, xml] of files) {
      writeFileSync(join(out, file), xml);
    }
    console.log(`hana-ddic-gen: ${dump}: ${counts.tabl} table(s), ${counts.dtel} data element(s), ${counts.doma} domain(s) -> ${out}`);
    // what a view became and where its reads stand, said in the run's
    // summary and not in a POOL refusal's tail (CRITIC-929 SHOULD 4)
    if (counts.view > 0) {
      console.log(`hana-ddic-gen: ${counts.view} view(s) written as read-only structure type(s): outside the HANA existing-schema mode a read of a view fails at SQL time; in the mode the shadow schema names the tenant's SQL view with a synonym`);
    }
    console.log(`hana-ddic-gen: not covered by --from-dump: search helps (SHLP, DD30L-DD33L) and messages (MSAG) are not in --ddic, ${notCovered.ttyp} table type(s) (DD40L) counted here`);
    return 0;
  }

  let names;
  if (fromBuild === true) {
    names = tablesFromValidation(await validationMessage(process.cwd()));
    console.log(`hana-ddic-gen: ${names.length} unresolved table name(s) in the generation`);
  } else {
    names = nameList(tables);
    if (names.length === 0) throw new Error("hana-ddic-gen: --tables A,B,C names what to read, or pass --from-build");
  }

  const db = new HanaDatabaseClient({existingSchema: true});
  await db.connect();
  try {
    const {tables: found, elements, domains, texts} = await readTables(db, names);
    mkdirSync(out, {recursive: true});
    for (const [name, table] of found) {
      const fields = ddicFields(table.rows, {elements, domains});
      // the TABCLASS/SQLTAB the DD02L row carries go through to the shared
      // writer, the dump path's equality (CRITIC-929 SHOULD 1): without
      // them --tables on an append or a view wrote TABCLASS TRANSP with a
      // DD09L, silently
      const xml = tablXml({name, text: texts.get(name) ?? "",
        clidep: String(table.head.clidep ?? "").toUpperCase() === "X",
        tabclass: String(table.head.tabclass ?? "").trim() || "TRANSP",
        sqltab: String(table.head.sqltab ?? "").trim(), fields});
      const file = join(out, abapGitFileName(name, "tabl"));
      writeFileSync(file, xml);
      console.log(`hana-ddic-gen: ${name}: ${fields.length} fields -> ${file}`);
    }
    return 0;
  } finally {
    await db.disconnect();
  }
}

if (runsAs("hana-ddic-gen.mjs")) {
  run().then((code) => process.exit(code)).catch((error) => {
    console.error(`hana-ddic-gen: ${error?.message ?? error}`);
    process.exit(2);
  });
}
