CLASS cl_abap_behv DEFINITION PUBLIC CREATE PUBLIC.
* The common base of RAP handlers and savers: making a message for %MSG.
* Clean-room (docs/rap-runtime.md): the method names are the public
* contract; the message is a ZCL_OSD_RAP_MESSAGE.
  PUBLIC SECTION.
* R7: the %control flag of a field a request changed (the flight saver
* compares with it), the same value as if_abap_behv=>mk-on
    CONSTANTS flag_changed TYPE x LENGTH 1 VALUE '01'.
    CONSTANTS flag_unchanged TYPE x LENGTH 1 VALUE '00'.
  PROTECTED SECTION.
    METHODS new_message_with_text
      IMPORTING
        severity   TYPE if_abap_behv_message=>t_severity DEFAULT if_abap_behv_message=>severity-error
        text       TYPE csequence OPTIONAL
      RETURNING
        VALUE(obj) TYPE REF TO if_abap_behv_message.

    METHODS new_message
      IMPORTING
        id         TYPE symsgid
        number     TYPE symsgno
        severity   TYPE if_abap_behv_message=>t_severity
        v1         TYPE simple OPTIONAL
        v2         TYPE simple OPTIONAL
        v3         TYPE simple OPTIONAL
        v4         TYPE simple OPTIONAL
      RETURNING
        VALUE(obj) TYPE REF TO if_abap_behv_message.
ENDCLASS.

CLASS cl_abap_behv IMPLEMENTATION.

  METHOD new_message_with_text.
    obj = zcl_osd_rap_message=>with_text( iv_severity = severity iv_text = text ).
  ENDMETHOD.

  METHOD new_message.
* no message class texts here: the message carries its id, number and
* variables, and its text says which message it is
    DATA lv_text TYPE string.
    lv_text = |{ id }/{ number } { v1 } { v2 } { v3 } { v4 }|.
    obj = zcl_osd_rap_message=>with_text( iv_severity = severity iv_text = lv_text ).
  ENDMETHOD.

ENDCLASS.
