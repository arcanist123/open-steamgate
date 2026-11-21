* The EML statements are written as the ZCL_OSD_RAP_EML calls they lower
* to, each with its statement in a comment above it (as in
* ZCL_OSD_RAP_R8_TEST). The user is switched with ZCL_OSD_LOGON=>SET, what
* an HTTP request's credential does (src/logon).
CLASS ltcl_owner DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE 'ZI_RAP_DTRIP'.
    TYPES tt_create   TYPE TABLE FOR CREATE zi_rap_dtrip.
    TYPES tt_update   TYPE TABLE FOR UPDATE zi_rap_dtrip.
    TYPES tt_activate TYPE TABLE FOR ACTION IMPORT zi_rap_dtrip~activate.
    TYPES tt_active   TYPE TABLE FOR ACTION RESULT zi_rap_dtrip~activate.
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
    METHODS as_user IMPORTING iv_user TYPE csequence.
    METHODS new_draft
      IMPORTING
        iv_description TYPE csequence
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
    METHODS update_draft
      IMPORTING
        iv_trip        TYPE ty_uuid
        iv_description TYPE csequence.
    METHODS cause
      RETURNING
        VALUE(rv_cause) TYPE if_abap_behv=>t_fail_cause.
    METHODS names_the_owner FOR TESTING RAISING cx_static_check.
    METHODS foreign_change_refused FOR TESTING RAISING cx_static_check.
    METHODS foreign_actions_refused FOR TESTING RAISING cx_static_check.
    METHODS owner_resumes FOR TESTING RAISING cx_static_check.
    METHODS foreign_edit_locked FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_owner IMPLEMENTATION.

  METHOD setup.
    clear_tables( ).
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
    as_user( 'ALICE' ).
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    clear_tables( ).
    zcl_osd_logon=>set( '' ).
  ENDMETHOD.

  METHOD clear_tables.
    DELETE FROM zrap_dtrip.
    DELETE FROM zrap_dtrip_d.
    DELETE FROM zrap_dleg.
    DELETE FROM zrap_dleg_d.
    DELETE FROM zosd_draft_adm.
    COMMIT WORK.
  ENDMETHOD.

  METHOD as_user.
* a request of another user: a new transaction, as the user
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
    zcl_osd_logon=>set( iv_user ).
  ENDMETHOD.

  METHOD commit.
* COMMIT ENTITIES
    zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                             IMPORTING ev_saved = rv_saved
                             CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD new_draft.
* MODIFY ENTITIES OF zi_rap_dtrip ENTITY trip CREATE FIELDS ( description )
*   WITH VALUE #( ( %cid = 'T1' %is_draft = if_abap_behv=>mk-on description = ... ) )
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-trip.
    ls_create-%cid = 'T1'.
    ls_create-%is_draft = if_abap_behv=>mk-on.
    ls_create-description = iv_description.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'description'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    READ TABLE ls_mapped-trip INDEX 1 INTO ls_line.
    rv_trip = ls_line-trip_uuid.
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'the draft is saved' ).
  ENDMETHOD.

  METHOD run.
* MODIFY ENTITIES OF zi_rap_dtrip ENTITY trip EXECUTE <action> FROM ...
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

  METHOD update_draft.
* MODIFY ENTITIES ... UPDATE FIELDS ( description ) WITH VALUE #( ( %is_draft = mk-on ... ) )
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    ls_update-trip_uuid = iv_trip.
    ls_update-%is_draft = if_abap_behv=>mk-on.
    ls_update-description = iv_description.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'trip' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'description'
                             CHANGING cs_mapped = ms_mapped cs_failed = ms_failed cs_reported = ms_reported ).
  ENDMETHOD.

  METHOD cause.
    DATA ls_failed LIKE LINE OF ms_failed-trip.
    READ TABLE ms_failed-trip INDEX 1 INTO ls_failed.
    rv_cause = ls_failed-%fail-cause.
  ENDMETHOD.

  METHOD names_the_owner.
    DATA lv_trip TYPE ty_uuid.
    DATA ls_adm  TYPE zosd_draft_adm.
    DATA ls_d    TYPE zrap_dtrip_d.
    lv_trip = new_draft( 'Alice plans' ).
    SELECT SINGLE * FROM zrap_dtrip_d INTO ls_d WHERE trip_uuid = lv_trip.
    SELECT SINGLE * FROM zosd_draft_adm INTO ls_adm WHERE draftuuid = ls_d-draftadministrativedatauuid.
    cl_abap_unit_assert=>assert_equals( act = ls_adm-createdbyuser exp = 'ALICE' ).
    cl_abap_unit_assert=>assert_equals( act = ls_adm-inprocessbyuser exp = 'ALICE' ).
    cl_abap_unit_assert=>assert_equals( act = ls_adm-lastchangedbyuser exp = 'ALICE' ).
  ENDMETHOD.

  METHOD foreign_change_refused.
    DATA lv_trip TYPE ty_uuid.
    DATA ls_d    TYPE zrap_dtrip_d.
    lv_trip = new_draft( 'Alice plans' ).
    as_user( 'BOB' ).
    update_draft( iv_trip = lv_trip iv_description = 'Bob was here' ).
    cl_abap_unit_assert=>assert_equals( act = cause( ) exp = if_abap_behv=>cause-locked msg = 'another user may not change it' ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_reported-trip msg = 'and is told whose it is' ).
    commit( ).
    SELECT SINGLE * FROM zrap_dtrip_d INTO ls_d WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = ls_d-description exp = 'Alice plans' ).
