CLASS zcl_stg_sadl_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
* The generic data provider behind a reference-data-source service: reads
* the CDS entity a SADL structure is bound to through its generated source
* class, with the request's ranges, order, paging and navigation turned
* into Open SQL. Aggregate entities ($select on a cube) are grouped.
  PUBLIC SECTION.
    INTERFACES if_sadl_gw_dpc.

    METHODS constructor
      IMPORTING
        iv_sadl_xml TYPE string.
  PRIVATE SECTION.
    DATA mo_def TYPE REF TO zcl_stg_sadl_def.

    METHODS entity_of
      IMPORTING
        iv_entity_set    TYPE string
      RETURNING
        VALUE(rs_entity) TYPE zcl_stg_cds_registry=>ty_entity
      RAISING
        /iwbep/cx_mgw_tech_exception.

    METHODS source_of
      IMPORTING
        is_entity        TYPE zcl_stg_cds_registry=>ty_entity
      RETURNING
        VALUE(ro_source) TYPE REF TO zif_stg_cds_source.

    METHODS navigation_where
      IMPORTING
        io_context      TYPE REF TO zcl_stg_request_context
      RETURNING
        VALUE(rv_where) TYPE string.

    METHODS key_where
      IMPORTING
        it_key_tab      TYPE /iwbep/t_mgw_name_value_pair
        is_set          TYPE zcl_stg_model_info=>ty_entity_set OPTIONAL
      RETURNING
        VALUE(rv_where) TYPE string.

    METHODS orderby_of
      IMPORTING
        it_orderby        TYPE /iwbep/t_mgw_tech_order
        is_set            TYPE zcl_stg_model_info=>ty_entity_set OPTIONAL
      RETURNING
        VALUE(rt_orderby) TYPE string_table.

    METHODS aggregate_fields
      IMPORTING
        is_entity  TYPE zcl_stg_cds_registry=>ty_entity
        iv_select  TYPE string
      EXPORTING
        et_fields  TYPE string_table
        et_groupby TYPE string_table.

* aggregated rows have no key of their own; the Gateway gives them one, so
* the client can tell them apart (the UI5 model keeps entries by their uri)
* a virtual element is not a column: SADL refuses to filter or sort by it
    METHODS reject_virtual
      IMPORTING
        is_entity  TYPE zcl_stg_cds_registry=>ty_entity
        iv_where   TYPE string
        it_orderby TYPE string_table
      RAISING
        /iwbep/cx_mgw_busi_exception.

* the virtual elements of the entity: an ABAP class fills them after the read
    METHODS calculate_virtual
      IMPORTING
        is_entity TYPE zcl_stg_cds_registry=>ty_entity
      CHANGING
        ct_data   TYPE STANDARD TABLE
      RAISING
        /iwbep/cx_mgw_tech_exception.

    METHODS synthetic_keys
      IMPORTING
        is_entity  TYPE zcl_stg_cds_registry=>ty_entity
        it_groupby TYPE string_table
      CHANGING
        ct_data    TYPE STANDARD TABLE.

* a create without its keys is refused before the database sees it
    METHODS check_keys
      IMPORTING
        is_entity TYPE zcl_stg_cds_registry=>ty_entity
        is_row    TYPE any
      RAISING
        /iwbep/cx_mgw_busi_exception.

* the behavior that writes the entity instead of this class (a managed RAP
* BDEF, zif_stg_sadl_behavior), or nothing
    METHODS behavior_of
      IMPORTING
        is_entity          TYPE zcl_stg_cds_registry=>ty_entity
      RETURNING
        VALUE(ri_behavior) TYPE REF TO zif_stg_sadl_behavior.

* the fields the request body gave, upper case
    METHODS payload_fields
      IMPORTING
        io_data_provider TYPE REF TO /iwbep/if_mgw_entry_provider
        is_entity        TYPE zcl_stg_cds_registry=>ty_entity
      RETURNING
        VALUE(rt_fields) TYPE string_table.

* PUT replaces the entity, PATCH and MERGE lay values over it
    METHODS replaces
      IMPORTING
        io_data_provider  TYPE REF TO /iwbep/if_mgw_entry_provider
      RETURNING
        VALUE(rv_replace) TYPE abap_bool.

