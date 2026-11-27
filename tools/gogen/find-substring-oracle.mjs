import assert from "node:assert/strict";
import {parse} from "acorn";
import {readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";
import {ABAP, MemoryConsole} from "@abaplint/runtime";
import {modulesOf} from "../osd-transpile.mjs";

// Node transpiler/runtime oracle, measured 2026-10-16; SAP unmeasured.
export const FIND_SUBSTRING_EXPECT = {
  ZCL_GOGEN_T_FINDSUB: "plain:0/1/2 first:0/3/2 case:0/3/2 miss:4/99/98 result:0/0/1/2/0 results:0/2 count:0/2 countmiss:4/0 table:0/1/2 section:0/5/2 sectionmiss:4/5/2",
  ZCL_GOGEN_T_FINDSUBBYTE: "plain:0/1 first:0/2 section:0/4 miss:4/99 results:0/2 allmiss:4/0",
  // #989, not a FIND case, checked on Node by the same run: a sign belongs to
  // the operand it stands before, with the priority of a multiplication
  // (keyword documentation, arith_exp); only ** binds tighter. A4H unmeasured.
  ZCL_GOGEN_T_SIGNPRIO: "add:-5,-9,-8 mul:-14,-4,-4,1 plus:9,5 paren:-9,-8,1 lit:1,1,1,1 three:-4,-10,2,1,-13,-1,-13 inner:9,5,10,-13,1,1,-8"
    + " p:-4.75,-9.75,-2.90,0.25,-5.25 f:-5.50,-9.50 i8:-1,-8999999998,-1,2 s:-5,1,-5 const:-5,1,5 if:y,y,3 arg:-5,1 tmpl:-5,1 plain:-4 append:-5 fn:5 cond:-9"
    + " pow:-49,-48,-12,49",
};

export async function checkFindSubstringOracle(selected, home, core, fixtures) {
  const names = Object.keys(FIND_SUBSTRING_EXPECT).filter(n => !selected.length || selected.includes(n.toLowerCase()));
  if (!names.length) return;
  const files = readdirSync(core, {recursive: true}).filter(p => p.endsWith(".xml") && ["dtel", "doma", "tabl", "ttyp"].includes(p.split(".").at(-2)))
    .map(p => ({filename: p.split("/").at(-1), contents: readFileSync(join(core, p), "utf8")}));
  for (const name of names) {
    const n = name.toLowerCase();
    files.push({filename: `${n}.clas.abap`, contents: readFileSync(join(fixtures, `${n}.clas.abap`), "utf8")});
    files.push({filename: `${n}.prog.abap`, contents: `REPORT ${n}. WRITE ${n}=>run( ).`});
  }
  const {Transpiler} = modulesOf(home);
  const output = await new Transpiler({ignoreSyntaxCheck: true, unknownTypes: "runtimeError"}).runRaw(files);
  const saved = globalThis.abap;
  const abap = globalThis.abap = new ABAP({console: new MemoryConsole()});
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  try {
    for (const o of output.objects.filter(o => o.filename.endsWith(".clas.mjs"))) {
      await new AsyncFunction("abap", moduleBody(o.chunk.getCode()))(abap);
    }
    for (const name of names) {
      abap.console.clear();
      const o = output.objects.find(o => o.filename === `${name.toLowerCase()}.prog.mjs`);
      await new AsyncFunction("abap", moduleBody(o.chunk.getCode()))(abap);
      const got = abap.console.get();
      assert.equal(got, FIND_SUBSTRING_EXPECT[name], `Node ${name}`);
      console.log(`ok   Node ${name}: ${got}`);
    }
  } finally { globalThis.abap = saved; }
}

// Remove module wrappers using JS AST ranges, preserving literals and comments.
function moduleBody(code) {
  const edits = parse(code, {ecmaVersion: "latest", sourceType: "module"}).body.flatMap(node =>
    node.type === "ImportDeclaration" ? [[node.start, node.end]]
      : node.type === "ExportNamedDeclaration" && node.declaration ? [[node.start, node.declaration.start]] : []);
  let end = 0, body = "";
  for (const [start, next] of edits) { body += code.slice(end, start); end = next; }
  return body + code.slice(end);
}
