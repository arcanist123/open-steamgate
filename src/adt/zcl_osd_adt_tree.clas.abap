"! B5: ADT repository tree. Host lists retain their supplied order.
CLASS zcl_osd_adt_tree DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_node,
      type TYPE string, name TYPE string, uri TYPE string, description TYPE string,
      version TYPE string, expandable TYPE abap_bool,
    END OF ty_node.
    TYPES tt_node TYPE STANDARD TABLE OF ty_node WITH DEFAULT KEY.
    CLASS-METHODS document IMPORTING it_nodes TYPE tt_node iv_flat TYPE abap_bool DEFAULT abap_false
      it_keys TYPE string_table OPTIONAL RETURNING VALUE(rv_body) TYPE string.
    CLASS-METHODS path_document IMPORTING it_nodes TYPE tt_node RETURNING VALUE(rv_body) TYPE string.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_kind,
      kind TYPE string, type TYPE string, id TYPE string,
    END OF ty_kind.
    TYPES tt_kind TYPE STANDARD TABLE OF ty_kind WITH DEFAULT KEY.

    CLASS-METHODS nodepath IMPORTING is_request TYPE zif_osd_adt_route=>ty_request
      RETURNING VALUE(rs_response) TYPE zif_osd_adt_route=>ty_response RAISING zcx_osd_adt.
    CLASS-METHODS nodestructure IMPORTING is_request TYPE zif_osd_adt_route=>ty_request
      RETURNING VALUE(rs_response) TYPE zif_osd_adt_route=>ty_response RAISING zcx_osd_adt.
    CLASS-METHODS package_nodes IMPORTING io_json TYPE REF TO zcl_ajson iv_folders TYPE abap_bool
      RETURNING VALUE(rt_nodes) TYPE tt_node.
    "! a function group's children: its modules (FUGR/FF), then its includes
    "! (FUGR/I), out of the group's abapGit XML (ZCL_OSD_ADT_FUNCTION)
    CLASS-METHODS function_nodes IMPORTING iv_name TYPE string
      RETURNING VALUE(rt_nodes) TYPE tt_node RAISING zcx_osd_adt.
    CLASS-METHODS node_keys IMPORTING it_xml TYPE zif_osd_adt_xml=>tt_element RETURNING VALUE(rt_keys) TYPE string_table.
    CLASS-METHODS kinds IMPORTING it_nodes TYPE tt_node RETURNING VALUE(rt_kinds) TYPE tt_kind.
    CLASS-METHODS type_info IMPORTING it_kinds TYPE tt_kind EXPORTING ev_types TYPE string et_categories TYPE string_table.
    CLASS-METHODS categories_document IMPORTING it_categories TYPE string_table RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS rows_document IMPORTING it_nodes TYPE tt_node iv_flat TYPE abap_bool RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS element IMPORTING iv_name TYPE string iv_value TYPE string RETURNING VALUE(rv_xml) TYPE string.
    CLASS-METHODS uri IMPORTING iv_type TYPE string iv_name TYPE string RETURNING VALUE(rv_uri) TYPE string.
