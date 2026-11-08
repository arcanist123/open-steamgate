CLASS zcl_osd_rap_sadl DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The managed RAP runtime behind the SADL data provider (R2c,
* docs/rap-runtime.md, "Serving"). A CDS entity that is the entity of a
* managed behavior definition is written through ZCL_OSD_RAP_RUNTIME --
* field control, numbering, determinations, validations, the save
* sequence -- and is still read through its view by the SADL data provider.
*
* One request is one RAP transaction: MODIFY (or the action), then the save
* sequence. A FAILED row, from the interaction phase or from a validation
* in the save, rolls the transaction back and becomes a business exception
* carrying the RAP messages, which the gateway answers with 400; nothing has
* been written then.
*
* The rows the SADL provider passes are the view's rows; the derived
* tables are made by the BDEF's adapter (ZIF_OSD_RAP_BO=>NEW_TABLE) and
* filled by component name, the %CONTROL flag set for every field the
* request gave.
  PUBLIC SECTION.
    INTERFACES zif_stg_sadl_behavior.
  PRIVATE SECTION.
    METHODS bo_of
      IMPORTING
        iv_entity    TYPE csequence
      RETURNING
        VALUE(ri_bo) TYPE REF TO zif_osd_rap_bo.

    METHODS runtime_of
      IMPORTING
        iv_entity  TYPE csequence
      EXPORTING
        eo_runtime TYPE REF TO zcl_osd_rap_runtime
        es_entity  TYPE zif_osd_rap_bo=>ty_entity
      RAISING
        /iwbep/cx_mgw_tech_exception.

    METHODS new_line
      IMPORTING
        io_runtime    TYPE REF TO zcl_osd_rap_runtime
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
        iv_kind       TYPE csequence
        iv_action     TYPE csequence OPTIONAL
      RETURNING
        VALUE(rr_tab) TYPE REF TO data
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS put_keys
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        is_from   TYPE any
      CHANGING
        cs_to     TYPE any.

    METHODS put_field
      IMPORTING
        iv_field TYPE string
        is_from  TYPE any
      CHANGING
        cs_line  TYPE any.

    METHODS count_failed
      IMPORTING
        is_model        TYPE zif_osd_rap_bo=>ty_model
        is_failed       TYPE any
      RETURNING
        VALUE(rv_count) TYPE i.

    METHODS messages
      IMPORTING
        is_model       TYPE zif_osd_rap_bo=>ty_model
        is_failed      TYPE any
        is_reported    TYPE any
      RETURNING
        VALUE(rv_text) TYPE string.

    METHODS finish
      IMPORTING
        io_runtime  TYPE REF TO zcl_osd_rap_runtime
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.

    METHODS refuse
      IMPORTING
        iv_text TYPE string
      RAISING
        /iwbep/cx_mgw_busi_exception.

    METHODS technical
      IMPORTING
        ix_error TYPE REF TO cx_root
      RAISING
        /iwbep/cx_mgw_tech_exception.
ENDCLASS.



CLASS zcl_osd_rap_sadl IMPLEMENTATION.

  METHOD bo_of.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA lt_bdef     TYPE zif_osd_rap_registry=>tt_name.
    DATA lv_bdef     TYPE string.
    DATA lv_class    TYPE string.
    DATA lv_name     TYPE string.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.

