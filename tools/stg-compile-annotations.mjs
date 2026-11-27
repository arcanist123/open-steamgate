// The vocabulary annotations of stg-compile's `annotations:` (tools/stg-compile.mjs),
// written as ABAP over vocab_anno_model. Carved out of stg-compile.mjs when the
// grammar grew (UI.DataPoint, UI.Chart, Criticality, UI.Hidden, fixed value lists).
// ------------------------------------------------- vocabulary annotations

// `annotations:` -> ZCL_<project>_MPC_ANN, a class that writes the vocabulary
// annotations through vocab_anno_model the way a SEGW-generated _MPC_EXT
// does; the _MPC_EXT calls it from DEFINE. Terms: UI.HeaderInfo,
// UI.SelectionFields, UI.LineItem (+ Criticality), UI.Facets and
// UI.HeaderFacets (+ UI.Hidden), UI.FieldGroup, UI.DataPoint, UI.Chart on an
// entity; Common.Label, Common.Text (+UI.TextArrangement), Common.ValueList,
// Common.ValueListWithFixedValues on a property.
//
//   annotations:
//     Travel:
//       header: {typeName: Travel, typeNamePlural: Travels, title: Description, description: TravelId}
//       selectionFields: [Status, TravelId]
//       lineItem: [TravelId, {value: Description, label: Description},
//                  {intent: {semanticObject: Booking, action: display, label: Open}}]
//       facets: [{id: General, label: General, fieldGroup: General}, {id: Bookings, label: Bookings, lineItem: to_Bookings}]
//       fieldGroups: {General: [TravelId, Description]}
//     Travel/Status:
//       label: Status
//       text: {path: StatusText, arrangement: TextFirst}
//       valueList: {label: Status, collection: StatusVHSet, search: true,
//                   parameters: [{inOut: {Status: Status}}, {displayOnly: Text}]}
const UI = "com.sap.vocabularies.UI.v1.";
const COMMON = "com.sap.vocabularies.Common.v1.";
const SESSION = "com.sap.vocabularies.Session.v1.";
const expandAlias = (path) => String(path).replaceAll("@UI.", "@" + UI).replaceAll("@Common.", "@" + COMMON);
const lit = (v) => `'${String(v).replaceAll("'", "''")}'`;

export class AnnotationWriter {
  constructor() {
    this.lines = [];
  }

  line(text) {
    this.lines.push(`    ${text}`);
  }

  target(name) {
    this.line("");
    this.line(`lo_target = io_vocab->create_annotations_target( ${lit(name)} ).`);
  }

  // an annotation with one simple value
  simple(term, kind, value, owner = "lo_target", into = "lo_annotation") {
    const text = kind === "set_boolean" ? (value ? "abap_true" : "abap_false") : lit(value);
    this.line(`${into} = ${owner}->create_annotation( ${lit(term)} ).`);
    this.line(`${into}->create_simple_value( )->${kind}( ${text} ).`);
  }

  // a record's property with one simple value
  value(record, property, kind, value) {
    const text = kind === "set_boolean" ? (value ? "abap_true" : "abap_false") : lit(value);
    this.line(`${record}->create_property( ${lit(property)} )->create_simple_value( )->${kind}( ${text} ).`);
  }

  // a UI.DataField-like record inside a collection
  dataField(collection, item, into = "lo_item") {
    if (typeof item === "string") {
      this.line(`${into} = ${collection}->create_record( ${lit(UI + "DataField")} ).`);
      this.value(into, "Value", "set_path", item);
      return;
    }
    if (item.intent) {
      this.line(`${into} = ${collection}->create_record( ${lit(UI + "DataFieldForIntentBasedNavigation")} ).`);
      if (item.intent.label) {
        this.value(into, "Label", "set_string", item.intent.label);
      }
      this.value(into, "SemanticObject", "set_string", item.intent.semanticObject);
      this.value(into, "Action", "set_string", item.intent.action);
      this.value(into, "RequiresContext", "set_boolean", item.intent.requiresContext !== false);
      return;
    }
    const type = item.semanticObject ? "DataFieldWithIntentBasedNavigation" : "DataField";
    this.line(`${into} = ${collection}->create_record( ${lit(UI + type)} ).`);
    this.value(into, "Value", "set_path", item.value);
    if (item.label) {
      this.value(into, "Label", "set_string", item.label);
    }
    if (item.semanticObject) {
      this.value(into, "SemanticObject", "set_string", item.semanticObject);
      this.value(into, "Action", "set_string", item.action);
    }
    // the value's colour: a path to a UI.CriticalityType number (0 neutral,
    // 1 negative, 2 critical, 3 positive)
    if (item.criticality) {
      this.value(into, "Criticality", "set_path", item.criticality);
    }
  }

