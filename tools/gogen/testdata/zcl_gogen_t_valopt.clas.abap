* Unmeasured: ABAP keyword documentation, VALUE with a table expression and
* OPTIONAL or DEFAULT (#996).
CLASS zcl_gogen_t_valopt DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF row,
             key   TYPE string,
             value TYPE i,
             ref   TYPE REF TO zcl_gogen_t_valopt,
           END OF row.
    TYPES rows TYPE STANDARD TABLE OF row WITH EMPTY KEY.
    DATA name TYPE string.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_valopt IMPLEMENTATION.
  METHOD run.
    DATA(fallback) = NEW zcl_gogen_t_valopt( ).
    fallback->name = `fallback`.
    DATA(other) = NEW zcl_gogen_t_valopt( ).
    other->name = `other`.
    DATA(t) = VALUE rows( ( key = `a` value = 1 ref = other ) ( key = `b` value = 2 ) ).
    DATA(found) = VALUE #( t[ key = `a` ] OPTIONAL ).
    DATA(missing) = VALUE #( t[ key = `x` ] OPTIONAL ).
    DATA(v) = VALUE i( t[ key = `b` ]-value DEFAULT 9 ).
    DATA(w) = VALUE i( t[ key = `x` ]-value DEFAULT 9 ).
    DATA(r1) = VALUE #( t[ key = `a` ]-ref DEFAULT fallback ).
    DATA(r2) = VALUE #( t[ key = `x` ]-ref DEFAULT fallback ).
    DATA(r3) = VALUE #( t[ key = `b` ]-ref DEFAULT fallback ).
    rv = |{ found-value }/{ found-key }/{ missing-value }/[{ missing-key }]/{ v }/{ w }/{ r1->name }/{ r2->name }/|
      && COND string( WHEN r3 IS BOUND THEN `bound` ELSE `initial` ).
  ENDMETHOD.
ENDCLASS.
