#!/usr/bin/env node
// Read the DDIC of a schema an SAP system already holds, and write what this
// tree writes by hand: one abapGit *.tabl.xml per table (H1, the first
// measuring tool of the existing-schema mode).
//
//   node tools/hana-ddic-probe.mjs --tables DD02L-able,ZOSD_H1_A [--out <dir>] [--diff] [--mandt]
//
//   --tables A,B,C   the tables to read (DD02L, DD03L, DD04L, DD01L, DD02T)
//   --out <dir>      write <table>.tabl.xml there; without it, print the XML
//   --diff           compare with src/**/<table>.tabl.xml when present:
//                    field order, type, length, decimals, key flag, a
//                    CURR/QUAN field's reference (REFTABLE/REFFIELD) and
//                    PRECFIELD; exit 1 on any difference
//   --mandt          say which of the tables have MANDT as the first key
//                    field
//
// Everything is read through tools/hana-client.mjs -- the connection
// HANA_HOST/PORT/USER/PASSWORD/SCHEMA configure for the runtime, the same
// identifier folding and literal trim -- and the client is constructed in
// the existing-schema mode, so the probe cannot DDL and, without
// OSD_HANA_WRITE=1, cannot write at all: it is a reader. The DD03L -> shape
// mapping is tools/hana-ddic-map.mjs, pure, testable without a database.
import {mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {runsAs} from "./osd-main.mjs";
import {HanaDatabaseClient} from "./hana-client.mjs";
import {ddicFields, mandtFirstKey, tablXml} from "./hana-ddic-map.mjs";

// names go into single-quoted literals; anything that is not a name this
// tool would send is refused before it becomes SQL. Exported for
// tools/hana-ddic-gen.mjs (H3): the same refusal for its --tables list.
export const nameList = (value) => (value ?? "").split(",").map((s) => s.trim()).filter((s) => s !== "")
  .map((s) => {
    const name = s.toUpperCase();
    if (/^[A-Z0-9_/#$]+$/.test(name) === false) {
      throw new Error(`${s} is not a table name this tool will send to the database`);
    }
    return name;
  });

const quoted = (names) => names.map((n) => `'${n}'`).join(",");

/** DD02L headers, DD03L fields, and the DD04L/DD01L rows the fields' data
 *  elements resolve through, in as many reads as there are DD* tables, not
 *  as many as there are fields. The column lists are measured, not guessed
 *  -- SYS.TABLE_COLUMNS of a real schema, pinned as the fixture of
 *  test/hana-ddic-probe.mjs, whose fake driver refuses a statement naming a
 *  column the list does not carry (the first run against a real system died
 *  on DD04L's INTTYPE, which lives on DD03L only). Every read is pinned to
 *  the active version -- AS4LOCAL 'A', AS4VERS '0000' -- or a table with an
 *  inactive version would yield its fields twice. Exported for
 *  tools/hana-ddic-gen.mjs (H3), which maps the same rows a second way never:
 *  the probe reads, the map shapes. */
export async function readTables(db, names) {
  const tables = new Map();
  for (const name of names) {
    const head = await db.query(`SELECT TABNAME, TABCLASS, SQLTAB, CLIDEP FROM DD02L WHERE TABNAME = '${name}' AND AS4LOCAL = 'A' AND AS4VERS = '0000'`);
    if (head.length === 0) {
      console.log(`hana-ddic-probe: ${name}: not in DD02L (no active version); skipped`);
      continue;
    }
    const rows = await db.query(`SELECT POSITION, FIELDNAME, KEYFLAG, ROLLNAME, DATATYPE, LENG, DECIMALS, INTTYPE, INTLEN, REFTABLE, PRECFIELD, REFFIELD, NOTNULL FROM DD03L WHERE TABNAME = '${name}' AND AS4LOCAL = 'A' AND AS4VERS = '0000' ORDER BY POSITION`);
    tables.set(name, {head: head[0], rows});
  }
  const elements = new Map();
  const rollnames = [...new Set([...tables.values()].flatMap((t) =>
    t.rows.map((r) => String(r.rollname ?? "").toUpperCase())).filter((r) => r !== ""))];
  if (rollnames.length > 0) {
    for (const row of await db.query(`SELECT ROLLNAME, DOMNAME, DATATYPE, LENG, DECIMALS FROM DD04L WHERE ROLLNAME IN (${quoted(rollnames)}) AND AS4LOCAL = 'A' AND AS4VERS = '0000'`)) {
      elements.set(String(row.rollname).toUpperCase(), row);
    }
  }
  const domains = new Map();
  const domnames = [...new Set([...elements.values()].map((r) =>
    String(r.domname ?? "").toUpperCase()).filter((d) => d !== ""))];
  if (domnames.length > 0) {
    for (const row of await db.query(`SELECT DOMNAME, DATATYPE, LENG, DECIMALS FROM DD01L WHERE DOMNAME IN (${quoted(domnames)}) AND AS4LOCAL = 'A' AND AS4VERS = '0000'`)) {
      domains.set(String(row.domname).toUpperCase(), row);
    }
  }
  // the text the tree writes into DD02V; English, as DDLANGUAGE 'E'
  const texts = new Map();
  for (const row of await db.query(`SELECT TABNAME, DDTEXT FROM DD02T WHERE TABNAME IN (${quoted(names)}) AND AS4LOCAL = 'A' AND AS4VERS = '0000' AND DDLANGUAGE = 'E'`)) {
    texts.set(String(row.tabname).toUpperCase(), String(row.ddtext ?? ""));
  }
  return {tables, elements, domains, texts};
}

// ---------------------------------------------------------------- diff ----

const tagOf = (block, name) => new RegExp(`<${name}>([^<]*)</${name}>`, "i").exec(block)?.[1] ?? "";

// every tabl.xml and dtel.xml under src/, by lower-case file name; the walk
// is the shallow sorted one tools/osd-ddic-reserved.mjs and osd-packs use
function srcDdicFiles(root) {
  const files = new Map();
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, {withFileTypes: true}); } catch { return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:tabl|dtel)\.xml$/i.test(entry.name)) files.set(entry.name.toLowerCase(), path);
    }
  };
  walk(join(root, "src"));
  return files;
}

