// What a validation finding names, when the structural pass cannot name it
// -- the TEXT FALLBACK of the closure walk (H5x-2), beside the loop:
// tools/hana-closure.mjs stays the loop, this file is its own package so the
// size budget stays honest.
//
// H5x-2 moved the names to structure: tools/hana-closure-graph.mjs's
// references() runs one SyntaxLogic pass per island object and returns every
// unknown the scope result records -- the `contains unknown: X not found`
// type lookups (with the fix keyword that preserves the DTEL/DOMA split),
// `Could not resolve top` / `unable to resolve` type chains, void object
// references, missing INTERFACES, `X unknown` type errors -- plus the
// definition-statement carriers the scope does not record: the missing
// SUPERCLASS and the GLOBAL FRIENDS names, read off the parsed CLASS
// DEFINITION statement. Those branches are GONE from this classifier; what
// stays is exactly what the report measured structure cannot carry
// (graph-closure/REPORT.md §3):
// - the SELECT shapes: `Database table or view "x" not found` and `field not
//   part of structure x-comp` -- a SELECT's table is in no scope carrier
//   (the INTO variable's error names none);
// - statement-level class references, which never become a variable/type or
//   a recorded reference: `Unknown class x`, `Class x not found`,
//   `CATCH/RAISE, unknown class CX_*`, `TYPE "x" not found`;
// - `Interface X unknown` (an INTERFACES statement): the structural pass
//   reads the statement since H5x-4 B1 -- in a class and inside an
//   interface definition, where the checker records nothing -- and this
//   branch is the fallback for a finding no reference carried. (A
//   `Could not resolve top X` off an interface's METHODS parameter is
//   structural since B1 as well; without a reference it stays
//   unclassified, visible, as before);
// - `resolveConstantValue, not found: X` (a constant default off an absent
//   object records nothing in the scope);
// - `Target type unknown, <name>`, which names the statement's target
//   VARIABLE -- a local variable's name is a cascade, counted, never asked;
// - the function-group dialect error (the name is the file's own);
// - the member cascades, counted, never asked -- the object they name is
//   usually among references(), the member is text-only. A missing
//   superclass or friend wording is counted here too: both names travel
//   structurally, the text adds nothing to ask.
// Findings the structural pass already carries are matched to their
// reference by file and line (tools/hana-closure.mjs) and never reach this
// classifier, so a deleted branch going back would mean a carrier the
// probes did not measure -- the unclassified list says so instead of
// silently dropping it.
//
// The exclusion decision is the graph analysis
// (tools/hana-closure-graph.mjs, graphDecide) since H5x-2; #933's
// exclusionDecisions/statusOf are deleted, no two machineries. This file
// keeps only the hold rule (exclusionCandidates): a file whose definition
// material is decided this round keeps its stubs back so the decision sees
// it whole.

// ------------------------------------------------------------ findings ----

// one line of the validation's own words: `rule, message[, fix], file:line`
// -- the fix and the message both carry commas, so the split is anchored on
// the tail: a fix is a single word, and the file is a comma-free,
// space-free, colon-free path followed by a line number. The build's log
// prefix (`osd-build: FAILED: `) is tolerated, so a build log parses the
// same way the thrown error does.
const FINDING = /^([a-z_]+), (.*?)(?:, ([A-Za-z][A-Za-z0-9_]*))?, ([^,\s:]+):(\d+)$/;

/** the findings of a validation message, in order, as
 *  {rule, message, fix, file, line, raw}. Lines that are not findings --
 *  build chatter, empty lines -- are dropped; classifying them is
 *  classifyFindings's job. Pure. */
export function parseFindings(message) {
  const findings = [];
  for (const raw of String(message ?? "").split("\n")) {
    const line = raw.replace(/^(?:osd-build|osd): FAILED: /, "");
    const m = FINDING.exec(line);
    if (m !== null) {
      findings.push({rule: m[1], message: m[2], fix: m[3], file: m[4], line: Number(m[5]), raw: line});
    }
  }
  return findings;
}

const NAME = "[A-Za-z0-9_/#$]+";

// a local variable's name, by the ABAP naming convention: LV_/LS_/LT_/LR_
// and the scope-letter families, every object ref *O_, RI_, CH_, ME_ (the
// bed asked five of these as TTYP under the Target type wording -- the name
// is the statement's target VARIABLE, never a type)
const LOCAL_VARIABLE = /^(?:[A-Z]O_|[LGECIRSA](?:V|S|T|R)_|RI_|CH_|ME_)/;

