CLASS zcl_osd_v4_sticky DEFINITION PUBLIC CREATE PUBLIC.
* Sticky-session editing on the V4 facade, the non-draft way Fiori Elements
* V4 edits and creates (SAP Session vocabulary, StickySessionSupported:
* https://github.com/SAP/odata-vocabularies/blob/main/vocabularies/Session.md).
* Fiori Elements V4 templates Edit, Save and the list report's Create only
* for a draft or a sticky-session entity set, so a plain SEGW service gets
* this from the facade, not from its DPC.
*
* Offered for an entity set whose entity type the model marks with
* Session.StickySessionSupported (stg-compile writes that marker for
* `sticky: true` in a YAML annotations block), which the model lets update
* and whose entity type has an ETag (set_as_etag): the ETag is how Save
* notices that somebody changed the entity while the session held its copy.
*
* EditAction reads the entity through GET_ENTITY into a buffer of the
* session (SAP-ContextId); PATCH/PUT and GET of that entity in the session
* work on the buffer; SaveAction writes it through UPDATE_ENTITY after
* comparing the ETag taken at Edit with the current one (412 if it moved);
* NewAction (bound to the collection, the key properties as parameters)
* starts a buffer that SaveAction writes through CREATE_ENTITY;
* DiscardAction (unbound) drops the session's buffers. No enqueue lock is
* taken: concurrency is optimistic, by ETag, as on a single write.
* A session idle for longer than GV_IDLE seconds is dropped (announced as
* SAP-Http-Session-Timeout, so the UI5 model keeps a live one alive); at
* most GV_MAX sessions hold buffers, a new one evicts the least recently
* used. The copy keeps the ETag its Edit/New started from until Save; PATCH
* and Save take If-Match with exactly that one (428 without, 412 otherwise),
* and Save answers the new ETag. A write naming an ended session is 410.
  PUBLIC SECTION.
    CONSTANTS gc_edit TYPE string VALUE 'OsdStickyEdit'.
    CONSTANTS gc_save TYPE string VALUE 'OsdStickySave'.
    CONSTANTS gc_new TYPE string VALUE 'OsdStickyNew'.
    CONSTANTS gc_discard TYPE string VALUE 'OsdStickyDiscard'.
* how long a session may stay idle, and how many may hold buffers at once;
* configure( ) changes both (tests, hosts)
    CLASS-METHODS configure IMPORTING iv_idle_seconds TYPE i iv_max_sessions TYPE i.
* a request in a session keeps it alive; every call first drops idle sessions
    CLASS-METHODS touch IMPORTING it_headers TYPE tihttpnvp.
    CLASS-METHODS offered IMPORTING io_model TYPE REF TO zcl_osd_v4_model
      is_set TYPE zcl_stg_model_info=>ty_entity_set RETURNING VALUE(rv_offered) TYPE abap_bool.
    CLASS-METHODS actions_xml IMPORTING io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS imports_xml IMPORTING io_model TYPE REF TO zcl_osd_v4_model RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS set_annotation IMPORTING io_model TYPE REF TO zcl_osd_v4_model
      is_set TYPE zcl_stg_model_info=>ty_entity_set RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS context_id IMPORTING it_headers TYPE tihttpnvp RETURNING VALUE(rv_id) TYPE string.
* the session's copy of an entity, unbound when the request is in no session
* or the session does not hold that entity
    CLASS-METHODS buffered IMPORTING it_headers TYPE tihttpnvp iv_service TYPE string iv_set TYPE string
      it_keys TYPE /iwbep/t_mgw_name_value_pair RETURNING VALUE(rr_data) TYPE REF TO data.
    CLASS-METHODS action IMPORTING iv_action TYPE string io_query TYPE REF TO zcl_osd_v4_query
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime iv_service_url TYPE string
      iv_body TYPE string it_headers TYPE tihttpnvp
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    CLASS-METHODS discard IMPORTING it_headers TYPE tihttpnvp
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    CLASS-METHODS patch IMPORTING ir_buffer TYPE REF TO data iv_method TYPE string
      io_model TYPE REF TO zcl_osd_v4_model is_set TYPE zcl_stg_model_info=>ty_entity_set
      iv_service_url TYPE string iv_body TYPE string it_headers TYPE tihttpnvp
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
    TYPES: BEGIN OF ty_entry,
             context TYPE string,
             service TYPE string,
             set     TYPE string,
             key     TYPE string,
             is_new  TYPE abap_bool,
* the ETag the entity had when Edit read it; Save compares
             etag    TYPE string,
             data    TYPE REF TO data,
* seconds since 1970 of the last request in the session
             touched TYPE i,
           END OF ty_entry.
    TYPES ty_entries TYPE STANDARD TABLE OF ty_entry WITH DEFAULT KEY.
* the buffers as they are, by value: what an atomicity group that fails
* gives back (a $batch's rollback does not reach class data)
    CLASS-METHODS snapshot RETURNING VALUE(rt_entries) TYPE ty_entries.
* the ETag a session's copy carries: the one its Edit or New started from
    CLASS-METHODS held IMPORTING ir_buffer TYPE REF TO data RETURNING VALUE(rv_etag) TYPE string.
* a JSON entity with the ETag computed from its values replaced by the held one
    CLASS-METHODS stamp IMPORTING iv_json TYPE string iv_computed TYPE string iv_held TYPE string
      RETURNING VALUE(rv_json) TYPE string.
* a write in a request that names a session (SAP-ContextId) to an entity the
* session does not hold is never written through: 410 when the session has
* ended (expired, evicted, saved or discarded), 400 when it is alive and
* the entity was not started with Edit
    CLASS-METHODS refuse IMPORTING it_headers TYPE tihttpnvp is_set TYPE zcl_stg_model_info=>ty_entity_set
      RAISING zcx_stg_error.
    CLASS-METHODS restore IMPORTING it_entries TYPE ty_entries.
  PRIVATE SECTION.
    CLASS-DATA gt_entries TYPE ty_entries.
    CLASS-DATA gv_counter TYPE i.
    CLASS-DATA gv_idle TYPE i VALUE 900.
    CLASS-DATA gv_max TYPE i VALUE 50.
    CLASS-METHODS now RETURNING VALUE(rv_seconds) TYPE i.
    CLASS-METHODS admit IMPORTING iv_context TYPE string.
    CLASS-METHODS precondition IMPORTING iv_held TYPE string it_headers TYPE tihttpnvp RAISING zcx_stg_error.
    CLASS-METHODS matches IMPORTING iv_if_match TYPE string iv_tag TYPE string RETURNING VALUE(rv_match) TYPE abap_bool.
    CLASS-METHODS key_text IMPORTING it_keys TYPE /iwbep/t_mgw_name_value_pair RETURNING VALUE(rv_key) TYPE string.
    CLASS-METHODS row_keys IMPORTING is_set TYPE zcl_stg_model_info=>ty_entity_set is_row TYPE any
      RETURNING VALUE(rt_keys) TYPE /iwbep/t_mgw_name_value_pair.
    CLASS-METHODS answer IMPORTING ir_data TYPE REF TO data io_model TYPE REF TO zcl_osd_v4_model
      is_set TYPE zcl_stg_model_info=>ty_entity_set iv_service_url TYPE string iv_context TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    CLASS-METHODS template IMPORTING io_dpc TYPE REF TO /iwbep/if_mgw_appl_srv_runtime
      io_query TYPE REF TO zcl_osd_v4_query is_set TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING VALUE(rr_row) TYPE REF TO data
      RAISING zcx_stg_error /iwbep/cx_mgw_base_exception.
ENDCLASS.

CLASS zcl_osd_v4_sticky IMPLEMENTATION.
  METHOD offered.
    DATA lv_line TYPE string.
    DATA lv_target TYPE string.
    IF is_set-updatable = abap_false OR is_set-is_media = abap_true
        OR io_model->has_etag( is_set-entity_type ) = abap_false.
      RETURN.
    ENDIF.
* the model asks for it: Session.StickySessionSupported on the entity type
    lv_target = |Target="{ io_model->ms_service-namespace }.{ is_set-entity_type }"|.
    LOOP AT io_model->mt_vocabulary INTO lv_line.
      IF lv_line CS lv_target AND lv_line CS 'com.sap.vocabularies.Session.v1.StickySessionSupported'.
        rv_offered = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD snapshot.
    DATA ls_entry TYPE ty_entry.
    DATA lr_copy TYPE REF TO data.
    FIELD-SYMBOLS <ls_from> TYPE any.
    FIELD-SYMBOLS <ls_to> TYPE any.
    LOOP AT gt_entries INTO ls_entry.
      ASSIGN ls_entry-data->* TO <ls_from>.
      CREATE DATA lr_copy LIKE <ls_from>.
      ASSIGN lr_copy->* TO <ls_to>.
      <ls_to> = <ls_from>.
      ls_entry-data = lr_copy.
      APPEND ls_entry TO rt_entries.
    ENDLOOP.
  ENDMETHOD.

  METHOD held.
    DATA ls_entry TYPE ty_entry.
    LOOP AT gt_entries INTO ls_entry WHERE data = ir_buffer.
      rv_etag = ls_entry-etag.
      RETURN.
    ENDLOOP.
  ENDMETHOD.

  METHOD stamp.
    rv_json = iv_json.
    IF iv_computed IS NOT INITIAL AND iv_held IS NOT INITIAL AND iv_computed <> iv_held.
      REPLACE FIRST OCCURRENCE OF '"@odata.etag":' && zcl_osd_v4_json=>quote( iv_computed )
        IN rv_json WITH '"@odata.etag":' && zcl_osd_v4_json=>quote( iv_held ).
    ENDIF.
  ENDMETHOD.

  METHOD refuse.
    DATA lv_context TYPE string.
    lv_context = context_id( it_headers ).
    READ TABLE gt_entries WITH KEY context = lv_context TRANSPORTING NO FIELDS.
    IF sy-subrc <> 0.
      zcl_osd_v4_query=>fail( iv_text = |The sticky session { lv_context } has ended (expired, evicted, saved or | &&
        |discarded); nothing was written. Start again with { gc_edit }| iv_status = 410 ).
    ENDIF.
    zcl_osd_v4_query=>fail( |The sticky session { lv_context } does not hold this entity of { is_set-name }; | &&
      |call { gc_edit } first. Nothing was written| ).
  ENDMETHOD.

  METHOD precondition.
    DATA lv_if_match TYPE string.
    IF iv_held IS INITIAL.
      RETURN.
    ENDIF.
    lv_if_match = zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'if-match' ).
    IF lv_if_match IS INITIAL.
      zcl_osd_v4_query=>fail( iv_text = 'The session copy has an ETag: send If-Match with it' iv_status = 428 ).
    ENDIF.
    IF matches( iv_if_match = lv_if_match iv_tag = iv_held ) = abap_false.
      zcl_osd_v4_query=>fail( iv_text = 'If-Match does not name the ETag the session holds for the entity' iv_status = 412 ).
    ENDIF.
  ENDMETHOD.

  METHOD restore.
    gt_entries = it_entries.
  ENDMETHOD.

  METHOD configure.
    gv_idle = iv_idle_seconds.
    gv_max = iv_max_sessions.
  ENDMETHOD.

  METHOD now.
    DATA lv_stamp TYPE timestamp.
    DATA lv_text TYPE string.
    DATA lv_date TYPE d.
    DATA lv_time TYPE t.
* both operands typed d: date minus date is a day count. Against a character
* literal the literal counts as the number 19700101 and the product
* overflows TYPE i (it did under the CI's pinned transpiler).
    DATA lv_epoch TYPE d VALUE '19700101'.
    GET TIME STAMP FIELD lv_stamp.
    lv_text = |{ lv_stamp }|.
    lv_date = lv_text(8).
    lv_time = lv_text+8(6).
    rv_seconds = ( lv_date - lv_epoch ) * 86400 + lv_time(2) * 3600 + lv_time+2(2) * 60 + lv_time+4(2).
  ENDMETHOD.

  METHOD touch.
    DATA lv_now TYPE i.
    DATA lv_limit TYPE i.
    DATA lv_context TYPE string.
    FIELD-SYMBOLS <ls_entry> TYPE ty_entry.
    lv_now = now( ).
    lv_limit = lv_now - gv_idle.
    DELETE gt_entries WHERE touched < lv_limit.
    lv_context = context_id( it_headers ).
    IF lv_context IS INITIAL.
      RETURN.
    ENDIF.
    LOOP AT gt_entries ASSIGNING <ls_entry> WHERE context = lv_context.
      <ls_entry>-touched = lv_now.
    ENDLOOP.
  ENDMETHOD.

  METHOD admit.
* a new session past the cap evicts the one least recently used
    TYPES: BEGIN OF ty_last,
             context TYPE string,
             touched TYPE i,
           END OF ty_last.
    DATA lt_last TYPE STANDARD TABLE OF ty_last WITH DEFAULT KEY.
    DATA ls_last TYPE ty_last.
    DATA ls_entry TYPE ty_entry.
    DATA ls_oldest TYPE ty_last.
    FIELD-SYMBOLS <ls_last> TYPE ty_last.
    READ TABLE gt_entries WITH KEY context = iv_context TRANSPORTING NO FIELDS.
    IF sy-subrc = 0.
      RETURN.
    ENDIF.
    DO.
      CLEAR lt_last.
      LOOP AT gt_entries INTO ls_entry.
        READ TABLE lt_last ASSIGNING <ls_last> WITH KEY context = ls_entry-context.
        IF sy-subrc <> 0.
          ls_last-context = ls_entry-context.
          ls_last-touched = ls_entry-touched.
          APPEND ls_last TO lt_last.
        ELSEIF ls_entry-touched > <ls_last>-touched.
          <ls_last>-touched = ls_entry-touched.
        ENDIF.
      ENDLOOP.
      IF lines( lt_last ) < gv_max OR lines( lt_last ) = 0.
        RETURN.
      ENDIF.
      SORT lt_last BY touched ASCENDING.
      READ TABLE lt_last INTO ls_oldest INDEX 1.
      DELETE gt_entries WHERE context = ls_oldest-context.
    ENDDO.
  ENDMETHOD.

  METHOD matches.
    DATA lt_tags TYPE string_table.
    DATA lv_tag TYPE string.
    DATA lv_want TYPE string.
    lv_want = iv_tag.
    IF lv_want CP 'W/*'.
      lv_want = substring( val = lv_want off = 2 ).
    ENDIF.
    SPLIT iv_if_match AT ',' INTO TABLE lt_tags.
    LOOP AT lt_tags INTO lv_tag.
      CONDENSE lv_tag.
      IF lv_tag CP 'W/*'.
        lv_tag = substring( val = lv_tag off = 2 ).
      ENDIF.
      IF lv_tag = '*' OR ( lv_want IS NOT INITIAL AND lv_tag = lv_want ).
        rv_match = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD actions_xml.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lt_done TYPE string_table.
    DATA lv_type TYPE string.
    DATA lv_params TYPE string.
    LOOP AT io_model->ms_service-entity_sets INTO ls_set.
      IF offered( io_model = io_model is_set = ls_set ) = abap_false.
        CONTINUE.
      ENDIF.
      READ TABLE lt_done WITH KEY table_line = ls_set-entity_type TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      APPEND ls_set-entity_type TO lt_done.
      lv_type = zcl_osd_v4_model=>xml( |{ io_model->ms_service-namespace }.{ ls_set-entity_type }| ).
      rv_xml = rv_xml &&
        |<Action Name="{ gc_edit }" IsBound="true" EntitySetPath="_it"><Parameter Name="_it" Type="{ lv_type }" Nullable="false"/>| &&
        |<ReturnType Type="{ lv_type }" Nullable="false"/></Action>| &&
        |<Action Name="{ gc_save }" IsBound="true" EntitySetPath="_it"><Parameter Name="_it" Type="{ lv_type }" Nullable="false"/>| &&
        |<ReturnType Type="{ lv_type }" Nullable="false"/></Action>|.
      IF ls_set-creatable = abap_true.
* the key is asked for when the entity is started (Fiori Elements shows the
* parameters of a NewAction in a dialog)
        CLEAR lv_params.
        LOOP AT ls_set-properties INTO ls_prop WHERE is_key = abap_true.
          ls_info = io_model->property( iv_type = ls_set-entity_type iv_name = ls_prop-name ).
          lv_params = lv_params && |<Parameter Name="{ zcl_osd_v4_model=>xml( ls_prop-name ) }" Type="{ ls_info-edm_type }"|
            && | Nullable="false"{ ls_info-facets }/>|.
        ENDLOOP.
        rv_xml = rv_xml &&
          |<Action Name="{ gc_new }" IsBound="true" EntitySetPath="_it"><Parameter Name="_it" Type="Collection({ lv_type })" Nullable="false"/>| &&
          lv_params && |<ReturnType Type="{ lv_type }" Nullable="false"/></Action>|.
      ENDIF.
    ENDLOOP.
    IF rv_xml IS NOT INITIAL.
      rv_xml = rv_xml && |<Action Name="{ gc_discard }"/>|.
    ENDIF.
  ENDMETHOD.

  METHOD imports_xml.
    DATA ls_set TYPE zcl_stg_model_info=>ty_entity_set.
    LOOP AT io_model->ms_service-entity_sets INTO ls_set.
      IF offered( io_model = io_model is_set = ls_set ) = abap_true.
        rv_xml = |<ActionImport Name="{ gc_discard }" Action="{ zcl_osd_v4_model=>xml( io_model->ms_service-namespace ) }.{ gc_discard }"/>|.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_annotation.
    DATA lv_ns TYPE string.
    IF offered( io_model = io_model is_set = is_set ) = abap_false.
      RETURN.
    ENDIF.
    lv_ns = zcl_osd_v4_model=>xml( io_model->ms_service-namespace ).
    rv_xml = '<Annotation Term="com.sap.vocabularies.Session.v1.StickySessionSupported">' &&
      '<Record Type="com.sap.vocabularies.Session.v1.StickySessionSupportedType">'.
    IF is_set-creatable = abap_true.
      rv_xml = rv_xml && |<PropertyValue Property="NewAction" String="{ lv_ns }.{ gc_new }"/>|.
    ENDIF.
    rv_xml = rv_xml &&
      |<PropertyValue Property="EditAction" String="{ lv_ns }.{ gc_edit }"/>| &&
      |<PropertyValue Property="SaveAction" String="{ lv_ns }.{ gc_save }"/>| &&
      |<PropertyValue Property="DiscardAction" String="{ gc_discard }"/>| &&
      '</Record></Annotation>'.
  ENDMETHOD.

  METHOD context_id.
    rv_id = zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'sap-contextid' ).
  ENDMETHOD.

  METHOD key_text.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lt_keys TYPE /iwbep/t_mgw_name_value_pair.
    lt_keys = it_keys.
    SORT lt_keys BY name.
    LOOP AT lt_keys INTO ls_key.
      rv_key = |{ rv_key }{ ls_key-name }={ ls_key-value };|.
    ENDLOOP.
  ENDMETHOD.

  METHOD row_keys.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    FIELD-SYMBOLS <lv_key> TYPE any.
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE is_row TO <lv_key>.
      IF sy-subrc = 0.
        ls_key-name = ls_prop-name.
        ls_key-value = <lv_key>.
        APPEND ls_key TO rt_keys.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD buffered.
    DATA ls_entry TYPE ty_entry.
    DATA lv_context TYPE string.
    touch( it_headers ).
    lv_context = context_id( it_headers ).
    IF lv_context IS INITIAL.
      RETURN.
    ENDIF.
    READ TABLE gt_entries INTO ls_entry WITH KEY context = lv_context service = iv_service
      set = iv_set key = key_text( it_keys ).
    IF sy-subrc = 0.
      rr_data = ls_entry-data.
    ENDIF.
  ENDMETHOD.

  METHOD answer.
    FIELD-SYMBOLS <ls_data> TYPE any.
    DATA lv_etag TYPE string.
    ASSIGN ir_data->* TO <ls_data>.
    rs_response-status = 200.
    rs_response-content_type = 'application/json;odata.metadata=minimal'.
    rs_response-body = zcl_osd_v4_write=>representation( is_data = <ls_data> is_set = is_set io_model = io_model
      iv_service_url = iv_service_url ).
    lv_etag = zcl_osd_v4_json=>etag( is_data = <ls_data> is_set = is_set io_model = io_model ).
    IF lv_etag IS NOT INITIAL.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
    ENDIF.
    IF iv_context IS NOT INITIAL.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'SAP-ContextId' iv_value = iv_context
        CHANGING ct_headers = rs_response-headers ).
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'SAP-Http-Session-Timeout' iv_value = |{ gv_idle }|
        CHANGING ct_headers = rs_response-headers ).
    ENDIF.
  ENDMETHOD.

  METHOD template.
