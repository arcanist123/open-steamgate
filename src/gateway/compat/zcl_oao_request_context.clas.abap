CLASS zcl_oao_request_context DEFINITION PUBLIC.
* Overlay (H5x-3) of the library's copy: the entity-set facet carries the
* navigation path getter, so every implementer of the facet serves it; this
* context has no URL behind it, the path stays empty.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_req_entityset.

    METHODS constructor
      IMPORTING
        iv_entity_set_name TYPE string.
  PRIVATE SECTION.
    DATA mv_entity_set_name TYPE string.
ENDCLASS.

CLASS zcl_oao_request_context IMPLEMENTATION.
  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_orderby.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_top.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_inlinecount.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_count.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_skip.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_converted_source_keys.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_filter.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD constructor.
    mv_entity_set_name = iv_entity_set_name.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_entity_set_name.
    rv_entity_set = mv_entity_set_name.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_source_entity_set_name.
    rv_entity_set = mv_entity_set_name.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause_convert.
    ASSERT 1 = 'todo'.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_navigation_path.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_source_entity_type_name.
* milestone 4: the facet's new getters; no URL behind this context either
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

ENDCLASS.