// the fields of a src/**/<table>.tabl.xml, as the diff compares them: order,
// type, length, decimals, key flag. A field typed only by its data element
// resolves one hop, through the dtel file beside it when that file names a
// type itself; a type that would need the domain hop is reported as not
// compared rather than guessed.
function fileFields(xml, files) {
  const fields = [];
  for (const match of xml.matchAll(/<DD03P>([\s\S]*?)<\/DD03P>/g)) {
    const block = match[1];
    const field = {
      fieldname: tagOf(block, "FIELDNAME").toUpperCase(),
      key: tagOf(block, "KEYFLAG") === "X",
      datatype: tagOf(block, "DATATYPE").toUpperCase(),
      leng: tagOf(block, "LENG"),
      decimals: tagOf(block, "DECIMALS"),
      reftable: tagOf(block, "REFTABLE").toUpperCase(),
      precfield: tagOf(block, "PRECFIELD").toUpperCase(),
      reffield: tagOf(block, "REFFIELD").toUpperCase(),
      unresolved: "",
    };
    if (field.fieldname === "" || field.fieldname.startsWith(".")) continue;
    if (field.datatype === "") {
      const element = tagOf(block, "ROLLNAME").toUpperCase();
      const dtelXml = element === "" ? undefined :
        (files.has(`${element.toLowerCase()}.dtel.xml`) ? readFileSync(files.get(`${element.toLowerCase()}.dtel.xml`), "utf8") : undefined);
      const datatype = dtelXml === undefined ? "" : tagOf(dtelXml, "DATATYPE").toUpperCase();
      if (datatype === "") {
        field.unresolved = element === "" ? "no type and no data element named" : `typed by ${element}, whose dtel.xml is not under src/ or names no type`;
      } else {
        field.datatype = datatype;
        field.leng = tagOf(dtelXml, "LENG");
        field.decimals = tagOf(dtelXml, "DECIMALS");
      }
    }
    fields.push(field);
  }
  return fields;
}

// the differences of one table, said out loud; the count is the caller's
// exit code, so a probe that finds drift says so without reading the scroll
function reportDiff(name, mapped, files, say) {
  const path = files.get(`${name.toLowerCase()}.tabl.xml`);
  if (path === undefined) {
    say(`hana-ddic-probe: ${name}: no src/**/*.tabl.xml, nothing to diff`);
    return 0;
  }
  const file = fileFields(readFileSync(path, "utf8"), files);
  const probed = mapped.fields.map((f) => ({
    fieldname: f.fieldname,
    key: f.key === true,
    datatype: f.datatype,
    leng: f.leng,
    decimals: f.decimals ?? "",
    reftable: f.reftable ?? "",
    precfield: f.precfield ?? "",
    reffield: f.reffield ?? "",
  }));
  let differences = 0;
  const say1 = (text) => { say(`hana-ddic-probe: ${name}: ${text}`); differences += 1; };
  if (file.length !== probed.length) {
    say1(`field count differs: the file has ${file.length}, DDIC has ${probed.length}`);
  }
  const byName = new Map(file.map((f) => [f.fieldname, f]));
  for (let i = 0; i < Math.min(file.length, probed.length); i++) {
    if (file[i].fieldname !== probed[i].fieldname) {
      say1(`field order differs at position ${i + 1}: the file has ${file[i].fieldname}, DDIC has ${probed[i].fieldname}`);
    }
  }
  for (const one of probed) {
    const other = byName.get(one.fieldname);
    if (other === undefined) {
      say1(`${one.fieldname} is in DDIC, not in the file`);
      continue;
    }
    if (other.unresolved !== "") {
      say(`${one.fieldname}: ${other.unresolved}; not compared`);
      continue;
    }
    for (const [what, a, b] of [
      ["type", other.datatype, one.datatype],
      ["length", other.leng.replace(/^0+(?=\d)/, ""), one.leng.replace(/^0+(?=\d)/, "")],
      ["decimals", other.decimals.replace(/^0+(?=\d)/, "") || "0", one.decimals.replace(/^0+(?=\d)/, "") || "0"],
      ["key flag", other.key ? "X" : "", one.key ? "X" : ""],
      ["reference table", other.reftable, one.reftable],
      ["reference field", other.reffield, one.reffield],
      ["preceding field", other.precfield, one.precfield],
    ]) {
      if (a !== b) say1(`${one.fieldname}: ${what}: the file says ${a === "" ? "(none)" : a}, DDIC says ${b === "" ? "(none)" : b}`);
    }
  }
  if (differences === 0) say(`hana-ddic-probe: ${name}: matches ${path}`);
  return differences;
}

