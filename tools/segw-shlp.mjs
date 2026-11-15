#!/usr/bin/env node
// Search help objects -> the search help registry.
//
// A SEGW operation mapped to a search help asks the runtime by name
// (/iwbep/cl_sb_shlp_data_factory). abapGit serializes the search help as
// <name>.shlp.xml: DD30V (selection method SELMETHOD and its kind SELMTYPE,
// exit SELMEXIT, text table TEXTTAB, ISSIMPLE), DD31V (an elementary help
// names itself there), DD32P (the parameters: FIELDNAME, ROLLNAME,
// SHLPINPUT, SHLPOUTPUT, SHLPLISPOS, SHLPSELPOS, DEFAULTVAL/DEFAULTTYP).
// Reading them is what lets a cloned repository -- or a converted dump's
// layers under gen/hana-src -- serve its own value helps: nothing
// registered by hand.
//
// Three kinds of selection (docs/segw-mapping.md, "Text tables and help views"):
// (the view's DD28J rows, when it has any, give the joins instead of DD26V)
//   - one table: zcl_oao_shlp_ddic selects from it by name, as before;
//   - a table with a text table (TEXTTAB), and a help view (SELMTYPE H,
//     a join that has no database object): a read class is generated per
//     selection method, gen/segw/zcl_osd_shlp_<method>.clas.abap, a static
//     Open SQL LEFT OUTER JOIN over the tables -- the text table and every
//     secondary table of the view bound on its key, its language field to
//     the session language -- with the view's selection conditions and the
//     request's selection options; the provider reads through it
//     (zif_oao_shlp_source). The join is derived from the dictionary in
//     the same folders: the tables' DD03P (keys, client, LANGUFLAG) and the
//     view's DD26V (FORTABNAME/FORFIELD/FORDIR), DD27P, DD28V;
//   - an exit function (SELMEXIT) only: registered, answered "not served".
// A literal default value restricts its field. Values stay internal, as the
// search help runtime answers them (a language help answers '0'); turning
// that into 'SR' is the conversion exit of the OData property.
//
// Output: gen/segw/zcl_stg_shlp_registry.clas.abap with one register() that
// builds a zcl_oao_shlp_ddic per elementary search help and registers it,
// and the read classes. Collective search helps are listed as not
// registered.
import {existsSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync} from "node:fs";
import {XMLParser} from "fast-xml-parser";
import {generatorFoldersOf, winningByLayer} from "./osd-packs.mjs";
import {basename, join} from "node:path";

const OUT = "gen/segw";
const SOURCE_PREFIX = "zcl_osd_shlp_";

const ARRAYS = new Set(["DD03P", "DD26V", "DD27P", "DD28J", "DD28V", "DD31S", "DD31V", "DD32P", "DD33V"]);
const parser = new XMLParser({ignoreAttributes: true, parseTagValue: false, trimValues: true, isArray: (name) => ARRAYS.has(name)});

/** the first value under `key`, at any depth (the fragments the tests
 *  write leave out the asx:abap wrapper a real file has) */
function find(node, key) {
  if (node === null || typeof node !== "object") return undefined;
  if (Object.hasOwn(node, key)) return node[key];
  for (const value of Object.values(node)) {
    const found = find(value, key);
    if (found !== undefined) return found;
  }
  return undefined;
}

const text = (v) => (v === undefined || v === null || typeof v === "object" ? "" : String(v).trim());
const rows = (doc, table, row) => {
  const t = find(doc, table);
  return t && typeof t === "object" ? [t[row] ?? []].flat().filter((r) => r && typeof r === "object") : [];
};

