CLASS ltcl_discovery DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS ordered_collections FOR TESTING.
    METHODS workspace_order FOR TESTING.
    METHODS document_quirks FOR TESTING.
    METHODS core_one_collection_each FOR TESTING.
    METHODS head_and_get FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_discovery IMPLEMENTATION.
  METHOD ordered_collections.
    DATA lt_rows TYPE zcl_osd_adt_discovery=>tt_collection.
    DATA ls_row TYPE zcl_osd_adt_discovery=>ty_collection.
    lt_rows = zcl_osd_adt_discovery=>collections( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rows ) exp = 28 ).
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-adt exp = `repository/informationsystem/virtualfolders` ).
    READ TABLE lt_rows INDEX 28 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-adt exp = `datapreview/freestyle` ).
    LOOP AT lt_rows INTO ls_row.
      cl_abap_unit_assert=>assert_not_initial( ls_row-term ).
      cl_abap_unit_assert=>assert_not_initial( ls_row-scheme ).
      IF ls_row-adt = `checkruns/reporters` OR ls_row-adt = `activation/inactiveobjects`.
        cl_abap_unit_assert=>assert_equals( act = ls_row-title exp = ls_row-adt ).
        cl_abap_unit_assert=>assert_equals( act = ls_row-workspace exp = `Source Library` ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD workspace_order.
    DATA lv_xml TYPE string.
    DATA lv_repo TYPE i.
    DATA lv_loop TYPE i.
    DATA lv_source TYPE i.
    DATA lv_ddic TYPE i.
    lv_xml = zcl_osd_adt_discovery=>document( ).
    FIND `<atom:title>Repository</atom:title>` IN lv_xml MATCH OFFSET lv_repo.
    FIND `<atom:title>Development Loop</atom:title>` IN lv_xml MATCH OFFSET lv_loop.
    FIND `<atom:title>Source Library</atom:title>` IN lv_xml MATCH OFFSET lv_source.
    FIND `<atom:title>Data Dictionary</atom:title>` IN lv_xml MATCH OFFSET lv_ddic.
    cl_abap_unit_assert=>assert_true( boolc( lv_repo < lv_loop AND lv_loop < lv_source AND lv_source < lv_ddic ) ).
  ENDMETHOD.

  METHOD document_quirks.
    DATA lv_xml TYPE string.
    DATA lv_count TYPE i.
    DATA lv_section TYPE string.
    lv_xml = zcl_osd_adt_discovery=>document( ).
    FIND ALL OCCURRENCES OF `<atom:category ` IN lv_xml MATCH COUNT lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 28 ).
    FIND ALL OCCURRENCES OF ` type="text/plain"` IN lv_xml MATCH COUNT lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_xml exp = `*{&amp;objectType*}*` ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_xml exp = `*categories/respository*` ).
    SPLIT lv_xml AT `<app:collection href="/sap/bc/adt/oo/classrun">` INTO lv_section lv_xml.
    SPLIT lv_xml AT `</app:collection>` INTO lv_section lv_xml.
    cl_abap_unit_assert=>assert_false( boolc( lv_section CS `<app:accept>` ) ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_section exp = `* type="text/plain"*` ).
  ENDMETHOD.

  METHOD head_and_get.
    DATA lo_route TYPE REF TO zif_osd_adt_route.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA ls_response TYPE zif_osd_adt_route=>ty_response.
    CREATE OBJECT lo_route TYPE zcl_osd_adt_discovery.
    ls_request-method = `HEAD`.
    ls_response = lo_route->handle( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type exp = `application/atomsvc+xml` ).
    cl_abap_unit_assert=>assert_initial( ls_response-body ).
    ls_request-method = `GET`.
    ls_request-path = `/sap/bc/adt/discovery`.
    ls_response = lo_route->handle( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type exp = `application/atomsvc+xml; charset=utf-8` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body exp = zcl_osd_adt_discovery=>document( ) ).
    ls_request-path = `/sap/bc/adt/core/discovery`.
    ls_response = lo_route->handle( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-body exp = zcl_osd_adt_discovery=>document( abap_true ) ).
  ENDMETHOD.
  METHOD core_one_collection_each.
    DATA lv_xml TYPE string.
    DATA lv_workspaces TYPE i.
    DATA lv_collections TYPE i.
    DATA lt_rows TYPE zcl_osd_adt_discovery=>tt_collection.
    lv_xml = zcl_osd_adt_discovery=>document( abap_true ).
    lt_rows = zcl_osd_adt_discovery=>collections( ).
    FIND ALL OCCURRENCES OF `<app:workspace>` IN lv_xml MATCH COUNT lv_workspaces.
    FIND ALL OCCURRENCES OF `<app:collection ` IN lv_xml MATCH COUNT lv_collections.
    cl_abap_unit_assert=>assert_equals( act = lv_workspaces exp = lines( lt_rows ) ).
    cl_abap_unit_assert=>assert_equals( act = lv_collections exp = lines( lt_rows ) ).
*   the plain form keeps the collections, grouped
    lv_xml = zcl_osd_adt_discovery=>document( ).
    FIND ALL OCCURRENCES OF `<app:collection ` IN lv_xml MATCH COUNT lv_collections.
    cl_abap_unit_assert=>assert_equals( act = lv_collections exp = lines( lt_rows ) ).
    FIND ALL OCCURRENCES OF `<app:workspace>` IN lv_xml MATCH COUNT lv_workspaces.
    cl_abap_unit_assert=>assert_true( boolc( lv_workspaces < lines( lt_rows ) ) ).
  ENDMETHOD.
ENDCLASS.
