CLASS ltcl_key DEFINITION DEFERRED.
CLASS ltcl_stamp DEFINITION DEFERRED.
CLASS ltcl_preliminary DEFINITION DEFERRED.
CLASS zcl_osd_rap_runtime DEFINITION LOCAL FRIENDS ltcl_key ltcl_stamp ltcl_preliminary.

CLASS ltcl_key DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The buffer, the conflict check and the delta all identify an instance by
* its key rendered as text; two different key tuples must never render alike.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_pair,
        first  TYPE c LENGTH 10,
        second TYPE c LENGTH 10,
      END OF ty_pair.
    METHODS separator_inside_a_value FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_key IMPLEMENTATION.

  METHOD separator_inside_a_value.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity  TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field   TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_one     TYPE ty_pair.
    DATA ls_two     TYPE ty_pair.

    CREATE OBJECT lo_runtime.
    ls_field-key = abap_true.
    ls_field-name = 'FIRST'.
    APPEND ls_field TO ls_entity-fields.
    ls_field-name = 'SECOND'.
    APPEND ls_field TO ls_entity-fields.
    ls_one-first = 'A|B'.
    ls_one-second = 'C'.
    ls_two-first = 'A'.
    ls_two-second = 'B|C'.
    cl_abap_unit_assert=>assert_differs(
      act = lo_runtime->key_of( is_entity = ls_entity is_row = ls_one )
      exp = lo_runtime->key_of( is_entity = ls_entity is_row = ls_two ) ).
    ls_two = ls_one.
    cl_abap_unit_assert=>assert_equals(
      act = lo_runtime->key_of( is_entity = ls_entity is_row = ls_one )
      exp = lo_runtime->key_of( is_entity = ls_entity is_row = ls_two ) ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_stamp DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* R4: an administrative time stamp moves forward by the calendar -- never
* to a 60th second -- also where the clock is behind the stored value
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_row,
        id   TYPE c LENGTH 4,
        at   TYPE timestamp,
        at_l TYPE timestampl,
      END OF ty_row.
    METHODS later_carries FOR TESTING RAISING cx_static_check.
    METHODS stamp_at_year_end FOR TESTING RAISING cx_static_check.
    METHODS apart_for_a_double FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_stamp IMPLEMENTATION.

  METHOD later_carries.
    DATA lv_stamp TYPE timestampl.
    lv_stamp = '20261110120000.5'.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_runtime=>later( lv_stamp ) exp = '20261110120000.5000001' ).
    lv_stamp = '20991231235959.9999999'.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_runtime=>later( lv_stamp ) exp = '21000101000000' ).
  ENDMETHOD.

  METHOD apart_for_a_double.
* 100 ns later is a later stamp, but not a different double at this size:
* stored through a seam that writes a DEC as a double, it is the same value
    DATA lv_old   TYPE timestampl.
    DATA lv_new   TYPE timestampl.
    DATA lv_old_f TYPE f.
    DATA lv_new_f TYPE f.
    lv_old = '20261110120000.5'.
    lv_new = zcl_osd_rap_runtime=>apart( iv_stamp = zcl_osd_rap_runtime=>later( lv_old ) iv_old = lv_old ).
    lv_old_f = lv_old.
    lv_new_f = lv_new.
    cl_abap_unit_assert=>assert_differs( act = lv_new_f exp = lv_old_f ).
    cl_abap_unit_assert=>assert_equals( act = boolc( lv_new > lv_old AND lv_new < '20261110120000.51' ) exp = abap_true ).
* a stamp a double already tells apart stays as it is
    lv_new = '20261110120000.51'.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_runtime=>apart( iv_stamp = lv_new iv_old = lv_old ) exp = lv_new ).
* and the step carries into the next second by the calendar
    lv_old = '20261231235959.9999999'.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_runtime=>apart( iv_stamp = lv_old iv_old = lv_old ) exp = '20270101000000' ).
  ENDMETHOD.

  METHOD stamp_at_year_end.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity  TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field   TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_inst    TYPE zcl_osd_rap_runtime=>ty_inst.
    DATA lr_row     TYPE REF TO ty_row.
    DATA lv_saved   TYPE timestampl.

    CREATE OBJECT lo_runtime.
    ls_field-name = 'AT'.
    ls_field-admin = 'CHANGED_AT'.
    APPEND ls_field TO ls_entity-fields.
    ls_field-name = 'AT_L'.
    ls_field-admin = 'LOCAL_CHANGED_AT'.
    APPEND ls_field TO ls_entity-fields.
    CREATE DATA lr_row.
    lr_row->at = '20991231235959'.
    lr_row->at_l = '20991231235959.9999999'.
    ls_inst-row = lr_row.
    APPEND ls_inst TO lo_runtime->mt_inst.
    lv_saved = zcl_osd_rap_runtime=>gv_stamp.
    lo_runtime->stamp( is_entity = ls_entity iv_index = 1 iv_create = abap_false ).
* the last stamp given is process-wide: left at 2100 it would carry every
* later stamp of this process past the year 2100 (found by R10's flight
* draft tests running after this one, "Invalid time value")
    zcl_osd_rap_runtime=>gv_stamp = lv_saved.
    cl_abap_unit_assert=>assert_equals( act = lr_row->at exp = '21000101000000' ).
    cl_abap_unit_assert=>assert_equals( act = lr_row->at_l exp = '21000101000000' ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_preliminary DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* R10 (#917 follow-up): the preliminary range is the top 1000 values of the
* key's type. A CHAR key may hold letters, and a letter sorts after every
* digit: only a value of digits alone can be in the range
  PRIVATE SECTION.
    METHODS numc_range FOR TESTING RAISING cx_static_check.
    METHODS char_digits_only FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_preliminary IMPLEMENTATION.

  METHOD numc_range.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_numc    TYPE n LENGTH 6.

    CREATE OBJECT lo_runtime.
    lv_numc = '999999'.
    cl_abap_unit_assert=>assert_true( lo_runtime->preliminary( lv_numc ) ).
    lv_numc = '999000'.
    cl_abap_unit_assert=>assert_true( lo_runtime->preliminary( lv_numc ) ).
    lv_numc = '998999'.
    cl_abap_unit_assert=>assert_false( lo_runtime->preliminary( lv_numc ) ).
  ENDMETHOD.

  METHOD char_digits_only.
    DATA lo_runtime TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_char    TYPE c LENGTH 6.

    CREATE OBJECT lo_runtime.
    lv_char = '999500'.
    cl_abap_unit_assert=>assert_true( act = lo_runtime->preliminary( lv_char ) msg = 'digits in the range' ).
    lv_char = '998999'.
    cl_abap_unit_assert=>assert_false( act = lo_runtime->preliminary( lv_char ) msg = 'digits below the range' ).
    lv_char = 'ZZZZZZ'.
    cl_abap_unit_assert=>assert_false( act = lo_runtime->preliminary( lv_char ) msg = 'letters sort after 999000' ).
    lv_char = 'A99999'.
    cl_abap_unit_assert=>assert_false( act = lo_runtime->preliminary( lv_char ) msg = 'one letter is enough' ).
    lv_char = '9999X9'.
    cl_abap_unit_assert=>assert_false( act = lo_runtime->preliminary( lv_char ) msg = 'a letter inside' ).
  ENDMETHOD.

ENDCLASS.
