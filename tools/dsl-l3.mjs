#!/usr/bin/env node
import {compileProof, renderProof} from "./dsl-l3-proof.mjs";
import {templateOrigins} from "./dsl-trace-origins.mjs";
import {convertFiles, enrichTrace, legacyTrace, readTraceFile, traceArgs} from "./dsl-trace.mjs";
// DSL L3: a set of L2 rules run as one unit, with a durable alert log and a
// trace from every alert to its rule line (docs/dsl-l3.md). A set is one
// manifest, `<set>.l3.yaml`, naming its rules by their `.l2.yaml` files; this
// compiler checks it, then renders through ZCL_OSD_TPL the set's runner class
// ZCL_L3_<SET> and its job report, each with a trace sidecar. It knows the
// set language and the L2 compiler's API, nothing of any domain.
//
//   node tools/dsl-l3.mjs build <set.l3.yaml> --out <dir> [--ddic <folder>]...
//   node tools/dsl-l3.mjs check <set.l3.yaml> --out <dir> [--ddic <folder>]...
//   node tools/dsl-l3.mjs explain <set>/<rule>/<model hash>/<date>/<pile>/<seq> [--set <set.l3.yaml>]... [--db <sqlite file>]
import {ruleVersion} from "./dsl-trace-history.mjs";
export {ruleVersion};
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, relative, resolve as resolvePath, sep} from "node:path";
import {createRequire} from "node:module";
import {pathToFileURL} from "node:url";
import yaml from "js-yaml";
const abaplint = createRequire(import.meta.url)("@abaplint/core");
import {lineOf} from "./dsl-yaml-lines.mjs";
import {compileSetParams, JOB_RANGE_ROWS, REPORT_PARAMETERS} from "./dsl-l3-params.mjs";
export {JOB_RANGE_ROWS, REPORT_PARAMETERS};
import {compileRule, lineIndex, misfit, modelHash, renderModel, rulePath, RuleError} from "./dsl-l2.mjs";
import {DEFAULT_DDIC, registryFor} from "./dsl-ddic.mjs";
import {compileSchedule, compileStages, explainStage, readStages, worklistVariants} from "./dsl-l3-stages.mjs";
import {compileResilience, resilienceNodes} from "./dsl-l3-resilience.mjs";
import {compileGovernor, governorTemplate} from "./dsl-l3-governor.mjs";
import {doctorOverlay, renderDoctor} from "./dsl-l3-doctor-overlay.mjs";
import {replayOverlay} from "./dsl-l3-replay-overlay.mjs";
import {compileReplay} from "./dsl-l3-replay.mjs";
import {compileCockpit, renderCockpit, cockpitRunnerTemplate} from "./dsl-l3-cockpit.mjs";
import {remoteVariant, compileRemote, remoteOverlay, renderRemote} from "./dsl-l3-remote.mjs";
import {compileSnapshots, snapshotOverlay} from "./dsl-l3-snapshot.mjs";
import {compileSettings} from "./dsl-l3-settings.mjs";
import {CHAOS_SETTINGS, compileSimulate, POISSON1, simPorts, simVariant, WORK_PORT} from "./dsl-l3-sim.mjs";
import {docDrift, graphJson, graphMermaid, graphOf} from "./dsl-l3-graph.mjs";

export const SET_TEMPLATE = "recipes/l3-set/template.tpl";
export const JOB_TEMPLATE = "recipes/l3-job/template.tpl";
// the templates of the ports (docs/dsl-l3.md, "Ports and adapters")
export const PORT_TEMPLATES = {
  "iface-autoclose": "recipes/l3-ports/iface-autoclose.tpl", "autoclose": "recipes/l3-ports/autoclose.tpl",
  "iface-source": "recipes/l3-ports/iface-source.tpl", "iface-sink": "recipes/l3-ports/iface-sink.tpl",
  factory: "recipes/l3-ports/factory.tpl", exception: "recipes/l3-ports/exception.tpl",
  "source-table": "recipes/l3-ports/source-table.tpl", "source-mem": "recipes/l3-ports/source-mem.tpl",
  "sink-log": "recipes/l3-ports/sink-log.tpl", "sink-dummy": "recipes/l3-ports/sink-dummy.tpl",
  "sink-capture": "recipes/l3-ports/sink-capture.tpl", "source-worklist": "recipes/l3-ports/source-worklist.tpl",
  "iface-work": "recipes/l3-ports/iface-work.tpl", "work-sim": "recipes/l3-ports/work-sim.tpl", "autoclose-sim": "recipes/l3-ports/autoclose-sim.tpl",
};
// the opt-in recipe overlays of a set (docs/dsl-l3.md, "Governor" and "Simulated twin")
const OVERLAY = {governor: "recipes/l3-governor", simulate: "recipes/l3-sim", cockpit: "recipes/l3-cockpit"};
// what a port of each kind may be served by without a class of its own
export const GENERATED = {source: ["table", "dummy", "capture"], sink: ["log", "dummy", "capture"], autoclose: ["none", "capture", "sim", "replay"], work: ["real", "sim", "replay"]};
// the methods a hand-written variant class must implement through the port's interface
export const PORT_METHODS = {source: ["read"], sink: ["put"], autoclose: ["apply"], work: ["check", "keys"]};
// the alert log is the one sink the runner knows how to fill
export const SINK_TABLE = "ZOSD_L3_ALERT";
export const SINK_GROUP = ["set_name", "rule_name", "model_hash", "check_date"];

// the widths of ZOSD_L3_ALERT's columns the runner writes from the manifest
export const WIDTH = {set: 16, rule: 60, hash: 71, file: 128, jobname: 32};
// a set name: the class ZCL_L3_<SET>, the report ZL3_<SET> (whose converted
// class ZCL_OSD_GUITX_L3_<SET> has 30 characters at most) and the job names
// L3_<SET>_<nn> are made of it
export const SET_NAME = /^[a-z][a-z0-9_]{0,12}$/;
// the job report's own selection fields; a set parameter's field is another name
// ---------------------------------------------------------------------------
// static checks on ABAP source, read with abaplint (statements, not text)

// Statements that end, split or leave the unit of work, and ones that write. A generated check
// class holds none of either; the generated runner and variants may write (the log does) but
// never end or split the unit. The one statement the runner may hold is SUBMIT, in the mode P
// path that a replay refuses (`jobs: true`). Hand-written variants are not scanned: a static
// scan cannot see what a helper they call does, so a replay does not bind them at all.
const S0 = abaplint.Statements;
const ENDS_UNIT = new Map([[S0.Commit, "COMMIT"], [S0.Rollback, "ROLLBACK"], [S0.Wait, "WAIT"], [S0.Submit, "SUBMIT"],
  [S0.CallTransaction, "CALL TRANSACTION"], [S0.Receive, "RECEIVE RESULTS"]]);
const WRITES = new Map([[abaplint.Statements.ModifyDatabase, "MODIFY"], [abaplint.Statements.InsertDatabase, "INSERT"],
  [abaplint.Statements.UpdateDatabase, "UPDATE"], [abaplint.Statements.DeleteDatabase, "DELETE"], [abaplint.Statements.MergeDatabase, "MERGE"]]);
const COMMITTING_FM = /^'(DB_COMMIT|DB_ROLLBACK|BAPI_TRANSACTION_COMMIT|BAPI_TRANSACTION_ROLLBACK)'$/i;

export function scanGeneratedUnits(model, runnerText, extraResults, remoteFiles = {}) {
  // nothing the runner or a generated variant holds may end the unit of work while a table is swapped
  for (const [name, text] of [[`${model.class}.clas.abap`, runnerText], ...extraResults.map(([n, r]) => [n, r.text]),
    ...Object.entries(remoteFiles).filter(([n]) => n === `${model.remote?.class}.clas.abap`)]) {
    const [first] = unitFindings(text, name, {writes: true, remoteSeam: name === `${model.remote?.class}.clas.abap` ? model.remote.function : undefined, jobs: name === `${model.class}.clas.abap`, waits: [model.simulate?.work_class, model.replay?.work_class].some((c) => name === `${c}.clas.abap`)});
    if (first) throw new SetError(model.where ?? model.source, model.set_line, `the generated ${name} line ${first.line} holds a ${first.what}; nothing generated may end the unit of work`);
  }
}

