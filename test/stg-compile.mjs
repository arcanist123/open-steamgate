import {expect} from "chai";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compile, compileAll, compileConfiguredAll, readModel} from "../tools/stg-compile.mjs";
import {generate} from "../tools/segw-gen.mjs";
import {loadFunctionGroups} from "../tools/segw-gen-mapping.mjs";
import {buildModel, parseIwpr} from "../tools/segw-gen.mjs";
import {exportIwpr, importIwpr} from "../tools/segw-tree.mjs";
import {readSpec} from "../tools/segw-tables.mjs";

// stg-compile: the YAML of the demo service becomes the SEGW project tree,
// the registration objects and (through segw-gen) the classes; the tree
// must read back as the same model, and the generated MPC must define what
// the hand-written demo MPC defines.
describe("tools/stg-compile: <service>.stg.yaml -> IWPR, IWSV, IWMO, _MPC/_DPC", () => {
  const source = readFileSync("src/demo/zstg_demo.stg.yaml", "utf8");
  const result = compile(source, {file: "zstg_demo.stg.yaml"});

  it("reads the file with its defaults", () => {
    const m = result.model;
    expect(m.classes).to.deep.equal({mpc: "ZCL_ZSTG_DEMO_MPC", mpcExt: "ZCL_ZSTG_DEMO_MPC_EXT", dpc: "ZCL_ZSTG_DEMO_DPC", dpcExt: "ZCL_ZSTG_DEMO_DPC_EXT", mpcAnn: "ZCL_ZSTG_DEMO_MPC_ANN"});
    const travel = m.entities[0];
    expect(travel.properties.map((p) => p.name)).to.deep.equal(["TravelId", "Description", "Status", "Seats", "StatusText", "PhotoUrl"]);
    // a key is not nullable and not updatable unless said otherwise; readonly turns creatable/updatable off
    expect(travel.properties[0]).to.include({isKey: true, type: "Edm.String", length: "8", creatable: true, updatable: false, nullable: false});
    expect(travel.properties[4]).to.include({creatable: false, updatable: false, sortable: false, filterable: false, field: "STATUS_TEXT"});
    expect(m.entities[3]).to.include({set: "StatusVHSet", creatable: false, searchable: true});
    expect(m.entities[2].operations.map((o) => o.type)).to.deep.equal(["R", "Q"]);
    expect(m.associations[0].card).to.deep.equal({left: "1", right: "N"});
    expect(m.functions.map((f) => `${f.name}:${f.method}:${f.multiplicity}`)).to.deep.equal(["CancelTravel:POST:1", "TravelCount:GET:"]);
  });

  it("writes the tree, the service and the model objects under their abapGit names", () => {
    expect(Object.keys(result.files)).to.deep.equal(["zstg_demo.iwpr.xml", "zstg_demo_srv                      0001.iwsv.xml", "zstg_demo_mdl                   0001.iwmo.xml"]);
    expect(result.files["zstg_demo_srv                      0001.iwsv.xml"]).to.contain("<CLASS_NAME>ZCL_ZSTG_DEMO_DPC_EXT</CLASS_NAME>");
    expect(result.files["zstg_demo_mdl                   0001.iwmo.xml"]).to.contain("<CLASS_NAME>ZCL_ZSTG_DEMO_MPC_EXT</CLASS_NAME>");
    // the registration objects match the hand-made ones of the demo
    expect(result.files["zstg_demo_srv                      0001.iwsv.xml"]).to.equal(readFileSync("src/demo/zstg_demo_srv                      0001.iwsv.xml", "utf8"));
    expect(result.files["zstg_demo_mdl                   0001.iwmo.xml"]).to.equal(readFileSync("src/demo/zstg_demo_mdl                   0001.iwmo.xml", "utf8"));
  });

  it("is deterministic: the same file gives the same tree", () => {
    expect(compile(source).iwpr).to.equal(result.iwpr);
    // a node id is base64 of 16 bytes, so 22 significant characters and "==";
    // the "==" is a consequence of the byte count, not something stapled on --
    // it used to be, and 55 of 59 ids decoded with non-zero padding bits
    expect(result.iwpr).to.match(/<NODE_UUID>[A-Za-z0-9+/]{21}[AEIMQUYcgkosw048]==<\/NODE_UUID>/);
  });

  it("writes the tree the way SEGW does: its fields, in its order, so segw-tree imports and exports it byte for byte", () => {
    const spec = readSpec();
    const tables = importIwpr(result.iwpr, spec);
    expect(exportIwpr(tables, "ZSTG_DEMO", spec)).to.equal(result.iwpr);
    // the text tables carry SEGW's label fields, not a DESCRIPTION
    expect(result.iwpr).to.contain("<ET_LABEL>Travel</ET_LABEL>");
    expect(result.iwpr).to.contain("<ESET_LABEL>TravelSet</ESET_LABEL>");
    expect(result.iwpr).to.contain("<NAVP_LABEL>to_Bookings</NAVP_LABEL>");
    expect(result.iwpr).not.to.contain("<TECH_NAME>TRAVELTOBOOKINGS</TECH_NAME>");
  });

  it("reads back through segw-gen as the same model", () => {
    const m = buildModel(parseIwpr(result.iwpr));
    expect(m.project).to.equal("ZSTG_DEMO");
    expect(m.namespace).to.equal("ZSTG_DEMO_SRV");
    expect(m.entityTypes.map((e) => e.name)).to.deep.equal(["Travel", "Booking", "Photo", "StatusVH"]);
    // a media entity is marked in the tree and generated with set_is_media
    expect(m.entityTypes.map((e) => e.isMedia)).to.deep.equal([false, false, true, false]);
    const travel = m.entityTypes[0];
    expect(travel.properties.map((p) => `${p.name}:${p.edmType}:${p.maxLength}`)).to.deep.equal(["TravelId:Edm.String:8", "Description:Edm.String:40", "Status:Edm.String:1", "Seats:Edm.Int32:", "StatusText:Edm.String:40", "PhotoUrl:Edm.String:120"]);
    expect(travel.properties[0]).to.include({isKey: true, nullable: false, updatable: false, label: "Travel"});
    expect(travel.entitySets[0]).to.include({name: "TravelSet", creatable: true, searchable: true, subscribable: false});
    expect(travel.entitySets[0].operations.map((o) => o.method)).to.deep.equal(["TRAVELSET_CREATE_ENTITY", "TRAVELSET_GET_ENTITY", "TRAVELSET_UPDATE_ENTITY", "TRAVELSET_DELETE_ENTITY", "TRAVELSET_GET_ENTITYSET"]);
    expect(m.entityTypes[3].entitySets[0].operations.map((o) => o.method)).to.deep.equal(["STATUSVHSET_GET_ENTITY", "STATUSVHSET_GET_ENTITYSET"]);
    expect(m.associations[0]).to.include({name: "TravelToBookings", leftType: "Travel", rightType: "Booking", leftCard: "1", rightCard: "N"});
    expect(m.associations[0].constraints).to.deep.equal([{principal: "TravelId", dependent: "TravelId"}]);
    expect(m.associations[0].sets).to.deep.equal([{name: "TravelToBookingsSet", leftSet: "TravelSet", rightSet: "BookingSet"}]);
    expect(m.navigation).to.deep.equal([{name: "to_Bookings", abapField: "TO_BOOKINGS", entity: "Travel", association: "TravelToBookings"}, {name: "to_Travel", abapField: "TO_TRAVEL", entity: "Booking", association: "TravelToBookings"}]);
    // returnSet is empty on purpose: an action bound to an entity type may
    // not name one, and SEGW refuses the project if it does. Gateway puts
    // EntitySet="TravelSet" into $metadata anyway, derived from actionFor
    // (A4H, 2026-09-19).
    expect(m.functionImports[0]).to.include({name: "CancelTravel", httpMethod: "POST", returnCard: "1", returnKind: "ETYP", returnType: "Travel", returnSet: "", actionFor: "Travel"});
    expect(m.functionImports[0].parameters[0]).to.include({name: "TravelId", abapField: "TRAVEL_ID", edmType: "Edm.String", maxLength: "8"});
  });

  it("generates the classes SEGW would write for that tree", () => {
    const mpc = result.classes["zcl_zstg_demo_mpc.clas.abap"];
    // the label comes first now, as a text symbol, which is what a real SEGW
    // generator writes -- see assignTextElements in tools/segw-gen.mjs
    expect(mpc).to.contain("lo_property = lo_entity_type->create_property( iv_property_name = 'TravelId' iv_abap_fieldname = 'TRAVEL_ID' ). \"#EC NOTEXT\nlo_property->set_is_key( ).\nlo_property->set_label_from_text_element(");
    expect(mpc).to.contain("lo_property->set_type_edm_string( ).\nlo_property->set_maxlength( iv_max_length = 8 ). \"#EC NOTEXT");
    expect(mpc).to.contain("lo_property = lo_entity_type->create_property( iv_property_name = 'FlightDate' iv_abap_fieldname = 'FLIGHT_DATE' ). \"#EC NOTEXT\nlo_property->set_label_from_text_element(");
    // A date is an Edm.DateTime with no precision and an ABAP type behind
    // it, which is what SAP's own sample projects carry for one
    // (TYPE_KIND D, LENGTH 8, a TYPE_NAME; no PROP_PRECISION). The
    // timestamp shape -- set_precison( 0 ) and a TIMESTAMP component -- is
    // what A4H refused to activate the DPC over, because the column is DATS.
    expect(mpc).to.contain("lo_property->set_type_edm_datetime( ).\nlo_property->set_creatable( abap_true ).");
    expect(mpc).to.not.contain("set_precison( iv_precision = 0 )");
    expect(mpc, "the structure component is a date, not a timestamp").to.contain("FLIGHT_DATE type SYDATE,");
    expect(mpc).to.contain("lo_entity_set->set_has_ftxt_search( abap_true ).");
    expect(mpc).to.contain("lo_association = model->create_association(\n                            iv_association_name = 'TravelToBookings' \"#EC NOTEXT\n                            iv_left_type        = 'Travel' \"#EC NOTEXT\n                            iv_right_type       = 'Booking' \"#EC NOTEXT\n                            iv_right_card       = 'N' \"#EC NOTEXT\n                            iv_left_card        = '1'  \"#EC NOTEXT");
    expect(mpc).to.contain("lo_ref_constraint->add_property( iv_principal_property = 'TravelId'   iv_dependent_property = 'TravelId' ). \"#EC NOTEXT");
    expect(mpc).to.contain("iv_property_name  = 'to_Bookings'");
    // the order SEGW itself writes: action_for before multiplicity, read off
    // the class SEGW regenerated from our tree on A4H (2026-09-19)
    expect(mpc).to.contain("lo_action = model->create_action( 'CancelTravel' ).  \"#EC NOTEXT\nlo_action->set_label_from_text_element(");
    expect(mpc).to.contain("lo_action->set_return_entity_type( 'Travel' ). \"#EC NOTEXT\n*Set HTTP method GET or POST\nlo_action->set_http_method( 'POST' ). \"#EC NOTEXT\n*Set the action for entity\nlo_action->set_action_for( 'Travel' ). \"#EC NOTEXT\n* Set return type multiplicity\nlo_action->set_return_multiplicity( '1' ). \"#EC NOTEXT");
    const dpc = result.classes["zcl_zstg_demo_dpc.clas.abap"];
    expect(dpc).to.contain("  methods TRAVELSET_GET_ENTITYSET\n    importing");
    expect(dpc).to.contain("      method = 'BOOKINGSET_CREATE_ENTITY'.");
    expect(dpc).not.to.contain("STATUSVHSET_CREATE_ENTITY");
    expect(Object.keys(result.ext)).to.deep.equal(["zcl_zstg_demo_mpc_ext.clas.abap", "zcl_zstg_demo_mpc_ext.clas.xml", "zcl_zstg_demo_dpc_ext.clas.abap", "zcl_zstg_demo_dpc_ext.clas.xml"]);
  });

  it("routes table: and cds: sources to SADL", () => {
    const r = compile(`
project: ZSTG_T
service: ZSTG_T_SRV
entities:
  Status:
    source: {table: ZSTG_STATUS}
    keys: [Status]
    properties:
      Status: String(1)
      Text: String(40)
  Item:
    source: {cds: ZSTG_I_ITEM}
    keys: [Id]
    properties:
      Id: String(10)
`);
    const m = buildModel(parseIwpr(r.iwpr));
    expect(m.entityTypes[0].entitySets[0].sadl).to.deep.equal({type: "DDIC", binding: "ZSTG_STATUS"});
    expect(m.entityTypes[0].abapStruct).to.equal("ZSTG_STATUS");
    expect(m.entityTypes[1].entitySets[0].sadl).to.deep.equal({type: "CDS", binding: "ZSTG_I_ITEM"});
    const dpc = r.classes["zcl_zstg_t_dpc.clas.abap"];
    expect(dpc).to.contain("  interfaces IF_SADL_GW_DPC_UTIL .");
    expect(dpc).to.contain('| <sadl:dataSource type="DDIC" name="StatusSet" binding="ZSTG_STATUS" />| &');
    expect(dpc).to.contain('| <sadl:dataSource type="CDS" name="ItemSet" binding="ZSTG_I_ITEM" />| &');
    expect(dpc).to.contain("    if_sadl_gw_dpc_util~get_dpc( )->get_entityset(");
  });

  it("says what is wrong with a file", () => {
    expect(() => readModel("project: X\nservice: Y\n", "x.stg.yaml")).to.throw('"entities" is required');
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    keys: [Id]\n    properties: {Name: String}\n", "x.stg.yaml")).to.throw("key Id is not a property");
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: Money}\n")).to.throw("unknown type Money");
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: String}\nassociations:\n  R: {from: A, to: B}\n")).to.throw("entity B is not defined");
  });
});

