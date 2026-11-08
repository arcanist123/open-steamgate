#!/usr/bin/env node
// SEGW offline, step 2: the generator.
//
// Reads a SEGW project (<project>.iwpr.xml as abapGit serializes it) and
// writes what transaction SEGW's "Generate Runtime Objects" writes: the model
// provider base class (_MPC) and the data provider base class (_DPC), each
// with its abapGit .clas.xml, plus the two _EXT subclasses when they do not
// exist yet (SEGW creates those once and never touches them again).
//
// The templates are SEGW's own, taken from generated classes in the wild;
// `--check <folder>` diffs the output against the classes already in a
// folder, which is how the generator is tested: on a repository that holds
// both the IWPR and what SEGW made of it, the diff must be empty (the
// generation timestamps are masked).
//
// The project tree (tables /IWBEP/I_SBD_* = service builder design, /IWBEP/
// I_SBO_* = the OData model): PR project, MD model (namespace, MPC class), SV
// service (DPC class), GA generated artifacts (class names), ET entity types,
// PR properties (SORT_ORDER), ES entity sets, ASO associations, AT
// association sets, NP navigation properties, RC referential constraints,
// FI function imports with FP parameters, OP the DPC operations per entity
// set with their method names. A flag named X_XU set to X means "X is NOT
// set"; a plain flag set to X means set.
import {existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {SHLP_IMPLEMENTATION, SHLP_INTERFACE, loadFunctionGroups, rfcMethod, shlpMethod} from "./segw-gen-mapping.mjs";

// ---------------------------------------------------------------- parsing

function records(xml, table) {
  // abapGit nests <TABLE><TABLE>record</TABLE><TABLE>record</TABLE></TABLE>
  const out = [];
  const block = new RegExp(`<${table}>\\s*((?:<${table}>[\\s\\S]*?</${table}>\\s*)+)</${table}>`).exec(xml);
  if (block === null) {
    return out;
  }
  const rec = new RegExp(`<${table}>([\\s\\S]*?)</${table}>`, "g");
  let m;
  while ((m = rec.exec(block[1])) !== null) {
    const fields = {};
    for (const f of m[1].matchAll(/<([A-Z_0-9]+)>([^<]*)<\/\1>/g)) {
      fields[f[1]] = unescapeXml(f[2]);
    }
    out.push(fields);
  }
  return out;
}

// abapGit escapes the five XML entities in a value; a tree field can hold any
// of them (a description with an ampersand, a bind structure with =>)
function unescapeXml(text) {
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&amp;", "&");
}

export function parseIwpr(xml) {
  const t = (name) => records(xml, "_-IWBEP_-I_" + name);
  return {
    project: t("SBD_PR")[0] ?? {},
    projectText: t("SBD_PRT")[0] ?? {},
    model: t("SBD_MD")[0] ?? {},
    service: t("SBD_SV")[0] ?? {},
    artifacts: t("SBD_GA"),
    dataSources: t("SBD_DS"),
    mappings: t("SBD_MH"),
    propertyMappings: t("SBD_MP"),
    mappingRanges: t("SBD_MR"),
    modelReferences: t("SBO_MR"),
    operations: t("SBD_OP"),
    designSets: t("SBD_SE"),
    entityTypes: t("SBO_ET"),
    properties: t("SBO_PR"),
    propertyTexts: t("SBO_PRT"),
    entitySets: t("SBO_ES"),
    associations: t("SBO_ASO"),
    associationSets: t("SBO_AT"),
    navigationProperties: t("SBO_NP"),
    referentialConstraints: t("SBO_RC"),
    functionImports: t("SBO_FI"),
    functionParameters: t("SBO_FP"),
    // The text tables of the actions and their parameters, read for the same
    // reason SBO_PRT is: the label is what a person typed, the name is what
    // the tool made. A project imported from a real IWPR with a label of its
    // own was served under its name.
    functionImportTexts: t("SBO_FIT"),
    functionParameterTexts: t("SBO_FPT"),
    complexTypes: t("SBO_CT"),
    referenceDataSources: t("SBO_DSR"),
  };
}

// ------------------------------------------------------------------ model

const set = (r, flag) => r[flag] === "X";

// What the tree stores for a property's size and what SEGW writes for it:
// a string has MAX_LENGTH -> set_maxlength; a decimal has PROP_PRECISION
// (digits) and SCALE -> set_maxlength( digits ) + set_precison( scale );
// a DateTime with a precision has PROP_PRECISION (7 for TIMESTAMPL) ->
// set_precison, and when the tree also carries SCALE (P 21 / S 7) the
// digits go to set_maxlength. TYPE_KIND/LENGTH/DECIMALS are the ABAP type
// behind a property without DDIC (inline structure component).
function lengths(pr) {
  const digits = pr.PROP_PRECISION ?? "";
  const scale = pr.SCALE ?? "";
  const decimal = pr.EDM_CORE_TYPE === "Edm.Decimal";
  return {
    precision: scale || (decimal ? "" : digits),
    maxLength: decimal || scale ? digits : (pr.MAX_LENGTH ?? ""),
    digits, scale, typeKind: pr.TYPE_KIND ?? "", length: pr.LENGTH ?? "", decimals: pr.DECIMALS ?? "",
  };
}

export function buildModel(p) {
  const byUuid = new Map();
  for (const list of [p.entityTypes, p.entitySets, p.associations, p.properties, p.functionImports]) {
    for (const r of list) {
      byUuid.set(r.NODE_UUID, r);
    }
  }
  const artifact = (kind) => p.artifacts.find((a) => a.GEN_ART_TYPE === kind)?.NAME ?? "";
  const mpc = artifact("MPCB");
  const entityTypes = p.entityTypes.map((et) => {
    const props = p.properties.filter((pr) => pr.PARENT_UUID === et.NODE_UUID)
      .sort((a, b) => Number(a.SORT_ORDER || 0) - Number(b.SORT_ORDER || 0))
      .map((pr) => ({
        name: pr.NAME,
        abapField: pr.ABAP_FIELD || pr.NAME.toUpperCase(),
        isKey: set(pr, "IS_KEY"),
        edmType: pr.EDM_CORE_TYPE,
        ...lengths(pr),
        creatable: set(pr, "CREATABLE"),
        updatable: set(pr, "UPDATABLE"),
        sortable: set(pr, "SORTABLE"),
        nullable: set(pr, "IS_NULLABLE"),
        filterable: set(pr, "FILTERABLE"),
        semantics: pr.SEMANTICS ?? "",
        asEtag: set(pr, "AS_ETAG"),
        label: p.propertyTexts.find((t) => t.NODE_UUID === pr.NODE_UUID)?.PROP_LABEL ?? "",
        typeName: pr.TYPE_NAME ?? "",
        complexType: pr.COMPLEX_TYPE ? (p.complexTypes.find((ct) => ct.NODE_UUID === pr.COMPLEX_TYPE)?.NAME ?? "") : "",
        uuid: pr.NODE_UUID,
      }));
    const sets = p.entitySets.filter((es) => es.ENTITY_TYPE === et.NODE_UUID).map((es) => ({
      name: es.NAME,
      // a plain X is set; no field or the X_XU marker ("explicitly cleared") is not
      creatable: set(es, "CREATABLE"),
      updatable: set(es, "UPDATABLE"),
      deletable: set(es, "DELETABLE"),
      pageable: set(es, "PAGEABLE"),
      addressable: set(es, "ADDRESSABLE"),
      searchable: set(es, "SEARCHABLE"),
      subscribable: set(es, "SUBSCRIBABLE"),
      filterRequired: set(es, "REQUIRES_FILTER"),
      uuid: es.NODE_UUID,
      operations: p.operations
        .filter((op) => p.designSets.find((d) => d.NODE_UUID === op.PARENT_UUID)?.ENTITY_SET_UUID === es.NODE_UUID)
        .map((op) => ({type: op.OPERATION_TYPE, method: op.IMP_METHOD, mapping: operationMapping(p, op)})),
      // "Map to data source" on a DDIC table, a CDS view or an EPM business
      // object (DS_TYPE 4): SEGW lets SADL serve the set, the DPC delegates
      // every operation to it. The mapping hangs under the entity set node
      // or under one of its operations.
      sadl: (() => {
        const design = p.designSets.find((d) => d.ENTITY_SET_UUID === es.NODE_UUID);
        if (!design) {
          return undefined;
        }
        const nodes = [design.NODE_UUID, ...p.operations.filter((op) => op.PARENT_UUID === design.NODE_UUID).map((op) => op.NODE_UUID)];
        for (const mh of p.mappings.filter((x) => nodes.includes(x.PARENT_UUID))) {
          const ds = p.dataSources.find((d) => d.NODE_UUID === mh.DS_UUID);
          const kind = ds && ds.DS_TYPE === "4" && /^(DDIC|CDS|EPM|ODC)~/.exec(ds.DS_GROUP ?? "");
          if (kind) {
            const binding = ds.DS_GROUP.slice(kind[0].length);
            if (kind[1] === "ODC") {
              // steamgate's local "external service": ODC~<service>~<entity set>
              // of another service in the registry, consumed in-process
              const [service, set] = binding.split("~");
              return {type: "ODC", binding, service, set};
            }
            return {type: kind[1], binding};
          }
        }
        return undefined;
      })(),
    }));
    return {
      // the suffix of GC_/DEFINE_/TS_/TT_ is the entity name in upper case, not
      // TECH_NAME: copied or renamed entities keep a stale TECH_NAME in the tree
      // (an entity type referenced from another model, NAME_XU = X, only has its TECH_NAME)
      name: et.NAME ?? et.TECH_NAME ?? "", techName: (et.NAME ?? et.TECH_NAME ?? "").toUpperCase(), abapStruct: et.ABAP_STRUCT ?? "",
      // a media entity: its content is a stream at <entity>/$value
      isMedia: set(et, "IS_MEDIA"),
      // ABAP names stop at 30 characters: TS_/TT_/GC_ + 27, DEFINE_ + 23
      typeStem: (et.NAME ?? et.TECH_NAME ?? "").toUpperCase().slice(0, 27), defineStem: (et.NAME ?? et.TECH_NAME ?? "").toUpperCase().slice(0, 23),
      properties: props, entitySets: sets, uuid: et.NODE_UUID,
    };
  });
  // two entities that agree on the first 23 characters: the one whose name
  // fits keeps DEFINE_<name>, the other loses one more character
  // (ESH_SEARCH, documented on help.sap.com -- link in docs/segw-mapping.md: DEFINE_DATASOURCEACTIVATIONLOG and DEFINE_DATASOURCEACTIVATIONLO)
  const taken = new Set();
  for (const et of [...entityTypes].sort((a, b) => a.techName.length - b.techName.length)) {
    let stem = et.defineStem;
    while (taken.has(stem) && stem.length > 1) {
      stem = stem.slice(0, -1);
    }
    taken.add(stem);
    et.defineStem = stem;
  }
  for (const r of p.complexTypes) {
    byUuid.set(r.NODE_UUID, r);
  }
  const typeName = (uuid) => byUuid.get(uuid)?.NAME ?? "";
  const complexTypes = p.complexTypes.map((ct) => ({
    name: ct.NAME, techName: (ct.TECH_NAME || ct.NAME).toUpperCase(), uuid: ct.NODE_UUID, abapStruct: ct.ABAP_STRUCT ?? "",
    properties: p.properties.filter((pr) => pr.PARENT_UUID === ct.NODE_UUID)
      .sort((a, b) => Number(a.SORT_ORDER || 0) - Number(b.SORT_ORDER || 0))
      .map((pr) => ({name: pr.NAME, abapField: pr.ABAP_FIELD || pr.NAME.toUpperCase(), edmType: pr.EDM_CORE_TYPE, typeName: pr.TYPE_NAME ?? "",
        ...lengths(pr), isKey: false, semantics: pr.SEMANTICS ?? "",
        creatable: set(pr, "CREATABLE"), updatable: set(pr, "UPDATABLE"), sortable: set(pr, "SORTABLE"), nullable: set(pr, "IS_NULLABLE"), filterable: set(pr, "FILTERABLE")})),
  }));
  const associations = p.associations.map((a) => ({
    name: a.NAME, leftType: typeName(a.LEFT_END_GUID), rightType: typeName(a.RIGHT_END_GUID),
    leftCard: a.LEFT_END_CARD, rightCard: a.RIGHT_END_CARD, uuid: a.NODE_UUID,
    constraints: p.referentialConstraints.filter((rc) => rc.ASSOCIATION_GUID === a.NODE_UUID).map((rc) => ({
      principal: byUuid.get(rc.PRINCIPAL_PROP_R)?.NAME ?? rc.NAME, dependent: byUuid.get(rc.DEPENDENT_PROP_R)?.NAME ?? rc.NAME,
    })),
    sets: p.associationSets.filter((s) => s.ASSOCIATION_GUID === a.NODE_UUID).map((s) => ({
      name: s.NAME, leftSet: typeName(s.LEFT_END_GUID), rightSet: typeName(s.RIGHT_END_GUID),
    })),
  }));
  const navigation = p.navigationProperties.map((np) => ({
    name: np.NAME, abapField: np.TECH_NAME || np.NAME.toUpperCase(),
    entity: typeName(np.ENTITY_GUID), association: typeName(np.RELATION_GUID),
  }));
  // `|| undefined` and not `?? ""`: the pool falls back with `label ?? name`,
  // so an empty string would pool an empty text instead of the name. The
  // property path wants the opposite -- no label means no symbol at all --
  // which is why the two read the same tables and treat "absent" differently.
  const fiLabel = (uuid) => p.functionImportTexts.find((t2) => t2.NODE_UUID === uuid)?.FI_LABEL || undefined;
  const fpLabel = (uuid) => p.functionParameterTexts.find((t2) => t2.NODE_UUID === uuid)?.FI_PARAM_LABEL || undefined;
  const functionImports = p.functionImports.map((fi) => ({
    name: fi.NAME, label: fiLabel(fi.NODE_UUID), httpMethod: fi.HTTP_METHOD ?? "", returnCard: fi.RETURN_CARD ?? "",
    returnKind: fi.RETURN_TYPE_KIND, returnType: typeName(fi.RETURN_REF_TYPE), returnSet: typeName(fi.RETURN_ENTITYSET),
    actionFor: fi.ACTION_FOR ? typeName(fi.ACTION_FOR) : "",
    parameters: p.functionParameters.filter((fp) => fp.FUNCTION_IMPORT === fi.NODE_UUID).map((fp) => ({
      name: fp.NAME, label: fpLabel(fp.NODE_UUID), abapField: fp.ABAP_FIELD || fp.NAME.toUpperCase(), edmType: fp.EDM_CORE_TYPE,
      dataElement: fp.DATA_ELEMENT ?? "", maxLength: fp.MAX_LENGTH ?? "",
    })),
  }));
  return {
    project: p.project.PROJECT,
    service: p.service.TECHNICAL_NAME ?? "",
    // 1 = code based / mapped, 3 = annotation model, 4 = OData 4.0 strategy
    projectType: p.project.PROJECT_TYPE ?? "1",
    description: p.projectText.DESCRIPTION ?? "",
    // a model without VALUE_NS (EPM-RFC-SAMPLE) has no namespace, not "undefined"
    namespace: p.model.VALUE_NS ?? "",
    lastChanged: p.project.LAST_CHG_TIME ?? "",
    classes: {mpc, mpcExt: artifact("MPCS"), dpc: artifact("DPCB"), dpcExt: artifact("DPCS")},
    artifacts: p.artifacts,
    // EXT = "Redefine > OData service (GW)", APC = annotation provider over another service
    modelReferences: p.modelReferences.map((r) => ({name: r.NAME, refType: r.REF_TYPE, object: r.OBJECT_NAME, version: r.OBJECT_VERSION})),
    entityTypes, associations, navigation, functionImports, complexTypes,
    referenceDataSources: p.referenceDataSources.map((r) => ({name: r.NAME, type: r.RDS_TYPE})),
  };
}

// "Map to Data Source" on one operation: the mapping header under the
// operation node points at the data source; its property rows (MP) carry
// the OData property (or a constant) and the parameter path on the
// function module / search help; MR rows name the range components
function operationMapping(p, op) {
  const mh = p.mappings.find((x) => x.PARENT_UUID === op.NODE_UUID);
  const ds = mh && p.dataSources.find((d) => d.NODE_UUID === mh.DS_UUID);
  if (!ds || (ds.DS_TYPE !== "2" && ds.DS_TYPE !== "6")) {
    return undefined;
  }
  const props = p.propertyMappings.filter((mp) => mp.PARENT_UUID === mh.NODE_UUID).map((mp) => ({
    uuid: mp.NODE_UUID, property: mp.PROPERTY_PATH ?? "", direction: mp.DIRECTION, dsAttPath: mp.DS_ATT_PATH ?? "",
    constant: mp.CONSTANT_VAL === undefined ? undefined : mp.CONSTANT_VAL.replaceAll("&apos;", "'").replaceAll("&quot;", "\""),
  }));
  const ranges = p.mappingRanges.filter((mr) => props.some((mp) => mp.uuid === mr.NODE_UUID)).map((mr) => ({
    mpUuid: mr.NODE_UUID, component: mr.DS_ATT_PATH.split("\\").pop(), semantics: mr.SEMANTICS,
  }));
  if (ds.DS_TYPE === "2") {
    return {kind: "RFC", functionName: ds.FUNCTION_NAME ?? ds.NAME, functionGroup: ds.DS_GROUP ?? "", destination: ds.RFC_DEST ?? "", logAttr: ds.LOG_DS_ATTR ?? "", props, ranges};
  }
  return {kind: "SHLP", shlpName: ds.NAME, maxHitsAttr: ds.MAX_HITS_DS_ATTR ?? "", props, ranges};
}

// -------------------------------------------------------------- MPC source

const EDM_SETTER = {
  "Edm.String": "string", "Edm.DateTime": "datetime", "Edm.Guid": "guid", "Edm.Int16": "int16", "Edm.Int32": "int32",
  "Edm.Int64": "int64", "Edm.Decimal": "decimal", "Edm.Boolean": "boolean", "Edm.Time": "time", "Edm.Byte": "byte",
  "Edm.SByte": "sbyte", "Edm.Binary": "binary", "Edm.Double": "double", "Edm.Float": "float", "Edm.Single": "single",
  "Edm.DateTimeOffset": "datetimeoffset",
};
const ABAP_TYPE = {
  "Edm.String": "STRING", "Edm.Guid": "SYSUUID_X", "Edm.Int32": "I", "Edm.Int16": "I", "Edm.Boolean": "XSDBOOLEAN",
  "Edm.DateTime": "TIMESTAMP", "Edm.Decimal": "P LENGTH 16 DECIMALS 3", "Edm.Time": "TIMS",
};
// what SEGW declares for a property without a DDIC type (from the corpus:
// MindsetAppAnalyzerFree, abap-sap-tools); a TYPE_NAME in the tree wins
const ABAP_INLINE = {
  "Edm.String": "string", "Edm.Guid": "SYSUUID_X", "Edm.Int32": "i", "Edm.Int16": "/IWBEP/SB_ODATA_TY_INT2", "Edm.Boolean": "FLAG",
  "Edm.DateTime": "TIMESTAMP", "Edm.Decimal": "P LENGTH 16 DECIMALS 3", "Edm.Time": "TIMS", "Edm.Byte": "INT1",
};
// packed length in bytes for a number of digits: 2 digits per byte plus the sign
const packedLength = (digits) => Math.floor(Number(digits) / 2) + 1;
function inlineType(pr) {
  if (pr.typeName) {
    return pr.typeName;
  }
  if (pr.typeKind === "P" && pr.length) {
    return `p length ${packedLength(pr.length)} decimals ${pr.decimals || 0}`;
  }
  switch (pr.edmType) {
    case "Edm.String": return pr.maxLength ? `c length ${pr.maxLength}` : "string";
    case "Edm.Decimal": return `p length ${packedLength(pr.digits || 31)} decimals ${pr.scale || 0}`;
    case "Edm.Double": return "f";
    default: return ABAP_INLINE[pr.edmType] || "string";
  }
}
const ab = (b) => (b ? "abap_true" : "abap_false");

const MPC_BANNER = `*&---------------------------------------------------------------------*
*&           Generated code for the MODEL PROVIDER BASE CLASS         &*
*&                                                                     &*
*&  !!!NEVER MODIFY THIS CLASS. IN CASE YOU WANT TO CHANGE THE MODEL  &*
*&        DO THIS IN THE MODEL PROVIDER SUBCLASS!!!                   &*
*&                                                                     &*
*&---------------------------------------------------------------------*
`;
const STARS = "***********************************************************************************************************************************";

function propertyCode(pr, opts) {
  const lines = [];
  if (pr.complexType) {
    return `lo_complex_type = lo_entity_type->create_complex_property( iv_property_name = '${pr.name}'
                                                           iv_complex_type_name = '${pr.complexType}'
                                                           iv_abap_fieldname    = '${pr.abapField}' ). "#EC NOTEXT`;
  }
  lines.push(`lo_property = lo_entity_type->create_property( iv_property_name = '${pr.name}' iv_abap_fieldname = '${pr.abapField}' ). "#EC NOTEXT`);
  if (pr.isKey) {
    lines.push("lo_property->set_is_key( ).");
  }
  if (pr.textElement) {
    lines.push(`lo_property->set_label_from_text_element( iv_text_element_symbol = '${pr.textElement}' iv_text_element_container = gc_incl_name ).  "#EC NOTEXT`);
  }
  lines.push(`lo_property->set_type_edm_${EDM_SETTER[pr.edmType] ?? "string"}( ).`);
  if (pr.precision) {
    lines.push(`lo_property->set_precison( iv_precision = ${pr.precision} ). "#EC NOTEXT`);
  }
  if (pr.maxLength) {
    lines.push(`lo_property->set_maxlength( iv_max_length = ${pr.maxLength} ). "#EC NOTEXT`);
  }
  if (pr.semantics) {
    lines.push(`lo_property->set_semantic( '${pr.semantics}' ). "#EC NOTEXT`);
  }
  lines.push(`lo_property->set_creatable( ${ab(pr.creatable)} ).`);
  lines.push(`lo_property->set_updatable( ${ab(pr.updatable)} ).`);
  lines.push(`lo_property->set_sortable( ${ab(pr.sortable)} ).`);
  lines.push(`lo_property->set_nullable( ${ab(pr.nullable)} ).`);
  lines.push(`lo_property->set_filterable( ${ab(pr.filterable)} ).`);
  if (opts.unicodeAnnotation !== false) {
    lines.push(`lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'unicode'
        iv_value    = 'false' ).`);
  }
  if (pr.asEtag) {
    lines.push("lo_property->set_as_etag( ).");
  }
  // SEGW takes labels from the class's text elements (set_label_from_text_element);
  // without a text pool the label goes in as the sap:label annotation (stg-compile)
  if (opts.labelAnnotations && pr.label && !pr.textElement) {
    lines.push(`lo_property->/iwbep/if_mgw_odata_annotatabl~create_annotation( 'sap' )->add(
      EXPORTING
        iv_key      = 'label'
        iv_value    = '${pr.label.replaceAll("'", "''")}' ).`);
  }
  return lines.join("\n");
}

function defineEntityMethod(et, opts, mpcName) {
  let s = `  method DEFINE_${et.defineStem}.\n${MPC_BANNER}\n\n  data:
        lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                "#EC NEEDED
        lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                "#EC NEEDED
        lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,                "#EC NEEDED
        lo_property       type ref to /iwbep/if_mgw_odata_property,                  "#EC NEEDED
        lo_entity_set     type ref to /iwbep/if_mgw_odata_entity_set.                "#EC NEEDED

${STARS}
*   ENTITY - ${et.name}
${STARS}

lo_entity_type = model->create_entity_type( iv_entity_type_name = '${et.name}' iv_def_entity_set = abap_false ). "#EC NOTEXT
${et.isMedia ? `lo_entity_type->set_is_media( 'X' ).  "#EC NOTEXT\n` : ""}
${STARS}
*Properties
${STARS}

`;
  s += et.properties.map((pr) => propertyCode(pr, opts)).join("\n") + "\n";
  if (et.abapStruct) {
    s += `
lo_entity_type->bind_structure( iv_structure_name   = '${et.abapStruct}'
                                iv_bind_conversions = 'X' ). "#EC NOTEXT

`;
  } else {
    s += `
lo_entity_type->bind_structure( iv_structure_name  = '${mpcName}=>TS_${et.typeStem}' ). "#EC NOTEXT

`;
  }
  s += `
${STARS}
*   ENTITY SETS
${STARS}
`;
  for (const es of et.entitySets) {
    s += `lo_entity_set = lo_entity_type->create_entity_set( '${es.name}' ). "#EC NOTEXT

lo_entity_set->set_creatable( ${ab(es.creatable)} ).
lo_entity_set->set_updatable( ${ab(es.updatable)} ).
lo_entity_set->set_deletable( ${ab(es.deletable)} ).

lo_entity_set->set_pageable( ${ab(es.pageable)} ).
lo_entity_set->set_addressable( ${ab(es.addressable)} ).
lo_entity_set->set_has_ftxt_search( ${ab(es.searchable)} ).
lo_entity_set->set_subscribable( ${ab(es.subscribable)} ).
lo_entity_set->set_filter_required( ${ab(es.filterRequired)} ).
`;
  }
  s += "  endmethod.\n";
  return s;
}

function defineComplexTypesMethod(m, opts, mpcName) {
  let s = `  method DEFINE_COMPLEXTYPES.\n${MPC_BANNER}

 data:
       lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,             "#EC NEEDED
       lo_complex_type   type ref to /iwbep/if_mgw_odata_cmplx_type,             "#EC NEEDED
       lo_property       type ref to /iwbep/if_mgw_odata_property.                "#EC NEEDED
`;
  for (const ct of m.complexTypes) {
    s += `
${STARS}
*   COMPLEX TYPE - ${ct.name}
${STARS}

lo_complex_type = model->create_complex_type( '${ct.name}' ). "#EC NOTEXT

${STARS}
*Properties
${STARS}

`;
    for (const pr of ct.properties) {
      s += `lo_property = lo_complex_type->create_property( iv_property_name  = '${pr.name}' iv_abap_fieldname = '${pr.abapField}' ). "#EC NOTEXT
lo_property->set_type_edm_${EDM_SETTER[pr.edmType] ?? "string"}( ).
`;
      if (pr.precision) {
        s += `lo_property->set_precison( iv_precision = ${pr.precision} ). "#EC NOTEXT\n`;
      }
      if (pr.maxLength) {
        s += `lo_property->set_maxlength( iv_max_length = ${pr.maxLength} ).\n`;
      }
      if (pr.semantics) {
        s += `lo_property->set_semantic( '${pr.semantics}' ). "#EC NOTEXT\n`;
      }
      s += `lo_property->set_creatable( ${ab(pr.creatable)} ).
lo_property->set_updatable( ${ab(pr.updatable)} ).
lo_property->set_sortable( ${ab(pr.sortable)} ).
lo_property->set_nullable( ${ab(pr.nullable)} ).
lo_property->set_filterable( ${ab(pr.filterable)} ).
`;
    }
    s += ct.abapStruct
      ? `lo_complex_type->bind_structure( iv_structure_name   = '${ct.abapStruct}'
                                 iv_bind_conversions = 'X' ). "#EC NOTEXT\n`
      : `lo_complex_type->bind_structure( iv_structure_name = '${mpcName}=>${ct.name.toUpperCase()}' ). "#EC NOTEXT\n`;
  }
  s += "  endmethod.\n";
  return s;
}

