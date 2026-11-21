CLASS ltcl_local_sub DEFINITION FOR TESTING RISK LEVEL HARMLESS DURATION SHORT FINAL.
  PRIVATE SECTION.
    METHODS local_subclass_of_the_owner FOR TESTING.
    METHODS local_exception_of_the_owner FOR TESTING.
ENDCLASS.

CLASS ltcl_local_sub IMPLEMENTATION.
  METHOD local_subclass_of_the_owner.
    DATA lv_before TYPE i.
    DATA lv_name TYPE string.
    DATA lv_expected TYPE string.
    lv_before = zcl_osd_local_sub_owner=>gv_count.
    lv_name = zcl_osd_local_sub_owner=>make( )->name( ).
    lv_before = lv_before + 1.
    lv_expected = |sub of owner { lv_before }|.
    cl_abap_unit_assert=>assert_equals( act = lv_name exp = lv_expected ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_local_sub_owner=>gv_count exp = lv_before ).
  ENDMETHOD.

  METHOD local_exception_of_the_owner.
    DATA lx_error TYPE REF TO zcx_osd_local_sub_owner.
    DATA lv_origin TYPE string.
    TRY.
        zcx_osd_local_sub_owner=>raise_local( ).
      CATCH zcx_osd_local_sub_owner INTO lx_error.
        lv_origin = lx_error->origin( ).
    ENDTRY.
    cl_abap_unit_assert=>assert_equals( act = lv_origin exp = `local` ).
  ENDMETHOD.
ENDCLASS.
