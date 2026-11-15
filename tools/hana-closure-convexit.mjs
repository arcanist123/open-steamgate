// The tables a conversion exit reads, for the closure walk (milestone 3).
//
// A Gateway property with `set_conversion_exit( 'CUNIT' )` is converted by
// this tree's own CONVERSION_EXIT_CUNIT_* (src/cunit), and that module reads
// the unit text table through a dynamic FROM (the twin names its own table
// in tests). A dynamic FROM is a string: the structural pass never sees it,
// so no finding asks for the table. On the bed the table was in the island
// only because a unit help view joins it; a service with a unit-converted
// property and no such help would have built without it -- and, before the
// module raised ZCX_OSD_CONV_TABLE, answered the internal unit key.
//
// Two halves, both read rather than restated:
//   - the trigger: every `set_conversion_exit( ... )` call with a literal
//     exit in an island object, off abaplint's parsed statements (no regex
//     over ABAP) -- the model method the gateway reads the exit from;
//   - the tables: DECLARED below per exit as a CONSTANT of the repo-owned
//     class that reads them, and the constant's VALUE is read from that
//     class's source in the tree being built. The class and its constant are
//     the declaration; this list only says where to look. A constant that is
//     not there fails the run (a renamed constant must not turn the ask off
//     without a word).
// Why a declared list and not the references() pass: the readers are this
// tree's runtime (src/), never island objects, and their table names are
// configurable in tests on purpose -- a static reference to T006A would not
// compile in a tree that does not bundle standard DDIC.
import {readFileSync} from "node:fs";
import {join} from "node:path";
import * as abaplint from "@abaplint/core";

const E = abaplint.Expressions;
const up = (s) => String(s ?? "").toUpperCase();
const kindOf = (node) => node.get().constructor.name;

/** per exit: the repo classes whose constant names a table the exit's
 *  conversion reads (src/cunit: the unit texts; the quantity decimals the
 *  JSON writer reads for the same units) */
export const EXIT_TABLES = {
  CUNIT: [
    {class: "ZCL_OSD_CUNIT", constant: "C_TEXT_TABLE", file: "src/cunit/zcl_osd_cunit.clas.abap"},
    {class: "ZCL_STG_JSON", constant: "C_UNIT_TABLE", file: "src/gateway/zcl_stg_json.clas.abap"},
  ],
};

const METHOD = "SET_CONVERSION_EXIT";

function literalText(str) {
  const s = String(str);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1).replace(/``/g, "`");
  return undefined;
}

/** the literal exits one object sets: [{exit, line}] */
export function conversionExitCalls(obj) {
  const out = [];
  const files = (obj?.getABAPFiles?.() ?? []).filter((f) => /\.testclasses\./.test(String(f.getFilename())) === false);
  for (const file of files) {
    for (const st of file.getStatements()) {
      const calls = [];
      for (const call of st.findAllExpressionsRecursive(E.MethodCall)) {
        calls.push({name: call.findDirectExpression(E.MethodName)?.concatTokens(), node: call});
      }
      if (kindOf(st) === "Call" && st.findDirectExpression(E.MethodSource) !== undefined) {
        const tokens = st.findDirectExpression(E.MethodSource).getTokens().map((t) => t.getStr());
        const arrow = Math.max(tokens.lastIndexOf("->"), tokens.lastIndexOf("=>"));
        const body = st.findDirectExpression(E.MethodCallBody);
        if (body !== undefined) calls.push({name: tokens.slice(arrow + 1).join(""), node: body});
      }
      for (const call of calls) {
        if (up(call.name).split("~").pop() !== METHOD) continue;
        const constant = call.node.findFirstExpression(E.Constant);
        const text = constant === undefined ? undefined : literalText(constant.getFirstToken().getStr());
        if (text !== undefined && text.trim() !== "") out.push({exit: up(text).trim(), line: st.getStart().getRow()});
      }
    }
  }
  return out;
}

/** a CONSTANTS value of one class source, by name; throws when absent */
export function declaredTable(source, declaration) {
  const reg = new abaplint.Registry();
  reg.addFile(new abaplint.MemoryFile(declaration.file.split("/").pop(), source));
  reg.parse();
  for (const obj of reg.getObjects()) {
    for (const file of obj.getABAPFiles?.() ?? []) {
      for (const st of file.getStatements()) {
        if (kindOf(st) !== "Constant") continue;
        if (up(st.findDirectExpression(E.DefinitionName)?.concatTokens()) !== declaration.constant) continue;
        const value = st.findDirectExpression(E.Value)?.findDirectExpression(E.Constant);
        const text = value === undefined ? undefined : literalText(value.getFirstToken().getStr());
        if (text !== undefined && text.trim() !== "") return up(text).trim();
      }
    }
  }
  throw new Error(`hana-closure-convexit: ${declaration.class}=>${declaration.constant} (${declaration.file}) declares no table -- the conversion exit's table cannot be asked for`);
}

/** the asks: [{name, kind: "tabl", finding}] for every table an exit the
 *  island sets reads, once per table; `objects` are the island records
 *  ({object, kind}); `sourceOf(file)` reads a repo source (default: under
 *  root). Exits this tree does not implement ask nothing. */
export function conversionExitAsks(reg, objects, root, sourceOf = (file) => readFileSync(join(root, file), "utf8")) {
  const asks = [];
  const seen = new Set();
  const tables = new Map();
  for (const o of objects) {
    const obj = reg.getObject(o.kind === "INTF" ? "INTF" : "CLAS", o.object);
    for (const call of conversionExitCalls(obj)) {
      const declared = EXIT_TABLES[call.exit];
      if (declared === undefined) continue;
      for (const d of declared) {
        if (tables.has(d.constant + d.class) === false) tables.set(d.constant + d.class, declaredTable(sourceOf(d.file), d));
        const table = tables.get(d.constant + d.class);
        if (seen.has(table) === true) continue;
        seen.add(table);
        asks.push({name: table, kind: "tabl",
          finding: `structural: conversion exit ${call.exit} set in ${o.object} (line ${call.line}) reads ${table} (${d.class}=>${d.constant})`});
      }
    }
  }
  return asks;
}
