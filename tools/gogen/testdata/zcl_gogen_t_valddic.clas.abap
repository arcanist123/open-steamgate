* Unmeasured: ABAP keyword documentation, VALUE with a DDIC table type (#998).
CLASS zcl_gogen_t_valddic DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.
CLASS zcl_gogen_t_valddic IMPLEMENTATION.
  METHOD run.
    DATA texts TYPE string_table.
    texts = VALUE string_table( ( `a` ) ( `b` ) ).
    DATA(more) = VALUE string_table( ( `c` ) ).
    APPEND LINES OF more TO texts.
    DATA(none) = VALUE string_table( ).
    rv = |{ lines( texts ) }/{ texts[ 1 ] }{ texts[ 3 ] }/{ lines( none ) }|.
  ENDMETHOD.
ENDCLASS.
