import {readJSONFile, readTraceMap} from "./trace-reader.mjs";
// DSL L2, slices 1 and 2 (docs/dsl-l2.md): a rule compiled to L1, rendered to
// ABAP as one query, proven by its own examples and by cases derived from its
// conditions, each run against the nested reference form. The committed class
// is what a fresh build makes; its generated test class runs green; the same
// rule with one operator changed in the ABAP makes derived cases fail, so the
// cases test the rule; type errors name the rule file and line; the trace
// reaches the rule line.
import {expect} from "chai";
import yaml from "js-yaml";
import {spawnSync} from "node:child_process";
import {existsSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, dirname, join, relative, sep} from "node:path";
import {pathToFileURL} from "node:url";
import {DEFAULT_DDIC, registryFor} from "../tools/dsl-ddic.mjs";
import {buildRule, capWarning, checkRule, compileRule, describeCases, evaluate, misfit, parseCondition, renderRule, RuleError, rulePath, stepValue} from "../tools/dsl-l2.mjs";
import {ruleKeys} from "../tools/dsl-l2-range.mjs";
import {bump, caseDiscriminates, compareValues, conditionOf, defaultValue, shiftDate, staleDiscriminates, structureDiscriminates, thresholdDiscriminates, windowOffsetDiscriminates} from "../tools/dsl-l2-eval.mjs";
import {modulesOf} from "../tools/osd-transpile.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";
import {UnitRun} from "../tools/osd-unit.mjs";

const RULE = "src/l2demo/maintenance_ship.l2.yaml";
const OUT = "src/l2demo";
const CLASS = "zcl_l2_maintenance_ship";
const RULE_TEXT = readFileSync(RULE, "utf8");
const DERIVED = ["B_STATUS_EQ", "B_STATUS_NE", "B_STATUS_BLANK", "B_SHIP_ID_MATCH", "B_SHIP_ID_NOMATCH",
  "B_DEP_DATE_LT", "B_DEP_DATE_EQ", "B_DEP_DATE_GT", "B_EXISTS_ZERO", "B_EXISTS_TWO"];
const ruleLine = (re) => RULE_TEXT.split("\n").findIndex((l) => re.test(l)) + 1;
const OR_NOT = "src/l2demo/grounded_ship_crew.l2.yaml";
const REQUIRE = "src/l2demo/ship_captain.l2.yaml";
const LIMIT = "src/l2demo/ship_voyage_limit.l2.yaml";
const MIN_CREW = "src/l2demo/ship_min_crew.l2.yaml";
const MIN_CAPTAINS = "src/l2demo/ship_min_captains.l2.yaml";
const CARGO_LIMIT = "src/l2demo/ship_cargo_limit.l2.yaml";
const MAX_CARGO = "src/l2demo/ship_max_cargo.l2.yaml";
const RECENT = "src/l2demo/recent_voyage.l2.yaml";
const BUSY = "src/l2demo/ship_busy.l2.yaml";
const RESTRICTED = "src/l2demo/ship_restricted_status.l2.yaml";
const ROW = "src/l2demo/grounded_ship.l2.yaml";
const WIDE_NOTE = "src/l2demo/ship_note.l2.yaml";
const DEMO_RULES = [WIDE_NOTE, ROW, RULE, OR_NOT, REQUIRE, LIMIT, MIN_CREW, MIN_CAPTAINS, CARGO_LIMIT, MAX_CARGO, RECENT, BUSY, RESTRICTED];