function defineAssociationsMethod(m) {
  let s = `  method DEFINE_ASSOCIATIONS.\n${MPC_BANNER}



data:
lo_annotation     type ref to /iwbep/if_mgw_odata_annotation,                   "#EC NEEDED
lo_entity_type    type ref to /iwbep/if_mgw_odata_entity_typ,                   "#EC NEEDED
lo_association    type ref to /iwbep/if_mgw_odata_assoc,                        "#EC NEEDED
lo_ref_constraint type ref to /iwbep/if_mgw_odata_ref_constr,                   "#EC NEEDED
lo_assoc_set      type ref to /iwbep/if_mgw_odata_assoc_set,                    "#EC NEEDED
lo_nav_property   type ref to /iwbep/if_mgw_odata_nav_prop.                     "#EC NEEDED

${STARS}
*   ASSOCIATIONS
${STARS}

`;
  for (const a of m.associations) {
    s += ` lo_association = model->create_association(
                            iv_association_name = '${a.name}' "#EC NOTEXT
                            iv_left_type        = '${a.leftType}' "#EC NOTEXT
                            iv_right_type       = '${a.rightType}' "#EC NOTEXT
                            iv_right_card       = '${a.rightCard}' "#EC NOTEXT
                            iv_left_card        = '${a.leftCard}'  "#EC NOTEXT
                            iv_def_assoc_set    = ${ab(a.sets.length === 0)} ). "#EC NOTEXT
`;
    if (a.constraints.length > 0) {
      s += `* Referential constraint for association - ${a.name}\nlo_ref_constraint = lo_association->create_ref_constraint( ).\n`;
      for (const c of a.constraints) {
        s += `lo_ref_constraint->add_property( iv_principal_property = '${c.principal}'   iv_dependent_property = '${c.dependent}' ). "#EC NOTEXT\n`;
      }
    }
    for (const as of a.sets) {
      s += `lo_assoc_set = model->create_association_set( iv_association_set_name  = '${as.name}'                         "#EC NOTEXT
                                              iv_left_entity_set_name  = '${as.leftSet}'              "#EC NOTEXT
                                              iv_right_entity_set_name = '${as.rightSet}'             "#EC NOTEXT
                                              iv_association_name      = '${a.name}' ).                                 "#EC NOTEXT
`;
    }
    s += "\n";
  }
  s += `
${STARS}
*   NAVIGATION PROPERTIES
${STARS}
`;
  for (const et of m.entityTypes) {
    const navs = m.navigation.filter((n) => n.entity === et.name);
    if (navs.length === 0) {
      continue;
    }
    s += `\n* Navigation Properties for entity - ${et.name}\nlo_entity_type = model->get_entity_type( iv_entity_name = '${et.name}' ). "#EC NOTEXT\n`;
    for (const n of navs) {
      s += `lo_nav_property = lo_entity_type->create_navigation_property( iv_property_name  = '${n.name}' "#EC NOTEXT
                                                              iv_abap_fieldname = '${n.abapField}' "#EC NOTEXT
                                                              iv_association_name = '${n.association}' ). "#EC NOTEXT
`;
    }
  }
  s += "  endmethod.\n";
  return s;
}

