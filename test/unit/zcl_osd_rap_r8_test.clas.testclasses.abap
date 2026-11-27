* The EML statements are written as the ZCL_OSD_RAP_EML calls they lower
* to, each with its statement in a comment above it (as in
* ZCL_OSD_RAP_EML_TEST); %is_draft is a component of the rows like a key.
CLASS ltcl_draft DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE 'ZI_RAP_DTRIP'.
    TYPES tt_create   TYPE TABLE FOR CREATE zi_rap_dtrip.
    TYPES tt_cba      TYPE TABLE FOR CREATE zi_rap_dtrip\_legs.
    TYPES tt_update   TYPE TABLE FOR UPDATE zi_rap_dtrip.
    TYPES tt_leg_del  TYPE TABLE FOR DELETE zi_rap_dleg.
    TYPES tt_read     TYPE TABLE FOR READ IMPORT zi_rap_dtrip.
    TYPES tt_trips    TYPE TABLE FOR READ RESULT zi_rap_dtrip.
    TYPES tt_edit     TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~edit.
    TYPES tt_edited   TYPE TABLE FOR ACTION RESULT zi_rap_dtrip~edit.
    TYPES tt_activate TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~activate.
    TYPES tt_active   TYPE TABLE FOR ACTION RESULT zi_rap_dtrip~activate.
    TYPES tt_discard  TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~discard.
    TYPES tt_resume   TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~resume.
    TYPES tt_resumed  TYPE TABLE FOR ACTION RESULT zi_rap_dtrip~resume.
    TYPES tt_prepare  TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~prepare.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY zi_rap_dtrip.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY zi_rap_dtrip.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY zi_rap_dtrip.
    TYPES ty_uuid     TYPE x LENGTH 16.
    DATA ms_mapped   TYPE ty_mapped.
    DATA ms_failed   TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.
    METHODS setup.
    METHODS teardown.
    METHODS clear_tables.
* a new draft trip with one leg per destination, saved (COMMIT ENTITIES)
    METHODS new_draft
      IMPORTING
        iv_description TYPE csequence
        it_legs        TYPE string_table
      RETURNING
        VALUE(rv_trip) TYPE ty_uuid.
    METHODS commit
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.
    METHODS run
      IMPORTING
        iv_action      TYPE csequence
        iv_trip        TYPE ty_uuid
        iv_draft       TYPE abap_bool
      RETURNING
        VALUE(rv_rows) TYPE i.
    METHODS read_trip
      IMPORTING
        iv_trip       TYPE ty_uuid
        iv_draft      TYPE abap_bool
      RETURNING
        VALUE(rs_row) TYPE zi_rap_dtrip.
* an active trip with two legs, made through a draft and Activate
    METHODS active_trip
      RETURNING
        VALUE(rv_trip) TYPE ty_uuid.
    METHODS creates_a_draft FOR TESTING RAISING cx_static_check.
    METHODS draft_skips_validation FOR TESTING RAISING cx_static_check.
    METHODS activates FOR TESTING RAISING cx_static_check.
    METHODS activation_validates FOR TESTING RAISING cx_static_check.
    METHODS activation_needs_mandatory FOR TESTING RAISING cx_static_check.
    METHODS edits_and_activates FOR TESTING RAISING cx_static_check.
    METHODS draft_holds_the_active FOR TESTING RAISING cx_static_check.
    METHODS discards FOR TESTING RAISING cx_static_check.
    METHODS activation_deletes_a_leg FOR TESTING RAISING cx_static_check.
    METHODS total_etag_conflict FOR TESTING RAISING cx_static_check.
    METHODS resumes_and_prepares FOR TESTING RAISING cx_static_check.
    METHODS failed_activation_keeps_draft FOR TESTING RAISING cx_static_check.
    METHODS draft_blocks_active_delete FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_draft IMPLEMENTATION.

  METHOD setup.
    clear_tables( ).
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    clear_tables( ).
  ENDMETHOD.

  METHOD clear_tables.
    DELETE FROM zrap_dtrip.
    DELETE FROM zrap_dtrip_d.
    DELETE FROM zrap_dleg.
    DELETE FROM zrap_dleg_d.
    DELETE FROM zosd_draft_adm.
    COMMIT WORK.
  ENDMETHOD.

  METHOD commit.
