CLASS ltcl_saver DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    TYPES tt_create   TYPE TABLE FOR CREATE /dmo/i_travel_m\\travel.
    TYPES tt_cba_book TYPE TABLE FOR CREATE /dmo/i_travel_m\\travel\_booking.
    TYPES tt_cba_supp TYPE TABLE FOR CREATE /dmo/i_travel_m\\booking\_booksupplement.
    TYPES tt_update   TYPE TABLE FOR UPDATE /dmo/i_travel_m\\travel.
    TYPES tt_delete   TYPE TABLE FOR DELETE /dmo/i_travel_m\\travel.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY /dmo/i_travel_m.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY /dmo/i_travel_m.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY /dmo/i_travel_m.
    DATA mo_rap      TYPE REF TO zcl_osd_rap_runtime.
    DATA ms_mapped   TYPE ty_mapped.
    DATA ms_failed   TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.
    METHODS setup.
    METHODS teardown.
    METHODS travel_with_supplement
      RETURNING
        VALUE(rv_travel) TYPE /dmo/travel_id.
    METHODS commit.
    METHODS logs_the_create FOR TESTING RAISING cx_static_check.
    METHODS logs_the_update FOR TESTING RAISING cx_static_check.
    METHODS supplement_through_the_saver FOR TESTING RAISING cx_static_check.
    METHODS delete_logged_and_cascaded FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_saver IMPLEMENTATION.

  METHOD setup.
    mo_rap = zcl_osd_rap_runtime=>for_bdef( '/DMO/I_TRAVEL_M' ).
    CLEAR: ms_mapped, ms_failed, ms_reported.
  ENDMETHOD.

  METHOD teardown.
    mo_rap->rollback( ).
  ENDMETHOD.

  METHOD commit.
    DATA lv_saved TYPE abap_bool.
    mo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_true( act = lv_saved msg = 'saved' ).
  ENDMETHOD.

  METHOD travel_with_supplement.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA lt_book   TYPE tt_cba_book.
    DATA ls_book   LIKE LINE OF lt_book.
    DATA ls_btgt   LIKE LINE OF ls_book-%target.
    DATA lt_supp   TYPE tt_cba_supp.
    DATA ls_supp   LIKE LINE OF lt_supp.
    DATA ls_stgt   LIKE LINE OF ls_supp-%target.
    DATA ls_line   LIKE LINE OF ms_mapped-travel.
    DATA lv_today  TYPE d.

    lv_today = cl_abap_context_info=>get_system_date( ).
    ls_create-%cid = 'T'.
    ls_create-agency_id = '070015'.
    ls_create-customer_id = '000078'.
    ls_create-begin_date = lv_today + 10.
    ls_create-end_date = lv_today + 20.
    ls_create-booking_fee = 20.
    ls_create-currency_code = 'EUR'.
    ls_create-overall_status = 'O'.
    ls_create-description = 'R7 unit'.
    ls_create-%control-agency_id = if_abap_behv=>mk-on.
    ls_create-%control-customer_id = if_abap_behv=>mk-on.
    ls_create-%control-begin_date = if_abap_behv=>mk-on.
    ls_create-%control-end_date = if_abap_behv=>mk-on.
    ls_create-%control-booking_fee = if_abap_behv=>mk-on.
    ls_create-%control-currency_code = if_abap_behv=>mk-on.
    ls_create-%control-overall_status = if_abap_behv=>mk-on.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'travel' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).

    ls_book-%cid_ref = 'T'.
    ls_btgt-%cid = 'B'.
    ls_btgt-booking_date = lv_today.
    ls_btgt-customer_id = '000078'.
    ls_btgt-carrier_id = 'SQ'.
    ls_btgt-connection_id = '0001'.
    " the generator windows its flights around the day the seed is made, so
    " the date is read from the seed, not written down: a fixed date fell out
    " of the window on 2026-11-16 and every test here went red with no change
    SELECT SINGLE flight_date FROM /dmo/flight
      WHERE carrier_id = @ls_btgt-carrier_id AND connection_id = @ls_btgt-connection_id
      INTO @ls_btgt-flight_date.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the seed holds an SQ 0001 flight' ).
    ls_btgt-flight_price = 100.
    ls_btgt-currency_code = 'EUR'.
    ls_btgt-booking_status = 'N'.
    ls_btgt-%control-booking_date = if_abap_behv=>mk-on.
    ls_btgt-%control-customer_id = if_abap_behv=>mk-on.
    ls_btgt-%control-carrier_id = if_abap_behv=>mk-on.
    ls_btgt-%control-connection_id = if_abap_behv=>mk-on.
    ls_btgt-%control-flight_date = if_abap_behv=>mk-on.
    ls_btgt-%control-flight_price = if_abap_behv=>mk-on.
    ls_btgt-%control-currency_code = if_abap_behv=>mk-on.
    ls_btgt-%control-booking_status = if_abap_behv=>mk-on.
    APPEND ls_btgt TO ls_book-%target.
    APPEND ls_book TO lt_book.
    mo_rap->create_by( EXPORTING iv_entity = 'travel' iv_assoc = '_booking' it_rows = lt_book
                       CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).

    ls_supp-%cid_ref = 'B'.
    ls_stgt-%cid = 'S'.
    ls_stgt-supplement_id = 'ML-0001'.
    ls_stgt-price = 17.
    ls_stgt-currency_code = 'EUR'.
    ls_stgt-%control-supplement_id = if_abap_behv=>mk-on.
    ls_stgt-%control-price = if_abap_behv=>mk-on.
    ls_stgt-%control-currency_code = if_abap_behv=>mk-on.
    APPEND ls_stgt TO ls_supp-%target.
    APPEND ls_supp TO lt_supp.
    mo_rap->create_by( EXPORTING iv_entity = 'booking' iv_assoc = '_booksupplement' it_rows = lt_supp
                       CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( ms_failed ).
    commit( ).
    READ TABLE ms_mapped-travel INDEX 1 INTO ls_line.
    rv_travel = ls_line-travel_id.
  ENDMETHOD.

  METHOD logs_the_create.
    DATA lv_travel TYPE /dmo/travel_id.
    DATA lt_log    TYPE STANDARD TABLE OF /dmo/log_travel WITH DEFAULT KEY.
    DATA ls_log    TYPE /dmo/log_travel.

    lv_travel = travel_with_supplement( ).
    SELECT * FROM /dmo/log_travel INTO TABLE @lt_log WHERE travel_id = @lv_travel.
* the saver logs a create's booking_fee and overall_status, each %control flagged
    cl_abap_unit_assert=>assert_equals( act = lines( lt_log ) exp = 2 ).
    READ TABLE lt_log INTO ls_log WITH KEY changed_field_name = 'booking_fee'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_log-changing_operation exp = 'CREATE' ).
    READ TABLE lt_log INTO ls_log WITH KEY changed_field_name = 'overall_status'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
  ENDMETHOD.

  METHOD logs_the_update.
    DATA lv_travel TYPE /dmo/travel_id.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lv_count  TYPE i.

    lv_travel = travel_with_supplement( ).
    ls_update-travel_id = lv_travel.
    ls_update-description = 'changed'.
    ls_update-%control-description = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'travel' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    commit( ).
    SELECT COUNT(*) FROM /dmo/log_travel INTO @lv_count
      WHERE travel_id = @lv_travel AND changing_operation = 'UPDATE' AND changed_field_name = 'description'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
