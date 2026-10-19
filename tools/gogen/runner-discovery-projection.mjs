// Host-side, fail-closed AST proof. Retain all operations except a deliberately
// classified, reference-free local integer sublanguage. This is stronger than
// comparing only names: lowering can stop at a refusal, add implicit exception
// classes, or change references through inferred types and shadowed variables.
import {staticDiscoveryReferences, functionDiscoveryReferences} from "./frontend-discovery-references.mjs";

/** @param {string} text @returns {boolean} */
const decimal = text => text.length > 0 && [...text].every(c => c >= "0" && c <= "9") && Number(text) <= 2147483647;
/** @param {import("@abaplint/core").Nodes.StatementNode} statement @returns {string[]} */
const wordsOf = statement => statement.getTokens().map(t => t.getStr().toUpperCase());
const harmless = new Set(["+", "-", ".", "(", ")"]);
const comparisons = new Set(["IF", "ELSEIF", "AND", "OR", "NOT", "=", "<>", "<", ">", "<=", ">=", "EQ", "NE", "LT", "GT", "LE", "GE", ".", "(", ")"]);

/**
 * @param {import("@abaplint/core").Nodes.StatementNode[]} statements
 * @param {typeof import("@abaplint/core")} core
 */
export function discoveryProjection(statements, core) {
  if (statements.some(s => ["Unknown", "MacroContent", "Define", "Include", "Submit"].includes(s.get().constructor.name))) return;
  const output = [], references = [];
  let method = [];
  const flush = () => {
    const integerDeclaration = s => {
      const w = wordsOf(s);
      return s.get() instanceof core.Statements.Data && w[0] === "DATA" && w[2] === "TYPE" && w[3] === "I"
        && (w.length === 5 && w[4] === "." || w.length === 7 && w[4] === "VALUE" && decimal(w[5]) && w[6] === ".");
    };
    const candidates = new Set(method.filter(integerDeclaration).map(s => wordsOf(s)[1]));
    const safe = s => {
      const w = wordsOf(s);
      if (integerDeclaration(s)) return true;
      if (["Add", "Subtract"].includes(s.get().constructor.name)) return w.length === 5 && decimal(w[1]) && candidates.has(w[3]) && ["TO", "FROM"].includes(w[2]);
      if (s.get() instanceof core.Statements.Move) return candidates.has(w[0]) && w[1] === "=" && w.slice(2).every(t => candidates.has(t) || decimal(t) || harmless.has(t));
      if (s.get() instanceof core.Statements.If || s.get() instanceof core.Statements.ElseIf)
        return w.slice(1).every(t => candidates.has(t) || decimal(t) || comparisons.has(t));
      return false;
    };
    const escaping = new Set();
    for (const s of method) if (!safe(s)) for (const w of wordsOf(s)) if (candidates.has(w)) escaping.add(w);
    for (const s of method) {
      // Keep control-flow structure and statement order. Only local writes and
      // declarations can be added/removed; comparisons may change operators.
      if (safe(s) && (!(s.get() instanceof core.Statements.Data) || !escaping.has(wordsOf(s)[1]))) {
        if (s.get() instanceof core.Statements.If) output.push(["If", "local-integer-condition"]);
        if (s.get() instanceof core.Statements.ElseIf) output.push(["ElseIf", "local-integer-condition"]);
      } else if (integerDeclaration(s)) output.push(["local-integer", wordsOf(s)[1]]);
      else output.push([s.get().constructor.name, s.getTokens().map(t => t.getStr())]);
    }
    method = [];
  };
  let inside = false;
  for (const s of statements) {
    // Explicit AST names are diagnostic facts as well as part of the proof.
    // Other discovery inputs remain bound by the retained operations below.
    for (const kind of ["ClassName", "InterfaceName", "TypeName", "DatabaseTable", "FunctionName", "Dynamic"]) {
      const expression = core.Expressions[kind];
      if (!expression) continue;
      for (const node of s.findAllExpressions(expression)) {
        const name = node.concatTokens();
        if (kind === "TypeName" && name.toUpperCase() === "I") continue;
        references.push([kind, name]);
      }
    }
    references.push(...staticDiscoveryReferences(s, core).map(r => ["static", r.owner, r.member]),
      ...functionDiscoveryReferences(s, core).map(n => ["function", n]));
    if (s.get() instanceof core.Statements.MethodImplementation) { inside = true; output.push(["method", s.concatTokens()]); continue; }
    if (s.get() instanceof core.Statements.EndMethod) { flush(); inside = false; output.push(["endmethod"]); continue; }
    if (inside) method.push(s);
    else output.push([s.get().constructor.name, s.getTokens().map(t => t.getStr())]);
  }
  if (inside) return;
  return {references: [...new Set(references.map(row => JSON.stringify(row)))].sort(), retained: output};
}