ENDCLASS.
CLASS zcl_osd_adt_tree IMPLEMENTATION.
  METHOD uri.
    DATA lt_types TYPE zcl_osd_adt_types=>tt_type.
    DATA ls_type TYPE zcl_osd_adt_types=>ty_type.
    lt_types = zcl_osd_adt_types=>all( ).
    READ TABLE lt_types INTO ls_type WITH KEY type = iv_type.
    IF sy-subrc <> 0.
      ls_type-collection = `unknown`.
    ENDIF.
    rv_uri = `/sap/bc/adt/` && ls_type-collection && `/` && zcl_osd_adt_uri=>encode_component( to_lower( iv_name ) ).
  ENDMETHOD.
  METHOD element.
    IF iv_value IS INITIAL.
      IF iv_name <> `OBJECT_URI` AND iv_name <> `OBJECT_VIT_URI`.
        rv_xml = `<` && iv_name && `/>`.
      ENDIF.
    ELSE.
      rv_xml = `<` && iv_name && `>` && zcl_osd_adt_xml=>esc( iv_value ) && `</` && iv_name && `>`.
    ENDIF.
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    IF is_request-pattern = `/sap/bc/adt/repository/nodepath`.
      rs_response = nodepath( is_request ).
    ELSE.
      rs_response = nodestructure( is_request ).
    ENDIF.
  ENDMETHOD.
  METHOD nodepath.
    DATA lt_nodes TYPE tt_node.
    DATA ls_node TYPE ty_node.
    DATA ls_object TYPE zcl_osd_adt_host=>ty_object.
    DATA ls_parsed TYPE zcl_osd_adt_types=>ty_object.
    DATA lv_name TYPE string.
    DATA lv_uri TYPE string.
    DATA lv_off TYPE i.
    DATA lv_rest TYPE string.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    DATA lt_query TYPE string_table.
    DATA lv_query TYPE string.
    DATA lv_qname TYPE string.
    DATA lv_qvalue TYPE string.
    DATA lv_count TYPE i.
    DATA lv_ok TYPE abap_bool.
    zcl_osd_adt_host=>require( `OBJECT` ).
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `uri` IMPORTING ev_value = lv_uri ).
*   Node only accepts a scalar uri; use raw query to detect repeats/arrays.
    lv_rest = is_request-uri.
    FIND FIRST OCCURRENCE OF `?` IN lv_rest MATCH OFFSET lv_off.
    IF sy-subrc = 0.
      lv_rest = substring( val = lv_rest off = lv_off + 1 ).
      SPLIT lv_rest AT `&` INTO TABLE lt_query.
      LOOP AT lt_query INTO lv_query.
        SPLIT lv_query AT `=` INTO lv_qname lv_qvalue.
        REPLACE ALL OCCURRENCES OF `+` IN lv_qname WITH ` `.
        zcl_osd_adt_uri=>decode_component( EXPORTING iv_text = lv_qname IMPORTING ev_text = lv_qvalue ev_ok = lv_ok ).
        IF lv_ok = abap_true.
          lv_qname = lv_qvalue.
        ENDIF.
        IF lv_qname = `uri`.
          lv_count = lv_count + 1.
        ELSEIF lv_qname CP `uri[*`.
          CLEAR lv_uri.
        ENDIF.
      ENDLOOP.
      IF lv_count > 1.
        CLEAR lv_uri.
      ENDIF.
    ENDIF.
    FIND FIRST OCCURRENCE OF `/includes/` IN lv_uri MATCH OFFSET lv_off.
    IF sy-subrc = 0.
      lv_uri = lv_uri(lv_off).
    ENDIF.
    ls_parsed = zcl_osd_adt_types=>object_from_uri( lv_uri ).
    IF ls_parsed-found = abap_false OR ls_parsed-ok = abap_false
        OR ( ls_parsed-type <> `CLAS` AND ls_parsed-type <> `INTF` AND ls_parsed-type <> `PROG`
        AND ls_parsed-type <> `DDLS` AND ls_parsed-type <> `SRVD` AND ls_parsed-type <> `INCL` ).
      lx_error = zcx_osd_adt=>invalid_request( `an object uri is required` ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    ls_object = zcl_osd_adt_host=>object( iv_type = ls_parsed-type iv_name = ls_parsed-name ).
    IF ls_object-found = abap_false.
      lx_error = zcx_osd_adt=>not_found( iv_message = |{ ls_parsed-type } { ls_parsed-name } does not exist| iv_miss = zcx_osd_adt=>c_miss_none ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    LOOP AT ls_object-packages INTO lv_name.
      CLEAR ls_node.
      ls_node-type = `DEVC/K`.
      ls_node-name = lv_name.
      ls_node-uri = uri( iv_type = `DEVC` iv_name = lv_name ).
      APPEND ls_node TO lt_nodes.
    ENDLOOP.
    FIND FIRST OCCURRENCE OF REGEX `[?#]` IN lv_uri MATCH OFFSET lv_off.
    IF sy-subrc = 0.
      lv_uri = lv_uri(lv_off).
    ENDIF.
    lv_off = strlen( lv_uri ) - 12.
    IF lv_off >= 0 AND substring( val = lv_uri off = lv_off ) = `/source/main`.
      lv_uri = lv_uri(lv_off).
    ENDIF.
    CLEAR ls_node.
    ls_node-type = zcl_osd_adt_types=>adt_type( ls_object-type ).
    ls_node-name = ls_object-name.
    ls_node-uri = lv_uri.
    APPEND ls_node TO lt_nodes.
    rs_response-status = 200.
    rs_response-content_type = `application/xml; charset=utf-8`.
    rs_response-body = path_document( lt_nodes ).
  ENDMETHOD.
  METHOD nodestructure.
    DATA lt_nodes TYPE tt_node.
    DATA ls_node TYPE ty_node.
    DATA ls_object TYPE zcl_osd_adt_host=>ty_object.
    DATA lv_name TYPE string.
    DATA lv_type TYPE string.
    DATA lv_user TYPE string.
    DATA lv_found TYPE abap_bool.
    DATA lv_flat TYPE abap_bool.
    DATA lv_accept TYPE string.
    DATA lv_folders TYPE abap_bool.
    DATA lo_json TYPE REF TO zcl_ajson.
    DATA lv_member TYPE string.
    DATA lv_rest TYPE string.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `parent_name` IMPORTING ev_value = lv_name ev_found = lv_found ).
    IF lv_found = abap_false.
      zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `parentName` IMPORTING ev_value = lv_name ev_found = lv_found ).
    ENDIF.
    IF lv_found = abap_false.
      zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `package` IMPORTING ev_value = lv_name ).
    ENDIF.
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `parent_type` IMPORTING ev_value = lv_type ev_found = lv_found ).
    IF lv_found = abap_false.
      zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `parentType` IMPORTING ev_value = lv_type ).
    ENDIF.
    lv_flat = boolc( lv_name IS INITIAL AND lv_type = `DEVC` ).
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `user_name` IMPORTING ev_value = lv_user ).
    IF lv_user IS INITIAL.
      lv_user = is_request-session-user.
    ENDIF.
    lv_accept = zcl_osd_adt_csrf=>header( it_headers = is_request-headers iv_name = `accept` ).
    FIND FIRST OCCURRENCE OF REGEX `dataname=com\.sap\.adt\.RepositoryObjectTreeContent` IN lv_accept IGNORING CASE.
    lv_folders = boolc( sy-subrc <> 0 ).
    SPLIT lv_type AT `/` INTO lv_type lv_rest.
    IF lv_type = `FUGR`.
      lt_nodes = function_nodes( lv_name ).
    ELSEIF lv_type = `CLAS`.
      zcl_osd_adt_host=>require( `OBJECT` ).
      ls_object = zcl_osd_adt_host=>object( iv_type = `CLAS` iv_name = lv_name ).
      IF ls_object-found = abap_false.
        lx_error = zcx_osd_adt=>not_found( |CLAS { lv_name } does not exist| ).
        RAISE EXCEPTION lx_error.
      ENDIF.
      CLEAR ls_node.
      ls_node-type = `CLAS/I`.
      ls_node-name = ls_object-name && `.main`.
      ls_node-uri = uri( iv_type = `CLAS` iv_name = ls_object-name ) && `/source/main`.
      APPEND ls_node TO lt_nodes.
      LOOP AT ls_object-includes INTO lv_member.
        ls_node-name = ls_object-name && `.` && lv_member.
        ls_node-uri = uri( iv_type = `CLAS` iv_name = ls_object-name ) && `/includes/` && lv_member.
        APPEND ls_node TO lt_nodes.
      ENDLOOP.
    ELSE.
      lo_json = zcl_osd_adt_package=>get( iv_name = lv_name iv_user = lv_user ).
      lt_nodes = package_nodes( io_json = lo_json iv_folders = lv_folders ).
    ENDIF.
    rs_response-status = 200.
    rs_response-content_type = zcl_osd_adt_xml=>as_xml_type( it_headers = is_request-headers iv_fallback = `com.sap.adt.RepositoryObjectTreeContent` ).
    rs_response-body = document( it_nodes = lt_nodes iv_flat = lv_flat it_keys = node_keys( is_request-xml ) ).
  ENDMETHOD.
  METHOD function_nodes.
    DATA ls_group TYPE zcl_osd_adt_function=>ty_group.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    DATA ls_module TYPE zcl_osd_adt_function=>ty_module.
    DATA lv_include TYPE string.
    DATA lv_base TYPE string.
    DATA ls_node TYPE ty_node.
    zcl_osd_adt_function=>group( EXPORTING iv_name = iv_name IMPORTING es_group = ls_group es_read = ls_read ).
    lv_base = zcl_osd_adt_function=>group_uri( ls_group-name ).
    LOOP AT ls_group-modules INTO ls_module.
      CLEAR ls_node.
      ls_node-type = `FUGR/FF`.
      ls_node-name = ls_module-name.
      ls_node-uri = lv_base && `/fmodules/` && zcl_osd_adt_uri=>encode_component( to_lower( ls_module-name ) ).
      ls_node-description = ls_module-text.
      ls_node-version = ls_read-version.
      APPEND ls_node TO rt_nodes.
    ENDLOOP.
    LOOP AT ls_group-includes INTO lv_include.
      CLEAR ls_node.
      ls_node-type = `FUGR/I`.
      ls_node-name = lv_include.
      ls_node-uri = lv_base && `/includes/` && zcl_osd_adt_uri=>encode_component( to_lower( lv_include ) ).
      ls_node-version = ls_read-version.
      APPEND ls_node TO rt_nodes.
    ENDLOOP.
  ENDMETHOD.
  METHOD package_nodes.
    DATA ls_node TYPE ty_node.
    DATA lv_type TYPE string.
    DATA lt_members TYPE string_table.
    DATA lv_member TYPE string.
    DATA lv_path TYPE string.
    lt_members = zcl_osd_adt_json=>ordered_members( io_json = io_json iv_path = `/subpackages` ).
    LOOP AT lt_members INTO lv_member.
      CLEAR ls_node.
      ls_node-type = `DEVC/K`.
      ls_node-name = io_json->get_string( `/subpackages/` && lv_member && `/name` ).
      ls_node-uri = uri( iv_type = `DEVC` iv_name = ls_node-name ).
      ls_node-expandable = abap_true.
      APPEND ls_node TO rt_nodes.
    ENDLOOP.
    lt_members = zcl_osd_adt_json=>ordered_members( io_json = io_json iv_path = `/objects` ).
    LOOP AT lt_members INTO lv_member.
      lv_path = `/objects/` && lv_member.
      lv_type = io_json->get_string( lv_path && `/type` ).
      IF lv_type = `DEVC`.
        CONTINUE.
      ENDIF.
      CLEAR ls_node.
      ls_node-type = zcl_osd_adt_types=>adt_type( lv_type ).
      ls_node-name = io_json->get_string( lv_path && `/name` ).
      ls_node-uri = uri( iv_type = lv_type iv_name = ls_node-name ).
      ls_node-version = io_json->get_string( lv_path && `/version` ).
      ls_node-expandable = boolc( lv_type = `CLAS` AND iv_folders = abap_true ).
      IF io_json->get_boolean( lv_path && `/library` ) = abap_true.
        ls_node-description = `library object`.
      ENDIF.
      APPEND ls_node TO rt_nodes.
    ENDLOOP.
  ENDMETHOD.
  METHOD node_keys.
    DATA ls_element TYPE zif_osd_adt_xml=>ty_element.
    LOOP AT it_xml INTO ls_element WHERE uri = `` AND local = `TV_NODEKEY`.
      IF ls_element-text IS NOT INITIAL AND ls_element-text <> `000000`.
        APPEND ls_element-text TO rt_keys.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.
  METHOD path_document.
    DATA ls_node TYPE ty_node.
    DATA lv_lines TYPE string.
    LOOP AT it_nodes INTO ls_node.
      IF sy-tabix > 1.
        lv_lines = lv_lines && cl_abap_char_utilities=>newline.
      ENDIF.
      lv_lines = lv_lines && |    <objectLinkReference adtcore:uri="{ zcl_osd_adt_xml=>esc( ls_node-uri ) }" adtcore:type="{ zcl_osd_adt_xml=>esc( ls_node-type ) }" adtcore:name="{ zcl_osd_adt_xml=>esc( ls_node-name ) }" projectexplorer:category=""/>|.
    ENDLOOP.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<projectexplorer:nodepath xmlns:projectexplorer="http://www.sap.com/adt/projectexplorer" xmlns:adtcore="http://www.sap.com/adt/core">\n|
      && |  <projectexplorer:objectLinkReferences>\n{ lv_lines }\n  </projectexplorer:objectLinkReferences>\n</projectexplorer:nodepath>\n|.
  ENDMETHOD.
  METHOD document.
    DATA lt_kinds TYPE tt_kind.
    DATA ls_kind TYPE ty_kind.
    DATA lt_categories TYPE string_table.
    DATA lt_filtered TYPE tt_node.
    DATA ls_node TYPE ty_node.
    DATA lv_kind TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_types TYPE string.
    DATA lv_categories TYPE string.
    DATA lv_rows TYPE string.
    lt_kinds = kinds( it_nodes ).
    IF iv_flat = abap_false AND it_keys IS NOT INITIAL.
      LOOP AT it_nodes INTO ls_node.
        SPLIT ls_node-type AT `/` INTO lv_kind lv_rest.
        READ TABLE lt_kinds INTO ls_kind WITH KEY kind = lv_kind.
        IF sy-subrc = 0.
          READ TABLE it_keys WITH KEY table_line = ls_kind-id TRANSPORTING NO FIELDS.
          IF sy-subrc = 0.
            APPEND ls_node TO lt_filtered.
          ENDIF.
        ENDIF.
      ENDLOOP.
      rv_body = document( lt_filtered ).
      RETURN.
    ENDIF.
    type_info( EXPORTING it_kinds = lt_kinds IMPORTING ev_types = lv_types et_categories = lt_categories ).
    lv_categories = categories_document( lt_categories ).
    lv_rows = rows_document( it_nodes = it_nodes iv_flat = iv_flat ).
    IF iv_flat = abap_true.
      rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
        && |<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n|
        && |  <asx:values><DATA><TREE_CONTENT>\n{ lv_rows }\n  </TREE_CONTENT></DATA></asx:values>\n</asx:abap>\n|.
    ELSE.
      rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
        && |<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0">\n|
        && |  <asx:values>\n    <DATA>\n      <TREE_CONTENT>\n{ lv_rows }\n      </TREE_CONTENT>\n|
        && |      <CATEGORIES>\n{ lv_categories }\n      </CATEGORIES>\n|
        && |      <OBJECT_TYPES>\n{ lv_types }\n      </OBJECT_TYPES>\n    </DATA>\n  </asx:values>\n</asx:abap>\n|.
    ENDIF.
  ENDMETHOD.
  METHOD kinds.
    DATA ls_kind TYPE ty_kind.
    DATA ls_node TYPE ty_node.
    DATA lv_kind TYPE string.
    DATA lv_rest TYPE string.
    DATA lv_num TYPE n LENGTH 6.
