CLASS zcl_oao_context DEFINITION PUBLIC.
* mo_context of a DPC: what the generated code reaches through it.
* Overlay (H5x-3) of the library's copy: the interface carries the message
* container getter the SEGW sample calls, and this class serves it.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_context.

    METHODS constructor
      IMPORTING
        io_logger TYPE REF TO /iwbep/cl_cos_logger.
  PRIVATE SECTION.
    DATA mo_logger TYPE REF TO /iwbep/cl_cos_logger.
ENDCLASS.

CLASS zcl_oao_context IMPLEMENTATION.

  METHOD constructor.
    mo_logger = io_logger.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_context~get_logger.
    ro_logger = mo_logger.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_context~get_message_container.
* the same per-request container the dispatcher reads into the error
* response (zcl_stg_dispatcher resets it at request entry)
    ro_message_container = /iwbep/cl_mgw_msg_container=>get_mgw_msg_container( ).
  ENDMETHOD.

ENDCLASS.
