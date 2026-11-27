import {DYNAMIC_EXPECT, checkDynamicCallOracle} from "./dynamic-call-oracle.mjs";
import {FIND_SUBSTRING_EXPECT, checkFindSubstringOracle} from "./find-substring-oracle.mjs";
import {existsSync, readFileSync, readdirSync} from "node:fs";
import {join} from "node:path";

// Keep copied demo fixtures aligned with the checkout used for measurement.
export function checkDemoCopies(here, home) {
  const demoCopies = readdirSync(join(here, "testdata")).filter((f) => /^zcl_osd_demo_\w+\.clas\.abap$/.test(f)).sort();
  const demoDrift = [];
  for (const f of demoCopies) {
    const theirs = join(home, "src", "demo_data", f);
    if (!existsSync(theirs)) { console.log(`skip copy check ${f}: not in ${home}/src/demo_data`); continue; }
    if (readFileSync(theirs, "utf8") !== readFileSync(join(here, "testdata", f), "utf8")) demoDrift.push(f);
  }
  return demoDrift;
}

export {compileClosedProgram as compileSemantics} from "./frontend-closure.mjs";

// #1012, unmeasured (ABAP type rules): structures that share their component
// names and differ in a component's type are types of their own, as are two
// types of one name in two methods, or in the class and in a method. One
// technical type under two type names stays one type (the last group).
const STRUCT_SHAPE_EXPECT = {ZCL_GOGEN_T_STRUCTSHAPE: "5/11 71/8 ab/abcdefghij 1.75/2 3/4 6/51 cx/self 5/11 5/11 1x/2y ABCD/S900/6"};
export const SEMANTICS_ORACLE_EXPECT = {...DYNAMIC_EXPECT, ...FIND_SUBSTRING_EXPECT, ...STRUCT_SHAPE_EXPECT};
export async function checkSemanticsOracles(selected, home, core, fixtures) {
  await checkDynamicCallOracle(selected, home, core, fixtures);
  await checkFindSubstringOracle(selected, home, core, fixtures);
}
