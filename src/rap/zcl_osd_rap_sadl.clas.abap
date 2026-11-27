CLASS zcl_osd_rap_sadl DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The managed RAP runtime behind the SADL data provider (R2c,
* docs/rap-runtime.md, "Serving"). A CDS entity that is the entity of a
* managed behavior definition is written through ZCL_OSD_RAP_RUNTIME --
* field control, numbering, determinations, validations, the save
* sequence -- and is still read through its view by the SADL data provider.
*
* One request is one RAP transaction: MODIFY (or the action), then the save
* sequence. Inside a $batch changeset or atomicity group the save writes
* without COMMIT WORK and the batch ends the LUW (ZCL_OSD_LUW_HOLD=>HELD),
* so a later failing member undoes it. A FAILED row, from the interaction
* phase or from a validation in the save, rolls the transaction back and
* becomes a business exception carrying the RAP messages, which the gateway
* answers with 400; nothing has been written then.
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

* R5: projections (docs/rap-runtime.md, "Projections"). The projection
* entity of the registry (initial when IV_ENTITY is none)
    METHODS projection_of
      IMPORTING
        iv_entity            TYPE csequence
      RETURNING
        VALUE(rs_projection) TYPE zif_osd_rap_registry=>ty_projection.
* an empty row of the base entity (its READ RESULT row)
    METHODS base_line
      IMPORTING
        is_projection TYPE zif_osd_rap_registry=>ty_projection
      RETURNING
        VALUE(rr_row) TYPE REF TO data
      RAISING
        /iwbep/cx_mgw_tech_exception.
* a projection row onto a base row, and back
    METHODS to_base
      IMPORTING
        is_projection TYPE zif_osd_rap_registry=>ty_projection
        is_row        TYPE any
      CHANGING
        cs_base       TYPE any.
    METHODS from_base
      IMPORTING
        is_projection TYPE zif_osd_rap_registry=>ty_projection
        is_base       TYPE any
      CHANGING
        cs_row        TYPE any.
* R10: the augment of a projection's create / update (use ... ( augment )):
* the projection's row and fields, kept while its base runs the operation,
* and run on the base's transaction before the save (AUGMENT_NOW)
    DATA ms_aug_proj   TYPE zif_osd_rap_registry=>ty_projection.
    DATA mr_aug_row    TYPE REF TO data.
    DATA mt_aug_fields TYPE string_table.
    METHODS augment_now
      IMPORTING
        io_runtime TYPE REF TO zcl_osd_rap_runtime
        iv_kind    TYPE csequence
        is_line    TYPE any
      RAISING
        /iwbep/cx_mgw_busi_exception
        /iwbep/cx_mgw_tech_exception.
    METHODS keep_augment
      IMPORTING
        is_projection TYPE zif_osd_rap_registry=>ty_projection
        is_row        TYPE any
        it_fields     TYPE string_table.
* R10: a projection of a draft-enabled BO: the version and flags of a row
    METHODS put_flags
      IMPORTING
        is_from TYPE any
      CHANGING
        cs_to   TYPE any.
