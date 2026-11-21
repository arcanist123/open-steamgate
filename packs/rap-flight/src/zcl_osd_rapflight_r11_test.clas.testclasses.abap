* The EML statements are written as the ZCL_OSD_RAP_EML calls they lower
* to, each with its statement in a comment above it. The rows each test
* makes are deleted again in teardown, so the seeded ones stay as they are.
CLASS ltcl_interface DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* /DMO/I_AgencyTP: `interface; use draft;` over /DMO/R_AgencyTP, every
* operation and draft action used
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE '/DMO/I_AGENCYTP'.
    TYPES tt_create   TYPE TABLE FOR CREATE /dmo/i_agencytp.
    TYPES tt_update   TYPE TABLE FOR UPDATE /dmo/i_agencytp.
    TYPES tt_delete   TYPE TABLE FOR DELETE /dmo/i_agencytp.
    TYPES tt_keys     TYPE TABLE FOR READ IMPORT /dmo/i_agencytp.
    TYPES tt_rows     TYPE TABLE FOR READ RESULT /dmo/i_agencytp.
    TYPES tt_activate TYPE TABLE FOR ACTION IMPORT /dmo/i_agencytp~activate.
    TYPES tt_active   TYPE TABLE FOR ACTION RESULT /dmo/i_agencytp~activate.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY /dmo/i_agencytp.
    TYPES ty_mapped_line TYPE STRUCTURE FOR MAPPED EARLY /dmo/i_agencytp.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY /dmo/i_agencytp.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY /dmo/i_agencytp.
    TYPES tt_base_keys TYPE TABLE FOR READ IMPORT /dmo/r_agencytp.
    TYPES tt_base_rows TYPE TABLE FOR READ RESULT /dmo/r_agencytp.
    TYPES ty_base_failed TYPE RESPONSE FOR FAILED EARLY /dmo/r_agencytp.
    DATA ms_failed   TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.
    DATA mv_max      TYPE /dmo/agency_id.
    DATA mv_country  TYPE land1.
    METHODS setup.
    METHODS teardown.
    METHODS commit
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.
    METHODS create
      IMPORTING
        iv_draft     TYPE abap_bool
        iv_name      TYPE csequence DEFAULT 'R11 agency'
      RETURNING
        VALUE(rs_line) TYPE ty_mapped_line.
    METHODS draft_activates_to_a_final_key FOR TESTING RAISING cx_static_check.
    METHODS update_and_delete FOR TESTING RAISING cx_static_check.
    METHODS shares_the_base_transaction FOR TESTING RAISING cx_static_check.
    METHODS refuses_what_it_cannot_route FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_interface IMPLEMENTATION.

  METHOD setup.
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
    SELECT MAX( agency_id ) FROM /dmo/agency WHERE agency_id < '999000' INTO @mv_max.
    SELECT SINGLE country FROM i_country INTO @mv_country.
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    DELETE FROM /dmo/agency WHERE name LIKE 'R11 %'.
    DELETE FROM /dmo/agency_d WHERE name LIKE 'R11 %'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD commit.
* COMMIT ENTITIES RESPONSE OF /dmo/i_agencytp FAILED f REPORTED r
    DATA lx_error TYPE REF TO zcx_osd_rap.
    TRY.
        zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                                 IMPORTING ev_saved = rv_saved
                                 CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>fail( lx_error->get_text( ) ).
    ENDTRY.
  ENDMETHOD.

  METHOD create.
* MODIFY ENTITIES OF /dmo/i_agencytp ENTITY /dmo/agency
*   CREATE FIELDS ( name countrycode emailaddress ) WITH VALUE #( ( %cid = 'I1' ... ) )
*   MAPPED DATA(mapped)
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped TYPE ty_mapped.

    ls_create-%cid = 'I1'.
    IF iv_draft = abap_true.
      ls_create-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    ls_create-name = iv_name.
    ls_create-countrycode = mv_country.
    ls_create-emailaddress = 'r11@agency.example'.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'name, countrycode, emailaddress'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the create is accepted' ).
    READ TABLE ls_mapped-/dmo/agency INDEX 1 INTO rs_line.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'MAPPED of the interface' ).
  ENDMETHOD.

  METHOD draft_activates_to_a_final_key.