// [{line, what}] for each statement of the source that ends the unit of work, writes (when
// writes is false), registers an update task or runs native SQL
// waits: the simulated work, whose WAIT is its job (a replay never binds it: the factory refuses)
export function unitFindings(text, name, {writes = false, jobs = false, waits = false, remoteSeam = undefined} = {}) {
  const registry = new abaplint.Registry();
  registry.addFile(new abaplint.MemoryFile(name, text));
  registry.parse();
  const found = [];
  for (const object of registry.getObjects()) {
    for (const file of object.getABAPFiles()) {
      for (const statement of file.getStatements()) {
        const type = statement.get().constructor;
        const line = statement.getStart().getRow();
        const source = statement.concatTokens().replace(/\s+/g, " ");
        if (ENDS_UNIT.has(type) && !(jobs && type === S0.Submit) && !(waits && type === S0.Wait)) found.push({line, what: `${ENDS_UNIT.get(type)} statement`});
        else if (!writes && WRITES.has(type)) found.push({line, what: `${WRITES.get(type)} database statement`});
        // The named synchronous RFC is the seam; the factory's replay refusal is its guard.
        // No helper, update/background/task call or other RFC receives this exemption.
        else if (type === S0.CallFunction && remoteSeam && source.toUpperCase().startsWith(`CALL FUNCTION '${remoteSeam}' DESTINATION `)
          && !/\bIN UPDATE TASK\b|\bIN BACKGROUND\b|\bSTARTING NEW TASK\b/i.test(source)) continue;
        else if (type === abaplint.Statements.CallFunction && (/\bIN UPDATE TASK\b|\bIN BACKGROUND\b|\bDESTINATION\b|\bSTARTING NEW TASK\b/i.test(source) || COMMITTING_FM.test((source.split(" ")[2] ?? "").replace(/\.$/, "")))) found.push({line, what: "CALL FUNCTION that registers an update or ends the unit"});
        else if (type === abaplint.Statements.SetUpdateTask) found.push({line, what: "SET UPDATE TASK statement"});
        else if (type === abaplint.Statements.CallDatabase) found.push({line, what: "native SQL"});
      }
    }
  }
  return found;
}

// What the named class of a source declares: its DEFINITION line, the interfaces it names and the
// methods its own IMPLEMENTATION holds (a second class in the file counts for nothing).
export function classShape(text, name, className) {
  const registry = new abaplint.Registry();
  registry.addFile(new abaplint.MemoryFile(name, text));
  registry.parse();
  const same = (a) => a?.toLowerCase() === className.toLowerCase();
  const S = abaplint.Statements, E = abaplint.Expressions;
  const shape = {line: undefined, interfaces: [], methods: []};
  let inDefinition = false, inImplementation = false;
  for (const file of registry.getObjects().flatMap((o) => o.getABAPFiles())) {
    for (const statement of file.getStatements()) {
      const type = statement.get();
      if (type instanceof S.ClassDefinition) {
        inDefinition = same(statement.findFirstExpression(E.ClassName)?.concatTokens());
        if (inDefinition) shape.line = statement.getStart().getRow();
      } else if (type instanceof S.ClassImplementation) {
        inImplementation = same(statement.findFirstExpression(E.ClassName)?.concatTokens());
      } else if (type instanceof S.EndClass) {
        inDefinition = false;
        inImplementation = false;
      } else if (inDefinition && type instanceof S.InterfaceDef) {
        shape.interfaces.push(statement.findFirstExpression(E.InterfaceName).concatTokens().toLowerCase());
      } else if (inImplementation && type instanceof S.MethodImplementation) {
        shape.methods.push(statement.findFirstExpression(E.MethodName).concatTokens().toLowerCase());
      }
    }
  }
  return shape.line === undefined ? undefined : shape;
}

const KEYS = ["set", "title", "class", "report", "date", "rules", "stages", "params", "piles", "ports", "bindings", "schedule", "resilience", "settings", "governor", "simulate", "cockpit", "snapshots", "input", "proof"];
const PORT_KEYS = ["kind", "table", "key", "group", "seq", "variants"];
const PORT_NAME = /^[a-z][a-z0-9_]{0,11}$/;
const RULE_KEYS = ["rule", "enabled"];
const CHAR = (length) => ({built_in: "CHAR", length});

export class SetError extends RuleError {}

const path = (file) => relative(process.cwd(), file).split(sep).join("/");
// the source of a hand-written variant class, beside the set or under src
function findClassFile(className, roots) {
  const name = `${className}.clas.abap`;
  const walk = (dir) => {
    if (!existsSync(dir)) return undefined;
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) { const hit = walk(join(dir, entry.name)); if (hit) return hit; }
      else if (entry.name.toLowerCase() === name) return join(dir, entry.name);
    }
    return undefined;
  };
  for (const root of roots) { const hit = walk(root); if (hit) return hit; }
  return undefined;
}

// The generated check class of a rule sits beside its rule file, as
// `node tools/dsl-l2.mjs build <rule> --out <its folder>` writes it.
const sidecarOf = (ruleFile, className) => join(dirname(ruleFile), `${className}.clas.trace.json`);

