CLASS lcx_local DEFINITION INHERITING FROM zcx_osd_local_sub_owner.
  PUBLIC SECTION.
    METHODS origin REDEFINITION.
ENDCLASS.

CLASS lcx_local IMPLEMENTATION.
  METHOD origin.
    rv_origin = `local`.
  ENDMETHOD.
ENDCLASS.
