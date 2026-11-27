CLASS zcl_osd_rap_message DEFINITION PUBLIC FINAL CREATE PRIVATE.
* A message of REPORTED (%MSG): a severity and a text. Made through
* CL_ABAP_BEHV->new_message_with_text in a behavior pool, and by the managed
* runtime itself for field control and missing instances.
  PUBLIC SECTION.
    INTERFACES if_abap_behv_message.

    CLASS-METHODS with_text
      IMPORTING
        iv_severity       TYPE if_abap_behv_message=>t_severity
        iv_text           TYPE csequence
      RETURNING
        VALUE(ro_message) TYPE REF TO zcl_osd_rap_message.
  PRIVATE SECTION.
    DATA mv_text TYPE string.
ENDCLASS.

CLASS zcl_osd_rap_message IMPLEMENTATION.

  METHOD with_text.
    CREATE OBJECT ro_message.
    ro_message->mv_text = iv_text.
    ro_message->if_abap_behv_message~m_severity = iv_severity.
    ro_message->if_t100_dyn_msg~msgty = iv_severity.
  ENDMETHOD.

  METHOD if_message~get_text.
    result = mv_text.
  ENDMETHOD.

  METHOD if_message~get_longtext.
    result = mv_text.
  ENDMETHOD.

ENDCLASS.
