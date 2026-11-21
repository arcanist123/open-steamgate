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
import {classNameOf} from "../cds-names.mjs";

/** R7: the behavior pools a BDEF names, the header's first, lower case */
const poolsOfModel = model => [...new Set([model.implementationClass, ...model.entities.map(e => e.implementationClass)].filter(Boolean).map(p => p.toLowerCase()))];

/** R7: the save of an entity: its own `with ... save`, else the header's */
export function saveOf(model, entity) {
  const own = (entity.options ?? []).find(o => /^(additional|unmanaged) save$/.test(o.kind));
  return own ?? (model.options ?? []).find(o => /^(additional|unmanaged) save$/.test(o.kind));
}

const upper = s => s.toUpperCase();
const squash = s => s.toLowerCase().replaceAll("_", "");
const lit = s => `'${String(s).replaceAll("'", "''")}'`;
const PARAMS = new Set(["keys", "entities", "result", "failed", "reported", "mapped"]);
const featured = opts => (opts ?? []).some(o => o.name === "features" && o.value === "instance");

// the CALL METHOD of a handler method, each parameter by its role
function callMethod(h, m, actual) {
  const groups = {importing: [], changing: [], exporting: []};
  for (const x of m.parameters) {
    if (!(x.role in actual)) throw new Error(`${h.name}->${m.name}: unexpected parameter ${x.name}`);
    const side = x.direction === "importing" ? "exporting" : x.direction === "exporting" ? "importing" : x.direction === "changing" ? "changing" : undefined;
    if (!side) throw new Error(`${h.name}->${m.name}: ${x.direction} parameter ${x.name}`);
    groups[side].push(`${x.name} = ${actual[x.role]}`);
  }
  return `    CALL METHOD io_handler->(${lit(upper(m.name))})`
    + (groups.exporting.length ? `\n      EXPORTING\n        ${groups.exporting.join("\n        ")}` : "")
    + (groups.importing.length ? `\n      IMPORTING\n        ${groups.importing.join("\n        ")}` : "")
    + (groups.changing.length ? `\n      CHANGING\n        ${groups.changing.join("\n        ")}` : "") + ".\n";
}