* The entity's ABAP shape is the DPC's own: the line type of what its
* GET_ENTITYSET hands back (the MPC's bound structure name is not public in
* the model library).
    DATA lr_rows TYPE REF TO data.
    DATA ls_paging TYPE /iwbep/s_mgw_paging.
    DATA lt_none TYPE /iwbep/t_mgw_name_value_pair.
    FIELD-SYMBOLS <lt_rows> TYPE ANY TABLE.
    ls_paging-top = 1.
    io_dpc->get_entityset( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
      iv_source_name = '' it_filter_select_options = io_query->mo_context->mt_filter is_paging = ls_paging
      it_key_tab = lt_none it_navigation_path = io_query->mo_context->mt_navigation_path
      it_order = io_query->mo_context->get_sorting_order( ) iv_filter_string = ''
      iv_search_string = '' io_tech_request_context = io_query->mo_context IMPORTING er_entityset = lr_rows ).
    IF lr_rows IS NOT BOUND.
      zcl_osd_v4_query=>fail( iv_text = |{ is_set-name } gives no row type to start a new entity from| iv_status = 501 ).
    ENDIF.
    ASSIGN lr_rows->* TO <lt_rows>.
    CREATE DATA rr_row LIKE LINE OF <lt_rows>.
  ENDMETHOD.

  METHOD action.
    DATA lv_context TYPE string.
    DATA lv_name TYPE string.
    DATA lv_body TYPE string.
    DATA lv_service TYPE string.
    DATA lv_key TYPE string.
    DATA lr_current TYPE REF TO data.
    DATA lr_entity TYPE REF TO data.
    DATA lr_row TYPE REF TO data.
    DATA lt_values TYPE zcl_osd_v4_provider=>ty_values.
    DATA lt_keys TYPE /iwbep/t_mgw_name_value_pair.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA ls_entry TYPE ty_entry.
    DATA lv_stamp TYPE timestamp.
    DATA lv_if_match TYPE string.
    DATA lo_provider TYPE REF TO zcl_osd_v4_provider.
    DATA lo_context TYPE REF TO zcl_stg_request_context.
    DATA lx_busi TYPE REF TO /iwbep/cx_mgw_busi_exception.
    FIELD-SYMBOLS <ls_row> TYPE any.
    FIELD-SYMBOLS <ls_current> TYPE any.

    lv_service = io_model->ms_service-name.
    lv_name = iv_action.
    IF lv_name CS '.'.
      lv_name = substring_after( val = lv_name sub = |{ io_model->ms_service-namespace }.| ).
    ENDIF.
    IF offered( io_model = io_model is_set = is_set ) = abap_false OR
        ( lv_name <> gc_edit AND lv_name <> gc_save AND lv_name <> gc_new ).
      zcl_osd_v4_query=>fail( iv_text = |Action { iv_action } is not implemented for { is_set-name }| iv_status = 501 ).
    ENDIF.
    lo_context = io_query->mo_context.
    IF ( lv_name = gc_new AND io_query->ms_request-key_string IS NOT INITIAL )
        OR ( lv_name <> gc_new AND io_query->ms_request-key_string IS INITIAL ).
      zcl_osd_v4_query=>fail( |{ lv_name } is bound to { is_set-name }, { gc_edit } and { gc_save } to one of its entities| ).
    ENDIF.
    touch( it_headers ).
    lv_context = context_id( it_headers ).
    IF lv_context IS INITIAL.
      gv_counter = gv_counter + 1.
      GET TIME STAMP FIELD lv_stamp.
      lv_context = |osd-{ lv_stamp }-{ gv_counter }|.
      CONDENSE lv_context NO-GAPS.
    ENDIF.

    CASE lv_name.
      WHEN gc_edit.
        lr_current = zcl_osd_v4_write=>read( io_dpc = io_dpc io_context = lo_context is_set = is_set ).
        IF lr_current IS NOT BOUND.
          zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
        ENDIF.
        IF zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'if-match' ) IS NOT INITIAL.
          zcl_osd_v4_write=>precondition( is_set = is_set io_model = io_model ir_current = lr_current it_headers = it_headers ).
        ENDIF.
        ASSIGN lr_current->* TO <ls_current>.
        lv_key = key_text( lo_context->mt_key_tab ).
        DELETE gt_entries WHERE context = lv_context AND service = lv_service AND set = is_set-name AND key = lv_key.
        ls_entry-context = lv_context.
        ls_entry-service = lv_service.
        ls_entry-set = is_set-name.
        ls_entry-key = lv_key.
        ls_entry-etag = zcl_osd_v4_json=>etag( is_data = <ls_current> is_set = is_set io_model = io_model ).
        ls_entry-data = lr_current.
        ls_entry-touched = now( ).
        admit( lv_context ).
        APPEND ls_entry TO gt_entries.
        rs_response = answer( ir_data = lr_current io_model = io_model is_set = is_set
          iv_service_url = iv_service_url iv_context = lv_context ).

      WHEN gc_new.
        lv_body = iv_body.
        IF lv_body IS INITIAL.
          lv_body = '{}'.
        ENDIF.
        lt_values = zcl_osd_v4_write=>values( iv_body = lv_body is_set = is_set io_model = io_model it_headers = it_headers ).
        lr_row = template( io_dpc = io_dpc io_query = io_query is_set = is_set ).
        ASSIGN lr_row->* TO <ls_row>.
        CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set.
        lo_provider->/iwbep/if_mgw_entry_provider~read_entry_data( IMPORTING es_data = <ls_row> ).
        lt_keys = row_keys( is_set = is_set is_row = <ls_row> ).
        LOOP AT lt_keys INTO ls_key WHERE value IS INITIAL.
          zcl_osd_v4_query=>fail( |{ gc_new } needs the key property { ls_key-name }| ).
        ENDLOOP.
