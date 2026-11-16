INTERFACE /iwbep/if_mgw_odata_item PUBLIC.
* Overlay (milestone 4): every element of a model is an item -- the
* entity set, the association and its set, the navigation property and the
* referential constraint as well as the entity type, the property and the
* action (a second generated service labels its entity sets, associations
* and navigation properties from its text pool; a redefining model
* disables elements it took over). The aliases on each element interface
* are the names its callers use.

  METHODS set_label_from_text_element
    IMPORTING
      iv_text_element_symbol    TYPE textpoolky
      iv_text_element_container TYPE string OPTIONAL
    RAISING
      /iwbep/cx_mgw_med_exception.

* the element is not part of the service: $metadata does not carry it
* (called with no argument, or with abap_true; abap_false enables it again)
  METHODS set_disabled
    IMPORTING
      iv_disabled TYPE abap_bool DEFAULT abap_true.

ENDINTERFACE.
