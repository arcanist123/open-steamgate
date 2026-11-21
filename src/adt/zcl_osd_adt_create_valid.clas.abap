"! The creation wizards' preflight: POST oo/validation/objectname,
"! packages/validation, programs/validation and includes/validation with
"! objtype, objname and packagename as query fields. Read-only: a passing
"! answer reserves nothing, CREATE checks again under its lock.
"!
"! The rules are tools/adt-create-validation.mjs's and tools/osd-object-name.mjs's,
"! message for message, so the Node facade and this front answer alike
"! (test/adt-abap-c1.mjs diffs them): the type must be one a wizard here
"! can create and must fit the resource asked, the name must be a
"! repository name, the object must not exist, the package must exist and
"! be writable, and a package under a parent is named <parent>_<FOLDER>
"! (or a $-name under $TMP). Asked of the store directly (OBJECT), not
"! through PARSE, so every host that has a store answers it.
CLASS zcl_osd_adt_create_valid DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_verdict,
             success TYPE abap_bool,
             message TYPE string,
           END OF ty_verdict.
    "! the resource of a validation path: OO, PACKAGE, PROG, INCL
    CLASS-METHODS resource_of IMPORTING iv_path TYPE string RETURNING VALUE(rv_resource) TYPE string.
    "! the store type of a wizard's objtype; initial when no wizard here creates it
    CLASS-METHODS type_of IMPORTING iv_objtype TYPE string RETURNING VALUE(rv_type) TYPE string.
    "! osd-object-name.mjs nameProblem: initial when the name is a repository name
    CLASS-METHODS name_problem IMPORTING iv_type TYPE string iv_name TYPE string RETURNING VALUE(rv_message) TYPE string.
    "! osd-object-name.mjs packageChildName
    CLASS-METHODS package_child IMPORTING iv_parent TYPE string iv_name TYPE string RETURNING VALUE(rv_ok) TYPE abap_bool.
    "! the verdict, the store asked for the object and its package
    CLASS-METHODS validate IMPORTING iv_resource TYPE string iv_objtype TYPE string iv_objname TYPE string iv_package TYPE string
      RETURNING VALUE(rs_verdict) TYPE ty_verdict RAISING zcx_osd_adt.
    CLASS-METHODS document IMPORTING is_verdict TYPE ty_verdict RETURNING VALUE(rv_body) TYPE string.
