INTERFACE /iwbep/if_mgw_context PUBLIC.
  METHODS get_logger
    RETURNING
      VALUE(ro_logger) TYPE REF TO /iwbep/cl_cos_logger.

* Overlay (H5x-3): the message container of the request -- the member the
* SEGW sample calls on the DPC's mo_context (typed by this interface) to
* collect messages while it processes (framework-gaps.json of bed run 18 --
* private evidence). Per SAP Help Portal, SAP Gateway Foundation, "Message
* Container": the runtime context serves the container and the error
* response carries what was added.
  METHODS get_message_container
    RETURNING
      VALUE(ro_message_container) TYPE REF TO /iwbep/if_message_container.
ENDINTERFACE.
