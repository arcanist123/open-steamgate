CLASS zcl_osd_m4g_dpc DEFINITION PUBLIC INHERITING FROM zcl_osd_h5x_dpc CREATE PUBLIC.
* Milestone 4, the host's safety (tools/hana-host-guard.mjs): a provider
* that tries to leave the box and one that runs into a stub, each swallowing
* what it met and answering 200 -- the shape a delivered DPC may well have.
* The read of the partner set is the twin's own; a filter on Name chooses a
* case instead:
*   M4URL:<url>   cl_http_client=>create_by_url + send, the failure answered
*                 through EXCEPTIONS and ignored;
*   M4DEST:<name> the same through create_by_destination;
*   M4ROOT:<url>  the send inside TRY ... CATCH cx_root, its failure raised
*                 as a class-based exception and swallowed there;
*   M4STUB        a method the closure stubbed (zcl_osd_m4g_gap), the raise
*                 caught by CATCH cx_root.
* Each case answers an empty partner set. Nothing on the wire says what
* happened; the host's trace has to.
*
* Three cases go below the ABAP on purpose, with kernel splices -- the
* shape of hostile delivered SOURCE the host's guard locks the cheap doors
* against (this is our own test tree, where the splice is legitimate):
*   M4TAMPER  assigns the host's stub hook: ignored, recorded as tampering;
*   M4RAW     a name lookup in JavaScript: the refusal crosses the ABAP as a
*             plain error (CATCH cx_root does not catch it), a 500 whose text
*             must not carry the target;
*   M4LISTEN  opens a listener: refused, the same way.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
  PRIVATE SECTION.
    METHODS send
      IMPORTING
        io_client TYPE REF TO if_http_client
      RETURNING
        VALUE(rv_subrc) TYPE i.
    METHODS by_url
      IMPORTING
        iv_url TYPE string.
    METHODS by_destination
      IMPORTING
        iv_destination TYPE string.
    METHODS swallowed
      IMPORTING
        iv_url TYPE string.
    METHODS below
      IMPORTING
        iv_case TYPE string.
ENDCLASS.

CLASS zcl_osd_m4g_dpc IMPLEMENTATION.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    DATA lt_filter TYPE /iwbep/t_mgw_select_option.
    DATA ls_filter LIKE LINE OF lt_filter.
    DATA ls_range  TYPE /iwbep/s_cod_select_option.
    DATA lv_case   TYPE string.
    DATA lv_arg    TYPE string.
    DATA lv_text   TYPE string.
    DATA lt_empty  TYPE zcl_osd_h5x_mpc=>tt_partner.

    IF iv_entity_set_name = 'PartnerSet'
        AND io_tech_request_context->get_source_entity_set_name( ) IS INITIAL.
      lt_filter = io_tech_request_context->get_filter( )->get_filter_select_options( ).
      LOOP AT lt_filter INTO ls_filter.
        IF to_upper( ls_filter-property ) <> 'NAME'.
          CONTINUE.
        ENDIF.
        LOOP AT ls_filter-select_options INTO ls_range.
          IF strlen( ls_range-low ) >= 2 AND substring( val = ls_range-low len = 2 ) = 'M4'.
            lv_text = ls_range-low.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
    ENDIF.

    IF lv_text IS INITIAL.
      super->/iwbep/if_mgw_appl_srv_runtime~get_entityset(
        EXPORTING
          iv_entity_name           = iv_entity_name
          iv_entity_set_name       = iv_entity_set_name
          iv_source_name           = iv_source_name
          it_filter_select_options = it_filter_select_options
          is_paging                = is_paging
          it_key_tab               = it_key_tab
          it_navigation_path       = it_navigation_path
          it_order                 = it_order
          iv_filter_string         = iv_filter_string
          iv_search_string         = iv_search_string
          io_tech_request_context  = io_tech_request_context
        IMPORTING
          er_entityset             = er_entityset
          es_response_context      = es_response_context ).
      RETURN.
    ENDIF.

    SPLIT lv_text AT ':' INTO lv_case lv_arg.
    IF lv_text CS ':'.
      lv_arg = substring( val = lv_text off = strlen( lv_case ) + 1 ).
    ENDIF.
    CASE lv_case.
      WHEN 'M4URL'.
        by_url( lv_arg ).
      WHEN 'M4DEST'.
        by_destination( lv_arg ).
      WHEN 'M4ROOT'.
        TRY.
            swallowed( lv_arg ).
          CATCH cx_root.
* swallowed on purpose: the case is a provider that hides a failure
        ENDTRY.
      WHEN 'M4TAMPER' OR 'M4RAW' OR 'M4LISTEN'.
        TRY.
            below( lv_case ).
          CATCH cx_root.
* swallowed on purpose: what reaches here is no ABAP exception anyway
        ENDTRY.
      WHEN 'M4STUB'.
        TRY.
            lv_text = zcl_osd_m4g_gap=>not_here( ).
          CATCH cx_root.
* swallowed on purpose, as above
        ENDTRY.
    ENDCASE.

    copy_data_to_ref( EXPORTING is_data = lt_empty
                      CHANGING  cr_data = er_entityset ).
  ENDMETHOD.

  METHOD send.
    io_client->send(
      EXCEPTIONS
        http_communication_failure = 1
        http_invalid_state         = 2
        http_processing_failed     = 3
        OTHERS                     = 4 ).
    rv_subrc = sy-subrc.
    IF rv_subrc = 0.
      io_client->receive(
        EXCEPTIONS
          http_communication_failure = 1
          http_invalid_state         = 2
          http_processing_failed     = 3
          OTHERS                     = 4 ).
      rv_subrc = sy-subrc.
    ENDIF.
    io_client->close( ).
  ENDMETHOD.

  METHOD by_url.
    DATA lo_client TYPE REF TO if_http_client.

    cl_http_client=>create_by_url(
      EXPORTING
        url    = iv_url
      IMPORTING
        client = lo_client
      EXCEPTIONS
        OTHERS = 1 ).
    IF sy-subrc = 0.
      send( lo_client ).
    ENDIF.
  ENDMETHOD.

  METHOD by_destination.
    DATA lo_client TYPE REF TO if_http_client.

    cl_http_client=>create_by_destination(
      EXPORTING
        destination = iv_destination
      IMPORTING
        client      = lo_client
      EXCEPTIONS
        OTHERS      = 1 ).
    IF sy-subrc = 0.
      send( lo_client ).
    ENDIF.
  ENDMETHOD.

  METHOD below.
    CASE iv_case.
      WHEN 'M4TAMPER'.
        WRITE '@KERNEL globalThis.osdNotActivated = () => {};'.
      WHEN 'M4RAW'.
        WRITE '@KERNEL await (await import("node:dns")).promises.lookup("m4-raw-target.invalid");'.
      WHEN 'M4LISTEN'.
        WRITE '@KERNEL (await import("node:net")).createServer().listen(0, "127.0.0.1");'.
    ENDCASE.
  ENDMETHOD.

  METHOD swallowed.
    DATA lo_client TYPE REF TO if_http_client.

    cl_http_client=>create_by_url(
      EXPORTING
        url    = iv_url
      IMPORTING
        client = lo_client
      EXCEPTIONS
        OTHERS = 1 ).
    IF sy-subrc <> 0 OR send( lo_client ) <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
