CLASS zcl_stg_odata_client DEFINITION PUBLIC CREATE PUBLIC.
* An OData service consumed from inside another one: SEGW's "external
* service" (ODC) in its local flavour. The request a DPC method received is
* turned back into an OData GET, dispatched in-process to the other service
* of this registry, and the JSON answer is read into the consuming
* service's entity structure by property name. The consuming service
* therefore exposes the properties it declares (same names as the provider,
* its own ABAP fields and types); $filter, $top, $skip, $orderby,
* $inlinecount and search travel through unchanged.
  PUBLIC SECTION.
* the technical order (ABAP names) as the other service's $orderby value:
* each field by the OData name of the same property of the local set, a
* path into a complex property (property initial, property_path
* ADDRESS-CITY) by its OData path (Address/City)
    CLASS-METHODS orderby_option
      IMPORTING
        it_orderby      TYPE /iwbep/t_mgw_tech_order
        is_set          TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING
        VALUE(rv_value) TYPE string.

    METHODS constructor
      IMPORTING
        iv_service    TYPE string
        iv_entity_set TYPE string.

    METHODS get_entityset
      IMPORTING
        io_tech_request_context TYPE REF TO /iwbep/if_mgw_req_entityset
        iv_local_service        TYPE string
        iv_local_set            TYPE string
      EXPORTING
        et_entityset            TYPE STANDARD TABLE
        es_response_context     TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.

    METHODS get_entity
      IMPORTING
        it_key_tab       TYPE /iwbep/t_mgw_name_value_pair
        iv_local_service TYPE string
        iv_local_set     TYPE string
      EXPORTING
        es_entity        TYPE any
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.

  PRIVATE SECTION.
    DATA mv_service    TYPE string.
    DATA mv_entity_set TYPE string.

    METHODS local_set
      IMPORTING
        iv_local_service TYPE string
        iv_local_set     TYPE string
      RETURNING
        VALUE(rs_set)    TYPE zcl_stg_model_info=>ty_entity_set
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS call
      IMPORTING
        iv_path        TYPE string
        it_options     TYPE tihttpnvp OPTIONAL
      RETURNING
        VALUE(rv_body) TYPE string
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS fill
      IMPORTING
        iv_json TYPE string
        is_set  TYPE zcl_stg_model_info=>ty_entity_set
      EXPORTING
        es_data TYPE any
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.

    METHODS key_predicate
      IMPORTING
        it_key_tab          TYPE /iwbep/t_mgw_name_value_pair
        is_set              TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING
        VALUE(rv_predicate) TYPE string.
ENDCLASS.

