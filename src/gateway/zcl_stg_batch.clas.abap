CLASS zcl_stg_batch DEFINITION PUBLIC CREATE PUBLIC.
* OData v2 $batch: multipart/mixed in, multipart/mixed out. Retrieve parts
* are dispatched one by one; a changeset is dispatched in order and answered
* as a whole: the first failing request becomes the changeset's single error
* response, like a real Gateway does, and the requests that already succeeded
* inside that changeset are rolled back with it (backlog B.2)
* (the bracket is real: all three database clients implement begin, commit
* and rollback, and nothing else in this system commits, which is why the
* fence below matters).
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_request,
             method  TYPE string,
             url     TYPE string,
             headers TYPE tihttpnvp,
             body    TYPE string,
             body_x  TYPE xstring,
* the MIME Content-ID of the part (the V4 facade answers with it)
             content_id TYPE string,
           END OF ty_request.
    TYPES ty_requests TYPE STANDARD TABLE OF ty_request WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_part,
             changeset TYPE abap_bool,
             requests  TYPE ty_requests,
           END OF ty_part.
    TYPES ty_parts TYPE STANDARD TABLE OF ty_part WITH DEFAULT KEY.

    CLASS-METHODS handle
      IMPORTING
        iv_body            TYPE string
        iv_body_x          TYPE xstring OPTIONAL
        iv_content_type    TYPE string
        iv_service_path    TYPE string
        iv_host            TYPE string
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response
      RAISING
        zcx_stg_error.

    CLASS-METHODS boundary_of
      IMPORTING
        iv_content_type    TYPE string
      RETURNING
        VALUE(rv_boundary) TYPE string.

    CLASS-METHODS parse
      IMPORTING
        iv_body         TYPE string
        iv_boundary     TYPE string
        iv_body_x       TYPE xstring OPTIONAL
      RETURNING
        VALUE(rt_parts) TYPE ty_parts
      RAISING
        zcx_stg_error.

    CLASS-METHODS format_part
      IMPORTING
        is_response      TYPE zcl_stg_dispatcher=>ty_response
      RETURNING
        VALUE(rv_string) TYPE string.
  PRIVATE SECTION.
    TYPES ty_xchunks TYPE STANDARD TABLE OF xstring WITH DEFAULT KEY.
    CLASS-DATA gv_counter TYPE i.

    CLASS-METHODS chunks
      IMPORTING
        iv_body          TYPE xstring
        iv_boundary      TYPE string
      RETURNING
        VALUE(rt_chunks) TYPE ty_xchunks
      RAISING zcx_stg_error.

    CLASS-METHODS split_headers
      IMPORTING
        iv_chunk   TYPE xstring
      EXPORTING
        et_headers TYPE tihttpnvp
        ev_rest    TYPE xstring
      RAISING zcx_stg_error.

    CLASS-METHODS header
      IMPORTING
        it_headers      TYPE tihttpnvp
        iv_name         TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS parse_request
      IMPORTING
        iv_chunk          TYPE xstring
      RETURNING
        VALUE(rs_request) TYPE ty_request
      RAISING
        zcx_stg_error.

    CLASS-METHODS run_request
      IMPORTING
        is_request         TYPE ty_request
        iv_service_path    TYPE string
        iv_host            TYPE string
      RETURNING
        VALUE(rs_response) TYPE zcl_stg_dispatcher=>ty_response.

    CLASS-METHODS byte_length
      IMPORTING
        iv_string     TYPE string
      RETURNING
        VALUE(rv_len) TYPE i.
ENDCLASS.