* the request's fields named as the base names them; a projection's own
* read-only field is dropped when it is sent unchanged (or empty, on a
* create) and refused otherwise
    METHODS base_fields
      IMPORTING
        is_projection    TYPE zif_osd_rap_registry=>ty_projection
        it_fields        TYPE string_table
        is_row           TYPE any
        is_current       TYPE any OPTIONAL
      RETURNING
        VALUE(rt_fields) TYPE string_table
      RAISING
        /iwbep/cx_mgw_busi_exception.
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
* R8: the version, IsActiveEntity on the wire and %is_draft in the BO
    IF is_entity-draft_table IS INITIAL.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE is_from TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE cs_to TO <lv_to>.
      IF sy-subrc = 0.
        IF <lv_from> IS INITIAL.
          <lv_to> = if_abap_behv=>mk-on.
        ELSE.
          <lv_to> = if_abap_behv=>mk-off.
        ENDIF.
      ENDIF.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE is_from TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE cs_to TO <lv_to>.
      IF sy-subrc = 0.
        IF <lv_from> = if_abap_behv=>mk-on.
          CLEAR <lv_to>.
        ELSE.
          <lv_to> = abap_true.
        ENDIF.
      ENDIF.
    ENDIF.
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
* inside a $batch changeset or atomicity group the batch owns the LUW: the
* save writes, and the group commits it or rolls it back as a whole
        io_runtime->commit( EXPORTING iv_end_luw  = boolc( zcl_osd_luw_hold=>held( ) = abap_false )
                            IMPORTING ev_saved    = lv_saved
                            CHANGING  cs_failed   = cs_failed
                                      cs_reported = cs_reported ).
      CATCH zcx_osd_rap INTO lx_error.
* R7: a failed save has ended the transaction itself; a saver's failure is
* the client's to read (400 with its text), a refused write technical
        IF lx_error->save = abap_false.
          io_runtime->rollback( ).
        ENDIF.
        IF lx_error->business = abap_true.
          refuse( lx_error->get_text( ) ).
        ENDIF.
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
    DATA ls_proj TYPE zif_osd_rap_registry=>ty_projection.
    IF bo_of( iv_entity ) IS NOT INITIAL.
      rv_handles = abap_true.
      RETURN.
    ENDIF.
    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      rv_handles = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD projection_of.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    DATA lv_class    TYPE string.

    lv_class = 'ZCL_OSD_RAP_REGISTRY'.
    TRY.
        CREATE OBJECT li_registry TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RETURN.
    ENDTRY.
    rs_projection = li_registry->projection( iv_entity ).
  ENDMETHOD.

  METHOD base_line.
    DATA li_bo   TYPE REF TO zif_osd_rap_bo.
    DATA lr_rows TYPE REF TO data.
    DATA ls_model  TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA li_source TYPE REF TO zif_stg_cds_source.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.

    li_bo = bo_of( is_projection-base_entity ).
    IF li_bo IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
        EXPORTING
          method = |RAP behavior of { is_projection-base_entity }, the base of { is_projection-entity }|.
    ENDIF.
