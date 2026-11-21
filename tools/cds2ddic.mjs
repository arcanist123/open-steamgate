#!/usr/bin/env node
// CDS (DDLS) -> what the transpiler and the SADL runtime need.
//
// For every src/cds/*.ddls.asddls that is a projection of one table or DDIC
// view (no joins yet) this writes into gen/cds/:
//   <SQLVIEW>.view.xml            DDIC view in abapGit form: the transpiler
//                                 creates the SQLite view from it and ABAP can
//                                 SELECT FROM it with typed fields
//   zcl_stg_cds_<sqlview>.clas.abap  a zif_stg_cds_source over that view
//                                 (static FROM; WHERE/ORDER BY/field list and
//                                 GROUP BY dynamic)
//   zcl_stg_cds_registry.clas.abap  entity metadata for the SADL exposure:
//                                 fields with EDM types, keys, labels, all
//                                 annotations, associations with their ON
//                                 pairs and cardinality
// The DDLS objects themselves stay out of the transpiler input (it rejects
// the object type); abaplint lints them.
import * as abaplint from "@abaplint/core";
import {contentFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {fileOf, wordOf, classNameOf} from "./cds-names.mjs";
import {readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync, rmSync, statSync} from "node:fs";
import {createHash} from "node:crypto";
import {basename, join} from "node:path";
import {libraryPath} from "./osd-lib-path.mjs";
import {compositionsOf, namespaced, projectedAssociations, projectionBase, redirectOf, resolveTree} from "./cds-tree.mjs";
import {castType, edmOf} from "./cds-types.mjs";
import {pathClass, pathElement} from "./cds-path.mjs";
import {computedElement, computedSourceClass, constantRead, singletonOf, structureXml} from "./cds-computed.mjs";
import {parseTABL, tableSourceClass} from "./cds-table.mjs";
export {tableSourceClass} from "./cds-table.mjs";

const OUT = "gen/cds";
// **The libraries this generator resolves types against, and they have to be
// the ones the build uses.** This list said `.local/fork/open-abap-odata`,
// which `abap_transpile.json` does not configure and `osd-worktree` does not
// share -- `SHARED` carries `.local/lars` and not `.local/fork` -- so in
// **every planted worktree** the folder was absent, `filter(existsSync)`
// dropped it, and the generator ran with one dependency fewer than in the
// checkout it was written in. Silently: an absent library was not an error,
// it was an absence.
//
// Measured before changing it: the two clones are identical here, 119 files
// each, `diff -rq` empty -- so this is the same content read from the place
// the rest of the system reads it (2026-09-19).
const LIBRARIES = ["open-abap-core", "open-abap-odata"];

function walk(dir, out = []) {
  // sorted: the registry this writes lists entities in this order, and a
  // directory's order is the host's (Bun and Node differ), not the tree's
  for (const e of readdirSync(dir, {withFileTypes: true}).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { if (!["node_modules", "output", ".git"].includes(e.name)) walk(p, out); }
    else if (/\.(abap|xml|asddls)$/.test(e.name) && !e.name.endsWith(".clas.testclasses.abap")) out.push(p);
  }
  return out;
}
const mem = (paths) => paths.map((p) => new abaplint.MemoryFile(p, readFileSync(p, "utf8")));

function tokensOf(node) { return node?.concatTokens?.() ?? ""; }
function nodeName(node) { return node.get?.().constructor?.name ?? ""; }
function children(node) { return node.getChildren?.() ?? []; }
function find(node, name) { const out = []; const rec = (n) => { if (nodeName(n) === name) out.push(n); for (const c of children(n)) rec(c); }; rec(node); return out; }
function firstDirect(node, name) { return children(node).find((c) => nodeName(c) === name); }
function normAnno(text) { return text.replace(/\s*\.\s*/g, ".").replace(/\s*:\s*/g, ": ").replace(/@\s+/g, "@").trim(); }

export function parseDDLS(obj, reg, depth = 0) {
  const p = obj.getParsedData();
  const tree = p?.tree;
  if (!tree) return undefined;
  const name = obj.getName();
  const sqlView = (p.sqlViewName ?? name).toUpperCase();
  const viewAnnotations = children(tree).filter((c) => nodeName(c) === "CDSAnnotation").map((c) => normAnno(tokensOf(c)));
  // R5: `as projection on` reads the base view's table (tools/cds-tree.mjs)
  const isProjection = nodeName(tree) === "CDSDefineProjection";
  const projected = isProjection ? projectionBase(tree, reg, name, depth, parseDDLS) : undefined;
  if (projected?.skip) return projected;
  const select = isProjection ? tree : firstDirect(tree, "CDSSelect");
  if (!select) return {name, skip: "no select"};
  const sources = isProjection ? [projected.source]
    : find(select, "CDSSource").map((s) => tokensOf(s).replace(/\s+as\s+\w+$/i, "").trim().toUpperCase());
  // R11: the singleton root (a left outer join on 0 = 0 with aggregates and
  // literals, one row) is computed by its source class (tools/cds-computed.mjs)
  const computed = isProjection ? projected.computed : singletonOf(select, {find, children, nodeName, tokensOf, firstDirect, reg, name});
  if (computed?.skip) return computed;
  if (!computed && (find(select, "CDSJoin").length > 0 || sources.length !== 1)) return {name, skip: "joins are not supported yet"};
  // **A WHERE was read and thrown away, and that was wrong in both
  // directions.** The generated DDIC view carries `DD26V` (the table) and
  // `DD27P` (the fields) and no selection condition at all, so a filtered
  // view returned EVERY row; and `write.writable` did not look, so a row
  // failing the filter could be INSERTED through a view that can never show
  // it -- which is precisely what SADL refuses to do. Both silent, and
  // nothing in the tree has a WHERE, so the cost of refusing now is zero
  // and the cost of the first one being wrong is a wrong answer.
  //
  // Refused at generation rather than at runtime, because the author is here
  // and the reader of a wrong row is not (2026-09-19, B.1).
  if (!computed && find(select, "CDSWhere").length > 0) {
    return {name, skip: "a WHERE in the view is not carried yet: the DDIC view would return every row, " +
      "and a write through it could insert a row the view cannot show"};
  }
  const source = computed && !isProjection ? computed.table : sources[0].replace(/\s+/g, "");
  const table = reg.getObject("TABL", source) ?? reg.getObject("VIEW", source);
  const comps = new Map();
  for (const c of table?.parseType(reg)?.getComponents?.() ?? []) comps.set(c.name.toUpperCase(), c.type);

  const fields = [];
  const exposedAssociations = [];
  const associationAnnotations = new Map();
  const redirects = new Map();
  for (const el of find(select, "CDSElement")) {
    const annos = children(el).filter((c) => nodeName(c) === "CDSAnnotation").map((c) => normAnno(tokensOf(c)));
    const isKey = children(el).some((c) => nodeName(c) === "Identifier" && tokensOf(c).toLowerCase() === "key");
    const as = firstDirect(el, "CDSAs");
    const alias = as ? tokensOf(firstDirect(as, "CDSName")) : undefined;
    const src = children(el).find((c) => nodeName(c) === "CDSName" || nodeName(c) === "CDSPrefixedName");
    const srcName = src ? tokensOf(src).replace(/\s+/g, "") : undefined;
    // a virtual element: no column behind it, an ABAP class calculates it
    // after the read (@ObjectModel.virtualElement + virtualElementCalculatedBy,
    // written as cast( '' as abap.<type> ) as <Name>)
    const cast = firstDirect(el, "CDSCast");
    if (cast && annos.some((a) => /@ObjectModel\.virtualElement:\s*true/i.test(a))) {
      const fieldName = (alias ?? "").toUpperCase();
      // normAnno has put a space after every colon, the one inside 'ABAP:...' too
      const by = annos.map((a) => /@ObjectModel\.virtualElementCalculatedBy:\s*'ABAP:\s*([^']+)'/i.exec(a)?.[1]?.trim()).find(Boolean);
      if (!fieldName || !by) {
        return {name, skip: `virtual element without an alias or a calculating class`};
      }
      const t = castType(tokensOf(cast));
      if (!t) {
        return {name, skip: `virtual element ${fieldName}: cannot read the cast type`};
      }
      const label = annos.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean);
      fields.push({name: fieldName, base: "", key: false, ...t.edm, abapType: t.abap,
        virtual: true, calculatedBy: by.toUpperCase(), label: label ?? fieldName, annotations: annos});
      continue;
    }
    // **A cast over a real column is a column, and it used to vanish.**
    //
    // The branch above handles `cast( '' as abap.char(12) ) as X` when the
    // element is annotated as a virtual one. Without that annotation the
    // element has no direct `CDSName` child at all -- the source column sits
    // *inside* the cast -- so `srcName` came out undefined and the `continue`
    // below dropped the field without a word. Three elements in, two fields
    // out; an entity keyed on the casted one then answered with no key
    // (backlog B.14, found 2026-09-17 building the status service).
    //
    // The type is the cast's, because that is what the cast is for. The
    // column underneath is still named, so the view reads it.
    if (cast && !srcName) {
      // What is being cast, read as the text between `cast(` and ` as abap.`.
      // Scanning the cast for a CDSName was the first attempt and it is worse
      // than the defect it fixes: in `cast( '' as abap.char(12) )` it finds
      // `char`, and a field pointing at a column that does not exist is a
      // disappearance with a name on it.
      const castText = tokensOf(cast).replace(/\s+/g, " ");
      const between = /^\s*cast\s*\(\s*(.*?)\s+as\s+abap\s*\./i.exec(castText)?.[1];
      const inner = between !== undefined && /^[\w.]+$/.test(between) ? between : undefined;
      const t = castType(tokensOf(cast));
      if (inner === undefined || t === undefined) {
        // a cast of a literal with no virtualElement annotation is a constant
        // column and needs a decision of its own; say so rather than drop it
        return {name, skip: `${(alias ?? "?").toUpperCase()}: a cast this generator cannot read ` +
          `(${inner === undefined ? "no column inside it" : "no ABAP type"})`};
      }
      const fieldName = (alias ?? inner).toUpperCase();
      const label = annos.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean);
      fields.push({name: fieldName, element: alias ?? inner.split(".").pop(), base: inner.split(".").pop().toUpperCase(), key: isKey,
        ...t.edm, abapType: t.abap, casted: true, label: label ?? fieldName, annotations: annos});
      continue;
    }
    // R11: a literal (`key 1 as CarrierSingletonID`) is a constant element,
    // an aggregate of the singleton root a computed one (cds-computed.mjs)
    if (!srcName) {
      const f = computedElement(el, {children, nodeName, tokensOf, firstDirect, annos, isKey, alias, comps, edmOf,
        computed: isProjection ? undefined : computed});
      if (f?.skip) return {name, skip: f.skip};
      if (f) fields.push(f);
      continue;
    }
    // R10: `_Assoc._Next.Element as X [: localized]`, a calculated element
    // (tools/cds-path.mjs)
    if (srcName.startsWith("_") && srcName.includes(".")) {
      fields.push(pathElement(srcName, alias, annos, tokensOf(el), sqlView));
      continue;
    }
    if (srcName.startsWith("_")) {
      exposedAssociations.push(srcName); associationAnnotations.set(srcName, annos);
      if (redirectOf(tokensOf(el))) redirects.set(srcName, redirectOf(tokensOf(el)));
      continue;
    }
    if (/[()+\-*\/]/.test(srcName) || /^'/.test(srcName)) continue; // expressions: not yet
    const fieldName = (alias ?? srcName.split(".").pop()).toUpperCase();
    let baseField = srcName.split(".").pop().toUpperCase();
    // R11: a constant of the view below stays a constant
    const constant = isProjection ? projected.fields.find((f) => f.name === baseField && f.constant !== undefined) : undefined;
    if (constant) {
      fields.push({...constant, name: fieldName, element: alias ?? srcName.split(".").pop(), key: isKey || constant.key,
        annotations: [...annos, ...(constant.annotations ?? [])], fromElement: constant.name});
      continue;
    }
    const below = isProjection ? projected.fields.find((f) => f.name === baseField && !f.virtual && f.base) : undefined;
    if (isProjection && below === undefined) return {name, skip: `${fieldName}: ${baseField} is no column element of ${projected.name}`};
    if (below) baseField = below.base;
    const t = edmOf(comps.get(baseField));
    // R10: the ABAP type of the column, for a path element that ends here
    const column = comps.get(baseField);
    const typeABAP = below?.typeABAP ?? (column && !/Void|Unknown/.test(column.constructor.name) && !column.containsVoid?.() ? column.toABAP?.() : undefined);
    const label = annos.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean) ?? (below && below.label !== below.name ? below.label : undefined);
    fields.push({name: fieldName, element: alias ?? srcName.split(".").pop(), base: baseField, key: isKey, ...t, typeABAP, label: label ?? fieldName,
      annotations: below ? [...annos, ...(below.annotations ?? [])] : annos, ...(below ? {fromElement: below.name} : {}),
      ...(below?.aggregate ? {aggregate: below.aggregate} : {})});
  }

  const associations = [];
  associations.push(...compositionsOf(find(select, "CDSComposition").map(tokensOf), exposedAssociations));
  for (const a of find(select, "CDSAssociation")) {
    const card = tokensOf(firstDirect(a, "CDSCardinality")).replace(/\s+/g, "");
    // `[1]` is `[0..1]` (R10: a path over it is to-one)
    const m = /\[(\d+)\.\.(\d+|\*)\]/.exec(card) ?? /\[()(\d+|\*)\]/.exec(card)?.map((x, i) => (i === 1 ? "0" : x));
    const toks = namespaced(tokensOf(a));
    const toParent = /\bto\s+parent\s+/i.test(toks); // R5: `parent` is not the target
    const target = /\bto\s+(?:parent\s+)?(\S+)/i.exec(toks)?.[1]?.toUpperCase();
    const alias = /\bas\s+(\S+)\s+on\b/i.exec(toks)?.[1] ?? target;
    const cond = tokensOf(firstDirect(a, "CDSCondition")) ?? "";
    const pairs = [];
    for (const part of cond.split(/\s+and\s+/i)) {
      const pm = /\$projection\s*\.\s*(\w+)\s*=\s*\w+\s*\.\s*(\w+)|(\w+)\s*\.\s*(\w+)\s*=\s*\$projection\s*\.\s*(\w+)/i.exec(part);
      if (pm) pairs.push(pm[1] ? {source: pm[1].toUpperCase(), target: pm[2].toUpperCase()} : {source: pm[5].toUpperCase(), target: pm[4].toUpperCase()});
    }
    // RAP's vocabulary, entered through the CDS annotation (backlog B.2):
    // @ObjectModel.association.type: [#TO_COMPOSITION_CHILD] makes the
    // target a part of this entity rather than a thing it points at, which
    // is what lets a delete take the children with it.
    const assocAnnos = associationAnnotations.get(alias) ?? [];
    const kind = toParent ? "PARENT" : assocAnnos.map((a) => /@ObjectModel\.association\.type:\s*\[?\s*#TO_COMPOSITION_(CHILD|PARENT|ROOT)/i.exec(a)?.[1]).find(Boolean);
    associations.push({alias, target, min: toParent ? "1" : m?.[1] ?? "0", max: toParent ? "1" : m?.[2] ?? "*", pairs, exposed: exposedAssociations.includes(alias),
      composition: kind === undefined ? undefined : kind.toUpperCase()});
  }
  if (isProjection) associations.push(...projectedAssociations(projected, exposedAssociations, redirects, associations));
  const label = viewAnnotations.map((a) => /@EndUserText\.label:\s*'([^']*)'/.exec(a)?.[1]).find(Boolean) ?? name;

  // a writable projection: the view says so (@ObjectModel.writeEnabled, or
  // the finer create/update/delete switches), it reads from one table, and
  // every key column of that table is a field of the view. Anything else
  // (a join, an aggregate, a key that is not exposed) stays read-only, the
  // way SADL refuses to write through a view it cannot map back.
  const flag = (pattern) => viewAnnotations.some((a) => new RegExp(`@ObjectModel\\.${pattern}:\\s*true`, "i").test(a));
  const asked = flag("writeEnabled");
  const isTable = reg.getObject("TABL", source) !== undefined;
  const keyColumns = (table?.listKeys?.(reg) ?? []).map((k) => k.toUpperCase());
  const mapped = new Map(fields.filter((f) => !f.virtual && f.base).map((f) => [f.base.toUpperCase(), f.name]));
  const mandt = comps.has("MANDT");
  const missing = keyColumns.filter((k) => k !== "MANDT" && !mapped.has(k));
  const writable = (asked || flag("createEnabled") || flag("updateEnabled") || flag("deleteEnabled"))
    && isTable && missing.length === 0 && !viewAnnotations.some((a) => /@Analytics\.dataCategory/i.test(a));
  const write = {
    asked: asked || flag("createEnabled") || flag("updateEnabled") || flag("deleteEnabled"),
    writable,
    why: !asked && !flag("createEnabled") && !flag("updateEnabled") && !flag("deleteEnabled") ? "the view does not ask for it"
      : !isTable ? `${source} is not a table`
      : missing.length > 0 ? `the key ${missing.join(", ")} of ${source} is not a field of the view`
      : viewAnnotations.some((a) => /@Analytics\.dataCategory/i.test(a)) ? "an analytical view is read-only"
      : "",
    creatable: asked || flag("createEnabled"),
    updatable: asked || flag("updateEnabled"),
    deletable: asked || flag("deleteEnabled"),
    keyColumns: keyColumns.filter((k) => k !== "MANDT"),
    mandt,
  };
  if (fields.length === 0) return {name, skip: `no field of ${source} could be resolved (is the source a view or table of this tree?)`};
  return {name, sqlView, source, fields, associations, exposedAssociations,
    viewAnnotations, label, write, ...(isProjection ? {projectionOf: projected.name} : {}), ...(computed ? {computed} : {})};
}

