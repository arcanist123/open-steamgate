* The tour demo of R7 (docs/rap-runtime.md, "R7"), shaped like the flight
* travel BO: the root's handlers and the saver are in this pool, the stop's
* handlers in a second one (ZBP_RAP_STOP). The tour is written by the managed
* save and then logged by save_modified (with additional save); the stops
* have no persistent table and are written by save_modified alone (with
* unmanaged save), into ZRAP_TOURSTOP through the BDEF's mapping read
* backwards (MAPPING FROM ENTITY).
*
* A new tour is open (O); close sets it to C. A tour described "unsaveable"
* makes the saver fail in the save (the test of a saver's failure).
CLASS lcx_tour_save DEFINITION INHERITING FROM cx_no_check FINAL.
  PUBLIC SECTION.
    METHODS if_message~get_text REDEFINITION.
ENDCLASS.

CLASS lcx_tour_save IMPLEMENTATION.
  METHOD if_message~get_text.
    result = `The tour log refuses an unsaveable tour`.
  ENDMETHOD.
ENDCLASS.

CLASS lhc_tour DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE tour.
    METHODS earlynumbering_cba_stops FOR NUMBERING
      IMPORTING entities FOR CREATE tour\_stops.
    METHODS set_status FOR DETERMINE ON MODIFY
      IMPORTING keys FOR tour~setstatus.
    METHODS close FOR MODIFY
      IMPORTING keys FOR ACTION tour~close RESULT result.
ENDCLASS.

CLASS lhc_tour IMPLEMENTATION.

  METHOD earlynumbering_create.
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_mapped LIKE LINE OF mapped-tour.
    DATA lv_max    TYPE n LENGTH 8.

    SELECT MAX( tour_id ) FROM zrap_tour INTO lv_max.
    LOOP AT entities INTO ls_entity.
      CLEAR ls_mapped.
      ls_mapped-%cid = ls_entity-%cid.
      IF ls_entity-tour_id IS INITIAL.
        lv_max = lv_max + 1.
        ls_mapped-tour_id = lv_max.
      ELSE.
        ls_mapped-tour_id = ls_entity-tour_id.
      ENDIF.
      APPEND ls_mapped TO mapped-tour.
    ENDLOOP.
  ENDMETHOD.

  METHOD earlynumbering_cba_stops.
* the stops of a tour are numbered 1, 2, 3 ... after the highest stop the
* tour has, saved (read from the stop's mapping table) or in this transaction
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_target LIKE LINE OF ls_entity-%target.
    DATA ls_mapped LIKE LINE OF mapped-stop.
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_tour\_stops.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_stops  TYPE TABLE FOR READ RESULT zi_rap_tour\_stops.
    DATA lt_link   TYPE TABLE FOR READ LINK zi_rap_tour\_stops.
    DATA ls_stop   LIKE LINE OF lt_stops.
    DATA ls_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_tour.
    DATA lv_max    TYPE n LENGTH 4.

    LOOP AT entities INTO ls_entity.
      CLEAR: lt_read, lt_stops, lt_link, lv_max.
      ls_read-%tky = ls_entity-%tky.
      APPEND ls_read TO lt_read.
* READ ENTITIES OF zi_rap_tour IN LOCAL MODE
*   ENTITY tour BY \_stops FROM lt_read RESULT lt_stops LINK lt_link.
* (the pinned transpiler does not lower BY \_assoc yet, docs/rap-runtime.md)
      zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef   = 'ZI_RAP_TOUR'
                                          iv_entity = 'TOUR'
                                          iv_assoc  = '_STOPS'
                                          it_keys   = lt_read
                                CHANGING  ct_result = lt_stops
                                          ct_link   = lt_link
                                          cs_failed = ls_failed ).
      LOOP AT lt_stops INTO ls_stop.
        IF ls_stop-stop_no > lv_max.
          lv_max = ls_stop-stop_no.
        ENDIF.
      ENDLOOP.
      LOOP AT ls_entity-%target INTO ls_target.
        CLEAR ls_mapped.
        ls_mapped-%cid = ls_target-%cid.
        ls_mapped-tour_id = ls_entity-tour_id.
        IF ls_target-stop_no IS INITIAL.
          lv_max = lv_max + 1.
          ls_mapped-stop_no = lv_max.
        ELSE.
          ls_mapped-stop_no = ls_target-stop_no.
        ENDIF.
        APPEND ls_mapped TO mapped-stop.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_status.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_tour.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_update.
      ls_update-%tky = ls_key-%tky.
      ls_update-status = 'O'.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    MODIFY ENTITIES OF zi_rap_tour IN LOCAL MODE
      ENTITY tour
        UPDATE FIELDS ( status ) WITH lt_update
      REPORTED reported.
  ENDMETHOD.

  METHOD close.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_tour.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_tour.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_tours  TYPE TABLE FOR READ RESULT zi_rap_tour.
    DATA ls_tour   LIKE LINE OF lt_tours.
    DATA ls_result LIKE LINE OF result.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR: ls_update, ls_read.
      ls_update-%tky = ls_key-%tky.
      ls_update-status = 'C'.
      APPEND ls_update TO lt_update.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    MODIFY ENTITIES OF zi_rap_tour IN LOCAL MODE
      ENTITY tour
        UPDATE FIELDS ( status ) WITH lt_update
      FAILED failed REPORTED reported.
    READ ENTITIES OF zi_rap_tour IN LOCAL MODE
      ENTITY tour
        ALL FIELDS WITH lt_read
      RESULT lt_tours.
    LOOP AT lt_tours INTO ls_tour.
      CLEAR ls_result.
      ls_result-%tky = ls_tour-%tky.
      ls_result-%param = CORRESPONDING #( ls_tour ).
      APPEND ls_result TO result.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

CLASS lsc_tour DEFINITION INHERITING FROM cl_abap_behavior_saver FINAL.
  PROTECTED SECTION.
    METHODS save_modified REDEFINITION.
  PRIVATE SECTION.
    METHODS log
      IMPORTING
        iv_tour  TYPE zrap_tour-tour_id
        iv_op    TYPE csequence
        iv_field TYPE csequence OPTIONAL
        iv_value TYPE csequence OPTIONAL.
ENDCLASS.

CLASS lsc_tour IMPLEMENTATION.

  METHOD save_modified.
    DATA ls_tour  LIKE LINE OF create-tour.
    DATA ls_gone  LIKE LINE OF delete-tour.
    DATA lt_stops TYPE STANDARD TABLE OF zrap_tourstop WITH DEFAULT KEY.
    DATA ls_stop  TYPE zrap_tourstop.
    DATA ls_upd   LIKE LINE OF update-stop.

* the additional save of the tour: a change log, after the managed write
    LOOP AT create-tour INTO ls_tour WHERE description = 'unsaveable'.
      RAISE EXCEPTION TYPE lcx_tour_save.
    ENDLOOP.
    LOOP AT create-tour INTO ls_tour.
      log( iv_tour = ls_tour-tour_id iv_op = 'CREATE' iv_field = 'description' iv_value = ls_tour-description ).
    ENDLOOP.
    LOOP AT update-tour INTO ls_tour.
      IF ls_tour-%control-description = if_abap_behv=>mk-on.
        log( iv_tour = ls_tour-tour_id iv_op = 'UPDATE' iv_field = 'description' iv_value = ls_tour-description ).
      ENDIF.
      IF ls_tour-%control-status = if_abap_behv=>mk-on.
        log( iv_tour = ls_tour-tour_id iv_op = 'UPDATE' iv_field = 'status' iv_value = ls_tour-status ).
      ENDIF.
    ENDLOOP.
    LOOP AT delete-tour INTO ls_gone.
      log( iv_tour = ls_gone-tour_id iv_op = 'DELETE' ).
    ENDLOOP.

* the unmanaged save of the stops: the only write they get
    IF create-stop IS NOT INITIAL.
      lt_stops = CORRESPONDING #( create-stop MAPPING FROM ENTITY ).
      INSERT zrap_tourstop FROM TABLE lt_stops.
    ENDIF.
    LOOP AT update-stop INTO ls_upd.
      SELECT SINGLE * FROM zrap_tourstop INTO ls_stop
        WHERE tour_id = ls_upd-tour_id AND stop_no = ls_upd-stop_no.
      IF ls_upd-%control-place = if_abap_behv=>mk-on.
        ls_stop-place_name = ls_upd-place.
      ENDIF.
      IF ls_upd-%control-nights = if_abap_behv=>mk-on.
        ls_stop-nights = ls_upd-nights.
      ENDIF.
      IF ls_upd-%control-stop_changed_at = if_abap_behv=>mk-on.
        ls_stop-stop_changed_at = ls_upd-stop_changed_at.
      ENDIF.
      UPDATE zrap_tourstop FROM ls_stop.
    ENDLOOP.
    IF delete-stop IS NOT INITIAL.
      lt_stops = CORRESPONDING #( delete-stop MAPPING FROM ENTITY ).
      DELETE zrap_tourstop FROM TABLE lt_stops.
    ENDIF.
  ENDMETHOD.

  METHOD log.
    DATA ls_log TYPE zrap_tourlog.
    ls_log-log_id = cl_system_uuid=>create_uuid_c32_static( ).
    ls_log-tour_id = iv_tour.
    ls_log-operation = iv_op.
    ls_log-field_name = iv_field.
    ls_log-new_value = iv_value.
    INSERT zrap_tourlog FROM ls_log.
  ENDMETHOD.

ENDCLASS.
