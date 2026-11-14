CLASS zcl_osd_session_langu DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The session language of a request: what it asks for (the sap-language
* URL parameter, else the first language of its Accept-Language header),
* and the switch of the system field for the request. SET LOCALE LANGUAGE
* is a no-op in the transpiler's runtime (ANORMALIES.md, set-locale-noop),
* so the field is set itself. The one implementation for every caller:
* the OData dispatcher, and whatever else serves a request in a language.
* Public methods REQUESTED and SWITCH are stable.
*
* Its own class so that a caller touches no system field on a request that
* names no language: the Go host's compiler does not carry sy-langu yet.
  PUBLIC SECTION.
* the SAP language key the request asks for, '' when it asks for none or
* for one this system does not know: sap-language (ISO 'DE' or the key
* 'D') wins; without it the first tag of Accept-Language ('de-DE,de;q=0.9'
* is 'D'; '*' is none)
    CLASS-METHODS requested
      IMPORTING
        it_options      TYPE tihttpnvp OPTIONAL
        it_headers      TYPE tihttpnvp OPTIONAL
      RETURNING
        VALUE(rv_langu) TYPE sy-langu.
* switch to the language, returning the one in force before
    CLASS-METHODS switch
      IMPORTING
        iv_langu           TYPE sy-langu
      RETURNING
        VALUE(rv_previous) TYPE sy-langu.
  PRIVATE SECTION.
    CLASS-METHODS key_of
      IMPORTING
        iv_value        TYPE string
      RETURNING
        VALUE(rv_langu) TYPE sy-langu.
ENDCLASS.

CLASS zcl_osd_session_langu IMPLEMENTATION.

  METHOD requested.
    DATA ls_pair  LIKE LINE OF it_options.
    DATA lv_value TYPE string.
    DATA lv_rest  TYPE string.

    LOOP AT it_options INTO ls_pair.
      IF to_lower( ls_pair-name ) = 'sap-language'.
        lv_value = to_upper( condense( ls_pair-value ) ).
      ENDIF.
    ENDLOOP.
    IF lv_value IS NOT INITIAL.
      rv_langu = key_of( lv_value ).
      RETURN.
    ENDIF.
    LOOP AT it_headers INTO ls_pair.
      IF to_lower( ls_pair-name ) = 'accept-language'.
        lv_value = ls_pair-value.
      ENDIF.
    ENDLOOP.
    IF lv_value IS INITIAL.
      RETURN.
    ENDIF.
* the first language range; its primary subtag
    SPLIT lv_value AT ',' INTO lv_value lv_rest.
    SPLIT lv_value AT ';' INTO lv_value lv_rest.
    SPLIT lv_value AT '-' INTO lv_value lv_rest.
    lv_value = to_upper( condense( lv_value ) ).
    IF strlen( lv_value ) = 2.
      rv_langu = key_of( lv_value ).
    ENDIF.
  ENDMETHOD.

  METHOD key_of.
    DATA lv_sap1 TYPE sy-langu.

    CASE strlen( iv_value ).
      WHEN 1.
        rv_langu = iv_value.
      WHEN 2.
        CALL FUNCTION 'CONVERSION_EXIT_ISOLA_INPUT'
          EXPORTING
            input            = iv_value
          IMPORTING
            output           = lv_sap1
          EXCEPTIONS
            unknown_language = 1
            OTHERS           = 2.
        IF sy-subrc = 0.
          rv_langu = lv_sap1.
        ENDIF.
    ENDCASE.
  ENDMETHOD.

  METHOD switch.
    rv_previous = sy-langu.
    sy-langu = iv_langu.
  ENDMETHOD.

ENDCLASS.
