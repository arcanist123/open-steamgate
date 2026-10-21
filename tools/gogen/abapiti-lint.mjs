// Read-only lint for the type forms abapiti cannot lower or that lie to its
// static types. Every rule is a trap met in a real step: a cast that claims a
// union arm the value may not be in, a bridge through unknown, an intersection
// alias with no shape, a map keyed by an optional read, a tuple claimed by
// cast, a probe cast with required fields, a bare `object`.
//
//   node tools/gogen/abapiti-lint.mjs [--out file.tsv] [file...]
//
//   node tools/gogen/abapiti-lint.mjs --check [--changed <ref>] [--warn]
//   node tools/gogen/abapiti-lint.mjs --update   lower counts, never raise them
//
// Without files it reads tools/gogen/*.mjs and *.ts (not *.test.mjs). TSV to
// --out (or stdout), counts per rule and per file alongside the TSV.
import {execFileSync} from "node:child_process";
import {readFileSync, readdirSync, writeFileSync} from "node:fs";
import {dirname, join, relative} from "node:path";
import {fileURLToPath} from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../..");
const BASELINE = join(here, "abapiti-lint.json");
export const RULES = ["R1 extract-cast", "R2 unknown-bridge", "R3 intersection-alias", "R4 optional-map-key", "R5 tuple-literal-cast", "R6 cast-to-probe", "R7 object-typed", "R8 typeof-namespace-member", "R9 cast-count"];
const rule = (n) => RULES[n - 1];

// A cast is a JSDoc `@type` on a parenthesized expression (JS) or `as` / `<T>` (TS).
function castOf(node) {
  if (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)) return {type: node.type, expr: node.expression, start: node.getStart()};
  if (!ts.isParenthesizedExpression(node) || !node.jsDoc?.length) return undefined;
  const tag = node.jsDoc.flatMap((d) => d.tags ?? []).find(ts.isJSDocTypeTag);
  return tag?.typeExpression ? {type: tag.typeExpression.type, expr: node.expression, start: node.jsDoc[0].getStart()} : undefined;
}
// The value under every paren, cast and non-null assertion.
function bare(node) {
  for (;;) {
    const c = castOf(node);
    if (c) node = c.expr;
    else if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) node = node.expression;
    else return node;
  }
}
const isLiteral = (n) => ts.isObjectLiteralExpression(n) || ts.isArrayLiteralExpression(n);
const unparen = (t) => (ts.isParenthesizedTypeNode(t) ? unparen(t.type) : t);
const isUnknown = (t) => unparen(t).kind === ts.SyntaxKind.UnknownKeyword;
const refName = (t) => (ts.isTypeReferenceNode(t) ? t.typeName.getText() : undefined);
const isTuple = (t) => {
  t = unparen(t);
  if (ts.isTypeOperatorNode(t)) t = unparen(t.type);
  return ts.isTupleTypeNode(t) || (ts.isArrayTypeNode(t) && isTuple(t.elementType));
};
const dataMembers = (t) => t.members.filter((m) => ts.isPropertySignature(m));
const requiredMembers = (t) => dataMembers(t).filter((m) => !m.questionToken);
const isPlainObject = (t) => t && (unparen(t).kind === ts.SyntaxKind.ObjectKeyword || /^Object$/.test(refName(unparen(t)) ?? ""));
// An alias without shape: an intersection, at the top or as an arm of a union,
// one of whose parts is an object literal type with data members.
function shapelessIntersection(t) {
  t = unparen(t);
  if (ts.isUnionTypeNode(t)) return t.types.some(shapelessIntersection);
  return ts.isIntersectionTypeNode(t) && t.types.some((p) => ts.isTypeLiteralNode(unparen(p)) && dataMembers(unparen(p)).length > 0);
}

