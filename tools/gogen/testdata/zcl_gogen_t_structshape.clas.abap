CLASS zcl_gogen_t_structshape DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
* #1012: structures with the same component names and other component
* types are structures of their own. Every pair below shares its names.
    TYPES: BEGIN OF ty_s, a TYPE i, b TYPE c LENGTH 5, END OF ty_s.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    METHODS who RETURNING VALUE(rv) TYPE string.
  PRIVATE SECTION.
* the other way round: one technical type under two type names is ONE type
    TYPES ty_int TYPE i.
    TYPES ty_c4a TYPE c LENGTH 4.
    TYPES ty_c4b TYPE c LENGTH 4.
    TYPES ty_ra TYPE RANGE OF ty_c4a.
    TYPES ty_rb TYPE RANGE OF ty_c4b.
    CLASS-METHODS fill CHANGING ct TYPE ty_rb.
    CLASS-METHODS alias_changing RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS alias_loop RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS alias_anon RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS char5 RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS str RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS str_first RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS int_second RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS char2 RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS char10 RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS dec2 RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS dec0 RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS nested RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS flat RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS int_rows RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS str_rows RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS ref_cx RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS ref_self RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS named_c RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS named_s RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS of_class RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS of_method RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS order_ab RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS order_ba RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_structshape IMPLEMENTATION.
  METHOD run.
    rv = |{ char5( ) }/{ str( ) } { str_first( ) }/{ int_second( ) } { char2( ) }/{ char10( ) } { dec2( ) }/{ dec0( ) }|.
    rv = |{ rv } { nested( ) }/{ flat( ) } { int_rows( ) }/{ str_rows( ) } { ref_cx( ) }/{ ref_self( ) }|.
    rv = |{ rv } { named_c( ) }/{ named_s( ) } { of_class( ) }/{ of_method( ) } { order_ab( ) }/{ order_ba( ) }|.
    rv = |{ rv } { alias_changing( ) }/{ alias_loop( ) }/{ alias_anon( ) }|.
  ENDMETHOD.
  METHOD who.
    rv = `self`.
  ENDMETHOD.
* the reported case: c LENGTH 5 and string
  METHOD char5.
    DATA: BEGIN OF ls, a TYPE i, b TYPE c LENGTH 5, END OF ls.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
  METHOD str.
    DATA: BEGIN OF ls, a TYPE i, b TYPE string, END OF ls.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
* string and i: the i is calculated with
  METHOD str_first.
    DATA: BEGIN OF ls, n TYPE i, v TYPE string, END OF ls.
    ls-v = `7`.
    CONCATENATE ls-v `1` INTO ls-v.
    rv = ls-v.
  ENDMETHOD.
  METHOD int_second.
    DATA: BEGIN OF ls, n TYPE i, v TYPE i, END OF ls.
    ls-v = 7.
    ls-v = ls-v + 1.
    rv = |{ ls-v }|.
  ENDMETHOD.
* two lengths of c
  METHOD char2.
    DATA: BEGIN OF ls, k TYPE i, t TYPE c LENGTH 2, END OF ls.
    ls-t = `abcdefghij`.
    rv = |{ ls-t }|.
  ENDMETHOD.
  METHOD char10.
    DATA: BEGIN OF ls, k TYPE i, t TYPE c LENGTH 10, END OF ls.
    ls-t = `abcdefghij`.
    rv = |{ ls-t }|.
  ENDMETHOD.
* two numbers of decimals
  METHOD dec2.
    DATA: BEGIN OF ls, k TYPE i, amount TYPE p LENGTH 8 DECIMALS 2, END OF ls.
    ls-amount = `1.75`.
    rv = |{ ls-amount }|.
  ENDMETHOD.
  METHOD dec0.
    DATA: BEGIN OF ls, k TYPE i, amount TYPE p LENGTH 8 DECIMALS 0, END OF ls.
    ls-amount = `1.75`.
    rv = |{ ls-amount }|.
  ENDMETHOD.
* a nested structure and an elementary component
  METHOD nested.
    DATA: BEGIN OF ls, k TYPE i, BEGIN OF sub, x TYPE i, END OF sub, END OF ls.
    ls-sub-x = 3.
    rv = |{ ls-sub-x }|.
  ENDMETHOD.
  METHOD flat.
    DATA: BEGIN OF ls, k TYPE i, sub TYPE i, END OF ls.
    ls-sub = 4.
    rv = |{ ls-sub }|.
  ENDMETHOD.
