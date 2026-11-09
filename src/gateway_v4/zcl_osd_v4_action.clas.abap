CLASS zcl_osd_v4_action DEFINITION PUBLIC CREATE PUBLIC.
* The model's function imports as V4 operations (OData 4.01 Part 1, 11.5):
* CSDL Action / Function elements, their imports, invocation and the
* result, all through the DPC's execute_action that the V2 path calls.
*
* Binding: a function import with set_action_for (SEGW's "Action for") is
* bound to that entity type. When its parameters cover every key of the
* type it is bound to the entity -- `_it` is the entity, the key parameters
* are filled from the URL and are not in the parameter list -- else to the
* collection, with every parameter. Without set_action_for it is unbound,
* reached through an ActionImport (POST) or a FunctionImport (GET) of the
* container. The HTTP method of the function import decides the kind: GET
* is a Function, anything else an Action.
*
* Return type: the entity type or Collection() of it when the model names
* one, the complex type when it names that, and Edm.PrimitiveType otherwise
* (classic SEGW has no primitive return kind in the tree; the value is
* serialized by its ABAP kind, as the V2 path does).
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_binding,
* 'E' bound to an entity, 'C' to a collection, 'U' unbound
             kind        TYPE c LENGTH 1,
             is_function TYPE abap_bool,
             entity_type TYPE string,
             entity_set  TYPE string,
           END OF ty_binding.
    CLASS-METHODS binding IMPORTING is_action TYPE zcl_stg_model_info=>ty_action
      io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rs_binding) TYPE ty_binding.
* the Action and Function elements of the schema
    CLASS-METHODS schema_xml IMPORTING io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rv_xml) TYPE string.
* the ActionImport and FunctionImport elements of the container
    CLASS-METHODS imports_xml IMPORTING io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rv_xml) TYPE string.
* Set(key)/<ns>.<op> or Set/<ns>.<op>
    CLASS-METHODS bound IMPORTING iv_method TYPE string iv_name TYPE string io_query TYPE REF TO zcl_osd_v4_query
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime iv_service_url TYPE string iv_body TYPE string
      it_headers TYPE tihttpnvp OPTIONAL
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
* <op>(p=v) or POST <op> at the service root
    CLASS-METHODS unbound IMPORTING iv_method TYPE string is_action TYPE zcl_stg_model_info=>ty_action
      io_query TYPE REF TO zcl_osd_v4_query io_model TYPE REF TO zcl_osd_v4_model
      io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime iv_service_url TYPE string iv_body TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
* the Allow header the caller puts on a 405
    CLASS-DATA gv_allow TYPE string READ-ONLY.
  PRIVATE SECTION.
    CLASS-METHODS op_name IMPORTING iv_name TYPE string io_model TYPE REF TO zcl_osd_v4_model
      RETURNING VALUE(rv_name) TYPE string.
    CLASS-METHODS return_xml IMPORTING is_action TYPE zcl_stg_model_info=>ty_action
      io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS parameters_xml IMPORTING is_action TYPE zcl_stg_model_info=>ty_action
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set iv_skip_keys TYPE abap_bool
      RETURNING VALUE(rv_xml) TYPE string.
* the parameters of a function: p=v,... from the URL
    CLASS-METHODS url_parameters IMPORTING iv_text TYPE string is_action TYPE zcl_stg_model_info=>ty_action
      CHANGING ct_parameters TYPE /iwbep/t_mgw_name_value_pair RAISING zcx_stg_error.
* the parameters of an action: the JSON object of the body
    CLASS-METHODS body_parameters IMPORTING iv_body TYPE string is_action TYPE zcl_stg_model_info=>ty_action
      CHANGING ct_parameters TYPE /iwbep/t_mgw_name_value_pair RAISING zcx_stg_error.
    CLASS-METHODS check_method IMPORTING iv_method TYPE string is_action TYPE zcl_stg_model_info=>ty_action
      is_binding TYPE ty_binding RAISING zcx_stg_error.
    CLASS-METHODS execute IMPORTING is_action TYPE zcl_stg_model_info=>ty_action
      it_parameters TYPE /iwbep/t_mgw_name_value_pair io_model TYPE REF TO zcl_osd_v4_model
      io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime iv_service_url TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS complex_json IMPORTING is_data TYPE any iv_type TYPE string io_model TYPE REF TO zcl_osd_v4_model
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.

