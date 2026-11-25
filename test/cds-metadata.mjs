import {expect} from "chai";
import * as abaplint from "@abaplint/core";
import {readFileSync} from "node:fs";
import {annotationValue, cdsMetadataOf, checkedDefinition, declaredAssociations, enumOf, labelOf, pairsOf, redirectsOf} from "../tools/cds-metadata.mjs";
import {parseDDLS} from "../tools/cds2ddic.mjs";

// tools/cds-metadata.mjs: cds2ddic's reading of the transpiler's CDS
// metadata (abaplint/transpiler#2264), over a registry it parsed itself.
function registry(sources) {
  const reg = new abaplint.Registry();
  for (const [name, text] of Object.entries(sources)) {
    reg.addFile(new abaplint.MemoryFile(`${name.toLowerCase().replaceAll("/", "#")}.ddls.asddls`, text));
  }
  reg.parse();
  return reg;
}
const metaOf = (reg, name) => cdsMetadataOf(reg.getObject("DDLS", name), reg);

const ROOT = `@EndUserText.label: 'The root'
@ObjectModel: { writeEnabled: true }
@OData.publish: true
define root view /NS/I_ROOT as select from zroot
  composition [0..*] of /NS/I_ITEM as _Item
  association [1..1] to ZI_OTHER as _Other on $projection.id = _Other.id and _Other.kind = $projection.kind
  association [1] to ZI_THIRD on $projection.id = ZI_THIRD.id
{
      @EndUserText.label: 'Key'
  key id,
      kind,
      @ObjectModel.association.type: [#TO_COMPOSITION_CHILD]
      _Item,
      _Other
}`;
const ITEM = `define view /NS/I_ITEM as select from zitem
  association to parent /NS/I_ROOT as _Root on $projection.id = _Root.id
{ key id, key pos, _Root }`;
const PROJ = `define root view entity /NS/C_ROOT as projection on /NS/I_ROOT
{ key id, _Item : redirected to composition child /NS/C_ITEM }`;

describe("cds-metadata: the transpiler's CDS metadata, read for cds2ddic", () => {
  const reg = registry({"/NS/I_ROOT": ROOT, "/NS/I_ITEM": ITEM, "/NS/C_ROOT": PROJ});

  it("reads an annotation flat or as a record, case-insensitively", () => {
    const meta = metaOf(reg, "/NS/I_ROOT");
    expect(labelOf(meta.annotations)).to.equal("The root");
    expect(annotationValue(meta.annotations, "objectmodel.writeEnabled")).to.equal(true);
    expect(annotationValue(meta.annotations, "OData.publish")).to.equal(true);
    expect(annotationValue(meta.annotations, "ObjectModel.createEnabled")).to.equal(undefined);
    expect(enumOf([{"#": "TO_COMPOSITION_CHILD"}])).to.equal("TO_COMPOSITION_CHILD");
  });

  it("gives the declared associations in cds2ddic's order and record: compositions first", () => {
    const own = declaredAssociations(metaOf(reg, "/NS/I_ROOT"), 3, ["_Item", "_Other"]);
    expect(own.map((a) => a.alias)).to.deep.equal(["_Item", "_Other", "ZI_THIRD"]);
    expect(own[0]).to.deep.include({target: "/NS/I_ITEM", min: "0", max: "*", pairs: [], exposed: true, composition: "CHILD"});
    expect(own[1]).to.deep.include({target: "ZI_OTHER", min: "1", max: "1", exposed: true, composition: undefined});
    expect(own[1].pairs).to.deep.equal([{source: "ID", target: "ID"}, {source: "KIND", target: "KIND"}]);
    // [n] is [0..n]; an association without an alias is named by its target
    expect(own[2]).to.deep.include({target: "ZI_THIRD", min: "0", max: "1", exposed: false});
  });

  it("makes a to-parent [1..1] and names it PARENT", () => {
    const [up] = declaredAssociations(metaOf(reg, "/NS/I_ITEM"), 1, ["_Root"]);
    expect(up).to.deep.include({alias: "_Root", target: "/NS/I_ROOT", min: "1", max: "1", composition: "PARENT"});
    expect(up.pairs).to.deep.equal([{source: "ID", target: "ID"}]);
  });

  it("gives a projection's redirected target as one name (ANORMALIES cds-metadata-redirect-namespace)", () => {
    const meta = metaOf(reg, "/NS/C_ROOT");
    expect(meta.definitionType).to.equal("PROJECTION_VIEW");
    // the transpiler's own text has the blanks of the tokens; ours has none
    expect(meta.associations.find((a) => a.name === "_Item").target.replace(/\s+/g, "")).to.equal("/NS/C_ITEM");
    expect(redirectsOf(meta).get("_ITEM")).to.equal("/NS/C_ITEM");
  });

  it("canary: the transpiler still writes a namespaced redirected target with blanks", () => {
    // when this fails, abaplint/transpiler fixed redirection(): drop nameOf's
    // workaround and close ANORMALIES ANOMALY-2026-11-25-cds-metadata-redirect-namespace
    const raw = metaOf(reg, "/NS/C_ROOT").associations.find((a) => a.name === "_Item").target;
    expect(raw, "ANOMALY-2026-11-25-cds-metadata-redirect-namespace is still open").to.match(/\s/);
  });

  it("refuses a definition type it does not know, naming both causes", () => {
    expect(checkedDefinition("ZX", {definitionType: "VIEW"}).definitionType).to.equal("VIEW");
    expect(() => checkedDefinition("ZX", {definitionType: "CDSDefineView"}))
      .to.throw(/ZX: the transpiler reads it as CDSDefineView: either .*another @abaplint\/core.* or it knows a definition type/);
  });

  it("reads no pair out of a condition of another shape", () => {
    expect(pairsOf("_X.a = 'A'")).to.deep.equal([]);
    expect(pairsOf(undefined)).to.deep.equal([]);
  });
});

