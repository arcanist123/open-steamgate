"! Classrun executes the serving generation. Transaction work belongs to
"! the handler's FENCE; failed runs request rollback but keep their text.
CLASS zcl_osd_adt_classrun DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    INTERFACES zif_osd_adt_route.
    TYPES: BEGIN OF ty_run,
             text TYPE string,
             ok TYPE abap_bool,
             message TYPE string,
             where TYPE string,
           END OF ty_run.
    CLASS-METHODS run IMPORTING iv_name TYPE string
      RETURNING VALUE(rs_run) TYPE ty_run RAISING zcx_osd_adt.
    CLASS-METHODS supports IMPORTING iv_source TYPE string
      RETURNING VALUE(rv_ok) TYPE abap_bool.
  PRIVATE SECTION.
    CLASS-METHODS check_built IMPORTING iv_name TYPE string
      RAISING zcx_osd_adt.
    CLASS-METHODS dump IMPORTING iv_name TYPE string iv_error TYPE string
        iv_message TYPE string iv_stack TYPE string ix_root TYPE REF TO cx_root OPTIONAL
      RETURNING VALUE(rv_where) TYPE string RAISING zcx_osd_adt.
ENDCLASS.
CLASS zcl_osd_adt_classrun IMPLEMENTATION.
  METHOD zif_osd_adt_route~handle.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.
    DATA ls_object TYPE zcl_osd_adt_host=>ty_object.
    DATA ls_source TYPE zcl_osd_adt_host=>ty_answer.
    DATA ls_run TYPE ty_run.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    zcl_osd_adt_host=>require( `SYSTEM` ).
    READ TABLE is_request-params INTO ls_param WITH KEY name = `name`.
    ls_object = zcl_osd_adt_host=>object( iv_type = `CLAS` iv_name = to_upper( ls_param-value ) ).
    IF ls_object-found = abap_false.
      lx_error = zcx_osd_adt=>not_found( iv_message = |CLAS { ls_param-value } does not exist|
        iv_miss = zcx_osd_adt=>c_miss_object ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    ls_source = zcl_osd_adt_host=>store( iv_command = `READ` iv_type = `CLAS`
      iv_name = ls_object-name iv_include = `main` ).
    IF supports( ls_source-source ) = abap_false.
      lx_error = zcx_osd_adt=>invalid_request( |{ ls_object-name } does not implement IF_OO_ADT_CLASSRUN| ).
      RAISE EXCEPTION lx_error.
    ENDIF.
    ls_run = run( ls_object-name ).
    rs_response-status = 200.
    rs_response-content_type = `text/plain; charset=utf-8`.
    rs_response-body = ls_run-text.
    rs_response-rollback = boolc( ls_run-ok = abap_false ).
  ENDMETHOD.
  METHOD supports.
    DATA lv_source TYPE string.
    DATA lv_space TYPE string.
    DATA lv_regex TYPE string.
*   7.02 POSIX boundary: underscore is a word character, as in JavaScript.
    lv_source = to_lower( iv_source ).
*   Explicit JS whitespace set; no repeated POSIX class runtime conversion.
    lv_space = `[ ` && cl_abap_char_utilities=>horizontal_tab
      && cl_abap_char_utilities=>cr_lf && cl_abap_char_utilities=>form_feed
      && cl_abap_codepage=>convert_from(
        '0BC2A0E19A80E28080E28081E28082E28083E28084E28085E28086E28087E28088E28089E2808AE280A8E280A9E280AFE2819FE38080EFBBBF' ) && `]`.
    lv_regex = `(^|[\r\n])` && lv_space && `*interfaces` && lv_space
      && `+if_oo_adt_classrun([^a-z0-9_]|$)`.
    FIND REGEX lv_regex IN lv_source.
    rv_ok = boolc( sy-subrc = 0 ).
  ENDMETHOD.
  METHOD check_built.
    DATA lo_type TYPE REF TO cl_abap_typedescr.
    DATA lo_class TYPE REF TO cl_abap_classdescr.
    DATA lx_error TYPE REF TO zcx_osd_adt.
    CALL METHOD cl_abap_typedescr=>describe_by_name
      EXPORTING p_name = iv_name RECEIVING type = lo_type
      EXCEPTIONS type_not_found = 1.
    IF sy-subrc <> 0.
      CREATE OBJECT lx_error EXPORTING iv_status = 503
        iv_message = |{ iv_name } is not built: activate it first|.
      RAISE EXCEPTION lx_error.
    ENDIF.
    lo_class ?= lo_type.
    READ TABLE lo_class->interfaces TRANSPORTING NO FIELDS WITH KEY name = `IF_OO_ADT_CLASSRUN`.
    IF sy-subrc <> 0.
      lx_error = zcx_osd_adt=>invalid_request( |{ iv_name } does not implement IF_OO_ADT_CLASSRUN| ).
      RAISE EXCEPTION lx_error.
    ENDIF.
  ENDMETHOD.
  METHOD run.
    DATA lo_out TYPE REF TO zcl_osd_classrun_out.
    DATA lv_failed TYPE abap_bool.
    DATA lv_error TYPE string.
    DATA lv_stack TYPE string.
    DATA lx_root TYPE REF TO cx_root.
    check_built( iv_name ).
    CREATE OBJECT lo_out.
    TRY.
        zcl_osd_kernel_guard=>call_classrun( EXPORTING iv_name = iv_name io_out = lo_out
          IMPORTING ev_failed = lv_failed ev_name = lv_error
            ev_message = rs_run-message ev_stack = lv_stack ).
*       On SAP the @KERNEL guard is a comment; keep class-based errors here.
      CATCH cx_root INTO lx_root.
        lv_failed = abap_true.
        rs_run-message = lx_root->get_text( ).
    ENDTRY.
    rs_run-text = lo_out->text( ).
    rs_run-ok = boolc( lv_failed = abap_false ).
    IF lv_failed = abap_true.
      rs_run-where = dump( iv_name = iv_name iv_error = lv_error
        iv_message = rs_run-message iv_stack = lv_stack ix_root = lx_root ).
      IF rs_run-text IS NOT INITIAL.
        rs_run-text = rs_run-text && cl_abap_char_utilities=>newline && cl_abap_char_utilities=>newline.
      ENDIF.
      rs_run-text = rs_run-text && `Runtime error: ` && rs_run-message && ` at ` && rs_run-where.
    ENDIF.
  ENDMETHOD.
  METHOD dump.
    DATA lo_payload TYPE REF TO zcl_osd_adt_json.
    DATA lo_json TYPE REF TO zcl_ajson.
    DATA lv_json TYPE string.
    DATA lv_include TYPE syrepid.
    DATA lv_line TYPE i.
    CREATE OBJECT lo_payload.
    lo_payload->add( iv_name = `operation` iv_value = `record` ).
    lo_payload->add( iv_name = `name` iv_value = iv_error ).
    lo_payload->add( iv_name = `message` iv_value = iv_message ).
    lo_payload->add( iv_name = `stack` iv_value = iv_stack ).
    lo_payload->add( iv_name = `request` iv_value = `classrun ` && iv_name ).
    TRY.
        lv_json = zcl_osd_adt_host=>system( iv_kind = `DUMP` iv_json = lo_payload->document( ) ).
        lo_json = zcl_ajson=>parse( lv_json ).
        rv_where = lo_json->get_string( `/where` ).
* a member named twice is CX_SY_ITAB_DUPLICATE_KEY in ajson's tree
      CATCH zcx_osd_adt zcx_ajson_error cx_sy_itab_duplicate_key.
*       A system has ST22 instead of a host dump table.
        IF ix_root IS NOT BOUND.
          rv_where = iv_error.
        ELSE.
          ix_root->get_source_position( IMPORTING include_name = lv_include source_line = lv_line ).
          rv_where = |{ lv_include }:{ lv_line }|.
        ENDIF.
    ENDTRY.
  ENDMETHOD.
ENDCLASS.