/** The fields of the generated SQL view, in order. A CDS SQL view over a
 *  client-dependent table carries the client as its first key field whether
 *  the DDL names it or not (client handling), so a reader of the view can
 *  tell one client's rows from another's; without it a runtime that does
 *  filter by client cannot read the view at all. Named in the DDL, it still
 *  goes first and into the key. The CDS entity itself has no client
 *  (`client: false` for the twin written under the CDS name), as on a system.
 *  One rule, used by the generator and by the CDS check in osd-store. */
export function viewFieldsOf(e, {client = true} = {}) {
  const real = (e.fields ?? []).filter((f) => !f.virtual);
  const isClient = (f) => String(f.base ?? "").toUpperCase() === "MANDT";
  const rest = real.filter((f) => !isClient(f));
  if (!client) return rest;
  const named = real.find(isClient);
  if (e.write?.mandt !== true) return real;
  return [{...(named ?? {name: "MANDT", base: "MANDT"}), key: true}, ...rest];
}

function viewXml(e, options) {
  const dd27 = viewFieldsOf(e, options).map((f) => `    <DD27P>
     <VIEWFIELD>${f.name}</VIEWFIELD>
     <TABNAME>${e.source}</TABNAME>
     <FIELDNAME>${f.base}</FIELDNAME>${f.key ? "\n     <KEYFLAG>X</KEYFLAG>" : ""}
    </DD27P>`).join("\n");
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_VIEW" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD25V>
    <VIEWNAME>${e.sqlView}</VIEWNAME>
    <AS4LOCAL>A</AS4LOCAL>
    <DDLANGUAGE>E</DDLANGUAGE>
    <AGGTYPE>V</AGGTYPE>
    <ROOTTAB>${e.source}</ROOTTAB>
    <DDTEXT>${e.label.replace(/[<>&]/g, "")}</DDTEXT>
    <VIEWCLASS>D</VIEWCLASS>
    <VIEWGRANT>R</VIEWGRANT>
   </DD25V>
   <DD26V_TABLE>
    <DD26V>
     <VIEWNAME>${e.sqlView}</VIEWNAME>
     <TABNAME>${e.source}</TABNAME>
     <TABPOS>0001</TABPOS>
     <FORTABNAME>${e.source}</FORTABNAME>
    </DD26V>
   </DD26V_TABLE>
   <DD27P_TABLE>
${dd27}
   </DD27P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
}

