"! The route table of the ADT facade in ABAP (ADR 0007, port-map.md section
"! 2, step 3): an ordered list of rows, each a method, a path pattern, the
"! class that answers and who serves it, ABAP or HOST.
"!
"! The rules, which are Express's, because the Node facade is the reference
"! until the last group has moved:
"!   - the first row that matches wins, so order is part of the contract;
"!   - a pattern segment :name matches one non-empty segment and is handed
"!     to the route percent-decoded, after the split and after the match
"!     (ZCL_OSD_ADT_URI: a segment that does not decode is a 400, as in
"!     Express); a last segment * matches whatever follows;
"!   - literal segments compare without case, and one trailing slash on the
"!     request is ignored (Express routes are case-insensitive, non-strict);
"!   - HEAD matches a HEAD row or, failing that, a GET row. The GET answer is
"!     kept whole and the HTTP layer drops the body, so Content-Length is the
"!     GET's, as Express sends it. A row of its own is how a HEAD answers
"!     differently (the graph does);
"!   - a row served by HOST, or no row at all, is not answered here: the
"!     handler says so and the Node front hands the request to the Node
"!     facade after the step (docs/adt-abap-port/slice-3-front.md). This
"!     table is the only matcher: the front no longer matches it in
"!     JavaScript, every request enters the handler first.
"! Slice 1 lists the rows ABAP serves and one catch-all for the host. The
"! per-type rows are generated from the type table (ZCL_OSD_ADT_TYPES) when
"! their group moves; slice 2 moves POST <collection>/:name, LOCK and UNLOCK.
CLASS zcl_osd_adt_router DEFINITION PUBLIC FINAL CREATE PUBLIC.
  PUBLIC SECTION.
    CONSTANTS c_base TYPE string VALUE `/sap/bc/adt`.
    CONSTANTS c_abap TYPE string VALUE `ABAP`.
    CONSTANTS c_host TYPE string VALUE `HOST`.

    TYPES: BEGIN OF ty_route,
             method    TYPE string,
             pattern   TYPE string,
             handler   TYPE string,
             resume_kind TYPE string,
             served_by TYPE string,
           END OF ty_route.
    TYPES tt_route TYPE STANDARD TABLE OF ty_route WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_result,
             served_by TYPE string,
             response  TYPE zif_osd_adt_route=>ty_response,
           END OF ty_result.

    CLASS-METHODS routes
      RETURNING VALUE(rt_routes) TYPE tt_route.

    CLASS-METHODS match
      IMPORTING it_routes TYPE tt_route
                iv_method TYPE string
                iv_path   TYPE string
      EXPORTING ev_found  TYPE abap_bool
                es_route  TYPE ty_route
                et_params TYPE zif_osd_adt_route=>tt_param.

    "! it_routes replaces the table, for a test
    CLASS-METHODS dispatch
      IMPORTING is_request       TYPE zif_osd_adt_route=>ty_request
                it_routes        TYPE tt_route OPTIONAL
      RETURNING VALUE(rs_result) TYPE ty_result
      RAISING   zcx_osd_adt.

    CLASS-METHODS add
      IMPORTING iv_method    TYPE string
                iv_pattern   TYPE string
                iv_handler   TYPE string OPTIONAL
                iv_resume_kind TYPE string OPTIONAL
                iv_served_by TYPE string DEFAULT c_abap
      CHANGING  ct_routes    TYPE tt_route.
  PRIVATE SECTION.
    CLASS-METHODS match_pattern
      IMPORTING iv_pattern TYPE string
                iv_path    TYPE string
      EXPORTING ev_match   TYPE abap_bool
                et_params  TYPE zif_osd_adt_route=>tt_param.
ENDCLASS.

