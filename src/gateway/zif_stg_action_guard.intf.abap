INTERFACE zif_stg_action_guard PUBLIC.
* A data provider whose function imports are actions that change the entity
* they are for (a RAP action served over V2, docs/rap-runtime.md, "R4"):
* the dispatcher checks If-Match for such an import as for a MERGE when the
* entity type has an ETag. A function import of any other provider is called
* as before, without a precondition: on a system a V2 function import is not
* ETag-checked by the Gateway.
  METHODS guards
    IMPORTING
      iv_entity_set    TYPE string
      iv_action        TYPE string
    RETURNING
      VALUE(rv_guards) TYPE abap_bool.
ENDINTERFACE.