const escapePattern = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// The recipe uses values, filters and inline sections. Fixed text must survive
// rendering; an inline section's text may be omitted when its condition is false.
function templateLinePattern(source) {
  const tags = /\{\{\{[^{}]*\}\}\}|\{\{[^{}]*\}\}/g;
  const parts = [];
  let from = 0;
  for (const match of source.matchAll(tags)) {
    parts.push({text: source.slice(from, match.index)});
    parts.push({tag: match[0].startsWith("{{{") ? match[0].slice(3, -3).trim() : match[0].slice(2, -2).trim()});
    from = match.index + match[0].length;
  }
  parts.push({text: source.slice(from)});
  if (parts.some((part) => part.tag !== undefined) &&
      parts.every((part) => part.tag === undefined ? !part.text.trim() : /^[#^/!>]/.test(part.tag))) {
    return null; // standalone control tags have no output line to compare
  }

  const render = (start, close) => {
    let pattern = "";
    for (let i = start; i < parts.length; i++) {
      const part = parts[i];
      if (part.text !== undefined) {
        pattern += escapePattern(part.text);
      } else if (part.tag.startsWith("/") && part.tag.slice(1) === close) {
        return {pattern, next: i + 1, closed: true};
      } else if (part.tag.startsWith("/") && close === undefined) {
        // A loop opened on a prior line can jump back before this suffix.
        // Only the prefix before its closing tag is mandatory here.
        return {pattern: pattern + ".*", next: parts.length, closed: false};
      } else if (part.tag.startsWith("#") || part.tag.startsWith("^")) {
        const name = part.tag.slice(1);
        const body = render(i + 1, name);
        if (body.closed) {
          pattern += `(?:${body.pattern})?`;
          i = body.next - 1;
        } else {
          // The remainder belongs to a section that may emit nothing on
          // this line; its closing tag and suffix are on a later line.
          return {pattern: pattern + ".*", next: parts.length, closed: false};
        }
      } else {
        // Values (including filtered/raw values), partials and unmatched tags.
        pattern += ".*";
      }
    }
    return {pattern, next: parts.length, closed: false};
  };
  return new RegExp(`^${render(0).pattern}$`);
}

function traceLineMismatch(entry, template, output) {
  const source = template[entry.template_line - 1];
  const rendered = output[entry.line - 1];
  if (source === undefined || rendered === undefined) return "line out of range";
  const pattern = templateLinePattern(source);
  // a line of section tags only emits no text of its own, so no output line
  // can come from it: an entry naming one is wrong (a whole sidecar pointed at
  // `{{/fields}}` used to pass)
  if (pattern === null) return `output line ${entry.line} names a tag-only template line ${entry.template_line}`;
  return pattern.test(rendered) ? null : `output ${JSON.stringify(rendered)} does not match template ${JSON.stringify(source)}`;
}

describe("DSL L2: a rule, its generated check, its examples and its derived cases", function () {
  this.timeout(180000);
  let scratch, registry;
  before(async () => {
    scratch = mkdtempSync(join(tmpdir(), "dsl-l2-test-"));
    registry = registryFor(DEFAULT_DDIC, []);
    // A fresh checkout has no optional navigation companions. Render them
    // without rewriting the committed code/traces checked by the suite.
    for (const rule of DEMO_RULES) {
      const {files} = await renderRule(compileRule(rule, {registry, out: OUT}));
      for (const [name, text] of Object.entries(files)) {
        const file = join(OUT, name);
        if (name.endsWith('.trace.meta.json') && !existsSync(file)) writeFileSync(file, text);
      }
    }
  });
  after(() => rmSync(scratch, {recursive: true, force: true}));

  // a copy of the committed rule with one line replaced
  const variant = (name, from, to) => {
    expect(RULE_TEXT, `the rule has ${from}`).to.include(from);
    const file = join(scratch, `${name}.l2.yaml`);
    writeFileSync(file, RULE_TEXT.replace(from, to));
    return file;
  };

  describe("generation", () => {
    for (const rule of DEMO_RULES) {
      it(`the committed files of ${basename(rule)} are a fresh build (the check command exits 0)`, () => {
        const run = spawnSync(process.execPath, ["tools/dsl-l2.mjs", "check", rule, "--out", OUT], {encoding: "utf8"});
        expect(run.status, run.stdout + run.stderr).to.equal(0);
        expect(run.stdout).to.contain("generated files match");
      });
    }

    it("every rule's class and test class trace to their current template lines", () => {
      const counts = {exact: 0, pattern: 0, tagOnly: 0};
      for (const rule of DEMO_RULES) {
        const name = compileRule(rule, {registry}).class;
        for (const kind of ["clas", "clas.testclasses"]) {
          const prefix = join(OUT, `${name}.${kind}`);
          const sidecar = readJSONFile(`${prefix}.trace.json`, "utf8");
          const template = readFileSync(sidecar.template, "utf8").split("\n");
          const output = readFileSync(`${prefix}.abap`, "utf8").split("\n");
          expect(sidecar.rule, `${name}.${kind} belongs to ${rule}`).to.equal(rule);
          expect(sidecar.lines.length, `${name}.${kind} traces every output line`).to.equal(output.length - 1);
          for (const [index, entry] of sidecar.lines.entries()) {
            expect(entry.line, `${name}.${kind} trace entry ${index + 1}`).to.equal(index + 1);
            const source = template[entry.template_line - 1];
            const rendered = output[entry.line - 1];
            expect(source, `${name}.${kind} output line ${entry.line} names template line ${entry.template_line}`).to.be.a("string");
            expect(rendered, `${name}.${kind} output line ${entry.line} exists`).to.be.a("string");
            const pattern = templateLinePattern(source);
            if (pattern === null) counts.tagOnly++;
            else if (source.includes("{{")) counts.pattern++;
            else counts.exact++;
            expect(traceLineMismatch(entry, template, output),
              `${name}.${kind} output line ${entry.line} from template line ${entry.template_line}`).to.equal(null);
          }
        }
      }
      expect(counts.exact).to.be.greaterThan(0);
      expect(counts.pattern).to.be.greaterThan(0);
      console.log(`L2 template trace: ${counts.exact} exact, ${counts.pattern} pattern, ${counts.tagOnly} tag-only lines`);
    });

    it("a sidecar template line shifted by one is rejected in memory", () => {
      const prefix = join(OUT, `${CLASS}.clas`);
      const sidecar = readJSONFile(`${prefix}.trace.json`, "utf8");
      const template = readFileSync(sidecar.template, "utf8").split("\n");
      const output = readFileSync(`${prefix}.abap`, "utf8").split("\n");
      const original = sidecar.lines[1]; // the rule/title line has two value holes
      expect(original).to.include({line: 2, template_line: 2});
      const mutant = {...original, template_line: original.template_line + 1};
      expect(traceLineMismatch(original, template, output)).to.equal(null);
      expect(traceLineMismatch(mutant, template, output),
        `shifted ${CLASS} output line ${original.line} to template line ${mutant.template_line}`).to.not.equal(null);
    });

    it("an entry pointed at a tag-only template line is rejected, so a faked sidecar cannot pass", () => {
      const prefix = join(OUT, `${CLASS}.clas.testclasses`);
      const sidecar = readJSONFile(`${prefix}.trace.json`, "utf8");
      const template = readFileSync(sidecar.template, "utf8").split("\n");
      const output = readFileSync(`${prefix}.abap`, "utf8").split("\n");
      const tagOnly = template.findIndex((line) => line.trim() !== "" && templateLinePattern(line) === null) + 1;
      expect(tagOnly, "the test-class template has a tag-only line").to.be.greaterThan(0);
      const faked = sidecar.lines.map((e) => ({...e, template_line: tagOnly}));
      const accepted = faked.filter((e) => traceLineMismatch(e, template, output) === null).length;
      expect(accepted, `entries accepted when every one names template line ${tagOnly}`).to.equal(0);
    });

    it("and the check notices one changed byte", async () => {
      const copy = join(scratch, "drift");
      mkdirSync(copy);
      for (const f of readdirSync(OUT).filter((f) => f.startsWith(`${CLASS}.`))) copyFileSync(join(OUT, f), join(copy, f));
      const file = join(copy, `${CLASS}.clas.abap`);
      writeFileSync(file, readFileSync(file, "utf8").replace("> iv_date", ">= iv_date"));
      expect(await checkRule(RULE, copy)).to.deep.equal([`${CLASS}.clas.abap: differs from a fresh build`]);
    });

    it("the compiler knows no domain words", () => {
      for (const file of ["tools/dsl-l2.mjs", "tools/dsl-l2-eval.mjs"]) {
        const source = readFileSync(file, "utf8");
        const hits = source.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /ship|voy/i.test(l));
        expect(hits, `${file} names the demo's domain`).to.deep.equal([]);
      }
    });
  });

  describe("driving-table ranges (range:)", () => {
    // the template with every range section taken out: what it was before
    // the range existed (`{{#range}}`, `{{#outer.range}}` and their inline forms)
    const withoutRange = (template) => readFileSync(template, "utf8")
      .replace(/^\{\{#(?:driving_keys|keys_check)\}\}\n[\s\S]*?^\{\{\/(?:driving_keys|keys_check)\}\}\n/gm, "")
      .replace(/^\{\{#(?:outer\.)?range\}\}\n[\s\S]*?^\{\{\/(?:outer\.)?range\}\}\n/gm, "")
      .replace(/\{\{#range\}\}[^\n]*?\{\{\/range\}\}/g, "");
    const at = (file, re) => readFileSync(file, "utf8").split("\n").findIndex((l) => re.test(l)) + 1;

    it("an empty range is every row; a range keeps the rows inside it, in the interpreter and in the SQL", () => {
      const model = compileRule(RULE, {registry});
      const rows = {zosd_l2_ship: ["S001", "S002", "S004"].map((ship_id) => ({ship_id, name: ship_id, status: "M"})),
        zosd_l2_voy: ["S001", "S002", "S004"].map((ship_id, i) => ({voyage_id: `V0000${i + 1}`, ship_id, dep_date: "20261005"}))};
      const ships = (range) => evaluate(model, rows, {date: "20261001", $range: range}).map((a) => a.slice(0, 4));
      expect(ships([])).to.deep.equal(["S001", "S002", "S004"]);
      expect(ships([{sign: "I", option: "BT", low: "S002", high: "S004"}])).to.deep.equal(["S002", "S004"]);
      expect(ships([{sign: "I", option: "EQ", low: "S001"}, {sign: "I", option: "EQ", low: "S004"}])).to.deep.equal(["S001", "S004"]);
      expect(ships([{sign: "I", option: "EQ", low: "S003"}])).to.deep.equal([]);
      const check = readFileSync(join(OUT, `${CLASS}.clas.abap`), "utf8");
      expect(check).to.include("                it_range TYPE tt_range OPTIONAL\n");
      expect(check).to.include("        AND ship~ship_id IN it_range\n");
      expect(check, "never a LOOP ... WHERE ... IN").to.not.match(/LOOP AT[^.]*\bIN\b/);
    });

    it("the range line traces to the rule's range: line", () => {
      const trace = readJSONFile(join(OUT, `${CLASS}.clas.trace.json`), "utf8");
      const lines = readFileSync(join(OUT, `${CLASS}.clas.abap`), "utf8").split("\n");
      const entry = trace.lines.find((e) => /IN it_range/.test(lines[e.line - 1]));
      expect(entry).to.include({node: "rule/maintenance-ship-no-future-voyage/range", rule_line: at(RULE, /^range:/)});
    });

    it("a rule without range: renders what the templates rendered before the range existed", async () => {
      const {renderModel} = await import("../tools/dsl-l2.mjs");
      const {renderRecipe} = await import("../tools/dsl-abap.mjs");
      for (const [rule, template, file] of [[RECENT, "recipes/l2-check/template.tpl", "clas.abap"],
        [RECENT, "recipes/l2-check-test/template.tpl", "clas.testclasses.abap"],
        [MIN_CAPTAINS, "recipes/l2-check/template.tpl", "clas.abap"], [MIN_CAPTAINS, "recipes/l2-check-test/template.tpl", "clas.testclasses.abap"]]) {
        const model = renderModel(compileRule(rule, {registry}));
        expect(model.range).to.equal(undefined);
        const stripped = join(scratch, `no-range-${basename(template)}`);
        writeFileSync(stripped, withoutRange(template));
        expect(readFileSync(stripped, "utf8"), "every range line sits in a range section").to.not.match(/range/);
        const before = (await renderRecipe(model, stripped)).text;
        expect(before, `${rule} ${file}`).to.equal((await renderRecipe(model, template)).text);
        expect(readFileSync(join(OUT, `${model.class}.${file}`), "utf8")).to.equal(before);
      }
    });

    it("an or at the top of when is parenthesised before the range is anded", async () => {
      const text = readFileSync(MIN_CREW, "utf8").replace("when: ship.status = 'A'", "when: ship.status = 'A' or ship.status = 'X'")
        .replace(/^class: .*$/m, "class: zcl_l2_range_or");
      const out = join(scratch, "range-or");
      await buildRule(writeRange("range-or", text), out, {registry});
      const check = readFileSync(join(out, "zcl_l2_range_or.clas.abap"), "utf8");
      const count = (text) => check.split(text).length - 1;
      // the for query (the range directly after the or) and the join query
      expect(count(["      WHERE ( ship~status = 'A'", "           OR ship~status = 'X' )", "        AND ship~ship_id IN it_range"].join("\n"))).to.equal(1);
      expect(count(["      WHERE ( ship~status = 'A'", "           OR ship~status = 'X' )", "        AND crew~since <= iv_date",
        "        AND ship~ship_id IN it_range"].join("\n"))).to.equal(1);
      expect(readFileSync(join(out, "zcl_l2_range_or.clas.testclasses.abap"), "utf8"))
        .to.include(["      WHERE ( status = 'A'", "           OR status = 'X' )", "        AND ship_id IN it_range"].join("\n"));
    });

    const writeRange = (name, text) => {
      const file = join(scratch, `${name}.l2.yaml`);
      writeFileSync(file, text);
      return file;
    };
    for (const [what, from, to, message, line] of [
      ["an alias other than the for alias", "range: ship.ship_id", "range: voy.ship_id", /range must name a field of the for alias ship/, /^range:/],
      ["a field the for table does not have", "range: ship.ship_id", "range: ship.colour", /range field ship\.colour is not a resolved field of ZOSD_L2_SHIP/, /^range:/],
      ["an EQ row with a high", "range: [{sign: I, option: BT, low: S002, high: S003}]", "range: [{sign: I, option: EQ, low: S002, high: S003}]",
        /an EQ range row has no high/, /^    range:/],
      ["sign E", "range: [{sign: I, option: BT, low: S002, high: S003}]", "range: [{sign: E, option: BT, low: S002, high: S003}]",
        /a range row is sign I with option EQ or BT/, /^    range:/],
      ["a low that does not fit the field", "range: [{sign: I, option: BT, low: S002, high: S003}]", "range: [{sign: I, option: BT, low: S00002, high: S003}]",
        /range low must fit ZOSD_L2_SHIP-ship_id/, /^    range:/],
      ["an example range in a rule without range:", "range: ship.ship_id\n", "", /an example range needs a range: line in the rule/, /^    range:/],
    ]) {
      it(`refuses ${what} at its line`, () => {
        const file = variant(`range-${what.replace(/\W+/g, "-")}`, from, to);
        expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${at(file, line)}: ${message.source}`));
      });
    }

    it("mutant: the range dropped from the WHERE fails the example whose range excludes a flagged ship", async () => {
      const file = variant("range-mutant", "class: zcl_l2_maintenance_ship", "class: zcl_l2_range_mutant");
      const {results} = await runRule(file, "zcl_l2_range_mutant", {mutate: {"clas.abap": [["        AND ship~ship_id IN it_range\n", ""]]}});
      expect(results.the_range_keeps_the_inner_ship).to.equal("failed");
      expect(failed(results)).to.deep.equal(["the_range_keeps_the_inner_ship"]);
    });
  });

  describe("keys: true, the driving keys a rule flags (L3 filter stages)", () => {
    const BUSY_TEXT = readFileSync(BUSY, "utf8");
    const BUSY_CLASS = "zcl_l2_ship_busy";
    const at = (file, re) => readFileSync(file, "utf8").split("\n").findIndex((l) => re.test(l)) + 1;
    const busyVariant = (name, from, to, text = BUSY_TEXT) => {
      expect(text, `the rule has ${from}`).to.include(from);
      const file = join(scratch, `${name}.l2.yaml`);
      writeFileSync(file, text.replace(from, to));
      return file;
    };
    // the templates with every keys section taken out: what they were before keys existed
    const withoutKeys = (template) => readFileSync(template, "utf8")
      .replace(/^\{\{#(?:driving_keys|keys_check)\}\}\n[\s\S]*?^\{\{\/(?:driving_keys|keys_check)\}\}\n/gm, "");

    it("the interpreter answers each flagged key once, sorted; the ABAP is the check's query, DISTINCT, never a SELECT per row", () => {
      const model = compileRule(BUSY, {registry});
      expect(model.driving_keys).to.include({table: "zosd_l2_ship", field: "ship_id", source: "ship~ship_id", rule_line: at(BUSY, /^keys:/)});
      const rows = {zosd_l2_ship: [["S004", "A"], ["S001", "A"], ["S002", "D"]].map(([ship_id, status]) => ({ship_id, name: ship_id, status})),
        zosd_l2_voy: [["V1", "S004"], ["V2", "S004"], ["V3", "S001"], ["V4", "S002"], ["V5", "S004"]].map(([voyage_id, ship_id]) => ({voyage_id, ship_id, dep_date: "20261005"}))};
      expect(evaluate(model, rows, {date: "20261001", $range: []})).to.have.length(4);
      expect(ruleKeys(model, rows, {date: "20261001", $range: []}, evaluate, compareValues)).to.deep.equal(["S001", "S004"]);
      expect(ruleKeys(model, rows, {date: "20261001", $range: [{sign: "I", option: "EQ", low: "S004"}]}, evaluate, compareValues)).to.deep.equal(["S004"]);
      const check = readFileSync(join(OUT, `${BUSY_CLASS}.clas.abap`), "utf8");
      const keys = check.slice(check.indexOf("  METHOD keys."));
      expect(keys).to.include("    SELECT DISTINCT ship~ship_id\n      FROM zosd_l2_ship AS ship\n        INNER JOIN zosd_l2_voy AS voy\n");
      expect(keys).to.include("        AND ship~ship_id IN it_range\n      ORDER BY ship~ship_id.\n    SORT lt_keys.\n    DELETE ADJACENT DUPLICATES FROM lt_keys.\n");
      expect(keys.match(/^ +SELECT\b/gm), "one query").to.have.length(1);
      expect(keys, "no SELECT inside a loop").to.not.match(/LOOP AT[\s\S]*SELECT/);
    });

    it("the keys method traces to the rule's keys: line, its query to the rule's own lines", () => {
      const trace = readJSONFile(join(OUT, `${BUSY_CLASS}.clas.trace.json`), "utf8");
      const lines = readFileSync(join(OUT, `${BUSY_CLASS}.clas.abap`), "utf8").split("\n");
      const of = (re) => trace.lines.find((e) => re.test(lines[e.line - 1]));
      expect(of(/^  METHOD keys\.$/)).to.include({node: "rule/ship-busy/keys", rule_line: at(BUSY, /^keys:/)});
      expect(of(/^    CLASS-METHODS keys$/)).to.include({node: "rule/ship-busy/keys", rule_line: at(BUSY, /^keys:/)});
      expect(of(/SELECT DISTINCT/).rule_line).to.be.within(1, BUSY_TEXT.split("\n").length);
      const tests = readJSONFile(join(OUT, `${BUSY_CLASS}.clas.testclasses.trace.json`), "utf8");
      const testLines = readFileSync(join(OUT, `${BUSY_CLASS}.clas.testclasses.abap`), "utf8").split("\n");
      const given = tests.lines.filter((e) => /=>keys\(/.test(testLines[e.line - 1]));
      expect(given.length, "every test asserts keys( )").to.be.greaterThan(5);
      expect(given.find((e) => e.node === "rule/ship-busy/example/several voyages one key/keys"))
        .to.include({rule_line: at(BUSY, /expect_keys: \[S001, S003\]/)});
    });

    it("a rule without keys: renders what the templates rendered before keys existed", async () => {
      const {renderModel} = await import("../tools/dsl-l2.mjs");
      const {renderRecipe} = await import("../tools/dsl-abap.mjs");
      for (const rule of [RULE, REQUIRE, LIMIT, RECENT]) {
        for (const [template, file] of [["recipes/l2-check/template.tpl", "clas.abap"], ["recipes/l2-check-test/template.tpl", "clas.testclasses.abap"]]) {
          const model = renderModel(compileRule(rule, {registry}));
          expect(model.driving_keys).to.equal(undefined);
          const stripped = join(scratch, `no-keys-${basename(template)}`);
          writeFileSync(stripped, withoutKeys(template));
          expect(readFileSync(stripped, "utf8"), "every keys line sits in a keys section").to.not.match(/driving_keys|keys_check|=>keys|METHOD keys/);
          const before = (await renderRecipe(model, stripped)).text;
          expect((await renderRecipe(model, template)).text, `${rule} ${file}`).to.equal(before);
          expect(readFileSync(join(OUT, `${model.class}.${file}`), "utf8")).to.equal(before);
        }
      }
    });

    it("the generated tests pass: every example and derived case asserts keys( ) beside check( )", async () => {
      const file = busyVariant("keys-green", `class: ${BUSY_CLASS}`, "class: zcl_l2_keys_green");
      const {results, messages, model} = await runRule(file, "zcl_l2_keys_green");
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.length).to.be.greaterThan(2);
      expect([...model.examples, ...model.cases].every((t) => t.keys_check)).to.equal(true);
    });

    it("mutant: keys( ) returning duplicates fails the example whose ship is flagged by three voyages", async () => {
      const file = busyVariant("keys-dupes", `class: ${BUSY_CLASS}`, "class: zcl_l2_keys_dupes");
      const {results} = await runRule(file, "zcl_l2_keys_dupes", {mutate: {"clas.abap": [
        ["    SELECT DISTINCT ship~ship_id\n", "    SELECT ship~ship_id\n"], ["    DELETE ADJACENT DUPLICATES FROM lt_keys.\n", ""]]}});
      expect(results.several_voyages_one_key).to.equal("failed");
      expect(results.the_range_keeps_the_inner_ship).to.equal("failed");
      expect(results.a_voyage_ahead).to.equal("passed");
    });

    for (const [what, from, to, message, line] of [
      ["keys that are not true or false", "\nkeys: true\n", "\nkeys: yes\n", /keys is true or false, not "yes"/, /^keys:/],
      ["keys without a range: line", "range: ship.ship_id\n", "", /keys: true needs a range: line/, /^keys:/],
      ["expect_keys that the rule does not flag", "    expect_keys: [S001, S003]", "    expect_keys: [S003, S001]", /expect_keys \["S003","S001"\], but the rule flags \["S001","S003"\]/, /expect_keys: \[S003, S001\]/],
      ["expect_keys in a rule without keys: true", "\nkeys: true\n", "\n", /expect_keys needs keys: true in the rule/, /expect_keys: \[S001\]$/],
    ]) {
      it(`refuses ${what} at its line`, () => {
        const file = busyVariant(`keys-${what.replace(/\W+/g, "-")}`, from, to);
        const want = at(file, line);
        expect(want).to.be.greaterThan(0);
        expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${want}: ${message.source}`));
      });
    }
    it("refuses keys: true on a limit: rule, whose threshold is decided over the ordered rows", () => {
      const text = readFileSync(LIMIT, "utf8").replace("range: ship.ship_id\n", "range: ship.ship_id\nkeys: true\n");
      const file = join(scratch, "keys-limit.l2.yaml");
      writeFileSync(file, text);
      expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${at(file, /^keys:/)}: keys: true is for a forbid: or require: rule`));
    });
  });

  describe("parameter types a class and a report accept (A4H 2026-10-02: ZL3_FLEET, \"Lengths must be specified explicitly\")", () => {
    const CAPTAIN = readFileSync(REQUIRE, "utf8");
    const at = (file) => readFileSync(file, "utf8").split("\n").findIndex((l) => /^  active_status:/.test(l)) + 1;
    const captain = (name, type) => {
      const file = join(scratch, `${name}.l2.yaml`);
      writeFileSync(file, CAPTAIN.replace("active_status: {type: ZOSD_L2_SHIP-STATUS, default: A}", `active_status: {type: ${type}, default: A}`));
      return file;
    };
    for (const bare of ["C", "c", "N", "P", "X"]) {
      it(`refuses a bare ${bare} at its line`, () => {
        const file = captain(`bare-${bare}`, bare);
        expect(() => compileRule(file, {registry})).to.throw(RuleError,
          new RegExp(`:${at(file)}: parameter \\$active_status type ${bare.toUpperCase()} has no length, which a class or report refuses`));
      });
    }
    it("a table field types the parameter as the field is typed, and the ABAP names it as written", () => {
      const model = compileRule(REQUIRE, {registry});
      expect(model.params.map((p) => [p.type_name, p.type])).to.deep.equal([["zosd_l2_ship-status", {built_in: "CHAR", length: 1}]]);
      expect(readFileSync(join(OUT, "zcl_l2_ship_captain.clas.abap"), "utf8")).to.include("iv_active_status TYPE zosd_l2_ship-status DEFAULT 'A'");
      expect(readFileSync(join(OUT, "zcl_l2_ship_captain.clas.testclasses.abap"), "utf8")).to.include("iv_active_status TYPE zosd_l2_ship-status DEFAULT 'A'");
    });
    it("refuses a field the table does not have", () => {
      const file = captain("no-field", "ZOSD_L2_SHIP-COLOUR");
      expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${at(file)}: parameter \\$active_status type ZOSD_L2_SHIP-COLOUR cannot resolve`));
    });
  });

  describe("type errors name the rule file and line", () => {
    const cases = [
      ["a date compared with a CHAR literal", "voy.dep_date > $date", "voy.dep_date > 'M'",
        /^voy\.dep_date is DATS 8; 'M' is not a date/, /^\s+where:/],
      ["a CHAR literal longer than its field", "ship.status = 'M'", "ship.status = 'MM'",
        /^ship.status is CHAR 1; 'MM' is 2 characters, longer than CHAR 1/, /^when:/],
      ["an unknown field", "ship.status = 'M'", "ship.colour = 'M'",
        /^ZOSD_L2_SHIP has no field COLOUR/, /^when:/],
      ["an unknown table", "for: ZOSD_L2_SHIP as ship", "for: ZOSD_L2_NOPE as ship",
        /^table ZOSD_L2_NOPE is not in the DDIC given/, /^for:/],
      ["a hole naming an undeclared alias", "{ship.name}", "{crew.name}",
        /^unknown alias crew/, /^alert:/],
      ["an alias out of scope in when", "when: ship.status = 'M'", "when: voy.ship_id = 'S001'",
        /^alias voy is not in scope here/, /^when:/],
      ["a comparison without an operator", "ship.status = 'M'", "ship.status 'M'",
        /^expected a comparison operator/, /^when:/],
      ["an example row value that does not fit", "{ship_id: S001, name: Albatross, status: M}]\n      ZOSD_L2_VOY: [{voyage_id: V00001",
        "{ship_id: S001, name: Albatross, status: MX}]\n      ZOSD_L2_VOY: [{voyage_id: V00001",
        /^ZOSD_L2_SHIP-STATUS is CHAR 1; 'MX' is 2 characters/, /^\s+ZOSD_L2_SHIP: \[\{ship_id: S001/],
    ];
    cases.forEach(([what, from, to, message, at], i) => {
      it(what, () => {
        const file = variant(`error${i}`, from, to);
        const where = relative(process.cwd(), file).split(sep).join("/");
        const line = readFileSync(file, "utf8").split("\n").findIndex((l) => at.test(l)) + 1;
        let error;
        try {
          compileRule(file, {registry});
        } catch (e) {
          error = e;
        }
        expect(error, "an error").to.be.instanceOf(RuleError);
        expect(error.message.startsWith(`${where}:${line}: `), error.message).to.equal(true);
        expect(error.message.slice(`${where}:${line}: `.length)).to.match(message);
      });
    });
  });

  describe("a rule carries its proof", () => {
    const refused = (name, text, message, at) => {
      const file = join(scratch, `${name}.l2.yaml`);
      writeFileSync(file, text);
      const where = relative(process.cwd(), file).split(sep).join("/");
      const line = text.split("\n").findIndex((l) => at.test(l)) + 1;
      expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`^${where.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${line}: ${message}`));
    };
    const head = RULE_TEXT.slice(0, RULE_TEXT.indexOf("examples:"));

    it("no examples key", () => refused("no-examples", head, "a rule needs examples", /^rule:/));
    it("an empty list of examples", () => refused("empty-examples", `${head}examples: []\n`, "a rule needs at least one example", /^examples:/));
    it("an example without expect", () => {
      const from = "    expect: []\n  - name: departs on the check date";
      expect(RULE_TEXT).to.include(from);
      refused("no-expect", RULE_TEXT.replace(from, "  - name: departs on the check date"),
        "example \"past voyage is fine\" has no expect", /^\s+- name: past voyage is fine/);
    });
  });

  describe("the rule's header and its boundaries", () => {
    const refused = (name, from, to, message, at) => {
      const file = variant(name, from, to);
      const where = relative(process.cwd(), file).split(sep).join("/");
      const text = readFileSync(file, "utf8");
      const line = text.split("\n").findIndex((l) => at.test(l)) + 1;
      let error;
      try {
        compileRule(file, {registry});
      } catch (e) {
        error = e;
      }
      expect(error, "an error").to.be.instanceOf(RuleError);
      expect(error.message.startsWith(`${where}:${line}: `), error.message).to.equal(true);
      expect(error.message.slice(`${where}:${line}: `.length)).to.match(message);
    };

    it("a class that is not text is a RuleError at its line", () =>
      refused("class-list", "class: zcl_l2_maintenance_ship", "class: [zcl_a, zcl_b]", /^class must be a class name/, /^class:/));
    it("a class mapping too", () =>
      refused("class-map", "class: zcl_l2_maintenance_ship", "class: {name: zcl_a}", /^class must be a class name/, /^class:/));
    it("a title over several lines is a RuleError at its line", () =>
      refused("title-lines", "title: A ship in maintenance has no voyage departing after the check date",
        "title: |\n  A ship in maintenance\n  has no voyage", /^title must be one line/, /^title:/));
    it("boundaries names a condition that is not there", () =>
      refused("boundaries-unknown", "boundaries: auto", "boundaries: [when/1, when/9]",
        /^boundaries names "when\/9", which is not a condition of the rule \(when\/1, forbid\/where\/1, forbid\/where\/2\)/, /^boundaries:/));
    it("boundaries is auto or a list", () =>
      refused("boundaries-word", "boundaries: auto", "boundaries: sometimes", /^boundaries is auto or a list of conditions/, /^boundaries:/));

    it("a list selects: two conditions give their own cases and the structural two", () => {
      const file = variant("boundaries-list", "boundaries: auto", "boundaries: [when/1, forbid/where/2]");
      const model = compileRule(file, {registry});
      expect(model.cases.map((c) => c.method)).to.deep.equal(["b_status_eq", "b_status_ne", "b_status_blank",
        "b_dep_date_lt", "b_dep_date_eq", "b_dep_date_gt", "b_exists_zero", "b_exists_two"]);
    });

    it("without boundaries there are the examples only", () => {
      const file = variant("no-boundaries", "boundaries: auto\n", "");
      const model = compileRule(file, {registry});
      expect(model.cases).to.deep.equal([]);
    });
  });

  describe("trace", () => {
    let abap, trace;
    before(() => {
      abap = readFileSync(join(OUT, `${CLASS}.clas.abap`), "utf8").split("\n");
      trace = readJSONFile(join(OUT, `${CLASS}.clas.trace.json`), "utf8");
    });
    const entry = (re) => {
      const line = abap.findIndex((l) => re.test(l)) + 1;
      expect(line, `a line matching ${re}`).to.be.greaterThan(0);
      return trace.lines.find((e) => e.line === line);
    };

    it("every output line goes to a template line, an L1 node and a rule line", () => {
      expect(trace.lines.length).to.equal(abap.length - 1);
      for (const e of trace.lines) {
        expect(e.template_line, JSON.stringify(e)).to.be.greaterThan(0);
        expect(e.node, JSON.stringify(e)).to.match(/^rule\/maintenance-ship-no-future-voyage/);
        expect(e.rule_line, JSON.stringify(e)).to.be.greaterThan(0);
      }
    });

    it("the dep_date condition traces to the rule's where line", () => {
      const e = entry(/AND voy~dep_date > iv_date$/);
      expect(e).to.include({node: "rule/maintenance-ship-no-future-voyage/forbid/where/2", rule_line: ruleLine(/^\s+where:/)});
    });

    it("the JOIN's ON and WHERE lines trace to their conditions and rule lines", () => {
      expect(entry(/ON voy~ship_id = ship~ship_id$/)).to.include({
        node: "rule/maintenance-ship-no-future-voyage/forbid/where/1", rule_line: ruleLine(/^\s+where:/)});
      expect(entry(/WHERE ship~status = 'M'$/)).to.include({
        node: "rule/maintenance-ship-no-future-voyage/when/1", rule_line: ruleLine(/^when:/)});
      expect(entry(/INNER JOIN zosd_l2_voy AS voy$/)).to.include({rule_line: ruleLine(/^forbid:/)});
    });

    it("the alert text traces to the rule's alert line", () => {
      const e = entry(/`: in maintenance, voyage `/);
      expect(e.node).to.match(/\/alert\/text\/\d+$/);
      expect(e.rule_line).to.equal(ruleLine(/^alert:/));
    });
  });

  describe("trace of the test class", () => {
    let abap, trace;
    before(() => {
      abap = readFileSync(join(OUT, `${CLASS}.clas.testclasses.abap`), "utf8").split("\n");
      trace = readJSONFile(join(OUT, `${CLASS}.clas.testclasses.trace.json`), "utf8");
    });
    const ruleLineOf = (re) => {
      const line = abap.findIndex((l) => re.test(l)) + 1;
      expect(line, `a line matching ${re}`).to.be.greaterThan(0);
      return trace.lines.find((e) => e.line === line).rule_line;
    };

    it("each example's check call traces to that example's date line", () => {
      const calls = abap.map((l, i) => [i + 1, l]).filter(([, l]) => /=>check\( iv_date = '\d{8}'(?: it_range = lt_range)? \)/.test(l));
      const dates = RULE_TEXT.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => /^\s+date: /.test(l));
      const names = [...RULE_TEXT.matchAll(/- name: (.+)/g)].map((m) => m[1]);
      expect(calls.length).to.equal(16);
      expect(dates.length).to.equal(6);
      calls.slice(0, 6).forEach(([line], k) => {
        expect(trace.lines.find((e) => e.line === line)).to.include({
          node: `rule/maintenance-ship-no-future-voyage/example/${names[k]}/date`, rule_line: dates[k][0]});
      });
    });

    it("each derived case traces to the rule line of its condition", () => {
      const at = (re) => {
        const line = abap.findIndex((l) => re.test(l)) + 1;
        expect(line, `a line matching ${re}`).to.be.greaterThan(0);
        return trace.lines.find((e) => e.line === line);
      };
      const lines = {status: ruleLine(/^when:/), where: ruleLine(/^\s+where:/), exists: ruleLine(/^\s+exists:/)};
      for (const [method, rule_line] of [["b_status_eq", lines.status], ["b_status_blank", lines.status],
        ["b_ship_id_nomatch", lines.where], ["b_dep_date_eq", lines.where], ["b_exists_zero", lines.exists], ["b_exists_two", lines.exists]]) {
        expect(at(new RegExp(`^  METHOD ${method}\\.$`))).to.include({rule_line});
        expect(at(new RegExp(`^    METHODS ${method} FOR TESTING\\.$`))).to.include({rule_line});
      }
      expect(at(/^  METHOD b_dep_date_eq\.$/).node).to.equal("rule/maintenance-ship-no-future-voyage/case/b_dep_date_eq");
    });

    it("a table's declaration and teardown trace to where the table enters the rule", () => {
      const forLine = ruleLine(/^for:/), existsLine = ruleLine(/^\s+exists:/);
      expect(ruleLineOf(/DATA mt_zosd_l2_ship TYPE/)).to.equal(forLine);
      expect(ruleLineOf(/DELETE zosd_l2_ship FROM TABLE/)).to.equal(forLine);
      expect(ruleLineOf(/DATA mt_zosd_l2_voy TYPE/)).to.equal(existsLine);
      expect(ruleLineOf(/DELETE zosd_l2_voy FROM TABLE/)).to.equal(existsLine);
    });
  });

  // two fixture tables of integer and packed fields, built into a DDIC folder of
  // the test's own (nothing of it is in the system's tree)
  const dtel = (name, type, length, decimals) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_DTEL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DD04V><ROLLNAME>${name}</ROLLNAME><DATATYPE>${type}</DATATYPE><LENG>${String(length).padStart(6, "0")}</LENG><DECIMALS>${String(decimals).padStart(6, "0")}</DECIMALS></DD04V></asx:values></asx:abap>
</abapGit>
`;
  const field = (name, inner) => `<DD03P><FIELDNAME>${name}</FIELDNAME>${inner}</DD03P>`;
  const tableXml = (name, fields) => `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V><TABNAME>${name}</TABNAME><DDLANGUAGE>E</DDLANGUAGE><TABCLASS>TRANSP</TABCLASS><CLIDEP>X</CLIDEP></DD02V>
   <DD03P_TABLE>${[
    field("MANDT", "<KEYFLAG>X</KEYFLAG><ROLLNAME>MANDT</ROLLNAME><NOTNULL>X</NOTNULL><COMPTYPE>E</COMPTYPE>"),
    ...fields,
  ].join("")}</DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`;
  const key = (name) => field(name, "<KEYFLAG>X</KEYFLAG><INTTYPE>C</INTTYPE><INTLEN>000008</INTLEN><NOTNULL>X</NOTNULL><DATATYPE>CHAR</DATATYPE><LENG>000004</LENG>");
  const keyInt = (name) => field(name, "<KEYFLAG>X</KEYFLAG><ROLLNAME>ZOSD_L2_T_I1</ROLLNAME><NOTNULL>X</NOTNULL><COMPTYPE>E</COMPTYPE>");
  const elem = (name, rollname) => field(name, `<ROLLNAME>${rollname}</ROLLNAME><COMPTYPE>E</COMPTYPE>`);
  const typed = (name, type, length) => field(name, `<DATATYPE>${type}</DATATYPE><LENG>${String(length).padStart(6, "0")}</LENG>`);
  const FIXTURE = {
    "zosd_l2_numa.tabl.xml": tableXml("ZOSD_L2_NUMA", [key("ID"), elem("LVL", "ZOSD_L2_T_I1"), typed("N4", "NUMC", 4), typed("CODE", "CHAR", 10)]),
    "zosd_l2_numb.tabl.xml": tableXml("ZOSD_L2_NUMB", [key("ID"), keyInt("SEQ"), elem("AMT", "ZOSD_L2_T_DEC"), elem("CNT", "ZOSD_L2_T_I1"),
      typed("N6", "NUMC", 6), typed("C4", "CHAR", 4)]),
    "zosd_l2_t_i1.dtel.xml": dtel("ZOSD_L2_T_I1", "INT1", 3, 0),
    "zosd_l2_t_dec.dtel.xml": dtel("ZOSD_L2_T_DEC", "DEC", 5, 2),
  };
  const fixtureDdic = () => {
    const ddic = join(scratch, "num-ddic");
    mkdirSync(ddic, {recursive: true});
    for (const [name, text] of Object.entries(FIXTURE)) writeFileSync(join(ddic, name), text);
    return ddic;
  };

  describe("integer ranges and packed precision (fixture tables)", () => {
    const RULE_NUM = `rule: numeric-fixture
class: zcl_l2_numeric_fixture
title: numeric fixture
for: ZOSD_L2_NUMA as n
when: n.lvl = 3
forbid:
  exists: ZOSD_L2_NUMB as m
  where: m.id = n.id and m.amt > 12.5
alert: "{n.id} {m.amt}"
examples:
  - name: one
    date: 20261001
    rows:
      ZOSD_L2_NUMA: [{id: A001, lvl: 3}]
      ZOSD_L2_NUMB: [{id: A001, seq: 1, amt: 999.99, cnt: 0}]
    expect: ["A001 999.99"]
`;
    let numRegistry;
    before(() => {
      numRegistry = registryFor([fixtureDdic(), ".local/lars/open-abap-core/src"], []);
    });
    const numRule = (name, from, to) => {
      expect(RULE_NUM).to.include(from);
      const file = join(scratch, `${name}.l2.yaml`);
      writeFileSync(file, RULE_NUM.replace(from, to));
      return file;
    };

    it("the fixture rule compiles, with the DDIC types on its literals", () => {
      const model = compileRule(numRule("num-ok", "", ""), {registry: numRegistry});
      expect(model.when.conditions[0]["value@type"]).to.deep.equal({built_in: "INT1"});
      expect(model.clauses[0].conditions[1]["value@type"]).to.deep.equal({built_in: "DEC", length: 5, decimals: 2});
    });

    const cases = [
      ["INT1 above 255", "n.lvl = 3", "n.lvl = 256", /^n\.lvl is INT1; 256 is out of range for INT1/, /^when:/],
      ["INT1 below 0", "n.lvl = 3", "n.lvl = -1", /^n\.lvl is INT1; -1 is out of range for INT1/, /^when:/],
      ["DEC 5,2 with four integer digits", "m.amt > 12.5", "m.amt > 1000", /^m\.amt is DEC 5,2; 1000 exceeds the precision of DEC 5,2/, /^\s+where:/],
      ["DEC 5,2 with three decimals", "m.amt > 12.5", "m.amt > 1.234", /^m\.amt is DEC 5,2; 1\.234 exceeds the precision of DEC 5,2/, /^\s+where:/],
      ["an example row out of INT1 range", "lvl: 3}", "lvl: 300}", /^ZOSD_L2_NUMA-LVL is INT1; 300 is out of range/, /^\s+ZOSD_L2_NUMA: \[/],
      ["an example row beyond DEC precision", "amt: 999.99", "amt: 1000.00", /^ZOSD_L2_NUMB-AMT is DEC 5,2; 1000\.00 exceeds the precision/, /^\s+ZOSD_L2_NUMB: \[/],
      ["the same table for and exists", "exists: ZOSD_L2_NUMB as m", "exists: ZOSD_L2_NUMA as m", /^for and exists are both ZOSD_L2_NUMA/, /^\s+exists:/],
    ];
    cases.forEach(([what, from, to, message, at], i) => {
      it(what, () => {
        const file = numRule(`num${i}`, from, to);
        const where = relative(process.cwd(), file).split(sep).join("/");
        const line = readFileSync(file, "utf8").split("\n").findIndex((l) => at.test(l)) + 1;
        let error;
        try {
          compileRule(file, {registry: numRegistry});
        } catch (e) {
          error = e;
        }
        expect(error, "an error").to.be.instanceOf(RuleError);
        expect(error.message.startsWith(`${where}:${line}: `), error.message).to.equal(true);
        expect(error.message.slice(`${where}:${line}: `.length)).to.match(message);
      });
    });
  });

  describe("the compiler's literal check agrees with the engine's literal filter", () => {
    const long = (n, c = "a") => c.repeat(n);
    const BOUNDARIES = [
      [{built_in: "INT1"}, ["0", "255", "256", "-0", "-1", "007", "1.5", "", "x"]],
      [{built_in: "INT2"}, ["32767", "32768", "-32768", "-32769"]],
      [{built_in: "INT4"}, ["2147483647", "2147483648", "-2147483648", "-2147483649", "00002147483647"]],
      [{built_in: "INT8"}, ["9223372036854775807", "9223372036854775808", "-9223372036854775808", "-9223372036854775809"]],
      [{built_in: "DEC", length: 5, decimals: 2}, ["999.99", "1000", "-999.99", "0.12", "0.123", "00123.45", "12.30", "1e3", "", "12."]],
      [{built_in: "DEC", length: 2, decimals: 2}, ["0.12", "1.2", "0", "00.99"]],
      [{built_in: "QUAN", length: 3, decimals: 0}, ["999", "1000", "1.0"]],
      [{built_in: "CHAR", length: 3}, ["abc", "abcd", "", "a'b"]],
      [{built_in: "CHAR", length: 300}, [long(255), long(256), long(128, "'"), long(127, "'")]],
      [{built_in: "NUMC", length: 4}, ["0012", "12a", "", "12345"]],
      [{built_in: "DATS", length: 8}, ["20261001", "2026100", "2026100a"]],
      [{built_in: "TIMS", length: 6}, ["235959", "23595"]],
      [{built_in: "STRG"}, ["x", long(255), long(256), long(128, "`"), "a\nb", "a\rb"]],
      [{built_in: "SSTR", length: 3}, ["abc", "abcd"]],
      [{built_in: "RAW", length: 2}, ["0a1b", "0a1", "0a1b2c", "zz", ""]],
    ];

    it("accepts and refuses the same boundary values", async () => {
      await import("./start.mjs");
      await import("../output/zcl_osd_tpl.clas.mjs");
      await import("../output/zcl_ajson.clas.mjs");
      const abap = globalThis.abap;
      const box = (value) => new abap.types.String().set(value);
      const disagreements = [];
      let count = 0;
      for (const [type, values] of BOUNDARIES) {
        for (const value of values) {
          const json = await abap.Classes.ZCL_AJSON.parse({iv_json: box(JSON.stringify({v: value, "v@type": type}))});
          let engine = true;
          try {
            await abap.Classes.ZCL_OSD_TPL.render({iv_template: box("{{v | literal}}"), ii_data: json});
          } catch (error) {
            if (!error.text?.get) throw error;
            engine = false;
          }
          const compiler = misfit(value, type) === undefined;
          count++;
          if (engine !== compiler) disagreements.push(`${JSON.stringify(type)} ${JSON.stringify(value)}: engine ${engine}, compiler ${compiler}`);
        }
      }
      expect(count).to.be.greaterThan(60);
      expect(disagreements).to.deep.equal([]);
    });
  });

  // A rule copy is built under its own class name, its generated files edited
  // as `mutate` says ({"clas.abap": [[from, to]]}; an edit that finds nothing
  // fails the test), transpiled alone and run in this process: which methods
  // fail, and with what message, says what the tests prove. `fixture` names
  // tables that are not in the system: their DDIC files and CREATE TABLE.
  const FLEET = ["zosd_l2_ship.tabl.xml", "zosd_l2_voy.tabl.xml", "zosd_l2_crew.tabl.xml",
    "zosd_l2_cargo.tabl.xml", "zosd_l2_weight.dtel.xml", "zosd_l2_days.dtel.xml"];
  async function loadRule(file, className, {ruleRegistry = registry, tables = FLEET,
    tableDir = OUT, mutate = {}, transform = {}} = {}) {
    const out = join(scratch, basename(file, ".l2.yaml"));
    const {model} = await buildRule(file, out, {registry: ruleRegistry});
    expect(model.class).to.equal(className);
    for (const [suffix, change] of Object.entries(transform)) {
      const target = join(out, `${className}.${suffix}`);
      const before = readFileSync(target, "utf8");
      const after = change(before);
      expect(after, `${suffix} changed by the transform`).to.not.equal(before);
      writeFileSync(target, after);
    }
    for (const [suffix, edits] of Object.entries(mutate)) {
      const target = join(out, `${className}.${suffix}`);
      let text = readFileSync(target, "utf8");
      for (const [from, to] of edits) {
        expect(text, `${suffix} holds ${from}`).to.include(from);
        text = text.replace(from, to);
      }
      writeFileSync(target, text);
    }
    const {Transpiler, core} = modulesOf(process.cwd());
    const reg = new core.Registry();
    for (const f of readdirSync(out).filter((f) => /\.clas\.(abap|testclasses\.abap|xml)$/.test(f))) {
      reg.addFile(new core.MemoryFile(f, readFileSync(join(out, f), "utf8")));
    }
    for (const f of tables) reg.addFile(new core.MemoryFile(f, readFileSync(join(tableDir, f), "utf8")));
    for (const p of ["ddic/dtel/mandt.dtel.xml", "ddic/ttyp/string_table.ttyp.xml"]) {
      reg.addDependency(new core.MemoryFile(basename(p), readFileSync(join(".local/lars/open-abap-core/src", p), "utf8")));
    }
    const config = JSON.parse(readFileSync("abap_transpile.json", "utf8"));
    const output = await new Transpiler({...config.options, unknownTypes: "runtimeError", ignoreSourceMap: true, skip: []}).run(reg);
    const own = new Set(output.objects.map((o) => o.filename));
    const outputDir = pathToFileURL(join(process.cwd(), "output") + sep).href;
    for (const o of output.objects.filter((o) => o.object.type === "CLAS")) {
      // what the class does not bring itself comes from the built system
      const code = o.chunk.getCode().replace(/import\("\.\/([^"]+)"\)/g, (m, name) => own.has(name) ? m : `import("${outputDir}${name}")`);
      writeFileSync(join(out, o.filename), code);
    }
    return {model, out, output};
  }
  async function runRule(file, className, {fixture = false, ...options} = {}) {
    const {model, out, output} = await loadRule(file, className, options);
    const db = globalThis.abap.context.databaseConnections.DEFAULT;
    const created = [];
    if (fixture) {
      for (const statement of output.databaseSetup.schemas.sqlite) {
        const name = /CREATE TABLE\s+'?(\w+)/i.exec(statement)?.[1];
        if (Array.isArray(fixture) && !fixture.includes(name?.toLowerCase())) continue;
        if (name) { await db.execute(statement); created.push(name); }
      }
    }
    try {
      const module = await import(pathToFileURL(join(out, `${className}.clas.testclasses.mjs`)).href);
      const results = {}, messages = {};
      for (const method of [...model.examples, ...model.cases].map((e) => e.method)) {
        const test = await new module.ltcl_examples().constructor_();
        try {
          await test.FRIENDS_ACCESS_INSTANCE[method]();
          results[method] = "passed";
        } catch (error) {
          results[method] = "failed";
          messages[method] = `${error?.msg?.get?.() ?? error?.message ?? error}\n${error?.stack ?? ""}`;
        } finally {
          await test.FRIENDS_ACCESS_INSTANCE.teardown();
        }
      }
      return {model, out, results, messages};
    } finally {
      for (const name of created) await db.execute(`DROP TABLE '${name}'`);
    }
  }
  const failed = (results) => Object.entries(results).filter(([, r]) => r === "failed").map(([m]) => m).sort();

  // A database may return the joined rows of one key apart (the ORDER BY is a
  // request, and the generated code must not lean on it). The shuffle moves the
  // first joined row to the end, right after the SELECT: with two rows for the
  // first key and another key behind them, the first key's rows are no longer
  // adjacent. The generated SORT puts them back; without it the loop must fail.
  const SORT_JOIN = "    SORT lt_join BY ship_ship_id.\n";
  const SHUFFLE = "    DATA ls_first LIKE LINE OF lt_join.\n    READ TABLE lt_join INTO ls_first INDEX 1.\n    IF sy-subrc = 0.\n      DELETE lt_join INDEX 1.\n      APPEND ls_first TO lt_join.\n    ENDIF.\n";
  const interleaving = (copyRule, source, tag, text = readFileSync(source, "utf8")) => {
    it(`${tag}: the loop does not depend on the database's row order (ORDER BY stays, SORT restores adjacency)`, async () => {
      const generated = readFileSync(join(OUT, `zcl_l2_${basename(source, ".l2.yaml")}.clas.abap`), "utf8");
      expect(generated).to.include("      ORDER BY\n        ship~ship_id.\n" + SORT_JOIN);
      const green = copyRule(`${tag}_shuf`, text);
      const ok = await runRule(green.file, green.className, {transform: {"clas.abap": (s) => s.replace(SORT_JOIN, SHUFFLE + SORT_JOIN)}});
      expect(failed(ok.results), JSON.stringify(ok.messages)).to.deep.equal([]);
      const red = copyRule(`${tag}_nosort`, text);
      const bad = await runRule(red.file, red.className, {transform: {"clas.abap": (s) => s.replace(SORT_JOIN, SHUFFLE)}});
      expect(failed(bad.results), "the loop fails when the rows of a key are apart").to.not.deep.equal([]);
    });
  };

  describe("slice 4: count thresholds", () => {
    before(async () => { await import("./start.mjs"); });
    const text = readFileSync(LIMIT, "utf8");
    const copy = (tag, source) => {
      const className = `zcl_l2_count_${tag}`;
      const file = join(scratch, `${tag}.l2.yaml`);
      writeFileSync(file, source.replace(/^class: .*$/m, `class: ${className}`));
      return {file, className};
    };
    const rows = (c) => Object.fromEntries(c.tables.map((t) => [t.table,
      t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));

    it("the committed rule runs its examples and all eleven derived cases, including two groups", async () => {
      const {model, results, messages} = await runRule(LIMIT, "zcl_l2_ship_voyage_limit");
      expect(Object.keys(results)).to.have.length(20);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      const groups = model.cases.find((c) => c.method === "b_count_groups");
      expect(groups).to.exist;
      expect(rows(groups).zosd_l2_ship).to.have.length(2);
      expect(rows(groups).zosd_l2_ship.map((ship) =>
        rows(groups).zosd_l2_voy.filter((voy) => voy.ship_id === ship.ship_id).length)).to.deep.equal([3, 2]);
      expect(groups.expect).to.have.length(1);
      for (const c of model.cases) {
        const discriminates = c.method === "b_count_groups" ? true : c.derived.condition.startsWith("limit/")
          ? thresholdDiscriminates(model, rows(c), {date: c.date.value})
          : caseDiscriminates(model, conditionOf(model, c.derived.condition), rows(c), {date: c.date.value});
        expect(discriminates, c.method).to.equal(true);
      }
    });

    it("the count source and threshold lines trace to their own rule lines", () => {
      for (const suffix of ["clas", "clas.testclasses"]) {
        const base = join(OUT, `zcl_l2_ship_voyage_limit.${suffix}`);
        const source = readFileSync(`${base}.abap`, "utf8").split("\n");
        const trace = readJSONFile(`${base}.trace.json`, "utf8");
        const at = (pattern) => trace.lines.find((e) => pattern.test(source[e.line - 1]));
        expect(at(/SELECT \* FROM zosd_l2_voy|INNER JOIN zosd_l2_voy/).rule_line).to.equal(text.split("\n").findIndex((l) => /^  count:/.test(l)) + 1);
        expect(at(/IF lv_count > 2\./).rule_line).to.equal(text.split("\n").findIndex((l) => /^  more_than:/.test(l)) + 1);
      }
    });

    interleaving(copy, LIMIT, "lim");

    it("the threshold operator mutant fails at exactly two", async () => {
      const {file, className} = copy("op", text);
      const {results} = await runRule(file, className, {transform: {"clas.abap": (s) => s.replaceAll("IF lv_count > 2.", "IF lv_count >= 2.")}});
      expect(failed(results)).to.include("exactly_two_future_voyages");
      expect(failed(results)).to.include("b_count_not_over");
    });

    it("the threshold literal mutant fails at three", async () => {
      const {file, className} = copy("lit", text);
      const {results} = await runRule(file, className, {transform: {"clas.abap": (s) => s.replaceAll("IF lv_count > 2.", "IF lv_count > 3.")}});
      expect(failed(results)).to.include("three_future_voyages");
    });

    it("dropping the group count reset fails on the last nonviolating ship", async () => {
      const {file, className} = copy("noclear", text);
      const {results} = await runRule(file, className, {mutate: {"clas.abap": [["        CLEAR lv_count.", "        " ]]}});
      expect(failed(results)).to.include("groups_last_under");
      expect(failed(results)).to.include("b_count_groups");
    });

    it("never splitting groups loses the first group's alert", async () => {
      const {file, className} = copy("nosplit", text);
      const {results} = await runRule(file, className, {mutate: {"clas.abap": [["IF lv_count > 0 AND (", "IF lv_count < 0 AND ("]]}});
      expect(failed(results)).to.include("groups_last_over");
      expect(failed(results)).to.include("b_count_groups");
    });

    it("dropping the ON equality is caught by check_reference", async () => {
      const {file, className} = copy("join", text);
      const {results, messages} = await runRule(file, className, {mutate: {"clas.abap": [["ON voy~ship_id = ship~ship_id", "ON voy~ship_id = voy~ship_id"]]}});
      expect(failed(results).length).to.be.greaterThan(0);
      expect(failed(results)).to.include("other_ships_voyages");
      expect(failed(results)).to.include("b_ship_id_nomatch");
      expect(Object.values(messages).some((m) => m.includes("#assert_same_as_reference"))).to.equal(true);
    });

    it("at_least: 3 has below and at boundary cases, both run in ABAP", async () => {
      const {file, className} = copy("at", text.replace("more_than: 2", "at_least: 3"));
      const {model, results, messages} = await runRule(file, className);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.map((c) => c.method)).to.include.members(["b_count_below", "b_count_at"]);
      expect(model.cases.find((c) => c.method === "b_count_below").expect).to.deep.equal([]);
      expect(model.cases.find((c) => c.method === "b_count_at").expect).to.have.length(1);
    });

    it("zero and one thresholds accept existence and emit once per for row", async () => {
      const base = `rule: count-exists
class: zcl_l2_count_exists
title: Count existence
for: ZOSD_L2_SHIP as ship
limit:
  count: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id
  more_than: 0
alert: "{ship.ship_id}: {count}"
boundaries: auto
examples:
  - name: no voyage
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: A, status: A}]
    expect: []
  - name: two voyages one alert
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: A, status: A}]
      ZOSD_L2_VOY:
        - {voyage_id: V00001, ship_id: S001, dep_date: 20261002}
        - {voyage_id: V00002, ship_id: S001, dep_date: 20261003}
    expect: ["S001: 2"]
`;
      for (const [tag, rule] of [["zero", base], ["one", base.replace("more_than: 0", "at_least: 1")]]) {
        const {file, className} = copy(tag, rule);
        const {model, results, messages} = await runRule(file, className);
        expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
        expect(model.cases.map((c) => c.method)).to.include("b_count_groups");
      }
    });

    it("refuses zero-count forms and counted-row alert holes at their own lines", () => {
      for (const [from, to, reason] of [
        ["more_than: 2", "at_least: 0", "holds for every for row"],
        ["more_than: 2", "fewer_than: 0", "never holds"],
        ["more_than: 2", "more_than: 2147483648", "INT4"],
        ["{count} future", "{voy.voyage_id} future", "limit counts rows"],
      ]) {
        const {file} = copy(`bad${reason.length}`, text.replace(from, to));
        const altered = readFileSync(file, "utf8");
        const target = altered.split("\n").findIndex((l) => l.includes(to)) + 1;
        expect(() => compileRule(file, {registry})).to.throw(RuleError, reason)
          .with.property("line", target);
      }
      const {file} = copy("mixed", text.replace("limit:\n", "forbid:\n  exists: ZOSD_L2_VOY as other\n  where: other.ship_id = ship.ship_id\nlimit:\n"));
      expect(() => compileRule(file, {registry})).to.throw(RuleError, "exactly one");
    });

    // Rules whose alert names no count and no key of the for table: the alert
    // lines of the two groups can only differ in a non-key field the alert
    // names, so the derived two-group case alone must catch a never-split
    // mutant (the examples are one trivial row each).
    const trivial = "examples:\n  - name: none\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: A, status: A}]\n    expect: []\n";
    const FIXTURES = {
      grpnd: `rule: grp
class: x
title: grouping
for: ZOSD_L2_SHIP as ship
when: ship.status = 'A' or not ship.name = 'X'
limit:
  count: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and (voy.dep_date > $date or not voy.voyage_id <> 'V99999')
  more_than: 2
alert: "{ship.name} too many"
boundaries: auto
${trivial}`,
      demoe: `rule: ship-too-many-future-voyages
class: x
title: A ship has at most two voyages departing after the check date
for: ZOSD_L2_SHIP as ship
when: ship.status <> 'D'
limit:
  count: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date > $date
  more_than: 2
alert: "{ship.name} over"
boundaries: auto
${trivial}`,
    };
    for (const [tag, source] of Object.entries(FIXTURES)) {
      it(`${tag}: the second group differs in the alert's fields, so the derived case alone catches never-split`, async () => {
        const {file, className} = copy(`split_${tag}`, source);
        const {model, results} = await runRule(file, className, {mutate: {"clas.abap": [["IF lv_count > 0 AND (", "IF lv_count < 0 AND ("]]}});
        const groups = model.cases.find((c) => c.method === "b_count_groups");
        expect(groups, JSON.stringify(model.skipped)).to.not.equal(undefined);
        const names = rows(groups).zosd_l2_ship.map((r) => r.name);
        expect(names, "one name per group").to.have.length(2);
        expect(names[0]).to.not.equal(names[1]);
        expect(failed(results)).to.deep.equal(["b_count_groups"]);
      });
    }

    it("skips the two-group case with a reason when the alert cannot tell the groups apart", () => {
      const {file} = copy("split_none", FIXTURES.demoe.replace('"{ship.name} over"', '"over"'));
      const model = compileRule(file, {registry});
      expect(model.cases.map((c) => c.method)).to.not.include("b_count_groups");
      expect(model.skipped.map((k) => k.reason).join("\n")).to.include("alerts differ");
    });

    it("warns for every threshold that loses a derived case to the cap, naming it, and for no other", () => {
      const probe = (tag, threshold) => {
        const {file} = copy(tag, FIXTURES.demoe.replace("more_than: 2", threshold));
        return {file, model: compileRule(file, {registry})};
      };
      for (const [threshold, named] of [
        ["more_than: 31", []],
        ["at_least: 32", []],
        ["more_than: 32", ["limit/more_than (groups)"]],
        ["at_least: 33", ["limit/at_least (groups)"]],
        ["more_than: 63", ["limit/more_than (groups)"]],
        ["at_least: 64", ["limit/at_least (groups)"]],
        ["more_than: 64", ["limit/more_than (over)", "limit/more_than (groups)"]],
        ["at_least: 65", ["limit/at_least (at)", "limit/at_least (groups)"]],
      ]) {
        const {file, model} = probe(`cap_${threshold.replace(/\W+/g, "_")}`, threshold);
        const warning = capWarning(model, file);
        if (!named.length) { expect(warning, threshold).to.equal(undefined); continue; }
        const line = readFileSync(file, "utf8").split("\n").findIndex((l) => l.includes(threshold)) + 1;
        expect(warning, threshold).to.include(`${file}:${line}: warning: the 64-row cap`);
        for (const name of named) expect(warning, threshold).to.include(name);
        const listed = warning.split(" skips derived cases: ")[1].split("; ")[0].split(", ");
        if (/: 6[4-5]$/.test(threshold) && !threshold.startsWith("at_least: 64")) expect(listed.filter((n) => n.startsWith("limit/")), threshold).to.deep.equal(named);
        else expect(listed, threshold).to.deep.equal(named);
      }
      // at_least: 64 derives both of its boundaries and loses only the groups
      const {model} = probe("cap_a64", "at_least: 64");
      expect(model.cases.map((c) => c.method)).to.include.members(["b_count_below", "b_count_at"]);
    });

    it("names the 64-row cap and warns with the threshold line", () => {
      const capText = `${text.slice(0, text.indexOf("examples:"))}examples:\n  - name: no voyages\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: A, status: A}]\n    expect: []\n`;
      const {file} = copy("cap64", capText.replace("more_than: 2", "more_than: 64"));
      const model = compileRule(file, {registry});
      expect(model.skipped.map((item) => item.reason).join("\n")).to.include("64-row");
      const line = readFileSync(file, "utf8").split("\n").findIndex((entry) => entry.includes("more_than: 64")) + 1;
      expect(capWarning(model, file)).to.include(`${file}:${line}: warning: the 64-row cap`);
    });
  });


  describe("slice 5: count from below (fewer_than, exactly, zero counts)", () => {
    before(async () => { await import("./start.mjs"); });
    const text = readFileSync(MIN_CREW, "utf8");
    const copy = (tag, source) => {
      const className = `zcl_l2_below_${tag}`;
      const file = join(scratch, `below_${tag}.l2.yaml`);
      writeFileSync(file, source.replace(/^class: .*$/m, `class: ${className}`));
      return {file, className};
    };
    const rows = (c) => Object.fromEntries(c.tables.map((t) => [t.table,
      t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));
    const discriminating = (model) => model.cases.filter((c) => !(c.method === "b_count_groups" ? true
      : c.method === "b_count_next_zero" ? staleDiscriminates(model, rows(c), {date: c.date.value})
      : c.derived.condition.startsWith("limit/") ? thresholdDiscriminates(model, rows(c), {date: c.date.value})
        : caseDiscriminates(model, conditionOf(model, c.derived.condition), rows(c), {date: c.date.value}))).map((c) => c.method);

    it("uses one LEFT OUTER JOIN for equalities, including a real row with an initial crew id", async () => {
      const {model, results, messages} = await runRule(MIN_CAPTAINS, "zcl_l2_ship_min_captains");
      expect(model.queries[0].zero.one_outer).to.equal(true);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.map((c) => c.method)).to.include.members(["b_count_next_zero", "b_count_groups"]);
      expect(discriminating(model)).to.deep.equal([]);
      const source = readFileSync(join(OUT, "zcl_l2_ship_min_captains.clas.abap"), "utf8");
      expect(source.match(/\bSELECT\b/g)).to.have.length(1);
      expect(source).to.include("LEFT OUTER JOIN zosd_l2_crew");
      expect(source).to.include("AND crew~role = 'C'");
    });

    it("keeps two queries when the condition tree has a comparison, or, or not", () => {
      const base = readFileSync(MIN_CAPTAINS, "utf8");
      for (const [tag, where] of [["date", "crew.ship_id = ship.ship_id and crew.since <= $date"],
        ["or", "crew.ship_id = ship.ship_id and (crew.role = 'C' or crew.role = 'K')"],
        ["not", "crew.ship_id = ship.ship_id and not crew.role = 'K'"]]) {
        const trivial = "examples:\n  - name: inactive\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: Gull, status: M}]\n    expect: []\n";
        const source = base.slice(0, base.indexOf("examples:")).replace("crew.ship_id = ship.ship_id and crew.role = 'C'", where) + trivial;
        const {file} = copy(`fb_${tag}`, source);
        expect(compileRule(file, {registry}).queries[0].zero.one_outer, tag).to.equal(undefined);
      }
    });

    // fewer_than: 2 hides the order dependence (a key with two counted rows
    // never alerts, so a duplicated for row is silent); fewer_than: 3 shows it
    const THREE = readFileSync(MIN_CAPTAINS, "utf8").replace("fewer_than: 2", "fewer_than: 3").replace(/examples:[\s\S]*$/, `examples:
  - name: two captains and none
    date: 20261001
    rows:
      ZOSD_L2_SHIP:
        - {ship_id: S002, name: Tern, status: A}
        - {ship_id: S001, name: Gull, status: A}
      ZOSD_L2_CREW:
        - {crew_id: C00002, ship_id: S001, role: C, since: 20260101}
        - {crew_id: C00001, ship_id: S001, role: C, since: 20260101}
        - {crew_id: C00003, ship_id: S002, role: K, since: 20260101}
    expect: ["S001 Gull: 2 captains", "S002 Tern: 0 captains"]
`);
    interleaving(copy, MIN_CAPTAINS, "outer", THREE);

    it("makes one database call for multiple for rows", async () => {
      const copyRule = copy("outer_calls", readFileSync(MIN_CAPTAINS, "utf8"));
      const {out, model} = await loadRule(copyRule.file, copyRule.className);
      const module = await import(pathToFileURL(join(out, `${model.class}.clas.mjs`)).href);
      const abap = globalThis.abap;
      const db = abap.context.databaseConnections.DEFAULT;
      const mandt = abap.builtin.sy.get().mandt.get();
      for (let i = 1; i <= 5; i++) {
        await db.execute(`INSERT INTO zosd_l2_ship (mandt, ship_id, name, status) VALUES ('${mandt}', 'Q00${i}', 'Ship ${i}', 'A')`);
        if (i % 2) await db.execute(`INSERT INTO zosd_l2_crew (mandt, crew_id, ship_id, role, since) VALUES ('${mandt}', 'Q0000${i}', 'Q00${i}', 'C', '20260101')`);
      }
      const original = db.select.bind(db);
      let calls = 0;
      db.select = async (options) => { calls++; return original(options); };
      let alerts;
      try { alerts = (await module[model.class].check({iv_date: new abap.types.Date().set("20261001")})).array().map((a) => a.get()).filter((a) => a.startsWith("Q")); }
      finally {
        db.select = original;
        await db.execute("DELETE FROM zosd_l2_crew WHERE crew_id LIKE 'Q%'");
        await db.execute("DELETE FROM zosd_l2_ship WHERE ship_id LIKE 'Q%'");
      }
      expect(calls).to.equal(1);
      expect(alerts).to.deep.equal(["Q001 Ship 1: 1 captains", "Q002 Ship 2: 0 captains", "Q003 Ship 3: 1 captains",
        "Q004 Ship 4: 0 captains", "Q005 Ship 5: 1 captains"]);
    });

    for (const [tag, from, to, evidence] of [
      ["missing", "      IF ls_join-crew_mandt IS INITIAL.\n        CONTINUE.\n      ENDIF.\n", "", "zero_and_two"],
      ["where", "AND crew~role = 'C'", "AND crew~role = crew~role", "zero_and_two"],
      ["clear", "      CLEAR lv_count.\n", "", "b_count_next_zero"],
    ]) {
      it(`${tag} mutant goes red against check_reference`, async () => {
        const {file, className} = copy(`outer_${tag}`, readFileSync(MIN_CAPTAINS, "utf8"));
        const transform = tag === "where" ? {"clas.abap": (s) => {
          const changed = s.replace("           AND crew~role = 'C'\n", "").replace("      WHERE ship~status = 'A'", "      WHERE ship~status = 'A' AND crew~role = 'C'");
          return changed;
        }} : {"clas.abap": (s) => s.replace(from, to)};
        const {results} = await runRule(file, className, {transform});
        expect(failed(results)).to.include(evidence);
      });
    }
    // exactly: one rule over the same fleet, its examples written for it
    const EXACTLY = `rule: ship-one-captain
class: x
title: An active ship has exactly one crew member in role C
for: ZOSD_L2_SHIP as ship
when: ship.status = 'A'
limit:
  count: ZOSD_L2_CREW as crew
  where: crew.ship_id = ship.ship_id and crew.role = 'C'
  exactly: 1
alert: "{ship.ship_id} {ship.name}: {count} captains"
boundaries: auto
examples:
  - name: one captain
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: A}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: C, since: 20260101}]
    expect: ["S001 Albatross: 1 captains"]
  - name: none and two
    date: 20261001
    rows:
      ZOSD_L2_SHIP:
        - {ship_id: S003, name: Tern, status: A}
        - {ship_id: S002, name: Gull, status: A}
      ZOSD_L2_CREW:
        - {crew_id: C00003, ship_id: S003, role: C, since: 20260101}
        - {crew_id: C00002, ship_id: S003, role: C, since: 20260101}
        - {crew_id: C00004, ship_id: S002, role: K, since: 20260101}
    expect: []
`;

    it("the committed rule runs its examples and its thirteen derived cases, a for row with no crew among them", async () => {
      const {model, results, messages} = await runRule(MIN_CREW, "zcl_l2_ship_min_crew");
      expect(Object.keys(results)).to.have.length(9 + 13);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.map((c) => c.method)).to.include.members(["b_count_below", "b_count_at", "b_count_zero", "b_count_next_zero", "b_count_groups"]);
      // a counted key directly before, in key order, a key with no counted row
      const next = model.cases.find((c) => c.method === "b_count_next_zero");
      const ships = rows(next).zosd_l2_ship.map((r) => r.ship_id);
      expect(ships).to.have.length(2);
      expect(ships[0] < ships[1]).to.equal(true);
      expect(rows(next).zosd_l2_crew.every((r) => r.ship_id === ships[0])).to.equal(true);
      const zero = model.cases.find((c) => c.method === "b_count_zero");
      expect(rows(zero).zosd_l2_crew, "no crew row at all").to.equal(undefined);
      expect(zero.expect.map((e) => e.value)).to.deep.equal(["S002 Cormorant: 0 crew aboard"]);
      expect(discriminating(model)).to.deep.equal([]);
    });

    it("check makes two database calls whatever the number of for rows: the for rows and the counted join", async () => {
      const {out, model} = await loadRule(...Object.values(copy("calls", text)));
      const abap = globalThis.abap;
      const db = abap.context.databaseConnections.DEFAULT;
      const mandt = abap.builtin.sy.get().mandt.get();
      const n = 5;
      try {
        for (let i = 1; i <= n; i++) {
          await db.execute(`INSERT INTO zosd_l2_ship (mandt, ship_id, name, status) VALUES ('${mandt}', 'Q00${i}', 'Ship ${i}', 'A')`);
          if (i % 2) await db.execute(`INSERT INTO zosd_l2_crew (mandt, crew_id, ship_id, role, since) VALUES ('${mandt}', 'Q0000${i}', 'Q00${i}', 'C', '20260101')`);
        }
        const module = await import(pathToFileURL(join(out, `${model.class}.clas.mjs`)).href);
        const original = db.select.bind(db);
        let calls = 0;
        db.select = async (options) => { calls++; return original(options); };
        let alerts;
        try {
          alerts = (await module[model.class].check({iv_date: new abap.types.Date().set("20261001")})).array().map((a) => a.get())
            .filter((a) => a.startsWith("Q"));
        } finally {
          db.select = original;
        }
        expect(calls, "two SELECTs").to.equal(2);
        expect(alerts).to.deep.equal(["Q001 Ship 1: 1 crew aboard", "Q002 Ship 2: 0 crew aboard", "Q003 Ship 3: 1 crew aboard",
          "Q004 Ship 4: 0 crew aboard", "Q005 Ship 5: 1 crew aboard"]);
      } finally {
        await db.execute("DELETE FROM zosd_l2_crew WHERE crew_id LIKE 'Q%'");
        await db.execute("DELETE FROM zosd_l2_ship WHERE ship_id LIKE 'Q%'");
      }
    });

    it("the count source and threshold lines trace to their own rule lines", () => {
      for (const suffix of ["clas", "clas.testclasses"]) {
        const base = join(OUT, `zcl_l2_ship_min_crew.${suffix}`);
        const source = readFileSync(`${base}.abap`, "utf8").split("\n");
        const trace = readJSONFile(`${base}.trace.json`, "utf8");
        const at = (pattern) => trace.lines.find((e) => pattern.test(source[e.line - 1]));
        expect(at(/SELECT \* FROM zosd_l2_crew|INNER JOIN zosd_l2_crew/).rule_line).to.equal(text.split("\n").findIndex((l) => /^  count:/.test(l)) + 1);
        expect(at(/IF lv_count < 2\./).rule_line).to.equal(text.split("\n").findIndex((l) => /^  fewer_than:/.test(l)) + 1);
      }
      // the read of the for rows traces to the for line, its WHERE to the when line
      const source = readFileSync(join(OUT, "zcl_l2_ship_min_crew.clas.abap"), "utf8").split("\n");
      const trace = readJSONFile(join(OUT, "zcl_l2_ship_min_crew.clas.trace.json"), "utf8");
      const into = trace.lines.find((e) => /INTO CORRESPONDING FIELDS OF TABLE lt_for/.test(source[e.line - 1]));
      expect(into.rule_line).to.equal(text.split("\n").findIndex((l) => /^for:/.test(l)) + 1);
      expect(trace.lines.find((e) => e.line === into.line + 1).rule_line).to.equal(text.split("\n").findIndex((l) => /^when:/.test(l)) + 1);
    });

    it("< changed to <= fails at two crew members, in the example and in the derived case", async () => {
      const {file, className} = copy("op", text);
      const {results} = await runRule(file, className, {transform: {"clas.abap": (s) => s.replaceAll("IF lv_count < 2.", "IF lv_count <= 2.")}});
      expect(failed(results)).to.include.members(["two_crew_members", "b_count_at"]);
    });

    it("dropping the zero count (CLEAR lv_count) lets a crewless ship take the previous ship's count and vanish", async () => {
      const {file, className} = copy("noclear", text);
      const {results} = await runRule(file, className, {mutate: {"clas.abap": [["      CLEAR lv_count.\n", ""]]}});
      expect(failed(results)).to.include.members(["fleet_out_of_key_order", "b_count_next_zero"]);
    });

    it("dropping CLEAR lv_count goes red through the derived cases alone (a rule whose only example has one crew member)", async () => {
      const head = text.slice(0, text.indexOf("examples:"));
      const only = `${head}examples:\n  - name: one crew member\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S002, name: Cormorant, status: A}]\n`
        + "      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S002, role: C, since: 20260101}]\n    expect: [\"S002 Cormorant: 1 crew aboard\"]\n";
      const clean = copy("onlyone", only);
      const ok = await runRule(clean.file, clean.className);
      expect(failed(ok.results), JSON.stringify(ok.messages)).to.deep.equal([]);
      const {file, className} = copy("onlyone_noclear", only);
      const {results} = await runRule(file, className, {mutate: {"clas.abap": [["      CLEAR lv_count.\n", ""]]}});
      expect(failed(results)).to.deep.equal(["b_count_next_zero"]);
    });

    const READ_FOR = "      READ TABLE lt_count INTO ls_count WITH TABLE KEY ship_ship_id = ls_for-ship_ship_id.\n";
    it("dropping the merge of the for rows the counts lack (only counted keys alert) loses every zero count", async () => {
      const {file, className} = copy("nomerge", text);
      const {results} = await runRule(file, className, {mutate: {"clas.abap": [[READ_FOR, `${READ_FOR}      CHECK sy-subrc = 0.\n`]]}});
      expect(failed(results)).to.include.members(["no_crew", "other_ships_crew", "fleet_out_of_key_order", "b_count_zero"]);
    });

    it("exactly: 1 derives below (no crew at all), at and above; = changed to >= fails above", async () => {
      const {file, className} = copy("exactly", EXACTLY);
      const model = compileRule(file, {registry});
      const methods = model.cases.map((c) => c.method);
      expect(methods).to.include.members(["b_count_below", "b_count_at", "b_count_above", "b_count_next_zero", "b_count_groups"]);
      expect(methods).to.not.include("b_count_zero");
      expect(rows(model.cases.find((c) => c.method === "b_count_below")).zosd_l2_crew).to.equal(undefined);
      expect(discriminating(model)).to.deep.equal([]);
      const clean = await runRule(file, className);
      expect(failed(clean.results), JSON.stringify(clean.messages)).to.deep.equal([]);
      // a class of its own: the module of the first run stays in the import cache
      const mutant = copy("exactly_ge", EXACTLY);
      const {results} = await runRule(mutant.file, mutant.className, {transform: {"clas.abap": (s) => s.replaceAll("IF lv_count = 1.", "IF lv_count >= 1.")}});
      expect(failed(results)).to.include.members(["none_and_two", "b_count_above"]);
      const stale = copy("exactly_stale", EXACTLY);
      const dropped = await runRule(stale.file, stale.className, {mutate: {"clas.abap": [["      CLEAR lv_count.\n", ""]]}});
      expect(failed(dropped.results)).to.include("b_count_next_zero");
    });

    it("exactly: 0 has no below case; exactly: 3 adds a zero case; both run green", async () => {
      const zeroRule = EXACTLY.replace("exactly: 1", "exactly: 0")
        .replace('expect: ["S001 Albatross: 1 captains"]', "expect: []")
        .replace("        - {crew_id: C00004, ship_id: S002, role: K, since: 20260101}\n    expect: []", "        - {crew_id: C00004, ship_id: S002, role: K, since: 20260101}\n    expect: [\"S002 Gull: 0 captains\"]");
      const threeRule = EXACTLY.replace("exactly: 1", "exactly: 3").replace('expect: ["S001 Albatross: 1 captains"]', "expect: []");
      for (const [tag, rule, want, without] of [["ex0", zeroRule, ["b_count_at", "b_count_above", "b_count_next_zero"], ["b_count_below", "b_count_zero"]],
        ["ex3", threeRule, ["b_count_below", "b_count_at", "b_count_above", "b_count_zero", "b_count_next_zero"], []]]) {
        const {file, className} = copy(tag, rule);
        const {model, results, messages} = await runRule(file, className);
        expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
        const methods = model.cases.map((c) => c.method);
        expect(methods, tag).to.include.members(want);
        for (const m of without) expect(methods, tag).to.not.include(m);
        expect(discriminating(model), tag).to.deep.equal([]);
      }
    });

    it("fewer_than: 1 tests its when on a ship with no crew row, and its below case is the zero case", () => {
      const {file} = copy("ft1", text.replace("fewer_than: 2", "fewer_than: 1")
        .replace('expect: ["S002 Cormorant: 1 crew aboard"]', "expect: []")
        .replace('expect: ["S005 Heron: 1 crew aboard"]', "expect: []")
        .replace('expect: ["S021 Teal: 0 crew aboard", "S022 Lark: 1 crew aboard"]', 'expect: ["S021 Teal: 0 crew aboard"]'));
      const model = compileRule(file, {registry});
      const below = model.cases.find((c) => c.method === "b_count_below");
      expect(rows(below).zosd_l2_crew).to.equal(undefined);
      expect(model.cases.map((c) => c.method)).to.not.include("b_count_zero");
      const status = model.cases.find((c) => c.method === "b_status_eq");
      expect(rows(status).zosd_l2_crew, "the when is tested with no crew row").to.equal(undefined);
      expect(status.expect).to.have.length(1);
      expect(discriminating(model)).to.deep.equal([]);
    });

    it("refuses fewer_than: 0, a negative exactly and two thresholds at their own lines", () => {
      for (const [to, reason] of [["fewer_than: 0", "never holds"], ["exactly: -1", "non-negative INT4"],
        ["fewer_than: 2\n  exactly: 2", "exactly one of more_than, at_least, fewer_than or exactly"]]) {
        const {file} = copy(`bad_${reason.length}`, text.replace("fewer_than: 2", to));
        const altered = readFileSync(file, "utf8");
        const target = altered.split("\n").findIndex((l) => l.includes(to.split("\n").pop())) + 1;
        expect(() => compileRule(file, {registry}), to).to.throw(RuleError, reason).with.property("line", target);
      }
    });

    it("warns when the 64-row cap skips a case of fewer_than or exactly", () => {
      const trivial = "examples:\n  - name: none\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: A, status: D}]\n    expect: []\n";
      const head = text.slice(0, text.indexOf("examples:"));
      for (const [threshold, named] of [["fewer_than: 32", []], ["fewer_than: 33", ["limit/fewer_than (groups)"]],
        ["exactly: 64", ["limit/exactly (above)", "limit/exactly (groups)"]],
        ["fewer_than: 65", ["limit/fewer_than (at)", "limit/fewer_than (next_zero)", "limit/fewer_than (groups)"]]]) {
        const {file} = copy(`cap_${threshold.replace(/\W+/g, "_")}`, head.replace("fewer_than: 2", threshold) + trivial);
        const model = compileRule(file, {registry});
        const warning = capWarning(model, file);
        if (!named.length) { expect(warning, threshold).to.equal(undefined); continue; }
        for (const name of named) expect(warning, threshold).to.include(name);
      }
    });
  });

  describe("slice 6: numeric field aggregates", () => {
    before(async () => { await import("./start.mjs"); });
    const cargoText = readFileSync(CARGO_LIMIT, "utf8");
    const copy = (tag, source) => {
      const className = `zcl_l2_ag_${tag}`;
      const file = join(scratch, `cargo_${tag}.l2.yaml`);
      writeFileSync(file, source.replace(/^class: .*$/m, `class: ${className}`));
      return {file, className};
    };
    const caseRows = (c) => Object.fromEntries(c.tables.map((t) => [t.table,
      t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));

    const ZERO_SUM = `rule: ship-cargo-empty-sum
class: zcl_l2_cargo_empty_sum
title: Empty cargo weighs zero
for: ZOSD_L2_SHIP as ship
limit:
  sum: ZOSD_L2_CARGO.weight as cargo
  where: cargo.ship_id = ship.ship_id
  fewer_than: 1000.00
alert: "{ship.ship_id}: {sum} kg booked"
boundaries: auto
examples:
  - name: above threshold
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S040, name: Tern, status: A}]
      ZOSD_L2_CARGO:
        - {cargo_id: C00040, ship_id: S040, weight: 600.01}
        - {cargo_id: C00041, ship_id: S040, weight: 400.00}
    expect: []
  - name: empty group
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S041, name: Gull, status: A}]
    expect: ["S041: 0.00 kg booked"]
  - name: nonempty then empty
    date: 20261001
    rows:
      ZOSD_L2_SHIP:
        - {ship_id: S042, name: Heron, status: A}
        - {ship_id: S043, name: Wren, status: A}
      ZOSD_L2_CARGO: [{cargo_id: C00042, ship_id: S042, weight: 1000.01}]
    expect: ["S043: 0.00 kg booked"]
`;

    const MIN_RULE = `rule: ship-min-cargo
class: zcl_l2_cargo_minimum
title: The minimum cargo weight is reported
for: ZOSD_L2_SHIP as ship
limit:
  min: ZOSD_L2_CARGO.weight as cargo
  where: cargo.ship_id = ship.ship_id
  at_least: -2.50
alert: "{ship.ship_id}: minimum {min} kg"
boundaries: auto
examples:
  - name: negative minimum
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S030, name: Tern, status: A}]
      ZOSD_L2_CARGO:
        - {cargo_id: C00030, ship_id: S030, weight: -2.50}
        - {cargo_id: C00031, ship_id: S030, weight: -1.25}
    expect: ["S030: minimum -2.50 kg"]
  - name: empty minimum is undefined
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S031, name: Gull, status: A}]
    expect: []
`;

    it("runs fractional sum examples and derives DEC boundaries and separate groups", async () => {
      const {model, results, messages} = await runRule(CARGO_LIMIT, "zcl_l2_ship_cargo_limit");
      expect(Object.keys(results)).to.have.length(model.examples.length + model.cases.length);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.map((c) => c.method)).to.include.members([
        "b_ship_id_match", "b_ship_id_nomatch", "b_sum_below", "b_sum_at", "b_sum_above", "b_sum_groups",
      ]);
      const values = Object.fromEntries(model.cases.filter((c) => ["below", "at", "above"].includes(c.derived.kind))
        .map((c) => [c.derived.kind, caseRows(c).zosd_l2_cargo[0].weight]));
      expect(values).to.deep.equal({below: "999.99", at: "1000.00", above: "1000.01"});
      const reference = readFileSync(join(OUT, "zcl_l2_ship_cargo_limit.clas.testclasses.abap"), "utf8");
      expect(reference).to.contain("SELECT weight FROM zosd_l2_cargo INTO TABLE lt_aggregate_values");
      expect(reference).to.contain("LOOP AT lt_aggregate_values INTO lv_aggregate_value.");
      expect(model.examples.map((e) => e.expect.map((x) => x.value))).to.deep.equal([
        ["S003: 1000.01 kg booked"], [], [], ["S011: 1000.01 kg booked"], ["S002: 1000.01 kg booked"],
      ]);
    });

    it("runs max and min, including negative DEC alert text and an exact extreme", async () => {
      const max = await runRule(MAX_CARGO, "zcl_l2_ship_max_cargo");
      expect(failed(max.results), JSON.stringify(max.messages)).to.deep.equal([]);
      expect(max.model.cases.map((c) => c.method)).to.include("b_max_at");
      const minCopy = copy("minimum", MIN_RULE);
      const min = await runRule(minCopy.file, minCopy.className);
      expect(failed(min.results), JSON.stringify(min.messages)).to.deep.equal([]);
      expect(min.model.cases.map((c) => c.method)).to.include("b_min_at");
      expect(min.model.examples[0].expect.map((e) => e.value)).to.deep.equal(["S030: minimum -2.50 kg"]);

      const negativeMaxText = MIN_RULE.replace("  min:", "  max:")
        .replace("alert: \"{ship.ship_id}: minimum {min} kg\"", "alert: \"{ship.ship_id}: maximum {max} kg\"")
        .replace("S030: minimum -2.50 kg", "S030: maximum -1.25 kg");
      const negativeMaxCopy = copy("negative_max", negativeMaxText);
      const negativeMax = await runRule(negativeMaxCopy.file, negativeMaxCopy.className);
      expect(failed(negativeMax.results), JSON.stringify(negativeMax.messages)).to.deep.equal([]);
      expect(negativeMax.model.cases.map((c) => c.method)).to.include("b_max_at");
      for (const testCase of negativeMax.model.cases) {
        const weights = caseRows(testCase).zosd_l2_cargo?.map((row) => row.weight) ?? [];
        expect(weights.every((weight) => weight.startsWith("-")), testCase.method).to.equal(true);
      }
    });

    it("uses the zero-sum query shape for fewer_than and derives zero, next_zero and two groups", async () => {
      const fewer = copy("empty_sum", ZERO_SUM);
      const {model, results, messages} = await runRule(fewer.file, fewer.className);
      expect(model.queries[0].zero).to.include({one_outer: true});
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      expect(model.cases.map((c) => c.method)).to.include.members(["b_sum_zero", "b_sum_next_zero", "b_sum_groups"]);
      const zero = model.cases.find((c) => c.method === "b_sum_zero");
      expect(caseRows(zero).zosd_l2_cargo).to.equal(undefined);
      expect(zero.expect.map((e) => e.value)).to.deep.equal(["S040: 0.00 kg booked"]);
      const next = model.cases.find((c) => c.method === "b_sum_next_zero");
      const ships = caseRows(next).zosd_l2_ship.map((r) => r.ship_id);
      expect(ships[0] < ships[1]).to.equal(true);
      expect(caseRows(next).zosd_l2_cargo.every((r) => r.ship_id === ships[0])).to.equal(true);
    });

    it("> to >=, sum to count, max to min, max's missing initial guard, reset removal and integer accumulation all go red", async () => {
      const ge = copy("ge", cargoText);
      const geResult = await runRule(ge.file, ge.className, {transform: {"clas.abap": (s) =>
        s.replaceAll("lv_aggregate > '1000.00'", "lv_aggregate >= '1000.00'")}});
      expect(failed(geResult.results)).to.include("b_sum_at");

      const count = copy("count_mutant", cargoText);
      const countResult = await runRule(count.file, count.className, {mutate: {"clas.abap": [[
        "ADD ls_join-cargo_weight TO lv_aggregate.", "ADD 1 TO lv_aggregate.",
      ]]}});
      expect(failed(countResult.results)).to.include("fractional_over");

      const min = copy("max_as_min", readFileSync(MAX_CARGO, "utf8"));
      const extremeResult = await runRule(min.file, min.className, {mutate: {"clas.abap": [[
        "ls_join-cargo_weight > lv_aggregate", "ls_join-cargo_weight < lv_aggregate",
      ]]}});
      expect(failed(extremeResult.results)).to.include("maximum_over");

      const negativeMax = copy("negative_max_no_seen", MIN_RULE.replace("  min:", "  max:")
        .replace("alert: \"{ship.ship_id}: minimum {min} kg\"", "alert: \"{ship.ship_id}: maximum {max} kg\"")
        .replace("S030: minimum -2.50 kg", "S030: maximum -1.25 kg"));
      const noMaxSeen = await runRule(negativeMax.file, negativeMax.className, {mutate: {"clas.abap": [[
        "lv_aggregate_seen IS INITIAL OR ls_join-cargo_weight > lv_aggregate", "ls_join-cargo_weight > lv_aggregate",
      ]]}});
      expect(failed(noMaxSeen.results)).to.include("negative_minimum");

      const fewer = copy("reset_mutant", ZERO_SUM);
      const resetResult = await runRule(fewer.file, fewer.className, {mutate: {"clas.abap": [[
        "      CLEAR lv_aggregate.\n      READ TABLE lt_count", "      READ TABLE lt_count",
      ]]}});
      expect(failed(resetResult.results)).to.include("b_sum_next_zero");

      const integer = copy("integer_accumulator", cargoText);
      const integerResult = await runRule(integer.file, integer.className, {mutate: {"clas.abap": [[
        "DATA lv_aggregate TYPE p LENGTH 16 DECIMALS 2.", "DATA lv_aggregate TYPE i.",
      ]]}});
      expect(failed(integerResult.results)).to.include("fractional_over");
    });

    it("reports unsupported DDIC fields, keeps INT8 sums wide, and refuses a DEC threshold's excess precision", async () => {
      const ddic = join(scratch, "aggregate-ddic");
      mkdirSync(ddic, {recursive: true});
      const numericFields = ["I1", "I2", "I4", "I8", "DEC"];
      const numericTypes = [["I1", "INT1", 3], ["I2", "INT2", 5], ["I4", "INT4", 10], ["I8", "INT8", 19], ["DEC", "DEC", 9]];
      for (const [name, type, length] of numericTypes) {
        writeFileSync(join(ddic, `zosd_l2_a_${name.toLowerCase()}.dtel.xml`), dtel(`ZOSD_L2_A_${name}`, type, length, type === "DEC" ? 2 : 0));
      }
      const badTypes = [["CHAR_VALUE", "CHAR", 4], ["NUMC_VALUE", "NUMC", 4], ["DATE_VALUE", "DATS", 8],
        ["TIME_VALUE", "TIMS", 6]];
      const fields = [typed("SHIP_ID", "CHAR", 4), ...numericFields.map((name) => elem(name, `ZOSD_L2_A_${name}`)),
        ...badTypes.map(([name, type, length]) => typed(name, type, length))];
      writeFileSync(join(ddic, "zosd_l2_aggnum.tabl.xml"), tableXml("ZOSD_L2_AGGNUM", [key("ID"), ...fields]));
      writeFileSync(join(ddic, "zosd_l2_aggfloat.tabl.xml"), tableXml("ZOSD_L2_AGGFLOAT", [key("ID"),
        typed("SHIP_ID", "CHAR", 4), typed("FLOAT_VALUE", "FLTP", 8)]));
      writeFileSync(join(ddic, "zosd_l2_aggint.tabl.xml"), tableXml("ZOSD_L2_AGGINT", [key("ID"),
        typed("SHIP_ID", "CHAR", 4), elem("INT_VALUE", "ZOSD_L2_A_I4")]));
      const aggRegistry = registryFor([...DEFAULT_DDIC, ddic], []);
      const ruleFor = (tag, source, threshold = "5") => `rule: aggregate-type-${tag.toLowerCase().replaceAll("_", "-")}
class: zcl_l2_aggregate_type
title: aggregate type check
for: ZOSD_L2_SHIP as ship
limit:
  sum: ZOSD_L2_AGGNUM.${source.toLowerCase()} as amount
  where: amount.ship_id = ship.ship_id
  more_than: ${threshold}
alert: "{sum}"
boundaries: auto
examples:
  - name: one
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S050, name: Tern, status: A}]
      ZOSD_L2_AGGNUM: [{id: A001, ship_id: S050, i1: 1, i2: 1, i4: 1, i8: 1, dec: 1.25,
        char_value: A, numc_value: 1, date_value: 20260101, float_value: 1.5, time_value: 120000}]
    expect: []
`;
      const compileSource = (tag, source, threshold = "5") => {
        const file = join(scratch, `aggregate_type_${tag.toLowerCase()}.l2.yaml`);
        writeFileSync(file, ruleFor(tag, source, threshold).replace("float_value: 1.5, ", ""));
        return {file};
      };
      for (const [field, expected] of [["I1", "int8"], ["I2", "int8"], ["I4", "int8"],
        ["I8", "int8"], ["DEC", "p LENGTH 16 DECIMALS 2"]]) {
        const item = compileSource(field, field);
        const model = compileRule(item.file, {registry: aggRegistry});
        expect(model.aggregate.accumulator_type, field).to.equal(expected);
      }
      for (const [field, datatype] of badTypes) {
        const item = compileSource(field, field);
        const source = readFileSync(item.file, "utf8");
        const line = source.split("\n").findIndex((entry) => entry.includes(`sum: ZOSD_L2_AGGNUM.${field.toLowerCase()}`)) + 1;
        let error;
        try { compileRule(item.file, {registry: aggRegistry}); } catch (caught) { error = caught; }
        expect(error, field).to.be.instanceOf(RuleError);
        expect(error.message, field).to.include(`:${line}: `);
        const message = (() => { try { compileRule(item.file, {registry: aggRegistry}); } catch (error) { return error.message; } })();
        expect(message, field).to.include(`is ${datatype}`);
      }
      const floatFile = join(scratch, "aggregate_type_float.l2.yaml");
      const floatText = ruleFor("FLOAT_VALUE", "FLOAT_VALUE").replace("ZOSD_L2_AGGNUM.float_value", "ZOSD_L2_AGGFLOAT.float_value")
        .replace("ZOSD_L2_AGGNUM: [{id: A001, ship_id: S050, i1: 1, i2: 1, i4: 1, i8: 1, dec: 1.25,\n        char_value: A, numc_value: 1, date_value: 20260101, float_value: 1.5, time_value: 120000}]", "ZOSD_L2_AGGNUM: []");
      writeFileSync(floatFile, floatText);
      const floatLine = floatText.split("\n").findIndex((entry) => entry.includes("sum: ZOSD_L2_AGGFLOAT.float_value")) + 1;
      expect(() => compileRule(floatFile, {registry: aggRegistry}))
        .to.throw(RuleError, new RegExp(`:${floatLine}: .*FLTP; floating point equality and rounding cannot be proved`));
      const file = join(scratch, "aggregate_threshold_precision.l2.yaml");
      writeFileSync(file, cargoText.replace("more_than: 1000.00", "more_than: 1000.001"));
      const text = readFileSync(file, "utf8");
      const line = text.split("\n").findIndex((entry) => entry.includes("more_than: 1000.001")) + 1;
      expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${line}: .*exceeds the precision of DEC 9,2`));

      const runtimeDdic = join(scratch, "aggregate-runtime-ddic");
      mkdirSync(runtimeDdic, {recursive: true});
      for (const name of FLEET) copyFileSync(join(OUT, name), join(runtimeDdic, name));
      for (const name of ["zosd_l2_aggint.tabl.xml", "zosd_l2_a_i4.dtel.xml"]) {
        copyFileSync(join(ddic, name), join(runtimeDdic, name));
      }
      const int8Rule = join(scratch, "aggregate_int8_alert.l2.yaml");
      writeFileSync(int8Rule, `rule: aggregate-int8-alert
class: zcl_l2_aggregate_int8_alert
title: A wide integer sum keeps every digit
for: ZOSD_L2_SHIP as ship
limit:
  sum: ZOSD_L2_AGGNUM.i8 as amount
  where: amount.ship_id = ship.ship_id
  more_than: 12345678901234566
alert: "{sum}"
boundaries: auto
examples:
  - name: seventeen digit total
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S050, name: Tern, status: A}]
      ZOSD_L2_AGGNUM: [{id: A050, ship_id: S050, i8: 12345678901234567}]
    expect: ["12345678901234567"]
`);
      const int8Out = join(scratch, "aggregate_int8_alert");
      const int8 = await buildRule(int8Rule, int8Out, {registry: aggRegistry});
      expect(int8.model.aggregate.accumulator_type).to.equal("int8");
      expect(int8.model.examples[0].expect.map((entry) => entry.value)).to.deep.equal(["12345678901234567"]);
      const int8Abap = readFileSync(join(int8Out, "zcl_l2_aggregate_int8_alert.clas.abap"), "utf8");
      expect(int8Abap).to.include("DATA lv_aggregate TYPE int8.");
      expect(int8Abap).to.include("DATA lv_aggregate_integer TYPE int8.");
      expect(int8Abap).to.not.match(/DATA lv_count(?:_text)? TYPE/);

      const int8BoundaryRule = join(scratch, "aggregate_int8_boundary.l2.yaml");
      writeFileSync(int8BoundaryRule, readFileSync(int8Rule, "utf8")
        .replace("more_than: 12345678901234566", "more_than: 9223372036854775807")
        .replace('expect: ["12345678901234567"]', "expect: []"));
      const int8Boundary = compileRule(int8BoundaryRule, {registry: aggRegistry});
      expect(int8Boundary.cases.map((c) => c.method)).to.not.include("b_sum_above");
      expect(int8Boundary.skipped.some((entry) =>
        entry.case === "above" && entry.reason.includes("outside the INT8 sum range"))).to.equal(true);

      const int4Rule = join(scratch, "aggregate_int4_alert.l2.yaml");
      writeFileSync(int4Rule, `rule: aggregate-int4-alert
class: zcl_l2_aggregate_int4_alert
title: Integer alert keeps its leading sign
for: ZOSD_L2_SHIP as ship
limit:
  sum: ZOSD_L2_AGGINT.int_value as amount
  where: amount.ship_id = ship.ship_id
  more_than: -4
alert: "{sum}"
examples:
  - name: negative integer total
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S050, name: Tern, status: A}]
      ZOSD_L2_AGGINT: [{id: A050, ship_id: S050, int_value: -3}]
    expect: ["-3"]
`);
      const int4 = await runRule(int4Rule, "zcl_l2_aggregate_int4_alert", {ruleRegistry: aggRegistry,
        tables: [...FLEET, "zosd_l2_aggint.tabl.xml", "zosd_l2_a_i4.dtel.xml"],
        tableDir: runtimeDdic, fixture: ["zosd_l2_aggint"]});
      expect(int4.model.aggregate.accumulator_type).to.equal("int8");
      expect(failed(int4.results), JSON.stringify(int4.messages)).to.deep.equal([]);

      const int4Out = join(scratch, "aggregate_int4_alert");
      await buildRule(int4Rule, int4Out, {registry: aggRegistry});
      const int4Abap = readFileSync(join(int4Out, "zcl_l2_aggregate_int4_alert.clas.abap"), "utf8");
      const int4TestAbap = readFileSync(join(int4Out, "zcl_l2_aggregate_int4_alert.clas.testclasses.abap"), "utf8");
      const integerFormatter = /IF lv_aggregate = -9223372036854775807 - 1\.\s+lv_aggregate_text = '9223372036854775808'\.\s+ELSE\.\s+lv_aggregate_integer = lv_aggregate\.\s+IF lv_aggregate < 0\.\s+lv_aggregate_integer = 0 - lv_aggregate\.\s+ENDIF\.\s+lv_aggregate_text = lv_aggregate_integer\.\s+CONDENSE lv_aggregate_text NO-GAPS\.\s+ENDIF\.\s+IF lv_aggregate < 0\.\s+CONCATENATE `-` lv_aggregate_text INTO lv_aggregate_signed\.\s+lv_aggregate_text = lv_aggregate_signed\.\s+ENDIF\./g;
      const hasIntegerSignFormatter = (source) => {
        const conversions = (source.match(/lv_aggregate_text = lv_aggregate_integer\./g) ?? []).length;
        const explicit = [...source.matchAll(integerFormatter)].length;
        return conversions > 0 && explicit === conversions;
      };
      expect(hasIntegerSignFormatter(int4Abap), "generated check formats the INT8 magnitude before the sign").to.equal(true);
      expect(hasIntegerSignFormatter(int4TestAbap), "generated reference test formats the INT8 magnitude before the sign").to.equal(true);
      const sapSignMutant = int4Abap.replace(/\s+IF lv_aggregate < 0\.\s+lv_aggregate_integer = 0 - lv_aggregate\.\s+ENDIF\./g, "")
        .replace(/\s+IF lv_aggregate < 0\.\s+CONCATENATE `-` lv_aggregate_text INTO lv_aggregate_signed\.\s+lv_aggregate_text = lv_aggregate_signed\.\s+ENDIF\./g, "");
      expect(hasIntegerSignFormatter(sapSignMutant), "the SAP trailing-sign mutant is rejected by the code-shape oracle").to.equal(false);
    });

    it("refuses fewer_than and exactly for min and max because their empty result is undefined", () => {
      for (const operation of ["min", "max"]) for (const threshold of ["fewer_than: 2.00", "exactly: 2.00"]) {
        const source = `rule: empty-extreme\nclass: zcl_l2_empty_extreme\ntitle: t\nfor: ZOSD_L2_SHIP as ship\nlimit:\n  ${operation}: ZOSD_L2_CARGO.weight as cargo\n  where: cargo.ship_id = ship.ship_id\n  ${threshold}\nalert: \"{${operation}}\"\nexamples:\n  - name: empty\n    date: 20261001\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S060, name: Tern, status: A}]\n    expect: []\n`;
        const file = join(scratch, `empty_${operation}_${threshold.split(":")[0]}.l2.yaml`);
        writeFileSync(file, source);
        const line = source.split("\n").findIndex((entry) => entry.includes(threshold)) + 1;
        expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`:${line}: ${operation} is undefined for an empty group`));
      }
    });
  });

  describe("row rules", () => {
    const source = readFileSync(ROW, "utf8");
    const compile = (name, text) => {
      const file = join(scratch, `row-${name}.l2.yaml`);
      writeFileSync(file, text);
      return compileRule(file, {registry});
    };

    it("compiles the row-rule example from the documentation", async () => {
      const section = readFileSync("docs/dsl-l2.md", "utf8").split("### Row rules")[1];
      const text = section.split("```yaml\n")[1].split("```")[0];
      const model = compile("documentation", text);
      const {findings} = await renderRule(model);
      expect(findings).to.deep.equal([]);
      expect(evaluate(model, {zosd_l2_ship: [{ship_id: "S001", name: "Albatross", status: "M"}]}))
        .to.deep.equal(["S001 Albatross: grounded"]);
    });

    it("uses the existing model without exists clauses and derives only when boundaries", () => {
      const model = compileRule(ROW, {registry});
      expect(model.kind).to.equal("row");
      expect(model.clauses).to.deep.equal([]);
      expect(model.tables.map((t) => t.table)).to.deep.equal(["zosd_l2_ship"]);
      expect(model.cases.length).to.be.greaterThan(0);
      expect(model.skipped).to.deep.equal([]);
      for (const c of model.cases) {
        expect(c.derived.condition).to.match(/^when\//);
        expect(caseDiscriminates(model, conditionOf(model, c.derived.condition),
          Object.fromEntries(c.tables.map((t) => [t.table, t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))])),
          {date: c.date.value, maintenance: "M"}), c.method).to.equal(true);
      }
    });

    it("refuses a missing when at the forbid line", () => {
      const text = source.replace(/^when:.*\n/m, "");
      const at = text.split("\n").findIndex((l) => l === "forbid: row") + 1;
      expect(() => compile("no-when", text)).to.throw(RuleError,
        new RegExp(`:${at}: forbid: row needs when:`));
    });

    it("refuses alert holes naming any other alias", () => {
      expect(() => compile("alias", source.replace("{ship.name}", "{voy.name}")))
        .to.throw(RuleError, /unknown alias voy/);
    });

    for (const [name, from, to, reason] of [
      ["foreign alias in when", "when: ship.status", "when: voy.status", /unknown alias voy/],
      ["all alongside row", "forbid: row", "forbid: row\nall: []", /unknown key all/],
      ["any alongside row", "forbid: row", "forbid: row\nany: []", /unknown key any/],
      ["row inside all", "forbid: row", "forbid: {all: [row, row]}", /must be a mapping/],
      ["row inside any", "forbid: row", "forbid: {any: [row, row]}", /must be a mapping/],
      ["row with limit", "forbid: row", "forbid: row\nlimit: {}", /exactly one of forbid:, require:, or limit:/],
      ["row with require", "forbid: row", "forbid: row\nrequire: {}", /a rule has forbid or require, not both/],
    ]) it(`refuses ${name}`, () => {
      expect(() => compile(name.replaceAll(" ", "-"), source.replace(from, to))).to.throw(RuleError, reason);
    });

    it("refuses row combined with exists keys or another rule kind", () => {
      for (const forbid of [
        "forbid: {row: true, exists: ZOSD_L2_VOY as voy}",
        "forbid: {exists: ZOSD_L2_VOY as voy, where: voy.ship_id = ship.ship_id, row: true}",
      ]) expect(() => compile("exists", source.replace("forbid: row", forbid)))
        .to.throw(RuleError, /unknown key forbid.row/);
      for (const extra of ["exists: ZOSD_L2_VOY as voy", "where: voy.ship_id = ship.ship_id"]) {
        expect(() => compile("extra-key", source.replace("forbid: row", `forbid: row\n${extra}`)))
          .to.throw(RuleError, /unknown key (exists|where)/);
      }
      expect(() => compile("require", source.replace("forbid: row", "forbid: row\nrequire: {}")))
        .to.throw(RuleError, /a rule has forbid or require, not both/);
    });

    it("the interpreter emits one alert per matching row in key order and honors params and range", () => {
      const model = compileRule(ROW, {registry});
      const rows = {zosd_l2_ship: [
        {ship_id: "S003", name: "Petrel", status: "D"},
        {ship_id: "S001", name: "Albatross", status: "M"},
        {ship_id: "S002", name: "Tern", status: "A"},
      ]};
      expect(evaluate(model, rows, {date: "20261001", maintenance: "M"}))
        .to.deep.equal(["S001 Albatross: grounded (M)", "S003 Petrel: grounded (D)"]);
      expect(evaluate(model, rows, {date: "20261001", maintenance: "A",
        $range: [{sign: "I", option: "EQ", low: "S002"}]}))
        .to.deep.equal(["S002 Tern: grounded (A)"]);
    });

    it("lowers to the committed single-table SELECT snapshot with parentheses and line origins", async () => {
      const model = compileRule(ROW, {registry, out: OUT});
      const {files, findings} = await renderRule(model);
      const abap = files[`${model.class}.clas.abap`];
      const check = abap.split("  METHOD check.")[1].split("  ENDMETHOD.")[0];
      expect(check.match(/\bSELECT\b/g)).to.have.length(1);
      expect(check).to.not.match(/JOIN|EXISTS/);
      expect(check).to.include("      FROM zosd_l2_ship AS ship");
      expect(check).to.include("      WHERE ( ship~status = iv_maintenance\n           OR ship~status = 'D' )\n        AND ship~ship_id IN it_range");
      expect(check).to.include("      ORDER BY\n        ship~ship_id.");
      expect(abap).to.equal(readFileSync(join(OUT, `${model.class}.clas.abap`), "utf8"));
      expect(findings).to.deep.equal([]);
      const trace = JSON.parse(files[`${model.class}.clas.trace.json`]);
      expect(trace.format).to.equal("osd-trace/1");
      const meta = JSON.parse(files[`${model.class}.clas.trace.meta.json`]);
      const whereLine = abap.split("\n").findIndex((l) => l.includes("WHERE ( ship~status")) + 1;
      const origin = meta.lines.find((l) => l.line === whereLine);
      expect(origin.node).to.equal("rule/grounded-ship/when/1");
      expect(origin.rule_line).to.equal(9);
      expect(abap.split("\n").every((l) => l.length <= 255)).to.equal(true);
      expect(model.queries[0].where.filter((l) => l.is_cmp).map((l) => l.rule_line))
        .to.include(source.split("\n").findIndex((l) => l.startsWith("when:")) + 1);
    });

    it("the generated ABAP Unit runs every example and derived case, including keys and reference", async () => {
      await import("./start.mjs");
      const model = compileRule(ROW, {registry});
      const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", model.class.toUpperCase());
      const count = model.examples.length + model.cases.length;
      expect(result.counts, JSON.stringify(result.testClasses)).to.include({methods: count, passed: count, failed: 0});
      expect(result.ok).to.equal(true);
    });
  });

  // The mutants change the rule in the ABAP -- the query and the reference
  // alike -- and leave the expectations as the unmutated rule derived them:
  // a rule file edited instead would change the interpreter's answers too.
  const mutateBoth = (from, to) => ({"clas.abap": [[from, to]], "clas.testclasses.abap": [[from.replace(/^\w+~/, ""), to.replace(/^\w+~/, "")]]});


  describe("the examples and the derived cases prove the rule", () => {
    it("ABAP Unit of the generated test class runs green in this runtime", async () => {
      const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", CLASS.toUpperCase());
      const methods = result.testClasses.flatMap((c) => c.testMethods);
      expect(methods.map((m) => m.name)).to.deep.equal(["FLAGGED", "PAST_VOYAGE_IS_FINE", "DEPARTS_ON_THE_CHECK_DATE",
        "SHIP_IN_SERVICE_IS_FINE", "ONE_ALERT_PER_VOYAGE", "THE_RANGE_KEEPS_THE_INNER_SHIP", ...DERIVED]);
      expect(result.counts, JSON.stringify(result.testClasses)).to.include({methods: 16, passed: 16, failed: 0});
      expect(result.ok).to.equal(true);
    });

    before(async () => {
      await import("./start.mjs");
    });

    it("the rule as written: every example and every derived case passes", async () => {
      const file = variant("as_written", "class: zcl_l2_maintenance_ship", "class: zcl_l2_as_written");
      const {results} = await runRule(file, "zcl_l2_as_written");
      expect(Object.keys(results)).to.have.length(16);
      expect(failed(results)).to.deep.equal([]);
    });

    it("> changed to >= : the derived case on the check date fails, and so does the written example", async () => {
      const file = variant("mutant_ge", "class: zcl_l2_maintenance_ship", "class: zcl_l2_mutant_ge");
      const {results} = await runRule(file, "zcl_l2_mutant_ge", {mutate: mutateBoth("voy~dep_date > iv_date", "voy~dep_date >= iv_date")});
      expect(failed(results)).to.deep.equal(["b_dep_date_eq", "departs_on_the_check_date"]);
    });

    it("> changed to >= : with the hand-written boundary example removed, the derived case alone catches it", async () => {
      const text = RULE_TEXT.replace("class: zcl_l2_maintenance_ship", "class: zcl_l2_mutant_alone");
      const from = text.indexOf("  - name: departs on the check date");
      const to = text.indexOf("  - name: ship in service is fine");
      expect(from).to.be.greaterThan(0);
      expect(to).to.be.greaterThan(from);
      const file = join(scratch, "mutant_alone.l2.yaml");
      writeFileSync(file, text.slice(0, from) + text.slice(to));
      const {model, results} = await runRule(file, "zcl_l2_mutant_alone", {mutate: mutateBoth("voy~dep_date > iv_date", "voy~dep_date >= iv_date")});
      expect(model.examples.map((e) => e.method)).to.not.include("departs_on_the_check_date");
      expect(failed(results)).to.deep.equal(["b_dep_date_eq"]);
    });

    it("status = 'M' changed to <> : derived cases fail", async () => {
      const file = variant("mutant_ne", "class: zcl_l2_maintenance_ship", "class: zcl_l2_mutant_ne");
      const {results} = await runRule(file, "zcl_l2_mutant_ne", {mutate: mutateBoth("ship~status = 'M'", "ship~status <> 'M'")});
      const red = failed(results);
      for (const method of ["b_status_eq", "b_status_ne", "b_status_blank"]) expect(red, `${method} in ${red}`).to.include(method);
      expect(red.filter((m) => m.startsWith("b_")).length).to.be.greaterThan(3);
    });

    it("a JOIN that lost its ON equality is caught by the comparison with check_reference", async () => {
      const file = variant("mutant_join", "class: zcl_l2_maintenance_ship", "class: zcl_l2_mutant_join");
      const {results, messages} = await runRule(file, "zcl_l2_mutant_join", {
        mutate: {"clas.abap": [["ON voy~ship_id = ship~ship_id", "ON ship~ship_id = ship~ship_id"]]}});
      const red = failed(results);
      expect(red).to.include("one_alert_per_voyage");
      expect(red).to.include("b_ship_id_nomatch");
      for (const method of red) expect(messages[method], method).to.include("assert_same_as_reference");
    });
  });

  describe("one query instead of a SELECT per row", () => {
    const db = () => globalThis.abap.context.databaseConnections.DEFAULT;
    const insert = async (table, columns, values) => {
      const mandt = globalThis.abap.builtin.sy.get().mandt.get();
      await db().execute(`INSERT INTO ${table} (mandt, ${columns.join(", ")}) VALUES ('${mandt}', ${values.map((v) => `'${v}'`).join(", ")})`);
    };
    before(async () => {
      await import("./start.mjs");
      await import(`../output/${CLASS}.clas.mjs`);
      await import(`../output/${CLASS}.clas.testclasses.mjs`);
    });

    it("check makes one database call whatever the number of for rows; check_reference makes 1 + n", async () => {
      const abap = globalThis.abap;
      const n = 6;
      try {
        for (let i = 1; i <= n; i++) {
          await insert("zosd_l2_ship", ["ship_id", "name", "status"], [`Q${i}`, `Ship ${i}`, "M"]);
          await insert("zosd_l2_voy", ["voyage_id", "ship_id", "dep_date"], [`QV${i}`, `Q${i}`, "20261005"]);
        }
        const counted = async (run) => {
          const original = db().select.bind(db());
          let calls = 0;
          db().select = async (options) => { calls++; return original(options); };
          try {
            return {alerts: (await run()).array().map((a) => a.get()), calls};
          } finally {
            db().select = original;
          }
        };
        const date = new abap.types.Date().set("20261001");
        const joined = await counted(() => abap.Classes.ZCL_L2_MAINTENANCE_SHIP.check({iv_date: date}));
        const test = await new (await import(`../output/${CLASS}.clas.testclasses.mjs`)).ltcl_examples().constructor_();
        const nested = await counted(() => test.FRIENDS_ACCESS_INSTANCE.check_reference({iv_date: date}));
        expect(joined.alerts).to.have.length(n);
        expect(joined.calls, "one SELECT").to.equal(1);
        expect(nested.calls, "1 + n SELECTs").to.equal(1 + n);
        expect(nested.alerts).to.deep.equal(joined.alerts);
      } finally {
        await db().execute("DELETE FROM zosd_l2_voy");
        await db().execute("DELETE FROM zosd_l2_ship");
      }
    });
  });

  describe("the interpreter", () => {
    const rowsOfNode = (test) => Object.fromEntries(test.tables.map((t) => [t.table,
      t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));

    it("agrees with the committed examples and with its own derived cases", () => {
      const model = compileRule(RULE, {registry});
      expect(model.examples).to.have.length(6);
      expect(model.cases).to.have.length(10);
      for (const t of [...model.examples, ...model.cases]) {
        const got = evaluate(model, rowsOfNode(t), {date: t.date.value, $range: t.range_args ?? []});
        expect(got.sort(), t.method).to.deep.equal(t.expect.map((e) => e.value).sort());
      }
    });

    it("a wrong hand-written expect fails the build with the example's line", () => {
      const from = '    expect: []\n  - name: departs on the check date';
      expect(RULE_TEXT).to.include(from);
      const file = join(scratch, "wrong-expect.l2.yaml");
      const text = RULE_TEXT.replace(from, '    expect: ["nothing like this"]\n  - name: departs on the check date');
      writeFileSync(file, text);
      const where = relative(process.cwd(), file).split(sep).join("/");
      const line = text.split("\n").findIndex((l) => /expect: \["nothing like this"\]/.test(l)) + 1;
      expect(() => compileRule(file, {registry})).to.throw(RuleError, new RegExp(`^${where.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:${line}: example "past voyage is fine" expects \\["nothing like this"\\] but the rule gives \\[\\]`));
    });

    it("a wrong rule is found against the examples as well: > written as >= with the examples kept", () => {
      const file = variant("wrong-rule", "voy.dep_date > $date", "voy.dep_date >= $date");
      expect(() => compileRule(file, {registry})).to.throw(RuleError, /example "departs on the check date" expects \[\] but the rule gives \["S001 Albatross/);
    });

    describe("DDIC stepping", () => {
      const DATS = {built_in: "DATS", length: 8};
      it("DATS over a month end, a year end and 29 February, and back", () => {
        const steps = [["20260930", 1, "20261001"], ["20261001", -1, "20260930"], ["20261231", 1, "20270101"], ["20270101", -1, "20261231"],
          ["20260228", 1, "20260301"], ["20240228", 1, "20240229"], ["20240229", 1, "20240301"], ["20240301", -1, "20240229"],
          ["20000228", 1, "20000229"], ["20000301", -1, "20000229"], ["19000228", 1, "19000301"], ["19000301", -1, "19000228"],
          ["20260131", 1, "20260201"], ["20260301", -1, "20260228"]];
        for (const [from, dir, to] of steps) expect(stepValue(DATS, from, dir), `${from} ${dir}`).to.equal(to);
      });
      it("DATS refuses what is not a date and what leaves the range", () => {
        for (const [from, dir] of [["20260231", 1], ["20261301", 1], ["00000000", 1], ["99991231", 1], ["00010101", -1], ["2026", 1]]) {
          expect(stepValue(DATS, from, dir), `${from} ${dir}`).to.equal(undefined);
        }
      });
      it("TIMS by the second, NUMC and INT by one, each refusing its edge", () => {
        const TIMS = {built_in: "TIMS", length: 6}, NUMC = {built_in: "NUMC", length: 3};
        expect(stepValue(TIMS, "235958", 1)).to.equal("235959");
        expect(stepValue(TIMS, "235959", 1)).to.equal(undefined);
        expect(stepValue(TIMS, "000000", -1)).to.equal(undefined);
        expect(stepValue(TIMS, "115959", 1)).to.equal("120000");
        expect(stepValue(NUMC, "009", 1)).to.equal("010");
        expect(stepValue(NUMC, "999", 1)).to.equal(undefined);
        expect(stepValue(NUMC, "000", -1)).to.equal(undefined);
        expect(stepValue({built_in: "INT1"}, "255", 1)).to.equal(undefined);
        expect(stepValue({built_in: "INT1"}, "0", -1)).to.equal(undefined);
        expect(stepValue({built_in: "INT4"}, "-1", -1)).to.equal("-2");
      });
      it("DEC steps by 10^-decimals, carrying over, and stays inside its precision", () => {
        const DEC2 = {built_in: "DEC", length: 5, decimals: 2}, DEC0 = {built_in: "DEC", length: 3, decimals: 0};
        expect(stepValue(DEC2, "12.50", 1)).to.equal("12.51");
        expect(stepValue(DEC2, "12.50", -1)).to.equal("12.49");
        expect(stepValue(DEC2, "12.99", 1)).to.equal("13.00");
        expect(stepValue(DEC2, "0.00", -1)).to.equal("-0.01");
        expect(stepValue(DEC2, "999.99", 1)).to.equal(undefined);
        expect(stepValue(DEC0, "41", 1)).to.equal("42");
      });
      it("CHAR compares without its trailing blanks; a blank is initial; a different value has the same length", () => {
        const CHAR = {built_in: "CHAR", length: 4};
        expect(compareValues(CHAR, "AB  ", CHAR, "AB")).to.equal(0);
        expect(compareValues(CHAR, "", CHAR, "  ")).to.equal(0);
        expect(compareValues(CHAR, "AB", CHAR, "AC")).to.equal(-1);
        expect(bump("M", 1)).to.equal("N");
        expect(bump("M", -1)).to.equal("L");
        expect(bump("AZ", -1)).to.equal("AY");
        expect(bump("", 1)).to.equal("A");
      });
    });

    it("the derived cases of the demo name, in the reviewer's view, every case and its expected alerts", () => {
      const text = describeCases(compileRule(RULE, {registry}));
      expect(text).to.contain("10 derived case(s)");
      expect(text).to.match(/b_dep_date_eq .*\n  date 20261001\n(.*\n)*.*dep_date="20261001"\n  expect: no alert/);
      expect(text).to.match(/b_status_blank .*\n(.*\n)*.*status=""/);
      const run = spawnSync(process.execPath, ["tools/dsl-l2.mjs", "cases", RULE], {encoding: "utf8"});
      expect(run.status, run.stderr).to.equal(0);
      expect(run.stdout.trim()).to.equal(text.trim());
    });
  });

  describe("a derived case must discriminate", () => {
    const head = (name, where, seq = "1") => `rule: ${name}
class: zcl_l2_${name.replaceAll("-", "_")}
title: a rule whose conditions share a field
for: ZOSD_L2_NUMA as n
forbid:
  exists: ZOSD_L2_NUMB as m
  where: ${where}
alert: "{n.id} {m.seq}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_NUMA: [{id: A001, lvl: 1}]
      ZOSD_L2_NUMB: [{id: A001, seq: ${seq}, amt: 1.00, cnt: 0}]
    expect: ["A001 ${seq}"]
`;
    let reg;
    before(() => { reg = registryFor([fixtureDdic(), ".local/lars/open-abap-core/src"], []); });
    const compile = (name, text) => {
      const f = join(scratch, `${name}.l2.yaml`);
      writeFileSync(f, text);
      return compileRule(f, {registry: reg});
    };
    const rowsOf = (t) => Object.fromEntries(t.tables.map((x) => [x.table, x.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));
    const discriminating = (model) => model.cases.filter((c) => c.derived.condition !== "forbid").every((c) =>
      caseDiscriminates(model, conditionOf(model, c.derived.condition), rowsOf(c), {date: c.date.value}));

    it("critic 1: b.id = a.id and b.id <> 'X': the cases of <> 'X' keep b.id as tested, and <> 'Y' is caught", () => {
      const text = head("critic-one", "m.id = n.id and m.id <> 'X'");
      const model = compile("critic-one", text);
      expect(discriminating(model)).to.equal(true);
      const mine = model.cases.filter((c) => c.derived.condition === "forbid/where/2");
      const idOf = (c) => rowsOf(c).zosd_l2_numb[0].id;
      expect(mine.length + model.skipped.filter((k) => k.condition.startsWith("m.id <> 'X'")).length).to.equal(3);
      for (const k of model.skipped) expect(k.reason).to.match(/^does not isolate |^no /);
      // the tested value is kept: the eq case has b.id = X, the ne case b.id != X
      expect(mine.map((c) => [c.derived.kind, idOf(c) === "X"])).to.deep.include.members([["eq", true]]);
      const mutated = compile("critic-one-y", text.replace("m.id <> 'X'", "m.id <> 'Y'").replace("class: zcl_l2_critic_one", "class: zcl_l2_critic_oney"));
      const caught = mine.some((c) => JSON.stringify(evaluate(mutated, rowsOf(c), {date: c.date.value})) !== JSON.stringify(c.expect.map((e) => e.value)));
      expect(caught, "some emitted case distinguishes <> 'Y' from <> 'X'").to.equal(true);
    });

    it("critic 2: b.id = a.id and b.seq <= 1: the second exists row still satisfies the where, so two alerts", () => {
      const model = compile("critic-two", head("critic-two", "m.id = n.id and m.seq <= 1"));
      expect(discriminating(model)).to.equal(true);
      const two = model.cases.find((c) => c.method === "b_exists_two");
      if (two) expect(two.expect, "two alerts").to.have.length(2);
      else expect(model.skipped.map((k) => k.reason).join("\n")).to.match(/does not isolate/);
      expect(two, "it is emitted here: seq 0 satisfies <= 1").to.not.equal(undefined);
      expect(rowsOf(two).zosd_l2_numb.map((r) => r.seq)).to.deep.equal(["1", "0"]);
    });

    it("a rule whose exists key cannot vary lists the two case as skipped with a reason", () => {
      const model = compile("critic-three", head("critic-three", "m.id = n.id and m.seq = 1"));
      expect(model.cases.map((c) => c.method)).to.not.include("b_exists_two");
      expect(model.skipped.map((k) => k.reason).join("\n")).to.match(/does not isolate the exists/);
    });

    it("the guard itself: rows that no mutant of the condition changes do not discriminate", () => {
      const model = compile("guard", head("guard", "m.id = n.id and m.seq <= 1"));
      const cond = conditionOf(model, "forbid/where/2");
      const params = {date: "20261001"};
      const row = {zosd_l2_numa: [{id: "A001", lvl: "1"}], zosd_l2_numb: [{id: "A001", seq: "1", amt: "1.00", cnt: "0"}]};
      expect(caseDiscriminates(model, cond, row, params), "seq = 1 sits on the boundary").to.equal(true);
      const far = {zosd_l2_numa: [{id: "A001", lvl: "1"}], zosd_l2_numb: [{id: "A001", seq: "100", amt: "1.00", cnt: "0"}]};
      expect(caseDiscriminates(model, cond, far, params), "seq = 100: dropping the condition or testing = changes the result").to.equal(true);
      const nothing = {zosd_l2_numa: [{id: "A001", lvl: "1"}], zosd_l2_numb: []};
      expect(caseDiscriminates(model, cond, nothing, params), "no exists row: nothing to decide").to.equal(false);
    });

    it("every derived case of the demo and of the synthetic rule discriminates", () => {
      expect(discriminating(compileRule(RULE, {registry}))).to.equal(true);
      const agree = compile("disc-agree", `rule: disc-agree
class: zcl_l2_disc_agree
title: t
for: ZOSD_L2_NUMA as n
when: n.lvl >= 3 and n.lvl <> 7
forbid:
  exists: ZOSD_L2_NUMB as m
  where: m.id = n.id and m.amt <= 12.5 and m.cnt < n.lvl
alert: "{n.id} {m.seq}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_NUMA: [{id: A001, lvl: 5}]
      ZOSD_L2_NUMB: [{id: A001, seq: 1, amt: 10.50, cnt: 2}]
    expect: ["A001 1"]
`);
      expect(discriminating(agree)).to.equal(true);
    });
  });

  describe("field-to-field types and NUMC", () => {
    const rule = (name, when, where, alert, rows) => `rule: ${name}
class: zcl_l2_${name.replaceAll("-", "_")}
title: t
for: ZOSD_L2_NUMA as n
${when}forbid:
  exists: ZOSD_L2_NUMB as m
  where: ${where}
alert: "${alert}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_NUMA: [${rows[0]}]
      ZOSD_L2_NUMB: [${rows[1]}]
    expect: [${rows[2]}]
`;
    let reg;
    before(() => { reg = registryFor([fixtureDdic(), ".local/lars/open-abap-core/src"], []); });
    const file = (name, text) => { const f = join(scratch, `${name}.l2.yaml`); writeFileSync(f, text); return f; };

    for (const [what, where, message] of [
      ["NUMC 6 against NUMC 4", "m.id = n.id and m.n6 = n.n4", /m\.n6 is NUMC 6, n\.n4 is NUMC 4; a field-to-field comparison needs the same type, length and decimals/],
      ["CHAR 4 against CHAR 10", "m.id = n.id and m.c4 = n.code", /m\.c4 is CHAR 4, n\.code is CHAR 10; a field-to-field/],
    ]) {
      it(`${what} is refused at the where line`, () => {
        const f = file(`s1-${what.replace(/\W+/g, "")}`, rule("s1", "", where, "{n.id}", ["{id: A001, lvl: 1}", "{id: A001, seq: 1}", '"A001"']));
        const line = readFileSync(f, "utf8").split("\n").findIndex((l) => /^\s+where:/.test(l)) + 1;
        expect(() => compileRule(f, {registry: reg})).to.throw(RuleError, new RegExp(`:${line}: `));
        expect(() => compileRule(f, {registry: reg})).to.throw(RuleError, message);
      });
    }

    const NUMC_RULE = () => rule("numc-short", "when: n.n4 = '12'\n", "m.id = n.id", "{n.id} {n.n4}",
      ["{id: A001, lvl: 1, n4: '12'}", "{id: A001, seq: 1}", '"A001 0012"']);

    it("a short NUMC literal, example value and hole read as the DDIC length: the expect is the padded text", () => {
      const model = compileRule(file("numc-short", NUMC_RULE()), {registry: reg});
      expect(model.cases.length).to.be.greaterThan(3);
      for (const c of model.cases.filter((x) => x.expect.length)) expect(c.expect[0].value).to.match(/^A001 (0012|0011|0013)$/);
      expect(model.cases.find((c) => c.method === "b_n4_eq").expect.map((e) => e.value)).to.deep.equal(["A001 0012"]);
    });

    it("and ABAP agrees on every case of it", async () => {
      const f = file("numc-abap", NUMC_RULE().replace("zcl_l2_numc_short", "zcl_l2_numc_abap"));
      const {results, messages} = await runRule(f, "zcl_l2_numc_abap", {ruleRegistry: reg, fixture: true,
        tables: ["zosd_l2_numa.tabl.xml", "zosd_l2_numb.tabl.xml", "zosd_l2_t_i1.dtel.xml", "zosd_l2_t_dec.dtel.xml"], tableDir: join(scratch, "num-ddic")});
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
    });

    it("an example name that makes the comparison message too long for a literal is refused", () => {
      const f = file("long-name", NUMC_RULE().replace("name: fires", `name: a${"!".repeat(225)}b`));
      expect(() => compileRule(f, {registry: reg})).to.throw(RuleError, /example name with the comparison message/);
    });
  });

  describe("the interpreter and the ABAP agree on INT and DEC fields (a synthetic rule)", () => {
    const RULE_AGREE = `rule: numeric-agreement
class: zcl_l2_numeric_agreement
title: a synthetic rule over integer and packed fields
for: ZOSD_L2_NUMA as n
when: n.lvl >= 3 and n.lvl <> 7
forbid:
  exists: ZOSD_L2_NUMB as m
  where: m.id = n.id and m.amt <= 12.5 and m.cnt < n.lvl
alert: "{n.id} {n.lvl} {m.seq} {m.cnt}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_NUMA: [{id: A001, lvl: 5}]
      ZOSD_L2_NUMB: [{id: A001, seq: 1, amt: 10.50, cnt: 2}]
    expect: ["A001 5 1 2"]
`;
    let ruleRegistry, file;
    before(async () => {
      await import("./start.mjs");
      ruleRegistry = registryFor([fixtureDdic(), ".local/lars/open-abap-core/src"], []);
      file = join(scratch, "agree.l2.yaml");
      writeFileSync(file, RULE_AGREE);
    });

    it("derives lt, eq and gt for <=, >=, <> and a field comparison, match and nomatch for the join, two structural cases", () => {
      const model = compileRule(file, {registry: ruleRegistry});
      const by = Object.fromEntries(model.cases.map((c) => [c.method, c]));
      expect(Object.keys(by)).to.deep.equal([
        "b_lvl_lt", "b_lvl_eq", "b_lvl_gt", "b_n_lvl_lt", "b_n_lvl_eq", "b_n_lvl_gt", "b_id_match", "b_id_nomatch",
        "b_amt_lt", "b_amt_eq", "b_amt_gt", "b_cnt_lt", "b_cnt_eq", "b_cnt_gt", "b_exists_zero", "b_exists_two"]);
      const value = (method, table, column) => by[method].tables.find((t) => t.table === table).rows[0].fields.find((f) => f.column === column).value;
      expect(["b_lvl_lt", "b_lvl_eq", "b_lvl_gt"].map((m) => value(m, "zosd_l2_numa", "lvl"))).to.deep.equal(["2", "3", "4"]);
      expect(["b_n_lvl_lt", "b_n_lvl_eq", "b_n_lvl_gt"].map((m) => value(m, "zosd_l2_numa", "lvl"))).to.deep.equal(["6", "7", "8"]);
      expect(["b_amt_lt", "b_amt_eq", "b_amt_gt"].map((m) => value(m, "zosd_l2_numb", "amt"))).to.deep.equal(["12.49", "12.50", "12.51"]);
      expect(by.b_lvl_lt.expect).to.deep.equal([]);
      expect(by.b_amt_gt.expect).to.deep.equal([]);
      expect(by.b_amt_eq.expect.map((e) => e.value)).to.deep.equal(["A001 5 1 2"]);
      expect(by.b_exists_two.expect).to.have.length(2);
    });

    it("every generated case passes in ABAP with the interpreter's alerts (<=, >=, <> included)", async () => {
      const {model, results, messages} = await runRule(file, "zcl_l2_numeric_agreement",
        {ruleRegistry, tables: ["zosd_l2_numa.tabl.xml", "zosd_l2_numb.tabl.xml", "zosd_l2_t_i1.dtel.xml", "zosd_l2_t_dec.dtel.xml"],
          tableDir: join(scratch, "num-ddic"), fixture: true});
      expect(model.cases).to.have.length(16);
      expect(Object.keys(results)).to.have.length(17);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
    });

    it("and it notices a mutated comparison: <= changed to < fails the eq case", async () => {
      // its own class name: a module of the same path would come out of the import cache
      const mutant = join(scratch, "agree_mut.l2.yaml");
      writeFileSync(mutant, RULE_AGREE.replace("zcl_l2_numeric_agreement", "zcl_l2_numeric_mutant"));
      const {results} = await runRule(mutant, "zcl_l2_numeric_mutant",
        {ruleRegistry, tables: ["zosd_l2_numa.tabl.xml", "zosd_l2_numb.tabl.xml", "zosd_l2_t_i1.dtel.xml", "zosd_l2_t_dec.dtel.xml"],
          tableDir: join(scratch, "num-ddic"), fixture: true,
          mutate: mutateBoth("m~amt <= '12.5'", "m~amt < '12.5'")});
      expect(failed(results)).to.deep.equal(["b_amt_eq"]);
    });

    it("and <> changed to = fails the eq case of the integer comparison", async () => {
      const mutant = join(scratch, "agree_mut2.l2.yaml");
      writeFileSync(mutant, RULE_AGREE.replace("zcl_l2_numeric_agreement", "zcl_l2_numeric_mutant2"));
      const {results} = await runRule(mutant, "zcl_l2_numeric_mutant2",
        {ruleRegistry, tables: ["zosd_l2_numa.tabl.xml", "zosd_l2_numb.tabl.xml", "zosd_l2_t_i1.dtel.xml", "zosd_l2_t_dec.dtel.xml"],
          tableDir: join(scratch, "num-ddic"), fixture: true,
          mutate: mutateBoth("n~lvl <> 7", "n~lvl = 7")});
      const red = failed(results);
      expect(red).to.include("b_n_lvl_eq");
      expect(red).to.include("fires");
    });
  });

  // ---------------------------------------------------------------------
  // slice 3: or, not, several exists, require, no duplicate conditions

  const OR_NOT_TEXT = readFileSync(OR_NOT, "utf8");
  const REQUIRE_TEXT = readFileSync(REQUIRE, "utf8");
  const lineIn = (text, re) => text.split("\n").findIndex((l) => re.test(l)) + 1;
  const writeRule = (name, text) => {
    const f = join(scratch, `${name}.l2.yaml`);
    writeFileSync(f, text);
    return f;
  };
  const refusedAt = (file, message, at) => {
    const text = readFileSync(file, "utf8");
    const where = relative(process.cwd(), file).split(sep).join("/");
    const line = typeof at === "number" ? at : lineIn(text, at);
    expect(line, `a line matching ${at}`).to.be.greaterThan(0);
    let error;
    try {
      compileRule(file, {registry});
    } catch (e) {
      error = e;
    }
    expect(error, "an error").to.be.instanceOf(RuleError);
    expect(error.message.startsWith(`${where}:${line}: `), error.message).to.equal(true);
    expect(error.message.slice(`${where}:${line}: `.length)).to.match(message);
  };
  const rowsOfCase = (t) => Object.fromEntries(t.tables.map((x) => [x.table,
    x.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));

  // two synthetic rules over the three fleet tables: all and any
  const ALL_RULE = `rule: all-fixture
class: zcl_l2_all_fixture
title: a ship in maintenance with a voyage ahead and a captain or pilot aboard
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M'
forbid:
  all:
    - exists: ZOSD_L2_VOY as voy
      where: voy.ship_id = ship.ship_id and voy.dep_date > $date
    - exists: ZOSD_L2_CREW as crew
      where: crew.ship_id = ship.ship_id and (crew.role = 'C' or crew.role = 'P')
alert: "{ship.ship_id}: voyage {voy.voyage_id}, crew {crew.crew_id}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: C, since: 20260101}]
    expect: ["S001: voyage V00001, crew C00001"]
  - name: a pair per combination
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY:
        - {voyage_id: V00001, ship_id: S001, dep_date: 20261005}
        - {voyage_id: V00002, ship_id: S001, dep_date: 20261006}
      ZOSD_L2_CREW:
        - {crew_id: C00001, ship_id: S001, role: C, since: 20260101}
        - {crew_id: C00002, ship_id: S001, role: P, since: 20260101}
    expect: ["S001: voyage V00001, crew C00001", "S001: voyage V00001, crew C00002",
      "S001: voyage V00002, crew C00001", "S001: voyage V00002, crew C00002"]
  - name: no crew no alert
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect: []
`;
  const ANY_RULE = `rule: any-fixture
class: zcl_l2_any_fixture
title: a ship in maintenance with a voyage ahead or a captain or pilot aboard
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M'
forbid:
  any:
    - exists: ZOSD_L2_VOY as voy
      where: voy.ship_id = ship.ship_id and voy.dep_date > $date
      alert: "{ship.ship_id}: voyage {voy.voyage_id} ahead"
    - exists: ZOSD_L2_CREW as crew
      where: crew.ship_id = ship.ship_id and (crew.role = 'C' or crew.role = 'P')
alert: "{ship.ship_id} {ship.name}: crew aboard"
boundaries: auto
examples:
  - name: fires twice
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: C, since: 20260101}]
    expect: ["S001: voyage V00001 ahead", "S001 Albatross: crew aboard"]
  - name: only the crew
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: P, since: 20260101}]
    expect: ["S001 Albatross: crew aboard"]
`;

  describe("slice 3: the condition language", () => {
    const tree = (text) => {
      const strip = (n) => n.op === "cmp" ? `${n.left.text}${n.cmp}${n.right.text}` : n.op === "not" ? {not: strip(n.item)} : {[n.op]: n.items.map(strip)};
      return strip(parseCondition(text, (m) => { throw new Error(m); }));
    };

    it("not binds tighter than and, and than or", () => {
      expect(tree("a.x = 1 or a.y = 2 and not a.z = 3")).to.deep.equal({or: ["a.x=1", {and: ["a.y=2", {not: "a.z=3"}]}]});
      expect(tree("not a.x = 1 and a.y = 2")).to.deep.equal({and: [{not: "a.x=1"}, "a.y=2"]});
    });
    it("parentheses group, and an and inside an and is one and", () => {
      expect(tree("(a.x = 1 or a.y = 2) and a.z = 3")).to.deep.equal({and: [{or: ["a.x=1", "a.y=2"]}, "a.z=3"]});
      expect(tree("(a.x = 1 and a.y = 2) and a.z = 3")).to.deep.equal({and: ["a.x=1", "a.y=2", "a.z=3"]});
      expect(tree("not (a.x = 1 or not (a.y = 2))")).to.deep.equal({not: {or: ["a.x=1", {not: "a.y=2"}]}});
    });
    it("a missing parenthesis, a stray one and a keyword as an operand are errors with their column", () => {
      const error = (text) => { try { parseCondition(text, (m) => { throw new Error(m); }); } catch (e) { return e.message; } return "no error"; };
      expect(error("(a.x = 1 or a.y = 2")).to.match(/^expected "\)" to close the "\(" at column 1, found the end/);
      expect(error("a.x = 1)")).to.match(/^unexpected "\)" at column 8/);
      expect(error("a.x = 1 and or a.y = 2")).to.match(/^expected an operand, found "or" at column 13/);
    });
    it("an alias that is a word of the language is refused at its line", () => {
      refusedAt(variant("alias-or", "for: ZOSD_L2_SHIP as ship", "for: ZOSD_L2_SHIP as or"), /^alias or is a word of the condition language/, /^for:/);
    });

    it("each comparison takes the line it is written on, in a condition over several lines", () => {
      const model = compileRule(OR_NOT, {registry});
      const [on, role, since] = model.clauses[0].conditions;
      expect(on.rule_line).to.equal(lineIn(OR_NOT_TEXT, /^\s+where: crew\.ship_id = ship\.ship_id$/));
      expect(role.rule_line).to.equal(lineIn(OR_NOT_TEXT, /^\s+and not \(crew\.role/));
      expect(since.rule_line).to.equal(role.rule_line);
      expect(role.rule_line).to.equal(on.rule_line + 1);
    });

    describe("two identical conditions in one conjunction are refused at the second", () => {
      it("written the same way", () => refusedAt(variant("dup-same", "when: ship.status = 'M'", "when: ship.status = 'M' and ship.status = 'M'"),
        /^ship\.status = 'M' repeats ship\.status = 'M' in the same conjunction/, /^when:/));
      it("with the operands the other way round", () => refusedAt(variant("dup-mirror", "when: ship.status = 'M'", "when: ship.status = 'M' and 'M' = ship.status"),
        /^'M' = ship\.status repeats ship\.status = 'M' in the same conjunction/, /^when:/));
      it("a join equality written both ways, the second on its own line", () => {
        const file = variant("dup-join", "  where: voy.ship_id = ship.ship_id and voy.dep_date > $date",
          "  where: voy.ship_id = ship.ship_id and voy.dep_date > $date\n    and ship.ship_id = voy.ship_id");
        refusedAt(file, /^ship\.ship_id = voy\.ship_id repeats voy\.ship_id = ship\.ship_id in the same conjunction/, /^\s+and ship\.ship_id = voy\.ship_id$/);
      });
      it("a < b and b > a", () => refusedAt(variant("dup-order", "voy.dep_date > $date", "voy.dep_date > $date and $date < voy.dep_date"),
        /^\$date < voy\.dep_date repeats voy\.dep_date > \$date/, /^\s+where:/));
      it("inside a group under or, too", () => refusedAt(variant("dup-group", "when: ship.status = 'M'", "when: ship.status = 'A' or (ship.status = 'M' and ship.status = 'M')"),
        /^ship\.status = 'M' repeats ship\.status = 'M' in the same conjunction/, /^when:/));
      it("but the same comparison in two different conjunctions is fine", () => {
        const file = variant("dup-ok", "when: ship.status = 'M'", "when: (ship.status = 'M' and ship.name = 'Albatross') or (ship.status = 'M' and ship.name = 'Petrel')");
        expect(() => compileRule(file, {registry})).to.not.throw();
      });
    });

    describe("forbid, require, all and any are checked with their lines", () => {
      it("forbid and require together", () => refusedAt(writeRule("both", RULE_TEXT.replace("alert:", "require:\n  exists: ZOSD_L2_CREW as crew\n  where: crew.ship_id = ship.ship_id\nalert:")),
        /^a rule has forbid or require, not both/, /^require:/));
      it("require's alert names only the for table", () => refusedAt(writeRule("req-hole", REQUIRE_TEXT.replace("in service without a captain\"", "no captain {crew.crew_id}\"")),
        /^\{crew\.crew_id\}: require alerts when no row of the exists table is there, so its alert names only fields of ship/, /^alert:/));
      it("require takes one exists", () => refusedAt(writeRule("req-any", REQUIRE_TEXT.replace("require:\n  exists: ZOSD_L2_CREW as crew\n  where:", "require:\n  any:\n    - exists: ZOSD_L2_CREW as crew\n      where:")),
        /^require takes one exists and where, not any/, /^\s+any:/));
      it("all with one clause", () => refusedAt(writeRule("all-one", ALL_RULE.replace(/    - exists: ZOSD_L2_CREW as crew\n.*\n/, "")),
        /^forbid\.all needs two or three clauses/, /^\s+all:/));
      it("all with four clauses", () => {
        const four = ALL_RULE.replace("alert:", "    - exists: ZOSD_L2_SHIP as s2\n      where: s2.ship_id = ship.ship_id\n    - exists: ZOSD_L2_NOPE as n\n      where: n.x = ship.ship_id\nalert:");
        refusedAt(writeRule("all-four", four), /^forbid\.all holds at most 3 clauses/, /^\s+- exists: ZOSD_L2_NOPE/);
      });
      it("a clause of all without an equality to for is refused with the reason", () => refusedAt(
        writeRule("all-nojoin", ALL_RULE.replace("where: crew.ship_id = ship.ship_id and (crew.role = 'C' or crew.role = 'P')", "where: crew.role = 'C' or crew.role = 'P'")),
        /^where needs an equality between a field of crew and a field of ship, joined to the rest by and \(every clause of all joins the for table in the one query\)/,
        /^\s+where: crew\.role = 'C' or/));
      it("an equality under or does not join", () => refusedAt(
        variant("or-join", "where: voy.ship_id = ship.ship_id and voy.dep_date > $date", "where: voy.ship_id = ship.ship_id or voy.dep_date > $date"),
        /^where needs an equality between a field of voy and a field of ship, joined to the rest by and/, /^\s+where:/));
      it("a clause of all may not name another clause's alias", () => refusedAt(
        writeRule("all-scope", ALL_RULE.replace("(crew.role = 'C' or crew.role = 'P')", "(crew.role = 'C' or voy.voyage_id = 'V00001')")),
        /^alias voy is not in scope here \(in scope: ship, crew\)/, /^\s+where: crew\.ship_id/));
      it("the same table in two clauses", () => refusedAt(writeRule("all-twin", ALL_RULE.replace("ZOSD_L2_CREW as crew", "ZOSD_L2_VOY as crew")),
        /^ZOSD_L2_VOY is read twice \(as voy and crew\); under all each clause reads its own table \(its zero case empties that table\); any allows a table twice/, /^\s+- exists: ZOSD_L2_VOY as crew/));
      it("a shared alert of any names only fields of for", () => refusedAt(writeRule("any-shared", ANY_RULE.replace("crew aboard\"", "crew {crew.crew_id} aboard\"")),
        /^\{crew\.crew_id\}: a shared alert of any names only fields of the for table/, /^alert:/));
      it("a clause of any without an alert and no shared one", () => refusedAt(writeRule("any-noalert", ANY_RULE.replace(/^alert: .*\n/m, "")),
        /^a clause of any needs its own alert: or the rule a shared alert:/, /^\s+- exists: ZOSD_L2_CREW/));
    });
  });

  describe("slice 3: the lowering", () => {
    const methodOf = (file, name) => {
      const text = readFileSync(file, "utf8");
      return text.slice(text.indexOf(`  METHOD ${name}.`), text.indexOf("ENDMETHOD.", text.indexOf(`  METHOD ${name}.`)));
    };
    const built = {};
    before(async () => {
      for (const [name, text] of [["all", ALL_RULE], ["any", ANY_RULE]]) {
        const out = join(scratch, `shape-${name}`);
        await buildRule(writeRule(`shape-${name}`, text), out, {registry});
        built[name] = (suffix) => join(out, `zcl_l2_${name}_fixture.${suffix}`);
      }
    });

    it("or and not: the WHERE keeps the groups in parentheses, one comparison per line", () => {
      const check = methodOf(join(OUT, "zcl_l2_grounded_ship_crew.clas.abap"), "check");
      expect(check).to.contain(["      WHERE ( ship~status = 'M'",
        "           OR ship~status = 'D' )",
        "        AND NOT ( crew~role = 'K'",
        "           OR crew~since > iv_date )",
        "        AND ship~ship_id IN it_range",
        "      ORDER BY"].join("\n"));
      expect(check).to.contain("          ON crew~ship_id = ship~ship_id\n");
      const reference = methodOf(join(OUT, "zcl_l2_grounded_ship_crew.clas.testclasses.abap"), "check_reference");
      expect(reference).to.contain("      WHERE ( status = 'M'\n           OR status = 'D' )\n        AND ship_id IN it_range\n");
      expect(reference).to.contain("        WHERE ship_id = ls_ship-ship_id\n          AND NOT ( role = 'K'\n             OR since > iv_date )\n");
    });

    it("require: one query with a correlated NOT EXISTS; the reference is IF ... IS INITIAL", () => {
      const check = methodOf(join(OUT, "zcl_l2_ship_captain.clas.abap"), "check");
      expect(check).to.contain(["      FROM zosd_l2_ship AS ship",
        "      INTO CORRESPONDING FIELDS OF TABLE lt_join",
        "      WHERE ship~status = iv_active_status",
        "        AND NOT EXISTS ( SELECT * FROM zosd_l2_crew AS crew",
        "          WHERE crew~ship_id = ship~ship_id",
        "            AND crew~role = 'C'",
        "            AND crew~since <= iv_date )",
        "        AND ship~ship_id IN it_range",
        "      ORDER BY",
        "        ship~ship_id."].join("\n"));
      expect(check.match(/^\s+SELECT$/gm)).to.have.length(1);
      expect(check.match(/SELECT \*/g)).to.have.length(1);
      expect(check).to.not.contain("INNER JOIN");
      const reference = methodOf(join(OUT, "zcl_l2_ship_captain.clas.testclasses.abap"), "check_reference");
      expect(reference).to.contain("      IF lt_crew IS INITIAL.\n");
      expect(reference).to.not.contain("DATA ls_crew");
    });

    it("all: one query, every clause an INNER JOIN with its ON, ordered by every key", () => {
      const check = methodOf(built.all("clas.abap"), "check");
      expect(check.match(/^\s+SELECT$/gm)).to.have.length(1);
      expect(check).to.contain(["      FROM zosd_l2_ship AS ship",
        "        INNER JOIN zosd_l2_voy AS voy",
        "          ON voy~ship_id = ship~ship_id",
        "        INNER JOIN zosd_l2_crew AS crew",
        "          ON crew~ship_id = ship~ship_id",
        "      INTO CORRESPONDING FIELDS OF TABLE lt_join",
        "      WHERE ship~status = 'M'",
        "        AND voy~dep_date > iv_date",
        "        AND ( crew~role = 'C'",
        "           OR crew~role = 'P' )",
        "      ORDER BY",
        "        ship~ship_id",
        "        voy~voyage_id",
        "        crew~crew_id."].join("\n"));
    });

    it("any: one query per clause, each into its own table, clause by clause", () => {
      const check = methodOf(built.any("clas.abap"), "check");
      expect(check.match(/^\s+SELECT$/gm)).to.have.length(2);
      expect(check.indexOf("INTO CORRESPONDING FIELDS OF TABLE lt_join1")).to.be.lessThan(check.indexOf("INTO CORRESPONDING FIELDS OF TABLE lt_join2"));
      expect(check).to.contain("        INNER JOIN zosd_l2_voy AS voy\n          ON voy~ship_id = ship~ship_id\n      INTO CORRESPONDING FIELDS OF TABLE lt_join1");
      expect(check).to.contain("        INNER JOIN zosd_l2_crew AS crew\n          ON crew~ship_id = ship~ship_id\n      INTO CORRESPONDING FIELDS OF TABLE lt_join2");
      expect(check).to.contain("lv_alert = ls_join1-ship_ship_id\n        && `: voyage `\n        && ls_join1-voy_voyage_id");
      expect(check).to.contain("lv_alert = ls_join2-ship_ship_id\n        && ` `\n        && ls_join2-ship_name");
    });

    it("the traces of the new constructs reach their own rule lines", () => {
      const at = (file, re) => {
        const abap = readFileSync(file, "utf8").split("\n");
        const trace = readJSONFile(file.replace(/\.abap$/, ".trace.json"), "utf8");
        const n = abap.findIndex((l) => re.test(l)) + 1;
        expect(n, `a line matching ${re}`).to.be.greaterThan(0);
        return trace.lines.find((e) => e.line === n);
      };
      const g = join(OUT, "zcl_l2_grounded_ship_crew.clas.abap"), c = join(OUT, "zcl_l2_ship_captain.clas.abap");
      expect(at(g, /OR ship~status = 'D' \)$/)).to.include({node: "rule/grounded-ship-keeps-only-keepers/when/2", rule_line: lineIn(OR_NOT_TEXT, /^when:/)});
      expect(at(g, /OR crew~since > iv_date \)$/)).to.include({node: "rule/grounded-ship-keeps-only-keepers/forbid/where/3", rule_line: lineIn(OR_NOT_TEXT, /^\s+and not/)});
      expect(at(g, /ON crew~ship_id = ship~ship_id$/)).to.include({rule_line: lineIn(OR_NOT_TEXT, /^\s+where:/)});
      expect(at(c, /AND NOT EXISTS \( SELECT \* FROM zosd_l2_crew AS crew$/)).to.include({node: "rule/ship-in-service-has-a-captain/require", rule_line: lineIn(REQUIRE_TEXT, /^\s+exists:/)});
      expect(at(c, /AND crew~since <= iv_date \)$/)).to.include({node: "rule/ship-in-service-has-a-captain/require/where/3", rule_line: lineIn(REQUIRE_TEXT, /^\s+where:/)});
      expect(at(join(OUT, "zcl_l2_ship_captain.clas.testclasses.abap"), /IF lt_crew IS INITIAL\.$/)).to.include({node: "rule/ship-in-service-has-a-captain/require"});
    });
  });

  describe("slice 3: derived cases under or, not, all, any and require", () => {
    const byMethod = (model) => Object.fromEntries(model.cases.map((c) => [c.method, c]));
    const alerts = (c) => c.expect.map((e) => e.value);

    it("the interpreter agrees with every example and derived case of every rule", () => {
      const models = [compileRule(OR_NOT, {registry}), compileRule(REQUIRE, {registry}),
        compileRule(writeRule("agree-all", ALL_RULE), {registry}), compileRule(writeRule("agree-any", ANY_RULE), {registry})];
      expect(models.map((m) => m.cases.length)).to.deep.equal([16, 13, 20, 21]);
      for (const model of models) {
        for (const t of [...model.examples, ...model.cases]) {
          expect(evaluate(model, rowsOfCase(t), {date: t.date.value, $range: t.range_args ?? [], ...Object.fromEntries((model.params ?? []).map((p) => [p.name, p.default]))}).sort(), `${model.rule} ${t.method}`).to.deep.equal(alerts(t).sort());
        }
      }
    });

    it("under or the other disjunct is held false, so the target decides", () => {
      const cases = byMethod(compileRule(OR_NOT, {registry}));
      // status = 'M' is tested with a status that is not 'D', and the other way round
      expect(["b_status_eq", "b_status_ne", "b_status_blank"].map((m) => rowsOfCase(cases[m]).zosd_l2_ship[0].status)).to.deep.equal(["M", "N", ""]);
      expect(["b_ship_status_eq", "b_ship_status_ne", "b_ship_status_blank"].map((m) => rowsOfCase(cases[m]).zosd_l2_ship[0].status)).to.deep.equal(["D", "E", ""]);
      expect(alerts(cases.b_status_eq)).to.have.length(1);
      expect(alerts(cases.b_status_ne)).to.deep.equal([]);
      // inside not ( role = 'K' or since > $date ): the other disjunct is false (since <= date)
      for (const m of ["b_role_eq", "b_role_ne", "b_role_blank"]) expect(rowsOfCase(cases[m]).zosd_l2_crew[0].since <= "20261001", m).to.equal(true);
      for (const m of ["b_since_lt", "b_since_eq", "b_since_gt"]) expect(rowsOfCase(cases[m]).zosd_l2_crew[0].role, m).to.not.equal("K");
    });

    it("under not the expected result flips: role = 'K' true gives no alert, false gives one", () => {
      const cases = byMethod(compileRule(OR_NOT, {registry}));
      expect(alerts(cases.b_role_eq)).to.deep.equal([]);
      expect(alerts(cases.b_role_ne)).to.have.length(1);
      expect(alerts(cases.b_since_gt)).to.deep.equal([]);
      expect(alerts(cases.b_since_eq)).to.have.length(1);
    });

    it("every case of the or/not, require, all and any rules discriminates", () => {
      for (const model of [compileRule(OR_NOT, {registry}), compileRule(REQUIRE, {registry}),
        compileRule(writeRule("disc-all", ALL_RULE), {registry}), compileRule(writeRule("disc-any", ANY_RULE), {registry})]) {
        for (const c of model.cases) {
          const params = {date: c.date.value, ...Object.fromEntries((model.params ?? []).map((p) => [p.name, p.default]))};
          const ok = c.derived.structural ? structureDiscriminates(model, rowsOfCase(c), params)
            : caseDiscriminates(model, conditionOf(model, c.derived.condition), rowsOfCase(c), params);
          expect(ok, `${model.rule} ${c.method}`).to.equal(true);
        }
      }
    });

    it("the guard bites under or: a row where the other disjunct holds does not isolate the target", () => {
      const model = compileRule(OR_NOT, {registry});
      const cond = conditionOf(model, "when/1");
      const params = {date: "20261001"};
      const crew = [{crew_id: "C00001", ship_id: "S001", role: "E", since: "20260101"}];
      expect(caseDiscriminates(model, cond, {zosd_l2_ship: [{ship_id: "S001", name: "A", status: "M"}], zosd_l2_crew: crew}, params)).to.equal(true);
      expect(caseDiscriminates(model, cond, {zosd_l2_ship: [{ship_id: "S001", name: "A", status: "D"}], zosd_l2_crew: crew}, params), "status D decides the or whatever status = 'M' says").to.equal(false);
      // and under not: a row where the other disjunct inside the not holds
      const role = conditionOf(model, "forbid/where/2");
      expect(caseDiscriminates(model, role, {zosd_l2_ship: [{ship_id: "S001", name: "A", status: "M"}], zosd_l2_crew: [{...crew[0], since: "20261231"}]}, params),
        "since > date makes the not false whatever role says").to.equal(false);
    });

    it("the structural guard bites too: a row set no clause decides is not emitted", () => {
      const model = compileRule(writeRule("guard-all", ALL_RULE), {registry});
      const params = {date: "20261001"};
      expect(structureDiscriminates(model, {zosd_l2_ship: [{ship_id: "S001", name: "A", status: "A"}], zosd_l2_voy: [], zosd_l2_crew: []}, params),
        "a ship in service: no clause changes anything").to.equal(false);
    });

    it("all: a case per clause with that clause unmatched gives no alert", () => {
      const cases = byMethod(compileRule(writeRule("struct-all", ALL_RULE), {registry}));
      expect(rowsOfCase(cases.b_crew_zero).zosd_l2_crew ?? []).to.deep.equal([]);
      expect(rowsOfCase(cases.b_crew_zero).zosd_l2_voy).to.have.length(1);
      expect(alerts(cases.b_crew_zero)).to.deep.equal([]);
      expect(alerts(cases.b_voy_zero)).to.deep.equal([]);
      expect(alerts(cases.b_crew_two)).to.have.length(2);
    });

    it("any: a case where only the second clause matches, and one where none does", () => {
      const cases = byMethod(compileRule(writeRule("struct-any", ANY_RULE), {registry}));
      expect(rowsOfCase(cases.b_crew_only).zosd_l2_voy ?? []).to.deep.equal([]);
      expect(alerts(cases.b_crew_only)).to.deep.equal(["S001 Albatross: crew aboard"]);
      expect(alerts(cases.b_voy_only)).to.deep.equal(["S001: voyage V00001 ahead"]);
      expect(alerts(cases.b_exists_zero)).to.deep.equal([]);
      expect(alerts(cases.b_crew_two)).to.have.length(3);
    });

    it("require: zero exists rows alert, one matching row does not; a when is tested with no exists row", () => {
      const cases = byMethod(compileRule(REQUIRE, {registry}));
      expect(alerts(cases.b_exists_zero)).to.deep.equal(["S002 Cormorant: in service without a captain"]);
      expect(alerts(cases.b_exists_one)).to.deep.equal([]);
      expect(rowsOfCase(cases.b_exists_one).zosd_l2_crew).to.have.length(1);
      expect(rowsOfCase(cases.b_status_eq).zosd_l2_crew ?? []).to.deep.equal([]);
      expect(alerts(cases.b_status_eq)).to.have.length(1);
      expect(alerts(cases.b_status_ne)).to.deep.equal([]);
    });
  });

  describe("slice 3: the ABAP proves it, and a mutant per construct is caught", () => {
    before(async () => {
      await import("./start.mjs");
    });
    const copy = (name, text, className) => writeRule(name, text.replace(/^class: .*$/m, `class: ${className}`));

    it("ABAP Unit of the two new demo classes runs green in this runtime", async () => {
      for (const [className, count] of [["ZCL_L2_GROUNDED_SHIP_CREW", 23], ["ZCL_L2_SHIP_CAPTAIN", 20]]) {
        const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", className);
        expect(result.counts, JSON.stringify(result.testClasses)).to.include({methods: count, passed: count, failed: 0});
      }
    });

    for (const [what, text, className, cases] of [
      ["or and not", () => OR_NOT_TEXT, "zcl_l2_s3_ornot", 23],
      ["require", () => REQUIRE_TEXT, "zcl_l2_s3_require", 20],
      ["all", () => ALL_RULE, "zcl_l2_s3_all", 23],
      ["any", () => ANY_RULE, "zcl_l2_s3_any", 23],
    ]) {
      it(`${what}: every example and derived case passes, check against check_reference included`, async () => {
        const {results, messages} = await runRule(copy(`abap-${className}`, text(), className), className);
        expect(Object.keys(results)).to.have.length(cases);
        expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
      });
    }

    it("or changed to and: the cases of the or fail", async () => {
      const {results} = await runRule(copy("mut-or", OR_NOT_TEXT, "zcl_l2_s3_mut_or"), "zcl_l2_s3_mut_or", {mutate: {
        "clas.abap": [["OR ship~status = 'D' )", "AND ship~status = 'D' )"]],
        "clas.testclasses.abap": [["OR status = 'D'", "AND status = 'D'"]]}});
      const red = failed(results);
      for (const m of ["b_status_eq", "b_ship_status_eq"]) expect(red, `${m} in ${red}`).to.include(m);
    });

    it("not dropped: the cases under the not fail", async () => {
      const {results} = await runRule(copy("mut-not", OR_NOT_TEXT, "zcl_l2_s3_mut_not"), "zcl_l2_s3_mut_not", {mutate: {
        "clas.abap": [["AND NOT ( crew~role = 'K'", "AND ( crew~role = 'K'"]],
        "clas.testclasses.abap": [["AND NOT ( role = 'K'", "AND ( role = 'K'"]]}});
      const red = failed(results);
      for (const m of ["b_role_eq", "b_role_ne", "b_since_eq", "b_since_gt", "engineer_aboard_in_maintenance"]) expect(red, `${m} in ${red}`).to.include(m);
    });

    it("require changed to forbid: the structural cases and the examples fail", async () => {
      const {results} = await runRule(copy("mut-req", REQUIRE_TEXT, "zcl_l2_s3_mut_req"), "zcl_l2_s3_mut_req", {mutate: {
        "clas.abap": [["AND NOT EXISTS (", "AND EXISTS ("]],
        "clas.testclasses.abap": [["IF lt_crew IS INITIAL.", "IF lt_crew IS NOT INITIAL."]]}});
      const red = failed(results);
      for (const m of ["b_exists_zero", "b_exists_one", "captain_aboard", "no_crew_at_all"]) expect(red, `${m} in ${red}`).to.include(m);
    });

    it("one clause of all dropped: the zero case of that clause fails, and not only against the reference", async () => {
      // the crew clause taken out of the query and out of the nested reference
      const dropQuery = (text) => text
        .replace("        crew~crew_id AS crew_crew_id\n", "")
        .replace("        INNER JOIN zosd_l2_crew AS crew\n          ON crew~ship_id = ship~ship_id\n", "")
        .replace("        AND ( crew~role = 'C'\n           OR crew~role = 'P' )\n", "")
        .replace("        voy~voyage_id\n        crew~crew_id.", "        voy~voyage_id.")
        .replace(/ls_join-crew_crew_id/, "`C00001`");
      const dropLevel = (text) => text.replace(/\n {8}SELECT \* FROM zosd_l2_crew[\s\S]*?LOOP AT lt_crew INTO ls_crew\./, "")
        .replace(/(APPEND lv_alert TO rt_alerts\.\n) {8}ENDLOOP\.\n/, "$1")
        .replace(/ls_crew-crew_id/, "`C00001`");
      const file = copy("mut-all", ALL_RULE, "zcl_l2_s3_mut_all");
      const {results, messages} = await runRule(file, "zcl_l2_s3_mut_all", {mutate: {}, transform: {"clas.abap": dropQuery, "clas.testclasses.abap": dropLevel}});
      const red = failed(results);
      expect(red).to.include("b_crew_zero");
      expect(messages.b_crew_zero).to.not.include("assert_same_as_reference");
      expect(red).to.include("no_crew_no_alert");
    });
  });

  describe("slice 3: one query where one query is possible", () => {
    const db = () => globalThis.abap.context.databaseConnections.DEFAULT;
    const insert = async (table, columns, values) => {
      const mandt = globalThis.abap.builtin.sy.get().mandt.get();
      await db().execute(`INSERT INTO ${table} (mandt, ${columns.join(", ")}) VALUES ('${mandt}', ${values.map((v) => `'${v}'`).join(", ")})`);
    };
    const counted = async (run) => {
      const original = db().select.bind(db());
      let calls = 0;
      db().select = async (options) => { calls++; return original(options); };
      try {
        return {alerts: (await run()).array().map((a) => a.get()), calls};
      } finally {
        db().select = original;
      }
    };
    before(async () => {
      await import("./start.mjs");
    });

    for (const [what, text, className, status, expected] of [
      ["require", () => REQUIRE_TEXT, "zcl_l2_s3_calls_req", "A", {calls: 1, alerts: 6}],
      ["all", () => ALL_RULE, "zcl_l2_s3_calls_all", "M", {calls: 1, alerts: 6}],
      ["any (two clauses)", () => ANY_RULE, "zcl_l2_s3_calls_any", "M", {calls: 2, alerts: 12}],
      ["or and not", () => OR_NOT_TEXT, "zcl_l2_s3_calls_ornot", "M", {calls: 1, alerts: 6}],
    ]) {
      it(`${what}: check makes ${expected.calls} database call(s) for six for rows, the reference more`, async () => {
        const {out} = await loadRule(writeRule(`calls-${className}`, text().replace(/^class: .*$/m, `class: ${className}`)), className);
        const module = await import(pathToFileURL(join(out, `${className}.clas.testclasses.mjs`)).href);
        await import(pathToFileURL(join(out, `${className}.clas.mjs`)).href);
        const n = 6;
        try {
          for (let i = 1; i <= n; i++) {
            await insert("zosd_l2_ship", ["ship_id", "name", "status"], [`Q${i}`, `Ship ${i}`, status]);
            await insert("zosd_l2_voy", ["voyage_id", "ship_id", "dep_date"], [`QV${i}`, `Q${i}`, "20261005"]);
            await insert("zosd_l2_crew", ["crew_id", "ship_id", "role", "since"], [`QC${i}`, `Q${i}`, "P", "20260101"]);
          }
          const date = new globalThis.abap.types.Date().set("20261001");
          const joined = await counted(() => globalThis.abap.Classes[className.toUpperCase()].check({iv_date: date}));
          const test = await new module.ltcl_examples().constructor_();
          const nested = await counted(() => test.FRIENDS_ACCESS_INSTANCE.check_reference({iv_date: date}));
          expect(joined.calls, "calls of check").to.equal(expected.calls);
          expect(joined.alerts).to.have.length(expected.alerts);
          expect(nested.calls, "the reference makes a call per for row").to.be.greaterThan(n);
          expect(nested.alerts).to.deep.equal(joined.alerts);
        } finally {
          for (const t of ["zosd_l2_crew", "zosd_l2_voy", "zosd_l2_ship"]) await db().execute(`DELETE FROM ${t}`);
        }
      });
    }
  });

  // ---------------------------------------------------------------------
  // slice 3, after the critic: duplicates as units, a table twice under any,
  // no generated line over 255 characters

  const ANY_TWICE = `rule: any-twice
class: zcl_l2_any_twice
title: a ship in maintenance with a voyage ahead, or one long ago
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M'
forbid:
  any:
    - exists: ZOSD_L2_VOY as v1
      where: v1.ship_id = ship.ship_id and v1.dep_date > $date
      alert: "{ship.ship_id}: voyage {v1.voyage_id} ahead"
    - exists: ZOSD_L2_VOY as v2
      where: v2.ship_id = ship.ship_id and v2.dep_date < '20200101'
      alert: "{ship.ship_id}: voyage {v2.voyage_id} long ago"
boundaries: auto
examples:
  - name: both
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY:
        - {voyage_id: V00001, ship_id: S001, dep_date: 20261005}
        - {voyage_id: V00002, ship_id: S001, dep_date: 20190101}
    expect: ["S001: voyage V00001 ahead", "S001: voyage V00002 long ago"]
  - name: one voyage in both
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00003, ship_id: S001, dep_date: 20190101}]
    expect: ["S001: voyage V00003 long ago"]
`;
  const LONG_TEXT = "x".repeat(255);
  const LONG_ALERT = `rule: long-alert
class: zcl_l2_long_alert
title: an alert text as long as a literal may be
for: ZOSD_L2_SHIP as ship
when: ship.status = 'M'
forbid:
  exists: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date > $date
alert: "{ship.ship_id}${LONG_TEXT}"
boundaries: auto
examples:
  - name: fires
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect: ["S001${LONG_TEXT}"]
`;

  describe("slice 3 critic: duplicates under not and in groups are refused as units", () => {
    it("not a and not a", () => refusedAt(variant("dup-not", "when: ship.status = 'M'", "when: not ship.status = 'A' and not ship.status = 'A'"),
      /^not ship\.status = 'A' repeats not ship\.status = 'A' in the same conjunction/, /^when:/));
    it("two groups with the same items in another order", () => refusedAt(
      variant("dup-groups", "when: ship.status = 'M'", "when: (ship.status = 'M' or ship.name = 'X') and (ship.name = 'X' or 'M' = ship.status)"),
      /^ship\.name = 'X' or 'M' = ship\.status repeats ship\.status = 'M' or ship\.name = 'X' in the same conjunction/, /^when:/));
    it("not (a or b) twice in a disjunction", () => refusedAt(
      variant("dup-notgroup", "when: ship.status = 'M'", "when: ship.status = 'M' or not (ship.name = 'X' or ship.name = 'Y') or not (ship.name = 'Y' or ship.name = 'X')"),
      /^not \(ship\.name = 'Y' or ship\.name = 'X'\) repeats not \(ship\.name = 'X' or ship\.name = 'Y'\) in the same disjunction/, /^when:/));
    it("but a and not a are different", () => {
      const file = variant("dup-notok", "when: ship.status = 'M'", "when: ship.status = 'M' and not ship.status = 'A'");
      expect(() => compileRule(file, {registry})).to.not.throw();
    });
  });

  describe("slice 3 critic: two clauses of any may read one table", () => {
    before(async () => {
      await import("./start.mjs");
    });
    it("compiles: one query per clause, each with its own alias, and a row of its own in the derived cases", () => {
      const model = compileRule(writeRule("any-twice", ANY_TWICE), {registry});
      expect(model.clauses.map((c) => [c.alias, c.table, c.slot])).to.deep.equal([["v1", "zosd_l2_voy", 0], ["v2", "zosd_l2_voy", 1]]);
      expect(model.tables.map((t) => t.table)).to.deep.equal(["zosd_l2_ship", "zosd_l2_voy"]);
      const eq = model.cases.find((c) => c.method === "b_v2_dep_date_eq");
      expect(rowsOfCase(eq).zosd_l2_voy.map((r) => r.dep_date)).to.deep.equal(["20261005", "20200101"]);
      expect(eq.expect.map((e) => e.value)).to.deep.equal(["S001: voyage V00001 ahead"]);
      const only = model.cases.find((c) => c.method === "b_v2_only");
      expect(rowsOfCase(only).zosd_l2_voy.map((r) => r.voyage_id)).to.deep.equal(["V00002"]);
      for (const c of model.cases) {
        const keys = (rowsOfCase(c).zosd_l2_voy ?? []).map((r) => r.voyage_id);
        expect(new Set(keys).size, `${c.method} keys`).to.equal(keys.length);
      }
    });
    it("and the ABAP agrees on every example and case", async () => {
      const {results, messages} = await runRule(writeRule("any-twice-abap", ANY_TWICE), "zcl_l2_any_twice");
      expect(Object.keys(results).length).to.be.greaterThan(15);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
    });
  });

  describe("slice 3 critic: no generated line is longer than 255 characters", () => {
    before(async () => {
      await import("./start.mjs");
    });
    it("G23: CHAR 255 example and derived assignments fit and preserve the complete note in ABAP", async () => {
      const model = compileRule(WIDE_NOTE, {registry, out: OUT});
      const example = model.examples[0].tables[0].rows[0].fields.find((f) => f.column === "note");
      expect(example.value).to.have.length(255);
      expect(example.assignment_pieces.map((p) => p.value).join("")).to.equal(example.value);
      const wide = model.cases.flatMap((c) => c.tables.flatMap((t) => t.rows.flatMap((r) => r.fields)))
        .filter((f) => f.column === "note" && f.value.length === 255);
      expect(wide.length, "derived cases fill the wide field").to.be.greaterThan(0);
      for (const field of wide) expect(field.assignment_pieces.map((p) => p.value).join("")).to.equal(field.value);
      const {files, findings} = await renderRule(model);
      expect(findings).to.deep.equal([]);
      for (const [name, text] of Object.entries(files).filter(([n]) => n.endsWith(".abap"))) {
        expect(text.split("\n").filter((line) => line.length > 255), name).to.deep.equal([]);
      }
      const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", model.class.toUpperCase());
      const count = model.examples.length + model.cases.length;
      expect(result.counts, JSON.stringify(result.testClasses)).to.include({methods: count, passed: count, failed: 0});
      expect(result.ok).to.equal(true);
    });

    for (const [tag, value] of [["trailing", "x".repeat(99) + "  " + "y".repeat(149) + "     "],
      ["apostrophe", "x".repeat(99) + "'" + "y".repeat(154)], ["empty", ""], ["unicode", "飞艇 café 🚢".repeat(20)],
      ["254", "x".repeat(254)], ["255", "x".repeat(255)]]) {
      it(`G23 exact value: ${tag}`, async () => {
        const className = `zcl_l2_g23_${tag}`;
        const source = readFileSync(WIDE_NOTE, "utf8");
        const doc = yaml.load(source);
        doc.class = className;
        doc.boundaries = [];
        doc.examples[0].rows.ZOSD_L2_NOTE[0].note = value;
        doc.examples[0].expect = [`S001: ${value.trimEnd()}`];
        const file = writeRule(`g23-${tag}`, yaml.dump(doc));
        const {model, out} = await loadRule(file, className, {tables: ["zosd_l2_note.tabl.xml"]});
        const module = await import(pathToFileURL(join(out, `${className}.clas.testclasses.mjs`)).href);
        const test = await new module.ltcl_examples().constructor_();
        try {
          await test.FRIENDS_ACCESS_INSTANCE[model.examples[0].method]();
          const table = test.FRIENDS_ACCESS_INSTANCE[model.tables[0].itab];
          expect(table.array()[0].get().note.get()).to.equal(value.padEnd(255));
        } finally { await test.FRIENDS_ACCESS_INSTANCE.teardown(); }
        for (const suffix of ["clas.abap", "clas.testclasses.abap"]) {
          expect(readFileSync(join(out, `${className}.${suffix}`), "utf8").split("\n").filter((l) => l.length > 255)).to.deep.equal([]);
        }
      });
    }

    for (const mode of ["driving", "range-param", "scalar-param"]) {
      it(`G23: a 255-character ${mode} bound/default runs in ABAP`, async () => {
        const doc = yaml.load(readFileSync(WIDE_NOTE, "utf8"));
        const className = `zcl_l2_g23_${mode.replaceAll("-", "_")}`;
        doc.class = className;
        doc.boundaries = [];
        const value = doc.examples[0].rows.ZOSD_L2_NOTE[0].note;
        const bounds = [{sign: "I", option: "BT", low: value, high: value}];
        if (mode === "driving") {
          doc.range = "ship.note";
          doc.examples[0].range = bounds;
        } else {
          const range = mode === "range-param";
          doc.params = {notes: {type: "ZOSD_L2_NOTE-NOTE", ...(range ? {range: true} : {}), default: range ? bounds : value}};
          doc.when += range ? " and ship.note in $notes" : " and ship.note = $notes";
          doc.examples.push({...doc.examples[0], name: "explicit wide parameter", params: {notes: range ? bounds : value}});
        }
        const {results, messages, out} = await runRule(writeRule(`g23-${mode}`, yaml.dump(doc)), className,
          {tables: ["zosd_l2_note.tabl.xml"]});
        expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
        expect(Object.keys(results)).to.have.length(mode === "driving" ? 1 : 2);
        for (const suffix of ["clas.abap", "clas.testclasses.abap"]) {
          expect(readFileSync(join(out, `${className}.${suffix}`), "utf8").split("\n").filter((l) => l.length > 255)).to.deep.equal([]);
        }
      });
    }

    it("G23: a note longer than CHAR 255 is still refused", () => {
      const doc = yaml.load(readFileSync(WIDE_NOTE, "utf8"));
      doc.examples[0].rows.ZOSD_L2_NOTE[0].note = "x".repeat(256);
      expect(() => compileRule(writeRule("g23-too-wide", yaml.dump(doc)), {registry})).to.throw(/longer than CHAR 255/);
    });

    it("a maximal accepted alert text renders in pieces, every line of both classes at most 255", async () => {
      const out = join(scratch, "long-alert");
      const {files, findings} = await buildRule(writeRule("long-alert", LONG_ALERT), out, {registry});
      expect(findings.filter((f) => f.severity === "E")).to.deep.equal([]);
      for (const [name, text] of Object.entries(files).filter(([n]) => n.endsWith(".abap"))) {
        const long = text.split("\n").filter((l) => l.length > 255);
        expect(long, name).to.deep.equal([]);
      }
      expect(files["zcl_l2_long_alert.clas.testclasses.abap"]).to.contain("APPEND lv_exp TO lt_exp.");
    });
    it("and its ABAP builds the same alert as the interpreter", async () => {
      const {results, messages} = await runRule(writeRule("long-alert-abap", LONG_ALERT.replace("zcl_l2_long_alert", "zcl_l2_long_alert2")), "zcl_l2_long_alert2");
      expect(Object.keys(results).length).to.be.greaterThan(5);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
    });
    it("an oversized generated header is still a RuleError at the rule line", async () => {
      const model = compileRule(WIDE_NOTE, {registry});
      model.source = "x".repeat(256);
      let error;
      try { await renderRule(model); } catch (e) { error = e; }
      expect(error).to.be.instanceOf(RuleError);
      expect(error.message).to.contain("Line exceeds 255 characters");
      expect(error.message).to.contain(`${WIDE_NOTE}:1:`);
    });

    it("G23: long example labels use the same split in assertion arguments", async () => {
      const name = `nb${"!".repeat(170)}`;
      const file = writeRule("long-name", LONG_ALERT.replace("  - name: fires", `  - name: ${name}`));
      const {files, findings} = await buildRule(file, join(scratch, "long-name-out"), {registry});
      expect(findings).to.deep.equal([]);
      for (const [name, text] of Object.entries(files).filter(([n]) => n.endsWith(".abap"))) {
        expect(text.split("\n").filter((line) => line.length > 255), name).to.deep.equal([]);
      }
    });
  });

  // A rule that lives in a pack (osg-demo, 2026-10-01): its tables declare
  // fields by DATATYPE with no data element, and it is built from another
  // checkout than the one it lives in.
  describe("a rule in a pack: built-in typed fields and a stable rule path", () => {
    const PACK = "test/fixtures/dsl-l2-pack";
    const PACK_RULE = join(PACK, "pack_ints.l2.yaml");
    const PACK_TABLES = ["zosd_l2_pkship.tabl.xml", "zosd_l2_pkvoy.tabl.xml"];
    let packRegistry;
    before(async () => {
      await import("./start.mjs");
      packRegistry = registryFor([PACK, ".local/lars/open-abap-core/src"], []);
    });

    it("INT1, INT2, INT4, INT8 and DEC typed by DATATYPE get their DDIC type and width", () => {
      const model = compileRule(PACK_RULE, {registry: packRegistry});
      const {fields} = model.ddic.zosd_l2_pkship;
      expect([fields.lvl1, fields.lvl2, fields.steam_pct, fields.odo, fields.rate]).to.deep.equal([
        {built_in: "INT1"}, {built_in: "INT2"}, {built_in: "INT4"}, {built_in: "INT8"}, {built_in: "DEC", length: 7, decimals: 2}]);
      expect(model.cases.length).to.be.greaterThan(5);
      // a filler value fits a narrow packed field whatever the seed
      for (const type of [{built_in: "DEC", length: 3, decimals: 2}, {built_in: "DEC", length: 2, decimals: 0}]) {
        for (const seed of [1, 9, 10, 99, 100, 500, 799]) expect(misfit(defaultValue(type, seed), type), `${JSON.stringify(type)} seed ${seed}`).to.equal(undefined);
      }
      // every derived row fills them with a value of their own type
      for (const c of model.cases) {
        for (const t of c.tables.filter((x) => x.table === "zosd_l2_pkship")) {
          for (const r of t.rows) {
            expect(r.fields.map((f) => f.column)).to.include.members(["lvl1", "lvl2", "steam_pct", "odo", "rate"]);
            for (const f of r.fields) expect(misfit(f.value, f["value@type"]), `${c.method} ${f.column}=${f.value}`).to.equal(undefined);
          }
        }
      }
    });

    it("and the generated tests of boundaries: auto run green in ABAP", async () => {
      // the transpiler's CREATE TABLE has no column type for INT8
      // (ANOMALY-2026-10-01-transpiler-int8-column), so the run is over the
      // fixture without its INT8 field; the compile above covers INT8
      const ddic = join(scratch, "pack-run");
      mkdirSync(ddic, {recursive: true});
      const ship = readFileSync(join(PACK, PACK_TABLES[0]), "utf8");
      const noInt8 = ship.replace(/\s*<DD03P>\s*<FIELDNAME>ODO<\/FIELDNAME>[\s\S]*?<\/DD03P>/, "");
      expect(noInt8).to.not.equal(ship);
      writeFileSync(join(ddic, PACK_TABLES[0]), noInt8);
      copyFileSync(join(PACK, PACK_TABLES[1]), join(ddic, PACK_TABLES[1]));
      const reg = registryFor([ddic, ".local/lars/open-abap-core/src"], []);
      const {model, results, messages} = await runRule(PACK_RULE, "zcl_l2_pack_ints",
        {ruleRegistry: reg, tables: PACK_TABLES, tableDir: ddic, fixture: true});
      expect(Object.keys(model.ddic.zosd_l2_pkship.fields)).to.include.members(["lvl1", "lvl2", "steam_pct", "rate"]);
      expect(Object.keys(results)).to.have.length(model.examples.length + model.cases.length);
      expect(failed(results), JSON.stringify(messages)).to.deep.equal([]);
    });

    it("a field the rule never names whose data element is missing is refused at boundaries, naming it", () => {
      const ddic = join(scratch, "pack-nodtel");
      mkdirSync(ddic, {recursive: true});
      const ship = readFileSync(join(PACK, PACK_TABLES[0]), "utf8");
      const lost = ship.replace(/<FIELDNAME>ODO<\/FIELDNAME>[\s\S]*?<\/DD03P>/,
        "<FIELDNAME>ODO</FIELDNAME>\n     <ROLLNAME>ZOSD_L2_NODTEL</ROLLNAME>\n     <ADMINFIELD>0</ADMINFIELD>\n     <COMPTYPE>E</COMPTYPE>\n    </DD03P>");
      expect(lost).to.not.equal(ship);
      writeFileSync(join(ddic, PACK_TABLES[0]), lost);
      copyFileSync(join(PACK, PACK_TABLES[1]), join(ddic, PACK_TABLES[1]));
      const reg = registryFor([ddic, ".local/lars/open-abap-core/src"], []);
      const file = join(scratch, "pack_nodtel.l2.yaml");
      writeFileSync(file, readFileSync(PACK_RULE, "utf8"));
      const where = relative(process.cwd(), file).split(sep).join("/");
      const at = lineIn(readFileSync(file, "utf8"), /^boundaries:/);
      expect(() => compileRule(file, {registry: reg})).to.throw(RuleError,
        `${where}:${at}: ZOSD_L2_PKSHIP-ODO: data element ZOSD_L2_NODTEL is not in the DDIC given; add a --ddic folder that has it`);
      // without boundaries nothing fills it, and the rule builds
      writeFileSync(file, readFileSync(PACK_RULE, "utf8").replace(/^boundaries: auto\n/m, ""));
      expect(compileRule(file, {registry: reg}).cases).to.deep.equal([]);
    });

    it("the rule path is recorded the same from another working directory", function () {
      // another checkout: every entry of this one but .git, linked, so that
      // the path relative to the working directory is ../../<this checkout>/...
      const here = process.cwd();
      const alt = join(scratch, "alt-checkout");
      mkdirSync(alt, {recursive: true});
      for (const entry of readdirSync(here)) if (entry !== ".git") symlinkSync(join(here, entry), join(alt, entry));
      const build = (cwd, out) => {
        const run = spawnSync(process.execPath, [join(here, "tools/dsl-l2.mjs"), "build", join(here, RULE), "--out", out,
          "--ddic", join(here, "src"), "--ddic", join(here, ".local/lars/open-abap-core/src")], {cwd, encoding: "utf8"});
        expect(run.status, run.stdout + run.stderr).to.equal(0);
        return Object.fromEntries(readdirSync(out).sort().map((f) => [f, readFileSync(join(out, f), "utf8")]));
      };
      const a = build(here, join(scratch, "path-a"));
      const b = build(alt, join(scratch, "path-b"));
      expect(Object.keys(a)).to.have.length(7);
      expect(b).to.deep.equal(a);
      expect(a[`${CLASS}.clas.abap`].split("\n")[0]).to.equal(`* Generated by tools/dsl-l2.mjs from ${RULE}; do not edit.`);
      expect(readTraceMap(a, `${CLASS}.clas.trace.json`).rule).to.equal(RULE);
    });

    it("a rule in another git repository records its path in that repository; outside one, relative to --out", () => {
      const repo = mkdtempSync(join(tmpdir(), "dsl-l2-repo-"));
      try {
        const init = spawnSync("git", ["init", "-q", repo], {encoding: "utf8"});
        expect(init.status, init.stderr).to.equal(0);
        mkdirSync(join(repo, "src", "l2"), {recursive: true});
        const file = join(repo, "src", "l2", "pack_ints.l2.yaml");
        copyFileSync(PACK_RULE, file);
        expect(rulePath(file, join(scratch, "elsewhere"))).to.equal("src/l2/pack_ints.l2.yaml");
        expect(compileRule(file, {registry: packRegistry}).source).to.equal("src/l2/pack_ints.l2.yaml");
      } finally {
        rmSync(repo, {recursive: true, force: true});
      }
      const loose = mkdtempSync(join(tmpdir(), "dsl-l2-loose-"));
      try {
        const file = join(loose, "rules", "pack_ints.l2.yaml");
        mkdirSync(dirname(file));
        copyFileSync(PACK_RULE, file);
        const inGit = spawnSync("git", ["rev-parse", "--show-toplevel"], {cwd: loose}).status === 0;
        if (!inGit) expect(rulePath(file, join(loose, "out"))).to.equal("../rules/pack_ints.l2.yaml");
      } finally {
        rmSync(loose, {recursive: true, force: true});
      }
    });
  });

  describe("slice 7: typed parameters and date windows", () => {
    const source = readFileSync(RECENT, "utf8");
    const write = (tag, text) => {
      const file = join(scratch, `s7-${tag}.l2.yaml`);
      writeFileSync(file, text.replace(/^class: .*$/m, `class: zcl_l2_s7_${tag.replaceAll("-", "_")}`));
      return file;
    };
    const refuse = (tag, text, linePattern, reason) => {
      const file = write(tag, text);
      const at = readFileSync(file, "utf8").split("\n").findIndex((line) => linePattern.test(line)) + 1;
      let error;
      try { compileRule(file, {registry}); } catch (caught) { error = caught; }
      expect(error).to.be.instanceOf(RuleError);
      expect(error.line).to.equal(at);
      expect(error.message).to.match(reason);
    };
    const rows = (c) => Object.fromEntries(c.tables.map((t) => [t.table,
      t.rows.map((r) => Object.fromEntries(r.fields.map((f) => [f.column, f.value])))]));

    it("lowers a leap-day bound once and traces both the use and declaration", () => {
      const model = compileRule(RECENT, {registry});
      expect(model.cases.filter((c) => c.derived.condition === "require/where/2").map((c) => c.method))
        .to.deep.equal(["b_dep_date_lt", "b_dep_date_eq", "b_dep_date_gt"]);
      expect(shiftDate("20240301", -1)).to.equal("20240229");
      const abap = readFileSync(join(OUT, "zcl_l2_recent_voyage.clas.abap"), "utf8").split("\n");
      expect(abap.filter((line) => /lv_window_1 = iv_date - iv_max_days\./.test(line))).to.have.length(1);
      expect(abap).to.include("            AND voy~dep_date >= lv_window_1");
      const trace = readJSONFile(join(OUT, "zcl_l2_recent_voyage.clas.trace.json"), "utf8");
      const usage = trace.lines.find((entry) => /voy~dep_date >= lv_window_1/.test(abap[entry.line - 1]));
      const paramLine = source.split("\n").findIndex((line) => /max_days:/.test(line)) + 1;
      const whereLine = source.split("\n").findIndex((line) => /where:/.test(line)) + 1;
      expect(usage).to.include({rule_line: whereLine, param_rule_line: paramLine});
    });

    it("every window boundary discriminates, with offset plus and minus one killed", () => {
      const model = compileRule(RECENT, {registry});
      const cond = model.clauses[0].conditions[1];
      const cases = model.cases.filter((c) => c.derived.condition === "require/where/2");
      const params = {date: "20240301", max_days: "1"};
      for (const c of cases) expect(caseDiscriminates(model, cond, rows(c), params), c.method).to.equal(true);
      expect(windowOffsetDiscriminates(model, cond, rows(cases[0]), params, 1)).to.equal(true);
      expect(windowOffsetDiscriminates(model, cond, rows(cases[1]), params, -1)).to.equal(true);
    });

    it("runs the committed examples and all derived cases against check_reference", async () => {
      await import("./start.mjs");
      const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", "ZCL_L2_RECENT_VOYAGE");
      const model = compileRule(RECENT, {registry});
      expect(result.counts).to.include({methods: model.examples.length + model.cases.length,
        passed: model.examples.length + model.cases.length, failed: 0});
    });

    it("an offset changed in generated ABAP is killed by a derived boundary", async () => {
      await import("./start.mjs");
      const file = write("offset_mutant", source);
      const result = await runRule(file, "zcl_l2_s7_offset_mutant", {mutate: {
        "clas.abap": [["lv_window_1 = iv_date - iv_max_days.", "lv_window_1 = iv_date - iv_max_days - 1."]],
        "clas.testclasses.abap": [["lv_window_1 = iv_date - iv_max_days.", "lv_window_1 = iv_date - iv_max_days - 1."]]}});
      expect(failed(result.results)).to.include("b_dep_date_lt");
    });

    it("accepts a direct typed operand and a plus window across leap day", async () => {
      await import("./start.mjs");
      const text = `rule: forward-window
class: zcl_l2_s7_forward
title: a voyage in a forward window
params:
  cutoff: {type: D, default: 20240227}
  days: {type: ZOSD_L2_DAYS, default: 1}
for: ZOSD_L2_SHIP as ship
forbid:
  exists: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date >= $cutoff and voy.dep_date <= $date + $days
alert: "{ship.ship_id}: {voy.voyage_id}"
boundaries: auto
examples:
  - name: leap day
    date: 20240228
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20240229}]
    expect: ["S001: V00001"]
  - name: overridden cutoff
    date: 20240228
    params: {cutoff: 20240301, days: 1}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_VOY: [{voyage_id: V00002, ship_id: S001, dep_date: 20240229}]
    expect: []
`;
      const file = write("forward", text);
      const model = compileRule(file, {registry});
      expect(model.clauses[0].conditions[1].sref).to.equal("iv_cutoff");
      expect(model.windows[0]).to.include({sign: "+", offset_ref: "iv_days"});
      const condition = model.clauses[0].conditions[2];
      const boundaries = model.cases.filter((c) => c.derived.condition === "forbid/where/3");
      expect(boundaries.map((c) => c.derived.kind)).to.deep.equal(["lt", "eq", "gt"]);
      for (const c of boundaries) expect(caseDiscriminates(model, condition, rows(c), {date: "20240228", cutoff: "20240227", days: "1"}), c.method).to.equal(true);
      expect(windowOffsetDiscriminates(model, condition, rows(boundaries[1]), {date: "20240228", cutoff: "20240227", days: "1"}, -1)).to.equal(true);
      expect(windowOffsetDiscriminates(model, condition, rows(boundaries[2]), {date: "20240228", cutoff: "20240227", days: "1"}, 1)).to.equal(true);
      const result = await runRule(file, "zcl_l2_s7_forward");
      expect(failed(result.results), JSON.stringify(result.messages)).to.deep.equal([]);
    });

    it("refuses unknown, unused, clashing, unresolved, misfit and floating parameters at their lines", () => {
      refuse("unknown", source.replace("$max_days", "$missing"), /where:/, /unknown parameter \$missing/);
      refuse("unused", source.replace("and voy.dep_date >= $date - $max_days", ""), /max_days:/, /declared but unused/);
      refuse("date", source.replace("max_days:", "date:"), /date: \{type:/, /clashes with/);
      refuse("unresolved", source.replace("ZOSD_L2_DAYS", "ZOSD_L2_NO_SUCH_TYPE"), /max_days:/, /cannot resolve/);
      refuse("default", source.replace("default: 30", "default: nope"), /max_days:/, /not an integer/);
      refuse("float", source.replace("ZOSD_L2_DAYS", "F"), /max_days:/, /FLTP/);
    });

    it("refuses invalid window operands at the comparison line", () => {
      refuse("negative", source.replace("$date - $max_days", "$date - -1"), /where:/, /non-negative INT4/);
      refuse("nondats", source.replace("voy.dep_date >= $date - $max_days", "voy.voyage_id >= $date - $max_days"), /where:/, /needs a DATS field/);
      refuse("nonint", source.replace("type: ZOSD_L2_DAYS, default: 30", "type: D, default: 20240301"), /where:/, /needs an INT parameter/);
      refuse("int8", source.replace("type: ZOSD_L2_DAYS, default: 30", "type: INT8, default: 30"), /where:/, /INT8 is unavailable in ABAP 7\.02/);
      refuse("tight-minus", source.replace("$date - $max_days", "$date-30"), /where:/, /write `\$date - 30`/);
      refuse("negative-example", source.replace("max_days: 1", "max_days: -1"), /params: \{max_days: -1\}/, /non-negative INT4/);
      refuse("negative-default", source.replace("default: 30", "default: -1"), /max_days:/, /non-negative INT4/);
      refuse("missing-required", source.replace(", default: 30", ""), /- name: default window/, /needs \$max_days/);
    });
  });

  describe("slice 8: range parameters (a selection table as a parameter, `field in $name`)", () => {
    const TEXT = readFileSync(RESTRICTED, "utf8");
    const PARAM_AT = /restricted: \{type/;
    const WHEN_AT = /^when:/;
    const write = (tag, text) => writeRule(`s8-${tag}`, text.replace(/^class: .*$/m, `class: zcl_l2_s8_${tag.replaceAll("-", "_")}`));
    const edit = (from, to, text = TEXT) => {
      expect(text, `the rule has ${JSON.stringify(from)}`).to.include(from);
      return text.replace(from, to);
    };
    const refuse = (tag, text, at, reason) => refusedAt(write(tag, text), reason, at);
    const compile = (tag, text) => compileRule(write(tag, text), {registry});
    const alertShips = (model, ships, params) => evaluate(model, {zosd_l2_ship: ships.map(([ship_id, status]) => ({ship_id, name: ship_id, status})),
      zosd_l2_voy: ships.map(([ship_id], i) => ({voyage_id: `V0000${i + 1}`, ship_id, dep_date: "20261005"}))}, {date: "20261001", ...params})
      .map((a) => a.slice(0, 4));
    const SHIPS = [["S001", "M"], ["S002", "D"], ["S003", "A"], ["S004", "N"], ["S005", "R"]];
    const rows = (...list) => list.map(([sign, option, low, high]) => ({sign, option, low, ...(high ? {high} : {})}));

    const NO_DEFAULT = `rule: restricted-no-default
class: zcl_l2_s8_nodefault_run
title: A ship whose status is in the table has no voyage ahead
params:
  restricted: {type: ZOSD_L2_SHIP-STATUS, range: true}
for: ZOSD_L2_SHIP as ship
when: ship.status in $restricted
forbid:
  exists: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date > $date
alert: "{ship.ship_id}: {voy.voyage_id}"
boundaries: auto
examples:
  - name: omitted is every status
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}, {ship_id: S002, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}, {voyage_id: V00002, ship_id: S002, dep_date: 20261005}]
    expect: ["S001: V00001", "S002: V00002"]
  - name: a table keeps its statuses
    date: 20261001
    params: {restricted: [M]}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}, {ship_id: S002, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}, {voyage_id: V00002, ship_id: S002, dep_date: 20261005}]
    expect: ["S002: V00002"]
`;
    const BOTH = `rule: crew-of-a-needed-role
class: zcl_l2_s8_require_run
title: A ship in service has a crew member of a needed role aboard
params:
  roles: {type: ZOSD_L2_CREW-ROLE, range: true, default: [{sign: I, option: BT, low: C, high: D}]}
  skipped: {type: ZOSD_L2_SHIP-NAME, range: true, default: [Tern]}
for: ZOSD_L2_SHIP as ship
when: ship.status = 'A' and ship.name not in $skipped
require:
  exists: ZOSD_L2_CREW as crew
  where: crew.ship_id = ship.ship_id and crew.role in $roles
alert: "{ship.ship_id}: nobody of a needed role aboard"
boundaries: auto
examples:
  - name: a captain is within default
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: C, since: 20260101}]
    expect: []
  - name: an engineer is not
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: E, since: 20260101}]
    expect: ["S001: nobody of a needed role aboard"]
  - name: the E row excludes the captain
    date: 20261001
    params: {roles: [{sign: I, option: BT, low: A, high: Z}, {sign: E, option: EQ, low: C}]}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}, {ship_id: S002, status: A}]
      ZOSD_L2_CREW: [{crew_id: C00001, ship_id: S001, role: C, since: 20260101}, {crew_id: C00002, ship_id: S002, role: E, since: 20260101}]
    expect: ["S001: nobody of a needed role aboard"]
  - name: empty roles is any crew
    date: 20261001
    params: {roles: []}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}, {ship_id: S002, status: A}]
      ZOSD_L2_CREW: [{crew_id: C00002, ship_id: S002, role: E, since: 20260101}]
    expect: ["S001: nobody of a needed role aboard"]
  - name: empty skipped checks none
    date: 20261001
    params: {skipped: []}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
    expect: []
`;

    const NOT_IN = `rule: restricted-not-in
class: zcl_l2_s8_notin
title: A ship whose status is outside the table has a voyage ahead
params:
  allowed: {type: ZOSD_L2_SHIP-STATUS, range: true, default: [M, D]}
for: ZOSD_L2_SHIP as ship
when: ship.status not in $allowed
forbid:
  exists: ZOSD_L2_VOY as voy
  where: voy.ship_id = ship.ship_id and voy.dep_date > $date
alert: "{ship.ship_id}: {voy.voyage_id}"
boundaries: auto
examples:
  - name: outside the default table
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect: ["S001: V00001"]
  - name: inside the default table
    date: 20261001
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: M}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect: []
  - name: an empty table holds no status
    date: 20261001
    params: {allowed: []}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: A}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}]
    expect: []
  - name: an E row alone
    date: 20261001
    params: {allowed: [{sign: E, option: EQ, low: M}]}
    rows:
      ZOSD_L2_SHIP: [{ship_id: S001, status: M}, {ship_id: S002, status: A}]
      ZOSD_L2_VOY: [{voyage_id: V00001, ship_id: S001, dep_date: 20261005}, {voyage_id: V00002, ship_id: S002, dep_date: 20261005}]
    expect: ["S001: V00001"]
`;

    it("compiles to a range parameter, a condition on it, and nodes that trace to their rule lines", () => {
      const model = compileRule(RESTRICTED, {registry});
      const [parameter, exempt] = model.params;
      expect(parameter).to.include({name: "restricted", is_selopt: true, ref: "iv_restricted", use: "lt_p_restricted", selopt_type: "tt_restricted", has_default: true});
      expect(parameter.default_rows.map((r) => [r.sign, r.option, r.low])).to.deep.equal([["I", "EQ", "M"], ["I", "EQ", "D"]]);
      for (const r of parameter.default_rows) expect(r.rule_line).to.equal(lineIn(TEXT, PARAM_AT));
      const condition = model.when.conditions[0];
      expect(condition).to.include({op: "IN", lhs: "ship~status", sref: "lt_p_restricted", text: "ship.status in $restricted"});
      expect(condition.cmp.rhs).to.deep.equal({kind: "range", name: "restricted"});
      expect(model.when.conditions[1]).to.include({op: "NOT IN", lhs: "ship~ship_id", sref: "lt_p_exempt", text: "ship.ship_id not in $exempt"});
      expect(exempt.default_rows.map((r) => [r.sign, r.option, r.low, r.high])).to.deep.equal([["I", "BT", "S900", "S999"]]);
      const abap = readFileSync(join(OUT, "zcl_l2_ship_restricted.clas.abap"), "utf8").split("\n");
      const trace = readJSONFile(join(OUT, "zcl_l2_ship_restricted.clas.trace.json"), "utf8");
      const usage = trace.lines.find((entry) => /ship~status IN lt_p_restricted/.test(abap[entry.line - 1]));
      expect(usage).to.include({rule_line: lineIn(TEXT, WHEN_AT), param_rule_line: lineIn(TEXT, PARAM_AT)});
      const filled = trace.lines.find((entry) => /ls_p_restricted-low = 'D'/.test(abap[entry.line - 1]));
      expect(filled).to.include({rule_line: lineIn(TEXT, PARAM_AT)});
    });

    it("the class takes the range as its own table type, optional, and a default fills it only when it is not supplied", () => {
      const check = readFileSync(join(OUT, "zcl_l2_ship_restricted.clas.abap"), "utf8");
      expect(check).to.include("      ls_p_exempt-option = 'BT'.\n      ls_p_exempt-low = 'S900'.\n      ls_p_exempt-high = 'S999'.\n");
      for (const line of ["    TYPES tt_restricted TYPE RANGE OF zosd_l2_ship-status.\n", "                iv_restricted TYPE tt_restricted OPTIONAL\n",
        "    IF iv_restricted IS SUPPLIED.\n      lt_p_restricted = iv_restricted.\n    ELSE.\n", "      WHERE ship~status IN lt_p_restricted\n        AND ship~ship_id NOT IN lt_p_exempt\n", "                iv_exempt TYPE tt_exempt OPTIONAL\n"]) {
        expect(check).to.include(line);
      }
      const test = readFileSync(join(OUT, "zcl_l2_ship_restricted.clas.testclasses.abap"), "utf8");
      expect(test).to.include("iv_restricted TYPE zcl_l2_ship_restricted=>tt_restricted OPTIONAL");
      expect(test, "the nested reference form asks the same question").to.include("      WHERE status IN lt_p_restricted\n");
      expect(test, "a case that sets the table builds it from rows").to.include("    DATA lt_p_restricted TYPE zcl_l2_ship_restricted=>tt_restricted.\n");
      expect(test).to.include("zcl_l2_ship_restricted=>check( iv_date = '20261001' it_range = lt_range iv_restricted = lt_p_restricted )");
    });

    it("without a default the parameter is read directly: an empty table is every value", () => {
      const model = compile("nodefault", NO_DEFAULT);
      expect(model.params[0]).to.not.have.property("has_default");
      expect(model.params[0].use).to.equal("iv_restricted");
    });

    it("refuses what is not a range parameter, at the line of the parameter or of the condition", () => {
      for (const [tag, from, to, at, reason] of [
        ["option", "default: [M, D]", "default: [{sign: I, option: NE, low: M}]", PARAM_AT, /^unknown option "NE" \(EQ or BT\)/],
        ["sign", "default: [M, D]", "default: [{sign: X, option: EQ, low: M}]", PARAM_AT, /^unknown sign "X" \(I or E\)/],
        ["key", "default: [M, D]", "default: [{sign: I, option: EQ, low: M, lo: X}]", PARAM_AT, /^unknown range key lo/],
        ["eq-high", "default: [M, D]", "default: [{sign: I, option: EQ, low: M, high: D}]", PARAM_AT, /^an EQ range row has no high/],
        ["bt-no-high", "default: [M, D]", "default: [{sign: I, option: BT, low: M}]", PARAM_AT, /^a range row needs high/],
        ["bt-reversed", "default: [M, D]", "default: [{sign: I, option: BT, low: M, high: D}]", PARAM_AT, /^range row is BT from M to D: low is above high/],
        ["misfit", "default: [M, D]", "default: [M, MM]", PARAM_AT, /^range low must fit CHAR 1: 'MM' is 2 characters, longer than CHAR 1/],
        ["scalar-default", "default: [M, D]", "default: M", PARAM_AT, /must be a list of rows/],
        ["flag", "range: true", "range: yes", PARAM_AT, /^range is true or false, not "yes"/],
        ["string", "type: ZOSD_L2_SHIP-STATUS, range", "type: STRING, range", PARAM_AT, /^parameter \$restricted is a range over STRG/],
        ["long-name", "restricted: {type", `${"r".repeat(25)}: {type`, new RegExp(`${"r".repeat(25)}: \\{type`), /^range parameter r{25} must be at most 24 characters/],
        ["not-a-range", ", range: true, default: [M, D]", ", default: A", WHEN_AT, /^ship\.status in \$restricted: \$restricted is not a range parameter \(declare it with range: true\)/],
        ["scalar-op", "when: ship.status in $restricted", "when: ship.status = $restricted", WHEN_AT, /^\$restricted is a range parameter: write ship\.status in \$restricted or not in \$restricted/],
        ["date", "when: ship.status in $restricted", "when: ship.status in $date", WHEN_AT, /^ship\.status in \$date: \$date is a date, not a range/],
        ["literal", "when: ship.status in $restricted", "when: ship.status in 'M'", WHEN_AT, /^in takes a range parameter \(\$name\), found 'M'/],
        ["left", "when: ship.status in $restricted", "when: $restricted in ship.status", WHEN_AT, /^in takes a range parameter/],
        ["type", "when: ship.status in $restricted", "when: ship.name in $restricted", WHEN_AT, /^ship\.name is CHAR 30, \$restricted is a range of CHAR 1/],
        ["example", "    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]", "    params: {restricted: [MM]}\n    rows:\n      ZOSD_L2_SHIP: [{ship_id: S001, name: Albatross, status: M}]", /params: \{restricted: \[MM\]\}/, /^range low must fit CHAR 1/],
        ["example-option", "params: {restricted: [A]}", "params: {restricted: [{sign: I, option: CP, low: A}]}", /params: \{restricted: \[\{sign: I, option: CP/, /^unknown option "CP"/],
        ["example-name", "params: {restricted: [A]}", "params: {restrict: [A]}", /params: \{restrict:/, /^unknown example parameter \$restrict/],
      ]) refuse(tag, edit(from, to), at, reason);
      expect(readFileSync(write("x", TEXT), "utf8")).to.include("range: true");
    });

    it("`in` of a range and `not in` meet Open SQL's selection table: an empty table is every value, so `not in` of it is none", () => {
      const model = compileRule(RESTRICTED, {registry});
      const A = ["S001", "S002", "S003", "S004", "S005"];
      expect(alertShips(model, SHIPS, {})).to.deep.equal(["S001", "S002"]);
      expect(alertShips(model, SHIPS, {restricted: []})).to.deep.equal(A);
      expect(alertShips(model, SHIPS, {restricted: rows(["E", "EQ", "M"])})).to.deep.equal(["S002", "S003", "S004", "S005"]);
      expect(alertShips(model, SHIPS, {restricted: rows(["I", "BT", "A", "M"], ["E", "EQ", "D"])})).to.deep.equal(["S001", "S003"]);
      expect(alertShips(model, SHIPS, {restricted: rows(["I", "EQ", "A"], ["E", "BT", "A", "Z"])})).to.deep.equal([]);
      const not = compile("not-in", NOT_IN);
      expect(not.when.conditions[0]).to.include({op: "NOT IN", text: "ship.status not in $allowed"});
      expect(alertShips(not, SHIPS, {})).to.deep.equal(["S003", "S004", "S005"]);
      expect(alertShips(not, SHIPS, {allowed: []})).to.deep.equal([]);
      expect(alertShips(not, SHIPS, {allowed: rows(["E", "EQ", "M"])})).to.deep.equal(["S001"]);
      expect(alertShips(not, SHIPS, {allowed: rows(["I", "BT", "A", "M"], ["E", "EQ", "D"])})).to.deep.equal(["S002", "S004", "S005"]);
    });

    const caseKinds = (model) => model.cases.filter((c) => c.derived.condition === "when/1");
    const paramsOf = (model, c, name = "restricted") => ({date: c.date.value, [name]: (c.param_args.find((a) => a.ref === `iv_${name}`)?.rows
      ?? model.params[0].default_rows).map(({sign, option, low, high}) => ({sign, option, low, ...(high ? {high} : {})}))});
    // the model with its one range comparison replaced by a mutant of it
    const mutated = (model, leaf) => ({...model, when: {...model.when, conditions: model.when.conditions.map((c, i) => i === 0 ? leaf : c)}});
    const killers = (model, c) => {
      const cond = model.when.conditions[0];
      const expected = JSON.stringify(c.expect.map((e) => e.value));
      const params = paramsOf(model, c);
      const differs = (leaf) => JSON.stringify(evaluate(mutated(model, leaf), rowsOfCase(c), params)) !== expected;
      return {
        always: differs({...cond, constant: true}), never: differs({...cond, constant: false}),
        flipped: differs({...cond, cmp: {...cond.cmp, op: cond.cmp.op === "IN" ? "NOT IN" : "IN"}}),
        exclusions: differs({...cond, cmp: {...cond.cmp, rhs: {...cond.cmp.rhs, exclusions_ignored: true}}}),
        emptyNone: differs({...cond, cmp: {...cond.cmp, rhs: {...cond.cmp.rhs, empty_is_none: true}}}),
      };
    };

    it("derives a value in the table, one outside it, the table emptied and an E row added, and each one kills its own mutant", () => {
      const model = compileRule(RESTRICTED, {registry});
      const cases = caseKinds(model);
      expect(cases.map((c) => [c.method, c.derived.kind])).to.deep.equal([["b_status_in", "in"], ["b_status_out", "out"], ["b_status_empty", "empty"], ["b_status_excl", "excl"]]);
      const [inCase, outCase, emptyCase, exclCase] = cases;
      const status = (c) => rowsOfCase(c).zosd_l2_ship[0].status;
      expect(["M", "D"]).to.include(status(inCase));
      expect(["M", "D"]).to.not.include(status(outCase));
      expect(inCase.expect).to.have.length(1);
      expect(outCase.expect).to.have.length(0);
      // the emptied table is an argument of the case, and every status passes
      expect(emptyCase.param_args.find((a) => a.ref === "iv_restricted").rows).to.deep.equal([]);
      expect(["M", "D"]).to.not.include(status(emptyCase));
      expect(emptyCase.expect).to.have.length(1);
      // the E row cuts the value that was in
      const added = exclCase.param_args.find((a) => a.ref === "iv_restricted").rows.map((r) => [r.sign, r.option, r.low]);
      expect(added).to.deep.equal([["I", "EQ", "M"], ["I", "EQ", "D"], ["E", "EQ", status(exclCase)]]);
      expect(exclCase.expect).to.have.length(0);
      const k = Object.fromEntries(cases.map((c) => [c.derived.kind, killers(model, c)]));
      expect(k.in, "in: in turned into not in, or never").to.include({flipped: true, never: true, always: false});
      expect(k.out, "out: the range ignored").to.include({always: true, flipped: true, never: false});
      expect(k.empty, "empty: an empty table read as no value").to.include({emptyNone: true, flipped: true});
      expect(k.excl, "excl: the E rows dropped").to.include({exclusions: true, always: true});
      for (const c of cases) expect(caseDiscriminates(model, conditionOf(model, "when/1"), rowsOfCase(c), paramsOf(model, c)), c.method).to.equal(true);
    });

    it("the reviewer's view of the cases names the table a case sets for itself", () => {
      const view = describeCases(compileRule(RESTRICTED, {registry}));
      expect(view).to.include("b_status_empty  [when/1, rule line");
      expect(view).to.include("  $restricted: (empty table)\n");
      expect(view).to.include("  $restricted: I EQ M, I EQ D, E EQ M\n");
      expect(view.match(/^  \$restricted:/gm), "only the two cases that set one").to.have.length(2);
    });

    it("an empty default has no value outside it, and says so; an E row alone still derives its cases", () => {
      const model = compile("empty-default", NO_DEFAULT.replace("range: true}", "range: true, default: []}"));
      expect(caseKinds(model).map((c) => c.derived.kind)).to.deep.equal(["in", "excl"]);
      expect(model.skipped.find((k) => k.condition === "ship.status in $restricted"))
        .to.deep.include({reason: "no value outside the range: an empty range holds every value"});
    });

    it("under `not in` the cases are the same four, and the empty table is the one that holds for no value", () => {
      const model = compile("not-in-cases", NOT_IN);
      const cases = caseKinds(model);
      expect(cases.map((c) => c.derived.kind)).to.deep.equal(["in", "out", "empty", "excl"]);
      for (const c of cases) expect(caseDiscriminates(model, conditionOf(model, "when/1"), rowsOfCase(c), paramsOf(model, c, "allowed")), c.method).to.equal(true);
      const alerting = Object.fromEntries(cases.map((c) => [c.derived.kind, c.expect.length]));
      expect(alerting).to.deep.equal({in: 0, out: 1, empty: 0, excl: 1});
    });

    it("the committed class runs its twelve examples and fifteen derived cases against check_reference in ABAP", async () => {
      await import("./start.mjs");
      const result = await new UnitRun(new ObjectStore()).runDetached("CLAS", "ZCL_L2_SHIP_RESTRICTED");
      const model = compileRule(RESTRICTED, {registry});
      expect(model.examples).to.have.length(12);
      expect(model.cases).to.have.length(15);
      expect(result.counts, JSON.stringify(result.testClasses)).to.include({methods: 27, passed: 27, failed: 0});
    });

    it("without a default the class passes the table straight to the query, and the examples run in ABAP", async () => {
      await import("./start.mjs");
      const file = writeRule("s8-nodefault-run", NO_DEFAULT);
      const {model, results} = await runRule(file, "zcl_l2_s8_nodefault_run");
      const abap = readFileSync(join(scratch, "s8-nodefault-run", "zcl_l2_s8_nodefault_run.clas.abap"), "utf8");
      expect(abap).to.include("      WHERE ship~status IN iv_restricted\n");
      expect(abap).to.not.include("IS SUPPLIED");
      expect(Object.keys(results)).to.have.length(model.examples.length + model.cases.length);
      expect(failed(results)).to.deep.equal([]);
    });

    it("`in` in a require's subquery and `not in` in a when, with defaults of BT rows, agree with check_reference in ABAP", async () => {
      await import("./start.mjs");
      const file = writeRule("s8-require-run", BOTH);
      const {model, results} = await runRule(file, "zcl_l2_s8_require_run");
      const abap = readFileSync(join(scratch, "s8-require-run", "zcl_l2_s8_require_run.clas.abap"), "utf8");
      expect(abap).to.include("AND crew~role IN lt_p_roles");
      expect(abap).to.include("ship~name NOT IN lt_p_skipped");
      expect(abap).to.include("ls_p_roles-option = 'BT'.\n      ls_p_roles-low = 'C'.\n      ls_p_roles-high = 'D'.\n");
      expect(model.cases.map((c) => c.method)).to.include.members(["b_role_in", "b_role_out", "b_role_empty", "b_role_excl",
        "b_name_in", "b_name_out", "b_name_empty", "b_name_excl"]);
      expect(failed(results)).to.deep.equal([]);
    });

    it("`not in` and an empty table (which holds for no value) agree with check_reference in ABAP", async () => {
      await import("./start.mjs");
      const {model, results} = await runRule(writeRule("s8-notin-run", NOT_IN), "zcl_l2_s8_notin");
      const abap = readFileSync(join(scratch, "s8-notin-run", "zcl_l2_s8_notin.clas.abap"), "utf8");
      expect(abap).to.include("      WHERE ship~status NOT IN lt_p_allowed\n");
      expect(model.cases.map((c) => c.method)).to.include.members(["b_status_in", "b_status_out", "b_status_empty", "b_status_excl"]);
      expect(Object.keys(results)).to.have.length(model.examples.length + model.cases.length);
      expect(failed(results)).to.deep.equal([]);
    });

    it("keys( ) of a keys: true rule takes the range parameter too, and its examples run in ABAP", async () => {
      await import("./start.mjs");
      const busy = readFileSync(BUSY, "utf8").replace("class: zcl_l2_ship_busy", "class: zcl_l2_s8_keys").replace("when: ship.status <> 'D'", "when: ship.status in $watch")
        .replace("keys: true\n", "keys: true\nparams:\n  watch: {type: ZOSD_L2_SHIP-STATUS, range: true, default: [A, M]}\n");
      const {model, results} = await runRule(writeRule("s8-keys-run", busy), "zcl_l2_s8_keys");
      const abap = readFileSync(join(scratch, "s8-keys-run", "zcl_l2_s8_keys.clas.abap"), "utf8");
      expect(abap.split("IF iv_watch IS SUPPLIED.").length - 1, "the default is filled in check( ) and in keys( )").to.equal(2);
      expect(abap).to.include("      WHERE ship~status IN lt_p_watch\n        AND voy~dep_date > iv_date\n        AND ship~ship_id IN it_range\n      ORDER BY ship~ship_id.");
      expect(model.cases.filter((c) => c.keys_check).length, "every case also checks keys( )").to.equal(model.cases.length);
      expect(Object.keys(results)).to.have.length(model.examples.length + model.cases.length);
      expect(failed(results)).to.deep.equal([]);
    });

    describe("mutants of the generated ABAP", () => {
      before(async () => { await import("./start.mjs"); });
      const copy = (tag) => write(`mut-${tag}`, TEXT);
      const run = (tag, mutate) => runRule(copy(tag), `zcl_l2_s8_mut_${tag}`, {mutate});

      it("in turned into not in: the cases of a value in and a value out fail", async () => {
        const {results} = await run("notin", mutateBoth("ship~status IN lt_p_restricted", "ship~status NOT IN lt_p_restricted"));
        const red = failed(results);
        for (const method of ["b_status_in", "b_status_out", "b_status_empty", "b_status_excl", "restricted_with_a_voyage_ahead", "active_ship_is_not_restricted"]) expect(red, method).to.include(method);
      });

      it("the table ignored: the case with a value outside it and the example of an active ship fail, and not against the reference alone", async () => {
        const {results, messages} = await run("ignored", {"clas.abap": [["      WHERE ship~status IN lt_p_restricted\n        AND ship~ship_id NOT IN lt_p_exempt", "      WHERE ship~ship_id NOT IN lt_p_exempt"]]});
        const red = failed(results);
        expect(red).to.include.members(["b_status_out", "active_ship_is_not_restricted", "another_table_replaces_default"]);
        for (const method of red) expect(messages[method], method).to.include("assert_same_as_reference");
      });

      it("the default never applied (the table always taken as supplied): every example that leans on the default fails", async () => {
        const {results} = await run("nodefault", {"clas.abap": [["    IF iv_restricted IS SUPPLIED.", "    IF 1 = 1."]],
          "clas.testclasses.abap": [["    IF iv_restricted IS SUPPLIED.", "    IF 1 = 1."]]});
        const red = failed(results);
        expect(red).to.include.members(["active_ship_is_not_restricted", "b_status_out"]);
        expect(red).to.not.include("empty_table_is_every_status");
      });

      it("the default applied over a table that is supplied: the examples that give their own table fail", async () => {
        const {results} = await run("override", {"clas.abap": [["    IF iv_restricted IS SUPPLIED.", "    IF 1 = 2."]],
          "clas.testclasses.abap": [["    IF iv_restricted IS SUPPLIED.", "    IF 1 = 2."]]});
        const red = failed(results);
        expect(red).to.include.members(["another_table_replaces_default", "empty_table_is_every_status", "b_status_empty", "b_status_excl"]);
        expect(red).to.not.include("restricted_with_a_voyage_ahead");
      });
    });
  });
});
