CLASS ltcl_cunit DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* ZZ1: " in English, ZO in German; G: G in English only.
  PRIVATE SECTION.
    METHODS setup.
    METHODS teardown.
    METHODS output_in_the_language FOR TESTING RAISING cx_static_check.
    METHODS output_default_is_sy_langu FOR TESTING RAISING cx_static_check.
    METHODS output_unknown_raises FOR TESTING RAISING cx_static_check.
    METHODS input_in_the_language FOR TESTING RAISING cx_static_check.
    METHODS input_unknown_raises FOR TESTING RAISING cx_static_check.
    METHODS input_initial_is_initial FOR TESTING RAISING cx_static_check.
    METHODS no_table_is_not_found FOR TESTING RAISING cx_static_check.
    METHODS unit
      IMPORTING
        iv_langu TYPE sy-langu
        iv_msehi TYPE csequence
        iv_mseh3 TYPE csequence
        iv_short TYPE csequence
        iv_long  TYPE csequence.
ENDCLASS.

CLASS ltcl_cunit IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zosd_h5x_uoma.
    unit( iv_langu = 'E'
          iv_msehi = 'ZZ1'
          iv_mseh3 = '"'
          iv_short = 'twin'
          iv_long  = 'Twin unit' ).
    unit( iv_langu = 'D'
          iv_msehi = 'ZZ1'
          iv_mseh3 = 'ZO'
          iv_short = 'zw'
          iv_long  = 'Zwillingseinheit' ).
    unit( iv_langu = 'E'
          iv_msehi = 'G'
          iv_mseh3 = 'G'
          iv_short = 'g'
          iv_long  = 'Gram' ).
    zcl_osd_cunit=>text_table( 'ZOSD_H5X_UOMA' ).
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_cunit=>text_table( ).
  ENDMETHOD.

  METHOD unit.
    DATA ls_row TYPE zosd_h5x_uoma.

    ls_row-client = sy-mandt.
    ls_row-spras = iv_langu.
    ls_row-msehi = iv_msehi.
    ls_row-mseh3 = iv_mseh3.
    ls_row-mseht = iv_short.
    ls_row-msehl = iv_long.
    INSERT zosd_h5x_uoma FROM ls_row.
  ENDMETHOD.

  METHOD output_in_the_language.
    DATA lv_output TYPE c LENGTH 3.
    DATA lv_short  TYPE c LENGTH 10.
    DATA lv_long   TYPE c LENGTH 30.

    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'ZZ1'
        language       = 'E'
      IMPORTING
        output         = lv_output
        short_text     = lv_short
        long_text      = lv_long
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lv_output
                                        exp = '"' ).
    cl_abap_unit_assert=>assert_equals( act = lv_short
                                        exp = 'twin' ).
    cl_abap_unit_assert=>assert_equals( act = lv_long
                                        exp = 'Twin unit' ).
    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'ZZ1'
        language       = 'D'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lv_output
                                        exp = 'ZO' ).
  ENDMETHOD.

  METHOD output_default_is_sy_langu.
    DATA lv_output TYPE c LENGTH 3.
    DATA lv_langu  TYPE sy-langu.

    lv_langu = zcl_osd_session_langu=>switch( 'D' ).
    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'ZZ1'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    zcl_osd_session_langu=>switch( lv_langu ).
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lv_output
                                        exp = 'ZO' ).
  ENDMETHOD.

  METHOD output_unknown_raises.
* G has no German row; QQQ no row at all
    DATA lv_output TYPE c LENGTH 3.

    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'G'
        language       = 'D'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 1 ).
    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'QQQ'
        language       = 'E'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 1 ).
  ENDMETHOD.

  METHOD input_in_the_language.
    DATA lv_output TYPE c LENGTH 3.

    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_INPUT'
      EXPORTING
        input          = '"'
        language       = 'E'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lv_output
                                        exp = 'ZZ1' ).
    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_INPUT'
      EXPORTING
        input          = 'ZO'
        language       = 'D'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lv_output
                                        exp = 'ZZ1' ).
  ENDMETHOD.

  METHOD input_unknown_raises.
* ZO is the German form: not an English one
    DATA lv_output TYPE c LENGTH 3.

    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_INPUT'
      EXPORTING
        input          = 'ZO'
        language       = 'E'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 1 ).
  ENDMETHOD.

  METHOD input_initial_is_initial.
    DATA lv_output TYPE c LENGTH 3 VALUE 'XYZ'.

    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_INPUT'
      EXPORTING
        input          = ''
        language       = 'E'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_initial( lv_output ).
  ENDMETHOD.

  METHOD no_table_is_not_found.
* a system without the unit text table (the default T006A is not in the
* tree here): not found, no dump
    DATA lv_output TYPE c LENGTH 3.

    zcl_osd_cunit=>text_table( 'ZOSD_H5X_NO_SUCH_TABLE' ).
    CALL FUNCTION 'CONVERSION_EXIT_CUNIT_OUTPUT'
      EXPORTING
        input          = 'ZZ1'
        language       = 'E'
      IMPORTING
        output         = lv_output
      EXCEPTIONS
        unit_not_found = 1
        OTHERS         = 2.
    cl_abap_unit_assert=>assert_subrc( exp = 1 ).
  ENDMETHOD.

ENDCLASS.
