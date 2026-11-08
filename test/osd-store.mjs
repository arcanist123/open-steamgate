import fs from "node:fs";
import {syncBuiltinESMExports} from "node:module";
import {expect} from "chai";
import {activeFixture} from "./helpers/source-snapshot.mjs";
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {NotFound, ObjectStore, ReadOnly, fileOf, nameOf} from "../tools/osd-store.mjs";
import {rootPackage} from "../tools/osd-source-layers.mjs";

// The object store behind the ADT façade: what a client reads, writes,
// checks and activates when it talks to OSD. The repository itself is the
// content, and the open-abap clones beside it are the standard objects, so
// the store is tested against what is actually on disk.
describe("tools/osd-store: the objects of the local system", function () {
  // a check parses the whole system, and the system grows when a repository
  // is imported into local/
  this.timeout(120000);
  const store = new ObjectStore();

  it("indexes this repository and the libraries beside it", () => {
    const all = store.list();
    expect(all.length).to.be.greaterThan(500);
    const types = new Set(all.map((o) => o.type));
    for (const type of ["CLAS", "INTF", "TABL", "DTEL", "DDLS"]) {
      expect(types, type).to.include(type);
    }
    // ours is writable, a library's is not
    expect(store.find("CLAS", "ZCL_STG_SEGW_EXPORT")).to.include({writable: true, library: false});
    expect(store.find("CLAS", "CL_ABAP_ZIP")).to.include({writable: false, library: true});
  });

  it("reads the source of a class, ours and the library's", () => {
    expect(store.read("CLAS", "ZCL_STG_SEGW_EXPORT").source).to.contain("CLASS zcl_stg_segw_export DEFINITION");
    expect(store.read("CLAS", "CL_ABAP_ZIP").source).to.contain("CLASS cl_abap_zip DEFINITION");
    // the name arrives in any case
    expect(store.read("CLAS", "zcl_stg_segw_export").source).to.contain("zcl_stg_segw_export");
  });

  it("reads the includes of a class, and an absent one is empty rather than an error", () => {
    const tests = store.read("CLAS", "ZCL_STG_SEGW_TEST", "testclasses");
    expect(tests.source).to.contain("CLASS ltcl_");
    const macros = store.read("CLAS", "ZCL_STG_SEGW_EXPORT", "macros");
    expect(macros).to.include({empty: true});
    expect(macros.source).to.equal("");
  });

  it("reads the parts of a function group by their program names", () => {
    const main = store.read("FUGR", "ZOSD_TEST_FG", "SAPLZOSD_TEST_FG");
    expect(main.source).to.contain("INCLUDE lzosd_test_fgtop.");
    expect(main.file).to.equal("src/zosd_test/src/zosd_test_fg.fugr.saplzosd_test_fg.abap");
    expect(store.read("FUGR", "ZOSD_TEST_FG", "z_osd_test_status_text").source).to.contain("FUNCTION z_osd_test_status_text.");
    expect(store.read("FUGR", "ZOSD_TEST_FG").source).to.contain("<FUNCNAME>Z_OSD_TEST_STATUS_TEXT</FUNCNAME>");
    expect(() => store.read("FUGR", "ZOSD_TEST_FG", "LZOSD_TEST_FGF01")).to.throw(NotFound, "FUGR ZOSD_TEST_FG include LZOSD_TEST_FGF01 does not exist");
  });

  it("an object that is not there says so, by type and name", () => {
    expect(() => store.read("CLAS", "ZCL_NOBODY_HOME")).to.throw(NotFound, "CLAS ZCL_NOBODY_HOME does not exist");
    expect(store.exists("CLAS", "ZCL_NOBODY_HOME")).to.equal(false);
  });

  it("tells a structure from a table, which abapGit writes into the same file", () => {
    // IHTTPNVP is INTTAB, so ADT would ask for it under ddic/structures
    expect(store.find("STRU", "IHTTPNVP")).to.not.equal(undefined);
    expect(store.find("TABL", "IHTTPNVP")).to.not.equal(undefined);
    // ZSTG_DEMO is a transparent table, so it is not a structure
    expect(store.find("TABL", "ZSTG_DEMO")).to.not.equal(undefined);
    expect(store.find("STRU", "ZSTG_DEMO")).to.equal(undefined);
  });

  it("finds objects by name and by what is in the source", () => {
    const byName = store.search("SEGW_GEN");
    expect(byName.map((o) => o.name)).to.include("ZCL_STG_SEGW_GEN");
    const bySource = store.search("maxEditMode", {source: true, type: "CLAS", max: 50});
    expect(bySource.map((o) => o.name)).to.include("ZCL_STG_SEGW_GEN_DPC");
  });

  it("checks an object against the whole registry, not against itself", () => {
    const good = store.check("CLAS", "ZCL_STG_SEGW_EXPORT");
    expect(good.issues, JSON.stringify(good.issues.slice(0, 2))).to.deep.equal([]);
    const active = store.activate("CLAS", "ZCL_STG_SEGW_GEN");
    expect(active.active).to.equal(true);
  });

  it("an include activates as itself: the registry files it as a program, and the check follows it there", () => {
    // INCL and PROG share a file and abaplint knows only PROG; asking the
    // registry for INCL found nothing and called every clean include broken
    const verdict = store.activate("INCL", "ZOSD_TEST_DEMO_INC");
    expect(verdict.issues, JSON.stringify(verdict.issues)).to.deep.equal([]);
    expect(verdict.active).to.equal(true);
  });

  it("a dependent of a kind the store does not index is checked, not thrown over", () => {
    // the SEGW project (IWPR) names the MPC_EXT it maps; it is in the
    // registry and not in TYPES, so the dependents walk used to reach
    // find() and 404 the whole activation with "IWPR ... does not exist"
    const kinds = store.dependents("CLAS", "ZCL_ZOSD_TEST_MPC_EXT").map((d) => d.type);
    expect(kinds).to.include("IWPR");
    expect(store.activate("CLAS", "ZCL_ZOSD_TEST_MPC_EXT").active).to.equal(true);
  });

  it("packages come from the tree, and every parent is one a folder really has", () => {
    const all = store.packages();
    expect(all.length).to.be.greaterThan(50);
    const names = new Set(all.map((p) => p.name));
    // a root has no parent, everyone else has one that exists
    for (const node of all) {
      if (node.parent !== undefined) {
        expect(names, `${node.name} -> ${node.parent}`).to.include(node.parent);
      }
    }
    expect(all.filter((p) => p.parent === undefined).map((p) => p.name)).to.include.members(["$STG", "$OPEN_ABAP_CORE", "$ZOSD_TEST"]);
    // the name is the chain joined, so an underscore in a folder invents no
    // parent: src/demo_sadl sits under $STG, not under $STG_DEMO, and the
    // library roots do not sprout a $OPEN above them
    expect(names).to.not.include("$OPEN");
    expect(names).to.not.include("$EXPRESS_ICF");
    expect(all.find((p) => p.name === "$STG_DEMO_SADL").parent).to.equal("$STG");
    expect(all.find((p) => p.name === "$STG_SEGW_DDIC").parent).to.equal("$STG_SEGW");
  });

  it("the tree has a root, which is what a client opens first", () => {
    // Alice's VS Code said "Unable to resolve nonexistent file
    // 'adt://osd/System Library'": the client asks for the node above every
    // package and OSD had nothing to answer with
    const tops = store.rootPackages();
    expect(tops.length).to.be.greaterThan(3);
    // $OSD is the root of what was imported into local/; since 2026-09-16
    // that content travels as packs and local/ may be empty, so only the
    // tree's own roots are promised here
    expect(tops.map((p) => p.name)).to.include.members(["$STG", "$ZOSD_TEST"]);
    for (const node of tops) {
      expect(node.parent, node.name).to.equal(undefined);
    }

    // and the same thing by the name a client uses for it: no package
    const root = store.package("");
    expect(root.name).to.equal("");
    expect(root.subpackages).to.deep.equal(tops.map((p) => p.name));
    expect(root.objects).to.deep.equal([]);
    // a name that is really missing is still missing
    expect(() => store.package("$NOSUCH")).to.throw(NotFound);
  });

  it("a package holds its objects and names its subpackages", () => {
    const segw = store.package("$STG_SEGW");
    expect(segw.subpackages).to.deep.equal(["$STG_SEGW_DDIC"]);
    expect(segw.objects.map((o) => o.name)).to.include("ZCL_STG_SEGW_GEN");
    // an object of the subpackage is not in the parent's list
    expect(segw.objects.map((o) => o.name)).to.not.include("ZSTG_SBD_PR");
    expect(store.package("$STG_SEGW_DDIC").objects.map((o) => o.name)).to.include("ZSTG_SBD_PR");
    expect(store.package("$stg_segw").name).to.equal("$STG_SEGW");
    expect(() => store.package("$NOBODY")).to.throw(NotFound, "DEVC $NOBODY");
  });

  it("an object knows its package, and a library package says so", () => {
    expect(store.find("CLAS", "ZCL_STG_SEGW_GEN").package).to.equal("$STG_SEGW");
    expect(store.find("CLAS", "CL_ABAP_ZIP").package).to.contain("$OPEN_ABAP_CORE");
    expect(store.package("$OPEN_ABAP_CORE").library).to.equal(true);
    expect(store.package("$STG_SEGW").library).to.equal(false);
    // every object of the system is in exactly one package
    const counted = store.packages().reduce((n, p) => n + p.objects, 0);
    // every entry is counted in exactly one package, except a root
    // package's own object: the package is not something inside itself
    const rootsWithOwnObject = store.rootPackages().filter((r) => store.find("DEVC", r.name) !== undefined).length;
    expect(counted).to.equal(store.list().length - rootsWithOwnObject);
  });

  it("abapGit's file names and object names convert both ways", () => {
    expect(fileOf("/DEMO/ZREPORT")).to.equal("#demo#zreport");
    expect(nameOf("#demo#zreport")).to.equal("/DEMO/ZREPORT");
    expect(nameOf(fileOf("ZCL_X"))).to.equal("ZCL_X");
  });
});

