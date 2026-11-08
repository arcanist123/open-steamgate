import {expect} from "chai";
import {execFile} from "node:child_process";
import {promisify} from "node:util";
import {fileURLToPath} from "node:url";
import {XMLParser, XMLValidator} from "fast-xml-parser";
import {createHash} from "node:crypto";
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
async function send(path, method, body, headers = {}) {
  const init = {method, headers: {...headers}};
  if (body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = typeof body === "string" ? body : JSON.stringify(body);
  }
  return fetch(path, init);
}
// the argument of EZOSD_V4_LOCK: SHA-256 of service|set|canonical key
const lockInput = (service, set, key) => ({mode_zosd_v4_lock: "E",
  lockhash: createHash("sha256").update(`${service}|${set}|${key}`).digest("hex").toUpperCase()});
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

  it("rejects same-property OR intersections without returning lossy IDs or counts", async () => {
    for (const filter of [
      "(TravelId ge 'T0002' or TravelId eq 'T0009') and TravelId le 'T0003'",
      "TravelId le 'T0003' and (TravelId ge 'T0002' or TravelId eq 'T0009')",
      "(TravelId eq 'T0002' or TravelId eq 'T0009') and TravelId ge 'T0003'",
    ]) {
      for (const path of ["/TravelSet", "/TravelSet/$count"]) {
        const res = await fetch(base + path + query({$filter: filter, $count: "true"}));
        expect(res.status, filter).to.equal(501);
        const body = await res.json();
        expect(body).not.to.have.any.keys("value", "@odata.count");
        expect(body.error.message).to.be.a("string");
      }
    }
    const safe = await json(base + "/TravelSet" + query({
      $filter: "(TravelId eq 'T0002' or TravelId eq 'T0009') and Status eq 'A'", $count: "true",
    }));
    expect(safe.value.map((r) => r.TravelId)).to.deep.equal(["T0002", "T0009"]);
    expect(safe["@odata.count"]).to.equal(2);
    const range = await json(base + "/TravelSet" + query({
      $filter: "TravelId ge 'T0002' and TravelId le 'T0003'", $count: "true",
    }));
    expect(range.value.map((r) => r.TravelId)).to.deep.equal(["T0002", "T0003"]);
    expect(range["@odata.count"]).to.equal(2);
  });

  it("rejects numeric and quoted temporal filter literals before conversion", async () => {
    for (const filter of ["Day eq 20261107", "Day eq '20260230'", "Moment eq '20261107253045'",
      "Day EQ 20261107", "Day eq '20261107'", "Day eq '2026-11-07'", "Moment eq 20261107123045",
      "Moment eq '2026-11-07T12:30:45Z'", "Day eq null",
      "Day ge 2026-11-01 and Day le '20261107'", "not (Day eq 20261107)"]) {
      const res = await fetch(literal + "/LiteralSet" + query({$filter: filter}));
      expect(res.status, filter).to.equal(400);
      expect((await res.json()).error.message).to.be.a("string");
    }
  });

  it("rejects function filters whose semantics select-options cannot preserve", async () => {
    for (const filter of ["tolower(Status) eq 'a'", "toupper(Status) eq 'A'", "trim(Status) eq 'A'",
      "tolower (Status) eq 'a'", "tolower(toupper(Status)) eq 'a'"]) {
      const res = await fetch(base + "/TravelSet" + query({$filter: filter}));
      expect(res.status, filter).to.equal(501);
      expect((await res.json()).error.message).to.be.a("string");
    }
    const body = await json(base + "/TravelSet" + query({$filter: "Description eq 'tolower(Status)'"}));
    expect(body.value).to.deep.equal([]);
  });

  it("serializes leading-zero and initial NUMC properties as JSON numbers", async () => {
    const body = await json(literal + "/LiteralSet");
    expect(body.value.map((r) => r.NumericText)).to.deep.equal([12, 0]);
    expect(body.value.map((r) => r.DecimalText)).to.deep.equal([12, 0]);
  });

  it("preserves Decimal and Int64 precision while canonicalizing numeric text", async () => {
    const {zcl_osd_v4_json} = await import("../output/zcl_osd_v4_json.clas.mjs");
    for (const [input, type, expected] of [
      ["0009223372036854775807", "Edm.Int64", "9223372036854775807"],
      ["-00012345678901234567890.0012300", "Edm.Decimal", "-12345678901234567890.0012300"],
      ["+00012.50", "Edm.Decimal", "12.50"],
      ["0000.000", "Edm.Decimal", "0.000"],
      ["00012.5E+03", "Edm.Double", "12.5E+03"],
    ]) {
      const result = await zcl_osd_v4_json.value({
        iv_value: new abap.types.String().set(input),
        iv_type: new abap.types.String().set(type),
      });
      expect(result.get()).to.equal(expected);
      expect(() => JSON.parse(result.get())).not.to.throw();
    }
  });

  it("rejects mismatched temporal keys and invalid calendar, clock and offset ranges", async () => {
    for (const path of [
      `/LiteralSet(Day=2026-11-07T12:30:45Z,Guid=${guid})`,
      "/LiteralSet" + query({$filter: "Day eq 2026-11-07T12:30:45Z"}),
      "/LiteralSet" + query({$filter: "Moment eq 2026-11-07"}),
      ...["2026-02-29", "2026-04-31", "0000-01-01", "2026-00-01", "2026-13-01"].map(
        (day) => `/LiteralSet(Day=${day},Guid=${guid})`),
      ...["2026-11-07T25:30:45Z", "2026-11-07T12:60:45Z", "2026-11-07T12:30:60Z",
        "2026-11-07T12:30:45+14:01", "2026-11-07T12:30:45-15:00", "2026-02-29T12:30:45Z"].map(
        (moment) => "/LiteralSet" + query({$filter: `Moment eq ${moment}`})),
    ]) {
      const res = await fetch(literal + path);
      expect(res.status, path).to.equal(400);
      expect((await res.json()).error.message).to.be.a("string");
    }
    const leap = await json(literal + "/LiteralSet" + query({$filter: "Day eq 2024-02-29"}));
    expect(leap.value).to.deep.equal([]);
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

  it("rejects V2 typed literals, unknown services, and writes the resource does not take", async () => {
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
    for (const [path, method, allow] of [
      ["/TravelSet('T0001')", "POST", "GET, PATCH, PUT, DELETE"],
      ["/TravelSet", "PATCH", "GET, POST"], ["/TravelSet", "DELETE", "GET, POST"],
      ["/$metadata", "POST", "GET"], ["/TravelSet/$count", "POST", "GET"], ["/$batch", "GET", "POST"],
    ]) {
      const res = await fetch(base + path, {method, headers: {"content-type": "application/json"}, body: method === "GET" ? undefined : "{}"});
      expect(res.status, `${method} ${path}`).to.equal(405);
      expect(res.headers.get("allow")).to.equal(allow);
      expect((await res.json()).error.message).to.be.a("string");
    }
    // the model refuses: LiteralSet is not creatable, so the DPC is never asked
    const refused = await send(literal + "/LiteralSet", "POST", {Name: "x"});
    expect(refused.status).to.equal(405);
    expect((await json(base + "/TravelSet('T0001')")).Description).to.equal("Berlin to Copenhagen");
  });

  describe("writes", () => {
    it("creates with 201, a V4 entity body and a Location; return=minimal answers 204", async () => {
      const res = await send(base + "/TravelSet", "POST",
        {"@odata.type": "#ZSTG_DEMO_SRV.Travel", TravelId: "T0100", Description: "V4 trip", Status: "A", Seats: 3});
      expect(res.status).to.equal(201);
      expect(res.headers.get("odata-version")).to.equal("4.0");
      expect(res.headers.get("location")).to.equal(base + "/TravelSet('T0100')");
      const body = await res.json();
      expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet/$entity");
      expect(body).to.include({TravelId: "T0100", Description: "V4 trip", Seats: 3});
      expect(body).not.to.have.property("@odata.etag");
      const minimal = await send(base + "/TravelSet", "POST", {TravelId: "T0101", Seats: 1}, {prefer: "return=minimal"});
      expect(minimal.status).to.equal(204);
      expect(minimal.headers.get("location")).to.equal(base + "/TravelSet('T0101')");
      expect(minimal.headers.get("odata-entityid")).to.equal(base + "/TravelSet('T0101')");
      expect(minimal.headers.get("preference-applied")).to.equal("return=minimal");
      expect(await minimal.text()).to.equal("");
      expect((await json(base + "/TravelSet('T0101')")).Seats).to.equal(1);
      expect((await send(base + "/TravelSet('T0101')", "DELETE")).status).to.equal(204);
    });

    it("PATCH merges the properties sent, PUT replaces the entity", async () => {
      const patch = await send(base + "/TravelSet('T0100')", "PATCH", {Description: "patched"});
      expect(patch.status).to.equal(204);
      expect(await json(base + "/TravelSet('T0100')")).to.include({Description: "patched", Seats: 3, Status: "A"});
      const put = await send(base + "/TravelSet('T0100')", "PUT", {Description: "replaced"});
      expect(put.status).to.equal(204);
      expect(await json(base + "/TravelSet('T0100')")).to.include({TravelId: "T0100", Description: "replaced", Seats: 0, Status: ""});
      // a key in the body cannot move the update to another entity
      const moved = await send(base + "/TravelSet('T0100')", "PATCH", {TravelId: "T0001", Seats: 7},
        {prefer: "return=representation"});
      expect(moved.status).to.equal(200);
      expect(moved.headers.get("preference-applied")).to.equal("return=representation");
      const body = await moved.json();
      expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet/$entity");
      expect(body).to.include({TravelId: "T0100", Seats: 7});
      expect((await json(base + "/TravelSet('T0001')")).Description).to.equal("Berlin to Copenhagen");
    });

    it("rejects unknown properties, mistyped values and deep payloads before the DPC", async () => {
      for (const [payload, status] of [[{Nope: 1}, 400], [{Seats: "many"}, 400], [{Seats: true}, 400],
        [{to_Bookings: [{BookingId: "B9"}]}, 501], [{"to_Bookings@odata.bind": ["BookingSet(TravelId='T0001',BookingId='B001')"]}, 501]]) {
        const res = await send(base + "/TravelSet('T0100')", "PATCH", payload);
        expect(res.status, JSON.stringify(payload)).to.equal(status);
        expect((await res.json()).error.message).to.be.a("string");
      }
      expect((await send(base + "/TravelSet('T0100')", "PATCH", "not json")).status).to.equal(400);
      expect((await send(base + "/TravelSet('NONE')", "PATCH", {Seats: 1})).status).to.equal(404);
      expect((await json(base + "/TravelSet('T0100')")).Seats).to.equal(7);
    });

    it("deletes with 204 and the entity is gone", async () => {
      expect((await send(base + "/TravelSet('T0100')", "DELETE")).status).to.equal(204);
      expect((await fetch(base + "/TravelSet('T0100')")).status).to.equal(404);
      expect((await send(base + "/TravelSet('T0100')", "DELETE")).status).to.equal(404);
      expect((await json(base + "/TravelSet?$count=true&$top=0"))["@odata.count"]).to.equal(4);
    });
  });

  describe("ETags", () => {
    it("announces Core.OptimisticConcurrency for an entity set with set_as_etag", async () => {
      const model = await schema(literal);
      const set = array(model.EntityContainer.EntitySet).find((s) => s.Name === "NoteSet");
      expect(set.Annotation.Term).to.equal("Core.OptimisticConcurrency");
      expect(set.Annotation.Collection.PropertyPath).to.equal("Version");
      const plain = await schema(base);
      expect(array(plain.EntityContainer.EntitySet).every((s) => s.Annotation === undefined)).to.equal(true);
    });

    it("emits @odata.etag and the ETag header on create and reads", async () => {
      const res = await send(literal + "/NoteSet", "POST", {Id: "N1", Text: "one"});
      expect(res.status).to.equal(201);
      expect(res.headers.get("etag")).to.equal('W/"1"');
      expect((await res.json())["@odata.etag"]).to.equal('W/"1"');
      const one = await fetch(literal + "/NoteSet('N1')");
      expect(one.headers.get("etag")).to.equal('W/"1"');
      expect((await one.json())).to.include({"@odata.etag": 'W/"1"', Version: 1});
      const list = await json(literal + "/NoteSet");
      expect(list.value[0]["@odata.etag"]).to.equal('W/"1"');
      expect(Object.keys(list.value[0])[0]).to.equal("@odata.etag");
      expect((await fetch(base + "/TravelSet('T0001')")).headers.get("etag")).to.equal(null);
    });

    it("requires If-Match: 428 without, 412 on a stale tag, * and the current tag pass", async () => {
      const url = literal + "/NoteSet('N1')";
      for (const method of ["PATCH", "PUT", "DELETE"]) {
        const res = await send(url, method, method === "DELETE" ? undefined : {Text: "x"});
        expect(res.status, method).to.equal(428);
        expect((await res.json()).error.message).to.contain("If-Match");
        const stale = await send(url, method, method === "DELETE" ? undefined : {Text: "x"}, {"if-match": 'W/"9"'});
        expect(stale.status, method).to.equal(412);
      }
      expect((await json(url)).Text).to.equal("one");
      const ok = await send(url, "PATCH", {Text: "two"}, {"if-match": 'W/"1"'});
      expect(ok.status).to.equal(204);
      expect(ok.headers.get("etag")).to.equal('W/"2"');
      const star = await send(url, "PUT", {Text: "three"}, {"if-match": "*"});
      expect(star.status).to.equal(204);
      expect(star.headers.get("etag")).to.equal('W/"3"');
      const list = await send(url, "PATCH", {Text: "four"}, {"if-match": 'W/"8", W/"3"'});
      expect(list.status).to.equal(204);
      expect(await json(url)).to.include({Text: "four", Version: 4});
      expect((await send(url, "DELETE", undefined, {"if-match": 'W/"3"'})).status).to.equal(412);
      expect((await send(url, "DELETE", undefined, {"if-match": 'W/"4"'})).status).to.equal(204);
      expect((await fetch(url)).status).to.equal(404);
    });

    it("refuses a specific If-Match on an entity without an ETag", async () => {
      const res = await send(base + "/TravelSet('T0001')", "PATCH", {Seats: 9}, {"if-match": 'W/"1"'});
      expect(res.status).to.equal(412);
      expect((await json(base + "/TravelSet('T0001')")).Seats).not.to.equal(9);
    });
  });

  describe("JSON $batch", () => {
    const batch = (requests, headers = {}) => fetch(base + "/$batch", {
      method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({requests}),
    });
    const travel = (id, extra = {}) => ({TravelId: id, Description: "batch " + id, Status: "A", Seats: 2, ...extra});

    it("answers 501 for a multipart batch and 400 for a malformed one", async () => {
      const multipart = await fetch(base + "/$batch", {method: "POST",
        headers: {"content-type": "multipart/mixed; boundary=b"}, body: "--b--"});
      expect(multipart.status).to.equal(501);
      expect((await multipart.json()).error.message).to.contain("Multipart");
      for (const requests of [
        [{id: "1", method: "GET", url: "TravelSet", dependsOn: ["2"]}, {id: "2", method: "GET", url: "TravelSet"}],
        [{id: "1", method: "GET", url: "TravelSet"}, {id: "1", method: "GET", url: "TravelSet"}],
        [{id: "1", method: "GET", url: "TravelSet", atomicityGroup: "g"}, {id: "2", method: "GET", url: "TravelSet"},
          {id: "3", method: "GET", url: "TravelSet", atomicityGroup: "g"}],
        [{id: "1", method: "GET"}],
      ]) {
        const res = await batch(requests);
        expect(res.status, JSON.stringify(requests)).to.equal(400);
      }
    });

    it("commits one atomicity group and rolls the failing one back as a whole", async () => {
      const res = await batch([
        {id: "1", atomicityGroup: "good", method: "POST", url: "TravelSet", body: travel("T0200")},
        {id: "2", atomicityGroup: "good", method: "PATCH", url: "TravelSet('T0200')", body: {Seats: 5}},
        {id: "3", atomicityGroup: "bad", method: "POST", url: "TravelSet", body: travel("T0201")},
        {id: "4", atomicityGroup: "bad", method: "POST", url: "TravelSet", body: travel("T0001")},
        {id: "5", atomicityGroup: "bad", method: "DELETE", url: "TravelSet('T0002')"},
        {id: "6", method: "GET", url: "TravelSet('T0200')"},
      ]);
      expect(res.status).to.equal(200);
      expect(res.headers.get("content-type")).to.contain("application/json");
      const {responses} = await res.json();
      expect(responses.map((r) => [r.id, r.atomicityGroup, r.status])).to.deep.equal([
        ["1", "good", 201], ["2", "good", 204], ["3", "bad", 424], ["4", "bad", 400], ["5", "bad", 424],
        ["6", undefined, 200],
      ]);
      expect(res.headers.get("preference-applied")).to.equal(null);
      expect(responses[0].headers.location).to.equal(base + "/TravelSet('T0200')");
      expect(responses[0].body.TravelId).to.equal("T0200");
      expect(responses[3].body.error.message).to.contain("T0001");
      expect(await json(base + "/TravelSet('T0200')")).to.include({Seats: 5});
      expect((await fetch(base + "/TravelSet('T0201')")).status).to.equal(404);
      expect((await fetch(base + "/TravelSet('T0002')")).status).to.equal(200);
      expect((await send(base + "/TravelSet('T0200')", "DELETE")).status).to.equal(204);
    });

    it("continues after a failed group with odata.continue-on-error", async () => {
      const res = await batch([
        {id: "1", atomicityGroup: "bad", method: "POST", url: "TravelSet", body: travel("T0202")},
        {id: "2", atomicityGroup: "bad", method: "POST", url: "TravelSet", body: travel("T0001")},
        {id: "3", atomicityGroup: "good", method: "POST", url: "TravelSet", body: travel("T0203")},
        {id: "4", method: "GET", url: "TravelSet('T0202')"},
        {id: "5", method: "GET", url: "TravelSet('T0203')", dependsOn: ["good"]},
        {id: "6", method: "DELETE", url: "TravelSet('T0203')", dependsOn: ["bad"]},
      ], {prefer: "odata.continue-on-error"});
      expect(res.headers.get("preference-applied")).to.equal("odata.continue-on-error");
      const {responses} = await res.json();
      expect(responses.map((r) => r.status)).to.deep.equal([424, 400, 201, 404, 200, 424]);
      expect(responses[4].body.Description).to.equal("batch T0203");
      expect((await fetch(base + "/TravelSet('T0202')")).status).to.equal(404);
      expect((await send(base + "/TravelSet('T0203')", "DELETE")).status).to.equal(204);
    });

    it("orders by dependsOn and resolves $<id> to the entity a request created", async () => {
      const res = await batch([
        {id: "new", method: "POST", url: "TravelSet", body: travel("T0300")},
        {id: "upd", method: "PATCH", url: "$new", dependsOn: ["new"], body: {Description: "through $new"}},
        {id: "get", method: "GET", url: "$new?$select=Description", dependsOn: ["upd", "new"]},
        {id: "del", method: "DELETE", url: "$new", dependsOn: ["get", "new"], headers: {"If-Match": "*"}},
      ]);
      const {responses} = await res.json();
      expect(responses.map((r) => r.status)).to.deep.equal([201, 204, 200, 204]);
      expect(responses[2].body).to.include({Description: "through $new"});
      expect(responses[2].body["@odata.context"]).to.equal(base + "/$metadata#TravelSet(Description)/$entity");
      expect((await fetch(base + "/TravelSet('T0300')")).status).to.equal(404);
      const failed = await batch([
        {id: "dup", method: "POST", url: "TravelSet", body: travel("T0001")},
        {id: "after", method: "PATCH", url: "$dup", dependsOn: ["dup"], body: {Seats: 1}},
      ], {prefer: "odata.continue-on-error"});
      expect((await failed.json()).responses.map((r) => r.status)).to.deep.equal([400, 424]);
      const stopped = await batch([
        {id: "dup", method: "POST", url: "TravelSet", body: travel("T0001")},
        {id: "next", method: "GET", url: "TravelSet('T0001')"},
      ], {prefer: "odata.continue-on-error=false"});
      expect(stopped.headers.get("preference-applied")).to.equal("odata.continue-on-error=false");
      expect((await stopped.json()).responses.map((r) => r.id)).to.deep.equal(["dup"]);
      expect((await json(base + "/TravelSet?$count=true&$top=0"))["@odata.count"]).to.equal(4);
    });

    it("carries If-Match and ETags through batch requests", async () => {
      const res = await batch([
        {id: "c", method: "POST", url: literal.replace(origin, "") + "/NoteSet", body: {Id: "B1", Text: "b"}},
        {id: "p", method: "PATCH", url: "$c", dependsOn: ["c"], body: {Text: "c"}},
        {id: "q", method: "PATCH", url: "$c", dependsOn: ["c"], body: {Text: "c"}, headers: {"if-match": 'W/"1"'}},
        {id: "d", method: "DELETE", url: "$c", dependsOn: ["q", "c"], headers: {"if-match": 'W/"2"'}},
      ], {prefer: "odata.continue-on-error"});
      const {responses} = await res.json();
      expect(responses.map((r) => r.status)).to.deep.equal([201, 428, 204, 204]);
      expect(responses[0].headers.etag).to.equal('W/"1"');
      expect(responses[2].headers.etag).to.equal('W/"2"');
    });
  });

  describe("review fixes", () => {
    const batch = (requests, headers = {}) => fetch(base + "/$batch", {
      method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({requests}),
    });
    const raw = (path, method, text, headers = {}) =>
      fetch(path, {method, headers: {"content-type": "application/json", ...headers}, body: text});

    before(async () => {
      expect((await send(base + "/TravelSet", "POST", {TravelId: "T0400", Description: "review", Status: "A", Seats: 2})).status).to.equal(201);
    });
    after(async () => {
      await send(base + "/TravelSet('T0400')", "DELETE");
    });

    it("rejects numbers outside the EDM type's domain and keeps the entity", async () => {
      const url = base + "/TravelSet('T0400')";
      for (const text of ['{"Seats":1.5}', '{"Seats":2147483648}', '{"Seats":-2147483649}', '{"Seats":1.0e-1}',
        '{"Seats":"2"}', '{"Description":123}', '{"Description":true}', '{"Status":"AB"}',
        `{"Description":"${"x".repeat(41)}"}`, '{"d":{"Seats":9}}', '{"TravelId":null}']) {
        const res = await raw(url, "PATCH", text);
        expect(res.status, text).to.equal(400);
        expect((await res.json()).error.message).to.be.a("string");
      }
      expect(await json(url)).to.include({Seats: 2, Description: "review", Status: "A"});
      expect((await raw(url, "PATCH", '{"Seats":-2147483648}')).status).to.equal(204);
      expect((await json(url)).Seats).to.equal(-2147483648);
    });

    it("keeps the string \"null\" apart from a JSON null", async () => {
      const url = base + "/TravelSet('T0400')";
      expect((await raw(url, "PATCH", '{"Description":"null"}')).status).to.equal(204);
      expect((await json(url)).Description).to.equal("null");
      expect((await raw(url, "PATCH", '{"Description":null}')).status).to.equal(204);
      expect((await json(url)).Description).to.equal("");
    });

    it("refuses relationship bindings in scalar and array form", async () => {
      const url = base + "/TravelSet('T0400')";
      for (const body of [{"to_Bookings@odata.bind": "BookingSet(TravelId='T0001',BookingId='B001')"},
        {"to_Bookings@bind": "BookingSet(TravelId='T0001',BookingId='B001')"},
        {"to_Bookings@odata.bind": ["BookingSet(TravelId='T0001',BookingId='B001')"]}]) {
        const res = await send(url, "PATCH", body);
        expect(res.status, JSON.stringify(body)).to.equal(501);
      }
      expect((await json(url)).Seats).to.equal(-2147483648);
    });

    it("holds the entity lock from the ETag check to the end of the LUW", async () => {
      const {enqTake, enqDrop} = await import("../tools/osd-enq-host.mjs");
      const url = literal + "/NoteSet('L1')";
      expect((await send(literal + "/NoteSet", "POST", {Id: "L1", Text: "locked"})).status).to.equal(201);
      const input = lockInput("ZOSD_V4_TEST", "NoteSet", "Id=L1");
      const taken = enqTake("v4-review-holder", "OTHER", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input);
      expect(taken.subrc).to.equal(0);
      try {
        for (const [method, body] of [["PATCH", {Text: "lost"}], ["PUT", {Text: "lost"}], ["DELETE", undefined]]) {
          const res = await send(url, method, body, {"if-match": 'W/"1"'});
          expect(res.status, method).to.equal(409);
        }
        expect(await json(url)).to.include({Text: "locked", Version: 1});
      } finally {
        enqDrop("v4-review-holder", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input);
      }
      // the lock a request takes ends with it: two writes in a row both pass
      expect((await send(url, "PATCH", {Text: "a"}, {"if-match": 'W/"1"'})).status).to.equal(204);
      expect((await send(url, "PATCH", {Text: "b"}, {"if-match": 'W/"2"'})).status).to.equal(204);
      expect((await send(url, "DELETE", undefined, {"if-match": "*"})).status).to.equal(204);
    });

    it("rejects too long strings against MaxLength on the ETag fixture", async () => {
      const res = await send(literal + "/NoteSet", "POST", {Id: "M1", Text: "y".repeat(81)});
      expect(res.status).to.equal(400);
      expect((await fetch(literal + "/NoteSet('M1')")).status).to.equal(404);
    });

    it("processes every request of a JSON batch by default; continue-on-error=false stops", async () => {
      const requests = [{id: "1", method: "GET", url: "TravelSet('NONE')"}, {id: "2", method: "GET", url: "TravelSet('T0001')"}];
      const all = await batch(requests);
      expect((await all.json()).responses.map((r) => r.status)).to.deep.equal([404, 200]);
      const stop = await batch(requests, {prefer: "odata.continue-on-error=false"});
      expect((await stop.json()).responses.map((r) => r.status)).to.deep.equal([404]);
      const yes = await batch(requests, {prefer: "odata.continue-on-error=true"});
      expect(yes.headers.get("preference-applied")).to.equal("odata.continue-on-error");
      expect((await yes.json()).responses.map((r) => r.status)).to.deep.equal([404, 200]);
    });

    it("rolls back the ETag fixture with its atomicity group", async () => {
      const notes = literal.replace(origin, "") + "/NoteSet";
      const res = await batch([
        {id: "1", atomicityGroup: "g", method: "POST", url: notes, body: {Id: "R1", Text: "first"}},
        {id: "2", atomicityGroup: "g", method: "POST", url: notes, body: {Id: "R1", Text: "again"}},
      ]);
      expect((await res.json()).responses.map((r) => r.status)).to.deep.equal([424, 400]);
      expect((await fetch(literal + "/NoteSet('R1')")).status).to.equal(404);
    });

    it("requires the group of a request in another atomicity group in dependsOn", async () => {
      const bad = await batch([
        {id: "a", atomicityGroup: "g", method: "GET", url: "TravelSet('T0001')"},
        {id: "b", method: "GET", url: "TravelSet('T0002')", dependsOn: ["a"]},
      ]);
      expect(bad.status).to.equal(400);
      expect((await bad.json()).error.message).to.contain("group");
      const good = await batch([
        {id: "a", atomicityGroup: "g", method: "GET", url: "TravelSet('T0001')"},
        {id: "b", method: "GET", url: "TravelSet('T0002')", dependsOn: ["g", "a"]},
      ]);
      expect((await good.json()).responses.map((r) => r.status)).to.deep.equal([200, 200]);
    });
  });

  describe("review fixes, round two", () => {
    const batch = (requests, headers = {}) => fetch(base + "/$batch", {
      method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({requests}),
    });
    const raw = (path, method, text, headers = {}) =>
      fetch(path, {method, headers: {"content-type": "application/json", ...headers}, body: text});

    it("locks an entity by its identity, whatever the order of the URL's key", async () => {
      const {enqTake, enqDrop} = await import("../tools/osd-enq-host.mjs");
      const input = lockInput("ZSTG_DEMO_SRV", "BookingSet", "TravelId=T0001,BookingId=B001");
      expect(enqTake("v4-review-key", "OTHER", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input).subrc).to.equal(0);
      try {
        for (const key of ["TravelId='T0001',BookingId='B001'", "BookingId='B001',TravelId='T0001'"]) {
          const res = await send(base + `/BookingSet(${key})`, "PATCH", {Customer: "bypassed lock"});
          expect(res.status, key).to.equal(409);
        }
      } finally {
        enqDrop("v4-review-key", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input);
      }
      expect((await json(base + "/BookingSet(TravelId='T0001',BookingId='B001')")).Customer).not.to.equal("bypassed lock");
    });

    it("validates the number as written, not as a float", async () => {
      expect((await send(base + "/TravelSet", "POST", {TravelId: "T0500", Seats: 2})).status).to.equal(201);
      try {
        for (const text of ['{"Seats":2.0000000000000001}', '{"Seats":1e3}']) {
          const res = await raw(base + "/TravelSet('T0500')", "PATCH", text);
          expect(res.status, text).to.equal(400);
        }
        expect((await json(base + "/TravelSet('T0500')")).Seats).to.equal(2);
      } finally {
        await send(base + "/TravelSet('T0500')", "DELETE");
      }
      for (const [id, digits] of [["I1", "9223372036854775807"], ["I2", "9007199254740993"], ["I3", "-9223372036854775808"]]) {
        const res = await raw(literal + "/NoteSet", "POST", `{"Id":"${id}","Counter":${digits}}`);
        expect(res.status, digits).to.equal(201);
        expect(await res.text(), digits).to.contain(`"Counter":${digits}`);
        await send(literal + `/NoteSet('${id}')`, "DELETE", undefined, {"if-match": "*"});
      }
      for (const digits of ["9223372036854775808", "-9223372036854775809", "1.5"]) {
        const res = await raw(literal + "/NoteSet", "POST", `{"Id":"I9","Counter":${digits}}`);
        expect(res.status, digits).to.equal(400);
      }
      expect((await fetch(literal + "/NoteSet('I9')")).status).to.equal(404);
    });

    it("requires a $<id> reference in dependsOn and string request metadata", async () => {
      const implicit = await batch([
        {id: "a", method: "POST", url: "TravelSet", body: {TravelId: "T0501", Seats: 1}},
        {id: "b", method: "PATCH", url: "$a", body: {Seats: 2}},
      ]);
      expect(implicit.status).to.equal(400);
      expect((await fetch(base + "/TravelSet('T0501')")).status).to.equal(404);
      const numeric = await batch([{id: 1, method: "GET", url: "TravelSet('T0001')"}]);
      expect(numeric.status).to.equal(400);
      const quoted = await batch([{id: "1", method: "GET", url: "TravelSet('NONE')"}, {id: "2", method: "GET", url: "TravelSet('T0001')"}],
        {prefer: 'odata.continue-on-error="false"'});
      expect((await quoted.json()).responses.map((r) => r.status)).to.deep.equal([404]);
    });
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
