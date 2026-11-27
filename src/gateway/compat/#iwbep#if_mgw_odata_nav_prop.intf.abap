INTERFACE /iwbep/if_mgw_odata_nav_prop PUBLIC.
* Overlay (milestone 4): the navigation property is an item (sap:label from
* the text pool, set_disabled).

  INTERFACES /iwbep/if_mgw_odata_item.

  ALIASES set_label_from_text_element FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

ENDINTERFACE.
