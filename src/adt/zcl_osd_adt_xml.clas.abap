"! XML text for the ADT documents, escaped the way the Node facade escapes
"! it (tools/adt-documents.mjs, xmlEscape): ampersand first, then less-than,
"! greater-than and the double quote. No apostrophe, because every attribute
"! here is written in double quotes. Not cl_http_utility=>escape_xml_attr_value,
"! which is a stub in open-abap-core (port-map.md, section 2).
CLASS zcl_osd_adt_xml DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    "! AS XML content type: the Accept dataname, else the fallback.
    CLASS-METHODS as_xml_type
      IMPORTING it_headers     TYPE tihttpnvp
                iv_fallback    TYPE string
      RETURNING VALUE(rv_type) TYPE string.
    CLASS-METHODS esc
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.
    "! the four entities esc writes, read back (abapGit XML text values)
    CLASS-METHODS unesc
      IMPORTING iv_text        TYPE string
      RETURNING VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_adt_xml IMPLEMENTATION.

  METHOD esc.
    rv_text = iv_text.
    REPLACE ALL OCCURRENCES OF `&` IN rv_text WITH `&amp;`.
    REPLACE ALL OCCURRENCES OF `<` IN rv_text WITH `&lt;`.
    REPLACE ALL OCCURRENCES OF `>` IN rv_text WITH `&gt;`.
    REPLACE ALL OCCURRENCES OF `"` IN rv_text WITH `&quot;`.
  ENDMETHOD.

  METHOD unesc.
    rv_text = iv_text.
    REPLACE ALL OCCURRENCES OF `&lt;` IN rv_text WITH `<`.
    REPLACE ALL OCCURRENCES OF `&gt;` IN rv_text WITH `>`.
    REPLACE ALL OCCURRENCES OF `&quot;` IN rv_text WITH `"`.
    REPLACE ALL OCCURRENCES OF `&amp;` IN rv_text WITH `&`.
  ENDMETHOD.

  METHOD as_xml_type.
    DATA lv_accept TYPE string.
    DATA lv_name TYPE string.
    DATA ls_header TYPE ihttpnvp.

    LOOP AT it_headers INTO ls_header.
      IF to_lower( ls_header-name ) = `accept`.
        lv_accept = ls_header-value.
        EXIT.
      ENDIF.
    ENDLOOP.
    FIND FIRST OCCURRENCE OF REGEX `dataname=([A-Za-z0-9_.]+)` IN lv_accept SUBMATCHES lv_name.
    IF sy-subrc <> 0.
      lv_name = iv_fallback.
    ENDIF.
    rv_type = |application/vnd.sap.as+xml; charset=utf-8; dataname={ lv_name }|.
  ENDMETHOD.

ENDCLASS.
