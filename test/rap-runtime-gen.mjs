// R2: the generated half of the managed RAP runtime (tools/rap/rap-runtime-gen.mjs,
// docs/rap-runtime.md). The runtime itself runs in ABAP Unit
// (test/unit/zcl_osd_rap_test); this checks what is generated from the BDEF and
// the pool, what is refused, and that the output passes the abaplint check
// the build applies.
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {basename, join, resolve} from "node:path";
import * as core from "@abaplint/core";
import {generate, walk} from "../tools/rap/bdef-gen.mjs";
import {runtimeOutputs, poolClasses} from "../tools/rap/rap-runtime-gen.mjs";
import {lowerDerived} from "../tools/rap/lower-derived.mjs";
import {warmRule} from "../tools/osd-warm.mjs";
import {libraryPath} from "../tools/osd-lib-path.mjs";

const read = f => ({filename: basename(f), contents: readFileSync(f, "utf8")});
// the original BO; the twin with handlers in the system's form (_sf, R3) is systemForm()
const demo = () => walk("src/rap_demo").filter(f => /\.(abap|xml|asbdef|asddls)$/.test(f) && !/_sf\./.test(basename(f))).map(read);
const systemForm = () => walk("src/rap_demo").filter(f => /\.(abap|xml|asbdef|asddls)$/.test(f) && !/zcl_rap_note_eml/.test(f)).map(read);
const pool = files => files.filter(f => /\.clas\.(locals_imp\.)?abap$/.test(f.filename));
function build(files) {
  const {plans} = generate(files);
  return runtimeOutputs(plans, pool(files));
}
function edit(files, suffix, from, to) {
  const f = files.find(x => x.filename.endsWith(suffix));
  assert.ok(f.contents.includes(from), `fixture text ${from}`);
  f.contents = f.contents.replace(from, to);
  return files;
}