// two answers for "exposed" (#2264's flag, cds2ddic's leading underscore):
// one rule decides, the underscore, compared case-insensitively, and a
// difference is said
describe("cds-metadata: exposure and declared associations in parseDDLS", () => {
  const DDLS_XML = (name) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DDLS"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DDLS>
<DDLNAME>${name}</DDLNAME><DDLANGUAGE>E</DDLANGUAGE><DDTEXT>t</DDTEXT></DDLS></asx:values></asx:abap></abapGit>`;
  function parse(name, text) {
    const reg = new abaplint.Registry();
    for (const t of ["zstg_demo", "zstg_demo_bk"]) {
      reg.addFile(new abaplint.MemoryFile(`${t}.tabl.xml`, readFileSync(`src/ddic/${t}.tabl.xml`, "utf8")));
    }
    reg.addFile(new abaplint.MemoryFile(`${name.toLowerCase()}.ddls.asddls`, text));
    reg.addFile(new abaplint.MemoryFile(`${name.toLowerCase()}.ddls.xml`, DDLS_XML(name)));
    reg.parse();
    const said = [];
    const log = console.log;
    console.log = (line) => said.push(String(line));
    try {
      return {view: parseDDLS(reg.getObject("DDLS", name), reg), said};
    } finally {
      console.log = log;
    }
  }

  it("exposes `_bk` for a declared `_Bk`, without a word", () => {
    const {view, said} = parse("ZC_EXPA", `@AbapCatalog.sqlViewName: 'ZVEXPA'
define view ZC_EXPA as select from zstg_demo
  association [0..*] to zstg_demo_bk as _Bk on $projection.TravelId = _Bk.travel_id
{ key travel_id as TravelId, _bk }`);
    expect(view.associations.map((a) => [a.alias, a.exposed])).to.deep.equal([["_Bk", true]]);
    expect(said).to.deep.equal([]);
  });

  it("keeps an exposure without an underscore unexposed, as before, and says the metadata disagrees", () => {
    const {view, said} = parse("ZC_EXPB", `@AbapCatalog.sqlViewName: 'ZVEXPB'
define view ZC_EXPB as select from zstg_demo
  association [0..*] to ZSTG_DEMO_BK on $projection.TravelId = ZSTG_DEMO_BK.travel_id
{ key travel_id as TravelId, ZSTG_DEMO_BK }`);
    expect(view.associations.map((a) => [a.alias, a.exposed])).to.deep.equal([["ZSTG_DEMO_BK", false]]);
    expect(said.join("\n")).to.match(/ZC_EXPB: ZSTG_DEMO_BK is exposed in the CDS metadata and not by its leading underscore/);
  });

  it("refuses an association declared in a union branch after the first", () => {
    const {view} = parse("ZC_UNI", `@AbapCatalog.sqlViewName: 'ZVUNI'
define view ZC_UNI as select from zstg_demo
{ key travel_id as TravelId }
union select from zstg_demo_bk
  association [0..*] to zstg_demo as _Head on $projection.TravelId = _Head.travel_id
{ key travel_id as TravelId }`);
    expect(view.skip).to.match(/union branch after the first/);
  });
});
