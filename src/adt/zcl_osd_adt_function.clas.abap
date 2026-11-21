"! Function groups (FUGR/F), their function modules (FUGR/FF) and their
"! includes (FUGR/I) as ADT documents, out of the abapGit files of the
"! store: <group>.fugr.xml carries AREAT, INCLUDES and FUNCTIONS, and every
"! part is a file beside it, <group>.fugr.<part>.abap, read through STORE
"! READ with the part's program name as IV_INCLUDE (tools/osd-store.mjs and
"! go/objstore agree on the file). The group's source/main is its main
"! program SAPL<group>, as a system answers it. Read-only: a module is not a
"! lockable type here, so there is no PUT and no create.
"!
"! Shapes: group:abapFunctionGroup (http://www.sap.com/adt/functions/groups),
"! fmodule:abapFunctionModule (http://www.sap.com/adt/functions/fmodules,
"! fmodule:processingType rfc|normal, adtcore:containerRef to the group) and
"! include:abapFunctionGroupInclude (http://www.sap.com/adt/functions/includes).
"! A client that opens any of them generically reads adtcore:name and
"! abapsource:sourceUri, then the source (abap-adt-api objectStructure and
"! mainInclude).
CLASS zcl_osd_adt_function DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_module,
             name   TYPE string,
             text   TYPE string,
             remote TYPE abap_bool,
           END OF ty_module.
    TYPES tt_module TYPE STANDARD TABLE OF ty_module WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_group,
             name     TYPE string,
             text     TYPE string,
             includes TYPE string_table,
             modules  TYPE tt_module,
           END OF ty_group.
    CONSTANTS c_base TYPE string VALUE `/sap/bc/adt/functions/groups/`.
    "! the main program of a group: SAPL<group>, a namespace kept in front
    CLASS-METHODS main_program IMPORTING iv_group TYPE string RETURNING VALUE(rv_name) TYPE string.
    "! the inverse of main_program: the group of a main program SAPL<group>
    "! or /NS/SAPL<rest>, initial for any other program name
    CLASS-METHODS group_of_main IMPORTING iv_program TYPE string RETURNING VALUE(rv_group) TYPE string.
    "! what the group's abapGit XML says: AREAT, INCLUDES without the main
    "! program (that is source/main of the group), FUNCTIONS in file order
    CLASS-METHODS parse IMPORTING iv_xml TYPE string iv_name TYPE string RETURNING VALUE(rs_group) TYPE ty_group.
    "! the group of the store, parsed; 404 when there is none
    CLASS-METHODS group IMPORTING iv_name TYPE string
      EXPORTING es_group TYPE ty_group es_read TYPE zcl_osd_adt_host=>ty_read RAISING zcx_osd_adt.
    CLASS-METHODS group_document IMPORTING is_group TYPE ty_group is_read TYPE zcl_osd_adt_host=>ty_read
      RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS module_document IMPORTING is_group TYPE ty_group is_module TYPE ty_module is_read TYPE zcl_osd_adt_host=>ty_read
      RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS include_document IMPORTING is_group TYPE ty_group iv_include TYPE string is_read TYPE zcl_osd_adt_host=>ty_read
      RETURNING VALUE(rv_body) TYPE string.
    "! /sap/bc/adt/functions/groups/<group>, lower case, encoded
    CLASS-METHODS group_uri IMPORTING iv_group TYPE string RETURNING VALUE(rv_uri) TYPE string.
  PRIVATE SECTION.
    CLASS-METHODS core_attributes IMPORTING is_read TYPE zcl_osd_adt_host=>ty_read iv_name TYPE string iv_type TYPE string iv_text TYPE string
      RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS package_ref IMPORTING iv_package TYPE string RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS container_ref IMPORTING iv_group TYPE string RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS source_text IMPORTING is_request TYPE zif_osd_adt_route=>ty_request iv_name TYPE string iv_part TYPE string iv_version TYPE string
      RETURNING VALUE(rs_response) TYPE zif_osd_adt_route=>ty_response RAISING zcx_osd_adt.
