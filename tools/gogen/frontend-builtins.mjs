// @ts-check
import {Expressions, Unsupported, upper, I, F, P31, S, XS, numeric} from "./frontend-base.mjs";
// Overloaded numeric built-ins, with explicit result types for both emitters.
/**
 * @param {string} name
 * @param {import("@abaplint/core").Nodes.ExpressionNode | undefined} direct
 * @param {import("@abaplint/core").Nodes.ExpressionNode | undefined} named
 * @param {import("./frontend-types.ts").MethodContext} ctx
 * @param {import("./ir.ts").Type | undefined} [calc]
 * @returns {import("./frontend-types.ts").ValueExpr}
 */
// @ts-expect-error -- abapiti form pending
export function builtin(name, direct, named, ctx, api, calc) {
  const {FUNCTIONS, source, convert} = api;
  const kind = FUNCTIONS[name];
  if (name === "BOOLX") {
    const params = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    /** @param {string} key @returns {import("@abaplint/core").Nodes.ExpressionNode | undefined} */
    const get = (key) => params.find((p) => upper(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.ParameterName)).concatTokens()) === key)?.findDirectExpression(Expressions.Source);
    if (!get("BOOL")) throw new Unsupported("BOOLX( ) requires BOOL");
    return {e: "fn", name, args: [convert(source(/** @type {import("./frontend-types.ts").SyntaxNode} */ (get("BOOL")), ctx), S), get("BIT") ? convert(source(/** @type {import("./frontend-types.ts").SyntaxNode} */ (get("BIT")), ctx), I) : {e: "int", value: 0, type: I}], type: XS};
  }
  if (name === "IPOW") {
    const params = named?.findDirectExpressions(Expressions.ParameterS) ?? [];
    /** @param {string} key @returns {import("@abaplint/core").Nodes.ExpressionNode | undefined} */
    const get = (key) => params.find((p) => upper(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.ParameterName)).concatTokens()) === key)?.findDirectExpression(Expressions.Source);
    if (!get("BASE") || !get("EXP")) throw new Unsupported("IPOW( ) requires BASE and EXP");
    const base = source(/** @type {import("./frontend-types.ts").SyntaxNode} */ (get("BASE")), ctx);
    /** @type {Record<string, number>} */ const rank = {i: 0, int8: 1, p: 2, f: 3};
    // Leaf-type discovery has no enclosing hint yet. Character bases start
    // as i (the built-in signature); the later calculation can widen it.
    calc ??= ["c", "n"].includes(base.type.k) ? I : undefined;
    const chosen = calc && (rank[calc.k] ?? -1) > (rank[base.type.k] ?? -1) ? calc : base.type;
    const type = chosen.k === "p" ? P31 : {...chosen};
    delete /** @type {{calculation?: unknown}} */ (type).calculation;
    if (!["i", "int8", "p", "f"].includes(type.k)) throw new Unsupported(`IPOW( ) of a ${type.k}: awaiting A4H oracle`);
    return {e: "fn", name, args: [convert(base, type), convert(source(/** @type {import("./frontend-types.ts").SyntaxNode} */ (get("EXP")), ctx), I)], type};
  }
  if (kind === "max") {
    if (named === undefined) throw new Unsupported(`${name}( ) without val1 / val2`);
    const vals = named.findDirectExpressions(Expressions.ParameterS).map((p) => source(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.Source)), ctx));
    const t = vals.some((v) => v.type.k === "f") ? F : vals.every((v) => v.type.k === "i") ? I : null;
    if (t === null) throw new Unsupported(`${name}( ) over ${vals.map((v) => v.type.k).join(",")}`);
    return {e: "fn", name, args: vals.map((v) => convert(v, t)), type: t};
  }
  const argNode = direct ?? named?.findDirectExpressions(Expressions.ParameterS).find((p) => upper(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.ParameterName)).concatTokens()) === "VAL")?.findDirectExpression(Expressions.Source);
  if (argNode === undefined) throw new Unsupported(`${name}( ) arguments`);
  if (kind === "f") return {e: "fn", name, args: [convert(source(argNode, ctx, F), F)], type: F};
  const arg = source(argNode, ctx);
  // of a p (A4H PDFMT fn:, PDCMP f:): abs( ) and frac( ) keep its type,
  // sign( ) is an i, ceil( ) floor( ) trunc( ) have no decimals (-1.5 gives
  // -1, -2, -1 in a template, -1.0 and -2.0 in a p(8,1))
  if (arg.type.k === "p") {
    if (name === "SIGN") return {e: "fn", name, args: [arg], type: I};
    if (["CEIL", "FLOOR", "TRUNC"].includes(name)) return {e: "fn", name, args: [arg], type: arg.type.calc ? P31 : {k: "p", len: arg.type.len, dec: 0}};
    return {e: "fn", name, args: [arg], type: arg.type};
  }
  if (!numeric(arg.type)) throw new Unsupported(`${name}( ) of a ${arg.type.k}`);
  return {e: "fn", name, args: [arg], type: arg.type};
}