* COMMIT ENTITIES
    zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                             IMPORTING ev_saved = rv_saved
                             CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD new_draft.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA lt_cba    TYPE tt_cba.
    DATA ls_cba    LIKE LINE OF lt_cba.
    DATA ls_target LIKE LINE OF ls_cba-%target.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-trip.
    DATA lv_dest   TYPE string.

* MODIFY ENTITIES OF zi_rap_dtrip ENTITY trip
*   CREATE FIELDS ( description ) WITH VALUE #( ( %cid = 'T1'
*     %is_draft = if_abap_behv=>mk-on description = iv_description ) )
*   CREATE BY \_Legs FIELDS ( destination ) WITH ...
    ls_create-%cid = 'T1'.
    ls_create-%is_draft = if_abap_behv=>mk-on.
    ls_create-description = iv_description.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'description'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    IF it_legs IS NOT INITIAL.
      ls_cba-%cid_ref = 'T1'.
      ls_cba-%is_draft = if_abap_behv=>mk-on.
      LOOP AT it_legs INTO lv_dest.
        CLEAR ls_target.
        ls_target-%cid = |L{ sy-tabix }|.
        ls_target-%is_draft = if_abap_behv=>mk-on.
        ls_target-destination = lv_dest.
        APPEND ls_target TO ls_cba-%target.
      ENDLOOP.
      APPEND ls_cba TO lt_cba.
      zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_assoc = '_legs'
                                            it_rows = lt_cba iv_fields = 'destination'
                                  CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    ENDIF.
    READ TABLE ls_mapped-trip INDEX 1 INTO ls_line.
    rv_trip = ls_line-trip_uuid.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%is_draft exp = if_abap_behv=>mk-on msg = 'MAPPED names the draft' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'the draft is saved' ).
  ENDMETHOD.

  METHOD run.
* MODIFY ENTITIES OF zi_rap_dtrip ENTITY trip EXECUTE <action>
*   FROM VALUE #( ( %tky-trip_uuid = iv_trip %tky-%is_draft = ... ) ) RESULT ...
    DATA lt_import TYPE tt_activate.
    DATA ls_import LIKE LINE OF lt_import.
    DATA lt_result TYPE tt_active.

    ls_import-trip_uuid = iv_trip.
    IF iv_draft = abap_true.
      ls_import-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    APPEND ls_import TO lt_import.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_action = iv_action it_rows = lt_import
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    rv_rows = lines( lt_result ).
  ENDMETHOD.

  METHOD read_trip.
* READ ENTITIES OF zi_rap_dtrip ENTITY trip ALL FIELDS
*   WITH VALUE #( ( trip_uuid = iv_trip %is_draft = ... ) ) RESULT ...
    DATA lt_key    TYPE tt_read.
    DATA ls_key    LIKE LINE OF lt_key.
    DATA lt_result TYPE tt_trips.
    DATA ls_result LIKE LINE OF lt_result.

    ls_key-trip_uuid = iv_trip.
    IF iv_draft = abap_true.
      ls_key-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    APPEND ls_key TO lt_key.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' it_keys = lt_key
                           CHANGING ct_result = lt_result cs_failed = ms_failed ).
    READ TABLE lt_result INDEX 1 INTO ls_result.
    IF sy-subrc = 0.
      MOVE-CORRESPONDING ls_result TO rs_row.
    ENDIF.
  ENDMETHOD.

  METHOD active_trip.
    DATA lt_legs TYPE string_table.
    APPEND `Oslo` TO lt_legs.
    APPEND `Bergen` TO lt_legs.
    rv_trip = new_draft( iv_description = 'Fjords' it_legs = lt_legs ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_trip = rv_trip iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'the activation is saved' ).
  ENDMETHOD.

  METHOD creates_a_draft.
    DATA lt_legs  TYPE string_table.
    DATA lv_trip  TYPE ty_uuid.
    DATA ls_draft TYPE zrap_dtrip_d.
    DATA ls_adm   TYPE zosd_draft_adm.
    DATA ls_row   TYPE zi_rap_dtrip.
    DATA lv_count TYPE i.

    APPEND `Rome` TO lt_legs.
    lv_trip = new_draft( iv_description = 'Italy' it_legs = lt_legs ).
