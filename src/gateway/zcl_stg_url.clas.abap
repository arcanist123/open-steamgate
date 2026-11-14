CLASS zcl_stg_url DEFINITION PUBLIC CREATE PUBLIC.
* OData v2 URL: /sap/opu/odata/sap/<Service>/<EntitySet>(<keys>)/$count?$opt=...
* A service whose technical name sits in a namespace is addressed with the
* namespace in place of "sap": /sap/opu/odata/<NS>/<Service>/... The service
* is looked up by its external name either way; namespace and prefix say how
* it was addressed, so the answer's own URLs repeat that address.
  PUBLIC SECTION.
* a navigation segment after the first: A('k')/ToB('k2')/ToC is the first
* segment ToB('k2') in nav_prop / nav_key_string and ToC here
    TYPES: BEGIN OF ty_nav_segment,
             nav_prop   TYPE string,
             key_string TYPE string,
           END OF ty_nav_segment.
    TYPES ty_nav_segments TYPE STANDARD TABLE OF ty_nav_segment WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_request,
             service         TYPE string,
             namespace       TYPE string,
             prefix          TYPE string,
             entity_set      TYPE string,
             key_string      TYPE string,
             nav_prop        TYPE string,
             nav_key_string  TYPE string,
             nav_more        TYPE ty_nav_segments,
             is_service_root TYPE abap_bool,
             is_metadata     TYPE abap_bool,
             is_batch        TYPE abap_bool,
             is_count        TYPE abap_bool,
             is_value        TYPE abap_bool,
             options         TYPE tihttpnvp,
           END OF ty_request.

    CLASS-METHODS parse
      IMPORTING
        iv_path           TYPE string
        it_options        TYPE tihttpnvp OPTIONAL
      RETURNING
        VALUE(rs_request) TYPE ty_request
      RAISING
        zcx_stg_error.

    CLASS-METHODS option
      IMPORTING
        is_request      TYPE ty_request
        iv_name         TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.

    CLASS-METHODS parse_keys
      IMPORTING
        iv_key_string     TYPE string
        it_key_names      TYPE string_table
      RETURNING
        VALUE(rt_key_tab) TYPE /iwbep/t_mgw_name_value_pair
      RAISING
        zcx_stg_error.

* a key or parameter literal without its quotes; a NUL in it is a 400,
* since it cannot reach the database (the SQL text ends at it)
    CLASS-METHODS unquote
      IMPORTING
        iv_value        TYPE string
      RETURNING
        VALUE(rv_value) TYPE string
      RAISING
        zcx_stg_error.
* a NUL cannot reach the database (the SQL text ends at it): a value
* holding one is a 400 with the code and the words of the caller
    CLASS-METHODS refuse_nul
      IMPORTING
        iv_value TYPE string
        iv_code  TYPE string
        iv_where TYPE string
      RAISING
        zcx_stg_error.
* a key predicate made fit for a URI in a header (Location): a character a
* URI may not carry raw becomes its UTF-8 bytes as %XX, so a key outside
* Latin-1, a blank or a percent sign survives the trip back
    CLASS-METHODS escape_key
      IMPORTING
        iv_value        TYPE string
      RETURNING
        VALUE(rv_value) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS segment
      IMPORTING iv_path TYPE string
      EXPORTING ev_name TYPE string ev_keys TYPE string
      CHANGING cv_off TYPE i
      RAISING zcx_stg_error.
ENDCLASS.

CLASS zcl_stg_url IMPLEMENTATION.

  METHOD parse.
    DATA ls_more    TYPE ty_nav_segment.
    DATA lv_ns      TYPE string.
    DATA lv_rest    TYPE string.
    DATA lv_segment TYPE string.
    DATA lv_off     TYPE i.

    FIND REGEX '/sap/opu/odata/([^/?]+)/([^/?]+)(.*)$' IN iv_path
      SUBMATCHES lv_ns rs_request-service lv_rest.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 404
          code    = 'STG/NOT_ODATA'
          message = |Not an OData path: { iv_path }|.
    ENDIF.
    rs_request-service = cl_http_utility=>unescape_url( rs_request-service ).
