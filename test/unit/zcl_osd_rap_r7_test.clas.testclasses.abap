CLASS ltcl_save DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    TYPES tt_create   TYPE TABLE FOR CREATE zi_rap_tour.
    TYPES tt_cba      TYPE TABLE FOR CREATE zi_rap_tour\_stops.
    TYPES tt_update   TYPE TABLE FOR UPDATE zi_rap_tour.
    TYPES tt_stop_upd TYPE TABLE FOR UPDATE zi_rap_tourstop.
    TYPES tt_delete   TYPE TABLE FOR DELETE zi_rap_tour.
    TYPES tt_read     TYPE TABLE FOR READ IMPORT zi_rap_tourstop.
    TYPES tt_stops    TYPE TABLE FOR READ RESULT zi_rap_tourstop.
    TYPES tt_close    TYPE TABLE FOR ACTION IMPORT zi_rap_tour~close.
    TYPES tt_closed   TYPE TABLE FOR ACTION RESULT zi_rap_tour~close.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY zi_rap_tour.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_tour.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_tour.
    TYPES tt_log      TYPE STANDARD TABLE OF zrap_tourlog WITH DEFAULT KEY.
    DATA mo_rap TYPE REF TO zcl_osd_rap_runtime.
    METHODS setup.
    METHODS teardown.
    METHODS clear_tables.
* a tour with one stop per entry of IT_NIGHTS, created and committed
    METHODS tour
      IMPORTING
        it_nights      TYPE int4_table
      EXPORTING
        ev_tour     TYPE zrap_tour-tour_id
        ev_saved    TYPE abap_bool
        es_failed   TYPE ty_failed
        es_reported TYPE ty_reported.
    METHODS log_of
      IMPORTING
        iv_tour       TYPE zrap_tour-tour_id
      RETURNING
        VALUE(rt_log) TYPE tt_log.
    METHODS commit
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.
    METHODS creates_and_logs FOR TESTING RAISING cx_static_check.
    METHODS update_logs_changed_fields FOR TESTING RAISING cx_static_check.
    METHODS unmanaged_update FOR TESTING RAISING cx_static_check.
    METHODS unmanaged_read FOR TESTING RAISING cx_static_check.
    METHODS delete_through_the_saver FOR TESTING RAISING cx_static_check.
    METHODS second_pool_validates FOR TESTING RAISING cx_static_check.
    METHODS action_is_logged FOR TESTING RAISING cx_static_check.
    METHODS model_names_pools FOR TESTING RAISING cx_static_check.
    METHODS saver_failure_ends_it FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_save IMPLEMENTATION.

  METHOD setup.
    clear_tables( ).
    mo_rap = zcl_osd_rap_runtime=>for_bdef( 'ZI_RAP_TOUR' ).
  ENDMETHOD.

  METHOD teardown.
    mo_rap->rollback( ).
    clear_tables( ).
  ENDMETHOD.

  METHOD clear_tables.
    DELETE FROM zrap_tourstop.
    DELETE FROM zrap_tour.
    DELETE FROM zrap_tourlog.
    COMMIT WORK.
  ENDMETHOD.

  METHOD tour.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA lt_cba      TYPE tt_cba.
    DATA ls_cba      LIKE LINE OF lt_cba.
    DATA ls_target   LIKE LINE OF ls_cba-%target.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_line     LIKE LINE OF ls_mapped-tour.
    DATA lv_nights   TYPE i.

    ls_create-%cid = 'T1'.
    ls_create-description = 'tour'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'tour' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = es_failed cs_reported = es_reported ).
    ls_cba-%cid_ref = 'T1'.
    LOOP AT it_nights INTO lv_nights.
      CLEAR ls_target.
      ls_target-%cid = |S{ sy-tabix }|.
      ls_target-place = |place { sy-tabix }|.
      ls_target-nights = lv_nights.
      ls_target-%control-place = if_abap_behv=>mk-on.
      ls_target-%control-nights = if_abap_behv=>mk-on.
      APPEND ls_target TO ls_cba-%target.
    ENDLOOP.
    APPEND ls_cba TO lt_cba.
    mo_rap->create_by( EXPORTING iv_entity = 'tour' iv_assoc = '_stops' it_rows = lt_cba
                       CHANGING cs_mapped = ls_mapped cs_failed = es_failed cs_reported = es_reported ).
    mo_rap->commit( IMPORTING ev_saved = ev_saved CHANGING cs_failed = es_failed cs_reported = es_reported ).
    READ TABLE ls_mapped-tour INDEX 1 INTO ls_line.
    ev_tour = ls_line-tour_id.
  ENDMETHOD.

  METHOD log_of.
    SELECT * FROM zrap_tourlog INTO TABLE rt_log WHERE tour_id = iv_tour ORDER BY operation field_name.
  ENDMETHOD.

  METHOD commit.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    mo_rap->commit( IMPORTING ev_saved = rv_saved CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
  ENDMETHOD.

  METHOD creates_and_logs.
    DATA lt_nights TYPE int4_table.
    DATA lv_tour   TYPE zrap_tour-tour_id.
    DATA lv_saved  TYPE abap_bool.
    DATA ls_tour   TYPE zrap_tour.
    DATA lt_stops  TYPE STANDARD TABLE OF zrap_tourstop WITH DEFAULT KEY.
    DATA ls_stop   TYPE zrap_tourstop.
    DATA lt_log    TYPE tt_log.
    DATA ls_log    TYPE zrap_tourlog.
    DATA lt_trace  TYPE string_table.

    APPEND 2 TO lt_nights.
    APPEND 3 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ev_saved = lv_saved ).
    cl_abap_unit_assert=>assert_true( lv_saved ).