  // a number with its context: what a header facet or a micro chart shows
  dataPoint(qualifier, d) {
    this.line(`lo_annotation = lo_target->create_annotation(`);
    this.line(`  iv_term      = ${lit(UI + "DataPoint")}`);
    this.line(`  iv_qualifier = ${lit(qualifier)} ).`);
    this.line(`lo_record = lo_annotation->create_record( ${lit(UI + "DataPointType")} ).`);
    this.value("lo_record", "Value", "set_path", d.value);
    if (d.title) {
      this.value("lo_record", "Title", "set_string", d.title);
    }
    for (const [key, name] of [["targetValue", "TargetValue"], ["minimumValue", "MinimumValue"], ["maximumValue", "MaximumValue"], ["criticality", "Criticality"]]) {
      if (d[key] !== undefined) {
        this.value("lo_record", name, typeof d[key] === "number" ? "set_decimal" : "set_path", String(d[key]));
      }
    }
    if (d.visualization) {
      this.value("lo_record", "Visualization", "set_enum_member_by_name", `${UI}VisualizationType/${d.visualization}`);
    }
    const c = d.criticalityCalculation;
    if (c) {
      this.line(`lo_item = lo_record->create_property( 'CriticalityCalculation' )->create_record( ${lit(UI + "CriticalityCalculationType")} ).`);
      this.value("lo_item", "ImprovementDirection", "set_enum_member_by_name", `${UI}ImprovementDirectionType/${c.improvementDirection ?? "Minimize"}`);
      for (const name of ["DeviationRangeLowValue", "ToleranceRangeLowValue", "ToleranceRangeHighValue", "DeviationRangeHighValue"]) {
        const key = name[0].toLowerCase() + name.slice(1);
        if (c[key] !== undefined) {
          this.value("lo_item", name, typeof c[key] === "number" ? "set_decimal" : "set_path", String(c[key]));
        }
      }
    }
  }

  // UI.Chart: a micro chart in an object page header (Donut is the radial
  // one, Bullet a value against its thresholds, BarStacked a collection's
  // rows as the segments of one bar)
  chart(qualifier, c) {
    this.line(`lo_annotation = lo_target->create_annotation(`);
    this.line(`  iv_term      = ${lit(UI + "Chart")}`);
    this.line(`  iv_qualifier = ${lit(qualifier)} ).`);
    this.line(`lo_record = lo_annotation->create_record( ${lit(UI + "ChartDefinitionType")} ).`);
    if (c.title) {
      this.value("lo_record", "Title", "set_string", c.title);
    }
    if (c.description) {
      this.value("lo_record", "Description", "set_string", c.description);
    }
    this.value("lo_record", "ChartType", "set_enum_member_by_name", `${UI}ChartType/${c.type}`);
    for (const [key, name] of [["dimensions", "Dimensions"], ["measures", "Measures"]]) {
      if (c[key]) {
        this.line(`lo_collection = lo_record->create_property( ${lit(name)} )->create_collection( ).`);
        for (const p of c[key]) {
          this.line(`lo_collection->create_simple_value( )->set_property_path( ${lit(p)} ).`);
        }
      }
    }
    if (c.measureAttributes) {
      this.line(`lo_collection = lo_record->create_property( 'MeasureAttributes' )->create_collection( ).`);
      for (const m of c.measureAttributes) {
        this.line(`lo_item = lo_collection->create_record( ${lit(UI + "ChartMeasureAttributeType")} ).`);
        this.value("lo_item", "Measure", "set_property_path", m.measure);
        this.value("lo_item", "Role", "set_enum_member_by_name", `${UI}ChartMeasureRoleType/${m.role ?? "Axis1"}`);
        if (m.dataPoint) {
          this.value("lo_item", "DataPoint", "set_annotation_path", `@${UI}DataPoint#${m.dataPoint}`);
        }
      }
    }
  }