* the row as the view reads it, found by the keys in CS_ROW
    METHODS read_row
      IMPORTING
        is_entity TYPE zcl_stg_cds_registry=>ty_entity
      CHANGING
        cs_row    TYPE any
      RAISING
        /iwbep/cx_mgw_tech_exception.

    METHODS sql_literal
      IMPORTING
        iv_value          TYPE string
      RETURNING
        VALUE(rv_literal) TYPE string.

    METHODS and_where
      IMPORTING
        iv_left         TYPE string
        iv_right        TYPE string
      RETURNING
        VALUE(rv_where) TYPE string.
ENDCLASS.

CLASS zcl_stg_sadl_dpc IMPLEMENTATION.

  METHOD constructor.
    super->constructor( ).
    CREATE OBJECT mo_def
      EXPORTING
        iv_sadl_xml = iv_sadl_xml.
  ENDMETHOD.

  METHOD entity_of.
    DATA ls_structure TYPE zcl_stg_sadl_def=>ty_structure.

    ls_structure = mo_def->structure_by_set( iv_entity_set ).
    IF ls_structure-name IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
        EXPORTING
          method = |SADL structure for entity set { iv_entity_set }|.
    ENDIF.
    rs_entity = zcl_stg_cds_registry=>get( mo_def->binding_of( ls_structure-data_source ) ).
    IF rs_entity-name IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
        EXPORTING
          method = |CDS entity { ls_structure-data_source }|.
    ENDIF.
  ENDMETHOD.

  METHOD source_of.
    DATA lv_class TYPE string.

    lv_class = is_entity-source_class.
    CREATE OBJECT ro_source TYPE (lv_class).
  ENDMETHOD.

  METHOD sql_literal.
    DATA lv_quote TYPE string.
    DATA lv_two   TYPE string.

    lv_quote   = |'|.
    lv_two     = ''''''.
    rv_literal = iv_value.
    REPLACE ALL OCCURRENCES OF lv_quote IN rv_literal WITH lv_two.
    rv_literal = |'{ rv_literal }'|.
  ENDMETHOD.

  METHOD and_where.
    IF iv_left IS INITIAL.
      rv_where = iv_right.
    ELSEIF iv_right IS INITIAL.
      rv_where = iv_left.
    ELSE.
      rv_where = |( { iv_left } ) AND ( { iv_right } )|.
    ENDIF.
  ENDMETHOD.

  METHOD key_where.
* the key names are OData properties; a DDIC-mapped entity's columns are
* the ABAP field names behind them (NodeUuid -> NODE_UUID), a CDS
* projection's are the property names themselves
    DATA ls_key      TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    DATA lv_field    TYPE string.

    LOOP AT it_key_tab INTO ls_key.
      lv_field = to_upper( ls_key-name ).
      READ TABLE is_set-properties INTO ls_property WITH KEY name = ls_key-name.
      IF sy-subrc = 0 AND ls_property-fieldname IS NOT INITIAL.
        lv_field = ls_property-fieldname.
      ENDIF.
      rv_where = and_where( iv_left  = rv_where
                            iv_right = |{ lv_field } = { sql_literal( ls_key-value ) }| ).
    ENDLOOP.
  ENDMETHOD.

  METHOD navigation_where.
* Set(key)/nav: the source structure's association tells which target
* fields equal which source keys
    DATA ls_path      TYPE /iwbep/s_mgw_navigation_path.
    DATA ls_source    TYPE zcl_stg_sadl_def=>ty_structure.
    DATA ls_assoc     TYPE zcl_stg_sadl_def=>ty_association.
    DATA ls_entity    TYPE zcl_stg_cds_registry=>ty_entity.
    DATA ls_cds_assoc TYPE zcl_stg_cds_registry=>ty_assoc.
    DATA ls_pair      TYPE zcl_stg_cds_registry=>ty_pair.
    DATA ls_key       TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_source_set TYPE string.
    DATA lv_binding    TYPE string.

    READ TABLE io_context->mt_navigation_path INTO ls_path INDEX 1.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lv_source_set = io_context->mv_source_entity_set.
    ls_source = mo_def->structure_by_set( lv_source_set ).
    IF ls_source-name IS INITIAL.
      RETURN.
    ENDIF.
    READ TABLE ls_source-associations INTO ls_assoc WITH KEY name = ls_path-nav_prop.
    IF sy-subrc = 0.
      lv_binding = to_upper( ls_assoc-binding ).
    ELSE.
