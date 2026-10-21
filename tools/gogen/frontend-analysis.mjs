// @ts-check
import {parseObserved} from "./frontend-inventory.mjs";
// Source-only analyses, keyed by the immutable parsed/rearranged node.
import {readText, listEntries, join} from "./host-io.ts";
import {parseSamc} from "../osd-samc.mjs";

// Match frontend.mjs: AST instanceof checks must use the transpiler's core.
import {createRequire} from "node:module";
const require = createRequire(import.meta.url);
const transpilerRequire = createRequire(require.resolve("@abaplint/transpiler/package.json"));
/** @type {typeof import("@abaplint/core")} */ const abaplint = transpilerRequire("@abaplint/core");
const {Expressions, ExpressionsCDS, Nodes, Structures} = abaplint;

/** @type {WeakMap<import("@abaplint/core").Nodes.StructureNode, import("@abaplint/core").Nodes.StructureNode | undefined>} */ const trees = new WeakMap();
/** @type {WeakMap<import("@abaplint/core").Nodes.StructureNode, Set<string>>} */ const inlineTables = new WeakMap();
/** @param {import("@abaplint/core").Nodes.StructureNode} node @param {typeof import("@abaplint/transpiler/build/src/rearranger.js").Rearranger} Rearranger */ export function rearrangedClass(node, Rearranger) {
  if (!trees.has(node)) trees.set(node, new Rearranger().run("CLAS", node));
  return trees.get(node);
}

/** @param {import("@abaplint/core").Nodes.StructureNode | undefined} body @returns {Set<string>} */ export function inlineTableLocals(body) {
  if (!body) return new Set();
  if (!inlineTables.has(body)) {
    /** @type {Set<string>} */ const names = new Set();
    for (const st of body.findAllStatementNodes()) {
      for (const into of st.findAllExpressions(Expressions.SQLIntoTable)) {
        for (const inline of into.findAllExpressions(Expressions.InlineData)) {
          const name = inline.findFirstExpression(Expressions.TargetField);
          if (name) names.add(name.concatTokens().toUpperCase());
        }
      }
    }
    inlineTables.set(body, names);
  }
  // @ts-expect-error -- abapiti form pending
  return inlineTables.get(body);
}

// The later folder wins each AMC channel name, as the runtime layers do.
/** @param {readonly string[]} folders */
export function samcOf(folders) {
  /** @type {Map<string, string>} */ const byName = new Map();
  /** @param {string} dir @returns {void} */ const walk = (dir) => {
    let entries;
    try { entries = listEntries(dir); } catch { return; }
    for (const [name, directory] of entries.sort((a, b) => a[0].localeCompare(b[0]))) {
      if (directory) walk(join(dir, name));
      else if (name.toLowerCase().endsWith(".samc.xml")) byName.set(name.toUpperCase(), join(dir, name));
    }
  };
  for (const f of folders) walk(f);
  const rows = [...byName.values()].flatMap((file) => parseSamc(readText(file), file));
  return [...new Map(rows.map((r) => [`${r.applicationId}|${r.path}`, r])).values()];
}

// Keep failures out of the serializable map and defer them until SQL uses a
// view. The map belongs to the registry, including reused registry compiles.
/** @type {WeakMap<Record<string, string>, Map<string, string>>} */ const cdsFailures = new WeakMap();
/** @type {WeakMap<Record<string, string>, (name: string) => void>} */ const cdsObservers = new WeakMap();
// Registry/provenance hooks are injected so these analyses stay source-only.
/** @param {Record<string, string> | undefined} views @param {(name: string) => void} observe */
export const bindCdsRegistry = (views, observe) => { if (views) cdsObservers.set(views, observe); };
/** @param {Record<string, string>} views @param {string} name */
export const cdsMappingError = (views, name) => {
  const observe = cdsObservers.get(views);
  if (observe) observe(name);
  return cdsFailures.get(views)?.get(name);
};
// @ts-expect-error -- abapiti form pending
function sqlViewName(annotations) {
  for (const annotation of annotations) {
    // @ts-expect-error -- abapiti form pending
    const key = annotation.getChildren().filter(c => c instanceof Nodes.TokenNode)
      // @ts-expect-error -- abapiti form pending
      .map(c => c.getFirstToken().getStr()).join("").toUpperCase();
    if (key !== "@ABAPCATALOG.SQLVIEWNAME:") continue;
    const value = annotation.findFirstExpression(ExpressionsCDS.CDSString)?.getFirstToken().getStr();
    if (value) return value.slice(1, -1).toUpperCase();
  }
}

