* Unmeasured: ABAP keyword documentation, NEW for a data reference (#997).
* The values are read through ref->comp only, so both emitters run it.
CLASS zcl_gogen_t_newdrefp DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF pair,
             a TYPE i,
             b TYPE string,
           END OF pair.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_newdrefp IMPLEMENTATION.
  METHOD run.
    DATA p TYPE REF TO pair.
    DATA p2 TYPE REF TO pair.
    DATA sp TYPE pair.
    sp-a = 1.
    sp-b = `q`.
    p = NEW #( sp ).
    sp-a = 2.
    p2 = p.
    p2->a = p2->a + 10.
    rv = |{ p->a }{ p->b }|.
    p = NEW #( a = 3 b = `x` ).
    rv = |{ rv }/{ p->a }{ p->b }{ p2->a }|.
    p = NEW pair( ).
    rv = |{ rv }/{ p->a }|.
  ENDMETHOD.
ENDCLASS.
