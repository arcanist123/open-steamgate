// A candidate boundary, not a discovery certificate. Only method bodies may
// vary. Actual lowering reads in the loaded registry must subsequently agree.
import {suppliedComparison} from "./frontend-analysis.mjs";
import {staticDiscoveryReferences, functionDiscoveryReferences} from "./frontend-discovery-references.mjs";
/** @param {import('@abaplint/core').Nodes.StatementNode[]} statements @param {typeof import('@abaplint/core')} core */
export function methodProjection(statements, core) {
  const retained = [], references = [];
  let method = false, methodName;
  for (const s of statements) {
    const kind = s.get().constructor.name;
    if (["Unknown", "MacroContent", "Define", "Include", "Submit"].includes(kind)) return;
    if (s.get() instanceof core.Statements.MethodImplementation) { method = true; methodName = s.findFirstExpression(core.Expressions.MethodName).concatTokens().toUpperCase(); }
    if (s.get() instanceof core.Statements.EndMethod) method = false;
    if (!method || s.get() instanceof core.Statements.MethodImplementation) retained.push([kind, s.getTokens().map(t => t.getStr())]);
    // These are the same static and FM observations selection expansion reads.
    references.push(...staticDiscoveryReferences(s, core).map(r => ["static", r.owner, r.member]),
      ...functionDiscoveryReferences(s, core).map(n => ["function", n]));
    for (const name of ["ClassName", "InterfaceName", "TypeName", "DatabaseTable", "Dynamic", "ParameterName"]) {
      for (const node of s.findAllExpressions(core.Expressions[name])) {
        const value = node.concatTokens().toUpperCase();
        // Primitive method locals add no discovery provider.
        if (name === "TypeName" && ["I", "INT8", "F", "P", "C", "N", "D", "T", "X", "STRING", "XSTRING", "ABAP_BOOL"].includes(value)) continue;
        references.push([name, value]);
      }
    }
    // Use suppliedMethods' own comparison reader: negation and unrelated
    // predicates affect execution, while discovery reads method + parameter.
    for (const comparison of s.findAllExpressions(core.Expressions.Compare)) {
      const supplied = suppliedComparison(comparison);
      if (supplied) references.push(["supplied", methodName, supplied.name]);
    }
  }
  if (method) return;
  return {retained, references: [...new Set(references.map(r => JSON.stringify(r)))].sort()};
}
