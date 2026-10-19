// Host guard for the projection's primitive sublanguage. The real syntax scope
// is authoritative; resolve TYPE i in its owning scope before erasing it.
import {abaplint} from "./frontend-base.mjs";
/** @param {import('./frontend-session-types.ts').Registry} reg @param {import('@abaplint/core').Objects.Class} obj @returns {boolean} */
export function builtinDiscoveryIntegers(reg, obj) {
  try {
    const file = obj.getMainABAPFile();
    if (!file) return false;
    let inside = false, spaghetti;
    for (const statement of file.getStatements()) {
      if (statement.get() instanceof abaplint.Statements.MethodImplementation) inside = true;
      if (statement.get() instanceof abaplint.Statements.EndMethod) inside = false;
      if (!inside || !(statement.get() instanceof abaplint.Statements.Data)) continue;
      const words = statement.getTokens().map(t => t.getStr().toUpperCase());
      if (words[0] !== "DATA" || words[2] !== "TYPE" || words[3] !== "I") continue;
      spaghetti ??= new abaplint.SyntaxLogic(reg, obj).run().spaghetti;
      const scope = spaghetti.lookupPosition(statement.getFirstToken().getStart(), file.getFilename());
      if (!(scope?.getData().vars[words[1]]?.getType() instanceof abaplint.BasicTypes.IntegerType)) return false;
    }
    return true;
  } catch { return false; }
}
