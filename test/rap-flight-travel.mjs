// R7: the managed travel BO of SAP's flight reference scenario
// (packs/rap-flight, /DMO/I_TRAVEL_M with its two projections) served
// without draft (V2 data requests and V4; V2 $metadata of a
// namespaced service is ANORMALIES "RAP R7: a namespaced service's V2
// $metadata"): its BDEF and projection BDEFs as fetched, its
// three behavior pools from the pack's overlay (docs/rap-flight-pack.md),
// its saver's additional save of the travel and unmanaged save of the
// booking supplements (docs/rap-runtime.md, "R7"). Needs a transpiled tree
// with the pack fetched; skips without it.
import assert from "node:assert/strict";
import {existsSync} from "node:fs";
import {startServer} from "./start.mjs";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const P = "%2FDMO%2FUI_TRAVEL_PROCESSOR_M", A = "%2FDMO%2FUI_TRAVEL_APPROVER_M";
const v2 = `${origin}/sap/opu/odata/sap/${P}`, v2a = `${origin}/sap/opu/odata/sap/${A}`;
const v4 = `${origin}/sap/opu/odata4/sap/${P}`, v4a = `${origin}/sap/opu/odata4/sap/${A}`;
const write = {"content-type": "application/json", "x-csrf-token": "open-steamgate", accept: "application/json"};
const json = {accept: "application/json"};
// a day from today, as V2 writes a date
const day = n => { const x = new Date(Date.now() + n * 864e5); return `/Date(${Date.UTC(x.getUTCFullYear(), x.getUTCMonth(), x.getUTCDate())})/`; };
// the read-only view service of the same pack, over the seeded tables
const ro = `${origin}/sap/opu/odata/sap/ZOSD_RAPFLIGHT_SRV`;
// a flight the scenario's generator seeds, picked from the seed itself at run
// time: the generator windows its flights around the day the build runs (its
// latest is a Monday "8 months in the future", a rolling date), so a flight
// date written down here falls out of the seed -- on 2026-11-16 the fixed
// 2027-06-23 did and this suite went red with no code change
let flight;

async function call(url, options) {
  const res = await fetch(url, options);
  const text = await res.text();
  let body;
  try { body = text ? JSON.parse(text) : undefined; } catch { body = text; }
  return {status: res.status, body, headers: res.headers};
}

