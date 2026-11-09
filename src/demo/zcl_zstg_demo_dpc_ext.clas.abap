CLASS zcl_zstg_demo_dpc_ext DEFINITION PUBLIC INHERITING FROM zcl_zstg_demo_dpc CREATE PUBLIC.
* The hand-written part a developer owns on a real system. Reads the
* select-options the Gateway hands over, runs Open SQL, applies paging.
  PUBLIC SECTION.
* the media resource of a Photo: GET and PUT of PhotoSet('T0001')/$value
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_stream REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~update_stream REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~create_deep_entity REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~execute_action REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_expanded_entityset REDEFINITION.
  PROTECTED SECTION.
    METHODS travelset_get_entityset REDEFINITION.
    METHODS travelset_get_entity REDEFINITION.
    METHODS travelset_create_entity REDEFINITION.
    METHODS travelset_update_entity REDEFINITION.
    METHODS travelset_delete_entity REDEFINITION.
    METHODS bookingset_get_entityset REDEFINITION.
    METHODS bookingset_get_entity REDEFINITION.
    METHODS bookingset_create_entity REDEFINITION.
    METHODS bookingset_update_entity REDEFINITION.
    METHODS bookingset_delete_entity REDEFINITION.
    METHODS statusvhset_get_entityset REDEFINITION.
    METHODS photoset_get_entityset REDEFINITION.
    METHODS photoset_get_entity REDEFINITION.
  PRIVATE SECTION.
* where a client reaches the pictures: relative to the page the Fiori app is
* served from (<mount>/app/ here, so <mount>/sap/opu/...). On a system, where
* the app is a BSP and the service lives under /sap/opu/odata/sap/, this is
* the absolute path; see AGENDA, "The Fiori apps".
    CONSTANTS gc_media_base TYPE string VALUE '../sap/opu/odata/sap/ZSTG_DEMO_SRV' ##NO_TEXT.

    TYPES ty_travel_id TYPE c LENGTH 8.
    TYPES ty_booking_id TYPE c LENGTH 4.
* low and high are strings, not CHAR 8: a $filter literal is compared as it
* was written, so TravelId eq 'T0001    X' matches nothing instead of being
* cut to T0001 (and a Description longer than 8 is not cut either)
    TYPES: BEGIN OF ty_range,
             sign   TYPE c LENGTH 1,
             option TYPE c LENGTH 2,
             low    TYPE string,
             high   TYPE string,
           END OF ty_range.
    TYPES ty_ranges TYPE STANDARD TABLE OF ty_range WITH DEFAULT KEY.

    METHODS fill_photo_url
      CHANGING
        ct_travel TYPE zcl_zstg_demo_mpc=>tt_travel.

* $orderby, applied the way a hand-written DPC has to apply it. The ordering
* arrives in it_order as the model's property names, and ABAP has no dynamic
* SORT the transpiler supports, so each set spells its own properties out.
* The terms are applied from the last to the first, which gives the same rows
* as one multi-key SORT because the sort is stable. A property the entity set
* does not have is a client error, not a silent no-op: that is what a system
* answers, and the alternative is a request that quietly ignores half of what
* it was asked for.
    METHODS order_travel
      IMPORTING
        it_order  TYPE /iwbep/t_mgw_sorting_order
      CHANGING
        ct_travel TYPE zcl_zstg_demo_mpc=>tt_travel
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS order_booking
      IMPORTING
        it_order   TYPE /iwbep/t_mgw_sorting_order
      CHANGING
        ct_booking TYPE zcl_zstg_demo_mpc=>tt_booking
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS order_photo
      IMPORTING
        it_order TYPE /iwbep/t_mgw_sorting_order
      CHANGING
        ct_photo TYPE zcl_zstg_demo_mpc=>tt_photo
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS unknown_order_property
      IMPORTING
        iv_property TYPE string
        iv_set      TYPE string
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS photo_url
      IMPORTING
        iv_travel_id  TYPE ty_travel_id
      RETURNING
        VALUE(rv_url) TYPE string.

    METHODS key_from
      IMPORTING
        it_key_tab          TYPE /iwbep/t_mgw_name_value_pair
      RETURNING
        VALUE(rv_travel_id) TYPE ty_travel_id
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS key_value
      IMPORTING
        it_key_tab      TYPE /iwbep/t_mgw_name_value_pair
        iv_name         TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    METHODS fill_status_text
      CHANGING
        ct_travel TYPE zcl_zstg_demo_mpc=>tt_travel.
    METHODS ranges_for
      IMPORTING
        iv_property      TYPE string
        it_filter        TYPE /iwbep/t_mgw_select_option
      RETURNING
        VALUE(rt_ranges) TYPE ty_ranges.
