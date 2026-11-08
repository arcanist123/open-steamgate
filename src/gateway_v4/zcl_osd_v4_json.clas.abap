CLASS zcl_osd_v4_json DEFINITION PUBLIC CREATE PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS quote IMPORTING iv_text TYPE string RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS value IMPORTING iv_value TYPE any iv_type TYPE string
      RETURNING VALUE(rv_json) TYPE string.
    CLASS-METHODS entity IMPORTING is_data TYPE any
      is_set TYPE zcl_stg_model_info=>ty_entity_set io_model TYPE REF TO zcl_osd_v4_model
      it_select TYPE string_table OPTIONAL it_nav TYPE zcl_stg_json=>ty_nav_jsons OPTIONAL
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
    FIELD-SYMBOLS <lv_value> TYPE any.
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
ENDCLASS.
