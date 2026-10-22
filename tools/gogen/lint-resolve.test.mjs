import assert from "node:assert/strict";
import {execFileSync, spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname, join, relative, resolve} from "node:path";
import {after, test} from "node:test";
import {zipInProcess} from "../osd-abapgit-zip.mjs";
import {abapgitXml} from "../osd-abapgit-xml.mjs";
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
  return {rules: rules ?? freshRules, facts: want, orderedInputs};
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

test("duplicate libraries, default pack fallback, explicit layers and selections", async () => {
  const root = fixture("selection");
  const cfg = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
  cfg.input_folder = ["base", "base", "overlay", "gen"];
  cfg.libs.push({folder: "/lib", files: "/deps/**"});
  cfg.libs.push({folder: "/lib", files: [null, false, 12]});
  write(root, "abap_transpile.json", JSON.stringify(cfg));
  write(root, "packs/default/osd-pack.json", '{"name":"default","order":1}');
  write(root, "packs/default/zfallback.prog.abap", "REPORT zfallback.");
  const {rules} = await parity(root, undefined, "default candidate dot and duplicate library paths");
  write(root, "packs/default/src/zselected.prog.abap", "REPORT zselected.");
  await parity(root, rules, "default switches from dot to src");
  for (const value of ["off", "on"]) {
    process.env.OSD_TMP = value;
    await parity(root, undefined, "TMP=" + value);
    delete process.env.OSD_TMP;
  }
  process.env.OSD_WEB_PACKS = "late";
  try { await parity(root, undefined, "selected packs"); } finally {delete process.env.OSD_WEB_PACKS;}
  const external = join(scratch, "external-pack");
  write(external, "osd-pack.json", '{"name":"external"}');
  write(external, "src/zexternal.prog.abap", "REPORT zexternal.");
  process.env.OSD_PACKS = external;
  try { await parity(root, undefined, "pack place is an external pack"); } finally {delete process.env.OSD_PACKS;}
  const layer = join(scratch, "folder-layer");
  write(layer, ".abapgit.xml", abapgitXml());
  write(layer, "src/package.devc.xml", "<DEVCLASS>ZLAYER</DEVCLASS>");
  write(layer, "src/ztest.clas.xml", "<xml/>");
  process.env.OSD_LAYERS = layer;
  try {
    const {rules} = await parity(root, undefined, "abapGit folder layer");
    write(layer, ".abapgit.xml", abapgitXml() + "\n");
    assert.match(native(root, rules).stderr, /rebuild/);
  } finally {delete process.env.OSD_LAYERS;}
});

test("listed pack candidates keep generic fallback metadata and TMP filtering position", async () => {
  const root = fixture("overlap");
  const cfg = JSON.parse(readFileSync(join(root, "abap_transpile.json")));
  cfg.input_folder = ["local/tmp", "base", "packs/late/addon", "gen"];
  write(root, "abap_transpile.json", JSON.stringify(cfg));
  process.env.OSD_TMP = "off";
  try {
    const {rules} = await parity(root, undefined, "listed missing candidate");
    write(root, "packs/late/addon/zaddon.prog.abap", "REPORT zaddon.");
    await parity(root, rules, "listed candidate becomes pack root");
    rmSync(join(root, "packs/late/addon"), {recursive: true});
    await parity(root, rules, "listed candidate falls back to generic root");
  } finally {delete process.env.OSD_TMP;}
});

test("installed physical paths retain logical exclusions and ordered pack slots", async () => {
  const root = fixture("installed");
  write(root, "abap_transpile.json", JSON.stringify({input_folder: ["src", "gen"],
    libs: [{folder: "/.local/lars/lib", exclude_filter: ["/src/skip/"]}], not_in_system: ["/src/skip/"]}));
  const id = "sha256:" + "a".repeat(64);
  const layers = [["input", "src"], ["lib", "lib"], ["pack", "last"]].map(([kind, name], order) => ({kind, name, order,
    digest: id, treeDigest: id, path: `${kind === "lib" ? "libs" : kind === "pack" ? "packs" : "inputs"}/${name}`}));
  write(root, ".local/system/.osd-system.json", JSON.stringify({digest: id, layers}));
  for (const l of layers) {
    const path = ".local/system/" + l.path;
    write(root, path + "/.osd-layer.json", JSON.stringify(l));
    write(root, path + "/.abapgit.xml", abapgitXml());
    write(root, path + "/src/ztest.prog.abap", "REPORT ztest.");
    write(root, path + "/src/skip/zskip.prog.abap", "REPORT zskip.");
    if (l.kind === "pack") write(root, path + "/osd-pack.json", '{"name":"last","abap":["src","addon"]}');
  }
  const {rules} = await parity(root, undefined, "installed");
  write(root, ".local/system/packs/last/addon/zextra.prog.abap", "REPORT zextra.");
  await parity(root, rules, "installed candidate creation");
  write(root, ".local/system/libs/lib/.osd-layer.json", "{}");
  assert.match(native(root, rules).stderr, /rebuild/);
});

