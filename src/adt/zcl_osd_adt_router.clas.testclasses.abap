CLASS ltcl_match DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The route table's rules without a server: first match wins, :param,
* HEAD falls back to GET, case and one trailing slash do not matter, and
* what ABAP does not serve is the host's.
  PRIVATE SECTION.
    DATA mt_routes TYPE zcl_osd_adt_router=>tt_route.
    METHODS setup.
    METHODS find
      IMPORTING iv_method       TYPE string
                iv_path         TYPE string
      RETURNING VALUE(rs_route) TYPE zcl_osd_adt_router=>ty_route.
    METHODS a_param_is_captured FOR TESTING RAISING cx_static_check.
    METHODS the_first_row_wins FOR TESTING RAISING cx_static_check.
    METHODS head_falls_back_to_get FOR TESTING RAISING cx_static_check.
    METHODS head_row_wins_over_get FOR TESTING RAISING cx_static_check.
    METHODS head_dispatch_keeps_get_body FOR TESTING RAISING cx_static_check.
    METHODS case_and_slash FOR TESTING RAISING cx_static_check.
    METHODS a_param_is_never_empty FOR TESTING RAISING cx_static_check.
    METHODS the_rest_is_the_hosts FOR TESTING RAISING cx_static_check.
    METHODS a_host_row_is_not_served FOR TESTING RAISING cx_static_check.
    METHODS settings_shadow FOR TESTING.
    METHODS discovery_rows FOR TESTING RAISING cx_static_check.
    METHODS versions_rows FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_match IMPLEMENTATION.

  METHOD settings_shadow.
    DATA lt_routes TYPE zcl_osd_adt_router=>tt_route.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    lt_routes = zcl_osd_adt_router=>routes( ).
    zcl_osd_adt_router=>match( EXPORTING it_routes = lt_routes iv_method = `GET` iv_path = `/sap/bc/adt/packages/SETTINGS` IMPORTING es_route = ls_route ).
