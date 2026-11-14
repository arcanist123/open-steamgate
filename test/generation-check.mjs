import {expect} from "chai";
import {existsSync, mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assertLoadable, checkGeneration, findCycles, importEdges, loadCheck, UNSETTLED_TLA} from "../tools/osd-generation-check.mjs";

// **A green transpile whose generation cannot load** was the HANA track's
// latest false green (2026-11-14): a class pool whose locals subclass the
// global class made its two modules await each other, and init.mjs never
// finished importing (ANORMALIES local-inherits-owner). The fixtures below
// are the shapes, in plain modules; the last case is the real generation,
// which holds test/unit/zcl_osd_local_sub_owner and zcx_osd_local_sub_owner.
function generation(files) {
  const dir = mkdtempSync(join(tmpdir(), "osd-generation-check-"));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
  return dir;
}

describe("generation check: a generation that cannot load is refused", function () {
  this.timeout(120000);
  const made = [];
  const fixture = (files) => { const dir = generation(files); made.push(dir); return dir; };
  after(() => { for (const dir of made) rmSync(dir, {recursive: true, force: true}); });

  it("passes a generation whose awaited imports form no cycle", () => {
    const dir = fixture({
      "init.mjs": `await import("./zcl_a.clas.mjs");\n`,
      "zcl_a.clas.mjs": `await import("./zcl_a.clas.locals.mjs");\nclass zcl_a {}\nexport {zcl_a};\n`,
      "zcl_a.clas.locals.mjs": `class lcl_b {}\nexport {lcl_b};\n`,
    });
    const result = checkGeneration(dir, {load: true, allow: []});
    expect(result, JSON.stringify(result)).to.include({ok: true, modules: 3});
  });

  it("names a cycle of awaited imports, and node exits 13 importing it", () => {
    // the transpiler's old layout of a local class inheriting from its owner
    const dir = fixture({
      "init.mjs": `await import("./zcx_x.clas.mjs");\n`,
      "zcx_x.clas.mjs": `await import("./zcx_x.clas.locals.mjs");\nclass zcx_x {}\nexport {zcx_x};\n`,
      "zcx_x.clas.locals.mjs": `const {zcx_x} = await import("./zcx_x.clas.mjs");\nclass lcx_x extends zcx_x {}\nexport {lcx_x};\n`,
    });
    const result = checkGeneration(dir, {load: true, allow: []});
    expect(result.ok).to.equal(false);
    expect(result.cycles).to.deep.equal([["zcx_x.clas.locals.mjs", "zcx_x.clas.mjs", "zcx_x.clas.locals.mjs"]]);
    expect(result.load.code).to.equal(UNSETTLED_TLA);
    expect(() => assertLoadable(dir, {allow: []})).to.throw(/cycle of awaited imports: zcx_x\.clas\.locals\.mjs -> zcx_x\.clas\.mjs/);
  });

  it("follows escaped specifiers and ignores imports inside functions", () => {
    const dir = fixture({
      "#ns#cl_a.clas.mjs": `await import("./%23ns%23cl_b.clas.mjs");\n`,
      "#ns#cl_b.clas.mjs": `async function later() {\n  await import("./#ns#cl_a.clas.mjs");\n}\nconst {x} = await import("./%23ns%23cl_a.clas.mjs");\n`,
      "zcl_c.clas.mjs": `export async function m() {\n  const {zcl_c} = await import("./zcl_c.clas.mjs");\n}\n`,
    });
    const edges = importEdges(dir);
    expect(edges.get("#ns#cl_a.clas.mjs")).to.deep.equal(["#ns#cl_b.clas.mjs"]);
    expect(edges.get("#ns#cl_b.clas.mjs")).to.deep.equal(["#ns#cl_a.clas.mjs"]);
    expect(edges.get("zcl_c.clas.mjs")).to.deep.equal([]);
    expect(findCycles(edges)).to.deep.equal([["#ns#cl_a.clas.mjs", "#ns#cl_b.clas.mjs", "#ns#cl_a.clas.mjs"]]);
  });

  it("names a module that is not JavaScript, unless the allow list names it; a stale entry is said", () => {
    const dir = fixture({
      "init.mjs": `await import("./zcl_s.clas.mjs");\n`,
      "zcl_s.clas.mjs": `class zcl_s {\n  static async m(INPUT) {\n    return INPUT.it_x[];\n  }\n}\n`,
      "zl_p.prog.mjs": `export const fine = 1;\n`,
    });
    const strict = checkGeneration(dir, {allow: []});
    expect(strict.ok).to.equal(false);
    expect(strict.syntax.map((e) => e.module)).to.deep.equal(["zcl_s.clas.mjs"]);
    const allow = [{module: "zcl_s.clas.mjs", reason: "fixture"}, {module: "zl_p.prog.mjs", reason: "fixed since"}];
    const lenient = checkGeneration(dir, {allow});
    expect(lenient.ok).to.equal(true);
    expect(lenient.tolerated.map((e) => e.module)).to.deep.equal(["zcl_s.clas.mjs"]);
    expect(lenient.stale).to.deep.equal(["zl_p.prog.mjs"]);
  });

  it("refuses a module a start loads, and only reports one that a run loads (a program)", () => {
    const dir = fixture({
      "init.mjs": `await import("./zcl_ok.clas.mjs");\n`,
      "zcl_ok.clas.mjs": `export async function run() {\n  await import("./zl_report.prog.mjs");\n}\n`,
      "zl_report.prog.mjs": `if (true) {\n  return;\n}\n`,
    });
    const result = checkGeneration(dir, {load: true, allow: []});
    expect(result.ok, JSON.stringify(result)).to.equal(true);
    expect(result.syntax).to.deep.equal([]);
    expect(result.latent.map((e) => e.module)).to.deep.equal(["zl_report.prog.mjs"]);
    expect(result.latent[0].message).to.match(/Illegal return/);
  });

  it("lists the class-constructor wait-cycles init.mjs carries, without failing the generation", () => {
    const dir = fixture({
      "init.mjs": `await import("./zcl_a.clas.mjs");\nconst __abapClassConstructorCycles = [["ZCL_POOL","ZCL_X"]];\n`,
      "zcl_a.clas.mjs": `export const a = 1;\n`,
    });
    const said = [];
    const result = assertLoadable(dir, {allow: [], log: (m) => said.push(m)});
    expect(result.ok).to.equal(true);
    expect(result.cctorCycles).to.deep.equal([["ZCL_POOL", "ZCL_X"]]);
    expect(said).to.include("generation-check: class constructors in a wait-cycle run in a defined order ABAP would not use: ZCL_POOL <-> ZCL_X");
    expect(checkGeneration(fixture({"init.mjs": `export const x = 1;\n`}), {allow: []}).cctorCycles).to.deep.equal([]);
  });

  it("reports an import that throws as a load failure with its exit code", () => {
    const dir = fixture({"init.mjs": `throw new Error("boom at load");\n`});
    const result = loadCheck(dir);
    expect(result.ok).to.equal(false);
    expect(result.code).to.equal(1);
    expect(result.stderr).to.match(/boom at load/);
  });

  describe("the built generation", () => {
    const output = join(process.cwd(), "output");
    before(function () { if (!existsSync(join(output, "init.mjs"))) this.skip(); });

    it("holds the class pools whose locals subclass the global class", () => {
      for (const module of ["zcl_osd_local_sub_owner.clas.mjs", "zcl_osd_local_sub_owner.clas.locals.mjs",
        "zcx_osd_local_sub_owner.clas.mjs", "zcx_osd_local_sub_owner.clas.locals.mjs"]) {
        expect(existsSync(join(output, module)), module).to.equal(true);
      }
    });

    it("parses, has no cycle of awaited imports, and init.mjs imports in a child node", function () {
      this.timeout(300000);
      const result = checkGeneration(output, {load: true});
      expect(result.cycles, "cycles").to.deep.equal([]);
      expect(result.syntax, "modules that do not parse").to.deep.equal([]);
      expect(result.load, "init.mjs").to.deep.equal({ok: true});
    });
  });
});