* saved into the draft tables only
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'no active instance' ).
    SELECT SINGLE * FROM zrap_dtrip_d INTO ls_draft WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the draft row' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-description exp = 'Italy' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-status exp = 'N' msg = 'determination on modify ran on the draft' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-hasactiveentity exp = '' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-draftentityoperationcode exp = 'C' ).
    cl_abap_unit_assert=>assert_not_initial( ls_draft-draftentitycreationdatetime ).
    cl_abap_unit_assert=>assert_initial( act = ls_draft-last_changed_at msg = 'the total ETag moves with the active instance only' ).
    SELECT COUNT(*) FROM zrap_dleg_d INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft leg' ).
* the admin data, one row per draft of a root
    SELECT SINGLE * FROM zosd_draft_adm INTO ls_adm WHERE draftuuid = ls_draft-draftadministrativedatauuid.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the admin row' ).
    cl_abap_unit_assert=>assert_equals( act = ls_adm-draftentitytype exp = 'ZI_RAP_DTRIP' ).
    cl_abap_unit_assert=>assert_equals( act = ls_adm-inprocessbyuser exp = sy-uname ).
* READ with %is_draft reads the draft, without it there is no instance
    zcl_osd_rap_eml=>reset( ).
    ls_row = read_trip( iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-description exp = 'Italy' ).
    ls_row = read_trip( iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_initial( act = ls_row msg = 'no active instance to read' ).
  ENDMETHOD.

  METHOD draft_skips_validation.
    DATA lt_legs  TYPE string_table.
    DATA lv_count TYPE i.
    new_draft( iv_description = 'INVALID trip' it_legs = lt_legs ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'a draft is saved unvalidated' ).
  ENDMETHOD.

  METHOD activates.
    DATA lv_trip   TYPE ty_uuid.
    DATA ls_trip   TYPE zrap_dtrip.
    DATA lv_count  TYPE i.
    lv_trip = active_trip( ).
    SELECT SINGLE * FROM zrap_dtrip INTO ls_trip WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the active instance, same key' ).
    cl_abap_unit_assert=>assert_equals( act = ls_trip-description exp = 'Fjords' ).
    cl_abap_unit_assert=>assert_equals( act = ls_trip-status exp = 'N' ).
    cl_abap_unit_assert=>assert_not_initial( act = ls_trip-last_changed_at msg = 'the total ETag is stamped' ).
    SELECT COUNT(*) FROM zrap_dleg INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 msg = 'the legs went with it' ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the draft is gone' ).
    SELECT COUNT(*) FROM zrap_dleg_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zosd_draft_adm INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'and its admin row' ).
  ENDMETHOD.

  METHOD activation_validates.
    DATA lt_legs  TYPE string_table.
    DATA lv_trip  TYPE ty_uuid.
    DATA lv_count TYPE i.
    lv_trip = new_draft( iv_description = 'INVALID trip' it_legs = lt_legs ).
    run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_false( act = commit( ) msg = 'the validation stops the activation' ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_reported-trip msg = 'with its message' ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft stays' ).
  ENDMETHOD.

  METHOD activation_needs_mandatory.
    DATA lt_legs  TYPE string_table.
    DATA lv_trip  TYPE ty_uuid.
    lv_trip = new_draft( iv_description = '' it_legs = lt_legs ).
    run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-trip msg = 'description is mandatory on the active instance' ).
  ENDMETHOD.

  METHOD edits_and_activates.
    DATA lv_trip   TYPE ty_uuid.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_draft  TYPE zrap_dtrip_d.
    DATA ls_trip   TYPE zrap_dtrip.
    DATA lv_before TYPE zrap_dtrip-last_changed_at.
    DATA lv_count  TYPE i.

    lv_trip = active_trip( ).
    SELECT SINGLE last_changed_at FROM zrap_dtrip INTO lv_before WHERE trip_uuid = lv_trip.
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ) exp = 1
                                        msg = 'Edit answers the draft' ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE * FROM zrap_dtrip_d INTO ls_draft WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'Edit copied the instance' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-hasactiveentity exp = 'X' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-draftentityoperationcode exp = 'U' ).
    cl_abap_unit_assert=>assert_equals( act = ls_draft-last_changed_at exp = lv_before msg = 'with the total ETag it started from' ).
    SELECT COUNT(*) FROM zrap_dleg_d INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 msg = 'and its composition tree' ).
