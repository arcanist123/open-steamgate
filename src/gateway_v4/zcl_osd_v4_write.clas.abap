CLASS zcl_osd_v4_write DEFINITION PUBLIC CREATE PUBLIC.
* POST / PATCH / PUT / DELETE of one entity over V4, through the same DPC
* create_entity / update_entity / delete_entity the V2 path calls. V4 JSON
* values are turned into the forms ZCL_STG_ENTRY_PROVIDER already converts.
* ETags: OData 4.01 Part 1 s11.4.1.1 (If-Match, 428 without, 412 on mismatch),
* checked under an exclusive lock (EZOSD_V4_LOCK) held until the LUW ends.
  PUBLIC SECTION.
    CLASS-METHODS execute IMPORTING iv_method TYPE string io_query TYPE REF TO zcl_osd_v4_query
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      iv_service_url TYPE string iv_body TYPE string it_headers TYPE tihttpnvp OPTIONAL
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS header IMPORTING it_headers TYPE tihttpnvp iv_name TYPE string
      RETURNING VALUE(rv_value) TYPE string.
* the structural values of a V4 JSON entity, checked and converted; et_nested
* are its navigation payloads (deep insert), each nested entity checked the
* same way and serialized again for ZCL_STG_ENTRY_PROVIDER, which reads
* nested JSON itself
    CLASS-METHODS values IMPORTING iv_body TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model it_headers TYPE tihttpnvp OPTIONAL
      EXPORTING et_nested TYPE tihttpnvp
      RETURNING VALUE(rt_values) TYPE zcl_osd_v4_provider=>ty_values RAISING zcx_stg_error.
* one V4 JSON value (the text ZCL_STG_JSON=>PARSE_OBJECT keeps) in the form
* the entry provider converts: internal dates and times, GUIDs without
* hyphens, numbers and booleans checked
    CLASS-METHODS convert IMPORTING iv_name TYPE string iv_value TYPE string iv_edm_type TYPE string
      RETURNING VALUE(rv_value) TYPE string RAISING zcx_stg_error.
* the navigation payloads as an expand tree, what create_deep_entity takes
    CLASS-METHODS expand_tree IMPORTING it_nested TYPE tihttpnvp
      RETURNING VALUE(ro_tree) TYPE REF TO zcl_stg_expand_node RAISING zcx_stg_error.
* the expand tree as the context URL of the answer names it
    CLASS-METHODS expand_context IMPORTING io_tree TYPE REF TO zcl_stg_expand_node
      RETURNING VALUE(rv_context) TYPE string.
    CLASS-METHODS add_header IMPORTING iv_name TYPE string iv_value TYPE string
      CHANGING ct_headers TYPE tihttpnvp.
