CLASS zcl_osd_v4_write DEFINITION PUBLIC CREATE PUBLIC.
* POST / PATCH / PUT / DELETE of one entity over V4, through the same DPC
* create_entity / update_entity / delete_entity the V2 path calls. V4 JSON
* values are turned into the forms ZCL_STG_ENTRY_PROVIDER already converts.
* ETags: OData 4.01 Part 1 s11.4.1.1 (If-Match, 428 without, 412 on mismatch).
  PUBLIC SECTION.
    CLASS-METHODS execute IMPORTING iv_method TYPE string io_query TYPE REF TO zcl_osd_v4_query
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      iv_service_url TYPE string iv_body TYPE string it_headers TYPE tihttpnvp OPTIONAL
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS header IMPORTING it_headers TYPE tihttpnvp iv_name TYPE string
      RETURNING VALUE(rv_value) TYPE string.
    CLASS-METHODS values IMPORTING iv_body TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model
      RETURNING VALUE(rt_values) TYPE tihttpnvp RAISING zcx_stg_error.
    CLASS-METHODS add_header IMPORTING iv_name TYPE string iv_value TYPE string
      CHANGING ct_headers TYPE tihttpnvp.
  PRIVATE SECTION.
    CLASS-METHODS read IMPORTING io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
      io_context TYPE REF TO zcl_stg_request_context is_set TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING VALUE(rr_entity) TYPE REF TO data
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS precondition IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model ir_current TYPE REF TO data it_headers TYPE tihttpnvp
      RAISING zcx_stg_error.
    CLASS-METHODS representation IMPORTING is_data TYPE any is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model iv_service_url TYPE string
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.

CLASS zcl_osd_v4_write IMPLEMENTATION.
  METHOD header.
    DATA ls_header TYPE ihttpnvp.
    LOOP AT it_headers INTO ls_header.
      IF to_lower( ls_header-name ) = to_lower( iv_name ).
        rv_value = ls_header-value.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD add_header.
    DATA ls_header TYPE ihttpnvp.
    ls_header-name = iv_name.
    ls_header-value = iv_value.
    APPEND ls_header TO ct_headers.
  ENDMETHOD.

  METHOD values.
    DATA lt_raw TYPE tihttpnvp.
    DATA lt_nested TYPE tihttpnvp.
    DATA ls_pair TYPE ihttpnvp.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_value TYPE string.
    DATA lv_h TYPE string.
    DATA lv_m TYPE string.
    DATA lv_s TYPE string.
    IF iv_body IS INITIAL.
      zcl_osd_v4_query=>fail( 'A JSON object is required as the request body' ).
    ENDIF.
    lt_raw = zcl_stg_json=>parse_object( EXPORTING iv_json = iv_body IMPORTING et_nested = lt_nested ).
    LOOP AT lt_nested INTO ls_pair.
      IF ls_pair-name CS '@'.
        zcl_osd_v4_query=>fail( iv_text = |Entity references ({ ls_pair-name }) are not implemented| iv_status = 501 ).
      ENDIF.
      zcl_osd_v4_query=>fail( iv_text = |Deep insert and structured values ({ ls_pair-name }) are not implemented in V4| iv_status = 501 ).
    ENDLOOP.
    LOOP AT lt_raw INTO ls_pair.
