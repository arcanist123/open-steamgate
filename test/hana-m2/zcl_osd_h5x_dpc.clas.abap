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
*
* Milestone 3 (B3), the wire form:
* - the partner set refuses a condition on CHANGED_AT itself, with a
*   business exception carrying a T100 key whose attr1 is a text, not an
*   attribute name (the sample's way of raising "filter not supported" and
*   "key '&1' does not exist"); an unknown partner is the same, 002;
* - an OR across two properties is read from get_osql_where_clause_convert
*   like every other filter: there is no select-option form of it;
* - an order's note is read in sy-langu, the session language, and its
*   language key is handed over as stored (E): the exit is the framework's.
* The value help sets read through the search help runtime the way a
* generated DPC does: the filter and the key as selection options, top +
* skip as the maximum, the first skip records dropped, the record / field
* / value rows moved into the entity by field name.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
  PRIVATE SECTION.
    CONSTANTS c_partner TYPE string VALUE 'Partner'.
    CONSTANTS c_order   TYPE string VALUE 'Order'.
    CONSTANTS c_item    TYPE string VALUE 'OrderItem'.
    CONSTANTS c_contact TYPE string VALUE 'Contact'.

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
    METHODS vh_set
      IMPORTING
        iv_entity_set_name TYPE string
        io_ctx             TYPE REF TO /iwbep/if_mgw_req_entityset
      EXPORTING
        er_entityset       TYPE REF TO data
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.
    METHODS vh_single
      IMPORTING
        iv_entity_set_name TYPE string
        it_key_tab         TYPE /iwbep/t_mgw_name_value_pair
      EXPORTING
        er_entity          TYPE REF TO data
      RAISING
        /iwbep/cx_mgw_busi_exception.
    CLASS-METHODS to_sql
      IMPORTING
        iv_string        TYPE string
      RETURNING
        VALUE(rv_string) TYPE string.
* a field name of the condition onto the join's alias, outside the quoted
* literals only: Name eq 'ADDRESS-CITY' is a value, not the column. The
* SEGW sample replaces over the whole text; the twin does not copy that
* (a DPC written from it would inherit it)
    CLASS-METHODS map_field
      IMPORTING
        iv_string        TYPE string
        iv_from          TYPE string
        iv_to            TYPE string
      RETURNING
        VALUE(rv_string) TYPE string.
    CLASS-METHODS outside_literals
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
    CLASS-METHODS order_note
      CHANGING
        cs_order TYPE zcl_osd_h5x_mpc=>ts_order.
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
* the dictionary-bound item type (milestone 3 B4) served with constant
* rows: quantities in units of different display decimals (B3)
    METHODS stock_items
      EXPORTING
        er_entityset TYPE REF TO data.
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
  METHOD vh_set.
    DATA lv_top     TYPE i.
    DATA lv_skip    TYPE i.
    DATA lv_maxrows TYPE i.
    DATA lt_filter  TYPE /iwbep/t_mgw_select_option.
    DATA ls_filter  LIKE LINE OF lt_filter.
    DATA ls_range   TYPE /iwbep/s_cod_select_option.
    DATA lt_selopt  TYPE ddshselops.
    DATA ls_selopt  LIKE LINE OF lt_selopt.
    DATA lr_rows    TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.

    lt_filter = io_ctx->get_filter( )->get_filter_select_options( ).
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
    lv_top  = io_ctx->get_top( ).
    lv_skip = io_ctx->get_skip( ).
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
  ENDMETHOD.
  METHOD vh_single.
    DATA lt_selopt TYPE ddshselops.
    DATA ls_selopt LIKE LINE OF lt_selopt.
    DATA ls_key    LIKE LINE OF it_key_tab.
    DATA lr_rows   TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

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
    rv_string = map_field( iv_string = rv_string iv_from = 'PARTNER_ID' iv_to = 'b~PARTNER_ID' ).
    rv_string = map_field( iv_string = rv_string iv_from = 'NAME' iv_to = 'b~NAME' ).
    rv_string = map_field( iv_string = rv_string iv_from = 'CHANGED_AT' iv_to = 'b~CHANGED_AT' ).
    rv_string = map_field( iv_string = rv_string iv_from = 'ADDRESS-CITY' iv_to = 'a~CITY' ).
    rv_string = map_field( iv_string = rv_string iv_from = 'ADDRESS-COUNTRY' iv_to = 'a~COUNTRY' ).
  ENDMETHOD.

  METHOD map_field.