* MODIFY ENTITIES ... UPDATE FIELDS ( description ) WITH VALUE #( ( %is_draft = mk-on ... ) )
    zcl_osd_rap_eml=>reset( ).
    ls_update-trip_uuid = lv_trip.
    ls_update-%is_draft = if_abap_behv=>mk-on.
    ls_update-description = 'Fjords and glaciers'.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'description'
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the draft takes the change' ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE description FROM zrap_dtrip INTO ls_trip-description WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = ls_trip-description exp = 'Fjords' msg = 'the active instance is unchanged' ).
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE * FROM zrap_dtrip INTO ls_trip WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = ls_trip-description exp = 'Fjords and glaciers' ).
    cl_abap_unit_assert=>assert_true( act = boolc( ls_trip-last_changed_at > lv_before ) msg = 'the total ETag moved' ).
    SELECT COUNT(*) FROM zrap_dleg INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD draft_holds_the_active.
    DATA lv_trip   TYPE ty_uuid.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_failed LIKE LINE OF ms_failed-trip.

    lv_trip = active_trip( ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
* a second Edit is a conflict
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ) exp = 0 ).
    READ TABLE ms_failed-trip INDEX 1 INTO ls_failed.
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-conflict ).
* a change of the active instance is refused while the draft holds it
    CLEAR: ms_failed, ms_reported.
    zcl_osd_rap_eml=>reset( ).
    ls_update-trip_uuid = lv_trip.
    ls_update-description = 'behind the draft'.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'description'
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE ms_failed-trip INDEX 1 INTO ls_failed.
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-locked ).
  ENDMETHOD.

  METHOD discards.
    DATA lv_trip  TYPE ty_uuid.
    DATA lv_count TYPE i.
    DATA ls_trip  TYPE zrap_dtrip.
    lv_trip = active_trip( ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Discard' iv_trip = lv_trip iv_draft = abap_true ) exp = 0 ).
    cl_abap_unit_assert=>assert_initial( ms_failed ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the draft is gone' ).
    SELECT COUNT(*) FROM zrap_dleg_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT COUNT(*) FROM zosd_draft_adm INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
    SELECT SINGLE * FROM zrap_dtrip INTO ls_trip WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = ls_trip-description exp = 'Fjords' msg = 'the active instance stays' ).
* and an Edit may start again
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ) exp = 1 ).
  ENDMETHOD.

  METHOD activation_deletes_a_leg.
    DATA lv_trip   TYPE ty_uuid.
    DATA lt_delete TYPE tt_leg_del.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA ls_leg    TYPE zrap_dleg_d.
    DATA lv_count  TYPE i.
    lv_trip = active_trip( ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE * FROM zrap_dleg_d INTO ls_leg WHERE trip_uuid = lv_trip AND destination = 'Oslo'.
* MODIFY ENTITIES ... ENTITY leg DELETE FROM VALUE #( ( leg_uuid = ... %is_draft = mk-on ) )
    zcl_osd_rap_eml=>reset( ).
    ls_delete-leg_uuid = ls_leg-leg_uuid.
    ls_delete-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'leg' iv_operation = 'DELETE' it_rows = lt_delete
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT COUNT(*) FROM zrap_dleg INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 2 msg = 'the active legs are untouched until Activate' ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT COUNT(*) FROM zrap_dleg INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'Activate deleted the leg the draft no longer has' ).
  ENDMETHOD.

  METHOD total_etag_conflict.
    DATA lv_trip  TYPE ty_uuid.
    DATA ls_failed LIKE LINE OF ms_failed-trip.
    lv_trip = active_trip( ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
* the active instance changes behind the draft (another way in than the BO)
    UPDATE zrap_dtrip SET last_changed_at = '20300101000000.0000000' WHERE trip_uuid = lv_trip.
    COMMIT WORK.
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ) exp = 0 ).
    READ TABLE ms_failed-trip INDEX 1 INTO ls_failed.
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-conflict ).
  ENDMETHOD.

  METHOD resumes_and_prepares.
    DATA lt_legs TYPE string_table.
    DATA lv_trip TYPE ty_uuid.
    lv_trip = new_draft( iv_description = 'INVALID again' it_legs = lt_legs ).
    zcl_osd_rap_eml=>reset( ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Resume' iv_trip = lv_trip iv_draft = abap_true ) exp = 1
                                        msg = 'Resume answers the draft' ).
    cl_abap_unit_assert=>assert_initial( ms_failed ).