* the entity as the DPC's GET_ENTITY returns it, and the lock on it until the
* end of the LUW (ZCL_OSD_V4_STICKY's Save goes through these too)
    CLASS-METHODS lock IMPORTING iv_service TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      it_key_tab TYPE /iwbep/t_mgw_name_value_pair RAISING zcx_stg_error.
    CLASS-METHODS read IMPORTING io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
      io_context TYPE REF TO zcl_stg_request_context is_set TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING VALUE(rr_entity) TYPE REF TO data
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS precondition IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model ir_current TYPE REF TO data it_headers TYPE tihttpnvp
      RAISING zcx_stg_error.
    CLASS-METHODS representation IMPORTING is_data TYPE any is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model iv_service_url TYPE string
      iv_expand TYPE string OPTIONAL
      RETURNING VALUE(rv_json) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS scalar IMPORTING iv_name TYPE string iv_kind TYPE string iv_value TYPE string
      is_info TYPE zcl_osd_v4_model=>ty_property iv_ieee TYPE abap_bool
      RETURNING VALUE(rv_value) TYPE string RAISING zcx_stg_error.
    CLASS-METHODS within IMPORTING iv_digits TYPE string iv_max TYPE string RETURNING VALUE(rv_ok) TYPE abap_bool.
* a nested entity of a deep insert, checked, converted and written back as JSON
    CLASS-METHODS reserialize IMPORTING iv_json TYPE string is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_model TYPE REF TO zcl_osd_v4_model it_headers TYPE tihttpnvp OPTIONAL
      RETURNING VALUE(rv_json) TYPE string RAISING zcx_stg_error.
ENDCLASS.

CLASS zcl_osd_v4_write IMPLEMENTATION.
  METHOD header.
    DATA ls_header TYPE ihttpnvp.
    LOOP AT it_headers INTO ls_header.
      IF to_lower( ls_header-name ) = to_lower( iv_name ).
        rv_value = ls_header-value.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD add_header.
    DATA ls_header TYPE ihttpnvp.
    ls_header-name = iv_name.
    ls_header-value = iv_value.
    APPEND ls_header TO ct_headers.
  ENDMETHOD.

  METHOD convert.
    DATA lv_h TYPE string.
    DATA lv_m TYPE string.
    DATA lv_s TYPE string.
    rv_value = iv_value.
    IF rv_value = 'null'.
      RETURN.
    ENDIF.
    CASE iv_edm_type.
      WHEN 'Edm.Date'.
        FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' IN rv_value.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 Date value| ).
        ENDIF.
        rv_value = zcl_osd_v4_query=>temporal( rv_value ).
      WHEN 'Edm.DateTimeOffset'.
        FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' IN rv_value.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 DateTimeOffset value| ).
        ENDIF.
        rv_value = zcl_osd_v4_query=>temporal( rv_value ).
      WHEN 'Edm.TimeOfDay'.
        FIND REGEX '^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.[0-9]+)?$' IN rv_value SUBMATCHES lv_h lv_m lv_s.
        IF sy-subrc <> 0 OR lv_h > '23' OR lv_m > '59' OR lv_s > '59'.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 TimeOfDay value| ).
        ENDIF.
        IF lv_s IS INITIAL.
          lv_s = '00'.
        ENDIF.
        rv_value = lv_h && lv_m && lv_s.
      WHEN 'Edm.Guid'.
        FIND REGEX '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' IN rv_value.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 Guid value| ).
        ENDIF.
        REPLACE ALL OCCURRENCES OF '-' IN rv_value WITH ''.
        rv_value = to_upper( rv_value ).
      WHEN 'Edm.Boolean'.
        IF rv_value <> 'true' AND rv_value <> 'false'.
          zcl_osd_v4_query=>fail( |{ iv_name } expects true or false| ).
        ENDIF.
      WHEN 'Edm.Byte' OR 'Edm.SByte' OR 'Edm.Int16' OR 'Edm.Int32' OR 'Edm.Int64'
        OR 'Edm.Decimal' OR 'Edm.Double' OR 'Edm.Single'.
        FIND REGEX '^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$' IN rv_value.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a number| ).
        ENDIF.
    ENDCASE.
  ENDMETHOD.

  METHOD reserialize.
    DATA lt_values TYPE zcl_osd_v4_provider=>ty_values.
    DATA ls_value TYPE zcl_osd_v4_provider=>ty_value.
    DATA lt_nested TYPE tihttpnvp.
    DATA ls_pair TYPE ihttpnvp.
    DATA lv_sep TYPE string.
    lt_values = values( EXPORTING iv_body = iv_json is_set = is_set io_model = io_model it_headers = it_headers
      IMPORTING et_nested = lt_nested ).
    rv_json = '{'.
    LOOP AT lt_values INTO ls_value.
      rv_json = rv_json && lv_sep && zcl_osd_v4_json=>quote( ls_value-name ) && ':'.
      IF ls_value-is_null = abap_true.
        rv_json = rv_json && 'null'.
      ELSE.
        rv_json = rv_json && zcl_osd_v4_json=>quote( ls_value-value ).
      ENDIF.
      lv_sep = ','.
    ENDLOOP.
    LOOP AT lt_nested INTO ls_pair.
      rv_json = rv_json && lv_sep && zcl_osd_v4_json=>quote( ls_pair-name ) && ':' && ls_pair-value.
      lv_sep = ','.
    ENDLOOP.
    rv_json = rv_json && '}'.
  ENDMETHOD.

  METHOD expand_tree.