// ABAP type names stop at 30 characters: TS_SALESORDER_GOODSISSUECREATE for
// the action SalesOrder_GoodsIssueCreated
const actionType = (fi) => `TS_${fi.name.toUpperCase()}`.slice(0, 30);
const actionParameterType = (fp) => fp.dataElement || ABAP_TYPE[fp.edmType] || "STRING";

function defineActionsMethod(m) {
  let s = `  method DEFINE_ACTIONS.\n${MPC_BANNER}


data:
lo_action         type ref to /iwbep/if_mgw_odata_action,                 "#EC NEEDED
lo_parameter      type ref to /iwbep/if_mgw_odata_parameter.              "#EC NEEDED
`;
  for (const fi of m.functionImports) {
    s += `
${STARS}
*   ACTION - ${fi.name}
${STARS}

lo_action = model->create_action( '${fi.name}' ).  "#EC NOTEXT
`;
    if (fi.textElement) {
      s += `lo_action->set_label_from_text_element( iv_text_element_symbol = '${fi.textElement}' iv_text_element_container = gc_incl_name ).  "#EC NOTEXT\n`;
    }
    if (fi.returnKind === "ETYP") {
      s += `*Set return entity type\nlo_action->set_return_entity_type( '${fi.returnType}' ). "#EC NOTEXT\n`;
    } else if (fi.returnKind === "CTYP") {
      s += `*Set return complex type\nlo_action->set_return_complex_type( '${fi.returnType}' ). "#EC NOTEXT\n`;
    }
    // a function import without an HTTP method in the tree gets no set_http_method line (ESH_SEARCH)
    if (fi.httpMethod) {
      s += `*Set HTTP method GET or POST\nlo_action->set_http_method( '${fi.httpMethod}' ). "#EC NOTEXT\n`;
    }
    // `set_action_for` BEFORE `set_return_multiplicity`, which is the order
    // SEGW itself writes -- read off ZCL_ZOSD_002_DEMO_MPC after SEGW
    // regenerated it from our own tree on A4H (2026-09-19). Nothing depends
    // on the order that we know of; the point is that the two generators
    // should be comparable line for line, and every difference that is not a
    // difference in meaning makes the comparison harder to read.
    if (fi.actionFor) {
      s += `*Set the action for entity\nlo_action->set_action_for( '${fi.actionFor}' ). "#EC NOTEXT\n`;
    }
    s += `* Set return type multiplicity\nlo_action->set_return_multiplicity( '${fi.returnCard}' ). "#EC NOTEXT\n`;
    if (fi.parameters.length > 0) {
      s += `${STARS}\n* Parameters\n${STARS}\n\n`;
      for (const fp of fi.parameters) {
        s += `lo_parameter = lo_action->create_input_parameter( iv_parameter_name = '${fp.name}'    iv_abap_fieldname = '${fp.abapField}' ). "#EC NOTEXT\n`;
        if (fp.textElement) {
          s += `lo_parameter->set_label_from_text_element( iv_text_element_symbol = '${fp.textElement}' iv_text_element_container = gc_incl_name ). "#EC NOTEXT\n`;
        }
        s += `lo_parameter->/iwbep/if_mgw_odata_property~set_type_edm_${EDM_SETTER[fp.edmType] ?? "string"}( ).\n`;
        if (fp.maxLength && fp.edmType === "Edm.String") {
          s += `lo_parameter->/iwbep/if_mgw_odata_property~set_maxlength( iv_max_length = ${fp.maxLength} ). "#EC NOTEXT\n`;
        }
      }
      s += `lo_action->bind_input_structure( iv_structure_name  = '${m.classes.mpc}=>${actionType(fi)}' ). "#EC NOTEXT\n`;
    }
  }
  s += "  endmethod.\n";
  return s;
}