* the managed write of the tour
    SELECT SINGLE * FROM zrap_tour INTO ls_tour WHERE tour_id = lv_tour.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_tour-status exp = 'O' ).
* the unmanaged save of the stops, through the mapping read backwards
    SELECT * FROM zrap_tourstop INTO TABLE lt_stops WHERE tour_id = lv_tour ORDER BY stop_no.
    cl_abap_unit_assert=>assert_equals( act = lines( lt_stops ) exp = 2 msg = 'the saver wrote the stops' ).
    READ TABLE lt_stops INDEX 2 INTO ls_stop.
    cl_abap_unit_assert=>assert_equals( act = ls_stop-stop_no exp = '0002' ).
    cl_abap_unit_assert=>assert_equals( act = ls_stop-place_name exp = 'place 2' msg = 'place -> place_name' ).
    cl_abap_unit_assert=>assert_equals( act = ls_stop-nights exp = 3 ).
    cl_abap_unit_assert=>assert_not_initial( ls_stop-stop_changed_at ).
* the additional save of the tour
    lt_log = log_of( lv_tour ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_log ) exp = 1 ).
    READ TABLE lt_log INDEX 1 INTO ls_log.
    cl_abap_unit_assert=>assert_equals( act = ls_log-operation exp = 'CREATE' ).
    cl_abap_unit_assert=>assert_equals( act = ls_log-new_value exp = 'tour' ).
* the sequence
    lt_trace = mo_rap->trace( ).
    READ TABLE lt_trace TRANSPORTING NO FIELDS WITH KEY table_line = 'ADJUST_NUMBERS'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    READ TABLE lt_trace TRANSPORTING NO FIELDS WITH KEY table_line = 'SAVE_MODIFIED'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
  ENDMETHOD.

  METHOD update_logs_changed_fields.
    DATA lt_nights   TYPE int4_table.
    DATA lv_tour     TYPE zrap_tour-tour_id.
    DATA lt_update   TYPE tt_update.
    DATA ls_update   LIKE LINE OF lt_update.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lt_log      TYPE tt_log.
    DATA ls_log      TYPE zrap_tourlog.

    APPEND 1 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ).
    ls_update-tour_id = lv_tour.
    ls_update-description = 'renamed'.
    ls_update-%control-description = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'tour' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    lt_log = log_of( lv_tour ).
