CLASS ltcl_eml DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* The EML statements' semantics over the note demo (src/rap_demo/), called
* on the facade directly: what the transpiler's lowering will call once the
* statements are transpiled (docs/rap-eml.md). ZCL_OSD_RAP_TEST covers the
* runtime underneath; this covers what the statements add: the session's
* runtime per behavior definition, FIELDS / SET FIELDS / AUTO FILL CID,
* the projection of READ, COMMIT and ROLLBACK over the session, SY-SUBRC,
* and the kernel entry binding the targets a statement does not name.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE 'ZI_RAP_NOTE'.

    TYPES tt_create TYPE TABLE FOR CREATE zi_rap_note.
    TYPES tt_update TYPE TABLE FOR UPDATE zi_rap_note.
    TYPES tt_delete TYPE TABLE FOR DELETE zi_rap_note.
    TYPES tt_read TYPE TABLE FOR READ RESULT zi_rap_note.
    TYPES ty_row TYPE STRUCTURE FOR READ RESULT zi_rap_note.
    TYPES tt_key TYPE TABLE FOR READ IMPORT zi_rap_note.
    TYPES tt_approve TYPE TABLE FOR ACTION IMPORT zi_rap_note\Note~Approve.
    TYPES tt_approved TYPE TABLE FOR ACTION RESULT zi_rap_note\Note~Approve.
    TYPES ty_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note.
    TYPES ty_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_note.

    DATA ms_mapped TYPE ty_mapped.
    DATA ms_failed TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.

    METHODS setup.
    METHODS teardown.
    METHODS create_read_commit FOR TESTING RAISING cx_static_check.
    METHODS fields_projection FOR TESTING RAISING cx_static_check.
    METHODS set_fields_with FOR TESTING RAISING cx_static_check.
    METHODS execute_action FOR TESTING RAISING cx_static_check.
    METHODS failed_save_and_rollback FOR TESTING RAISING cx_static_check.
    METHODS delete_missing_sets_subrc FOR TESTING RAISING cx_static_check.
    METHODS unknown_field_raises FOR TESTING RAISING cx_static_check.
    METHODS unknown_bdef_raises FOR TESTING RAISING cx_static_check.
    METHODS one_runtime_per_session FOR TESTING RAISING cx_static_check.
    METHODS kernel_binds_missing_targets FOR TESTING RAISING cx_static_check.
    METHODS statement_boundary FOR TESTING RAISING cx_static_check.
    METHODS result_is_the_operations FOR TESTING RAISING cx_static_check.
    METHODS rollback_takes_the_luw FOR TESTING RAISING cx_static_check.
    METHODS auto_cid_beside_explicit FOR TESTING RAISING cx_static_check.
    METHODS unknown_read_field_raises FOR TESTING RAISING cx_static_check.

    METHODS create
      IMPORTING iv_text      TYPE csequence
      RETURNING VALUE(rv_id) TYPE zrap_note-note_id
      RAISING   cx_static_check.
    METHODS read_one
      IMPORTING iv_id         TYPE zrap_note-note_id
                iv_fields     TYPE csequence
      RETURNING VALUE(rs_row) TYPE ty_row
      RAISING   cx_static_check.
    METHODS commit
      RETURNING VALUE(rv_saved) TYPE abap_bool
      RAISING   cx_static_check.
    METHODS db_count
      RETURNING VALUE(rv_count) TYPE i.
ENDCLASS.

