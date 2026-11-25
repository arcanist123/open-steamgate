* The SEGW project tree served from its own tables through a service that
* is nothing but YAML (src/segw/zstg_segw.stg.yaml -> stg-compile -> classes
* that delegate to SADL): create, read, update, delete over a DDIC table
* without a line of hand-written DPC code
CLASS ltcl_crud DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    CONSTANTS gc_base TYPE string VALUE '/sap/opu/odata/sap/ZSTG_SEGW_SRV'.
    METHODS setup.
    METHODS create_read_update_delete FOR TESTING RAISING cx_static_check.
    METHODS create_duplicate_is_400 FOR TESTING RAISING cx_static_check.
    METHODS create_without_key_is_400 FOR TESTING RAISING cx_static_check.
    METHODS delete_unknown_is_400 FOR TESTING RAISING cx_static_check.
    METHODS text_table_with_language_key FOR TESTING RAISING cx_static_check.
    METHODS call
      IMPORTING
        iv_method          TYPE string
        iv_path            TYPE string
        iv_body            TYPE string OPTIONAL
        iv_query           TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
ENDCLASS.

CLASS ltcl_crud IMPLEMENTATION.

  METHOD setup.
    zcl_oao_registry=>register( iv_service = 'ZSTG_SEGW_SRV'
                                iv_mpc     = 'ZCL_ZSTG_SEGW_MPC_EXT'
                                iv_dpc     = 'ZCL_ZSTG_SEGW_DPC_EXT' ).
    zcl_stg_model_info=>clear( ).
    DELETE FROM zstg_sbd_pr WHERE project LIKE 'ZUT_%'.
    DELETE FROM zstg_sbd_prt WHERE project LIKE 'ZUT_%'.
  ENDMETHOD.

  METHOD call.
    DATA lt_options TYPE tihttpnvp.

    IF iv_query IS NOT INITIAL.
      lt_options = cl_http_utility=>string_to_fields( iv_query ).
    ENDIF.
    rs_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = iv_method
                                                iv_path    = iv_path
                                                it_options = lt_options
                                                iv_body    = iv_body ).
  ENDMETHOD.

  METHOD create_read_update_delete.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = call( iv_method = 'POST'
                        iv_path   = gc_base && '/ProjectSet'
                        iv_body   = `{"Project":"ZUT_ONE","NodeUuid":"pr-1","ProjectType":"S","LastChgTime":"20260912200000.0000000"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 201 ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"Project":"ZUT_ONE"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"ProjectType":"S"` ) ).

    ls_response = call( iv_method = 'GET'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_ONE',NodeUuid='pr-1')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"NodeUuid":"pr-1"` ) ).

    ls_response = call( iv_method = 'PUT'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_ONE',NodeUuid='pr-1')`
                        iv_body   = `{"Project":"ZUT_ONE","NodeUuid":"pr-1","ProjectType":"R"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 204 ).
    ls_response = call( iv_method = 'GET'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_ONE',NodeUuid='pr-1')` ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"ProjectType":"R"` ) ).

* the set lists it, $filter on a key works through the generic read
    ls_response = call( iv_method = 'GET'
                        iv_path   = gc_base && `/ProjectSet`
                        iv_query  = `$filter=Project eq 'ZUT_ONE'` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"ProjectType":"R"` ) ).

    ls_response = call( iv_method = 'DELETE'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_ONE',NodeUuid='pr-1')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 204 ).
    ls_response = call( iv_method = 'GET'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_ONE',NodeUuid='pr-1')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 404 ).
  ENDMETHOD.

  METHOD create_duplicate_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = call( iv_method = 'POST'
                        iv_path   = gc_base && '/ProjectSet'
                        iv_body   = `{"Project":"ZUT_DUP","NodeUuid":"pr-1"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 201 ).
    ls_response = call( iv_method = 'POST'
                        iv_path   = gc_base && '/ProjectSet'
                        iv_body   = `{"Project":"ZUT_DUP","NodeUuid":"pr-1"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400 ).
  ENDMETHOD.

  METHOD create_without_key_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = call( iv_method = 'POST'
                        iv_path   = gc_base && '/ProjectSet'
                        iv_body   = `{"Project":"ZUT_NOKEY","ProjectType":"S"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400 ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `NODE_UUID` ) ).
  ENDMETHOD.

  METHOD delete_unknown_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = call( iv_method = 'DELETE'
                        iv_path   = gc_base && `/ProjectSet(Project='ZUT_NONE',NodeUuid='x')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 400 ).
  ENDMETHOD.

  METHOD text_table_with_language_key.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = call( iv_method = 'POST'
                        iv_path   = gc_base && '/ProjectTextSet'
                        iv_body   = `{"Project":"ZUT_TXT","Language":"E","Description":"A project, described"}` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 201 ).
    ls_response = call( iv_method = 'GET'
                        iv_path   = gc_base && `/ProjectTextSet(Project='ZUT_TXT',Language='E')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status
                                        exp = 200 ).
    cl_abap_unit_assert=>assert_true( boolc( ls_response-body CS `"Description":"A project, described"` ) ).
  ENDMETHOD.

ENDCLASS.

* the project tree imported from test/fixtures/segw/zstg_mapped.iwpr.xml
* (data/zstg_sb*.tabu.json, tools/segw-tree.mjs) is served by the same service
CLASS ltcl_tree DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.
  PRIVATE SECTION.
    METHODS setup.
    METHODS entity_types_of_the_project FOR TESTING.
    METHODS properties_in_file_order FOR TESTING.
    METHODS text_table_of_the_project FOR TESTING.
ENDCLASS.

CLASS ltcl_tree IMPLEMENTATION.

  METHOD setup.
    zcl_oao_registry=>register( iv_service = 'ZSTG_SEGW_SRV'
                                iv_mpc     = 'ZCL_ZSTG_SEGW_MPC_EXT'
                                iv_dpc     = 'ZCL_ZSTG_SEGW_DPC_EXT' ).
    zcl_stg_model_info=>clear( ).
  ENDMETHOD.

  METHOD entity_types_of_the_project.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options TYPE tihttpnvp.

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZSTG_MAPPED'&$orderby=StgSeq` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/EntityTypeSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"Travel"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"StatusVH"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"AbapStruct":"ZSTG_DEMO"' ) ).
  ENDMETHOD.

  METHOD properties_in_file_order.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options TYPE tihttpnvp.
    DATA lv_travel TYPE i.
    DATA lv_seats  TYPE i.

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZSTG_MAPPED' and ParentUuid eq 'et-1'&$orderby=StgSeq&$select=Name,StgSeq` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/PropertySet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    FIND '"Name":"TravelId"' IN ls_response-body MATCH OFFSET lv_travel.
    cl_abap_unit_assert=>assert_subrc( msg = ls_response-body ).
    FIND '"Name":"Seats"' IN ls_response-body MATCH OFFSET lv_seats.
    cl_abap_unit_assert=>assert_subrc( msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_travel < lv_seats ) ).
    cl_abap_unit_assert=>assert_false( xsdbool( ls_response-body CS '"Name":"Status"' ) ).
  ENDMETHOD.

  METHOD text_table_of_the_project.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/ProjectTextSet(Project='ZSTG_MAPPED',Language='E')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Description":"' ) ).
  ENDMETHOD.

ENDCLASS.

* POST ImportSet with an IWPR file as Content: zcl_stg_segw_import parses
* it and replaces the project's rows in every table
CLASS ltcl_import DEFINITION FOR TESTING RISK LEVEL DANGEROUS DURATION SHORT FINAL.
  PRIVATE SECTION.
    CONSTANTS gc_set TYPE string VALUE '/sap/opu/odata/sap/ZSTG_SEGW_SRV/ImportSet'.
    METHODS setup.
    METHODS import_writes_the_rows FOR TESTING.
    METHODS import_replaces_the_project FOR TESTING.
    METHODS unknown_field_is_400_untouched FOR TESTING.
    METHODS export_gives_the_file_back FOR TESTING.
    METHODS export_of_nobody_is_400 FOR TESTING.
    METHODS delete_node_takes_its_subtree FOR TESTING.
    METHODS delete_unknown_node_is_400 FOR TESTING.
    METHODS generate_writes_the_mpc FOR TESTING.
    METHODS function_group_fills_the_table FOR TESTING.
    METHODS value_too_long_is_400 FOR TESTING.
    METHODS repo_is_an_abapgit_repository FOR TESTING.
    METHODS repo_of_a_local_object_is_400 FOR TESTING.
    METHODS count IMPORTING iv_set TYPE string iv_needle TYPE string RETURNING VALUE(rv_count) TYPE i.
    METHODS iwpr IMPORTING iv_second_type TYPE abap_bool DEFAULT abap_true RETURNING VALUE(rv_xml) TYPE string.
    METHODS post IMPORTING iv_xml TYPE string RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    METHODS entity_types RETURNING VALUE(rv_body) TYPE string.
ENDCLASS.

CLASS ltcl_import IMPLEMENTATION.

  METHOD setup.
    zcl_oao_registry=>register( iv_service = 'ZSTG_SEGW_SRV'
                                iv_mpc     = 'ZCL_ZSTG_SEGW_MPC_EXT'
                                iv_dpc     = 'ZCL_ZSTG_SEGW_DPC_EXT' ).
    zcl_stg_model_info=>clear( ).
    DELETE FROM zstg_sbd_pr WHERE project = 'ZUT_IMP'.
    DELETE FROM zstg_sbd_prt WHERE project = 'ZUT_IMP'.
    DELETE FROM zstg_sbo_et WHERE project = 'ZUT_IMP'.
    DELETE FROM zstg_sbo_pr WHERE project = 'ZUT_IMP'.
    DELETE FROM zstg_sbo_prt WHERE project = 'ZUT_IMP'.
    DELETE FROM zstg_sbd_ga WHERE project = 'ZUT_IMP'.
    DELETE FROM tadir WHERE pgmid = 'R3TR' AND object = 'CLAS' AND obj_name = 'ZCL_ZUT_IMP_MPC'.
  ENDMETHOD.

  METHOD iwpr.
    DATA lv_nl TYPE string.
    lv_nl = cl_abap_char_utilities=>newline.
*   The byte order mark, because every IWPR a real system writes begins with
*   one and this fixture says "the same bytes as went in". A fixture that
*   differs from a real file in its first three bytes cannot prove anything
*   about the first three bytes -- the same correction the two Node fixtures
*   needed on 2026-09-19.
    rv_xml = zcl_stg_segw_gen=>bom( )
      && `<?xml version="1.0" encoding="utf-8"?>` && lv_nl
      && `<abapGit version="v1.0.0" serializer="LCL_OBJECT_IWPR" serializer_version="v1.0.0">` && lv_nl
      && ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">` && lv_nl
      && `  <asx:values>` && lv_nl
      && `   <_-IWBEP_-I_SBD_GA>` && lv_nl
      && `    <_-IWBEP_-I_SBD_GA>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>ga-1</NODE_UUID>` && lv_nl
      && `     <NAME>ZCL_ZUT_IMP_MPC</NAME>` && lv_nl
      && `     <GEN_ART_TYPE>MPCB</GEN_ART_TYPE>` && lv_nl
      && `    </_-IWBEP_-I_SBD_GA>` && lv_nl
      && `   </_-IWBEP_-I_SBD_GA>` && lv_nl
      && `   <_-IWBEP_-I_SBD_PR>` && lv_nl
      && `    <_-IWBEP_-I_SBD_PR>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>pr-1</NODE_UUID>` && lv_nl
      && `     <PROJECT_TYPE>1</PROJECT_TYPE>` && lv_nl
      && `    </_-IWBEP_-I_SBD_PR>` && lv_nl
      && `   </_-IWBEP_-I_SBD_PR>` && lv_nl
      && `   <_-IWBEP_-I_SBD_PRT>` && lv_nl
      && `    <_-IWBEP_-I_SBD_PRT>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <SYLANGU>E</SYLANGU>` && lv_nl
      && `     <DESCRIPTION>A &amp; B &lt;imported&gt;</DESCRIPTION>` && lv_nl
      && `    </_-IWBEP_-I_SBD_PRT>` && lv_nl
      && `   </_-IWBEP_-I_SBD_PRT>` && lv_nl
      && `   <_-IWBEP_-I_SBO_ET>` && lv_nl
      && `    <_-IWBEP_-I_SBO_ET>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>et-1</NODE_UUID>` && lv_nl
      && `     <NAME>Travel</NAME>` && lv_nl
      && `     <ABAP_STRUCT>ZSTG_DEMO</ABAP_STRUCT>` && lv_nl
      && `    </_-IWBEP_-I_SBO_ET>` && lv_nl.
    IF iv_second_type = abap_true.
      rv_xml = rv_xml
        && `    <_-IWBEP_-I_SBO_ET>` && lv_nl
        && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
        && `     <NODE_UUID>et-2</NODE_UUID>` && lv_nl
        && `     <NAME>Booking</NAME>` && lv_nl
        && `    </_-IWBEP_-I_SBO_ET>` && lv_nl.
    ENDIF.
    rv_xml = rv_xml
      && `   </_-IWBEP_-I_SBO_ET>` && lv_nl
      && `   <_-IWBEP_-I_SBO_PR>` && lv_nl
      && `    <_-IWBEP_-I_SBO_PR>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>pp-1</NODE_UUID>` && lv_nl
      && `     <PARENT_UUID>et-1</PARENT_UUID>` && lv_nl
      && `     <NAME>TravelId</NAME>` && lv_nl
      && `    </_-IWBEP_-I_SBO_PR>` && lv_nl
      && `    <_-IWBEP_-I_SBO_PR>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>pp-2</NODE_UUID>` && lv_nl
      && `     <PARENT_UUID>et-2</PARENT_UUID>` && lv_nl
      && `     <NAME>BookingId</NAME>` && lv_nl
      && `    </_-IWBEP_-I_SBO_PR>` && lv_nl
      && `   </_-IWBEP_-I_SBO_PR>` && lv_nl
      && `   <_-IWBEP_-I_SBO_PRT>` && lv_nl
      && `    <_-IWBEP_-I_SBO_PRT>` && lv_nl
      && `     <SYLANGU>E</SYLANGU>` && lv_nl
      && `     <PROJECT>ZUT_IMP</PROJECT>` && lv_nl
      && `     <NODE_UUID>pp-1</NODE_UUID>` && lv_nl
      && `     <PROP_LABEL>Travel</PROP_LABEL>` && lv_nl
      && `    </_-IWBEP_-I_SBO_PRT>` && lv_nl
      && `   </_-IWBEP_-I_SBO_PRT>` && lv_nl
      && `  </asx:values>` && lv_nl
      && ` </asx:abap>` && lv_nl
      && `</abapGit>` && lv_nl.
  ENDMETHOD.

  METHOD post.
    rs_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'POST'
                                                iv_path   = gc_set
                                                iv_body   = |\{"Content":"{ zcl_stg_json=>escape( iv_xml ) }"\}| ).
  ENDMETHOD.

  METHOD entity_types.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZUT_IMP'&$orderby=StgSeq` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/EntityTypeSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    rv_body = ls_response-body.
  ENDMETHOD.

  METHOD import_writes_the_rows.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_body     TYPE string.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Project":"ZUT_IMP"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Rows":8' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Tables":6' ) ).

    lv_body = entity_types( ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"Name":"Travel"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"Name":"Booking"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"StgSeq":2' ) ).

* entities are unescaped on the way in
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/ProjectTextSet(Project='ZUT_IMP',Language='E')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Description":"A & B <imported>"' ) ).
  ENDMETHOD.

  METHOD import_replaces_the_project.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_body     TYPE string.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    ls_response = post( iwpr( abap_false ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Rows":7' ) ).

    lv_body = entity_types( ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"Name":"Travel"' ) ).
    cl_abap_unit_assert=>assert_false( xsdbool( lv_body CS '"Name":"Booking"' ) ).
  ENDMETHOD.

  METHOD unknown_field_is_400_untouched.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_xml      TYPE string.
    DATA lv_body     TYPE string.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).

    lv_xml = iwpr( abap_false ).
    REPLACE '<NAME>Travel</NAME>' IN lv_xml WITH '<NAME>Flight</NAME><MADE_UP>x</MADE_UP>'.
    ls_response = post( lv_xml ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'SBO_ET.MADE_UP: not a field of ZSTG_SBO_ET' ) ).

* the earlier import is still there, untouched
    lv_body = entity_types( ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"Name":"Travel"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( lv_body CS '"Name":"Booking"' ) ).
    cl_abap_unit_assert=>assert_false( xsdbool( lv_body CS '"Name":"Flight"' ) ).
  ENDMETHOD.

  METHOD export_gives_the_file_back.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_xml      TYPE string.

    lv_xml = iwpr( ).
    ls_response = post( lv_xml ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).

    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/ExportSet('ZUT_IMP')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
* the same bytes as went in: rows by position, fields in the table's order,
* &amp; &lt; &gt; escaped again
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS |"Content":"{ zcl_stg_json=>escape( lv_xml ) }"| ) ).
  ENDMETHOD.

  METHOD export_of_nobody_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/ExportSet('ZUT_NOBODY')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'no project ZUT_NOBODY' ) ).
  ENDMETHOD.

  METHOD count.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZUT_IMP'` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = |/sap/opu/odata/sap/ZSTG_SEGW_SRV/{ iv_set }|
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    FIND ALL OCCURRENCES OF iv_needle IN ls_response-body MATCH COUNT rv_count.
  ENDMETHOD.

  METHOD delete_node_takes_its_subtree.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'PropertySet' iv_needle = '"NodeUuid":"pp-' ) exp = 2 ).

