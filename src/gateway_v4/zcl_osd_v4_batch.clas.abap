CLASS zcl_osd_v4_batch DEFINITION PUBLIC CREATE PUBLIC.
* JSON $batch, OData JSON Format 4.01 s19: {"requests":[...]} in,
* {"responses":[...]} out. Each request runs through ZCL_OSD_V4_HTTP=>DISPATCH.
* An atomicityGroup is one LUW: a COMMIT WORK fences it off from what ran
* before, a failing member rolls the whole group back, and the group commits
* only when every member succeeded. A request outside a group is its own LUW,
* like a single request. dependsOn names earlier requests or groups; when one
* of them failed the request is not executed and answers 424. A url that
* starts with $<id> continues the Location of the entity request <id> created.
* Every request is processed, as JSON Format 4.01 s19.4 has it for a JSON
* batch; Prefer: odata.continue-on-error=false stops after the first failed
* request or group.
* A multipart/mixed batch (OData 4.01 Part 1, 11.7.7; what the UI5 V4 model
* sends) is read by the V2 parser ZCL_STG_BATCH into the same request list:
* a change set becomes an atomicity group, and the answer goes back as
* multipart, a change set as a nested multipart whose parts carry Content-ID,
* a failed change set as its one error response.
  PUBLIC SECTION.
    CLASS-METHODS handle IMPORTING iv_body TYPE string it_headers TYPE tihttpnvp OPTIONAL
      iv_service_path TYPE string iv_origin TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING zcx_stg_error.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_request,
             id      TYPE string,
             method  TYPE string,
             url     TYPE string,
             group   TYPE string,
             headers TYPE tihttpnvp,
             body    TYPE string,
             depends TYPE string_table,
* multipart: the part's MIME Content-ID, echoed on its response part
             content_id TYPE string,
           END OF ty_request.
    TYPES ty_requests TYPE STANDARD TABLE OF ty_request WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_result,
             id       TYPE string,
             group    TYPE string,
             response TYPE zcl_stg_dispatcher=>ty_response,
             content_id TYPE string,
           END OF ty_result.
    TYPES ty_results TYPE STANDARD TABLE OF ty_result WITH DEFAULT KEY.
    CLASS-METHODS parse IMPORTING iv_body TYPE string RETURNING VALUE(rt_requests) TYPE ty_requests
      RAISING zcx_stg_error.
    CLASS-METHODS validate IMPORTING it_requests TYPE ty_requests RAISING zcx_stg_error.
    CLASS-METHODS text IMPORTING iv_json TYPE string RETURNING VALUE(rv_text) TYPE string
      RAISING zcx_stg_error.
    CLASS-METHODS run_one IMPORTING is_request TYPE ty_request iv_url TYPE string
      iv_service_path TYPE string iv_origin TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    CLASS-METHODS error IMPORTING iv_status TYPE i iv_message TYPE string
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
* the continue-on-error preference: true unless it says false; ev_applied is
* what Preference-Applied echoes when the client asked
    CLASS-METHODS continuation IMPORTING iv_prefer TYPE string EXPORTING ev_applied TYPE string
      RETURNING VALUE(rv_continue) TYPE abap_bool.
    CLASS-METHODS result_json IMPORTING is_result TYPE ty_result RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS from_multipart IMPORTING iv_body TYPE string iv_content_type TYPE string
      RETURNING VALUE(rt_requests) TYPE ty_requests RAISING zcx_stg_error.
    CLASS-METHODS multipart IMPORTING it_results TYPE ty_results
      RETURNING VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.
    CLASS-METHODS http_part IMPORTING is_response TYPE zcl_stg_dispatcher=>ty_response iv_content_id TYPE string OPTIONAL
      RETURNING VALUE(rv_part) TYPE string.
    CLASS-DATA gv_counter TYPE i.
ENDCLASS.