* an entity that exists already cannot be started again
        lo_context->mt_key_tab = lt_keys.
        TRY.
            lr_current = zcl_osd_v4_write=>read( io_dpc = io_dpc io_context = lo_context is_set = is_set ).
          CATCH /iwbep/cx_mgw_busi_exception INTO lx_busi.
            CLEAR lr_current.
        ENDTRY.
        IF lr_current IS BOUND.
          zcl_osd_v4_query=>fail( |{ is_set-name }({ key_text( lt_keys ) }) exists already| ).
        ENDIF.
        lv_key = key_text( lt_keys ).
        DELETE gt_entries WHERE context = lv_context AND service = lv_service AND set = is_set-name AND key = lv_key.
        ls_entry-context = lv_context.
        ls_entry-service = lv_service.
        ls_entry-set = is_set-name.
        ls_entry-key = lv_key.
        ls_entry-is_new = abap_true.
        ls_entry-etag = zcl_osd_v4_json=>etag( is_data = <ls_row> is_set = is_set io_model = io_model ).
        ls_entry-data = lr_row.
        ls_entry-touched = now( ).
        admit( lv_context ).
        APPEND ls_entry TO gt_entries.
        rs_response = answer( ir_data = lr_row io_model = io_model is_set = is_set
          iv_service_url = iv_service_url iv_context = lv_context ).

      WHEN gc_save.
        lv_key = key_text( lo_context->mt_key_tab ).
        READ TABLE gt_entries INTO ls_entry WITH KEY context = lv_context service = lv_service set = is_set-name key = lv_key.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |No sticky session holds { is_set-name }({ lv_key }); call { gc_edit } first| ).
        ENDIF.