* A hand-written reference-data-source MPC writes the binding into the
* definition (<sadl:association binding="_BOOKINGS">); a SEGW-generated one
* does not - the tree has no place for it, and SEGW resolves it against the
* CDS entity when it generates. Here the name is the resolution: a published
* view calls the navigation of the alias _Bookings to_Bookings (measured on a
* system, docs/cds-publish.md), so the alias is the property without its to_.
      lv_binding = to_upper( ls_path-nav_prop ).
      IF lv_binding CP 'TO_*'.
        lv_binding = |_{ lv_binding+3 }|.
      ELSE.
        RETURN.
      ENDIF.
    ENDIF.
    ls_entity = zcl_stg_cds_registry=>get( mo_def->binding_of( ls_source-data_source ) ).
    LOOP AT ls_entity-associations INTO ls_cds_assoc.
      IF to_upper( ls_cds_assoc-name ) = lv_binding.
        EXIT.
      ENDIF.
      CLEAR ls_cds_assoc.
    ENDLOOP.
    LOOP AT ls_cds_assoc-pairs INTO ls_pair.
      LOOP AT ls_path-key_tab INTO ls_key.
        IF to_upper( ls_key-name ) = ls_pair-source.
          rv_where = and_where( iv_left  = rv_where
                                iv_right = |{ ls_pair-target } = { sql_literal( ls_key-value ) }| ).
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD orderby_of.
* $orderby names properties; a DDIC-mapped set sorts by the field behind
* the property (StgSeq -> STG_SEQ), as key_where and the $filter do
    DATA ls_order    TYPE /iwbep/s_mgw_tech_order.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    DATA lv_field    TYPE string.
    DATA lv_line     TYPE string.

    LOOP AT it_orderby INTO ls_order.
      lv_field = to_upper( ls_order-property ).
      READ TABLE is_set-properties INTO ls_property WITH KEY name = ls_order-property.
      IF sy-subrc = 0 AND ls_property-fieldname IS NOT INITIAL.
        lv_field = ls_property-fieldname.
      ENDIF.
      IF to_lower( ls_order-order ) = 'desc'.
        lv_line = |{ lv_field } DESCENDING|.
      ELSE.
        lv_line = |{ lv_field } ASCENDING|.
      ENDIF.
      APPEND lv_line TO rt_orderby.
    ENDLOOP.
  ENDMETHOD.

  METHOD aggregate_fields.
* $select on an aggregate entity: dimensions group, measures sum
    DATA lt_selected TYPE string_table.
    DATA lv_name     TYPE string.
    DATA ls_field    TYPE zcl_stg_cds_registry=>ty_field.
    DATA lv_function TYPE string.
    DATA lv_line     TYPE string.

    CLEAR et_fields.
    CLEAR et_groupby.
    SPLIT iv_select AT ',' INTO TABLE lt_selected.
    LOOP AT lt_selected INTO lv_name.
      CONDENSE lv_name.
      READ TABLE is_entity-fields INTO ls_field WITH KEY name = lv_name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      CLEAR lv_function.
      FIND REGEX '@Aggregation\.default:\s*#(\w+)' IN TABLE ls_field-annotations IGNORING CASE SUBMATCHES lv_function.
      lv_function = to_upper( lv_function ).
* column names lower case: the runtime maps result columns to the
* structure's components by exact name
      IF lv_function IS INITIAL OR lv_function = 'NONE'.
        lv_line = to_lower( ls_field-name ).
        APPEND lv_line TO et_fields.
        APPEND lv_line TO et_groupby.
      ELSE.
        lv_line = |{ lv_function }( { to_lower( ls_field-name ) } ) AS { to_lower( ls_field-name ) }|.
        APPEND lv_line TO et_fields.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD synthetic_keys.
    CONSTANTS lc_alphabet TYPE string VALUE ` ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghijklmnopqrstuvwxyz_-./:,;|=+*#()[]{}!?@&%$'"`.
    DATA ls_field  TYPE zcl_stg_cds_registry=>ty_field.
    DATA lv_name   TYPE string.
    DATA lv_text   TYPE string.
    DATA lv_hash   TYPE p LENGTH 8 DECIMALS 0.
    DATA lv_offset TYPE i.
    DATA lv_index  TYPE i.
    DATA lv_char   TYPE c LENGTH 1.
    DATA lv_key    TYPE string.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    LOOP AT ct_data ASSIGNING <ls_row>.
      CLEAR lv_text.
      LOOP AT it_groupby INTO lv_name.
        ASSIGN COMPONENT to_upper( lv_name ) OF STRUCTURE <ls_row> TO <lv_value>.
        IF sy-subrc = 0.
          lv_text = |{ lv_text }{ lv_name }={ <lv_value> }\||.
        ENDIF.
      ENDLOOP.
