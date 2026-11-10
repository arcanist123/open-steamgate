CLASS zcl_stg_http_handler DEFINITION PUBLIC CREATE PUBLIC.
* ICF entry point: if_http_extension on a real system, cl_express_icf_shim
* on Node. Everything OData happens in zcl_stg_dispatcher.
  PUBLIC SECTION.
    INTERFACES if_http_extension.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_stg_http_handler IMPLEMENTATION.

  METHOD if_http_extension~handle_request.
    DATA lv_method   TYPE string.
    DATA lv_path     TYPE string.
    DATA lv_host     TYPE string.
    DATA lv_proto    TYPE string.
    DATA lt_options  TYPE tihttpnvp.
    DATA lt_headers  TYPE tihttpnvp.
    DATA ls_response TYPE zcl_stg_dispatcher=>ty_response.
    DATA ls_header   TYPE ihttpnvp.
    DATA lv_body     TYPE string.
    DATA lv_body_x   TYPE xstring.

    lv_method = server->request->get_header_field( '~request_method' ).
    lv_path   = server->request->get_header_field( '~path' ).
    lv_host   = server->request->get_header_field( 'host' ).
    IF lv_host IS INITIAL.
      lv_host = 'localhost'.
    ENDIF.
* behind a reverse proxy, or in the browser preview where the service is
* mounted below a path, the absolute URLs in the answers need the outside view
    lv_proto = server->request->get_header_field( 'x-forwarded-proto' ).
    IF lv_proto IS INITIAL.
      lv_proto = 'http'.
    ENDIF.
    lv_host = |{ lv_proto }://{ lv_host }{ server->request->get_header_field( 'x-forwarded-prefix' ) }|.
    server->request->get_form_fields_cs( CHANGING fields = lt_options ).
* the whole header set travels with the request: If-Match of a write is
* read from it (the ETag check of ZCL_STG_DISPATCHER), as the V4 front does
    server->request->get_header_fields( CHANGING fields = lt_headers ).
    lv_body = server->request->get_cdata( ).
* a media resource (PUT <entity>/$value) is bytes, not text
    lv_body_x = server->request->get_data( ).

* CSRF: UI5 fetches a token with a GET and sends it back on writes. There is
* no session to protect locally, so any token is accepted; hand one out.
    IF to_lower( server->request->get_header_field( 'x-csrf-token' ) ) = 'fetch'.
      server->response->set_header_field( name  = 'x-csrf-token'
                                          value = 'open-steamgate' ).
    ENDIF.

* One modifying request is one LUW (backlog B.2). The COMMIT before is the
* fence: nothing in this system commits on its own, so without it the
* ROLLBACK after a failure would reach back to whatever the process last
* wrote, including the tables the generation writes at boot. $batch is left
* alone here, because its changesets own their own brackets and a commit
* around the whole batch would defeat them.
    IF lv_method <> 'GET' AND lv_method <> 'HEAD' AND lv_path NP '*/$batch*'.
      COMMIT WORK.
    ENDIF.

    ls_response = zcl_stg_dispatcher=>dispatch( iv_method  = lv_method
                                                iv_path    = lv_path
                                                it_options = lt_options
                                                iv_host    = lv_host
                                                iv_body    = lv_body
                                                iv_body_x  = lv_body_x
                                                iv_content_type = server->request->get_header_field( 'content-type' )
                                                it_headers = lt_headers ).

    IF lv_method <> 'GET' AND lv_method <> 'HEAD' AND lv_path NP '*/$batch*'.
      IF ls_response-status >= 400.
* a request that failed half way through -- a deep insert whose second row
* was refused, a composition delete whose child went and whose parent did
* not -- leaves nothing behind
        ROLLBACK WORK.
      ELSE.
        COMMIT WORK.
      ENDIF.
    ENDIF.

    LOOP AT ls_response-headers INTO ls_header.
      server->response->set_header_field( name  = ls_header-name
                                          value = ls_header-value ).
    ENDLOOP.
    IF ls_response-content_type IS NOT INITIAL.
      server->response->set_header_field( name  = 'content-type'
                                          value = ls_response-content_type ).
    ENDIF.
    server->response->set_header_field( name  = 'dataserviceversion'
                                        value = '2.0' ).
    IF ls_response-body_x IS NOT INITIAL.
      server->response->set_data( ls_response-body_x ).
    ELSE.
      server->response->set_cdata( ls_response-body ).
    ENDIF.
    server->response->set_status( code   = ls_response-status
                                  reason = ls_response-reason ).
  ENDMETHOD.

ENDCLASS.
