// R1: concrete ABAP types, without changing abaplint or executing RAP.
import * as core from "@abaplint/core";
import {createHash} from "node:crypto";
import {basename, join, resolve} from "node:path";
import {existsSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync} from "node:fs";
import {parseBdef} from "./bdef-parse.mjs";
import {parseDDLS} from "../cds2ddic.mjs";
import {contentFoldersOf, winningByLayer} from "../osd-packs.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {runsAs} from "../osd-main.mjs";
import {fieldControl, runtimeOutputs} from "./rap-runtime-gen.mjs";
import {parseSrvd, serviceYaml} from "./srvd-gen.mjs";

const upper = s => s.toUpperCase();
const ident = s => /^[A-Z_%][A-Z0-9_%]*$/i.test(s);
const digest = s => createHash("sha256").update(s).digest("hex").slice(0, 16);
export function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name)).flatMap(e =>
    e.isSymbolicLink() || e.name.startsWith(".") ? [] : e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)]);
}
const struct = (name, fields) => {
  if (!fields.length) throw new Error(`Empty RAP structure ${name}`);
  return `  TYPES: BEGIN OF ${name},\n${fields.map(([n, t]) => `           ${n} TYPE ${t},`).join("\n")}\n         END OF ${name}.\n`;
};
// Named includes preserve both direct fields and RAP component groups.
const included = (name, type, group, fields = []) => `  TYPES BEGIN OF ${name}.\n  INCLUDE TYPE ${type} AS ${group}.\n`
  + fields.map(([n, t]) => `  TYPES ${n} TYPE ${t}.\n`).join("") + `  TYPES END OF ${name}.\n`;

