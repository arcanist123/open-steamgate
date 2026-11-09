// osgo-fast.mjs decides when osgo may skip the Node build. The decision is
// tested over a small tree and a stand-in for osd-build.mjs whose hash has
// the same contract (every input file by digest, `substitute` puts digests
// back, `digests` is filled); the warm rule and the snapshot paths are the
// real ones. The real hash over the real tree is proved by building both
// ways (docs/osgo-fast-rebuild.md, "The fast path").
import {test} from "node:test";
import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, resolve} from "node:path";
import {fastProof, fastStoreEdits, fastSyntaxRefusal} from "./osgo-fast.mjs";

const realTools = resolve(import.meta.dirname, "..");
const sha = (b) => createHash("sha256").update(b).digest("hex");

const stubBuild = `
import {createHash} from "node:crypto";
import {existsSync, readFileSync, readdirSync, readlinkSync} from "node:fs";
import {join, relative, resolve, basename} from "node:path";
const walk = (d) => existsSync(d) ? readdirSync(d, {withFileTypes: true}).flatMap((e) => e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]) : [];
const sha = (b) => createHash("sha256").update(b).digest("hex");
export const layout = (root) => ({byInput: join(root, "build", "by-input")});
export const inputsOf = (root) => { if (globalThis.osgoFastLibError) throw new Error(globalThis.osgoFastLibError); return {folders: [join(root, "src")]}; };
export const liveHash = (root) => { try { return basename(readlinkSync(join(root, "build", "live"))); } catch { return undefined; } };
export const activeOverlay = (o) => o;
export const genHash = (root) => sha(walk(join(root, "gen")).sort().map((f) => relative(root, f) + readFileSync(f)).join("\\0")).slice(0, 16);
export function hashOf(root, inputs, options = {}) {
  const h = createHash("sha256").update(readFileSync(join(root, "config")));
  for (const f of walk(join(root, "src")).sort()) {
    const d = options.substitute?.get(resolve(f)) ?? sha(readFileSync(f));
    options.digests?.set(f, d);
    h.update(relative(root, f)).update(d);
  }
  return h.digest("hex").slice(0, 16);
}
`;

function tree() {
  const root = mkdtempSync(join(tmpdir(), "osgo-fast-"));
  const tools = join(root, "tools");
  mkdirSync(tools);
  writeFileSync(join(tools, "osd-build.mjs"), stubBuild);
  writeFileSync(join(tools, "osd-source-build-view.mjs"), `export const sourceBuildOverlay = async () => globalThis.osgoFastOverlay;`);
  writeFileSync(join(tools, "osd-warm.mjs"), `export {warmRule} from ${JSON.stringify(join(realTools, "osd-warm.mjs"))};`);
  writeFileSync(join(tools, "osd-source-snapshot.mjs"), `export {sourceSnapshotPath} from ${JSON.stringify(join(realTools, "osd-source-snapshot.mjs"))};`);
  mkdirSync(join(root, "src"));
  mkdirSync(join(root, "gen"));
  writeFileSync(join(root, "config"), "{}");
  writeFileSync(join(root, "gen", "registry.abap"), "* generated");
  const files = {
    "src/zcl_a.clas.abap": "CLASS zcl_a DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    METHODS m RETURNING VALUE(r) TYPE string.\nENDCLASS.\nCLASS zcl_a IMPLEMENTATION.\n  METHOD m.\n    r = 'one'.\n  ENDMETHOD.\nENDCLASS.\n",
    "src/zcl_a.clas.xml": "<xml/>",
    "src/zif_b.intf.abap": "INTERFACE zif_b PUBLIC.\n  METHODS x.\nENDINTERFACE.\n",
    "src/zcl_c.clas.abap": "CLASS zcl_c DEFINITION PUBLIC.\n  PUBLIC SECTION.\n    INTERFACES zif_b.\nENDCLASS.\nCLASS zcl_c IMPLEMENTATION.\n  METHOD zif_b~x.\n  ENDMETHOD.\nENDCLASS.\n",
    "src/zstg_t.tabl.xml": "<tabl/>",
    "src/model.stg.yaml": "entities: []\n",
  };
  for (const [f, text] of Object.entries(files)) writeFileSync(join(root, f), text);
  return {root, tools, files};
}