  // The target of one annotations: entry. R8: Common.DraftRoot / DraftNode
  // apply to the entity set, which the V2 model names inside its container
  // (the V4 facade moves the target); written here, and false when the
  // entry says nothing else, so no entity-type target follows
  targetOf(namespace, a) {
    if (!a.property && (a.spec.draftRoot || a.spec.draftNode)) {
      const d = a.spec.draftRoot ?? a.spec.draftNode;
      this.target(`${namespace}.${namespace}_Entities/${d.set ?? a.entity.set}`);
      this.draft(a.spec);
      if (Object.keys(a.spec).every((k) => k === "draftRoot" || k === "draftNode")) {
        return false;
      }
    }
    this.target(`${namespace}.${a.target}`);
    return true;
  }

  // R8: a draft-enabled entity set (docs/rap-runtime.md, R8):
  //   draftRoot: {set, activation, edit, prepare}  Common.DraftRoot
  //   draftNode: {set, prepare}                    Common.DraftNode
  draft(s) {
    if (s.draftRoot) {
      this.line(`lo_record = lo_target->create_annotation( ${lit(COMMON + "DraftRoot")} )->create_record( ${lit(COMMON + "DraftRootType")} ).`);
      for (const [key, name] of [["activation", "ActivationAction"], ["edit", "EditAction"], ["prepare", "PreparationAction"]]) {
        if (s.draftRoot[key]) {
          this.value("lo_record", name, "set_string", s.draftRoot[key]);
        }
      }
    }
    if (s.draftNode) {
      this.line(`lo_record = lo_target->create_annotation( ${lit(COMMON + "DraftNode")} )->create_record( ${lit(COMMON + "DraftNodeType")} ).`);
      if (s.draftNode.prepare) {
        this.value("lo_record", "PreparationAction", "set_string", s.draftNode.prepare);
      }
    }
  }

  entity(a) {
    const s = a.spec;
    // sticky: true asks the OData V4 facade for sticky-session editing of
    // this entity's set (what Fiori Elements V4 edits and creates through,
    // docs/odata-v4.md). The marker is Session.StickySessionSupported on the
    // type with an empty record; the facade defines the actions and names
    // them on the entity set, where Fiori Elements reads them.
    if (s.sticky === true) {
      this.line(`lo_record = lo_target->create_annotation( ${lit(SESSION + "StickySessionSupported")} )->create_record( ${lit(SESSION + "StickySessionSupportedType")} ).`);
    }
    if (s.header) {
      this.line(`lo_record = lo_target->create_annotation( ${lit(UI + "HeaderInfo")} )->create_record( ${lit(UI + "HeaderInfoType")} ).`);
      if (s.header.typeName) {
        this.value("lo_record", "TypeName", "set_string", s.header.typeName);
      }
      if (s.header.typeNamePlural) {
        this.value("lo_record", "TypeNamePlural", "set_string", s.header.typeNamePlural);
      }
      if (s.header.imageUrl) {
        this.value("lo_record", "ImageUrl", "set_path", s.header.imageUrl);
      }
      for (const [key, name] of [["title", "Title"], ["description", "Description"]]) {
        if (s.header[key]) {
          this.line(`lo_item = lo_record->create_property( ${lit(name)} )->create_record( ${lit(UI + "DataField")} ).`);
          this.value("lo_item", "Value", "set_path", s.header[key]);
        }
      }
    }
    if (s.selectionFields) {
      this.line(`lo_collection = lo_target->create_annotation( ${lit(UI + "SelectionFields")} )->create_collection( ).`);
      for (const f of s.selectionFields) {
        this.line(`lo_collection->create_simple_value( )->set_property_path( ${lit(f)} ).`);
      }
    }
    if (s.lineItem) {
      this.line(`lo_collection = lo_target->create_annotation( ${lit(UI + "LineItem")} )->create_collection( ).`);
      for (const item of s.lineItem) {
        this.dataField("lo_collection", item);
      }
    }
    // UI.HeaderFacets is UI.Facets in the object page's header rather than in
    // its body: the same ReferenceFacet, a different term. Without it a Fiori
    // Elements header shows only the title and the description of HeaderInfo,
    // and everything else falls into the first section (measured on the
    // status app, 2026-09-17).
    for (const [term, list] of [[UI + "HeaderFacets", s.headerFacets], [UI + "Facets", s.facets]]) {
      if (list === undefined) {
        continue;
      }
      this.line(`lo_collection = lo_target->create_annotation( ${lit(term)} )->create_collection( ).`);
      for (const f of list) {
        this.line(`lo_item = lo_collection->create_record( ${lit(UI + "ReferenceFacet")} ).`);
        this.value("lo_item", "ID", "set_string", f.id);
        if (f.label) {
          this.value("lo_item", "Label", "set_string", f.label);
        }
        // $metadata declares no vocabulary aliases, so the path names the term
        // in full, the way Gateway renders it (a target: written as given,
        // UI./Common. aliases expanded)
        const path = expandAlias(f.fieldGroup ? `@UI.FieldGroup#${f.fieldGroup}` : f.lineItem ? `${f.lineItem}/@UI.LineItem` : f.target);
        this.line(`lo_item->create_property( 'Target' )->create_simple_value( )->set_annotation_path( ${lit(path)} ).`);
        // a facet that is not shown while a boolean property of the entity is true
        // (an object page section with nothing in it)
        if (f.hidden) {
          this.line(`lo_item->create_annotation( ${lit(UI + "Hidden")} )->create_simple_value( )->set_path( ${lit(f.hidden)} ).`);
        }
      }
    }
    for (const [name, d] of Object.entries(s.dataPoints ?? {})) {
      this.dataPoint(name, d);
    }
    for (const [name, c] of Object.entries(s.charts ?? {})) {
      this.chart(name, c);
    }
    for (const [name, fields] of Object.entries(s.fieldGroups ?? {})) {
      this.line(`lo_annotation = lo_target->create_annotation(`);
      this.line(`  iv_term      = ${lit(UI + "FieldGroup")}`);
      this.line(`  iv_qualifier = ${lit(name)} ).`);
      this.line(`lo_record = lo_annotation->create_record( ${lit(UI + "FieldGroupType")} ).`);
      this.line(`lo_collection = lo_record->create_property( 'Data' )->create_collection( ).`);
      for (const item of fields) {
        this.dataField("lo_collection", item);
      }
    }
  }

