// R11 (docs/rap-runtime.md, "R11"): the two CDS constructs of the flight's
// carrier singleton that no SQL view of this runtime can carry, for
// tools/cds2ddic.mjs and tools/rap/bdef-gen.mjs.
//
//   literalElement(el, ...)      `1 as CarrierSingletonID`: a constant element
//   singletonOf(select, ...)     the singleton root: `select from L left outer
//                                join T as t on 0 = 0 { key 1 as Id,
//                                max( t.c ) as M } where L.Language =
//                                $session.system_language` -- one row
//   computedSourceClass(e)       the ZIF_STG_CDS_SOURCE of such a root
//   constantsOf(e)               the constants of a view, for the classes
//   structureXml(e)              the root's type: on a system a CDS entity is
//                                a type; without a SQL view it is a structure
//
// A constant element has no column: the generated DDIC view leaves it out,
// the classes that read the view fill it after the read, and a condition on
// it is decided before the SELECT (ZCL_STG_CDS_CONST): equal, it is dropped;
// different, there is no row. A singleton root has no SQL view at all: its
// source class computes its one row from the aggregates over the joined
// table. Depends on tools/cds-names.mjs only.
import {classNameOf} from "./cds-names.mjs";

const AGGREGATES = new Set(["MAX", "MIN", "SUM", "COUNT"]);

/** the type of a literal as a CDS element on a system: an integer is the
 *  smallest integer type that holds it (the flight's draft tables say INT1
 *  for `1`), a string is CHAR of its length */
export function literalType(text) {
  const raw = String(text).trim();
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (n <= 255) return {value: String(n), abap: "int1", edm: {edm: "Edm.Byte", maxlength: 0}};
    if (n <= 32767) return {value: String(n), abap: "int2", edm: {edm: "Edm.Int16", maxlength: 0}};
    return {value: String(n), abap: "int4", edm: {edm: "Edm.Int32", maxlength: 0}};
  }
  const s = /^'((?:[^']|'')*)'$/.exec(raw);
  if (s) {
    const value = s[1].replaceAll("''", "'");
    return {value, abap: `c LENGTH ${Math.max(value.length, 1)}`, edm: {edm: "Edm.String", maxlength: Math.max(value.length, 1)}};
  }
  return undefined;
}

/** a CDSElement that is a literal (`key 1 as X`, `'A' as Y`), else undefined.
 *  The field is calculated (no column), its value the literal's */
export function literalElement(el, {children, nodeName, tokensOf, annos, isKey}) {
  const lit = children(el).find((c) => ["CDSInteger", "CDSString"].includes(nodeName(c)));
  if (!lit) return undefined;
  const as = children(el).find((c) => nodeName(c) === "CDSAs");
  const alias = as ? tokensOf(children(as).find((c) => nodeName(c) === "CDSName")) : undefined;
  if (!alias) return {skip: `the literal ${tokensOf(lit)} has no alias`};
  const t = literalType(tokensOf(lit));
  if (!t) return {skip: `${alias}: a literal of no type this generator reads (${tokensOf(lit)})`};
  const name = alias.toUpperCase();
  const label = annos.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean);
  return {field: {name, element: alias, base: "", key: isKey, ...t.edm, abapType: t.abap, typeABAP: t.abap,
    virtual: true, constant: t.value, calculatedBy: "", label: label ?? name, annotations: annos}};
}

/** the constant elements of a parsed view */
export const constantsOf = (e) => (e.fields ?? []).filter((f) => f.constant !== undefined);

/** R11: the singleton root's shape, or undefined when the select is not it
 *  (then the caller's refusal of joins stands). The left source is read as
 *  its one row for the logon language: on a system I_Language has a row for
 *  every logon language, which is what makes the root exactly one instance */
