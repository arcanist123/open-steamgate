// R2c: a service definition becomes a service (docs/rap-runtime.md, "Serving").
//
//   define service ZUI_RAP_NOTE {
//     expose ZI_RAP_NOTE as Note;
//   }
//
// The transpiler refuses SRVD objects (ANORMALIES srvd-not-allowed), so a
// service definition is excluded from the transpile like a BDEF and read
// here instead, with the BDEF tokenizer rather than a pattern. What it
// writes is the model of a stg-compile service (`<srvd>.stg.yaml` in
// gen/rap/), which `stg-compile --all` compiles like any other: one entity
// per exposed CDS entity, bound to the view through SADL, so reads take the
// CDS path a published view takes; a behavior definition over the entity
// makes the set writable and its instance actions function imports, and the
// SADL data provider hands those writes to the managed RAP runtime.
//
// There is no service binding here: the service is named after the
// definition, version 0001, and is served over V2 and V4 alike.
import {createHash} from "node:crypto";
import {tokenize} from "./tokenize.mjs";
import {classNameOf} from "../cds-names.mjs";

const upper = s => String(s).toUpperCase();

/** the grammar a minimal SRVD uses: annotations, then one define service */
export function parseSrvd(source, file = "srvd") {
  const t = tokenize(source);
  let i = 0;
  const at = () => t[i]?.lower;
  const take = (expected) => {
    const token = t[i];
    if (!token) throw new Error(`${file}: unexpected end, expected ${expected ?? "more"}`);
    if (expected !== undefined && token.lower !== expected) throw new Error(`${file}:${token.line}: expected ${expected}, found ${token.value}`);
    i++;
    return token.value;
  };
  // header annotations (@EndUserText.label: '...', @Metadata...) are skipped
  // up to `define`; a label is kept for the description
  let label = "";
  while (i < t.length && at() !== "define") {
    if (at() === "@") {
      const start = i;
      i++;
      const path = [];
      while (i < t.length && at() !== ":" && at() !== "@" && at() !== "define") path.push(t[i++].value);
      if (at() === ":") {
        i++;
        const value = t[i++]?.value ?? "";
        if (path.join("").toLowerCase() === "endusertext.label" && /^'/.test(value)) label = value.slice(1, -1).replaceAll("''", "'");
      }
      if (i === start) i++;
    } else {
      throw new Error(`${file}:${t[i].line}: expected an annotation or define, found ${t[i].value}`);
    }
  }
  take("define");
  take("service");
  const name = take();
  take("{");
  const exposed = [];
  while (at() !== "}") {
    if (at() === undefined) throw new Error(`${file}: service ${name} is not closed`);
    if (at() === "@") throw new Error(`${file}:${t[i].line}: element annotations in a service definition are not read yet`);
    take("expose");
    const entity = take();
    let alias = entity;
    if (at() === "as") {
      take("as");
      alias = take();
    }
    take(";");
    exposed.push({entity: upper(entity), alias});
  }
  take("}");
  if (i < t.length) throw new Error(`${file}:${t[i].line}: text after the service definition`);
  if (!exposed.length) throw new Error(`${file}: service ${name} exposes nothing`);
  return {name: upper(name), label, exposed};
}

// the OData type of a CDS element of a given ABAP type. A RAW16 UUID is a
// 32-character hex string: the V2 wire has no Edm.Guid conversion yet
function edm(type, where) {
  const t = String(type).toLowerCase().trim();
  let m;
  if ((m = /^c length (\d+)$/.exec(t)) || (m = /^n length (\d+)$/.exec(t))) return `String(${Number(m[1])})`;
  if ((m = /^x length (\d+)$/.exec(t))) return `String(${Number(m[1]) * 2})`;
  if (t === "string") return "String";
  // R10: a large object (the flight agency's Attachment, RAWSTRING)
  if (t === "xstring") return "Binary";
  if (t === "d") return "date";
  if (t === "t") return "Time";
  if (t === "i" || t === "int4") return "Int32";
  // R11: a literal's type (the carrier singleton's `1`: INT1)
  if (t === "int1") return "Byte";
  if (t === "int2") return "Int16";
  if (t === "int8") return "Int64";
  if ((m = /^p length (\d+) decimals (\d+)$/.exec(t))) return `"Decimal(${Number(m[1]) * 2 - 1},${Number(m[2])})"`;
  throw new Error(`${where}: no OData type for ABAP type ${type}`);
}

const yamlString = s => JSON.stringify(String(s));

// R9: the CDS view a draft-enabled service serves its draft administrative
// data from (src/rap_draftadm/zosd_i_draftadm.ddls.asddls, over ZOSD_DRAFT_ADM), the
// entity set and type it is served as, and the OData type of each element
// where the CDS type alone does not say it (docs/rap-runtime.md, R9;
// unmeasured: a system's set and type names and Edm.Guid for the UUID)
export const DRAFT_ADMIN = {view: "ZOSD_I_DRAFTADM", set: "DraftAdministrativeData", type: "DraftAdministrativeDataType"};
// the element names as the view spells them (a virtual element's case is not kept by the CDS parse)
const DRAFT_ADMIN_NAMES = new Map(["DraftUUID", "DraftEntityType", "CreationDateTime", "CreatedByUser", "LastChangeDateTime",
  "LastChangedByUser", "InProcessByUser", "CreatedByUserDescription", "LastChangedByUserDescription", "InProcessByUserDescription",
  "DraftIsCreatedByMe", "DraftIsLastChangedByMe", "DraftIsProcessedByMe"].map(n => [n.toUpperCase(), n]));
const DRAFT_ADMIN_TYPES = {
  CREATIONDATETIME: "DateTimeOffset", LASTCHANGEDATETIME: "DateTimeOffset",
  DRAFTISCREATEDBYME: "Boolean", DRAFTISLASTCHANGEDBYME: "Boolean", DRAFTISPROCESSEDBYME: "Boolean",
};

/**
 * The stg-compile model of a service definition.
 * entityOf(name) -> {view, fields, behavior} where view is the parsed CDS
 * entity (original element names and labels), fields the resolved elements
 * ({name, type, key}) and behavior, for an entity of a managed BDEF, the
 * operations, field control and actions the runtime knows.
 */
export function serviceYaml(srvd, entityOf, file = "srvd") {
  const service = srvd.name;
  if (service.length > 26) throw new Error(`${file}: service ${service} is longer than 26 characters`);
  // A namespaced service keeps its namespace in front of the class names
  // (/DMO/CL_..., the shape stg-compile's own `cls` gives a project that
  // names no classes), so the prefix is 8 characters, not ZCL_'s 4. 30
  // characters of class name with _MPC_EXT (8) behind it leave 18 of a
  // plain name, 14 of a namespaced one; a longer name keeps 12 (a
  // namespaced one 8) and adds 6 of its own hash, so two services that
  // share a prefix never name the same classes
  const ns = /^\/([^/]+)\/(.+)$/.exec(service);
  const head = ns ? `/${ns[1]}/CL_` : "ZCL_";
  const stem = ns ? ns[2] : service;
  const keep = ns ? 14 : 18;
  const short = stem.length <= keep
    ? head + stem
    : head + stem.slice(0, keep - 6) + upper(createHash("sha256").update(service).digest("hex").slice(0, 6));
  const lines = [];
  lines.push(`# generated by tools/rap/srvd-gen.mjs from ${service} (service definition) - do not edit`);
  lines.push(`project: ${service}`);
  lines.push(`service: ${service}`);
  lines.push(`model: ${service}`);
  lines.push(`description: ${yamlString((srvd.label || service).slice(0, 60))}`);
  lines.push(`namespace: ${service}`);
  lines.push(`classes: {mpc: ${short}_MPC, mpc_ext: ${short}_MPC_EXT, dpc: ${short}_DPC, dpc_ext: ${short}_DPC_EXT}`);
  lines.push("entities:");
  const functions = [];
  const functionNames = new Set();
  const aliases = new Set();
  const resolved = [];
  const annotations = [];
  // R9: the navigations every entity of a draft BO has, SiblingEntity (the
  // other version of the instance) and DraftAdministrativeData
  const draftNavs = [];
  for (const x of srvd.exposed) {
    if (aliases.has(upper(x.alias))) throw new Error(`${file}: ${x.alias} is exposed twice`);
    aliases.add(upper(x.alias));
    const {view, fields, behavior, draft} = entityOf(x.entity);
    const type = `${x.alias}Type`;
    resolved.push({x, view, type});
    const b0 = behavior ?? {create: false, update: false, delete: false, control: new Map(), actions: []};
    // R11: DELETE of a draft root's draft is its Discard (what sap.fe sends),
    // so a draft root takes a DELETE even when its active instance has none
    // (the carrier singleton's root); the runtime refuses it on the active one
    const b = draft?.root && !b0.delete ? {...b0, delete: true} : b0;
    const ops = ["R", "Q"];
    if (b.create) ops.unshift("C");
    if (b.update) ops.push("U");
    if (b.delete) ops.push("D");
    // `element` is the name as the CDS source spells it (cds2ddic's parse):
    // the properties keep it, a published view keeps the upper-case name
    const nameOf = new Map(view.fields.map(f => [upper(f.name), f]));
    const prop = f => nameOf.get(upper(f.name))?.element ?? nameOf.get(upper(f.name))?.name ?? f.name;
    lines.push(`  ${type}:`);
    lines.push(`    set: ${x.alias}`);
    // R8: a draft entity's rows are its union class's (IsActiveEntity and
    // the two flags beside the CDS elements), keyed also by IsActiveEntity
    const struct = draft ? upper(draft.union) : upper(classNameOf("zcl_stg_cds_", view.sqlView));
    lines.push(`    source: {cds: ${x.entity}, struct: "${struct}=>TY_ROW"}`);
    lines.push(`    keys: [${[...fields.filter(f => f.key).map(prop), ...(draft ? ["IsActiveEntity"] : [])].join(", ")}]`);
    lines.push(`    creatable: ${b.create}`);
    lines.push(`    updatable: ${b.update}`);
    lines.push(`    deletable: ${b.delete}`);
    lines.push(`    operations: [${ops.join(", ")}]`);
    lines.push("    properties:");
    for (const f of fields) {
      const c = b.control.get(upper(f.name)) ?? {};
      const writable = b.create || b.update;
      const flags = !writable || c.readonly === "X" || c.numbering ? ", readonly: true"
        : f.key ? ", updatable: false"
        : c.readonly === "U" ? ", updatable: false" : "";
      // every property is labelled (the CDS label, else its name), which is
      // what a Fiori client shows as the column and field title
      const label = nameOf.get(upper(f.name))?.label;
      const etag = b.etag && upper(b.etag) === upper(f.name) ? ", etag: true" : "";
      lines.push(`      ${prop(f)}: {type: ${edm(f.type, `${x.entity}.${f.name}`)}, field: ${upper(f.name)}${flags}${etag}, label: ${yamlString(String(label && upper(label) !== upper(f.name) ? label : prop(f)).slice(0, 60))}}`);
    }
    if (draft) {
      lines.push("      IsActiveEntity: {type: Boolean, field: ISACTIVEENTITY, readonly: true, label: \"IsActiveEntity\"}");
      lines.push("      HasActiveEntity: {type: Boolean, field: HASACTIVEENTITY, readonly: true, label: \"HasActiveEntity\"}");
      lines.push("      HasDraftEntity: {type: Boolean, field: HASDRAFTENTITY, readonly: true, label: \"HasDraftEntity\"}");
      // the actions Fiori Elements V4 calls by the names Common.DraftRoot
      // gives; Discard is the DELETE of the draft root (docs/rap-runtime.md, R8)
      draftNavs.push(x.alias);
      if (draft.root) annotations.push(`  ${type}:`, `    draftRoot: {set: ${x.alias}, activation: ${service}.Activate, edit: ${service}.Edit, prepare: ${service}.Prepare}`);
      else annotations.push(`  ${type}:`, `    draftNode: {set: ${x.alias}}`);
    }
    for (const a of b.actions) {
      // R8: Discard is DELETE of the draft root over OData
      if (draft && upper(a) === "DISCARD") continue;
      if (functionNames.has(upper(a))) throw new Error(`${file}: two exposed entities have an action ${a}; a V2 function import needs one name`);
      functionNames.add(upper(a));
      const params = fields.filter(f => f.key).map(f => `${prop(f)}: ${edm(f.type, `${x.entity}.${f.name}`)}`);
      if (draft) params.push("IsActiveEntity: Boolean");
      if (draft && upper(a) === "EDIT") params.push("PreserveChanges: Boolean");
      functions.push(`  ${a}:`, "    method: POST", `    returns: {entity: ${type}, set: ${x.alias}, multiplicity: "1"}`, `    for: ${type}`,
        `    parameters: {${params.join(", ")}}`);
    }
  }
  if (draftNavs.length) {
    if (aliases.has(upper(DRAFT_ADMIN.set))) throw new Error(`${file}: ${DRAFT_ADMIN.set} is the draft administrative data of a draft service`);
    let admin;
    try {
      admin = entityOf(DRAFT_ADMIN.view);
    } catch (error) {
      throw new Error(`${file}: a draft service serves ${DRAFT_ADMIN.view} as ${DRAFT_ADMIN.set}: ${error.message}`);
    }
    const prop = f => DRAFT_ADMIN_NAMES.get(upper(f.name)) ?? f.name;
    lines.push(`  ${DRAFT_ADMIN.type}:`, `    set: ${DRAFT_ADMIN.set}`,
      `    source: {cds: ${DRAFT_ADMIN.view}, struct: "${upper(classNameOf("zcl_stg_cds_", admin.view.sqlView))}=>TY_ROW"}`,
      `    keys: [${admin.fields.filter(f => f.key).map(prop).join(", ")}]`,
      "    creatable: false", "    updatable: false", "    deletable: false", "    operations: [R, Q]", "    properties:");
    for (const f of admin.fields) {
      const type = DRAFT_ADMIN_TYPES[upper(f.name)] ?? edm(f.type, `${DRAFT_ADMIN.view}.${f.name}`);
      lines.push(`      ${prop(f)}: {type: ${type}, field: ${upper(f.name)}, readonly: true, label: ${yamlString(prop(f))}}`);
    }
  }
  // R5: the associations of an exposed entity to another exposed entity are
  // its navigation properties (the V2 name, to_<alias without _>, on V4
  // too, as for every service of this registry); a composition's pairs are
  // the referential constraint, a to-parent association is N:1 without one
  const element = (r, name) => {
    const f = r.view.fields.find(v => upper(v.name) === upper(name));
    return f?.element ?? f?.name ?? name;
  };
  const assocLines = [];
  // R11: an association (set) name is at most 40 characters in the model
  // (/IWBEP/ external names): the singleton's CarriersSingleton_DraftAdmini-
  // strativeData has 41. A longer one keeps 35 and a hash of the whole
  const bounded = n => n.length <= 40 ? n : `${n.slice(0, 35)}_${createHash("sha256").update(n).digest("hex").slice(0, 4).toUpperCase()}`;
  for (const r of resolved) {
    for (const a of r.view.associations ?? []) {
      if (!a.exposed || !(a.pairs ?? []).length) continue;
      const to = resolved.find(t => upper(t.x.entity) === upper(a.target));
      if (!to) continue;
      const nav = `to_${a.alias.replace(/^_/, "")}`;
      const name = bounded(`${r.x.alias}_${a.alias.replace(/^_/, "")}`);
      const parent = a.composition === "PARENT";
      const card = parent ? "N:1" : a.max === "*" ? "1:N" : a.min === "0" ? "1:0" : "1:1";
      assocLines.push(`  ${name}:`, `    from: ${r.type}`, `    to: ${to.type}`, `    cardinality: "${card}"`, `    set: ${name}`);
      if (!parent) assocLines.push(`    constraint: {${a.pairs.map(pr => `${element(r, pr.source)}: ${element(to, pr.target)}`).join(", ")}}`);
      assocLines.push(`    navigation: {${r.type}: ${nav}}`);
    }
  }
  // R9: SiblingEntity is the same type (no constraint: the key without
  // IsActiveEntity, the other version); DraftAdministrativeData the admin
  // row of the instance's draft. Both 0..1, both resolved by the SADL data
  // provider (zcl_stg_sadl_dpc), not by CDS associations
  for (const alias of draftNavs) {
    const type = `${alias}Type`;
    const sibling = bounded(`${alias}_SiblingEntity`), admin = bounded(`${alias}_DraftAdministrativeData`);
    assocLines.push(`  ${sibling}:`, `    from: ${type}`, `    to: ${type}`, `    cardinality: "1:0"`, `    set: ${sibling}`,
      `    navigation: {${type}: SiblingEntity}`);
    assocLines.push(`  ${admin}:`, `    from: ${type}`, `    to: ${DRAFT_ADMIN.type}`, `    cardinality: "1:0"`,
      `    set: ${admin}`, `    navigation: {${type}: DraftAdministrativeData}`);
  }
  if (assocLines.length) lines.push("associations:", ...assocLines);
  if (functions.length) lines.push("functions:", ...functions);
  if (annotations.length) lines.push("annotations:", ...annotations);
  return lines.join("\n") + "\n";
}
