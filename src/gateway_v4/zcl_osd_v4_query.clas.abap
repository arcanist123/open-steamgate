CLASS zcl_osd_v4_query DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    DATA ms_request TYPE zcl_stg_url=>ty_request.
    DATA mo_context TYPE REF TO zcl_stg_request_context.
* $expand=nav(opt;opt;...): the navigation property and the options inside
* its parentheses, read as a query of the target set when it is expanded
    TYPES: BEGIN OF ty_expand,
             name    TYPE string,
             options TYPE tihttpnvp,
           END OF ty_expand.
    TYPES ty_expands TYPE STANDARD TABLE OF ty_expand WITH DEFAULT KEY.
* $select=nav/prop: a structural property of an expanded navigation
    TYPES: BEGIN OF ty_nav_select,
             nav      TYPE string,
             property TYPE string,
           END OF ty_nav_select.
    TYPES ty_nav_selects TYPE STANDARD TABLE OF ty_nav_select WITH DEFAULT KEY.
    DATA mt_select TYPE string_table.
    DATA mt_expand TYPE ty_expands.
    DATA mt_nav_select TYPE ty_nav_selects.
    DATA mv_top TYPE i VALUE -1.
    DATA mv_skip TYPE i.
    DATA mv_count TYPE abap_bool.
* Set(key)/<navigation>: the navigation property the resource path follows
    DATA mv_navigation TYPE string.
* Set(key)/<namespace>.<action> or Set/<namespace>.<action>: a bound action
    DATA mv_action TYPE string.
* the parameters of a bound function, <namespace>.<function>(p=v,...)
    DATA mv_params TYPE string.
    METHODS constructor IMPORTING iv_path TYPE string it_options TYPE tihttpnvp
      RAISING zcx_stg_error.
    METHODS prepare IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model RAISING zcx_stg_error.
* iv_text at iv_separator, outside quotes and outside parentheses
    CLASS-METHODS split IMPORTING iv_text TYPE string iv_separator TYPE string DEFAULT ','
      RETURNING VALUE(rt_parts) TYPE string_table RAISING zcx_stg_error.
* a $search value: one term or one quoted phrase, as the DPC takes it
    CLASS-METHODS search_term IMPORTING iv_text TYPE string RETURNING VALUE(rv_term) TYPE string
      RAISING zcx_stg_error.
    CLASS-METHODS filter IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string
      RAISING zcx_stg_error.
    CLASS-METHODS fail IMPORTING iv_text TYPE string iv_status TYPE i DEFAULT 400 RAISING zcx_stg_error.
* A V4 Date or DateTimeOffset literal as the internal YYYYMMDD[hhmmss[.f]] (UTC)
    CLASS-METHODS temporal IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string RAISING zcx_stg_error.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_shape,
             property TYPE string,
             alternatives TYPE abap_bool,
           END OF ty_shape.
    TYPES ty_shapes TYPE STANDARD TABLE OF ty_shape WITH DEFAULT KEY.
    CLASS-METHODS validate_shape IMPORTING it_nodes TYPE zcl_stg_filter=>ty_nodes iv_id TYPE i
      RETURNING VALUE(rt_shape) TYPE ty_shapes RAISING zcx_stg_error.
    METHODS validate_literals IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model RAISING zcx_stg_error.
    METHODS read_options IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model RAISING zcx_stg_error.
    METHODS validate_temporal_filters IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model RAISING zcx_stg_error.
    METHODS read_keys IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model RAISING zcx_stg_error.
    METHODS select_fields IMPORTING iv_select TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      RAISING zcx_stg_error.
    CLASS-METHODS atom IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string RAISING zcx_stg_error.
    METHODS expand_items IMPORTING iv_expand TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      RAISING zcx_stg_error.
* Set() -- empty parentheses, which only an operation without parameters may carry
    DATA mv_empty_parens TYPE abap_bool.
ENDCLASS.

CLASS zcl_osd_v4_query IMPLEMENTATION.
  METHOD fail.
    RAISE EXCEPTION TYPE zcx_stg_error EXPORTING status = iv_status code = 'V4/REQUEST' message = iv_text.
  ENDMETHOD.

  METHOD constructor.
    DATA lv_rest TYPE string.
    DATA lv_tail TYPE string.
    FIND REGEX '/sap/opu/odata4/sap/([^/?]+)(.*)$' IN iv_path SUBMATCHES ms_request-service lv_rest.
    IF sy-subrc <> 0.
      fail( iv_text = 'Not a V4 service path' iv_status = 404 ).
    ENDIF.
    ms_request-options = it_options.
    IF lv_rest IS INITIAL OR lv_rest = '/'.
      ms_request-is_service_root = abap_true.
    ELSEIF lv_rest = '/$metadata'.
      ms_request-is_metadata = abap_true.
    ELSEIF lv_rest = '/$batch'.
      ms_request-is_batch = abap_true.
    ELSE.
