CLASS zcl_osd_h5x_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
* The read shape of a SEGW sample's business set, synthetic and written
* fresh: the technical context's WHERE and ORDER BY in ABAP names, mapped
* by text replacement onto the aliases of a join; a SELECT ... ENDSELECT
* over the join with an INTO list that fills a complex component, UP TO
* top + skip rows, the first skip rows dropped by sy-dbcnt; $count and the
* inline count by SELECT COUNT( * ) over the same join.
* The value help sets read through the search help runtime the way a
* generated DPC does: the filter and the key as selection options, top +
* skip as the maximum, the first skip records dropped, the record / field
* / value rows moved into the entity by field name.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
  PRIVATE SECTION.
    CLASS-METHODS search_help_of
      IMPORTING
        iv_entity_set_name TYPE string
      RETURNING
        VALUE(rv_shlp)     TYPE string.
    METHODS value_help
      IMPORTING
        iv_entity_set_name TYPE string
        it_selopt          TYPE ddshselops
        iv_maxrows         TYPE i
        iv_skip            TYPE i
      RETURNING
        VALUE(rr_rows)     TYPE REF TO data
      RAISING
        /iwbep/cx_mgw_busi_exception.
    CLASS-METHODS to_sql
      IMPORTING
        iv_string        TYPE string
      RETURNING
        VALUE(rv_string) TYPE string.
ENDCLASS.

CLASS zcl_osd_h5x_dpc IMPLEMENTATION.
  METHOD search_help_of.
    CASE iv_entity_set_name.
      WHEN 'VH_CategorySet'.
        rv_shlp = 'ZOSD_H5X_SH_CAT'.
      WHEN 'VH_CountrySet'.
        rv_shlp = 'ZOSD_H5X_SH_CTY'.
      WHEN 'VH_UnitSet'.
        rv_shlp = 'ZOSD_H5X_SH_UN'.
    ENDCASE.
  ENDMETHOD.

  METHOD value_help.
    DATA lo_sh_data  TYPE REF TO /iwbep/if_sb_shlp_data.
    DATA lt_result   TYPE /iwbep/if_sb_gendpc_shlp_data=>tt_result_list.
    DATA ls_result   LIKE LINE OF lt_result.
    DATA ls_message  TYPE bapiret2.
    DATA lv_record   TYPE i.
    DATA lr_row      TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    CASE iv_entity_set_name.
      WHEN 'VH_CategorySet'.
        CREATE DATA rr_rows TYPE zcl_osd_h5x_mpc=>tt_vh_category.
        CREATE DATA lr_row TYPE zcl_osd_h5x_mpc=>ts_vh_category.
      WHEN 'VH_CountrySet'.
        CREATE DATA rr_rows TYPE zcl_osd_h5x_mpc=>tt_vh_country.
        CREATE DATA lr_row TYPE zcl_osd_h5x_mpc=>ts_vh_country.
      WHEN OTHERS.
        CREATE DATA rr_rows TYPE zcl_osd_h5x_mpc=>tt_vh_unit.
        CREATE DATA lr_row TYPE zcl_osd_h5x_mpc=>ts_vh_unit.
    ENDCASE.
    ASSIGN rr_rows->* TO <lt_rows>.
    ASSIGN lr_row->* TO <ls_row>.

    lo_sh_data = /iwbep/cl_sb_shlp_data_factory=>get_sh_data_obj( ).
    lo_sh_data->/iwbep/if_sb_gendpc_shlp_data~get_search_help_values(
      EXPORTING
        iv_shlp_name      = search_help_of( iv_entity_set_name )
        iv_maxrows        = iv_maxrows
        iv_sort           = abap_true
        iv_call_shlt_exit = abap_true
        it_selopt         = it_selopt
      IMPORTING
        et_return_list    = lt_result
        es_message        = ls_message ).
    IF ls_message IS NOT INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          message = ls_message-message.
    ENDIF.

    LOOP AT lt_result INTO ls_result WHERE record_number > iv_skip.
      IF ls_result-record_number <> lv_record AND lv_record > 0.
        APPEND <ls_row> TO <lt_rows>.
        CLEAR <ls_row>.
      ENDIF.
      lv_record = ls_result-record_number.
      ASSIGN COMPONENT ls_result-field_name OF STRUCTURE <ls_row> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = ls_result-field_value.
      ENDIF.
    ENDLOOP.
    IF lv_record > 0.
      APPEND <ls_row> TO <lt_rows>.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entity.
    DATA lt_selopt TYPE ddshselops.
    DATA ls_selopt LIKE LINE OF lt_selopt.
    DATA ls_key    LIKE LINE OF it_key_tab.
    DATA lr_rows   TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    IF search_help_of( iv_entity_set_name ) IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT it_key_tab INTO ls_key.
      ls_selopt-shlpname  = search_help_of( iv_entity_set_name ).
      ls_selopt-shlpfield = to_upper( ls_key-name ).
      ls_selopt-sign      = 'I'.
      ls_selopt-option    = 'EQ'.
      ls_selopt-low       = ls_key-value.
      APPEND ls_selopt TO lt_selopt.
    ENDLOOP.
    lr_rows = value_help( iv_entity_set_name = iv_entity_set_name
                          it_selopt          = lt_selopt
                          iv_maxrows         = 1
                          iv_skip            = 0 ).
    ASSIGN lr_rows->* TO <lt_rows>.
    READ TABLE <lt_rows> INDEX 1 ASSIGNING <ls_row>.
    IF sy-subrc = 0.
      copy_data_to_ref( EXPORTING is_data = <ls_row>
                        CHANGING  cr_data = er_entity ).
    ENDIF.
  ENDMETHOD.
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
    DATA lt_filter    TYPE /iwbep/t_mgw_select_option.
    DATA ls_filter    LIKE LINE OF lt_filter.
    DATA ls_range     TYPE /iwbep/s_cod_select_option.
    DATA lt_selopt    TYPE ddshselops.
    DATA ls_selopt    LIKE LINE OF lt_selopt.
    DATA lr_rows      TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.

    IF search_help_of( iv_entity_set_name ) IS NOT INITIAL.
      lt_filter = io_tech_request_context->get_filter( )->get_filter_select_options( ).
      LOOP AT lt_filter INTO ls_filter.
        LOOP AT ls_filter-select_options INTO ls_range.
          ls_selopt-shlpname  = search_help_of( iv_entity_set_name ).
          ls_selopt-shlpfield = to_upper( ls_filter-property ).
          ls_selopt-sign      = ls_range-sign.
          ls_selopt-option    = ls_range-option.
          ls_selopt-low       = ls_range-low.
          ls_selopt-high      = ls_range-high.
          APPEND ls_selopt TO lt_selopt.
        ENDLOOP.
      ENDLOOP.
      lv_top  = io_tech_request_context->get_top( ).
      lv_skip = io_tech_request_context->get_skip( ).
      IF lv_top > 0.
        lv_maxrows = lv_top + lv_skip.
      ENDIF.
      lr_rows = value_help( iv_entity_set_name = iv_entity_set_name
                            it_selopt          = lt_selopt
                            iv_maxrows         = lv_maxrows
                            iv_skip            = lv_skip ).
      ASSIGN lr_rows->* TO <lt_rows>.
      copy_data_to_ref( EXPORTING is_data = <lt_rows>
                        CHANGING  cr_data = er_entityset ).
      RETURN.
    ENDIF.

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
