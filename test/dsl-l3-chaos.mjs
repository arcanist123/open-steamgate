// DSL L3 slice 6c (docs/dsl-l3.md, "Chaos profiles and overrides"): the twin's
// outcomes as a knob. A manifest names profiles, each a partial override of
// simulate.default; at run time the settings simulate.profile (one of them)
// and simulate.dump / hang / slow / hits_mean / autoclose (explicit overrides)
// choose. Here, without a database: the manifest's refusals at their lines,
// the order of precedence, the JavaScript twin's draws under a profile and an
// override with exact numbers, byte stability of a set without profiles, the
// settings machinery (an enum, a sum), and the mutants of those. The runs on
// a database, ABAP against this twin, are in test/dsl-l3-sim.mjs ("chaos").
import {expect} from "chai";
import {spawnSync} from "node:child_process";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {basename, join, relative, sep} from "node:path";
import {pathToFileURL} from "node:url";
import {compileSet, renderSet, SetError} from "../tools/dsl-l3.mjs";
import {renderCockpit} from "../tools/dsl-l3-cockpit.mjs";
import {chaosOf, configOf, draw, POISSON1} from "../tools/dsl-l3-sim.mjs";

const SET = "src/l2demo/fleet2.l3.yaml";
const OUT = "src/l2demo";
const SET_TEXT = readFileSync(SET, "utf8");
// the commit before the slice: what a set without profiles must still render, byte for byte
const BEFORE = "28d17e752";
const where = (file) => relative(process.cwd(), file).split(sep).join("/");
const git = (args) => spawnSync("git", args, {encoding: "utf8", maxBuffer: 64 * 1024 * 1024});
let model;
const ruleOf = (name) => model.simulate.rules.find((r) => r.rule === name);
const PROFILES = SET_TEXT.match(/^  profiles:\n(    .*\n)+/m)[0];

