CLASS ltcl_tech_request DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The /IWBEP/ members the SEGW sample calls through the technical request
* context (H5x-3): the navigation path getter on both facets (the sample's
* RESOLVE_NAVIGATION_PATH receives io_tech_request_ctx_entity
* TYPE REF TO /iwbep/if_mgw_req_entity and io_tech_request_ctx_entityset
* TYPE REF TO /iwbep/if_mgw_req_entityset and calls the getter on each), and
* the function-import name and converted-parameters getters on
* /iwbep/if_mgw_req_func_import (the sample's ACTION_SO_ACTIONS receives
* io_tech_request_context TYPE REF TO /iwbep/if_mgw_req_func_import).
  PRIVATE SECTION.
    METHODS navigation_path_entity FOR TESTING RAISING cx_static_check.
    METHODS navigation_path_entityset FOR TESTING RAISING cx_static_check.
    METHODS function_import_name FOR TESTING RAISING cx_static_check.
    METHODS converted_parameters FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_tech_request IMPLEMENTATION.

  METHOD navigation_path_entity.
* Two steps, Travel -> to_Bookings -> to_Carrier: every row carries the
* navigation property, the entity type it starts from (the addressed set's
* type for the first step, the previous step's target afterwards) and the
* one it leads to -- the two fields a contract caller branches on.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lt_path    TYPE /iwbep/t_mgw_tech_navi.
    DATA ls_row     TYPE /iwbep/s_mgw_tech_navi.
    DATA ls_pair    TYPE /iwbep/s_mgw_tech_pair.
    DATA ls_step    LIKE LINE OF lo_context->mt_navigation_path.
    DATA ls_key     LIKE LINE OF ls_step-key_tab.

    CREATE OBJECT lo_context.
* no navigation in the URL: the path is empty
    lt_path = lo_context->/iwbep/if_mgw_req_entity~get_navigation_path( ).
    cl_abap_unit_assert=>assert_initial( lt_path ).

* the path the dispatcher parsed out of the URL comes back in order
    lo_context->mv_source_entity_type = 'Travel'.
    ls_step-nav_prop     = 'to_Bookings'.
    ls_step-key          = `'1'`.
    ls_step-target_type  = 'Booking'.
    ls_step-multiplicity = '*'.
    ls_key-name  = 'TravelId'.
    ls_key-value = '1'.
    APPEND ls_key TO ls_step-key_tab.
    APPEND ls_step TO lo_context->mt_navigation_path.
    CLEAR ls_step.
    ls_step-nav_prop     = 'to_Carrier'.
    ls_step-target_type  = 'Carrier'.
    ls_step-multiplicity = '1'.
    APPEND ls_step TO lo_context->mt_navigation_path.

    lt_path = lo_context->/iwbep/if_mgw_req_entity~get_navigation_path( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_path )
                                        exp = 2 ).
    READ TABLE lt_path INTO ls_row INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_row-nav_prop
                                        exp = 'to_Bookings' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-source_entity_type
                                        exp = 'Travel' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-target_entity_type
                                        exp = 'Booking' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-multiplicity
                                        exp = '*' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_row-key_tab )
                                        exp = 1 ).
    READ TABLE ls_row-key_tab INTO ls_pair INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_pair-name
                                        exp = 'TravelId' ).
    cl_abap_unit_assert=>assert_equals( act = ls_pair-value
                                        exp = '1' ).
    READ TABLE lt_path INTO ls_row INDEX 2.
    cl_abap_unit_assert=>assert_equals( act = ls_row-nav_prop
                                        exp = 'to_Carrier' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-source_entity_type
                                        exp = 'Booking' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-target_entity_type
                                        exp = 'Carrier' ).
  ENDMETHOD.

  METHOD navigation_path_entityset.