* a small polynomial hash over the dimension values, digits only so it
* fits numeric as well as character keys
      lv_hash = 7.
      lv_index = 0.
      WHILE lv_index < strlen( lv_text ).
        lv_char = lv_text+lv_index(1).
        FIND lv_char IN lc_alphabet MATCH OFFSET lv_offset.
        IF sy-subrc <> 0.
          lv_offset = 1.
        ENDIF.
        lv_hash = ( lv_hash * 97 + lv_offset + 1 ) MOD 999999937.
        lv_index = lv_index + 1.
      ENDWHILE.
      lv_key = |{ lv_hash }|.
      CONDENSE lv_key NO-GAPS.
      LOOP AT is_entity-fields INTO ls_field WHERE is_key = abap_true.
        ASSIGN COMPONENT to_upper( ls_field-name ) OF STRUCTURE <ls_row> TO <lv_value>.
        IF sy-subrc = 0.
          <lv_value> = lv_key.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD reject_virtual.
    DATA ls_field TYPE zcl_stg_cds_registry=>ty_field.
    DATA lv_order TYPE string.
    DATA lv_all   TYPE string.

    LOOP AT it_orderby INTO lv_order.
      lv_all = |{ lv_all } { lv_order }|.
    ENDLOOP.
    lv_all = to_upper( |{ lv_all } { iv_where }| ).

    LOOP AT is_entity-fields INTO ls_field WHERE virtual = abap_true.
      FIND REGEX |\\b{ to_upper( ls_field-name ) }\\b| IN lv_all.
      IF sy-subrc = 0.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            message = |{ ls_field-name } is a virtual element: it is calculated after the read, so it cannot be filtered or sorted|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD calculate_virtual.
* @ObjectModel.virtualElement: the value is not in the database, an exit class
* computes it from the row that was read (if_sadl_exit_calc_element_read).
* One call per class, with every virtual element it owns.
    DATA ls_field   TYPE zcl_stg_cds_registry=>ty_field.
    DATA lt_classes TYPE string_table.
    DATA lv_class   TYPE string.
    DATA lo_exit    TYPE REF TO if_sadl_exit_calc_element_read.
    DATA lt_calc    TYPE if_sadl_exit=>ty_t_element_info.
    DATA ls_calc    TYPE if_sadl_exit=>ty_s_element_info.
    DATA lx_root    TYPE REF TO cx_root.

    LOOP AT is_entity-fields INTO ls_field WHERE virtual = abap_true.
      READ TABLE lt_classes TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-calculated_by.
      IF sy-subrc <> 0.
        APPEND ls_field-calculated_by TO lt_classes.
      ENDIF.
    ENDLOOP.
    IF lt_classes IS INITIAL OR ct_data IS INITIAL.
      RETURN.
    ENDIF.

    LOOP AT lt_classes INTO lv_class.
      CLEAR lt_calc.
      LOOP AT is_entity-fields INTO ls_field WHERE virtual = abap_true AND calculated_by = lv_class.
        ls_calc-name = ls_field-name.
        APPEND ls_calc TO lt_calc.
      ENDLOOP.
      TRY.
          CREATE OBJECT lo_exit TYPE (lv_class).
          lo_exit->calculate(
            EXPORTING
              it_original_data           = ct_data
              it_requested_calc_elements = lt_calc
            CHANGING
              ct_calculated_data         = ct_data ).
        CATCH cx_root INTO lx_root.
          RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
            EXPORTING
              textid   = /iwbep/cx_mgw_tech_exception=>internal_error
              previous = lx_root.
      ENDTRY.
    ENDLOOP.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_entityset.
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA ls_entity   TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source   TYPE REF TO zif_stg_cds_source.
    DATA lv_where    TYPE string.
    DATA lt_orderby  TYPE string_table.
    DATA lt_fields   TYPE string_table.
    DATA lt_groupby  TYPE string_table.
    DATA lr_data     TYPE REF TO data.
    DATA lv_skip     TYPE i.
    DATA lv_top      TYPE i.
    DATA lv_index    TYPE i.
    DATA lv_select   TYPE string.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.

    lo_context ?= io_tech_request_context.
    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).

    lv_where = io_tech_request_context->get_osql_where_clause( ).
    lv_where = and_where( iv_left  = lv_where
                          iv_right = navigation_where( lo_context ) ).
    lt_orderby = orderby_of( it_orderby = io_tech_request_context->get_orderby( )
                             is_set     = lo_context->ms_set ).

    lv_select = lo_context->mv_select.
    IF lv_select IS NOT INITIAL AND lo_context->mv_aggregate = abap_true.
      aggregate_fields( EXPORTING is_entity  = ls_entity
                                  iv_select  = lv_select
                        IMPORTING et_fields  = lt_fields
                                  et_groupby = lt_groupby ).
    ENDIF.

    reject_virtual( is_entity  = ls_entity
                    iv_where   = lv_where
                    it_orderby = lt_orderby ).

    lr_data = lo_source->read( iv_where   = lv_where
                               it_orderby = lt_orderby
                               it_fields  = lt_fields
                               it_groupby = lt_groupby ).
    ASSIGN lr_data->* TO <lt_data>.
    IF lt_fields IS NOT INITIAL.
      synthetic_keys( EXPORTING is_entity  = ls_entity
                                it_groupby = lt_groupby
                      CHANGING  ct_data    = <lt_data> ).
    ENDIF.
    calculate_virtual( EXPORTING is_entity = ls_entity
                       CHANGING  ct_data   = <lt_data> ).

