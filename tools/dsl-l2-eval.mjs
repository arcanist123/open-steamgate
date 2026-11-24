// DSL L2, slices 2 and 3: what a rule means, computed in JavaScript, and the
// cases derived from it (docs/dsl-l2.md, "Boundaries").
//
// `evaluate(model, rows, params)` interprets the compiled rule over rows the
// way the generated ABAP is meant to: every row of the `for` table that meets
// `when`, then per the rule's kind the rows of its exists clauses that meet
// their `where` (forbid: one alert per match; all: per combination; any: per
// match of each clause; require: one alert when nothing matches). Conditions
// are trees of and / or / not over comparisons. Comparisons use DDIC semantics (CHAR ignores trailing blanks, DATS /
// TIMS / NUMC compare as digit strings, INT and DEC numerically). The
// generated test class then checks that the ABAP says the same, on every
// derived case and every hand-written example; the agreement is the proof.
//
// The compiler's own word list stays empty of any domain: tables, fields and
// values arrive in the model.
import {inRange} from "./dsl-l2-range.mjs";
import {holdsRange, plainRow, rangeMutants, rangeVariants} from "./dsl-l2-selopt.mjs";
import {INTEGERS, PACKED, INT_RANGE, kindOf, canonical, isOrdered, initialValue, scaled, sign, compareValues, render, formatDecimal, shiftDate,
  stepValue, bump, different, defaultValue} from "./dsl-l2-values.mjs";
export {INTEGERS, PACKED, INT_RANGE, kindOf, canonical, isOrdered, initialValue, compareValues, render, shiftDate,
  stepValue, bump, different, defaultValue} from "./dsl-l2-values.mjs";