describe("tools/stg-compile: a service consumed from another one (local ODC)", () => {
  it("routes service:/set: to zcl_stg_odata_client in the generated DPC", () => {
    const r = compile(readFileSync("src/demo_odc/zstg_odc.stg.yaml", "utf8"), {file: "zstg_odc.stg.yaml"});
    const m = buildModel(parseIwpr(r.iwpr));
    expect(m.service).to.equal("ZSTG_ODC_SRV");
    expect(m.entityTypes[0].entitySets[0].sadl).to.deep.equal({type: "ODC", binding: "ZSTG_SADL_SRV~Zc_Stg_TravelSet", service: "ZSTG_SADL_SRV", set: "Zc_Stg_TravelSet"});
    expect(m.entityTypes[0].abapStruct).to.equal("");
    const dpc = r.classes["zcl_zstg_odc_dpc.clas.abap"];
    expect(dpc).not.to.contain("IF_SADL_GW_DPC_UTIL");
    expect(dpc).to.contain("  method TRAVELSET_GET_ENTITYSET.\n    DATA lo_client TYPE REF TO zcl_stg_odata_client.");
    expect(dpc).to.contain("        iv_service    = 'ZSTG_SADL_SRV'\n        iv_entity_set = 'Zc_Stg_TravelSet'.");
    expect(dpc).to.contain("        iv_local_service        = 'ZSTG_ODC_SRV'\n        iv_local_set            = iv_entity_set_name");
    expect(dpc).to.contain("    lo_client->get_entity(\n      EXPORTING\n        it_key_tab       = it_key_tab");
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    source: {service: Z}\n    properties: {Id: String}\n")).to.throw("source.service needs source.set");
  });
});

