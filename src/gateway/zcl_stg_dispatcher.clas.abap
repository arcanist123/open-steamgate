CLASS zcl_stg_dispatcher DEFINITION PUBLIC CREATE PUBLIC.
* HTTP verb + OData URL -> the right DPC call -> OData v2 response.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_response,
             status       TYPE i,
             reason       TYPE string,
             content_type TYPE string,
             body         TYPE string,
* the media resource of an entity ($value): bytes, not text
             body_x       TYPE xstring,
             headers      TYPE tihttpnvp,
           END OF ty_response.

    CLASS-METHODS dispatch
      IMPORTING
        iv_method          TYPE string
        iv_path            TYPE string
        it_options         TYPE tihttpnvp OPTIONAL
        iv_host            TYPE string DEFAULT 'localhost'
        iv_body            TYPE string OPTIONAL
        iv_body_x          TYPE xstring OPTIONAL
        iv_content_type    TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response.
  PRIVATE SECTION.
    CLASS-METHODS origin
      IMPORTING
        iv_host          TYPE string
      RETURNING
        VALUE(rv_origin) TYPE string.
    CLASS-METHODS run
      IMPORTING
        iv_method          TYPE string
        iv_path            TYPE string
        it_options         TYPE tihttpnvp
        iv_host            TYPE string
        iv_body            TYPE string
        iv_body_x          TYPE xstring
        iv_content_type    TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

* GET or PUT of <entity>/$value: the DPC's get_stream / update_stream
    CLASS-METHODS media
      IMPORTING
        iv_method          TYPE string
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_body_x          TYPE xstring
        iv_content_type    TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS build_context
      IMPORTING
        is_request        TYPE zcl_stg_url=>ty_request
        is_set            TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING
        VALUE(ro_context) TYPE REF TO zcl_stg_request_context
      RAISING
        zcx_stg_error.

    CLASS-METHODS parse_orderby
      IMPORTING
        iv_orderby      TYPE string
      RETURNING
        VALUE(rt_order) TYPE /iwbep/t_mgw_tech_order.

    CLASS-METHODS read_entity_set
      IMPORTING
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
        it_navigation_path TYPE /iwbep/t_mgw_navigation_path OPTIONAL
        it_key_tab         TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
        iv_source_set      TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS read_entity
      IMPORTING
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
        it_navigation_path TYPE /iwbep/t_mgw_navigation_path OPTIONAL
        it_key_tab         TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
        iv_source_set      TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS navigation_path
      IMPORTING
        is_service     TYPE zcl_stg_model_info=>ty_service
        is_set         TYPE zcl_stg_model_info=>ty_entity_set
        is_request     TYPE zcl_stg_url=>ty_request
      EXPORTING
        es_nav         TYPE zcl_stg_model_info=>ty_nav
        es_target      TYPE zcl_stg_model_info=>ty_entity_set
        et_keys        TYPE /iwbep/t_mgw_name_value_pair
        et_path        TYPE /iwbep/t_mgw_navigation_path
        es_request     TYPE zcl_stg_url=>ty_request
      RAISING
        zcx_stg_error.
    CLASS-METHODS create_through_navigation
      IMPORTING
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
        iv_body            TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.
    CLASS-METHODS read_navigation
      IMPORTING
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS expand_list
      IMPORTING
        is_request     TYPE zcl_stg_url=>ty_request
      RETURNING
        VALUE(rt_navs) TYPE string_table.

    CLASS-METHODS row_keys
      IMPORTING
        is_row            TYPE any
        is_set            TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING
        VALUE(rt_key_tab) TYPE /iwbep/t_mgw_name_value_pair.

    CLASS-METHODS expand_row
      IMPORTING
        io_dpc             TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_row             TYPE any
        it_expand          TYPE string_table
        iv_base_url        TYPE string
        it_tech_clauses    TYPE string_table OPTIONAL
      RETURNING
        VALUE(rt_nav_json) TYPE zcl_stg_json=>ty_nav_jsons
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

* first-level navigation names of the expand paths, and the remaining
* paths below one of them
    CLASS-METHODS expand_levels
      IMPORTING
        it_expand      TYPE string_table
      RETURNING
        VALUE(rt_navs) TYPE string_table.

    CLASS-METHODS expand_below
      IMPORTING
        it_expand      TYPE string_table
        iv_nav         TYPE string
      RETURNING
        VALUE(rt_rest) TYPE string_table.

    CLASS-METHODS expand_tree_of
      IMPORTING
        it_expand      TYPE string_table
      RETURNING
        VALUE(ro_tree) TYPE REF TO zcl_stg_expand_node.

    CLASS-METHODS entities_with_expand
      IMPORTING
        io_dpc             TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        it_rows            TYPE ANY TABLE
        it_expand          TYPE string_table
        iv_base_url        TYPE string
        it_tech_clauses    TYPE string_table OPTIONAL
      RETURNING
        VALUE(rt_entities) TYPE string_table
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS write_entity
      IMPORTING
        iv_method          TYPE string
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_set             TYPE zcl_stg_model_info=>ty_entity_set
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
        iv_body            TYPE string
        it_navigation_path TYPE /iwbep/t_mgw_navigation_path OPTIONAL
        it_key_tab         TYPE /iwbep/t_mgw_name_value_pair OPTIONAL
        iv_source_set      TYPE string OPTIONAL
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS function_import
      IMPORTING
        iv_method          TYPE string
        is_service         TYPE zcl_stg_model_info=>ty_service
        is_action          TYPE zcl_stg_model_info=>ty_action
        is_request         TYPE zcl_stg_url=>ty_request
        iv_base_url        TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response
      RAISING
        zcx_stg_error
        /iwbep/cx_mgw_base_exception.

    CLASS-METHODS expand_tree
      IMPORTING
        it_nested      TYPE tihttpnvp
      RETURNING
        VALUE(ro_tree) TYPE REF TO zcl_stg_expand_node.

    CLASS-METHODS service_document
      IMPORTING
        is_service         TYPE zcl_stg_model_info=>ty_service
        iv_base_url        TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response.

    CLASS-METHODS json_response
      IMPORTING
        iv_status          TYPE i
        iv_body            TYPE string
      RETURNING
        VALUE(rs_response) TYPE ty_response.
ENDCLASS.

CLASS zcl_stg_dispatcher IMPLEMENTATION.

  METHOD origin.