*   First appearance defines ids and category order. Never sort host lists.
    LOOP AT it_nodes INTO ls_node.
      SPLIT ls_node-type AT `/` INTO lv_kind lv_rest.
      IF lv_kind = `DEVC`.
        CONTINUE.
      ENDIF.
      READ TABLE rt_kinds WITH KEY kind = lv_kind TRANSPORTING NO FIELDS.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
      lv_num = lines( rt_kinds ) + 1.
      ls_kind-kind = lv_kind.
      ls_kind-type = ls_node-type.
      ls_kind-id = lv_num.
      APPEND ls_kind TO rt_kinds.
    ENDLOOP.
  ENDMETHOD.
  METHOD type_info.
    DATA ls_kind TYPE ty_kind.
    DATA lt_types TYPE zcl_osd_adt_types=>tt_type.
    DATA ls_type TYPE zcl_osd_adt_types=>ty_type.
    DATA lv_category TYPE string.
    lt_types = zcl_osd_adt_types=>all( ).
    LOOP AT it_kinds INTO ls_kind.
      CLEAR ls_type.
      READ TABLE lt_types INTO ls_type WITH KEY type = ls_kind-kind.
      lv_category = ls_type-tree_category.
      IF lv_category IS INITIAL.
        lv_category = `other`.
      ENDIF.
      READ TABLE et_categories WITH KEY table_line = lv_category TRANSPORTING NO FIELDS.
      IF sy-subrc <> 0.
        APPEND lv_category TO et_categories.
      ENDIF.
      IF sy-tabix > 0 AND ev_types IS NOT INITIAL.
        ev_types = ev_types && cl_abap_char_utilities=>newline.
      ENDIF.
      ev_types = ev_types && `    <SEU_ADT_OBJECT_TYPE_INFO>`
        && element( iv_name = `OBJECT_TYPE` iv_value = ls_kind-type )
        && element( iv_name = `CATEGORY_TAG` iv_value = lv_category )
        && element( iv_name = `OBJECT_TYPE_LABEL` iv_value = ls_type-tree_label )
        && element( iv_name = `NODE_ID` iv_value = ls_kind-id ) && `</SEU_ADT_OBJECT_TYPE_INFO>`.
    ENDLOOP.
  ENDMETHOD.
  METHOD categories_document.
    DATA lv_category TYPE string.
    DATA lv_label TYPE string.
    LOOP AT it_categories INTO lv_category.
      CASE lv_category.
        WHEN `source_library`.
          lv_label = `Source Code Library`.
        WHEN `dictionary`.
          lv_label = `Dictionary`.
        WHEN OTHERS.
          lv_label = `Others`.
      ENDCASE.
      IF sy-tabix > 1.
        rv_xml = rv_xml && cl_abap_char_utilities=>newline.
      ENDIF.
      rv_xml = rv_xml && `    <SEU_ADT_OBJECT_CATEGORY_INFO>`
        && element( iv_name = `CATEGORY` iv_value = lv_category )
        && element( iv_name = `CATEGORY_LABEL` iv_value = lv_label ) && `</SEU_ADT_OBJECT_CATEGORY_INFO>`.
    ENDLOOP.
  ENDMETHOD.
  METHOD rows_document.
    DATA ls_node TYPE ty_node.
    DATA lv_row TYPE string.
    DATA lv_expand TYPE string.
    DATA lv_version TYPE string.
    LOOP AT it_nodes INTO ls_node.
      lv_expand = ``.
      IF ls_node-expandable = abap_true.
        lv_expand = `X`.
      ENDIF.
      lv_row = `    <SEU_ADT_REPOSITORY_OBJ_NODE>`
        && element( iv_name = `OBJECT_TYPE` iv_value = ls_node-type )
        && element( iv_name = `OBJECT_NAME` iv_value = ls_node-name )
        && element( iv_name = `TECH_NAME` iv_value = ls_node-name )
        && element( iv_name = `OBJECT_URI` iv_value = ls_node-uri )
        && element( iv_name = `EXPANDABLE` iv_value = lv_expand ).
      IF iv_flat = abap_false.
        lv_row = lv_row && `<NODE_ID/><PARENT_NAME/>`.
      ENDIF.
      lv_row = lv_row && element( iv_name = `DESCRIPTION` iv_value = ls_node-description ).
      IF iv_flat = abap_false.
        lv_version = `A`.
        IF ls_node-version = `inactive`.
          lv_version = `I`.
        ENDIF.
        lv_row = lv_row && `<DESCRIPTION_TYPE/>` && element( iv_name = `VERSION` iv_value = lv_version ) && `<INACTIVE_TYPE/>`.
      ENDIF.
      lv_row = lv_row && `</SEU_ADT_REPOSITORY_OBJ_NODE>`.
      IF sy-tabix > 1.
        rv_xml = rv_xml && cl_abap_char_utilities=>newline.
      ENDIF.
      rv_xml = rv_xml && lv_row.
    ENDLOOP.
  ENDMETHOD.
ENDCLASS.