CLASS zcl_stg_odata_client IMPLEMENTATION.

  METHOD constructor.
    mv_service    = iv_service.
    mv_entity_set = iv_entity_set.
  ENDMETHOD.

  METHOD local_set.
    DATA ls_service TYPE zcl_stg_model_info=>ty_service.
    DATA lx_error   TYPE REF TO zcx_stg_error.

    TRY.
        ls_service = zcl_stg_model_info=>get( iv_local_service ).
        rs_set = zcl_stg_model_info=>find_set( is_service    = ls_service
                                               iv_entity_set = iv_local_set ).
      CATCH zcx_stg_error INTO lx_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = lx_error->get_text( ).
    ENDTRY.
  ENDMETHOD.

  METHOD call.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_text     TYPE string.
    DATA lt_nested TYPE tihttpnvp.
    DATA lt_values TYPE tihttpnvp.
    DATA ls_pair TYPE ihttpnvp.
    DATA lx_json TYPE REF TO zcx_stg_error.

    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = 'GET'
                                                iv_path    = |/sap/opu/odata/sap/{ mv_service }/{ iv_path }|
                                                it_options = it_options ).
    IF ls_response-status <> 200.
      TRY.
          lt_values = zcl_stg_json=>parse_object(
            EXPORTING iv_json = ls_response-body IMPORTING et_nested = lt_nested ).
          READ TABLE lt_nested WITH KEY name = 'error' INTO ls_pair.
          IF sy-subrc = 0.
            lt_values = zcl_stg_json=>parse_object(
              EXPORTING iv_json = ls_pair-value IMPORTING et_nested = lt_nested ).
            READ TABLE lt_nested WITH KEY name = 'message' INTO ls_pair.
            IF sy-subrc = 0.
              lt_values = zcl_stg_json=>parse_object( ls_pair-value ).
              READ TABLE lt_values WITH KEY name = 'value' INTO ls_pair.
              IF sy-subrc = 0.
                lv_text = ls_pair-value.
              ENDIF.
            ENDIF.
          ENDIF.
        CATCH zcx_stg_error INTO lx_json.
      ENDTRY.
      IF lv_text IS INITIAL.
        lv_text = ls_response-body.
      ENDIF.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |{ mv_service }/{ iv_path }: { ls_response-status } { lv_text }|.
    ENDIF.
    rv_body = ls_response-body.
  ENDMETHOD.

  METHOD fill.
    DATA lt_values   TYPE tihttpnvp.
    DATA lo_provider TYPE REF TO zcl_stg_entry_provider.
    DATA lx_error    TYPE REF TO zcx_stg_error.

    TRY.
        lt_values = zcl_stg_json=>parse_object( iv_json ).
      CATCH zcx_stg_error INTO lx_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = lx_error->get_text( ).
    ENDTRY.
    CREATE OBJECT lo_provider
      EXPORTING
        it_values = lt_values
        is_set    = is_set.
    lo_provider->/iwbep/if_mgw_entry_provider~read_entry_data( IMPORTING es_data = es_data ).
  ENDMETHOD.

  METHOD key_predicate.
    DATA ls_key      LIKE LINE OF it_key_tab.
    DATA ls_property LIKE LINE OF is_set-properties.
    DATA lv_value    TYPE string.
    DATA lv_part     TYPE string.

    LOOP AT it_key_tab INTO ls_key.
      READ TABLE is_set-properties INTO ls_property WITH KEY name = ls_key-name.
      IF sy-subrc = 0 AND ls_property-edm_type = 'Edm.String'.
        lv_value = |'{ ls_key-value }'|.
      ELSE.
        lv_value = ls_key-value.
      ENDIF.
      IF lines( it_key_tab ) = 1.
        lv_part = lv_value.
      ELSE.
        lv_part = |{ ls_key-name }={ lv_value }|.
      ENDIF.
      IF rv_predicate IS INITIAL.
        rv_predicate = lv_part.
      ELSE.
        rv_predicate = |{ rv_predicate },{ lv_part }|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD orderby_option.
    DATA ls_orderby  LIKE LINE OF it_orderby.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    DATA lv_name     TYPE string.

    LOOP AT it_orderby INTO ls_orderby.
      lv_name = ls_orderby-property.
      IF lv_name IS INITIAL.
        lv_name = ls_orderby-property_path.
      ENDIF.
      READ TABLE is_set-properties INTO ls_property WITH KEY fieldname = lv_name.
      IF sy-subrc <> 0.
        READ TABLE is_set-components INTO ls_property WITH KEY fieldname = lv_name.
      ENDIF.
      IF sy-subrc = 0.
        lv_name = ls_property-name.
      ENDIF.
      IF rv_value IS NOT INITIAL.
        rv_value = |{ rv_value },|.
      ENDIF.
      rv_value = |{ rv_value }{ lv_name } { to_lower( ls_orderby-order ) }|.
    ENDLOOP.
  ENDMETHOD.

  METHOD get_entityset.
    DATA ls_set      TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_options  TYPE tihttpnvp.
    DATA ls_option   TYPE ihttpnvp.
    DATA lo_filter   TYPE REF TO /iwbep/if_mgw_req_filter.
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA lt_orderby  TYPE /iwbep/t_mgw_tech_order.
    DATA lv_top      TYPE string.
    DATA lv_skip     TYPE i.
    DATA lv_body     TYPE string.
    DATA lt_values   TYPE tihttpnvp.
    DATA lt_nested   TYPE tihttpnvp.
    DATA ls_value    TYPE ihttpnvp.
    DATA lt_elements TYPE string_table.
    DATA lv_element  TYPE string.
    DATA lr_line     TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_stg_error.
    FIELD-SYMBOLS <ls_line> TYPE any.

    CLEAR: et_entityset, es_response_context.
    ls_set = local_set( iv_local_service = iv_local_service
                        iv_local_set     = iv_local_set ).

