* The EML statements are written as the ZCL_OSD_RAP_EML calls they lower
* to, each with its statement in a comment above it; %is_draft is a
* component of the rows like a key. The rows each test makes are deleted
* again in teardown, so the seeded ones stay as they are.
CLASS ltcl_supplement DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE '/DMO/I_SUPPLEMENT'.
    TYPES tt_create   TYPE TABLE FOR CREATE /dmo/i_supplement.
    TYPES tt_update   TYPE TABLE FOR UPDATE /dmo/i_supplement.
    TYPES tt_activate TYPE TABLE FOR ACTION IMPORT /dmo/i_supplement~activate.
    TYPES tt_active   TYPE TABLE FOR ACTION RESULT /dmo/i_supplement~activate.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY /dmo/i_supplement.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY /dmo/i_supplement.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY /dmo/i_supplement.
    DATA ms_failed   TYPE ty_failed.
    DATA ms_reported TYPE ty_reported.
    DATA mt_made     TYPE STANDARD TABLE OF /dmo/supplement_id WITH DEFAULT KEY.
    METHODS setup.
    METHODS teardown.
    METHODS commit
      RETURNING
        VALUE(rv_saved) TYPE abap_bool.
    METHODS new_draft
      IMPORTING
        iv_price     TYPE /dmo/supplement_price
      RETURNING
        VALUE(rv_id) TYPE /dmo/supplement_id.
    METHODS run
      IMPORTING
        iv_action      TYPE csequence
        iv_id          TYPE /dmo/supplement_id
        iv_draft       TYPE abap_bool
      RETURNING
        VALUE(rv_rows) TYPE i.
    METHODS numbers_by_category FOR TESTING RAISING cx_static_check.
    METHODS activates FOR TESTING RAISING cx_static_check.
    METHODS activation_validates FOR TESTING RAISING cx_static_check.
    METHODS edits_and_discards FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_supplement IMPLEMENTATION.

  METHOD setup.
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported, mt_made.
  ENDMETHOD.

  METHOD teardown.
    DATA lv_id TYPE /dmo/supplement_id.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    LOOP AT mt_made INTO lv_id.
      DELETE FROM /dmo/supplement WHERE supplement_id = @lv_id.
      DELETE FROM /dmo/suppl_text WHERE supplement_id = @lv_id.
      DELETE FROM /dmo/suppl_d WHERE supplementid = @lv_id.
      DELETE FROM /dmo/suppl_txt_d WHERE supplementid = @lv_id.
    ENDLOOP.
    COMMIT WORK.
  ENDMETHOD.

  METHOD commit.
* COMMIT ENTITIES; a failed save is the test's failure, with its reason
    DATA lx_error TYPE REF TO zcx_osd_rap.
    TRY.
        zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                                 IMPORTING ev_saved = rv_saved
                                 CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        cl_abap_unit_assert=>fail( lx_error->get_text( ) ).
    ENDTRY.
  ENDMETHOD.

  METHOD new_draft.
* MODIFY ENTITIES OF /dmo/i_supplement ENTITY supplement
*   CREATE FIELDS ( supplementcategory price currencycode )
*   WITH VALUE #( ( %cid = 'S1' %is_draft = if_abap_behv=>mk-on ... ) )
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-supplement.

    ls_create-%cid = 'S1'.
    ls_create-%is_draft = if_abap_behv=>mk-on.
    ls_create-supplementcategory = 'ML'.
    ls_create-price = iv_price.
    ls_create-currencycode = 'EUR'.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'supplement' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'supplementcategory, price, currencycode'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the create is accepted' ).
    READ TABLE ls_mapped-supplement INDEX 1 INTO ls_line.
    rv_id = ls_line-supplementid.
    APPEND rv_id TO mt_made.
    cl_abap_unit_assert=>assert_equals( act = ls_line-%is_draft exp = if_abap_behv=>mk-on msg = 'MAPPED names the draft' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'the draft is saved' ).
  ENDMETHOD.

  METHOD run.
