CLASS zcl_osd_v4_json DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS quote IMPORTING iv_text TYPE string RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS value IMPORTING iv_value TYPE any iv_type TYPE string
      RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS entity IMPORTING is_data TYPE any
      is_set TYPE zcl_stg_model_info=>ty_entity_set io_model TYPE REF TO zcl_osd_v4_model
      it_select TYPE string_table OPTIONAL it_nav TYPE zcl_stg_json=>ty_nav_jsons OPTIONAL
      RETURNING VALUE(rv_json) TYPE string.
* W/"..." from the properties the MPC marks set_as_etag; empty without one
    CLASS-METHODS etag IMPORTING is_data TYPE any
      is_set TYPE zcl_stg_model_info=>ty_entity_set io_model TYPE REF TO zcl_osd_v4_model
      RETURNING VALUE(rv_etag) TYPE string.
* The V4 key predicate of an entity, without the parentheses; a string value
* is made fit for a URI by escape_key_value, the predicate's own characters
* (the quotes, the = and , of a compound key) stay raw
    CLASS-METHODS key_predicate IMPORTING is_data TYPE any
      is_set TYPE zcl_stg_model_info=>ty_entity_set io_model TYPE REF TO zcl_osd_v4_model
      RETURNING VALUE(rv_key) TYPE string.
* A string key value escaped for a URI: an ASCII byte keeps what
* cl_http_utility=>escape_url wrote for it (kept set and lowercase hex), so
* an ASCII key has the Location it always had; a character outside ASCII
* becomes its UTF-8 bytes as %XX, because escape_url writes one % before all
* bytes of a character, which no client decodes
    CLASS-METHODS escape_key_value IMPORTING iv_value TYPE string
      RETURNING VALUE(rv_value) TYPE string.
* {"@odata.context":...} followed by the members of an entity object
    CLASS-METHODS document IMPORTING iv_context TYPE string iv_entity TYPE string
      RETURNING VALUE(rv_json) TYPE string.
ENDCLASS.

CLASS zcl_osd_v4_json IMPLEMENTATION.
  METHOD quote.
    rv_json = |"{ escape( val = iv_text format = cl_abap_format=>e_json_string ) }"|.
  ENDMETHOD.

  METHOD value.
    DATA lv_text TYPE string.
    DATA lv_sign TYPE string.
    DATA lv_integer TYPE string.
    DATA lv_fraction TYPE string.
    DATA lv_exponent TYPE string.
    DATA lv_x TYPE xstring.
    DATA lv_kind TYPE c LENGTH 1.
    DESCRIBE FIELD iv_value TYPE lv_kind.
    lv_text = |{ iv_value }|.
    CASE iv_type.
      WHEN 'Edm.Boolean'.
        IF iv_value IS INITIAL OR lv_text = 'false'.
          rv_json = 'false'.
        ELSE.
          rv_json = 'true'.
        ENDIF.
      WHEN 'Edm.Byte' OR 'Edm.SByte' OR 'Edm.Int16' OR 'Edm.Int32' OR 'Edm.Int64'
        OR 'Edm.Decimal' OR 'Edm.Double' OR 'Edm.Single'.
        CONDENSE lv_text NO-GAPS.
        IF lv_text IS INITIAL.
          lv_text = '0'.
        ENDIF.
        IF lv_text = 'INF' OR lv_text = '-INF' OR lv_text = 'NaN'.
          rv_json = quote( lv_text ).
        ELSE.