export function compileSet(file, {ddic, registry, out} = {}) {
  const text = readFileSync(file, "utf8");
  const where = path(file);
  const fail = (line, message) => { throw new SetError(where, line, message); };
  let doc;
  try {
    doc = yaml.load(text, {schema: yaml.FAILSAFE_SCHEMA, filename: where});
  } catch (error) {
    throw new SetError(where, (error.mark?.line ?? 0) + 1, error.reason ?? error.message);
  }
  const index = lineIndex(text);
  const line = (key) => lineOf(index, key);
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) fail(1, "a set is a mapping with set, title and rules");
  for (const key of Object.keys(doc)) if (!KEYS.includes(key)) fail(line(key), `unknown key ${key} (${KEYS.join(", ")})`);
  const scalar = (key, required) => {
    const value = doc[key];
    if (value === undefined) {
      if (required) fail(1, `a set needs ${key}`);
      return undefined;
    }
    if (typeof value !== "string" || value.includes("\n")) fail(line(key), `${key} is one line of text`);
    return value;
  };
  const set = scalar("set", true);
  if (!SET_NAME.test(set)) fail(line("set"), `set ${JSON.stringify(set)} is a lower-case name of 1 to 13 letters, digits and _ starting with a letter`);
  const title = scalar("title", true);
  const className = (scalar("class") ?? `zcl_l3_${set}`).toLowerCase();
  if (!/^z[a-z0-9_]{1,29}$/.test(className)) fail(line("class"), `class ${className} is a Z name of at most 30 characters`);
  const report = (scalar("report") ?? `zl3_${set}`).toLowerCase();
  if (!/^z[a-z0-9_]{1,18}$/.test(report)) fail(line("report"), `report ${report} is a Z name of at most 19 characters (its converted class ZCL_OSD_GUITX_<name without Z> has 30)`);
  const date = scalar("date", true);
  if (date !== "$date" && date !== "today") fail(line("date"), `date is $date (the caller passes the check date) or today ($date, the current date when the caller passes none); other parameters are params:`);

  // stages: (docs/dsl-l3.md, "Stages, filters and a schedule") list the rules
  // stage by stage; a set without them is one implicit stage, as before
  const stageDocs = doc.stages === undefined ? undefined : readStages(doc, {line, fail});
  if (!stageDocs) {
    if (!Array.isArray(doc.rules)) fail(line("rules"), "rules is a list of {rule: <file.l2.yaml>, enabled: true|false}");
    if (!doc.rules.length) fail(line("rules"), "a set needs at least one rule");
  }
  const listed = stageDocs ? stageDocs.flatMap((st) => st.entries.map((e) => ({...e, s: st.s})))
    : doc.rules.map((entry, i) => ({entry, path: `rules/${i}`}));
  const seen = {file: new Map(), name: new Map(), class: new Map()};
  const all = listed.map(({entry, path: base, s}) => {
    const at = line(base);
    if (typeof entry === "string") entry = {rule: entry};
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) fail(at, "a rule entry is {rule: <file.l2.yaml>} with an optional enabled: true|false");
    for (const key of Object.keys(entry)) if (!RULE_KEYS.includes(key)) fail(line(`${base}/${key}`), `unknown key ${key} in a rule entry (${RULE_KEYS.join(", ")})`);
    if (typeof entry.rule !== "string" || !entry.rule.endsWith(".l2.yaml")) fail(at, "rule names a .l2.yaml file, relative to the set");
    const enabled = entry.enabled ?? "true";
    if (enabled !== "true" && enabled !== "false") fail(line(`${base}/enabled`), `enabled is true or false, not ${JSON.stringify(enabled)}`);
    const ruleFile = resolvePath(dirname(file), entry.rule);
    if (!existsSync(ruleFile)) fail(at, `rule file ${entry.rule} does not exist (${path(ruleFile)})`);
    const twice = (kind, key, what) => {
      if (seen[kind].has(key)) fail(at, `${what} is already in the set at line ${seen[kind].get(key)}`);
      seen[kind].set(key, at);
    };
    twice("file", ruleFile, `rule file ${entry.rule}`);
    let compiled;
    try {
      // out: the rule's own folder, where its class is built, so a rule
      // outside a repository records the path its sidecar records
      compiled = compileRule(ruleFile, {out: dirname(ruleFile), ...(ddic ? {ddic} : {}), ...(registry ? {registry} : {})});
    } catch (error) {
      if (error instanceof RuleError) fail(at, `rule ${entry.rule} does not compile: ${error.message}`);
      throw error;
    }
    twice("name", compiled.rule, `rule ${compiled.rule}`);
    twice("class", compiled.class, `class ${compiled.class}`);
    if (compiled.rule.length > WIDTH.rule) fail(at, `rule name ${compiled.rule} is longer than ${WIDTH.rule} characters, the width of ZOSD_L3_ALERT-RULE_NAME`);
    const hash = modelHash(renderModel(compiled));
    // a check class is read-only by construction: a replay runs it with the table swapped
    const classFile = join(dirname(ruleFile), `${compiled.class}.clas.abap`);
    if (existsSync(classFile)) {
      const [first] = unitFindings(readFileSync(classFile, "utf8"), basename(classFile));
      if (first) fail(at, `the generated class of ${entry.rule} (${path(classFile)}:${first.line}) holds a ${first.what}; a check class only reads (a replay swaps table content under it)`);
    }
    const sidecar = sidecarOf(ruleFile, compiled.class);
    let committed;
    try { committed = readTraceFile(sidecar).model; }
    catch (error) {
      if (error.message.includes("hash mismatch")) fail(at, `rule ${entry.rule}: ${error.message}; rebuild its check class`);
      committed = undefined;
    }
    if (committed === undefined) fail(at, `rule ${entry.rule} has no generated class beside it (${path(sidecar)}); build it with node tools/dsl-l2.mjs build ${path(ruleFile)} --out ${path(dirname(ruleFile))}`);
    if (committed !== hash) fail(at, `the generated class of ${entry.rule} is stale (its trace names ${committed}, the rule compiles to ${hash}); rebuild it with node tools/dsl-l2.mjs build ${path(ruleFile)} --out ${path(dirname(ruleFile))}`);
    const recorded = compiled.source;
    if (recorded.length > WIDTH.file) fail(at, `rule path ${recorded} is longer than ${WIDTH.file} characters, the width of ZOSD_L3_ALERT-RULE_FILE`);
    return {at, enabled: enabled === "true", compiled, hash, recorded, s};
  });
  const enabled = all.filter((r) => r.enabled);
  if (!enabled.length) fail(line(stageDocs ? "stages" : "rules"), "every rule of the set is disabled; a set runs at least one");
  if (enabled.length > 99) fail(line(stageDocs ? "stages" : "rules"), "a set runs at most 99 rules (the job name numbers them in two digits)");

  // set parameters (docs/dsl-l3.md, "Piles and set parameters" and "Range set parameters")
  const {paramDocs, params} = compileSetParams({doc, enabled, set, line, fail});

  const id = `set/${set}`;

  // ports and bindings (docs/dsl-l3.md, "Ports and adapters")
  const asMap = (value, key, what) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) fail(line(key), `${key} is ${what}`);
    return value;
  };
  let registry0;
  const columnsOf = (table, key) => {
    registry0 ??= registryFor(ddic ?? DEFAULT_DDIC, []);
    const object = registry0.getObject("TABL", table.toUpperCase());
    if (!object) fail(line(`${key}/table`), `table ${table.toUpperCase()} is not in the DDIC given`);
    const fields = (object.getFields() ?? []).filter((f) => !f.FIELDNAME.startsWith("."));
    const names = fields.map((f) => f.FIELDNAME.toLowerCase());
    const clidep = /<CLIDEP>X</.test(object.getXML() ?? "");
    return {names, fields, client: clidep ? names[0] : undefined};
  };
  const classSearch = [dirname(file), "src"];
  const portDocs = doc.ports === undefined ? {alerts: {kind: "sink", table: SINK_TABLE, group: [...SINK_GROUP], seq: "alert_seq", variants: {log: "generated"}}} : asMap(doc.ports, "ports", "a mapping of port name to its definition");
  const implicit = doc.ports === undefined;
  const bindingDocs = doc.bindings === undefined ? (implicit ? {alerts: "log"} : {}) : asMap(doc.bindings, "bindings", "a mapping of port name to the variant it is bound to");
  if (!Object.keys(portDocs).length) fail(line("ports"), "ports names at least one port");
  // simulate: brings the work port (variants real and sim), bound to real unless bound
  const injected = simPorts(doc, portDocs, bindingDocs, {line, fail});
  // a hand-written variant: the named class itself declares the port's interface and implements
  // each of its methods (read with abaplint, so a second class in the file counts for nothing);
  // refused at the class's own file and line otherwise. Nothing more is asked of it: a replay
  // never binds a hand-written class (the factory refuses it from data, before it is created)
  const checkClass = ({className, iface, kind, at, vname}) => {
    const found = findClassFile(className, classSearch);
    if (!found) fail(at, `class ${className} of variant ${vname} is not found (${className}.clas.abap beside the set or under src)`);
    const text = readFileSync(found, "utf8");
    const shape = classShape(text, basename(found), className);
    if (!shape) throw new SetError(path(found), 1, `${basename(found)} does not define class ${className}`);
    if (!shape.interfaces.includes(iface)) {
      throw new SetError(path(found), shape.line, `class ${className} does not implement ${iface}, the interface of the ${kind} port (INTERFACES ${iface}.)`);
    }
    for (const method of PORT_METHODS[kind]) {
      if (!shape.methods.includes(`${iface}~${method}`)) {
        throw new SetError(path(found), shape.line, `class ${className} does not implement ${iface}~${method} in its own implementation; the port's signature is ${PORT_METHODS[kind].join(", ")} (see the generated ${iface})`);
      }
    }
  };
  const ifaceOf = (port) => `zif_l3_${set}_${port}`;
  const tooLong = (name, key) => { if (name.length > 30) fail(line(key), `the generated name ${name} has ${name.length} characters, a class or interface name has at most 30; shorten the set, port or variant name`); };
  const ports = Object.entries(portDocs).map(([name, def], pi) => {
    const key = `ports/${name}`;
    const at = implicit ? line("set") : injected.port && name === WORK_PORT ? line("simulate") : line(key);
    if (!PORT_NAME.test(name)) fail(at, `port ${JSON.stringify(name)} is a lower-case name of 1 to 12 letters, digits and _ starting with a letter`);
    asMap(def, key, "a mapping with kind, table and variants");
    for (const k of Object.keys(def)) if (!PORT_KEYS.includes(k)) fail(line(`${key}/${k}`), `unknown key ${k} in a port (${PORT_KEYS.join(", ")})`);
    const text = (k, required) => {
      const v = def[k];
      if (v === undefined) { if (required) fail(at, `port ${name} needs ${k}`); return undefined; }
      if (typeof v !== "string" || v.includes("\n") || !/^[A-Za-z][A-Za-z0-9_]*$/.test(v)) fail(line(`${key}/${k}`), `${k} of port ${name} is a name of letters, digits and _`);
      return v;
    };
    const kind = text("kind", true);
    if (!GENERATED[kind]) fail(line(`${key}/kind`), `kind of port ${name} is source, sink, autoclose or work, not ${JSON.stringify(kind)}`);
    const table = kind === "autoclose" || kind === "work" ? "zosd_l3_alert" : text("table", true).toLowerCase();
    const {names, client} = implicit ? {names: null, client: undefined} : columnsOf(table, key);
    const column = (k, v) => {
      if (names && !names.includes(v.toLowerCase())) fail(line(`${key}/${k}`), `${table.toUpperCase()} has no field ${v.toUpperCase()}`);
      return v.toLowerCase();
    };
    let keyField, group, seq;
    if (kind === "source") {
      keyField = column("key", text("key", true));
      for (const k of ["group", "seq"]) if (def[k] !== undefined) fail(line(`${key}/${k}`), `${k} belongs to a sink, port ${name} is a source`);
    } else if (kind === "sink") {
      if (def.key !== undefined) fail(line(`${key}/key`), `key belongs to a source, port ${name} is a sink`);
      if (table.toUpperCase() !== SINK_TABLE) fail(line(`${key}/table`), `a sink writes ${SINK_TABLE}, the table the runner fills, not ${table.toUpperCase()}`);
      if (!Array.isArray(def.group) || def.group.some((g) => typeof g !== "string")) fail(line(`${key}/group`), `group of sink ${name} is a list of field names`);
      group = def.group.map((g) => column("group", g));
      if (JSON.stringify(group) !== JSON.stringify(SINK_GROUP)) fail(line(`${key}/group`), `group of sink ${name} is ${SINK_GROUP.join(", ")} (the key of one rule version and date), the fields the runner knows`);
      seq = column("seq", text("seq", true));
    }
    const variantDocs = asMap(def.variants, `${key}/variants`, `a mapping of variant name to generated or a class name`);
    if (!Object.keys(variantDocs).length) fail(line(`${key}/variants`), `port ${name} needs at least one variant`);
    tooLong(ifaceOf(name), key);
    const iface = ifaceOf(name);
    const variants = Object.entries(variantDocs).map(([vname, value0]) => {
      let value = value0;
      const vkey = `${key}/variants/${vname}`;
      const vat = implicit || (injected.port && name === WORK_PORT) ? at : line(vkey);
      if (!PORT_NAME.test(vname)) fail(vat, `variant ${JSON.stringify(vname)} is a lower-case name of 1 to 12 letters, digits and _ starting with a letter`);
      const remote = remoteVariant(value, {kind, vname, vkey, line, fail});
      if (remote) value = "generated";
      if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) fail(vat, `variant ${vname} is generated or the name of a class`);
      let className, generated = value === "generated";
      const sim = simVariant({kind, vname, generated, simulate: doc.simulate !== undefined, at: vat, fail});
      if (generated) {
        if (!remote && !GENERATED[kind].includes(vname)) fail(vat, `a generated variant of a ${kind} is one of ${GENERATED[kind].join(", ")}; ${vname} needs a class of its own (${vname}: <class>)`);
        className = `zcl_l3_${set}_${name}_${vname}`;
        if (vname === "replay" && className.length > 30) className = `zcl_l3_${set}_${name}_rpl`;
        tooLong(className, vkey);
      } else {
        className = value.toLowerCase();
        checkClass({className, iface, kind, at: vat, vname});
      }
      return {
        "@id": `${id}/port/${name}/variant/${vname}`, set_line: vat,
        name: vname, "name@type": CHAR(30), class: className, generated, ...(remote ? {remote, is_remote: true} : {}),
        is_table: generated && vname === "table", is_log: generated && vname === "log",
        is_dummy: generated && vname === "dummy", is_capture: generated && vname === "capture",
        // what the factory knows of a variant without creating it: a hand-written class counts as live
        // and not volatile, and a replay does not bind it
        port: name, "port@type": CHAR(30), hand: !generated,
        volatile: generated && (vname === "dummy" || vname === "capture"),
        nonlive: generated && kind === "source" && vname !== "table", ...sim,
      };
    });
    const bound = bindingDocs[name];
    const bat = line(`bindings/${name}`);
    if (bound === undefined) fail(implicit ? at : line("bindings"), `port ${name} has no binding; bindings names the variant each port runs with`);
    if (typeof bound !== "string" || !variants.some((v) => v.name === bound)) fail(bat, `binding ${name}: ${JSON.stringify(bound)} is not a variant of the port (${variants.map((v) => v.name).join(", ")})`);
    return {
      "@id": `${id}/port/${name}`, set_line: at,
      name, "name@type": CHAR(30), kind, is_source: kind === "source", is_sink: kind === "sink", ...(kind === "autoclose" ? {is_autoclose: true} : {}), ...(kind === "work" ? {is_work: true} : {}),
      table, key: keyField, seq, iface, exception: `zcx_l3_${set}_port`, ports_class: `zcl_l3_${set}_ports`,
      group: group?.map((g, i) => ({name: g, lead: i === 0 ? "WHERE" : "AND"})) ?? [],
      has_client: client !== undefined, client: client ?? "",
      variants,
      binding: {"@id": `${id}/binding/${name}`, set_line: implicit || (injected.binding && name === WORK_PORT) ? at : bat, variant: bound, "variant@type": CHAR(30)},
    };
  });
  for (const name of Object.keys(bindingDocs)) if (!ports.some((p) => p.name === name)) fail(line(`bindings/${name}`), `binding ${name} names no port of the set`);
  const sinks = ports.filter((p) => p.is_sink);
  if (sinks.length !== 1) fail(line("ports"), `a set has exactly one sink, the alert sink the runner writes through; this one has ${sinks.length}`);
  // the pile planner (docs/dsl-l3.md, "Piles and set parameters"): the keys
  // of a source port cut into piles of `size`; a rule is piled when its L2
  // range: is that key on that table
  let piles;
  if (doc.piles !== undefined && !stageDocs) {
    const spec = asMap(doc.piles, "piles", "a mapping with source and size");
    for (const key of Object.keys(spec)) if (!["source", "size"].includes(key)) fail(line(`piles/${key}`), `unknown key ${key} in piles (source, size)`);
    const source = ports.find((p) => p.name === spec.source && p.is_source);
    if (!source) fail(line("piles/source"), `piles.source ${JSON.stringify(spec.source)} is not a source port of the set (${ports.filter((p) => p.is_source).map((p) => p.name).join(", ") || "none"})`);
    const keyField = columnsOf(source.table, `ports/${source.name}`).fields.find((f) => f.FIELDNAME.toLowerCase() === source.key);
    if (Number(keyField.LENG) > 40) fail(line("piles/source"), `the key ${source.table.toUpperCase()}-${source.key.toUpperCase()} is longer than 40 characters, the width of ZOSD_L3_PILE-RANGE_LOW and RANGE_HIGH`);
    if (!/^[1-9][0-9]{0,9}$/.test(String(spec.size)) || Number(spec.size) > 2147483647) fail(line("piles/size"), `piles.size is a whole number from 1 to 2147483647 (an INT4), not ${JSON.stringify(spec.size)}`);
    piles = {"@id": `${id}/piles`, set_line: line("piles"), size: spec.size, "size@type": {built_in: "INT4"},
      source: {name: source.name, "name@type": CHAR(30), key: source.key, table: source.table, iface: source.iface}};
    if (!enabled.some((r) => r.compiled.range?.table === source.table && r.compiled.range.field === source.key)) {
      fail(line("piles"), `no enabled rule is piled: a rule is piled when its range: is ${source.key} of ${source.table.toUpperCase()}, the key of port ${source.name}`);
    }
    if (`L3_${set}_99_9999`.length > WIDTH.jobname) fail(line("piles"), `the job names L3_<SET>_<nn>_<pppp> have at most ${WIDTH.jobname} characters`);
    // the alert log's group gains the pile: a rerun of one pile replaces that pile's rows only
    sinks[0].group.push({name: "pile_no", lead: "AND", "@id": piles["@id"], set_line: piles.set_line});
  }
  // the stages against the ports: worklists, pile sources, the worklist variant of a port
  let staged;
  if (stageDocs) {
    staged = compileStages(stageDocs, all, {id, set, ports, line, fail, columnsOf, asMap});
    worklistVariants(ports, staged.worklists, {id, set, fail, line});
    // every rule of a staged set runs in piles (pile 0 when its stage is not piled)
    sinks[0].group.push({name: "pile_no", lead: "AND", "@id": `${id}/stages`, set_line: line("stages")});
  }
  const schedule = compileSchedule(doc, {id, set, line, fail, staged: Boolean(staged)});
  // resilience: (docs/dsl-l3.md, "Resilience"): retries, the doctor, fuses, dry run, retention
  const resilience = compileResilience(doc, {id, set, line, fail, staged: Boolean(staged), sink: sinks[0], schedule});
  let releaseEvent;
  if (stageDocs && doc.piles !== undefined) {
    const spec = asMap(doc.piles, "piles", "{release: submit|event, lanes}");
    if (!["submit", "event"].includes(spec.release)) fail(line("piles/release"), "piles.release is submit or event");
    if (spec.lanes !== undefined && (!/^[1-9][0-9]{0,3}$/.test(String(spec.lanes)) || +spec.lanes > 9999)) fail(line("piles/lanes"), "piles.lanes is 1..9999");
    if (spec.release === "event") {
      if (!resilience?.doctor.daemon) fail(line("piles/release"), "event release needs a daemon doctor");
      releaseEvent = {"@id": `${id}/piles/release`, set_line: line("piles/release"), lanes: String(spec.lanes ?? "0")};
    }
  }
  const SET = set.toUpperCase();
  const stageOf = (r) => staged?.stages[r.s];
  // a piled rule's range traces to its range: line in the rule file
  const pileOf = (r) => {
    const range = r.compiled.range;
    const source = staged ? stageOf(r).piles?.source : piles.source;
    if (!source || !range || range.table !== source.table || range.field !== source.key) return {unpiled: true};
    return {piled: true, range: {"@id": `${id}/rule/${r.compiled.rule}/range`, set_line: r.at, rule_file: r.recorded, rule_line: range.rule_line}};
  };
  // the set parameters a rule's check receives; `fallback`: the rule's own
  // default, for a set parameter that has none
  const argsOf = (r) => (r.compiled.params ?? []).filter((p) => paramDocs[p.name]).map((p) => ({name: p.name, ref: p.ref,
    ...(paramDocs[p.name].default === undefined && p.default !== undefined ? {fallback: p.default, "fallback@type": p.type} : {})}));
  const node = (r, n) => ({
    "@id": `${id}/rule/${r.compiled.rule}`, set_line: r.at,
    name: r.compiled.rule, "name@type": CHAR(WIDTH.rule),
    hash: r.hash, "hash@type": CHAR(WIDTH.hash),
    check_class: r.compiled.class, "check_class@type": CHAR(30),
    file: r.recorded, "file@type": CHAR(WIDTH.file),
    // the alert line of the rule: what an alert row names; a rule whose
    // clauses carry their own alerts names its root line
    alert_line: String(r.compiled.alert?.rule_line ?? r.compiled.rule_line), "alert_line@type": {built_in: "INT4"},
    ...(n ? {index: String(n), jobname: `L3_${SET}_${staged ? stageOf(r).no : ""}${String(n).padStart(2, "0")}`, "jobname@type": CHAR(WIDTH.jobname)} : {}),
    ...(piles || staged ? pileOf(r) : {}),
    ...(argsOf(r).length ? {param_args: argsOf(r)} : {}),
    ...(((piles || staged) && pileOf(r).piled) || argsOf(r).length ? {has_args: true} : {}),
    ...(staged ? {stage_no: stageOf(r).no, "stage_no@type": {built_in: "INT4"}, ...(stageOf(r).filter ? {filter: true, worklist: stageOf(r).worklist.name, "worklist@type": CHAR(16)} : {check: true})} : {}),
  });
  const model = {
    ...(releaseEvent ? {release_event: releaseEvent} : {}),
    "@id": id, set_line: line("set"),
    set, set_upper: SET, "set@type": CHAR(WIDTH.set), title, class: className, report, source: rulePath(file, out),
    jobs: `L3_${SET}_*`, "jobs@type": CHAR(WIDTH.jobname),
    date: {"@id": `${id}/date`, set_line: line("date"), today: date === "today"},
    ports_class: `zcl_l3_${set}_ports`, exception: `zcx_l3_${set}_port`,
    ports, sources: ports.filter((p) => p.is_source).map((p, i) => ({...p, index: String(i + 1)})), sink: sinks[0],
    // with_params: the lines every set parameter shares (ty_params, is_params), traced to params:
    ...(params.length ? {params, with_params: {"@id": `${id}/params`, set_line: line("params")}} : {}), ...(piles ? {piles} : {}),
    // planned: the plan machinery a piled and a staged set share (lock, finalise, the plan rows)
    ...(piles ? {planned: piles} : {}), ...(staged ? {planned: {"@id": `${id}/stages`, set_line: line("stages")},
      staged: {"@id": `${id}/stages`, set_line: line("stages"), count: String(staged.stages.length), "count@type": {built_in: "INT4"}},
      stages: staged.stages} : {}), ...(schedule ? {schedule} : {}), ...resilienceNodes(resilience),
    rules: enabled.map((r, i) => node(r, i + 1)),
    disabled: all.filter((r) => !r.enabled).map((r) => node(r)),
  };
  // each stage's rules, for the stage's plan; a worklist variant makes the factory refuse binding it
  if (staged) for (const stage of staged.stages) stage.members = model.rules.filter((r) => r.stage_no === stage.no);
  if (ports.some((p) => p.has_worklist)) model.with_worklist = {"@id": `${id}/stages`, set_line: line("stages")};
  if (doc.governor !== undefined) model.governor = compileGovernor(doc, model, all, {line, fail});
  if (doc.simulate !== undefined) model.simulate = compileSimulate(doc, model, all, {line, fail, bindings: bindingDocs});
  if (doc.simulate?.profile !== undefined) compileReplay(doc.simulate, model.simulate, model, {file, line, fail});
  compileSnapshots(doc, model, {line, fail, columnsOf});
  compileRemote(model, {line, fail, columnsOf});
  if (doc.settings !== undefined) model.settings = compileSettings(doc, model, {line, fail});
  if (model.remote && (!model.settings || (model.remote.setting && !model.settings.entries.some((e) => e.name === "remote.destination")))) fail(model.remote.set_line, "remote receiver needs settings; remote.destination must be tunable when named");
  // a tunable seed is the run's: the chance autoclose reads it from the run's snapshot
  if (model.simulate && model.settings?.simulate_seed) model.simulate.seed_conf = {"@id": model.simulate["@id"], set_line: model.simulate.set_line, conf: model.settings.class};
  if (model.replay) model.replay.seed_conf = model.simulate.seed_conf;
  // chaos: profiles are chosen by a setting, so a set that names profiles must let the operator choose
  if (model.simulate?.profile_names && !model.settings?.entries.some((e) => e.name === "simulate.profile")) fail(line("simulate/profiles"), "simulate.profiles are chosen by the setting simulate.profile: list it in settings.tunable (without it the profiles could never run)");
  // the work class reads the chaos settings of the run's snapshot (after the replay copy: a replay twin has none)
  const chaos = model.settings?.entries.filter((e) => CHAOS_SETTINGS.includes(e.name)).map((e) => e.name) ?? [];
  if (model.simulate && chaos.length) model.simulate.chaos_conf = {"@id": model.simulate["@id"], set_line: model.simulate.set_line, conf: model.settings.class,
    poisson1: POISSON1, "poisson1@type": {built_in: "STRG"},
    has_profile: chaos.includes("simulate.profile"), has_dump: chaos.includes("simulate.dump"), has_hang: chaos.includes("simulate.hang"),
    has_slow: chaos.includes("simulate.slow"), has_hits: chaos.includes("simulate.hits_mean"), has_close: chaos.includes("simulate.autoclose")};
  if (doc.cockpit !== undefined) model.cockpit = compileCockpit(doc, model, {line, fail});
  if (doc.proof !== undefined) model.proof = compileProof(doc.proof, model, all, {line, fail});
  Object.defineProperty(model, "where", {value: where});
  return model;
}

