// The line of each key and list item of a YAML file, which js-yaml does not
// keep: the DSL tools (tools/dsl-l2.mjs, tools/dsl-l3.mjs) name file:line in
// every refusal through it.

// A path is the keys and 0-based item indexes joined by "/", as
// `forbid/where` or `examples/1/rows/ZTAB/0/field`. Block mappings and block
// sequences are indexed; a flow collection (`[{a: 1}]`) is one line, so what
// is inside it takes the line of the key that holds it (see `lineOf`).
export function lineIndex(text) {
  const index = new Map();
  const stack = [{indent: -1, path: ""}];
  let scalarIndent = -1;
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = i + 1;
    const indent = raw.length - raw.trimStart().length;
    const content = raw.trim();
    if (scalarIndent >= 0) {
      if (content === "" || indent > scalarIndent) return;
      scalarIndent = -1;
    }
    if (content === "" || content.startsWith("#") || content === "---") return;
    let column = indent;
    let rest = raw.slice(indent);
    while (rest === "-" || rest.startsWith("- ")) {
      while (stack.at(-1).indent > column || (stack.at(-1).indent === column && stack.at(-1).item)) stack.pop();
      const parent = stack.at(-1);
      parent.count = parent.itemIndent === column ? parent.count + 1 : 0;
      parent.itemIndent = column;
      const path = `${parent.path}/${parent.count}`;
      if (!index.has(path)) index.set(path, line);
      stack.push({indent: column, path, item: true});
      const after = rest.slice(1);
      const skip = after.length - after.trimStart().length;
      column += 1 + skip;
      rest = after.trimStart();
    }
    const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{[\]}:,][^:#]*?)\s*:(?:\s|$)/.exec(rest);
    if (!key) return;
    const name = key[1].startsWith('"') || key[1].startsWith("'") ? key[1].slice(1, -1) : key[1].trim();
    while (stack.at(-1).indent >= column) stack.pop();
    const path = `${stack.at(-1).path}/${name}`;
    if (!index.has(path)) index.set(path, line);
    stack.push({indent: column, path});
    if (/^[|>][-+0-9]*\s*(#.*)?$/.test(rest.slice(key[0].length).trim())) scalarIndent = column;
  });
  return index;
}

// the line of a path, or of the nearest enclosing path that has one
export function lineOf(index, path) {
  let current = `/${path}`;
  while (current) {
    if (index.has(current)) return index.get(current);
    current = current.slice(0, current.lastIndexOf("/"));
  }
  return 1;
}

// The rule line of each column of a condition written over several lines: a
// plain scalar continued on more indented lines, or a block scalar (`|`, `>`).
// `value` is what js-yaml read. When the lines joined the way YAML joins them
// are not that value (quotes, escapes, blank lines, indentation kept by `|`),
// every column takes the key's line.
export function scalarLines(text, keyLine, value) {
  const source = text.split(/\r?\n/);
  const whole = () => keyLine;
  const raw = source[keyLine - 1] ?? "";
  let column = raw.length - raw.trimStart().length;
  let rest = raw.slice(column);
  while (rest === "-" || rest.startsWith("- ")) {
    const after = rest.slice(1);
    column += 1 + after.length - after.trimStart().length;
    rest = after.trimStart();
  }
  const key = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^\s"'#{[\]}:,][^:#]*?)\s*:(?:\s+|$)/.exec(rest);
  if (!key || typeof value !== "string") return whole;
  const first = rest.slice(key[0].length).replace(/\s+#.*$/, "").trimEnd();
  const block = /^[|>]/.test(first);
  if (!block && (first === "" || /^["']/.test(first))) return whole;
  const segments = block ? [] : [{line: keyLine, text: first}];
  for (let i = keyLine; i < source.length; i++) {
    const text = source[i];
    if (text.trim() === "") break;
    if (text.length - text.trimStart().length <= column || (!block && text.trim().startsWith("#"))) break;
    segments.push({line: i + 1, text: text.trim()});
  }
  const joined = segments.map((s) => s.text).join(first.startsWith("|") ? "\n" : " ");
  if (!segments.length || joined !== value.replace(/\n+$/, "")) return whole;
  const starts = [];
  let offset = 1;
  for (const s of segments) {
    starts.push([offset, s.line]);
    offset += s.text.length + 1;
  }
  return (at) => starts.filter(([o]) => o <= at).at(-1)?.[1] ?? keyLine;
}