// a full build of the tree as it is: the live generation with its record
async function build(t) {
  const stub = await import(join(t.tools, "osd-build.mjs"));
  const digests = new Map();
  const hash = stub.hashOf(t.root, stub.inputsOf(t.root), {digests});
  const gen = join(t.root, "build", "by-input", hash);
  mkdirSync(join(t.root, "build", "source-by-digest"), {recursive: true});
  const record = {};
  for (const [f, d] of digests) {
    const key = f.slice(t.root.length + 1);
    if (!/\.(abap|xml)$/.test(key)) continue;
    record[key] = d;
    writeFileSync(join(t.root, "build", "source-by-digest", d), readFileSync(f));
  }
  mkdirSync(gen, {recursive: true});
  writeFileSync(join(gen, "manifest.json"), JSON.stringify({hash, gen: stub.genHash(t.root)}));
  writeFileSync(join(gen, "source-inputs.json"), JSON.stringify(record));
  rmSync(join(t.root, "build", "live"), {force: true});
  (await import("node:fs")).symlinkSync(join("by-input", hash), join(t.root, "build", "live"));
  return hash;
}

const edit = (t, f, from, to) => writeFileSync(join(t.root, f), readFileSync(join(t.root, f), "utf8").replace(from, to));

test("a method body edit is fast, and names the generation a full build names", async () => {
  const t = tree();
  try {
    const live = await build(t);
    edit(t, "src/zcl_a.clas.abap", "'one'", "'two'");
    const proof = await fastProof(t.root, {tools: t.tools});
    assert.equal(proof.ok, true, proof.reason);
    assert.equal(proof.base, live);
    assert.deepEqual(proof.changed, ["src/zcl_a.clas.abap"]);
    const full = await build(t);
    assert.equal(proof.hash, full);
    assert.notEqual(full, live);
  } finally { rmSync(t.root, {recursive: true, force: true}); }
});

test("a new method and an interface edit are fast; several edits at once too", async () => {
  const t = tree();
  try {
    await build(t);
    edit(t, "src/zcl_a.clas.abap", "    METHODS m", "    METHODS n.\n    METHODS m");
    edit(t, "src/zcl_a.clas.abap", "  METHOD m.", "  METHOD n.\n  ENDMETHOD.\n  METHOD m.");
    edit(t, "src/zif_b.intf.abap", "  METHODS x.", "  METHODS x.\n  METHODS y.");
    const proof = await fastProof(t.root, {tools: t.tools});
    assert.equal(proof.ok, true, proof.reason);
    assert.deepEqual(proof.changed, ["src/zcl_a.clas.abap", "src/zif_b.intf.abap"]);
  } finally { rmSync(t.root, {recursive: true, force: true}); }
});

test("anything a generator reads takes the full build", async (s) => {
  const cases = [
    ["an INTERFACES line", (t) => edit(t, "src/zcl_c.clas.abap", "    INTERFACES zif_b.", "    INTERFACES zif_b.\n    INTERFACES zif_d.")],
    ["an AMDP body", (t) => edit(t, "src/zcl_a.clas.abap", "  METHOD m.", "  METHOD m BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT.")],
    ["DDIC", (t) => edit(t, "src/zstg_t.tabl.xml", "<tabl/>", "<tabl></tabl>")],
    ["object XML", (t) => edit(t, "src/zcl_a.clas.xml", "<xml/>", "<xml></xml>")],
    ["a YAML", (t) => edit(t, "src/model.stg.yaml", "[]", "[x]")],
    ["a new class", (t) => writeFileSync(join(t.root, "src/zcl_new.clas.abap"), "CLASS zcl_new DEFINITION.\nENDCLASS.\n")],
    ["a removed class", (t) => rmSync(join(t.root, "src/zcl_c.clas.abap"))],
    ["the config", (t) => { edit(t, "src/zcl_a.clas.abap", "'one'", "'two'"); writeFileSync(join(t.root, "config"), "{\"x\":1}"); }],
    ["a stale gen/", (t) => { edit(t, "src/zcl_a.clas.abap", "'one'", "'two'"); writeFileSync(join(t.root, "gen", "registry.abap"), "* other"); }],
    ["an inactive overlay", (t) => { edit(t, "src/zcl_a.clas.abap", "'one'", "'two'"); globalThis.osgoFastOverlay = {exclude: new Set(["x"])}; }],
  ];
  for (const [name, change] of cases) {
    await s.test(name, async () => {
      const t = tree();
      try {
        await build(t);
        change(t);
        const proof = await fastProof(t.root, {tools: t.tools});
        assert.equal(proof.ok, false, `${name} was taken as fast`);
        assert.ok(proof.reason);
      } finally { delete globalThis.osgoFastOverlay; rmSync(t.root, {recursive: true, force: true}); }
    });
  }
});

