CLASS zcl_osd_conv_exit DEFINITION PUBLIC FINAL CREATE PUBLIC.
* A conversion exit of a property or a search help field, run the way the
* Gateway runs it on a system: CONVERSION_EXIT_<exit>_OUTPUT before a
* value is written (the body, an entry's URI, the order of a value help's
* hit list), CONVERSION_EXIT_<exit>_INPUT on a key the URL names before
* the provider reads it. One place for both directions, so the JSON
* writer, the request context and the search help provider call the same
* modules the same way.
*
* An exit without a module in this system, or a module that declines the
* value (CUNIT's UNIT_NOT_FOUND, ISOLA's UNKNOWN_LANGUAGE), leaves the
* value as it is: what a system answers then is not measured.
  PUBLIC SECTION.
    CLASS-METHODS output
      IMPORTING
        iv_value        TYPE any
        iv_exit         TYPE csequence
      RETURNING
        VALUE(rv_value) TYPE string.

* the value into cv_target, the field it is read into: an exit that pads
* (ALPHA) pads to that field's length, as on a system
    CLASS-METHODS input
      IMPORTING
        iv_value  TYPE string
        iv_exit   TYPE csequence
      CHANGING
        cv_target TYPE any.
ENDCLASS.

CLASS zcl_osd_conv_exit IMPLEMENTATION.

  METHOD output.
    DATA lv_module TYPE string.
    DATA lv_output TYPE c LENGTH 255.

    rv_value = iv_value.
    IF iv_exit IS INITIAL.
      RETURN.
    ENDIF.
    lv_module = |CONVERSION_EXIT_{ to_upper( iv_exit ) }_OUTPUT|.
    TRY.
        CALL FUNCTION lv_module
          EXPORTING
            input  = iv_value
          IMPORTING
            output = lv_output
          EXCEPTIONS
            OTHERS = 1.
        IF sy-subrc = 0.
          rv_value = lv_output.
        ENDIF.
      CATCH cx_sy_dyn_call_illegal_func ##NO_HANDLER.
* no module for this exit here: the value as stored
    ENDTRY.
  ENDMETHOD.

  METHOD input.
    DATA lv_module TYPE string.
    DATA lr_output TYPE REF TO data.
    FIELD-SYMBOLS <lv_output> TYPE any.

    cv_target = iv_value.
    IF iv_exit IS INITIAL.
      RETURN.
    ENDIF.
    lv_module = |CONVERSION_EXIT_{ to_upper( iv_exit ) }_INPUT|.
    CREATE DATA lr_output LIKE cv_target.
    ASSIGN lr_output->* TO <lv_output>.
    TRY.
        CALL FUNCTION lv_module
          EXPORTING
            input  = iv_value
          IMPORTING
            output = <lv_output>
          EXCEPTIONS
            OTHERS = 1.
        IF sy-subrc = 0.
          cv_target = <lv_output>.
        ENDIF.
      CATCH cx_sy_dyn_call_illegal_func ##NO_HANDLER.
* no module for this exit here: the value as the URL gave it
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
