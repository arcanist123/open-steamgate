// The per-object cache through the production entry points (osg-build.mjs
// compileOsg / osgDatabase) on a disposable one-class project: a cache a
// build left without its database record, or with metadata of another
// shape, must make the next fast build run the full front end -- not abort
// it in osgDatabase, and not throw out of compileOsg.
import {test} from "node:test";
import assert from "node:assert/strict";
import {copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const repo = join(import.meta.dirname, "..", "..");
const root = mkdtempSync(join(tmpdir(), "osgo-incr-fallback-"));
mkdirSync(join(root, "app"));
for (const d of ["tools", "node_modules", "test"]) symlinkSync(join(repo, d), join(root, d));
for (const f of ["libs.lock.json", "abaplint.jsonc"]) copyFileSync(join(repo, f), join(root, f));
writeFileSync(join(root, "abap_transpile.json"), JSON.stringify({input_folder: ["app"], libs: []}));
const file = join(root, "app", "zcl_incr_fallback.clas.abap");
writeFileSync(file, `CLASS zcl_incr_fallback DEFINITION PUBLIC. PUBLIC SECTION. METHODS run RETURNING VALUE(r) TYPE i. ENDCLASS.
CLASS zcl_incr_fallback IMPLEMENTATION. METHOD run. r = 1. ENDMETHOD. ENDCLASS.`);
process.env.OSG_HOME = root;
const {compileOsg, osgDatabase} = await import("./osg-build.mjs");
const gen = join(root, "build", "osgo-incr", "live1");
const owners = new Set(["ZCL_INCR_FALLBACK"]);
const proof = {ok: true, base: "live1", changed: ["app/zcl_incr_fallback.clas.abap"]};
const setLiteral = (n) => writeFileSync(file, readFileSync(file, "utf8").replace(/r = \d+\./, `r = ${n}.`));

test.after(() => rmSync(root, {recursive: true, force: true}));

test("a recording without its database record is a full-build miss, and the build completes", async () => {
  // the full build records the index, then stops before osgDatabase
  compileOsg({includeTests: owners, incr: {recordGen: "live1"}});
  setLiteral(2);
  const fast = compileOsg({includeTests: owners, incr: {proof}});
  assert.equal(fast.incr?.read, undefined);
  assert.match(fast.incr?.refused ?? "", /no completion stamp/);
  assert.equal(fast.program.classes.some((c) => c.name === "ZCL_INCR_FALLBACK"), true);
  const db = await osgDatabase(fast.program, {incr: fast.incr});
  assert.ok(Array.isArray(db.statements));
});

test("a complete recording is taken; damaged metadata then refuses instead of throwing", async () => {
  const full = compileOsg({includeTests: owners, incr: {recordGen: "live1"}});
  await osgDatabase(full.program, {incr: full.incr}); // writes db.json and the stamp
  setLiteral(3);
  const fast = compileOsg({includeTests: owners, incr: {proof}});
  assert.ok(fast.incr?.read, fast.incr?.refused);
  const db = await osgDatabase(fast.program, {incr: fast.incr});
  assert.ok(Array.isArray(db.statements));
  writeFileSync(join(gen, "index.json"), "null");
  const damaged = compileOsg({includeTests: owners, incr: {proof}});
  assert.equal(damaged.incr?.read, undefined);
  assert.match(damaged.incr?.refused ?? "", /incomplete or damaged/);
});