/** Input files are already selected by content layer, never test/ or libraries' BDEFs. */
export function generate(files, dependencies = []) {
  const bdefs = files.filter(f => f.filename.endsWith(".bdef.asbdef"));
  const srvds = files.filter(f => f.filename.endsWith(".srvd.srvdsrv"));
  if (!bdefs.length && !srvds.length) return {outputs: {}, bindings: {}};
  const reg = new core.Registry(new core.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {}})));
  const ddic = f => /\.(ddls\.(asddls|xml)|tabl\.xml|view\.xml|dtel\.xml|doma\.xml)$/.test(f.filename);
  reg.addFiles(files.filter(ddic).map(f => new core.MemoryFile(f.filename, f.contents)));
  reg.addDependencies(dependencies.filter(ddic).map(f => new core.MemoryFile(f.filename, f.contents)));
  reg.parse();
  const views = new Map(reg.getObjectsByType("DDLS").map(o => {
    const view = parseDDLS(o, reg);
    // The CDS generator skips unsupported expressions; a type generator must
    // refuse them, since losing a component would change a method contract.
    let elements = 0;
    const visit = n => {
      if (n?.get?.().constructor.name === "CDSElement") elements++;
      for (const child of n?.getChildren?.() ?? []) visit(child);
    };
    visit(o.getParsedData()?.tree);
    if (view && !view.skip && elements !== view.fields.length + view.exposedAssociations.length) view.skip = "unsupported CDS elements";
    return [upper(o.getName()), view];
  }));
  const fieldsOf = (name, visiting = new Set()) => {
    const key = upper(name);
    if (visiting.has(key)) throw new Error(`Cyclic CDS type ${name}`);
    const next = new Set([...visiting, key]);
    const view = views.get(key);
    if (!view || view.skip || !view.fields.length) throw new Error(`Unresolved CDS entity ${name}${view?.skip ? `: ${view.skip}` : ""}`);
    const base = reg.getObject("TABL", view.source) ?? reg.getObject("VIEW", view.source);
    if (!base && !views.has(upper(view.source))) throw new Error(`Unresolved CDS entity ${view.source}`);
    const components = new Map((base?.parseType(reg)?.getComponents?.() ?? []).map(c => [upper(c.name), c.type]));
    const below = !base && views.has(upper(view.source)) ? fieldsOf(view.source, next) : [];
    return view.fields.map(f => {
      const type = components.get(upper(f.base));
      const sourceType = type && !type.containsVoid?.() && !/Unknown|Void/.test(type.constructor.name) ? type.toABAP() : below.find(b => upper(b.name) === upper(f.base))?.type;
      if (!f.virtual && !sourceType) throw new Error(`Unresolved CDS field ${name}.${f.name}`);
      const abap = f.abapType ?? sourceType;
      if (!ident(f.name) || !abap || /todo|unknown|void/i.test(abap)) throw new Error(`Unresolved CDS field ${name}.${f.name}`);
      return {name: f.name.toLowerCase(), type: abap, key: f.key, base: f.base};
    });
  };
  const outputs = {}, bindings = {}, plans = [];
  const bind = (form, kind, ref, type) => {
    const key = upper(`${form} FOR ${kind} ${ref}`);
    if (bindings[key] && bindings[key] !== type) throw new Error(`Ambiguous RAP reference ${ref}`);
    bindings[key] = type;
  };
  for (const file of bdefs) {
    const model = parseBdef(file.contents);
    if (model.unparsed.length) throw new Error(`${file.filename}: unparsed BDEF grammar`);
    if (model.implementationType !== "managed" && model.implementationType !== "unmanaged") throw new Error(`${file.filename}: unsupported ${model.implementationType} BDEF (projection uses need resolution)`);
    const root = basename(file.filename).replace(/\.bdef\.asbdef$/, "");
    const iface = `zif_rap_${digest(upper(root))}`;
    let body = `INTERFACE ${iface} PUBLIC.\n`;
    const responses = new Map();
    const plan = {root, iface, model, entities: []};
    plans.push(plan);
    for (const [index, entity] of model.entities.entries()) {
      if (entity.associations.length || entity.functions.length || entity.determineActions.length) throw new Error(`${entity.entity}: associations/functions/determine actions are outside R1`);
      const p = `e${index}`;
      const fields = fieldsOf(entity.entity);
      plan.entities.push({entity, prefix: p, fields, source: views.get(upper(entity.entity)).source});
      if (entity.persistentTable && !reg.getObject("TABL", entity.persistentTable)) throw new Error(`${entity.entity}: missing persistent table ${entity.persistentTable}`);
      for (const mapping of entity.mappings) {
        const table = reg.getObject("TABL", mapping.table);
        if (!table) throw new Error(`${entity.entity}: missing mapping table ${mapping.table}`);
        const columns = table.parseType(reg)?.getComponents?.() ?? [];
        for (const field of mapping.fields) {
          if (!fields.some(f => upper(f.name) === upper(field.field))) throw new Error(`${entity.entity}: unknown mapping field ${field.field}`);
          if (!columns.some(c => upper(c.name) === upper(field.column))) throw new Error(`${entity.entity}: unknown mapping column ${mapping.table}.${field.column}`);
        }
      }
      const keys = fields.filter(f => f.key);
      if (!keys.length) throw new Error(`${entity.entity}: no CDS key`);
      const pairs = fs => fs.map(f => [f.name, f.type]);
      body += struct(`${p}_key`, pairs(keys));
      body += included(`${p}_pky`, `${p}_key`, "%key", entity.numbering === "late" ? [["%pid", "x LENGTH 16"]] : []);
      body += included(`${p}_tky`, `${p}_pky`, "%pky", model.withDraft ? [["%is_draft", "x LENGTH 1"]] : []);
      body += struct(`${p}_control`, fields.map(f => [f.name, "x LENGTH 1"]));
      // %data includes all CDS fields with a key group; %tky shares its key fields.
      body += included(`${p}_data`, `${p}_tky`, "%tky", pairs(fields.filter(f => !f.key)));
      body += struct(`${p}_fail`, [["cause", "i"]]);
      const opFields = entity.operations.map(o => [`%${o.kind}`, "x LENGTH 1"]);
      if (entity.actions.length) {
        body += struct(`${p}_actions`, entity.actions.map(a => [a.name.toLowerCase(), "x LENGTH 1"]));
        opFields.push(["%action", `${p}_actions`]);
      }
      if (opFields.length) body += struct(`${p}_op`, opFields);
      const refs = new Set([entity.entity, `${root}\\${entity.alias ?? entity.entity}`, `${root}\\${entity.entity}`]);
      // R3: the implicit handler forms name an entity by its alias or CDS name,
      // resolved against the behavior definition of the pool they are in
      const pool = upper(entity.implementationClass ?? model.implementationClass ?? "");
      const local = [...new Set([entity.alias ?? entity.entity, entity.entity])];
      const poolBind = (kind, ref, type) => { if (pool) bind(`POOL ${pool}`, kind, ref, type); };
      for (const kind of ["CREATE", "UPDATE", "DELETE", "READ IMPORT", "READ RESULT", "MAPPED", "FAILED", "REPORTED", "LOCK", "KEY OF", "DETERMINATION", "VALIDATION"]) {
        if (["CREATE", "UPDATE", "DELETE"].includes(kind) && !entity.operations.some(o => upper(o.kind) === kind)) continue;
        const name = `${p}_${kind.toLowerCase().replaceAll(" ", "_")}`;
        const fullData = ["CREATE", "UPDATE", "READ RESULT"].includes(kind);
        const extra = [];
        if (["CREATE", "MAPPED", "FAILED", "REPORTED"].includes(kind)) extra.push(["%cid", "c LENGTH 128"]);
        if (["UPDATE", "DELETE"].includes(kind)) extra.push(["%cid_ref", "c LENGTH 128"]);
        if (["CREATE", "UPDATE", "READ IMPORT"].includes(kind)) extra.push(["%control", `${p}_control`]);
        if (kind === "FAILED") extra.push(["%fail", `${p}_fail`], ...(opFields.length ? [["%op", `${p}_op`]] : []));
        if (kind === "REPORTED") extra.push(["%msg", "REF TO object"], ["%element", `${p}_control`], ["%state_area", "c LENGTH 128"], ["%global", "x LENGTH 1"]);
        body += included(name, `${p}_${fullData ? "data" : "tky"}`, fullData ? "%data" : "%tky", extra);
        body += `  TYPES t_${name} TYPE STANDARD TABLE OF ${name} WITH DEFAULT KEY.\n`;
        for (const ref of local) poolBind(kind, ref, `${iface}=>t_${name}`);
        for (const ref of refs) {
          bind("TABLE", kind, ref, `${iface}=>t_${name}`);
          bind("STRUCTURE", kind, ref, `${iface}=>${name}`);
          if (["MAPPED", "FAILED", "REPORTED"].includes(kind)) {
            bind("TABLE", `${kind} EARLY`, ref, `${iface}=>t_${name}`);
            bind("STRUCTURE", `${kind} EARLY`, ref, `${iface}=>${name}`);
          }
        }
        if (["MAPPED", "FAILED", "REPORTED"].includes(kind)) {
          const list = responses.get(kind) ?? [];
          list.push([(entity.alias ?? entity.entity).toLowerCase(), `t_${name}`]); responses.set(kind, list);
        }
      }
      for (const [a, action] of entity.actions.entries()) {
        if (action.use || action.modifiers.length || action.parameter?.deep || action.parameter?.table || action.result?.deep) throw new Error(`${entity.entity}~${action.name}: unsupported action modifiers/parameter shape`);
        const param = action.parameter ? fieldsOf(action.parameter.name) : undefined;
        if (param) body += struct(`${p}_a${a}_param`, pairs(param));
        for (const kind of ["IMPORT", "RESULT"]) {
          if (kind === "RESULT" && !action.result) continue;
          const extra = [];
          if (kind === "IMPORT") extra.push(["%cid_ref", "c LENGTH 128"], ...(param ? [["%param", `${p}_a${a}_param`]] : []));
          else {
            const result = action.result.type === "$self" ? fields : fieldsOf(action.result.type);
            body += struct(`${p}_a${a}_payload`, pairs(result));
            extra.push(["%param", `${p}_a${a}_payload`]);
          }
          const name = `${p}_a${a}_${kind.toLowerCase()}`;
          body += included(name, `${p}_tky`, "%tky", extra);
          body += `  TYPES t_${name} TYPE STANDARD TABLE OF ${name} WITH DEFAULT KEY.\n`;
          for (const ref of refs) for (const form of ["TABLE", "STRUCTURE"]) bind(form, `ACTION ${kind}`, `${ref}~${action.name}`, `${iface}=>${form === "TABLE" ? "t_" : ""}${name}`);
          for (const ref of local) poolBind(`ACTION ${kind}`, `${ref}~${action.name}`, `${iface}=>t_${name}`);
        }
      }
    }
    for (const [kind, fields] of responses) {
      if (fields.some(([n]) => !ident(n))) throw new Error(`${root}: response aliases must be ABAP identifiers`);
      const name = `r_${kind.toLowerCase()}`;
      body += struct(name, fields);
      for (const phase of ["", " EARLY"]) bind("RESPONSE", kind + phase, root, `${iface}=>${name}`);
      for (const pool of new Set([model.implementationClass, ...model.entities.map(e => e.implementationClass)].filter(Boolean).map(upper))) {
        bind(`POOL ${pool}`, "RESPONSE", kind, `${iface}=>${name}`);
      }
    }
    outputs[`${iface}.intf.abap`] = body + "ENDINTERFACE.\n";
  }
  // R2c: a service definition becomes a stg-compile model in gen/rap/
  const entityOf = name => {
    const view = views.get(upper(name));
    if (!view || view.skip) throw new Error(`Unresolved CDS entity ${name}${view?.skip ? `: ${view.skip}` : ""}`);
    const fields = fieldsOf(name);
    const owner = plans.flatMap(p => p.entities.map(e => ({p, e}))).find(({e}) => upper(e.entity.entity) === upper(name));
    if (!owner) return {view, fields};
    const {entity} = owner.e;
    const has = op => entity.operations.some(o => o.kind === op && !o.use);
    return {view, fields, behavior: {create: has("create"), update: has("update"), delete: has("delete"),
      control: fieldControl(entity, fields), actions: entity.actions.map(a => a.name)}};
  };
  for (const file of srvds) {
    const srvd = parseSrvd(file.contents, file.filename);
    const stem = basename(file.filename).replace(/\.srvd\.srvdsrv$/, "");
    if (upper(stem) !== srvd.name) throw new Error(`${file.filename}: defines ${srvd.name}`);
    outputs[`${stem.toLowerCase()}.stg.yaml`] = serviceYaml(srvd, entityOf, file.filename);
  }
  return {outputs, bindings, plans};
}

