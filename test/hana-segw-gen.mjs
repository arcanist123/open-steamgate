import {expect} from "chai";
import {mkdirSync, mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {run} from "../tools/hana-segw-gen.mjs";
import {registryClass, mergeRegistrations, dumpFacts} from "../tools/segw-registry.mjs";
import {generationHanaSrcProblem, segwPrivateGen} from "../tools/osd-tmp.mjs";

// Registration out of a tenant's Gateway tables (tools/hana-segw-gen.mjs, H5b).
//
// One seam, without a system: the fixture is a dump directory the way the
// dumper writes it (manifest.json, reposrc.jsonl, tables/<name with / as
// #>.jsonl), holding only synthetic ZOSD_H5_* rows. The five registration
// tables appear as the dumper names them; the join and the skips are the
// contract, the class is written by tools/segw-registry.mjs's one writer,
// and the XML-vs-dump override follows the layer rule. The private marking
// is tested against the guard every publisher reads (tools/osd-tmp.mjs).

// the class-pool program of a class: the name padded with '=' to 30, then CP
const pool = (cls) => (cls + "=".repeat(Math.max(0, 30 - cls.length))).slice(0, 30) + "CP";
const prog = (name) => ({program: name, state: "A"});

// a dump directory holding only synthetic ZOSD_H5_* rows
const dump = () => {
  const root = mkdtempSync(join(tmpdir(), "hana-segw-dump-"));
  const table = (name, rows) => {
    mkdirSync(join(root, "tables"), {recursive: true});
    writeFileSync(join(root, "tables", name), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  };
  const reposrc = (programs) => writeFileSync(join(root, "reposrc.jsonl"), programs.map((p) => JSON.stringify(p)).join("\n") + "\n");
  const manifest = (extra = {}) => writeFileSync(join(root, "manifest.json"),
    JSON.stringify({tool: "vsp hana dump", provenance: "the H5 fixtures' own test bed", ...extra}, undefined, 2));
  return {root, table, reposrc, manifest};
};

const srh = (technical, version, dpc, external = technical) => ({
  TECHNICAL_NAME: technical, VERSION: version, EXTERNAL_NAME: external,
  CLASS_NAME: dpc, NAMESPACE: "", IS_SAP_SERVICE: "", SERVICE_TYPE: "0",
  EXT_4_TECH_NAME: "", EXT_4_VERSION: "0000",
});
const srg = (group, groupVersion, model, modelVersion) => ({
  GROUP_TECH_NAME: group, GROUP_VERSION: groupVersion, MODEL_TECH_NAME: model, MODEL_VERSION: modelVersion,
});
const ohd = (technical, version, mpc) => ({TECHNICAL_NAME: technical, VERSION: version, CLASS_NAME: mpc});
const srt = (technical, version, language, description) => ({
  TECHNICAL_NAME: technical, VERSION: version, LANGUAGE: language, DESCRIPTION: description,
});

// a tree of its own for the class write: src is empty, so the XML side of
// the merge is empty unless a test plants an IWSV in it
const tree = () => {
  const root = mkdtempSync(join(tmpdir(), "hana-segw-tree-"));
  mkdirSync(join(root, "src"), {recursive: true});
  writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["src"]}));
  const facts = join(root, "gen", "hana-segw");
  const abap = join(root, "gen", "segw", "zcl_stg_segw_registry.clas.abap");
  const iwsv = (technical, dpc) => writeFileSync(join(root, "src", `${technical.toLowerCase()}.iwsv.xml`),
    `<abapGit><_-IWBEP_-I_MGW_SRG><MODEL_TECH_NAME>ZOSD_H5_MDL</MODEL_TECH_NAME><MODEL_VERSION>0001</MODEL_VERSION></_-IWBEP_-I_MGW_SRG>` +
    `<_-IWBEP_-I_MGW_SRH><TECHNICAL_NAME>${technical}</TECHNICAL_NAME><VERSION>0001</VERSION>` +
    `<EXTERNAL_NAME>${technical}</EXTERNAL_NAME><CLASS_NAME>${dpc}</CLASS_NAME></_-IWBEP_-I_MGW_SRH></abapGit>`);
  return {root, facts, abap, iwsv};
};