* iv_host is either a bare host (tests, the express server before the
* handler saw a request) or the outside origin incl. scheme and mount prefix
    IF iv_host CS '://'.
      rv_origin = iv_host.
    ELSE.
      rv_origin = |http://{ iv_host }|.
    ENDIF.
  ENDMETHOD.

  METHOD dispatch.
    DATA lx_stg     TYPE REF TO zcx_stg_error.
    DATA lx_not     TYPE REF TO /iwbep/cx_mgw_not_impl_exc.
    DATA lx_busi    TYPE REF TO /iwbep/cx_mgw_busi_exception.
    DATA lx_gateway TYPE REF TO /iwbep/cx_mgw_base_exception.
    DATA lv_message TYPE string.

    TRY.
        rs_response = run( iv_method  = iv_method
                           iv_path    = iv_path
                           it_options = it_options
                           iv_host    = iv_host
                           iv_body    = iv_body
                           iv_body_x  = iv_body_x
                           iv_content_type = iv_content_type ).
      CATCH zcx_stg_error INTO lx_stg.
        rs_response = json_response( iv_status = lx_stg->status
                                     iv_body   = zcl_stg_json=>error( iv_code    = lx_stg->code
                                                                      iv_message = lx_stg->message ) ).
      CATCH /iwbep/cx_mgw_not_impl_exc INTO lx_not.
        rs_response = json_response( iv_status = 501
                                     iv_body   = zcl_stg_json=>error( iv_code    = 'STG/NOT_IMPLEMENTED'
                                                                      iv_message = |DPC method not implemented: { lx_not->method }| ) ).
      CATCH /iwbep/cx_mgw_busi_exception INTO lx_busi.
        lv_message = lx_busi->message_unlimited.
        IF lv_message IS INITIAL.
          lv_message = lx_busi->message.
        ENDIF.
        IF lv_message IS INITIAL.
          lv_message = 'Business exception raised by the data provider'.
        ENDIF.
        rs_response = json_response( iv_status = 400
                                     iv_body   = zcl_stg_json=>error( iv_code    = 'STG/BUSINESS'
                                                                      iv_message = lv_message ) ).
      CATCH /iwbep/cx_mgw_base_exception INTO lx_gateway.
        rs_response = json_response( iv_status = 500
                                     iv_body   = zcl_stg_json=>error( iv_code    = 'STG/TECHNICAL'
                                                                      iv_message = lx_gateway->get_text( ) ) ).
    ENDTRY.
  ENDMETHOD.

  METHOD json_response.
    rs_response-status       = iv_status.
    rs_response-content_type = 'application/json'.
    rs_response-body         = iv_body.
    CASE iv_status.
      WHEN 200.
        rs_response-reason = 'OK'.
      WHEN 201.
        rs_response-reason = 'Created'.
      WHEN 204.
        rs_response-reason = 'No Content'.
        CLEAR rs_response-content_type.
      WHEN 400.
        rs_response-reason = 'Bad Request'.
      WHEN 404.
        rs_response-reason = 'Not Found'.
      WHEN 405.
        rs_response-reason = 'Method Not Allowed'.
      WHEN 501.
        rs_response-reason = 'Not Implemented'.
      WHEN OTHERS.
        rs_response-reason = 'Error'.
    ENDCASE.
  ENDMETHOD.

  METHOD run.
    DATA ls_request TYPE zcl_stg_url=>ty_request.
    DATA ls_service TYPE zcl_stg_model_info=>ty_service.
    DATA ls_set     TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_action  TYPE zcl_stg_model_info=>ty_action.
    DATA lv_base    TYPE string.
    DATA lv_method  TYPE string.

    ls_request = zcl_stg_url=>parse( iv_path    = iv_path
                                     it_options = it_options ).
    ls_service = zcl_stg_model_info=>get( ls_request-service ).
    zcl_stg_json=>register_sets( ls_service-entity_sets ).
    lv_base    = |{ origin( iv_host ) }/sap/opu/odata/sap/{ ls_service-name }|.
    lv_method  = to_upper( iv_method ).

    IF ls_request-is_metadata = abap_true.
      rs_response-status       = 200.
      rs_response-reason       = 'OK'.
      rs_response-content_type = 'application/xml'.
      rs_response-body         = zcl_oao_http_handler=>handle( iv_path )-data.
      RETURN.
    ENDIF.

    IF ls_request-is_service_root = abap_true.
      rs_response = service_document( is_service  = ls_service
                                      iv_base_url = lv_base ).
      RETURN.
    ENDIF.

    IF ls_request-is_batch = abap_true.
      IF lv_method <> 'POST'.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status  = 405
            code    = 'STG/METHOD_NOT_ALLOWED'
            message = '$batch takes POST'.
      ENDIF.
      rs_response = zcl_stg_batch=>handle( iv_body         = iv_body
                                            iv_body_x       = iv_body_x
                                           iv_content_type = iv_content_type
                                           iv_service_path = |/sap/opu/odata/sap/{ ls_service-name }|
                                           iv_host         = iv_host ).
      RETURN.
    ENDIF.

* a segment that is not an entity set may be a function import
    READ TABLE ls_service-entity_sets TRANSPORTING NO FIELDS WITH KEY name = ls_request-entity_set.
    IF sy-subrc <> 0.
      ls_action = zcl_stg_model_info=>find_action( is_service = ls_service
                                                   iv_name    = ls_request-entity_set ).
      IF ls_action-name IS NOT INITIAL.
        rs_response = function_import( iv_method   = lv_method
                                       is_service  = ls_service
                                       is_action   = ls_action
                                       is_request  = ls_request
                                       iv_base_url = lv_base ).
        RETURN.
      ENDIF.
    ENDIF.

    ls_set = zcl_stg_model_info=>find_set( is_service    = ls_service
                                           iv_entity_set = ls_request-entity_set ).

    IF ls_request-is_value = abap_true.
      rs_response = media( iv_method       = lv_method
                           is_service      = ls_service
                           is_set          = ls_set
                           is_request      = ls_request
                           iv_body_x       = iv_body_x
                           iv_content_type = iv_content_type ).
      RETURN.
    ENDIF.

    IF ls_request-nav_prop IS NOT INITIAL.
      IF lv_method = 'GET'.
        rs_response = read_navigation( is_service  = ls_service
                                       is_set      = ls_set
                                       is_request  = ls_request
                                       iv_base_url = lv_base ).
        RETURN.
      ENDIF.
      IF lv_method = 'POST' AND ls_request-nav_key_string IS INITIAL.
