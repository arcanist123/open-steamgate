// @ts-check
// The identity of a structure's layout: what two structures must agree on
// to be one Go (and one JS) type. Component names alone are not it (#1012):
// `a TYPE i, b TYPE c LENGTH 5` and `a TYPE i, b TYPE string` have the same
// names and need two types. The shape therefore spells every component's
// type as far as the generated type depends on it: kind, length and
// decimals of an elementary component (not the name of its type), the row
// and the keys of a table, the target of a reference, a nested structure
// with its own name and components.
//
// Read off abaplint's type alone, with no lowering and no program state, so
// frontend-types-signatures.mjs (which names the type) and
// osgo-incr-anon.mjs (which finds that name again in a new registry) ask
// the same question and get the same answer.
import {BasicTypes, upper} from "./frontend-base.mjs";

/** @typedef {import("@abaplint/core").AbstractType} AbstractType */
/** @typedef {{open: Set<AbstractType>, cyclic: boolean}} Walk */

// instanceof and not constructor.name: a bundle may rename a class
const KINDS = [
  {cls: BasicTypes.CharacterType, tag: "C"}, {cls: BasicTypes.NumericType, tag: "N"}, {cls: BasicTypes.DateType, tag: "D"},
  {cls: BasicTypes.TimeType, tag: "T"}, {cls: BasicTypes.IntegerType, tag: "I"}, {cls: BasicTypes.Integer8Type, tag: "8"},
  {cls: BasicTypes.PackedType, tag: "P"}, {cls: BasicTypes.FloatType, tag: "F"}, {cls: BasicTypes.HexType, tag: "X"},
  {cls: BasicTypes.StringType, tag: "g"}, {cls: BasicTypes.XStringType, tag: "y"}, {cls: BasicTypes.DecFloat16Type, tag: "a"},
  {cls: BasicTypes.DecFloat34Type, tag: "e"}, {cls: BasicTypes.DecFloatType, tag: "decfloat"}, {cls: BasicTypes.UTCLongType, tag: "utcl"},
  {cls: BasicTypes.EnumType, tag: "enum"}, {cls: BasicTypes.GenericObjectReferenceType, tag: "r*"},
  {cls: BasicTypes.AnyType, tag: "any"}, {cls: BasicTypes.DataType, tag: "data"}, {cls: BasicTypes.SimpleType, tag: "simple"},
  {cls: BasicTypes.CGenericType, tag: "C*"}, {cls: BasicTypes.NGenericType, tag: "N*"}, {cls: BasicTypes.XGenericType, tag: "X*"},
  {cls: BasicTypes.PGenericType, tag: "P*"}, {cls: BasicTypes.CLikeType, tag: "clike"}, {cls: BasicTypes.CSequenceType, tag: "cseq"},
  {cls: BasicTypes.XSequenceType, tag: "xseq"}, {cls: BasicTypes.NumericGenericType, tag: "numeric"},
  {cls: BasicTypes.VoidType, tag: "void"}, {cls: BasicTypes.UnknownType, tag: "unknown"},
];

/** the shape of a structure whose walk met no cycle: it depends on the type alone
 *  @type {WeakMap<AbstractType, string>} */
const SHAPES = new WeakMap();

/** @param {readonly string[] | undefined} fields */ const names = (fields) => (fields ?? []).map(upper).join(" ");

/** @param {AbstractType} t @param {Walk} walk @returns {string} */ function typeShape(t, walk) {
  if (t instanceof BasicTypes.StructureType) {
    const q = t.getQualifiedName();
    return `u${q ? `<${upper(q)}>` : ""}{${componentsShape(t, walk)}}`;
  }
  if (t instanceof BasicTypes.TableType) {
    const o = t.getOptions();
    const primary = `${t.getAccessType() ?? ""} ${o.keyType ?? ""} ${o.primaryKey?.isUnique === true ? "U" : ""}(${names(o.primaryKey?.keyFields)})`;
    const secondary = (o.secondary ?? []).map((k) => `;${upper(k.name)} ${upper(k.type ?? "")} ${k.isUnique === true ? "U" : ""}(${names(k.keyFields)})`).join("");
    return `h[${primary}${secondary}]${typeShape(t.getRowType(), walk)}`;
  }
  if (t instanceof BasicTypes.DataReference) return `l(${typeShape(t.getType(), walk)})`;
  if (t instanceof BasicTypes.ObjectReferenceType) return `r<${upper(t.getIdentifierName())}>`;
  const kind = KINDS.find((k) => k.cls !== undefined && t instanceof k.cls)?.tag ?? "?";
  // an elementary component counts by its technical type only: kind, length
  // and decimals where it has them. Not by the name of its type: `TYPE i`
  // and `TYPE ty_int`, or two data elements of one domain, are compatible
  // in ABAP and stay one Go type, as they were (passed by reference, LOOP
  // INTO the other row). The names rttiNamed puts on the field are then
  // those of the structure that named the type first, as before #1012.
  const len = "getLength" in t && typeof t.getLength === "function" ? String(t.getLength()) : "";
  const dec = "getDecimals" in t && typeof t.getDecimals === "function" ? `.${t.getDecimals()}` : "";
  return `${kind}${len}${dec}`;
}

/** @param {AbstractType} t a structure @param {Walk} walk @returns {string} */ function componentsShape(t, walk) {
  const known = SHAPES.get(t);
  if (known !== undefined) return known;
  // a structure reached again below itself: marked, not walked again, and
  // no shape that holds the mark is remembered
  if (walk.open.has(t)) { walk.cyclic = true; return "^"; }
  walk.open.add(t);
  /** @type {Walk} */ const inner = {open: walk.open, cyclic: false};
  /** @type {readonly {name: string, type: AbstractType}[]} */ const comps = "getComponents" in t && typeof t.getComponents === "function" ? t.getComponents() : [];
  const shape = comps.map((c) => `${upper(c.name)}:${c.type ? typeShape(c.type, inner) : "?"}`).join(",");
  walk.open.delete(t);
  if (inner.cyclic) walk.cyclic = true;
  else SHAPES.set(t, shape);
  return shape;
}

/** the shape of a structure: its components in order, each with its type
 *  @param {AbstractType} t a StructureType @returns {string} */
export function structShape(t) {
  return componentsShape(t, {open: new Set(), cyclic: false});
}

/** The name a structure of this shape takes among the structures already
 *  named: `go` itself, or go_V2, go_V3 ... past every structure that has
 *  the name with another shape.
 *  @param {{has(go: string): boolean, get(go: string): {shape?: string} | undefined}} structs @param {string} go @param {string} shape @returns {string} */
export function nameForShape(structs, go, shape) {
  let name = go;
  for (let n = 2; structs.has(name) && structs.get(name)?.shape !== undefined && structs.get(name)?.shape !== shape; n += 1) name = `${name.replace(/_V\d+$/, "")}_V${n}`;
  return name;
}
