import {expect} from "chai";
import * as abaplint from "@abaplint/core";
import {annotationValue, cdsMetadataOf, declaredAssociations, enumOf, labelOf, pairsOf, redirectsOf} from "../tools/cds-metadata.mjs";

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
    const own = declaredAssociations(metaOf(reg, "/NS/I_ROOT"), 3);
    expect(own.map((a) => a.alias)).to.deep.equal(["_Item", "_Other", "ZI_THIRD"]);
    expect(own[0]).to.deep.include({target: "/NS/I_ITEM", min: "0", max: "*", pairs: [], exposed: true, composition: "CHILD"});
    expect(own[1]).to.deep.include({target: "ZI_OTHER", min: "1", max: "1", exposed: true, composition: undefined});
    expect(own[1].pairs).to.deep.equal([{source: "ID", target: "ID"}, {source: "KIND", target: "KIND"}]);
    // [n] is [0..n]; an association without an alias is named by its target
    expect(own[2]).to.deep.include({target: "ZI_THIRD", min: "0", max: "1", exposed: false});
  });

  it("makes a to-parent [1..1] and names it PARENT", () => {
    const [up] = declaredAssociations(metaOf(reg, "/NS/I_ITEM"), 1);
    expect(up).to.deep.include({alias: "_Root", target: "/NS/I_ROOT", min: "1", max: "1", composition: "PARENT"});
    expect(up.pairs).to.deep.equal([{source: "ID", target: "ID"}]);
  });

  it("gives a projection's redirected target as one name (ANORMALIES cds-metadata-redirect-namespace)", () => {
    const meta = metaOf(reg, "/NS/C_ROOT");
    expect(meta.definitionType).to.equal("PROJECTION_VIEW");
    // the transpiler's own text has the blanks of the tokens; ours has none
    expect(meta.associations.find((a) => a.name === "_Item").target.replace(/\s+/g, "")).to.equal("/NS/C_ITEM");
    expect(redirectsOf(meta).get("_Item")).to.equal("/NS/C_ITEM");
  });

  it("reads no pair out of a condition of another shape", () => {
    expect(pairsOf("_X.a = 'A'")).to.deep.equal([]);
    expect(pairsOf(undefined)).to.deep.equal([]);
  });
});
