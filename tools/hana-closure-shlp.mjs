// The search helps a service names, for the closure walk (milestone 3, the
// value-help sets).
//
// A SEGW service's value-help sets read through the /IWBEP/ search-help data
// API: the generated DPC hands the search help's NAME to
// `/iwbep/if_sb_gendpc_shlp_data~get_search_help_values( iv_shlp_name = ... )`
// -- a string, never a type. The structural pass (references(), the
// SyntaxLogic carriers) sees only what the checker cannot resolve, and a
// string resolves, so no finding ever named such a help: measured on the
// bed, of a sample service's eleven value-help sets only the four whose
// helps live in the service's own package reached the island, and the seven
// table / help-view helps outside it answered "no search-help provider".
//
// This module reads the call itself, off abaplint's parsed statements (no
// regex over ABAP): every method call whose method is GET_SEARCH_HELP_VALUES
// -- bare, or qualified by the API interface -- and its IV_SHLP_NAME
// parameter. The argument is
//   - a literal ('X' or `X`)                      -> asked as SHLP;
//   - a constant with a literal value (a local CONSTANTS, the class's own,
//     `zcl_x=>gc_x`, `me->gc_x`)                   -> asked as SHLP;
//   - the implementing method's own IV_SHLP_NAME  -> the forwarder the
//     generator writes into every DPC (it passes the caller's name on to the
//     factory's provider): nothing to ask, nothing to report;
//   - anything else (a variable, a call)           -> "dynamic": reported once
//     per class=>method, never asked -- no name exists before run time.
//
// What a help that ARRIVED needs is followed from its file (followAsks): the
// selection method (a table, or a view when the help's SELMTYPE says so),
// the text table, the included helps and the parameters' data elements;
// and for a view that arrived, its tables. The dumper closes all of that on
// the server already (DD31S, DD32S, DD30L+DD02L, DD26S, DD27S); this is the
// backstop for what it did not deliver: a name already in the island, or
// already resolved by a dump, is never asked again.
import {readdirSync, readFileSync} from "node:fs";
import {join} from "node:path";
import * as abaplint from "@abaplint/core";
import {parseSearchHelp, parseView} from "./segw-shlp.mjs";

const E = abaplint.Expressions;

/** the contract read off the /IWBEP/ interface we implement */
export const SEARCH_HELP_API = {
  interface: "/IWBEP/IF_SB_GENDPC_SHLP_DATA",
  method: "GET_SEARCH_HELP_VALUES",
  parameter: "IV_SHLP_NAME",
};

const kindOf = (node) => node.get().constructor.name;
const up = (s) => String(s ?? "").toUpperCase();

/** whether a parsed method name (`m`, `zif_x~m`) is the API's method */
function isApiMethod(name) {
  const parts = up(name).split("~");
  if (parts[parts.length - 1] !== SEARCH_HELP_API.method) return false;
  return parts.length === 1 || (parts.length === 2 && parts[0] === SEARCH_HELP_API.interface);
}

/** the ParameterS nodes of one call, without descending into a nested call */
function parametersOf(node, out = []) {
  for (const child of node.getChildren?.() ?? []) {
    const k = kindOf(child);
    if (k === "MethodCall" || k === "MethodCallChain") continue;
    if (k === "ParameterS") out.push(child);
    else parametersOf(child, out);
  }
  return out;
}

/** the text of a character literal token, without its quotes */
function literalText(str) {
  const s = String(str);
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  if (s.length >= 2 && s.startsWith("`") && s.endsWith("`")) return s.slice(1, -1).replace(/``/g, "`");
  return undefined;
}

/** a CONSTANTS statement's literal value, by name, among statements */
function constantIn(statements, name) {
  for (const st of statements) {
    if (kindOf(st) !== "Constant") continue;
    const def = st.findDirectExpression(E.DefinitionName)?.concatTokens();
    if (up(def) !== name) continue;
    const value = st.findDirectExpression(E.Value)?.findDirectExpression(E.Constant);
    return value === undefined ? undefined : literalText(value.getFirstToken().getStr());
  }
  return undefined;
}

