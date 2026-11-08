CLASS ltcl_key DEFINITION DEFERRED.
CLASS zcl_osd_rap_runtime DEFINITION LOCAL FRIENDS ltcl_key.

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
