// Cut an AMDP body out of an ABAP class, with the signature it needs.
//
// Backlog B.19. The body of an AMDP method is already valid SQLScript -- that
// is the whole point of the design: HANA runs it natively and we never write
// an interpreter for a second language. So what is needed is not a
// transpiler, it is a pair of scissors and a type map.
//
//   node tools/amdp-extract.mjs <class.clas.abap> [--json] [--procedure]
//
// The body is cut by source position. abaplint #4307 is fixed in 2.120.59,
// but NativeSQL token spans lost body tails on the measured corpus.
import {readFileSync} from "node:fs";
import * as abaplint from "@abaplint/core";
import {runsAs} from "./osd-main.mjs";

/** ABAP type -> the HANA type a generated procedure declares */
const HANA_TYPE = {
  I: "INTEGER", INT4: "INTEGER", INT8: "BIGINT", INT2: "SMALLINT", INT1: "SMALLINT",
  F: "DOUBLE", STRING: "NCLOB", XSTRING: "BLOB",
  // ABAP dates/times cross an AMDP signature in their character storage
  // form. DATS/TIMS are DDIC names, not scalar SQL types accepted by HANA's
  // CREATE PROCEDURE grammar.
  D: "NVARCHAR(8)", T: "NVARCHAR(6)", DATS: "NVARCHAR(8)", TIMS: "NVARCHAR(6)",
  // the type-pool boolean everybody uses, c LENGTH 1
  ABAP_BOOL: "NVARCHAR(1)",
};

/** the HANA type of one ABAP-typed component */
export function hanaType(t) {
  const name = String(t ?? "").trim().toUpperCase();
  if (HANA_TYPE[name] !== undefined) return HANA_TYPE[name];
  // ABAP writes a length two ways: "c LENGTH 20" in a modern declaration and
  // "c(20)" in an old one, and a packed type adds DECIMALS.
  const len = /\bLENGTH\s+(\d+)/.exec(name)?.[1] ?? /^\w+\s*\(\s*(\d+)\s*\)/.exec(name)?.[1] ?? /^(?:CHAR|NUMC)(\d+)$/.exec(name)?.[1];
  const dec = /\bDECIMALS\s+(\d+)/.exec(name)?.[1];
  const base = /^([A-Z_/]+)/.exec(name)?.[1] ?? "";
  if (base === "P" || base === "DEC") return `DECIMAL(${len ?? 16}, ${dec ?? 2})`;
  if ((base === "C" || base === "CHAR" || base === "N" || base === "NUMC") && len !== undefined) return `NVARCHAR(${len})`;
  if (base === "X" || base === "XSEQUENCE") return len === undefined ? "BLOB" : `VARBINARY(${len})`;
  if (HANA_TYPE[base] !== undefined) return HANA_TYPE[base];
  return undefined; // a type we do not know: the caller decides what to do
}

// The TYPES a class declares for itself. abaplint's parsed class definition
// carries attributes, constants and methods but not local type definitions,
// and a table parameter of an AMDP method is almost always one of these --
// so this reads them out of the source. It is a small reader on purpose: a
// structure, a table of a structure, and a table of a scalar are the three
// shapes an AMDP signature can use, and anything else comes back undefined
// rather than guessed at.
export function localTypes(source) {
  const types = new Map();
  const text = source.replace(/\r/g, "");
  // BEGIN OF <name> ... END OF <name>
  for (const m of text.matchAll(/BEGIN\s+OF\s+(\w+)\s*,?([\s\S]*?)END\s+OF\s+\1/gi)) {
    const components = [];
    for (const c of m[2].matchAll(/(\w+)\s+TYPE\s+([\w\/]+(?:\s+LENGTH\s+\d+)?(?:\s+DECIMALS\s+\d+)?)/gi)) {
      components.push({name: c[1], abapType: c[2].trim()});
    }
    types.set(m[1].toUpperCase(), {kind: "structure", components});
  }
  // <name> TYPE [STANDARD|SORTED|HASHED] TABLE OF <row>
  for (const m of text.matchAll(/(\w+)\s+TYPE\s+(?:STANDARD\s+|SORTED\s+|HASHED\s+)?TABLE\s+OF\s+([\w\/]+)/gi)) {
    types.set(m[1].toUpperCase(), {kind: "table", of: m[2].toUpperCase()});
  }
  return types;
}