ENDCLASS.

CLASS zcl_zstg_demo_dpc_ext IMPLEMENTATION.

  METHOD ranges_for.
    DATA ls_filter TYPE /iwbep/s_mgw_select_option.
    DATA ls_option TYPE /iwbep/s_cod_select_option.
    DATA ls_range  TYPE ty_range.

    LOOP AT it_filter INTO ls_filter.
      IF to_upper( ls_filter-property ) <> to_upper( iv_property ).
        CONTINUE.
      ENDIF.
      LOOP AT ls_filter-select_options INTO ls_option.
        ls_range-sign   = ls_option-sign.
        ls_range-option = ls_option-option.
        ls_range-low    = ls_option-low.
        ls_range-high   = ls_option-high.
        APPEND ls_range TO rt_ranges.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD travelset_get_entityset.
    DATA lt_travel_id   TYPE ty_ranges.
    DATA lt_status      TYPE ty_ranges.
    DATA lt_description TYPE ty_ranges.
    DATA lt_seats       TYPE ty_ranges.
    DATA lv_skip        TYPE i.
    DATA lv_top         TYPE i.
    DATA lv_index       TYPE i.
    DATA lv_search      TYPE string.
    FIELD-SYMBOLS <ls_travel> LIKE LINE OF et_entityset.

* every filterable property becomes a range; startswith/substringof arrive
* as CP patterns and go to the database as LIKE
    lt_travel_id = ranges_for( iv_property = 'TravelId'
                               it_filter   = it_filter_select_options ).
    lt_status = ranges_for( iv_property = 'Status'
                            it_filter   = it_filter_select_options ).
    lt_description = ranges_for( iv_property = 'Description'
                                 it_filter   = it_filter_select_options ).
    lt_seats = ranges_for( iv_property = 'Seats'
                           it_filter   = it_filter_select_options ).

    SELECT travel_id description status seats
      FROM zstg_demo
      INTO CORRESPONDING FIELDS OF TABLE et_entityset
      WHERE travel_id IN lt_travel_id
        AND status IN lt_status
        AND description IN lt_description
        AND seats IN lt_seats
      ORDER BY travel_id.

* the filter bar's search field (sap:searchable): id or description contains
    IF iv_search_string IS NOT INITIAL.
      lv_search = to_upper( iv_search_string ).
      LOOP AT et_entityset ASSIGNING <ls_travel>.
        IF to_upper( <ls_travel>-description ) NS lv_search AND to_upper( <ls_travel>-travel_id ) NS lv_search.
          DELETE et_entityset.
        ENDIF.
      ENDLOOP.
    ENDIF.
    fill_status_text( CHANGING ct_travel = et_entityset ).
    fill_photo_url( CHANGING ct_travel = et_entityset ).

* $orderby, after the derived properties are filled, so StatusText can be
* sorted on, and before paging, so skip and top count the ordered rows
    order_travel( EXPORTING it_order = it_order CHANGING ct_travel = et_entityset ).