* the entity-set facet answers the same rows
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lt_path    TYPE /iwbep/t_mgw_tech_navi.
    DATA ls_row     TYPE /iwbep/s_mgw_tech_navi.
    DATA ls_step    LIKE LINE OF lo_context->mt_navigation_path.

    CREATE OBJECT lo_context.
    lo_context->mv_source_entity_type = 'Order'.
    ls_step-nav_prop    = 'to_Item'.
    ls_step-target_type = 'Item'.
    APPEND ls_step TO lo_context->mt_navigation_path.
    CLEAR ls_step.
    ls_step-nav_prop    = 'to_Product'.
    ls_step-target_type = 'Product'.
    APPEND ls_step TO lo_context->mt_navigation_path.

    lt_path = lo_context->/iwbep/if_mgw_req_entityset~get_navigation_path( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_path )
                                        exp = 2 ).
    READ TABLE lt_path INTO ls_row INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_row-nav_prop
                                        exp = 'to_Item' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-source_entity_type
                                        exp = 'Order' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-target_entity_type
                                        exp = 'Item' ).
    READ TABLE lt_path INTO ls_row INDEX 2.
    cl_abap_unit_assert=>assert_equals( act = ls_row-source_entity_type
                                        exp = 'Item' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-target_entity_type
                                        exp = 'Product' ).
  ENDMETHOD.

  METHOD function_import_name.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lv_name    TYPE string.

    CREATE OBJECT lo_context.
    lv_name = lo_context->/iwbep/if_mgw_req_func_import~get_function_import_name( ).
    cl_abap_unit_assert=>assert_initial( lv_name ).

    lo_context->mv_function_import = 'CancelTravel'.
    lv_name = lo_context->/iwbep/if_mgw_req_func_import~get_function_import_name( ).
    cl_abap_unit_assert=>assert_equals( act = lv_name
                                        exp = 'CancelTravel' ).
  ENDMETHOD.

  METHOD converted_parameters.
    TYPES: BEGIN OF ty_params,
             travelid TYPE c LENGTH 8,
             status   TYPE c LENGTH 1,
           END OF ty_params.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA ls_param   LIKE LINE OF lo_context->mt_parameter.
    DATA ls_params  TYPE ty_params.

    CREATE OBJECT lo_context.
    ls_param-name  = 'TravelId'.
    ls_param-value = 'T0009'.
    APPEND ls_param TO lo_context->mt_parameter.
    ls_param-name  = 'Status'.
    ls_param-value = 'X'.
    APPEND ls_param TO lo_context->mt_parameter.

* the parameters converted into the structure the provider declared: one
* component per parameter, by parameter name, values as text
    lo_context->/iwbep/if_mgw_req_func_import~get_converted_parameters(
        IMPORTING es_parameter_values = ls_params ).
    cl_abap_unit_assert=>assert_equals( act = ls_params-travelid
                                        exp = 'T0009' ).
    cl_abap_unit_assert=>assert_equals( act = ls_params-status
                                        exp = 'X' ).
  ENDMETHOD.

ENDCLASS.



CLASS ltcl_changeset_types DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The changeset request/response structures carry the Content-ID of the
* operation and the Content-ID it references: the member the sample's
* CHANGESET_BEGIN reads off the operation info and CHANGESet_PROCESS off
* the request and response rows (framework-gaps.json, bed run 18, private
* evidence). A compile check only: the fields are types, nothing in the
* runtime fills them ($batch does not pass Content-IDs into them and does
* not call CHANGESET_BEGIN with operation info), so this writes and reads
* the fields back and proves that they exist, nothing more.
  PRIVATE SECTION.
    METHODS content_id_members FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_changeset_types IMPLEMENTATION.

  METHOD content_id_members.
    DATA ls_request  TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_changeset_request.
    DATA ls_response TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_changeset_response.
    DATA ls_info     TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_operation_info.

    ls_request-operation_no     = 1.
    ls_request-content_id       = '1'.
    ls_request-content_id_ref   = '0'.
    ls_response-operation_no    = 1.
    ls_response-content_id      = '1'.
    ls_info-content_id          = '1'.
    ls_info-content_id_ref      = '0'.

    cl_abap_unit_assert=>assert_equals( act = ls_request-content_id
                                        exp = '1' ).
    cl_abap_unit_assert=>assert_equals( act = ls_request-content_id_ref
                                        exp = '0' ).
    cl_abap_unit_assert=>assert_equals( act = ls_response-content_id
                                        exp = '1' ).
    cl_abap_unit_assert=>assert_equals( act = ls_info-content_id_ref
                                        exp = '0' ).
  ENDMETHOD.

ENDCLASS.
