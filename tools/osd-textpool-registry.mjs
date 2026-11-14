#!/usr/bin/env node
// Text pools -> a registry the ABAP reads at run time.
//
// A class or a program carries a text pool: text symbols (ID I), selection
// texts (S), the title (R), list headings (H, T). The transpiler carries
// none of it (READ TEXTPOOL is a "transpiler todo" that throws), and a SEGW
// model provider takes most of its property labels from it:
// set_label_from_text_element( iv_text_element_symbol = '044'
// iv_text_element_container = gc_incl_name ). abapGit serializes the pool
// into the object's XML -- <TPOOL> in the master language (the object's
// LANGU), <I18N_TPOOL> for the translations, one <item> per language with
// <LANGUAGE> and <TEXTPOOL> -- so the pool is read here, at build time, and
// written as a class the ABAP asks (src/gateway/zcl_osd_textpool, which is
// what the model API's set_label_from_text_element resolves through).
//
// Read: *.clas.xml (key: the class name) and *.prog.xml (key: the program
// name) in every input folder, test fixtures included -- a text is data and
// no object of its own, so a fixture's pool cannot break the build the way a
// fixture's CDS view would. The later folder wins a file, as everywhere.
// Not read (yet): function groups' pools and abapGit's LANGU/.po
// translation files.
//
// Output: gen/textpool/zcl_osd_textpool_registry.clas.abap, one pool()
// method, CASE over the program, rows of (language, id, key, entry). A text
// that is not 7-bit ASCII goes in as its UTF-8 hex: ABAP source stays ASCII.
//
//   node tools/osd-textpool-registry.mjs [folder...] [--list]
import {mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {XMLParser} from "fast-xml-parser";
import {inputFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {runsAs} from "./osd-main.mjs";

const OUT = "gen/textpool";

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: false,
  isArray: (name) => name === "item",
});

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir).sort();
  } catch (error) {
    if (out.length === 0 && error?.code === "ENOENT") throw error;
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    if (stat.isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      walk(full, out);
    } else if (/\.(clas|prog)\.xml$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const text = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? "" : String(v));

function rows(items, langu) {
  return (items ?? []).map((i) => ({
    langu,
    id: text(i.ID).trim(),
    key: text(i.KEY).trim(),
    entry: text(i.ENTRY).replace(/\s+$/, ""),
  })).filter((r) => r.id !== "" && r.entry !== "");
}

/** the pool of one abapGit XML file: {program, master, rows} or undefined */
export function parsePool(xml, file = "") {
  if (xml.includes("<TPOOL>") === false && xml.includes("<I18N_TPOOL>") === false) return undefined;
  const doc = parser.parse(xml);
  const values = doc?.abapGit?.["asx:abap"]?.["asx:values"] ?? {};
  let program;
  let master;
  if (/\.clas\.xml$/i.test(file) || values.VSEOCLASS !== undefined) {
    program = text(values.VSEOCLASS?.CLSNAME);
    master = text(values.VSEOCLASS?.LANGU);
  } else {
    program = text(values.PROGDIR?.NAME);
    // abapGit writes no language for a program: the pool is in the
    // master language, E unless the object says otherwise
    master = text(values.PROGDIR?.LANGU);
  }
  if (program === "") {
    program = basename(file).replace(/\.(clas|prog)\.xml$/i, "").replaceAll("#", "/");
  }
  program = program.toUpperCase();
  master = (master || "E").trim().toUpperCase();
  // the program, the language, the id and the key go into the ABAP as
  // literals; one that is not a name is refused (the entry is a text and is
  // written escaped)
  const check = (value, re, what) => {
    if (!re.test(value)) throw new Error(`osd-textpool-registry: ${file}: ${what} ${JSON.stringify(value)} is not one`);
    return value;
  };
  check(program, /^[A-Z0-9_/]{1,40}$/, "program name");
  check(master, /^[A-Z0-9]$/, "language key");
  const out = rows(values.TPOOL?.item, master);
  for (const i18n of values.I18N_TPOOL?.item ?? []) {
    const langu = text(i18n.LANGUAGE).trim().toUpperCase();
    if (langu === "") continue;
    check(langu, /^[A-Z0-9]$/, "language key");
    out.push(...rows(i18n.TEXTPOOL?.item, langu));
  }
  for (const r of out) {
    check(r.id, /^[A-Z]$/, "text pool id");
    check(r.key, /^[A-Za-z0-9_%/-]{0,30}$/, "text pool key");
  }
  return out.length > 0 ? {program, master, rows: out} : undefined;
}

/** every pool below the folders, the later folder winning a file */
export function textPools(folders) {
  const pools = [];
  for (const file of winningByLayer(folders, (folder) => walk(folder), (f) => basename(f).toLowerCase())) {
    const pool = parsePool(readFileSync(file, "utf8"), file);
    if (pool !== undefined) pools.push({...pool, file});
  }
  // codepoint order, never the locale's: the bytes are a generation input
  return pools.sort((a, b) => (a.program < b.program ? -1 : a.program > b.program ? 1 : 0));
}

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);