* Normalize textually: numeric casts can round Decimal and Int64 values.
          FIND REGEX '^([+-]?)([0-9]+)(\.[0-9]+)?([eE][+-]?[0-9]+)?$' IN lv_text
            SUBMATCHES lv_sign lv_integer lv_fraction lv_exponent.
          IF sy-subrc <> 0.
            rv_json = 'null'.
            RETURN.
          ENDIF.
          WHILE strlen( lv_integer ) > 1 AND lv_integer(1) = '0'.
            lv_integer = substring( val = lv_integer off = 1 ).
          ENDWHILE.
          IF lv_sign = '+'.
            CLEAR lv_sign.
          ENDIF.
          rv_json = lv_sign && lv_integer && lv_fraction && lv_exponent.
        ENDIF.
      WHEN 'Edm.Date' OR 'Edm.DateTimeOffset'.
        IF iv_value IS INITIAL.
          rv_json = 'null'.
          RETURN.
        ENDIF.
        CONDENSE lv_text NO-GAPS.
        IF lv_kind = 'D'.
          lv_text = iv_value.
        ENDIF.
        IF strlen( lv_text ) >= 8 AND lv_text(8) CO '0123456789'.
          IF iv_type = 'Edm.Date'.
            lv_text = |{ lv_text(4) }-{ lv_text+4(2) }-{ lv_text+6(2) }|.
          ELSEIF strlen( lv_text ) >= 14.
            lv_text = |{ lv_text(4) }-{ lv_text+4(2) }-{ lv_text+6(2) }T{ lv_text+8(2) }:{ lv_text+10(2) }:{ lv_text+12(2) }{ substring( val = lv_text off = 14 ) }Z|.
          ELSE.
            lv_text = |{ lv_text(4) }-{ lv_text+4(2) }-{ lv_text+6(2) }T00:00:00Z|.
          ENDIF.
        ENDIF.
        rv_json = quote( lv_text ).
      WHEN 'Edm.TimeOfDay'.
        lv_text = iv_value.
        IF strlen( lv_text ) = 6.
          lv_text = |{ lv_text(2) }:{ lv_text+2(2) }:{ lv_text+4(2) }|.
        ENDIF.
        rv_json = quote( lv_text ).
      WHEN 'Edm.Guid'.
        CONDENSE lv_text NO-GAPS.
        IF strlen( lv_text ) = 32.
          lv_text = |{ lv_text(8) }-{ lv_text+8(4) }-{ lv_text+12(4) }-{ lv_text+16(4) }-{ lv_text+20(12) }|.
        ENDIF.
        rv_json = quote( to_lower( lv_text ) ).
      WHEN 'Edm.Binary'.
        lv_x = iv_value.
        lv_text = cl_http_utility=>encode_x_base64( lv_x ).
        REPLACE ALL OCCURRENCES OF '+' IN lv_text WITH '-'.
        REPLACE ALL OCCURRENCES OF '/' IN lv_text WITH '_'.
        REPLACE ALL OCCURRENCES OF '=' IN lv_text WITH ''.
        rv_json = quote( lv_text ).
      WHEN OTHERS.
        lv_text = iv_value.
        rv_json = quote( lv_text ).
    ENDCASE.
  ENDMETHOD.

  METHOD entity.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA ls_nav TYPE zcl_stg_json=>ty_nav_json.
    DATA lv_fields TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_etag TYPE string.
    FIELD-SYMBOLS <lv_value> TYPE any.
    lv_etag = etag( is_data = is_data is_set = is_set io_model = io_model ).
    IF lv_etag IS NOT INITIAL.
      lv_fields = '"@odata.etag":' && quote( lv_etag ).
      lv_sep = ','.
    ENDIF.
    LOOP AT is_set-properties INTO ls_prop.
      IF it_select IS NOT INITIAL.
        READ TABLE it_select WITH KEY table_line = ls_prop-name TRANSPORTING NO FIELDS.
        IF sy-subrc <> 0.
          CONTINUE.
        ENDIF.
      ENDIF.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE is_data TO <lv_value>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_prop-name ).
      lv_fields = lv_fields && lv_sep && quote( ls_prop-name ) && ':' &&
        value( iv_value = <lv_value> iv_type = ls_info-edm_type ).
      lv_sep = ','.
    ENDLOOP.
    LOOP AT it_nav INTO ls_nav.
      lv_fields = lv_fields && lv_sep && quote( ls_nav-name ) && ':' && ls_nav-json.
      lv_sep = ','.
    ENDLOOP.
    rv_json = '{' && lv_fields && '}'.
  ENDMETHOD.

  METHOD etag.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_text TYPE string.
    DATA lv_tag TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_found TYPE abap_bool.
    FIELD-SYMBOLS <lv_value> TYPE any.
    LOOP AT is_set-properties INTO ls_prop.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_prop-name ).
      IF ls_info-is_etag = abap_false.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE is_data TO <lv_value>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      lv_text = value( iv_value = <lv_value> iv_type = ls_info-edm_type ).
      IF strlen( lv_text ) >= 2 AND lv_text(1) = '"'.
        lv_text = substring( val = lv_text off = 1 len = strlen( lv_text ) - 2 ).
      ENDIF.
* escaped, so the tag carries no quote, comma or semicolon of its own; the
* semicolon separates the values of several ETag properties
      lv_tag = lv_tag && lv_sep && cl_http_utility=>escape_url( lv_text ).
      lv_sep = ';'.
      lv_found = abap_true.
    ENDLOOP.
    IF lv_found = abap_true.
      rv_etag = |W/"{ lv_tag }"|.
    ENDIF.
  ENDMETHOD.

  METHOD key_predicate.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA ls_info TYPE zcl_osd_v4_model=>ty_property.
    DATA lv_text TYPE string.
    DATA lv_sep TYPE string.
    DATA lv_count TYPE i.
    FIELD-SYMBOLS <lv_value> TYPE any.
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      lv_count = lv_count + 1.
    ENDLOOP.
    LOOP AT is_set-properties INTO ls_prop WHERE is_key = abap_true.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE is_data TO <lv_value>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ls_info = io_model->property( iv_type = is_set-entity_type iv_name = ls_prop-name ).
      IF ls_info-edm_type = 'Edm.String'.
        lv_text = <lv_value>.
        REPLACE ALL OCCURRENCES OF |'| IN lv_text WITH |''|.
        lv_text = |'{ escape_key_value( lv_text ) }'|.
      ELSE.
        lv_text = value( iv_value = <lv_value> iv_type = ls_info-edm_type ).
        REPLACE ALL OCCURRENCES OF '"' IN lv_text WITH ''.
      ENDIF.
      IF lv_count > 1.
        lv_text = ls_prop-name && '=' && lv_text.
      ENDIF.
      rv_key = rv_key && lv_sep && lv_text.
      lv_sep = ','.
    ENDLOOP.
  ENDMETHOD.

  METHOD escape_key_value.
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
      IF lv_char CA 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789.-_()'.
* the characters escape_url keeps
        rv_value = rv_value && lv_char.
      ELSE.
        lv_unit = cl_abap_conv_out_ce=>uccp( lv_char ).
        IF lv_unit < '0080'.
* an ASCII byte: the escape escape_url writes, % and lowercase hex
          rv_value = rv_value && '%' && to_lower( cl_abap_codepage=>convert_to( lv_char ) ).
        ELSE.
* a character outside the BMP is two UTF-16 units, a high and a low
* surrogate: it is encoded as one code point, not as two halves
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
      ENDIF.
      lv_index = lv_index + lv_size.
    ENDWHILE.
  ENDMETHOD.

  METHOD document.
    rv_json = '{"@odata.context":' && quote( iv_context ).
    IF iv_entity <> '{}'.
      rv_json = rv_json && ',' && substring( val = iv_entity off = 1 ).
    ELSE.
      rv_json = rv_json && '}'.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
