* The draft trip demo of R8 (docs/rap-runtime.md, "R8"). The handlers are
* written in the explicit form (the instances as ENTITIES): they run for
* draft and active instances alike, and the runtime decides which. A new
* trip is N; a description containing INVALID fails the validation, which
* runs when the draft is activated, and on Prepare.
CLASS lhc_trip DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    TYPES tt_trip TYPE TABLE FOR READ RESULT zi_rap_dtrip.

    METHODS set_status
      IMPORTING keys     TYPE TABLE FOR DETERMINATION zi_rap_dtrip
      CHANGING  entities TYPE tt_trip.
    METHODS check_description
      IMPORTING keys     TYPE TABLE FOR VALIDATION zi_rap_dtrip
                entities TYPE tt_trip
      CHANGING  failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_dtrip
                reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_dtrip.
ENDCLASS.

CLASS lhc_trip IMPLEMENTATION.

  METHOD set_status.
    FIELD-SYMBOLS <ls_trip> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_trip> WHERE status IS INITIAL.
      <ls_trip>-status = 'N'.
    ENDLOOP.
  ENDMETHOD.

  METHOD check_description.
    DATA ls_failed   LIKE LINE OF failed-trip.
    DATA ls_reported LIKE LINE OF reported-trip.
    FIELD-SYMBOLS <ls_trip> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_trip>.
      IF to_upper( <ls_trip>-description ) CS 'INVALID'.
        CLEAR: ls_failed, ls_reported.
        ls_failed-%tky = <ls_trip>-%tky.
        APPEND ls_failed TO failed-trip.
        ls_reported-%tky = <ls_trip>-%tky.
        ls_reported-%msg = new_message_with_text(
          severity = if_abap_behv_message=>severity-error
          text     = 'A trip description may not say INVALID' ).
        ls_reported-%element-description = if_abap_behv=>mk-on.
        APPEND ls_reported TO reported-trip.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
