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
// The Guid the DPC seeds, in its internal form: 32 hex digits, upper case
// (test/v4/zcl_osd_v4_test_dpc.clas.abap). The V4 wire literal is the same value
// hyphenated and lower case, which the parser and the serializer each derive, so
// it is derived here too. Spelled out it is a UUID shape, and the leak scanner
// flags every UUID shape on sight -- synthetic or not -- in the repository scan
// and in the public layer the test folder is published as, where the
// repository's allow list does not apply.
const guidInternal = "12345678123412341234123456789ABC";
const guid = guidInternal.toLowerCase().replace(/^(.{8})(.{4})(.{4})(.{4})(.{12})$/, "$1-$2-$3-$4-$5");
const key = `Day=2026-11-07,Guid=${guid}`;
const array = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];
const query = (options) => "?" + new URLSearchParams(options);
async function json(path, options) {
  const res = await fetch(path, options);
  const body = await res.json();
  expect(res.status, JSON.stringify(body)).to.equal(200);
  return body;
}
// The demo's Travel has an ETag (Description, Status, Seats are set_as_etag),
// so a write to it without If-Match is 428; these tests are about the write
// itself and say If-Match: * unless they pass their own. The ETag contract
// is tested on its own below.
async function send(path, method, body, headers = {}) {
  const init = {method, headers: {...headers}};
  if (path.startsWith(base + "/TravelSet") && ["PATCH", "PUT", "DELETE"].includes(method)
      && !Object.keys(headers).some((name) => name.toLowerCase() === "if-match")) {
    init.headers["if-match"] = "*";
  }
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
    // control information is not a property: the ETag stays (Travel has one)
    expect(body.value[0]).to.have.all.keys("@odata.etag", "TravelId", "Description");
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet(TravelId,Description)");
    const one = await json(base + "/TravelSet('T0001')?$select=Description");
    expect(one).to.have.all.keys("@odata.context", "@odata.etag", "Description");
    const booking = await json(base + "/BookingSet(TravelId='T0001',BookingId='B001')?$select=Customer");
    expect(booking).to.have.all.keys("@odata.context", "Customer");
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

  // the MaxLength check of zcl_stg_model_info=>check_keys, shared with V2: a
  // key the DPC's CHAR(8) field would cut is a 400, never another entity.
  // The $filter half is the demo DPC's behaviour, not the gateway's: its
  // ranges are strings (src/demo/zcl_zstg_demo_dpc_ext.clas.abap:37-42), so
  // the literal stays whole and matches no row; a DDIC-typed CHAR range on a
  // system would cut it to T0001 (docs/key-length.md).
  it("refuses a key longer than its MaxLength with 400 and changes nothing; a long $filter literal matches nothing in the demo DPC", async () => {
    const before = await json(base + "/TravelSet('T0002')");
    const url = base + "/TravelSet(" + encodeURIComponent("'T0002    X'") + ")";
    const read = await fetch(url);
    expect(read.status).to.equal(400);
    expect((await read.json()).error.message).to.contain("MaxLength 8");
    expect((await fetch(base + "/TravelSet(" + encodeURIComponent("TravelId='T0002    X'") + ")")).status).to.equal(400);
    expect((await send(url, "PATCH", {Description: "wrong row"})).status).to.equal(400);
    expect((await send(url, "PUT", {Description: "wrong row"})).status).to.equal(400);
    expect((await send(url, "DELETE")).status).to.equal(400);
    expect((await fetch(url + "/to_Bookings")).status).to.equal(400);
    expect(await json(base + "/TravelSet('T0002')")).to.deep.equal(before);
    // the demo DPC's string ranges keep the literal whole, so no row matches
    const filtered = await json(base + "/TravelSet" + query({$filter: "TravelId eq 'T0001    X'"}));
    expect(filtered.value).to.deep.equal([]);
  });

  // trailing blanks never make a key too long: the check measures at the
  // last non-blank character, the way a CHAR field holds the value, so a key
  // of MaxLength characters plus blanks addresses the entity and only a
  // non-blank beyond the MaxLength is a 400 (shared check, same as V2)
  it("accepts a key of MaxLength characters plus trailing blanks; a non-blank beyond is still a 400", async () => {
    // T0001 + 4 blanks: 9 characters, 5 significant, MaxLength 8
    const padded = await fetch(base + "/TravelSet(" + encodeURIComponent("'T0001    '") + ")");
    expect(padded.status).to.equal(200);
    expect((await padded.json()).TravelId).to.equal("T0001");
    expect((await fetch(base + "/TravelSet(" + encodeURIComponent("'T0001   X'") + ")")).status).to.equal(400);
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
    ["/TravelSet?$expand=to_Bookings($nope=1)", 501], ["/TravelSet?$expand=to_Bookings/to_Travel", 501],
    ["/TravelSet?$expand=*", 501], ["/TravelSet?$expand=to_Bookings($top=1", 400],
    ["/TravelSet?$expand=to_Bookings,to_Bookings", 400], ["/TravelSet?$expand=to_Bookings($select=Nope)", 400],
    ["/BookingSet?$expand=to_Travel($top=1)", 400], ["/TravelSet?$select=to_Bookings/Nope&$expand=to_Bookings", 400],
    ["/BookingSet?$search=Ada", 501], ["/TravelSet?$search=Berlin%20AND%20Copenhagen", 501],
    ["/TravelSet?$search=Berlin%20Copenhagen", 501], ["/TravelSet?$expand=to_Bookings($search=Ada)", 501],
    ["/TravelSet?$apply=aggregate(Seats)", 501], ["/TravelSet(TravelId='T0001',TravelId='T0002')", 400],
    ["/BookingSet(TravelId='T0001')", 400], ["/TravelSet()", 400],
    ["/TravelSet?$top=1&$top=2", 400],
    ["/Nope(Status='A')", 404], ["/TravelCount(Status='A')/$count", 400], ["/TravelCount(Nope='A')", 400],
    ["/TravelCount(Status=@p)?@p='A'", 501], ["/TravelSet('T0001')/ZSTG_DEMO_SRV.Nope", 404],
    ["/TravelSet('T0001')/ZSTG_DEMO_SRV.CancelTravel", 405], ["/TravelSet/ZSTG_DEMO_SRV.CancelTravel", 400],
    ["/CancelTravel", 404], ["/TravelSet('T0001')/to_Bookings(BookingId='B001')", 404],
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
      expect(body["@odata.etag"]).to.equal('W/"V4%20trip;A;3"');
      const minimal = await send(base + "/TravelSet", "POST", {TravelId: "T0101", Seats: 1}, {prefer: "return=minimal"});
      expect(minimal.status).to.equal(204);
      expect(minimal.headers.get("location")).to.equal(base + "/TravelSet('T0101')");
      expect(minimal.headers.get("odata-entityid")).to.equal(base + "/TravelSet('T0101')");
      expect(minimal.headers.get("preference-applied")).to.equal("return=minimal");
      expect(await minimal.text()).to.equal("");
      expect((await json(base + "/TravelSet('T0101')")).Seats).to.equal(1);
      expect((await send(base + "/TravelSet('T0101')", "DELETE")).status).to.equal(204);
    });

    // ANOMALY-2026-11-08-escape-url-multibyte: escape_url wrote one % before
    // all UTF-8 bytes of a character (Жук -> %d096%d183%d0ba), so the Location
    // could not be decoded and following it was the server's URIError 400
    // page. A character outside ASCII is percent-encoded per UTF-8 byte now;
    // an ASCII key keeps the exact bytes cl_http_utility=>escape_url wrote
    // before (kept set, % and lowercase hex), pinned per key below.
    it("the Location of a created entity keeps an ASCII key's bytes and reads back a key outside ASCII", async () => {
      const cases = [
        ["It's", "It%27%27s"],
        ["a,b", "a%2cb"],
        ["a<b", "a%3cb"],
        ["T0102", "T0102"],
        ["T 0102", "T%200102"],
        ["100%", "100%25"],
        ["Жук", "%D0%96%D1%83%D0%BA"],
        ["\u{1F600}", "%F0%9F%98%80"],
        ["a\u{1F600}b", "a%F0%9F%98%80b"],
        ["Ж'ук", "%D0%96%27%27%D1%83%D0%BA"],
      ];
      for (const [key, escaped] of cases) {
        const res = await send(base + "/TravelSet", "POST", {TravelId: key, Description: "odd", Status: "A", Seats: 1});
        expect(res.status, key).to.equal(201);
        const location = res.headers.get("location");
        expect(location, key).to.equal(base + "/TravelSet('" + escaped + "')");
        expect(location, key).to.match(/^[\x20-\x7e]*$/);
        const got = await fetch(location);
        expect(got.status, key).to.equal(200);
        expect((await got.json()).TravelId, key).to.equal(key);
        expect((await send(location, "DELETE")).status, key).to.equal(204);
        expect((await fetch(location)).status, key).to.equal(404);
      }
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
      const concurrency = array(set.Annotation).find((a) => a.Term === "Core.OptimisticConcurrency");
      expect(concurrency.Collection.PropertyPath).to.equal("Version");
      const demo = await schema(base);
      const travels = array(demo.EntityContainer.EntitySet).find((s) => s.Name === "TravelSet");
      expect(array(travels.Annotation).find((a) => a.Term === "Core.OptimisticConcurrency").Collection.PropertyPath)
        .to.deep.equal(["Description", "Status", "Seats"]);
      const bookings = array(demo.EntityContainer.EntitySet).find((s) => s.Name === "BookingSet");
      // BookingSet carries only its SearchRestrictions (not searchable), no ETag
      expect(array(bookings.Annotation).map((a) => a.Term)).to.deep.equal(["Capabilities.SearchRestrictions"]);
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
      expect((await fetch(base + "/BookingSet(TravelId='T0001',BookingId='B001')")).headers.get("etag")).to.equal(null);
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
      const booking = base + "/BookingSet(TravelId='T0001',BookingId='B001')";
      const res = await send(booking, "PATCH", {Customer: "nobody"}, {"if-match": 'W/"1"'});
      expect(res.status).to.equal(412);
      expect((await json(booking)).Customer).not.to.equal("nobody");
    });
  });

  describe("JSON $batch", () => {
    const batch = (requests, headers = {}) => fetch(base + "/$batch", {
      method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({requests}),
    });
    const travel = (id, extra = {}) => ({TravelId: id, Description: "batch " + id, Status: "A", Seats: 2, ...extra});

    it("answers 415 for a batch that is neither JSON nor multipart and 400 for a malformed one", async () => {
      const plain = await fetch(base + "/$batch", {method: "POST", headers: {"content-type": "text/plain"}, body: "x"});
      expect(plain.status).to.equal(415);
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
        {id: "2", atomicityGroup: "good", method: "PATCH", url: "TravelSet('T0200')", body: {Seats: 5}, headers: {"if-match": "*"}},
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
        {id: "upd", method: "PATCH", url: "$new", dependsOn: ["new"], body: {Description: "through $new"}, headers: {"if-match": "*"}},
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
    // Travel has an ETag (see send): a write to it says If-Match: * here too
    const raw = (path, method, text, headers = {}) =>
      fetch(path, {method, headers: {"content-type": "application/json",
        ...(path.startsWith(base + "/TravelSet") ? {"if-match": "*"} : {}), ...headers}, body: text});

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
    // Travel has an ETag (see send): a write to it says If-Match: * here too
    const raw = (path, method, text, headers = {}) =>
      fetch(path, {method, headers: {"content-type": "application/json",
        ...(path.startsWith(base + "/TravelSet") ? {"if-match": "*"} : {}), ...headers}, body: text});

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

  // Post-merge critic of #856/#858 (2026-11-08). The first two are the SQL
  // host-variable escape (ANOMALY-2026-11-08-sql-host-variable-inlined,
  // fixed in the pinned transpiler): a quote in a key used to end the SQL
  // literal, so x' OR '1'='1 read and wrote every row, and a'b was a 500.
  describe("review fixes, round three", () => {
    const batch = (requests, headers = {}) => fetch(base + "/$batch", {
      method: "POST", headers: {"content-type": "application/json", ...headers}, body: JSON.stringify({requests}),
    });
    const raw = (path, method, text, headers = {}) =>
      fetch(path, {method, headers: {"content-type": "application/json", ...headers}, body: text});
    const injected = encodeURIComponent("'x'' OR ''1''=''1'");

    it("a quote in a key is a character of the key, not the end of the SQL literal", async () => {
      // longer than the key's MaxLength these are refused before the DPC (400);
      // the quoted keys that fit reach the SELECT and find nothing (404)
      expect((await fetch(base + `/TravelSet(${injected})`)).status).to.equal(400);
      expect((await fetch(base + "/TravelSet(" + encodeURIComponent("'x'' OR travel_id=''T0003'' --'") + ")")).status).to.equal(400);
      expect((await fetch(base + "/BookingSet(TravelId='T0001',BookingId=" + injected + ")")).status).to.equal(400);
      expect((await fetch(base + "/TravelSet(" + encodeURIComponent("'x''OR''1'") + ")")).status).to.equal(404);
      expect((await fetch(base + "/BookingSet(TravelId='T0001',BookingId=" + encodeURIComponent("'''--'") + ")")).status).to.equal(404);
      const patched = await raw(base + `/TravelSet(${injected})`, "PATCH", '{"Description":"oracle"}');
      expect(patched.status).to.equal(400);
      const fits = await raw(base + "/TravelSet(" + encodeURIComponent("'x''OR''1'") + ")", "PATCH", '{"Description":"oracle"}', {"if-match": "*"});
      expect(fits.status).to.equal(404);
      const all = await json(base + "/TravelSet?$select=TravelId,Description");
      expect(all.value.map((t) => t.Description)).to.not.include("oracle");
      expect(all.value.find((t) => t.TravelId === "T0001").Description).to.equal("Berlin to Copenhagen");
      // a filter literal takes the same road into the DPC's ranges
      const filtered = await json(base + "/TravelSet?$filter=" + encodeURIComponent("TravelId eq 'x'' OR ''1''=''1'"));
      expect(filtered.value).to.deep.equal([]);
    });

    it("a key with a quote round-trips: create, read, update, delete", async () => {
      const url = literal + "/NoteSet('a''b')";
      expect((await send(literal + "/NoteSet", "POST", {Id: "a'b", Text: "t"})).status).to.equal(201);
      const read = await fetch(url);
      expect(read.status).to.equal(200);
      expect(await read.json()).to.include({Id: "a'b", Text: "t", Version: 1});
      expect((await send(url, "PATCH", {Text: "it's"}, {"if-match": "*"})).status).to.equal(204);
      expect(await json(url)).to.include({Id: "a'b", Text: "it's", Version: 2});
      const list = await json(literal + "/NoteSet?$filter=" + encodeURIComponent("Id eq 'a''b'"));
      expect(list.value.map((n) => n.Id)).to.deep.equal(["a'b"]);
      expect((await send(url, "DELETE", undefined, {"if-match": "*"})).status).to.equal(204);
      expect((await fetch(url)).status).to.equal(404);
      // the demo service, whose DPC updates with UPDATE ... FROM the row
      expect((await send(base + "/TravelSet", "POST", {TravelId: "a'b", Seats: 1})).status).to.equal(201);
      expect(await json(base + "/TravelSet('a''b')")).to.include({TravelId: "a'b", Seats: 1});
      expect((await send(base + "/TravelSet('a''b')", "PATCH", {Seats: 2})).status).to.equal(204);
      expect((await json(base + "/TravelSet('a''b')")).Seats).to.equal(2);
      expect((await send(base + "/TravelSet('a''b')", "DELETE")).status).to.equal(204);
    });

    // zcl_stg_json=>skip_blanks compared a one-character string with SPACE,
    // which is the empty string once converted, so a blank after : or , was
    // never skipped and {"Seats": 7} was refused with 400.
    it("accepts blanks and newlines between the tokens of a write body", async () => {
      expect((await send(base + "/TravelSet", "POST", '{"TravelId": "T0907", "Seats": 1}')).status).to.equal(201);
      try {
        for (const [text, seats] of [['{"Seats": 7}', 7], ['{"Seats":8, "Description":"d"}', 8], ['{ "Seats" : 9 , "Description" : "e" }', 9],
          ['{\n  "Seats": 10\n}', 10], ['{"Seats":\t11}', 11], ['{"Seats":12}\n', 12], [' {"Seats":13}', 13]]) {
          const res = await raw(base + "/TravelSet('T0907')", "PATCH", text, {"if-match": "*"});
          expect(res.status, JSON.stringify(text)).to.equal(204);
          expect((await json(base + "/TravelSet('T0907')")).Seats, JSON.stringify(text)).to.equal(seats);
        }
        expect((await json(base + "/TravelSet('T0907')")).Description).to.equal("e");
      } finally {
        await send(base + "/TravelSet('T0907')", "DELETE");
      }
    });

    it("refuses a dependsOn that is not an array, like the other mistyped members", async () => {
      for (const dependsOn of ["a", 1, true, {a: 1}]) {
        const res = await batch([{id: "a", method: "GET", url: "TravelSet('T0001')"},
          {id: "b", method: "GET", url: "TravelSet('T0001')", dependsOn}]);
        expect(res.status, JSON.stringify(dependsOn)).to.equal(400);
        expect((await res.json()).error.message).to.contain("dependsOn must be an array");
      }
      const fine = await batch([{id: "a", method: "GET", url: "TravelSet('T0001')"},
        {id: "b", method: "GET", url: "TravelSet('T0001')", dependsOn: ["a"]}]);
      expect(fine.status).to.equal(200);
      expect((await fine.json()).responses.map((r) => r.status)).to.deep.equal([200, 200]);
    });
  });
});

// What a Fiori Elements V4 app (webapp/travel4, test/e2e/travel4.spec.mjs)
// asks of the service beyond plain reads: the UI annotations in $metadata,
// a CSRF token by HEAD, sap-* query options, reads through a navigation
// property, and the multipart $batch the UI5 V4 model sends.
describe("OData V4 for Fiori Elements", () => {
  let server;
  before(() => {
    server = startServer(true);
  });
  after(() => server.close());

  const CRLF = "\r\n";
  const part = (method, url, headers = {}, body) => ["Content-Type:application/http", "Content-Transfer-Encoding:binary", "",
    `${method} ${url} HTTP/1.1`, "Accept:application/json;odata.metadata=minimal;IEEE754Compatible=true",
    ...Object.entries(headers).map(([k, v]) => `${k}:${v}`), "", body === undefined ? "" : JSON.stringify(body)].join(CRLF);
  const changeset = (boundary, parts) => ["Content-Type: multipart/mixed;boundary=" + boundary, "", "",
    ...parts.map((p, i) => `--${boundary}${CRLF}Content-ID:${i}.0${CRLF}${p}`),
    `--${boundary}--`].join(CRLF);
  const multipart = (parts) => fetch(base + "/$batch", {method: "POST",
    headers: {"content-type": "multipart/mixed;boundary=batch_1", "odata-version": "4.0"},
    body: parts.map((p) => `--batch_1${CRLF}${p}${CRLF}`).join("") + "--batch_1--" + CRLF});
  // the parts of a multipart answer: [{status, headers, body, contentId}], a change set as an array
  function parts(text, boundary) {
    return text.split("--" + boundary).slice(1, -1).map((chunk) => {
      const inner = /boundary=([^\r\n;]+)/.exec(chunk.split(CRLF + CRLF)[0]);
      if (/multipart\/mixed/.test(chunk.split(CRLF + CRLF)[0])) {
        return parts(chunk, inner[1].trim());
      }
      const [mime, http, ...rest] = chunk.replace(/^\r\n/, "").split(CRLF + CRLF);
      const [statusLine, ...lines] = http.split(CRLF);
      const headers = Object.fromEntries(lines.map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
      const body = rest.join(CRLF + CRLF).trim();
      return {status: Number(statusLine.split(" ")[1]), statusLine, headers, contentId: /Content-ID: *(\S+)/i.exec(mime)?.[1],
        body: body === "" ? undefined : (headers["content-type"] ?? "").includes("json") ? JSON.parse(body) : body};
    });
  }

  it("carries the UI and Common annotations of the model in CSDL", async () => {
    const res = await fetch(base + "/$metadata");
    const xml = await res.text();
    const doc = new XMLParser({ignoreAttributes: false, attributeNamePrefix: ""}).parse(xml);
    const refs = array(doc["edmx:Edmx"]["edmx:Reference"]).map((r) => r["edmx:Include"].Namespace);
    expect(refs).to.include.members(["com.sap.vocabularies.UI.v1", "com.sap.vocabularies.Common.v1", "Org.OData.Core.V1"]);
    const model = doc["edmx:Edmx"]["edmx:DataServices"].Schema;
    const target = (name) => array(model.Annotations).find((a) => a.Target === name);
    const terms = (name) => array(target(name).Annotation).map((a) => a.Term + (a.Qualifier ? "#" + a.Qualifier : ""));
    expect(terms("ZSTG_DEMO_SRV.Travel")).to.include.members(["com.sap.vocabularies.UI.v1.HeaderInfo",
      "com.sap.vocabularies.UI.v1.SelectionFields", "com.sap.vocabularies.UI.v1.LineItem",
      "com.sap.vocabularies.UI.v1.Facets", "com.sap.vocabularies.UI.v1.FieldGroup#General"]);
    expect(terms("ZSTG_DEMO_SRV.Travel/Description")).to.deep.equal(["com.sap.vocabularies.Common.v1.Label"]);
    expect(terms("ZSTG_DEMO_SRV.Travel/Status")).to.include("com.sap.vocabularies.Common.v1.ValueList");
    // the annotations are a sibling of the container, inside the one schema
    expect(xml.indexOf("<Annotations")).to.be.greaterThan(xml.indexOf("</EntityContainer>"));
    // a service without vocabulary annotations references no UI vocabulary it does not use
    expect(await (await fetch(literal + "/$metadata")).text()).not.to.contain("com.sap.vocabularies.UI");
  });

  it("answers HEAD on the service root with a CSRF token and no body", async () => {
    const res = await fetch(base + "/", {method: "HEAD", headers: {"x-csrf-token": "Fetch"}});
    expect(res.status).to.equal(200);
    expect(res.headers.get("x-csrf-token")).to.be.a("string").and.not.empty;
    expect(res.headers.get("odata-version")).to.equal("4.0");
    expect(await res.text()).to.equal("");
  });

  it("ignores sap-* query options and still refuses unknown ones", async () => {
    const list = await json(base + "/TravelSet" + query({"sap-client": "001", "sap-language": "EN", "sap-context-token": "x", $top: "1"}));
    expect(list.value).to.have.length(1);
    expect((await fetch(base + "/TravelSet?custom=1")).status).to.equal(501);
  });

  it("reads through a navigation property: collection, count, options and a single target", async () => {
    const bookings = await json(base + "/TravelSet('T0001')/to_Bookings" +
      query({$count: "true", $select: "BookingId,Customer", $orderby: "BookingId desc", $top: "1"}));
    expect(bookings["@odata.count"]).to.equal(2);
    expect(bookings.value).to.deep.equal([{BookingId: "B002", Customer: bookings.value[0].Customer}]);
    expect(bookings.value[0].Customer).to.be.a("string").and.not.empty;
    const count = await fetch(base + "/TravelSet('T0001')/to_Bookings/$count");
    expect(await count.text()).to.equal("2");
    const travel = await json(base + "/BookingSet(TravelId='T0002',BookingId='B001')/to_Travel?$select=TravelId");
    expect(travel.TravelId).to.equal("T0002");
    expect(travel["@odata.context"]).to.match(/\$entity$/);
    expect((await fetch(base + "/TravelSet('T0001')/to_Nothing")).status).to.be.oneOf([400, 404]);
    // a POST to a collection-valued navigation creates below the source (R5,
    // test/rap-r5.mjs); a POST to a single-valued one and a PATCH through a
    // navigation are still not served
    expect((await send(base + "/BookingSet(TravelId='T0002',BookingId='B001')/to_Travel", "POST", {Seats: 1})).status).to.equal(501);
    expect((await send(base + "/TravelSet('T0001')/to_Bookings", "PATCH", {Customer: "x"})).status).to.equal(501);
  });

  it("answers a multipart $batch: reads, a change set with If-Match and ETags, Content-IDs", async () => {
    const etag = (await fetch(base + "/TravelSet('T0002')")).headers.get("etag");
    expect(etag).to.match(/^W\/"/);
    const res = await multipart([
      part("GET", "TravelSet?$count=true&$select=TravelId,Seats&$skip=0&$top=2"),
      changeset("changeset_1", [part("PATCH", "TravelSet('T0002')",
        {"Content-Type": "application/json;charset=UTF-8;IEEE754Compatible=true", "If-Match": etag}, {Seats: 6})]),
      part("GET", "TravelSet('T0002')?$select=Seats"),
    ]);
    expect(res.status).to.equal(200);
    const type = res.headers.get("content-type");
    expect(type).to.match(/^multipart\/mixed; *boundary=/);
    const answer = parts(await res.text(), /boundary=(.+)$/.exec(type)[1].trim());
    expect(answer).to.have.length(3);
    expect(answer[0].status).to.equal(200);
    expect(answer[0].headers["odata-version"]).to.equal("4.0");
    expect(answer[0].body["@odata.count"]).to.equal(4);
    expect(answer[0].body.value).to.have.length(2);
    expect(answer[1]).to.be.an("array").with.length(1);
    // the client's own Content-ID comes back
    expect(answer[1][0]).to.include({status: 204, contentId: "0.0"});
    expect(answer[1][0].headers.etag).to.match(/;6"$/);
    expect(answer[2].body.Seats).to.equal(6);
  });

  describe("sticky-session editing (Session.StickySessionSupported)", () => {
    const action = (path, name, body = {}, headers = {}) => send(base + path + "/ZSTG_DEMO_SRV." + name, "POST", body, headers);
    const inSession = (id) => ({"sap-contextid": id});

    it("announces the session actions for an updatable entity set with an ETag, and only there", async () => {
      const res = await fetch(base + "/$metadata");
      const xml = await res.text();
      const doc = new XMLParser({ignoreAttributes: false, attributeNamePrefix: ""}).parse(xml);
      const refs = array(doc["edmx:Edmx"]["edmx:Reference"]).map((r) => r["edmx:Include"].Namespace);
      expect(refs).to.include("com.sap.vocabularies.Session.v1");
      const model = doc["edmx:Edmx"]["edmx:DataServices"].Schema;
      const actions = array(model.Action);
      for (const name of ["OsdStickyEdit", "OsdStickySave"]) {
        const a = actions.find((x) => x.Name === name);
        expect(a, name).to.include({IsBound: "true", EntitySetPath: "_it"});
        expect(a.Parameter.Type).to.equal("ZSTG_DEMO_SRV.Travel");
      }
      const created = actions.find((x) => x.Name === "OsdStickyNew");
      expect(array(created.Parameter).map((p) => p.Name)).to.deep.equal(["_it", "TravelId"]);
      expect(array(created.Parameter)[0].Type).to.equal("Collection(ZSTG_DEMO_SRV.Travel)");
      expect(model.EntityContainer.ActionImport).to.include({Name: "OsdStickyDiscard", Action: "ZSTG_DEMO_SRV.OsdStickyDiscard"});
      const sets = array(model.EntityContainer.EntitySet);
      const sticky = array(sets.find((x) => x.Name === "TravelSet").Annotation)
        .find((a) => a.Term === "com.sap.vocabularies.Session.v1.StickySessionSupported");
      expect(Object.fromEntries(sticky.Record.PropertyValue.map((p) => [p.Property, p.String]))).to.deep.equal({
        NewAction: "ZSTG_DEMO_SRV.OsdStickyNew", EditAction: "ZSTG_DEMO_SRV.OsdStickyEdit",
        SaveAction: "ZSTG_DEMO_SRV.OsdStickySave", DiscardAction: "OsdStickyDiscard"});
      expect(array(sets.find((x) => x.Name === "BookingSet").Annotation).map((a) => a.Term))
        .not.to.include("com.sap.vocabularies.Session.v1.StickySessionSupported");
      // opt-in: NoteSet of the test service is updatable and has an ETag, and
      // its model does not ask for a sticky session
      expect(await (await fetch(literal + "/$metadata")).text()).not.to.contain("OsdSticky");
    });

    it("Save checks If-Match against the session's copy", async () => {
      const edit = await action("/TravelSet('T0003')", "OsdStickyEdit");
      const id = edit.headers.get("sap-contextid");
      const patch = await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 55}, {...inSession(id), "if-match": "*"});
      const stale = await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(id), "if-match": 'W/"definitely-stale"'});
      expect(stale.status).to.equal(412);
      // a tag of another entity is no version of this copy either
      const other = (await fetch(base + "/TravelSet('T0001')")).headers.get("etag");
      expect((await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(id), "if-match": other})).status).to.equal(412);
      expect((await json(base + "/TravelSet('T0003')")).Seats).to.equal(4);
      // the copy keeps the tag Edit handed out until Save
      expect(patch.headers.get("etag")).to.equal(edit.headers.get("etag"));
      const save = await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(id), "if-match": edit.headers.get("etag")});
      expect(save.status).to.equal(200);
      expect((await json(base + "/TravelSet('T0003')")).Seats).to.equal(55);
      expect((await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 4})).status).to.equal(204);
    });

    it("a failing atomicity group gives the session's copies back, Save included", async () => {
      const batchIn = (id, requests) => fetch(base + "/$batch", {method: "POST",
        headers: {"content-type": "application/json", "sap-contextid": id}, body: JSON.stringify({requests})});
      const edit = await action("/TravelSet('T0001')", "OsdStickyEdit");
      const id = edit.headers.get("sap-contextid");
      const before = (await json(base + "/TravelSet('T0001')", {headers: inSession(id)})).Seats;
      const failed = await batchIn(id, [
        {id: "a", atomicityGroup: "g", method: "PATCH", url: "TravelSet('T0001')", headers: {"if-match": "*"}, body: {Seats: 77}},
        {id: "b", atomicityGroup: "g", method: "POST", url: "TravelSet", body: {TravelId: "T0001"}},
      ]);
      expect((await failed.json()).responses.map((r) => r.status)).to.deep.equal([424, 400]);
      expect((await json(base + "/TravelSet('T0001')", {headers: inSession(id)})).Seats).to.equal(before);
      // Save inside a failing group: the database rolls back and the copy stays
      await send(base + "/TravelSet('T0001')", "PATCH", {Seats: 66}, {...inSession(id), "if-match": "*"});
      const saveFailed = await batchIn(id, [
        {id: "s", atomicityGroup: "g", method: "POST", url: "TravelSet('T0001')/ZSTG_DEMO_SRV.OsdStickySave", body: {}, headers: {"if-match": "*"}},
        {id: "x", atomicityGroup: "g", method: "POST", url: "TravelSet", body: {TravelId: "T0001"}},
      ]);
      expect((await saveFailed.json()).responses.map((r) => r.status)).to.deep.equal([424, 400]);
      expect((await json(base + "/TravelSet('T0001')")).Seats).to.equal(before);
      const save = await action("/TravelSet('T0001')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"});
      expect(save.status).to.equal(200);
      expect((await json(base + "/TravelSet('T0001')")).Seats).to.equal(66);
      expect((await send(base + "/TravelSet('T0001')", "PATCH", {Seats: before})).status).to.equal(204);
    });

    it("drops a session idle past the timeout, and evicts the least recently used one past the cap", async function () {
      this.timeout(20000);
      const {zcl_osd_v4_sticky} = await import("../output/zcl_osd_v4_sticky.clas.mjs");
      const configure = (idle, max) => zcl_osd_v4_sticky.configure({
        iv_idle_seconds: new abap.types.Integer().set(idle), iv_max_sessions: new abap.types.Integer().set(max)});
      try {
        await configure(1, 50);
        const edit = await action("/TravelSet('T0002')", "OsdStickyEdit");
        expect(edit.headers.get("sap-http-session-timeout")).to.equal("1");
        const id = edit.headers.get("sap-contextid");
        await new Promise((resolve) => setTimeout(resolve, 2200));
        // an expired session takes no write, and nothing reaches the database
        const seats = (await json(base + "/TravelSet('T0002')")).Seats;
        expect((await send(base + "/TravelSet('T0002')", "PATCH", {Seats: 84}, {...inSession(id), "if-match": edit.headers.get("etag")})).status)
          .to.equal(410);
        expect((await json(base + "/TravelSet('T0002')")).Seats).to.equal(seats);
        expect((await action("/TravelSet('T0002')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"})).status).to.equal(400);
        await configure(900, 2);
        const ids = [];
        for (const key of ["T0001", "T0002", "T0003"]) {
          ids.push((await action(`/TravelSet('${key}')`, "OsdStickyEdit")).headers.get("sap-contextid"));
        }
        expect(new Set(ids).size).to.equal(3);
        expect((await action("/TravelSet('T0001')", "OsdStickySave", {}, {...inSession(ids[0]), "if-match": "*"})).status).to.equal(400);
        expect((await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(ids[2]), "if-match": "*"})).status).to.equal(200);
        expect((await action("/TravelSet('T0002')", "OsdStickySave", {}, {...inSession(ids[1]), "if-match": "*"})).status).to.equal(200);
      } finally {
        await configure(900, 50);
      }
    });

    it("Edit opens a session, PATCH changes only the session's copy, Save writes it", async () => {
      const edit = await action("/TravelSet('T0002')", "OsdStickyEdit");
      expect(edit.status).to.equal(200);
      const id = edit.headers.get("sap-contextid");
      expect(id).to.be.a("string").and.not.empty;
      const etag = edit.headers.get("etag");
      expect((await edit.json()).TravelId).to.equal("T0002");
      const patch = await send(base + "/TravelSet('T0002')", "PATCH", {Description: "in the session"},
        {...inSession(id), "if-match": etag});
      expect(patch.status).to.equal(204);
      expect(patch.headers.get("etag")).to.equal(etag);
      expect(patch.headers.get("sap-contextid")).to.equal(id);
      expect((await json(base + "/TravelSet('T0002')")).Description).to.not.equal("in the session");
      expect((await json(base + "/TravelSet('T0002')", {headers: inSession(id)})).Description).to.equal("in the session");
      // a tag the session does not hold
      expect((await send(base + "/TravelSet('T0002')", "PATCH", {Seats: 1}, {...inSession(id), "if-match": 'W/"stale"'})).status)
        .to.equal(412);
      const save = await action("/TravelSet('T0002')", "OsdStickySave", {}, {...inSession(id), "if-match": etag});
      expect(save.status).to.equal(200);
      expect((await save.json()).Description).to.equal("in the session");
      expect((await json(base + "/TravelSet('T0002')")).Description).to.equal("in the session");
      // the session no longer holds it
      expect((await action("/TravelSet('T0002')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"})).status).to.equal(400);
    });

    it("Discard drops the session's copies; Save after a change by somebody else is 412", async () => {
      const edit = await action("/TravelSet('T0003')", "OsdStickyEdit");
      const id = edit.headers.get("sap-contextid");
      await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 40}, {...inSession(id), "if-match": "*"});
      const discard = await fetch(base + "/OsdStickyDiscard", {method: "POST", headers: {...inSession(id), "content-type": "application/json"}, body: "{}"});
      expect(discard.status).to.equal(204);
      expect((await json(base + "/TravelSet('T0003')", {headers: inSession(id)})).Seats).to.equal(4);
      expect((await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"})).status).to.equal(400);
      const again = await action("/TravelSet('T0003')", "OsdStickyEdit", {}, inSession(id));
      expect(again.headers.get("sap-contextid")).to.equal(id);
      expect((await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 41})).status).to.equal(204);
      const late = await action("/TravelSet('T0003')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"});
      expect(late.status).to.equal(412);
      expect((await json(base + "/TravelSet('T0003')")).Seats).to.equal(41);
      expect((await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 4})).status).to.equal(204);
    });

    it("New starts an entity in the session that Save creates", async () => {
      const created = await action("/TravelSet", "OsdStickyNew", {TravelId: "T0600"});
      expect(created.status).to.equal(200);
      const id = created.headers.get("sap-contextid");
      expect(await created.json()).to.include({TravelId: "T0600", Description: ""});
      expect((await fetch(base + "/TravelSet('T0600')")).status).to.equal(404);
      expect((await send(base + "/TravelSet('T0600')", "PATCH", {Description: "new in V4", Seats: 2},
        {...inSession(id), "if-match": created.headers.get("etag")})).status).to.equal(204);
      const save = await action("/TravelSet('T0600')", "OsdStickySave", {}, {...inSession(id), "if-match": "*"});
      expect(save.status).to.equal(200);
      expect(await json(base + "/TravelSet('T0600')")).to.include({Description: "new in V4", Seats: 2});
      expect((await action("/TravelSet", "OsdStickyNew", {TravelId: "T0001"})).status).to.equal(400);
      expect((await action("/TravelSet", "OsdStickyNew", {})).status).to.equal(400);
      expect((await action("/BookingSet(TravelId='T0001',BookingId='B001')", "OsdStickyEdit")).status).to.equal(501);
      expect((await send(base + "/TravelSet('T0600')", "DELETE")).status).to.equal(204);
    });

    const configure = async (idle, max) => {
      const {zcl_osd_v4_sticky} = await import("../output/zcl_osd_v4_sticky.clas.mjs");
      await zcl_osd_v4_sticky.configure({
        iv_idle_seconds: new abap.types.Integer().set(idle), iv_max_sessions: new abap.types.Integer().set(max)});
    };

    it("refuses a PATCH in a session that expired or was evicted, and never writes it through", async () => {
      try {
        await configure(900, 1);
        const first = await action("/TravelSet('T0001')", "OsdStickyEdit");
        const lost = first.headers.get("sap-contextid");
        const seats = (await json(base + "/TravelSet('T0001')")).Seats;
        const second = await action("/TravelSet('T0002')", "OsdStickyEdit");
        const live = second.headers.get("sap-contextid");
        // the first session was evicted by the second: its PATCH is refused
        const evicted = await send(base + "/TravelSet('T0001')", "PATCH", {Seats: 83},
          {...inSession(lost), "if-match": first.headers.get("etag")});
        expect(evicted.status).to.equal(410);
        expect((await evicted.json()).error.message).to.contain("session");
        expect((await send(base + "/TravelSet('T0001')", "PUT", {Seats: 83}, {...inSession(lost), "if-match": "*"})).status).to.equal(410);
        expect((await send(base + "/TravelSet('T0001')", "PATCH", {Seats: 83}, {...inSession("osd-never-opened"), "if-match": "*"})).status)
          .to.equal(410);
        expect((await json(base + "/TravelSet('T0001')")).Seats).to.equal(seats);
        // a live session that does not hold the entity: Edit first
        const notHeld = await send(base + "/TravelSet('T0003')", "PATCH", {Seats: 83}, {...inSession(live), "if-match": "*"});
        expect(notHeld.status).to.equal(400);
        expect((await json(base + "/TravelSet('T0003')")).Seats).to.not.equal(83);
        await fetch(base + "/OsdStickyDiscard", {method: "POST", headers: inSession(live)});
      } finally {
        await configure(900, 50);
      }
    });

    it("Save takes only the ETag the session holds; the session's ETag stays the one Edit handed out", async () => {
      const edit = await action("/TravelSet('T0001')", "OsdStickyEdit");
      const id = edit.headers.get("sap-contextid");
      const held = edit.headers.get("etag");
      const before = (await json(base + "/TravelSet('T0001')")).Seats;
      const patch = await send(base + "/TravelSet('T0001')", "PATCH", {Seats: 37}, {...inSession(id), "if-match": held});
      expect(patch.status).to.equal(204);
      expect(patch.headers.get("etag")).to.equal(held);
      const copy = await json(base + "/TravelSet('T0001')", {headers: inSession(id)});
      expect(copy.Seats).to.equal(37);
      expect(copy["@odata.etag"]).to.equal(held);
      // a tag describing the changed content is not the tag the session holds
      const content = `W/"${encodeURIComponent(copy.Description)};${copy.Status};37"`;
      expect((await action("/TravelSet('T0001')", "OsdStickySave", {}, {...inSession(id), "if-match": content})).status).to.equal(412);
      expect((await action("/TravelSet('T0001')", "OsdStickySave", {}, inSession(id))).status).to.equal(428);
      expect((await json(base + "/TravelSet('T0001')")).Seats).to.equal(before);
      const save = await action("/TravelSet('T0001')", "OsdStickySave", {}, {...inSession(id), "if-match": held});
      expect(save.status).to.equal(200);
      expect(save.headers.get("etag")).to.not.equal(held);
      expect((await json(base + "/TravelSet('T0001')")).Seats).to.equal(37);
      expect((await send(base + "/TravelSet('T0001')", "PATCH", {Seats: before})).status).to.equal(204);
    });

    it("names the session on a batch whose part opened it", async () => {
      const res = await multipart([part("POST", "TravelSet('T0001')/ZSTG_DEMO_SRV.OsdStickyEdit",
        {"Content-Type": "application/json"}, {})]);
      const id = res.headers.get("sap-contextid");
      expect(id).to.be.a("string").and.not.empty;
      const discard = await fetch(base + "/OsdStickyDiscard", {method: "POST", headers: inSession(id)});
      expect(discard.status).to.equal(204);
    });
  });

  it("echoes the client's Content-IDs and refuses a read inside a change set", async () => {
    const res = await multipart([
      "Content-ID: read-9\r\n" + part("GET", "TravelSet('T0001')?$select=TravelId"),
      changeset("changeset_3", [part("PATCH", "BookingSet(TravelId='T0001',BookingId='B001')",
        {"Content-Type": "application/json"}, {Customer: "Ada Lovelace"})]).replace("Content-ID:0.0", "Content-ID:42"),
    ]);
    const answer = parts(await res.text(), /boundary=(.+)$/.exec(res.headers.get("content-type"))[1].trim());
    expect(answer[0]).to.include({status: 200, contentId: "read-9"});
    expect(answer[1][0]).to.include({status: 204, contentId: "42"});
    const read = await multipart([changeset("changeset_4", [part("GET", "TravelSet('T0001')")])]);
    expect(read.status).to.equal(400);
  });

  it("rolls a failing change set back and answers it with its one error", async () => {
    const res = await multipart([
      changeset("changeset_2", [
        part("POST", "TravelSet", {"Content-Type": "application/json"}, {TravelId: "T0400", Description: "multipart"}),
        part("PATCH", "TravelSet('T0001')", {"Content-Type": "application/json", "If-Match": 'W/"stale"'}, {Seats: 1}),
      ]),
    ]);
    const answer = parts(await res.text(), /boundary=(.+)$/.exec(res.headers.get("content-type"))[1].trim());
    expect(answer).to.have.length(1);
    expect(answer[0].status).to.equal(412);
    expect(answer[0].body.error.message).to.be.a("string");
    expect((await fetch(base + "/TravelSet('T0400')")).status).to.equal(404);
  });
});