* The levels below come from the payload's shape, over every element of a
* collection: one booking with flights and one without still expand flights.
* The payloads below a name are gathered into one array, so the recursion
* sees all of them.
    DATA ls_nested TYPE ihttpnvp.
    DATA lo_child TYPE REF TO zcl_stg_expand_node.
    DATA lt_inner TYPE tihttpnvp.
    DATA ls_inner TYPE ihttpnvp.
    DATA lt_merged TYPE tihttpnvp.
    DATA lt_elements TYPE string_table.
    DATA lt_more TYPE string_table.
    DATA lv_element TYPE string.
    DATA lv_more TYPE string.
    FIELD-SYMBOLS <ls_merged> TYPE ihttpnvp.
    CREATE OBJECT ro_tree.
    LOOP AT it_nested INTO ls_nested.
      CLEAR lt_elements.
      IF ls_nested-value CP '[*'.
        lt_elements = zcl_stg_json=>parse_array( ls_nested-value ).
      ELSEIF ls_nested-value IS NOT INITIAL.
        APPEND ls_nested-value TO lt_elements.
      ENDIF.
      CLEAR lt_merged.
      LOOP AT lt_elements INTO lv_element.
        CLEAR lt_inner.
        zcl_stg_json=>parse_object( EXPORTING iv_json = lv_element IMPORTING et_nested = lt_inner ).
        LOOP AT lt_inner INTO ls_inner.
          CLEAR lt_more.
          IF ls_inner-value CP '[*'.
            lt_more = zcl_stg_json=>parse_array( ls_inner-value ).
          ELSE.
            APPEND ls_inner-value TO lt_more.
          ENDIF.
          READ TABLE lt_merged ASSIGNING <ls_merged> WITH KEY name = ls_inner-name.
          IF sy-subrc <> 0.
            APPEND INITIAL LINE TO lt_merged ASSIGNING <ls_merged>.
            <ls_merged>-name = ls_inner-name.
          ENDIF.
          LOOP AT lt_more INTO lv_more.
            IF <ls_merged>-value IS INITIAL.
              <ls_merged>-value = lv_more.
            ELSE.
              <ls_merged>-value = <ls_merged>-value && ',' && lv_more.
            ENDIF.
          ENDLOOP.
        ENDLOOP.
      ENDLOOP.
      LOOP AT lt_merged ASSIGNING <ls_merged>.
        <ls_merged>-value = '[' && <ls_merged>-value && ']'.
      ENDLOOP.
      lo_child = expand_tree( lt_merged ).
      ro_tree->add_child( iv_name = ls_nested-name io_node = lo_child ).
    ENDLOOP.
  ENDMETHOD.

  METHOD expand_context.
* the expanded navigation properties as the context URL names them (OData
* 4.01 Part 1, 10.9): (to_Bookings(),to_Agency(to_Country()))
    DATA lt_children TYPE /iwbep/if_mgw_odata_expand=>ty_t_node_children.
    DATA ls_child TYPE /iwbep/if_mgw_odata_expand=>ty_s_node_child.
    DATA lo_node TYPE REF TO zcl_stg_expand_node.
    DATA lv_inner TYPE string.
    DATA lv_sep TYPE string.
    lt_children = io_tree->/iwbep/if_mgw_odata_expand~get_children( ).
    IF lt_children IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT lt_children INTO ls_child.
      lo_node ?= ls_child-node.
      lv_inner = expand_context( lo_node ).
      IF lv_inner IS INITIAL.
        lv_inner = '()'.
      ENDIF.
      rv_context = rv_context && lv_sep && ls_child-tech_nav_prop_name && lv_inner.
      lv_sep = ','.
    ENDLOOP.
    rv_context = '(' && rv_context && ')'.
  ENDMETHOD.

  METHOD values.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA lx_json TYPE REF TO zcx_ajson_error.
    DATA lt_members TYPE string_table.
    DATA lv_name TYPE string.
    DATA lv_lower TYPE string.
    DATA lv_path TYPE string.
    DATA lv_kind TYPE string.
    DATA lv_ieee TYPE abap_bool.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA ls_value TYPE zcl_osd_v4_provider=>ty_value.
    DATA lt_lexemes TYPE tihttpnvp.
    DATA ls_lexeme TYPE ihttpnvp.
    DATA lv_value TYPE string.
    DATA lt_raw_nested TYPE tihttpnvp.
    DATA ls_nested TYPE ihttpnvp.
    DATA ls_nav TYPE zcl_stg_model_info=>ty_nav.
    DATA ls_target TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lt_elements TYPE string_table.
    DATA lv_element TYPE string.
    DATA lv_sep TYPE string.
    CLEAR et_nested.
    IF iv_body IS INITIAL.
      zcl_osd_v4_query=>fail( 'A JSON object is required as the request body' ).
    ENDIF.
* The token kinds matter (a number is not a string, null is not "null"), so
* the body is read with ajson rather than the V2 parser, which keeps text only.
    TRY.
        lo_json = zcl_ajson=>parse( iv_body ).
      CATCH zcx_ajson_error INTO lx_json.
        zcl_osd_v4_query=>fail( |The request body is not valid JSON: { lx_json->get_text( ) }| ).
    ENDTRY.
    IF lo_json->get_node_type( '/' ) <> zif_ajson_types=>node_type-object.
      zcl_osd_v4_query=>fail( 'The request body must be a JSON object' ).
    ENDIF.
* ajson knows the token kinds but hands numbers over as floating point; the
* V2 parser keeps each scalar's literal text. A number is validated and
* written as the client wrote it.
    lt_lexemes = zcl_stg_json=>parse_object( EXPORTING iv_json = iv_body IMPORTING et_nested = lt_raw_nested ).
    lv_ieee = boolc( to_lower( header( it_headers = it_headers iv_name = 'content-type' ) ) CS 'ieee754compatible=true' ).
    lt_members = lo_json->members( '/' ).
    LOOP AT lt_members INTO lv_name.
      lv_path = '/' && lv_name.
      lv_kind = lo_json->get_node_type( lv_path ).
      lv_lower = to_lower( lv_name ).
