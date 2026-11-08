CLASS zcl_osd_v4_batch DEFINITION PUBLIC CREATE PUBLIC.
* JSON $batch, OData JSON Format 4.01 s19: {"requests":[...]} in,
* {"responses":[...]} out. Each request runs through ZCL_OSD_V4_HTTP=>DISPATCH.
* An atomicityGroup is one LUW: a COMMIT WORK fences it off from what ran
* before, a failing member rolls the whole group back, and the group commits
* only when every member succeeded. A request outside a group is its own LUW,
* like a single request. dependsOn names earlier requests or groups; when one
* of them failed the request is not executed and answers 424. A url that
* starts with $<id> continues the Location of the entity request <id> created.
* Without Prefer: odata.continue-on-error, processing stops after the first
* failed request or group. Multipart batches are not implemented (501).
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
           END OF ty_request.
    TYPES ty_requests TYPE STANDARD TABLE OF ty_request WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_result,
             id       TYPE string,
             group    TYPE string,
             response TYPE zcl_stg_dispatcher=>ty_response,
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
    CLASS-METHODS result_json IMPORTING is_result TYPE ty_result RETURNING VALUE(rv_json) TYPE string.
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

    lt_values = zcl_stg_json=>parse_object( EXPORTING iv_json = iv_body IMPORTING et_nested = lt_nested ).
    READ TABLE lt_nested INTO ls_pair WITH KEY name = 'requests'.
    IF sy-subrc <> 0.
      zcl_osd_v4_query=>fail( 'A JSON batch needs a "requests" array' ).
    ENDIF.
    lt_elements = zcl_stg_json=>parse_array( ls_pair-value ).
    LOOP AT lt_elements INTO lv_element.
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
      ENDLOOP.
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

  METHOD error.
    rs_response-status = iv_status.
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
    FIELD-SYMBOLS <ls_result> TYPE ty_result.

    lv_type = to_lower( zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'content-type' ) ).
    IF lv_type CS 'multipart/'.
      zcl_osd_v4_query=>fail( iv_text = 'Multipart $batch is not implemented; send a JSON batch (application/json)'
        iv_status = 501 ).
    ENDIF.
    IF lv_type NS 'application/json'.
      zcl_osd_v4_query=>fail( iv_text = 'A JSON $batch needs Content-Type: application/json' iv_status = 415 ).
    ENDIF.
    lt_requests = parse( iv_body ).
    validate( lt_requests ).
    lv_continue = boolc( to_lower( zcl_osd_v4_write=>header( it_headers = it_headers iv_name = 'prefer' ) )
      CS 'continue-on-error' ).
    lv_prefix = iv_origin && iv_service_path && '/'.

    LOOP AT lt_requests INTO ls_request.
      lv_index = sy-tabix.
      CLEAR ls_result.
      ls_result-id = ls_request-id.
      ls_result-group = ls_request-group.

      IF ls_request-group IS NOT INITIAL AND ls_request-group <> lv_group.
* a new atomicity group: the COMMIT is the fence, so that the ROLLBACK of a
* failing member reaches only what this group did
        lv_group = ls_request-group.
        lv_group_failed = abap_false.
        lv_group_first = lines( lt_results ) + 1.
        COMMIT WORK.
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

    LOOP AT lt_results INTO ls_result.
      lv_body = lv_body && lv_sep && result_json( ls_result ).
      lv_sep = ','.
    ENDLOOP.
    rs_response-status = 200.
    rs_response-content_type = 'application/json;odata.metadata=minimal'.
    rs_response-body = '{"responses":[' && lv_body && ']}'.
    IF lv_continue = abap_true.
      zcl_osd_v4_write=>add_header( EXPORTING iv_name = 'Preference-Applied' iv_value = 'odata.continue-on-error'
        CHANGING ct_headers = rs_response-headers ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