// Operations mapped to a function module or a search help: the YAML twin of
// test/fixtures/segw/zstg_mapped.iwpr.xml must give the same DPC methods
describe("tools/stg-compile: operations mapped to function modules and search helps", () => {
  const fms = loadFunctionGroups(["test/fixtures/segw"]);
  const fromYaml = compile(readFileSync("test/fixtures/segw/zstg_mapped.stg.yaml", "utf8"), {file: "zstg_mapped.stg.yaml", functionModules: fms});
  const fromTree = generate(readFileSync("test/fixtures/segw/zstg_mapped.iwpr.xml", "utf8"), {functionModules: fms, warnings: []});
  const method = (source, name) => {
    const at = source.indexOf(`  method ${name}.`);
    expect(at, name).to.be.greaterThan(-1);
    return source.slice(at, source.indexOf("  endmethod.", at));
  };

  it("carries the mapping rows in the tree", () => {
    const m = buildModel(parseIwpr(fromYaml.iwpr));
    const travel = m.entityTypes[0].entitySets[0];
    const query = travel.operations.find((o) => o.type === "Q").mapping;
    expect(query).to.include({kind: "RFC", functionName: "Z_STG_TRAVEL_LIST", functionGroup: "ZSTG_RFC", logAttr: "ET_RETURN"});
    expect(query.props.map((x) => `${x.direction} ${x.property || x.constant} ${x.dsAttPath}`)).to.deep.equal(["I TravelId IT_TRAVEL_ID_RANGE", "I 'X' IV_WITH_TEXTS", "O TravelId ET_TRAVEL\\TRAVEL_ID", "O Seats ET_TRAVEL\\SEATS"]);
    expect(query.ranges.map((r) => `${r.semantics}:${r.component}`)).to.deep.equal(["H:HIGH", "L:LOW", "O:OPTION", "S:SIGN"]);
    const read = travel.operations.find((o) => o.type === "R").mapping;
    expect(read).to.include({kind: "RFC", functionName: "Z_STG_TRAVEL_GET", destination: "NONE"});
    expect(m.entityTypes[1].entitySets[0].operations[0].mapping).to.include({kind: "SHLP", shlpName: "ZSTG_STATUS_SH", maxHitsAttr: "MAX_HITS"});
    expect(fromYaml.warnings).to.deep.equal([]);
  });

  it("gives the DPC methods segw-gen writes for the hand-made tree", () => {
    const yamlDpc = fromYaml.classes["zcl_zstg_mapped_dpc.clas.abap"];
    const treeDpc = fromTree.files["zcl_zstg_mapped_dpc.clas.abap"];
    for (const name of ["TRAVELSET_GET_ENTITY", "TRAVELSET_GET_ENTITYSET", "STATUSVHSET_GET_ENTITYSET"]) {
      expect(method(yamlDpc, name), name).to.equal(method(treeDpc, name));
    }
    expect(yamlDpc).to.contain("  interfaces /IWBEP/IF_SB_GENDPC_SHLP_DATA .");
  });

  it("says what is wrong with a mapping", () => {
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: String}\n    operations:\n      fetch: {function: Z}\n")).to.throw("use create, read, update, delete or query");
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: String}\n    operations:\n      read: {function: Z, in: {Nope: IV_X}}\n")).to.throw("names property Nope");
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: String}\n    operations:\n      read: {in: {Id: IV_X}}\n")).to.throw("needs function: or searchhelp:");
  });
});