* R10: the base of a draft projection is served by its union: its row says
* the version (IsActiveEntity), which the base's methods read
    ls_model = li_bo->model( ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY name = is_projection-base_entity.
    IF sy-subrc = 0 AND ls_entity-union IS NOT INITIAL.
      TRY.
          CREATE OBJECT li_source TYPE (ls_entity-union).
          rr_row = li_source->create_line( ).
          RETURN.
        CATCH cx_sy_create_object_error.
          RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception
            EXPORTING
              method = |draft union { ls_entity-union } of { is_projection-base_entity }|.
      ENDTRY.
    ENDIF.
    lr_rows = li_bo->new_rows( is_projection-base_entity ).
    ASSIGN lr_rows->* TO <lt_rows>.
    CREATE DATA rr_row LIKE LINE OF <lt_rows>.
  ENDMETHOD.

  METHOD put_flags.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.
    DATA lt_flags TYPE string_table.
    DATA lv_flag  TYPE string.

    APPEND 'ISACTIVEENTITY' TO lt_flags.
    APPEND 'HASACTIVEENTITY' TO lt_flags.
    APPEND 'HASDRAFTENTITY' TO lt_flags.
    APPEND 'DRAFTUUID' TO lt_flags.
    LOOP AT lt_flags INTO lv_flag.
      ASSIGN COMPONENT lv_flag OF STRUCTURE is_from TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT lv_flag OF STRUCTURE cs_to TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
  ENDMETHOD.

  METHOD keep_augment.
    FIELD-SYMBOLS <ls_row> TYPE any.
    CLEAR: ms_aug_proj, mr_aug_row, mt_aug_fields.
    IF is_projection-augment IS INITIAL.
      RETURN.
    ENDIF.
    ms_aug_proj = is_projection.
    CREATE DATA mr_aug_row LIKE is_row.
    ASSIGN mr_aug_row->* TO <ls_row>.
    <ls_row> = is_row.
    mt_aug_fields = it_fields.
  ENDMETHOD.

  METHOD augment_now.
* R10: the projection's request rows, keyed as the base line, to the augment
    DATA li_augment TYPE REF TO zif_osd_rap_augment.
    DATA lr_tab     TYPE REF TO data.
    DATA ls_proj    TYPE zif_osd_rap_registry=>ty_projection.
    DATA ls_map     TYPE zif_osd_rap_registry=>ty_map.
    DATA lv_field   TYPE string.
    DATA lv_failed  TYPE i.
    DATA lt_msgs    TYPE string_table.
    DATA lv_text    TYPE string.
    DATA lx_error   TYPE REF TO zcx_osd_rap.
    FIELD-SYMBOLS <lt_tab>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>  TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    IF ms_aug_proj-entity IS INITIAL.
      RETURN.
    ENDIF.
    ls_proj = ms_aug_proj.
    CLEAR ms_aug_proj.
    TRY.
        CREATE OBJECT li_augment TYPE (ls_proj-augment).
      CATCH cx_sy_create_object_error.
        RAISE EXCEPTION TYPE /iwbep/cx_mgw_tech_exception EXPORTING method = |augment { ls_proj-augment }|.
    ENDTRY.
    lr_tab = li_augment->new_table( iv_entity = ls_proj-entity iv_kind = iv_kind ).
    IF lr_tab IS INITIAL.
      RETURN.
    ENDIF.
    ASSIGN lr_tab->* TO <lt_tab>.
    APPEND INITIAL LINE TO <lt_tab> ASSIGNING <ls_new>.
    ASSIGN mr_aug_row->* TO <ls_row>.
* the keys, the version and the content ID are the base line's (a created
* instance is named by %cid until the save draws its key)
    LOOP AT ls_proj-fields INTO ls_map.
      ASSIGN COMPONENT ls_map-base OF STRUCTURE is_line TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_map-name OF STRUCTURE <ls_new> TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
    ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE is_line TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE <ls_new> TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDIF.
    ASSIGN COMPONENT '%CID' OF STRUCTURE is_line TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_new> TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDIF.
* the fields of the request, the projection's names (its calculated ones too)
    LOOP AT mt_aug_fields INTO lv_field.
      put_field( EXPORTING iv_field = lv_field is_from = <ls_row> CHANGING cs_line = <ls_new> ).
    ENDLOOP.
    TRY.
        IF iv_kind = 'CREATE'.
          io_runtime->augment( EXPORTING io_augment = li_augment iv_entity = ls_proj-entity ir_create = lr_tab
                               IMPORTING ev_failed = lv_failed et_messages = lt_msgs ).
        ELSE.
          io_runtime->augment( EXPORTING io_augment = li_augment iv_entity = ls_proj-entity ir_update = lr_tab
                               IMPORTING ev_failed = lv_failed et_messages = lt_msgs ).
        ENDIF.
      CATCH zcx_osd_rap INTO lx_error.
        io_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