describe("DSL L3 slice 6c: chaos profiles and overrides", function () {
  this.timeout(300000);
  before(() => { model = compileSet(SET); });
  let scratch;
  before(() => { scratch = mkdtempSync(join(tmpdir(), "dsl-l3-chaos-")); });
  after(() => rmSync(scratch, {recursive: true, force: true}));

  let count = 0;
  const manifest = (edits, text = SET_TEXT) => {
    const dir = join(scratch, `m${++count}`);
    mkdirSync(dir, {recursive: true});
    for (const [from, to] of edits) {
      expect(text, `the set has ${JSON.stringify(from)}`).to.include(from);
      text = text.replace(from, to);
    }
    text = text.replace(/rule: ([a-z_]+\.l2\.yaml)/g, (m, f) => `rule: ${relative(dir, join(process.cwd(), OUT, f)).split(sep).join("/")}`);
    const file = join(dir, "fleet2.l3.yaml");
    writeFileSync(file, text);
    return file;
  };
  const refusedAt = (file, message, at) => {
    const line = readFileSync(file, "utf8").split("\n").findIndex((l) => at.test(l)) + 1;
    expect(line, `a line matches ${at}`).to.be.greaterThan(0);
    let error;
    try { compileSet(file); } catch (e) { error = e; }
    expect(error, `refused: ${message}`).to.be.instanceOf(SetError);
    expect(error.message.slice(where(file).length), error.message).to.match(new RegExp(`^:${line}: ${message.source}`));
  };

  describe("the manifest", () => {
    it("names six profiles, each a partial override: only what it changes for a rule is emitted", () => {
      expect(model.simulate.profile_names).to.deep.equal(["calm", "squall", "storm", "flood", "stuck", "random"]);
      const fields = (rule) => Object.fromEntries(ruleOf(rule).chaos.profiles.map((p) => [p.name, Object.keys(p).filter((k) => k.startsWith("p_")).map((k) => k.slice(2))]));
      // a plain rule takes everything a profile names from default's place
      expect(fields("ship-cargo-limit")).to.deep.equal({calm: ["outcome"], squall: ["outcome"], storm: ["outcome", "slow_factor"], flood: ["hits"], stuck: ["outcome"], random: ["outcome"]});
      // the filter's stage names its outcome, duration and keep: a profile reaches only its slow factor (storm) and, unused by a filter, its hits
      expect(fields("ship-busy")).to.deep.equal({storm: ["slow_factor"], flood: ["hits"]});
      // a rule's own hits beat flood's
      expect(Object.keys(fields("ship-min-crew"))).to.not.include("flood");
      // every profile field traces to the profile's own line
      const at = (name) => SET_TEXT.split("\n").findIndex((l) => l.startsWith(`    ${name}:`) && /outcome|hits/.test(l)) + 1;
      const storm = ruleOf("ship-cargo-limit").chaos.profiles.find((p) => p.name === "storm");
      expect([storm.p_outcome.set_line, storm.p_slow_factor.set_line, storm.set_line]).to.deep.equal([at("storm"), at("storm"), at("storm")]);
      expect(storm.p_outcome).to.include({ok: "600000", slow: "100000", dump: "200000", hang: "100000"});
    });

    it("the profile takes default's place, nothing else: a stage's or a rule's block beats it", () => {
      const stage = (profile) => ruleOf("ship-busy").chaos?.profiles.find((p) => p.name === profile)?.p_outcome;
      expect(stage("storm"), "the candidates stage names its outcome").to.equal(undefined);
      const cfg = (rule, profile) => configOf(ruleOf(rule), {profile});
      expect([cfg("ship-busy", "storm").ok, cfg("ship-busy", "storm").dump, cfg("ship-busy", "calm").dump]).to.deep.equal([500000, 500000, 500000]);
      expect(cfg("ship-min-crew", "flood").hits).to.equal("F");
      expect(cfg("ship-cargo-limit", "flood").hits).to.equal("P");
      expect(cfg("ship-cargo-limit", "default")).to.deep.equal(configOf(ruleOf("ship-cargo-limit")));
      expect(cfg("ship-cargo-limit", "nonesuch"), "an unknown profile is the default").to.deep.equal(configOf(ruleOf("ship-cargo-limit")));
    });

    it("refusals, each at its line", () => {
      refusedAt(manifest([["    calm: {outcome: {ok: 0.99, dump: 0.005, hang: 0, slow: 0.005}}", "    calm: {outcome: {ok: 0.99, dump: 0.005, hang: 0, slow: 0.01}}"]]),
        /the outcome probabilities sum to 1, these to 1\.005/, /^    calm:/);
      refusedAt(manifest([["    squall: {outcome: {ok: 0.85, dump: 0.08, hang: 0.02, slow: 0.05}}", "    squall: {outcome: {ok: 1.2, dump: 0, hang: 0, slow: 0}}"]]),
        /outcome\.ok is a number from 0 to 1 with at most six decimals, not "1\.2"/, /^    squall:/);
      refusedAt(manifest([["    storm: {outcome: {ok: 0.6, dump: 0.2, hang: 0.1, slow: 0.1}, slow_factor: 10}", "    storm: {outcome: {ok: 0.6, dump: 0.2, hang: 0.1, slow: 0.1}, jitter: 10}"]]),
        /unknown key jitter in simulate\.profiles\.storm \(duration, outcome, slow_factor, hits, autoclose\)/, /jitter: 10/);
      // keep is a field of a rule's or a stage's block, not of a profile
      refusedAt(manifest([["    stuck: {outcome: {ok: 0.7, hang: 0.3}}", "    stuck: {keep: 0.5}"]]), /unknown key keep in simulate\.profiles\.stuck/, /stuck: \{keep: 0\.5/);
      refusedAt(manifest([["    stuck: {outcome: {ok: 0.7, hang: 0.3}}", "    stuck: {outcome: {ok: 0.7, crash: 0.3}}"]]), /unknown key crash in outcome/, /crash: 0\.3/);
      refusedAt(manifest([["    flood: {hits: {dist: poisson, mean: 12}}", "    flood: {hits: {dist: poisson, mean: 0}}"]]), /hits\.mean is above 0/, /mean: 0/);
      refusedAt(manifest([["    random: {", "    Random: {"]]), /a profile name is 1 to 20 characters from a-z and _, not "Random"/, /^    Random:/);
      refusedAt(manifest([["    random: {", "    not-random: {"]]), /a profile name is 1 to 20 characters from a-z and _/, /^    not-random:/);
      refusedAt(manifest([["    random: {", "    a_name_of_twenty_one_: {"]]), /a profile name is 1 to 20 characters/, /^    a_name_of/);
      refusedAt(manifest([["    random: {", "    default: {"]]), /default is the name of simulate\.default/, /^    default:/);
      refusedAt(manifest([["    random: {", "    random:\n    other: {"]]), /simulate\.profiles\.random is a mapping of duration, outcome, slow_factor, hits, autoclose/, /^    random:$/);
      const eleven = Array.from({length: 11}, (_, i) => `    p${"abcdefghijk"[i]}: {slow_factor: 2}\n`).join("");
      refusedAt(manifest([[PROFILES, `  profiles:\n${eleven}`]]), /simulate\.profiles has at most 10 profiles/, /^  profiles:/);
      // profiles are chosen by a setting: without it in the tunables they could never run
      refusedAt(manifest([["simulate.profile, ", ""]]), /simulate\.profiles are chosen by the setting simulate\.profile/, /^  profiles:/);
      // and the setting without profiles is not a setting of the set
      refusedAt(manifest([[PROFILES, ""]]), /unknown or unavailable tunable "simulate\.profile"/, /^  tunable:/);
      // a bound the DSL default (-1, not set) falls outside of
      refusedAt(manifest([["    fuses.max_alerts: {min: 1, max: 100000}\n", "    fuses.max_alerts: {min: 1, max: 100000}\n    simulate.dump: {min: 0, max: 100}\n"]]),
        /DSL default of simulate\.dump is outside its bounds/, /^  tunable:/);
    });

    it("the settings: an enum with the manifest's names, the overrides from -1 (not set), the profile and the overrides run-scoped", () => {
      const entry = (name) => model.settings.entries.find((e) => e.name === name);
      expect(entry("simulate.profile")).to.include({default: "default", min: "1", max: "20", pattern: "^(default|calm|squall|storm|flood|stuck|random)$", char: true, scoped: true});
      for (const [name, max] of [["simulate.dump", "1000"], ["simulate.hang", "1000"], ["simulate.slow", "1000"], ["simulate.hits_mean", "100"], ["simulate.autoclose", "1000"]]) {
        expect(entry(name), name).to.include({default: "-1", min: "-1", max, numeric: true, scoped: true});
      }
      // none of them takes a selection field of the pile job (a job step carries at most 20), nor does piles.lanes, read live
      expect(model.settings.entries.filter((e) => e.chaos).map((e) => e.name)).to.have.length(6);
      // remote.destination is the one new setting: read live at send/retry, with no extra job input.
      expect(entry("remote.destination")).to.include({live: true, unscreened: true, scoped: false});
      expect(model.settings.entries.filter((e) => e.unscreened && !e.chaos).map((e) => e.name)).to.deep.equal(["piles.lanes", "remote.destination"]);
      expect(model.settings.entries.filter((e) => !e.unscreened).map((e) => e.screen)).to.deep.equal(Array.from({length: 13}, (_, i) => `s_${i + 1}`));
      expect(model.settings.chaos_outcomes.map((e) => e.name)).to.deep.equal(["simulate.dump", "simulate.hang", "simulate.slow"]);
      // a manifest narrows an override: never more than 30 per cent dumps from the cockpit
      const narrowed = compileSet(manifest([["    fuses.max_alerts: {min: 1, max: 100000}\n", "    fuses.max_alerts: {min: 1, max: 100000}\n    simulate.dump: {min: -1, max: 300}\n"]]));
      expect(narrowed.settings.entries.find((e) => e.name === "simulate.dump")).to.include({min: "-1", max: "300"});
      // a set that lists only some of them gets only those; its sum check covers the outcome shares it has
      const some = compileSet(manifest([[PROFILES, ""], ["simulate.profile, simulate.dump, simulate.hang, simulate.slow, simulate.hits_mean, simulate.autoclose", "simulate.hits_mean"]]));
      expect(some.settings.chaos_sum).to.equal(undefined);
      expect(some.simulate.chaos_conf).to.include({has_hits: true, has_dump: false, has_profile: false});
    });
  });

  describe("the generated code", () => {
    it("every generated line of the set stays under 255 characters (a real system cuts a longer one)", async () => {
      const {files} = await renderSet(model);
      const long = [];
      // Trace and metadata sidecars are JSON, not code imported into an ABAP system.
      for (const [name, text] of Object.entries(files)) if (!/\.trace(?:\.meta)?\.json$/.test(name)) text.split("\n").forEach((l, i) => { if (l.length > 254) long.push(`${name}:${i + 1} ${l.length}`); });
      expect(long).to.deep.equal([]);
      // the job's selection screen takes at most 20 values: the chaos settings are not among them
      const job = files["zl3_fleet2.prog.abap"];
      expect(job.split("\n").filter((l) => /^PARAMETERS /.test(l)).length).to.be.lessThanOrEqual(20);
      expect(job).to.not.include("simulate_dump");
      // they are read from the run's snapshot
      expect(files["zcl_l3_fleet2.clas.abap"]).to.include("ls_work-chaos = zcl_l3_fleet2_work_sim=>chaos_of_run( iv_run ).");
      expect(files["zcl_l3_fleet2_close_sim.clas.abap"]).to.include("ls_chaos = zcl_l3_fleet2_work_sim=>chaos_of_run( lv_run ).");
    });

    it("a set without profiles and chaos settings renders the bytes it rendered before the slice", async function () {
      if (git(["cat-file", "-e", `${BEFORE}:${SET}`]).status !== 0) this.skip();
      // the manifest as it was: no profiles, none of the six settings
      // Restore the pre-chaos manifest and explicitly retain its scheduled job doctor.
      // Normalize the 5e additions, snapshots, event release and the later remote seam; all other live
      // manifest bytes stay in the oracle.
      const slice6c = SET_TEXT
        // The remote variant and its one live setting did not exist in the pre-chaos oracle.
        .replace("      remote: {function: Z_L3_FLEET2_ALERTS, destination: remote.destination, group: ZL3_FLEET2_RFC}\n", "")
        .replace(", remote.destination]", "]").replace(/^# Bounded concurrency[^\n]*\n(# [^\n]*\n){3}/m, "").replace("piles: {release: event}\n", "").replace(", piles.lanes]", "]").replace("  doctor: {as: [daemon], tick: 10}\n", "").replace("[doctor.tick, ", "[")
        .replace(/^snapshots:\n(  .*\n)+/m, "").replace(/^    input:.*\n/gm, "")
        .replace("# takes over a silent pile or gate after 15 minutes; the daemon doctor is\n# armed by every parallel run;",
          "# takes over a lock, a pile or a gate left for 15 minutes and runs as a job of\n# the schedule;");
      expect(slice6c, "only the explicit later additions since 6c").to.equal(git(["show", `8f032a432:${SET}`]).stdout);
      const before = slice6c.replace(PROFILES, "").replace(/^  # Chaos profiles[^\n]*\n(  #[^\n]*\n)*/m, "")
        .replace(/, simulate\.(profile|dump|hang|slow|hits_mean|autoclose)/g, "");
      expect(before, "the set before the slice").to.equal(git(["show", `${BEFORE}:${SET}`]).stdout);
      const file = join(OUT, `zz_chaos_${process.pid}.l3.yaml`);
      writeFileSync(file, before.replace("resilience:\n", "resilience:\n  doctor: {as: [job]}\n"));
      try {
        const model = compileSet(file);
        const {files} = await renderSet(model);
        // the run cockpit's files (its service, DPC extension and two apps) are the
        // cockpit's (slice 6a), which changed after this slice; what this slice owns
        // is everything else the set renders
        const cockpit = new Set(Object.keys(await renderCockpit(model)));
        expect(cockpit.size, "the cockpit renders its own files").to.be.greaterThan(10);
        let compared = 0;
        for (const [name, text] of Object.entries(files)) {
          // a sidecar names the recipes' hashes, which this slice changed; every other file is the bytes
          if (/\.trace(?:\.meta)?\.json$/.test(name) || cockpit.has(name)) continue;
          const was = git(["show", `${BEFORE}:${OUT}/${name}`]);
          expect(was.status, `${name} existed before the slice`).to.equal(0);
          let expected = was.stdout;
          if (name === "zcl_l3_fleet2.clas.abap") {
            // The later dry-report fix is independent of chaos profiles. Pin
            // its whole method to that commit; compare every other byte to BEFORE.
            const fixed = git(["show", `fc353cb58:${OUT}/${name}`]);
            expect(fixed.status, "the dry-report fix is in local history").to.equal(0);
            const method = /^  METHOD dry\.[\s\S]*?^  ENDMETHOD\./m;
            const dry = fixed.stdout.match(method)?.[0];
            expect(dry, "the fixed dry method").to.be.a("string");
            expect(expected).to.match(method);
            expected = expected.replace(method, dry);
          }
          expect(text.replaceAll(basename(file), "fleet2.l3.yaml"), name).to.equal(expected);
          compared++;
        }
        // the set's own files (runner, ports and variants, the twin, settings, reports): 40 without the cockpit's
        expect(compared).to.be.at.least(40);
      } finally { rmSync(file, {force: true}); }
    });

    it("mutant: the comparison is not vacuous: the committed fleet2 differs from the set before", async function () {
      if (git(["cat-file", "-e", `${BEFORE}:${SET}`]).status !== 0) this.skip();
      expect(readFileSync(join(OUT, "zcl_l3_fleet2_work_sim.clas.abap"), "utf8")).to.not.equal(git(["show", `${BEFORE}:${OUT}/zcl_l3_fleet2_work_sim.clas.abap`]).stdout);
    });
  });

  describe("the JavaScript twin under a profile and an override", () => {
    const night = (config, n = 2000, drawing = draw) => {
      const counts = {OK: 0, SLOW: 0, DUMP: 0, HANG: 0};
      let hits = 0, seconds = 0;
      for (let pile = 1; pile <= n; pile++) {
        const d = drawing(config, {run: "R", rule: "ship-cargo-limit", pile, attempt: 1, seed: 42, scale: 0, stale: 900}, []);
        counts[d.outcome]++; hits += d.hits; seconds += d.duration;
      }
      return {...counts, hits, seconds};
    };
    let rule;
    before(() => { rule = ruleOf("ship-cargo-limit"); });
    // the same seed, 2000 piles: exact numbers per profile (the stream is a pure function of its inputs)
    const EXPECTED = {
      default: {OK: 1861, SLOW: 68, DUMP: 51, HANG: 20, hits: 3981},
      calm: {OK: 1980, SLOW: 10, DUMP: 10, HANG: 0, hits: 3981},
      squall: {OK: 1702, SLOW: 100, DUMP: 157, HANG: 41, hits: 3981},
      storm: {OK: 1196, SLOW: 205, DUMP: 401, HANG: 198, hits: 3981},
      flood: {OK: 1861, SLOW: 68, DUMP: 51, HANG: 20, hits: 23956},
      stuck: {OK: 1401, SLOW: 0, DUMP: 0, HANG: 599, hits: 3981},
      random: {OK: 503, SLOW: 495, DUMP: 503, HANG: 499, hits: 3981},
    };
    const shown = (n) => Object.fromEntries(Object.entries(n).filter(([k]) => k !== "seconds"));
    it("the same seed under each profile: exact outcome counts over 2000 piles", () => {
      for (const [profile, expected] of Object.entries(EXPECTED)) expect(shown(night(configOf(rule, {profile}))), profile).to.deep.equal(expected);
      // measurably different: a storm dumps eight times as often as the default, a calm never hangs
      expect(EXPECTED.storm.DUMP).to.be.greaterThan(7 * EXPECTED.default.DUMP);
      expect(night(configOf(rule, {profile: "storm"})).seconds, "a storm's slow piles take ten times as long").to.be.greaterThan(night(configOf(rule, {profile: "default"})).seconds);
    });

    it("an override beats the profile; ok is the rest, and the shares not set are zero once any is", () => {
      const ovr = {outcome_set: true, slow: 100, dump: 300, hang: 0};
      expect(shown(night(configOf(rule, {profile: "stuck", ...ovr})))).to.deep.equal(shown(night(configOf(rule, {profile: "storm", ...ovr}))))
        .and.to.satisfy((n) => n.HANG === 0 && n.OK + n.SLOW + n.DUMP === 2000 && Math.abs(n.DUMP - 600) < 100 && Math.abs(n.SLOW - 200) < 80, "the override's shares, over the profile's");
      expect(chaosOf({"simulate.profile": "storm", "simulate.dump": "250"})).to.deep.equal({profile: "storm", outcome_set: true, slow: 0, dump: 250, hang: 0,
        hits_set: false, hits_mean: 0, close_set: false, close: 0});
      expect(chaosOf({}), "nothing set").to.deep.equal({profile: "default", outcome_set: false, slow: 0, dump: 0, hang: 0, hits_set: false, hits_mean: 0, close_set: false, close: 0});
      expect(configOf(rule, chaosOf({"simulate.dump": "1000"})), "all dumps").to.include({ok: 0, slow: 0, dump: 1000000, hang: 0});
      expect(configOf(rule, chaosOf({"simulate.autoclose": "250"})).autoclose).to.equal(250000);
      // a hits mean of 0 is no hits; of n the sum of n Poisson(1) draws, whose mean is n
      expect(night(configOf(rule, chaosOf({"simulate.hits_mean": "0"}))).hits).to.equal(0);
      const mean = night(configOf(rule, chaosOf({"simulate.hits_mean": "20"}))).hits / 2000;
      expect(mean, "mean of 20").to.be.within(19.5, 20.5);
      expect(night(configOf(rule, chaosOf({"simulate.hits_mean": "20"}))).hits).to.equal(39928);
      expect(configOf(rule, chaosOf({"simulate.hits_mean": "3"}))).to.include({hits: "S", hits_a: 3, cdf: POISSON1});
    });

    // the twin with an edit, from a copy of the file (it has no imports), measured the same way
    const mutated = async (name, from, to) => {
      const text = readFileSync("tools/dsl-l3-sim.mjs", "utf8");
      expect(text, `the twin holds ${JSON.stringify(from)}`).to.include(from);
      const copy = join(scratch, `${name}.mjs`);
      writeFileSync(copy, text.replace(from, to));
      return import(pathToFileURL(copy).href);
    };
    it("mutant: a profile that is ignored: a storm is the default", async () => {
      const m = await mutated("noprofile", "const profile = node.chaos?.profiles.find((p) => p.name === chaos.profile);", "const profile = undefined;");
      expect(shown(night(m.configOf(rule, {profile: "storm"})))).to.deep.equal(EXPECTED.default).and.to.not.deep.equal(EXPECTED.storm);
    });
    it("mutant: the override of the shares ignored", async () => {
      const m = await mutated("noovr", "if (chaos.outcome_set) {", "if (false) {");
      expect(night(m.configOf(rule, chaosOf({"simulate.dump": "1000"}))).DUMP, "dumps by the default's 3 per cent, not all").to.be.lessThan(100);
    });
    it("mutant: a hits mean drawn once, not summed", async () => {
      const m = await mutated("nosum", "for (let i = 1; i < config.hits_a; i++) count += hits(config, stream.next());", ";");
      expect(night(m.configOf(rule, chaosOf({"simulate.hits_mean": "20"})), 2000, m.draw).hits / 2000, "the mean of one Poisson(1)").to.be.lessThan(2);
    });
  });
});
