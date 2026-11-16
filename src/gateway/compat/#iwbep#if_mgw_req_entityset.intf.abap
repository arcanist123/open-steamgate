INTERFACE /iwbep/if_mgw_req_entityset PUBLIC.

  METHODS get_source_entity_set_name
    RETURNING
      VALUE(rv_entity_set) TYPE /iwbep/mgw_tech_name.

  METHODS get_entity_set_name
    RETURNING
      VALUE(rv_entity_set) TYPE /iwbep/mgw_tech_name.

  METHODS get_top
    RETURNING
      VALUE(rv_top) TYPE string.

  METHODS get_skip
    RETURNING
      VALUE(rv_skip) TYPE i.

  METHODS get_converted_source_keys
    EXPORTING
      es_key_values TYPE data.

  METHODS get_filter
    RETURNING
      VALUE(ro_filter) TYPE REF TO /iwbep/if_mgw_req_filter.

  METHODS has_inlinecount
    RETURNING
      VALUE(rv_has_inlinecount) TYPE abap_bool.

  METHODS has_count
    RETURNING
      VALUE(rv_has_count) TYPE abap_bool.

  METHODS get_orderby
    RETURNING
      VALUE(rt_orderby) TYPE /iwbep/t_mgw_tech_order.

  METHODS get_osql_where_clause_convert
    RETURNING
      VALUE(rv_osql_where_clause) TYPE string.

  METHODS get_osql_where_clause
    RETURNING
      VALUE(rv_osql_where_clause) TYPE string
    RAISING
      /iwbep/cx_mgw_busi_exception.

* Overlay (H5x-3): the navigation path the URL carried, the member the SEGW
* sample calls on this facet and on the single-entity facet (framework-gaps
* .json of bed run 18 -- private evidence). Technical names, one row per
* step with source and target entity type: see /iwbep/if_mgw_req_entity.
  METHODS get_navigation_path
    RETURNING
      VALUE(rt_navigation_path) TYPE /iwbep/t_mgw_tech_navi.

* Overlay (milestone 4), the members a second generated service calls on
* this facet:
* the entity type of the set a navigation started from ('' for a direct
* read, as get_source_entity_set_name)
  METHODS get_source_entity_type_name
    RETURNING
      VALUE(rv_source_entity_type) TYPE /iwbep/mgw_tech_name.

* the "search" option of the URL, as written
  METHODS get_search_string
    RETURNING
      VALUE(rv_search_string) TYPE string.

* the $skiptoken of the URL, as written ('' when none)
  METHODS get_skiptoken
    RETURNING
      VALUE(rv_skiptoken) TYPE string.

* the $select of the URL in ABAP field names, with the key fields of the
* set added; empty when the URL selected nothing (everything)
  METHODS get_select_with_mandtry_fields
    RETURNING
      VALUE(rt_selected_fields) TYPE /iwbep/t_mgw_tech_field_names.
ENDINTERFACE.
