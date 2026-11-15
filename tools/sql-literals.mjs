import {splitLiterals} from "./osd-sql-literals.mjs";

// Trailing blanks on the way into the database, in one place.
//
// ABAP pads a CHAR to its field length, so the runtime hands over
// `'abc       '` for a CHAR(10) holding `abc`. What a database does with
// that is not a detail: a real system does not keep the blanks -- measured
// on A4H, a CHAR(30) holding '$TMP' answers LENGTH 4 -- and HANA's NCHAR
// does not either.
//
// This function existed **twice**, character for character, in
// tools/duckdb-client.mjs and tools/hana-client.mjs, and not at all in the
// two SQLite clients. So the same ABAP INSERT stored three characters on
// DuckDB and ten on the engine the deployed showcase runs (measured
// 2026-09-19), and the system's own behaviour depended on `STG_DB`.
//
// SQLite got away with it because its columns are declared `COLLATE RTRIM`,
// which makes comparisons ignore the padding. Comparisons were never the
// problem: `LENGTH`, `SUBSTR` and `||` see the blanks, and that is seven of
// the fifteen differences the conformance table measures against HANA.
//
// Two copies of a rule is one rule and one stale opinion -- which is the
// same sentence this tree wrote about a refusal predicate the same day.

/** Trim trailing blanks inside single-quoted literals, quote-aware.
 *
 *  An escaped quote (`''`) is left alone, and nothing outside a literal is
 *  touched: a column name, a keyword and the spacing of the statement mean
 *  what they meant. */
export function trimLiterals(sql) {
  // The literals come from the one scanner (osd-sql-literals.mjs), not from
  // a regular expression: /'((?:[^']|'')*)'/ recursed once per character of
  // a literal and overflowed the stack on a long one (a class source written
  // into a table, abapiti case 038). An unterminated literal is left as it is.
  let out = "";
  for (const {literal, text} of splitLiterals(sql)) {
    if (!literal || text.length < 2 || !text.endsWith("'") || (text.endsWith("''") && !closes(text))) {
      out += text;
      continue;
    }
    let end = text.length - 1;
    while (end > 1 && text[end - 1] === " ") end--;
    out += text.slice(0, end) + "'";
  }
  return out;
}

// whether a literal ending in '' is closed: the quotes after the opening one
// pair up as escapes except the last, so a closed literal has an even count
function closes(text) {
  let n = 0;
  for (let i = text.length - 1; i > 0 && text[i] === "'"; i--) n++;
  return n % 2 === 1;
}

/**
 * Put the same rule on a client we do not own.
 *
 * `@abaplint/database-sqlite` is the default here and the only engine in the
 * browser preview, and it is somebody else's package, so the trimming cannot
 * live inside it. It wraps the four methods Open SQL arrives through and
 * leaves everything else alone -- including the native channel, which must
 * stay untouched because the SQLScript lowering sends its own statements and
 * binds its own values.
 *
 * Applied where every host passes: `test/setup.mjs` is the transpiler's
 * `options.setup`, so the server, the unit run and the preview all go
 * through it. A rule about what every host must do belongs in one module
 * they all reach, not in a comment in the first of them.
 */
export function installTrim(client) {
  if (client === undefined || client.__trimsLiterals === true) return client;
  for (const method of ["insert", "update", "delete"]) {
    const original = client[method];
    if (typeof original !== "function") continue;
    client[method] = function (options = {}) {
      const copy = {...options};
      if (Array.isArray(copy.values)) copy.values = copy.values.map((v) => trimLiterals(String(v)));
      if (Array.isArray(copy.set)) copy.set = copy.set.map((v) => trimLiterals(String(v)));
      if (typeof copy.where === "string") copy.where = trimLiterals(copy.where);
      return original.call(this, copy);
    };
  }
  const execute = client.execute;
  if (typeof execute === "function") {
    client.execute = function (sql) {
      if (Array.isArray(sql)) return execute.call(this, sql.map((s) => (/^\s*INSERT/i.test(s) ? trimLiterals(s) : s)));
      return execute.call(this, typeof sql === "string" && /^\s*INSERT/i.test(sql) ? trimLiterals(sql) : sql);
    };
  }
  Object.defineProperty(client, "__trimsLiterals", {value: true, configurable: true});
  return client;
}
