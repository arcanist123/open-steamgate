CLASS zcl_osd_m4a_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
* Milestone 4, the twin of the request-context members and the exception
* members a second generated service uses (synthetic, written fresh): each
* read keeps what the technical context answered (gs_seen) for the test to
* compare with what the request carried, and answers no rows. The search
* option picks an exception, raised the way such a service raises it:
* - notfound: resource_not_found with the entity type and HTTP 404,
* - filter: filter_not_supported with the property the filter named,
* - container: a message added through the exception's own container.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_seen,
             entity_set  TYPE string,
             search      TYPE string,
             skiptoken   TYPE string,
             source_type TYPE string,
             selected    TYPE string,
           END OF ty_seen.

    CLASS-DATA gs_seen TYPE ty_seen.

    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
  PRIVATE SECTION.
* the selected fields, sorted and joined with blanks
    CLASS-METHODS joined
      IMPORTING
        it_fields      TYPE /iwbep/t_mgw_tech_field_names
      RETURNING
        VALUE(rv_text) TYPE string.

    METHODS raise_for
      IMPORTING
        iv_search TYPE string
      RAISING
        /iwbep/cx_mgw_busi_exception.
ENDCLASS.

CLASS zcl_osd_m4a_dpc IMPLEMENTATION.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    DATA lt_order TYPE zcl_osd_m4a_mpc=>tt_order.
    DATA lt_item  TYPE zcl_osd_m4a_mpc=>tt_item.

    CLEAR gs_seen.
    gs_seen-entity_set  = iv_entity_set_name.
    gs_seen-search      = io_tech_request_context->get_search_string( ).
    gs_seen-skiptoken   = io_tech_request_context->get_skiptoken( ).
    gs_seen-source_type = io_tech_request_context->get_source_entity_type_name( ).
    gs_seen-selected    = joined( io_tech_request_context->get_select_with_mandtry_fields( ) ).

    raise_for( gs_seen-search ).

    IF iv_entity_set_name = 'Items'.
      copy_data_to_ref( EXPORTING is_data = lt_item
                        CHANGING  cr_data = er_entityset ).
    ELSE.
      copy_data_to_ref( EXPORTING is_data = lt_order
                        CHANGING  cr_data = er_entityset ).
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entity.
    DATA ls_order TYPE zcl_osd_m4a_mpc=>ts_order.

    CLEAR gs_seen.
    gs_seen-entity_set  = iv_entity_set_name.
    gs_seen-source_type = io_tech_request_context->get_source_entity_type_name( ).
    gs_seen-selected    = joined( io_tech_request_context->get_select_with_mandtry_fields( ) ).

    io_tech_request_context->get_converted_keys( IMPORTING es_key_values = ls_order ).
    copy_data_to_ref( EXPORTING is_data = ls_order
                      CHANGING  cr_data = er_entity ).
  ENDMETHOD.

  METHOD joined.
    DATA lt_fields TYPE string_table.
    DATA lv_field  TYPE string.
    DATA ls_field  LIKE LINE OF it_fields.

    LOOP AT it_fields INTO ls_field.
      lv_field = ls_field.
      APPEND lv_field TO lt_fields.
    ENDLOOP.
    SORT lt_fields.
    CONCATENATE LINES OF lt_fields INTO rv_text SEPARATED BY space.
  ENDMETHOD.

  METHOD raise_for.
    DATA lx_busi TYPE REF TO /iwbep/cx_mgw_busi_exception.

    CASE iv_search.
      WHEN 'notfound'.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            textid           = /iwbep/cx_mgw_busi_exception=>resource_not_found
            entity_type      = 'Order'
            http_status_code = /iwbep/cx_mgw_busi_exception=>gcs_http_status_codes-not_found.
      WHEN 'filter'.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            textid       = /iwbep/cx_mgw_busi_exception=>filter_not_supported
            filter_param = 'Title'.
      WHEN 'container'.
        CREATE OBJECT lx_busi
          EXPORTING
            message = 'Order refused'.
        lx_busi->get_msg_container( )->add_message_text_only(
          iv_msg_type    = 'E'
          iv_msg_text    = 'Added through the exception container'
          iv_entity_type = 'Order' ).
        RAISE EXCEPTION lx_busi.
    ENDCASE.
  ENDMETHOD.

ENDCLASS.
