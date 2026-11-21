// DD03L -> our abapGit *.tabl.xml shape, as a pure function.
//
// tools/hana-ddic-probe.mjs reads DD02L/DD03L/DD04L/DD01L/DD02T out of a
// schema an SAP system already holds, through the hana-client (so identifier
// folding and the literal trim apply), and this module turns the rows into
// what the tree writes by hand: the DD03P entries of src/**/*.tabl.xml. It
// is pure so it is testable without a database (test/hana-ddic-map.mjs;
// its fixtures are named ZOSD_H1_* for the same reason the leak list
// exists).
//
// The mapping is faithful to what DD03L carries and to this tree's
// conventions, which were read off its fixtures rather than invented:
//
//   - INTTYPE and INTLEN are DD03L's own columns, carried for every field,
//     resolved or not: they are read from there and preferred over anything
//     derived. Only what DD03L leaves blank is derived -- INTLEN by the
//     rules further down, the way tools/segw-tables.mjs and
//     tools/dsl-l3-remote.mjs derive it (LENG x 2 for the character types
//     C/N/D/T -- so DATS 16 and TIMS 12, as
//     src/webgui/zosd_revision_s.tabl.xml spells them; the byte count for
//     RAW/LRAW/LCHR; 1/2/4/8 for INT1/INT2/INT4/INT8; (LENG+1)/2 rounded up
//     for packed; 8 for the string/lob references (g/y) and FLTP), INTTYPE
//     from the DATATYPE's letter. A type with no rule here is refused by
//     name, not guessed at -- the rule hana-client's own TYPE_CODES table
//     states. The descriptor carries which half of the pair it had to
//     derive (inttypeFrom/intlenFrom: "dd03l" or "derived"), and the probe
//     prints the derived fields by name.
//   - a CURR/QUAN field carries the field its value is measured in:
//     REFTABLE plus REFFIELD name the currency/unit field, and PRECFIELD
//     is DD03L's own position marker (for an .INCLUDE row it names the
//     include). DD03L is the only source -- neither DD04L nor DD01L knows
//     the table the field sits in -- and what the row leaves blank stays
//     absent, the way a system's own abapGit export writes it (DD03P's
//     component order: after INTLEN, before NOTNULL). Without them the
//     field went out packed with no reference at all: the XML did not
//     round-trip and --diff could not see reference drift.
//   - a field typed by a data element carries ROLLNAME and COMPTYPE E
//     beside its resolved types, which is what a system's own abapGit
//     export writes. An element with no type of its own resolves through
//     its domain (DD04L -> DD01L), the hop tools/adt-documents.mjs
//     documents and once missed.
//   - MANDT is the one field with a shape of its own, as segw-tables writes
//     it everywhere: the XML carries KEYFLAG, ROLLNAME MANDT, ADMINFIELD 0,
//     NOTNULL X, COMPTYPE E, and nothing else. The descriptor beside it also
//     carries the type DD03L names for the field (CLNT, LENG 3), because
//     --diff compares the client field against a system's own export, whose
//     DD03P does spell the type.
//   - an .INCLUDE row is not a field; it is refused by name so a table is
//     never emitted as the part of itself that happened to resolve (the
//     partial-schema mistake tools/osd-type-graph.mjs records).
//
// The XML itself is emitted by structureXml (tools/cds-computed.mjs) in its
// transport shape: one writer, two consumers.
import {structureXml, xmlText} from "./cds-computed.mjs";

const pad = (n) => String(n).padStart(6, "0");

