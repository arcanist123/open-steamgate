INTERFACE /iwbep/if_mgw_odata_ref_constr PUBLIC.
* Overlay (milestone 4): the referential constraint is an item
* (set_disabled).

  INTERFACES /iwbep/if_mgw_odata_item.

  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

  METHODS add_property
    IMPORTING
      iv_principal_property TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_dependent_property TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RAISING
      /iwbep/cx_mgw_med_exception.

ENDINTERFACE.
