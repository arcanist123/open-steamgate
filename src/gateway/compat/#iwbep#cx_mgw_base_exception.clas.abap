CLASS /iwbep/cx_mgw_base_exception DEFINITION INHERITING FROM cx_static_check PUBLIC.
* Overlay (milestone 4) of the library copy: the members the exceptions of
* two more generated services use on every Gateway exception --
* the HTTP status codes by name (gcs_http_status_codes, the values are the
* HTTP codes themselves), the status the exception answers with
* (http_status_code; a subclass sets it in its constructor, as the
* own exception of service A does for "not found"), and the
* message container the exception carries (get_msg_container: the
* request's own container unless one was given, so what is added through
* it reaches the error response's innererror.errordetails).
  PUBLIC SECTION.
    INTERFACES if_t100_message.

* NOT MEASURED: the component names not_found, forbidden,
* precondition_failed, internal_server_error and bad_request are the ones the
* callers read so far; the others, and every component's type, are assumed
* (the values are the HTTP codes themselves)
    CONSTANTS:
      BEGIN OF gcs_http_status_codes,
        ok                    TYPE i VALUE 200,
        created               TYPE i VALUE 201,
        no_content            TYPE i VALUE 204,
        not_modified          TYPE i VALUE 304,
        bad_request           TYPE i VALUE 400,
        unauthorized          TYPE i VALUE 401,
        forbidden             TYPE i VALUE 403,
        not_found             TYPE i VALUE 404,
        method_not_allowed    TYPE i VALUE 405,
        conflict              TYPE i VALUE 409,
        gone                  TYPE i VALUE 410,
        precondition_failed   TYPE i VALUE 412,
        precondition_required TYPE i VALUE 428,
        internal_server_error TYPE i VALUE 500,
        not_implemented       TYPE i VALUE 501,
        service_unavailable   TYPE i VALUE 503,
      END OF gcs_http_status_codes.

* 0 when the exception names none: the gateway answers its default then.
* NOT MEASURED: the type on a system (i here)
    DATA http_status_code  TYPE i.
    DATA message_container TYPE REF TO /iwbep/if_message_container.

    METHODS constructor
      IMPORTING
        textid            LIKE if_t100_message=>t100key OPTIONAL
        previous          LIKE previous OPTIONAL
        message_container TYPE REF TO /iwbep/if_message_container OPTIONAL
        http_status_code  TYPE i OPTIONAL.

    METHODS get_msg_container
      RETURNING
        VALUE(ro_message_container) TYPE REF TO /iwbep/if_message_container.
ENDCLASS.

CLASS /iwbep/cx_mgw_base_exception IMPLEMENTATION.

  METHOD constructor.
    super->constructor( previous = previous ).
    CLEAR me->textid.
    IF textid IS INITIAL.
      if_t100_message~t100key = if_t100_message=>default_textid.
    ELSE.
      if_t100_message~t100key = textid.
    ENDIF.
    me->message_container = message_container.
    me->http_status_code  = http_status_code.
  ENDMETHOD.

  METHOD get_msg_container.
    IF message_container IS NOT BOUND.
      message_container = /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ).
    ENDIF.
    ro_message_container = message_container.
  ENDMETHOD.

ENDCLASS.
