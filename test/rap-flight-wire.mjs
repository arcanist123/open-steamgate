import {expect} from "chai";
import {existsSync} from "node:fs";
import {startServer} from "./start.mjs";

// packs/rap-flight over the wire: the read-only service the pack's overlay
// compiles from zosd_rapflight.stg.yaml (SADL over the CDS interface views
// of SAP's flight reference scenario). The pack is fetched, so this suite
// runs only where the fetch happened (the build refuses the pack otherwise,
// and a tree without the pack has no ZOSD_RAPFLIGHT_SRV to ask).
const PORT = process.env.STG_PORT ?? 3030;
const S = `http://localhost:${PORT}/sap/opu/odata/sap/ZOSD_RAPFLIGHT_SRV`;

describe("packs/rap-flight: the scenario's views over SADL", function () {
  if (!existsSync("packs/rap-flight/upstream")) {
    it.skip("the pack is not fetched here (node tools/osd-fetch.mjs rap-flight)", () => {});
    return;
  }
  let server;
  before(() => {
    server = startServer(true);
  });
  after(() => server.close());

  it("$metadata names the managed root and its children, read-only", async () => {
    const res = await fetch(S + "/$metadata");
    expect(res.status).to.equal(200);
    const xml = await res.text();
    for (const type of ["Travel", "Booking", "BookingSupplement", "Carrier", "Customer", "Agency", "Connection", "Flight", "Airport"]) {
      expect(xml, type).to.contain(`<EntityType Name="${type}"`);
    }
    expect(xml).to.match(/EntitySet Name="TravelSet"[^>]*sap:creatable="false"/);
    expect(xml).to.match(/Name="TravelId"[^>]*Type="Edm.String"[^>]*MaxLength="8"/);
    expect(xml).to.match(/Name="TotalPrice"[^>]*Type="Edm.Decimal"/);
  });

  it("the entity sets answer, and the seeded rows are there: a fetched pack's build made them", async () => {
    // unconditional on purpose: the pack being fetched means the build (the
    // server's own start included) made its rows, and a conditional check
    // here is what let a start without them pass for a green one
    for (const [set, key] of [["TravelSet", "TravelId"], ["CarrierSet", "Airlineid"], ["CustomerSet", "Customerid"], ["AirportSet", "Airportid"]]) {
      const res = await fetch(`${S}/${set}?$top=3&$inlinecount=allpages&$format=json`);
      expect(res.status, set).to.equal(200);
      const d = (await res.json()).d;
      expect(d.results, set).to.be.an("array");
      expect(Number(d.__count), `${set} has rows`).to.be.greaterThan(0);
      expect(d.results[0], `${set} key`).to.have.property(key);
    }
  });

  it("$filter and $orderby go through to the view", async () => {
    const res = await fetch(`${S}/TravelSet?$filter=OverallStatus eq 'A'&$orderby=TravelId desc&$top=5&$format=json`);
    expect(res.status).to.equal(200);
    const rows = (await res.json()).d.results;
    for (const r of rows) expect(r.OverallStatus).to.equal("A");
    const ids = rows.map((r) => r.TravelId);
    expect(ids).to.deep.equal([...ids].sort().reverse());
  });
});
