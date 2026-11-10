CLASS zcl_osd_v4_http DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
    CLASS-METHODS dispatch IMPORTING iv_method TYPE string iv_path TYPE string
      it_options TYPE tihttpnvp OPTIONAL iv_origin TYPE string DEFAULT 'http://localhost'
      iv_body TYPE string OPTIONAL it_headers TYPE tihttpnvp OPTIONAL
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
  PRIVATE SECTION.
* the Allow header of a 405, set by run before it refuses a method
    CLASS-DATA gv_allow TYPE string.
    CLASS-METHODS context IMPORTING io_query TYPE REF TO zcl_osd_v4_query
      is_set TYPE zcl_stg_model_info=>ty_entity_set iv_base TYPE string
      RETURNING VALUE(rv_context) TYPE string.
    CLASS-METHODS service_document IMPORTING io_model TYPE REF TO zcl_osd_v4_model iv_base TYPE string
      RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS run IMPORTING iv_method TYPE string iv_path TYPE string
      it_options TYPE tihttpnvp iv_origin TYPE string iv_body TYPE string it_headers TYPE tihttpnvp
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
* the expanded navigations of one row: each item read as a query of the
* target set with the options inside its parentheses (nested $expand
* recurses); it_nav_select are the parent's $select=nav/prop paths
    CLASS-METHODS expand IMPORTING io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      is_row TYPE any it_expand TYPE zcl_osd_v4_query=>ty_expands
      it_nav_select TYPE zcl_osd_v4_query=>ty_nav_selects OPTIONAL
      RETURNING VALUE(rt_nav) TYPE zcl_stg_json=>ty_nav_jsons
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
ENDCLASS.

CLASS zcl_osd_v4_http IMPLEMENTATION.
  METHOD if_http_extension~handle_request.
    DATA lt_options TYPE tihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA ls_header TYPE ihttpnvp.
    DATA lv_proto TYPE string.
    DATA lv_host TYPE string.
    DATA lv_query TYPE string.
    DATA lv_method TYPE string.
    DATA lv_path TYPE string.
    DATA lv_body TYPE string.
    DATA lv_writes TYPE abap_bool.
    DATA lt_headers TYPE tihttpnvp.
* A request starts with no group holding the LUW. The flag is a static and a
* static outlives the request here (on a system each request is a session of
* its own); a batch that dumped never reached its reset, and the next RAP save
* would leave its COMMIT to a group that is gone (ZCL_OSD_LUW_HOLD=>HELD).
    zcl_osd_luw_hold=>hold( abap_false ).
* ANORMALIES: posted-form-has-no-fields, V4 GET addendum. Decode once
* from the raw query: names, form spaces and literal encoded plus signs.
    lv_query = server->request->get_header_field( '~query_string' ).
    IF lv_query IS NOT INITIAL.
      lt_options = zcl_osd_form=>parse( lv_query ).
    ELSE.
      server->request->get_form_fields_cs( CHANGING fields = lt_options ).
    ENDIF.
    lv_proto = server->request->get_header_field( 'x-forwarded-proto' ).
    IF lv_proto IS INITIAL.
      lv_proto = 'http'.
    ENDIF.
    lv_host = server->request->get_header_field( 'host' ).
    lv_method = to_upper( server->request->get_header_field( '~request_method' ) ).
    lv_path = server->request->get_header_field( '~path' ).
    server->request->get_header_fields( CHANGING fields = lt_headers ).
    IF lv_method <> 'GET' AND lv_method <> 'HEAD'.
      lv_body = server->request->get_cdata( ).
    ENDIF.
* One modifying request is one LUW, as in ZCL_STG_HTTP_HANDLER: the COMMIT
* before is the fence, a failure rolls back. $batch brackets its own groups.
    lv_writes = boolc( lv_method <> 'GET' AND lv_method <> 'HEAD' AND lv_path NP '*/$batch' ).
    IF lv_writes = abap_true.
      COMMIT WORK.
    ENDIF.
    ls_response = dispatch( iv_method = lv_method iv_path = lv_path it_options = lt_options
      iv_origin = |{ lv_proto }://{ lv_host }{ server->request->get_header_field( 'x-forwarded-prefix' ) }|
      iv_body = lv_body it_headers = lt_headers ).
    IF lv_writes = abap_true.
      IF ls_response-status >= 400.
        ROLLBACK WORK.
      ELSE.
        COMMIT WORK.
      ENDIF.
    ENDIF.
    server->response->set_header_field( name = 'OData-Version' value = '4.0' ).