* a draft through the interface: %pid and a preliminary key in the
* interface's MAPPED; Activate (used by the interface) draws the final key
    DATA ls_line   TYPE ty_mapped_line.
    DATA lt_import TYPE tt_activate.
    DATA ls_import LIKE LINE OF lt_import.
    DATA lt_result TYPE tt_active.
    DATA lv_next   TYPE /dmo/agency_id.
    DATA lv_count  TYPE i.

    ls_line = create( abap_true ).
    cl_abap_unit_assert=>assert_not_initial( act = ls_line-%pid msg = '%pid through the interface' ).
    cl_abap_unit_assert=>assert_char_cp( act = ls_line-agencyid exp = '99999+' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
* MODIFY ENTITIES OF /dmo/i_agencytp ENTITY /dmo/agency
*   EXECUTE Activate FROM VALUE #( ( %key-agencyid = ... %is_draft = if_abap_behv=>mk-on ) )
    ls_import-agencyid = ls_line-agencyid.
    ls_import-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_import TO lt_import.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_action = 'Activate' it_rows = lt_import
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_result ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    lv_next = mv_max + 1.
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_next AND name = 'R11 agency'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'saved under the final key' ).
    SELECT COUNT(*) FROM /dmo/agency_d INTO @lv_count WHERE agencyid = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the draft is gone' ).
  ENDMETHOD.

  METHOD update_and_delete.
* an active agency created, changed and deleted through the interface; READ
* ENTITIES OF /dmo/i_agencytp answers the interface's row type
    DATA lv_id     TYPE /dmo/agency_id.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA lt_keys   TYPE tt_keys.
    DATA ls_key    LIKE LINE OF lt_keys.
    DATA lt_rows   TYPE tt_rows.
    DATA ls_row    LIKE LINE OF lt_rows.
    DATA ls_mapped TYPE ty_mapped.
    DATA lv_count  TYPE i.

    create( abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    lv_id = mv_max + 1.
* MODIFY ENTITIES OF /dmo/i_agencytp ENTITY /dmo/agency
*   UPDATE FIELDS ( city ) WITH VALUE #( ( agencyid = lv_id city = 'Interface City' ) )
    ls_update-agencyid = lv_id.
    ls_update-city = 'Interface City'.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'city'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed ).
* READ ENTITIES OF /dmo/i_agencytp ENTITY /dmo/agency
*   FIELDS ( name city ) WITH VALUE #( ( agencyid = lv_id ) ) RESULT DATA(rows)
    ls_key-agencyid = lv_id.
    APPEND ls_key TO lt_keys.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' it_keys = lt_keys iv_fields = 'name, city'
                           CHANGING ct_result = lt_rows cs_failed = ms_failed ).
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-city exp = 'Interface City' msg = 'the buffer, read through the interface' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = 'R11 agency' ).
    cl_abap_unit_assert=>assert_initial( act = ls_row-emailaddress msg = 'a field not read is initial' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_id AND city = 'Interface City'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
* MODIFY ENTITIES OF /dmo/i_agencytp ENTITY /dmo/agency DELETE FROM VALUE #( ( agencyid = lv_id ) )
    ls_delete-agencyid = lv_id.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_operation = 'DELETE'
                                       it_rows = lt_delete
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 ).
  ENDMETHOD.

  METHOD shares_the_base_transaction.
* the interface and its base are one business object: a create through the
* interface is in the base's buffer before the save, and one COMMIT
* ENTITIES saves it
    DATA ls_line      TYPE ty_mapped_line.
    DATA lt_keys      TYPE tt_base_keys.
    DATA ls_key       LIKE LINE OF lt_keys.
    DATA lt_rows      TYPE tt_base_rows.
    DATA ls_row       LIKE LINE OF lt_rows.
    DATA ls_failed    TYPE ty_base_failed.
    DATA lt_sessions  TYPE string_table.

    ls_line = create( iv_draft = abap_false iv_name = 'R11 shared' ).