function provenance(model, tracePath) {
  let current = model, node = model;
  for (const part of String(tracePath ?? "").split("/").filter(Boolean)) {
    current = Array.isArray(current) ? current[Number(part) - 1] : current?.[part];
    if (current?.["@id"]) node = current;
  }
  return {node: node["@id"], set_line: node.set_line,
    ...(node.rule_line !== undefined ? {rule_file: node.rule_file, rule_line: node.rule_line} : {})};
}

function sidecar(model, template, rendered) {
  return JSON.stringify({
    generator: "dsl-l3", set: model.source, template,
    ...(model.governor && [SET_TEMPLATE, JOB_TEMPLATE].includes(template) ? {overlay: `recipes/l3-governor/${template === SET_TEMPLATE ? "runner" : "job"}.patch.json`} : {}),
    ...(model.autodoctor && [SET_TEMPLATE, JOB_TEMPLATE].includes(template) ? {doctor_overlay: template === JOB_TEMPLATE ? ["recipes/l3-doctor/job-tail.tpl"] : ["recipes/l3-doctor/runner.patch.json", "recipes/l3-doctor/runner.tpl", ...(model.release_event ? ["recipes/l3-doctor/release.patch.json"] : [])]} : {}),
    ...(rendered.simOverlays?.length ? {sim_overlay: rendered.simOverlays} : {}),
    ...(rendered.replayOverlays?.length ? {replay_overlay: rendered.replayOverlays} : {}),
    ...(model.snapshots && template === SET_TEMPLATE ? {snapshot_overlay: ["recipes/l3-snapshot/public.tpl", "recipes/l3-snapshot/run.tpl", "recipes/l3-snapshot/methods.tpl"]} : {}),
    ...(model.remote && template === SET_TEMPLATE ? {remote_overlay: ["public", "send", "receive", "counts", "release", "resume"].map((n) => `recipes/l3-remote/${n}.tpl`)} : {}),
    model: `sha256:${createHash("sha256").update(JSON.stringify(model)).digest("hex")}`,
    ...(model.rules ? {rules: Object.fromEntries(model.rules.map((r) => [r.name, {file: r.file, class: r.check_class, model: r.hash}]))} : {}),
    lines: enrichTrace(model, rendered.trace).map((entry) => ({...(!legacyTrace() ? entry : {}), line: entry.line, template_line: entry.template_line, path: entry.path,
      ...provenance(model, entry.path)})),
  }, null, 1) + "\n";
}