ENDCLASS.
CLASS zcl_osd_adt_function IMPLEMENTATION.
  METHOD main_program.
    DATA lv_group TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_off TYPE i.
    lv_group = to_upper( iv_group ).
    IF strlen( lv_group ) > 1 AND lv_group(1) = `/`.
      lv_rest = substring( val = lv_group off = 1 ).
      FIND FIRST OCCURRENCE OF `/` IN lv_rest MATCH OFFSET lv_off.
      IF sy-subrc = 0.
        lv_off = lv_off + 2.
        rv_name = lv_group(lv_off) && `SAPL` && substring( val = lv_group off = lv_off ).
        RETURN.
      ENDIF.
    ENDIF.
    rv_name = `SAPL` && lv_group.
  ENDMETHOD.
  METHOD group_of_main.
    DATA lv_name TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_off TYPE i.
    lv_name = to_upper( iv_program ).
    IF strlen( lv_name ) > 1 AND lv_name(1) = `/`.
      lv_rest = substring( val = lv_name off = 1 ).
      FIND FIRST OCCURRENCE OF `/` IN lv_rest MATCH OFFSET lv_off.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_off = lv_off + 2.
      lv_rest = substring( val = lv_name off = lv_off ).
      IF strlen( lv_rest ) > 4 AND lv_rest(4) = `SAPL`.
        rv_group = lv_name(lv_off) && substring( val = lv_rest off = 4 ).
      ENDIF.
      RETURN.
    ENDIF.
    IF strlen( lv_name ) > 4 AND lv_name(4) = `SAPL`.
      rv_group = substring( val = lv_name off = 4 ).
    ENDIF.
  ENDMETHOD.
  METHOD group_uri.
    rv_uri = c_base && zcl_osd_adt_uri=>encode_component( to_lower( iv_group ) ).
  ENDMETHOD.
  METHOD parse.
    DATA lt_items TYPE zcl_osd_adt_scan=>tt_block.
    DATA ls_item TYPE zcl_osd_adt_scan=>ty_block.
    DATA ls_module TYPE ty_module.
    DATA lt_values TYPE string_table.
    DATA lv_value TYPE string.
    DATA lv_main TYPE string.
    DATA lv_functions TYPE string.
    DATA lv_off TYPE i.
    rs_group-name = to_upper( iv_name ).
    rs_group-text = zcl_osd_adt_ddic=>tag( iv_xml = iv_xml iv_tag = `AREAT` ).
    lv_main = main_program( rs_group-name ).
    lt_values = zcl_osd_adt_scan=>tag_values( iv_xml = iv_xml iv_tag = `SOBJ_NAME` ).
    LOOP AT lt_values INTO lv_value.
      lv_value = to_upper( lv_value ).
      IF lv_value <> lv_main AND lv_value IS NOT INITIAL.
        APPEND lv_value TO rs_group-includes.
      ENDIF.
    ENDLOOP.
    lv_functions = iv_xml.
    FIND FIRST OCCURRENCE OF `<FUNCTIONS>` IN lv_functions MATCH OFFSET lv_off.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    lv_functions = substring( val = lv_functions off = lv_off ).
    lt_items = zcl_osd_adt_scan=>blocks( iv_xml = lv_functions iv_element = `item` ).
    LOOP AT lt_items INTO ls_item.
      CLEAR ls_module.
      ls_module-name = to_upper( zcl_osd_adt_ddic=>tag( iv_xml = ls_item-content iv_tag = `FUNCNAME` ) ).
      IF ls_module-name IS INITIAL.
        CONTINUE.
      ENDIF.
      ls_module-text = zcl_osd_adt_ddic=>tag( iv_xml = ls_item-content iv_tag = `SHORT_TEXT` ).
      ls_module-remote = boolc( zcl_osd_adt_ddic=>tag( iv_xml = ls_item-content iv_tag = `REMOTE_CALL` ) = `R` ).
      APPEND ls_module TO rs_group-modules.
    ENDLOOP.
  ENDMETHOD.
  METHOD group.
    CLEAR: es_group, es_read.
    es_read = zcl_osd_adt_source=>read( iv_type = `FUGR` iv_name = iv_name ).
    es_group = parse( iv_xml = es_read-source iv_name = es_read-name ).
    IF es_group-name IS INITIAL.
      es_group-name = to_upper( iv_name ).
    ENDIF.
  ENDMETHOD.
  METHOD core_attributes.
    DATA lv_version TYPE string.
    DATA lv_by TYPE string.
    lv_version = is_read-version.
    IF lv_version IS INITIAL.
      lv_version = `active`.
    ENDIF.
    lv_by = is_read-changed_by.
    IF lv_by IS INITIAL.
      lv_by = `OSD`.
    ENDIF.
    rv_xml = | adtcore:name="{ zcl_osd_adt_xml=>esc( iv_name ) }" adtcore:type="{ iv_type }"\n|
      && | adtcore:description="{ zcl_osd_adt_xml=>esc( iv_text ) }" adtcore:version="{ lv_version }"\n|
      && | adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:abapLanguageVersion="standard"\n|
      && | adtcore:createdAt="1970-01-01T00:00:00Z" adtcore:changedAt="1970-01-01T00:00:00Z"\n|
      && | adtcore:createdBy="{ zcl_osd_adt_xml=>esc( lv_by ) }" adtcore:changedBy="{ zcl_osd_adt_xml=>esc( lv_by ) }" adtcore:responsible="{ zcl_osd_adt_xml=>esc( lv_by ) }"|.
  ENDMETHOD.
  METHOD package_ref.
    rv_xml = |  <adtcore:packageRef adtcore:name="{ zcl_osd_adt_xml=>esc( iv_package ) }" adtcore:type="DEVC/K"\n|
      && |   adtcore:uri="/sap/bc/adt/packages/{ zcl_osd_adt_uri=>encode_component( to_lower( iv_package ) ) }"/>\n|.
  ENDMETHOD.
  METHOD container_ref.
    rv_xml = |  <adtcore:containerRef adtcore:name="{ zcl_osd_adt_xml=>esc( iv_group ) }" adtcore:type="FUGR/F"\n|
      && |   adtcore:uri="{ group_uri( iv_group ) }"/>\n|.
  ENDMETHOD.
  METHOD group_document.
    DATA lv_links TYPE string.
    DATA lv_include TYPE string.
    DATA ls_module TYPE ty_module.
    LOOP AT is_group-includes INTO lv_include.
      lv_links = lv_links && |  <atom:link href="includes/{ zcl_osd_adt_uri=>encode_component( to_lower( lv_include ) ) }" rel="http://www.sap.com/adt/relations/functions/includes" type="application/vnd.sap.adt.functions.includes.v2+xml" title="{ zcl_osd_adt_xml=>esc( lv_include ) }"/>\n|.
    ENDLOOP.
    LOOP AT is_group-modules INTO ls_module.
      lv_links = lv_links && |  <atom:link href="fmodules/{ zcl_osd_adt_uri=>encode_component( to_lower( ls_module-name ) ) }" rel="http://www.sap.com/adt/relations/functions/fmodules" type="application/vnd.sap.adt.functions.fmodules.v3+xml" title="{ zcl_osd_adt_xml=>esc( ls_module-name ) }"/>\n|.
    ENDLOOP.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<group:abapFunctionGroup xmlns:group="http://www.sap.com/adt/functions/groups"\n|
      && | xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource"\n|
      && | xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && core_attributes( is_read = is_read iv_name = is_group-name iv_type = `FUGR/F` iv_text = is_group-text ) && |\n|
      && | abapsource:sourceUri="source/main" abapsource:fixPointArithmetic="true"\n|
      && | abapsource:activeUnicodeCheck="true">\n|
      && |  <atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain"/>\n|
      && lv_links
      && package_ref( is_read-package )
      && |  <abapsource:syntaxConfiguration><abapsource:language>\n|
      && |    <abapsource:version>X</abapsource:version><abapsource:description>Standard ABAP</abapsource:description>\n|
      && |  </abapsource:language></abapsource:syntaxConfiguration>\n|
      && |</group:abapFunctionGroup>\n|.
  ENDMETHOD.
  METHOD module_document.
    DATA lv_processing TYPE string VALUE `normal`.
    IF is_module-remote = abap_true.
      lv_processing = `rfc`.
    ENDIF.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<fmodule:abapFunctionModule xmlns:fmodule="http://www.sap.com/adt/functions/fmodules"\n|
      && | xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource"\n|
      && | xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && | fmodule:processingType="{ lv_processing }" fmodule:releaseState="notReleased"\n|
      && core_attributes( is_read = is_read iv_name = is_module-name iv_type = `FUGR/FF` iv_text = is_module-text ) && |\n|
      && | abapsource:sourceUri="source/main" abapsource:fixPointArithmetic="true"\n|
      && | abapsource:activeUnicodeCheck="true">\n|
      && |  <atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain"/>\n|
      && container_ref( is_group-name )
      && package_ref( is_read-package )
      && |</fmodule:abapFunctionModule>\n|.
  ENDMETHOD.
  METHOD include_document.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<include:abapFunctionGroupInclude xmlns:include="http://www.sap.com/adt/functions/includes"\n|
      && | xmlns:adtcore="http://www.sap.com/adt/core" xmlns:abapsource="http://www.sap.com/adt/abapsource"\n|
      && | xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && core_attributes( is_read = is_read iv_name = iv_include iv_type = `FUGR/I` iv_text = `` ) && |\n|
      && | abapsource:sourceUri="source/main" abapsource:fixPointArithmetic="true"\n|
      && | abapsource:activeUnicodeCheck="true">\n|
      && |  <atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain"/>\n|
      && container_ref( is_group-name )
      && package_ref( is_read-package )
      && |</include:abapFunctionGroupInclude>\n|.
  ENDMETHOD.
  METHOD source_text.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    ls_read = zcl_osd_adt_source=>read( iv_type = `FUGR` iv_name = iv_name iv_include = iv_part iv_version = iv_version ).
    rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = ls_read-source
      iv_type = `text/plain; charset=utf-8` iv_etag = ls_read-etag ).
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    DATA lv_name TYPE string.
    DATA lv_part TYPE string.
    DATA lv_version TYPE string.
    DATA ls_group TYPE ty_group.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    DATA ls_module TYPE ty_module.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    READ TABLE is_request-params WITH KEY name = `name` INTO ls_param.
    lv_name = to_upper( ls_param-value ).
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `version` IMPORTING ev_value = lv_version ).
    group( EXPORTING iv_name = lv_name IMPORTING es_group = ls_group es_read = ls_read ).
    IF is_request-pattern = c_base && `:name`.
      rs_response = zcl_osd_adt_entity=>send( is_request = is_request
        iv_body = group_document( is_group = ls_group is_read = ls_read )
        iv_type = `application/vnd.sap.adt.functions.groups.v2+xml` ).
    ELSEIF is_request-pattern = c_base && `:name/source/main`.
      rs_response = source_text( is_request = is_request iv_name = ls_group-name
        iv_part = main_program( ls_group-name ) iv_version = lv_version ).
    ELSEIF is_request-pattern CP c_base && `:name/includes/:include*`.
      READ TABLE is_request-params WITH KEY name = `include` INTO ls_param.
      lv_part = to_upper( ls_param-value ).
      READ TABLE ls_group-includes WITH KEY table_line = lv_part TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        lx_error = zcx_osd_adt=>not_found( iv_message = |FUGR/I { lv_part } does not exist in { ls_group-name }|
          iv_miss = zcx_osd_adt=>c_miss_object ).
        RAISE EXCEPTION lx_error.
      ENDIF.
      IF is_request-pattern CP `*/source/main`.
        rs_response = source_text( is_request = is_request iv_name = ls_group-name iv_part = lv_part iv_version = lv_version ).
      ELSE.
        rs_response = zcl_osd_adt_entity=>send( is_request = is_request
          iv_body = include_document( is_group = ls_group iv_include = lv_part is_read = ls_read )
          iv_type = `application/vnd.sap.adt.functions.includes.v2+xml` ).
      ENDIF.
    ELSE.
      READ TABLE is_request-params WITH KEY name = `module` INTO ls_param.
      lv_part = to_upper( ls_param-value ).
      READ TABLE ls_group-modules WITH KEY name = lv_part INTO ls_module.
      IF sy-subrc <> 0.
        lx_error = zcx_osd_adt=>not_found( iv_message = |FUGR/FF { lv_part } does not exist in { ls_group-name }|
          iv_miss = zcx_osd_adt=>c_miss_object ).
        RAISE EXCEPTION lx_error.
      ENDIF.
      IF is_request-pattern CP `*/source/main`.
        rs_response = source_text( is_request = is_request iv_name = ls_group-name iv_part = lv_part iv_version = lv_version ).
      ELSE.
        rs_response = zcl_osd_adt_entity=>send( is_request = is_request
          iv_body = module_document( is_group = ls_group is_module = ls_module is_read = ls_read )
          iv_type = `application/vnd.sap.adt.functions.fmodules.v3+xml` ).
      ENDIF.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
