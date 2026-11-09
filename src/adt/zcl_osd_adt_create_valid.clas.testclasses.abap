CLASS ltcl_create_valid DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS resources FOR TESTING.
    METHODS names FOR TESTING.
    METHODS package_children FOR TESTING.
    METHODS documents FOR TESTING.
ENDCLASS.
CLASS ltcl_create_valid IMPLEMENTATION.
  METHOD resources.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>resource_of( `/sap/bc/adt/oo/validation/objectname` ) exp = `OO` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>resource_of( `/sap/bc/adt/PaCkAgEs/VaLiDaTiOn/` ) exp = `PACKAGE` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>resource_of( `/sap/bc/adt/programs/validation` ) exp = `PROG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>resource_of( `/sap/bc/adt/includes/validation` ) exp = `INCL` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>type_of( `PROG/P` ) exp = `PROG` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>type_of( `prog/i` ) exp = `INCL` ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_create_valid=>type_of( `FUGR/F` ) ).
  ENDMETHOD.
  METHOD names.
*   the messages of tools/osd-object-name.mjs nameProblem, word for word
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_create_valid=>name_problem( iv_type = `PROG` iv_name = `ZTEST_1` ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_create_valid=>name_problem( iv_type = `CLAS` iv_name = `/DEMO/ZCL_X` ) ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_create_valid=>name_problem( iv_type = `DEVC` iv_name = `$TMP_SUB` ) ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>name_problem( iv_type = `CLAS` iv_name = `zcl_low` )
      exp = `CLAS zcl_low: a repository name is upper case` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>name_problem( iv_type = `CLAS` iv_name = `../INVALID` )
      exp = `CLAS "../INVALID" is not a repository name (A-Z, 0-9, _, an optional /NAMESPACE/)` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>name_problem( iv_type = `DEVC` iv_name = `Z.X` )
      exp = `DEVC "Z.X" is not a repository name (A-Z, 0-9, _, a leading $, an optional /NAMESPACE/)` ).
    cl_abap_unit_assert=>assert_true( boolc( zcl_osd_adt_create_valid=>name_problem( iv_type = `DEVC` iv_name = `$A234567890123456789012345678901` ) IS NOT INITIAL ) ).
    cl_abap_unit_assert=>assert_true( boolc( zcl_osd_adt_create_valid=>name_problem( iv_type = `PROG` iv_name = `$ZPROG` ) IS NOT INITIAL ) ).
  ENDMETHOD.
  METHOD package_children.
*   tools/osd-object-name.mjs packageChildName
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$TMP` iv_name = `$MIXED` ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$TMP` iv_name = `$TMP_SUB` ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$TMP` iv_name = `$TMP_` ) exp = abap_false ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$TMP` iv_name = `ZNEW` ) exp = abap_false ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$STG` iv_name = `$STG_ADT` ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_create_valid=>package_child( iv_parent = `$STG` iv_name = `$OTHER` ) exp = abap_false ).
  ENDMETHOD.
  METHOD documents.
    DATA ls_verdict TYPE zcl_osd_adt_create_valid=>ty_verdict.
    ls_verdict-success = abap_true.
    cl_abap_unit_assert=>assert_true( boolc( zcl_osd_adt_create_valid=>document( ls_verdict )
      CS `<DATA><CHECK_RESULT>X</CHECK_RESULT><SEVERITY>SUCCESS</SEVERITY><SHORT_TEXT></SHORT_TEXT></DATA>` ) ).
    ls_verdict-success = abap_false.
    ls_verdict-message = `A package under $TMP must be named $TMP_<FOLDER>`.
    cl_abap_unit_assert=>assert_true( boolc( zcl_osd_adt_create_valid=>document( ls_verdict )
      CS `<CHECK_RESULT></CHECK_RESULT><SEVERITY>ERROR</SEVERITY><SHORT_TEXT>A package under $TMP must be named $TMP_&lt;FOLDER&gt;</SHORT_TEXT>` ) ).
  ENDMETHOD.
ENDCLASS.