const xmlEscape = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function classXml(model, name = model.class, descript = `L3 rule set ${model.set}`) {
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values><VSEOCLASS><CLSNAME>${name.toUpperCase()}</CLSNAME><LANGU>E</LANGU><DESCRIPT>${xmlEscape(descript.slice(0, 60))}</DESCRIPT><STATE>1</STATE><CLSCCINCL>X</CLSCCINCL><FIXPT>X</FIXPT><UNICODE>X</UNICODE></VSEOCLASS></asx:values>
 </asx:abap>
</abapGit>
`;
}

function intfXml(name, descript) {
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_INTF" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values><VSEOINTERF><CLSNAME>${name.toUpperCase()}</CLSNAME><LANGU>E</LANGU><DESCRIPT>${xmlEscape(descript.slice(0, 60))}</DESCRIPT><EXPOSURE>2</EXPOSURE><STATE>1</STATE><UNICODE>X</UNICODE></VSEOINTERF></asx:values>
 </asx:abap>
</abapGit>
`;
}

// every node with an @id of a model, id -> its manifest line
function linesById(model, map = new Map()) {
  if (Array.isArray(model)) { for (const x of model) linesById(x, map); return map; }
  if (!model || typeof model !== "object") return map;
  if (model["@id"]) map.set(model["@id"], model.set_line);
  for (const value of Object.values(model)) linesById(value, map);
  return map;
}