* customer_id was not changed: not logged
    SELECT COUNT(*) FROM /dmo/log_travel INTO @lv_count
      WHERE travel_id = @lv_travel AND changing_operation = 'UPDATE' AND changed_field_name = 'customer_id'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD supplement_through_the_saver.
    DATA lv_travel TYPE /dmo/travel_id.
    DATA ls_suppl  TYPE /dmo/booksuppl_m.

    lv_travel = travel_with_supplement( ).
    SELECT SINGLE * FROM /dmo/booksuppl_m INTO @ls_suppl WHERE travel_id = @lv_travel.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'written by /DMO/FLIGHT_BOOKSUPPL_C' ).
    cl_abap_unit_assert=>assert_equals( act = ls_suppl-booking_id exp = '0010' ).
    cl_abap_unit_assert=>assert_equals( act = ls_suppl-booking_supplement_id exp = '01' ).
    cl_abap_unit_assert=>assert_equals( act = ls_suppl-supplement_id exp = 'ML-0001' ).
  ENDMETHOD.

  METHOD delete_logged_and_cascaded.
    DATA lv_travel TYPE /dmo/travel_id.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA lv_count  TYPE i.

    lv_travel = travel_with_supplement( ).
    ls_delete-travel_id = lv_travel.
    APPEND ls_delete TO lt_delete.
    mo_rap->modify( EXPORTING iv_entity = 'travel' iv_operation = zcl_osd_rap_runtime=>co_operation-delete it_rows = lt_delete
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    commit( ).
    SELECT COUNT(*) FROM /dmo/travel_m INTO @lv_count WHERE travel_id = @lv_travel.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM /dmo/booksuppl_m INTO @lv_count WHERE travel_id = @lv_travel.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'deleted by /DMO/FLIGHT_BOOKSUPPL_D' ).
    SELECT COUNT(*) FROM /dmo/log_travel INTO @lv_count WHERE travel_id = @lv_travel AND changing_operation = 'DELETE'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
  ENDMETHOD.

ENDCLASS.