* POST TravelSet('T0001')/to_Bookings: create in the target set, the source
* keys and the navigation path tell the DPC whose child it is
        rs_response = create_through_navigation( is_service  = ls_service
                                                 is_set      = ls_set
                                                 is_request  = ls_request
                                                 iv_base_url = lv_base
                                                 iv_body     = iv_body ).
        RETURN.
      ENDIF.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 501
          code    = 'STG/NOT_IMPLEMENTED'
          message = |{ lv_method } through a navigation property is not implemented|.
    ENDIF.

    IF lv_method <> 'GET'.
      rs_response = write_entity( iv_method   = lv_method
                                  is_service  = ls_service
                                  is_set      = ls_set
                                  is_request  = ls_request
                                  iv_base_url = lv_base
                                  iv_body     = iv_body ).
      RETURN.
    ENDIF.

    IF ls_request-key_string IS INITIAL.
      rs_response = read_entity_set( is_service  = ls_service
                                     is_set      = ls_set
                                     is_request  = ls_request
                                     iv_base_url = lv_base ).
    ELSE.
      rs_response = read_entity( is_service  = ls_service
                                 is_set      = ls_set
                                 is_request  = ls_request
                                 iv_base_url = lv_base ).
    ENDIF.
  ENDMETHOD.

  METHOD media.
* The media resource of an entity: a media entity type (set_is_media in the
* MPC) answers <entity>/$value with bytes, and the DPC is the one holding
* them. er_stream of get_stream is a reference to the media resource the
* interface declares (mime type + value), which is what a SEGW-generated
* DPC hands back through copy_data_to_ref.
    DATA lo_dpc     TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lr_stream  TYPE REF TO data.
    DATA ls_media   TYPE /iwbep/if_mgw_appl_types=>ty_s_media_resource.
    FIELD-SYMBOLS <ls_media> TYPE /iwbep/if_mgw_appl_types=>ty_s_media_resource.

    IF is_set-is_media = abap_false.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/NOT_A_MEDIA_ENTITY'
          message = |{ is_set-name } is not a media entity set|.
    ENDIF.
    IF is_request-key_string IS INITIAL.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/KEY_MISSING'
          message = |$value needs an entity key|.
    ENDIF.

    lo_dpc     = zcl_oao_registry=>create_dpc( is_service-name ).
    lo_context = build_context( is_request = is_request
                                is_set     = is_set ).

    CASE iv_method.
      WHEN 'GET'.
        lo_dpc->get_stream(
          EXPORTING
            iv_entity_name          = is_set-entity_type
            iv_entity_set_name      = is_set-name
            iv_source_name          = ''
            it_key_tab              = lo_context->mt_key_tab
            io_tech_request_context = lo_context
          IMPORTING
            er_stream               = lr_stream ).
        IF lr_stream IS NOT BOUND.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status  = 404
              code    = 'STG/ENTITY_NOT_FOUND'
              message = |{ is_set-name }({ is_request-key_string }) has no media resource|.
        ENDIF.
        ASSIGN lr_stream->* TO <ls_media>.
        rs_response-status       = 200.
        rs_response-reason       = 'OK'.
        rs_response-content_type = <ls_media>-mime_type.
        IF rs_response-content_type IS INITIAL.
          rs_response-content_type = 'application/octet-stream'.
        ENDIF.
        rs_response-body_x = <ls_media>-value.
      WHEN 'PUT'.
        ls_media-mime_type = iv_content_type.
        ls_media-value     = iv_body_x.
        lo_dpc->update_stream(
          EXPORTING
            iv_entity_name          = is_set-entity_type
            iv_entity_set_name      = is_set-name
            iv_source_name          = ''
            is_media_resource       = ls_media
            it_key_tab              = lo_context->mt_key_tab
            io_tech_request_context = lo_context ).
        rs_response-status = 204.
        rs_response-reason = 'No Content'.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status  = 405
            code    = 'STG/METHOD_NOT_ALLOWED'
            message = |{ iv_method } on $value is not implemented|.
    ENDCASE.
  ENDMETHOD.

  METHOD write_entity.
    DATA lo_dpc      TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA lo_provider TYPE REF TO zcl_stg_entry_provider.
    DATA lt_nav_path TYPE /iwbep/t_mgw_navigation_path.
    DATA lr_entity   TYPE REF TO data.
    DATA ls_header   TYPE ihttpnvp.
    DATA lv_location TYPE string.
    DATA lt_values   TYPE tihttpnvp.
    DATA lt_nested   TYPE tihttpnvp.
    DATA ls_source   TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_source_name TYPE string.
    FIELD-SYMBOLS <ls_data> TYPE any.

    lo_dpc     = zcl_oao_registry=>create_dpc( is_service-name ).
    lo_context = build_context( is_request = is_request
                                is_set     = is_set ).
    IF it_navigation_path IS NOT INITIAL.
      lo_context->mt_key_tab           = it_key_tab.
      lo_context->mt_navigation_path   = it_navigation_path.
      lo_context->mv_source_entity_set = iv_source_set.
      lt_nav_path = it_navigation_path.
      ls_source = zcl_stg_model_info=>find_set( is_service    = is_service
                                                iv_entity_set = iv_source_set ).
      lv_source_name = ls_source-entity_type.
    ENDIF.

* what the model says the set allows: a refusal here is the Gateway's, before
* any DPC method is looked for
    IF ( iv_method = 'POST' AND is_set-creatable = abap_false )
        OR ( ( iv_method = 'PUT' OR iv_method = 'PATCH' OR iv_method = 'MERGE' ) AND is_set-updatable = abap_false )
        OR ( iv_method = 'DELETE' AND is_set-deletable = abap_false ).
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 405
          code    = 'STG/METHOD_NOT_ALLOWED'
          message = |{ is_set-name } is not { COND string( WHEN iv_method = 'POST' THEN 'creatable' WHEN iv_method = 'DELETE' THEN 'deletable' ELSE 'updatable' ) }|.
    ENDIF.

    CASE iv_method.
      WHEN 'POST'.
        IF is_request-key_string IS NOT INITIAL.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status  = 405
              code    = 'STG/METHOD_NOT_ALLOWED'
              message = 'POST goes to the entity set, not to an entity'.
        ENDIF.
        lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json   = iv_body
                                                IMPORTING et_nested = lt_nested ).
        CREATE OBJECT lo_provider
          EXPORTING
            it_values  = lt_values
            it_nested  = lt_nested
            is_set     = is_set
            is_service = is_service.
        IF lt_nested IS NOT INITIAL.
