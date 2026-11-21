// R10 (docs/rap-runtime.md, "Path elements"): `_A._B.Element as X [:
// localized]` in a CDS view. Before R10 such an element was taken for an
// exposed association and silently not served; now it is a calculated
// element, typed from the element the path ends in, filled after the read
// by a generated class (tools/cds-path.mjs). The views here are the demo's
// tables; the flight's (_SupplementText.Description : localized) are
// test/rap-r10.mjs.
import {expect} from "chai";
import * as abaplint from "@abaplint/core";
import {readFileSync} from "node:fs";
import {parseDDLS, tableSourceClass} from "../tools/cds2ddic.mjs";
import {resolveTree} from "../tools/cds-tree.mjs";
import {pathClass} from "../tools/cds-path.mjs";

const DDLS_XML = (name) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DDLS"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DDLS>
<DDLNAME>${name}</DDLNAME><DDLANGUAGE>E</DDLANGUAGE><DDTEXT>t</DDTEXT></DDLS></asx:values></asx:abap></abapGit>`;

function views(sources) {
  const reg = new abaplint.Registry();
  for (const t of ["zstg_demo", "zstg_demo_bk"]) {
    reg.addFile(new abaplint.MemoryFile(`${t}.tabl.xml`, readFileSync(`src/ddic/${t}.tabl.xml`, "utf8")));
  }
  for (const [name, text] of Object.entries(sources)) {
    reg.addFile(new abaplint.MemoryFile(`${name.toLowerCase()}.ddls.asddls`, text));
    reg.addFile(new abaplint.MemoryFile(`${name.toLowerCase()}.ddls.xml`, DDLS_XML(name)));
  }
  reg.parse();
  const parsed = Object.keys(sources).map((name) => parseDDLS(reg.getObjectsByType("DDLS").find((x) => x.getName().toUpperCase() === name), reg));
  resolveTree(parsed, new Map(parsed.map((v) => [v.name.toUpperCase(), v])));
  return Object.fromEntries(parsed.map((v) => [v.name, v]));
}

const TRAVEL = `define view entity ZC_PTRAVEL as select from zstg_demo
{ key travel_id as TravelId, status as Status }`;
const BOOKING = `define view entity ZC_PBOOKING as select from zstg_demo_bk
  association [1..1] to ZC_PTRAVEL as _Travel on $projection.TravelId = _Travel.TravelId
{ key travel_id as TravelId, key booking_id as BookingId,
  _Travel.Status as TravelStatus,
  _Travel }`;

describe("CDS path elements (R10)", () => {
  it("are calculated elements typed from the element they end in", () => {
    const all = views({ZC_PTRAVEL: TRAVEL, ZC_PBOOKING: BOOKING});
    const f = all.ZC_PBOOKING.fields.find((x) => x.name === "TRAVELSTATUS");
    expect(f, "served, not taken for an association").to.not.equal(undefined);
    expect(f.virtual).to.equal(true);
    expect(f.calculatedBy).to.match(/^ZCL_STG_CDS_ZC_PBOOKING_P$/);
    expect(f.path.steps).to.deep.equal([{assoc: "_Travel", target: "ZC_PTRAVEL", sqlView: "ZC_PTRAVEL",
      pairs: [{source: "TRAVELID", target: "TRAVELID"}], language: undefined}]);
    const status = all.ZC_PTRAVEL.fields.find((x) => x.name === "STATUS");
    expect(f.abapType).to.equal(status.typeABAP);
    expect(f.edm).to.equal(status.edm);
    expect(all.ZC_PBOOKING.exposedAssociations).to.deep.equal(["_Travel"]);
  });

  it("writes the class that fills them: one SELECT SINGLE per hop, a draft's first hop from the draft table", () => {
    const all = views({ZC_PTRAVEL: TRAVEL, ZC_PBOOKING: BOOKING});
    const abap = pathClass(all.ZC_PBOOKING);
    expect(abap).to.match(/CLASS zcl_stg_cds_zc_pbooking_p DEFINITION/);
    expect(abap).to.match(/INTERFACES if_sadl_exit_calc_element_read\./);
    expect(abap).to.match(/zcl_stg_cds_path=>is_draft\( cs_row \)/);
    expect(abap).to.match(/SELECT SINGLE \* FROM \(lv_table\) INTO CORRESPONDING FIELDS OF ls_h1\n\s+WHERE travelid = <lv_k0>\./);
    expect(abap).to.match(/<lv_out> = ls_h1-status\./);
  });

  it("does not serve a path it cannot resolve, and says which hop broke", () => {
    const all = views({ZC_PBOOKING: BOOKING.replace("ZC_PTRAVEL as _Travel", "ZC_NOWHERE as _Travel")});
    expect(all.ZC_PBOOKING.fields.some((x) => x.name === "TRAVELSTATUS")).to.equal(false);
    expect(all.ZC_PBOOKING.droppedPaths).to.deep.equal([{name: "TRAVELSTATUS", why: "_Travel ends in ZC_NOWHERE, which is not a generated CDS view"}]);
  });

  it("does not serve a path over a to-many hop without a language condition (an arbitrary row)", () => {
    const all = views({ZC_PTRAVEL: `define view entity ZC_PTRAVEL as select from zstg_demo
  association [0..*] to ZC_PBOOKING as _Booking on $projection.TravelId = _Booking.TravelId
{ key travel_id as TravelId, status as Status, _Booking.BookingId as AnyBooking, _Booking }`, ZC_PBOOKING: BOOKING});
    expect(all.ZC_PTRAVEL.fields.some((x) => x.name === "ANYBOOKING")).to.equal(false);
    expect(all.ZC_PTRAVEL.droppedPaths[0].why).to.match(/is to-many \[0\.\.\*\] without a language condition/);
  });

  // #917 follow-up: `[1]` is `[0..1]`. Read as `[1..*]` (the regex took the
  // one number for the minimum) a path over it was refused as to-many
  it("reads the cardinality [1] as [0..1], so a path over it is to-one", () => {
    const all = views({ZC_PTRAVEL: TRAVEL, ZC_PBOOKING: BOOKING.replace("[1..1]", "[1]")});
    const a = all.ZC_PBOOKING.associations.find((x) => x.alias === "_Travel");
    expect([a.min, a.max]).to.deep.equal(["0", "1"]);
    expect(all.ZC_PBOOKING.fields.some((x) => x.name === "TRAVELSTATUS"), "the path is served").to.equal(true);
    const many = views({ZC_PTRAVEL: TRAVEL, ZC_PBOOKING: BOOKING.replace("[1..1]", "[*]")});
    const m = many.ZC_PBOOKING.associations.find((x) => x.alias === "_Travel");
    expect([m.min, m.max]).to.deep.equal(["0", "*"]);
  });
});

// #917 follow-up: a table whose row has an include group (every draft
// table's admin include, an append structure's /dmo/... group) is updated
// with UPDATE ... SET over its named columns; UPDATE dbtab FROM answers 4 at
// runtime (ANOMALY-2026-11-11-update-include-group), and DELETE + INSERT in
// its place would be no UPDATE for a trigger or a foreign key
describe("table classes of a table with an include group (R10)", () => {
  const draft = {name: "/DMO/AGENCY_D", fields: [{name: "AGENCYID", key: true}, {name: "NAME"}, {name: "DRAFTUUID"}],
    keyColumns: ["agencyid"], components: ["mandt", "agencyid", "name", "%admin", "draftuuid"], associations: []};
  const method = (abap, name) => {
    const start = abap.indexOf(`METHOD zif_stg_cds_source~${name}.`);
    return abap.slice(start, abap.indexOf("ENDMETHOD.", start));
  };

  it("updates with UPDATE ... SET over the named columns, never DELETE + INSERT", () => {
    const update = method(tableSourceClass(draft), "update");
    expect(update).to.match(/UPDATE \/dmo\/agency_d SET name = ls_row-name\s+draftuuid = ls_row-draftuuid\s+WHERE agencyid = ls_row-agencyid\./);
    expect(update).to.not.match(/\bDELETE\b/);
    expect(update).to.not.match(/\bINSERT\b/);
    expect(update).to.not.match(/UPDATE \S+ FROM/);
  });

  it("keeps UPDATE ... FROM for a table whose components are all plain names", () => {
    const plain = {...draft, name: "ZSTG_PLAIN", components: ["mandt", "agencyid", "name", "draftuuid"]};
    expect(method(tableSourceClass(plain), "update")).to.match(/UPDATE zstg_plain FROM ls_row\./);
  });
});

