"! Small XML pattern scanners. No XML decoding: Node consumes raw captures.
"! Boundaries are JavaScript ASCII word boundaries, not XML name boundaries.
CLASS zcl_osd_adt_scan DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_block,
             attributes TYPE string,
             content TYPE string,
           END OF ty_block.
    TYPES tt_block TYPE STANDARD TABLE OF ty_block WITH DEFAULT KEY.
    TYPES tt_object TYPE STANDARD TABLE OF zcl_osd_adt_types=>ty_object WITH DEFAULT KEY.
    CLASS-METHODS attribute IMPORTING iv_xml TYPE string iv_element TYPE string OPTIONAL iv_name TYPE string
      EXPORTING ev_value TYPE string ev_found TYPE abap_bool.
    CLASS-METHODS references IMPORTING iv_xml TYPE string RETURNING VALUE(rt_objects) TYPE tt_object.
    CLASS-METHODS blocks IMPORTING iv_xml TYPE string iv_element TYPE string RETURNING VALUE(rt_blocks) TYPE tt_block.
    CLASS-METHODS first_tag_value IMPORTING iv_xml TYPE string iv_tag TYPE string
      EXPORTING ev_value TYPE string ev_found TYPE abap_bool.
    "! every text value of <tag>...</tag>, in document order, raw (not
    "! decoded); a tag whose content holds markup is passed over, as in
    "! first_tag_value
    CLASS-METHODS tag_values IMPORTING iv_xml TYPE string iv_tag TYPE string
      RETURNING VALUE(rt_values) TYPE string_table.
  PRIVATE SECTION.
    CLASS-METHODS word IMPORTING iv_char TYPE string RETURNING VALUE(rv_word) TYPE abap_bool.
    CLASS-METHODS opening IMPORTING iv_xml TYPE string iv_element TYPE string iv_start TYPE i DEFAULT 0
      EXPORTING ev_start TYPE i ev_end TYPE i ev_found TYPE abap_bool.
