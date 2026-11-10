// R2: the typed half of the managed RAP runtime (docs/rap-runtime.md).
//
// For every behavior definition bdef-gen.mjs resolved, this writes one class
// implementing ZIF_OSD_RAP_BO -- the model the runtime reads (fields, field
// control, numbering, mapping, determinations, validations, actions) and the
// typed calls into the behavior pool's local handler -- plus
// ZCL_OSD_RAP_REGISTRY, which ZCL_OSD_RAP_RUNTIME=>FOR_BDEF finds by name.
//
// The pool is read with abaplint's own parser, never with a pattern: its
// local classes inheriting CL_ABAP_BEHAVIOR_HANDLER / _SAVER, their methods
// and the names and directions of the parameters. A handler method is bound
// to a determination, validation or action by the FOR clause of its
// declaration when it is written in the system's form (FOR DETERMINE ON ...
// FOR ent~det, FOR VALIDATE ON SAVE, FOR MODIFY ... FOR ACTION ent~act; R3,
// lower-derived.mjs), else by name (SetStatus = set_status = setstatus).
// A parameter is passed by its role (keys, entities, result, the responses),
// which the implicit form states and the explicit form names.
import * as core from "@abaplint/core";
import {implicitHandlers} from "./lower-derived.mjs";

const upper = s => s.toUpperCase();
const squash = s => s.toLowerCase().replaceAll("_", "");
const lit = s => `'${String(s).replaceAll("'", "''")}'`;
const PARAMS = new Set(["keys", "entities", "result", "failed", "reported", "mapped"]);

/** local handler and saver classes of a pool, from the parse */
export function poolClasses(name, files) {
  const pool = files.filter(f => f.filename.toLowerCase().startsWith(`${name.toLowerCase()}.clas.`));
  if (!pool.some(f => f.filename.toLowerCase() === `${name.toLowerCase()}.clas.abap`)) throw new Error(`behavior pool ${name} not found`);
  const reg = new core.Registry(new core.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {}})));
  reg.addFiles(pool.map(f => new core.MemoryFile(f.filename, f.contents)));
  reg.parse();
  const obj = reg.getFirstObject();
  // the parser gives an implicit declaration no parameters: they come from its form
  const implicit = new Map(pool.flatMap(f => implicitHandlers(f.contents, f.filename)).map(h => [`${h.cls} ${h.method}`, h]));
  const classes = [];
  for (const file of obj.getABAPFiles()) {
    for (const c of file.getInfo().listClassDefinitions()) {
      if (c.isGlobal) continue;
      const parent = (c.superClassName ?? "").toLowerCase();
      const kind = parent === "cl_abap_behavior_handler" ? "handler" : parent === "cl_abap_behavior_saver" ? "saver" : undefined;
      if (!kind) continue;
      classes.push({name: c.name.toLowerCase(), kind, methods: c.methods.map(m => {
        const h = implicit.get(`${c.name.toLowerCase()} ${m.name.toLowerCase()}`);
        if (h) return {name: m.name.toLowerCase(), implicit: h, parameters: h.params.map(p => ({name: p.name, direction: p.direction, role: p.role}))};
        return {name: m.name.toLowerCase(), parameters: m.parameters.map(p => ({name: p.name.toLowerCase(), direction: String(p.direction).toLowerCase(), role: p.name.toLowerCase()}))};
      })});
    }
  }
  return classes;
}

export function fieldControl(entity, fields) {
  const control = new Map(fields.map(f => [upper(f.name), {readonly: "", mandatory: "", numbering: false}]));
  for (const group of entity.fields) {
    for (const name of group.fields) {
      const c = control.get(upper(name));
      if (!c) throw new Error(`${entity.entity}: field control for unknown field ${name}`);
      for (const a of group.attributes) {
        // only the forms the runtime implements; another qualifier is refused
        // rather than read as its unconditional form
        if (a.name === "readonly" && (a.value === null || a.value === "update")) c.readonly = a.value === "update" ? (c.readonly || "U") : "X";
        else if (a.name === "mandatory" && (a.value === null || a.value === "create")) c.mandatory = a.value === "create" ? (c.mandatory || "C") : "X";
        else if (a.name === "numbering" && a.value === "managed") c.numbering = true;
        else if (a.name !== "features") throw new Error(`${entity.entity}: field control ${a.name}${a.value ? `:${a.value}` : ""} is outside R2`);
      }
    }
  }
  return control;
}

