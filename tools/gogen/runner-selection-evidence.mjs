// Host-side discovery certificates. The original literal proof remains a
// separate special case beside the conservative AST projection.
import {createHash} from "node:crypto";
import {createRequire} from "node:module";
import {localInterfaceNames, currentTypeNames, amcSource} from "./frontend-source-observations.mjs";
import {methodProjection} from "./runner-method-projection.mjs";
import {discoveryProjection} from "./runner-discovery-projection.mjs";
const require = createRequire(import.meta.url);
const digest = (text, kind = "exact-v1") => `${kind}:${createHash("sha256").update(text).digest("hex")}`;
function literalEvidence(name, source) {
  if (!name.toLowerCase().endsWith(".clas.abap") || !source.includes("CONV string(")) return digest(source);
  try {
    const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
    const config = core.Config.getDefault().get();
    config.syntax.version = "v758";
    const reg = new core.Registry(new core.Config(JSON.stringify(config)));
    reg.addFile(new core.MemoryFile(name.split("/").at(-1), source)); reg.parse();
    const statements = [...reg.getObjects()].flatMap(o => o.getABAPFiles().flatMap(f => f.getStatements()));
    if (!statements.length || statements.some(s => ["Unknown", "MacroContent", "Define", "Include"].includes(s.get().constructor.name))) return digest(source);
    const lines = source.split("\n"), offsets = [0];
    for (const line of lines) offsets.push(offsets.at(-1) + line.length + 1);
    const ranges = [];
    let method = false;
    for (const s of statements) {
      if (s.get() instanceof core.Statements.MethodImplementation) method = true;
      if (s.get() instanceof core.Statements.EndMethod) method = false;
      if (!method || !(s.get() instanceof core.Statements.Move)) continue;
      const tokens = s.getTokens(), words = tokens.map(t => t.getStr().toUpperCase());
      if (tokens.length !== 11 || words[0] !== "DATA" || words[1] !== "(" || words[3] !== ")"
          || words[4] !== "=" || words[5] !== "CONV" || words[6] !== "STRING" || words[7] !== "("
          || words[9] !== ")" || words[10] !== "." || !(tokens[8] instanceof core.Tokens.StringTemplate)) continue;
      const token = tokens[8], text = token.getStr();
      // Even escaped interpolation/control sequences are outside this proof.
      if (text.includes("{") || text.includes("}") || text.includes("\\") || text.includes("\n") || text.includes("\r")) continue;
      const start = offsets[token.getStart().getRow() - 1] + token.getStart().getCol() - 1;
      if (source.slice(start, start + text.length) !== text) return digest(source);
      ranges.push([start, start + text.length]);
    }
    // Keep all following token positions stable. SUBMIT normalization embeds
    // source columns in generated local names; width changes are not certified.
    let result = source;
    for (const [start, end] of ranges.reverse()) result = result.slice(0, start) + `|<local-string-value:${end - start}>|` + result.slice(end);
    return digest(JSON.stringify([result, localInterfaceNames(source), currentTypeNames(source), amcSource(source)]), "local-v1");
  } catch { return digest(source); }
}

// Both proofs are persisted. The literal proof remains an independent fast
// path; a broader proof never weakens its equal-width/value-only contract.
/** @param {string} name @param {string} source @param {boolean} allowReferences @returns {string} */
export function discoveryEvidence(name, source, allowReferences = true) {
  const literal = literalEvidence(name, source);
  if (!allowReferences || !name.toLowerCase().endsWith(".clas.abap")) return JSON.stringify([literal]);
  try {
    const core = createRequire(require.resolve("@abaplint/transpiler/package.json"))("@abaplint/core");
    const config = core.Config.getDefault().get(); config.syntax.version = "v758";
    const reg = new core.Registry(new core.Config(JSON.stringify(config)));
    reg.addFile(new core.MemoryFile(name.split("/").at(-1), source)); reg.parse();
    const files = [...reg.getObjects()].flatMap(o => o.getABAPFiles());
    if (files.length !== 1 || !files[0].getStructure()) return JSON.stringify([literal]);
    const projection = discoveryProjection(files[0].getStatements(), core);
    const general = methodProjection(files[0].getStatements(), core);
    const probes = [localInterfaceNames(source), currentTypeNames(source), amcSource(source)];
    return JSON.stringify([literal, projection && !currentTypeNames(source).includes("I") ? digest(JSON.stringify([projection, ...probes]), "references-v1") : null,
      general ? digest(JSON.stringify([general, ...probes]), "method-candidate-v1") : null, general ? source : null]);
  } catch { return JSON.stringify([literal]); }
}
/** @param {string} before @param {string} after @returns {string | undefined} */
export function matchingDiscoveryEvidence(before, after) {
  try {
    const a = JSON.parse(before), b = JSON.parse(after);
    if (!Array.isArray(a) || !Array.isArray(b)) return;
    if (typeof a[0] === "string" && a[0].startsWith("local-v1:") && a[0] === b[0]) return "local-string-initializers";
    if (typeof a[1] === "string" && a[1].startsWith("references-v1:") && a[1] === b[1]) return "discovery-references";
    if (typeof a[2] === "string" && a[2].startsWith("method-candidate-v1:") && a[2] === b[2] && typeof a[3] === "string" && typeof b[3] === "string") return "method-discovery-candidate";
  } catch { /* Older or malformed evidence is a miss. */ }
}
