CLASS ltcl_stablerows DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT.
  PRIVATE SECTION.
    METHODS converted FOR TESTING.
ENDCLASS.
CLASS ltcl_stablerows IMPLEMENTATION.
  METHOD converted.
    cl_abap_unit_assert=>assert_equals( act = zcl_gogen_t_stablerows=>converted( ) exp = `a1b2` ).
  ENDMETHOD.
ENDCLASS.