CLASS zcl_stg_batch IMPLEMENTATION.

  METHOD boundary_of.
    DATA lv_off TYPE i.
    DATA lv_start TYPE i.
    DATA lv_part TYPE string.
    DATA lv_name TYPE string.
    DATA lv_value TYPE string.
    DATA lv_quote TYPE abap_bool.
    DATA lv_char TYPE c LENGTH 1.
    DATA lv_size TYPE i.
    DATA lv_part_len TYPE i.
    DATA lv_value_len TYPE i.
    DATA lv_iterations TYPE i.
    lv_size = strlen( iv_content_type ).
    lv_iterations = lv_size + 1.
    DO lv_iterations TIMES.
      lv_off = sy-index - 1.
      IF lv_off < lv_size.
        lv_char = iv_content_type+lv_off(1).
        IF lv_char = '"'.
          IF lv_quote = abap_true.
            lv_quote = abap_false.
          ELSE.
            lv_quote = abap_true.
          ENDIF.
        ENDIF.
      ELSE.
        lv_char = ';'.
      ENDIF.
      IF lv_char = ';' AND lv_quote = abap_false.
        IF lv_off > lv_start.
          lv_part_len = lv_off - lv_start.
          lv_part = iv_content_type+lv_start(lv_part_len).
          SPLIT lv_part AT '=' INTO lv_name lv_value.
          lv_name = to_lower( condense( lv_name ) ).
          IF lv_name = 'boundary'.
            SHIFT lv_value LEFT DELETING LEADING space.
            SHIFT lv_value RIGHT DELETING TRAILING space.
            IF strlen( lv_value ) >= 2 AND lv_value(1) = '"'.
              lv_size = strlen( lv_value ) - 1.
              IF lv_value+lv_size(1) = '"'.
                lv_value_len = lv_size - 1.
                rv_boundary = lv_value+1(lv_value_len).
              ENDIF.
            ELSE.
              rv_boundary = lv_value.
            ENDIF.
            RETURN.
          ENDIF.
        ENDIF.
        lv_start = lv_off + 1.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD chunks.
    DATA lv_marker TYPE xstring.
    DATA lv_pos TYPE i.
    DATA lv_scan TYPE i.
    DATA lv_after TYPE i.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_len TYPE i.
    DATA lv_closing TYPE abap_bool.
    DATA lv_valid TYPE abap_bool.
    DATA lv_marker_len TYPE i.
    DATA lv_slice_len TYPE i.
    lv_marker = cl_abap_codepage=>convert_to( |--{ iv_boundary }| ).
    lv_len = xstrlen( iv_body ).
    lv_marker_len = xstrlen( lv_marker ).
    WHILE lv_scan < lv_len.
      lv_pos = lv_scan.
      WHILE lv_pos + lv_marker_len <= lv_len.
        IF iv_body+lv_pos(lv_marker_len) = lv_marker.
          EXIT.
        ENDIF.
        lv_pos = lv_pos + 1.
      ENDWHILE.
      IF lv_pos + lv_marker_len > lv_len.
        EXIT.
      ENDIF.
      lv_after = lv_pos + lv_marker_len.
      lv_valid = abap_false.
      IF lv_pos = 0.
        lv_valid = abap_true.
      ELSE.
        lv_end = lv_pos - 1.
        IF iv_body+lv_end(1) = '0A'.
          lv_valid = abap_true.
        ENDIF.
      ENDIF.
      lv_closing = abap_false.
      IF lv_after + 1 < lv_len.
        IF iv_body+lv_after(2) = '2D2D'.
          lv_closing = abap_true.
          lv_after = lv_after + 2.
        ENDIF.
      ENDIF.
* MIME permits spaces and tabs after the boundary marker.
      WHILE lv_after < lv_len AND ( iv_body+lv_after(1) = '20' OR iv_body+lv_after(1) = '09' ).
        lv_after = lv_after + 1.
      ENDWHILE.
      IF lv_after = lv_len.