*   B1's static row precedes packages/:name and matches without case
    cl_abap_unit_assert=>assert_equals( act = ls_route-served_by exp = zcl_osd_adt_router=>c_abap ).
    cl_abap_unit_assert=>assert_equals( act = ls_route-pattern exp = `/sap/bc/adt/packages/settings` ).
    zcl_osd_adt_router=>match( EXPORTING it_routes = lt_routes iv_method = `GET` iv_path = `/sap/bc/adt/packages/%73ettings` IMPORTING es_route = ls_route ).
    cl_abap_unit_assert=>assert_equals( act = ls_route-served_by exp = zcl_osd_adt_router=>c_abap ).
    cl_abap_unit_assert=>assert_equals( act = ls_route-pattern exp = `/sap/bc/adt/packages/:name` ).
  ENDMETHOD.
  METHOD discovery_rows.
    DATA lt_routes TYPE zcl_osd_adt_router=>tt_route.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    DATA lt_paths TYPE string_table.
    DATA lv_path TYPE string.
    DATA lv_found TYPE abap_bool.
    lt_routes = zcl_osd_adt_router=>routes( ).
    APPEND `/sap/bc/adt/core/discovery` TO lt_paths.
    APPEND `/sap/bc/adt/discovery` TO lt_paths.
    LOOP AT lt_paths INTO lv_path.
      zcl_osd_adt_router=>match( EXPORTING it_routes = lt_routes iv_method = `HEAD` iv_path = lv_path
                                IMPORTING ev_found = lv_found es_route = ls_route ).
      cl_abap_unit_assert=>assert_true( lv_found ).
      cl_abap_unit_assert=>assert_equals( act = ls_route-method exp = `HEAD` ).
      cl_abap_unit_assert=>assert_equals( act = ls_route-handler exp = `ZCL_OSD_ADT_DISCOVERY` ).
      cl_abap_unit_assert=>assert_equals( act = ls_route-served_by exp = zcl_osd_adt_router=>c_abap ).
    ENDLOOP.
  ENDMETHOD.

  METHOD versions_rows.
    DATA lt_routes TYPE zcl_osd_adt_router=>tt_route.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    DATA lv_found TYPE abap_bool.
    DATA lt_paths TYPE string_table.
    DATA lv_path TYPE string.
    lt_routes = zcl_osd_adt_router=>routes( ).
    APPEND `/sap/bc/adt/oo/classes/zcl_x/source/main/versions` TO lt_paths.
    APPEND `/sap/bc/adt/oo/classes/zcl_x/source/main/versions/19700101101123/00000/content` TO lt_paths.
    APPEND `/sap/bc/adt/oo/classes/zcl_x/includes/testclasses/versions` TO lt_paths.
    APPEND `/sap/bc/adt/oo/interfaces/zif_x/includes/main/versions/19700101101123/00000/content` TO lt_paths.
    APPEND `/sap/bc/adt/ddic/ddl/sources/zx/versions` TO lt_paths.
    APPEND `/sap/bc/adt/programs/programs/zx/source/main/versions` TO lt_paths.
    APPEND `/sap/bc/adt/programs/includes/zx/source/main/versions` TO lt_paths.
    APPEND `/sap/bc/adt/ddic/srvd/sources/zx/source/main/versions` TO lt_paths.
    LOOP AT lt_paths INTO lv_path.
      zcl_osd_adt_router=>match( EXPORTING it_routes = lt_routes iv_method = `HEAD` iv_path = lv_path
                                IMPORTING ev_found = lv_found es_route = ls_route ).
      cl_abap_unit_assert=>assert_true( lv_found ).
      cl_abap_unit_assert=>assert_equals( act = ls_route-handler exp = `ZCL_OSD_ADT_VERSIONS` ).
      cl_abap_unit_assert=>assert_equals( act = ls_route-served_by exp = zcl_osd_adt_router=>c_abap ).
    ENDLOOP.
  ENDMETHOD.

  METHOD setup.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    ls_route-method = `GET`.
    ls_route-pattern = `/sap/bc/adt/packages/valuehelps/:what`.
    ls_route-handler = `VALUEHELPS`.
    ls_route-served_by = zcl_osd_adt_router=>c_abap.
    APPEND ls_route TO mt_routes.
    ls_route-pattern = `/sap/bc/adt/packages/:name`.
    ls_route-handler = `PACKAGE`.
    APPEND ls_route TO mt_routes.
    ls_route-method = `HEAD`.
    ls_route-pattern = `/sap/bc/adt/discovery`.
    ls_route-handler = `HEAD_DISCOVERY`.
    APPEND ls_route TO mt_routes.
    ls_route-method = `GET`.
    ls_route-handler = `DISCOVERY`.
    APPEND ls_route TO mt_routes.
    ls_route-pattern = `/sap/bc/adt/packages/settings`.
    ls_route-handler = `SETTINGS`.
    APPEND ls_route TO mt_routes.
  ENDMETHOD.

  METHOD find.
    DATA lv_found TYPE abap_bool.
    zcl_osd_adt_router=>match( EXPORTING it_routes = mt_routes
                                         iv_method = iv_method
                                         iv_path   = iv_path
                               IMPORTING ev_found  = lv_found
                                         es_route  = rs_route ).
  ENDMETHOD.

  METHOD a_param_is_captured.
    DATA lv_found TYPE abap_bool.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    DATA lt_params TYPE zif_osd_adt_route=>tt_param.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    zcl_osd_adt_router=>match( EXPORTING it_routes = mt_routes
                                         iv_method = `GET`
                                         iv_path   = `/sap/bc/adt/packages/%2Fdemo%2Fzpkg`
                               IMPORTING ev_found  = lv_found
                                         es_route  = ls_route
                                         et_params = lt_params ).
    cl_abap_unit_assert=>assert_equals( act = ls_route-handler exp = `PACKAGE` ).
    READ TABLE lt_params INDEX 1 INTO ls_param.
    cl_abap_unit_assert=>assert_equals( act = ls_param-name exp = `name` ).
*   raw from the match; dispatch decodes it (ltcl_decode)
    cl_abap_unit_assert=>assert_equals( act = ls_param-value exp = `%2Fdemo%2Fzpkg` ).
  ENDMETHOD.

  METHOD the_first_row_wins.
*   packages/settings is listed after packages/:name, so :name takes it:
*   order is part of the contract, which is why the Node facade registers
*   packages/settings first
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `GET` iv_path = `/sap/bc/adt/packages/settings` )-handler
      exp = `PACKAGE` ).
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `GET` iv_path = `/sap/bc/adt/packages/valuehelps/softwarecomponents` )-handler
      exp = `VALUEHELPS` ).
  ENDMETHOD.

  METHOD head_dispatch_keeps_get_body.