// The composition children a view declares, as the ZIF_STG_CDS_COMPOSITION
// implementation of its source class. A parent implements the interface, a
// view with no #TO_COMPOSITION_CHILD does not, and the SADL DPC asks with a
// cast -- which is why this is a second interface and not more methods on
// ZIF_STG_CDS_SOURCE (five hand-written classes in src/segw implement that
// one).
/** **An association a projection re-exposes belongs to the projection.**
 *
 *  `parseDDLS` reads one view at a time, and a view's associations are the
 *  `association [0..*] to X on ...` clauses it declares itself. A projection
 *  declares none -- it names an element, `_Child`, that the view underneath
 *  declared -- so the element was collected as "exposed" and then had
 *  nothing to be exposed **of**. Measured on a projection of a view with one
 *  association: the base came back with its association and the projection
 *  with none, silently (backlog B.1, the read half).
 *
 *  So it is a pass over all the views rather than a line inside one: the
 *  answer is in a different file, and `parseDDLS` never has two files.
 *
 *  Inherited rather than copied blindly: the source's association keeps its
 *  own `pairs`, because the ON condition is written in the source's column
 *  names and the projection renames nothing it does not select. A projection
 *  that renames a column used in an ON condition is **not** handled, and
 *  says so rather than producing pairs that name a column the target does
 *  not have. */
