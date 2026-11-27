* the console the ADT class run writes to: every write is kept as a line
CLASS lcl_out DEFINITION.
  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun_out.
    DATA mt_lines TYPE string_table.
ENDCLASS.

CLASS lcl_out IMPLEMENTATION.

  METHOD if_oo_adt_classrun_out~write.
    DATA lv_line TYPE string.
    lv_line = if_oo_adt_classrun_out~get( data = data name = name ).
    APPEND lv_line TO mt_lines.
    output = me.
  ENDMETHOD.

  METHOD if_oo_adt_classrun_out~get.
    DATA lo_type TYPE REF TO cl_abap_typedescr.
    lo_type = cl_abap_typedescr=>describe_by_data( data ).
    IF lo_type->kind = cl_abap_typedescr=>kind_elem.
      output = |{ data }|.
    ELSE.
      output = |<{ lo_type->absolute_name }>|.
    ENDIF.
    IF name IS NOT INITIAL.
      output = |{ name }: { output }|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