* MODIFY ENTITIES OF /dmo/i_supplement ENTITY supplement EXECUTE <action>
*   FROM VALUE #( ( %tky-supplementid = iv_id %tky-%is_draft = ... ) ) RESULT ...
    DATA lt_import TYPE tt_activate.
    DATA ls_import LIKE LINE OF lt_import.
    DATA lt_result TYPE tt_active.

    ls_import-supplementid = iv_id.
    IF iv_draft = abap_true.
      ls_import-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    APPEND ls_import TO lt_import.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = 'supplement' iv_action = iv_action it_rows = lt_import
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    rv_rows = lines( lt_result ).
  ENDMETHOD.

  METHOD numbers_by_category.
* the pool's early numbering: the category, a dash and the next number of
* the category, counted over the active and the draft supplements
    DATA lv_first  TYPE /dmo/supplement_id.
    DATA lv_second TYPE /dmo/supplement_id.

    lv_first = new_draft( '9.50' ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_first exp = 'ML-++++' ).
    lv_second = new_draft( '9.50' ).
    cl_abap_unit_assert=>assert_equals( act = CONV i( substring_after( val = lv_second sub = '-' ) )
                                        exp = CONV i( substring_after( val = lv_first sub = '-' ) ) + 1
                                        msg = 'a draft counts for the next number' ).
    SELECT COUNT(*) FROM /dmo/suppl_d INTO @DATA(lv_drafts) WHERE supplementid = @lv_first.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 1 ).
    SELECT COUNT(*) FROM /dmo/supplement INTO @DATA(lv_active) WHERE supplement_id = @lv_first.
    cl_abap_unit_assert=>assert_equals( act = lv_active exp = 0 msg = 'a draft is not active' ).
  ENDMETHOD.

  METHOD activates.
    DATA lv_id   TYPE /dmo/supplement_id.
    DATA ls_row  TYPE /dmo/supplement.

    lv_id = new_draft( '12.00' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Prepare' iv_id = lv_id iv_draft = abap_true ) exp = 0 ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'Prepare: validatePrice passes' ).
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Activate' iv_id = lv_id iv_draft = abap_true ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT SINGLE * FROM /dmo/supplement INTO @ls_row WHERE supplement_id = @lv_id.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'active after Activate' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-price exp = '12.00' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-supplement_category exp = 'ML' ).
    SELECT COUNT(*) FROM /dmo/suppl_d INTO @DATA(lv_drafts) WHERE supplementid = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 0 msg = 'the draft is gone' ).
  ENDMETHOD.

  METHOD activation_validates.
