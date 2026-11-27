// String literals in SQL text, found once, so that no rewrite of the text
// can read them.
//
// Every client here turns the SELECT the runtime hands over into its
// engine's dialect with regular expressions: UP TO n ROWS becomes LIMIT n,
// ~ becomes ., DESCENDING becomes DESC, LIMIT 0 disappears. Run over the
// whole statement, those rewrites reached into the values too, after the
// gateway's escaper had made them safe: 'a~b' was sent as 'a.b',
// 'A EQ B' as 'A = B', 'x LIMIT 0' as 'x', and 'x UP TO 9 ROWS' as 'x'
// with a LIMIT 9 that the value chose (ANORMALIES.md, "SQL literals re-read as
// statement text"). A value is data, so every rewrite runs on the statement
// with its literals masked out, and the literals go back exactly as they
// came.
//
// A literal is single-quoted with '' for a quote inside it. An unterminated
// literal runs to the end of the text and is data as well. The scan is one
// pass with indexOf, never a regular expression over a literal:
// /'((?:[^']|'')*)'/ backtracked per character and overflowed the stack on
// a long value (abapiti case 038).
//
// The same function lives in the pinned runtime (packages/runtime/src/
// sql_literals.ts of oisee/transpiler), where expandDynamic and the
// database packages use it; this is its twin for the clients this
// repository owns and the two published ones it extends
// (test/sql-literals.mjs).

/** The text split into code and literals, in order.
 *  @param {string} sql
 *  @param {string} [quotes] the characters that open a literal
 *  @returns {{literal: boolean, text: string}[]} */
export function splitLiterals(sql, quotes = "'") {
  const segments = [];
  let from = 0;
  let i = 0;
  while (i < sql.length) {
    if (!quotes.includes(sql[i])) { i++; continue; }
    const quote = sql[i];
    let j = i + 1;
    for (;;) {
      j = sql.indexOf(quote, j);
      if (j < 0 || sql[j + 1] !== quote) break;
      j += 2;
    }
    const end = j < 0 ? sql.length : j + 1;
    if (i > from) segments.push({literal: false, text: sql.slice(from, i)});
    segments.push({literal: true, text: sql.slice(i, end)});
    from = end;
    i = end;
  }
  if (from < sql.length) segments.push({literal: false, text: sql.slice(from)});
  return segments;
}

// A placeholder holds no character a rewrite looks for (no blank, no
// keyword, no ~) and is quoted, so a rewrite still sees a value where the
// literal was. The code outside literals is never data, so a placeholder in
// what the rewrite returns is one the masking made.
const PLACEHOLDER = /'\u0000(\d+)\u0000'/g;

/** Runs `rewrite` over the code of `sql` only; every single-quoted literal
 *  comes back verbatim.
 *  @param {string} sql
 *  @param {(code: string) => string} rewrite */
export function outsideLiterals(sql, rewrite) {
  if (!sql.includes("'")) return rewrite(sql);
  const kept = [];
  let masked = "";
  for (const {literal, text} of splitLiterals(sql)) {
    if (literal) {
      masked += "'\u0000" + kept.length + "\u0000'";
      kept.push(text);
    } else {
      masked += text;
    }
  }
  return rewrite(masked).replace(PLACEHOLDER, (_whole, n) => kept[Number(n)]);
}

/** The rewrites every SQL client here applies to a runtime SELECT, on the
 *  code only. `primaryKey` expands ORDER BY PRIMARY KEY (dropped without
 *  it); `substr` translates LEFT( )/RIGHT( ) for SQLite.
 *  @param {string} select
 *  @param {{primaryKey?: string[], substr?: boolean, upTo?: boolean, limitZero?: boolean}} [options] */
export function abapSelectToSql(select, {primaryKey, substr = false, upTo = true, limitZero = true} = {}) {
  return outsideLiterals(select, (s) => {
    if (upTo) s = s.replace(/ UP TO (\d+) ROWS(.*)/i, "$2 LIMIT $1");
    s = primaryKey
      ? s.replace(/ ORDER BY PRIMARY KEY/i, " ORDER BY " + primaryKey.join(", "))
      : s.replace(/ ORDER BY PRIMARY KEY/i, "");
    s = s.replace(/ ASCENDING/ig, " ASC").replace(/ DESCENDING/ig, " DESC").replace(/~/g, ".");
    if (limitZero) s = s.replace(/ LIMIT 0/g, "");
    if (substr) {
      s = s.replace(/\bLEFT\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)/ig, "substr($1, 1, $2)")
        .replace(/\bRIGHT\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)/ig, "substr($1, -$2)");
    }
    return s;
  });
}