* "sap" in any case is the one /sap/ prefix, spelled lower case in the
* answers; any other segment is a namespace and is repeated as given
    IF to_lower( lv_ns ) = 'sap'.
      rs_request-prefix = '/sap/opu/odata/sap'.
    ELSE.
      rs_request-namespace = lv_ns.
      rs_request-prefix    = |/sap/opu/odata/{ lv_ns }|.
    ENDIF.
    rs_request-options = it_options.

    IF lv_rest = '' OR lv_rest = '/'.
      rs_request-is_service_root = abap_true.
      RETURN.
    ENDIF.

    IF lv_rest = '/$metadata' OR lv_rest = '/$metadata/'.
      rs_request-is_metadata = abap_true.
      RETURN.
    ENDIF.

    IF lv_rest = '/$batch' OR lv_rest = '/$batch/'.
      rs_request-is_batch = abap_true.
      RETURN.
    ENDIF.

    lv_off = 1.
    segment( EXPORTING iv_path = lv_rest
             IMPORTING ev_name = lv_segment ev_keys = rs_request-key_string
             CHANGING cv_off = lv_off ).
    IF lv_off < strlen( lv_rest ) AND lv_rest+lv_off(1) = '/'.
      lv_off = lv_off + 1.
      IF lv_off < strlen( lv_rest ).
        IF lv_rest+lv_off = '$count' OR lv_rest+lv_off = '$count/'.
          rs_request-is_count = abap_true.
          lv_off = strlen( lv_rest ).
        ELSEIF lv_rest+lv_off = '$value' OR lv_rest+lv_off = '$value/'.
          rs_request-is_value = abap_true.
          lv_off = strlen( lv_rest ).
        ELSE.
          segment( EXPORTING iv_path = lv_rest
                   IMPORTING ev_name = rs_request-nav_prop ev_keys = rs_request-nav_key_string
                   CHANGING cv_off = lv_off ).
* further navigation segments (A('k')/ToB('k2')/ToC), then $count / $value
          WHILE lv_off < strlen( lv_rest ) AND lv_rest+lv_off(1) = '/'.
            lv_off = lv_off + 1.
            IF lv_off >= strlen( lv_rest ).
              EXIT.
            ENDIF.
            IF lv_rest+lv_off = '$count' OR lv_rest+lv_off = '$count/'.
              rs_request-is_count = abap_true.
              lv_off = strlen( lv_rest ).
            ELSEIF lv_rest+lv_off = '$value' OR lv_rest+lv_off = '$value/'.
              rs_request-is_value = abap_true.
              lv_off = strlen( lv_rest ).
            ELSE.
              CLEAR ls_more.
              segment( EXPORTING iv_path = lv_rest
                       IMPORTING ev_name = ls_more-nav_prop ev_keys = ls_more-key_string
                       CHANGING cv_off = lv_off ).
              IF ls_more-nav_prop IS INITIAL.
                EXIT.
              ENDIF.
              ls_more-nav_prop = cl_http_utility=>unescape_url( ls_more-nav_prop ).
              APPEND ls_more TO rs_request-nav_more.
            ENDIF.
          ENDWHILE.
        ENDIF.
      ENDIF.
    ENDIF.
    IF lv_segment IS INITIAL OR lv_off <> strlen( lv_rest ).
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING
          status  = 400
          code    = 'STG/BAD_RESOURCE_PATH'
          message = |Unsupported resource path: { lv_rest }|.
    ENDIF.
    rs_request-entity_set = cl_http_utility=>unescape_url( lv_segment ).
    rs_request-nav_prop = cl_http_utility=>unescape_url( rs_request-nav_prop ).
  ENDMETHOD.

  METHOD segment.
    DATA lv_start TYPE i.
    DATA lv_len TYPE i.
    DATA lv_quote TYPE abap_bool.
    DATA lv_char TYPE c LENGTH 1.
    DATA lv_key_start TYPE i.
    DATA lv_closed TYPE abap_bool.
    DATA lv_next TYPE i.
    DATA lv_slice_len TYPE i.
    CLEAR: ev_name, ev_keys.
    lv_len = strlen( iv_path ).
    lv_start = cv_off.
    WHILE cv_off < lv_len.
      lv_char = iv_path+cv_off(1).
      IF lv_char = '/' OR lv_char = '('.
        EXIT.
      ENDIF.
      IF lv_char = ')'.
        EXIT.
      ENDIF.
      cv_off = cv_off + 1.
    ENDWHILE.
    IF cv_off > lv_start.
      lv_slice_len = cv_off - lv_start.
      ev_name = iv_path+lv_start(lv_slice_len).
    ENDIF.
    IF cv_off < lv_len AND iv_path+cv_off(1) = '('.
      cv_off = cv_off + 1.
      lv_key_start = cv_off.
      WHILE cv_off < lv_len.
        lv_char = iv_path+cv_off(1).
        IF lv_char = ''''.
          lv_next = cv_off + 1.
          IF lv_quote = abap_true AND lv_next < lv_len AND iv_path+lv_next(1) = ''''.
            cv_off = cv_off + 2.
            CONTINUE.
          ENDIF.
          IF lv_quote = abap_true.
            lv_quote = abap_false.
          ELSE.
            lv_quote = abap_true.
          ENDIF.
        ELSEIF lv_char = ')' AND lv_quote = abap_false.
          lv_closed = abap_true.
          EXIT.
        ENDIF.
        cv_off = cv_off + 1.
      ENDWHILE.
      IF lv_closed = abap_true AND cv_off > lv_key_start.
        lv_slice_len = cv_off - lv_key_start.
        ev_keys = iv_path+lv_key_start(lv_slice_len).
        cv_off = cv_off + 1.
      ELSE.
        CLEAR ev_name.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD option.
    DATA ls_option LIKE LINE OF is_request-options.
    DATA lv_name   TYPE string.

    LOOP AT is_request-options INTO ls_option.