* paging the way most hand-written DPCs do it: after the SELECT
    lv_skip = is_paging-skip.
    lv_top  = is_paging-top.
    IF lv_skip > 0.
      DO lv_skip TIMES.
        DELETE et_entityset INDEX 1.
      ENDDO.
    ENDIF.
    IF lv_top > 0.
      lv_index = lv_top + 1.
      WHILE lines( et_entityset ) >= lv_index.
        DELETE et_entityset INDEX lv_index.
      ENDWHILE.
    ENDIF.
  ENDMETHOD.

  METHOD unknown_order_property.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
      EXPORTING
        message = |$orderby: { iv_set } has no property { iv_property }|.
  ENDMETHOD.

  METHOD order_travel.
    DATA lv_index TYPE i.
    DATA ls_order TYPE /iwbep/s_mgw_sorting_order.
    DATA lv_desc  TYPE abap_bool.

    lv_index = lines( it_order ).
    WHILE lv_index >= 1.
      READ TABLE it_order INDEX lv_index INTO ls_order.
      lv_desc = boolc( to_lower( ls_order-order ) = 'desc' ).
      CASE to_upper( ls_order-property ).
        WHEN 'TRAVELID'.
          IF lv_desc = abap_true.
            SORT ct_travel BY travel_id DESCENDING.
          ELSE.
            SORT ct_travel BY travel_id ASCENDING.
          ENDIF.
        WHEN 'DESCRIPTION'.
          IF lv_desc = abap_true.
            SORT ct_travel BY description DESCENDING.
          ELSE.
            SORT ct_travel BY description ASCENDING.
          ENDIF.
        WHEN 'STATUS'.
          IF lv_desc = abap_true.
            SORT ct_travel BY status DESCENDING.
          ELSE.
            SORT ct_travel BY status ASCENDING.
          ENDIF.
        WHEN 'SEATS'.
          IF lv_desc = abap_true.
            SORT ct_travel BY seats DESCENDING.
          ELSE.
            SORT ct_travel BY seats ASCENDING.
          ENDIF.
        WHEN 'STATUSTEXT'.
          IF lv_desc = abap_true.
            SORT ct_travel BY status_text DESCENDING.
          ELSE.
            SORT ct_travel BY status_text ASCENDING.
          ENDIF.
        WHEN OTHERS.
          unknown_order_property( iv_property = ls_order-property iv_set = 'TravelSet' ).
      ENDCASE.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD order_booking.
    DATA lv_index TYPE i.
    DATA ls_order TYPE /iwbep/s_mgw_sorting_order.
    DATA lv_desc  TYPE abap_bool.

    lv_index = lines( it_order ).
    WHILE lv_index >= 1.
      READ TABLE it_order INDEX lv_index INTO ls_order.
      lv_desc = boolc( to_lower( ls_order-order ) = 'desc' ).
      CASE to_upper( ls_order-property ).
        WHEN 'TRAVELID'.
          IF lv_desc = abap_true.
            SORT ct_booking BY travel_id DESCENDING.
          ELSE.
            SORT ct_booking BY travel_id ASCENDING.
          ENDIF.
        WHEN 'BOOKINGID'.
          IF lv_desc = abap_true.
            SORT ct_booking BY booking_id DESCENDING.
          ELSE.
            SORT ct_booking BY booking_id ASCENDING.
          ENDIF.
        WHEN 'CUSTOMER'.
          IF lv_desc = abap_true.
            SORT ct_booking BY customer DESCENDING.
          ELSE.
            SORT ct_booking BY customer ASCENDING.
          ENDIF.
        WHEN 'FLIGHTDATE'.
          IF lv_desc = abap_true.
            SORT ct_booking BY flight_date DESCENDING.
          ELSE.
            SORT ct_booking BY flight_date ASCENDING.
          ENDIF.
        WHEN OTHERS.
          unknown_order_property( iv_property = ls_order-property iv_set = 'BookingSet' ).
      ENDCASE.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD order_photo.
    DATA lv_index TYPE i.
    DATA ls_order TYPE /iwbep/s_mgw_sorting_order.
    DATA lv_desc  TYPE abap_bool.

    lv_index = lines( it_order ).
    WHILE lv_index >= 1.
      READ TABLE it_order INDEX lv_index INTO ls_order.
      lv_desc = boolc( to_lower( ls_order-order ) = 'desc' ).
      CASE to_upper( ls_order-property ).
        WHEN 'TRAVELID'.
          IF lv_desc = abap_true.
            SORT ct_photo BY travel_id DESCENDING.
          ELSE.
            SORT ct_photo BY travel_id ASCENDING.
          ENDIF.
        WHEN 'MIMETYPE'.
          IF lv_desc = abap_true.
            SORT ct_photo BY mime_type DESCENDING.
          ELSE.
            SORT ct_photo BY mime_type ASCENDING.
          ENDIF.
        WHEN 'FILENAME'.
          IF lv_desc = abap_true.
            SORT ct_photo BY file_name DESCENDING.
          ELSE.
            SORT ct_photo BY file_name ASCENDING.
          ENDIF.
        WHEN OTHERS.
          unknown_order_property( iv_property = ls_order-property iv_set = 'PhotoSet' ).
      ENDCASE.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD key_from.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.

    READ TABLE it_key_tab INTO ls_key WITH KEY name = 'TravelId'.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = 'Key TravelId missing'.
    ENDIF.
    rv_travel_id = ls_key-value.
  ENDMETHOD.

  METHOD travelset_create_entity.
    DATA ls_row TYPE zstg_demo.

    io_data_provider->read_entry_data( IMPORTING es_data = er_entity ).
    IF er_entity-travel_id IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = 'TravelId is required'.
    ENDIF.

    ls_row-mandt = sy-mandt.
    MOVE-CORRESPONDING er_entity TO ls_row.
    INSERT zstg_demo FROM ls_row.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Travel { er_entity-travel_id } already exists|.
    ENDIF.
  ENDMETHOD.

  METHOD travelset_update_entity.
    DATA lv_travel_id TYPE c LENGTH 8.
    DATA ls_row       TYPE zstg_demo.

    lv_travel_id = key_from( it_key_tab ).
    io_data_provider->read_entry_data( IMPORTING es_data = er_entity ).
    er_entity-travel_id = lv_travel_id.

    SELECT SINGLE * FROM zstg_demo INTO ls_row WHERE travel_id = lv_travel_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Travel { lv_travel_id } does not exist|.
    ENDIF.
    MOVE-CORRESPONDING er_entity TO ls_row.
    UPDATE zstg_demo FROM ls_row.
  ENDMETHOD.

  METHOD travelset_delete_entity.
    DATA lv_travel_id TYPE c LENGTH 8.

    lv_travel_id = key_from( it_key_tab ).
    DELETE FROM zstg_demo WHERE travel_id = lv_travel_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Travel { lv_travel_id } does not exist|.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~create_deep_entity.