// DD03L row (the lower-case shape query() returns) -> our field descriptor:
// plain names for the tests and for the diff, padded strings where the XML
// wants them. `refs` carries the DD04L rows by ROLLNAME and the DD01L rows
// by DOMNAME, so the element and domain hops stay pure.
export function ddicField(row, refs = {}) {
  const fieldname = String(row.fieldname ?? "").toUpperCase();
  if (fieldname === "" || fieldname.startsWith(".")) return undefined;
  const key = String(row.keyflag ?? "").toUpperCase() === "X";
  const notnull = String(row.notnull ?? "").toUpperCase() === "X";
  const rollname = String(row.rollname ?? "").toUpperCase();
  const elements = refs.elements instanceof Map ? refs.elements : new Map();
  const domains = refs.domains instanceof Map ? refs.domains : new Map();
  // the client field, in the shape this tree writes it everywhere. The
  // descriptor also carries what DD03L says of the field's type, which
  // --diff compares: a system's own export spells DATATYPE/LENG on MANDT,
  // the XML's tags block does not, and stays as it is.
  if (fieldname === "MANDT") {
    const digits = Number(String(row.leng ?? "").trim() || 0);
    const decimals = Number(String(row.decimals ?? "").trim() || 0);
    return {fieldname, key, notnull: true, mandt: true,
      datatype: String(row.datatype ?? "").toUpperCase(),
      leng: pad(digits),
      ...(decimals > 0 ? {decimals: pad(decimals)} : {}),
      tags: {...(key ? {KEYFLAG: "X"} : {}), ROLLNAME: "MANDT", ADMINFIELD: "0", NOTNULL: "X", COMPTYPE: "E"}};
  }
  const element = elements.get(rollname);
  const domname = String(element?.domname ?? "").toUpperCase();
  const domain = domname === "" ? undefined : domains.get(domname);
  // the field's own row wins; the element, then the domain, fill what it
  // leaves empty
  const pick = (...sources) => {
    for (const value of sources) {
      if (value !== undefined && value !== null && String(value) !== "") return String(value);
    }
    return "";
  };
  const datatype = pick(row.datatype, element?.datatype, domain?.datatype).toUpperCase();
  if (datatype === "") {
    throw new Error(`hana-ddic-map: ${fieldname} has no type of its own and its data element ${rollname === "" ? "(none named)" : rollname} resolves to nothing`);
  }
  // INTTYPE and INTLEN are DD03L's own columns, for every field, resolved
  // or not -- so DD03L is the source and the element/domain hops fill only
  // what a blank leaves. (DD04L and DD01L do not carry the pair at all;
  // asking DD04L for INTTYPE was the guessed column the probe's first run
  // against a real system died on -- the measured column lists are pinned
  // by test/hana-ddic-probe.mjs.) The ABAP letters are case-significant:
  // lower-case g is STRING, y is XSTRING, b and s the small integers --
  // never folded.
  const inttypeOwn = String(row.inttype ?? "").trim();
  const inttype = inttypeOwn !== "" ? inttypeOwn : (INTTYPE_OF[datatype] ?? "");
  const inttypeFrom = inttypeOwn !== "" ? "dd03l" : (INTTYPE_OF[datatype] !== undefined ? "derived" : undefined);
  const digits = Number(pick(row.leng, element?.leng, domain?.leng) || 0);
  const decimals = Number(pick(row.decimals, element?.decimals, domain?.decimals) || 0);
  const intlenOwn = String(row.intlen ?? "").trim();
  const intlen = intlenOwn !== ""
    ? (/^\d+$/.test(intlenOwn) ? pad(Number(intlenOwn)) : intlenOwn)
    : intlenOf(fieldname, datatype, inttype, digits);
  const intlenFrom = intlenOwn !== "" ? "dd03l" : "derived";
  // the reference a CURR/QUAN field carries, exactly as DD03L says it --
  // REFTABLE and REFFIELD point at the currency/unit field, PRECFIELD is
  // the position marker (and an .INCLUDE row's name; ddicFields reads it
  // below). Blank stays absent: an empty tag is drift against what a
  // system's own export writes.
  const reftable = String(row.reftable ?? "").toUpperCase();
  const precfield = String(row.precfield ?? "").toUpperCase();
  const reffield = String(row.reffield ?? "").toUpperCase();
  // the component type DD03L names, when it is not the plain data-element
  // one (H5a): a structured component arrives as COMPTYPE S with DATATYPE
  // STRU and no INTTYPE, and the XML carries ROLLNAME beside COMPTYPE S --
  // the type is the structure the rollname names, not a data element
  const comptype = String(row.comptype ?? "").toUpperCase();
  return {
    fieldname, key, notnull, ...(rollname === "" ? {} : {rollname}),
    datatype, inttype, inttypeFrom, leng: pad(digits), intlen, intlenFrom,
    ...(reftable === "" ? {} : {reftable}),
    ...(precfield === "" ? {} : {precfield}),
    ...(reffield === "" ? {} : {reffield}),
    ...(comptype === "" || comptype === "E" ? {} : {comptype}),
    ...(decimals > 0 ? {decimals: pad(decimals)} : {}),
  };
}

