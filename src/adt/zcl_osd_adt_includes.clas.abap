"! The main programs of an include, GET programs/includes/:name/mainprograms:
"! an adtcore:objectReferences list, read out of D010INC, the load graph the
"! cross-reference seed derives from every INCLUDE statement of the tree
"! (tools/osd-xref-seed.mjs; a system's D010INC says the same). The route
"! is registered only with the serving database, like the A9 xref readers.
"! A master SAPL<group> (or /NS/SAPL<rest>) is the function group it belongs to (FUGR/F), any
"! other master is a program (PROG/P); a master the store does not know is
"! named with its type guessed that way and no package, rather than left
"! out, because the include is in it whether or not the file is here.
CLASS zcl_osd_adt_includes DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    CONSTANTS c_type TYPE string VALUE `application/vnd.sap.adt.programs.includes.mainprograms+xml; charset=utf-8`.
    "! the masters of an include, as D010INC lists them, sorted
    CLASS-METHODS masters IMPORTING iv_include TYPE string RETURNING VALUE(rt_masters) TYPE string_table.
    "! the reference of a master: FUGR/F for SAPL<group> or /NS/SAPL<rest>, else PROG/P
    CLASS-METHODS reference IMPORTING iv_master TYPE string iv_package TYPE string
      RETURNING VALUE(rs_ref) TYPE zcl_osd_adt_doc_common=>ty_reference.
ENDCLASS.
CLASS zcl_osd_adt_includes IMPLEMENTATION.
  METHOD masters.
    DATA lt_rows TYPE STANDARD TABLE OF d010inc-master WITH DEFAULT KEY.
    DATA lv_row LIKE LINE OF lt_rows.
    DATA lv_include TYPE d010inc-include.
    DATA lv_text TYPE string.
    DATA lv_last TYPE string.
    lv_include = to_upper( iv_include ).
*   the forms gogen compiles (tools/gogen/frontend.mjs): no DISTINCT, no
*   DELETE ADJACENT DUPLICATES on an elementary table; sorted, so the
*   duplicates are adjacent and the loop drops them
*   capped at 500 masters, silently, as the where-used list is at 200
    SELECT master FROM d010inc INTO TABLE lt_rows UP TO 500 ROWS
      WHERE include = lv_include ORDER BY master.
    LOOP AT lt_rows INTO lv_row.
      lv_text = lv_row.
      lv_text = to_upper( zcl_osd_adt_js=>trim( lv_text ) ).
      IF lv_text IS INITIAL OR lv_text = lv_last.
        CONTINUE.
      ENDIF.
      lv_last = lv_text.
      APPEND lv_text TO rt_masters.
    ENDLOOP.
  ENDMETHOD.
  METHOD reference.
    DATA lv_group TYPE string.
    rs_ref-name = iv_master.
    rs_ref-has_uri = abap_true.
    lv_group = zcl_osd_adt_function=>group_of_main( iv_master ).
    IF lv_group IS NOT INITIAL.
      rs_ref-name = lv_group.
      rs_ref-type = `FUGR/F`.
      rs_ref-uri = zcl_osd_adt_function=>group_uri( lv_group ).
    ELSE.
      rs_ref-type = `PROG/P`.
      rs_ref-uri = `/sap/bc/adt/programs/programs/` && zcl_osd_adt_uri=>encode_component( to_lower( iv_master ) ).
    ENDIF.
    rs_ref-package_name = iv_package.
    rs_ref-has_package = boolc( iv_package IS NOT INITIAL ).
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    DATA ls_include TYPE zcl_osd_adt_host=>ty_object.
    DATA ls_master TYPE zcl_osd_adt_host=>ty_object.
    DATA lt_masters TYPE string_table.
    DATA lv_master TYPE string.
    DATA lv_type TYPE string.
    DATA lv_name TYPE string.
    DATA lt_refs TYPE zcl_osd_adt_doc_common=>tt_reference.
    DATA ls_ref TYPE zcl_osd_adt_doc_common=>ty_reference.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    READ TABLE is_request-params WITH KEY name = `name` INTO ls_param.
    zcl_osd_adt_host=>require( `OBJECT` ).
    ls_include = zcl_osd_adt_host=>object( iv_type = `INCL` iv_name = to_upper( ls_param-value ) ).
    IF ls_include-found = abap_false.
      lx_error = zcx_osd_adt=>not_found( iv_message = |INCL { to_upper( ls_param-value ) } does not exist|
        iv_miss = zcx_osd_adt=>c_miss_object ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    lt_masters = masters( ls_include-name ).
    LOOP AT lt_masters INTO lv_master.
      lv_type = `PROG`.
      lv_name = zcl_osd_adt_function=>group_of_main( lv_master ).
      IF lv_name IS INITIAL.
        lv_name = lv_master.
      ELSE.
        lv_type = `FUGR`.
      ENDIF.
      ls_master = zcl_osd_adt_host=>object( iv_type = lv_type iv_name = lv_name ).
      ls_ref = reference( iv_master = lv_master iv_package = ls_master-package ).
      APPEND ls_ref TO lt_refs.
    ENDLOOP.
    rs_response = zcl_osd_adt_entity=>send( is_request = is_request
      iv_body = zcl_osd_adt_doc_common=>object_references( lt_refs ) iv_type = c_type ).
  ENDMETHOD.
ENDCLASS.