// annotations: -> ZCL_<project>_MPC_ANN through vocab_anno_model, called by the _MPC_EXT
describe("tools/stg-compile: Fiori annotations in the model", () => {
  const r = compile(readFileSync("src/demo/zstg_demo.stg.yaml", "utf8"), {file: "zstg_demo.stg.yaml"});
  const ann = r.classes["zcl_zstg_demo_mpc_ann.clas.abap"];

  it("writes the annotation class the way a SEGW _MPC_EXT writes vocabulary annotations", () => {
    expect(Object.keys(r.classes)).to.include("zcl_zstg_demo_mpc_ann.clas.abap").and.include("zcl_zstg_demo_mpc_ann.clas.xml");
    expect(ann).to.contain("lo_target = io_vocab->create_annotations_target( 'ZSTG_DEMO_SRV.Travel/Status' ).");
    expect(ann).to.contain("lo_annotation = lo_target->create_annotation( 'com.sap.vocabularies.Common.v1.Text' ).\n    lo_annotation->create_simple_value( )->set_path( 'StatusText' ).\n    lo_nested = lo_annotation->create_annotation( 'com.sap.vocabularies.UI.v1.TextArrangement' ).\n    lo_nested->create_simple_value( )->set_enum_member_by_name( 'com.sap.vocabularies.UI.v1.TextArrangementType/TextFirst' ).");
    expect(ann).to.contain("lo_record->create_property( 'CollectionPath' )->create_simple_value( )->set_string( 'StatusVHSet' ).\n    lo_record->create_property( 'SearchSupported' )->create_simple_value( )->set_boolean( abap_true ).");
    expect(ann).to.contain("lo_item = lo_collection->create_record( 'com.sap.vocabularies.Common.v1.ValueListParameterInOut' ).\n    lo_item->create_property( 'LocalDataProperty' )->create_simple_value( )->set_property_path( 'Status' ).");
    expect(ann).to.contain("lo_collection->create_simple_value( )->set_property_path( 'Status' ).");
    expect(ann).to.contain("lo_item = lo_collection->create_record( 'com.sap.vocabularies.UI.v1.DataFieldForIntentBasedNavigation' ).");
    expect(ann).to.contain("lo_item->create_property( 'Target' )->create_simple_value( )->set_annotation_path( 'to_Bookings/@com.sap.vocabularies.UI.v1.LineItem' ).");
    expect(ann).to.contain("  iv_term      = 'com.sap.vocabularies.UI.v1.FieldGroup'\n      iv_qualifier = 'General' ).");
  });

  it("gives the _MPC_EXT a DEFINE that calls it, and the base class its labels as text symbols", () => {
    expect(r.ext["zcl_zstg_demo_mpc_ext.clas.abap"]).to.contain("    super->define( ).\n    ZCL_ZSTG_DEMO_MPC_ANN=>define( vocab_anno_model ).");
    // **Not** a sap:label annotation. Gateway adds its own from the DDIC
    // element when the type is bound to a structure, so ours landed beside it
    // and the property carried the attribute twice -- invalid XML, and a
    // browser stopped rendering our $metadata at it (A4H, 2026-09-19). The
    // corpus says so too: set_label_from_text_element 1014 times, this
    // annotation never.
    expect(r.classes["zcl_zstg_demo_mpc.clas.abap"]).to.contain("set_label_from_text_element( iv_text_element_symbol = '");
    expect(r.classes["zcl_zstg_demo_mpc.clas.abap"]).to.not.contain("iv_key      = 'label'");
    expect(r.classes["zcl_zstg_demo_mpc.clas.xml"] ?? r.files?.["zcl_zstg_demo_mpc.clas.xml"] ?? "").to.be.a("string");
  });

  it("writes the media entity and the picture annotations", () => {
    expect(r.iwpr).to.contain("<NAME>Photo</NAME>\n     <IS_MEDIA>X</IS_MEDIA>");
    const mpc = r.classes["zcl_zstg_demo_mpc.clas.abap"];
    expect(mpc).to.contain("lo_entity_type = model->create_entity_type( iv_entity_type_name = 'Photo' iv_def_entity_set = abap_false ). \"#EC NOTEXT\nlo_entity_type->set_is_media( 'X' ).  \"#EC NOTEXT");
    expect(mpc).not.to.contain("'Travel' iv_def_entity_set = abap_false ). \"#EC NOTEXT\nlo_entity_type->set_is_media");
    expect(ann).to.contain("lo_record->create_property( 'ImageUrl' )->create_simple_value( )->set_path( 'PhotoUrl' ).");
    expect(ann).to.contain("lo_annotation = lo_target->create_annotation( 'com.sap.vocabularies.UI.v1.IsImageURL' ).\n    lo_annotation->create_simple_value( )->set_boolean( abap_true ).");
  });

  it("names a target that is not in the model", () => {
    expect(() => readModel("project: X\nservice: Y\nentities:\n  A:\n    properties: {Id: String}\nannotations:\n  A/Nope: {label: x}\n")).to.throw("A has no property Nope");
  });

  // the run cockpit's terms (DSL L3 slice 6a): a coloured status, header micro
  // charts, a section hidden by a boolean, a drop-down value list
  it("writes UI.DataPoint, UI.Chart, a DataField's Criticality, UI.Hidden on a facet and fixed value lists", () => {
    const ann = compile(`project: ZX
service: ZX_SRV
entities:
  R:
    keys: [Id]
    properties: {Id: String(8), Status: String(8), Crit: Byte, Done: Int32, All: Int32, Used: Int32, Max: Int32, Warn: Int32, Narrow: Int32, NoRows: Boolean}
annotations:
  R:
    lineItem: [{value: Status, label: Status, criticality: Crit}]
    headerFacets: [{id: Final, label: Final, target: "@UI.Chart#Final"}]
    facets: [{id: Rows, label: Rows, target: "@UI.FieldGroup#Rows", hidden: NoRows}]
    dataPoints:
      Final: {value: Done, title: Final, targetValue: All}
      Budget: {value: Used, minimumValue: 0, maximumValue: Max,
        criticalityCalculation: {improvementDirection: Minimize, toleranceRangeHighValue: Warn, deviationRangeHighValue: Narrow}}
    charts:
      Final: {type: Donut, measures: [Done], measureAttributes: [{measure: Done, dataPoint: Final}]}
      Bar: {type: BarStacked, dimensions: [Status], measures: [Done]}
  R/Status: {valueListFixed: true}
`).classes["zcl_zx_mpc_ann.clas.abap"];
    const UI = "com.sap.vocabularies.UI.v1.";
    expect(ann).to.contain("lo_item->create_property( 'Criticality' )->create_simple_value( )->set_path( 'Crit' ).");
    expect(ann).to.contain(`lo_item->create_property( 'Target' )->create_simple_value( )->set_annotation_path( '@${UI}Chart#Final' ).`);
    expect(ann).to.contain(`lo_item->create_annotation( '${UI}Hidden' )->create_simple_value( )->set_path( 'NoRows' ).`);
    expect(ann).to.contain(`  iv_term      = '${UI}DataPoint'\n      iv_qualifier = 'Final' ).\n    lo_record = lo_annotation->create_record( '${UI}DataPointType' ).`);
    expect(ann).to.contain("lo_record->create_property( 'TargetValue' )->create_simple_value( )->set_path( 'All' ).");
    expect(ann).to.contain("lo_record->create_property( 'MinimumValue' )->create_simple_value( )->set_decimal( '0' ).");
    expect(ann).to.contain(`lo_item->create_property( 'ImprovementDirection' )->create_simple_value( )->set_enum_member_by_name( '${UI}ImprovementDirectionType/Minimize' ).`);
    expect(ann).to.contain("lo_item->create_property( 'ToleranceRangeHighValue' )->create_simple_value( )->set_path( 'Warn' ).");
    expect(ann).to.contain("lo_item->create_property( 'DeviationRangeHighValue' )->create_simple_value( )->set_path( 'Narrow' ).");
    expect(ann).to.contain(`lo_record->create_property( 'ChartType' )->create_simple_value( )->set_enum_member_by_name( '${UI}ChartType/Donut' ).`);
    expect(ann).to.contain(`set_enum_member_by_name( '${UI}ChartType/BarStacked' ).`);
    expect(ann).to.contain("lo_collection = lo_record->create_property( 'Dimensions' )->create_collection( ).\n    lo_collection->create_simple_value( )->set_property_path( 'Status' ).");
    expect(ann).to.contain(`lo_item->create_property( 'DataPoint' )->create_simple_value( )->set_annotation_path( '@${UI}DataPoint#Final' ).`);
    expect(ann).to.contain("lo_annotation = lo_target->create_annotation( 'com.sap.vocabularies.Common.v1.ValueListWithFixedValues' ).\n    lo_annotation->create_simple_value( )->set_boolean( abap_true ).");
  });
});