* Set, Set(key), Set(key)/nav, Set(key)/ns.Op, Set(key)/ns.Fn(p=v), Op(p=v):
* the key predicate is the shortest that lets the rest match, so a bound
* function's own parentheses are not taken for part of the key
      FIND REGEX '^/([^/($]+)(?:\((.*?)\))?(?:/([A-Za-z_][A-Za-z0-9_.]*)(?:\((.*)\))?)?(/\$count)?/?$' IN lv_rest
        SUBMATCHES ms_request-entity_set ms_request-key_string mv_navigation mv_params lv_tail.
      IF sy-subrc <> 0.
        fail( iv_text = 'Unsupported V4 resource path' iv_status = 404 ).
      ENDIF.
      ms_request-entity_set = cl_http_utility=>unescape_url( ms_request-entity_set ).
      ms_request-key_string = cl_http_utility=>unescape_url( ms_request-key_string ).
      IF mv_navigation CS '.'.
        mv_action = mv_navigation.
        CLEAR mv_navigation.
        IF lv_tail IS NOT INITIAL.
          fail( iv_text = 'Unsupported V4 resource path' iv_status = 404 ).
        ENDIF.
      ELSEIF mv_navigation IS NOT INITIAL AND lv_rest CP |*/{ mv_navigation }(*|.
* parameters belong to an operation, not to a navigation property
        fail( iv_text = 'Unsupported V4 resource path' iv_status = 404 ).
      ENDIF.
      IF mv_navigation IS NOT INITIAL AND ms_request-key_string IS INITIAL.
        fail( iv_text = 'A navigation property needs the key of its source entity' iv_status = 404 ).
      ENDIF.
      IF lv_tail = '/$count'.
        ms_request-is_count = abap_true.
        IF ms_request-key_string IS NOT INITIAL AND mv_navigation IS INITIAL.
          fail( iv_text = '$count requires a collection' ).
        ENDIF.
      ENDIF.
      IF ms_request-key_string IS INITIAL AND lv_rest CP |/{ ms_request-entity_set }()*|.
* Op() is an operation without parameters; Set() is refused when the keys are read
        mv_empty_parens = abap_true.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD split.
    DATA lv_off TYPE i.
    DATA lv_char TYPE string.
    DATA lv_part TYPE string.
    DATA lv_in TYPE abap_bool.
    DATA lv_depth TYPE i.
    WHILE lv_off < strlen( iv_text ).
      lv_char = iv_text+lv_off(1).
      IF lv_char = |'|.
        IF lv_in = abap_true AND lv_off + 1 < strlen( iv_text ).
          IF substring( val = iv_text off = lv_off + 1 len = 1 ) = |'|.
            lv_part = lv_part && |''|.
            lv_off = lv_off + 2.
            CONTINUE.
          ENDIF.
        ENDIF.
        IF lv_in = abap_true.
          lv_in = abap_false.
        ELSE.
          lv_in = abap_true.
        ENDIF.
      ENDIF.
      IF lv_in = abap_false AND lv_char = '('.
        lv_depth = lv_depth + 1.
      ELSEIF lv_in = abap_false AND lv_char = ')'.
        lv_depth = lv_depth - 1.
        IF lv_depth < 0.
          fail( 'Unbalanced parentheses' ).
        ENDIF.
      ENDIF.
      IF lv_char = iv_separator AND lv_in = abap_false AND lv_depth = 0.
        SHIFT lv_part LEFT DELETING LEADING space.
        SHIFT lv_part RIGHT DELETING TRAILING space.
        IF lv_part IS INITIAL.
          fail( 'Empty query item' ).
        ENDIF.
        APPEND lv_part TO rt_parts.
        CLEAR lv_part.
      ELSE.
        lv_part = lv_part && lv_char.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
    IF lv_in = abap_true.
      fail( 'Unterminated string literal' ).
    ENDIF.
    IF lv_depth <> 0.
      fail( 'Unbalanced parentheses' ).
    ENDIF.
    SHIFT lv_part LEFT DELETING LEADING space.
    SHIFT lv_part RIGHT DELETING TRAILING space.
    IF lv_part IS NOT INITIAL.
      APPEND lv_part TO rt_parts.
    ELSEIF iv_text IS NOT INITIAL.
      fail( 'Empty query item' ).
    ENDIF.
  ENDMETHOD.

  METHOD temporal.
    DATA lv_year TYPE i.
    DATA lv_month TYPE i.
    DATA lv_day TYPE i.
    DATA lv_max TYPE i.
    DATA lv_date TYPE d.
    DATA lv_time TYPE t.
    DATA lv_days TYPE i.
    DATA lv_seconds TYPE i.
    DATA lv_offset TYPE i.
    DATA lv_zone TYPE string.
    DATA lv_frac TYPE string.
    DATA lv_h TYPE i.
    DATA lv_m TYPE i.
    DATA lv_s TYPE i.
    rv_text = iv_text.
    FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T.*)?$' IN iv_text.
    IF sy-subrc <> 0.
      fail( 'Invalid temporal literal' ).
    ENDIF.
    lv_year = iv_text(4).
    lv_month = iv_text+5(2).
    lv_day = iv_text+8(2).
    IF lv_year < 1 OR lv_month < 1 OR lv_month > 12 OR lv_day < 1.
      fail( 'Invalid calendar date' ).
    ENDIF.
    lv_max = 31.
    IF lv_month = 4 OR lv_month = 6 OR lv_month = 9 OR lv_month = 11.
      lv_max = 30.
    ELSEIF lv_month = 2.
      lv_max = 28.
      IF lv_year MOD 400 = 0 OR ( lv_year MOD 4 = 0 AND lv_year MOD 100 <> 0 ).
        lv_max = 29.
      ENDIF.
    ENDIF.
    IF lv_day > lv_max.
      fail( 'Invalid calendar date' ).
    ENDIF.
    IF strlen( iv_text ) = 10.
      REPLACE ALL OCCURRENCES OF '-' IN rv_text WITH ''.
      RETURN.
    ENDIF.
    FIND REGEX '^([0-9]{4}-[0-9]{2}-[0-9]{2})T([0-9]{2}:[0-9]{2}:[0-9]{2})(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$'
      IN iv_text SUBMATCHES rv_text lv_zone lv_frac.