* the entity type, its property and the property's text go; the other type stays
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'DELETE'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/NodeSet(Project='ZUT_IMP',NodeUuid='et-1')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 204 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'EntityTypeSet' iv_needle = '"Name":"Travel"' ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'EntityTypeSet' iv_needle = '"Name":"Booking"' ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'PropertySet' iv_needle = '"NodeUuid":"pp-1"' ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'PropertySet' iv_needle = '"NodeUuid":"pp-2"' ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'PropertyTextSet' iv_needle = '"NodeUuid":"pp-1"' ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'ProjectSet' iv_needle = '"NodeUuid":"pr-1"' ) exp = 1 ).
  ENDMETHOD.

  METHOD delete_unknown_node_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.

    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'DELETE'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/NodeSet(Project='ZUT_IMP',NodeUuid='nobody')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'no node nobody in project ZUT_IMP' ) ).
  ENDMETHOD.

  METHOD generate_writes_the_mpc.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZUT_IMP'` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/GenerateSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"zcl_zut_imp_mpc.clas.abap"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"zcl_zut_imp_mpc.clas.trace.json"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"zcl_zut_imp_mpc.clas.xml"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '<CLSNAME>ZCL_ZUT_IMP_MPC</CLSNAME>' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'class ZCL_ZUT_IMP_MPC definition' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'method DEFINE_TRAVEL.' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS `lo_property = lo_entity_type->create_property( iv_property_name = 'BookingId' iv_abap_fieldname = 'BOOKINGID' ).` ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS `lo_entity_type->bind_structure( iv_structure_name   = 'ZSTG_DEMO'` ) ).

