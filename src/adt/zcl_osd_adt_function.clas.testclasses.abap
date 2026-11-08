CLASS ltcl_function DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS main_program FOR TESTING.
    METHODS parse FOR TESTING.
    METHODS documents FOR TESTING.
    METHODS xml RETURNING VALUE(rv_xml) TYPE string.
ENDCLASS.
CLASS ltcl_function IMPLEMENTATION.
  METHOD main_program.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_function=>main_program( `zosd_test_fg` ) exp = `SAPLZOSD_TEST_FG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_function=>main_program( `/DEMO/FG` ) exp = `/DEMO/SAPLFG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_function=>group_uri( `/DEMO/FG` ) exp = `/sap/bc/adt/functions/groups/%2Fdemo%2Ffg` ).
*   group_of_main inverts main_program, namespaced too, and the include
*   list's reference follows it (a namespaced master is FUGR/F, not PROG/P)
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_function=>group_of_main( `SAPLZOSD_TEST_FG` ) exp = `ZOSD_TEST_FG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_function=>group_of_main( `/DEMO/SAPLFG` ) exp = `/DEMO/FG` ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_function=>group_of_main( `ZPROG` ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_function=>group_of_main( `/DEMO/ZPROG` ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_function=>group_of_main( `SAPL` ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_includes=>reference( iv_master = `/DEMO/SAPLFG` iv_package = `` )-type exp = `FUGR/F` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_includes=>reference( iv_master = `/DEMO/SAPLFG` iv_package = `` )-uri
      exp = `/sap/bc/adt/functions/groups/%2Fdemo%2Ffg` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_includes=>reference( iv_master = `ZPROG` iv_package = `` )-type exp = `PROG/P` ).
  ENDMETHOD.
  METHOD xml.
    rv_xml = `<abapGit><asx:values><AREAT>Demo &amp; more</AREAT><INCLUDES><SOBJ_NAME>LZFGTOP</SOBJ_NAME><SOBJ_NAME>SAPLZFG</SOBJ_NAME></INCLUDES>`
      && `<FUNCTIONS><item><FUNCNAME>Z_ONE</FUNCNAME><REMOTE_CALL>R</REMOTE_CALL><SHORT_TEXT>first</SHORT_TEXT><IMPORT><RSIMP><PARAMETER>IV</PARAMETER></RSIMP></IMPORT></item>`
      && `<item><FUNCNAME>Z_TWO</FUNCNAME><SHORT_TEXT>second</SHORT_TEXT></item></FUNCTIONS></asx:values></abapGit>`.
  ENDMETHOD.
  METHOD parse.
    DATA ls_group TYPE zcl_osd_adt_function=>ty_group.
    DATA ls_module TYPE zcl_osd_adt_function=>ty_module.
    ls_group = zcl_osd_adt_function=>parse( iv_xml = xml( ) iv_name = `zfg` ).
    cl_abap_unit_assert=>assert_equals( act = ls_group-name exp = `ZFG` ).
    cl_abap_unit_assert=>assert_equals( act = ls_group-text exp = `Demo & more` ).
*   the main program is the group's own source, not an include of it
    cl_abap_unit_assert=>assert_equals( act = lines( ls_group-includes ) exp = 1 ).
    READ TABLE ls_group-includes INDEX 1 INTO ls_group-text.
    cl_abap_unit_assert=>assert_equals( act = ls_group-text exp = `LZFGTOP` ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_group-modules ) exp = 2 ).
    READ TABLE ls_group-modules INDEX 1 INTO ls_module.
    cl_abap_unit_assert=>assert_equals( act = ls_module-name exp = `Z_ONE` ).
    cl_abap_unit_assert=>assert_equals( act = ls_module-text exp = `first` ).
    cl_abap_unit_assert=>assert_equals( act = ls_module-remote exp = abap_true ).
    READ TABLE ls_group-modules INDEX 2 INTO ls_module.
    cl_abap_unit_assert=>assert_equals( act = ls_module-remote exp = abap_false ).
  ENDMETHOD.
  METHOD documents.
    DATA ls_group TYPE zcl_osd_adt_function=>ty_group.
    DATA ls_module TYPE zcl_osd_adt_function=>ty_module.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    DATA lv_xml TYPE string.
    ls_group = zcl_osd_adt_function=>parse( iv_xml = xml( ) iv_name = `ZFG` ).
    ls_read-package = `$TMP`.
    ls_read-version = `inactive`.
    lv_xml = zcl_osd_adt_function=>group_document( is_group = ls_group is_read = ls_read ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<group:abapFunctionGroup ` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:name="ZFG" adtcore:type="FUGR/F"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:description="Demo &amp; more"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:version="inactive"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `abapsource:sourceUri="source/main"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `href="fmodules/z_one"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `href="includes/lzfgtop"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:uri="/sap/bc/adt/packages/%24tmp"` ) ).
    READ TABLE ls_group-modules INDEX 1 INTO ls_module.
    lv_xml = zcl_osd_adt_function=>module_document( is_group = ls_group is_module = ls_module is_read = ls_read ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `fmodule:processingType="rfc"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:name="Z_ONE" adtcore:type="FUGR/FF"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<adtcore:containerRef adtcore:name="ZFG" adtcore:type="FUGR/F"` ) ).
    lv_xml = zcl_osd_adt_function=>include_document( is_group = ls_group iv_include = `LZFGTOP` is_read = ls_read ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:name="LZFGTOP" adtcore:type="FUGR/I"` ) ).
  ENDMETHOD.
ENDCLASS.
