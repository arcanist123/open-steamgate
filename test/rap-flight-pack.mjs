import {expect} from "chai";
import {existsSync, readFileSync} from "node:fs";
import {join} from "node:path";
import {packsOf, markerOf, sourceMatches} from "../tools/osd-packs.mjs";
import {fileOf, wordOf, classNameOf} from "../tools/cds-names.mjs";

// packs/rap-flight: SAP's RAP flight reference scenario, fetched from its
// public repository at a pinned commit (docs/rap-flight-pack.md). What this
// checks is the manifest, not the scenario: the pin is a commit and not a
// branch, every exclude pattern says why it is there, and the overlay only
// holds what the document lists. The build's own refusal of an unfetched
// pack (UNFETCHED) is tested in test/osd-fetch.mjs for every pack alike.
const ROOT = process.cwd();
const DIR = join(ROOT, "packs", "rap-flight");
const manifest = JSON.parse(readFileSync(join(DIR, "osd-pack.json"), "utf8"));

describe("packs/rap-flight: the manifest", () => {
  it("is a pack the loader accepts, with one fetched source over the repository's src/", () => {
    const pack = packsOf(ROOT, {}).find((p) => p.name === "rap-flight");
    expect(pack, "found in packs/").to.not.equal(undefined);
    expect(pack.sources).to.have.length(1);
    const [source] = pack.sources;
    expect(source.folder).to.equal("upstream");
    expect(source.repo).to.equal("https://github.com/SAP-samples/abap-platform-refscen-flight");
    expect(source.path).to.equal("src");
    expect(pack.abap.map((f) => f.replaceAll("\\", "/"))).to.deep.equal([join(DIR, "upstream"), join(DIR, "src")].map((f) => f.replaceAll("\\", "/")));
  });

  it("pins a commit, not a branch: a generation is the hash of its inputs", () => {
    expect(manifest.sources[0].ref).to.match(/^[0-9a-f]{40}$/);
  });

  it("explains every exclude pattern, so a refusal can be told from a shortcut", () => {
    const why = manifest._exclude_why ?? {};
    for (const pattern of manifest.sources[0].exclude) {
      expect(why[pattern], `a reason for ${pattern}`).to.be.a("string").and.not.equal("");
      expect(() => new RegExp(pattern), `${pattern} is a regular expression`).to.not.throw();
    }
    expect(Object.keys(why).sort()).to.deep.equal([...manifest.sources[0].exclude].sort());
  });

  it("keeps the business objects out by pattern: pools, test classes, BDEFs, the other scenarios", () => {
    const patterns = manifest.sources[0].exclude.map((e) => new RegExp(e, "i"));
    const excluded = (path) => patterns.some((p) => p.test(path));
    // R7: the managed travel runs; its pools come whole from the overlay
    expect(excluded("managed/#dmo#bp_travel_m.clas.abap"), "behavior pool (the overlay's)").to.equal(true);
    expect(excluded("managed/#dmo#i_travel_m.bdef.asbdef"), "the travel BDEF runs").to.equal(false);
    expect(excluded("managed/#dmo#c_travel_processor_m.bdef.asbdef"), "its projection runs").to.equal(false);
    expect(excluded("managed/#dmo#c_travel_processor_m.ddls.asddls"), "its projection view").to.equal(false);
    expect(excluded("reuse/supplement/#dmo#i_supplement.bdef.asbdef"), "the supplement BDEF runs (R10)").to.equal(false);
    expect(excluded("reuse/agency/#dmo#c_agencytp.bdef.asbdef"), "the agency projection runs (R10)").to.equal(false);
    expect(excluded("reuse/agency/#dmo#i_agencytp.bdef.asbdef"), "the interface BDEF runs (R11)").to.equal(false);
    expect(excluded("reuse/agency/#dmo#i_agencytp.ddls.asddls"), "its view (R11)").to.equal(false);
    expect(excluded("reuse/carrier/#dmo#i_carrierslocksingleton_s.bdef.asbdef"), "the singleton runs (R11)").to.equal(false);
    expect(excluded("reuse/carrier/#dmo#c_carrierslocksingleton_s.bdef.asbdef"), "its projection (R11)").to.equal(false);
    expect(excluded("reuse/carrier/#dmo#i_carrierslocksingleton_s.ddls.asddls"), "the computed root view (R11)").to.equal(false);
    expect(excluded("reuse/carrier/#dmo#ui_carriers_s.srvd.srvdsrv"), "its service (R11)").to.equal(false);
    expect(excluded("reuse/carrier/#dmo#bp_i_carrierslocksingle_s.clas.abap"), "behavior pool (the overlay's, R11)").to.equal(true);
    expect(excluded("reuse/supplement/#dmo#bp_i_supplement.clas.abap"), "behavior pool (the overlay's, R10)").to.equal(true);
    expect(excluded("managed/#dmo#tc_travel_m.clas.abap"), "test consumer").to.equal(true);
    expect(excluded("managed/#dmo#bp_travel_m.clas.testclasses.abap"), "ABAP Unit").to.equal(true);
    expect(excluded("draft/#dmo#i_travel_d.ddls.asddls"), "another scenario").to.equal(true);
    expect(excluded("reuse/agency/rev/#dmo#zz_agn_reva.tabl.xml"), "extensibility chapter").to.equal(true);
    expect(excluded("reuse/agency/slogn/#dmo#zz_s_ext_agency_slogan.tabl.xml"), "the append structure /dmo/agency includes").to.equal(false);
    expect(excluded("managed/#dmo#i_travel_m.ddls.asddls"), "the CDS view").to.equal(false);
    expect(excluded("managed/#dmo#travel_m.tabl.xml"), "the table").to.equal(false);
    expect(excluded("legacy/#dmo#cl_flight_data_generator.clas.abap"), "the data generator").to.equal(false);
  });

  it("when fetched, holds exactly what the manifest says (the marker agrees with the source)", function () {
    if (!existsSync(join(DIR, "upstream"))) this.skip();
    const pack = packsOf(ROOT, {}).find((p) => p.name === "rap-flight");
    const marker = markerOf(DIR);
    expect(marker.upstream, "the marker names the folder").to.not.equal(undefined);
    expect(marker.upstream.commit).to.equal(manifest.sources[0].ref);
    expect(sourceMatches(pack.sources[0], marker.upstream), "same repo, ref, path and excludes").to.equal(true);
  });
});

