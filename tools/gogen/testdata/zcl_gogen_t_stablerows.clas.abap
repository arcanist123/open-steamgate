* Pin 4m: a row-by-row move between two tables of different row types whose
* source rows are stable (APPEND INITIAL LINE ... ASSIGNING keeps their
* addresses, so the Go slice holds pointers); and a constant of a
* BEGIN OF ENUM, which has a name and no number, left out of the Go
* constants rather than written as NaN.
CLASS zcl_gogen_t_stablerows DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_pair,
             name  TYPE string,
             value TYPE string,
           END OF ty_pair.
    TYPES ty_pairs TYPE STANDARD TABLE OF ty_pair WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_field,
             key  TYPE string,
             text TYPE string,
           END OF ty_field.
    TYPES ty_fields TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.
    TYPES:
      BEGIN OF ENUM ty_role,
        main,
        attachment,
      END OF ENUM ty_role.
    CLASS-METHODS converted RETURNING VALUE(rv) TYPE string.
ENDCLASS.

CLASS zcl_gogen_t_stablerows IMPLEMENTATION.
  METHOD converted.
    DATA lt_pairs TYPE ty_pairs.
    DATA lt_fields TYPE ty_fields.
    DATA ls_field TYPE ty_field.
    FIELD-SYMBOLS <ls_pair> TYPE ty_pair.
    APPEND INITIAL LINE TO lt_pairs ASSIGNING <ls_pair>.
    <ls_pair>-name = `a`.
    <ls_pair>-value = `1`.
    APPEND INITIAL LINE TO lt_pairs ASSIGNING <ls_pair>.
    <ls_pair>-name = `b`.
    <ls_pair>-value = `2`.
    lt_fields = lt_pairs.
    LOOP AT lt_fields INTO ls_field.
      rv = rv && ls_field-key && ls_field-text.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