*   The fallback's contract is "the GET answer of the same path, whole", so
*   the expectation is that answer, not a fixed document: core/discovery
*   answers its own (core) form since the core reader needed it.
    DATA lt_routes TYPE zcl_osd_adt_router=>tt_route.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA ls_result TYPE zcl_osd_adt_router=>ty_result.
    DATA ls_get TYPE zcl_osd_adt_router=>ty_result.
    lt_routes = zcl_osd_adt_router=>routes( ).
    DELETE lt_routes WHERE method = `HEAD` AND handler = `ZCL_OSD_ADT_DISCOVERY`.
    ls_request-method = `GET`.
    ls_request-path = `/sap/bc/adt/core/discovery`.
    ls_get = zcl_osd_adt_router=>dispatch( is_request = ls_request it_routes = lt_routes ).
    ls_request-method = `HEAD`.
    ls_result = zcl_osd_adt_router=>dispatch( is_request = ls_request it_routes = lt_routes ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-served_by exp = zcl_osd_adt_router=>c_abap ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-response-body exp = ls_get-response-body ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-response-body exp = zcl_osd_adt_discovery=>document( abap_true ) ).
    cl_abap_unit_assert=>assert_equals(
      act = ls_result-response-content_type exp = `application/atomsvc+xml; charset=utf-8` ).
  ENDMETHOD.

  METHOD head_falls_back_to_get.
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `HEAD` iv_path = `/sap/bc/adt/packages/zpkg` )-handler
      exp = `PACKAGE` ).
  ENDMETHOD.

  METHOD head_row_wins_over_get.
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `HEAD` iv_path = `/sap/bc/adt/discovery` )-handler
      exp = `HEAD_DISCOVERY` ).
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `GET` iv_path = `/sap/bc/adt/discovery` )-handler
      exp = `DISCOVERY` ).
  ENDMETHOD.

  METHOD case_and_slash.
    cl_abap_unit_assert=>assert_equals(
      act = find( iv_method = `GET` iv_path = `/SAP/BC/ADT/Discovery/` )-handler
      exp = `DISCOVERY` ).
  ENDMETHOD.

  METHOD a_param_is_never_empty.
    cl_abap_unit_assert=>assert_initial( find( iv_method = `GET` iv_path = `/sap/bc/adt/packages//x` ) ).
    cl_abap_unit_assert=>assert_initial( find( iv_method = `POST` iv_path = `/sap/bc/adt/packages/zpkg` ) ).
  ENDMETHOD.

  METHOD the_rest_is_the_hosts.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA ls_result TYPE zcl_osd_adt_router=>ty_result.
    ls_request-method = `GET`.
    ls_request-path = `/sap/bc/adt/repository/nodestructure`.
    ls_result = zcl_osd_adt_router=>dispatch( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-served_by exp = zcl_osd_adt_router=>c_host ).