* navigation payload inside the body: a deep insert
          lo_dpc->create_deep_entity(
            EXPORTING
              iv_entity_name          = is_set-entity_type
              iv_entity_set_name      = is_set-name
              iv_source_name          = ''
              io_data_provider        = lo_provider
              it_key_tab              = lo_context->mt_key_tab
              it_navigation_path      = lt_nav_path
              io_expand               = expand_tree( lt_nested )
              io_tech_request_context = lo_context
            IMPORTING
              er_deep_entity          = lr_entity ).
        ELSE.
          lo_dpc->create_entity(
            EXPORTING
              iv_entity_name          = is_set-entity_type
              iv_entity_set_name      = is_set-name
              iv_source_name          = lv_source_name
              io_data_provider        = lo_provider
              it_key_tab              = lo_context->mt_key_tab
              it_navigation_path      = lt_nav_path
              io_tech_request_context = lo_context
            IMPORTING
              er_entity               = lr_entity ).
        ENDIF.
        IF lr_entity IS NOT BOUND.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status  = 500
              code    = 'STG/NO_ENTITY'
              message = 'The data provider created nothing'.
        ENDIF.
        ASSIGN lr_entity->* TO <ls_data>.
        rs_response = json_response( iv_status = 201
                                     iv_body   = zcl_stg_json=>entry( is_data      = <ls_data>
                                                                      is_set       = is_set
                                                                      iv_namespace = is_service-namespace
                                                                      iv_base_url  = iv_base_url ) ).
        ls_header-name  = 'location'.
        lv_location = zcl_stg_url=>escape_key( zcl_stg_json=>key_predicate( is_data = <ls_data>
                                                                             is_set  = is_set ) ).
        ls_header-value = |{ iv_base_url }/{ is_set-name }({ lv_location })|.
        APPEND ls_header TO rs_response-headers.

      WHEN 'PUT' OR 'PATCH' OR 'MERGE'.
        IF is_request-key_string IS INITIAL.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status  = 405
              code    = 'STG/METHOD_NOT_ALLOWED'
              message = |{ iv_method } needs an entity key|.
        ENDIF.
        lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json   = iv_body
                                                IMPORTING et_nested = lt_nested ).
        CREATE OBJECT lo_provider
          EXPORTING
            it_values  = lt_values
            it_nested  = lt_nested
            is_set     = is_set
            is_service = is_service.
* PATCH and MERGE change only the properties sent: as the Gateway does, read
* the entity first and let the provider lay the request over it
        IF iv_method <> 'PUT'.
          lo_dpc->get_entity(
            EXPORTING
              iv_entity_name          = is_set-entity_type
              iv_entity_set_name      = is_set-name
              iv_source_name          = ''
              it_key_tab              = lo_context->mt_key_tab
              it_navigation_path      = lt_nav_path
              io_tech_request_context = lo_context
            IMPORTING
              er_entity               = lr_entity ).
          IF lr_entity IS BOUND.
            lo_provider->set_base( lr_entity ).
          ENDIF.
        ENDIF.
        lo_dpc->update_entity(
          EXPORTING
            iv_entity_name          = is_set-entity_type
            iv_entity_set_name      = is_set-name
            iv_source_name          = ''
            io_data_provider        = lo_provider
            it_key_tab              = lo_context->mt_key_tab
            it_navigation_path      = lt_nav_path
            io_tech_request_context = lo_context
          IMPORTING
            er_entity               = lr_entity ).
        rs_response = json_response( iv_status = 204
                                     iv_body   = '' ).

      WHEN 'DELETE'.
        IF is_request-key_string IS INITIAL.
          RAISE EXCEPTION TYPE zcx_stg_error
            EXPORTING
              status  = 405
              code    = 'STG/METHOD_NOT_ALLOWED'
              message = 'DELETE needs an entity key'.
        ENDIF.
        lo_dpc->delete_entity(
          iv_entity_name          = is_set-entity_type
          iv_entity_set_name      = is_set-name
          iv_source_name          = ''
          it_key_tab              = lo_context->mt_key_tab
          it_navigation_path      = lt_nav_path
          io_tech_request_context = lo_context ).
        rs_response = json_response( iv_status = 204
                                     iv_body   = '' ).

      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status  = 501
            code    = 'STG/VERB_NOT_IMPLEMENTED'
            message = |{ iv_method } is not implemented|.
    ENDCASE.
  ENDMETHOD.

  METHOD function_import.
    DATA lo_dpc       TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context   TYPE REF TO zcl_stg_request_context.
    DATA lt_parameter TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_parameter TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_property  TYPE zcl_stg_model_info=>ty_property.
    DATA ls_option    TYPE ihttpnvp.
    DATA lr_data      TYPE REF TO data.
    DATA ls_set       TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_kind      TYPE c LENGTH 1.
    DATA lv_value     TYPE string.
    FIELD-SYMBOLS <lt_data> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_data> TYPE any.
    FIELD-SYMBOLS <lv_data> TYPE any.

    IF iv_method <> is_action-http_method.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 405
          code    = 'STG/METHOD_NOT_ALLOWED'
          message = |Function import { is_action-name } takes { is_action-http_method }|.
    ENDIF.

* parameters come as query options, quoted like key values
    LOOP AT is_action-parameters INTO ls_property.
      CLEAR ls_parameter.
      ls_parameter-name = ls_property-name.
      LOOP AT is_request-options INTO ls_option.
        IF to_lower( ls_option-name ) = to_lower( ls_property-name ).
          ls_parameter-value = zcl_stg_url=>unquote( ls_option-value ).
          zcl_stg_model_info=>check_length( is_property = ls_property
                                            iv_value    = ls_parameter-value
                                            iv_what     = |Parameter of { is_action-name }:| ).
        ENDIF.
      ENDLOOP.
      APPEND ls_parameter TO lt_parameter.
    ENDLOOP.

    lo_dpc = zcl_oao_registry=>create_dpc( is_service-name ).
    CREATE OBJECT lo_context.
    lo_context->mv_entity_set  = is_action-return_entity_set.
    lo_context->mv_entity_type = is_action-return_entity_type.
    lo_context->mv_function_import = is_action-name.
    lo_context->mt_parameter       = lt_parameter.
* an action for an entity type names no set of its own (SEGW leaves it
* empty); a provider that is only given the context finds it by the type
    IF lo_context->mv_entity_set IS INITIAL AND is_action-return_entity_type IS NOT INITIAL.
      LOOP AT is_service-entity_sets INTO ls_set WHERE entity_type = is_action-return_entity_type.
        lo_context->mv_entity_set = ls_set-name.
        EXIT.
      ENDLOOP.
      CLEAR ls_set.
    ENDIF.

    lo_dpc->execute_action(
      EXPORTING
        iv_action_name          = is_action-name
        it_parameter            = lt_parameter
        io_tech_request_context = lo_context
      IMPORTING
        er_data                 = lr_data ).

    IF lr_data IS NOT BOUND.
      rs_response = json_response( iv_status = 204
                                   iv_body   = '' ).
      RETURN.
    ENDIF.

    IF is_action-return_entity_set IS NOT INITIAL.
      ls_set = zcl_stg_model_info=>find_set( is_service    = is_service
                                             iv_entity_set = is_action-return_entity_set ).
    ELSEIF is_action-return_entity_type IS NOT INITIAL.
      LOOP AT is_service-entity_sets INTO ls_set WHERE entity_type = is_action-return_entity_type.
        EXIT.
      ENDLOOP.
    ENDIF.

    ASSIGN lr_data->* TO <lv_data>.
    DESCRIBE FIELD <lv_data> TYPE lv_kind.
    IF lv_kind = 'h'.
      ASSIGN lr_data->* TO <lt_data>.
      rs_response = json_response( iv_status = 200
                                   iv_body   = zcl_stg_json=>feed( it_data      = <lt_data>
                                                                   is_set       = ls_set
                                                                   iv_namespace = is_service-namespace
                                                                   iv_base_url  = iv_base_url ) ).
    ELSEIF lv_kind = 'u' OR lv_kind = 'v'.
      ASSIGN lr_data->* TO <ls_data>.
      rs_response = json_response( iv_status = 200
                                   iv_body   = zcl_stg_json=>entry( is_data      = <ls_data>
                                                                    is_set       = ls_set
                                                                    iv_namespace = is_service-namespace
                                                                    iv_base_url  = iv_base_url ) ).
    ELSE.
