// The commas of a dynamic ORDER BY, put in on the way into any client.
//
// Open SQL separates the columns of an ORDER BY with blanks or with commas:
// `ORDER BY (lv)` with lv = `s~so_id i~so_item_pos` or `a DESCENDING b` is
// legal ABAP, and a SEGW-generated provider builds exactly that from the
// technical order (`CONCATENATE ... SEPARATED BY space`). The pinned
// transpiler emits the string verbatim, and no database client inserts the
// commas SQL needs: HANA answers error 257, SQLite a syntax error, and the
// provider turns either into a business exception (ANORMALIES
// "dynamic-order-by-blanks").
//
// The fix belongs in the transpiler (a local commit adds
// `abap.dynamicOrderBy` there); until the pin carries it, this module puts
// the commas into the **trailing** ORDER BY of a SELECT the runtime hands a
// client. The runtime writes ORDER BY last (UP TO comes before it), so the
// clause runs to the end of the text, or to an UP TO / LIMIT / OFFSET a
// client may have put after it. A clause is changed only when it is a plain
// column list -- no parenthesis, no quote, no PRIMARY KEY -- so a static
// clause, which arrives with its commas and its quoted names, and anything
// this cannot read are passed on untouched.

const DIRECTIONS = new Set(["ASCENDING", "DESCENDING", "ASC", "DESC"]);

/** One clause body (what follows ORDER BY) as a comma-separated list. */
export function orderByList(text) {
  const trimmed = text.trim();
  if (trimmed === "" || /^PRIMARY\s+KEY$/i.test(trimmed) || /[()'"`]/.test(trimmed)) return text;
  const items = [];
  for (const group of trimmed.split(",")) {
    for (const token of group.trim().split(/\s+/)) {
      if (token === "") continue;
      if (DIRECTIONS.has(token.toUpperCase()) && items.length > 0) items[items.length - 1] += ` ${token}`;
      else items.push(token);
    }
  }
  return items.join(", ");
}

/** the offset of the last ` ORDER BY ` outside a single-quoted literal, or -1 */
function lastOrderBy(select) {
  let found = -1;
  let quoted = false;
  const upper = select.toUpperCase();
  for (let i = 0; i < select.length; i++) {
    if (select[i] === "'") {
      quoted = !quoted; // '' inside a literal toggles twice: still inside
      continue;
    }
    if (!quoted && upper.startsWith(" ORDER BY ", i)) found = i;
  }
  return found;
}

/** A whole SELECT with its trailing ORDER BY comma-separated. */
export function orderByWithCommas(select) {
  if (typeof select !== "string") return select;
  const at = lastOrderBy(select);
  if (at < 0) return select;
  const start = at + " ORDER BY ".length;
  const rest = select.slice(start);
  const tail = rest.search(/ (UP TO|LIMIT|OFFSET) /i);
  const body = tail < 0 ? rest : rest.slice(0, tail);
  const list = orderByList(body);
  if (list === body) return select;
  const trailing = body.match(/\s*$/)[0];
  return select.slice(0, start) + list + trailing + (tail < 0 ? "" : rest.slice(tail));
}

/** Wrap a client's `select` so every SELECT passes orderByWithCommas first. */
export function installOrderByCommas(client) {
  if (client === undefined || client.__orderByCommas === true) return client;
  const original = client.select;
  if (typeof original !== "function") return client;
  client.select = function (options = {}) {
    if (typeof options.select !== "string") return original.call(this, options);
    return original.call(this, {...options, select: orderByWithCommas(options.select)});
  };
  client.__orderByCommas = true;
  return client;
}