export function mpcSource(m, opts = {}) {
  const cls = m.classes.mpc;
  const hasAssoc = m.associations.length > 0 || m.navigation.length > 0;
  const hasActions = m.functionImports.length > 0;
  const textElements = m.entityTypes.flatMap((et) => et.properties.filter((p) => p.textElement).map((p) => ({...p, entity: et.name})));

  // types: the first pair, then the text element types, then the rest
  const typeBlocks = [];
  for (const ct of m.complexTypes) {
    if (ct.abapStruct) {
      typeBlocks.push(`  types:\n     ${ct.name.toUpperCase()} type ${ct.abapStruct} .\n`);
      continue;
    }
    typeBlocks.push(`  types:\n        begin of ${ct.name.toUpperCase()},\n` +
      ct.properties.map((pr) => `        ${pr.abapField} type ${inlineType(pr)},\n`).join("") +
      `    end of ${ct.name.toUpperCase()} .\n`);
  }
  for (const fi of m.functionImports.filter((f) => f.parameters.length > 0)) {
    typeBlocks.push(`  types:\n    begin of ${actionType(fi)},\n` +
      fi.parameters.map((p) => `        ${p.abapField} type ${actionParameterType(p)},\n`).join("") +
      `    end of ${actionType(fi)} .\n`);
  }
  for (const et of m.entityTypes) {
    if (et.abapStruct) {
      typeBlocks.push(`  types:\n     TS_${et.typeStem} type ${et.abapStruct} .\n  types:\nTT_${et.typeStem} type standard table of TS_${et.typeStem} .\n`);
    } else {
      // no DDIC structure behind the entity: SEGW declares one from the properties
      typeBlocks.push(`  types:\n      begin of TS_${et.typeStem},\n` +
        et.properties.map((pr) => `     ${pr.abapField} type ${pr.complexType ? pr.complexType.toUpperCase() : inlineType(pr)},\n`).join("") +
        `  end of TS_${et.typeStem} .\n  types:\n    TT_${et.typeStem} type standard table of TS_${et.typeStem} .\n`);
    }
  }
  const textElementTypes = `  types:
   begin of ts_text_element,
      artifact_name  type c length 40,       " technical name
      artifact_type  type c length 4,
      parent_artifact_name type c length 40, " technical name
      parent_artifact_type type c length 4,
      text_symbol    type textpoolky,
   end of ts_text_element .
  types:
         tt_text_elements type standard table of ts_text_element with key text_symbol .
`;
  const types = [typeBlocks[0] ?? "", textElementTypes, ...typeBlocks.slice(1)].join("");

  let s = `class ${cls} definition
  public
  inheriting from /IWBEP/CL_MGW_PUSH_ABS_MODEL
  create public .

public section.

${types}
`;
  // one constant per entity and complex type; the class editor keeps them in alphabetical order
  const named = [...m.entityTypes.map((et) => ({tech: et.typeStem, name: et.name})), ...m.complexTypes.map((ct) => ({tech: ct.name.toUpperCase().slice(0, 27), name: ct.name}))];
  for (const c of named.sort((a, b) => a.tech.localeCompare(b.tech))) {
    s += `  constants GC_${c.tech} type /IWBEP/IF_MGW_MED_ODATA_TYPES=>TY_E_MED_ENTITY_NAME value '${c.name}' ##NO_TEXT.\n`;
  }
  s += `
  methods LOAD_TEXT_ELEMENTS
  final
    returning
      value(RT_TEXT_ELEMENTS) type TT_TEXT_ELEMENTS
    raising
      /IWBEP/CX_MGW_MED_EXCEPTION .

  methods DEFINE
    redefinition .
  methods GET_LAST_MODIFIED
    redefinition .
protected section.
private section.
`;
  if (textElements.length > 0 || m.functionImports.some((fi) => fi.textElement || fi.parameters.some((fp) => fp.textElement))) { // each names it
    s += `\n  constants GC_INCL_NAME type STRING value '${cls.padEnd(30, "=")}CP' ##NO_TEXT.\n`;
  }
  s += "\n";
  const hasComplex = m.complexTypes.length > 0;
  const privateMethods = [...(hasComplex ? ["DEFINE_COMPLEXTYPES"] : []), ...m.entityTypes.map((et) => `DEFINE_${et.defineStem}`), ...(hasAssoc ? ["DEFINE_ASSOCIATIONS"] : []), ...(hasActions ? ["DEFINE_ACTIONS"] : [])];
  for (const name of privateMethods) {
    s += `  methods ${name}\n    raising\n      /IWBEP/CX_MGW_MED_EXCEPTION .\n`;
  }
  s += `ENDCLASS.



CLASS ${cls} IMPLEMENTATION.


  method DEFINE.
${MPC_BANNER}${opts.superDefine ? "super->define( ).\n\n" : ""}
model->set_schema_namespace( '${m.namespace}' ).

`;
  if (hasComplex) {
    s += "define_complextypes( ).\n";
  }
  for (const et of m.entityTypes) {
    s += `define_${et.defineStem.toLowerCase()}( ).\n`;
  }
  if (hasAssoc) {
    s += "define_associations( ).\n";
  }
  if (hasActions) {
    s += "define_actions( ).\n";
  }
  s += "  endmethod.\n";

  // method implementations in alphabetical order, as the class editor keeps them
  const impls = {};
  if (hasActions) {
    impls.DEFINE_ACTIONS = defineActionsMethod(m);
  }
  if (hasAssoc) {
    impls.DEFINE_ASSOCIATIONS = defineAssociationsMethod(m);
  }
  if (hasComplex) {
    impls.DEFINE_COMPLEXTYPES = defineComplexTypesMethod(m, opts, cls);
  }
  for (const et of m.entityTypes) {
    impls[`DEFINE_${et.defineStem}`] = defineEntityMethod(et, opts, cls);
  }
  impls.GET_LAST_MODIFIED = `  method GET_LAST_MODIFIED.\n${MPC_BANNER}

  CONSTANTS: lc_gen_date_time TYPE timestamp VALUE '${opts.generatedAt ?? m.lastChanged.slice(0, 14)}'.                  "#EC NOTEXT
  rv_last_modified = super->get_last_modified( ).
  IF rv_last_modified LT lc_gen_date_time.
    rv_last_modified = lc_gen_date_time.
  ENDIF.
  endmethod.
`;
  let lte = `  method LOAD_TEXT_ELEMENTS.\n${MPC_BANNER}

DATA:
     ls_text_element TYPE ts_text_element.                                 "#EC NEEDED
`;
  if (textElements.length === 0) {
    lte += "CLEAR ls_text_element.\n";
  } else {
    lte += "\n\n";
    for (const t of textElements) {
      lte += `clear ls_text_element.
ls_text_element-artifact_name          = '${t.name}'.                 "#EC NOTEXT
ls_text_element-artifact_type          = 'PROP'.                                       "#EC NOTEXT
ls_text_element-parent_artifact_name   = '${t.entity}'.                            "#EC NOTEXT
ls_text_element-parent_artifact_type   = 'ETYP'.                                       "#EC NOTEXT
ls_text_element-text_symbol            = '${t.textElement}'.              "#EC NOTEXT
APPEND ls_text_element TO rt_text_elements.
`;
    }
  }
  lte += "  endmethod.\n";
  impls.LOAD_TEXT_ELEMENTS = lte;
  for (const name of Object.keys(impls).sort()) {
    s += "\n\n" + impls[name];
  }
  s += "ENDCLASS.\n";
  return s;
}

// ---------------------------------------------------------------- DPC source

function dpcHeader(include, m, opts, doubleSpace = false) {
  // the first line of SEGW's include banner has 94 dashes, the last 95; the
  // GET_ENTITY include has 95 in both and a doubled blank before "on"
  const first = "*&" + "-".repeat(doubleSpace ? 95 : 94) + "*";
  const last = "*&" + "-".repeat(95) + "*";
  return `${first}
*&  Include           ${include}
*&* This class has been generated ${doubleSpace ? " " : ""}on ${opts.generatedOn} in client ${opts.client}
*&*
*&*       WARNING--> NEVER MODIFY THIS CLASS <--WARNING
*&*   If you want to change the DPC implementation, use the
*&*   generated methods inside the DPC provider subclass - ${m.classes.dpcExt}
${last}
`;
}

const OP_SIGNATURES = {
  C: (m, et) => `    importing
      !IV_ENTITY_NAME type STRING
      !IV_ENTITY_SET_NAME type STRING
      !IV_SOURCE_NAME type STRING
      !IT_KEY_TAB type /IWBEP/T_MGW_NAME_VALUE_PAIR
      !IO_TECH_REQUEST_CONTEXT type ref to /IWBEP/IF_MGW_REQ_ENTITY_C optional
      !IT_NAVIGATION_PATH type /IWBEP/T_MGW_NAVIGATION_PATH
      !IO_DATA_PROVIDER type ref to /IWBEP/IF_MGW_ENTRY_PROVIDER optional
    exporting
      !ER_ENTITY type ${m.classes.mpc}=>TS_${et.typeStem}
    raising
      /IWBEP/CX_MGW_BUSI_EXCEPTION
      /IWBEP/CX_MGW_TECH_EXCEPTION .`,
  D: () => `    importing
      !IV_ENTITY_NAME type STRING
      !IV_ENTITY_SET_NAME type STRING
      !IV_SOURCE_NAME type STRING
      !IT_KEY_TAB type /IWBEP/T_MGW_NAME_VALUE_PAIR
      !IO_TECH_REQUEST_CONTEXT type ref to /IWBEP/IF_MGW_REQ_ENTITY_D optional
      !IT_NAVIGATION_PATH type /IWBEP/T_MGW_NAVIGATION_PATH
    raising
      /IWBEP/CX_MGW_BUSI_EXCEPTION
      /IWBEP/CX_MGW_TECH_EXCEPTION .`,
  R: (m, et) => `    importing
      !IV_ENTITY_NAME type STRING
      !IV_ENTITY_SET_NAME type STRING
      !IV_SOURCE_NAME type STRING
      !IT_KEY_TAB type /IWBEP/T_MGW_NAME_VALUE_PAIR
      !IO_REQUEST_OBJECT type ref to /IWBEP/IF_MGW_REQ_ENTITY optional
      !IO_TECH_REQUEST_CONTEXT type ref to /IWBEP/IF_MGW_REQ_ENTITY optional
      !IT_NAVIGATION_PATH type /IWBEP/T_MGW_NAVIGATION_PATH
    exporting
      !ER_ENTITY type ${m.classes.mpc}=>TS_${et.typeStem}
      !ES_RESPONSE_CONTEXT type /IWBEP/IF_MGW_APPL_SRV_RUNTIME=>TY_S_MGW_RESPONSE_ENTITY_CNTXT
    raising
      /IWBEP/CX_MGW_BUSI_EXCEPTION
      /IWBEP/CX_MGW_TECH_EXCEPTION .`,
  Q: (m, et) => `    importing
      !IV_ENTITY_NAME type STRING
      !IV_ENTITY_SET_NAME type STRING
      !IV_SOURCE_NAME type STRING
      !IT_FILTER_SELECT_OPTIONS type /IWBEP/T_MGW_SELECT_OPTION
      !IS_PAGING type /IWBEP/S_MGW_PAGING
      !IT_KEY_TAB type /IWBEP/T_MGW_NAME_VALUE_PAIR
      !IT_NAVIGATION_PATH type /IWBEP/T_MGW_NAVIGATION_PATH
      !IT_ORDER type /IWBEP/T_MGW_SORTING_ORDER
      !IV_FILTER_STRING type STRING
      !IV_SEARCH_STRING type STRING
      !IO_TECH_REQUEST_CONTEXT type ref to /IWBEP/IF_MGW_REQ_ENTITYSET optional
    exporting
      !ET_ENTITYSET type ${m.classes.mpc}=>TT_${et.typeStem}
      !ES_RESPONSE_CONTEXT type /IWBEP/IF_MGW_APPL_SRV_RUNTIME=>TY_S_MGW_RESPONSE_CONTEXT
    raising
      /IWBEP/CX_MGW_BUSI_EXCEPTION
      /IWBEP/CX_MGW_TECH_EXCEPTION .`,
  U: (m, et) => `    importing
      !IV_ENTITY_NAME type STRING
      !IV_ENTITY_SET_NAME type STRING
      !IV_SOURCE_NAME type STRING
      !IT_KEY_TAB type /IWBEP/T_MGW_NAME_VALUE_PAIR
      !IO_TECH_REQUEST_CONTEXT type ref to /IWBEP/IF_MGW_REQ_ENTITY_U optional
      !IT_NAVIGATION_PATH type /IWBEP/T_MGW_NAVIGATION_PATH
      !IO_DATA_PROVIDER type ref to /IWBEP/IF_MGW_ENTRY_PROVIDER optional
    exporting
      !ER_ENTITY type ${m.classes.mpc}=>TS_${et.typeStem}
    raising
      /IWBEP/CX_MGW_BUSI_EXCEPTION
      /IWBEP/CX_MGW_TECH_EXCEPTION .`,
};