* primitive return: {"d":{"<Name>":value}}
      lv_value = zcl_stg_json=>value( iv_value    = <lv_data>
                                      iv_edm_type = 'Edm.String' ).
      IF lv_kind = 'I' OR lv_kind = 'P' OR lv_kind = 'F' OR lv_kind = 'b' OR lv_kind = 's' OR lv_kind = '8'.
        lv_value = zcl_stg_json=>value( iv_value    = <lv_data>
                                        iv_edm_type = 'Edm.Int32' ).
      ENDIF.
      rs_response = json_response( iv_status = 200
                                   iv_body   = |\{"d":\{"{ is_action-name }":{ lv_value }\}\}| ).
    ENDIF.
  ENDMETHOD.

  METHOD expand_tree.
    DATA ls_nested LIKE LINE OF it_nested.
    DATA lo_child  TYPE REF TO zcl_stg_expand_node.

    CREATE OBJECT ro_tree.
    LOOP AT it_nested INTO ls_nested.
      CREATE OBJECT lo_child.
      ro_tree->add_child( iv_name = ls_nested-name
                          io_node = lo_child ).
    ENDLOOP.
  ENDMETHOD.

  METHOD service_document.
    DATA ls_set  LIKE LINE OF is_service-entity_sets.
    DATA lv_sets TYPE string.

    LOOP AT is_service-entity_sets INTO ls_set.
      IF lv_sets IS INITIAL.
        lv_sets = |"{ ls_set-name }"|.
      ELSE.
        lv_sets = |{ lv_sets },"{ ls_set-name }"|.
      ENDIF.
    ENDLOOP.
    rs_response = json_response( iv_status = 200
                                 iv_body   = |\{"d":\{"EntitySets":[{ lv_sets }]\}\}| ).
  ENDMETHOD.

  METHOD parse_orderby.
    DATA lt_parts TYPE string_table.
    DATA lv_part  TYPE string.
    DATA ls_order TYPE /iwbep/s_mgw_tech_order.
    DATA lv_dir   TYPE string.

    SPLIT iv_orderby AT ',' INTO TABLE lt_parts.
    LOOP AT lt_parts INTO lv_part.
      CONDENSE lv_part.
      IF lv_part IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR ls_order.
      SPLIT lv_part AT space INTO ls_order-property lv_dir.
      CONDENSE lv_dir.
      IF to_lower( lv_dir ) = 'desc'.
        ls_order-order = 'desc'.
      ELSE.
        ls_order-order = 'asc'.
      ENDIF.
      ls_order-property_path = ls_order-property.
      APPEND ls_order TO rt_order.
    ENDLOOP.
  ENDMETHOD.

  METHOD build_context.
    DATA lv_value TYPE string.

    CREATE OBJECT ro_context.
    ro_context->mv_entity_set  = is_set-name.
    ro_context->mv_entity_type = is_set-entity_type.
    ro_context->ms_set         = is_set.
    ro_context->mv_count       = is_request-is_count.
    ro_context->mv_aggregate   = is_set-aggregate.
    ro_context->mv_select      = zcl_stg_url=>option( is_request = is_request
                                                      iv_name    = '$select' ).

    lv_value = zcl_stg_url=>option( is_request = is_request
                                    iv_name    = '$top' ).
    IF lv_value IS NOT INITIAL.
      ro_context->mv_top = lv_value.
    ENDIF.

    lv_value = zcl_stg_url=>option( is_request = is_request
                                    iv_name    = '$skip' ).
    IF lv_value IS NOT INITIAL.
      ro_context->mv_skip = lv_value.
    ENDIF.

    lv_value = zcl_stg_url=>option( is_request = is_request
                                    iv_name    = '$inlinecount' ).
    IF to_lower( lv_value ) = 'allpages'.
      ro_context->mv_inlinecount = abap_true.
    ENDIF.

    lv_value = zcl_stg_url=>option( is_request = is_request
                                    iv_name    = '$orderby' ).
    IF lv_value IS NOT INITIAL.
      ro_context->mt_orderby = parse_orderby( lv_value ).
    ENDIF.

    ro_context->mv_search_string = zcl_stg_url=>option( is_request = is_request
                                                        iv_name    = 'search' ).
    lv_value = zcl_stg_url=>option( is_request = is_request
                                    iv_name    = '$filter' ).
    IF lv_value IS NOT INITIAL.
      ro_context->mv_filter_string = lv_value.
      ro_context->mt_filter = zcl_stg_filter=>parse( iv_filter = lv_value
                                                     is_set    = is_set ).
    ENDIF.

    ro_context->mt_key_tab = zcl_stg_url=>parse_keys(
      iv_key_string = is_request-key_string
      it_key_names  = zcl_stg_model_info=>key_names( is_set ) ).
    zcl_stg_model_info=>check_keys( is_set     = is_set
                                    it_key_tab = ro_context->mt_key_tab ).
  ENDMETHOD.

  METHOD read_entity_set.
    DATA lo_dpc       TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context   TYPE REF TO zcl_stg_request_context.
    DATA lt_nav_path  TYPE /iwbep/t_mgw_navigation_path.
    DATA ls_paging    TYPE /iwbep/s_mgw_paging.
    DATA lr_entityset TYPE REF TO data.
    DATA ls_context   TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context.
    DATA lv_count     TYPE string.
    DATA lt_expand    TYPE string_table.
    DATA lt_entities  TYPE string_table.
    DATA lt_tech_clauses TYPE string_table.
    FIELD-SYMBOLS <lt_data> TYPE ANY TABLE.

    lo_dpc     = zcl_oao_registry=>create_dpc( is_service-name ).
    lo_context = build_context( is_request = is_request
                                is_set     = is_set ).
    IF it_key_tab IS SUPPLIED.
      lo_context->mt_key_tab = it_key_tab.
    ENDIF.
    lt_nav_path = it_navigation_path.
    lo_context->mt_navigation_path   = it_navigation_path.
    lo_context->mv_source_entity_set = iv_source_set.
    lo_context->mt_navigation_path   = it_navigation_path.
    lo_context->mv_source_entity_set = iv_source_set.
    IF is_request-is_count = abap_false.
      ls_paging = lo_context->get_paging( ).
    ENDIF.

    lt_expand = expand_list( is_request ).
    IF lt_expand IS INITIAL OR is_request-is_count = abap_true.
      lo_dpc->get_entityset(
        EXPORTING
          iv_entity_name           = is_set-entity_type
          iv_entity_set_name       = is_set-name
          iv_source_name           = ''
          it_filter_select_options = lo_context->mt_filter
          is_paging                = ls_paging
          it_key_tab               = lo_context->mt_key_tab
          it_navigation_path       = lt_nav_path
          it_order                 = lo_context->get_sorting_order( )
          iv_filter_string         = lo_context->mv_filter_string
          iv_search_string         = lo_context->mv_search_string
          io_tech_request_context  = lo_context
        IMPORTING
          er_entityset             = lr_entityset
          es_response_context      = ls_context ).
    ELSE.
