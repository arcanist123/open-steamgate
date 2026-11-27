// The types of CDS elements, for tools/cds2ddic.mjs: the ABAP and OData
// type of a cast( ) (a virtual element, or a cast over a column), and the
// OData type of a resolved abaplint type. Moved out of cds2ddic.mjs as is.

// cast( '' as abap.char( 20 ) ) -> the ABAP type of the virtual element and
// what it is in OData; the handful of types a calculated element uses
export function castType(text) {
  const m = /as\s+abap\s*\.\s*(\w+)\s*(?:\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\))?/i.exec(String(text));
  if (!m) return undefined;
  const kind = m[1].toLowerCase();
  const a = Number(m[2] ?? 0);
  const b = Number(m[3] ?? 0);
  switch (kind) {
    case "char": return {abap: `c LENGTH ${a || 1}`, edm: {edm: "Edm.String", maxlength: a || 1}};
    case "numc": return {abap: `n LENGTH ${a || 1}`, edm: {edm: "Edm.String", maxlength: a || 1}};
    case "sstring": case "string": return {abap: "string", edm: {edm: "Edm.String", maxlength: a || 0}};
    case "int1": case "int2": case "int4": return {abap: "i", edm: {edm: "Edm.Int32"}};
    case "int8": return {abap: "int8", edm: {edm: "Edm.Int64"}};
    case "dats": return {abap: "d", edm: {edm: "Edm.DateTime", precision: 0}};
    case "tims": return {abap: "t", edm: {edm: "Edm.Time"}};
    case "dec": case "curr": case "quan":
      return {abap: `p LENGTH ${Math.floor((a || 15) / 2) + 1} DECIMALS ${b}`, edm: {edm: "Edm.Decimal", precision: a || 15, scale: b}};
    default: return undefined;
  }
}

export function edmOf(type) {
  const n = type?.constructor?.name ?? "VoidType";
  const len = type?.getLength?.() ?? 0;
  switch (n) {
    case "CharacterType": return {edm: "Edm.String", maxlength: len};
    case "NumericType": return {edm: "Edm.String", maxlength: len};
    case "StringType": return {edm: "Edm.String", maxlength: 0};
    case "IntegerType": case "Integer8Type": return {edm: "Edm.Int32", maxlength: 0};
    case "PackedType": return {edm: "Edm.Decimal", precision: len * 2 - 1, scale: type.getDecimals?.() ?? 0};
    case "FloatType": case "DecFloat16Type": case "DecFloat34Type": return {edm: "Edm.Decimal", precision: 34, scale: 0};
    case "DateType": return {edm: "Edm.DateTime", precision: 0};
    case "TimeType": return {edm: "Edm.Time", precision: 0};
    default: return {edm: "Edm.String", maxlength: len};
  }
}