* Extract by fixed positions after checking the complete lexical form.
    IF sy-subrc <> 0.
      fail( 'Invalid DateTimeOffset literal' ).
    ENDIF.
    rv_text = iv_text(10).
    REPLACE ALL OCCURRENCES OF '-' IN rv_text WITH ''.
    lv_date = rv_text.
    lv_time = iv_text+11(2) && iv_text+14(2) && iv_text+17(2).
    lv_zone = substring( val = iv_text off = 19 + strlen( lv_frac ) ).
    lv_h = lv_time(2).
    lv_m = lv_time+2(2).
    lv_s = lv_time+4(2).
    IF lv_h > 23 OR lv_m > 59 OR lv_s > 59.
      fail( 'Invalid clock time' ).
    ENDIF.
    lv_seconds = lv_h * 3600 + lv_m * 60 + lv_s.
    IF lv_zone <> 'Z'.
      lv_h = lv_zone+1(2).
      lv_m = lv_zone+4(2).
      IF lv_h > 14 OR lv_m > 59 OR ( lv_h = 14 AND lv_m <> 0 ).
        fail( 'Invalid timezone offset' ).
      ENDIF.
      lv_offset = lv_h * 3600 + lv_m * 60.
      IF lv_zone(1) = '+'.
        lv_seconds = lv_seconds - lv_offset.
      ELSE.
        lv_seconds = lv_seconds + lv_offset.
      ENDIF.
    ENDIF.
    lv_days = lv_seconds DIV 86400.
    lv_seconds = lv_seconds MOD 86400.
    lv_date = lv_date + lv_days.
    lv_time = lv_seconds.
    rv_text = |{ lv_date DATE = RAW }{ lv_time TIME = RAW }{ lv_frac }|.
  ENDMETHOD.

  METHOD atom.
    DATA lv_raw TYPE string.
    rv_text = iv_text.
    FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T.*)?$' IN iv_text.
    IF sy-subrc = 0.
      lv_raw = temporal( iv_text ).
      rv_text = |datetime'{ lv_raw }'|.
      RETURN.
    ENDIF.
    FIND REGEX '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' IN iv_text.
    IF sy-subrc = 0.
      rv_text = |guid'{ iv_text }'|.
    ENDIF.
  ENDMETHOD.

  METHOD filter.
    DATA lv_off TYPE i.
    DATA lv_char TYPE string.
    DATA lv_word TYPE string.
    DATA lv_in TYPE abap_bool.
    WHILE lv_off < strlen( iv_text ).
      lv_char = iv_text+lv_off(1).
      IF lv_in = abap_true.
        rv_text = rv_text && lv_char.
        IF lv_char = |'|.
          IF lv_off + 1 < strlen( iv_text ) AND substring( val = iv_text off = lv_off + 1 len = 1 ) = |'|.
            rv_text = rv_text && |'|.
            lv_off = lv_off + 1.
          ELSE.
            lv_in = abap_false.
          ENDIF.
        ENDIF.
      ELSEIF lv_char = |'|.
        IF to_lower( lv_word ) = 'datetime' OR to_lower( lv_word ) = 'guid' OR to_lower( lv_word ) = 'datetimeoffset'.
          fail( 'V2 typed literals are not V4 literals' ).
        ENDIF.
        rv_text = rv_text && atom( lv_word ) && lv_char.
        CLEAR lv_word.
        lv_in = abap_true.
      ELSEIF lv_char = ` ` OR lv_char = '(' OR lv_char = ')' OR lv_char = ','.
        IF to_lower( lv_word ) = 'tolower' OR to_lower( lv_word ) = 'toupper' OR to_lower( lv_word ) = 'trim'.
          fail( iv_text = 'String transformations cannot be represented as select-options' iv_status = 501 ).
        ENDIF.
        rv_text = rv_text && atom( lv_word ) && lv_char.
        CLEAR lv_word.
      ELSE.
        lv_word = lv_word && lv_char.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
    IF lv_in = abap_true.
      fail( 'Unterminated filter string' ).
    ENDIF.
    rv_text = rv_text && atom( lv_word ).
  ENDMETHOD.

  METHOD prepare.
    CREATE OBJECT mo_context.
    mo_context->mv_entity_set = is_set-name.
    mo_context->mv_entity_type = is_set-entity_type.
    mo_context->ms_set = is_set.
    mo_context->mv_aggregate = is_set-aggregate.
    read_options( is_set = is_set io_model = io_model ).
    read_keys( is_set = is_set io_model = io_model ).
  ENDMETHOD.

  METHOD read_options.
    DATA ls_opt TYPE ihttpnvp.
    DATA lt_parts TYPE string_table.
    DATA lv_part TYPE string.
    DATA lv_name TYPE string.
    DATA lv_dir TYPE string.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_order TYPE /iwbep/s_mgw_tech_order.
    DATA lt_seen TYPE string_table.
    DATA lo_parser TYPE REF TO zcl_stg_filter.
    DATA lt_nodes TYPE zcl_stg_filter=>ty_nodes.
    DATA lt_shape TYPE ty_shapes.



    LOOP AT ms_request-options INTO ls_opt.
      READ TABLE lt_seen WITH KEY table_line = ls_opt-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        fail( |Duplicate query option { ls_opt-name }| ).
      ENDIF.
      APPEND ls_opt-name TO lt_seen.
      CASE ls_opt-name.
        WHEN '$top' OR '$skip'.
          IF ls_opt-value IS INITIAL OR ls_opt-value CN '0123456789' OR strlen( ls_opt-value ) > 9.
            fail( |{ ls_opt-name } must be a nonnegative integer| ).
          ENDIF.
          IF ls_opt-name = '$top'.
            mv_top = ls_opt-value.
          ELSE.
            mv_skip = ls_opt-value.
          ENDIF.
        WHEN '$count'.
          CASE ls_opt-value.
            WHEN 'true'.
              mv_count = abap_true.
            WHEN 'false'.
              mv_count = abap_false.
            WHEN OTHERS.
              fail( '$count must be true or false' ).
          ENDCASE.
        WHEN '$select'.
          select_fields( iv_select = ls_opt-value is_set = is_set ).
        WHEN '$expand'.
          expand_items( iv_expand = ls_opt-value is_set = is_set ).
        WHEN '$search'.