* a DPC may expand itself (deep structures + et_expanded_tech_clauses);
* the framework base falls back to get_entityset and leaves the rest to us
      lo_dpc->get_expanded_entityset(
        EXPORTING
          iv_entity_name           = is_set-entity_type
          iv_entity_set_name       = is_set-name
          iv_source_name           = ''
          it_filter_select_options = lo_context->mt_filter
          is_paging                = ls_paging
          it_key_tab               = lo_context->mt_key_tab
          it_navigation_path       = lt_nav_path
          it_order                 = lo_context->get_sorting_order( )
          iv_filter_string         = lo_context->mv_filter_string
          iv_search_string         = ''
          io_expand                = expand_tree_of( lt_expand )
          io_tech_request_context  = lo_context
        IMPORTING
          er_entityset             = lr_entityset
          et_expanded_tech_clauses = lt_tech_clauses
          es_response_context      = ls_context ).
    ENDIF.

    IF lr_entityset IS BOUND.
      ASSIGN lr_entityset->* TO <lt_data>.
    ENDIF.

    IF is_request-is_count = abap_true.
      IF <lt_data> IS ASSIGNED.
        lv_count = |{ lines( <lt_data> ) }|.
      ELSE.
        lv_count = '0'.
      ENDIF.
      CONDENSE lv_count NO-GAPS.
      rs_response-status       = 200.
      rs_response-reason       = 'OK'.
      rs_response-content_type = 'text/plain'.
      rs_response-body         = lv_count.
      RETURN.
    ENDIF.

    IF lo_context->mv_inlinecount = abap_true.
      lv_count = ls_context-inlinecount.
      IF lv_count IS INITIAL AND <lt_data> IS ASSIGNED.
* the DPC did not count for us: count what it returned
        lv_count = |{ lines( <lt_data> ) }|.
        CONDENSE lv_count NO-GAPS.
      ENDIF.
    ENDIF.

    IF <lt_data> IS ASSIGNED AND lt_expand IS NOT INITIAL.
      lt_entities = entities_with_expand( io_dpc          = lo_dpc
                                          is_service      = is_service
                                          is_set          = is_set
                                          it_rows         = <lt_data>
                                          it_expand       = lt_expand
                                          iv_base_url     = iv_base_url
                                          it_tech_clauses = lt_tech_clauses ).
      rs_response = json_response( iv_status = 200
                                   iv_body   = zcl_stg_json=>feed_of( it_entities    = lt_entities
                                                                      iv_inlinecount = lv_count ) ).
    ELSEIF <lt_data> IS ASSIGNED.
      rs_response = json_response( iv_status = 200
                                   iv_body   = zcl_stg_json=>feed( it_data        = <lt_data>
                                                                   is_set         = is_set
                                                                   iv_namespace   = is_service-namespace
                                                                   iv_base_url    = iv_base_url
                                                                   iv_inlinecount = lv_count ) ).
    ELSE.
      rs_response = json_response( iv_status = 200
                                   iv_body   = '{"d":{"results":[]}}' ).
    ENDIF.
  ENDMETHOD.

  METHOD read_entity.
    DATA lo_dpc      TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA lt_nav_path TYPE /iwbep/t_mgw_navigation_path.
    DATA lr_entity   TYPE REF TO data.
    DATA lt_expand   TYPE string_table.
    DATA lt_nav_json TYPE zcl_stg_json=>ty_nav_jsons.
    DATA lt_tech_clauses TYPE string_table.
    FIELD-SYMBOLS <ls_data> TYPE any.

    lo_dpc     = zcl_oao_registry=>create_dpc( is_service-name ).
    lo_context = build_context( is_request = is_request
                                is_set     = is_set ).
    IF it_key_tab IS SUPPLIED.
      lo_context->mt_key_tab = it_key_tab.
    ENDIF.
    lt_nav_path = it_navigation_path.
    lo_context->mt_navigation_path   = it_navigation_path.
    lo_context->mv_source_entity_set = iv_source_set.

    lt_expand = expand_list( is_request ).
    IF lt_expand IS INITIAL.
      lo_dpc->get_entity(
        EXPORTING
          iv_entity_name          = is_set-entity_type
          iv_entity_set_name      = is_set-name
          iv_source_name          = ''
          it_key_tab              = lo_context->mt_key_tab
          it_navigation_path      = lt_nav_path
          io_tech_request_context = lo_context
        IMPORTING
          er_entity               = lr_entity ).
    ELSE.
      lo_dpc->get_expanded_entity(
        EXPORTING
          iv_entity_name          = is_set-entity_type
          iv_entity_set_name      = is_set-name
          iv_source_name          = ''
          it_key_tab              = lo_context->mt_key_tab
          it_navigation_path      = lt_nav_path
          io_expand               = expand_tree_of( lt_expand )
          io_tech_request_context = lo_context
        IMPORTING
          er_entity               = lr_entity
          et_expanded_tech_clauses = lt_tech_clauses ).
    ENDIF.

    IF lr_entity IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 404
          code    = 'STG/ENTITY_NOT_FOUND'
          message = |{ is_set-name }({ is_request-key_string }) not found|.
    ENDIF.
    ASSIGN lr_entity->* TO <ls_data>.

    IF lt_expand IS NOT INITIAL.
      lt_nav_json = expand_row( io_dpc          = lo_dpc
                                is_service      = is_service
                                is_set          = is_set
                                is_row          = <ls_data>
                                it_expand       = lt_expand
                                iv_base_url     = iv_base_url
                                it_tech_clauses = lt_tech_clauses ).
    ENDIF.

    rs_response = json_response( iv_status = 200
                                 iv_body   = zcl_stg_json=>entry( is_data      = <ls_data>
                                                                  is_set       = is_set
                                                                  iv_namespace = is_service-namespace
                                                                  iv_base_url  = iv_base_url
                                                                  it_nav_json  = lt_nav_json ) ).
  ENDMETHOD.

  METHOD expand_list.
    DATA lv_expand TYPE string.
    DATA lt_parts  TYPE string_table.
    DATA lv_part   TYPE string.

    lv_expand = zcl_stg_url=>option( is_request = is_request
                                     iv_name    = '$expand' ).
    IF lv_expand IS INITIAL.
      RETURN.
    ENDIF.
    SPLIT lv_expand AT ',' INTO TABLE lt_parts.
    LOOP AT lt_parts INTO lv_part.
      CONDENSE lv_part.
      IF lv_part IS INITIAL.
        CONTINUE.
      ENDIF.