* the augment's own messages are the answer (RELATING TO is not run, so
* they are not mapped to the request's rows: docs/rap-runtime.md, R10)
    IF lv_failed > 0.
      io_runtime->rollback( ).
      lv_text = concat_lines_of( table = lt_msgs sep = `; ` ).
      IF lv_text IS INITIAL.
        lv_text = |{ ls_proj-alias }: the augment of the { to_lower( iv_kind ) } failed|.
      ENDIF.
      refuse( lv_text ).
    ENDIF.
  ENDMETHOD.

  METHOD to_base.
    DATA ls_map TYPE zif_osd_rap_registry=>ty_map.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    LOOP AT is_projection-fields INTO ls_map.
      ASSIGN COMPONENT ls_map-name OF STRUCTURE is_row TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_map-base OF STRUCTURE cs_base TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
    put_flags( EXPORTING is_from = is_row CHANGING cs_to = cs_base ).
  ENDMETHOD.

  METHOD from_base.
    DATA ls_map TYPE zif_osd_rap_registry=>ty_map.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    LOOP AT is_projection-fields INTO ls_map.
      ASSIGN COMPONENT ls_map-base OF STRUCTURE is_base TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_map-name OF STRUCTURE cs_row TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
    put_flags( EXPORTING is_from = is_base CHANGING cs_to = cs_row ).
  ENDMETHOD.

  METHOD base_fields.
    DATA ls_map   TYPE zif_osd_rap_registry=>ty_map.
    DATA lv_field TYPE string.
    FIELD-SYMBOLS <lv_value>   TYPE any.
    FIELD-SYMBOLS <lv_current> TYPE any.

    LOOP AT it_fields INTO lv_field.
      READ TABLE is_projection-readonly TRANSPORTING NO FIELDS WITH KEY table_line = lv_field.
      IF sy-subrc = 0.
        ASSIGN COMPONENT lv_field OF STRUCTURE is_row TO <lv_value>.
        IF is_current IS SUPPLIED.
          ASSIGN COMPONENT lv_field OF STRUCTURE is_current TO <lv_current>.
          IF <lv_value> = <lv_current>.
            CONTINUE.
          ENDIF.
        ELSEIF <lv_value> IS INITIAL.
          CONTINUE.
        ENDIF.
        refuse( |Field { lv_field } is read-only| ).
      ENDIF.
      READ TABLE is_projection-fields INTO ls_map WITH KEY name = lv_field.
      IF sy-subrc = 0.
        APPEND ls_map-base TO rt_fields.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~create_by.
    DATA lo_runtime  TYPE REF TO zcl_osd_rap_runtime.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_target   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_assoc    TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_field    TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_proj     TYPE zif_osd_rap_registry=>ty_projection.
    DATA ls_child    TYPE zif_osd_rap_registry=>ty_projection.
    DATA lr_parent   TYPE REF TO data.
    DATA lr_child    TYPE REF TO data.
    DATA lt_fields   TYPE string_table.
    DATA lr_tab      TYPE REF TO data.
    DATA lr_mapped   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lv_assoc    TYPE string.
    DATA lx_error    TYPE REF TO zcx_osd_rap.
    FIELD-SYMBOLS <ls_base_parent> TYPE any.
    FIELD-SYMBOLS <ls_base_child>  TYPE any.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lt_target>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>      TYPE any.
    FIELD-SYMBOLS <lv_value>    TYPE any.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.
    FIELD-SYMBOLS <lt_mapped>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_key>      TYPE any.

    lv_assoc = to_upper( iv_assoc ).
