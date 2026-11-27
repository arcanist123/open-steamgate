"! A global exception class whose locals hold a subclass of itself, the
"! shape an exception root class of a dependency package has (ANORMALIES
"! local-inherits-owner). RAISE_LOCAL raises the local subclass.
CLASS zcx_osd_local_sub_owner DEFINITION PUBLIC INHERITING FROM cx_static_check CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS raise_local RAISING zcx_osd_local_sub_owner.
    METHODS origin RETURNING VALUE(rv_origin) TYPE string.
ENDCLASS.

CLASS zcx_osd_local_sub_owner IMPLEMENTATION.
  METHOD raise_local.
    RAISE EXCEPTION TYPE lcx_local.
  ENDMETHOD.

  METHOD origin.
    rv_origin = `global`.
  ENDMETHOD.
ENDCLASS.
