// Lower only token sequences: ABAP comments, literals and templates stay intact.
// Preserve newlines so a source map still names the original source row.
import {Lexer} from "@abaplint/core/build/src/abap/1_lexer/lexer.js";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {MemoryFile} from "@abaplint/core";
export function readRapBindings(root, onRead) {
  const file = join(root, "gen/rap/bindings.json");
  if (!existsSync(file)) return {};
  const bytes = readFileSync(file);
  onRead?.(file, bytes);
  return JSON.parse(bytes.toString("utf8"));
}
// R3: the handler method forms written on a system, without parameter types:
//   METHODS m FOR DETERMINE ON MODIFY|SAVE IMPORTING keys FOR ent~det.
//   METHODS m FOR VALIDATE ON SAVE IMPORTING keys FOR ent~val.
//   METHODS m FOR MODIFY IMPORTING k FOR ACTION ent~act [RESULT r]
//                                  e FOR CREATE|UPDATE ent  k FOR DELETE ent ...
//   METHODS m FOR READ IMPORTING keys FOR READ ent RESULT result.
//   METHODS m FOR LOCK IMPORTING keys FOR LOCK ent.
// Each becomes an explicit signature over the BDEF's derived types (the
// pool-scoped bindings bdef-gen writes), with the implicit response
// parameters the form has: FAILED / REPORTED / MAPPED (EARLY), CHANGING.
const RESPONSES = {DETERMINE: ["reported"], VALIDATE: ["failed", "reported"], MODIFY: ["mapped", "failed", "reported"],
  READ: ["failed", "reported"], LOCK: ["failed", "reported"]};
// forms a system knows that are not lowered: named in the refusal
const REFUSED = ["NUMBERING", "INSTANCE", "GLOBAL", "PRECHECK", "FEATURES", "AUTHORIZATION", "DETERMINE", "VALIDATE", "MODIFY", "READ", "LOCK", "BEHAVIOR"];
const ident = "[A-Za-z_/%][A-Za-z0-9_/%]*";

/** the pool a class file belongs to: #dmo#bp_x.clas.locals_imp.abap -> /DMO/BP_X */
export function poolOf(filename) {
  const m = /^(.+?)\.clas\.(?:locals_imp\.|locals_def\.)?abap$/i.exec(filename.split(/[\\/]/).pop());
  return m ? m[1].replaceAll("#", "/").toUpperCase() : undefined;
}

function parseForm(text, where) {
  const fail = why => { throw new Error(`${where}: RAP handler form not lowered: ${why} (METHODS ... FOR ${text})`); };
  const re = (r, t = text) => new RegExp(`^${r}$`, "i").exec(t);
  let m;
  if ((m = re(`DETERMINE ON (MODIFY|SAVE) IMPORTING (${ident}) FOR (${ident})~(${ident})`))) {
    return {form: "DETERMINE", on: m[1].toUpperCase(), clauses: [{param: m[2], kind: "DETERMINATION", entity: m[3], name: m[4]}]};
  }
  if ((m = re(`VALIDATE ON SAVE IMPORTING (${ident}) FOR (${ident})~(${ident})`))) {
    return {form: "VALIDATE", clauses: [{param: m[1], kind: "VALIDATION", entity: m[2], name: m[3]}]};
  }
  if ((m = re(`READ IMPORTING (${ident}) FOR READ (${ident}) RESULT (${ident})`))) {
    return {form: "READ", clauses: [{param: m[1], kind: "READ", entity: m[2], result: m[3]}]};
  }
  if ((m = re(`LOCK IMPORTING (${ident}) FOR LOCK (${ident})`))) {
    return {form: "LOCK", clauses: [{param: m[1], kind: "LOCK", entity: m[2]}]};
  }
  if ((m = re("MODIFY IMPORTING (.+)"))) {
    const clauses = [];
    let rest = m[1];
    while (rest) {
      let c;
      if ((c = re(`(${ident}) FOR ACTION (${ident})~(${ident})(?: RESULT (${ident}))?(?: (.*))?`, rest))) {
        clauses.push({param: c[1], kind: "ACTION", entity: c[2], name: c[3], result: c[4]}); rest = c[5];
      } else if ((c = re(`(${ident}) FOR (CREATE|UPDATE|DELETE) (${ident})(?: (.*))?`, rest))) {
        clauses.push({param: c[1], kind: c[2].toUpperCase(), entity: c[3]}); rest = c[4];
      } else fail(`'${rest}' (create by association, functions and the other FOR MODIFY clauses are outside R3)`);
    }
    return {form: "MODIFY", clauses};
  }
  const words = text.split(" ").map(x => x.toUpperCase());
  if (words[0] === "INSTANCE" || words[0] === "GLOBAL") fail(`${words.slice(0, 2).join(" ")} has no derived request/result types yet`);
  if (["NUMBERING", "PRECHECK"].includes(words[0])) fail(`FOR ${words[0]} is outside R3`);
  fail("unsupported clause");
}