* The client's tag must be the one the session holds for its copy: the
* ETag the entity had when Edit (or New) started the session. Buffered
* changes do not move it -- the tag names the version the session works on,
* not each keystroke -- so a PATCH answered while Save is already on its way
* leaves the client's tag current. Save gives the new ETag of what it wrote.
* Missing: 428; another tag: 412, nothing written (OData 4.01 Part 1, 8.2.4).
        precondition( iv_held = ls_entry-etag it_headers = it_headers ).
        CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set ir_base = ls_entry-data.
        IF ls_entry-is_new = abap_true.
          io_dpc->create_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
            iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
            it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
            IMPORTING er_entity = lr_entity ).
        ELSE.
          zcl_osd_v4_write=>lock( iv_service = io_model->ms_service-name is_set = is_set it_key_tab = lo_context->mt_key_tab ).
          lr_current = zcl_osd_v4_write=>read( io_dpc = io_dpc io_context = lo_context is_set = is_set ).
          IF lr_current IS NOT BOUND.
            zcl_osd_v4_query=>fail( iv_text = 'Entity not found' iv_status = 404 ).
          ENDIF.
          ASSIGN lr_current->* TO <ls_current>.
          IF zcl_osd_v4_json=>etag( is_data = <ls_current> is_set = is_set io_model = io_model ) <> ls_entry-etag.
            zcl_osd_v4_query=>fail( iv_text = |{ is_set-name }({ lv_key }) was changed since { gc_edit }| iv_status = 412 ).
          ENDIF.
          io_dpc->update_entity( EXPORTING iv_entity_name = is_set-entity_type iv_entity_set_name = is_set-name
            iv_source_name = '' io_data_provider = lo_provider it_key_tab = lo_context->mt_key_tab
            it_navigation_path = lo_context->mt_navigation_path io_tech_request_context = lo_context
            IMPORTING er_entity = lr_entity ).
        ENDIF.
        DELETE gt_entries WHERE context = lv_context AND service = lv_service AND set = is_set-name AND key = lv_key.
        lr_entity = zcl_osd_v4_write=>read( io_dpc = io_dpc io_context = lo_context is_set = is_set ).
        IF lr_entity IS NOT BOUND.
          lr_entity = ls_entry-data.
        ENDIF.
        rs_response = answer( ir_data = lr_entity io_model = io_model is_set = is_set
          iv_service_url = iv_service_url iv_context = lv_context ).
    ENDCASE.
  ENDMETHOD.

  METHOD discard.
    DATA lv_context TYPE string.
    lv_context = context_id( it_headers ).
    IF lv_context IS NOT INITIAL.
      DELETE gt_entries WHERE context = lv_context.
    ENDIF.
    rs_response-status = 204.
  ENDMETHOD.

  METHOD patch.
    DATA lt_values TYPE zcl_osd_v4_provider=>ty_values.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA lr_copy TYPE REF TO data.
    DATA lo_provider TYPE REF TO zcl_osd_v4_provider.
    DATA lv_etag TYPE string.
    DATA lv_prefer TYPE string.
    FIELD-SYMBOLS <ls_buffer> TYPE any.
    FIELD-SYMBOLS <ls_copy> TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to> TYPE any.

    lt_values = zcl_osd_v4_write=>values( iv_body = iv_body is_set = is_set io_model = io_model it_headers = it_headers ).