describe("tools/stg-compile: complex types", () => {
  const yaml = `
project: ZSTG_CT
service: ZSTG_CT_SRV
complexTypes:
  Address:
    properties:
      Street: String(40)
      City: {type: String(40), label: City}
  Money:
    source: {struct: ZSTG_MONEY}
    properties:
      Amount: Decimal(15,2)
      Currency: String(5)
entities:
  Customer:
    keys: [CustomerId]
    properties:
      CustomerId: String(10)
      Name: String(40)
      Address: {type: Address, field: ADDR}
      Balance: Money
functions:
  Quote:
    method: GET
    returns: {complexType: Money}
    parameters:
      CustomerId: String(10)
`;
  const result = compile(yaml, {file: "zstg_ct.stg.yaml"});

  it("carries the complex types and their properties in the tree, the complex property by reference", () => {
    const m = result.model;
    expect(m.complexTypes.map((c) => `${c.name}:${c.abapStruct}:${c.properties.map((p) => p.name).join(",")}`)).to.deep.equal(["Address::Street,City", "Money:ZSTG_MONEY:Amount,Currency"]);
    expect(m.entities[0].properties[2]).to.include({name: "Address", field: "ADDR", complexType: "Address", type: ""});
    expect(m.functions[0]).to.include({returnComplex: "Money", multiplicity: "1"});
    expect(result.iwpr).to.contain("<_-IWBEP_-I_SBO_CT>\n     <PROJECT>ZSTG_CT</PROJECT>");
    expect(result.iwpr).to.contain("<NAME>Money</NAME>\n     <MODEL>");
    expect(result.iwpr).to.contain("<ABAP_STRUCT>ZSTG_MONEY</ABAP_STRUCT>");
    expect(result.iwpr).to.match(/<NAME>Address<\/NAME>\n     <COMPLEX_TYPE>[^<]+<\/COMPLEX_TYPE>\n     <REF_TYPE>T<\/REF_TYPE>\n     <ABAP_FIELD>ADDR<\/ABAP_FIELD>/);
    expect(result.iwpr).to.contain("<RETURN_TYPE_KIND>CTYP</RETURN_TYPE_KIND>");
    // SEGW's shape: segw-tree takes it in and gives the same bytes back
    const spec = readSpec();
    expect(exportIwpr(importIwpr(result.iwpr, spec), "ZSTG_CT", spec)).to.equal(result.iwpr);
  });

  it("reads back through segw-gen and generates the complex type code SEGW writes", () => {
    const m = buildModel(parseIwpr(result.iwpr));
    expect(m.complexTypes.map((c) => c.name)).to.deep.equal(["Address", "Money"]);
    expect(m.complexTypes[1]).to.include({abapStruct: "ZSTG_MONEY"});
    expect(m.complexTypes[0].properties.map((p) => `${p.name}:${p.edmType}:${p.maxLength}`)).to.deep.equal(["Street:Edm.String:40", "City:Edm.String:40"]);
    expect(m.entityTypes[0].properties[2]).to.include({name: "Address", abapField: "ADDR", complexType: "Address"});
    expect(m.functionImports[0]).to.include({returnKind: "CTYP", returnType: "Money"});
    const mpc = result.classes["zcl_zstg_ct_mpc.clas.abap"];
    expect(mpc).to.contain("define_complextypes( ).");
    expect(mpc).to.contain("lo_complex_type = model->create_complex_type( 'Address' ). \"#EC NOTEXT");
    expect(mpc).to.contain("lo_complex_type = lo_entity_type->create_complex_property( iv_property_name = 'Address'\n                                                           iv_complex_type_name = 'Address'\n                                                           iv_abap_fieldname    = 'ADDR' ). \"#EC NOTEXT");
    expect(mpc).to.contain("lo_complex_type->bind_structure( iv_structure_name   = 'ZSTG_MONEY'");
    expect(mpc).to.contain("lo_action->set_return_complex_type( 'Money' ). \"#EC NOTEXT");
    // the entity's structure declares the complex property with the complex type's type
    expect(mpc).to.match(/begin of TS_CUSTOMER,\n(.*\n)*\s+ADDR type ADDRESS,\n/);
  });

  it("says what is wrong with a complex type", () => {
    expect(() => compile(yaml.replace("keys: [CustomerId]", "keys: [Address]"), {file: "x"})).to.throw("a complex property cannot be a key");
    expect(() => compile(yaml.replace("complexType: Money", "complexType: Price"), {file: "x"})).to.throw("complex type Price is not defined");
    expect(() => compile(yaml.replace("Balance: Money", "Balance: Price"), {file: "x"})).to.throw("unknown type Price");
  });
});

