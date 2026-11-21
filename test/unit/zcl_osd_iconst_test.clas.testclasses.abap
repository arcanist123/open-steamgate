CLASS ltcl_iconst DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.
  PRIVATE SECTION.
    METHODS chain_of_three FOR TESTING.
    METHODS read_back FOR TESTING.
    METHODS structured_component FOR TESTING.
    METHODS class_constant_set_at_load FOR TESTING.
    METHODS from_a_component FOR TESTING.
    METHODS class_constant_two_hops FOR TESTING.
ENDCLASS.

CLASS ltcl_iconst IMPLEMENTATION.
  METHOD chain_of_three.
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_a=>from_chain exp = `c` ).
  ENDMETHOD.

  METHOD read_back.
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_b=>back exp = `a` ).
  ENDMETHOD.

  METHOD structured_component.
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_a=>gs_pair-base exp = `c` ).
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_a=>gs_pair-own exp = `pair` ).
  ENDMETHOD.

  METHOD class_constant_set_at_load.
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_a=>from_class exp = 'N' ).
  ENDMETHOD.

  METHOD from_a_component.
    cl_abap_unit_assert=>assert_equals( act = zif_osd_iconst_a=>from_component exp = `two` ).
  ENDMETHOD.

  METHOD class_constant_two_hops.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_iconst_src=>two_hops exp = `c` ).
  ENDMETHOD.
ENDCLASS.
