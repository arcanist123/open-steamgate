import {expect} from "chai";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {XMLParser, XMLValidator} from "fast-xml-parser";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const base = `${origin}/sap/opu/odata4/sap/ZSTG_DEMO_SRV`;
const literal = `${origin}/sap/opu/odata4/sap/ZOSD_V4_TEST`;
const guid = "12345678-1234-1234-1234-123456789abc";
const key = `Day=2026-11-07,Guid=${guid}`;
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const query = (options) => "?" + new URLSearchParams(options);
async function json(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).to.equal(200);
  return body;
}
async function schema(path) {
  const res = await fetch(path + "/$metadata");
  expect(res.status).to.equal(200);
  expect(res.headers.get("content-type")).to.contain("application/xml");
  expect(res.headers.get("odata-version")).to.equal("4.0");
  expect(res.headers.has("dataserviceversion")).to.equal(false);
  const xml = await res.text();
  expect(XMLValidator.validate(xml)).to.equal(true);
  const doc = new XMLParser({ignoreAttributes: false, attributeNamePrefix: ""}).parse(xml);
  expect(doc["edmx:Edmx"].Version).to.equal("4.0");
  expect(doc["edmx:Edmx"]["xmlns:edmx"]).to.equal("http://docs.oasis-open.org/odata/ns/edmx");
  const model = doc["edmx:Edmx"]["edmx:DataServices"].Schema;
  expect(model.xmlns).to.equal("http://docs.oasis-open.org/odata/ns/edm");
  return model;
}