/**
 * B.1, the write half: a projection of a writable view is writable too.
 *
 * `write.writable` asked for one **table** underneath, so a projection of a
 * view -- the shape the read half just taught to carry associations -- was
 * refused with "<view> is not a table". Correct while nothing composed the
 * mapping, and no longer the whole answer: a projection's field names a
 * field of the view below it, that field names a column, and writing needs
 * the composition of the two.
 *
 * Refusals are by name and each says which link of the chain broke, because
 * "not writable" over a two-level view is a sentence somebody then spends an
 * evening on. What is refused:
 *
 *   the chain does not end at a table          (a view of a view of a view…)
 *   the view below is not itself writable      (its own reason is carried up)
 *   a field names something the view below does not have
 *   a key of the base table is not reachable through the chain
 *
 * The mapping is composed once here rather than at each use, so the
 * generated `to_base` stays one hop: view field -> base column, whatever the
 * depth it came from.
 */
export function resolveWriteChain(views, byName, depth = 8) {
  for (const view of views) {
    const below = byName.get(String(view.source ?? "").toUpperCase());
    if (below === undefined) continue;                  // it selects from a table already
    const w = view.write;
    if (w === undefined || w.asked !== true) continue;  // it never asked to be written

    // walk down, composing the field mapping as we go
    let current = view;
    let mapping = new Map((view.fields ?? []).filter((f) => !f.virtual && f.base)
      .map((f) => [f.name.toUpperCase(), String(f.base).toUpperCase()]));
    let next = below;
    let hops = 0;
    let broke;
    while (next !== undefined && hops < depth) {
      hops += 1;
      if (next.write?.asked !== true) {
        broke = `${next.name} is not written through either (${next.write?.why ?? "it does not ask for it"})`;
        break;
      }
      const theirs = new Map((next.fields ?? []).filter((f) => !f.virtual && f.base)
        .map((f) => [f.name.toUpperCase(), String(f.base).toUpperCase()]));
      const composed = new Map();
      for (const [name, base] of mapping) {
        const deeper = theirs.get(base);
        if (deeper === undefined) {
          broke = `${view.name}.${name} names ${base}, which ${next.name} does not have`;
          break;
        }
        composed.set(name, deeper);
      }
      if (broke !== undefined) break;
      mapping = composed;
      current = next;
      next = byName.get(String(next.source ?? "").toUpperCase());
    }
    if (broke === undefined && next !== undefined) broke = `the chain under ${view.name} is deeper than ${depth} views`;
    if (broke !== undefined) {
      view.write = {...w, writable: false, why: broke};
      continue;
    }
    // `current` is now the last view in the chain, the one that reads a table
    const keys = (current.write?.keyColumns ?? []).map((k) => k.toUpperCase());
    const reachable = new Set(mapping.values());
    const missing = keys.filter((k) => !reachable.has(k));
    if (missing.length > 0) {
      view.write = {...w, writable: false,
        why: `the key ${missing.join(", ")} of ${current.source} is not reachable through ${view.name}`};
      continue;
    }
    // it composes: the projection writes the base table directly, with the
    // mapping flattened, so nothing downstream has to know there was a chain
    view.source = current.source;
    view.fields = (view.fields ?? []).map((f) => (f.virtual || !f.base ? f
      : {...f, base: mapping.get(f.name.toUpperCase()) ?? f.base}));
    view.write = {...w, writable: current.write.writable === true, why: "",
      keyColumns: current.write.keyColumns, mandt: current.write.mandt,
      through: current.name};
  }
  return views;
}

export function inheritAssociations(views, byName) {
  for (const view of views) {
    const source = byName.get(String(view.source ?? "").toUpperCase());
    if (source === undefined) continue;                 // it selects from a table
    for (const name of view.exposedAssociations ?? []) {
      if ((view.associations ?? []).some((a) => a.alias === name)) continue;
      const inherited = (source.associations ?? []).find((a) => a.alias === name);
      if (inherited === undefined) {
        view.unresolvedAssociations = [...(view.unresolvedAssociations ?? []), name];
        continue;
      }
      // A pair's `source` is a column **of the source view**, so the test is
      // on the projection's `base`, not on its `name`: `key TravelId as
      // Journey` gives `base: TRAVELID, name: JOURNEY`, and looking at the
      // name finds nothing. The first version of this check did exactly
      // that and therefore never fired -- a refusal that cannot happen is
      // not a refusal, and its own test said so.
      const renamed = inherited.pairs?.some((pair) => {
        const column = String(pair.source ?? "").toUpperCase();
        const field = (view.fields ?? []).find((f) => String(f.base ?? "").toUpperCase() === column);
        return field !== undefined && String(field.name).toUpperCase() !== column;
      });
      if (renamed === true) {
        view.unresolvedAssociations = [...(view.unresolvedAssociations ?? []), name];
        continue;
      }
      view.associations = [...(view.associations ?? []), {...inherited, inheritedFrom: source.name}];
    }
  }
  return views;
}