/** local handler and saver classes of a pool, from the parse */
export function poolClasses(name, files) {
  // abapGit writes the namespace of /DMO/BP_X as # (#dmo#bp_x.clas.abap)
  const file = name.toLowerCase().replaceAll("/", "#");
  const pool = files.filter(f => f.filename.toLowerCase().startsWith(`${file}.clas.`));
  if (!pool.some(f => f.filename.toLowerCase() === `${file}.clas.abap`)) throw new Error(`behavior pool ${name} not found`);
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

// the runtime's name of a field: the CDS element upper case
function fieldName(e, name) {
  const f = e.fields.find(x => upper(x.name) === upper(name));
  if (!f) throw new Error(`${e.entity.entity}: association pair names ${name}, no element of the entity`);
  return upper(f.name);
}

// R5: one projection entity as the registry answers it
function projectionEntry(plan, e) {
  const {entity, base} = e;
  const used = op => entity.operations.some(o => o.kind === op);
  return {
    entity: upper(entity.entity), alias: entity.alias ?? entity.entity, bdef: upper(plan.root),
    baseBdef: upper(plan.base.root), baseEntity: upper(base.entity.entity),
    create: used("create"), update: used("update"), delete: used("delete"),
    actions: entity.actions.map(a => upper(a.name)),
    assocs: e.tree.assocs.map(a => ({name: upper(a.name), create: a.create,
      target: plan.entities.find(x => upper(x.entity.entity) === a.target)})),
    fields: e.fields.filter(f => f.from).map(f => ({name: upper(f.name), base: upper(f.from)})),
    // R10: a calculated element is read-only unless field ( modify ) says
    // the augment writes it; MODIFY lists those
    readonly: [...entity.fields.filter(g => g.attributes.some(a => a.name === "readonly")).flatMap(g => g.fields).map(upper),
      ...e.fields.filter(f => !f.from && !modifyOf(entity).has(upper(f.name))).map(f => upper(f.name))],
    modify: e.fields.filter(f => !f.from && modifyOf(entity).has(upper(f.name))).map(f => upper(f.name)),
    augment: e.augment ?? [],
  };
}

/** R10: the elements a projection marks field ( modify ) */
function modifyOf(entity) {
  return new Set(entity.fields.filter(g => g.attributes.some(a => a.name === "modify")).flatMap(g => g.fields).map(upper));
}

function projectionCase(x) {
  return `      WHEN ${lit(x.entity)}.
        rs_projection-entity = ${lit(x.entity)}.
        rs_projection-alias = ${lit(x.alias)}.
        rs_projection-bdef = ${lit(x.bdef)}.
        rs_projection-base_bdef = ${lit(x.baseBdef)}.
        rs_projection-base_entity = ${lit(x.baseEntity)}.
${["create", "update", "delete"].filter(op => x[op]).map(op => `        rs_projection-${op} = abap_true.\n`).join("")}`
    + x.actions.map(a => `        APPEND ${lit(a)} TO rs_projection-actions.\n`).join("")
    + x.assocs.map(a => `        APPEND ${lit(a.name)} TO rs_projection-assocs.\n`
      + (a.create ? `        APPEND ${lit(a.name)} TO rs_projection-creates.\n` : "")).join("")
    + x.fields.map(f => `        ls_map-name = ${lit(f.name)}.\n        ls_map-base = ${lit(f.base)}.\n        APPEND ls_map TO rs_projection-fields.\n`).join("")
    + x.readonly.map(f => `        APPEND ${lit(f)} TO rs_projection-readonly.\n`).join("")
    + (x.modify ?? []).map(f => `        APPEND ${lit(f)} TO rs_projection-modify.\n`).join("")
    + (x.union ? `        rs_projection-union = ${lit(upper(x.union))}.\n` : "")
    + (x.augmentClass ? `        rs_projection-augment = ${lit(upper(x.augmentClass))}.\n` : "");
}

// R8: the served rows of a draft-enabled entity: the CDS view's rows (the
// active instances) and the draft table's (the drafts), each with the draft
// flags, read by the SADL data provider in place of the view
// (zif_stg_cds_draft_source; the union itself is ZCL_OSD_RAP_DRAFT=>UNION)
function draftUnion(name, e, entity, bdef) {
  const view = upper(e.view.sqlView ?? entity.entity);
  const draft = upper(entity.draftTable);
  // R11: a view with a constant element, or the singleton root (no SQL
  // view), is read through its source class, which decides a condition on
  // a constant and fills the constants (tools/cds-computed.mjs)
  const source = e.view.computed || (e.view.fields ?? []).some(f => f.constant !== undefined)
    ? classNameOf("zcl_stg_cds_", e.view.sqlView ?? entity.entity).toLowerCase() : undefined;
  // R10: a projection's calculated elements (its path elements) are
  // components of the row too; its path class fills them after the read
  const virtual = source ? "" : e.fields.filter(f => f.virtual).map(f => `           ${f.name} TYPE ${f.type},\n`).join("");
  const keys = e.fields.filter(f => f.key).map(f => `    APPEND ${lit(upper(f.name))} TO lt_keys.\n`).join("");
  return `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/rap/rap-runtime-gen.mjs from ${bdef} - do not edit
* (docs/rap-runtime.md, R8): ${upper(entity.entity)} as a draft-enabled
* entity serves it, the active instances of ${view} and the drafts of
* ${draft}, each row with IsActiveEntity, HasActiveEntity, HasDraftEntity
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_row.
        INCLUDE TYPE ${source ? `${source}=>ty_row` : view.toLowerCase()}.
    TYPES: ${virtual.trimStart()}isactiveentity  TYPE c LENGTH 1,
           hasactiveentity TYPE c LENGTH 1,
           hasdraftentity  TYPE c LENGTH 1,
           draftuuid       TYPE x LENGTH 16,
           siblingentity   TYPE c LENGTH 1,
           draftadmin      TYPE c LENGTH 1,
           inprocessbyuser TYPE c LENGTH 12,
           END OF ty_row.
    TYPES tt_row TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    INTERFACES zif_stg_cds_source.
    INTERFACES zif_stg_cds_draft_source.
ENDCLASS.

CLASS ${name} IMPLEMENTATION.

  METHOD zif_stg_cds_source~read.
    rr_data = zif_stg_cds_draft_source~read_versions( iv_where = iv_where it_orderby = it_orderby ).
  ENDMETHOD.

  METHOD zif_stg_cds_draft_source~read_versions.
    DATA lt_active TYPE ${source ? `${source}=>tt_row` : `STANDARD TABLE OF ${view.toLowerCase()} WITH DEFAULT KEY`}.
    DATA lt_draft  TYPE STANDARD TABLE OF ${draft.toLowerCase()} WITH DEFAULT KEY.
    DATA lt_known  TYPE STANDARD TABLE OF ${draft.toLowerCase()} WITH DEFAULT KEY.
    DATA lr_known  TYPE REF TO data.
    DATA lt_keys   TYPE string_table.
    DATA lr_active TYPE REF TO data.
    DATA lr_draft  TYPE REF TO data.
    DATA lv_where  TYPE string.
${source ? `    DATA li_view   TYPE REF TO zif_stg_cds_source.
    DATA lt_none   TYPE string_table.
    DATA lr_view   TYPE REF TO data.
    FIELD-SYMBOLS <lt_view> TYPE STANDARD TABLE.
` : ""}
* the condition names CDS elements, which are the columns of both
    lv_where = iv_where.
${source ? `    CREATE OBJECT li_view TYPE ${source}.
    lr_view = li_view->read( iv_where = lv_where it_orderby = lt_none ).
    ASSIGN lr_view->* TO <lt_view>.
    lt_active = <lt_view>.
` : `    SELECT * FROM ${view.toLowerCase()} INTO TABLE lt_active WHERE (lv_where).
`}    SELECT * FROM ${draft.toLowerCase()} INTO TABLE lt_draft WHERE (lv_where).
* HasDraftEntity of an active row does not depend on whether its draft
* matches the condition: every draft is asked (its key), not the matching ones
    SELECT ${e.fields.filter(f => f.key).map(f => f.name.toLowerCase()).join(" ")} draftadministrativedatauuid
      FROM ${draft.toLowerCase()} INTO CORRESPONDING FIELDS OF TABLE lt_known.
${keys}    CREATE DATA rr_data TYPE tt_row.
    GET REFERENCE OF lt_active INTO lr_active.
    GET REFERENCE OF lt_draft INTO lr_draft.
    GET REFERENCE OF lt_known INTO lr_known.
    zcl_osd_rap_draft=>union( ir_active  = lr_active
                              ir_draft   = lr_draft
                              ir_known   = lr_known
                              it_keys    = lt_keys
                              it_orderby = it_orderby
                              it_flags   = it_flags
                              iv_latest  = iv_latest
                              ir_rows    = rr_data ).
  ENDMETHOD.

  METHOD zif_stg_cds_source~create_line.
    CREATE DATA rr_line TYPE ty_row.
  ENDMETHOD.

  METHOD zif_stg_cds_source~insert.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
      EXPORTING
        textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
        method = 'INSERT through ${upper(entity.entity)}: its behavior writes it'.
  ENDMETHOD.

  METHOD zif_stg_cds_source~update.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
      EXPORTING
        textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
        method = 'UPDATE through ${upper(entity.entity)}: its behavior writes it'.
  ENDMETHOD.

  METHOD zif_stg_cds_source~delete.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
      EXPORTING
        textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
        method = 'DELETE through ${upper(entity.entity)}: its behavior writes it'.
  ENDMETHOD.

ENDCLASS.
`;
}

// R10 (docs/rap-runtime.md, R10): the augment of a projection -- `use create
// ( augment )` / `use update ( augment )` -- is a FOR MODIFY method of the
// projection's pool typed by the projection's derived types. The runtime
// gives it the request rows (ZCL_OSD_RAP_RUNTIME=>AUGMENT) while the base's
// transaction is active, so its MODIFY AUGMENTING ENTITIES reaches the base
function augmentClass(cls, plan, entities, files) {
  const {iface, model} = plan;
  let tables = "", cases = "";
  for (const e of entities) {
    const {entity, prefix: p} = e;
    const pool = (entity.implementationClass ?? model.implementationClass).toLowerCase();
    const names = new Set([upper(entity.entity), upper(entity.alias ?? entity.entity)]);
    const found = poolClasses(pool, files).filter(c => c.kind === "handler").flatMap(h => h.methods
      .filter(m => m.implicit?.form === "MODIFY" && m.implicit.clauses.some(x => ["CREATE", "UPDATE"].includes(x.kind) && names.has(upper(x.entity))))
      .map(m => ({h, m})));
    if (found.length !== 1) throw new Error(`${entity.entity}: augment needs one FOR MODIFY method for its create / update in ${upper(pool)} (found ${found.length})`);
    const {h, m} = found[0];
    for (const kind of ["create", "update"]) {
      if (entity.operations.some(o => o.kind === kind)) tables += `      WHEN ${lit(`${upper(entity.entity)}~${upper(kind)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${p}_${kind}.\n`;
    }
    const actual = {mapped: "ls_mapped", failed: "ls_failed", reported: "ls_reported"};
    for (const x of m.implicit.clauses) {
      if (!["CREATE", "UPDATE"].includes(x.kind) || !names.has(upper(x.entity))) throw new Error(`${h.name}->${m.name}: an augment takes the create and update of ${entity.entity} only`);
    }
    const params = m.parameters.map(x => {
      const c = x.role === "entities" ? m.implicit.clauses.find(k => k.param.toLowerCase() === x.name) : undefined;
      return {...x, actual: c ? `lt_${c.kind.toLowerCase()}` : actual[x.role]};
    });
    const group = d => params.filter(x => x.direction === d).map(x => `${x.name} = ${x.actual}`);
    cases += `      WHEN ${lit(upper(entity.entity))}.
        IF ir_create IS BOUND.
          ASSIGN ir_create->* TO <lt_c${p}>.
          lt_create_${p} = <lt_c${p}>.
        ENDIF.
        IF ir_update IS BOUND.
          ASSIGN ir_update->* TO <lt_u${p}>.
          lt_update_${p} = <lt_u${p}>.
        ENDIF.
        lv_name = ${lit(`\\CLASS-POOL=${upper(pool)}\\CLASS=${upper(h.name)}`)}.
        CREATE OBJECT lo_handler TYPE (lv_name).
        CALL METHOD lo_handler->(${lit(upper(m.name))})
          EXPORTING
            ${group("importing").map(g => g.replace(/= lt_(create|update)$/, `= lt_$1_${p}`)).join("\n            ")}
          CHANGING
            ${group("changing").map(g => g.replace(/= (ls_\w+)$/, `= $1_${p}`)).join("\n            ")}.
        ev_failed = lines( ls_failed_${p}-${(entity.alias ?? entity.entity).toLowerCase()} ).
        LOOP AT ls_reported_${p}-${(entity.alias ?? entity.entity).toLowerCase()} INTO ls_rep_${p}.
          IF ls_rep_${p}-%msg IS BOUND.
            TRY.
                lo_msg ?= ls_rep_${p}-%msg.
                APPEND lo_msg->get_text( ) TO et_messages.
              CATCH cx_sy_move_cast_error.
                CONTINUE.
            ENDTRY.
          ENDIF.
        ENDLOOP.
`;
  }
  const decl = entities.map(({prefix: p, entity}) => {
    const has = kind => entity.operations.some(o => o.kind === kind);
    return `    DATA lt_create_${p} TYPE ${has("create") ? `${iface}=>t_${p}_create` : "STANDARD TABLE OF i WITH DEFAULT KEY"}.
    DATA lt_update_${p} TYPE ${has("update") ? `${iface}=>t_${p}_update` : "STANDARD TABLE OF i WITH DEFAULT KEY"}.
    DATA ls_mapped_${p} TYPE ${iface}=>r_mapped.
    DATA ls_failed_${p} TYPE ${iface}=>r_failed.
    DATA ls_reported_${p} TYPE ${iface}=>r_reported.
    DATA ls_rep_${p} LIKE LINE OF ls_reported_${p}-${(entity.alias ?? entity.entity).toLowerCase()}.
    FIELD-SYMBOLS <lt_c${p}> LIKE lt_create_${p}.
    FIELD-SYMBOLS <lt_u${p}> LIKE lt_update_${p}.
`;
  }).join("");
  return `CLASS ${cls} DEFINITION PUBLIC FINAL CREATE PUBLIC.
* generated by tools/rap/rap-runtime-gen.mjs from ${upper(plan.root)} - do not edit
* (docs/rap-runtime.md, R10): the augment of the projection, typed
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_augment.
ENDCLASS.

CLASS ${cls} IMPLEMENTATION.

  METHOD zif_osd_rap_augment~new_table.
    CASE to_upper( iv_entity && '~' && iv_kind ).
${tables}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_augment~augment.
    DATA lo_handler TYPE REF TO object.
    DATA lo_msg TYPE REF TO if_message.
    DATA lv_name TYPE string.
${decl}
    CASE to_upper( iv_entity ).
${cases}    ENDCASE.
  ENDMETHOD.

ENDCLASS.
`;
}

/** the generated sources of the runtime: one adapter per plan and the registry */
export function runtimeOutputs(plans, files) {
  const outputs = {};
  const registry = [];
  const projections = [];
  for (const plan of plans) {
    const {model, iface, root} = plan;
    // R5: a projection runs on its base: no adapter, a registry entry
    if (plan.projection) {
      const augments = [];
      for (const [index, e] of plan.entities.entries()) {
        const entry = projectionEntry(plan, e);
        // R10: use draft -- the projection entity serves the active rows of
        // its view and the drafts of its base's draft table, a union of its own
        if (model.withDraft) {
          if (e.draftRefusal) throw new Error(e.draftRefusal);
          if (e.base.draftRefusal) throw new Error(e.base.draftRefusal);
          entry.union = `${iface.replace(/^zif_/, "zcl_")}_d${index}`;
          outputs[`${entry.union}.clas.abap`] = draftUnion(entry.union, e, {...e.entity, draftTable: e.base.entity.draftTable}, upper(root));
        }
        if ((e.augment ?? []).length) augments.push(e);
        projections.push(entry);
      }
      // R10: the projection's augment, typed by the projection's derived types
      if (augments.length) {
        const cls = iface.replace(/^zif_/, "zcl_");
        outputs[`${cls}.clas.abap`] = augmentClass(cls, plan, augments, files);
        for (const e of augments) projections.find(x => x.entity === upper(e.entity.entity)).augmentClass = cls;
      }
      continue;
    }
    if (model.implementationType !== "managed") throw new Error(`${root}: only managed behavior definitions run (R2)`);
    if (!model.implementationClass) throw new Error(`${root}: no behavior pool`);
    // R7: every pool the BDEF names; each entity's handlers are in its own
    const header = model.implementationClass.toLowerCase();
    const classesOf = new Map(poolsOfModel(model).map(p => [p, poolClasses(p, files)]));
    const absoluteIn = (pool, c) => `\\CLASS-POOL=${upper(pool)}\\CLASS=${upper(c)}`;
    const cls = iface.replace(/^zif_/, "zcl_");
    let model_ = `    rs_model-bdef = ${lit(upper(root))}.\n    rs_model-pool = ${lit(upper(header))}.\n`
      + (model.withDraft ? "    rs_model-draft = abap_true.\n" : "");
    const savers = [];
    for (const [p, classes] of classesOf) {
      const found = classes.filter(c => c.kind === "saver");
      if (found.length > 1) throw new Error(`${p}: more than one saver class`);
      for (const c of found) savers.push({name: absoluteIn(p, c.name), modified: c.methods.some(m => m.name === "save_modified"),
        adjust: c.methods.some(m => m.name === "adjust_numbers")});
    }
    if (savers.length) model_ += `    rs_model-saver = ${lit(savers[0].name)}.\n`;
    for (const sv of savers) model_ += `    CLEAR ls_saver.\n    ls_saver-name = ${lit(sv.name)}.\n` + (sv.modified ? "    ls_saver-modified = abap_true.\n" : "")
      + (sv.adjust ? "    ls_saver-adjust = abap_true.\n" : "") + "    APPEND ls_saver TO rs_model-savers.\n";
    const late = plan.entities.some(e => e.entity.numbering === "late");
    let rows = "", results = "", calls = "", methods = "", defs = "", tables = "";
    for (const e of plan.entities) {
      const {entity, prefix: p} = e;
      // R8: the draft contract bdef-gen.mjs checked (draft table, actions)
      if (e.draftRefusal) throw new Error(e.draftRefusal);
      const pool = (entity.implementationClass ?? model.implementationClass).toLowerCase();
      const handlers = classesOf.get(pool).filter(c => c.kind === "handler");
      const absolute = c => absoluteIn(pool, c);
      // R10: late numbering -- the saver's adjust_numbers draws the final key
      // in the save; a late-numbered entity with children would need their
      // foreign keys moved with it, which no flight BO has
      if (entity.numbering === "late") {
        if (!savers.some(sv => sv.adjust)) throw new Error(`${entity.entity}: late numbering needs a saver redefining adjust_numbers in a pool of ${upper(root)}`);
        if ((e.tree?.assocs ?? []).some(a => a.kind === "C")) throw new Error(`${entity.entity}: late numbering of an entity with composition children is outside R10`);
        if (e.tree?.parent) throw new Error(`${entity.entity}: late numbering of a child is outside R10`);
      }
      if (entity.numbering && !["early", "late"].includes(entity.numbering)) throw new Error(`${entity.entity}: ${entity.numbering} numbering is outside R10`);
      // R10: extensible (the BO is open to extensions) changes nothing here
      const other = (entity.options ?? []).filter(o => o.name !== "unique" && o.kind !== "extensible" && !/^(additional|unmanaged) save$/.test(o.kind ?? ""));
      if (other.length) throw new Error(`${entity.entity}: behavior options ${other.map(o => o.name ?? o.kind).join(", ")} are outside R7`);
      // R7: with additional save writes and then calls save_modified, with
      // unmanaged save only calls it; it reads saved instances from its mapping table
      const save = saveOf(model, entity);
      if (save && !savers.some(sv => sv.modified)) throw new Error(`${entity.entity}: with ${save.kind} needs a saver with save_modified in a pool of ${upper(root)}`);
      const unmanaged = save?.kind === "unmanaged save";
      if (unmanaged && entity.persistentTable) throw new Error(`${entity.entity}: with unmanaged save and a persistent table`);
      // R11: an unmanaged save without a mapping table reads its saved
      // instances through its CDS view (the carrier singleton's root, a view
      // computed from a join: docs/rap-runtime.md, "The singleton root")
      const viaView = unmanaged && !entity.mappings.length;
      const table = viaView ? "" : unmanaged ? entity.mappings[0].table : entity.persistentTable;
      if (!table && !viaView) throw new Error(`${entity.entity}: a managed entity needs a persistent table`);
      const mapping = entity.mappings.find(m => upper(m.table) === upper(table));
      const control = fieldControl(entity, e.fields);
      const response = (entity.alias ?? entity.entity).toLowerCase();
      model_ += `    CLEAR ls_entity.\n    ls_entity-name = ${lit(upper(entity.entity))}.\n    ls_entity-alias = ${lit(entity.alias ?? entity.entity)}.\n`
        + `    ls_entity-response = ${lit(upper(response))}.\n    ls_entity-table = ${lit(upper(table))}.\n`
        + `    ls_entity-source = ${lit(upper(viaView ? classNameOf("zcl_stg_cds_", e.view.sqlView ?? entity.entity) : classNameOf("zcl_stg_tab_", table)))}.\n`
        + `    ls_entity-pool = ${lit(upper(pool))}.\n`
        + (save ? `    ls_entity-save = '${unmanaged ? "U" : "A"}'.\n` : "")
        + (save?.fullData ? "    ls_entity-full_data = abap_true.\n" : "")
        // R8: the draft table (its columns are the CDS elements) and its
        // table class, the root's total ETag
        + (model.withDraft ? `    ls_entity-draft_table = ${lit(upper(entity.draftTable))}.\n    ls_entity-draft_source = ${lit(upper(classNameOf("zcl_stg_tab_", entity.draftTable)))}.\n`
          + `    ls_entity-draft_view = ${lit(upper(classNameOf("zcl_stg_cds_", e.view.sqlView ?? entity.entity)))}.\n` : "")
        + (entity.totalEtag ? `    ls_entity-total_etag = ${lit(upper(e.fields.find(f => upper(f.name) === upper(entity.totalEtag)).name))}.\n` : "");
      for (const op of ["create", "update", "delete"]) if (entity.operations.some(o => o.kind === op && !o.use)) model_ += `    ls_entity-${op} = abap_true.\n`;
      // R4: the ETag field, and which operations ask the pool's features
      if (entity.etag?.kind === "master") {
        const field = e.fields.find(f => upper(f.name) === upper(entity.etag.field));
        if (!field) throw new Error(`${entity.entity}: etag master ${entity.etag.field} is no element of the entity`);
        model_ += `    ls_entity-etag = ${lit(upper(field.name))}.\n`;
      }
      for (const op of ["update", "delete"]) if (entity.operations.some(o => o.kind === op && !o.use && featured(o.options))) model_ += `    ls_entity-feat_${op} = abap_true.\n`;
      if (entity.operations.some(o => o.kind === "create" && featured(o.options))) throw new Error(`${entity.entity}: create ( features : instance ) has no instance to ask (global features are outside R4)`);
      if (entity.numbering === "early") model_ += "    ls_entity-numbering = 'E'.\n";
      if (entity.numbering === "late") model_ += "    ls_entity-numbering = 'L'.\n";
      // R5: the entity's place in the tree, and its associations
      const tree = e.tree ?? {assocs: []};
      let top = e;
      const chain = [];
      for (let depth = 0; top.tree?.parent; depth++) {
        if (depth > 16) throw new Error(`${entity.entity}: the parent chain does not end`);
        top = plan.entities.find(x => upper(x.entity.entity) === top.tree.parent);
        chain.push(upper(top.entity.entity));
      }
      // R6: a dependency by an association other than the parent's names an
      // ancestor; a lock's is the lock master (the root, which is locked)
      for (const d of tree.ancestors ?? []) {
        if (!chain.includes(d.target)) throw new Error(`${entity.entity}: ${d.clause} dependent by ${d.assoc}, whose target ${d.target} is no ancestor`);
        if (d.clause === "lock" && d.target !== upper(top.entity.entity)) throw new Error(`${entity.entity}: lock dependent by ${d.assoc}, whose target ${d.target} is not the lock master ${upper(top.entity.entity)}`);
      }
      model_ += `    ls_entity-root = ${lit(upper(top.entity.entity))}.\n`;
      if (tree.parent) model_ += `    ls_entity-parent = ${lit(tree.parent)}.\n    ls_entity-parent_assoc = ${lit(upper(tree.parentAssoc))}.\n`;
      if (entity.lock?.kind) model_ += `    ls_entity-lock = '${entity.lock.kind === "master" ? "M" : "D"}'.\n`;
      const createdBy = plan.entities.filter(x => (x.tree?.assocs ?? []).some(a => a.create && a.target === upper(entity.entity)));
      if (entity.numbering === "early" && !entity.operations.some(o => o.kind === "create" && !o.use) && !createdBy.length) throw new Error(`${entity.entity}: early numbering without create`);
      for (const a of tree.assocs) {
        const target = plan.entities.find(x => upper(x.entity.entity) === a.target);
        model_ += `    CLEAR ls_assoc.\n    ls_assoc-name = ${lit(upper(a.name))}.\n    ls_assoc-target = ${lit(a.target)}.\n    ls_assoc-kind = '${a.kind}'.\n`
          + (a.create ? "    ls_assoc-create = abap_true.\n" : "")
          + (a.featCreate ? "    ls_assoc-feat_create = abap_true.\n" : "")
          + (a.create && target.entity.numbering === "early" ? "    ls_assoc-numbering = 'E'.\n" : "")
          + a.pairs.map(pr => `    CLEAR ls_pair.\n    ls_pair-source = ${lit(fieldName(e, pr.source))}.\n    ls_pair-target = ${lit(fieldName(target, pr.target))}.\n    APPEND ls_pair TO ls_assoc-pairs.\n`).join("")
          + "    APPEND ls_assoc TO ls_entity-assocs.\n";
      }
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
          + (f.admin ? `    ls_field-admin = ${lit(f.admin)}.\n` : "")
          // R11: a literal of the view, no column (docs/rap-runtime.md, "Constant elements")
          + (f.constant !== undefined ? `    ls_field-constant = ${lit(f.constant)}.\n` : "")
          + "    APPEND ls_field TO ls_entity-fields.\n";
      }
      // the keys a handler gets are the instances' %tky: the key, and (R11)
      // %is_draft and %pid -- without them a handler's READ ENTITIES of a
      // draft (Prepare's validations, the carrier singleton's features) read
      // the active instance, or nothing
      const keyCopy = e.fields.filter(f => f.key).map(f => `      ls_key-${f.name} = <ls_row>-${f.name}.\n`).join("")
        + (model.withDraft ? "      ls_key-%is_draft = <ls_row>-%is_draft.\n" : "")
        + (entity.numbering === "late" ? "      ls_key-%pid = <ls_row>-%pid.\n" : "");
      const callables = [
        ...entity.determinations.map(d => ({...d, kind: "D"})),
        ...entity.validations.map(v => ({...v, kind: "V", on: "save"})),
        ...entity.actions.map((a, index) => ({...a, kind: a.determine ? "X" : (a.modifiers ?? []).includes("draft") ? "E" : "A", on: "", triggers: a.determine ? a.triggers : [], index})),
      ];
      let handler;
      for (const [n, c] of callables.entries()) {
        if (c.kind === "A" && (c.use || c.modifiers.some(m => m !== "internal" && m !== "factory") || c.parameter || (c.result && c.result.type !== "$self"))) {
          throw new Error(`${entity.entity}~${c.name}: only instance actions (also internal or factory) without parameter and with no or a $self result run (R6)`);
        }
        // R8: a draft action (Edit, Activate, Discard, Resume) is the
        // framework's: no handler method, the runtime runs it
        if (c.kind === "E") {
          model_ += `    CLEAR ls_callable.\n    ls_callable-kind = 'E'.\n    ls_callable-name = ${lit(upper(c.name))}.\n    APPEND ls_callable TO ls_entity-callables.\n`;
          continue;
        }
        // R6: a determine action has no method of its own; the runtime runs
        // its members, determinations on save and validations of the entity
        if (c.kind === "X") {
          if ((c.options ?? []).length) throw new Error(`${entity.entity}~${c.name}: determine action options are outside R6`);
          model_ += `    CLEAR ls_callable.\n    ls_callable-kind = 'X'.\n    ls_callable-name = ${lit(upper(c.name))}.\n`
            + (c.triggers ?? []).map(t => {
              const [owner, name] = t.name.includes("~") ? t.name.split("~").map(x => x.trim()) : [undefined, t.name];
              // R11: a member of an entity below the root (bdef-gen.mjs checked it)
              const other = owner && ![entity.entity, entity.alias].filter(Boolean).some(n => upper(n) === upper(owner))
                ? plan.entities.find(x => [x.entity.entity, x.entity.alias].filter(Boolean).some(n => upper(n) === upper(owner))) : undefined;
              return `    CLEAR ls_member.\n    ls_member-kind = '${t.kind === "determination" ? "D" : "V"}'.\n    ls_member-name = ${lit(upper(name))}.\n`
                + (other ? `    ls_member-entity = ${lit(upper(other.entity.entity))}.\n` : "")
                + ((t.options ?? []).some(o => o.name === "always") ? "    ls_member-always = abap_true.\n" : "")
                + "    APPEND ls_member TO ls_callable-members.\n";
            }).join("")
            + "    APPEND ls_callable TO ls_entity-callables.\n";
          continue;
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
          + (c.kind === "A" && featured(c.options) ? "    ls_callable-features = abap_true.\n" : "")
          + (c.kind === "A" && c.modifiers.includes("internal") ? "    ls_callable-internal = abap_true.\n" : "")
          + (c.kind === "A" && c.modifiers.includes("factory") ? "    ls_callable-factory = abap_true.\n" : "")
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
        defs += `    METHODS ${method}\n      IMPORTING\n        io_handler  TYPE REF TO object\n        ir_rows     TYPE REF TO data\n        ir_keys     TYPE REF TO data\n        ir_result   TYPE REF TO data\n        ir_failed   TYPE REF TO data\n        ir_reported TYPE REF TO data\n        ir_mapped   TYPE REF TO data OPTIONAL.\n`;
        calls += `      WHEN ${lit(`${upper(entity.entity)}~${upper(c.name)}`)}.\n        ${method}( io_handler = io_handler ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).\n`;
        const keyType = c.kind === "A" ? `${iface}=>t_${p}_a${c.index}_import` : `${iface}=>t_${p}_${c.kind === "D" ? "determination" : "validation"}`;
        let body = `    DATA lt_keys TYPE ${keyType}.\n    DATA ls_key LIKE LINE OF lt_keys.\n`
          + `    FIELD-SYMBOLS <lt_rows> TYPE ${iface}=>t_${p}_read_result.\n    FIELD-SYMBOLS <ls_row> LIKE LINE OF <lt_rows>.\n`
          + `    FIELD-SYMBOLS <ls_failed> TYPE ${iface}=>r_failed.\n    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.\n`
          + (m.parameters.some(x => x.role === "mapped") ? `    DATA ls_mapped TYPE ${iface}=>r_mapped.\n    FIELD-SYMBOLS <ls_mapped> TYPE ${iface}=>r_mapped.\n` : "");
        if (c.kind === "A") body += `    FIELD-SYMBOLS <lt_keys> TYPE ${keyType}.\n`;
        if (c.kind === "A" && c.result) body += `    FIELD-SYMBOLS <lt_result> TYPE ${iface}=>t_${p}_a${c.index}_result.\n`;
        body += "\n    ASSIGN ir_rows->* TO <lt_rows>.\n    ASSIGN ir_failed->* TO <ls_failed>.\n    ASSIGN ir_reported->* TO <ls_reported>.\n";
        // R6: the caller's MAPPED reaches the handler (a factory action fills it)
        if (m.parameters.some(x => x.role === "mapped")) body += "    IF ir_mapped IS BOUND.\n      ASSIGN ir_mapped->* TO <ls_mapped>.\n    ELSE.\n      ASSIGN ls_mapped TO <ls_mapped>.\n    ENDIF.\n";
        if (c.kind === "A") {
          body += "    ASSIGN ir_keys->* TO <lt_keys>.\n    lt_keys = <lt_keys>.\n";
          if (c.result) body += "    ASSIGN ir_result->* TO <lt_result>.\n";
        } else {
          body += "    LOOP AT <lt_rows> ASSIGNING <ls_row>.\n      CLEAR ls_key.\n"
            + keyCopy
            + "      APPEND ls_key TO lt_keys.\n    ENDLOOP.\n";
        }
        const actual = {keys: "lt_keys", entities: "<lt_rows>", failed: "<ls_failed>", reported: "<ls_reported>", result: "<lt_result>", mapped: "<ls_mapped>"};
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
      // R4: the instance features and the early numbering of the entity, each
      // a method in the system's form bound by its FOR clause
      const names = new Set([upper(entity.entity), upper(entity.alias ?? entity.entity)]);
      const special = form => {
        const found = handlers.flatMap(h => h.methods.filter(m => m.implicit?.form === form && m.implicit.clauses.some(x => names.has(upper(x.entity)))).map(m => ({h, m})));
        if (found.length > 1) throw new Error(`${entity.entity}: more than one FOR ${form} method in ${pool}`);
        if (found.length && handler && handler !== found[0].h.name) throw new Error(`${entity.entity}: handler methods in two classes (${handler}, ${found[0].h.name})`);
        if (found.length) handler = found[0].h.name;
        return found[0];
      };
      const wantsFeatures = entity.operations.some(o => featured(o.options)) || entity.actions.some(a => featured(a.options)) || tree.assocs.some(a => a.featCreate);
      const feat = special("FEATURES");
      if (wantsFeatures && !feat) throw new Error(`${entity.entity}: features : instance without a FOR INSTANCE FEATURES method in ${pool}`);
      if (feat) {
        const method = `${p}_feat`;
        model_ += "    ls_entity-features = abap_true.\n";
        defs += `    METHODS ${method}\n      IMPORTING\n        io_handler  TYPE REF TO object\n        ir_rows     TYPE REF TO data\n        ir_result   TYPE REF TO data\n        ir_failed   TYPE REF TO data\n        ir_reported TYPE REF TO data.\n`;
        calls += `      WHEN ${lit(`${upper(entity.entity)}~%FEATURES`)}.\n        ${method}( io_handler = io_handler ir_rows = ir_rows ir_result = ir_result ir_failed = ir_failed ir_reported = ir_reported ).\n`;
        const flags = [
          ...entity.operations.filter(o => !o.use && o.kind !== "create").map(o => `%${o.kind}`),
          ...entity.actions.map(a => `%action-${a.name.toLowerCase()}`),
          ...tree.assocs.filter(a => a.create).map(a => `%assoc-${a.name.toLowerCase()}`),
        ];
        const body = `    DATA lt_keys TYPE ${iface}=>t_${p}_features_key.\n    DATA ls_key LIKE LINE OF lt_keys.\n    DATA ls_request TYPE ${iface}=>${p}_feat.\n`
          + `    FIELD-SYMBOLS <lt_rows> TYPE ${iface}=>t_${p}_read_result.\n    FIELD-SYMBOLS <ls_row> LIKE LINE OF <lt_rows>.\n`
          + `    FIELD-SYMBOLS <lt_result> TYPE ${iface}=>t_${p}_features_result.\n`
          + `    FIELD-SYMBOLS <ls_failed> TYPE ${iface}=>r_failed.\n    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.\n\n`
          + "    ASSIGN ir_rows->* TO <lt_rows>.\n    ASSIGN ir_result->* TO <lt_result>.\n    ASSIGN ir_failed->* TO <ls_failed>.\n    ASSIGN ir_reported->* TO <ls_reported>.\n"
          + "    LOOP AT <lt_rows> ASSIGNING <ls_row>.\n      CLEAR ls_key.\n"
          + keyCopy
          + "      APPEND ls_key TO lt_keys.\n    ENDLOOP.\n"
          + flags.map(f => `    ls_request-${f} = if_abap_behv=>mk-on.\n`).join("")
          + callMethod(feat.h, feat.m, {keys: "lt_keys", request: "ls_request", result: "<lt_result>", failed: "<ls_failed>", reported: "<ls_reported>"});
        methods += `  METHOD ${method}.\n* instance features: ${feat.h.name}->${feat.m.name}\n${body}  ENDMETHOD.\n\n`;
        tables += `      WHEN ${lit(`${upper(entity.entity)}~FEATURES RESULT~`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${p}_features_result.\n`;
      }
      // R5: the cba numbering of each child this entity creates by association
      for (const [k, a] of tree.assocs.entries()) {
        const target = plan.entities.find(x => upper(x.entity.entity) === a.target);
        if (!a.create || target.entity.numbering !== "early") continue;
        const found = handlers.flatMap(h => h.methods.filter(m => m.implicit?.form === "NUMBERING"
          && m.implicit.clauses.some(x => x.assoc && names.has(upper(x.source)) && upper(x.assoc) === upper(a.name))).map(m => ({h, m})));
        if (found.length !== 1) throw new Error(`${entity.entity}\\${a.name}: early numbering of ${target.entity.entity} needs one FOR NUMBERING ... FOR CREATE ${entity.alias ?? entity.entity}\\${a.name} method in ${pool} (found ${found.length})`);
        if (handler && handler !== found[0].h.name) throw new Error(`${entity.entity}: handler methods in two classes (${handler}, ${found[0].h.name})`);
        handler = found[0].h.name;
        const method = `${p}_cba${k}`;
        defs += `    METHODS ${method}\n      IMPORTING\n        io_handler  TYPE REF TO object\n        ir_rows     TYPE REF TO data\n        ir_mapped   TYPE REF TO data\n        ir_failed   TYPE REF TO data\n        ir_reported TYPE REF TO data.\n`;
        calls += `      WHEN ${lit(`${upper(entity.entity)}~%NUMBERING\\${upper(a.name)}`)}.\n        ${method}( io_handler = io_handler ir_rows = ir_rows ir_mapped = ir_mapped ir_failed = ir_failed ir_reported = ir_reported ).\n`;
        const x = `${p}_x${k}`;
        const body = `    FIELD-SYMBOLS <lt_rows> TYPE ${iface}=>t_${x}_create.\n    FIELD-SYMBOLS <ls_mapped> TYPE ${iface}=>r_mapped.\n`
          + `    FIELD-SYMBOLS <ls_failed> TYPE ${iface}=>r_failed.\n    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.\n\n`
          + "    ASSIGN ir_rows->* TO <lt_rows>.\n    ASSIGN ir_mapped->* TO <ls_mapped>.\n    ASSIGN ir_failed->* TO <ls_failed>.\n    ASSIGN ir_reported->* TO <ls_reported>.\n"
          + callMethod(found[0].h, found[0].m, {entities: "<lt_rows>", mapped: "<ls_mapped>", failed: "<ls_failed>", reported: "<ls_reported>"});
        methods += `  METHOD ${method}.\n* early numbering of a create by association: ${found[0].h.name}->${found[0].m.name}\n${body}  ENDMETHOD.\n\n`;
      }
      // the derived tables of the associations (R5), for the bridge and EML
      for (const [k, a] of tree.assocs.entries()) {
        const x = `${p}_x${k}`;
        const target = plan.entities.find(t => upper(t.entity.entity) === a.target);
        tables += `      WHEN ${lit(`${upper(entity.entity)}~CREATE BY~${upper(a.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${x}_create.\n`
          + `      WHEN ${lit(`${upper(entity.entity)}~READ BY~${upper(a.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${x}_rimport.\n`
          + `      WHEN ${lit(`${upper(entity.entity)}~READ BY RESULT~${upper(a.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${target.prefix}_read_result.\n`
          + `      WHEN ${lit(`${upper(entity.entity)}~LINK~${upper(a.name)}`)}.\n        CREATE DATA rr_table TYPE ${iface}=>t_${x}_link.\n`;
      }
      if (entity.numbering === "early" && entity.operations.some(o => o.kind === "create" && !o.use)) {
        const num = handlers.flatMap(h => h.methods.filter(m => m.implicit?.form === "NUMBERING" && m.implicit.clauses.some(x => !x.assoc && names.has(upper(x.entity)))).map(m => ({h, m})))[0];
        if (!num) throw new Error(`${entity.entity}: early numbering without a FOR NUMBERING ... FOR CREATE method in ${pool}`);
        if (handler && handler !== num.h.name) throw new Error(`${entity.entity}: handler methods in two classes (${handler}, ${num.h.name})`);
        handler = num.h.name;
        const method = `${p}_num`;
        defs += `    METHODS ${method}\n      IMPORTING\n        io_handler  TYPE REF TO object\n        ir_rows     TYPE REF TO data\n        ir_mapped   TYPE REF TO data\n        ir_failed   TYPE REF TO data\n        ir_reported TYPE REF TO data.\n`;
        calls += `      WHEN ${lit(`${upper(entity.entity)}~%NUMBERING`)}.\n        ${method}( io_handler = io_handler ir_rows = ir_rows ir_mapped = ir_mapped ir_failed = ir_failed ir_reported = ir_reported ).\n`;
        const body = `    FIELD-SYMBOLS <lt_rows> TYPE ${iface}=>t_${p}_create.\n    FIELD-SYMBOLS <ls_mapped> TYPE ${iface}=>r_mapped.\n`
          + `    FIELD-SYMBOLS <ls_failed> TYPE ${iface}=>r_failed.\n    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.\n\n`
          + "    ASSIGN ir_rows->* TO <lt_rows>.\n    ASSIGN ir_mapped->* TO <ls_mapped>.\n    ASSIGN ir_failed->* TO <ls_failed>.\n    ASSIGN ir_reported->* TO <ls_reported>.\n"
          + callMethod(num.h, num.m, {entities: "<lt_rows>", mapped: "<ls_mapped>", failed: "<ls_failed>", reported: "<ls_reported>"});
        methods += `  METHOD ${method}.\n* early numbering: ${num.h.name}->${num.m.name}\n${body}  ENDMETHOD.\n\n`;
      }
      if (handler) model_ += `    ls_entity-handler = ${lit(absolute(handler))}.\n`;
      model_ += "    APPEND ls_entity TO rs_model-entities.\n";
      rows += `      WHEN ${lit(upper(entity.entity))}.\n        CREATE DATA rr_rows TYPE ${iface}=>t_${p}_read_result.\n`;
      // R8: the served rows of a draft entity, active and draft versions
      if (model.withDraft) {
        const union = `${cls}_d${plan.entities.indexOf(e)}`;
        outputs[`${union}.clas.abap`] = draftUnion(union, e, entity, upper(root));
        model_ = model_.replace(/(    APPEND ls_entity TO rs_model-entities\.\n)$/, `    ls_entity-union = ${lit(upper(union))}.\n$1`);
      }
      for (const c of callables) {
        // by the CDS name or the alias, as the runtime names an entity
        const names = [...new Set([upper(entity.entity), upper(entity.alias ?? entity.entity)])].map(e => lit(`${e}~${upper(c.name)}`)).join(" OR ");
        if ((c.kind === "A" || c.kind === "E") && c.result) results += `      WHEN ${names}.\n        CREATE DATA rr_result TYPE ${iface}=>t_${p}_a${c.index}_result.\n`;
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
    DATA ls_assoc TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_pair TYPE zif_osd_rap_bo=>ty_pair.
    DATA ls_member TYPE zif_osd_rap_bo=>ty_member.
    DATA ls_saver TYPE zif_osd_rap_bo=>ty_saver.

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
${late ? `      WHEN 'MAPPED LATE'.\n        CREATE DATA rr_response TYPE ${iface}=>r_mapped_late.\n` : ""}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_request.
    CASE to_upper( iv_kind ).
      WHEN 'CHANGE'.
        CREATE DATA rr_request TYPE ${iface}=>r_change.
      WHEN 'DELETE'.
        CREATE DATA rr_request TYPE ${iface}=>r_delete.
    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~save_modified.
* R7: the saver's save_modified, its parameters lowered from the
* REDEFINITION (tools/rap/lower-derived.mjs)
    FIELD-SYMBOLS <ls_create> TYPE ${iface}=>r_change.
    FIELD-SYMBOLS <ls_update> TYPE ${iface}=>r_change.
    FIELD-SYMBOLS <ls_delete> TYPE ${iface}=>r_delete.
    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.
    ASSIGN ir_create->* TO <ls_create>.
    ASSIGN ir_update->* TO <ls_update>.
    ASSIGN ir_delete->* TO <ls_delete>.
    ASSIGN ir_reported->* TO <ls_reported>.
    CALL METHOD io_saver->('SAVE_MODIFIED')
      EXPORTING
        create   = <ls_create>
        update   = <ls_update>
        delete   = <ls_delete>
      CHANGING
        reported = <ls_reported>.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~adjust_numbers.
* R10: the saver's adjust_numbers, its parameters lowered from the
* REDEFINITION (tools/rap/lower-derived.mjs)
${late ? `    FIELD-SYMBOLS <ls_mapped> TYPE ${iface}=>r_mapped_late.
    FIELD-SYMBOLS <ls_reported> TYPE ${iface}=>r_reported.
    ASSIGN ir_mapped->* TO <ls_mapped>.
    ASSIGN ir_reported->* TO <ls_reported>.
    CALL METHOD io_saver->('ADJUST_NUMBERS')
      CHANGING
        mapped   = <ls_mapped>
        reported = <ls_reported>.
` : "    RETURN.\n"}  ENDMETHOD.

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
  projections.sort((a, b) => a.entity.localeCompare(b.entity));
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

  METHOD zif_osd_rap_registry~projection.
* R5: the projection entities of the tree, each over its base entity
    DATA ls_map TYPE zif_osd_rap_registry=>ty_map.
    CASE to_upper( iv_entity ).
${projections.map(projectionCase).join("")}    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_registry~projections.
* R11: the entities of one projection or interface BDEF (EML over it)
    DATA ls_projection TYPE zif_osd_rap_registry=>ty_projection.
    CASE to_upper( iv_bdef ).
${[...new Set(projections.map(x => x.bdef))].sort().map(b => `      WHEN ${lit(b)}.
` + projections.filter(x => x.bdef === b).map(x =>
  `        ls_projection = zif_osd_rap_registry~projection( ${lit(x.entity)} ).
        APPEND ls_projection TO rt_projection.
`).join("")).join("")}    ENDCASE.
  ENDMETHOD.

ENDCLASS.
`;
  return outputs;
}
