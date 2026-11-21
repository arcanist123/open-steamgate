CLASS lcl_narrow DEFINITION FINAL.
* The note BO with an entity that does not expose STATUS: the generated
* adapter, its model narrowed. The table still has the column.
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
    METHODS constructor IMPORTING iv_bdef TYPE csequence RAISING cx_static_check.
  PRIVATE SECTION.
    DATA mi_bo TYPE REF TO zif_osd_rap_bo.
ENDCLASS.

CLASS lcl_narrow IMPLEMENTATION.

  METHOD constructor.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    CREATE OBJECT li_registry TYPE ('ZCL_OSD_RAP_REGISTRY').
    mi_bo = li_registry->get( iv_bdef ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~model.
    FIELD-SYMBOLS <ls_entity> LIKE LINE OF rs_model-entities.
    rs_model = mi_bo->model( ).
    LOOP AT rs_model-entities ASSIGNING <ls_entity>.
      DELETE <ls_entity>-fields WHERE name = 'STATUS'.
    ENDLOOP.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_rows.
    rr_rows = mi_bo->new_rows( iv_entity ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_table.
    rr_table = mi_bo->new_table( iv_entity = iv_entity iv_kind = iv_kind iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_response.
    rr_response = mi_bo->new_response( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_result.
    rr_result = mi_bo->new_result( iv_entity = iv_entity iv_action = iv_action ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~new_request.
    rr_request = mi_bo->new_request( iv_kind ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~save_modified.
    mi_bo->save_modified( io_saver = io_saver ir_create = ir_create ir_update = ir_update
                          ir_delete = ir_delete ir_reported = ir_reported ).
  ENDMETHOD.

  METHOD zif_osd_rap_bo~adjust_numbers.
    RETURN.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~call.
    mi_bo->call( io_handler = io_handler iv_entity = iv_entity iv_name = iv_name
                 ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                 ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_scenario DEFINITION FOR TESTING FINAL.
* The note demo (src/rap_demo/) through the managed runtime: the buffer,
* field control, numbering, determinations on modify and on save, the
* validation, the action and the order of the save sequence. The same
* scenario runs over two behavior definitions of the same table: ZI_RAP_NOTE,
* whose handler takes explicit signatures and the instances as a table, and
* ZI_RAP_NOTE_SF, whose handler is declared in the system's form and works
* through the buffer (R3). The tables below are typed by the first; the
* runtime addresses rows by component name, and the two are alike.
  PUBLIC SECTION.
    TYPES tt_create TYPE TABLE FOR CREATE zi_rap_note.
    TYPES tt_update TYPE TABLE FOR UPDATE zi_rap_note.
    TYPES tt_delete TYPE TABLE FOR DELETE zi_rap_note.
    TYPES tt_read TYPE TABLE FOR READ RESULT zi_rap_note.
    TYPES tt_key TYPE TABLE FOR READ IMPORT zi_rap_note.
    TYPES tt_approve TYPE TABLE FOR ACTION IMPORT zi_rap_note\Note~Approve.
    TYPES tt_approved TYPE TABLE FOR ACTION RESULT zi_rap_note\Note~Approve.
    TYPES ty_mapped TYPE RESPONSE FOR MAPPED EARLY zi_rap_note.
    TYPES ty_failed TYPE RESPONSE FOR FAILED EARLY zi_rap_note.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_note.

    DATA mv_bdef TYPE string.
    DATA mo_rap TYPE REF TO zcl_osd_rap_runtime.
    DATA ms_mapped TYPE ty_mapped.
    DATA ms_failed TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.

    METHODS constructor IMPORTING iv_bdef TYPE csequence.
    METHODS prepare RAISING cx_static_check.
    METHODS finish.
    METHODS create_update_delete RAISING cx_static_check.
    METHODS determination_on_modify RAISING cx_static_check.
    METHODS determination_on_save RAISING cx_static_check.
    METHODS validation_writes_nothing RAISING cx_static_check.
    METHODS action_result RAISING cx_static_check.
    METHODS save_order RAISING cx_static_check.
    METHODS field_control RAISING cx_static_check.
    METHODS cid_ref_in_one_transaction RAISING cx_static_check.
    METHODS save_resets_the_buffer RAISING cx_static_check.
    METHODS duplicate_cid RAISING cx_static_check.
    METHODS unexposed_column_kept RAISING cx_static_check.
    METHODS update_text
      IMPORTING io_rap  TYPE REF TO zcl_osd_rap_runtime
                iv_id   TYPE zrap_note-note_id
                iv_text TYPE csequence
      RAISING   cx_static_check.

    METHODS create
      IMPORTING iv_cid       TYPE csequence
                iv_text      TYPE csequence
      RETURNING VALUE(rv_id) TYPE zrap_note-note_id
      RAISING   cx_static_check.
    METHODS commit
      RETURNING VALUE(rv_saved) TYPE abap_bool
      RAISING   cx_static_check.
    METHODS db_count
      RETURNING VALUE(rv_count) TYPE i.
* the pool's saver phases (each pool keeps its own)
    METHODS phases
      RETURNING VALUE(rt_phases) TYPE string_table.
    METHODS clear_phases.
ENDCLASS.

CLASS ltcl_scenario IMPLEMENTATION.

  METHOD constructor.
    mv_bdef = iv_bdef.
  ENDMETHOD.

  METHOD phases.
    IF mv_bdef = 'ZI_RAP_NOTE'.
      rt_phases = zbp_rap_note=>phases.
    ELSE.
      rt_phases = zbp_rap_note_sf=>phases.
    ENDIF.
  ENDMETHOD.

  METHOD clear_phases.
    CLEAR: zbp_rap_note=>phases, zbp_rap_note_sf=>phases.
  ENDMETHOD.

  METHOD prepare.
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
    clear_phases( ).
    CLEAR: ms_mapped, ms_failed, ms_reported.
    mo_rap = zcl_osd_rap_runtime=>for_bdef( mv_bdef ).
  ENDMETHOD.

  METHOD finish.
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD create.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped LIKE LINE OF ms_mapped-note.

    ls_create-%cid = iv_cid.
    ls_create-notetext = iv_text.
    ls_create-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'C' it_rows = lt_create
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE ms_mapped-note INTO ls_mapped WITH KEY %cid = iv_cid.
    IF sy-subrc = 0.
      rv_id = ls_mapped-noteid.
    ENDIF.
  ENDMETHOD.

  METHOD commit.
    mo_rap->commit( IMPORTING ev_saved = rv_saved
                    CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD db_count.
    SELECT COUNT(*) FROM zrap_note INTO rv_count.
  ENDMETHOD.

  METHOD create_update_delete.
    DATA lv_id     TYPE zrap_note-note_id.
    DATA ls_db     TYPE zrap_note.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.

    lv_id = create( iv_cid = 'C1' iv_text = 'First note' ).
    cl_abap_unit_assert=>assert_not_initial( act = lv_id msg = 'managed numbering maps the %cid to a UUID' ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 msg = 'nothing is written before the save' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'First note' ).

    ls_update-noteid = lv_id.
    ls_update-notetext = 'Changed note'.
    ls_update-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
* the entity by its CDS name, which is the root's and so the definition's
    mo_rap->modify( EXPORTING iv_entity = mv_bdef iv_operation = 'U' it_rows = lt_update
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( ms_failed-note ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Changed note' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'N' msg = 'an update leaves the status' ).

    ls_delete-noteid = lv_id.
    APPEND ls_delete TO lt_delete.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'D' it_rows = lt_delete
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 1 msg = 'the delete waits for the save' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).

* gone: a second delete fails with not found
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'D' it_rows = lt_delete
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
  ENDMETHOD.

  METHOD determination_on_modify.
    DATA lv_id     TYPE zrap_note-note_id.
    DATA lt_key    TYPE tt_key.
    DATA ls_key    LIKE LINE OF lt_key.
    DATA lt_result TYPE tt_read.
    DATA ls_result LIKE LINE OF lt_result.
    DATA lt_trace  TYPE string_table.

    lv_id = create( iv_cid = 'C1' iv_text = 'Defaulted' ).
    ls_key-noteid = lv_id.
    APPEND ls_key TO lt_key.
    mo_rap->read( EXPORTING iv_entity = 'Note' it_keys = lt_key
                  CHANGING ct_result = lt_result cs_failed = ms_failed ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-status exp = 'N' msg = 'SetStatus sets the default on create' ).
    lt_trace = mo_rap->trace( ).
    READ TABLE lt_trace TRANSPORTING NO FIELDS WITH KEY table_line = 'DETERMINATION SETSTATUS'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
  ENDMETHOD.

  METHOD determination_on_save.
    DATA lv_id TYPE zrap_note-note_id.
    DATA ls_db TYPE zrap_note.

    lv_id = create( iv_cid = 'C1' iv_text = '  Spaced    out  ' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Spaced out' msg = 'Normalize runs on save' ).
  ENDMETHOD.

  METHOD validation_writes_nothing.
    DATA lv_id       TYPE zrap_note-note_id.
    DATA ls_failed   LIKE LINE OF ms_failed-note.
    DATA ls_reported LIKE LINE OF ms_reported-note.
    DATA li_message  TYPE REF TO if_message.

    create( iv_cid = 'C1' iv_text = 'A valid note' ).
    lv_id = create( iv_cid = 'C2' iv_text = 'ab' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_false ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 msg = 'a failed validation writes no instance at all' ).
    READ TABLE ms_failed-note INTO ls_failed INDEX 1.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_failed-noteid exp = lv_id ).
    READ TABLE ms_reported-note INTO ls_reported INDEX 1.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    li_message ?= ls_reported-%msg.
    cl_abap_unit_assert=>assert_equals( act = li_message->get_text( ) exp = 'A note text needs at least three characters' ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 2 msg = 'the buffer is kept for a correction' ).

    mo_rap->rollback( ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).
  ENDMETHOD.

  METHOD action_result.
    DATA lv_id      TYPE zrap_note-note_id.
    DATA lt_approve TYPE tt_approve.
    DATA ls_approve LIKE LINE OF lt_approve.
    DATA lt_result  TYPE tt_approved.
    DATA ls_result  LIKE LINE OF lt_result.
    DATA ls_db      TYPE zrap_note.

    lv_id = create( iv_cid = 'C1' iv_text = 'To approve' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).

    ls_approve-noteid = lv_id.
    APPEND ls_approve TO lt_approve.
    mo_rap->execute( EXPORTING iv_entity = 'Note' iv_action = 'Approve' it_keys = lt_approve
                     CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-noteid exp = lv_id ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-%param-status exp = 'A' ).
    cl_abap_unit_assert=>assert_equals( act = ls_result-%param-notetext exp = 'To approve' ).

    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'N' msg = 'the action waits for the save' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'A' ).
  ENDMETHOD.

  METHOD save_order.
    DATA lt_exp TYPE string_table.

    create( iv_cid = 'C1' iv_text = 'Ordered' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    APPEND 'DETERMINATION SETSTATUS' TO lt_exp.
    APPEND 'FINALIZE' TO lt_exp.
    APPEND 'DETERMINATION NORMALIZE' TO lt_exp.
    APPEND 'CHECK_BEFORE_SAVE' TO lt_exp.
    APPEND 'VALIDATION CHECKTEXT' TO lt_exp.
    APPEND 'ADJUST_NUMBERS' TO lt_exp.
    APPEND 'SAVE' TO lt_exp.
    APPEND 'CLEANUP' TO lt_exp.
    cl_abap_unit_assert=>assert_equals( act = mo_rap->trace( ) exp = lt_exp ).

    CLEAR lt_exp.
    APPEND 'FINALIZE' TO lt_exp.
    APPEND 'CHECK_BEFORE_SAVE' TO lt_exp.
    APPEND 'CLEANUP' TO lt_exp.
    cl_abap_unit_assert=>assert_equals( act = phases( ) exp = lt_exp msg = 'the pool saver is called in order' ).

    clear_phases( ).
    create( iv_cid = 'C2' iv_text = 'no' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_false ).
    CLEAR lt_exp.
    APPEND 'FINALIZE' TO lt_exp.
    APPEND 'CHECK_BEFORE_SAVE' TO lt_exp.
    APPEND 'CLEANUP_FINALIZE' TO lt_exp.
    cl_abap_unit_assert=>assert_equals( act = phases( ) exp = lt_exp msg = 'a failed check ends in cleanup_finalize' ).
  ENDMETHOD.

  METHOD field_control.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_failed LIKE LINE OF ms_failed-note.

* Status is read-only
    ls_create-%cid = 'C1'.
    ls_create-notetext = 'Has a status'.
    ls_create-status = 'A'.
    ls_create-%control-notetext = if_abap_behv=>mk-on.
    ls_create-%control-status = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
* NoteText is mandatory
    CLEAR ls_create.
    ls_create-%cid = 'C2'.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'C' it_rows = lt_create
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( ms_mapped-note ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 2 ).
    READ TABLE ms_failed-note INTO ls_failed WITH KEY %cid = 'C1'.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-readonly ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_reported-note ) exp = 2 ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 ).
  ENDMETHOD.

  METHOD cid_ref_in_one_transaction.
    DATA lv_id     TYPE zrap_note-note_id.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_db     TYPE zrap_note.

    lv_id = create( iv_cid = 'C1' iv_text = 'Before' ).
    ls_update-%cid_ref = 'C1'.
    ls_update-notetext = 'After'.
    ls_update-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'U' it_rows = lt_update
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 1 msg = 'a create then an update is one create' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'After' ).
  ENDMETHOD.

  METHOD update_text.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    ls_update-noteid = iv_id.
    ls_update-notetext = iv_text.
    ls_update-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    io_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'U' it_rows = lt_update
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD save_resets_the_buffer.
* after a save the next transaction reads the database again, and the
* content IDs of the saved one are no references any more
    DATA lv_id     TYPE zrap_note-note_id.
    DATA ls_db     TYPE zrap_note.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.

    lv_id = create( iv_cid = 'C1' iv_text = 'Saved once' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    UPDATE zrap_note SET status = 'Z' WHERE note_id = lv_id.
    COMMIT WORK.

    update_text( io_rap = mo_rap iv_id = lv_id iv_text = 'Saved twice' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Saved twice' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'Z' msg = 'a change made between the transactions survives' ).

    ls_update-%cid_ref = 'C1'.
    ls_update-notetext = 'Stale reference'.
    ls_update-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_update TO lt_update.
    CLEAR ms_failed.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'U' it_rows = lt_update
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 msg = 'a %cid_ref of a saved transaction' ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 0 ).
  ENDMETHOD.

  METHOD duplicate_cid.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_failed LIKE LINE OF ms_failed-note.

    ls_create-%cid = 'DUP'.
    ls_create-notetext = 'First'.
    ls_create-%control-notetext = if_abap_behv=>mk-on.
    APPEND ls_create TO lt_create.
    ls_create-notetext = 'Second'.
    APPEND ls_create TO lt_create.
    mo_rap->modify( EXPORTING iv_entity = 'Note' iv_operation = 'C' it_rows = lt_create
                    CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_mapped-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = lines( ms_failed-note ) exp = 1 ).
    READ TABLE ms_failed-note INTO ls_failed INDEX 1.
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-conflict ).
    cl_abap_unit_assert=>assert_equals( act = mo_rap->pending( ) exp = 1 ).
  ENDMETHOD.

  METHOD unexposed_column_kept.
* an entity without STATUS updates the text and leaves the column alone
    DATA lv_id     TYPE zrap_note-note_id.
    DATA ls_db     TYPE zrap_note.
    DATA lo_narrow TYPE REF TO lcl_narrow.
    DATA lo_rap    TYPE REF TO zcl_osd_rap_runtime.
    DATA lv_saved  TYPE abap_bool.

    lv_id = create( iv_cid = 'C1' iv_text = 'Wide' ).
    cl_abap_unit_assert=>assert_equals( act = commit( ) exp = abap_true ).
    UPDATE zrap_note SET status = 'Z' WHERE note_id = lv_id.
    COMMIT WORK.

    CREATE OBJECT lo_narrow EXPORTING iv_bdef = mv_bdef.
    lo_rap = zcl_osd_rap_runtime=>for_bo( lo_narrow ).
    update_text( io_rap = lo_rap iv_id = lv_id iv_text = 'Narrow' ).
    cl_abap_unit_assert=>assert_initial( ms_failed-note ).
    lo_rap->commit( IMPORTING ev_saved = lv_saved
                    CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_saved exp = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Narrow' ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'Z' ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_explicit DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* ZBP_RAP_NOTE: explicit derived signatures, the instances as a table
  PRIVATE SECTION.
    DATA mo_scenario TYPE REF TO ltcl_scenario.
    METHODS setup RAISING cx_static_check.
    METHODS teardown.
    METHODS create_update_delete FOR TESTING RAISING cx_static_check.
    METHODS determination_on_modify FOR TESTING RAISING cx_static_check.
    METHODS determination_on_save FOR TESTING RAISING cx_static_check.
    METHODS validation_writes_nothing FOR TESTING RAISING cx_static_check.
    METHODS action_result FOR TESTING RAISING cx_static_check.
    METHODS save_order FOR TESTING RAISING cx_static_check.
    METHODS field_control FOR TESTING RAISING cx_static_check.
    METHODS cid_ref_in_one_transaction FOR TESTING RAISING cx_static_check.
    METHODS save_resets_the_buffer FOR TESTING RAISING cx_static_check.
    METHODS duplicate_cid FOR TESTING RAISING cx_static_check.
    METHODS unexposed_column_kept FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_explicit IMPLEMENTATION.

  METHOD setup.
    CREATE OBJECT mo_scenario EXPORTING iv_bdef = 'ZI_RAP_NOTE'.
    mo_scenario->prepare( ).
  ENDMETHOD.

  METHOD teardown.
    mo_scenario->finish( ).
  ENDMETHOD.

  METHOD create_update_delete.
    mo_scenario->create_update_delete( ).
  ENDMETHOD.

  METHOD determination_on_modify.
    mo_scenario->determination_on_modify( ).
  ENDMETHOD.

  METHOD determination_on_save.
    mo_scenario->determination_on_save( ).
  ENDMETHOD.

  METHOD validation_writes_nothing.
    mo_scenario->validation_writes_nothing( ).
  ENDMETHOD.

  METHOD action_result.
    mo_scenario->action_result( ).
  ENDMETHOD.

  METHOD save_order.
    mo_scenario->save_order( ).
  ENDMETHOD.

  METHOD field_control.
    mo_scenario->field_control( ).
  ENDMETHOD.

  METHOD cid_ref_in_one_transaction.
    mo_scenario->cid_ref_in_one_transaction( ).
  ENDMETHOD.

  METHOD save_resets_the_buffer.
    mo_scenario->save_resets_the_buffer( ).
  ENDMETHOD.

  METHOD duplicate_cid.
    mo_scenario->duplicate_cid( ).
  ENDMETHOD.

  METHOD unexposed_column_kept.
    mo_scenario->unexposed_column_kept( ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_system_form DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* ZBP_RAP_NOTE_SF: the handler declared as on a system (R3)
  PRIVATE SECTION.
    DATA mo_scenario TYPE REF TO ltcl_scenario.
    METHODS setup RAISING cx_static_check.
    METHODS teardown.
    METHODS create_update_delete FOR TESTING RAISING cx_static_check.
    METHODS determination_on_modify FOR TESTING RAISING cx_static_check.
    METHODS determination_on_save FOR TESTING RAISING cx_static_check.
    METHODS validation_writes_nothing FOR TESTING RAISING cx_static_check.
    METHODS action_result FOR TESTING RAISING cx_static_check.
    METHODS save_order FOR TESTING RAISING cx_static_check.
    METHODS field_control FOR TESTING RAISING cx_static_check.
    METHODS cid_ref_in_one_transaction FOR TESTING RAISING cx_static_check.
    METHODS save_resets_the_buffer FOR TESTING RAISING cx_static_check.
    METHODS duplicate_cid FOR TESTING RAISING cx_static_check.
    METHODS unexposed_column_kept FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_system_form IMPLEMENTATION.

  METHOD setup.
    CREATE OBJECT mo_scenario EXPORTING iv_bdef = 'ZI_RAP_NOTE_SF'.
    mo_scenario->prepare( ).
  ENDMETHOD.

  METHOD teardown.
    mo_scenario->finish( ).
  ENDMETHOD.

  METHOD create_update_delete.
    mo_scenario->create_update_delete( ).
  ENDMETHOD.

  METHOD determination_on_modify.
    mo_scenario->determination_on_modify( ).
  ENDMETHOD.

  METHOD determination_on_save.
    mo_scenario->determination_on_save( ).
  ENDMETHOD.

  METHOD validation_writes_nothing.
    mo_scenario->validation_writes_nothing( ).
  ENDMETHOD.

  METHOD action_result.
    mo_scenario->action_result( ).
  ENDMETHOD.

  METHOD save_order.
    mo_scenario->save_order( ).
  ENDMETHOD.

  METHOD field_control.
    mo_scenario->field_control( ).
  ENDMETHOD.

  METHOD cid_ref_in_one_transaction.
    mo_scenario->cid_ref_in_one_transaction( ).
  ENDMETHOD.

  METHOD save_resets_the_buffer.
    mo_scenario->save_resets_the_buffer( ).
  ENDMETHOD.

  METHOD duplicate_cid.
    mo_scenario->duplicate_cid( ).
  ENDMETHOD.

  METHOD unexposed_column_kept.
    mo_scenario->unexposed_column_kept( ).
  ENDMETHOD.

ENDCLASS.