* walk the text: a quote toggles "inside a literal" (a doubled quote toggles
* twice); the name is replaced in each stretch outside one
    DATA lv_len     TYPE i.
    DATA lv_off     TYPE i.
    DATA lv_char    TYPE string.
    DATA lv_outside TYPE string.
    DATA lv_inside  TYPE abap_bool.

    lv_len = strlen( iv_string ).
    WHILE lv_off < lv_len.
      lv_char = substring( val = iv_string off = lv_off len = 1 ).
      IF lv_char = |'|.
        IF lv_inside = abap_false.
          REPLACE ALL OCCURRENCES OF iv_from IN lv_outside WITH iv_to.
          rv_string = rv_string && lv_outside.
          CLEAR lv_outside.
          lv_inside = abap_true.
        ELSE.
          lv_inside = abap_false.
        ENDIF.
        rv_string = rv_string && lv_char.
      ELSEIF lv_inside = abap_true.
        rv_string = rv_string && lv_char.
      ELSE.
        lv_outside = lv_outside && lv_char.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
    REPLACE ALL OCCURRENCES OF iv_from IN lv_outside WITH iv_to.
    rv_string = rv_string && lv_outside.
  ENDMETHOD.

  METHOD outside_literals.
    DATA lv_len    TYPE i.
    DATA lv_off    TYPE i.
    DATA lv_char   TYPE string.
    DATA lv_inside TYPE abap_bool.

    lv_len = strlen( iv_string ).
    WHILE lv_off < lv_len.
      lv_char = substring( val = iv_string off = lv_off len = 1 ).
      IF lv_char = |'|.
        lv_inside = boolc( lv_inside = abap_false ).
        rv_string = rv_string && ` `.
      ELSEIF lv_inside = abap_false.
        rv_string = rv_string && lv_char.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
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

  METHOD order_note.
    SELECT SINGLE note spras FROM zosd_h5x_sot
      INTO (cs_order-note, cs_order-note_langu)
      WHERE order_id = cs_order-order_id AND spras = sy-langu.
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

    IF search_help_of( iv_entity_set_name ) IS NOT INITIAL.
      vh_set( EXPORTING iv_entity_set_name = iv_entity_set_name
                        io_ctx             = io_tech_request_context
              IMPORTING er_entityset       = er_entityset ).
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
      WHEN 'Item'.
        stock_items( IMPORTING er_entityset = er_entityset ).
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

    IF search_help_of( iv_entity_set_name ) IS NOT INITIAL.
      vh_single( EXPORTING iv_entity_set_name = iv_entity_set_name
                           it_key_tab         = it_key_tab
                 IMPORTING er_entity          = er_entity ).
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
    DATA ls_t100      TYPE scx_t100key.

    lv_where = to_sql( io_ctx->get_osql_where_clause_convert( ) ).
    IF outside_literals( lv_where ) CS 'CHANGED_AT'.
      ls_t100-msgid = 'ZOSD_H5X'.
      ls_t100-msgno = '001'.
      ls_t100-attr1 = 'CHANGED_AT'.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid = ls_t100.
    ENDIF.
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
    FIELD-SYMBOLS <ls_order> TYPE zcl_osd_h5x_mpc=>ts_order.

    IF io_ctx IS BOUND.
      lv_where = io_ctx->get_osql_where_clause_convert( ).
      lv_where = map_field( iv_string = lv_where iv_from = 'ORDER_ID' iv_to = 's~ORDER_ID' ).
      lv_where = map_field( iv_string = lv_where iv_from = 'BUYER_ID' iv_to = 's~BUYER_ID' ).
      lv_orderby = orderby_of( io_ctx ).
      lv_orderby = map_field( iv_string = lv_orderby iv_from = 'ORDER_ID' iv_to = 's~ORDER_ID' ).
      lv_orderby = map_field( iv_string = lv_orderby iv_from = 'BUYER_ID' iv_to = 's~BUYER_ID' ).
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
    LOOP AT lt_entityset ASSIGNING <ls_order>.
      order_note( CHANGING cs_order = <ls_order> ).
    ENDLOOP.

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
      lv_where = map_field( iv_string = lv_where iv_from = 'ORDER_ID' iv_to = 'i~ORDER_ID' ).
      lv_where = map_field( iv_string = lv_where iv_from = 'ITEM_POS' iv_to = 'i~ITEM_POS' ).
      lv_where = map_field( iv_string = lv_where iv_from = 'NOTE' iv_to = 'i~NOTE' ).
      lv_orderby = orderby_of( io_ctx ).
      lv_orderby = map_field( iv_string = lv_orderby iv_from = 'ORDER_ID' iv_to = 'i~ORDER_ID' ).
      lv_orderby = map_field( iv_string = lv_orderby iv_from = 'ITEM_POS' iv_to = 'i~ITEM_POS' ).
      lv_orderby = map_field( iv_string = lv_orderby iv_from = 'NOTE' iv_to = 'i~NOTE' ).
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

  METHOD stock_items.
    DATA lt_items TYPE STANDARD TABLE OF zosd_h5x_s_item WITH DEFAULT KEY.
    DATA ls_item  TYPE zosd_h5x_s_item.

    ls_item-currency = 'EUR'.
    ls_item-amount   = '12.50'.
    ls_item-item_no  = '1'.
    ls_item-quantity = '3'.
    ls_item-unit     = 'PC'.
    APPEND ls_item TO lt_items.
    ls_item-item_no  = '2'.
    ls_item-quantity = '0.65'.
    ls_item-unit     = 'MTR'.
    APPEND ls_item TO lt_items.
    ls_item-item_no  = '3'.
    ls_item-quantity = '24.8'.
    ls_item-unit     = 'CMT'.
    APPEND ls_item TO lt_items.
    ls_item-item_no  = '4'.
    ls_item-quantity = '2.5'.
    ls_item-unit     = 'ZZZ'.
    APPEND ls_item TO lt_items.
    ls_item-item_no  = '5'.
    ls_item-quantity = '1.25'.
    ls_item-unit     = 'PC'.
    APPEND ls_item TO lt_items.
    copy_data_to_ref( EXPORTING is_data = lt_items
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
    DATA ls_t100 TYPE scx_t100key.

    SELECT b~partner_id b~name b~changed_at a~city a~country
      INTO (rs_entity-partner_id, rs_entity-name, rs_entity-changed_at,
            rs_entity-address-city, rs_entity-address-country)
      FROM ( zosd_h5x_bp AS b
             INNER JOIN zosd_h5x_ad AS a ON a~node_key = b~addr_key )
      UP TO 1 ROWS
      WHERE b~partner_id = iv_partner_id.
    ENDSELECT.
    IF sy-subrc <> 0.
      ls_t100-msgid = 'ZOSD_H5X'.
      ls_t100-msgno = '002'.
      ls_t100-attr1 = iv_partner_id.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid = ls_t100.
    ENDIF.
  ENDMETHOD.

  METHOD order_single.
    SELECT SINGLE order_id buyer_id FROM zosd_h5x_so
      INTO (rs_entity-order_id, rs_entity-buyer_id)
      WHERE order_id = iv_order_id.
    IF sy-subrc <> 0.
      not_found( |Order { iv_order_id }| ).
    ENDIF.
    order_note( CHANGING cs_order = rs_entity ).
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
