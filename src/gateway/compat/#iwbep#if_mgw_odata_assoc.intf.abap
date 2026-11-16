INTERFACE /iwbep/if_mgw_odata_assoc PUBLIC.
* Overlay (milestone 4): the association is an item (sap:label from the
* text pool, set_disabled); its referential constraint is read back, and an
* association set is created from it under the name the model gives.

  INTERFACES /iwbep/if_mgw_odata_item.

  ALIASES set_label_from_text_element FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

  METHODS create_ref_constraint
    IMPORTING
      iv_principal_is_left     TYPE abap_bool DEFAULT abap_true
    RETURNING
      VALUE(ro_ref_constraint) TYPE REF TO /iwbep/if_mgw_odata_ref_constr
    RAISING
      /iwbep/cx_mgw_med_exception.

* the constraint create_ref_constraint made; a med exception when none
  METHODS get_ref_constraint
    RETURNING
      VALUE(ro_ref_constraint) TYPE REF TO /iwbep/if_mgw_odata_ref_constr
    RAISING
      /iwbep/cx_mgw_med_exception.

* an association set of this association between the default entity sets
* of its two ends, named iv_assoc_set_name
  METHODS create_assoc_set
    IMPORTING
      iv_assoc_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_assoc_set) TYPE REF TO /iwbep/if_mgw_odata_assoc_set
    RAISING
      /iwbep/cx_mgw_med_exception.

ENDINTERFACE.
