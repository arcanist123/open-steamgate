// @ts-check
// AST observations shared by selection expansion and the host edit proof.
// Keep spelling and order: discovery's namespace and FM ownership policies
// are intentionally different from ordinary syntax name resolution.
/** @param {import('@abaplint/core').Nodes.StatementNode} statement @param {import('./frontend-session-types.ts').SelectionCore} core */
export function staticDiscoveryReferences(statement, core) {
  const tokens = statement.getTokens(), references = [];
  for (let i = 1; i + 1 < tokens.length; i++) {
    if (tokens[i].getStr() !== "=>" || !(tokens[i - 1] instanceof core.Tokens.Identifier)
        || !(tokens[i + 1] instanceof core.Tokens.Identifier)) continue;
    references.push({owner: /** @type {string} */ (tokens[i - 1].getStr().split("/").at(-1)).toLowerCase(), member: tokens[i + 1].getStr().toUpperCase()});
  }
  return references;
}
/** @param {import('@abaplint/core').Nodes.StatementNode} statement @param {import('./frontend-session-types.ts').SelectionCore} core */
export function functionDiscoveryReferences(statement, core) {
  const tokens = statement.getTokens(), names = [];
  if (statement.get() instanceof core.MacroContent) {
    for (let i = 0; i + 2 < tokens.length; i++) {
      if (tokens[i].getStr().toUpperCase() === "CALL" && tokens[i + 1].getStr().toUpperCase() === "FUNCTION") names.push(tokens[i + 2]);
    }
  } else if (statement.get() instanceof core.Statements.CallFunction && tokens[1]?.getStr().toUpperCase() === "FUNCTION") {
    names.push(statement.findDirectExpression(core.Expressions.FunctionName)?.getFirstToken());
  }
  /** @type {string[]} */ const literals = []; // An explicit loop instead of a narrowing filter.
  for (const name of names) if (name instanceof core.Tokens.StringToken) literals.push(name.getStr());
  return literals.filter(name => name.startsWith("'") && name.endsWith("'") && name.length > 2).map(name => name.slice(1, -1).toUpperCase());
}