* a draft is saved unvalidated; Activate runs validatePrice and refuses
    DATA lv_id TYPE /dmo/supplement_id.

    lv_id = new_draft( '0' ).
    run( iv_action = 'Activate' iv_id = lv_id iv_draft = abap_true ).
    commit( ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-supplement msg = 'price_required' ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT COUNT(*) FROM /dmo/supplement INTO @DATA(lv_active) WHERE supplement_id = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_active exp = 0 ).
    SELECT COUNT(*) FROM /dmo/suppl_d INTO @DATA(lv_drafts) WHERE supplementid = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 1 msg = 'the draft stays' ).
  ENDMETHOD.

  METHOD edits_and_discards.
    DATA lv_id     TYPE /dmo/supplement_id.
    DATA lt_update TYPE tt_update.
    DATA ls_update LIKE LINE OF lt_update.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_row    TYPE /dmo/supplement.

    lv_id = new_draft( '5.00' ).
    run( iv_action = 'Activate' iv_id = lv_id iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
* Edit: a draft of the active supplement
    cl_abap_unit_assert=>assert_equals( act = run( iv_action = 'Edit' iv_id = lv_id iv_draft = abap_false ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
* MODIFY ENTITIES ... UPDATE FIELDS ( price ) WITH VALUE #( ( %is_draft = on ... ) )
    ls_update-supplementid = lv_id.
    ls_update-%is_draft = if_abap_behv=>mk-on.
    ls_update-price = '6.00'.
    APPEND ls_update TO lt_update.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = 'supplement' iv_operation = 'UPDATE'
                                       it_rows = lt_update iv_fields = 'price'
                             CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
* Discard: the draft goes, the active supplement keeps its price
    run( iv_action = 'Discard' iv_id = lv_id iv_draft = abap_true ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/suppl_d INTO @DATA(lv_drafts) WHERE supplementid = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 0 ).
    SELECT SINGLE * FROM /dmo/supplement INTO @ls_row WHERE supplement_id = @lv_id.
    cl_abap_unit_assert=>assert_equals( act = ls_row-price exp = '5.00' ).
  ENDMETHOD.

ENDCLASS.

CLASS lcl_reversing DEFINITION FINAL.
* The agency BO whose saver returns MAPPED LATE in reverse order: a valid
* adjust_numbers may order its rows as it likes, %pre names each one (the
* #917 critic's probe). Everything else is the generated adapter.
* #917 follow-up: the other modes make the saver's answer wrong in one way
* each, and the runtime's guard must refuse it -- P a final key in the
* preliminary range, U a key an active agency has, D the same final key for
* two instances, X a row dropped, I one %pid twice.
  PUBLIC SECTION.
    INTERFACES zif_osd_rap_bo.
    METHODS constructor
      IMPORTING
        iv_mode TYPE c DEFAULT 'R'
        iv_key  TYPE /dmo/agency_id OPTIONAL.
  PRIVATE SECTION.
    DATA mi_bo   TYPE REF TO zif_osd_rap_bo.
    DATA mv_mode TYPE c LENGTH 1.
    DATA mv_key  TYPE /dmo/agency_id.
ENDCLASS.

CLASS lcl_reversing IMPLEMENTATION.

  METHOD constructor.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    CREATE OBJECT li_registry TYPE ('ZCL_OSD_RAP_REGISTRY').
    mi_bo = li_registry->get( '/DMO/R_AGENCYTP' ).
    mv_mode = iv_mode.
    mv_key = iv_key.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~model.
    rs_model = mi_bo->model( ).
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
    DATA lr_copy TYPE REF TO data.
    DATA lv_line TYPE i.
    FIELD-SYMBOLS <ls_mapped> TYPE any.
    FIELD-SYMBOLS <lt_late>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_copy>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lv_value>  TYPE any.
    DATA lv_key TYPE /dmo/agency_id.
    DATA lv_pid TYPE x LENGTH 16.

    mi_bo->adjust_numbers( io_saver = io_saver ir_mapped = ir_mapped ir_reported = ir_reported ).
    ASSIGN ir_mapped->* TO <ls_mapped>.
    ASSIGN COMPONENT '/DMO/AGENCY' OF STRUCTURE <ls_mapped> TO <lt_late>.
    CREATE DATA lr_copy LIKE <lt_late>.
    ASSIGN lr_copy->* TO <lt_copy>.
    CASE mv_mode.
      WHEN 'R'.
        lv_line = lines( <lt_late> ).
        WHILE lv_line > 0.
          READ TABLE <lt_late> INDEX lv_line ASSIGNING <ls_row>.
          APPEND <ls_row> TO <lt_copy>.
          lv_line = lv_line - 1.
        ENDWHILE.
        <lt_late> = <lt_copy>.
      WHEN 'P' OR 'U'.
        LOOP AT <lt_late> ASSIGNING <ls_row>.
          ASSIGN COMPONENT 'AGENCYID' OF STRUCTURE <ls_row> TO <lv_value>.
          <lv_value> = mv_key.
        ENDLOOP.
      WHEN 'D'.
        READ TABLE <lt_late> INDEX 1 ASSIGNING <ls_row>.
        ASSIGN COMPONENT 'AGENCYID' OF STRUCTURE <ls_row> TO <lv_value>.
        lv_key = <lv_value>.
        LOOP AT <lt_late> ASSIGNING <ls_row>.
          ASSIGN COMPONENT 'AGENCYID' OF STRUCTURE <ls_row> TO <lv_value>.
          <lv_value> = lv_key.
        ENDLOOP.
      WHEN 'X'.
        DELETE <lt_late> INDEX lines( <lt_late> ).
      WHEN 'I'.
        READ TABLE <lt_late> INDEX 1 ASSIGNING <ls_row>.
        ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_row> TO <lv_value>.
        lv_pid = <lv_value>.
        READ TABLE <lt_late> INDEX 2 ASSIGNING <ls_row>.
        ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_row> TO <lv_value>.
        <lv_value> = lv_pid.
    ENDCASE.
  ENDMETHOD.

  METHOD zif_osd_rap_bo~call.
    mi_bo->call( io_handler = io_handler iv_entity = iv_entity iv_name = iv_name
                 ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                 ir_failed = ir_failed ir_reported = ir_reported ir_mapped = ir_mapped ).
  ENDMETHOD.

ENDCLASS.

CLASS ltcl_agency DEFINITION FOR TESTING DURATION SHORT RISK LEVEL DANGEROUS FINAL.
  PRIVATE SECTION.
    CONSTANTS co_bdef TYPE string VALUE '/DMO/R_AGENCYTP'.
    TYPES tt_create   TYPE TABLE FOR CREATE /dmo/r_agencytp.
    TYPES tt_activate TYPE TABLE FOR ACTION IMPORT /dmo/r_agencytp~activate.
    TYPES tt_active   TYPE TABLE FOR ACTION RESULT /dmo/r_agencytp~activate.
    TYPES ty_mapped   TYPE RESPONSE FOR MAPPED EARLY /dmo/r_agencytp.
    TYPES ty_failed   TYPE RESPONSE FOR FAILED EARLY /dmo/r_agencytp.
    TYPES ty_reported TYPE RESPONSE FOR REPORTED EARLY /dmo/r_agencytp.
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
        iv_draft      TYPE abap_bool
        iv_email      TYPE csequence DEFAULT 'r10@agency.example'
        iv_name       TYPE csequence DEFAULT 'R10 agency'
      RETURNING
        VALUE(rs_key) TYPE ty_mapped.
    METHODS activate
      IMPORTING
        iv_id          TYPE /dmo/agency_id
      RETURNING
        VALUE(rv_rows) TYPE i.
    METHODS draft_has_a_preliminary_key FOR TESTING RAISING cx_static_check.
    METHODS activate_draws_the_final_key FOR TESTING RAISING cx_static_check.
    METHODS activation_validates FOR TESTING RAISING cx_static_check.
    METHODS active_create_numbers_late FOR TESTING RAISING cx_static_check.
    METHODS drafts_at_the_top_do_not_meet FOR TESTING RAISING cx_static_check.
    METHODS exhausted_range_writes_nothing FOR TESTING RAISING cx_static_check.
    METHODS mapping_by_pid_not_order FOR TESTING RAISING cx_static_check.
    METHODS refuses_a_preliminary_key FOR TESTING RAISING cx_static_check.
    METHODS refuses_a_key_in_use FOR TESTING RAISING cx_static_check.
    METHODS refuses_a_duplicate_key FOR TESTING RAISING cx_static_check.
    METHODS refuses_a_dropped_row FOR TESTING RAISING cx_static_check.
    METHODS refuses_a_duplicated_pid FOR TESTING RAISING cx_static_check.
    METHODS refused
      IMPORTING
        iv_mode   TYPE c
        iv_key    TYPE /dmo/agency_id OPTIONAL
        iv_reason TYPE csequence.
    METHODS keep
      IMPORTING
        iv_id   TYPE /dmo/agency_id
        iv_name TYPE csequence.
    METHODS first_key
      IMPORTING
        is_mapped    TYPE ty_mapped
      RETURNING
        VALUE(rv_id) TYPE /dmo/agency_id.
ENDCLASS.

CLASS ltcl_agency IMPLEMENTATION.

  METHOD setup.
    zcl_osd_rap_eml=>reset( ).
    CLEAR: ms_failed, ms_reported.
    SELECT MAX( agency_id ) FROM /dmo/agency INTO @mv_max.
    SELECT SINGLE country FROM i_country INTO @mv_country.
  ENDMETHOD.

  METHOD teardown.
    zcl_osd_rap_eml=>rollback( ).
    zcl_osd_rap_eml=>reset( ).
    DELETE FROM /dmo/agency WHERE agency_id > @mv_max.
    DELETE FROM /dmo/agency_d WHERE name LIKE 'R10 %'.
    COMMIT WORK.
  ENDMETHOD.

  METHOD commit.
* COMMIT ENTITIES; a failed save is the test's failure, with its reason
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
* MODIFY ENTITIES OF /dmo/r_agencytp ENTITY /dmo/agency
*   CREATE FIELDS ( name countrycode emailaddress ) WITH VALUE #( ( %cid = 'A1' ... ) )
*   MAPPED DATA(mapped)
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.

    ls_create-%cid = 'A1'.
    IF iv_draft = abap_true.
      ls_create-%is_draft = if_abap_behv=>mk-on.
    ENDIF.
    ls_create-name = iv_name.
    ls_create-countrycode = mv_country.
    ls_create-emailaddress = iv_email.
    APPEND ls_create TO lt_create.
    zcl_osd_rap_eml=>modify( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_operation = 'CREATE'
                                       it_rows = lt_create iv_fields = 'name, countrycode, emailaddress'
                             CHANGING cs_mapped = rs_key cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the create is accepted' ).
  ENDMETHOD.

  METHOD activate.
    DATA lt_import TYPE tt_activate.
    DATA ls_import LIKE LINE OF lt_import.
    DATA lt_result TYPE tt_active.

    ls_import-agencyid = iv_id.
    ls_import-%is_draft = if_abap_behv=>mk-on.
    APPEND ls_import TO lt_import.
    zcl_osd_rap_eml=>execute( EXPORTING iv_bdef = co_bdef iv_entity = '/dmo/agency' iv_action = 'Activate' it_rows = lt_import
                              CHANGING ct_result = lt_result cs_failed = ms_failed cs_reported = ms_reported ).
    rv_rows = lines( lt_result ).
  ENDMETHOD.

  METHOD draft_has_a_preliminary_key.
* a new draft has %pid and a preliminary key from the top of the key's
* range, which the final keys (counting up) do not reach
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-/dmo/agency.

    ls_mapped = create( abap_true ).
    READ TABLE ls_mapped-/dmo/agency INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_not_initial( act = ls_line-%pid msg = '%pid' ).
    cl_abap_unit_assert=>assert_char_cp( act = ls_line-agencyid exp = '99999+' ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/agency_d INTO @DATA(lv_drafts) WHERE agencyid = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 1 msg = 'the draft keeps its preliminary key' ).
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_active) WHERE agency_id > @mv_max.
    cl_abap_unit_assert=>assert_equals( act = lv_active exp = 0 ).
  ENDMETHOD.

  METHOD activate_draws_the_final_key.
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-/dmo/agency.
    DATA ls_row    TYPE /dmo/agency.
    DATA lv_next   TYPE /dmo/agency_id.

    ls_mapped = create( abap_true ).
    READ TABLE ls_mapped-/dmo/agency INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    cl_abap_unit_assert=>assert_equals( act = activate( ls_line-agencyid ) exp = 1 ).
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'validations pass, adjust_numbers draws' ).
    lv_next = mv_max + 1.
    SELECT SINGLE * FROM /dmo/agency INTO @ls_row WHERE agency_id = @lv_next.
    cl_abap_unit_assert=>assert_subrc( act = sy-subrc msg = 'the final key: the highest saved + 1' ).
    cl_abap_unit_assert=>assert_equals( act = ls_row-name exp = 'R10 agency' ).
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_pre) WHERE agency_id = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_pre exp = 0 msg = 'the preliminary key is not saved' ).
    SELECT COUNT(*) FROM /dmo/agency_d INTO @DATA(lv_drafts) WHERE agencyid = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 0 msg = 'the draft is gone' ).
  ENDMETHOD.

  METHOD activation_validates.
