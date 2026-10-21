// @ts-check
import {append} from "./append.ts";
import {convert, Unsupported} from "./frontend.mjs";

// Registration and RECEIVING conversion share the identities resolved in lowering.
/** @param {Pick<import("./emit-go-types.ts").ProgramInput, "classes" | "dynamicDispatch">} program @returns {Array<NonNullable<import("./emit-go-types.ts").ProgramInput["dynamicDispatch"]>[number] & {cls: import("./emit-go-types.ts").Class; m: import("./emit-go-types.ts").Method}>} */
export function dynamicAdapters(program) {
  const classes = new Map(), methods = new Map();
  for (const cls of /** @type {NonNullable<import("./emit-go-types.ts").ProgramInput["classes"]>} */ (program.classes)) if (!classes.has(cls.name)) classes.set(cls.name, cls);
  return (program.dynamicDispatch ?? []).map((entry) => {
    const cls = classes.get(entry.owner);
    if (!methods.has(cls)) {
      const index = new Map();
      for (const method of [...cls.methods, ...(cls.stubs ?? [])])
        if (!index.has(method.name)) index.set(method.name, method);
      methods.set(cls, index);
    }
    return {...entry, cls, m: methods.get(cls).get(entry.method)};
  });
}

// A missing MOVE conversion becomes an ABAP dynamic-call type error at dispatch.
/** @param {Pick<import("./emit-go-types.ts").ProgramInput, "classes" | "dynamicDispatch">} program @param {string} method @param {import("./ir.ts").Type} target @returns {import("./emit-go-types.ts").DynamicResultMove[]} */
export function dynamicResultMoves(program, method, target) {
  /** @type {import("./emit-go-types.ts").DynamicResultMove[]} */ const moves = [];
  const dynamicDispatch = (program.dynamicDispatch ?? []).filter((entry) => entry.key.endsWith(`=>${method}`));
  for (const {key, m} of dynamicAdapters({classes: program.classes, dynamicDispatch})) {
    if (!m.returning) continue;
    try {
      const value = /** @type {import("./emit-go-types.ts").Expr} */ (convert({e: "dyn_result", type: m.returning.type}, target));
      moves.push({key, type: m.returning.type, value});
    } catch (e) { if (!(e instanceof Unsupported)) throw e; }
  }
  return moves;
}

/** @param {Extract<import("./ir.ts").Stmt, {s: "call_dyn_static"}>} st @param {unknown} ctx @param {string} t @param {Pick<import("./emit-go-types.ts").ProgramInput, "classes" | "dynamicDispatch">} program @param {{expr: (e: unknown, ctx: unknown) => string, stmt: (st: unknown, ctx: unknown, d: number) => string[]}} helpers @returns {string[]} */
export function dynamicCallJs(st, ctx, t, program, {expr, stmt}) {
  const moves = st.receiving ? dynamicResultMoves(program, st.method, /** @type {{type: import("./ir.ts").Type}} */ (st.receiving.target).type) : [];
  const call = `abap.CallStatic(s, ${expr(st.cls, ctx)}, ${JSON.stringify(st.method)}, {${st.args.map((a) => `${JSON.stringify(a.name)}: ${expr(a.value, ctx)}`).join(", ")}}, ${JSON.stringify(st.receiving?.name ?? "")}, ${JSON.stringify(moves.map((m) => m.key))})`;
  if (!st.receiving) return [`${t}${call};`];
  return [`${t}{`, `${t}  const [$dynKey, $dynValue] = ${call};`, `${t}  switch ($dynKey) {`,
    ...moves.flatMap((m) => [`${t}    case ${JSON.stringify(m.key)}: {`,
      ...stmt({s: /** @type {{target: {type: import("./ir.ts").Type}}} */ (st.receiving).target.type.k === "data" ? "set_data" : "assign", target: /** @type {{target: import("./ir.ts").Expr}} */ (st.receiving).target,
        value: m.value}, ctx, 3), `${t}      break; }`]), `${t}  }`, `${t}}`];
}

/**
 * CALL METHOD (class)=>m, as emit-go's staticRegistry: every compiled class is
 * known by name, and each static method a dynamic call names gets an adapter
 * that reads its arguments out of generic data by name.
 */
/** @param {import("./emit-go-types.ts").ProgramInput} program @param {{definable: typeof import("./emit-go.mjs").definable, zero: (t: import("./ir.ts").Type) => string, unwrapTo: (t: import("./ir.ts").Type, d: string) => string, composite: (t: import("./ir.ts").Type) => boolean, expr: (e: unknown, ctx: unknown) => string, typeName: (name: string) => string}} helpers @returns {string[]} */
export function staticRegistryJs(program, {definable, zero, unwrapTo, composite, expr, typeName}) {
  const wanted = program.dynStatics ?? new Set();
  if (wanted.size === 0) return [];
  const out = [`abap.knownClasses(${JSON.stringify(/** @type {NonNullable<import("./emit-go-types.ts").ProgramInput["classes"]>} */ (program.classes).map((c) => c.name))}, ${JSON.stringify([...(program.rtti?.known ?? [])].filter((n) => !n.includes("=>")))});`];
  for (const {key, cls, m, defaults} of dynamicAdapters(program)) {
    if (!m.static || !m.params || !definable(program, m)) continue;
    /** @type {string[]} */ const lines = [];
    const args = m.params.map((p, i) => {
      const v = `v${i}`;
      if (p.dir !== "importing") {
        if (p.dir === "changing" && !p.optional) lines.push(`  abap.paramMissing(${JSON.stringify(`${cls.name}=>${m.name} ${p.name}`)});`);
        lines.push(`  const ${v} = {v: ${zero(p.type)}};`); return v;
      }
      if (p.suppliedOf) { lines.push(`  const ${v} = ${JSON.stringify(p.suppliedOf)} in a ? "X" : "";`); return v; }
      const d = `a[${JSON.stringify(p.name)}]`;
      const read = ["i", "string", "c", "d", "t"].includes(p.type.k) ? unwrapTo(p.type, d)
        : p.type.k === "data" ? d : composite(p.type) && p.byValue ? `abap.copy(${d}.get())` : `${d}.get()`;
      const absent = p.default !== undefined ? expr(/** @type {{name: string, value: unknown}} */ (defaults.find(d => d.name === p.name)).value, {cls, method: m, loop: 0}) : p.optional ? zero(p.type)
        : `abap.paramMissing(${JSON.stringify(`${cls.name}=>${m.name} ${p.name}`)})`;
      lines.push(`  const ${v} = ${JSON.stringify(p.name)} in a ? ${read} : ${absent};`);
      return v;
    });
    append(out, [`abap.registerStatic(${JSON.stringify(key)}, ${JSON.stringify(m.params.filter((p) => p.dir === "importing" && !p.suppliedOf).map((p) => p.name))}, ${JSON.stringify(m.returning?.name ?? "")}, (s, a) => {`], lines, [`  ${m.returning ? "return " : ""}${typeName(cls.name)}.${typeName(m.name)}(${["s", ...args].join(", ")});`, "});"]);
  }
  out.push("");
  return out;
}
