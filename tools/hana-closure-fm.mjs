// Function modules as findings of the closure walk (milestone 4). A static
// `CALL FUNCTION '<name>'` to a module nobody provides is no finding of the
// transpiler at all: it transpiles, and fails at run time with
// CX_SY_DYN_CALL_ILLEGAL_FUNC. On a five-service family 82 modules were
// called and 75 were absent, none of them reported. This module makes them
// findings, structurally (abaplint's CallFunction statement and its
// FunctionName expression, never a text search):
//
// - per iteration, over the structural registry the walk already parsed
//   (the build's file set: island, this tree, the libraries): the literal
//   names the island calls, which of them a function group of the build
//   defines (present), which not (absent), and how many calls name the
//   module dynamically -- closure-summary.json's `function_modules`, and a
//   gap of kind FUNC per absent module (with used_by) in closure-gaps.json;
// - per validation pass of the stub rounds: a synthetic finding per call to
//   an absent module inside an island class method, so the method becomes a
//   stub candidate whose raise says "function module <name> not in the
//   island" -- the stub trace names the module instead of a run-time dump.
//
// The dumper is NOT asked for function groups here: the policy -- fetch the
// group, stub the module, or provide it clean-room -- is decided elsewhere.
// A FUNC gap never enters the request's requested/seen.
import {readFileSync} from "node:fs";
import * as abaplint from "@abaplint/core";

const S = abaplint.Statements;
const E = abaplint.Expressions;
const base = (filename) => String(filename ?? "").split("/").pop();

/** the CALL FUNCTION statements of one parsed ABAP object: [{name, line,
 *  file, dynamic}] -- `name` the upper-cased literal, undefined (and dynamic
 *  true) when the module is named by a variable. Pure over the object. */
export function functionCallsOf(obj) {
  const out = [];
  for (const file of obj?.getABAPFiles?.() ?? []) {
    for (const st of file.getStatements()) {
      if (st.get() instanceof S.CallFunction === false) continue;
      const fname = st.findDirectExpression(E.FunctionName);
      const children = fname?.getChildren() ?? [];
      const constant = children.length === 1 && children[0].get() instanceof E.Constant ? children[0] : undefined;
      const token = constant?.getFirstToken().getStr() ?? "";
      const literal = /^['`]/.test(token) ? token.slice(1, -1).trim().toUpperCase() : undefined;
      out.push({name: literal, line: st.getStart().getRow(), file: base(file.getFilename()), dynamic: literal === undefined});
    }
  }
  return out;
}

/** the function modules the build defines: every FUGR of the registry
 *  (island, tree, libraries), by its modules' names. Pure over the
 *  registry. */
export function definedModules(reg) {
  const names = new Set();
  for (const obj of reg.getObjects()) {
    if (obj.getType() !== "FUGR") continue;
    let modules = [];
    try {
      modules = obj.getModules();
    } catch {
      modules = [];
    }
    for (const m of modules) names.add(String(m.getName()).toUpperCase());
  }
  return names;
}

/** one iteration's function-module facts: the island's calls (an object is
 *  the island's when one of its files is an island basename), the modules
 *  the build defines. Returns {calls, present, absent, dynamic, summary,
 *  gaps}: `summary` is closure-summary.json's `function_modules` ({called,
 *  present, absent, dynamic} counts plus the absent names), `gaps` the FUNC
 *  gaps with used_by. Pure over the registry. */
export function scanFunctionModules(reg, islandFiles) {
  const calls = [];
  for (const obj of reg.getObjects()) {
    if (reg.isDependency(obj) === true) continue;
    const files = obj.getFiles().map((f) => base(f.getFilename()));
    if (files.some((f) => islandFiles.has(f) === true) === false) continue;
    for (const c of functionCallsOf(obj)) if (islandFiles.has(c.file) === true) calls.push({...c, object: obj.getName()});
  }
  const defined = definedModules(reg);
  const called = [...new Set(calls.filter((c) => c.dynamic === false).map((c) => c.name))].sort();
  const present = called.filter((n) => defined.has(n) === true);
  const absent = called.filter((n) => defined.has(n) === false);
  const dynamic = calls.filter((c) => c.dynamic === true);
  const usedBy = (name) => calls.filter((c) => c.name === name)
    .map((c) => ({file: c.file, line: c.line})).sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  const gaps = absent.map((name) => ({name, kind: "FUNC", reason: "function module not in the island (no function group of the build defines it; the dumper is not asked for function groups)",
    first_finding: `function module ${name} not in the island, ${usedBy(name)[0].file}:${usedBy(name)[0].line}`, used_by: usedBy(name)}));
  return {calls, present, absent, dynamic,
    summary: {called: called.length, present: present.length, absent: absent.length, dynamic: dynamic.length,
      by_name: called.map((name) => ({name, present: defined.has(name), used_by: usedBy(name)})),
      dynamic_calls: dynamic.map((c) => ({file: c.file, line: c.line}))},
    gaps};
}

/** the stub pass's findings for the current sources (the stub rounds
 *  rewrite them between passes, so the lines are re-read every pass): one
 *  finding per call to an absent module in an island class file, shaped
 *  like parseFindings' records plus `fm` (the module's name), so the stub
 *  pass can tell it from a transpiler finding. `classPaths` is
 *  islandClassPaths' basename -> paths map; `cache` (a Map) keeps a file's
 *  calls by content across passes. */
export function moduleFindings(classPaths, absent, cache = new Map()) {
  const wanted = new Set(absent);
  if (wanted.size === 0) return [];
  const out = [];
  for (const [basename, paths] of classPaths) {
    for (const path of paths) {
      let source;
      try {
        source = readFileSync(path, "utf8");
      } catch {
        continue;
      }
      // the necessary condition: no keyword, no CALL FUNCTION to find
      if (source.toUpperCase().includes("FUNCTION") === false) continue;
      let calls = cache.get(source);
      if (calls === undefined) {
        const reg = new abaplint.Registry();
        reg.addFile(new abaplint.MemoryFile(basename, source));
        reg.parse();
        calls = reg.getObjects().flatMap((o) => functionCallsOf(o));
        cache.set(source, calls);
      }
      for (const c of calls) {
        if (c.dynamic === true || wanted.has(c.name) === false) continue;
        const message = `function module ${c.name} not in the island`;
        out.push({rule: "closure", message, file: basename, line: c.line, raw: `closure, ${message}, ${basename}:${c.line}`, fm: c.name});
      }
    }
  }
  return out;
}

/** the stub reason of a method whose only findings are calls to absent
 *  modules. Pure. */
export const moduleStubReason = (names) => `function module ${[...new Set(names)].join(", ")} not in the island`;