/** the HANA type of a parameter, resolving a class-local type when it is one */
export function parameterType(abapType, types) {
  const direct = hanaType(abapType);
  if (direct !== undefined) return direct;
  const t = types?.get(String(abapType).toUpperCase());
  if (t === undefined) return undefined;
  if (t.kind === "structure") {
    const cols = t.components.map((c) => `${c.name.toLowerCase()} ${hanaType(c.abapType) ?? "NCLOB"}`);
    return cols.length === 0 ? undefined : `TABLE(${cols.join(", ")})`;
  }
  if (t.kind === "table") {
    const row = types.get(t.of);
    if (row?.kind === "structure") {
      const cols = row.components.map((c) => `${c.name.toLowerCase()} ${hanaType(c.abapType) ?? "NCLOB"}`);
      return cols.length === 0 ? undefined : `TABLE(${cols.join(", ")})`;
    }
    const scalar = hanaType(t.of);
    return scalar === undefined ? undefined : `TABLE(value ${scalar})`;
  }
  return undefined;
}

/** the type text of a parameter: `TYPE x`, `TYPE REF TO x`, `TYPE STANDARD TABLE OF x`,
 *  `TYPE sy-mandt`, `LIKE x`, with LENGTH / DECIMALS -- REF TO and the table
 *  kind are kept in the text, so a reader downstream refuses them by name
 *  rather than reading `REF TO x` as `x` */
const TYPE_TEXT = /\b(?:TYPE|LIKE)\s+((?:REF\s+TO\s+)?(?:(?:STANDARD|SORTED|HASHED)\s+TABLE\s+OF\s+)?[\w\/]+(?:=>[\w\/]+)?(?:-[\w\/]+)*(?:\s+LENGTH\s+\d+)?(?:\s+DECIMALS\s+\d+)?)/i;
/** the literal after DEFAULT: a quoted text (with '' inside), a number, or a name such as sy-datum */
const DEFAULT_TEXT = /\bDEFAULT\s+('(?:[^']|'')*'|[-\w.]+)/i;

/** ABAP comments out, quote-aware: a `"` inside a '…' literal is text, and a
 *  `'` inside a "…" comment is a comment */
function withoutComments(source) {
  return source.split("\n").map((line) => {
    if (/^\*/.test(line)) return "";
    let quoted = false;
    for (let i = 0; i < line.length; i += 1) {
      if (line[i] === "'") quoted = !quoted;
      else if (line[i] === '"' && !quoted) return line.slice(0, i);
    }
    return line;
  }).join("\n");
}

/** split ABAP text into statements on the periods outside '…' literals */
function statementsOf(text) {
  const out = [];
  let quoted = false;
  let current = "";
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'") quoted = !quoted;
    if (ch === "." && !quoted && /\s|$/.test(text[i + 1] ?? "")) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim() !== "") out.push(current);
  return out;
}

/** The method definitions of a class, read as text: `[CLASS-]METHODS name
 *  IMPORTING value(p) TYPE t ... RETURNING value(r) TYPE t.` Used when
 *  abaplint hands back no class definition, and for a method abaplint
 *  dropped from one it did read (ANOMALY-2026-09-23-amdp-method-options).
 *  Comments and statement ends are read quote-aware; a section whose heads
 *  are not all read yields no parameters for that method -- the coverage
 *  instrument cross-checks this reader against abaplint wherever both
 *  read the class. */
