CLASS lcl_silent DEFINITION FINAL.
* The trip BO with a numbering method that answers nothing: no MAPPED line
* and no FAILED line for any row. Everything else is the generated adapter.
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
    METHODS constructor RAISING cx_static_check.
  PRIVATE SECTION.
    DATA mi_bo TYPE REF TO zif_osd_rap_bo.
ENDCLASS.

CLASS lcl_silent IMPLEMENTATION.

  METHOD constructor.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    CREATE OBJECT li_registry TYPE ('ZCL_OSD_RAP_REGISTRY').
    mi_bo = li_registry->get( 'ZI_RAP_TRIP' ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~model.
    rs_model = mi_bo->model( ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_rows.
    rr_rows = mi_bo->new_rows( iv_entity ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_table.
    rr_table = mi_bo->new_table( iv_entity = iv_entity iv_kind = iv_kind iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_response.
    rr_response = mi_bo->new_response( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_result.
    rr_result = mi_bo->new_result( iv_entity = iv_entity iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_request.
    rr_request = mi_bo->new_request( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~save_modified.
    mi_bo->save_modified( io_saver = io_saver ir_create = ir_create ir_update = ir_update
                          ir_delete = ir_delete ir_reported = ir_reported ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~adjust_numbers.
    RETURN.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~call.
    IF iv_name = '%NUMBERING'.
      RETURN.
    ENDIF.
    mi_bo->call( io_handler = io_handler iv_entity = iv_entity iv_name = iv_name
                 ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                 ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_numbering DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    TYPES tt_create TYPE TABLE FOR CREATE zi_rap_trip.
    TYPES ty_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_trip.
    TYPES ty_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_trip.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_trip.
    DATA mo_rap TYPE REF TO zcl_osd_rap_runtime.
    METHODS teardown.
    METHODS row
      IMPORTING iv_cid TYPE csequence
      CHANGING ct_rows TYPE tt_create.
    METHODS caller_cid_like_a_temporary FOR TESTING RAISING cx_static_check.
    METHODS blank_beside_caller_cids FOR TESTING RAISING cx_static_check.
    METHODS unmapped_row_fails FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_numbering IMPLEMENTATION.

  METHOD teardown.
    IF mo_rap IS BOUND.
      mo_rap->rollback( ).
    ENDIF.
  ENDMETHOD.

  METHOD row.
    DATA ls_row LIKE LINE OF ct_rows.
    ls_row-%cid = iv_cid.
    ls_row-description = |trip { iv_cid }|.
    ls_row-%control-description = if_abap_behv=>mk-on.
    APPEND ls_row TO ct_rows.
  ENDMETHOD.

  METHOD caller_cid_like_a_temporary.
* a caller may name a content ID the way the runtime names its temporary
* ones; it comes back in MAPPED unchanged, with a key of its own
    DATA lt_rows     TYPE tt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_line     LIKE LINE OF ls_mapped-trip.

    mo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_TRIP' ).
    row( EXPORTING iv_cid = '%OSD-NUMBERING-1-0' CHANGING ct_rows = lt_rows ).
    mo_rap->modify( EXPORTING iv_entity = 'trip' iv_operation = 'C' it_rows = lt_rows
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-trip ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_mapped-trip ) exp = 1 ).
    READ TABLE ls_mapped-trip INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = '%OSD-NUMBERING-1-0' ).
    cl_abap_unit_assert=>assert_not_initial( ls_line-trip_id ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 1 ).
  ENDMETHOD.

  METHOD blank_beside_caller_cids.
* a row without a content ID beside rows that carry the one the runtime
* would have given it: three rows, three keys, every caller ID kept
    DATA lt_rows     TYPE tt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_line     LIKE LINE OF ls_mapped-trip.
    DATA lt_ids      TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_id       TYPE string.

    mo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_TRIP' ).
    row( EXPORTING iv_cid = '' CHANGING ct_rows = lt_rows ).
    row( EXPORTING iv_cid = '%OSD-NUMBERING-1-0' CHANGING ct_rows = lt_rows ).
    row( EXPORTING iv_cid = 'client' CHANGING ct_rows = lt_rows ).
    mo_rap->modify( EXPORTING iv_entity = 'trip' iv_operation = 'C' it_rows = lt_rows
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed-trip ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_mapped-trip ) exp = 3 ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 3 ).
    READ TABLE ls_mapped-trip INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_initial( ls_line-%cid ).
    READ TABLE ls_mapped-trip INDEX 2 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = '%OSD-NUMBERING-1-0' ).
    READ TABLE ls_mapped-trip INDEX 3 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = 'client' ).
    LOOP AT ls_mapped-trip INTO ls_line.
      lv_id = ls_line-trip_id.
      READ TABLE lt_ids TRANSPORTING NO FIELDS WITH KEY table_line = lv_id.
      cl_abap_unit_assert=>assert_subrc( exp = 4 act = sy-subrc ).
      APPEND lv_id TO lt_ids.
    ENDLOOP.
  ENDMETHOD.

  METHOD unmapped_row_fails.
* every input %cid must come back in MAPPED or FAILED; one that comes back
* in neither is failed, not created with the initial key it came with
    DATA lo_silent   TYPE REF TO lcl_silent.
    DATA lt_rows     TYPE tt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_line     LIKE LINE OF ls_failed-trip.

    CREATE OBJECT lo_silent.
    mo_rap = zcl_osd_rap_runtime=>for_bo( lo_silent ).
    row( EXPORTING iv_cid = 'unmapped' CHANGING ct_rows = lt_rows ).
    mo_rap->modify( EXPORTING iv_entity = 'trip' iv_operation = 'C' it_rows = lt_rows
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_mapped-trip ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-trip ) exp = 1 ).
    READ TABLE ls_failed-trip INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = 'unmapped' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_reported-trip ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 ).
  ENDMETHOD.

ENDCLASS.
