// R7: a seeded field typed by a data element (ROLLNAME, no DATATYPE in the
// table's XML) takes its type from the element, or from the element's
// domain. Before, the flight pack's /dmo/ dates went in as ISO text cut to
// eight characters ('2027-06-') and its CHAR fields unpadded.
import {expect} from "chai";
import {mkdtempSync, mkdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {seedStatements} from "./seed.mjs";

const xml = (body) => `<?xml version="1.0" encoding="utf-8"?>\n<abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${body}</asx:values></asx:abap></abapGit>\n`;
const field = (name, inner) => `<DD03P><FIELDNAME>${name}</FIELDNAME>${inner}</DD03P>`;

describe("seed: field types through data element and domain", () => {
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), "osd-seed-elements-"));
    const ddic = join(dir, "ddic");
    mkdirSync(ddic);
    mkdirSync(join(dir, "data"));
    writeFileSync(join(ddic, "#zns#trip.tabl.xml"), xml(`<DD02V><TABNAME>/ZNS/TRIP</TABNAME><TABCLASS>TRANSP</TABCLASS></DD02V><DD03P_TABLE>${
      field("TRIP_ID", "<KEYFLAG>X</KEYFLAG><ROLLNAME>/ZNS/TRIP_ID</ROLLNAME>")
      + field("TRIP_DATE", "<ROLLNAME>/ZNS/TRIP_DATE</ROLLNAME>")
      + field("NOTE", "<ROLLNAME>/ZNS/NOTE</ROLLNAME>")}</DD03P_TABLE>`));
    // a date element by its domain, a CHAR element by its domain, one with its own type
    writeFileSync(join(ddic, "#zns#trip_date.dtel.xml"), xml("<DD04V><ROLLNAME>/ZNS/TRIP_DATE</ROLLNAME><DOMNAME>/ZNS/DATE</DOMNAME></DD04V>"));
    writeFileSync(join(ddic, "#zns#date.doma.xml"), xml("<DD01V><DOMNAME>/ZNS/DATE</DOMNAME><DATATYPE>DATS</DATATYPE><LENG>000008</LENG></DD01V>"));
    writeFileSync(join(ddic, "#zns#trip_id.dtel.xml"), xml("<DD04V><ROLLNAME>/ZNS/TRIP_ID</ROLLNAME><DOMNAME>/ZNS/ID</DOMNAME></DD04V>"));
    writeFileSync(join(ddic, "#zns#id.doma.xml"), xml("<DD01V><DOMNAME>/ZNS/ID</DOMNAME><DATATYPE>NUMC</DATATYPE><LENG>000006</LENG></DD01V>"));
    writeFileSync(join(ddic, "#zns#note.dtel.xml"), xml("<DD04V><ROLLNAME>/ZNS/NOTE</ROLLNAME><DATATYPE>CHAR</DATATYPE><LENG>000010</LENG></DD04V>"));
    writeFileSync(join(dir, "data", "#zns#trip.tabu.json"), JSON.stringify([{trip_id: "42", trip_date: "2027-06-23", note: "ab"}]));
  });
  after(() => rmSync(dir, {recursive: true, force: true}));

  it("seeds a date typed through element and domain in the internal form, and pads elements' CHAR and NUMC", () => {
    const sql = [seedStatements(join(dir, "data"), join(dir, "ddic"))].flat().join("\n");
    expect(sql).to.include("'20270623'");
    expect(sql).to.not.include("2027-06-");
    expect(sql).to.include("'ab        '");
    expect(sql).to.include(`VALUES ('42    ', '20270623', 'ab        ')`);
  });
});
