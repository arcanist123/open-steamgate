CLASS zcl_osd_h5x_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
* The read shape of a SEGW sample's business sets, synthetic and written
* fresh: the technical context's WHERE and ORDER BY in ABAP names, mapped
* by text replacement onto the aliases of a join; a SELECT ... ENDSELECT
* over the join with an INTO list that fills a complex component, UP TO
* top + skip rows, the first skip rows dropped by sy-dbcnt; $count and the
* inline count by SELECT COUNT( * ) over the same join.
*
* Milestone 3 (B2), the request-context contract such a provider is
* written against:
* - a read with no source set is direct: the keys come from
*   get_converted_keys; an answered source set means "navigation", resolved
*   from get_navigation_path;
* - the first row of the path starts at the source: its keys come from
*   get_converted_source_keys into the SOURCE type's structure;
* - a step's key_tab holds the step's target keys in ABAP field names (one
*   key read by index, a two-part key by name), and is empty for a step to
*   be read as a set or a to-one step;
* - a navigation that ends in a collection reads the set with one more
*   condition, the parent's key on the join's alias;
* - iv_source_name names the type the navigation starts from (the first
*   row's source), empty on a direct read; a mismatch is refused here so a
*   gateway that passes the wrong name fails the tests;
* - the default order of the item set is two columns separated by a blank,
*   and $orderby is concatenated the same way: legal Open SQL that SQL only
*   takes with commas (ANORMALIES "dynamic-order-by-blanks").
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
  PRIVATE SECTION.
    CONSTANTS c_partner TYPE string VALUE 'Partner'.
    CONSTANTS c_order   TYPE string VALUE 'Order'.
    CONSTANTS c_item    TYPE string VALUE 'OrderItem'.
    CONSTANTS c_contact TYPE string VALUE 'Contact'.

    CLASS-METHODS to_sql
      IMPORTING
        iv_string        TYPE string
      RETURNING
        VALUE(rv_string) TYPE string.
    CLASS-METHODS orderby_of
      IMPORTING
        io_ctx          TYPE REF TO /iwbep/if_mgw_req_entityset
      RETURNING
        VALUE(rv_order) TYPE string.
    CLASS-METHODS add_where
      IMPORTING
        iv_where        TYPE string
        iv_add          TYPE string
      RETURNING
        VALUE(rv_where) TYPE string.
    CLASS-METHODS not_found
      IMPORTING
        iv_what TYPE string
      RAISING
        /iwbep/cx_mgw_busi_exception.
    CLASS-METHODS check_source_name
      IMPORTING
        iv_source_name TYPE string
        it_path        TYPE /iwbep/t_mgw_tech_navi
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS partner_set
      IMPORTING
        io_ctx              TYPE REF TO /iwbep/if_mgw_req_entityset
      EXPORTING
        er_entityset        TYPE REF TO data
        es_response_context TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context.
    METHODS order_set
      IMPORTING
        io_ctx              TYPE REF TO /iwbep/if_mgw_req_entityset
        iv_add              TYPE string OPTIONAL
      EXPORTING
        er_entityset        TYPE REF TO data
        es_response_context TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context.
    METHODS item_set
      IMPORTING
        io_ctx              TYPE REF TO /iwbep/if_mgw_req_entityset
        iv_add              TYPE string OPTIONAL
      EXPORTING
        er_entityset        TYPE REF TO data
        es_response_context TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context
      RAISING
        /iwbep/cx_mgw_busi_exception.
    METHODS contact_set
      IMPORTING
        iv_add              TYPE string OPTIONAL
      EXPORTING
        er_entityset        TYPE REF TO data.

    METHODS partner_single
      IMPORTING
        iv_partner_id    TYPE clike
      RETURNING
        VALUE(rs_entity) TYPE zcl_osd_h5x_mpc=>ts_partner
      RAISING
        /iwbep/cx_mgw_busi_exception.
    METHODS order_single
      IMPORTING
        iv_order_id      TYPE clike
      RETURNING
        VALUE(rs_entity) TYPE zcl_osd_h5x_mpc=>ts_order
      RAISING
        /iwbep/cx_mgw_busi_exception.
    METHODS item_single
      IMPORTING
        iv_order_id      TYPE clike
        iv_item_pos      TYPE clike
      RETURNING
        VALUE(rs_entity) TYPE zcl_osd_h5x_mpc=>ts_order_item
      RAISING
        /iwbep/cx_mgw_busi_exception.
    METHODS contact_single
      IMPORTING
        iv_contact_guid  TYPE xsequence
      RETURNING
        VALUE(rs_entity) TYPE zcl_osd_h5x_mpc=>ts_contact
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS resolve_navigation
      IMPORTING
        io_entity           TYPE REF TO /iwbep/if_mgw_req_entity OPTIONAL
        io_entityset        TYPE REF TO /iwbep/if_mgw_req_entityset OPTIONAL
      EXPORTING
        er_data             TYPE REF TO data
        es_response_context TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context
      RAISING
        /iwbep/cx_mgw_busi_exception.
ENDCLASS.

CLASS zcl_osd_h5x_dpc IMPLEMENTATION.
  METHOD to_sql.
* no name here is a part of another, so the order does not matter
    rv_string = iv_string.
    REPLACE ALL OCCURRENCES OF 'PARTNER_ID' IN rv_string WITH 'b~PARTNER_ID'.
    REPLACE ALL OCCURRENCES OF 'NAME' IN rv_string WITH 'b~NAME'.
    REPLACE ALL OCCURRENCES OF 'CHANGED_AT' IN rv_string WITH 'b~CHANGED_AT'.
    REPLACE ALL OCCURRENCES OF 'ADDRESS-CITY' IN rv_string WITH 'a~CITY'.
    REPLACE ALL OCCURRENCES OF 'ADDRESS-COUNTRY' IN rv_string WITH 'a~COUNTRY'.
  ENDMETHOD.

  METHOD orderby_of.
* the technical order as a SEGW sample concatenates it: separated by blanks
    DATA lt_orderby   TYPE /iwbep/t_mgw_tech_order.
    DATA ls_orderby   LIKE LINE OF lt_orderby.
    DATA lv_property  TYPE string.
    DATA lv_direction TYPE string.

    lt_orderby = io_ctx->get_orderby( ).
    LOOP AT lt_orderby INTO ls_orderby.
      lv_property = ls_orderby-property.
      IF lv_property IS INITIAL.
        lv_property = ls_orderby-property_path.
      ENDIF.
      lv_direction = 'ASCENDING'.
      IF ls_orderby-order = 'desc'.
        lv_direction = 'DESCENDING'.
      ENDIF.
      CONCATENATE rv_order lv_property lv_direction INTO rv_order SEPARATED BY space.
    ENDLOOP.
    CONDENSE rv_order.
  ENDMETHOD.

  METHOD add_where.
    rv_where = iv_where.
    IF iv_add IS INITIAL.
      RETURN.
    ENDIF.
    IF rv_where IS INITIAL.
      rv_where = iv_add.
    ELSE.
      rv_where = |( { rv_where } ) AND { iv_add }|.
    ENDIF.
  ENDMETHOD.

  METHOD not_found.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
      EXPORTING
        message = |{ iv_what } not found|.
  ENDMETHOD.

  METHOD check_source_name.
    DATA ls_first LIKE LINE OF it_path.

    READ TABLE it_path INTO ls_first INDEX 1.
    IF iv_source_name <> ls_first-source_entity_type.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = |iv_source_name '{ iv_source_name }' is not the navigation's source '{ ls_first-source_entity_type }'|.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    check_source_name( iv_source_name = iv_source_name
                       it_path        = io_tech_request_context->get_navigation_path( ) ).