* what the DPC's GET_ENTITYSET takes as iv_search_string (V2: search=),
* for an entity set the model marks searchable (set_has_ftxt_search)
          IF ms_request-key_string IS NOT INITIAL AND mv_navigation IS INITIAL.
            fail( '$search applies to a collection, not to a single entity' ).
          ENDIF.
          IF is_set-searchable = abap_false.
            fail( iv_text = |{ is_set-name } is not searchable: the model does not mark it set_has_ftxt_search (searchable: true)|
              iv_status = 501 ).
          ENDIF.
          mo_context->mv_search_string = search_term( ls_opt-value ).
        WHEN '$orderby'.
          lt_parts = split( ls_opt-value ).
          LOOP AT lt_parts INTO lv_part.
            CLEAR ls_order.
            CLEAR lv_dir.
            SPLIT lv_part AT space INTO lv_name lv_dir.
            CONDENSE lv_dir.
            IF lv_dir <> '' AND lv_dir <> 'asc' AND lv_dir <> 'desc'.
              fail( 'Invalid order direction' ).
            ENDIF.
            ls_prop = zcl_stg_model_info=>find_property( is_set = is_set iv_name = lv_name ).
            ls_order-property = ls_prop-name.
            ls_order-property_path = ls_prop-name.
            ls_order-order = lv_dir.
            IF lv_dir IS INITIAL.
              ls_order-order = 'asc'.
            ENDIF.
            APPEND ls_order TO mo_context->mt_orderby.
          ENDLOOP.
        WHEN '$filter'.
          mo_context->mv_filter_string = filter( ls_opt-value ).
          validate_literals( is_set = is_set io_model = io_model ).
          CREATE OBJECT lo_parser EXPORTING
            it_tokens = zcl_stg_filter=>tokenize( mo_context->mv_filter_string ) is_set = is_set.
          lt_nodes = lo_parser->parse_tree( ).
          lt_shape = validate_shape( it_nodes = lt_nodes iv_id = lines( lt_nodes ) ).
          mo_context->mt_filter = zcl_stg_filter=>parse( iv_filter = mo_context->mv_filter_string is_set = is_set ).
          validate_temporal_filters( is_set = is_set io_model = io_model ).
          IF ls_opt-value IS NOT INITIAL AND mo_context->mt_filter IS INITIAL.
            fail( iv_text = 'This filter cannot be represented as select-options' iv_status = 501 ).
          ENDIF.
        WHEN '$format'.
          IF ls_opt-value <> 'json' AND ls_opt-value <> 'application/json'.
            fail( 'Only JSON is supported' ).
          ENDIF.
        WHEN OTHERS.
