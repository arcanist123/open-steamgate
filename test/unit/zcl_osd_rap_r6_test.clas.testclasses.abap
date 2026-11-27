CLASS lcl_lazy DEFINITION FINAL.
* The bill BO whose factory handler maps nothing: the runtime must fail the
* import row (the factory's contract). Everything else is the generated
* adapter.
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
    METHODS constructor RAISING cx_static_check.
  PRIVATE SECTION.
    DATA mi_bo TYPE REF TO zif_osd_rap_bo.
ENDCLASS.

CLASS lcl_lazy IMPLEMENTATION.

  METHOD constructor.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    CREATE OBJECT li_registry TYPE ('ZCL_OSD_RAP_REGISTRY').
    mi_bo = li_registry->get( 'ZI_RAP_BILL' ).
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
    IF to_upper( iv_name ) = 'COPYBILL'.
      RETURN.
    ENDIF.
    mi_bo->call( io_handler = io_handler iv_entity = iv_entity iv_name = iv_name
                 ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                 ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_actions DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    TYPES tt_create   TYPE TABLE FOR CREATE zi_rap_bill.
    TYPES tt_update   TYPE TABLE FOR UPDATE zi_rap_bill.
    TYPES tt_read     TYPE TABLE FOR READ IMPORT zi_rap_bill.
    TYPES tt_bills    TYPE TABLE FOR READ RESULT zi_rap_bill.
    TYPES tt_recalc   TYPE TABLE FOR ACTION IMPORT zi_rap_bill~recalctotal.
    TYPES tt_copy     TYPE TABLE FOR ACTION IMPORT zi_rap_bill~copybill.
    TYPES tt_check    TYPE TABLE FOR ACTION IMPORT zi_rap_bill~check.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY zi_rap_bill.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_bill.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_bill.
    DATA mo_rap TYPE REF TO zcl_osd_rap_runtime.
    METHODS setup.
    METHODS teardown.
* a bill in the buffer (not saved); its number
    METHODS new_bill
      IMPORTING
        iv_amount       TYPE i
        iv_discount     TYPE i
      RETURNING
        VALUE(rv_bill)  TYPE zrap_bill-bill_id.
* a saved bill; its number
    METHODS saved_bill
      IMPORTING
        iv_amount       TYPE i
        iv_discount     TYPE i
      RETURNING
        VALUE(rv_bill)  TYPE zrap_bill-bill_id.
    METHODS read_bill
      IMPORTING
        iv_bill        TYPE zrap_bill-bill_id
      RETURNING
        VALUE(rs_bill) TYPE zrap_bill.
    METHODS internal_refused_outside FOR TESTING RAISING cx_static_check.
    METHODS internal_refused_through_eml FOR TESTING RAISING cx_static_check.
    METHODS internal_runs_in_local_mode FOR TESTING RAISING cx_static_check.
    METHODS factory_maps_the_copy FOR TESTING RAISING cx_static_check.
    METHODS factory_through_eml FOR TESTING RAISING cx_static_check.
    METHODS factory_without_mapping FOR TESTING RAISING cx_static_check.
    METHODS factory_needs_a_cid FOR TESTING RAISING cx_static_check.
    METHODS determine_runs_triggered FOR TESTING RAISING cx_static_check.
    METHODS determine_runs_always FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_actions IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zrap_bill.
    COMMIT WORK.
    mo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_BILL' ).
  ENDMETHOD.

  METHOD teardown.
    mo_rap->rollback( ).
    DELETE FROM zrap_bill.
    COMMIT WORK.
  ENDMETHOD.

  METHOD new_bill.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_line     LIKE LINE OF ls_mapped-bill.

    ls_create-%cid = |B{ iv_amount }-{ iv_discount }|.
    ls_create-description = 'bill'.
    ls_create-amount = iv_amount.
    ls_create-discount = iv_discount.
    ls_create-%control-description = if_abap_behv=>mk-on.
    ls_create-%control-amount = if_abap_behv=>mk-on.
    ls_create-%control-discount = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'bill' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    READ TABLE ls_mapped-bill INDEX 1 INTO ls_line.
    rv_bill = ls_line-bill_id.
  ENDMETHOD.

  METHOD saved_bill.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lv_saved    TYPE abap_bool.

    rv_bill = new_bill( iv_amount = iv_amount iv_discount = iv_discount ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
  ENDMETHOD.

  METHOD read_bill.
    SELECT SINGLE * FROM zrap_bill INTO rs_bill WHERE bill_id = iv_bill.
  ENDMETHOD.

  METHOD internal_refused_outside.
* the internal action is the BO's own: a caller outside its handlers is refused
    DATA lt_keys     TYPE tt_recalc.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lx_error    TYPE REF TO zcx_osd_rap.

    ls_key-bill_id = saved_bill( iv_amount = 10 iv_discount = 1 ).
    APPEND ls_key TO lt_keys.
    TRY.
        mo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'ReCalcTotal' it_keys = lt_keys
                         CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported ).
        cl_abap_unit_assert=>fail( 'an internal action executed from outside' ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>assert_char_cp( act = lx_error->get_text( ) exp = '*is internal*IN LOCAL MODE*' ).
    ENDTRY.
  ENDMETHOD.

  METHOD internal_refused_through_eml.
* the same through the statement: the session's runtime, at depth 0
    DATA lt_keys   TYPE tt_recalc.
    DATA ls_key    LIKE LINE OF lt_keys.
    DATA ls_failed TYPE ty_failed.
    DATA lv_caught TYPE abap_bool.

    ls_key-bill_id = saved_bill( iv_amount = 10 iv_discount = 1 ).
    APPEND ls_key TO lt_keys.
    TRY.
        MODIFY ENTITIES OF zi_rap_bill
          ENTITY bill
            EXECUTE recalctotal FROM lt_keys
          FAILED ls_failed.
      CATCH zcx_osd_rap.
        lv_caught = abap_true.
    ENDTRY.
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_true( lv_caught ).
  ENDMETHOD.

  METHOD internal_runs_in_local_mode.
* calcTotal executes ReCalcTotal IN LOCAL MODE: the total follows
    DATA lv_bill     TYPE zrap_bill-bill_id.
    DATA lt_update   TYPE tt_update.
    DATA ls_update   LIKE LINE OF lt_update.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lv_saved    TYPE abap_bool.
    DATA lt_trace    TYPE string_table.
    DATA ls_row      TYPE zrap_bill.

    lv_bill = saved_bill( iv_amount = 100 iv_discount = 30 ).
    ls_row = read_bill( lv_bill ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-total exp = 70 ).
    lt_trace = mo_rap->trace( ).
    READ TABLE lt_trace TRANSPORTING NO FIELDS WITH KEY table_line = 'ACTION RECALCTOTAL'.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).

    ls_update-bill_id = lv_bill.
    ls_update-discount = 50.
    ls_update-%control-discount = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'bill' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
    ls_row = read_bill( lv_bill ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-total exp = 50 ).
  ENDMETHOD.

  METHOD factory_maps_the_copy.
    DATA lv_bill     TYPE zrap_bill-bill_id.
    DATA lt_keys     TYPE tt_copy.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_line     LIKE LINE OF ls_mapped-bill.
    DATA lv_saved    TYPE abap_bool.
    DATA ls_copy     TYPE zrap_bill.

    lv_bill = saved_bill( iv_amount = 40 iv_discount = 5 ).
    ls_key-bill_id = lv_bill.
    ls_key-%cid = 'COPY1'.
    APPEND ls_key TO lt_keys.
    mo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'copyBill' it_keys = lt_keys
                     CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported
                              cs_mapped = ls_mapped ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_mapped-bill ) exp = 1 ).
    READ TABLE ls_mapped-bill INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = 'COPY1' ).
    cl_abap_unit_assert=>assert_differs( act = ls_line-bill_id exp = lv_bill ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
    ls_copy = read_bill( ls_line-bill_id ).
    cl_abap_unit_assert=>assert_equals( act = ls_copy-copied_from exp = lv_bill ).
    cl_abap_unit_assert=>assert_equals( act = ls_copy-amount exp = 40 ).
* the copy is a create: its determinations ran
    cl_abap_unit_assert=>assert_equals( act = ls_copy-total exp = 35 ).
  ENDMETHOD.

  METHOD factory_through_eml.
* EXECUTE ... MAPPED: the statement's MAPPED gets the copy
    DATA lv_bill   TYPE zrap_bill-bill_id.
    DATA lt_keys   TYPE tt_copy.
    DATA ls_key    LIKE LINE OF lt_keys.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_failed TYPE ty_failed.
    DATA ls_line   LIKE LINE OF ls_mapped-bill.

    lv_bill = saved_bill( iv_amount = 8 iv_discount = 0 ).
    ls_key-bill_id = lv_bill.
    ls_key-%cid = 'EML1'.
    APPEND ls_key TO lt_keys.
    MODIFY ENTITIES OF zi_rap_bill
      ENTITY bill
        EXECUTE copybill FROM lt_keys
      MAPPED ls_mapped
      FAILED ls_failed.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    zcl_osd_rap_eml=>reset( ).
    READ TABLE ls_mapped-bill INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%cid exp = 'EML1' ).
    cl_abap_unit_assert=>assert_not_initial( ls_line-bill_id ).
  ENDMETHOD.

  METHOD factory_without_mapping.