// every entity set operation of the model, with its entity type
function operations(m) {
  const out = [];
  for (const et of m.entityTypes) {
    for (const es of et.entitySets) {
      for (const op of es.operations) {
        out.push({...op, set: es, entity: et});
      }
    }
  }
  return out;
}

function dispatch(kind, m, opts) {
  const mpc = m.classes.mpc.toLowerCase();
  const ops = operations(m).filter((o) => o.type === kind);
  const lower = (o) => o.method.toLowerCase();
  const decls = ops.map((o) => ` DATA ${lower(o)} TYPE ${mpc}=>${kind === "Q" ? "tt" : "ts"}_${o.entity.typeStem.toLowerCase()}.\n`).join("");
  switch (kind) {
    case "C": return `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~CREATE_ENTITY.
${dpcHeader("/IWBEP/DPC_TEMP_CRT_ENTITY_BASE", m, opts)}
${decls} DATA lv_entityset_name TYPE string.

lv_entityset_name = io_tech_request_context->get_entity_set_name( ).

CASE lv_entityset_name.
${ops.map((o) => `*-------------------------------------------------------------------------*
*             EntitySet -  ${o.set.name}
*-------------------------------------------------------------------------*
     WHEN '${o.set.name}'.
*     Call the entity set generated method
    ${lower(o)}(
         EXPORTING iv_entity_name     = iv_entity_name
                   iv_entity_set_name = iv_entity_set_name
                   iv_source_name     = iv_source_name
                   io_data_provider   = io_data_provider
                   it_key_tab         = it_key_tab
                   it_navigation_path = it_navigation_path
                   io_tech_request_context = io_tech_request_context
       \t IMPORTING er_entity          = ${lower(o)}
    ).
*     Send specific entity data to the caller interfaces
    copy_data_to_ref(
      EXPORTING
        is_data = ${lower(o)}
      CHANGING
        cr_data = er_entity
   ).

`).join("")}  when others.
    super->/iwbep/if_mgw_appl_srv_runtime~create_entity(
       EXPORTING
         iv_entity_name = iv_entity_name
         iv_entity_set_name = iv_entity_set_name
         iv_source_name = iv_source_name
         io_data_provider   = io_data_provider
         it_key_tab = it_key_tab
         it_navigation_path = it_navigation_path
      IMPORTING
        er_entity = er_entity
  ).
ENDCASE.
  endmethod.
`;
    case "D": return `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~DELETE_ENTITY.
${dpcHeader("/IWBEP/DPC_TEMP_DEL_ENTITY_BASE", m, opts)}
 DATA lv_entityset_name TYPE string.

lv_entityset_name = io_tech_request_context->get_entity_set_name( ).

CASE lv_entityset_name.
${ops.map((o) => `*-------------------------------------------------------------------------*
*             EntitySet -  ${o.set.name}
*-------------------------------------------------------------------------*
      when '${o.set.name}'.
*     Call the entity set generated method
     ${lower(o)}(
          EXPORTING iv_entity_name     = iv_entity_name
                    iv_entity_set_name = iv_entity_set_name
                    iv_source_name     = iv_source_name
                    it_key_tab         = it_key_tab
                    it_navigation_path = it_navigation_path
                    io_tech_request_context = io_tech_request_context
     ).

`).join("")}   when others.
     super->/iwbep/if_mgw_appl_srv_runtime~delete_entity(
        EXPORTING
          iv_entity_name = iv_entity_name
          iv_entity_set_name = iv_entity_set_name
          iv_source_name = iv_source_name
          it_key_tab = it_key_tab
          it_navigation_path = it_navigation_path
 ).
 ENDCASE.
  endmethod.
`;
    case "R": return `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_ENTITY.
${dpcHeader("/IWBEP/DPC_TEMP_GETENTITY_BASE", m, opts, true)}
${decls} DATA lv_entityset_name TYPE string.
 DATA lr_entity TYPE REF TO data.       "#EC NEEDED

lv_entityset_name = io_tech_request_context->get_entity_set_name( ).

CASE lv_entityset_name.
${ops.map((o) => `*-------------------------------------------------------------------------*
*             EntitySet -  ${o.set.name}
*-------------------------------------------------------------------------*
      WHEN '${o.set.name}'.
*     Call the entity set generated method
          ${lower(o)}(
               EXPORTING iv_entity_name     = iv_entity_name
                         iv_entity_set_name = iv_entity_set_name
                         iv_source_name     = iv_source_name
                         it_key_tab         = it_key_tab
                         it_navigation_path = it_navigation_path
                         io_tech_request_context = io_tech_request_context
             \t IMPORTING er_entity          = ${lower(o)}
                         es_response_context = es_response_context
          ).

        IF ${lower(o)} IS NOT INITIAL.
*     Send specific entity data to the caller interface
          copy_data_to_ref(
            EXPORTING
              is_data = ${lower(o)}
            CHANGING
              cr_data = er_entity
          ).
        ELSE.
*         In case of initial values - unbind the entity reference
          er_entity = lr_entity.
        ENDIF.
`).join("")}
      WHEN OTHERS.
        super->/iwbep/if_mgw_appl_srv_runtime~get_entity(
           EXPORTING
             iv_entity_name = iv_entity_name
             iv_entity_set_name = iv_entity_set_name
             iv_source_name = iv_source_name
             it_key_tab = it_key_tab
             it_navigation_path = it_navigation_path
          IMPORTING
            er_entity = er_entity
    ).
 ENDCASE.
  endmethod.
`;
    case "Q": return `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_ENTITYSET.
${dpcHeader("/IWBEP/DPC_TMP_ENTITYSET_BASE", m, opts)}${decls} DATA lv_entityset_name TYPE string.

lv_entityset_name = io_tech_request_context->get_entity_set_name( ).

CASE lv_entityset_name.
${ops.map((o) => `*-------------------------------------------------------------------------*
*             EntitySet -  ${o.set.name}
*-------------------------------------------------------------------------*
   WHEN '${o.set.name}'.
*     Call the entity set generated method
      ${lower(o)}(
        EXPORTING
         iv_entity_name = iv_entity_name
         iv_entity_set_name = iv_entity_set_name
         iv_source_name = iv_source_name
         it_filter_select_options = it_filter_select_options
         it_order = it_order
         is_paging = is_paging
         it_navigation_path = it_navigation_path
         it_key_tab = it_key_tab
         iv_filter_string = iv_filter_string
         iv_search_string = iv_search_string
         io_tech_request_context = io_tech_request_context
       IMPORTING
         et_entityset = ${lower(o)}
         es_response_context = es_response_context
       ).
*     Send specific entity data to the caller interface
      copy_data_to_ref(
        EXPORTING
          is_data = ${lower(o)}
        CHANGING
          cr_data = er_entityset
      ).

`).join("")}    WHEN OTHERS.
      super->/iwbep/if_mgw_appl_srv_runtime~get_entityset(
        EXPORTING
          iv_entity_name = iv_entity_name
          iv_entity_set_name = iv_entity_set_name
          iv_source_name = iv_source_name
          it_filter_select_options = it_filter_select_options
          it_order = it_order
          is_paging = is_paging
          it_navigation_path = it_navigation_path
          it_key_tab = it_key_tab
          iv_filter_string = iv_filter_string
          iv_search_string = iv_search_string
          io_tech_request_context = io_tech_request_context
       IMPORTING
         er_entityset = er_entityset ).
 ENDCASE.
  endmethod.
`;
    case "U": return `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~UPDATE_ENTITY.
${dpcHeader("/IWBEP/DPC_TEMP_UPD_ENTITY_BASE", m, opts)}
${decls} DATA lv_entityset_name TYPE string.
 DATA lr_entity TYPE REF TO data. "#EC NEEDED

lv_entityset_name = io_tech_request_context->get_entity_set_name( ).

CASE lv_entityset_name.
${ops.map((o) => `*-------------------------------------------------------------------------*
*             EntitySet -  ${o.set.name}
*-------------------------------------------------------------------------*
      WHEN '${o.set.name}'.
*     Call the entity set generated method
          ${lower(o)}(
               EXPORTING iv_entity_name     = iv_entity_name
                         iv_entity_set_name = iv_entity_set_name
                         iv_source_name     = iv_source_name
                         io_data_provider   = io_data_provider
                         it_key_tab         = it_key_tab
                         it_navigation_path = it_navigation_path
                         io_tech_request_context = io_tech_request_context
             \t IMPORTING er_entity          = ${lower(o)}
          ).
       IF ${lower(o)} IS NOT INITIAL.
*     Send specific entity data to the caller interface
          copy_data_to_ref(
            EXPORTING
              is_data = ${lower(o)}
            CHANGING
              cr_data = er_entity
          ).
        ELSE.
*         In case of initial values - unbind the entity reference
          er_entity = lr_entity.
        ENDIF.
`).join("")}      WHEN OTHERS.
        super->/iwbep/if_mgw_appl_srv_runtime~update_entity(
           EXPORTING
             iv_entity_name = iv_entity_name
             iv_entity_set_name = iv_entity_set_name
             iv_source_name = iv_source_name
             io_data_provider   = io_data_provider
             it_key_tab = it_key_tab
             it_navigation_path = it_navigation_path
          IMPORTING
            er_entity = er_entity
    ).
 ENDCASE.
  endmethod.
`;
    default: throw new Error("dispatch " + kind);
  }
}

