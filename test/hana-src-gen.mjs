import {expect} from "chai";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {execFileSync, spawnSync} from "node:child_process";
import {dirname, join, resolve} from "node:path";
import {run} from "../tools/hana-src-gen.mjs";
import {build, hashOf} from "../tools/osd-build.mjs";
import {syntheticReads} from "./helpers/fix7-fixtures.mjs";
import {writePublicArtefact} from "../tools/osd-public-tree.mjs";
import {generationHanaSrcProblem} from "../tools/osd-tmp.mjs";
import {expandedFolders} from "../tools/osd-packs.mjs";
import {layers} from "../tools/osd-inputs.mjs";

// The tenant's sources as input layers (tools/hana-src-gen.mjs, H4).
//
// One seam, without a dump: the fixture is a converter output directory
// (plan.json + layers/<name>/{.abapgit.xml, src/}) built in a temp dir, the
// way dump-to-layers.mjs writes it. Objects and packages are ZOSD_H4_*;
// layer names are the converter's <system>-<package> of those. The layering
// case is held the way H3 holds its: the folders become inputs before src/
// and a hand-written src/ file of the same name wins. One case runs
// --from-dump through a fake converter (OSD_HANA_CONVERTER) written into the
// test's own temp dir; no real converter, dump or HANA is involved.

// the .abapgit.xml the converter writes, verbatim from the fixture sample
const ABAPGIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA><MASTER_LANGUAGE>E</MASTER_LANGUAGE><STARTING_FOLDER>/src/</STARTING_FOLDER><FOLDER_LOGIC>PREFIX</FOLDER_LOGIC></DATA>
 </asx:values>
