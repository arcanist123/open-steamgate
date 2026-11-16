CLASS lcl_req_entity DEFINITION FINAL.
* Minimal single-entity request context. open-abap-odata has no usable one:
* zcl_oao_request_context only implements the entity-set interface and
* /iwbep/cl_mgw_request returns empty from every method. QW3 replaces this.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_req_entity.
    METHODS constructor
      IMPORTING
        iv_entity_set_name TYPE string.
  PRIVATE SECTION.
    DATA mv_entity_set_name TYPE string.
ENDCLASS.

CLASS lcl_req_entity IMPLEMENTATION.
  METHOD constructor.
    mv_entity_set_name = iv_entity_set_name.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_set_name.
    rv_entity_set = mv_entity_set_name.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_source_entity_set_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_source_keys.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_navigation_path.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_source_entity_type_name.
    RETURN.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_select_with_mandtry_fields.
    RETURN.
  ENDMETHOD.
ENDCLASS.

CLASS ltcl_phase0 DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* Phase 0 exit test (docs/prior-art.md section 4): a transpiled, SEGW-shaped DPC runs
* its Open SQL against the local SQLite seeded from an abapGit TABU capture.
  PRIVATE SECTION.
    DATA mo_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.

    METHODS setup.
    METHODS mpc_defines_model FOR TESTING RAISING cx_static_check.
    METHODS entityset_reads_sqlite FOR TESTING RAISING cx_static_check.
    METHODS entityset_select_options FOR TESTING RAISING cx_static_check.
    METHODS entityset_paging FOR TESTING RAISING cx_static_check.
    METHODS entity_by_key FOR TESTING RAISING cx_static_check.
    METHODS unknown_set_falls_to_super FOR TESTING RAISING cx_static_check.

    METHODS get_entityset
      IMPORTING
        it_filter        TYPE /iwbep/t_mgw_select_option OPTIONAL
        is_paging        TYPE /iwbep/s_mgw_paging OPTIONAL
        iv_set           TYPE string DEFAULT 'TravelSet'
      RETURNING
        VALUE(rt_travel) TYPE zcl_zstg_demo_mpc=>tt_travel
      RAISING
        cx_static_check.
ENDCLASS.

CLASS ltcl_phase0 IMPLEMENTATION.

  METHOD setup.
    CREATE OBJECT mo_dpc TYPE zcl_zstg_demo_dpc_ext.
  ENDMETHOD.

  METHOD get_entityset.
    DATA lo_context   TYPE REF TO /iwbep/if_mgw_req_entityset.
    DATA lt_key_tab   TYPE /iwbep/t_mgw_name_value_pair.
    DATA lt_nav_path  TYPE /iwbep/t_mgw_navigation_path.
    DATA lt_order     TYPE /iwbep/t_mgw_sorting_order.
    DATA lr_entityset TYPE REF TO data.
    FIELD-SYMBOLS <lt_result> TYPE zcl_zstg_demo_mpc=>tt_travel.

    CREATE OBJECT lo_context TYPE zcl_oao_request_context
      EXPORTING
        iv_entity_set_name = iv_set.

    mo_dpc->get_entityset(
      EXPORTING
        iv_entity_name           = 'Travel'
        iv_entity_set_name       = iv_set
        iv_source_name           = ''
        it_filter_select_options = it_filter
        is_paging                = is_paging
        it_key_tab               = lt_key_tab
        it_navigation_path       = lt_nav_path
        it_order                 = lt_order
        iv_filter_string         = ''
        iv_search_string         = ''
        io_tech_request_context  = lo_context
      IMPORTING
        er_entityset             = lr_entityset ).

    IF lr_entityset IS BOUND.
      ASSIGN lr_entityset->* TO <lt_result>.
      rt_travel = <lt_result>.
    ENDIF.
  ENDMETHOD.

  METHOD mpc_defines_model.
    DATA lo_mpc    TYPE REF TO zcl_zstg_demo_mpc_ext.
    DATA lo_entity TYPE REF TO /iwbep/if_mgw_odata_entity_typ.
    DATA lv_ns     TYPE string.

    CREATE OBJECT lo_mpc.
    lo_mpc->define( ).
    lo_mpc->model->get_schema_namespace( IMPORTING ev_namespace = lv_ns ).
    cl_abap_unit_assert=>assert_equals( act = lv_ns
                                        exp = 'ZSTG_DEMO_SRV' ).
    lo_entity = lo_mpc->model->get_entity_type( zcl_zstg_demo_mpc=>gc_travel ).
    cl_abap_unit_assert=>assert_equals( act = lines( lo_entity->get_properties( ) )
                                        exp = 6 ).
  ENDMETHOD.

  METHOD entityset_reads_sqlite.
    DATA lt_travel TYPE zcl_zstg_demo_mpc=>tt_travel.
    DATA ls_travel TYPE zcl_zstg_demo_mpc=>ts_travel.

    lt_travel = get_entityset( ).