CLASS zcl_osd_adt_router IMPLEMENTATION.

  METHOD routes.
    DATA lt_types TYPE zcl_osd_adt_types=>tt_type.
    DATA ls_type TYPE zcl_osd_adt_types=>ty_type.
    DATA lv_pattern TYPE string.
    DATA lv_classrun_by TYPE string.

    add( EXPORTING iv_method = `HEAD` iv_pattern = `/sap/bc/adt/core/discovery` iv_handler = `ZCL_OSD_ADT_DISCOVERY`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/discovery` iv_handler = `ZCL_OSD_ADT_DISCOVERY`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `HEAD` iv_pattern = `/sap/bc/adt/discovery` iv_handler = `ZCL_OSD_ADT_DISCOVERY`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/discovery` iv_handler = `ZCL_OSD_ADT_DISCOVERY`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/debugger/listeners` iv_handler = `ZCL_OSD_ADT_LISTENERS`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/debugger/listeners` iv_handler = `ZCL_OSD_ADT_LISTENERS`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `DELETE` iv_pattern = `/sap/bc/adt/debugger/listeners` iv_handler = `ZCL_OSD_ADT_LISTENERS`
         CHANGING ct_routes = rt_routes ).

    add( EXPORTING iv_method = `HEAD` iv_pattern = `/sap/bc/adt/compatibility/graph` iv_handler = `ZCL_OSD_ADT_GRAPH`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/compatibility/graph` iv_handler = `ZCL_OSD_ADT_GRAPH`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/systeminformation`
                   iv_handler = `ZCL_OSD_ADT_SYSINFO`
         CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/oo/validation/objectname`
                   iv_handler = `ZCL_OSD_ADT_CREATE_VALID` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/packages/validation`
                   iv_handler = `ZCL_OSD_ADT_CREATE_VALID` CHANGING ct_routes = rt_routes ).
*   Static package rows must precede future GET packages/:name rows.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/repository/informationsystem/virtualfolders/facets`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/repository/informationsystem/objecttypes`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/repository/informationsystem/releasestates`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/repository/informationsystem/objectproperties/values`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/packages/settings`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/packages/valuehelps/:what`
                   iv_handler = `ZCL_OSD_ADT_RIS_STATIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/repository/typestructure`
                   iv_handler = `ZCL_OSD_ADT_TYPESTRUCTURE` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/ddic/tables/parser/info`
                   iv_handler = `ZCL_OSD_ADT_DDIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/ddic/dataelements/:name` iv_handler = `ZCL_OSD_ADT_DDIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/ddic/tables/:name` iv_handler = `ZCL_OSD_ADT_DDIC` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/ddic/tables/:name/source/main` iv_handler = `ZCL_OSD_ADT_DDIC` CHANGING ct_routes = rt_routes ).
*   After the B1 statics: packages/settings must match before packages/:name.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/packages/:name` iv_handler = `ZCL_OSD_ADT_PACKAGE` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/repository/informationsystem/search` iv_handler = `ZCL_OSD_ADT_SEARCH` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/repository/informationsystem/virtualfolders/contents` iv_handler = `ZCL_OSD_ADT_VFS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/repository/nodepath` iv_handler = `ZCL_OSD_ADT_TREE` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/repository/nodestructure` iv_handler = `ZCL_OSD_ADT_TREE` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/checkruns/reporters`
                   iv_handler = `ZCL_OSD_ADT_CHECKRUN` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/checkruns`
                   iv_handler = `ZCL_OSD_ADT_CHECKRUN` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/abapunit/metadata`
                   iv_handler = `ZCL_OSD_ADT_UNIT_OBJECT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/unit/object`
                   iv_handler = `ZCL_OSD_ADT_UNIT_OBJECT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/sessions`
                   iv_handler = `ZCL_OSD_ADT_SESSIONS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `DELETE` iv_pattern = `/sap/bc/adt/core/http/sessions/:id`
                   iv_handler = `ZCL_OSD_ADT_SESSIONS` CHANGING ct_routes = rt_routes ).
*   Node host only: SAP's standard logoff node is not shipped as SICF.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/public/bc/icf/logoff`
                   iv_handler = `ZCL_OSD_ADT_LOGOFF` CHANGING ct_routes = rt_routes ).
*   LOCK and UNLOCK, one row per lockable type, from the type table
    lt_types = zcl_osd_adt_types=>lockable( ).
    LOOP AT lt_types INTO ls_type.
      lv_pattern = c_base && `/` && ls_type-collection && `/:name`.
      add( EXPORTING iv_method = `POST` iv_pattern = lv_pattern iv_handler = `ZCL_OSD_ADT_LOCK`
           CHANGING ct_routes = rt_routes ).
    ENDLOOP.