* a relationship binding (Nav@odata.bind, or @bind in 4.01) would change
* data this facade cannot change: refuse it rather than drop it
      IF lv_lower CS '@odata.bind' OR lv_lower CP '*@bind'.
        zcl_osd_v4_query=>fail( iv_text = |Entity references ({ lv_name }) are not implemented| iv_status = 501 ).
      ENDIF.
* other control information and instance annotations (@odata.type, Name@x.y)
      IF lv_name CS '@'.
        CONTINUE.
      ENDIF.
      READ TABLE is_set-properties INTO ls_prop WITH KEY name = lv_name.
      IF sy-subrc <> 0.
        READ TABLE is_set-navs INTO ls_nav WITH KEY name = lv_name.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |Unknown property { lv_name } of { is_set-entity_type }| ).
        ENDIF.
* related entities under a navigation property: a deep insert (the caller
* decides whether it takes one). Each is checked and converted like the
* entity itself and written back as JSON of strings, which the V2 provider
* converts as on the V2 path.
        READ TABLE io_model->ms_service-entity_sets INTO ls_target WITH KEY name = ls_nav-target_set.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ ls_nav-name } has no target entity set| ).
        ENDIF.
        READ TABLE lt_raw_nested INTO ls_nested WITH KEY name = lv_name.
        IF lv_kind = zif_ajson_types=>node_type-array.
          IF ls_nav-to_many = abap_false.
            zcl_osd_v4_query=>fail( |{ ls_nav-name } takes one entity, not a collection| ).
          ENDIF.
          lt_elements = zcl_stg_json=>parse_array( ls_nested-value ).
          ls_nested-value = '['.
          CLEAR lv_sep.
          LOOP AT lt_elements INTO lv_element.
            ls_nested-value = ls_nested-value && lv_sep
              && reserialize( iv_json = lv_element is_set = ls_target io_model = io_model it_headers = it_headers ).
            lv_sep = ','.
          ENDLOOP.
          ls_nested-value = ls_nested-value && ']'.
        ELSEIF lv_kind = zif_ajson_types=>node_type-object.
          IF ls_nav-to_many = abap_true.
            zcl_osd_v4_query=>fail( |{ ls_nav-name } takes a collection| ).
          ENDIF.
          ls_nested-value = reserialize( iv_json = ls_nested-value is_set = ls_target io_model = io_model
            it_headers = it_headers ).
        ELSE.
          zcl_osd_v4_query=>fail( |{ ls_nav-name } takes an entity or a collection of entities| ).
        ENDIF.
        ls_nested-name = lv_name.
        APPEND ls_nested TO et_nested.
        CONTINUE.
      ENDIF.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = lv_name ).
      CLEAR ls_value.
      ls_value-name = lv_name.
      IF lv_kind = zif_ajson_types=>node_type-null.
        IF ls_prop-nullable = abap_false OR ls_prop-is_key = abap_true.
          zcl_osd_v4_query=>fail( |{ lv_name } is not nullable| ).
        ENDIF.
        ls_value-is_null = abap_true.
        APPEND ls_value TO rt_values.
        CONTINUE.
      ENDIF.
      lv_value = lo_json->get( lv_path ).
      IF lv_kind = zif_ajson_types=>node_type-number.
        READ TABLE lt_lexemes INTO ls_lexeme WITH KEY name = lv_name.
        lv_value = ls_lexeme-value.
      ENDIF.
      ls_value-value = scalar( iv_name = lv_name iv_kind = lv_kind iv_value = lv_value
        is_info = ls_info iv_ieee = lv_ieee ).
      ls_value-is_text = boolc( ls_info-edm_type = 'Edm.String' ).
      APPEND ls_value TO rt_values.
    ENDLOOP.
  ENDMETHOD.

  METHOD within.