test("prepared ZIP layers resolve without materializing and refuse changed archives", async () => {
  const root = fixture("zip");
  const source = join(scratch, "zip-source");
  write(source, ".abapgit.xml", abapgitXml());
  write(source, "src/package.devc.xml", "<DEVCLASS>ZZIP</DEVCLASS>");
  write(source, "src/ztest.clas.abap", "CLASS ztest DEFINITION PUBLIC. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS.");
  write(source, "src/ztest.clas.xml", "<xml/>");
  write(root, "layer.zip", zipInProcess(source));
  process.env.OSD_LAYERS = "layer.zip";
  try {
    const {rules} = await parity(root, undefined, "prepared ZIP");
    const overlay = rules.roots.find(r => r.overlayOf).path;
    write(root, overlay + "/ztest.clas.abap", "CLASS ztest DEFINITION PUBLIC. ENDCLASS. CLASS ztest IMPLEMENTATION. ENDCLASS.\n");
    await parity(root, rules, "ZIP overlay byte edit");
    write(root, "layer.zip", Buffer.concat([readFileSync(join(root, "layer.zip")), Buffer.from("changed")]));
    assert.match(native(root, rules).stderr, /rebuild/);
  } finally {delete process.env.OSD_LAYERS;}
});

test("inferred root package is guarded while ordinary same-prefix additions remain mutable", async () => {
  const root = fixture("inferred-package");
  const layer = join(scratch, "inferred-layer");
  write(layer, ".abapgit.xml", abapgitXml());
  write(layer, "src/zcl_one_first.clas.abap", "CLASS zcl_one_first DEFINITION PUBLIC. ENDCLASS. CLASS zcl_one_first IMPLEMENTATION. ENDCLASS.");
  process.env.OSD_LAYERS = layer;
  try {
    const {rules} = await parity(root, undefined, "inferred package initial");
    write(layer, "src/zcl_one_second.clas.abap", "CLASS zcl_one_second DEFINITION PUBLIC. ENDCLASS. CLASS zcl_one_second IMPLEMENTATION. ENDCLASS.");
    await parity(root, rules, "same package prefix");
    write(layer, "src/zcl_other_first.clas.abap", "CLASS zcl_other_first DEFINITION PUBLIC. ENDCLASS. CLASS zcl_other_first IMPLEMENTATION. ENDCLASS.");
    assert.match(native(root, rules).stderr, /rebuild/);
    rmSync(join(layer, "src/zcl_other_first.clas.abap"));
    write(layer, "src/package.devc.xml", "<DEVCLASS>ZCHANGED</DEVCLASS>");
    assert.match(native(root, rules).stderr, /rebuild/);
  } finally {delete process.env.OSD_LAYERS;}
});

test("critic 838: unnamed DEVC header still guards inferred package mutations", async () => {
  const root = fixture("critic-unnamed");
  write(root, "base/.abapgit.xml", "<abapGit><STARTING_FOLDER>/</STARTING_FOLDER></abapGit>");
  write(root, "base/package.devc.xml", "<DEVC><CTEXT>Root package</CTEXT></DEVC>");
  write(root, "base/zcl_one_first.clas.abap", "CLASS zcl_one_first DEFINITION PUBLIC. ENDCLASS.");
  const {rules, facts} = await parity(root, undefined, "unnamed header initial");
  assert.equal(facts.store.roots[0].package, "$ZONE");
  write(root, "base/zcl_other_first.clas.abap", "CLASS zcl_other_first DEFINITION PUBLIC. ENDCLASS.");
  const fresh = await lintBuildSpec(root);
  assert.equal(fresh.store.roots[0].package, "$OSD_BASE");
  assert.match(native(root, rules).stderr, /rebuild/);
});

test("critic 838: pack validation folders refuse removal and file replacement", async () => {
  for (const replacement of [false, true]) {
    const root = fixture("critic-bsp-" + replacement);
    write(root, "packs/late/osd-pack.json", '{"name":"late","abap":"src","bsp":{"APP":"webapp"}}');
    write(root, "packs/late/src/zpack.prog.abap", "REPORT zpack.");
    write(root, "packs/late/webapp/index.html", "ok");
    const {rules} = await parity(root, undefined, "BSP directory initial");
    rmSync(join(root, "packs/late/webapp"), {recursive: true});
    if (replacement) write(root, "packs/late/webapp", "file");
    await assert.rejects(lintBuildSpec(root), /bsp APP.*not a folder/);
    assert.match(native(root, rules).stderr, /rebuild/);
  }
});