*   Source and document rows follow the Node source-collection loop order.
*   Specific GET rows precede the HOST catch-all and cannot shadow POST LOCK.
    lt_types = zcl_osd_adt_types=>sources( ).
    LOOP AT lt_types INTO ls_type.
      lv_pattern = c_base && `/` && ls_type-collection && `/:name`.
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/source/main`
                     iv_handler = `ZCL_OSD_ADT_SOURCE` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/includes/:include`
                     iv_handler = `ZCL_OSD_ADT_SOURCE` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/includes/:include/source/main`
                     iv_handler = `ZCL_OSD_ADT_SOURCE` CHANGING ct_routes = rt_routes ).
      lv_pattern = c_base && `/` && ls_type-collection && `/:name/source/main/versions`.
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern iv_handler = `ZCL_OSD_ADT_VERSIONS`
           CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/:stamp/:version/content`
                     iv_handler = `ZCL_OSD_ADT_VERSIONS` CHANGING ct_routes = rt_routes ).
      IF ls_type-type = `DDLS`.
        lv_pattern = c_base && `/` && ls_type-collection && `/:name/versions`.
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern iv_handler = `ZCL_OSD_ADT_VERSIONS`
             CHANGING ct_routes = rt_routes ).
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/:stamp/:version/content`
                       iv_handler = `ZCL_OSD_ADT_VERSIONS` CHANGING ct_routes = rt_routes ).
      ENDIF.
      IF ls_type-type = `CLAS` OR ls_type-type = `INTF`.
        lv_pattern = c_base && `/` && ls_type-collection && `/:name/includes/:include/versions`.
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern iv_handler = `ZCL_OSD_ADT_VERSIONS`
             CHANGING ct_routes = rt_routes ).
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/:stamp/:version/content`
                       iv_handler = `ZCL_OSD_ADT_VERSIONS` CHANGING ct_routes = rt_routes ).
      ENDIF.
      lv_pattern = c_base && `/` && ls_type-collection && `/:name`.
      IF ls_type-type = `CLAS` OR ls_type-type = `PROG` OR ls_type-type = `INTF` OR ls_type-type = `DDLS`.
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern
                       iv_handler = `ZCL_OSD_ADT_OBJECT` CHANGING ct_routes = rt_routes ).
      ENDIF.
    ENDLOOP.
*   B2b: structure rows and its bare aliases, separate from source B2a.
    lt_types = zcl_osd_adt_types=>sources( ).
    LOOP AT lt_types INTO ls_type.
      lv_pattern = c_base && `/` && ls_type-collection && `/:name`.
      add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/objectstructure`
        iv_handler = `ZCL_OSD_ADT_STRUCTURE` CHANGING ct_routes = rt_routes ).
      IF ls_type-type = `INCL` OR ls_type-type = `SRVD`.
        add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern
          iv_handler = `ZCL_OSD_ADT_STRUCTURE` CHANGING ct_routes = rt_routes ).
      ENDIF.
    ENDLOOP.
    IF zcl_osd_adt_host=>one_runtime( ) = abap_true.
      add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/datapreview/freestyle`
                     iv_handler = `ZCL_OSD_ADT_FREESTYLE` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/datapreview/ddic/:name/metadata`
                     iv_handler = `ZCL_OSD_ADT_PREVIEW` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/datapreview/ddic`
                     iv_handler = `ZCL_OSD_ADT_PREVIEW` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/datapreview/cds/:name/metadata`
                     iv_handler = `ZCL_OSD_ADT_PREVIEW` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/datapreview/cds`
                     iv_handler = `ZCL_OSD_ADT_PREVIEW` CHANGING ct_routes = rt_routes ).
    ENDIF.
*   Only ADT on one runtime can bind the serving generation and DUMP.
    lv_classrun_by = c_host.
    IF zcl_osd_kernel_guard=>has_generation( ) = abap_true.
      lv_classrun_by = c_abap.
    ENDIF.
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/oo/classrun/:name`
      iv_handler = `ZCL_OSD_ADT_CLASSRUN` iv_served_by = lv_classrun_by
      CHANGING ct_routes = rt_routes ).
*   A10: SEGW entity set map.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/segw/entitysets`
      iv_handler = `ZCL_OSD_ADT_ENTITYSETS` CHANGING ct_routes = rt_routes ).
