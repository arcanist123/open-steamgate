CLASS lcl_sub DEFINITION INHERITING FROM zcl_osd_local_sub_owner.
  PUBLIC SECTION.
    METHODS name REDEFINITION.
ENDCLASS.

CLASS lcl_sub IMPLEMENTATION.
  METHOD name.
    DATA lv_count TYPE i.
    count_up( ).
    lv_count = zcl_osd_local_sub_owner=>gv_count.
    rv_name = |sub of { super->name( ) } { lv_count }|.
  ENDMETHOD.
ENDCLASS.
