* The second behavior pool of the tour demo (R7): the stop's handlers live
* here, as the flight booking's live in /DMO/BP_BOOKING_M. A stop needs at
* least one night.
CLASS lhc_stop DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    METHODS check_nights FOR VALIDATE ON SAVE
      IMPORTING keys FOR stop~checknights.
ENDCLASS.

CLASS lhc_stop IMPLEMENTATION.

  METHOD check_nights.
    DATA lt_read  TYPE TABLE FOR READ IMPORT zi_rap_tourstop.
    DATA ls_read  LIKE LINE OF lt_read.
    DATA lt_stops TYPE TABLE FOR READ RESULT zi_rap_tourstop.
    DATA ls_stop  LIKE LINE OF lt_stops.
    DATA ls_fail  LIKE LINE OF failed-stop.
    DATA ls_msg   LIKE LINE OF reported-stop.
    DATA ls_key   LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_read.
      ls_read-%tky = ls_key-%tky.
      APPEND ls_read TO lt_read.
    ENDLOOP.
    READ ENTITIES OF zi_rap_tour IN LOCAL MODE
      ENTITY stop
        FIELDS ( nights ) WITH lt_read
      RESULT lt_stops.
    LOOP AT lt_stops INTO ls_stop WHERE nights <= 0.
      CLEAR: ls_fail, ls_msg.
      ls_fail-%tky = ls_stop-%tky.
      APPEND ls_fail TO failed-stop.
      ls_msg-%tky = ls_stop-%tky.
      ls_msg-%msg = new_message_with_text( severity = if_abap_behv_message=>severity-error
                                           text     = |Stop { ls_stop-stop_no }: at least one night| ).
      APPEND ls_msg TO reported-stop.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