function progXml(model) {
  return `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_PROG" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values><PROGDIR><NAME>${model.report.toUpperCase()}</NAME><DBAPL>S</DBAPL><SUBC>1</SUBC><FIXPT>X</FIXPT><UCCHECK>X</UCCHECK></PROGDIR></asx:values>
 </asx:abap>
</abapGit>
`;
}

// A template with the overlays the model opts into, in order: the governor's,
// then the simulated twin's (a governed set's runner takes a second list of
// the twin's whose anchors are the governor's lines). Undefined when none applies.
function overlaid(model, template, patches) {
  const files = [];
  if (model.governor && patches.governor) files.push(`${OVERLAY.governor}/${patches.governor}`);
  if (model.simulate && patches.simulate) files.push(`${OVERLAY.simulate}/${patches.simulate}`);
  if (model.simulate && model.governor && patches.governed) files.push(`${OVERLAY.simulate}/${patches.governed}`);
  // the cockpit's audited entry points go on last, over whatever the set already has
  if (model.cockpit && patches.cockpit) files.push(`${OVERLAY.cockpit}/${patches.cockpit}`);
  if (!files.length && !model.autodoctor && !model.resilience?.doctor.explicit_every) return undefined;
  let text = readFileSync(template, "utf8");
  const original = text;
  const tracker = templateOrigins(template,text);
  for (const file of files) text = governorTemplate(text, JSON.parse(readFileSync(file, "utf8")), tracker.observe, file);
  if (model.replay && patches.simulate) {
    text = replayOverlay(text, template === PORT_TEMPLATES.factory ? "factory" : "runner", tracker.observe);
  }
  text = doctorOverlay(model, text, template === JOB_TEMPLATE ? "job" : template === SET_TEMPLATE ? "runner" : "port", tracker.observe);
  return {templateText: text, tracker, original, replay: model.replay && patches.simulate ? ["recipes/l3-replay/overlay.json"] : [], sim: files.filter((f) => f.startsWith(OVERLAY.simulate))};
}
async function renderWith(model, template, patches) {
  const {renderRecipe} = await import("./dsl-abap.mjs");
  let over = overlaid(model, template, patches);
  const base = () => {
    const original = readFileSync(template,"utf8");
    return {templateText:original,original,tracker:templateOrigins(template,original),sim:[],replay:[]};
  };
  if (model.snapshots && template === SET_TEMPLATE) {
    over ??= base();
    over.templateText = snapshotOverlay(model,over.templateText,over.tracker.observe);
  }
  if (model.remote && template === SET_TEMPLATE) {
    over ??= base();
    over.templateText = remoteOverlay(model,over.templateText,over.tracker.observe);
  }
  const result = await renderRecipe(model, template, {profile: "abap", ...(over ? {templateText: over.templateText, templateOrigins: over.templateText === over.original ? undefined : over.tracker.origins} : {})});
  return over?.sim.length ? {...result, simOverlays: over.sim, replayOverlays: over.replay} : result;
}

// The files of a set, name -> content. What the abap profile refuses is a
// SetError at the manifest line of the node the line traces to.
export async function renderSet(model) {
  const {renderRecipe} = await import("./dsl-abap.mjs");
  const quiet = console.log;
  let runner, job;
  try {
    console.log = (...items) => console.error(...items); // runtime bootstrap diagnostics
    runner = await renderWith(model, SET_TEMPLATE, {governor: "runner.patch.json", simulate: "runner.patch.json", governed: "runner-governed.patch.json", cockpit: "runner.patch.json"});
    job = await renderWith(model, JOB_TEMPLATE, {governor: "job.patch.json"});
  } finally {
    console.log = quiet;
  }
  const known = linesById(model);
  const nodeLine = (nodeId) => known.get(nodeId) ?? model.set_line;
  const extra = await renderPorts(model);
  const remoteFiles = model.remote ? await renderRemote(model, {classXml}) : {};
  scanGeneratedUnits(model, runner.text, extra.results, remoteFiles);
  const results = [[`${model.class}.clas.abap`, runner], [`${model.report}.prog.abap`, job], ...extra.results];
  const doctor = await renderDoctor(model, {renderRecipe, sidecar, progXml, classXml});
  results.push(...doctor.results);
  Object.assign(extra.files, doctor.files);
  if (model.settings) {
    for (const [name, template, kind] of [[model.settings.class, "recipes/l3-settings/class.tpl", "clas"],
      [model.settings.report, "recipes/l3-settings/report.tpl", "prog"]]) {
      // the governor's patch, then the twin's (the sum of the outcome shares), then the cockpit's
      let text = readFileSync(template, "utf8");
      const original = text;
      const tracker = templateOrigins(template,text);
      if (kind === "clas") {
        for (const file of [
          ...(model.governor ? ["recipes/l3-governor/settings.patch.json"] : []),
          ...(model.settings.chaos_sum ? ["recipes/l3-sim/settings.patch.json"] : []),
        ]) text = governorTemplate(text, JSON.parse(readFileSync(file,"utf8")), tracker.observe, file);
      }
      text = cockpitRunnerTemplate(model,text,kind === "clas" ? "settings" : "settings-report",tracker.observe);
      const rendered = await renderRecipe(model,template,{profile:"abap",templateText:text,templateOrigins:text === original ? undefined : tracker.origins});
      results.push([`${name}.${kind}.abap`, rendered]);
    }
  }
  for (const [name, result] of results) {
    const error = result.findings.find((f) => f.severity === "E");
    if (error) throw new SetError(model.where ?? model.source, nodeLine(error.node), `the generated ${name} line ${error.line}: ${error.text} (${error.rule}, ${error.node})`);
  }
  return {
    files: convertFiles({
      ...extra.files, ...await renderProof(model, {renderRecipe, sidecar, classXml}),
      ...remoteFiles,
      ...(model.cockpit ? await renderCockpit(model) : {}),
      ...(model.settings ? Object.fromEntries(results.slice(-2).flatMap(([name, result]) => [
        [name, result.text], [name.replace(/\.(clas|prog)\.abap$/, ".$1.xml"), name.endsWith(".clas.abap")
          ? classXml(model, model.settings.class, `L3 settings of ${model.set}`) : progXml({...model, report: model.settings.report})],
        [name.replace(/\.abap$/, ".trace.json"), sidecar(model, name.endsWith(".clas.abap")
          ? "recipes/l3-settings/class.tpl" : "recipes/l3-settings/report.tpl", result)],
      ])) : {}),
      [`${model.class}.clas.abap`]: runner.text,
      [`${model.class}.clas.xml`]: classXml(model),
      [`${model.class}.clas.trace.json`]: sidecar(model, SET_TEMPLATE, runner),
      [`${model.report}.prog.abap`]: job.text,
      [`${model.report}.prog.xml`]: progXml(model),
      [`${model.report}.prog.trace.json`]: sidecar(model, JOB_TEMPLATE, job),
    }, {model}),
    findings: [...results.filter(([name]) => /_(dmn\.clas|doc\.prog)\.abap$/.test(name)).flatMap(([name, r]) => r.findings.map((f) => ({...f, file: name}))),
      ...runner.findings.map((f) => ({...f, file: `${model.class}.clas.abap`})),
      ...job.findings.map((f) => ({...f, file: `${model.report}.prog.abap`})),
      ...extra.results.flatMap(([name, r]) => r.findings.map((f) => ({...f, file: name}))),
      ...(model.settings ? results.slice(-2).flatMap(([name, r]) => r.findings.map((f) => ({...f, file: name}))) : [])],
  };
}