* A closing delimiter may end the body without a line break.
        IF lv_closing = abap_false.
          lv_valid = abap_false.
        ENDIF.
      ELSEIF iv_body+lv_after(1) = '0A'.
        lv_after = lv_after + 1.
      ELSEIF lv_after + 1 < lv_len AND iv_body+lv_after(2) = '0D0A'.
        lv_after = lv_after + 2.
      ELSE.
        lv_valid = abap_false.
      ENDIF.
      IF lv_valid = abap_false.
        lv_scan = lv_pos + 1.
        CONTINUE.
      ENDIF.
      IF lv_start > 0.
        lv_end = lv_pos - 1.
        IF lv_end > lv_start.
          lv_slice_len = lv_end - 1.
          IF iv_body+lv_slice_len(1) = '0D'.
            lv_end = lv_end - 1.
          ENDIF.
        ENDIF.
        IF lv_end >= lv_start.
          lv_slice_len = lv_end - lv_start.
          APPEND iv_body+lv_start(lv_slice_len) TO rt_chunks.
        ENDIF.
      ENDIF.
      IF lv_closing = abap_true.
        RETURN.
      ENDIF.
      lv_start = lv_after.
      lv_scan = lv_start.
    ENDWHILE.
    RAISE EXCEPTION TYPE zcx_stg_error
      EXPORTING status = 400 code = 'STG/BAD_BATCH' message = 'Missing closing multipart boundary'.
  ENDMETHOD.

  METHOD split_headers.
    DATA lt_lines TYPE string_table.
    DATA lv_line  TYPE string.
    DATA ls_hdr   TYPE ihttpnvp.
    DATA lv_index TYPE i.
    DATA lv_head TYPE string.
    DATA lv_sep_len TYPE i.
    DATA lv_colon TYPE i.
    DATA lv_head_x TYPE xstring.
    DATA lv_first TYPE c LENGTH 1.
    DATA lv_trim TYPE string.

    CLEAR et_headers.
    CLEAR ev_rest.
    IF xstrlen( iv_chunk ) >= 2 AND iv_chunk(2) = '0D0A'.
      ev_rest = iv_chunk+2.
      RETURN.
    ENDIF.
    IF xstrlen( iv_chunk ) >= 1 AND iv_chunk(1) = '0A'.
      ev_rest = iv_chunk+1.
      RETURN.
    ENDIF.
    WHILE lv_index + 2 <= xstrlen( iv_chunk ).
      IF lv_index + 4 <= xstrlen( iv_chunk ) AND iv_chunk+lv_index(4) = '0D0A0D0A'.
        lv_sep_len = 4.
        EXIT.
      ELSEIF iv_chunk+lv_index(2) = '0A0A'.
        lv_sep_len = 2.
        EXIT.
      ENDIF.
      lv_index = lv_index + 1.
    ENDWHILE.
    IF lv_sep_len = 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING status = 400 code = 'STG/BAD_BATCH' message = 'Missing multipart header separator'.
    ENDIF.
    lv_head_x = iv_chunk(lv_index).
    lv_head = cl_abap_codepage=>convert_from( lv_head_x ).
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf IN lv_head
      WITH cl_abap_char_utilities=>newline.
    SPLIT lv_head AT cl_abap_char_utilities=>newline INTO TABLE lt_lines.
    LOOP AT lt_lines INTO lv_line.
      IF lv_line IS NOT INITIAL.
        lv_first = lv_line(1).
        IF lv_first = space OR lv_first = cl_abap_char_utilities=>horizontal_tab.
          IF et_headers IS INITIAL.
            RAISE EXCEPTION TYPE zcx_stg_error
              EXPORTING status = 400 code = 'STG/BAD_BATCH' message = 'Orphan multipart header continuation'.
          ENDIF.
          lv_trim = lv_line.
          SHIFT lv_trim LEFT DELETING LEADING space.
          WHILE lv_trim IS NOT INITIAL AND lv_trim(1) = cl_abap_char_utilities=>horizontal_tab.
            lv_trim = lv_trim+1.
            SHIFT lv_trim LEFT DELETING LEADING space.
          ENDWHILE.
          READ TABLE et_headers INDEX lines( et_headers ) INTO ls_hdr.
          ls_hdr-value = |{ ls_hdr-value } { lv_trim }|.
          MODIFY et_headers FROM ls_hdr INDEX lines( et_headers ).
          CONTINUE.
        ENDIF.
      ENDIF.
      CLEAR ls_hdr.
      FIND FIRST OCCURRENCE OF ':' IN lv_line MATCH OFFSET lv_colon.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING status = 400 code = 'STG/BAD_BATCH' message = 'Malformed multipart header'.
      ENDIF.
      ls_hdr-name = lv_line(lv_colon).
      lv_colon = lv_colon + 1.
      ls_hdr-value = lv_line+lv_colon.
      ls_hdr-name = to_lower( condense( ls_hdr-name ) ).
      SHIFT ls_hdr-value LEFT DELETING LEADING space.
      APPEND ls_hdr TO et_headers.
    ENDLOOP.
    lv_index = lv_index + lv_sep_len.
    ev_rest = iv_chunk+lv_index.
  ENDMETHOD.

  METHOD header.
    DATA ls_hdr TYPE ihttpnvp.

    READ TABLE it_headers INTO ls_hdr WITH KEY name = to_lower( iv_name ).
    IF sy-subrc = 0.
      rv_value = ls_hdr-value.
    ENDIF.
  ENDMETHOD.

  METHOD parse_request.
    DATA lt_part_headers TYPE tihttpnvp.
    DATA lv_http         TYPE xstring.
    DATA lv_line         TYPE string.
    DATA lv_version      TYPE string.
    DATA lv_rest         TYPE xstring.
    DATA lv_off          TYPE i.
    DATA lv_line_end TYPE i.
    DATA lv_line_x TYPE xstring.

