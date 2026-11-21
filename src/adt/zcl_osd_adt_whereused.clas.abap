"! Where-used, POST repository/informationsystem/usageReferences?uri=...:
"! the objects whose source names the object the URI points at, read out of
"! WBCROSSGT / WBCROSSGTX (OTYPE TY, every type reference the cross-
"! reference seed derives from the tree, tools/osd-xref-seed.mjs) on the
"! serving database, like the A9 xref readers. INCLUDE there is the
"! referencing object's own name (tools/osd-xref.mjs: not ZCL_X=======CM001),
"! so each hit is resolved to its type through STORE SEARCH and to its
"! package through STORE OBJECT, and answered as one referencedObject with
"! its adtObject and packageRef, the shape abap-adt-api usageReferences and
"! vsp read. Object level only: a position in the URI (#start=l,c) is
"! accepted and ignored, the answer names the objects that use the object,
"! not the lines; usageSnippets is not served. The request body
"! (affectedObjects) is not read: every hit is a result.
CLASS zcl_osd_adt_whereused DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_hit,
             name     TYPE string,
             type     TYPE string,
             adt_type TYPE string,
             uri      TYPE string,
             package  TYPE string,
           END OF ty_hit.
    TYPES tt_hit TYPE STANDARD TABLE OF ty_hit WITH DEFAULT KEY.
    CONSTANTS c_type TYPE string VALUE `application/vnd.sap.adt.repository.usagereferences.result.v1+xml; charset=utf-8`.
    CONSTANTS c_limit TYPE i VALUE 200.
    "! the names that reference iv_name, the object itself left out, sorted
    CLASS-METHODS readers IMPORTING iv_name TYPE string RETURNING VALUE(rt_names) TYPE string_table.
    CLASS-METHODS document IMPORTING it_hits TYPE tt_hit RETURNING VALUE(rv_body) TYPE string.
    "! the store's type of a name (SEARCH, exact match); initial when unknown
    CLASS-METHODS type_of IMPORTING iv_name TYPE string RETURNING VALUE(rv_type) TYPE string RAISING zcx_osd_adt.
ENDCLASS.
CLASS zcl_osd_adt_whereused IMPLEMENTATION.
  METHOD readers.
    DATA lt_rows TYPE STANDARD TABLE OF wbcrossgt-include WITH DEFAULT KEY.
    DATA lt_extra LIKE lt_rows.
    DATA lv_row LIKE LINE OF lt_rows.
    DATA lv_name TYPE wbcrossgt-name.
    DATA lv_text TYPE string.
    DATA lv_last TYPE string.
    lv_name = to_upper( iv_name ).
