import {expect} from "chai";
import {appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {spawnSync} from "node:child_process";
import {tmpdir} from "node:os";
import {basename, join} from "node:path";
import {fileURLToPath} from "node:url";
import {classifyFindings, islandBasenames, parseFindings, requestFor, run, tadirKinds} from "../tools/hana-closure.mjs";
import {dumperCommand, parseEnvFile} from "../tools/hana-closure-dumper.mjs";
import {methodBlocks, stubBodies, stubNamesText} from "../tools/hana-closure-stubs.mjs";
import {buildVerdict, islandObjectCount, islandShrinkCheck, layersDdicCount} from "../tools/hana-closure-merge.mjs";
import {ddicFields, tablXml} from "../tools/hana-ddic-map.mjs";

const REPO = fileURLToPath(new URL("..", import.meta.url));

// H5c: the dependency closure, by iteration (tools/hana-closure.mjs).
//
// Everything here runs against fakes, the way CI must: the dumper is a
// fixture script this test writes that mimics the real binary's CLI contract
// (a foreign binary on the bed, spawned by path from OSD_HANA_DUMPER: the
// required connection flags, the schema-1 request file, the refusal of an
// --out inside a git working tree unless --allow-in-repo, the password read
// from VSP_HANA_PASSWORD only), the dump merge is a fake host behind
// OSD_SELF (the real hana-ddic-gen --from-dump and hana-src-gen --from-dump
// are PR #926, merged; the loop only owns their argv), and the validate step
// is the transpiler's own validation over a scratch tree whose node_modules
// is a symlink to this checkout's, the converter the loop starts per dump is
// a fixture script (OSD_HANA_CONVERTER) that copies staged layers per dump
// and refuses an --out inside the working tree without --allow-in-repo, like
// the real one, and the fixed point's positive control (the build) is a
// fake-host mode. No
// HANA is reachable from CI. Names are
// ZOSD_H5C_* fixtures; a real service's names live in the private findings
// log and its leak list.
describe("hana-closure: the dependency closure, by iteration", () => {

  // ------------------------------------------------------------- units ----

  it("the fallback classifier asks exactly the shapes no reference carries", () => {
    const lines = [
      // the SELECT shapes: a SELECT's table is in no scope carrier (the
      // INTO variable's error names none -- probes/probe-tables.mjs)
      `check_syntax, Database table or view "zosd_h5c_bpa" not found, zcl_h5c_app.clas.abap:10`,
      `unknown_types, Variable "LV_TXT" contains unknown: Type error, field not part of structure zosd_h5c_v-ddtext, zcl_h5c_app.clas.abap:23`,
      // the type-lookup fallback: a finding whose UnknownType carried no
      // extractable name (a domain-typed variable's error can be the bare
      // name) -- when the name IS carried, the finding is
      // structural-matched and never reaches these branches
      `unknown_types, Variable "LV_ROLE" contains unknown: ZOSD_H5C_ROLE not found, lookup, zcl_h5c_app.clas.abap:11`,
      `unknown_types, Variable "LV_ID" contains unknown: ZOSD_H5C_ID not found, lookupDataElement, zcl_h5c_app.clas.abap:12`,
      `unknown_types, Variable "LV_GUID" contains unknown: ZOSD_H5C_UUID, lookupDomain, zcl_h5c_app.clas.abap:13`,
      `unknown_types, Contains unknown, ZOSD_H5C_LAND not found, lookup, zcl_h5c_app.clas.abap:14`,
      // statement-level class references: RAISE/CATCH/CREATE OBJECT and
      // TYPES statements never become a variable, a type or a recorded
      // reference (graph-closure/REPORT.md §3)
      `check_syntax, Class zcl_h5c_facade not found, zcl_h5c_app.clas.abap:15`,
      `check_syntax, Unknown class cl_h5c_standard, zcl_h5c_app.clas.abap:16`,
      `check_syntax, CATCH, unknown class ZCX_H5C_API, zcl_h5c_app.clas.abap:18`,
      `check_syntax, RAISE, unknown class zcx_h5c_late, zcl_h5c_app.clas.abap:33`,
      `unknown_types, TYPE "cl_h5c_number_range" not found, zcl_h5c_app.clas.abap:19`,
      // a constant default off an absent object records nothing in the
      // scope (probes/probe-edges.mjs): X is THAT name, a code kind
      `check_syntax, resolveConstantValue, not found: zif_h5c_organization, zcl_h5c_org_unit.intf.abap:44`,
      // table types in a TABLE OF position: no scope carrier either
      `unknown_types, ZOSD_H5C_PARAMS_TAB not found, lookup, zcl_h5c_app.clas.abap:24`,
      `check_syntax, Loop, not a table type, /ZOSD/H5C_T_NAVI not found, lookup, zcl_h5c_app.clas.abap:25`,
      // Target type unknown names the statement's target VARIABLE: a local
      // variable's name is a cascade, counted, never asked (the bed asked
      // five of these as TTYP and they became gaps); a name outside the
      // convention is the kind-less dictionary triple
      `check_syntax, Target type unknown, zosd_h5c_tt_loc, zcl_h5c_app.clas.abap:35`,
      `check_syntax, Target type unknown, eo_h5c_error_message, zcl_h5c_facade.clas.abap:45`,
      // the function-group compile shape: the name is the file's own
      `parser_error, Statement does not exist in the configured ABAP version(or a parser error), "FUNCTION", #zosd#gws_h5c_shexits.fugr.#zosd#lgws_h5c$01.abap:5`,
      // not findings at all
      `osd-build: transpile`,
      ``,
    ];
    const {names, cascades, unclassified} = classifyFindings(parseFindings(lines.join("\n")));
    const want = [
      ["ZOSD_H5C_BPA", "tabl"],
      ["ZOSD_H5C_V", "tabl"],
      ["ZOSD_H5C_ROLE", "ddic"],
      ["ZOSD_H5C_ID", "dtel"],
      ["ZOSD_H5C_UUID", "doma"],
      ["ZOSD_H5C_LAND", "ddic"],
      ["ZCL_H5C_FACADE", "clas"],
      ["CL_H5C_STANDARD", "clas"],
      ["ZCX_H5C_API", "clas"],
      ["ZCX_H5C_LATE", "clas"],
      ["CL_H5C_NUMBER_RANGE", "clas"],
      ["ZIF_H5C_ORGANIZATION", "clas"],
      ["ZOSD_H5C_PARAMS_TAB", "ddic"],
      ["/ZOSD/H5C_T_NAVI", "ddic"],
      ["ZOSD_H5C_TT_LOC", "ddic"],
      ["/ZOSD/GWS_H5C_SHEXITS", "fugr"],
    ];
    expect(names.map((n) => [n.name, n.kind]), "every fallback name, classified, in first-named order").to.deep.equal(want);
    expect(names.map((n) => n.name).filter((n) => n.startsWith("EO_H5C")),
      "a variable's name is never the ask").to.deep.equal([]);
    // the first finding that named it rides along -- the gaps file quotes it
    expect(names[0].finding).to.include(`Database table or view "zosd_h5c_bpa" not found`);
    expect(names[0].message, "the message rides beside the raw (the SHLP decision reads it)").to.equal(`Database table or view "zosd_h5c_bpa" not found`);
    expect(names[15].finding).to.include(`#zosd#gws_h5c_shexits.fugr.`);
    expect(names.find((n) => n.name === "CL_H5C_NUMBER_RANGE").kind, "a TYPES statement's class ref asks as a class").to.equal("clas");
    expect(cascades, "the variable cascade is counted, not named").to.equal(1);
    expect(unclassified, "every line was understood").to.deep.equal([]);
  });

  it("wordings whose name travels structurally are counted, never asked", () => {
    // a missing superclass or friend (the CLASS DEFINITION statement's
    // INHERITING FROM / GLOBAL FRIENDS carry both names), a void type
    // error, the member cascades: the names are references()'s -- the text
    // adds nothing to ask
    const {names, cascades, unclassified} = classifyFindings(parseFindings([
      `check_syntax, Super class "zcl_h5c_superabs" not found or contains errors, zcl_h5c_app.clas.abap:34`,
      `check_syntax, Friend class zcl_h5c_friend does not exist, cm_h5c_root.clas.abap:7`,
      `unknown_types, ZCX_H5C_API_EXCEPTION unknown, zif_h5c_message_buffer.intf.abap:14`,
      `check_syntax, Method or attribute "retrieve" not found, MethodSource, zcl_h5c_app.clas.abap:24`,
      `check_syntax, Component "content_id" not found in structure, zcl_h5c_app.clas.abap:26`,
      `check_syntax, Not an object reference, attribute name, zcl_h5c_app.clas.abap:27`,
      `unknown_types, Variable "LS_P" contains unknown: Type error, not a table type mt_h5c_params, zcl_h5c_app.clas.abap:29`,
      `unknown_types, Variable "LS_C" contains unknown: TY_S_H5C_CHANGESET not found in class or interface, zcl_h5c_app.clas.abap:30`,
      `unknown_types, Variable "LS_H5C_HEAD" contains unknown: Select, buildStructureTypeError not found, zcl_h5c_app.clas.abap:31`,
      `check_syntax, "callcontrol" not found, findTop, #zosd#gws_h5c_shexits.fugr.#zosd#gws_h5c_exit.abap:31`,
      `check_syntax, Definition for "zosd_h5c_attr" not found in scope(AttributeName), zcl_h5c_app.clas.abap:36`,
      `check_syntax, Method parameter type not compatible, zcl_h5c_app.clas.abap:37`,
      `check_syntax, ZCL_H5C_PROT cannot be instantiated, class is defined as protected, zcl_h5c_app.clas.abap:38`,
    ].join("\n")));
    expect(names, "no fallback name out of any of them").to.deep.equal([]);
    expect(cascades, "every one counted, none named").to.equal(13);
    expect(unclassified).to.deep.equal([]);
  });

  it("a structural shape that reaches the classifier anyway is visible as unclassified", () => {
    // the deleted branches -- contains-unknown, could not resolve top,
    // unable to resolve -- are references()'s carriers: the loop
    // structural-matches their findings by line and they never get here.
    // One of these wordings WITHOUT a matching reference is a carrier the
    // probes did not measure: visible, never silently dropped
    const {names, unclassified} = classifyFindings(parseFindings([
      `unknown_types, Could not resolve top ZIF_H5C_MSG, resolveTypeChain, zcl_h5c_app.clas.abap:19`,
      `unknown_types, Variable "LR_BUF" contains unknown: REF, unable to resolve zif_h5c_msg, zcl_h5c_app.clas.abap:22`,
    ].join("\n")));
    expect(names).to.deep.equal([]);
    expect(unclassified).to.have.lengthOf(2);
  });

  it("a repeated name is asked once, with its first finding", () => {
    const line = `check_syntax, Database table or view "zosd_h5c_bpa" not found, zcl_h5c_app.clas.abap:10`;
    const {names, cascades} = classifyFindings(parseFindings([line, line, line].join("\n")));
    expect(names).to.have.lengthOf(1);
    expect(names[0].finding).to.equal(line);
    expect(cascades, "a repeated name is the same name, not a cascade").to.equal(0);
  });

  it("tolerates the build log's FAILED prefix and reports what it cannot classify", () => {
    const {names, unclassified} = classifyFindings(parseFindings([
      `osd-build: FAILED: check_syntax, Database table or view "zosd_h5c_land" not found, zcl_h5c_app.clas.abap:14`,
      `check_datasets, Open ABAP Cloud shapes only, zcl_h5c_ref.clas.abap:3`,
    ].join("\n")));
    expect(names.map((n) => n.name)).to.deep.equal(["ZOSD_H5C_LAND"]);
    expect(unclassified).to.deep.equal([`check_datasets, Open ABAP Cloud shapes only, zcl_h5c_ref.clas.abap:3`]);
  });

  it("a kind-less ddic name is asked under TABL, DTEL, TTYP and DOMA -- SHLP only when the finding says search help", () => {
    // `contains unknown: X not found` does not say whether X is a table, a
    // data element, a table type or a domain (the structural ask's error
    // text says `lookup` for every one): the name goes in under every kind
    // the dumper resolves by name, and the dumper's manifest.closure
    // reports what the dictionary does not have
    expect(tadirKinds("ddic", `unknown_types, Variable "LV_ROLE" contains unknown: ZOSD_H5C_ROLE not found, lookup, zcl_h5c_app.clas.abap:11`))
      .to.deep.equal(["TABL", "DTEL", "TTYP", "DOMA"]);
    expect(tadirKinds("ddic", `check_syntax, "callcontrol" not found, findTop, #zosd#gws_h5c_shexits.fugr.x.abap:31 -- the search help exit's TABLES signature`))
      .to.deep.equal(["TABL", "DTEL", "TTYP", "DOMA", "SHLP"]);
    expect(tadirKinds("tabl", "f")).to.deep.equal(["TABL"]);
    expect(tadirKinds("dtel", "f")).to.deep.equal(["DTEL"]);
    expect(tadirKinds("doma", "f")).to.deep.equal(["DOMA"]);
    expect(tadirKinds("clas", "f")).to.deep.equal(["CLAS"]);
    expect(tadirKinds("intf", "f")).to.deep.equal(["INTF"]);
    expect(tadirKinds("fugr", "f")).to.deep.equal(["FUGR"]);
  });

  it("the request is schema 1, exactly what the dumper's reader reads", () => {
    const kinds = ["TABL", "DTEL", "DOMA", "TTYP", "SHLP", "CLAS", "INTF", "FUGR", "PROG"];
    const asked = {ZOSD_H5C_ROLE: {kinds: ["TABL", "DTEL", "TTYP"], iteration: 2, finding: "old finding"}};
    const gaps = [{name: "ZOSD_H5C_UUID", kind: "DOMA", first_finding: "f", iterations_requested: 3}];
    const fresh = [
      {name: "ZOSD_H5C_BPA", kind: "tabl", finding: "f"},
      {name: "ZIF_H5C_BO", kind: "intf", finding: "g"},
      {name: "ZOSD_H5C_SHLP_EXIT", kind: "ddic", finding: `"callcontrol" not found -- the search help exit's TABLES signature`},
      // the message decides the SHLP extra kind, never the raw line: the
      // raw ends in the file name, and this file is called *searchhelpexits*
      {name: "ZOSD_H5C_FILEONLY", kind: "ddic",
        finding: `unknown_types, Variable "LV_X" contains unknown: ZOSD_H5C_FILEONLY not found, lookup, #zosd#gws_h5c_searchhelpexits.fugr.#zosd#lgws_h5c$01.abap:5`,
        message: `Variable "LV_X" contains unknown: ZOSD_H5C_FILEONLY not found`},
    ];
    const request = requestFor({iteration: 3, generation: "h5c_sha", fresh, asked, gaps});
    expect(Object.keys(request).sort(), "the exact key set").to.deep.equal(
      ["gaps", "generation", "iteration", "requested", "schema", "seen", "source"]);
    expect(request.schema, "the reader refuses any other schema").to.equal(1);
    expect(request.iteration).to.equal(3);
    expect(request.generation, "the hash from the merge's manifest").to.equal("h5c_sha");
    expect(request.source).to.equal("transpile validate() findings");
    expect(Object.keys(request.requested), "the nine upper-case TADIR kinds").to.deep.equal(kinds);
    expect(Object.keys(request.seen)).to.deep.equal(kinds);
    expect(request.requested.TABL).to.deep.equal(["ZOSD_H5C_BPA", "ZOSD_H5C_SHLP_EXIT", "ZOSD_H5C_FILEONLY"]);
    expect(request.requested.DTEL).to.deep.equal(["ZOSD_H5C_SHLP_EXIT", "ZOSD_H5C_FILEONLY"]);
    expect(request.requested.TTYP).to.deep.equal(["ZOSD_H5C_SHLP_EXIT", "ZOSD_H5C_FILEONLY"]);
    expect(request.requested.SHLP).to.deep.equal(["ZOSD_H5C_SHLP_EXIT"]);
    expect(request.requested.TABL).to.include("ZOSD_H5C_FILEONLY");
    expect(request.requested.SHLP, "the file name alone never adds the SHLP kind").to.not.include("ZOSD_H5C_FILEONLY");
    expect(request.requested.INTF).to.deep.equal(["ZIF_H5C_BO"]);
    expect(request.requested.CLAS).to.deep.equal([]);
    // seen is what earlier iterations requested, per kind, so the dumper skips it
    expect(request.seen.TABL).to.deep.equal(["ZOSD_H5C_ROLE"]);
    expect(request.seen.DTEL).to.deep.equal(["ZOSD_H5C_ROLE"]);
    expect(request.seen.TTYP).to.deep.equal(["ZOSD_H5C_ROLE"]);
    expect(request.seen.PROG).to.deep.equal([]);
    expect(request.gaps).to.deep.equal([{name: "ZOSD_H5C_UUID", kind: "DOMA", first_finding: "f", iterations_requested: 3}]);
  });

  it("the dumper's argv is the real binary's contract, and the password stays out of it", () => {
    const connection = {HANA_HOST: "h5c.example", HANA_PORT: "30215", HANA_USER: "h5c_user", HANA_SCHEMA: "h5c_schema", HANA_PASSWORD: "h5c_secret"};
    const {argv, env} = dumperCommand({dumper: "/opt/vsp/vsp-hana", connection, requestPath: "/r/closure-request.json", dumpDir: "/d/dump-002", provenance: "closure iteration 2"});
    expect(argv.slice(0, 3)).to.deep.equal(["/opt/vsp/vsp-hana", "hana", "dump"]);
    const flag = (name) => argv[argv.indexOf(name) + 1];
    expect(flag("--host")).to.equal("h5c.example");
    expect(flag("--port")).to.equal("30215");
    expect(flag("--user")).to.equal("h5c_user");
    expect(flag("--schema")).to.equal("h5c_schema");
    expect(flag("--provenance")).to.equal("closure iteration 2");
    expect(flag("--ddic-closure"), "the request file, not a comma-joined --name").to.equal("/r/closure-request.json");
    expect(flag("--out")).to.equal("/d/dump-002");
    expect(argv, "the dump lands in gitignored .local/, which the dumper refuses without the flag").to.include("--allow-in-repo");
    expect(argv, "the closure must never carry CCAU test includes (round 7)").to.include("--skip-test-includes");
    expect(argv.join(" "), "the password is in the child's environment only, never on the argv").to.not.include("h5c_secret");
    expect(argv).to.not.include("--name");
    expect(argv).to.not.include("--password");
    expect(env).to.deep.equal({VSP_HANA_PASSWORD: "h5c_secret"});
    try {
      dumperCommand({dumper: "/opt/vsp/vsp-hana", connection: {...connection, HANA_HOST: ""}, requestPath: "/r", dumpDir: "/d", provenance: "p"});
      expect.fail("a connection without the host was accepted");
    } catch (error) {
      expect(error.message).to.match(/HANA_HOST/);
    }
  });

  it("reads the dumper's connection env file", () => {
    expect(parseEnvFile([
      "# the connection",
      "HANA_HOST=h5c.example",
      "",
      "export HANA_USER=h5c_user",
      "HANA_PASSWORD=h5c_secret",
    ].join("\n"))).to.deep.equal({HANA_HOST: "h5c.example", HANA_USER: "h5c_user", HANA_PASSWORD: "h5c_secret"});
  });

  it("the fake dumper refuses a non-empty --out like the real one", () => {
    // critic r2's S-5: the fake must fail where the real binary fails, or a
    // re-executed pending round slides through a test green (the real
    // dumper refuses the answered directory: prepareOut's "is not empty")
    const root = mkdtempSync(join(tmpdir(), "hana-closure-fakedumper-"));
    try {
      writeFileSync(join(root, "fake-dumper.mjs"), fakeDumperSource());
      chmodSync(join(root, "fake-dumper.mjs"), 0o755);
      mkdirSync(join(root, "req"), {recursive: true});
      writeFileSync(join(root, "req", "closure-request.json"), JSON.stringify({schema: 1, requested: {}}));
      const argv = (out) => [join(root, "fake-dumper.mjs"), "hana", "dump",
        "--host", "h5c.example", "--user", "h5c_user", "--schema", "h5c_schema",
        "--provenance", "p", "--ddic-closure", join(root, "req", "closure-request.json"),
        "--out", out, "--allow-in-repo"];
      mkdirSync(join(root, "out-full"), {recursive: true});
      writeFileSync(join(root, "out-full", "manifest.json"), "{}\n");
      const full = spawnSync(process.execPath, argv(join(root, "out-full")));
      expect(full.status, "the real one refuses a non-empty --out").to.equal(3);
      expect(String(full.stderr)).to.include("not empty");
      const fresh = spawnSync(process.execPath, argv(join(root, "out-new")));
      expect(fresh.status, "an empty --out goes through").to.equal(0);
      expect(existsSync(join(root, "out-new", "manifest.json"))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the island's basenames come out of gen/hana-src/** and gen/hana-ddic/*, never out of src/", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-closure-island-"));
    try {
      mkdirSync(join(root, "gen", "hana-src", "001-h5c", "src"), {recursive: true});
      mkdirSync(join(root, "gen", "hana-ddic"), {recursive: true});
      mkdirSync(join(root, "src"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-src", "001-h5c", "src", "zcl_h5c_island.clas.abap"), "x");
      writeFileSync(join(root, "gen", "hana-src", "001-h5c", "src", "sub.clas.abap"), "x");
      writeFileSync(join(root, "gen", "hana-ddic", "zosd_h5c_head.tabl.xml"), "x");
      writeFileSync(join(root, "src", "zcl_h5c_own.clas.abap"), "x");
      const island = islandBasenames(root);
      expect([...island].sort(), "the island's files, nested layers included").to.deep.equal(
        ["sub.clas.abap", "zcl_h5c_island.clas.abap", "zosd_h5c_head.tabl.xml"]);
      expect(island.has("zcl_h5c_own.clas.abap"), "a src/ file is the tree's own").to.equal(false);
      expect(islandBasenames(join(root, "nowhere")).size, "no island, no names").to.equal(0);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("counts the island's classes, interfaces and tables -- objects, not files", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-closure-count-"));
    try {
      mkdirSync(join(root, "gen", "hana-src", "001-h5c", "src"), {recursive: true});
      mkdirSync(join(root, "gen", "hana-ddic"), {recursive: true});
      for (const f of ["zcl_h5c_one.clas.abap", "zcl_h5c_one.clas.xml", "zcl_h5c_one.clas.locals_imp.abap",
        "zcl_h5c_two.clas.abap", "zif_h5c_three.intf.abap", "zif_h5c_three.intf.xml", "zcl_h5c_prog.prog.abap"]) {
        writeFileSync(join(root, "gen", "hana-src", "001-h5c", "src", f), "x");
      }
      for (const f of ["zosd_h5c_head.tabl.xml", "zosd_h5c_el.dtel.xml", "zosd_h5c_head2.tabl.xml"]) {
        writeFileSync(join(root, "gen", "hana-ddic", f), "x");
      }
      // round 5: the layers carry .tabl.xml too when the converter is the
      // DDIC's writer of record; a stem both folders carry is one object
      for (const f of ["zosd_h5c_layer.tabl.xml", "zosd_h5c_head2.tabl.xml", "zosd_h5c_layer.dtel.xml"]) {
        writeFileSync(join(root, "gen", "hana-src", "001-h5c", "src", f), "x");
      }
      // the class's locals include and xml are the same object; dtel and prog
      // are not in the count (classes+interfaces+tables, the shrink assert's
      // unit); and the test-code rule (S-7.1): a test-classes include and a
      // *_TEST class present in gen/hana-src are not island objects
      for (const f of ["zcl_h5c_one.clas.testclasses.abap", "zcl_h5c_helper_test.clas.abap"]) {
        writeFileSync(join(root, "gen", "hana-src", "001-h5c", "src", f), "x");
      }
      expect(islandObjectCount(root)).to.deep.equal({clas: 2, intf: 1, tabl: 3, total: 6});
      expect(islandObjectCount(join(root, "nowhere"))).to.deep.equal({clas: 0, intf: 0, tabl: 0, total: 0});
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the shrink assert is per kind: tables holding a total up is still a lost island", () => {
    // critic r4 S-4: the builder's own first shrink scenario passed because
    // the second dump's new tables compensated the classes it lost
    expect(islandShrinkCheck({clas: 1, intf: 1, tabl: 1, total: 3}, {clas: 1, intf: 1, tabl: 2, total: 4}, 3),
      "every kind non-decreasing stands").to.equal(undefined);
    let thrown;
    try {
      islandShrinkCheck({clas: 1, intf: 1, tabl: 1, total: 3}, {clas: 0, intf: 1, tabl: 3, total: 4}, 3);
      expect.fail("the compensated shrink was accepted");
    } catch (error) {
      thrown = error;
    }
    expect(thrown.message, "both totals are on the abort").to.include("the island shrank: 3 -> 4");
    expect(thrown.message, "the kind that shrank is named").to.include("clas 1 -> 0");
    expect(thrown.message).to.include("classes+interfaces+tables");
  });

  it("counts the DDIC XML the layers carry -- the converter is then the writer of record", () => {
    const root = mkdtempSync(join(tmpdir(), "hana-closure-layerddic-"));
    try {
      mkdirSync(join(root, "layers-001", "layers", "h5c-main", "src"), {recursive: true});
      mkdirSync(join(root, "layers-002", "layers", "h5c-main", "src"), {recursive: true});
      writeFileSync(join(root, "layers-001", "layers", "h5c-main", "src", "zosd_h5c_a.tabl.xml"), "x");
      writeFileSync(join(root, "layers-001", "layers", "h5c-main", "src", "zosd_h5c_b.dtel.xml"), "x");
      writeFileSync(join(root, "layers-001", "plan.json"), "{}\n");
      writeFileSync(join(root, "layers-002", "layers", "h5c-main", "src", "zcl_h5c_x.clas.abap"), "x");
      expect(layersDdicCount([join(root, "layers-001"), join(root, "layers-002")])).to.equal(2);
      expect(layersDdicCount([join(root, "layers-002")]), "no DDIC XML, no count").to.equal(0);
      expect(layersDdicCount([])).to.equal(0);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the positive control: a build that fails with no findings refuses the fixed point", () => {
    // bed run 4's control: osd-build FAILED on a generator step with zero
    // transpiler findings -- the shape the loop must never read as convergence
    const quiet = [
      "osd-build: osd-transpiler.mjs",
      "osd-build: FAILED: node --import tools/osd-generator-reads.mjs tools/cds2ddic.mjs exited 1",
      "osd-build: live generation untouched",
    ].join("\n");
    let quietThrow;
    try {
      buildVerdict(1, quiet);
      expect.fail("the quiet failure was accepted");
    } catch (error) {
      quietThrow = error;
    }
    expect(quietThrow.message, "non-zero exit, zero findings: abort with the FAILED line").to.include("not a fixed point");
    expect(quietThrow.message).to.include("FAILED: node --import");
    expect(buildVerdict(0, "")).to.deep.equal({status: 0, findings: 0});
    expect(buildVerdict(1, `check_syntax, Database table or view "zosd_h5c_head" not found, zcl_h5c_loop.clas.abap:10`),
      "exit 1 with findings only: the walk's ordinary material").to.deep.equal({status: 1, findings: 1});
  });

  // ------------------------------------------------- lazy activation ----

  const STUB_CLASS = [
    `CLASS zcl_h5c_stub DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    TYPES ty_h5c TYPE zosd_h5c_w.`,
    `    METHODS one.`,
    `    METHODS two.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_stub IMPLEMENTATION.`,
    `  METHOD one.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD two.`,
    `    SELECT SINGLE * FROM zosd_h5c_head INTO @DATA(ls_h5c_head) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const findingAt = (line) => parseFindings(`check_syntax, Database table or view "zosd_h5c_head" not found, zcl_h5c_stub.clas.abap:${line}`);

  it("stubs the method a finding names, at the parsed positions, byte-identical around the block", () => {
    const {source: stubbed, stubs, unmatched} = stubBodies(STUB_CLASS, findingAt(12), "zcl_h5c_stub.clas.abap");
    expect(stubs).to.have.lengthOf(1);
    expect(stubs[0].method).to.equal("TWO");
    expect(stubs[0].className).to.equal("ZCL_H5C_STUB");
    expect(stubs[0].missing).to.deep.equal(["ZOSD_H5C_HEAD"]);
    expect(unmatched, "the finding was inside a body").to.deep.equal([]);
    const original = STUB_CLASS.split("\n");
    const out = stubbed.split("\n");
    expect(out.slice(0, 11), "everything before the body").to.deep.equal(original.slice(0, 11));
    expect(out[11]).to.equal(`    RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_HEAD'.`);
    expect(out[12]).to.equal(`  ENDMETHOD.`);
    expect(out.slice(13), "everything after the block").to.deep.equal(original.slice(13));
    // the rewritten file still parses into the same blocks
    expect(methodBlocks(stubbed, "zcl_h5c_stub.clas.abap")).to.have.lengthOf(2);
  });

  it("a definition-level finding is not stubbed: it comes back unmatched and the file stays whole", () => {
    const findings = parseFindings(`unknown_types, Variable "TY_H5C" contains unknown: ZOSD_H5C_W not found, lookup, zcl_h5c_stub.clas.abap:3`);
    const {source: stubbed, stubs, unmatched} = stubBodies(STUB_CLASS, findings, "zcl_h5c_stub.clas.abap");
    expect(stubs, "the definition part has no METHOD block around line 3").to.deep.equal([]);
    expect(unmatched).to.deep.equal(findings);
    expect(stubbed).to.equal(STUB_CLASS);
  });

  it("several findings in one method are one stub: the references first, then the fallback", () => {
    const findings = parseFindings([
      `unknown_types, Variable "LV_ID" contains unknown: ZOSD_H5C_ID not found, lookupDataElement, zcl_h5c_stub.clas.abap:12`,
      `check_syntax, Method or attribute "get_messages" not found, MethodSource, zcl_h5c_stub.clas.abap:12`,
      `check_syntax, Database table or view "zosd_h5c_bpa" not found, zcl_h5c_stub.clas.abap:12`,
    ].join("\n"));
    // the data element's name is references()'s (the variable's
    // UnknownType carries it, fix keyword and all); the cascade names
    // nothing; the SELECT table is the fallback's
    const refs = [{name: "ZOSD_H5C_ID", kind: "type", via: "lookup", fix: "lookupDataElement",
      line: 12, level: "method", method: "TWO"}];
    const {source: stubbed, stubs} = stubBodies(STUB_CLASS, findings, "zcl_h5c_stub.clas.abap", refs);
    expect(stubs).to.have.lengthOf(1);
    expect(stubs[0].finding, "the first finding is the record's").to.match(/contains unknown: ZOSD_H5C_ID/);
    expect(stubs[0].missing, "the cascade's name is not the thing that is missing").to.deep.equal(["ZOSD_H5C_ID", "ZOSD_H5C_BPA"]);
    expect(stubs[0].missingKinds).to.deep.equal([{name: "ZOSD_H5C_ID", kind: "dtel"}, {name: "ZOSD_H5C_BPA", kind: "tabl"}]);
    expect(stubbed).to.include(`missing = 'ZOSD_H5C_ID, ZOSD_H5C_BPA'.`);
  });

  it("a locals_imp include stubs like the class's own file, under the local class's name", () => {
    const locals = [
      `CLASS lcl_h5c_local DEFINITION.`,
      `  PUBLIC SECTION.`,
      `    METHODS go.`,
      `ENDCLASS.`,
      `CLASS lcl_h5c_local IMPLEMENTATION.`,
      `  METHOD go.`,
      `    DATA lv_w TYPE zosd_h5c_w.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const findings = parseFindings(`unknown_types, Variable "LV_W" contains unknown: ZOSD_H5C_W not found, lookup, zcl_h5c_local.clas.locals_imp.abap:7`);
    const {source: stubbed, stubs} = stubBodies(locals, findings, "zcl_h5c_local.clas.locals_imp.abap");
    expect(stubs).to.have.lengthOf(1);
    expect(stubs[0].className).to.equal("LCL_H5C_LOCAL");
    expect(stubs[0].method).to.equal("GO");
    expect(stubbed).to.include(`missing = 'ZOSD_H5C_W'.`);
  });

  it("a file that does not parse stays whole, its findings all unmatched", () => {
    const findings = findingAt(2);
    const {source: stubbed, stubs, unmatched} = stubBodies("this is not abap.", findings, "zcl_h5c_stub.clas.abap");
    expect(stubs).to.deep.equal([]);
    expect(unmatched).to.deep.equal(findings);
    expect(stubbed).to.equal("this is not abap.");
  });

  it("the stub's names list caps at ~200 characters", () => {
    const long = ["ZOSD_H5C_" + "A".repeat(80), "ZOSD_H5C_" + "B".repeat(80), "ZOSD_H5C_" + "C".repeat(80)];
    const text = stubNamesText(long);
    expect(text.length, "the text travels in the exception").to.be.at.most(200);
    expect(text).to.match(/\.\.\.$/);
    expect(stubNamesText(["ZOSD_H5C_HEAD"])).to.equal("ZOSD_H5C_HEAD");
    expect(stubNamesText([])).to.equal("");
  });

  it("the request carries the stubbed names in `deferred`, an optional key beside requested/seen", () => {
    const deferred = [{name: "ZOSD_H5C_HEAD", kind: "tabl", finding: "f"}];
    const request = requestFor({iteration: 2, generation: "g", fresh: [{name: "ZOSD_H5C_DEF", kind: "ddic", finding: "f"}], asked: {}, gaps: [], deferred});
    expect(Object.keys(request).sort(), "the exact key set grows by the optional key").to.deep.equal(
      ["deferred", "gaps", "generation", "iteration", "requested", "schema", "seen", "source"]);
    expect(request.deferred.TABL).to.deep.equal(["ZOSD_H5C_HEAD"]);
    expect(request.deferred.DTEL, "a tabl finding is deferred under TABL only").to.deep.equal([]);
    expect(Object.keys(requestFor({iteration: 2, generation: "g", fresh: [], asked: {}, gaps: []})), "without stubs the key is not there").to.not.include("deferred");
  });

  // --------------------------------------------------- H5x-1 units ----

  it("planStubPass: a table the dumper can answer keeps its body; a dead table or a code name stubs", async () => {
    const {planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    const base = {source: STUB_CLASS, basename: "zcl_h5c_stub.clas.abap",
      asked: () => true, islandFiles: new Set(), excludedObjects: new Set(), registered: new Set()};
    // the method's only miss is a live table: no stub yet, the name eager
    const live = planStubPass({...base, findings: findingAt(12), missingOf: () => false, asked: () => false});
    expect(live.stubs, "the dumper can still answer").to.deep.equal([]);
    expect(live.source).to.equal(STUB_CLASS);
    expect(live.deferred).to.deep.equal([]);
    expect(live.eager, "the body stays, the finding stays: classification asks the name").to.deep.equal([]);
    // the dumper answered missing: the stub records the gap, nothing deferred
    const dead = planStubPass({...base, findings: findingAt(12), missingOf: () => true});
    expect(dead.stubs).to.have.lengthOf(1);
    expect(dead.stubs[0].missing).to.deep.equal(["ZOSD_H5C_HEAD"]);
    expect(dead.deferred).to.deep.equal([]);
    expect(dead.source).to.contain(`missing = 'ZOSD_H5C_HEAD'.`);
    // a code-kind miss stays deferred
    const code = planStubPass({...base, missingOf: () => true,
      findings: parseFindings(`check_syntax, Class zcl_h5c_far not found, zcl_h5c_stub.clas.abap:12`)});
    expect(code.stubs).to.have.lengthOf(1);
    expect(code.deferred.map((d) => d.name)).to.deep.equal(["ZCL_H5C_FAR"]);
    expect(code.deferred[0].kind).to.equal("clas");
    // and a mixed stub: the code name deferred, the table asked eagerly
    const mixed = planStubPass({...base, missingOf: () => false, asked: () => false,
      findings: parseFindings([
        `check_syntax, Class zcl_h5c_far not found, zcl_h5c_stub.clas.abap:12`,
        `check_syntax, Database table or view "zosd_h5c_head" not found, zcl_h5c_stub.clas.abap:12`,
      ].join("\n"))});
    expect(mixed.stubs).to.have.lengthOf(1);
    expect(mixed.deferred.map((d) => d.name)).to.deep.equal(["ZCL_H5C_FAR"]);
    expect(mixed.eager.map((e) => e.name)).to.deep.equal(["ZOSD_H5C_HEAD"]);
  });

  it("planStubPass: --defer-ddic keeps round 3 -- every name of a stubbed method is lazy", async () => {
    const {planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    const plan = planStubPass({source: STUB_CLASS, findings: findingAt(12), basename: "zcl_h5c_stub.clas.abap",
      missingOf: () => false, asked: () => true, islandFiles: new Set(), excludedObjects: new Set(),
      registered: new Set(), deferDdic: true});
    expect(plan.stubs, "the method is stubbed at once").to.have.lengthOf(1);
    expect(plan.deferred.map((d) => d.name)).to.deep.equal(["ZOSD_H5C_HEAD"]);
    expect(plan.eager).to.deep.equal([]);
  });

  it("exclusionCandidates: definition references with nothing pending hold the file; a live name does not", async () => {
    const {exclusionCandidates} = await import("../tools/hana-closure-exclude.mjs");
    // the structural definition material (references()): a name the
    // request can still bring keeps the file's stubs applying; a settled
    // one holds them for the graph decision
    const file = {object: "ZCL_H5C_DEF", defNames: [{name: "ZOSD_H5C_DEF", kind: "ddic"}], unmatched: []};
    expect(exclusionCandidates({files: [file], pendingOf: () => true}).has("ZCL_H5C_DEF")).to.equal(false);
    expect(exclusionCandidates({files: [file], pendingOf: () => false}).has("ZCL_H5C_DEF")).to.equal(true);
    // method-only findings are no candidate material (the stubs' business)
    expect(exclusionCandidates({files: [{object: "ZCL_H5C_STUB", defNames: [], unmatched: []}], pendingOf: () => false}).size).to.equal(0);
    // definition FINDINGS are material beside the references (the
    // fallback's names ride the same predicate)
    const named = parseFindings(`check_syntax, resolveConstantValue, not found: zif_h5c_organization, zcl_h5c_org_unit.intf.abap:2`);
    expect(exclusionCandidates({files: [{object: "ZIF_H5C_ORG_UNIT", defNames: [], unmatched: named}], pendingOf: () => true}).size).to.equal(0);
    expect(exclusionCandidates({files: [{object: "ZIF_H5C_ORG_UNIT", defNames: [], unmatched: named}], pendingOf: () => false}).has("ZIF_H5C_ORG_UNIT")).to.equal(true);
    // an unmatched finding that names nothing is nameless-root material:
    // held like any other decision material
    const nameless = parseFindings(`parser_error, Statement does not exist in the configured ABAP version(or a parser error), "NOT", zcl_h5c_broken.clas.abap:3`);
    expect(exclusionCandidates({files: [{object: "ZCL_H5C_BROKEN", defNames: [], unmatched: nameless}], pendingOf: () => false}).has("ZCL_H5C_BROKEN")).to.equal(true);
  });

  it("graphDecide: the bed-15 shape -- a root two layers below a cycle and the seed", async () => {
    const {graphDecide} = await import("../tools/hana-closure-graph.mjs");
    // the cycle (A->B->C->A, all present), the seed depending on the cycle,
    // the root R whose definition references an answered-absent name, MID
    // that cannot compile without R, and a class whose GLOBAL FRIENDS names
    // the root: only the root side falls, the cycle and the seed stay
    const objects = [
      {object: "ZCL_H5C_CYC_A", defNames: [], edges: ["ZCL_H5C_CYC_B"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_CYC_B", defNames: [], edges: ["ZCL_H5C_CYC_C"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_CYC_C", defNames: [], edges: ["ZCL_H5C_CYC_A"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_SVC_DPC_EXT", defNames: [], edges: ["ZCL_H5C_CYC_A"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_TEST_BASE", defNames: [{name: "ZOSD_H5C_DEAD", kind: "ddic"}], edges: [], friends: [], nameless: [], findings: ["f"]},
      {object: "ZCL_H5C_TEST_MID", defNames: [], edges: ["ZCL_H5C_TEST_BASE"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_FRIENDING", defNames: [{name: "ZCL_H5C_TEST_BASE", kind: "clas", via: "friends"}], edges: [], friends: ["ZCL_H5C_TEST_BASE"], nameless: [], findings: []},
    ];
    const answers = {
      pendingOf: () => false,
      statusOf: (name) => (name === "ZOSD_H5C_DEAD" ? "absent" : "present"),
      guard: new Set(["ZCL_H5C_SVC_DPC_EXT"]), guardMode: "registration",
    };
    const d = graphDecide({objects, ...answers});
    expect(d.blocked).to.equal(false);
    expect(d.roots).to.deep.equal([{object: "ZCL_H5C_TEST_BASE", missing: ["ZOSD_H5C_DEAD"], nameless: []}]);
    expect(d.cascades).to.deep.equal([{object: "ZCL_H5C_TEST_MID", of: ["ZCL_H5C_TEST_BASE"]}]);
    expect(d.cycles.map((c) => c.members)).to.deep.equal([["ZCL_H5C_CYC_A", "ZCL_H5C_CYC_B", "ZCL_H5C_CYC_C"]]);
    expect(d.cycles[0].kept).to.equal(true);
    expect(d.strips).to.deep.equal([{object: "ZCL_H5C_FRIENDING", of: ["ZCL_H5C_TEST_BASE"]}]);
    expect([...d.excluded].sort()).to.deep.equal(["ZCL_H5C_TEST_BASE", "ZCL_H5C_TEST_MID"]);
    // the gate (item 1): a pending definition-level name blocks every
    // decision -- the bed's iteration-3 exclusion cannot happen any more
    const blocked = graphDecide({objects,
      pendingOf: (name) => name === "ZOSD_H5C_DEAD", statusOf: () => "absent",
      guard: new Set(), guardMode: "registration"});
    expect(blocked.blocked).to.equal(true);
    expect(blocked.roots).to.deep.equal([]);
    // a friend name never roots: an answered-absent FRIEND of an object is
    // strip material, not exclusion material
    const friendGone = graphDecide({objects: [
      {object: "ZCL_H5C_FRIENDING", defNames: [{name: "ZCL_H5C_GONE_FRIEND", kind: "clas", via: "friends"}],
        edges: [], friends: ["ZCL_H5C_GONE_FRIEND"], nameless: [], findings: []},
    ], ...answers, statusOf: () => "absent"});
    expect(friendGone.roots).to.deep.equal([]);
    expect([...friendGone.excluded]).to.deep.equal([]);
    // nameless definition findings (parse garbage) root; a cycle member's
    // do not (its references all resolve -- the cycle record reports it)
    const garbage = graphDecide({objects: [
      {object: "ZCL_H5C_BROKEN", defNames: [], edges: [], friends: [], nameless: ["parser_error, ... zcl_h5c_broken.clas.abap:3"], findings: []},
      {object: "ZCL_H5C_CYC_X", defNames: [], edges: ["ZCL_H5C_CYC_Y"], friends: [], nameless: ["check_syntax, ... x:1"], findings: []},
      {object: "ZCL_H5C_CYC_Y", defNames: [], edges: ["ZCL_H5C_CYC_X"], friends: [], nameless: ["check_syntax, ... y:1"], findings: []},
    ], ...answers, statusOf: () => "present"});
    expect(garbage.roots.map((r) => r.object)).to.deep.equal(["ZCL_H5C_BROKEN"]);
    expect(garbage.cycles.map((c) => c.members)).to.deep.equal([["ZCL_H5C_CYC_X", "ZCL_H5C_CYC_Y"]]);
    // a cycle with a root inside falls whole (the root's fall breaks it)
    const cycleRoot = graphDecide({objects: [
      {object: "ZCL_H5C_KNOT_A", defNames: [{name: "ZOSD_H5C_DEAD", kind: "ddic"}], edges: ["ZCL_H5C_KNOT_B"], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_KNOT_B", defNames: [], edges: ["ZCL_H5C_KNOT_A"], friends: [], nameless: [], findings: []},
    ], ...answers});
    expect([...cycleRoot.excluded].sort()).to.deep.equal(["ZCL_H5C_KNOT_A", "ZCL_H5C_KNOT_B"]);
    expect(cycleRoot.cascades.map((c) => c.object)).to.deep.equal(["ZCL_H5C_KNOT_B"]);
    expect(cycleRoot.cycles).to.deep.equal([]);
    // item 5: a seed service class is never excluded -- as a root or as a
    // cascade; the run fails with the object
    let thrown;
    try {
      graphDecide({objects: [{object: "ZCL_H5C_SVC_DPC_EXT", defNames: [{name: "ZOSD_H5C_DEAD", kind: "ddic"}],
        edges: [], friends: [], nameless: [], findings: []}], ...answers});
      expect.fail("the seed class was excluded");
    } catch (error) { thrown = error; }
    expect(thrown.guard).to.equal(true);
    expect(thrown.message).to.include("ZCL_H5C_SVC_DPC_EXT");
    expect(thrown.message).to.include("gen/hana-segw");
    try {
      graphDecide({objects: [
        {object: "ZCL_H5C_TEST_BASE", defNames: [{name: "ZOSD_H5C_DEAD", kind: "ddic"}], edges: [], friends: [], nameless: [], findings: []},
        {object: "ZCL_H5C_SVC_DPC_EXT", defNames: [], edges: ["ZCL_H5C_TEST_BASE"], friends: [], nameless: [], findings: []},
      ], ...answers});
      expect.fail("the seed class fell with the root");
    } catch (error) { thrown = error; }
    expect(thrown.guard, "the cascade path fails the run the same way").to.equal(true);
  });

  it("analyseIsland: one object's throw is recorded {file, error} and the rest are analysed -- the fixture that makes references() throw (FIX-1)", async () => {
    const {analyseIsland, references} = await import("../tools/hana-closure-graph.mjs");
    // the fixture: a registry whose getObject throws for one island object --
    // exactly what makes analyseObject, and so references(), throw
    const badReg = {getObject: (kind, name) => {
      if (name === "ZCL_H5C_BAD") throw new Error("boom");
      return undefined;
    }};
    expect(() => references(badReg, "/x/zcl_h5c_bad.clas.abap"), "references() itself propagates the throw").to.throw("boom");
    const root = "/x";
    const classPaths = new Map([
      ["zcl_h5c_bad.clas.abap", ["/x/zcl_h5c_bad.clas.abap"]],
      ["zcl_h5c_good.clas.abap", ["/x/zcl_h5c_good.clas.abap"]],
    ]);
    const analysis = analyseIsland({reg: badReg, root, classPaths});
    expect(analysis.errors, "the throw is recorded {file, error}").to.deep.equal([{file: "zcl_h5c_bad.clas.abap", error: "boom"}]);
    expect(analysis.objects.map((o) => o.object), "only the good object is analysed").to.deep.equal(["ZCL_H5C_GOOD"]);
    expect(analysis.byObject.has("ZCL_H5C_BAD"), "the errored object is out of every map: red, unknown cause, never excluded").to.equal(false);
  });

  it("references(): the carriers, per shape, on synthetic objects", async () => {
    const abaplint = await import("@abaplint/core");
    const graph = await import("../tools/hana-closure-graph.mjs");
    const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify({
      global: {files: "/**/*.*"},
      syntax: {version: abaplint.Version.OpenABAP, errorNamespace: "."},
      rules: {},
    })));
    const F = {
      "zif_h5g_present.intf.abap": `
INTERFACE zif_h5g_present PUBLIC.
  METHODS go.
ENDINTERFACE.`,
      "zcl_h5g_edge.clas.abap": `
CLASS zcl_h5g_edge DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run_it.
ENDCLASS.
CLASS zcl_h5g_edge IMPLEMENTATION.
  METHOD run_it.
    RETURN.
  ENDMETHOD.
ENDCLASS.`,
      // every carrier in one object: void object reference, type lookups,
      // a qualified type chain, a missing superclass, GLOBAL FRIENDS, a
      // missing and a present INTERFACES, a signature miss, a body DATA
      "zcl_h5g_full.clas.abap": `
CLASS zcl_h5g_full DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5g_edge GLOBAL FRIENDS zcl_h5g_friend_gone.
  PUBLIC SECTION.
    INTERFACES zif_h5g_intf_missing.
    INTERFACES zif_h5g_present.
    TYPES ty_h5g TYPE zosd_h5g_dtel_missing.
    DATA mo_gone TYPE REF TO zif_h5g_void_missing.
    DATA gv_qual TYPE zif_h5g_qual_missing=>ty_thing.
    METHODS run_it.
    METHODS with_sig IMPORTING iv_h5g TYPE zosd_h5g_sig_missing DEFAULT 1 OPTIONAL.
ENDCLASS.
CLASS zcl_h5g_full IMPLEMENTATION.
  METHOD run_it.
    RETURN.
  ENDMETHOD.
  METHOD with_sig.
    DATA lx_h5g TYPE REF TO zcx_h5g_body_missing.
    RETURN.
  ENDMETHOD.
ENDCLASS.`,
      // a missing superclass: the statement carrier
      "zcl_h5g_supermiss.clas.abap": `
CLASS zcl_h5g_supermiss DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5g_super_missing.
  PUBLIC SECTION.
    METHODS run_it.
ENDCLASS.
CLASS zcl_h5g_supermiss IMPLEMENTATION.
  METHOD run_it.
    RETURN.
  ENDMETHOD.
ENDCLASS.`,
      // the shapes structure does NOT carry (they stay text asks): a
      // SELECT's table, a static call on an absent class
      "zcl_h5g_text.clas.abap": `
CLASS zcl_h5g_text DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run_it.
ENDCLASS.
CLASS zcl_h5g_text IMPLEMENTATION.
  METHOD run_it.
    SELECT SINGLE * FROM ztab_h5g_select_missing INTO @DATA(ls_h5g) ##SUBRC_OK.
    zcl_h5g_static_missing=>do_it( ).
    RETURN.
  ENDMETHOD.
ENDCLASS.`,
    };
    for (const [name, src] of Object.entries(F)) reg.addFile(new abaplint.MemoryFile(name, src));
    reg.parse();
    const refs = graph.references(reg, "zcl_h5g_full.clas.abap");
    const byName = new Map(refs.map((r) => [r.name, r]));
    expect(byName.get("ZIF_H5G_VOID_MISSING"), "a void object reference in a definition attribute").to.include({level: "definition"});
    expect(byName.get("ZOSD_H5G_DTEL_MISSING"), "a type lookup names the type and its fix keyword").to.include({level: "definition", via: "lookup", fix: "lookup"});
    expect(byName.get("ZIF_H5G_QUAL_MISSING"), "a qualified type chain is a qual carrier").to.include({level: "definition", via: "qual"});
    expect(byName.get("ZOSD_H5G_SIG_MISSING"), "a signature-level miss names its method").to.include({level: "signature", method: "WITH_SIG"});
    expect(byName.get("ZOSD_H5G_SIG_MISSING").var).to.equal("IV_H5G");
    expect(byName.get("ZCX_H5G_BODY_MISSING"), "a body DATA names its method").to.include({level: "method", method: "WITH_SIG"});
    // a missing superclass comes off the statement of the object that
    // names it (the full fixture's superclass is present: an edge, below)
    expect(graph.references(reg, "zcl_h5g_supermiss.clas.abap").map((u) => [u.name, u.via])).to.deep.equal(
      [["ZCL_H5G_SUPER_MISSING", "super"]]);
    expect(byName.get("ZCL_H5G_FRIEND_GONE"), "a friend name is a soft unknown").to.include({level: "definition", via: "friends"});
    expect(byName.get("ZIF_H5G_INTF_MISSING").ooType, "the OO carrier says the object type").to.equal("INTF");
    // what no scope records -- the shapes the text fallback keeps
    expect(graph.references(reg, "zcl_h5g_text.clas.abap"), "a SELECT's table and a static call record nothing").to.deep.equal([]);
    // request kinds: ooType beats the prefix heuristic, the fix keyword
    // keeps the DDIC split, the prefix heuristic takes the rest
    expect(graph.requestKindOf("ZIF_H5G_INTF_MISSING", byName.get("ZIF_H5G_INTF_MISSING"))).to.equal("intf");
    expect(graph.requestKindOf("ZOSD_H5G_DTEL_MISSING", byName.get("ZOSD_H5G_DTEL_MISSING"))).to.equal("ddic");
    // a qualified type chain's carrier is the UnknownType: no ooType, so
    // the name prefix decides -- the same CLAS the old classifier gave a
    // ZIF_ name (presence checks both suffixes)
    expect(graph.requestKindOf("ZIF_H5G_QUAL_MISSING", byName.get("ZIF_H5G_QUAL_MISSING"))).to.equal("clas");
    expect(graph.requestKindOf("ZCL_H5G_SUPER_MISSING", {via: "super"})).to.equal("clas");
    expect(graph.requestKindOf("ZOSD_H5G_ANY", {})).to.equal("ddic");
    expect(graph.requestKindOf("ZOSD_H5G_ANY", {kind: "table"})).to.equal("tabl");
    // the resolved edges: the superclass, the present interfaces, the
    // attribute's TYPE REF TO -- definition level
    const analysis = graph.analyseObject(reg, "zcl_h5g_full.clas.abap");
    const edges = analysis.perFile.get("zcl_h5g_full.clas.abap").edges.filter((e) => e.level === "definition").map((e) => e.to);
    expect(edges).to.include("ZCL_H5G_EDGE");
    expect(edges).to.include("ZIF_H5G_PRESENT");
    expect(graph.analyseIsland({reg, root: "/r", classPaths: new Map([
      ["zcl_h5g_full.clas.abap", ["/r/gen/hana-src/000-x/src/zcl_h5g_full.clas.abap"]],
      ["zif_h5g_present.intf.abap", ["/r/gen/hana-src/000-x/src/zif_h5g_present.intf.abap"]],
    ])}).objects.map((o) => [o.object, o.kind])).to.deep.equal(
      [["ZCL_H5G_FULL", "CLAS"], ["ZIF_H5G_PRESENT", "INTF"]]);
  });

  it("references(): an INTERFACES include is asked as INTF, and an interface's METHODS parameter types are read (H5x-4 B1)", async () => {
    // bed run 21's shape at fixture scale: an interface that includes
    // another one the build lacks, and an interface whose METHODS parameter
    // is typed off an absent interface. Inside an INTERFACE definition the
    // checker stops at the first unknown include and records nothing, and
    // an interface's parameters live on its definition only -- neither
    // reached the request, the control build named both, rc=1.
    const abaplint = await import("@abaplint/core");
    const graph = await import("../tools/hana-closure-graph.mjs");
    const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify({
      global: {files: "/**/*.*"},
      syntax: {version: abaplint.Version.OpenABAP, errorNamespace: "."},
      rules: {},
    })));
    const F = {
      "zif_h5c_inc_present.intf.abap": `
INTERFACE zif_h5c_inc_present PUBLIC.
  TYPES ty_h5c TYPE i.
ENDINTERFACE.`,
      "zif_h5c_inc_outer.intf.abap": `
INTERFACE zif_h5c_inc_outer PUBLIC.
  TYPES ty_h5c_one TYPE i.
  TYPES ty_h5c_two TYPE i.
  INTERFACES zif_h5c_inc_present.
  INTERFACES zif_h5c_inc_missing.
  INTERFACES zif_h5c_inc_missing2.
ENDINTERFACE.`,
      "zif_h5c_inc_sig.intf.abap": `
INTERFACE zif_h5c_inc_sig PUBLIC.
  METHODS get_it EXPORTING et_h5c TYPE zif_h5c_inc_qual_missing=>tt_h5c.
ENDINTERFACE.`,
      // a class's locals define an interface of their own: no global ask
      "zcl_h5c_inc_local.clas.abap": `
CLASS zcl_h5c_inc_local DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run_it.
ENDCLASS.
CLASS zcl_h5c_inc_local IMPLEMENTATION.
  METHOD run_it.
    RETURN.
  ENDMETHOD.
ENDCLASS.`,
      "zcl_h5c_inc_local.clas.locals_def.abap": `
INTERFACE lif_h5c_local.
  METHODS go.
ENDINTERFACE.
CLASS lcl_h5c_local DEFINITION.
  PUBLIC SECTION.
    INTERFACES lif_h5c_local.
ENDCLASS.`,
    };
    for (const [name, src] of Object.entries(F)) reg.addFile(new abaplint.MemoryFile(name, src));
    reg.parse();
    const outer = graph.references(reg, "zif_h5c_inc_outer.intf.abap");
    expect(outer.map((r) => [r.name, r.level, r.via, r.ooType, r.line]), "both missing includes, none of the present one").to.deep.equal([
      ["ZIF_H5C_INC_MISSING", "definition", "interfaces", "INTF", 6],
      ["ZIF_H5C_INC_MISSING2", "definition", "interfaces", "INTF", 7],
    ]);
    expect(graph.requestKindOf("ZIF_H5C_INC_MISSING", outer[0]), "asked as INTF").to.equal("intf");
    const edges = graph.analyseObject(reg, "zif_h5c_inc_outer.intf.abap").perFile.get("zif_h5c_inc_outer.intf.abap").edges;
    expect(edges.filter((e) => e.level === "definition").map((e) => e.to), "a present include is a definition edge").to.include("ZIF_H5C_INC_PRESENT");
    const sig = graph.references(reg, "zif_h5c_inc_sig.intf.abap");
    expect(sig.map((r) => [r.name, r.level, r.via, r.method, r.var]), "the parameter's qualified type top").to.deep.equal([
      ["ZIF_H5C_INC_QUAL_MISSING", "signature", "qual", "GET_IT", "ET_H5C"],
    ]);
    expect(graph.references(reg, "zcl_h5c_inc_local.clas.abap").filter((r) => /LIF_H5C/.test(r.name)), "a local interface is never asked").to.deep.equal([]);
    // and the loop's merge: the finding of the include sits on the
    // INTERFACE statement's line (measured), structural-matched by name
    const findings = parseFindings([
      "check_syntax, Interface zif_h5c_inc_missing unknown, zif_h5c_inc_outer.intf.abap:2",
    ].join("\n"));
    const analysis = graph.analyseIsland({reg, root: "/r", classPaths: new Map([
      ["zif_h5c_inc_outer.intf.abap", ["/r/gen/hana-src/000-x/src/zif_h5c_inc_outer.intf.abap"]],
    ])});
    const merged = graph.mergeNames({analysis, findings, classPaths: new Map([["zif_h5c_inc_outer.intf.abap", []]])});
    expect(merged.names.map((n) => [n.name, n.kind])).to.deep.equal([["ZIF_H5C_INC_MISSING", "intf"], ["ZIF_H5C_INC_MISSING2", "intf"]]);
    expect(merged.structuralCount, "the include's finding is structural, never unclassified").to.equal(1);
    // one definition edge per present include (the scope walk may carry it too)
    expect(edges.filter((e) => e.to === "ZIF_H5C_INC_PRESENT" && e.level === "definition")).to.have.lengthOf(1);
  });

  it("mergeNames matches an INTERFACES include's finding on its exact name only -- a name it merely prefixes is still asked (critic M1, #939)", async () => {
    const abaplint = await import("@abaplint/core");
    const graph = await import("../tools/hana-closure-graph.mjs");
    const reg = new abaplint.Registry(new abaplint.Config(JSON.stringify({
      global: {files: "/**/*.*"},
      syntax: {version: abaplint.Version.OpenABAP, errorNamespace: "."},
      rules: {},
    })));
    reg.addFile(new abaplint.MemoryFile("zif_h5r_long.intf.abap", [
      "INTERFACE zif_h5r_long PUBLIC.",
      "  INTERFACES zif_h5r_x.",
      "  TYPES ty_h5r_1 TYPE i.",
      "  TYPES ty_h5r_2 TYPE i.",
      "  TYPES ty_h5r_3 TYPE i.",
      "  TYPES ty_h5r_4 TYPE i.",
      "  TYPES ty_h5r_5 TYPE i.",
      "  TYPES ty_h5r_6 TYPE i.",
      "  TYPES ty_h5r_7 TYPE i.",
      "  METHODS m.",
      "ENDINTERFACE.",
    ].join("\n")));
    reg.parse();
    const classPaths = new Map([["zif_h5r_long.intf.abap", ["/r/gen/hana-src/000-x/src/zif_h5r_long.intf.abap"]]]);
    const analysis = graph.analyseIsland({reg, root: "/r", classPaths});
    const findings = parseFindings([
      "check_syntax, Interface zif_h5r_x unknown, zif_h5r_long.intf.abap:1",
      "check_syntax, Unknown class zif_h5r_x_lcl, zif_h5r_long.intf.abap:10",
      "check_syntax, Interface zif_h5r_x_tt unknown, zif_h5r_long.intf.abap:10",
    ].join("\n"));
    const merged = graph.mergeNames({analysis, findings, classPaths});
    expect(merged.structuralCount, "only the include's own finding is structural").to.equal(1);
    expect(merged.rest.map((f) => f.line)).to.deep.equal([10, 10]);
    expect(classifyFindings(merged.rest).names.map((n) => [n.name, n.kind]), "the prefixed names are asked").to.deep.equal(
      [["ZIF_H5R_X_LCL", "clas"], ["ZIF_H5R_X_TT", "intf"]]);
  });

  it("the fallback asks `Interface X unknown` as INTF when no reference carried it (H5x-4 B1)", () => {
    const {names, unclassified} = classifyFindings(parseFindings([
      "check_syntax, Interface ZIF_H5C_INC_TEXT unknown, zif_h5c_inc_text.intf.abap:2",
      "check_syntax, Unknown class zcl_h5c_inc_text, zcl_h5c_inc_user.clas.abap:9",
    ].join("\n")));
    expect(names.map((n) => [n.name, n.kind])).to.deep.equal([["ZIF_H5C_INC_TEXT", "intf"], ["ZCL_H5C_INC_TEXT", "clas"]]);
    expect(unclassified).to.deep.equal([]);
  });

  it("the stub record holds each (class, method) once: latest finding wins, rounds counted (H5x-4 B1)", async () => {
    const {recordStub, stubList} = await import("../tools/hana-closure-report.mjs");
    const {frameworkGapList} = await import("../tools/hana-closure-stubs.mjs");
    const record = new Map();
    // bed run 21: the same method re-stubbed once per iteration
    for (let round = 1; round <= 3; round++) {
      recordStub(record, {object: "ZCL_H5C_SVC_DPC_EXT", class: "ZCL_H5C_SVC_DPC_EXT", method: "HEADS_GET_ENTITY", missing: [`R${round}`], finding: `f${round}`});
    }
    recordStub(record, {object: "ZCL_H5C_SVC_DPC_EXT", class: "ZCL_H5C_SVC_DPC_EXT", method: "ORDERS_GET_ENTITY", missing: [], finding: "g"});
    recordStub(record, {object: "ZCL_H5C_SVC_DPC_EXT", class: "lcl_h5c_helper", method: "ORDERS_GET_ENTITY", missing: [], finding: "h"});
    const list = stubList(record);
    expect(list).to.have.lengthOf(3);
    expect(list[0]).to.include({method: "HEADS_GET_ENTITY", finding: "f3", rounds: 3});
    expect(list[0].missing).to.deep.equal(["R3"]);
    expect(list.map((s) => s.rounds)).to.deep.equal([3, 1, 1]);
    // a framework gap's use is listed once, however many rounds met it
    const gaps = new Map([["Method \"x\" not found", {finding: "Method \"x\" not found", used_by: [
      {file: "a.clas.abap", line: 3, method: "M"}, {file: "a.clas.abap", line: 3, method: "M"}, {file: "a.clas.abap", line: 9, method: "N"}]}]]);
    expect(frameworkGapList(gaps)[0].used_by).to.have.lengthOf(2);
  });

  it("the run summary fails on a missing or excluded seed class and on a stubbed --require-unstubbed method (H5x-4 B1)", async () => {
    const {closureSummary, unstubbedGlob, takeAll} = await import("../tools/hana-closure-report.mjs");
    const seeds = new Set(["ZCL_H5C_SVC_DPC", "ZCL_H5C_SVC_DPC_EXT", "ZCL_H5C_SVC_MPC"]);
    const island = new Set(["ZCL_H5C_SVC_DPC", "ZCL_H5C_SVC_DPC_EXT", "ZCL_H5C_SVC_MPC"]);
    const stubs = [
      {object: "ZCL_H5C_SVC_DPC_EXT", class: "ZCL_H5C_SVC_DPC_EXT", method: "HEADS_GET_ENTITY", rounds: 2},
      {object: "ZCL_H5C_OTHER", class: "ZCL_H5C_OTHER", method: "X_GET_ENTITYSET", rounds: 1},
    ];
    const base = {iterations: 4, islandObjects: {total: 9}, seeds, present: (n) => island.has(n), excluded: new Set(), stubs,
      gaps: [{name: "ZOSD_H5C_GAP", kind: "TTYP", first_finding: "x"}]};
    const ok = closureSummary({...base, requireUnstubbed: ["*_GET_ENTITYSET"]});
    expect(ok.failures, "a non-seed GET_ENTITYSET stub is no seed failure").to.deep.equal([]);
    expect(ok).to.include({fixed_point: true, iterations: 4, stubs_unique: 2});
    expect(ok.seed).to.deep.equal({classes: [...seeds].sort(), stubbed_methods: [{class: "ZCL_H5C_SVC_DPC_EXT", method: "HEADS_GET_ENTITY"}]});
    expect(ok.gaps).to.deep.equal([{name: "ZOSD_H5C_GAP", kind: "TTYP"}]);
    const stubbed = closureSummary({...base, requireUnstubbed: ["*_GET_ENTITY", "*_GET_ENTITYSET"]});
    expect(stubbed.failures).to.have.lengthOf(1);
    expect(stubbed.failures[0]).to.include("*_GET_ENTITY").and.include("ZCL_H5C_SVC_DPC_EXT=>HEADS_GET_ENTITY");
    const missing = closureSummary({...base, present: (n) => n !== "ZCL_H5C_SVC_MPC" && island.has(n)});
    expect(missing.failures).to.deep.equal(["seed class ZCL_H5C_SVC_MPC is not an island object"]);
    // a base derived off an _EXT name, named by no source: absent is no failure
    const derived = closureSummary({...base, named: new Set(["ZCL_H5C_SVC_DPC_EXT", "ZCL_H5C_SVC_MPC"]),
      present: (n) => n !== "ZCL_H5C_SVC_DPC" && island.has(n)});
    expect(derived.failures).to.deep.equal([]);
    const excluded = closureSummary({...base, excluded: new Set(["ZCL_H5C_SVC_DPC"])});
    expect(excluded.failures).to.deep.equal(["seed class ZCL_H5C_SVC_DPC is excluded from the build"]);
    expect(excluded.excluded).to.deep.equal(["ZCL_H5C_SVC_DPC"]);
    expect(unstubbedGlob("zcl_h5c_svc_dpc_ext=>heads_*")("ZCL_H5C_SVC_DPC_EXT", "HEADS_GET_ENTITY")).to.equal(true);
    expect(unstubbedGlob("*_GET_ENTITYSET")("ZCL_H5C_SVC_DPC_EXT", "HEADS_GET_ENTITY")).to.equal(false);
    expect(unstubbedGlob("HEADS_GET_ENTIT?")("Z", "heads_get_entity")).to.equal(true);
    const args = ["--require-unstubbed", "a", "--x", "--require-unstubbed", "b"];
    expect(takeAll(args, "--require-unstubbed")).to.deep.equal(["a", "b"]);
    expect(args).to.deep.equal(["--x"]);
  });

  it("stripFriends and cutSignatureParams: the clause or the parameter goes, the statement stays", async () => {
    const {stripFriends, cutSignatureParams} = await import("../tools/hana-closure-graph.mjs");
    const source = [
      `CLASS zcl_h5g_cut DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5g_base GLOBAL FRIENDS zcl_h5g_gone zcl_h5g_kept.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `    METHODS with_sig IMPORTING iv_h5g TYPE zosd_h5g_sig DEFAULT 1 OPTIONAL.`,
      `    METHODS two_sig IMPORTING iv_a TYPE zosd_h5g_a OPTIONAL iv_b TYPE i OPTIONAL.`,
      `ENDCLASS.`,
      `CLASS zcl_h5g_cut IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `  METHOD with_sig.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `  METHOD two_sig.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n").replace(/\\n/g, "\n");
    // a subset of the friends goes, the clause and the kept friend stay
    const strip = stripFriends(source, "zcl_h5g_cut.clas.abap", (n) => n === "ZCL_H5G_GONE");
    expect(strip.stripped).to.deep.equal(["ZCL_H5G_GONE"]);
    expect(strip.source.split("\n")[0]).to.equal(
      `CLASS zcl_h5g_cut DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5g_base GLOBAL FRIENDS zcl_h5g_kept.`);
    // every friend gone: the whole GLOBAL FRIENDS words go
    const all = stripFriends(source, "zcl_h5g_cut.clas.abap", () => true);
    expect(all.stripped).to.deep.equal(["ZCL_H5G_GONE", "ZCL_H5G_KEPT"]);
    expect(all.source.split("\n")[0]).to.equal(
      `CLASS zcl_h5g_cut DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5g_base.`);
    // one parameter cut, the DEFAULT and OPTIONAL going with it
    const cut = cutSignatureParams(source, "zcl_h5g_cut.clas.abap", "WITH_SIG", ["IV_H5G"]);
    expect(cut.cut).to.deep.equal(["IV_H5G"]);
    expect(cut.source.split("\n")[3]).to.equal(`    METHODS with_sig.`);
    // the parameter after the cut one keeps its clause keyword
    const two = cutSignatureParams(source, "zcl_h5g_cut.clas.abap", "TWO_SIG", ["IV_A"]);
    expect(two.source.split("\n")[4]).to.equal(`    METHODS two_sig IMPORTING iv_b TYPE i OPTIONAL.`);
    // nothing gone, nothing cut: the source stands
    expect(stripFriends(source, "zcl_h5g_cut.clas.abap", () => false).source).to.equal(source);
    expect(cutSignatureParams(source, "zcl_h5g_cut.clas.abap", "RUN_IT", ["IV_X"]).source).to.equal(source);
  });

  it("planStubPass: a method whose findings name nothing is stubbed, the raise carrying the finding text (S-3)", async () => {
    const {planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    // the bed's DPC_EXT shape: members the clean-room framework layer lacks
    // name nothing the dumper could bring. Round 7 stubbed such methods;
    // H5x-1's first cut kept their bodies forever (78 -> 52 stubs).
    const source = [
      `CLASS zcl_h5c_dpc DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS get_rows.`,
      `    METHODS fill_head.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_dpc IMPLEMENTATION.`,
      `  METHOD get_rows.`,
      `    DATA ls_h5c TYPE i.`,
      `    ls_h5c = 1.`,
      `  ENDMETHOD.`,
      `  METHOD fill_head.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const findings = parseFindings([
      `check_syntax, Component "zz_h5c_field" not found in structure, zcl_h5c_dpc.clas.abap:8`,
      `check_syntax, Method "get_h5c_thing" not found, methodCallChain, zcl_h5c_dpc.clas.abap:9`,
    ].join("\n"));
    const base = {source, findings, basename: "zcl_h5c_dpc.clas.abap",
      asked: () => true, islandFiles: new Set(), excludedObjects: new Set(), registered: new Set()};
    const plan = planStubPass({...base, missingOf: () => false});
    expect(plan.stubs, "the nameless method is stubbed again (round-7 equal)").to.have.lengthOf(1);
    expect(plan.stubs[0].method).to.equal("GET_ROWS");
    expect(plan.stubs[0].missing, "the cascades name nothing").to.deep.equal([]);
    expect(plan.eager).to.deep.equal([]);
    expect(plan.deferred).to.deep.equal([]);
    expect(plan.source).to.contain(`missing = 'Component "zz_h5c_field" not found in structure'`);
    expect(plan.source, "a raise never says needs ''").to.not.contain(`missing = ''`);
    // a sibling method with a name this iteration's request can still bring
    // keeps its body; only the nameless method is stubbed
    const mixed = planStubPass({...base, asked: () => false, missingOf: () => false,
      findings: parseFindings([
        `check_syntax, Component "zz_h5c_field" not found in structure, zcl_h5c_dpc.clas.abap:8`,
        `check_syntax, Database table or view "zosd_h5c_head" not found, zcl_h5c_dpc.clas.abap:13`,
      ].join("\n"))});
    expect(mixed.stubs, "only the nameless method is stubbed").to.have.lengthOf(1);
    expect(mixed.stubs[0].method).to.equal("GET_ROWS");
    expect(mixed.source, "the waiting method's body stays").to.contain("RETURN.");
  });

  it("planStubPass + candidates: the R5 shape -- a dead definition name beside a cascade-only method", async () => {
    const {planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    const {exclusionCandidates} = await import("../tools/hana-closure-exclude.mjs");
    // a dead definition name AND a cascade-only method finding: round 0's
    // stubs.length === 0 gate kept such a file in the build forever; fix
    // round 1 decided the exclusion on the definition findings alone. Fix
    // round 2 splits the two: the plan stubs the method, the candidate
    // check holds the file so the stub never lands before the decision
    const source = [
      `CLASS zcl_h5c_mix DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    DATA go_h5c TYPE REF TO zcl_h5c_gone.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_mix IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    DATA ls_h5c TYPE i.`,
      `    ls_h5c = 1.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const findings = parseFindings([
      `unknown_types, Variable "GO_H5C" contains unknown: REF, unable to resolve zcl_h5c_gone, zcl_h5c_mix.clas.abap:3`,
      `check_syntax, Method "do_h5c" not found, methodCallChain, zcl_h5c_mix.clas.abap:9`,
    ].join("\n"));
    const base = {source, findings, basename: "zcl_h5c_mix.clas.abap",
      islandFiles: new Set(), excludedObjects: new Set()};
    const plan = planStubPass({...base, missingOf: (name) => name === "ZCL_H5C_GONE", asked: () => true});
    expect(plan.unmatched, "the definition finding is the decision's material").to.have.lengthOf(1);
    expect(plan.stubs, "the method is stubbable").to.have.lengthOf(1);
    // the dead name is the structural definition material (references());
    // the finding text itself names nothing the fallback asks any more
    expect(exclusionCandidates({files: [{object: "ZCL_H5C_MIX", defNames: [{name: "ZCL_H5C_GONE", kind: "clas"}], unmatched: plan.unmatched}],
      pendingOf: () => false}).has("ZCL_H5C_MIX"), "the dead name is answered: the file is held").to.equal(true);
    // a LIVE definition name beside a real stub: not held -- the stub
    // applies, the name waits
    const live = planStubPass({...base, missingOf: (name) => name !== "ZCL_H5C_GONE", asked: () => false});
    expect(live.unmatched).to.have.lengthOf(1);
    expect(live.stubs).to.have.lengthOf(1);
    expect(exclusionCandidates({files: [{object: "ZCL_H5C_MIX", defNames: [{name: "ZCL_H5C_GONE", kind: "clas"}], unmatched: live.unmatched}],
      pendingOf: (name) => name === "ZCL_H5C_GONE"}).has("ZCL_H5C_MIX"), "the live name waits").to.equal(false);
  });

  it("a name whose object is in the island is dropped and counted: cascade (present)", async () => {
    const {dropPresentNames, abapBaseOf, objectFilePresent} = await import("../tools/hana-closure-stubs.mjs");
    expect(abapBaseOf("/ZOSD/H5C_T_NAVI"), "the namespace escaped as #ns#").to.equal("#zosd#h5c_t_navi");
    expect(abapBaseOf("ZIF_H5C_BO")).to.equal("zif_h5c_bo");
    const files = new Set(["zif_h5c_present.intf.abap", "zosd_h5c_head.tabl.xml", "#zosd#h5c_t_navi.tabl.xml"]);
    expect(objectFilePresent("ZIF_H5C_PRESENT", "intf", files)).to.equal(true);
    // the classified kind of a ZIF_ name is the prefix heuristic's `clas`
    // (`Could not resolve top zif_h5c_present` names it CLAS) -- a code kind
    // is present as .clas.abap OR .intf.abap, or every customer interface is
    // asked again every round (fix round 1, M-1.4)
    expect(objectFilePresent("ZIF_H5C_PRESENT", "clas", files), "a code kind finds either file").to.equal(true);
    expect(objectFilePresent("ZOSD_H5C_HEAD", "tabl", files)).to.equal(true);
    expect(objectFilePresent("/ZOSD/H5C_T_NAVI", "tabl", files)).to.equal(true);
    expect(objectFilePresent("ZOSD_H5C_W", "ddic", files), "no XML of the kinds the request asks under").to.equal(false);
    const {names: kept, present} = dropPresentNames([
      {name: "ZIF_H5C_PRESENT", kind: "intf"},
      {name: "ZOSD_H5C_HEAD", kind: "tabl"},
      {name: "ZIF_H5C_ABSENT", kind: "intf"},
      {name: "ZOSD_H5C_OTHER", kind: "tabl"},
    ], files);
    expect(kept.map((n) => n.name)).to.deep.equal(["ZIF_H5C_ABSENT", "ZOSD_H5C_OTHER"]);
    expect(present, "counted, not asked").to.equal(2);
    // an object excluded this run is not present: its name is dead downstream
    const gone = dropPresentNames([{name: "ZIF_H5C_PRESENT", kind: "intf"}], files, new Set(["ZIF_H5C_PRESENT"]));
    expect(gone.names).to.deep.equal([]);
    expect(gone.present).to.equal(0);
  });

  it("planStubPass: the nameless stubs' findings come back as framework-gap entries, the quoted member extracted", async () => {
    const {planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    // the members the clean-room framework layer lacks: a method the runtime
    // interface does not carry, a changeset component, a message container
    const source = [
      `CLASS zcl_h5c_gaps DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS get_rows.`,
      `    METHODS get_ctx.`,
      `    METHODS get_main.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_gaps IMPLEMENTATION.`,
      `  METHOD get_rows.`,
      `    me->get_h5c_thing( ).`,
      `  ENDMETHOD.`,
      `  METHOD get_ctx.`,
      `    DATA ls_h5c TYPE zosd_h5c_ctx.`,
      `    ls_h5c-h5c_thing = 1.`,
      `  ENDMETHOD.`,
      `  METHOD get_main.`,
      `    me->mo_h5c_ctx->run( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const findings = parseFindings([
      `check_syntax, Method "get_h5c_thing" not found, methodCallChain, zcl_h5c_gaps.clas.abap:9`,
      `check_syntax, Component "h5c_thing" not found in structure, zcl_h5c_gaps.clas.abap:13`,
      `check_syntax, Attribute or constant "mo_h5c_ctx" not found in "zcl_h5c_gaps", zcl_h5c_gaps.clas.abap:16`,
      `unknown_types, Variable "LS_H5C" contains unknown: TY_S_H5C_ROW not found in class or interface, zcl_h5c_gaps.clas.abap:12`,
    ].join("\n"));
    const plan = planStubPass({source, findings, basename: "zcl_h5c_gaps.clas.abap",
      missingOf: () => false, asked: () => true, islandFiles: new Set(), excludedObjects: new Set(), registered: new Set()});
    expect(plan.stubs, "three methods, all nameless: all stubbed").to.have.lengthOf(3);
    expect(plan.nameless, "one entry per distinct nameless finding text, sorted").to.deep.equal([
      {finding: `Attribute or constant "mo_h5c_ctx" not found in "zcl_h5c_gaps"`, member: "mo_h5c_ctx", line: 16, method: "GET_MAIN"},
      {finding: `Component "h5c_thing" not found in structure`, member: "h5c_thing", line: 13, method: "GET_CTX"},
      {finding: `Method "get_h5c_thing" not found`, member: "get_h5c_thing", line: 9, method: "GET_ROWS"},
      {finding: `Variable "LS_H5C" contains unknown: TY_S_H5C_ROW not found in class or interface`, line: 12, method: "GET_CTX"},
    ]);
  });

  it("planStubPass: body stubs and a signature stub land in one pass over one parse (the bed-17 shape, FIX-1)", async () => {
    const {methodBlocks, planStubPass} = await import("../tools/hana-closure-stubs.mjs");
    // bed run 17's shape in miniature: a class whose body stubs move its
    // lines while a signature stub still carries rows from the same parse.
    // Applying the two stub lists in two passes computed the signature
    // stub's offsets against the pre-rewrite source and ran offsetAt past
    // the shrunken source's end (`Cannot read properties of undefined
    // (reading 'length')`). The bodies sit before the signature-missed
    // method and carry most of the file's lines -- the geometry that moved
    // the file's end.
    const body = (n) => Array.from({length: n}, (_, i) => `    lv_x = ${i}.`).join("\n");
    const source = [
      "CLASS zcl_h5c_both DEFINITION PUBLIC FINAL CREATE PUBLIC.",
      "  PUBLIC SECTION.",
      "    METHODS run_a.",
      "    METHODS run_b.",
      "    METHODS sig_z",
      "      IMPORTING iv_dead TYPE zosd_h5c_dead.",
      "ENDCLASS.",
      "CLASS zcl_h5c_both IMPLEMENTATION.",
      "  METHOD run_a.",
      body(20),
      "  ENDMETHOD.",
      "  METHOD run_b.",
      body(20),
      "  ENDMETHOD.",
      "  METHOD sig_z.",
      "    RETURN.",
      "  ENDMETHOD.",
      "ENDCLASS.",
    ].join("\n") + "\n";
    const findings = parseFindings([
      `unknown_types, Variable "LV_X" contains unknown: ZOSD_H5C_DEAD not found, lookup, zcl_h5c_both.clas.abap:15`,
      `unknown_types, Variable "LV_X" contains unknown: ZOSD_H5C_DEAD not found, lookup, zcl_h5c_both.clas.abap:40`,
    ].join("\n"));
    const refs = [
      {name: "ZOSD_H5C_DEAD", kind: "type", line: 6, level: "signature", method: "SIG_Z", via: "lookup", var: "IV_DEAD"},
    ];
    const plan = planStubPass({source, findings, basename: "zcl_h5c_both.clas.abap", refs,
      missingOf: (name) => name === "ZOSD_H5C_DEAD", asked: () => true, refusedOf: () => false,
      islandFiles: new Set(), excludedObjects: new Set(), goneOf: () => false});
    expect(plan.stubs, "two body stubs and the signature stub").to.have.lengthOf(3);
    expect(plan.stubs.filter((s) => s.signature === true).map((s) => s.method)).to.deep.equal(["SIG_Z"]);
    expect((plan.source.match(/RAISE EXCEPTION TYPE zcx_osd_not_activated/g) ?? []).length,
      "all three raises are in the rewritten source").to.equal(3);
    expect(methodBlocks(plan.source).map((b) => b.method), "the result still parses, three blocks").to.deep.equal(["RUN_A", "RUN_B", "SIG_Z"]);
    expect(plan.source.includes("IMPORTING iv_dead"), "the parameter's clause is cut").to.equal(false);
    expect(/METHODS sig_z\s*\./.test(plan.source), "the METHODS statement stays").to.equal(true);
  });

  it("the seam reads the six-section record from OSD_HANA_CLOSURE_OUT -- the loop's --out -- not only the fixed path (S-1)", async () => {
    const {closureStubs, closureStubsFile, definitionExclusions, excludedFiles} = await import("../tools/hana-closure-exclusions.mjs");
    const root = mkdtempSync(join(tmpdir(), "hana-closure-seam-"));
    const saved = process.env.OSD_HANA_CLOSURE_OUT;
    try {
      const record = {
        roots: [{level: "definition", object: "ZCL_H5C_DEFX", kind: "CLAS", file: "gen/hana-src/000-x/src/zcl_h5c_defx.clas.abap", missing: ["ZOSD_H5C_DEAD"], findings: ["f"]}],
        cascades: [
          {level: "cascade", object: "ZCL_H5C_FALL", kind: "CLAS", file: "gen/hana-src/000-x/src/zcl_h5c_fall.clas.abap", of: ["ZCL_H5C_DEFX"], findings: [], excluded: true},
          {level: "cascade", object: "ZCL_H5C_STRIP", kind: "CLAS", file: "gen/hana-src/000-x/src/zcl_h5c_strip.clas.abap", of: ["ZCL_H5C_DEFX"], edge: "friends", action: "strip-friends", findings: [], excluded: false},
        ],
        cycles: [], stubs: [{object: "ZCL_H5C_DEFX", method: "RUN", missing: ["ZOSD_H5C_DEAD"]}], waits: [],
        errors: [{file: "gen/hana-src/000-x/src/zcl_h5c_badx.clas.abap", error: "boom"}],
        excluded: {CLAS: ["ZCL_H5C_DEFX", "ZCL_H5C_FALL"]},
      };
      mkdirSync(join(root, "gen", "hana-closure"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-closure", "closure-stubs.json"), JSON.stringify(record) + "\n");
      expect(closureStubsFile(root), "without the var, the fixed path").to.equal(join(root, "gen", "hana-closure", "closure-stubs.json"));
      expect(definitionExclusions(root).map((e) => e.object), "roots and the cascades excluded with them; a FRIENDS strip is a record, not an exclusion").to.deep.equal(
        ["ZCL_H5C_DEFX", "ZCL_H5C_FALL"]);
      expect(closureStubs(root).errors, "the errors ride the record (FIX-1), an error excludes nothing").to.deep.equal(
        [{file: "gen/hana-src/000-x/src/zcl_h5c_badx.clas.abap", error: "boom"}]);
      expect(excludedFiles(root)).to.deep.equal(
        ["gen/hana-src/000-x/src/zcl_h5c_defx.clas.abap", "gen/hana-src/000-x/src/zcl_h5c_fall.clas.abap"]);
      const other = join(root, "closure-out");
      mkdirSync(other, {recursive: true});
      writeFileSync(join(other, "closure-stubs.json"), JSON.stringify({roots: [], cascades: [], cycles: [], stubs: [], waits: [], excluded: {}}) + "\n");
      process.env.OSD_HANA_CLOSURE_OUT = other;
      expect(closureStubsFile(root), "the env var moves the seam").to.equal(join(other, "closure-stubs.json"));
      expect(definitionExclusions(root), "the loop's --out record is the one the build reads").to.deep.equal([]);
      delete process.env.OSD_HANA_CLOSURE_OUT;
      expect(definitionExclusions(root, join(other, "closure-stubs.json")), "the explicit file, the loop's in-process channel").to.deep.equal([]);
      expect(definitionExclusions(root)).to.have.lengthOf(2);
      // a record an H5x-1 iterator wrote (an array of records) still reads
      writeFileSync(join(root, "gen", "hana-closure", "closure-stubs.json"), JSON.stringify([
        {level: "definition", object: "ZCL_H5C_OLD", file: "gen/hana-src/000-x/src/zcl_h5c_old.clas.abap", findings: ["f"]},
        {level: "method", file: "f.clas.abap", class: "ZCL_H5C_OLD", method: "M", missing: [], finding: "f"},
      ]) + "\n");
      expect(definitionExclusions(root).map((e) => e.object)).to.deep.equal(["ZCL_H5C_OLD"]);
      expect(excludedFiles(root)).to.deep.equal(["gen/hana-src/000-x/src/zcl_h5c_old.clas.abap"]);
    } finally {
      if (saved === undefined) delete process.env.OSD_HANA_CLOSURE_OUT;
      else process.env.OSD_HANA_CLOSURE_OUT = saved;
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the exclusions join the generation hash (S-2): a record renames the generation", async function () {
    this.timeout(60000);
    const {hashOf} = await import("../tools/osd-build.mjs");
    const plain = hashOf(process.cwd());
    const withGap = hashOf(process.cwd(), undefined, {exclusions: ["gen/hana-src/000-x/src/zcl_h5c_defx.clas.abap"]});
    expect(withGap, "an exclusion is a build input in all but name").to.not.equal(plain);
    expect(hashOf(process.cwd(), undefined, {exclusions: []}), "an empty list changes nothing").to.equal(plain);
    expect(hashOf(process.cwd(), undefined, {exclusions: ["a"]}))
      .to.not.equal(hashOf(process.cwd(), undefined, {exclusions: ["b"]}));
  });

  it("the registered service's own classes come from the gen/hana-segw facts and the island's IWSV/IWMO XML", async () => {
    const {registeredServiceClasses} = await import("../tools/hana-closure-stubs.mjs");
    const root = mkdtempSync(join(tmpdir(), "hana-closure-regsvc-"));
    try {
      expect(registeredServiceClasses(root).size, "no facts, no island registrations").to.equal(0);
      mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
        {service: "h5x1", version: "0001", dpc: "ZCL_H5X1_SVC_DPC_EXT", mpc: "ZCL_H5X1_SVC_MPC_EXT"},
      ]}) + "\n");
      mkdirSync(join(root, "gen", "hana-src", "000-x", "src"), {recursive: true});
      // the same fields tools/segw-registry.mjs reads, under the abapGit
      // file names (technical name padded out to the version)
      writeFileSync(join(root, "gen", "hana-src", "000-x", "src", "z5x1_xml_svc               0001.iwsv.xml"),
        `<asx:abap><asx:values><DATA>` +
        `<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>Z5X1_XML</TECHNICAL_NAME><VERSION>0001</VERSION><CLASS_NAME>ZCL_H5X1_XML_DPC_EXT</CLASS_NAME></_-IWBEP_-I_MGW_SRH>` +
        `</DATA></asx:values></asx:abap>\n`);
      writeFileSync(join(root, "gen", "hana-src", "000-x", "src", "z5x1_xml_mdl               0001.iwmo.xml"),
        `<asx:abap><asx:values><DATA>` +
        `<_-IWBEP_-I_MGW_OHD><TECHNICAL_NAME>Z5X1_XML</TECHNICAL_NAME><VERSION>0001</VERSION><CLASS_NAME>ZCL_H5X1_XML_MPC_EXT</CLASS_NAME></_-IWBEP_-I_MGW_OHD>` +
        `</DATA></asx:values></asx:abap>\n`);
      expect([...registeredServiceClasses(root)].sort()).to.deep.equal([
        "ZCL_H5X1_SVC_DPC", "ZCL_H5X1_SVC_DPC_EXT", "ZCL_H5X1_SVC_MPC", "ZCL_H5X1_SVC_MPC_EXT",
        "ZCL_H5X1_XML_DPC", "ZCL_H5X1_XML_DPC_EXT", "ZCL_H5X1_XML_MPC", "ZCL_H5X1_XML_MPC_EXT",
      ]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the seed guard knows the walk's own classes by suffix when no registration exists (item 5)", async () => {
    const {registeredServiceClasses, serviceGuardBySuffixOnly} = await import("../tools/hana-closure-stubs.mjs");
    const root = mkdtempSync(join(tmpdir(), "hana-closure-suffixguard-"));
    try {
      expect(serviceGuardBySuffixOnly(root), "nothing at all: by suffix").to.equal(true);
      expect(registeredServiceClasses(root).size).to.equal(0);
      mkdirSync(join(root, "gen", "hana-src", "000-x", "src"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-src", "000-x", "src", "zcl_h5x1_svc_dpc_ext.clas.abap"), "x");
      writeFileSync(join(root, "gen", "hana-src", "000-x", "src", "zcl_h5x1_svc_mpc.clas.abap"), "x");
      writeFileSync(join(root, "gen", "hana-src", "000-x", "src", "zcl_h5x1_plain.clas.abap"), "x");
      expect([...registeredServiceClasses(root)].sort()).to.deep.equal(
        ["ZCL_H5X1_SVC_DPC", "ZCL_H5X1_SVC_DPC_EXT", "ZCL_H5X1_SVC_MPC"]);
      expect(serviceGuardBySuffixOnly(root), "still no registration: by suffix").to.equal(true);
      // a registration flips the mode; both protections stay on
      mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
        {service: "s", version: "0001", dpc: "ZCL_H5X1_REG_DPC_EXT", mpc: "ZCL_H5X1_REG_MPC_EXT"},
      ]}) + "\n");
      expect([...registeredServiceClasses(root)].sort()).to.deep.equal([
        "ZCL_H5X1_REG_DPC", "ZCL_H5X1_REG_DPC_EXT", "ZCL_H5X1_REG_MPC", "ZCL_H5X1_REG_MPC_EXT",
        "ZCL_H5X1_SVC_DPC", "ZCL_H5X1_SVC_DPC_EXT", "ZCL_H5X1_SVC_MPC"]);
      expect(serviceGuardBySuffixOnly(root)).to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  // ------------------------------------------------------------- loop -----

  // the fixture class: one SELECT against a table the scratch tree does not
  // have -- the one shape a first closure iteration is made of
  const CLAS_SOURCE = [
    `CLASS zcl_h5c_loop DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_loop IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_head INTO @DATA(ls_h5c_head) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // and one whose class types by an unknown name -- the wording that carries
  // no dictionary kind (the `ddic` bucket)
  const CLAS_TYPE_SOURCE = [
    `CLASS zcl_h5c_type DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_type IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    DATA lv_w TYPE zosd_h5c_w.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the tree's own business: a class under src/ naming its own table. Its
  // finding is real, but it is outside the island -- src/ findings are never
  // asked (the request must not carry ZOSD_H5C_OWN anywhere)
  const OWN_SOURCE = [
    `CLASS zcl_h5c_own DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_own IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_own INTO @DATA(ls_h5c_own) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the stub raise's superclass chain, as scratch-tree fixtures shaped like
  // open-abap-core's src/exceptions/ (a scratch tree carries no libs); the
  // real zcx_osd_not_activated.clas.abap is copied in beside them, so the
  // stub line compiles against the real class
  const IF_MESSAGE_SOURCE = [
    `INTERFACE if_message PUBLIC.`,
    `  METHODS get_text RETURNING VALUE(result) TYPE string.`,
    `  METHODS get_longtext RETURNING VALUE(result) TYPE string.`,
    `ENDINTERFACE.`,
    ``,
  ].join("\n");
  const CX_ROOT_SOURCE = [
    `CLASS cx_root DEFINITION ABSTRACT PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA previous TYPE REF TO cx_root READ-ONLY.`,
    `    DATA textid TYPE c LENGTH 32 READ-ONLY.`,
    `    METHODS constructor`,
    `      IMPORTING`,
    `        textid   LIKE textid OPTIONAL`,
    `        previous TYPE REF TO cx_root OPTIONAL.`,
    `    INTERFACES if_message.`,
    `    ALIASES get_text FOR if_message~get_text.`,
    `ENDCLASS.`,
    `CLASS cx_root IMPLEMENTATION.`,
    `  METHOD constructor.`,
    `    me->previous = previous.`,
    `    me->textid = textid.`,
    `  ENDMETHOD.`,
    `  METHOD if_message~get_text.`,
    `    result = ''.`,
    `  ENDMETHOD.`,
    `  METHOD if_message~get_longtext.`,
    `    result = ''.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const CX_NO_CHECK_SOURCE = [
    `CLASS cx_no_check DEFINITION PUBLIC INHERITING FROM cx_root.`,
    `  PUBLIC SECTION.`,
    `    METHODS constructor`,
    `      IMPORTING`,
    `        textid   LIKE textid OPTIONAL`,
    `        previous TYPE REF TO cx_root OPTIONAL.`,
    `ENDCLASS.`,
    `CLASS cx_no_check IMPLEMENTATION.`,
    `  METHOD constructor.`,
    `    super->constructor( textid = textid previous = previous ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the lazy-activation fixture: `two` SELECTs a table the island does not
  // have (a method-body finding -> stubbed); a second island class types an
  // attribute by a missing name in its DEFINITION part (outside any body ->
  // cannot be stubbed -> the request)
  const CLAS_STUB_SOURCE = [
    `CLASS zcl_h5c_stub DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS one.`,
    `    METHODS two.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_stub IMPLEMENTATION.`,
    `  METHOD one.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD two.`,
    `    SELECT SINGLE * FROM zosd_h5c_head INTO @DATA(ls_h5c_head) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  const CLAS_DEF_SOURCE = [
    `CLASS zcl_h5c_def DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gv_h5c TYPE zosd_h5c_def.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_def IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the definition-level exclusion fixture (H5x-1): the unknown type sits
  // in the DEFINITION part, outside every method body -- no stub can reach
  // it, so once the dumper answered missing the class falls out of the
  // build through osd-build's own exclusion seam
  const CLAS_DEFEX_SOURCE = [
    `CLASS zcl_h5c_defex DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gv_h5c TYPE zosd_h5c_dead.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_defex IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the code-kind miss (H5x-1): a static call on a class the tree does not
  // have -- the one shape that stays lazy (deferred) under
  // --stub-unresolved, because a class pull is code and code is what the
  // island grows on
  const CLAS_CODE_SOURCE = [
    `CLASS zcl_h5c_code DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS one.`,
    `    METHODS two.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_code IMPLEMENTATION.`,
    `  METHOD one.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD two.`,
    `    zcl_h5c_far=>run_it( ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the presence fixtures (H5x-1): a superclass the island HOLDS but that
  // does not parse, and the dependent inheriting from it -- the dependent's
  // finding names an object that is present, so it is a cascade of that
  // object's own findings and is never asked (measured shape:
  // `Super class "zcl_h5c_far" not found or contains errors`)
  const CLAS_FAR_BROKEN_SOURCE = [
    `CLASS zcl_h5c_far DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    NOT ABAP AT ALL.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const CLAS_USER_SOURCE = [
    `CLASS zcl_h5c_user DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5c_far.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_user IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the fix-round-2 chain fixtures: USER -> MID -> FAR (three inheritance
  // levels), plus two walkers whose method misses keep the walk alive so a
  // decision and a request can share an iteration
  const CLAS_MID_SOURCE = [
    `CLASS zcl_h5c_mid DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5c_far.`,
    `  PUBLIC SECTION.`,
    `    METHODS mid_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_mid IMPLEMENTATION.`,
    `  METHOD mid_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const CLAS_FAR_SOURCE = [
    `CLASS zcl_h5c_far DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS far_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_far IMPLEMENTATION.`,
    `  METHOD far_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  // the lift fixture (M3 B5.1): a method that calls the far class -- a
  // code-kind miss, stubbed and deferred while the class is absent, whole
  // again once a dump brings it (MID's superclass ask brings it)
  const CLAS_LIFT_SOURCE = [
    `CLASS zcl_h5c_lift DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS keep_it.`,
    `    METHODS call_far.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_lift IMPLEMENTATION.`,
    `  METHOD keep_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD call_far.`,
    `    DATA lo_far TYPE REF TO zcl_h5c_far.`,
    `    CREATE OBJECT lo_far.`,
    `    lo_far->far_it( ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const CLAS_OTHER_SOURCE = [
    `CLASS zcl_h5c_other DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_other IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_more INTO @DATA(ls_h5c_more) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const CLAS_WALKER_SOURCE = [
    `CLASS zcl_h5c_walker DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_walker IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_wtable INTO @DATA(ls_h5c_wtable) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the clean half of the real-build fixture (H5x-1's acceptance): the
  // island builds when the definition-level class is excluded
  const CLAS_CLEAN_SOURCE = [
    `CLASS zcl_h5c_clean DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_clean IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the per-name fill's fixture (round 7): the class reads a table the
  // converter's TADIR selection did not cover -- the dump RESOLVES it, the
  // layers do not carry it, and the fill writes exactly that one
  const CLAS_BPA_SOURCE = [
    `CLASS zcl_h5c_bpa DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_bpa IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_bpa INTO @DATA(ls_h5c_bpa) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // the test-code fixtures (round 7): a class's test-classes include and a
  // *_TEST class the closure pulled -- neither is island content, and the
  // tables they read must never enter a request
  const TESTCLASSES_SOURCE = [
    `CLASS ltcl_h5c_probe DEFINITION FINAL FOR TESTING.`,
    `  PUBLIC SECTION.`,
    `    METHODS runs FOR TESTING.`,
    `ENDCLASS.`,
    `CLASS ltcl_h5c_probe IMPLEMENTATION.`,
    `  METHOD runs.`,
    `    SELECT SINGLE * FROM zosd_h5c_ttest INTO @DATA(ls_h5c_ttest) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const TESTCLASS_SOURCE = [
    `CLASS zcl_h5c_helper_test DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_helper_test IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_ttest2 INTO @DATA(ls_h5c_two) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  // a scratch tree that validates like the real one, at fixture scale: the
  // same input-folder shape (the generated DDIC first, the tenant sources,
  // then src), no libraries, and this checkout's transpiler through a
  // symlinked node_modules. The loop's fixture class is staged OUTSIDE every
  // input folder; the fake converter lays it into gen/hana-src/000-h5c-main/src/
  // on each merge, the way the real converter+hana-src-gen lay the dumped
  // sources -- so the mixed validate() output names files of the
  // island and of src/, and only the island's are classified.
  const scratch = (source = CLAS_SOURCE, name = "zcl_h5c_loop", opts = {}) => {
    const root = mkdtempSync(join(tmpdir(), "hana-closure-root-"));
    symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
    writeFileSync(join(root, "package.json"), JSON.stringify({name: "hana-closure-scratch", private: true}) + "\n");
    writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
      input_folder: ["gen/hana-ddic", "gen/hana-src/*", "src"],
      output_folder: "output",
      libs: [],
      write_source_map: false,
      options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
    }, null, 2) + "\n");
    mkdirSync(join(root, "src"), {recursive: true});
    writeFileSync(join(root, "src", "zcl_h5c_own.clas.abap"), OWN_SOURCE);
    writeFileSync(join(root, "src", "if_message.intf.abap"), IF_MESSAGE_SOURCE);
    writeFileSync(join(root, "src", "cx_root.clas.abap"), CX_ROOT_SOURCE);
    writeFileSync(join(root, "src", "cx_no_check.clas.abap"), CX_NO_CHECK_SOURCE);
    if (opts.noZcx !== true) {
      mkdirSync(join(root, "src", "hana"), {recursive: true});
      copyFileSync(join(REPO, "src", "hana", "zcx_osd_not_activated.clas.abap"), join(root, "src", "hana", "zcx_osd_not_activated.clas.abap"));
    }
    mkdirSync(join(root, "island"), {recursive: true});
    writeFileSync(join(root, "island", `${name}.${opts.islandExt ?? "clas"}.abap`), source);
    if (opts.island2Name !== undefined) {
      writeFileSync(join(root, "island", opts.island2Name), opts.island2Source);
    }
    return root;
  };

  // iteration 1's dump: a dump directory of --ddic shape, carrying nothing
  // the fixture tree needs yet -- or, when `tables` is given, exactly those
  // DD02L rows
  const fixtureDump = (dir, tables = []) => {
    mkdirSync(join(dir, "tables"), {recursive: true});
    writeFileSync(join(dir, "tables", "DD02L.jsonl"), tables.map((t) => JSON.stringify({TABNAME: t})).join("\n") + (tables.length === 0 ? "" : "\n"));
    writeFileSync(join(dir, "manifest.json"), "{}\n");
  };

  // the fake dumper: the real binary's CLI contract (required flags, the
  // schema-1 request file, the git-tree refusal unless --allow-in-repo, the
  // password from VSP_HANA_PASSWORD only), a synthetic --ddic dump, and a
  // record of what it saw. H5C_MISSING_KINDS names the dictionary kinds the
  // "dictionary" lacks; by default every requested name resolves.
  const fakeDumperSource = () => `#!/usr/bin/env node
import {appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
const args = process.argv.slice(2);
const at = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] !== "hana" || args[1] !== "dump") process.exit(3);
// the flags the real binary refuses to run without (MarkFlagRequired)
for (const flag of ["--host", "--user", "--schema", "--provenance", "--out"]) {
  if (at(flag) === undefined || at(flag) === "") {
    console.error("required flag(s) not set: " + flag.slice(2));
    process.exit(3);
  }
}
// an --out inside a git working tree is refused unless --allow-in-repo
const out = resolve(at("--out"));
for (let dir = out; ; dir = dirname(dir)) {
  if (existsSync(join(dir, ".git"))) {
    if (args.includes("--allow-in-repo") === false) {
      console.error("dumps stay out of repositories");
      process.exit(3);
    }
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
}
// the real prepareOut refuses a non-empty --out (dump.go: "is not empty")
if (existsSync(out) && readdirSync(out).length > 0) {
  console.error("dump out already exists and is not empty: " + out);
  process.exit(3);
}
// the request is read the way the real reader reads it: schema 1
const request = JSON.parse(readFileSync(at("--ddic-closure"), "utf8"));
if (request.schema !== 1) {
  console.error("schema " + request.schema + ", expected 1");
  process.exit(3);
}
const record = process.env.H5C_RECORD;
if (record) appendFileSync(record, JSON.stringify({
  argv: args,
  out,
  ddicClosure: at("--ddic-closure"),
  allowInRepo: args.includes("--allow-in-repo"),
  skipTestIncludes: args.includes("--skip-test-includes"),
  provenance: at("--provenance"),
  connection: {host: at("--host"), port: at("--port"), user: at("--user"), schema: at("--schema")},
  passwordEnv: process.env.VSP_HANA_PASSWORD ?? null,
}) + "\\n");
// what the dictionary answered: the request's dictionary names, resolved
// unless H5C_MISSING_KINDS says the dictionary lacks the kind -- or
// H5C_MISSING_NAMES names the object itself (H5x-1: a per-name answer, so
// one scenario can resolve one table and refuse another)
const missingKinds = (process.env.H5C_MISSING_KINDS ?? "").split(",").filter(Boolean);
const unhandledKinds = (process.env.H5C_UNHANDLED_KINDS ?? "").split(",").filter(Boolean);
const missingNames = (process.env.H5C_MISSING_NAMES ?? "").split(",").filter(Boolean).map((s) => s.trim().toUpperCase());
const resolved = {};
const missing = {};
const unhandled = {};
for (const kind of Object.keys(request.requested)) {
  const list = request.requested[kind] ?? [];
  if (list.length === 0) continue;
  const grouped = {resolved: [], missing: [], unhandled: []};
  for (const name of list) {
    const bucket = missingNames.includes(name.toUpperCase()) === true ? "missing"
      : missingKinds.includes(kind) === true ? "missing"
      : unhandledKinds.includes(kind) === true ? "unhandled" : "resolved";
    grouped[bucket].push(name);
  }
  if (grouped.resolved.length > 0) resolved[kind] = [...grouped.resolved].sort();
  if (grouped.missing.length > 0) missing[kind] = [...grouped.missing].sort();
  if (grouped.unhandled.length > 0) unhandled[kind] = [...grouped.unhandled].sort();
}
const found = missingKinds.includes("TABL") || unhandledKinds.includes("TABL") ? []
  : (request.requested.TABL ?? []).filter((t) => missingNames.includes(t.toUpperCase()) === false);
mkdirSync(join(out, "tables"), {recursive: true});
writeFileSync(join(out, "tables", "DD02L.jsonl"), found.map((t) => JSON.stringify({TABNAME: t.toUpperCase()})).join("\\n") + (found.length === 0 ? "" : "\\n"));
const closure = {rounds: 1, resolved, missing};
if (Object.keys(unhandled).length > 0) closure.unhandled = unhandled;
writeFileSync(join(out, "manifest.json"), JSON.stringify({closure}) + "\\n");
process.exit(0);
`;

  // the fake host behind OSD_SELF: the argv of hana-ddic-gen --from-dump and
  // hana-src-gen --layers is what the loop owns (the real tools' write modes
  // are PR #926's and this tree's), so the fake asserts it and emulates the
  // merge. The DDIC half writes the same XML the real mapper writes -- it
  // has to, the transpiler must resolve it for the fixed point -- and never
  // clears the folder, the way the real --from-dump writes per-file overlays.
  // The source half lays the UNION of the --layers dirs (later wins per
  // file), the way the real hana-src-gen does; H5C_SHRINK=1 makes it
  // reproduce the round-3 bug (only the last dump's layers) for the
  // shrink-assert test. H5C_GROW=1 drops one more unresolved table into the
  // second merge, so the closure keeps growing and a cap has something to
  // stop. tool osd-build.mjs is the fixed point's positive control: ok by
  // default, H5C_BUILD=fail-quiet is the generator crash bed run 4 saw
  // (non-zero exit, zero findings), H5C_BUILD=fail-findings exits non-zero
  // carrying a finding line.
  const fakeHostSource = () => `#!/usr/bin/env node
import {appendFileSync, copyFileSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {ddicFields, tablXml} from ${JSON.stringify(join(REPO, "tools", "hana-ddic-map.mjs"))};
import {islandTestCode} from ${JSON.stringify(join(REPO, "tools", "hana-src-gen.mjs"))};
const args = process.argv.slice(2);
const tool = args[1];
const rest = args.slice(2);
const at = (name) => { const i = rest.indexOf(name); return i >= 0 ? rest[i + 1] : undefined; };
const log = process.env.H5C_HOST_LOG;
if (log) appendFileSync(log, JSON.stringify({tool, rest}) + "\\n");
if (process.env.H5C_NO_FROM_DUMP === "1" && tool === "hana-ddic-gen.mjs") {
  console.error("hana-ddic-gen: unknown option --from-dump");
  process.exit(2);
}
if (tool === "hana-ddic-gen.mjs") {
  const dump = at("--from-dump");
  const out = at("--out");
  let rows = [];
  try {
    rows = readFileSync(join(dump, "tables", "DD02L.jsonl"), "utf8").split("\\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  } catch { /* not a dump of --ddic shape: nothing to merge */ }
  // the real hana-ddic-map's TABCLASS refusal (H5a's guard, CRITIC-926):
  // the tool exits 2 on the first object it refuses to write
  const refuse = process.env.H5C_REFUSE;
  if (refuse !== undefined && rows.some((r) => String(r.TABNAME).toUpperCase() === refuse)) {
    console.error("hana-ddic-gen: hana-ddic-map: " + refuse + ": TABCLASS APPEND is not written here -- only TRANSP and INTTAB are");
    process.exit(2);
  }
  // --names (round 7's per-name fill): only the named objects are written
  const wanted = at("--names") === undefined ? null : new Set(at("--names").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
  mkdirSync(out, {recursive: true});
  for (const row of rows) {
    const name = String(row.TABNAME).toUpperCase();
    if (wanted !== null && wanted.has(name) === false) continue;
    const fields = ddicFields([{position: "1", fieldname: "ZOSD_H5C_KEY", keyflag: "X", rollname: "", datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X"}]);
    writeFileSync(join(out, name.toLowerCase() + ".tabl.xml"), tablXml({name, text: "h5c fixture", clidep: false, fields}));
  }
  process.exit(0);
}
if (tool === "hana-src-gen.mjs") {
  // the loop merges LAYERS (the union of every dump so far), never one dump:
  // --layers <dir>... --out <dir>, the argv tools/hana-src-gen.mjs takes
  const out = at("--out");
  const dirs = [];
  for (let i = 0; i < rest.length; i++) if (rest[i] === "--layers") dirs.push(rest[i + 1]);
  if (dirs.length === 0) {
    console.error("fake host: the loop must merge layers (--layers), not a dump");
    process.exit(2);
  }
  const shown = process.env.H5C_SHRINK === "1" ? [dirs[dirs.length - 1]] : dirs;
  rmSync(out, {recursive: true, force: true});
  mkdirSync(out, {recursive: true});
  for (const dir of shown) {
    const plan = JSON.parse(readFileSync(join(dir, "plan.json"), "utf8"));
    for (const layer of plan.layers ?? []) {
      const target = join(out, String(layer.order).padStart(3, "0") + "-" + layer.name);
      mkdirSync(join(target, "src"), {recursive: true});
      copyFileSync(join(dir, layer.folder, ".abapgit.xml"), join(target, ".abapgit.xml"));
      for (const file of readdirSync(join(dir, layer.folder, "src"))) {
        // the island rule (round 7): no test code in gen/hana-src -- the
        // real predicate, imported (S-7.2), so the loop scenario proves it
        if (islandTestCode(file) === true) continue;
        copyFileSync(join(dir, layer.folder, "src", file), join(target, "src", file));
      }
    }
  }
  const last = JSON.parse(readFileSync(join(dirs[dirs.length - 1], "plan.json"), "utf8"));
  writeFileSync(join(out, "manifest.json"), JSON.stringify({dump: last.dump ?? {manifest_sha256: "h5c_sha"}}) + "\\n");
  if (process.env.H5C_GROW === "1") {
    const counter = join(out, "..", "host-invocations");
    const seen = (() => { try { return Number(readFileSync(counter, "utf8")); } catch { return 0; } })();
    writeFileSync(counter, String(seen + 1));
    if (seen >= 1) {
      const layer = join(out, "001-more", "src");
      mkdirSync(layer, {recursive: true});
      writeFileSync(join(layer, "zcl_h5c_more.clas.abap"), [
        "CLASS zcl_h5c_more DEFINITION PUBLIC FINAL CREATE PUBLIC.",
        "  PUBLIC SECTION.",
        "    METHODS run_it.",
        "ENDCLASS.",
        "CLASS zcl_h5c_more IMPLEMENTATION.",
        "  METHOD run_it.",
        "    SELECT SINGLE * FROM zosd_h5c_more_2 INTO @DATA(ls_h5c_more) ##SUBRC_OK.",
        "  ENDMETHOD.",
        "ENDCLASS.",
        "",
      ].join("\\n"));
    }
  }
  process.exit(0);
}
if (tool === "osd-build.mjs") {
  const mode = process.env.H5C_BUILD ?? "ok";
  if (mode === "fail-quiet") {
    console.log("osd-build: osd-transpiler.mjs");
    console.log("osd-build: FAILED: node --import tools/osd-generator-reads.mjs tools/cds2ddic.mjs exited 1");
    console.log("osd-build: live generation untouched");
    process.exit(1);
  }
  if (mode === "fail-findings") {
    console.log('check_syntax, Database table or view "zosd_h5c_head" not found, zcl_h5c_loop.clas.abap:10');
    process.exit(1);
  }
  process.exit(0);
}
process.exit(2);
`;

  // the fake converter the loop starts per dump (OSD_HANA_CONVERTER, an
  // external script like the real dump-to-layers.mjs): it copies the staged
  // converter output of the dump it was handed -- and refuses an --out
  // inside a git working tree unless --allow-in-repo, the real converter's
  // own refusal (dump-to-layers.mjs rejectGit, word for word), and records
  // its argv the way the fake dumper does. The loop's layers dir sits under
  // .local/ INSIDE the tree, so every loop scenario is green only when the
  // flag travels (the .git scenarios run the refusal end to end).
  const fakeConverterSource = () => `#!/usr/bin/env node
import {appendFileSync, cpSync, existsSync, rmSync} from "node:fs";
import {dirname, join, resolve} from "node:path";
const args = process.argv.slice(2);
const at = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
// an --out inside a git working tree is refused unless --allow-in-repo
const out = resolve(at("--out"));
for (let dir = out; ; dir = dirname(dir)) {
  if (existsSync(join(dir, ".git"))) {
    if (args.includes("--allow-in-repo") === false) {
      console.error("Refusing to write inside a git working tree: " + out + " (use --allow-in-repo)");
      process.exit(3);
    }
    break;
  }
  const parent = dirname(dir);
  if (parent === dir) break;
}
const record = process.env.H5C_CONV_RECORD;
if (record) appendFileSync(record, JSON.stringify({argv: args, out, allowInRepo: args.includes("--allow-in-repo")}) + "\\n");
const map = JSON.parse(process.env.H5C_CONV_MAP ?? "{}");
const source = map[args[0]];
if (source === undefined) {
  console.error("no staged layers for " + args[0]);
  process.exit(3);
}
rmSync(at("--out"), {recursive: true, force: true});
cpSync(source, at("--out"), {recursive: true});
process.exit(0);
`;

  // a staged converter output (what the fake converter copies into --out):
  // plan.json with one layer, .abapgit.xml, src/ with the files
  const ABAPGIT_XML = `<?xml version="1.0" encoding="utf-8"?>
<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
 <asx:values>
  <DATA><MASTER_LANGUAGE>E</MASTER_LANGUAGE><STARTING_FOLDER>/src/</STARTING_FOLDER><FOLDER_LOGIC>PREFIX</FOLDER_LOGIC></DATA>
 </asx:values>
</asx:abap>
`;
  const converterOut = (dir, files = []) => {
    mkdirSync(join(dir, "layers", "h5c-main", "src"), {recursive: true});
    writeFileSync(join(dir, "layers", "h5c-main", ".abapgit.xml"), ABAPGIT_XML);
    writeFileSync(join(dir, "plan.json"), JSON.stringify({
      schema: 1, system: "h5c",
      dump: {manifest_sha256: "h5c_sha", provenance: "the h5c fixtures' own test bed"},
      layers: [{name: "h5c-main", package: "$ZOSD_H5C", folder: "layers/h5c-main", order: 0,
        objects: files.length === 0 ? {} : {CLAS: files.length}, requires: [], requires_outside: [],
        closure: {unresolved: 0, items: []}}],
      cycles: [], no_source: {}, orphans: [], errors: [],
      empty_layers: {count: 0, names: []}, unpackaged_groups: 0,
    }, null, 2) + "\n");
    for (const [name, from] of files) copyFileSync(from, join(dir, "layers", "h5c-main", "src", name));
    return dir;
  };

  const envFor = (root, opts = {}) => {
    // every dump's layers are staged here, and the fake converter copies the
    // staged tree of the dump it was handed (H5C_CONV_MAP keys the dump
    // paths): dump-001 carries the island class(es), the dumper's dumps are
    // empty unless opts.convBFiles names more
    const island = opts.island ?? "zcl_h5c_loop.clas.abap";
    const filesA = [[island, join(root, "island", island)]];
    if (opts.island2Name !== undefined) filesA.push([opts.island2Name, join(root, "island", opts.island2Name)]);
    // extra staged files of the seed dump's layer -- the converter-DDIC
    // scenario stages the .tabl.xml the converter master writes
    for (const name of opts.convAFiles ?? []) filesA.push([name, join(root, "island", name)]);
    const filesB = (opts.convBFiles ?? []).map((name) => [name, join(root, "island", name)]);
    const filesC = [...filesB, ...(opts.convCFiles ?? []).map((name) => [name, join(root, "island", name)])];
    const convMap = JSON.stringify({
      [join(root, "dump-001")]: converterOut(join(root, "conv-a"), filesA),
      [dumpDirOf(root, 2)]: converterOut(join(root, "conv-b"), filesB),
      [dumpDirOf(root, 3)]: converterOut(join(root, "conv-c"), filesC),
      [dumpDirOf(root, 4)]: converterOut(join(root, "conv-d"), filesC),
    });
    return {
      ...process.env,
      OSD_SELF: JSON.stringify([process.execPath, join(root, "fake-host.mjs")]),
      H5C_HOST_LOG: join(root, "host-log.jsonl"),
      OSD_HANA_CONVERTER: join(root, "fake-converter.mjs"),
      H5C_CONV_MAP: convMap,
      H5C_CONV_RECORD: join(root, "converter-log.jsonl"),
      ...(opts.shrink ? {H5C_SHRINK: "1"} : {}),
      ...(opts.build !== undefined ? {H5C_BUILD: opts.build} : {}),
      ...(opts.grow ? {H5C_GROW: "1"} : {}),
      ...(opts.noFromDump ? {H5C_NO_FROM_DUMP: "1"} : {}),
      ...(opts.missingKinds !== undefined ? {H5C_MISSING_KINDS: opts.missingKinds} : {}),
      ...(opts.missingNames !== undefined ? {H5C_MISSING_NAMES: opts.missingNames} : {}),
      ...(opts.unhandledKinds !== undefined ? {H5C_UNHANDLED_KINDS: opts.unhandledKinds} : {}),
      ...(opts.refuse !== undefined ? {H5C_REFUSE: opts.refuse} : {}),
      ...(opts.dumper === false ? {OSD_HANA_DUMP_ENV: join(root, "dump.env")} : {
        OSD_HANA_DUMPER: join(root, "fake-dumper.mjs"),
        OSD_HANA_DUMP_ENV: join(root, "dump.env"),
        H5C_RECORD: join(root, "dumper-log.jsonl"),
      }),
    };
  };

  const writeFakes = (root, env) => {
    writeFileSync(join(root, "fake-host.mjs"), fakeHostSource());
    writeFileSync(join(root, "fake-converter.mjs"), fakeConverterSource());
    writeFileSync(join(root, "fake-dumper.mjs"), fakeDumperSource());
    chmodSync(join(root, "fake-dumper.mjs"), 0o755);
    writeFileSync(join(root, "dump.env"), [
      "# the bed connection",
      "HANA_HOST=h5c.example",
      "HANA_PORT=30215",
      "HANA_USER=h5c_user",
      "HANA_SCHEMA=h5c_schema",
      "HANA_PASSWORD=h5c_secret",
      "",
    ].join("\n"));
    return env;
  };

  const dumperCalls = (root) => readFileSync(join(root, "dumper-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const converterCalls = (root) => readFileSync(join(root, "converter-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const hostCalls = (root) => readFileSync(join(root, "host-log.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const outFile = (root, name) => join(root, "gen", "hana-closure", name);
  const dumpDirOf = (root, n) => join(root, ".local", "hana-closure", `dump-${String(n).padStart(3, "0")}`);
  const layersDirOf = (root, n) => join(root, ".local", "hana-closure", `layers-${String(n).padStart(3, "0")}`);

  it("runs to the fixed point: ask, dump through the fake, merge, and the name resolves", async function () {
    this.timeout(180000);
    const root = scratch();
    // the dumps land inside the tree (gitignored .local/): the fake dumper
    // refuses that without --allow-in-repo, the way the real one does
    mkdirSync(join(root, ".git"));
    const dump = join(root, "dump-001");
    fixtureDump(dump);
    const env = writeFakes(root, envFor(root));
    const said = [];
    try {
      const result = await run(["--dump", dump, "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);

      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(Object.keys(request).sort()).to.deep.equal(
        ["gaps", "generation", "iteration", "requested", "schema", "seen", "source"]);
      expect(request.schema).to.equal(1);
      expect(request.iteration).to.equal(2);
      expect(request.generation, "the hash the merge's manifest carries").to.equal("h5c_sha");
      expect(request.source).to.equal("transpile validate() findings");
      // the mixed validate() output named ZOSD_H5C_HEAD (the island fixture)
      // AND ZOSD_H5C_OWN (src/, the tree's own): only the island's is asked
      expect(request.requested.TABL).to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(JSON.stringify(request), "a src/ finding never enters the request").to.not.include("ZOSD_H5C_OWN");
      expect(request.seen.TABL).to.deep.equal([]);
      expect(request.gaps).to.deep.equal([]);

      // the island scoping is reported once per iteration, as a count (the
      // src/ class emits its findings -- the tree's own, counted, not named)
      expect(said.some((l) => /iteration 1: 1 new name\(s\), 0 gap\(s\), [1-9][0-9]* outside the island/.test(l)),
        "the unscoped count is on the iteration line").to.equal(true);
      // the loop's own dump line prints --host <env>, never the values
      // (logs get pasted); the by-hand command keeps them
      expect(said.some((l) => /^dump: hana dump --host <env> --port <env> --user <env> --schema <env> /.test(l)),
        "the dumper's log line is redacted").to.equal(true);
      for (const secret of ["h5c.example", "30215", "h5c_user", "h5c_schema", "h5c_secret"]) {
        expect(said.some((l) => l.includes(secret)), `${secret} stays off the loop's log`).to.equal(false);
      }

      // the fake dumper saw the whole contract: subcommand, the request file,
      // its own directory inside .local/, the provenance, the connection
      // flags of the env file -- and the password only in its environment
      const calls = dumperCalls(root);
      expect(calls).to.have.lengthOf(1);
      expect(calls[0].argv.slice(0, 2)).to.deep.equal(["hana", "dump"]);
      expect(calls[0].ddicClosure).to.equal(join(root, "gen", "hana-closure", "closure-request.json"));
      expect(calls[0].allowInRepo, "the dump is inside the tree, the flag must travel").to.equal(true);
      expect(calls[0].argv, "the closure must never carry CCAU test includes (round 7)").to.include("--skip-test-includes");
      expect(calls[0].skipTestIncludes).to.equal(true);
      expect(calls[0].out).to.equal(dumpDirOf(root, 2));
      expect(calls[0].provenance).to.match(/iteration 2/);
      expect(calls[0].connection).to.deep.equal({host: "h5c.example", port: "30215", user: "h5c_user", schema: "h5c_schema"});
      expect(calls[0].passwordEnv).to.equal("h5c_secret");
      expect(calls[0].argv.join(" "), "no env-file value on the spawned argv").to.not.include("h5c_secret");
      expect(calls[0].argv.join(" ")).to.not.include("--name");

      // both merges ran through the host dispatch, twice (two passes), and
      // the fixed point's positive control ran the build through it too
      const merges = hostCalls(root);
      expect(merges.map((m) => m.tool)).to.deep.equal(
        ["hana-ddic-gen.mjs", "hana-src-gen.mjs", "hana-ddic-gen.mjs", "hana-src-gen.mjs", "osd-build.mjs"]);
      expect(merges[0].rest).to.deep.equal(["--from-dump", dump, "--out", join(root, "gen", "hana-ddic")]);
      expect(merges[1].rest, "the first pass lays the seed dump's layers").to.deep.equal(
        ["--layers", layersDirOf(root, 1), "--out", join(root, "gen", "hana-src")]);
      expect(merges[2].rest[1], "the second pass merges the dump the dumper wrote").to.equal(dumpDirOf(root, 2));
      expect(merges[3].rest, "the second pass lays the union of both dumps' layers").to.deep.equal(
        ["--layers", layersDirOf(root, 1), "--layers", layersDirOf(root, 2), "--out", join(root, "gen", "hana-src")]);

      // resolved, so: no gaps, no third round
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
      expect(existsSync(dumpDirOf(root, 3))).to.equal(false);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.iteration).to.equal(2);
      expect(state.dump).to.equal(dumpDirOf(root, 2));
      expect(state.pending, "the round was answered in-run").to.equal(undefined);
      expect(state.asked.ZOSD_H5C_HEAD.kinds).to.deep.equal(["TABL"]);
      expect(state.asked.ZOSD_H5C_HEAD.iteration).to.equal(2);
      expect(state.asked.ZOSD_H5C_HEAD.finding).to.match(/Database table or view "zosd_h5c_head" not found/);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a kind-less ddic name the dictionary HAS (resolved under one of the three kinds) is not a gap", async function () {
    this.timeout(180000);
    // the dictionary answers per kind: resolved under TABL, "missing" under
    // DTEL and TTYP -- that is the normal answer for a name it has, not a
    // gap (the gap rule is asked AND still unresolved after the dump)
    const root = scratch(CLAS_TYPE_SOURCE, "zcl_h5c_type");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_type.clas.abap", missingKinds: "DTEL"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped).to.equal("fixed-point");

      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.TABL, "the kind-less name under every kind the dumper resolves").to.deep.equal(["ZOSD_H5C_W"]);
      expect(request.requested.DTEL).to.deep.equal(["ZOSD_H5C_W"]);
      expect(request.requested.TTYP).to.deep.equal(["ZOSD_H5C_W"]);
      expect(request.requested.SHLP, "the finding says nothing of search helps").to.deep.equal([]);

      // TABL resolved, the merge wrote the table, the build knows the name:
      // no gap, whatever the other two kinds' missing answer said
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps, "resolved under TABL is the dictionary HAS the name").to.deep.equal([]);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.missing).to.deep.equal({});
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a kind-less ddic name the dictionary lacks under every kind it was asked is a gap", async function () {
    this.timeout(180000);
    const root = scratch(CLAS_TYPE_SOURCE, "zcl_h5c_type");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_type.clas.abap", missingKinds: "TABL,DTEL,TTYP,DOMA"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      // asked, and the dump answered "missing" under all three kinds: the
      // dictionary does not have the name, the gap stands -- under one of
      // the kinds it was asked under (which one the per-kind answer names)
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_W");
      expect(["TABL", "DTEL", "TTYP"], "the kind of the per-kind missing answer").to.include(gaps[0].kind);
      expect(gaps[0].first_finding).to.match(/contains unknown: ZOSD_H5C_W not found/);
      expect(gaps[0].iterations_requested).to.equal(2);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(Object.keys(state.missing)).to.deep.equal(["ZOSD_H5C_W"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a name the dumper answered but the build still misses is a gap with its kind and first finding", async function () {
    this.timeout(180000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {missingKinds: "TABL"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      // the iteration line carries the per-kind gap counts (round 7)
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("gaps by kind: TABL 1")),
        "the gap's kind is on the iteration line").to.equal(true);
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_HEAD");
      expect(gaps[0].kind).to.equal("TABL");
      expect(gaps[0].first_finding).to.match(/Database table or view "zosd_h5c_head" not found/);
      expect(gaps[0].iterations_requested).to.equal(2);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a merge tool's refusal of one object is a gap, and the merge continues without it", async function () {
    this.timeout(180000);
    // bedrun3's live death: hana-ddic-map refuses a TABCLASS APPEND structure
    // and hana-ddic-gen exits 2 -- the loop must not die on it
    const root = scratch();
    fixtureDump(join(root, "dump-001"), ["ZOSD_H5C_APPEND", "ZOSD_H5C_KEEP"]);
    const env = writeFakes(root, envFor(root, {refuse: "ZOSD_H5C_APPEND"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped, "the refusal did not stop the loop").to.equal("fixed-point");

      // the object is a gap: the dictionary HAS it, the generator refuses it
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_APPEND");
      expect(gaps[0].kind).to.equal("TABL");
      expect(gaps[0].reason).to.equal("unsupported TABCLASS APPEND");
      expect(gaps[0].first_finding).to.match(/TABCLASS APPEND is not written here/);
      expect(gaps[0].iterations_requested, "never asked: asking cannot source it").to.equal(undefined);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.refused.ZOSD_H5C_APPEND.reason).to.equal("unsupported TABCLASS APPEND");

      // the merge went on: a retry against a filtered copy of the dump --
      // the refused row gone, the dump's own remaining rows kept -- and the
      // loop's own dump is still the original
      const ddicMerges = hostCalls(root).filter((m) => m.tool === "hana-ddic-gen.mjs");
      expect(ddicMerges[0].rest[1]).to.equal(join(root, "dump-001"));
      const retryDump = ddicMerges[1].rest[1];
      expect(retryDump, "the retry reads a filtered copy, not the dump itself").to.not.equal(join(root, "dump-001"));
      const kept = readFileSync(join(retryDump, "tables", "DD02L.jsonl"), "utf8").split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
      expect(kept.map((r) => r.TABNAME)).to.deep.equal(["ZOSD_H5C_KEEP"]);
      expect(existsSync(join(root, "gen", "hana-ddic", "zosd_h5c_keep.tabl.xml")), "the rest of the dump merged").to.equal(true);
      expect(existsSync(join(root, "gen", "hana-ddic", "zosd_h5c_append.tabl.xml")), "the refused object is not written").to.equal(false);
      expect(existsSync(join(root, "dump-001", "tables", "DD02L.jsonl")), "the dump itself is untouched").to.equal(true);

      // the request does not carry the refused name -- asking is pointless
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(JSON.stringify(request)).to.not.include("ZOSD_H5C_APPEND");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--dry-run writes the request -- and marks its names asked -- and never starts the dumper", async function () {
    this.timeout(180000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--dry-run"], {root, env});
      expect(result.stopped).to.equal("dry-run");
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.schema).to.equal(1);
      expect(request.requested.TABL).to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(existsSync(join(root, "dumper-log.jsonl")), "the dumper was not spawned").to.equal(false);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.asked.ZOSD_H5C_HEAD.iteration, "the request's names are asked from the moment it is written").to.equal(2);
      expect(state.pending.dumpDir).to.equal(dumpDirOf(root, 2));
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the manual route: the request marks its names asked, and a hand-run dump + --dump continuation gaps what is still missing", async function () {
    this.timeout(300000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const bare = writeFakes(root, envFor(root, {dumper: false}));
    const dumpDir = dumpDirOf(root, 2);
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env: bare});
      expect(result.stopped).to.equal("no-dumper");
      expect(result.command).to.include(`hana dump --host h5c.example --port 30215 --user h5c_user --schema h5c_schema`);
      expect(result.command).to.include(`--ddic-closure ${join(root, "gen", "hana-closure", "closure-request.json")}`);
      expect(result.command).to.include(`--out ${dumpDir}`);
      expect(result.command).to.include("--allow-in-repo");
      expect(result.command, "the by-hand route skips test includes too").to.include("--skip-test-includes");
      expect(result.command).to.include(`$OSD_HANA_DUMPER`);
      // the request was written; its names are asked; the round is pending
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.asked.ZOSD_H5C_HEAD.kinds).to.deep.equal(["TABL"]);
      expect(state.pending.dumpDir).to.equal(dumpDir);

      // a bare run without the dumper re-prints the pending round; it does
      // not merge, because the pending dump does not exist yet
      const before = hostCalls(root).length;
      const again = await run(["--system", "h5c"], {root, env: bare});
      expect(again.stopped).to.equal("no-dumper");
      expect(again.command).to.include(`--out ${dumpDir}`);
      expect(hostCalls(root).length, "no merge ran").to.equal(before);

      // the hand-run dump lands where the pending round pointed, and it
      // lacks the name: the continuation sees the name as asked and gaps it
      fixtureDump(dumpDir);
      const second = await run(["--system", "h5c", "--dump", dumpDir], {root, env: bare});
      expect(second.stopped, "asked and still unresolved: a gap").to.equal("fixed-point");
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_HEAD");
      expect(gaps[0].kind).to.equal("TABL");
      expect(gaps[0].iterations_requested).to.equal(2);
      const stateAfter = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(stateAfter.pending, "the hand-run dump superseded the pending round").to.equal(undefined);
      expect(existsSync(join(root, "dumper-log.jsonl")), "the dumper was never spawned").to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--max-iterations stops with the pending request on disk, and the next run executes it", async function () {
    this.timeout(300000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {grow: true}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--max-iterations", "1"], {root, env});
      expect(result.stopped).to.equal("cap");
      expect(result.iteration).to.equal(3);
      expect(dumperCalls(root), "one dumper round, not two").to.have.lengthOf(1);
      // the round the cap refused has its request written, ready for the next run
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.iteration).to.equal(3);
      expect(request.requested.TABL).to.deep.equal(["ZOSD_H5C_MORE_2"]);
      expect(request.seen.TABL, "everything asked before, so the dumper skips it").to.deep.equal(["ZOSD_H5C_HEAD"]);
      let state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.pending.dumpDir).to.equal(dumpDirOf(root, 3));

      // the next run picks up where this one stopped: it executes the
      // pending round, the merge resolves the name, the walk reaches the
      // fixed point
      const second = await run(["--system", "h5c"], {root, env});
      expect(second.stopped).to.equal("fixed-point");
      expect(second.iteration).to.equal(3);
      expect(dumperCalls(root)).to.have.lengthOf(2);
      state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.pending).to.equal(undefined);
      expect(state.dump).to.equal(dumpDirOf(root, 3));
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a merge tool that does not know --from-dump says what it needs", async function () {
    this.timeout(180000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {dumper: false, noFromDump: true}));
    try {
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
        expect.fail("the unknown option was swallowed");
      } catch (error) {
        expect(error.message).to.include("predates --from-dump (PR #926, merged)");
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved: a method whose only miss is a table is not stubbed -- the table is asked that iteration", async function () {
    this.timeout(300000);
    // H5x-1's eager rule: a DDIC-kind miss is requested from the dumper in
    // the same iteration (a DDIC closure is cheap and pulls no code), and
    // while the dumper can still answer the body stays. The fake dumper
    // resolves the table: asked in iteration 1, filled, the method never
    // stubbed, stub count 0.
    const root = scratch(CLAS_STUB_SOURCE, "zcl_h5c_stub");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_stub.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      expect(dumperCalls(root), "one dumper round: the table was asked, not deferred").to.have.lengthOf(1);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.TABL, "the method's miss is in the request").to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(request.deferred.TABL, "a table is eager now: nothing is deferred").to.deep.equal([]);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.asked.ZOSD_H5C_HEAD.kinds, "asked, the opposite of round 3's never-asked").to.deep.equal(["TABL"]);
      expect(JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")), "stub count 0").to.deep.equal({roots: [], cascades: [], cycles: [], stubs: [], waits: [], errors: [], excluded: {}});
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"), "utf8");
      expect(islandFile, "the body stayed").to.not.include("RAISE EXCEPTION");
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("0 stubbed method(s)"))).to.equal(true);
      expect(said.some((l) => l.includes("awaiting the dumper's DDIC answer"))).to.equal(true);
      expect(said.some((l) => /^stub: no stubbable finding remains after 0 round/.test(l))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved: a table the dictionary lacks is a gap, and the stub records it", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_STUB_SOURCE, "zcl_h5c_stub");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_stub.clas.abap", missingNames: "ZOSD_H5C_HEAD"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.stubs, "method stubs are the record's stubs section").to.have.lengthOf(1);
      expect(record.stubs[0].file).to.equal(join("gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"));
      expect(record.stubs[0].object).to.equal("ZCL_H5C_STUB");
      expect(record.stubs[0].class).to.equal("ZCL_H5C_STUB");
      expect(record.stubs[0].method).to.equal("TWO");
      expect(record.stubs[0].missing, "the stub records the gap").to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(record.roots, "nothing excluded here").to.deep.equal([]);
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"), "utf8");
      expect(islandFile).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_HEAD'.`);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.deferred.TABL, "the gap is a gap, not deferred").to.deep.equal([]);
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_HEAD");
      expect(gaps[0].kind).to.equal("TABL");
      expect(gaps[0].iterations_requested).to.equal(2);
      expect(said.some((l) => l === "stub round 1: ZCL_H5C_STUB: 1 method(s) stubbed (generation h5c_sha)")).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved: a code-kind miss stays deferred and the method is stubbed", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_CODE_SOURCE, "zcl_h5c_code", {island2Name: "zcl_h5c_def.clas.abap", island2Source: CLAS_DEF_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_code.clas.abap", island2Name: "zcl_h5c_def.clas.abap"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.TABL, "the definition-level name is requested").to.deep.equal(["ZOSD_H5C_DEF"]);
      expect(request.deferred.CLAS, "the code name is deferred, lazy, grows on the miss").to.deep.equal(["ZCL_H5C_FAR"]);
      expect(JSON.stringify(request.requested), "the deferred name is not requested").to.not.include("ZCL_H5C_FAR");
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps.map((g) => g.name), "a deferred name is not a gap").to.deep.equal([]);
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_code.clas.abap"), "utf8");
      expect(islandFile).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZCL_H5C_FAR'.`);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--defer-ddic keeps round 3: every name of a stubbed method is lazy, even the dictionary's", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_STUB_SOURCE, "zcl_h5c_stub", {island2Name: "zcl_h5c_def.clas.abap", island2Source: CLAS_DEF_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_stub.clas.abap", island2Name: "zcl_h5c_def.clas.abap"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved", "--defer-ddic"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.deferred.TABL, "the table is deferred like code").to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(JSON.stringify(request.requested), "and not requested").to.not.include("ZOSD_H5C_HEAD");
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.stubs.length, "the method is stubbed at once").to.be.at.least(1);
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"), "utf8");
      expect(islandFile).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_HEAD'.`);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved: definition-level findings exclude the class through the build's own seam; the method is stubbed beside it", async function () {
    this.timeout(300000);
    // one class unresolvable at the definition level (the dumper answered
    // missing for its type), one method-level miss the dumper also refused,
    // and a third class arriving with the second dump so the walk goes one
    // more round -- that request is the one carrying the excluded object
    const root = scratch(CLAS_DEFEX_SOURCE, "zcl_h5c_defex",
      {island2Name: "zcl_h5c_stub.clas.abap", island2Source: CLAS_STUB_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_defex.clas.abap", island2Name: "zcl_h5c_stub.clas.abap",
      missingNames: "ZOSD_H5C_DEAD,ZOSD_H5C_HEAD", grow: true}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(dumperCalls(root), "one round per iteration: the exclusion never stopped the walk").to.have.lengthOf(2);
      // the record: the definition-level exclusion (and the method stub of
      // the round that applied it)
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      const excluded = record.roots[0];
      expect(excluded.object).to.equal("ZCL_H5C_DEFEX");
      expect(excluded.kind).to.equal("CLAS");
      expect(excluded.missing, "the definition reference's answered-absent name").to.deep.equal(["ZOSD_H5C_DEAD"]);
      expect(excluded.file).to.equal(join("gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_defex.clas.abap"));
      expect(excluded.findings).to.have.lengthOf(1);
      expect(excluded.findings[0]).to.match(/contains unknown: ZOSD_H5C_DEAD not found/);
      // the file stays in its layer on disk, never deleted and never rewritten
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_defex.clas.abap"), "utf8"))
        .to.equal(CLAS_DEFEX_SOURCE);
      // the request carries the object under excluded -- its own top-level
      // key, not deferred -- beside the fresh name the walk is still chasing
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(Object.keys(request).sort()).to.include("excluded");
      expect(request.excluded.CLAS).to.deep.equal(["ZCL_H5C_DEFEX"]);
      expect(request.requested.TABL, "the walk went on: the second dump's name").to.deep.equal(["ZOSD_H5C_MORE_2"]);
      expect(request.deferred.TABL).to.deep.equal([]);
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps.map((g) => g.name).sort(), "the dead names are gaps").to.deep.equal(["ZOSD_H5C_DEAD", "ZOSD_H5C_HEAD"]);
      // the iteration line counts the exclusion
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("1 excluded"))).to.equal(true);
      // the stubbed method beside it, and the build's own config carrying
      // the exclusion
      const stubFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"), "utf8");
      expect(stubFile).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_HEAD'.`);
      const {ownConfig} = await import("../tools/osd-build.mjs");
      const {layers} = await import("../tools/osd-inputs.mjs");
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const own = ownConfig(root, config, layers(root, config), join(root, "output"));
      expect(own.exclude_filter).to.include(`(^|/)gen/hana-src/000-h5c-main/src/zcl_h5c_defex\\.clas\\.abap$`);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a registered service's own class is never excluded: the run fails with the object and its findings", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_DEFEX_SOURCE, "zcl_h5x1_svc_dpc_ext");
    mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
    writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
      {service: "h5x1", version: "0001", dpc: "ZCL_H5X1_SVC_DPC_EXT", mpc: "ZCL_H5X1_SVC_MPC_EXT"},
    ]}) + "\n");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5x1_svc_dpc_ext.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    try {
      let message;
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env});
        expect.fail("the service's own class was excluded");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("ZCL_H5X1_SVC_DPC_EXT");
      expect(message).to.match(/registered service/);
      expect(message, "the findings travel with it").to.match(/contains unknown: ZOSD_H5C_DEAD not found/);
      // the file is whole, and nothing excluded it
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5x1_svc_dpc_ext.clas.abap"), "utf8"))
        .to.equal(CLAS_DEFEX_SOURCE);
      expect(JSON.stringify(JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"))))
        .to.not.include("ZCL_H5X1_SVC_DPC_EXT");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a present-but-red superclass makes the dependent a cascade: the root is excluded, the dependent falls with it", async function () {
    this.timeout(300000);
    // the round-0 shape re-measured (the island holds the broken
    // superclass; the dependent's definition names it): fix round 1
    // excluded the DEPENDENT here -- a present name counted as answered
    // although present-red, the bed's run-15 bug that swallowed the EPM
    // core. Fix round 2: the broken superclass is the ROOT (its findings
    // name nothing), excluded level definition; the dependent is recorded
    // as its cascade and falls with it on re-evaluation. Never requested,
    // never a gap, no dumper round at all.
    const root = scratch(CLAS_USER_SOURCE, "zcl_h5c_user",
      {island2Name: "zcl_h5c_far.clas.abap", island2Source: CLAS_FAR_BROKEN_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_user.clas.abap", island2Name: "zcl_h5c_far.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(1);
      expect(existsSync(join(root, "dumper-log.jsonl")), "no dumper round: nothing to ask").to.equal(false);
      expect(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).to.not.include("ZCL_H5C_FAR");
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(Object.keys(state.asked), "nothing was asked at all").to.deep.equal([]);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      const far = record.roots.find((e) => e.object === "ZCL_H5C_FAR");
      expect(far, "the broken superclass is the root (its parse findings name nothing)").to.be.an("object");
      expect(far.findings.length, "its own parse findings are the record").to.be.greaterThan(0);
      const user = record.cascades.find((e) => e.object === "ZCL_H5C_USER");
      expect(user, "the dependent falls as its cascade, in the same decision").to.be.an("object");
      expect(user.of).to.deep.equal(["ZCL_H5C_FAR"]);
      expect(user.excluded).to.equal(true);
      expect(user.findings[0]).to.match(/Super class "zcl_h5c_far" not found or contains/);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_user.clas.abap"), "utf8"))
        .to.equal(CLAS_USER_SOURCE);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved caps at --max-stub-rounds and leaves the rest in the request", async function () {
    this.timeout(300000);
    // no exception class in the tree: the stub itself cannot resolve, so
    // every round would stub again -- the cap stops the rewriting and the
    // leftover names stay in the request
    const root = scratch(CLAS_CODE_SOURCE, "zcl_h5c_code", {noZcx: true});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_code.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved", "--max-stub-rounds", "1"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(said.filter((l) => l.startsWith("stub cap:")).length, "the cap said itself in both passes").to.be.at.least(2);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.deferred.CLAS, "the first stub's code name is deferred").to.deep.equal(["ZCL_H5C_FAR"]);
      expect(JSON.stringify(request), "the stub raise's own class is still missing: the request asks for it").to.include("ZCX_OSD_NOT_ACTIVATED");
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps.map((g) => g.name)).to.include("ZCX_OSD_NOT_ACTIVATED");
      expect(gaps.map((g) => g.name), "the deferred code name is not a gap").to.not.include("ZCL_H5C_FAR");
      const stubbedSource = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_code.clas.abap"), "utf8");
      expect(stubbedSource).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZCL_H5C_FAR'.`);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the real build: a two-file island with one definition-level class transpiles GREEN with that class excluded", async function () {
    this.timeout(300000);
    // H5x-1's acceptance, proven by the build's own path and not by a
    // comment: the loop's record in gen/hana-closure/closure-stubs.json is
    // the input of osd-build's own exclusion seam (ownConfig), and with it
    // the transpile exits 0 while the excluded file stays in its layer on
    // disk. RED control first: without the record the same build fails on
    // the definition-level type.
    const {build, ownConfig} = await import("../tools/osd-build.mjs");
    const {layers} = await import("../tools/osd-inputs.mjs");
    const {definitionExclusions} = await import("../tools/hana-closure-exclusions.mjs");
    const root = mkdtempSync(join(tmpdir(), "hana-closure-realbuild-"));
    const envNames = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_IMAGE_PACKS"];
    const saved = Object.fromEntries(envNames.map((n) => [n, process.env[n]]));
    try {
      symlinkSync(join(REPO, "node_modules"), join(root, "node_modules"), "dir");
      writeFileSync(join(root, "package.json"), JSON.stringify({name: "hana-closure-realbuild", private: true}) + "\n");
      writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({
        input_folder: ["gen/hana-src/*"],
        output_folder: "output",
        libs: [],
        write_source_map: false,
        options: {ignoreSyntaxCheck: false, addFilenames: true, addCommonJS: true, unknownTypes: "compileError"},
      }, null, 2) + "\n");
      const island = join(root, "gen", "hana-src", "000-h5x1", "src");
      mkdirSync(island, {recursive: true});
      writeFileSync(join(island, "zcl_h5c_clean.clas.abap"), CLAS_CLEAN_SOURCE);
      writeFileSync(join(island, "zcl_h5c_defex.clas.abap"), CLAS_DEFEX_SOURCE);
      for (const n of envNames) delete process.env[n];
      let red;
      try {
        await build({root, generators: false, switch: false, log: () => {}});
        expect.fail("the build passed with the definition-level class in it");
      } catch (error) {
        red = error;
      }
      expect(`${String(red.output ?? "")}\n${red.message ?? ""}`).to.match(/ZOSD_H5C_DEAD/);
      // the walk's record, exactly as the loop writes it
      mkdirSync(join(root, "gen", "hana-closure"), {recursive: true});
      writeFileSync(join(root, "gen", "hana-closure", "closure-stubs.json"), JSON.stringify({
        roots: [{level: "definition", object: "ZCL_H5C_DEFEX", kind: "CLAS", file: "gen/hana-src/000-h5x1/src/zcl_h5c_defex.clas.abap",
          missing: ["ZOSD_H5C_DEAD"],
          findings: [`unknown_types, Variable "GV_H5C" contains unknown: ZOSD_H5C_DEAD not found, lookup, zcl_h5c_defex.clas.abap:3`]}],
        cascades: [], cycles: [], stubs: [], waits: [], excluded: {CLAS: ["ZCL_H5C_DEFEX"]},
      }, null, 2) + "\n");
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const own = ownConfig(root, config, layers(root, config), join(root, "build", "tmp", "out"));
      expect(own.exclude_filter).to.include(`(^|/)gen/hana-src/000-h5x1/src/zcl_h5c_defex\\.clas\\.abap$`);
      const built = await build({root, generators: false, switch: false, log: () => {}});
      expect(built.ok, "the transpile is GREEN with the class excluded").to.equal(true);
      expect(definitionExclusions(root)).to.have.lengthOf(1);
      expect(existsSync(join(island, "zcl_h5c_defex.clas.abap")), "the file stays in its layer on disk").to.equal(true);
    } finally {
      for (const n of envNames) {
        if (saved[n] === undefined) delete process.env[n];
        else process.env[n] = saved[n];
      }
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--stub-unresolved: a method whose findings name nothing is stubbed with the finding as its reason, and the framework gaps are listed", async function () {
    this.timeout(300000);
    // the bed's DPC_EXT shape: members the clean-room framework layer lacks
    // name nothing the dumper could bring -- a runtime method, a changeset
    // component, a message container. The bodies go, each raise carries its
    // finding's text (S-3: a GET never says needs ''), and the iteration
    // writes gen/hana-closure/framework-gaps.json beside the stubs: the work
    // list of what the island's framework layer is missing.
    const GAPS_SOURCE = [
      `CLASS zcl_h5c_gaps DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS get_rows.`,
      `    METHODS get_ctx.`,
      `    METHODS get_main.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_gaps IMPLEMENTATION.`,
      `  METHOD get_rows.`,
      `    me->get_h5c_thing( ).`,
      `  ENDMETHOD.`,
      `  METHOD get_ctx.`,
      `    DATA ls_h5c TYPE zosd_h5c_ctx.`,
      `    ls_h5c-h5c_thing = 1.`,
      `  ENDMETHOD.`,
      `  METHOD get_main.`,
      `    me->mo_h5c_ctx->run( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(GAPS_SOURCE, "zcl_h5c_gaps");
    // the structure the component cascade reads is IN the island (staged by
    // the converter's layer), so the component finding names nothing
    writeFileSync(join(root, "island", "zosd_h5c_ctx.tabl.xml"),
      tablXml({name: "ZOSD_H5C_CTX", text: "h5c fixture", clidep: false,
        fields: ddicFields([{position: "1", fieldname: "ZOSD_H5C_KEY", keyflag: "X", rollname: "",
          datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X"}])}));
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_gaps.clas.abap", convAFiles: ["zosd_h5c_ctx.tabl.xml"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(1);
      expect(existsSync(join(root, "dumper-log.jsonl")), "nameless findings ask nothing").to.equal(false);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      const stubs = record.stubs;
      expect(stubs, "three nameless methods stubbed").to.have.lengthOf(3);
      for (const e of stubs) expect(e.missing).to.deep.equal([]);
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_gaps.clas.abap"), "utf8");
      expect(islandFile).to.contain(`missing = 'Method "get_h5c_thing" not found'`);
      expect(islandFile).to.contain(`missing = 'Component "h5c_thing" not found in structure'`);
      expect(islandFile).to.contain(`missing = 'Attribute or constant "mo_h5c_ctx" not found in "zcl_h5c_gaps"'`);
      expect(islandFile, "a raise never says needs ''").to.not.contain(`missing = ''`);
      const gaps = JSON.parse(readFileSync(outFile(root, "framework-gaps.json"), "utf8"));
      expect(gaps.map((e) => e.finding)).to.deep.equal([
        `Attribute or constant "mo_h5c_ctx" not found in "zcl_h5c_gaps"`,
        `Component "h5c_thing" not found in structure`,
        `Method "get_h5c_thing" not found`,
      ]);
      expect(gaps.map((e) => e.member)).to.deep.equal(["mo_h5c_ctx", "h5c_thing", "get_h5c_thing"]);
      const rows = gaps.find((e) => e.finding === `Method "get_h5c_thing" not found`).used_by;
      expect(rows).to.have.lengthOf(1);
      expect(rows[0].file).to.equal("zcl_h5c_gaps.clas.abap");
      expect(rows[0].method).to.equal("GET_ROWS");
      expect(rows[0].line).to.be.a("number");
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("framework gaps: 3"))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("--out moves the whole seam with it: the record lands in --out and the build reads it from there (S-1)", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_DEFEX_SOURCE, "zcl_h5c_defex");
    fixtureDump(join(root, "dump-001"));
    const closureOut = join(root, "closure-out");
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_defex.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    const saved = process.env.OSD_HANA_CLOSURE_OUT;
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved",
        "--out", closureOut], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(existsSync(join(root, "gen", "hana-closure")), "the fixed path is never created").to.equal(false);
      const record = JSON.parse(readFileSync(join(closureOut, "closure-stubs.json"), "utf8"));
      expect(record.roots.some((e) => e.object === "ZCL_H5C_DEFEX")).to.equal(true);
      expect(record.excluded.CLAS, "the excluded map carries the object per kind").to.deep.equal(["ZCL_H5C_DEFEX"]);
      expect(JSON.parse(readFileSync(join(closureOut, "framework-gaps.json"), "utf8"))).to.deep.equal([]);
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("1 excluded"))).to.equal(true);
      // the build's ownConfig reads the same record, through the env var the
      // loop also hands its own spawned builds
      const {ownConfig} = await import("../tools/osd-build.mjs");
      const {layers} = await import("../tools/osd-inputs.mjs");
      process.env.OSD_HANA_CLOSURE_OUT = closureOut;
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const own = ownConfig(root, config, layers(root, config), join(root, "output"));
      expect(own.exclude_filter).to.include(`(^|/)gen/hana-src/000-h5c-main/src/zcl_h5c_defex\\.clas\\.abap$`);
    } finally {
      if (saved === undefined) delete process.env.OSD_HANA_CLOSURE_OUT;
      else process.env.OSD_HANA_CLOSURE_OUT = saved;
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the loop writes the record the real build reads, and the exclusion renames the generation (S-2)", async function () {
    this.timeout(300000);
    // item 4's real-build unit proved the seam with a hand-written record;
    // this one proves the trigger: the loop excludes the class itself, the
    // real build goes green over the loop's own tree, the file stays in its
    // layer -- and the generation is NAMED by the exclusion, so a cached
    // generation cannot predate the record (S-2).
    const root = scratch(CLAS_DEFEX_SOURCE, "zcl_h5c_defex");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_defex.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    const envNames = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_IMAGE_PACKS"];
    const savedEnv = Object.fromEntries(envNames.map((n) => [n, process.env[n]]));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots.some((e) => e.object === "ZCL_H5C_DEFEX")).to.equal(true);
      const {build, ownConfig, hashOf, inputsOf} = await import("../tools/osd-build.mjs");
      const {layers} = await import("../tools/osd-inputs.mjs");
      const {excludedFiles} = await import("../tools/hana-closure-exclusions.mjs");
      // the build under test keeps the tree's own exception chain and the
      // stub exception class (src/**), but the scratch's zcl_h5c_own
      // fixture -- outside the island on purpose -- is not this build's
      // business and is removed
      rmSync(join(root, "src", "zcl_h5c_own.clas.abap"), {force: true});
      const config = JSON.parse(readFileSync(join(root, "abap_transpile.json"), "utf8"));
      const exclusions = excludedFiles(root);
      expect(exclusions).to.have.lengthOf(1);
      const inputs = inputsOf(root, config);
      expect(hashOf(root, inputs), "without the exclusions the name is the old one")
        .to.not.equal(hashOf(root, inputs, {exclusions}));
      for (const n of envNames) delete process.env[n];
      const built = await build({root, generators: false, switch: false, log: () => {}});
      expect(built.ok, "the transpile is green with the loop's class excluded").to.equal(true);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_defex.clas.abap"), "utf8"))
        .to.equal(CLAS_DEFEX_SOURCE);
      const own = ownConfig(root, config, layers(root, config), join(root, "output"));
      expect(own.exclude_filter).to.include(`(^|/)gen/hana-src/000-h5c-main/src/zcl_h5c_defex\\.clas\\.abap$`);
    } finally {
      for (const n of envNames) {
        if (savedEnv[n] === undefined) delete process.env[n];
        else process.env[n] = savedEnv[n];
      }
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("without --stub-unresolved the same island is round 2: everything is requested, nothing is stubbed", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_STUB_SOURCE, "zcl_h5c_stub", {island2Name: "zcl_h5c_def.clas.abap", island2Source: CLAS_DEF_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_stub.clas.abap", island2Name: "zcl_h5c_def.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(Object.keys(request), "no deferred key without the flag").to.not.include("deferred");
      expect([...request.requested.TABL].sort()).to.deep.equal(["ZOSD_H5C_DEF", "ZOSD_H5C_HEAD"]);
      expect(existsSync(outFile(root, "closure-stubs.json")), "no stubs file without the flag").to.equal(false);
      const islandFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_stub.clas.abap"), "utf8");
      expect(islandFile).to.not.include("RAISE EXCEPTION");
      expect(said.some((l) => l.startsWith("stub ")), "no stub line without the flag").to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the island accumulates: a second dump that lacks the first's objects cannot erase them", async function () {
    this.timeout(300000);
    // FIX-4 (bed run 5): each hana-src-gen --from-dump REPLACED gen/hana-src,
    // so iteration 2 validated a tree without the service and the fixed point
    // was false. The island is the UNION of the seed dump and every dump so
    // far, later wins per object: the fake converter stages each dump's
    // layers, the fake host lays the union, and the first dump's class must
    // still be in the island at the fixed point.
    const SECOND_SOURCE = [
      `CLASS zcl_h5c_second DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_second IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    SELECT SINGLE * FROM zosd_h5c_head INTO @DATA(ls_h5c_second) ##SUBRC_OK.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(CLAS_SOURCE, "zcl_h5c_loop", {island2Name: "zcl_h5c_second.clas.abap", island2Source: SECOND_SOURCE});
    mkdirSync(join(root, ".git"));
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_loop.clas.abap", convBFiles: ["zcl_h5c_second.clas.abap"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      const island = join(root, "gen", "hana-src", "000-h5c-main", "src");
      expect(existsSync(join(island, "zcl_h5c_loop.clas.abap")), "the first dump's class survived the second merge").to.equal(true);
      expect(existsSync(join(island, "zcl_h5c_second.clas.abap")), "the second dump's class is there").to.equal(true);
      expect(existsSync(join(root, "gen", "hana-ddic", "zosd_h5c_head.tabl.xml")), "the DDIC accumulated (per-file overlays)").to.equal(true);
      // the counts are on the iteration lines and never went down
      expect(said.filter((l) => /island object/.test(l))).to.have.lengthOf(2);
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("1 island object(s)"))).to.equal(true);
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("3 island object(s)"))).to.equal(true);
      // the state remembers the layers dirs per dump, and the object count
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.layers).to.have.lengthOf(2);
      expect(state.islandObjects).to.deep.equal({clas: 2, intf: 0, tabl: 1, total: 3});
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the converter is the writer of record: DDIC XML in the layers skips hana-ddic-gen", async function () {
    this.timeout(300000);
    // round 5 (a4h-i7): the converter master writes .tabl/.dtel/.doma/.ttyp
    // XML from the dump's DD* rows, and the layers carry it into the build
    // through hana-src-gen alone. The loop must not write gen/hana-ddic
    // from the dump on top of it: the step is skipped (one log line says
    // so), the table resolves from the layer, and the walk converges with
    // NO dumper round and NO hana-ddic-gen call. The cross-check
    // (--from-dump --against <layers>) is a follow-up, not built.
    const root = scratch(CLAS_SOURCE);
    writeFileSync(join(root, "island", "zosd_h5c_head.tabl.xml"),
      tablXml({name: "ZOSD_H5C_HEAD", text: "h5c fixture", clidep: false,
        fields: ddicFields([{position: "1", fieldname: "ZOSD_H5C_KEY", keyflag: "X", rollname: "",
          datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X"}])}));
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_loop.clas.abap", convAFiles: ["zosd_h5c_head.tabl.xml"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration, "the layer closed the name: no dumper round").to.equal(1);
      expect(existsSync(join(root, "dumper-log.jsonl")), "no dumper round ran").to.equal(false);
      const merges = hostCalls(root);
      expect(merges.map((m) => m.tool), "no hana-ddic-gen: the converter wrote the table").to.deep.equal(
        ["hana-src-gen.mjs", "osd-build.mjs"]);
      expect(merges[0].rest).to.deep.equal(
        ["--layers", layersDirOf(root, 1), "--out", join(root, "gen", "hana-src")]);
      // the converter's argv is the real converter's contract, with the flag
      // the in-tree layers dir needs: .local/hana-closure/ sits inside the
      // git working tree, which the converter refuses to write without
      // --allow-in-repo (the fake refuses it with the real wording; the
      // .git scenarios run that refusal end to end)
      const convs = converterCalls(root);
      expect(convs).to.have.lengthOf(1);
      expect(convs[0].argv.slice(0, 1)).to.deep.equal([join(root, "dump-001")]);
      expect(convs[0].out).to.equal(layersDirOf(root, 1));
      expect(convs[0].argv.join(" ")).to.include("--system h5c");
      expect(convs[0].allowInRepo, "the layers land inside the tree: the flag must travel").to.equal(true);
      expect(said.some((l) => l.includes("the layers carry the DDIC XML (1 file(s)) -- hana-ddic-gen --from-dump is skipped, the converter is the writer of record")),
        "the skip says itself").to.equal(true);
      expect(existsSync(join(root, "gen", "hana-ddic")), "gen/hana-ddic is not written").to.equal(false);
      expect(existsSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zosd_h5c_head.tabl.xml")), "the layer carries the table").to.equal(true);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.islandObjects, "the layer's table counts (the shrink control is not blind)").to.deep.equal({clas: 1, intf: 0, tabl: 1, total: 2});
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the per-name DDIC fill: the layers carry some DDIC, the dump resolved more, the rest is filled", async function () {
    this.timeout(300000);
    // FIX-7 item 1 (bed run 10): the converter writes DDIC XML only for the
    // objects its TADIR package selection covers, and with the converter as
    // the writer of record the loop skipped the dump's own DDIC merge -- so
    // 86 resolved DOMA / 156 DTEL / 25 TABL produced 10 dtel + 7 tabl. The
    // writer of record is per NAME: every resolved DDIC name without an
    // island XML is written by hana-ddic-gen --from-dump --names for exactly
    // those names, into gen/hana-ddic (which layers before gen/hana-src, so
    // where the converter DID write one, its file wins).
    const root = scratch(CLAS_BPA_SOURCE, "zcl_h5c_bpa");
    // the converter's one table: the TADIR selection covered this one
    writeFileSync(join(root, "island", "zosd_h5c_head.tabl.xml"),
      tablXml({name: "ZOSD_H5C_HEAD", text: "h5c fixture", clidep: false,
        fields: ddicFields([{position: "1", fieldname: "ZOSD_H5C_KEY", keyflag: "X", rollname: "",
          datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X"}])}));
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_bpa.clas.abap", convAFiles: ["zosd_h5c_head.tabl.xml"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration, "the fill closed the name in the same round").to.equal(2);
      const merges = hostCalls(root);
      const fill = merges.find((m) => m.tool === "hana-ddic-gen.mjs" && m.rest.includes("--names"));
      expect(fill, "the fill ran").to.be.an("object");
      expect(fill.rest, "exactly the name the layers do not carry, from the dump that resolved it").to.deep.equal(
        ["--from-dump", dumpDirOf(root, 2), "--names", "ZOSD_H5C_BPA", "--out", join(root, "gen", "hana-ddic")]);
      expect(existsSync(join(root, "gen", "hana-ddic", "zosd_h5c_bpa.tabl.xml")), "the resolved name is written").to.equal(true);
      expect(existsSync(join(root, "gen", "hana-ddic", "zosd_h5c_head.tabl.xml")), "the converter's file is not duplicated").to.equal(false);
      expect(existsSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zosd_h5c_head.tabl.xml")), "the converter's file wins in the island").to.equal(true);
      expect(said.some((l) => l.startsWith("ddic fill:") && l.includes("without an island XML")),
        "the fill says itself").to.equal(true);
      // the iteration line carries the resolved-vs-written counts (item 4):
      // a writer-of-record hole shows as written < resolved. Here resolved
      // counts the one ASKED name the dump answered (the converter's HEAD
      // was never asked), and written counts both island XMLs: TABL 1/2.
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("DDIC resolved/written: TABL 1/2")),
        "resolved and written per kind, on the line").to.equal(true);
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.resolved, "the resolved names accumulate per kind").to.deep.equal({TABL: ["ZOSD_H5C_BPA"]});
      expect(state.islandObjects, "the fill's table counts (the shrink control is not blind)").to.deep.equal({clas: 1, intf: 0, tabl: 2, total: 3});
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("the island carries no test code: *.testclasses.abap and *_TEST classes are not staged", async function () {
    this.timeout(300000);
    // FIX-7 item 2 (bed run 12: 157 of the island's findings sat in
    // *.clas.testclasses.abap, among them SAP's unit-test assertion class
    // pulled through a facade's test include and stubbed method by method).
    // The dumper keeps CCAU test includes out of the closure
    // (--skip-test-includes, asserted above); a dump that carries them
    // anyway does not stage them into gen/hana-src, and their findings are
    // not island findings.
    const root = scratch();
    writeFileSync(join(root, "island", "zcl_h5c_loop.clas.testclasses.abap"), TESTCLASSES_SOURCE);
    writeFileSync(join(root, "island", "zcl_h5c_helper_test.clas.abap"), TESTCLASS_SOURCE);
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {convAFiles: ["zcl_h5c_loop.clas.testclasses.abap", "zcl_h5c_helper_test.clas.abap"]}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      expect(dumperCalls(root), "the test code did not grow the walk").to.have.lengthOf(1);
      expect(readdirSync(join(root, "gen", "hana-src", "000-h5c-main", "src")).sort(),
        "only the class is staged, neither test file").to.deep.equal(["zcl_h5c_loop.clas.abap"]);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.TABL).to.deep.equal(["ZOSD_H5C_HEAD"]);
      expect(JSON.stringify(request), "a test include's table is never asked").to.not.include("ZOSD_H5C_TTEST");
      expect(JSON.stringify(request)).to.not.include("ZOSD_H5C_TTEST2");
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(Object.keys(state.asked), "nor asked in any round").to.deep.equal(["ZOSD_H5C_HEAD"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("an unhandled kind is unanswered, not missing: a kind's missing wins over it", async function () {
    this.timeout(300000);
    // closure.unhandled = the request kinds the
    // dumper's closure does not follow (FIX-1's dumper update). TABL and
    // DTEL answered missing (does not exist), TTYP is unanswered: the gap
    // stands under the missing kind, and the unhandled entry adds neither
    // a kind nor a reason
    const root = scratch(CLAS_TYPE_SOURCE, "zcl_h5c_type");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_type.clas.abap", missingKinds: "TABL,DTEL,DOMA", unhandledKinds: "TTYP"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_W");
      expect(gaps[0].kind, "the missing kind, not the unhandled one").to.be.oneOf(["TABL", "DTEL", "DOMA"]);
      expect(gaps[0].reason, "does-not-exist is the stronger word: no unhandled reason").to.equal(undefined);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a name unanswered only under unhandled kinds gaps with the unhandled reason", async function () {
    this.timeout(300000);
    const root = scratch(CLAS_TYPE_SOURCE, "zcl_h5c_type");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_type.clas.abap", unhandledKinds: "TABL,DTEL,TTYP,DOMA"}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
      expect(result.stopped).to.equal("fixed-point");
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps).to.have.lengthOf(1);
      expect(gaps[0].name).to.equal("ZOSD_H5C_W");
      expect(gaps[0].kind).to.equal("TABL");
      expect(gaps[0].reason).to.equal("unhandled by the dumper's closure");
      expect(gaps[0].iterations_requested).to.equal(2);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a shrinking island aborts the run with both counts", async function () {
    this.timeout(300000);
    // the assert behind the accumulation: if the merge ever loses objects
    // (H5C_SHRINK=1 makes the fake host write only the last dump's layers --
    // the round-3 bug, on demand), the run dies instead of "converging"
    const root = scratch(CLAS_SOURCE, "zcl_h5c_loop", {island2Name: "zcl_h5c_def.clas.abap", island2Source: CLAS_DEF_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_loop.clas.abap", island2Name: "zcl_h5c_def.clas.abap", shrink: true, missingKinds: "TABL"}));
    try {
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
        expect.fail("the shrinking island was not caught");
      } catch (error) {
        expect(error.message).to.include("the island shrank: 2 -> 0");
        expect(error.message).to.include("clas 2 -> 0");
        expect(error.message).to.include("classes+interfaces+tables");
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a build that fails with no findings is not a fixed point", async function () {
    this.timeout(300000);
    // bed run 4's control: osd-build FAILED on a generator step with zero
    // transpiler findings, and the loop read that as convergence. The fixed
    // point now needs the build's own exit code.
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {build: "fail-quiet"}));
    try {
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env});
        expect.fail("the empty validate was trusted as a fixed point");
      } catch (error) {
        expect(error.message).to.include("not a fixed point");
        expect(error.message).to.include("FAILED: node --import");
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a failed build that still carries findings leaves the fixed point standing", async function () {
    this.timeout(300000);
    const root = scratch();
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {build: "fail-findings"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped, "exit 1 with findings only: the walk's ordinary material").to.equal("fixed-point");
      expect(said.some((l) => l.startsWith("build: exited 1 with 1 finding(s)"))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("refuses unknown options and a first run without a dump", async () => {
    const root = scratch();
    try {
      try {
        await run(["--bogus"], {root, env: {}});
        expect.fail("unknown option accepted");
      } catch (error) {
        expect(error.message).to.include("unknown option");
      }
      try {
        await run([], {root, env: {}});
        expect.fail("a dumpless first run accepted");
      } catch (error) {
        expect(error.message).to.match(/dump/);
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  // --------------------------------------------------- fix round 2 ----

  it("fix2 item 1: a superclass arriving one iteration later -- no exclusion in the early iteration, clean at the end", async function () {
    this.timeout(300000);
    // the bed's knot in miniature (run 15): the dependent and its red
    // superclass are in the island from iteration 1, the superclass's own
    // superclass is missing and unasked. Fix round 1 excluded the DEPENDENT
    // in iteration 1 (a present name counted as answered although
    // present-red) and the chain fell one object per iteration. Now the
    // gate waits for the missing name, the dumper brings the superclass,
    // and every object is clean at the end.
    const root = scratch(CLAS_USER_SOURCE, "zcl_h5c_user",
      {island2Name: "zcl_h5c_mid.clas.abap", island2Source: CLAS_MID_SOURCE});
    fixtureDump(join(root, "dump-001"));
    writeFileSync(join(root, "island", "zcl_h5c_far.clas.abap"), CLAS_FAR_SOURCE);
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_user.clas.abap",
      island2Name: "zcl_h5c_mid.clas.abap", convBFiles: ["zcl_h5c_far.clas.abap"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      expect(dumperCalls(root), "one round: the missing superclass was asked").to.have.lengthOf(1);
      expect(said.some((l) => /excluded:|cascade:|cycle:/.test(l)), "no exclusion decided anywhere").to.equal(false);
      expect(JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")), "no record of any kind").to.deep.equal({roots: [], cascades: [], cycles: [], stubs: [], waits: [], errors: [], excluded: {}});
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_mid.clas.abap"), "utf8"))
        .to.equal(CLAS_MID_SOURCE);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_user.clas.abap"), "utf8"))
        .to.equal(CLAS_USER_SOURCE);
      const state = JSON.parse(readFileSync(outFile(root, "state.json"), "utf8"));
      expect(state.asked.ZCL_H5C_FAR.kinds).to.deep.equal(["CLAS"]);
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 3: the chain's roots -- nothing decided early, the roots excluded once the dumper answered, roots only under excluded", async function () {
    this.timeout(300000);
    // FAR never arrives. The INHERITANCE shape names the ULTIMATE missing
    // superclass on every descendant (measured: the validation channel
    // reports `Super class "zcl_h5c_far"` on USER too, not USER's own
    // present-but-red MID -- the reference shapes are the ones that name
    // their present-but-red predecessor, and the scenario below carries
    // that path). So MID and USER are each a root on their own account:
    // nothing is decided in iteration 1 (item 1's gate -- the name was
    // unasked), both are excluded once the dumper answered missing, the
    // re-decision replays it every iteration the island grows, and the
    // request's excluded key carries the LAST decision's roots.
    const root = scratch(CLAS_USER_SOURCE, "zcl_h5c_user",
      {island2Name: "zcl_h5c_mid.clas.abap", island2Source: CLAS_MID_SOURCE});
    fixtureDump(join(root, "dump-001"));
    writeFileSync(join(root, "island", "zcl_h5c_other.clas.abap"), CLAS_OTHER_SOURCE);
    writeFileSync(join(root, "island", "zcl_h5c_walker.clas.abap"), CLAS_WALKER_SOURCE);
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_user.clas.abap",
      island2Name: "zcl_h5c_mid.clas.abap", convBFiles: ["zcl_h5c_other.clas.abap"],
      convCFiles: ["zcl_h5c_walker.clas.abap"], missingNames: "ZCL_H5C_FAR"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(4);
      expect(dumperCalls(root)).to.have.lengthOf(3);
      const iteration1 = said.findIndex((l) => l.includes("iteration 1:"));
      const firstDecision = said.findIndex((l) => /excluded:|cascade:|cycle:/.test(l));
      expect(firstDecision, "nothing is decided in the early iteration (item 1)").to.be.greaterThan(iteration1);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      const mid = record.roots.find((e) => e.object === "ZCL_H5C_MID");
      expect(mid.missing, "the answered-absent superclass is the root's missing name").to.deep.equal(["ZCL_H5C_FAR"]);
      expect(mid.findings[0]).to.match(/Super class "zcl_h5c_far" not found or contains/);
      // the INHERITANCE shape names the ULTIMATE missing superclass on the
      // descendant too (the measured wording): USER is a root on its own
      // account, like MID -- the dependent-of-a-present-but-red-predecessor
      // cascade is the scenario below
      const user = record.roots.find((e) => e.object === "ZCL_H5C_USER");
      expect(user, "the descendant is a root on its own account").to.be.an("object");
      expect(user.missing).to.deep.equal(["ZCL_H5C_FAR"]);
      // the request's excluded key: the LAST decision's roots
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.excluded.CLAS).to.deep.equal(["ZCL_H5C_MID", "ZCL_H5C_USER"]);
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("2 excluded"))).to.equal(true);
      // the files stand, never rewritten
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_mid.clas.abap"), "utf8"))
        .to.equal(CLAS_MID_SOURCE);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_user.clas.abap"), "utf8"))
        .to.equal(CLAS_USER_SOURCE);
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps.map((g) => g.name)).to.include("ZCL_H5C_FAR");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 4: a true cycle A->B->C->A -- recorded, every member stays, nothing excluded", async function () {
    this.timeout(300000);
    // the exact brief fixture, measured against the real transpiler
    // (probes/probe-cycle-order.mjs): three present classes inheriting in a
    // ring emit `Super class "..." not found or contains errors` naming the
    // next member each -- a residual SCC, kept whole
    const CYC = (name, sup) => [
      `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM ${sup}.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS ${name} IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(CYC("zcl_h5c_cyc_a", "zcl_h5c_cyc_b"), "zcl_h5c_cyc_a",
      {island2Name: "zcl_h5c_cyc_b.clas.abap", island2Source: CYC("zcl_h5c_cyc_b", "zcl_h5c_cyc_c")});
    writeFileSync(join(root, "island", "zcl_h5c_cyc_c.clas.abap"), CYC("zcl_h5c_cyc_c", "zcl_h5c_cyc_a"));
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_cyc_a.clas.abap",
      island2Name: "zcl_h5c_cyc_b.clas.abap", convAFiles: ["zcl_h5c_cyc_c.clas.abap"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration, "no missing name: no dumper round").to.equal(1);
      expect(existsSync(join(root, "dumper-log.jsonl"))).to.equal(false);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.cycles).to.have.lengthOf(1);
      expect(record.cycles[0].members).to.deep.equal(["ZCL_H5C_CYC_A", "ZCL_H5C_CYC_B", "ZCL_H5C_CYC_C"]);
      expect(record.cycles[0].kept).to.equal(true);
      expect(Object.keys(record.cycles[0].findings).sort()).to.deep.equal(record.cycles[0].members);
      expect(record.cycles[0].findings.ZCL_H5C_CYC_A[0]).to.match(/Super class "zcl_h5c_cyc_b" not found or contains/);
      for (const f of ["zcl_h5c_cyc_a.clas.abap", "zcl_h5c_cyc_b.clas.abap", "zcl_h5c_cyc_c.clas.abap"]) {
        expect(existsSync(join(root, "gen", "hana-src", "000-h5c-main", "src", f)), `${f} stays in the build`).to.equal(true);
      }
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_cyc_a.clas.abap"), "utf8"))
        .to.equal(CYC("zcl_h5c_cyc_a", "zcl_h5c_cyc_b"));
      expect(said.some((l) => l.startsWith("cycle: ZCL_H5C_CYC_A") && l.includes("kept in the build"))).to.equal(true);
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("3 cycle member(s) kept"))).to.equal(true);
      expect(said.some((l) => /excluded:|cascade:/.test(l)), "nothing excluded").to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 2: the exclusion is re-decided per iteration -- a later dump un-excludes", async function () {
    this.timeout(300000);
    // iteration 2 excludes ZCL_H5C_DEFEX (its type answered missing);
    // iteration 3's dump's layer carries the type's XML -- the island
    // grew, the exclusion is re-decided from scratch: the class is back in
    // the build, clean, and the record carries no definition entry any
    // more. (A once-missing name cannot come back as a RESOLUTION -- the
    // dumper skips seen names -- it comes back as island content, the
    // mechanism item 2 names: the island grew.)
    const root = scratch(CLAS_DEFEX_SOURCE, "zcl_h5c_defex",
      {island2Name: "zcl_h5c_stub.clas.abap", island2Source: CLAS_STUB_SOURCE});
    fixtureDump(join(root, "dump-001"));
    writeFileSync(join(root, "island", "zosd_h5c_dead.tabl.xml"),
      tablXml({name: "ZOSD_H5C_DEAD", text: "h5c fixture", clidep: false,
        fields: ddicFields([{position: "1", fieldname: "ZOSD_H5C_KEY", keyflag: "X", rollname: "",
          datatype: "CHAR", leng: "10", decimals: "0", inttype: "C", intlen: "000020", notnull: "X"}])}));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_defex.clas.abap",
      island2Name: "zcl_h5c_stub.clas.abap", missingNames: "ZOSD_H5C_DEAD,ZOSD_H5C_HEAD",
      convCFiles: ["zosd_h5c_dead.tabl.xml"], grow: true}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(3);
      expect(dumperCalls(root)).to.have.lengthOf(2);
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("1 excluded")), "excluded in iteration 2").to.equal(true);
      expect(said.some((l) => l.includes("iteration 3:") && l.includes("excluded")), "nothing excluded in iteration 3").to.equal(false);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots, "the exclusion was re-decided away").to.deep.equal([]);
      // the type's XML arrived with the third dump's layer; the class
      // compiles again
      expect(existsSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zosd_h5c_dead.tabl.xml")),
        "the third dump's layer carries the type").to.equal(true);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_defex.clas.abap"), "utf8"))
        .to.equal(CLAS_DEFEX_SOURCE);
      // the last request still shows the decision that WAS in force when it
      // was written (iteration 2's), the one the next iteration re-decided
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.excluded.CLAS).to.deep.equal(["ZCL_H5C_DEFEX"]);
      const gaps = JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps;
      expect(gaps.map((g) => g.name)).to.include("ZOSD_H5C_HEAD");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 5: no registration -- the seed classes are protected by suffix, and the line says so", async function () {
    this.timeout(300000);
    const SEED_DEFEX = [
      `CLASS zcl_h5c_svc_dpc_ext DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    DATA gv_h5c TYPE zosd_h5c_dead.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_svc_dpc_ext IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(SEED_DEFEX, "zcl_h5c_svc_dpc_ext");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_svc_dpc_ext.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    const said = [];
    try {
      let message;
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
        expect.fail("the seed class was excluded without a registration");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("ZCL_H5C_SVC_DPC_EXT");
      expect(message).to.match(/registered service/);
      expect(message, "recognised by suffix: no registration exists").to.match(/by suffix/);
      expect(message, "the findings travel with it").to.match(/contains unknown: ZOSD_H5C_DEAD not found/);
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("service guard: by suffix, no registration"))).to.equal(true);
      expect(JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")).roots, "nothing excluded").to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 5: with a registration the guard protects both ways", async function () {
    this.timeout(300000);
    const EXTRA_MPC = [
      `CLASS zcl_h5c_extra_mpc DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    DATA gv_h5c TYPE zosd_h5c_dead.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_extra_mpc IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(EXTRA_MPC, "zcl_h5c_extra_mpc");
    mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
    writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
      {service: "h5x1", version: "0001", dpc: "ZCL_H5X1_SVC_DPC_EXT", mpc: "ZCL_H5X1_SVC_MPC_EXT"},
    ]}) + "\n");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_extra_mpc.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    const said = [];
    try {
      let message;
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
        expect.fail("the unregistered suffix class was excluded beside a registration");
      } catch (error) {
        message = error.message;
      }
      expect(message).to.include("ZCL_H5C_EXTRA_MPC");
      expect(message).to.match(/registered service/);
      expect(said.some((l) => l.includes("service guard: by suffix")), "a registration exists: no by-suffix note").to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 6a: resolveConstantValue names the absent interface -- it is asked, the naming interface is not excluded", async function () {
    this.timeout(300000);
    // the bed's shape (run 15), emitted by the real transpiler at fixture
    // scale (probes/probe-const.mjs): fix round 1 had no branch for the
    // wording, the finding was nameless, nameless counted as answered, and
    // the naming interface was EXCLUDED without the named one ever being
    // asked. Now the name is a code-kind ask and the interface waits.
    const ORG_UNIT = [
      `INTERFACE zif_h5c_org_unit PUBLIC.`,
      `  CONSTANTS gc_h5c TYPE i VALUE zif_h5c_organization=>gc_thing.`,
      `ENDINTERFACE.`,
      ``,
    ].join("\n");
    const ORGANIZATION = [
      `INTERFACE zif_h5c_organization PUBLIC.`,
      `  CONSTANTS gc_thing TYPE i VALUE 1.`,
      `ENDINTERFACE.`,
      ``,
    ].join("\n");
    const root = scratch(ORG_UNIT, "zif_h5c_org_unit", {islandExt: "intf"});
    writeFileSync(join(root, "island", "zif_h5c_organization.intf.abap"), ORGANIZATION);
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zif_h5c_org_unit.intf.abap",
      convBFiles: ["zif_h5c_organization.intf.abap"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      expect(dumperCalls(root), "the named interface was asked").to.have.lengthOf(1);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.CLAS, "the ZIF_ name under the prefix heuristic's CLAS, as every ZIF_ ask").to.deep.equal(["ZIF_H5C_ORGANIZATION"]);
      expect(said.some((l) => /excluded:|cascade:|cycle:/.test(l)), "the naming interface is not excluded").to.equal(false);
      expect(JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")).roots).to.deep.equal([]);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zif_h5c_org_unit.intf.abap"), "utf8"))
        .to.equal(ORG_UNIT);
      expect(JSON.parse(readFileSync(outFile(root, "closure-gaps.json"), "utf8")).gaps).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-4 B1: an interface's INTERFACES include is asked as INTF and arrives -- the fixed point carries it, the summary says so", async function () {
    this.timeout(300000);
    // bed run 21: the fixed point stood with the control build rc=1 on two
    // `Interface X unknown` includes nobody had asked for. Now the include
    // is a code-kind ask, the dump brings it, and the control is green.
    const OUTER = [
      `INTERFACE zif_h5c_inc_outer PUBLIC.`,
      `  INTERFACES zif_h5c_inc_inner.`,
      `  TYPES ty_h5c TYPE i.`,
      `ENDINTERFACE.`,
      ``,
    ].join("\n");
    const INNER = [
      `INTERFACE zif_h5c_inc_inner PUBLIC.`,
      `  TYPES ty_h5c_inner TYPE i.`,
      `ENDINTERFACE.`,
      ``,
    ].join("\n");
    const root = scratch(OUTER, "zif_h5c_inc_outer", {islandExt: "intf"});
    writeFileSync(join(root, "island", "zif_h5c_inc_inner.intf.abap"), INNER);
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zif_h5c_inc_outer.intf.abap", convBFiles: ["zif_h5c_inc_inner.intf.abap"]}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.INTF, "the include is asked under INTF").to.deep.equal(["ZIF_H5C_INC_INNER"]);
      expect(said.some((l) => /unclassified:/.test(l)), "nothing unclassified").to.equal(false);
      expect(said.some((l) => /excluded:/.test(l)), "nothing excluded").to.equal(false);
      expect(existsSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zif_h5c_inc_inner.intf.abap")), "the include is an island object").to.equal(true);
      const summary = JSON.parse(readFileSync(outFile(root, "closure-summary.json"), "utf8"));
      expect(summary).to.include({fixed_point: true, iterations: 2, stubs_unique: 0});
      expect(summary.island_objects, "both interfaces").to.equal(2);
      expect(summary.excluded).to.deep.equal([]);
      expect(summary.failures).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  // the seed service's DPC_EXT at fixture scale: one entity-set read that
  // calls a class the tree does not have (a code-kind miss: stubbed,
  // deferred), and a definition-level table on its companion so the walk
  // takes a second iteration and re-lays the island -- the re-stub bed run
  // 21 recorded once per iteration
  const SVC_DPC_EXT_SOURCE = [
    `CLASS zcl_h5c_svc_dpc_ext DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS items_get_entityset.`,
    `    METHODS items_get_entity.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_svc_dpc_ext IMPLEMENTATION.`,
    `  METHOD items_get_entityset.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD items_get_entity.`,
    `    zcl_h5c_far=>run_it( ).`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const SVC_DPC_SOURCE = [
    `CLASS zcl_h5c_svc_dpc DEFINITION PUBLIC CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gv_h5c TYPE zosd_h5c_def.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_svc_dpc IMPLEMENTATION.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  it("H5x-4 B1: a method re-stubbed in every iteration is recorded once, with its rounds; the summary lists the seed's stubs", async function () {
    this.timeout(300000);
    const root = scratch(SVC_DPC_EXT_SOURCE, "zcl_h5c_svc_dpc_ext", {island2Name: "zcl_h5c_svc_dpc.clas.abap", island2Source: SVC_DPC_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_svc_dpc_ext.clas.abap", island2Name: "zcl_h5c_svc_dpc.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved",
        "--require-unstubbed", "*_GET_ENTITYSET"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration, "the island was re-laid once").to.equal(2);
      const stubs = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")).stubs;
      expect(stubs.map((s) => [s.class, s.method, s.rounds])).to.deep.equal([["ZCL_H5C_SVC_DPC_EXT", "ITEMS_GET_ENTITY", 2]]);
      expect(said.filter((l) => /^iteration /.test(l)).every((l) => / 1 stubbed method\(s\)/.test(l)), "the line counts unique pairs").to.equal(true);
      const summary = JSON.parse(readFileSync(outFile(root, "closure-summary.json"), "utf8"));
      expect(summary).to.include({stubs_unique: 1, iterations: 2});
      expect(summary.seed).to.deep.equal({classes: ["ZCL_H5C_SVC_DPC", "ZCL_H5C_SVC_DPC_EXT"],
        stubbed_methods: [{class: "ZCL_H5C_SVC_DPC_EXT", method: "ITEMS_GET_ENTITY"}]});
      expect(summary.failures).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("M3 B5.1: a stub is lifted when its missing class arrives -- fresh and resumed walks end on the same stub set", async function () {
    this.timeout(600000);
    // the bed's fresh-vs-resumed split in miniature (fresh 111, resumed 37
    // over the same island): iteration 1 stubs CALL_FAR (ZCL_H5C_FAR is
    // absent, a code-kind miss, deferred); MID's superclass ask brings
    // FAR with dump 2, the re-laid island compiles whole, and the stub of
    // iteration 1 must be gone from the record, the line and the summary
    const setUp = () => {
      const root = scratch(CLAS_LIFT_SOURCE, "zcl_h5c_lift",
        {island2Name: "zcl_h5c_mid.clas.abap", island2Source: CLAS_MID_SOURCE});
      fixtureDump(join(root, "dump-001"));
      writeFileSync(join(root, "island", "zcl_h5c_far.clas.abap"), CLAS_FAR_SOURCE);
      const env = writeFakes(root, envFor(root, {island: "zcl_h5c_lift.clas.abap",
        island2Name: "zcl_h5c_mid.clas.abap", convBFiles: ["zcl_h5c_far.clas.abap"]}));
      return {root, env};
    };
    const stubSet = (root) => JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8")).stubs
      .map((s) => `${s.object}|${s.class}|${s.method}`).sort();
    const fresh = setUp();
    const capped = setUp();
    try {
      // fresh: one process, both iterations
      const said = [];
      const result = await run(["--dump", join(fresh.root, "dump-001"), "--system", "h5c", "--stub-unresolved"],
        {root: fresh.root, env: fresh.env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      const lines = said.filter((l) => /^iteration /.test(l));
      expect(lines[0], "iteration 1 stubs the call").to.match(/ 1 stubbed method\(s\), 0 lifted,/);
      expect(lines[1], "iteration 2 lifts it").to.match(/ 0 stubbed method\(s\), 1 lifted,/);
      expect(said).to.include("lifted: ZCL_H5C_LIFT=>CALL_FAR (ZCL_H5C_LIFT) -- its reason no longer holds, the body is back");
      expect(stubSet(fresh.root), "the stub of iteration 1 is gone").to.deep.equal([]);
      expect(readFileSync(join(fresh.root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_lift.clas.abap"), "utf8"),
        "the pristine body is back").to.equal(CLAS_LIFT_SOURCE);
      const summary = JSON.parse(readFileSync(outFile(fresh.root, "closure-summary.json"), "utf8"));
      expect(summary).to.include({stubs_unique: 0, lifted: 1, iterations: 2});
      expect(summary.lifted_stubs).to.deep.equal([{class: "ZCL_H5C_LIFT", method: "CALL_FAR"}]);

      // resumed: the cap stops after iteration 1 with the stub on disk, the
      // next process picks the pending round up and lifts it the same way
      const first = await run(["--dump", join(capped.root, "dump-001"), "--system", "h5c", "--stub-unresolved",
        "--max-iterations", "0"], {root: capped.root, env: capped.env, say: () => {}});
      expect(first.stopped).to.equal("cap");
      expect(stubSet(capped.root), "iteration 1 recorded the stub").to.deep.equal(["ZCL_H5C_LIFT|ZCL_H5C_LIFT|CALL_FAR"]);
      const resumed = await run(["--system", "h5c", "--stub-unresolved"], {root: capped.root, env: capped.env, say: () => {}});
      expect(resumed.stopped).to.equal("fixed-point");
      expect(stubSet(capped.root), "fresh and resumed agree").to.deep.equal(stubSet(fresh.root));
      const resumedSummary = JSON.parse(readFileSync(outFile(capped.root, "closure-summary.json"), "utf8"));
      expect(resumedSummary).to.include({stubs_unique: 0, lifted: 1});

      // and a run resumed over the finished walk changes nothing
      await run(["--system", "h5c", "--stub-unresolved"], {root: fresh.root, env: fresh.env, say: () => {}});
      expect(stubSet(fresh.root)).to.deep.equal(stubSet(capped.root));
    } finally {
      rmSync(fresh.root, {recursive: true, force: true});
      rmSync(capped.root, {recursive: true, force: true});
    }
  });

  it("H5x-4 B1: --require-unstubbed fails the fixed point on a stubbed seed method, after writing the summary", async function () {
    this.timeout(300000);
    const root = scratch(SVC_DPC_EXT_SOURCE, "zcl_h5c_svc_dpc_ext", {island2Name: "zcl_h5c_svc_dpc.clas.abap", island2Source: SVC_DPC_SOURCE});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_svc_dpc_ext.clas.abap", island2Name: "zcl_h5c_svc_dpc.clas.abap"}));
    try {
      let error;
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved",
          "--require-unstubbed", "*_GET_ENTITYSET", "--require-unstubbed", "*_get_entity"], {root, env, say: () => {}});
      } catch (e) {
        error = e;
      }
      expect(error, "the run fails").to.not.equal(undefined);
      expect(String(error.message)).to.include("--require-unstubbed *_get_entity").and.include("ZCL_H5C_SVC_DPC_EXT=>ITEMS_GET_ENTITY");
      expect(String(error.message), "the glob that holds is not a failure").to.not.include("*_GET_ENTITYSET:");
      const summary = JSON.parse(readFileSync(outFile(root, "closure-summary.json"), "utf8"));
      expect(summary.failures).to.have.lengthOf(1);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-4 B1: a registered seed class missing from the island fails the fixed point", async function () {
    this.timeout(300000);
    // the registration names an MPC_EXT the dumps never brought; the
    // DPC_EXT alone is there -- its derived DPC base, named by nobody, is
    // not required (an _EXT's own superclass ask covers a real one)
    const root = scratch(SVC_DPC_EXT_SOURCE, "zcl_h5c_svc_dpc_ext");
    mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
    writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
      {service: "h5c", version: "0001", dpc: "ZCL_H5C_SVC_DPC_EXT", mpc: "ZCL_H5C_SVC_MPC_EXT"},
    ]}) + "\n");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_svc_dpc_ext.clas.abap"}));
    try {
      let error;
      try {
        await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: () => {}});
      } catch (e) {
        error = e;
      }
      expect(error, "the run fails").to.not.equal(undefined);
      expect(String(error.message)).to.include("seed class ZCL_H5C_SVC_MPC_EXT is not an island object");
      const summary = JSON.parse(readFileSync(outFile(root, "closure-summary.json"), "utf8"));
      expect(summary.failures).to.deep.equal(["seed class ZCL_H5C_SVC_MPC_EXT is not an island object"]);
      expect(summary.seed.classes).to.deep.equal(["ZCL_H5C_SVC_DPC", "ZCL_H5C_SVC_DPC_EXT", "ZCL_H5C_SVC_MPC", "ZCL_H5C_SVC_MPC_EXT"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("fix2 item 7: the seed classes' nameless stubs lead framework-gaps.json, flagged seed", async function () {
    this.timeout(300000);
    const NAMELESS = (name, member) => [
      `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS get_rows.`,
      `ENDCLASS.`,
      `CLASS ${name} IMPLEMENTATION.`,
      `  METHOD get_rows.`,
      `    me->${member}( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const root = scratch(NAMELESS("zcl_h5c_gaps", "get_h5c_plain"), "zcl_h5c_gaps",
      {island2Name: "zcl_h5c_svc_dpc_ext.clas.abap", island2Source: NAMELESS("zcl_h5c_svc_dpc_ext", "get_h5c_seed")});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_gaps.clas.abap",
      island2Name: "zcl_h5c_svc_dpc_ext.clas.abap"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(1);
      const gaps = JSON.parse(readFileSync(outFile(root, "framework-gaps.json"), "utf8"));
      expect(gaps.map((e) => [e.seed === true, e.finding]), "the seed class's entries first, flagged").to.deep.equal([
        [true, `Method "get_h5c_seed" not found`],
        [false, `Method "get_h5c_plain" not found`],
      ]);
      expect(gaps[0].used_by[0].file).to.equal("zcl_h5c_svc_dpc_ext.clas.abap");
      expect(said.some((l) => l.includes("iteration 1:") && l.includes("framework gaps: 2"))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
  // ------------------------------------------------------- H5x-2 ----

  // the bed-15 shape's fixtures: a root (its definition references a type
  // the dictionary answered missing) two layers below a cycle and the seed
  const H5X2_ROOT = [
    `CLASS zcl_h5c_test_base DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gv_h5c TYPE zosd_h5c_dead.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_test_base IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_MID = [
    `CLASS zcl_h5c_test_mid DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA mo_h5c TYPE REF TO zcl_h5c_test_base.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_test_mid IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  // the dependent that references the root only from a BODY: stubbed, never
  // excluded
  const H5X2_BODY_DEP = [
    `CLASS zcl_h5c_test_body DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_test_body IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    DATA lo_h5c TYPE REF TO zcl_h5c_test_base.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_CYC = (name, sup) => [
    `CLASS ${name} DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM ${sup}.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS ${name} IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_SEED = [
    `CLASS zcl_h5c_svc_dpc_ext DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA mo_h5c TYPE REF TO zcl_h5c_cyc_a.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_svc_dpc_ext IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_FRIEND = [
    `CLASS zcl_h5c_friending DEFINITION PUBLIC FINAL CREATE PUBLIC GLOBAL FRIENDS zcl_h5c_gonefriend.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_friending IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_GONE_FRIEND = H5X2_ROOT;
  const H5X2_SIG = [
    `CLASS zcl_h5c_sig DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    METHODS run_it.`,
    `    METHODS with_sig IMPORTING iv_h5g TYPE zosd_h5c_sig DEFAULT 1 OPTIONAL.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_sig IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `  METHOD with_sig.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_HELD = [
    `CLASS zcl_h5c_held DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gv_h5c TYPE zosd_h5c_dead.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_held IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    SELECT SINGLE * FROM zosd_h5c_head INTO @DATA(ls_h5c_head) ##SUBRC_OK.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");
  const H5X2_BLOCK = [
    `CLASS zcl_h5c_block DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
    `  PUBLIC SECTION.`,
    `    DATA gw_h5c TYPE zosd_h5c_block.`,
    `    METHODS run_it.`,
    `ENDCLASS.`,
    `CLASS zcl_h5c_block IMPLEMENTATION.`,
    `  METHOD run_it.`,
    `    RETURN.`,
    `  ENDMETHOD.`,
    `ENDCLASS.`,
    ``,
  ].join("\n");

  it("H5x-2: a bed-15-shaped island -- only the root side excluded, the cycle and the seed kept", async function () {
    this.timeout(300000);
    // the graph decision's scenario: the root and its definition-level
    // dependent fall, a cycle of present objects stays whole, the seed
    // stays, and a dependent that references the root only from a body is
    // stubbed, not excluded
    const root = scratch(H5X2_ROOT, "zcl_h5c_test_base",
      {island2Name: "zcl_h5c_svc_dpc_ext.clas.abap", island2Source: H5X2_SEED});
    for (const [name, src] of [
      ["zcl_h5c_cyc_a.clas.abap", H5X2_CYC("zcl_h5c_cyc_a", "zcl_h5c_cyc_b")],
      ["zcl_h5c_cyc_b.clas.abap", H5X2_CYC("zcl_h5c_cyc_b", "zcl_h5c_cyc_c")],
      ["zcl_h5c_cyc_c.clas.abap", H5X2_CYC("zcl_h5c_cyc_c", "zcl_h5c_cyc_a")],
      ["zcl_h5c_test_mid.clas.abap", H5X2_MID],
      ["zcl_h5c_test_body.clas.abap", H5X2_BODY_DEP],
    ]) writeFileSync(join(root, "island", name), src);
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_test_base.clas.abap",
      island2Name: "zcl_h5c_svc_dpc_ext.clas.abap",
      convAFiles: ["zcl_h5c_cyc_a.clas.abap", "zcl_h5c_cyc_b.clas.abap", "zcl_h5c_cyc_c.clas.abap",
        "zcl_h5c_test_mid.clas.abap", "zcl_h5c_test_body.clas.abap"],
      missingNames: "ZOSD_H5C_DEAD"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(2);
      expect(dumperCalls(root), "one round: the root's missing type was asked").to.have.lengthOf(1);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots.map((e) => e.object), "the root is the only root").to.deep.equal(["ZCL_H5C_TEST_BASE"]);
      expect(record.roots[0].missing).to.deep.equal(["ZOSD_H5C_DEAD"]);
      expect(record.cascades.filter((e) => e.excluded === true).map((e) => e.object), "the definition-level dependent falls with it").to.deep.equal(["ZCL_H5C_TEST_MID"]);
      expect(record.cycles.map((c) => c.members), "the cycle stays whole").to.deep.equal(
        [["ZCL_H5C_CYC_A", "ZCL_H5C_CYC_B", "ZCL_H5C_CYC_C"]]);
      expect(record.excluded.CLAS.sort(), "the seed is never excluded").to.deep.equal(["ZCL_H5C_TEST_BASE", "ZCL_H5C_TEST_MID"]);
      // the body-level dependent: kept, and stubbed once its reference broke
      expect(record.stubs.some((s) => s.object === "ZCL_H5C_TEST_BODY" && s.method === "RUN_IT"),
        "the body-level dependent is stubbed, not excluded").to.equal(true);
      const bodyFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_test_body.clas.abap"), "utf8");
      expect(bodyFile).to.include("RAISE EXCEPTION TYPE zcx_osd_not_activated");
      // the excluded files stand on disk, never rewritten
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_test_base.clas.abap"), "utf8")).to.equal(H5X2_ROOT);
      expect(readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_test_mid.clas.abap"), "utf8")).to.equal(H5X2_MID);
      expect(said.some((l) => l.startsWith("cycle: ZCL_H5C_CYC_A") && l.includes("kept in the build"))).to.equal(true);
      expect(said.some((l) => l.includes("iteration 2:") && l.includes("2 excluded"))).to.equal(true);
      // the waits are empty at the fixed point: nothing pending any more
      expect(record.waits).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-2: a blocked decision's waits are the request's asks -- the round trip", async function () {
    this.timeout(300000);
    // no dumper: the run stops with the pending request, and the record's
    // waits carry the still-pending definition names -- the same names the
    // request asks for (report MUST 4: requested == waits.names)
    const root = scratch(H5X2_ROOT, "zcl_h5c_test_base");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_test_base.clas.abap", dumper: false}));
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env});
      expect(result.stopped).to.equal("no-dumper");
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots, "a blocked decision excludes nothing").to.deep.equal([]);
      expect(record.waits, "the pending definition names, per object").to.deep.equal(
        [{object: "ZCL_H5C_TEST_BASE", names: ["ZOSD_H5C_DEAD"]}]);
      const request = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request.requested.TABL, "the waits' names are the request's asks").to.deep.equal(["ZOSD_H5C_DEAD"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-2 (S-2.2): at a blocked decision the held files' methods still stub", async function () {
    this.timeout(300000);
    // zcl_h5c_held: its definition type is ANSWERED missing (settled --
    // held for the decision) and its method misses a table the dictionary
    // also lacks (stubbable). zcl_h5c_block arrives with the second dump
    // referencing a name that is still unasked: the gate blocks in
    // iteration 2's rounds, and the hold releases -- the held file's
    // method stubs apply instead of the file staying red to the cap
    const root = scratch(H5X2_HELD, "zcl_h5c_held");
    writeFileSync(join(root, "island", "zcl_h5c_block.clas.abap"), H5X2_BLOCK);
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_held.clas.abap",
      convBFiles: ["zcl_h5c_block.clas.abap"],
      missingNames: "ZOSD_H5C_DEAD,ZOSD_H5C_HEAD,ZOSD_H5C_BLOCK"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(result.iteration).to.equal(3);
      expect(dumperCalls(root)).to.have.lengthOf(2);
      // the held file's method was stubbed WHILE the decision was blocked
      console.log("DEBUG-S22 said:", JSON.stringify(said.filter((l) => /stub|excluded|decision|gate/.test(l)), null, 1));
      expect(said.some((l) => l.includes("stub round 1: ZCL_H5C_HELD: 1 method(s) stubbed")),
        "the hold released at the blocked decision").to.equal(true);
      // the stub landed in iteration 2; iteration 3's merge lays the layer
      // sources again (the wipe-and-restub cycle every iteration runs) and
      // the file is then EXCLUDED -- its plans are moot, and since M3 B5.1
      // the record is the current iteration's: an excluded object has no
      // stub in it, and its iteration-2 stub is gone, not lifted
      const heldFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_held.clas.abap"), "utf8");
      expect(heldFile, "the excluded file stands as its layer wrote it").to.equal(H5X2_HELD);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots.map((e) => e.object).sort(), "both roots excluded once the dumper answered").to.deep.equal(
        ["ZCL_H5C_BLOCK", "ZCL_H5C_HELD"]);
      expect(record.stubs.some((s) => s.object === "ZCL_H5C_HELD"), "an excluded object carries no stub").to.equal(false);
      expect(said.some((l) => l.startsWith("lifted: ")), "an exclusion is not a lift").to.equal(false);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-2: a GLOBAL FRIENDS clause naming an excluded object is stripped, the class stays", async function () {
    this.timeout(300000);
    const root = scratch(H5X2_GONE_FRIEND, "zcl_h5c_gonefriend",
      {island2Name: "zcl_h5c_friending.clas.abap", island2Source: H5X2_FRIEND});
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_gonefriend.clas.abap",
      island2Name: "zcl_h5c_friending.clas.abap", missingNames: "ZOSD_H5C_DEAD"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots.map((e) => e.object)).to.deep.equal(["ZCL_H5C_GONEFRIEND"]);
      const strip = record.cascades.find((e) => e.object === "ZCL_H5C_FRIENDING");
      expect(strip, "the FRIENDS strip is a record, not an exclusion").to.be.an("object");
      expect(strip.edge).to.equal("friends");
      expect(strip.action).to.equal("strip-friends");
      expect(strip.excluded).to.equal(false);
      expect(strip.of).to.deep.equal(["ZCL_H5C_GONEFRIEND"]);
      expect(record.excluded.CLAS).to.deep.equal(["ZCL_H5C_GONEFRIEND"]);
      // the clause left the source; the class stays in the build
      const friendFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_friending.clas.abap"), "utf8");
      expect(friendFile, "the GLOBAL FRIENDS clause is gone").to.not.include("GLOBAL FRIENDS");
      expect(friendFile).to.include("METHODS run_it.");
      expect(said.some((l) => l.startsWith("friends: ZCL_H5C_FRIENDING strips GLOBAL FRIENDS ZCL_H5C_GONEFRIEND"))).to.equal(true);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("H5x-2: a signature-level miss is a parameter cut with the body stubbed once the name is answered", async function () {
    this.timeout(300000);
    // the method_definition scope's unknown (a parameter typed by a
    // missing name): while the dumper can still answer, the signature
    // stays whole and the name goes out eager; once it is answered
    // missing, the parameter is cut and the body stubbed -- the method
    // compiles without the name, the way a body stub does for a body
    const root = scratch(H5X2_SIG, "zcl_h5c_sig");
    fixtureDump(join(root, "dump-001"));
    const env = writeFakes(root, envFor(root, {island: "zcl_h5c_sig.clas.abap", missingNames: "ZOSD_H5C_SIG"}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(dumperCalls(root), "the signature's name was asked, not cut").to.have.lengthOf(1);
      const request1 = JSON.parse(readFileSync(outFile(root, "closure-request.json"), "utf8"));
      expect(request1.requested.TABL, "the signature's DDIC name is in the first request").to.include("ZOSD_H5C_SIG");
      const sigFile = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_sig.clas.abap"), "utf8");
      expect(sigFile, "the parameter (DEFAULT and OPTIONAL with it) is cut").to.include(`    METHODS with_sig.`);
      expect(sigFile).to.not.include("zosd_h5c_sig");
      expect(sigFile).to.include(`RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_SIG'.`);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots, "a signature miss is stub material, never exclusion material").to.deep.equal([]);
      const stub = record.stubs.find((s) => s.method === "WITH_SIG");
      expect(stub, "the signature stub is recorded").to.be.an("object");
      expect(stub.signature).to.equal(true);
      expect(stub.missing).to.deep.equal(["ZOSD_H5C_SIG"]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("testCodeObjects: a class whose OWN definition is test code is a root, nothing else is (H5x-3 fix 1)", async () => {
    const {testCodeObjects} = await import("../tools/hana-closure-graph.mjs");
    // the roots: the framework's own names, FOR TESTING in the class's own
    // header, inheriting from a framework class, implementing a framework
    // interface. NOT roots, though the first round made every one of them
    // test code through its transitive naming closure: a GLOBAL FRIENDS
    // clause to a decorator (the bed's EPM test utilities), an unknown
    // naming the framework, and the bed-19 shape itself -- the service's
    // own DPC, whose generated header COMMENTS name its own _EXT subclass,
    // which the closure had dragged in through the EPM layer. The seed
    // guard killed bed run 19 on that DPC (FIX-1).
    const objects = [
      {object: "IF_AUNIT_H5C_TEST", unknowns: [], edges: [], friends: [], file: "x/if_aunit_h5c_test.intf.abap"},
      {object: "ZCL_H5C_AUNIT_DECORATOR", unknowns: [], edges: [{to: "IF_AUNIT_H5C_TEST", level: "definition"}], friends: [], file: "x/zcl_h5c_aunit_decorator.clas.abap"},
      {object: "ZCL_H5C_AUNIT_SUB", unknowns: [], edges: [], friends: [], file: "x/zcl_h5c_aunit_sub.clas.abap"},
      {object: "ZCL_H5C_FOR_TEST", unknowns: [], edges: [], friends: [], file: "x/zcl_h5c_for_test.clas.abap"},
      {object: "ZCL_H5C_AUNIT_UTIL", unknowns: [], edges: [], friends: [], file: "x/zcl_h5c_aunit_util.clas.abap"},
      {object: "ZCL_H5C_AUNIT_NAMER", unknowns: [{name: "CL_AUNIT_H5C_ASSERT", kind: "clas", level: "method"}], edges: [], friends: [], file: "x/zcl_h5c_aunit_namer.clas.abap"},
      {object: "/H5C/CL_H5C_SVC_DPC", unknowns: [], edges: [], friends: [], file: "x/#h5c#cl_h5c_svc_dpc.clas.abap"},
      {object: "ZCL_H5C_KEEP", unknowns: [{name: "ZOSD_H5C_HEAD", kind: "tabl", level: "method"}], edges: [], friends: [], file: "x/zcl_h5c_keep.clas.abap"},
      // fix round 2 (S-1): production classes that only SAY the words -- in a
      // comment, a trailing comment and string literals -- are not test
      // code; the classifier reads abaplint statements, not the raw text
      {object: "ZCL_H5C_SAYS_IN_COMMENT", unknowns: [], edges: [], friends: [], file: "x/zcl_h5c_says_in_comment.clas.abap"},
      {object: "ZCL_H5C_SAYS_IN_STRING", unknowns: [], edges: [], friends: [], file: "x/zcl_h5c_says_in_string.clas.abap"},
    ];
    const sources = {
      IF_AUNIT_H5C_TEST: "INTERFACE if_aunit_h5c_test PUBLIC. ENDINTERFACE.",
      ZCL_H5C_AUNIT_DECORATOR: "CLASS zcl_h5c_aunit_decorator DEFINITION PUBLIC. INTERFACES if_aunit_h5c_test. ENDCLASS.",
      ZCL_H5C_AUNIT_SUB: "CLASS zcl_h5c_aunit_sub DEFINITION PUBLIC INHERITING FROM cl_aunit_h5c_assert. ENDCLASS.",
      ZCL_H5C_FOR_TEST: "CLASS zcl_h5c_for_test DEFINITION PUBLIC FINAL FOR TESTING. ENDCLASS.",
      ZCL_H5C_AUNIT_UTIL: "CLASS zcl_h5c_aunit_util DEFINITION PUBLIC. GLOBAL FRIENDS zcl_h5c_aunit_decorator. ENDCLASS.",
      ZCL_H5C_AUNIT_NAMER: "CLASS zcl_h5c_aunit_namer DEFINITION PUBLIC. ENDCLASS.",
      "/H5C/CL_H5C_SVC_DPC": [
        "CLASS /h5c/cl_h5c_svc_dpc definition public abstract create public.",
        "* GENERATED METHODS INSIDE THE DPC PROVIDER SUBCLASS - /H5C/CL_H5C_SVC_DPC_EXT",
        "ENDCLASS.",
      ].join("\n"),
      ZCL_H5C_KEEP: "CLASS zcl_h5c_keep DEFINITION PUBLIC. ENDCLASS.",
      ZCL_H5C_SAYS_IN_COMMENT: [
        "CLASS zcl_h5c_says_in_comment DEFINITION PUBLIC.",
        "* we used to say INTERFACES if_aunit_h5c_test here, and FOR TESTING",
        "  PUBLIC SECTION. \" INTERFACES if_aunit_h5c_test",
        "ENDCLASS.",
        "CLASS zcl_h5c_says_in_comment IMPLEMENTATION.",
        "ENDCLASS.",
      ].join("\n"),
      ZCL_H5C_SAYS_IN_STRING: [
        "CLASS zcl_h5c_says_in_string DEFINITION PUBLIC.",
        "  PUBLIC SECTION.",
        "    METHODS run_it.",
        "ENDCLASS.",
        "CLASS zcl_h5c_says_in_string IMPLEMENTATION.",
        "  METHOD run_it.",
        "    DATA lv_text TYPE string.",
        "    lv_text = `INTERFACES IF_AUNIT_H5C_TEST`.",
        "    lv_text = 'INTERFACES if_aunit_h5c_test.'.",
        "    lv_text = |CLASS zcl_h5c_says_in_string DEFINITION FOR TESTING.|.",
        "  ENDMETHOD.",
        "ENDCLASS.",
      ].join("\n"),
    };
    const {roots, all} = testCodeObjects(objects, (o) => sources[o.object]);
    expect([...roots].sort()).to.deep.equal([
      "IF_AUNIT_H5C_TEST", "ZCL_H5C_AUNIT_DECORATOR", "ZCL_H5C_AUNIT_SUB", "ZCL_H5C_FOR_TEST"]);
    expect([...all].sort()).to.deep.equal([
      "IF_AUNIT_H5C_TEST", "ZCL_H5C_AUNIT_DECORATOR", "ZCL_H5C_AUNIT_SUB", "ZCL_H5C_FOR_TEST"]);
    // there is no transitive step to skip: all IS the roots, the same names
    expect([...all].sort()).to.deep.equal([...roots].sort());
    // without sources only the framework's own names root -- the
    // own-definition shapes are not decidable without the file
    const thin = testCodeObjects(objects);
    expect([...thin.all].sort()).to.deep.equal(["IF_AUNIT_H5C_TEST"]);
  });

  it("graphDecide: a dependent of a test-code seed is a cascade, a FRIENDS clause strips, the seed guard holds (H5x-3 fix 1)", async () => {
    const {graphDecide} = await import("../tools/hana-closure-graph.mjs");
    // the island's test-code roots are excluded OUTSIDE this decision; here
    // they arrive as seeds. They are graph nodes: a dependent whose
    // definition references one falls as a CASCADE of it (#934's rule --
    // never as test code), a FRIENDS clause naming one strips (soft), and
    // a seed that is a guarded service class throws. An object that only
    // names a seed in a method body is not in the graph at all and stays.
    const objects = [
      {object: "ZCL_H5C_SVC_DPC", defNames: [], edges: [], friends: [], nameless: [], findings: []},
      {object: "ZCL_H5C_TEST_DEP", defNames: [], edges: ["IF_AUNIT_H5C_TEST"], friends: [], nameless: [], findings: []},
      // the parsed-clause shape: the FRIENDS clause reaches the record as a
      // resolved definition-level edge as well -- the edge must be soft
      {object: "ZCL_H5C_FRIENDING", defNames: [], edges: ["ZCL_H5C_AUNIT_BASE"], friends: ["ZCL_H5C_AUNIT_BASE"], nameless: [], findings: []},
    ];
    const d = graphDecide({objects, pendingOf: () => false, statusOf: () => "present",
      guard: new Set(["ZCL_H5C_SVC_DPC"]), guardMode: "registration",
      seeds: new Set(["IF_AUNIT_H5C_TEST", "ZCL_H5C_AUNIT_BASE"])});
    expect(d.blocked).to.equal(false);
    expect(d.cascades).to.deep.equal([{object: "ZCL_H5C_TEST_DEP", of: ["IF_AUNIT_H5C_TEST"]}]);
    expect(d.strips).to.deep.equal([{object: "ZCL_H5C_FRIENDING", of: ["ZCL_H5C_AUNIT_BASE"]}]);
    expect([...d.excluded].sort()).to.deep.equal(["IF_AUNIT_H5C_TEST", "ZCL_H5C_AUNIT_BASE", "ZCL_H5C_TEST_DEP"]);
    expect(d.roots).to.deep.equal([]);
    // the seed itself must never be a guarded service class
    let thrown;
    try {
      graphDecide({objects, pendingOf: () => false, statusOf: () => "present",
        guard: new Set(["ZCL_H5C_SVC_DPC"]), guardMode: "registration",
        seeds: new Set(["ZCL_H5C_SVC_DPC"])});
      expect.fail("the seed service class was excluded");
    } catch (error) { thrown = error; }
    expect(thrown.guard).to.equal(true);
    expect(thrown.message).to.include("ZCL_H5C_SVC_DPC");
  });

  it("test code for the island rule: the unit-test framework surface is neither built nor counted (H5x-3)", async function () {
    this.timeout(300000);
    // the bed-19 shape at fixture scale: the aunit kernel interface, a
    // decorator implementing it (own definition test code), a helper whose
    // GLOBAL FRIENDS names the decorator (a strip, not test code), the
    // decorator's definition-level dependent (a #934 cascade of it), a
    // body-level user of the helper (stays, resolves), the registered
    // service's own DPC whose generated comment names its own _EXT (the
    // shape that killed bed run 19's run through the first round's
    // transitive closure; the seed guard must never fire), and a kept
    // class whose deferred code name is answered by nobody. The roots
    // leave the build before any decision would be needed: not stubbed,
    // not asked, not a framework gap; the dependents fall through the
    // graph decision's seeds.
    const INTF_AUNIT_SOURCE = [
      `INTERFACE if_aunit_h5c_test PUBLIC.`,
      `  METHODS get_test_methods RETURNING VALUE(rt_h5c) TYPE string_table.`,
      `ENDINTERFACE.`,
      ``,
    ].join("\n");
    const DECORATOR_SOURCE = [
      `CLASS zcl_h5c_aunit_decorator DEFINITION PUBLIC CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    INTERFACES if_aunit_h5c_test.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_aunit_decorator IMPLEMENTATION.`,
      `  METHOD if_aunit_h5c_test~get_test_methods.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `  METHOD run_it.`,
      `    me->if_aunit_h5c_test~get_absolute_class_name( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const UTIL_SOURCE = [
      `CLASS zcl_h5c_aunit_util DEFINITION PUBLIC CREATE PUBLIC FRIENDS zcl_h5c_aunit_decorator.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_aunit_util IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const USER_SOURCE = [
      `CLASS zcl_h5c_aunit_user DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5c_aunit_util.`,
      `  PUBLIC SECTION.`,
      `    METHODS user_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_aunit_user IMPLEMENTATION.`,
      `  METHOD user_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const BODY_SOURCE = [
      `CLASS zcl_h5c_aunit_body DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_aunit_body IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    DATA lo_h5c TYPE REF TO zcl_h5c_aunit_util.`,
      `    CREATE OBJECT lo_h5c.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const KEEP_SOURCE = [
      `CLASS zcl_h5c_keep DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS one.`,
      `    METHODS two.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_keep IMPLEMENTATION.`,
      `  METHOD one.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `  METHOD two.`,
      `    zcl_h5c_far=>run_it( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    // the dependent of the excluded decorator: a subclass cannot compile
    // without its superclass, so once the decorator leaves it falls as a
    // cascade of it (#934's rule) -- never as test code, though its own
    // definition is not test code in any shape
    const DEP_SOURCE = [
      `CLASS zcl_h5c_test_dep DEFINITION PUBLIC FINAL CREATE PUBLIC INHERITING FROM zcl_h5c_aunit_decorator.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_test_dep IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    RETURN.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    // the bed-19 shape at fixture scale: the registered service's own DPC
    // whose generated header comment names its own _EXT subclass, and the
    // _EXT itself, which uses the helper chain at METHOD level (the real
    // DPC_EXT's five stubbed methods). Under the first round's transitive
    // rule both were dragged into the test surface through the helper
    // chain and the seed guard killed the run; now the guard never fires
    // and the DPC is business as usual -- stubbed like any island class.
    const SVC_SOURCE = [
      `CLASS zcl_h5c_svc_dpc DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_svc_dpc IMPLEMENTATION.`,
      `* GENERATED METHODS INSIDE THE DPC PROVIDER SUBCLASS - ZCL_H5C_SVC_DPC_EXT`,
      `  METHOD run_it.`,
      `    zcl_h5c_nowhere=>run_it( ).`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const SVC_EXT_SOURCE = [
      `CLASS zcl_h5c_svc_dpc_ext DEFINITION PUBLIC FINAL CREATE PUBLIC.`,
      `  PUBLIC SECTION.`,
      `    METHODS run_it.`,
      `ENDCLASS.`,
      `CLASS zcl_h5c_svc_dpc_ext IMPLEMENTATION.`,
      `  METHOD run_it.`,
      `    DATA lo_h5c TYPE REF TO zcl_h5c_aunit_util.`,
      `    CREATE OBJECT lo_h5c.`,
      `  ENDMETHOD.`,
      `ENDCLASS.`,
      ``,
    ].join("\n");
    const extra = [
      ["zcl_h5c_aunit_util.clas.abap", UTIL_SOURCE],
      ["zcl_h5c_aunit_user.clas.abap", USER_SOURCE],
      ["zcl_h5c_aunit_body.clas.abap", BODY_SOURCE],
      ["zcl_h5c_test_dep.clas.abap", DEP_SOURCE],
      ["zcl_h5c_svc_dpc.clas.abap", SVC_SOURCE],
      ["zcl_h5c_svc_dpc_ext.clas.abap", SVC_EXT_SOURCE],
      // the registration's MPC: a registered seed class must be an island
      // object, or the fixed point fails (H5x-4 B1's summary guard)
      ["zcl_h5c_svc_mpc.clas.abap", [
        `CLASS zcl_h5c_svc_mpc DEFINITION PUBLIC CREATE PUBLIC.`,
        `ENDCLASS.`,
        `CLASS zcl_h5c_svc_mpc IMPLEMENTATION.`,
        `ENDCLASS.`,
        ``,
      ].join("\n")],
      ["zcl_h5c_keep.clas.abap", KEEP_SOURCE],
    ];
    const root = scratch(INTF_AUNIT_SOURCE, "if_aunit_h5c_test", {islandExt: "intf",
      island2Name: "zcl_h5c_aunit_decorator.clas.abap", island2Source: DECORATOR_SOURCE});
    for (const [name, source] of extra) writeFileSync(join(root, "island", name), source);
    fixtureDump(join(root, "dump-001"));
    // the registration that makes ZCL_H5C_SVC_DPC (and its derived _EXT)
    // the seeded guard's classes
    mkdirSync(join(root, "gen", "hana-segw"), {recursive: true});
    writeFileSync(join(root, "gen", "hana-segw", "from-dump.json"), JSON.stringify({services: [
      {service: "h5c", version: "0001", dpc: "ZCL_H5C_SVC_DPC", mpc: "ZCL_H5C_SVC_MPC"},
    ]}) + "\n");
    const env = writeFakes(root, envFor(root, {island: "if_aunit_h5c_test.intf.abap",
      island2Name: "zcl_h5c_aunit_decorator.clas.abap",
      convAFiles: extra.map(([name]) => name)}));
    const said = [];
    try {
      const result = await run(["--dump", join(root, "dump-001"), "--system", "h5c", "--stub-unresolved"], {root, env, say: (m) => said.push(m)});
      expect(result.stopped).to.equal("fixed-point");
      expect(said.some((l) => l.includes("test code: 2 island object(s) out of the build")),
        "only the own-definition test code is named on the log").to.equal(true);
      expect(said.some((l) => l.includes("registered service's own class")),
        "the seed guard never fires for the service's own DPC").to.equal(false);
      expect(existsSync(join(root, "dumper-log.jsonl")), "the surface asks nothing").to.equal(false);
      const record = JSON.parse(readFileSync(outFile(root, "closure-stubs.json"), "utf8"));
      expect(record.roots.filter((r) => r.testCode === true).map((r) => r.object).sort()).to.deep.equal(
        ["IF_AUNIT_H5C_TEST", "ZCL_H5C_AUNIT_DECORATOR"]);
      expect(record.cascades.filter((r) => r.testCode === true), "no dependent is test code any more").to.deep.equal([]);
      // the decorator's dependent falls as a #934 cascade of it (a
      // subclass cannot compile without its superclass); the helper's
      // FRIENDS clause to the excluded decorator strips and the helper
      // stays in the build
      const depCascade = record.cascades.find((r) => r.object === "ZCL_H5C_TEST_DEP");
      expect(depCascade?.excluded, "the decorator's dependent is excluded").to.equal(true);
      expect(depCascade?.of).to.deep.equal(["ZCL_H5C_AUNIT_DECORATOR"]);
      expect(depCascade?.testCode, "the cascade is not test code").to.equal(undefined);
      const strip = record.cascades.find((r) => r.edge === "friends");
      expect(strip?.object).to.equal("ZCL_H5C_AUNIT_UTIL");
      expect(strip?.excluded).to.equal(false);
      const seam = await import("../tools/hana-closure-exclusions.mjs");
      expect(seam.excludedFiles(root), "the build is kept from the roots and the dependent").to.have.lengthOf(3);
      const gaps = JSON.parse(readFileSync(outFile(root, "framework-gaps.json"), "utf8"));
      expect(gaps, "the surface's findings are no framework gaps").to.deep.equal([]);
      const decorator = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_aunit_decorator.clas.abap"), "utf8");
      expect(decorator, "test code is not stubbed -- it leaves whole").to.not.include("RAISE EXCEPTION");
      expect(decorator).to.include("get_absolute_class_name");
      const util = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_aunit_util.clas.abap"), "utf8");
      expect(util, "the helper stays and loses only its FRIENDS clause").to.not.include("FRIENDS zcl_h5c_aunit_decorator");
      expect(util).to.include("METHOD run_it");
      const svc = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_svc_dpc.clas.abap"), "utf8");
      expect(svc, "the service's own DPC keeps its generated comment").to.include("GENERATED METHODS INSIDE THE DPC PROVIDER SUBCLASS");
      expect(svc, "the service's own DPC is stubbed like any island class").to.include("RAISE EXCEPTION TYPE zcx_osd_not_activated");
      // the kept class is business as usual: its method stubbed, its
      // deferred name pending forever, the fixed point honest
      const keep = readFileSync(join(root, "gen", "hana-src", "000-h5c-main", "src", "zcl_h5c_keep.clas.abap"), "utf8");
      expect(keep).to.include("RAISE EXCEPTION TYPE zcx_osd_not_activated");
      // and the real build over the loop's own tree is green with the
      // surface excluded (the positive control, at fixture scale)
      rmSync(join(root, "src", "zcl_h5c_own.clas.abap"), {force: true});
      const envNames = ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_IMAGE_PACKS"];
      const savedEnv = Object.fromEntries(envNames.map((n) => [n, process.env[n]]));
      for (const n of envNames) delete process.env[n];
      try {
        const {build} = await import("../tools/osd-build.mjs");
        const built = await build({root, generators: false, switch: false, log: () => {}});
        expect(built.ok, "the transpile is green with the test-code surface excluded").to.equal(true);
      } finally {
        for (const n of envNames) {
          if (savedEnv[n] === undefined) delete process.env[n];
          else process.env[n] = savedEnv[n];
        }
      }
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });
});

