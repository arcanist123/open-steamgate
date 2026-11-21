CLASS ltcl_decide DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* R11: the conditions the SADL data provider and the RAP runtime write
* (`NAME = 'v'`, joined by AND) on a view with the constant ID = 1
  PRIVATE SECTION.
    DATA mt_const TYPE zcl_stg_cds_const=>tt_const.
    METHODS setup.
    METHODS equal_is_dropped FOR TESTING RAISING cx_static_check.
    METHODS different_is_no_row FOR TESTING RAISING cx_static_check.
    METHODS others_stay FOR TESTING RAISING cx_static_check.
    METHODS other_forms_refused FOR TESTING RAISING cx_static_check.
    METHODS fills_a_row FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_decide IMPLEMENTATION.

  METHOD setup.
    DATA ls_const TYPE zcl_stg_cds_const=>ty_const.
    ls_const-name = 'CARRIERSINGLETONID'.
    ls_const-value = '1'.
    APPEND ls_const TO mt_const.
  ENDMETHOD.

  METHOD equal_is_dropped.
    DATA lv_where TYPE string.
    lv_where = `CARRIERSINGLETONID = '1'`.
    cl_abap_unit_assert=>assert_true( zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ) ).
    cl_abap_unit_assert=>assert_initial( lv_where ).
    lv_where = `1 = carriersingletonid`.
    cl_abap_unit_assert=>assert_true( zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ) ).
    lv_where = `CarrierSingletonID = '01'`.
    cl_abap_unit_assert=>assert_true( act = zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ) msg = 'a number compares as a number' ).
  ENDMETHOD.

  METHOD different_is_no_row.
    DATA lv_where TYPE string.
    lv_where = `CARRIERSINGLETONID = '2' AND NAME = 'X'`.
    cl_abap_unit_assert=>assert_false( zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ) ).
  ENDMETHOD.

  METHOD others_stay.
    DATA lv_where TYPE string.
    lv_where = `AIRLINEID = 'AA' AND CARRIERSINGLETONID = '1' AND NAME = 'x AND y'`.
    cl_abap_unit_assert=>assert_true( zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ) ).
    cl_abap_unit_assert=>assert_equals( act = lv_where exp = `AIRLINEID = 'AA' AND NAME = 'x AND y'` ).
  ENDMETHOD.

  METHOD other_forms_refused.
    DATA lv_where TYPE string.
    DATA lv_refused TYPE abap_bool.
    lv_where = `( CARRIERSINGLETONID = '1' OR NAME = 'X' )`.
    TRY.
        zcl_stg_cds_const=>decide( EXPORTING it_const = mt_const CHANGING cv_where = lv_where ).
      CATCH cx_root.
        lv_refused = abap_true.
    ENDTRY.
    cl_abap_unit_assert=>assert_true( act = lv_refused msg = 'inside OR: not decided here' ).
  ENDMETHOD.

  METHOD fills_a_row.
    TYPES: BEGIN OF ty_row,
             airlineid          TYPE c LENGTH 3,
             carriersingletonid TYPE int1,
           END OF ty_row.
    DATA ls_row TYPE ty_row.
    zcl_stg_cds_const=>fill( EXPORTING it_const = mt_const CHANGING cs_row = ls_row ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-carriersingletonid exp = 1 ).
  ENDMETHOD.

ENDCLASS.
