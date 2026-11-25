// The metadata of a CDS entity as the transpiler reads it, for tools/cds2ddic.mjs.
//
// Since abaplint/transpiler#2264 (2.14.38) every DDLS of a build is registered in
// abap.DDIC with its metadata: definition type, annotations as values, fields with
// key / virtual / annotations, associations with target, type, cardinality, ON
// condition, exposed and the exposing element's annotations, redirected targets in
// a projection. cds2ddic runs before the transpile, so it calls the same code the
// handler calls (CDSMetadata, over the registry cds2ddic has already parsed)
// instead of reading the transpile output. One reader of CDS metadata for the
// generator and the runtime.
//
// CDSMetadata is not exported from the package entry, so this imports the
// module file; exporting it is a one-line upstream change (drafted, not sent).
// What #2264 does not give stays in cds2ddic.mjs and its helpers, each place
// marked "not in #2264" (the list is in docs/cds-publish.md).
import transpilerCds from "@abaplint/transpiler/build/src/cds_metadata.js";

const {CDSMetadata} = transpilerCds;
const KNOWN = new Set(["VIEW", "VIEW_ENTITY", "PROJECTION_VIEW", "ABSTRACT_ENTITY", "CUSTOM_ENTITY",
  "TABLE_FUNCTION", "HIERARCHY", "TABLE_ENTITY", "EXTERNAL_ENTITY"]);
const readers = new WeakMap();
// #2264 writes a redirected target as its token text, `/ DMO / C_X` for a
// namespaced one (ANORMALIES cds-metadata-redirect-namespace); a name has no blanks
const nameOf = (target) => String(target).replace(/\s+/g, "").toUpperCase();

/** the #2264 metadata of a DDLS object of `reg` */
export function cdsMetadataOf(obj, reg) {
  let reader = readers.get(reg);
  if (reader === undefined) readers.set(reg, reader = new CDSMetadata(reg));
  const meta = reader.build(obj);
  // CDSMetadata tells the node types apart with instanceof: a registry parsed by
  // another copy of @abaplint/core gives no annotations and no fields, and names
  // the definition by its class. Said, never generated from.
  if (meta !== undefined && !KNOWN.has(meta.definitionType)) {
    throw new Error(`cds2ddic: ${obj.getName()}: the transpiler reads it as ${meta.definitionType}; ` +
      "@abaplint/transpiler resolves another @abaplint/core than this tree (node tools/osd-transpiler-pin.mjs)");
  }
  return meta;
}

/** the value of an annotation, by its dotted name, case-insensitive; written
 *  flat (@A.b.c: v) or as a record (@A: {b: {c: v}}) */
export function annotationValue(annotations, name) {
  const path = name.toLowerCase().split(".");
  for (const a of annotations ?? []) {
    const own = a.name.toLowerCase().split(".");
    if (own.length > path.length || own.some((part, i) => part !== path[i])) continue;
    let value = a.value;
    for (const part of path.slice(own.length)) {
      const key = value !== null && typeof value === "object" && !Array.isArray(value)
        ? Object.keys(value).find((k) => k.toLowerCase() === part) : undefined;
      value = key === undefined ? undefined : value[key];
    }
    if (value !== undefined) return value;
  }
  return undefined;
}

/** @EndUserText.label, when it is a string */
export function labelOf(annotations) {
  const label = annotationValue(annotations, "EndUserText.label");
  return typeof label === "string" && label !== "" ? label : undefined;
}

/** an enum value, #X, or the first of an array of them */
export function enumOf(value) {
  const first = Array.isArray(value) ? value[0] : value;
  return first !== null && typeof first === "object" && typeof first["#"] === "string" ? first["#"] : undefined;
}

/** the field of the metadata an element of the select list is, by its name */
export function metaFieldOf(meta, name) {
  const wanted = String(name ?? "").toUpperCase();
  return wanted === "" ? undefined : (meta?.fields ?? []).find((f) => f.name.toUpperCase() === wanted);
}

/** `$projection.a = _X.b and _X.c = $projection.d` -> [{source: A, target: B}, {source: D, target: C}];
 *  a part of another shape gives no pair */
export function pairsOf(condition) {
  const pairs = [];
  for (const part of String(condition ?? "").split(/\s+and\s+/i)) {
    const pm = /\$projection\s*\.\s*(\w+)\s*=\s*\w+\s*\.\s*(\w+)|(\w+)\s*\.\s*(\w+)\s*=\s*\$projection\s*\.\s*(\w+)/i.exec(part);
    if (pm) pairs.push(pm[1] ? {source: pm[1].toUpperCase(), target: pm[2].toUpperCase()} : {source: pm[5].toUpperCase(), target: pm[4].toUpperCase()});
  }
  return pairs;
}

/** the associations and compositions the view declares itself, in cds2ddic's
 *  record: compositions first, then the associations, each in source order.
 *  CDSMetadata lists the declared ones before those its elements take over from
 *  a source, so they are the first `declared` entries */
export function declaredAssociations(meta, declared) {
  const own = (meta?.associations ?? []).slice(0, declared);
  const record = (a) => {
    const toParent = a.type === "TO_PARENT";
    const upper = nameOf(a.target);
    const kind = toParent ? "PARENT" : a.type === "COMPOSITION" ? "CHILD"
      : /^TO_COMPOSITION_(CHILD|PARENT|ROOT)$/.exec(enumOf(annotationValue(a.annotations, "ObjectModel.association.type")) ?? "")?.[1];
    return {alias: a.name === a.target ? upper : a.name, target: upper,
      min: toParent ? "1" : String(a.cardinality?.min ?? 0), max: toParent ? "1" : String(a.cardinality?.max ?? "*"),
      pairs: pairsOf(a.condition), exposed: a.exposed, composition: kind};
  };
  return [...own.filter((a) => a.type === "COMPOSITION"), ...own.filter((a) => a.type !== "COMPOSITION")].map(record);
}

/** a projection's redirected targets: exposed association -> target, upper case */
export function redirectsOf(meta) {
  return new Map((meta?.associations ?? []).filter((a) => a.exposed).map((a) => [a.name, nameOf(a.target)]));
}