CLASS zcl_osd_v4_batch IMPLEMENTATION.
  METHOD text.
    DATA lt_values TYPE tihttpnvp.
    DATA ls_value TYPE ihttpnvp.
    lt_values = zcl_stg_json=>parse_object( '{"v":' && iv_json && '}' ).
    READ TABLE lt_values INTO ls_value INDEX 1.
    rv_text = ls_value-value.
  ENDMETHOD.

  METHOD parse.
    DATA lt_values TYPE tihttpnvp.
    DATA lt_nested TYPE tihttpnvp.
    DATA lt_inner TYPE tihttpnvp.
    DATA lt_inner_nested TYPE tihttpnvp.
    DATA lt_headers TYPE tihttpnvp.
    DATA ls_pair TYPE ihttpnvp.
    DATA ls_header TYPE ihttpnvp.
    DATA lt_elements TYPE string_table.
    DATA lt_depends TYPE string_table.
    DATA lv_element TYPE string.
    DATA lv_depend TYPE string.
    DATA ls_request TYPE ty_request.
    DATA lo_json TYPE REF TO zif_ajson.
    DATA lt_strings TYPE string_table.
    DATA lv_member TYPE string.
    DATA lv_path TYPE string.
    DATA lv_index TYPE i.

    APPEND 'id' TO lt_strings.
    APPEND 'method' TO lt_strings.
    APPEND 'url' TO lt_strings.
    APPEND 'atomicityGroup' TO lt_strings.
    lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json = iv_body IMPORTING et_nested = lt_nested ).
* the V2 parser keeps text only; the kinds of the request members come from
* ajson, so a numeric id or a non-string url is refused, not coerced
    TRY.
        lo_json = zcl_ajson=>parse( iv_body ).
      CATCH zcx_ajson_error.
        zcl_osd_v4_query=>fail( 'The batch body is not valid JSON' ).
    ENDTRY.
    READ TABLE lt_nested INTO ls_pair WITH KEY name = 'requests'.
    IF sy-subrc <> 0.
      zcl_osd_v4_query=>fail( 'A JSON batch needs a "requests" array' ).
    ENDIF.
    lt_elements = zcl_stg_json=>parse_array( ls_pair-value ).
    LOOP AT lt_elements INTO lv_element.
      lv_index = sy-tabix.
      LOOP AT lt_strings INTO lv_member.
        lv_path = |/requests/{ lv_index }/{ lv_member }|.
        IF lo_json->exists( lv_path ) = abap_true
            AND lo_json->get_node_type( lv_path ) <> zif_ajson_types=>node_type-string.
          zcl_osd_v4_query=>fail( |Batch request { lv_index }: { lv_member } must be a string| ).
        ENDIF.
      ENDLOOP.
      lv_path = |/requests/{ lv_index }/dependsOn|.
      IF lo_json->exists( lv_path ) = abap_true
          AND lo_json->get_node_type( lv_path ) <> zif_ajson_types=>node_type-array.
        zcl_osd_v4_query=>fail( |Batch request { lv_index }: dependsOn must be an array| ).
      ENDIF.
      CLEAR ls_request.
      lt_inner = zcl_stg_json=>parse_object( EXPORTING iv_json = lv_element IMPORTING et_nested = lt_inner_nested ).
      LOOP AT lt_inner INTO ls_pair.
        CASE ls_pair-name.
          WHEN 'id'.
            ls_request-id = ls_pair-value.
          WHEN 'method'.
            ls_request-method = to_upper( ls_pair-value ).
          WHEN 'url'.
            ls_request-url = ls_pair-value.
          WHEN 'atomicityGroup'.
            ls_request-group = ls_pair-value.
          WHEN 'body'.
            IF ls_pair-value <> 'null'.
              ls_request-body = ls_pair-value.
            ENDIF.
        ENDCASE.
      ENDLOOP.
      LOOP AT lt_inner_nested INTO ls_pair.
        CASE ls_pair-name.
          WHEN 'headers'.
            lt_headers = zcl_stg_json=>parse_object( ls_pair-value ).
            LOOP AT lt_headers INTO ls_header.
              ls_header-name = to_lower( ls_header-name ).
              APPEND ls_header TO ls_request-headers.
            ENDLOOP.
          WHEN 'body'.
            ls_request-body = ls_pair-value.
          WHEN 'dependsOn'.
            lt_depends = zcl_stg_json=>parse_array( ls_pair-value ).
            LOOP AT lt_depends INTO lv_depend.
              APPEND text( lv_depend ) TO ls_request-depends.
            ENDLOOP.
        ENDCASE.
      ENDLOOP.
      IF ls_request-id IS INITIAL OR ls_request-method IS INITIAL OR ls_request-url IS INITIAL.
        zcl_osd_v4_query=>fail( 'Every batch request needs id, method and url' ).
      ENDIF.
      APPEND ls_request TO rt_requests.
    ENDLOOP.
  ENDMETHOD.

  METHOD validate.
    DATA ls_request TYPE ty_request.
    DATA lt_ids TYPE string_table.
    DATA lt_closed TYPE string_table.
    DATA lv_previous TYPE string.
    DATA lv_depend TYPE string.
    DATA ls_other TYPE ty_request.
    LOOP AT it_requests INTO ls_request.
      READ TABLE lt_ids WITH KEY table_line = ls_request-id TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        zcl_osd_v4_query=>fail( |Duplicate batch request id { ls_request-id }| ).
      ENDIF.
      IF ls_request-group <> lv_previous AND lv_previous IS NOT INITIAL.
        APPEND lv_previous TO lt_closed.
      ENDIF.
      IF ls_request-group IS NOT INITIAL AND ls_request-group <> lv_previous.
        READ TABLE lt_closed WITH KEY table_line = ls_request-group TRANSPORTING NO FIELDS.
        IF sy-subrc = 0.
          zcl_osd_v4_query=>fail( |The requests of atomicity group { ls_request-group } must be adjacent| ).
        ENDIF.
      ENDIF.