export function definitionsByText(source) {
  const out = new Map();
  const direction = {importing: "IN", exporting: "OUT", changing: "INOUT", returning: "RETURNING"};
  /** split a chained `METHODS: a ..., b ....` on the commas outside parentheses and quotes */
  const chain = (body) => {
    const parts = [];
    let depth = 0;
    let quoted = false;
    let current = "";
    for (const ch of body) {
      if (ch === "'") quoted = !quoted;
      if (!quoted && ch === "(") depth += 1;
      if (!quoted && ch === ")") depth -= 1;
      if (ch === "," && depth === 0 && !quoted) {
        parts.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
    parts.push(current);
    return parts;
  };
  for (const statement of statementsOf(withoutComments(source))) {
    const m = /^\s*(?:CLASS-)?METHODS\b(:?)([\s\S]*)$/i.exec(statement);
    if (m === null) continue;
    const declarations = m[1] === ":" ? chain(m[2]) : [m[2]];
    for (const declaration of declarations) {
      const head = /^\s*([\w~]+)\b([\s\S]*)$/.exec(declaration);
      if (head === null) continue;
      const name = head[1].toUpperCase();
      const rest = head[2];
      if (/^\s*FOR\s+TABLE\s+FUNCTION/i.test(rest) || /^\s*(REDEFINITION|ABSTRACT|FINAL)?\s*$/i.test(rest)) continue;
      const params = [];
      let complete = true;
      const words = rest.replace(/\s+/g, " ").trim();
      // `AMDP OPTIONS READ-ONLY CDS SESSION CLIENT clnt` may precede the
      // sections; it lands before the first section keyword and is skipped
      const sections = words.split(/\b(IMPORTING|EXPORTING|CHANGING|RETURNING|RAISING|EXCEPTIONS)\b/i);
      for (let i = 1; i < sections.length; i += 2) {
        const current = direction[sections[i].toLowerCase()];
        if (current === undefined) continue;
        const body = sections[i + 1];
        // every `name TYPE|LIKE` head in the section must be read, or the
        // method gets no parameters at all: a partial list would compile
        // against a signature the class does not have
        const heads = [...body.matchAll(/(?:VALUE\s*\(\s*[\w\/]+\s*\)|REFERENCE\s*\(\s*[\w\/]+\s*\)|\b[\w\/]+)\s+(?:TYPE|LIKE)\b/gi)].length;
        let read = 0;
        for (const p of body.matchAll(new RegExp(`(?:VALUE\\s*\\(\\s*([\\w\\/]+)\\s*\\)|REFERENCE\\s*\\(\\s*([\\w\\/]+)\\s*\\)|\\b([\\w\\/]+))\\s+${TYPE_TEXT.source.slice(2)}((?:\\s+(?:OPTIONAL|DEFAULT\\s+(?:'(?:[^']|'')*'|[-\\w.]+)))*)`, "gi"))) {
          const pname = p[1] ?? p[2] ?? p[3];
          if (/^(IMPORTING|EXPORTING|CHANGING|RETURNING|OPTIONAL|DEFAULT|TYPE|LIKE)$/i.test(pname)) continue;
          const modifiers = p[5] ?? "";
          const defaultText = DEFAULT_TEXT.exec(modifiers)?.[1];
          params.push({name: pname, direction: current, abapType: p[4].trim(), optional: /\bOPTIONAL\b/i.test(modifiers),
            ...(defaultText === undefined ? {} : {default: defaultText})});
          read += 1;
        }
        if (read !== heads) complete = false;
      }
      if (!out.has(name)) out.set(name, complete ? params : []);
    }
  }
  return out;
}

export function extract(source, filename = "x.clas.abap", extraTypeSources = []) {
  const reg = new abaplint.Registry()
    .addFile(new abaplint.MemoryFile(filename, source)).parse();
  const obj = reg.getFirstObject();
  if (obj === undefined) throw new Error("nothing parsed out of " + filename);
  const file = obj.getABAPFiles()[0];
  const lines = source.split("\n");

  // The method definitions, so a body can be given its parameters. abaplint
  // gives the name and the direction of each parameter but not its type --
  // the type needs a resolved registry with the DDIC in it, which we do not
  // have for a class read off a system. The token's own row is enough: the
  // type text is on that line of the definition, and reading it there is
  // exact rather than a guess.
  const defs = new Map();
  const direction = {importing: "IN", exporting: "OUT", changing: "INOUT", returning: "RETURNING"};
  const classDefinition = obj.getClassDefinition?.();
  const definitionSource = classDefinition === undefined ? "text" : "abaplint";
  /** methods whose signature the text reader supplied, by name */
  const byText = new Set();
  const textDefinitions = definitionsByText(source);
  if (classDefinition === undefined) {
    // abaplint could not read the class definition -- on a class off a
    // system that is an AMDP OPTIONS clause it does not know, in the
    // implementation (ANOMALY-2026-09-23-amdp-method-options) -- and then
    // every method had no parameters, so a body's own IN table looked
    // like an unknown variable. The definition text is still there.
    for (const [name, params] of textDefinitions) {
      defs.set(name, params);
      byText.add(name);
    }
  }
  for (const m of classDefinition?.methods ?? []) {
    const params = [];
    const methodParameters = m.parameters ?? [];
    for (const [index, p] of methodParameters.entries()) {
      // getStart(), not .start: core 2.120.94 made a token its own position
      // and dropped the field, which left every parameter without a row
      const at = p.identifier?.token?.getStart?.();
      const row = at?.getRow?.();
      const line = row === undefined ? "" : (lines[row - 1] ?? "");
      // The token position is authoritative. Searching the line for the
      // parameter text can hit the same spelling inside the method name.
      const start = Math.max(0, Number(at?.getCol?.() ?? 1) - 1);
      const next = methodParameters[index + 1]?.identifier?.token?.getStart?.();
      // `OPTIONAL` belongs to this parameter only. Method declarations may
      // put several VALUE(...) parameters on one line, so scanning to EOL
      // lets a later OPTIONAL silently relax every earlier required input.
      const end = next !== undefined && row !== undefined && next.getRow() === row ? Math.max(start, Number(next.getCol()) - 1) : undefined;
      const after = line.slice(start, end);
      // A double quote starts an ABAP comment. Words in that prose are not
      // declaration modifiers (`" not OPTIONAL` must stay required).
      const declaration = after.split('"', 1)[0];
      // a type text may be a table field, `sy-mandt` / `spfli-carrid`: the
      // cross-check against the text reader found this regex cutting them
      // to `SY` and `SPFLI` (27 methods on the A4H export, 2026-09-23)
      const typeMatch = TYPE_TEXT.exec(declaration);
      const abapType = typeMatch?.[1] ?? "";
      const modifiers = typeMatch === null ? "" : declaration.slice(typeMatch.index + typeMatch[0].length);
      // OPTIONAL is a flag; DEFAULT is a value, carried as the text of its
      // literal so the compiler can put THAT into the program -- an omitted
      // DEFAULT 10 filled with the initial value 0 answered [] where HANA
      // answered every row (foreman-dell's probe, 2026-09-23)
      const defaultText = DEFAULT_TEXT.exec(modifiers)?.[1];
      params.push({name: p.name, direction: direction[p.direction] ?? "IN", abapType: abapType.trim(),
        optional: /\bOPTIONAL\b/i.test(modifiers), ...(defaultText === undefined ? {} : {default: defaultText})});
    }
    defs.set(String(m.name).toUpperCase(), params);
  }
  // the same clause in the DEFINITION (`METHODS m AMDP OPTIONS READ-ONLY
  // IMPORTING ...`) drops that one method from abaplint's class definition
  // while the rest survive; the text reader has it, and says so (this is
  // the second place the reader feeds amdp-gen, not only a missing classdef)
  if (classDefinition !== undefined) {
    for (const [name, params] of textDefinitions) {
      if (!defs.has(name) && params.length > 0) {
        defs.set(name, params);
        byText.add(name);
      }
    }
  }

  // `CLASS-METHODS get_x FOR TABLE FUNCTION p_x_tf.` -- a method whose
  // signature is not in the class at all but in the DDLS it names. abaplint
  // gives such a method no parameters; the name of the DDLS is what the
  // caller needs to go and read them (tools/sqlscript/table-function-ddls.mjs).
  const tableFunctions = new Map();
  for (const st of file.getStatements()) {
    if (st.get().constructor.name !== "MethodDef") continue;
    const m = /METHODS\s+([\w~]+)\s+FOR\s+TABLE\s+FUNCTION\s+([\w\/]+)/i.exec(st.concatTokens());
    if (m !== null) tableFunctions.set(m[1].toUpperCase(), m[2].toUpperCase());
  }

  // The database methods are cut out of the TEXT, not out of abaplint's
  // statements: from `METHOD m BY DATABASE ...` to the first line that is
  // `ENDMETHOD.`. abaplint lexes a SQLScript body as ABAP, and a body can
  // put its lexer into a state where the rest of the method is one token a
  // line -- `endmethod.` among them -- so two methods came out as one and
  // the second was lost (a corpus class whose SQLScript comment ends in
  // `] ) }`; HANA then refused the merged body "near <the next method>").
  // Searched in copies with the ABAP comments blanked, offset for offset:
  // a `*` line inside a USING list is not a table, a header in a comment is
  // none. `"` is blanked only where the header is looked for -- in a
  // SQLScript body it opens a quoted name, not a comment. The body is cut
  // from the source itself, and ends at the LAST `ENDMETHOD` (pragmas
  // allowed) before the next METHOD or ENDCLASS: an `ENDMETHOD.` in a
  // comment of the body comes earlier, and `x = 1; ENDMETHOD.` or
  // `ENDMETHOD ##NEEDED.` still end it. No ENDMETHOD before that boundary:
  // the method is left out rather than merged with the next.
  const out = [];
  const starless = source.split("\n").map((line) => (line.startsWith("*") ? " ".repeat(line.length) : line)).join("\n");
  const blanked = starless.split("\n").map((line) => line.replace(/"[^\n]*$/, (c) => " ".repeat(c.length))).join("\n");
  const headerAt = /^[ \t]*METHOD\s+([\w\/~]+)\s+BY\s+DATABASE\s+(PROCEDURE|FUNCTION)\b[^.]*\./gim;
  for (const header of blanked.matchAll(headerAt)) {
    const text = header[0];
    const bodyStart = header.index + text.length;
    const rest = starless.slice(bodyStart);
    const boundary = /^[ \t]*(?:METHOD\s|ENDCLASS\b)/im.exec(rest);
    const region = boundary === null ? rest : rest.slice(0, boundary.index);
    const ends = [...region.matchAll(/\bENDMETHOD(?:\s+##\w+)*\s*\./gi)];
    if (ends.length === 0) continue;
    const body = source.slice(bodyStart, bodyStart + ends.at(-1).index).trim();
    const name = header[1];
    const tableFunction = tableFunctions.get(name.toUpperCase());
    out.push({
      name,
      // PROCEDURE or FUNCTION: a table function becomes CREATE FUNCTION ...
      // RETURNS TABLE(...) in HANA, not a procedure with an OUT parameter
      dbKind: header[2].toUpperCase(),
      forDb: /FOR\s+(\w+)/i.exec(text)?.[1] ?? "",
      language: /LANGUAGE\s+(\w+)/i.exec(text)?.[1] ?? "",
      readOnly: /OPTIONS\s+READ-ONLY/i.test(text),
      usings: (/\bUSING\b([^.]*)/i.exec(text)?.[1] ?? "").split(/[\s,]+/).filter(Boolean),
      body, parameters: defs.get(name.toUpperCase()) ?? [],
      signatureSource: byText.has(name.toUpperCase()) ? "text" : definitionSource,
      ...(tableFunction === undefined ? {} : {tableFunction}),
    });
  }
  // Types an AMDP signature uses are often not in the class: the Z80 CPU
  // keeps them in ZIF_Z80_00_AMDP_TYPES. Extra sources contribute theirs, and
  // the class's own win a name they share.
  const types = new Map();
  for (const extra of extraTypeSources) for (const [k, v] of localTypes(extra)) types.set(k, v);
  for (const [k, v] of localTypes(source)) types.set(k, v);
  return {className: obj.getName(), methods: out, types, definitionSource};
}

/**
 * The text reader against abaplint, on a class abaplint does read: the
 * methods whose parameter lists (name, direction, type text, OPTIONAL)
 * differ. Zero is what makes the text reader trustworthy where it is the
 * only source (ANOMALY-2026-09-23-amdp-method-options); a difference is
 * counted by the instrument and never decided at runtime.
 */
export function definitionsDisagree(source, filename = "x.clas.abap") {
  const parsed = extract(source, filename);
  if (parsed.definitionSource !== "abaplint") return {compared: 0, differing: []};
  const byText = definitionsByText(source);
  const differing = [];
  let compared = 0;
  const shape = (params) => params.map((p) => `${String(p.name).toUpperCase()} ${p.direction} ${String(p.abapType).toUpperCase().replace(/\s+/g, " ")}${p.optional ? " OPTIONAL" : ""}`).join("; ");
  for (const m of parsed.methods) {
    if (m.signatureSource === "text") continue;
    const text = byText.get(String(m.name).toUpperCase());
    if (text === undefined) continue;
    compared += 1;
    if (shape(m.parameters) !== shape(text)) differing.push({method: m.name, abaplint: shape(m.parameters), text: shape(text)});
  }
  return {compared, differing};
}

/** the CREATE PROCEDURE a cut body needs in order to run in HANA */
export function procedure(cls, m, schema, types) {
  const args = m.parameters.map((p) => {
    const t = parameterType(p.abapType, types);
    // The disposable oracle wrapper is always a procedure. An ABAP database
    // function's scalar RETURNING value is therefore represented as the
    // equivalent OUT parameter; its tracked body remains byte-for-byte the
    // same assignment.
    if (p.direction === "RETURNING" && /^TABLE\s*\(/i.test(t ?? "")) {
      throw new Error("the disposable procedure oracle supports scalar RETURNING only");
    }
    const direction = p.direction === "RETURNING" ? "OUT" : p.direction;
    return `${direction} ${p.name.toLowerCase()} ${t ?? `/* unmapped: ${p.abapType} */`}`;
  });
  const name = `"${schema}"."${cls}=>${m.name.toUpperCase()}"`;
  return [
    `CREATE PROCEDURE ${name} (${args.join(", ")})`,
    `  LANGUAGE ${m.language || "SQLSCRIPT"}`,
    `  SQL SECURITY INVOKER`,
    m.readOnly ? "  READS SQL DATA" : "",
    `AS BEGIN`,
    m.body,
    `END;`,
  ].filter((x) => x !== "").join("\n");
}

if (runsAs("amdp-extract.mjs")) {
  const args = process.argv.slice(2);
  const path = args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--types");
  if (path === undefined) { console.error("usage: node tools/amdp-extract.mjs <class.clas.abap> [--types <file>]... [--json] [--procedure]"); process.exit(2); }
  const extras = args.map((a, i) => (a === "--types" ? args[i + 1] : undefined)).filter(Boolean).map((f) => readFileSync(f, "utf8"));
  const result = extract(readFileSync(path, "utf8"), path.split("/").pop(), extras);
  if (process.argv.includes("--json")) { console.log(JSON.stringify(result, undefined, 2)); }
  else if (process.argv.includes("--procedure")) {
    for (const m of result.methods) console.log(procedure(result.className, m, process.env.HXE_SCHEMA ?? "OSD", result.types) + "\n");
  } else {
    console.log(`${result.className}: ${result.methods.length} AMDP method(s)`);
    for (const m of result.methods) {
      const unmapped = m.parameters.filter((p) => parameterType(p.abapType, result.types) === undefined);
      console.log(`  ${m.name}  FOR ${m.forDb} ${m.language}${m.readOnly ? " READ-ONLY" : ""}` +
        `  ${m.parameters.length} parameter(s)${unmapped.length ? `, ${unmapped.length} unmapped` : ""}` +
        `  body ${m.body.split("\n").length} lines`);
      for (const p of m.parameters) console.log(`      ${p.direction.padEnd(5)} ${p.name.toLowerCase().padEnd(14)} ${p.abapType} -> ${parameterType(p.abapType, result.types) ?? "?"}`);
    }
  }
}
