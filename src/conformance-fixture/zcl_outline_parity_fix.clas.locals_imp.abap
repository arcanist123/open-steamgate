*"* Local helper definitions and implementations
*"* Keep three comment lines to exercise include coordinates
*"* independently of the main source

CLASS lcl_helper DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS double
      IMPORTING iv        TYPE i
      RETURNING VALUE(rv) TYPE i.
ENDCLASS.


CLASS lcl_helper IMPLEMENTATION.

  METHOD double.
    rv = iv * 2.
  ENDMETHOD.
ENDCLASS.