// writing happens in a temporary system, so a test never touches the
// repository it runs in
describe("tools/osd-store: writing to the local system", function () {
  // one of these waits for a transpile, which is seconds rather than the
  // two mocha allows by default. It passed until now because the transpile
  // failed fast in a temporary root, which is luck rather than a test.
  this.timeout(120000);

  let root;
  let store;

  const CLASS = `CLASS zcl_osd_probe DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_probe IMPLEMENTATION.
  METHOD run.
    rv_text = 'hello'.
  ENDMETHOD.
ENDCLASS.
`;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "osd-"));
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "abaplint.jsonc"), readFileSync("abaplint.jsonc", "utf8"));
    store = new ObjectStore({root, libs: []});
  });

  afterEach(() => {
    rmSync(root, {recursive: true, force: true});
  });

  it("a new object lands as a file and reads back", () => {
    const written = store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    expect(written.file).to.equal("src/osd/zcl_osd_probe.clas.abap");
    expect(readFileSync(join(root, written.file), "utf8")).to.equal(CLASS);
    expect(store.read("CLAS", "ZCL_OSD_PROBE").source).to.equal(CLASS);
    expect(store.list("CLAS").map((o) => o.name)).to.deep.equal(["ZCL_OSD_PROBE"]);
  });

  it("an include name the table does not own is refused, never written into the main file", () => {
    const written = store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    // "constructor" and "toString" are properties of every object: a plain
    // lookup found Object there and wrote over the class (critic on #294)
    for (const include of ["constructor", "toString"]) {
      expect(() => store.write("CLAS", "ZCL_OSD_PROBE", "* not a class\n", include)).to.throw(/class include/);
      expect(() => store.read("CLAS", "ZCL_OSD_PROBE", include)).to.throw();
    }
    expect(readFileSync(join(root, written.file), "utf8")).to.equal(CLASS);
  });

  it("a new object may name a writable layer root", () => {
    mkdirSync(join(root, "scratch", "src"), {recursive: true});
    const layered = new ObjectStore({root, libs: [], roots: [
      {path: "src", writable: true, library: false},
      {path: "scratch/src", writable: true, library: false, pack: "notebook-scratch", package: "$NOTEBOOK_SCRATCH"},
    ]});

    const written = layered.write("CLAS", "ZCL_OSD_PROBE", CLASS, "main", {root: "scratch/src"});

    expect(written.file).to.equal("scratch/src/osd/zcl_osd_probe.clas.abap");
    expect(layered.find("CLAS", "ZCL_OSD_PROBE").root).to.equal("scratch/src");
    expect(readFileSync(join(root, written.file), "utf8")).to.equal(CLASS);
    expect(existsSync(join(root, "src", "osd", "zcl_osd_probe.clas.abap"))).to.equal(false);
    expect(() => layered.write("CLAS", "ZCL_OSD_OTHER", CLASS, "main", {root: "missing/src"}))
      .to.throw(/not a writable object-store root/);
    expect(() => layered.write("CLAS", "ZCL_OSD_PROBE", CLASS, "main", {root: "src"}))
      .to.throw(/already belongs to scratch\/src/);
  });

  it("a new object joins the package tree without rebuilding the index", () => {
    // $TMP is there before anything is (tools/osd-tmp.mjs), and nothing else
    expect(store.packages().map((pkg) => pkg.name)).to.deep.equal(["$TMP"]);

    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);

    const packages = store.packages();
    expect(packages.map((pkg) => pkg.name)).to.deep.equal(["$STG", "$STG_OSD", "$TMP"]);
    expect(packages.find((pkg) => pkg.name === "$STG_OSD").objects).to.equal(1);
    expect(store.rootPackages().map((pkg) => pkg.name)).to.deep.equal(["$STG", "$TMP"]);
    expect(store.package("$STG_OSD").objects).to.deep.include({
      type: "CLAS",
      name: "ZCL_OSD_PROBE",
      library: false,
      writable: true,
      // just written, and so not activated yet
      version: "inactive",
    });
  });

  it("writing again replaces the source, and the includes go beside it", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS.replace("hello", "goodbye"));
    expect(store.read("CLAS", "ZCL_OSD_PROBE").source).to.contain("goodbye");
    store.write("CLAS", "ZCL_OSD_PROBE", "CLASS ltcl DEFINITION FOR TESTING.\nENDCLASS.\n", "testclasses");
    expect(store.read("CLAS", "ZCL_OSD_PROBE", "testclasses").source).to.contain("ltcl");
    expect(store.read("CLAS", "ZCL_OSD_PROBE").source).to.contain("goodbye");
  });

  it("a created object lands in the folder of its package, with the abapGit header beside it", () => {
    // a package is a folder: the parent's header names the folder
    mkdirSync(join(root, "src", "demo"), {recursive: true});
    writeFileSync(join(root, "src", "demo", "package.devc.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DEVC" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DEVC><CTEXT>demo</CTEXT></DEVC></asx:values></asx:abap>
</abapGit>
`);
    const made = store.create("CLAS", "zcl_osd_made", {description: "made by a test", package: "$STG_DEMO"});
    expect(made.file).to.equal("src/demo/zcl_osd_made.clas.abap");
    expect(made.package).to.equal("$STG_DEMO");
    expect(made.version, "a created object is inactive until activated").to.equal("inactive");
    expect(existsSync(join(root, "src/demo/zcl_osd_made.clas.xml"))).to.equal(true);
    expect(readFileSync(join(root, "src/demo/zcl_osd_made.clas.xml"), "utf8")).to.contain("<DESCRIPT>made by a test</DESCRIPT>");
    expect(store.read("CLAS", "ZCL_OSD_MADE").source).to.contain("CLASS zcl_osd_made DEFINITION PUBLIC");
    expect(store.package("$STG_DEMO").objects.map((o) => o.name)).to.include("ZCL_OSD_MADE");
    // the skeleton checks clean, so the next save is the first real source
    expect(store.check("CLAS", "ZCL_OSD_MADE").issues).to.deep.equal([]);

    // twice is a conflict, a package that is not there is not found
    expect(() => store.create("CLAS", "ZCL_OSD_MADE", {package: "$STG_DEMO"})).to.throw(/already exists/);
    expect(() => store.create("INTF", "ZIF_X", {package: "$NOWHERE"})).to.throw(/does not exist/);
    expect(() => store.create("FUGR", "ZFG", {package: "$STG_DEMO"})).to.throw(/not supported/);

    // a package is a folder under its parent's, named after its last link
    const sub = store.create("DEVC", "$STG_DEMO_SUB", {description: "a subpackage", package: "$STG_DEMO"});
    expect(sub.file).to.equal("src/demo/sub/package.devc.xml");
    expect(store.packages().map((p) => p.name)).to.include("$STG_DEMO_SUB");
    expect(() => store.create("DEVC", "$OTHER", {package: "$STG_DEMO"})).to.throw(/named \$STG_DEMO_<FOLDER>/);
    const prog = store.create("PROG", "ZOSD_MADE_PROG", {description: "a report", package: "$STG_DEMO_SUB"});
    expect(prog.file).to.equal("src/demo/sub/zosd_made_prog.prog.abap");
    expect(readFileSync(join(root, "src/demo/sub/zosd_made_prog.prog.xml"), "utf8")).to.contain("<ENTRY>a report</ENTRY>");
    const incl = store.create("INCL", "ZOSD_MADE_INC", {package: "$STG_DEMO_SUB"});
    expect(readFileSync(join(root, incl.file.replace(/\.abap$/, ".xml")), "utf8")).to.contain("<SUBC>I</SUBC>");
    expect(store.find("INCL", "ZOSD_MADE_INC")).to.not.equal(undefined);
  });

  it("a deleted object takes its header with it, and a package goes only once it is empty", () => {
    mkdirSync(join(root, "src", "demo"), {recursive: true});
    writeFileSync(join(root, "src", "demo", "package.devc.xml"), "<abapGit><asx:abap><asx:values><DEVC><CTEXT>demo</CTEXT></DEVC></asx:values></asx:abap></abapGit>");
    const sub = store.create("DEVC", "$STG_DEMO_SUB", {package: "$STG_DEMO"});
    const made = store.create("CLAS", "ZCL_OSD_GONE", {package: "$STG_DEMO_SUB"});
    expect(() => store.delete("DEVC", "$STG_DEMO_SUB")).to.throw(/still holds 1 object/);
    expect(store.delete("CLAS", "ZCL_OSD_GONE")).to.deep.include({deleted: true});
    expect(existsSync(join(root, made.file))).to.equal(false);
    expect(existsSync(join(root, made.file.replace(/\.abap$/, ".xml"))), "the header went too").to.equal(false);
    expect(store.find("CLAS", "ZCL_OSD_GONE")).to.equal(undefined);
    expect(store.delete("DEVC", "$STG_DEMO_SUB")).to.deep.include({deleted: true});
    expect(existsSync(join(root, sub.file))).to.equal(false);
    expect(() => store.delete("CLAS", "ZCL_OSD_GONE")).to.throw(/does not exist/);
  });

  it("a file that appears on disk is an object here, once the store watches", async () => {
    store.watch();
    try {
      expect(store.find("CLAS", "ZCL_OSD_FROM_DISK")).to.equal(undefined);
      mkdirSync(join(root, "src", "osd"), {recursive: true});
      writeFileSync(join(root, "src/osd/zcl_osd_from_disk.clas.abap"), CLASS.replaceAll("zcl_osd_probe", "zcl_osd_from_disk"));
      // the watcher is an event away, not a call away
      for (let i = 0; i < 50 && store.find("CLAS", "ZCL_OSD_FROM_DISK") === undefined; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(store.find("CLAS", "ZCL_OSD_FROM_DISK")?.file).to.equal("src/osd/zcl_osd_from_disk.clas.abap");
      expect(store.check("CLAS", "ZCL_OSD_FROM_DISK").issues, "the registry saw it too").to.deep.equal([]);
      // and a change on disk is the source the next read gets, and the registry checks
      writeFileSync(join(root, "src/osd/zcl_osd_from_disk.clas.abap"), "CLASS zcl_osd_from_disk DEFINITION PUBLIC.\nENDCLASS.\nCLASS zcl_osd_from_disk IMPLEMENTATION.\n  METHOD nope.\n  ENDMETHOD.\nENDCLASS.\n");
      for (let i = 0; i < 50 && store.check("CLAS", "ZCL_OSD_FROM_DISK").issues.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      expect(store.check("CLAS", "ZCL_OSD_FROM_DISK").issues.length, "a broken edit on disk is a broken object here").to.be.greaterThan(0);
    } finally {
      store.unwatch();
    }
  });

  it("a namespaced name becomes an abapGit file name", () => {
    const written = store.write("PROG", "/DEMO/ZREPORT", "REPORT zreport.\nWRITE 'x'.\n");
    expect(written.file).to.equal("src/osd/#demo#zreport.prog.abap");
    expect(store.read("PROG", "/demo/zreport").source).to.contain("REPORT");
  });

  it("deleting takes the object and its includes", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    store.write("CLAS", "ZCL_OSD_PROBE", "CLASS ltcl DEFINITION FOR TESTING.\nENDCLASS.\n", "testclasses");
    expect(store.delete("CLAS", "ZCL_OSD_PROBE")).to.include({deleted: true});
    expect(store.exists("CLAS", "ZCL_OSD_PROBE")).to.equal(false);
    expect(() => store.read("CLAS", "ZCL_OSD_PROBE")).to.throw(NotFound);
  });

  it("a library object cannot be written or deleted", () => {
    // Keep even a regressed write guard from planting a writable shadow in
    // the checkout and poisoning subsequent repository/library tests.
    const libraryFile = join(root, "lib", "cl_abap_zip.clas.abap");
    const source = readFileSync(new ObjectStore().find("CLAS", "CL_ABAP_ZIP").file, "utf8");
    mkdirSync(join(root, "lib"));
    writeFileSync(libraryFile, source);
    const withLibs = new ObjectStore({root, libs: ["lib"]});
    expect(withLibs.find("CLAS", "CL_ABAP_ZIP")).to.include({root: "lib", writable: false, library: true});
    expect(() => withLibs.write("CLAS", "CL_ABAP_ZIP", "nope")).to.throw(ReadOnly);
    expect(() => withLibs.delete("CLAS", "CL_ABAP_ZIP")).to.throw(ReadOnly);
    expect(readFileSync(libraryFile, "utf8")).to.equal(source);
    expect(existsSync(join(root, "src", "osd", "cl_abap_zip.clas.abap"))).to.equal(false);
  });

  it("the transpile behind an activation is a separate call, so the verdict is fast", async () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    const before = Date.now();
    const verdict = store.activate("CLAS", "ZCL_OSD_PROBE");
    expect(Date.now() - before, "the verdict waits for no transpile").to.be.lessThan(9000);
    expect(verdict.active).to.equal(true);
    // the same promise while it runs, so two activations do not transpile twice
    const first = store.transpile();
    expect(store.transpile()).to.equal(first);
    expect(await first).to.include.keys(["ok", "ms", "objects"]);
  });

  it("keeps a saved version inactive until publication succeeds", async () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    const checked = store.activate("CLAS", "ZCL_OSD_PROBE");
    expect(checked.active).to.equal(true);
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_PROBE")).version).to.equal("inactive");

    // A failed build must not commit the check verdict as an activation.
    store.publish = async () => ({ok: false, transpile: {error: "ENOSPC"}});
    expect((await store.publish()).ok).to.equal(false);
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_PROBE")).version).to.equal("inactive");

    // If another save arrives during publication, the old verdict must not
    // activate the newer text, even when the new text is equally valid.
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS.replace("'hello'", "'newer'"));
    expect(store.completeActivation(checked)).to.equal(false);
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_PROBE")).version).to.equal("inactive");
    // Model successful publication, including its retained source proof.
    activeFixture(root);
    expect(store.completeActivation(store.activate("CLAS", "ZCL_OSD_PROBE"))).to.equal(true);
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_PROBE")).version).to.equal("active");
  });

  it("completes a multi-object activation all at once", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    store.write("CLAS", "ZCL_OSD_OTHER", CLASS.replaceAll("zcl_osd_probe", "zcl_osd_other"));
    const checked = [store.activate("CLAS", "ZCL_OSD_PROBE"), store.activate("CLAS", "ZCL_OSD_OTHER")];
    store.write("CLAS", "ZCL_OSD_OTHER", CLASS.replaceAll("zcl_osd_probe", "zcl_osd_other").replace("'hello'", "'newer'"));
    expect(store.completeActivations(checked)).to.equal(false);
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_PROBE")).version).to.equal("inactive");
    expect(store.stateOf(store.find("CLAS", "ZCL_OSD_OTHER")).version).to.equal("inactive");
  });

  it("activation holds or fails on the syntax check, with the line and the rule", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    expect(store.activate("CLAS", "ZCL_OSD_PROBE").active).to.equal(true);

    store.write("CLAS", "ZCL_OSD_PROBE", CLASS.replace("rv_text = 'hello'.", "rv_text = lv_missing."));
    const broken = store.activate("CLAS", "ZCL_OSD_PROBE");
    expect(broken.active).to.equal(false);
    expect(broken.issues.length).to.be.greaterThan(0);
    expect(broken.issues[0]).to.include.keys(["severity", "rule", "message", "file", "line", "column"]);
    expect(broken.issues[0].message).to.contain("lv_missing");
    expect(broken.issues[0].line).to.be.greaterThan(1);
  });

  it("a write updates the kept parse and invalidates cached callers", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    store.write("CLAS", "ZCL_OSD_PROBE_CALLER", `CLASS zcl_osd_probe_caller DEFINITION PUBLIC.
PUBLIC SECTION. CLASS-METHODS run. ENDCLASS.
CLASS zcl_osd_probe_caller IMPLEMENTATION.
METHOD run. DATA probe TYPE REF TO zcl_osd_probe. CREATE OBJECT probe. probe->run( ). ENDMETHOD. ENDCLASS.`);
    expect(store.completeActivation(store.activate("CLAS", "ZCL_OSD_PROBE_CALLER", {activating: ["CLAS ZCL_OSD_PROBE"]}))).to.equal(true);
    const registry = store.registry();
    expect(store.check("CLAS", "ZCL_OSD_PROBE_CALLER").issues).to.deep.equal([]);
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS.replaceAll("run", "renamed"));
    const refused = store.activate("CLAS", "ZCL_OSD_PROBE");
    expect(store.registry(), "the hot path keeps the registry").to.equal(registry);
    expect(refused.active).to.equal(false);
    expect(refused.dependents.map(d => d.name)).to.include("ZCL_OSD_PROBE_CALLER");
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    expect(store.activate("CLAS", "ZCL_OSD_PROBE").active).to.equal(true);
    expect(store.check("CLAS", "ZCL_OSD_PROBE_CALLER").issues).to.deep.equal([]);
    store.delete("CLAS", "ZCL_OSD_PROBE_CALLER");
  });

  it("rebuilding the index drops the parse, because files changed under it", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    store.registry();
    expect(store.parsed).to.not.equal(undefined);
    // what an import does: many files at once, none of them through write()
    store.build();
    expect(store.parsed, "a parse that predates the objects it would check").to.equal(undefined);
  });

  it("a check can be given the source, and the file on disk is not touched", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    const stored = store.read("CLAS", "ZCL_OSD_PROBE").source;

    const asked = store.check("CLAS", "ZCL_OSD_PROBE", {source: CLASS.replace("rv_text = 'hello'.", "rv_text = lv_missing.")});
    expect(asked.issues.length).to.be.greaterThan(0);
    expect(asked.issues[0]).to.include.keys(["severity", "rule", "message", "file", "line", "column"]);
    expect(asked.issues[0]).to.not.have.property("endLine");
    expect(asked.issues[0]).to.not.have.property("endColumn");
    expect(JSON.stringify(asked)).to.not.contain("\"endLine\"").and.not.contain("\"endColumn\"");
    expect(asked.issues[0].message).to.contain("lv_missing");

    // what was asked about is gone; what is stored is what answers again
    expect(store.read("CLAS", "ZCL_OSD_PROBE").source).to.equal(stored);
    expect(store.check("CLAS", "ZCL_OSD_PROBE").issues).to.deep.equal([]);
  });

  it("discovers an abapGit root package in lexical order", () => {
    const tree = mkdtempSync(join(tmpdir(), "osd-root-package-"));
    const originalRead = fs.readdirSync;
    try {
      writeFileSync(join(tree, "z_created_first.devc.xml"), "");
      writeFileSync(join(tree, "a_created_second.devc.xml"), "");
      // Force the platform-independent reverse order that the old code used.
      fs.readdirSync = (folder, ...args) => folder === tree
        ? ["z_created_first.devc.xml", "a_created_second.devc.xml"]
        : originalRead(folder, ...args);
      syncBuiltinESMExports();
      expect(rootPackage(tree, "$FALLBACK")).to.equal("A_CREATED_SECOND");
    } finally {
      fs.readdirSync = originalRead;
      syncBuiltinESMExports();
      rmSync(tree, {recursive: true, force: true});
    }
  });

  it("source in the request goes to the include the caller named", () => {
    store.write("CLAS", "ZCL_OSD_PROBE", CLASS);
    const answer = store.check("CLAS", "ZCL_OSD_PROBE", {include: "testclasses", source: "this is not ABAP"});
    expect(answer.issues.length).to.be.greaterThan(0);
    expect(answer.issues[0].file).to.contain(".clas.testclasses.abap");
    expect(() => store.read("CLAS", "ZCL_OSD_PROBE", "testclasses")).to.not.throw();
    expect(store.read("CLAS", "ZCL_OSD_PROBE", "testclasses").empty).to.equal(true);
  });

  it("an object that is not there yet can be checked, which is what a client asks before it creates one", () => {
    const answer = store.check("CLAS", "ZCL_OSD_UNBORN", {source: CLASS.replaceAll("zcl_osd_probe", "zcl_osd_unborn")});
    expect(answer).to.include({type: "CLAS", name: "ZCL_OSD_UNBORN"});
    expect(answer.issues, JSON.stringify(answer.issues)).to.deep.equal([]);
    // nothing was created by asking
    expect(store.exists("CLAS", "ZCL_OSD_UNBORN")).to.equal(false);
    expect(() => store.check("CLAS", "ZCL_OSD_UNBORN")).to.throw(NotFound);
  });


  // An editor on Windows sends CRLF. Stored as it came, a saved comment
  // became a diff of every line in the file, with the comment nowhere in it.
  it("stores what an editor saves with the repository's line endings", async () => {
    const {mkdtempSync, mkdirSync, copyFileSync, readFileSync} = await import("node:fs");
    const {join} = await import("node:path");
    const {tmpdir} = await import("node:os");
    const root = mkdtempSync(join(tmpdir(), "osd-crlf-"));
    mkdirSync(join(root, "osd"));
    copyFileSync("abaplint.jsonc", join(root, "abaplint.jsonc"));
    const store = new ObjectStore({root});
    store.write("PROG", "ZOSD_CRLF", "REPORT zosd_crlf.\r\n* typed on Windows\r\nWRITE 1.\r\n");
    const onDisk = readFileSync(join(root, store.find("PROG", "ZOSD_CRLF").file), "utf8");
    expect(onDisk).to.equal("REPORT zosd_crlf.\n* typed on Windows\nWRITE 1.\n");
    expect(store.read("PROG", "ZOSD_CRLF").source).to.not.contain("\r");
  });
  // The roots are the transpiler's inputs, in the transpiler's order, so the
  // object ADT opens is the object that runs. Before 2026-09-16 the store
  // walked src, local, test, gen and the transpiler src, test, gen, local/*,
  // and local/ as a whole put 677 objects in the tree that no build had.
  describe("roots are the layers of abap_transpile.json", () => {
    let tree;
    const write = (file, text = "") => {
      mkdirSync(join(tree, file, ".."), {recursive: true});
      writeFileSync(join(tree, file), text);
    };
    const CLASS = (name, method) => `CLASS ${name} DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS ${method}.\nENDCLASS.\nCLASS ${name} IMPLEMENTATION.\n  METHOD ${method}.\n  ENDMETHOD.\nENDCLASS.\n`;

    beforeEach(() => {
      tree = mkdtempSync(join(tmpdir(), "osd-layers-"));
      writeFileSync(join(tree, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "gen", "local/used"]}, null, 2) + "\n");
      write("src/zcl_ours.clas.abap", CLASS("zcl_ours", "first"));
      write("gen/zcl_ours.clas.abap", CLASS("zcl_ours", "generated"));
      write("local/used/zcl_ours.clas.abap", CLASS("zcl_ours", "imported"));
      write("local/used/zcl_theirs.clas.abap", CLASS("zcl_theirs", "run"));
      write("local/shadow/zcl_shadow.clas.abap", CLASS("zcl_shadow", "run"));
    });

    afterEach(() => rmSync(tree, {recursive: true, force: true}));

    it("reads the inputs in their order, and the later one wins, as in the build", () => {
      const own = new ObjectStore({root: tree, libs: []});
      // and $TMP last, a root before anything is in it (tools/osd-tmp.mjs)
      expect(own.roots.map((r) => r.path)).to.deep.equal(["src", "gen", "local/used", "local/tmp"]);
      expect(own.find("CLAS", "ZCL_OURS")).to.include({file: "local/used/zcl_ours.clas.abap", writable: true, imported: true});
      expect(own.find("CLAS", "ZCL_THEIRS")).to.include({file: "local/used/zcl_theirs.clas.abap", writable: true, imported: true});
      expect(own.find("CLAS", "ZCL_SHADOW"), "a folder that is not an input is not the system").to.equal(undefined);
      // gen is generated, never edited; an imported repository is a package under $OSD
      expect(own.roots.find((r) => r.path === "gen").writable).to.equal(false);
      expect(own.find("CLAS", "ZCL_THEIRS").packages).to.deep.equal(["$OSD", "$OSD_USED"]);
      // a library is not a layer: it fills only what no root has
      const withLib = new ObjectStore({root: tree, roots: [{path: "src", writable: true, library: false}], libs: ["local/used"]});
      expect(withLib.find("CLAS", "ZCL_OURS")).to.include({file: "src/zcl_ours.clas.abap", library: false});
      expect(withLib.find("CLAS", "ZCL_THEIRS")).to.include({file: "local/used/zcl_theirs.clas.abap", library: true});
    });

    it("rereads the list when told, and keeps roots a caller chose", () => {
      const own = new ObjectStore({root: tree, libs: []});
      writeFileSync(join(tree, "abap_transpile.json"), JSON.stringify({input_folder: ["src", "gen", "local/used", "local/shadow"]}));
      expect(own.find("CLAS", "ZCL_SHADOW")).to.equal(undefined);
      own.reroot();
      expect(own.find("CLAS", "ZCL_SHADOW")).to.include({file: "local/shadow/zcl_shadow.clas.abap"});
      const chosen = new ObjectStore({root: tree, roots: [{path: "gen", writable: false, library: false}], libs: []});
      chosen.reroot();
      expect(chosen.roots.map((r) => r.path)).to.deep.equal(["gen", "local/tmp"]);
      expect(chosen.find("CLAS", "ZCL_OURS")).to.include({file: "gen/zcl_ours.clas.abap"});
    });

    it("a tree without the config uses the build's src fallback", () => {
      rmSync(join(tree, "abap_transpile.json"));
      const own = new ObjectStore({root: tree, libs: []});
      expect(own.roots.map((r) => r.path)).to.deep.equal(["src", "local/tmp"]);
      expect(own.find("CLAS", "ZCL_SHADOW")).to.equal(undefined);
    });
  });
});

// **The store's libraries are the build's libraries, or the check lies.**
//
// They were two lists: a hand-written DEFAULT_LIBS of three folders in
// tools/osd-store.mjs, and the six libs of abap_transpile.json. Everything
// compiled and ran -- only the syntax check was wrong, and in the direction
// that costs most: it told a person their class was broken. Alice found it on
// the deployed editor, 2026-09-19, on two classes at once, both of them
// extending a superclass that lives in a library the store could not see.
//
// So the assertion is the PROPERTY ("the same libraries") and the SYMPTOM
// ("this class checks clean"), not the list of folders, which would go stale
// with the next library added.
describe("the libraries the store reads are the ones the build reads", function () {
  this.timeout(180000);

  it("every lib of abap_transpile.json is a root of the store", async () => {
    const {libraryFiles} = await import("../tools/osd-inputs.mjs");
    const store = new ObjectStore({root: process.cwd()});
    const configured = libraryFiles(process.cwd()).map((l) => l.folder.replace(/^\//, ""));
    const seen = store.libs.map((l) => l.path);
    for (const folder of configured) {
      expect(seen.some((p) => p === folder || p.startsWith(folder + "/")),
        `${folder} is configured for the build and is not a library of the store: ${seen.join(", ")}`)
        .to.equal(true);
    }
    expect(configured.length, "the tree has libraries at all").to.be.greaterThan(3);
  });

  it("a class extending a library superclass is NOT reported broken", () => {
    // the exact symptom: `Super class "cl_apc_wsp_ext_stateful_base" not
    // found or contains errors`, where the superclass is in open-abap-apc --
    // configured for the build, missing from the store's old list
    const store = new ObjectStore({root: process.cwd()});
    const result = store.check("CLAS", "ZCL_APC_ZORK");
    expect(result.issues.map((i) => i.message).join(" | "),
      "the check sees the same system the build compiles").to.equal("");
  });

  it("and the file list per library is the build's own, not the whole folder", async () => {
    // abapGit is configured file by file (a dozen or so of its 592 objects);
    // walking its folder would put the rest into the registry, and then an
    // activation would check objects this system does not contain
    const {libraryFiles} = await import("../tools/osd-inputs.mjs");
    const abapgit = libraryFiles(process.cwd()).find((l) => l.folder.endsWith("/abapgit"));
    if (abapgit === undefined) return; // no clone here; the other two tests still hold
    const store = new ObjectStore({root: process.cwd()});
    const held = store.libs.filter((l) => l.path.includes("abapgit")).flatMap((l) => l.files ?? []);
    expect(held.length, "the configured files, not the folder").to.equal(abapgit.files.length);
    expect(held.length).to.be.lessThan(592);
  });
});