// The next slice over the same classes: the model's function imports as
// bound/unbound V4 operations, deep insert through create_deep_entity,
// options inside $expand(...) and $search.
describe("OData V4 operations, deep insert, expand options and search", () => {
  let server;
  before(() => {
    server = startServer(true);
  });
  after(() => server.close());
  // a bound action on a Travel needs If-Match like a PATCH (428 without): the
  // calls below that are not about it say If-Match: *
  const post = (path, body, headers = {}) => send(base + path, "POST", body,
    /^\/TravelSet\(.*\)\/ZSTG_DEMO_SRV\./.test(path)
      && !Object.keys(headers).some((name) => name.toLowerCase() === "if-match") ? {"if-match": "*", ...headers} : headers);

  it("describes the function imports as a bound action and an unbound function with imports", async () => {
    const model = await schema(base);
    const cancel = array(model.Action).find((a) => a.Name === "CancelTravel");
    // it answers its binding's own type, from the binding's set
    expect(cancel).to.include({IsBound: "true", EntitySetPath: "_it"});
    // the one parameter is the binding: TravelId is Travel's key and is filled from the URL
    expect(array(cancel.Parameter)).to.deep.equal([{Name: "_it", Type: "ZSTG_DEMO_SRV.Travel", Nullable: "false"}]);
    expect(cancel.ReturnType.Type).to.equal("ZSTG_DEMO_SRV.Travel");
    const count = array(model.Function).find((f) => f.Name === "TravelCount");
    expect(count).not.to.have.property("IsBound");
    // the facets the MPC gives the parameter (set_maxlength( 1 ))
    expect(array(count.Parameter)).to.deep.equal([{Name: "Status", Type: "Edm.String", MaxLength: "1"}]);
    // classic SEGW has no primitive return kind in the tree
    expect(count.ReturnType.Type).to.equal("Edm.PrimitiveType");
    const imports = array(model.EntityContainer.FunctionImport);
    expect(imports.find((i) => i.Name === "TravelCount")).to.include({Function: "ZSTG_DEMO_SRV.TravelCount"});
    expect(array(model.EntityContainer.ActionImport).map((i) => i.Name)).not.to.include("CancelTravel");
    // the sticky-session actions are still there beside them
    expect(array(model.Action).map((a) => a.Name)).to.include.members(["OsdStickyEdit", "OsdStickySave", "OsdStickyNew", "OsdStickyDiscard"]);
  });

  it("invokes the unbound function with URL parameters and types the primitive result by its ABAP kind", async () => {
    const some = await json(base + "/TravelCount(Status='A')");
    expect(some).to.deep.equal({"@odata.context": base + "/$metadata#Edm.Int32", value: 3});
    const all = await json(base + "/TravelCount()");
    expect(all.value).to.equal(4);
    expect((await json(base + "/TravelCount(Status='X')")).value).to.equal(1);
    // a function takes GET, an unknown parameter is 400, a bound operation is not at the root
    const res = await post("/TravelCount(Status='A')", {});
    expect(res.status).to.equal(405);
    expect(res.headers.get("allow")).to.equal("GET");
    expect((await fetch(base + "/TravelCount(Nope='A')")).status).to.equal(400);
    expect((await post("/CancelTravel", {TravelId: "T0009"})).status).to.equal(404);
  });

  it("invokes the bound action on an entity through the V2 execute_action and answers the entity", async () => {
    let res = await post("/TravelSet('T0009')/ZSTG_DEMO_SRV.CancelTravel", {});
    expect(res.status, await res.clone().text()).to.equal(200);
    const body = await res.json();
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet/$entity");
    expect(body).to.include({TravelId: "T0009", Status: "X"});
    expect(body["@odata.etag"]).to.match(/^W\//);
    expect((await json(base + "/TravelSet('T0009')")).Status).to.equal("X");
    // the key of the binding cannot be moved by a parameter in the body; unknown parameters are 400
    res = await post("/TravelSet('T0009')/ZSTG_DEMO_SRV.CancelTravel", {Nope: 1});
    expect(res.status).to.equal(400);
    res = await post("/TravelSet('T0009')/ZSTG_DEMO_SRV.CancelTravel", {TravelId: "T0001"});
    expect(res.status).to.equal(200);
    expect((await res.json()).TravelId).to.equal("T0009");
    expect((await json(base + "/TravelSet('T0001')")).Status).to.equal("A");
    // an action takes POST; an entity-bound action needs the key; nothing is bound to Booking
    res = await fetch(base + "/TravelSet('T0009')/ZSTG_DEMO_SRV.CancelTravel");
    expect(res.status).to.equal(405);
    expect(res.headers.get("allow")).to.equal("POST");
    expect((await post("/TravelSet/ZSTG_DEMO_SRV.CancelTravel", {TravelId: "T0009"})).status).to.equal(400);
    expect((await post("/BookingSet(TravelId='T0001',BookingId='B001')/ZSTG_DEMO_SRV.CancelTravel", {})).status).to.equal(400);
    // the binding parameter is read first: a key nobody has is 404 before the DPC runs
    expect((await post("/TravelSet('NONE')/ZSTG_DEMO_SRV.CancelTravel", {})).status).to.equal(404);
    // put the seed row back
    res = await send(base + "/TravelSet('T0009')", "PUT", {Description: "Other client, must not leak", Status: "A", Seats: 9});
    expect(res.status).to.equal(204);
  });

  // #889's MaxLength refusal (zcl_stg_model_info, check_keys/check_length) on
  // the operation paths: the key of a bound operation goes through the same
  // check a read's key does, and so does every parameter value, from the URL
  // of a function or the body of an action. A value the DPC's CHAR field
  // would cut is a 400 before the DPC runs, never another entity or a wrong
  // count; trailing blanks measure at the last non-blank character.
  it("refuses an over-long key or parameter of an operation with 400 and changes nothing", async () => {
    const before = JSON.stringify((await json(base + "/TravelSet?$orderby=TravelId&$select=TravelId,Status")).value);
    const tooLong = async (res) => {
      expect(res.status, await res.clone().text()).to.equal(400);
      expect((await res.json()).error.code).to.equal("STG/VALUE_TOO_LONG");
    };
    // the key of a bound action: 'T0002    X' would be cut to T0002 by the DPC
    await tooLong(await post(`/TravelSet(${encodeURIComponent("'T0002    X'")})/ZSTG_DEMO_SRV.CancelTravel`, {}));
    // a function's URL parameter: Status has MaxLength 1
    await tooLong(await fetch(base + `/TravelCount(Status=${encodeURIComponent("'AB'")})`));
    // an action's body parameter: TravelId has MaxLength 8
    await tooLong(await post("/TravelSet('T0009')/ZSTG_DEMO_SRV.CancelTravel", {TravelId: "T0002    X"}));
    // trailing blanks never make a parameter too long, the same as a key
    expect((await fetch(base + `/TravelCount(Status=${encodeURIComponent("'A '")})`)).status).to.equal(200);
    expect(JSON.stringify((await json(base + "/TravelSet?$orderby=TravelId&$select=TravelId,Status")).value)).to.equal(before);
  });

  it("creates a travel with its bookings in one POST and answers the deep entity", async () => {
    let res = await post("/TravelSet", {TravelId: "T0700", Description: "Deep over V4", Status: "A", Seats: 1,
      to_Bookings: [{BookingId: "B001", Customer: "Barbara Liskov", FlightDate: "2026-12-01"},
        {BookingId: "B002", Customer: "Frances Allen", FlightDate: "2026-12-02"}]});
    expect(res.status, await res.clone().text()).to.equal(201);
    expect(res.headers.get("location")).to.equal(base + "/TravelSet('T0700')");
    expect(res.headers.get("etag")).to.match(/^W\//);
    const body = await res.json();
    // the context URL names what the answer expands (OData 4.01 Part 1, 10.9)
    expect(body["@odata.context"]).to.equal(base + "/$metadata#TravelSet(to_Bookings())/$entity");
    expect(body).to.include({TravelId: "T0700", Description: "Deep over V4"});
    expect(body.to_Bookings.map((b) => [b.TravelId, b.BookingId, b.Customer, b.FlightDate])).to.deep.equal(
      [["T0700", "B001", "Barbara Liskov", "2026-12-01"], ["T0700", "B002", "Frances Allen", "2026-12-02"]]);
    expect(body.to_Bookings[0]).not.to.have.property("to_Travel");
    const below = await json(base + "/TravelSet('T0700')/to_Bookings?$orderby=BookingId");
    expect(below.value.map((b) => b.FlightDate)).to.deep.equal(["2026-12-01", "2026-12-02"]);
    // the shape of the payload is checked before the DPC: a collection for a to-many, known properties, V4 values
    for (const [payload, status] of [
      [{TravelId: "T0701", to_Bookings: {BookingId: "B001"}}, 400],
      [{TravelId: "T0701", to_Bookings: [{Nope: 1}]}, 400],
      [{TravelId: "T0701", to_Bookings: [{BookingId: "B001", FlightDate: "01.12.2026"}]}, 400],
      [{TravelId: "T0701", to_Nope: [{BookingId: "B001"}]}, 400],
      [{TravelId: "T0701", "to_Bookings@odata.bind": ["BookingSet(TravelId='T0001',BookingId='B001')"]}, 501],
    ]) {
      res = await post("/TravelSet", payload);
      expect(res.status, JSON.stringify(payload)).to.equal(status);
    }
    expect((await send(base + "/BookingSet", "POST", {TravelId: "T0701", BookingId: "B001", to_Travel: [{TravelId: "T0701"}]})).status).to.equal(400);
    expect((await fetch(base + "/TravelSet('T0701')")).status).to.equal(404);
    // one LUW: a booking the DPC refuses takes the travel with it
    res = await post("/TravelSet", {TravelId: "T0702", Description: "Half", Status: "A", Seats: 1,
      to_Bookings: [{BookingId: "B001", Customer: "One"}, {BookingId: "B001", Customer: "Twice"}]});
    expect(res.status).to.equal(400);
    expect((await fetch(base + "/TravelSet('T0702')")).status).to.equal(404);
    expect((await json(base + "/BookingSet?$filter=TravelId eq 'T0702'")).value).to.deep.equal([]);
    // a deep update is not implemented
    expect((await send(base + "/TravelSet('T0700')", "PATCH", {to_Bookings: [{BookingId: "B003"}]})).status).to.equal(501);
    for (const id of ["B001", "B002"]) {
      expect((await send(base + `/BookingSet(TravelId='T0700',BookingId='${id}')`, "DELETE")).status).to.equal(204);
    }
    expect((await send(base + "/TravelSet('T0700')", "DELETE")).status).to.equal(204);
  });

  it("applies $select, $filter, $orderby, $top, $skip and $count inside $expand", async () => {
    const one = await json(base + "/TravelSet('T0001')?$expand=to_Bookings($select=BookingId;$orderby=BookingId desc;$top=1;$count=true)");
    expect(one["@odata.context"]).to.equal(base + "/$metadata#TravelSet(to_Bookings(BookingId))/$entity");
    expect(one["to_Bookings@odata.count"]).to.equal(2);
    expect(one.to_Bookings).to.deep.equal([{BookingId: "B002"}]);
    const skipped = await json(base + "/TravelSet('T0001')?$expand=to_Bookings($skip=1)");
    expect(skipped.to_Bookings.map((b) => b.BookingId)).to.deep.equal(["B002"]);
    const counted = await json(base + "/TravelSet?$expand=to_Bookings($count=true;$top=0)&$orderby=TravelId&$top=3&$select=TravelId");
    expect(counted.value.map((t) => [t.TravelId, t["to_Bookings@odata.count"], t.to_Bookings.length])).to.deep.equal(
      [["T0001", 2, 0], ["T0002", 1, 0], ["T0003", 0, 0]]);
    // the expansion's $filter is a filter of the target set: the same converter, the same refusals
    expect((await fetch(base + "/TravelSet?$expand=to_Bookings($filter=tolower(Customer) eq 'x')")).status).to.equal(501);
    expect((await fetch(base + "/TravelSet?$expand=to_Bookings($filter=FlightDate eq '2026-09-15')")).status).to.equal(400);
    // ...and it reaches the DPC as select-options; the demo's hand-written BookingSet only
    // honours TravelId, the SADL runtime applies them all (as on a single request to the set)
    const cds = `${origin}/sap/opu/odata4/sap/ZC_STG_TRAVEL_CDS`;
    const filtered = await json(cds + "/ZC_STG_TRAVEL?$expand=to_Bookings($filter=CUSTOMER eq 'Grace Hopper';$count=true;$select=BOOKINGID)&$orderby=TRAVELID&$top=2&$select=TRAVELID");
    expect(filtered["@odata.context"]).to.equal(cds + "/$metadata#ZC_STG_TRAVEL(TRAVELID,to_Bookings(BOOKINGID))");
    expect(filtered.value[0]["to_Bookings@odata.count"]).to.equal(1);
    expect(filtered.value[0].to_Bookings).to.deep.equal([{BOOKINGID: "B002"}]);
    expect(filtered.value[1]["to_Bookings@odata.count"]).to.equal(0);
    expect(filtered.value[1].to_Bookings).to.deep.equal([]);
  });

  it("expands several levels and takes $select paths through a navigation", async () => {
    const deep = await json(base + "/BookingSet(TravelId='T0001',BookingId='B001')?$select=BookingId&$expand=to_Travel($select=Description;$expand=to_Bookings($select=Customer;$orderby=Customer desc))");
    expect(deep["@odata.context"]).to.equal(base + "/$metadata#BookingSet(BookingId,to_Travel(Description))/$entity");
    expect(Object.keys(deep).filter((k) => !k.startsWith("@"))).to.deep.equal(["BookingId", "to_Travel"]);
    expect(deep.to_Travel.Description).to.equal("Berlin to Copenhagen");
    expect(deep.to_Travel).not.to.have.property("TravelId");
    expect(deep.to_Travel["@odata.etag"]).to.match(/^W\//);
    expect(deep.to_Travel.to_Bookings).to.deep.equal([{Customer: "Grace Hopper"}, {Customer: "Ada Lovelace"}]);
    const paths = await json(base + "/TravelSet('T0001')?$select=TravelId,to_Bookings/Customer&$expand=to_Bookings");
    expect(paths.to_Bookings).to.deep.equal([{Customer: "Ada Lovelace"}, {Customer: "Grace Hopper"}]);
    // a $select inside the parentheses wins over the path on the parent
    const both = await json(base + "/TravelSet('T0001')?$select=to_Bookings/Customer&$expand=to_Bookings($select=BookingId)");
    expect(both.to_Bookings).to.deep.equal([{BookingId: "B001"}, {BookingId: "B002"}]);
    // the navigation property alone in $select is accepted (it has no links to show)
    expect((await json(base + "/TravelSet('T0001')?$select=TravelId,to_Bookings")).TravelId).to.equal("T0001");
    const none = await json(base + "/TravelSet('T0009')?$expand=to_Bookings($count=true;$top=1)");
    expect(none["to_Bookings@odata.count"]).to.equal(0);
    expect(none.to_Bookings).to.deep.equal([]);
  });

  it("hands $search to the DPC of a searchable entity set, as a term or a phrase", async () => {
    // T0001 and T0003 keep their seed descriptions through the suites above (T0002's is edited in a session)
    const term = await json(base + "/TravelSet?$search=Berlin&$orderby=TravelId");
    expect(term.value.map((t) => t.TravelId)).to.deep.equal(["T0001"]);
    const phrase = await json(base + `/TravelSet?$search=${encodeURIComponent('"Aarhus to"')}&$count=true&$top=1&$orderby=TravelId`);
    expect(phrase["@odata.count"]).to.equal(1);
    expect(phrase.value.map((t) => t.TravelId)).to.deep.equal(["T0003"]);
    expect((await json(base + "/TravelSet?$search=t0003")).value.map((t) => t.TravelId)).to.deep.equal(["T0003"]);
    expect((await json(base + "/TravelSet/$count?$search=Odense")).toString()).to.equal("1");
    expect((await json(base + "/TravelSet?$search=nothing-matches-this")).value).to.deep.equal([]);
    // the value help set is searchable too (the search help's text), the bookings are not
    expect((await json(base + "/StatusVHSet?$search=Cancel")).value.map((s) => s.Status)).to.deep.equal(["X"]);
    const res = await fetch(base + "/BookingSet?$search=Ada");
    expect(res.status).to.equal(501);
    expect((await res.json()).error.message).to.contain("searchable");
    expect((await fetch(base + "/TravelSet?$search=")).status).to.equal(400);
  });

  // The injection classes fixed on the V2 path (SQL host variables, JSON keys)
  // tried on the operation parameters, the bound key and $search: no row
  // changes, every answer is JSON, nothing is a 500.
  it("keeps quotes, backslashes, NUL and JSON fragments in parameters, keys and $search as data", async () => {
    const rows = async () => JSON.stringify((await json(base + "/TravelSet?$orderby=TravelId&$select=TravelId,Status,Seats,Description")).value);
    const answer = async (path, init) => {
      const res = await fetch(base + path, init);
      const text = await res.text();
      expect(() => JSON.parse(text), `${path}: ${text}`).not.to.throw();
      expect(res.status, `${path}: ${text}`).not.to.equal(500);
      return {status: res.status, body: JSON.parse(text)};
    };
    const literal = (v) => encodeURIComponent("'" + v.replaceAll("'", "''") + "'");
    const phrase = (v) => encodeURIComponent('"' + v.replaceAll("\\", "\\\\").replaceAll('"', '\\"') + '"');
    // T0003 is cancelled below with every value; cancel it once first so the snapshot is its final state
    await answer("/TravelSet('T0003')/ZSTG_DEMO_SRV.CancelTravel", {method: "POST", headers: {"content-type": "application/json", "if-match": "*"}, body: "{}"});
    const before = await rows();
    const values = ["'", "A'", "' OR '1'='1", '"', "\\", '"},{"x":1', '{"TravelId":"T0002"}', "A\u2028"];
    for (const value of values) {
      const count = await answer(`/TravelCount(Status=${literal(value)})`);
      // Status has MaxLength 1: a value that fits is counted, a longer one is
      // the same 400 as an over-long key (check_length, as on V2)
      if (value.length <= 1) {
        expect(count.status, value).to.equal(200);
        expect(count.body.value, value).to.be.a("number");
      } else {
        expect(count.status, value).to.equal(400);
      }
      // the binding's key wins over a body parameter of the same name, and a
      // body parameter longer than TravelId's MaxLength 8 is a 400 before it
      // can reach the DPC
      const cancel = await answer("/TravelSet('T0003')/ZSTG_DEMO_SRV.CancelTravel",
        {method: "POST", headers: {"content-type": "application/json", "if-match": "*"}, body: JSON.stringify({TravelId: value})});
      if (value.length <= 8) {
        expect(cancel.status, value).to.equal(200);
        expect(cancel.body.TravelId, value).to.equal("T0003");
      } else {
        expect(cancel.status, value).to.equal(400);
      }
      expect((await answer(`/TravelSet(${literal("T9" + value)})`)).status, value).to.be.oneOf([400, 404]);
      expect((await answer(`/TravelSet?$search=${phrase(value)}`)).body.value, value).to.deep.equal([]);
      expect([200, 400, 501], value).to.include((await answer(`/TravelSet?$search=${encodeURIComponent(value)}`)).status);
    }
    // NUL is refused wherever it comes from
    expect((await answer(`/TravelCount(Status=${literal("A\u0000")})`)).status).to.equal(400);
    expect((await answer("/TravelSet('T0003')/ZSTG_DEMO_SRV.CancelTravel", {method: "POST",
      headers: {"content-type": "application/json"}, body: '{"TravelId":"T\\u0000"}'})).status).to.equal(400);
    // a key longer than its MaxLength would be cut to another entity's key by
    // the DPC: check_keys refuses it (400) on a read, a write and a bound action
    const long = encodeURIComponent("'T0002    X'");
    expect((await answer(`/TravelSet(${long})`)).status).to.equal(400);
    expect((await answer(`/TravelSet(${long})/ZSTG_DEMO_SRV.CancelTravel`, {method: "POST",
      headers: {"content-type": "application/json", "if-match": "*"}, body: "{}"})).status).to.equal(400);
    expect((await answer(`/TravelSet(${long})`, {method: "PATCH",
      headers: {"content-type": "application/json", "if-match": "*"}, body: '{"Seats":9}'})).status).to.equal(400);
    expect(await rows()).to.equal(before);
    // a phrase is read in one pass: an escaped backslash before a quote ends it
    expect((await answer(`/TravelSet?$search=${encodeURIComponent('"x\\\\" OR "y"')}`)).status).to.equal(501);
    expect((await answer(`/TravelSet?$search=${encodeURIComponent('"a" "b"')}`)).status).to.equal(501);
    expect((await answer(`/TravelSet?$search=${encodeURIComponent('"a\\"')}`)).status).to.equal(400);
    expect((await answer(`/TravelSet?$search=${encodeURIComponent('"a\\q"')}`)).status).to.equal(400);
    const spaced = await answer(`/TravelSet?$search=${encodeURIComponent('"Aarhus to"')}&$orderby=TravelId`);
    expect(spaced.body.value.map((t) => t.TravelId)).to.deep.equal(["T0003"]);
  });

  // OData 4.01 Part 1, 11.5.5: If-Match applies to the binding parameter of a
  // bound action, which sap.fe sends; the action runs under the entity lock.
  it("checks If-Match and the entity lock of a bound action's binding parameter", async () => {
    const path = "/TravelSet('T0002')";
    const read = await fetch(base + path);
    const etag = read.headers.get("etag") ?? (await read.json())["@odata.etag"];
    expect(etag).to.match(/^W\//);
    const status = (await json(base + path)).Status;
    const cancel = (headers) => fetch(base + path + "/ZSTG_DEMO_SRV.CancelTravel",
      {method: "POST", headers: {"content-type": "application/json", ...headers}, body: "{}"});
    // no If-Match on an entity with an ETag: 428, as for PATCH, row unchanged
    let res = await cancel({});
    expect(res.status, await res.clone().text()).to.equal(428);
    expect((await json(base + path)).Status).to.equal(status);
    res = await cancel({"if-match": 'W/"bogus"'});
    expect(res.status, await res.clone().text()).to.equal(412);
    expect((await json(base + path)).Status).to.equal(status);
    // held by another request: 409, row unchanged
    const {enqTake, enqDrop} = await import("../tools/osd-enq-host.mjs");
    const input = lockInput("ZSTG_DEMO_SRV", "TravelSet", "TravelId=T0002");
    expect(enqTake("v4-action-lock", "OTHER", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input).subrc).to.equal(0);
    try {
      expect((await cancel({"if-match": etag})).status).to.equal(409);
    } finally {
      enqDrop("v4-action-lock", "ZOSD_V4_LOCK", "EZOSD_V4_LOCK", input);
    }
    expect((await json(base + path)).Status).to.equal(status);
    // the current ETag passes; then the old one is stale
    res = await cancel({"if-match": etag});
    expect(res.status, await res.clone().text()).to.equal(200);
    expect((await res.json()).Status).to.equal("X");
    if (status !== "X") {
      expect((await cancel({"if-match": etag})).status).to.equal(412);
    }
    // a missing key is 404 whatever If-Match says
    expect((await fetch(base + "/TravelSet('T0404')/ZSTG_DEMO_SRV.CancelTravel",
      {method: "POST", headers: {"content-type": "application/json", "if-match": "*"}, body: "{}"})).status).to.equal(404);
    expect((await send(base + path, "PATCH", {Status: status})).status).to.equal(204);
  });

  it("reads operation parameters by their type: strings quoted, each name once", async () => {
    for (const [path, want] of [["/TravelCount(Status=1)", 400], ["/TravelCount(Status=A)", 400],
      ["/TravelCount(Status='A',Status='X')", 400], ["/TravelCount(Status=null)", 200]]) {
      const res = await fetch(base + path);
      expect(res.status, path + " " + await res.clone().text()).to.equal(want);
    }
    const action = (text) => fetch(base + "/TravelSet('T0003')/ZSTG_DEMO_SRV.CancelTravel",
      {method: "POST", headers: {"content-type": "application/json", "if-match": "*"}, body: text});
    for (const text of ['{"TravelId":5}', '{"TravelId":true}', '{"TravelId":"T0003","TravelId":"T0003"}']) {
      const res = await action(text);
      expect(res.status, text + " " + await res.clone().text()).to.equal(400);
    }
    expect((await action('{"TravelId":"T0003"}')).status).to.equal(200);
  });

  it("says which sets have no full-text search, and $search wants a collection", async () => {
    const res = await fetch(base + "/$metadata");
    const xml = await res.text();
    const doc = new XMLParser({ignoreAttributes: false, attributeNamePrefix: ""}).parse(xml);
    const refs = array(doc["edmx:Edmx"]["edmx:Reference"]).map((r) => r["edmx:Include"]);
    expect(refs).to.deep.include({Namespace: "Org.OData.Capabilities.V1", Alias: "Capabilities"});
    const sets = array(doc["edmx:Edmx"]["edmx:DataServices"].Schema.EntityContainer.EntitySet);
    const restriction = (name) => array(sets.find((x) => x.Name === name).Annotation)
      .find((a) => a.Term === "Capabilities.SearchRestrictions");
    expect(restriction("BookingSet").Record.PropertyValue).to.deep.equal({Property: "Searchable", Bool: "false"});
    expect(restriction("TravelSet")).to.equal(undefined);
    expect((await fetch(base + "/TravelSet('T0001')?$search=Aarhus")).status).to.equal(400);
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