* dependsOn may name an earlier request or a group that has ended
      LOOP AT ls_request-depends INTO lv_depend.
        READ TABLE lt_ids WITH KEY table_line = lv_depend TRANSPORTING NO FIELDS.
        IF sy-subrc <> 0.
          READ TABLE lt_closed WITH KEY table_line = lv_depend TRANSPORTING NO FIELDS.
        ENDIF.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |Request { ls_request-id } depends on { lv_depend }, which is not an earlier request or group| ).
        ENDIF.
* JSON Format 4.01 s19.1: a request in another atomicity group is depended
* on through its group, which has to be listed as well
        READ TABLE it_requests INTO ls_other WITH KEY id = lv_depend.
        IF sy-subrc = 0 AND ls_other-group IS NOT INITIAL AND ls_other-group <> ls_request-group.
          READ TABLE ls_request-depends WITH KEY table_line = ls_other-group TRANSPORTING NO FIELDS.
          IF sy-subrc <> 0.
            zcl_osd_v4_query=>fail( |Request { ls_request-id } depends on { lv_depend } of atomicity group { ls_other-group }, but not on the group| ).
          ENDIF.
        ENDIF.
      ENDLOOP.
* JSON Format 4.01 s19.1: a url that starts with $<id> depends on <id>, so
* <id> has to be in dependsOn (and with it, the cross-group rule above)
      IF ls_request-url(1) = '$'.
        FIND REGEX '^\$([^/?]+)' IN ls_request-url SUBMATCHES lv_depend.
        READ TABLE ls_request-depends WITH KEY table_line = lv_depend TRANSPORTING NO FIELDS.
        IF sy-subrc <> 0.
          zcl_osd_v4_query=>fail( |Request { ls_request-id } refers to ${ lv_depend } without depending on it| ).
        ENDIF.
      ENDIF.
      APPEND ls_request-id TO lt_ids.
      lv_previous = ls_request-group.
    ENDLOOP.
    LOOP AT it_requests INTO ls_request WHERE group IS NOT INITIAL.
      READ TABLE lt_ids WITH KEY table_line = ls_request-group TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        zcl_osd_v4_query=>fail( |Atomicity group { ls_request-group } has the id of a request| ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD continuation.
    DATA lt_items TYPE string_table.
    DATA lv_item TYPE string.
    DATA lv_name TYPE string.
    DATA lv_value TYPE string.
    rv_continue = abap_true.
    CLEAR ev_applied.
    lv_item = to_lower( iv_prefer ).
    SPLIT lv_item AT ',' INTO TABLE lt_items.
    LOOP AT lt_items INTO lv_item.
      CONDENSE lv_item NO-GAPS.
      SPLIT lv_item AT '=' INTO lv_name lv_value.
      REPLACE ALL OCCURRENCES OF '"' IN lv_value WITH ''.
      IF lv_name <> 'odata.continue-on-error' AND lv_name <> 'continue-on-error'.
        CONTINUE.
      ENDIF.
      IF lv_value = 'false'.
        rv_continue = abap_false.
        ev_applied = 'odata.continue-on-error=false'.
      ELSE.
        rv_continue = abap_true.
        ev_applied = 'odata.continue-on-error'.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD from_multipart.
    DATA lt_parts TYPE zcl_stg_batch=>ty_parts.
    DATA ls_part TYPE zcl_stg_batch=>ty_part.
    DATA ls_in TYPE zcl_stg_batch=>ty_request.
    DATA ls_request TYPE ty_request.
    DATA ls_header TYPE ihttpnvp.
    DATA lv_part TYPE i.
    DATA lv_count TYPE i.
    lt_parts = zcl_stg_batch=>parse( iv_body = iv_body iv_boundary = zcl_stg_batch=>boundary_of( iv_content_type ) ).
    LOOP AT lt_parts INTO ls_part.
      lv_part = sy-tabix.
      LOOP AT ls_part-requests INTO ls_in.
        lv_count = lv_count + 1.
        CLEAR ls_request.
* the id is the part's Content-ID, so that $<Content-ID> references and the
* answer's Content-ID are the client's own; a part without one gets an
* internal id. A change set is an atomicity group and holds changes only
* (OData 4.01 Part 1, 11.7.7.1).
        ls_request-content_id = ls_in-content_id.
        ls_request-id = ls_in-content_id.
        IF ls_request-id IS INITIAL.
          ls_request-id = |~part{ lv_count }|.
        ENDIF.
        IF ls_part-changeset = abap_true.
          ls_request-group = |~changeset{ lv_part }|.
          IF ls_in-method = 'GET' OR ls_in-method = 'HEAD'.
            zcl_osd_v4_query=>fail( |A change set holds changes, not { ls_in-method } { ls_in-url }| ).
          ENDIF.
        ENDIF.
        ls_request-method = ls_in-method.
        ls_request-url = ls_in-url.
        ls_request-body = ls_in-body.
        LOOP AT ls_in-headers INTO ls_header.
          ls_header-name = to_lower( ls_header-name ).
          APPEND ls_header TO ls_request-headers.
        ENDLOOP.
        APPEND ls_request TO rt_requests.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD http_part.
    DATA lv_crlf TYPE string.
    DATA ls_header TYPE ihttpnvp.
    DATA lv_reason TYPE string.
    lv_crlf = cl_abap_char_utilities=>cr_lf.
    lv_reason = is_response-reason.
    IF lv_reason IS INITIAL.
      lv_reason = 'OK'.
    ENDIF.
    rv_part = |Content-Type: application/http{ lv_crlf }Content-Transfer-Encoding: binary{ lv_crlf }|.
    IF iv_content_id IS NOT INITIAL.
      rv_part = rv_part && |Content-ID: { iv_content_id }{ lv_crlf }|.
    ENDIF.
    rv_part = rv_part && lv_crlf && |HTTP/1.1 { is_response-status } { lv_reason }{ lv_crlf }OData-Version: 4.0{ lv_crlf }|.
    IF is_response-content_type IS NOT INITIAL.
      rv_part = rv_part && |Content-Type: { is_response-content_type }{ lv_crlf }|.
    ENDIF.
    LOOP AT is_response-headers INTO ls_header.
      rv_part = rv_part && |{ ls_header-name }: { ls_header-value }{ lv_crlf }|.
    ENDLOOP.
    rv_part = rv_part && lv_crlf && is_response-body && lv_crlf.
  ENDMETHOD.

  METHOD multipart.
    DATA ls_result TYPE ty_result.
    DATA ls_member TYPE ty_result.
    DATA ls_failed TYPE ty_result.
    DATA lv_crlf TYPE string.
    DATA lv_boundary TYPE string.
    DATA lv_changeset TYPE string.
    DATA lv_out TYPE string.
    DATA lv_inner TYPE string.
    DATA lv_group TYPE string.
    DATA lv_failed TYPE abap_bool.
    DATA lv_member TYPE i.
    DATA lv_id TYPE string.
    lv_crlf = cl_abap_char_utilities=>cr_lf.
    gv_counter = gv_counter + 1.
    lv_boundary = |batchresponse_osd_v4_{ gv_counter }|.
    LOOP AT it_results INTO ls_result.
      IF ls_result-group IS INITIAL.
        lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }| &&
          http_part( is_response = ls_result-response iv_content_id = ls_result-content_id ).
        CONTINUE.
      ENDIF.
      IF ls_result-group = lv_group.
        CONTINUE.
      ENDIF.