* the same file by key
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/GenerateSet(Project='ZUT_IMP',Name='zcl_zut_imp_mpc.clas.abap')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'method GET_LAST_MODIFIED.' ) ).
  ENDMETHOD.

  METHOD function_group_fills_the_table.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.
    DATA lv_xml      TYPE string.
    DATA lv_nl       TYPE string.

    DELETE FROM zstg_fm_param WHERE funcname = 'Z_UT_MODULE'.
    lv_nl = cl_abap_char_utilities=>newline.
    lv_xml = `<?xml version="1.0" encoding="utf-8"?>` && lv_nl
      && `<abapGit version="v1.0.0" serializer="LCL_OBJECT_FUGR" serializer_version="v1.0.0">` && lv_nl
      && ` <asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">` && lv_nl
      && `  <asx:values>` && lv_nl
      && `   <FUNCTIONS>` && lv_nl
      && `    <item>` && lv_nl
      && `     <FUNCNAME>Z_UT_MODULE</FUNCNAME>` && lv_nl
      && `     <REMOTE_CALL>R</REMOTE_CALL>` && lv_nl
      && `     <IMPORT>` && lv_nl
      && `      <RSIMP>` && lv_nl
      && `       <PARAMETER>IV_ID</PARAMETER>` && lv_nl
      && `       <OPTIONAL>X</OPTIONAL>` && lv_nl
      && `       <TYP>CHAR10</TYP>` && lv_nl
      && `      </RSIMP>` && lv_nl
      && `     </IMPORT>` && lv_nl
      && `     <TABLES>` && lv_nl
      && `      <RSTBL>` && lv_nl
      && `       <PARAMETER>ET_RETURN</PARAMETER>` && lv_nl
      && `       <DBSTRUCT>BAPIRET2</DBSTRUCT>` && lv_nl
      && `      </RSTBL>` && lv_nl
      && `     </TABLES>` && lv_nl
      && `    </item>` && lv_nl
      && `   </FUNCTIONS>` && lv_nl
      && `  </asx:values>` && lv_nl
      && ` </asx:abap>` && lv_nl
      && `</abapGit>` && lv_nl.
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'POST'
                                                iv_path   = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/FunctionGroupSet'
                                                iv_body   = |\{"Name":"ZUT","Content":"{ zcl_stg_json=>escape( lv_xml ) }"\}| ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Modules":1' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Rows":2' ) ).

    lt_options = cl_http_utility=>string_to_fields( `$filter=Funcname eq 'Z_UT_MODULE'&$orderby=StgSeq` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/ModuleParameterSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Parameter":"IV_ID","Kind":"I","Typ":"CHAR10","Optional":"X","Remote":"X","StgSeq":1' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Parameter":"ET_RETURN","Kind":"T","Typ":"BAPIRET2"' ) ).
  ENDMETHOD.

  METHOD value_too_long_is_400.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_xml      TYPE string.

    lv_xml = iwpr( ).
    REPLACE '<NAME>Travel</NAME>' IN lv_xml
      WITH '<NAME>TravelWithAnEntityNameFarLongerThanTheColumnOfTheTableThatHoldsIt</NAME>'.
    ls_response = post( lv_xml ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'SBO_ET.NAME: the value does not fit the column of ZSTG_SBO_ET' ) ).