export function singletonOf(select, {find, children, nodeName, tokensOf, firstDirect, reg, name}) {
  const joins = find(select, "CDSJoin");
  if (joins.length !== 1) return undefined;
  const join = joins[0];
  const words = children(join).filter((c) => nodeName(c) === "Identifier").map((c) => tokensOf(c).toUpperCase()).join(" ");
  const cond = tokensOf(firstDirect(join, "CDSCondition") ?? join).replace(/\s+/g, "");
  const always = /^(\d+)=(\d+)$/.exec(cond);
  if (!/^LEFT OUTER JOIN( ON)?$/.test(words) || !always || always[1] !== always[2]) return undefined;
  const source = firstDirect(join, "CDSSource");
  const table = tokensOf(firstDirect(source, "CDSPrefixedName") ?? source).replace(/\s+/g, "").toUpperCase();
  const as = firstDirect(source, "CDSAs");
  const alias = (as ? tokensOf(firstDirect(as, "CDSName")) : table).replace(/\s+/g, "").toUpperCase();
  const tabl = reg.getObject("TABL", table);
  if (!tabl) return {name, skip: `the singleton root joins ${table}, which is not a table of this tree`};
  const where = find(select, "CDSWhere")[0];
  if (where && !/^\w+\.\w+=\$session\.system_language$/i.test(tokensOf(firstDirect(where, "CDSCondition") ?? where).replace(/\s+/g, ""))) {
    return {name, skip: "a singleton root whose WHERE is not `<source>.Language = $session.system_language`"};
  }
  if (find(select, "CDSGroupBy").length) return {name, skip: "a singleton root with GROUP BY (more than one row)"};
  const comps = new Map((tabl.parseType(reg)?.getComponents?.() ?? []).map((c) => [c.name.toUpperCase(), c.type]));
  const aggregates = [];
  for (const el of find(select, "CDSElement")) {
    const agg = firstDirect(el, "CDSAggregate");
    if (!agg) continue;
    const ids = children(agg).filter((c) => nodeName(c) === "Identifier").map((c) => tokensOf(c).toUpperCase());
    const fn = ids[0];
    const arg = tokensOf(firstDirect(agg, "CDSPrefixedName") ?? agg).replace(/\s+/g, "").toUpperCase().split(".");
    const asEl = firstDirect(el, "CDSAs");
    const elName = asEl ? tokensOf(firstDirect(asEl, "CDSName")).toUpperCase() : undefined;
    if (!AGGREGATES.has(fn) || !elName) return {name, skip: `${tokensOf(el)}: an aggregate this generator does not compute`};
    if (arg.length !== 2 || arg[0] !== alias) return {name, skip: `${elName}: an aggregate over something other than a column of ${table}`};
    const column = arg[1];
    if (fn !== "COUNT" && !comps.has(column)) return {name, skip: `${elName}: ${table} has no column ${column}`};
    // the column's DDIC field: the structure type of the root (below) has
    // the column's type, as the CDS element has on a system
    const dd03p = fn === "COUNT" ? undefined : tabl.getFields?.().find((f) => String(f.FIELDNAME).toUpperCase() === column);
    aggregates.push({name: elName, fn, column, dd03p});
  }
  if (!aggregates.length) return undefined;
  return {table, alias, aggregates};
}

/** R11: the source class of a singleton root (or a projection of one): no
 *  SQL view, one row computed per read -- the constants, and each aggregate
 *  over the joined table with one Open SQL statement */
export function computedSourceClass(e) {
  const cls = classNameOf("zcl_stg_cds_", e.sqlView).toLowerCase();
  const table = e.computed.table.toLowerCase();
  const typeOf = (f) => (f.constant !== undefined ? f.abapType
    : f.aggregate?.fn === "COUNT" ? "i" : `${table}-${f.aggregate.column.toLowerCase()}`);
  const real = e.fields.filter((f) => f.constant !== undefined || f.aggregate);
  const other = e.fields.filter((f) => !real.includes(f));
  const rows = real.map((f) => `             ${f.name.toLowerCase()} TYPE ${typeOf(f)},`)
    .concat(other.map((f) => `             ${f.name.toLowerCase()} TYPE ${f.abapType},`));
  const selects = real.filter((f) => f.aggregate).map((f) => `    SELECT ${f.aggregate.fn === "COUNT" ? "COUNT(*)" : `${f.aggregate.fn}( ${f.aggregate.column.toLowerCase()} )`} FROM ${table} INTO ls_row-${f.name.toLowerCase()}.`);
  const constants = constantsOf(e);
  return `CLASS ${cls} DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/cds2ddic.mjs (tools/cds-computed.mjs) from ${e.name} - do not edit
* R11 (docs/rap-runtime.md, "The singleton root"): no SQL view; the one row
* is computed per read -- the constants, and ${e.computed.aggregates.map((a) => `${a.fn}( ${a.column} )`).join(", ")}
* over ${e.computed.table}
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row,
${rows.join("\n")}
           END OF ty_row.
    TYPES tt_row TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    INTERFACES zif_stg_cds_source.
    CLASS-METHODS constants
      RETURNING
        VALUE(rt_const) TYPE zcl_stg_cds_const=>tt_const.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD constants.
${constantLines(constants)}  ENDMETHOD.

  METHOD zif_stg_cds_source~read.
    DATA ls_row   TYPE ty_row.
    DATA lv_where TYPE string.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.

    CREATE DATA rr_data TYPE tt_row.
    ASSIGN rr_data->* TO <lt_data>.
    lv_where = iv_where.
    IF zcl_stg_cds_const=>decide( EXPORTING it_const = constants( ) CHANGING cv_where = lv_where ) = abap_false.
      RETURN.
    ENDIF.
    IF lv_where IS NOT INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
        EXPORTING
          textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
          method = |${e.name}: a condition on a computed element ({ lv_where })|.
    ENDIF.
${selects.join("\n")}
    zcl_stg_cds_const=>fill( EXPORTING it_const = constants( ) CHANGING cs_row = ls_row ).
    APPEND ls_row TO <lt_data>.
  ENDMETHOD.

  METHOD zif_stg_cds_source~create_line.
    CREATE DATA rr_line TYPE ty_row.
  ENDMETHOD.

${["insert", "update", "delete"].map((m) => `  METHOD zif_stg_cds_source~${m}.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
      EXPORTING
        textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
        method = '${m.toUpperCase()} through ${e.name}: a computed view is read-only'.
  ENDMETHOD.
`).join("\n")}
ENDCLASS.
`;
}