// A project folder under gen/stg whose YAML is gone is removed by the next
// --all run: the registry would otherwise keep serving a service nobody
// declares, and the build failed on a class of a pack that was no longer
// there (the user's path, 2026-09-17).
describe("stg-compile --all sweeps a project no YAML declares", () => {
  it("removes the stale folder and keeps the declared one", () => {
    const out = mkdtempSync(join(tmpdir(), "stg-all-"));
    try {
      mkdirSync(join(out, "zzz_gone"));
      writeFileSync(join(out, "zzz_gone", "zcl_zzz.clas.abap"), "");
      const report = compileAll("src/demo_odc", out);
      expect(existsSync(join(out, "zzz_gone")), "the stale folder").to.equal(false);
      expect(existsSync(join(out, "zstg_odc")), "the declared one").to.equal(true);
      expect(report.some((r) => r.removed === true && r.project === "ZZZ_GONE")).to.equal(true);
    } finally {
      rmSync(out, {recursive: true, force: true});
    }
  });
});

describe("stg-compile --all treats packs as owned source", () => {
  it("compiles only the project in the later layer regardless of path sorting", () => {
    const root = mkdtempSync(join(tmpdir(), "stg-layer-"));
    try {
      const system = join(root, "z-system");
      const user = join(root, "a-user");
      const out = join(root, "gen");
      mkdirSync(system);
      mkdirSync(user);
      const model = (service) => `project: ZLAYER\nservice: ${service}\nentities:\n  Item:\n    keys: [Id]\n    properties:\n      Id: String(8)\n`;
      writeFileSync(join(system, "project.stg.yaml"), model("ZLAYER_SYSTEM"));
      writeFileSync(join(user, "project.stg.yaml"), model("ZLAYER_USER"));
      const report = compileAll(system, out, [], [user]);
      expect(report.filter((r) => r.project === "ZLAYER")).to.have.length(1);
      const winner = report.find((r) => r.project === "ZLAYER");
      expect(winner).to.include({file: join(user, "project.stg.yaml"), service: "ZLAYER_USER"});
      expect(readFileSync(join(out, "zlayer", winner.written.find((name) => name.endsWith(".iwsv.xml"))), "utf8"))
        .to.contain("ZLAYER_USER");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("keeps a hand-written DPC_EXT beside a pack model", () => {
    const root = mkdtempSync(join(tmpdir(), "stg-pack-src-"));
    const own = join(root, "src");
    const pack = join(root, "pack");
    const out = join(root, "gen");
    mkdirSync(own, {recursive: true});
    mkdirSync(pack, {recursive: true});
    writeFileSync(join(pack, "zpack.stg.yaml"), `project: ZPACK\nservice: ZPACK_SRV\nentities:\n  Item:\n    keys: [Id]\n    properties:\n      Id: String(8)\n`);
    writeFileSync(join(pack, "zcl_zpack_dpc_ext.clas.abap"), "CLASS zcl_zpack_dpc_ext DEFINITION PUBLIC. ENDCLASS.\n");

    const report = compileAll(own, out, [], [pack]);
    const built = report.find((r) => r.project === "ZPACK");
    expect(built.kept).to.include("zcl_zpack_dpc_ext.clas.abap");
    expect(existsSync(join(out, "zpack", "zcl_zpack_dpc_ext.clas.abap"))).to.equal(false);
  });
});

describe("stg-compile --all uses configured generator order", () => {
  it("honors src when later or omitted, and projects gen onto gen/cds", () => {
    const root = mkdtempSync(join(tmpdir(), "stg-order-"));
    const previousCwd = process.cwd();
    const model = (service, project = "ZORDER") => `project: ${project}\nservice: ${service}\nentities:\n  Item:\n    keys: [Id]\n    properties:\n      Id: String(8)\n`;
    try {
      process.chdir(root);
      for (const folder of ["layer", "src", "gen/cds"]) mkdirSync(join(root, folder), {recursive: true});
      writeFileSync(join(root, "layer", "order.stg.yaml"), model("ZORDER_LAYER"));
      writeFileSync(join(root, "src", "order.stg.yaml"), model("ZORDER_SRC"));
      writeFileSync(join(root, "gen/cds", "published.stg.yaml"), model("ZPUBLISHED_SRV", "ZPUBLISHED"));
      const run = (folders) => {
        writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: folders}));
        compileConfiguredAll(root, "gen/stg", [], {});
        const folder = join(root, "gen/stg/zorder");
        return readFileSync(join(folder, readdirSync(folder).find((name) => name.endsWith(".iwsv.xml"))), "utf8");
      };
      expect(run(["layer", "src", "gen"])).to.contain("ZORDER_SRC");
      expect(existsSync(join(root, "gen/stg/zpublished")), "gen/cds model").to.equal(true);
      expect(run(["layer", "gen"])).to.contain("ZORDER_LAYER");
    } finally {
      process.chdir(previousCwd);
      rmSync(root, {recursive: true, force: true});
    }
  });
});