const COMM_SERVICES = `  method /IWBEP/IF_SB_DPC_COMM_SERVICES~COMMIT_WORK.
* Call RFC commit work functionality
DATA lt_message      TYPE bapiret2. "#EC NEEDED
DATA lv_message_text TYPE BAPI_MSG.
DATA lo_logger       TYPE REF TO /iwbep/cl_cos_logger.
DATA lv_subrc        TYPE syst-subrc.

lo_logger = /iwbep/if_mgw_conv_srv_runtime~get_logger( ).

  IF iv_rfc_dest IS INITIAL OR iv_rfc_dest EQ 'NONE'.
    CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
      EXPORTING
      wait   = abap_true
    IMPORTING
      return = lt_message.
  ELSE.
    CALL FUNCTION 'BAPI_TRANSACTION_COMMIT'
      DESTINATION iv_rfc_dest
    EXPORTING
      wait                  = abap_true
    IMPORTING
      return                = lt_message
    EXCEPTIONS
      communication_failure = 1000 MESSAGE lv_message_text
      system_failure        = 1001 MESSAGE lv_message_text
      OTHERS                = 1002.

  IF sy-subrc <> 0.
    lv_subrc = sy-subrc.
    /iwbep/cl_sb_gen_dpc_rt_util=>rfc_exception_handling(
        EXPORTING
          iv_subrc            = lv_subrc
          iv_exp_message_text = lv_message_text
          io_logger           = lo_logger ).
  ENDIF.
  ENDIF.
  endmethod.


  method /IWBEP/IF_SB_DPC_COMM_SERVICES~GET_GENERATION_STRATEGY.
* Get generation strategy
  rv_generation_strategy = '1'.
  endmethod.


  method /IWBEP/IF_SB_DPC_COMM_SERVICES~LOG_MESSAGE.
* Log message in the application log
DATA lo_logger TYPE REF TO /iwbep/cl_cos_logger.
DATA lv_text TYPE /iwbep/sup_msg_longtext.

  MESSAGE ID iv_msg_id TYPE iv_msg_type NUMBER iv_msg_number
    WITH iv_msg_v1 iv_msg_v2 iv_msg_v3 iv_msg_v4 INTO lv_text.

  lo_logger = mo_context->get_logger( ).
  lo_logger->log_message(
    EXPORTING
     iv_msg_type   = iv_msg_type
     iv_msg_id     = iv_msg_id
     iv_msg_number = iv_msg_number
     iv_msg_text   = lv_text
     iv_msg_v1     = iv_msg_v1
     iv_msg_v2     = iv_msg_v2
     iv_msg_v3     = iv_msg_v3
     iv_msg_v4     = iv_msg_v4
     iv_agent      = 'DPC' ).
  endmethod.


  method /IWBEP/IF_SB_DPC_COMM_SERVICES~RFC_EXCEPTION_HANDLING.
* RFC call exception handling
DATA lo_logger  TYPE REF TO /iwbep/cl_cos_logger.

lo_logger = /iwbep/if_mgw_conv_srv_runtime~get_logger( ).

/iwbep/cl_sb_gen_dpc_rt_util=>rfc_exception_handling(
  EXPORTING
    iv_subrc            = iv_subrc
    iv_exp_message_text = iv_exp_message_text
    io_logger           = lo_logger ).
  endmethod.


  method /IWBEP/IF_SB_DPC_COMM_SERVICES~RFC_SAVE_LOG.
  DATA lo_logger  TYPE REF TO /iwbep/cl_cos_logger.
  DATA lo_message_container TYPE REF TO /iwbep/if_message_container.

  lo_logger = /iwbep/if_mgw_conv_srv_runtime~get_logger( ).
  lo_message_container = /iwbep/if_mgw_conv_srv_runtime~get_message_container( ).

  " Save the RFC call log in the application log
  /iwbep/cl_sb_gen_dpc_rt_util=>rfc_save_log(
    EXPORTING
      is_return            = is_return
      iv_entity_type       = iv_entity_type
      it_return            = it_return
      it_key_tab           = it_key_tab
      io_logger            = lo_logger
      io_message_container = lo_message_container ).
  endmethod.


  method /IWBEP/IF_SB_DPC_COMM_SERVICES~SET_INJECTION.
* Unit test injection
  IF io_unit IS BOUND.
    mo_injection = io_unit.
  ELSE.
    mo_injection = me.
  ENDIF.
  endmethod.


  method CHECK_SUBSCRIPTION_AUTHORITY.
  RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
    EXPORTING
      textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
      method = 'CHECK_SUBSCRIPTION_AUTHORITY'.
  endmethod.
`;

const SADL_DELEGATION = {
  C: `    if_sadl_gw_dpc_util~get_dpc( )->create_entity( EXPORTING io_data_provider        = io_data_provider
                                                             io_tech_request_context = io_tech_request_context
                                                   IMPORTING es_data                 = er_entity ).`,
  D: `    if_sadl_gw_dpc_util~get_dpc( )->delete_entity( io_tech_request_context ).`,
  R: `    if_sadl_gw_dpc_util~get_dpc( )->get_entity( EXPORTING io_tech_request_context = io_tech_request_context
                                                IMPORTING es_data                 = er_entity ).`,
  Q: `    if_sadl_gw_dpc_util~get_dpc( )->get_entityset( EXPORTING io_tech_request_context = io_tech_request_context
                                                   IMPORTING et_data                 = et_entityset
                                                             es_response_context     = es_response_context ).`,
  U: `    if_sadl_gw_dpc_util~get_dpc( )->update_entity( EXPORTING io_tech_request_context = io_tech_request_context
                                                             io_data_provider        = io_data_provider
                                                   IMPORTING es_data                 = er_entity ).`,
};

// steamgate's local ODC: the operation is served by another service of
// the registry through zcl_stg_odata_client (reads only; writes stay stubs)
function odcMethod(o, m) {
  const head = `  method ${o.method}.
    DATA lo_client TYPE REF TO zcl_stg_odata_client.

* served by ${o.set.sadl.service}/${o.set.sadl.set}, another service of this registry
    CREATE OBJECT lo_client
      EXPORTING
        iv_service    = '${o.set.sadl.service}'
        iv_entity_set = '${o.set.sadl.set}'.
`;
  if (o.type === "Q") {
    return head + `    lo_client->get_entityset(
      EXPORTING
        io_tech_request_context = io_tech_request_context
        iv_local_service        = '${m.service}'
        iv_local_set            = iv_entity_set_name
      IMPORTING
        et_entityset            = et_entityset
        es_response_context     = es_response_context ).
  endmethod.
`;
  }
  if (o.type === "R") {
    return head + `    lo_client->get_entity(
      EXPORTING
        it_key_tab       = it_key_tab
        iv_local_service = '${m.service}'
        iv_local_set     = iv_entity_set_name
      IMPORTING
        es_entity        = er_entity ).
  endmethod.
`;
  }
  return "";
}

function sadlMethods(m, opts) {
  const sets = m.entityTypes.flatMap((et) => et.entitySets.filter((es) => es.sadl && es.sadl.type !== "ODC").map((es) => ({...es, entity: et})));
  // a where-used reference to the DDIC object behind each set; an EPM
  // business object node is not a DDIC type, so it gets none
  const refs = sets.filter((es) => es.sadl.type !== "EPM").map((es, i) => `    TYPES ty_${es.sadl.binding.replace(/\//g, "/")}_${i + 1} TYPE ${es.sadl.binding.toLowerCase()} ##NEEDED. " reference for where-used list`);
  const dataSources = sets.map((es) => `               | <sadl:dataSource type="${es.sadl.type}" name="${es.name}" binding="${es.sadl.binding}" />| &`);
  const structureLines = [...sets].reverse().flatMap((es) => [
    // maxEditMode follows what the tree says the set allows: EPM-CDS-SAMPLE has
    // CDS sources, writable EmployeeSet/LeaveRequestSet and EX; every
    // read-only project in the corpus has RO.
    `               |<sadl:structure name="${es.name}" dataSource="${es.name}" maxEditMode="${es.creatable || es.updatable || es.deletable ? "EX" : "RO"}" >| &`,
    `               | <sadl:query name="EntitySetDefault">| &`,
    `               | </sadl:query>| &`,
    ...es.entity.properties.map((pr) => `               | <sadl:attribute name="${pr.abapField}" binding="${pr.abapField}" isOutput="TRUE" isKey="${pr.isKey ? "TRUE" : "FALSE"}" />| &`),
    `               |</sadl:structure>| &`,
  ]);
  const structures = structureLines.join("\n");
  // SEGW writes the whole definition as one & chain, and the generator now
  // writes it the same way. It used to be built in pieces of 200 lines,
  // because the transpiler nested such a chain one concat( ) call per operand
  // and a service worker's stack gave out near 800 (ZSTG_SEGW: 55 sets).
  // abaplint/transpiler#1836 flattens the whole chain into one call, released
  // in 2.13.87; measured here at 1200 operands, one concat( ) call, no
  // recursion left to run out of. ANORMALIES: transpiler-concat-chain.
  const sadlXml = `    DATA(lv_sadl_xml) =
               |<?xml version="1.0" encoding="utf-16"?>| &
               |<sadl:definition xmlns:sadl="http://sap.com/sap.nw.f.sadl" syntaxVersion="V2" >| &
${dataSources.join("\n")}
               |<sadl:resultSet>| &
${structures}
               |</sadl:resultSet>| &
               |</sadl:definition>| .`;
  return {
    "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~CREATE_DEEP_ENTITY": `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~CREATE_DEEP_ENTITY.
    CAST /iwbep/if_mgw_appl_srv_runtime( if_sadl_gw_dpc_util~get_dpc( ) )->create_deep_entity(
                   EXPORTING io_tech_request_context = io_tech_request_context
                             io_data_provider        = io_data_provider
                             io_expand               = io_expand
                   IMPORTING er_deep_entity          = er_deep_entity ).
  endmethod.
`,
    "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~EXECUTE_ACTION": `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~EXECUTE_ACTION.
    if_sadl_gw_dpc_util~get_dpc( )->execute_action( EXPORTING io_tech_request_context = io_tech_request_context
                                                    IMPORTING er_data                 = er_data ).
  endmethod.
`,
    "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_IS_CONDITIONAL_IMPLEMENTED": `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_IS_CONDITIONAL_IMPLEMENTED.
    TRY.
        rv_conditional_active = if_sadl_gw_dpc_util~get_dpc( )->get_is_conditional_implemented(
                                               iv_operation_type  = iv_operation_type
                                               iv_entity_set_name = iv_entity_set_name ).
      CATCH /iwbep/cx_mgw_tech_exception /iwbep/cx_mgw_busi_exception.
        rv_conditional_active = super->/iwbep/if_mgw_appl_srv_runtime~get_is_conditional_implemented(
                                       iv_operation_type     = iv_operation_type
                                       iv_entity_set_name    = iv_entity_set_name ).
    ENDTRY.
  endmethod.
`,
    "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_IS_CONDI_IMPLE_FOR_ACTION": `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~GET_IS_CONDI_IMPLE_FOR_ACTION.
    TRY.
        rv_conditional_active = if_sadl_gw_dpc_util~get_dpc( )->get_is_condi_imple_for_action( iv_action_name ).
      CATCH /iwbep/cx_mgw_tech_exception /iwbep/cx_mgw_busi_exception.
        rv_conditional_active = super->/iwbep/if_mgw_appl_srv_runtime~get_is_condi_imple_for_action( iv_action_name ).
    ENDTRY.
  endmethod.
`,
    "/IWBEP/IF_MGW_APPL_SRV_RUNTIME~PATCH_ENTITY": `  method /IWBEP/IF_MGW_APPL_SRV_RUNTIME~PATCH_ENTITY.
        super->/iwbep/if_mgw_appl_srv_runtime~patch_entity(
                       EXPORTING io_tech_request_context = io_tech_request_context
                                 io_data_provider        = io_data_provider
                                 iv_entity_name          = iv_entity_name
                                 iv_entity_set_name      = iv_entity_set_name
                                 iv_source_name          = iv_source_name
                                 it_key_tab              = it_key_tab
                                 it_navigation_path      = it_navigation_path
                       IMPORTING er_entity               = er_entity  ).
  endmethod.
`,
    "IF_SADL_GW_DPC_UTIL~GET_DPC": `  method IF_SADL_GW_DPC_UTIL~GET_DPC.
${refs.join("\n")}

${sadlXml}
    ro_dpc = cl_sadl_gw_dpc_factory=>create_for_sadl( iv_sadl_xml   = lv_sadl_xml
               iv_timestamp         = ${opts.generatedAt}
               iv_uuid              = '${m.project}'
               io_query_control     = me
               io_extension_control = me
               io_context           = me->mo_context ).
  endmethod.
`,
    "IF_SADL_GW_EXTENSION_CONTROL~SET_EXTENSION_MAPPING": `  method IF_SADL_GW_EXTENSION_CONTROL~SET_EXTENSION_MAPPING.
" Intended to be overwritten
RETURN.
  endmethod.
`,
    "IF_SADL_GW_QUERY_CONTROL~SET_QUERY_OPTIONS": `  method IF_SADL_GW_QUERY_CONTROL~SET_QUERY_OPTIONS.
" Intended to be overwritten
RETURN.
  endmethod.
`,
  };
}

