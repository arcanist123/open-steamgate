CLASS zcl_osd_m4g_gap DEFINITION PUBLIC FINAL CREATE PUBLIC.
* Two stubs the way tools/hana-closure-stubs.mjs writes them, for the
* host's stub trace (milestone 4): a method whose body is the raise, and a
* class constructor that only signals -- it runs when the generation loads,
* so every host prints its line once at start; the text says it is this
* fixture and not a missing object.
  PUBLIC SECTION.
    CLASS-METHODS class_constructor.
    CLASS-METHODS not_here
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_m4g_gap IMPLEMENTATION.

  METHOD class_constructor.
    zcx_osd_not_activated=>signal( 'ZOSD_M4G_LOAD_GAP (test fixture, test/hana-m4)' ).
  ENDMETHOD.

  METHOD not_here.
    RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_M4G_REQUEST_GAP'.
  ENDMETHOD.

ENDCLASS.
