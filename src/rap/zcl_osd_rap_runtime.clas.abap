CLASS zcl_osd_rap_runtime DEFINITION PUBLIC CREATE PRIVATE.
* The managed RAP runtime of one behavior definition (docs/rap-runtime.md):
* a transactional buffer over its instances, with the interaction phase
* (MODIFY, READ, actions) and the save sequence (COMMIT).
*
* It calls the behavior pool directly: determinations, validations and
* actions through the generated adapter (ZIF_OSD_RAP_BO), the saver's phases
* through CL_ABAP_BEHAVIOR_SAVER. A handler written in the system's form
* (FOR DETERMINE / FOR VALIDATE / FOR MODIFY, R3) gets its keys and reads
* and changes the instances with EML, which reaches this runtime while the
* handler runs (ACTIVE) and acts as IN LOCAL MODE: read-only fields may be
* set, and the determinations a change triggers run when the handler has
* returned. A handler written with an ENTITIES table instead changes the
* rows in place, and the runtime takes the changes back into the buffer.
*
* What it does, in the order a request meets it:
*   field control   read-only fields refused, mandatory fields required
*   numbering       a managed key drawn as a UUID on create
*   %cid            mapped back with the key; %cid_ref resolved later
*   determinations  on modify after each request, on save in finalize
*   validations     on save in check_before_save; a FAILED row stops the
*                   save, nothing is written and the LUW is rolled back
*   save            the persistent table written through the BDEF mapping,
*                   then COMMIT WORK and cleanup
*
* The rows of the buffer are the BDEF's derived READ RESULT rows, held as
* data references and addressed by component name; the delta (create,
* update, delete, collapsed) is ZCL_OSD_LUW.

  PUBLIC SECTION.
    TYPES ty_operation TYPE c LENGTH 1.

    CONSTANTS:
      BEGIN OF co_operation,
        create TYPE ty_operation VALUE 'C',
        update TYPE ty_operation VALUE 'U',
        delete TYPE ty_operation VALUE 'D',
      END OF co_operation.

* a runtime for a behavior definition of the generated registry
    CLASS-METHODS for_bdef
      IMPORTING
        iv_bdef           TYPE csequence
      RETURNING
        VALUE(ro_runtime) TYPE REF TO zcl_osd_rap_runtime
      RAISING
        zcx_osd_rap.

* the runtime of a behavior definition whose handler is running, innermost
* first: where EML inside a handler goes (initial when none is running)
    CLASS-METHODS active
      IMPORTING
        iv_bdef           TYPE csequence
      RETURNING
        VALUE(ro_runtime) TYPE REF TO zcl_osd_rap_runtime.

* a runtime over a given adapter
    CLASS-METHODS for_bo
      IMPORTING
        io_bo             TYPE REF TO zif_osd_rap_bo
      RETURNING
        VALUE(ro_runtime) TYPE REF TO zcl_osd_rap_runtime.

* create, update or delete instances. IT_ROWS is a TABLE FOR CREATE, UPDATE
* or DELETE of the entity (name or alias); the responses are the BDEF's
* RESPONSE FOR MAPPED / FAILED / REPORTED EARLY structures
    METHODS modify
      IMPORTING
        iv_entity    TYPE csequence
        iv_operation TYPE ty_operation
        it_rows      TYPE ANY TABLE
      CHANGING
        cs_mapped    TYPE any
        cs_failed    TYPE any
        cs_reported  TYPE any
      RAISING
        zcx_osd_rap.

* read instances through the buffer. IT_KEYS: rows with the key fields (a
* TABLE FOR READ IMPORT); CT_RESULT: a TABLE FOR READ RESULT
    METHODS read
      IMPORTING
        iv_entity TYPE csequence
        it_keys   TYPE ANY TABLE
      CHANGING
        ct_result TYPE STANDARD TABLE
        cs_failed TYPE any
      RAISING
        zcx_osd_rap.

* execute an instance action. IT_KEYS: a TABLE FOR ACTION IMPORT;
* CT_RESULT: a TABLE FOR ACTION RESULT
    METHODS execute
      IMPORTING
        iv_entity   TYPE csequence
        iv_action   TYPE csequence
        it_keys     TYPE STANDARD TABLE
      CHANGING
        ct_result   TYPE STANDARD TABLE
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* the save sequence. EV_SAVED is false when finalize or check_before_save
* failed: then nothing is written, the LUW is rolled back and the buffer is
* kept, so the caller can correct it or ROLLBACK. IV_END_LUW false: the
* save writes but neither commits nor rolls back, because an enclosing owner
* holds the LUW (a $batch changeset or atomicity group) and ends it
    METHODS commit
      IMPORTING
        iv_end_luw  TYPE abap_bool DEFAULT abap_true
      EXPORTING
        ev_saved    TYPE abap_bool
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* forget the buffer without writing it
    METHODS rollback.

* the behavior definition this runtime runs
    METHODS bo
      RETURNING
        VALUE(ri_bo) TYPE REF TO zif_osd_rap_bo.

* what ran, in order: phases, determinations, validations and actions
    METHODS trace
      RETURNING
        VALUE(rt_trace) TYPE string_table.

* how many changes the buffer holds
    METHODS pending
      RETURNING
        VALUE(rv_count) TYPE i.

  PROTECTED SECTION.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_inst,
        entity      TYPE string,
        key         TYPE string,
        cid         TYPE string,
        row         TYPE REF TO data,
        state       TYPE ty_operation,
        created     TYPE abap_bool,
        updated     TYPE abap_bool,
        fields      TYPE string_table,
        req_created TYPE abap_bool,
        req_updated TYPE abap_bool,
        req_fields  TYPE string_table,
      END OF ty_inst,
      tt_inst TYPE STANDARD TABLE OF ty_inst WITH DEFAULT KEY.

    TYPES:
      BEGIN OF ty_handler,
        name    TYPE string,
        handler TYPE REF TO object,
      END OF ty_handler,
      tt_handler TYPE STANDARD TABLE OF ty_handler WITH DEFAULT KEY.

    DATA mo_bo TYPE REF TO zif_osd_rap_bo.
    DATA ms_model TYPE zif_osd_rap_bo=>ty_model.
    DATA mi_luw TYPE REF TO zif_osd_luw.
    DATA mt_inst TYPE tt_inst.
    DATA mt_handler TYPE tt_handler.
    DATA mo_saver TYPE REF TO cl_abap_behavior_saver.
    DATA mt_trace TYPE string_table.
    DATA mt_done TYPE string_table.