  property(a) {
    const s = a.spec;
    if (s.label) {
      this.simple(COMMON + "Label", "set_string", s.label);
    }
    // the value is the URL of an image: a list column and the header show it
    // as a picture instead of the text (the media resource of a media entity
    // is the usual source)
    if (s.isImageUrl) {
      this.simple(UI + "IsImageURL", "set_boolean", true);
    }
    if (s.text) {
      const t = typeof s.text === "string" ? {path: s.text} : s.text;
      this.simple(COMMON + "Text", "set_path", t.path);
      if (t.arrangement) {
        this.simple(UI + "TextArrangement", "set_enum_member_by_name", `${UI}TextArrangementType/${t.arrangement}`, "lo_annotation", "lo_nested");
      }
    }
    // a value list of a few fixed values: a drop-down instead of a search dialog
    if (s.valueListFixed) {
      this.simple(COMMON + "ValueListWithFixedValues", "set_boolean", true);
    }
    if (s.valueList) {
      const v = s.valueList;
      this.line(`lo_record = lo_target->create_annotation( ${lit(COMMON + "ValueList")} )->create_record( ${lit(COMMON + "ValueListType")} ).`);
      if (v.label) {
        this.value("lo_record", "Label", "set_string", v.label);
      }
      this.value("lo_record", "CollectionPath", "set_string", v.collection);
      this.value("lo_record", "SearchSupported", "set_boolean", v.search === true);
      this.line(`lo_collection = lo_record->create_property( 'Parameters' )->create_collection( ).`);
      for (const p of v.parameters ?? []) {
        const [kind, spec] = Object.entries(p)[0];
        const type = {inOut: "ValueListParameterInOut", in: "ValueListParameterIn", out: "ValueListParameterOut", displayOnly: "ValueListParameterDisplayOnly"}[kind];
        if (!type) {
          throw new Error(`annotations: ${a.target}: value list parameter ${kind}: use inOut, in, out or displayOnly`);
        }
        this.line(`lo_item = lo_collection->create_record( ${lit(COMMON + type)} ).`);
        if (kind === "displayOnly") {
          this.value("lo_item", "ValueListProperty", "set_string", spec);
        } else {
          const [local, remote] = Object.entries(spec)[0];
          this.value("lo_item", "LocalDataProperty", "set_property_path", local);
          this.value("lo_item", "ValueListProperty", "set_string", remote);
        }
      }
    }
  }
}