* part headers (Content-Type: application/http ...), blank line, then the
* embedded HTTP request
    split_headers( EXPORTING iv_chunk   = iv_chunk
                   IMPORTING et_headers = lt_part_headers
                             ev_rest    = lv_http ).
    rs_request-content_id = header( it_headers = lt_part_headers
                                    iv_name    = 'content-id' ).

    WHILE lv_off < xstrlen( lv_http ).
      IF lv_http+lv_off(1) = '0A'.
        EXIT.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
    IF lv_off >= xstrlen( lv_http ) OR lv_off = 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/BAD_BATCH'
          message = 'Batch part without a request line'.
    ENDIF.
    lv_line_end = lv_off.
    IF lv_line_end > 0.
      lv_line_end = lv_line_end - 1.
      IF lv_http+lv_line_end(1) = '0D'.
        lv_line_x = lv_http(lv_line_end).
      ELSE.
        lv_line_x = lv_http(lv_off).
      ENDIF.
    ENDIF.
    lv_line = cl_abap_codepage=>convert_from( lv_line_x ).
    SPLIT lv_line AT space INTO rs_request-method rs_request-url lv_version.
    rs_request-method = to_upper( rs_request-method ).
    IF rs_request-method IS INITIAL OR rs_request-url IS INITIAL.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/BAD_BATCH'
          message = |Bad request line in batch: { lv_line }|.
    ENDIF.

    lv_off = lv_off + 1.
    lv_rest = lv_http+lv_off.
    IF lv_rest IS NOT INITIAL.
      split_headers( EXPORTING iv_chunk   = lv_rest
                     IMPORTING et_headers = rs_request-headers
                               ev_rest    = rs_request-body_x ).
    ENDIF.
    TRY.
        rs_request-body = cl_abap_codepage=>convert_from( rs_request-body_x ).
      CATCH cx_root.
        CLEAR rs_request-body.
    ENDTRY.
  ENDMETHOD.

  METHOD parse.
    DATA lt_chunks    TYPE ty_xchunks.
    DATA lv_chunk     TYPE xstring.
    DATA lt_headers   TYPE tihttpnvp.
    DATA lv_rest      TYPE xstring.
    DATA lv_type      TYPE string.
    DATA lv_boundary  TYPE string.
    DATA lt_inner     TYPE ty_xchunks.
    DATA lv_inner     TYPE xstring.
    DATA ls_part      TYPE ty_part.
    DATA lv_body_x    TYPE xstring.

    IF iv_boundary IS INITIAL.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/BAD_BATCH'
          message = 'Content-Type of a $batch request must carry a boundary'.
    ENDIF.

    lv_body_x = iv_body_x.
    IF lv_body_x IS INITIAL.
      lv_body_x = cl_abap_codepage=>convert_to( iv_body ).
    ENDIF.
    lt_chunks = chunks( iv_body     = lv_body_x
                        iv_boundary = iv_boundary ).
    LOOP AT lt_chunks INTO lv_chunk.
      CLEAR ls_part.
      split_headers( EXPORTING iv_chunk   = lv_chunk
                     IMPORTING et_headers = lt_headers
                               ev_rest    = lv_rest ).
      lv_type = header( it_headers = lt_headers
                        iv_name    = 'content-type' ).
      IF lv_type CS 'multipart/mixed'.
        ls_part-changeset = abap_true.
        lv_boundary = boundary_of( lv_type ).
        lt_inner = chunks( iv_body     = lv_rest
                           iv_boundary = lv_boundary ).
        LOOP AT lt_inner INTO lv_inner.
          APPEND parse_request( lv_inner ) TO ls_part-requests.
        ENDLOOP.
      ELSE.
        APPEND parse_request( lv_chunk ) TO ls_part-requests.
      ENDIF.
      APPEND ls_part TO rt_parts.
    ENDLOOP.
  ENDMETHOD.

  METHOD run_request.
    DATA lv_url     TYPE string.
    DATA lv_path    TYPE string.
    DATA lv_query   TYPE string.
    DATA lt_options TYPE tihttpnvp.
    DATA lv_off     TYPE i.

    lv_url = is_request-url.
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
    IF lv_query IS NOT INITIAL.
      lt_options = cl_http_utility=>string_to_fields( lv_query ).
    ENDIF.

    rs_response = zcl_stg_dispatcher=>dispatch( iv_method  = is_request-method
                                                iv_path    = lv_path
                                                it_options = lt_options
                                                iv_host    = iv_host
                                                iv_body    = is_request-body
                                                iv_body_x  = is_request-body_x
                                                iv_content_type = header( it_headers = is_request-headers
                                                                          iv_name = 'content-type' ) ).
  ENDMETHOD.

  METHOD byte_length.
    DATA lv_x TYPE xstring.

    TRY.
        lv_x = cl_abap_codepage=>convert_to( iv_string ).
        rv_len = xstrlen( lv_x ).
      CATCH cx_root.
        rv_len = strlen( iv_string ).
    ENDTRY.
  ENDMETHOD.

  METHOD format_part.
    DATA lv_crlf TYPE string.
    DATA ls_hdr  TYPE ihttpnvp.

    lv_crlf = cl_abap_char_utilities=>cr_lf.
    rv_string = |Content-Type: application/http{ lv_crlf }Content-Transfer-Encoding: binary{ lv_crlf }{ lv_crlf }| &&
                |HTTP/1.1 { is_response-status } { is_response-reason }{ lv_crlf }|.
    IF is_response-content_type IS NOT INITIAL.
      rv_string = rv_string && |Content-Type: { is_response-content_type }{ lv_crlf }|.
    ENDIF.
    rv_string = rv_string && |Content-Length: { byte_length( is_response-body ) }{ lv_crlf }| &&
                |DataServiceVersion: 2.0{ lv_crlf }|.
    LOOP AT is_response-headers INTO ls_hdr.
      rv_string = rv_string && |{ ls_hdr-name }: { ls_hdr-value }{ lv_crlf }|.
    ENDLOOP.
    rv_string = rv_string && lv_crlf && is_response-body && lv_crlf.
  ENDMETHOD.

  METHOD handle.
    DATA lt_parts     TYPE ty_parts.
    DATA ls_part      TYPE ty_part.
    DATA ls_request   TYPE ty_request.
    DATA ls_response  TYPE zcl_stg_dispatcher=>ty_response.
    DATA lv_boundary  TYPE string.
    DATA lv_cs        TYPE string.
    DATA lv_crlf      TYPE string.
    DATA lv_out       TYPE string.
    DATA lv_cs_out    TYPE string.
    DATA lv_failed    TYPE abap_bool.

    lv_crlf = cl_abap_char_utilities=>cr_lf.
    lt_parts = parse( iv_body     = iv_body
                      iv_body_x   = iv_body_x
                      iv_boundary = boundary_of( iv_content_type ) ).

    gv_counter = gv_counter + 1.
    lv_boundary = |batchresponse_stg_{ gv_counter }|.

    LOOP AT lt_parts INTO ls_part.
      IF ls_part-changeset = abap_true.
        gv_counter = gv_counter + 1.
        lv_cs = |changesetresponse_stg_{ gv_counter }|.
        CLEAR lv_cs_out.
        lv_failed = abap_false.