// The interface of each port, its generated variants, the factory and the
// exception class, each rendered from a model of its own whose root is the
// node it traces to: the port for an interface, the variant for a variant
// class, the set for the factory.
async function renderPorts(model) {
  const {renderRecipe} = await import("./dsl-abap.mjs");
  const quiet = console.log;
  const files = {}, results = [];
  const base = {set: model.set, "set@type": CHAR(WIDTH.set), source: model.source, ports_class: model.ports_class, exception: model.exception};
  const one = async (name, ext, root, template, descript, interface_ = false) => {
    let result;
    try {
      console.log = (...items) => console.error(...items);
      result = template === "factory" ? await renderWith(root, PORT_TEMPLATES[template], {simulate: "factory.patch.json"})
        : await renderRecipe(root, PORT_TEMPLATES[template], {profile: "abap"});
    } finally { console.log = quiet; }
    results.push([`${name}.${ext}.abap`, result]);
    files[`${name}.${ext}.abap`] = result.text;
    files[`${name}.${ext}.xml`] = interface_ ? intfXml(name, descript) : classXml(model, name, descript);
    files[`${name}.${ext}.trace.json`] = sidecar(root, PORT_TEMPLATES[template], result);
  };
  for (const port of model.ports) {
    const {variants, binding, ...fields} = port;
    const portRoot = {...base, ...fields, port: port.name, "@id": port["@id"], set_line: port.set_line};
    await one(port.iface, "intf", portRoot, port.is_autoclose ? "iface-autoclose" : port.is_work ? "iface-work" : port.is_source ? "iface-source" : "iface-sink", `L3 port ${port.name} of ${model.set}`, true);
    for (const variant of variants) {
      // a hand-written class is its author's; the work's real variant is the runner's own calls
      if (!variant.generated || variant.is_inline || variant.is_remote) continue;
      const root = {...portRoot, "@id": variant["@id"], set_line: variant.set_line, variant: variant.name, ...(port.is_work ? {"variant@type": CHAR(30)} : {}), class: variant.class,
        capture: variant.is_capture, dummy: variant.is_dummy, ...(variant.is_replay ? {sim: model.replay, replay: model.replay} : {})};
      const template = port.is_autoclose ? (variant.is_sim ? "autoclose-sim" : "autoclose") : port.is_work ? "work-sim"
        : port.is_source ? (variant.is_table ? "source-table" : variant.is_worklist ? "source-worklist" : "source-mem")
        : variant.is_log ? "sink-log" : variant.is_dummy ? "sink-dummy" : "sink-capture";
      await one(variant.class, "clas", root, template, `L3 port ${port.name}, variant ${variant.name}`);
    }
  }
  const setRoot = {...model};
  await one(model.ports_class, "clas", setRoot, "factory", `L3 ports of ${model.set}`);
  await one(model.exception, "clas", setRoot, "exception", `L3 port refusal of ${model.set}`);
  return {files, results};
}

export async function buildSet(file, out, options = {}) {
  const model = compileSet(file, {out, ...options});
  const rendered = await renderSet(model);
  mkdirSync(out, {recursive: true});
  for (const [name, content] of Object.entries(rendered.files)) {
    mkdirSync(dirname(join(out, name)), {recursive: true});
    writeFileSync(join(out, name), content);
  }
  return {model, ...rendered};
}

// Regenerate into a scratch folder and compare byte for byte with `out`.
export async function checkSet(file, out, options = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "dsl-l3-"));
  try {
    const {files} = await buildSet(file, scratch, {...options, out});
    const drift = [];
    for (const name of Object.keys(files)) {
      let committed;
      try { committed = readFileSync(join(out, name)); } catch { drift.push(`${name}: missing in ${out}`); continue; }
      if (!committed.equals(readFileSync(join(scratch, name)))) drift.push(`${name}: differs from a fresh build`);
    }
    return drift;
  } finally {
    rmSync(scratch, {recursive: true, force: true});
  }
}

// ---------------------------------------------------------------------------
// explain: an alert key down to the rule line and the generated check lines

// `<set>/<rule>/<model hash>/<check date>/<pile>/<seq>`; the hash is the full
// `sha256:<hex>` or at least eight of its hex digits.
export function parseAlertKey(key) {
  const parts = String(key).split("/");
  if (![5, 6].includes(parts.length)) throw new Error(`an alert key is <set>/<rule>/<model hash>/<check date>/<pile>/<seq>, got ${JSON.stringify(key)}`);
  const [set, rule, hash, date, ...tail] = parts;
  const [pile, seq] = tail.length === 1 ? ["0", tail[0]] : tail;
  const hex = hash.replace(/^sha256:/, "");
  if (!/^[0-9a-f]{8,64}$/.test(hex)) throw new Error(`model hash ${hash} is sha256:<hex> or at least 8 of its hex digits`);
  if (!/^\d{8}$/.test(date)) throw new Error(`check date ${date} is YYYYMMDD`);
  if (!/^\d+$/.test(pile)) throw new Error(`pile ${pile} is a non-negative number`);
  if (!/^\d+$/.test(seq) || Number(seq) < 1) throw new Error(`alert sequence ${seq} is a number from 1`);
  return {set, rule, hash: hex, date, pile: Number(pile), seq: Number(seq)};
}

function setFiles(root = "src") {
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isDirectory()) walk(join(dir, entry.name));
      else if (entry.name.endsWith(".l3.yaml")) found.push(join(dir, entry.name));
    }
  };
  if (existsSync(root)) walk(root);
  return found;
}

const git = (args) => spawnSync("git", args, {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});


function alertRow(db, key) {
  if (!db) return undefined;
  return import("node:sqlite").then(({DatabaseSync}) => {
    const handle = new DatabaseSync(db, {readOnly: true});
    try {
      const alert = handle.prepare(`SELECT * FROM zosd_l3_alert WHERE set_name = ? AND rule_name = ? AND model_hash LIKE ?
        AND check_date = ? AND pile_no = ? AND alert_seq = ?`).get(key.set, key.rule, `sha256:${key.hash}%`, key.date, key.pile, key.seq);
      // the plan row of the alert's pile, by its run (an older database has no plan table)
      let pile;
      let settings = [], events = [], budget, snapshots = [], remote;
      try {
        if (alert && /^[a-z][a-z0-9_]{0,12}$/.test(key.set)) remote = handle.prepare(`SELECT * FROM zl3_${key.set}_rlink WHERE set_name = ? AND (run_id = ? OR remote_run = ?) ORDER BY linked DESC`).get(key.set, alert.run_id, alert.run_id);
      } catch { remote = undefined; }
      try {
        pile = alert && handle.prepare(`SELECT * FROM zosd_l3_pile WHERE set_name = ? AND run_id = ? AND rule_name = ? AND pile_no = ?`)
          .get(key.set, alert.run_id, key.rule, key.pile);
      } catch { pile = undefined; }
      try {
        if (alert) settings = handle.prepare(`SELECT * FROM zosd_l3_run_conf WHERE set_name = ? AND run_id = ? ORDER BY param_name`)
          .all(key.set, alert.run_id);
      } catch { settings = []; }
      try {
        if (alert) {
          events = handle.prepare(`SELECT * FROM zosd_l3_event WHERE run_id = ? AND set_name = ? ORDER BY seq`).all(alert.run_id, key.set);
          budget = handle.prepare(`SELECT * FROM zosd_l3_budget WHERE run_id = ? AND set_name = ?`).get(alert.run_id, key.set);
        }
      } catch { events = []; }
      try {
        if (alert) snapshots = handle.prepare(`SELECT * FROM zosd_l3_run_snap WHERE set_name = ? AND run_id = ? ORDER BY stage_no`).all(key.set, alert.run_id);
      } catch { snapshots = []; }
      return alert && {...alert, pile, settings, events, budget, snapshots, remote};
    } finally { handle.close(); }
  });
}

// what the pile of an alert was: a piled rule's pile of the plan (its range
// when the plan row is at hand), or the one pile 0 of a rule that is not piled
function pileLine(model, entry, k, file, row) {
  if (!model.piles) return `pile    ${k.pile}: the set has no piles:, every rule runs as one pile`;
  const at = `${path(file)}:${model.piles.set_line}`;
  if (!entry.piled) return `pile    ${k.pile}: the rule is not piled (its range: is not ${model.piles.source.key} of ${model.piles.source.table.toUpperCase()}), one pile over every row (${at})`;
  const range = row ? `, range ${String(row.range_low).trim() === String(row.range_high).trim() ? `I EQ ${String(row.range_low).trim()}`
    : `I BT ${String(row.range_low).trim()} ${String(row.range_high).trim()}`}, ${String(row.status).trim()}` : "";
  return `pile    ${k.pile} of the plan, ${model.piles.size} keys of ${model.piles.source.key} per pile (${at})${range}`;
}

