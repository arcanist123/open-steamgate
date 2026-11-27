INTERFACE /iwbep/if_mgw_odata_assoc_set PUBLIC.
* Overlay (milestone 4): the association set is an item (set_disabled).

  INTERFACES /iwbep/if_mgw_odata_item.

  ALIASES set_label_from_text_element FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

ENDINTERFACE.
