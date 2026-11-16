CLASS zcl_oao_nav_prop DEFINITION PUBLIC.
* Overlay of open-abap-odata's navigation property (milestone 4): an item --
* its label from the text pool (sap:label on the NavigationProperty) and
* set_disabled.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_nav_prop.

    DATA mv_name           TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_association    TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_abap_fieldname TYPE string.
    DATA mv_text_symbol    TYPE textpoolky.
    DATA mv_text_container TYPE string.
    DATA mv_disabled       TYPE abap_bool.
ENDCLASS.

CLASS zcl_oao_nav_prop IMPLEMENTATION.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_symbol    = iv_text_element_symbol.
    mv_text_container = iv_text_element_container.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_disabled.
    mv_disabled = iv_disabled.
  ENDMETHOD.

ENDCLASS.