* READ ENTITIES OF /dmo/r_agencytp ENTITY /dmo/agency ALL FIELDS WITH ...
    ls_key-agencyid = ls_line-agencyid.
    ls_key-%pid = ls_line-%pid.
    APPEND ls_key TO lt_keys.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = '/DMO/R_AGENCYTP' iv_entity = '/dmo/agency' it_keys = lt_keys
                           iv_fields = zcl_osd_rap_eml=>co_all_fields
                           CHANGING ct_result = lt_rows cs_failed = ls_failed ).
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = 'R11 shared' msg = 'the base sees the interface''s create' ).
    lt_sessions = zcl_osd_rap_eml=>sessions( ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_sessions ) exp = 1 msg = 'one transaction, the base''s' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_count) WHERE name = 'R11 shared'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
  ENDMETHOD.

  METHOD refuses_what_it_cannot_route.
* EML runs a projection on its base by component name: an entity the BDEF
* does not have, a projection that renames elements and one with an augment
* are refused, not mapped wrongly
    DATA lt_keys   TYPE tt_keys.
    DATA ls_key    LIKE LINE OF lt_keys.
    DATA lt_rows   TYPE tt_rows.
    DATA lx_error  TYPE REF TO zcx_osd_rap.
    DATA lv_text   TYPE string.

    ls_key-agencyid = mv_max.
    APPEND ls_key TO lt_keys.
    TRY.
        zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Nothing' it_keys = lt_keys
                               CHANGING ct_result = lt_rows cs_failed = ms_failed ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_text = lx_error->get_text( ).
    ENDTRY.
    cl_abap_unit_assert=>assert_char_cp( act = lv_text exp = '*no entity of /DMO/I_AGENCYTP*' ).
    CLEAR lv_text.
    TRY.
        zcl_osd_rap_eml=>read( EXPORTING iv_bdef = '/DMO/C_TRAVEL_PROCESSOR_M' iv_entity = 'TravelProcessor' it_keys = lt_keys
                               CHANGING ct_result = lt_rows cs_failed = ms_failed ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_text = lx_error->get_text( ).
    ENDTRY.
    cl_abap_unit_assert=>assert_char_cp( act = lv_text exp = '*renames*' ).
    CLEAR lv_text.
    TRY.
        zcl_osd_rap_eml=>read( EXPORTING iv_bdef = '/DMO/C_SUPPLEMENT' iv_entity = 'Supplement' it_keys = lt_keys
                               CHANGING ct_result = lt_rows cs_failed = ms_failed ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_text = lx_error->get_text( ).
    ENDTRY.
    cl_abap_unit_assert=>assert_char_cp( act = lv_text exp = '*augment*' ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_singleton DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
* /DMO/I_CarriersLockSingleton_S: one root instance (CarrierSingletonID 1,
* computed from a join, no table), every carrier below it; Edit makes a
* draft of the root and of all its carriers, which are changed, created and
* deleted as drafts and activated together. The carriers the tests change
* are restored in teardown
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE '/DMO/I_CARRIERSLOCKSINGLETON_S'.
    TYPES tt_action   TYPE TABLE FOR ACTION IMPORT /dmo/i_carrierslocksingleton_s~edit.
    TYPES tt_action_r TYPE TABLE FOR ACTION RESULT /dmo/i_carrierslocksingleton_s~edit.
    TYPES tt_root_key TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s.
    TYPES tt_root     TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s.
    TYPES tt_by_key   TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s\_airline.
    TYPES tt_by       TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s\_airline.
    TYPES tt_by_link  TYPE TABLE FOR READ LINK /dmo/i_carrierslocksingleton_s\_airline.
    TYPES tt_cba      TYPE TABLE FOR CREATE /dmo/i_carrierslocksingleton_s\_airline.
    TYPES tt_update   TYPE TABLE FOR UPDATE /dmo/i_carrierslocksingleton_s\carrier.
    TYPES tt_delete   TYPE TABLE FOR DELETE /dmo/i_carrierslocksingleton_s\carrier.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY /dmo/i_carrierslocksingleton_s.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY /dmo/i_carrierslocksingleton_s.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY /dmo/i_carrierslocksingleton_s.
    DATA ms_failed   TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.
    DATA mt_carriers TYPE STANDARD TABLE OF /dmo/carrier WITH DEFAULT KEY.
    DATA mv_currency TYPE /dmo/currency_code.
    METHODS setup.
    METHODS teardown.
    METHODS commit
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.
    METHODS run
      IMPORTING
        iv_action      TYPE csequence
        iv_draft       TYPE abap_bool
      RETURNING
        VALUE(rv_rows) TYPE i.
    METHODS carriers
      IMPORTING
        iv_draft       TYPE abap_bool
      RETURNING
        VALUE(rt_rows) TYPE tt_by.
    METHODS update_name
      IMPORTING
        iv_id   TYPE /dmo/carrier_id
        iv_name TYPE csequence.
    METHODS why
      RETURNING
        VALUE(rv_text) TYPE string.
    METHODS root_is_one_computed_row FOR TESTING RAISING cx_static_check.
    METHODS edit_drafts_every_carrier FOR TESTING RAISING cx_static_check.
    METHODS change_and_activate FOR TESTING RAISING cx_static_check.
    METHODS create_and_delete_below FOR TESTING RAISING cx_static_check.
    METHODS prepare_validates_carriers FOR TESTING RAISING cx_static_check.
    METHODS used_carrier_is_not_deleted FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_singleton IMPLEMENTATION.

  METHOD setup.
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
    SELECT * FROM /dmo/carrier INTO TABLE @mt_carriers.
    SELECT SINGLE currency FROM i_currency INTO @mv_currency.
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    DELETE FROM /dmo/d_carr_lock.
    DELETE FROM /dmo/d_carrier.
    DELETE FROM /dmo/carrier.
    INSERT /dmo/carrier FROM TABLE @mt_carriers.
    COMMIT WORK.
  ENDMETHOD.

  METHOD commit.
    DATA lx_error TYPE REF TO zcx_osd_rap.
    TRY.
        zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                                 IMPORTING ev_saved = rv_saved
                                 CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>fail( lx_error->get_text( ) ).
    ENDTRY.
  ENDMETHOD.

  METHOD why.
* the messages of the last statements and the end of the runtime's trace,
* for an assertion's message
    DATA ls_rep    LIKE LINE OF ms_reported-carrier.
    DATA ls_root   LIKE LINE OF ms_reported-carrierslocksingleton.
    DATA lo_msg    TYPE REF TO if_message.
    DATA lt_trace  TYPE string_table.
    DATA lv_line   TYPE string.
    DATA lv_from   TYPE i.
    DATA lx_error  TYPE REF TO cx_root.

    LOOP AT ms_reported-carrier INTO ls_rep WHERE %msg IS BOUND.
      lo_msg ?= ls_rep-%msg.
      rv_text = |{ rv_text } [{ ls_rep-airlineid }: { lo_msg->get_text( ) }]|.
    ENDLOOP.
    LOOP AT ms_reported-carrierslocksingleton INTO ls_root WHERE %msg IS BOUND.
      lo_msg ?= ls_root-%msg.
      rv_text = |{ rv_text } [root: { lo_msg->get_text( ) }]|.
    ENDLOOP.
    TRY.
        lt_trace = zcl_osd_rap_eml=>runtime( co_bdef )->trace( ).
      CATCH cx_root INTO lx_error.
        rv_text = |{ rv_text } (no trace: { lx_error->get_text( ) })|.
    ENDTRY.
    lv_from = lines( lt_trace ) - 12.
    LOOP AT lt_trace INTO lv_line FROM lv_from.
      rv_text = |{ rv_text } / { lv_line }|.
    ENDLOOP.
  ENDMETHOD.

  METHOD run.
* MODIFY ENTITIES OF /dmo/i_carrierslocksingleton_s ENTITY CarriersLockSingleton
*   EXECUTE <action> FROM VALUE #( ( %tky-carriersingletonid = 1 %tky-%is_draft = ... ) )
    DATA lt_import TYPE tt_action.
    DATA ls_import LIKE LINE OF lt_import.
    DATA lt_result TYPE tt_action_r.

    ls_import-carriersingletonid = 1.
    IF iv_draft = abap_true.
      ls_import-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    APPEND ls_import TO lt_import.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'CarriersLockSingleton' iv_action = iv_action it_rows = lt_import
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    rv_rows = lines( lt_result ).
  ENDMETHOD.

  METHOD carriers.
* READ ENTITIES OF /dmo/i_carrierslocksingleton_s ENTITY CarriersLockSingleton
*   BY \_Airline ALL FIELDS WITH VALUE #( ( carriersingletonid = 1 %is_draft = ... ) )
    DATA lt_keys TYPE tt_by_key.
    DATA ls_key  LIKE LINE OF lt_keys.
    DATA lt_link TYPE tt_by_link.

    ls_key-carriersingletonid = 1.
    IF iv_draft = abap_true.
      ls_key-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    APPEND ls_key TO lt_keys.
    zcl_osd_rap_eml=>read_by( EXPORTING iv_bdef = co_bdef iv_entity = 'CarriersLockSingleton' iv_assoc = '_Airline' it_keys = lt_keys
                              CHANGING ct_result = rt_rows ct_link = lt_link cs_failed = ms_failed ).
  ENDMETHOD.

  METHOD update_name.
* MODIFY ENTITIES ... ENTITY Carrier UPDATE FIELDS ( name )
*   WITH VALUE #( ( airlineid = iv_id %is_draft = if_abap_behv=>mk-on name = iv_name ) )
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_mapped TYPE ty_mapped.

    ls_update-airlineid = iv_id.
    ls_update-%is_draft = if_abap_behv=>mk-on.
    ls_update-name = iv_name.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Carrier' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'name'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the draft takes the change' ).
  ENDMETHOD.

  METHOD root_is_one_computed_row.
* the root is the view's one row: the literal key and MAX( last_changed_at )
    DATA lt_keys TYPE tt_root_key.
    DATA ls_key  LIKE LINE OF lt_keys.
    DATA lt_rows TYPE tt_root.
    DATA ls_row  LIKE LINE OF lt_rows.
    DATA lv_max  TYPE /dmo/carrier-last_changed_at.

    ls_key-carriersingletonid = 1.
    APPEND ls_key TO lt_keys.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'CarriersLockSingleton' it_keys = lt_keys
                                     iv_fields = zcl_osd_rap_eml=>co_all_fields
                           CHANGING ct_result = lt_rows cs_failed = ms_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rows ) exp = 1 ).
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    SELECT MAX( last_changed_at ) FROM /dmo/carrier INTO @lv_max.
    cl_abap_unit_assert=>assert_equals( act = ls_row-lastchangedatmax exp = lv_max msg = 'the total ETag: the latest change of a carrier' ).