* a factory handler that maps nothing and fails nothing breaks the contract
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA lo_rap      TYPE REF TO zcl_osd_rap_runtime.
    DATA lt_keys     TYPE tt_copy.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_fail     LIKE LINE OF ls_failed-bill.

    ls_key-bill_id = saved_bill( iv_amount = 3 iv_discount = 1 ).
    ls_key-%cid = 'LAZY'.
    APPEND ls_key TO lt_keys.
    CREATE OBJECT li_bo TYPE lcl_lazy.
    lo_rap = zcl_osd_rap_runtime=>for_bo( li_bo ).
    lo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'copyBill' it_keys = lt_keys
                     CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported
                              cs_mapped = ls_mapped ).
    lo_rap->rollback( ).
    cl_abap_unit_assert=>assert_initial( ls_mapped-bill ).
    READ TABLE ls_failed-bill INDEX 1 INTO ls_fail.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = ls_fail-%cid exp = 'LAZY' ).
  ENDMETHOD.

  METHOD factory_needs_a_cid.
* a row without %cid is refused up front, by name, and nothing is copied
    DATA lt_keys     TYPE tt_copy.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_msg      LIKE LINE OF ls_reported-bill.
    DATA lo_msg      TYPE REF TO if_message.
    DATA lt_trace    TYPE string_table.

    ls_key-bill_id = saved_bill( iv_amount = 3 iv_discount = 1 ).
    APPEND ls_key TO lt_keys.
    mo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'copyBill' it_keys = lt_keys
                     CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported
                              cs_mapped = ls_mapped ).
    cl_abap_unit_assert=>assert_initial( ls_mapped-bill ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-bill ) exp = 1 ).
    READ TABLE ls_reported-bill INDEX 1 INTO ls_msg.
    lo_msg ?= ls_msg-%msg.
    cl_abap_unit_assert=>assert_char_cp( act = lo_msg->get_text( ) exp = '*needs a %cid*' ).
    lt_trace = mo_rap->trace( ).
    READ TABLE lt_trace TRANSPORTING NO FIELDS WITH KEY table_line = 'ACTION COPYBILL'.
    cl_abap_unit_assert=>assert_subrc( exp = 4 ).
  ENDMETHOD.

  METHOD determine_runs_triggered.