/** an abapGit file name -> the object name (`#iwbep#x` -> `/IWBEP/X`) */
const objectName = (file) => basename(file).split(".")[0].replace(/#/g, "/").toUpperCase();

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir).sort();
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) {
        continue;
      }
      walk(full, out);
    } else if (/\.(shlp|tabl|view|dtel|doma)\.xml$/i.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

/** the literal of a DEFAULTTYP L default, without its quotes */
function literalDefault(value) {
  const v = value.trim();
  const m = /^'(.*)'$/s.exec(v);
  return m ? m[1].replace(/''/g, "'") : v;
}

/** one search help as its XML defines it */
export function parseSearchHelp(xml, file) {
  const doc = parser.parse(xml);
  const head = find(doc, "DD30V") ?? {};
  const name = text(head.SHLPNAME);
  const parameters = rows(doc, "DD32P_TABLE", "DD32P").map((p) => {
    const defaultType = text(p.DEFAULTTYP);
    const defaultValue = text(p.DEFAULTVAL);
    return {
      name: text(p.FIELDNAME),
      rollname: text(p.ROLLNAME),
      input: text(p.SHLPINPUT) === "X",
      output: text(p.SHLPOUTPUT) === "X",
      listPosition: parseInt(text(p.SHLPLISPOS) || "0", 10),
      selectPosition: parseInt(text(p.SHLPSELPOS) || "0", 10),
      defaultType,
      defaultValue,
      ...(defaultType === "L" ? {default: literalDefault(defaultValue)} : {}),
    };
  });
  // an elementary help names itself in DD31V (the converter writes that
  // row); another name there, or a DD31S row, is a collective one
  const subs = [...rows(doc, "DD31S_TABLE", "DD31S"), ...rows(doc, "DD31V_TABLE", "DD31V")].map((r) => text(r.SUBSHLP));
  return {
    name,
    description: text(head.DDTEXT),
    simple: text(head.ISSIMPLE) === "X",
    selmethod: text(head.SELMETHOD).toUpperCase(),
    selmtype: text(head.SELMTYPE),
    selmexit: text(head.SELMEXIT).toUpperCase(),
    texttab: text(head.TEXTTAB).toUpperCase(),
    collective: subs.some((s) => s !== "" && s.toUpperCase() !== name.toUpperCase()),
    subhelps: [...new Set(subs.filter((s) => s !== "").map((s) => s.toUpperCase()))],
    parameters,
    file,
  };
}

/** one table as the join needs it: keys, client field, language field */
export function parseTable(xml) {
  const doc = parser.parse(xml);
  const head = find(doc, "DD02V") ?? {};
  const fields = rows(doc, "DD03P_TABLE", "DD03P")
    .filter((f) => text(f.FIELDNAME) !== "" && !text(f.FIELDNAME).startsWith("."))
    .map((f) => ({
      name: text(f.FIELDNAME).toUpperCase(),
      key: text(f.KEYFLAG) === "X",
      rollname: text(f.ROLLNAME).toUpperCase(),
      datatype: text(f.DATATYPE).toUpperCase(),
      language: text(f.LANGUFLAG) === "X",
    }));
  return {name: text(head.TABNAME).toUpperCase(), clidep: text(head.CLIDEP) === "X", fields};
}

/** a view as a help view needs it: tables with their foreign-key path,
 *  fields, selection conditions */
export function parseView(xml) {
  const doc = parser.parse(xml);
  const head = find(doc, "DD25V") ?? {};
  return {
    name: text(head.VIEWNAME).toUpperCase(),
    viewclass: text(head.VIEWCLASS),
    tables: rows(doc, "DD26V_TABLE", "DD26V")
      .map((t) => ({table: text(t.TABNAME).toUpperCase(), position: parseInt(text(t.TABPOS) || "0", 10),
        fortable: text(t.FORTABNAME).toUpperCase(), forfield: text(t.FORFIELD).toUpperCase(), fordir: text(t.FORDIR)}))
      .sort((a, b) => a.position - b.position),
    fields: rows(doc, "DD27P_TABLE", "DD27P")
      .map((f) => ({viewfield: text(f.VIEWFIELD).toUpperCase(), table: text(f.TABNAME).toUpperCase(), field: text(f.FIELDNAME).toUpperCase(),
        position: parseInt(text(f.OBJPOS) || "0", 10)}))
      .sort((a, b) => a.position - b.position),
    // explicit join conditions (abapGit's DD28J: LTAB-LFIELD = RTAB-RFIELD);
    // a help view has none -- its joins are the foreign keys DD26V names --
    // and the converter writes the table only when the dictionary has rows
    joins: rows(doc, "DD28J_TABLE", "DD28J")
      .map((j) => ({ltab: text(j.LTAB).toUpperCase(), lfield: text(j.LFIELD).toUpperCase(), operator: text(j.OPERATOR).toUpperCase() || "EQ",
        rtab: text(j.RTAB).toUpperCase(), rfield: text(j.RFIELD).toUpperCase(), position: parseInt(text(j.POSITION) || "0", 10)}))
      .sort((a, b) => a.position - b.position),
    conditions: rows(doc, "DD28V_TABLE", "DD28V")
      .map((c) => ({table: text(c.TABNAME).toUpperCase(), field: text(c.FIELDNAME).toUpperCase(), operator: text(c.OPERATOR).toUpperCase(),
        constants: text(c.CONSTANTS), andOr: text(c.AND_OR).toUpperCase(), negation: text(c.NEGATION) === "X",
        position: parseInt(text(c.POSITION) || "0", 10)}))
      .sort((a, b) => a.position - b.position),
  };
}

/** the dictionary objects of the folders, by name, the later layer winning */
export function dictionaryOf(files) {
  const index = {tabl: new Map(), view: new Map(), dtel: new Map(), doma: new Map()};
  for (const file of files) {
    const kind = /\.(tabl|view|dtel|doma)\.xml$/i.exec(file)?.[1]?.toLowerCase();
    if (kind) index[kind].set(objectName(file), file);
  }
  const cache = new Map();
  const read = (kind, name, parse) => {
    const file = index[kind].get(name);
    if (file === undefined) return undefined;
    if (!cache.has(file)) cache.set(file, parse(readFileSync(file, "utf8")));
    return cache.get(file);
  };
  const value = (kind, name, key) => read(kind, name, (xml) => parser.parse(xml)) && text(find(read(kind, name, (xml) => parser.parse(xml)), key));
  return {
    table: (name) => read("tabl", name, parseTable),
    view: (name) => read("view", name, parseView),
    /** the data type of a field, through its data element when DD03P has none */
    datatype: (field) => {
      if (field.datatype) return field.datatype;
      const domain = field.rollname ? value("dtel", field.rollname, "DOMNAME") : "";
      return (value("dtel", field.rollname, "DATATYPE") || (domain ? value("doma", domain.toUpperCase(), "DATATYPE") : "") || "").toUpperCase();
    },
  };
}

/** the search helps found below the folders */
export function searchHelps(folders) {
  return winningByLayer(folders,
    (folder) => walk(folder).filter((f) => /\.shlp\.xml$/i.test(f)).map((file) => parseSearchHelp(readFileSync(file, "utf8"), file)),
    (help) => help.name.toUpperCase()).sort((a, b) => a.name.localeCompare(b.name));
}

/** the dictionary of the folders, in layer order */
export function dictionary(folders) {
  return dictionaryOf(folders.flatMap((folder) => walk(folder)));
}

const clientOf = (dict, table) => table.fields.find((f) => f.key && (dict.datatype(f) === "CLNT" || f.rollname === "MANDT"));
const languageOf = (table) => table.fields.find((f) => f.key && f.language);

/** the ON condition of `child` against `parent`, or a reason it has none:
 *  the client to the parent's client, the language field to the session
 *  language, the rest of the child's key to the parent's key -- by
 *  position, or (a check table, FORDIR E) to the field that checks it */
function bindKey(dict, child, parent, forfield, fordir) {
  const childClient = clientOf(dict, child);
  const parentClient = clientOf(dict, parent);
  const language = languageOf(child);
  const rest = child.fields.filter((f) => f.key && f !== childClient && f !== language);
  const parentKeys = parent.fields.filter((f) => f.key && f !== parentClient);
  const on = [];
  if (childClient && parentClient) on.push({field: childClient.name, parentField: parentClient.name});
  if (language) on.push({field: language.name, language: true});
  if (fordir === "E") {
    // the parent's FORFIELD is checked against this table: it pairs with
    // the one key field no parent field of the same name explains
    const named = rest.filter((f) => rest.length > 1 && parent.fields.some((p) => p.name === f.name && p.name !== forfield));
    const open = rest.filter((f) => !named.includes(f));
    for (const f of named) on.push({field: f.name, parentField: f.name});
    if (open.length !== 1 || !forfield) {
      return {reason: `${child.name}: ${open.length} key field(s) left for the checking field ${forfield || "(none)"} of ${parent.name}`};
    }
    on.push({field: open[0].name, parentField: forfield});
  } else {
    if (rest.length !== parentKeys.length) {
      return {reason: `${child.name}: ${rest.length} key field(s) besides client and language, ${parent.name} has ${parentKeys.length}`};
    }
    // DDIC pairs the fields of a foreign key one by one (DD05P), not by
    // key order; the converter's tabl.xml carries no DD05P, so a field
    // pairs with the parent key field of its name, and only a single field
    // left over on each side pairs by elimination (a text table's SPRSL
    // with its check table's SPRAS). Anything else is refused: a join on
    // crossed fields would answer wrong rows without a word.
    const free = [...parentKeys];
    const left = [];
    for (const f of rest) {
      const same = free.find((p) => p.name === f.name);
      if (same) {
        free.splice(free.indexOf(same), 1);
        on.push({field: f.name, parentField: same.name});
      } else {
        left.push(f);
      }
    }
    if (left.length === 1 && free.length === 1) {
      on.push({field: left[0].name, parentField: free[0].name});
    } else if (left.length > 0) {
      return {reason: `${child.name}: key field(s) ${left.map((f) => f.name).join(", ")} pair with no key field of ${parent.name} by name`};
    }
  }
  const unbound = on.filter((c) => !c.language && !c.parentField);
  if (unbound.length > 0) return {reason: `${child.name}: no field of ${parent.name} for ${unbound.map((c) => c.field).join(", ")}`};
  // the whole key is bound, so the outer join adds at most one row
  const bound = child.fields.filter((f) => f.key).every((f) => on.some((c) => c.field === f.name));
  return {on, bound};
}

/** the ON condition of `child` from DD28J rows, when the view has them. Unlike
 *  bindKey's refusals below, a partial key is kept here, on purpose: DD28J IS
 *  the view's join definition (a view may join on part of a key), whereas
 *  bindKey derives a join nobody wrote and refuses what it cannot pair. Each
 *  row pairing one of its fields with a field of a table before it (EQ only;
 *  a row to a table after it is read on that table's turn),
 *  its language key field, when no row binds it, to the session language */
function bindJoins(joins, child, aliasOf) {
  const on = [];
  for (const j of joins) {
    const [mine, other, otherTable] = j.rtab === child.name ? [j.rfield, j.lfield, j.ltab]
      : j.ltab === child.name ? [j.lfield, j.rfield, j.rtab] : [];
    // a row to a table after it is that table's join, read on its turn
    if (mine === undefined || otherTable === child.name || !aliasOf.has(otherTable)) continue;
    if (j.operator !== "EQ") return {reason: `${child.name}: DD28J operator ${j.operator} is not served`};
    on.push({field: mine, parentField: other, parentAlias: aliasOf.get(otherTable)});
  }
  if (on.length === 0) return {reason: `${child.name}: the view's DD28J rows join it to no table before it`};
  const language = languageOf(child);
  if (language && !on.some((c) => c.field === language.name)) on.push({field: language.name, language: true});
  const bound = child.fields.filter((f) => f.key).every((f) => on.some((c) => c.field === f.name));
  return {on, bound};
}

const OPERATORS = {EQ: "=", NE: "<>", LT: "<", LE: "<=", GT: ">", GE: ">=", LIKE: "LIKE"};

// What reaches generated ABAP and SQL out of dictionary XML is checked here,
// the generator being the validator of last resort over a converted dump's
// layers (PR #952 critic MUST-2): a name is a DDIC identifier -- an optional
// /NAMESPACE/, then a letter or underscore, letters, digits, underscores --
// and not one of the Open SQL words that could change a statement's meaning;
// a condition constant is one quoted literal or a number, re-emitted through
// the same escaping as a parameter default. Anything else is refused with
// its reason, never emitted.
const NAME = /^(\/[A-Z0-9_]+\/)?[A-Z_][A-Z0-9_]*$/;
const SQL_WORDS = new Set(["AND", "OR", "NOT", "LIKE", "IN", "BETWEEN", "IS", "NULL", "AS", "FROM", "WHERE", "ON",
  "JOIN", "INNER", "OUTER", "LEFT", "ORDER", "BY", "GROUP", "HAVING", "SELECT", "INTO", "UP", "TO", "ROWS", "ESCAPE",
  "EXISTS", "DISTINCT", "UNION", "ALL", "ANY", "SOME", "CASE", "WHEN", "THEN", "ELSE", "END"]);
export const validName = (name) => typeof name === "string" && NAME.test(name) && !SQL_WORDS.has(name);

/** a DD28V constant as ABAP source, or undefined when it is not one literal */
export function conditionLiteral(constants) {
  const text = String(constants ?? "").trim();
  const quoted = /^'((?:[^']|'')*)'$/.exec(text);
  if (quoted) return q(quoted[1].replace(/''/g, "'"));
  if (/^[+-]?\d+(\.\d+)?$/.test(text)) return text;
  return undefined;
}