/**
 * The implicit handler declarations of an ABAP source: per method, its class,
 * the form, the clauses (parameter, kind, entity, name, result) and the
 * parameters it implies, each with its role and direction. Token offsets
 * locate the text from FOR to the end of the declaration.
 */
export function implicitHandlers(source, filename) {
  if (!/\.abap$/i.test(filename) || !/\bFOR\b/i.test(source)) return [];
  const all = new Lexer().run(new MemoryFile(filename, source)).tokens;
  const tokens = all.filter(t => t.constructor.name !== "Comment");
  const w = i => tokens[i]?.getStr().toUpperCase();
  const out = [];
  let cls, inMethods = false, start = -1;
  for (let i = 0; i < tokens.length; i++) {
    if (w(i - 1) === "." || i === 0) inMethods = false;
    if ((i === 0 || w(i - 1) === ".") && w(i) === "CLASS" && w(i + 2) === "DEFINITION") cls = tokens[i + 1].getStr().toLowerCase();
    if ((i === 0 || w(i - 1) === ".") && w(i) === "METHODS") { inMethods = true; start = i + (w(i + 1) === ":" ? 2 : 1); i = start - 1; continue; }
    if (!inMethods || i !== start) continue;
    // one declaration: tokens[start] is the method name, up to "," or "."
    let end = start;
    while (end < tokens.length && ![".", ","].includes(w(end))) end++;
    start = end + 1;
    if (w(i + 1) !== "FOR" || !REFUSED.includes(w(i + 2))) { i = end; if (w(end) === ".") inMethods = false; continue; }
    const text = tokens.slice(i + 2, end).map(t => t.getStr()).join(" ").replace(/\s*([\\~])\s*/g, "$1");
    const where = `${filename}:${tokens[i].getStart().getRow()}`;
    const parsed = parseForm(text, where);
    const params = [];
    for (const c of parsed.clauses) {
      params.push({name: c.param.toLowerCase(), direction: "importing", role: ["CREATE", "UPDATE"].includes(c.kind) ? "entities" : "keys", clause: c, of: "import"});
      if (c.result) params.push({name: c.result.toLowerCase(), direction: "changing", role: "result", clause: c, of: "result"});
    }
    for (const r of RESPONSES[parsed.form]) params.push({name: r, direction: "changing", role: r});
    const names = params.map(p => p.name);
    if (new Set(names).size !== names.length) throw new Error(`${where}: RAP handler parameters named twice (${names.join(", ")})`);
    out.push({cls, method: tokens[i].getStr().toLowerCase(), ...parsed, params, where, tokens: [tokens[i + 1], tokens[end - 1]], all});
    i = end;
    if (w(end) === ".") inMethods = false;
  }
  return out;
}

