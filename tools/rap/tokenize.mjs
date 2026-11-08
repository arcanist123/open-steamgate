import {Position} from '@abaplint/core/build/src/position.js';
import {Identifier} from '@abaplint/core/build/src/abap/1_lexer/tokens/identifier.js';

// Reuse abaplint's position/token substrate. Its CDS lexer splits namespaces,
// loses exact source offsets, and accepts unterminated strings/comments; BDEF
// needs a small scanner to retain exact recovery spans and diagnostics.
export function tokenize(source) {
  const tokens = [];
  let i = 0, line = 1, column = 1;
  const advance = () => { const c = source[i++]; if (c === '\n') { line++; column = 1; } else column++; return c; };
  while (i < source.length) {
    if (/\s/.test(source[i])) { advance(); continue; }
    if (source.startsWith('//', i) || source.startsWith('--', i)) {
      while (i < source.length && source[i] !== '\n') advance();
      continue;
    }
    const start = i, row = line, col = column;
    if (source.startsWith('/*', i)) {
      advance(); advance();
      while (i < source.length && !source.startsWith('*/', i)) advance();
      if (i === source.length) throw new SyntaxError(`Unterminated comment at line ${row}`);
      advance(); advance(); continue;
    }
    if (source[i] === "'" || source[i] === '"') {
      const quote = advance();
      let closed = false;
      while (i < source.length) {
        if (advance() === quote) {
          if (source[i] === quote) { advance(); continue; }
          closed = true; break;
        }
      }
      if (!closed) throw new SyntaxError(`Unterminated string at line ${row}`);
    } else if (/[A-Za-z_$%]/.test(source[i]) || (source[i] === '/' && /[A-Za-z_]/.test(source[i + 1] ?? ''))) {
      const namespaced = source[i] === '/';
      advance();
      while (i < source.length && /[A-Za-z0-9_$%]/.test(source[i])) advance();
      if (namespaced && source[i] === '/' && !source.startsWith('//', i) && !source.startsWith('/*', i)) {
        advance();
        while (i < source.length && /[A-Za-z0-9_$%]/.test(source[i])) advance();
      }
    } else if (/[0-9]/.test(source[i])) {
      while (i < source.length && /[0-9]/.test(source[i])) advance();
    } else if (source.startsWith('..', i)) { advance(); advance(); }
    else advance();
    const value = source.slice(start, i);
    const token = new Identifier(new Position(row, col), value);
    tokens.push({value, lower: value.toLowerCase(), start, end: i, line: row, column: col, token});
  }
  return tokens;
}