* CREATE description, UPDATE description -- and no UPDATE status: only the
* changed fields are flagged in the request
    cl_abap_unit_assert=>assert_equals( act = lines( lt_log ) exp = 2 ).
    READ TABLE lt_log INDEX 2 INTO ls_log.
    cl_abap_unit_assert=>assert_equals( act = ls_log-operation exp = 'UPDATE' ).
    cl_abap_unit_assert=>assert_equals( act = ls_log-field_name exp = 'description' ).
    cl_abap_unit_assert=>assert_equals( act = ls_log-new_value exp = 'renamed' ).
  ENDMETHOD.

  METHOD unmanaged_update.
    DATA lt_nights   TYPE int4_table.
    DATA lv_tour     TYPE zrap_tour-tour_id.
    DATA lt_update   TYPE tt_stop_upd.
    DATA ls_update   LIKE LINE OF lt_update.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_stop     TYPE zrap_tourstop.

    APPEND 1 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ).
    ls_update-tour_id = lv_tour.
    ls_update-stop_no = '0001'.
    ls_update-nights = 4.
    ls_update-%control-nights = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'stop' iv_operation = zcl_osd_rap_runtime=>co_operation-update it_rows = lt_update
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE * FROM zrap_tourstop INTO ls_stop WHERE tour_id = lv_tour AND stop_no = '0001'.
    cl_abap_unit_assert=>assert_equals( act = ls_stop-nights exp = 4 ).
    cl_abap_unit_assert=>assert_equals( act = ls_stop-place_name exp = 'place 1' msg = 'an unflagged field keeps its value' ).
  ENDMETHOD.

  METHOD unmanaged_read.
* an entity without a persistent table reads saved instances from its mapping table
    DATA lt_nights TYPE int4_table.
    DATA lv_tour   TYPE zrap_tour-tour_id.
    DATA lt_keys   TYPE tt_read.
    DATA ls_key    LIKE LINE OF lt_keys.
    DATA lt_stops  TYPE tt_stops.
    DATA ls_stop   LIKE LINE OF lt_stops.
    DATA ls_failed TYPE ty_failed.

    APPEND 5 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ).
    ls_key-tour_id = lv_tour.
    ls_key-stop_no = '0001'.
    APPEND ls_key TO lt_keys.
    mo_rap->read( EXPORTING iv_entity = 'stop' it_keys = lt_keys CHANGING ct_result = lt_stops cs_failed = ls_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_stops ) exp = 1 ).
    READ TABLE lt_stops INDEX 1 INTO ls_stop.
    cl_abap_unit_assert=>assert_equals( act = ls_stop-place exp = 'place 1' ).
    cl_abap_unit_assert=>assert_equals( act = ls_stop-nights exp = 5 ).
  ENDMETHOD.

  METHOD delete_through_the_saver.
    DATA lt_nights   TYPE int4_table.
    DATA lv_tour     TYPE zrap_tour-tour_id.
    DATA lt_delete   TYPE tt_delete.
    DATA ls_delete   LIKE LINE OF lt_delete.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lv_count    TYPE i.
    DATA lt_log      TYPE tt_log.
    DATA ls_log      TYPE zrap_tourlog.

    APPEND 1 TO lt_nights.
    APPEND 2 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ).
    ls_delete-tour_id = lv_tour.
    APPEND ls_delete TO lt_delete.
    mo_rap->modify( EXPORTING iv_entity = 'tour' iv_operation = zcl_osd_rap_runtime=>co_operation-delete it_rows = lt_delete
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT COUNT(*) FROM zrap_tour INTO lv_count WHERE tour_id = lv_tour.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the managed delete' ).
    SELECT COUNT(*) FROM zrap_tourstop INTO lv_count WHERE tour_id = lv_tour.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the cascade reached the saver' ).
    lt_log = log_of( lv_tour ).
    READ TABLE lt_log INTO ls_log WITH KEY operation = 'DELETE'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the delete is logged' ).
  ENDMETHOD.

  METHOD second_pool_validates.
    DATA lt_nights   TYPE int4_table.
    DATA lv_saved    TYPE abap_bool.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_msg      LIKE LINE OF ls_reported-stop.
    DATA lo_msg      TYPE REF TO if_message.
    DATA lv_count    TYPE i.

    APPEND 0 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_saved = lv_saved es_failed = ls_failed es_reported = ls_reported ).
    cl_abap_unit_assert=>assert_false( lv_saved ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-stop ) exp = 1 ).
    READ TABLE ls_reported-stop INDEX 1 INTO ls_msg.
    lo_msg ?= ls_msg-%msg.
    cl_abap_unit_assert=>assert_equals( act = lo_msg->get_text( ) exp = 'Stop 0001: at least one night' ).