CLASS zcl_osd_v4_action IMPLEMENTATION.
  METHOD binding.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA lv_all TYPE abap_bool.
    rs_binding-kind = 'U'.
    rs_binding-is_function = boolc( is_action-http_method = 'GET' ).
    IF is_action-action_for IS INITIAL.
      RETURN.
    ENDIF.
    READ TABLE io_model->ms_service-entity_sets INTO ls_set WITH KEY entity_type = is_action-action_for.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    rs_binding-entity_type = ls_set-entity_type.
    rs_binding-entity_set = ls_set-name.
    rs_binding-kind = 'C'.
    lv_all = abap_true.
    LOOP AT ls_set-properties INTO ls_prop WHERE is_key = abap_true.
      READ TABLE is_action-parameters WITH KEY name = ls_prop-name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        lv_all = abap_false.
      ENDIF.
    ENDLOOP.
    IF lv_all = abap_true.
      rs_binding-kind = 'E'.
    ENDIF.
  ENDMETHOD.

  METHOD return_xml.
    DATA lv_type TYPE string.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    IF is_action-return_entity_type IS NOT INITIAL.
      lv_type = |{ io_model->ms_service-namespace }.{ is_action-return_entity_type }|.
    ELSEIF is_action-return_entity_set IS NOT INITIAL.
      READ TABLE io_model->ms_service-entity_sets INTO ls_set WITH KEY name = is_action-return_entity_set.
      lv_type = |{ io_model->ms_service-namespace }.{ ls_set-entity_type }|.
    ELSEIF is_action-return_complex_type IS NOT INITIAL.
      lv_type = |{ io_model->ms_service-namespace }.{ is_action-return_complex_type }|.
    ELSE.
      lv_type = 'Edm.PrimitiveType'.
    ENDIF.
    IF is_action-return_many = abap_true.
      lv_type = |Collection({ lv_type })|.
    ENDIF.
    rv_xml = |<ReturnType Type="{ zcl_osd_v4_model=>xml( lv_type ) }"/>|.
  ENDMETHOD.

  METHOD parameters_xml.
    DATA ls_param TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    LOOP AT is_action-parameters INTO ls_param.
      IF iv_skip_keys = abap_true.
        READ TABLE is_set-properties WITH KEY name = ls_param-name is_key = abap_true TRANSPORTING NO FIELDS.
        IF sy-subrc = 0.
          CONTINUE.
        ENDIF.
      ENDIF.
* the facets the MPC gave the parameter (set_maxlength, set_precision...),
* written as for a property
      ls_info = io_model->parameter( iv_action = is_action-name iv_name = ls_param-name ).
      rv_xml = rv_xml && |<Parameter Name="{ zcl_osd_v4_model=>xml( ls_param-name ) }" Type="{
        zcl_osd_v4_model=>xml( zcl_osd_v4_model=>v4_type( ls_param-edm_type ) ) }"{ ls_info-facets }/>|.
    ENDLOOP.
  ENDMETHOD.

  METHOD schema_xml.
    DATA ls_action TYPE zcl_stg_model_info=>ty_action.
    DATA ls_binding TYPE ty_binding.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_tag TYPE string.
    DATA lv_type TYPE string.
    DATA lv_bound TYPE string.
    DATA lv_params TYPE string.
    DATA lv_returns TYPE string.
    DATA ls_return TYPE zcl_stg_model_info=>ty_entity_set.
    LOOP AT io_model->ms_service-actions INTO ls_action.
      ls_binding = binding( is_action = ls_action io_model = io_model ).
      lv_tag = 'Action'.
      IF ls_binding-is_function = abap_true.
        lv_tag = 'Function'.
      ENDIF.
      CLEAR lv_bound.
      CLEAR lv_params.
      IF ls_binding-kind <> 'U'.
        READ TABLE io_model->ms_service-entity_sets INTO ls_set WITH KEY name = ls_binding-entity_set.
        lv_type = zcl_osd_v4_model=>xml( |{ io_model->ms_service-namespace }.{ ls_binding-entity_type }| ).
        IF ls_binding-kind = 'C'.
          lv_type = |Collection({ lv_type })|.
        ENDIF.
        lv_bound = ' IsBound="true"'.