// The hand-written demo MPC against the generated one, FILE AGAINST FILE.
//
// The suite above compares the generator with literals written into this
// file -- `expect(mpc).to.contain("lo_property = …")` -- which is a
// transcription of the generator, not an oracle. Somebody copied fragments
// of the output in once and they have agreed with it ever since. The only
// thing here read off disk was the IWSV and IWMO pair (lines 39-40), so the
// header's claim that this file "keeps the hand-written model in step" was
// true of two XML files and of nothing else.
//
// That is the third edition of one shape in a single day: two
// implementations agreeing with each other, a real fixture edited to match
// the generator, and now an oracle transcribed into the test. None of them
// looks suspicious, and in all three the external thing stopped being
// external.
//
// So this compares `src/demo/zcl_zstg_demo_mpc.clas.abap` with what
// stg-compile makes of `src/demo/zstg_demo.stg.yaml`. The divergences it
// finds today are real and each is named below with what has to happen to
// it -- an exception with a reason can be told from a way of making the
// build green.
describe("the hand-written demo MPC and the generated one declare the same types", () => {
  /** `TYPES: BEGIN OF x … END OF x` as {name: [fields]}, plus table types. */
  const typesOf = (src) => {
    const out = {};
    for (const m of src.matchAll(/TYPES:?\s*BEGIN OF\s+([a-z0-9_]+)\s*,?([\s\S]*?)END OF\s+\1/gi)) {
      out[m[1].toLowerCase()] = [...m[2].matchAll(/^\s*([a-z0-9_]+)\s+TYPE\s/gim)].map((x) => x[1].toLowerCase());
    }
    for (const m of src.matchAll(/TYPES:?\s*([a-z0-9_]+)\s+TYPE\s+STANDARD TABLE OF\s+([a-z0-9_]+)/gi)) {
      out[m[1].toLowerCase()] = [`TABLE OF ${m[2].toLowerCase()}`];
    }
    return out;
  };

  // Measured 2026-09-19. Each entry says why it differs and what closes it.
  const KNOWN = {
    // the generator's machinery, which the hand-written class predates
    ts_text_element: "generated: the text pool types, added with set_label_from_text_element",
    tt_text_elements: "generated: the text pool types",
    ts_canceltravel: "generated: the function import's input structure",
    ts_travelcount: "generated: the function import's input structure",
    // TO FIX: the hand-written class names the model's own entity differently
    ts_status_vh: "hand: the model says StatusVH/Text, this says ts_status_vh/status_text -- bring the class to the model",
    tt_status_vh: "hand: same, the table type",
    ts_statusvh: "generated from the model; the pair of ts_status_vh above",
    tt_statusvh: "generated from the model; the pair of tt_status_vh above",
    // TO FIX: belongs in _MPC_EXT, which SEGW does not regenerate. Two of two
    // real projects in the corpus declare their deep structure there and
    // INCLUDE TYPE the flat part from the base class.
    ts_travel_deep: "hand: a deep-insert structure in a class SEGW regenerates -- move it to _MPC_EXT",
  };

  const generated = async () => {
    const {readFileSync} = await import("node:fs");
    const {compile} = await import("../tools/stg-compile.mjs");
    return compile(readFileSync("src/demo/zstg_demo.stg.yaml", "utf8"))
      .classes["zcl_zstg_demo_mpc.clas.abap"];
  };

  it("and every difference is one we have named", async () => {
    const {readFileSync} = await import("node:fs");
    const hand = typesOf(readFileSync("src/demo/zcl_zstg_demo_mpc.clas.abap", "utf8"));
    const gen = typesOf(await generated());
    expect(Object.keys(hand).length, "read nothing from the hand-written class").to.be.greaterThan(3);

    const differing = [...new Set([...Object.keys(hand), ...Object.keys(gen)])]
      .filter((k) => JSON.stringify(hand[k]) !== JSON.stringify(gen[k]))
      .filter((k) => KNOWN[k] === undefined);
    expect(differing, `types that differ and are not named in KNOWN: ${differing.join(", ")}`)
      .to.deep.equal([]);
  });

  it("and the ones we share are identical, field for field", async () => {
    const {readFileSync} = await import("node:fs");
    const hand = typesOf(readFileSync("src/demo/zcl_zstg_demo_mpc.clas.abap", "utf8"));
    const gen = typesOf(await generated());
    const shared = Object.keys(hand).filter((k) => gen[k] !== undefined);
    expect(shared.length, "no shared type at all: this would pass on nothing").to.be.greaterThan(2);
    for (const k of shared) expect(gen[k], `${k} differs`).to.deep.equal(hand[k]);
  });

  it("declares the text element container for an action when no property is labelled", () => {
    const r = compile(`project: ZSTG_INCL
service: ZSTG_INCL_SRV
entities:
  Thing:
    keys: [Id]
    properties:
      Id: String(4)
functions:
  Touch:
    method: POST
    returns: {entity: Thing}
    parameters: {Id: String(4)}
`);
    const mpc = Object.entries(r.classes).find(([f]) => /_mpc\.clas\.abap$/.test(f))[1];
    expect(mpc).to.contain("iv_text_element_container = gc_incl_name");
    expect(mpc).to.match(/constants GC_INCL_NAME type STRING/);
  });
});
