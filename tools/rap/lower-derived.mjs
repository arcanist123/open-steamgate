// Lower only token sequences: ABAP comments, literals and templates stay intact.
// Preserve newlines so a source map still names the original source row.
import {Lexer} from "@abaplint/core/build/src/abap/1_lexer/lexer.js";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {MemoryFile} from "@abaplint/core";
export function readRapBindings(root, onRead) {
  const file = join(root, "gen/rap/bindings.json");
  if (!existsSync(file)) return {};
  const bytes = readFileSync(file);
  onRead?.(file, bytes);
  return JSON.parse(bytes.toString("utf8"));
}
export function lowerDerived(source, filename, bindings) {
  if (!filename.endsWith(".abap") || !/\bFOR\b/i.test(source)) return source;
  const allTokens = new Lexer().run(new MemoryFile(filename, source)).tokens;
  const tokens = allTokens.filter(t => t.constructor.name !== "Comment");
  const lines = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lines.push(i + 1);
  const offset = t => lines[t.getStart().getRow() - 1] + t.getStart().getCol() - 1;
  const changes = [];
  const word = i => tokens[i]?.getStr().toUpperCase();
  for (let i = 0; i < tokens.length; i++) {
    if (word(i) !== "TYPE" || !["TABLE", "STRUCTURE", "RESPONSE", "REQUEST"].includes(word(i + 1)) || word(i + 2) !== "FOR") continue;
    let found;
    // Longest binding first: qualified entity/action names consist of several tokens.
    for (let end = i + 3; end < tokens.length && end < i + 18; end++) {
      const slice = tokens.slice(i + 1, end + 1);
      const key = slice.map(t => t.getStr()).join(" ").replace(/\s*([\\~])\s*/g, "$1").toUpperCase();
      if (bindings[key]) found = {end, type: bindings[key]};
      if ([".", ","].includes(word(end))) break;
    }
    if (!found) throw new Error(`${filename}:${tokens[i].getStart().getRow()}: unsupported or unresolved RAP derived type`);
    const start = offset(tokens[i + 1]), end = offset(tokens[found.end]) + tokens[found.end].getStr().length;
    const original = source.slice(start, end);
    const comments = allTokens.filter(t => t.constructor.name === "Comment" && offset(t) >= start && offset(t) < end);
    // Keep comment text on its original line; never move code after an inline comment.
    const rows = original.split("\n").map(() => "");
    rows[0] = found.type;
    for (const comment of comments) rows[comment.getStart().getRow() - tokens[i + 1].getStart().getRow()] += ` ${comment.getStr()}`;
    changes.push({start, end, text: rows.join("\n")}); i = found.end;
  }
  for (const c of changes.reverse()) source = source.slice(0, c.start) + c.text + source.slice(c.end);
  return source;
}
