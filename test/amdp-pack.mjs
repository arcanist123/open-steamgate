import {expect} from "chai";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {contentFoldersOf} from "../tools/osd-packs.mjs";
import {generate, portabilityWarnings} from "../tools/amdp-gen.mjs";
import {ObjectStore} from "../tools/osd-store.mjs";

describe("AMDP in a content pack", () => {
  it("generates one procedure from the winning class body", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-layer-"));
    try {
      const system = join(root, "system");
      const user = join(root, "user");
      mkdirSync(system);
      mkdirSync(user);
      const source = (value) => `
CLASS zcl_layer_amdp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    CLASS-METHODS answer IMPORTING VALUE(iv_n) TYPE i EXPORTING VALUE(ev_n) TYPE i.
ENDCLASS.
CLASS zcl_layer_amdp IMPLEMENTATION.
  METHOD answer BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
    ev_n = :iv_n + ${value};
  ENDMETHOD.
ENDCLASS.\n`;
      writeFileSync(join(system, "zcl_layer_amdp.clas.abap"), source(1));
      writeFileSync(join(user, "zcl_layer_amdp.clas.abap"), source(2));
      const made = generate([system, user], join(root, "gen"));
      expect(made.classes).to.deep.equal(["zcl_layer_amdp.clas.abap"]);
      expect(made.procedures).to.have.length(1);
      expect(made.procedures[0].body).to.contain("ev_n = :iv_n + 2");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("discovers and rewrites a pack-local AMDP class", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-pack-"));
    const src = join(root, "src");
    const pack = join(root, "packs", "vectors");
    const packSrc = join(pack, "src");
    const out = join(root, "gen", "amdp");
    mkdirSync(src, {recursive: true});
    mkdirSync(packSrc, {recursive: true});
    writeFileSync(join(pack, "osd-pack.json"), JSON.stringify({name: "vectors"}));
    writeFileSync(join(packSrc, "zcl_vector_amdp.clas.abap"), `
CLASS zcl_vector_amdp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    CLASS-METHODS answer IMPORTING VALUE(iv_n) TYPE i EXPORTING VALUE(ev_n) TYPE i.
ENDCLASS.
CLASS zcl_vector_amdp IMPLEMENTATION.
  METHOD answer BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
    ev_n = :iv_n;
  ENDMETHOD.
ENDCLASS.\n`);

    const folders = contentFoldersOf(root);
    expect(folders).to.deep.equal(["src", "packs/vectors/src"]);
    const made = generate(folders.map((folder) => join(root, folder)), out);
    expect(made.procedures).to.have.length(1);
    expect(readFileSync(join(out, "zcl_vector_amdp.clas.abap"), "utf8"))
      .to.contain("DESTINATION 'AMDP'").and.not.contain("ev_n = :iv_n");
  });
});

describe("amdp-gen reads a table function's DDLS through the runtime store by the entity it defines", () => {
  it("warns when a scalar assignment cannot be lowered for SQLite", () => {
    const source = `CLASS zcl_scalar_check DEFINITION PUBLIC CREATE PUBLIC.
 PUBLIC SECTION.
 INTERFACES if_amdp_marker_hdb.
 CLASS-METHODS run EXPORTING VALUE(ev_result) TYPE i.
ENDCLASS.
CLASS zcl_scalar_check IMPLEMENTATION.
 METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
 ev_result = CAST('x' AS INTEGER);
 ENDMETHOD.
ENDCLASS.`;
    const store = new ObjectStore({root: process.cwd(), roots: [], libs: []});
    const warnings = portabilityWarnings(source, "zcl_scalar_check.clas.abap", store, "sqlite");
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include({severity: "W", line: 8});
    expect(warnings[0].message).to.contain("CAST to INTEGER cannot raise");
  });

  it("points a dialect refusal after an earlier statement to its own line", () => {
    const source = `CLASS zcl_line_check DEFINITION PUBLIC CREATE PUBLIC.
 PUBLIC SECTION.
 INTERFACES if_amdp_marker_hdb.
 CLASS-METHODS run EXPORTING VALUE(ev_result) TYPE i.
ENDCLASS.
CLASS zcl_line_check IMPLEMENTATION.
 METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
 ev_result = 1;
 ev_result = CAST('x' AS INTEGER);
 ENDMETHOD.
ENDCLASS.`;
    const store = new ObjectStore({root: process.cwd(), roots: [], libs: []});
    const warnings = portabilityWarnings(source, "zcl_line_check.clas.abap", store, "sqlite");
    expect(warnings).to.have.length(1);
    expect(warnings[0]).to.include({severity: "W", line: 9});
    expect(warnings[0].message).to.contain("CAST to INTEGER cannot raise");
  });

  it("checks dialect refusals inside write statements", () => {
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-write-check-"));
    try {
      const src = join(root, "src");
      mkdirSync(src, {recursive: true});
      writeFileSync(join(src, "zstg_write.tabl.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V><TABNAME>ZSTG_WRITE</TABNAME><DDLANGUAGE>E</DDLANGUAGE><TABCLASS>TRANSP</TABCLASS></DD02V>
   <DD03P_TABLE>
    <DD03P><FIELDNAME>K</FIELDNAME><KEYFLAG>X</KEYFLAG><ADMINFIELD>0</ADMINFIELD><INTTYPE>X</INTTYPE><INTLEN>000004</INTLEN><NOTNULL>X</NOTNULL><DATATYPE>INT4</DATATYPE><LENG>000010</LENG></DD03P>
   </DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>`);
      const source = `CLASS zcl_write_check DEFINITION PUBLIC CREATE PUBLIC.
 PUBLIC SECTION.
 INTERFACES if_amdp_marker_hdb.
 CLASS-METHODS run EXPORTING VALUE(ev_result) TYPE i.
ENDCLASS.
CLASS zcl_write_check IMPLEMENTATION.
 METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT USING zstg_write.
 INSERT INTO zstg_write (k) VALUES (CAST('x' AS INTEGER));
 ev_result = 1;
 ENDMETHOD.
ENDCLASS.`;
      const store = new ObjectStore({root, roots: [{path: "src", package: "$WRITE", writable: false}], libs: []});
      const warnings = portabilityWarnings(source, "zcl_write_check.clas.abap", store, "sqlite");
      expect(warnings).to.have.length(1);
      expect(warnings[0]).to.include({severity: "W", line: 8});
      expect(warnings[0].message).to.contain("CAST to INTEGER cannot raise");
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("checks IF conditions with the same SQLite portability rules", () => {
    const source = `CLASS zcl_condition_check DEFINITION PUBLIC CREATE PUBLIC.
 PUBLIC SECTION.
 INTERFACES if_amdp_marker_hdb.
 CLASS-METHODS run EXPORTING VALUE(ev_result) TYPE i.
ENDCLASS.
CLASS zcl_condition_check IMPLEMENTATION.
 METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
 IF CAST('x' AS INTEGER) = 1 THEN
   ev_result = 1;
 END IF;
 ENDMETHOD.
ENDCLASS.`;
    const store = new ObjectStore({root: process.cwd(), roots: [], libs: []});
    const warnings = portabilityWarnings(source, "zcl_condition_check.clas.abap", store, "sqlite");
    expect(warnings).to.have.length(1);
    expect(warnings[0].message).to.contain("CAST to INTEGER cannot raise");
  });

  it("records the DuckDB refusal of a compiled body, so the status page cannot call it portable-duckdb", () => {
    // FLOOR compiles into the IR but has no measured DuckDB rendering: the
    // build keeps the IR (the call path is unchanged, and refuses at call
    // time) and writes down the refusal the call will raise
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-duckdb-refusal-"));
    try {
      const src = join(root, "src");
      mkdirSync(src);
      const body = (expr) => `
CLASS zcl_floor_amdp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    CLASS-METHODS run IMPORTING VALUE(iv) TYPE i EXPORTING VALUE(ev) TYPE i.
ENDCLASS.
CLASS zcl_floor_amdp IMPLEMENTATION.
  METHOD run BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
    ev = ${expr};
  ENDMETHOD.
ENDCLASS.\n`;
      writeFileSync(join(src, "zcl_floor_amdp.clas.abap"), body("FLOOR(:iv / 2.0)"));
      let made = generate([src], join(root, "gen"));
      expect(made.procedures[0].portable, "the IR is still compiled").to.not.equal(undefined);
      expect(made.procedures[0].portableDuckdbRefusal?.message).to.match(/FLOOR/);
      writeFileSync(join(src, "zcl_floor_amdp.clas.abap"), body(":iv + 1"));
      made = generate([src], join(root, "gen"));
      expect(made.procedures[0].portableDuckdbRefusal).to.equal(undefined);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("a DDL source whose object name is not the entity still gives the method its RETURNS", async () => {
    const {ObjectStore} = await import("../tools/osd-store.mjs");
    const {rmSync} = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-entity-"));
    try {
      const src = join(root, "src");
      mkdirSync(src, {recursive: true});
      // the object is ZSTG_DDL_SRC, the entity it defines is ZSTG_TF_ENTITY,
      // and the class names the entity, as FOR TABLE FUNCTION always does
      writeFileSync(join(src, "zstg_ddl_src.ddls.asddls"), `@EndUserText.label: 'x'
define table function Zstg_Tf_Entity
with parameters p_value : abap.int4
returns { k : abap.int4; }
implemented by method zcl_stg_tf_entity=>get;\n`);
      writeFileSync(join(src, "zcl_stg_tf_entity.clas.abap"), `
CLASS zcl_stg_tf_entity DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    CLASS-METHODS get FOR TABLE FUNCTION zstg_tf_entity.
ENDCLASS.
CLASS zcl_stg_tf_entity IMPLEMENTATION.
  METHOD get BY DATABASE FUNCTION FOR HDB LANGUAGE SQLSCRIPT OPTIONS READ-ONLY.
    RETURN SELECT :p_value AS k FROM dummy;
  ENDMETHOD.
ENDCLASS.\n`);
      const store = new ObjectStore({root, roots: [{path: "src", package: "$ENTITY", writable: false}], libs: []});
      expect(store.read("DDLS", "ZSTG_TF_ENTITY").source).to.contain("Zstg_Tf_Entity");
      const made = generate([src], join(root, "gen", "amdp"), {store});
      expect(made.procedures).to.have.length(1);
      expect(made.procedures[0].portableRefusal, JSON.stringify(made.procedures[0].portableRefusal)).to.equal(undefined);
      expect(made.procedures[0].portable.outputSchema).to.deep.equal({K: {abap: "I"}});
      expect(portabilityWarnings(readFileSync(join(src, "zcl_stg_tf_entity.clas.abap"), "utf8"),
        "zcl_stg_tf_entity.clas.abap", store, "sqlite")).to.deep.equal([]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  it("hands the compiler the table's primary key from the DDIC, so an UPSERT compiles", async () => {
    const {ObjectStore} = await import("../tools/osd-store.mjs");
    const {rmSync} = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "osd-amdp-upsert-"));
    try {
      const src = join(root, "src");
      mkdirSync(src, {recursive: true});
      writeFileSync(join(src, "zstg_ups.tabl.xml"), `<?xml version="1.0" encoding="utf-8"?>
<abapGit version="v1.0.0" serializer="LCL_OBJECT_TABL" serializer_version="v1.0.0">
 <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">
  <asx:values>
   <DD02V><TABNAME>ZSTG_UPS</TABNAME><DDLANGUAGE>E</DDLANGUAGE><TABCLASS>TRANSP</TABCLASS><DDTEXT>x</DDTEXT></DD02V>
   <DD03P_TABLE>
    <DD03P><FIELDNAME>K</FIELDNAME><KEYFLAG>X</KEYFLAG><ADMINFIELD>0</ADMINFIELD><INTTYPE>X</INTTYPE><INTLEN>000004</INTLEN><NOTNULL>X</NOTNULL><DATATYPE>INT4</DATATYPE><LENG>000010</LENG></DD03P>
    <DD03P><FIELDNAME>V</FIELDNAME><ADMINFIELD>0</ADMINFIELD><INTTYPE>C</INTTYPE><INTLEN>000020</INTLEN><DATATYPE>CHAR</DATATYPE><LENG>000010</LENG></DD03P>
   </DD03P_TABLE>
  </asx:values>
 </asx:abap>
</abapGit>
`);
      writeFileSync(join(src, "zcl_stg_ups.clas.abap"), `
CLASS zcl_stg_ups DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_amdp_marker_hdb.
    CLASS-METHODS put EXPORTING VALUE(ev) TYPE string.
ENDCLASS.
CLASS zcl_stg_ups IMPLEMENTATION.
  METHOD put BY DATABASE PROCEDURE FOR HDB LANGUAGE SQLSCRIPT USING zstg_ups.
    UPSERT zstg_ups VALUES (1, 'a') WITH PRIMARY KEY;
    ev = 'x';
  ENDMETHOD.
ENDCLASS.\n`);
      const store = new ObjectStore({root, roots: [{path: "src", package: "$UPSERT", writable: false}], libs: []});
      const made = generate([src], join(root, "gen", "amdp"), {store});
      expect(made.procedures).to.have.length(1);
      expect(made.procedures[0].portableRefusal, JSON.stringify(made.procedures[0].portableRefusal)).to.equal(undefined);
      const write = made.procedures[0].portable.body.find((one) => one.stmt === "write").write;
      expect([write.write, write.key]).to.deep.equal(["upsert", ["K"]]);
    } finally {
      rmSync(root, {recursive: true, force: true});
    }
  });

  describe("the store's entity look-up stays a read, and follows writes", () => {
    let root, store, ObjectStore;
    const ddls = (entity) => `define table function ${entity} returns { k : abap.int4; } implemented by method cl_x=>m;\n`;
    beforeEach(async () => {
      ({ObjectStore} = await import("../tools/osd-store.mjs"));
      root = mkdtempSync(join(tmpdir(), "osd-store-entity-"));
      mkdirSync(join(root, "src"), {recursive: true});
      writeFileSync(join(root, "src", "z_src.ddls.asddls"), ddls("Z_OLD"));
      store = new ObjectStore({root, roots: [{path: "src", package: "$ENTITY", writable: true}], libs: []});
    });
    afterEach(async () => {
      const {rmSync} = await import("node:fs");
      rmSync(root, {recursive: true, force: true});
    });

    it("follows a rewrite of the source to its new entity", () => {
      expect(store.read("DDLS", "Z_OLD").source).to.contain("Z_OLD");
      store.write("DDLS", "Z_SRC", ddls("Z_NEW"));
      expect(store.read("DDLS", "Z_NEW").source).to.contain("Z_NEW");
      expect(() => store.read("DDLS", "Z_OLD")).to.throw(/does not exist/);
    });

    it("forgets the entity of a deleted source", () => {
      expect(store.read("DDLS", "Z_OLD").source).to.contain("Z_OLD");
      store.delete("DDLS", "Z_SRC");
      expect(() => store.read("DDLS", "Z_OLD")).to.throw(/does not exist/);
    });

    it("never resolves a write target by entity: a write to the entity name is a new object", () => {
      store.write("DDLS", "Z_OLD", ddls("Z_OTHER"));
      expect(readFileSync(join(root, "src", "z_src.ddls.asddls"), "utf8")).to.contain("Z_OLD");
      expect(store.read("DDLS", "Z_SRC").source).to.contain("Z_OLD");
    });

    it("takes neither of two sources defining one entity", () => {
      writeFileSync(join(root, "src", "z_two.ddls.asddls"), ddls("Z_OLD"));
      const fresh = new ObjectStore({root, roots: [{path: "src", package: "$ENTITY", writable: true}], libs: []});
      expect(() => fresh.read("DDLS", "Z_OLD")).to.throw(/does not exist/);
      expect(fresh.read("DDLS", "Z_TWO").source).to.contain("Z_OLD");
    });
  });
});
