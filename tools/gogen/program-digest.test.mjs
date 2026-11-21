// The generation digest (program-digest.mjs) must notice every program
// change the emitted Go notices: the generation used to be the hash of the
// unlayered emission, and this checks, over one small tree and a battery of
// edits that each touch one thing the emitter reads, that the digest changes
// exactly when the emitted text changes. (Tables and DDIC are covered by the
// real-tree proof in docs/osgo-fast-rebuild.md; this tree has none.)
import {test} from "node:test";
import assert from "node:assert/strict";
import {mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {compileProgram} from "./frontend.mjs";
import {emitGo, componentInterfaces} from "./emit-go.mjs";
import {programDigest} from "./program-digest.mjs";

const base = {
  "app/zif_digest.intf.abap": `INTERFACE zif_digest PUBLIC.
  TYPES: BEGIN OF ty_row, a TYPE i, b TYPE string, END OF ty_row.
  TYPES ty_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
  CONSTANTS co_v TYPE i VALUE 1.
  METHODS m IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.
ENDINTERFACE.`,
  "app/zcl_digest_impl.clas.abap": `CLASS zcl_digest_impl DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_digest.
    CONSTANTS co_own TYPE string VALUE 'own'.
    CLASS-DATA static TYPE i VALUE 7.
    METHODS use IMPORTING x TYPE i EXPORTING y TYPE i.
ENDCLASS.
CLASS zcl_digest_impl IMPLEMENTATION.
  METHOD zif_digest~m.
    r = n + 1.
  ENDMETHOD.
  METHOD use.
    y = x * zcl_digest_impl=>static.
  ENDMETHOD.
ENDCLASS.`,
  "app/zcl_digest_caller.clas.abap": `CLASS zcl_digest_caller DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS run RETURNING VALUE(r) TYPE string.
ENDCLASS.
CLASS zcl_digest_caller IMPLEMENTATION.
  METHOD run.
    DATA rows TYPE zif_digest=>ty_rows.
    DATA ref TYPE REF TO zif_digest.
    CREATE OBJECT ref TYPE zcl_digest_impl.
    r = |{ ref->m( 1 ) }:{ zcl_digest_impl=>co_own }:{ zif_digest=>co_v }:{ lines( rows ) }|.
  ENDMETHOD.
ENDCLASS.`,
};

// each edit must flip BOTH the emitted text and the digest; nothing here
// changes the class or method inventory, so the emission stays comparable
const edits = {
  "a method body": ["app/zcl_digest_impl.clas.abap", "r = n + 1.", "r = n + 2."],
  "a constant value": ["app/zcl_digest_impl.clas.abap", "VALUE 'own'.", "VALUE 'own2'."],
  "a static attribute value": ["app/zcl_digest_impl.clas.abap", "VALUE 7.", "VALUE 8."],
  "an interface constant": ["app/zif_digest.intf.abap", "VALUE 1.", "VALUE 2."],
  "an interface method signature": ["app/zif_digest.intf.abap", "IMPORTING n TYPE i RETURNING VALUE(r) TYPE i.", "IMPORTING n TYPE i RETURNING VALUE(r) TYPE string."],
  "a structure field type": ["app/zif_digest.intf.abap", "b TYPE string", "b TYPE i"],
  "a method signature": ["app/zcl_digest_impl.clas.abap", "METHODS use IMPORTING x TYPE i EXPORTING y TYPE i.", "METHODS use IMPORTING x TYPE string EXPORTING y TYPE i."],
};

test("the digest changes exactly when the emitted text changes", () => {
  const root = mkdtempSync(join(tmpdir(), "osgo-digest-"));
  try {
    for (const [file, text] of Object.entries(base)) { mkdirSync(join(root, file, ".."), {recursive: true}); writeFileSync(join(root, file), text); }
    const folders = [join(root, "app")];
    const names = ["zif_digest", "zcl_digest_impl", "zcl_digest_caller"];
    const build = () => {
      const program = compileProgram({folders, objects: names, tolerant: true});
      return {text: emitGo(program), digest: programDigest(program, {componentInterfaces})};
    };
    const before = build();
    for (const [name, [file, from, to]] of Object.entries(edits)) {
      writeFileSync(join(root, file), readFileSync(join(root, file), "utf8").replace(from, to));
      const after = build();
      assert.notEqual(after.text, before.text, `${name}: the emitted text must change`);
      assert.notEqual(after.digest, before.digest, `${name}: the digest must change`);
      writeFileSync(join(root, file), readFileSync(join(root, file), "utf8").replace(to, from));
      assert.equal(build().digest, before.digest, `${name}: put back, the digest is the same again`);
    }
  } finally { rmSync(root, {recursive: true, force: true}); }
});

test("the digest does not depend on the objects of the IR (a rebuilt program names the same generation)", () => {
  const root = mkdtempSync(join(tmpdir(), "osgo-digest-"));
  try {
    for (const [file, text] of Object.entries(base)) { mkdirSync(join(root, file, ".."), {recursive: true}); writeFileSync(join(root, file), text); }
    const folders = [join(root, "app")];
    const names = ["zif_digest", "zcl_digest_impl", "zcl_digest_caller"];
    const one = programDigest(compileProgram({folders, objects: names, tolerant: true}), {componentInterfaces});
    const two = programDigest(compileProgram({folders, objects: names, tolerant: true}), {componentInterfaces});
    assert.equal(one, two);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