* |iv_digits| <= iv_max, both unsigned decimal digit strings
    DATA lv_digits TYPE string.
    lv_digits = iv_digits.
    WHILE strlen( lv_digits ) > 1 AND lv_digits(1) = '0'.
      lv_digits = substring( val = lv_digits off = 1 ).
    ENDWHILE.
    IF strlen( lv_digits ) <> strlen( iv_max ).
      rv_ok = boolc( strlen( lv_digits ) < strlen( iv_max ) ).
    ELSE.
      rv_ok = boolc( lv_digits <= iv_max ).
    ENDIF.
  ENDMETHOD.

  METHOD scalar.
    DATA lv_sign TYPE string.
    DATA lv_int TYPE string.
    DATA lv_frac TYPE string.
    DATA lv_max TYPE string.
    DATA lv_min TYPE string.
    DATA lv_h TYPE string.
    DATA lv_m TYPE string.
    DATA lv_s TYPE string.
    DATA lv_precision TYPE i.
    DATA lv_scale TYPE i.
    DATA lv_length TYPE i.
    DATA lv_text TYPE string.
    DATA lv_ok TYPE abap_bool.
    rv_value = iv_value.
    CASE is_info-edm_type.
      WHEN 'Edm.Boolean'.
        IF iv_kind <> zif_ajson_types=>node_type-boolean.
          zcl_osd_v4_query=>fail( |{ iv_name } expects true or false| ).
        ENDIF.
      WHEN 'Edm.Byte' OR 'Edm.SByte' OR 'Edm.Int16' OR 'Edm.Int32' OR 'Edm.Int64'.
* Int64 may travel as a string under IEEE754Compatible=true
        IF NOT ( iv_kind = zif_ajson_types=>node_type-number
            OR ( iv_kind = zif_ajson_types=>node_type-string AND iv_ieee = abap_true AND is_info-edm_type = 'Edm.Int64' ) ).
          zcl_osd_v4_query=>fail( |{ iv_name } expects a JSON number| ).
        ENDIF.
        FIND REGEX '^(-?)([0-9]+)$' IN iv_value SUBMATCHES lv_sign lv_int.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects an integer| ).
        ENDIF.
        CASE is_info-edm_type.
          WHEN 'Edm.Byte'.
            lv_max = '255'.
            lv_min = '0'.
          WHEN 'Edm.SByte'.
            lv_max = '127'.
            lv_min = '128'.
          WHEN 'Edm.Int16'.
            lv_max = '32767'.
            lv_min = '32768'.
          WHEN 'Edm.Int32'.
            lv_max = '2147483647'.
            lv_min = '2147483648'.
          WHEN OTHERS.
            lv_max = '9223372036854775807'.
            lv_min = '9223372036854775808'.
        ENDCASE.
        IF lv_sign = '-'.
          lv_ok = within( iv_digits = lv_int iv_max = lv_min ).
        ELSE.
          lv_ok = within( iv_digits = lv_int iv_max = lv_max ).
        ENDIF.
        IF lv_ok = abap_false.
          zcl_osd_v4_query=>fail( |{ iv_name } is out of range for { is_info-edm_type }| ).
        ENDIF.
      WHEN 'Edm.Decimal'.
        IF NOT ( iv_kind = zif_ajson_types=>node_type-number
            OR ( iv_kind = zif_ajson_types=>node_type-string AND iv_ieee = abap_true ) ).
          zcl_osd_v4_query=>fail( |{ iv_name } expects a JSON number| ).
        ENDIF.
        FIND REGEX '^(-?)([0-9]+)(?:\.([0-9]+))?$' IN iv_value SUBMATCHES lv_sign lv_int lv_frac.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a decimal number without exponent| ).
        ENDIF.
        WHILE strlen( lv_int ) > 1 AND lv_int(1) = '0'.
          lv_int = substring( val = lv_int off = 1 ).
        ENDWHILE.
        IF lv_int = '0'.
          CLEAR lv_int.
        ENDIF.
        FIND REGEX 'Scale="([0-9]+)"' IN is_info-facets SUBMATCHES lv_text.
        IF sy-subrc = 0.
          lv_scale = lv_text.
          IF strlen( lv_frac ) > lv_scale.
            zcl_osd_v4_query=>fail( |{ iv_name } has more than { lv_scale } decimal places| ).
          ENDIF.
          FIND REGEX 'Precision="([0-9]+)"' IN is_info-facets SUBMATCHES lv_text.
          IF sy-subrc = 0.
            lv_precision = lv_text.
            IF strlen( lv_int ) > lv_precision - lv_scale.
              zcl_osd_v4_query=>fail( |{ iv_name } has more digits than Precision { lv_precision } allows| ).
            ENDIF.
          ENDIF.
        ENDIF.
      WHEN 'Edm.Double' OR 'Edm.Single'.
        IF iv_kind = zif_ajson_types=>node_type-string.
          IF iv_value <> 'INF' AND iv_value <> '-INF' AND iv_value <> 'NaN'.
            zcl_osd_v4_query=>fail( |{ iv_name } expects a JSON number| ).
          ENDIF.
        ELSEIF iv_kind <> zif_ajson_types=>node_type-number.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a JSON number| ).
        ENDIF.
      WHEN OTHERS.
        IF iv_kind <> zif_ajson_types=>node_type-string.
          zcl_osd_v4_query=>fail( |{ iv_name } expects a JSON string| ).
        ENDIF.
        CASE is_info-edm_type.
          WHEN 'Edm.String'.
            FIND REGEX 'MaxLength="([0-9]+)"' IN is_info-facets SUBMATCHES lv_text.
            IF sy-subrc = 0.
              lv_length = lv_text.
              IF strlen( iv_value ) > lv_length.
                zcl_osd_v4_query=>fail( |{ iv_name } is longer than MaxLength { lv_length }| ).
              ENDIF.
            ENDIF.
          WHEN 'Edm.Date'.
            FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' IN iv_value.
            IF sy-subrc <> 0.
              zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 Date value| ).
            ENDIF.
            rv_value = zcl_osd_v4_query=>temporal( iv_value ).
          WHEN 'Edm.DateTimeOffset'.
            FIND REGEX '^[0-9]{4}-[0-9]{2}-[0-9]{2}T' IN iv_value.
            IF sy-subrc <> 0.
              zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 DateTimeOffset value| ).
            ENDIF.
            rv_value = zcl_osd_v4_query=>temporal( iv_value ).
          WHEN 'Edm.TimeOfDay'.
            FIND REGEX '^([0-9]{2}):([0-9]{2})(?::([0-9]{2}))?(?:\.[0-9]+)?$' IN iv_value SUBMATCHES lv_h lv_m lv_s.
            IF sy-subrc <> 0 OR lv_h > '23' OR lv_m > '59' OR lv_s > '59'.
              zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 TimeOfDay value| ).
            ENDIF.
            IF lv_s IS INITIAL.
              lv_s = '00'.
            ENDIF.
            rv_value = lv_h && lv_m && lv_s.
          WHEN 'Edm.Guid'.
            FIND REGEX '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' IN iv_value.
            IF sy-subrc <> 0.
              zcl_osd_v4_query=>fail( |{ iv_name } expects a V4 Guid value| ).
            ENDIF.
            rv_value = iv_value.
            REPLACE ALL OCCURRENCES OF '-' IN rv_value WITH ''.
            rv_value = to_upper( rv_value ).
          WHEN 'Edm.Binary'.
            zcl_osd_v4_query=>fail( iv_text = |Binary values ({ iv_name }) are not implemented in V4 writes| iv_status = 501 ).
        ENDCASE.
    ENDCASE.
  ENDMETHOD.

  METHOD lock.
