import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, unlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join, resolve} from "node:path";
import * as core from "@abaplint/core";
import {generate, walk, main} from "../tools/rap/bdef-gen.mjs";
import {lowerDerived} from "../tools/rap/lower-derived.mjs";
import {keepCompileInputs, readCompileInputs} from "../tools/osd-compile-snapshot.mjs";
import {keepGeneratedSources} from "../tools/osd-source-snapshot.mjs";
import {loadFiles, modulesOf} from "../tools/osd-transpile.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";

// The pin lowers EML, so abap_transpile.json no longer leaves the real-EML
// demo (_eml_demo) out of this folder. The original BO; its twin with
// handlers in the system's form (_sf, R3) is read by systemForm() and has
// tests of its own.
const sf = f => /_sf\./.test(basename(f));
const demo = () => walk("src/rap_demo").filter(f => /\.(abap|xml|asbdef|asddls)$/.test(f) && !sf(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const systemForm = () => walk("src/rap_demo").filter(f => /\.(abap|xml|asbdef|asddls)$/.test(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
// The pool inherits the clean-room bases of the R2 runtime (src/rap/), which
// lean on the LUW buffer, the CDS source interface and open-abap-core; those
// are dependencies here, checked but not the subject (`npm run lint` lints
// them as source).
const base = () => [...walk("src/rap"), ...walk("src/luw"), ...walk("src/logon"), "src/sadl/zif_stg_cds_source.intf.abap"]
  .filter(f => /\.(abap|xml)$/.test(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const coreFiles = () => walk(join(libraryPath(resolve("."), "open-abap-core"), "src"))
  .filter(f => !/[\\/]tcp[\\/]/.test(f) && /\.(abap|xml)$/.test(f)).map(f => ({filename: basename(f), contents: readFileSync(f, "utf8")}));
const dependencies = (lib, reg) => reg.addDependencies([...base(), ...coreFiles()].map(f => new lib.MemoryFile(f.filename, f.contents)));
const config = () => new core.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {check_syntax: true, unknown_types: true}}));
function registry(outputs) {
  const reg = new core.Registry(config());
  reg.addFiles(Object.entries(outputs).map(([name, source]) => new core.MemoryFile(name, source)));
  reg.parse();
  assert.deepEqual(reg.findIssues().map(i => i.getMessage()), []);
  return reg;
}
function component(type, path) {
  for (const name of path.split("-")) {
    type = type?.getComponents?.().find(c => c.name.toLowerCase() === name)?.type;
    assert.ok(type, `missing ${path} at ${name}`);
  }
  assert.ok(!type.containsVoid?.(), `${path} is concrete`);
  return type;
}

describe("RAP derived type generator (R1)", () => {
  it("lints the original source with open-abap before lowering", function () {
    this.timeout(30000);
    const reg = new core.Registry(config());
    reg.addFiles(demo().map(f => new core.MemoryFile(f.filename, f.contents)));
    dependencies(core, reg);
    assert.deepEqual(reg.findIssues().map(i => i.getMessage()), []);
  });

  it("discovers content packs, ignores test fixtures, follows overrides and removes stale output", () => {
    const root = mkdtempSync(join(tmpdir(), "rap-content-"));
    const saved = process.env.OSD_ROOT;
    try {
      process.env.OSD_ROOT = root;
      mkdirSync(join(root, "src")); mkdirSync(join(root, "test"));
      mkdirSync(join(root, "packs/notes/src"), {recursive: true});
      writeFileSync(join(root, "libs.lock.json"), readFileSync("libs.lock.json"));
      writeFileSync(join(root, "packs/notes/osd-pack.json"), JSON.stringify({name: "notes"}));
      writeFileSync(join(root, "test/broken.bdef.asbdef"), "invalid test fixture");
      for (const f of demo()) writeFileSync(join(root, "packs/notes/src", f.filename), f.contents);
      // Later pack wins over a broken BDEF with the same name under src/.
      writeFileSync(join(root, "src/zi_rap_note.bdef.asbdef"), "invalid shadowed source");
      main();
      const generated = join(root, "gen/rap");
      assert.ok(existsSync(join(generated, "bindings.json")));
      assert.ok(Object.keys(JSON.parse(readFileSync(join(generated, "bindings.json")))).length > 0);
      writeFileSync(join(generated, "stale.intf.abap"), "stale");
      main(); assert.ok(!existsSync(join(generated, "stale.intf.abap")));
      unlinkSync(join(root, "packs/notes/src/zi_rap_note.bdef.asbdef"));
      unlinkSync(join(root, "src/zi_rap_note.bdef.asbdef"));
      main(); assert.ok(!existsSync(generated), "no BDEF is a no-op with stale output removed");
    } finally {
      if (saved === undefined) delete process.env.OSD_ROOT; else process.env.OSD_ROOT = saved;
      rmSync(root, {recursive: true, force: true});
    }
  });
  it("discovers content DDIC views through the production entry point", () => {
    const root = mkdtempSync(join(tmpdir(), "rap-view-"));
    const saved = process.env.OSD_ROOT;
    try {
      process.env.OSD_ROOT = root;
      mkdirSync(join(root, "src"));
      writeFileSync(join(root, "libs.lock.json"), readFileSync("libs.lock.json"));
      const files = demo();
      const cds = files.find(f => f.filename.endsWith(".asddls"));
      cds.contents = cds.contents.replace("select from zrap_note", "select from znote_view");
      files.push({filename: "znote_view.view.xml", contents: `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_VIEW" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>
  <DD25V><VIEWNAME>ZNOTE_VIEW</VIEWNAME><AGGTYPE>V</AGGTYPE><ROOTTAB>ZRAP_NOTE</ROOTTAB><VIEWCLASS>D</VIEWCLASS></DD25V>
  <DD26V_TABLE><DD26V><VIEWNAME>ZNOTE_VIEW</VIEWNAME><TABNAME>ZRAP_NOTE</TABNAME><TABPOS>0001</TABPOS></DD26V></DD26V_TABLE>
  <DD27P_TABLE>${["NOTE_ID", "NOTE_TEXT", "STATUS"].map((field, i) => `<DD27P>
   <VIEWNAME>ZNOTE_VIEW</VIEWNAME><OBJPOS>000${i + 1}</OBJPOS><VIEWFIELD>${field}</VIEWFIELD>
   <TABNAME>ZRAP_NOTE</TABNAME><FIELDNAME>${field}</FIELDNAME><KEYFLAG>${i === 0 ? "X" : ""}</KEYFLAG>
  </DD27P>`).join("")}</DD27P_TABLE>
 </asx:values></asx:abap>
</abapGit>`});
      const {outputs, bindings} = generate(files);
      registry(outputs);
      for (const f of files) writeFileSync(join(root, "src", f.filename), f.contents);
      main();
      for (const [name, source] of Object.entries(outputs)) assert.equal(readFileSync(join(root, "gen/rap", name), "utf8"), source);
      assert.deepEqual(JSON.parse(readFileSync(join(root, "gen/rap/bindings.json"))), bindings);
    } finally {
      if (saved === undefined) delete process.env.OSD_ROOT; else process.env.OSD_ROOT = saved;
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("validates cast source columns and entities independently of target types", () => {
    const files = demo();
    const cds = files.find(f => f.filename.endsWith(".asddls"));
    cds.contents = cds.contents.replace("note_text as NoteText", "cast( note_text as abap.char( 30 ) ) as NoteText");
    const {outputs} = generate(files);
    registry(outputs);
    assert.match(Object.values(outputs).join(""), /notetext TYPE c LENGTH 30/i);
    cds.contents = cds.contents.replace("cast( note_text", "cast( missing");
    assert.throws(() => generate(files), /Unresolved CDS field ZI_RAP_NOTE.NOTETEXT/);
    cds.contents = `define root view entity ZI_RAP_NOTE as select from zmissing {
      key cast( note_id as abap.char( 10 ) ) as NoteId,
          cast( note_text as abap.char( 60 ) ) as NoteText,
          cast( status as abap.char( 1 ) ) as Status }`;
    assert.throws(() => generate(files), /Unresolved CDS (entity|field)/);
  });

  it("validates mapping tables even for empty corresponding mappings", () => {
    const files = demo();
    const bdef = files.find(f => f.filename.endsWith(".asbdef"));
    bdef.contents = bdef.contents.replace(/mapping for zrap_note \{[^}]*\}/, "mapping for zrap_note corresponding;");
    registry(generate(files).outputs);
    bdef.contents = bdef.contents.replace("mapping for zrap_note", "mapping for zmissing");
    assert.throws(() => generate(files), /missing mapping table zmissing/);
  });

  it("emits concrete CDS fields and all required RAP families/component groups", () => {
    const {outputs, bindings} = generate(demo());
    const reg = registry(outputs);
    // Inspect the resolved declarations through a consumer, independent of internal scopes.
    const decl = Object.entries(bindings).filter(([k]) => k.startsWith("TABLE ") && k.endsWith(" ZI_RAP_NOTE"));
    for (const kind of ["CREATE", "UPDATE", "DELETE", "READ IMPORT", "READ RESULT", "MAPPED", "FAILED", "REPORTED", "LOCK", "KEY OF", "DETERMINATION", "VALIDATION"]) {
      assert.ok(bindings[`TABLE FOR ${kind} ZI_RAP_NOTE`], `missing ${kind} family`);
    }
    const vars = decl.map(([, v], i) => `DATA v${i} TYPE ${v}.`).join("\n");
    reg.addFile(new core.MemoryFile("zrap_probe.prog.abap", vars)); reg.parse();
    assert.deepEqual(reg.findIssues().map(i => i.getMessage()), []);
    const scope = new core.SyntaxLogic(reg, reg.getObject("PROG", "ZRAP_PROBE")).run().spaghetti.getTop();
    const lookup = (s, n) => s.findVariable(n) ?? s.getChildren().map(c => lookup(c, n)).find(Boolean);
    for (const [[key], i] of decl.map((x, i) => [x, i])) {
      const row = lookup(scope, `v${i}`).getType().getRowType();
      for (const path of ["noteid", "%key-noteid", "%tky-noteid"]) component(row, path);
      if (/FOR (CREATE|UPDATE|READ IMPORT) /.test(key)) component(row, "%control-notetext");
      if (/FOR (CREATE|MAPPED|FAILED|REPORTED)( EARLY)? /.test(key)) component(row, "%cid");
      if (/FOR (UPDATE|DELETE) /.test(key)) component(row, "%cid_ref");
      if (/FOR (CREATE|UPDATE|READ RESULT) /.test(key)) {
        component(row, "%data-notetext");
        assert.equal(component(row, "notetext").getLength(), 60);
      }
      if (/FOR FAILED/.test(key)) component(row, "%fail-cause");
      if (/FOR REPORTED/.test(key)) { component(row, "%msg"); component(row, "%element-status"); }
    }
    assert.match(bindings["TABLE FOR ACTION IMPORT ZI_RAP_NOTE\\NOTE~APPROVE"], /=>t_e0_a0_import$/);
    assert.match(bindings["TABLE FOR ACTION RESULT ZI_RAP_NOTE\\NOTE~APPROVE"], /=>t_e0_a0_result$/);
    assert.match(bindings["RESPONSE FOR FAILED EARLY ZI_RAP_NOTE"], /=>r_failed$/);
  });

  it("adds draft identity, late-numbering pid, action parameters, and action results", () => {
    const files = demo();
    const bdef = files.find(f => f.filename.endsWith(".asbdef"));
    bdef.contents = bdef.contents.replace("unique;", "unique;\nwith draft;").replace("lock master", "late numbering\nlock master").replace("action Approve result", "action Approve parameter ZI_RAP_NOTE result");
    const {outputs} = generate(files);
    registry(outputs);
    const text = Object.values(outputs).join("");
    for (const textPart of ["%pid TYPE x LENGTH 16", "%is_draft TYPE x LENGTH 1", "%param TYPE e0_a0_param", "%param TYPE e0_a0_payload"]) assert.ok(text.includes(textPart), textPart);
  });

  it("rejects incomplete models, unresolved types, projections and unsupported forms", () => {
    for (const [from, to, error] of [
      ["  create;", "  mystery;", /unparsed/],
      ["ZI_RAP_NOTE alias", "ZI_MISSING alias", /Unresolved CDS/],
      ["managed implementation in class zbp_rap_note unique;", "projection;", /lock master in a projection/],
      ["  create;", "  association _Items { create; }", /association _Items is no association of the CDS entity/],
      ["persistent table zrap_note", "persistent table zmissing", /missing persistent table/],
      ["NoteText = note_text", "Missing = note_text", /unknown mapping field/],
      ["NoteText = note_text", "NoteText = missing", /unknown mapping column/],
    ]) {
      const files = demo();
      files.find(f => f.filename.endsWith(".asbdef")).contents = files.find(f => f.filename.endsWith(".asbdef")).contents.replace(from, to);
      assert.throws(() => generate(files), error);
    }
    assert.throws(() => lowerDerived("DATA x TYPE TABLE FOR FAILED LATE zi_rap_note.", "x.prog.abap", generate(demo()).bindings), /unsupported or unresolved/);
    assert.deepEqual(generate([]), {outputs: {}, bindings: {}});
  });

  it("lowers mixed-case, qualified and multiline types while preserving comments/literals and line counts", () => {
    const {bindings} = generate(demo());
    const source = `" TYPE TABLE FOR CREATE zi_rap_note\nDATA text TYPE string VALUE 'TYPE TABLE FOR CREATE zi_rap_note'.\nDATA x TYPE table \" keep me\n FOR create zi_rap_note.\nDATA y TYPE TABLE FOR ACTION IMPORT zi_rap_note\\Note~Approve.\n`;
    const lowered = lowerDerived(source, "zrap.prog.abap", bindings);
    assert.equal(source.split("\n").length, lowered.split("\n").length);
    assert.ok(lowered.includes('" keep me'));
    assert.ok(lowered.includes("VALUE 'TYPE TABLE FOR CREATE zi_rap_note'"));
    assert.ok(lowered.startsWith('" TYPE TABLE FOR CREATE zi_rap_note'));
    assert.ok(lowered.includes(bindings["TABLE FOR CREATE ZI_RAP_NOTE"]));
    assert.ok(lowered.includes(bindings["TABLE FOR ACTION IMPORT ZI_RAP_NOTE\\NOTE~APPROVE"]));
    assert.equal(lowerDerived(lowered, "zrap.prog.abap", bindings), lowered);
  });

  it("lowers the handler declarations of the system's form into explicit signatures (R3)", () => {
    const {bindings} = generate(systemForm());
    const pool = systemForm().find(f => f.filename === "zbp_rap_note_sf.clas.locals_imp.abap");
    const lowered = lowerDerived(pool.contents, pool.filename, bindings);
    assert.equal(lowered.split("\n").length, pool.contents.split("\n").length, "rows kept for the source map");
    const t = k => bindings[`POOL ZBP_RAP_NOTE_SF FOR ${k}`];
    assert.ok(lowered.includes(`METHODS default_status IMPORTING keys TYPE ${t("DETERMINATION NOTE")} CHANGING reported TYPE ${t("RESPONSE REPORTED")}`));
    assert.ok(lowered.includes(`METHODS text_length IMPORTING keys TYPE ${t("VALIDATION NOTE")} CHANGING failed TYPE ${t("RESPONSE FAILED")} reported TYPE ${t("RESPONSE REPORTED")}`));
    assert.ok(lowered.includes(`METHODS approve_note IMPORTING keys TYPE ${t("ACTION IMPORT NOTE~APPROVE")} CHANGING result TYPE ${t("ACTION RESULT NOTE~APPROVE")} mapped TYPE ${t("RESPONSE MAPPED")} failed TYPE`));
    assert.ok(!/FOR (DETERMINE|VALIDATE|MODIFY)\b/.test(lowered.replace(/^\*.*$/gm, "")), "no implicit form is left");
    assert.equal(lowerDerived(lowered, pool.filename, bindings), lowered, "idempotent");
    // the other forms, by the CDS name or the alias, chained, namespaced pool name
    const forms = [
      "CLASS lhc DEFINITION INHERITING FROM cl_abap_behavior_handler.",
      "  PRIVATE SECTION.",
      "    METHODS: rd FOR READ IMPORTING k FOR READ zi_rap_note_sf RESULT r,",
      "      lk FOR LOCK IMPORTING k FOR LOCK Note,",
      "      cud FOR MODIFY IMPORTING c FOR CREATE Note u FOR UPDATE Note d FOR DELETE Note. \" a comment",
      "    METHODS other IMPORTING x TYPE i.",
      "    METHODS t FOR TESTING.",
      "ENDCLASS."].join("\n");
    const out = lowerDerived(forms, "zbp_rap_note_sf.clas.locals_imp.abap", bindings);
    assert.ok(out.includes(`rd IMPORTING k TYPE ${t("READ IMPORT ZI_RAP_NOTE_SF")} CHANGING r TYPE ${t("READ RESULT ZI_RAP_NOTE_SF")} failed TYPE ${t("RESPONSE FAILED")} reported TYPE`));
    assert.ok(out.includes(`lk IMPORTING k TYPE ${t("LOCK NOTE")} CHANGING failed TYPE`));
    assert.ok(out.includes(`cud IMPORTING c TYPE ${t("CREATE NOTE")} u TYPE ${t("UPDATE NOTE")} d TYPE ${t("DELETE NOTE")} CHANGING mapped TYPE`));
    // R4: instance features and early numbering
    const r4 = lowerDerived([
      "CLASS lhc DEFINITION INHERITING FROM cl_abap_behavior_handler.",
      "  PRIVATE SECTION.",
      "    METHODS f FOR INSTANCE FEATURES",
      "      IMPORTING keys REQUEST requested_features FOR Note RESULT result.",
      "    METHODS n FOR NUMBERING IMPORTING entities FOR CREATE Note.",
      "ENDCLASS."].join("\n"), "zbp_rap_note_sf.clas.locals_imp.abap", bindings);
    assert.ok(r4.includes(`METHODS f IMPORTING keys TYPE ${t("INSTANCE FEATURES KEY NOTE")} requested_features TYPE ${t("INSTANCE FEATURES REQUEST NOTE")} CHANGING result TYPE ${t("INSTANCE FEATURES RESULT NOTE")} failed TYPE ${t("RESPONSE FAILED")} reported TYPE ${t("RESPONSE REPORTED")}`), r4);
    assert.ok(r4.includes(`METHODS n IMPORTING entities TYPE ${t("CREATE NOTE")} CHANGING mapped TYPE ${t("RESPONSE MAPPED")} failed TYPE`), r4);
    assert.equal(r4.split("\n").length, 6, "rows kept for the source map");
    assert.ok(out.includes("METHODS other IMPORTING x TYPE i.") && out.includes("METHODS t FOR TESTING.") && out.includes('" a comment'));
    for (const [decl, error] of [
      // R5: the cba numbering form is lowered; the note BO has no _Items
      ["METHODS n FOR NUMBERING IMPORTING entities FOR CREATE Note\\_Items.", /unresolved RAP handler type CREATE Note\\_Items/],
      ["METHODS f FOR GLOBAL FEATURES IMPORTING REQUEST r FOR Note RESULT result.", /GLOBAL FEATURES has no derived/],
      ["METHODS a FOR INSTANCE AUTHORIZATION IMPORTING keys REQUEST r FOR Note RESULT result.", /INSTANCE AUTHORIZATION has no derived/],
      ["METHODS a FOR GLOBAL AUTHORIZATION IMPORTING REQUEST r FOR Note RESULT result.", /GLOBAL AUTHORIZATION has no derived/],
      ["METHODS c FOR MODIFY IMPORTING e FOR CREATE Note\\_Items.", /create by association/],
      ["METHODS d FOR DETERMINE ON MODIFY IMPORTING keys FOR Other~SetStatus.", /unresolved RAP handler type DETERMINATION Other/],
      ["METHODS a FOR MODIFY IMPORTING keys FOR ACTION Note~Reject RESULT result.", /unresolved RAP handler type ACTION IMPORT Note~Reject/],
    ]) assert.throws(() => lowerDerived(`CLASS l DEFINITION.\n PRIVATE SECTION.\n ${decl}\nENDCLASS.`, "zbp_rap_note_sf.clas.locals_imp.abap", bindings), error, decl);
    // a pool no behavior definition names
    assert.throws(() => lowerDerived("CLASS l DEFINITION.\n METHODS d FOR DETERMINE ON SAVE IMPORTING keys FOR Note~Normalize.\nENDCLASS.", "zbp_other.clas.locals_imp.abap", bindings), /implementation in class ZBP_OTHER/);
  });

  it("lints and transpiles the system-form pool through the real source loader (R3)", async function () {
    this.timeout(60000);
    const root = mkdtempSync(join(tmpdir(), "rap-r3-"));
    try {
      const {outputs, bindings} = generate(systemForm());
      mkdirSync(join(root, "src")); mkdirSync(join(root, "gen/rap"), {recursive: true});
      for (const f of systemForm()) writeFileSync(join(root, "src", f.filename), f.contents);
      for (const [name, source] of Object.entries(outputs)) writeFileSync(join(root, "gen/rap", name), source);
      writeFileSync(join(root, "gen/rap/bindings.json"), JSON.stringify(bindings));
      const {Transpiler, core: selectedCore} = modulesOf(resolve("."));
      const buildConfig = {...JSON.parse(readFileSync("abap_transpile.json")), input_folder: ["src", "gen/rap"], output_folder: "output"};
      const {files} = await loadFiles(root, buildConfig, selectedCore);
      const reg = new selectedCore.Registry(new selectedCore.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {check_syntax: true, unknown_types: true}})));
      for (const f of files) reg.addFile(new selectedCore.MemoryFile(f.filename, f.contents));
      dependencies(selectedCore, reg);
      reg.parse();
      assert.deepEqual(reg.findIssues().map(i => `${i.getFilename()}: ${i.getMessage()}`), []);
      const output = await new Transpiler({unknownTypes: "compileError", ignoreSyntaxCheck: false, only: o => !reg.isDependency(o)}).run(reg, {set() {}, async tick() {}});
      const code = output.objects.filter(o => o.object.name.toUpperCase() === "ZBP_RAP_NOTE_SF").map(o => o.chunk.getCode()).join("\n");
      // the parameters exist in the emitted method: the implicit form had none for the parser
      assert.match(code, /async #default_status\(INPUT\)[\s\S]*INPUT\.reported/);
      assert.match(code, /async #approve_note\(INPUT\)[\s\S]*INPUT\.result/);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });

  it("lints and transpiles the original managed pool through the real source loader", async function () {
    this.timeout(30000);
    const root = mkdtempSync(join(tmpdir(), "rap-r1-"));
    try {
      const {outputs, bindings} = generate(demo());
      mkdirSync(join(root, "src")); mkdirSync(join(root, "gen/rap"), {recursive: true});
      for (const f of demo()) writeFileSync(join(root, "src", f.filename), f.contents);
      for (const [name, source] of Object.entries(outputs)) writeFileSync(join(root, "gen/rap", name), source);
      writeFileSync(join(root, "gen/rap/bindings.json"), JSON.stringify(bindings));
      const {Transpiler, core: selectedCore} = modulesOf(resolve("."));
      const buildConfig = {...JSON.parse(readFileSync("abap_transpile.json")), input_folder: ["src", "gen/rap"], output_folder: "output"};
      const {files} = await loadFiles(root, buildConfig, selectedCore);
      const reg = new selectedCore.Registry(new selectedCore.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {check_syntax: true, unknown_types: true}})));
      for (const f of files) reg.addFile(new selectedCore.MemoryFile(f.filename, f.contents));
      dependencies(selectedCore, reg);
      reg.parse();
      assert.deepEqual(reg.findIssues().map(i => `${i.getFilename()}: ${i.getMessage()}`), []);
      const output = await new Transpiler({unknownTypes: "compileError", ignoreSyntaxCheck: false, only: o => !reg.isDependency(o)}).run(reg, {set() {}, async tick() {}});
      const pool = output.objects.find(o => o.object.name.toUpperCase() === "ZBP_RAP_NOTE");
      assert.ok(pool, "behavior pool emitted");
      const code = output.objects.map(o => o.chunk.getCode()).join("\n");
      assert.match(code, /lhc_note/i);
      assert.match(code, /%control/);
      assert.match(code, /%key/);
      assert.ok(!code.includes("RAP-TODO"));
      // Replay from retained raw bytes, even if live generated bindings change.
      const generation = join(root, "build/frozen"); mkdirSync(generation, {recursive: true});
      keepCompileInputs(root, generation, buildConfig, files, []);
      keepGeneratedSources(root, generation);
      writeFileSync(join(root, "gen/rap/bindings.json"), "{}");
      const frozen = readCompileInputs(root, generation);
      assert.deepEqual(frozen.rapBindings, bindings);
      const replay = new selectedCore.Registry();
      for (const f of frozen.files) replay.addFile(new selectedCore.MemoryFile(f.filename, lowerDerived(f.bytes.toString("utf8"), f.filename, frozen.rapBindings)));
      dependencies(selectedCore, replay);
      const replayed = await new Transpiler({unknownTypes: "compileError", ignoreSyntaxCheck: false, only: o => !replay.isDependency(o)}).run(replay, {set() {}, async tick() {}});
      assert.equal(replayed.objects.map(o => o.chunk.getCode()).join("\n"), code);
    } finally { rmSync(root, {recursive: true, force: true}); }
  });
});