function rhsValue(rhs, params) {
  if (rhs.kind === "literal") return rhs.value;
  if (rhs.kind === "param") return params[rhs.name];
  if (rhs.kind === "window") {
    const offset = rhs.offset.kind === "literal" ? rhs.offset.value : params[rhs.offset.name];
    if (offset === undefined) throw new Error(`no value for date window offset $${rhs.offset.name}`);
    const days = Number(offset);
    if (!Number.isSafeInteger(days) || days < 0) throw new Error(`date window offset must be a non-negative safe integer: ${offset}`);
    return shiftDate(params.date, (rhs.sign === "-" ? -1 : 1) * days);
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// the interpreter

const lower = (rows) => Object.fromEntries(Object.entries(rows).map(([table, list]) => [table.toLowerCase(), list]));

// A condition is a tree over the comparisons of its list: {op: "cmp", index}
// names `leaves[index]`; "and" and "or" hold `items`, "not" one `item`. A
// leaf with `constant` set (a mutant of the discriminate guard) is that value.
// Two-valued logic is enough: a field is never NULL here (every row is
// written by an ABAP INSERT, which fills every column, and every join is an
// INNER JOIN), so NOT is plain negation.
function holdsTree(tree, leaves, holds) {
  switch (tree.op) {
    case "cmp": {
      const leaf = leaves[tree.index];
      return leaf.constant !== undefined ? leaf.constant : holds(leaf.cmp);
    }
    case "and": return tree.items.every((item) => holdsTree(item, leaves, holds));
    case "or": return tree.items.some((item) => holdsTree(item, leaves, holds));
    case "not": return !holdsTree(tree.item, leaves, holds);
    default: throw new Error(`condition node ${tree.op}`);
  }
}

// `rows`: {TABLE: [{field: text}]} (names in any case; a field left out is
// initial), `params`: {date: "YYYYMMDD"}. Alerts come in the order the
// generated check returns them:
//   forbid (one exists, or all:)  the `for` key, then each exists key in turn;
//   forbid any:                    clause by clause, each by the `for` key and its own key;
//   require:                       the `for` key.
// `override` ({<clause index>: true | false}) replaces a clause by one that
// always matches (a row of initial values) or never does: the structural
// mutants of the discriminate guard.
export function evaluate(model, rows, params = {}, override = {}) {
  params = {...Object.fromEntries((model.params ?? []).filter((p) => p.is_selopt || p.default !== undefined)
    .map((p) => [p.name, p.is_selopt ? (p.default_rows ?? []).map(plainRow) : p.default])), ...params};
  const tables = lower(rows);
  const schema = model.ddic;
  const fieldsOf = (table) => schema[table].fields;
  const valueOf = (table, row, column) => canonical(fieldsOf(table)[column], row[column] ?? initialValue(fieldsOf(table)[column]));
  const ordered = (table) => [...(tables[table] ?? [])].sort((x, y) => {
    for (const key of schema[table].keys) {
      const c = compareValues(fieldsOf(table)[key], valueOf(table, x, key), fieldsOf(table)[key], valueOf(table, y, key));
      if (c) return c;
    }
    return 0;
  });
  const holdsIn = (context) => (cmp) => {
    const left = context[cmp.alias];
    const a = valueOf(left.table, left.row, cmp.column);
    if (cmp.rhs.kind === "range") return holdsRange(cmp, a, params);
    let b, typeB = cmp.type;
    if (cmp.rhs.kind !== "field") {
      b = rhsValue(cmp.rhs, params);
      if (b === undefined) throw new Error(`no value for parameter or date window ${JSON.stringify(cmp.rhs)}`);
    } else {
      const right = context[cmp.rhs.alias];
      b = valueOf(right.table, right.row, cmp.rhs.column);
      typeB = cmp.rhs.type;
    }
    return test(cmp.op, compareValues(cmp.type, a, typeB, b));
  };
  const outer = model.for;
  const whenHolds = (context) => !model.when.tree || holdsTree(model.when.tree, model.when.conditions, holdsIn(context));
  // the rows of a clause that match it for the `for` row in `context`
  const matching = (clause, c, context) => {
    if (override[c] === true) return [{}];
    if (override[c] === false) return [];
    return ordered(clause.table).filter((row) =>
      holdsTree(clause.tree, clause.conditions, holdsIn({...context, [clause.alias]: {table: clause.table, row}})));
  };
  const alertOf = (parts, context) => parts.map((part) => {
    if (part.is_text) return part.value;
    if (part.is_count) return String(context.$count);
    if (part.is_aggregate) return render(model.aggregate.type, context.$aggregate);
    const at = context[part.alias];
    return render(fieldsOf(at.table)[part.column], valueOf(at.table, at.row, part.column));
  }).join("");
  const alerts = [];
  const each = (visit) => {
    for (const o of ordered(outer.table)) {
      if (model.range && !inRange(params.$range, fieldsOf(outer.table)[model.range.field], valueOf(outer.table, o, model.range.field))) continue;
      const context = {[outer.alias]: {table: outer.table, row: o}};
      if (whenHolds(context)) visit(context);
    }
  };
  if (model.kind === "limit") {
    const clause = model.clauses[0];
    let last = 0;
    let lastAggregate;
    each((context) => {
      const found = matching(clause, 0, context);
      if (model.aggregate.is_count) {
        let count = found.length;
        // `inner`: the mutant that reads the for rows through the INNER JOIN
        // only, so a for row with no counted row is never seen
        if (count === 0 && model.threshold.inner) return;
        // `stale`: the mutant whose count is not reset per for row
        if (count === 0 && model.threshold.stale) count = last;
        last = count;
        if (test(model.threshold.op, Math.sign(count - model.threshold.value))) {
          alerts.push(alertOf(model.alert.parts, {...context, $count: count}));
        }
        return;
      }
      const type = model.aggregate.type;
      let value;
      if (model.aggregate.is_sum) {
        if (!found.length && model.threshold.inner) return;
        if (!found.length && model.threshold.stale) value = lastAggregate ?? initialValue(type);
        else {
          const total = found.reduce((acc, row) => acc + scaled(valueOf(clause.table, row, model.aggregate.column), type.decimals ?? 0), 0n);
          value = formatDecimal(total, type.decimals ?? 0);
        }
        lastAggregate = value;
      } else {
        if (!found.length) return; // chosen empty-group rule: min/max have no value, so emit no alert
        value = valueOf(clause.table, found[0], model.aggregate.column);
        for (const row of found.slice(1)) {
          const candidate = valueOf(clause.table, row, model.aggregate.column);
          const cmp = compareValues(type, candidate, type, value);
          if ((model.aggregate.is_min && cmp < 0) || (model.aggregate.is_max && cmp > 0)) value = candidate;
        }
      }
      const threshold = model.threshold.canonical_value ?? String(model.threshold.value);
      if (test(model.threshold.op, compareValues(type, value, type, threshold))) {
        alerts.push(alertOf(model.alert.parts, {...context, $aggregate: value}));
      }
    });
  } else if (model.kind === "require") {
    const clause = model.clauses[0];
    each((context) => {
      if (!matching(clause, 0, context).length) alerts.push(alertOf(model.alert.parts, context));
    });
  } else if (model.combine === "any") {
    model.clauses.forEach((clause, c) => each((context) => {
      for (const row of matching(clause, c, context)) {
        alerts.push(alertOf(clause.alert.parts, {...context, [clause.alias]: {table: clause.table, row}}));
      }
    }));
  } else {
    each((context) => {
      const walk = (c, ctx) => {
        if (c === model.clauses.length) { alerts.push(alertOf(model.alert.parts, ctx)); return; }
        const clause = model.clauses[c];
        for (const row of matching(clause, c, ctx)) walk(c + 1, {...ctx, [clause.alias]: {table: clause.table, row}});
      };
      walk(0, context);
    });
  }
  return alerts;
}

function test(op, c) {
  switch (op) {
    case "=": return c === 0;
    case "<>": return c !== 0;
    case "<": return c < 0;
    case ">": return c > 0;
    case "<=": return c <= 0;
    case ">=": return c >= 0;
    default: throw new Error(`operator ${op}`);
  }
}

// ---------------------------------------------------------------------------
// derived cases

const clone = (rows) => Object.fromEntries(Object.entries(rows).map(([t, list]) => [t, list.map((r) => ({...r}))]));

// every comparison of the rule: the `when` ones, then each clause's
const leavesOf = (model) => [...model.when.conditions, ...model.clauses.flatMap((c) => c.conditions)];

// "when/1", "forbid/where/2", "forbid/all/2/where/1", "require/where/1": the
// comparison node of the model whose @id ends so
export function conditionOf(model, reference) {
  return leavesOf(model).find((leaf) => leaf["@id"] === `${model["@id"]}/${reference}`);
}

export function allReferences(model) {
  return leavesOf(model).map((leaf) => leaf["@id"].slice(model["@id"].length + 1));
}

// the tree a comparison belongs to: the `when`, or a clause's `where`
function ownerOf(model, cond) {
  const at = model.when.conditions.indexOf(cond);
  if (at >= 0) return {when: true, table: model.for.table, alias: model.for.alias, tree: model.when.tree, leaves: model.when.conditions, index: at, slot: 0};
  for (const clause of model.clauses) {
    const i = clause.conditions.indexOf(cond);
    if (i >= 0) return {when: false, clause, table: clause.table, alias: clause.alias, tree: clause.tree, leaves: clause.conditions, index: i, slot: slotOf(clause)};
  }
  throw new Error(`internal: ${cond.text} is in no condition of the rule`);
}

const INVERT = {"=": "<>", "<>": "=", "<": ">=", ">=": "<", ">": "<=", "<=": ">", "IN": "NOT IN", "NOT IN": "IN"};
const LIMIT = 64; // alternatives kept per tree; a rule this wide gets fewer derived cases, never wrong ones

const product = (lists) => lists.reduce((acc, list) => acc.flatMap((a) => list.map((b) => [...a, ...b])).slice(0, LIMIT), [[]]);
const union = (lists) => lists.flat().slice(0, LIMIT);

// The ways a tree can come out `want`: a list of alternatives, each a list
// of comparisons (a negated one with its operator inverted) that together
// force it. Values that satisfy one alternative make the tree `want`.
function alternatives(tree, leaves, want) {
  switch (tree.op) {
    case "cmp": {
      const leaf = leaves[tree.index];
      if (leaf.constant !== undefined) return leaf.constant === want ? [[]] : [];
      return [[want ? leaf.cmp : {...leaf.cmp, op: INVERT[leaf.cmp.op]}]];
    }
    case "not": return alternatives(tree.item, leaves, !want);
    case "and": return want ? product(tree.items.map((x) => alternatives(x, leaves, true))) : union(tree.items.map((x) => alternatives(x, leaves, false)));
    case "or": return want ? union(tree.items.map((x) => alternatives(x, leaves, true))) : product(tree.items.map((x) => alternatives(x, leaves, false)));
    default: throw new Error(`condition node ${tree.op}`);
  }
}

// The alternatives under which the comparison `target` alone decides the
// tree: along its path every sibling under an `and` holds, every sibling
// under an `or` does not; a `not` passes the decision through (and flips it).
function sensitize(tree, leaves, target) {
  if (tree.op === "cmp") return tree.index === target ? [[]] : undefined;
  if (tree.op === "not") return sensitize(tree.item, leaves, target);
  for (const [i, item] of tree.items.entries()) {
    const inner = sensitize(item, leaves, target);
    if (!inner) continue;
    return product([inner, ...tree.items.filter((_, j) => j !== i).map((x) => alternatives(x, leaves, tree.op === "and"))]);
  }
  return undefined;
}

// Gives the fields of `table` that `cmps` constrain values that satisfy them
// (the row's other fields stay); a reason when none does. `cmps` is one
// alternative: comparisons that must all hold.
function solveRow(model, params, rows, alias, table, cmps, keep = false, slot = 0) {
  const row = rows[table][slot];
  const byColumn = new Map();
  for (const cmp of cmps.filter((x) => x.alias === alias)) {
    if (!byColumn.has(cmp.column)) byColumn.set(cmp.column, []);
    byColumn.get(cmp.column).push(cmp);
  }
  for (const [column, list] of byColumn) {
    const type = model.ddic[table].fields[column];
    const target = (cmp) => cmp.rhs.kind === "field" ? rows[model.for.table][0][cmp.rhs.column] ?? initialValue(cmp.rhs.type)
      : rhsValue(cmp.rhs, params);
    const stepped = (v) => [v, isOrdered(type) ? stepValue(type, v, 1) : bump(v, 1), isOrdered(type) ? stepValue(type, v, -1) : bump(v, -1)];
    const candidates = [];
    for (const cmp of list) {
      // a range: every bound of its rows and the values beside them
      if (cmp.rhs.kind === "range") candidates.push(...(params[cmp.rhs.name] ?? []).flatMap((r) => [...stepped(r.low), ...(r.high === undefined ? [] : stepped(r.high))]));
      else candidates.push(...stepped(target(cmp)));
    }
    if (keep) candidates.unshift(row[column]);
    candidates.push(row[column], initialValue(type));
    const ok = (value) => list.every((cmp) => cmp.rhs.kind === "range" ? holdsRange(cmp, canonical(type, value), params)
      : test(cmp.op, compareValues(type, value, cmp.rhs.kind === "field" ? cmp.rhs.type : type, target(cmp))));
    const pick = candidates.find((value) => value !== undefined && ok(value));
    if (pick === undefined) return `no value of ${table}-${column} satisfies ${list.map((c) => c.rhs.kind === "field" ? `${c.op} ${c.rhs.alias}.${c.rhs.column}`
      : c.rhs.kind === "range" ? `${c.op} range $${c.rhs.name}` : `${c.op} ${target(c)}`).join(" and ")}`;
    row[column] = pick;
  }
  return undefined;
}

// The first alternative that a row of `table` can be made to satisfy.
function solveAlternatives(model, params, rows, alias, table, alts, keep, slot = 0) {
  if (!rows[table]?.[slot]) return undefined;
  let why = "the condition cannot hold";
  for (const alt of alts) {
    const trial = clone(rows);
    why = solveRow(model, params, trial, alias, table, alt, keep, slot);
    if (!why) { rows[table][slot] = trial[table][slot]; return undefined; }
  }
  return why;
}

const treeAlternatives = (tree, leaves) => tree ? alternatives(tree, leaves, true) : [[]];

// every clause row made to match again (keep the values that already do)
function resolveClauses(model, params, rows, except, keep) {
  for (const clause of model.clauses) {
    if (clause === except) continue;
    solveAlternatives(model, params, rows, clause.alias, clause.table, treeAlternatives(clause.tree, clause.conditions), keep, slotOf(clause));
  }
}

// A clause's own row in its table: 0, or 1 for the second of two `any`
// clauses that read one table (each clause gets a row of its own).
const slotOf = (clause) => clause.slot ?? 0;

// whether the rows of every table have different keys (an INSERT of the
// test would refuse two rows with the same one)
function keysDistinct(model, rows) {
  return Object.entries(rows).every(([table, list]) => {
    const {keys, fields} = model.ddic[table];
    const seen = new Set(list.map((row) => JSON.stringify(keys.map((k) => canonical(fields[k], row[k] ?? initialValue(fields[k]))))));
    return seen.size === list.length;
  });
}

// whether every tree of the rule holds: `when` on the `for` row, each
// clause's `where` on that row and the clause's own row
function allHold(model, rows, params) {
  const outer = rows[model.for.table]?.[0];
  if (!outer) return false;
  const probe = {...model, kind: "forbid", combine: "all", clauses: [], alert: {parts: []}};
  if (evaluate(probe, {[model.for.table]: [outer]}, params).length !== 1) return false;
  return model.clauses.every((clause) => {
    const row = rows[clause.table]?.[slotOf(clause)];
    return row !== undefined && evaluate({...probe, clauses: [clause]}, {[model.for.table]: [outer], [clause.table]: [row]}, params).length === 1;
  }) && keysDistinct(model, rows);
}

// One row per table on which every condition holds, so that in the cases only
// the condition under test decides: the first example's first rows when they
// do, else rows generated from the field types. Undefined with a reason when
// the conditions cannot hold together.
function baseRows(model, params, example) {
  const fullRow = (table, given = {}, slot = 0) => {
    const {fields, client} = model.ddic[table];
    const row = {};
    let seed = 1 + 50 * slot;
    for (const [column, type] of Object.entries(fields)) {
      if (column === client) continue;
      row[column] = canonical(type, given[column] ?? defaultValue(type, seed++));
    }
    return row;
  };
  const rowsFrom = (given) => {
    const rows = {[model.for.table]: [fullRow(model.for.table, given?.[model.for.table]?.[0])]};
    for (const clause of model.clauses) {
      rows[clause.table] ??= [];
      rows[clause.table][slotOf(clause)] = fullRow(clause.table, given?.[clause.table]?.[slotOf(clause)], slotOf(clause));
    }
    return rows;
  };
  if (example) {
    const rows = rowsFrom(example);
    if (allHold(model, rows, params)) return {rows};
  }
  const generated = rowsFrom(undefined);
  let why = "no value satisfies the when";
  for (const alt of treeAlternatives(model.when.tree, model.when.conditions)) {
    const rows = clone(generated);
    why = solveRow(model, params, rows, model.for.alias, model.for.table, alt);
    if (why) continue;
    for (const clause of model.clauses) {
      why = solveAlternatives(model, params, rows, clause.alias, clause.table, treeAlternatives(clause.tree, clause.conditions), false, slotOf(clause));
      if (why) break;
    }
    if (!why && allHold(model, rows, params)) return {rows};
    why ??= "generated rows do not make every condition hold";
  }
  return {why};
}

// After a case changed a field, the join equalities that are not under test
// hold again, and the tested value stays: a changed exists field is followed
// by the `for` field of each equality on it; every other exists row then
// follows the `for` row (the other row is adjusted, the value under test is not).
function rejoin(model, rows, except, changedClause, changedColumn) {
  const outer = rows[model.for.table][0];
  const byInner = [], byOuter = [];
  for (const clause of model.clauses) {
    const inner = rows[clause.table]?.[slotOf(clause)];
    if (!inner) continue;
    for (const c of clause.on) {
      if (c === except) continue;
      (clause === changedClause && c.cmp.column === changedColumn ? byInner : byOuter).push([inner, c]);
    }
  }
  for (const [inner, c] of byInner) outer[c.cmp.rhs.column] = inner[c.cmp.column];
  for (const [inner, c] of byOuter) inner[c.cmp.column] = outer[c.cmp.rhs.column];
}

const OPERATORS = ["=", "<>", "<", ">", "<=", ">="];

// the model with one comparison replaced by `leaf` (the tree keeps its shape)
function withCondition(model, cond, leaf) {
  const swap = (list) => list.map((c) => c === cond ? leaf : c);
  return {...model, when: {...model.when, conditions: swap(model.when.conditions)},
    clauses: model.clauses.map((clause) => ({...clause, conditions: swap(clause.conditions)}))};
}

// the variants of a comparison a translation could get wrong: always true
// (dropped from a conjunction), always false (dropped from a disjunction),
// every other operator, the literal or parameter one step either way
function mutantsOf(cond, params) {
  const cmp = cond.cmp;
  if (cmp.rhs.kind === "range") return rangeMutants(cond);
  const out = [{...cond, constant: true}, {...cond, constant: false},
    ...OPERATORS.filter((op) => op !== cmp.op).map((op) => ({...cond, cmp: {...cmp, op}}))];
  if (cmp.rhs.kind !== "field") {
    const value = rhsValue(cmp.rhs, params);
    for (const dir of [-1, 1]) {
      const shifted = isOrdered(cmp.type) ? stepValue(cmp.type, value, dir) : bump(value, dir);
      if (shifted !== undefined) out.push({...cond, cmp: {...cmp, rhs: {kind: "literal", value: shifted}}});
    }
  }
  if (cmp.rhs.kind === "window") {
    for (const dir of [-1, 1]) {
      const offset = cmp.rhs.offset.kind === "literal" ? cmp.rhs.offset.value : params[cmp.rhs.offset.name];
      const next = BigInt(offset) + BigInt(dir);
      if (next >= 0n && next <= 2147483647n) out.push({...cond, cmp: {...cmp,
        rhs: {...cmp.rhs, offset: {kind: "literal", value: String(next)}}}});
    }
  }
  return out;
}

export function windowOffsetDiscriminates(model, cond, rows, params, dir) {
  const rhs = cond.cmp.rhs;
  if (rhs.kind !== "window") return false;
  const offset = rhs.offset.kind === "literal" ? rhs.offset.value : params[rhs.offset.name];
  const next = BigInt(offset) + BigInt(dir);
  if (next < 0n || next > 2147483647n) return false;
  const mutated = {...cond, cmp: {...cond.cmp, rhs: {...rhs, offset: {kind: "literal", value: String(next)}}}};
  return JSON.stringify(evaluate(model, rows, params)) !== JSON.stringify(evaluate(withCondition(model, cond, mutated), rows, params));
}

// A case discriminates when some mutant of the condition it targets gives
// other alerts on its rows than the rule does: otherwise it would pass
// whether the translation of that condition is right or wrong.
export function caseDiscriminates(model, cond, rows, params) {
  const expected = JSON.stringify(evaluate(model, rows, params));
  return mutantsOf(cond, params).some((leaf) => JSON.stringify(evaluate(withCondition(model, cond, leaf), rows, params)) !== expected);
}

// The same for a structural case: some clause replaced by one that always
// matches or by one that never does changes its alerts.
export function structureDiscriminates(model, rows, params) {
  const expected = JSON.stringify(evaluate(model, rows, params));
  return model.clauses.some((_, c) => [true, false].some((value) =>
    JSON.stringify(evaluate(model, rows, params, {[c]: value})) !== expected));
}

// Add matching rows by varying a counted-table key. The interpreter checks
// the resulting count, so a constrained key or a short key cannot fake a case.
export const COUNT_ROW_CAP = 64;

const countedModel = (model) => ({...model, aggregate: {is_count: true}, threshold: {op: ">", value: 0}, alert: {parts: [{is_count: true}]} });
const matchingCount = (model, rows, params) => {
  const result = evaluate(countedModel(model), rows, params);
  return result.length === 1 ? Number(result[0]) : undefined;
};

function countTo(model, rows, wanted, params) {
  const clause = model.clauses[0];
  const table = clause.table;
  if (wanted === 0) { rows[table] = []; return true; }
  if (wanted > COUNT_ROW_CAP) return false;
  const count = () => matchingCount(model, rows, params);
  if (count() !== 1) return false;
  const base = {...rows[table][0]};
  for (let i = 1; i < wanted; i++) {
    let added = false;
    for (const key of model.ddic[table].keys) {
      const type = model.ddic[table].fields[key];
      for (let seed = i + 100; seed < i + 300; seed++) {
        const value = defaultValue(type, seed);
        const row = {...base, [key]: value};
        rows[table].push(row);
        if (keysDistinct(model, rows) && count() === i + 1) { added = true; break; }
        rows[table].pop();
      }
      if (added) break;
    }
    if (!added) return false;
  }
  return true;
}

function splitTotal(type, total) {
  const decimals = type.decimals ?? 0;
  const target = kindOf(type) === "int" ? BigInt(total) : scaled(total, decimals);
  let low, high;
  if (kindOf(type) === "int") [low, high] = INT_RANGE[type.built_in];
  else { high = 10n ** BigInt(type.length ?? 0) - 1n; low = -high; }
  const values = target > high ? [high, target - high] : target < low ? [low, target - low] : [target];
  if (values.some((part) => part < low || part > high)) return undefined;
  return values.map((part) => kindOf(type) === "int" ? String(part) : formatDecimal(part, decimals));
}

function stepAggregate(type, text, dir) {
  if (kindOf(type) === "int") {
    const next = BigInt(text) + BigInt(dir);
    if (type.built_in === "INT8") {
      const [low, high] = INT_RANGE.INT8;
      if (next < low || next > high) return undefined;
    }
    return String(next);
  }
  return formatDecimal(scaled(text, type.decimals ?? 0) + BigInt(dir), type.decimals ?? 0);
}

// Make one counted group whose exact sum is `total`. Values are split across
// two source rows only when a sum boundary is one step past the field range.
function sumTo(model, baseRows, total, params) {
  if (total === undefined) return undefined;
  const clause = model.clauses[0], table = clause.table;
  const type = model.aggregate.type, column = model.aggregate.column;
  const values = splitTotal(type, total);
  if (!values) return undefined;
  const start = clone(baseRows);
  if (!start[table]?.length && !countTo(model, start, 1, params)) return undefined;
  let base;
  for (const candidate of start[table] ?? []) {
    const row = {...candidate, [column]: values[0]};
    const probe = clone(start);
    probe[table] = [row];
    if (matchingCount(model, probe, params) === 1) { base = row; break; }
  }
  if (!base) return undefined;
  const rows = clone(start);
  rows[table] = [base];
  for (let i = 1; i < values.length; i++) {
    let added;
    for (const key of model.ddic[table].keys) {
      const keyType = model.ddic[table].fields[key];
      for (let seed = 400 + i * 300; seed < 700 + i * 300 && !added; seed++) {
        const candidate = {...base, [column]: values[i], [key]: defaultValue(keyType, seed)};
        const probe = clone(rows);
        probe[table].push(candidate);
        if (keysDistinct(model, probe) && matchingCount(model, probe, params) === i + 1) added = candidate;
      }
      if (added) break;
    }
    if (!added) return undefined;
    rows[table].push(added);
  }
  return rows;
}

function extremeTo(model, baseRows, value, params) {
  const table = model.clauses[0].table, column = model.aggregate.column;
  const type = model.aggregate.type;
  if (value === undefined || misfitNumeric(value, type)) return undefined;
  const start = clone(baseRows);
  if (!start[table]?.length && !countTo(model, start, 1, params)) return undefined;
  for (const candidate of start[table] ?? []) {
    const row = {...candidate, [column]: canonical(type, value)};
    const rows = clone(start);
    rows[table] = [row];
    if (matchingCount(model, rows, params) === 1) return rows;
  }
  return undefined;
}

function misfitNumeric(value, type) {
  if (kindOf(type) === "int") {
    if (!/^-?[0-9]+$/.test(value)) return true;
    const n = BigInt(value), [low, high] = INT_RANGE[type.built_in];
    return n < low || n > high;
  }
  if (!/^-?[0-9]+(\.[0-9]+)?$/.test(value)) return true;
  const [whole, fraction = ""] = value.replace(/^-/, "").split(".");
  return fraction.length > (type.decimals ?? 0) || whole.replace(/^0+(?=.)/, "").length > (type.length ?? 0) - (type.decimals ?? 0);
}

// the operators a threshold's operator is mistaken for: the bound included
// or excluded, and for an equality its one-sided forms
const THRESHOLD_MUTANTS = {">": [">="], ">=": [">"], "<": ["<="], "=": [">=", "<=", "<>"]};

// Rows with the base for row counted `carried` times and a second for row,
// later in key order, with no counted row; undefined when no such rows make
// the stale-count mutant change the alerts.
function nextZero(model, baseRows, carried, params) {
  const forTable = model.for.table, {keys, fields} = model.ddic[forTable];
  const first = clone(baseRows);
  if (!countTo(model, first, carried, params)) return undefined;
  const original = first[forTable][0];
  const others = Object.keys(fields).filter((column) => !keys.includes(column) && column !== model.ddic[forTable].client);
  const counts = {...model, threshold: {op: ">=", value: 0}, alert: {parts: [{is_count: true}]}};
  for (const key of keys) {
    const candidates = [bump(original[key], 1), stepValue(fields[key], original[key], 1),
      ...Array.from({length: 298}, (_, i) => defaultValue(fields[key], i + 2))];
    for (const candidate of candidates) {
      if (candidate === undefined || compareValues(fields[key], candidate, fields[key], original[key]) <= 0) continue;
      // the other fields as they were, or each made different (so the alert
      // names something of its own); either may keep the when true
      for (const variant of [false, true]) {
        const second = {...original, [key]: candidate};
        if (variant) for (const column of others) second[column] = different(fields[column], original[column]) ?? second[column];
        const rows = clone(first);
        rows[forTable].push(second);
        if (!keysDistinct(model, rows)) continue;
        if (JSON.stringify(evaluate(counts, rows, params)) !== JSON.stringify([String(carried), "0"])) continue;
        if (staleDiscriminates(model, rows, params)) return rows;
      }
    }
  }
  return undefined;
}

// A threshold case discriminates when a mutant of the threshold changes its
// alerts: another operator, the value one either way, and for a zero-count
// threshold the for rows read through the INNER JOIN only.
export function thresholdDiscriminates(model, rows, params) {
  const expected = JSON.stringify(evaluate(model, rows, params));
  const {op, value} = model.threshold;
  const values = model.aggregate.is_count ? [value - 1, value + 1]
    : [stepValue(model.aggregate.type, model.threshold.canonical_value, -1), stepValue(model.aggregate.type, model.threshold.canonical_value, 1)].filter((v) => v !== undefined);
  return [...THRESHOLD_MUTANTS[op].map((other) => ({...model.threshold, op: other})),
    ...values.map((candidate) => ({...model.threshold, value: candidate, canonical_value: candidate}))]
    .some((threshold) => JSON.stringify(evaluate({...model, threshold}, rows, params)) !== expected)
    || (model.threshold.zero === true && JSON.stringify(evaluate({...model, threshold: {...model.threshold, inner: true}}, rows, params)) !== expected);
}

// A zero-count case discriminates the count reset when the mutant that
// keeps the previous for row's count changes its alerts.
export function staleDiscriminates(model, rows, params) {
  return JSON.stringify(evaluate(model, rows, params))
    !== JSON.stringify(evaluate({...model, threshold: {...model.threshold, stale: true}}, rows, params));
}

// The counts a limit's cases are built on. `fires` is the count at which the
// rule alerts nearest its threshold (a `when` comparison decides there);
// `flips` the count at which one counted row less changes the answer (a
// `where` comparison decides there, its row being one of them).
export function pivotCounts(threshold) {
  const n = threshold.value;
  switch (threshold.op) {
    case ">": return {fires: n + 1, flips: n + 1};
    case ">=": return {fires: n, flips: n};
    case "<": return {fires: n - 1, flips: n};
    case "=": return {fires: n, flips: Math.max(n, 1)};
    default: throw new Error(`threshold operator ${threshold.op}`);
  }
}

function aggregateNextZero(model, baseRows, params) {
  const type = model.aggregate.type;
  const threshold = model.threshold.canonical_value;
  const targets = [threshold, stepAggregate(type, threshold, -1), stepAggregate(type, threshold, 1), initialValue(type)]
    .filter((v, i, all) => v !== undefined && all.indexOf(v) === i);
  const forTable = model.for.table, {keys, fields} = model.ddic[forTable];
  for (const target of targets) {
    const first = sumTo(model, baseRows, target, params);
    if (!first) continue;
    const original = first[forTable][0];
    const named = [...new Set(model.alert.parts.filter((part) => !part.is_text && !part.is_count && !part.is_aggregate
      && part.alias === model.for.alias && !keys.includes(part.column)).map((part) => part.column))];
    for (const key of keys) {
      const keyType = fields[key];
      const candidates = [stepValue(keyType, original[key], 1), bump(original[key], 1),
        ...Array.from({length: 298}, (_, i) => defaultValue(keyType, i + 2))];
      for (const candidate of candidates) {
        if (candidate === undefined || compareValues(keyType, candidate, keyType, original[key]) <= 0) continue;
        const rows = clone(first);
        const second = {...original, [key]: candidate};
        for (const column of named) second[column] = different(fields[column], original[column]) ?? defaultValue(fields[column], 2);
        rows[forTable].push(second);
        if (!keysDistinct(model, rows) || !staleDiscriminates(model, rows, params)) continue;
        return rows;
      }
    }
  }
  return undefined;
}

function aggregateGroups(model, baseRows, params) {
  const type = model.aggregate.type, t = model.threshold.canonical_value;
  const below = stepAggregate(type, t, -1), above = stepAggregate(type, t, 1);
  const targets = {
    ">": [above, t], ">=": [t, below], "<": [below, t], "=": [t, above],
  }[model.threshold.op];
  if (!targets || targets.some((v) => v === undefined)) return undefined;
  const first = sumTo(model, baseRows, targets[0], params);
  const second = sumTo(model, baseRows, targets[1], params);
  if (!first || !second) return undefined;
  const forTable = model.for.table, clause = model.clauses[0];
  const fields = model.ddic[forTable].fields, keys = model.ddic[forTable].keys;
  const named = [...new Set(model.alert.parts.filter((part) => !part.is_text && !part.is_count && !part.is_aggregate
    && part.alias === model.for.alias && !keys.includes(part.column)).map((part) => part.column))];
  const original = second[forTable][0];
  for (const key of keys) {
    const keyType = fields[key];
    const candidates = [stepValue(keyType, original[key], 1), ...Array.from({length: 298}, (_, i) => defaultValue(keyType, i + 2))];
    for (const candidate of candidates) {
      if (candidate === undefined || compareValues(keyType, candidate, keyType, original[key]) === 0) continue;
      const variant = clone(second);
      const secondOuter = variant[forTable][0];
      secondOuter[key] = candidate;
      for (const column of named) secondOuter[column] = different(fields[column], original[column]) ?? defaultValue(fields[column], 2);
      // Keep the JOIN equalities true after giving the second group its own key
      // and its own alert text.
      for (const on of clause.on) {
        if (on.cmp.rhs.kind === "field" && on.cmp.rhs.alias === model.for.alias) {
          for (const row of variant[clause.table]) row[on.cmp.column] = secondOuter[on.cmp.rhs.column];
        }
      }
      const freeKey = model.ddic[clause.table].keys.find((column) =>
        !clause.on.some((on) => on.cmp.column === column));
      if (freeKey) variant[clause.table].forEach((row, i) => {
        row[freeKey] = defaultValue(model.ddic[clause.table].fields[freeKey], 800 + i);
      });
      const rows = clone(first);
      rows[forTable].push(secondOuter);
      rows[clause.table].push(...variant[clause.table]);
      if (!keysDistinct(model, rows)) continue;
      const combined = evaluate(model, rows, params);
      const separate = [...evaluate(model, first, params), ...evaluate(model, variant, params)];
      if (JSON.stringify(combined) === JSON.stringify(separate)) return rows;
    }
  }
  return undefined;
}

// Every case for the selected conditions, in rule order, then the structural
// cases of the clauses: {method, label, kind, condition, line (the rule line
// of the condition or clause), date, rows, expect, structural}. `example` is
// the raw rows of the first hand-written example, `date` its check date.
export function deriveCases(model, references, {date, params = {date}, paramArgs = [], example, reserved = new Set()}) {
  const base = baseRows(model, params, example);
  if (base.why) return {cases: [], skipped: [{condition: "(all)", reason: base.why}]};
  const cases = [], skipped = [];
  const taken = new Set(reserved);
  const name = (condition, tagCandidates, suffixes, condLine) => {
    for (const tag of tagCandidates) {
      const methods = suffixes.map((s) => `b_${tag}_${s}`);
      if (methods.every((m) => m.length <= 30 && !taken.has(m))) {
        methods.forEach((m) => taken.add(m));
        return Object.fromEntries(suffixes.map((s, i) => [s, methods[i]]));
      }
    }
    throw new Error(`cannot name the cases of ${condition} (line ${condLine}) within 30 characters`);
  };
  // `given`: a range parameter this case sets for itself ({name, rows}); the others are the first example's
  const add = (condition, line, suffix, methods, label, rows, structural = false, given = undefined) => {
    if (!keysDistinct(model, rows)) {
      skipped.push({condition: `${label} (${suffix})`, reason: "its rows would share a key"});
      return;
    }
    const own = given ? {...params, [given.name]: given.rows} : params;
    cases.push({method: methods[suffix], label: `${label}: ${suffix}`, kind: suffix, condition, line, date, rows, paramArgs,
      expect: evaluate(model, rows, own), structural, params: own, ...(given ? {given} : {})});
  };
  let index = 0;
  for (const reference of references) {
    index++;
    const cond = conditionOf(model, reference);
    const cmp = cond.cmp;
    const owner = ownerOf(model, cond);
    const table = owner.table;
    const type = model.ddic[table].fields[cmp.column];
    const isJoin = !owner.when && owner.clause.on.includes(cond);
    // rows in which this comparison alone decides its tree, and every other
    // tree holds; under require a `when` decides only when no exists row is there
    let start = clone(base.rows);
    if (owner.when && model.kind === "require") for (const clause of model.clauses) start[clause.table] = [];
    const why = solveAlternatives(model, params, start, owner.alias, owner.table, sensitize(owner.tree, owner.leaves, owner.index), true, owner.slot);
    const columnTags = [cmp.column, `${cmp.alias}_${cmp.column}`, `c${index}`];
    if (why) {
      skipped.push({condition: cond.text, reason: `does not isolate ${cond.text}: ${why}`});
      continue;
    }
    // A condition in a counted table can only change an aggregate alert when
    // the rows it admits sit on the alerting side of the threshold. Tune the
    // value first, then derive the condition's matching and nonmatching rows.
    if (!owner.when && model.kind === "limit" && !model.aggregate.is_count) {
      const aggregateType = model.aggregate.type;
      const t = model.threshold.canonical_value;
      const candidates = model.aggregate.is_sum
        ? [stepAggregate(aggregateType, t, 1), t, stepAggregate(aggregateType, t, -1), initialValue(aggregateType)]
        : [stepAggregate(aggregateType, t, 1), t, stepAggregate(aggregateType, t, -1)];
      const tuned = candidates.filter((value, i, all) => value !== undefined && all.indexOf(value) === i)
        .map((value) => model.aggregate.is_sum ? sumTo(model, start, value, params) : extremeTo(model, start, value, params))
        .find((rows) => rows && caseDiscriminates(model, cond, rows, params));
      if (tuned) start = tuned;
    }
    if (owner.when) resolveClauses(model, params, start, undefined, true);
    // a limit's comparison decides at its pivot count; a `when` whose pivot is
    // 0 is tested on a for row with no counted row at all (emptied below,
    // after the field is set)
    const pivot = model.kind === "limit" && model.aggregate.is_count
      ? pivotCounts(model.threshold)[owner.when ? "fires" : "flips"] : undefined;
    if (pivot !== undefined && pivot > 0 && !countTo(model, start, pivot, params)) {
      skipped.push({condition: cond.text, reason: pivot > COUNT_ROW_CAP
        ? `count exceeds the ${COUNT_ROW_CAP}-row derived-case cap` : "cannot make the threshold count with distinct matching keys",
        cap: pivot > COUNT_ROW_CAP, case: "all variants"});
      continue;
    }
    const setField = (value, using = params) => {
      const rows = clone(start);
      rows[table][owner.slot][cmp.column] = value;
      rejoin(model, rows, cond, owner.clause, cmp.column);
      // a changed value may break the other conditions on another row
      // (m.cnt < n.lvl): keep the tested value and adjust the other rows
      resolveClauses(model, using, rows, owner.when ? undefined : owner.clause, true);
      if (pivot === 0) rows[model.clauses[0].table] = [];
      return rows;
    };
    const isRange = cmp.rhs.kind === "range";
    const reference_value = isRange ? undefined : canonical(type, cmp.rhs.kind === "field" ? start[model.for.table][0][cmp.rhs.column]
      : rhsValue(cmp.rhs, params));
    let variants;
    // a range: a value in it, one outside it, the table emptied (every value), an E row added
    if (isRange) variants = rangeVariants({name: cmp.rhs.name, rows: params[cmp.rhs.name] ?? [], type, current: start[table][owner.slot][cmp.column],
      around: (v) => [v, isOrdered(type) ? stepValue(type, v, 1) : bump(v, 1), isOrdered(type) ? stepValue(type, v, -1) : bump(v, -1)],
      fallbacks: [defaultValue(type), initialValue(type)], canonical});
    else if (isJoin) variants = [["match", reference_value], ["nomatch", different(type, reference_value)]];
    else if (isOrdered(type)) variants = [["lt", stepValue(type, reference_value, -1)], ["eq", reference_value], ["gt", stepValue(type, reference_value, 1)]];
    else variants = [["eq", reference_value], ["ne", bump(reference_value, 1) ?? bump(reference_value, -1)],
      ...(compareValues(type, "", type, reference_value) === 0 ? [] : [["blank", ""]])];
    const methods = name(cond.text, columnTags, variants.map(([s]) => s), cond.rule_line);
    for (const [suffix, value, given] of variants) {
      if (value === undefined) {
        skipped.push({condition: cond.text, reason: !isRange ? `no ${suffix} value: the type has no step that way`
          : suffix === "out" ? "no value outside the range: an empty range holds every value" : `no ${suffix} value for the range`});
        delete methods[suffix];
        continue;
      }
      // a case that sets the range parameter itself is solved and judged with its own table
      const own = given ? {...params, [given.name]: given.rows} : params;
      const rows = setField(value, own);
      if (!caseDiscriminates(model, cond, rows, own)) {
        skipped.push({condition: `${cond.text} (${suffix})`, reason: `does not isolate ${cond.text}`});
        delete methods[suffix];
        continue;
      }
      add(reference, cond.rule_line, suffix, methods, cond.text, rows, false, given);
    }
  }

  if (model.kind === "limit" && !model.aggregate.is_count) {
    const {operation, type} = model.aggregate;
    const threshold = model.threshold.canonical_value;
    if (operation === "sum") {
      const targets = [stepAggregate(type, threshold, -1), threshold, stepAggregate(type, threshold, 1)];
      const suffixes = ["below", "at", "above"];
      const methods = name("sum threshold", [operation, "limit"], suffixes, model.threshold.rule_line);
      for (let i = 0; i < targets.length; i++) {
        if (targets[i] === undefined) {
          skipped.push({condition: `limit/${model.threshold.key}`, reason: `the ${suffixes[i]} boundary is outside the INT8 sum range`, case: suffixes[i]});
          continue;
        }
        const rows = sumTo(model, base.rows, targets[i], params);
        if (!rows) {
          skipped.push({condition: `limit/${model.threshold.key}`, reason: `cannot make the matching rows sum to ${targets[i]}`, case: suffixes[i]});
          continue;
        }
        add(`limit/${model.threshold.key}`, model.threshold.rule_line, suffixes[i], methods,
          `matching rows sum to ${targets[i]}`, rows, true);
      }
      if (model.threshold.zero) {
        const rows = clone(base.rows);
        rows[model.clauses[0].table] = [];
        const zeroMethod = name("empty sum", [operation], ["zero"], model.threshold.rule_line);
        if (thresholdDiscriminates(model, rows, params)) {
          add(`limit/${model.threshold.key}`, model.threshold.rule_line, "zero", zeroMethod, "no matching rows; sum is 0", rows, true);
        } else {
          skipped.push({condition: `limit/${model.threshold.key} (zero)`, reason: "empty sum does not discriminate the threshold"});
        }
        const next = aggregateNextZero(model, base.rows, params);
        const nextMethod = name("sum accumulator reset", [operation], ["next_zero"], model.threshold.rule_line);
        if (next) {
          add(`limit/${model.threshold.key}`, model.threshold.rule_line, "next_zero", nextMethod,
            "a nonempty sum followed by a for row with no matching rows", next, true);
        } else {
          skipped.push({condition: `limit/${model.threshold.key} (next_zero)`, reason: "cannot make a previous sum whose carried value changes the next empty group's alert"});
        }
      }
      const groups = aggregateGroups(model, base.rows, params);
      const groupsMethod = name("sum groups", [operation], ["groups"], model.threshold.rule_line);
      if (groups) {
        add(`limit/${model.threshold.key}`, model.threshold.rule_line, "groups", groupsMethod,
          "two for groups with sums on opposite sides of the threshold", groups, true);
      } else {
        skipped.push({condition: `limit/${model.threshold.key} (groups)`, reason: "cannot make two groups whose separate sums produce opposite threshold results"});
      }
    } else {
      const rows = extremeTo(model, base.rows, threshold, params);
      const methods = name(`${operation} threshold`, [operation, "limit"], ["at"], model.threshold.rule_line);
      if (!rows) {
        skipped.push({condition: `limit/${model.threshold.key} (at)`, reason: `cannot make a matching group whose ${operation} is ${threshold}`});
      } else if (!thresholdDiscriminates(model, rows, params)) {
        skipped.push({condition: `limit/${model.threshold.key} (at)`, reason: `${operation} boundary does not discriminate the threshold`});
      } else {
        add(`limit/${model.threshold.key}`, model.threshold.rule_line, "at", methods,
          `the group's ${operation} is ${threshold}`, rows, true);
      }
    }
    return {cases, skipped};
  }

  if (model.kind === "limit") {
    const n = model.threshold.value;
    // the counts on either side of the threshold, and for exactly both sides;
    // a zero-count comparison always has a case with no counted row at all
    const bounds = {
      ">": [["not_over", n], ["over", n + 1]],
      ">=": [["below", n - 1], ["at", n]],
      "<": [["below", n - 1], ["at", n]],
      "=": [...(n > 0 ? [["below", n - 1]] : []), ["at", n], ["above", n + 1]],
    }[model.threshold.op];
    if (model.threshold.zero && !bounds.some(([, count]) => count === 0)) bounds.push(["zero", 0]);
    const suffixes = bounds.map(([suffix]) => suffix), counts = bounds.map(([, count]) => count);
    const methods = name("limit threshold", ["count"], suffixes, model.threshold.rule_line);
    for (let i = 0; i < counts.length; i++) {
      const rows = clone(base.rows);
      if (!countTo(model, rows, counts[i], params)) {
        skipped.push({condition: `limit/${model.threshold.key}`, reason: counts[i] > COUNT_ROW_CAP
          ? `${counts[i]} matching rows exceed the ${COUNT_ROW_CAP}-row derived-case cap`
          : `cannot make ${counts[i]} matching rows with distinct keys`,
          cap: counts[i] > COUNT_ROW_CAP, case: suffixes[i]});
        continue;
      }
      if (!thresholdDiscriminates(model, rows, params)) {
        skipped.push({condition: `limit/${model.threshold.key}`, reason: `${counts[i]} rows do not discriminate the threshold`});
        continue;
      }
      add(`limit/${model.threshold.key}`, model.threshold.rule_line, suffixes[i], methods,
        `${counts[i]} matching rows`, rows, true);
    }
    // fewer_than / exactly: a for key with counted rows directly before, in
    // key order, a key with none, the first count chosen so that it would
    // change the second row's answer were it carried over (the count reset
    // per for row is what this case tests; the guard is the stale mutant).
    if (model.threshold.zero) {
      const carried = model.threshold.op === "<" ? n : Math.max(n, 1);
      const methods = name("limit count reset", ["count"], ["next_zero"], model.threshold.rule_line);
      const made = carried > COUNT_ROW_CAP ? undefined : nextZero(model, base.rows, carried, params);
      if (carried > COUNT_ROW_CAP) {
        skipped.push({condition: `limit/${model.threshold.key}`, reason: `${carried} matching rows exceed the ${COUNT_ROW_CAP}-row derived-case cap`,
          cap: true, case: "next_zero"});
      } else if (!made) {
        skipped.push({condition: `limit/${model.threshold.key}`, reason: "cannot make a counted for key followed by one with no counted row whose alerts tell them apart"});
      } else {
        add(`limit/${model.threshold.key}`, model.threshold.rule_line, "next_zero", methods,
          `${carried} matching rows, then a key with none`, made, true);
      }
    }
    // Exercise the transition between two for rows. The first group alerts
    // (more_than: over the threshold) and the second sits next to it without
    // alerting, so both clearing the count and detecting the new key matter.
    // For fewer_than and exactly the first group may have no counted row.
    const over = pivotCounts(model.threshold).fires;
    const at = {">": Math.max(1, n), ">=": Math.max(1, n - 1), "<": n, "=": n + 1}[model.threshold.op];
    if (over + at > COUNT_ROW_CAP) {
      skipped.push({condition: `limit/${model.threshold.key}`, reason: `two groups need ${over + at} counted rows, exceeding the ${COUNT_ROW_CAP}-row derived-case cap`,
        cap: true, case: "groups"});
    } else {
      const first = clone(base.rows), second = clone(base.rows);
      let joined = false;
      // The second group must read differently from the first in every field
      // the alert names, or the alert lines cannot tell the groups apart and
      // a mutant that never splits them goes unseen.
      const forAlias = model.for.alias;
      const alerted = model.alert.parts.filter((part) => !part.is_text && !part.is_count && part.alias === forAlias).map((part) => part.column);
      const named = [...new Set(alerted)].filter((column) => !model.ddic[model.for.table].keys.includes(column));
      const counted = model.alert.parts.some((part) => part.is_count);
      const original_row = {...second[model.for.table][0]};
      const apart = () => (alerted.length > 0 || counted) && named.every((column) =>
        compareValues(model.ddic[model.for.table].fields[column], original_row[column], model.ddic[model.for.table].fields[column], second[model.for.table][0][column]) !== 0);
      if (countTo(model, first, over, params)) {
        const outer = second[model.for.table][0];
        for (const key of model.ddic[model.for.table].keys) {
          const type = model.ddic[model.for.table].fields[key];
          const original = outer[key];
          for (let seed = 2; seed < 300 && !joined; seed++) {
            const candidate = defaultValue(type, seed);
            if (compareValues(type, original, type, candidate) === 0) continue;
            Object.assign(outer, original_row);
            outer[key] = candidate;
            for (const column of named) {
              const field = model.ddic[model.for.table].fields[column];
              const value = seed === 2 ? different(field, original_row[column]) : defaultValue(field, seed);
              if (value !== undefined) outer[column] = value;
            }
            for (const on of model.clauses[0].on) {
              if (on.cmp.rhs.kind === "field" && on.cmp.rhs.column === key && on.cmp.op === "=") {
                second[model.clauses[0].table][0][on.cmp.column] = candidate;
              }
            }
            if (countTo(model, second, at, params)) {
              const counted = model.clauses[0].table;
              const freeKey = model.ddic[counted].keys.find((column) =>
                !model.clauses[0].on.some((on) => on.cmp.column === column));
              if (freeKey) {
                const type = model.ddic[counted].fields[freeKey];
                second[counted].forEach((row, i) => { row[freeKey] = defaultValue(type, 500 + i); });
              }
              const rows = clone(first);
              rows[model.for.table].push(outer);
              rows[counted].push(...second[counted]);
              if (keysDistinct(model, rows) && evaluate(model, rows, params).length ===
                evaluate(model, first, params).length + evaluate(model, second, params).length && apart()) {
                const multi = name("limit groups", ["count"], ["groups"], model.threshold.rule_line);
                add(`limit/${model.threshold.key}`, model.threshold.rule_line, "groups", multi,
                  `${over} and ${at} matching rows in two groups`, rows, true);
                joined = true;
              }
            }
            if (!joined) {
              Object.assign(outer, original_row);
              second[model.clauses[0].table] = base.rows[model.clauses[0].table].map((row) => ({...row}));
            }
          }
          if (joined) break;
        }
      }
      if (!joined) skipped.push({condition: `limit/${model.threshold.key}`, reason: "cannot make two distinct for groups with matching counted rows whose alerts differ"});
    }
    return {cases, skipped};
  }

  // the structural cases of the clauses, each guarded like the others
  const one = model.clauses.length === 1;
  const structural = (condition, line, suffix, methods, label, rows) => {
    if (!structureDiscriminates(model, rows, params)) {
      skipped.push({condition: `${label} (${suffix})`, reason: `does not isolate ${label}`});
      return;
    }
    add(condition, line, suffix, methods, label, rows, true);
  };
  const reference = (clause) => clause["@id"].slice(model["@id"].length + 1);
  const labelOf = (clause) => `exists ${clause.table.toUpperCase()} as ${clause.alias}`;
  const baseCount = evaluate(model, base.rows, params).length;
  // two rows of a clause for one for row: the second differs in a key field,
  // by a value that still satisfies the whole where, so one alert more
  const twoRows = (clause) => {
    const inner = model.ddic[clause.table];
    for (const key of inner.keys) {
      const type = inner.fields[key];
      const first = base.rows[clause.table][slotOf(clause)][key];
      const candidates = [different(type, first), stepValue(type, first, -1), stepValue(type, first, 1), bump(first, 1), bump(first, -1)];
      for (const next of candidates) {
        if (next === undefined || compareValues(type, next, type, first) === 0) continue;
        const rows = clone(base.rows);
        rows[clause.table].push({...rows[clause.table][slotOf(clause)], [key]: next});
        if (keysDistinct(model, rows) && evaluate(model, rows, params).length === baseCount + 1) return rows;
      }
    }
    return undefined;
  };
  if (model.kind === "require") {
    const clause = model.clauses[0];
    const methods = name(`exists ${clause.table}`, ["exists"], ["zero", "one"], clause.exists_line);
    const zero = clone(base.rows);
    zero[clause.table] = [];
    structural(reference(clause), clause.exists_line, "zero", methods, labelOf(clause), zero);
    structural(reference(clause), clause.exists_line, "one", methods, labelOf(clause), clone(base.rows));
    return {cases, skipped};
  }
  const any = model.combine === "any";
  model.clauses.forEach((clause, c) => {
    const tags = one ? ["exists"] : [clause.alias, `exists${c + 1}`, `x${c + 1}`];
    const suffixes = any ? ["only", "two"] : ["zero", "two"];
    const methods = name(`exists ${clause.table}`, tags, suffixes, clause.exists_line);
    const rows = clone(base.rows);
    if (any) {
      // only this clause's row: the other clauses' rows go, a table they share
      // with this clause keeps this clause's row
      for (const other of model.clauses) {
        if (other !== clause) rows[other.table] = other.table === clause.table ? [base.rows[clause.table][slotOf(clause)]] : [];
      }
    } else {
      rows[clause.table] = [];
    }
    structural(reference(clause), clause.exists_line, suffixes[0], methods, labelOf(clause), rows);
    const two = twoRows(clause);
    if (!two) skipped.push({condition: labelOf(clause), reason: "does not isolate the exists: no second row with another key value satisfies the whole where (one alert more)"});
    else structural(reference(clause), clause.exists_line, "two", methods, labelOf(clause), two);
  });
  if (any) {
    const methods = name("every exists", ["exists"], ["zero"], model.clauses[0].exists_line);
    const rows = clone(base.rows);
    for (const clause of model.clauses) rows[clause.table] = [];
    structural("forbid/any", model.clauses[0].exists_line, "zero", methods, "no exists row", rows);
  }
  return {cases, skipped};
}