* CSRF, as on the V2 path (ZCL_STG_HTTP_HANDLER): the V4 model fetches a
* token with HEAD on the service root before its first write. There is no
* session to protect locally, so any token is accepted; hand one out.
* a sticky session stays named on every answer, or the V4 model takes it for ended
    IF server->request->get_header_field( 'sap-contextid' ) IS NOT INITIAL.
      server->response->set_header_field( name = 'SAP-ContextId' value = server->request->get_header_field( 'sap-contextid' ) ).
    ENDIF.
    IF to_lower( server->request->get_header_field( 'x-csrf-token' ) ) = 'fetch'.
      server->response->set_header_field( name = 'x-csrf-token' value = 'open-steamgate' ).
    ENDIF.
    IF ls_response-content_type IS NOT INITIAL.
      server->response->set_header_field( name = 'content-type' value = ls_response-content_type ).
    ENDIF.
    LOOP AT ls_response-headers INTO ls_header.
      server->response->set_header_field( name = ls_header-name value = ls_header-value ).
    ENDLOOP.
    server->response->set_cdata( ls_response-body ).
    server->response->set_status( code = ls_response-status reason = ls_response-reason ).
  ENDMETHOD.

  METHOD dispatch.
    DATA lx_error TYPE REF TO zcx_stg_error.
    DATA lx_not TYPE REF TO /iwbep/cx_mgw_not_impl_exc.
    DATA lx_busi TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lx_root TYPE REF TO cx_root.
    DATA lv_code TYPE string.
    DATA lv_message TYPE string.
    DATA ls_header TYPE ihttpnvp.
    DATA lv_allow TYPE string.
    DATA lv_method TYPE string.
* a batch dispatches its requests through here again: keep the caller's Allow
    lv_allow = gv_allow.
    CLEAR gv_allow.
    lv_method = to_upper( iv_method ).
* HEAD is GET without the body (RFC 9110 9.3.2)
    IF lv_method = 'HEAD'.
      lv_method = 'GET'.
    ENDIF.
    TRY.
        rs_response = run( iv_method = lv_method iv_path = iv_path it_options = it_options
          iv_origin = iv_origin iv_body = iv_body it_headers = it_headers ).
      CATCH zcx_stg_error INTO lx_error.
        rs_response-status = lx_error->status.
        lv_code = lx_error->code.
        lv_message = lx_error->message.
      CATCH /iwbep/cx_mgw_not_impl_exc INTO lx_not.
        rs_response-status = 501.
        lv_code = 'V4/NOT_IMPLEMENTED'.
        lv_message = |DPC method not implemented: { lx_not->method }|.
      CATCH /iwbep/cx_mgw_busi_exception INTO lx_busi.
        rs_response-status = 400.
        lv_code = 'V4/BUSINESS'.
        lv_message = lx_busi->message_unlimited.
        IF lv_message IS INITIAL.
          lv_message = lx_busi->message.
        ENDIF.
      CATCH cx_root INTO lx_root.
        rs_response-status = 500.
        lv_code = 'V4/TECHNICAL'.
        lv_message = lx_root->get_text( ).
    ENDTRY.
    IF rs_response-status >= 400.
      rs_response-body = '{"error":{"code":' && zcl_osd_v4_json=>quote( lv_code ) &&
        ',"message":' && zcl_osd_v4_json=>quote( lv_message ) && '}}'.
      rs_response-content_type = 'application/json;odata.metadata=minimal'.
    ENDIF.
    CASE rs_response-status.
      WHEN 200.
        rs_response-reason = 'OK'.
      WHEN 201.
        rs_response-reason = 'Created'.
      WHEN 204.
        rs_response-reason = 'No Content'.
      WHEN 400.
        rs_response-reason = 'Bad Request'.
      WHEN 404.
        rs_response-reason = 'Not Found'.
      WHEN 405.
        rs_response-reason = 'Method Not Allowed'.
        ls_header-name = 'Allow'.
        ls_header-value = gv_allow.
        IF ls_header-value IS INITIAL.
          ls_header-value = 'GET'.
        ENDIF.
        APPEND ls_header TO rs_response-headers.
      WHEN 409.
        rs_response-reason = 'Conflict'.
      WHEN 412.
        rs_response-reason = 'Precondition Failed'.
      WHEN 415.
        rs_response-reason = 'Unsupported Media Type'.
      WHEN 424.
        rs_response-reason = 'Failed Dependency'.
      WHEN 428.
        rs_response-reason = 'Precondition Required'.
      WHEN 501.
        rs_response-reason = 'Not Implemented'.
      WHEN OTHERS.
        rs_response-reason = 'Internal Server Error'.
    ENDCASE.
    gv_allow = lv_allow.
    IF to_upper( iv_method ) = 'HEAD'.
      CLEAR rs_response-body.
    ENDIF.
  ENDMETHOD.

  METHOD run.
    DATA lo_query TYPE REF TO zcl_osd_v4_query.
    DATA lo_model TYPE REF TO zcl_osd_v4_model.
    DATA lo_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lr_data TYPE REF TO data.
    DATA lt_nav TYPE zcl_stg_json=>ty_nav_jsons.
    DATA lv_base TYPE string.
    DATA lv_context TYPE string.
    DATA lv_rows TYPE string.
    DATA lv_row TYPE string.
    DATA lv_index TYPE i.
    DATA lv_taken TYPE i.
    DATA lv_count TYPE i.
    DATA lv_count_json TYPE string.
    DATA lv_sep TYPE string.
    DATA ls_paging TYPE /iwbep/s_mgw_paging.
    DATA lv_service_url TYPE string.
    DATA lv_etag TYPE string.
    DATA lo_source TYPE REF TO zcl_osd_v4_query.
    DATA ls_source TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_path TYPE /iwbep/s_mgw_navigation_path.
    DATA lt_none TYPE tihttpnvp.
    DATA lv_source_type TYPE string.
    DATA lv_single TYPE abap_bool.
    DATA lr_buffer TYPE REF TO data.
    DATA ls_action TYPE zcl_stg_model_info=>ty_action.
    DATA lv_op TYPE string.
    DATA lx_error TYPE REF TO zcx_stg_error.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_row> TYPE any.

