CLASS zcl_oao_assoc_set DEFINITION PUBLIC.
* Overlay of open-abap-odata's association set (milestone 4): an item
* (set_disabled; a label is kept, a system's $metadata of the services
* measured writes none on an AssociationSet).
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_assoc_set.

    DATA mv_name           TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_association    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_left_set       TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_right_set      TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_text_symbol    TYPE textpoolky.
    DATA mv_text_container TYPE string.
    DATA mv_disabled       TYPE abap_bool.
ENDCLASS.

CLASS zcl_oao_assoc_set IMPLEMENTATION.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_symbol    = iv_text_element_symbol.
    mv_text_container = iv_text_element_container.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_disabled.
    mv_disabled = iv_disabled.
  ENDMETHOD.

ENDCLASS.