* a change set, answered as a whole: a nested multipart when every member
* succeeded, else the one response of the member that failed
      lv_group = ls_result-group.
      lv_failed = abap_false.
      CLEAR ls_failed.
      CLEAR lv_inner.
      lv_member = 0.
      gv_counter = gv_counter + 1.
      lv_changeset = |changesetresponse_osd_v4_{ gv_counter }|.
      LOOP AT it_results INTO ls_member WHERE group = lv_group.
* a member without a Content-ID of its own is named by its position
        lv_id = ls_member-content_id.
        IF lv_id IS INITIAL.
          lv_id = |{ lv_member }|.
        ENDIF.
        IF ls_member-response-status >= 400.
          IF lv_failed = abap_false OR ls_failed-response-status = 424.
            ls_failed = ls_member.
          ENDIF.
          lv_failed = abap_true.
        ENDIF.
        lv_inner = lv_inner && |--{ lv_changeset }{ lv_crlf }| &&
          http_part( is_response = ls_member-response iv_content_id = lv_id ).
        lv_member = lv_member + 1.
      ENDLOOP.
      IF lv_failed = abap_true.
        lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }| &&
          http_part( is_response = ls_failed-response iv_content_id = ls_failed-content_id ).
      ELSE.
        lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }Content-Type: multipart/mixed; boundary={ lv_changeset }{ lv_crlf }{ lv_crlf }| &&
          lv_inner && |--{ lv_changeset }--{ lv_crlf }|.
      ENDIF.
    ENDLOOP.
    rs_response-status = 200.
    rs_response-content_type = |multipart/mixed; boundary={ lv_boundary }|.
    rs_response-body = lv_out && |--{ lv_boundary }--{ lv_crlf }|.
  ENDMETHOD.

  METHOD error.
    rs_response-status = iv_status.
    CASE iv_status.
      WHEN 400.
        rs_response-reason = 'Bad Request'.
      WHEN 424.
        rs_response-reason = 'Failed Dependency'.
    ENDCASE.
    rs_response-content_type = 'application/json;odata.metadata=minimal'.
    rs_response-body = '{"error":{"code":"V4/BATCH","message":' && zcl_osd_v4_json=>quote( iv_message ) && '}}'.
  ENDMETHOD.

  METHOD run_one.
    DATA lv_url TYPE string.
    DATA lv_path TYPE string.
    DATA lv_query TYPE string.
    DATA lt_options TYPE tihttpnvp.
    DATA lv_off TYPE i.
    lv_url = iv_url.
    IF lv_url CP 'http://*' OR lv_url CP 'https://*'.
      FIND FIRST OCCURRENCE OF '/sap/opu/' IN lv_url MATCH OFFSET lv_off.
      IF sy-subrc = 0.
        lv_url = lv_url+lv_off.
      ENDIF.
    ENDIF.
    IF lv_url CP '/*'.
      lv_path = lv_url.
    ELSE.
      lv_path = |{ iv_service_path }/{ lv_url }|.
    ENDIF.
    SPLIT lv_path AT '?' INTO lv_path lv_query.
    IF lv_path CP '*/$batch'.
      rs_response = error( iv_status = 400 iv_message = 'A batch cannot contain a $batch request' ).
      RETURN.
    ENDIF.
    IF lv_query IS NOT INITIAL.
      lt_options = zcl_osd_form=>parse( lv_query ).
    ENDIF.
    rs_response = zcl_osd_v4_http=>dispatch( iv_method = is_request-method iv_path = lv_path
      it_options = lt_options iv_origin = iv_origin iv_body = is_request-body it_headers = is_request-headers ).
  ENDMETHOD.

  METHOD result_json.
    DATA ls_header TYPE ihttpnvp.
    DATA lv_headers TYPE string.
    DATA lv_sep TYPE string.
    rv_json = '{"id":' && zcl_osd_v4_json=>quote( is_result-id ).
    IF is_result-group IS NOT INITIAL.
      rv_json = rv_json && ',"atomicityGroup":' && zcl_osd_v4_json=>quote( is_result-group ).
    ENDIF.
    rv_json = rv_json && |,"status":{ is_result-response-status }|.
    IF is_result-response-content_type IS NOT INITIAL.
      lv_headers = '"content-type":' && zcl_osd_v4_json=>quote( is_result-response-content_type ).
      lv_sep = ','.
    ENDIF.
    LOOP AT is_result-response-headers INTO ls_header.
      lv_headers = lv_headers && lv_sep && zcl_osd_v4_json=>quote( to_lower( ls_header-name ) ) && ':' &&
        zcl_osd_v4_json=>quote( ls_header-value ).
      lv_sep = ','.
    ENDLOOP.
    rv_json = rv_json && ',"headers":{' && lv_headers && '}'.
    IF is_result-response-body IS NOT INITIAL.
      IF is_result-response-content_type CS 'json'.
        rv_json = rv_json && ',"body":' && is_result-response-body.
      ELSE.
        rv_json = rv_json && ',"body":' && zcl_osd_v4_json=>quote( is_result-response-body ).
      ENDIF.
    ENDIF.
    rv_json = rv_json && '}'.
  ENDMETHOD.

  METHOD handle.
    DATA lt_requests TYPE ty_requests.
    DATA ls_request TYPE ty_request.
    DATA ls_next TYPE ty_request.
    DATA lt_results TYPE ty_results.
    DATA ls_result TYPE ty_result.
    DATA lt_failed TYPE string_table.
    DATA lt_locations TYPE tihttpnvp.
    DATA ls_location TYPE ihttpnvp.
    DATA lv_type TYPE string.
    DATA lv_continue TYPE abap_bool.
    DATA lv_group TYPE string.
    DATA lv_group_failed TYPE abap_bool.
    DATA lv_group_first TYPE i.
    DATA lv_index TYPE i.
    DATA lv_depend TYPE string.
    DATA lv_blocked TYPE abap_bool.
    DATA lv_url TYPE string.
    DATA lv_ref TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_prefix TYPE string.
    DATA lv_value TYPE string.
    DATA lv_body TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_last TYPE abap_bool.
    DATA lv_writes TYPE abap_bool.
    DATA lv_next TYPE i.
    DATA lv_length TYPE i.
    DATA lv_applied TYPE string.
    DATA lv_multipart TYPE abap_bool.
    DATA lv_session TYPE string.
    DATA lt_sticky TYPE zcl_osd_v4_sticky=>ty_entries.
    FIELD-SYMBOLS <ls_result> TYPE ty_result.
    FIELD-SYMBOLS <ls_request> TYPE ty_request.

    lv_type = zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'content-type' ).
    IF to_lower( lv_type ) CS 'multipart/mixed'.
      lv_multipart = abap_true.
      lt_requests = from_multipart( iv_body = iv_body iv_content_type = lv_type ).
    ELSEIF to_lower( lv_type ) CS 'application/json'.
      lt_requests = parse( iv_body ).
    ELSE.
      zcl_osd_v4_query=>fail( iv_text = 'A $batch is multipart/mixed or application/json' iv_status = 415 ).
    ENDIF.
    validate( lt_requests ).
