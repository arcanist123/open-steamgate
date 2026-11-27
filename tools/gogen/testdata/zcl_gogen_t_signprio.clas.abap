* A sign in front of an operand (#989). The rule is the ABAP keyword
* documentation's, "Arithmetic Expressions (arith_exp)": the effect of a
* sign is that of -1 * in its place, so it has the priority of a
* multiplication: - a + b is ( - a ) + b, - a MOD b is ( - a ) MOD b and
* - a ** 2 is - ( a ** 2 ). Node (transpiler 2.14.41) answers the same on
* every case here; none of them is measured on a system.
CLASS zcl_gogen_t_signprio DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS ints RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS chains RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS types RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS places RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS powers RETURNING VALUE(rv) TYPE string.
    CLASS-METHODS echo IMPORTING iv TYPE i RETURNING VALUE(rv) TYPE i.
ENDCLASS.

CLASS zcl_gogen_t_signprio IMPLEMENTATION.
  METHOD echo.
    rv = iv.
  ENDMETHOD.

  METHOD ints.
    DATA a TYPE i VALUE 7.
    DATA b TYPE i VALUE 2.
    DATA r TYPE i.
    r = - a + b.
    rv = |add:{ r }|.
    r = - a - b.
    rv = rv && |,{ r }|.
    r = - a - 1.
    rv = rv && |,{ r }|.
    r = - a * b.
    rv = rv && | mul:{ r }|.
    r = - a / b.
    rv = rv && |,{ r }|.
    r = - a DIV b.
    rv = rv && |,{ r }|.
    r = - a MOD b.
    rv = rv && |,{ r }|.
    r = + a + b.
    rv = rv && | plus:{ r }|.
    r = + a - b.
    rv = rv && |,{ r }|.
    r = - ( a + b ).
    rv = rv && | paren:{ r }|.
    r = - ( a + b ) + 1.
    rv = rv && |,{ r }|.
    r = - ( a ) MOD b.
    rv = rv && |,{ r }|.
    r = -1 + b.
    rv = rv && | lit:{ r }|.
    r = - 1 + b.
    rv = rv && |,{ r }|.
    r = - 7 MOD 2.
    rv = rv && |,{ r }|.
    r = -7 MOD 2.
    rv = rv && |,{ r }|.
  ENDMETHOD.

  METHOD chains.
    DATA a TYPE i VALUE 7.
    DATA b TYPE i VALUE 2.
    DATA r TYPE i.
    r = - a + b + 1.
    rv = |three:{ r }|.
    r = - a - b - 1.
    rv = rv && |,{ r }|.
    r = - a MOD b + 1.
    rv = rv && |,{ r }|.
    r = - a MOD b MOD 3.
    rv = rv && |,{ r }|.
    r = - a * b + 1.
    rv = rv && |,{ r }|.
    r = - a + b * 3.
    rv = rv && |,{ r }|.
    r = - a DIV b * 3 - 1.
    rv = rv && |,{ r }|.
    r = a - - b.
    rv = rv && | inner:{ r }|.
    r = a + - b.
    rv = rv && |,{ r }|.
    r = a - - b + 1.
    rv = rv && |,{ r }|.
    r = b * - a + 1.
    rv = rv && |,{ r }|.
    r = a MOD - b.
    rv = rv && |,{ r }|.
    r = b - - a MOD b.
    rv = rv && |,{ r }|.
    r = - a - - a MOD b.
    rv = rv && |,{ r }|.
  ENDMETHOD.

  METHOD types.
    CONSTANTS lc_seven TYPE i VALUE 7.
    DATA b TYPE i VALUE 2.
    DATA r TYPE i.
    DATA p TYPE p LENGTH 8 DECIMALS 2 VALUE '7.25'.
    DATA q TYPE p LENGTH 8 DECIMALS 2 VALUE '2.50'.
    DATA rp TYPE p LENGTH 8 DECIMALS 2.
    DATA f TYPE f VALUE '7.5'.
    DATA rf TYPE f.
    DATA zero TYPE int8 VALUE 0.
    DATA big TYPE int8 VALUE 9000000000.
    DATA r8 TYPE int8.
    DATA s TYPE string VALUE `7`.
    DATA c TYPE c LENGTH 3 VALUE '7'.
    rp = - p + q.
    rv = |p:{ rp }|.
    rp = - p - q.
    rv = rv && |,{ rp }|.
    rp = - p / q.
    rv = rv && |,{ rp }|.
    rp = - p MOD q.
    rv = rv && |,{ rp }|.
    rp = - p + b.
    rv = rv && |,{ rp }|.
    rf = - f + b.
    rv = rv && | f:{ rf DECIMALS = 2 }|.
    rf = - f - b.
    rv = rv && |,{ rf DECIMALS = 2 }|.
    r8 = - zero - 1.
    rv = rv && | i8:{ r8 }|.
    r8 = - big + b.
    rv = rv && |,{ r8 }|.
    r8 = - big MOD b - 1.
    rv = rv && |,{ r8 }|.
    r8 = - big MOD 7.
    rv = rv && |,{ r8 }|.
    r = - s + b.
    rv = rv && | s:{ r }|.
    r = - s MOD b.
    rv = rv && |,{ r }|.
    r = - c + b.
    rv = rv && |,{ r }|.
    r = - lc_seven + b.
    rv = rv && | const:{ r }|.
    r = - lc_seven MOD 2.
    rv = rv && |,{ r }|.
    r = - b + lc_seven.
    rv = rv && |,{ r }|.
  ENDMETHOD.

  METHOD places.
    DATA a TYPE i VALUE 7.
    DATA b TYPE i VALUE 2.
    DATA r TYPE i.
    DATA lt TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
    IF - a + b = -5.
      rv = |if:y|.
    ELSE.
      rv = |if:n|.
    ENDIF.
    IF -5 = - a + b AND - a MOD b > 0.
      rv = rv && |,y|.
    ELSE.
      rv = rv && |,n|.
    ENDIF.
    WHILE - a + b < -4 AND r < 3.
      r = r + 1.
    ENDWHILE.
    rv = rv && |,{ r }|.
    r = echo( - a + b ).
    rv = rv && | arg:{ r }|.
    r = echo( iv = - a MOD b ).
    rv = rv && |,{ r }|.
    rv = rv && | tmpl:{ - a + b },{ - a MOD b }|.
    r = 1.
    r = r - a + b.
    rv = rv && | plain:{ r }|.
    APPEND - a + b TO lt.
    READ TABLE lt INDEX 1 INTO r.
    rv = rv && | append:{ r }|.
    r = abs( - a + b ).
    rv = rv && | fn:{ r }|.
    r = COND #( WHEN - a + b < 0 THEN - a - b ELSE 0 ).
    rv = rv && | cond:{ r }|.
  ENDMETHOD.

  METHOD powers.
    DATA a TYPE i VALUE 7.
    DATA b TYPE i VALUE 2.
    DATA r TYPE i.
    r = - a ** 2.
    rv = |pow:{ r }|.
    r = - a ** 2 + 1.
    rv = rv && |,{ r }|.
    r = - b ** 2 * 3.
    rv = rv && |,{ r }|.
    r = ( - a ) ** 2.
    rv = rv && |,{ r }|.
  ENDMETHOD.

  METHOD run.
    rv = |{ ints( ) } { chains( ) } { types( ) } { places( ) } { powers( ) }|.
  ENDMETHOD.
ENDCLASS.