*   a method no ABAP row has for a served path is the host's too
    ls_request-method = `POST`.
    ls_request-path = `/sap/bc/adt/core/http/systeminformation`.
    ls_result = zcl_osd_adt_router=>dispatch( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-served_by exp = zcl_osd_adt_router=>c_host ).
  ENDMETHOD.

  METHOD a_host_row_is_not_served.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA ls_response TYPE zif_osd_adt_route=>ty_response.
    DATA lv_served_by TYPE string.
    ls_request-method = `DELETE`.
    ls_request-path = `/sap/bc/adt/oo/classes/zcl_x`.
    zcl_osd_adt_handler=>answer( EXPORTING is_request   = ls_request
                                 IMPORTING es_response  = ls_response
                                           ev_served_by = lv_served_by ).
    cl_abap_unit_assert=>assert_equals( act = lv_served_by exp = zcl_osd_adt_router=>c_host ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 404 ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_document DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The exception document byte for byte. The Node side of the same case is
* compared in test/adt-abap-diff.mjs; this one pins the text itself.
  PRIVATE SECTION.
    METHODS without_properties FOR TESTING RAISING cx_static_check.
    METHODS with_properties_escaped FOR TESTING RAISING cx_static_check.
    METHODS the_graph_head FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_document IMPLEMENTATION.

  METHOD without_properties.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    DATA lv_nl TYPE string.
    DATA lv_exp TYPE string.
    lv_nl = cl_abap_char_utilities=>newline.
    lx_error = zcx_osd_adt=>not_found( `CLAS ZCL_NONE does not exist` ).
    lv_exp = `<?xml version="1.0" encoding="utf-8"?>` && lv_nl
      && `<exc:exception xmlns:exc="http://www.sap.com/abapxml/types/communicationframework">` && lv_nl
      && `  <namespace id="com.sap.adt"/>` && lv_nl
      && `  <type id="ExceptionResourceNotFound"/>` && lv_nl
      && `  <message lang="EN">CLAS ZCL_NONE does not exist</message>` && lv_nl
      && `  <localizedMessage lang="EN">CLAS ZCL_NONE does not exist</localizedMessage>` && lv_nl
      && `  <properties/>` && lv_nl
      && `</exc:exception>` && lv_nl.
    cl_abap_unit_assert=>assert_equals( act = lx_error->document( ) exp = lv_exp ).
    cl_abap_unit_assert=>assert_equals( act = lx_error->status exp = 404 ).
  ENDMETHOD.

  METHOD with_properties_escaped.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    DATA lt_properties TYPE tihttpnvp.
    DATA ls_property TYPE ihttpnvp.
    DATA lv_doc TYPE string.
    ls_property-name = `T100KEY-ID`.
    ls_property-value = `EU`.
    APPEND ls_property TO lt_properties.
    ls_property-name = `LONGTEXT`.
    ls_property-value = `a <b> & "c"`.
    APPEND ls_property TO lt_properties.
    CREATE OBJECT lx_error
      EXPORTING iv_status     = 403
                iv_type       = `ExceptionResourceNoAccess`
                iv_message    = `x < y`
                it_properties = lt_properties.
    lv_doc = lx_error->document( ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_doc exp = `*<message lang="EN">x &lt; y</message>*` ).
    cl_abap_unit_assert=>assert_char_cp(
      act = lv_doc
      exp = `*<entry key="LONGTEXT">a &lt;b&gt; &amp; &quot;c&quot;</entry>*` ).
  ENDMETHOD.

  METHOD the_graph_head.
    DATA lo_graph TYPE REF TO zif_osd_adt_route.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA ls_response TYPE zif_osd_adt_route=>ty_response.
    CREATE OBJECT lo_graph TYPE zcl_osd_adt_graph.
    ls_request-method = `HEAD`.
    ls_response = lo_graph->handle( ls_request ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_type exp = `application/xml` ).
    cl_abap_unit_assert=>assert_initial( ls_response-body ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_decode DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* A :param is decoded as Express decodes it: %XX bytes as UTF-8, a plus
* sign kept, and anything else a 400 "Failed to decode param" rather than
* a JavaScript URIError no CATCH reaches.
  PRIVATE SECTION.
    METHODS refused
      IMPORTING iv_segment TYPE string.
    METHODS a_plus_stays_a_plus FOR TESTING RAISING cx_static_check.
    METHODS bytes_are_decoded FOR TESTING RAISING cx_static_check.
    METHODS malformed_is_400 FOR TESTING RAISING cx_static_check.
    METHODS not_utf8_is_400 FOR TESTING RAISING cx_static_check.
    METHODS dispatch_answers_400 FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_decode IMPLEMENTATION.

  METHOD refused.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    TRY.
        zcl_osd_adt_uri=>decode_segment( iv_segment ).
        cl_abap_unit_assert=>fail( |{ iv_segment } decoded| ).
      CATCH zcx_osd_adt INTO lx_error.
        cl_abap_unit_assert=>assert_equals( act = lx_error->status exp = 400 ).
        cl_abap_unit_assert=>assert_equals( act = lx_error->message_text
                                            exp = |Failed to decode param '{ iv_segment }'| ).
    ENDTRY.
  ENDMETHOD.

  METHOD a_plus_stays_a_plus.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_uri=>decode_segment( `a+b` ) exp = `a+b` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_uri=>decode_segment( `a%2Bb+c` ) exp = `a+b+c` ).
  ENDMETHOD.

  METHOD bytes_are_decoded.
    DATA lv_text TYPE string.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_uri=>decode_segment( `%2Fdemo%2fzpkg` ) exp = `/demo/zpkg` ).
*   two bytes, one character (a-umlaut)
    lv_text = zcl_osd_adt_uri=>decode_segment( `%C3%A4x` ).
    cl_abap_unit_assert=>assert_equals( act = strlen( lv_text ) exp = 2 ).
  ENDMETHOD.

  METHOD malformed_is_400.
    refused( `%zz` ).
    refused( `abc%4` ).
    refused( `%` ).
  ENDMETHOD.

  METHOD not_utf8_is_400.
    refused( `%FF` ).
    refused( `%C3` ).
  ENDMETHOD.

  METHOD dispatch_answers_400.
    DATA lt_routes TYPE zcl_osd_adt_router=>tt_route.
    DATA ls_route TYPE zcl_osd_adt_router=>ty_route.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    ls_route-method = `GET`.
    ls_route-pattern = `/sap/bc/adt/probe/:name`.
    ls_route-handler = `ZCL_OSD_ADT_GRAPH`.
    ls_route-served_by = zcl_osd_adt_router=>c_abap.
    APPEND ls_route TO lt_routes.
    ls_request-method = `GET`.
    ls_request-path = `/sap/bc/adt/probe/%zz`.
    TRY.
        zcl_osd_adt_router=>dispatch( is_request = ls_request it_routes = lt_routes ).
        cl_abap_unit_assert=>fail( `dispatched` ).
      CATCH zcx_osd_adt INTO lx_error.
        cl_abap_unit_assert=>assert_equals( act = lx_error->status exp = 400 ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
