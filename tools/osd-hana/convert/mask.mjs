// DD03P-MASK for a table field, derived from the dictionary's own facts.
//
// The dump carries DD03L, not the DD03P view, and DD03L has no MASK column;
// DDIC builds it when it reads a table (DDIF_TABL_GET). The rule, checked
// against a private DDIF oracle of a live system (every row agreed):
//
//   MASK = rtrim( "  " + DATATYPE padded to 4 + COMPTYPE + REFTYPE )
//
// two blanks, the dictionary type in positions 3-6, then the component type
// (E data element, S include, L table type, R reference, ...) and, for a
// reference, its kind (D data, O object). Trailing blanks are dropped, the
// two leading ones are part of the value ("  CHAR", "  DEC E", "      S").
//
// DATATYPE comes from the DD03L row; when a row lacks it, from the field's
// data element (DD04L) and then the domain (DD01L) -- the same chain DDIC
// takes. A row with no type at all and no component type has no mask.
import {key} from "./xml.mjs";

/** @param field a DD03L row; @param lookups {dd04l(name) -> row, dd01l(name) -> row} */
export function dd03pMask(field, {dd04l = () => undefined, dd01l = () => undefined} = {}) {
  let datatype = key(field.DATATYPE);
  if (datatype === "") {
    const element = key(field.ROLLNAME) !== "" ? dd04l(key(field.ROLLNAME)) : undefined;
    datatype = key(element?.DATATYPE);
    if (datatype === "") {
      const domain = key(field.DOMNAME) || key(element?.DOMNAME);
      datatype = domain !== "" ? key(dd01l(domain)?.DATATYPE) : "";
    }
  }
  const mask = `  ${datatype.padEnd(4, " ")}${key(field.COMPTYPE)}${key(field.REFTYPE)}`.trimEnd();
  return mask === "" ? undefined : mask;
}