* by name: without behavior definitions the registry is not generated
    lv_class = 'ZCL_OSD_RAP_REGISTRY'.
    TRY.
        CREATE OBJECT li_registry TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RETURN.
    ENDTRY.
    lv_name = to_upper( iv_entity ).
    lt_bdef = li_registry->list( ).
    LOOP AT lt_bdef INTO lv_bdef.
      li_bo = li_registry->get( lv_bdef ).
      IF li_bo IS INITIAL.
        CONTINUE.
      ENDIF.
      ls_model = li_bo->model( ).
      READ TABLE ls_model-entities TRANSPORTING NO FIELDS WITH KEY name = lv_name.
      IF sy-subrc = 0.
        ri_bo = li_bo.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD runtime_of.
    DATA li_bo    TYPE REF TO zif_osd_rap_bo.
    DATA ls_model TYPE zif_osd_rap_bo=>ty_model.
    DATA lv_name  TYPE string.

    li_bo = bo_of( iv_entity ).
    IF li_bo IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
        EXPORTING
          method = |RAP behavior of { iv_entity }|.
    ENDIF.
    eo_runtime = zcl_osd_rap_runtime=>for_bo( li_bo ).
    ls_model = li_bo->model( ).
    lv_name = to_upper( iv_entity ).
    READ TABLE ls_model-entities INTO es_entity WITH KEY name = lv_name.
  ENDMETHOD.

  METHOD new_line.
    FIELD-SYMBOLS <lt_tab> TYPE STANDARD TABLE.

    rr_tab = io_runtime->bo( )->new_table( iv_entity = is_entity-name
                                           iv_kind   = iv_kind
                                           iv_action = iv_action ).
    IF rr_tab IS INITIAL.
      refuse( |{ is_entity-alias }: the behavior has no { to_lower( iv_kind ) } { iv_action }| ).
    ENDIF.
    ASSIGN rr_tab->* TO <lt_tab>.
    APPEND INITIAL LINE TO <lt_tab>.
  ENDMETHOD.

  METHOD put_keys.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE is_from TO <lv_from>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_to TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD put_field.
    FIELD-SYMBOLS <lv_from>    TYPE any.
    FIELD-SYMBOLS <lv_to>      TYPE any.
    FIELD-SYMBOLS <ls_control> TYPE any.
    FIELD-SYMBOLS <lv_flag>    TYPE any.

    ASSIGN COMPONENT iv_field OF STRUCTURE is_from TO <lv_from>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT iv_field OF STRUCTURE cs_line TO <lv_to>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    <lv_to> = <lv_from>.
    ASSIGN COMPONENT '%CONTROL' OF STRUCTURE cs_line TO <ls_control>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT iv_field OF STRUCTURE <ls_control> TO <lv_flag>.
      IF sy-subrc = 0.
        <lv_flag> = if_abap_behv=>mk-on.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD count_failed.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    FIELD-SYMBOLS <lt_failed> TYPE STANDARD TABLE.

    LOOP AT is_model-entities INTO ls_entity.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE is_failed TO <lt_failed>.
      IF sy-subrc = 0.
        rv_count = rv_count + lines( <lt_failed> ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD messages.
* the texts of REPORTED, in order; a failure without a message is named by
* its cause
    DATA ls_entity  TYPE zif_osd_rap_bo=>ty_entity.
    DATA lo_object  TYPE REF TO object.
    DATA li_message TYPE REF TO if_message.
    DATA lv_text    TYPE string.
    FIELD-SYMBOLS <lt_rows>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.
    FIELD-SYMBOLS <ls_fail>  TYPE any.

    LOOP AT is_model-entities INTO ls_entity.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE is_reported TO <lt_rows>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      LOOP AT <lt_rows> ASSIGNING <ls_row>.
        ASSIGN COMPONENT '%MSG' OF STRUCTURE <ls_row> TO <lv_value>.
        IF sy-subrc <> 0 OR <lv_value> IS INITIAL.
          CONTINUE.
        ENDIF.
        lo_object = <lv_value>.
        TRY.
            li_message ?= lo_object.
          CATCH cx_sy_move_cast_error.
            CONTINUE.
        ENDTRY.
        lv_text = li_message->get_text( ).
        IF lv_text IS INITIAL.
          CONTINUE.
        ENDIF.
        IF rv_text IS INITIAL.
          rv_text = lv_text.
        ELSE.
          rv_text = |{ rv_text }; { lv_text }|.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    IF rv_text IS NOT INITIAL.
      RETURN.
    ENDIF.

    LOOP AT is_model-entities INTO ls_entity.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE is_failed TO <lt_rows>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      LOOP AT <lt_rows> ASSIGNING <ls_row>.
        ASSIGN COMPONENT '%FAIL' OF STRUCTURE <ls_row> TO <ls_fail>.
        IF sy-subrc = 0.
          ASSIGN COMPONENT 'CAUSE' OF STRUCTURE <ls_fail> TO <lv_value>.
        ENDIF.
        IF sy-subrc = 0.
          rv_text = |{ ls_entity-alias } failed, cause { <lv_value> }|.
        ELSE.
          rv_text = |{ ls_entity-alias } failed|.
        ENDIF.
        RETURN.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD finish.
* the interaction phase failed: nothing is saved. Otherwise the save
* sequence, which may still fail in a validation
    DATA ls_model TYPE zif_osd_rap_bo=>ty_model.
    DATA lv_saved TYPE abap_bool.
    DATA lv_text  TYPE string.
    DATA lx_error TYPE REF TO zcx_osd_rap.

    ls_model = io_runtime->bo( )->model( ).
    IF count_failed( is_model = ls_model is_failed = cs_failed ) > 0.
      lv_text = messages( is_model = ls_model is_failed = cs_failed is_reported = cs_reported ).
      io_runtime->rollback( ).
      refuse( lv_text ).
    ENDIF.

    TRY.
        io_runtime->commit( IMPORTING ev_saved    = lv_saved
                            CHANGING  cs_failed   = cs_failed
                                      cs_reported = cs_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        io_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    IF lv_saved = abap_false.
      lv_text = messages( is_model = ls_model is_failed = cs_failed is_reported = cs_reported ).
      io_runtime->rollback( ).
      refuse( lv_text ).
    ENDIF.
  ENDMETHOD.

  METHOD refuse.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception
      EXPORTING
        textid            = /iwbep/cx_mgw_busi_exception=>business_error
        message           = iv_text
        message_unlimited = iv_text.
  ENDMETHOD.

  METHOD technical.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
      EXPORTING
        method = ix_error->get_text( ).
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~handles.
    IF bo_of( iv_entity ) IS NOT INITIAL.
      rv_handles = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~actions.
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA lv_name     TYPE string.

    li_bo = bo_of( iv_entity ).
    IF li_bo IS INITIAL.
      RETURN.
    ENDIF.
    ls_model = li_bo->model( ).
    lv_name = to_upper( iv_entity ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY name = lv_name.
    LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'A'.
      APPEND ls_callable-name TO rt_actions.
    ENDLOOP.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~create.
    DATA lo_runtime  TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field    TYPE zif_osd_rap_bo=>ty_field.
    DATA lr_tab      TYPE REF TO data.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lv_value>    TYPE any.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.
    FIELD-SYMBOLS <lt_mapped>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_key>      TYPE any.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity iv_kind = 'CREATE' ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_value>.
    IF sy-subrc = 0.
      <lv_value> = 'ODATA'.
    ENDIF.
    LOOP AT ls_entity-fields INTO ls_field.
      READ TABLE it_fields TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
* a read-only field sent empty is no write: clients send the whole entity
      IF ls_field-readonly = 'X' OR ls_field-numbering = abap_true.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_value>.
        IF sy-subrc <> 0 OR <lv_value> IS INITIAL.
          CONTINUE.
        ENDIF.
      ENDIF.
      put_field( EXPORTING iv_field = ls_field-name is_from = cs_row
                 CHANGING  cs_line  = <ls_line> ).
    ENDLOOP.

    lr_mapped   = lo_runtime->bo( )->new_response( 'MAPPED' ).
    lr_failed   = lo_runtime->bo( )->new_response( 'FAILED' ).
    lr_reported = lo_runtime->bo( )->new_response( 'REPORTED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    TRY.
        lo_runtime->modify( EXPORTING iv_entity    = ls_entity-name
                                      iv_operation = zcl_osd_rap_runtime=>co_operation-create
                                      it_rows      = <lt_tab>
                            CHANGING  cs_mapped    = <ls_mapped>
                                      cs_failed    = <ls_failed>
                                      cs_reported  = <ls_reported> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).

* the keys the runtime drew (managed numbering) go back to the caller
    ASSIGN COMPONENT ls_entity-response OF STRUCTURE <ls_mapped> TO <lt_mapped>.
    IF sy-subrc = 0.
      READ TABLE <lt_mapped> INDEX 1 ASSIGNING <ls_key>.
      IF sy-subrc = 0.
        put_keys( EXPORTING is_entity = ls_entity is_from = <ls_key>
                  CHANGING  cs_to     = cs_row ).
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~update.
    DATA lo_runtime  TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field    TYPE zif_osd_rap_bo=>ty_field.
    DATA lr_tab      TYPE REF TO data.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    DATA lv_sent     TYPE abap_bool.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lv_value>    TYPE any.
    FIELD-SYMBOLS <lv_current>  TYPE any.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity iv_kind = 'UPDATE' ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    put_keys( EXPORTING is_entity = ls_entity is_from = is_row
              CHANGING  cs_to     = <ls_line> ).
    LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_false.
      READ TABLE it_fields TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
      IF sy-subrc = 0.
        lv_sent = abap_true.
      ELSE.
        lv_sent = abap_false.
      ENDIF.
* PATCH and MERGE change what they give; PUT replaces, so an editable field
* it does not give is written initial, and a read-only one keeps its value
      IF lv_sent = abap_false AND ( iv_replace = abap_false OR ls_field-readonly IS NOT INITIAL ).
        CONTINUE.
      ENDIF.
* a read-only field sent as it is is no write (PUT sends the whole entity);
* sent with another value, the runtime refuses it
      IF ls_field-readonly IS NOT INITIAL.
        UNASSIGN: <lv_value>, <lv_current>.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE is_row TO <lv_value>.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE is_current TO <lv_current>.
        IF <lv_value> IS ASSIGNED AND <lv_current> IS ASSIGNED.
          IF <lv_value> = <lv_current>.
            CONTINUE.
          ENDIF.
        ENDIF.
      ENDIF.
      put_field( EXPORTING iv_field = ls_field-name is_from = is_row
                 CHANGING  cs_line  = <ls_line> ).
    ENDLOOP.

    lr_mapped   = lo_runtime->bo( )->new_response( 'MAPPED' ).
    lr_failed   = lo_runtime->bo( )->new_response( 'FAILED' ).
    lr_reported = lo_runtime->bo( )->new_response( 'REPORTED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    TRY.
        lo_runtime->modify( EXPORTING iv_entity    = ls_entity-name
                                      iv_operation = zcl_osd_rap_runtime=>co_operation-update
                                      it_rows      = <lt_tab>
                            CHANGING  cs_mapped    = <ls_mapped>
                                      cs_failed    = <ls_failed>
                                      cs_reported  = <ls_reported> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~delete.
    DATA lo_runtime  TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lr_tab      TYPE REF TO data.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity iv_kind = 'DELETE' ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    put_keys( EXPORTING is_entity = ls_entity is_from = is_row
              CHANGING  cs_to     = <ls_line> ).

    lr_mapped   = lo_runtime->bo( )->new_response( 'MAPPED' ).
    lr_failed   = lo_runtime->bo( )->new_response( 'FAILED' ).
    lr_reported = lo_runtime->bo( )->new_response( 'REPORTED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    TRY.
        lo_runtime->modify( EXPORTING iv_entity    = ls_entity-name
                                      iv_operation = zcl_osd_rap_runtime=>co_operation-delete
                                      it_rows      = <lt_tab>
                            CHANGING  cs_mapped    = <ls_mapped>
                                      cs_failed    = <ls_failed>
                                      cs_reported  = <ls_reported> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~execute.
    DATA lo_runtime  TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lr_tab      TYPE REF TO data.
    DATA lr_result   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    DATA lt_none     TYPE string_table.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lt_result>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity
                       iv_kind = 'ACTION IMPORT' iv_action = iv_action ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    put_keys( EXPORTING is_entity = ls_entity is_from = is_row
              CHANGING  cs_to     = <ls_line> ).
* an action without a result still needs a table to answer into
    lr_result = lo_runtime->bo( )->new_table( iv_entity = ls_entity-name
                                              iv_kind   = 'ACTION RESULT'
                                              iv_action = iv_action ).
    IF lr_result IS INITIAL.
      GET REFERENCE OF lt_none INTO lr_result.
    ENDIF.
    ASSIGN lr_result->* TO <lt_result>.

    lr_failed   = lo_runtime->bo( )->new_response( 'FAILED' ).
    lr_reported = lo_runtime->bo( )->new_response( 'REPORTED' ).
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    TRY.
        lo_runtime->execute( EXPORTING iv_entity   = ls_entity-name
                                       iv_action   = iv_action
                                       it_keys     = <lt_tab>
                             CHANGING  ct_result   = <lt_result>
                                       cs_failed   = <ls_failed>
                                       cs_reported = <ls_reported> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).
  ENDMETHOD.

ENDCLASS.
