// The closure on a second service (milestone 4): the five iterator defects
// the five-service family run and the second-service run measured, and the
// kernel-splice refusal, each as a fake-dumper loop scenario
// (test/helpers/hana-closure-fakes.mjs: the real hana-src-gen, a fake dumper
// answering from a staged tenant folder). Synthetic names only.
import {expect} from "chai";
import {existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {run} from "../tools/hana-closure.mjs";
import {cycleName} from "../tools/hana-src-gen.mjs";
import {dumperRequests, outFile, readJson, scratchClosure} from "./helpers/hana-closure-fakes.mjs";

const cls = (name, publicSection, methods) => [
  `CLASS ${name} DEFINITION PUBLIC CREATE PUBLIC.`,
  `  PUBLIC SECTION.`,
  ...publicSection.map((l) => `    ${l}`),
  `ENDCLASS.`,
  `CLASS ${name} IMPLEMENTATION.`,
  ...Object.entries(methods).flatMap(([m, body]) => [`  METHOD ${m}.`, ...body.map((l) => `    ${l}`), `  ENDMETHOD.`]),
  `ENDCLASS.`,
  ``,
].join("\n");

const DEP = cls("zcl_osd_h5x_dep", ["CLASS-METHODS run."], {run: ["RETURN."]});
const SEED_NEEDS_DEP = cls("zcl_osd_h5x_seed", ["METHODS run_it."], {run_it: ["DATA lo_dep TYPE REF TO zcl_osd_h5x_dep.", "CREATE OBJECT lo_dep."]});
const ARGS = (seedDump) => ["--dump", seedDump, "--system", "h5x", "--stub-unresolved"];
const requestedOf = (root) => dumperRequests(root).map((r) => r.requested);
const allRequested = (root) => requestedOf(root).flatMap((r) => Object.values(r).flat());

describe("hana-closure milestone 4: the closure on a second service", function () {
  this.timeout(300000);
  const roots = [];
  const make = (opts) => {
    const s = scratchClosure(opts);
    roots.push(s.root);
    return s;
  };
  const lines = [];
  const say = (m) => lines.push(m);
  after(() => {
    for (const root of roots) rmSync(root, {recursive: true, force: true});
  });

  it("1: a 40-package cycle is one layer of a bounded name, its members in members.json", async () => {
    const {root, env, seedDump} = make({seed: {"zcl_osd_h5x_seed.clas.abap": SEED_NEEDS_DEP},
      tenant: {"zcl_osd_h5x_dep.clas.abap": DEP}, env: {H5X_CYCLE: "40"}});
    const result = await run(ARGS(seedDump), {root, env, say});
    expect(result.stopped).to.equal("fixed-point");
    const folders = readdirSync(join(root, "gen", "hana-src")).filter((f) => f !== "manifest.json");
    const cycle = folders.find((f) => f.includes("-cycle-"));
    expect(cycle, folders.join(", ")).to.not.equal(undefined);
    expect(cycle.length, "a bounded name").to.be.below(80);
    expect(cycle).to.match(/^001-cycle-osg-zosd-h5x-basis-package-with-a-long-n-40-[0-9a-f]{10}$/);
    const members = readJson(join(root, "gen", "hana-src", cycle, "members.json"));
    expect(members.cycle).to.have.lengthOf(40);
    expect(members.name).to.equal(cycle.replace(/^\d+-/, ""));
    expect(readdirSync(join(root, "gen", "hana-src", cycle, "src"))).to.include("zcl_osd_h5x_dep.clas.abap");
    const manifest = readJson(join(root, "gen", "hana-src", "manifest.json"));
    expect(manifest.layers.find((l) => l.cycle !== undefined).cycle).to.have.lengthOf(40);
    // the name is the members' and nothing else's: order does not move it
    expect(cycleName(["b", "a", "c"])).to.equal(cycleName(["c", "b", "a"]));
  });

});