* there is no instance 2
    CLEAR: lt_keys, lt_rows.
    ls_key-carriersingletonid = 2.
    APPEND ls_key TO lt_keys.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'CarriersLockSingleton' it_keys = lt_keys
                           CHANGING ct_result = lt_rows cs_failed = ms_failed ).
    cl_abap_unit_assert=>assert_initial( lt_rows ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-carrierslocksingleton msg = 'not found' ).
  ENDMETHOD.

  METHOD edit_drafts_every_carrier.
* the active carriers all belong to the one root (their CarrierSingletonID
* is the literal 1); Edit drafts the root and each of them
    DATA lt_rows  TYPE tt_by.
    DATA ls_row   LIKE LINE OF lt_rows.
    DATA lv_count TYPE i.

    lt_rows = carriers( abap_false ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rows ) exp = lines( mt_carriers ) msg = 'every carrier is below the root' ).
    READ TABLE lt_rows INDEX 1 INTO ls_row.
    cl_abap_unit_assert=>assert_equals( act = ls_row-carriersingletonid exp = 1 msg = 'the constant is filled' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_draft = abap_false ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT COUNT(*) FROM /dmo/d_carr_lock INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the root''s draft' ).
    SELECT COUNT(*) FROM /dmo/d_carrier INTO @lv_count WHERE carriersingletonid = 1.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = lines( mt_carriers ) msg = 'a draft of each carrier, under the root' ).
    zcl_osd_rap_eml=>reset( ).
    lt_rows = carriers( abap_true ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rows ) exp = lines( mt_carriers ) msg = 'the drafts below the root''s draft' ).
  ENDMETHOD.

  METHOD change_and_activate.
    DATA ls_first TYPE /dmo/carrier.
    DATA ls_row   TYPE /dmo/carrier.
    DATA lv_count TYPE i.

    READ TABLE mt_carriers INDEX 1 INTO ls_first.
    run( iv_action = 'Edit' iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    update_name( iv_id = ls_first-carrier_id iv_name = 'R11 renamed' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT SINGLE * FROM /dmo/carrier INTO @ls_row WHERE carrier_id = @ls_first-carrier_id.
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = ls_first-name msg = 'a draft change is not active' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT SINGLE * FROM /dmo/carrier INTO @ls_row WHERE carrier_id = @ls_first-carrier_id.
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = 'R11 renamed' ).
    SELECT COUNT(*) FROM /dmo/carrier INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = lines( mt_carriers ) msg = 'the others stay' ).
    SELECT COUNT(*) FROM /dmo/d_carr_lock INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'the root''s draft is gone' ).
    SELECT COUNT(*) FROM /dmo/d_carrier INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'and every carrier draft' ).
  ENDMETHOD.

  METHOD create_and_delete_below.