*   A8a: thin introspection documents over SYSTEM raw.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/build`
      iv_handler = `ZCL_OSD_ADT_INTROSPECT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/changed`
      iv_handler = `ZCL_OSD_ADT_INTROSPECT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/services`
      iv_handler = `ZCL_OSD_ADT_INTROSPECT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/transactions`
      iv_handler = `ZCL_OSD_ADT_INTROSPECT` CHANGING ct_routes = rt_routes ).
*   A3b: loopback browser handoff.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/reentranceticket`
      iv_handler = `ZCL_OSD_ADT_REENTRANCE` CHANGING ct_routes = rt_routes ).
*   A9: xref readers and closure use the serving database.
    IF zcl_osd_kernel_guard=>has_serving_database( ) = abap_true.
      add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/xref/readers`
        iv_handler = `ZCL_OSD_ADT_XREF` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/core/http/xref/closure`
        iv_handler = `ZCL_OSD_ADT_XREF` CHANGING ct_routes = rt_routes ).
    ENDIF.
*   Function groups and their parts (FUGR/F, FUGR/FF, FUGR/I), read-only.
    lv_pattern = c_base && `/functions/groups/:name`.
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/source/main`
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/includes/:include`
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/includes/:include/source/main`
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/fmodules/:module`
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = lv_pattern && `/fmodules/:module/source/main`
      iv_handler = `ZCL_OSD_ADT_FUNCTION` CHANGING ct_routes = rt_routes ).
*   Message classes (MSAG/N): the document and its text form.
    add( EXPORTING iv_method = `GET` iv_pattern = c_base && `/messageclass/:name`
      iv_handler = `ZCL_OSD_ADT_MSAG` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = c_base && `/messageclass/:name/source/main`
      iv_handler = `ZCL_OSD_ADT_MSAG` CHANGING ct_routes = rt_routes ).