function lowerImplicit(source, filename, bindings) {
  const handlers = implicitHandlers(source, filename);
  if (!handlers.length) return source;
  const pool = poolOf(filename);
  const lines = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lines.push(i + 1);
  const offset = t => lines[t.getStart().getRow() - 1] + t.getStart().getCol() - 1;
  const changes = [];
  for (const h of handlers) {
    if (!pool) throw new Error(`${h.where}: RAP handler form outside a class pool`);
    const type = key => {
      const found = bindings[`POOL ${pool} FOR ${key}`.toUpperCase()];
      if (!found) throw new Error(`${h.where}: unresolved RAP handler type ${key} (no behavior definition with implementation in class ${pool} declares it)`);
      return found;
    };
    const typeOf = p => {
      if (!p.clause) return type(`RESPONSE ${p.role}`);
      const c = p.clause;
      if (c.kind === "ACTION") return type(`ACTION ${p.of === "result" ? "RESULT" : "IMPORT"} ${c.entity}~${c.name}`);
      if (c.kind === "READ") return type(`READ ${p.of === "result" ? "RESULT" : "IMPORT"} ${c.entity}`);
      return type(`${c.kind} ${c.entity}`);
    };
    const group = d => h.params.filter(p => p.direction === d).map(p => `${p.name} TYPE ${typeOf(p)}`).join(" ");
    let text = "";
    if (group("importing")) text += `IMPORTING ${group("importing")}`;
    if (group("changing")) text += `${text ? " " : ""}CHANGING ${group("changing")}`;
    // from the FOR to the end of the declaration; rows and comments are kept
    // where they were, for the source map
    const [first, last] = h.tokens;
    const start = offset(first), end = offset(last) + last.getStr().length;
    const rows = source.slice(start, end).split("\n").map(() => "");
    rows[0] = text;
    for (const t of h.all.filter(t => t.constructor.name === "Comment" && offset(t) >= start && offset(t) < end)) {
      rows[t.getStart().getRow() - first.getStart().getRow()] += ` ${t.getStr()}`;
    }
    changes.push({start, end, text: rows.join("\n")});
  }
  for (const c of changes.reverse()) source = source.slice(0, c.start) + c.text + source.slice(c.end);
  return source;
}

export function lowerDerived(source, filename, bindings) {
  if (!filename.endsWith(".abap") || !/\bFOR\b/i.test(source)) return source;
  source = lowerImplicit(source, filename, bindings);
  const allTokens = new Lexer().run(new MemoryFile(filename, source)).tokens;
  const tokens = allTokens.filter(t => t.constructor.name !== "Comment");
  const lines = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") lines.push(i + 1);
  const offset = t => lines[t.getStart().getRow() - 1] + t.getStart().getCol() - 1;
  const changes = [];
  const word = i => tokens[i]?.getStr().toUpperCase();
  for (let i = 0; i < tokens.length; i++) {
    if (word(i) !== "TYPE" || !["TABLE", "STRUCTURE", "RESPONSE", "REQUEST"].includes(word(i + 1)) || word(i + 2) !== "FOR") continue;
    let found;
    // Longest binding first: qualified entity/action names consist of several tokens.
    for (let end = i + 3; end < tokens.length && end < i + 18; end++) {
      const slice = tokens.slice(i + 1, end + 1);
      const key = slice.map(t => t.getStr()).join(" ").replace(/\s*([\\~])\s*/g, "$1").toUpperCase();
      if (bindings[key]) found = {end, type: bindings[key]};
      if ([".", ","].includes(word(end))) break;
    }
    if (!found) throw new Error(`${filename}:${tokens[i].getStart().getRow()}: unsupported or unresolved RAP derived type`);
    const start = offset(tokens[i + 1]), end = offset(tokens[found.end]) + tokens[found.end].getStr().length;
    const original = source.slice(start, end);
    const comments = allTokens.filter(t => t.constructor.name === "Comment" && offset(t) >= start && offset(t) < end);
    // Keep comment text on its original line; never move code after an inline comment.
    const rows = original.split("\n").map(() => "");
    rows[0] = found.type;
    for (const comment of comments) rows[comment.getStart().getRow() - tokens[i + 1].getStart().getRow()] += ` ${comment.getStr()}`;
    changes.push({start, end, text: rows.join("\n")}); i = found.end;
  }
  for (const c of changes.reverse()) source = source.slice(0, c.start) + c.text + source.slice(c.end);
  return source;
}