CLASS ltcl_eml IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_mapped, ms_failed, ms_reported.
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD create.
* MODIFY ENTITIES OF zi_rap_note ENTITY Note CREATE AUTO FILL CID
*   FIELDS ( NoteText ) WITH lt_create MAPPED ... FAILED ... REPORTED ...
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped LIKE LINE OF ms_mapped-note.

    ls_create-notetext = iv_text.
    APPEND ls_create TO lt_create.
    CLEAR ms_mapped.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'NoteText' iv_auto_fill_cid = abap_true
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE ms_mapped-note INDEX 1 INTO ls_mapped.
    IF sy-subrc = 0.
      rv_id = ls_mapped-noteid.
    ENDIF.
  ENDMETHOD.

  METHOD read_one.
    DATA lt_key    TYPE tt_key.
    DATA ls_key    LIKE LINE OF lt_key.
    DATA lt_result TYPE tt_read.

    ls_key-noteid = iv_id.
    APPEND ls_key TO lt_key.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = lt_key iv_fields = iv_fields
                           CHANGING ct_result = lt_result cs_failed = ms_failed ).
    READ TABLE lt_result INDEX 1 INTO rs_row.
  ENDMETHOD.

  METHOD commit.
    zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                             IMPORTING ev_saved = rv_saved
                             CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD db_count.
    SELECT COUNT(*) FROM zrap_note INTO rv_count.
  ENDMETHOD.

  METHOD create_read_commit.
    DATA lv_id     TYPE zrap_note-note_id.
    DATA lv_subrc  TYPE sy-subrc.
    DATA ls_mapped LIKE LINE OF ms_mapped-note.
    DATA ls_row    TYPE ty_row.
    DATA ls_db     TYPE zrap_note.

    lv_id = create( 'First note' ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 msg = 'MODIFY without a failure sets sy-subrc 0' ).
    cl_abap_unit_assert=>assert_not_initial( act = lv_id ).
    READ TABLE ms_mapped-note INDEX 1 INTO ls_mapped.
    cl_abap_unit_assert=>assert_equals( act = ls_mapped-%cid(5) exp = '%AUTO' msg = 'AUTO FILL CID gives the row a %cid' ).

    ls_row = read_one( iv_id = lv_id iv_fields = zcl_osd_rap_eml=>co_all_fields ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-notetext exp = 'First note' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-status exp = 'N' msg = 'READ sees the determination on modify' ).

    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 msg = 'nothing is written before COMMIT ENTITIES' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 msg = 'COMMIT ENTITIES saved: sy-subrc 0' ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'First note' ).
  ENDMETHOD.

  METHOD fields_projection.
    DATA lv_id  TYPE zrap_note-note_id.
    DATA ls_row TYPE ty_row.

    lv_id = create( 'Projected' ).
    commit( ).
    ls_row = read_one( iv_id = lv_id iv_fields = 'NoteText' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-noteid exp = lv_id msg = 'the key is always read' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-notetext exp = 'Projected' ).
    cl_abap_unit_assert=>assert_initial( act = ls_row-status msg = 'a field not in FIELDS ( ) is initial' ).

    ls_row = read_one( iv_id = lv_id iv_fields = '' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-status exp = 'N' msg = 'FROM reads every field' ).
  ENDMETHOD.

  METHOD set_fields_with.
* MODIFY ... UPDATE SET FIELDS WITH lt_update: %control from the values
    DATA lv_id     TYPE zrap_note-note_id.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_db     TYPE zrap_note.

    lv_id = create( 'Before' ).
    commit( ).
    ls_update-noteid = lv_id.
    ls_update-notetext = 'After'.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_set_fields = abap_true
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed-note msg = 'an initial read-only Status is not flagged' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'After' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'N' ).
  ENDMETHOD.

  METHOD execute_action.
    DATA lv_id      TYPE zrap_note-note_id.
    DATA lt_approve TYPE tt_approve.
    DATA ls_approve LIKE LINE OF lt_approve.
    DATA lt_result  TYPE tt_approved.
    DATA ls_result  LIKE LINE OF lt_result.
    DATA ls_db      TYPE zrap_note.

    lv_id = create( 'To approve' ).
    commit( ).
    ls_approve-noteid = lv_id.
    APPEND ls_approve TO lt_approve.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_action = 'Approve' it_rows = lt_approve
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-%param-status exp = 'A' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'A' ).
  ENDMETHOD.

  METHOD failed_save_and_rollback.
    DATA lv_subrc TYPE sy-subrc.

    create( 'A valid note' ).
    create( 'ab' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_false ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 4 msg = 'a failed COMMIT ENTITIES sets sy-subrc 4' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>runtime( co_bdef )->pending( ) exp = 2
                                        msg = 'the buffer is kept after a failed save' ).

    zcl_osd_rap_eml=>rollback( ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>runtime( co_bdef )->pending( ) exp = 0
                                        msg = 'ROLLBACK ENTITIES forgets the buffer' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).
  ENDMETHOD.

  METHOD delete_missing_sets_subrc.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA lv_subrc  TYPE sy-subrc.

    ls_delete-noteid = '00000000000000000000000000000001'.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'DELETE' it_rows = lt_delete
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 4 ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>count_rows( ms_failed ) exp = 1 ).
  ENDMETHOD.

  METHOD unknown_field_raises.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA lx_error  TYPE REF TO zcx_osd_rap.

    ls_create-%cid = 'C1'.
    APPEND ls_create TO lt_create.
    TRY.
        zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'CREATE'
                                           it_rows = lt_create iv_fields = 'NoSuchField'
                                 CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
        cl_abap_unit_assert=>fail( 'FIELDS ( ) with an unknown field is refused' ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>assert_char_cp( act = lx_error->get_text( ) exp = '*NOSUCHFIELD*' ).
    ENDTRY.
  ENDMETHOD.

  METHOD unknown_bdef_raises.
    TRY.
        zcl_osd_rap_eml=>runtime( 'ZI_NO_SUCH_BDEF' ).
        cl_abap_unit_assert=>fail( 'an unknown behavior definition is refused' ).
      CATCH zcx_osd_rap.
    ENDTRY.
    cl_abap_unit_assert=>assert_initial( act = zcl_osd_rap_eml=>sessions( ) msg = 'and leaves no session' ).
  ENDMETHOD.

  METHOD one_runtime_per_session.
    DATA lo_first  TYPE REF TO zcl_osd_rap_runtime.
    DATA lo_second TYPE REF TO zcl_osd_rap_runtime.
    DATA lt_exp    TYPE string_table.

    lo_first = zcl_osd_rap_eml=>runtime( 'zi_rap_note' ).
    lo_second = zcl_osd_rap_eml=>runtime( 'ZI_RAP_NOTE' ).
    cl_abap_unit_assert=>assert_true( act = boolc( lo_first = lo_second ) msg = 'one runtime per definition, whatever the case' ).
    APPEND co_bdef TO lt_exp.
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>sessions( ) exp = lt_exp ).
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_initial( act = zcl_osd_rap_eml=>sessions( ) ).
  ENDMETHOD.

  METHOD kernel_binds_missing_targets.