describe("RAP managed runtime generator (R2)", () => {
  it("binds the demo pool's handler and saver and writes the model", () => {
    const outputs = build(demo());
    const names = Object.keys(outputs).sort();
    assert.equal(names.length, 2);
    assert.ok(names.includes("zcl_osd_rap_registry.clas.abap"));
    const adapter = outputs[names.find(n => n.startsWith("zcl_rap_"))];
    for (const text of [
      "rs_model-saver = '\\CLASS-POOL=ZBP_RAP_NOTE\\CLASS=LSC_NOTE'.",
      "ls_entity-handler = '\\CLASS-POOL=ZBP_RAP_NOTE\\CLASS=LHC_NOTE'.",
      "ls_entity-source = 'ZCL_STG_TAB_ZRAP_NOTE'.",
      "ls_field-column = 'NOTE_ID'.",
      "ls_field-numbering = abap_true.",
      "ls_field-mandatory = 'X'.",
      "ls_callable-method = 'SET_STATUS'.",
      "ls_callable-method = 'CHECK_TEXT'.",
      "CALL METHOD io_handler->('APPROVE')",
    ]) assert.ok(adapter.includes(text), text);
    // a validation's entities are imported, its responses changed
    assert.match(adapter, /io_handler->\('CHECK_TEXT'\)\s+EXPORTING\s+keys = lt_keys\s+entities = <lt_rows>\s+CHANGING\s+failed = <ls_failed>\s+reported = <ls_reported>\./);
    assert.ok(outputs["zcl_osd_rap_registry.clas.abap"].includes("WHEN 'ZI_RAP_NOTE'."));
  });

  it("reads the pool's local classes with the parser", () => {
    const classes = poolClasses("zbp_rap_note", pool(demo()));
    assert.deepEqual(classes.map(c => `${c.kind} ${c.name}`), ["handler lhc_note", "saver lsc_note"]);
    const approve = classes[0].methods.find(m => m.name === "approve");
    assert.deepEqual(approve.parameters.map(p => `${p.direction} ${p.name}`), ["importing keys", "changing entities", "changing result"]);
  });

  it("passes the build's abaplint check together with the pool and the runtime", function () {
    this.timeout(60000);
    const files = demo();
    const {outputs, bindings} = generate(files);
    Object.assign(outputs, build(files));
    const reg = new core.Registry(new core.Config(JSON.stringify({global: {files: "/**/*.*"}, syntax: {version: "open-abap", errorNamespace: "."}, rules: {check_syntax: true, unknown_types: true}})));
    for (const f of files) reg.addFile(new core.MemoryFile(f.filename, lowerDerived(f.contents, f.filename, bindings)));
    for (const [name, source] of Object.entries(outputs)) reg.addFile(new core.MemoryFile(name, source));
    for (const f of [...walk("src/rap"), ...walk("src/luw"), ...walk("src/logon"), "src/sadl/zif_stg_cds_source.intf.abap", "src/sadl/zif_stg_sadl_behavior.intf.abap"].filter(x => /\.(abap|xml)$/.test(x))) {
      reg.addFile(new core.MemoryFile(basename(f), readFileSync(f, "utf8")));
    }
    // open-abap-odata: the /IWBEP/ exceptions ZCL_OSD_RAP_SADL raises (R2c)
    reg.addDependencies(walk(join(libraryPath(resolve("."), "open-abap-odata"), "src"))
      .filter(f => /\.(abap|xml)$/.test(f)).map(f => new core.MemoryFile(basename(f), readFileSync(f, "utf8"))));
    reg.addDependencies(walk(join(libraryPath(resolve("."), "open-abap-core"), "src"))
      .filter(f => !/[\\/]tcp[\\/]/.test(f) && /\.(abap|xml)$/.test(f)).map(f => new core.MemoryFile(basename(f), readFileSync(f, "utf8"))));
    reg.parse();
    // the table class comes from cds2ddic, not from here: void, not an error
    const issues = reg.findIssues().filter(i => !reg.isFileDependency(i.getFilename())).map(i => `${i.getFilename()}: ${i.getMessage()}`);
    assert.deepEqual(issues, []);
  });

  it("refuses what the runtime does not run", () => {
    for (const [suffix, from, to, error] of [
      [".asbdef", "managed implementation", "unmanaged implementation", /only managed/],
      [".asbdef", "lock master", "early numbering\nlock master", /early numbering without a FOR NUMBERING/],
      // R10: late numbering runs, given a saver that redefines adjust_numbers
      [".asbdef", "lock master", "late numbering\nlock master", /late numbering needs a saver redefining adjust_numbers/],
      [".asbdef", "update;", "update ( features : instance );", /features : instance without a FOR INSTANCE FEATURES method/],
      [".asbdef", "create;", "create ( features : instance );", /global features are outside R4/],
      [".asbdef", "lock master", "etag master Missing\nlock master", /etag master Missing is no element/],
      [".asbdef", "field ( numbering : managed, readonly ) NoteId;", "field ( numbering : managed ) NoteText;", /needs a key of type x LENGTH 16/],
      [".asbdef", "determination Normalize on save { field NoteText; }", "determination Normalize on save { delete; }", /delete trigger/],
      [".asbdef", "action Approve result [1] $self;", "action Approve parameter ZI_RAP_NOTE result [1] $self;", /only instance actions/],
      [".asbdef", "validation CheckText", "validation CheckLength", /no handler method named after it/],
      [".asbdef", "field ( readonly ) Status;", "field ( suppress ) Status;", /field control suppress is outside R2/],
      [".asbdef", "field ( readonly ) Status;", "field ( readonly : create ) Status;", /field control readonly:create is outside R2/],
      [".asbdef", "field ( mandatory ) NoteText;", "field ( mandatory : update ) NoteText;", /field control mandatory:update is outside R2/],
      [".locals_imp.abap", "CHANGING  failed   TYPE", "CHANGING  failure  TYPE", /parameters must be keys/],
    ]) {
      assert.throws(() => build(edit(demo(), suffix, from, to)), error, `${from} -> ${to}`);
    }
  });

  it("binds the system-form pool by the FOR clause and passes parameters by role (R3)", () => {
    const files = systemForm();
    const {plans} = generate(files);
    const outputs = runtimeOutputs(plans, pool(files));
    const adapter = Object.values(outputs).find(s => s.includes("rs_model-bdef = 'ZI_RAP_NOTE_SF'."));
    const explicit = Object.values(outputs).find(s => s.includes("rs_model-bdef = 'ZI_RAP_NOTE'."));
    for (const [name, method] of [["SETSTATUS", "DEFAULT_STATUS"], ["NORMALIZE", "TIDY_TEXT"], ["CHECKTEXT", "TEXT_LENGTH"], ["APPROVE", "APPROVE_NOTE"]]) {
      assert.match(adapter, new RegExp(`ls_callable-name = '${name}'\\.\\n    ls_callable-method = '${method}'\\.\\n    ls_callable-on`.replace("\\n    ls_callable-on", name === "APPROVE" ? "" : "\\n    ls_callable-on")));
    }
    assert.ok(!adapter.includes("ls_callable-entities"), "no instances table: the handler works through EML");
    assert.equal(explicit.match(/ls_callable-entities = abap_true/g).length, 4, "the explicit pool still takes its table back");
    assert.match(adapter, /io_handler->\('TEXT_LENGTH'\)\s+EXPORTING\s+keys = lt_keys\s+CHANGING\s+failed = <ls_failed>\s+reported = <ls_reported>\./);
    assert.match(adapter, /io_handler->\('APPROVE_NOTE'\)\s+EXPORTING\s+keys = lt_keys\s+CHANGING\s+result = <lt_result>\s+mapped = <ls_mapped>\s+failed = <ls_failed>\s+reported = <ls_reported>\./);
    // R6: the caller's MAPPED reaches an action handler (a factory action fills it)
    assert.match(adapter, /IF ir_mapped IS BOUND\.\n\s+ASSIGN ir_mapped->\* TO <ls_mapped>\.\n\s+ELSE\.\n\s+ASSIGN ls_mapped TO <ls_mapped>\./);
    const classes = poolClasses("zbp_rap_note_sf", pool(files));
    assert.deepEqual(classes[0].methods.find(m => m.name === "default_status").parameters.map(p => `${p.direction} ${p.name}`), ["importing keys", "changing reported"]);
    // a parameter named otherwise keeps its role; a wrong ON and a missing FOR clause are refused
    const renamed = edit(systemForm(), "_sf.clas.locals_imp.abap", "IMPORTING keys FOR note~checktext", "IMPORTING lt_keys FOR note~checktext");
    assert.match(Object.values(runtimeOutputs(generate(renamed).plans, pool(renamed))).join(), /io_handler->\('TEXT_LENGTH'\)\s+EXPORTING\s+lt_keys = lt_keys/);
    for (const [from, to, error] of [
      ["FOR DETERMINE ON MODIFY\n      IMPORTING keys FOR note~setstatus", "FOR DETERMINE ON SAVE\n      IMPORTING keys FOR note~setstatus", /FOR DETERMINE ON SAVE for a determination on modify/],
      ["IMPORTING keys FOR note~checktext", "IMPORTING keys FOR note~checkother", /no handler method named after it/],
    ]) {
      const f = edit(systemForm(), "_sf.clas.locals_imp.abap", from, to);
      assert.throws(() => runtimeOutputs(generate(f).plans, pool(f)), error, to);
    }
  });

  it("generates nothing without a behavior definition", () => {
    assert.deepEqual(runtimeOutputs([], []), {});
  });

  it("sends an edit of a behavior pool's handler or saver cold", () => {
    const saver = "CLASS lsc_x DEFINITION INHERITING FROM cl_abap_behavior_saver FINAL.\nENDCLASS.\n";
    assert.match(warmRule({path: "src/x/zbp_x.clas.locals_imp.abap", before: saver, after: saver + "* edited\n"}), /behavior pool/);
    assert.equal(warmRule({path: "src/x/zcl_x.clas.abap", before: "CLASS zcl_x DEFINITION.\nENDCLASS.\n", after: "CLASS zcl_x DEFINITION.\n* c\nENDCLASS.\n"}), undefined);
  });
});