/** one call's argument as a name, "forward", or undefined (dynamic) */
function argumentName({source, reg, obj, all, local, enclosing, spaghetti, filename}) {
  const children = source.getChildren();
  if (children.length !== 1) return undefined;
  const only = children[0];
  if (kindOf(only) === "Constant") {
    const text = literalText(only.getFirstToken().getStr());
    return text === undefined ? undefined : {name: up(text).trim(), via: "literal"};
  }
  if (kindOf(only) !== "FieldChain") return undefined;
  const tokens = only.getTokens().map((t) => up(t.getStr()));
  // the generated forwarder: the implementing method passes its own
  // IV_SHLP_NAME to the factory's provider
  if (tokens.length === 1 && tokens[0] === SEARCH_HELP_API.parameter && isApiMethod(enclosing)) return "forward";
  // the checker's own resolution first: a read-only identifier with a value
  if (spaghetti !== undefined) {
    try {
      const at = only.getLastToken().getStart();
      const scope = spaghetti.lookupPosition(at, filename);
      for (const ref of scope?.getData().references ?? []) {
        if (ref.position.getStart().equals(at) === false || ref.resolved === undefined) continue;
        const value = ref.resolved.getValue?.();
        const meta = ref.resolved.getMeta?.() ?? [];
        // the checker keeps a constant's value as written, quotes and all
        if (typeof value === "string" && meta.includes("read_only") === true) return {name: up(literalText(value) ?? value).trim(), via: "constant"};
      }
    } catch {
      // no scope here: the statement lookup below stands
    }
  }
  // the statements otherwise (an object whose syntax stops early records no
  // scope for the call): `c`, `me->c`, `<own class>=>c` -- the method's
  // CONSTANTS before the call, then the class's; `zcl_other=>c` -- that
  // class's or interface's definition in the build
  const last = tokens[tokens.length - 1];
  const owner = up(obj.getName());
  const head = tokens.length === 3 && tokens[1] === "=>" ? tokens[0] : tokens.length === 3 && tokens[0] === "ME" && tokens[1] === "->" ? owner : tokens.length === 1 ? owner : undefined;
  if (head === undefined) return undefined;
  if (head === owner) {
    const value = (tokens.length === 1 ? constantIn(local, last) : undefined) ?? constantIn(all, last);
    return value === undefined ? undefined : {name: up(value).trim(), via: "constant"};
  }
  const other = reg.getObject("CLAS", head) ?? reg.getObject("INTF", head);
  if (other === undefined) return undefined;
  const value = constantIn((other.getABAPFiles?.() ?? []).flatMap((f) => f.getStatements()), last);
  return value === undefined ? undefined : {name: up(value).trim(), via: "constant"};
}

/** the search helps one object hands to the API, by file:
 *  Map(basename -> [{name?, line, method, via} | {dynamic: true, line, method}]).
 *  `spaghetti` is the object's scope result when the caller has one (the
 *  structural pass caches it on the object). Pure over the registry. */