*   the forms gogen compiles (tools/gogen/frontend.mjs): no DISTINCT, no
*   DELETE ADJACENT DUPLICATES on an elementary table; both tables sorted
*   together, the duplicates are adjacent and the loop drops them
    SELECT include FROM wbcrossgt INTO TABLE lt_rows UP TO 5000 ROWS
      WHERE otype = 'TY' AND name = lv_name ORDER BY include.
    SELECT include FROM wbcrossgtx INTO TABLE lt_extra UP TO 5000 ROWS
      WHERE otype = 'TY' AND name = lv_name ORDER BY include.
    APPEND LINES OF lt_extra TO lt_rows.
    SORT lt_rows.
    LOOP AT lt_rows INTO lv_row.
      lv_text = lv_row.
      lv_text = to_upper( zcl_osd_adt_js=>trim( lv_text ) ).
      IF lv_text IS INITIAL OR lv_text = to_upper( iv_name ) OR lv_text = lv_last.
        CONTINUE.
      ENDIF.
      lv_last = lv_text.
      APPEND lv_text TO rt_names.
    ENDLOOP.
  ENDMETHOD.
  METHOD type_of.
    DATA lo_input TYPE REF TO zcl_osd_adt_json.
    DATA ls_answer TYPE zcl_osd_adt_host=>ty_answer.
    DATA lt_lines TYPE string_table.
    DATA lv_line TYPE string.
    DATA lv_type TYPE string.
    DATA lv_name TYPE string.
    DATA lv_library TYPE string.
    zcl_osd_adt_host=>require( `SEARCH` ).
    CREATE OBJECT lo_input.
    lo_input->add( iv_name = `format` iv_value = `lines` ).
    lo_input->add( iv_name = `seed` iv_value = iv_name ).
    lo_input->add( iv_name = `type` iv_value = `` ).
    lo_input->add_raw( iv_name = `limit` iv_json = `null` ).
    ls_answer = zcl_osd_adt_host=>store( iv_command = `SEARCH` iv_json = lo_input->document( ) ).
    SPLIT ls_answer-source AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
    LOOP AT lt_lines INTO lv_line WHERE table_line IS NOT INITIAL.
      SPLIT lv_line AT cl_abap_char_utilities=>horizontal_tab INTO lv_type lv_name lv_library.
      IF to_upper( lv_name ) = to_upper( iv_name ).
        rv_type = lv_type.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.
  METHOD document.
    DATA ls_hit TYPE ty_hit.
    DATA lv_rows TYPE string.
    LOOP AT it_hits INTO ls_hit.
      lv_rows = lv_rows
        && |    <usageReferences:referencedObject uri="{ zcl_osd_adt_xml=>esc( ls_hit-uri ) }" parentUri="" isResult="true" canHaveChildren="false" usageInformation="">\n|
        && |      <usageReferences:adtObject adtcore:uri="{ zcl_osd_adt_xml=>esc( ls_hit-uri ) }" adtcore:type="{ zcl_osd_adt_xml=>esc( ls_hit-adt_type ) }" adtcore:name="{ zcl_osd_adt_xml=>esc( ls_hit-name ) }" adtcore:responsible="" adtcore:description="">\n|
        && |        <adtcore:packageRef adtcore:name="{ zcl_osd_adt_xml=>esc( ls_hit-package ) }" adtcore:type="DEVC/K" adtcore:uri="/sap/bc/adt/packages/{ zcl_osd_adt_uri=>encode_component( to_lower( ls_hit-package ) ) }"/>\n|
        && |      </usageReferences:adtObject>\n|
        && |      <objectIdentifier>{ zcl_osd_adt_xml=>esc( ls_hit-adt_type ) };{ zcl_osd_adt_xml=>esc( ls_hit-name ) }</objectIdentifier>\n|
        && |    </usageReferences:referencedObject>\n|.
    ENDLOOP.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences" xmlns:adtcore="http://www.sap.com/adt/core">\n|
      && |  <usageReferences:referencedObjects>\n|
      && lv_rows
      && |  </usageReferences:referencedObjects>\n|
      && |  <usageReferences:affectedObjects/>\n|
      && |</usageReferences:usageReferenceResult>\n|.
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    DATA lv_uri TYPE string.
    DATA lv_found TYPE abap_bool.
    DATA ls_object TYPE zcl_osd_adt_types=>ty_object.
    DATA ls_known TYPE zcl_osd_adt_host=>ty_object.
    DATA lt_names TYPE string_table.
    DATA lv_name TYPE string.
    DATA lt_types TYPE zcl_osd_adt_types=>tt_type.
    DATA ls_type TYPE zcl_osd_adt_types=>ty_type.
    DATA ls_hit TYPE ty_hit.
    DATA lt_hits TYPE tt_hit.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `uri` IMPORTING ev_value = lv_uri ev_found = lv_found ).
    IF lv_found = abap_false OR lv_uri IS INITIAL.
      lx_error = zcx_osd_adt=>invalid_request( `usageReferences needs the uri of an object` ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    ls_object = zcl_osd_adt_types=>object_from_uri( lv_uri ).
    IF ls_object-found = abap_false OR ls_object-ok = abap_false.
      lx_error = zcx_osd_adt=>invalid_request( |{ lv_uri } names no repository object| ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    zcl_osd_adt_host=>require( `OBJECT` ).
    ls_known = zcl_osd_adt_host=>object( iv_type = ls_object-type iv_name = ls_object-name ).
    IF ls_known-found = abap_false.
      lx_error = zcx_osd_adt=>not_found( iv_message = |{ ls_object-type } { ls_object-name } does not exist|
        iv_miss = zcx_osd_adt=>c_miss_object ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    lt_types = zcl_osd_adt_types=>all( ).
    lt_names = readers( ls_known-name ).
    LOOP AT lt_names INTO lv_name.
      IF sy-tabix > c_limit.
        EXIT.
      ENDIF.
      CLEAR ls_hit.
      ls_hit-name = lv_name.
      ls_hit-type = type_of( lv_name ).
      IF ls_hit-type IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE lt_types INTO ls_type WITH KEY type = ls_hit-type.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ls_hit-adt_type = ls_type-adt_type.
      ls_hit-uri = `/sap/bc/adt/` && ls_type-collection && `/` && zcl_osd_adt_uri=>encode_component( to_lower( lv_name ) ).
      ls_known = zcl_osd_adt_host=>object( iv_type = ls_hit-type iv_name = lv_name ).
      ls_hit-package = ls_known-package.
      APPEND ls_hit TO lt_hits.
    ENDLOOP.
    rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = document( lt_hits ) iv_type = c_type ).
  ENDMETHOD.
ENDCLASS.