*   The creation wizards' other preflights (programs, includes).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/programs/validation`
      iv_handler = `ZCL_OSD_ADT_CREATE_VALID` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/includes/validation`
      iv_handler = `ZCL_OSD_ADT_CREATE_VALID` CHANGING ct_routes = rt_routes ).
*   Cross-reference reads: the main programs of an include (D010INC) and
*   where-used (WBCROSSGT), where the kernel has the seeded tables.
    IF zcl_osd_kernel_guard=>has_cross_reference( ) = abap_true.
      add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/programs/includes/:name/mainprograms`
        iv_handler = `ZCL_OSD_ADT_INCLUDES` CHANGING ct_routes = rt_routes ).
      add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/repository/informationsystem/usageReferences`
        iv_handler = `ZCL_OSD_ADT_WHEREUSED` CHANGING ct_routes = rt_routes ).
    ENDIF.
*   everything else is still the Node facade's, until its group moves
*   A2: editor helpers, transport checks and occurrence markers.
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/feeds`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/feeds/variants`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/system/users`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/runtime/dumps`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/runtime/systemmessages`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `GET` iv_pattern = `/sap/bc/adt/gw/errorlog`
                   iv_handler = `ZCL_OSD_ADT_FEEDS` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/cts/transportchecks`
                   iv_handler = `ZCL_OSD_ADT_TRANSPORT` CHANGING ct_routes = rt_routes ).
    add( EXPORTING iv_method = `POST` iv_pattern = `/sap/bc/adt/abapsource/occurencemarkers`
                   iv_handler = `ZCL_OSD_ADT_OCCURRENCES` CHANGING ct_routes = rt_routes ).

    add( EXPORTING iv_method = `*` iv_pattern = `/sap/bc/adt/*` iv_served_by = c_host
         CHANGING ct_routes = rt_routes ).
  ENDMETHOD.

  METHOD add.
    DATA ls_route TYPE ty_route.
    ls_route-method = iv_method.
    ls_route-pattern = iv_pattern.
    ls_route-handler = iv_handler.
    ls_route-resume_kind = iv_resume_kind.
    ls_route-served_by = iv_served_by.
    APPEND ls_route TO ct_routes.
  ENDMETHOD.

  METHOD match.
    DATA ls_route TYPE ty_route.
    DATA lv_match TYPE abap_bool.

    CLEAR: ev_found, es_route, et_params.
    LOOP AT it_routes INTO ls_route.
      IF ls_route-method <> `*` AND ls_route-method <> iv_method
          AND NOT ( iv_method = `HEAD` AND ls_route-method = `GET` ).
        CONTINUE.
      ENDIF.
      match_pattern( EXPORTING iv_pattern = ls_route-pattern
                               iv_path    = iv_path
                     IMPORTING ev_match   = lv_match
                               et_params  = et_params ).
      IF lv_match = abap_true.
        ev_found = abap_true.
        es_route = ls_route.
        RETURN.
      ENDIF.
    ENDLOOP.
    CLEAR et_params.
  ENDMETHOD.

  METHOD match_pattern.
    DATA lt_pattern TYPE string_table.
    DATA lt_path TYPE string_table.
    DATA lv_part TYPE string.
    DATA lv_segment TYPE string.
    DATA lv_last TYPE i.
    DATA ls_param TYPE zif_osd_adt_route=>ty_param.

    CLEAR: ev_match, et_params.
    SPLIT iv_pattern AT `/` INTO TABLE lt_pattern.
    SPLIT iv_path AT `/` INTO TABLE lt_path.
    lv_last = lines( lt_pattern ).

    LOOP AT lt_pattern INTO lv_part.
      IF sy-tabix = lv_last AND lv_part = `*`.
        ev_match = abap_true.
        RETURN.
      ENDIF.
      READ TABLE lt_path INDEX sy-tabix INTO lv_segment.
      IF sy-subrc <> 0.
        CLEAR et_params.
        RETURN.
      ENDIF.
      IF strlen( lv_part ) > 1 AND lv_part(1) = `:`.
        IF lv_segment IS INITIAL.
          CLEAR et_params.
          RETURN.
        ENDIF.
        ls_param-name = substring( val = lv_part off = 1 ).
*       raw: decoded by dispatch after the match, where a refusal is a 400
        ls_param-value = lv_segment.
        APPEND ls_param TO et_params.
      ELSEIF to_lower( lv_part ) <> to_lower( lv_segment ).
        CLEAR et_params.
        RETURN.
      ENDIF.
    ENDLOOP.

    IF lines( lt_path ) = lv_last.
      ev_match = abap_true.
    ELSE.
      CLEAR et_params.
    ENDIF.
  ENDMETHOD.

  METHOD dispatch.
    DATA ls_route TYPE ty_route.
    DATA lv_found TYPE abap_bool.
    DATA ls_request TYPE zif_osd_adt_route=>ty_request.
    DATA li_route TYPE REF TO zif_osd_adt_route.
    DATA lt_routes TYPE tt_route.
    FIELD-SYMBOLS <ls_param> LIKE LINE OF ls_request-params.

    lt_routes = it_routes.
    IF lt_routes IS INITIAL.
      lt_routes = routes( ).
    ENDIF.
    ls_request = is_request.
    match( EXPORTING it_routes = lt_routes
                     iv_method = is_request-method
                     iv_path   = is_request-path
           IMPORTING ev_found  = lv_found
                     es_route  = ls_route
                     et_params = ls_request-params ).
    IF lv_found = abap_false OR ls_route-served_by = c_host.
      rs_result-served_by = c_host.
      RETURN.
    ENDIF.

    LOOP AT ls_request-params ASSIGNING <ls_param>.
      <ls_param>-value = zcl_osd_adt_uri=>decode_segment( <ls_param>-value ).
    ENDLOOP.

*   A HEAD falling back to GET keeps the GET answer for HTTP body suppression.
    IF is_request-method = `HEAD` AND ls_route-method = `GET`.
      ls_request-method = `GET`.
    ENDIF.
    ls_request-pattern = ls_route-pattern.
    CREATE OBJECT li_route TYPE (ls_route-handler).
    rs_result-served_by = c_abap.
    rs_result-response = li_route->handle( ls_request ).
  ENDMETHOD.

ENDCLASS.
