"! Message classes (MSAG/N) out of the abapGit <name>.msag.xml of the store:
"! T100A (ARBGB, MASTERLANG, STEXT) and the T100 rows of the master
"! language. The document is mc:messageClass (http://www.sap.com/adt/MessageClass)
"! with one <mc:messages mc:msgno mc:msgtext/> per message, the shape a
"! client reads with Accept application/vnd.sap.adt.mc.messageclass+xml.
"! source/main is OSD's own text form of the messages, one line "NNN text"
"! per message, so a generic client that opens every object as a document
"! plus a source (abap-adt-api mainInclude) can show a message class as a
"! file; a system has no such resource, and the atom:link that names it
"! says text/plain. Read-only.
CLASS zcl_osd_adt_msag DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_message,
             number TYPE string,
             text   TYPE string,
           END OF ty_message.
    TYPES tt_message TYPE STANDARD TABLE OF ty_message WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_class,
             name     TYPE string,
             text     TYPE string,
             language TYPE string,
             messages TYPE tt_message,
           END OF ty_class.
    "! the master language's messages, in file order, texts decoded
    CLASS-METHODS parse IMPORTING iv_xml TYPE string iv_name TYPE string RETURNING VALUE(rs_class) TYPE ty_class.
    CLASS-METHODS document IMPORTING is_class TYPE ty_class is_read TYPE zcl_osd_adt_host=>ty_read
      RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS text IMPORTING is_class TYPE ty_class RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.
CLASS zcl_osd_adt_msag IMPLEMENTATION.
  METHOD parse.
    DATA lt_rows TYPE string_table.
    DATA lv_row TYPE string.
    DATA lv_language TYPE string.
    DATA ls_message TYPE ty_message.
    DATA lv_head TYPE string.
    DATA lv_off TYPE i.
    rs_class-name = to_upper( iv_name ).
    lv_head = iv_xml.
    FIND FIRST OCCURRENCE OF `</T100A>` IN lv_head MATCH OFFSET lv_off.
    IF sy-subrc = 0.
      lv_head = lv_head(lv_off).
    ENDIF.
    rs_class-text = zcl_osd_adt_ddic=>tag( iv_xml = lv_head iv_tag = `STEXT` ).
    rs_class-language = to_upper( zcl_osd_adt_ddic=>tag( iv_xml = lv_head iv_tag = `MASTERLANG` ) ).
    IF rs_class-language IS INITIAL.
      rs_class-language = `E`.
    ENDIF.
*   one <T100> wrapper, then one <T100> per row: the rows are the chunks
*   that carry a message number
    SPLIT iv_xml AT `<T100>` INTO TABLE lt_rows.
    LOOP AT lt_rows INTO lv_row.
      CLEAR ls_message.
      ls_message-number = zcl_osd_adt_ddic=>tag( iv_xml = lv_row iv_tag = `MSGNR` ).
      IF ls_message-number IS INITIAL.
        CONTINUE.
      ENDIF.
      lv_language = to_upper( zcl_osd_adt_ddic=>tag( iv_xml = lv_row iv_tag = `SPRSL` ) ).
      IF lv_language IS NOT INITIAL AND lv_language <> rs_class-language.
        CONTINUE.
      ENDIF.
      ls_message-text = zcl_osd_adt_ddic=>tag( iv_xml = lv_row iv_tag = `TEXT` ).
      APPEND ls_message TO rs_class-messages.
    ENDLOOP.
  ENDMETHOD.
  METHOD text.
    DATA ls_message TYPE ty_message.
    LOOP AT is_class-messages INTO ls_message.
      rv_text = rv_text && ls_message-number && ` ` && ls_message-text && cl_abap_char_utilities=>newline.
    ENDLOOP.
  ENDMETHOD.
  METHOD document.
    DATA lv_version TYPE string.
    DATA lv_by TYPE string.
    DATA lv_messages TYPE string.
    DATA ls_message TYPE ty_message.
    lv_version = is_read-version.
    IF lv_version IS INITIAL.
      lv_version = `active`.
    ENDIF.
    lv_by = is_read-changed_by.
    IF lv_by IS INITIAL.
      lv_by = `OSD`.
    ENDIF.
    LOOP AT is_class-messages INTO ls_message.
      lv_messages = lv_messages && |  <mc:messages mc:msgno="{ zcl_osd_adt_xml=>esc( ls_message-number ) }" mc:msgtext="{ zcl_osd_adt_xml=>esc( ls_message-text ) }"/>\n|.
    ENDLOOP.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass"\n|
      && | xmlns:adtcore="http://www.sap.com/adt/core" xmlns:atom="http://www.w3.org/2005/Atom"\n|
      && | adtcore:name="{ zcl_osd_adt_xml=>esc( is_class-name ) }" adtcore:type="MSAG/N"\n|
      && | adtcore:description="{ zcl_osd_adt_xml=>esc( is_class-text ) }" adtcore:version="{ lv_version }"\n|
      && | adtcore:language="EN" adtcore:masterLanguage="EN" adtcore:abapLanguageVersion="standard"\n|
      && | adtcore:createdAt="1970-01-01T00:00:00Z" adtcore:changedAt="1970-01-01T00:00:00Z"\n|
      && | adtcore:createdBy="{ zcl_osd_adt_xml=>esc( lv_by ) }" adtcore:changedBy="{ zcl_osd_adt_xml=>esc( lv_by ) }" adtcore:responsible="{ zcl_osd_adt_xml=>esc( lv_by ) }">\n|
      && |  <atom:link href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain" title="the messages as text, one per line (OSD)"/>\n|
      && |  <adtcore:packageRef adtcore:name="{ zcl_osd_adt_xml=>esc( is_read-package ) }" adtcore:type="DEVC/K"\n|
      && |   adtcore:uri="/sap/bc/adt/packages/{ zcl_osd_adt_uri=>encode_component( to_lower( is_read-package ) ) }"/>\n|
      && lv_messages
      && |</mc:messageClass>\n|.
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    DATA ls_class TYPE ty_class.
    READ TABLE is_request-params WITH KEY name = `name` INTO ls_param.
    ls_read = zcl_osd_adt_source=>read( iv_type = `MSAG` iv_name = to_upper( ls_param-value ) ).
    ls_class = parse( iv_xml = ls_read-source iv_name = ls_read-name ).
    IF is_request-pattern CP `*/source/main`.
      rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = text( ls_class )
        iv_type = `text/plain; charset=utf-8` ).
    ELSE.
      rs_response = zcl_osd_adt_entity=>send( is_request = is_request iv_body = document( is_class = ls_class is_read = ls_read )
        iv_type = `application/vnd.sap.adt.mc.messageclass+xml` ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