* $inlinecount counts before the page is cut
    IF lo_context->mv_inlinecount = abap_true.
      es_response_context-inlinecount = |{ lines( <lt_data> ) }|.
      CONDENSE es_response_context-inlinecount NO-GAPS.
    ENDIF.

* paging after the read, the way SADL's own DPC does it without HANA
    lv_skip = io_tech_request_context->get_skip( ).
    lv_top  = io_tech_request_context->get_top( ).
    IF lo_context->mv_count = abap_false.
      IF lv_skip > 0.
        DO lv_skip TIMES.
          DELETE <lt_data> INDEX 1.
        ENDDO.
      ENDIF.
      IF lv_top > 0.
        lv_index = lv_top + 1.
        WHILE lines( <lt_data> ) >= lv_index.
          DELETE <lt_data> INDEX lv_index.
        ENDWHILE.
      ENDIF.
    ENDIF.

    et_data = <lt_data>.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_entity.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA ls_entity  TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source  TYPE REF TO zif_stg_cds_source.
    DATA lv_where   TYPE string.
    DATA lt_orderby TYPE string_table.
    DATA lr_data    TYPE REF TO data.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    lo_context ?= io_tech_request_context.
    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).

* through a navigation the association pairs identify the target; the key
* tab then still holds the source keys and must not be applied
    IF lo_context->mt_navigation_path IS NOT INITIAL.
      lv_where = navigation_where( lo_context ).
    ELSE.
      lv_where = key_where( it_key_tab = lo_context->mt_key_tab
                            is_set     = lo_context->ms_set ).
    ENDIF.

    lr_data = lo_source->read( iv_where   = lv_where
                               it_orderby = lt_orderby ).
    ASSIGN lr_data->* TO <lt_data>.
    calculate_virtual( EXPORTING is_entity = ls_entity
                       CHANGING  ct_data   = <lt_data> ).
    READ TABLE <lt_data> INDEX 1 ASSIGNING <ls_row>.
    IF sy-subrc = 0.
      es_data = <ls_row>.
    ELSE.
      CLEAR es_data.
    ENDIF.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_expanded_entityset.
    DATA lr_data TYPE REF TO data.
    DATA ls_entity TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source TYPE REF TO zif_stg_cds_source.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.