export function lint(text, file) {
  const hits = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  const name = file;
  const namespaces = new Set(sf.statements.filter(ts.isImportDeclaration)
    .map((n) => n.importClause?.namedBindings).filter((n) => n && ts.isNamespaceImport(n)).map((n) => n.name.text));
  function visitTypeQuery(node) {
    if (!ts.isTypeQueryNode(node) || !ts.isQualifiedName(node.exprName)) return;
    let root = node.exprName;
    while (ts.isQualifiedName(root)) root = root.left;
    if (ts.isIdentifier(root) && namespaces.has(root.text)) report(8, node.getStart(), node);
  }
  const seen = new Set();
  const report = (n, start, node) => {
    const key = `${n}:${start}`;
    if (seen.has(key)) return;
    seen.add(key);
    const {line, character} = sf.getLineAndCharacterOfPosition(start);
    const snippet = text.slice(start, node.getEnd()).replace(/\s+/g, " ").slice(0, 160);
    hits.push({file: name, line: line + 1, col: character + 1, rule: rule(n), snippet});
  };

  function visitCast(node) {
    const c = castOf(node);
    if (!c) return;
    report(9, c.start, node);
    const inner = castOf(c.expr) ?? (ts.isParenthesizedExpression(c.expr) ? castOf(c.expr.expression) : undefined);
    const bridged = inner && isUnknown(inner.type);
    const value = bare(c.expr);
    const type = unparen(c.type);
    if (refName(type) === "Extract" && !isLiteral(value)) report(1, c.start, node);
    if (bridged && !isUnknown(type)) report(2, c.start, node);
    if (isTuple(type) && ts.isArrayLiteralExpression(value)) report(5, c.start, node);
    if (ts.isTypeLiteralNode(type) && requiredMembers(type).length && !isLiteral(value)) report(6, c.start, node);
  }

  // `m.has(x)` / `.get` / `.delete` keyed by an optional read.
  function visitMapKey(node) {
    if (!ts.isCallExpression(node) || node.arguments.length !== 1 || !ts.isPropertyAccessExpression(node.expression)) return;
    if (!["has", "get", "delete"].includes(node.expression.name.text)) return;
    const arg = bare(node.arguments[0]);
    if (!ts.isPropertyAccessExpression(arg) && !ts.isElementAccessExpression(arg)) return;
    const optionalChain = !!arg.questionDotToken;
    let optionalField = false;
    if (ts.isPropertyAccessExpression(arg)) {
      const view = (function viewOf(n) {
        const c = castOf(n);
        if (c) return ts.isTypeLiteralNode(unparen(c.type)) ? unparen(c.type) : undefined;
        return ts.isParenthesizedExpression(n) ? viewOf(n.expression) : undefined;
      })(arg.expression);
      optionalField = !!view?.members.some((m) => ts.isPropertySignature(m) && m.questionToken && m.name.getText() === arg.name.text);
    }
    if (optionalChain || optionalField) report(4, node.getStart(), node);
  }

  function visitObject(node) {
    const declared = (ts.isTypeAliasDeclaration(node) || ts.isVariableDeclaration(node) || ts.isParameter(node)
      || ts.isPropertySignature(node) || ts.isPropertyDeclaration(node)) ? node.type : undefined;
    if (isPlainObject(declared)) report(7, node.getStart(), node);
    if (ts.isTypeAliasDeclaration(node) && shapelessIntersection(node.type)) report(3, node.getStart(), node);
  }

  // JSDoc tags on declarations: @type / @param / @returns {object}, @typedef {A & {...}}.
  function visitDoc(node) {
    for (const doc of node.jsDoc ?? []) for (const tag of doc.tags ?? []) {
      if (ts.isParenthesizedExpression(node) && ts.isJSDocTypeTag(tag)) continue;
      const type = tag.typeExpression?.type;
      if (!type) continue;
      const hasProps = ts.isJSDocTypedefTag(tag) && doc.tags.some((t) => ts.isJSDocPropertyTag(t));
      if (isPlainObject(type) && !hasProps && (ts.isJSDocTypeTag(tag) || ts.isJSDocParameterTag(tag) || ts.isJSDocReturnTag(tag) || ts.isJSDocTypedefTag(tag))) report(7, tag.getStart(), tag);
      if (ts.isJSDocTypedefTag(tag) && shapelessIntersection(type)) report(3, tag.getStart(), tag);
      // fields of an object type written inside the comment (`{token: object}`)
      (function fields(t) {
        if (ts.isPropertySignature(t)) visitObject(t);
        ts.forEachChild(t, fields);
      })(type);
    }
  }

  (function walk(node) {
    visitCast(node);
    visitMapKey(node);
    visitObject(node);
    visitDoc(node);
    visitTypeQuery(node);
    for (const doc of node.jsDoc ?? []) {
      (function types(n) {
        visitTypeQuery(n);
        ts.forEachChild(n, types);
      })(doc);
    }
    ts.forEachChild(node, walk);
  })(sf);
  return hits;
}

/** Counts include zeros so removed forms can ratchet all the way to zero. */
export function counts(hits) {
  return Object.fromEntries(RULES.map((r) => [r, hits.filter((h) => h.rule === r).length]));
}