* a projection: the parent and the child mapped onto their bases
    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      READ TABLE ls_proj-creates TRANSPORTING NO FIELDS WITH KEY table_line = lv_assoc.
      IF sy-subrc <> 0.
        refuse( |{ ls_proj-alias }: the projection does not use create by association { iv_assoc }| ).
      ENDIF.
      ls_child = projection_of( iv_target ).
      lr_parent = base_line( ls_proj ).
      ASSIGN lr_parent->* TO <ls_base_parent>.
      to_base( EXPORTING is_projection = ls_proj is_row = is_parent CHANGING cs_base = <ls_base_parent> ).
      lr_child = base_line( ls_child ).
      ASSIGN lr_child->* TO <ls_base_child>.
      to_base( EXPORTING is_projection = ls_child is_row = cs_row CHANGING cs_base = <ls_base_child> ).
      lt_fields = base_fields( is_projection = ls_child it_fields = it_fields is_row = cs_row ).
      zif_stg_sadl_behavior~create_by( EXPORTING iv_entity = ls_proj-base_entity iv_assoc = iv_assoc
                                                 is_parent = <ls_base_parent> iv_target = ls_child-base_entity
                                                 it_fields = lt_fields
                                       CHANGING  cs_row    = <ls_base_child> ).
      from_base( EXPORTING is_projection = ls_child is_base = <ls_base_child> CHANGING cs_row = cs_row ).
      RETURN.
    ENDIF.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    READ TABLE ls_entity-assocs INTO ls_assoc WITH KEY name = lv_assoc.
    IF sy-subrc <> 0 OR ls_assoc-create = abap_false.
      refuse( |{ ls_entity-alias }: no create by association { iv_assoc }| ).
    ENDIF.
    ls_model = lo_runtime->bo( )->model( ).
    READ TABLE ls_model-entities INTO ls_target WITH KEY name = ls_assoc-target.
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity iv_kind = 'CREATE BY' iv_action = lv_assoc ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    put_keys( EXPORTING is_entity = ls_entity is_from = is_parent
              CHANGING  cs_to     = <ls_line> ).
    ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_line> TO <lt_target>.
    APPEND INITIAL LINE TO <lt_target> ASSIGNING <ls_new>.
    ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_new> TO <lv_value>.
    IF sy-subrc = 0.
      <lv_value> = 'ODATA'.
    ENDIF.
    LOOP AT ls_target-fields INTO ls_field.
      READ TABLE it_fields TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
* the parent's key is the parent's, whatever the body says
      READ TABLE ls_assoc-pairs TRANSPORTING NO FIELDS WITH KEY target = ls_field-name.
      IF sy-subrc = 0.
        CONTINUE.
      ENDIF.