* Prepare runs the validation it lists on the draft, and changes nothing
    run( iv_action = 'Prepare' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-trip msg = 'Prepare reports the invalid description' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_rap_eml=>runtime( co_bdef )->pending( ) exp = 0 ).
* Resume of an active instance is refused
    CLEAR ms_failed.
    run( iv_action = 'Resume' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_not_initial( ms_failed-trip ).
  ENDMETHOD.

  METHOD failed_activation_keeps_draft.
* the critic's P1 on #913: an Activate refused by a mandatory field changes
* nothing in the buffer, so the COMMIT ENTITIES after it saves nothing --
* the draft and its leg stay, and no partial active root is written
    DATA lt_legs  TYPE string_table.
    DATA lv_trip  TYPE ty_uuid.
    DATA lv_count TYPE i.
    APPEND `Rome` TO lt_legs.
    lv_trip = new_draft( iv_description = '' it_legs = lt_legs ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-trip msg = 'Activate is refused' ).
    commit( ).
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft root stays after a refused Activate and COMMIT' ).
    SELECT COUNT(*) FROM zrap_dleg_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft leg stays' ).
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'no active root is written' ).
    SELECT COUNT(*) FROM zosd_draft_adm INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the admin row stays' ).
  ENDMETHOD.

  METHOD draft_blocks_active_delete.
* the critic's P3 on #913: the draft holds the active instance against a delete too
    DATA lv_trip   TYPE ty_uuid.
    DATA lt_delete TYPE TABLE FOR DELETE zi_rap_dtrip.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA ls_failed LIKE LINE OF ms_failed-trip.
    DATA lv_count  TYPE i.
    lv_trip = active_trip( ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    zcl_osd_rap_eml=>reset( ).
    ls_delete-trip_uuid = lv_trip.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'DELETE' it_rows = lt_delete
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE ms_failed-trip INDEX 1 INTO ls_failed.
    cl_abap_unit_assert=>assert_equals( act = ls_failed-%fail-cause exp = if_abap_behv=>cause-locked ).
    commit( ).
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the active trip stays' ).
  ENDMETHOD.

ENDCLASS.
