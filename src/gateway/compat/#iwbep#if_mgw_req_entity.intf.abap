INTERFACE /iwbep/if_mgw_req_entity PUBLIC.

  METHODS get_entity_set_name
    RETURNING
      VALUE(rv_entity_set) TYPE /iwbep/mgw_tech_name.

  METHODS get_entity_type_name
    RETURNING
      VALUE(rv_entity_type) TYPE /iwbep/mgw_tech_name.

  METHODS get_source_entity_set_name
    RETURNING
      VALUE(rv_entity_set) TYPE /iwbep/mgw_tech_name.

  METHODS get_converted_keys
    EXPORTING
      es_key_values TYPE data.

  METHODS get_converted_source_keys
    EXPORTING
      es_key_values TYPE data.

* Overlay (H5x-3): the navigation path the URL carried, the member the SEGW
* sample calls on this facet and on the entity-set facet (its
* RESOLVE_NAVIGATION_PATH receives both contexts and calls the getter on
* each; framework-gaps.json of bed run 18 -- private evidence). The
* technical request context returns the navigation path in technical names
* (SAP Help Portal, GET_NAVIGATION_PATH, RT_NAVIGATION_PATH:
* https://help.sap.com/saphelp_gateway20sp12/helpdata/en/88/1733b1d5fd42d7a732bc405d1ed67b/content.htm
* ): one row per step with the source and the target entity type,
* /iwbep/t_mgw_tech_navi, not the it_navigation_path table of the
* operations.
  METHODS get_navigation_path
    RETURNING
      VALUE(rt_navigation_path) TYPE /iwbep/t_mgw_tech_navi.

* Overlay (milestone 4): the same two members as on the entity-set facet
* (a second generated service reads both on a single read)
  METHODS get_source_entity_type_name
    RETURNING
      VALUE(rv_source_entity_type) TYPE /iwbep/mgw_tech_name.

  METHODS get_select_with_mandtry_fields
    RETURNING
      VALUE(rt_selected_fields) TYPE /iwbep/t_mgw_tech_field_names.
ENDINTERFACE.