* a direct read has no source set; an answered one means "navigation"
    IF io_tech_request_context->get_source_entity_set_name( ) IS NOT INITIAL.
      resolve_navigation( EXPORTING io_entityset        = io_tech_request_context
                          IMPORTING er_data             = er_entityset
                                    es_response_context = es_response_context ).
      RETURN.
    ENDIF.

    CASE iv_entity_name.
      WHEN c_partner.
        partner_set( EXPORTING io_ctx              = io_tech_request_context
                     IMPORTING er_entityset        = er_entityset
                               es_response_context = es_response_context ).
      WHEN c_order.
        order_set( EXPORTING io_ctx              = io_tech_request_context
                   IMPORTING er_entityset        = er_entityset
                             es_response_context = es_response_context ).
      WHEN c_item.
        item_set( EXPORTING io_ctx              = io_tech_request_context
                  IMPORTING er_entityset        = er_entityset
                            es_response_context = es_response_context ).
      WHEN c_contact.
        contact_set( IMPORTING er_entityset = er_entityset ).
    ENDCASE.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entity.
    DATA ls_partner TYPE zcl_osd_h5x_mpc=>ts_partner.
    DATA ls_order   TYPE zcl_osd_h5x_mpc=>ts_order.
    DATA ls_item    TYPE zcl_osd_h5x_mpc=>ts_order_item.
    DATA ls_contact TYPE zcl_osd_h5x_mpc=>ts_contact.
    DATA ls_context TYPE /iwbep/if_mgw_appl_srv_runtime=>ty_s_mgw_response_context.

    check_source_name( iv_source_name = iv_source_name
                       it_path        = io_tech_request_context->get_navigation_path( ) ).
