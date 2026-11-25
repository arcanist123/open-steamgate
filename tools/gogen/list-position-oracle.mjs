// Direct-Node semantics comparisons, not assertions of SAP behavior. No SAP connection.
// OSD_HEAVY_RANGE=50-59 tools/osd-heavy.sh node tools/gogen/list-position-oracle.mjs [--native] [--check]
import {execFileSync} from "node:child_process";
import {mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {ABAP, MemoryConsole} from "@abaplint/runtime";
import {modulesOf} from "../osd-transpile.mjs";
import {libraryPath} from "../osd-lib-path.mjs";
import {acceptanceTextSource} from "./list-acceptance-oracle.mjs";
import assert from "node:assert/strict";
import {repairListPosition} from "./osabap-list.mjs";
import {home} from "./home.mjs";

const fixtureDir = join(import.meta.dirname, "testdata-list");
const cases = readdirSync(fixtureDir).filter(file => file.endsWith(".prog.abap")).sort()
  .map(file => [file.slice(0, -10), readFileSync(join(fixtureDir, file), "utf8")]);

const gui = libraryPath(home, "open-abap-gui");
const core = join(libraryPath(home, "open-abap-core"), "src");
const {Transpiler} = modulesOf(home);
const {convertProgram} = await import(pathToFileURL(join(gui, "converter/src/api.mjs")).href);
const {parseSource} = await import(pathToFileURL(join(gui, "converter/src/parser.mjs")).href);
const options = {ignoreSyntaxCheck: true, unknownTypes: "runtimeError", addCommonJS: true};
const dir = mkdtempSync(join(tmpdir(), "list-position-oracle-"));
const saved = globalThis.abap;
const hostClasses = new Set(["cx_root", "cx_no_check", "cx_static_check", "cx_dynamic_check",
  "cl_message_helper", "kernel_internal_name", "zcl_gg_host_list", "zcl_gg_host_session",
  "zcl_gg_host_compatibility", "zcl_gg_host_status", "zcx_gg_control_flow"]);
const hostFiles = [];
for (const root of [core, join(gui, "framework"), join(gui, "src")]) {
  for (const path of readdirSync(root, {recursive: true}).sort()) {
    const filename = path.split("/").at(-1);
    if (filename.endsWith(".intf.abap") || filename.endsWith(".type.abap") || filename.endsWith(".xml")
        || filename.endsWith(".clas.abap") && hostClasses.has(filename.split(".")[0])) {
      hostFiles.push({filename, contents: readFileSync(join(root, path), "utf8")});
    }
  }
}

async function runNode(files, target) {
  const output = await new Transpiler(options).runRaw(files);
  mkdirSync(target, {recursive: true});
  const abap = globalThis.abap = new ABAP({console: new MemoryConsole()});
  for (const object of output.objects) writeFileSync(join(target, object.filename), object.chunk.getCode());
  for (const object of output.objects.filter(o => o.filename.endsWith(".clas.mjs") || o.filename.endsWith(".intf.mjs"))) {
    await import(pathToFileURL(join(target, object.filename)).href);
  }
  // a program's statements run in its exported $main since transpiler 2.14.20
  const program = await import(pathToFileURL(join(target, "zprobe.prog.mjs")).href);
  if (typeof program.$main === "function") await program.$main();
  return abap.console.get();
}

// Execute the actual converted event and list processor, with the same handler
// wiring as ZCL_GG_HOST=>RUN. Kernel code only serializes the finished list;
// it does not implement list positioning or change its output.
const driver = `REPORT zprobe.
DATA lo_list TYPE REF TO zcl_gg_host_list.
DATA lo_session TYPE REF TO zcl_gg_host_session.
DATA lo_report TYPE REF TO zcl_osabap_probe.
DATA lo_handler TYPE REF TO zif_gg_list_processing_v1.
DATA lt_lines TYPE zcl_gg_host_list=>ty_text_lines.
lo_list = NEW #( ).
lo_session = NEW #( io_list = lo_list ).
lo_report = NEW #( ).
lo_handler = lo_report->zif_gg_report_v1~get_list_processing( lo_session ).
lo_list->set_handler( io_session = lo_session io_handler = lo_handler ).
IF lo_handler IS BOUND.
  lo_list->apply_settings( lo_handler->get_settings( lo_session ) ).
ENDIF.
lo_report->zif_gg_report_v1~start_of_selection( io_session = lo_session it_values = VALUE #( ) ).
lt_lines = lo_list->finish_output( ).
WRITE '@KERNEL abap.console.add(JSON.stringify(lt_lines.array().map(row => row.get())));'.`;

try {
  if (process.env.LIST_ACCEPTANCE_REPORT) {
    const source = readFileSync(process.env.LIST_ACCEPTANCE_REPORT, "utf8");
    try {
      const output = await runNode([{filename: "zprobe.prog.abap", contents: source}], join(dir, "acceptance-direct"));
      console.log(JSON.stringify({name: "acceptance", engine: "Node-direct", output}));
    } catch (error) {
      console.log(JSON.stringify({name: "acceptance", engine: "Node-direct", error: error.message}));
    }
    if (process.env.LIST_ACCEPTANCE_CSV) {
      const filename = process.env.LIST_ACCEPTANCE_CSV;
      const projected = acceptanceTextSource(source, parseSource, filename, readFileSync(filename, "utf8"));
      const output = await runNode([{filename: "zprobe.prog.abap", contents: projected}], join(dir, "acceptance-text"));
      console.log(JSON.stringify({name: "acceptance", engine: "Node-direct-text-projection", output}));
    }
  }
  for (const [name, source] of cases) {
    try {
      const output = await runNode([{filename: "zprobe.prog.abap", contents: source}], join(dir, name, "direct"));
      console.log(JSON.stringify({name, engine: "Node-direct", source, output}));
    } catch (error) {
      console.log(JSON.stringify({name, engine: "Node-direct", error: error.message}));
      if (process.argv.includes("--check")) {
        const expected = name.startsWith("format") || name.startsWith("reset") ? "FORMAT, not supported"
          : name === "new-line" ? "Statement NewLine not supported"
          : name === "top" ? "TOP-OF-PAGE, not supported" : undefined;
        assert.ok(expected && error.message.includes(expected), `${name}: ${error.message}`);
      }
    }
    // FORMAT is unsupported upstream. Elide only parsed attribute statements
    // for a separate, explicitly labelled text oracle.
    const attrs = parseSource(source).units[0].statements.filter(s => s.kind === "Format");
    let textSource = source;
    for (const s of attrs.reverse()) textSource = textSource.slice(0, s.span.startOffset) + textSource.slice(s.span.endOffset);
    let direct;
    try {
      direct = await runNode([{filename: "zprobe.prog.abap", contents: textSource}], join(dir, name, "text-direct"));
      if (attrs.length) console.log(JSON.stringify({name, engine: "Node-direct-format-elided", output: direct}));
    } catch (error) {
      if (process.argv.includes("--check") && !["new-line", "top"].includes(name)) throw error;
    }
    const converted = await convertProgram({source, filename: "zprobe.prog.abap", mode: "strict",
      nativePassthrough: true, className: "ZCL_OSABAP_PROBE", transactionCode: "ZPROBE"});
    if (!converted.supported) throw new Error(JSON.stringify(converted.diagnostics));
    const files = [...hostFiles, {filename: "zcl_osabap_probe.clas.abap", contents: repairListPosition(converted.classSource, parseSource)},
      ...(converted.helperSources ?? []).map(h => ({filename: `${h.className.toLowerCase()}.clas.abap`, contents: repairListPosition(h.source, parseSource)})),
      {filename: "zprobe.prog.abap", contents: driver}];
    const lines = JSON.parse(await runNode(files, join(dir, name, "converted")));
    console.log(JSON.stringify({name, engine: "Node-converted", lines}));
    if (process.argv.includes("--check") && name === "inline") {
      // Known upstream defect: direct ULINE does not advance before plain
      // WRITE. Assert both observations explicitly instead of ignoring them.
      assert.equal(direct, "a\n" + "-".repeat(50) + "b");
      assert.deepEqual(lines, ["a", "-".repeat(132), "b"]);
    }
    if (process.argv.includes("--check") && name === "uline-skip") {
      // Keyword documentation expectation: unmeasured; measure on A4H.
      // Neither console newline counts nor the direct runtime are a SAP oracle.
      assert.equal(direct, "-".repeat(50) + "\n");
      assert.deepEqual(lines, ["-".repeat(132), ""]);
    }
    if (process.argv.includes("--check") && name === "new-line") assert.deepEqual(lines, ["a", "b"]);
    if (process.argv.includes("--check") && name === "top") assert.deepEqual(lines, ["-".repeat(132), "h", "b"]);
    if (process.argv.includes("--check") && direct !== undefined && name !== "inline") {
      // Width is a host policy (132 vs upstream's hardcoded 50), not cursor
      // positioning. Keep every other character, including empty lines.
      const normalized = lines.map(line => line === "-".repeat(132) ? "-".repeat(50) : line).join("\n");
      assert.equal(normalized, direct, name);
    }
    if (process.argv.includes("--native")) {
      const reportDir = join(dir, "report");
      mkdirSync(reportDir, {recursive: true});
      const report = join(reportDir, "zprobe.prog.abap");
      writeFileSync(report, source);
      const build = join(dir, "native");
      execFileSync(process.execPath, [join(import.meta.dirname, "osabap.mjs"), report], {
        env: {...process.env, OSABAP_BUILD_ROOT: build}, stdio: ["ignore", "ignore", "inherit"],
      });
      const output = execFileSync(join(build, ".out/osabap"), ["-params", "{}"], {encoding: "utf8"});
      console.log(JSON.stringify({name, engine: "Go-native", output}));
      if (process.argv.includes("--check")) assert.equal(output, lines.join("\n") + "\n", name);
    }
  }
} finally {
  globalThis.abap = saved;
  rmSync(dir, {recursive: true, force: true});
}