function childrenMethod(e, byName) {
  const children = compositionChildren(e, byName);
  if (children.length === 0) return {declare: "", implement: ""};
  const rows = [];
  for (const {a, child} of children) {
    rows.push(`    CLEAR ls_child.
    ls_child-navigation = '${navigationName(a.alias)}'.
    ls_child-view = '${child.name.toUpperCase()}'.`);
    for (const p of a.pairs) {
      rows.push(`    ls_key-parent = '${propertyName(p.source)}'.
    ls_key-child = '${propertyName(p.target)}'.
    APPEND ls_key TO ls_child-keys.`);
    }
    rows.push(`    APPEND ls_child TO rt_children.`);
  }
  return {
    declare: "    INTERFACES zif_stg_cds_composition.\n",
    implement: `
  METHOD zif_stg_cds_composition~children.
* what this entity is made of, from @ObjectModel.association.type
    DATA ls_child TYPE zif_stg_cds_composition=>ty_child.
    DATA ls_key   TYPE zif_stg_cds_composition=>ty_key_pair.

${rows.join("\n")}
  ENDMETHOD.
`,
  };
}

// the exposed associations of e that are parts of it, with their target view
function compositionChildren(e, byName) {
  if (byName === undefined) return [];
  const out = [];
  for (const a of e.associations ?? []) {
    if (a.composition !== "CHILD") continue;
    const child = byName.get(String(a.target ?? "").toUpperCase());
    if (child === undefined || child.source === undefined) continue;
    if ((a.pairs ?? []).length === 0) continue;
    out.push({a, child});
  }
  return out;
}

function sourceClass(e, byName) {
  const cls = classNameOf("zcl_stg_cds_", e.sqlView).toLowerCase();
  const view = e.sqlView.toLowerCase();
  const virtual = e.fields.filter((f) => f.virtual);
  // the row the SADL runtime hands out: the columns of the SQL view plus the
  // virtual elements, which no SELECT fills (an ABAP class does, after the
  // read). A DPC over this entity declares its table as tt_row.
  const rowDecl = `    TYPES: BEGIN OF ty_row.
        INCLUDE TYPE ${view}.
${virtual.length === 0 ? "    TYPES: " : `    TYPES: ${virtual.map((f) => `${f.name.toLowerCase()} TYPE ${f.abapType}`).join(",\n           ")},\n           `}END OF ty_row.
    TYPES tt_row TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
`;
  const writable = e.write?.writable === true;
  const parts = childrenMethod(e, byName);
  // R11: constant elements (cds-computed.mjs)
  const k = constantRead(e);
  return `CLASS ${cls} DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/cds2ddic.mjs from ${e.name} - do not edit
  PUBLIC SECTION.
${rowDecl}    INTERFACES zif_stg_cds_source.
${parts.declare}${k.declare}${writable ? `  PRIVATE SECTION.
    METHODS to_base
      IMPORTING
        is_line       TYPE any
      RETURNING
        VALUE(rs_row) TYPE ${e.source.toLowerCase()}.
` : ""}ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD zif_stg_cds_source~read.
    DATA lv_where TYPE string.
${k.data}    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.

    CREATE DATA rr_data TYPE tt_row.
    ASSIGN rr_data->* TO <lt_data>.

* an empty condition is every row on a system; '1 = 1' in its place is
* CX_SY_DYNAMIC_OSQL_SEMANTICS there (measured on A4H, docs/osql-where.md)
    lv_where = iv_where.
${k.decide}
    IF ${k.fields} IS INITIAL.
      SELECT * FROM ${view}
        INTO CORRESPONDING FIELDS OF TABLE <lt_data>
        WHERE (lv_where)
        ORDER BY (it_orderby).
    ELSE.
      SELECT (${k.fields}) FROM ${view}
        INTO CORRESPONDING FIELDS OF TABLE <lt_data>
        WHERE (lv_where)
        GROUP BY (it_groupby)
        ORDER BY (it_orderby).
    ENDIF.
${k.fill}  ENDMETHOD.
${k.method}
  METHOD zif_stg_cds_source~create_line.
    CREATE DATA rr_line TYPE ty_row.
  ENDMETHOD.

${writeMethods(e, byName)}${parts.implement}
ENDCLASS.
`;
}

// The write side of a CDS entity. A projection the view marked writable and
// that maps back to one table field for field is written through to that
// table; anything else keeps SADL's answer, which is that it cannot.

// A composition child is a part of its parent, so deleting the parent takes
// the children with it (backlog B.2: RAP's vocabulary, declared in the CDS
// annotation). One DELETE per child view, over the child's own base table,
// joined on the pairs the association's ON condition gave us. The parent's
// own DELETE follows, so sy-subrc still answers for the parent.
function cascadeDeletes(e, byName) {
  const children = compositionChildren(e, byName);
  if (children.length === 0) return "";
  const out = [];
  for (const {a, child} of children) {
    const baseOf = (view, name) => (view.fields.find((f) => f.name === String(name).toUpperCase())?.base ?? name).toLowerCase();
    const pairs = (a.pairs ?? []).filter((p) => p.source && p.target);
    out.push(`*   composition: ${child.name} is a part of ${e.name}, so it goes too
    DELETE FROM ${child.source.toLowerCase()}
      WHERE ${pairs.map((p) => `${baseOf(child, p.target)} = ls_row-${baseOf(e, p.source)}`).join("\n        AND ")}.
`);
  }
  return out.join("");
}

function writeMethods(e, byName) {
  const w = e.write ?? {writable: false, why: "the view does not ask for it"};
  const notImpl = (verb) => `  METHOD zif_stg_cds_source~${verb.toLowerCase()}.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
      EXPORTING
        textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
        method = '${verb} through ${e.name}: ${w.why}'.
  ENDMETHOD.
`;
  if (!w.writable) {
    return [notImpl("INSERT"), notImpl("UPDATE"), notImpl("DELETE")].join("\n");
  }
  const tab = e.source.toLowerCase();
  const mapped = e.fields.filter((f) => !f.virtual && f.base);
  const assign = mapped.map((f) => `    ASSIGN COMPONENT '${f.name}' OF STRUCTURE is_line TO <lv_value>.
    IF sy-subrc = 0.
      rs_row-${f.base.toLowerCase()} = <lv_value>.
    ENDIF.`).join("\n");
  const body = (verb, statement) => (w[verb === "INSERT" ? "creatable" : verb === "UPDATE" ? "updatable" : "deletable"]
    ? `  METHOD zif_stg_cds_source~${verb.toLowerCase()}.
    DATA ls_row TYPE ${tab}.

    ls_row = to_base( is_line ).
${statement}
    rv_subrc = sy-subrc.
  ENDMETHOD.
`
    : notImpl(verb));
  return `  METHOD to_base.
* the row of the view mapped back to the row of the table it projects
    FIELD-SYMBOLS <lv_value> TYPE any.

${w.mandt ? "    rs_row-mandt = sy-mandt.\n" : ""}${assign}
  ENDMETHOD.

${body("INSERT", `    INSERT ${tab} FROM ls_row.`)}
${body("UPDATE", `    UPDATE ${tab} FROM ls_row.`)}
${body("DELETE", `${cascadeDeletes(e, byName)}    DELETE FROM ${tab}
      WHERE ${w.keyColumns.map((k) => `${k.toLowerCase()} = ls_row-${k.toLowerCase()}`).join("\n        AND ")}.`)}`;
}