* an operation that answers the binding's own type answers it from the
* binding's set: EntitySetPath tells the client which set that is (the
* sticky-session actions say the same)
        CLEAR lv_returns.
        IF ls_action-return_entity_type IS NOT INITIAL.
          lv_returns = ls_action-return_entity_type.
        ELSEIF ls_action-return_entity_set IS NOT INITIAL.
          READ TABLE io_model->ms_service-entity_sets INTO ls_return WITH KEY name = ls_action-return_entity_set.
          IF sy-subrc = 0.
            lv_returns = ls_return-entity_type.
          ENDIF.
        ENDIF.
        IF lv_returns IS NOT INITIAL AND lv_returns = ls_binding-entity_type
            AND ( ls_action-return_entity_set IS INITIAL OR ls_action-return_entity_set = ls_binding-entity_set ).
          lv_bound = lv_bound && ' EntitySetPath="_it"'.
        ENDIF.
        lv_params = |<Parameter Name="_it" Type="{ lv_type }" Nullable="false"/>|.
        lv_params = lv_params && parameters_xml( is_action = ls_action io_model = io_model is_set = ls_set
          iv_skip_keys = boolc( ls_binding-kind = 'E' ) ).
      ELSE.
        lv_params = parameters_xml( is_action = ls_action io_model = io_model is_set = ls_set iv_skip_keys = abap_false ).
      ENDIF.
      rv_xml = rv_xml && |<{ lv_tag } Name="{ zcl_osd_v4_model=>xml( ls_action-name ) }"{ lv_bound }>| &&
        lv_params && return_xml( is_action = ls_action io_model = io_model ) && |</{ lv_tag }>|.
    ENDLOOP.
  ENDMETHOD.

  METHOD imports_xml.
    DATA ls_action TYPE zcl_stg_model_info=>ty_action.
    DATA ls_binding TYPE ty_binding.
    DATA lv_set TYPE string.
    DATA lv_ns TYPE string.
    lv_ns = zcl_osd_v4_model=>xml( io_model->ms_service-namespace ).
    LOOP AT io_model->ms_service-actions INTO ls_action.
      ls_binding = binding( is_action = ls_action io_model = io_model ).
      IF ls_binding-kind <> 'U'.
        CONTINUE.
      ENDIF.
      CLEAR lv_set.
      IF ls_action-return_entity_set IS NOT INITIAL.
        lv_set = | EntitySet="{ zcl_osd_v4_model=>xml( ls_action-return_entity_set ) }"|.
      ENDIF.
      IF ls_binding-is_function = abap_true.
        rv_xml = rv_xml && |<FunctionImport Name="{ zcl_osd_v4_model=>xml( ls_action-name ) }" Function="{ lv_ns }.{
          zcl_osd_v4_model=>xml( ls_action-name ) }"{ lv_set }/>|.
      ELSE.
        rv_xml = rv_xml && |<ActionImport Name="{ zcl_osd_v4_model=>xml( ls_action-name ) }" Action="{ lv_ns }.{
          zcl_osd_v4_model=>xml( ls_action-name ) }"{ lv_set }/>|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD op_name.
    rv_name = iv_name.
    IF rv_name CP |{ io_model->ms_service-namespace }.*|.
      rv_name = substring( val = rv_name off = strlen( io_model->ms_service-namespace ) + 1 ).
    ENDIF.
  ENDMETHOD.

  METHOD check_method.
    IF is_binding-is_function = abap_true AND iv_method <> 'GET'.
      gv_allow = 'GET'.
      zcl_osd_v4_query=>fail( iv_text = |Function { is_action-name } takes GET| iv_status = 405 ).
    ELSEIF is_binding-is_function = abap_false AND iv_method <> 'POST'.
      gv_allow = 'POST'.
      zcl_osd_v4_query=>fail( iv_text = |Action { is_action-name } takes POST| iv_status = 405 ).
    ENDIF.
  ENDMETHOD.

  METHOD url_parameters.
    DATA lt_parts TYPE string_table.
    DATA lv_part TYPE string.
    DATA lv_equal TYPE i.
    DATA lv_value TYPE string.
    DATA ls_param TYPE zcl_stg_model_info=>ty_property.
    DATA ls_pair TYPE /iwbep/s_mgw_name_value_pair.
    DATA lt_seen TYPE string_table.
    DATA lv_type TYPE string.
    DATA lv_quoted TYPE abap_bool.
    FIELD-SYMBOLS <ls_pair> TYPE /iwbep/s_mgw_name_value_pair.
    lt_parts = zcl_osd_v4_query=>split( iv_text ).
    LOOP AT lt_parts INTO lv_part.
      FIND FIRST OCCURRENCE OF '=' IN lv_part MATCH OFFSET lv_equal.
      IF sy-subrc <> 0 OR lv_part(1) = |'|.
        zcl_osd_v4_query=>fail( |Malformed parameter { lv_part }: expected name=value| ).
      ENDIF.
      ls_pair-name = lv_part(lv_equal).
      lv_value = substring( val = lv_part off = lv_equal + 1 ).
      CONDENSE ls_pair-name.
      SHIFT lv_value LEFT DELETING LEADING space.
      SHIFT lv_value RIGHT DELETING TRAILING space.
      READ TABLE is_action-parameters INTO ls_param WITH KEY name = ls_pair-name.
      IF sy-subrc <> 0.
        zcl_osd_v4_query=>fail( |Unknown parameter { ls_pair-name } of { is_action-name }| ).
      ENDIF.
      READ TABLE lt_seen WITH KEY table_line = ls_pair-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        zcl_osd_v4_query=>fail( |Parameter { ls_pair-name } is given more than once| ).
      ENDIF.
      APPEND ls_pair-name TO lt_seen.
      IF lv_value CP '@*'.
        zcl_osd_v4_query=>fail( iv_text = 'Parameter aliases are not implemented' iv_status = 501 ).
      ENDIF.