/** the first name of a help (and its plan) that is no identifier, as a reason */
export function nameRefusal(help, plan) {
  const names = [["selection method", help.selmethod], ["text table", help.texttab], ["exit", help.selmexit],
    ...help.parameters.map((p) => ["parameter", p.name.toUpperCase()])].filter(([, n]) => n !== "");
  if (plan && !plan.reason) {
    for (const t of plan.tables) {
      names.push(["table", t.table.name]);
      // every DD03P field of a joined table: the ORDER BY writes the first
      // table's key fields whether or not a view field names them
      for (const f of t.table.fields) names.push(["table field", f.name]);
      for (const c of t.on ?? []) names.push(["join field", c.field], ...(c.parentField ? [["join field", c.parentField]] : []));
    }
    for (const [viewfield, f] of plan.fields) names.push(["field", viewfield], ["field", f.table], ["field", f.field]);
    for (const c of plan.conditions) names.push(["condition field", c.field]);
  }
  const bad = names.find(([, n]) => !validName(n));
  return bad ? `${bad[0]} ${JSON.stringify(bad[1])} is not a dictionary name this generator writes into ABAP` : undefined;
}

/** the join a search help's selection amounts to, or {reason} */
export function joinPlan(help, dict) {
  if (help.texttab !== "") {
    const base = dict.table(help.selmethod);
    const texts = dict.table(help.texttab);
    if (!base || !texts) return {reason: `table ${!base ? help.selmethod : help.texttab} is not in the build`};
    const bound = bindKey(dict, texts, base, "", "I");
    if (bound.reason) return {reason: bound.reason};
    const tables = [{alias: "t1", table: base}, {alias: "t2", table: texts, parent: "t1", on: bound.on}];
    const fields = new Map();
    for (const f of base.fields) fields.set(f.name, {alias: "t1", table: base.name, field: f.name});
    for (const f of texts.fields) if (!fields.has(f.name)) fields.set(f.name, {alias: "t2", table: texts.name, field: f.name});
    return {kind: "texttab", key: `${help.selmethod}|${help.texttab}`, method: help.selmethod, tables, fields, conditions: []};
  }
  if (help.selmtype !== "H") return undefined;
  const view = dict.view(help.selmethod);
  if (!view) return {reason: `help view ${help.selmethod} has no definition (.view.xml) in the build`};
  if (view.viewclass !== "H") return {reason: `view ${help.selmethod} is VIEWCLASS ${view.viewclass || "(none)"}, not a help view`};
  if (view.tables.length === 0) return {reason: `help view ${help.selmethod} names no table`};
  const tables = [];
  const aliasOf = new Map();
  for (const [i, t] of view.tables.entries()) {
    const table = dict.table(t.table);
    if (!table) return {reason: `table ${t.table} of help view ${help.selmethod} is not in the build`};
    const alias = `t${i + 1}`;
    if (i === 0) {
      tables.push({alias, table});
    } else {
      if (view.joins.length > 0) {
        const bound = bindJoins(view.joins, table, aliasOf);
        if (bound.reason) return {reason: `help view ${help.selmethod}: ${bound.reason}`};
        tables.push({alias, table, parent: bound.on.find((c) => c.parentAlias)?.parentAlias, on: bound.on, bound: bound.bound});
        aliasOf.set(t.table, alias);
        continue;
      }
      const parentAlias = aliasOf.get(t.fortable);
      if (!parentAlias) return {reason: `help view ${help.selmethod}: ${t.table} is joined to ${t.fortable || "(nothing)"}, which is not before it`};
      const parent = tables.find((x) => x.alias === parentAlias).table;
      const bound = bindKey(dict, table, parent, t.forfield, t.fordir);
      if (bound.reason) return {reason: `help view ${help.selmethod}: ${bound.reason}`};
      tables.push({alias, table, parent: parentAlias, on: bound.on, bound: bound.bound});
    }
    aliasOf.set(t.table, alias);
  }
  const fields = new Map();
  for (const f of view.fields) {
    if (!aliasOf.has(f.table)) return {reason: `help view ${help.selmethod}: field ${f.viewfield} of ${f.table}, which is not among its tables`};
    fields.set(f.viewfield, {alias: aliasOf.get(f.table), table: f.table, field: f.field});
  }
  const conditions = [];
  for (const c of view.conditions) {
    if (!aliasOf.has(c.table)) return {reason: `help view ${help.selmethod}: a condition on ${c.table}, which is not among its tables`};
    if (!OPERATORS[c.operator]) return {reason: `help view ${help.selmethod}: condition operator ${c.operator} is not served`};
    const literal = conditionLiteral(c.constants);
    if (literal === undefined) return {reason: `help view ${help.selmethod}: condition constant ${JSON.stringify(c.constants)} is not one literal`};
    conditions.push({...c, literal, alias: aliasOf.get(c.table)});
  }
  // AND only (PR #952 critic MUST-4): which row a DD28V AND_OR belongs to,
  // and how DDIC groups an OR, are not measured here, and a guess changes the
  // row set. A sequence with an OR is refused; between rows AND is the link.
  if (conditions.some((c) => c.andOr === "OR")) {
    return {reason: `help view ${help.selmethod}: selection conditions linked by OR are not served`};
  }
  return {kind: "helpview", key: help.selmethod, method: help.selmethod, tables, fields, conditions};
}

