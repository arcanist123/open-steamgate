// The semantic dependencies of one object of the osgo per-object front-end
// cache: every class, interface and function group its syntax pass resolved
// something in. Part of tools/gogen/osgo-incr.mjs (README
// tools/gogen/osgo-incr.md), carved out of it (the size rule).
//
// What the lowering read (getObject) and what the lowered IR names do not
// cover a type the syntax pass resolved through another object and the IR
// keeps no name of: `TYPE zcl_types=>ty_num`, where ty_num is `TYPE i`,
// lowers to a plain int32 with no trace of zcl_types. Change ty_num to
// string and a user kept from the cache still says int32. abaplint's
// syntax pass records every such resolution as a reference in its scope
// tree, with the identifier it resolved to (and so the file that declares
// it) or, for a class or interface named, its name: that is the dependency.
import {abaplint} from "./frontend-base.mjs";

const upper = (text) => String(text).toUpperCase();
const keyOf = (type, name) => `${type} ${name}`;
const KINDS = new Set(["CLAS", "INTF", "FUGR"]);

/**
 * The object keys ("CLAS X", "INTF Y", "FUGR Z") the syntax pass of one
 * registry object resolved a reference in, or null when that pass cannot be
 * run (then nothing certifies the object's dependencies, and the reader
 * re-lowers it every time).
 * @param {any} reg the registry of the full build
 * @param {string} key the object, "CLAS NAME" / "INTF NAME" / "FUGR NAME"
 * @param {(file: string) => [string, string]} objectOf the owner of a file
 * @returns {Set<string> | null}
 */
export function semanticDeps(reg, key, objectOf) {
  const space = key.indexOf(" ");
  const obj = reg.getObject(key.slice(0, space), key.slice(space + 1));
  if (obj === undefined) return new Set();
  let top;
  try { top = new abaplint.SyntaxLogic(reg, obj).run().spaghetti.getTop(); } catch { return null; }
  const out = new Set();
  const add = (type, name) => { if (KINDS.has(type) && name) out.add(keyOf(type, upper(name))); };
  const visit = (node) => {
    for (const ref of node.getData().references ?? []) {
      const file = ref.resolved?.getFilename?.();
      if (file) add(...objectOf(file));
      const oo = ref.extra?.ooName;
      if (oo) {
        if (ref.extra.ooType === "CLAS" || ref.extra.ooType === "INTF") add(ref.extra.ooType, oo);
        else { add("CLAS", oo); add("INTF", oo); }
      }
    }
    for (const child of node.getChildren()) visit(child);
  };
  try { visit(top); } catch { return null; }
  out.delete(key);
  return out;
}
