import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {after, test} from "node:test";
import {lintBuildSpec} from "./lint-engine.mjs";

const repo = resolve(import.meta.dirname, "../..");
const scratch = mkdtempSync(join(tmpdir(), "lint-resolve-parity-"));
const bin = join(scratch, "lintresolve");
const env = {...process.env, GOWORK: "off", GOPROXY: "off"};
for (const key of Object.keys(process.env)) if (key.startsWith("OSD_LIB_") || ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY"].includes(key)) delete process.env[key];
execFileSync("go", ["build", "-o", bin, "./cmd/lintresolve"], {cwd: join(repo, "tools/gogen/go"), env});
after(() => rmSync(scratch, {recursive: true, force: true}));
const write = (root, file, raw) => {mkdirSync(dirname(join(root, file)), {recursive: true}); writeFileSync(join(root, file), raw);};
const fixture = name => {
  const root = join(scratch, name);
  write(root, "abap_transpile.json", JSON.stringify({input_folder: ["base", "overlay", "gen"],
    libs: [{folder: "/lib", files: ["/src/**", "/deps/*"], exclude_filter: ["excluded"]}, {folder: "/missing"}, {folder: "/empty", files: []}],
    not_in_system: ["/skip/", "\\.trace(?:\\.meta)?\\.json$"]}));
  write(root, "abaplint.jsonc", '// full-line comment\n{"syntax":{"version":"v702"},"rules":{"check_syntax":false}}');
  write(root, "libs.lock.json", '{"libraries":[]}');
  write(root, "base/ztest.clas.abap", "CLASS ztest DEFINITION PUBLIC. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS.");
  write(root, "base/ztest.clas.xml", "<xml/>");
  write(root, "base/ztest.clas.locals_def.abap", "TYPES ty TYPE i.");
  write(root, "overlay/ztest.clas.abap", "CLASS ztest DEFINITION PUBLIC. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS.");
  write(root, "lib/deps/d.dtel.xml", "<xml/>");
  write(root, "lib/src/zdep.intf.abap", "INTERFACE zdep PUBLIC. ENDINTERFACE.");
  write(root, "lib/src/Excluded.intf.abap", "excluded");
  write(root, "lib/src/zdep.clas.testclasses.abap", "testclasses");
  write(root, "lib/out/zoutside.intf.abap", "outside");
  write(root, "packs/late/osd-pack.json", '{"name":"late","abap":["src","addon"]}');
  return root;
};
const native = (root, rules, extra = {}) => spawnSync(bin, [root], {input: JSON.stringify(rules), encoding: "utf8", env: {...process.env, ...extra}});
const canonical = value => typeof value === "object" && value !== null
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])])) : value;
const digest = value => createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
async function parity(root, rules, label) {
  const {rules: freshRules, ...raw} = await lintBuildSpec(root);
  const want = JSON.parse(JSON.stringify(raw)); // JSON wire omission semantics.
  const result = native(root, rules ?? freshRules);
  assert.equal(result.status, 0, `${label}: ${result.stderr}`);
  const got = JSON.parse(result.stdout);
  const captured = spawnSync(bin, [root, "--capture"], {input: JSON.stringify(rules ?? freshRules), encoding: "utf8", env: process.env});
  assert.equal(captured.status, 0, `${label} capture: ${captured.stderr}`);
  const orderedInputs = want.files.map(file => [file, createHash("sha256").update(readFileSync(join(root, file))).digest("hex")]);
  assert.deepEqual(JSON.parse(captured.stdout), orderedInputs, `${label}: ordered (Filename,SHA256(raw))`);
  assert.deepEqual(got, want, label); // Includes byte-exact config, ordered paths and duplicates.
  assert.equal(JSON.stringify(canonical(got)), JSON.stringify(canonical(want)), label);
  return {rules: rules ?? freshRules, facts: want};
}