* handlers of this runtime running now: the modifications they make are
* local (IN LOCAL MODE) and inside the request that called them
    DATA mv_depth TYPE i.
    CLASS-DATA gt_active TYPE STANDARD TABLE OF REF TO zcl_osd_rap_runtime WITH DEFAULT KEY.

    METHODS entity_of
      IMPORTING
        iv_entity        TYPE csequence
      RETURNING
        VALUE(rs_entity) TYPE zif_osd_rap_bo=>ty_entity
      RAISING
        zcx_osd_rap.

    METHODS new_row
      IMPORTING
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
      RETURNING
        VALUE(rr_row) TYPE REF TO data.

    METHODS key_of
      IMPORTING
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
        is_row        TYPE any
      RETURNING
        VALUE(rv_key) TYPE string.

    METHODS copy_keys
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        is_from   TYPE any
      CHANGING
        cs_to     TYPE any.

    METHODS control_on
      IMPORTING
        is_row       TYPE any
        iv_field     TYPE string
      RETURNING
        VALUE(rv_on) TYPE abap_bool.

    METHODS text_of
      IMPORTING
        is_row         TYPE any
        iv_component   TYPE string
      RETURNING
        VALUE(rv_text) TYPE string.

    METHODS index_of
      IMPORTING
        iv_entity       TYPE string
        iv_key          TYPE string
      RETURNING
        VALUE(rv_index) TYPE i.

    METHODS resolve
      IMPORTING
        is_entity       TYPE zif_osd_rap_bo=>ty_entity
        is_input        TYPE any
      RETURNING
        VALUE(rv_index) TYPE i
      RAISING
        zcx_osd_rap.

    METHODS select_row
      IMPORTING
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
        is_keys       TYPE any
      RETURNING
        VALUE(rr_row) TYPE REF TO data
      RAISING
        zcx_osd_rap.

    METHODS table_row
      IMPORTING
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
        is_keys       TYPE any
      RETURNING
        VALUE(rr_line) TYPE REF TO data
      RAISING
        zcx_osd_rap.

    METHODS source_of
      IMPORTING
        is_entity        TYPE zif_osd_rap_bo=>ty_entity
      RETURNING
        VALUE(ri_source) TYPE REF TO zif_stg_cds_source
      RAISING
        zcx_osd_rap.

    METHODS fail
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_input    TYPE any
        iv_cause    TYPE if_abap_behv=>t_fail_cause
        iv_text     TYPE string
        iv_field    TYPE string OPTIONAL
        iv_op       TYPE string OPTIONAL
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any.

    METHODS check_fields
      IMPORTING
        is_entity    TYPE zif_osd_rap_bo=>ty_entity
        is_input     TYPE any
        iv_operation TYPE ty_operation
      EXPORTING
        ev_ok        TYPE abap_bool
      CHANGING
        cs_failed    TYPE any
        cs_reported  TYPE any.

    METHODS create_one
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_input    TYPE any
      CHANGING
        cs_mapped   TYPE any
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS update_one
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_input    TYPE any
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS delete_one
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_input    TYPE any
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS mark
      IMPORTING
        iv_index TYPE i
        iv_field TYPE string.

    METHODS start_request.

    METHODS triggered
      IMPORTING
        is_callable  TYPE zif_osd_rap_bo=>ty_callable
        is_inst      TYPE ty_inst
      RETURNING
        VALUE(rv_on) TYPE abap_bool.

    METHODS determine
      IMPORTING
        iv_on       TYPE zif_osd_rap_bo=>ty_flag
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS validate
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS invoke
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_callable TYPE zif_osd_rap_bo=>ty_callable
        ir_rows     TYPE REF TO data
        ir_keys     TYPE REF TO data OPTIONAL
        ir_result   TYPE REF TO data OPTIONAL
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS take_back
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        ir_rows   TYPE REF TO data.

    METHODS handler_of
      IMPORTING
        is_entity         TYPE zif_osd_rap_bo=>ty_entity
      RETURNING
        VALUE(ro_handler) TYPE REF TO object
      RAISING
        zcx_osd_rap.

    METHODS saver
      RETURNING
        VALUE(ro_saver) TYPE REF TO cl_abap_behavior_saver
      RAISING
        zcx_osd_rap.

    METHODS count_failed
      IMPORTING
        is_failed       TYPE any
      RETURNING
        VALUE(rv_count) TYPE i.

    METHODS persist
      RAISING
        zcx_osd_rap.

    METHODS done
      IMPORTING
        iv_mark        TYPE string
      RETURNING
        VALUE(rv_done) TYPE abap_bool.
ENDCLASS.



CLASS zcl_osd_rap_runtime IMPLEMENTATION.

  METHOD for_bdef.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA lv_class    TYPE string.

