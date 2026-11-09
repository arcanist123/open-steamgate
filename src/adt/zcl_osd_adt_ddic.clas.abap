CLASS zcl_osd_adt_ddic DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_field,
      name TYPE string, element TYPE string, datatype TYPE string,
      description TYPE string, letter TYPE string, length TYPE string, decimals TYPE string, key TYPE abap_bool, notnull TYPE abap_bool,
    END OF ty_field.
    TYPES tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_table,
      name TYPE string, description TYPE string, delivery TYPE string, maintenance TYPE string,
      fields TYPE tt_field,
    END OF ty_table.
    CLASS-METHODS tag IMPORTING iv_xml TYPE string iv_tag TYPE string RETURNING VALUE(rv_text) TYPE string.
    CLASS-METHODS js_int IMPORTING iv_text TYPE string RETURNING VALUE(rv_text) TYPE string.
    "! Resolver hook for C4: ELEMENT is retained for resolution after parsing.
    "! These document routes deliberately do not call a type resolver.
    CLASS-METHODS table_fields IMPORTING iv_xml TYPE string iv_name TYPE string iv_resolve TYPE abap_bool DEFAULT abap_false RETURNING VALUE(rs_table) TYPE ty_table.
    CLASS-METHODS table_source IMPORTING is_table TYPE ty_table RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS table_document IMPORTING iv_name TYPE string iv_package TYPE string iv_description TYPE string RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS data_element IMPORTING iv_xml TYPE string iv_name TYPE string iv_package TYPE string RETURNING VALUE(rv_body) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS resolve IMPORTING iv_element TYPE string CHANGING cs_field TYPE ty_field.
    CLASS-METHODS letter IMPORTING iv_type TYPE string iv_default TYPE string RETURNING VALUE(rv_letter) TYPE string.