* nothing is written: neither the managed nor the savers' part
    SELECT COUNT(*) FROM zrap_tour INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zrap_tourstop INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zrap_tourlog INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD action_is_logged.
    DATA lt_nights   TYPE int4_table.
    DATA lv_tour     TYPE zrap_tour-tour_id.
    DATA lt_close    TYPE tt_close.
    DATA ls_close    LIKE LINE OF lt_close.
    DATA lt_closed   TYPE tt_closed.
    DATA ls_closed   LIKE LINE OF lt_closed.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lt_log      TYPE tt_log.
    DATA ls_log      TYPE zrap_tourlog.

    APPEND 1 TO lt_nights.
    tour( EXPORTING it_nights = lt_nights IMPORTING ev_tour = lv_tour ).
    ls_close-tour_id = lv_tour.
    APPEND ls_close TO lt_close.
    mo_rap->execute( EXPORTING iv_entity = 'tour' iv_action = 'close' it_keys = lt_close
                     CHANGING ct_result = lt_closed cs_failed = ls_failed cs_reported = ls_reported ).
    cl_abap_unit_assert=>assert_initial( ls_failed ).
    READ TABLE lt_closed INDEX 1 INTO ls_closed.
    cl_abap_unit_assert=>assert_equals( act = ls_closed-%param-status exp = 'C' ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    lt_log = log_of( lv_tour ).
    READ TABLE lt_log INTO ls_log WITH KEY operation = 'UPDATE' field_name = 'status'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_log-new_value exp = 'C' ).
  ENDMETHOD.

  METHOD model_names_pools.
    DATA ls_model  TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    ls_model = mo_rap->bo( )->model( ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY alias = 'stop'.
    cl_abap_unit_assert=>assert_equals( act = ls_entity-pool exp = 'ZBP_RAP_STOP' ).
    cl_abap_unit_assert=>assert_equals( act = ls_entity-handler exp = '\CLASS-POOL=ZBP_RAP_STOP\CLASS=LHC_STOP' ).
    cl_abap_unit_assert=>assert_equals( act = ls_entity-save exp = 'U' ).
    cl_abap_unit_assert=>assert_equals( act = ls_entity-table exp = 'ZRAP_TOURSTOP' ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY alias = 'tour'.
    cl_abap_unit_assert=>assert_equals( act = ls_entity-save exp = 'A' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_model-savers ) exp = 1 ).
  ENDMETHOD.

  METHOD saver_failure_ends_it.
* a saver that fails in the save: the managed write is rolled back with it,
* the savers' cleanup runs, the buffer is gone, and the exception says why
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    DATA lt_trace    TYPE string_table.
    DATA lv_last     TYPE string.
    DATA lv_count    TYPE i.

    ls_create-%cid = 'U1'.
    ls_create-description = 'unsaveable'.
    ls_create-%control-description = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'tour' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = ls_reported ).
    TRY.
        mo_rap->commit( CHANGING cs_failed = ls_failed cs_reported = ls_reported ).
        cl_abap_unit_assert=>fail( 'the save must fail' ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>assert_true( lx_error->save ).
        cl_abap_unit_assert=>assert_true( lx_error->business ).
        cl_abap_unit_assert=>assert_equals( act = lx_error->get_text( ) exp = `The tour log refuses an unsaveable tour` ).
    ENDTRY.
    SELECT COUNT(*) FROM zrap_tour INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the managed write is rolled back' ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 msg = 'the buffer is discarded' ).
    lt_trace = mo_rap->trace( ).
    READ TABLE lt_trace INDEX lines( lt_trace ) INTO lv_last.
    cl_abap_unit_assert=>assert_equals( act = lv_last exp = 'CLEANUP' ).
  ENDMETHOD.

ENDCLASS.