* by name: without behavior definitions the registry is not generated
    lv_class = 'ZCL_OSD_RAP_REGISTRY'.
    TRY.
        CREATE OBJECT li_registry TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no RAP registry: no behavior definition was generated|.
    ENDTRY.
    li_bo = li_registry->get( iv_bdef ).
    IF li_bo IS INITIAL.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |unknown behavior definition { iv_bdef }|.
    ENDIF.
    ro_runtime = for_bo( li_bo ).
  ENDMETHOD.

  METHOD active.
    DATA lv_bdef  TYPE string.
    DATA lv_index TYPE i.
    DATA lo_rap   TYPE REF TO zcl_osd_rap_runtime.

    lv_bdef = to_upper( iv_bdef ).
    lv_index = lines( gt_active ).
    WHILE lv_index > 0.
      READ TABLE gt_active INDEX lv_index INTO lo_rap.
      IF to_upper( lo_rap->ms_model-bdef ) = lv_bdef.
        ro_runtime = lo_rap.
        RETURN.
      ENDIF.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD for_bo.
    CREATE OBJECT ro_runtime.
    ro_runtime->mo_bo = io_bo.
    ro_runtime->ms_model = io_bo->model( ).
    CREATE OBJECT ro_runtime->mi_luw TYPE zcl_osd_luw.
  ENDMETHOD.

  METHOD entity_of.
    DATA lv_name TYPE string.
    lv_name = to_upper( iv_entity ).
    LOOP AT ms_model-entities INTO rs_entity.
      IF rs_entity-name = lv_name OR to_upper( rs_entity-alias ) = lv_name.
        RETURN.
      ENDIF.
    ENDLOOP.
    RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ms_model-bdef } has no entity { iv_entity }|.
  ENDMETHOD.

  METHOD new_row.
    DATA lr_rows TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.

    lr_rows = mo_bo->new_rows( is_entity-name ).
    ASSIGN lr_rows->* TO <lt_rows>.
    CREATE DATA rr_row LIKE LINE OF <lt_rows>.
  ENDMETHOD.

  METHOD key_of.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_text  TYPE string.

* each component as <length>:<text>, so no separator inside a value can
* make two different key tuples one string
    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      lv_text = text_of( is_row = is_row iv_component = ls_field-name ).
      rv_key = rv_key && |{ strlen( lv_text ) }:{ lv_text }|.
    ENDLOOP.
  ENDMETHOD.

  METHOD text_of.
    FIELD-SYMBOLS <lv_value> TYPE any.
    ASSIGN COMPONENT iv_component OF STRUCTURE is_row TO <lv_value>.
    IF sy-subrc = 0.
      rv_text = <lv_value>.
    ENDIF.
  ENDMETHOD.

  METHOD copy_keys.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE is_from TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_to TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
  ENDMETHOD.

  METHOD control_on.
    FIELD-SYMBOLS <ls_control> TYPE any.
    FIELD-SYMBOLS <lv_flag>    TYPE any.

    ASSIGN COMPONENT '%CONTROL' OF STRUCTURE is_row TO <ls_control>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT iv_field OF STRUCTURE <ls_control> TO <lv_flag>.
    IF sy-subrc = 0 AND <lv_flag> IS NOT INITIAL.
      rv_on = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD index_of.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    LOOP AT mt_inst ASSIGNING <ls_inst>.
      IF <ls_inst>-entity = iv_entity AND <ls_inst>-key = iv_key.
        rv_index = sy-tabix.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD resolve.
* an instance by %cid_ref (an instance created earlier in this transaction)
* or by its key, from the buffer or else from the database. 0 when there is
* none, or it was deleted
    DATA lv_cid  TYPE string.
    DATA lv_key  TYPE string.
    DATA lr_row  TYPE REF TO data.
    DATA ls_inst TYPE ty_inst.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.

    lv_cid = text_of( is_row = is_input iv_component = '%CID_REF' ).
    IF lv_cid IS NOT INITIAL.
      LOOP AT mt_inst ASSIGNING <ls_inst> WHERE entity = is_entity-name AND cid = lv_cid.
        rv_index = sy-tabix.
      ENDLOOP.
    ELSE.
      lv_key = key_of( is_entity = is_entity is_row = is_input ).
      rv_index = index_of( iv_entity = is_entity-name iv_key = lv_key ).
      IF rv_index = 0.
        lr_row = select_row( is_entity = is_entity is_keys = is_input ).
        IF lr_row IS NOT INITIAL.
          ls_inst-entity = is_entity-name.
          ls_inst-key    = lv_key.
          ls_inst-row    = lr_row.
          APPEND ls_inst TO mt_inst.
          rv_index = lines( mt_inst ).
        ENDIF.
      ENDIF.
    ENDIF.

    IF rv_index > 0.
      READ TABLE mt_inst INDEX rv_index ASSIGNING <ls_inst>.
      IF <ls_inst>-state = co_operation-delete.
        rv_index = 0.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD source_of.
    TRY.
        CREATE OBJECT ri_source TYPE (is_entity-source).
      CATCH cx_sy_create_object_error.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no table class { is_entity-source } for { is_entity-table }|.
    ENDTRY.
  ENDMETHOD.

  METHOD table_row.
* one row of the persistent table by the entity's key, as the table has it
    DATA li_source TYPE REF TO zif_stg_cds_source.
    DATA lr_data   TYPE REF TO data.
    DATA lt_order  TYPE string_table.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_where  TYPE string.
    DATA lv_value  TYPE string.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_data> TYPE any.
    FIELD-SYMBOLS <ls_line> TYPE any.

    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      lv_value = text_of( is_row = is_keys iv_component = ls_field-name ).
      REPLACE ALL OCCURRENCES OF `'` IN lv_value WITH `''`.
      IF lv_where IS NOT INITIAL.
        lv_where = lv_where && ` AND `.
      ENDIF.
      lv_where = lv_where && ls_field-column && ` = '` && lv_value && `'`.
    ENDLOOP.

    li_source = source_of( is_entity ).
    lr_data = li_source->read( iv_where = lv_where it_orderby = lt_order ).
    ASSIGN lr_data->* TO <lt_data>.
    READ TABLE <lt_data> INDEX 1 ASSIGNING <ls_data>.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    rr_line = li_source->create_line( ).
    ASSIGN rr_line->* TO <ls_line>.
    <ls_line> = <ls_data>.
  ENDMETHOD.

  METHOD select_row.
* one instance of the persistent table, mapped to the entity's fields
    DATA lr_line  TYPE REF TO data.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <ls_data> TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    lr_line = table_row( is_entity = is_entity is_keys = is_keys ).
    IF lr_line IS INITIAL.
      RETURN.
    ENDIF.
    ASSIGN lr_line->* TO <ls_data>.

    rr_row = new_row( is_entity ).
    ASSIGN rr_row->* TO <ls_row>.
    LOOP AT is_entity-fields INTO ls_field.
      ASSIGN COMPONENT ls_field-column OF STRUCTURE <ls_data> TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
  ENDMETHOD.

  METHOD fail.
