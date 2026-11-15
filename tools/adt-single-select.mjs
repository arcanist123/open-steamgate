import {abapSelectToSql} from "./osd-sql-literals.mjs";

// Validate before opening a preview fence or forwarding SQL to another process.
// Delimiters inside SQL strings, identifiers and comments are not statements.
export function singleSelect(sql, refuse) {
  const text = String(sql).trim();
  let out = '', ended = false;
  for (let i = 0; i < text.length;) {
    const c = text[i], next = text[i + 1];
    if (/\s/.test(c)) {out += c; i++; continue;}
    if (c === '-' && next === '-') {
      const end = text.indexOf('\n', i + 2);
      i = end < 0 ? text.length : end; out += ' '; continue;
    }
    if (c === '/' && next === '*') {
      let depth = 1; i += 2;
      while (i < text.length && depth) {
        if (text.slice(i, i + 2) === '/*') {depth++; i += 2;}
        else if (text.slice(i, i + 2) === '*/') {depth--; i += 2;}
        else i++;
      }
      if (depth) throw refuse('unterminated comment');
      out += ' '; continue;
    }
    if (ended) throw refuse(text.slice(i).match(/^\w+/)?.[0] ?? c);
    if (c === ';') {ended = true; i++; continue;}
    const dollar = c === '$' ? /^\$(?:[A-Za-z_]\w*)?\$/.exec(text.slice(i))?.[0] : undefined;
    if (dollar) {
      const end = text.indexOf(dollar, i + dollar.length);
      if (end < 0) throw refuse('unterminated string');
      out += text.slice(i, end + dollar.length); i = end + dollar.length; continue;
    }
    if (["'", '"', '`', '['].includes(c)) {
      const close = c === '[' ? ']' : c;
      const start = i++;
      // PostgreSQL E'...' allows escaped quotes; ordinary SQL uses doubled quotes.
      const escaped = c === "'" && /(?:^|\W)E$/i.test(out);
      while (i < text.length) {
        if (escaped && text[i] === '\\') {i += 2; continue;}
        if (text[i++] === close) {
          if (text[i] === close) {i++; continue;}
          break;
        }
      }
      out += text.slice(start, i); continue;
    }
    out += c; i++;
  }
  out = out.trim();
  if (!/^select\b/i.test(out)) throw refuse(out.split(/\s+/)[0] ?? '');
  return out;
}

export function rewritePreview(sql) {
  return abapSelectToSql(sql, {upTo: false, limitZero: false, substr: true});
}

// SQLite's cursor uses prepare; singleSelect has already checked its tail.
export async function selectSQLiteOne(client, sql, max = 100) {
  const cursor = await client.openCursor({select: rewritePreview(sql)});
  try {
    const rows = [];
    // Published sql.js drops a final partial package; size one retains it.
    while (rows.length < max) {
      const batch = await cursor.fetchNextCursor(1);
      if (!batch.rows?.length) break;
      rows.push(...batch.rows);
    }
    return {rows};
  } finally {await cursor.closeCursor();}
}
