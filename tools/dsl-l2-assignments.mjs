// Wide test-row values need string expressions: text literals discard trailing
// blanks in each piece, whereas string literals preserve the complete value.
export function assignmentNode(field, pieces) {
  const type = field["value@type"].built_in;
  if (!["CHAR", "NUMC", "CLNT", "LANG", "CUKY", "UNIT", "ACCP", "DATS", "TIMS", "STRG", "SSTR"].includes(type)
      || field.value.replace(/['`]/g, "$&$&").length <= 100) return field;
  const list = pieces(field.value);
  return {...field, assignment_pieces: list.map((value, k) => ({
    "@id": `${field["@id"]}/piece/${k + 1}`, rule_line: field.rule_line,
    value, "value@type": {built_in: "STRG"}, first: k === 0, stop: k === list.length - 1 ? "." : "",
  }))};
}

// Compile-time concatenated constants also work in DEFAULT and call arguments.
// Enrich only wide typed literals: short literals keep their stored model hash.
export function literalNodes(node, pieces) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map((child) => literalNodes(child, pieces));
  const out = Object.fromEntries(Object.entries(node).map(([key, value]) => [key, literalNodes(value, pieces)]));
  for (const key of Object.keys(node).filter((key) => key.endsWith("@type"))) {
    const name = key.slice(0, -5);
    if (typeof node[name] !== "string") continue;
    const split = assignmentNode({"@id": `${node["@id"]}/${name}`, rule_line: node.rule_line,
      value: node[name], "value@type": node[key]}, pieces).assignment_pieces;
    if (split) out[`${name}_pieces`] = split;
  }
  return out;
}

// Presentation only: keep continuation whitespace out of the versioned model.
export function continuationNodes(node) {
  if (!node || typeof node !== "object") return node;
  if (Array.isArray(node)) return node.map(continuationNodes);
  return Object.fromEntries(Object.entries(node).map(([key, value]) => [key,
    key.endsWith("_pieces") && Array.isArray(value)
      ? value.map((piece, k) => ({...piece, continuation: k > 0 ? " &\n        " : ""}))
      : continuationNodes(value)]));
}