ENDCLASS.
CLASS zcl_osd_adt_scan IMPLEMENTATION.
  METHOD word.
    rv_word = boolc( iv_char IS NOT INITIAL AND iv_char CO `ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_` ).
  ENDMETHOD.
  METHOD opening.
    DATA lv_token TYPE string.
    DATA lv_off TYPE i.
    DATA lv_after TYPE i.
    DATA lv_rest TYPE string.
    DATA lv_char TYPE string.
    DATA lv_end TYPE i.
    CLEAR ev_found.
    IF iv_element IS INITIAL.
      RETURN.
    ENDIF.
    lv_token = `<` && iv_element.
    lv_off = iv_start.
    WHILE lv_off < strlen( iv_xml ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_token IN lv_rest MATCH OFFSET ev_start.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      ev_start = ev_start + lv_off.
      lv_after = ev_start + strlen( lv_token ).
      CLEAR lv_char.
      IF lv_after < strlen( iv_xml ).
        lv_char = iv_xml+lv_after(1).
      ENDIF.
      IF word( lv_char ) <> word( substring( val = iv_element off = strlen( iv_element ) - 1 ) ).
        lv_rest = substring( val = iv_xml off = lv_after ).
        FIND FIRST OCCURRENCE OF `>` IN lv_rest MATCH OFFSET lv_end.
        IF sy-subrc = 0.
          ev_end = lv_after + lv_end + 1.
          ev_found = abap_true.
          RETURN.
        ENDIF.
      ENDIF.
      lv_off = lv_after.
    ENDWHILE.
  ENDMETHOD.
  METHOD attribute.
    DATA lv_scope TYPE string.
    DATA lv_token TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_off TYPE i.
    DATA lv_pos TYPE i.
    DATA lv_char TYPE string.
    DATA lv_found TYPE abap_bool.
    CLEAR: ev_value, ev_found.
    lv_scope = iv_xml.
    IF iv_element IS NOT INITIAL.
      opening( EXPORTING iv_xml = iv_xml iv_element = iv_element
        IMPORTING ev_start = lv_start ev_end = lv_end ev_found = lv_found ).
      IF lv_found = abap_false.
        RETURN.
      ENDIF.
      lv_end = lv_end - lv_start.
      lv_scope = iv_xml+lv_start(lv_end).
    ENDIF.
    lv_token = iv_name && `="`.
    WHILE lv_off < strlen( lv_scope ).
      lv_rest = substring( val = lv_scope off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_token IN lv_rest MATCH OFFSET lv_pos.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_pos = lv_pos + lv_off.
      CLEAR lv_char.
      IF lv_pos > 0.
        lv_start = lv_pos - 1.
        lv_char = lv_scope+lv_start(1).
      ENDIF.
      lv_off = lv_pos + strlen( lv_token ).
      IF word( lv_char ) = word( substring( val = iv_name len = 1 ) ).
        CONTINUE.
      ENDIF.
      lv_rest = substring( val = lv_scope off = lv_off ).
      FIND FIRST OCCURRENCE OF `"` IN lv_rest MATCH OFFSET lv_end.
      IF sy-subrc = 0.
        ev_value = lv_rest(lv_end).
        ev_found = abap_true.
      ENDIF.
      RETURN.
    ENDWHILE.
  ENDMETHOD.
  METHOD blocks.
    DATA lv_off TYPE i.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_close TYPE i.
    DATA lv_len TYPE i.
    DATA lv_rest TYPE string.
    DATA lv_token TYPE string.
    DATA lv_found TYPE abap_bool.
    DATA ls_block TYPE ty_block.
    lv_token = `</` && iv_element && `>`.
    WHILE lv_off < strlen( iv_xml ).
      opening( EXPORTING iv_xml = iv_xml iv_element = iv_element iv_start = lv_off
        IMPORTING ev_start = lv_start ev_end = lv_end ev_found = lv_found ).
      IF lv_found = abap_false.
        RETURN.
      ENDIF.
      lv_rest = substring( val = iv_xml off = lv_end ).
      FIND FIRST OCCURRENCE OF lv_token IN lv_rest MATCH OFFSET lv_close.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_start = lv_start + strlen( iv_element ) + 1.
      lv_len = lv_end - lv_start - 1.
      ls_block-attributes = iv_xml+lv_start(lv_len).
      ls_block-content = lv_rest(lv_close).
      APPEND ls_block TO rt_blocks.
      lv_off = lv_end + lv_close + strlen( lv_token ).
    ENDWHILE.
  ENDMETHOD.
  METHOD first_tag_value.
    DATA lv_open TYPE string.
    DATA lv_close TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_off TYPE i.
    DATA lv_value TYPE string.
    CLEAR: ev_value, ev_found.
    lv_open = `<` && iv_tag && `>`.
    lv_close = `</` && iv_tag && `>`.
    WHILE lv_off < strlen( iv_xml ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_open IN lv_rest MATCH OFFSET lv_start.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_off = lv_off + lv_start + strlen( lv_open ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_close IN lv_rest MATCH OFFSET lv_end.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_value = lv_rest(lv_end).
      IF lv_value NA `<`.
        ev_value = lv_value.
        ev_found = abap_true.
        RETURN.
      ENDIF.
    ENDWHILE.
  ENDMETHOD.
  METHOD references.
    DATA lv_rest TYPE string.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_off TYPE i.
    DATA lv_uri TYPE string.
    DATA ls_object TYPE zcl_osd_adt_types=>ty_object.
    WHILE lv_off < strlen( iv_xml ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF `adtcore:uri="` IN lv_rest MATCH OFFSET lv_start.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_off = lv_off + lv_start + 13.
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF `"` IN lv_rest MATCH OFFSET lv_end.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_uri = lv_rest(lv_end).
      lv_off = lv_off + lv_end + 1.
      IF lv_uri IS INITIAL.
        CONTINUE.
      ENDIF.
      ls_object = zcl_osd_adt_types=>object_from_uri( lv_uri ).
      IF ls_object-found = abap_true.
        APPEND ls_object TO rt_objects.
      ENDIF.
    ENDWHILE.
  ENDMETHOD.
  METHOD tag_values.
    DATA lv_open TYPE string.
    DATA lv_close TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_start TYPE i.
    DATA lv_end TYPE i.
    DATA lv_off TYPE i.
    DATA lv_value TYPE string.
    lv_open = `<` && iv_tag && `>`.
    lv_close = `</` && iv_tag && `>`.
    WHILE lv_off < strlen( iv_xml ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_open IN lv_rest MATCH OFFSET lv_start.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_off = lv_off + lv_start + strlen( lv_open ).
      lv_rest = substring( val = iv_xml off = lv_off ).
      FIND FIRST OCCURRENCE OF lv_close IN lv_rest MATCH OFFSET lv_end.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_value = lv_rest(lv_end).
      IF lv_value NA `<`.
        APPEND lv_value TO rt_values.
      ENDIF.
      lv_off = lv_off + lv_end + strlen( lv_close ).
    ENDWHILE.
  ENDMETHOD.
ENDCLASS.