// A valid numeric include must participate in the same retained dependency index.
describe('ObjectStore numeric include invalidation', function () {
  let root, store;
  before(() => {
    root = mkdtempSync(join(tmpdir(), 'numeric-include-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'abap_transpile.json'), JSON.stringify({input_folder: 'src', libs: []}));
    writeFileSync(join(root, 'abaplint.jsonc'), JSON.stringify({syntax: {version: 'v702'}}));
    writeFileSync(join(root, 'src/123.prog.abap'), 'DATA gv_old TYPE i.\n');
    writeFileSync(join(root, 'src/zreader.prog.abap'), 'REPORT zreader.\nINCLUDE 123.\nSTART-OF-SELECTION.\ngv_old = 1.\n');
    activeFixture(root);
    store = new ObjectStore({root, libs: []});
  });
  after(() => rmSync(root, {recursive: true, force: true}));
  it('refuses a variable rename used by an active cached reader, then recovers', () => {
    expect(store.check('PROG', 'ZREADER').issues).to.deep.equal([]);
    const registry = store.registry();
    store.write('INCL', '123', 'DATA gv_new TYPE i.\n');
    const result = store.activate('INCL', '123');
    expect(store.registry()).to.equal(registry);
    expect(result.active).to.equal(false);
    expect(result.dependents.map(d => d.name)).to.include('ZREADER');
    expect(result.dependents.flatMap(d => d.issues).some(i => /gv_old/i.test(i.message))).to.equal(true);
    store.write('INCL', '123', 'DATA gv_old TYPE i.\n');
    expect(store.activate('INCL', '123').active).to.equal(true);
  });
});

describe('ObjectStore transitive activation checks', function () {
  let root, store;
  const base = 'CLASS zcl_base DEFINITION PUBLIC. PUBLIC SECTION. METHODS run IMPORTING iv_old TYPE i. ENDCLASS.\nCLASS zcl_base IMPLEMENTATION. METHOD run. ENDMETHOD. ENDCLASS.\n';
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'transitive-activation-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'abap_transpile.json'), JSON.stringify({input_folder: 'src', libs: []}));
    writeFileSync(join(root, 'abaplint.jsonc'), JSON.stringify({syntax: {version: 'v702'}}));
    writeFileSync(join(root, 'src/zcl_base.clas.abap'), base);
    writeFileSync(join(root, 'src/zcl_sub.clas.abap'), 'CLASS zcl_sub DEFINITION PUBLIC INHERITING FROM zcl_base. ENDCLASS.\nCLASS zcl_sub IMPLEMENTATION. ENDCLASS.\n');
    writeFileSync(join(root, 'src/zcl_caller.clas.abap'), 'CLASS zcl_caller DEFINITION PUBLIC. PUBLIC SECTION. CLASS-METHODS call. ENDCLASS.\nCLASS zcl_caller IMPLEMENTATION. METHOD call. DATA sub TYPE REF TO zcl_sub. CREATE OBJECT sub. sub->run( iv_old = 1 ). ENDMETHOD. ENDCLASS.\n');
    activeFixture(root);
    store = new ObjectStore({root, libs: []});
  });
  afterEach(() => rmSync(root, {recursive: true, force: true}));
  it('checks an inherited parameter through a subclass and recovers with the kept registry', () => {
    expect(store.check('CLAS', 'ZCL_CALLER').issues).to.deep.equal([]);
    const registry = store.registry();
    store.write('CLAS', 'ZCL_BASE', base.replace('iv_old', 'iv_new'));
    const result = store.activate('CLAS', 'ZCL_BASE');
    expect(result.issues).to.deep.equal([]);
    expect(result.active).to.equal(false);
    expect(result.dependents.map(d => d.name)).to.include('ZCL_CALLER');
    expect(result.dependents.flatMap(d => d.issues).some(i => /iv_old/i.test(i.message))).to.equal(true);
    expect(store.registry()).to.equal(registry);
    store.write('CLAS', 'ZCL_BASE', base);
    expect(store.activate('CLAS', 'ZCL_BASE').active).to.equal(true);
  });
  it('accepts APC metadata reached through its handler while retaining source checks', () => {
    writeFileSync(join(root, 'src/zchannel.sapc.xml'), '<SAPC><APPLICATION_ID>ZCHANNEL</APPLICATION_ID><PATH>/channel</PATH><CLASS_NAME>ZCL_CALLER</CLASS_NAME><STATEFUL>X</STATEFUL></SAPC>');
    store.build();
    expect(store.activate('CLAS', 'ZCL_BASE').active).to.equal(true);
    store.write('CLAS', 'ZCL_BASE', base.replace('iv_old', 'iv_new'));
    expect(store.activate('CLAS', 'ZCL_BASE').dependents.map(d => d.name)).to.include('ZCL_CALLER');
  });
  it('logs and checks the full registry above the dirty closure limit', () => {
    for (let i = 0; i < 257; i++) writeFileSync(join(root, `src/zreader${i}.prog.abap`), `REPORT zreader${i}.\n* zcl_base\n`);
    writeFileSync(join(root, 'src/zbad.prog.abap'), 'REPORT zbad.\nmissing_variable = 1.\n');
    store.build();
    const messages = [], warn = console.warn;
    console.warn = message => messages.push(message);
    let result;
    try {result = store.activate('CLAS', 'ZCL_BASE');} finally {console.warn = warn;}
    expect(messages.some(m => m.includes('exceeds 256') && m.includes('full registry check'))).to.equal(true);
    expect(result.active).to.equal(false);
    expect(result.dependents.map(d => d.name)).to.include('ZBAD');
  });
  it('never takes a library object for a dependent, not even in the full registry fallback', () => {
    for (let i = 0; i < 257; i++) writeFileSync(join(root, `src/zreader${i}.prog.abap`), `REPORT zreader${i}.\n* zcl_base\n`);
    // a library object with an issue of its own: an unknown type, as a
    // library carries for DDIC it does not ship. It reads zcl_base too.
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib/zlib_broken.prog.abap'), 'REPORT zlib_broken.\n* zcl_base\nDATA ls_msg TYPE zlib_unknown_type.\n');
    const withLib = new ObjectStore({root, libs: ['lib']});
    withLib.build();
    const warn = console.warn;
    console.warn = () => {};
    let fallback;
    try {fallback = withLib.activate('CLAS', 'ZCL_BASE');} finally {console.warn = warn;}
    expect(withLib.registry().getObject('PROG', 'ZLIB_BROKEN')).to.not.equal(undefined);
    expect(fallback.dependents.map(d => d.name)).to.not.include('ZLIB_BROKEN');
    expect(fallback.active).to.equal(true);
  });
});