* plain read; the framework expands the navigation properties generically
    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).
    lr_data = lo_source->read( iv_where   = ''
                               it_orderby = et_expanded_tech_clauses ).
    ASSIGN lr_data->* TO <lt_data>.
    CLEAR <lt_data>.
    if_sadl_gw_dpc~get_entityset( EXPORTING io_tech_request_context = io_tech_request_context
                                  IMPORTING et_data                 = <lt_data>
                                            es_response_context     = es_response_context ).
    er_entityset = lr_data.
    CLEAR et_expanded_tech_clauses.
    ev_entity_mapped_by_sadl = abap_true.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_expanded_entity.
    DATA lr_line   TYPE REF TO data.
    DATA ls_entity TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source TYPE REF TO zif_stg_cds_source.
    FIELD-SYMBOLS <ls_row> TYPE any.

    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).
    lr_line = lo_source->create_line( ).
    ASSIGN lr_line->* TO <ls_row>.
    if_sadl_gw_dpc~get_entity( EXPORTING io_tech_request_context = io_tech_request_context
                               IMPORTING es_data                 = <ls_row> ).
    IF <ls_row> IS NOT INITIAL.
      er_entity = lr_line.
    ENDIF.
    CLEAR et_expanded_tech_clauses.
    ev_entity_mapped_by_sadl = abap_true.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~create_entity.
* generic create over a DDIC table: the payload becomes a row, the client
* from sy-mandt, the keys must be in the payload
    DATA ls_entity TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source TYPE REF TO zif_stg_cds_source.
    DATA lr_line   TYPE REF TO data.
    DATA lv_subrc  TYPE sy-subrc.
    DATA li_behavior TYPE REF TO zif_stg_sadl_behavior.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_mandt> TYPE any.

    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).
    lr_line = lo_source->create_line( ).
    ASSIGN lr_line->* TO <ls_row>.
    io_data_provider->read_entry_data( IMPORTING es_data = <ls_row> ).
    ASSIGN COMPONENT 'MANDT' OF STRUCTURE <ls_row> TO <lv_mandt>.
    IF sy-subrc = 0.
      <lv_mandt> = sy-mandt.
    ENDIF.
* an entity with a behavior is created by it, keys and all
    li_behavior = behavior_of( ls_entity ).
    IF li_behavior IS BOUND.
      li_behavior->create( EXPORTING iv_entity = ls_entity-name
                                     it_fields = payload_fields( io_data_provider = io_data_provider
                                                                 is_entity        = ls_entity )
                           CHANGING  cs_row    = <ls_row> ).
      read_row( EXPORTING is_entity = ls_entity
                CHANGING  cs_row    = <ls_row> ).
      es_data = <ls_row>.
      RETURN.
    ENDIF.
    check_keys( EXPORTING is_entity = ls_entity
                          is_row    = <ls_row> ).
    lv_subrc = lo_source->insert( <ls_row> ).
    IF lv_subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |{ io_tech_request_context->get_entity_set_name( ) }: an entity with these keys exists|.
    ENDIF.
    es_data = <ls_row>.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~update_entity.
* generic update: the keys of the request, the payload over the stored row
    DATA ls_entity TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source TYPE REF TO zif_stg_cds_source.
    DATA lr_line   TYPE REF TO data.
    DATA lv_subrc  TYPE sy-subrc.
    DATA lo_read   TYPE REF TO /iwbep/if_mgw_req_entity.
    DATA lr_keys   TYPE REF TO data.
    DATA ls_field  TYPE zcl_stg_cds_registry=>ty_field.
    DATA li_behavior TYPE REF TO zif_stg_sadl_behavior.
    DATA lr_current  TYPE REF TO data.
    FIELD-SYMBOLS <ls_current> TYPE any.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <ls_keys>  TYPE any.
    FIELD-SYMBOLS <lv_key>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).
    lr_line = lo_source->create_line( ).
    ASSIGN lr_line->* TO <ls_row>.
    lo_read ?= io_tech_request_context.
    if_sadl_gw_dpc~get_entity( EXPORTING io_tech_request_context = lo_read
                               IMPORTING es_data                 = <ls_row> ).
    IF <ls_row> IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |{ io_tech_request_context->get_entity_set_name( ) }: no entity with these keys|.
    ENDIF.
    lr_current = lo_source->create_line( ).
    ASSIGN lr_current->* TO <ls_current>.
    <ls_current> = <ls_row>.
    io_data_provider->read_entry_data( IMPORTING es_data = <ls_row> ).
