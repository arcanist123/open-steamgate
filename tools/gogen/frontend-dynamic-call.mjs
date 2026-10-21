// @ts-check
import {Expressions, isTok, isExpr, S, Unsupported, goName} from "./frontend-base.mjs";

// Static dispatch through a run-time class name. Parenthesized literal
// method names share the same adapter as an ordinary identifier; the class
// stays dynamic even when both names happen to be literals.
/**
 * @param {import("@abaplint/core").Nodes.StatementNode} node
 * @param {import("./frontend-types.ts").MethodContext} ctx
 * @param {{sourceOperand: (node: import("./frontend-types.ts").SyntaxNode, ctx: import("./frontend-types.ts").MethodContext) => import("./frontend-types.ts").ValueExpr, source: typeof import("./frontend-expressions-calls.mjs").source, convert: typeof import("./frontend.mjs").convert, lvalue: (node: import("./frontend-types.ts").SyntaxNode, ctx: import("./frontend-types.ts").MethodContext) => import("./frontend-types.ts").ValueExpr}} helpers
 * @returns {Extract<import("./frontend-types.ts").FrontendStmt, {s: "call_dyn_static"}>}
 */
export function dynamicStaticCall(node, ctx, {sourceOperand, source, convert, lvalue}) {
  const text = node.concatTokens();
  const kids = /** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (node.findDirectExpression(Expressions.MethodSource)).getChildren();
  if (kids.length !== 3 || !isTok(kids[1], "=>")) throw new Unsupported(`CALL METHOD form: ${text}`);
  /** @param {import("./frontend-types.ts").SyntaxNode} dynamic */
  const operand = (dynamic) => {
    const inner = dynamic.getChildren().filter((c) => !isTok(c));
    if (inner.length !== 1) throw new Unsupported(`CALL METHOD form: ${text}`);
    return sourceOperand(/** @type {import("./frontend-types.ts").SyntaxNode} */ (inner[0]), ctx);
  };
  const cls = convert(operand(kids[0]), S);
  let method;
  if (isExpr(kids[2], Expressions.AttributeName)) method = kids[2].concatTokens().toUpperCase();
  else if (isExpr(kids[2], Expressions.Dynamic)) {
    const value = operand(kids[2]);
    if (value.e !== "str" && value.e !== "chars") throw new Unsupported(`CALL METHOD with nonliteral dynamic method: ${text}`);
    method = value.value.trimEnd().toUpperCase();
  } else throw new Unsupported(`CALL METHOD form: ${text}`);
  const body = node.findDirectExpression(Expressions.MethodCallBody);
  const mp = body?.findDirectExpression(Expressions.MethodParameters);
  // EXPORTING and RECEIVING are passed by name. The section keywords are direct token
  // children of MethodParameters; a literal 'IMPORTING' in an argument is not.
  const sections = ["IMPORTING", "CHANGING", "EXCEPTIONS"];
  if (mp?.getChildren().some((c) => sections.some((k) => isTok(c, k)))) throw new Unsupported(`CALL METHOD by name with ${mp.concatTokens()}`);
  if (body && !mp) throw new Unsupported(`CALL METHOD form: ${text}`);
  const args = (mp?.findAllExpressions(Expressions.ParameterS) ?? []).map((p) => ({name: /** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.ParameterName)).concatTokens().toUpperCase(),
    value: convert(source(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (p.findDirectExpression(Expressions.Source)), ctx), {k: "data"})}));
  const rp = mp?.findDirectExpression(Expressions.ParameterT);
  const receiving = rp ? {name: /** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (rp.findDirectExpression(Expressions.ParameterName)).concatTokens().toUpperCase(),
    target: lvalue(/** @type {import("@abaplint/core").Nodes.ExpressionNode} */ (rp.findDirectExpression(Expressions.Target)), ctx)} : null;
  for (const name of ["CX_SY_DYN_CALL_ILLEGAL_CLASS", "CX_SY_DYN_CALL_ILLEGAL_METHOD", "CX_SY_DYN_CALL_PARAM_NOT_FOUND", "CX_SY_DYN_CALL_PARAM_MISSING", "CX_SY_DYN_CALL_ILLEGAL_TYPE"]) {
    for (let n = name; n;) {
      const def = ctx.reg.getObject("CLAS", n)?.getDefinition();
      if (!def) break;
      ctx.program.missing.add(n);
      n = /** @type {string} */ (def.getSuperClass()?.toUpperCase());
    }
  }
  ctx.program.dynStatics.add(method);
  return {s: "call_dyn_static", cls, method, args, receiving};
}

// Resolve once during lowering: registration and result conversion consume the
// same called-key -> implementation identity. Defaults must register constants
// before either emitter writes program.consts.
/**
 * @param {import("./frontend-types.ts").FrontendProgram} program
 * @param {{defaultValue: typeof import("./frontend.mjs").defaultValue, aliasTarget: (reg: import("./frontend-session-types.ts").Registry, owner: string, name: string) => string | undefined}} helpers
 */
export function prepareDynamicStatics(program, {defaultValue, aliasTarget}) {
  program.dynamicDispatch = [];
  /** @type {Map<string, import("./frontend-types.ts").FrontendClass>} */ const classes = new Map();
  /** @type {Map<string, Map<string, import("./frontend-types.ts").FrontendMethod | (import("./frontend-types.ts").MethodSignature & {reason: string})>>} */ const statics = new Map();
  for (const cls of program.classes) {
    if (classes.has(cls.name)) continue;
    classes.set(cls.name, cls);
    /** @type {Map<string, import("./frontend-types.ts").FrontendMethod | (import("./frontend-types.ts").MethodSignature & {reason: string})>} */ const methods = new Map();
    for (const method of cls.methods)
      if (method.static && !methods.has(method.name)) methods.set(method.name, method);
    for (const method of /** @type {NonNullable<import("./frontend-types.ts").FrontendClass["stubs"]>} */ (cls.stubs))
      if (/** @type {import("./frontend-types.ts").Signature} */ (method).static && !methods.has(method.name)) methods.set(method.name, method);
    statics.set(cls.name, methods);
  }
  for (const cls of program.classes) for (const method of program.dynStatics) {
    const name = aliasTarget(program.reg, cls.name, method) ?? method;
    let owner = cls.name;
    let impl;
    /** @type {Set<string>} */ const seen = new Set();
    while (owner && !seen.has(owner)) {
      seen.add(owner);
      const c = classes.get(owner);
      impl = statics.get(owner)?.get(name);
      if (impl) break;
      owner = /** @type {string} */ (c?.super);
    }
    if (!impl) continue;
    const saved = [program.currentOwner, program.currentClass, program.currentTypes];
    const defaults = [];
    try {
      program.currentOwner = owner.split(":")[0];
      program.currentClass = goName(owner);
      program.currentTypes = undefined;
      for (const p of /** @type {{params?: readonly import("./frontend-types.ts").FrontendParam[]}} */ (impl).params ?? []) if (p.default !== undefined)
        defaults.push({name: p.name, value: defaultValue(p, {reg: program.reg, program, className: owner})});
    // @ts-expect-error -- abapiti form pending
    } finally { [program.currentOwner, program.currentClass, program.currentTypes] = saved; }
    program.dynamicDispatch.push({key: `${cls.name}=>${method}`, owner, method: name, defaults});
  }
}