export function dpcSource(m, opts = {}) {
  const cls = m.classes.dpc;
  const ops = operations(m);
  const kinds = [...new Set(ops.map((o) => o.type))];
  const isSadl = (es) => es.sadl && es.sadl.type !== "ODC";
  const hasSadl = m.entityTypes.some((et) => et.entitySets.some(isSadl));
  const hasShlp = ops.some((o) => o.mapping?.kind === "SHLP");
  const redefs = [["Q", "GET_ENTITYSET"], ["R", "GET_ENTITY"], ["U", "UPDATE_ENTITY"], ["C", "CREATE_ENTITY"], ["D", "DELETE_ENTITY"]].filter(([k]) => kinds.includes(k)).map(([, n]) => n);
  if (hasSadl) {
    redefs.push("CREATE_DEEP_ENTITY", "EXECUTE_ACTION", "GET_IS_CONDITIONAL_IMPLEMENTED", "GET_IS_CONDI_IMPLE_FOR_ACTION", "PATCH_ENTITY");
  }
  let s = `class ${cls} definition
  public
  inheriting from /IWBEP/CL_MGW_PUSH_ABS_DATA
  abstract
  create public .

public section.

  interfaces /IWBEP/IF_SB_DPC_COMM_SERVICES .
${hasShlp ? `  interfaces ${SHLP_INTERFACE} .\n` : ""}  interfaces /IWBEP/IF_SB_GEN_DPC_INJECTION .
${hasSadl ? "  interfaces IF_SADL_GW_DPC_UTIL .\n  interfaces IF_SADL_GW_EXTENSION_CONTROL .\n  interfaces IF_SADL_GW_QUERY_CONTROL .\n" : ""}
`;
  for (const name of redefs) {
    s += `  methods /IWBEP/IF_MGW_APPL_SRV_RUNTIME~${name}\n    redefinition .\n`;
  }
  s += `protected section.

  data mo_injection type ref to /IWBEP/IF_SB_GEN_DPC_INJECTION .

`;
  const sorted = [...ops].sort((a, b) => a.method.localeCompare(b.method));
  for (const o of sorted) {
    s += `  methods ${o.method}\n${OP_SIGNATURES[o.type](m, o.entity)}\n`;
  }
  s += `
  methods CHECK_SUBSCRIPTION_AUTHORITY
    redefinition .
private section.
ENDCLASS.



CLASS ${cls} IMPLEMENTATION.

`;
  // the class editor keeps the implementations in alphabetical order of
  // the method name (interface methods sort under their interface)
  const impls = {};
  const dispatchName = {C: "CREATE_ENTITY", D: "DELETE_ENTITY", R: "GET_ENTITY", Q: "GET_ENTITYSET", U: "UPDATE_ENTITY"};
  for (const k of ["C", "D", "R", "Q", "U"]) {
    if (kinds.includes(k)) {
      impls[`/IWBEP/IF_MGW_APPL_SRV_RUNTIME~${dispatchName[k]}`] = dispatch(k, m, opts);
    }
  }
  for (const block of COMM_SERVICES.split(/\n\n\n(?=  method )/)) {
    impls[/^  method ([^.]+)\./.exec(block)[1]] = block.endsWith("\n") ? block : block + "\n";
  }
  if (hasSadl) {
    Object.assign(impls, sadlMethods(m, opts));
  }
  if (hasShlp) {
    impls[`${SHLP_INTERFACE}~GET_SEARCH_HELP_VALUES`] = SHLP_IMPLEMENTATION;
  }
  const stub = (o, comment = "") => `  method ${o.method}.
${comment}  RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
    EXPORTING
      textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
      method = '${o.method}'.
  endmethod.
`;
  for (const o of sorted) {
    if (o.mapping?.kind === "RFC") {
      const body = rfcMethod(o, m, opts);
      if (body === "") {
        opts.warnings?.push(`${o.method}: mapped to function module ${o.mapping.functionName}, whose signature is not in any function group given with --lib; left as a stub`);
        impls[o.method] = stub(o, `* Mapped to ${o.mapping.functionName}: the function group was not available when this class was generated\n`);
      } else {
        impls[o.method] = body;
      }
    } else if (o.mapping?.kind === "SHLP") {
      impls[o.method] = shlpMethod(o, m) || stub(o);
    } else if (o.set.sadl?.type === "ODC") {
      impls[o.method] = odcMethod(o, m) || stub(o);
    } else if (o.set.sadl) {
      impls[o.method] = `  method ${o.method}.\n${SADL_DELEGATION[o.type]}\n  endmethod.\n`;
    } else {
      impls[o.method] = stub(o);
    }
  }
  s += "\n" + Object.keys(impls).sort().map((k) => impls[k]).join("\n\n");
  s += "ENDCLASS.\n";
  return s;
}

// ------------------------------------------------------------------ XML

const BOM = "\ufeff";
function clasXml(name, description, components = [], subs = [], tpool = []) {
  let s = `${BOM}<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_CLAS" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <VSEOCLASS>
    <CLSNAME>${name}</CLSNAME>
    <LANGU>E</LANGU>
    <DESCRIPT>${description}</DESCRIPT>
    <STATE>1</STATE>
    <CLSCCINCL>X</CLSCCINCL>
    <FIXPT>X</FIXPT>
    <UNICODE>X</UNICODE>
   </VSEOCLASS>
`;
  if (components.length > 0) {
    s += "   <DESCRIPTIONS>\n" + components.map(([c, d]) => `    <SEOCOMPOTX>
     <CMPNAME>${c}</CMPNAME>
     <LANGU>E</LANGU>
     <DESCRIPT>${d}</DESCRIPT>
    </SEOCOMPOTX>
`).join("") + "   </DESCRIPTIONS>\n";
  }
  if (subs.length > 0) {
    s += "   <DESCRIPTIONS_SUB>\n" + subs.map(([c, sub, d]) => `    <SEOSUBCOTX>
     <CMPNAME>${c}</CMPNAME>
     <SCONAME>${sub}</SCONAME>
     <LANGU>E</LANGU>
     <DESCRIPT>${d}</DESCRIPT>
    </SEOSUBCOTX>
`).join("") + "   </DESCRIPTIONS_SUB>\n";
  }
  if (tpool.length > 0) {
    // The shape abapGit serialises a text pool in, read off a real export
    // (the ESH_SEARCH MPC's XML): ID I for a text symbol, the three-digit
    // key, the text, and the field length the symbol was defined with.
    s += "   <TPOOL>\n" + tpool.map(([key, entry]) => `    <item>
     <ID>I</ID>
     <KEY>${key}</KEY>
     <ENTRY>${String(entry).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")}</ENTRY>
     <LENGTH>132</LENGTH>
    </item>
`).join("") + "   </TPOOL>\n";
  }
  s += `  </asx:values>
 </asx:abap>
</abapGit>
`;
  return s;
}

const OP_SUBS = {
  C: [["/IWBEP/CX_MGW_BUSI_EXCEPTION", "business exception in mgw"], ["/IWBEP/CX_MGW_TECH_EXCEPTION", "mgw technical exception"], ["ER_ENTITY", "Returning data"], ["IO_DATA_PROVIDER", "MGW Entry Data Provider"], ["IT_KEY_TAB", "table for name value pairs"], ["IT_NAVIGATION_PATH", "table of navigation paths"]],
  D: [["/IWBEP/CX_MGW_BUSI_EXCEPTION", "business exception in mgw"], ["/IWBEP/CX_MGW_TECH_EXCEPTION", "mgw technical exception"], ["IT_KEY_TAB", "table for name value pairs"], ["IT_NAVIGATION_PATH", "table of navigation paths"]],
  R: [["/IWBEP/CX_MGW_BUSI_EXCEPTION", "business exception in mgw"], ["/IWBEP/CX_MGW_TECH_EXCEPTION", "mgw technical exception"], ["ER_ENTITY", "Returning data"], ["IO_REQUEST_OBJECT", "table of navigation paths"], ["IT_KEY_TAB", "table for name value pairs"], ["IT_NAVIGATION_PATH", "table of navigation paths"]],
  Q: [["/IWBEP/CX_MGW_BUSI_EXCEPTION", "business exception in mgw"], ["/IWBEP/CX_MGW_TECH_EXCEPTION", "mgw technical exception"], ["ET_ENTITYSET", "Returning data"], ["IS_PAGING", "Paging structure"], ["IT_FILTER_SELECT_OPTIONS", "Table of select options"], ["IT_KEY_TAB", "Table for name value pairs"], ["IT_NAVIGATION_PATH", "Table of navigation paths"], ["IT_ORDER", "The sorting order"], ["IV_FILTER_STRING", "Table for name value pairs"]],
  U: [["/IWBEP/CX_MGW_BUSI_EXCEPTION", "business exception in mgw"], ["/IWBEP/CX_MGW_TECH_EXCEPTION", "mgw technical exception"], ["ER_ENTITY", "Returning data"], ["IO_DATA_PROVIDER", "MGW Entry Data Provider"], ["IT_KEY_TAB", "table for name value pairs"], ["IT_NAVIGATION_PATH", "table of navigation paths"]],
};

/** Give every labelled property a text symbol, and hand back the pool.
 *
 *  **A label belongs in the class's text pool, not in a `sap:label`
 *  annotation**, and this was measured rather than reasoned: across the
 *  corpus, `set_label_from_text_element(` occurs 1014 times and
 *  `iv_key = 'label'` not once. A real SEGW generator never writes the
 *  annotation.
 *
 *  It matters because the two are not equivalent on a system. Gateway adds
 *  its own `sap:label` from the DDIC data element when the entity type is
 *  bound to a structure, so ours lands beside it and the property carries
 *  the attribute **twice** -- which is not valid XML. A browser stopped
 *  rendering our $metadata at the second one; the shape comparison did not
 *  notice, because a lenient reader takes the first match. Found 2026-09-19
 *  on A4H, and it cannot be found here: our own $metadata is valid, because
 *  nothing adds the DDIC half.
 *
 *  Numbering starts above whatever the model already carries, because a
 *  model read from a real IWPR brings SEGW's own symbols and renumbering
 *  them would point the calls at somebody else's text. */