describe("OData V4 read wire", () => {
  let server;
  before(async () => {
    const {zcl_oao_registry} = await import("../output/zcl_oao_registry.clas.mjs");
    await import("../output/zcl_osd_v4_test_mpc.clas.mjs");
    await import("../output/zcl_osd_v4_test_dpc.clas.mjs");
    await zcl_oao_registry.register({
      iv_service: new abap.types.String().set("ZOSD_V4_TEST"),
      iv_mpc: new abap.types.String().set("ZCL_OSD_V4_TEST_MPC"),
      iv_dpc: new abap.types.String().set("ZCL_OSD_V4_TEST_DPC"),
    });
    server = startServer(true);
  });
  after(() => server.close());

  it("serves parsed CSDL with keys, V4 types, partners and navigation bindings", async () => {
    const model = await schema(base);
    expect(model.Namespace).to.equal("ZSTG_DEMO_SRV");
    const types = array(model.EntityType);
    const travel = types.find((t) => t.Name === "Travel");
    expect(travel.Key.PropertyRef.Name).to.equal("TravelId");
    expect(array(travel.Property).find((p) => p.Name === "TravelId")).to.include({Type: "Edm.String", Nullable: "false"});
    expect(array(travel.NavigationProperty).find((p) => p.Name === "to_Bookings"))
      .to.include({Type: "Collection(ZSTG_DEMO_SRV.Booking)", Partner: "to_Travel"});
    const booking = types.find((t) => t.Name === "Booking");
    expect(array(booking.Key.PropertyRef).map((p) => p.Name)).to.deep.equal(["TravelId", "BookingId"]);
    expect(array(booking.Property).find((p) => p.Name === "FlightDate").Type).to.equal("Edm.Date");
    const set = array(model.EntityContainer.EntitySet).find((s) => s.Name === "TravelSet");
    expect(set.EntityType).to.equal("ZSTG_DEMO_SRV.Travel");
    expect(set.NavigationPropertyBinding).to.include({Path: "to_Bookings", Target: "BookingSet"});
  });

  it("retains decimal precision/scale and timestamp types from the existing MPC", async () => {
    const model = await schema(literal);
    const props = array(array(model.EntityType).find((t) => t.Name === "Literal").Property);
    expect(props.find((p) => p.Name === "Amount")).to.include({Type: "Edm.Decimal", Precision: "15", Scale: "2"});
    expect(props.find((p) => p.Name === "Moment").Type).to.equal("Edm.DateTimeOffset");
    expect(props.find((p) => p.Name === "Guid").Type).to.equal("Edm.Guid");
  });

  it("serves the V4 service document and minimal collection envelope", async () => {
    const root = await json(base + "/");
    expect(root["@odata.context"]).to.equal(base + "/$metadata");
    expect(root.value).to.deep.include({name: "TravelSet", kind: "EntitySet", url: "TravelSet"});
    const res = await fetch(base + "/TravelSet");
    expect(res.headers.get("odata-version")).to.equal("4.0");
    expect(res.headers.get("content-type")).to.contain("odata.metadata=minimal");
    const body = await res.json();
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet");
    expect(body.value.map((r) => r.TravelId)).to.deep.equal(["T0001", "T0002", "T0003", "T0009"]);
    expect(body.value[0].Seats).to.equal(2);
    expect(body.value[0]).not.to.have.any.keys("__metadata", "to_Bookings");
    expect(body).not.to.have.property("d");
  });

  it("reads single and composite keys with single-object context", async () => {
    const body = await json(base + "/TravelSet('T0003')");
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet/$entity");
    expect(body.Description).to.equal("Aarhus to Odense");
    expect(body).not.to.have.property("value");
    const booking = await json(base + "/BookingSet(TravelId='T0001',BookingId='B001')");
    expect(booking.FlightDate).to.equal("2026-09-15");
  });

  it("projects $select for collections and entities", async () => {
    const body = await json(base + "/TravelSet?$select=TravelId,Description&$top=1");
    expect(body.value[0]).to.have.all.keys("TravelId", "Description");
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet(TravelId,Description)");
    const one = await json(base + "/TravelSet('T0001')?$select=Description");
    expect(one).to.have.all.keys("@odata.context", "Description");
    expect((await json(base + "/TravelSet?$select=*&$top=1")).value[0]).to.have.property("Seats");
  });

  it("reuses select-options filters", async () => {
    const body = await json(base + "/TravelSet" + query({$filter: "Status eq 'X' or Status eq 'Z'"}));
    expect(body.value.map((r) => r.TravelId)).to.deep.equal(["T0003"]);
  });

  it("orders before paging and counts before paging", async () => {
    const body = await json(base + "/TravelSet?$orderby=TravelId%20desc&$top=2&$skip=1&$count=true");
    expect(body.value.map((r) => r.TravelId)).to.deep.equal(["T0003", "T0002"]);
    expect(body["@odata.count"]).to.equal(4);
    const filtered = await json(base + "/TravelSet" + query({$filter: "Status eq 'A'", $top: "1", $count: "true"}));
    expect(filtered.value).to.have.length(1);
    expect(filtered["@odata.count"]).to.equal(3);
  });

  it("handles zero top, empty collections, skip beyond end, and count=false", async () => {
    const zero = await json(base + "/TravelSet?$top=0&$count=true");
    expect(zero.value).to.deep.equal([]);
    expect(zero["@odata.count"]).to.equal(4);
    const empty = await json(base + "/TravelSet" + query({$filter: "TravelId eq 'NONE'", $count: "true"}));
    expect(empty.value).to.deep.equal([]);
    expect(empty["@odata.count"]).to.equal(0);
    const skip = await json(base + "/TravelSet?$skip=999&$count=false");
    expect(skip.value).to.deep.equal([]);
    expect(skip).not.to.have.property("@odata.count");
  });

  it("serves filtered /$count as plain text, independent of paging", async () => {
    const res = await fetch(base + "/TravelSet/$count" + query({$filter: "Status eq 'A'", $top: "0", $skip: "100"}));
    expect(res.status).to.equal(200);
    expect(res.headers.get("content-type")).to.contain("text/plain");
    expect(await res.text()).to.equal("3");
  });

  it("expands to-many as arrays and to-one as objects, including with $select", async () => {
    const list = await json(base + "/TravelSet?$expand=to_Bookings&$top=1&$select=TravelId");
    expect(list.value[0].to_Bookings.map((r) => r.BookingId)).to.deep.equal(["B001", "B002"]);
    expect(list.value[0].to_Bookings[1].Customer).to.equal("Grace Hopper");
    expect(list.value[0].to_Bookings[0]).not.to.have.property("__metadata");
    const one = await json(base + "/BookingSet(TravelId='T0002',BookingId='B001')?$expand=to_Travel");
    expect(one.to_Travel.Description).to.equal("Copenhagen to Aarhus");
    const empty = await json(base + "/TravelSet('T0009')?$expand=to_Bookings");
    expect(empty.to_Bookings).to.deep.equal([]);
  });

  it("accepts bare V4 date and GUID keys and writes typed V4 JSON values", async () => {
    const body = await json(literal + `/LiteralSet(${key})`);
    expect(body.Day).to.equal("2026-11-07");
    expect(body.Guid).to.equal(guid);
    expect(body.Amount).to.equal(123.45);
    expect(body.Moment).to.equal("2026-11-07T12:30:45Z");
    expect(body.Name).to.equal("O'Brien, (a=b)  test");
  });

  it("normalizes bare V4 dates, GUIDs and UTC/offset timestamps for $filter", async () => {
    for (const filter of ["Day eq 2026-11-07", `Guid eq ${guid} and Day eq 2026-11-07`,
      "Moment eq 2026-11-07T12:30:45Z and Day eq 2026-11-07", "Moment eq 2026-11-07T14:30:45+02:00 and Day eq 2026-11-07"]) {
      const body = await json(literal + "/LiteralSet" + query({$filter: filter}));
      expect(body.value, filter).to.have.length(1);
      expect(body.value[0].Day).to.equal("2026-11-07");
    }
  });

  it("preserves escaped quotes, commas, parentheses, equals and spaces in keys and filter strings", async () => {
    for (const key of ["'O''Brien, (a=b)  test'", "Name='O''Brien, (a=b)  test'"]) {
      const one = await json(literal + "/TextSet(" + encodeURIComponent(key) + ")");
      expect(one.Name).to.equal("O'Brien, (a=b)  test");
    }
    const body = await json(literal + "/LiteralSet" + query({$filter: "Name eq 'O''Brien, (a=b)  test'"}));
    expect(body.value).to.have.length(1);
    expect(body.value[0].Name).to.equal("O'Brien, (a=b)  test");
  });

  it("serves SADL/CDS and YAML-compiled services through the same registration", async () => {
    const sadl = `${origin}/sap/opu/odata4/sap/ZSTG_SADL_SRV`;
    await schema(sadl);
    const body = await json(sadl + "/Zc_Stg_TravelSet" + query({$filter: "STATUS eq 'A'", $orderby: "TRAVELID desc", $select: "TRAVELID,STATUS", $top: "1", $count: "true"}));
    expect(body.value[0]).to.include({TRAVELID: "T0009", STATUS: "A"});
    expect(body["@odata.count"]).to.equal(3);
    const yaml = `${origin}/sap/opu/odata4/sap/ZOSD_TEST_SRV`;
    await schema(yaml);
    expect((await json(yaml + "/ItemSet?$top=1")).value).to.be.an("array");
  });

  for (const [path, status] of [
    ["/MissingSet", 404], ["/TravelSet('NONE')", 404], ["/TravelSet?$top=-1", 400],
    ["/TravelSet?$skip=oops", 400], ["/TravelSet?$count=allpages", 400],
    ["/TravelSet?$select=Missing", 400], ["/TravelSet?$orderby=Missing", 400],
    ["/TravelSet?$orderby=TravelId%20sideways", 400], ["/TravelSet?$filter=Seats%20eq", 400],
    ["/TravelSet?$expand=to_Bookings($top=1)", 501], ["/TravelSet?$expand=to_Bookings/to_Travel", 501],
    ["/TravelSet?$apply=aggregate(Seats)", 501], ["/TravelSet(TravelId='T0001',TravelId='T0002')", 400],
    ["/BookingSet(TravelId='T0001')", 400], ["/TravelSet()", 400],
    ["/TravelSet?$top=1&$top=2", 400],
  ]) {
    it(`returns a V4 error and ${status} for ${path}`, async () => {
      const res = await fetch(base + path);
      expect(res.status).to.equal(status);
      const body = await res.json();
      expect(body.error.code).to.be.a("string").and.not.empty;
      expect(body.error.message).to.be.a("string").and.not.empty;
      expect(res.headers.get("odata-version")).to.equal("4.0");
    });
  }

  it("rejects V2 typed literals, unknown services, and writes without changing data", async () => {
    for (const path of [`/LiteralSet(Day=datetime'2026-11-07',Guid=${guid})`,
      "/LiteralSet" + query({$filter: "Day eq datetime'2026-11-07'"}),
      `/LiteralSet(Day=2026-11-07,Guid=guid'${guid}')`]) {
      const res = await fetch(literal + path);
      expect(res.status).to.equal(400);
      expect((await res.json()).error.message).to.be.a("string");
    }
    const missing = await fetch(`${origin}/sap/opu/odata4/sap/NO_SUCH_SERVICE/$metadata`);
    expect(missing.status).to.equal(404);
    expect((await missing.json()).error.message).to.be.a("string");
    for (const method of ["POST", "PATCH", "DELETE"]) {
      const res = await fetch(base + "/TravelSet('T0001')", {method});
      expect(res.status).to.equal(405);
      expect(res.headers.get("allow")).to.equal("GET");
      expect((await res.json()).error.message).to.be.a("string");
    }
    expect((await json(base + "/TravelSet('T0001')")).Description).to.equal("Berlin to Copenhagen");
  });
});

// This goes through the parent proxy and real child, so losing the V4
// forwarding hook cannot hide behind a passing inline-handler test.
describe("OData V4 child routing", () => {
  it("serves V4 metadata/read/count and V2 reads through the child host", async function () {
    this.timeout(150000);
    const {stdout} = await promisify(execFile)(process.execPath,
      [fileURLToPath(new URL("./v4/child.mjs", import.meta.url))],
      {env: process.env, timeout: 135000, maxBuffer: 2 * 1024 * 1024});
    expect(stdout).to.contain("PASS: V4 metadata/read/count and V2 read through the child host");
  });
});
