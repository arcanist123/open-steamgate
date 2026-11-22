* Unmeasured: ABAP keyword documentation, a method call on NEW x( ) (#540).
CLASS zcl_gogen_t_newcall DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-DATA calls TYPE i.
    METHODS constructor IMPORTING iv TYPE i OPTIONAL.
    METHODS twice RETURNING VALUE(rv) TYPE i.
    METHODS self RETURNING VALUE(ro) TYPE REF TO zcl_gogen_t_newcall.
    METHODS count.
    CLASS-METHODS run RETURNING VALUE(rv) TYPE string.
  PRIVATE SECTION.
    DATA mv TYPE i.
ENDCLASS.
CLASS zcl_gogen_t_newcall IMPLEMENTATION.
  METHOD constructor.
    mv = iv.
  ENDMETHOD.
  METHOD twice.
    rv = mv * 2.
  ENDMETHOD.
  METHOD self.
    ro = me.
  ENDMETHOD.
  METHOD count.
    calls = calls + 1.
  ENDMETHOD.
  METHOD run.
    DATA(a) = NEW zcl_gogen_t_newcall( 21 )->twice( ).
    DATA(b) = NEW zcl_gogen_t_newcall( iv = 5 )->self( )->twice( ).
    NEW zcl_gogen_t_newcall( )->count( ).
    NEW zcl_gogen_t_newcall( )->count( ).
    rv = |{ a }/{ b }/{ calls }/{ NEW zcl_gogen_t_newcall( 3 )->twice( ) }|.
  ENDMETHOD.
ENDCLASS.