* a request in a sticky session keeps it alive (and idle ones are dropped)
    zcl_osd_v4_sticky=>touch( it_headers ).
    CREATE OBJECT lo_query EXPORTING iv_path = iv_path it_options = it_options.
    CREATE OBJECT lo_model EXPORTING iv_service = lo_query->ms_request-service.
    lv_service_url = |{ iv_origin }/sap/opu/odata4/sap/{ lo_model->ms_service-name }|.
    lv_base = lv_service_url && '/$metadata'.
    IF lo_query->ms_request-is_batch = abap_true.
      IF iv_method <> 'POST'.
        gv_allow = 'POST'.
        zcl_osd_v4_query=>fail( iv_text = '$batch takes POST' iv_status = 405 ).
      ENDIF.
      rs_response = zcl_osd_v4_batch=>handle( iv_body = iv_body it_headers = it_headers
        iv_service_path = |/sap/opu/odata4/sap/{ lo_model->ms_service-name }| iv_origin = iv_origin ).
      RETURN.
    ENDIF.
    IF iv_method <> 'GET' AND ( lo_query->ms_request-is_metadata = abap_true
        OR lo_query->ms_request-is_service_root = abap_true OR lo_query->ms_request-is_count = abap_true ).
      zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not allowed on this resource| iv_status = 405 ).
    ENDIF.
    rs_response-status = 200.
    rs_response-content_type = 'application/json;odata.metadata=minimal'.
    IF lo_query->ms_request-is_metadata = abap_true.
      rs_response-content_type = 'application/xml'.
      rs_response-body = lo_model->metadata( ).
      RETURN.
    ENDIF.
    IF lo_query->ms_request-is_service_root = abap_true.
      rs_response-body = service_document( io_model = lo_model iv_base = lv_base ).
      RETURN.
    ENDIF.
    IF lo_query->ms_request-entity_set = zcl_osd_v4_sticky=>gc_discard AND lo_query->ms_request-key_string IS INITIAL
        AND lo_query->mv_navigation IS INITIAL AND lo_query->mv_action IS INITIAL
        AND zcl_osd_v4_sticky=>imports_xml( lo_model ) IS NOT INITIAL.
* the unbound DiscardAction of sticky-session editing (ZCL_OSD_V4_STICKY)
      IF iv_method <> 'POST'.
        gv_allow = 'POST'.
        zcl_osd_v4_query=>fail( iv_text = |{ zcl_osd_v4_sticky=>gc_discard } takes POST| iv_status = 405 ).
      ENDIF.
      rs_response = zcl_osd_v4_sticky=>discard( it_headers ).
      RETURN.
    ENDIF.