describe("hana-segw-gen: registration out of the dumped Gateway tables", () => {
  it("joins service -> model -> MPC and carries the E description", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRT.jsonl", [
        srt("ZOSD_H5_SRV", "0001", "D", "ZOSD_H5 auf Deutsch"),
        srt("ZOSD_H5_SRV", "0001", "E", "the H5 fixture service")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services).to.have.length(1);
      expect(facts.services[0]).to.include({
        service: "ZOSD_H5_SRV", version: "0001", external: "ZOSD_H5_SRV",
        dpc: "ZCL_ZOSD_H5_DPC_EXT", mpc: "ZCL_ZOSD_H5_MPC_EXT", model: "ZOSD_H5_MDL",
        description: "the H5 fixture service",
      });
      expect(facts.skipped).to.deep.equal([]);
      const manifest = JSON.parse(readFileSync(join(t.facts, "manifest.json"), "utf8"));
      expect(manifest.source).to.equal("dump");
      expect(manifest.dump).to.equal(resolve(d.root));
      expect(manifest.provenance).to.equal("the H5 fixtures' own test bed");
      expect("generated_at" in manifest, "no clock: gen/hana-segw is hashed, a clock would rename every generation").to.equal(false);
      const abap = readFileSync(t.abap, "utf8");
      expect(abap).to.contain("iv_service = 'ZOSD_H5_SRV'");
      expect(abap).to.contain("iv_mpc     = 'ZCL_ZOSD_H5_MPC_EXT'");
      expect(abap).to.contain("iv_dpc     = 'ZCL_ZOSD_H5_DPC_EXT'");
      expect(abap).to.contain('" the H5 fixture service');
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("matches versions as the tables carry them: no SRG row for 0002, no OHD row for the model version", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [
        srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT"),
        srh("ZOSD_H5_SRV", "0002", "ZCL_ZOSD_H5_DPC_EXT"),
        srh("ZOSD_H5_LOST_MDL", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [
        srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001"),
        srg("ZOSD_H5_LOST_MDL", "0001", "ZOSD_H5_OTHER_MDL", "9999")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services.map((s) => s.version)).to.deep.equal(["0001"]);
      expect(facts.skipped.map((s) => s.service)).to.deep.equal(["ZOSD_H5_LOST_MDL", "ZOSD_H5_SRV"]);
      expect(facts.skipped.map((s) => s.version)).to.deep.equal(["0001", "0002"]);
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("a service whose DPC or MPC class is absent is reported and skipped, never emitted", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [
        srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT"),
        srh("ZOSD_H5_NO_DPC", "0001", "ZCL_ZOSD_H5_NOWHERE"),
        srh("ZOSD_H5_NO_DPC2", "0001", "ZCL_ZOSD_H5_ALSO_NOWHERE")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [
        srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001"),
        srg("ZOSD_H5_NO_DPC", "0001", "ZOSD_H5_MDL", "0001"),
        srg("ZOSD_H5_NO_DPC2", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      // only the first service's classes are in the dump
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services.map((s) => s.service)).to.deep.equal(["ZOSD_H5_SRV"]);
      expect(facts.skipped.map((s) => s.service).sort()).to.deep.equal(["ZOSD_H5_NO_DPC", "ZOSD_H5_NO_DPC2"]);
      expect(facts.skipped[0].reason).to.match(/ZCL_ZOSD_H5_NOWHERE/);
      const abap = readFileSync(t.abap, "utf8");
      expect(abap).to.not.contain("ZOSD_H5_NO_DPC");
      expect(abap).to.not.contain("ZCL_ZOSD_H5_NOWHERE");
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("a class present under gen/hana-src counts as present", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      // the dump carries no reposrc at all; the classes came through H4's
      // layers instead
      d.manifest();
      mkdirSync(join(t.root, "gen", "hana-src", "000-osd-zosd-h5", "src"), {recursive: true});
      writeFileSync(join(t.root, "gen", "hana-src", "000-osd-zosd-h5", "src", "zcl_zosd_h5_dpc_ext.clas.abap"), "CLASS zcl_zosd_h5_dpc_ext DEFINITION PUBLIC.\nENDCLASS.\n");
      writeFileSync(join(t.root, "gen", "hana-src", "000-osd-zosd-h5", "src", "zcl_zosd_h5_mpc_ext.clas.abap"), "CLASS zcl_zosd_h5_mpc_ext DEFINITION PUBLIC.\nENDCLASS.\n");
      // a real closure layer's flat src/ holds interfaces, programs and
      // function groups beside the classes
      writeFileSync(join(t.root, "gen", "hana-src", "000-osd-zosd-h5", "src", "zif_zosd_h5.intf.abap"), "INTERFACE zif_zosd_h5 PUBLIC.\nENDINTERFACE.\n");
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services).to.have.length(1);
      expect(facts.skipped).to.deep.equal([]);
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("--service filters by technical name and version, and refuses a name nothing matches", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [
        srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT"),
        srh("ZOSD_H5_OTHER", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [
        srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001"),
        srg("ZOSD_H5_OTHER", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      expect(await run(["--from-dump", d.root, "--service", "ZOSD_H5_OTHER"], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services.map((s) => s.service)).to.deep.equal(["ZOSD_H5_OTHER"]);
      for (const nobody of ["ZOSD_H5_NOBODY", "ZOSD_H5_OTHER:0002"]) {
        let refused;
        try {
          await run(["--from-dump", d.root, "--service", nobody], {root: t.root});
          expect.fail("a --service nothing matches must refuse");
        } catch (error) {
          refused = error;
        }
        expect(refused.message).to.contain(nobody);
      }
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("the XML source wins a shared service, reported as an override; other dump services still register", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [
        srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT"),
        srh("ZOSD_H5_ONLY_DUMP", "0001", "ZCL_ZOSD_H5_DUMP_DPC")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [
        srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001"),
        srg("ZOSD_H5_ONLY_DUMP", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT")), prog(pool("ZCL_ZOSD_H5_DUMP_DPC"))]);
      d.manifest();
      // the tree's XML names the same service with its own DPC: the later
      // source wins, the way a later folder wins
      t.iwsv("ZOSD_H5_SRV", "ZCL_ZOSD_H5_XML_DPC");
      writeFileSync(join(t.root, "src", "zosd_h5_mdl.iwmo.xml"),
        "<abapGit><_-IWBEP_-I_MGW_OHD><TECHNICAL_NAME>ZOSD_H5_MDL</TECHNICAL_NAME><VERSION>0001</VERSION><CLASS_NAME>ZCL_ZOSD_H5_XML_MPC</CLASS_NAME></_-IWBEP_-I_MGW_OHD></abapGit>");
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const abap = readFileSync(t.abap, "utf8");
      expect(abap).to.contain("iv_dpc     = 'ZCL_ZOSD_H5_XML_DPC'");
      expect(abap).to.not.contain("iv_dpc     = 'ZCL_ZOSD_H5_DPC_EXT'");
      expect(abap).to.contain("iv_service = 'ZOSD_H5_ONLY_DUMP'");
      expect(abap).to.contain("iv_dpc     = 'ZCL_ZOSD_H5_DUMP_DPC'");
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.overridden).to.deep.equal([{service: "ZOSD_H5_SRV", version: "0001", kept: "xml"}]);
      // and the merge itself, unit-first
      const xml = [{service: "ZOSD_H5_SRV", version: "0001", external: "ZOSD_H5_SRV", dpc: "ZCL_XML", mpc: "ZCL_XML_M", model: "M", modelVersion: "0001", description: ""}];
      const dumpEntries = [{service: "ZOSD_H5_SRV", version: "0001", external: "ZOSD_H5_SRV", dpc: "ZCL_DUMP", mpc: "ZCL_DUMP_M", model: "M", modelVersion: "0001", description: "from the dump"}];
      const merged = mergeRegistrations(xml, dumpEntries);
      expect(merged.entries.map((e) => e.dpc)).to.deep.equal(["ZCL_XML"]);
      expect(merged.overrides).to.deep.equal([{service: "ZOSD_H5_SRV", version: "0001", kept: "xml"}]);
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("--check agrees while the outputs stand and exits 1 on drift", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      expect(await run(["--from-dump", d.root, "--check"], {root: t.root})).to.equal(0);
      writeFileSync(t.abap, "* edited\n");
      expect(await run(["--from-dump", d.root, "--check"], {root: t.root})).to.equal(1);
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      rmSync(join(t.facts, "from-dump.json"));
      expect(await run(["--from-dump", d.root, "--check"], {root: t.root})).to.equal(1);
      // no facts at all is drift too, and says so -- and the folder to
      // check is not an option (the marking test below)
      rmSync(t.facts, {recursive: true, force: true});
      expect(await run(["--from-dump", d.root, "--check"], {root: t.root})).to.equal(1);
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("a registry written from a dump is always marked: the facts live in gen/hana-segw and --facts is not a flag", async () => {
    const d = dump();
    const t = tree();
    try {
      d.table("#IWBEP#I_MGW_SRH.jsonl", [srh("ZOSD_H5_SRV", "0001", "ZCL_ZOSD_H5_DPC_EXT")]);
      d.table("#IWBEP#I_MGW_SRG.jsonl", [srg("ZOSD_H5_SRV", "0001", "ZOSD_H5_MDL", "0001")]);
      d.table("#IWBEP#I_MGW_OHD.jsonl", [ohd("ZOSD_H5_MDL", "0001", "ZCL_ZOSD_H5_MPC_EXT")]);
      d.reposrc([prog(pool("ZCL_ZOSD_H5_DPC_EXT")), prog(pool("ZCL_ZOSD_H5_MPC_EXT"))]);
      d.manifest();
      // whatever the invocation, the class at gen/segw carries tenant names
      // exactly while the facts exist, so it must carry the mark the
      // publishers' filters read -- wherever the tool was pointed
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      expect(existsSync(join(t.facts, "from-dump.json")), "the default run marks").to.equal(true);
      expect(segwPrivateGen("gen/segw/zcl_stg_segw_registry.clas.abap", t.root), "and the guard sees it").to.equal(true);
      rmSync(t.facts, {recursive: true, force: true});
      expect(await run(["--from-dump", d.root, "--service", "ZOSD_H5_SRV:0001"], {root: t.root})).to.equal(0);
      expect(existsSync(join(t.facts, "from-dump.json")), "the --service run marks too").to.equal(true);
      // the mark cannot be separated from the facts: there is no invocation
      // that points them elsewhere
      let refused;
      try {
        await run(["--from-dump", d.root, "--facts", join(t.root, "elsewhere")], {root: t.root});
        expect.fail("--facts must refuse: the facts cannot move off the private mark");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/facts/);
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("dumpFacts refuses the half state: a manifest without its entries file", () => {
    const t = tree();
    try {
      expect(dumpFacts(t.facts)).to.equal(undefined);
      mkdirSync(t.facts, {recursive: true});
      writeFileSync(join(t.facts, "manifest.json"), JSON.stringify({source: "dump", dump: "/nowhere"}));
      let refused;
      try {
        dumpFacts(t.facts);
        expect.fail("a manifest without from-dump.json must refuse");
      } catch (error) {
        refused = error;
      }
      expect(refused.message).to.match(/from-dump\.json/);
      writeFileSync(join(t.facts, "from-dump.json"), JSON.stringify({services: [], skipped: [], overridden: []}));
      expect(dumpFacts(t.facts)).to.include({source: "dump"});
    } finally {
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("a dump that names none of the five tables reads as empty, not as an error", async () => {
    const d = dump();
    const t = tree();
    try {
      d.reposrc([]);
      d.manifest();
      expect(await run(["--from-dump", d.root], {root: t.root})).to.equal(0);
      const facts = JSON.parse(readFileSync(join(t.facts, "from-dump.json"), "utf8"));
      expect(facts.services).to.deep.equal([]);
      const abap = readFileSync(t.abap, "utf8");
      expect(abap).to.contain("CLASS zcl_stg_segw_registry");
    } finally {
      rmSync(d.root, {recursive: true, force: true});
      rmSync(t.root, {recursive: true, force: true});
    }
  });

  it("the transpiler config excludes the facts' .json files", () => {
    // docs/db-backends.md: "Its .json files are excluded from the
    // transpiler like gen/rap/bindings.json." The entry has to match the
    // file names the folder actually holds, not only a file literally
    // named ".json" -- otherwise the pair is handed to the transpiler and
    // the claim is false.
    const config = JSON.parse(readFileSync("abap_transpile.json", "utf8"));
    const excludes = (config.exclude_filter ?? []).map((entry) => new RegExp(entry, "i"));
    for (const name of ["gen/hana-segw/from-dump.json", "gen/hana-segw/manifest.json"]) {
      // the entries are anchored like the ones they copy
      // ("/gen/hana-src/manifest\.json$"), and listFiles hands them the
      // absolute paths it walked (tools/osd-transpile.mjs) -- test the
      // shape the build tests
      expect(excludes.some((re) => re.test(`/tree/${name}`)), `${name} is excluded`).to.equal(true);
    }
  });

  // ---- the private marking, against the guard the publishers read

  describe("the private marking", () => {
    it("segwPrivateGen: gen/segw is dropped exactly while the facts exist", () => {
      const t = tree();
      try {
        expect(segwPrivateGen("gen/segw/zcl_stg_segw_registry.clas.abap", t.root), "no facts, no dump").to.equal(false);
        expect(segwPrivateGen("src/zosd_h5.clas.abap", t.root)).to.equal(false);
        expect(segwPrivateGen("gen/segw", t.root)).to.equal(false);
        // a manifest alone says nothing: the facts are the mark
        mkdirSync(t.facts, {recursive: true});
        writeFileSync(join(t.facts, "manifest.json"), JSON.stringify({source: "dump", dump: "/nowhere"}));
        expect(segwPrivateGen("gen/segw/zcl_stg_segw_registry.clas.abap", t.root)).to.equal(false);
        writeFileSync(join(t.facts, "from-dump.json"), JSON.stringify({services: []}));
        expect(segwPrivateGen("gen/segw/zcl_stg_segw_registry.clas.abap", t.root), "dump-fed").to.equal(true);
        expect(segwPrivateGen("gen/segw", t.root)).to.equal(true);
        expect(segwPrivateGen("gen/segwx/keep.clas.abap", t.root), "a prefix lookalike is no false positive").to.equal(false);
      } finally {
        rmSync(t.root, {recursive: true, force: true});
      }
    });

    it("generationHanaSrcProblem: the facts folder is private through the one prefix list", () => {
      const generation = mkdtempSync(join(tmpdir(), "hana-segw-pub-"));
      try {
        writeFileSync(join(generation, "manifest.json"), JSON.stringify({
          inputs: {folders: ["src", "gen", "gen/hana-segw"]}}));
        const problem = generationHanaSrcProblem(generation);
        expect(problem, "the tenant's registration facts are private").to.match(/gen\/hana-segw/);
        expect(problem).to.match(/private/);
        writeFileSync(join(generation, "manifest.json"), JSON.stringify({
          inputs: {folders: ["src", "gen", "gen/hana-segwx"]}}));
        expect(generationHanaSrcProblem(generation), "a prefix lookalike is no false positive").to.equal(undefined);
        writeFileSync(join(generation, "manifest.json"), JSON.stringify({
          inputs: {folders: ["src", "gen"]}}));
        expect(generationHanaSrcProblem(generation), "a generation without the facts folder publishes").to.equal(undefined);
      } finally {
        rmSync(generation, {recursive: true, force: true});
      }
    });
  });
});
