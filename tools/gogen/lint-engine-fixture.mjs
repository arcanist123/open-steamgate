// A small registry double for executing the REAL facade/index through OSGo.
// It models file/object identity and dirty parsing, not abaplint diagnostics.
import {writeFileSync} from "node:fs";
import {join} from "node:path";

export function writeLintRegistryDouble(dir) {
  const xml = body => `<abapGit version="v1.0.0"><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>${body}</asx:values></asx:abap></abapGit>`;
  for (const [name, fields] of [["SUBMATCH_RESULT", ["OFFSET", "LENGTH"]], ["MATCH_RESULT", ["LINE", "OFFSET", "LENGTH"]]]) {
    const components = fields.map((field, i) => `<DD03P><FIELDNAME>${field}</FIELDNAME><POSITION>${i+1}</POSITION><DATATYPE>INT4</DATATYPE><INTTYPE>I</INTTYPE><INTLEN>4</INTLEN><LENG>10</LENG></DD03P>`).join("")
      + (name === "MATCH_RESULT" ? "<DD03P><FIELDNAME>SUBMATCHES</FIELDNAME><POSITION>4</POSITION><ROLLNAME>SUBMATCH_RESULT_TAB</ROLLNAME><DATATYPE>TTYP</DATATYPE><COMPTYPE>L</COMPTYPE></DD03P>" : "");
    writeFileSync(join(dir, name.toLowerCase() + ".tabl.xml"), xml(`<DD02V><TABNAME>${name}</TABNAME><TABCLASS>INTTAB</TABCLASS></DD02V><DD03P_TABLE>${components}</DD03P_TABLE>`));
    writeFileSync(join(dir, name.toLowerCase() + "_tab.ttyp.xml"), xml(`<DD40V><TYPENAME>${name}_TAB</TYPENAME><ROWTYPE>${name}</ROWTYPE><ROWKIND>S</ROWKIND><DATATYPE>STRU</DATATYPE><ACCESSMODE>T</ACCESSMODE><KEYDEF>D</KEYDEF><KEYKIND>N</KEYKIND></DD40V>`));
  }
  const files = {
    "cx_root.clas": `CLASS cx_root DEFINITION PUBLIC.
 PUBLIC SECTION.
 DATA previous TYPE REF TO cx_root.
 METHODS constructor.
 METHODS get_text RETURNING VALUE(result) TYPE string.
ENDCLASS.
CLASS cx_root IMPLEMENTATION.
 METHOD constructor. ENDMETHOD.
 METHOD get_text. ENDMETHOD.
ENDCLASS.`,
    "cx_no_check.clas": `CLASS cx_no_check DEFINITION PUBLIC INHERITING FROM cx_root.
ENDCLASS.
CLASS cx_no_check IMPLEMENTATION. ENDCLASS.`,
    "zif_lnt_file.intf": `INTERFACE zif_lnt_file PUBLIC.
 METHODS get_raw RETURNING VALUE(result) TYPE string.
 METHODS get_filename RETURNING VALUE(result) TYPE string.
 METHODS get_object_name RETURNING VALUE(result) TYPE string.
ENDINTERFACE.`,
    "zif_lnt_object.intf": `INTERFACE zif_lnt_object PUBLIC.
 METHODS get_name RETURNING VALUE(result) TYPE string.
 METHODS get_files RETURNING VALUE(result) TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
 METHODS set_dirty.
 METHODS is_dirty RETURNING VALUE(result) TYPE abap_bool.
ENDINTERFACE.`,
    "zif_lnt_generator_8f73cd1c.intf": `INTERFACE zif_lnt_generator_8f73cd1c PUBLIC.
 METHODS next RETURNING VALUE(result) TYPE REF TO zcl_lnt_generator_17955b8b.
ENDINTERFACE.`,
    "zlnt_runtime_arra_c22708faf2e3.clas": `CLASS zlnt_runtime_arra_c22708faf2e3 DEFINITION PUBLIC.
 PUBLIC SECTION.
 DATA items TYPE STANDARD TABLE OF REF TO object WITH DEFAULT KEY.
 METHODS dense.
ENDCLASS.
CLASS zlnt_runtime_arra_c22708faf2e3 IMPLEMENTATION.
 METHOD dense. ENDMETHOD.
ENDCLASS.`,
    "zcl_lnt_memory_file.clas": `CLASS zcl_lnt_memory_file DEFINITION PUBLIC.
 PUBLIC SECTION.
 INTERFACES zif_lnt_file.
 METHODS constructor IMPORTING i_filename TYPE string i_raw TYPE string.
 PRIVATE SECTION.
 DATA filename TYPE string.
 DATA raw TYPE string.
ENDCLASS.
CLASS zcl_lnt_memory_file IMPLEMENTATION.
 METHOD constructor. filename = i_filename. raw = i_raw. ENDMETHOD.
 METHOD zif_lnt_file~get_raw. result = raw. ENDMETHOD.
 METHOD zif_lnt_file~get_filename. result = filename. ENDMETHOD.
 METHOD zif_lnt_file~get_object_name.
 DATA parts TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
 DATA name TYPE string.
 DATA suffix TYPE string.
 SPLIT filename AT '/' INTO TABLE parts.
 READ TABLE parts INTO name INDEX lines( parts ).
 SPLIT name AT '.' INTO result suffix.
 result = to_upper( result ).
 ENDMETHOD.
ENDCLASS.`,
    "zcl_test_lint_object.clas": `CLASS zcl_test_lint_object DEFINITION PUBLIC.
 PUBLIC SECTION.
 INTERFACES zif_lnt_object.
 DATA name TYPE string.
 DATA files TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
 DATA dirty TYPE abap_bool VALUE abap_true.
 METHODS constructor IMPORTING i_name TYPE string.
ENDCLASS.
CLASS zcl_test_lint_object IMPLEMENTATION.
 METHOD constructor. name = i_name. CREATE OBJECT files. ENDMETHOD.
 METHOD zif_lnt_object~get_name. result = name. ENDMETHOD.
 METHOD zif_lnt_object~get_files. result = files. ENDMETHOD.
 METHOD zif_lnt_object~set_dirty. dirty = abap_true. ENDMETHOD.
 METHOD zif_lnt_object~is_dirty. result = dirty. ENDMETHOD.
ENDCLASS.`,
    "zcl_lnt_generator_17955b8b.clas": `CLASS zcl_lnt_generator_17955b8b DEFINITION PUBLIC.
 PUBLIC SECTION.
 DATA done TYPE abap_bool.
 DATA value TYPE REF TO zif_lnt_object.
ENDCLASS.
CLASS zcl_lnt_generator_17955b8b IMPLEMENTATION. ENDCLASS.`,
    "zcl_test_lint_generator.clas": `CLASS zcl_test_lint_generator DEFINITION PUBLIC.
 PUBLIC SECTION.
 INTERFACES zif_lnt_generator_8f73cd1c.
 DATA objects TYPE STANDARD TABLE OF REF TO zcl_test_lint_object WITH DEFAULT KEY.
 DATA idx TYPE i.
ENDCLASS.
CLASS zcl_test_lint_generator IMPLEMENTATION.
 METHOD zif_lnt_generator_8f73cd1c~next.
 DATA obj TYPE REF TO zcl_test_lint_object.
 CREATE OBJECT result.
 idx = idx + 1.
 READ TABLE objects INTO obj INDEX idx.
 IF sy-subrc = 0. result->value = obj. ELSE. result->done = abap_true. ENDIF.
 ENDMETHOD.
ENDCLASS.`,
    "zcl_lnt_registry.clas": `CLASS zcl_lnt_registry DEFINITION PUBLIC.
 PUBLIC SECTION.
 DATA objects TYPE STANDARD TABLE OF REF TO zcl_test_lint_object WITH DEFAULT KEY.
 METHODS get_file_by_name IMPORTING i_filename TYPE string RETURNING VALUE(result) TYPE REF TO zif_lnt_file.
 METHODS find_object_for_file IMPORTING i_file TYPE REF TO zif_lnt_file RETURNING VALUE(result) TYPE REF TO zif_lnt_object.
 METHODS object_for_name IMPORTING name TYPE string RETURNING VALUE(result) TYPE REF TO zcl_test_lint_object.
 METHODS get_objects RETURNING VALUE(result) TYPE REF TO zif_lnt_generator_8f73cd1c.
 METHODS add_file IMPORTING i_file TYPE REF TO zif_lnt_file.
 METHODS update_file IMPORTING i_file TYPE REF TO zif_lnt_file.
 METHODS remove_file IMPORTING i_file TYPE REF TO zif_lnt_file.
 METHODS parse.
 METHODS find_issues_object IMPORTING i_iobj TYPE REF TO zif_lnt_object
 RETURNING VALUE(result) TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
ENDCLASS.
CLASS zcl_lnt_registry IMPLEMENTATION.
 METHOD get_objects.
 DATA gen TYPE REF TO zcl_test_lint_generator.
 CREATE OBJECT gen. gen->objects = objects. result = gen.
 ENDMETHOD.
 METHOD get_file_by_name.
 DATA obj TYPE REF TO zcl_test_lint_object.
 DATA item TYPE REF TO object.
 DATA file TYPE REF TO zif_lnt_file.
 LOOP AT objects INTO obj.
 LOOP AT obj->files->items INTO item.
 file ?= item.
 IF file->get_filename( ) = i_filename. result = file. RETURN. ENDIF.
 ENDLOOP. ENDLOOP.
 ENDMETHOD.
 METHOD find_object_for_file.
 DATA obj TYPE REF TO zcl_test_lint_object.
 DATA item TYPE REF TO object.
 DATA file TYPE REF TO zif_lnt_file.
 LOOP AT objects INTO obj.
 LOOP AT obj->files->items INTO item.
 file ?= item.
 IF file->get_filename( ) = i_file->get_filename( ). result = obj. RETURN. ENDIF.
 ENDLOOP.
 ENDLOOP.
 ENDMETHOD.
 METHOD object_for_name.
 DATA obj TYPE REF TO zcl_test_lint_object.
 LOOP AT objects INTO obj.
 IF obj->name = name. result = obj. RETURN. ENDIF.
 ENDLOOP.
 ENDMETHOD.
 METHOD add_file.
 DATA obj TYPE REF TO zcl_test_lint_object.
 obj = object_for_name( i_file->get_object_name( ) ).
 IF obj IS NOT BOUND.
 CREATE OBJECT obj EXPORTING i_name = i_file->get_object_name( ). APPEND obj TO objects.
 ENDIF.
 APPEND i_file TO obj->files->items. obj->dirty = abap_true.
 ENDMETHOD.
 METHOD update_file.
 DATA obj TYPE REF TO zcl_test_lint_object.
 DATA item TYPE REF TO object.
 DATA file TYPE REF TO zif_lnt_file.
 DATA idx TYPE i.
 obj ?= find_object_for_file( i_file ).
 LOOP AT obj->files->items INTO item.
 idx = sy-tabix. file ?= item.
 IF file->get_filename( ) = i_file->get_filename( ).
 DELETE obj->files->items INDEX idx. item = i_file. INSERT item INTO obj->files->items INDEX idx. EXIT.
 ENDIF. ENDLOOP. obj->dirty = abap_true.
 ENDMETHOD.
 METHOD remove_file.
 DATA obj TYPE REF TO zcl_test_lint_object.
 DATA item TYPE REF TO object.
 DATA file TYPE REF TO zif_lnt_file.
 DATA idx TYPE i.
 DATA object_idx TYPE i.
 LOOP AT objects INTO obj.
 object_idx = sy-tabix.
 LOOP AT obj->files->items INTO item.
 idx = sy-tabix. file ?= item.
 IF file->get_filename( ) = i_file->get_filename( ).
 DELETE obj->files->items INDEX idx. obj->dirty = abap_true.
 IF obj->files->items IS INITIAL. DELETE objects INDEX object_idx. ENDIF.
 RETURN.
 ENDIF. ENDLOOP. ENDLOOP.
 ENDMETHOD.
 METHOD parse.
 DATA obj TYPE REF TO zcl_test_lint_object.
 LOOP AT objects INTO obj. obj->dirty = abap_false. ENDLOOP.
 ENDMETHOD.
 METHOD find_issues_object.
 parse( ). CREATE OBJECT result.
 ENDMETHOD.
ENDCLASS.`,
    "zcl_lnt_registry_run.clas": `CLASS zcl_lnt_registry_run DEFINITION PUBLIC.
 PUBLIC SECTION.
 METHODS constructor.
 METHODS add_file IMPORTING i_filename TYPE string i_raw TYPE string.
 METHODS add_dependency IMPORTING i_filename TYPE string i_raw TYPE string.
 METHODS parse IMPORTING i_config TYPE string RETURNING VALUE(result) TYPE REF TO zcl_lnt_registry.
 PRIVATE SECTION.
 DATA reg TYPE REF TO zcl_lnt_registry.
ENDCLASS.
CLASS zcl_lnt_registry_run IMPLEMENTATION.
 METHOD constructor. CREATE OBJECT reg. ENDMETHOD.
 METHOD add_file.
 DATA file TYPE REF TO zcl_lnt_memory_file.
 CREATE OBJECT file EXPORTING i_filename = i_filename i_raw = i_raw.
 reg->add_file( file ).
 ENDMETHOD.
 METHOD add_dependency. add_file( i_filename = i_filename i_raw = i_raw ). ENDMETHOD.
 METHOD parse. reg->parse( ). result = reg. ENDMETHOD.
ENDCLASS.`,
    "zlnt_runtime_opti_8df4f98f9a3a.clas": `CLASS zlnt_runtime_opti_8df4f98f9a3a DEFINITION PUBLIC.
 PUBLIC SECTION.
 DATA has TYPE abap_bool.
 DATA number_special TYPE i.
 DATA value TYPE i.
ENDCLASS.
CLASS zlnt_runtime_opti_8df4f98f9a3a IMPLEMENTATION. ENDCLASS.`,
    "zcl_lnt_position.clas": `CLASS zcl_lnt_position DEFINITION PUBLIC.
 PUBLIC SECTION.
 METHODS get_row RETURNING VALUE(result) TYPE i.
 METHODS get_col RETURNING VALUE(result) TYPE REF TO zlnt_runtime_opti_8df4f98f9a3a.
ENDCLASS.
CLASS zcl_lnt_position IMPLEMENTATION.
 METHOD get_row. result = 1. ENDMETHOD.
 METHOD get_col. CREATE OBJECT result. result->has = abap_true. result->value = 1. ENDMETHOD.
ENDCLASS.`,
    "zcl_lnt_issue.clas": `CLASS zcl_lnt_issue DEFINITION PUBLIC.
 PUBLIC SECTION.
 ${["key", "severity", "filename", "message"].map(n => `METHODS get_${n} RETURNING VALUE(result) TYPE string.`).join("\n")}
 METHODS get_start RETURNING VALUE(result) TYPE REF TO zcl_lnt_position.
 METHODS get_end RETURNING VALUE(result) TYPE REF TO zcl_lnt_position.
ENDCLASS.
CLASS zcl_lnt_issue IMPLEMENTATION.
 ${["key", "severity", "filename", "message"].map(n => `METHOD get_${n}. ENDMETHOD.`).join("\n")}
 METHOD get_start. CREATE OBJECT result. ENDMETHOD.
 METHOD get_end. CREATE OBJECT result. ENDMETHOD.
ENDCLASS.`,
  };
  for (const [name, raw] of Object.entries(files)) writeFileSync(join(dir, name + ".abap"), raw);
}