export function searchHelpCalls(reg, obj) {
  const result = new Map();
  if (obj === undefined) return result;
  let spaghetti;
  try {
    spaghetti = new abaplint.SyntaxLogic(reg, obj).run().spaghetti;
  } catch {
    spaghetti = undefined;
  }
  const all = (obj.getABAPFiles?.() ?? []).flatMap((f) => f.getStatements());
  for (const file of obj.getABAPFiles?.() ?? []) {
    const base = String(file.getFilename()).split("/").pop();
    const statements = file.getStatements();
    let enclosing;
    let methodStart = 0;
    statements.forEach((st, index) => {
      const k = kindOf(st);
      if (k === "MethodImplementation") {
        enclosing = up(st.findDirectExpression(E.MethodName)?.concatTokens());
        methodStart = index;
        return;
      }
      if (k === "EndMethod") {
        enclosing = undefined;
        return;
      }
      // the functional form and CALL METHOD alike: the method's name node,
      // then the call's own parameters
      const calls = [];
      for (const call of st.findAllExpressionsRecursive(E.MethodCall)) {
        calls.push({name: call.findDirectExpression(E.MethodName)?.concatTokens(), node: call});
      }
      if (k === "Call" && st.findDirectExpression(E.MethodSource) !== undefined) {
        // the method is what follows the source's last arrow
        const tokens = st.findDirectExpression(E.MethodSource).getTokens().map((t) => t.getStr());
        const arrow = Math.max(tokens.lastIndexOf("->"), tokens.lastIndexOf("=>"));
        const body = st.findDirectExpression(E.MethodCallBody);
        if (body !== undefined) calls.push({name: tokens.slice(arrow + 1).join(""), node: body});
      }
      for (const call of calls) {
        if (isApiMethod(call.name) === false) continue;
        const param = parametersOf(call.node)
          .find((p) => up(p.findDirectExpression(E.ParameterName)?.concatTokens()) === SEARCH_HELP_API.parameter);
        if (param === undefined) continue;
        const source = param.findDirectExpression(E.Source);
        const line = st.getStart().getRow();
        const named = source === undefined ? undefined : argumentName({source, reg, obj, all,
          local: statements.slice(methodStart, index), enclosing, spaghetti, filename: file.getFilename()});
        if (named === "forward") continue;
        const list = result.get(base) ?? [];
        list.push(named === undefined || named.name === ""
          ? {dynamic: true, line, method: enclosing ?? ""}
          : {name: named.name, line, method: enclosing ?? "", via: named.via});
        result.set(base, list);
      }
    });
  }
  return result;
}

