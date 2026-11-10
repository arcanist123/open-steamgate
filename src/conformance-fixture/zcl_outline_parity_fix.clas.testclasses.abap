*"* Synthetic ABAP unit tests

CLASS ltcl_probe DEFINITION FINAL FOR TESTING
  RISK LEVEL HARMLESS
  DURATION SHORT.

  PRIVATE SECTION.
    METHODS first_test FOR TESTING.

    METHODS second_test FOR TESTING.
ENDCLASS.


CLASS ltcl_probe IMPLEMENTATION.

  METHOD first_test.
    cl_abap_unit_assert=>assert_equals( act = zcl_outline_parity_fix=>twice( 2 ) exp = 4 ).
  ENDMETHOD.


  METHOD second_test.
    DATA lo_cut TYPE REF TO zcl_outline_parity_fix.
    CREATE OBJECT lo_cut.
    cl_abap_unit_assert=>assert_equals( act = lo_cut->greet( `x` ) exp = `Hello x` ).
  ENDMETHOD.
ENDCLASS.