* full paths, a/b included; expand_row splits them per level
      READ TABLE rt_navs WITH KEY table_line = lv_part TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND lv_part TO rt_navs.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD row_keys.
    DATA ls_property LIKE LINE OF is_set-properties.
    DATA ls_key      TYPE /iwbep/s_mgw_name_value_pair.
    FIELD-SYMBOLS <lv_field> TYPE any.

    LOOP AT is_set-properties INTO ls_property WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_property-fieldname OF STRUCTURE is_row TO <lv_field>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      CLEAR ls_key.
      ls_key-name  = ls_property-name.
      ls_key-value = <lv_field>.
      APPEND ls_key TO rt_key_tab.
    ENDLOOP.
  ENDMETHOD.

  METHOD expand_levels.
    DATA lv_path  TYPE string.
    DATA lv_first TYPE string.
    DATA lv_rest  TYPE string.

    LOOP AT it_expand INTO lv_path.
      SPLIT lv_path AT '/' INTO lv_first lv_rest.
      READ TABLE rt_navs WITH KEY table_line = lv_first TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND lv_first TO rt_navs.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD expand_below.
    DATA lv_path  TYPE string.
    DATA lv_first TYPE string.
    DATA lv_rest  TYPE string.

    LOOP AT it_expand INTO lv_path.
      SPLIT lv_path AT '/' INTO lv_first lv_rest.
      IF lv_first = iv_nav AND lv_rest IS NOT INITIAL.
        APPEND lv_rest TO rt_rest.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD expand_tree_of.
    DATA lt_navs TYPE string_table.
    DATA lv_nav  TYPE string.

    CREATE OBJECT ro_tree.
    lt_navs = expand_levels( it_expand ).
    LOOP AT lt_navs INTO lv_nav.
      ro_tree->add_child( iv_name = lv_nav
                          io_node = expand_tree_of( expand_below( it_expand = it_expand
                                                                  iv_nav    = lv_nav ) ) ).
    ENDLOOP.
  ENDMETHOD.

  METHOD entities_with_expand.
    FIELD-SYMBOLS <ls_row> TYPE any.

    LOOP AT it_rows ASSIGNING <ls_row>.
      APPEND zcl_stg_json=>entity( is_data      = <ls_row>
                                   is_set       = is_set
                                   iv_namespace = is_service-namespace
                                   iv_base_url  = iv_base_url
                                   it_nav_json  = expand_row( io_dpc          = io_dpc
                                                              is_service      = is_service
                                                              is_set          = is_set
                                                              is_row          = <ls_row>
                                                              it_expand       = it_expand
                                                              iv_base_url     = iv_base_url
                                                              it_tech_clauses = it_tech_clauses ) ) TO rt_entities.
    ENDLOOP.
  ENDMETHOD.

  METHOD expand_row.
    DATA lt_navs     TYPE string_table.
    DATA lv_nav      TYPE string.
    DATA lt_below    TYPE string_table.
    DATA lv_upper    TYPE string.
    DATA ls_nav      TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target   TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_keys     TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_path     TYPE /iwbep/s_mgw_navigation_path.
    DATA lt_path     TYPE /iwbep/t_mgw_navigation_path.
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA lt_filter   TYPE /iwbep/t_mgw_select_option.
    DATA ls_paging   TYPE /iwbep/s_mgw_paging.
    DATA lt_order    TYPE /iwbep/t_mgw_sorting_order.
    DATA lr_data     TYPE REF TO data.
    DATA ls_nav_json TYPE zcl_stg_json=>ty_nav_json.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_one>  TYPE any.

    lt_keys = row_keys( is_row = is_row
                        is_set = is_set ).
    lt_navs = expand_levels( it_expand ).

    LOOP AT lt_navs INTO lv_nav.
      ls_nav    = zcl_stg_model_info=>find_nav( is_set  = is_set
                                                iv_name = lv_nav ).
      lt_below  = expand_below( it_expand = it_expand
                                iv_nav    = lv_nav ).
* the DPC already delivered this navigation inside the row (tech clause):
* the serializer inlines the component, nothing to fetch here
      lv_upper = to_upper( lv_nav ).
      READ TABLE it_tech_clauses WITH KEY table_line = lv_upper TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      ls_target = zcl_stg_model_info=>find_set( is_service    = is_service
                                                iv_entity_set = ls_nav-target_set ).

      CLEAR lt_path.
      CLEAR ls_path.
      ls_path-nav_prop              = ls_nav-name.
      ls_path-key_tab               = lt_keys.
      ls_path-target_type           = ls_nav-target_type.
      ls_path-target_type_namespace = is_service-namespace.
      IF ls_nav-to_many = abap_true.
        ls_path-multiplicity = '*'.
      ELSE.
        ls_path-multiplicity = '1'.
      ENDIF.
      APPEND ls_path TO lt_path.

      CREATE OBJECT lo_context.
      lo_context->mv_entity_set        = ls_target-name.
      lo_context->mv_entity_type       = ls_target-entity_type.
      lo_context->ms_set               = ls_target.
      lo_context->mt_key_tab           = lt_keys.
      lo_context->mt_navigation_path   = lt_path.
      lo_context->mv_source_entity_set = is_set-name.

      CLEAR ls_nav_json.
      ls_nav_json-name = ls_nav-name.
      CLEAR lr_data.

      IF ls_nav-to_many = abap_true.
        io_dpc->get_entityset(
          EXPORTING
            iv_entity_name           = ls_target-entity_type
            iv_entity_set_name       = ls_target-name
            iv_source_name           = is_set-entity_type
            it_filter_select_options = lt_filter
            is_paging                = ls_paging
            it_key_tab               = lt_keys
            it_navigation_path       = lt_path
            it_order                 = lt_order
            iv_filter_string         = ''
            iv_search_string         = ''
            io_tech_request_context  = lo_context
          IMPORTING
            er_entityset             = lr_data ).
        IF lr_data IS BOUND.
          ASSIGN lr_data->* TO <lt_rows>.
          IF lt_below IS INITIAL.
            ls_nav_json-json = zcl_stg_json=>feed( it_data      = <lt_rows>
                                                   is_set       = ls_target
                                                   iv_namespace = is_service-namespace
                                                   iv_base_url  = iv_base_url ).
          ELSE.