* the statements without MAPPED, FAILED, REPORTED or RESULT, as the
* transpiler emits them: KERNEL_RAP_EML binds scratch responses
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA lt_key    TYPE tt_key.
    DATA ls_key    LIKE LINE OF lt_key.
    DATA lt_result TYPE tt_read.
    DATA ls_result LIKE LINE OF lt_result.
    DATA lt_approve TYPE tt_approve.
    DATA ls_approve LIKE LINE OF lt_approve.
    DATA lv_subrc  TYPE sy-subrc.

    ls_create-%cid = 'K1'.
    ls_create-notetext = 'Kernel bound'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).

    kernel_rap_eml=>commit( ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 1 ).

    SELECT SINGLE note_id FROM zrap_note INTO ls_key-noteid.
    APPEND ls_key TO lt_key.
    kernel_rap_eml=>read( EXPORTING bdef = co_bdef entity = 'Note' keys = lt_key fields = zcl_osd_rap_eml=>co_all_fields
                          CHANGING result = lt_result ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-notetext exp = 'Kernel bound' ).

    ls_approve-noteid = ls_key-noteid.
    APPEND ls_approve TO lt_approve.
    kernel_rap_eml=>execute( bdef = co_bdef entity = 'Note' action = 'Approve' rows = lt_approve ).
    kernel_rap_eml=>commit( bdef = co_bdef ).
    kernel_rap_eml=>read( EXPORTING bdef = co_bdef entity = 'Note' keys = lt_key
                          CHANGING result = lt_result ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    cl_abap_unit_assert=>assert_equals( act = ls_result-status exp = 'A' msg = 'the action ran without a RESULT target' ).

    kernel_rap_eml=>rollback( ).
  ENDMETHOD.

  METHOD statement_boundary.
* BEGIN starts a statement: the targets it names hold that statement's
* responses and nothing of an earlier one; SY-SUBRC is the statement's
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA ls_mapped LIKE LINE OF ms_mapped-note.
    DATA lv_subrc  TYPE sy-subrc.

    ls_create-%cid = 'C1'.
    ls_create-notetext = 'First statement'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>begin( EXPORTING bdef = co_bdef CHANGING mapped = ms_mapped failed = ms_failed reported = ms_reported ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 1 ).

    CLEAR lt_create.
    ls_create-%cid = 'C2'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>begin( EXPORTING bdef = co_bdef CHANGING mapped = ms_mapped failed = ms_failed reported = ms_reported ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 1 msg = 'a second statement starts from an empty MAPPED' ).
    READ TABLE ms_mapped-note INDEX 1 INTO ls_mapped.
    cl_abap_unit_assert=>assert_equals( act = ls_mapped-%cid exp = 'C2' ).

* a failing operation followed by a good one in one statement: both seen
    ls_delete-noteid = '00000000000000000000000000000001'.
    APPEND ls_delete TO lt_delete.
    CLEAR lt_create.
    ls_create-%cid = 'C3'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>begin( EXPORTING bdef = co_bdef CHANGING mapped = ms_mapped failed = ms_failed reported = ms_reported ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'DELETE' rows = lt_delete ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 4 msg = 'SY-SUBRC is the statement''s, not the last operation''s' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_reported-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 1 ).

* the next statement does not carry the failure
    CLEAR lt_create.
    ls_create-%cid = 'C4'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>begin( EXPORTING bdef = co_bdef CHANGING mapped = ms_mapped failed = ms_failed reported = ms_reported ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed-note ).
    cl_abap_unit_assert=>assert_initial( act = ms_reported-note ).

* a failed save, a rollback, a good save: the COMMIT's responses are its own
    CLEAR lt_create.
    ls_create-%cid = 'C5'.
    ls_create-notetext = 'ab'.
    APPEND ls_create TO lt_create.
    kernel_rap_eml=>begin( EXPORTING bdef = co_bdef CHANGING mapped = ms_mapped failed = ms_failed reported = ms_reported ).
    kernel_rap_eml=>modify( bdef = co_bdef entity = 'Note' operation = 'CREATE' rows = lt_create fields = 'NOTETEXT' ).
    kernel_rap_eml=>commit( EXPORTING bdef = co_bdef CHANGING failed = ms_failed reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
    kernel_rap_eml=>rollback( ).
    kernel_rap_eml=>commit( EXPORTING bdef = co_bdef CHANGING failed = ms_failed reported = ms_reported ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed-note msg = 'COMMIT ENTITIES fills FAILED from empty' ).
    cl_abap_unit_assert=>assert_initial( act = ms_reported-note ).
  ENDMETHOD.

  METHOD result_is_the_operations.
* two EXECUTEs into one RESULT: the second holds its own rows only
    DATA lv_id      TYPE zrap_note-note_id.
    DATA lt_approve TYPE tt_approve.
    DATA ls_approve LIKE LINE OF lt_approve.
    DATA lt_result  TYPE tt_approved.

    lv_id = create( 'Twice' ).
    commit( ).
    ls_approve-noteid = lv_id.
    APPEND ls_approve TO lt_approve.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_action = 'Approve' it_rows = lt_approve
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_action = 'Approve' it_rows = lt_approve
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_result ) exp = 1 ).
  ENDMETHOD.

  METHOD rollback_takes_the_luw.