* sap-client, sap-language, sap-context-token...: host-specific hints that
* do not change the wire shape (OData 4.01 Part 2, 5.2: custom options
* begin with a letter, and a service ignores those it does not know)
          IF ls_opt-name NP 'sap-*'.
            fail( iv_text = |Query option { ls_opt-name } is not implemented| iv_status = 501 ).
          ENDIF.
      ENDCASE.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_shape.
    DATA ls_node TYPE zcl_stg_filter=>ty_node.
    DATA lt_right TYPE ty_shapes.
    DATA ls_shape TYPE ty_shape.
    FIELD-SYMBOLS <left> TYPE ty_shape.
    IF iv_id < 1.
      RETURN.
    ENDIF.
    READ TABLE it_nodes INDEX iv_id INTO ls_node.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    IF ls_node-property IS NOT INITIAL.
      ls_shape-property = ls_node-property.
      APPEND ls_shape TO rt_shape.
      RETURN.
    ENDIF.
    rt_shape = validate_shape( it_nodes = it_nodes iv_id = ls_node-left ).
    lt_right = validate_shape( it_nodes = it_nodes iv_id = ls_node-right ).
    LOOP AT lt_right INTO ls_shape.
      READ TABLE rt_shape WITH KEY property = ls_shape-property ASSIGNING <left>.
      IF sy-subrc = 0.
* Intersecting an OR with another bound must constrain every branch.
* The shared converter only folds a bound into its first range.
        IF ls_node-kind = 'and' AND ( <left>-alternatives = abap_true OR ls_shape-alternatives = abap_true ).
          fail( iv_text = 'Same-property OR intersections cannot be represented safely' iv_status = 501 ).
        ENDIF.
        IF ls_shape-alternatives = abap_true.
          <left>-alternatives = abap_true.
        ENDIF.
      ELSE.
        APPEND ls_shape TO rt_shape.
      ENDIF.
    ENDLOOP.
    IF ls_node-kind = 'or'.
      LOOP AT rt_shape ASSIGNING <left>.
        <left>-alternatives = abap_true.
      ENDLOOP.
    ENDIF.
  ENDMETHOD.

  METHOD validate_literals.
    DATA lt_tokens TYPE zcl_stg_filter=>ty_tokens.
    DATA ls_token TYPE zcl_stg_filter=>ty_token.
    DATA ls_op TYPE zcl_stg_filter=>ty_token.
    DATA ls_value TYPE zcl_stg_filter=>ty_token.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_index TYPE i.