</asx:abap>
`;

// a converter output directory: plan.json plus the layer folders named in it
const converterOutput = () => {
  const root = mkdtempSync(join(tmpdir(), "hana-src-gen-"));
  const written = [];
  const layer = (name, pkg, order, files = []) => {
    written.push({name, package: pkg, folder: `layers/${name}`, order, objects: files.length === 0 ? {} : {PROG: files.length}});
    mkdirSync(join(root, "layers", name, "src"), {recursive: true});
    writeFileSync(join(root, "layers", name, ".abapgit.xml"), ABAPGIT_XML);
    for (const [file, body] of files) writeFileSync(join(root, "layers", name, "src", file), body);
  };
  const plan = (extra = {}) => {
    writeFileSync(join(root, "plan.json"), JSON.stringify({
      schema: 1, system: "osd",
      dump: {manifest_sha256: "f".repeat(64), provenance: "the H4 fixtures' own test bed"},
      layers: [...written].sort((a, b) => a.order - b.order),
      cycles: [], no_source: {TABL: 1}, orphans: [], errors: [],
      empty_layers: {count: 0, names: []}, unpackaged_groups: 0,
      ...extra,
    }, undefined, 2));
  };
  return {root, layer, plan};
};

const out = (root) => join(root, "gen-out");

describe("hana-src-gen: the tenant's sources as input layers", () => {
  it("orders and zero-pads the layers", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-b", "$ZOSD_H4_B", 2, [["zosd_h4_b.prog.abap", "REPORT zosd_h4_b.\n"]]);
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.layer("osd-tmp-zosd-h4-c", "$ZOSD_H4_C", 11, [["zosd_h4_c.prog.abap", "REPORT zosd_h4_c.\n"]]);
      f.plan();
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      expect(readdirSync(out(f.root)).sort()).to.deep.equal([
        "000-osd-tmp-zosd-h4-a", "002-osd-tmp-zosd-h4-b", "011-osd-tmp-zosd-h4-c", "manifest.json"]);
      expect(readFileSync(join(out(f.root), "002-osd-tmp-zosd-h4-b", "src", "zosd_h4_b.prog.abap"), "utf8"))
        .to.equal("REPORT zosd_h4_b.\n");
      expect(readFileSync(join(out(f.root), "011-osd-tmp-zosd-h4-c", ".abapgit.xml"), "utf8")).to.equal(ABAPGIT_XML);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("test code stays out of the island: *.testclasses.abap and *_TEST classes are not copied", async () => {
    // H5c round 7: the island must not include test code (the same rule
    // tools/hana-closure-merge.mjs's object count applies) -- a dump that
    // carries a class's test-classes include, or a *_TEST class the closure
    // pulled, stages neither; a name that only ends in _test inside a word
    // (latest) is not a test class
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [
        ["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"],
        ["zcl_h4_a_own.clas.testclasses.abap", "CLASS ltcl_h4_a_test DEFINITION FOR TESTING. ENDCLASS.\n"],
        ["zcl_h4_a_helper_test.clas.abap", "CLASS zcl_h4_a_helper_test DEFINITION PUBLIC FINAL. ENDCLASS.\n"],
        ["zcl_h4_a_keeper.clas.abap", "CLASS zcl_h4_a_keeper DEFINITION PUBLIC FINAL. ENDCLASS.\n"],
        ["zosd_h4_a_latest.clas.abap", "CLASS zcl_h4_a_latest DEFINITION PUBLIC FINAL. ENDCLASS.\n"],
        // an exception class named *_TEST is raised, not run: it stays
        ["zcx_h4_a_test.clas.abap", "CLASS zcx_h4_a_test DEFINITION PUBLIC INHERITING FROM cx_static_check. ENDCLASS.\n"],
      ]);
      f.plan();
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      expect(readdirSync(join(out(f.root), "000-osd-tmp-zosd-h4-a", "src")).sort()).to.deep.equal(
        ["zcl_h4_a_keeper.clas.abap", "zcx_h4_a_test.clas.abap", "zosd_h4_a.prog.abap", "zosd_h4_a_latest.clas.abap"]);
      // the plan and the disk agree, so --check passes
      expect(await run(["--layers", f.root, "--check", "--out", out(f.root)])).to.equal(0);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("a cycle group is one folder, the members' src merged, and the manifest says so", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-x", "$ZOSD_H4_X", 3, [["zosd_h4_x.prog.abap", "REPORT zosd_h4_x.\n"]]);
      f.layer("osd-tmp-zosd-h4-y", "$ZOSD_H4_Y", 4, [["zosd_h4_y.prog.abap", "REPORT zosd_h4_y.\n"]]);
      f.plan({cycles: [["osd-tmp-zosd-h4-x", "osd-tmp-zosd-h4-y"]]});
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      // one folder at the smallest member's order; no folder per member
      expect(readdirSync(out(f.root)).sort()).to.deep.equal([
        "003-cycle-osd-tmp-zosd-h4-x+osd-tmp-zosd-h4-y", "manifest.json"]);
      const merged = join(out(f.root), "003-cycle-osd-tmp-zosd-h4-x+osd-tmp-zosd-h4-y");
      expect(readFileSync(join(merged, "src", "zosd_h4_x.prog.abap"), "utf8")).to.equal("REPORT zosd_h4_x.\n");
      expect(readFileSync(join(merged, "src", "zosd_h4_y.prog.abap"), "utf8")).to.equal("REPORT zosd_h4_y.\n");
      expect(readFileSync(join(merged, ".abapgit.xml"), "utf8")).to.equal(ABAPGIT_XML);
      const manifest = JSON.parse(readFileSync(join(out(f.root), "manifest.json"), "utf8"));
      expect(manifest.layers).to.deep.equal([{
        name: "cycle-osd-tmp-zosd-h4-x+osd-tmp-zosd-h4-y", package: null, order: 3, objects: {PROG: 2},
        cycle: ["osd-tmp-zosd-h4-x", "osd-tmp-zosd-h4-y"],
      }]);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("--packages filters by plan package and refuses a pattern that names nothing", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-keep", "$ZOSD_H4_KEEP", 0, [["zosd_h4_keep.prog.abap", "REPORT zosd_h4_keep.\n"]]);
      f.layer("osd-tmp-zosd-h4-drop", "$ZOSD_H4_DROP", 1, [["zosd_h4_drop.prog.abap", "REPORT zosd_h4_drop.\n"]]);
      f.plan();
      expect(await run(["--layers", f.root, "--packages", "$ZOSD_H4_K%", "--out", out(f.root)])).to.equal(0);
      expect(readdirSync(out(f.root)).sort()).to.deep.equal(["000-osd-tmp-zosd-h4-keep", "manifest.json"]);
      const manifest = JSON.parse(readFileSync(join(out(f.root), "manifest.json"), "utf8"));
      expect(manifest.layers.map((l) => l.package)).to.deep.equal(["$ZOSD_H4_KEEP"]);
      let refused;
      try {
        await run(["--layers", f.root, "--packages", "$ZOSD_H4_NONE", "--out", join(f.root, "none")]);
        expect.fail("a pattern that names no layer must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/no layer matches --packages \$ZOSD_H4_NONE/);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("a layer folder without .abapgit.xml is refused", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      unlinkSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", ".abapgit.xml"));
      let refused;
      try {
        await run(["--layers", f.root, "--out", out(f.root)]);
        expect.fail("a layer without .abapgit.xml must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/osd-tmp-zosd-h4-a.*has no \.abapgit\.xml/);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("nested folders in a layer are refused", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      mkdirSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "src", "nested"), {recursive: true});
      writeFileSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "src", "nested", "zosd_h4_n.prog.abap"), "REPORT zosd_h4_n.\n");
      let refused;
      try {
        await run(["--layers", f.root, "--out", out(f.root)]);
        expect.fail("a nested folder must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/nested.*is a folder/);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("a layers directory inside the tree is refused unless it is under gen/ or .local/", async () => {
    const tree = mkdtempSync(join(tmpdir(), "hana-src-tree-"));
    try {
      // local/ is inside the tree and not gen/ or .local/: refused
      const local = join(tree, "local", "layers");
      mkdirSync(local, {recursive: true});
      writeFileSync(join(local, "plan.json"), "{}");
      let refused;
      try {
        await run(["--layers", local, "--out", join(tree, "gen", "out")], {root: tree});
        expect.fail("a layers directory inside the tree must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/inside this tree/);
      expect(refused.message).to.match(/gen\/ or \.local\//);
      // under gen/ the same directory is allowed, and is read
      const allowed = join(tree, "gen", "layers");
      const f = converterOutput();
      try {
        f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
        f.plan();
        rmSync(allowed, {recursive: true, force: true});
        cpSync(f.root, allowed, {recursive: true});
        expect(await run(["--layers", allowed, "--out", join(tree, "gen", "hana-src")], {root: tree})).to.equal(0);
        expect(readdirSync(join(tree, "gen", "hana-src"))).to.include("000-osd-tmp-zosd-h4-a");
      } finally {
        rmSync(f.root, {recursive: true, force: true});
      }
    } finally {
      rmSync(tree, {recursive: true, force: true});
    }
  });

  it("the manifest carries the provenance the plan has, and only that", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      const manifest = JSON.parse(readFileSync(join(out(f.root), "manifest.json"), "utf8"));
      expect(manifest.source).to.equal(f.root);
      expect(manifest.dump).to.deep.equal({manifest_sha256: "f".repeat(64), provenance: "the H4 fixtures' own test bed"});
      expect(manifest.layers).to.deep.equal([
        {name: "osd-tmp-zosd-h4-a", package: "$ZOSD_H4_A", order: 0, objects: {PROG: 1}}]);
      expect(manifest.no_source).to.deep.equal({TABL: 1});
      expect(new Date(manifest.generated_at).toISOString()).to.equal(manifest.generated_at);
      expect("converter_commit" in manifest, "the plan carries no converter commit").to.equal(false);
      // a plan that carries one passes it through, and one without a dump
      // manifest says nothing about a dump
      f.plan({converter_commit: "abc123", dump: undefined});
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      const again = JSON.parse(readFileSync(join(out(f.root), "manifest.json"), "utf8"));
      expect(again.converter_commit).to.equal("abc123");
      expect("dump" in again, "no dump provenance, no dump key").to.equal(false);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("--check exits 1 on drift and ignores generated_at", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.layer("osd-tmp-zosd-h4-b", "$ZOSD_H4_B", 1, [["zosd_h4_b.prog.abap", "REPORT zosd_h4_b.\n"]]);
      f.plan();
      const at = out(f.root);
      expect(await run(["--layers", f.root, "--out", at])).to.equal(0);
      // a fresh --check run would write a new generated_at; it is not drift
      expect(await run(["--layers", f.root, "--check", "--out", at])).to.equal(0);
      // an edited copy is drift
      writeFileSync(join(at, "000-osd-tmp-zosd-h4-a", "src", "zosd_h4_a.prog.abap"), "REPORT edited.\n");
      expect(await run(["--layers", f.root, "--check", "--out", at])).to.equal(1);
      writeFileSync(join(at, "000-osd-tmp-zosd-h4-a", "src", "zosd_h4_a.prog.abap"), "REPORT zosd_h4_a.\n");
      // a missing folder is drift
      rmSync(join(at, "001-osd-tmp-zosd-h4-b"), {recursive: true, force: true});
      expect(await run(["--layers", f.root, "--check", "--out", at])).to.equal(1);
      expect(await run(["--layers", f.root, "--out", at])).to.equal(0);
      // an extra file on disk is drift
      writeFileSync(join(at, "001-osd-tmp-zosd-h4-b", "src", "zosd_h4_extra.prog.abap"), "REPORT zosd_h4_extra.\n");
      expect(await run(["--layers", f.root, "--check", "--out", at])).to.equal(1);
      // no gen/hana-src at all is drift, and says so
      const empty = join(f.root, "never-written");
      expect(await run(["--layers", f.root, "--check", "--out", empty])).to.equal(1);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("several --layers dirs accumulate: the union of the plans, later wins per file", async () => {
    const f1 = converterOutput();
    const f2 = converterOutput();
    try {
      f1.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f1.layer("osd-tmp-zosd-h4-b", "$ZOSD_H4_B", 1, [["zosd_h4_b.prog.abap", "REPORT zosd_h4_b from the first dump.\n"]]);
      f1.plan();
      f2.layer("osd-tmp-zosd-h4-b", "$ZOSD_H4_B", 0, [
        ["zosd_h4_b.prog.abap", "REPORT zosd_h4_b from the second dump.\n"],
        ["zosd_h4_b2.prog.abap", "REPORT zosd_h4_b2.\n"]]);
      f2.layer("osd-tmp-zosd-h4-c", "$ZOSD_H4_C", 1, [["zosd_h4_c.prog.abap", "REPORT zosd_h4_c.\n"]]);
      f2.plan({dump: {manifest_sha256: "2".repeat(64), provenance: "the second dump"}});
      const at = out(f1.root);
      expect(await run(["--layers", f1.root, "--layers", f2.root, "--out", at])).to.equal(0);
      // three folders, renumbered in the flags' order; the layer both dumps
      // carry is ONE folder holding the union of its files
      expect(readdirSync(at).sort()).to.deep.equal([
        "000-osd-tmp-zosd-h4-a", "001-osd-tmp-zosd-h4-b", "002-osd-tmp-zosd-h4-c", "manifest.json"]);
      expect(readFileSync(join(at, "000-osd-tmp-zosd-h4-a", "src", "zosd_h4_a.prog.abap"), "utf8"))
        .to.equal("REPORT zosd_h4_a.\n");
      expect(readFileSync(join(at, "001-osd-tmp-zosd-h4-b", "src", "zosd_h4_b.prog.abap"), "utf8"),
        "the later dump's copy of the shared file wins").to.equal("REPORT zosd_h4_b from the second dump.\n");
      expect(existsSync(join(at, "001-osd-tmp-zosd-h4-b", "src", "zosd_h4_b2.prog.abap")),
        "the first dump's extra file stays (union, not replace)").to.equal(true);
      expect(readFileSync(join(at, "002-osd-tmp-zosd-h4-c", "src", "zosd_h4_c.prog.abap"), "utf8"))
        .to.equal("REPORT zosd_h4_c.\n");
      const manifest = JSON.parse(readFileSync(join(at, "manifest.json"), "utf8"));
      expect(manifest.source).to.deep.equal([f1.root, f2.root]);
      expect(manifest.dump, "the last dump's provenance is the generation's").to.deep.equal(
        {manifest_sha256: "2".repeat(64), provenance: "the second dump"});
      expect(manifest.layers.map((l) => l.name)).to.deep.equal(
        ["osd-tmp-zosd-h4-a", "osd-tmp-zosd-h4-b", "osd-tmp-zosd-h4-c"]);
      // the loop merges every iteration: a repeat is stable, --check agrees
      expect(await run(["--layers", f1.root, "--layers", f2.root, "--check", "--out", at])).to.equal(0);
    } finally {
      rmSync(f1.root, {recursive: true, force: true});
      rmSync(f2.root, {recursive: true, force: true});
    }
  });

  it("--packages over several --layers matches the union, and refuses a pattern that names nothing in any of them", async () => {
    const f1 = converterOutput();
    const f2 = converterOutput();
    try {
      f1.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f1.plan();
      f2.layer("osd-tmp-zosd-h4-c", "$ZOSD_H4_C", 0, [["zosd_h4_c.prog.abap", "REPORT zosd_h4_c.\n"]]);
      f2.plan();
      const at = out(f1.root);
      expect(await run(["--layers", f1.root, "--layers", f2.root, "--packages", "$ZOSD_H4_C", "--out", at])).to.equal(0);
      expect(readdirSync(at).sort()).to.deep.equal(["000-osd-tmp-zosd-h4-c", "manifest.json"]);
      let refused;
      try {
        await run(["--layers", f1.root, "--layers", f2.root, "--packages", "$ZOSD_H4_NONE", "--out", join(f1.root, "none")]);
        expect.fail("a pattern that names no layer in any dir must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/no layer matches --packages \$ZOSD_H4_NONE/);
    } finally {
      rmSync(f1.root, {recursive: true, force: true});
      rmSync(f2.root, {recursive: true, force: true});
    }
  });

  it("the folders are layers before src/, and a src/ file of the same name wins", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-src-layers-"));
    const write = (rel, body) => {
      mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), {recursive: true});
      writeFileSync(join(root, rel), body);
    };
    try {
      write("abap_transpile.json", JSON.stringify({input_folder: ["gen/hana-ddic", "gen/hana-src/*", "src", "gen"]}));
      write("gen/hana-src/000-osd-tmp-zosd-h4-a/.abapgit.xml", ABAPGIT_XML);
      write("gen/hana-src/000-osd-tmp-zosd-h4-a/src/zosd_h4_prog.prog.abap", "REPORT generated.\n");
      write("gen/hana-src/001-osd-tmp-zosd-h4-b/.abapgit.xml", ABAPGIT_XML);
      write("gen/hana-src/001-osd-tmp-zosd-h4-b/src/zosd_h4_keep.prog.abap", "REPORT zosd_h4_keep.\n");
      write("src/zosd_h4_prog.prog.abap", "REPORT hand-written wins.\n");
      write("gen/hana-ddic/zosd_h4_tab.tabl.xml", "<abapGit><TABNAME>ZOSD_H4_TAB</TABNAME></abapGit>");
      write("gen/zosd_h4_gen.tabl.xml", "<abapGit><TABNAME>ZOSD_H4_GEN</TABNAME></abapGit>");
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const stack = layers(root, config);
      expect(stack.folders, "one entry, the children as layers, before src/").to.deep.equal([
        "gen/hana-ddic", "gen/hana-src/000-osd-tmp-zosd-h4-a", "gen/hana-src/001-osd-tmp-zosd-h4-b", "src", "gen"]);
      expect(stack.owner.get("PROG ZOSD_H4_PROG"), "the hand-written src/ file wins").to.equal("src");
      expect(stack.hidden).to.deep.equal(["gen/hana-src/000-osd-tmp-zosd-h4-a/src/zosd_h4_prog.prog.abap"]);
      expect(stack.owner.get("PROG ZOSD_H4_KEEP")).to.equal("gen/hana-src/001-osd-tmp-zosd-h4-b");
      expect(stack.owner.get("TABL ZOSD_H4_TAB")).to.equal("gen/hana-ddic");
      expect(stack.owner.get("TABL ZOSD_H4_GEN")).to.equal("gen");
      expect(stack.duplicates).to.deep.equal([]);
      expect(stack.total, "each object counted once; the repository marker is no object").to.equal(4);
      expect([...stack.owner.keys()].filter((o) => o.startsWith("ABAPGIT")), "no phantom object from .abapgit.xml")
        .to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("expandedFolders: one entry, the children as layers", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-src-expand-"));
    const write = (rel, body = "") => {
      mkdirSync(join(root, rel.split("/").slice(0, -1).join("/")), {recursive: true});
      writeFileSync(join(root, rel), body);
    };
    try {
      write("gen/hana-src/002-osd-tmp-zosd-h4-b/src/zosd_h4_b.prog.abap");
      write("gen/hana-src/001-osd-tmp-zosd-h4-a/src/zosd_h4_a.prog.abap");
      write("gen/hana-src/manifest.json", "{}");
      // the children in name order (the zero padding is the plan order), the
      // parent's own files not expanded, the plain entry carried through
      expect(expandedFolders(["gen/hana-src/*", "src"], root)).to.deep.equal([
        "gen/hana-src/001-osd-tmp-zosd-h4-a", "gen/hana-src/002-osd-tmp-zosd-h4-b", "src"]);
      // a parent that is not there yields nothing, like a missing input folder
      expect(expandedFolders(["gen/hana-absent/*"], root)).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the tracked abap_transpile.json pins the order: gen/hana-ddic, gen/hana-src/*, then src", () => {
    // the decision lives in the tracked file; layers()'s mechanics are
    // pinned by the temp-config case above, the file itself by this one
    const config = JSON.parse(readFileSync(new URL("../abap_transpile.json", import.meta.url), "utf8"));
    const folders = config.input_folder;
    const at = (entry) => folders.indexOf(entry);
    expect(at("gen/hana-ddic"), "gen/hana-ddic is listed").to.be.at.least(0);
    expect(at("gen/hana-src/*"), "the generated layers are one entry").to.be.at.least(0);
    expect(at("src"), "src is listed").to.be.at.least(0);
    expect(at("gen/hana-ddic"), "the layers sit after gen/hana-ddic").to.be.lessThan(at("gen/hana-src/*"));
    expect(at("gen/hana-src/*"), "the layers sit before src/: the later folder wins").to.be.lessThan(at("src"));
    expect(config.exclude_filter, "the manifest is provenance, not transpile input")
      .to.include("/gen/hana-src/manifest\\.json$");
  });

  it("--from-dump runs the converter on the dump, records the dump as the source, and --check agrees", async () => {
    const f = converterOutput();
    const bin = mkdtempSync(join(tmpdir(), "hana-src-conv-"));
    const dumpDir = join(bin, "dump"); // a dump path; the fake converter never opens it
    mkdirSync(dumpDir, {recursive: true});
    const recorded = join(bin, "argv.json");
    writeFileSync(join(bin, "fake-converter.mjs"), [
      "import {cpSync, writeFileSync} from \"node:fs\";",
      "const args = process.argv.slice(2);",
      "writeFileSync(process.env.FAKE_CONVERTER_RECORD, JSON.stringify(args));",
      "cpSync(process.env.FAKE_CONVERTER_SOURCE, args[args.indexOf(\"--out\") + 1], {recursive: true});",
      ""].join("\n"));
    const saved = {
      OSD_HANA_CONVERTER: process.env.OSD_HANA_CONVERTER,
      FAKE_CONVERTER_RECORD: process.env.FAKE_CONVERTER_RECORD,
      FAKE_CONVERTER_SOURCE: process.env.FAKE_CONVERTER_SOURCE,
    };
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      process.env.OSD_HANA_CONVERTER = join(bin, "fake-converter.mjs");
      process.env.FAKE_CONVERTER_RECORD = recorded;
      process.env.FAKE_CONVERTER_SOURCE = f.root;
      const at = out(f.root);
      expect(await run(["--from-dump", "--dump", dumpDir, "--system", "osd", "--out", at])).to.equal(0);
      // the converter's argv, pinned: <dump> --out <temp> --system <prefix>
      const args = JSON.parse(readFileSync(recorded, "utf8"));
      expect(args.slice(0, 1), "the dump is the converter's input").to.deep.equal([dumpDir]);
      expect(args.slice(1), "--out, the temp dir this tool made, --system, the prefix")
        .to.deep.equal(["--out", args[2], "--system", "osd"]);
      expect(args[2], "the temp dir is this tool's own mkdtemp").to.match(/hana-src-layers-/);
      // the manifest names the dump and the prefix, not the temp dir (which
      // is gone by now), so a later --check over the same dump agrees: a new
      // temp dir cannot drift on its path alone
      const manifest = JSON.parse(readFileSync(join(at, "manifest.json"), "utf8"));
      expect(manifest.source).to.equal(resolve(dumpDir));
      expect(manifest.system).to.equal("osd");
      expect(await run(["--from-dump", "--dump", dumpDir, "--system", "osd", "--check", "--out", at])).to.equal(0);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(bin, {recursive: true, force: true});
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("--out inside the tree is refused unless it is under gen/ or .local/", async () => {
    const tree = mkdtempSync(join(tmpdir(), "hana-src-out-"));
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      let refused;
      try {
        await run(["--layers", f.root, "--out", join(tree, "src", "tenant")], {root: tree});
        expect.fail("an --out inside the tree must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/--out .*inside this tree/);
      expect(refused.message).to.match(/gen\/ or \.local\//);
      // under .local/ the same out is allowed, like under gen/
      expect(await run(["--layers", f.root, "--out", join(tree, ".local", "hana-src")], {root: tree})).to.equal(0);
      expect(readdirSync(join(tree, ".local", "hana-src"))).to.include("000-osd-tmp-zosd-h4-a");
    } finally {
      rmSync(tree, {recursive: true, force: true});
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("a folder beside a layer's src/ is refused, like a nested one; a file stays ignored", async () => {
    const f = converterOutput();
    try {
      f.layer("osd-tmp-zosd-h4-a", "$ZOSD_H4_A", 0, [["zosd_h4_a.prog.abap", "REPORT zosd_h4_a.\n"]]);
      f.plan();
      mkdirSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "other"), {recursive: true});
      writeFileSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "other", "stray.txt"), "stray\n");
      let refused;
      try {
        await run(["--layers", f.root, "--out", out(f.root)]);
        expect.fail("a folder beside src/ must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/other\/ beside src\//);
      // a file beside src/ is ignored, not copied (a package.devc.xml, when
      // the converter grows one)
      rmSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "other"), {recursive: true, force: true});
      writeFileSync(join(f.root, "layers", "osd-tmp-zosd-h4-a", "package.devc.xml"), "<devc/>");
      expect(await run(["--layers", f.root, "--out", out(f.root)])).to.equal(0);
      expect(readdirSync(join(out(f.root), "000-osd-tmp-zosd-h4-a"))).to.deep.equal([".abapgit.xml", "src"]);
    } finally {
      rmSync(f.root, {recursive: true, force: true});
    }
  });

  it("generationHanaSrcProblem: the private gen/ prefixes refuse, a clean generation publishes", async () => {
    // the helper, unit-first: an inputs.folders entry under any private
    // folder is a private generation, a clean one publishes, an unreadable
    // record is a refusal (fail closed). No second witness, unlike the $TMP
    // check: this tree's own config names "gen/hana-src/*" whether or not a
    // build ever saw one of these layers, so only the generation's expanded
    // folder list decides. gen/hana-ddic is private the same way -- the
    // dockerignore names the folders, and its DDIC shapes are the tenant's
    // table and field names; gen/hana-closure too -- the closure's state,
    // request and gaps files carry the tenant's object names.
    const {generationHanaSrcProblem} = await import("../tools/osd-tmp.mjs");
    const generation = mkdtempSync(join(tmpdir(), "hana-src-pub-"));
    try {
      writeFileSync(join(generation, "manifest.json"), JSON.stringify({
        inputs: {folders: ["src", "gen/hana-src/000-osd-tmp-zosd-h4-a"]}}));
      expect(generationHanaSrcProblem(generation)).to.match(/gen\/hana-src\/000-osd-tmp-zosd-h4-a/);
      expect(generationHanaSrcProblem(generation), "the tenant's sources are private").to.match(/private/);
      writeFileSync(join(generation, "manifest.json"), JSON.stringify({
        inputs: {folders: ["src", "gen", "gen/hana-ddic"]}}));
      expect(generationHanaSrcProblem(generation), "the generated DDIC is private the same way").to.match(/gen\/hana-ddic/);
      expect(generationHanaSrcProblem(generation)).to.match(/private/);
      writeFileSync(join(generation, "manifest.json"), JSON.stringify({
        inputs: {folders: ["src", "gen", "gen/hana-closure"]}}));
      expect(generationHanaSrcProblem(generation), "the closure's state and request are tenant content too").to.match(/gen\/hana-closure/);
      expect(generationHanaSrcProblem(generation)).to.match(/private/);
      writeFileSync(join(generation, "manifest.json"), JSON.stringify({
        inputs: {folders: ["src", "gen", "gen/hana-srcx"]}}));
      expect(generationHanaSrcProblem(generation), "a prefix lookalike is no false positive").to.equal(undefined);
      writeFileSync(join(generation, "manifest.json"), JSON.stringify({
        inputs: {folders: ["src", "gen"]}}));
      expect(generationHanaSrcProblem(generation), "a generation without the private folders publishes").to.equal(undefined);
      writeFileSync(join(generation, "manifest.json"), "{broken");
      expect(generationHanaSrcProblem(generation), "no record, no publishing").to.match(/no readable record/);
    } finally {
      rmSync(generation, {recursive: true, force: true});
    }
  });

  // ---- the REAL pair: the build's own inputsOf record, and the guard every
  // publisher reads it with -- not a hand-written manifest. The base leaves
  // gen/hana-ddic existing but empty on every build (runGenerators, H3 fix
  // round 4), so a tree that has built once must still publish: the record
  // names what the build read, and an empty folder was never read.
  const CHECKOUT = resolve(import.meta.dirname, "..");
  const realTree = () => {
    const root = mkdtempSync(join(tmpdir(), "hana-src-real-"));
    symlinkSync(join(CHECKOUT, "node_modules"), join(root, "node_modules"), "dir");
    // the generators resolve library pins (cds2ddic's types, the gui
    // converter of osd-gui-convert): a lock this tree can read and the
    // checkout's clones. The tree is not a checkout, so the pin gate is the
    // shipped-tree rule and the refs are never verified -- they only have to
    // be well-formed.
    writeFileSync(join(root, "libs.lock.json"), JSON.stringify({
      transpiler: {repo: "example/transpiler", ref: "a".repeat(40)},
      libraries: ["abapgit", "ajson", "express-icf-shim", "open-abap-apc", "open-abap-core", "open-abap-odata", "open-abap-gui"]
        .map((folder) => ({folder, repo: `example/${folder}`, ref: "0".repeat(40)})),
    }));
    mkdirSync(join(root, ".local"), {recursive: true});
    symlinkSync(join(CHECKOUT, ".local", "lars"), join(root, ".local", "lars"), "dir");
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "src", "zosd_h4_real.clas.abap"),
      "CLASS zosd_h4_real DEFINITION PUBLIC.\nENDCLASS.\nCLASS zosd_h4_real IMPLEMENTATION.\nENDCLASS.\n");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["gen/hana-ddic", "src"], output_folder: "output", libs: [],
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }));
    return root;
  };
  const editSource = (root) => writeFileSync(join(root, "src", "zosd_h4_real.clas.abap"),
    `CLASS zosd_h4_real DEFINITION PUBLIC.\nENDCLASS.\nCLASS zosd_h4_real IMPLEMENTATION.\nENDCLASS.\n* touched ${Math.random()}\n`);
  const manifestFolders = (root, hash) =>
    JSON.parse(readFileSync(join(root, "build", "by-input", hash, "manifest.json"), "utf8")).inputs.folders;
  // a build of a tree of its own: the publishers' env scrub, for the same
  // reason their fake trees pass OSD_PACKS= and friends empty
  const withTreeEnv = async (fn) => {
    const names = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_IMAGE_PACKS"];
    const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
    try {
      for (const n of names) delete process.env[n];
      return await fn();
    } finally {
      for (const [n, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[n]; else process.env[n] = v;
      }
    }
  };

  it("the real pair: an empty gen/hana-ddic is no input, the next build is not refused", async function () {
    this.timeout(240000);
    const root = realTree();
    try {
      const first = await withTreeEnv(() => build({root}));
      expect(generationHanaSrcProblem(join(root, "build", "by-input", first.hash)), "the first build publishes").to.equal(undefined);
      // runGenerators has made gen/hana-ddic, empty, by now; a source edit
      // makes the next build a generation of its own, the way any tree that
      // changed since its last build is
      editSource(root);
      const second = await withTreeEnv(() => build({root}));
      expect(second.hash, "the edit built a new generation").to.not.equal(first.hash);
      expect(manifestFolders(root, second.hash), "the empty folder is not in the record").to.not.include("gen/hana-ddic");
      expect(generationHanaSrcProblem(join(root, "build", "by-input", second.hash)), "the second build publishes too").to.equal(undefined);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the real pair: one file in gen/hana-ddic makes the generation after it private", async function () {
    this.timeout(240000);
    const root = realTree();
    try {
      const first = await withTreeEnv(() => build({root}));
      writeFileSync(join(root, "gen", "hana-ddic", "zosd_h4_real_tab.tabl.xml"),
        "<abapGit><TABNAME>ZOSD_H4_REAL_TAB</TABNAME></abapGit>");
      editSource(root);
      const second = await withTreeEnv(() => build({root}));
      expect(second.hash, "the edit built a new generation").to.not.equal(first.hash);
      expect(manifestFolders(root, second.hash), "a folder that contributed is the record").to.include("gen/hana-ddic");
      const problem = generationHanaSrcProblem(join(root, "build", "by-input", second.hash));
      expect(problem, "the tenant's DDIC in the inputs is private").to.match(/gen\/hana-ddic/);
      expect(problem).to.match(/private/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  // ---- the publishers, behaviourally. One fake tree; each publisher runs
  // against a build/live generation whose manifest is rewritten per case: a
  // tenant layer in it -> refused before anything is staged; a clean record
  // -> allowed; and the stale gen/hana-src and gen/hana-ddic folders planted
  // on disk never reach what the clean run stages -- the decision is the
  // record, not the tree. The tools the publishers import are copied into
  // the tree, so what runs is the code the tree itself ships.

  describe("the publishers that bundle a build, against a fake tree", () => {
    const REPO = resolve(import.meta.dirname, "..");
    // each tree's generation is named by the hash of the tree itself, and
    // carries a complete, public read record (#908): the publishers gate on
    // both before they look at gen/hana-src
    const GENERATION = new Map();
    let home;
    // the preview's module graph resolves bare specifiers (@abaplint/core
    // and friends) from node_modules beside the importing folder: its tree
    // links the checkout's node_modules, and it copies no node_modules of
    // its own, so the link costs nothing
    let previewHome;

    const writeIn = (tree, rel, body = "") => {
      mkdirSync(dirname(join(tree, rel)), {recursive: true});
      writeFileSync(join(tree, rel), body);
    };
    const copyFromRepo = (tree, rel) => {
      mkdirSync(dirname(join(tree, rel)), {recursive: true});
      cpSync(join(REPO, rel), join(tree, rel), {recursive: true});
    };
    const generationManifest = (tree, folders) => {
      writeIn(tree, join("build", "by-input", GENERATION.get(tree), "manifest.json"),
        `${JSON.stringify({hash: GENERATION.get(tree), inputs: {folders}, systemDigest: null, systemPrivate: false, provenance: []}, undefined, 2)}\n`);
      syntheticReads(tree, GENERATION.get(tree));
    };
    // the children see a tree of their own, not this checkout's packs or layers
    const runInTree = (tree, script, args = []) => spawnSync("node", [script, ...args],
      {cwd: tree, encoding: "utf8", env: {...process.env,
        OSD_PACKS: "", OSD_WEB_PACKS: "", OSD_TMP: "", OSD_LAYERS: "",
        OSD_LAYER_PACKAGE: "", OSD_IMAGE_PACKS: "", OSD_PREVIEW_GENERATE_ONLY: "1"}});
    // the same environment runInTree hands a child: empty, not unset -- an
    // unset OSD_WEB_PACKS selects every pack, an empty one none, and the two
    // name different generations of one tree. Restored when fn has settled,
    // a promise included.
    const withTreeEnv = (fn) => {
      const names = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_IMAGE_PACKS"];
      const saved = Object.fromEntries(names.map((n) => [n, process.env[n]]));
      const restore = () => {
        for (const [n, v] of Object.entries(saved)) {
          if (v === undefined) delete process.env[n]; else process.env[n] = v;
        }
      };
      for (const n of names) process.env[n] = "";
      let result;
      try { result = fn(); } catch (error) { restore(); throw error; }
      if (typeof result?.then === "function") return result.finally(restore);
      restore();
      return result;
    };
    const freshProbe = () => {
      rmSync(join(home, ".local", "release-probe", "linux-amd64"), {recursive: true, force: true});
      writeIn(home, join(".local", "release-probe", "linux-amd64", "osd"), "placeholder osd binary\n");
    };
    const stagesNoPrivateGen = (rel) => {
      const entries = readdirSync(join(home, rel), {recursive: true}).join(",");
      expect(entries, `${rel} drops the stale gen/hana-src`).to.not.match(/hana-src/);
      expect(entries, `${rel} drops the stale gen/hana-ddic`).to.not.match(/hana-ddic/);
      expect(entries, `${rel} drops the stale gen/hana-closure`).to.not.match(/hana-closure/);
      expect(entries, `${rel} stages gen/ itself`).to.match(/zosd_h4_gen_control/);
    };

    before(async function () {
      this.timeout(240000);
      home = join(mkdtempSync(join(tmpdir(), "hana-src-pub-")), "tree");
      previewHome = join(dirname(home), "preview-tree");
      const freshProbeAt = (tree) => {
        rmSync(join(tree, ".local", "release-probe", "linux-amd64"), {recursive: true, force: true});
        writeIn(tree, join(".local", "release-probe", "linux-amd64", "osd"), "placeholder osd binary\n");
      };
      // both trees hold the same fixture; they differ only in node_modules
      const buildTree = (tree, {linkedNodeModules = false} = {}) => {
        mkdirSync(tree, {recursive: true});
        copyFromRepo(tree, "tools");
        for (const dir of ["src", "data", "webapp", "test", "bin", "scripts"]) mkdirSync(join(tree, dir), {recursive: true});
        if (linkedNodeModules) symlinkSync(join(REPO, "node_modules"), join(tree, "node_modules"));
        else {
          // the public-tree gate imports the parser, and the hash names the
          // transpiler and runtime installed in the tree: link those three, so
          // a publisher run in this process and one run in the tree agree
          mkdirSync(join(tree, "node_modules", "@abaplint"), {recursive: true});
          for (const name of ["core", "transpiler", "runtime"])
            symlinkSync(join(REPO, "node_modules", "@abaplint", name), join(tree, "node_modules", "@abaplint", name));
        }
        for (const file of ["test/seed.mjs", "web/preview-socket.mjs", "docker/image/assemble.mjs",
          "docker/image/license-assumptions.mjs", "docker/image/packs.mjs", "scripts/build-preview.mjs",
          "scripts/make-download-bundle.mjs", "scripts/release/run.sh", "scripts/release/run.ps1", "LICENSE"]) {
          copyFromRepo(tree, file);
        }
        writeIn(tree, "docker/image/sources.json", `${JSON.stringify({libraries: []})}\n`);
        writeIn(tree, "libs.lock.json", `${JSON.stringify({libraries: [], transpiler: {repo: "example/transpiler", ref: "fixture"}})}\n`);
        writeIn(tree, "abap_transpile.json", `${JSON.stringify({input_folder: ["src"]})}\n`);
        writeIn(tree, "abaplint.jsonc", "{}\n");
        writeIn(tree, "package.json", `${JSON.stringify({name: "hana-src-publisher-fixture", private: true})}\n`);
        writeIn(tree, "package-lock.json", "{}\n");
        writeIn(tree, "bin/osd.mjs", "// the fixture's placeholder host\n");
        // one generation for build/live to point at, and the private folders
        // stale on disk beside it: the decision must be the record, not the
        // tree. output/ is the link the preview resolves its generation
        // through (dirname(realpath(output)) is the generation, the way
        // osd-build lays it out), and build-preview reads it before its
        // guards run
        writeIn(tree, join("gen", "amdp", "procedures.json"), `${JSON.stringify({procedures: []})}\n`);
        writeIn(tree, join("gen", "zosd_h4_gen_control.tabl.xml"), "<abapGit><TABNAME>ZOSD_H4_GEN_CONTROL</TABNAME></abapGit>");
        writeIn(tree, join("gen", "hana-src", "000-osd-tmp-zosd-h4-a", "src", "zosd_h4_a.prog.abap"), "REPORT zosd_h4_a.\n");
        writeIn(tree, join("gen", "hana-ddic", "zosd_h4_tab.tabl.xml"), "<abapGit><TABNAME>ZOSD_H4_TAB</TABNAME></abapGit>");
        writeIn(tree, join("gen", "hana-closure", "state.json"), "{}\n");
        // the bundle fingerprints the host and the launchers, probes a binary,
        // wants the three packs, and reads the commit of the tree it stages
        freshProbeAt(tree);
        for (const pack of ["lsd", "o4d", "zork"]) writeIn(tree, join("packs", pack, "osd-pack.json"), `${JSON.stringify({name: pack})}\n`);
        execFileSync("git", ["init", "-q"], {cwd: tree});
        execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost",
          "commit", "--allow-empty", "-q", "-m", "fixture"], {cwd: tree});
        const generation = withTreeEnv(() => hashOf(tree));
        GENERATION.set(tree, generation);
        writeIn(tree, join("build", "by-input", generation, "output", "init.mjs"), "export default {};\n");
        symlinkSync(join("by-input", generation), join(tree, "build", "live"));
        symlinkSync(join("build", "live", "output"), join(tree, "output"));
      };
      buildTree(home, {});
      buildTree(previewHome, {linkedNodeModules: true});
      // the transpiler packages the image's license report reads, one folder
      // beside both trees: assemble reads ../transpiler/ against its cwd
      for (const name of ["runtime", "transpiler", "cli"]) {
        mkdirSync(join(dirname(home), "transpiler", "packages", name), {recursive: true});
        writeFileSync(join(dirname(home), "transpiler", "packages", name, "package.json"),
          `${JSON.stringify({name: `fixture-transpiler-${name}`, version: "0.0.0", license: "MIT"})}\n`);
        writeFileSync(join(dirname(home), "transpiler", "packages", name, "LICENSE"),
          "MIT License\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software.\n");
      }
    });
    after(function () {
      rmSync(dirname(home), {recursive: true, force: true});
    });

    it("the preview refuses it before anything is staged, and stages gen/ never", function () {
      this.timeout(120000);
      generationManifest(previewHome, ["src", "gen/hana-src/000-osd-tmp-zosd-h4-a"]);
      const refused = runInTree(previewHome, join(previewHome, "scripts", "build-preview.mjs"));
      expect(refused.status, refused.stderr).to.not.equal(0);
      expect(refused.stderr).to.match(/gen\/hana-src\/000-osd-tmp-zosd-h4-a/);
      expect(refused.stderr, "the tenant's sources are private").to.match(/private/);
      expect(existsSync(join(previewHome, "web", "generated")), "the refusal stages nothing").to.equal(false);
      // a clean record publishes, whatever the stale folders on disk say
      generationManifest(previewHome, ["src", "gen"]);
      const clean = runInTree(previewHome, join(previewHome, "scripts", "build-preview.mjs"));
      expect(clean.status, clean.stderr).to.equal(0);
      const staged = readdirSync(join(previewHome, "web", "generated"));
      expect(staged, "the generated modules are written").to.include("seed.mjs");
      expect(staged, "the preview stages web/generated only, no gen/ tree").to.not.include("gen");
      for (const file of staged) {
        expect(readFileSync(join(previewHome, "web", "generated", file), "utf8"),
          `${file} carries no tenant object`).to.not.match(/zosd_h4_|hana-src|hana-ddic/);
      }
      expect(existsSync(join(previewHome, "build", "preview")), "GENERATE_ONLY stops before the bundle").to.equal(false);
    });

    it("the docker image refuses it before anything is copied, and its gen/ copy drops the private folders", function () {
      this.timeout(120000);
      const out = join(home, "image-out");
      generationManifest(home, ["src", "gen/hana-src/000-osd-tmp-zosd-h4-a", "gen/hana-ddic"]);
      const refused = runInTree(home, join(home, "docker", "image", "assemble.mjs"), [out]);
      expect(refused.status, refused.stderr).to.not.equal(0);
      expect(refused.stderr).to.match(/gen\/hana-src\/000-osd-tmp-zosd-h4-a/);
      expect(existsSync(out), "the refusal copies nothing").to.equal(false);
      generationManifest(home, ["src", "gen"]);
      const clean = runInTree(home, join(home, "docker", "image", "assemble.mjs"), [out]);
      expect(clean.status, clean.stderr).to.equal(0);
      stagesNoPrivateGen(join("image-out", "gen"));
      expect(existsSync(join(out, "build", "by-input", GENERATION.get(home), "manifest.json")),
        "the guarded generation itself is copied").to.equal(true);
      // the build context names the private folders, so a widened allowlist
      // cannot carry them in
      const ignore = readFileSync(new URL("../docker/image/Dockerfile.dockerignore", import.meta.url), "utf8");
      expect(ignore, "the context excludes the tenant's sources").to.match(/^gen\/hana-src$/m);
      expect(ignore, "and the generated DDIC beside them").to.match(/^gen\/hana-ddic$/m);
      expect(ignore, "and the closure walk's files beside them").to.match(/^gen\/hana-closure$/m);
    });

    it("the download bundle refuses it before staging, and the staged gen/ drops the private folders", async function () {
      this.timeout(120000);
      const {main} = await import(new URL("../scripts/make-download-bundle.mjs", import.meta.url).href);
      generationManifest(home, ["src", "gen", "gen/hana-ddic"]);
      freshProbe();
      const refused = await withTreeEnv(() => main(["linux-amd64"], {root: home})).then(() => undefined, (error) => error);
      expect(refused, "a generation built with a private layer must refuse").to.be.an("error");
      expect(refused.message).to.match(/gen\/hana-ddic/);
      expect(refused.message, "the tenant's content is private").to.match(/private/);
      expect(readdirSync(join(home, ".local", "release-probe", "linux-amd64")), "the refusal stages nothing")
        .to.deep.equal(["osd"]);
      generationManifest(home, ["src", "gen"]);
      freshProbe();
      // the binary the bundle ships carries its public record, as
      // build-binary stamps it from the tree's live generation
      withTreeEnv(() => writePublicArtefact(join(home, ".local", "release-probe", "linux-amd64", "osd"), home));
      const archive = await withTreeEnv(() => main(["linux-amd64"], {root: home}));
      expect(archive, "the bundle is written").to.match(/osd-bun-.*\.tar\.gz$/);
      const stage = readdirSync(join(home, ".local", "release-probe", "linux-amd64")).find((e) => e.startsWith("osd-bun-"));
      stagesNoPrivateGen(join(".local", "release-probe", "linux-amd64", stage, "gen"));
    });

    it("the release directory refuses it before anything is copied, and its tree drops the private folders", async function () {
      this.timeout(120000);
      const {main} = await import(new URL("../scripts/make-release.mjs", import.meta.url).href);
      const out = join(home, "release-out");
      generationManifest(home, ["src", "gen/hana-ddic"]);
      const refused = await withTreeEnv(() => main([out], {root: home})).then(() => undefined, (error) => error);
      expect(refused, "a generation built with a private layer must refuse").to.be.an("error");
      expect(refused.message).to.match(/gen\/hana-ddic/);
      expect(existsSync(out), "the refusal copies nothing, not even an empty out").to.equal(false);
      generationManifest(home, ["src", "gen"]);
      await withTreeEnv(() => main([out], {root: home}));
      stagesNoPrivateGen(join("release-out", "gen"));
      expect(existsSync(join(out, "src")), "the tree itself is copied").to.equal(true);
      expect(existsSync(join(out, "build", "by-input", GENERATION.get(home), "manifest.json")),
        "the guarded generation is copied").to.equal(true);
    });
  });
});