/** the generated sources of the runtime: one adapter per plan and the registry */
export function runtimeOutputs(plans, files) {
  const outputs = {};
  const registry = [];
  for (const plan of plans) {
    const {model, iface, root} = plan;
    if (model.implementationType !== "managed") throw new Error(`${root}: only managed behavior definitions run (R2)`);
    if (model.withDraft) throw new Error(`${root}: draft is outside R2`);
    if (!model.implementationClass) throw new Error(`${root}: no behavior pool`);
    const pool = model.implementationClass.toLowerCase();
    const classes = poolClasses(pool, files);
    const absolute = c => `\\CLASS-POOL=${upper(pool)}\\CLASS=${upper(c)}`;
    const savers = classes.filter(c => c.kind === "saver");
    if (savers.length > 1) throw new Error(`${pool}: more than one saver class`);
    const handlers = classes.filter(c => c.kind === "handler");
    const cls = iface.replace(/^zif_/, "zcl_");
    let model_ = `    rs_model-bdef = ${lit(upper(root))}.\n    rs_model-pool = ${lit(upper(pool))}.\n`;
    if (savers.length) model_ += `    rs_model-saver = ${lit(absolute(savers[0].name))}.\n`;
    let rows = "", results = "", calls = "", methods = "", defs = "", tables = "";
    for (const e of plan.entities) {
      const {entity, prefix: p} = e;
      if (entity.numbering) throw new Error(`${entity.entity}: ${entity.numbering} numbering through the pool is outside R2`);
      if (entity.options?.length && entity.options.some(o => o.name !== "unique")) {
        throw new Error(`${entity.entity}: behavior options ${entity.options.map(o => o.name).join(", ")} are outside R2`);
      }
      const table = entity.persistentTable;
      if (!table) throw new Error(`${entity.entity}: a managed entity needs a persistent table`);
      const mapping = entity.mappings.find(m => upper(m.table) === upper(table));
      const control = fieldControl(entity, e.fields);
      const response = (entity.alias ?? entity.entity).toLowerCase();
      model_ += `    CLEAR ls_entity.\n    ls_entity-name = ${lit(upper(entity.entity))}.\n    ls_entity-alias = ${lit(entity.alias ?? entity.entity)}.\n`
        + `    ls_entity-response = ${lit(upper(response))}.\n    ls_entity-table = ${lit(upper(table))}.\n`
        + `    ls_entity-source = ${lit(upper(`zcl_stg_tab_${table.toLowerCase()}`))}.\n`;
      for (const op of ["create", "update", "delete"]) if (entity.operations.some(o => o.kind === op && !o.use)) model_ += `    ls_entity-${op} = abap_true.\n`;
      for (const f of e.fields) {
        const mapped = mapping?.fields.find(m => upper(m.field) === upper(f.name))?.column;
        const column = mapped ?? (upper(e.source) === upper(table) && f.base ? f.base : f.name);
        const c = control.get(upper(f.name));
        if (c.numbering && (!f.key || !/^x LENGTH 16$/i.test(f.type))) throw new Error(`${entity.entity}.${f.name}: managed numbering needs a key of type x LENGTH 16 (a UUID)`);
        model_ += `    CLEAR ls_field.\n    ls_field-name = ${lit(upper(f.name))}.\n    ls_field-column = ${lit(upper(column))}.\n`
          + (f.key ? "    ls_field-key = abap_true.\n" : "")
          + (c.readonly ? `    ls_field-readonly = ${lit(c.readonly)}.\n` : "")
          + (c.mandatory ? `    ls_field-mandatory = ${lit(c.mandatory)}.\n` : "")
          + (c.numbering ? "    ls_field-numbering = abap_true.\n" : "")
          + "    APPEND ls_field TO ls_entity-fields.\n";
      }
      const callables = [
        ...entity.determinations.map(d => ({...d, kind: "D"})),
        ...entity.validations.map(v => ({...v, kind: "V", on: "save"})),
        ...entity.actions.map((a, index) => ({...a, kind: "A", on: "", triggers: [], index})),
      ];
      let handler;
      for (const [n, c] of callables.entries()) {
        if (c.kind === "A" && (c.use || c.modifiers.length || c.parameter || (c.result && c.result.type !== "$self"))) {
          throw new Error(`${entity.entity}~${c.name}: only instance actions without parameter and with no or a $self result run (R2)`);
        }
        // the declaration's FOR clause binds first; a method named after it, written explicitly, second
        const names = new Set([upper(entity.entity), upper(entity.alias ?? entity.entity)]);
        const form = {D: "DETERMINE", V: "VALIDATE", A: "MODIFY"}[c.kind];
        const declared = handlers.flatMap(h => h.methods.filter(m => m.implicit?.form === form
          && m.implicit.clauses.some(x => (c.kind !== "A" || x.kind === "ACTION") && names.has(upper(x.entity)) && upper(x.name ?? "") === upper(c.name))).map(m => ({h, m})));
        const found = declared.length ? declared
          : handlers.flatMap(h => h.methods.filter(m => !m.implicit && squash(m.name) === squash(c.name)).map(m => ({h, m})));
        if (found.length !== 1) throw new Error(`${entity.entity}~${c.name}: ${found.length ? "more than one" : "no"} handler method named after it in ${pool}`);
        const {h, m} = found[0];
        if (handler && handler !== h.name) throw new Error(`${entity.entity}: handler methods in two classes (${handler}, ${h.name})`);
        handler = h.name;
        const unknown = m.parameters.filter(x => !PARAMS.has(x.role));
        if (unknown.length || !m.parameters.some(x => x.role === "keys")) {
          throw new Error(`${h.name}->${m.name}: parameters must be keys and any of entities, result, failed, reported, mapped (got ${m.parameters.map(x => x.name).join(", ")})`);
        }
        if (m.implicit) {
          if (m.implicit.clauses.length !== 1) throw new Error(`${h.name}->${m.name}: one handler method per determination, validation or action (R3)`);
          if (c.kind === "D" && m.implicit.on !== (c.on === "modify" ? "MODIFY" : "SAVE")) throw new Error(`${h.name}->${m.name}: FOR DETERMINE ON ${m.implicit.on} for a determination on ${c.on}`);
        }
        const trig = c.triggers ?? [];
        if (trig.some(t => t.kind === "delete")) throw new Error(`${entity.entity}~${c.name}: a delete trigger is outside R2`);
        model_ += `    CLEAR ls_callable.\n    ls_callable-kind = '${c.kind}'.\n    ls_callable-name = ${lit(upper(c.name))}.\n`
          + `    ls_callable-method = ${lit(upper(m.name))}.\n`
          + (m.parameters.some(x => x.role === "entities") ? "    ls_callable-entities = abap_true.\n" : "")
          + (c.on ? `    ls_callable-on = '${c.on === "modify" ? "M" : "S"}'.\n` : "")
          + (trig.some(t => t.kind === "create") ? "    ls_callable-on_create = abap_true.\n" : "")
          + (trig.some(t => t.kind === "update") ? "    ls_callable-on_update = abap_true.\n" : "")
          + trig.filter(t => t.kind === "field").flatMap(t => t.fields).map(f => {
            if (!control.has(upper(f))) throw new Error(`${entity.entity}~${c.name}: trigger on unknown field ${f}`);
            return `    APPEND ${lit(upper(f))} TO ls_callable-fields.\n`;
          }).join("")
          + "    APPEND ls_callable TO ls_entity-callables.\n";
        // the typed call: keys built from the rows, or the caller's import table for an action
        const method = `${p}_c${n}`;
        defs += `    METHODS ${method}\n      IMPORTING\n        io_handler  TYPE REF TO object\n        ir_rows     TYPE REF TO data\n        ir_keys     TYPE REF TO data\n        ir_result   TYPE REF TO data\n        ir_failed   TYPE REF TO data\n        ir_reported TYPE REF TO data.\n`;
        calls += `      WHEN ${lit(`${upper(entity.entity)}~${upper(c.name)}`)}.\n        ${method}( io_handler = io_handler ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result ir_failed = ir_failed ir_reported = ir_reported ).\n`;
        const keyType = c.kind === "A" ? `${iface}=>t_${p}_a${c.index}_import` : `${iface}=>t_${p}_${c.kind === "D" ? "determination" : "validation"}`;
        let body = `    DATA lt_keys TYPE ${keyType}.\n    DATA ls_key LIKE LINE OF lt_keys.\n`
          + `    FIELD-SYMBOLS <lt_rows> TYPE ${iface}=>t_${p}_read_result.\n    FIELD-SYMBOLS <ls_row> LIKE LINE OF <lt_rows>.\n`
          + `    FIELD-SYMBOLS <ls_failed> TYPE ${iface}=>r_failed.\n    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.\n`
          + (m.parameters.some(x => x.role === "mapped") ? `    DATA ls_mapped TYPE ${iface}=>r_mapped.\n` : "");
        if (c.kind === "A") body += `    FIELD-SYMBOLS <lt_keys> TYPE ${keyType}.\n`;
        if (c.kind === "A" && c.result) body += `    FIELD-SYMBOLS <lt_result> TYPE ${iface}=>t_${p}_a${c.index}_result.\n`;
        body += "\n    ASSIGN ir_rows->* TO <lt_rows>.\n    ASSIGN ir_failed->* TO <ls_failed>.\n    ASSIGN ir_reported->* TO <ls_reported>.\n";
        if (c.kind === "A") {
          body += "    ASSIGN ir_keys->* TO <lt_keys>.\n    lt_keys = <lt_keys>.\n";
          if (c.result) body += "    ASSIGN ir_result->* TO <lt_result>.\n";
        } else {
          body += "    LOOP AT <lt_rows> ASSIGNING <ls_row>.\n      CLEAR ls_key.\n"
            + e.fields.filter(f => f.key).map(f => `      ls_key-${f.name} = <ls_row>-${f.name}.\n`).join("")
            + "      APPEND ls_key TO lt_keys.\n    ENDLOOP.\n";
        }
        const actual = {keys: "lt_keys", entities: "<lt_rows>", failed: "<ls_failed>", reported: "<ls_reported>", result: "<lt_result>", mapped: "ls_mapped"};
        if (m.parameters.some(x => x.role === "result") && !(c.kind === "A" && c.result)) throw new Error(`${h.name}->${m.name}: a result parameter without a result`);
        const groups = {importing: [], changing: [], exporting: []};
        for (const x of m.parameters) {
          // the caller's side of each direction
          const side = x.direction === "importing" ? "exporting" : x.direction === "exporting" ? "importing" : x.direction === "changing" ? "changing" : undefined;
          if (!side) throw new Error(`${h.name}->${m.name}: ${x.direction} parameter ${x.name}`);
          groups[side === "exporting" ? "exporting" : side === "importing" ? "importing" : "changing"].push(`${x.name} = ${actual[x.role]}`);
        }
        body += `    CALL METHOD io_handler->(${lit(upper(m.name))})`
          + (groups.exporting.length ? `\n      EXPORTING\n        ${groups.exporting.join("\n        ")}` : "")
          + (groups.importing.length ? `\n      IMPORTING\n        ${groups.importing.join("\n        ")}` : "")
          + (groups.changing.length ? `\n      CHANGING\n        ${groups.changing.join("\n        ")}` : "") + ".\n";
        methods += `  METHOD ${method}.\n* ${c.kind === "D" ? "determination" : c.kind === "V" ? "validation" : "action"} ${c.name}: ${h.name}->${m.name}\n${body}  ENDMETHOD.\n\n`;
      }
      if (handler) model_ += `    ls_entity-handler = ${lit(absolute(handler))}.\n`;
      model_ += "    APPEND ls_entity TO rs_model-entities.\n";
      rows += `      WHEN ${lit(upper(entity.entity))}.\n        CREATE DATA rr_rows TYPE ${iface}=>t_${p}_read_result.\n`;
      for (const c of callables) {
        // by the CDS name or the alias, as the runtime names an entity
        const names = [...new Set([upper(entity.entity), upper(entity.alias ?? entity.entity)])].map(e => lit(`${e}~${upper(c.name)}`)).join(" OR ");
        if (c.kind === "A" && c.result) results += `      WHEN ${names}.\n        CREATE DATA rr_result TYPE ${iface}=>t_${p}_a${c.index}_result.\n`;
      }
      // the derived tables a caller that knows only the model fills (R2c)
      for (const op of ["create", "update", "delete"]) {
        if (entity.operations.some(o => o.kind === op && !o.use)) tables += `      WHEN ${lit(`${upper(entity.entity)}~${upper(op)}~`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${p}_${op}.\n`;
      }
      for (const [a, action] of entity.actions.entries()) {
        tables += `      WHEN ${lit(`${upper(entity.entity)}~ACTION IMPORT~${upper(action.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${p}_a${a}_import.\n`;
        if (action.result) tables += `      WHEN ${lit(`${upper(entity.entity)}~ACTION RESULT~${upper(action.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${p}_a${a}_result.\n`;
      }
    }
    const source = `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/rap/rap-runtime-gen.mjs from ${upper(root)} - do not edit
* (docs/rap-runtime.md): the typed half of the managed RAP runtime
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
  PRIVATE SECTION.
${defs}ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD zif_osd_rap_bo~model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.

${model_}  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_rows.
    CASE to_upper( iv_entity ).
${rows}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_result.
    CASE to_upper( iv_entity && '~' && iv_action ).
${results}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_table.
    DATA lv_name TYPE string.
    lv_name = to_upper( iv_entity && '~' && iv_kind && '~' && iv_action ).
    CASE lv_name.
${tables}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_response.
    CASE to_upper( iv_kind ).
      WHEN 'MAPPED'.
        CREATE DATA rr_response TYPE ${iface}=>r_mapped.
      WHEN 'FAILED'.
        CREATE DATA rr_response TYPE ${iface}=>r_failed.
      WHEN 'REPORTED'.
        CREATE DATA rr_response TYPE ${iface}=>r_reported.
    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~call.
    DATA lv_name TYPE string.
    lv_name = to_upper( iv_entity && '~' && iv_name ).
    CASE lv_name.
${calls}    ENDCASE.
  ENDMETHOD.

${methods}ENDCLASS.
`;
    outputs[`${cls}.clas.abap`] = source.replace(/\n{3,}/g, "\n\n");
    registry.push({bdef: upper(root), cls});
  }
  if (!registry.length) return outputs;
  registry.sort((a, b) => a.bdef.localeCompare(b.bdef));
  outputs["zcl_osd_rap_registry.clas.abap"] = `CLASS zcl_osd_rap_registry DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/rap/rap-runtime-gen.mjs - do not edit
* the behavior definitions of the tree and their runtime adapters
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_registry.
ENDCLASS.

CLASS zcl_osd_rap_registry IMPLEMENTATION.

  METHOD zif_osd_rap_registry~get.
    CASE to_upper( iv_bdef ).
${registry.map(r => `      WHEN ${lit(r.bdef)}.\n        CREATE OBJECT ro_bo TYPE ${r.cls}.\n`).join("")}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_registry~list.
${registry.map(r => `    APPEND ${lit(r.bdef)} TO rt_bdef.\n`).join("")}  ENDMETHOD.

ENDCLASS.
`;
  return outputs;
}