* an unbound operation at the service root: <FunctionImport>(p=v) or POST <ActionImport>
    READ TABLE lo_model->ms_service-entity_sets WITH KEY name = lo_query->ms_request-entity_set TRANSPORTING NO FIELDS.
    IF sy-subrc <> 0 AND lo_query->mv_navigation IS INITIAL AND lo_query->mv_action IS INITIAL.
      ls_action = zcl_stg_model_info=>find_action( is_service = lo_model->ms_service iv_name = lo_query->ms_request-entity_set ).
      IF ls_action-name IS NOT INITIAL.
        IF lo_query->ms_request-is_count = abap_true.
          zcl_osd_v4_query=>fail( iv_text = 'Unsupported V4 resource path' iv_status = 404 ).
        ENDIF.
        TRY.
            rs_response = zcl_osd_v4_action=>unbound( iv_method = iv_method is_action = ls_action io_query = lo_query
              io_model = lo_model io_dpc = zcl_oao_registry=>create_dpc( lo_model->ms_service-name )
              iv_service_url = lv_service_url iv_body = iv_body ).
          CATCH zcx_stg_error INTO lx_error.
            gv_allow = zcl_osd_v4_action=>gv_allow.
            RAISE EXCEPTION lx_error.
        ENDTRY.
        RETURN.
      ENDIF.
    ENDIF.
    ls_set = zcl_stg_model_info=>find_set( is_service = lo_model->ms_service iv_entity_set = lo_query->ms_request-entity_set ).
    IF lo_query->mv_action IS NOT INITIAL.
      lo_query->prepare( is_set = ls_set io_model = lo_model ).
      lv_op = lo_query->mv_action.
      IF lv_op CP |{ lo_model->ms_service-namespace }.*|.
        lv_op = substring( val = lv_op off = strlen( lo_model->ms_service-namespace ) + 1 ).
      ENDIF.
      lo_dpc = zcl_oao_registry=>create_dpc( lo_model->ms_service-name ).
* The draft actions of sticky editing go to the sticky facade; every other
* bound operation, of a code-based DPC or of one SADL serves (a RAP service:
* its BDEF action runs through the behavior, docs/rap-runtime.md), goes to
* ZCL_OSD_V4_ACTION, which hands it to EXECUTE_ACTION as the V2 path does.
      IF lv_op = zcl_osd_v4_sticky=>gc_edit OR lv_op = zcl_osd_v4_sticky=>gc_save OR lv_op = zcl_osd_v4_sticky=>gc_new.
        IF iv_method <> 'POST'.
          gv_allow = 'POST'.
          zcl_osd_v4_query=>fail( iv_text = 'An action takes POST' iv_status = 405 ).
        ENDIF.
        rs_response = zcl_osd_v4_sticky=>action( iv_action = lo_query->mv_action io_query = lo_query io_model = lo_model
          is_set = ls_set io_dpc = lo_dpc iv_service_url = lv_service_url
          iv_body = iv_body it_headers = it_headers ).
        RETURN.
      ENDIF.
* a bound operation of the model (ZCL_OSD_V4_ACTION): Set(key)/<ns>.<op> or Set/<ns>.<op>
      TRY.
          rs_response = zcl_osd_v4_action=>bound( iv_method = iv_method iv_name = lo_query->mv_action io_query = lo_query
            io_model = lo_model is_set = ls_set io_dpc = lo_dpc
            iv_service_url = lv_service_url iv_body = iv_body it_headers = it_headers ).
        CATCH zcx_stg_error INTO lx_error.
          gv_allow = zcl_osd_v4_action=>gv_allow.
          RAISE EXCEPTION lx_error.
      ENDTRY.
      RETURN.
    ENDIF.
    IF lo_query->mv_navigation IS NOT INITIAL.