* A string is a quoted literal and nothing else is (OData 4.01 ABNF,
* primitiveLiteral): TravelCount(Status=1) is not the string '1'
      lv_type = zcl_osd_v4_model=>v4_type( ls_param-edm_type ).
      IF lv_value = 'null'.
        lv_quoted = abap_false.
      ELSEIF strlen( lv_value ) >= 1 AND lv_value(1) = |'|.
        lv_quoted = abap_true.
      ELSE.
        lv_quoted = abap_false.
      ENDIF.
      IF lv_value <> 'null' AND lv_quoted <> boolc( lv_type = 'Edm.String' ).
        IF lv_type = 'Edm.String'.
          zcl_osd_v4_query=>fail( |Parameter { ls_pair-name } is an Edm.String: a quoted literal is expected| ).
        ELSE.
          zcl_osd_v4_query=>fail( |Parameter { ls_pair-name } is an { lv_type }: an unquoted literal is expected| ).
        ENDIF.
      ENDIF.
      IF lv_quoted = abap_true.
        IF strlen( lv_value ) < 2 OR substring( val = lv_value off = strlen( lv_value ) - 1 ) <> |'|.
          zcl_osd_v4_query=>fail( |Unterminated string literal in parameter { ls_pair-name }| ).
        ENDIF.
        lv_value = zcl_stg_url=>unquote( lv_value ).
      ENDIF.
      lv_value = zcl_osd_v4_write=>convert( iv_name = ls_pair-name iv_value = lv_value iv_edm_type = lv_type ).
      IF lv_quoted = abap_false AND lv_value = 'null'.
        CLEAR lv_value.
      ENDIF.
* the same MaxLength check as a read's key (zcl_stg_model_info), after the
* null (which is handed over empty): a parameter the DPC's CHAR field would
* cut is a 400, never a wrong answer
      zcl_stg_model_info=>check_length( is_property = ls_param
                                        iv_value    = lv_value
                                        iv_what     = |Parameter of { is_action-name }:| ).
      READ TABLE ct_parameters ASSIGNING <ls_pair> WITH KEY name = ls_pair-name.
      IF sy-subrc = 0.
        <ls_pair>-value = lv_value.
      ELSE.
        ls_pair-value = lv_value.
        APPEND ls_pair TO ct_parameters.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD body_parameters.
    DATA lt_values TYPE tihttpnvp.
    DATA lt_nested TYPE tihttpnvp.
    DATA ls_value TYPE ihttpnvp.
    DATA ls_param TYPE zcl_stg_model_info=>ty_property.
    DATA ls_pair TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_body TYPE string.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA lx_json TYPE REF TO zcx_ajson_error.
    DATA lt_seen TYPE string_table.
    DATA lv_kind TYPE string.
    FIELD-SYMBOLS <ls_pair> TYPE /iwbep/s_mgw_name_value_pair.
    lv_body = iv_body.
    IF lv_body IS INITIAL.
      lv_body = '{}'.
    ENDIF.
