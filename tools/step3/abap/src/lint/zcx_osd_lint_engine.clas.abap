CLASS zcx_osd_lint_engine DEFINITION PUBLIC INHERITING FROM cx_no_check
  FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    DATA reason TYPE string READ-ONLY.
    METHODS constructor IMPORTING iv_reason TYPE string.
    METHODS get_text REDEFINITION.
ENDCLASS.

CLASS zcx_osd_lint_engine IMPLEMENTATION.
  METHOD constructor.
    super->constructor( ).
    reason = iv_reason.
  ENDMETHOD.
  METHOD get_text.
    result = reason.
  ENDMETHOD.
ENDCLASS.