/** the APPENDs of a CONSTANTS method: each constant element, its value */
export function constantLines(constants) {
  if (!constants.length) return "";
  return "    DATA ls_const TYPE zcl_stg_cds_const=>ty_const.\n" + constants.map((f) => `    ls_const-name = '${f.name}'.\n    ls_const-value = '${String(f.constant).replaceAll("'", "''")}'.\n    APPEND ls_const TO rt_const.\n`).join("");
}

const pad = (n, w = 6) => String(n).padStart(w, "0");
export const xmlText = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** R11: the DDIC structure (TABL INTTAB) under the CDS name of a computed
 *  view: `TYPES x TYPE /dmo/i_carrierslocksingleton_s` resolves as on a
 *  system, where the CDS entity is a type. The constants are typed by their
 *  literal, an aggregate by the column it aggregates (COUNT: INT4)
 *
 *  This is the one TABL XML writer of the tree. With `transport` it spells a
 *  transparent table instead of a structure -- TABCLASS, CLIDEP, MAINFLAG,
 *  CONTFLAG and the DD09L technical settings -- which is what the DDIC probe
 *  of the existing-schema mode emits (tools/hana-ddic-probe.mjs). With
 *  `ddlanguage` the header carries that language instead of E -- the master
 *  language the text was picked in (CRITIC-926 SHOULD 4) -- and a DDTEXT
 *  that comes out empty is dropped, the way an export leaves it out, not
 *  written as an empty tag. A field
 *  may also carry its DD03P tags directly in `f.dd03p` (the mapping's own
 *  order: KEYFLAG, ROLLNAME, COMPTYPE, ADMINFIELD, INTTYPE, INTLEN,
 *  REFTABLE, PRECFIELD, REFFIELD, NOTNULL, DATATYPE, LENG, DECIMALS, MASK);
 *  without it, spelled as before. */