* Set(key)/<navigation>: the source entity's key, then the target set read
* the way $expand reads it -- the DPC sees the navigation path and the
* source key, as on the V2 path
      IF iv_method <> 'GET'.
        zcl_osd_v4_query=>fail( iv_text = 'Writes through a navigation property are not implemented' iv_status = 501 ).
      ENDIF.
      ls_nav = zcl_stg_model_info=>find_nav( is_set = ls_set iv_name = lo_query->mv_navigation ).
      CREATE OBJECT lo_source EXPORTING
        iv_path = |/sap/opu/odata4/sap/{ lo_model->ms_service-name }/{ ls_set-name }({ lo_query->ms_request-key_string })|
        it_options = lt_none.
      lo_source->prepare( is_set = ls_set io_model = lo_model ).
      ls_source = ls_set.
      lv_source_type = ls_set-entity_type.
      ls_set = zcl_stg_model_info=>find_set( is_service = lo_model->ms_service iv_entity_set = ls_nav-target_set ).
      lo_query->ms_request-entity_set = ls_set-name.
      CLEAR lo_query->ms_request-key_string.
      IF ls_nav-to_many = abap_false.
        lv_single = abap_true.
        IF lo_query->ms_request-is_count = abap_true.
          zcl_osd_v4_query=>fail( iv_text = '$count requires a collection' ).
        ENDIF.
      ENDIF.
    ENDIF.
    lo_query->prepare( is_set = ls_set io_model = lo_model ).
    lo_context = lo_query->mo_context.
    IF lo_source IS BOUND.
      lo_context->mt_key_tab = lo_source->mo_context->mt_key_tab.
      lo_context->mv_source_entity_set = ls_source-name.
      ls_path-nav_prop = ls_nav-name.
      ls_path-key_tab = lo_context->mt_key_tab.
      ls_path-target_type = ls_nav-target_type.
      ls_path-target_type_namespace = lo_model->ms_service-namespace.
      ls_path-multiplicity = '1'.
      IF ls_nav-to_many = abap_true.
        ls_path-multiplicity = '*'.
      ENDIF.
      APPEND ls_path TO lo_context->mt_navigation_path.
    ENDIF.
    lo_dpc = zcl_oao_registry=>create_dpc( lo_model->ms_service-name ).
* an entity a sticky session holds is read and changed in the session
    IF lo_query->ms_request-key_string IS NOT INITIAL AND lo_source IS NOT BOUND.
      lr_buffer = zcl_osd_v4_sticky=>buffered( it_headers = it_headers iv_service = lo_model->ms_service-name
        iv_set = ls_set-name it_keys = lo_context->mt_key_tab ).
    ENDIF.
    IF lr_buffer IS NOT BOUND AND ( iv_method = 'PATCH' OR iv_method = 'PUT' )
        AND zcl_osd_v4_sticky=>context_id( it_headers ) IS NOT INITIAL
        AND zcl_osd_v4_sticky=>offered( io_model = lo_model is_set = ls_set ) = abap_true.
      zcl_osd_v4_sticky=>refuse( it_headers = it_headers is_set = ls_set ).
    ENDIF.
    IF lr_buffer IS BOUND AND ( iv_method = 'PATCH' OR iv_method = 'PUT' ).
      rs_response = zcl_osd_v4_sticky=>patch( ir_buffer = lr_buffer iv_method = iv_method io_model = lo_model
        is_set = ls_set iv_service_url = lv_service_url iv_body = iv_body it_headers = it_headers ).
      RETURN.
    ENDIF.
    IF iv_method <> 'GET'.
      IF lo_query->ms_request-key_string IS INITIAL AND iv_method <> 'POST'.
        gv_allow = 'GET, POST'.
        zcl_osd_v4_query=>fail( iv_text = |{ iv_method } needs an entity key| iv_status = 405 ).
      ELSEIF lo_query->ms_request-key_string IS NOT INITIAL
          AND iv_method <> 'PATCH' AND iv_method <> 'PUT' AND iv_method <> 'DELETE'.
        gv_allow = 'GET, PATCH, PUT, DELETE'.
        zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not allowed on an entity| iv_status = 405 ).
      ENDIF.
      rs_response = zcl_osd_v4_write=>execute( iv_method = iv_method io_query = lo_query io_model = lo_model
        is_set = ls_set iv_service_url = lv_service_url iv_body = iv_body it_headers = it_headers ).
      RETURN.
    ENDIF.
    lv_context = context( io_query = lo_query is_set = ls_set iv_base = lv_base ).
    IF lo_query->ms_request-key_string IS NOT INITIAL OR lv_single = abap_true.
      IF lr_buffer IS BOUND.
        lr_data = lr_buffer.
      ELSE.
        lo_dpc->get_entity( EXPORTING iv_entity_name = ls_set-entity_type iv_entity_set_name = ls_set-name
          iv_source_name = lv_source_type it_key_tab = lo_context->mt_key_tab it_navigation_path = lo_context->mt_navigation_path
          io_tech_request_context = lo_context IMPORTING er_entity = lr_data ).
      ENDIF.
      IF lr_data IS NOT BOUND AND lv_single = abap_true.
