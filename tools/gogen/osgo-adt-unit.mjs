// The ABAP Unit test classes an osgo binary carries for the ADT test runner
// (go/adtunit, docs/osgo-adt-activation.md). osgo.mjs compiles the test
// include of the owners named here and writes zz_unit.go, which registers
// each local test class with its methods, its risk and duration, its source
// lines and the closures that call it. The calls are the ones unit.mjs
// generates for cmd/unit: New_<owner:class>, the method, SETUP/TEARDOWN on
// the instance, CLASS_SETUP/CLASS_TEARDOWN as functions.
import {funcName, typeName} from "./go-symbols.mjs";

// the ADT and ABAP-FS fixture: one passing method, one deliberate failure
export const DEFAULT_OWNERS = ["ZCL_ZOSD_TEST_DEMO"];

/** --unit-owners A,B (or none), else OSGO_UNIT_OWNERS, else the default. */
export function unitOwners(argv = process.argv.slice(2), env = process.env) {
  const i = argv.indexOf("--unit-owners");
  if (i >= 0 && (argv[i + 1] === undefined || argv[i + 1].startsWith("--"))) throw new Error("--unit-owners needs a value");
  const text = i >= 0 ? argv[i + 1] : env.OSGO_UNIT_OWNERS;
  if (text === undefined) return [...DEFAULT_OWNERS];
  const names = String(text).split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  return names.length === 1 && names[0] === "NONE" ? [] : names;
}

const tokenText = (t) => String(t?.getStr?.() ?? t?.str ?? t?.name ?? "");
const rowOf = (at) => at?.getRow?.() ?? at?.row ?? 1;
const colOf = (at) => at?.getCol?.() ?? at?.col ?? 1;
const RISK = {HARMLESS: "harmless", DANGEROUS: "dangerous", CRITICAL: "critical"};
const DURATION = {SHORT: "short", MEDIUM: "medium", LONG: "long"};
const INCLUDES = {locals_def: "definitions", locals_imp: "implementations", macros: "macros", testclasses: "testclasses"};

/** The test classes of the owners that this program compiled, with why the others are not there. */
export function unitClasses(program, owners) {
  const compiled = new Map(program.classes.map((c) => [c.name, c]));
  const classes = [];
  const missing = [];
  for (const owner of owners) {
    const object = program.reg.getObject("CLAS", owner);
    if (object === undefined) { missing.push(`${owner}: not in this program`); continue; }
    for (const file of object.getABAPFiles()) {
      const include = INCLUDES[/\.clas\.([a-z_]+)\.abap$/.exec(file.getFilename())?.[1]] ?? "main";
      const bodies = new Map(file.getInfo().listClassImplementations().map((i) => [i.name.toUpperCase(),
        new Map(i.methods.map((m) => [tokenText(m.token ?? m).toUpperCase(), m.token?.start ?? m.start]))]));
      for (const def of file.getInfo().listClassDefinitions()) {
        if (def.isForTesting !== true || def.isGlobal || def.isAbstract) continue;
        const name = def.name.toUpperCase();
        const key = `${owner}:${name}`;
        const c = compiled.get(key);
        if (c === undefined) { missing.push(`${key}: not compiled`); continue; }
        const has = (m) => c.methods.some((x) => x.name === m);
        const at = def.identifier?.token?.start;
        classes.push({
          owner, name, key, include,
          risk: RISK[String(def.riskLevel ?? "").toUpperCase()] ?? "harmless",
          duration: DURATION[String(def.duration ?? "").toUpperCase()] ?? "short",
          line: rowOf(at), column: colOf(at),
          setup: has("SETUP"), teardown: has("TEARDOWN"), classSetup: has("CLASS_SETUP"), classTeardown: has("CLASS_TEARDOWN"),
          methods: def.methods.filter((m) => m.isForTesting).map((m) => {
            const where = bodies.get(name)?.get(m.name.toUpperCase()) ?? m.identifier?.token?.start;
            const method = m.name.toUpperCase();
            return {name: method, line: rowOf(where), column: colOf(where), compiled: has(method)};
          }),
        });
      }
    }
  }
  return {classes, missing};
}

/** zz_unit.go: unitOwners filled for the classes unitClasses found. */
export function unitGo(classes) {
  const q = JSON.stringify;
  const byOwner = Map.groupBy(classes, (c) => c.owner);
  const entries = [...byOwner].map(([owner, list]) => `\t\t${q(owner)}: {\n${list.map((c) => {
    const T = typeName(c.key);
    const instance = [
      c.setup ? `Setup: func() { t.SETUP(s) }, ` : "",
      c.teardown ? `Teardown: func() { t.TEARDOWN(s) }, ` : "",
      `Methods: map[string]func(){${c.methods.filter((m) => m.compiled).map((m) => `${q(m.name)}: func() { t.${typeName(m.name)}(s) }`).join(", ")}}`,
    ].join("");
    return `\t\t\t{Name: ${q(c.name)}, Include: ${q(c.include)}, Risk: ${q(c.risk)}, Duration: ${q(c.duration)}, Line: ${c.line}, Column: ${c.column},
\t\t\t\tMethods: []adtunit.Method{${c.methods.map((m) => `{Name: ${q(m.name)}, Line: ${m.line}, Column: ${m.column}}`).join(", ")}},
${c.classSetup ? `\t\t\t\tClassSetup: func(step any) { ${funcName(c.key, "CLASS_SETUP")}(step.(*abap.Session)) },\n` : ""}${c.classTeardown ? `\t\t\t\tClassTeardown: func(step any) { ${funcName(c.key, "CLASS_TEARDOWN")}(step.(*abap.Session)) },\n` : ""}\t\t\t\tNew: func(step any) adtunit.Instance { s := step.(*abap.Session); t := New_${T}(s); _ = t; return adtunit.Instance{${instance}} },
\t\t\t},`;
  }).join("\n")}\n\t\t},`).join("\n");
  return `package main

// generated by tools/gogen/osgo.mjs (osgo-adt-unit.mjs): the ABAP Unit test
// classes compiled into this binary for the ADT test runner

import (
\t"osg/gogen/abap"
\t"osg/gogen/adtunit"
)

var _ *abap.Session

func init() {
\tunitOwners = map[string][]adtunit.Class{
${entries}
\t}
}
`;
}