export function main() {
  const root = process.env.OSD_ROOT ?? process.cwd();
  const paths = winningByLayer(contentFoldersOf(root).map(f => resolve(root, f)), walk, f => basename(f).toLowerCase());
  const files = paths.filter(f => /\.(bdef\.asbdef|srvd\.srvdsrv|ddls\.(asddls|xml)|tabl\.xml|view\.xml|dtel\.xml|doma\.xml)$/.test(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
  const out = join(root, "gen/rap");
  // No dependencies or output when there are no BDEFs; remove stale generated types.
  if (!files.some(f => f.filename.endsWith(".bdef.asbdef") || f.filename.endsWith(".srvd.srvdsrv"))) { rmSync(out, {recursive: true, force: true}); return; }
  const deps = [];
  for (const name of ["open-abap-core", "open-abap-odata"]) {
    const dir = join(libraryPath(root, name), "src");
    deps.push(...walk(dir).filter(f => /\.(tabl|view|dtel|doma)\.xml$/.test(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")})));
  }
  const {outputs, bindings, plans} = generate(files, deps);
  // the runtime adapters read the behavior pools named by the BDEFs (R2)
  const pools = new Set((plans ?? []).map(p => (p.model.implementationClass ?? "").toLowerCase()).filter(Boolean));
  const poolFiles = paths.filter(f => pools.has(basename(f).toLowerCase().split(".")[0]) && /\.clas\.(locals_imp\.|locals_def\.)?abap$/i.test(f))
    .map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
  Object.assign(outputs, runtimeOutputs(plans ?? [], poolFiles));
  mkdirSync(out, {recursive: true});
  outputs["bindings.json"] = JSON.stringify(bindings, null, 2) + "\n";
  for (const file of readdirSync(out)) if (!(file in outputs)) rmSync(join(out, file), {recursive: true, force: true});
  for (const [file, contents] of Object.entries(outputs)) writeFileSync(join(out, file), contents);
  console.log(`bdef-gen: ${Object.keys(outputs).filter(f => f.endsWith(".intf.abap")).length} type interfaces, ${Object.keys(outputs).filter(f => f.endsWith(".clas.abap")).length} runtime classes, ${Object.keys(outputs).filter(f => f.endsWith(".stg.yaml")).length} service definitions`);
}
if (runsAs("bdef-gen.mjs")) main();