* a RAP change pending and a row written with SQL beside it: ROLLBACK
* ENTITIES rolls the LUW back, so the SQL row goes too
    DATA ls_db TYPE zrap_note.

    create( 'Pending' ).
    ls_db-note_id = '000000000000000000000000000000AA'.
    ls_db-note_text = 'Written with SQL'.
    ls_db-status = 'N'.
    INSERT zrap_note FROM ls_db.
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 1 ).
    zcl_osd_rap_eml=>rollback( ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 msg = 'ROLLBACK ENTITIES is a ROLLBACK WORK too' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>runtime( co_bdef )->pending( ) exp = 0 ).
  ENDMETHOD.

  METHOD auto_cid_beside_explicit.
* a caller's %cid and an automatic one in one request, either order; a
* caller's %cid in the automatic namespace is refused
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped LIKE LINE OF ms_mapped-note.
    DATA lv_subrc  TYPE sy-subrc.
    DATA lx_error  TYPE REF TO zcx_osd_rap.

    ls_create-notetext = 'Mixed'.
    ls_create-%cid = 'C1'.
    APPEND ls_create TO lt_create.
    CLEAR ls_create-%cid.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'NoteText' iv_auto_fill_cid = abap_true
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 2 ).
    READ TABLE ms_mapped-note INDEX 2 INTO ls_mapped.
    cl_abap_unit_assert=>assert_equals( act = ls_mapped-%cid(6) exp = zcl_osd_rap_eml=>co_auto_cid ).

    CLEAR: lt_create, ms_mapped.
    CLEAR ls_create-%cid.
    APPEND ls_create TO lt_create.
    ls_create-%cid = 'C2'.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'NoteText' iv_auto_fill_cid = abap_true
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    lv_subrc = sy-subrc.
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 msg = 'the other order too' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 2 ).

    CLEAR lt_create.
    ls_create-%cid = '%AUTO-1'.
    APPEND ls_create TO lt_create.
    TRY.
        zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' iv_operation = 'CREATE'
                                           it_rows = lt_create iv_fields = 'NoteText'
                                 CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
        cl_abap_unit_assert=>fail( 'a %cid in the automatic namespace is refused' ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>assert_char_cp( act = lx_error->get_text( ) exp = '*%AUTO-*' ).
    ENDTRY.
  ENDMETHOD.

  METHOD unknown_read_field_raises.
    DATA lt_key TYPE tt_key.
    DATA ls_key LIKE LINE OF lt_key.
    DATA lt_result TYPE tt_read.
    DATA lx_error  TYPE REF TO zcx_osd_rap.

    ls_key-noteid = '000000000000000000000000000000AB'.
    APPEND ls_key TO lt_key.
    TRY.
        zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Note' it_keys = lt_key iv_fields = 'NoSuchField'
                               CHANGING ct_result = lt_result cs_failed = ms_failed ).
        cl_abap_unit_assert=>fail( 'READ FIELDS ( ) with an unknown field is refused, even with no row to read' ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>assert_char_cp( act = lx_error->get_text( ) exp = '*NOSUCHFIELD*' ).
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
