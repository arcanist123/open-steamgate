* Unmeasured: ABAP keyword documentation, conversion rules; a generic value
* moved into int8, f, i, x and xstring (#995).
CLASS zcl_gogen_t_genmove DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES x2 TYPE x LENGTH 2.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS to_int8 IMPORTING value TYPE simple RETURNING VALUE(r) TYPE int8.
    CLASS-METHODS to_f IMPORTING value TYPE simple RETURNING VALUE(r) TYPE f.
    CLASS-METHODS to_i IMPORTING value TYPE simple RETURNING VALUE(r) TYPE i.
    CLASS-METHODS to_xstring IMPORTING value TYPE simple RETURNING VALUE(r) TYPE xstring.
    CLASS-METHODS to_x2 IMPORTING value TYPE simple RETURNING VALUE(r) TYPE x2.
ENDCLASS.
CLASS zcl_gogen_t_genmove IMPLEMENTATION.
  METHOD to_int8.
    r = value.
  ENDMETHOD.
  METHOD to_f.
    r = value.
  ENDMETHOD.
  METHOD to_i.
    r = value.
  ENDMETHOD.
  METHOD to_xstring.
    r = value.
  ENDMETHOD.
  METHOD to_x2.
    r = value.
  ENDMETHOD.
  METHOD run.
    DATA i TYPE i VALUE 7.
    DATA big TYPE int8 VALUE 5000000000.
    DATA small TYPE int8 VALUE 12.
    DATA p TYPE p LENGTH 8 DECIMALS 1 VALUE '2.5'.
    DATA neg TYPE p LENGTH 8 DECIMALS 1 VALUE '-2.5'.
    DATA x3 TYPE x LENGTH 3 VALUE 'ABCDEF'.
    DATA xs TYPE xstring VALUE '01'.
    rv = |{ to_int8( i ) }/{ to_int8( big ) }/{ to_int8( p ) }/{ to_f( i ) }/{ to_f( p ) }/{ to_i( small ) }/{ to_i( neg ) }/{ to_xstring( x3 ) }/{ to_x2( x3 ) }/{ to_x2( xs ) }|.
  ENDMETHOD.
ENDCLASS.