* 4 rows are seeded, 3 in client 123 and 1 in client 001. A real system
* returns 3. The transpiler has no implicit MANDT (ANORMALIES.md), so the
* fourth row leaks through: this assertion pins the current behaviour and
* will start failing the day the runtime gains client handling.
    cl_abap_unit_assert=>assert_equals( act = lines( lt_travel )
                                        exp = 4 ).

    READ TABLE lt_travel INTO ls_travel INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_travel-travel_id
                                        exp = 'T0001' ).
    cl_abap_unit_assert=>assert_equals( act = ls_travel-description
                                        exp = 'Berlin to Copenhagen' ).
    cl_abap_unit_assert=>assert_equals( act = ls_travel-seats
                                        exp = 2 ).
  ENDMETHOD.

  METHOD entityset_select_options.
    DATA lt_filter TYPE /iwbep/t_mgw_select_option.
    DATA ls_filter TYPE /iwbep/s_mgw_select_option.
    DATA ls_option TYPE /iwbep/s_cod_select_option.
    DATA lt_travel TYPE zcl_zstg_demo_mpc=>tt_travel.
    DATA ls_travel TYPE zcl_zstg_demo_mpc=>ts_travel.

* what the Gateway builds from $filter=Status eq 'A' and TravelId ge 'T0002'
    ls_filter-property = 'Status'.
    ls_option-sign = 'I'.
    ls_option-option = 'EQ'.
    ls_option-low = 'A'.
    APPEND ls_option TO ls_filter-select_options.
    APPEND ls_filter TO lt_filter.

    CLEAR ls_filter.
    ls_filter-property = 'TravelId'.
    ls_option-sign = 'I'.
    ls_option-option = 'GE'.
    ls_option-low = 'T0002'.
    APPEND ls_option TO ls_filter-select_options.
    APPEND ls_filter TO lt_filter.

    lt_travel = get_entityset( it_filter = lt_filter ).

    cl_abap_unit_assert=>assert_equals( act = lines( lt_travel )
                                        exp = 2 ).
    READ TABLE lt_travel INTO ls_travel INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_travel-travel_id
                                        exp = 'T0002' ).
    READ TABLE lt_travel INTO ls_travel INDEX 2.
    cl_abap_unit_assert=>assert_equals( act = ls_travel-travel_id
                                        exp = 'T0009' ).
  ENDMETHOD.

  METHOD entityset_paging.
    DATA ls_paging TYPE /iwbep/s_mgw_paging.
    DATA lt_travel TYPE zcl_zstg_demo_mpc=>tt_travel.
    DATA ls_travel TYPE zcl_zstg_demo_mpc=>ts_travel.

    ls_paging-skip = 1.
    ls_paging-top = 2.
    lt_travel = get_entityset( is_paging = ls_paging ).

    cl_abap_unit_assert=>assert_equals( act = lines( lt_travel )
                                        exp = 2 ).
    READ TABLE lt_travel INTO ls_travel INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_travel-travel_id
                                        exp = 'T0002' ).
  ENDMETHOD.

  METHOD entity_by_key.
    DATA lo_context  TYPE REF TO /iwbep/if_mgw_req_entity.
    DATA lt_key_tab  TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_key      TYPE /iwbep/s_mgw_name_value_pair.
    DATA lt_nav_path TYPE /iwbep/t_mgw_navigation_path.
    DATA lr_entity   TYPE REF TO data.
    FIELD-SYMBOLS <ls_travel> TYPE zcl_zstg_demo_mpc=>ts_travel.

    ls_key-name = 'TravelId'.
    ls_key-value = 'T0003'.
    APPEND ls_key TO lt_key_tab.

    CREATE OBJECT lo_context TYPE lcl_req_entity
      EXPORTING
        iv_entity_set_name = 'TravelSet'.

    mo_dpc->get_entity(
      EXPORTING
        iv_entity_name          = 'Travel'
        iv_entity_set_name      = 'TravelSet'
        iv_source_name          = ''
        it_key_tab              = lt_key_tab
        it_navigation_path      = lt_nav_path
        io_tech_request_context = lo_context
      IMPORTING
        er_entity               = lr_entity ).

    cl_abap_unit_assert=>assert_bound( lr_entity ).
    ASSIGN lr_entity->* TO <ls_travel>.
    cl_abap_unit_assert=>assert_equals( act = <ls_travel>-description
                                        exp = 'Aarhus to Odense' ).
    cl_abap_unit_assert=>assert_equals( act = <ls_travel>-status
                                        exp = 'X' ).
  ENDMETHOD.

  METHOD unknown_set_falls_to_super.
    DATA lt_travel TYPE zcl_zstg_demo_mpc=>tt_travel.

* SEGW shape: WHEN OTHERS delegates to the framework base, whose stub in
* open-abap-odata is a bare RETURN. Nothing is bound, nothing raised.
    lt_travel = get_entityset( iv_set = 'NoSuchSet' ).
    cl_abap_unit_assert=>assert_initial( lt_travel ).
  ENDMETHOD.

ENDCLASS.