// the ABAP letter a DATATYPE implies, consulted only when DD03L leaves
// INTTYPE blank. The letters are the ones the INTLEN rules below already
// state, so a derived letter and a derived INTLEN stay consistent with each
// other (LCHR under X, as that rule has always had it). A DATATYPE not
// named here leaves INTTYPE empty rather than guessed at.
const INTTYPE_OF = {
  CHAR: "C", CLNT: "C", CUKY: "C", UNIT: "C",
  NUMC: "N", ACCP: "N",
  DATS: "D", TIMS: "T",
  DEC: "P", CURR: "P", QUAN: "P",
  INT1: "b", INT2: "s", INT4: "I", INT8: "8",
  RAW: "X", LRAW: "X", LCHR: "X",
  STRG: "g", SSTR: "g",
  RSTR: "y", RAWSTRING: "y",
  FLTP: "F",
};

/** INTLEN from the type, per the rules in the module comment -- called only
 *  when DD03L leaves its own INTLEN blank. The INTTYPE is the ABAP letter
 *  (I for INT4, b/s for INT1/INT2, 8 for INT8), the DATATYPE the
 *  dictionary's own name; either is enough. */
function intlenOf(fieldname, datatype, inttype, digits) {
  if (["C", "N", "D", "T"].includes(inttype)) return pad(digits * 2);
  if (inttype === "I" || datatype === "INT4") return pad(4);
  if (inttype === "b" || datatype === "INT1") return pad(1);
  if (inttype === "s" || datatype === "INT2") return pad(2);
  if (inttype === "8" || datatype === "INT8") return pad(8);
  if (inttype === "X" && ["RAW", "LRAW", "LCHR"].includes(datatype)) return pad(digits);
  if (inttype === "P" || ["DEC", "CURR", "QUAN"].includes(datatype)) return pad(Math.ceil((digits + 1) / 2));
  if (inttype === "g" || ["STRG", "SSTR"].includes(datatype)) return pad(8);
  if (inttype === "y" || ["RSTR", "RAWSTRING"].includes(datatype)) return pad(8);
  if (inttype === "F" || datatype === "FLTP") return pad(8);
  throw new Error(`hana-ddic-map: ${fieldname}: ${datatype} (INTTYPE ${inttype || "?"}) has no INTLEN rule here`);
}

/** the fields of one DD03L read, in POSITION order. An .INCLUDE row is
 *  refused by name, with the structure it would have expanded, so the
 *  caller can splice those fields in themselves. */