* control information and instance annotations (@odata.type, Name@x.y)
      IF ls_pair-name CS '@'.
        CONTINUE.
      ENDIF.
      READ TABLE is_set-properties INTO ls_prop WITH KEY name = ls_pair-name.
      IF sy-subrc <> 0.
        zcl_osd_v4_query=>fail( |Unknown property { ls_pair-name } of { is_set-entity_type }| ).
      ENDIF.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_pair-name ).
      lv_value = ls_pair-value.
      IF lv_value = 'null'.
        APPEND ls_pair TO rt_values.
        CONTINUE.
      ENDIF.
      CASE ls_info-edm_type.
        WHEN 'Edm.Date'.
          FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' IN lv_value.
          IF sy-subrc <> 0.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects a V4 Date value| ).
          ENDIF.
          lv_value = zcl_osd_v4_query=>temporal( lv_value ).
        WHEN 'Edm.DateTimeOffset'.
          FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' IN lv_value.
          IF sy-subrc <> 0.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects a V4 DateTimeOffset value| ).
          ENDIF.
          lv_value = zcl_osd_v4_query=>temporal( lv_value ).
        WHEN 'Edm.TimeOfDay'.
          FIND REGEX '^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.[0-9]+)?$' IN lv_value SUBMATCHES lv_h lv_m lv_s.
          IF sy-subrc <> 0 OR lv_h > '23' OR lv_m > '59' OR lv_s > '59'.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects a V4 TimeOfDay value| ).
          ENDIF.
          IF lv_s IS INITIAL.
            lv_s = '00'.
          ENDIF.
          lv_value = lv_h && lv_m && lv_s.
        WHEN 'Edm.Guid'.
          FIND REGEX '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' IN lv_value.
          IF sy-subrc <> 0.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects a V4 Guid value| ).
          ENDIF.
          REPLACE ALL OCCURRENCES OF '-' IN lv_value WITH ''.
          lv_value = to_upper( lv_value ).
        WHEN 'Edm.Boolean'.
          IF lv_value <> 'true' AND lv_value <> 'false'.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects true or false| ).
          ENDIF.
        WHEN 'Edm.Byte' OR 'Edm.SByte' OR 'Edm.Int16' OR 'Edm.Int32' OR 'Edm.Int64'
          OR 'Edm.Decimal' OR 'Edm.Double' OR 'Edm.Single'.
          FIND REGEX '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' IN lv_value.
          IF sy-subrc <> 0.
            zcl_osd_v4_query=>fail( |{ ls_pair-name } expects a number| ).
          ENDIF.
      ENDCASE.
      ls_pair-value = lv_value.
      APPEND ls_pair TO rt_values.
    ENDLOOP.
  ENDMETHOD.

  METHOD read.
    io_dpc->get_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
      iv_source_name = '' it_key_tab = io_context->mt_key_tab it_navigation_path = io_context->mt_navigation_path
      io_tech_request_context = io_context IMPORTING er_entity = rr_entity ).
  ENDMETHOD.

  METHOD precondition.
    DATA lv_if_match TYPE string.
    DATA lv_current TYPE string.
    DATA lt_tags TYPE string_table.
    DATA lv_tag TYPE string.
    DATA lv_weak TYPE string.
    FIELD-SYMBOLS <ls_current> TYPE any.
    lv_if_match = header( it_headers = it_headers iv_name = 'if-match' ).
    CONDENSE lv_if_match.
    ASSIGN ir_current->* TO <ls_current>.
    lv_current = zcl_osd_v4_json=>etag( is_data = <ls_current> is_set = is_set io_model = io_model ).
    IF lv_if_match IS INITIAL.
      IF io_model->has_etag( is_set-entity_type ) = abap_true.
        zcl_osd_v4_query=>fail( iv_text = |{ is_set-name } has an ETag: send If-Match with it, or If-Match: *|
          iv_status = 428 ).
      ENDIF.
      RETURN.
    ENDIF.
    IF lv_if_match = '*'.
      RETURN.
    ENDIF.
* A list of entity tags; the weak prefix is not part of the comparison
    lv_weak = lv_current.
    IF lv_weak CP 'W/*'.
      lv_weak = substring( val = lv_weak off = 2 ).
    ENDIF.
    SPLIT lv_if_match AT ',' INTO TABLE lt_tags.
    LOOP AT lt_tags INTO lv_tag.
      CONDENSE lv_tag.
      IF lv_tag CP 'W/*'.
        lv_tag = substring( val = lv_tag off = 2 ).
      ENDIF.
      IF lv_current IS NOT INITIAL AND ( lv_tag = lv_weak OR lv_tag = '*' ).
        RETURN.
      ENDIF.
    ENDLOOP.
    zcl_osd_v4_query=>fail( iv_text = 'If-Match does not match the current ETag of the entity' iv_status = 412 ).
  ENDMETHOD.

  METHOD representation.
    DATA lv_entity TYPE string.
    lv_entity = zcl_osd_v4_json=>entity( is_data = is_data is_set = is_set io_model = io_model ).
    rv_json = zcl_osd_v4_json=>document( iv_context = |{ iv_service_url }/$metadata#{ is_set-name }/$entity|
      iv_entity = lv_entity ).
  ENDMETHOD.

  METHOD execute.
    DATA lo_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lo_provider TYPE REF TO zcl_stg_entry_provider.
    DATA lt_values TYPE tihttpnvp.
    DATA ls_value TYPE ihttpnvp.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lr_entity TYPE REF TO data.
    DATA lr_current TYPE REF TO data.
    DATA lv_prefer TYPE string.
    DATA lv_location TYPE string.
    DATA lv_etag TYPE string.
    FIELD-SYMBOLS <ls_data> TYPE any.

    lo_dpc = zcl_oao_registry=>create_dpc( io_model->ms_service-name ).
    lo_context = io_query->mo_context.
    lv_prefer = to_lower( header( it_headers = it_headers iv_name = 'prefer' ) ).
    rs_response-content_type = 'application/json;odata.metadata=minimal'.