describe("packs/rap-flight: namespaced CDS names in the generator", () => {
  // the first namespaced view in a pack made cds2ddic write gen/cds/dmo/...
  // and fail with ENOENT; the file takes abapGit's form and the generated
  // class name carries the namespace as a word
  it("writes /DMO/CURRHLP as #dmo#currhlp and names its class ZCL_STG_CDS_DMO_CURRHLP", () => {
    expect(fileOf("/DMO/CURRHLP")).to.equal("#dmo#currhlp");
    expect(wordOf("/DMO/CURRHLP")).to.equal("DMO_CURRHLP");
    expect(fileOf("ZVTRAVEL"), "an unnamespaced name is untouched").to.equal("zvtravel");
    expect(wordOf("zvtravel")).to.equal("ZVTRAVEL");
  });

  // a CDS view entity has no SQL view name and up to 30 characters of its own,
  // which ZCL_STG_CDS_ + word does not fit: fourteen of the pack's generated
  // classes were "too long" before the name was cut to 30 with a hash tail
  it("keeps a generated class name at 30 characters, deterministically", () => {
    expect(classNameOf("ZCL_STG_CDS_", "/DMO/I_TRAVEL_M")).to.equal("ZCL_STG_CDS_DMO_I_TRAVEL_M");
    const long = classNameOf("ZCL_STG_CDS_", "/DMO/I_TRAVEL_STATUS_VH_TEXT");
    expect(long.length).to.be.at.most(30);
    expect(long).to.match(/^ZCL_STG_CDS_DMO_I_TRAVEL_[0-9A-F]{4}$/);
    expect(classNameOf("ZCL_STG_CDS_", "/DMO/I_TRAVEL_STATUS_VH_TEXT"), "the same name every build").to.equal(long);
    expect(classNameOf("ZCL_STG_CDS_", "/DMO/I_TRAVEL_STATUS_VH")).to.not.equal(long);
    expect(classNameOf("ZCL_", "/DMO/C_BOOKSUPPL_PROCESSOR_M", "_MPC_EXT")).to.have.length(30).and.match(/_MPC_EXT$/);
    expect(classNameOf("zcl_stg_tab_", "ZSTG_DEMO"), "the demo is untouched").to.equal("zcl_stg_tab_ZSTG_DEMO");
  });
});