export function structureXml(e, {transport = false, ddlanguage = "", tabclass = "", sqltab = ""} = {}) {
  const builtin = (f) => {
    const m = /^c LENGTH (\d+)$/.exec(f.abapType ?? "");
    if (m) return {INTTYPE: "C", INTLEN: pad(Number(m[1]) * 2), DATATYPE: "CHAR", LENG: pad(m[1])};
    switch (f.abapType) {
      case "int1": return {INTTYPE: "X", INTLEN: pad(1), DATATYPE: "INT1", LENG: pad(3)};
      case "int2": return {INTTYPE: "X", INTLEN: pad(2), DATATYPE: "INT2", LENG: pad(5)};
      default: return {INTTYPE: "I", INTLEN: pad(4), DATATYPE: "INT4", LENG: pad(10)};
    }
  };
  const fields = e.fields.filter((f) => transport || f.tabl === true || f.constant !== undefined || f.aggregate).map((f) => {
    const d = f.aggregate?.dd03p;
    const props = f.dd03p ?? (d?.ROLLNAME ? {ROLLNAME: d.ROLLNAME, COMPTYPE: "E"}
      : d ? Object.fromEntries(["INTTYPE", "INTLEN", "DATATYPE", "LENG", "DECIMALS"].filter((k) => d[k] !== undefined).map((k) => [k, d[k]]))
      : builtin(f));
    return `    <DD03P>
     <FIELDNAME>${f.name}</FIELDNAME>
${Object.entries(props).map(([k, v]) => `     <${k}>${xmlText(v)}</${k}>`).join("\n")}
    </DD03P>`;
  });
  const ddtext = xmlText(String(e.label ?? e.name).slice(0, 60));
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V>
    <TABNAME>${e.name.toUpperCase()}</TABNAME>
    <DDLANGUAGE>${String(ddlanguage).trim().toUpperCase() || "E"}</DDLANGUAGE>
    <TABCLASS>${String(tabclass).trim() !== "" ? String(tabclass).trim().toUpperCase() : transport ? "TRANSP" : "INTTAB"}</TABCLASS>
${String(e.sqltab ?? "").trim() !== "" ? `    <SQLTAB>${xmlText(String(e.sqltab).trim().toUpperCase())}</SQLTAB>\n` : ""}${transport && e.clidep !== false ? "    <CLIDEP>X</CLIDEP>\n" : ""}${ddtext !== "" ? `    <DDTEXT>${ddtext}</DDTEXT>\n` : ""}${transport ? "    <MAINFLAG>X</MAINFLAG>\n    <CONTFLAG>A</CONTFLAG>\n" : ""}    <EXCLASS>1</EXCLASS>
   </DD02V>
${transport ? `   <DD09L>
    <TABNAME>${e.name.toUpperCase()}</TABNAME>
    <AS4LOCAL>A</AS4LOCAL>
    <TABKAT>0</TABKAT>
    <TABART>APPL1</TABART>
    <BUFALLOW>N</BUFALLOW>
   </DD09L>
` : ""}   <DD03P_TABLE>
${fields.join("\n")}
   </DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

/** R11: the element of a view that has no source column: a literal (a
 *  constant element) or, in the singleton root, an aggregate */
export function computedElement(el, {children, nodeName, tokensOf, firstDirect, annos, isKey, alias, comps, edmOf, computed}) {
  const lit = literalElement(el, {children, nodeName, tokensOf, annos, isKey});
  if (lit?.skip) return lit;
  if (lit) return lit.field;
  const a = computed && firstDirect(el, "CDSAggregate") ? computed.aggregates.find((x) => x.name === (alias ?? "").toUpperCase()) : undefined;
  if (!a) return undefined;
  const count = a.fn === "COUNT";
  const column = comps.get(a.column);
  const label = annos.map((x) => /@EndUserText\.label:\s*'([^']*)'/.exec(x)?.[1]).find(Boolean);
  return {name: a.name, element: alias, base: count ? "" : a.column, key: isKey, ...(count ? {edm: "Edm.Int32", maxlength: 0} : edmOf(column)),
    typeABAP: count ? "i" : column?.toABAP?.(), ...(count ? {abapType: "i", virtual: true, calculatedBy: ""} : {}),
    aggregate: a, label: label ?? a.name, annotations: annos};
}

/** R11: the parts of a generated source class's read for a view with
 *  constant elements -- a condition on one is decided before the SELECT
 *  (the view has no column for it), the value filled after it. Empty parts
 *  for a view without one, so its class stays as it was */
export function constantRead(e) {
  const constants = constantsOf(e);
  if (!constants.length) return {declare: "", data: "", decide: "", fields: "it_fields", fill: "", method: ""};
  return {
    declare: "    CLASS-METHODS constants\n      RETURNING\n        VALUE(rt_const) TYPE zcl_stg_cds_const=>tt_const.\n",
    data: "    DATA lt_fields TYPE string_table.\n    FIELD-SYMBOLS <ls_row> TYPE any.\n",
    decide: "    IF zcl_stg_cds_const=>decide( EXPORTING it_const = constants( ) CHANGING cv_where = lv_where ) = abap_false.\n"
      + "      RETURN.\n    ENDIF.\n    lt_fields = it_fields.\n"
      + constants.map((f) => `    DELETE lt_fields WHERE table_line = '${f.name}'.\n`).join(""),
    fields: "lt_fields",
    fill: "    LOOP AT <lt_data> ASSIGNING <ls_row>.\n      zcl_stg_cds_const=>fill( EXPORTING it_const = constants( ) CHANGING cs_row = <ls_row> ).\n    ENDLOOP.\n",
    method: `\n  METHOD constants.\n${constantLines(constants)}  ENDMETHOD.\n`,
  };
}