* a sticky session (SAP-ContextId) is named on the batch, and its parts are in it
    lv_value = zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'sap-contextid' ).
    IF lv_value IS NOT INITIAL.
      LOOP AT lt_requests ASSIGNING <ls_request>.
        IF zcl_osd_v4_write=>header( it_headers = <ls_request>-headers iv_name = 'sap-contextid' ) IS INITIAL.
          ls_location-name = 'sap-contextid'.
          ls_location-value = lv_value.
          APPEND ls_location TO <ls_request>-headers.
        ENDIF.
      ENDLOOP.
      CLEAR ls_location.
      CLEAR lv_value.
    ENDIF.
    continuation( EXPORTING iv_prefer = zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'prefer' )
      IMPORTING ev_applied = lv_applied RECEIVING rv_continue = lv_continue ).
    lv_prefix = iv_origin && iv_service_path && '/'.

    LOOP AT lt_requests INTO ls_request.
      lv_index = sy-tabix.
      CLEAR ls_result.
      ls_result-id = ls_request-id.
      ls_result-group = ls_request-group.
      ls_result-content_id = ls_request-content_id.

      IF ls_request-group IS NOT INITIAL AND ls_request-group <> lv_group.
* a new atomicity group: the COMMIT is the fence, so that the ROLLBACK of a
* failing member reaches only what this group did
        lv_group = ls_request-group.
        lv_group_failed = abap_false.
        lv_group_first = lines( lt_results ) + 1.
        COMMIT WORK.