/** the counted-cascade tag of a message, or undefined: the wordings whose
 *  name is not the thing that is missing -- and, since H5x-2, the super and
 *  friend wordings whose names travel structurally. The loop's decision
 *  material reads the tag to keep a friend or superclass wording from
 *  reading as a nameless root (the strip and the graph handle both). */
export const cascadeOf = (message) => [
  [/^Method (?:or attribute )?"[^"]*" not found$/, "method"],
  [/^Component "[^"]*" not found in structure$/, "component"],
  [/^Not an object reference/, "reference"],
  [/^"[^"]*" not found$/, "fugr-signature"],
  [/not a table type [A-Za-z0-9_/#$]+$/, "local-type"],
  [/ not found in class or interface$/, "local-type"],
  [/contains unknown: Select, [A-Za-z]+ not found$/, "select-type"],
  [/contains unknown: Type error,/, "type-error"],
  // cascades of an unknown type or class (the name in them is not the thing
  // that is missing)
  [/^Definition for "[^"]*" not found in scope\([A-Za-z]+\)$/, "scope"],
  [/^Method parameter type not(?: compatible)?$/, "param-type"],
  [/^[^,]+ cannot be instantiated, class is defined as(?: protected)?$/, "protected"],
  // the type-error wording of a void type (`X unknown`): missing, the
  // structural pass carries the name; present-but-red, it is that object's
  // own red. Counted either way, never asked
  [/^[A-Za-z0-9_/#$]+ unknown$/, "unknown-type"],
  // the superclass and friend wordings: both names travel structurally (the
  // CLASS DEFINITION statement's INHERITING FROM and GLOBAL FRIENDS); the
  // text adds nothing to ask
  [/^Super class "[^"]+" not found or contains(?: errors)?$/, "super"],
  [/^Friend class [^ ]+ does not exist$/, "friend"],
].find(([re]) => re.test(message))?.[1];

// an abapGit file name's object part to the name it stands for: the
// namespace is escaped as #ns#, one rule for both directions
// (tools/hana-ddic-map.mjs abapGitFileName)
export const nameFromAbapFile = (part) => part.replace(/^#([^#]+)#/, "/$1/").toUpperCase();
// INTF or CLAS is a NAME-PREFIX heuristic (`if*` -> INTF, anything else
// CLAS), not a TADIR lookup: on the measured log every name in these shapes
// is IF_*, so it is correct there, but a dictionary object dragged into a
// type chain would be asked as CLAS and come back as a wrong-kind gap (the
// dumper answers what the TADIR kind names, and reports the rest missing).
const objectKind = (name) => (/^if/i.test(name) ? "intf" : "clas");

/** what the fallback asks for: `names` carries every requestable name with
 *  its kind and the first finding that named it, in first-named order,
 *  de-duplicated; `cascades` counts the findings whose name is not the
 *  thing that is missing (or whose name travels structurally); the
 *  `unclassified` raw lines are the ones this classifier has no shape for,
 *  so a new transpiler wording is visible instead of silently dropped.
 *  Pure. */
export function classifyFindings(findings) {
  const names = [];
  const seen = new Set();
  let cascades = 0;
  const unclassified = [];
  const ask = (name, kind, finding) => {
    if (/^[A-Z0-9_/#$]+$/.test(name) === false || seen.has(name)) return;
    seen.add(name);
    // the message rides beside the raw line: the SHLP decision reads the
    // message only, never the raw's file name
    names.push({name, kind, finding: finding.raw, message: finding.message});
  };
  for (const finding of findings) {
    const {message, fix, file} = finding;
    let m;
    if ((m = new RegExp(`^Database table or view "(${NAME})" not found$`).exec(message))) {
      ask(m[1].toUpperCase(), "tabl", finding);
    } else if ((m = new RegExp(`field not part of structure (${NAME})-`).exec(message))) {
      ask(m[1].toUpperCase(), "tabl", finding);
    } else if ((m = new RegExp(`^Contains unknown, (${NAME}) not found$`).exec(message))) {
      // the error's first line -- the fallback for the type-lookup shapes
      // whose UnknownType carried no extractable name (a domain-typed
      // variable's error can be the bare name); when the name IS carried,
      // the finding is structural-matched and never reaches this branch
      ask(m[1].toUpperCase(), "ddic", finding);
    } else if ((m = new RegExp(`contains unknown: (${NAME}) not found$`).exec(message))) {
      ask(m[1].toUpperCase(), fix === "lookupDataElement" ? "dtel" : "ddic", finding);
    } else if (fix === "lookupDomain" && (m = new RegExp(`contains unknown: (${NAME})$`).exec(message))) {
      // the domain lookup reports no "not found": its fix field is the shape
      ask(m[1].toUpperCase(), "doma", finding);
    } else if ((m = new RegExp(`^Unknown class (${NAME})$`).exec(message))) {
      ask(m[1].toUpperCase(), objectKind(m[1]), finding);
    } else if ((m = new RegExp(`^Interface (${NAME}) unknown$`).exec(message))) {
      // the INTERFACES statement's wording (in a class or inside an
      // interface definition) -- the FALLBACK: the structural pass reads
      // the statement itself (B1); this branch asks when no reference
      // carried the name. The wording says interface: the kind is INTF
      ask(m[1].toUpperCase(), "intf", finding);
    } else if ((m = new RegExp(`^Class (${NAME}) not found$`).exec(message))) {
      ask(m[1].toUpperCase(), "clas", finding);
    } else if ((m = new RegExp(`^CATCH, unknown class (${NAME})$`).exec(message))) {
      ask(m[1].toUpperCase(), "clas", finding);
    } else if ((m = new RegExp(`^RAISE, unknown class (${NAME})$`).exec(message))) {
      // RAISE EXCEPTION TYPE x with x not in the build -- the shape a stub
      // raise produces when the stub's own class is missing
      ask(m[1].toUpperCase(), objectKind(m[1]), finding);
    } else if ((m = new RegExp(`^TYPE "(${NAME})" not found$`).exec(message))) {
      // a TYPES statement naming an absent class -- no scope carrier
      // records it (measured); the name is the ask
      ask(m[1].toUpperCase(), objectKind(m[1]), finding);
    } else if ((m = new RegExp(`^resolveConstantValue, not found: (${NAME})$`, "i").exec(message)) !== null) {
      // a constant default resolved off an absent class or interface: X is
      // THAT name (a code kind); the scope records nothing here
      ask(m[1].toUpperCase(), objectKind(m[1]), finding);
    } else if ((m = new RegExp(`^(${NAME}) not found$`).exec(message)) !== null) {
      // the bare shape: a type name alone (`X not found`) -- a table type
      // in a TYPES ... TABLE OF position, which no scope carrier names
      ask(m[1].toUpperCase(), "ddic", finding);
    } else if ((m = new RegExp(`not a table type, (${NAME}) not found$`).exec(message))) {
      ask(m[1].toUpperCase(), "ddic", finding);
    } else if ((m = new RegExp(`^Target type unknown, (${NAME})$`).exec(message)) !== null) {
      // the kind-less dictionary triple for a name outside the
      // local-variable convention; a local variable's name is a CASCADE,
      // counted, never asked -- the wording names the statement's target
      // VARIABLE
      const name = m[1].toUpperCase();
      if (LOCAL_VARIABLE.test(name) === true) cascades++;
      else ask(name, "ddic", finding);
    } else if (message === "Target type unknown" && /^[A-Za-z][A-Za-z0-9_]*$/.test(fix ?? "") === true) {
      // the parse may read the name as the line's fix field -- the same
      // local-variable rule applies there
      if (LOCAL_VARIABLE.test(fix.toUpperCase()) === true) cascades++;
      else ask(fix.toUpperCase(), "ddic", finding);
    } else if (message.startsWith("Statement does not exist in the configured ABAP version") === true) {
      // the function-group compile shape: the transpiler compiles a *.abap
      // include as a program, and "FUNCTION" is not in its dialect -- the
      // name of what to dump is the file's own
      const fugr = /^([^.]+)\.fugr\./.exec(file);
      if (fugr !== null) ask(nameFromAbapFile(fugr[1]), "fugr", finding);
      else unclassified.push(finding.raw);
    } else if (cascadeOf(message) !== undefined) {
      cascades++;
    } else {
      unclassified.push(finding.raw);
    }
  }
  return {names, cascades, unclassified};
}

// ------------------------------------------------------------- the hold ----

/** the files whose stubs are held back this round because their definition
 *  material is decision material the graph is about to read: `defNames`
 *  (the structural definition-level unknowns) and `unmatched` (definition
 *  findings) whose every name is settled -- nothing this iteration's request
 *  can still bring. Held files are decided in the quiescent round
 *  (graphDecide); when the decision BLOCKS, the loop releases the hold and
 *  the stubs apply after all (S-2.2). Pure. */
export function exclusionCandidates({files, pendingOf}) {
  const held = new Set();
  for (const f of files ?? []) {
    const unmatched = f.unmatched ?? [];
    const names = [...(f.defNames ?? []), ...classifyFindings(unmatched).names];
    if (names.length === 0 && unmatched.length === 0) continue;
    if (names.some((n) => pendingOf(n.name, n.kind) === true) === false) held.add(f.object);
  }
  return held;
}