* An exclusive lock on the entity from before its ETag is read until the end
* of the LUW, so no other work process can change it between the check and
* the write (_SCOPE 2: released by COMMIT/ROLLBACK WORK or the end of the
* request, whichever ends the LUW).
    DATA lv_key TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_argument TYPE string.
    DATA lv_hash TYPE string.
    DATA lv_lockhash TYPE c LENGTH 64.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA lx_hash TYPE REF TO cx_abap_message_digest.
* The identity of the entity, not the spelling of its URL: key properties in
* the model's order, with the values the query already normalized (unquoted
* strings, internal dates, GUIDs without hyphens in upper case)
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      READ TABLE it_key_tab INTO ls_key WITH KEY name = ls_prop-name.
      lv_key = lv_key && lv_sep && ls_prop-name && '=' && ls_key-value.
      lv_sep = ','.
    ENDLOOP.
* A system allows a lock argument of 120 characters at most, and service,
* set and key together can be longer: the lock argument is the SHA-256 of
* the whole identity. Nothing is cut, so two entities share a lock only if
* their hashes collide, and then the lock covers more, never less.
    lv_argument = iv_service && '|' && is_set-name && '|' && lv_key.
    TRY.
        cl_abap_message_digest=>calculate_hash_for_char( EXPORTING if_algorithm = 'SHA256' if_data = lv_argument
          IMPORTING ef_hashstring = lv_hash ).
      CATCH cx_abap_message_digest INTO lx_hash.
        zcl_osd_v4_query=>fail( iv_text = |Entity lock: { lx_hash->get_text( ) }| iv_status = 500 ).
    ENDTRY.
    lv_lockhash = lv_hash.
    CALL FUNCTION 'ENQUEUE_EZOSD_V4_LOCK'
      EXPORTING
        mode_zosd_v4_lock = 'E'
        lockhash = lv_lockhash
      EXCEPTIONS
        foreign_lock = 1
        system_failure = 2
        OTHERS = 3.
    IF sy-subrc = 1.
      zcl_osd_v4_query=>fail( iv_text = |{ is_set-name }({ lv_key }) is being changed by another request| iv_status = 409 ).
    ELSEIF sy-subrc <> 0.
      zcl_osd_v4_query=>fail( iv_text = 'The lock server refused the entity lock' iv_status = 500 ).
    ENDIF.
  ENDMETHOD.

  METHOD read.
    io_dpc->get_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
      iv_source_name = '' it_key_tab = io_context->mt_key_tab it_navigation_path = io_context->mt_navigation_path
      io_tech_request_context = io_context IMPORTING er_entity = rr_entity ).
  ENDMETHOD.

  METHOD precondition.
    DATA lv_if_match TYPE string.
    DATA lv_current TYPE string.
    DATA lt_tags TYPE string_table.
    DATA lv_tag TYPE string.
    DATA lv_weak TYPE string.
    FIELD-SYMBOLS <ls_current> TYPE any.
    lv_if_match = header( it_headers = it_headers iv_name = 'if-match' ).
    CONDENSE lv_if_match.
    ASSIGN ir_current->* TO <ls_current>.
    lv_current = zcl_osd_v4_json=>etag( is_data = <ls_current> is_set = is_set io_model = io_model ).
    IF lv_if_match IS INITIAL.
      IF io_model->has_etag( is_set-entity_type ) = abap_true.
        zcl_osd_v4_query=>fail( iv_text = |{ is_set-name } has an ETag: send If-Match with it, or If-Match: *|
          iv_status = 428 ).
      ENDIF.
      RETURN.
    ENDIF.
    IF lv_if_match = '*'.
      RETURN.
    ENDIF.