* the session's copy carries the ETag it was started with (see Save)
    lv_etag = held( ir_buffer ).
    precondition( iv_held = lv_etag it_headers = it_headers ).
* the key is the one the URL names
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      DELETE lt_values WHERE name = ls_prop-name.
    ENDLOOP.
* read_entry_data clears its target before it lays the base over it, so the
* result goes into a new structure and the session's copy stays the base
    ASSIGN ir_buffer->* TO <ls_buffer>.
    CREATE DATA lr_copy LIKE <ls_buffer>.
    ASSIGN lr_copy->* TO <ls_copy>.
* PATCH lays the body over the session's copy; PUT replaces it, so what the
* body leaves out becomes initial and only the key stays
    IF iv_method = 'PATCH'.
      CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set ir_base = ir_buffer.
    ELSE.
      CREATE OBJECT lo_provider EXPORTING it_values = lt_values is_set = is_set.
    ENDIF.
    lo_provider->/iwbep/if_mgw_entry_provider~read_entry_data( IMPORTING es_data = <ls_copy> ).
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE <ls_buffer> TO <lv_from>.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE <ls_copy> TO <lv_to>.
      IF <lv_from> IS ASSIGNED AND <lv_to> IS ASSIGNED.
        <lv_to> = <lv_from>.
      ENDIF.
      UNASSIGN <lv_from>.
      UNASSIGN <lv_to>.
    ENDLOOP.
    <ls_buffer> = <ls_copy>.

    rs_response-status = 204.
    IF lv_etag IS NOT INITIAL.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'ETag' iv_value = lv_etag CHANGING ct_headers = rs_response-headers ).
    ENDIF.
    lv_prefer = to_lower( zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'prefer' ) ).
    IF lv_prefer CS 'return=representation'.
      rs_response-status = 200.
      rs_response-content_type = 'application/json;odata.metadata=minimal'.
      rs_response-body = stamp( iv_json = zcl_osd_v4_write=>representation( is_data = <ls_buffer> is_set = is_set
        io_model = io_model iv_service_url = iv_service_url ) iv_computed = zcl_osd_v4_json=>etag( is_data = <ls_buffer>
        is_set = is_set io_model = io_model ) iv_held = lv_etag ).
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'return=representation'
        CHANGING ct_headers = rs_response-headers ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