describe("RAP R7: the flight travel BO served (V2 data requests and V4)", function () {
  this.timeout(300000);
  let server;
  before(async function () {
    if (!existsSync("packs/rap-flight/upstream")) this.skip();
    server = startServer(true);
    for (let i = 0; i < 1200; i++) {
      try {
        if ((await fetch(`${v2}/Travel?$top=1&$format=json`, {headers: json})).status === 200) break;
      } catch { /* not listening yet */ }
      await new Promise(r => setTimeout(r, 200));
    }
    flight = await pickFlight();
  });
  after(() => server?.close());

  const get = url => call(url, {headers: json});
  // the SQ 0001 flight of the day the seed was made, in the shape a booking
  // write takes; the seed's window rolls with the build day, so the test
  // reads the date from the seed instead of writing one down
  const pickFlight = async () => {
    const res = await get(`${ro}/FlightSet?$filter=Airlineid eq 'SQ' and Connectionid eq '0001'&$top=1&$format=json`);
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const row = res.body.d.results[0];
    assert.ok(row, "the seed holds an SQ 0001 flight");
    return {CarrierID: row.Airlineid, ConnectionID: row.Connectionid, FlightDate: row.Flightdate};
  };
  const tag = async url => (await get(url)).headers.get("etag");
  const travel = async (extra = {}) => {
    const res = await call(`${v2}/Travel`, {method: "POST", headers: write, body: JSON.stringify({
      AgencyID: "070015", CustomerID: "000078", BeginDate: day(10), EndDate: day(20),
      BookingFee: "20.00", CurrencyCode: "EUR", OverallStatus: "O", Description: "R7", ...extra})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    return res.body.d;
  };
  const booking = (id, extra = {}) => call(`${v2}/Travel('${id}')/to_Booking`, {method: "POST", headers: write, body: JSON.stringify({
    BookingDate: day(0), CustomerID: "000078", ...flight, FlightPrice: "100.00", CurrencyCode: "EUR", BookingStatus: "N", ...extra})});
  const supplement = (id, bid, price) => call(`${v2}/Booking(TravelID='${id}',BookingID='${bid}')/to_BookSupplement`, {method: "POST", headers: write,
    body: JSON.stringify({SupplementID: "ML-0001", Price: price, CurrencyCode: "EUR"})});
  const supplements = async id => (await get(`${v2}/BookingSupplement?$filter=TravelID eq '${id}'&$format=json`)).body.d.results;

  it("creates a travel, a booking and a supplement; the supplement reaches its table only through the saver", async () => {
    const t = await travel();
    assert.equal(t.OverallStatus, "O");
    assert.equal(t.TotalPrice, "20.00", "the determination's internal action: the booking fee alone");
    let res = await booking(t.TravelID);
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.d.BookingID, "0010", "the travel pool's cba numbering");
    res = await supplement(t.TravelID, "0010", "17.00");
    assert.equal(res.status, 201, JSON.stringify(res.body));
    assert.equal(res.body.d.BookingSupplementID, "01", "the booking pool's cba numbering");
    const rows = await supplements(t.TravelID);
    assert.deepEqual(rows.map(r => [r.BookingID, r.BookingSupplementID, r.Price]), [["0010", "01", "17.00"]]);
    // booking 100.00 EUR + supplement 17.00 EUR + fee 20.00
    assert.equal((await get(`${v2}/Travel('${t.TravelID}')?$format=json`)).body.d.TotalPrice, "137.00");
  });

  it("refuses what the pools' validations refuse, with the scenario's messages", async () => {
    let res = await call(`${v2}/Travel`, {method: "POST", headers: write, body: JSON.stringify({
      AgencyID: "070015", CustomerID: "999999", BeginDate: day(10), EndDate: day(20), BookingFee: "1.00", CurrencyCode: "EUR", OverallStatus: "O"})});
    assert.equal(res.status, 400);
    assert.match(JSON.stringify(res.body), /Customer 999999 unknown|999999/);
    const t = await travel();
    res = await booking(t.TravelID, {ConnectionID: "9999"});
    assert.equal(res.status, 400, "the booking pool's validation");
    assert.match(JSON.stringify(res.body), /No Flight/i);
  });

  it("updates a supplement through the unmanaged save, and the travel's total follows", async () => {
    const t = await travel();
    await booking(t.TravelID);
    await supplement(t.TravelID, "0010", "17.00");
    const url = `${v2}/BookingSupplement(TravelID='${t.TravelID}',BookingID='0010',BookingSupplementID='01')`;
    const res = await call(url, {method: "PATCH", headers: {...write, "if-match": await tag(`${url}?$format=json`)}, body: JSON.stringify({Price: "25.00"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await get(`${url}?$format=json`)).body.d.Price, "25.00");
    assert.equal((await get(`${v2}/Travel('${t.TravelID}')?$format=json`)).body.d.TotalPrice, "145.00");
  });

  it("copies a travel with its bookings and supplements (factory action), and deletes one with all of them", async () => {
    const t = await travel();
    await booking(t.TravelID);
    await supplement(t.TravelID, "0010", "5.00");
    const url = `${v2}/Travel('${t.TravelID}')`;
    let res = await call(`${v2}/copyTravel?TravelID='${t.TravelID}'`, {method: "POST", headers: {...write, "if-match": await tag(`${url}?$format=json`)}});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    const copy = res.body.d.TravelID;
    assert.notEqual(copy, t.TravelID);
    assert.equal((await get(`${v2}/Travel('${copy}')/to_Booking?$format=json`)).body.d.results.length, 1);
    assert.equal((await supplements(copy)).length, 1, "the copy's supplement went through the saver");
    res = await call(url, {method: "DELETE", headers: {...write, "if-match": await tag(`${url}?$format=json`)}});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    assert.equal((await get(`${url}?$format=json`)).status, 404);
    assert.equal((await supplements(t.TravelID)).length, 0, "the cascade reached the unmanaged save");
    assert.equal((await supplements(copy)).length, 1, "the copy keeps its own");
  });

  it("accepts a travel through the approver projection (V2) and rejects one (V4)", async () => {
    const t = await travel();
    const url = `${v2a}/Travel('${t.TravelID}')`;
    let res = await call(`${v2a}/acceptTravel?TravelID='${t.TravelID}'`, {method: "POST", headers: {...write, "if-match": await tag(`${url}?$format=json`)}});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.d.OverallStatus, "A");
    const u = await travel();
    const etag = (await call(`${v4a}/Travel('${u.TravelID}')`)).body["@odata.etag"];
    res = await call(`${v4a}/Travel('${u.TravelID}')/%2FDMO%2FUI_TRAVEL_APPROVER_M.rejectTravel`, {method: "POST", headers: {...write, "if-match": etag}, body: "{}"});
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.OverallStatus, "X");
  });

  it("creates, updates and reads over V4", async () => {
    let res = await call(`${v4}/Travel`, {method: "POST", headers: write, body: JSON.stringify({
      AgencyID: "070015", CustomerID: "000078", BeginDate: new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10),
      EndDate: new Date(Date.now() + 20 * 864e5).toISOString().slice(0, 10), BookingFee: 3, CurrencyCode: "EUR", OverallStatus: "O", Description: "V4"})});
    assert.equal(res.status, 201, JSON.stringify(res.body));
    const id = res.body.TravelID;
    const etag = (await call(`${v4}/Travel('${id}')`)).body["@odata.etag"];
    res = await call(`${v4}/Travel('${id}')`, {method: "PATCH", headers: {...write, "if-match": etag}, body: JSON.stringify({Description: "V4 changed"})});
    assert.equal(res.status, 204, JSON.stringify(res.body));
    res = await call(`${v4}/Travel('${id}')`);
    assert.equal(res.body.Description, "V4 changed");
    assert.equal(res.body.TotalPrice, 3);
  });
});