* a read-only or drawn field sent empty is no write
      IF ls_field-readonly = 'X' OR ls_field-numbering = abap_true.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_value>.
        IF sy-subrc <> 0 OR <lv_value> IS INITIAL.
          CONTINUE.
        ENDIF.
      ENDIF.
      put_field( EXPORTING iv_field = ls_field-name is_from = cs_row
                 CHANGING  cs_line  = <ls_new> ).
    ENDLOOP.

    lr_mapped   = lo_runtime->bo( )->new_response( 'MAPPED' ).
    lr_failed   = lo_runtime->bo( )->new_response( 'FAILED' ).
    lr_reported = lo_runtime->bo( )->new_response( 'REPORTED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    TRY.
        lo_runtime->create_by( EXPORTING iv_entity = ls_entity-name iv_assoc = lv_assoc it_rows = <lt_tab>
                               CHANGING  cs_mapped = <ls_mapped> cs_failed = <ls_failed> cs_reported = <ls_reported> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).

* the child's keys: the parent's and the drawn ones, from MAPPED
    ASSIGN COMPONENT ls_target-response OF STRUCTURE <ls_mapped> TO <lt_mapped>.
    IF sy-subrc = 0.
      READ TABLE <lt_mapped> INDEX 1 ASSIGNING <ls_key>.
      IF sy-subrc = 0.
        put_keys( EXPORTING is_entity = ls_target is_from = <ls_key>
                  CHANGING  cs_to     = cs_row ).
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~draft_source.
* R8: the generated class that serves a draft entity's active and draft rows
    DATA li_bo     TYPE REF TO zif_osd_rap_bo.
    DATA ls_model  TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_name   TYPE string.

    DATA ls_proj   TYPE zif_osd_rap_registry=>ty_projection.

* R10: a projection of a draft-enabled BO has a union of its own
    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      rv_class = ls_proj-union.
      RETURN.
    ENDIF.
    li_bo = bo_of( iv_entity ).
    IF li_bo IS INITIAL.
      RETURN.
    ENDIF.
    ls_model = li_bo->model( ).
    lv_name = to_upper( iv_entity ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY name = lv_name.
    IF sy-subrc = 0.
      rv_class = ls_entity-union.
    ENDIF.
  ENDMETHOD.

  METHOD zif_stg_sadl_behavior~actions.
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA lv_name     TYPE string.

    DATA ls_proj     TYPE zif_osd_rap_registry=>ty_projection.

    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      rt_actions = ls_proj-actions.
      RETURN.
    ENDIF.
    li_bo = bo_of( iv_entity ).
    IF li_bo IS INITIAL.
      RETURN.
    ENDIF.
    ls_model = li_bo->model( ).
    lv_name = to_upper( iv_entity ).
    READ TABLE ls_model-entities INTO ls_entity WITH KEY name = lv_name.
* R6: determine actions too; an internal action is the BO's own
    LOOP AT ls_entity-callables INTO ls_callable WHERE ( kind = 'A' AND internal = abap_false ) OR kind = 'X' OR kind = 'E'.
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
    DATA ls_proj TYPE zif_osd_rap_registry=>ty_projection.
    DATA lr_base TYPE REF TO data.
    DATA lt_base_fields TYPE string_table.
    FIELD-SYMBOLS <ls_base> TYPE any.

    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      IF ls_proj-create = abap_false.
        refuse( |{ ls_proj-alias }: the projection does not use create| ).
      ENDIF.
      lr_base = base_line( ls_proj ).
      ASSIGN lr_base->* TO <ls_base>.
      to_base( EXPORTING is_projection = ls_proj is_row = cs_row CHANGING cs_base = <ls_base> ).
      lt_base_fields = base_fields( is_projection = ls_proj it_fields = it_fields is_row = cs_row ).
      keep_augment( is_projection = ls_proj is_row = cs_row it_fields = it_fields ).
      zif_stg_sadl_behavior~create( EXPORTING iv_entity = ls_proj-base_entity it_fields = lt_base_fields
                                    CHANGING  cs_row    = <ls_base> ).
      from_base( EXPORTING is_projection = ls_proj is_base = <ls_base> CHANGING cs_row = cs_row ).
      RETURN.
    ENDIF.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
* R5: a child is created through its parent's association only
    IF ls_entity-create = abap_false AND ls_entity-parent IS NOT INITIAL.
      refuse( |{ ls_entity-alias } is created through its parent (create by association)| ).
    ENDIF.
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity iv_kind = 'CREATE' ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_value>.
    IF sy-subrc = 0.
      <lv_value> = 'ODATA'.
    ENDIF.
* R8: a POST to the set of a draft-enabled root creates a draft (an active
* instance is made by Activate)
    IF ls_entity-draft_table IS NOT INITIAL.
      ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE <ls_line> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = if_abap_behv=>mk-on.
      ENDIF.
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
* R10: a projection's augment adds to the request before the save
    IF count_failed( is_model = lo_runtime->bo( )->model( ) is_failed = <ls_failed> ) = 0.
      augment_now( io_runtime = lo_runtime iv_kind = 'CREATE' is_line = <ls_line> ).
    ENDIF.
    CLEAR ms_aug_proj.
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
* R10: late numbering -- the key the save drew in place of the preliminary one
    TRY.
        lo_runtime->final_key( EXPORTING iv_entity = ls_entity-name CHANGING cs_row = cs_row ).
      CATCH zcx_osd_rap INTO lx_error.
        technical( lx_error ).
    ENDTRY.
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
    DATA ls_proj TYPE zif_osd_rap_registry=>ty_projection.
    DATA lr_base TYPE REF TO data.
    DATA lr_base_current TYPE REF TO data.
    DATA lt_base_fields TYPE string_table.
    FIELD-SYMBOLS <ls_base> TYPE any.
    FIELD-SYMBOLS <ls_base_current> TYPE any.

    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      IF ls_proj-update = abap_false.
        refuse( |{ ls_proj-alias }: the projection does not use update| ).
      ENDIF.
      lr_base = base_line( ls_proj ).
      ASSIGN lr_base->* TO <ls_base>.
      to_base( EXPORTING is_projection = ls_proj is_row = is_row CHANGING cs_base = <ls_base> ).
      lr_base_current = base_line( ls_proj ).
      ASSIGN lr_base_current->* TO <ls_base_current>.
      to_base( EXPORTING is_projection = ls_proj is_row = is_current CHANGING cs_base = <ls_base_current> ).
      lt_base_fields = base_fields( is_projection = ls_proj it_fields = it_fields is_row = is_row is_current = is_current ).
      keep_augment( is_projection = ls_proj is_row = is_row it_fields = it_fields ).
      zif_stg_sadl_behavior~update( iv_entity = ls_proj-base_entity is_row = <ls_base> is_current = <ls_base_current>
                                    it_fields = lt_base_fields iv_replace = iv_replace ).
      RETURN.
    ENDIF.

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
* R10: a projection's augment adds to the request before the save
    IF count_failed( is_model = lo_runtime->bo( )->model( ) is_failed = <ls_failed> ) = 0.
      augment_now( io_runtime = lo_runtime iv_kind = 'UPDATE' is_line = <ls_line> ).
    ENDIF.
    CLEAR ms_aug_proj.
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

    DATA ls_proj TYPE zif_osd_rap_registry=>ty_projection.
    DATA lr_base TYPE REF TO data.
    DATA lv_discard TYPE abap_bool.
    FIELD-SYMBOLS <ls_base> TYPE any.
    FIELD-SYMBOLS <lv_active> TYPE any.

    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
* R11: a draft's DELETE is its Discard (a used draft action), which a
* projection of a root without delete (the carrier singleton) still serves
      ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE is_row TO <lv_active>.
      IF sy-subrc = 0 AND ls_proj-union IS NOT INITIAL.
        READ TABLE ls_proj-actions TRANSPORTING NO FIELDS WITH KEY table_line = 'DISCARD'.
        IF sy-subrc = 0 AND <lv_active> IS INITIAL.
          lv_discard = abap_true.
        ENDIF.
      ENDIF.
      IF ls_proj-delete = abap_false AND lv_discard = abap_false.
        refuse( |{ ls_proj-alias }: the projection does not use delete| ).
      ENDIF.
      lr_base = base_line( ls_proj ).
      ASSIGN lr_base->* TO <ls_base>.
      to_base( EXPORTING is_projection = ls_proj is_row = is_row CHANGING cs_base = <ls_base> ).
      zif_stg_sadl_behavior~delete( iv_entity = ls_proj-base_entity is_row = <ls_base> ).
      RETURN.
    ENDIF.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
* R8: DELETE of a draft root discards the draft (what Fiori Elements V4
* sends for Discard)
    IF ls_entity-draft_table IS NOT INITIAL AND ls_entity-parent IS INITIAL.
      ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE is_row TO <lv_active>.
      IF sy-subrc = 0 AND <lv_active> IS INITIAL.
        zif_stg_sadl_behavior~execute( iv_entity = iv_entity iv_action = 'DISCARD' is_row = is_row ).
        RETURN.
      ENDIF.
    ENDIF.
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
    DATA lr_mapped   TYPE REF TO data.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA lv_factory  TYPE abap_bool.
    FIELD-SYMBOLS <lt_tab>      TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lt_result>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.
    FIELD-SYMBOLS <ls_mapped>   TYPE any.
    FIELD-SYMBOLS <lt_mapped>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lv_cid>      TYPE any.

    DATA ls_proj TYPE zif_osd_rap_registry=>ty_projection.
    DATA lr_base TYPE REF TO data.
    DATA lr_new  TYPE REF TO data.
    FIELD-SYMBOLS <ls_base> TYPE any.
    FIELD-SYMBOLS <ls_new>  TYPE any.

    DATA lv_action TYPE string.
    ls_proj = projection_of( iv_entity ).
    IF ls_proj-entity IS NOT INITIAL.
      lv_action = to_upper( iv_action ).
      READ TABLE ls_proj-actions TRANSPORTING NO FIELDS WITH KEY table_line = lv_action.
      IF sy-subrc <> 0.
        refuse( |{ ls_proj-alias }: the projection does not use action { iv_action }| ).
      ENDIF.
      lr_base = base_line( ls_proj ).
      ASSIGN lr_base->* TO <ls_base>.
      to_base( EXPORTING is_projection = ls_proj is_row = is_row CHANGING cs_base = <ls_base> ).
      lr_new = base_line( ls_proj ).
      ASSIGN lr_new->* TO <ls_new>.
      zif_stg_sadl_behavior~execute( EXPORTING iv_entity = ls_proj-base_entity iv_action = iv_action is_row = <ls_base>
                                     IMPORTING es_row = <ls_new> ).
      IF <ls_new> IS NOT INITIAL AND es_row IS SUPPLIED.
        from_base( EXPORTING is_projection = ls_proj is_base = <ls_new> CHANGING cs_row = es_row ).
      ENDIF.
      RETURN.
    ENDIF.

    runtime_of( EXPORTING iv_entity  = iv_entity
                IMPORTING eo_runtime = lo_runtime
                          es_entity  = ls_entity ).
    lr_tab = new_line( io_runtime = lo_runtime is_entity = ls_entity
                       iv_kind = 'ACTION IMPORT' iv_action = iv_action ).
    ASSIGN lr_tab->* TO <lt_tab>.
    READ TABLE <lt_tab> INDEX 1 ASSIGNING <ls_line>.
    put_keys( EXPORTING is_entity = ls_entity is_from = is_row
              CHANGING  cs_to     = <ls_line> ).
* R6: a factory action maps its new instance under the %cid of the row
    lv_action = to_upper( iv_action ).
    LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'A' AND name = lv_action AND factory = abap_true.
      lv_factory = abap_true.
    ENDLOOP.
    IF lv_factory = abap_true.
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_cid>.
      IF sy-subrc = 0.
        <lv_cid> = 'OSD-FACTORY'.
      ENDIF.
    ENDIF.
    lr_mapped = lo_runtime->bo( )->new_response( 'MAPPED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
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
                                       cs_reported = <ls_reported>
                                       cs_mapped   = <ls_mapped> ).
      CATCH zcx_osd_rap INTO lx_error.
        lo_runtime->rollback( ).
        technical( lx_error ).
    ENDTRY.
    finish( EXPORTING io_runtime  = lo_runtime
            CHANGING  cs_failed   = <ls_failed>
                      cs_reported = <ls_reported> ).
* R8: Edit answers the draft, Activate the active instance
    LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'E' AND name = lv_action.
      IF es_row IS SUPPLIED.
        READ TABLE <lt_result> INDEX 1 ASSIGNING <ls_line>.
        IF sy-subrc = 0.
          put_keys( EXPORTING is_entity = ls_entity is_from = <ls_line>
                    CHANGING  cs_to     = es_row ).
* R10: Activate of a new draft of a late-numbered entity: the final key
          IF lv_action = 'ACTIVATE'.
            TRY.
                lo_runtime->final_key( EXPORTING iv_entity = ls_entity-name CHANGING cs_row = es_row ).
              CATCH zcx_osd_rap INTO lx_error.
                technical( lx_error ).
            ENDTRY.
          ENDIF.
        ENDIF.
      ENDIF.
      RETURN.
    ENDLOOP.
    IF lv_factory = abap_false OR es_row IS NOT SUPPLIED.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT ls_entity-response OF STRUCTURE <ls_mapped> TO <lt_mapped>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    LOOP AT <lt_mapped> ASSIGNING <ls_line>.
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_cid>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      IF <lv_cid> = 'OSD-FACTORY'.
        put_keys( EXPORTING is_entity = ls_entity is_from = <ls_line>
                  CHANGING  cs_to     = es_row ).
        EXIT.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