test("critic 838: root pack keeps empty candidate key through membership mutation", async () => {
  const root = fixture("critic-root-pack");
  write(root, "osd-pack.json", '{"name":"rootpack"}');
  process.env.OSD_PACKS = ".";
  try {
    const {rules, facts} = await parity(root, undefined, "root pack initial");
    assert.equal(facts.packSources[""], "directory");
    write(root, "src/zroot.prog.abap", "REPORT zroot.");
    await parity(root, rules, "root pack switches to src");
    rmSync(join(root, "src"), {recursive: true});
    await parity(root, rules, "root pack falls back to dot");
  } finally { delete process.env.OSD_PACKS; }
});

test("sweep: optional DDIC requirements cover every mutable ABAP fallback", async () => {
  const root = fixture("sweep-ddic");
  write(root, "packs/late/osd-pack.json", '{"name":"late"}');
  const {rules} = await parity(root, undefined, "default DDIC before fallback switch");
  write(root, "packs/late/src/znew.prog.abap", "REPORT znew.");
  await parity(root, rules, "new ABAP candidate without DDIC");
  write(root, "packs/late/src/ddic/znew.tabl.xml", "<xml/>");
  await lintBuildSpec(root); // Optional folder is valid; fixed structural policy requires rebuilding.
  assert.match(native(root, rules).stderr, /rebuild/);
});

test("sweep: shadow scan errors and ZIP overlay topology refuse before checking", async () => {
  const shadow = fixture("sweep-shadow");
  const {rules: shadowRules} = await lintBuildSpec(shadow);
  symlinkSync(join(shadow, "absent"), join(shadow, "local-broken"));
  mkdirSync(join(shadow, "local"));
  renameSync(join(shadow, "local-broken"), join(shadow, "local/broken"));
  await assert.rejects(lintBuildSpec(shadow), /ENOENT/);
  assert.match(native(shadow, shadowRules).stderr, /rebuild/);

  const root = fixture("sweep-zip");
  const source = join(scratch, "sweep-zip-source");
  write(source, ".abapgit.xml", abapgitXml());
  write(source, "src/package.devc.xml", "<DEVCLASS>ZZIP</DEVCLASS>");
  write(source, "src/zcl_zip.clas.abap", "CLASS zcl_zip DEFINITION PUBLIC. ENDCLASS.");
  write(root, "layer.zip", zipInProcess(source));
  process.env.OSD_LAYERS = "layer.zip";
  try {
    const {rules} = await parity(root, undefined, "sweep ZIP initial");
    const overlay = rules.roots.find(r => r.overlayOf).path;
    const target = join(root, overlay, "zcl_zip.clas.abap");
    rmSync(target);
    assert.match(native(root, rules).stderr, /rebuild/); // Node would seed it again.
    await parity(root, undefined, "fresh Node reseeds missing overlay member");
    renameSync(join(root, overlay), join(root, overlay + "-saved"));
    symlinkSync(join(root, overlay + "-saved"), join(root, overlay));
    await assert.rejects(lintBuildSpec(root), /redirected through a link/);
    assert.match(native(root, rules).stderr, /rebuild/);
  } finally { delete process.env.OSD_LAYERS; }
});

test("critic 838 round 2: former pack root becomes a broken shadow link", async () => {
  const root = fixture("critic-former-root-shadow");
  write(root, "local/osd-pack.json", '{"name":"p","abap":"extra"}');
  write(root, "local/extra/zextra.prog.abap", "REPORT zextra.");
  process.env.OSD_PACKS = "local";
  try {
    const {rules, facts} = await parity(root, undefined, "former root initial");
    assert(facts.store.roots.some(r => r.path === "local/extra"));
    rmSync(join(root, "local/extra"), {recursive: true});
    symlinkSync(join(root, "absent"), join(root, "local/extra"));
    await assert.rejects(lintBuildSpec(root), /ENOENT/);
    const result = native(root, rules);
    assert.notEqual(result.status, 0, result.stdout);
    assert.match(result.stderr, /rebuild: shadow stat failed: local\/extra/);
  } finally { delete process.env.OSD_PACKS; }
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
  const {facts, rules, orderedInputs} = await parity(root, undefined, "full checkout");
  t.diagnostic(JSON.stringify({roots: facts.store.roots.length, libraryGroups: facts.store.libs.length,
    libraryPlaces: facts.libraryPlaces.length, files: facts.files.length, hidden: facts.hidden.length,
    guards: Object.keys(facts.guards).length, selectedPacks: rules.packs.length,
    libraryFiles: facts.store.libs.reduce((n,lib) => n + lib.files.length, 0),
    packCandidateTypes: Object.values(facts.packSources).reduce((out,kind) => ({...out, [kind]: (out[kind] ?? 0) + 1}), {}),
    orderedInputsSha256: digest(orderedInputs),
    configBytesSha256: createHash("sha256").update(facts.config).digest("hex"), factsSha256: digest(facts), filesSha256: digest(facts.files), configSha256: digest(facts.config)}));
});