ENDCLASS.
CLASS zcl_osd_adt_ddic IMPLEMENTATION.
  METHOD zif_osd_adt_route~handle.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    DATA lv_type TYPE string.
    DATA lv_name TYPE string.
    DATA lv_source TYPE string.
    DATA lv_json TYPE string.
    DATA lv_error TYPE string.
    DATA lv_package TYPE string.
    DATA lt_objects TYPE STANDARD TABLE OF zosd_object_s WITH DEFAULT KEY.
    DATA ls_object LIKE LINE OF lt_objects.
    DATA ls_table TYPE ty_table.
    DATA lv_body TYPE string.
    CASE is_request-pattern.
      WHEN `/sap/bc/adt/ddic/tables/parser/info`.
        lx_error = zcx_osd_adt=>not_found( iv_message = `the DDL parser information is the system's own and is not served here` iv_miss = zcx_osd_adt=>c_miss_resource ).
        RAISE EXCEPTION lx_error.
      WHEN `/sap/bc/adt/ddic/dataelements/:name`.
        lv_type = `DTEL`.
      WHEN `/sap/bc/adt/ddic/tables/:name` OR `/sap/bc/adt/ddic/tables/:name/source/main`.
        lv_type = `TABL`.
      WHEN OTHERS.
        lx_error = zcx_osd_adt=>internal( |unknown DDIC route pattern: { is_request-pattern }| ).
        RAISE EXCEPTION lx_error.
    ENDCASE.
    READ TABLE is_request-params WITH KEY name = `name` INTO ls_param.
    CALL FUNCTION 'ZOSD_STORE' DESTINATION 'STORE'
      EXPORTING iv_command = `READ` iv_type = lv_type iv_name = ls_param-value iv_include = `main`
      IMPORTING ev_source = lv_source ev_package = lv_package ev_json = lv_json ev_error = lv_error
      TABLES et_object = lt_objects
      EXCEPTIONS OTHERS = 1.
    IF sy-subrc <> 0.
      lx_error = zcx_osd_adt=>internal( `no object store here` ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    TRY.
        zcl_osd_adt_host=>check_error( iv_json = lv_json iv_error = lv_error ).
      CATCH zcx_osd_adt INTO lx_error.
        IF lx_error->status = 404.
          lx_error = zcx_osd_adt=>not_found( |{ lv_type } { ls_param-value } does not exist| ).
        ENDIF.
        RAISE EXCEPTION lx_error.
    ENDTRY.
    READ TABLE lt_objects INDEX 1 INTO ls_object.
    lv_name = ls_object-name.
    IF lv_type = `DTEL`.
      rs_response-status = 200.
      rs_response-content_type = `application/vnd.sap.adt.dataelements.v2+xml; charset=utf-8`.
      rs_response-body = data_element( iv_xml = lv_source iv_name = lv_name iv_package = lv_package ).
    ELSE.
      ls_table = table_fields( iv_xml = lv_source iv_name = lv_name ).
      IF is_request-pattern = `/sap/bc/adt/ddic/tables/:name/source/main`.
        lv_body = table_source( ls_table ).
        rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = lv_body iv_type = `text/plain; charset=utf-8` ).
      ELSE.
        lv_body = table_document( iv_name = lv_name iv_package = lv_package iv_description = ls_table-description ).
        rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = lv_body iv_type = `application/vnd.sap.adt.tables.v2+xml; charset=utf-8` ).
      ENDIF.
    ENDIF.
  ENDMETHOD.
  METHOD tag.
    zcl_osd_adt_scan=>first_tag_value( EXPORTING iv_xml = iv_xml iv_tag = iv_tag IMPORTING ev_value = rv_text ).
    rv_text = zcl_osd_adt_xml=>unesc( rv_text ).
  ENDMETHOD.
  METHOD js_int.
    DATA lv_digits TYPE string.
    DATA lv_sign TYPE string.
    DATA lv_text TYPE string.
    lv_text = iv_text.
    IF lv_text IS INITIAL.
      lv_text = `0`.
    ENDIF.
    lv_text = zcl_osd_adt_js=>trim( lv_text ).
    FIND FIRST OCCURRENCE OF REGEX `^([+-]?)([0-9]+)` IN lv_text SUBMATCHES lv_sign lv_digits.
    IF sy-subrc <> 0.
      rv_text = `NaN`.
      RETURN.
    ENDIF.
    SHIFT lv_digits LEFT DELETING LEADING `0`.
    IF lv_digits IS INITIAL.
      rv_text = `0`.
    ELSEIF lv_sign = `-`.
      rv_text = `-` && lv_digits.
    ELSE.
      rv_text = lv_digits.
    ENDIF.
  ENDMETHOD.
  METHOD table_fields.
    DATA lv_head TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_block TYPE string.
    DATA lv_off TYPE i.
    DATA ls_field TYPE ty_field.
    DATA lt_resolved TYPE HASHED TABLE OF ty_field WITH UNIQUE KEY element.
    DATA ls_resolved TYPE ty_field.
    rs_table-name = iv_name.
    lv_head = iv_xml.
    FIND FIRST OCCURRENCE OF `<DD03P_TABLE>` IN lv_head MATCH OFFSET lv_off.
    IF sy-subrc = 0.
      lv_head = lv_head(lv_off).
    ENDIF.
    rs_table-description = tag( iv_xml = lv_head iv_tag = `DDTEXT` ).
    rs_table-delivery = tag( iv_xml = lv_head iv_tag = `CONTFLAG` ).
    IF rs_table-delivery IS INITIAL.
      rs_table-delivery = `A`.
    ENDIF.
    rs_table-maintenance = `#RESTRICTED`.
    IF tag( iv_xml = lv_head iv_tag = `MAINFLAG` ) = `X`.
      rs_table-maintenance = `#ALLOWED`.
    ENDIF.
    lv_rest = iv_xml.
    DO.
      FIND FIRST OCCURRENCE OF `<DD03P>` IN lv_rest MATCH OFFSET lv_off.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
      lv_rest = substring( val = lv_rest off = lv_off + 7 ).
      FIND FIRST OCCURRENCE OF `</DD03P>` IN lv_rest MATCH OFFSET lv_off.
      IF sy-subrc <> 0.
        EXIT.
      ENDIF.
      lv_block = lv_rest(lv_off).
      lv_rest = substring( val = lv_rest off = lv_off + 8 ).
      CLEAR ls_field.
      ls_field-name = tag( iv_xml = lv_block iv_tag = `FIELDNAME` ).
      IF ls_field-name IS INITIAL OR ls_field-name(1) = `.`.
        CONTINUE.
      ENDIF.
      ls_field-element = tag( iv_xml = lv_block iv_tag = `ROLLNAME` ).
      ls_field-datatype = tag( iv_xml = lv_block iv_tag = `DATATYPE` ).
      ls_field-length = js_int( tag( iv_xml = lv_block iv_tag = `LENG` ) ).
      ls_field-decimals = js_int( tag( iv_xml = lv_block iv_tag = `DECIMALS` ) ).
      ls_field-key = boolc( tag( iv_xml = lv_block iv_tag = `KEYFLAG` ) = `X` ).
      ls_field-notnull = boolc( tag( iv_xml = lv_block iv_tag = `NOTNULL` ) = `X` ).
      ls_field-description = tag( iv_xml = lv_block iv_tag = `DDTEXT` ).
      IF iv_resolve = abap_true.
        IF ls_field-element IS NOT INITIAL AND ls_field-datatype IS INITIAL.
          READ TABLE lt_resolved WITH TABLE KEY element = ls_field-element INTO ls_resolved.
          IF sy-subrc <> 0.
            CLEAR ls_resolved.
            ls_resolved-element = ls_field-element.
            resolve( EXPORTING iv_element = ls_field-element CHANGING cs_field = ls_resolved ).
            INSERT ls_resolved INTO TABLE lt_resolved.
          ENDIF.
          IF ls_resolved-datatype IS NOT INITIAL.
            ls_field-datatype = ls_resolved-datatype.
            ls_field-length = ls_resolved-length.
            ls_field-decimals = ls_resolved-decimals.
            IF ls_field-description IS INITIAL.
              ls_field-description = ls_resolved-description.
            ENDIF.
          ENDIF.
        ENDIF.
        ls_field-letter = letter( iv_type = ls_field-datatype iv_default = tag( iv_xml = lv_block iv_tag = `INTTYPE` ) ).
      ENDIF.
      APPEND ls_field TO rs_table-fields.
    ENDDO.
  ENDMETHOD.
  METHOD table_document.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<blue:blueSource xmlns:blue="http://www.sap.com/wbobj/blue"\n|
      && |                 xmlns:abapsource="http://www.sap.com/adt/abapsource"\n|
      && |                 xmlns:adtcore="http://www.sap.com/adt/core"\n|
      && |                 xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && |                 abapsource:sourceUri="./{ zcl_osd_adt_uri=>encode_component( to_lower( iv_name ) ) }/source/main"\n|
      && |                 abapsource:fixPointArithmetic="false" abapsource:activeUnicodeCheck="false"\n|
      && |                 adtcore:responsible="{ `OSD` }" adtcore:masterLanguage="EN" adtcore:abapLanguageVersion="standard"\n|
      && |                 adtcore:name="{ zcl_osd_adt_xml=>esc( iv_name ) }" adtcore:type="TABL/DT"\n|
      && |                 adtcore:changedAt="{ `1970-01-01T00:00:00Z` }" adtcore:version="{ `active` }" adtcore:createdAt="{ `1970-01-01T00:00:00Z` }"\n|
      && |                 adtcore:changedBy="{ `OSD` }" adtcore:createdBy="{ `OSD` }"\n|
      && |                 adtcore:description="{ zcl_osd_adt_xml=>esc( iv_description ) }" adtcore:language="EN">\n|
      && |  <atom:link href="/sap/bc/adt/repository/informationsystem/abaplanguageversions?uri={ zcl_osd_adt_uri=>encode_component( `/sap/bc/adt/ddic/tables/` && to_lower( iv_name ) ) }" rel="http://www.sap.com/adt/relations/informationsystem/abaplanguageversions" type="application/vnd.sap.adt.nameditems.v1+xml" title="Allowed ABAP language versions"/>\n|
      && |  <atom:link href="./{ zcl_osd_adt_uri=>encode_component( to_lower( iv_name ) ) }/source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain" title="Source Content"/>\n|
      && |  <adtcore:packageRef adtcore:uri="/sap/bc/adt/packages/{ zcl_osd_adt_uri=>encode_component( to_lower( iv_package ) ) }" adtcore:type="DEVC/K" adtcore:name="{ zcl_osd_adt_xml=>esc( iv_package ) }"/>\n|
      && |</blue:blueSource>\n|.
  ENDMETHOD.
  METHOD data_element.
    DATA lv_kind TYPE string.
    DATA lv_name TYPE string.
    DATA lv_short TYPE string.
    DATA lv_medium TYPE string.
    DATA lv_long TYPE string.
    DATA lv_heading TYPE string.
    DATA lv_nohistory TYPE string.
    DATA lv_logflag TYPE string.
    DATA lv_ltrflddis TYPE string.
    DATA lv_bidictrlc TYPE string.
    lv_name = tag( iv_xml = iv_xml iv_tag = `DOMNAME` ).
    lv_kind = `predefinedAbapType`.
    IF lv_name IS NOT INITIAL.
      lv_kind = `domain`.
    ELSE.
      lv_name = tag( iv_xml = iv_xml iv_tag = `ROLLNAME` ).
    ENDIF.
    CASE tag( iv_xml = iv_xml iv_tag = `REFKIND` ).
      WHEN `D`.
        lv_kind = `refToDictionaryType`.
      WHEN `R`.
        lv_kind = `refToPredefinedAbapType`.
        IF tag( iv_xml = iv_xml iv_tag = `REFTYPE` ) = `C` OR tag( iv_xml = iv_xml iv_tag = `REFTYPE` ) = `I`.
          lv_kind = `refToClifType`.
        ENDIF.
    ENDCASE.
    lv_short = js_int( tag( iv_xml = iv_xml iv_tag = `SCRLEN1` ) ).
    IF lv_short = `0` OR lv_short = `NaN`.
      lv_short = `10`.
    ENDIF.
    lv_medium = js_int( tag( iv_xml = iv_xml iv_tag = `SCRLEN2` ) ).
    IF lv_medium = `0` OR lv_medium = `NaN`.
      lv_medium = `20`.
    ENDIF.
    lv_long = js_int( tag( iv_xml = iv_xml iv_tag = `SCRLEN3` ) ).
    IF lv_long = `0` OR lv_long = `NaN`.
      lv_long = `40`.
    ENDIF.
    lv_heading = js_int( tag( iv_xml = iv_xml iv_tag = `HEADLEN` ) ).
    IF lv_heading = `0` OR lv_heading = `NaN`.
      lv_heading = `55`.
    ENDIF.
    lv_nohistory = `false`.
    IF tag( iv_xml = iv_xml iv_tag = `NOHISTORY` ) = `X`.
      lv_nohistory = `true`.
    ENDIF.
    lv_logflag = `false`.
    IF tag( iv_xml = iv_xml iv_tag = `LOGFLAG` ) = `X`.
      lv_logflag = `true`.
    ENDIF.
    lv_ltrflddis = `false`.
    IF tag( iv_xml = iv_xml iv_tag = `LTRFLDDIS` ) = `X`.
      lv_ltrflddis = `true`.
    ENDIF.
    lv_bidictrlc = `false`.
    IF tag( iv_xml = iv_xml iv_tag = `BIDICTRLC` ) = `X`.
      lv_bidictrlc = `true`.
    ENDIF.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<blue:wbobj xmlns:blue="http://www.sap.com/wbobj/dictionary/dtel"\n|
      && |            xmlns:adtcore="http://www.sap.com/adt/core"\n|
      && |            xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && |            adtcore:name="{ zcl_osd_adt_xml=>esc( iv_name ) }" adtcore:type="DTEL/DE"\n|
      && |            adtcore:version="active" adtcore:masterLanguage="EN" adtcore:language="EN"\n|
      && |            adtcore:responsible="{ `OSD` }" adtcore:changedBy="{ `OSD` }" adtcore:createdBy="{ `OSD` }"\n|
      && |            adtcore:changedAt="{ `1970-01-01T00:00:00Z` }" adtcore:createdAt="{ `1970-01-01T00:00:00Z` }"\n|
      && |            adtcore:description="{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `DDTEXT` ) ) }" adtcore:abapLanguageVersion="standard">\n|
      && |  <atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain"/>\n|
      && |  <adtcore:packageRef adtcore:name="{ zcl_osd_adt_xml=>esc( iv_package ) }" adtcore:type="DEVC/K"\n|
      && |   adtcore:uri="/sap/bc/adt/packages/{ zcl_osd_adt_uri=>encode_component( to_lower( iv_package ) ) }"/>\n|
      && |  <dtel:dataElement xmlns:dtel="http://www.sap.com/adt/dictionary/dataelements">\n|
      && |    <dtel:typeKind>{ lv_kind }</dtel:typeKind>\n|
      && |    <dtel:typeName>{ zcl_osd_adt_xml=>esc( lv_name ) }</dtel:typeName>\n|
      && |    <dtel:dataType>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `DATATYPE` ) ) }</dtel:dataType>\n|
      && |    <dtel:dataTypeLength>{ js_int( tag( iv_xml = iv_xml iv_tag = `LENG` ) ) }</dtel:dataTypeLength>\n|
      && |    <dtel:dataTypeDecimals>{ js_int( tag( iv_xml = iv_xml iv_tag = `DECIMALS` ) ) }</dtel:dataTypeDecimals>\n|
      && |    <dtel:shortFieldLabel>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `SCRTEXT_S` ) ) }</dtel:shortFieldLabel>\n|
      && |    <dtel:shortFieldLength>{ lv_short }</dtel:shortFieldLength>\n|
      && |    <dtel:shortFieldMaxLength>10</dtel:shortFieldMaxLength>\n|
      && |    <dtel:mediumFieldLabel>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `SCRTEXT_M` ) ) }</dtel:mediumFieldLabel>\n|
      && |    <dtel:mediumFieldLength>{ lv_medium }</dtel:mediumFieldLength>\n|
      && |    <dtel:mediumFieldMaxLength>20</dtel:mediumFieldMaxLength>\n|
      && |    <dtel:longFieldLabel>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `SCRTEXT_L` ) ) }</dtel:longFieldLabel>\n|
      && |    <dtel:longFieldLength>{ lv_long }</dtel:longFieldLength>\n|
      && |    <dtel:longFieldMaxLength>40</dtel:longFieldMaxLength>\n|
      && |    <dtel:headingFieldLabel>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `REPTEXT` ) ) }</dtel:headingFieldLabel>\n|
      && |    <dtel:headingFieldLength>{ lv_heading }</dtel:headingFieldLength>\n|
      && |    <dtel:headingFieldMaxLength>55</dtel:headingFieldMaxLength>\n|
      && |    <dtel:searchHelp>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `SHLPNAME` ) ) }</dtel:searchHelp>\n|
      && |    <dtel:searchHelpParameter>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `SHLPFIELD` ) ) }</dtel:searchHelpParameter>\n|
      && |    <dtel:setGetParameter>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `MEMORYID` ) ) }</dtel:setGetParameter>\n|
      && |    <dtel:defaultComponentName>{ zcl_osd_adt_xml=>esc( tag( iv_xml = iv_xml iv_tag = `DEFFDNAME` ) ) }</dtel:defaultComponentName>\n|
      && |    <dtel:deactivateInputHistory>{ lv_nohistory }</dtel:deactivateInputHistory>\n|
      && |    <dtel:changeDocument>{ lv_logflag }</dtel:changeDocument>\n|
      && |    <dtel:leftToRightDirection>{ lv_ltrflddis }</dtel:leftToRightDirection>\n|
      && |    <dtel:deactivateBIDIFiltering>{ lv_bidictrlc }</dtel:deactivateBIDIFiltering>\n|
      && |  </dtel:dataElement>\n|
      && |</blue:wbobj>\n|.
  ENDMETHOD.
  METHOD table_source.
    DATA lv_width TYPE i.
    DATA ls_field TYPE ty_field.
    DATA lv_name TYPE string.
    DATA lv_type TYPE string.
    DATA lv_kind TYPE string.
    DATA lv_key TYPE string.
    DATA lv_null TYPE string.
    DATA lv_lines TYPE string.
    DATA lv_first TYPE abap_bool VALUE abap_true.
    DATA lv_description TYPE string.
    LOOP AT is_table-fields INTO ls_field.
      lv_width = nmax( val1 = lv_width val2 = strlen( ls_field-name ) ).
    ENDLOOP.
    LOOP AT is_table-fields INTO ls_field.
      lv_name = to_lower( ls_field-name ).
      WHILE strlen( lv_name ) < lv_width.
        lv_name = lv_name && ` `.
      ENDWHILE.
      IF ls_field-element IS NOT INITIAL.
        lv_type = to_lower( ls_field-element ).
      ELSE.
        lv_kind = to_upper( ls_field-datatype ).
        lv_type = to_lower( lv_kind ).
        CASE lv_kind.
          WHEN `RSTR`.
            lv_type = `rawstring`.
          WHEN `STRG`.
            lv_type = `string`.
          WHEN `SSTR`.
            lv_type = `sstring`.
        ENDCASE.
        lv_type = `abap.` && lv_type.
        CASE lv_kind.
          WHEN `DEC` OR `CURR` OR `QUAN` OR `DF16_DEC` OR `DF34_DEC`.
            lv_type = lv_type && `(` && ls_field-length && `,` && ls_field-decimals && `)`.
          WHEN `CHAR` OR `NUMC` OR `RAW` OR `LCHR` OR `LRAW` OR `RSTR` OR `STRG` OR `SSTR`.
            lv_type = lv_type && `(` && ls_field-length && `)`.
        ENDCASE.
      ENDIF.
      lv_key = `    `.
      IF ls_field-key = abap_true.
        lv_key = `key `.
      ENDIF.
      CLEAR lv_null.
      IF ls_field-notnull = abap_true.
        lv_null = ` not null`.
      ENDIF.
      IF lv_first = abap_false.
        lv_lines = lv_lines && cl_abap_char_utilities=>newline.
      ENDIF.
      lv_first = abap_false.
      lv_lines = lv_lines && `  ` && lv_key && lv_name && ` : ` && lv_type && lv_null && `;`.
    ENDLOOP.
    lv_description = is_table-description.
    REPLACE ALL OCCURRENCES OF `'` IN lv_description WITH `''`.
    rv_body = |@EndUserText.label : '{ lv_description }'\n|
      && |@AbapCatalog.enhancement.category : #NOT_EXTENSIBLE\n|
      && |@AbapCatalog.tableCategory : #TRANSPARENT\n|
      && |@AbapCatalog.deliveryClass : #{ is_table-delivery }\n|
      && |@AbapCatalog.dataMaintenance : { is_table-maintenance }\n|
      && |define table { to_lower( is_table-name ) } \{\n\n{ lv_lines }\n\n\}\n|.
  ENDMETHOD.
  METHOD resolve.
    DATA ls_answer TYPE zcl_osd_adt_host=>ty_answer.
    DATA lv_domain TYPE string.
    DATA lv_xml TYPE string.
    DATA lv_text TYPE string.
    TRY.
        ls_answer = zcl_osd_adt_host=>store( iv_command = `READ` iv_type = `DTEL` iv_name = iv_element ).
        lv_xml = ls_answer-source.
        lv_text = tag( iv_xml = lv_xml iv_tag = `DDTEXT` ).
        IF lv_text IS INITIAL.
          lv_text = tag( iv_xml = lv_xml iv_tag = `SCRTEXT_M` ).
        ENDIF.
        lv_domain = tag( iv_xml = lv_xml iv_tag = `DOMNAME` ).
        IF tag( iv_xml = lv_xml iv_tag = `DATATYPE` ) IS INITIAL AND lv_domain IS NOT INITIAL.
          ls_answer = zcl_osd_adt_host=>store( iv_command = `READ` iv_type = `DOMA` iv_name = lv_domain ).
          lv_xml = ls_answer-source.
        ENDIF.
        IF tag( iv_xml = lv_xml iv_tag = `DATATYPE` ) IS INITIAL.
          RETURN.
        ENDIF.
        cs_field-datatype = tag( iv_xml = lv_xml iv_tag = `DATATYPE` ).
        cs_field-length = js_int( tag( iv_xml = lv_xml iv_tag = `LENG` ) ).
        cs_field-decimals = js_int( tag( iv_xml = lv_xml iv_tag = `DECIMALS` ) ).
        IF cs_field-description IS INITIAL.
          cs_field-description = lv_text.
        ENDIF.
      CATCH zcx_osd_adt.