function q(s) { return "'" + String(s ?? "").replaceAll("'", "''") + "'"; }
function bt(s) { return "`" + String(s ?? "").replaceAll("`", "``") + "`"; }

// @OData.publish: true on a CDS view is "this view is a service" — on a
// system it generates <view>_CDS with its MPC/DPC and registers it. Here it
// becomes the same model a stg.yaml describes, with the entity bound to the
// view (SADL delegation); stg-compile then writes the tree, the registration
// objects and the classes, exactly as for a hand-written service.
function publishedYaml(e, byName) {
  const service = `${e.name}_CDS`.toUpperCase();
  // One published view is not one entity: every view its exposed
  // associations reach joins the same service (measured on a system
  // 2026-09-17, docs/cds-publish.md). Breadth first from the annotated
  // view, the visited set is the cycle guard - ZC_STG_BOOKING exposes
  // _Travel straight back at ZC_STG_TRAVEL.
  const reached = [e];
  const seen = new Map([[e.name.toUpperCase(), e]]);
  for (let i = 0; i < reached.length; i++) {
    for (const a of reached[i].associations ?? []) {
      if (a.exposed !== true) continue;
      const target = byName.get(String(a.target ?? "").toUpperCase());
      if (target === undefined || seen.has(target.name.toUpperCase())) continue;
      seen.set(target.name.toUpperCase(), target);
      reached.push(target);
    }
  }
  const lines = [];
  lines.push(`# generated by tools/cds2ddic.mjs from ${e.name} (@OData.publish: true) - do not edit`);
  lines.push(`project: ${service}`);
  lines.push(`service: ${service}`);
  lines.push(`model: ${service}`);
  lines.push(`description: ${JSON.stringify(e.label.slice(0, 60))}`);
  lines.push(`namespace: ${service}`);
  // ZCL_<project>_MPC_EXT would be over 30 characters for most view names;
  // the SQL view name is at most 16 by DDIC rule, so the classes are named
  // after it. The class names are ours: nothing measured says what SAP
  // calls them, and the entity names above are what a client sees.
  lines.push(`classes: {mpc: ${classNameOf("ZCL_", e.sqlView, "_MPC")}, mpc_ext: ${classNameOf("ZCL_", e.sqlView, "_MPC_EXT")}, dpc: ${classNameOf("ZCL_", e.sqlView, "_DPC")}, dpc_ext: ${classNameOf("ZCL_", e.sqlView, "_DPC_EXT")}}`);
  lines.push(`entities:`);
  for (const x of reached) lines.push(...entityLines(x));
  const assocs = reached.flatMap((x) => (x.associations ?? [])
    .filter((a) => a.exposed === true && seen.has(String(a.target ?? "").toUpperCase()))
    .map((a) => ({from: x, to: seen.get(String(a.target).toUpperCase()), a, name: associationName(service, x.name, a.alias)})));
  if (assocs.length > 0) {
    lines.push(`associations:`);
    for (const {from, to, a, name} of assocs) {
      // [0..*] -> 1 to *, [1..1] -> 1 to 1, [0..1] -> 1 to 0..1; the left
      // end is 1 on a system whatever the CDS minimum says
      const right = a.max === "*" ? "N" : a.min === "0" ? "0" : "1";
      lines.push(`  ${name}:`);
      lines.push(`    from: ${entityName(from)}`);
      lines.push(`    to: ${entityName(to)}`);
      lines.push(`    cardinality: "1:${right}"`);
      // the association and its set carry the same name on a system
      lines.push(`    set: ${name}`);
      if ((a.pairs ?? []).length > 0) {
        lines.push(`    constraint: {${a.pairs.map((p) => `${propertyName(p.source)}: ${propertyName(p.target)}`).join(", ")}}`);
      }
      lines.push(`    navigation: {${entityName(from)}: ${navigationName(a.alias)}}`);
    }
  }
  return lines.join("\n") + "\n";
}

// one entity of a published service: bound to the view through SADL, with
// the view's own @ObjectModel switches deciding whether it can be written
function entityLines(e) {
  const lines = [];
  lines.push(`  ${entityName(e)}:`);
  lines.push(`    set: ${setName(e)}`);
  // the model binds to the row of the generated source class, so the virtual
  // elements are part of the structure the DPC hands back
  lines.push(`    source: {cds: ${e.name}, struct: "${classNameOf("ZCL_STG_CDS_", e.sqlView)}=>TY_ROW"}`);
  lines.push(`    keys: [${e.fields.filter((f) => f.key).map((f) => propertyName(f.name)).join(", ")}]`);
  const w = e.write ?? {};
  lines.push(`    creatable: ${w.creatable === true}`);
  lines.push(`    updatable: ${w.updatable === true}`);
  lines.push(`    deletable: ${w.deletable === true}`);
  const ops = ["R", "Q"];
  if (w.creatable) ops.unshift("C");
  if (w.updatable) ops.push("U");
  if (w.deletable) ops.push("D");
  lines.push(`    operations: [${ops.join(", ")}]`);
  lines.push(`    properties:`);
  for (const f of e.fields) {
    const type = f.edm === "Edm.String" ? `String(${f.maxlength || 40})`
      : f.edm === "Edm.Decimal" ? `"Decimal(${f.precision || 15},${f.scale || 0})"`
      : f.edm === "Edm.DateTime" ? "DateTime"
      : f.edm === "Edm.Int64" ? "Int64"
      : f.edm === "Edm.Time" ? "Time"
      : "Int32";
    const label = JSON.stringify(f.label.slice(0, 60));
    const readonly = f.virtual || !(w.creatable || w.updatable) ? ", readonly: true" : f.key ? ", updatable: false" : "";
    lines.push(`      ${propertyName(f.name)}: {type: ${type}, field: ${f.name}${readonly}, label: ${label}${f.virtual ? ", sortable: false, filterable: false" : ""}}`);
  }
  return lines;
}

// the OData names of a published CDS view, measured on a system: the entity
// type is <VIEW>Type and the entity set is the view's own name, no suffix
function entityName(e) {
  return `${e.name.toUpperCase()}Type`;
}

function setName(e) {
  return e.name.toUpperCase();
}

// _Bookings -> to_Bookings: the alias with its leading underscore turned
// into a to_ prefix
function navigationName(alias) {
  return `to_${String(alias).replace(/^_/, "")}`;
}

