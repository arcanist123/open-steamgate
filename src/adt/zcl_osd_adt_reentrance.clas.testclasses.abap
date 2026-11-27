CLASS ltcl_reentrance DEFINITION FINAL FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS grammar FOR TESTING.
    METHODS query FOR TESTING.
    METHODS accept FOR TESTING.
    METHODS escaping FOR TESTING.
    METHODS clock FOR TESTING.
    METHODS subtract_precision FOR TESTING.
ENDCLASS.
CLASS ltcl_reentrance IMPLEMENTATION.
  METHOD grammar.
    DATA lv_url TYPE string.
    DATA lv_error TYPE string.
    zcl_osd_adt_reentrance=>target( EXPORTING iv_target = `HTTP://LOCALHOST:0080`
      IMPORTING ev_url = lv_url ev_error = lv_error ).
    cl_abap_unit_assert=>assert_equals( act = lv_url exp = `http://localhost/` ).
    cl_abap_unit_assert=>assert_initial( lv_error ).
    zcl_osd_adt_reentrance=>target( EXPORTING iv_target = `http://127.1/`
      IMPORTING ev_url = lv_url ev_error = lv_error ).
    cl_abap_unit_assert=>assert_equals( act = lv_error exp = `redirect-url must point at loopback` ).
  ENDMETHOD.
  METHOD query.
    cl_abap_unit_assert=>assert_equals(
      act = zcl_osd_adt_reentrance=>serialize( iv_query = `a=one%20two&&_=old&_=later&flag&reentrance-ticket=old`
        iv_stamp = `1,2` iv_ticket = `ticket` )
      exp = `a=one+two&_=1%2C2&flag=&reentrance-ticket=ticket` ).
  ENDMETHOD.
  METHOD accept.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_reentrance=>negotiate( `text/plain;q=0.5,text/html` ) exp = `text/html` ).
    cl_abap_unit_assert=>assert_initial( zcl_osd_adt_reentrance=>negotiate( `application/json` ) ).
  ENDMETHOD.
  METHOD clock.
    DATA lv_stamp TYPE timestampl VALUE '19700102030405.6789012'.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_reentrance=>unix_ms( lv_stamp ) exp = `97445678` ).
  ENDMETHOD.
  METHOD escaping.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_reentrance=>html( `&<>"'` ) exp = `&amp;&lt;&gt;&quot;&#39;` ).
  ENDMETHOD.
  METHOD subtract_precision.
* cl_abap_tstmp=>subtract keeps the fraction (open-abap-core #1311, as a
* system does), so the difference is read in milliseconds, not in an i
    DATA lv_stamp TYPE timestampl VALUE '20261003123456.9980000'.
    DATA lv_epoch TYPE timestampl VALUE '19700101000000.0000000'.
    DATA lv_diff TYPE tzntstmpl.
    DATA lv_ms TYPE p LENGTH 16 DECIMALS 0.
    DATA lv_missing TYPE i.
    lv_diff = cl_abap_tstmp=>subtract( tstmp1 = lv_stamp tstmp2 = lv_epoch ).
    cl_abap_unit_assert=>assert_equals( act = lv_diff exp = '1791030896.998' ).
    lv_ms = lv_diff * 1000.
    cl_abap_unit_assert=>assert_equals( act = lv_ms exp = '1791030896998' ).
    cl_abap_unit_assert=>assert_equals(
      act = zcl_osd_adt_reentrance=>unix_ms( lv_stamp ) exp = `1791030896998` ).
    GET TIME STAMP FIELD lv_stamp.
    lv_diff = cl_abap_tstmp=>subtract( tstmp1 = lv_stamp tstmp2 = lv_epoch ).
    lv_ms = lv_diff * 1000.
    lv_missing = zcl_osd_adt_reentrance=>unix_ms( lv_stamp ) - lv_ms.
    cl_abap_unit_assert=>assert_true( boolc( lv_missing >= -1 AND lv_missing <= 1 ) ).
  ENDMETHOD.
ENDCLASS.