* the draft takes an e-mail address without a domain; Activate runs
* /DMO/validateEMailAddress and refuses it, nothing is numbered
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-/dmo/agency.

    ls_mapped = create( iv_draft = abap_true iv_email = 'no-at-sign' ).
    READ TABLE ls_mapped-/dmo/agency INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_true( act = commit( ) msg = 'a draft is saved unvalidated' ).
    activate( ls_line-agencyid ).
    commit( ).
    cl_abap_unit_assert=>assert_not_initial( act = ms_failed-/dmo/agency msg = 'email_invalid_format' ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_active) WHERE agency_id > @mv_max.
    cl_abap_unit_assert=>assert_equals( act = lv_active exp = 0 ).
    SELECT COUNT(*) FROM /dmo/agency_d INTO @DATA(lv_drafts) WHERE agencyid = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_drafts exp = 1 msg = 'the draft stays' ).
  ENDMETHOD.

  METHOD active_create_numbers_late.
* without a draft: MAPPED answers %pid and the preliminary key; the save's
* adjust_numbers writes the final one
    DATA ls_mapped TYPE ty_mapped.
    DATA ls_line   LIKE LINE OF ls_mapped-/dmo/agency.
    DATA lv_next   TYPE /dmo/agency_id.

    ls_mapped = create( abap_false ).
    READ TABLE ls_mapped-/dmo/agency INDEX 1 INTO ls_line.
    cl_abap_unit_assert=>assert_not_initial( act = ls_line-%pid ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    lv_next = mv_max + 1.
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_final) WHERE agency_id = @lv_next.
    cl_abap_unit_assert=>assert_equals( act = lv_final exp = 1 ).
    SELECT COUNT(*) FROM /dmo/agency INTO @DATA(lv_pre) WHERE agency_id = @ls_line-agencyid.
    cl_abap_unit_assert=>assert_equals( act = lv_pre exp = 0 ).
  ENDMETHOD.

  METHOD keep.