// assoc_<32 lower-case hex>. A system writes a GUID there, which would be a
// different string on every build; gen/ is an input to the generation hash,
// so the hex is a sha256 of the service, the view the association is written
// on and the alias - the same shape, and reproducible.
function associationName(service, view, alias) {
  return `assoc_${createHash("sha256").update(`${service}|${view}|${alias}`).digest("hex").slice(0, 32)}`;
}

function propertyName(field) {
  return String(field).toUpperCase();
}

function registryClass(entities) {
  let body = "";
  for (const e of entities) {
    body += `
    CLEAR ls_entity.
    ls_entity-name         = ${q(e.name)}.
    ls_entity-sql_view     = ${q(e.sqlView)}.
    ls_entity-source_class = ${q(classNameOf(e.table ? "ZCL_STG_TAB_" : "ZCL_STG_CDS_", e.sqlView))}.
    ls_entity-label        = ${bt(e.label)}.
    ls_entity-creatable    = ${e.write?.creatable && e.write?.writable ? "abap_true" : "abap_false"}.
    ls_entity-updatable    = ${e.write?.updatable && e.write?.writable ? "abap_true" : "abap_false"}.
    ls_entity-deletable    = ${e.write?.deletable && e.write?.writable ? "abap_true" : "abap_false"}.
`;
    for (const a of e.viewAnnotations) body += `    APPEND ${bt(a)} TO ls_entity-annotations.\n`;
    for (const f of e.fields) {
      body += `    CLEAR ls_field.
    ls_field-name      = ${q(f.name)}.
    ls_field-is_key    = ${f.key ? "abap_true" : "abap_false"}.
    ls_field-virtual   = ${f.virtual ? "abap_true" : "abap_false"}.
    ls_field-calculated_by = ${q(f.calculatedBy ?? "")}.
    ls_field-edm_type  = ${q(f.edm)}.
    ls_field-maxlength = ${f.maxlength ?? 0}.
    ls_field-precision = ${f.precision ?? 0}.
    ls_field-scale     = ${f.scale ?? 0}.
    ls_field-label     = ${bt(f.label)}.
`;
      for (const a of f.annotations) body += `    APPEND ${bt(a)} TO ls_field-annotations.\n`;
      body += `    APPEND ls_field TO ls_entity-fields.\n`;
    }
    for (const a of e.associations) {
      body += `    CLEAR ls_assoc.
    ls_assoc-name    = ${q(a.alias)}.
    ls_assoc-target  = ${q(a.target)}.
    ls_assoc-min     = ${q(a.min)}.
    ls_assoc-max     = ${q(a.max)}.
    ls_assoc-exposed = ${a.exposed ? "abap_true" : "abap_false"}.
`;
      for (const p of a.pairs) body += `    CLEAR ls_pair.
    ls_pair-source = ${q(p.source)}.
    ls_pair-target = ${q(p.target)}.
    APPEND ls_pair TO ls_assoc-pairs.
`;
      body += `    APPEND ls_assoc TO ls_entity-associations.\n`;
    }
    body += `    APPEND ls_entity TO gt_entities.\n`;
  }
  return `CLASS zcl_stg_cds_registry DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/cds2ddic.mjs - do not edit. What the SADL exposure and
* DPC know about every CDS entity of this build.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_field,
             name        TYPE string,
             is_key      TYPE abap_bool,
* a virtual element: filled by calculated_by after the read, not by the SELECT
             virtual        TYPE abap_bool,
             calculated_by  TYPE string,
             edm_type    TYPE string,
             maxlength   TYPE i,
             precision   TYPE i,
             scale       TYPE i,
             label       TYPE string,
             annotations TYPE string_table,
           END OF ty_field.
    TYPES tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_pair,
             source TYPE string,
             target TYPE string,
           END OF ty_pair.
    TYPES tt_pair TYPE STANDARD TABLE OF ty_pair WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_assoc,
             name    TYPE string,
             target  TYPE string,
             min     TYPE string,
             max     TYPE string,
             exposed TYPE abap_bool,
             pairs   TYPE tt_pair,
           END OF ty_assoc.
    TYPES tt_assoc TYPE STANDARD TABLE OF ty_assoc WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_entity,
             name         TYPE string,
             sql_view     TYPE string,
             source_class TYPE string,
             label        TYPE string,
* what the view allows (@ObjectModel.writeEnabled and the finer switches):
* SADL writes through a projection only when the view asks for it
             creatable    TYPE abap_bool,
             updatable    TYPE abap_bool,
             deletable    TYPE abap_bool,
             annotations  TYPE string_table,
             fields       TYPE tt_field,
             associations TYPE tt_assoc,
           END OF ty_entity.
    TYPES tt_entity TYPE STANDARD TABLE OF ty_entity WITH DEFAULT KEY.

    CLASS-METHODS entities
      RETURNING
        VALUE(rt_entities) TYPE tt_entity.

    CLASS-METHODS get
      IMPORTING
        iv_name          TYPE string
      RETURNING
        VALUE(rs_entity) TYPE ty_entity.
  PRIVATE SECTION.
    CLASS-DATA gt_entities TYPE tt_entity.
    CLASS-METHODS build.
ENDCLASS.

CLASS zcl_stg_cds_registry IMPLEMENTATION.

  METHOD entities.
    IF gt_entities IS INITIAL.
      build( ).
    ENDIF.
    rt_entities = gt_entities.
  ENDMETHOD.

  METHOD get.
    IF gt_entities IS INITIAL.
      build( ).
    ENDIF.
    READ TABLE gt_entities INTO rs_entity WITH KEY name = to_upper( iv_name ).
    IF sy-subrc <> 0.
      CLEAR rs_entity.
    ENDIF.
  ENDMETHOD.

  METHOD build.
    DATA ls_entity TYPE ty_entity.
    DATA ls_field  TYPE ty_field.
    DATA ls_assoc  TYPE ty_assoc.
    DATA ls_pair   TYPE ty_pair.
${body}
  ENDMETHOD.

ENDCLASS.
`;
}

