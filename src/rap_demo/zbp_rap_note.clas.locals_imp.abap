* The handler and saver of the note demo, run by the managed runtime
* (src/rap/, docs/rap-runtime.md). The signatures are explicit derived types
* and the methods are bound by name to the BDEF's determinations,
* validation and action; without EML a handler gets the instances it works
* on as ENTITIES and changes them in place. The READ RESULT and ACTION
* RESULT forms are named with TYPES: abaplint reads a RESULT inside a METHODS
* statement as a RAP result parameter.
CLASS lhc_note DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    TYPES tt_note TYPE TABLE FOR READ RESULT zi_rap_note.
    TYPES tt_approved TYPE TABLE FOR ACTION RESULT zi_rap_note\Note~Approve.

    METHODS set_status
      IMPORTING keys     TYPE TABLE FOR DETERMINATION zi_rap_note
      CHANGING  entities TYPE tt_note.
    METHODS normalize
      IMPORTING keys     TYPE TABLE FOR DETERMINATION zi_rap_note
      CHANGING  entities TYPE tt_note.
    METHODS check_text
      IMPORTING keys     TYPE TABLE FOR VALIDATION zi_rap_note
                entities TYPE tt_note
      CHANGING  failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_note
                reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_note.
    METHODS approve
      IMPORTING keys     TYPE TABLE FOR ACTION IMPORT zi_rap_note\Note~Approve
      CHANGING  entities TYPE tt_note
                result   TYPE tt_approved.
ENDCLASS.

CLASS lhc_note IMPLEMENTATION.

  METHOD set_status.
* a new note starts as N (new)
    FIELD-SYMBOLS <ls_note> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_note> WHERE status IS INITIAL.
      <ls_note>-status = 'N'.
    ENDLOOP.
  ENDMETHOD.

  METHOD normalize.
* the text is saved without leading, trailing or doubled blanks
    FIELD-SYMBOLS <ls_note> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_note>.
      CONDENSE <ls_note>-notetext.
    ENDLOOP.
  ENDMETHOD.

  METHOD check_text.
* a note text has at least three characters
    DATA ls_failed   LIKE LINE OF failed-note.
    DATA ls_reported LIKE LINE OF reported-note.
    FIELD-SYMBOLS <ls_note> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_note>.
      IF strlen( <ls_note>-notetext ) < 3.
        CLEAR: ls_failed, ls_reported.
        ls_failed-noteid = <ls_note>-noteid.
        APPEND ls_failed TO failed-note.
        ls_reported-noteid = <ls_note>-noteid.
        ls_reported-%msg = new_message_with_text(
          severity = if_abap_behv_message=>severity-error
          text     = 'A note text needs at least three characters' ).
        ls_reported-%element-notetext = if_abap_behv=>mk-on.
        APPEND ls_reported TO reported-note.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD approve.
* approving sets the status to A and answers the note itself
    DATA ls_result LIKE LINE OF result.
    FIELD-SYMBOLS <ls_note> LIKE LINE OF entities.
    LOOP AT entities ASSIGNING <ls_note>.
      <ls_note>-status = 'A'.
      CLEAR ls_result.
      ls_result-noteid = <ls_note>-noteid.
      MOVE-CORRESPONDING <ls_note> TO ls_result-%param.
      APPEND ls_result TO result.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.

CLASS lsc_note DEFINITION INHERITING FROM cl_abap_behavior_saver FINAL.
  PROTECTED SECTION.
    METHODS finalize REDEFINITION.
    METHODS check_before_save REDEFINITION.
    METHODS cleanup REDEFINITION.
    METHODS cleanup_finalize REDEFINITION.
ENDCLASS.

CLASS lsc_note IMPLEMENTATION.

  METHOD finalize.
    APPEND 'FINALIZE' TO zbp_rap_note=>phases.
  ENDMETHOD.

  METHOD check_before_save.
    APPEND 'CHECK_BEFORE_SAVE' TO zbp_rap_note=>phases.
  ENDMETHOD.

  METHOD cleanup.
    APPEND 'CLEANUP' TO zbp_rap_note=>phases.
  ENDMETHOD.

  METHOD cleanup_finalize.
    APPEND 'CLEANUP_FINALIZE' TO zbp_rap_note=>phases.
  ENDMETHOD.

ENDCLASS.