* the sticky sessions' buffers are not in the database: a failing group
* gives them back as they were, like the rows (ZCL_OSD_V4_STICKY)
        lt_sticky = zcl_osd_v4_sticky=>snapshot( ).
      ENDIF.

      lv_blocked = abap_false.
      LOOP AT ls_request-depends INTO lv_depend.
        READ TABLE lt_failed WITH KEY table_line = lv_depend TRANSPORTING NO FIELDS.
        IF sy-subrc = 0.
          lv_blocked = abap_true.
        ENDIF.
      ENDLOOP.

      lv_url = ls_request-url.
      IF lv_url(1) = '$'.
        FIND REGEX '^\$([^/?]+)(.*)$' IN lv_url SUBMATCHES lv_ref lv_rest.
        READ TABLE lt_locations INTO ls_location WITH KEY name = lv_ref.
        IF sy-subrc = 0.
          lv_url = ls_location-value && lv_rest.
        ELSE.
          READ TABLE lt_failed WITH KEY table_line = lv_ref TRANSPORTING NO FIELDS.
          IF sy-subrc = 0.
            lv_blocked = abap_true.
          ELSE.
            CLEAR lv_url.
          ENDIF.
        ENDIF.
      ENDIF.

      IF ls_request-group IS NOT INITIAL AND lv_group_failed = abap_true.
        ls_result-response = error( iv_status = 424
          iv_message = |Not executed: atomicity group { ls_request-group } failed| ).
      ELSEIF lv_blocked = abap_true.
        ls_result-response = error( iv_status = 424 iv_message = 'Not executed: a request it depends on failed' ).
      ELSEIF lv_url IS INITIAL.
        ls_result-response = error( iv_status = 400
          iv_message = |{ ls_request-url } refers to no entity created earlier in this batch| ).
      ELSE.
        lv_writes = boolc( ls_request-method <> 'GET' AND ls_request-group IS INITIAL ).
        IF lv_writes = abap_true.
          COMMIT WORK.
        ENDIF.
        ls_result-response = run_one( is_request = ls_request iv_url = lv_url
          iv_service_path = iv_service_path iv_origin = iv_origin ).
        IF lv_writes = abap_true.
          IF ls_result-response-status >= 400.
            ROLLBACK WORK.
          ELSE.
            COMMIT WORK.
          ENDIF.
        ENDIF.
        IF ls_result-response-status < 400.
          lv_value = zcl_osd_v4_write=>header( it_headers = ls_result-response-headers iv_name = 'location' ).
          IF lv_value IS NOT INITIAL.
            lv_length = strlen( lv_prefix ).
            IF strlen( lv_value ) > lv_length.
              IF lv_value(lv_length) = lv_prefix.
                lv_value = substring( val = lv_value off = lv_length ).
              ENDIF.
            ENDIF.
            ls_location-name = ls_request-id.
            ls_location-value = lv_value.
            APPEND ls_location TO lt_locations.
          ENDIF.
        ENDIF.
      ENDIF.

      IF ls_result-response-status >= 400.
        APPEND ls_request-id TO lt_failed.
        IF ls_request-group IS NOT INITIAL AND lv_group_failed = abap_false.