* Normalization creates TYPED datetime tokens only from bare V4 temporals.
* Quoted and numeric inputs retain their kinds until the shared parser runs.
    lt_tokens = zcl_stg_filter=>tokenize( mo_context->mv_filter_string ).
    LOOP AT lt_tokens INTO ls_token.
      lv_index = sy-tabix.
      IF ls_token-kind <> 'IDENT'.
        CONTINUE.
      ENDIF.
      READ TABLE lt_tokens INDEX lv_index + 1 INTO ls_op.
      ls_op-value = to_lower( ls_op-value ).
      IF sy-subrc <> 0 OR ls_op-kind <> 'IDENT' OR
        NOT ( ls_op-value = 'eq' OR ls_op-value = 'ne' OR ls_op-value = 'gt' OR
              ls_op-value = 'ge' OR ls_op-value = 'lt' OR ls_op-value = 'le' ).
        CONTINUE.
      ENDIF.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_token-value ).
      IF ls_info-edm_type = 'Edm.Date' OR ls_info-edm_type = 'Edm.DateTimeOffset'.
        READ TABLE lt_tokens INDEX lv_index + 2 INTO ls_value.
        IF sy-subrc <> 0 OR ls_value-kind <> 'TYPED' OR ls_value-value NP 'datetime:*'.
          fail( 'Temporal properties require bare V4 temporal literals' ).
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate_temporal_filters.
    DATA ls_filter TYPE /iwbep/s_mgw_select_option.
    DATA ls_range TYPE /iwbep/s_cod_select_option.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_length TYPE i.
    LOOP AT mo_context->mt_filter INTO ls_filter.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_filter-property ).
      IF ls_info-edm_type = 'Edm.Date' OR ls_info-edm_type = 'Edm.DateTimeOffset'.
        lv_length = 8.
        IF ls_info-edm_type = 'Edm.DateTimeOffset'.
          lv_length = 14.
        ENDIF.
        LOOP AT ls_filter-select_options INTO ls_range.
          IF strlen( ls_range-low ) < lv_length OR
            ( ls_info-edm_type = 'Edm.Date' AND strlen( ls_range-low ) <> lv_length ).
            fail( 'Temporal literal does not match property type' ).
          ENDIF.
          IF ls_range-high IS NOT INITIAL AND ( strlen( ls_range-high ) < lv_length OR
            ( ls_info-edm_type = 'Edm.Date' AND strlen( ls_range-high ) <> lv_length ) ).
            fail( 'Temporal literal does not match property type' ).
          ENDIF.
        ENDLOOP.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD read_keys.
    DATA lt_parts TYPE string_table.
    DATA lv_part TYPE string.
    DATA lv_value TYPE string.
    DATA lv_equal TYPE i.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lt_names TYPE string_table.

    IF mv_empty_parens = abap_true.
      fail( 'Empty key predicate' ).
    ENDIF.
    lt_names = zcl_stg_model_info=>key_names( is_set ).
    lt_parts = split( ms_request-key_string ).
    LOOP AT lt_parts INTO lv_part.
      CLEAR ls_key.
      IF lv_part(1) <> |'| AND lv_part CS '='.
        FIND FIRST OCCURRENCE OF '=' IN lv_part MATCH OFFSET lv_equal.
        ls_key-name = lv_part(lv_equal).
        lv_value = substring( val = lv_part off = lv_equal + 1 ).
        CONDENSE ls_key-name.
        SHIFT lv_value LEFT DELETING LEADING space.
        SHIFT lv_value RIGHT DELETING TRAILING space.
      ELSEIF lines( lt_names ) = 1.
        READ TABLE lt_names INDEX 1 INTO ls_key-name.
        lv_value = lv_part.
      ELSE.
        fail( 'Composite key must name every key property' ).
      ENDIF.
      READ TABLE lt_names WITH KEY table_line = ls_key-name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        fail( |Unknown key property { ls_key-name }| ).
      ENDIF.
      READ TABLE mo_context->mt_key_tab WITH KEY name = ls_key-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        fail( 'Duplicate key property' ).
      ENDIF.
      ls_prop = zcl_stg_model_info=>find_property( is_set = is_set iv_name = ls_key-name ).
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_prop-name ).
      CASE ls_info-edm_type.
        WHEN 'Edm.String'.
          IF strlen( lv_value ) < 2 OR lv_value(1) <> |'| OR substring( val = lv_value off = strlen( lv_value ) - 1 ) <> |'|.
            fail( 'String keys must be quoted' ).
          ENDIF.
          ls_key-value = zcl_stg_url=>unquote( lv_value ).