export function main() {
  const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify({
    global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {},
  })));
  const mains = [];
  // every CDS view and every table of the repository, wherever it lives under src/
  mains.push(...winningByLayer(contentFoldersOf(process.env.OSD_ROOT ?? process.cwd()),
    (folder) => walk(folder).filter((file) => /\.(ddls\.asddls|ddls\.xml|tabl\.xml|dtel\.xml|doma\.xml|ttyp\.xml)$/.test(file)),
    (file) => basename(file).toLowerCase()));
  reg.addFiles(mem(mains));
  // and a library that is not there is SAID, not skipped: the output
  // changes without it, and a generator that shrugs at a missing dependency
  // produces a different system and calls it the same one
  const root = process.env.OSD_ROOT ?? process.cwd();
  const libs = LIBRARIES.map((name) => join(libraryPath(root, name), "src"));
  const absent = libs.filter((l) => !existsSync(l));
  if (absent.length > 0) {
    console.log(`cds2ddic: WARNING ${absent.join(", ")} missing -- types from ${absent.length === 1 ? "it" : "them"} ` +
      "will not resolve, and what this writes is not what a complete tree writes");
  }
  reg.addDependencies(mem(libs.filter(existsSync).flatMap((l) => walk(l))));
  reg.parse();

  mkdirSync(OUT, {recursive: true});
  // What this run writes, so what it does not write can go. gen/ is an input
  // to the build and to the generation hash, so a file left over from another
  // set of inputs is not dead weight, it is a wrong object: a pack taken away
  // left its generated table accessor behind and the next build failed on a
  // table that no longer existed (2026-09-16, backlog E.2).
  const written = new Set();
  const write = (file, contents) => {
    written.add(file);
    writeFileSync(join(OUT, file), contents);
  };
  const entities = [];
  // every view is parsed before anything is written: a published view needs
  // the views its exposed associations reach, and they can be parsed later
  const views = [];
  for (const obj of reg.getObjectsByType("DDLS")) {
    const e = parseDDLS(obj, reg);
    if (!e) continue;
    if (e.skip) { console.log(`cds2ddic: ${e.name}: skipped (${e.skip})`); continue; }
    views.push(e);
  }
  const byName = new Map(views.map((v) => [v.name.toUpperCase(), v]));
  resolveTree(views, byName);
  // R10: a path element that does not resolve is not served (resolvePaths
  // took it out), and the build says which hop broke
  for (const e of views) for (const d of e.droppedPaths ?? []) console.log(`cds2ddic: ${e.name}: path element ${d.name} not served (${d.why})`);
  inheritAssociations(views, byName);
  resolveWriteChain(views, byName);
  // A view that still reads another CDS view (not composed down to a table
  // by resolveWriteChain) would lose the client: the entity it reads carries
  // none, so its rows would reach a reader unfiltered. None exists yet, so
  // it is refused here rather than generated wrong.
  for (const e of [...views]) {
    const below = byName.get(String(e.source ?? "").toUpperCase());
    if (below === undefined) continue;
    let base = below;
    for (let hops = 0; base !== undefined && hops < 8; hops += 1) {
      const next = byName.get(String(base.source ?? "").toUpperCase());
      if (next === undefined) break;
      base = next;
    }
    if (base?.write?.mandt === true) {
      console.log(`cds2ddic: ${e.name}: skipped (it reads the CDS view ${below.name} over a client-dependent table, and the client is not carried through a view of a view yet)`);
      views.splice(views.indexOf(e), 1);
      byName.delete(e.name.toUpperCase());
    }
  }
  for (const e of views) {
    entities.push(e);
    // R11: a singleton root has no SQL view; its source class computes it
    if (e.computed) {
      write(classNameOf("zcl_stg_cds_", e.sqlView).toLowerCase() + ".clas.abap", computedSourceClass(e));
      write(fileOf(e.name) + ".tabl.xml", structureXml(e));
      console.log(`cds2ddic: ${e.name} -> computed (${e.fields.length} fields: ${e.computed.aggregates.map((a) => `${a.fn}( ${a.column} )`).join(", ")} over ${e.computed.table})`);
      continue;
    }
    write(fileOf(e.sqlView) + ".view.xml", viewXml(e));
    // on a system the CDS entity name is a type and a select source of its own
    // (SELECT FROM zc_stg_travel, TYPES x TYPE zc_stg_travel); the SQL view is
    // the technical twin. Both exist here, over the same columns.
    if (e.name.toUpperCase() !== e.sqlView.toUpperCase()) {
      write(fileOf(e.name) + ".view.xml", viewXml({...e, sqlView: e.name.toUpperCase()}, {client: false}));
    }
    write(classNameOf("zcl_stg_cds_", e.sqlView).toLowerCase() + ".clas.abap", sourceClass(e, byName));
    if (e.fields.some((f) => f.path)) write(classNameOf("zcl_stg_cds_", e.sqlView, "_p").toLowerCase() + ".clas.abap", pathClass(e));
    let published = "";
    if (e.viewAnnotations.some((a) => /@OData\.publish:\s*true/i.test(a))) {
      // the whole set of views is needed: an exposed association pulls its
      // target into the same service
      write(e.name.toLowerCase() + "_cds.stg.yaml", publishedYaml(e, byName));
      published = `, published as ${e.name}_CDS`;
    }
    console.log(`cds2ddic: ${e.name} -> ${e.sqlView} (${e.fields.length} fields, ${e.associations.length} associations)${published}`);
  }
  for (const obj of reg.getObjectsByType("TABL")) {
    if (!mains.includes(obj.getFiles()[0].getFilename())) continue; // the repository's own tables, not the libraries'
    // **A structure is not a table.** TABL carries both: TRANSP has rows,
    // INTTAB is a shape with no storage behind it, and reading, inserting or
    // deleting one is meaningless. The generator did not look, so it wrote a
    // source class for every structure in the tree -- and for a KEYLESS one
    // it wrote a `DELETE` with no WHERE, which does not parse and stopped
    // the whole build (2026-09-19, found by adding ZOSD_SQLTRACE_S).
    //
    // The class it wrote for `ZOSD_TEST_ITEM_S` had been there all along and
    // nothing referenced it: an object nobody used, generated from a thing
    // it should not have been generated from, waiting for the first
    // structure without a key.
    const kind = /<TABCLASS>(\w+)<\/TABCLASS>/.exec(
      obj.getFiles().map((f) => f.getRaw()).join("\n"))?.[1];
    if (kind !== undefined && kind !== "TRANSP") {
      console.log(`cds2ddic: ${obj.getName()} is ${kind}, not a table, so nothing is generated for it`);
      continue;
    }
    const t = parseTABL(obj, reg);
    if (!t) continue;
    entities.push(t);
    write(classNameOf("zcl_stg_tab_", t.name).toLowerCase() + ".clas.abap", tableSourceClass(t));
    console.log(`cds2ddic: table ${t.name} (${t.fields.length} fields, keys ${t.fields.filter((f) => f.key).map((f) => f.name).join(",")})`);
  }
  write("zcl_stg_cds_registry.clas.abap", registryClass(entities));
  for (const stale of readdirSync(OUT).filter((f) => written.has(f) === false)) {
    rmSync(join(OUT, stale), {recursive: true, force: true});
    console.log(`cds2ddic: removed ${stale}, nothing generates it any more`);
  }
}
if (basename(process.argv[1] ?? "") === "cds2ddic.mjs") main();