* the token kinds matter (a number is not a string): ajson reads them, the
* V2 parser keeps each scalar's literal text, as for an entity body
    TRY.
        lo_json = zcl_ajson=>parse( lv_body ).
      CATCH zcx_ajson_error INTO lx_json.
        zcl_osd_v4_query=>fail( |The request body is not valid JSON: { lx_json->get_text( ) }| ).
    ENDTRY.
    IF lo_json->get_node_type( '/' ) <> zif_ajson_types=>node_type-object.
      zcl_osd_v4_query=>fail( 'The request body must be a JSON object' ).
    ENDIF.
    lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json = lv_body IMPORTING et_nested = lt_nested ).
    READ TABLE lt_nested INDEX 1 INTO ls_value.
    IF sy-subrc = 0.
      zcl_osd_v4_query=>fail( iv_text = |Parameter { ls_value-name }: only primitive parameters are implemented| iv_status = 501 ).
    ENDIF.
    LOOP AT lt_values INTO ls_value.
      IF ls_value-name CS '@'.
        CONTINUE.
      ENDIF.
      READ TABLE is_action-parameters INTO ls_param WITH KEY name = ls_value-name.
      IF sy-subrc <> 0.
        zcl_osd_v4_query=>fail( |Unknown parameter { ls_value-name } of { is_action-name }| ).
      ENDIF.
      READ TABLE lt_seen WITH KEY table_line = ls_value-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        zcl_osd_v4_query=>fail( |Parameter { ls_value-name } is given more than once| ).
      ENDIF.
      APPEND ls_value-name TO lt_seen.
      lv_kind = lo_json->get_node_type( '/' && ls_value-name ).
      IF zcl_osd_v4_model=>v4_type( ls_param-edm_type ) = 'Edm.String'
          AND lv_kind <> zif_ajson_types=>node_type-string AND lv_kind <> zif_ajson_types=>node_type-null.
        zcl_osd_v4_query=>fail( |Parameter { ls_value-name } is an Edm.String: a JSON string is expected| ).
      ENDIF.
      ls_pair-name = ls_value-name.
      ls_pair-value = zcl_osd_v4_write=>convert( iv_name = ls_value-name iv_value = ls_value-value
        iv_edm_type = zcl_osd_v4_model=>v4_type( ls_param-edm_type ) ).
      IF lv_kind = zif_ajson_types=>node_type-null.
        CLEAR ls_pair-value.
      ENDIF.
* the body's parameters go through the same MaxLength check as a function's
* URL parameters and a read's key (a JSON null is handed over empty before
* it): a cut value never reaches the DPC
      zcl_stg_model_info=>check_length( is_property = ls_param
                                        iv_value    = ls_pair-value
                                        iv_what     = |Parameter of { is_action-name }:| ).
      READ TABLE ct_parameters ASSIGNING <ls_pair> WITH KEY name = ls_pair-name.
      IF sy-subrc = 0.
        <ls_pair>-value = ls_pair-value.
      ELSE.
        APPEND ls_pair TO ct_parameters.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD bound.
    DATA ls_action TYPE zcl_stg_model_info=>ty_action.
    DATA ls_binding TYPE ty_binding.
    DATA lt_parameters TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_param TYPE zcl_stg_model_info=>ty_property.
    DATA ls_pair TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_name TYPE string.
    DATA lr_current TYPE REF TO data.
    FIELD-SYMBOLS <ls_bound> TYPE /iwbep/s_mgw_name_value_pair.
    lv_name = op_name( iv_name = iv_name io_model = io_model ).
    ls_action = zcl_stg_model_info=>find_action( is_service = io_model->ms_service iv_name = lv_name ).
    IF ls_action-name IS INITIAL.
      zcl_osd_v4_query=>fail( iv_text = |Unknown operation { iv_name }| iv_status = 404 ).
    ENDIF.
    ls_binding = binding( is_action = ls_action io_model = io_model ).
    IF ls_binding-kind = 'U' OR ls_binding-entity_type <> is_set-entity_type.
      zcl_osd_v4_query=>fail( |{ ls_action-name } is not bound to { is_set-name }| ).
    ENDIF.
    IF ls_binding-kind = 'E' AND io_query->ms_request-key_string IS INITIAL.
      zcl_osd_v4_query=>fail( |{ ls_action-name } is bound to an entity of { is_set-name }: a key is needed| ).
    ELSEIF ls_binding-kind = 'C' AND io_query->ms_request-key_string IS NOT INITIAL.
      zcl_osd_v4_query=>fail( |{ ls_action-name } is bound to the collection { is_set-name }, not to an entity| ).
    ENDIF.
    check_method( iv_method = iv_method is_action = ls_action is_binding = ls_binding ).
