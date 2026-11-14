CLASS zcl_osd_h5x_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
* The read shape of a SEGW sample's business set, synthetic and written
* fresh: the technical context's WHERE and ORDER BY in ABAP names, mapped
* by text replacement onto the aliases of a join; a SELECT ... ENDSELECT
* over the join with an INTO list that fills a complex component, UP TO
* top + skip rows, the first skip rows dropped by sy-dbcnt; $count and the
* inline count by SELECT COUNT( * ) over the same join.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
  PRIVATE SECTION.
    CLASS-METHODS to_sql
      IMPORTING
        iv_string        TYPE string
      RETURNING
        VALUE(rv_string) TYPE string.
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

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    DATA ls_entity    TYPE zcl_osd_h5x_mpc=>ts_partner.
    DATA lt_entityset TYPE zcl_osd_h5x_mpc=>tt_partner.
    DATA lt_orderby   TYPE /iwbep/t_mgw_tech_order.
    DATA ls_orderby   LIKE LINE OF lt_orderby.
    DATA lv_where     TYPE string.
    DATA lv_orderby   TYPE string.
    DATA lv_property  TYPE string.
    DATA lv_direction TYPE string.
    DATA lv_top       TYPE i.
    DATA lv_skip      TYPE i.
    DATA lv_maxrows   TYPE i.
    DATA lv_count     TYPE i.

* a direct read has no source set; a navigation would be resolved here
* (the sample's shape: an answered source set means "navigation")
    IF io_tech_request_context->get_source_entity_set_name( ) IS NOT INITIAL.
      RETURN.
    ENDIF.

    lv_where = to_sql( io_tech_request_context->get_osql_where_clause_convert( ) ).
    lt_orderby = io_tech_request_context->get_orderby( ).
    LOOP AT lt_orderby INTO ls_orderby.
      lv_property = ls_orderby-property.
      IF lv_property IS INITIAL.
        lv_property = ls_orderby-property_path.
      ENDIF.
      lv_direction = 'ASCENDING'.
      IF ls_orderby-order = 'desc'.
        lv_direction = 'DESCENDING'.
      ENDIF.
      lv_orderby = |{ lv_orderby } { lv_property } { lv_direction }|.
    ENDLOOP.
    lv_orderby = to_sql( lv_orderby ).
    CONDENSE lv_orderby.
    IF lv_orderby IS INITIAL.
      lv_orderby = 'b~PARTNER_ID'.
    ENDIF.

    lv_top  = io_tech_request_context->get_top( ).
    lv_skip = io_tech_request_context->get_skip( ).
    IF lv_top > 0.
      lv_maxrows = lv_top + lv_skip.
    ENDIF.

    IF io_tech_request_context->has_count( ) = abap_true.
      SELECT COUNT( * ) INTO (lv_count)
        FROM ( zosd_h5x_bp AS b
               INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
        WHERE (lv_where).
      es_response_context-count = lv_count.
      RETURN.
    ENDIF.

    IF io_tech_request_context->has_inlinecount( ) = abap_true.
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
ENDCLASS.