* a single-valued navigation to nothing (OData 4.01 Part 1, 9.1.4)
        rs_response-status = 204.
        CLEAR rs_response-content_type.
        RETURN.
      ELSEIF lr_data IS NOT BOUND.
        zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
      ENDIF.
      ASSIGN lr_data->* TO <ls_row>.
      lt_nav = expand( io_dpc = lo_dpc io_model = lo_model is_set = ls_set is_row = <ls_row> it_expand = lo_query->mt_expand
        it_nav_select = lo_query->mt_nav_select ).
      lv_row = zcl_osd_v4_json=>entity( is_data = <ls_row> is_set = ls_set io_model = lo_model
        it_select = lo_query->mt_select it_nav = lt_nav ).
      lv_context = lv_context && '/$entity'.
      rs_response-body = zcl_osd_v4_json=>document( iv_context = lv_context iv_entity = lv_row ).
      lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_row> is_set = ls_set io_model = lo_model ).
      IF lr_buffer IS BOUND.
* the session's copy carries the ETag its Edit started from (ZCL_OSD_V4_STICKY)
        rs_response-body = zcl_osd_v4_sticky=>stamp( iv_json = rs_response-body iv_computed = lv_etag
          iv_held = zcl_osd_v4_sticky=>held( lr_buffer ) ).
        lv_etag = zcl_osd_v4_sticky=>held( lr_buffer ).
      ENDIF.
      IF lv_etag IS NOT INITIAL.
        zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag
          CHANGING ct_headers = rs_response-headers ).
      ENDIF.
      RETURN.
    ENDIF.
* Read an unpaged collection: counts precede paging, even for DPCs which
* do not implement response_context-inlinecount. Ordering stays in the DPC.
    lo_dpc->get_entityset( EXPORTING iv_entity_name = ls_set-entity_type iv_entity_set_name = ls_set-name
      iv_source_name = lv_source_type it_filter_select_options = lo_context->mt_filter is_paging = ls_paging
      it_key_tab = lo_context->mt_key_tab it_navigation_path = lo_context->mt_navigation_path
      it_order = lo_context->get_sorting_order( ) iv_filter_string = lo_context->mv_filter_string
      iv_search_string = lo_context->mv_search_string io_tech_request_context = lo_context IMPORTING er_entityset = lr_data ).
    IF lr_data IS BOUND.
      ASSIGN lr_data->* TO <lt_rows>.
      lv_count = lines( <lt_rows> ).
      IF lo_query->ms_request-is_count = abap_false.
        LOOP AT <lt_rows> ASSIGNING <ls_row>.
          lv_index = lv_index + 1.
          IF lv_index <= lo_query->mv_skip.
            CONTINUE.
          ENDIF.
          IF lo_query->mv_top >= 0 AND lv_taken >= lo_query->mv_top.
            EXIT.
          ENDIF.
          lt_nav = expand( io_dpc = lo_dpc io_model = lo_model is_set = ls_set is_row = <ls_row> it_expand = lo_query->mt_expand
            it_nav_select = lo_query->mt_nav_select ).
          lv_row = zcl_osd_v4_json=>entity( is_data = <ls_row> is_set = ls_set io_model = lo_model
            it_select = lo_query->mt_select it_nav = lt_nav ).
          lv_rows = lv_rows && lv_sep && lv_row.
          lv_sep = ','.
          lv_taken = lv_taken + 1.
        ENDLOOP.
      ENDIF.
    ENDIF.
    IF lo_query->ms_request-is_count = abap_true.
      rs_response-content_type = 'text/plain'.
      rs_response-body = |{ lv_count }|.
      CONDENSE rs_response-body NO-GAPS.
      RETURN.
    ENDIF.
    IF lo_query->mv_count = abap_true.
      lv_count_json = |,"@odata.count":{ lv_count }|.
    ENDIF.
    rs_response-body = '{"@odata.context":' && zcl_osd_v4_json=>quote( lv_context ) && lv_count_json && ',"value":[' && lv_rows && ']}'.
  ENDMETHOD.

  METHOD context.
    DATA lv_projection TYPE string.
    DATA lv_name TYPE string.
    DATA lv_sep TYPE string.
    DATA ls_item TYPE zcl_osd_v4_query=>ty_expand.
    DATA ls_opt TYPE ihttpnvp.
    DATA lv_inner TYPE string.
    rv_context = iv_base && '#' && is_set-name.
    LOOP AT io_query->mt_select INTO lv_name.
      lv_projection = lv_projection && lv_sep && lv_name.
      lv_sep = ','.
    ENDLOOP.