* A changeset is one LUW, so it has to be all or nothing (backlog B.2). The
* COMMIT here is the fence, not the point: it ends whatever LUW was open
* before this changeset -- the rows the boot writes, an earlier part of this
* same batch -- so that the ROLLBACK below can only reach what this changeset
* did. Without it a failing changeset would undo the whole process's
* uncommitted history, because nothing else in this system ever commits.
        COMMIT WORK.
        LOOP AT ls_part-requests INTO ls_request.
          ls_response = run_request( is_request      = ls_request
                                     iv_service_path = iv_service_path
                                     iv_host         = iv_host ).
          IF ls_response-status >= 400.
* the changeset fails as a whole: one error part instead of the multipart,
* and the requests that already succeeded inside it are undone
            lv_failed = abap_true.
            ROLLBACK WORK.
            lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }| && format_part( ls_response ).
            EXIT.
          ENDIF.
          lv_cs_out = lv_cs_out && |--{ lv_cs }{ lv_crlf }| && format_part( ls_response ).
        ENDLOOP.
        IF lv_failed = abap_false.
          COMMIT WORK.
          lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }Content-Type: multipart/mixed; boundary={ lv_cs }{ lv_crlf }{ lv_crlf }| &&
                   lv_cs_out && |--{ lv_cs }--{ lv_crlf }|.
        ENDIF.
      ELSE.
        READ TABLE ls_part-requests INDEX 1 INTO ls_request.
        ls_response = run_request( is_request      = ls_request
                                   iv_service_path = iv_service_path
                                   iv_host         = iv_host ).
        lv_out = lv_out && |--{ lv_boundary }{ lv_crlf }| && format_part( ls_response ).
      ENDIF.
    ENDLOOP.
    lv_out = lv_out && |--{ lv_boundary }--{ lv_crlf }|.

    rs_response-status       = 202.
    rs_response-reason       = 'Accepted'.
    rs_response-content_type = |multipart/mixed; boundary={ lv_boundary }|.
    rs_response-body         = lv_out.
  ENDMETHOD.

ENDCLASS.
