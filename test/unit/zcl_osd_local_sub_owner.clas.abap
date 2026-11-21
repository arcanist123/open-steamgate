"! A class pool whose locals hold a subclass of the global class itself:
"! CLASS lcl_sub DEFINITION INHERITING FROM zcl_osd_local_sub_owner.
"! Legal ABAP. The generated module of the class and the module of its
"! locals once awaited each other at load time, and a generation holding
"! such a class never finished loading (ANORMALIES
"! local-inherits-owner). The class data, the class constructor and the
"! factory below are what the locals must still see.
CLASS zcl_osd_local_sub_owner DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-DATA gv_count TYPE i READ-ONLY.
    CLASS-METHODS class_constructor.
    CLASS-METHODS make RETURNING VALUE(ro_result) TYPE REF TO zcl_osd_local_sub_owner.
    CLASS-METHODS count_up.
    METHODS name RETURNING VALUE(rv_name) TYPE string.
ENDCLASS.

CLASS zcl_osd_local_sub_owner IMPLEMENTATION.
  METHOD class_constructor.
    gv_count = 10.
  ENDMETHOD.

  METHOD make.
    CREATE OBJECT ro_result TYPE lcl_sub.
  ENDMETHOD.

  METHOD count_up.
    gv_count = gv_count + 1.
  ENDMETHOD.

  METHOD name.
    rv_name = `owner`.
  ENDMETHOD.
ENDCLASS.
