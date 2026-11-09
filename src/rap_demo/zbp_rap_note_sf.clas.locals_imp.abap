* The note demo's handler with the method declarations written as on a
* system: no parameter types, the BDEF's derived types and the implicit
* FAILED / REPORTED / MAPPED come from the declaration's FOR clause
* (tools/rap/lower-derived.mjs, R3), and each method is bound to its
* determination, validation or action by that clause, not by its name.
*
* The bodies read and change the instances the way a system's handler
* does, through the transactional buffer, not through a table handed in.
* Each call below is the EML statement in the comment above it, made
* through ZCL_OSD_RAP_EML: the pinned transpiler does not lower EML yet
* (docs/rap-eml.md). Inside a handler that reaches the calling transaction
* and acts as IN LOCAL MODE.
CLASS lhc_note DEFINITION INHERITING FROM cl_abap_behavior_handler FINAL.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE 'ZI_RAP_NOTE_SF'.

    METHODS default_status FOR DETERMINE ON MODIFY
      IMPORTING keys FOR note~setstatus.
    METHODS tidy_text FOR DETERMINE ON SAVE
      IMPORTING keys FOR note~normalize.
    METHODS text_length FOR VALIDATE ON SAVE
      IMPORTING keys FOR note~checktext.
    METHODS approve_note FOR MODIFY
      IMPORTING keys FOR ACTION note~approve RESULT result.
ENDCLASS.

CLASS lhc_note IMPLEMENTATION.

  METHOD default_status.
* a new note starts as N (new)
    DATA lt_notes  TYPE TABLE FOR READ RESULT zi_rap_note_sf.
    DATA ls_note   LIKE LINE OF lt_notes.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_note_sf.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note_sf.
    DATA ls_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note_sf.

* READ ENTITIES OF zi_rap_note_sf IN LOCAL MODE ENTITY Note
*   FIELDS ( Status ) WITH CORRESPONDING #( keys ) RESULT lt_notes.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = keys iv_fields = 'STATUS'
                           CHANGING ct_result = lt_notes cs_failed = ls_failed ).
    LOOP AT lt_notes INTO ls_note WHERE status IS INITIAL.
      CLEAR ls_update.
      ls_update-%tky = ls_note-%tky.
      ls_update-status = 'N'.
      APPEND ls_update TO lt_update.
    ENDLOOP.
    IF lt_update IS INITIAL.
      RETURN.
    ENDIF.
* MODIFY ENTITIES OF zi_rap_note_sf IN LOCAL MODE ENTITY Note
*   UPDATE FIELDS ( Status ) WITH lt_update REPORTED reported.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'STATUS'
                             CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = reported ).
  ENDMETHOD.

  METHOD tidy_text.
* the text is saved without leading, trailing or doubled blanks
    DATA lt_notes  TYPE TABLE FOR READ RESULT zi_rap_note_sf.
    DATA ls_note   LIKE LINE OF lt_notes.
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_note_sf.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lv_text   TYPE string.
    DATA ls_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note_sf.
    DATA ls_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note_sf.

* READ ENTITIES ... FIELDS ( NoteText ) WITH CORRESPONDING #( keys ) RESULT lt_notes.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = keys iv_fields = 'NOTETEXT'
                           CHANGING ct_result = lt_notes cs_failed = ls_failed ).
    LOOP AT lt_notes INTO ls_note.
      lv_text = ls_note-notetext.
      CONDENSE lv_text.
      IF lv_text <> ls_note-notetext.
        CLEAR ls_update.
        ls_update-%tky = ls_note-%tky.
        ls_update-notetext = lv_text.
        APPEND ls_update TO lt_update.
      ENDIF.
    ENDLOOP.
    IF lt_update IS INITIAL.
      RETURN.
    ENDIF.
* MODIFY ENTITIES ... UPDATE FIELDS ( NoteText ) WITH lt_update REPORTED reported.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'NOTETEXT'
                             CHANGING cs_mapped = ls_mapped cs_failed = ls_failed cs_reported = reported ).
  ENDMETHOD.

  METHOD text_length.
* a note text has at least three characters
    DATA lt_notes    TYPE TABLE FOR READ RESULT zi_rap_note_sf.
    DATA ls_note     LIKE LINE OF lt_notes.
    DATA ls_failed   LIKE LINE OF failed-note.
    DATA ls_reported LIKE LINE OF reported-note.

* READ ENTITIES ... FIELDS ( NoteText ) WITH CORRESPONDING #( keys ) RESULT lt_notes.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = keys iv_fields = 'NOTETEXT'
                           CHANGING ct_result = lt_notes cs_failed = failed ).
    LOOP AT lt_notes INTO ls_note.
      IF strlen( ls_note-notetext ) < 3.
        CLEAR: ls_failed, ls_reported.
        ls_failed-%tky = ls_note-%tky.
        APPEND ls_failed TO failed-note.
        ls_reported-%tky = ls_note-%tky.
        ls_reported-%msg = new_message_with_text(
          severity = if_abap_behv_message=>severity-error
          text     = 'A note text needs at least three characters' ).
        ls_reported-%element-notetext = if_abap_behv=>mk-on.
        APPEND ls_reported TO reported-note.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD approve_note.
* approving sets the status to A and answers the note itself
    DATA lt_update TYPE TABLE FOR UPDATE zi_rap_note_sf.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lt_notes  TYPE TABLE FOR READ RESULT zi_rap_note_sf.
    DATA ls_note   LIKE LINE OF lt_notes.
    DATA ls_result LIKE LINE OF result.
    DATA ls_key    LIKE LINE OF keys.

    LOOP AT keys INTO ls_key.
      CLEAR ls_update.
      ls_update-%tky = ls_key-%tky.
      ls_update-status = 'A'.
      APPEND ls_update TO lt_update.
    ENDLOOP.
* MODIFY ENTITIES ... UPDATE FIELDS ( Status ) WITH lt_update
*   MAPPED mapped FAILED failed REPORTED reported.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'STATUS'
                             CHANGING cs_mapped = mapped cs_failed = failed cs_reported = reported ).
* READ ENTITIES ... ALL FIELDS WITH CORRESPONDING #( keys ) RESULT lt_notes.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = keys
                                     iv_fields = zcl_osd_rap_eml=>co_all_fields
                           CHANGING ct_result = lt_notes cs_failed = failed ).
    LOOP AT lt_notes INTO ls_note.
      CLEAR ls_result.
      ls_result-%tky = ls_note-%tky.
      MOVE-CORRESPONDING ls_note TO ls_result-%param.
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
    APPEND 'FINALIZE' TO zbp_rap_note_sf=>phases.
  ENDMETHOD.

  METHOD check_before_save.
    APPEND 'CHECK_BEFORE_SAVE' TO zbp_rap_note_sf=>phases.
  ENDMETHOD.

  METHOD cleanup.
    APPEND 'CLEANUP' TO zbp_rap_note_sf=>phases.
  ENDMETHOD.

  METHOD cleanup_finalize.
    APPEND 'CLEANUP_FINALIZE' TO zbp_rap_note_sf=>phases.
  ENDMETHOD.

ENDCLASS.
