CLASS zcl_rap_note_eml DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The note demo driven with EML (docs/rap-eml.md): the statements as they
* are written on a system, lowered by the transpiler onto KERNEL_RAP_EML
* and run by the managed runtime. A transpiler without the EML lowering
* cannot build it, so abap_transpile.json excludes it until the pin moves.
  PUBLIC SECTION.
    TYPES tt_create TYPE TABLE FOR CREATE zi_rap_note.
    TYPES tt_update TYPE TABLE FOR UPDATE zi_rap_note.
    TYPES tt_key TYPE TABLE FOR READ IMPORT zi_rap_note.
    TYPES tt_note TYPE TABLE FOR READ RESULT zi_rap_note.
    TYPES ty_note TYPE STRUCTURE FOR READ RESULT zi_rap_note.
    TYPES tt_approve TYPE TABLE FOR ACTION IMPORT zi_rap_note\Note~Approve.
    TYPES tt_approved TYPE TABLE FOR ACTION RESULT zi_rap_note\Note~Approve.
    TYPES ty_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note.
    TYPES ty_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_note.

* MODIFY ... CREATE AUTO FILL CID FIELDS ( notetext ) WITH: the new key
    METHODS create_note
      IMPORTING
        iv_text      TYPE csequence
      RETURNING
        VALUE(rv_id) TYPE zrap_note-note_id.

* MODIFY ... UPDATE FIELDS ( notetext ) WITH: false when FAILED
    METHODS change_text
      IMPORTING
        iv_id         TYPE zrap_note-note_id
        iv_text       TYPE csequence
      RETURNING
        VALUE(rv_ok)  TYPE abap_bool.

* READ ... ALL FIELDS WITH ... RESULT
    METHODS read_note
      IMPORTING
        iv_id          TYPE zrap_note-note_id
      RETURNING
        VALUE(rs_note) TYPE ty_note.

* MODIFY ... EXECUTE approve FROM ... RESULT: the status the action set
    METHODS approve
      IMPORTING
        iv_id            TYPE zrap_note-note_id
      RETURNING
        VALUE(rv_status) TYPE zrap_note-status.

* COMMIT ENTITIES RESPONSE OF zi_rap_note: true when saved
    METHODS save
      EXPORTING
        es_failed       TYPE ty_failed
        es_reported     TYPE ty_reported
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.

* ROLLBACK ENTITIES
    METHODS discard.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.



CLASS zcl_rap_note_eml IMPLEMENTATION.

  METHOD create_note.
    DATA lt_create   TYPE tt_create.
    DATA ls_create   LIKE LINE OF lt_create.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.
    DATA ls_key      LIKE LINE OF ls_mapped-note.

    ls_create-notetext = iv_text.
    APPEND ls_create TO lt_create.
    MODIFY ENTITIES OF zi_rap_note ENTITY note
      CREATE AUTO FILL CID FIELDS ( notetext ) WITH lt_create
      MAPPED ls_mapped FAILED ls_failed REPORTED ls_reported.
    READ TABLE ls_mapped-note INDEX 1 INTO ls_key.
    IF sy-subrc = 0.
      rv_id = ls_key-noteid.
    ENDIF.
  ENDMETHOD.

  METHOD change_text.
    DATA lt_update   TYPE tt_update.
    DATA ls_update   LIKE LINE OF lt_update.
    DATA ls_mapped   TYPE ty_mapped.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.

    ls_update-noteid = iv_id.
    ls_update-notetext = iv_text.
    APPEND ls_update TO lt_update.
    MODIFY ENTITIES OF zi_rap_note ENTITY note
      UPDATE FIELDS ( notetext ) WITH lt_update
      MAPPED ls_mapped FAILED ls_failed REPORTED ls_reported.
* FAILED says whether it worked; SY-SUBRC after MODIFY is an OSG convention
    IF ls_failed-note IS INITIAL.
      rv_ok = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD read_note.
    DATA lt_key    TYPE tt_key.
    DATA ls_key    LIKE LINE OF lt_key.
    DATA lt_note   TYPE tt_note.
    DATA ls_failed TYPE ty_failed.

    ls_key-noteid = iv_id.
    APPEND ls_key TO lt_key.
    READ ENTITIES OF zi_rap_note ENTITY note
      ALL FIELDS WITH lt_key
      RESULT lt_note
      FAILED ls_failed.
    READ TABLE lt_note INDEX 1 INTO rs_note.
  ENDMETHOD.

  METHOD approve.
    DATA lt_approve  TYPE tt_approve.
    DATA ls_approve  LIKE LINE OF lt_approve.
    DATA lt_result   TYPE tt_approved.
    DATA ls_result   LIKE LINE OF lt_result.
    DATA ls_failed   TYPE ty_failed.
    DATA ls_reported TYPE ty_reported.

    ls_approve-noteid = iv_id.
    APPEND ls_approve TO lt_approve.
    MODIFY ENTITIES OF zi_rap_note ENTITY note
      EXECUTE approve FROM lt_approve
      RESULT lt_result
      FAILED ls_failed REPORTED ls_reported.
    READ TABLE lt_result INDEX 1 INTO ls_result.
    IF sy-subrc = 0.
      rv_status = ls_result-%param-status.
    ENDIF.
  ENDMETHOD.

  METHOD save.
    CLEAR: es_failed, es_reported.
    COMMIT ENTITIES RESPONSE OF zi_rap_note FAILED es_failed REPORTED es_reported.
    IF sy-subrc = 0.
      rv_saved = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD discard.
    ROLLBACK ENTITIES.
  ENDMETHOD.

ENDCLASS.
