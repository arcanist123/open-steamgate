CLASS zcl_stg_json_text DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The text of a JSON string, without its quotes: the built-in
* escape( format = cl_abap_format=>e_json_string ). zcl_stg_json cannot call
* the built-in itself, since its own method ESCAPE hides it inside the class,
* and a local class is not compiled by every host (osgo compiles the locals
* of a named few only), so the call lives in a global class of its own.
  PUBLIC SECTION.
    CLASS-METHODS escape_string
      IMPORTING
        iv_text        TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_stg_json_text IMPLEMENTATION.

  METHOD escape_string.
    rv_text = escape( val = iv_text format = cl_abap_format=>e_json_string ).
  ENDMETHOD.

ENDCLASS.