* every parameter is handed to the DPC, as on V2; the key of the binding
* fills the parameters named like the key properties
    LOOP AT ls_action-parameters INTO ls_param.
      CLEAR ls_pair.
      ls_pair-name = ls_param-name.
      READ TABLE io_query->mo_context->mt_key_tab INTO ls_key WITH KEY name = ls_param-name.
      IF sy-subrc = 0.
        ls_pair-value = ls_key-value.
      ENDIF.
      APPEND ls_pair TO lt_parameters.
    ENDLOOP.
    IF ls_binding-is_function = abap_true.
      url_parameters( EXPORTING iv_text = io_query->mv_params is_action = ls_action CHANGING ct_parameters = lt_parameters ).
    ELSE.
      IF io_query->mv_params IS NOT INITIAL.
        zcl_osd_v4_query=>fail( |Action { ls_action-name } takes its parameters in the request body| ).
      ENDIF.
      body_parameters( EXPORTING iv_body = iv_body is_action = ls_action CHANGING ct_parameters = lt_parameters ).
    ENDIF.
* the key is the binding's: a parameter in the body or URL cannot move it
    LOOP AT io_query->mo_context->mt_key_tab INTO ls_key.
      READ TABLE lt_parameters ASSIGNING <ls_bound> WITH KEY name = ls_key-name.
      IF sy-subrc = 0.
        <ls_bound>-value = ls_key-value.
      ENDIF.
    ENDLOOP.
