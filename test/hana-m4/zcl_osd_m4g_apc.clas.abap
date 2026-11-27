* A push channel for test/hana-serve.mjs: it answers on_start and echoes a
* message, and on "write" it inserts a row, which a read-only host refuses
* (the event dumps, the socket closes 1011, the host says the write).
CLASS zcl_osd_m4g_apc DEFINITION PUBLIC INHERITING FROM cl_apc_wsp_ext_stateful_base FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS if_apc_wsp_extension~on_start REDEFINITION.
    METHODS if_apc_wsp_extension~on_message REDEFINITION.
  PRIVATE SECTION.
    METHODS send IMPORTING io_manager TYPE REF TO if_apc_wsp_message_manager iv_text TYPE string.
ENDCLASS.

CLASS zcl_osd_m4g_apc IMPLEMENTATION.
  METHOD if_apc_wsp_extension~on_start.
    send( io_manager = i_message_manager iv_text = `ready` ).
  ENDMETHOD.

  METHOD if_apc_wsp_extension~on_message.
    DATA lv_text TYPE string.
    DATA ls_row TYPE zstg_demo.
    lv_text = i_message->get_text( ).
    IF lv_text = `write`.
      ls_row-travel_id = 'T0199'.
      INSERT zstg_demo FROM ls_row.
    ENDIF.
    send( io_manager = i_message_manager iv_text = |echo { lv_text }| ).
  ENDMETHOD.

  METHOD send.
    DATA lo_message TYPE REF TO if_apc_wsp_message.
    lo_message = io_manager->create_message( ).
    lo_message->set_text( iv_text ).
    io_manager->send( lo_message ).
  ENDMETHOD.
ENDCLASS.