* no source set: a direct read, keys from get_converted_keys
    IF io_tech_request_context->get_source_entity_set_name( ) IS NOT INITIAL.
      resolve_navigation( EXPORTING io_entity           = io_tech_request_context
                          IMPORTING er_data             = er_entity
                                    es_response_context = ls_context ).
      RETURN.
    ENDIF.

    CASE iv_entity_name.
      WHEN c_partner.
        io_tech_request_context->get_converted_keys( IMPORTING es_key_values = ls_partner ).
        ls_partner = partner_single( ls_partner-partner_id ).
        copy_data_to_ref( EXPORTING is_data = ls_partner
                          CHANGING  cr_data = er_entity ).
      WHEN c_order.
        io_tech_request_context->get_converted_keys( IMPORTING es_key_values = ls_order ).
        ls_order = order_single( ls_order-order_id ).
        copy_data_to_ref( EXPORTING is_data = ls_order
                          CHANGING  cr_data = er_entity ).
      WHEN c_item.
        io_tech_request_context->get_converted_keys( IMPORTING es_key_values = ls_item ).
        ls_item = item_single( iv_order_id = ls_item-order_id
                               iv_item_pos = ls_item-item_pos ).
        copy_data_to_ref( EXPORTING is_data = ls_item
                          CHANGING  cr_data = er_entity ).
      WHEN c_contact.
        io_tech_request_context->get_converted_keys( IMPORTING es_key_values = ls_contact ).
        ls_contact = contact_single( ls_contact-contact_guid ).
        copy_data_to_ref( EXPORTING is_data = ls_contact
                          CHANGING  cr_data = er_entity ).
    ENDCASE.
  ENDMETHOD.

  METHOD resolve_navigation.
    DATA lt_path    TYPE /iwbep/t_mgw_tech_navi.
    DATA ls_step    LIKE LINE OF lt_path.
    DATA ls_key     TYPE /iwbep/s_mgw_tech_pair.
    DATA lv_from    TYPE string.
    DATA lv_set     TYPE abap_bool.
    DATA ls_partner TYPE zcl_osd_h5x_mpc=>ts_partner.
    DATA ls_order   TYPE zcl_osd_h5x_mpc=>ts_order.
    DATA ls_item    TYPE zcl_osd_h5x_mpc=>ts_order_item.
    DATA ls_contact TYPE zcl_osd_h5x_mpc=>ts_contact.
    DATA lv_id      TYPE c LENGTH 10.
    DATA lv_pos     TYPE c LENGTH 10.
    DATA lv_guid    TYPE x LENGTH 16.
    FIELD-SYMBOLS <ls_source> TYPE any.

    CLEAR: er_data, es_response_context.
    IF io_entity IS BOUND.
      lt_path = io_entity->get_navigation_path( ).
    ELSEIF io_entityset IS BOUND.
      lt_path = io_entityset->get_navigation_path( ).
    ENDIF.

    LOOP AT lt_path INTO ls_step.
