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
