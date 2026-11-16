CLASS /iwbep/cl_mgw_request DEFINITION PUBLIC.
* Overlay (H5x-3) of the library's copy: the request facets carry the
* navigation path getter (entity, entity set) and the function-import
* getters, so every implementer serves them; this request has no URL behind
* it and returns empty the way it does from every other method.
  PUBLIC SECTION.

    INTERFACES /iwbep/if_mgw_req_entity.
    INTERFACES /iwbep/if_mgw_req_entityset.
    INTERFACES /iwbep/if_mgw_req_entity_c.
    INTERFACES /iwbep/if_mgw_req_entity_d.
    INTERFACES /iwbep/if_mgw_req_entity_u.
    INTERFACES /iwbep/if_mgw_req_entity_p.
    INTERFACES /iwbep/if_mgw_req_func_import.

    METHODS get_request_details
      RETURNING
        VALUE(rs_request) TYPE /iwbep/if_mgw_core_srv_runtime=>ty_s_mgw_request_context.

ENDCLASS.

CLASS /iwbep/cl_mgw_request IMPLEMENTATION.
  METHOD /iwbep/if_mgw_req_entity_d~get_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_d~get_converted_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_source_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_u~get_converted_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_source_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_orderby.
    RETURN.
  ENDMETHOD.

  METHOD get_request_details.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_source_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_source_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_top.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_skip.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_converted_source_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_filter.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_inlinecount.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_count.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause_convert.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_d~get_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_u~get_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_navigation_path.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_navigation_path.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_func_import~get_function_import_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_func_import~get_converted_parameters.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_source_entity_type_name.
* milestone 4: the facets' new getters, empty here like every other one
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_select_with_mandtry_fields.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_source_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_search_string.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_skiptoken.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_select_with_mandtry_fields.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_u~get_entity_type_name.
    RETURN.
  ENDMETHOD.

ENDCLASS.
