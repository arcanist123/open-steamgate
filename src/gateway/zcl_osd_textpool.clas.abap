CLASS zcl_osd_textpool DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The text pools of the classes and programs of this tree, read from the
* registry tools/osd-textpool-registry.mjs writes at build time out of the
* <TPOOL> abapGit serializes: the transpiler carries no text pool (READ
* TEXTPOOL is a transpiler todo, ANORMALIES.md). What a Gateway model asks
* through set_label_from_text_element is answered here, in the session
* language and in no other: a symbol without a text in that language has
* no text (measured: a SEGW sample's labels from its text pool disappear
* under sap-language=DE, where the pool has no German).
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_text,
             langu TYPE c LENGTH 1,
             id    TYPE c LENGTH 1,
             key   TYPE string,
             entry TYPE string,
           END OF ty_text.
    TYPES ty_pool TYPE STANDARD TABLE OF ty_text WITH DEFAULT KEY.

* the program a text element container names: a class pool
* ('<class>====...CP', the class name padded with '=' to 30, then CP) is
* its class, anything else the program itself
    CLASS-METHODS program_of
      IMPORTING
        iv_container      TYPE csequence
      RETURNING
        VALUE(rv_program) TYPE string.
* the text symbol (ID I) of the container in the language, '' when none
    CLASS-METHODS text_symbol
      IMPORTING
        iv_container   TYPE csequence
        iv_symbol      TYPE csequence
        iv_langu       TYPE sy-langu DEFAULT sy-langu
      RETURNING
        VALUE(rv_text) TYPE string.
* READ TEXTPOOL iv_program LANGUAGE iv_langu: the rows of one language
    CLASS-METHODS read
      IMPORTING
        iv_program     TYPE csequence
        iv_langu       TYPE sy-langu DEFAULT sy-langu
      RETURNING
        VALUE(rt_pool) TYPE ty_pool.
ENDCLASS.

CLASS zcl_osd_textpool IMPLEMENTATION.

  METHOD program_of.
    DATA lv_length TYPE i.

    rv_program = to_upper( condense( iv_container ) ).
    lv_length = strlen( rv_program ).
    IF lv_length = 32 AND rv_program+30(2) = 'CP' AND rv_program CS '='.
      rv_program = rv_program(30).
      WHILE rv_program IS NOT INITIAL AND substring( val = rv_program off = strlen( rv_program ) - 1 len = 1 ) = '='.
        rv_program = substring( val = rv_program len = strlen( rv_program ) - 1 ).
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD text_symbol.
    DATA lt_pool TYPE ty_pool.
    DATA ls_text LIKE LINE OF lt_pool.
    DATA lv_key  TYPE string.

    lv_key = condense( iv_symbol ).
    lt_pool = read( iv_program = program_of( iv_container )
                    iv_langu   = iv_langu ).
    LOOP AT lt_pool INTO ls_text WHERE id = 'I'.
      IF ls_text-key = lv_key.
        rv_text = ls_text-entry.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD read.
    DATA lt_all  TYPE ty_pool.
    DATA ls_text LIKE LINE OF lt_all.

    lt_all = zcl_osd_textpool_registry=>pool( to_upper( iv_program ) ).
    LOOP AT lt_all INTO ls_text WHERE langu = iv_langu.
      APPEND ls_text TO rt_pool.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