* an active agency written straight into the table, as a seed row would be
    DATA ls_row TYPE /dmo/agency.
    ls_row-agency_id = iv_id.
    ls_row-name = iv_name.
    ls_row-country_code = mv_country.
    ls_row-email_address = 'kept@agency.example'.
    INSERT /dmo/agency FROM @ls_row.
    COMMIT WORK.
  ENDMETHOD.

  METHOD first_key.
    DATA ls_line LIKE LINE OF is_mapped-/dmo/agency.
    READ TABLE is_mapped-/dmo/agency INDEX 1 INTO ls_line.
    rv_id = ls_line-agencyid.
  ENDMETHOD.

  METHOD drafts_at_the_top_do_not_meet.
* the #917 critic's repro: an agency saved at 999997, two new drafts under
* the preliminary keys above it, both activated. Before, the first took the
* second's preliminary key as its final one and the second then replaced
* the first. The final keys are drawn below the preliminary range now
    DATA lv_first  TYPE /dmo/agency_id.
    DATA lv_second TYPE /dmo/agency_id.
    DATA lv_below  TYPE /dmo/agency_id.
    DATA lv_n1     TYPE /dmo/agency_id.
    DATA lv_n2     TYPE /dmo/agency_id.
    DATA lv_count  TYPE i.

    SELECT MAX( agency_id ) FROM /dmo/agency WHERE agency_id < '999000' INTO @lv_below.
    lv_n1 = lv_below + 1.
    lv_n2 = lv_below + 2.
    keep( iv_id = '999997' iv_name = 'R10 kept' ).
    lv_first = first_key( create( iv_draft = abap_true iv_name = 'R10 first' ) ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    lv_second = first_key( create( iv_draft = abap_true iv_name = 'R10 second' ) ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    cl_abap_unit_assert=>assert_equals( act = lv_first exp = '999999' ).
    cl_abap_unit_assert=>assert_equals( act = lv_second exp = '999998' ).
    activate( lv_first ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    activate( lv_second ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_n1 AND name = 'R10 first'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the first, below the preliminary range' ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_n2 AND name = 'R10 second'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the second, its own key' ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = '999997' AND name = 'R10 kept'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the saved agency is untouched' ).
  ENDMETHOD.

  METHOD exhausted_range_writes_nothing.
* the final range is used up (an agency at 998999, just below the
* preliminary range): Activate's save fails and writes nothing, the draft stays
    DATA lv_pre   TYPE /dmo/agency_id.
    DATA lv_count TYPE i.
    DATA lv_saved TYPE abap_bool.
    DATA lx_error TYPE REF TO zcx_osd_rap.

    keep( iv_id = '998999' iv_name = 'R10 kept' ).
    lv_pre = first_key( create( abap_true ) ).
    cl_abap_unit_assert=>assert_true( act = commit( ) ).
    activate( lv_pre ).
    TRY.
        zcl_osd_rap_eml=>commit( EXPORTING iv_bdef = co_bdef
                                 IMPORTING ev_saved = lv_saved
                                 CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_saved = abap_false.
    ENDTRY.
    cl_abap_unit_assert=>assert_false( act = lv_saved msg = 'no final key: the save fails' ).
    zcl_osd_rap_eml=>rollback( ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id > @mv_max AND agency_id <> '998999'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = 'nothing written' ).
    SELECT COUNT(*) FROM /dmo/agency_d INTO @lv_count WHERE agencyid = @lv_pre.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the draft stays' ).
  ENDMETHOD.

  METHOD mapping_by_pid_not_order.
* two active creates, the saver's MAPPED LATE reversed: each instance gets
* the key its %pid was given
    DATA lo_bo     TYPE REF TO lcl_reversing.
    DATA lo_rap    TYPE REF TO zcl_osd_rap_runtime.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped TYPE ty_mapped.
    DATA lv_saved  TYPE abap_bool.
    DATA lv_below  TYPE /dmo/agency_id.
    DATA lv_n1     TYPE /dmo/agency_id.
    DATA lv_n2     TYPE /dmo/agency_id.
    DATA lv_count  TYPE i.

    SELECT MAX( agency_id ) FROM /dmo/agency WHERE agency_id < '999000' INTO @lv_below.
    lv_n1 = lv_below + 1.
    lv_n2 = lv_below + 2.
    CREATE OBJECT lo_bo.
    lo_rap = zcl_osd_rap_runtime=>for_bo( lo_bo ).
    ls_create-countrycode = mv_country.
    ls_create-emailaddress = 'r10@agency.example'.
    ls_create-%control-name = if_abap_behv=>mk-on.
    ls_create-%control-countrycode = if_abap_behv=>mk-on.
    ls_create-%control-emailaddress = if_abap_behv=>mk-on.
    ls_create-%cid = 'M1'.
    ls_create-name = 'R10 first'.
    APPEND ls_create TO lt_create.
    ls_create-%cid = 'M2'.
    ls_create-name = 'R10 second'.
    APPEND ls_create TO lt_create.
    lo_rap->modify( EXPORTING iv_entity = '/dmo/agency' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    lo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_true( act = lv_saved ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_n1 AND name = 'R10 first'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 msg = 'the saver gave the first row the first number' ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE agency_id = @lv_n2 AND name = 'R10 second'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 1 ).
  ENDMETHOD.

  METHOD refused.
* two active creates whose saver answers MAPPED LATE wrongly (lcl_reversing,
* mode IV_MODE): the save is refused with IV_REASON and writes nothing
    DATA lo_bo     TYPE REF TO lcl_reversing.
    DATA lo_rap    TYPE REF TO zcl_osd_rap_runtime.
    DATA lt_create TYPE tt_create.
    DATA ls_create LIKE LINE OF lt_create.
    DATA ls_mapped TYPE ty_mapped.
    DATA lv_saved  TYPE abap_bool.
    DATA lv_text   TYPE string.
    DATA lv_count  TYPE i.
    DATA lx_error  TYPE REF TO zcx_osd_rap.

    CREATE OBJECT lo_bo EXPORTING iv_mode = iv_mode iv_key = iv_key.
    lo_rap = zcl_osd_rap_runtime=>for_bo( lo_bo ).
    ls_create-countrycode = mv_country.
    ls_create-emailaddress = 'r10@agency.example'.
    ls_create-%control-name = if_abap_behv=>mk-on.
    ls_create-%control-countrycode = if_abap_behv=>mk-on.
    ls_create-%control-emailaddress = if_abap_behv=>mk-on.
    ls_create-%cid = 'G1'.
    ls_create-name = 'R10 guard one'.
    APPEND ls_create TO lt_create.
    ls_create-%cid = 'G2'.
    ls_create-name = 'R10 guard two'.
    APPEND ls_create TO lt_create.
    lo_rap->modify( EXPORTING iv_entity = '/dmo/agency' iv_operation = zcl_osd_rap_runtime=>co_operation-create it_rows = lt_create
                    CHANGING cs_mapped = ls_mapped cs_failed = ms_failed cs_reported = ms_reported ).
    cl_abap_unit_assert=>assert_initial( act = ms_failed msg = 'the creates are accepted' ).
    TRY.
        lo_rap->commit( IMPORTING ev_saved = lv_saved CHANGING cs_failed = ms_failed cs_reported = ms_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_saved = abap_false.
        lv_text = lx_error->get_text( ).
    ENDTRY.
    lo_rap->rollback( ).
    cl_abap_unit_assert=>assert_false( act = lv_saved msg = |mode { iv_mode }: the save is refused| ).
    cl_abap_unit_assert=>assert_char_cp( act = lv_text exp = |*{ iv_reason }*| msg = |mode { iv_mode }: { lv_text }| ).
    SELECT COUNT(*) FROM /dmo/agency INTO @lv_count WHERE name LIKE 'R10 guard %'.
    cl_abap_unit_assert=>assert_equals( act = lv_count exp = 0 msg = |mode { iv_mode }: nothing written| ).
  ENDMETHOD.

  METHOD refuses_a_preliminary_key.
    refused( iv_mode = 'P' iv_key = '999500' iv_reason = 'range of the preliminary keys' ).
  ENDMETHOD.

  METHOD refuses_a_key_in_use.
* the highest saved agency: an active instance has it
    refused( iv_mode = 'U' iv_key = mv_max iv_reason = 'in use' ).
  ENDMETHOD.

  METHOD refuses_a_duplicate_key.
    refused( iv_mode = 'D' iv_reason = 'in use' ).
  ENDMETHOD.

  METHOD refuses_a_dropped_row.
    refused( iv_mode = 'X' iv_reason = '1 rows for 2 instances' ).
  ENDMETHOD.

  METHOD refuses_a_duplicated_pid.
    refused( iv_mode = 'I' iv_reason = '(%pid)' ).
  ENDMETHOD.

ENDCLASS.