* the query options, as the caller sent them
    lo_filter = io_tech_request_context->get_filter( ).
    ls_option-name  = '$filter'.
    ls_option-value = lo_filter->get_filter_string( ).
    IF ls_option-value IS NOT INITIAL.
      APPEND ls_option TO lt_options.
    ENDIF.
    lv_top = io_tech_request_context->get_top( ).
    IF lv_top IS NOT INITIAL AND lv_top <> '0'.
      ls_option-name  = '$top'.
      ls_option-value = lv_top.
      APPEND ls_option TO lt_options.
    ENDIF.
    lv_skip = io_tech_request_context->get_skip( ).
    IF lv_skip > 0.
      ls_option-name  = '$skip'.
      ls_option-value = |{ lv_skip }|.
      APPEND ls_option TO lt_options.
    ENDIF.
    lt_orderby = io_tech_request_context->get_orderby( ).
    CLEAR ls_option.
    ls_option-value = orderby_option( it_orderby = lt_orderby
                                      is_set     = ls_set ).
    IF ls_option-value IS NOT INITIAL.
      ls_option-name = '$orderby'.
      APPEND ls_option TO lt_options.
    ENDIF.
    IF io_tech_request_context->has_inlinecount( ) = abap_true.
      ls_option-name  = '$inlinecount'.
      ls_option-value = 'allpages'.
      APPEND ls_option TO lt_options.
    ENDIF.
* the search string is ours, not in the interface
    TRY.
        lo_context ?= io_tech_request_context.
        IF lo_context->mv_search_string IS NOT INITIAL.
          ls_option-name  = 'search'.
          ls_option-value = lo_context->mv_search_string.
          APPEND ls_option TO lt_options.
        ENDIF.
      CATCH cx_sy_move_cast_error.
    ENDTRY.

    lv_body = call( iv_path    = mv_entity_set
                    it_options = lt_options ).

* {"d":{"results":[...],"__count":"n"}}
    TRY.
        lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json   = lv_body
                                                IMPORTING et_nested = lt_nested ).
        READ TABLE lt_values INTO ls_value WITH KEY name = '__count'.
        IF sy-subrc = 0.
          es_response_context-inlinecount = ls_value-value.
        ENDIF.
        READ TABLE lt_nested INTO ls_value WITH KEY name = 'results'.
        IF sy-subrc = 0.
          lt_elements = zcl_stg_json=>parse_array( ls_value-value ).
        ENDIF.
      CATCH zcx_stg_error INTO lx_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = lx_error->get_text( ).
    ENDTRY.

    CREATE DATA lr_line LIKE LINE OF et_entityset.
    ASSIGN lr_line->* TO <ls_line>.
    LOOP AT lt_elements INTO lv_element.
      CLEAR <ls_line>.
      fill( EXPORTING iv_json = lv_element
                      is_set  = ls_set
            IMPORTING es_data = <ls_line> ).
      APPEND <ls_line> TO et_entityset.
    ENDLOOP.
  ENDMETHOD.

  METHOD get_entity.
    DATA ls_set  TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_body TYPE string.

    CLEAR es_entity.
    ls_set  = local_set( iv_local_service = iv_local_service
                         iv_local_set     = iv_local_set ).
    lv_body = call( |{ mv_entity_set }({ key_predicate( it_key_tab = it_key_tab is_set = ls_set ) })| ).
    fill( EXPORTING iv_json = lv_body
                    is_set  = ls_set
          IMPORTING es_data = es_entity ).
  ENDMETHOD.

ENDCLASS.
