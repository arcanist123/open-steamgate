"! Outline coordinate fixture
CLASS zcl_outline_parity_fix DEFINITION
  PUBLIC
  CREATE PUBLIC.

  PUBLIC SECTION.
    INTERFACES if_oo_adt_classrun.

    ALIASES run FOR if_oo_adt_classrun~main.

    " an instance method
    METHODS greet
      IMPORTING iv_name        TYPE string
      RETURNING VALUE(rv_text) TYPE string.

    "! a static method
    CLASS-METHODS twice
      IMPORTING iv_value        TYPE i
      RETURNING VALUE(rv_value) TYPE i.

    " a long signature over several lines
    METHODS long_signature
      IMPORTING
        iv_first  TYPE string
        iv_second TYPE i DEFAULT 0
        it_lines  TYPE string_table OPTIONAL
      EXPORTING
        ev_count  TYPE i
      CHANGING
        cv_state  TYPE string.

  PROTECTED SECTION.

    METHODS prot_helper
      RETURNING VALUE(rv_n) TYPE i.

  PRIVATE SECTION.
    DATA mv_count TYPE i.

    " a private method
    METHODS priv_helper
      IMPORTING iv_n TYPE i.
ENDCLASS.



CLASS zcl_outline_parity_fix IMPLEMENTATION.

  METHOD if_oo_adt_classrun~main.
    out->write( greet( `world` ) ).
  ENDMETHOD.



  METHOD greet.
    " greet says hello
    rv_text = |Hello { iv_name }|.
  ENDMETHOD.

  METHOD twice.
    rv_value = lcl_helper=>double( iv_value ).
  ENDMETHOD.


  METHOD long_signature.
* a star comment inside the long one
    DATA lv_line TYPE string.
    ev_count = lines( it_lines ).
    LOOP AT it_lines INTO lv_line.
      cv_state = cv_state && lv_line.
    ENDLOOP.
    cv_state = cv_state && iv_first && iv_second.
  ENDMETHOD.



  METHOD prot_helper.
    rv_n = mv_count.
  ENDMETHOD.

  METHOD priv_helper.
    mv_count = mv_count + iv_n.
  ENDMETHOD.
ENDCLASS.