/** an ABAP expression for the text: a literal, or its UTF-8 bytes in hex,
 *  200 hex digits a line (ABAP lines stay under 255; a text pool entry of
 *  132 characters is at most 792 digits, four chunks) */
export function abapText(s, indent = 0) {
  if (ascii(s)) return `'${s.replaceAll("'", "''")}'`;
  const hex = Buffer.from(s, "utf8").toString("hex").toUpperCase();
  const chunks = hex.match(/.{1,200}/g);
  if (chunks.length > 4) throw new Error(`osd-textpool-registry: text too long for utf8( ): ${s.length} characters`);
  const pad = " ".repeat(indent + "utf8( ".length);
  return `utf8( ${chunks.map((c, i) => `iv_hex${i + 1} = '${c}'`).join("\n" + pad)} )`;
}

/** one call, a parameter a line */
export function abapCall(name, params, indent) {
  const width = Math.max(...params.map(([p]) => p.length));
  const pad = " ".repeat(indent + name.length + 2);
  return `${name}( ${params.map(([p, v], i) => {
    const head = `${p.padEnd(width)} = `;
    return (i === 0 ? "" : pad) + head + v(indent + name.length + 2 + head.length);
  }).join("\n")} )`;
}

export function registryClass(pools) {
  const whens = pools.map((p) => {
    const lines = p.rows.map((r) => `        APPEND ${abapCall("row", [
      ["iv_langu", () => `'${r.langu}'`],
      ["iv_id", () => `'${r.id}'`],
      ["iv_key", (at) => abapText(r.key, at)],
      ["iv_entry", (at) => abapText(r.entry, at)],
    ], 15)} TO rt_pool.`);
    return `      WHEN ${abapText(p.program)}.\n${lines.join("\n")}`;
  });
  const body = whens.length > 0
    ? `    CASE iv_program.\n${whens.join("\n")}\n    ENDCASE.`
    : "    CLEAR rt_pool.";
  return `CLASS zcl_osd_textpool_registry DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/osd-textpool-registry.mjs from the <TPOOL> of the
* class and program XML - do not edit
  PUBLIC SECTION.
    CLASS-METHODS pool
      IMPORTING
        iv_program     TYPE csequence
      RETURNING
        VALUE(rt_pool) TYPE zcl_osd_textpool=>ty_pool.
  PRIVATE SECTION.
    CLASS-METHODS row
      IMPORTING
        iv_langu      TYPE csequence
        iv_id         TYPE csequence
        iv_key        TYPE csequence
        iv_entry      TYPE csequence
      RETURNING
        VALUE(rs_row) TYPE zcl_osd_textpool=>ty_text.
    CLASS-METHODS utf8
      IMPORTING
        iv_hex1        TYPE csequence
        iv_hex2        TYPE csequence OPTIONAL
        iv_hex3        TYPE csequence OPTIONAL
        iv_hex4        TYPE csequence OPTIONAL
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_textpool_registry IMPLEMENTATION.

  METHOD pool.
${body}
  ENDMETHOD.

  METHOD row.
    rs_row-langu = iv_langu.
    rs_row-id    = iv_id.
    rs_row-key   = iv_key.
    rs_row-entry = iv_entry.
  ENDMETHOD.

  METHOD utf8.
    DATA lv_hex TYPE xstring.
    DATA lv_all TYPE string.
    CONCATENATE iv_hex1 iv_hex2 iv_hex3 iv_hex4 INTO lv_all.
    lv_hex = lv_all.
    rv_text = cl_abap_codepage=>convert_from( lv_hex ).
  ENDMETHOD.

ENDCLASS.
`;
}

if (runsAs("osd-textpool-registry.mjs")) {
  const folders = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const root = process.env.OSD_ROOT ?? process.cwd();
  const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
  const pools = textPools(folders.length > 0 ? folders : inputFoldersOf(root, config));
  for (const p of pools) {
    console.log(`osd-textpool-registry: ${p.program}: ${p.rows.length} texts, ${[...new Set(p.rows.map((r) => r.langu))].join("/")}`);
  }
  if (process.argv.includes("--list") === false) {
    mkdirSync(join(root, OUT), {recursive: true});
    writeFileSync(join(root, OUT, "zcl_osd_textpool_registry.clas.abap"), registryClass(pools));
  }
}