export function assignTextElements(m) {
  const existing = m.entityTypes.flatMap((et) => et.properties)
    .map((p) => Number(p.textElement)).filter((n) => Number.isFinite(n));
  let next = existing.length === 0 ? 1 : Math.max(...existing) + 1;
  const pool = [];
  /** `orName` for the nodes SEGW labels with their own name when nothing
   *  else is given -- actions and their parameters, whose $metadata on a
   *  system reads `sap:label="CancelTravel"` and `sap:label="Status"`. A
   *  property is not one of them: a property with no label has none, and
   *  inventing one would put a text in the model the author never wrote.
   *
   *  **An open question, with a measurement on each side (2026-09-20).**
   *
   *  For: SEGW regenerated the demo's MPC from our tree on A4H (2026-09-19)
   *  and wrote `lo_action->set_label_from_text_element(` straight after
   *  `create_action` -- `test/stg-compile.mjs` pins those bytes. Our tree
   *  carried `FI_LABEL` for that action, because `stg-compile` writes one.
   *
   *  Against: the corpus holds exactly one real SEGW-generated MPC that has
   *  actions, `ycl_slpm_mpc`. It has 39 property label calls, symbols 001 to
   *  039 contiguous with no gaps, a TPOOL of exactly 39 entries, and **two
   *  actions with four parameters carrying no symbol at all**. Under this
   *  rule that pool would hold 45.
   *
   *  Both hold if SEGW emits the call when the TREE carries a label and not
   *  otherwise -- our tree always does because `stg-compile` writes one, and
   *  that project's evidently did not. If that is right, `orName` is a
   *  coincidence: it produces the measured bytes for the wrong reason, and
   *  would produce wrong ones for a project imported from a real IWPR whose
   *  actions have no label.
   *
   *  **Not changed on that inference.** The A4H run is a measurement of a
   *  system and the corpus reading is an inference about a tree nobody has;
   *  trading the first for the second is the wrong direction. What settles
   *  it is one A4H run: create an action, type no label, regenerate, read
   *  whether the call is there. Until then the rule stands and the doubt is
   *  written next to it rather than in somebody's memory.
   *
   *  A second opinion was asked and agreed (codex gpt-5.6-sol, 2026-09-20):
   *  the only controlled byte-level observation supports what is here, and
   *  the alternative rests on a reconstruction of a tree nobody has. */
  const take = (node, orName = false) => {
    if (node.textElement) {
      pool.push([String(node.textElement), node.label ?? node.name]);
      return;
    }
    const label = node.label ?? (orName ? node.name : undefined);
    if (!label) return;
    node.textElement = String(next++).padStart(3, "0");
    node.label = label;
    pool.push([node.textElement, label]);
  };
  for (const et of m.entityTypes) {
    for (const pr of et.properties) take(pr);
  }
  // Actions and their parameters carry labels too -- SEGW writes
  // `lo_action->set_label_from_text_element` and one per input parameter.
  // They were missed the first time because the fix was written for the
  // defect that had been seen, a duplicated sap:label on a property, rather
  // than for the rule it came from.
  for (const fi of m.functionImports ?? []) {
    take(fi, true);
    for (const fp of fi.parameters ?? []) take(fp, true);
  }
  return pool;
}

export function mpcXml(m) {
  const names = [...(m.complexTypes.length > 0 ? ["DEFINE_COMPLEXTYPES"] : []), ...m.entityTypes.map((et) => `DEFINE_${et.defineStem}`), ...(m.associations.length > 0 || m.navigation.length > 0 ? ["DEFINE_ASSOCIATIONS"] : []), ...(m.functionImports.length > 0 ? ["DEFINE_ACTIONS"] : []), "LOAD_TEXT_ELEMENTS"].sort();
  return clasXml(m.classes.mpc, m.classes.mpc, names.map((n) => [n, n]), [],
    [...m.entityTypes.flatMap((et) => et.properties),
     ...(m.functionImports ?? []),
     ...(m.functionImports ?? []).flatMap((fi) => fi.parameters ?? [])]
      .filter((p) => p.textElement && p.label)
      .map((p) => [String(p.textElement), p.label]));
}

export function dpcXml(m) {
  const ops = operations(m).sort((a, b) => a.method.localeCompare(b.method));
  return clasXml(m.classes.dpc, "Data Provider Base Class",
    ops.map((o) => [o.method, `Related EntitySet Name: ${o.set.name}`]),
    ops.flatMap((o) => OP_SUBS[o.type].map(([sub, d]) => [o.method, sub, d])));
}

export function extSources(m) {
  const mpcExt = m.classes.mpcExt;
  const dpcExt = m.classes.dpcExt;
  return {
    [fileName(mpcExt, ".clas.abap")]: `class ${mpcExt} definition
  public
  inheriting from ${m.classes.mpc}
  create public .

public section.
protected section.
private section.
ENDCLASS.



CLASS ${mpcExt} IMPLEMENTATION.
ENDCLASS.
`,
    [fileName(mpcExt, ".clas.xml")]: clasXml(mpcExt, mpcExt),
    [fileName(dpcExt, ".clas.abap")]: `class ${dpcExt} definition
  public
  inheriting from ${m.classes.dpc}
  create public .

public section.
protected section.
private section.
ENDCLASS.



CLASS ${dpcExt} IMPLEMENTATION.
ENDCLASS.
`,
    [fileName(dpcExt, ".clas.xml")]: clasXml(dpcExt, "Data Provider Secondary Class"),
  };
}

// ------------------------------------------------------------------ CLI

// abapGit writes /NS/CL_X as #ns#cl_x
const fileName = (cls, ext) => cls.toLowerCase().replaceAll("/", "#") + ext;

export function generate(iwprXml, opts = {}) {
  const m = buildModel(parseIwpr(iwprXml));
  if (m.referenceDataSources.length > 0 && m.entityTypes.length === 0) {
    return {model: m, files: {}, ext: {}, skipped: "reference data source (SADL) project: the RDS templates are not generated yet"};
  }
  if (m.projectType === "3") {
    return {model: m, files: {}, ext: {}, skipped: "annotation model project (PROJECT_TYPE 3): it generates an annotation provider class, not an MPC/DPC pair"};
  }
  const redefined = m.modelReferences.find((r) => r.refType === "EXT" || r.refType === "APC");
  if (redefined) {
    return {model: m, files: {}, ext: {}, skipped: `redefines ${redefined.object} ${redefined.version}: the MPC extends that model and the DPC inherits its _DPC_EXT; the redefine templates are not generated yet`};
  }
  const ts = m.lastChanged.replace(/\..*/, "");
  const o = {
    generatedAt: ts.slice(0, 14),
    generatedOn: `${ts.slice(6, 8)}.${ts.slice(4, 6)}.${ts.slice(0, 4)} ${ts.slice(8, 10)}:${ts.slice(10, 12)}:${ts.slice(12, 14)}`,
    client: "001",
    ...opts,
  };
  // Labels become text symbols before anything is written, so the source and
  // the class XML agree about the numbers: mpcSource emits the
  // set_label_from_text_element calls and LOAD_TEXT_ELEMENTS, mpcXml emits
  // the pool they resolve against. Two writers, one assignment.
  assignTextElements(m);
  const files = {
    [fileName(m.classes.mpc, ".clas.abap")]: mpcSource(m, o),
    [fileName(m.classes.mpc, ".clas.xml")]: mpcXml(m),
    [fileName(m.classes.dpc, ".clas.abap")]: dpcSource(m, o),
    [fileName(m.classes.dpc, ".clas.xml")]: dpcXml(m),
  };
  return {model: m, files, ext: extSources(m)};
}

const mask = (s) => s
  .replace(/generated\s+on \d\d\.\d\d\.\d{4} \d\d:\d\d:\d\d in client \d+/g, "generated on <ts> in client <c>")
  .replace(/VALUE '\d{14}'/g, "VALUE '<ts>'")
  // abapGit versions differ in what they put into the class XML
  .replace(/^\s*<CLSNAME>.*<\/CLSNAME>\n(?=\s*<CMPNAME>)/gm, "")
  .replace(/<LANGU>.<\/LANGU>/g, "<LANGU>?</LANGU>")
  .replace(/\r\n/g, "\n");
// what SEGW releases differ in: indentation, blank lines, letter case
const loose = (s) => mask(s).replace(/<DESCRIPTIONS_SUB>[\s\S]*?<\/DESCRIPTIONS_SUB>\n?/g, "").split("\n").map((l) => l.trim().replace(/\s+/g, " ").toLowerCase()).filter((l) => l !== "").join("\n");

if (process.argv[1] && /segw-gen\.mjs$/.test(process.argv[1])) {
  const args = process.argv.slice(2);
  const valued = ["--out", "--lib"];
  const folder = args.find((a, i) => !a.startsWith("--") && !valued.includes(args[i - 1]));
  const check = args.includes("--check");
  const out = args[args.indexOf("--out") + 1];
  const libs = args.flatMap((a, i) => (a === "--lib" ? [args[i + 1]] : []));
  if (!folder) {
    console.error("usage: segw-gen.mjs <folder with <project>.iwpr.xml> [--check] [--out <dir>] [--lib <folder with *.fugr.xml>]...");
    process.exit(2);
  }
  const iwpr = readdirSync(folder).sort().find((f) => f.endsWith(".iwpr.xml"));
  if (!iwpr) {
    console.error("no .iwpr.xml in " + folder);
    process.exit(2);
  }
  const warnings = [];
  const {model, files, ext, skipped} = generate(readFileSync(join(folder, iwpr), "utf8"), {
    superDefine: args.includes("--super-define"), functionModules: loadFunctionGroups([...libs, folder]), warnings,
  });
  if (skipped) {
    console.log(`segw-gen: ${model.project}: ${skipped}`);
    process.exit(0);
  }
  const mapped = model.entityTypes.flatMap((et) => et.entitySets.flatMap((es) => es.operations.filter((o) => o.mapping).map((o) => o.mapping.kind)));
  console.log(`segw-gen: ${model.project} (${model.description}): ${model.entityTypes.length} entity types, ${model.associations.length} associations, ${model.functionImports.length} function imports${mapped.length > 0 ? `, ${mapped.filter((k) => k === "RFC").length} operations mapped to function modules, ${mapped.filter((k) => k === "SHLP").length} to search helps` : ""} -> ${Object.keys(files).join(", ")}`);
  for (const w of warnings) {
    console.log(`  warning: ${w}`);
  }
  if (check) {
    let bad = 0;
    for (const [name, content] of Object.entries(files)) {
      const path = join(folder, name);
      if (!existsSync(path)) {
        console.log(`  ${name}: not in ${folder}`);
        bad++;
        continue;
      }
      const have = mask(readFileSync(path, "utf8"));
      const want = mask(content);
      if (have === want) {
        console.log(`  ${name}: identical`);
      } else if (loose(have) === loose(want)) {
        console.log(`  ${name}: identical modulo formatting (another SEGW release)`);
      } else if (loose(have).split("\n").sort().join("\n") === loose(want).split("\n").sort().join("\n")) {
        console.log(`  ${name}: identical modulo formatting and declaration order (another abapGit)`);
      } else if (loose(have) !== loose(want)) {
        const a = loose(have).split("\n");
        const b = loose(want).split("\n");
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) {
          i++;
        }
        bad++;
        console.log(`  ${name}: differs (first difference after formatting, line ${i + 1} of ${a.length} vs ${b.length})\n    have: ${JSON.stringify(a[i] ?? "")}\n    want: ${JSON.stringify(b[i] ?? "")}`);
        // and, order aside, what only one side has
        const count = (lines) => lines.reduce((m, l) => m.set(l, (m.get(l) ?? 0) + 1), new Map());
        const ca = count(a);
        const cb = count(b);
        const onlyA = [...ca].filter(([l, n]) => (cb.get(l) ?? 0) < n).map(([l]) => l);
        const onlyB = [...cb].filter(([l, n]) => (ca.get(l) ?? 0) < n).map(([l]) => l);
        for (const l of onlyA.slice(0, 4)) {
          console.log(`    only in the folder: ${JSON.stringify(l)}`);
        }
        for (const l of onlyB.slice(0, 4)) {
          console.log(`    only generated:     ${JSON.stringify(l)}`);
        }
        console.log(`    (${onlyA.length} lines only in the folder, ${onlyB.length} only generated)`);
      } else {
        bad++;
        const a = have.split("\n");
        const b = want.split("\n");
        let i = 0;
        while (i < a.length && i < b.length && a[i] === b[i]) {
          i++;
        }
        console.log(`  ${name}: differs from line ${i + 1} (${a.length} vs ${b.length} lines)\n    have: ${JSON.stringify(a[i] ?? "")}\n    want: ${JSON.stringify(b[i] ?? "")}`);
      }
    }
    process.exit(bad === 0 ? 0 : 1);
  }
  if (out) {
    mkdirSync(out, {recursive: true});
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(join(out, name), content);
    }
    for (const [name, content] of Object.entries(ext)) {
      if (!existsSync(join(out, name))) {
        writeFileSync(join(out, name), content);
      }
    }
    console.log(`  written to ${out}`);
  }
}
