CLASS zcl_oao_msg_container DEFINITION PUBLIC.
* The message container of a request: BAPI return messages and plain texts
* the DPC adds while processing, read by the error response.
* Overlay (H5x-3) of the library's copy: the interface carries add_message,
* the member the SEGW sample calls per message it forwards.
* Milestone 4: reset, and add_message_from_exception (a page service hands
* its exceptions to the container).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_message_container.

    METHODS get_messages
      RETURNING
        VALUE(rt_messages) TYPE bapirettab.

    METHODS has_errors
      RETURNING
        VALUE(rv_errors) TYPE abap_bool.
  PRIVATE SECTION.
    DATA mt_messages TYPE bapirettab.
ENDCLASS.

CLASS zcl_oao_msg_container IMPLEMENTATION.

  METHOD /iwbep/if_message_container~add_message_from_bapi.
    APPEND is_bapi_message TO mt_messages.
  ENDMETHOD.

  METHOD /iwbep/if_message_container~add_message_text_only.
    DATA ls_message TYPE bapiret2.

    ls_message-type    = iv_msg_type.
    ls_message-message = iv_msg_text.
    APPEND ls_message TO mt_messages.
  ENDMETHOD.

  METHOD /iwbep/if_message_container~add_messages_from_bapi.
    DATA ls_message TYPE bapiret2.
    FIELD-SYMBOLS <ls_row> TYPE any.

    LOOP AT it_bapi_messages ASSIGNING <ls_row>.
      CLEAR ls_message.
      MOVE-CORRESPONDING <ls_row> TO ls_message.
      APPEND ls_message TO mt_messages.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_message_container~add_message.
    DATA ls_message TYPE bapiret2.

    ls_message-type       = iv_msg_type.
    ls_message-id         = iv_msg_id.
    ls_message-number     = iv_msg_number.
    ls_message-message_v1 = iv_msg_v1.
    ls_message-message_v2 = iv_msg_v2.
    ls_message-message_v3 = iv_msg_v3.
    ls_message-message_v4 = iv_msg_v4.
* a text the caller gives is the message; otherwise the text a system builds
* from the message class, built here from the variables: this runtime keeps
* no message classes. The category, leading flag, entity type, keys and
* target are accepted and not kept: the error response carries none of them.
    IF iv_msg_text IS NOT INITIAL.
      ls_message-message = iv_msg_text.
    ELSE.
      CONCATENATE iv_msg_v1 iv_msg_v2 iv_msg_v3 iv_msg_v4
        INTO ls_message-message SEPARATED BY space.
      CONDENSE ls_message-message.
    ENDIF.
    APPEND ls_message TO mt_messages.
  ENDMETHOD.

  METHOD /iwbep/if_message_container~reset.
    CLEAR mt_messages.
  ENDMETHOD.

  METHOD /iwbep/if_message_container~add_message_from_exception.
* one message per exception, the outer one first and then what it wraps
* (unless iv_add_previous is off): an error, its text the exception's text,
* its message class and number the exception's T100 key when it has one
    DATA lx_current TYPE REF TO cx_root.
    DATA lo_t100    TYPE REF TO if_t100_message.
    DATA ls_message TYPE bapiret2.

    lx_current = io_exception.
    WHILE lx_current IS BOUND.
      CLEAR ls_message.
      ls_message-type    = 'E'.
      ls_message-message = lx_current->get_text( ).
      TRY.
          lo_t100 ?= lx_current.
          ls_message-id     = lo_t100->t100key-msgid.
          ls_message-number = lo_t100->t100key-msgno.
        CATCH cx_sy_move_cast_error ##NO_HANDLER.
      ENDTRY.
      APPEND ls_message TO mt_messages.
      IF iv_add_previous = abap_false.
        EXIT.
      ENDIF.
      lx_current = lx_current->previous.
    ENDWHILE.
  ENDMETHOD.

  METHOD get_messages.
    rt_messages = mt_messages.
  ENDMETHOD.

  METHOD has_errors.
    DATA ls_message TYPE bapiret2.

    LOOP AT mt_messages INTO ls_message WHERE type CA 'EAX'.
      rv_errors = abap_true.
      RETURN.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