export function ddicFields(rows, refs = {}) {
  const out = [];
  const includes = [];
  for (const row of [...(rows ?? [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))) {
    const name = String(row.fieldname ?? "").toUpperCase();
    if (name.startsWith(".")) {
      // every dot form names its structure in PRECFIELD (.INCLUDE,
      // .INCLU-<suffix>, .APPEND alike), and the refusal below says which
      // structure to read -- a blank PRECFIELD falls back to the marker
      const structure = String(row.precfield ?? "").trim().toUpperCase();
      includes.push(structure !== "" ? structure : name);
      continue;
    }
    const field = ddicField(row, refs);
    if (field !== undefined) out.push(field);
  }
  if (includes.length > 0) {
    throw new Error(`hana-ddic-map: the table carries an include row (${includes.join(", ")}); read the included structure's DD03L and splice its fields in before mapping`);
  }
  return out;
}

/** what --mandt asks: is MANDT the first key field? A MANDT further back is
 *  not the client field ABAP's client handling assumes first. */
export function mandtFirstKey(fields) {
  const first = (fields ?? [])[0];
  return first !== undefined && first.fieldname === "MANDT" && first.key === true;
}

/** the client column of a client-dependent table, from its DD03L rows (the
 *  lower-case shape query() returns): the first key field, in POSITION
 *  order, whose DATATYPE is CLNT. Not the name MANDT -- a real tenant names
 *  it CLIENT, MANDANT, CLNT, RCLNT and more -- and not "the first column",
 *  which some tables flagged client-dependent hold something else in.
 *  Dot rows (.INCLUDE, .APPEND) are markers, not fields: DD03L carries
 *  their expanded fields beside them. Undefined when no key field is CLNT;
 *  the caller decides what that means (the shadow schema refuses). */
export function clientField(rows) {
  const sorted = [...(rows ?? [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  for (const row of sorted) {
    const name = String(row.fieldname ?? "").trim().toUpperCase();
    if (name === "" || name.startsWith(".")) continue;
    if (String(row.keyflag ?? "").toUpperCase() !== "X") continue;
    if (String(row.datatype ?? "").trim().toUpperCase() === "CLNT") return name;
  }
  return undefined;
}

/** one mapped table as the tree's abapGit TABL XML, through the shared
 *  writer. `table` is {name, text, clidep, tabclass, fields, language}:
 *  the fields as ddicFields/ddicFieldsWithIncludes returned them, the
 *  language the master language the text was picked in. */
export function tablXml(table) {
  // the TABCLASS the DD02L row carries, through to the writer (H5a): the
  // dump's structures arrive as INTTAB and go out in the include shape --
  // no DD09L, no client, TABCLASS INTTAB. A row without one stays TRANSP,
  // which is what the live read has always produced. H5d lifts the two
  // refusals the real closure run hit: an APPEND goes out as its own TABL,
  // TABCLASS APPEND, the SQLTAB target its DD02L row names beside it, the
  // include shape otherwise -- no DD09L, no client (the fetched pack's own
  // append export is the shape); a VIEW goes out as a read-only structure
  // type, TABCLASS VIEW, the shape the transpiler resolves the name
  // through -- the join tables a .view.xml needs (DD26S/DD27S) are not in
  // --ddic, so the CDS route's DDIC-view shape is out of reach here.
  // POOL and CLUSTER stay refused by name (CRITIC-926 SHOULD 3): TABCLASS
  // reduced to a boolean wrote a POOL as a type that holds no rows,
  // silently. The refusal is about the TABCLASS and nothing else
  // (CRITIC-929 SHOULD 4): what a VIEW became and where its reads stand is
  // said in the dump run's summary view line (tools/hana-ddic-gen.mjs) and
  // in docs/db-backends.md's shadow-schema paragraph, not tacked onto a
  // POOL error about a different kind.
  const tabclass = String(table.tabclass ?? "TRANSP").toUpperCase();
  if (tabclass !== "TRANSP" && tabclass !== "INTTAB" && tabclass !== "APPEND" && tabclass !== "VIEW") {
    throw new Error(`hana-ddic-map: ${table.name}: TABCLASS ${tabclass} is not written here -- TRANSP, INTTAB, APPEND and VIEW are.`);
  }
  // a repeated FIELDNAME in the final list is refused here, before anything
  // is written, naming table and field (CRITIC-929 MUST 1): the raw
  // duplicate a dump's own DD03L rows can carry, or an expansion the skip
  // in ddicFieldsWithIncludes missed, used to be written twice and die
  // later in cds2ddic as a transpiler error -- the failure belongs at
  // generation time. Marker rows stand outside the check: two .INCLU--AP
  // markers naming two appends are the dictionary's own spelling, and the
  // transpiler expands both off PRECFIELD.
  const seen = new Set();
  for (const field of table.fields ?? []) {
    if (field.marker === true) continue;
    const fieldname = String(field.fieldname ?? "").toUpperCase();
    if (seen.has(fieldname)) {
      throw new Error(`hana-ddic-map: ${table.name}: the field list repeats ${fieldname} -- nothing is written`);
    }
    seen.add(fieldname);
  }
  const fields = (table.fields ?? []).map((f) => ({
    // tabl marks a DDIC field so the writer's include shape keeps it: that
    // filter exists for the CDS structure's computed-only fields (H5a), and
    // a marked field is never one of those
    tabl: true,
    name: f.fieldname,
    dd03p: f.marker === true ? {
      // an include/append marker row, spelled the way the fetched pack's
      // own exports spell them, minus the DDTEXT the dump's DD03L does not
      // carry: KEYFLAG when the marker is a key include, COMPTYPE S, the
      // structure in PRECFIELD, the component kind in MASK
      ...(f.key === true ? {KEYFLAG: "X"} : {}),
      COMPTYPE: "S",
      PRECFIELD: f.precfield,
      MASK: "      S",
    } : f.mandt === true ? f.tags : {
      ...(f.key ? {KEYFLAG: "X"} : {}),
      ...(f.rollname !== undefined ? {ROLLNAME: f.rollname, COMPTYPE: f.comptype ?? "E"} : {}),
      ADMINFIELD: "0",
      // a structured component (COMPTYPE S) has INTTYPE blank in DD03L and
      // INTTYPE_OF has no STRU: an empty tag is the drift the module
      // refuses everywhere else, so the tag only goes out when there is a
      // letter (CRITIC-926 SHOULD 2)
      ...(f.inttype ? {INTTYPE: f.inttype} : {}),
      INTLEN: f.intlen,
      ...(f.reftable !== undefined ? {REFTABLE: f.reftable} : {}),
      ...(f.precfield !== undefined ? {PRECFIELD: f.precfield} : {}),
      ...(f.reffield !== undefined ? {REFFIELD: f.reffield} : {}),
      ...(f.notnull ? {NOTNULL: "X"} : {}),
      DATATYPE: f.datatype,
      LENG: f.leng,
      ...(f.decimals !== undefined ? {DECIMALS: f.decimals} : {}),
      // MASK the way a system's own export spells it ("      S" on a real
      // export's .INCLUDE row): a structured component is an S, an ordinary
      // field is two spaces plus its DATATYPE. Spelled here, not carried:
      // the dump's MASK column arrives trimmed, its leading spaces gone.
      MASK: f.comptype === "S" ? "      S" : `  ${f.datatype}`,
    },
  }));
  // the header's DDLANGUAGE is the master language the text was picked in,
  // not a hard-coded E (CRITIC-926 SHOULD 4)
  return structureXml({name: table.name, label: table.text, clidep: table.clidep !== false, fields,
    sqltab: String(table.sqltab ?? "").trim().toUpperCase()},
  {transport: tabclass === "TRANSP", ddlanguage: table.language, tabclass});
}

// ------------------------------------------------------------- the dump ----
// The pieces the dump path (H5a) needs and the live read never did. The
// *.dtel.xml / *.doma.xml of this tree were only ever written by hand, so
// there was no writer to reuse: these are the one pair, beside tablXml, in
// the envelope the tree's own files carry (read off src/zosd_test/ddic,
// packs/rap-flight and the lib's dtel/doma files).

/** the abapGit file name of an object: lower case, a /namespace/ spelled
 *  #namespace#, the way abapGit names namespace objects on disk and the way
 *  this tree's own dumps and layers spell them. One rule for the gen tool's
 *  live read and its dump read. */
export function abapGitFileName(name, kind) {
  return `${String(name).toLowerCase().replaceAll("/", "#")}.${kind}.xml`;
}

const abapGitEnvelope = (serializer, values) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_${serializer}" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
${values}  </asx:values>
 </asx:abap>
</abapGit>
`;

// the tags of a DD04V/DD01V/DD07V: what the row leaves blank stays absent,
// the way a system's own abapGit export writes it
const tagLines = (indent, tags) => tags
  .filter(([, value]) => String(value ?? "").trim() !== "")
  .map(([name, value]) => `${indent}<${name}>${xmlText(String(value).trim())}</${name}>`)
  .join("\n") + "\n";

/** one DD04L row and its DD04T text row as the tree's abapGit *.dtel.xml,
 *  in the DD04V shape a system's own export writes (CRITIC-926 SHOULD 1).
 *  `element` is {name, row, trow, masterLanguage}: DOMNAME stands third,
 *  right after DDLANGUAGE, and a domain-typed element (REFKIND D) goes out
 *  with none of DATATYPE/LENG/DECIMALS/OUTPUTLEN at all -- the dictionary
 *  copies the domain's type onto the DD04L row, abapGit clears the copy on
 *  the way out, and abaplint resolves the type through the domain
 *  (lookupDomain). A predefined-typed element (REFKIND blank) keeps its own
 *  type tags, after DTELMASTER, with the initial values dropped: abapGit
 *  writes no zero LENG/DECIMALS/OUTPUTLEN -- the real dump's one string
 *  element carries LENG 000000, and its export spells DATATYPE alone. The
 *  words come from the DD04T row, which is where the dictionary keeps
 *  DDTEXT and the four labels (DD04L carries only the lengths they are
 *  shown in, unpadded, as the row says them). */
export function dtelXml(element) {
  const row = element.row ?? {};
  const trow = element.trow ?? {};
  const v = (tag) => String(row[tag] ?? "");
  const t = (tag) => String(trow[tag] ?? "");
  const lang = (String(element.masterLanguage ?? "").trim() || "E").toUpperCase();
  const refkind = v("refkind").trim().toUpperCase();
  const domainTyped = refkind === "D";
  const positive = (tag) => Number(v(tag).trim()) > 0;
  const tags = [
    ["ROLLNAME", String(element.name ?? "").toUpperCase()],
    ["DDLANGUAGE", lang],
    ...(v("domname").trim() !== "" ? [["DOMNAME", v("domname").toUpperCase()]] : []),
    ...(positive("headlen") ? [["HEADLEN", v("headlen")]] : []),
    ...(positive("scrlen1") ? [["SCRLEN1", v("scrlen1")]] : []),
    ...(positive("scrlen2") ? [["SCRLEN2", v("scrlen2")]] : []),
    ...(positive("scrlen3") ? [["SCRLEN3", v("scrlen3")]] : []),
    ["DDTEXT", t("ddtext")],
    ["REPTEXT", t("reptext")],
    ["SCRTEXT_S", t("scrtext_s")],
    ["SCRTEXT_M", t("scrtext_m")],
    ["SCRTEXT_L", t("scrtext_l")],
    ["DTELMASTER", v("dtelmaster").trim() !== "" ? v("dtelmaster") : lang],
    ...(domainTyped ? [] : [
      ...(v("datatype").trim() !== "" ? [["DATATYPE", v("datatype").toUpperCase()]] : []),
      ...(positive("leng") ? [["LENG", pad(Number(v("leng").trim()))]] : []),
      ...(positive("decimals") ? [["DECIMALS", pad(Number(v("decimals").trim()))]] : []),
      ...(positive("outputlen") ? [["OUTPUTLEN", v("outputlen")]] : []),
    ]),
    ...(refkind !== "" ? [["REFKIND", refkind]] : []),
    ...(v("reftype").trim() !== "" ? [["REFTYPE", v("reftype").toUpperCase()]] : []),
  ];
  return abapGitEnvelope("DTEL", `   <DD04V>\n${tagLines("    ", tags)}   </DD04V>\n`);
}

/** one DD01L row, its DD01T text and its DD07L values as the tree's abapGit
 *  *.doma.xml. `domain` is {name, row, text, masterLanguage, values}. A
 *  domain with no dumped values goes out without the DD07V_TAB -- the shape
 *  of a domain without fixed values in this tree's own files. */
export function domaXml(domain) {
  const row = domain.row ?? {};
  const v = (tag) => String(row[tag] ?? "");
  const lang = (String(domain.masterLanguage ?? "").trim() || "E").toUpperCase();
  const tags = [
    ["DOMNAME", String(domain.name ?? "").toUpperCase()],
    ["DDLANGUAGE", lang],
    ["DATATYPE", v("datatype").toUpperCase()],
    ["LENG", pad(Number(v("leng").trim()) || 0)],
    ["DECIMALS", pad(Number(v("decimals").trim()) || 0)],
    ["OUTPUTLEN", v("outputlen")],
    ...(v("lowercase").trim().toUpperCase() === "X" ? [["LOWERCASE", "X"]] : []),
    ...(v("valexi").trim().toUpperCase() === "X" ? [["VALEXI", "X"]] : []),
    ["DDTEXT", domain.text ?? ""],
  ];
  const values = [...(domain.values ?? [])]
    .sort((a, b) => (Number(a.valpos) || 0) - (Number(b.valpos) || 0))
    .map((value) => {
      const w = (tag) => String(value[tag] ?? "");
      return `    <DD07V>\n${tagLines("     ", [
        ["DOMNAME", String(domain.name ?? "").toUpperCase()],
        ["VALPOS", String(Number(w("valpos").trim()) || 0).padStart(4, "0")],
        ["DDLANGUAGE", lang],
        ["DOMVALUE_L", w("domvalue_l")],
        ["DOMVALUE_H", w("domvalue_h")],
        ["DDTEXT", w("ddtext")],
      ])}    </DD07V>`;
    })
    .join("\n");
  const valuesBlock = values === "" ? "" : `   <DD07V_TAB>\n${values}\n   </DD07V_TAB>\n`;
  return abapGitEnvelope("DOMA", `   <DD01V>\n${tagLines("    ", tags)}   </DD01V>\n${valuesBlock}`);
}

/** the fields of one DD03L read, as a system's own abapGit export spells
 *  them (H5d): the marker rows STAY -- .INCLUDE, .INCLU-<suffix> and
 *  .INCLU--AP, the dictionary's append spelling, each naming its structure
 *  in PRECFIELD -- and the copies the dump's DD03L also carries, the
 *  included fields expanded again under the base table's own name, are
 *  dropped by the dictionary's own mark: every expanded copy carries
 *  ADMINFIELD '1', every plain row '0' (measured on the real closure dump:
 *  16 copies against 265 plain rows, the 7 marker rows '0' as well), and
 *  the rule is the mark's value space, abapGit's own `adminfield <> '0'`
 *  -- anything but '0' is a copy -- so the mark is the discriminator and
 *  the name only the fallback for rows that carry no mark at all -- a
 *  copy an older read brings without the
 *  column is still caught by name, suffix and all, since a
 *  .INCLU-<suffix> marker renames its copies by the suffix (the
 *  transpiler's own rename, --AP excepted). The transpiler expands the
 *  markers itself, off PRECFIELD, the way it expands the fetched pack's
 *  own exports -- so the target table's type gains the appended fields
 *  with no second writer, and a .INCLU-<suffix> keeps its suffix on the
 *  names by the transpiler's own rename (CRITIC-926 SHOULD 5). FIELDNAME
 *  .APPEND -- a spelling the dictionary does not write but hand-built
 *  shapes have used -- goes out as .INCLU--AP, the form the transpiler
 *  expands with no rename. A marker whose DD03L is not in the dump is
 *  refused by name: the XML would carry a structure the generation never
 *  writes. A plain '0' row named like an include's field is refused too,
 *  by table and field: the expansion would repeat it (CRITIC-929-r2
 *  SHOULD 2). `includes` carries the dump's DD03L rows by table name; the
 *  live read keeps plain ddicFields, which refuses an include row. */
export function ddicFieldsWithIncludes(rows, refs = {}, includes = new Map()) {
  const sorted = [...(rows ?? [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0));
  const out = [];
  // the fieldnames the markers of this table bring in, flattened through
  // the include chain: an outer row carrying one of them is the dump's
  // expanded copy of the include's field -- DDIC names are unique in the
  // flattened structure, so the name cannot be anything else
  const shadowed = new Set();
  const flattened = (name, chain) => {
    if (chain.has(name)) {
      throw new Error(`hana-ddic-map: the include chain closes a cycle at ${name}`);
    }
    const inner = includes.get(name);
    if (inner === undefined) {
      throw new Error(`hana-ddic-map: the include chain reaches ${name}, whose DD03L is not in the dump`);
    }
    const names = new Set();
    for (const row of [...(inner ?? [])].sort((a, b) => (Number(a.position) || 0) - (Number(b.position) || 0))) {
      const fieldname = String(row.fieldname ?? "").toUpperCase();
      if (fieldname === "" || fieldname.startsWith(".")) {
        const nested = String(row.precfield ?? "").trim().toUpperCase();
        if (nested !== "") {
          for (const deep of flattened(nested, new Set([...chain, name]))) names.add(deep);
        }
        continue;
      }
      names.add(fieldname);
    }
    return names;
  };
  for (const row of sorted) {
    const name = String(row.fieldname ?? "").toUpperCase();
    if (name.startsWith(".")) {
      const include = String(row.precfield ?? "").trim().toUpperCase();
      if (include === "") {
        throw new Error(`hana-ddic-map: the table carries an include row (${name}) with no PRECFIELD naming its structure`);
      }
      if (includes.has(include) === false) {
        throw new Error(`hana-ddic-map: the table carries an include row (${name}) whose DD03L (${include}) is not in the dump`);
      }
      const deep = flattened(include, new Set());
      for (const field of deep) shadowed.add(field);
      // the suffix the marker carries renames the copies (the transpiler's
      // own rename, table.js; the append form --AP renames nothing), so the
      // fallback's name set carries the suffixed spellings too. The real
      // dump's 7 markers are all plain .INCLUDE -- this is the fallback's
      // own bookkeeping, for a read without the ADMINFIELD column.
      const suffix = /^\.INCLU-(.+)$/.exec(name)?.[1];
      if (suffix !== undefined && suffix !== "-AP") {
        for (const field of deep) shadowed.add(field + suffix);
      }
      const key = String(row.keyflag ?? "").toUpperCase() === "X";
      out.push({fieldname: name === ".APPEND" ? ".INCLU--AP" : name, key, marker: true, precfield: include});
      continue;
    }
    // DDIC's own discriminator first (CRITIC-929 MUST 1; CRITIC-929-r2
    // SHOULD 2): a row whose ADMINFIELD is anything but '0' is the dump's
    // expansion of an include's field, whatever it is named -- abapGit's
    // own rule is `DELETE ... WHERE adminfield <> '0'`, and the '1' every
    // measured copy carries is only the value the dumps happen to hold --
    // and a marker row is kept whatever its mark (the transpiler expands
    // it off PRECFIELD). The name rule fires only for a row that carries
    // no mark at all (an older read without the column): a marked row is
    // decided by its mark, not its name. And a row plain by its mark ('0')
    // whose name is an include's field is refused here, naming the table
    // and the field (the row's own TABNAME): the marker kept beside it
    // makes the transpiler expand the include into that same name, and
    // the duplicate used to be written and die in cds2ddic later
    // (CRITIC-929-r2 SHOULD 2) -- the refusal belongs at generation time,
    // like the raw duplicate's in tablXml. The copies ride their markers
    // in POSITION order in the dumps measured, so the mark and the name
    // here see the marker first.
    const adminfield = String(row.adminfield ?? "").trim().toUpperCase();
    if (adminfield !== "0" && adminfield !== "") continue;
    if (adminfield === "" && shadowed.has(name)) continue;
    if (shadowed.has(name)) {
      const table = String(row.tabname ?? "").toUpperCase();
      throw new Error(`hana-ddic-map: ${table}: the field list repeats ${name} through an include expansion -- nothing is written`);
    }
    const field = ddicField(row, refs);
    if (field !== undefined) out.push(field);
  }
  return out;
}