* a key longer than its MaxLength is refused by check_keys below, the same
* check as the V2 path: the DPC's CHAR field would cut it, and
* TravelSet('T0002    X') would read, change or delete T0002
        WHEN 'Edm.Date' OR 'Edm.DateTimeOffset'.
          IF ls_info-edm_type = 'Edm.Date' AND strlen( lv_value ) <> 10.
            fail( 'Expected a V4 Date literal' ).
          ELSEIF ls_info-edm_type = 'Edm.DateTimeOffset' AND strlen( lv_value ) = 10.
            fail( 'Expected a V4 DateTimeOffset literal' ).
          ENDIF.
          FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}(T.*)?$' IN lv_value.
          IF sy-subrc <> 0.
            fail( 'Expected a V4 date or timestamp literal' ).
          ENDIF.
          ls_key-value = temporal( lv_value ).
        WHEN 'Edm.Guid'.
          FIND REGEX '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' IN lv_value.
          IF sy-subrc <> 0.
            fail( 'Expected a V4 GUID literal' ).
          ENDIF.
          REPLACE ALL OCCURRENCES OF '-' IN lv_value WITH ''.
          ls_key-value = to_upper( lv_value ).
        WHEN OTHERS.
          FIND REGEX '^-?[0-9]+(\.[0-9]+)?$' IN lv_value.
          IF sy-subrc <> 0.
            fail( 'Expected a numeric key literal' ).
          ENDIF.
          ls_key-value = lv_value.
      ENDCASE.
      APPEND ls_key TO mo_context->mt_key_tab.
    ENDLOOP.
    IF ms_request-key_string IS NOT INITIAL AND lines( mo_context->mt_key_tab ) <> lines( lt_names ).
      fail( 'Missing key property' ).
    ENDIF.
* the same MaxLength check as the V2 path: a longer key is a 400, never a
* cut value addressing another entity
    zcl_stg_model_info=>check_keys( is_set = is_set it_key_tab = mo_context->mt_key_tab ).
  ENDMETHOD.

  METHOD select_fields.
    DATA lt_parts TYPE string_table.
    DATA lv_part TYPE string.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_nav_select TYPE ty_nav_select.


    lt_parts = split( iv_select ).
    LOOP AT lt_parts INTO lv_part.
      IF lv_part = '*'.
        CONTINUE.
      ENDIF.
      IF lv_part CS '/'.
* nav/prop: a property of the expanded navigation (OData 4.01 Part 1,
* 11.2.5.1); nav alone names the navigation property, which has no
* representation of its own here (no links in minimal metadata)
        SPLIT lv_part AT '/' INTO ls_nav_select-nav ls_nav_select-property.
        ls_nav = zcl_stg_model_info=>find_nav( is_set = is_set iv_name = ls_nav_select-nav ).
        ls_nav_select-nav = ls_nav-name.
        IF ls_nav_select-property IS INITIAL OR ls_nav_select-property CS '/'.
          fail( |$select path { lv_part } is not supported| ).
        ENDIF.
        APPEND ls_nav_select TO mt_nav_select.
        CONTINUE.
      ENDIF.
      READ TABLE is_set-navs WITH KEY name = lv_part TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      ls_prop = zcl_stg_model_info=>find_property( is_set = is_set iv_name = lv_part ).
      APPEND ls_prop-name TO mt_select.
    ENDLOOP.
    READ TABLE lt_parts WITH KEY table_line = '*' TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      CLEAR mt_select.
    ELSE.
      mo_context->mv_select = iv_select.
    ENDIF.
  ENDMETHOD.

  METHOD expand_items.
    DATA lt_parts TYPE string_table.
    DATA lv_part TYPE string.
    DATA lv_name TYPE string.
    DATA lv_options TYPE string.
    DATA lt_options TYPE string_table.
    DATA lv_option TYPE string.
    DATA lv_equal TYPE i.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_item TYPE ty_expand.
    DATA ls_opt TYPE ihttpnvp.
    lt_parts = split( iv_expand ).
    LOOP AT lt_parts INTO lv_part.
      CLEAR ls_item.
      lv_name = lv_part.
      CLEAR lv_options.
      FIND FIRST OCCURRENCE OF '(' IN lv_part MATCH OFFSET lv_equal.
      IF sy-subrc = 0.
        IF substring( val = lv_part off = strlen( lv_part ) - 1 ) <> ')'.
          fail( |Malformed $expand item { lv_part }| ).
        ENDIF.
        lv_name = lv_part(lv_equal).
        lv_options = substring( val = lv_part off = lv_equal + 1 len = strlen( lv_part ) - lv_equal - 2 ).
      ENDIF.
      IF lv_name = '*' OR lv_name CS '/'.