ENDCLASS.
CLASS zcl_osd_adt_create_valid IMPLEMENTATION.
  METHOD resource_of.
    DATA lv_path TYPE string.
    lv_path = to_lower( iv_path ).
    IF lv_path CP `*/packages/validation` OR lv_path CP `*/packages/validation/`.
      rv_resource = `PACKAGE`.
    ELSEIF lv_path CP `*/programs/validation` OR lv_path CP `*/programs/validation/`.
      rv_resource = `PROG`.
    ELSEIF lv_path CP `*/includes/validation` OR lv_path CP `*/includes/validation/`.
      rv_resource = `INCL`.
    ELSE.
      rv_resource = `OO`.
    ENDIF.
  ENDMETHOD.
  METHOD type_of.
    CASE to_upper( iv_objtype ).
      WHEN `CLAS/OC`.
        rv_type = `CLAS`.
      WHEN `INTF/OI`.
        rv_type = `INTF`.
      WHEN `DEVC/K`.
        rv_type = `DEVC`.
      WHEN `PROG/P`.
        rv_type = `PROG`.
      WHEN `PROG/I`.
        rv_type = `INCL`.
    ENDCASE.
  ENDMETHOD.
  METHOD name_problem.
    DATA lv_dollar TYPE string.
    IF iv_name <> to_upper( iv_name ).
      rv_message = |{ iv_type } { iv_name }: a repository name is upper case|.
      RETURN.
    ENDIF.
    IF iv_type = `DEVC`.
      lv_dollar = `, a leading $`.
      FIND FIRST OCCURRENCE OF REGEX `^(\$|/[A-Z0-9_]{1,10}/)?[A-Z0-9_]{1,30}$` IN iv_name.
      IF sy-subrc = 0 AND strlen( iv_name ) <= 30.
        RETURN.
      ENDIF.
    ELSE.
      FIND FIRST OCCURRENCE OF REGEX `^(/[A-Z0-9_]{1,10}/)?[A-Z0-9_]{1,40}$` IN iv_name.
      IF sy-subrc = 0.
        RETURN.
      ENDIF.
    ENDIF.
    rv_message = |{ iv_type } "{ iv_name }" is not a repository name (A-Z, 0-9, _{ lv_dollar }, an optional /NAMESPACE/)|.
  ENDMETHOD.
  METHOD package_child.
    DATA lv_prefix TYPE string.
    DATA lv_prefixed TYPE abap_bool.
    lv_prefix = iv_parent && `_`.
    lv_prefixed = boolc( strlen( iv_name ) >= strlen( lv_prefix ) AND substring( val = iv_name len = strlen( lv_prefix ) ) = lv_prefix ).
    IF iv_parent = `$TMP` AND strlen( iv_name ) > 0 AND iv_name(1) = `$` AND lv_prefixed = abap_false.
      rv_ok = abap_true.
      RETURN.
    ENDIF.
    rv_ok = boolc( lv_prefixed = abap_true AND strlen( iv_name ) > strlen( lv_prefix ) ).
  ENDMETHOD.
  METHOD validate.
    DATA lv_type TYPE string.
    DATA lv_name TYPE string.
    DATA lv_parent TYPE string.
    DATA ls_object TYPE zcl_osd_adt_host=>ty_object.
    DATA ls_home TYPE zcl_osd_adt_host=>ty_object.
    lv_type = type_of( iv_objtype ).
    lv_name = to_upper( iv_objname ).
    lv_parent = to_upper( iv_package ).
    IF lv_type IS INITIAL.
      rs_verdict-message = `Unsupported object type`.
    ELSEIF ( iv_resource = `PACKAGE` AND lv_type <> `DEVC` )
        OR ( iv_resource = `OO` AND lv_type <> `CLAS` AND lv_type <> `INTF` )
        OR ( iv_resource = `PROG` AND lv_type <> `PROG` )
        OR ( iv_resource = `INCL` AND lv_type <> `INCL` ).
      rs_verdict-message = `Object type does not match the validation resource`.
    ELSE.
      rs_verdict-message = name_problem( iv_type = lv_type iv_name = lv_name ).
      IF rs_verdict-message IS INITIAL.
        zcl_osd_adt_host=>require( `OBJECT` ).
        ls_object = zcl_osd_adt_host=>object( iv_type = lv_type iv_name = lv_name ).
        IF ls_object-found = abap_true.
          rs_verdict-message = |{ lv_type } { lv_name } already exists|.
        ELSE.
          ls_home = zcl_osd_adt_host=>object( iv_type = `DEVC` iv_name = lv_parent ).
          IF ls_home-found = abap_false.
            IF lv_parent IS INITIAL.
              lv_parent = `(missing)`.
            ENDIF.
            rs_verdict-message = |Package { lv_parent } does not exist|.
          ELSEIF ls_home-writable = abap_false.
            rs_verdict-message = |Package { lv_parent } is read-only|.
          ELSEIF lv_type = `DEVC` AND package_child( iv_parent = lv_parent iv_name = lv_name ) = abap_false.
            rs_verdict-message = |A package under { lv_parent } must be named { lv_parent }_<FOLDER>|.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDIF.
    rs_verdict-success = boolc( rs_verdict-message IS INITIAL ).
  ENDMETHOD.
  METHOD document.
    DATA lv_result TYPE string.
    DATA lv_severity TYPE string VALUE `ERROR`.
    IF is_verdict-success = abap_true.
      lv_result = `X`.
      lv_severity = `SUCCESS`.
    ENDIF.
    rv_body = |<?xml version="1.0" encoding="utf-8"?>\n|
      && |<asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values><DATA><CHECK_RESULT>{ lv_result }</CHECK_RESULT><SEVERITY>{ lv_severity }</SEVERITY><SHORT_TEXT>{ zcl_osd_adt_xml=>esc( is_verdict-message ) }</SHORT_TEXT></DATA></asx:values></asx:abap>|.
  ENDMETHOD.
  METHOD zif_osd_adt_route~handle.
    DATA lv_objtype TYPE string.
    DATA lv_objname TYPE string.
    DATA lv_package TYPE string.
    DATA lv_found TYPE abap_bool.
    DATA ls_verdict TYPE ty_verdict.
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `objtype` IMPORTING ev_value = lv_objtype ev_found = lv_found ).
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `objname` IMPORTING ev_value = lv_objname ev_found = lv_found ).
    zcl_osd_adt_package=>query( EXPORTING is_request = is_request iv_name = `packagename` IMPORTING ev_value = lv_package ev_found = lv_found ).
    ls_verdict = validate( iv_resource = resource_of( is_request-path ) iv_objtype = lv_objtype
      iv_objname = lv_objname iv_package = lv_package ).
    rs_response-status = 200.
    rs_response-content_type = `application/vnd.sap.as+xml; charset=utf-8`.
    rs_response-body = document( ls_verdict ).
  ENDMETHOD.
ENDCLASS.