* What the model allows on the set, as on the V2 path: a refused write never
* reaches the DPC.
    IF ( iv_method = 'POST' AND is_set-creatable = abap_false )
        OR ( ( iv_method = 'PATCH' OR iv_method = 'PUT' ) AND is_set-updatable = abap_false )
        OR ( iv_method = 'DELETE' AND is_set-deletable = abap_false ).
      zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not allowed on { is_set-name }| iv_status = 405 ).
    ENDIF.

    CASE iv_method.
      WHEN 'POST'.
        lt_values = values( iv_body = iv_body is_set = is_set io_model = io_model ).
        CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set is_service = io_model->ms_service.
        lo_dpc->create_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
          iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
          it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
          IMPORTING er_entity = lr_entity ).
        IF lr_entity IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'The data provider created nothing' iv_status = 500 ).
        ENDIF.
        ASSIGN lr_entity->* TO <ls_data>.
        lv_location = |{ iv_service_url }/{ is_set-name }({ zcl_osd_v4_json=>key_predicate(
          is_data = <ls_data> is_set = is_set io_model = io_model ) })|.
        add_header( EXPORTING iv_name = 'Location' iv_value = lv_location CHANGING ct_headers = rs_response-headers ).
        lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_data> is_set = is_set io_model = io_model ).
        IF lv_etag IS NOT INITIAL.
          add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
        ENDIF.
        IF lv_prefer CS 'return=minimal'.
          rs_response-status = 204.
          CLEAR rs_response-content_type.
          add_header( EXPORTING iv_name = 'OData-EntityId' iv_value = lv_location CHANGING ct_headers = rs_response-headers ).
          add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'return=minimal' CHANGING ct_headers = rs_response-headers ).
        ELSE.
          rs_response-status = 201.
          rs_response-body = representation( is_data = <ls_data> is_set = is_set io_model = io_model
            iv_service_url = iv_service_url ).
        ENDIF.

      WHEN 'PATCH' OR 'PUT'.
        lt_values = values( iv_body = iv_body is_set = is_set io_model = io_model ).
        lr_current = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        IF lr_current IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
        ENDIF.
        precondition( is_set = is_set io_model = io_model ir_current = lr_current it_headers = it_headers ).
* The key is the one the URL names: a key property in the body cannot move
* the update to another entity.
        LOOP AT lo_context->mt_key_tab INTO ls_key.
          DELETE lt_values WHERE name = ls_key-name.
          ls_value-name = ls_key-name.
          ls_value-value = ls_key-value.
          APPEND ls_value TO lt_values.
        ENDLOOP.
        CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set is_service = io_model->ms_service.
* PATCH lays the request over the entity as it is; PUT replaces it, so a
* property the body leaves out is reset to its initial value.
        IF iv_method = 'PATCH'.
          lo_provider->set_base( lr_current ).
        ENDIF.
        lo_dpc->update_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
          iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
          it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
          IMPORTING er_entity = lr_entity ).
        lr_entity = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        rs_response-status = 204.
        CLEAR rs_response-content_type.
        IF lr_entity IS BOUND.
          ASSIGN lr_entity->* TO <ls_data>.
          lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_data> is_set = is_set io_model = io_model ).
          IF lv_etag IS NOT INITIAL.
            add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
          ENDIF.
          IF lv_prefer CS 'return=representation'.
            rs_response-status = 200.
            rs_response-content_type = 'application/json;odata.metadata=minimal'.
            rs_response-body = representation( is_data = <ls_data> is_set = is_set io_model = io_model
              iv_service_url = iv_service_url ).
            add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'return=representation'
              CHANGING ct_headers = rs_response-headers ).
          ENDIF.
        ENDIF.

      WHEN 'DELETE'.
        lr_current = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        IF lr_current IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
        ENDIF.
        precondition( is_set = is_set io_model = io_model ir_current = lr_current it_headers = it_headers ).
        lo_dpc->delete_entity( iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
          iv_source_name = '' it_key_tab = lo_context->mt_key_tab it_navigation_path = lo_context->mt_navigation_path
          io_tech_request_context = lo_context ).
        rs_response-status = 204.
        CLEAR rs_response-content_type.

      WHEN OTHERS.
        zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not supported| iv_status = 405 ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