* two row types
  METHOD int_rows.
    DATA: BEGIN OF ls, k TYPE i, rows TYPE STANDARD TABLE OF i WITH DEFAULT KEY, END OF ls.
    DATA n TYPE i.
    APPEND 5 TO ls-rows.
    READ TABLE ls-rows INDEX 1 INTO n.
    n = n + 1.
    rv = |{ n }|.
  ENDMETHOD.
  METHOD str_rows.
    DATA: BEGIN OF ls, k TYPE i, rows TYPE STANDARD TABLE OF string WITH DEFAULT KEY, END OF ls.
    DATA s TYPE string.
    APPEND `5` TO ls-rows.
    READ TABLE ls-rows INDEX 1 INTO s.
    CONCATENATE s `1` INTO s.
    rv = s.
  ENDMETHOD.
* references to two classes
  METHOD ref_cx.
    DATA: BEGIN OF ls, k TYPE i, obj TYPE REF TO cx_sy_zerodivide, END OF ls.
    CREATE OBJECT ls-obj.
    IF ls-obj IS BOUND.
      rv = `cx`.
    ENDIF.
  ENDMETHOD.
  METHOD ref_self.
    DATA: BEGIN OF ls, k TYPE i, obj TYPE REF TO zcl_gogen_t_structshape, END OF ls.
    CREATE OBJECT ls-obj.
    rv = ls-obj->who( ).
  ENDMETHOD.
* one type name in two methods
  METHOD named_c.
    TYPES: BEGIN OF ty_local, a TYPE i, b TYPE c LENGTH 5, END OF ty_local.
    DATA ls TYPE ty_local.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
  METHOD named_s.
    TYPES: BEGIN OF ty_local, a TYPE i, b TYPE string, END OF ty_local.
    DATA ls TYPE ty_local.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
* a type of the class and a type of a method with its name
  METHOD of_class.
    DATA ls TYPE ty_s.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
  METHOD of_method.
    TYPES: BEGIN OF ty_s, a TYPE i, b TYPE string, END OF ty_s.
    DATA ls TYPE ty_s.
    ls-b = `hello world`.
    rv = |{ strlen( ls-b ) }|.
  ENDMETHOD.
* the same components in another order were two types before, and stay two
  METHOD order_ab.
    DATA: BEGIN OF ls, p TYPE i, q TYPE string, END OF ls.
    ls-p = 1.
    ls-q = `x`.
    rv = |{ ls-p }{ ls-q }|.
  ENDMETHOD.
  METHOD order_ba.
    DATA: BEGIN OF ls, q TYPE string, p TYPE i, END OF ls.
    ls-p = 2.
    ls-q = `y`.
    rv = |{ ls-p }{ ls-q }|.
  ENDMETHOD.
* the names of the component types differ, the types do not: the rows of
* the two ranges are one type, passed by reference and looped into
  METHOD fill.
    DATA ls LIKE LINE OF ct.
    ls-low = 'ABCD'.
    APPEND ls TO ct.
  ENDMETHOD.
  METHOD alias_changing.
    DATA lt_a TYPE ty_ra.
    DATA ls_a LIKE LINE OF lt_a.
    fill( CHANGING ct = lt_a ).
    READ TABLE lt_a INDEX 1 INTO ls_a.
    rv = ls_a-low.
  ENDMETHOD.
  METHOD alias_loop.
    DATA lt_a TYPE ty_ra.
    DATA lt_b TYPE ty_rb.
    DATA ls_a LIKE LINE OF lt_a.
    DATA ls_b LIKE LINE OF lt_b.
    ls_a-low = 'S900'.
    APPEND ls_a TO lt_a.
    LOOP AT lt_a INTO ls_b.
      rv = ls_b-low.
    ENDLOOP.
  ENDMETHOD.
  METHOD alias_anon.
    DATA: BEGIN OF ls3, z TYPE i, END OF ls3.
    DATA: BEGIN OF ls4, z TYPE ty_int, END OF ls4.
    ls4-z = 6.
    ls3 = ls4.
    rv = |{ ls3-z }|.
  ENDMETHOD.
ENDCLASS.