* the keys come from the URL, a payload cannot move the row (the context
* clears what it fills, so the keys are read apart and copied over)
    lr_keys = lo_source->create_line( ).
    ASSIGN lr_keys->* TO <ls_keys>.
    io_tech_request_context->get_converted_keys( IMPORTING es_key_values = <ls_keys> ).
    LOOP AT ls_entity-fields INTO ls_field WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_keys> TO <lv_key>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = <lv_key>.
      ENDIF.
    ENDLOOP.
    ASSIGN COMPONENT 'MANDT' OF STRUCTURE <ls_row> TO <lv_value>.
    IF sy-subrc = 0.
      <lv_value> = sy-mandt.
    ENDIF.
    li_behavior = behavior_of( ls_entity ).
    IF li_behavior IS BOUND.
      li_behavior->update( iv_entity  = ls_entity-name
                           is_row     = <ls_row>
                           is_current = <ls_current>
                           it_fields  = payload_fields( io_data_provider = io_data_provider
                                                        is_entity        = ls_entity )
                           iv_replace = replaces( io_data_provider ) ).
      read_row( EXPORTING is_entity = ls_entity
                CHANGING  cs_row    = <ls_row> ).
      es_data = <ls_row>.
      RETURN.
    ENDIF.
    lv_subrc = lo_source->update( <ls_row> ).
    IF lv_subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |{ io_tech_request_context->get_entity_set_name( ) }: update failed|.
    ENDIF.
    es_data = <ls_row>.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~delete_entity.
    DATA li_behavior TYPE REF TO zif_stg_sadl_behavior.
    DATA ls_entity TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source TYPE REF TO zif_stg_cds_source.
    DATA lr_line   TYPE REF TO data.
    DATA lv_subrc  TYPE sy-subrc.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_mandt> TYPE any.

    ls_entity = entity_of( io_tech_request_context->get_entity_set_name( ) ).
    lo_source = source_of( ls_entity ).
    lr_line = lo_source->create_line( ).
    ASSIGN lr_line->* TO <ls_row>.
    io_tech_request_context->get_converted_keys( IMPORTING es_key_values = <ls_row> ).
    ASSIGN COMPONENT 'MANDT' OF STRUCTURE <ls_row> TO <lv_mandt>.
    IF sy-subrc = 0.
      <lv_mandt> = sy-mandt.
    ENDIF.
    li_behavior = behavior_of( ls_entity ).
    IF li_behavior IS BOUND.
      li_behavior->delete( iv_entity = ls_entity-name
                           is_row    = <ls_row> ).
      RETURN.
    ENDIF.
    lv_subrc = lo_source->delete( <ls_row> ).
    IF lv_subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
        EXPORTING
          textid  = /iwbep/cx_mgw_busi_exception=>business_error
          message = |{ io_tech_request_context->get_entity_set_name( ) }: no entity with these keys|.
    ENDIF.
  ENDMETHOD.

  METHOD check_keys.
    DATA ls_field TYPE zcl_stg_cds_registry=>ty_field.
    FIELD-SYMBOLS <lv_value> TYPE any.

    LOOP AT is_entity-fields INTO ls_field WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE is_row TO <lv_value>.
      IF sy-subrc = 0 AND <lv_value> IS INITIAL.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
          EXPORTING
            textid  = /iwbep/cx_mgw_busi_exception=>business_error
            message = |{ is_entity-name }: key { ls_field-name } is missing|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~execute_action.
* an action of the entity's behavior, exposed as a function import whose
* parameters are the keys and whose result is the entity (RAP over V2)
    DATA lo_context  TYPE REF TO zcl_stg_request_context.
    DATA ls_entity   TYPE zcl_stg_cds_registry=>ty_entity.
    DATA lo_source   TYPE REF TO zif_stg_cds_source.
    DATA li_behavior TYPE REF TO zif_stg_sadl_behavior.
    DATA lt_actions  TYPE string_table.
    DATA ls_param    TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_action   TYPE string.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    lo_context ?= io_tech_request_context.
    lv_action = to_upper( lo_context->mv_function_import ).
    IF lo_context->mv_entity_set IS NOT INITIAL AND lv_action IS NOT INITIAL.
      ls_entity = entity_of( lo_context->mv_entity_set ).
      li_behavior = behavior_of( ls_entity ).
    ENDIF.
    IF li_behavior IS BOUND.
      lt_actions = li_behavior->actions( ls_entity-name ).
      READ TABLE lt_actions TRANSPORTING NO FIELDS WITH KEY table_line = lv_action.
      IF sy-subrc <> 0.
        CLEAR li_behavior.
      ENDIF.
    ENDIF.
    IF li_behavior IS NOT BOUND.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_not_impl_exc
        EXPORTING
          textid = /iwbep/cx_mgw_not_impl_exc=>method_not_implemented
          method = 'SADL EXECUTE_ACTION'.
    ENDIF.

    lo_source = source_of( ls_entity ).
    er_data = lo_source->create_line( ).
    ASSIGN er_data->* TO <ls_row>.
