// The table registry as the dynamic Open SQL condition parser reads it
// (tools/ir-osql-where.mjs), carved out of frontend.mjs (its size budget):
// pure functions over the program's tables, no registry, no lowering.
/**
 * The table registry (go/abap tables.go, README "The table registry"): every
 * TABL and DDIC view the registry has, in name order, as
 *   {name, view, client, key: [..], columns: [{name, kind, len, dec, key, type}],
 *    row: <the Go struct type, when every column is in the subset> | why}
 * where kind is the type kind letter (C N D T I 8 F P g y X), len the
 * characters of C N X and the bytes of P, and type the column's type in the
 * relational IR (sqlscript-ir.mjs T: C/len for C and N, I, INT8, P/digits/
 * dec, STRING, D, X/len, XSTRING; null where the IR has none). Built from
 * the same DDIC facts the SELECT path reads (dbTable), after the classes, so
 * that the row types it adds change nothing they compiled.
 */
/** the table registry as the column registry of the dynamic Open SQL
 * condition parser: {NAME: {view, client, key, columns: [{name, kind, len,
 * dec, key, type}]}}, JSON as it stands (README "The table registry") */
export function columnRegistry(program) {
  return {
    tables: Object.fromEntries((program.tables ?? []).map((t) => [t.name, {view: t.view, client: t.client, key: t.key,
      ...(t.sqlView ? {sqlView: t.sqlView} : {}), ...(t.cds ? {cds: t.cds} : {}),
      // tools/ir-osql-where.mjs osqlWherePredicate(text, columns) as it is
      columns: whereColumns(t),
      fields: t.columns.map((c) => ({name: c.name, kind: c.kind, len: c.len, dec: c.dec, key: c.key}))}])),
    cdsViews: program.cdsViews ?? {},
  };
}

/** {COL: {type, kind?}}: the columns argument of osqlWherePredicate
 * (tools/ir-osql-where.mjs), NUMC marked; a column with no IR type is left
 * out, as the parser could not compare it anyway */
export function whereColumns(t) {
  return Object.fromEntries(t.columns.filter((c) => c.type !== null).map((c) => [c.name, c.kind === "N" ? {type: c.type, kind: "NUMC"} : {type: c.type}]));
}
