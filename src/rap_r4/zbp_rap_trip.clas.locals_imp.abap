* The trip demo of R4 (docs/rap-runtime.md, "R4"): the constructs the
* flight reference scenario's travel uses beside its compositions, written
* the way that scenario writes them -- early numbering through a FOR
* NUMBERING method, instance features through a FOR INSTANCE FEATURES
* method, an etag master on a field the runtime stamps -- with EML inside
* the handlers.
*
* A trip is open (O) when created. Accept sets A, reject sets X. An
* accepted trip cannot be accepted again or deleted; a rejected trip cannot
* be rejected again or changed.
CLASS lhc_trip DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS get_features FOR INSTANCE FEATURES
      IMPORTING keys REQUEST requested_features FOR trip RESULT result.
    METHODS earlynumbering_create FOR NUMBERING
      IMPORTING entities FOR CREATE trip.
    METHODS set_status FOR DETERMINE ON MODIFY
      IMPORTING keys FOR trip~setstatus.
    METHODS accept FOR MODIFY
      IMPORTING keys FOR ACTION trip~accept RESULT result.
    METHODS reject FOR MODIFY
      IMPORTING keys FOR ACTION trip~reject RESULT result.
    METHODS change_status
      IMPORTING
        it_keys   TYPE STANDARD TABLE
        iv_status TYPE c
      CHANGING
        ct_result TYPE STANDARD TABLE
        cs_mapped TYPE any
        cs_failed TYPE any
        cs_reported TYPE any.
ENDCLASS.

CLASS lhc_trip IMPLEMENTATION.

  METHOD get_features.
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_trip.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_trips  TYPE TABLE FOR READ RESULT zi_rap_trip.
    DATA ls_trip   LIKE LINE OF lt_trips.
    DATA ls_result LIKE LINE OF result.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_trip IN LOCAL MODE
      ENTITY trip
        FIELDS ( status ) WITH lt_read
      RESULT lt_trips
      FAILED failed.

    LOOP AT lt_trips INTO ls_trip.
      CLEAR ls_result.
      ls_result-%tky = ls_trip-%tky.
      ls_result-%update = if_abap_behv=>fc-o-enabled.
      ls_result-%delete = if_abap_behv=>fc-o-enabled.
      ls_result-%action-accept = if_abap_behv=>fc-o-enabled.
      ls_result-%action-reject = if_abap_behv=>fc-o-enabled.
      IF ls_trip-status = 'A'.
        ls_result-%delete = if_abap_behv=>fc-o-disabled.
        ls_result-%action-accept = if_abap_behv=>fc-o-disabled.
      ELSEIF ls_trip-status = 'X'.
        ls_result-%update = if_abap_behv=>fc-o-disabled.
        ls_result-%action-reject = if_abap_behv=>fc-o-disabled.
      ENDIF.
      APPEND ls_result TO result.
    ENDLOOP.
  ENDMETHOD.

  METHOD earlynumbering_create.
* the next number after the highest one saved and the ones drawn in this
* call; a create that brings its own number keeps it
    DATA ls_entity LIKE LINE OF entities.
    DATA ls_mapped LIKE LINE OF mapped-trip.
    DATA lv_max    TYPE n LENGTH 8.

    SELECT MAX( trip_id ) FROM zrap_trip INTO lv_max.
    LOOP AT entities INTO ls_entity WHERE trip_id IS NOT INITIAL.
      IF ls_entity-trip_id > lv_max.
        lv_max = ls_entity-trip_id.
      ENDIF.
    ENDLOOP.
    LOOP AT entities INTO ls_entity.
      CLEAR ls_mapped.
      ls_mapped-%cid = ls_entity-%cid.
      IF ls_entity-trip_id IS INITIAL.
        lv_max = lv_max + 1.
        ls_mapped-trip_id = lv_max.
      ELSE.
        ls_mapped-trip_id = ls_entity-trip_id.
      ENDIF.
      APPEND ls_mapped TO mapped-trip.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_status.
* a new trip is open
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_trip.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_trips  TYPE TABLE FOR READ RESULT zi_rap_trip.
    DATA ls_trip   LIKE LINE OF lt_trips.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_trip.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_trip IN LOCAL MODE
      ENTITY trip
        FIELDS ( status ) WITH lt_read
      RESULT lt_trips.
    LOOP AT lt_trips INTO ls_trip WHERE status IS INITIAL.
      CLEAR ls_update.
      ls_update-%tky = ls_trip-%tky.
      ls_update-status = 'O'.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    IF lt_update IS INITIAL.
      RETURN.
    ENDIF.
    MODIFY ENTITIES OF zi_rap_trip IN LOCAL MODE
      ENTITY trip
        UPDATE FIELDS ( status ) WITH lt_update
      REPORTED reported.
  ENDMETHOD.

  METHOD accept.
    change_status( EXPORTING it_keys = keys iv_status = 'A'
                   CHANGING ct_result = result cs_mapped = mapped cs_failed = failed cs_reported = reported ).
  ENDMETHOD.

  METHOD reject.
    change_status( EXPORTING it_keys = keys iv_status = 'X'
                   CHANGING ct_result = result cs_mapped = mapped cs_failed = failed cs_reported = reported ).
  ENDMETHOD.

  METHOD change_status.
* the status of every trip given, then the trips themselves as the result
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_trip.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lt_read   TYPE TABLE FOR READ IMPORT zi_rap_trip.
    DATA ls_read   LIKE LINE OF lt_read.
    DATA lt_trips  TYPE TABLE FOR READ RESULT zi_rap_trip.
    DATA ls_trip   LIKE LINE OF lt_trips.
    DATA ls_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_trip.
    DATA ls_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_trip.
    DATA ls_report TYPE RESPONSE FOR REPORTED EARLY zi_rap_trip.
    FIELD-SYMBOLS <ls_key>    TYPE any.
    FIELD-SYMBOLS <lv_id>     TYPE any.
    FIELD-SYMBOLS <ls_result> TYPE any.
    FIELD-SYMBOLS <lv_value>  TYPE any.

    LOOP AT it_keys ASSIGNING <ls_key>.
      ASSIGN COMPONENT 'TRIP_ID' OF STRUCTURE <ls_key> TO <lv_id>.
      CLEAR: ls_update, ls_read.
      ls_update-trip_id = <lv_id>.
      ls_update-status = iv_status.
      APPEND ls_update TO lt_update.
      ls_read-trip_id = <lv_id>.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    MODIFY ENTITIES OF zi_rap_trip IN LOCAL MODE
      ENTITY trip
        UPDATE FIELDS ( status ) WITH lt_update
      MAPPED ls_mapped FAILED ls_failed REPORTED ls_report.
    READ ENTITIES OF zi_rap_trip IN LOCAL MODE
      ENTITY trip
        ALL FIELDS WITH lt_read
      RESULT lt_trips.
    LOOP AT lt_trips INTO ls_trip.
      APPEND INITIAL LINE TO ct_result ASSIGNING <ls_result>.
      ASSIGN COMPONENT 'TRIP_ID' OF STRUCTURE <ls_result> TO <lv_value>.
      <lv_value> = ls_trip-trip_id.
      ASSIGN COMPONENT '%PARAM' OF STRUCTURE <ls_result> TO <lv_value>.
      MOVE-CORRESPONDING ls_trip TO <lv_value>.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