/** the tables a read needs: a secondary table bound on its whole key that
 *  gives no field read and no condition, and no table joins to, is left
 *  out -- an outer join to it can neither add nor remove a row */
function needed(plan, used) {
  let tables = plan.tables;
  for (;;) {
    const keep = tables.filter((t, i) => i === 0 || !t.bound
      || used.some((f) => plan.fields.get(f)?.alias === t.alias)
      || plan.conditions.some((c) => c.alias === t.alias)
      || tables.some((o) => o.parent === t.alias || (o.on ?? []).some((c) => c.parentAlias === t.alias)));
    if (keep.length === tables.length) return tables;
    tables = keep;
  }
}

const q = (s) => "'" + s.replace(/'/g, "''") + "'";
// a comment line carries 7-bit printable text only: a line break would end
// the comment, and ABAP source is ASCII
const comment = (s) => String(s).replace(/[^\x20-\x7E]/g, "?");
const bool = (b) => (b ? "abap_true" : "abap_false");
const lower = (s) => s.toLowerCase();

/** the read class of one join, and the help fields it answers */
export function sourceClass(className, plan, used) {
  const tables = needed(plan, used);
  const columns = used.map((name) => ({name, ...plan.fields.get(name)}));
  const width = Math.max(...columns.map((c) => c.name.length));
  const types = columns.map((c) => `             ${lower(c.name).padEnd(width)} TYPE ${lower(c.table)}-${lower(c.field)},`);
  const select = columns.map((c) => `${c.alias}~${lower(c.field)} AS ${lower(c.name)}`);
  const from = [`      FROM ${lower(tables[0].table.name)} AS ${tables[0].alias}`];
  for (const t of tables.slice(1)) {
    const on = t.on.map((c) => `${t.alias}~${lower(c.field)} = ${c.language ? "iv_langu" : `${c.parentAlias ?? t.parent}~${lower(c.parentField)}`}`);
    from.push(`        LEFT OUTER JOIN ${lower(t.table.name)} AS ${t.alias}`);
    from.push(`          ON ${on.join(`\n         AND `)}`);
  }
  const where = plan.conditions
    .map((c) => `${c.negation ? "NOT " : ""}${c.alias}~${lower(c.field)} ${OPERATORS[c.operator]} ${c.literal}`)
    .join(" AND ");
  const whereLine = where === "" ? "      WHERE (lv_where)" : `      WHERE ( ${where} ) AND (lv_where)`;
  const order = tables[0].table.fields.filter((f) => f.key).map((f) => `${tables[0].alias}~${lower(f.name)}`);
  const cases = columns.map((c) => `      WHEN ${q(c.name)}.\n        rv_column = '${c.alias}~${lower(c.field)}'.`);
  const what = plan.kind === "texttab"
    ? `the table ${plan.tables[0].table.name} with its text table ${plan.tables[1].table.name}`
    : `the help view ${plan.method}`;
  return `CLASS ${className} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/segw-shlp.mjs from the search help objects - do not edit
* The selection of ${what}:
* a join, the language field of a text table bound to the session language.
  PUBLIC SECTION.
    INTERFACES zif_oao_shlp_source.
    TYPES: BEGIN OF ty_row,
${types.join("\n")}
           END OF ty_row.
    TYPES ty_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
ENDCLASS.

CLASS ${className} IMPLEMENTATION.

  METHOD zif_oao_shlp_source~select.
    DATA lv_where TYPE string.
    FIELD-SYMBOLS <lt_rows> TYPE ty_rows.

    CREATE DATA rr_rows TYPE ty_rows.
    ASSIGN rr_rows->* TO <lt_rows>.
    lv_where = iv_where.
    IF lv_where IS INITIAL.
      lv_where = '1 = 1'.
    ENDIF.
    SELECT ${select.join("\n           ")}
${from.join("\n")}
      INTO CORRESPONDING FIELDS OF TABLE <lt_rows>
${whereLine}
      ORDER BY ${order.join(" ")}.
  ENDMETHOD.

  METHOD zif_oao_shlp_source~column.
    CASE to_upper( iv_field ).
${cases.join("\n")}
      WHEN OTHERS.
* the provider refuses a field that is no parameter before it asks here
        CLEAR rv_column.
    ENDCASE.
  ENDMETHOD.

ENDCLASS.
`;
}

/** the generated read classes and, per help, the class it reads through
 *  or the reason it has none */
export function sources(helps, dict) {
  const byKey = new Map();
  const forHelp = new Map();
  const used = new Set();
  for (const h of helps) {
    if (h.collective || !h.simple) continue;
    const plan = h.selmethod === "" ? undefined : joinPlan(h, dict);
    const refused = plan?.reason ?? nameRefusal(h, plan);
    if (refused) {
      forHelp.set(h.name, {reason: refused});
      continue;
    }
    if (plan === undefined) continue;
    const missing = h.parameters.filter((p) => !plan.fields.has(p.name.toUpperCase()));
    if (missing.length > 0) {
      forHelp.set(h.name, {reason: `${missing.map((p) => p.name).join(", ")} not in ${plan.method}${plan.kind === "texttab" ? " or " + h.texttab : ""}`});
      continue;
    }
    let entry = byKey.get(plan.key);
    if (entry === undefined) {
      const stem = (SOURCE_PREFIX + lower(plan.method).replace(/\//g, "_").replace(/^_+/, "")).slice(0, 30);
      let name = stem;
      for (let n = 2; used.has(name); n++) name = stem.slice(0, 30 - String(n).length - 1) + "_" + n;
      used.add(name);
      entry = {className: name, plan, fields: []};
      byKey.set(plan.key, entry);
    }
    for (const p of h.parameters) if (!entry.fields.includes(p.name.toUpperCase())) entry.fields.push(p.name.toUpperCase());
    forHelp.set(h.name, {className: entry.className});
  }
  const classes = [...byKey.values()].map((e) => ({className: e.className, abap: sourceClass(e.className, e.plan, e.fields)}));
  return {classes, forHelp};
}

export function shlpRegistryClass(helps, {dict, className = "zcl_stg_shlp_registry"} = {}) {
  const read = dict ? sources(helps, dict).forHelp : new Map();
  const blocks = [];
  let registered = 0;
  let joined = false;
  for (const h of helps) {
    if (h.collective || !h.simple) {
      blocks.push(`* ${comment(h.name)}: collective search help, not registered (elementary ones only)`);
      continue;
    }
    if (h.selmethod === "" && h.selmexit === "") {
      blocks.push(`* ${comment(h.name)}: no selection method and no exit, not registered`);
      continue;
    }
    const source = read.get(h.name);
    if (source?.reason) {
      blocks.push(`* ${comment(h.name)}: not registered, ${comment(source.reason)}`);
      continue;
    }
    registered++;
    const lines = [`* ${comment(h.name)}: ${comment(h.description || "search help")}`];
    const opts = [`iv_shlp_name = ${q(h.name)}`];
    if (h.selmethod !== "") {
      opts.push(`iv_selmethod = ${q(h.selmethod)}`);
    }
    if (h.selmexit !== "") {
      opts.push(`iv_selmexit  = ${q(h.selmexit)}`);
    }
    if (h.texttab !== "") {
      opts.push(`iv_texttab   = ${q(h.texttab)}`);
    }
    if (source?.className) {
      joined = true;
      lines.push(`    CREATE OBJECT lo_source TYPE ${source.className}.`);
      opts.push("io_source    = lo_source");
    }
    const pad = " ".repeat("    lo_shlp = zcl_oao_shlp_ddic=>create( ".length);
    lines.push(`    lo_shlp = zcl_oao_shlp_ddic=>create( ${opts.join("\n" + pad)} ).`);
    const ppad = " ".repeat("    lo_shlp->add_parameter( ".length);
    for (const p of h.parameters) {
      const extra = [];
      if (p.default !== undefined) extra.push(`iv_default         = ${q(p.default)}`);
      if (p.defaultType !== "" && p.defaultType !== "L") {
        lines.push(`* ${comment(p.name)}: default of kind ${comment(p.defaultType)} (${comment(p.defaultValue)}) is not applied here`);
      }
      lines.push(`    lo_shlp->add_parameter( iv_name            = ${q(p.name)}
${ppad}iv_input           = ${bool(p.input)}
${ppad}iv_output          = ${bool(p.output)}
${ppad}iv_list_position   = ${p.listPosition}
${ppad}iv_select_position = ${p.selectPosition}${extra.map((e) => `\n${ppad}${e}`).join("")} ).`);
    }
    lines.push("    lo_shlp->register( ).");
    blocks.push(lines.join("\n"));
  }
  const declarations = [`    DATA lo_shlp TYPE REF TO zcl_oao_shlp_ddic.`, ...(joined ? [`    DATA lo_source TYPE REF TO zif_oao_shlp_source.`] : [])];
  const body = registered > 0
    ? `${declarations.join("\n")}\n\n${blocks.join("\n\n")}`
    : `${blocks.length > 0 ? blocks.join("\n") + "\n" : ""}    RETURN.`;
  return `CLASS ${className} DEFINITION PUBLIC CREATE PUBLIC.
* generated by tools/segw-shlp.mjs from the search help objects - do not edit
  PUBLIC SECTION.
    CLASS-METHODS register.
ENDCLASS.

CLASS ${className} IMPLEMENTATION.

  METHOD register.
${body}
  ENDMETHOD.

ENDCLASS.
`;
}

/** everything the folders' search helps generate: file name -> source */
export function generate(folders, {className} = {}) {
  const helps = searchHelps(folders);
  const dict = dictionary(folders);
  const files = new Map();
  for (const c of sources(helps, dict).classes) files.set(`${c.className}.clas.abap`, c.abap);
  files.set(`${className ?? "zcl_stg_shlp_registry"}.clas.abap`, shlpRegistryClass(helps, {dict, className}));
  return {helps, dict, files};
}

if (process.argv[1] && /segw-shlp\.mjs$/.test(process.argv[1])) {
  const folders = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const list = process.argv.includes("--list");
  const {helps, dict, files} = generate(folders.length > 0 ? folders : generatorFoldersOf(process.env.OSD_ROOT ?? process.cwd()));
  const read = sources(helps, dict).forHelp;
  for (const h of helps) {
    const source = read.get(h.name);
    const how = h.collective || !h.simple ? "collective, skipped"
      : source?.reason ? `not registered: ${source.reason}`
      : source?.className ? `${h.selmtype === "H" ? "help view" : "table with text table"} ${h.selmethod}${h.texttab ? "/" + h.texttab : ""} through ${source.className}`
      : h.selmethod ? "table " + h.selmethod : h.selmexit ? "exit " + h.selmexit : "no source";
    console.log(`segw-shlp: ${h.name} -> ${how}, ${h.parameters.length} parameters${h.description ? " (" + h.description + ")" : ""}`);
  }
  if (!list) {
    mkdirSync(OUT, {recursive: true});
    // a read class no help needs any more goes, or it would stay in the build
    for (const stale of existsSync(OUT) ? readdirSync(OUT) : []) {
      if (stale.startsWith(SOURCE_PREFIX) && !files.has(stale)) rmSync(join(OUT, stale));
    }
    for (const [name, abap] of files) writeFileSync(join(OUT, name), abap);
  }
}
