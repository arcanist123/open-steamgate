CLASS zcl_oao_entity_set DEFINITION PUBLIC.
* Overlay of open-abap-odata's entity set (src/gateway/compat/README.md,
* milestone 4): the set is an item -- its label from the text pool
* (sap:label on the EntitySet) and set_disabled (the set leaves the model).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_entity_set.
    INTERFACES /iwbep/if_mgw_odata_annotatabl.

    DATA mo_annotation TYPE REF TO zcl_oao_annotation.

    DATA mv_creatable       TYPE abap_bool.
    DATA mv_updatable       TYPE abap_bool.
    DATA mv_deletable       TYPE abap_bool.
    DATA mv_pageable        TYPE abap_bool.
    DATA mv_addressable     TYPE abap_bool.
    DATA mv_fsearch         TYPE abap_bool.
    DATA mv_subscribable    TYPE abap_bool.
    DATA mv_filter_required TYPE abap_bool.
    DATA mv_text_symbol     TYPE textpoolky.
    DATA mv_text_container  TYPE string.
    DATA mv_disabled        TYPE abap_bool.
ENDCLASS.

CLASS zcl_oao_entity_set IMPLEMENTATION.

  METHOD /iwbep/if_mgw_odata_entity_set~set_creatable.
    mv_creatable = iv_creatable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_updatable.
    mv_updatable = iv_updatable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_deletable.
    mv_deletable = iv_deletable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_pageable.
    mv_pageable = iv_pageable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_addressable.
    mv_addressable = iv_addressable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_has_ftxt_search.
    mv_fsearch = iv_fsearch.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_subscribable.
    mv_subscribable = iv_subscribable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_entity_set~set_filter_required.
    mv_filter_required = iv_req_filter.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_symbol    = iv_text_element_symbol.
    mv_text_container = iv_text_element_container.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_disabled.
    mv_disabled = iv_disabled.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_annotatabl~create_annotation.
    IF mo_annotation IS NOT BOUND.
      CREATE OBJECT mo_annotation.
    ENDIF.
    ro_annotation = mo_annotation.
  ENDMETHOD.

ENDCLASS.