* nothing of that import was written
    cl_abap_unit_assert=>assert_equals( act = count( iv_set = 'EntityTypeSet' iv_needle = '"Project"' ) exp = 0 ).
  ENDMETHOD.

  METHOD repo_is_an_abapgit_repository.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZUT_IMP'` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/RepoFileSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":".abapgit.xml"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"src/package.devc.xml"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"src/zut_imp.iwpr.xml"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Name":"src/zcl_zut_imp_mpc.clas.abap"' ) ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '<STARTING_FOLDER>/src/</STARTING_FOLDER>' ) ).

* the same repository as one zip: PK, and the base64 is not empty
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/RepoSet('ZUT_IMP')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 200 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS '"Content":"UEsDB' ) ).
  ENDMETHOD.

  METHOD repo_of_a_local_object_is_400.
* an object of $TMP is never transported (tools/osd-tmp.mjs): TADIR saying
* $TMP for one class of the project refuses both routes of the export
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_tadir    TYPE tadir.

    ls_response = post( iwpr( ) ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 201 msg = ls_response-body ).
    ls_tadir-pgmid    = 'R3TR'.
    ls_tadir-object   = 'CLAS'.
    ls_tadir-obj_name = 'ZCL_ZUT_IMP_MPC'.
    ls_tadir-devclass = '$TMP'.
    MODIFY tadir FROM ls_tadir.

    lt_options = cl_http_utility=>string_to_fields( `$filter=Project eq 'ZUT_IMP'` ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method  = 'GET'
                                                iv_path    = '/sap/opu/odata/sap/ZSTG_SEGW_SRV/RepoFileSet'
                                                it_options = lt_options ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).
    cl_abap_unit_assert=>assert_true( xsdbool( ls_response-body CS 'never transported' ) ).
    ls_response = zcl_stg_dispatcher=>dispatch_decoded( iv_method = 'GET'
                                                iv_path   = `/sap/opu/odata/sap/ZSTG_SEGW_SRV/RepoSet('ZUT_IMP')` ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-status exp = 400 msg = ls_response-body ).

    DELETE FROM tadir WHERE pgmid = 'R3TR' AND object = 'CLAS' AND obj_name = 'ZCL_ZUT_IMP_MPC'.
  ENDMETHOD.

ENDCLASS.