// alert -> set and rule -> the rule version -> its alert line -> the lines of
// the generated check that trace to it. `row` is the alert row when known.
export async function explainAlert(key, {sets = setFiles(), db, row} = {}) {
  const k = typeof key === "string" ? parseAlertKey(key) : key;
  const found = sets.map((file) => ({file, model: compileSet(file)})).find((s) => s.model.set === k.set);
  if (!found) throw new Error(`no set ${k.set} in ${sets.map(path).join(", ") || "(no .l3.yaml found)"}`);
  const {model} = found;
  const entry = [...model.rules, ...model.disabled].find((r) => r.name === k.rule);
  if (!entry) throw new Error(`set ${k.set} (${path(found.file)}) has no rule ${k.rule}`);
  const top = git(["rev-parse", "--show-toplevel"]);
  const base = top.status === 0 ? top.stdout.trim() : process.cwd();
  const version = ruleVersion(entry, k.hash, base);
  if (!version) throw new Error(`rule ${k.rule}: no version with model hash ${k.hash} in the working tree or in git history of ${entry.file}`);
  const alertRowFound = row ?? await alertRow(db, k);
  const ruleLines = version.rule.split("\n");
  const ruleLine = alertRowFound?.rule_line ? Number(alertRowFound.rule_line) : Number(entry.alert_line);
  const checkLines = version.check.split("\n");
  const alertNode = `rule/${k.rule}/alert`;
  const generated = version.trace.lines.filter((l) => version.trace.format === "osd-trace/1"
    ? l.sources.some(s => s.node === alertNode || s.node.startsWith(`${alertNode}/`))
    : l.rule_line === ruleLine).map((l) => l.line);
  const runnerTrace = readTraceFile(join(dirname(found.file), `${model.class}.clas.trace.json`));
  const runnerLines = runnerTrace.lines.filter((l) => runnerTrace.format === "osd-trace/1"
    ? l.sources.some(s => s.node === entry["@id"])
    : l.node === entry["@id"]).map((l) => l.line);
  const out = [
    `alert   ${k.set}/${k.rule}/sha256:${k.hash.slice(0, 12)}.../${k.date}/${k.pile}/${k.seq}`,
    ...(alertRowFound ? [`text    ${String(alertRowFound.alert_text).trimEnd()}`, `run     ${String(alertRowFound.run_id).trim()} at ${alertRowFound.run_ts}`] : []),
    ...(alertRowFound?.remote ? [`remote  ${String(alertRowFound.remote.remote_run).trim()} (detecting run ${String(alertRowFound.remote.run_id).trim()})`] : []),
    ...(alertRowFound?.snapshots ?? []).map((s) => `snapshot ${String(s.snap_name).trim()}: id ${String(s.snap_id).trim()}, SHA256 ${String(s.content_hash).trim()}, rows ${s.row_count}, stage ${s.stage_no}`),
    ...(alertRowFound?.settings?.length ? ["settings effective for this run:", ...alertRowFound.settings.map((s) =>
      `  ${String(s.param_name).trim()} = ${String(s.param_val).trim()} (${String(s.origin).trim()}, DSL ${String(s.dsl_value).trim()}${String(s.origin).trim() === "USER" ? `; ${String(s.changed_by).trim()} at ${s.changed_at}` : ""})`)] : []),
    ...(alertRowFound?.budget ? [`governor ${String(alertRowFound.budget.state).trim()}: open ${alertRowFound.budget.reserved}, glass ${alertRowFound.budget.glass}, consumed ${alertRowFound.budget.consumed}, refunded ${alertRowFound.budget.refunded}`,
      ...(alertRowFound.events ?? []).map((e) => `  ${e.seq} ${String(e.kind).trim()}: open ${e.reserved}/${e.glass}, amount ${e.amount}, ${String(e.reason).trim()} (${String(e.actor).trim()} at ${e.acted})`)] : []),
    `set     ${path(found.file)}:${entry.set_line}: ${readFileSync(found.file, "utf8").split("\n")[entry.set_line - 1].trim()}`,
    `rule    ${k.rule}, ${entry.file} as of ${version.where}, model ${version.trace.model}`,
    `line    ${entry.file}:${ruleLine}: ${(ruleLines[ruleLine - 1] ?? "").trim()}`,
    `check   ${entry.check_class}.clas.abap, ${generated.length} line(s) trace to rule line ${ruleLine}:`,
    ...generated.map((n) => `  ${String(n).padStart(5)}  ${checkLines[n - 1]}`),
    ...(model.staged ? explainStage(model, entry, k, (n) => `${path(found.file)}:${n}`, alertRowFound?.pile) : [pileLine(model, entry, k, found.file, alertRowFound?.pile)]),
    `runner  ${model.class}.clas.abap lines ${compress(runnerLines)} trace to set line ${entry.set_line}`,
  ];
  return {text: out.join("\n"), set: found.file, rule: entry, ruleLine, generated, runnerLines, version: version.where};
}

const compress = (numbers) => {
  const out = [];
  for (const n of numbers) {
    const last = out.at(-1);
    if (last && last[1] === n - 1) last[1] = n; else out.push([n, n]);
  }
  return out.map(([a, b]) => (a === b ? `${a}` : `${a}-${b}`)).join(", ");
};

async function main(args) {
  const [command, target, ...rest] = args;
  const ddic = [];
  const sets = [];
  let out, db, docs, run, profile;
  const formats = [];
  const settings = {};
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--out") out = rest[++i];
    else if (command === "graph" && ["--mermaid", "--json"].includes(rest[i])) formats.push(rest[i].slice(2));
    else if (command === "graph" && rest[i] === "--docs") docs = rest[++i];
    else if (command === "graph") throw new Error(`unknown argument ${rest[i]} (graph takes --mermaid, --json, --out <file>, --docs <file>)`);
    else if (rest[i] === "--ddic") ddic.push(rest[++i]);
    else if (rest[i] === "--set") sets.push(rest[++i]);
    else if (rest[i] === "--db") db = rest[++i];
    else if (rest[i] === "--run") run = rest[++i];
    else if (rest[i] === "--profile") profile = rest[++i];
    else if (rest[i] === "--setting") {
      const pair = /^(\S+)=(.+)$/.exec(rest[++i] ?? "");
      if (!pair) throw new Error("--setting is name=value");
      settings[pair[1]] = pair[2];
    }
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (command === "graph" && target) {
    if (formats.length > 1) throw new Error("graph prints one format: --mermaid or --json");
    const graph = graphOf(compileSet(target));
    const text = formats[0] === "json" ? graphJson(graph) : graphMermaid(graph);
    if (docs !== undefined) {
      const drift = formats[0] === "json" ? "--docs checks the mermaid copy" : docDrift(docs, graph.set, text);
      console.log(drift || `${docs}: the diagram of ${graph.set} matches`);
      return drift ? 1 : 0;
    }
    if (out) writeFileSync(out, text); else process.stdout.write(text);
    return 0;
  }
  if (command === "profile" && target) {
    const {profileRun} = await import("./dsl-l3-profile.mjs");
    const text = JSON.stringify(profileRun(compileSet(target), {run, db}), null, 2) + "\n";
    if (out) writeFileSync(out, text); else process.stdout.write(text);
    return 0;
  }
  if (command === "whatif" && target) {
    if (!db || (!run && !profile)) throw new Error("whatif needs --db and --run or --profile");
    const {whatif} = await import("./dsl-l3-whatif.mjs");
    const log = console.log;
    let result;
    try { console.log = (...items) => console.error(...items); result = await whatif(target, {run, db, profile, settings}); }
    finally { console.log = log; }
    console.log(JSON.stringify(result, null, 2));
    return 0;
  }
  if (command === "explain" && target) {
    const {text} = await explainAlert(target, {...(sets.length ? {sets} : {}), db});
    console.log(text);
    return 0;
  }
  if (!["build", "check"].includes(command) || !target || !out) {
    console.error("Usage: node tools/dsl-l3.mjs <build|check> <set.l3.yaml> --out <dir> [--ddic <folder>]...\n"
      + "       node tools/dsl-l3.mjs graph <set.l3.yaml> [--mermaid|--json] [--out <file>] [--docs <doc.md>]\n"
      + "       node tools/dsl-l3.mjs profile <set.l3.yaml> --run <id> --db <sqlite> [--out <profile.json>]\n"
      + "       node tools/dsl-l3.mjs whatif <set.l3.yaml> --db <sqlite> <--run <id>|--profile <json>> [--setting name=value]...\n"
      + "       node tools/dsl-l3.mjs explain <set>/<rule>/<model hash>/<date>/<pile>/<seq> [--set <set.l3.yaml>]... [--db <sqlite file>]");
    return 2;
  }
  const options = ddic.length ? {ddic} : {};
  if (command === "check") {
    const drift = await checkSet(target, out, options);
    for (const line of drift) console.error(line);
    console.log(drift.length ? `${target}: ${drift.length} file(s) drifted; rebuild with: node tools/dsl-l3.mjs build ${target} --out ${out}`
      : `${target}: generated files match`);
    return drift.length ? 1 : 0;
  }
  const {files, findings} = await buildSet(target, out, options);
  for (const name of Object.keys(files)) console.log(`wrote ${join(out, name)}`);
  console.log(`abap profile: ${findings.length} finding(s)`);
  for (const f of findings) console.log(`${f.severity} ${f.file}:${f.line} ${f.rule}: ${f.text} (${f.node})`);
  return findings.some((f) => f.severity === "E") ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // exit only once stdout and stderr have drained: a piped stdout is
  // asynchronous, and process.exit() right after console.log loses the output
  const flushThenExit = (code) => process.stdout.write("", () => process.stderr.write("", () => process.exit(code)));
  main(traceArgs(process.argv.slice(2))).then(flushThenExit, (error) => {
    console.error(error.message);
    flushThenExit(1);
  });
}
