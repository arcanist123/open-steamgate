CLASS ltcl_message_container DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The message container members the SEGW sample calls (H5x-3):
* /iwbep/if_mgw_context~get_message_container on the runtime context the
* DPC's mo_context is typed by, and /iwbep/if_message_container~add_message
* on the container it returns. The container collects what was added and
* the dispatcher reads it into the error response.
  PRIVATE SECTION.
    METHODS add_message_collects FOR TESTING RAISING cx_static_check.
    METHODS context_serves_container FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_message_container IMPLEMENTATION.

  METHOD add_message_collects.
    DATA lo_container TYPE REF TO /iwbep/if_message_container.
    DATA lo_impl      TYPE REF TO zcl_oao_msg_container.
    DATA lt_messages  TYPE bapirettab.
    DATA ls_message   LIKE LINE OF lt_messages.
    DATA lt_keys      TYPE /iwbep/t_mgw_name_value_pair.

    /iwbep/cl_mgw_msg_container=>reset( ).
    lo_container = /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ).
    lo_container->add_message( iv_msg_type   = 'E'
                               iv_msg_id     = 'ZSTG_DEMO'
                               iv_msg_number = '004'
                               iv_msg_v1     = 'T0400' ).

    lo_impl ?= lo_container.
    lt_messages = lo_impl->get_messages( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_messages )
                                        exp = 1 ).
    READ TABLE lt_messages INTO ls_message INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_message-type
                                        exp = 'E' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-id
                                        exp = 'ZSTG_DEMO' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-number
                                        exp = '004' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-message_v1
                                        exp = 'T0400' ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-message
                                        exp = 'T0400' ).

* a second add lands beside the first; an error makes has_errors true
    lo_container->add_message( iv_msg_type   = 'S'
                               iv_msg_id     = 'ZSTG_DEMO'
                               iv_msg_number = '005' ).
    lt_messages = lo_impl->get_messages( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_messages )
                                        exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = lo_impl->has_errors( )
                                        exp = abap_true ).

* the documented optional parameters compile, and a given text is the message
    lo_container->add_message( iv_msg_type            = 'I'
                               iv_msg_text            = 'given text'
                               iv_msg_v1              = 'ignored'
                               iv_error_category      = 'PROCESSING'
                               iv_is_leading_message  = abap_true
                               iv_entity_type         = 'Travel'
                               it_key_tab             = lt_keys
                               iv_message_target      = 'TravelId' ).
    lt_messages = lo_impl->get_messages( ).
    READ TABLE lt_messages INTO ls_message INDEX 3.
    cl_abap_unit_assert=>assert_equals( act = ls_message-message
                                        exp = 'given text' ).

* the next request starts from an empty container
    /iwbep/cl_mgw_msg_container=>reset( ).
    lo_container = /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ).
    lo_impl ?= lo_container.
    cl_abap_unit_assert=>assert_initial( lo_impl->get_messages( ) ).
  ENDMETHOD.

  METHOD context_serves_container.
    DATA lo_logger   TYPE REF TO /iwbep/cl_cos_logger.
    DATA lo_context  TYPE REF TO zcl_oao_context.
    DATA lo_from_ctx TYPE REF TO /iwbep/if_message_container.
    DATA lo_impl     TYPE REF TO zcl_oao_msg_container.
    DATA ls_message  TYPE bapiret2.

    CREATE OBJECT lo_logger.
    CREATE OBJECT lo_context EXPORTING io_logger = lo_logger.

    /iwbep/cl_mgw_msg_container=>reset( ).
    lo_from_ctx = lo_context->/iwbep/if_mgw_context~get_message_container( ).
    cl_abap_unit_assert=>assert_bound( lo_from_ctx ).

* what the context serves is the same container the dispatcher reads
    lo_from_ctx->add_message( iv_msg_type   = 'W'
                              iv_msg_id     = 'ZSTG_DEMO'
                              iv_msg_number = '010'
                              iv_msg_v1     = 'from the context' ).
    lo_impl ?= /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ).
    READ TABLE lo_impl->get_messages( ) INTO ls_message INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_message-message
                                        exp = 'from the context' ).
  ENDMETHOD.

ENDCLASS.