* a FAILED row (key, %cid, %fail-cause, the operation) and a REPORTED row
* with the message and, for field control, the %element
    DATA lo_message TYPE REF TO zcl_osd_rap_message.
    DATA lv_cid     TYPE string.
    FIELD-SYMBOLS <lt_failed>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_reported> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>     TYPE any.
    FIELD-SYMBOLS <lv_value>    TYPE any.
    FIELD-SYMBOLS <ls_group>    TYPE any.

    lv_cid = text_of( is_row = is_input iv_component = '%CID' ).
    IF lv_cid IS INITIAL.
      lv_cid = text_of( is_row = is_input iv_component = '%CID_REF' ).
    ENDIF.

    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_failed TO <lt_failed>.
    IF sy-subrc = 0.
      APPEND INITIAL LINE TO <lt_failed> ASSIGNING <ls_line>.
      copy_keys( EXPORTING is_entity = is_entity is_from = is_input CHANGING cs_to = <ls_line> ).
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = lv_cid.
      ENDIF.
      ASSIGN COMPONENT '%FAIL' OF STRUCTURE <ls_line> TO <ls_group>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'CAUSE' OF STRUCTURE <ls_group> TO <lv_value>.
        <lv_value> = iv_cause.
      ENDIF.
      IF iv_op IS NOT INITIAL.
        ASSIGN COMPONENT '%OP' OF STRUCTURE <ls_line> TO <ls_group>.
        IF sy-subrc = 0.
          ASSIGN COMPONENT iv_op OF STRUCTURE <ls_group> TO <lv_value>.
          IF sy-subrc = 0.
            <lv_value> = if_abap_behv=>mk-on.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDIF.

    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_reported TO <lt_reported>.
    IF sy-subrc = 0.
      APPEND INITIAL LINE TO <lt_reported> ASSIGNING <ls_line>.
      copy_keys( EXPORTING is_entity = is_entity is_from = is_input CHANGING cs_to = <ls_line> ).
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_line> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = lv_cid.
      ENDIF.
      lo_message = zcl_osd_rap_message=>with_text(
        iv_severity = if_abap_behv_message=>severity-error
        iv_text     = iv_text ).
      ASSIGN COMPONENT '%MSG' OF STRUCTURE <ls_line> TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = lo_message.
      ENDIF.
      IF iv_field IS NOT INITIAL.
        ASSIGN COMPONENT '%ELEMENT' OF STRUCTURE <ls_line> TO <ls_group>.
        IF sy-subrc = 0.
          ASSIGN COMPONENT iv_field OF STRUCTURE <ls_group> TO <lv_value>.
          IF sy-subrc = 0.
            <lv_value> = if_abap_behv=>mk-on.
          ENDIF.
        ENDIF.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD check_fields.
* field control of an external modify: a read-only field may not be given,
* a mandatory one must be given and not be initial. Keys identify the
* instance on update and are not checked there
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_on    TYPE abap_bool.
    DATA lv_op    TYPE string.
    FIELD-SYMBOLS <lv_value> TYPE any.

    ev_ok = abap_true.
    IF iv_operation = co_operation-create.
      lv_op = '%CREATE'.
    ELSE.
      lv_op = '%UPDATE'.
    ENDIF.

    LOOP AT is_entity-fields INTO ls_field.
      IF iv_operation = co_operation-update AND ls_field-key = abap_true.
        CONTINUE.
      ENDIF.
      lv_on = control_on( is_row = is_input iv_field = ls_field-name ).

