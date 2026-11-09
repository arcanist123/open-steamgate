import {expect} from "chai";
import {startServer} from "./start.mjs";
// the port of the gateway under test: STG_PORT, as test/start.mjs reads it, so sessions do not collide on 3030
const PORT = process.env.STG_PORT ?? 3030;

const BASE = `http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_DEMO_SRV`;

describe("wire", () => {
  let server;

  before(() => {
    server = startServer(true);
  });

  after(() => server.close());

  // The front door is the launchpad: every app and every demo the system
  // serves is a tile on it, the UI5 ones as components and the ABAP-written
  // pages as plain URLs, which is the honest shape — a tile points at a
  // service and what is behind it need not be UI5 to belong on the page.
  it("root is the launchpad, and the launchpad names what this system serves", async () => {
    const res = await fetch(`http://localhost:${PORT}/`, {redirect: "manual"});
    expect(res.status).to.equal(302);
    expect(res.headers.get("location")).to.equal("/app/flp.html");
    const page = await (await fetch(`http://localhost:${PORT}/app/flp.html`)).text();
    for (const tile of ["Travels", "Bookings", "Flight analytics", "SEGW", "Vivid Vibes", "Zork"]) {
      expect(page, tile).to.contain(tile);
    }
    expect(page, "the demo behind its tile").to.contain("../sap/bc/zo4d_demo");
    expect(page, "zork behind its tile").to.contain("../sap/bc/zork");
  });

  // A pack reaches the launchpad by declaring tiles in its osd-pack.json;
  // the page asks for them at start, so neither flp.html nor launchpad.js
  // knows a pack's name (backlog E.2).
  it("the launchpad is told which tiles the packs ask for", async () => {
    const res = await fetch(`http://localhost:${PORT}/app/packs.json`);
    expect(res.status).to.equal(200);
    const {tiles} = await res.json();
    expect(tiles).to.be.an("array");
    for (const tile of tiles) {
      expect(tile, JSON.stringify(tile)).to.include.keys("id", "title", "icon", "url", "pack");
    }
    const page = await (await fetch(`http://localhost:${PORT}/app/launchpad.js`)).text();
    expect(page, "the launchpad asks for them").to.contain("packs.json");
  });

  // The sandbox resolves an intent only from the applications it boots
  // with, so a pack's intents have to be in the page's config before
  // sandbox.js runs, not added by launchpad.js afterwards.
  it("the launchpad boots with the intents the packs' apps declare", async () => {
    const {applications} = await (await fetch(`http://localhost:${PORT}/app/packs.json`)).json();
    expect(applications).to.be.an("object");
    for (const [intent, app] of Object.entries(applications)) {
      expect(intent).to.match(/^[^-]+-[^-]+$/);
      expect(app.additionalInformation, intent).to.match(/^SAPUI5\.Component=/);
      expect(app.url, intent).to.match(/^\.\.\/sap\/bc\/ui5_ui5\/sap\/z[a-z0-9_]+\/$/);
    }
    const flp = await (await fetch(`http://localhost:${PORT}/app/flp.html`)).text();
    const read = flp.indexOf('"./packs.json", false');
    expect(read, "flp.html reads packs.json synchronously").to.be.greaterThan(-1);
    expect(read, "before the sandbox boots").to.be.lessThan(flp.indexOf("bootstrap/sandbox.js"));
  });

  it("$metadata", async () => {
    const res = await fetch(BASE + "/$metadata");
    expect(res.status).to.equal(200);
    expect(res.headers.get("content-type")).to.contain("application/xml");
    expect(res.headers.get("dataserviceversion")).to.equal("2.0");
    const xml = await res.text();
    expect(xml).to.contain('<EntityType Name="Travel"');
    expect(xml).to.contain('<EntitySet Name="TravelSet" EntityType="ZSTG_DEMO_SRV.Travel"');
  });

  it("entity set as OData v2 JSON", async () => {
    const res = await fetch(BASE + "/TravelSet?$format=json");
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.d.results).to.have.length(4);
    expect(body.d.results[0].TravelId).to.equal("T0001");
    expect(body.d.results[0].Seats).to.equal(2);
    expect(body.d.results[0].__metadata.uri).to.equal(
      `http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('T0001')`);
  });

  it("$top/$skip/$inlinecount", async () => {
    const res = await fetch(BASE + "/TravelSet?$top=2&$skip=1&$inlinecount=allpages");
    const body = await res.json();
    expect(body.d.results.map((r) => r.TravelId)).to.deep.equal(["T0002", "T0003"]);
    expect(body.d.__count).to.equal("2");
  });

  it("single entity by key", async () => {
    const res = await fetch(BASE + "/TravelSet('T0003')");
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.d.Description).to.equal("Aarhus to Odense");
    expect(body.d.__metadata.type).to.equal("ZSTG_DEMO_SRV.Travel");
  });

  it("$filter reaches the DPC as select-options", async () => {
    const res = await fetch(BASE + "/TravelSet?$filter=" + encodeURIComponent("Status eq 'X' or Status eq 'Z'"));
    expect(res.status).to.equal(200);
    const body = await res.json();
    expect(body.d.results.map((r) => r.TravelId)).to.deep.equal(["T0003"]);
  });

  it("navigation and $expand", async () => {
    let res = await fetch(BASE + "/TravelSet('T0001')/to_Bookings");
    expect(res.status).to.equal(200);
    let body = await res.json();
    expect(body.d.results.map((b) => b.BookingId)).to.deep.equal(["B001", "B002"]);
    expect(body.d.results[0].FlightDate).to.match(/^\/Date\(\d+\)\/$/);

    res = await fetch(BASE + "/TravelSet?$expand=to_Bookings&$top=1");
    body = await res.json();
    expect(body.d.results[0].to_Bookings.results).to.have.length(2);
    expect(body.d.results[0].to_Bookings.results[1].Customer).to.equal("Grace Hopper");

    res = await fetch(BASE + "/BookingSet(TravelId='T0002',BookingId='B001')?$expand=to_Travel");
    body = await res.json();
    expect(body.d.to_Travel.Description).to.equal("Copenhagen to Aarhus");

    res = await fetch(BASE + "/TravelSet('T0002')");
    body = await res.json();
    expect(body.d.to_Bookings.__deferred.uri).to.equal(BASE + "/TravelSet('T0002')/to_Bookings");
  });

  it("deep insert: a travel with its bookings in one POST", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({
      TravelId: "T0700", Description: "Deep over the wire", Status: "A", Seats: 1,
      to_Bookings: [{BookingId: "B001", Customer: "Barbara Liskov"}],
    })});
    expect(res.status).to.equal(201);
    const body = await res.json();
    expect(body.d.to_Bookings.results[0].Customer).to.equal("Barbara Liskov");
    res = await fetch(BASE + "/TravelSet('T0700')/to_Bookings");
    expect((await res.json()).d.results).to.have.length(1);
    await fetch(BASE + "/TravelSet('T0700')", {method: "DELETE", headers});
  });

  // A key is data in the response too. The V2 entry built its __deferred
  // links from the key before the key was escaped for JSON, so a key with a
  // quote or a backslash (POST makes one) broke GET by key and every list
  // that held the row; the Location of a created row with a key outside
  // Latin-1 was a 500 after the row was committed; a NUL in a key was a 500.
  it("a quote or a backslash in a key stays data in the response: GET by key, the list, the deferred links", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    const keyUrl = (key) => `${BASE}/TravelSet(${encodeURIComponent("'" + key.replace(/'/g, "''") + "'")})`;
    // a lone CR, a backspace, a form feed and the other controls below
    // U+0020 must be escaped too, or the stored row breaks the whole list;
    // a quote (OData's own '') must round-trip as well
    for (const key of ['a"b', "a\\b", 'q","x":"', "a\rb", "a\u0001b", "a\bb", "a\fb", "a\u001fb", "a'b"]) {
      let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: key, Description: "odd", Status: "A", Seats: 1})});
      expect(res.status, key).to.equal(201);
      res = await fetch(keyUrl(key) + "?$format=json");
      expect(res.status, key).to.equal(200);
      const one = JSON.parse(await res.text()).d;
      expect(one.TravelId, key).to.equal(key);
      expect(Object.keys(one), key).to.not.include("x");
      expect(one.to_Bookings.__deferred.uri, key).to.equal(one.__metadata.uri + "/to_Bookings");
      const all = JSON.parse(await (await fetch(BASE + "/TravelSet?$format=json")).text());
      expect(all.d.results.map((t) => t.TravelId), key).to.include(key);
      expect((await fetch(keyUrl(key), {method: "DELETE", headers})).status, key).to.equal(204);
    }
  });

  // a character outside the BMP is one code point in the URI, not two
  // lone surrogates (which came out as two U+FFFD and a 404)
  it("the Location of a created row with a key outside Latin-1 or outside the BMP is a URI", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    const keyUrl = (key) => `${BASE}/TravelSet(${encodeURIComponent("'" + key + "'")})`;
    for (const key of ["Жук", "\u{1F600}", "a\u{1F600}b"]) {
      let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: key, Description: "odd", Status: "A", Seats: 1})});
      expect(res.status, key).to.equal(201);
      const location = res.headers.get("location");
      expect(location, key).to.match(/^[\x20-\x7e]+$/);
      res = await fetch(location + "?$format=json");
      expect(res.status, key).to.equal(200);
      expect((await res.json()).d.TravelId, key).to.equal(key);
      expect((await fetch(keyUrl(key), {method: "DELETE", headers})).status, key).to.equal(204);
    }
  });

  it("a NUL in a key or a $filter literal is a 400 in V2 and V4, in the URL and in a POST body", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    expect((await fetch(`${BASE}/TravelSet('a%00b')?$format=json`)).status).to.equal(400);
    expect((await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet('a%00b')`)).status).to.equal(400);
    expect((await fetch(`${BASE}/TravelSet?$filter=TravelId%20eq%20'a%00b'&$format=json`)).status).to.equal(400);
    expect((await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet?$filter=TravelId%20eq%20'a%00b'`)).status).to.equal(400);
    let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: "a\u0000b", Description: "nul", Status: "A", Seats: 1})});
    expect(res.status).to.equal(400);
    res = await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet`, {method: "POST", headers, body: JSON.stringify({TravelId: "a\u0000c", Description: "nul", Status: "A", Seats: 1})});
    expect(res.status).to.equal(400);
    const all = await (await fetch(BASE + "/TravelSet?$format=json")).json();
    expect(all.d.results.map((t) => t.TravelId).filter((id) => id.startsWith("a"))).to.deep.equal([]);
  });

  // CHAR semantics: trailing blanks of a CHAR key are not part of it, so
  // 'T0001 ' is T0001 in V2 and V4 alike.
  it("a trailing blank in a CHAR key: V2 and V4 find the same row", async () => {
    const v2 = await fetch(`${BASE}/TravelSet('T0001%20')?$format=json`);
    expect(v2.status).to.equal(200);
    expect((await v2.json()).d.TravelId).to.equal("T0001");
    const v4 = await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet('T0001%20')`);
    expect(v4.status).to.equal(200);
    expect((await v4.json()).TravelId).to.equal("T0001");
  });

  // A key or a function import parameter longer than the MaxLength of its
  // property is a 400, as the Gateway's URI parser answers it. Before, the
  // DPC's CHAR(8) field cut it: TravelSet('T0002    X') read, merged, put
  // and deleted T0002, and TravelCount(Status='A''') counted the 'A' rows.
  // The $filter half below is the demo DPC's behaviour, not the gateway's:
  // its ranges are strings (src/demo/zcl_zstg_demo_dpc_ext.clas.abap:37-42),
  // so the literal stays whole and matches no row; a DDIC-typed CHAR range
  // on a system would cut it to T0001 (docs/key-length.md).
  it("a key or a parameter longer than its MaxLength is a 400; a long $filter literal matches nothing in the demo DPC", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    const long = encodeURIComponent("'T0002    X'");
    const before = (await (await fetch(`${BASE}/TravelSet('T0002')?$format=json`)).json()).d;
    let res = await fetch(`${BASE}/TravelSet(${long})?$format=json`);
    expect(res.status).to.equal(400);
    const error = (await res.json()).error;
    expect(error.code).to.equal("STG/VALUE_TOO_LONG");
    expect(JSON.stringify(error.message)).to.contain("TravelId").and.contain("MaxLength 8");
    expect((await fetch(`${BASE}/TravelSet(TravelId=${long})?$format=json`)).status).to.equal(400);
    expect((await fetch(`${BASE}/TravelSet(${long})/to_Bookings?$format=json`)).status).to.equal(400);
    for (const [method, body] of [["MERGE", {Description: "wrong row"}], ["PUT", {Description: "wrong row", Status: "X", Seats: 1}], ["DELETE", undefined]]) {
      res = await fetch(`${BASE}/TravelSet(${long})`, {method, headers, body: body && JSON.stringify(body)});
      expect(res.status, method).to.equal(400);
    }
    res = await fetch(`${BASE}/TravelSet(${long})/to_Bookings`, {method: "POST", headers, body: JSON.stringify({BookingId: "B990", Customer: "wrong"})});
    expect(res.status, "POST through navigation").to.equal(400);
    const after = await fetch(`${BASE}/TravelSet('T0002')?$format=json`);
    expect(after.status).to.equal(200);
    expect((await after.json()).d).to.deep.equal(before);
    // exactly MaxLength is still a key
    expect((await fetch(`${BASE}/TravelSet('T0002%20%20%20')?$format=json`)).status).to.equal(200);

    // the demo DPC's string ranges keep the literal whole, so no row matches
    const filtered = await (await fetch(`${BASE}/TravelSet?$format=json&$filter=` + encodeURIComponent("TravelId eq 'T0001    X'"))).json();
    expect(filtered.d.results).to.deep.equal([]);
    const v4 = await (await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet?$filter=` + encodeURIComponent("TravelId eq 'T0001    X'"))).json();
    expect(v4.value).to.deep.equal([]);

    res = await fetch(`${BASE}/TravelCount?Status=${encodeURIComponent("'A'''")}`);
    expect(res.status).to.equal(400);
    expect((await res.json()).error.code).to.equal("STG/VALUE_TOO_LONG");
    expect((await fetch(`${BASE}/TravelCount?Status='AX'`)).status).to.equal(400);
    res = await fetch(`${BASE}/CancelTravel?TravelId=${long}`, {method: "POST", headers: {"x-csrf-token": "open-steamgate"}});
    expect(res.status).to.equal(400);
    expect((await (await fetch(`${BASE}/TravelSet('T0002')?$format=json`)).json()).d.Status).to.equal(before.Status);
  });

  // The MaxLength check measures the value the way a CHAR field holds it:
  // at its last non-blank character. Trailing blanks can never address
  // another entity (the DPC's field drops or pads them), so a key of
  // MaxLength characters plus blanks is accepted, and only a non-blank
  // character beyond the MaxLength is a 400.
  it("trailing blanks never make a key or a parameter too long; a non-blank beyond the MaxLength does", async () => {
    // T0001 + 4 blanks: 9 characters, 5 significant, MaxLength 8
    const padded = encodeURIComponent("'T0001    '");
    const v2 = await fetch(`${BASE}/TravelSet(${padded})?$format=json`);
    expect(v2.status).to.equal(200);
    expect((await v2.json()).d.TravelId).to.equal("T0001");
    const v4 = await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet(${padded})`);
    expect(v4.status).to.equal(200);
    expect((await v4.json()).TravelId).to.equal("T0001");
    const beyond = encodeURIComponent("'T0001   X'");
    expect((await fetch(`${BASE}/TravelSet(${beyond})?$format=json`)).status).to.equal(400);
    expect((await fetch(`http://localhost:${PORT}/sap/opu/odata4/sap/ZSTG_DEMO_SRV/TravelSet(${beyond})`)).status).to.equal(400);
    // Status has MaxLength 1: 'A ' (a trailing blank) counts the A rows
    const withBlank = await fetch(`${BASE}/TravelCount?Status=${encodeURIComponent("'A '")}`);
    expect(withBlank.status).to.equal(200);
    expect((await withBlank.json()).d.TravelCount).to.equal((await (await fetch(`${BASE}/TravelCount?Status='A'`)).json()).d.TravelCount);
  });

  // ANOMALY-2026-11-08-sql-host-variable-inlined: the transpiler inlined a
  // host variable into the SQL text unescaped, so a quote in a key ended the
  // literal. Measured before the pinned fix: GET of this key answered T0001,
  // MERGE of it changed every travel's Description, and a'b was a 500.
  it("a quote in a key stays in the key: nothing else is read or written", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    const injected = encodeURIComponent("'x'' OR ''1''=''1'");
    // longer than TravelId's MaxLength 8, it is refused before the DPC; a
    // quoted key that fits reaches the SELECT and finds nothing
    expect((await fetch(`${BASE}/TravelSet(${injected})?$format=json`)).status).to.equal(400);
    expect((await fetch(`${BASE}/TravelSet(${encodeURIComponent("'x''OR''1'")})?$format=json`)).status).to.equal(404);
    const merged = await fetch(`${BASE}/TravelSet(${injected})`, {method: "MERGE", headers, body: JSON.stringify({Description: "oracle"})});
    expect(merged.status).to.equal(400);
    const all = await (await fetch(`${BASE}/TravelSet?$format=json`)).json();
    expect(all.d.results.map((t) => t.Description)).to.not.include("oracle");
    expect(all.d.results.find((t) => t.TravelId === "T0001").Description).to.equal("Berlin to Copenhagen");
    const filtered = await (await fetch(`${BASE}/TravelSet?$format=json&$filter=` + encodeURIComponent("TravelId eq 'x'' OR ''1''=''1'"))).json();
    expect(filtered.d.results).to.deep.equal([]);
    // and a key with a quote round-trips
    let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: "a'b", Description: "quoted", Status: "A", Seats: 1})});
    expect(res.status).to.equal(201);
    res = await fetch(`${BASE}/TravelSet('a''b')?$format=json`);
    expect(res.status).to.equal(200);
    expect((await res.json()).d).to.include({TravelId: "a'b", Description: "quoted"});
    res = await fetch(`${BASE}/TravelSet('a''b')`, {method: "MERGE", headers, body: JSON.stringify({Description: "it's"})});
    expect(res.status).to.equal(204);
    expect((await (await fetch(`${BASE}/TravelSet('a''b')?$format=json`)).json()).d.Description).to.equal("it's");
    res = await fetch(`${BASE}/TravelSet('a''b')`, {method: "DELETE", headers});
    expect(res.status).to.equal(204);
    expect((await fetch(`${BASE}/TravelSet('a''b')?$format=json`)).status).to.equal(404);
  });

  it("media entity: the picture of a travel over the wire", async () => {
    // $metadata says the type has a stream, the JSON says where it is
    const meta = await (await fetch(`${BASE}/$metadata`)).text();
    expect(meta).to.contain('<EntityType Name="Photo" m:HasStream="true"');
    const photo = await (await fetch(`${BASE}/PhotoSet('T0001')?$format=json`)).json();
    expect(photo.d.__metadata.media_src).to.equal(`${BASE}/PhotoSet('T0001')/$value`);
    expect(photo.d.FileName).to.equal("t0001.png");

    // the bytes themselves, with their content type
    const res = await fetch(`${BASE}/PhotoSet('T0001')/$value`);
    expect(res.status).to.equal(200);
    expect(res.headers.get("content-type")).to.equal("image/png");
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(bytes.length).to.equal(930);
    expect([...bytes.slice(0, 8)]).to.deep.equal([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

    // and the travel points at it, so Fiori Elements can show it
    const travel = await (await fetch(`${BASE}/TravelSet('T0003')?$format=json`)).json();
    expect(travel.d.PhotoUrl).to.equal("../sap/opu/odata/sap/ZSTG_DEMO_SRV/PhotoSet('T0003')/$value");
  });

  it("function imports", async () => {
    let res = await fetch(BASE + "/TravelCount?Status='A'");
    expect(res.status).to.equal(200);
    expect((await res.json()).d.TravelCount).to.equal(3);

    res = await fetch(BASE + "/CancelTravel?TravelId='T0009'", {method: "POST", headers: {"x-csrf-token": "open-steamgate"}});
    expect(res.status).to.equal(200);
    expect((await res.json()).d.Status).to.equal("X");
    // put the seed row back for the tests that follow
    res = await fetch(BASE + "/TravelSet('T0009')", {method: "PUT", headers: {"content-type": "application/json", "x-csrf-token": "open-steamgate"}, body: JSON.stringify({Description: "Other client, must not leak", Status: "A", Seats: 9})});
    expect(res.status).to.equal(204);
  });

  it("SADL service over CDS views: read, navigate, aggregate", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_SADL_SRV`;
    let res = await fetch(S + "/$metadata");
    expect(res.status).to.equal(200);
    const xml = await res.text();
    expect(xml).to.contain('<EntitySet Name="Zc_Stg_TravelcubeSet"');
    expect(xml).to.contain('sap:semantics="aggregate"');
    expect(xml).to.contain('Term="com.sap.vocabularies.UI.v1.LineItem"');

    res = await fetch(S + "/Zc_Stg_TravelSet?$filter=STATUS eq 'A'&$orderby=TRAVELID desc");
    expect(res.status).to.equal(200);
    expect((await res.json()).d.results.map((r) => r.TRAVELID)).to.deep.equal(["T0009", "T0002", "T0001"]);

    res = await fetch(S + "/Zc_Stg_TravelSet('T0001')/TO_BOOKINGS");
    expect((await res.json()).d.results.map((r) => r.BOOKINGID)).to.deep.equal(["B001", "B002"]);

    res = await fetch(S + "/Zc_Stg_TravelcubeSet?$select=STATUS,SEATS&$orderby=STATUS");
    const rows = (await res.json()).d.results.map((r) => [r.STATUS, r.SEATS]);
    expect(rows).to.deep.equal([["A", 12], ["X", 4]]);
  });

  it("SADL substringof and startswith filters preserve mixed case", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_SADL_SRV/Zc_Stg_TravelSet`;
    for (const [filter, ids] of [
      ["startswith(DESCRIPTION,'Berlin')", ["T0001"]],
      ["startswith(DESCRIPTION,'berlin')", []],
      ["substringof('erlin',DESCRIPTION)", ["T0001"]],
      ["substringof('ERLIN',DESCRIPTION)", []],
    ]) {
      const res = await fetch(`${S}?$filter=${encodeURIComponent(filter)}&$format=json`);
      expect(res.status, filter).to.equal(200);
      expect((await res.json()).d.results.map(row => row.TRAVELID), filter).to.deep.equal(ids);
    }
  });

  it("virtual elements: a CDS field an ABAP class calculates after the read", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_SADL_SRV`;
    // the model says they exist and that the database cannot order or filter by them
    const xml = await (await fetch(S + "/$metadata")).text();
    expect(xml).to.contain('<Property Name="OCCUPANCY" Type="Edm.String" Nullable="true" MaxLength="12" sap:unicode="false" sap:label="Occupancy" sap:creatable="false" sap:updatable="false" sap:sortable="false" sap:filterable="false"/>');
    expect(xml).to.contain('<Property Name="FREESEATS" Type="Edm.Int32"');

    // zcl_stg_travel_calc fills them: occupancy from the row, free seats from
    // the bookings of that travel (T0001 has 2 seats and 2 bookings)
    const rows = (await (await fetch(S + "/Zc_Stg_TravelSet?$format=json")).json()).d.results;
    expect(rows.map((r) => [r.TRAVELID, r.OCCUPANCY, r.FREESEATS])).to.deep.equal([
      ["T0001", "20% of 10", 0],
      ["T0002", "10% of 10", 0],
      ["T0003", "40% of 10", 4],
      ["T0009", "90% of 10", 9],
    ]);
    const one = (await (await fetch(S + "/Zc_Stg_TravelSet('T0003')?$format=json")).json()).d;
    expect(one.OCCUPANCY).to.equal("40% of 10");
    expect(one.FREESEATS).to.equal(4);

    // and SADL refuses what it cannot do, instead of failing in SQL
    for (const query of ["$filter=OCCUPANCY eq 'x'", "$orderby=FREESEATS"]) {
      const res = await fetch(`${S}/Zc_Stg_TravelSet?${query}`);
      expect(res.status).to.equal(400);
      expect((await res.json()).error.message.value).to.contain("is a virtual element");
    }
  });

  it("@OData.publish: a CDS view is a service, without SEGW", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZC_STG_TRAVEL_CDS`;
    // the annotation on the view generated the model, the registration
    // objects and the classes; the registry serves them like any other service
    // the exposed association pulled ZC_STG_BOOKING into the same service,
    // and the entity set is the view's own name - measured on a system
    // 2026-09-17, docs/cds-publish.md
    const doc = await (await fetch(S + "/")).json();
    expect(doc.d.EntitySets).to.deep.equal(["ZC_STG_TRAVEL", "ZC_STG_BOOKING"]);

    const xml = await (await fetch(S + "/$metadata")).text();
    expect(xml).to.contain('<EntityType Name="ZC_STG_TRAVELType"');
    expect(xml).to.contain('<EntityType Name="ZC_STG_BOOKINGType"');
    expect(xml).to.contain('<EntitySet Name="ZC_STG_TRAVEL" EntityType="ZC_STG_TRAVEL_CDS.ZC_STG_TRAVELType"');
    expect(xml).to.contain('<EntitySet Name="ZC_STG_BOOKING" EntityType="ZC_STG_TRAVEL_CDS.ZC_STG_BOOKINGType"');
    // the child of the composition asks for writes too, so it is not flagged read-only
    expect(xml).to.not.contain('Name="ZC_STG_BOOKING" EntityType="ZC_STG_TRAVEL_CDS.ZC_STG_BOOKINGType" sap:creatable="false"');
    expect(xml).to.contain("<EntityContainer Name=\"ZC_STG_TRAVEL_CDS_Entities\"");
    // the association is assoc_<32 hex>, the same string on its set, with
    // FromRole_/ToRole_ roles; the hex is a hash here, not a GUID, so that a
    // build is reproducible
    const assoc = /<NavigationProperty Name="to_Bookings" Relationship="ZC_STG_TRAVEL_CDS\.(assoc_[0-9a-f]{32})" FromRole="FromRole_\1" ToRole="ToRole_\1"\/>/.exec(xml);
    expect(assoc, "to_Bookings navigation property").to.not.equal(null);
    expect(xml).to.contain(`<Association Name="${assoc[1]}"`);
    expect(xml).to.contain(`<End Type="ZC_STG_TRAVEL_CDS.ZC_STG_BOOKINGType" Multiplicity="*" Role="ToRole_${assoc[1]}"/>`);
    expect(xml).to.contain(`<AssociationSet Name="${assoc[1]}"`);
    expect(xml).to.contain(`<End EntitySet="ZC_STG_BOOKING" Role="ToRole_${assoc[1]}"/>`);
    // ZC_STG_BOOKING exposes _Travel back: the cycle is followed once
    expect(xml).to.contain('<NavigationProperty Name="to_Travel"');

    const rows = (await (await fetch(S + "/ZC_STG_TRAVEL?$format=json&$filter=STATUS eq 'A'")).json()).d.results;
    expect(rows.map((r) => r.TRAVELID)).to.deep.equal(["T0001", "T0002", "T0009"]);
    // the virtual elements of the view are part of the published service too
    expect(rows[0].OCCUPANCY).to.equal("20% of 10");

    // and the navigation carries data, not only metadata: the target rows are
    // the ones the ON condition selects, both nested and through the URL
    const expanded = (await (await fetch(S + "/ZC_STG_TRAVEL?$top=1&$expand=to_Bookings&$format=json")).json()).d.results[0];
    expect(expanded.to_Bookings.results.map((r) => r.BOOKINGID)).to.deep.equal(["B001", "B002"]);
    const below = (await (await fetch(S + "/ZC_STG_TRAVEL('T0002')/to_Bookings?$format=json")).json()).d.results;
    expect(below.map((r) => `${r.TRAVELID}/${r.BOOKINGID}`)).to.deep.equal(["T0002/B001"]);
    const up = (await (await fetch(S + "/ZC_STG_BOOKING(TRAVELID='T0002',BOOKINGID='B001')/to_Travel?$format=json")).json()).d;
    expect(up.TRAVELID).to.equal("T0002");

    // the cube views are published as well
    const cube = await (await fetch(`http://localhost:${PORT}/sap/opu/odata/sap/ZC_STG_FLIGHTCUBE_CDS/`)).json();
    expect(cube.d.EntitySets).to.deep.equal(["ZC_STG_FLIGHTCUBE"]);
  });

  it("writes through a CDS projection: @ObjectModel.writeEnabled", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZC_STG_TRAVEL_CDS`;
    const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};

    // the view is a projection of one table field for field, so SADL writes
    // through it: the row lands in ZSTG_DEMO
    let res = await fetch(S + "/ZC_STG_TRAVEL", {method: "POST", headers: write,
      body: JSON.stringify({TRAVELID: "T0700", DESCRIPTION: "Through the projection", STATUS: "A", SEATS: 3})});
    expect(res.status).to.equal(201);

    const demo = await (await fetch(`${BASE}/TravelSet('T0700')?$format=json`)).json();
    expect(demo.d.Description).to.equal("Through the projection");

    res = await fetch(S + "/ZC_STG_TRAVEL('T0700')", {method: "PUT", headers: write,
      body: JSON.stringify({DESCRIPTION: "Renamed", STATUS: "X", SEATS: 5})});
    expect(res.status).to.equal(204);
    const after = (await (await fetch(S + "/ZC_STG_TRAVEL('T0700')?$format=json")).json()).d;
    expect([after.DESCRIPTION, after.STATUS, after.SEATS]).to.deep.equal(["Renamed", "X", 5]);
    // the virtual element is recalculated on the way out
    expect(after.OCCUPANCY).to.equal("50% of 10");

    res = await fetch(S + "/ZC_STG_TRAVEL('T0700')", {method: "DELETE", headers: write});
    expect(res.status).to.equal(204);
    expect((await fetch(`${BASE}/TravelSet('T0700')`)).status).to.equal(404);

    // a view that did not ask for writes, and an analytical one, are refused
    // by the model, before any DPC method is looked for
    res = await fetch(`http://localhost:${PORT}/sap/opu/odata/sap/ZC_STG_FLIGHTCUBE_CDS/ZC_STG_FLIGHTCUBE`,
      {method: "POST", headers: write, body: "{}"});
    expect(res.status).to.equal(405);
    expect((await res.json()).error.message.value).to.contain("is not creatable");

    res = await fetch(`http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_SADL_SRV/Zc_Stg_TravelSet('T0001')`,
      {method: "DELETE", headers: write});
    expect(res.status).to.equal(405);
    expect((await fetch(`${BASE}/TravelSet('T0001')`)).status).to.equal(200);
  });

  it("a composition child goes with its parent: @ObjectModel.association.type [#TO_COMPOSITION_CHILD]", async () => {
    const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZC_STG_TRAVEL_CDS`;
    const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};

    // a travel with two bookings under it. The child view asks for writes of
    // its own, which is what makes this reachable over the wire at all.
    let res = await fetch(S + "/ZC_STG_TRAVEL", {method: "POST", headers: write,
      body: JSON.stringify({TRAVELID: "T0800", DESCRIPTION: "Composition", STATUS: "A", SEATS: 2})});
    expect(res.status).to.equal(201);
    for (const id of ["B1", "B2"]) {
      res = await fetch(S + "/ZC_STG_BOOKING", {method: "POST", headers: write,
        body: JSON.stringify({TRAVELID: "T0800", BOOKINGID: id, CUSTOMER: "C" + id, FLIGHTDATE: "20260918"})});
      expect(res.status).to.equal(201);
    }
    let below = (await (await fetch(S + "/ZC_STG_TRAVEL('T0800')/to_Bookings?$format=json")).json()).d.results;
    expect(below.map((r) => r.BOOKINGID).sort()).to.deep.equal(["B1", "B2"]);

    // deleting the parent takes the parts with it, in one statement each and
    // one LUW - a booking is not a thing a travel points at, it is part of it
    res = await fetch(S + "/ZC_STG_TRAVEL('T0800')", {method: "DELETE", headers: write});
    expect(res.status).to.equal(204);
    expect((await fetch(S + "/ZC_STG_TRAVEL('T0800')")).status).to.equal(404);
    below = (await (await fetch(S + "/ZC_STG_BOOKING?$format=json&$filter=TRAVELID eq 'T0800'")).json()).d.results;
    expect(below).to.deep.equal([]);

    // and the other direction does not cascade: deleting a booking leaves its
    // travel alone, because _Travel is the parent end of the composition
    res = await fetch(S + "/ZC_STG_BOOKING", {method: "POST", headers: write,
      body: JSON.stringify({TRAVELID: "T0002", BOOKINGID: "B9", CUSTOMER: "C9", FLIGHTDATE: "20260918"})});
    expect(res.status).to.equal(201);
    res = await fetch(S + "/ZC_STG_BOOKING(TRAVELID='T0002',BOOKINGID='B9')", {method: "DELETE", headers: write});
    expect(res.status).to.equal(204);
    expect((await fetch(S + "/ZC_STG_TRAVEL('T0002')")).status).to.equal(200);
  });

  it("$count", async () => {
    const res = await fetch(BASE + "/TravelSet/$count");
    expect(res.status).to.equal(200);
    expect(await res.text()).to.equal("4");
  });

  it("404 with an OData error body", async () => {
    const res = await fetch(BASE + "/TravelSet('NOPE')");
    expect(res.status).to.equal(404);
    const body = await res.json();
    expect(body.error.code).to.equal("STG/ENTITY_NOT_FOUND");
  });

  it("$batch with a retrieve part and a changeset", async () => {
    const crlf = "\r\n";
    const body = [
      "--b", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "GET TravelSet?$top=2&$inlinecount=allpages HTTP/1.1", "Accept: application/json", "", "",
      "--b", "Content-Type: multipart/mixed; boundary=cs", "",
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "POST TravelSet HTTP/1.1", "Content-Type: application/json", "", JSON.stringify({TravelId: "T0400", Description: "via batch", Seats: 1}),
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "DELETE TravelSet('T0400') HTTP/1.1", "", "",
      "--cs--", "", "--b--", "",
    ].join(crlf);
    const res = await fetch(BASE + "/$batch", {method: "POST", headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "open-steamgate"}, body});
    expect(res.status).to.equal(202);
    expect(res.headers.get("content-type")).to.match(/^multipart\/mixed; boundary=batchresponse_stg_/);
    const text = await res.text();
    expect(text).to.contain("HTTP/1.1 200 OK");
    expect(text).to.contain('"__count":"2"');
    expect(text).to.contain("HTTP/1.1 201 Created");
    expect(text).to.contain("HTTP/1.1 204 No Content");
    expect((text.match(/--batchresponse_stg_\d+--/g) || []).length).to.equal(1);
  });

  it("a changeset that fails is undone, including the requests that had succeeded", async () => {
    const crlf = "\r\n";
    // two creates and then a POST at an entity rather than at the set, which
    // the dispatcher refuses with 405. The changeset fails as a whole, and the
    // two rows the first two requests had already written have to be gone with
    // it: a changeset is one LUW, not three requests that happen to travel
    // together (backlog B.2).
    const body = [
      "--b", "Content-Type: multipart/mixed; boundary=cs", "",
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "POST TravelSet HTTP/1.1", "Content-Type: application/json", "", JSON.stringify({TravelId: "T0410", Description: "first of the changeset", Seats: 1}),
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "POST TravelSet HTTP/1.1", "Content-Type: application/json", "", JSON.stringify({TravelId: "T0411", Description: "second of the changeset", Seats: 1}),
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "POST TravelSet('T0001') HTTP/1.1", "Content-Type: application/json", "", "{}",
      "--cs--", "", "--b--", "",
    ].join(crlf);
    const res = await fetch(BASE + "/$batch", {method: "POST", headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "open-steamgate"}, body});
    expect(res.status).to.equal(202);
    const text = await res.text();
    expect(text, "the changeset answers with the one error").to.contain("HTTP/1.1 405");
    expect(text, "and not with the parts that had worked").to.not.contain("HTTP/1.1 201 Created");

    for (const id of ["T0410", "T0411"]) {
      expect((await fetch(`${BASE}/TravelSet('${id}')`)).status, id + " was rolled back").to.equal(404);
    }

    // and the fence holds: what was there before the changeset is still there
    expect((await fetch(`${BASE}/TravelSet('T0001')`)).status, "the seeded rows survived").to.equal(200);
  });

  it("a request that dumps leaves nothing behind, not even for the next write", async () => {
    const crlf = "\r\n";
    // An exception nobody declared: Seats is a number and "abc" is not one, so
    // the entry provider raises CX_SY_CONVERSION_NO_NUMBER, which is none of
    // the four gateway families the dispatcher catches. It therefore unwinds
    // past the ROLLBACK WORK of the changeset -- and the row the first request
    // of the changeset had already written stays pending on the connection.
    //
    // That is the half-write. Nothing reads it back, because it is committed
    // by nobody; it becomes permanent one request later, when the *next*
    // modifying request opens with its fencing COMMIT WORK and adopts it.
    // Ending the LUW on a dump is the kernel's job rather than the ABAP's, so
    // it lives in tools/osd-dialog-step.mjs and every host uses it.
    const part = (body) => [
      "--cs", "Content-Type: application/http", "Content-Transfer-Encoding: binary", "",
      "POST TravelSet HTTP/1.1", "Content-Type: application/json", "", JSON.stringify(body),
    ].join(crlf);
    const body = [
      "--b", "Content-Type: multipart/mixed; boundary=cs", "",
      part({TravelId: "T0920", Description: "written before the dump", Seats: 1}),
      part({TravelId: "T0921", Description: "dumps on Seats", Seats: "abc"}),
      "--cs--", "", "--b--", "",
    ].join(crlf);
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    const res = await fetch(BASE + "/$batch", {method: "POST", headers: {"content-type": "multipart/mixed; boundary=b", "x-csrf-token": "open-steamgate"}, body});
    expect(res.status, "the dump is the host's to answer, not the dispatcher's").to.equal(500);

    // the next modifying request: its fence is what used to make the
    // half-write permanent
    const next = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: "T0930", Description: "the request after the dump", Seats: 1})});
    expect(next.status, "and the system still works afterwards").to.equal(201);

    expect((await fetch(`${BASE}/TravelSet('T0920')`)).status, "the row written before the dump is gone").to.equal(404);
    expect((await fetch(`${BASE}/TravelSet('T0921')`)).status, "and the one that dumped never existed").to.equal(404);

    await fetch(`${BASE}/TravelSet('T0930')`, {method: "DELETE", headers});
  });

  it("CSRF token fetch is answered", async () => {
    const res = await fetch(BASE + "/", {headers: {"x-csrf-token": "Fetch"}});
    expect(res.status).to.equal(200);
    expect(res.headers.get("x-csrf-token")).to.equal("open-steamgate");
  });

  it("POST, PUT, DELETE round trip through the DPC", async () => {
    const headers = {"content-type": "application/json", "x-csrf-token": "open-steamgate"};
    let res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: "T0200", Description: "Wire created", Status: "A", Seats: 1})});
    expect(res.status).to.equal(201);
    expect(res.headers.get("location")).to.equal(`http://localhost:${PORT}/sap/opu/odata/sap/ZSTG_DEMO_SRV/TravelSet('T0200')`);
    expect((await res.json()).d.Description).to.equal("Wire created");

    res = await fetch(BASE + "/TravelSet('T0200')", {method: "PUT", headers, body: JSON.stringify({d: {Description: "Wire updated", Status: "X", Seats: 2}})});
    expect(res.status).to.equal(204);

    res = await fetch(BASE + "/TravelSet('T0200')");
    const body = await res.json();
    expect(body.d.Description).to.equal("Wire updated");
    expect(body.d.Seats).to.equal(2);

    res = await fetch(BASE + "/TravelSet('T0200')", {method: "DELETE", headers});
    expect(res.status).to.equal(204);
    res = await fetch(BASE + "/TravelSet('T0200')");
    expect(res.status).to.equal(404);

    res = await fetch(BASE + "/TravelSet", {method: "POST", headers, body: JSON.stringify({TravelId: "T0001"})});
    expect(res.status).to.equal(400);
    expect((await res.json()).error.code).to.equal("STG/BUSINESS");
  });
});