* Travel with bookings in one request. The deep structure is read from the
* provider, the header inserted, the items inserted with the header key.
    DATA ls_deep    TYPE zcl_zstg_demo_mpc_ext=>ts_travel_deep.
    DATA ls_travel  TYPE zstg_demo.
    DATA ls_booking TYPE zstg_demo_bk.
    FIELD-SYMBOLS <ls_item> TYPE zcl_zstg_demo_mpc=>ts_booking.

    IF iv_entity_set_name <> 'TravelSet'.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
        EXPORTING
          textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
          method = 'CREATE_DEEP_ENTITY'.
    ENDIF.

    io_data_provider->read_entry_data( IMPORTING es_data = ls_deep ).
    IF ls_deep-travel_id IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = 'TravelId is required'.
    ENDIF.

    ls_travel-mandt = sy-mandt.
    MOVE-CORRESPONDING ls_deep TO ls_travel.
    INSERT zstg_demo FROM ls_travel.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Travel { ls_deep-travel_id } already exists|.
    ENDIF.

    LOOP AT ls_deep-to_bookings ASSIGNING <ls_item>.
      <ls_item>-travel_id = ls_deep-travel_id.
      CLEAR ls_booking.
      ls_booking-mandt = sy-mandt.
      MOVE-CORRESPONDING <ls_item> TO ls_booking.
      INSERT zstg_demo_bk FROM ls_booking.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = |Booking { <ls_item>-booking_id } already exists|.
      ENDIF.
    ENDLOOP.

    copy_data_to_ref( EXPORTING is_data = ls_deep
                      CHANGING  cr_data = er_deep_entity ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_expanded_entityset.
* The fast path a hand-written DPC takes for $expand=to_Bookings: two
* SELECTs instead of one per travel, deep rows, and the tech clause that
* tells the framework this navigation is already filled.
    DATA lt_children TYPE /iwbep/if_mgw_odata_expand=>ty_t_node_children.
    DATA ls_child    LIKE LINE OF lt_children.
    DATA lt_travel   TYPE zcl_zstg_demo_mpc=>tt_travel.
    DATA lt_deep     TYPE STANDARD TABLE OF zcl_zstg_demo_mpc_ext=>ts_travel_deep WITH DEFAULT KEY.
    DATA ls_deep     TYPE zcl_zstg_demo_mpc_ext=>ts_travel_deep.
    DATA lt_booking  TYPE STANDARD TABLE OF zcl_zstg_demo_mpc=>ts_booking WITH DEFAULT KEY.
    DATA ls_travel   TYPE zcl_zstg_demo_mpc=>ts_travel.
    DATA ls_booking  TYPE zcl_zstg_demo_mpc=>ts_booking.
    DATA lv_wants    TYPE abap_bool.

    IF io_expand IS BOUND.
      lt_children = io_expand->get_children( ).
      LOOP AT lt_children INTO ls_child.
        IF to_upper( ls_child-tech_nav_prop_name ) = 'TO_BOOKINGS'.
          lv_wants = abap_true.
        ENDIF.
      ENDLOOP.
    ENDIF.

    IF iv_entity_set_name <> 'TravelSet' OR lv_wants = abap_false.
      super->/iwbep/if_mgw_appl_srv_runtime~get_expanded_entityset(
        EXPORTING
          iv_entity_name           = iv_entity_name
          iv_entity_set_name       = iv_entity_set_name
          iv_source_name           = iv_source_name
          it_filter_select_options = it_filter_select_options
          it_order                 = it_order
          is_paging                = is_paging
          it_navigation_path       = it_navigation_path
          it_key_tab               = it_key_tab
          iv_filter_string         = iv_filter_string
          iv_search_string         = iv_search_string
          io_expand                = io_expand
          io_tech_request_context  = io_tech_request_context
        IMPORTING
          er_entityset             = er_entityset
          et_expanded_tech_clauses = et_expanded_tech_clauses
          es_response_context      = es_response_context ).
      RETURN.
    ENDIF.

    travelset_get_entityset(
      EXPORTING
        iv_entity_name           = iv_entity_name
        iv_entity_set_name       = iv_entity_set_name
        iv_source_name           = iv_source_name
        it_filter_select_options = it_filter_select_options
        it_order                 = it_order
        is_paging                = is_paging
        it_navigation_path       = it_navigation_path
        it_key_tab               = it_key_tab
        iv_filter_string         = iv_filter_string
        iv_search_string         = iv_search_string
        io_tech_request_context  = io_tech_request_context
      IMPORTING
        et_entityset             = lt_travel
        es_response_context      = es_response_context ).

* an empty driving table would select every booking (ABAP semantics)
    IF lt_travel IS NOT INITIAL.
      SELECT * FROM zstg_demo_bk
        INTO CORRESPONDING FIELDS OF TABLE lt_booking
        FOR ALL ENTRIES IN lt_travel
        WHERE travel_id = lt_travel-travel_id.
      SORT lt_booking BY travel_id booking_id.
    ENDIF.

    LOOP AT lt_travel INTO ls_travel.
      CLEAR ls_deep.
      MOVE-CORRESPONDING ls_travel TO ls_deep.
      LOOP AT lt_booking INTO ls_booking WHERE travel_id = ls_travel-travel_id.
        APPEND ls_booking TO ls_deep-to_bookings.
      ENDLOOP.
      APPEND ls_deep TO lt_deep.
    ENDLOOP.

    APPEND 'TO_BOOKINGS' TO et_expanded_tech_clauses.
    copy_data_to_ref( EXPORTING is_data = lt_deep
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~execute_action.
    DATA ls_travel TYPE zcl_zstg_demo_mpc=>ts_travel.
    DATA lv_id     TYPE c LENGTH 8.
    DATA lv_status TYPE c LENGTH 1.
    DATA lv_count  TYPE i.

    CASE iv_action_name.
      WHEN 'CancelTravel'.
        lv_id = key_value( it_key_tab = it_parameter
                           iv_name    = 'TravelId' ).
        UPDATE zstg_demo SET status = 'X' WHERE travel_id = lv_id.
        IF sy-subrc <> 0.
          RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
            EXPORTING
              message = |Travel { lv_id } does not exist|.
        ENDIF.
        SELECT SINGLE travel_id description status seats
          FROM zstg_demo
          INTO CORRESPONDING FIELDS OF ls_travel
          WHERE travel_id = lv_id.
        copy_data_to_ref( EXPORTING is_data = ls_travel
                          CHANGING  cr_data = er_data ).
      WHEN 'TravelCount'.
        lv_status = key_value( it_key_tab = it_parameter
                               iv_name    = 'Status' ).
        IF lv_status IS INITIAL.
          SELECT COUNT( * ) FROM zstg_demo INTO lv_count.
        ELSE.
          SELECT COUNT( * ) FROM zstg_demo INTO lv_count WHERE status = lv_status.
        ENDIF.
        copy_data_to_ref( EXPORTING is_data = lv_count
                          CHANGING  cr_data = er_data ).
      WHEN OTHERS.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
          EXPORTING
            textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
            method = iv_action_name.
    ENDCASE.
  ENDMETHOD.

  METHOD key_value.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.

    READ TABLE it_key_tab INTO ls_key WITH KEY name = iv_name.
    IF sy-subrc = 0.
      rv_value = ls_key-value.
    ENDIF.
  ENDMETHOD.

  METHOD bookingset_get_entityset.
    DATA lt_travel_id TYPE ty_ranges.
    DATA ls_range     TYPE ty_range.
    DATA lv_parent    TYPE string.

    lt_travel_id = ranges_for( iv_property = 'TravelId'
                               it_filter   = it_filter_select_options ).

* navigation TravelSet('x')/to_Bookings: the source keys arrive in it_key_tab
    IF it_navigation_path IS NOT INITIAL.
      lv_parent = key_value( it_key_tab = it_key_tab
                             iv_name    = 'TravelId' ).
      IF lv_parent IS NOT INITIAL.
        ls_range-sign   = 'I'.
        ls_range-option = 'EQ'.
        ls_range-low    = lv_parent.
        APPEND ls_range TO lt_travel_id.
      ENDIF.
    ENDIF.

    SELECT travel_id booking_id customer flight_date
      FROM zstg_demo_bk
      INTO CORRESPONDING FIELDS OF TABLE et_entityset
      WHERE travel_id IN lt_travel_id
      ORDER BY travel_id booking_id.

    order_booking( EXPORTING it_order = it_order CHANGING ct_booking = et_entityset ).
  ENDMETHOD.

  METHOD bookingset_get_entity.
    DATA lv_travel_id  TYPE c LENGTH 8.
    DATA lv_booking_id TYPE c LENGTH 4.

    lv_travel_id  = key_value( it_key_tab = it_key_tab
                               iv_name    = 'TravelId' ).
    lv_booking_id = key_value( it_key_tab = it_key_tab
                               iv_name    = 'BookingId' ).

    SELECT SINGLE travel_id booking_id customer flight_date
      FROM zstg_demo_bk
      INTO CORRESPONDING FIELDS OF er_entity
      WHERE travel_id = lv_travel_id
        AND booking_id = lv_booking_id.
  ENDMETHOD.

  METHOD travelset_get_entity.
    DATA lv_travel_id TYPE c LENGTH 8.
    DATA lv_photo_id  TYPE ty_travel_id.

    lv_travel_id = key_from( it_key_tab ).

    SELECT SINGLE travel_id description status seats
      FROM zstg_demo
      INTO CORRESPONDING FIELDS OF er_entity
      WHERE travel_id = lv_travel_id.
    IF sy-subrc = 0.
      SELECT SINGLE status_text FROM zstg_status
        INTO er_entity-status_text
        WHERE status = er_entity-status.
      SELECT SINGLE travel_id FROM zstg_photo
        INTO lv_photo_id
        WHERE travel_id = lv_travel_id.
      IF sy-subrc = 0.
        er_entity-photo_url = photo_url( lv_travel_id ).
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD fill_status_text.
    DATA lt_status TYPE zcl_zstg_demo_mpc=>tt_statusvh.
    DATA ls_status LIKE LINE OF lt_status.
    FIELD-SYMBOLS <ls_travel> LIKE LINE OF ct_travel.

    IF ct_travel IS INITIAL.
      RETURN.
    ENDIF.
    SELECT status status_text FROM zstg_status
      INTO CORRESPONDING FIELDS OF TABLE lt_status.
    LOOP AT ct_travel ASSIGNING <ls_travel>.
      READ TABLE lt_status INTO ls_status WITH KEY status = <ls_travel>-status.
      IF sy-subrc = 0.
        <ls_travel>-status_text = ls_status-status_text.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD photoset_get_entityset.
    SELECT travel_id mime_type file_name
      FROM zstg_photo
      INTO CORRESPONDING FIELDS OF TABLE et_entityset
      ORDER BY travel_id.

    order_photo( EXPORTING it_order = it_order CHANGING ct_photo = et_entityset ).
  ENDMETHOD.

  METHOD photoset_get_entity.
    DATA lv_travel_id TYPE ty_travel_id.

    lv_travel_id = key_from( it_key_tab ).
    SELECT SINGLE travel_id mime_type file_name
      FROM zstg_photo
      INTO CORRESPONDING FIELDS OF er_entity
      WHERE travel_id = lv_travel_id.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_stream.
* GET PhotoSet('T0001')/$value: the bytes of the picture and their type.
* er_stream is the media resource the interface declares, handed over the
* way a SEGW-generated DPC does it, through copy_data_to_ref.
    DATA ls_stream    TYPE /iwbep/if_mgw_appl_types=>ty_s_media_resource.
    DATA ls_photo     TYPE zstg_photo.
    DATA lv_travel_id TYPE ty_travel_id.

    IF iv_entity_set_name <> 'PhotoSet'.
      super->/iwbep/if_mgw_appl_srv_runtime~get_stream(
        EXPORTING
          iv_entity_name          = iv_entity_name
          iv_entity_set_name      = iv_entity_set_name
          iv_source_name          = iv_source_name
          it_key_tab              = it_key_tab
          it_navigation_path      = it_navigation_path
          io_tech_request_context = io_tech_request_context
        IMPORTING
          er_stream               = er_stream
          es_response_context     = es_response_context ).
      RETURN.
    ENDIF.

    lv_travel_id = key_from( it_key_tab ).
    SELECT SINGLE * FROM zstg_photo
      INTO ls_photo
      WHERE travel_id = lv_travel_id.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    ls_stream-mime_type = ls_photo-mime_type.
    ls_stream-value     = ls_photo-content.
    copy_data_to_ref(
      EXPORTING
        is_data = ls_stream
      CHANGING
        cr_data = er_stream ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~update_stream.
* PUT PhotoSet('T0001')/$value: a new picture for a travel that has one
    DATA lv_travel_id TYPE ty_travel_id.
    DATA lv_mime      TYPE c LENGTH 40.

    IF iv_entity_set_name <> 'PhotoSet'.
      super->/iwbep/if_mgw_appl_srv_runtime~update_stream(
        EXPORTING
          iv_entity_name          = iv_entity_name
          iv_entity_set_name      = iv_entity_set_name
          iv_source_name          = iv_source_name
          is_media_resource       = is_media_resource
          it_key_tab              = it_key_tab
          it_navigation_path      = it_navigation_path
          io_tech_request_context = io_tech_request_context ).
      RETURN.
    ENDIF.

    lv_travel_id = key_from( it_key_tab ).
    lv_mime      = is_media_resource-mime_type.
    UPDATE zstg_photo
      SET mime_type = lv_mime
          content   = is_media_resource-value
      WHERE travel_id = lv_travel_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |No picture for travel { lv_travel_id }|.
    ENDIF.
  ENDMETHOD.

  METHOD photo_url.
    rv_url = |{ gc_media_base }/PhotoSet('{ iv_travel_id }')/$value|.
  ENDMETHOD.

  METHOD fill_photo_url.
* the travels that have a picture carry the URL of its media resource;
* UI.IsImageURL on the property is what makes Fiori Elements show it
    DATA lt_id TYPE STANDARD TABLE OF ty_travel_id WITH DEFAULT KEY.
    DATA lv_id TYPE ty_travel_id.
    FIELD-SYMBOLS <ls_travel> LIKE LINE OF ct_travel.

    IF ct_travel IS INITIAL.
      RETURN.
    ENDIF.
    SELECT travel_id FROM zstg_photo INTO TABLE lt_id.
    LOOP AT ct_travel ASSIGNING <ls_travel>.
      READ TABLE lt_id INTO lv_id WITH KEY table_line = <ls_travel>-travel_id.
      IF sy-subrc = 0.
        <ls_travel>-photo_url = photo_url( <ls_travel>-travel_id ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD statusvhset_get_entityset.
* the F4 list the way SEGW maps an entity set to a search help: the filter
* becomes selection options of ZSTG_STATUS_SH, the runtime answers in
* record / field / value rows, mapped back here (the generated template);
* $search over the text is ours on top, the value help dialog sends it
    DATA ls_filter  TYPE /iwbep/s_mgw_select_option.
    DATA ls_range   TYPE /iwbep/s_cod_select_option.
    DATA lt_selopt  TYPE ddshselops.
    DATA ls_selopt  LIKE LINE OF lt_selopt.
    DATA lt_result  TYPE /iwbep/if_sb_gendpc_shlp_data=>tt_result_list.
    DATA ls_result  LIKE LINE OF lt_result.
    DATA ls_message TYPE bapiret2.
    DATA ls_row     LIKE LINE OF et_entityset.
    DATA lv_record  TYPE i.
    DATA lv_search  TYPE string.
    FIELD-SYMBOLS <ls_row> LIKE LINE OF et_entityset.

    LOOP AT it_filter_select_options INTO ls_filter.
      CASE ls_filter-property.
        WHEN 'Status'.
          ls_selopt-shlpfield = 'STATUS'.
        WHEN 'Text'.
          ls_selopt-shlpfield = 'STATUS_TEXT'.
        WHEN OTHERS.
          CONTINUE.
      ENDCASE.
      ls_selopt-shlpname = 'ZSTG_STATUS_SH'.
      LOOP AT ls_filter-select_options INTO ls_range.
        ls_selopt-sign   = ls_range-sign.
        ls_selopt-option = ls_range-option.
        ls_selopt-low    = ls_range-low.
        ls_selopt-high   = ls_range-high.
        APPEND ls_selopt TO lt_selopt.
      ENDLOOP.
    ENDLOOP.

    me->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
      EXPORTING
        iv_shlp_name      = 'ZSTG_STATUS_SH'
        iv_maxrows        = is_paging-top
        iv_sort           = abap_true
        iv_call_shlt_exit = abap_true
        it_selopt         = lt_selopt
      IMPORTING
        et_return_list    = lt_result
        es_message        = ls_message ).
    IF ls_message IS NOT INITIAL.
* a generated DPC does this through /iwbep/if_sb_dpc_comm_services~rfc_save_log
      /iwbep/cl_sb_gen_dpc_rt_util=>rfc_save_log(
        is_return            = ls_message
        iv_entity_type       = iv_entity_name
        it_key_tab           = it_key_tab
        io_logger            = /iwbep/if_mgw_conv_srv_runtime~get_logger( )
        io_message_container = /iwbep/if_mgw_conv_srv_runtime~get_message_container( ) ).
    ENDIF.

    CLEAR et_entityset.
    LOOP AT lt_result INTO ls_result.
      IF ls_result-record_number <> lv_record.
        IF lv_record > 0.
          APPEND ls_row TO et_entityset.
        ENDIF.
        CLEAR ls_row.
        lv_record = ls_result-record_number.
      ENDIF.
      CASE ls_result-field_name.
        WHEN 'STATUS'.
          ls_row-status = ls_result-field_value.
        WHEN 'STATUS_TEXT'.
          ls_row-status_text = ls_result-field_value.
      ENDCASE.
    ENDLOOP.
    IF lv_record > 0.
      APPEND ls_row TO et_entityset.
    ENDIF.

    IF iv_search_string IS NOT INITIAL.
      lv_search = to_upper( iv_search_string ).
      LOOP AT et_entityset ASSIGNING <ls_row>.
        IF to_upper( <ls_row>-status_text ) NS lv_search AND to_upper( <ls_row>-status ) NS lv_search.
          DELETE et_entityset.
        ENDIF.
      ENDLOOP.
    ENDIF.
  ENDMETHOD.

  METHOD bookingset_create_entity.
    DATA ls_row     TYPE zstg_demo_bk.
    DATA lt_last    TYPE STANDARD TABLE OF ty_booking_id WITH DEFAULT KEY.
    DATA lv_last    TYPE ty_booking_id.
    DATA lv_number  TYPE i.
    DATA lv_parent  TYPE string.

    io_data_provider->read_entry_data( IMPORTING es_data = er_entity ).
* created below a travel (POST TravelSet('T0001')/to_Bookings): the parent
* key comes with the navigation path, the payload need not repeat it
    IF er_entity-travel_id IS INITIAL AND it_navigation_path IS NOT INITIAL.
      lv_parent = key_value( it_key_tab = it_key_tab
                             iv_name    = 'TravelId' ).
      er_entity-travel_id = lv_parent.
    ENDIF.
    IF er_entity-travel_id IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = 'TravelId is required'.
    ENDIF.
    SELECT SINGLE travel_id FROM zstg_demo INTO lv_parent
      WHERE travel_id = er_entity-travel_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Travel { er_entity-travel_id } does not exist|.
    ENDIF.
* no booking number given: the next one below this travel (B001, B002, ...)
    IF er_entity-booking_id IS INITIAL.
      SELECT booking_id FROM zstg_demo_bk INTO TABLE lt_last
        WHERE travel_id = er_entity-travel_id
        ORDER BY booking_id DESCENDING.
      READ TABLE lt_last INDEX 1 INTO lv_last.
      IF sy-subrc = 0.
        lv_number = lv_last+1(3).
      ENDIF.
      lv_number = lv_number + 1.
      er_entity-booking_id = |B{ lv_number WIDTH = 3 ALIGN = RIGHT PAD = '0' }|.
    ENDIF.

    ls_row-mandt = sy-mandt.
    MOVE-CORRESPONDING er_entity TO ls_row.
    INSERT zstg_demo_bk FROM ls_row.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Booking { er_entity-booking_id } already exists below { er_entity-travel_id }|.
    ENDIF.
  ENDMETHOD.

  METHOD bookingset_update_entity.
    DATA ls_row TYPE zstg_demo_bk.

    io_data_provider->read_entry_data( IMPORTING es_data = er_entity ).
    er_entity-travel_id  = key_value( it_key_tab = it_key_tab
                                      iv_name    = 'TravelId' ).
    er_entity-booking_id = key_value( it_key_tab = it_key_tab
                                      iv_name    = 'BookingId' ).
    ls_row-mandt = sy-mandt.
    MOVE-CORRESPONDING er_entity TO ls_row.
    UPDATE zstg_demo_bk FROM ls_row.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Booking { er_entity-booking_id } does not exist|.
    ENDIF.
  ENDMETHOD.

  METHOD bookingset_delete_entity.
    DATA lv_travel_id  TYPE c LENGTH 8.
    DATA lv_booking_id TYPE c LENGTH 4.

    lv_travel_id  = key_value( it_key_tab = it_key_tab
                               iv_name    = 'TravelId' ).
    lv_booking_id = key_value( it_key_tab = it_key_tab
                               iv_name    = 'BookingId' ).
    DELETE FROM zstg_demo_bk WHERE travel_id = lv_travel_id AND booking_id = lv_booking_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |Booking { lv_booking_id } does not exist|.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