* a handler's own change (IN LOCAL MODE) may set a read-only field
      IF lv_on = abap_true AND mv_depth = 0
          AND ( ls_field-readonly = 'X'
          OR ( ls_field-readonly = 'U' AND iv_operation = co_operation-update ) ).
        fail( EXPORTING is_entity = is_entity is_input = is_input
                        iv_cause = if_abap_behv=>cause-readonly
                        iv_text = |Field { ls_field-name } is read-only|
                        iv_field = ls_field-name iv_op = lv_op
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        ev_ok = abap_false.
        RETURN.
      ENDIF.

      IF ls_field-mandatory = 'X'
          OR ( ls_field-mandatory = 'C' AND iv_operation = co_operation-create ).
        IF iv_operation = co_operation-update AND lv_on = abap_false.
          CONTINUE.
        ENDIF.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE is_input TO <lv_value>.
        IF lv_on = abap_false OR <lv_value> IS INITIAL.
          fail( EXPORTING is_entity = is_entity is_input = is_input
                          iv_cause = if_abap_behv=>cause-unspecific
                          iv_text = |Field { ls_field-name } is mandatory|
                          iv_field = ls_field-name iv_op = lv_op
                CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
          ev_ok = abap_false.
          RETURN.
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD mark.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    READ TABLE mt_inst INDEX iv_index ASSIGNING <ls_inst>.
    READ TABLE <ls_inst>-fields TRANSPORTING NO FIELDS WITH KEY table_line = iv_field.
    IF sy-subrc <> 0.
      APPEND iv_field TO <ls_inst>-fields.
    ENDIF.
    READ TABLE <ls_inst>-req_fields TRANSPORTING NO FIELDS WITH KEY table_line = iv_field.
    IF sy-subrc <> 0.
      APPEND iv_field TO <ls_inst>-req_fields.
    ENDIF.
  ENDMETHOD.

  METHOD create_one.
    DATA lr_row   TYPE REF TO data.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_inst  TYPE ty_inst.
    DATA lv_index TYPE i.
    DATA lv_x16   TYPE x LENGTH 16.
    DATA lv_ok    TYPE abap_bool.
    DATA lv_cid   TYPE string.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lv_from>   TYPE any.
    FIELD-SYMBOLS <lv_to>     TYPE any.
    FIELD-SYMBOLS <lt_mapped> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_mapped> TYPE any.

    check_fields( EXPORTING is_entity = is_entity is_input = is_input iv_operation = co_operation-create
                  IMPORTING ev_ok = lv_ok
                  CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

* a content ID names one instance of the transaction; a second create with
* it would make every later %cid_ref ambiguous
    lv_cid = text_of( is_row = is_input iv_component = '%CID' ).
    IF lv_cid IS NOT INITIAL.
      READ TABLE mt_inst TRANSPORTING NO FIELDS WITH KEY entity = is_entity-name cid = lv_cid.
      IF sy-subrc = 0.
        fail( EXPORTING is_entity = is_entity is_input = is_input
                        iv_cause = if_abap_behv=>cause-conflict
                        iv_text = |Content ID { lv_cid } is already used|
                        iv_op = '%CREATE'
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        RETURN.
      ENDIF.
    ENDIF.

    lr_row = new_row( is_entity ).
    ASSIGN lr_row->* TO <ls_row>.
    LOOP AT is_entity-fields INTO ls_field.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
      IF ls_field-numbering = abap_true.
        TRY.
            lv_x16 = cl_system_uuid=>create_uuid_x16_static( ).
          CATCH cx_uuid_error.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no UUID for { is_entity-name }|.
        ENDTRY.
        <lv_to> = lv_x16.
      ELSEIF ls_field-key = abap_true OR control_on( is_row = is_input iv_field = ls_field-name ) = abap_true.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE is_input TO <lv_from>.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDLOOP.

    ls_inst-entity = is_entity-name.
    ls_inst-key    = key_of( is_entity = is_entity is_row = <ls_row> ).
    lv_index = index_of( iv_entity = is_entity-name iv_key = ls_inst-key ).
    IF lv_index > 0.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      IF ls_inst-state <> co_operation-delete.
        lv_index = -1.
      ENDIF.
    ELSEIF select_row( is_entity = is_entity is_keys = <ls_row> ) IS NOT INITIAL.
      lv_index = -1.
    ENDIF.
    IF lv_index < 0.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-conflict
                      iv_text = |{ is_entity-alias } { ls_inst-key } already exists|
                      iv_op = '%CREATE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.

    CLEAR ls_inst.
    ls_inst-entity      = is_entity-name.
    ls_inst-key         = key_of( is_entity = is_entity is_row = <ls_row> ).
    ls_inst-cid         = text_of( is_row = is_input iv_component = '%CID' ).
    ls_inst-row         = lr_row.
    ls_inst-state       = co_operation-create.
    ls_inst-created     = abap_true.
    ls_inst-req_created = abap_true.
    IF lv_index > 0.
      MODIFY mt_inst INDEX lv_index FROM ls_inst.
    ELSE.
      APPEND ls_inst TO mt_inst.
      lv_index = lines( mt_inst ).
    ENDIF.
    LOOP AT is_entity-fields INTO ls_field.
      IF control_on( is_row = is_input iv_field = ls_field-name ) = abap_true OR ls_field-numbering = abap_true.
        mark( iv_index = lv_index iv_field = ls_field-name ).
      ENDIF.
    ENDLOOP.
    mi_luw->modify( iv_entity = is_entity-name iv_key = ls_inst-key
                    iv_operation = co_operation-create ir_row = lr_row ).

    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_mapped TO <lt_mapped>.
    IF sy-subrc = 0.
      APPEND INITIAL LINE TO <lt_mapped> ASSIGNING <ls_mapped>.
      copy_keys( EXPORTING is_entity = is_entity is_from = <ls_row> CHANGING cs_to = <ls_mapped> ).
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_mapped> TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = ls_inst-cid.
      ENDIF.
    ENDIF.
  ENDMETHOD.

  METHOD update_one.
    DATA lv_index TYPE i.
    DATA lv_ok    TYPE abap_bool.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    lv_index = resolve( is_entity = is_entity is_input = is_input ).
    IF lv_index = 0.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-not_found
                      iv_text = |{ is_entity-alias } not found| iv_op = '%UPDATE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    check_fields( EXPORTING is_entity = is_entity is_input = is_input iv_operation = co_operation-update
                  IMPORTING ev_ok = lv_ok
                  CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    ASSIGN <ls_inst>-row->* TO <ls_row>.
    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_false.
      IF control_on( is_row = is_input iv_field = ls_field-name ) = abap_false.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE is_input TO <lv_from>.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
      <lv_to> = <lv_from>.
      mark( iv_index = lv_index iv_field = ls_field-name ).
    ENDLOOP.
    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    IF <ls_inst>-state IS INITIAL.
      <ls_inst>-state = co_operation-update.
    ENDIF.
    <ls_inst>-updated = abap_true.
    <ls_inst>-req_updated = abap_true.
    mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                    iv_operation = co_operation-update ir_row = <ls_inst>-row ).
  ENDMETHOD.

  METHOD delete_one.
    DATA lv_index TYPE i.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.

    lv_index = resolve( is_entity = is_entity is_input = is_input ).
    IF lv_index = 0.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-not_found
                      iv_text = |{ is_entity-alias } not found| iv_op = '%DELETE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    <ls_inst>-state = co_operation-delete.
    mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                    iv_operation = co_operation-delete ir_row = <ls_inst>-row ).
  ENDMETHOD.

  METHOD start_request.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    LOOP AT mt_inst ASSIGNING <ls_inst>.
      CLEAR: <ls_inst>-req_created, <ls_inst>-req_updated, <ls_inst>-req_fields.
    ENDLOOP.
    CLEAR mt_done.
  ENDMETHOD.

  METHOD modify.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    FIELD-SYMBOLS <ls_input> TYPE any.

    ls_entity = entity_of( iv_entity ).
    CASE iv_operation.
      WHEN co_operation-create.
        IF ls_entity-create = abap_false.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no create|.
        ENDIF.
      WHEN co_operation-update.
        IF ls_entity-update = abap_false.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no update|.
        ENDIF.
      WHEN co_operation-delete.
        IF ls_entity-delete = abap_false.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no delete|.
        ENDIF.
      WHEN OTHERS.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |unknown operation { iv_operation }|.
    ENDCASE.

* inside a handler the request is the caller's: its determinations run
* when the handler has returned
    IF mv_depth = 0.
      start_request( ).
    ENDIF.
    LOOP AT it_rows ASSIGNING <ls_input>.
      CASE iv_operation.
        WHEN co_operation-create.
          create_one( EXPORTING is_entity = ls_entity is_input = <ls_input>
                      CHANGING cs_mapped = cs_mapped cs_failed = cs_failed cs_reported = cs_reported ).
        WHEN co_operation-update.
          update_one( EXPORTING is_entity = ls_entity is_input = <ls_input>
                      CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        WHEN OTHERS.
          delete_one( EXPORTING is_entity = ls_entity is_input = <ls_input>
                      CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      ENDCASE.
    ENDLOOP.

    IF mv_depth = 0.
      determine( EXPORTING iv_on = 'M' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.
  ENDMETHOD.

  METHOD read.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_index  TYPE i.
    DATA ls_inst   TYPE ty_inst.
    DATA lr_reported TYPE REF TO data.
    FIELD-SYMBOLS <ls_key> TYPE any.
    FIELD-SYMBOLS <ls_row> TYPE any.
    FIELD-SYMBOLS <ls_out> TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    ls_entity = entity_of( iv_entity ).
* READ answers FAILED only; the message of a missing instance is dropped
    lr_reported = mo_bo->new_response( 'REPORTED' ).
    ASSIGN lr_reported->* TO <ls_reported>.
    LOOP AT it_keys ASSIGNING <ls_key>.
      lv_index = resolve( is_entity = ls_entity is_input = <ls_key> ).
      IF lv_index = 0.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-not_found
                        iv_text = |{ ls_entity-alias } not found|
              CHANGING cs_failed = cs_failed cs_reported = <ls_reported> ).
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_row>.
      APPEND INITIAL LINE TO ct_result ASSIGNING <ls_out>.
      MOVE-CORRESPONDING <ls_row> TO <ls_out>.
    ENDLOOP.
  ENDMETHOD.

  METHOD execute.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA lv_name     TYPE string.
    DATA lv_index    TYPE i.
    DATA lv_found    TYPE abap_bool.
    DATA ls_inst     TYPE ty_inst.
    DATA lr_rows     TYPE REF TO data.
    DATA lr_keys     TYPE REF TO data.
    DATA lr_result   TYPE REF TO data.
    FIELD-SYMBOLS <ls_key>  TYPE any.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_keys> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>  TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    ls_entity = entity_of( iv_entity ).
    lv_name = to_upper( iv_action ).
    LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'A' AND name = lv_name.
      lv_found = abap_true.
    ENDLOOP.
    IF lv_found = abap_false.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no action { iv_action }|.
    ENDIF.

    IF mv_depth = 0.
      start_request( ).
    ENDIF.
    lr_rows = mo_bo->new_rows( ls_entity-name ).
    ASSIGN lr_rows->* TO <lt_rows>.
    CREATE DATA lr_keys LIKE it_keys.
    ASSIGN lr_keys->* TO <lt_keys>.
    LOOP AT it_keys ASSIGNING <ls_key>.
      lv_index = resolve( is_entity = ls_entity is_input = <ls_key> ).
      IF lv_index = 0.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-not_found
                        iv_text = |{ ls_entity-alias } not found|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_row>.
      APPEND <ls_row> TO <lt_rows>.
* the handler sees the key also where the caller gave a %cid_ref
      APPEND <ls_key> TO <lt_keys> ASSIGNING <ls_new>.
      copy_keys( EXPORTING is_entity = ls_entity is_from = <ls_row> CHANGING cs_to = <ls_new> ).
    ENDLOOP.
    IF lines( <lt_rows> ) = 0.
      RETURN.
    ENDIF.

    GET REFERENCE OF ct_result INTO lr_result.
    invoke( EXPORTING is_entity = ls_entity is_callable = ls_callable
                      ir_rows = lr_rows ir_keys = lr_keys ir_result = lr_result
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF mv_depth = 0.
      determine( EXPORTING iv_on = 'M' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.
  ENDMETHOD.

  METHOD triggered.
    DATA lv_field TYPE string.
    DATA lv_created TYPE abap_bool.
    DATA lv_updated TYPE abap_bool.

    IF is_inst-state = co_operation-delete.
      RETURN.
    ENDIF.
    IF is_callable-on = 'M'.
      lv_created = is_inst-req_created.
      lv_updated = is_inst-req_updated.
    ELSE.
      lv_created = is_inst-created.
      lv_updated = is_inst-updated.
    ENDIF.
    IF ( is_callable-on_create = abap_true AND lv_created = abap_true )
        OR ( is_callable-on_update = abap_true AND lv_updated = abap_true AND lv_created = abap_false ).
      rv_on = abap_true.
      RETURN.
    ENDIF.
    LOOP AT is_callable-fields INTO lv_field.
      IF is_callable-on = 'M'.
        READ TABLE is_inst-req_fields TRANSPORTING NO FIELDS WITH KEY table_line = lv_field.
      ELSE.
        READ TABLE is_inst-fields TRANSPORTING NO FIELDS WITH KEY table_line = lv_field.
      ENDIF.
      IF sy-subrc = 0.
        rv_on = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD done.
* each determination runs once per instance per request (on modify) or per
* save (on save), so two determinations that trigger each other end
    READ TABLE mt_done TRANSPORTING NO FIELDS WITH KEY table_line = iv_mark.
    IF sy-subrc = 0.
      rv_done = abap_true.
      RETURN.
    ENDIF.
    APPEND iv_mark TO mt_done.
  ENDMETHOD.

  METHOD determine.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA ls_inst     TYPE ty_inst.
    DATA lr_rows     TYPE REF TO data.
    DATA lv_ran      TYPE abap_bool.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    DO 20 TIMES.
      lv_ran = abap_false.
      LOOP AT ms_model-entities INTO ls_entity.
        LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'D' AND on = iv_on.
          lr_rows = mo_bo->new_rows( ls_entity-name ).
          ASSIGN lr_rows->* TO <lt_rows>.
          LOOP AT mt_inst INTO ls_inst WHERE entity = ls_entity-name.
            IF triggered( is_callable = ls_callable is_inst = ls_inst ) = abap_false
                OR done( |{ iv_on } { ls_callable-name } { ls_inst-key }| ) = abap_true.
              CONTINUE.
            ENDIF.
            ASSIGN ls_inst-row->* TO <ls_row>.
            APPEND <ls_row> TO <lt_rows>.
          ENDLOOP.
          IF lines( <lt_rows> ) > 0.
            invoke( EXPORTING is_entity = ls_entity is_callable = ls_callable ir_rows = lr_rows
                    CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
            lv_ran = abap_true.
          ENDIF.
        ENDLOOP.
      ENDLOOP.
      IF lv_ran = abap_false.
        RETURN.
      ENDIF.
    ENDDO.
  ENDMETHOD.

  METHOD validate.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_callable TYPE zif_osd_rap_bo=>ty_callable.
    DATA ls_inst     TYPE ty_inst.
    DATA lr_rows     TYPE REF TO data.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    LOOP AT ms_model-entities INTO ls_entity.
      LOOP AT ls_entity-callables INTO ls_callable WHERE kind = 'V'.
        lr_rows = mo_bo->new_rows( ls_entity-name ).
        ASSIGN lr_rows->* TO <lt_rows>.
        LOOP AT mt_inst INTO ls_inst WHERE entity = ls_entity-name.
          IF triggered( is_callable = ls_callable is_inst = ls_inst ) = abap_true.
            ASSIGN ls_inst-row->* TO <ls_row>.
            APPEND <ls_row> TO <lt_rows>.
          ENDIF.
        ENDLOOP.
        IF lines( <lt_rows> ) > 0.
          invoke( EXPORTING is_entity = ls_entity is_callable = ls_callable ir_rows = lr_rows
                  CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD invoke.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lo_handler  TYPE REF TO object.
    DATA lv_kind     TYPE string.
    DATA lx_error    TYPE REF TO cx_root.
    DATA lv_top      TYPE i.

    CASE is_callable-kind.
      WHEN 'D'.
        lv_kind = 'DETERMINATION'.
      WHEN 'V'.
        lv_kind = 'VALIDATION'.
      WHEN OTHERS.
        lv_kind = 'ACTION'.
    ENDCASE.
    APPEND |{ lv_kind } { is_callable-name }| TO mt_trace.

    lo_handler = handler_of( is_entity ).
    GET REFERENCE OF cs_failed INTO lr_failed.
    GET REFERENCE OF cs_reported INTO lr_reported.
* while the handler runs, EML in it reaches this runtime (ACTIVE)
    APPEND me TO gt_active.
    mv_depth = mv_depth + 1.
    TRY.
        mo_bo->call( io_handler = lo_handler iv_entity = is_entity-name iv_name = is_callable-name
                     ir_rows = ir_rows ir_keys = ir_keys ir_result = ir_result
                     ir_failed = lr_failed ir_reported = lr_reported ).
      CATCH cx_root INTO lx_error.
        mv_depth = mv_depth - 1.
        lv_top = lines( gt_active ).
        DELETE gt_active INDEX lv_top.
        RAISE EXCEPTION lx_error.
    ENDTRY.
    mv_depth = mv_depth - 1.
    lv_top = lines( gt_active ).
    DELETE gt_active INDEX lv_top.
* a validation only judges; what it may have changed is not taken back. A
* handler without an ENTITIES table changed the buffer itself, through EML
    IF is_callable-kind <> 'V' AND is_callable-entities = abap_true.
      take_back( is_entity = is_entity ir_rows = ir_rows ).
    ENDIF.
  ENDMETHOD.

  METHOD take_back.
* what a determination or action changed, into the buffer: field by field,
* so the changed fields trigger what depends on them
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_key   TYPE string.
    DATA lv_index TYPE i.
    DATA lv_dirty TYPE abap_bool.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>  TYPE any.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_new>  TYPE any.
    FIELD-SYMBOLS <lv_old>  TYPE any.

    ASSIGN ir_rows->* TO <lt_rows>.
    LOOP AT <lt_rows> ASSIGNING <ls_new>.
      lv_key = key_of( is_entity = is_entity is_row = <ls_new> ).
      lv_index = index_of( iv_entity = is_entity-name iv_key = lv_key ).
      IF lv_index = 0.
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
      IF <ls_inst>-state = co_operation-delete.
        CONTINUE.
      ENDIF.
      ASSIGN <ls_inst>-row->* TO <ls_row>.
      lv_dirty = abap_false.
      LOOP AT is_entity-fields INTO ls_field WHERE key = abap_false.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_new> TO <lv_new>.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_old>.
        IF <lv_new> <> <lv_old>.
          <lv_old> = <lv_new>.
          mark( iv_index = lv_index iv_field = ls_field-name ).
          lv_dirty = abap_true.
        ENDIF.
      ENDLOOP.
      IF lv_dirty = abap_true.
        READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
        IF <ls_inst>-state IS INITIAL.
          <ls_inst>-state = co_operation-update.
        ENDIF.
        IF <ls_inst>-created = abap_false.
          <ls_inst>-updated = abap_true.
          <ls_inst>-req_updated = abap_true.
        ENDIF.
        mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                        iv_operation = co_operation-update ir_row = <ls_inst>-row ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD handler_of.
    DATA ls_handler TYPE ty_handler.

    READ TABLE mt_handler INTO ls_handler WITH KEY name = is_entity-handler.
    IF sy-subrc = 0.
      ro_handler = ls_handler-handler.
      RETURN.
    ENDIF.
    IF is_entity-handler IS INITIAL.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ is_entity-alias } has no handler class|.
    ENDIF.
    TRY.
        CREATE OBJECT ro_handler TYPE (is_entity-handler).
      CATCH cx_sy_create_object_error.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |handler { is_entity-handler } not found|.
    ENDTRY.
    ls_handler-name = is_entity-handler.
    ls_handler-handler = ro_handler.
    APPEND ls_handler TO mt_handler.
  ENDMETHOD.

  METHOD saver.
    IF mo_saver IS INITIAL AND ms_model-saver IS NOT INITIAL.
      TRY.
          CREATE OBJECT mo_saver TYPE (ms_model-saver).
        CATCH cx_sy_create_object_error.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |saver { ms_model-saver } not found|.
      ENDTRY.
    ENDIF.
    ro_saver = mo_saver.
  ENDMETHOD.

  METHOD count_failed.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    FIELD-SYMBOLS <lt_failed> TYPE STANDARD TABLE.

    LOOP AT ms_model-entities INTO ls_entity.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE is_failed TO <lt_failed>.
      IF sy-subrc = 0.
        rv_count = rv_count + lines( <lt_failed> ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD commit.
    DATA lo_saver  TYPE REF TO cl_abap_behavior_saver.
    DATA lv_before TYPE i.
    DATA lx_error  TYPE REF TO zcx_osd_rap.

    ev_saved = abap_false.
    lo_saver = saver( ).
    lv_before = count_failed( cs_failed ).
    CLEAR mt_done.

    APPEND 'FINALIZE' TO mt_trace.
    determine( EXPORTING iv_on = 'S' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF lo_saver IS NOT INITIAL.
      lo_saver->finalize( ).
    ENDIF.

    IF count_failed( cs_failed ) = lv_before.
      APPEND 'CHECK_BEFORE_SAVE' TO mt_trace.
      validate( CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      IF lo_saver IS NOT INITIAL.
        lo_saver->check_before_save( ).
      ENDIF.
    ENDIF.

    IF count_failed( cs_failed ) > lv_before.
* nothing was written; the buffer stays for the caller to correct
      APPEND 'CLEANUP_FINALIZE' TO mt_trace.
      IF lo_saver IS NOT INITIAL.
        lo_saver->cleanup_finalize( ).
      ENDIF.
      IF iv_end_luw = abap_true.
        ROLLBACK WORK.
      ENDIF.
      RETURN.
    ENDIF.

    APPEND 'SAVE' TO mt_trace.
    TRY.
        persist( ).
      CATCH zcx_osd_rap INTO lx_error.
        IF iv_end_luw = abap_true.
          ROLLBACK WORK.
        ENDIF.
        RAISE EXCEPTION lx_error.
    ENDTRY.
    IF iv_end_luw = abap_true.
      COMMIT WORK.
    ENDIF.

    APPEND 'CLEANUP' TO mt_trace.
    IF lo_saver IS NOT INITIAL.
      lo_saver->cleanup( ).
    ENDIF.
* cleanup resets the transactional buffer: the next transaction reads the
* database again, and a %cid of this one is not a reference any more
    mi_luw->discard( ).
    CLEAR: mt_inst, mt_done.
    ev_saved = abap_true.
  ENDMETHOD.

  METHOD persist.
* the managed save: every change of the delta into the persistent table,
* each CDS element into its mapped column
    DATA lt_delta  TYPE zif_osd_luw=>tt_change.
    DATA ls_change TYPE zif_osd_luw=>ty_change.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA li_source TYPE REF TO zif_stg_cds_source.
    DATA lr_line   TYPE REF TO data.
    DATA lv_subrc  TYPE sy-subrc.
    FIELD-SYMBOLS <ls_line> TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    lt_delta = mi_luw->delta( ).
    LOOP AT lt_delta INTO ls_change.
      ls_entity = entity_of( ls_change-entity ).
      li_source = source_of( ls_entity ).
      ASSIGN ls_change-row->* TO <ls_row>.
* an update starts from the row in the database, so a column the entity
* does not expose keeps its value
      CLEAR lr_line.
      IF ls_change-operation = co_operation-update.
        lr_line = table_row( is_entity = ls_entity is_keys = <ls_row> ).
      ENDIF.
      IF lr_line IS INITIAL.
        lr_line = li_source->create_line( ).
      ENDIF.
      ASSIGN lr_line->* TO <ls_line>.
      ASSIGN COMPONENT 'MANDT' OF STRUCTURE <ls_line> TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = sy-mandt.
      ENDIF.
      LOOP AT ls_entity-fields INTO ls_field.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_from>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT ls_field-column OF STRUCTURE <ls_line> TO <lv_to>.
        CHECK sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDLOOP.
      CASE ls_change-operation.
        WHEN co_operation-create.
          lv_subrc = li_source->insert( <ls_line> ).
        WHEN co_operation-update.
          lv_subrc = li_source->update( <ls_line> ).
        WHEN OTHERS.
          lv_subrc = li_source->delete( <ls_line> ).
      ENDCASE.
      IF lv_subrc <> 0.
        RAISE EXCEPTION TYPE zcx_osd_rap
          EXPORTING iv_reason = |save of { ls_entity-alias } { ls_change-key } ({ ls_change-operation }) failed|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD rollback.
    DATA lo_saver TYPE REF TO cl_abap_behavior_saver.
    TRY.
        lo_saver = saver( ).
      CATCH zcx_osd_rap.
        CLEAR lo_saver.
    ENDTRY.
    IF lo_saver IS NOT INITIAL.
      lo_saver->cleanup( ).
    ENDIF.
    APPEND 'ROLLBACK' TO mt_trace.
    mi_luw->discard( ).
    CLEAR: mt_inst, mt_done.
  ENDMETHOD.

  METHOD bo.
    ri_bo = mo_bo.
  ENDMETHOD.

  METHOD trace.
    rt_trace = mt_trace.
  ENDMETHOD.

  METHOD pending.
    rv_count = mi_luw->count( ).
  ENDMETHOD.

ENDCLASS.