*       Unresolved elements keep their original inline attributes.
    ENDTRY.
  ENDMETHOD.
  METHOD letter.
    CASE iv_type.
      WHEN `CHAR` OR `CLNT` OR `CUKY` OR `LANG` OR `UNIT` OR `ACCP` OR `LCHR`.
        rv_letter = `C`.
      WHEN `NUMC`.
        rv_letter = `N`.
      WHEN `DATS`.
        rv_letter = `D`.
      WHEN `TIMS`.
        rv_letter = `T`.
      WHEN `INT1`.
        rv_letter = `b`.
      WHEN `INT2`.
        rv_letter = `s`.
      WHEN `INT4` OR `RAW` OR `LRAW`.
        rv_letter = `X`.
      WHEN `INT8`.
        rv_letter = `8`.
      WHEN `DEC` OR `CURR` OR `QUAN`.
        rv_letter = `P`.
      WHEN `FLTP`.
        rv_letter = `F`.
      WHEN `RSTR`.
        rv_letter = `y`.
      WHEN `STRG` OR `SSTR`.
        rv_letter = `g`.
      WHEN `DF16_DEC`.
        rv_letter = `a`.
      WHEN `DF34_DEC`.
        rv_letter = `e`.
      WHEN OTHERS.
        rv_letter = iv_default.
        IF rv_letter IS INITIAL.
          rv_letter = `C`.
        ENDIF.
    ENDCASE.
  ENDMETHOD.
ENDCLASS.