* The binding parameter is the entity the URL names (OData 4.01 Part 1,
* 11.5.5): it must exist (404), and an action changes it the way a PATCH
* does -- under the entity lock, after If-Match is checked against its
* current ETag: 412 on a mismatch, and 428 without If-Match when the entity
* type has an ETag, the same rule as PATCH/PUT/DELETE (sap.fe sends it).
    IF ls_binding-kind = 'E'.
      IF ls_binding-is_function = abap_false.
        zcl_osd_v4_write=>lock( iv_service = io_model->ms_service-name is_set = is_set
          it_key_tab = io_query->mo_context->mt_key_tab ).
      ENDIF.
      lr_current = zcl_osd_v4_write=>read( io_dpc = io_dpc io_context = io_query->mo_context is_set = is_set ).
      IF lr_current IS NOT BOUND.
        zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
      ENDIF.
      IF ls_binding-is_function = abap_false.
        zcl_osd_v4_write=>precondition( is_set = is_set io_model = io_model ir_current = lr_current
          it_headers = it_headers ).
      ENDIF.
    ENDIF.
    rs_response = execute( is_action = ls_action it_parameters = lt_parameters io_model = io_model
      io_dpc = io_dpc iv_service_url = iv_service_url ).
  ENDMETHOD.

  METHOD unbound.
    DATA ls_binding TYPE ty_binding.
    DATA lt_parameters TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_param TYPE zcl_stg_model_info=>ty_property.
    DATA ls_pair TYPE /iwbep/s_mgw_name_value_pair.
    ls_binding = binding( is_action = is_action io_model = io_model ).
    IF ls_binding-kind <> 'U'.
      zcl_osd_v4_query=>fail( iv_text = |{ is_action-name } is bound to { ls_binding-entity_set }: call it there| iv_status = 404 ).
    ENDIF.
    check_method( iv_method = iv_method is_action = is_action is_binding = ls_binding ).
    LOOP AT is_action-parameters INTO ls_param.
      CLEAR ls_pair.
      ls_pair-name = ls_param-name.
      APPEND ls_pair TO lt_parameters.
    ENDLOOP.
    IF ls_binding-is_function = abap_true.
      url_parameters( EXPORTING iv_text = io_query->ms_request-key_string is_action = is_action
        CHANGING ct_parameters = lt_parameters ).
    ELSE.
      IF io_query->ms_request-key_string IS NOT INITIAL.
        zcl_osd_v4_query=>fail( |Action { is_action-name } takes its parameters in the request body| ).
      ENDIF.
      body_parameters( EXPORTING iv_body = iv_body is_action = is_action CHANGING ct_parameters = lt_parameters ).
    ENDIF.
    rs_response = execute( is_action = is_action it_parameters = lt_parameters io_model = io_model
      io_dpc = io_dpc iv_service_url = iv_service_url ).
  ENDMETHOD.

  METHOD execute.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lr_data TYPE REF TO data.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA lv_kind TYPE c LENGTH 1.
    DATA lv_rows TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_type TYPE string.
    FIELD-SYMBOLS <lv_data> TYPE any.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.
    FIELD-SYMBOLS <ls_row> TYPE any.
    CREATE OBJECT lo_context.
    lo_context->mv_entity_set = is_action-return_entity_set.
    lo_context->mv_entity_type = is_action-return_entity_type.
    io_dpc->execute_action( EXPORTING iv_action_name = is_action-name it_parameter = it_parameters
      io_tech_request_context = lo_context IMPORTING er_data = lr_data ).
    rs_response-status = 200.
    rs_response-content_type = 'application/json;odata.metadata=minimal'.
    IF lr_data IS NOT BOUND.
      rs_response-status = 204.
      CLEAR rs_response-content_type.
      RETURN.
    ENDIF.
    IF is_action-return_entity_set IS NOT INITIAL.
      READ TABLE io_model->ms_service-entity_sets INTO ls_set WITH KEY name = is_action-return_entity_set.
    ELSEIF is_action-return_entity_type IS NOT INITIAL.
      READ TABLE io_model->ms_service-entity_sets INTO ls_set WITH KEY entity_type = is_action-return_entity_type.
    ENDIF.
    ASSIGN lr_data->* TO <lv_data>.
    DESCRIBE FIELD <lv_data> TYPE lv_kind.
    IF lv_kind = 'h'.
      ASSIGN lr_data->* TO <lt_rows>.
      IF ls_set-name IS INITIAL.
        zcl_osd_v4_query=>fail( iv_text = |{ is_action-name }: a collection of complex or primitive values is not implemented|
          iv_status = 501 ).
      ENDIF.
      LOOP AT <lt_rows> ASSIGNING <ls_row>.
        lv_rows = lv_rows && lv_sep && zcl_osd_v4_json=>entity( is_data = <ls_row> is_set = ls_set io_model = io_model ).
        lv_sep = ','.
      ENDLOOP.
      rs_response-body = '{"@odata.context":' && zcl_osd_v4_json=>quote( |{ iv_service_url }/$metadata#{ ls_set-name }| ) &&
        ',"value":[' && lv_rows && ']}'.
    ELSEIF lv_kind = 'u' OR lv_kind = 'v'.
      IF ls_set-name IS NOT INITIAL.
        rs_response-body = zcl_osd_v4_write=>representation( is_data = <lv_data> is_set = ls_set io_model = io_model
          iv_service_url = iv_service_url ).
      ELSEIF is_action-return_complex_type IS NOT INITIAL.
        rs_response-body = zcl_osd_v4_json=>document(
          iv_context = |{ iv_service_url }/$metadata#{ io_model->ms_service-namespace }.{ is_action-return_complex_type }|
          iv_entity = complex_json( is_data = <lv_data> iv_type = is_action-return_complex_type io_model = io_model ) ).
      ELSE.
        zcl_osd_v4_query=>fail( iv_text = |{ is_action-name } answered a structure the model does not type| iv_status = 501 ).
      ENDIF.
    ELSE.
* a primitive: {"@odata.context":"...#Edm.Int32","value":3}
      lv_type = zcl_osd_v4_json=>type_of( <lv_data> ).
      rs_response-body = '{"@odata.context":' && zcl_osd_v4_json=>quote( |{ iv_service_url }/$metadata#{ lv_type }| ) &&
        ',"value":' && zcl_osd_v4_json=>value( iv_value = <lv_data> iv_type = lv_type ) && '}'.
    ENDIF.
  ENDMETHOD.

  METHOD complex_json.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_fields TYPE string.
    DATA lv_sep TYPE string.
    FIELD-SYMBOLS <lv_value> TYPE any.
    LOOP AT io_model->mt_complex INTO ls_info WHERE entity_type = iv_type.
      ASSIGN COMPONENT ls_info-fieldname OF STRUCTURE is_data TO <lv_value>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_fields = lv_fields && lv_sep && zcl_osd_v4_json=>quote( ls_info-name ) && ':' &&
        zcl_osd_v4_json=>value( iv_value = <lv_value> iv_type = ls_info-edm_type ).
      lv_sep = ','.
    ENDLOOP.
    rv_json = '{' && lv_fields && '}'.
  ENDMETHOD.
ENDCLASS.
