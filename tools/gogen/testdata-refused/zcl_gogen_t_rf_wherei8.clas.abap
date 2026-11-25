* LOOP ... USING KEY with a WHERE on an i component against an int8 value
* (abapiti 043 critic round): the key loop compares the plain component, so
* it is refused rather than lowered with mismatched types. The i component is
* the key's own: abaplint 2.120.118 refuses a WHERE that leaves a key
* component out, so the comparison is on the key component itself.
CLASS zcl_gogen_t_rf_wherei8 DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF entry, k TYPE string, n TYPE i, END OF entry.
    TYPES entries_type TYPE STANDARD TABLE OF entry WITH DEFAULT KEY WITH NON-UNIQUE SORTED KEY sk COMPONENTS n.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_gogen_t_rf_wherei8 IMPLEMENTATION.
  METHOD run.
    DATA entries TYPE entries_type.
    DATA row TYPE entry.
    DATA wide TYPE int8 VALUE 7.
    LOOP AT entries INTO row USING KEY sk WHERE n = wide.
      rv = rv && row-k.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