* a new bill: the validation's triggers hold (create), so it runs and fails
    DATA lv_bill     TYPE zrap_bill-bill_id.
    DATA lt_keys     TYPE tt_check.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_fail     LIKE LINE OF ls_failed-bill.
    DATA lt_read     TYPE tt_read.
    DATA ls_read     LIKE LINE OF lt_read.
    DATA lt_bills    TYPE tt_bills.
    DATA ls_bill     LIKE LINE OF lt_bills.

    lv_bill = new_bill( iv_amount = 5 iv_discount = 9 ).
    ls_key-bill_id = lv_bill.
    APPEND ls_key TO lt_keys.
    mo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'check' it_keys = lt_keys
                     CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported ).
    READ TABLE ls_failed-bill INDEX 1 INTO ls_fail.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = ls_fail-bill_id exp = lv_bill ).
    cl_abap_unit_assert=>assert_not_initial( ls_reported-bill ).
* the instance stays in the buffer, counted once
    ls_read-bill_id = lv_bill.
    APPEND ls_read TO lt_read.
    mo_rap->read( EXPORTING iv_entity = 'bill' it_keys = lt_read CHANGING ct_result = lt_bills cs_failed = ls_failed ).
    READ TABLE lt_bills INDEX 1 INTO ls_bill.
    cl_abap_unit_assert=>assert_subrc( exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = ls_bill-checks exp = 1 ).
  ENDMETHOD.

  METHOD determine_runs_always.
* a saved bill: the validation's triggers do not hold, the ( always )
* determination runs anyway; the save does not run it again
    DATA lv_bill     TYPE zrap_bill-bill_id.
    DATA lt_keys     TYPE tt_check.
    DATA ls_key      LIKE LINE OF lt_keys.
    DATA lt_none     TYPE string_table.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lt_trace    TYPE string_table.
    DATA lv_line     TYPE string.
    DATA lv_after    TYPE abap_bool.
    DATA lv_saved    TYPE abap_bool.
    DATA ls_row      TYPE zrap_bill.

    lv_bill = saved_bill( iv_amount = 20 iv_discount = 2 ).
* the save ran countCheck once: the amount was set on create
    ls_row = read_bill( lv_bill ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-checks exp = 1 ).
    ls_key-bill_id = lv_bill.
    APPEND ls_key TO lt_keys.
    mo_rap->execute( EXPORTING iv_entity = 'bill' iv_action = 'check' it_keys = lt_keys
                     CHANGING ct_result = lt_none cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    lt_trace = mo_rap->trace( ).
    LOOP AT lt_trace INTO lv_line.
      IF lv_line = 'DETERMINE ACTION CHECK'.
        lv_after = abap_true.
      ELSEIF lv_after = abap_true.
        cl_abap_unit_assert=>assert_differs( act = lv_line exp = 'VALIDATION CHECKAMOUNT' ).
      ENDIF.
    ENDLOOP.
    cl_abap_unit_assert=>assert_true( lv_after ).
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
    ls_row = read_bill( lv_bill ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-checks exp = 2 ).
  ENDMETHOD.

ENDCLASS.
