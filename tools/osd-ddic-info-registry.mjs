#!/usr/bin/env node
// Dictionary field information -> a registry the ABAP reads at run time.
//
// A Gateway model that binds an entity type to a dictionary structure
// (bind_structure( '<structure>' )) gets more from the dictionary than the
// ABAP types: the field label of each component's data element (the
// medium one becomes sap:label where the model set none), the reference
// field of an amount or a quantity (sap:unit, the property bound to it) and
// the kind of the data type (a currency key is sap:semantics
// "currency-code", a unit "unit-of-measure"). RTTI in open-abap-core
// carries none of it -- no labels, no reference fields -- so it is read
// here, at build time, from the objects abapGit serialized:
//
//   *.tabl.xml   DD03P per component: FIELDNAME, ROLLNAME, DATATYPE (for a
//                built-in type), REFTABLE/REFFIELD; an .INCLUDE row
//                (PRECFIELD) is replaced by the included structure's fields
//   *.dtel.xml   DD04V: DATATYPE (or DOMNAME), SCRTEXT_S/M/L, REPTEXT in the
//                master language (DDLANGUAGE); DD04_TEXTS for translations
//   *.doma.xml   DD01V: DATATYPE, for a data element typed by its domain
//
// and written as gen/ddicinfo/zcl_osd_ddic_info_registry.clas.abap: fields()
// per structure, labels() per data element, datatype() for the data
// elements whose type the model reads (amount, quantity, currency key,
// unit, date). src/gateway/zcl_osd_ddic_info is the accessor the model
// API's bind_structure asks (src/gateway/compat). Input folders are read
// with the test fixtures, as tools/osd-textpool-registry.mjs does; the later
// folder wins a file.
//
//   node tools/osd-ddic-info-registry.mjs [folder...] [--list]
import {mkdirSync, readFileSync, readdirSync, statSync, writeFileSync} from "node:fs";
import {basename, join} from "node:path";
import {XMLParser} from "fast-xml-parser";
import {inputFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {runsAs} from "./osd-main.mjs";
import {abapCall, abapText} from "./osd-textpool-registry.mjs";
import {classNameOf} from "./cds-names.mjs";

const OUT = "gen/ddicinfo";
const MEANINGFUL = ["CURR", "QUAN", "CUKY", "UNIT", "DATS"];

const parser = new XMLParser({
  ignoreAttributes: true,
  parseTagValue: false,
  trimValues: true,
  isArray: (name) => ["DD03P", "DD27P", "item", "DD04_TEXTS"].includes(name),
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
    } else if (/\.(tabl|view|dtel|doma)\.xml$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

const text = (v) => (v === undefined || v === null || typeof v === "object" ? "" : String(v).trim());
const valuesOf = (xml) => parser.parse(xml)?.abapGit?.["asx:abap"]?.["asx:values"] ?? {};

/** one structure or table: {name, fields: [{fieldname, rollname, datatype, reftable, reffield, include}]} */
export function parseTabl(xml) {
  const v = valuesOf(xml);
  const name = text(v.DD02V?.TABNAME).toUpperCase();
  const rows = v.DD03P_TABLE?.DD03P ?? [];
  const fields = rows.map((r) => {
    const fieldname = text(r.FIELDNAME).toUpperCase();
    if (fieldname.startsWith(".INCLU")) {
      return {include: text(r.PRECFIELD).toUpperCase()};
    }
    return {
      fieldname,
      rollname: text(r.COMPTYPE) === "E" || text(r.COMPTYPE) === "" ? text(r.ROLLNAME).toUpperCase() : "",
      datatype: text(r.DATATYPE).toUpperCase(),
      reftable: text(r.REFTABLE).toUpperCase(),
      reffield: text(r.REFFIELD).toUpperCase(),
    };
  }).filter((f) => f.include !== undefined ? f.include !== "" : f.fieldname !== "" && f.fieldname.startsWith(".") === false);
  return {name, fields};
}

/** one data element: {name, datatype, domname, labels: [{langu, short, medium, long, heading}]} */
export function parseDtel(xml) {
  const v = valuesOf(xml);
  const d = v.DD04V ?? {};
  const master = text(d.DDLANGUAGE).toUpperCase() || "E";
  const label = (src, langu) => ({
    langu,
    short: text(src.SCRTEXT_S), medium: text(src.SCRTEXT_M), long: text(src.SCRTEXT_L), heading: text(src.REPTEXT),
  });
  const labels = [label(d, master)];
  for (const t of v.DD04_TEXTS?.[0]?.item ?? v.DD04_TEXTS?.item ?? []) {
    const langu = text(t.DDLANGUAGE).toUpperCase();
    if (langu !== "" && langu !== master) labels.push(label(t, langu));
  }
  return {
    name: text(d.ROLLNAME).toUpperCase(),
    datatype: text(d.DATATYPE).toUpperCase(),
    domname: text(d.DOMNAME).toUpperCase(),
    labels: labels.filter((l) => l.short || l.medium || l.long || l.heading),
  };
}

/** a database view (cds2ddic writes one per CDS view): {name, view: [{fieldname, tabname, tabfield}]} */
export function parseView(xml) {
  const v = valuesOf(xml);
  const rows = v.DD27P_TABLE?.DD27P ?? [];
  return {
    name: text(v.DD25V?.VIEWNAME).toUpperCase(),
    view: (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      fieldname: text(r.VIEWFIELD).toUpperCase(), tabname: text(r.TABNAME).toUpperCase(), tabfield: text(r.FIELDNAME).toUpperCase(),
    })).filter((f) => f.fieldname !== "" && f.tabname !== ""),
  };
}

export function parseDoma(xml) {
  const d = valuesOf(xml).DD01V ?? {};
  return {name: text(d.DOMNAME).toUpperCase(), datatype: text(d.DATATYPE).toUpperCase()};
}

/** the dictionary below the folders: {structures, elements} */
export function ddicInfo(folders) {
  const tabls = new Map();
  const dtels = new Map();
  const domas = new Map();
  for (const file of winningByLayer(folders, (folder) => walk(folder), (f) => basename(f).toLowerCase())) {
    const xml = readFileSync(file, "utf8");
    if (/\.tabl\.xml$/i.test(file)) {
      const t = parseTabl(xml);
      if (t.name) tabls.set(t.name, t);
    } else if (/\.view\.xml$/i.test(file)) {
      const t = parseView(xml);
      if (t.name) tabls.set(t.name, t);
    } else if (/\.dtel\.xml$/i.test(file)) {
      const d = parseDtel(xml);
      if (d.name) dtels.set(d.name, d);
    } else {
      const d = parseDoma(xml);
      if (d.name) domas.set(d.name, d);
    }
  }
  const flat = (name, seen = new Set()) => {
    const t = tabls.get(name);
    if (t === undefined || seen.has(name)) return [];
    seen.add(name);
    if (t.view !== undefined) {
      // a view field is its base table's field under the view's name; a
      // reference field becomes the view field over the base's reference
      // field (none when the view does not select it)
      const bases = new Map();
      const baseOf = (tab) => {
        if (!bases.has(tab)) bases.set(tab, flat(tab, new Set(seen)));
        return bases.get(tab);
      };
      return t.view.map((v) => {
        const base = baseOf(v.tabname).find((f) => f.fieldname === v.tabfield);
        if (base === undefined) return {fieldname: v.fieldname, rollname: "", datatype: "", reftable: "", reffield: ""};
        const ref = base.reffield === "" ? undefined
          : t.view.find((w) => w.tabname === v.tabname && w.tabfield === base.reffield);
        return {fieldname: v.fieldname, rollname: base.rollname, datatype: base.datatype,
          reftable: ref ? name : "", reffield: ref ? ref.fieldname : ""};
      });
    }
    return t.fields.flatMap((f) => (f.include !== undefined ? flat(f.include, seen) : [f]));
  };
  const typeOf = (f) => {
    if (f.datatype) return f.datatype;
    const d = dtels.get(f.rollname);
    if (d === undefined) return "";
    return d.datatype || domas.get(d.domname)?.datatype || "";
  };
  const structures = [...tabls.keys()].sort().map((name) => ({
    name,
    fields: flat(name).map((f) => ({...f, datatype: typeOf(f)})),
  })).filter((s) => s.fields.some((f) => f.rollname || f.reffield));
  // every data element with a label, not only those a structure here uses:
  // a model may bind a type of its own class whose components are typed by
  // data elements (a SEGW value-help type), which RTTI names at run time
  const elements = [...dtels.keys()].sort().map((name) => dtels.get(name)).filter((d) => d.labels.length > 0);
  // and the dictionary type of the data elements whose type means something
  // to the model (sap:unit, sap:semantics, a date)
  const types = [...dtels.keys()].sort()
    .map((name) => ({name, datatype: typeOf({rollname: name})}))
    .filter((t) => MEANINGFUL.includes(t.datatype));
  return {structures, elements, types};
}

/** The dates of the dictionary below the folders, as segw-gen asks for them:
 *  (structure, field) -> is the component DATS. A model of this tree shows a
 *  date as a date by an explicit sap:display-format annotation (a system
 *  derives none from the dictionary, milestone 3 B4), for an inline `type:
 *  date` property and for a component of a bound dictionary structure. */
export function dictionaryDates(folders) {
  const dates = new Set();
  const aliases = new Map();
  for (const s of ddicInfo(folders).structures) {
    for (const f of s.fields) if (f.datatype === "DATS") dates.add(`${s.name}-${f.fieldname}`);
    // a published CDS view's model binds the row type of its source class
    // (tools/cds2ddic.mjs: ty_row includes the SQL view), named this way
    aliases.set(`${classNameOf("ZCL_STG_CDS_", s.name)}=>TY_ROW`, s.name);
  }
  return (structure, field) => {
    const name = String(structure).toUpperCase();
    return dates.has(`${aliases.get(name) ?? name}-${String(field).toUpperCase()}`);
  };
}

export function registryClass({structures, elements, types = []}) {
  const fieldWhens = structures.map((s) => {
    const lines = s.fields.map((f) => `        APPEND ${abapCall("field", [
      ["iv_fieldname", (at) => abapText(f.fieldname, at)],
      ["iv_rollname", (at) => abapText(f.rollname, at)],
      ["iv_datatype", () => `'${f.datatype}'`],
      ["iv_reftable", (at) => abapText(f.reftable, at)],
      ["iv_reffield", (at) => abapText(f.reffield, at)],
    ], 15)} TO rt_fields.`);
    return `      WHEN ${abapText(s.name)}.\n${lines.join("\n")}`;
  });
  const labelWhens = elements.map((d) => {
    const lines = d.labels.map((l) => `        APPEND ${abapCall("label", [
      ["iv_langu", () => `'${l.langu}'`],
      ["iv_short", (at) => abapText(l.short, at)],
      ["iv_medium", (at) => abapText(l.medium, at)],
      ["iv_long", (at) => abapText(l.long, at)],
      ["iv_heading", (at) => abapText(l.heading, at)],
    ], 15)} TO rt_labels.`);
    return `      WHEN ${abapText(d.name)}.\n${lines.join("\n")}`;
  });
  const typeWhens = types.map((t) => `      WHEN ${abapText(t.name)}.\n        rv_datatype = '${t.datatype}'.`);
  const cased = (whens, target) => (whens.length > 0 ? `    CASE iv_name.\n${whens.join("\n")}\n    ENDCASE.` : `    CLEAR ${target}.`);
  return `CLASS zcl_osd_ddic_info_registry DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/osd-ddic-info-registry.mjs from the TABL, DTEL and DOMA
* objects - do not edit
  PUBLIC SECTION.
    CLASS-METHODS fields
      IMPORTING
        iv_name          TYPE csequence
      RETURNING
        VALUE(rt_fields) TYPE zcl_osd_ddic_info=>ty_fields.
    CLASS-METHODS labels
      IMPORTING
        iv_name          TYPE csequence
      RETURNING
        VALUE(rt_labels) TYPE zcl_osd_ddic_info=>ty_labels.
* the dictionary type of a data element, only CURR, QUAN, CUKY, UNIT, DATS
    CLASS-METHODS datatype
      IMPORTING
        iv_name            TYPE csequence
      RETURNING
        VALUE(rv_datatype) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS field
      IMPORTING
        iv_fieldname    TYPE csequence
        iv_rollname     TYPE csequence
        iv_datatype     TYPE csequence
        iv_reftable     TYPE csequence
        iv_reffield     TYPE csequence
      RETURNING
        VALUE(rs_field) TYPE zcl_osd_ddic_info=>ty_field.
    CLASS-METHODS label
      IMPORTING
        iv_langu        TYPE csequence
        iv_short        TYPE csequence
        iv_medium       TYPE csequence
        iv_long         TYPE csequence
        iv_heading      TYPE csequence
      RETURNING
        VALUE(rs_label) TYPE zcl_osd_ddic_info=>ty_label.
    CLASS-METHODS utf8
      IMPORTING
        iv_hex1        TYPE csequence
        iv_hex2        TYPE csequence OPTIONAL
        iv_hex3        TYPE csequence OPTIONAL
        iv_hex4        TYPE csequence OPTIONAL
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_ddic_info_registry IMPLEMENTATION.

  METHOD fields.
${cased(fieldWhens, "rt_fields")}
  ENDMETHOD.

  METHOD labels.
${cased(labelWhens, "rt_labels")}
  ENDMETHOD.

  METHOD datatype.
${cased(typeWhens, "rv_datatype")}
  ENDMETHOD.

  METHOD field.
    rs_field-fieldname = iv_fieldname.
    rs_field-rollname  = iv_rollname.
    rs_field-datatype  = iv_datatype.
    rs_field-reftable  = iv_reftable.
    rs_field-reffield  = iv_reffield.
  ENDMETHOD.

  METHOD label.
    rs_label-langu   = iv_langu.
    rs_label-short   = iv_short.
    rs_label-medium  = iv_medium.
    rs_label-long    = iv_long.
    rs_label-heading = iv_heading.
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

if (runsAs("osd-ddic-info-registry.mjs")) {
  const folders = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const root = process.env.OSD_ROOT ?? process.cwd();
  const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
  const info = ddicInfo(folders.length > 0 ? folders : inputFoldersOf(root, config));
  console.log(`osd-ddic-info-registry: ${info.structures.length} structures, ${info.elements.length} data elements with labels, ${info.types.length} typed`);
  if (process.argv.includes("--list")) {
    for (const s of info.structures) console.log(`osd-ddic-info-registry: ${s.name}: ${s.fields.length} fields`);
  } else {
    mkdirSync(join(root, OUT), {recursive: true});
    writeFileSync(join(root, OUT, "zcl_osd_ddic_info_registry.clas.abap"), registryClass(info));
  }
}