* A list of entity tags; the weak prefix is not part of the comparison
    lv_weak = lv_current.
    IF lv_weak CP 'W/*'.
      lv_weak = substring( val = lv_weak off = 2 ).
    ENDIF.
    SPLIT lv_if_match AT ',' INTO TABLE lt_tags.
    LOOP AT lt_tags INTO lv_tag.
      CONDENSE lv_tag.
      IF lv_tag CP 'W/*'.
        lv_tag = substring( val = lv_tag off = 2 ).
      ENDIF.
      IF lv_current IS NOT INITIAL AND ( lv_tag = lv_weak OR lv_tag = '*' ).
        RETURN.
      ENDIF.
    ENDLOOP.
    zcl_osd_v4_query=>fail( iv_text = 'If-Match does not match the current ETag of the entity' iv_status = 412 ).
  ENDMETHOD.

  METHOD representation.
    DATA lv_entity TYPE string.
    lv_entity = zcl_osd_v4_json=>entity( is_data = is_data is_set = is_set io_model = io_model ).
    rv_json = zcl_osd_v4_json=>document( iv_context = |{ iv_service_url }/$metadata#{ is_set-name }{ iv_expand }/$entity|
      iv_entity = lv_entity ).
  ENDMETHOD.

  METHOD execute.
    DATA lo_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lo_provider TYPE REF TO zcl_osd_v4_provider.
    DATA lt_values TYPE zcl_osd_v4_provider=>ty_values.
    DATA ls_value TYPE zcl_osd_v4_provider=>ty_value.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lr_entity TYPE REF TO data.
    DATA lr_current TYPE REF TO data.
    DATA lv_prefer TYPE string.
    DATA lv_location TYPE string.
    DATA lv_etag TYPE string.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lt_nested TYPE tihttpnvp.
    DATA lo_tree TYPE REF TO zcl_stg_expand_node.
    DATA lv_expand TYPE string.
    FIELD-SYMBOLS <ls_data> TYPE any.

    lo_dpc = zcl_oao_registry=>create_dpc( io_model->ms_service-name ).
    lo_context = io_query->mo_context.
    lv_prefer = to_lower( header( it_headers = it_headers iv_name = 'prefer' ) ).
    rs_response-content_type = 'application/json;odata.metadata=minimal'.

* What the model allows on the set, as on the V2 path: a refused write never
* reaches the DPC.
    IF ( iv_method = 'POST' AND is_set-creatable = abap_false )
        OR ( ( iv_method = 'PATCH' OR iv_method = 'PUT' ) AND is_set-updatable = abap_false )
        OR ( iv_method = 'DELETE' AND is_set-deletable = abap_false ).
      zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not allowed on { is_set-name }| iv_status = 405 ).
    ENDIF.

    CASE iv_method.
      WHEN 'POST'.
        lt_values = values( EXPORTING iv_body = iv_body is_set = is_set io_model = io_model it_headers = it_headers
          IMPORTING et_nested = lt_nested ).
        CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set
          it_nested = lt_nested is_service = io_model->ms_service.
        IF lt_nested IS NOT INITIAL.
* deep insert (OData 4.01 Part 1, 11.4.2.2): the parent and the related
* entities in one LUW through the DPC's create_deep_entity, as on V2
          lo_tree = expand_tree( lt_nested ).
          lv_expand = expand_context( lo_tree ).
          lo_dpc->create_deep_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
            iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
            it_navigation_path = lo_context->mt_navigation_path io_expand = lo_tree
            io_tech_request_context = lo_context IMPORTING er_deep_entity = lr_entity ).
        ELSE.
          lo_dpc->create_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
            iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
            it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
            IMPORTING er_entity = lr_entity ).
        ENDIF.
        IF lr_entity IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'The data provider created nothing' iv_status = 500 ).
        ENDIF.
        ASSIGN lr_entity->* TO <ls_data>.
