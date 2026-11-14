import {expect} from "chai";
import {clientControl, refusal} from "../tools/hana-client-control.mjs";

// The client-filter control (tools/hana-client-control.mjs) over a fake
// database: a tenant table ZOSD_CC_T (invented for this fixture) holding rows
// for clients 000, 001 and 066, read through a fake session whose shadow
// object either filters on the logon client (a view) or does not (a
// synonym, or no filter at all). The real thing runs on a bed; no HANA is
// reachable from CI.
describe("the HANA client-filter control", () => {
  const OWN = "ZOSD_CC_OWN";
  const TENANT = "ZOSD_CC_TENANT";
  const ROWS = {"000": 7, "001": 4, "066": 2};
  const total = Object.values(ROWS).reduce((a, b) => a + b, 0);

  const fakeOpen = ({rows = ROWS, filtered = true, isView = true, column = "CLIENT", noColumn = false, sent = []} = {}) => async (client) => ({
    query: async (sql) => {
      sent.push({client, sql});
      if (/FROM SYS\.VIEWS/.test(sql)) return [{n: isView ? 1 : 0}];
      if (/"DD03L"/.test(sql)) {
        expect(sql).to.match(/AS4LOCAL = 'A' AND AS4VERS = '0000' AND KEYFLAG = 'X'/);
        return noColumn
          ? [{tabname: "ZOSD_CC_T", position: "0001", fieldname: "ZOSD_ID", keyflag: "X", datatype: "CHAR"}]
          : [{tabname: "ZOSD_CC_T", position: "0002", fieldname: column, keyflag: "X", datatype: "CLNT"},
            {tabname: "ZOSD_CC_T", position: "0001", fieldname: ".INCLUDE", keyflag: "X", datatype: ""}];
      }
      if (sql.includes(`"${TENANT}"."ZOSD_CC_T" GROUP BY`)) {
        expect(sql).to.include(`"${column}"`);
        return Object.entries(rows).map(([c, n]) => ({c, n}));
      }
      if (sql.includes(`"${TENANT}"."ZOSD_CC_T"`)) return [{n: Object.values(rows).reduce((a, b) => a + b, 0)}];
      if (sql === `SELECT COUNT(*) AS N FROM "ZOSD_CC_T"`) {
        return [{n: filtered ? (rows[client] ?? 0) : Object.values(rows).reduce((a, b) => a + b, 0)}];
      }
      throw new Error(`unexpected statement ${sql}`);
    },
    disconnect: async () => undefined,
  });

  const run = (options, clients = ["000", "001"]) =>
    clientControl({table: "ZOSD_CC_T", clients, own: OWN, tenant: TENANT, open: fakeOpen(options)});

  it("passes when each client's shadow count is the tenant's count for that client", async () => {
    const sent = [];
    const result = await run({sent});
    expect(result.pass).to.equal(true);
    expect(result.clients).to.deep.equal({"000": 7, "001": 4});
    expect(result.tenant).to.deep.equal({column: "CLIENT", perClient: ROWS, total});
    // one session per client, and only SELECTs
    expect(new Set(sent.map((s) => s.client))).to.deep.equal(new Set(["000", "001"]));
    expect(sent.every((s) => /^SELECT /.test(s.sql))).to.equal(true);
  });

  it("fails a shadow object that does not filter", async () => {
    const result = await run({filtered: false});
    expect(result.pass).to.equal(false);
    expect(result.checks.filter((c) => c.ok === false).map((c) => c.text).join("\n")).to.match(/client 000: shadow 13, tenant 7/);
  });

  it("fails a synonym even when the counts happen to agree", async () => {
    const result = await run({isView: false});
    expect(result.pass).to.equal(false);
    expect(result.checks.find((c) => c.ok === false).text).to.match(/not a view/);
  });

  it("does not report a green that proves nothing: a table with one client's rows only fails", async () => {
    const result = await run({rows: {"001": 5}}, ["000", "001"]);
    expect(result.pass).to.equal(false);
    const failed = result.checks.filter((c) => c.ok === false).map((c) => c.text);
    expect(failed.some((t) => /differs from the unfiltered total 5/.test(t))).to.equal(true);
  });

  it("fails equal counts in two clients: a filter on the wrong value would not show", async () => {
    const result = await run({rows: {"000": 3, "001": 3}});
    expect(result.pass).to.equal(false);
    expect(result.checks.find((c) => c.ok === false).text).to.match(/differ from each other/);
  });

  it("fails a table without a client column", async () => {
    const result = await run({noColumn: true});
    expect(result.pass).to.equal(false);
    expect(result.checks[0].text).to.match(/no CLNT key field/);
  });

  it("refuses everything but the shadow-schema mode, before a socket opens", () => {
    const env = {HANA_EXISTING_SCHEMA: "1", HANA_OWN_SCHEMA: "zosd_cc_own", HANA_SCHEMA: TENANT};
    expect(refusal({table: "ZOSD_CC_T", clients: ["000", "001"], env})).to.equal(undefined);
    expect(refusal({table: "ZOSD_CC_T", clients: ["000", "001"], env: {...env, HANA_EXISTING_SCHEMA: undefined}})).to.match(/HANA_EXISTING_SCHEMA=1/);
    expect(refusal({table: "ZOSD_CC_T", clients: ["000", "001"], env: {...env, HANA_OWN_SCHEMA: ""}})).to.match(/HANA_OWN_SCHEMA/);
    expect(refusal({table: "ZOSD_CC_T", clients: ["000", "001"], env: {...env, HANA_OWN_SCHEMA: TENANT.toLowerCase()}})).to.match(/equals/);
    expect(refusal({table: undefined, clients: ["000", "001"], env})).to.match(/--table/);
    expect(refusal({table: "ZOSD_CC_T", clients: ["001"], env})).to.match(/at least two/);
    expect(refusal({table: "ZOSD_CC_T", clients: ["001", "1"], env})).to.match(/not a client/);
    expect(refusal({table: "ZOSD_CC_T", clients: ["001", "001"], env})).to.match(/twice/);
  });
});