* deeper levels: expand each target row in turn
            ls_nav_json-json = zcl_stg_json=>feed_of( entities_with_expand( io_dpc      = io_dpc
                                                                            is_service  = is_service
                                                                            is_set      = ls_target
                                                                            it_rows     = <lt_rows>
                                                                            it_expand   = lt_below
                                                                            iv_base_url = iv_base_url ) ).
          ENDIF.
* strip the {"d": ... } envelope: inside an entity the feed is {"results":[...]}
          ls_nav_json-json = substring( val = ls_nav_json-json
                                        off = 5
                                        len = strlen( ls_nav_json-json ) - 6 ).
        ELSE.
          ls_nav_json-json = '{"results":[]}'.
        ENDIF.
      ELSE.
        io_dpc->get_entity(
          EXPORTING
            iv_entity_name          = ls_target-entity_type
            iv_entity_set_name      = ls_target-name
            iv_source_name          = is_set-entity_type
            it_key_tab              = lt_keys
            it_navigation_path      = lt_path
            io_tech_request_context = lo_context
          IMPORTING
            er_entity               = lr_data ).
        IF lr_data IS BOUND.
          ASSIGN lr_data->* TO <ls_one>.
          ls_nav_json-json = zcl_stg_json=>entity( is_data      = <ls_one>
                                                   is_set       = ls_target
                                                   iv_namespace = is_service-namespace
                                                   iv_base_url  = iv_base_url
                                                   it_nav_json  = expand_row( io_dpc      = io_dpc
                                                                              is_service  = is_service
                                                                              is_set      = ls_target
                                                                              is_row      = <ls_one>
                                                                              it_expand   = lt_below
                                                                              iv_base_url = iv_base_url ) ).
        ELSE.
          ls_nav_json-json = 'null'.
        ENDIF.
      ENDIF.
      APPEND ls_nav_json TO rt_nav_json.
    ENDLOOP.
  ENDMETHOD.

  METHOD navigation_path.
    DATA ls_path TYPE /iwbep/s_mgw_navigation_path.

    CLEAR: es_nav, es_target, et_keys, et_path, es_request.
    es_nav    = zcl_stg_model_info=>find_nav( is_set  = is_set
                                              iv_name = is_request-nav_prop ).
    es_target = zcl_stg_model_info=>find_set( is_service    = is_service
                                              iv_entity_set = es_nav-target_set ).
    et_keys   = zcl_stg_url=>parse_keys( iv_key_string = is_request-key_string
                                         it_key_names  = zcl_stg_model_info=>key_names( is_set ) ).
    zcl_stg_model_info=>check_keys( is_set     = is_set
                                    it_key_tab = et_keys ).

    ls_path-nav_prop              = es_nav-name.
    ls_path-key                   = is_request-key_string.
    ls_path-key_tab               = et_keys.
    ls_path-target_type           = es_nav-target_type.
    ls_path-target_type_namespace = is_service-namespace.
    IF es_nav-to_many = abap_true.
      ls_path-multiplicity = '*'.
    ELSE.
      ls_path-multiplicity = '1'.
    ENDIF.
    APPEND ls_path TO et_path.

* the rest of the request now addresses the target set
    es_request = is_request.
    es_request-entity_set = es_target-name.
    es_request-key_string = is_request-nav_key_string.
    CLEAR es_request-nav_prop.
    CLEAR es_request-nav_key_string.
  ENDMETHOD.

  METHOD create_through_navigation.
    DATA ls_nav     TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target  TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_keys    TYPE /iwbep/t_mgw_name_value_pair.
    DATA lt_path    TYPE /iwbep/t_mgw_navigation_path.
    DATA ls_request TYPE zcl_stg_url=>ty_request.

    navigation_path( EXPORTING is_service = is_service
                               is_set     = is_set
                               is_request = is_request
                     IMPORTING es_nav     = ls_nav
                               es_target  = ls_target
                               et_keys    = lt_keys
                               et_path    = lt_path
                               es_request = ls_request ).
    IF ls_nav-to_many = abap_false.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 405
          code    = 'STG/METHOD_NOT_ALLOWED'
          message = |{ ls_nav-name } is a to-one navigation, nothing is created below it|.
    ENDIF.
    rs_response = write_entity( iv_method          = 'POST'
                                is_service         = is_service
                                is_set             = ls_target
                                is_request         = ls_request
                                iv_base_url        = iv_base_url
                                iv_body            = iv_body
                                it_navigation_path = lt_path
                                it_key_tab         = lt_keys
                                iv_source_set      = is_set-name ).
  ENDMETHOD.

  METHOD read_navigation.
    DATA ls_nav     TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target  TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_keys    TYPE /iwbep/t_mgw_name_value_pair.
    DATA lt_path    TYPE /iwbep/t_mgw_navigation_path.
    DATA ls_request TYPE zcl_stg_url=>ty_request.

    navigation_path( EXPORTING is_service = is_service
                               is_set     = is_set
                               is_request = is_request
                     IMPORTING es_nav     = ls_nav
                               es_target  = ls_target
                               et_keys    = lt_keys
                               et_path    = lt_path
                               es_request = ls_request ).

    IF ls_nav-to_many = abap_true AND is_request-nav_key_string IS INITIAL.
      rs_response = read_entity_set( is_service         = is_service
                                     is_set             = ls_target
                                     is_request         = ls_request
                                     iv_base_url        = iv_base_url
                                     it_navigation_path = lt_path
                                     it_key_tab         = lt_keys
                                     iv_source_set      = is_set-name ).
    ELSEIF is_request-nav_key_string IS INITIAL.
* to-one: the source keys identify the target (foreign key)
      rs_response = read_entity( is_service         = is_service
                                 is_set             = ls_target
                                 is_request         = ls_request
                                 iv_base_url        = iv_base_url
                                 it_navigation_path = lt_path
                                 it_key_tab         = lt_keys
                                 iv_source_set      = is_set-name ).
    ELSE.
      rs_response = read_entity( is_service         = is_service
                                 is_set             = ls_target
                                 is_request         = ls_request
                                 iv_base_url        = iv_base_url
                                 it_navigation_path = lt_path
                                 iv_source_set      = is_set-name ).
    ENDIF.
  ENDMETHOD.

ENDCLASS.