function main() {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return undefined;
    if (!args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    return args.splice(at, 2)[1];
  };
  const out = take("--out");
  const changed = take("--changed");
  const has = (flag) => {
    const at = args.indexOf(flag);
    if (at < 0) return false;
    args.splice(at, 1);
    return true;
  };
  const check = has("--check");
  const update = has("--update");
  const warn = has("--warn");
  if (args.some((a) => a.startsWith("--"))) throw new Error(`unknown option: ${args.find((a) => a.startsWith("--"))}`);
  if ((check && update) || ((check || update) && (out || args.length)) || (update && changed)) throw new Error("use --check [--changed <ref>] [--warn], --update, or [--out file.tsv] [file...]");
  const files = args.length ? args : readdirSync(here).sort()
    .filter((f) => /\.(mjs|ts)$/.test(f) && !f.endsWith(".test.mjs") && f !== "abapiti-lint.mjs")
    .map((f) => join(here, f));
  const measured = {};
  const hits = files.flatMap((file) => {
    const name = relative(ROOT, file).split("\\").join("/");
    const found = lint(readFileSync(file, "utf8"), name);
    measured[name] = counts(found);
    return found;
  });
  if (check || update || changed || warn) {
    // Missing baseline is an error; initialization is a deliberate generation
    // from origin/main, not a side effect of --update accepting new debt.
    const baseline = JSON.parse(readFileSync(BASELINE, "utf8"));
    if (update) {
      for (const [file, limits] of Object.entries(baseline.files)) {
        if (!measured[file]) delete baseline.files[file];
        else for (const r of RULES) limits[r] = Math.min(limits[r] ?? 0, measured[file][r]);
      }
      for (const file of Object.keys(measured)) baseline.files[file] ??= Object.fromEntries(RULES.map((r) => [r, 0]));
      writeFileSync(BASELINE, JSON.stringify(baseline, null, 2) + "\n");
      console.log("abapiti-lint: budgets lowered to what is there; new forms keep budget 0");
      return;
    }
    const git = (...a) => execFileSync("git", a, {cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"]});
    let touched;
    if (changed) {
      let mergeBase;
      try { mergeBase = git("merge-base", "HEAD", changed).trim(); } catch { /* judge the whole tree */ }
      if (mergeBase) touched = new Set(git("diff", "--name-only", "-z", mergeBase).split("\0").filter(Boolean));
      else console.error(`abapiti-lint: no merge base with ${changed} -- judging the whole tree against it`);
      // A baseline edit changes the limits even without a source edit.
      if (touched?.has("tools/gogen/abapiti-lint.json")) touched = undefined;
    }
    const errors = [], inherited = [], shrunk = [];
    for (const file of new Set([...Object.keys(measured), ...Object.keys(baseline.files)])) {
      for (const r of RULES) {
        const n = measured[file]?.[r] ?? 0, limit = baseline.files[file]?.[r] ?? 0;
        if (n > limit) (touched && !touched.has(file) ? inherited : errors).push(`${file}: ${r}: ${n} sites, budget ${limit} -- use the safe form in tools/gogen/abapiti-lint.md`);
        if (n < limit) shrunk.push(`${file}: ${r}: ${limit} -> ${n}`);
      }
    }
    if (shrunk.length) console.log(`abapiti-lint: ${shrunk.length} count(s) shrank -- run node tools/gogen/abapiti-lint.mjs --update to lower the baseline`);
    if (inherited.length) {
      console.error(`abapiti-lint: ${inherited.length} breach(es) in what this branch does not touch (on ${changed} already, not this branch's to fix):`);
      for (const e of inherited) console.error(`  ${e}`);
    }
    if (errors.length) {
      console.error(`abapiti-lint: ${errors.length} breach(es)${warn ? " (advisory)" : ""}:`);
      for (const e of errors) console.error(warn && process.env.GITHUB_ACTIONS ? `::warning title=abapiti lint::${e}` : `  ${e}`);
      process.exitCode = warn ? 0 : 1;
    } else console.log(inherited.length ? "abapiti-lint: nothing this branch touched is over its budget" : `abapiti-lint: ${Object.keys(measured).length} files, all within`);
    return;
  }
  hits.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.col - b.col);
  const tsv = hits.map((h) => `${h.file}:${h.line}:${h.col}\t${h.rule}\t${h.snippet}`).join("\n") + (hits.length ? "\n" : "");
  const byRule = counts(hits);
  const byFile = Object.entries(measured).map(([f, c]) => [f, Object.values(c).reduce((a, b) => a + b, 0)]).filter(([, n]) => n);
  const summary = [
    `${hits.length} sites in ${files.length} files`,
    ...RULES.map((r) => `${String(byRule[r]).padStart(5)}  ${r}`), "",
    ...byFile.sort((a, b) => b[1] - a[1]).map(([f, n]) => `${String(n).padStart(5)}  ${f}`),
  ].join("\n");
  if (out) { writeFileSync(out, tsv); console.log(summary); }
  else { process.stdout.write(tsv); console.error(summary); }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); }
  catch (e) { console.error(`abapiti-lint: ${e.message}`); process.exitCode = 1; }
}
