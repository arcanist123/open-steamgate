* Unmeasured: ABAP keyword documentation, NEW for a data reference (#997).
* The values are read through ASSIGN ref->*.
CLASS zcl_gogen_t_newdref DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF row,
             count TYPE REF TO i,
             name  TYPE REF TO string,
           END OF row.
    TYPES: BEGIN OF pair,
             a TYPE i,
             b TYPE string,
           END OF pair.
    TYPES ints TYPE STANDARD TABLE OF i WITH EMPTY KEY.
    TYPES pairs TYPE STANDARD TABLE OF pair WITH EMPTY KEY.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_newdref IMPLEMENTATION.
  METHOD run.
    DATA number TYPE REF TO i.
    DATA source TYPE i VALUE 5.
    DATA r TYPE row.
    DATA p TYPE REF TO pair.
    DATA t TYPE REF TO ints.
    DATA e TYPE REF TO i.
    DATA f TYPE REF TO string.
    DATA tp TYPE REF TO pairs.
    FIELD-SYMBOLS <i> TYPE i.
    FIELD-SYMBOLS <s> TYPE string.
    FIELD-SYMBOLS <t> TYPE ints.
    FIELD-SYMBOLS <tp> TYPE pairs.
    number = NEW #( source ).
    source = 6.
    ASSIGN number->* TO <i>.
    rv = |{ <i> }|.
    r-count = NEW #( 2 * 3 ).
    number = r-count.
    ASSIGN number->* TO <i>.
    rv = |{ rv }/{ <i> }|.
    r-name = NEW #( |n{ <i> }| ).
    f = r-name.
    ASSIGN f->* TO <s>.
    rv = |{ rv }/{ <s> }|.
    p = NEW #( a = 1 b = `x` ).
    rv = |{ rv }/{ p->a }{ p->b }|.
    t = NEW #( ( 1 ) ( 2 ) ( 3 ) ).
    ASSIGN t->* TO <t>.
    rv = |{ rv }/{ lines( <t> ) }|.
    e = NEW i( ).
    ASSIGN e->* TO <i>.
    rv = |{ rv }/{ <i> }|.
    f = NEW string( `s` ).
    ASSIGN f->* TO <s>.
    rv = |{ rv }/{ <s> }|.
    tp = NEW #( ( a = 7 b = `y` ) ( a = 8 b = `z` ) ).
    ASSIGN tp->* TO <tp>.
    rv = |{ rv }/{ lines( <tp> ) }{ <tp>[ 2 ]-b }|.
  ENDMETHOD.
ENDCLASS.