// A CDS view entity has no SQL view name and is left out.
/** @param {readonly (string | {filename: string; source: string})[]} sources @returns {Record<string, string>} */ export function cdsSqlViews(sources) {
  /** @type {Record<string, string>} */ const out = {};
  /** @type {Map<string, string>} */ const failures = new Map();
  cdsFailures.set(out, failures);
  for (const [index, input] of sources.entries()) {
    const {filename, source} = typeof input === "string"
      ? {filename: `gogen_${index}.ddls.asddls`, source: input} : input;
    const src = source.startsWith("\uFEFF") ? source.slice(1) : source;
    // Core recognizes only lowercase extensions. Keep the original for messages.
    // Do not add CDS sources to the ABAP registry used for type checking.
    const reg = new abaplint.Registry();
    const file = new abaplint.MemoryFile(filename.toLowerCase(), src);
    reg.addFile(file);
    parseObserved(reg);
    const obj = reg.getFirstObject();
    // Pinned core's getSQLViewName() searches raw text and includes comments.
    // Its parsed CDS annotations exclude comments and expose the string token.
    // @ts-expect-error -- abapiti form pending
    /** @type {import("@abaplint/core").Nodes.ExpressionNode | undefined} */ const tree = obj?.getTree();
    if (!tree) {
      const message = `${filename}: DDLS view mapping could not be read`;
      // Without a tree there is no definition or SQL view name to read; the
      // abapGit object name (the file name) is what a failure can be found by.
      if (obj) failures.set(obj.getName().toUpperCase(), message);
      continue;
    }
    if (!(tree.get() instanceof ExpressionsCDS.CDSDefineView)) continue;
    // @ts-expect-error -- abapiti form pending
    const cds = obj.getDefinitionName();
    if (tree.getChildren().some((c) => c instanceof Nodes.TokenNode && c.getFirstToken().getStr().toUpperCase() === "ENTITY")) continue;
    const sql = sqlViewName(tree.findDirectExpressions(ExpressionsCDS.CDSAnnotation));
    if (sql && cds) out[cds.toUpperCase()] = sql;
  }
  return out;
}

// Typed host methods keep their parsed signature; generic ones use NATIVE_ME.
/** @param {typeof import("./frontend-classes-native.mjs").NATIVE_ME} nativeMe @param {string} className @param {string} name @returns {string | undefined} */ export function nativeMethodBody(nativeMe, className, name) {
  if (className === "CL_ABAP_CLASSDESCR" && name === "GET_SUPER_CLASS_TYPE") return "Native_GET_SUPER_CLASS_TYPE";
  return nativeMe.get(`${className}=>${name}`)?.fn;
}

// Only direct Compare tokens can spell IS [NOT] SUPPLIED. Literals and
// nested expressions stay inside Source nodes and cannot impersonate it.
/** @param {import("@abaplint/core").Nodes.ExpressionNode} node */
export function suppliedComparison(node) {
  const tokens = node.getChildren().filter(c => c instanceof Nodes.TokenNode).map(c => c.getFirstToken().getStr().toUpperCase());
  let state = 0, negated = false;
  for (const token of tokens) {
    if (state === 0 && token === "NOT") continue; // leading comparison negation
    if (state === 0 && token === "IS") state = 1;
    else if (state === 1 && token === "NOT") { negated = true; state = 2; }
    else if ((state === 1 || state === 2) && token === "SUPPLIED") state = 3;
    else return undefined;
  }
  const sources = node.findDirectExpressions(Expressions.Source);
  return state === 3 && sources.length === 1 ? {name: sources[0].concatTokens().toUpperCase(), negated} : undefined;
}

/** @type {WeakMap<import("@abaplint/core").ABAPFile, import("./frontend-types.ts").SuppliedMethod[]>} */
const suppliedOfFile = new WeakMap();
/** @param {import("@abaplint/core").ABAPFile} file */
export function suppliedMethods(file) {
  let methods = suppliedOfFile.get(file);
  if (methods) return methods;
  methods = [];
  for (const method of file.getStructure()?.findAllStructures(Structures.Method) ?? []) {
    // @ts-expect-error -- abapiti form pending
    const found = method.findAllExpressions(Expressions.Compare).map(suppliedComparison).filter(Boolean).map(c => c.name);
    // @ts-expect-error -- abapiti form pending
    methods.push({name: method.findFirstExpression(Expressions.MethodName).concatTokens().toUpperCase(), found});
  }
  suppliedOfFile.set(file, methods);
  return methods;
}