* the parameters name the key properties, spelled like the view's fields
    LOOP AT lo_context->mt_parameter INTO ls_param.
      ASSIGN COMPONENT to_upper( ls_param-name ) OF STRUCTURE <ls_row> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = ls_param-value.
      ENDIF.
    ENDLOOP.
    li_behavior->execute( iv_entity = ls_entity-name
                          iv_action = lv_action
                          is_row    = <ls_row> ).
    read_row( EXPORTING is_entity = ls_entity
              CHANGING  cs_row    = <ls_row> ).
  ENDMETHOD.

  METHOD behavior_of.
    DATA lv_class TYPE string.

* by name: the RAP runtime is a package of its own
    lv_class = 'ZCL_OSD_RAP_SADL'.
    TRY.
        CREATE OBJECT ri_behavior TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RETURN.
    ENDTRY.
    IF ri_behavior->handles( is_entity-name ) = abap_false.
      CLEAR ri_behavior.
    ENDIF.
  ENDMETHOD.

  METHOD payload_fields.
    DATA lo_provider TYPE REF TO zcl_stg_entry_provider.
    DATA ls_field    TYPE zcl_stg_cds_registry=>ty_field.

    TRY.
        lo_provider ?= io_data_provider.
        rt_fields = lo_provider->fields( ).
      CATCH cx_sy_move_cast_error.
* another provider: every field counts as given
        LOOP AT is_entity-fields INTO ls_field.
          APPEND to_upper( ls_field-name ) TO rt_fields.
        ENDLOOP.
    ENDTRY.
  ENDMETHOD.

  METHOD replaces.
    DATA lo_provider TYPE REF TO zcl_stg_entry_provider.

* another provider: every field counts as given (payload_fields), which
* replaces the entity whichever this flag says
    TRY.
        lo_provider ?= io_data_provider.
        IF lo_provider->merges( ) = abap_false.
          rv_replace = abap_true.
        ENDIF.
      CATCH cx_sy_move_cast_error.
        rv_replace = abap_true.
    ENDTRY.
  ENDMETHOD.

  METHOD read_row.
    DATA lo_source  TYPE REF TO zif_stg_cds_source.
    DATA ls_field   TYPE zcl_stg_cds_registry=>ty_field.
    DATA lt_key     TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_key     TYPE /iwbep/s_mgw_name_value_pair.
    DATA lt_orderby TYPE string_table.
    DATA lr_data    TYPE REF TO data.
    FIELD-SYMBOLS <lv_value> TYPE any.
    FIELD-SYMBOLS <lt_data>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_found> TYPE any.

    LOOP AT is_entity-fields INTO ls_field WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_value>.
      IF sy-subrc = 0.
        ls_key-name  = ls_field-name.
        ls_key-value = <lv_value>.
        APPEND ls_key TO lt_key.
      ENDIF.
    ENDLOOP.
    lo_source = source_of( is_entity ).
    lr_data = lo_source->read( iv_where   = key_where( lt_key )
                               it_orderby = lt_orderby ).
    ASSIGN lr_data->* TO <lt_data>.
    calculate_virtual( EXPORTING is_entity = is_entity
                       CHANGING  ct_data   = <lt_data> ).
    READ TABLE <lt_data> INDEX 1 ASSIGNING <ls_found>.
    IF sy-subrc = 0.
      cs_row = <ls_found>.
    ENDIF.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_is_conditional_implemented.
    rv_conditional_active = abap_false.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~get_is_condi_imple_for_action.
    rv_conditional_active = abap_false.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~begin_changeset.
    RETURN.
  ENDMETHOD.

  METHOD if_sadl_gw_dpc~process_changeset.
    RETURN.
  ENDMETHOD.

ENDCLASS.
