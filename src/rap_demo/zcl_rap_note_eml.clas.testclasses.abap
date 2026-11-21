CLASS ltcl_eml_statements DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* Real EML against the note demo. The class is excluded from the transpile
* in abap_transpile.json while the pinned transpiler lacks the EML lowering
* (docs/rap-eml.md): without it COMMIT ENTITIES stops the whole build.
  PRIVATE SECTION.
    DATA mo_notes TYPE REF TO zcl_rap_note_eml.

    METHODS setup.
    METHODS teardown.
    METHODS create_and_save FOR TESTING.
    METHODS approve_and_save FOR TESTING.
    METHODS invalid_text_is_not_saved FOR TESTING.
    METHODS db_count
      RETURNING VALUE(rv_count) TYPE i.
ENDCLASS.

CLASS ltcl_eml_statements IMPLEMENTATION.

  METHOD setup.
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
    zcl_osd_rap_eml=>reset( ).
    CREATE OBJECT mo_notes.
  ENDMETHOD.

  METHOD teardown.
    mo_notes->discard( ).
    zcl_osd_rap_eml=>reset( ).
    DELETE FROM zrap_note WHERE status <> '#'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD db_count.
    SELECT COUNT(*) FROM zrap_note INTO rv_count.
  ENDMETHOD.

  METHOD create_and_save.
    DATA lv_id   TYPE zrap_note-note_id.
    DATA ls_note TYPE zcl_rap_note_eml=>ty_note.
    DATA ls_db   TYPE zrap_note.

    lv_id = mo_notes->create_note( 'Written with EML' ).
    cl_abap_unit_assert=>assert_not_initial( act = lv_id msg = 'MODIFY ENTITIES CREATE maps a key' ).
    ls_note = mo_notes->read_note( lv_id ).
    cl_abap_unit_assert=>assert_equals( act = ls_note-notetext exp = 'Written with EML' ).
    cl_abap_unit_assert=>assert_equals( act = ls_note-status exp = 'N' msg = 'READ ENTITIES sees the buffer' ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).

    cl_abap_unit_assert=>assert_true( act = mo_notes->save( ) msg = 'COMMIT ENTITIES saves' ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc ).
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Written with EML' ).

    cl_abap_unit_assert=>assert_true( act = mo_notes->change_text( iv_id = lv_id iv_text = 'Changed with EML' ) ).
    cl_abap_unit_assert=>assert_true( act = mo_notes->save( ) ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-note_text exp = 'Changed with EML' ).
  ENDMETHOD.

  METHOD approve_and_save.
    DATA lv_id TYPE zrap_note-note_id.
    DATA ls_db TYPE zrap_note.

    lv_id = mo_notes->create_note( 'To approve' ).
    mo_notes->save( ).
    cl_abap_unit_assert=>assert_equals( act = mo_notes->approve( lv_id ) exp = 'A' msg = 'EXECUTE answers the RESULT' ).
    cl_abap_unit_assert=>assert_true( act = mo_notes->save( ) ).
    SELECT SINGLE * FROM zrap_note INTO ls_db WHERE note_id = lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_db-status exp = 'A' ).
  ENDMETHOD.

  METHOD invalid_text_is_not_saved.
    DATA ls_failed   TYPE zcl_rap_note_eml=>ty_failed.
    DATA ls_reported TYPE zcl_rap_note_eml=>ty_reported.

    mo_notes->create_note( 'ab' ).
    cl_abap_unit_assert=>assert_false( act = mo_notes->save( IMPORTING es_failed = ls_failed es_reported = ls_reported )
                                       msg = 'the validation on save fails the COMMIT ENTITIES' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_failed-note ) exp = 1 msg = 'RESPONSE OF carries the FAILED' ).
    cl_abap_unit_assert=>assert_equals( act = lines( ls_reported-note ) exp = 1 ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).
    mo_notes->discard( ).
    cl_abap_unit_assert=>assert_true( act = mo_notes->save( ) msg = 'after ROLLBACK ENTITIES there is nothing to fail' ).
    cl_abap_unit_assert=>assert_equals( act = db_count( ) exp = 0 ).
  ENDMETHOD.

ENDCLASS.