* a client may encode the $ of a system query option (%24top): the name
* is the decoded one, as on a system -- read raw, the option was ignored
* without a word and the whole set came back (H5x-4 B4)
      lv_name = ls_option-name.
* only a well-formed escape is decoded: the decoder throws on %zz or a bare
* %, and a system ignores such an option rather than failing the request
      FIND REGEX '^[A-Za-z0-9$_.+-]*(%[0-9A-Fa-f]{2}[A-Za-z0-9$_.+-]*)+$' IN lv_name.
      IF sy-subrc = 0.
        lv_name = cl_http_utility=>unescape_url( lv_name ).
      ENDIF.
      IF to_lower( lv_name ) = to_lower( iv_name ).
        rv_value = ls_option-value.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD unquote.
    DATA lv_quote TYPE string.
    DATA lv_two   TYPE string.
    DATA lv_p1    TYPE string.
    DATA lv_p2    TYPE string.
    DATA lv_p3    TYPE string.
    DATA lv_p4    TYPE string.
    DATA lv_p5    TYPE string.

    lv_quote = |'|.
    lv_two   = ''''''.
    rv_value = iv_value.
* an Edm.Guid literal, guid'c0ffee00-0000-4000-8000-0000000000a1', is the
* 32 hex digits a RAW 16 field takes; left as it came, the value reached the
* provider with its prefix and dashes and found no row (M3-B0, W6)
    FIND REGEX `^guid'([0-9A-Fa-f]{8})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{4})-([0-9A-Fa-f]{12})'$`
      IN rv_value IGNORING CASE SUBMATCHES lv_p1 lv_p2 lv_p3 lv_p4 lv_p5.
    IF sy-subrc = 0.
      rv_value = to_upper( lv_p1 && lv_p2 && lv_p3 && lv_p4 && lv_p5 ).
      RETURN.
    ENDIF.
    IF strlen( rv_value ) >= 2 AND rv_value(1) = lv_quote AND substring( val = rv_value
                                                                           off = strlen( rv_value ) - 1 ) = lv_quote.
      rv_value = substring( val = rv_value
                            off = 1
                            len = strlen( rv_value ) - 2 ).
      REPLACE ALL OCCURRENCES OF lv_two IN rv_value WITH lv_quote.
    ENDIF.
    refuse_nul( iv_value = rv_value
                iv_code  = 'STG/BAD_KEY'
                iv_where = 'a key' ).
  ENDMETHOD.

  METHOD refuse_nul.
    DATA lv_nul TYPE string.

    lv_nul = cl_abap_conv_in_ce=>uccp( '0000' ).
    FIND lv_nul IN iv_value.
    IF sy-subrc = 0.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING status = 400 code = iv_code message = |A NUL character in { iv_where } is not accepted|.
    ENDIF.
  ENDMETHOD.

  METHOD escape_key.
    DATA lv_index TYPE i.
    DATA lv_len   TYPE i.
    DATA lv_size  TYPE i.
    DATA lv_byte  TYPE i.
    DATA lv_char  TYPE string.
    DATA lv_unit  TYPE x LENGTH 2.
    DATA lv_x     TYPE xstring.
    DATA lv_hex   TYPE string.

    lv_len = strlen( iv_value ).
    WHILE lv_index < lv_len.
      lv_size = 1.
      lv_char = iv_value+lv_index(1).
      IF lv_char CA 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~!$&''()*+,;=:@/'.
        rv_value = rv_value && lv_char.
      ELSE.