* the key predicate carries its own URI escaping: key_predicate encodes a
* string value per UTF-8 byte, an ASCII key keeping the bytes escape_url
* wrote, so the Location of an ASCII key is the one it always had
        lv_location = zcl_osd_v4_json=>key_predicate( is_data = <ls_data>
                                                       is_set   = is_set
                                                       io_model = io_model ).
        lv_location = |{ iv_service_url }/{ is_set-name }({ lv_location })|.
        add_header( EXPORTING iv_name = 'Location' iv_value = lv_location CHANGING ct_headers = rs_response-headers ).
        lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_data> is_set = is_set io_model = io_model ).
        IF lv_etag IS NOT INITIAL.
          add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
        ENDIF.
        IF lv_prefer CS 'return=minimal'.
          rs_response-status = 204.
          CLEAR rs_response-content_type.
          add_header( EXPORTING iv_name = 'OData-EntityId' iv_value = lv_location CHANGING ct_headers = rs_response-headers ).
          add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'return=minimal' CHANGING ct_headers = rs_response-headers ).
        ELSE.
          rs_response-status = 201.
          rs_response-body = representation( is_data = <ls_data> is_set = is_set io_model = io_model
            iv_service_url = iv_service_url iv_expand = lv_expand ).
        ENDIF.

      WHEN 'PATCH' OR 'PUT'.
        lt_values = values( EXPORTING iv_body = iv_body is_set = is_set io_model = io_model it_headers = it_headers
          IMPORTING et_nested = lt_nested ).
        IF lt_nested IS NOT INITIAL.
          zcl_osd_v4_query=>fail( iv_text = 'A deep update (related entities in a PATCH or PUT) is not implemented' iv_status = 501 ).
        ENDIF.
        lock( iv_service = io_model->ms_service-name is_set = is_set it_key_tab = lo_context->mt_key_tab ).
        lr_current = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        IF lr_current IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
        ENDIF.
        precondition( is_set = is_set io_model = io_model ir_current = lr_current it_headers = it_headers ).
* The key is the one the URL names: a key property in the body cannot move
* the update to another entity.
        LOOP AT lo_context->mt_key_tab INTO ls_key.
          DELETE lt_values WHERE name = ls_key-name.
          CLEAR ls_value.
          ls_value-name = ls_key-name.
          ls_value-value = ls_key-value.
          ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_key-name ).
          ls_value-is_text = boolc( ls_info-edm_type = 'Edm.String' ).
          APPEND ls_value TO lt_values.
        ENDLOOP.
* PATCH lays the request over the entity as it is; PUT replaces it, so a
* property the body leaves out is reset to its initial value.
        IF iv_method = 'PATCH'.
          CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set ir_base = lr_current.
        ELSE.
          CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set.
        ENDIF.
        lo_dpc->update_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
          iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
          it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
          IMPORTING er_entity = lr_entity ).
        lr_entity = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        rs_response-status = 204.
        CLEAR rs_response-content_type.
        IF lr_entity IS BOUND.
          ASSIGN lr_entity->* TO <ls_data>.
          lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_data> is_set = is_set io_model = io_model ).
          IF lv_etag IS NOT INITIAL.
            add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
          ENDIF.
          IF lv_prefer CS 'return=representation'.
            rs_response-status = 200.
            rs_response-content_type = 'application/json;odata.metadata=minimal'.
            rs_response-body = representation( is_data = <ls_data> is_set = is_set io_model = io_model
              iv_service_url = iv_service_url ).
            add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'return=representation'
              CHANGING ct_headers = rs_response-headers ).
          ENDIF.
        ENDIF.

      WHEN 'DELETE'.
        lock( iv_service = io_model->ms_service-name is_set = is_set it_key_tab = lo_context->mt_key_tab ).
        lr_current = read( io_dpc = lo_dpc io_context = lo_context is_set = is_set ).
        IF lr_current IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
        ENDIF.
        precondition( is_set = is_set io_model = io_model ir_current = lr_current it_headers = it_headers ).
        lo_dpc->delete_entity( iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
          iv_source_name = '' it_key_tab = lo_context->mt_key_tab it_navigation_path = lo_context->mt_navigation_path
          io_tech_request_context = lo_context ).
        rs_response-status = 204.
        CLEAR rs_response-content_type.

      WHEN OTHERS.
        zcl_osd_v4_query=>fail( iv_text = |{ iv_method } is not supported| iv_status = 405 ).
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