test("fixed rules refresh every ordered fact through library, hidden and pack type mutations", async () => {
  const root = fixture("mutations");
  const {rules} = await parity(root, undefined, "initial");
  const cases = [
    ["library add", () => write(root, "lib/src/new.intf.abap", "INTERFACE new PUBLIC. ENDINTERFACE.")],
    ["library rename", () => renameSync(join(root, "lib/src/new.intf.abap"), join(root, "lib/src/renamed.intf.abap"))],
    ["library remove", () => rmSync(join(root, "lib/src/renamed.intf.abap"))],
    ["excluded case insensitive", () => write(root, "lib/src/eXcLuDeD2.intf.abap", "excluded")],
    ["outside glob", () => write(root, "lib/else/new.intf.abap", "outside")],
    ["testclasses", () => write(root, "lib/src/new.clas.testclasses.abap", "testclasses")],
    ["missing library created", () => write(root, "missing/src/new.intf.abap", "INTERFACE new PUBLIC. ENDINTERFACE.")],
    ["hidden winner removed", () => rmSync(join(root, "overlay/ztest.clas.abap"))],
    ["cross layer XML hides whole object", () => write(root, "gen/ztest.clas.xml", "<xml/>")],
    ["candidate directory", () => write(root, "packs/late/addon/zpack.intf.abap", "INTERFACE zpack PUBLIC. ENDINTERFACE.")],
    ["candidate file", () => {rmSync(join(root, "packs/late/addon"), {recursive: true}); write(root, "packs/late/addon", "file");}],
    ["candidate missing again", () => rmSync(join(root, "packs/late/addon"))],
    ["sidecars do not compete", () => {for (const p of ["base", "overlay"]) {write(root, `${p}/Component.js.trace.json`, "{}"); write(root, `${p}/package.devc.xml`, "<xml/>");}}],
    ["UTF16 order and full Unicode identity", () => {
      for (const n of ["\u{10000}", "\ue000", "ß", "SS"]) write(root, `base/${n}.intf.abap`, "INTERFACE z PUBLIC. ENDINTERFACE.");
      write(root, "overlay/SS.intf.xml", "<xml/>");
    }],
    ["case sensitive extension", () => write(root, "base/upper.intf.ABAP", "not included")],
  ];
  for (const [label, mutate] of cases) {mutate(); await parity(root, rules, label);}
  const empty = join(scratch, "empty-path"); mkdirSync(empty);
  const result = native(root, rules, {PATH: empty});
  assert.equal(result.status, 0, result.stderr);
});

test("each structural guard and environment selector refuses with rebuild", async () => {
  for (const file of ["abaplint.jsonc", "abap_transpile.json", "libs.lock.json", "packs/late/osd-pack.json"]) {
    const root = fixture("guard-" + file.replaceAll("/", "_"));
    const {rules} = await lintBuildSpec(root);
    write(root, file, readFileSync(join(root, file), "utf8") + "\n");
    const result = native(root, rules); assert.notEqual(result.status, 0); assert.match(result.stderr, /rebuild/);
  }
  for (const [label, mutate] of [
    ["new pack", r => write(r, "packs/new/osd-pack.json", '{"name":"new"}')],
    ["removed pack", r => rmSync(join(r, "packs/late"), {recursive: true})],
    ["renamed pack", r => renameSync(join(r, "packs/late"), join(r, "packs/renamed"))],
    ["tmp topology", r => write(r, "local/tmp/new.prog.abap", "REPORT new.")],
    ["installed identity", r => write(r, ".local/system/.osd-system.json", "{}")],
    ["abapgit metadata", r => write(r, "base/.abapgit.xml", "<abapGit/>")],
  ]) {
    const root = fixture("guard-" + label); const {rules} = await lintBuildSpec(root); mutate(root);
    const result = native(root, rules); assert.notEqual(result.status, 0, label); assert.match(result.stderr, /rebuild/, label);
  }
  const root = fixture("env"); const {rules} = await lintBuildSpec(root);
  for (const key of ["OSD_PACKS", "OSD_WEB_PACKS", "OSD_TMP", "OSD_LAYERS", "OSD_LAYER_PACKAGE", "OSD_LAYER_DISCOVERY_ONLY", "OSD_LIB_NEW"]) {
    const result = native(root, rules, {[key]: "changed"}); assert.notEqual(result.status, 0, key); assert.match(result.stderr, /rebuild/, key);
  }
});

test("regex incompatibilities fail at build time", async () => {
  for (const re of ["(?=x)", "(x)\\1", "\\s", "[[:alpha:]]"]) {
    const root = fixture("regex-" + digest(re).slice(0, 8));
    const cfg = JSON.parse(readFileSync(join(root, "abap_transpile.json"))); cfg.not_in_system = [re];
    write(root, "abap_transpile.json", JSON.stringify(cfg));
    await assert.rejects(lintBuildSpec(root), /rebuild|Command failed/);
  }
});

test("full checkout disposable copy matches every fact", async t => {
  const root = join(scratch, "checkout");
  // Preserve the configured source closure; avoid copying dependency/build caches.
  cpSync(repo, root, {recursive: true, filter: path => {
    const parts = relative(repo, path).split("/");
    return !parts.some(p => [".git", "node_modules", ".out"].includes(p)) && !["output", "build"].includes(parts[0]);
  }});
  const {facts} = await parity(root, undefined, "full checkout");
  t.diagnostic(JSON.stringify({roots: facts.store.roots.length, libraryGroups: facts.store.libs.length,
    libraryPlaces: facts.libraryPlaces.length, files: facts.files.length, hidden: facts.hidden.length,
    guards: Object.keys(facts.guards).length, factsSha256: digest(facts), filesSha256: digest(facts.files), configSha256: digest(facts.config)}));
});