* a character outside the BMP is two UTF-16 units, a high and a low
* surrogate: it is encoded as one code point, not as two halves
        lv_unit = cl_abap_conv_out_ce=>uccp( lv_char ).
        IF lv_unit >= 'D800' AND lv_unit <= 'DBFF' AND lv_index + 1 < lv_len.
          lv_size = 2.
          lv_char = iv_value+lv_index(2).
        ENDIF.
        lv_x = cl_abap_codepage=>convert_to( lv_char ).
        lv_hex = lv_x.
        lv_byte = 0.
        WHILE lv_byte < strlen( lv_hex ).
          rv_value = rv_value && '%' && lv_hex+lv_byte(2).
          lv_byte = lv_byte + 2.
        ENDWHILE.
      ENDIF.
      lv_index = lv_index + lv_size.
    ENDWHILE.
  ENDMETHOD.

  METHOD parse_keys.
    DATA lt_parts TYPE string_table.
    DATA lv_part  TYPE string.
    DATA ls_key   TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_name  TYPE string.
    DATA lv_off TYPE i.
    DATA lv_start TYPE i.
    DATA lv_len TYPE i.
    DATA lv_quote TYPE abap_bool.
    DATA lv_char TYPE c LENGTH 1.
    DATA lv_next TYPE i.
    DATA lv_equal TYPE i.
    DATA lv_slice_len TYPE i.
    DATA lv_piece TYPE string.

    IF iv_key_string IS INITIAL.
      RETURN.
    ENDIF.

    lv_len = strlen( iv_key_string ).
    WHILE lv_off < lv_len.
      lv_char = iv_key_string+lv_off(1).
      IF lv_char = ''''.
        lv_next = lv_off + 1.
        IF lv_quote = abap_true AND lv_next < lv_len AND iv_key_string+lv_next(1) = ''''.
          lv_off = lv_off + 2.
          CONTINUE.
        ENDIF.
        IF lv_quote = abap_true.
          lv_quote = abap_false.
        ELSE.
          lv_quote = abap_true.
        ENDIF.
      ELSEIF lv_char = ',' AND lv_quote = abap_false.
        lv_slice_len = lv_off - lv_start.
        lv_piece = iv_key_string+lv_start(lv_slice_len).
        APPEND lv_piece TO lt_parts.
        lv_start = lv_off + 1.
      ENDIF.
      lv_off = lv_off + 1.
    ENDWHILE.
    IF lv_quote = abap_true OR lv_start = lv_len.
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING status = 400 code = 'STG/BAD_KEY' message = 'Malformed key predicate'.
    ENDIF.
    lv_slice_len = lv_len - lv_start.
    lv_piece = iv_key_string+lv_start(lv_slice_len).
    APPEND lv_piece TO lt_parts.
    LOOP AT lt_parts INTO lv_part.
      SHIFT lv_part LEFT DELETING LEADING space.
      SHIFT lv_part RIGHT DELETING TRAILING space.
      CLEAR: ls_key, lv_equal, lv_quote.
      DO strlen( lv_part ) TIMES.
        lv_off = sy-index - 1.
        lv_char = lv_part+lv_off(1).
        IF lv_char = ''''.
          IF lv_quote = abap_true.
            lv_quote = abap_false.
          ELSE.
            lv_quote = abap_true.
          ENDIF.
        ELSEIF lv_char = '=' AND lv_quote = abap_false.
          lv_equal = lv_off + 1.
          EXIT.
        ENDIF.
      ENDDO.
      IF lv_equal > 0.
        lv_slice_len = lv_equal - 1.
        ls_key-name = lv_part(lv_slice_len).
        ls_key-value = lv_part+lv_equal.
        CONDENSE ls_key-name.
        SHIFT ls_key-value LEFT DELETING LEADING space.
        SHIFT ls_key-value RIGHT DELETING TRAILING space.
      ELSEIF lines( it_key_names ) = 1.
        READ TABLE it_key_names INDEX 1 INTO lv_name.
        ls_key-name  = lv_name.
        ls_key-value = lv_part.
      ELSE.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status  = 400
            code    = 'STG/BAD_KEY'
            message = |Key predicate must name every key property: { iv_key_string }|.
      ENDIF.
      IF ls_key-name IS INITIAL OR ls_key-value IS INITIAL.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING status = 400 code = 'STG/BAD_KEY' message = 'Malformed key predicate'.
      ENDIF.
      ls_key-name = cl_http_utility=>unescape_url( ls_key-name ).
      ls_key-value = cl_http_utility=>unescape_url( ls_key-value ).
      ls_key-value = unquote( ls_key-value ).
      READ TABLE rt_key_tab WITH KEY name = ls_key-name TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING status = 400 code = 'STG/BAD_KEY' message = 'Duplicate key property'.
      ENDIF.
      APPEND ls_key TO rt_key_tab.
    ENDLOOP.
    IF lines( rt_key_tab ) <> lines( it_key_names ).
      RAISE EXCEPTION TYPE zcx_stg_error
        EXPORTING status = 400 code = 'STG/BAD_KEY' message = 'Wrong number of key properties'.
    ENDIF.
    LOOP AT it_key_names INTO lv_name.
      READ TABLE rt_key_tab WITH KEY name = lv_name TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING status = 400 code = 'STG/BAD_KEY' message = 'Unknown key property'.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