* $expand=* and nav/nav paths (type casts in 4.01) are not served; nesting
* goes through nav($expand=nav)
        fail( iv_text = |$expand path { lv_name } is not implemented| iv_status = 501 ).
      ENDIF.
      ls_nav = zcl_stg_model_info=>find_nav( is_set = is_set iv_name = lv_name ).
      ls_item-name = ls_nav-name.
      IF lv_options IS NOT INITIAL.
        lt_options = split( iv_text = lv_options iv_separator = ';' ).
        LOOP AT lt_options INTO lv_option.
          CLEAR ls_opt.
          FIND FIRST OCCURRENCE OF '=' IN lv_option MATCH OFFSET lv_equal.
          IF sy-subrc <> 0.
            fail( |Malformed $expand option { lv_option }| ).
          ENDIF.
          ls_opt-name = lv_option(lv_equal).
          ls_opt-value = substring( val = lv_option off = lv_equal + 1 ).
          CONDENSE ls_opt-name.
          IF ls_opt-name NP '$*'.
            fail( |{ ls_opt-name } is not an expand option| ).
          ENDIF.
          APPEND ls_opt TO ls_item-options.
        ENDLOOP.
      ENDIF.
      READ TABLE mt_expand WITH KEY name = ls_item-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        fail( |{ ls_item-name } is expanded twice| ).
      ENDIF.
      APPEND ls_item TO mt_expand.
    ENDLOOP.
  ENDMETHOD.

  METHOD search_term.
    DATA lv_text TYPE string.
    DATA lv_len TYPE i.
    DATA lv_pos TYPE i.
    DATA lv_char TYPE string.
    DATA lv_closed TYPE abap_bool.
    DATA lt_words TYPE string_table.
    DATA lv_word TYPE string.
* trimmed only: the spaces inside a phrase are the phrase's
    lv_text = iv_text.
    SHIFT lv_text LEFT DELETING LEADING space.
    SHIFT lv_text RIGHT DELETING TRAILING space.
    IF lv_text IS INITIAL.
      fail( '$search needs a term' ).
    ENDIF.
    IF lv_text(1) = '"'.
* a phrase; the escapes of OData 4.01 Part 2, 5.1.7 (backslash before a quote
* or a backslash) are undone in one pass, left to right, so an escaped
* backslash before a quote cannot turn the quote into an escaped one. A quote
* that is not escaped ends the phrase: anything after it is a second phrase
* or an operator, which this slice does not serve.
      lv_len = strlen( lv_text ).
      lv_pos = 1.
      WHILE lv_pos < lv_len.
        lv_char = substring( val = lv_text off = lv_pos len = 1 ).
        IF lv_char = '\'.
          lv_pos = lv_pos + 1.
          IF lv_pos >= lv_len.
            fail( '$search phrase ends inside an escape' ).
          ENDIF.
          lv_char = substring( val = lv_text off = lv_pos len = 1 ).
          IF lv_char <> '"' AND lv_char <> '\'.
            fail( |$search phrase: a backslash escapes only a quote or a backslash| ).
          ENDIF.
          rv_term = rv_term && lv_char.
        ELSEIF lv_char = '"'.
          lv_closed = abap_true.
          EXIT.
        ELSE.
          rv_term = rv_term && lv_char.
        ENDIF.
        lv_pos = lv_pos + 1.
      ENDWHILE.
      IF lv_closed = abap_false.
        fail( '$search phrase without its closing quote' ).
      ENDIF.
      IF lv_pos + 1 < lv_len.
        fail( iv_text = '$search expressions (grouping, several phrases) are not implemented: one term or one quoted phrase'
          iv_status = 501 ).
      ENDIF.
      IF rv_term IS INITIAL.
        fail( '$search needs a term' ).
      ENDIF.
      RETURN.
    ENDIF.
    IF lv_text CS '"' OR lv_text CS '('.
      fail( iv_text = '$search expressions (grouping, several phrases) are not implemented: one term or one quoted phrase'
        iv_status = 501 ).
    ENDIF.
    SPLIT lv_text AT space INTO TABLE lt_words.
    LOOP AT lt_words INTO lv_word.
      IF lv_word = 'AND' OR lv_word = 'OR' OR lv_word = 'NOT'.
        fail( iv_text = '$search operators (AND, OR, NOT) are not implemented: one term or one quoted phrase'
          iv_status = 501 ).
      ENDIF.
    ENDLOOP.
    IF lines( lt_words ) > 1.
      fail( iv_text = 'Several $search terms are not implemented: one term, or a quoted phrase'
        iv_status = 501 ).
    ENDIF.
    rv_term = lv_text.
  ENDMETHOD.
ENDCLASS.