* the owner goes on
    as_user( 'ALICE' ).
    update_draft( iv_trip = lv_trip iv_description = 'Alice plans more' ).
    cl_abap_unit_assert=>assert_initial( ms_failed ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT SINGLE * FROM zrap_dtrip_d INTO ls_d WHERE trip_uuid = lv_trip.
    cl_abap_unit_assert=>assert_equals( act = ls_d-description exp = 'Alice plans more' ).
  ENDMETHOD.

  METHOD foreign_actions_refused.
    DATA lv_trip   TYPE ty_uuid.
    DATA lv_count  TYPE i.
    DATA lt_action TYPE string_table.
    DATA lv_action TYPE string.
    lv_trip = new_draft( 'Alice plans' ).
    APPEND `Activate` TO lt_action.
    APPEND `Discard` TO lt_action.
    APPEND `Resume` TO lt_action.
    APPEND `Prepare` TO lt_action.
    LOOP AT lt_action INTO lv_action.
      as_user( 'BOB' ).
      run( iv_action = lv_action iv_trip = lv_trip iv_draft = abap_true ).
      cl_abap_unit_assert=>assert_equals( act = cause( ) exp = if_abap_behv=>cause-locked msg = lv_action ).
      commit( ).
    ENDLOOP.
    SELECT COUNT(*) FROM zrap_dtrip_d INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft is still there' ).
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'and not activated' ).
  ENDMETHOD.

  METHOD owner_resumes.
    DATA lv_trip  TYPE ty_uuid.
    DATA lv_count TYPE i.
    lv_trip = new_draft( 'Alice plans' ).
    as_user( 'ALICE' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Resume' iv_trip = lv_trip iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_initial( ms_failed ).
    as_user( 'ALICE' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    SELECT COUNT(*) FROM zrap_dtrip INTO lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
  ENDMETHOD.

  METHOD foreign_edit_locked.
    DATA lv_trip TYPE ty_uuid.
    lv_trip = new_draft( 'Alice plans' ).
    as_user( 'ALICE' ).
    run( iv_action = 'Activate' iv_trip = lv_trip iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
    as_user( 'ALICE' ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( commit( ) ).
* another user: the instance is locked by the draft's owner
    as_user( 'BOB' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ) exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = cause( ) exp = if_abap_behv=>cause-locked ).
* the owner: one draft per instance, a conflict as in R8
    as_user( 'ALICE' ).
    run( iv_action = 'Edit' iv_trip = lv_trip iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_equals( act = cause( ) exp = if_abap_behv=>cause-conflict ).
  ENDMETHOD.

ENDCLASS.

* src/logon: ENTER takes the user of a Basic credential, LEAVE ends it
CLASS ltcl_logon DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
  PRIVATE SECTION.
    METHODS teardown.
    METHODS basic_user_until_leave FOR TESTING RAISING cx_static_check.
    METHODS no_credential_is_sy_uname FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_logon IMPLEMENTATION.

  METHOD teardown.
    zcl_osd_logon=>leave( ).
  ENDMETHOD.

  METHOD basic_user_until_leave.
    zcl_osd_logon=>enter( |Basic { cl_http_utility=>encode_base64( 'bob:secret' ) }| ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_logon=>user( ) exp = 'BOB' ).
    zcl_osd_logon=>leave( ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_logon=>user( ) exp = sy-uname ).
  ENDMETHOD.

  METHOD no_credential_is_sy_uname.
    zcl_osd_logon=>set( 'ALICE' ).
    zcl_osd_logon=>enter( '' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_logon=>user( ) exp = sy-uname ).
    zcl_osd_logon=>enter( 'Bearer abc' ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_logon=>user( ) exp = sy-uname ).
  ENDMETHOD.

ENDCLASS.