* all or nothing: what the group already did is undone, and its members that
* succeeded answer 424 rather than a success that did not last
          lv_group_failed = abap_true.
          ROLLBACK WORK.
          zcl_osd_v4_sticky=>restore( lt_sticky ).
          LOOP AT lt_results ASSIGNING <ls_result> FROM lv_group_first.
            APPEND <ls_result>-id TO lt_failed.
            DELETE lt_locations WHERE name = <ls_result>-id.
            <ls_result>-response = error( iv_status = 424
              iv_message = |Rolled back: atomicity group { ls_request-group } failed| ).
          ENDLOOP.
        ENDIF.
      ENDIF.
      APPEND ls_result TO lt_results.

* the end of a group: commit it, or record it as failed
      lv_last = abap_true.
      lv_next = lv_index + 1.
      READ TABLE lt_requests INTO ls_next INDEX lv_next.
      IF sy-subrc = 0 AND ls_next-group = ls_request-group AND ls_request-group IS NOT INITIAL.
        lv_last = abap_false.
      ENDIF.
      IF ls_request-group IS NOT INITIAL AND lv_last = abap_true.
        IF lv_group_failed = abap_true.
          APPEND ls_request-group TO lt_failed.
        ELSE.
          COMMIT WORK.
        ENDIF.
        CLEAR lv_group.
      ENDIF.
      IF lv_continue = abap_false AND lv_last = abap_true.
        IF ( ls_request-group IS NOT INITIAL AND lv_group_failed = abap_true )
            OR ( ls_request-group IS INITIAL AND ls_result-response-status >= 400 ).
          EXIT.
        ENDIF.
      ENDIF.
    ENDLOOP.

* A sticky session a part opened (SAP-ContextId) is announced on the batch
* itself: the client reads the header of the HTTP response, not of a part.
    LOOP AT lt_results INTO ls_result.
      lv_value = zcl_osd_v4_write=>header( it_headers = ls_result-response-headers iv_name = 'sap-contextid' ).
      IF lv_value IS NOT INITIAL.
        lv_session = lv_value.
      ENDIF.
    ENDLOOP.
    IF lv_multipart = abap_true.
      rs_response = multipart( lt_results ).
    ELSE.
      LOOP AT lt_results INTO ls_result.
        lv_body = lv_body && lv_sep && result_json( ls_result ).
        lv_sep = ','.
      ENDLOOP.
      rs_response-status = 200.
      rs_response-content_type = 'application/json;odata.metadata=minimal'.
      rs_response-body = '{"responses":[' && lv_body && ']}'.
    ENDIF.
    IF lv_session IS NOT INITIAL.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'SAP-ContextId' iv_value = lv_session
        CHANGING ct_headers = rs_response-headers ).
    ENDIF.
    IF lv_applied IS NOT INITIAL.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = lv_applied
        CHANGING ct_headers = rs_response-headers ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