* the first step starts at the source: its keys, converted into the
* source type's structure, read the source entity
      IF lv_from IS INITIAL.
        CASE ls_step-source_entity_type.
          WHEN c_partner.
            ASSIGN ls_partner TO <ls_source>.
          WHEN c_order.
            ASSIGN ls_order TO <ls_source>.
          WHEN c_item.
            ASSIGN ls_item TO <ls_source>.
          WHEN c_contact.
            ASSIGN ls_contact TO <ls_source>.
          WHEN OTHERS.
            not_found( |Source type { ls_step-source_entity_type }| ).
        ENDCASE.
        IF io_entity IS BOUND.
          io_entity->get_converted_source_keys( IMPORTING es_key_values = <ls_source> ).
        ELSE.
          io_entityset->get_converted_source_keys( IMPORTING es_key_values = <ls_source> ).
        ENDIF.
        CASE ls_step-source_entity_type.
          WHEN c_partner.
            ls_partner = partner_single( ls_partner-partner_id ).
          WHEN c_order.
            ls_order = order_single( ls_order-order_id ).
          WHEN c_item.
            ls_item = item_single( iv_order_id = ls_item-order_id
                                   iv_item_pos = ls_item-item_pos ).
          WHEN c_contact.
            ls_contact = contact_single( ls_contact-contact_guid ).
        ENDCASE.
        lv_from = ls_step-source_entity_type.
      ENDIF.

      CASE lv_from.
        WHEN c_partner.
          CASE ls_step-target_entity_type.
            WHEN c_order.
              IF ls_step-key_tab IS NOT INITIAL.
                READ TABLE ls_step-key_tab INTO ls_key INDEX 1.
                lv_id = ls_key-value.
                ls_order = order_single( lv_id ).
              ELSE.
                order_set( EXPORTING io_ctx              = io_entityset
                                     iv_add              = |s~BUYER_ID = '{ ls_partner-partner_id }'|
                           IMPORTING er_entityset        = er_data
                                     es_response_context = es_response_context ).
                lv_set = abap_true.
                EXIT.
              ENDIF.
            WHEN c_contact.
              IF ls_step-key_tab IS NOT INITIAL.
                READ TABLE ls_step-key_tab INTO ls_key INDEX 1.
                lv_guid = ls_key-value.
                ls_contact = contact_single( lv_guid ).
              ELSE.
                contact_set( EXPORTING iv_add       = |c~PARTNER_ID = '{ ls_partner-partner_id }'|
                             IMPORTING er_entityset = er_data ).
                lv_set = abap_true.
                EXIT.
              ENDIF.
          ENDCASE.
        WHEN c_order.
          CASE ls_step-target_entity_type.
            WHEN c_partner.
              ls_partner = partner_single( ls_order-buyer_id ).
            WHEN c_item.
              IF ls_step-key_tab IS NOT INITIAL.
                CLEAR: lv_id, lv_pos.
                LOOP AT ls_step-key_tab INTO ls_key.
                  CASE ls_key-name.
                    WHEN 'ORDER_ID'.
                      lv_id = ls_key-value.
                    WHEN 'ITEM_POS'.
                      lv_pos = ls_key-value.
                  ENDCASE.
                ENDLOOP.
                ls_item = item_single( iv_order_id = lv_id
                                       iv_item_pos = lv_pos ).
              ELSE.
                item_set( EXPORTING io_ctx              = io_entityset
                                    iv_add              = |s~ORDER_ID = '{ ls_order-order_id }'|
                          IMPORTING er_entityset        = er_data
                                    es_response_context = es_response_context ).
                lv_set = abap_true.
                EXIT.
              ENDIF.
          ENDCASE.
        WHEN c_item.
          IF ls_step-target_entity_type = c_order.
            ls_order = order_single( ls_item-order_id ).
          ENDIF.
        WHEN c_contact.
          IF ls_step-target_entity_type = c_partner.
            ls_partner = partner_single( ls_contact-partner_id ).
          ENDIF.
      ENDCASE.
      lv_from = ls_step-target_entity_type.
    ENDLOOP.

    IF lv_set = abap_true OR lv_from IS INITIAL.
      RETURN.
    ENDIF.
    CASE lv_from.
      WHEN c_partner.
        copy_data_to_ref( EXPORTING is_data = ls_partner
                          CHANGING  cr_data = er_data ).
      WHEN c_order.
        copy_data_to_ref( EXPORTING is_data = ls_order
                          CHANGING  cr_data = er_data ).
      WHEN c_item.
        copy_data_to_ref( EXPORTING is_data = ls_item
                          CHANGING  cr_data = er_data ).
      WHEN c_contact.
        copy_data_to_ref( EXPORTING is_data = ls_contact
                          CHANGING  cr_data = er_data ).
    ENDCASE.
  ENDMETHOD.

  METHOD partner_set.
    DATA ls_entity    TYPE zcl_osd_h5x_mpc=>ts_partner.
    DATA lt_entityset TYPE zcl_osd_h5x_mpc=>tt_partner.
    DATA lv_where     TYPE string.
    DATA lv_orderby   TYPE string.
    DATA lv_top       TYPE i.
    DATA lv_skip      TYPE i.
    DATA lv_maxrows   TYPE i.
    DATA lv_count     TYPE i.

    lv_where = to_sql( io_ctx->get_osql_where_clause_convert( ) ).
    lv_orderby = to_sql( orderby_of( io_ctx ) ).
    IF lv_orderby IS INITIAL.
      lv_orderby = 'b~PARTNER_ID'.
    ENDIF.

    lv_top  = io_ctx->get_top( ).
    lv_skip = io_ctx->get_skip( ).
    IF lv_top > 0.
      lv_maxrows = lv_top + lv_skip.
    ENDIF.

    IF io_ctx->has_count( ) = abap_true.
      SELECT COUNT( * ) INTO (lv_count)
        FROM ( zosd_h5x_bp AS b
               INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
        WHERE (lv_where).
      es_response_context-count = lv_count.
      RETURN.
    ENDIF.

    IF io_ctx->has_inlinecount( ) = abap_true.
      SELECT COUNT( * ) INTO (lv_count)
        FROM ( zosd_h5x_bp AS b
               INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
        WHERE (lv_where).
      es_response_context-inlinecount = lv_count.
    ENDIF.

    SELECT b~partner_id b~name b~changed_at a~city a~country
      INTO (ls_entity-partner_id, ls_entity-name, ls_entity-changed_at,
            ls_entity-address-city, ls_entity-address-country)
      FROM ( zosd_h5x_bp AS b
             INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
      UP TO lv_maxrows ROWS
      WHERE (lv_where)
      ORDER BY (lv_orderby).
      IF sy-dbcnt > lv_skip.
        APPEND ls_entity TO lt_entityset.
      ENDIF.
    ENDSELECT.

    copy_data_to_ref( EXPORTING is_data = lt_entityset
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD order_set.
    DATA ls_entity    TYPE zcl_osd_h5x_mpc=>ts_order.
    DATA lt_entityset TYPE zcl_osd_h5x_mpc=>tt_order.
    DATA lv_where     TYPE string.
    DATA lv_orderby   TYPE string.
    DATA lv_count     TYPE i.

    IF io_ctx IS BOUND.
      lv_where = io_ctx->get_osql_where_clause_convert( ).
      REPLACE ALL OCCURRENCES OF 'ORDER_ID' IN lv_where WITH 's~ORDER_ID'.
      REPLACE ALL OCCURRENCES OF 'BUYER_ID' IN lv_where WITH 's~BUYER_ID'.
      lv_orderby = orderby_of( io_ctx ).
      REPLACE ALL OCCURRENCES OF 'ORDER_ID' IN lv_orderby WITH 's~ORDER_ID'.
      REPLACE ALL OCCURRENCES OF 'BUYER_ID' IN lv_orderby WITH 's~BUYER_ID'.
    ENDIF.
    lv_where = add_where( iv_where = lv_where
                          iv_add   = iv_add ).
    IF lv_orderby IS INITIAL.
      lv_orderby = 's~ORDER_ID'.
    ENDIF.

    IF io_ctx IS BOUND.
      IF io_ctx->has_count( ) = abap_true.
        SELECT COUNT( * ) INTO (lv_count) FROM zosd_h5x_so AS s WHERE (lv_where).
        es_response_context-count = lv_count.
        RETURN.
      ENDIF.
    ENDIF.

    SELECT s~order_id s~buyer_id INTO (ls_entity-order_id, ls_entity-buyer_id)
      FROM zosd_h5x_so AS s
      WHERE (lv_where)
      ORDER BY (lv_orderby).
      APPEND ls_entity TO lt_entityset.
    ENDSELECT.

    copy_data_to_ref( EXPORTING is_data = lt_entityset
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD item_set.
* the join of item and order, s~ and i~ in one condition and one order;
* the default order is two columns separated by a blank
    DATA ls_entity    TYPE zcl_osd_h5x_mpc=>ts_order_item.
    DATA lt_entityset TYPE zcl_osd_h5x_mpc=>tt_order_item.
    DATA lv_where     TYPE string.
    DATA lv_orderby   TYPE string.
    DATA lv_top       TYPE i.
    DATA lv_skip      TYPE i.
    DATA lv_maxrows   TYPE i.
    DATA lv_count     TYPE i.

    IF io_ctx IS BOUND.
      lv_where = io_ctx->get_osql_where_clause_convert( ).
      REPLACE ALL OCCURRENCES OF 'ORDER_ID' IN lv_where WITH 'i~ORDER_ID'.
      REPLACE ALL OCCURRENCES OF 'ITEM_POS' IN lv_where WITH 'i~ITEM_POS'.
      REPLACE ALL OCCURRENCES OF 'NOTE' IN lv_where WITH 'i~NOTE'.
      lv_orderby = orderby_of( io_ctx ).
      REPLACE ALL OCCURRENCES OF 'ORDER_ID' IN lv_orderby WITH 'i~ORDER_ID'.
      REPLACE ALL OCCURRENCES OF 'ITEM_POS' IN lv_orderby WITH 'i~ITEM_POS'.
      REPLACE ALL OCCURRENCES OF 'NOTE' IN lv_orderby WITH 'i~NOTE'.
      lv_top  = io_ctx->get_top( ).
      lv_skip = io_ctx->get_skip( ).
    ENDIF.
    lv_where = add_where( iv_where = lv_where
                          iv_add   = iv_add ).
    IF lv_orderby IS INITIAL.
      lv_orderby = 's~ORDER_ID i~ITEM_POS'.
    ENDIF.
    IF lv_top > 0.
      lv_maxrows = lv_top + lv_skip.
    ENDIF.

    TRY.
        IF io_ctx IS BOUND.
          IF io_ctx->has_count( ) = abap_true.
            SELECT COUNT( * ) INTO (lv_count)
              FROM ( zosd_h5x_soi AS i
                     INNER JOIN zosd_h5x_so AS s ON s~order_id = i~order_id )
              WHERE (lv_where).
            es_response_context-count = lv_count.
            RETURN.
          ENDIF.
        ENDIF.

        SELECT i~order_id i~item_pos i~note
          INTO (ls_entity-order_id, ls_entity-item_pos, ls_entity-note)
          FROM ( zosd_h5x_soi AS i
                 INNER JOIN zosd_h5x_so AS s ON s~order_id = i~order_id )
          UP TO lv_maxrows ROWS
          WHERE (lv_where)
          ORDER BY (lv_orderby).
          IF sy-dbcnt > lv_skip.
            APPEND ls_entity TO lt_entityset.
          ENDIF.
        ENDSELECT.
      CATCH cx_sy_dynamic_osql_semantics cx_sy_dynamic_osql_syntax cx_sy_dynamic_osql_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = 'OrderItemSet: the dynamic statement was refused'.
    ENDTRY.

    copy_data_to_ref( EXPORTING is_data = lt_entityset
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD contact_set.
    DATA ls_entity    TYPE zcl_osd_h5x_mpc=>ts_contact.
    DATA lt_entityset TYPE zcl_osd_h5x_mpc=>tt_contact.
    DATA lv_where     TYPE string.

    lv_where = add_where( iv_where = ''
                          iv_add   = iv_add ).
    SELECT c~contact_guid c~partner_id c~name
      INTO (ls_entity-contact_guid, ls_entity-partner_id, ls_entity-name)
      FROM zosd_h5x_ct AS c
      WHERE (lv_where)
      ORDER BY c~name.
      APPEND ls_entity TO lt_entityset.
    ENDSELECT.

    copy_data_to_ref( EXPORTING is_data = lt_entityset
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD partner_single.
    SELECT b~partner_id b~name b~changed_at a~city a~country
      INTO (rs_entity-partner_id, rs_entity-name, rs_entity-changed_at,
            rs_entity-address-city, rs_entity-address-country)
      FROM ( zosd_h5x_bp AS b
             INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
      UP TO 1 ROWS
      WHERE b~partner_id = iv_partner_id.
    ENDSELECT.
    IF sy-subrc <> 0.
      not_found( |Partner { iv_partner_id }| ).
    ENDIF.
  ENDMETHOD.

  METHOD order_single.
    SELECT SINGLE order_id buyer_id FROM zosd_h5x_so
      INTO (rs_entity-order_id, rs_entity-buyer_id)
      WHERE order_id = iv_order_id.
    IF sy-subrc <> 0.
      not_found( |Order { iv_order_id }| ).
    ENDIF.
  ENDMETHOD.

  METHOD item_single.
    SELECT SINGLE order_id item_pos note FROM zosd_h5x_soi
      INTO (rs_entity-order_id, rs_entity-item_pos, rs_entity-note)
      WHERE order_id = iv_order_id AND item_pos = iv_item_pos.
    IF sy-subrc <> 0.
      not_found( |Item { iv_order_id }/{ iv_item_pos }| ).
    ENDIF.
  ENDMETHOD.

  METHOD contact_single.
    SELECT SINGLE contact_guid partner_id name FROM zosd_h5x_ct
      INTO (rs_entity-contact_guid, rs_entity-partner_id, rs_entity-name)
      WHERE contact_guid = iv_contact_guid.
    IF sy-subrc <> 0.
      not_found( 'Contact' ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