* MODIFY ENTITIES ... ENTITY CarriersLockSingleton CREATE BY \_Airline
*   FIELDS ( airlineid name currencycode ) WITH VALUE #( ( %tky = root draft %target = ... ) )
    DATA lt_cba    TYPE tt_cba.
    DATA ls_cba    LIKE LINE OF lt_cba.
    DATA ls_target LIKE LINE OF ls_cba-%target.
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA ls_mapped TYPE ty_mapped.
    DATA lv_count  TYPE i.

    run( iv_action = 'Edit' iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    ls_cba-carriersingletonid = 1.
    ls_cba-%is_draft = if_abap_behv=>mk-on.
    ls_target-%cid = 'C1'.
    ls_target-%is_draft = if_abap_behv=>mk-on.
    ls_target-airlineid = 'ZZ'.
    ls_target-name = 'R11 airline'.
    ls_target-currencycode = mv_currency.
    APPEND ls_target TO ls_cba-%target.
    APPEND ls_cba TO lt_cba.
    zcl_osd_rap_eml=>create_by( EXPORTING iv_bdef = co_bdef iv_entity = 'CarriersLockSingleton' iv_assoc = '_Airline'
                                          it_rows = lt_cba iv_fields = 'airlineid, name, currencycode'
                                CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the carrier is created below the root''s draft' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    run( iv_action = 'Activate' iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT COUNT(*) FROM /dmo/carrier INTO @lv_count WHERE carrier_id = 'ZZ' AND name = 'R11 airline'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'active after Activate' ).
* and deleted again: it has no connection, so its delete is enabled
    run( iv_action = 'Edit' iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    ls_delete-airlineid = 'ZZ'.
    ls_delete-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Carrier' iv_operation = 'DELETE' it_rows = lt_delete
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the delete of an unused carrier' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    run( iv_action = 'Activate' iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT COUNT(*) FROM /dmo/carrier INTO @lv_count WHERE carrier_id = 'ZZ'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'gone after Activate' ).
    SELECT COUNT(*) FROM /dmo/carrier INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = lines( mt_carriers ) ).
  ENDMETHOD.

  METHOD prepare_validates_carriers.
* the root's Prepare runs Carrier~validateName on the carrier drafts below
* it; the Activate that follows is refused and the drafts stay
    DATA ls_first TYPE /dmo/carrier.
    DATA ls_row   TYPE /dmo/carrier.
    DATA lv_count TYPE i.

    READ TABLE mt_carriers INDEX 1 INTO ls_first.
    run( iv_action = 'Edit' iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    update_name( iv_id = ls_first-carrier_id iv_name = '' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    zcl_osd_rap_eml=>reset( ).
    run( iv_action = 'Prepare' iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-carrier msg = |name_required, from the root's Prepare: { why( ) }| ).
    zcl_osd_rap_eml=>rollback( ).
    CLEAR ms_failed.
    run( iv_action = 'Activate' iv_draft = abap_true ).
    commit( ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed msg = 'Activate refused' ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT SINGLE * FROM /dmo/carrier INTO @ls_row WHERE carrier_id = @ls_first-carrier_id.
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = ls_first-name msg = 'the active carrier keeps its name' ).
    SELECT COUNT(*) FROM /dmo/d_carr_lock INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft stays' ).
    run( iv_action = 'Discard' iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
    SELECT COUNT(*) FROM /dmo/d_carrier INTO @lv_count.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'Discard takes the carrier drafts' ).
  ENDMETHOD.

  METHOD used_carrier_is_not_deleted.
* get_instance_features: a carrier with a connection has %delete disabled
    DATA lt_delete TYPE tt_delete.
    DATA ls_delete LIKE LINE OF lt_delete.
    DATA ls_mapped TYPE ty_mapped.
    DATA lv_used   TYPE /dmo/carrier_id.
    DATA lv_count  TYPE i.

    DATA lt_ids    TYPE SORTED TABLE OF /dmo/i_carrier WITH UNIQUE KEY AirlineID.
    DATA ls_id     TYPE /dmo/i_carrier.

    SELECT SINGLE carrier_id FROM /dmo/connection INTO @lv_used.
    cl_abap_unit_assert=>assert_not_initial( act = lv_used msg = 'the seed has connections' ).
* what the pool's get_instance_features asks
    ls_id-AirlineID = lv_used.
    INSERT ls_id INTO TABLE lt_ids.
    SELECT DISTINCT AirlineID FROM /DMO/I_Connection
      FOR ALL ENTRIES IN @lt_ids
      WHERE AirlineID = @lt_ids-AirlineID
      INTO TABLE @DATA(lt_connections).
    cl_abap_unit_assert=>assert_not_initial( act = lt_connections msg = 'the connection view answers the carrier' ).
    run( iv_action = 'Edit' iv_draft = abap_false ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = why( ) ).
* the draft the handler reads (READ ENTITIES ... IN LOCAL MODE in the pool)
    DATA lt_rkeys TYPE TABLE FOR READ IMPORT /dmo/i_carrierslocksingleton_s\carrier.
    DATA ls_rkey  LIKE LINE OF lt_rkeys.
    DATA lt_rrows TYPE TABLE FOR READ RESULT /dmo/i_carrierslocksingleton_s\carrier.
    ls_rkey-airlineid = lv_used.
    ls_rkey-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_rkey TO lt_rkeys.
    zcl_osd_rap_eml=>read( EXPORTING iv_bdef = co_bdef iv_entity = 'Carrier' it_keys = lt_rkeys iv_fields = 'airlineid'
                           CHANGING ct_result = lt_rrows cs_failed = ms_failed ).
    cl_abap_unit_assert=>assert_equals( act = lines( lt_rrows ) exp = 1 msg = |the carrier's draft by key: { why( ) }| ).
    ls_delete-airlineid = lv_used.
    ls_delete-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_delete TO lt_delete.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'Carrier' iv_operation = 'DELETE' it_rows = lt_delete
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-carrier msg = |the delete is disabled: { why( ) }| ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT COUNT(*) FROM /dmo/d_carrier INTO @lv_count WHERE airlineid = @lv_used.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft of the carrier stays' ).
  ENDMETHOD.

ENDCLASS.
