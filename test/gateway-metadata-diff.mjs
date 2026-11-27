import {expect} from "chai";
import {spawnSync} from "node:child_process";
import {mkdtempSync, writeFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {compare, model, parseAccept, verdict} from "../tools/odata-metadata-diff.mjs";

// tools/odata-metadata-diff.mjs over two small synthetic $metadata
// documents. Every name below is invented (ZOSD_B3_*). Each case changes
// one thing in a copy of the base document and checks which class the
// difference lands in -- and, because a diff that passes by normalising
// both sides away is the false green this tool exists to prevent, that a
// change the old names-only comparison could not see is a structure
// difference here.
const base = ({
  ns = "ZOSD_B3_SRV",
  typeAttrs = "",
  nameProp = `<Property Name="Name" Type="Edm.String" Nullable="false" MaxLength="40" sap:label="Name" sap:creatable="false"/>`,
  amountProp = `<Property Name="Amount" Type="Edm.Decimal" Precision="15" Scale="2" sap:label="Amount"/>`,
  propsOrder = ["id", "name", "amount"],
  setAttrs = `sap:creatable="false" sap:addressable="true"`,
  multiplicity = "*",
  fiParam = `<Parameter Name="Mode" Type="Edm.String" Mode="In" MaxLength="1"/>`,
  sets = ["Parent", "Child"],
} = {}) => {
  const props = {
    id: `<Property Name="Id" Type="Edm.String" Nullable="false" MaxLength="10" sap:label="Id"/>`,
    name: nameProp,
    amount: amountProp,
  };
  const set = {
    Parent: `<EntitySet Name="ParentSet" EntityType="${ns}.Parent" ${setAttrs}/>`,
    Child: `<EntitySet Name="ChildSet" EntityType="${ns}.Child"/>`,
  };
  return `<?xml version="1.0" encoding="utf-8"?>
<edmx:Edmx Version="1.0" xmlns:edmx="http://schemas.microsoft.com/ado/2007/06/edmx" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns:sap="http://www.sap.com/Protocols/SAPData">
  <edmx:DataServices m:DataServiceVersion="2.0">
    <Schema Namespace="${ns}" xml:lang="en" xmlns="http://schemas.microsoft.com/ado/2008/09/edm">
      <EntityType Name="Parent" ${typeAttrs}>
        <Key><PropertyRef Name="Id"/></Key>
        ${propsOrder.map((p) => props[p]).join("\n        ")}
        <NavigationProperty Name="ToChildren" Relationship="${ns}.ParentChild" FromRole="FromRole_ParentChild" ToRole="ToRole_ParentChild"/>
      </EntityType>
      <EntityType Name="Child">
        <Key><PropertyRef Name="Id"/><PropertyRef Name="Pos"/></Key>
        <Property Name="Id" Type="Edm.String" Nullable="false" MaxLength="10"/>
        <Property Name="Pos" Type="Edm.String" Nullable="false" MaxLength="4"/>
      </EntityType>
      <Association Name="ParentChild">
        <End Type="${ns}.Parent" Multiplicity="1" Role="FromRole_ParentChild"/>
        <End Type="${ns}.Child" Multiplicity="${multiplicity}" Role="ToRole_ParentChild"/>
        <ReferentialConstraint>
          <Principal Role="FromRole_ParentChild"><PropertyRef Name="Id"/></Principal>
          <Dependent Role="ToRole_ParentChild"><PropertyRef Name="Id"/></Dependent>
        </ReferentialConstraint>
      </Association>
      <EntityContainer Name="${ns}_Entities" m:IsDefaultEntityContainer="true">
        ${sets.map((s) => set[s]).join("\n        ")}
        <AssociationSet Name="ParentChildSet" Association="${ns}.ParentChild">
          <End EntitySet="ParentSet" Role="FromRole_ParentChild"/>
          <End EntitySet="ChildSet" Role="ToRole_ParentChild"/>
        </AssociationSet>
        <FunctionImport Name="Recalc" ReturnType="${ns}.Parent" EntitySet="ParentSet" m:HttpMethod="POST">
          ${fiParam}
        </FunctionImport>
      </EntityContainer>
      <atom:link rel="self" href="http://localhost/sap/opu/odata/sap/${ns}/$metadata" xmlns:atom="http://www.w3.org/2005/Atom"/>
    </Schema>
  </edmx:DataServices>
</edmx:Edmx>`;
};

const classes = (r) => r.differences.map((d) => d.class);

describe("odata-metadata-diff: two $metadata documents, parsed and classed", () => {
  it("finds nothing in a document compared with itself", () => {
    const r = compare(base(), base());
    expect(r.differences).to.deep.equal([]);
    expect(verdict(r).ok).to.equal(true);
  });

  it("ignores attribute order and whitespace, which are not content", () => {
    const a = base();
    const b = base().replace(`Type="Edm.String" Nullable="false" MaxLength="40"`, `MaxLength="40"   Nullable="false" Type="Edm.String"`);
    expect(compare(a, b).differences).to.deep.equal([]);
  });

  it("reads the model, not the names: same names, other type is structure", () => {
    const r = compare(base(), base({nameProp: `<Property Name="Name" Type="Edm.Int32" Nullable="false" MaxLength="40" sap:label="Name" sap:creatable="false"/>`}));
    expect(classes(r)).to.deep.equal(["structure"]);
    expect(r.differences[0].where).to.equal("Type Parent Property Name");
    expect(r.differences[0].text).to.equal(`Type: ours "Edm.String", theirs "Edm.Int32"`);
  });

  it("puts nullable, maxlength, precision and scale into structure", () => {
    const r = compare(base(), base({
      nameProp: `<Property Name="Name" Type="Edm.String" Nullable="true" MaxLength="60" sap:label="Name" sap:creatable="false"/>`,
      amountProp: `<Property Name="Amount" Type="Edm.Decimal" Precision="16" Scale="3" sap:label="Amount"/>`,
    }));
    expect(classes(r)).to.deep.equal(["structure", "structure", "structure", "structure"]);
    expect(r.differences.map((d) => d.text.split(":")[0]).sort()).to.deep.equal(["MaxLength", "Nullable", "Precision", "Scale"]);
  });

  it("reads an absent Nullable as \"true\" (the CSDL default), says so, and still sees false", () => {
    // a system writes Nullable only when it is false; our writer writes
    // Nullable="true" -- the same model, and the count says it was read so
    const absent = `<Property Name="Amount" Type="Edm.Decimal" Precision="15" Scale="2" sap:label="Amount"/>`;
    const writtenTrue = `<Property Name="Amount" Type="Edm.Decimal" Nullable="true" Precision="15" Scale="2" sap:label="Amount"/>`;
    const same = compare(base({amountProp: writtenTrue}), base({amountProp: absent}));
    expect(same.differences).to.deep.equal([]);
    expect(same.normalised.nullableDefaults.theirs).to.be.greaterThan(0);
    const writtenFalse = `<Property Name="Amount" Type="Edm.Decimal" Nullable="false" Precision="15" Scale="2" sap:label="Amount"/>`;
    const other = compare(base({amountProp: writtenFalse}), base({amountProp: absent}));
    expect(other.differences.map((d) => d.text.split(":")[0])).to.deep.equal(["Nullable"]);
  });

  it("reads an absent sap:creatable/sortable/... as \"true\" (SAP's default), and still sees false", () => {
    const same = compare(base({setAttrs: `sap:creatable="true" sap:addressable="true"`}), base({setAttrs: `sap:addressable="true"`}));
    expect(same.differences).to.deep.equal([]);
    expect(same.normalised.sapDefaults.theirs).to.be.greaterThan(same.normalised.sapDefaults.ours);
    const other = compare(base(), base({setAttrs: `sap:addressable="true"`}));
    expect(other.differences.map((d) => d.text.split(":").slice(0, 2).join(":"))).to.deep.equal(["sap:creatable"]);
  });

  it("puts keys, multiplicity, navigation, sets and function import parameters into structure", () => {
    const r = compare(base(), base({multiplicity: "0..1"}));
    expect(r.differences).to.have.length(1);
    expect(r.differences[0]).to.include({class: "structure", where: "Association ParentChild End ToRole_ParentChild"});
    const p = compare(base(), base({fiParam: `<Parameter Name="Mode" Type="Edm.String" Mode="In" MaxLength="2"/>`}));
    expect(p.differences[0]).to.include({class: "structure", where: "EntityContainer ZOSD_B3_SRV_Entities FunctionImport Recalc Parameter Mode"});
    const s = compare(base(), base({sets: ["Parent"]}));
    expect(s.differences.map((d) => d.text)).to.include("EntitySet ChildSet: only ours");
    expect(classes(s)).to.deep.equal(["structure"]);
    const keyless = base().replace(`<Key><PropertyRef Name="Id"/><PropertyRef Name="Pos"/></Key>`, `<Key><PropertyRef Name="Id"/></Key>`);
    const k = compare(base(), keyless);
    expect(k.differences[0]).to.include({class: "structure", where: "Type Child"});
    expect(k.differences[0].text).to.match(/^Key: /);
    const nav = base().replace(`ToRole="ToRole_ParentChild"/>`, `ToRole="ToRole_Other"/>`);
    expect(compare(base(), nav).differences[0]).to.include({class: "structure", where: "Type Parent NavigationProperty ToChildren"});
  });

  it("puts sap:* attributes into annotations: label, creatable, addressable", () => {
    const r = compare(base(), base({
      nameProp: `<Property Name="Name" Type="Edm.String" Nullable="false" MaxLength="40" sap:label="Full name" sap:creatable="false"/>`,
      setAttrs: `sap:creatable="false"`,
    }));
    expect(classes(r)).to.deep.equal(["annotations", "annotations"]);
    expect(r.differences.map((d) => d.text)).to.include(`sap:addressable: ours "true", theirs (absent)`);
    expect(verdict(r, ["annotations"]).ok).to.equal(true);
    expect(verdict(r, []).ok).to.equal(false);
  });

  it("puts the same members in another order into order", () => {
    const r = compare(base(), base({propsOrder: ["id", "amount", "name"], sets: ["Child", "Parent"]}));
    expect(classes(r)).to.deep.equal(["order", "order"]);
    expect(verdict(r, ["annotations", "order"]).ok).to.equal(true);
    expect(verdict(r, ["annotations"])).to.deep.equal({ok: false, refused: ["order"]});
  });

  it("reports a differing schema namespace once, not on every reference", () => {
    const r = compare(base(), base({ns: "ZOSD_B3_OTHER"}));
    // the namespace, plus the container whose name carries it -- and the
    // sets inside that container are still compared, not skipped
    expect(r.differences.map((d) => d.where)).to.deep.equal(["Schema", "EntityContainer"]);
    const both = compare(base(), base({ns: "ZOSD_B3_OTHER", sets: ["Parent"]}));
    expect(both.differences.map((d) => d.text)).to.include("EntitySet ChildSet: only ours");
    expect(verdict(r, ["annotations", "order"]).ok).to.equal(false);
  });

  it("compares the document versions a client branches on, as structure", () => {
    const dsv = compare(base(), base().replace(`m:DataServiceVersion="2.0"`, `m:DataServiceVersion="3.0"`));
    expect(dsv.differences).to.deep.equal([{class: "structure", where: "DataServices", text: `DataServiceVersion: ours "2.0", theirs "3.0"`}]);
    const edmx = compare(base(), base().replace(`<edmx:Edmx Version="1.0"`, `<edmx:Edmx Version="4.0"`));
    expect(edmx.differences).to.deep.equal([{class: "structure", where: "Edmx", text: `Version: ours "1.0", theirs "4.0"`}]);
    expect(verdict(dsv, ["annotations", "order"]).ok).to.equal(false);
  });

  it("puts a function import's HTTP method and an absent Nullable into structure", () => {
    const method = compare(base(), base().replace(`m:HttpMethod="POST"`, `m:HttpMethod="GET"`));
    expect(classes(method)).to.deep.equal(["structure"]);
    expect(method.differences[0].text).to.equal(`m:HttpMethod: ours "POST", theirs "GET"`);
    const nullable = compare(base(), base({nameProp: `<Property Name="Name" Type="Edm.String" MaxLength="40" sap:label="Name" sap:creatable="false"/>`}));
    // absent is CSDL's default, "true": false against it is still a difference
    expect(nullable.differences).to.deep.equal([{class: "structure", where: "Type Parent Property Name", text: `Nullable: ours "false", theirs "true"`}]);
  });

  it("refuses what is not EDMX, and an unknown class to accept", () => {
    expect(() => model("<a><b></a>")).to.throw(/not well-formed/);
    expect(() => model("<root/>")).to.throw(/DataServices/);
    expect(() => parseAccept("annotations,typo")).to.throw(/unknown class typo/);
  });

  it("exits 0 only when every differing class is accepted, and prints every difference", () => {
    const dir = mkdtempSync(join(tmpdir(), "odata-metadata-diff-"));
    try {
      const a = join(dir, "a.xml");
      const b = join(dir, "b.xml");
      writeFileSync(a, base());
      writeFileSync(b, base({setAttrs: `sap:creatable="true" sap:addressable="true"`, propsOrder: ["name", "id", "amount"]}));
      const tool = fileURLToPath(new URL("../tools/odata-metadata-diff.mjs", import.meta.url));
      const run = (...args) => spawnSync(process.execPath, [tool, a, b, ...args], {encoding: "utf8"});
      const strict = run();
      expect(strict.status).to.equal(1);
      expect(strict.stdout).to.contain("annotations: 1");
      expect(strict.stdout).to.contain("order: 1");
      const partly = run("--accept", "annotations");
      expect(partly.status).to.equal(1);
      expect(partly.stdout).to.contain("differs in order");
      const both = run("--accept", "annotations,order");
      expect(both.status).to.equal(0);
      // accepted is counted, never hidden
      expect(both.stdout).to.contain("annotations (accepted): 1");
      expect(both.stdout).to.contain("sap:creatable");
      expect(run("--accept", "nope").status).to.equal(2);
    } finally {
      rmSync(dir, {recursive: true, force: true});
    }
  });
});