* an expanded navigation with its own $select names it (OData JSON 4.01, 10.9)
    LOOP AT io_query->mt_expand INTO ls_item.
      CLEAR lv_inner.
      READ TABLE ls_item-options INTO ls_opt WITH KEY name = '$select'.
      IF sy-subrc = 0 AND ls_opt-value <> '*'.
        lv_inner = ls_opt-value.
        CONDENSE lv_inner NO-GAPS.
      ENDIF.
      lv_projection = lv_projection && lv_sep && ls_item-name && '(' && lv_inner && ')'.
      lv_sep = ','.
    ENDLOOP.
    IF lv_projection IS NOT INITIAL.
      rv_context = rv_context && '(' && lv_projection && ')'.
    ENDIF.
    CLEAR lv_sep.
  ENDMETHOD.

  METHOD service_document.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_rows TYPE string.
    DATA lv_sep TYPE string.
    LOOP AT io_model->ms_service-entity_sets INTO ls_set.
      lv_rows = lv_rows && lv_sep && '{"name":' && zcl_osd_v4_json=>quote( ls_set-name ) &&
        ',"kind":"EntitySet","url":' && zcl_osd_v4_json=>quote( ls_set-name ) && '}'.
      lv_sep = ','.
    ENDLOOP.
    rv_json = '{"@odata.context":' && zcl_osd_v4_json=>quote( iv_base ) && ',"value":[' && lv_rows && ']}'.
  ENDMETHOD.

  METHOD expand.
    DATA ls_item TYPE zcl_osd_v4_query=>ty_expand.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA lt_keys TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_path TYPE /iwbep/s_mgw_navigation_path.
    DATA lo_sub TYPE REF TO zcl_osd_v4_query.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lr_data TYPE REF TO data.
    DATA ls_json TYPE zcl_stg_json=>ty_nav_json.
    DATA ls_count TYPE zcl_stg_json=>ty_nav_json.
    DATA ls_paging TYPE /iwbep/s_mgw_paging.
    DATA lt_select TYPE string_table.
    DATA ls_nav_select TYPE zcl_osd_v4_query=>ty_nav_select.
    DATA lt_below TYPE zcl_stg_json=>ty_nav_jsons.
    DATA lv_sep TYPE string.
    DATA lv_index TYPE i.
    DATA lv_taken TYPE i.
    FIELD-SYMBOLS <lv_key> TYPE any.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_row> TYPE any.
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE is_row TO <lv_key>.
      IF sy-subrc = 0.
        ls_key-name = ls_prop-name.
        ls_key-value = <lv_key>.
        APPEND ls_key TO lt_keys.
      ENDIF.
    ENDLOOP.
    LOOP AT it_expand INTO ls_item.
      ls_nav = zcl_stg_model_info=>find_nav( is_set = is_set iv_name = ls_item-name ).
      ls_target = zcl_stg_model_info=>find_set( is_service = io_model->ms_service iv_entity_set = ls_nav-target_set ).
* the options inside the parentheses are a query of the target set: the
* same validation and the same select-options as a request to it
      CREATE OBJECT lo_sub EXPORTING
        iv_path = |/sap/opu/odata4/sap/{ io_model->ms_service-name }/{ ls_target-name }| it_options = ls_item-options.
      lo_sub->prepare( is_set = ls_target io_model = io_model ).
      lo_context = lo_sub->mo_context.
      lo_context->mt_key_tab = lt_keys.
      lo_context->mv_source_entity_set = is_set-name.
      CLEAR ls_path.
      ls_path-nav_prop = ls_nav-name.
      ls_path-key_tab = lt_keys.
      ls_path-target_type = ls_nav-target_type.
      ls_path-target_type_namespace = io_model->ms_service-namespace.
      ls_path-multiplicity = '1'.
      IF ls_nav-to_many = abap_true.
        ls_path-multiplicity = '*'.
      ENDIF.
      APPEND ls_path TO lo_context->mt_navigation_path.