test("a tree that is built already, or has no live generation, is not the fast case", async () => {
  const t = tree();
  try {
    assert.equal((await fastProof(t.root, {tools: t.tools})).ok, false);
    await build(t);
    const proof = await fastProof(t.root, {tools: t.tools});
    assert.equal(proof.ok, false);
    assert.match(proof.reason, /built already/);
  } finally { rmSync(t.root, {recursive: true, force: true}); }
});

test("an edit put back is the live generation again", async () => {
  const t = tree();
  try {
    const live = await build(t);
    const before = readFileSync(join(t.root, "src/zcl_a.clas.abap"));
    edit(t, "src/zcl_a.clas.abap", "'one'", "'two'");
    writeFileSync(join(t.root, "src/zcl_a.clas.abap"), before);
    const proof = await fastProof(t.root, {tools: t.tools});
    assert.equal(proof.hash, live);
    assert.equal(sha(before), sha(readFileSync(join(t.root, "src/zcl_a.clas.abap"))));
    assert.ok(readdirSync(join(t.root, "build", "by-input")).length === 1);
  } finally { rmSync(t.root, {recursive: true, force: true}); }
});

test("a library that cannot name the generation is a full build, not a throw", async () => {
  const t = tree();
  try {
    await build(t);
    edit(t, "src/zcl_a.clas.abap", "'one'", "'two'");
    globalThis.osgoFastLibError = "lib at x has modified or untracked files";
    const proof = await fastProof(t.root, {tools: t.tools});
    assert.equal(proof.ok, false);
    assert.match(proof.reason, /cannot be named: lib at x has modified/);
  } finally { delete globalThis.osgoFastLibError; rmSync(t.root, {recursive: true, force: true}); }
});

test("the active copies: this build's and the last build's stay, the rest go", async () => {
  const t = tree();
  try {
    const out = join(t.root, ".out", "osgo-active");
    mkdirSync(out, {recursive: true});
    writeFileSync(join(out, "stale"), "x");
    writeFileSync(join(out, "serving"), "y");
    const previous = join(t.root, "zz_store.json");
    writeFileSync(previous, JSON.stringify({active: {"src/zcl_c.clas.abap": ".out/osgo-active/serving", "src/zif_b.intf.abap": "build/by-input/h/source/x"}}));
    edit(t, "src/zcl_a.clas.abap", "'one'", "'two'");
    const edited = fastStoreEdits(t.root, ["src/zcl_a.clas.abap"], out, {previous});
    const mine = sha(readFileSync(join(t.root, "src/zcl_a.clas.abap")));
    assert.deepEqual(edited.get("src/zcl_a.clas.abap"), {digest: mine, path: `.out/osgo-active/${mine}`});
    assert.deepEqual(readdirSync(out).sort(), [mine, "serving"].sort());
    // without a last store only this build's copy is left
    fastStoreEdits(t.root, ["src/zcl_a.clas.abap"], out);
    assert.deepEqual(readdirSync(out), [mine]);
  } finally { rmSync(t.root, {recursive: true, force: true}); }
});

test("a syntax error in an edited object refuses the fast build and names object, file and line", () => {
  const diagnostics = [
    {object: "ZCL_A", message: "/src/zcl_a.clas.abap:7: Method \"nope\" not found, methodCallChain"},
    {object: "ZCL_UNTOUCHED", message: "/lib/zcl_untouched.clas.abap:3: the live generation's own"},
  ];
  const refusal = fastSyntaxRefusal(["src/zcl_a.clas.abap"], diagnostics);
  assert.match(refusal, /ZCL_A: \/src\/zcl_a\.clas\.abap:7: Method "nope" not found/);
  assert.doesNotMatch(refusal, /ZCL_UNTOUCHED/);
  // an error in a local include belongs to its class; a namespace is found by its # name
  assert.ok(fastSyntaxRefusal(["src/zcl_a.clas.locals_imp.abap"], diagnostics));
  assert.ok(fastSyntaxRefusal(["src/#ns#cl_b.clas.abap"], [{object: "/NS/CL_B", message: "x:1: y"}]));
  // errors only in objects nobody edited are not this edit's
  assert.equal(fastSyntaxRefusal(["src/zif_b.intf.abap"], diagnostics), undefined);
  assert.equal(fastSyntaxRefusal(["src/zcl_a.clas.abap"], []), undefined);
});