/** one object file's search-help asks in references()' shape */
export function searchHelpReferences(reg, filename) {
  const base = String(filename ?? "").split("/").pop() ?? "";
  const m = /^(.+?)\.(clas|intf)(?:\.locals_(?:imp|def))?\.abap$/.exec(base);
  if (m === null) return [];
  const name = up(m[1]).replace(/#/g, "/");
  const obj = reg.getObject(m[2] === "clas" ? "CLAS" : "INTF", name);
  return (searchHelpCalls(reg, obj).get(base) ?? []).filter((c) => c.dynamic !== true)
    .map((c) => ({name: c.name, kind: "shlp", line: c.line, level: "method", ...(c.method !== "" ? {method: c.method} : {}), via: "search-help"}));
}

/** the island's search-help names, for the request: every island object
 *  (its record from analyseIsland) read once. Returns {names: [{name, kind:
 *  "shlp", finding}], sites: [{object, method, name}], dynamic: [{object,
 *  method}]} -- names first-named, sites per call, dynamic once per
 *  object=>method. */
export function islandSearchHelps(reg, objects) {
  const names = [];
  const seen = new Set();
  const sites = [];
  const dynamic = new Map();
  for (const o of objects) {
    const obj = reg.getObject(o.kind === "INTF" ? "INTF" : "CLAS", o.object);
    for (const [base, calls] of searchHelpCalls(reg, obj)) {
      for (const c of calls) {
        if (c.dynamic === true) {
          dynamic.set(`${o.object}=>${c.method}`, {object: o.object, method: c.method});
          continue;
        }
        sites.push({object: o.object, method: c.method, name: c.name});
        if (seen.has(c.name) === true) continue;
        seen.add(c.name);
        names.push({name: c.name, kind: "shlp",
          finding: `structural: search help ${c.name} handed to ${SEARCH_HELP_API.method} in ${o.object}=>${c.method} (${c.via}), ${base}:${c.line}`});
      }
    }
  }
  return {names, sites, dynamic: [...dynamic.values()]};
}

const abapBase = (name) => up(name).toLowerCase().replace(/\//g, "#");

/** the island's search-help and view files: Map(object name -> path), per
 *  kind, under gen/hana-src (the layers) and gen/hana-ddic */
export function islandDictionaryFiles(root) {
  const files = {shlp: new Map(), view: new Map()};
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, {withFileTypes: true});
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else {
        const m = /^([^.]+)\.(shlp|view)\.xml$/.exec(entry.name);
        if (m !== null) files[m[2]].set(up(m[1].replace(/^#([^#]+)#/, "/$1/")), join(dir, entry.name));
      }
    }
  };
  walk(join(root, "gen", "hana-src"));
  walk(join(root, "gen", "hana-ddic"));
  return files;
}

// the selection method kinds that are a view (DD30L SELMTYPE: H a help view,
// V a maintenance view, D a database view); T and an empty kind are a table
const VIEW_SELMTYPES = new Set(["H", "V", "D"]);

/** what the arrived helps and views still name: [{name, kind, finding}],
 *  kinds tabl/view/shlp/dtel -- a name the island holds (`islandFiles`, the
 *  basename set) or a dump already resolved (`resolved`, any kind) is not
 *  asked. Reads the files; otherwise pure. */
export function followAsks(root, islandFiles, resolved = new Set()) {
  const {shlp, view} = islandDictionaryFiles(root);
  const out = [];
  const seen = new Set();
  const suffix = {tabl: ".tabl.xml", view: ".view.xml", shlp: ".shlp.xml", dtel: ".dtel.xml"};
  const ask = (name, kind, finding) => {
    const n = up(name).trim();
    if (n === "" || seen.has(n) === true || resolved.has(n) === true) return;
    if (islandFiles.has(abapBase(n) + suffix[kind]) === true) return;
    seen.add(n);
    out.push({name: n, kind, finding});
  };
  for (const [name, path] of shlp) {
    let help;
    try {
      help = parseSearchHelp(readFileSync(path, "utf8"), path);
    } catch {
      continue;
    }
    if (help.selmethod !== "") {
      const asView = VIEW_SELMTYPES.has(help.selmtype) === true;
      ask(help.selmethod, asView === true ? "view" : "tabl", `structural: search help ${name} selects from ${help.selmethod} (SELMTYPE ${help.selmtype || "T"})`);
    }
    if (help.texttab !== "") ask(help.texttab, "tabl", `structural: search help ${name} takes its texts from ${help.texttab}`);
    for (const sub of help.subhelps ?? []) {
      if (up(sub) !== name) ask(sub, "shlp", `structural: search help ${name} includes ${sub}`);
    }
    for (const p of help.parameters) {
      if (p.rollname !== "") ask(p.rollname, "dtel", `structural: search help ${name} parameter ${p.name} is typed ${p.rollname}`);
    }
  }
  for (const [name, path] of view) {
    let parsed;
    try {
      parsed = parseView(readFileSync(path, "utf8"));
    } catch {
      continue;
    }
    for (const t of parsed.tables) ask(t.table, "tabl", `structural: view ${name} reads ${t.table}`);
  }
  return out;
}

/** closure-summary.json's `search_helps`: the names the island hands to the
 *  API (`asked`), those whose .shlp.xml is in the island (`resolved`), the
 *  rest (`missing`), the dynamic call sites (`dynamic`), and every value-help
 *  method of a SEED class whose help is missing (`unserved`: listed, not a
 *  failure -- the set answers "no provider" until its help arrives). Pure. */
export function searchHelpSummary({found, islandFiles, seeds = new Set()}) {
  const asked = found.names.map((n) => n.name);
  const present = (name) => islandFiles.has(abapBase(name) + ".shlp.xml");
  const missing = asked.filter((n) => present(n) === false);
  const unserved = found.sites.filter((s) => seeds.has(s.object) === true && present(s.name) === false)
    .map((s) => ({class: s.object, method: s.method, search_help: s.name}))
    .filter((s, i, all) => all.findIndex((x) => x.class === s.class && x.method === s.method && x.search_help === s.search_help) === i)
    .sort((a, b) => (`${a.class}|${a.method}|${a.search_help}` < `${b.class}|${b.method}|${b.search_help}` ? -1 : 1));
  return {asked: asked.length, resolved: asked.length - missing.length, missing: missing.length,
    dynamic: found.dynamic.length, ...(unserved.length > 0 ? {unserved} : {})};
}