* $select=nav/prop on the parent applies when the expansion has no $select of its own
      lt_select = lo_sub->mt_select.
      IF lt_select IS INITIAL.
        LOOP AT it_nav_select INTO ls_nav_select WHERE nav = ls_nav-name.
          ls_prop = zcl_stg_model_info=>find_property( is_set = ls_target iv_name = ls_nav_select-property ).
          APPEND ls_prop-name TO lt_select.
        ENDLOOP.
      ENDIF.
      CLEAR lr_data.
      CLEAR ls_json.
      ls_json-name = ls_item-name.
      IF ls_nav-to_many = abap_true.
        io_dpc->get_entityset( EXPORTING iv_entity_name = ls_target-entity_type iv_entity_set_name = ls_target-name
          iv_source_name = is_set-entity_type it_filter_select_options = lo_context->mt_filter is_paging = ls_paging
          it_key_tab = lt_keys it_navigation_path = lo_context->mt_navigation_path it_order = lo_context->get_sorting_order( )
          iv_filter_string = lo_context->mv_filter_string iv_search_string = lo_context->mv_search_string
          io_tech_request_context = lo_context IMPORTING er_entityset = lr_data ).
        ls_json-json = '['.
        CLEAR lv_sep.
        lv_index = 0.
        lv_taken = 0.
        IF lr_data IS BOUND.
          ASSIGN lr_data->* TO <lt_rows>.
* counts precede paging, as on the collection itself
          IF lo_sub->mv_count = abap_true.
            ls_count-name = |{ ls_item-name }@odata.count|.
            ls_count-json = |{ lines( <lt_rows> ) }|.
            CONDENSE ls_count-json NO-GAPS.
            APPEND ls_count TO rt_nav.
          ENDIF.
          LOOP AT <lt_rows> ASSIGNING <ls_row>.
            lv_index = lv_index + 1.
            IF lv_index <= lo_sub->mv_skip.
              CONTINUE.
            ENDIF.
            IF lo_sub->mv_top >= 0 AND lv_taken >= lo_sub->mv_top.
              EXIT.
            ENDIF.
            lt_below = expand( io_dpc = io_dpc io_model = io_model is_set = ls_target is_row = <ls_row>
              it_expand = lo_sub->mt_expand it_nav_select = lo_sub->mt_nav_select ).
            ls_json-json = ls_json-json && lv_sep && zcl_osd_v4_json=>entity( is_data = <ls_row> is_set = ls_target
              io_model = io_model it_select = lt_select it_nav = lt_below ).
            lv_sep = ','.
            lv_taken = lv_taken + 1.
          ENDLOOP.
        ELSEIF lo_sub->mv_count = abap_true.
          ls_count-name = |{ ls_item-name }@odata.count|.
          ls_count-json = '0'.
          APPEND ls_count TO rt_nav.
        ENDIF.
        ls_json-json = ls_json-json && ']'.
      ELSE.
        IF lo_sub->mv_count = abap_true OR lo_sub->mv_top >= 0 OR lo_sub->mv_skip > 0
            OR lo_context->mt_orderby IS NOT INITIAL OR lo_context->mt_filter IS NOT INITIAL
            OR lo_context->mv_search_string IS NOT INITIAL.
          zcl_osd_v4_query=>fail( |{ ls_item-name } is a single entity: only $select and $expand apply to it| ).
        ENDIF.
        io_dpc->get_entity( EXPORTING iv_entity_name = ls_target-entity_type iv_entity_set_name = ls_target-name
          iv_source_name = is_set-entity_type it_key_tab = lt_keys it_navigation_path = lo_context->mt_navigation_path
          io_tech_request_context = lo_context IMPORTING er_entity = lr_data ).
        ls_json-json = 'null'.
        IF lr_data IS BOUND.
          ASSIGN lr_data->* TO <ls_row>.
          lt_below = expand( io_dpc = io_dpc io_model = io_model is_set = ls_target is_row = <ls_row>
            it_expand = lo_sub->mt_expand it_nav_select = lo_sub->mt_nav_select ).
          ls_json-json = zcl_osd_v4_json=>entity( is_data = <ls_row> is_set = ls_target io_model = io_model
            it_select = lt_select it_nav = lt_below ).
        ENDIF.
      ENDIF.
      APPEND ls_json TO rt_nav.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