function take(args, name) {
  const at = args.indexOf(name);
  if (at < 0) return undefined;
  const value = args[at + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`hana-ddic-probe: ${name} needs a value`);
  args.splice(at, 2);
  return value;
}

// a flag with no value, consumed so the unknown-option check below sees
// only what is left
function has(args, flag) {
  const at = args.indexOf(flag);
  if (at < 0) return false;
  args.splice(at, 1);
  return true;
}

export async function run(args = process.argv.slice(2)) {
  const out = take(args, "--out");
  const diff = has(args, "--diff");
  const mandt = has(args, "--mandt");
  const names = nameList(take(args, "--tables"));
  if (names.length === 0) throw new Error("--tables A,B,C names what to read");
  const rest = args.filter((a) => a.startsWith("--"));
  if (rest.length > 0) throw new Error(`unknown option ${rest[0]}`);

  const db = new HanaDatabaseClient({existingSchema: true});
  await db.connect();
  try {
    const {tables, elements, domains, texts} = await readTables(db, names);
    const mapped = new Map();
    for (const [name, t] of tables) {
      mapped.set(name, {
        name,
        text: texts.get(name) ?? "",
        clidep: String(t.head.clidep ?? "").toUpperCase() === "X",
        // TABCLASS/SQLTAB through to the shared writer, the dump path's
        // equality (CRITIC-929 SHOULD 1): without them --tables on an
        // append or a view wrote TABCLASS TRANSP with a DD09L, silently
        tabclass: String(t.head.tabclass ?? "").trim() || "TRANSP",
        sqltab: String(t.head.sqltab ?? "").trim(),
        fields: ddicFields(t.rows, {elements, domains}),
      });
    }
    if (mandt) {
      for (const name of names) {
        const m = mapped.get(name);
        if (m !== undefined) {
          console.log(`hana-ddic-probe: ${name}: MANDT as the first key field: ${mandtFirstKey(m.fields) ? "yes" : "no"}`);
        }
      }
    }
    const files = diff ? srcDdicFiles(process.cwd()) : undefined;
    let differences = 0;
    for (const [name, m] of mapped) {
      // where INTTYPE/INTLEN came from, said out loud: the descriptor names
      // the half of the pair it had to derive because DD03L left it blank
      for (const f of m.fields) {
        const derived = [
          ...(f.inttypeFrom === "derived" ? ["INTTYPE derived from DATATYPE"] : []),
          ...(f.intlenFrom === "derived" ? ["INTLEN derived from the type rules"] : []),
        ].join(", ");
        if (derived !== "") console.log(`hana-ddic-probe: ${name}: ${f.fieldname}: ${derived} (DD03L blank)`);
      }
      const xml = tablXml(m);
      if (out !== undefined) {
        mkdirSync(out, {recursive: true});
        const file = join(out, `${name.toLowerCase()}.tabl.xml`);
        writeFileSync(file, xml);
        console.log(`hana-ddic-probe: ${name}: ${m.fields.length} fields -> ${file}`);
      } else {
        console.log(xml);
      }
      if (diff) differences += reportDiff(name, m, files, console.log);
    }
    return diff && differences > 0 ? 1 : 0;
  } finally {
    await db.disconnect();
  }
}

if (runsAs("hana-ddic-probe.mjs")) {
  run().then((code) => process.exit(code)).catch((error) => {
    console.error(`hana-ddic-probe: ${error?.message ?? error}`);
    process.exit(2);
  });
}
