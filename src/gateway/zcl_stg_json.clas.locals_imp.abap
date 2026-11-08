* The built-in escape( ) is hidden inside zcl_stg_json by its own method of
* that name, so the call lives here, outside the class's scope.
CLASS lcl_json_string DEFINITION FINAL.
  PUBLIC SECTION.
    CLASS-METHODS escape_text
      IMPORTING
        iv_text        TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS lcl_json_string IMPLEMENTATION.
  METHOD escape_text.
    rv_text = escape( val = iv_text format = cl_abap_format=>e_json_string ).
  ENDMETHOD.
ENDCLASS.
