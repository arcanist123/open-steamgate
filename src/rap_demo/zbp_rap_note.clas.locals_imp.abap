" Explicit derived signatures demonstrate the R1 compiler boundary.
" The R2 runtime will supply handler dispatch and transactional behavior.
CLASS lhc_note DEFINITION FINAL.
  PUBLIC SECTION.
    METHODS create IMPORTING entities TYPE TABLE FOR CREATE zi_rap_note.
    METHODS update IMPORTING entities TYPE TABLE FOR UPDATE zi_rap_note.
    METHODS delete IMPORTING keys TYPE TABLE FOR DELETE zi_rap_note.
    METHODS approve
      IMPORTING keys TYPE TABLE FOR ACTION IMPORT zi_rap_note\Note~Approve
      EXPORTING result TYPE TABLE FOR ACTION RESULT zi_rap_note\Note~Approve.
    METHODS set_status IMPORTING keys TYPE TABLE FOR DETERMINATION zi_rap_note.
    METHODS check_text IMPORTING keys TYPE TABLE FOR VALIDATION zi_rap_note.
    METHODS read_result IMPORTING entities TYPE TABLE FOR READ RESULT zi_rap_note.
    METHODS responses
      CHANGING failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note
               reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_note
               mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note.
ENDCLASS.

CLASS lhc_note IMPLEMENTATION.
  METHOD create.
  ENDMETHOD.
  METHOD update.
  ENDMETHOD.
  METHOD delete.
  ENDMETHOD.
  METHOD approve.
  ENDMETHOD.
  METHOD set_status.
  ENDMETHOD.
  METHOD check_text.
  ENDMETHOD.
  METHOD read_result.
  ENDMETHOD.
  METHOD responses.
  ENDMETHOD.
ENDCLASS.
