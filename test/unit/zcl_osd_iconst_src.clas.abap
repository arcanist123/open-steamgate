"! A class constant the class sets in its class constructor, the way a
"! kernel class sets cl_abap_char_utilities=>newline: an interface constant
"! from it must read it at load, after this class has loaded.
CLASS zcl_osd_iconst_src DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS marker TYPE c LENGTH 1 VALUE '_'.
    "! two interfaces away from its value: abaplint leaves it without one
    CONSTANTS two_hops TYPE string VALUE zif_osd_iconst_a=>from_chain.
    CLASS-METHODS class_constructor.
ENDCLASS.

CLASS zcl_osd_iconst_src IMPLEMENTATION.
  METHOD class_constructor.
    WRITE '@KERNEL zcl_osd_iconst_src.marker.set("N");'.
  ENDMETHOD.
ENDCLASS.
