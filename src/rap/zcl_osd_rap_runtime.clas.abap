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
*   numbering       a managed key drawn as a UUID on create; with early
*                   numbering the pool's FOR NUMBERING method draws it (R4)
*   features        an update, delete or action declared ( features :
*                   instance ) asks the pool's FOR INSTANCE FEATURES method
*                   and is refused (cause disabled) when it answers disabled
*   admin fields    @Semantics created/last changed at/by stamped on create
*                   and change, so an etag master field moves with each write
*   %cid            mapped back with the key; %cid_ref resolved later
*   determinations  on modify after each request, on save in finalize
*   validations     on save in check_before_save; a FAILED row stops the
*                   save, nothing is written and the LUW is rolled back
*   save            the persistent table written through the BDEF mapping,
*                   then the savers' save_modified for the entities with an
*                   additional or unmanaged save (R7), then COMMIT WORK and
*                   cleanup; every pool's saver is called in each phase
*   tree (R5)       create and read by association; a delete takes the
*                   composition children; an update, delete, action or
*                   create by association locks the root instance (lock
*                   master / dependent) and a child write stamps the
*                   root's total change fields
*
*   draft (R8)      with draft: %is_draft is part of an instance's
*                   identity; a draft is read from and saved into the
*                   draft table, skips determinations on save and
*                   validations, and the draft actions Edit, Activate,
*                   Discard and Resume are run here; Prepare is a determine
*                   action over the draft (docs/rap-runtime.md, R8)
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
* CT_RESULT: a TABLE FOR ACTION RESULT. R6: an internal action only from a
* handler of this runtime (IN LOCAL MODE), else ZCX_OSD_RAP; a determine
* action runs its members; a factory action answers the new instances in
* CS_MAPPED (RESPONSE FOR MAPPED), under the %cid of each import row
    METHODS execute
      IMPORTING
        iv_entity   TYPE csequence
        iv_action   TYPE csequence
        it_keys     TYPE STANDARD TABLE
      CHANGING
        ct_result   TYPE STANDARD TABLE
        cs_failed   TYPE any
        cs_reported TYPE any
        cs_mapped   TYPE any OPTIONAL
      RAISING
        zcx_osd_rap.

* R5: create instances of the target of a composition IV_ASSOC of IV_ENTITY
* (create by association). IT_ROWS is a TABLE FOR CREATE entity\_assoc: the
* parent by its key or %cid_ref, the new instances in %target
    METHODS create_by
      IMPORTING
        iv_entity   TYPE csequence
        iv_assoc    TYPE csequence
        it_rows     TYPE STANDARD TABLE
      CHANGING
        cs_mapped   TYPE any
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* R5: read by association: for each instance IT_KEYS names (a TABLE FOR
* READ IMPORT entity\_assoc), the instances the association reaches, into
* CT_RESULT (TABLE FOR READ RESULT entity\_assoc), and source and target
* keys into CT_LINK (TABLE FOR READ LINK entity\_assoc)
    METHODS read_by
      IMPORTING
        iv_entity TYPE csequence
        iv_assoc  TYPE csequence
        it_keys   TYPE ANY TABLE
      CHANGING
        ct_result TYPE STANDARD TABLE
        ct_link   TYPE STANDARD TABLE
        cs_failed TYPE any
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

* R10: the augment of a projection (use create / update ( augment )): the
* generated class IO_AUGMENT calls the projection pool's FOR MODIFY method
* with the request's rows while this runtime is active, so its MODIFY
* AUGMENTING ENTITIES (EML) lands in this transaction. EV_FAILED: the rows
* the augment put into its FAILED
    METHODS augment
      IMPORTING
        io_augment TYPE REF TO zif_osd_rap_augment
        iv_entity  TYPE csequence
        ir_create  TYPE REF TO data OPTIONAL
        ir_update  TYPE REF TO data OPTIONAL
      EXPORTING
        ev_failed   TYPE i
        et_messages TYPE string_table
      RAISING
        zcx_osd_rap.

* R10: late numbering. After a save, the final key adjust_numbers gave an
* instance the transaction created under a preliminary key: CS_ROW (a row of
* IV_ENTITY with its keys, IsActiveEntity or %is_draft) gets the final key
* when its key was a preliminary one of the last save, and stays otherwise
    METHODS final_key
      IMPORTING
        iv_entity TYPE csequence
      CHANGING
        cs_row    TYPE any
      RAISING
        zcx_osd_rap.

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
        admin_uuid  TYPE x LENGTH 16,
        has_active  TYPE abap_bool,
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
* R7: the local savers of every pool of the BDEF, the header's first
    DATA mt_savers TYPE STANDARD TABLE OF REF TO cl_abap_behavior_saver WITH DEFAULT KEY.
    DATA mv_savers TYPE abap_bool.
    DATA mt_trace TYPE string_table.
    DATA mt_done TYPE string_table.
* handlers of this runtime running now: the modifications they make are
* local (IN LOCAL MODE) and inside the request that called them
    DATA mv_depth TYPE i.
    CLASS-DATA gt_active TYPE STANDARD TABLE OF REF TO zcl_osd_rap_runtime WITH DEFAULT KEY.
* the last time stamp given to an administrative field: a new one is always
* later, also where the clock does not move between two writes
    CLASS-DATA gv_stamp TYPE timestampl.
* R5: the roots this transaction holds the lock of (BDEF|root|key), and
* the lock arguments (their SHA-256), released when the transaction ends
    DATA mt_locked TYPE string_table.
    DATA mt_lockhash TYPE string_table.
* R8: Activate takes the lock of the active root while its draft still
* exists; the draft is the activation's own and does not refuse it
    DATA mv_activating TYPE abap_bool.
* R10: the preliminary and final keys of the last save's late numbering
    TYPES:
      BEGIN OF ty_late,
        entity TYPE string,
        pre    TYPE string,
        row    TYPE REF TO data,
      END OF ty_late,
      tt_late TYPE STANDARD TABLE OF ty_late WITH DEFAULT KEY.
    DATA mt_late TYPE tt_late.

* R10: a preliminary key and %pid for an instance of a late-numbered entity
* (docs/rap-runtime.md, R10)
    METHODS late_key
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
      CHANGING
        cs_row    TYPE any
      RAISING
        zcx_osd_rap.
* R10: whether a key value is one late_key could have drawn
    METHODS preliminary
      IMPORTING
        iv_value     TYPE simple
      RETURNING
        VALUE(rv_on) TYPE abap_bool.
* R10: the save's adjust_numbers: MAPPED LATE of every created active
* instance of a late-numbered entity to the savers, the final keys back
    METHODS late_numbers
      CHANGING
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

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

* R8: whether a row names the draft (%is_draft on) of a draft-enabled BO
    METHODS is_draft
      IMPORTING
        is_row         TYPE any
      RETURNING
        VALUE(rv_on)   TYPE abap_bool.

    CLASS-METHODS set_draft
      IMPORTING
        iv_on  TYPE abap_bool
      CHANGING
        cs_row TYPE any.

* R8: whether the root instance IS_ROOT names (its keys) has a draft: in
* the buffer (and not deleted there), else in the draft table
    METHODS draft_exists
      IMPORTING
        is_root          TYPE zif_osd_rap_bo=>ty_entity
        is_keys          TYPE any
      RETURNING
        VALUE(rv_exists) TYPE abap_bool.

* R9: who the draft of the root instance IS_KEYS names is in process by
* (initial: no draft, or one of this transaction)
    METHODS draft_holder
      IMPORTING
        is_root        TYPE zif_osd_rap_bo=>ty_entity
        is_keys        TYPE any
      RETURNING
        VALUE(rv_user) TYPE syuname.

* R8: the draft actions (KIND E) on the instance at IV_INDEX
    METHODS draft_action
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        iv_action   TYPE string
        iv_index    TYPE i
        is_key      TYPE any
      CHANGING
        ct_result   TYPE STANDARD TABLE
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* R8: whether every mandatory field of IS_ROW is filled (FAILED if not)
    METHODS mandatory_ok
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_row      TYPE any
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RETURNING
        VALUE(rv_ok) TYPE abap_bool.

* R8: Activate of the draft root at IV_INDEX
    METHODS activate_draft
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        iv_index    TYPE i
        is_key      TYPE any
      CHANGING
        ct_result   TYPE STANDARD TABLE
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* R8: the instance at IV_INDEX and its composition tree as drafts (Edit)
    METHODS copy_to_draft
      IMPORTING
        is_entity      TYPE zif_osd_rap_bo=>ty_entity
        iv_index       TYPE i
        iv_uuid        TYPE xsequence
      RETURNING
        VALUE(rv_index) TYPE i
      RAISING
        zcx_osd_rap.

* R8: the draft tree below IV_INDEX, as entity|index pairs
    METHODS draft_tree
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
      CHANGING
        ct_tree   TYPE string_table
      RAISING
        zcx_osd_rap.

* R8: the active instance a draft row becomes on Activate; its index
    METHODS activate_one
      IMPORTING
        is_entity       TYPE zif_osd_rap_bo=>ty_entity
        is_draft        TYPE any
      CHANGING
        cs_failed       TYPE any
        cs_reported     TYPE any
      RETURNING
        VALUE(rv_index) TYPE i
      RAISING
        zcx_osd_rap.

* R9: the user a draft is in process by (ZOSD_DRAFT_ADM), initial when
* the admin row is not written yet (a draft of this transaction)
    METHODS holder_of
      IMPORTING
        iv_uuid        TYPE zosd_draft_adm-draftuuid
      RETURNING
        VALUE(rv_user) TYPE syuname.

* R9: whether the draft at IV_INDEX (any instance of its tree) belongs to
* another user than the request's; FAILED and REPORTED say so when it does
    METHODS foreign_draft
      IMPORTING
        is_entity       TYPE zif_osd_rap_bo=>ty_entity
        iv_index        TYPE i
        is_input        TYPE any
      CHANGING
        cs_failed       TYPE any
        cs_reported     TYPE any
      RETURNING
        VALUE(rv_foreign) TYPE abap_bool
      RAISING
        zcx_osd_rap.

* R8: the draft's admin UUID (one per draft of a root, shared by its tree)
    METHODS admin_uuid
      IMPORTING
        is_entity     TYPE zif_osd_rap_bo=>ty_entity
        iv_index      TYPE i
      RETURNING
        VALUE(rv_uuid) TYPE zosd_draft_adm-draftuuid
      RAISING
        zcx_osd_rap.

    METHODS draft_admin
      IMPORTING
        is_entity    TYPE zif_osd_rap_bo=>ty_entity
        iv_uuid      TYPE xsequence
        iv_operation TYPE ty_operation.

    METHODS result_row
      IMPORTING
        is_row    TYPE any
      CHANGING
        ct_result TYPE STANDARD TABLE.

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

* R4: whether the pool's instance features enable an operation of one
* instance: IV_FLAG %UPDATE, %DELETE, or an action name with IV_GROUP %ACTION
    METHODS enabled
      IMPORTING
        is_entity         TYPE zif_osd_rap_bo=>ty_entity
        iv_index          TYPE i
        iv_group          TYPE string OPTIONAL
        iv_flag           TYPE string
      RETURNING
        VALUE(rv_enabled) TYPE abap_bool
      RAISING
        zcx_osd_rap.
* R4: a handler method of the pool that is no determination, validation or
* action (%FEATURES, %NUMBERING), with this runtime ACTIVE while it runs
    METHODS call_pool
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        iv_name     TYPE string
        ir_rows     TYPE REF TO data
        ir_result   TYPE REF TO data OPTIONAL
        ir_mapped   TYPE REF TO data OPTIONAL
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.
* R4: early numbering, the keys of a create drawn by the pool before the
* instances enter the buffer
    METHODS number
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        it_rows     TYPE ANY TABLE
      EXPORTING
        er_rows     TYPE REF TO data
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.
* R4: the 100 ns after a time stamp, valid by the calendar
    CLASS-METHODS later
      IMPORTING
        iv_stamp        TYPE timestampl
      RETURNING
        VALUE(rv_stamp) TYPE timestampl.
* iv_stamp, or the first stamp after it that a double tells from iv_old.
* The database seams write a DEC as a double (ANORMALIES.md,
* ANOMALY-2026-10-08-dec-sqlite-real), which resolves about 4 ms at the
* size of a TIMESTAMPL: two writes inside that window were stored as the
* same value, the ETag over it did not move, and a stale If-Match passed.
    CLASS-METHODS apart
      IMPORTING
        iv_stamp        TYPE timestampl
        iv_old          TYPE timestampl
      RETURNING
        VALUE(rv_stamp) TYPE timestampl.
* R4: the administrative fields of an instance, on create or on change
    METHODS stamp
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
        iv_create TYPE abap_bool
        iv_total  TYPE abap_bool DEFAULT abap_false.
* R5: an association of an entity, by name
    METHODS assoc_of
      IMPORTING
        is_entity       TYPE zif_osd_rap_bo=>ty_entity
        iv_assoc        TYPE csequence
      RETURNING
        VALUE(rs_assoc) TYPE zif_osd_rap_bo=>ty_assoc
      RAISING
        zcx_osd_rap.
* R5: the instances an association reaches from the instance IV_INDEX, from
* the persistent table and the buffer (the buffer wins), in key order
    METHODS targets
      IMPORTING
        is_entity       TYPE zif_osd_rap_bo=>ty_entity
        is_assoc        TYPE zif_osd_rap_bo=>ty_assoc
        iv_index        TYPE i
      RETURNING
        VALUE(rt_index) TYPE int4_table
      RAISING
        zcx_osd_rap.
* R5: the parent instance of the instance IV_INDEX (0 when there is none)
    METHODS parent_of
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
      EXPORTING
        es_parent TYPE zif_osd_rap_bo=>ty_entity
        ev_index  TYPE i
      RAISING
        zcx_osd_rap.
* R11: the constant elements of an entity into a row read from its table
    METHODS fill_constants
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
      CHANGING
        cs_row    TYPE any.
* R5: the root instance of the instance IV_INDEX (0 when it is gone)
    METHODS root_of
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
      EXPORTING
        es_root   TYPE zif_osd_rap_bo=>ty_entity
        ev_index  TYPE i
      RAISING
        zcx_osd_rap.
* R5: lock master / dependent: the exclusive lock on the root instance,
* once per transaction. False (and FAILED, cause locked) when another owner
* holds it
    METHODS lock
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        iv_index    TYPE i
        is_input    TYPE any
      EXPORTING
        ev_ok       TYPE abap_bool
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.
* R5: release the root locks of the transaction (the framework's DEQUEUE
* after the save or the rollback: a COMMIT WORK that queued no update
* releases nothing, tools/osd-enq.mjs)
    METHODS unlock.
* R5: a change below the root stamps the root's total change fields
    METHODS touch_root
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
      RAISING
        zcx_osd_rap.
* R5: delete an instance and its composition children, recursively
    METHODS delete_tree
      IMPORTING
        is_entity TYPE zif_osd_rap_bo=>ty_entity
        iv_index  TYPE i
      RAISING
        zcx_osd_rap.
* R5: the key values of a row, for a message
    METHODS key_text
      IMPORTING
        is_entity      TYPE zif_osd_rap_bo=>ty_entity
        is_row         TYPE any
      RETURNING
        VALUE(rv_text) TYPE string.
* R5: early numbering of a create by association, as NUMBER for a create
    METHODS number_by
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_assoc    TYPE zif_osd_rap_bo=>ty_assoc
        ir_rows     TYPE REF TO data
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.
    METHODS create_one
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_input    TYPE any
* R5: the fields the framework sets (the parent's key in a create by
* association): copied whatever %control says, key or not
        it_framework TYPE string_table OPTIONAL
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
        ir_mapped   TYPE REF TO data OPTIONAL
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* R6: the members of a determine action, for the instances IT_KEYS names
* (the buffer's instance keys)
    METHODS determine_action
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_callable TYPE zif_osd_rap_bo=>ty_callable
        it_keys     TYPE string_table
      CHANGING
        cs_failed   TYPE any
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

* R6: a factory action's contract, every import row's %cid in MAPPED or
* the row in FAILED; a row that is in neither is failed
    METHODS check_factory
      IMPORTING
        is_entity   TYPE zif_osd_rap_bo=>ty_entity
        is_callable TYPE zif_osd_rap_bo=>ty_callable
        it_keys     TYPE STANDARD TABLE
      CHANGING
        cs_mapped   TYPE any
        cs_failed   TYPE any
        cs_reported TYPE any.

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

    METHODS savers
      RETURNING
        VALUE(rt_savers) LIKE mt_savers
      RAISING
        zcx_osd_rap.

* R7: the request of save_modified from the buffer, for the entities with
* an additional or unmanaged save, then each saver's save_modified (or save)
    METHODS save_savers
      CHANGING
        cs_reported TYPE any
      RAISING
        zcx_osd_rap.

    METHODS request_row
      IMPORTING
        is_entity  TYPE zif_osd_rap_bo=>ty_entity
        is_inst    TYPE ty_inst
        iv_kind    TYPE ty_operation
      CHANGING
        ct_rows    TYPE STANDARD TABLE.

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
* R8: the draft and the active instance of one key are two instances; a
* rendering of the key tuple starts with a digit, so the prefix is unique
    IF is_draft( is_row ) = abap_true.
      rv_key = |D\|{ rv_key }|.
    ENDIF.
  ENDMETHOD.

  METHOD is_draft.
    FIELD-SYMBOLS <lv_flag> TYPE any.
    IF ms_model-draft = abap_false.
      RETURN.
    ENDIF.
    ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE is_row TO <lv_flag>.
    IF sy-subrc = 0 AND <lv_flag> = if_abap_behv=>mk-on.
      rv_on = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD set_draft.
    FIELD-SYMBOLS <lv_flag> TYPE any.
    ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE cs_row TO <lv_flag>.
    IF sy-subrc = 0.
      IF iv_on = abap_true.
        <lv_flag> = if_abap_behv=>mk-on.
      ELSE.
        <lv_flag> = if_abap_behv=>mk-off.
      ENDIF.
    ENDIF.
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
* R10: %pid is part of %pky (late numbering)
    ASSIGN COMPONENT '%PID' OF STRUCTURE is_from TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT '%PID' OF STRUCTURE cs_to TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDIF.
* R8: %is_draft is part of %tky
    ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE is_from TO <lv_from>.
    IF sy-subrc = 0.
      ASSIGN COMPONENT '%IS_DRAFT' OF STRUCTURE cs_to TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDIF.
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

    DATA lv_draft  TYPE abap_bool.
    DATA lv_column TYPE string.

* R8: a draft is a row of the draft table, its columns the CDS elements
    lv_draft = is_draft( is_keys ).
    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      lv_value = text_of( is_row = is_keys iv_component = ls_field-name ).
      REPLACE ALL OCCURRENCES OF `'` IN lv_value WITH `''`.
      IF lv_where IS NOT INITIAL.
        lv_where = lv_where && ` AND `.
      ENDIF.
      lv_column = ls_field-column.
      IF lv_draft = abap_true.
        lv_column = ls_field-name.
      ENDIF.
      lv_where = lv_where && lv_column && ` = '` && lv_value && `'`.
    ENDLOOP.

    IF lv_draft = abap_true.
      TRY.
          CREATE OBJECT li_source TYPE (is_entity-draft_source).
        CATCH cx_sy_create_object_error.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no table class { is_entity-draft_source } for { is_entity-draft_table }|.
      ENDTRY.
    ELSE.
      li_source = source_of( is_entity ).
    ENDIF.
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
      IF is_draft( is_keys ) = abap_true.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_data> TO <lv_from>.
      ELSE.
        ASSIGN COMPONENT ls_field-column OF STRUCTURE <ls_data> TO <lv_from>.
      ENDIF.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
    IF is_draft( is_keys ) = abap_false.
      fill_constants( EXPORTING is_entity = is_entity CHANGING cs_row = <ls_row> ).
    ENDIF.
    set_draft( EXPORTING iv_on = is_draft( is_keys ) CHANGING cs_row = <ls_row> ).
  ENDMETHOD.

  METHOD fill_constants.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <lv_value> TYPE any.
    LOOP AT is_entity-fields INTO ls_field WHERE constant IS NOT INITIAL.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_value>.
      IF sy-subrc = 0.
        <lv_value> = ls_field-constant.
      ENDIF.
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

* R8: a draft may be incomplete; Activate checks the active instance
      IF ( ls_field-mandatory = 'X'
          OR ( ls_field-mandatory = 'C' AND iv_operation = co_operation-create ) )
          AND is_draft( is_input ) = abap_false.
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
      ELSE.
        READ TABLE it_framework TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
        IF sy-subrc = 0.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE is_input TO <lv_from>.
          <lv_to> = <lv_from>.
        ENDIF.
      ENDIF.
    ENDLOOP.

    set_draft( EXPORTING iv_on = is_draft( is_input ) CHANGING cs_row = <ls_row> ).
* R10: late numbering -- a preliminary key and %pid until adjust_numbers
    IF is_entity-numbering = 'L'.
      late_key( EXPORTING is_entity = is_entity CHANGING cs_row = <ls_row> ).
    ENDIF.
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
* R8: a new draft of a root is a new draft (admin data of its own)
    IF is_draft( <ls_row> ) = abap_true AND is_entity-parent IS INITIAL.
      TRY.
          ls_inst-admin_uuid = cl_system_uuid=>create_uuid_x16_static( ).
        CATCH cx_uuid_error.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no UUID for the draft of { is_entity-name }|.
      ENDTRY.
    ENDIF.
    IF lv_index > 0.
      MODIFY mt_inst INDEX lv_index FROM ls_inst.
    ELSE.
      APPEND ls_inst TO mt_inst.
      lv_index = lines( mt_inst ).
    ENDIF.
    LOOP AT is_entity-fields INTO ls_field.
      READ TABLE it_framework TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
      IF control_on( is_row = is_input iv_field = ls_field-name ) = abap_true OR ls_field-numbering = abap_true OR sy-subrc = 0.
        mark( iv_index = lv_index iv_field = ls_field-name ).
      ENDIF.
    ENDLOOP.
    stamp( is_entity = is_entity iv_index = lv_index iv_create = abap_true ).
    mi_luw->modify( iv_entity = is_entity-name iv_key = ls_inst-key
                    iv_operation = co_operation-create ir_row = lr_row ).
    touch_root( is_entity = is_entity iv_index = lv_index ).

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
    IF is_entity-feat_update = abap_true
        AND enabled( is_entity = is_entity iv_index = lv_index iv_flag = '%UPDATE' ) = abap_false.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-disabled
                      iv_text = |Update of { is_entity-alias } is disabled| iv_op = '%UPDATE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    check_fields( EXPORTING is_entity = is_entity is_input = is_input iv_operation = co_operation-update
                  IMPORTING ev_ok = lv_ok
                  CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.
    lock( EXPORTING is_entity = is_entity iv_index = lv_index is_input = is_input
          IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
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
    stamp( is_entity = is_entity iv_index = lv_index iv_create = abap_false ).
    mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                    iv_operation = co_operation-update ir_row = <ls_inst>-row ).
    touch_root( is_entity = is_entity iv_index = lv_index ).
  ENDMETHOD.

  METHOD delete_one.
    DATA lv_index TYPE i.
    DATA lv_ok    TYPE abap_bool.

    lv_index = resolve( is_entity = is_entity is_input = is_input ).
    IF lv_index = 0.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-not_found
                      iv_text = |{ is_entity-alias } not found| iv_op = '%DELETE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    IF is_entity-feat_delete = abap_true
        AND enabled( is_entity = is_entity iv_index = lv_index iv_flag = '%DELETE' ) = abap_false.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-disabled
                      iv_text = |Delete of { is_entity-alias } is disabled| iv_op = '%DELETE'
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    lock( EXPORTING is_entity = is_entity iv_index = lv_index is_input = is_input
          IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.
* the root's stamp moves while the parent chain is still there
    touch_root( is_entity = is_entity iv_index = lv_index ).
    delete_tree( is_entity = is_entity iv_index = lv_index ).
  ENDMETHOD.

  METHOD assoc_of.
    DATA lv_name TYPE string.
    lv_name = to_upper( iv_assoc ).
    READ TABLE is_entity-assocs INTO rs_assoc WITH KEY name = lv_name.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ is_entity-alias } has no association { iv_assoc }|.
    ENDIF.
  ENDMETHOD.

  METHOD key_text.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      IF rv_text IS INITIAL.
        rv_text = text_of( is_row = is_row iv_component = ls_field-name ).
      ELSE.
        rv_text = rv_text && '/' && text_of( is_row = is_row iv_component = ls_field-name ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD targets.
* the saved rows first, each into the buffer unless an instance with its key
* is there already; then every buffered instance the pairs reach
    TYPES:
      BEGIN OF ty_found,
        key   TYPE string,
        index TYPE i,
      END OF ty_found.
    DATA ls_target TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_pair   TYPE zif_osd_rap_bo=>ty_pair.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_inst   TYPE ty_inst.
    DATA ls_src    TYPE ty_inst.
    DATA li_source TYPE REF TO zif_stg_cds_source.
    DATA lr_data   TYPE REF TO data.
    DATA lr_row    TYPE REF TO data.
    DATA lt_order  TYPE string_table.
    DATA lv_where  TYPE string.
    DATA lv_value  TYPE string.
    DATA lv_key    TYPE string.
    DATA lv_match  TYPE abap_bool.
    DATA lv_tabix  TYPE i.
    DATA ls_found  TYPE ty_found.
    DATA lt_found  TYPE STANDARD TABLE OF ty_found WITH DEFAULT KEY.
    FIELD-SYMBOLS <ls_src>  TYPE any.
    FIELD-SYMBOLS <lt_data> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_data> TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    DATA lv_draft  TYPE abap_bool.
    DATA lv_column TYPE string.
    DATA lv_none   TYPE abap_bool.

    ls_target = entity_of( is_assoc-target ).
    READ TABLE mt_inst INDEX iv_index INTO ls_src.
    ASSIGN ls_src-row->* TO <ls_src>.
* R8: a draft reaches the drafts below it (association { with draft; }),
* an active instance the active ones
    lv_draft = is_draft( <ls_src> ).

    LOOP AT is_assoc-pairs INTO ls_pair.
      READ TABLE ls_target-fields INTO ls_field WITH KEY name = ls_pair-target.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_target-alias } has no field { ls_pair-target }|.
      ENDIF.
      lv_value = text_of( is_row = <ls_src> iv_component = ls_pair-source ).
* R11: a constant of the target has no column in its table: every saved
* instance has it, so the pair holds for all of them or for none
      IF ls_field-constant IS NOT INITIAL AND lv_draft = abap_false.
        IF condense( lv_value ) <> condense( ls_field-constant ).
          lv_none = abap_true.
        ENDIF.
        CONTINUE.
      ENDIF.
      REPLACE ALL OCCURRENCES OF `'` IN lv_value WITH `''`.
      IF lv_where IS NOT INITIAL.
        lv_where = lv_where && ` AND `.
      ENDIF.
      lv_column = ls_field-column.
      IF lv_draft = abap_true.
        lv_column = ls_field-name.
      ENDIF.
      lv_where = lv_where && lv_column && ` = '` && lv_value && `'`.
    ENDLOOP.
* an instance created in this transaction has nothing saved below it
    IF ls_src-created = abap_false AND lv_none = abap_false.
      IF lv_draft = abap_true.
        TRY.
            CREATE OBJECT li_source TYPE (ls_target-draft_source).
          CATCH cx_sy_create_object_error.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no table class { ls_target-draft_source }|.
        ENDTRY.
      ELSE.
        li_source = source_of( ls_target ).
      ENDIF.
      lr_data = li_source->read( iv_where = lv_where it_orderby = lt_order ).
      ASSIGN lr_data->* TO <lt_data>.
      LOOP AT <lt_data> ASSIGNING <ls_data>.
        lr_row = new_row( ls_target ).
        ASSIGN lr_row->* TO <ls_row>.
        LOOP AT ls_target-fields INTO ls_field.
          IF lv_draft = abap_true.
            ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_data> TO <lv_from>.
          ELSE.
            ASSIGN COMPONENT ls_field-column OF STRUCTURE <ls_data> TO <lv_from>.
          ENDIF.
          CHECK sy-subrc = 0.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
          CHECK sy-subrc = 0.
          <lv_to> = <lv_from>.
        ENDLOOP.
        IF lv_draft = abap_false.
          fill_constants( EXPORTING is_entity = ls_target CHANGING cs_row = <ls_row> ).
        ENDIF.
        set_draft( EXPORTING iv_on = lv_draft CHANGING cs_row = <ls_row> ).
        lv_key = key_of( is_entity = ls_target is_row = <ls_row> ).
        IF index_of( iv_entity = ls_target-name iv_key = lv_key ) = 0.
          CLEAR ls_inst.
          ls_inst-entity = ls_target-name.
          ls_inst-key    = lv_key.
          ls_inst-row    = lr_row.
          APPEND ls_inst TO mt_inst.
        ENDIF.
      ENDLOOP.
    ENDIF.

    LOOP AT mt_inst INTO ls_inst WHERE entity = ls_target-name.
      lv_tabix = sy-tabix.
      IF ls_inst-state = co_operation-delete.
        CONTINUE.
      ENDIF.
      ASSIGN ls_inst-row->* TO <ls_row>.
      IF is_draft( <ls_row> ) <> lv_draft.
        CONTINUE.
      ENDIF.
      lv_match = abap_true.
      LOOP AT is_assoc-pairs INTO ls_pair.
        IF text_of( is_row = <ls_row> iv_component = ls_pair-target ) <> text_of( is_row = <ls_src> iv_component = ls_pair-source ).
          lv_match = abap_false.
          EXIT.
        ENDIF.
      ENDLOOP.
      IF lv_match = abap_true.
        ls_found-key = ls_inst-key.
        ls_found-index = lv_tabix.
        APPEND ls_found TO lt_found.
      ENDIF.
    ENDLOOP.
    SORT lt_found BY key.
    LOOP AT lt_found INTO ls_found.
      APPEND ls_found-index TO rt_index.
    ENDLOOP.
  ENDMETHOD.

  METHOD parent_of.
    DATA ls_assoc TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_pair  TYPE zif_osd_rap_bo=>ty_pair.
    DATA ls_inst  TYPE ty_inst.
    DATA lr_keys  TYPE REF TO data.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <ls_keys> TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.

    CLEAR: es_parent, ev_index.
    IF is_entity-parent IS INITIAL.
      RETURN.
    ENDIF.
    es_parent = entity_of( is_entity-parent ).
    ls_assoc = assoc_of( is_entity = is_entity iv_assoc = is_entity-parent_assoc ).
    READ TABLE mt_inst INDEX iv_index INTO ls_inst.
    ASSIGN ls_inst-row->* TO <ls_row>.
    lr_keys = new_row( es_parent ).
    ASSIGN lr_keys->* TO <ls_keys>.
    LOOP AT ls_assoc-pairs INTO ls_pair.
      ASSIGN COMPONENT ls_pair-source OF STRUCTURE <ls_row> TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_pair-target OF STRUCTURE <ls_keys> TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
    ENDLOOP.
    set_draft( EXPORTING iv_on = is_draft( <ls_row> ) CHANGING cs_row = <ls_keys> ).
    ev_index = resolve( is_entity = es_parent is_input = <ls_keys> ).
  ENDMETHOD.

  METHOD root_of.
    DATA ls_parent TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_index  TYPE i.
    es_root = is_entity.
    ev_index = iv_index.
    WHILE es_root-parent IS NOT INITIAL AND ev_index > 0.
      lv_index = ev_index.
      parent_of( EXPORTING is_entity = es_root iv_index = lv_index
                 IMPORTING es_parent = ls_parent ev_index = ev_index ).
      es_root = ls_parent.
    ENDWHILE.
  ENDMETHOD.

  METHOD lock.
* lock master on the root, lock dependent through it: the lock argument is
* the SHA-256 of BDEF, root entity and root key (a lock key has at most 120
* characters), held until the LUW ends (_SCOPE 2). A root created in this
* transaction is nobody else's to see, and needs none
    DATA ls_root     TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_inst     TYPE ty_inst.
    DATA lv_index    TYPE i.
    DATA lv_argument TYPE string.
    DATA lv_hash     TYPE string.
    DATA lv_lockhash TYPE c LENGTH 64.
    DATA lx_hash     TYPE REF TO cx_abap_message_digest.
    FIELD-SYMBOLS <ls_row> TYPE any.

    ev_ok = abap_true.
    IF is_entity-lock IS INITIAL.
      RETURN.
    ENDIF.
    root_of( EXPORTING is_entity = is_entity iv_index = iv_index IMPORTING es_root = ls_root ev_index = lv_index ).
    IF lv_index = 0.
      RETURN.
    ENDIF.
    READ TABLE mt_inst INDEX lv_index INTO ls_inst.
* R8: while an active instance has a draft, the draft holds it (the
* exclusive lock of Edit, kept here by the draft's existence)
    IF ms_model-draft = abap_true.
      ASSIGN ls_inst-row->* TO <ls_row>.
      IF is_draft( <ls_row> ) = abap_false AND mv_activating = abap_false
          AND draft_exists( is_root = ls_root is_keys = <ls_row> ) = abap_true.
        fail( EXPORTING is_entity = is_entity is_input = is_input
                        iv_cause = if_abap_behv=>cause-locked
                        iv_text = |{ ls_root-alias } { key_text( is_entity = ls_root is_row = <ls_row> ) } has a draft: it is edited there|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        ev_ok = abap_false.
        RETURN.
      ENDIF.
* R9: a draft is its owner's: another user's change of it is refused
      IF is_draft( <ls_row> ) = abap_true AND ls_inst-created = abap_false
          AND foreign_draft( EXPORTING is_entity = is_entity iv_index = iv_index is_input = is_input
                             CHANGING cs_failed = cs_failed cs_reported = cs_reported ) = abap_true.
        ev_ok = abap_false.
        RETURN.
      ENDIF.
    ENDIF.
    IF ls_inst-created = abap_true.
      RETURN.
    ENDIF.
    lv_argument = |{ ms_model-bdef }\|{ ls_root-name }\|{ ls_inst-key }|.
    READ TABLE mt_locked TRANSPORTING NO FIELDS WITH KEY table_line = lv_argument.
    IF sy-subrc = 0.
      RETURN.
    ENDIF.
    TRY.
        cl_abap_message_digest=>calculate_hash_for_char( EXPORTING if_algorithm = 'SHA256' if_data = lv_argument
          IMPORTING ef_hashstring = lv_hash ).
      CATCH cx_abap_message_digest INTO lx_hash.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |lock of { ls_root-alias }: { lx_hash->get_text( ) }|.
    ENDTRY.
    lv_lockhash = lv_hash.
    CALL FUNCTION 'ENQUEUE_EZOSD_RAP_LOCK'
      EXPORTING
        mode_zosd_rap_lock = 'E'
        lockhash           = lv_lockhash
      EXCEPTIONS
        foreign_lock       = 1
        system_failure     = 2
        OTHERS             = 3.
    IF sy-subrc = 1.
      ASSIGN ls_inst-row->* TO <ls_row>.
      fail( EXPORTING is_entity = is_entity is_input = is_input
                      iv_cause = if_abap_behv=>cause-locked
                      iv_text = |{ ls_root-alias } { key_text( is_entity = ls_root is_row = <ls_row> ) } is locked by another user|
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      ev_ok = abap_false.
      RETURN.
    ELSEIF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |the lock server refused the lock of { ls_root-alias }|.
    ENDIF.
    APPEND lv_argument TO mt_locked.
    APPEND lv_hash TO mt_lockhash.
  ENDMETHOD.

  METHOD unlock.
    DATA lv_hash     TYPE string.
    DATA lv_lockhash TYPE c LENGTH 64.
    LOOP AT mt_lockhash INTO lv_hash.
      lv_lockhash = lv_hash.
      CALL FUNCTION 'DEQUEUE_EZOSD_RAP_LOCK'
        EXPORTING
          mode_zosd_rap_lock = 'E'
          lockhash           = lv_lockhash.
    ENDLOOP.
    CLEAR: mt_locked, mt_lockhash.
  ENDMETHOD.

  METHOD touch_root.
    DATA ls_root  TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_index TYPE i.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.

    IF is_entity-parent IS INITIAL.
      RETURN.
    ENDIF.
    root_of( EXPORTING is_entity = is_entity iv_index = iv_index IMPORTING es_root = ls_root ev_index = lv_index ).
    IF lv_index = 0.
      RETURN.
    ENDIF.
* R8: the total stamp moves with the active instance only (total etag)
    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    IF ms_model-draft = abap_true AND <ls_inst>-key CP 'D|*'.
      RETURN.
    ENDIF.
    READ TABLE ls_root-fields TRANSPORTING NO FIELDS WITH KEY admin = 'CHANGED_AT'.
    IF sy-subrc <> 0.
      READ TABLE ls_root-fields TRANSPORTING NO FIELDS WITH KEY admin = 'CHANGED_BY'.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
    ENDIF.
    stamp( is_entity = ls_root iv_index = lv_index iv_create = abap_false iv_total = abap_true ).
    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    IF <ls_inst>-state IS INITIAL.
      <ls_inst>-state = co_operation-update.
    ENDIF.
    IF <ls_inst>-state = co_operation-update.
      mi_luw->modify( iv_entity = ls_root-name iv_key = <ls_inst>-key
                      iv_operation = co_operation-update ir_row = <ls_inst>-row ).
    ENDIF.
  ENDMETHOD.

  METHOD delete_tree.
* the children first into the delta, then the instance: a part goes with
* the whole, without asking its features (the framework's delete)
    DATA ls_assoc TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_child TYPE zif_osd_rap_bo=>ty_entity.
    DATA lt_index TYPE int4_table.
    DATA lv_child TYPE i.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.

    LOOP AT is_entity-assocs INTO ls_assoc WHERE kind = 'C'.
      ls_child = entity_of( ls_assoc-target ).
      lt_index = targets( is_entity = is_entity is_assoc = ls_assoc iv_index = iv_index ).
      LOOP AT lt_index INTO lv_child.
        delete_tree( is_entity = ls_child iv_index = lv_child ).
      ENDLOOP.
    ENDLOOP.
    READ TABLE mt_inst INDEX iv_index ASSIGNING <ls_inst>.
    <ls_inst>-state = co_operation-delete.
    mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                    iv_operation = co_operation-delete ir_row = <ls_inst>-row ).
  ENDMETHOD.

  METHOD create_by.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_target TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_assoc  TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_pair   TYPE zif_osd_rap_bo=>ty_pair.
    DATA ls_inst   TYPE ty_inst.
    DATA lr_rows   TYPE REF TO data.
    DATA lv_index  TYPE i.
    DATA lt_drop   TYPE int4_table.
    DATA lv_row    TYPE i.
    DATA lv_ok     TYPE abap_bool.
    DATA lt_framework TYPE string_table.
    FIELD-SYMBOLS <lt_rows>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <ls_parent> TYPE any.
    FIELD-SYMBOLS <lt_target> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>    TYPE any.
    FIELD-SYMBOLS <lv_from>   TYPE any.
    FIELD-SYMBOLS <lv_to>     TYPE any.

    ls_entity = entity_of( iv_entity ).
    ls_assoc = assoc_of( is_entity = ls_entity iv_assoc = iv_assoc ).
    IF ls_assoc-create = abap_false.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no create by association { iv_assoc }|.
    ENDIF.
    ls_target = entity_of( ls_assoc-target ).
    IF mv_depth = 0.
      start_request( ).
    ENDIF.
    CREATE DATA lr_rows LIKE it_rows.
    ASSIGN lr_rows->* TO <lt_rows>.
    <lt_rows> = it_rows.

* the parent of each row: by key or %cid_ref, enabled, locked; its key
* goes into the row and into the pair fields of every new instance
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_row = sy-tabix.
      lv_index = resolve( is_entity = ls_entity is_input = <ls_row> ).
      IF lv_index = 0.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_row>
                        iv_cause = if_abap_behv=>cause-not_found
                        iv_text = |{ ls_entity-alias } not found|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        INSERT lv_row INTO lt_drop INDEX 1.
        CONTINUE.
      ENDIF.
      IF ls_assoc-feat_create = abap_true
          AND enabled( is_entity = ls_entity iv_index = lv_index iv_group = '%ASSOC' iv_flag = ls_assoc-name ) = abap_false.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_row>
                        iv_cause = if_abap_behv=>cause-disabled
                        iv_text = |Create by association { ls_assoc-name } of { ls_entity-alias } is disabled|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        INSERT lv_row INTO lt_drop INDEX 1.
        CONTINUE.
      ENDIF.
      lock( EXPORTING is_entity = ls_entity iv_index = lv_index is_input = <ls_row>
            IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      IF lv_ok = abap_false.
        INSERT lv_row INTO lt_drop INDEX 1.
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_parent>.
      copy_keys( EXPORTING is_entity = ls_entity is_from = <ls_parent> CHANGING cs_to = <ls_row> ).
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      LOOP AT <lt_target> ASSIGNING <ls_new>.
        LOOP AT ls_assoc-pairs INTO ls_pair.
          ASSIGN COMPONENT ls_pair-source OF STRUCTURE <ls_parent> TO <lv_from>.
          CHECK sy-subrc = 0.
          ASSIGN COMPONENT ls_pair-target OF STRUCTURE <ls_new> TO <lv_to>.
          CHECK sy-subrc = 0.
          <lv_to> = <lv_from>.
        ENDLOOP.
* R8: a child of a draft is a draft (association { create; with draft; })
        set_draft( EXPORTING iv_on = is_draft( <ls_parent> ) CHANGING cs_row = <ls_new> ).
      ENDLOOP.
    ENDLOOP.
    LOOP AT lt_drop INTO lv_row.
      DELETE <lt_rows> INDEX lv_row.
    ENDLOOP.
    IF lines( <lt_rows> ) = 0.
      RETURN.
    ENDIF.

* early numbering of the children: the parent's FOR NUMBERING ... FOR
* CREATE e\_assoc method draws their keys
    IF ls_assoc-numbering = 'E'.
      number_by( EXPORTING is_entity = ls_entity is_assoc = ls_assoc ir_rows = lr_rows
                 CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.

* the parent's key fields of the child are the framework's: kept also
* where they are no key of the child (a UUID child with its parent's UUID)
    LOOP AT ls_assoc-pairs INTO ls_pair.
      APPEND ls_pair-target TO lt_framework.
    ENDLOOP.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      LOOP AT <lt_target> ASSIGNING <ls_new>.
        create_one( EXPORTING is_entity = ls_target is_input = <ls_new> it_framework = lt_framework
                    CHANGING cs_mapped = cs_mapped cs_failed = cs_failed cs_reported = cs_reported ).
      ENDLOOP.
    ENDLOOP.

    IF mv_depth = 0.
      determine( EXPORTING iv_on = 'M' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.
  ENDMETHOD.

  METHOD number_by.
* as NUMBER: every %target row's key comes from the MAPPED line of the
* target with its %cid; a row the method neither maps nor fails is failed
* here, and a failed row is dropped from %target
    DATA ls_target TYPE zif_osd_rap_bo=>ty_entity.
    DATA lr_mapped TYPE REF TO data.
    DATA lv_cid    TYPE string.
    DATA lv_temp   TYPE string.
    DATA lv_count  TYPE i.
    DATA lv_index  TYPE i.
    DATA lv_found  TYPE abap_bool.
    DATA lv_failed TYPE abap_bool.
    DATA lt_drop   TYPE int4_table.
    DATA lt_cids   TYPE string_table.
    DATA lt_temp   TYPE string_table.
    DATA lv_row    TYPE i.
    DATA lv_try    TYPE i.
    DATA lv_slot   TYPE string.
    FIELD-SYMBOLS <lt_rows>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lt_target> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>    TYPE any.
    FIELD-SYMBOLS <lv_cid>    TYPE any.
    FIELD-SYMBOLS <ls_mapped> TYPE any.
    FIELD-SYMBOLS <lt_mapped> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_failed> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>   TYPE any.

    ls_target = entity_of( is_assoc-target ).
    ASSIGN ir_rows->* TO <lt_rows>.
* a %target row without a content ID gets one for the call, so its key can
* be told apart: one that no %target row of the call carries, and only
* those rows lose it again; a caller's %cid, whatever it looks like, is
* kept and comes back in MAPPED (as NUMBER does for a create)
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      LOOP AT <lt_target> ASSIGNING <ls_new>.
        APPEND text_of( is_row = <ls_new> iv_component = '%CID' ) TO lt_cids.
      ENDLOOP.
    ENDLOOP.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_row = sy-tabix.
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      LOOP AT <lt_target> ASSIGNING <ls_new>.
        lv_index = sy-tabix.
        ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_new> TO <lv_cid>.
        IF sy-subrc <> 0 OR <lv_cid> IS NOT INITIAL.
          CONTINUE.
        ENDIF.
        lv_try = 0.
        DO.
          lv_count = lv_count + 1.
          lv_temp = |%OSD-CBA-{ lv_count }-{ lv_try }|.
          READ TABLE lt_cids TRANSPORTING NO FIELDS WITH KEY table_line = lv_temp.
          IF sy-subrc <> 0.
            EXIT.
          ENDIF.
          lv_try = lv_try + 1.
        ENDDO.
        <lv_cid> = lv_temp.
        APPEND lv_temp TO lt_cids.
        lv_slot = |{ lv_row }/{ lv_index }|.
        APPEND lv_slot TO lt_temp.
      ENDLOOP.
    ENDLOOP.
    lr_mapped = mo_bo->new_response( 'MAPPED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    call_pool( EXPORTING is_entity = is_entity iv_name = |%NUMBERING\\{ is_assoc-name }| ir_rows = ir_rows ir_mapped = lr_mapped
               CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ASSIGN COMPONENT ls_target-response OF STRUCTURE <ls_mapped> TO <lt_mapped>.
    ASSIGN COMPONENT ls_target-response OF STRUCTURE cs_failed TO <lt_failed>.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_row = sy-tabix.
      ASSIGN COMPONENT '%TARGET' OF STRUCTURE <ls_row> TO <lt_target>.
      CLEAR lt_drop.
      LOOP AT <lt_target> ASSIGNING <ls_new>.
        lv_index = sy-tabix.
        lv_cid = text_of( is_row = <ls_new> iv_component = '%CID' ).
        lv_found = abap_false.
        lv_failed = abap_false.
        IF <lt_mapped> IS ASSIGNED.
          LOOP AT <lt_mapped> ASSIGNING <ls_line>.
            IF text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid.
              copy_keys( EXPORTING is_entity = ls_target is_from = <ls_line> CHANGING cs_to = <ls_new> ).
              lv_found = abap_true.
            ENDIF.
          ENDLOOP.
        ENDIF.
        IF lv_found = abap_false AND <lt_failed> IS ASSIGNED.
          LOOP AT <lt_failed> ASSIGNING <ls_line>.
            IF text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid.
              lv_failed = abap_true.
            ENDIF.
          ENDLOOP.
        ENDIF.
        lv_slot = |{ lv_row }/{ lv_index }|.
        READ TABLE lt_temp TRANSPORTING NO FIELDS WITH KEY table_line = lv_slot.
        IF sy-subrc = 0.
          ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_new> TO <lv_cid>.
          CLEAR <lv_cid>.
        ENDIF.
        IF lv_found = abap_false AND lv_failed = abap_false.
          fail( EXPORTING is_entity = ls_target is_input = <ls_new>
                          iv_cause = if_abap_behv=>cause-unspecific
                          iv_text = |Early numbering of { ls_target-alias } gave no key and no failure for an instance|
                          iv_op = '%CREATE'
                CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
          lv_failed = abap_true.
        ENDIF.
        IF lv_failed = abap_true.
          INSERT lv_index INTO lt_drop INDEX 1.
        ENDIF.
      ENDLOOP.
      LOOP AT lt_drop INTO lv_index.
        DELETE <lt_target> INDEX lv_index.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD read_by.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_target   TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_assoc    TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_inst     TYPE ty_inst.
    DATA ls_src      TYPE ty_inst.
    DATA lv_index    TYPE i.
    DATA lv_found    TYPE i.
    DATA lt_index    TYPE int4_table.
    DATA lr_reported TYPE REF TO data.
    FIELD-SYMBOLS <ls_key>      TYPE any.
    FIELD-SYMBOLS <ls_src>      TYPE any.
    FIELD-SYMBOLS <ls_row>      TYPE any.
    FIELD-SYMBOLS <ls_out>      TYPE any.
    FIELD-SYMBOLS <ls_link>     TYPE any.
    FIELD-SYMBOLS <ls_side>     TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    ls_entity = entity_of( iv_entity ).
    ls_assoc = assoc_of( is_entity = ls_entity iv_assoc = iv_assoc ).
    ls_target = entity_of( ls_assoc-target ).
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
      lt_index = targets( is_entity = ls_entity is_assoc = ls_assoc iv_index = lv_index ).
      READ TABLE mt_inst INDEX lv_index INTO ls_src.
      ASSIGN ls_src-row->* TO <ls_src>.
      LOOP AT lt_index INTO lv_found.
        READ TABLE mt_inst INDEX lv_found INTO ls_inst.
        ASSIGN ls_inst-row->* TO <ls_row>.
        APPEND INITIAL LINE TO ct_result ASSIGNING <ls_out>.
        MOVE-CORRESPONDING <ls_row> TO <ls_out>.
        APPEND INITIAL LINE TO ct_link ASSIGNING <ls_link>.
        ASSIGN COMPONENT 'SOURCE' OF STRUCTURE <ls_link> TO <ls_side>.
        IF sy-subrc = 0.
          copy_keys( EXPORTING is_entity = ls_entity is_from = <ls_src> CHANGING cs_to = <ls_side> ).
        ENDIF.
        ASSIGN COMPONENT 'TARGET' OF STRUCTURE <ls_link> TO <ls_side>.
        IF sy-subrc = 0.
          copy_keys( EXPORTING is_entity = ls_target is_from = <ls_row> CHANGING cs_to = <ls_side> ).
        ENDIF.
      ENDLOOP.
    ENDLOOP.
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
    DATA lr_rows   TYPE REF TO data.
    FIELD-SYMBOLS <ls_input> TYPE any.
    FIELD-SYMBOLS <lt_rows>  TYPE ANY TABLE.

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
* early numbering: the pool draws the keys of the new instances first
    IF iv_operation = co_operation-create AND ls_entity-numbering = 'E'.
      number( EXPORTING is_entity = ls_entity it_rows = it_rows
              IMPORTING er_rows = lr_rows
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ELSE.
      CREATE DATA lr_rows LIKE it_rows.
      ASSIGN lr_rows->* TO <lt_rows>.
      <lt_rows> = it_rows.
    ENDIF.
    ASSIGN lr_rows->* TO <lt_rows>.
    LOOP AT <lt_rows> ASSIGNING <ls_input>.
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
    DATA lr_mapped   TYPE REF TO data.
    DATA lv_ok       TYPE abap_bool.
    DATA lt_inst     TYPE string_table.
    FIELD-SYMBOLS <ls_key>  TYPE any.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_keys> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_new>  TYPE any.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <ls_mapped> TYPE any.

    ls_entity = entity_of( iv_entity ).
    lv_name = to_upper( iv_action ).
    LOOP AT ls_entity-callables INTO ls_callable WHERE ( kind = 'A' OR kind = 'X' OR kind = 'E' ) AND name = lv_name.
      lv_found = abap_true.
      EXIT.
    ENDLOOP.
    IF lv_found = abap_false.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |{ ls_entity-alias } has no action { iv_action }|.
    ENDIF.
* R6: an internal action is the business object's own: only its handlers,
* running now in this runtime (IN LOCAL MODE), execute it
    IF ls_callable-internal = abap_true AND mv_depth = 0.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason =
        |Action { iv_action } of { ls_entity-alias } is internal: only the business object's own handlers execute it, IN LOCAL MODE|.
    ENDIF.
    IF cs_mapped IS SUPPLIED.
      GET REFERENCE OF cs_mapped INTO lr_mapped.
    ELSE.
      lr_mapped = mo_bo->new_response( 'MAPPED' ).
    ENDIF.
    ASSIGN lr_mapped->* TO <ls_mapped>.

    IF mv_depth = 0.
      start_request( ).
    ENDIF.
    lr_rows = mo_bo->new_rows( ls_entity-name ).
    ASSIGN lr_rows->* TO <lt_rows>.
    CREATE DATA lr_keys LIKE it_keys.
    ASSIGN lr_keys->* TO <lt_keys>.
    LOOP AT it_keys ASSIGNING <ls_key>.
* R6: a factory action maps its new instance under the row's %cid, so a
* row without one is refused before the handler runs
      IF ls_callable-factory = abap_true AND text_of( is_row = <ls_key> iv_component = '%CID' ) IS INITIAL.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-unspecific
                        iv_text = |Factory action { iv_action } of { ls_entity-alias } needs a %cid for the new instance|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        CONTINUE.
      ENDIF.
      lv_index = resolve( is_entity = ls_entity is_input = <ls_key> ).
      IF lv_index = 0.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-not_found
                        iv_text = |{ ls_entity-alias } not found|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        CONTINUE.
      ENDIF.
* R8: Edit, Activate, Discard, Resume are the framework's
      IF ls_callable-kind = 'E'.
        draft_action( EXPORTING is_entity = ls_entity iv_action = lv_name iv_index = lv_index is_key = <ls_key>
                      CHANGING ct_result = ct_result cs_failed = cs_failed cs_reported = cs_reported ).
        CONTINUE.
      ENDIF.
      IF ls_callable-features = abap_true
          AND enabled( is_entity = ls_entity iv_index = lv_index iv_group = '%ACTION' iv_flag = lv_name ) = abap_false.
        fail( EXPORTING is_entity = ls_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-disabled
                        iv_text = |Action { iv_action } of { ls_entity-alias } is disabled|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        CONTINUE.
      ENDIF.
      lock( EXPORTING is_entity = ls_entity iv_index = lv_index is_input = <ls_key>
            IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      IF lv_ok = abap_false.
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_row>.
      APPEND <ls_row> TO <lt_rows>.
      APPEND ls_inst-key TO lt_inst.
* the handler sees the key also where the caller gave a %cid_ref
      APPEND <ls_key> TO <lt_keys> ASSIGNING <ls_new>.
      copy_keys( EXPORTING is_entity = ls_entity is_from = <ls_row> CHANGING cs_to = <ls_new> ).
    ENDLOOP.
    IF lines( <lt_rows> ) = 0.
      RETURN.
    ENDIF.

    IF ls_callable-kind = 'X'.
      determine_action( EXPORTING is_entity = ls_entity is_callable = ls_callable it_keys = lt_inst
                        CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ELSE.
      GET REFERENCE OF ct_result INTO lr_result.
      invoke( EXPORTING is_entity = ls_entity is_callable = ls_callable
                        ir_rows = lr_rows ir_keys = lr_keys ir_result = lr_result ir_mapped = lr_mapped
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      IF ls_callable-factory = abap_true.
        check_factory( EXPORTING is_entity = ls_entity is_callable = ls_callable it_keys = <lt_keys>
                       CHANGING cs_mapped = <ls_mapped> cs_failed = cs_failed cs_reported = cs_reported ).
      ENDIF.
    ENDIF.
    IF mv_depth = 0.
      determine( EXPORTING iv_on = 'M' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ENDIF.
  ENDMETHOD.

  METHOD determine_action.
* R6: determinations on save first, then validations, each in the order
* declared (the save sequence's order, this runtime's choice); a member runs
* for the instances whose triggers hold since the last save, a member
* declared ( always ) for all of them. Triggers are not consumed: the save
* runs a determination again if they still hold
    DATA ls_member   TYPE zif_osd_rap_bo=>ty_member.
    DATA ls_member_c TYPE zif_osd_rap_bo=>ty_callable.
    DATA ls_inst     TYPE ty_inst.
    DATA lr_rows     TYPE REF TO data.
    DATA lv_kind     TYPE zif_osd_rap_bo=>ty_flag.
    DATA lv_found    TYPE abap_bool.
    DATA ls_owner    TYPE zif_osd_rap_bo=>ty_entity.
    DATA lt_roots    TYPE int4_table.
    DATA lt_tree     TYPE string_table.
    DATA lv_tree_done TYPE abap_bool.
    DATA lv_entry    TYPE string.
    DATA lv_name     TYPE string.
    DATA lv_text     TYPE string.
    DATA lv_index    TYPE i.
    FIELD-SYMBOLS <lt_rows> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>  TYPE any.

    APPEND |DETERMINE ACTION { is_callable-name }| TO mt_trace.
    DO 2 TIMES.
      IF sy-index = 1.
        lv_kind = 'D'.
      ELSE.
        lv_kind = 'V'.
      ENDIF.
      LOOP AT is_callable-members INTO ls_member WHERE kind = lv_kind.
* R11: a member of another entity (the carrier singleton's Prepare runs
* Carrier~validateName) runs for that entity's instances below the keyed ones
        ls_owner = is_entity.
        IF ls_member-entity IS NOT INITIAL AND ls_member-entity <> is_entity-name.
          ls_owner = entity_of( ls_member-entity ).
        ENDIF.
        lv_found = abap_false.
        LOOP AT ls_owner-callables INTO ls_member_c WHERE kind = lv_kind AND name = ls_member-name.
          lv_found = abap_true.
          EXIT.
        ENDLOOP.
        IF lv_found = abap_false.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason =
            |{ is_entity-alias }~{ is_callable-name }: no member { ls_owner-alias }~{ ls_member-name }|.
        ENDIF.
        lr_rows = mo_bo->new_rows( ls_owner-name ).
        ASSIGN lr_rows->* TO <lt_rows>.
        IF ls_owner-name = is_entity-name.
          LOOP AT mt_inst INTO ls_inst WHERE entity = is_entity-name.
            READ TABLE it_keys TRANSPORTING NO FIELDS WITH KEY table_line = ls_inst-key.
            IF sy-subrc <> 0.
              CONTINUE.
            ENDIF.
* R8: Prepare checks a draft whole (unmeasured: a system tracks the
* draft's changed fields and may run fewer)
            IF ls_member-always = abap_false AND NOT ls_inst-key CP 'D|*'
                AND triggered( is_callable = ls_member_c is_inst = ls_inst ) = abap_false.
              CONTINUE.
            ENDIF.
            ASSIGN ls_inst-row->* TO <ls_row>.
            APPEND <ls_row> TO <lt_rows>.
          ENDLOOP.
        ELSE.
          IF lv_tree_done = abap_false.
            lv_tree_done = abap_true.
            LOOP AT mt_inst INTO ls_inst WHERE entity = is_entity-name AND state <> co_operation-delete.
              lv_index = sy-tabix.
              READ TABLE it_keys TRANSPORTING NO FIELDS WITH KEY table_line = ls_inst-key.
              IF sy-subrc = 0.
                APPEND lv_index TO lt_roots.
              ENDIF.
            ENDLOOP.
            LOOP AT lt_roots INTO lv_index.
              draft_tree( EXPORTING is_entity = is_entity iv_index = lv_index CHANGING ct_tree = lt_tree ).
            ENDLOOP.
          ENDIF.
          LOOP AT lt_tree INTO lv_entry.
            SPLIT lv_entry AT '|' INTO lv_name lv_text.
            CHECK lv_name = ls_owner-name.
            lv_index = lv_text.
            READ TABLE mt_inst INDEX lv_index INTO ls_inst.
            CHECK sy-subrc = 0 AND ls_inst-state <> co_operation-delete.
            IF ls_member-always = abap_false AND NOT ls_inst-key CP 'D|*'
                AND triggered( is_callable = ls_member_c is_inst = ls_inst ) = abap_false.
              CONTINUE.
            ENDIF.
            ASSIGN ls_inst-row->* TO <ls_row>.
            APPEND <ls_row> TO <lt_rows>.
          ENDLOOP.
        ENDIF.
        IF lines( <lt_rows> ) > 0.
          invoke( EXPORTING is_entity = ls_owner is_callable = ls_member_c ir_rows = lr_rows
                  CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        ENDIF.
      ENDLOOP.
    ENDDO.
  ENDMETHOD.

  METHOD check_factory.
    DATA lv_cid  TYPE string.
    DATA lv_key  TYPE string.
    DATA lv_done TYPE abap_bool.
    FIELD-SYMBOLS <ls_key>    TYPE any.
    FIELD-SYMBOLS <lt_mapped> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_failed> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>   TYPE any.

    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_mapped TO <lt_mapped>.
    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_failed TO <lt_failed>.
    IF <lt_mapped> IS NOT ASSIGNED OR <lt_failed> IS NOT ASSIGNED.
      RETURN.
    ENDIF.
    LOOP AT it_keys ASSIGNING <ls_key>.
      lv_cid = text_of( is_row = <ls_key> iv_component = '%CID' ).
      lv_key = key_of( is_entity = is_entity is_row = <ls_key> ).
      lv_done = abap_false.
      LOOP AT <lt_mapped> ASSIGNING <ls_line>.
        IF lv_cid IS NOT INITIAL AND text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid.
          lv_done = abap_true.
          EXIT.
        ENDIF.
      ENDLOOP.
      LOOP AT <lt_failed> ASSIGNING <ls_line>.
        IF lv_done = abap_true.
          EXIT.
        ENDIF.
        IF ( lv_cid IS NOT INITIAL AND text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid )
            OR key_of( is_entity = is_entity is_row = <ls_line> ) = lv_key.
          lv_done = abap_true.
        ENDIF.
      ENDLOOP.
      IF lv_done = abap_false.
        fail( EXPORTING is_entity = is_entity is_input = <ls_key>
                        iv_cause = if_abap_behv=>cause-unspecific
                        iv_text = |Factory action { is_callable-name } of { is_entity-alias } gave no instance and no failure|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      ENDIF.
    ENDLOOP.
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
* R8: determinations on save run when a draft is activated, not on it
            IF iv_on = 'S' AND ls_inst-key CP 'D|*'.
              CONTINUE.
            ENDIF.
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
* R8: a draft is validated on Prepare and when it is activated
          IF ls_inst-key CP 'D|*'.
            CONTINUE.
          ENDIF.
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
                     ir_failed = lr_failed ir_reported = lr_reported ir_mapped = ir_mapped ).
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

  METHOD call_pool.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lo_handler  TYPE REF TO object.
    DATA lx_error    TYPE REF TO cx_root.
    DATA lv_top      TYPE i.

    APPEND |{ iv_name } { is_entity-alias }| TO mt_trace.
    lo_handler = handler_of( is_entity ).
    GET REFERENCE OF cs_failed INTO lr_failed.
    GET REFERENCE OF cs_reported INTO lr_reported.
    APPEND me TO gt_active.
    mv_depth = mv_depth + 1.
    TRY.
        mo_bo->call( io_handler = lo_handler iv_entity = is_entity-name iv_name = iv_name
                     ir_rows = ir_rows ir_result = ir_result ir_mapped = ir_mapped
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
  ENDMETHOD.

  METHOD enabled.
* IN LOCAL MODE (a handler of this runtime is running) skips feature control
    DATA lr_rows     TYPE REF TO data.
    DATA lr_result   TYPE REF TO data.
    DATA lr_failed   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA ls_inst     TYPE ty_inst.
    FIELD-SYMBOLS <lt_rows>     TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_result>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_result>   TYPE any.
    FIELD-SYMBOLS <ls_row>      TYPE any.
    FIELD-SYMBOLS <ls_group>    TYPE any.
    FIELD-SYMBOLS <lv_flag>     TYPE any.
    FIELD-SYMBOLS <ls_failed>   TYPE any.
    FIELD-SYMBOLS <ls_reported> TYPE any.

    rv_enabled = abap_true.
    IF is_entity-features = abap_false OR mv_depth > 0.
      RETURN.
    ENDIF.
    READ TABLE mt_inst INDEX iv_index INTO ls_inst.
    lr_rows = mo_bo->new_rows( is_entity-name ).
    ASSIGN lr_rows->* TO <lt_rows>.
    ASSIGN ls_inst-row->* TO <ls_row>.
    APPEND <ls_row> TO <lt_rows>.
    lr_result = mo_bo->new_table( iv_entity = is_entity-name iv_kind = 'FEATURES RESULT' ).
    ASSIGN lr_result->* TO <lt_result>.
* what the method reports is its own business: an operation it does not
* answer for stays enabled
    lr_failed = mo_bo->new_response( 'FAILED' ).
    lr_reported = mo_bo->new_response( 'REPORTED' ).
    ASSIGN lr_failed->* TO <ls_failed>.
    ASSIGN lr_reported->* TO <ls_reported>.
    call_pool( EXPORTING is_entity = is_entity iv_name = '%FEATURES' ir_rows = lr_rows ir_result = lr_result
               CHANGING cs_failed = <ls_failed> cs_reported = <ls_reported> ).
    LOOP AT <lt_result> ASSIGNING <ls_result>.
      IF key_of( is_entity = is_entity is_row = <ls_result> ) <> ls_inst-key.
        CONTINUE.
      ENDIF.
      IF iv_group IS INITIAL.
        ASSIGN COMPONENT iv_flag OF STRUCTURE <ls_result> TO <lv_flag>.
      ELSE.
        ASSIGN COMPONENT iv_group OF STRUCTURE <ls_result> TO <ls_group>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT iv_flag OF STRUCTURE <ls_group> TO <lv_flag>.
      ENDIF.
      IF sy-subrc = 0 AND <lv_flag> = if_abap_behv=>fc-o-disabled.
        rv_enabled = abap_false.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD number.
* the rows go to the pool's FOR NUMBERING method; each key it maps for a
* content ID is the key of that create. A row it fails is dropped with the
* method's FAILED and REPORTED. A row it neither maps nor fails breaks the
* method's contract (every input %cid is in MAPPED or FAILED): it is failed
* here and not created with the key it came with
    DATA lr_mapped TYPE REF TO data.
    DATA lv_cid    TYPE string.
    DATA lv_temp   TYPE string.
    DATA lv_index  TYPE i.
    DATA lv_try    TYPE i.
    DATA lv_found  TYPE abap_bool.
    DATA lv_failed TYPE abap_bool.
    DATA lt_drop   TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
    DATA lt_cids   TYPE string_table.
    DATA lt_temp   TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
    FIELD-SYMBOLS <lt_rows>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <ls_mapped> TYPE any.
    FIELD-SYMBOLS <lt_mapped> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_failed> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_line>   TYPE any.
    FIELD-SYMBOLS <lv_cid>    TYPE any.

    CREATE DATA er_rows LIKE it_rows.
    ASSIGN er_rows->* TO <lt_rows>.
    <lt_rows> = it_rows.
* a row without a content ID gets one for the call, so its key can be told
* apart: one no row of the call carries, and only those rows lose it again
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      APPEND text_of( is_row = <ls_row> iv_component = '%CID' ) TO lt_cids.
    ENDLOOP.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_index = sy-tabix.
      ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_row> TO <lv_cid>.
      IF sy-subrc <> 0 OR <lv_cid> IS NOT INITIAL.
        CONTINUE.
      ENDIF.
      lv_try = 0.
      DO.
        lv_temp = |%OSD-NUMBERING-{ lv_index }-{ lv_try }|.
        READ TABLE lt_cids TRANSPORTING NO FIELDS WITH KEY table_line = lv_temp.
        IF sy-subrc <> 0.
          EXIT.
        ENDIF.
        lv_try = lv_try + 1.
      ENDDO.
      <lv_cid> = lv_temp.
      APPEND lv_temp TO lt_cids.
      APPEND lv_index TO lt_temp.
    ENDLOOP.
    lr_mapped = mo_bo->new_response( 'MAPPED' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    call_pool( EXPORTING is_entity = is_entity iv_name = '%NUMBERING' ir_rows = er_rows ir_mapped = lr_mapped
               CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    ASSIGN COMPONENT is_entity-response OF STRUCTURE <ls_mapped> TO <lt_mapped>.
    ASSIGN COMPONENT is_entity-response OF STRUCTURE cs_failed TO <lt_failed>.
    LOOP AT <lt_rows> ASSIGNING <ls_row>.
      lv_index = sy-tabix.
      lv_cid = text_of( is_row = <ls_row> iv_component = '%CID' ).
      lv_found = abap_false.
      lv_failed = abap_false.
      IF <lt_mapped> IS ASSIGNED.
        LOOP AT <lt_mapped> ASSIGNING <ls_line>.
          IF text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid.
            copy_keys( EXPORTING is_entity = is_entity is_from = <ls_line> CHANGING cs_to = <ls_row> ).
            lv_found = abap_true.
          ENDIF.
        ENDLOOP.
      ENDIF.
      IF lv_found = abap_false AND <lt_failed> IS ASSIGNED.
        LOOP AT <lt_failed> ASSIGNING <ls_line>.
          IF text_of( is_row = <ls_line> iv_component = '%CID' ) = lv_cid.
            lv_failed = abap_true.
          ENDIF.
        ENDLOOP.
      ENDIF.
      READ TABLE lt_temp TRANSPORTING NO FIELDS WITH KEY table_line = lv_index.
      IF sy-subrc = 0.
        ASSIGN COMPONENT '%CID' OF STRUCTURE <ls_row> TO <lv_cid>.
        CLEAR <lv_cid>.
      ENDIF.
      IF lv_found = abap_false AND lv_failed = abap_false.
        fail( EXPORTING is_entity = is_entity is_input = <ls_row>
                        iv_cause = if_abap_behv=>cause-unspecific
                        iv_text = |Early numbering of { is_entity-alias } gave no key and no failure for an instance|
                        iv_op = '%CREATE'
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        lv_failed = abap_true.
      ENDIF.
      IF lv_failed = abap_true.
        INSERT lv_index INTO lt_drop INDEX 1.
      ENDIF.
    ENDLOOP.
    LOOP AT lt_drop INTO lv_index.
      DELETE <lt_rows> INDEX lv_index.
    ENDLOOP.
  ENDMETHOD.

  METHOD stamp.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_now   TYPE timestampl.
    DATA lv_old   TYPE timestampl.
    DATA lv_short TYPE timestamp.
    DATA lv_decimals TYPE i.
    FIELD-SYMBOLS <ls_inst>  TYPE ty_inst.
    FIELD-SYMBOLS <ls_row>   TYPE any.
    FIELD-SYMBOLS <lv_value> TYPE any.

    READ TABLE mt_inst INDEX iv_index ASSIGNING <ls_inst>.
    ASSIGN <ls_inst>-row->* TO <ls_row>.
    LOOP AT is_entity-fields INTO ls_field WHERE admin IS NOT INITIAL.
      IF iv_create = abap_false AND ( ls_field-admin = 'CREATED_AT' OR ls_field-admin = 'CREATED_BY' ).
        CONTINUE.
      ENDIF.
* R5: a change below the root moves the root's total stamp only
      IF iv_total = abap_true AND ls_field-admin <> 'CHANGED_AT' AND ls_field-admin <> 'CHANGED_BY'.
        CONTINUE.
      ENDIF.
* R8: a change of a draft leaves the total stamp (Activate compares it)
      IF ( ls_field-admin = 'CHANGED_AT' OR ls_field-admin = 'CHANGED_BY' ) AND is_draft( <ls_row> ) = abap_true.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_value>.
      CHECK sy-subrc = 0.
      IF ls_field-admin CP '*_BY'.
* R9: the request's user (SY-UNAME without a credential, ZCL_OSD_LOGON)
        <lv_value> = zcl_osd_logon=>user( ).
      ELSE.
        GET TIME STAMP FIELD lv_now.
        lv_old = <lv_value>.
        IF lv_now <= gv_stamp.
          lv_now = later( gv_stamp ).
        ENDIF.
        IF lv_now <= lv_old.
          lv_now = later( lv_old ).
        ENDIF.
        lv_now = apart( iv_stamp = lv_now iv_old = lv_old ).
        gv_stamp = lv_now.
        DESCRIBE FIELD <lv_value> DECIMALS lv_decimals.
        IF lv_decimals = 0.
* a field of seconds takes the second it falls in, and still has to move:
* the next second, by the calendar
          lv_short = floor( lv_now ).
          IF lv_short <= lv_old AND iv_create = abap_false.
            lv_short = floor( lv_old ).
            lv_short = cl_abap_tstmp=>add( tstmp = lv_short secs = 1 ).
          ENDIF.
          <lv_value> = lv_short.
        ELSE.
          <lv_value> = lv_now.
        ENDIF.
      ENDIF.
      mark( iv_index = iv_index iv_field = ls_field-name ).
    ENDLOOP.
  ENDMETHOD.

  METHOD later.
* the next 100 ns after a TIMESTAMPL, carried into the next second by the
* calendar (cl_abap_tstmp=>add), never to a 60th second
    DATA lv_second TYPE timestamp.
    DATA lv_fraction TYPE timestampl.

    lv_second = floor( iv_stamp ).
    lv_fraction = iv_stamp - lv_second.
    IF lv_fraction < '0.9999999'.
      rv_stamp = iv_stamp + '0.0000001'.
    ELSE.
      rv_stamp = cl_abap_tstmp=>add( tstmp = lv_second secs = 1 ).
    ENDIF.
  ENDMETHOD.

  METHOD apart.
* step away from iv_stamp by 100 ns, 200 ns, 400 ns ... until the double of
* the result is above the double of iv_old; about 16 steps cross the 4 ms
* a double resolves there. A step past the second takes the next second by
* the calendar, which a double always tells apart.
    DATA lv_new    TYPE f.
    DATA lv_old    TYPE f.
    DATA lv_step   TYPE timestampl.
    DATA lv_second TYPE timestamp.
    DATA lv_fraction TYPE timestampl.

    rv_stamp = iv_stamp.
    lv_old = iv_old.
    lv_new = rv_stamp.
    lv_step = '0.0000001'.
    WHILE lv_new <= lv_old AND rv_stamp IS NOT INITIAL.
      lv_second = floor( iv_stamp ).
      lv_fraction = iv_stamp - lv_second + lv_step.
      IF lv_fraction < 1.
        rv_stamp = lv_second + lv_fraction.
      ELSE.
        rv_stamp = cl_abap_tstmp=>add( tstmp = lv_second secs = 1 ).
        RETURN.
      ENDIF.
      lv_new = rv_stamp.
      lv_step = lv_step * 2.
    ENDWHILE.
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
        stamp( is_entity = is_entity iv_index = lv_index iv_create = abap_false ).
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

  METHOD savers.
    DATA lt_names TYPE string_table.
    DATA lv_name  TYPE string.
    DATA ls_saver TYPE zif_osd_rap_bo=>ty_saver.
    DATA lo_saver TYPE REF TO cl_abap_behavior_saver.

    IF mv_savers = abap_false.
      LOOP AT ms_model-savers INTO ls_saver.
        APPEND ls_saver-name TO lt_names.
      ENDLOOP.
      IF lt_names IS INITIAL AND ms_model-saver IS NOT INITIAL.
        APPEND ms_model-saver TO lt_names.
      ENDIF.
      LOOP AT lt_names INTO lv_name.
        TRY.
            CREATE OBJECT lo_saver TYPE (lv_name).
          CATCH cx_sy_create_object_error.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |saver { lv_name } not found|.
        ENDTRY.
        APPEND lo_saver TO mt_savers.
      ENDLOOP.
      mv_savers = abap_true.
    ENDIF.
    rt_savers = mt_savers.
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
    DATA lt_savers LIKE mt_savers.
    DATA lo_saver  TYPE REF TO cl_abap_behavior_saver.
    DATA lv_before TYPE i.
    DATA lx_error  TYPE REF TO zcx_osd_rap.
    DATA lx_root   TYPE REF TO cx_root.
    DATA lv_text   TYPE string.
    DATA lv_business TYPE abap_bool.

    ev_saved = abap_false.
    CLEAR mt_late.
    lt_savers = savers( ).
    lv_before = count_failed( cs_failed ).
    CLEAR mt_done.

    APPEND 'FINALIZE' TO mt_trace.
    determine( EXPORTING iv_on = 'S' CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
    LOOP AT lt_savers INTO lo_saver.
      lo_saver->finalize( ).
    ENDLOOP.

    IF count_failed( cs_failed ) = lv_before.
      APPEND 'CHECK_BEFORE_SAVE' TO mt_trace.
      validate( CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      LOOP AT lt_savers INTO lo_saver.
        lo_saver->check_before_save( ).
      ENDLOOP.
    ENDIF.

    IF count_failed( cs_failed ) > lv_before.
* nothing was written; the buffer stays for the caller to correct
      APPEND 'CLEANUP_FINALIZE' TO mt_trace.
      LOOP AT lt_savers INTO lo_saver.
        lo_saver->cleanup_finalize( ).
      ENDLOOP.
      IF iv_end_luw = abap_true.
        ROLLBACK WORK.
        unlock( ).
      ENDIF.
      RETURN.
    ENDIF.

* R10: adjust_numbers of the savers that redefine it, with MAPPED LATE of
* the instances created under a preliminary key (late numbering)
    APPEND 'ADJUST_NUMBERS' TO mt_trace.

    APPEND 'SAVE' TO mt_trace.
* R7: a failure in the save ends the transaction here: the LUW is rolled
* back (when the runtime owns it), the savers' cleanup runs and the buffer is
* discarded -- the instances were already checked, so there is nothing a
* caller could correct, and a buffer half written must not be saved again.
* A saver's failure is the caller's to show (BUSINESS), a refused database
* write a technical error.
    TRY.
* R10: inside the save's failure handling: a mapping refused here writes nothing
        late_numbers( CHANGING cs_reported = cs_reported ).
        persist( ).
        save_savers( CHANGING cs_reported = cs_reported ).
      CATCH zcx_osd_rap INTO lx_error.
        lv_text = lx_error->get_text( ).
        lv_business = abap_false.
      CATCH cx_root INTO lx_root.
        lv_text = |{ lx_root->get_text( ) }|.
        IF lv_text IS INITIAL.
          lv_text = |save of { ms_model-bdef } failed in a saver|.
        ENDIF.
        lv_business = abap_true.
    ENDTRY.
    IF lv_text IS NOT INITIAL OR lx_error IS BOUND.
      IF iv_end_luw = abap_true.
        ROLLBACK WORK.
        unlock( ).
      ENDIF.
      APPEND 'CLEANUP' TO mt_trace.
      LOOP AT lt_savers INTO lo_saver.
        lo_saver->cleanup( ).
      ENDLOOP.
      mi_luw->discard( ).
      CLEAR: mt_inst, mt_done.
      RAISE EXCEPTION TYPE zcx_osd_rap
        EXPORTING
          iv_reason   = lv_text
          iv_save     = abap_true
          iv_business = lv_business.
    ENDIF.
    IF iv_end_luw = abap_true.
      COMMIT WORK.
      unlock( ).
    ENDIF.

    APPEND 'CLEANUP' TO mt_trace.
    LOOP AT lt_savers INTO lo_saver.
      lo_saver->cleanup( ).
    ENDLOOP.
* cleanup resets the transactional buffer: the next transaction reads the
* database again, and a %cid of this one is not a reference any more
    mi_luw->discard( ).
    CLEAR: mt_inst, mt_done.
    ev_saved = abap_true.
  ENDMETHOD.

  METHOD augment.
    DATA lv_top   TYPE i.
    DATA lx_error TYPE REF TO cx_root.

    APPEND |AUGMENT { iv_entity }| TO mt_trace.
    APPEND me TO gt_active.
    TRY.
        io_augment->augment( EXPORTING iv_entity = iv_entity ir_create = ir_create ir_update = ir_update
                             IMPORTING ev_failed = ev_failed et_messages = et_messages ).
      CATCH cx_root INTO lx_error.
        lv_top = lines( gt_active ).
        DELETE gt_active INDEX lv_top.
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |augment of { iv_entity }: { lx_error->get_text( ) }|.
    ENDTRY.
    lv_top = lines( gt_active ).
    DELETE gt_active INDEX lv_top.
  ENDMETHOD.

  METHOD late_key.
* the preliminary key counts down from the largest value of the key's type,
* skipping every key an active instance, a draft or the buffer has: the
* final key adjust_numbers draws counts up from the number range, so the two
* do not meet (unmeasured: on a system the key may stay initial and %pid
* alone names the instance; a key is what OData addresses, so one is given)
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_kind  TYPE c LENGTH 1.
    DATA lv_len   TYPE i.
    DATA lv_k     TYPE i.
    DATA lv_value TYPE string.
    DATA lv_num   TYPE string.
    DATA lv_int   TYPE i.
    DATA lv_tail  TYPE i.
    DATA lv_x16   TYPE x LENGTH 16.
    DATA lr_probe TYPE REF TO data.
    DATA lv_taken TYPE abap_bool.
    DATA lv_keys  TYPE i.
    FIELD-SYMBOLS <lv_key>   TYPE any.
    FIELD-SYMBOLS <lv_pid>   TYPE any.
    FIELD-SYMBOLS <ls_probe> TYPE any.
    FIELD-SYMBOLS <lv_probe> TYPE any.

    ASSIGN COMPONENT '%PID' OF STRUCTURE cs_row TO <lv_pid>.
    IF sy-subrc = 0 AND <lv_pid> IS INITIAL.
      TRY.
          lv_x16 = cl_system_uuid=>create_uuid_x16_static( ).
        CATCH cx_uuid_error.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no %pid for { is_entity-name }|.
      ENDTRY.
      <lv_pid> = lv_x16.
    ENDIF.
    LOOP AT is_entity-fields INTO ls_field WHERE key = abap_true.
      lv_keys = lv_keys + 1.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_key>.
      IF <lv_key> IS NOT INITIAL.
        RETURN.
      ENDIF.
    ENDLOOP.
    IF lv_keys <> 1.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |late numbering of { is_entity-name }: a preliminary key for more than one key field is outside R10|.
    ENDIF.
    DESCRIBE FIELD <lv_key> TYPE lv_kind OUTPUT-LENGTH lv_len.
    IF lv_kind <> 'N' AND lv_kind <> 'C' AND lv_kind <> 'I'.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |late numbering of { is_entity-name }: a preliminary key of type { lv_kind } is outside R10|.
    ENDIF.
    lr_probe = new_row( is_entity ).
    ASSIGN lr_probe->* TO <ls_probe>.
    ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_probe> TO <lv_probe>.
    IF lv_kind = 'I'.
      lv_len = 9.
    ENDIF.
    lv_tail = lv_len.
    IF lv_tail > 9.
      lv_tail = 9.
    ENDIF.
    IF lv_tail < 4.
      RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |late numbering of { is_entity-name }: a key of { lv_tail } digits leaves no room for the preliminary keys (the top 1000)|.
    ENDIF.
    DO 1000 TIMES.
      lv_k = sy-index - 1.
      lv_int = 1.
      DO lv_tail TIMES.
        lv_int = lv_int * 10.
      ENDDO.
      lv_int = lv_int - 1 - lv_k.
      lv_num = lv_int.
      lv_num = condense( lv_num ).
      lv_value = repeat( val = '9' occ = lv_len - lv_tail ) && repeat( val = '0' occ = lv_tail - strlen( lv_num ) ) && lv_num.
      <lv_probe> = lv_value.
      lv_taken = abap_false.
      set_draft( EXPORTING iv_on = abap_false CHANGING cs_row = <ls_probe> ).
      IF index_of( iv_entity = is_entity-name iv_key = key_of( is_entity = is_entity is_row = <ls_probe> ) ) > 0
          OR select_row( is_entity = is_entity is_keys = <ls_probe> ) IS NOT INITIAL.
        lv_taken = abap_true.
      ENDIF.
      IF ms_model-draft = abap_true AND lv_taken = abap_false.
        set_draft( EXPORTING iv_on = abap_true CHANGING cs_row = <ls_probe> ).
        IF index_of( iv_entity = is_entity-name iv_key = key_of( is_entity = is_entity is_row = <ls_probe> ) ) > 0
            OR select_row( is_entity = is_entity is_keys = <ls_probe> ) IS NOT INITIAL.
          lv_taken = abap_true.
        ENDIF.
      ENDIF.
      IF lv_taken = abap_false.
        <lv_key> = lv_value.
        RETURN.
      ENDIF.
    ENDDO.
    RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |late numbering of { is_entity-name }: no free preliminary key|.
  ENDMETHOD.

  METHOD late_numbers.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_saver  TYPE zif_osd_rap_bo=>ty_saver.
    DATA lt_savers LIKE mt_savers.
    DATA lo_saver  TYPE REF TO cl_abap_behavior_saver.
    DATA lr_mapped TYPE REF TO data.
    DATA lr_rep    TYPE REF TO data.
    DATA ls_late   TYPE ty_late.
    DATA lt_index  TYPE STANDARD TABLE OF i WITH DEFAULT KEY.
    DATA lv_index  TYPE i.
    DATA lv_any    TYPE abap_bool.
    DATA lv_hits   TYPE i.
    DATA lv_final  TYPE string.
    DATA lt_finals TYPE string_table.
    DATA lr_probe  TYPE REF TO data.
    FIELD-SYMBOLS <ls_inst>   TYPE ty_inst.
    FIELD-SYMBOLS <ls_any>    TYPE any.
    FIELD-SYMBOLS <ls_probe>  TYPE any.
    FIELD-SYMBOLS <lv_pid>    TYPE any.
    FIELD-SYMBOLS <ls_mapped> TYPE any.
    FIELD-SYMBOLS <lt_late>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_late>   TYPE any.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lv_from>   TYPE any.
    FIELD-SYMBOLS <lv_to>     TYPE any.
    FIELD-SYMBOLS <ls_tmp>    TYPE any.

    LOOP AT ms_model-entities INTO ls_entity WHERE numbering = 'L'.
      lv_any = abap_true.
    ENDLOOP.
    IF lv_any = abap_false.
      RETURN.
    ENDIF.
    lr_mapped = mo_bo->new_response( 'MAPPED LATE' ).
    ASSIGN lr_mapped->* TO <ls_mapped>.
    LOOP AT ms_model-entities INTO ls_entity WHERE numbering = 'L'.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE <ls_mapped> TO <lt_late>.
      CHECK sy-subrc = 0.
      CLEAR lt_index.
* a created active instance (a draft keeps its preliminary key until it is
* activated, and Activate creates the active instance)
      LOOP AT mt_inst ASSIGNING <ls_inst> WHERE entity = ls_entity-name AND state = co_operation-create.
        CHECK NOT <ls_inst>-key CP 'D|*'.
        lv_index = sy-tabix.
        ASSIGN <ls_inst>-row->* TO <ls_row>.
        APPEND INITIAL LINE TO <lt_late> ASSIGNING <ls_late>.
        ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_row> TO <lv_from>.
        IF sy-subrc = 0.
          ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_late> TO <lv_to>.
          IF sy-subrc = 0.
            <lv_to> = <lv_from>.
          ENDIF.
        ENDIF.
        ASSIGN COMPONENT '%TMP' OF STRUCTURE <ls_late> TO <ls_tmp>.
        LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_from>.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_tmp> TO <lv_to>.
          IF sy-subrc = 0.
            <lv_to> = <lv_from>.
          ENDIF.
        ENDLOOP.
        APPEND lv_index TO lt_index.
      ENDLOOP.
      IF lt_index IS INITIAL.
        CONTINUE.
      ENDIF.
      lt_savers = savers( ).
      GET REFERENCE OF cs_reported INTO lr_rep.
      LOOP AT ms_model-savers INTO ls_saver WHERE adjust = abap_true.
        READ TABLE lt_savers INDEX sy-tabix INTO lo_saver.
        CHECK sy-subrc = 0.
        mo_bo->adjust_numbers( io_saver = lo_saver ir_mapped = lr_mapped ir_reported = lr_rep ).
      ENDLOOP.
* the final keys back into the instances: their rows are what the save
* writes. A row of MAPPED LATE is the instance its %pid names, whatever the
* order the saver left the rows in; a row for no instance, an instance with
* no row or two, a final key that is a preliminary one or that an active
* instance (saved or in this transaction) already has fails the save, which
* then writes nothing (docs/rap-runtime.md, R10)
      IF lines( <lt_late> ) <> lines( lt_index ).
        RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |adjust_numbers of { ls_entity-alias }: { lines( <lt_late> ) } rows for { lines( lt_index ) } instances|.
      ENDIF.
      CLEAR lt_finals.
      LOOP AT lt_index INTO lv_index.
        READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
        ASSIGN <ls_inst>-row->* TO <ls_row>.
        ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_row> TO <lv_pid>.
        lv_hits = 0.
        LOOP AT <lt_late> ASSIGNING <ls_any>.
          ASSIGN COMPONENT '%PID' OF STRUCTURE <ls_any> TO <lv_from>.
          IF sy-subrc = 0 AND <lv_from> = <lv_pid>.
            lv_hits = lv_hits + 1.
            ASSIGN <ls_any> TO <ls_late>.
          ENDIF.
        ENDLOOP.
        IF lv_hits <> 1.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |adjust_numbers of { ls_entity-alias }: { lv_hits } rows for the instance { <ls_inst>-key } (%pid)|.
        ENDIF.
        lr_probe = new_row( ls_entity ).
        ASSIGN lr_probe->* TO <ls_probe>.
        LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_late> TO <lv_from>.
          IF sy-subrc <> 0 OR <lv_from> IS INITIAL.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |adjust_numbers gave { ls_entity-alias } { <ls_inst>-key } no final key|.
          ENDIF.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_probe> TO <lv_to>.
          <lv_to> = <lv_from>.
          IF preliminary( <lv_from> ) = abap_true.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |adjust_numbers gave { ls_entity-alias } { <ls_inst>-key } the final key { <lv_from> }, which is in the range of the preliminary keys|.
          ENDIF.
        ENDLOOP.
        lv_final = key_of( is_entity = ls_entity is_row = <ls_probe> ).
        READ TABLE lt_finals TRANSPORTING NO FIELDS WITH KEY table_line = lv_final.
        IF sy-subrc = 0 OR index_of( iv_entity = ls_entity-name iv_key = lv_final ) > 0
            OR select_row( is_entity = ls_entity is_keys = <ls_probe> ) IS NOT INITIAL.
          RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |adjust_numbers gave { ls_entity-alias } { <ls_inst>-key } the final key { lv_final }, which is in use|.
        ENDIF.
        APPEND lv_final TO lt_finals.
        CLEAR ls_late.
        ls_late-entity = ls_entity-name.
        ls_late-pre = <ls_inst>-key.
        LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_probe> TO <lv_from>.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
          <lv_to> = <lv_from>.
        ENDLOOP.
        <ls_inst>-key = lv_final.
        ls_late-row = <ls_inst>-row.
        APPEND ls_late TO mt_late.
        APPEND |LATE { ls_entity-alias } { ls_late-pre } -> { <ls_inst>-key }| TO mt_trace.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD preliminary.
* whether a key value is in the range late_key draws preliminary keys from:
* the top 1000 values of the key's type
    DATA lv_kind  TYPE c LENGTH 1.
    DATA lv_len   TYPE i.
    DATA lv_tail  TYPE i.
    DATA lv_int   TYPE i.
    DATA lv_num   TYPE string.
    DATA lv_floor TYPE string.
    DATA lv_text  TYPE string.

    DESCRIBE FIELD iv_value TYPE lv_kind OUTPUT-LENGTH lv_len.
    IF lv_kind <> 'N' AND lv_kind <> 'C' AND lv_kind <> 'I'.
      RETURN.
    ENDIF.
    IF lv_kind = 'I'.
      lv_len = 9.
    ENDIF.
    lv_tail = lv_len.
    IF lv_tail > 9.
      lv_tail = 9.
    ENDIF.
    lv_int = 1.
    DO lv_tail TIMES.
      lv_int = lv_int * 10.
    ENDDO.
    lv_int = lv_int - 1000.
    IF lv_int < 0.
      lv_int = 0.
    ENDIF.
    IF lv_kind = 'I'.
      lv_num = iv_value.
      rv_on = boolc( CONV i( iv_value ) >= lv_int ).
      RETURN.
    ENDIF.
    lv_num = lv_int.
    lv_num = condense( lv_num ).
    lv_floor = repeat( val = '9' occ = lv_len - lv_tail ) && repeat( val = '0' occ = lv_tail - strlen( lv_num ) ) && lv_num.
    lv_text = iv_value.
* a CHAR key holds letters too, and 'A99999' sorts after '999000': only a
* value of digits alone can be one late_key drew (#917 follow-up)
    IF lv_kind = 'C' AND NOT lv_text CO '0123456789'.
      RETURN.
    ENDIF.
    rv_on = boolc( strlen( lv_text ) = lv_len AND lv_text >= lv_floor ).
  ENDMETHOD.

  METHOD final_key.
    DATA ls_entity TYPE zif_osd_rap_bo=>ty_entity.
    DATA ls_field  TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_late   TYPE ty_late.
    DATA lr_probe  TYPE REF TO data.
    DATA lv_key    TYPE string.
    FIELD-SYMBOLS <ls_probe> TYPE any.
    FIELD-SYMBOLS <ls_final> TYPE any.
    FIELD-SYMBOLS <lv_from>  TYPE any.
    FIELD-SYMBOLS <lv_to>    TYPE any.

    IF mt_late IS INITIAL.
      RETURN.
    ENDIF.
    ls_entity = entity_of( iv_entity ).
    lr_probe = new_row( ls_entity ).
    ASSIGN lr_probe->* TO <ls_probe>.
    LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_probe> TO <lv_to>.
      <lv_to> = <lv_from>.
    ENDLOOP.
    lv_key = key_of( is_entity = ls_entity is_row = <ls_probe> ).
    READ TABLE mt_late INTO ls_late WITH KEY entity = ls_entity-name pre = lv_key.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.
    ASSIGN ls_late-row->* TO <ls_final>.
    LOOP AT ls_entity-fields INTO ls_field WHERE key = abap_true.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_final> TO <lv_from>.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE cs_row TO <lv_to>.
      IF sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDIF.
    ENDLOOP.
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

    DATA lv_index  TYPE i.
    DATA lv_now    TYPE timestampl.
    DATA ls_inst   TYPE ty_inst.
    DATA lv_uuid   TYPE zosd_draft_adm-draftuuid.

    lt_delta = mi_luw->delta( ).
    LOOP AT lt_delta INTO ls_change.
      ls_entity = entity_of( ls_change-entity ).
* R8: a draft goes into the draft table, each CDS element into the column
* of its name, with the draft's admin columns, and its admin data along
      IF ls_change-key CP 'D|*'.
        ASSIGN ls_change-row->* TO <ls_row>.
        READ TABLE mt_inst WITH KEY entity = ls_change-entity key = ls_change-key TRANSPORTING NO FIELDS.
        lv_index = sy-tabix.
        READ TABLE mt_inst INDEX lv_index INTO ls_inst.
        TRY.
            CREATE OBJECT li_source TYPE (ls_entity-draft_source).
          CATCH cx_sy_create_object_error.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no table class { ls_entity-draft_source }|.
        ENDTRY.
        CLEAR lr_line.
        IF ls_change-operation <> co_operation-create.
          lr_line = table_row( is_entity = ls_entity is_keys = <ls_row> ).
        ENDIF.
        IF lr_line IS INITIAL.
          lr_line = li_source->create_line( ).
        ENDIF.
        ASSIGN lr_line->* TO <ls_line>.
        LOOP AT ls_entity-fields INTO ls_field.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_from>.
          CHECK sy-subrc = 0.
          ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_line> TO <lv_to>.
          CHECK sy-subrc = 0.
          <lv_to> = <lv_from>.
        ENDLOOP.
* the root's draft names the admin row, read while its row is still there
        CLEAR lv_uuid.
        IF ls_entity-parent IS INITIAL OR ls_change-operation <> co_operation-delete.
          lv_uuid = admin_uuid( is_entity = ls_entity iv_index = lv_index ).
        ENDIF.
        GET TIME STAMP FIELD lv_now.
        IF ls_change-operation = co_operation-create.
          ASSIGN COMPONENT 'DRAFTENTITYCREATIONDATETIME' OF STRUCTURE <ls_line> TO <lv_to>.
          <lv_to> = lv_now.
          ASSIGN COMPONENT 'HASACTIVEENTITY' OF STRUCTURE <ls_line> TO <lv_to>.
          <lv_to> = ls_inst-has_active.
          ASSIGN COMPONENT 'DRAFTENTITYOPERATIONCODE' OF STRUCTURE <ls_line> TO <lv_to>.
          IF ls_inst-has_active = abap_true.
            <lv_to> = 'U'.
          ELSE.
            <lv_to> = 'C'.
          ENDIF.
          ASSIGN COMPONENT 'DRAFTADMINISTRATIVEDATAUUID' OF STRUCTURE <ls_line> TO <lv_to>.
          <lv_to> = lv_uuid.
        ENDIF.
        ASSIGN COMPONENT 'DRAFTENTITYLASTCHANGEDATETIME' OF STRUCTURE <ls_line> TO <lv_to>.
        <lv_to> = lv_now.
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
            EXPORTING iv_reason = |save of the draft of { ls_entity-alias } { ls_change-key } ({ ls_change-operation }) failed|.
        ENDIF.
        draft_admin( is_entity = ls_entity iv_uuid = lv_uuid iv_operation = ls_change-operation ).
        CONTINUE.
      ENDIF.
* R7: an entity with an unmanaged save is written by its saver only
      IF ls_entity-save = 'U'.
        CONTINUE.
      ENDIF.
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

  METHOD save_savers.
    DATA lt_savers   LIKE mt_savers.
    DATA lo_saver    TYPE REF TO cl_abap_behavior_saver.
    DATA ls_saver    TYPE zif_osd_rap_bo=>ty_saver.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lt_delta    TYPE zif_osd_luw=>tt_change.
    DATA ls_change   TYPE zif_osd_luw=>ty_change.
    DATA ls_inst     TYPE ty_inst.
    DATA lr_create   TYPE REF TO data.
    DATA lr_update   TYPE REF TO data.
    DATA lr_delete   TYPE REF TO data.
    DATA lr_reported TYPE REF TO data.
    DATA lv_any      TYPE abap_bool.
    FIELD-SYMBOLS <ls_request> TYPE any.
    FIELD-SYMBOLS <lt_rows>    TYPE STANDARD TABLE.

    LOOP AT ms_model-entities INTO ls_entity WHERE save IS NOT INITIAL.
      lv_any = abap_true.
    ENDLOOP.
    lt_savers = savers( ).
    IF lv_any = abap_false.
      LOOP AT lt_savers INTO lo_saver.
        lo_saver->save( ).
      ENDLOOP.
      RETURN.
    ENDIF.

    lr_create = mo_bo->new_request( 'CHANGE' ).
    lr_update = mo_bo->new_request( 'CHANGE' ).
    lr_delete = mo_bo->new_request( 'DELETE' ).
    lt_delta = mi_luw->delta( ).
    LOOP AT lt_delta INTO ls_change.
      ls_entity = entity_of( ls_change-entity ).
      IF ls_entity-save IS INITIAL.
        CONTINUE.
      ENDIF.
      READ TABLE mt_inst INTO ls_inst WITH KEY entity = ls_change-entity key = ls_change-key.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
* R8: the request names active instances only
      IF ls_inst-key CP 'D|*'.
        CONTINUE.
      ENDIF.
      CASE ls_change-operation.
        WHEN co_operation-create.
          ASSIGN lr_create->* TO <ls_request>.
        WHEN co_operation-update.
          ASSIGN lr_update->* TO <ls_request>.
        WHEN OTHERS.
          ASSIGN lr_delete->* TO <ls_request>.
      ENDCASE.
      ASSIGN COMPONENT ls_entity-response OF STRUCTURE <ls_request> TO <lt_rows>.
      request_row( EXPORTING is_entity = ls_entity is_inst = ls_inst iv_kind = ls_change-operation
                   CHANGING ct_rows = <lt_rows> ).
    ENDLOOP.

    GET REFERENCE OF cs_reported INTO lr_reported.
    LOOP AT lt_savers INTO lo_saver.
      READ TABLE ms_model-savers INTO ls_saver INDEX sy-tabix.
      IF sy-subrc = 0 AND ls_saver-modified = abap_true.
        APPEND 'SAVE_MODIFIED' TO mt_trace.
        mo_bo->save_modified( io_saver = lo_saver ir_create = lr_create ir_update = lr_update
                              ir_delete = lr_delete ir_reported = lr_reported ).
      ELSE.
        lo_saver->save( ).
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD request_row.
* one row of the request: a create the instance with %control on for every
* field set since it was created; an update its keys and the fields changed
* in this transaction (all fields WITH FULL DATA), flagged; a delete its keys
    DATA lr_line  TYPE REF TO data.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lv_set   TYPE abap_bool.
    FIELD-SYMBOLS <ls_line>    TYPE any.
    FIELD-SYMBOLS <ls_row>     TYPE any.
    FIELD-SYMBOLS <ls_control> TYPE any.
    FIELD-SYMBOLS <lv_from>    TYPE any.
    FIELD-SYMBOLS <lv_to>      TYPE any.

    CREATE DATA lr_line LIKE LINE OF ct_rows.
    ASSIGN lr_line->* TO <ls_line>.
    ASSIGN is_inst-row->* TO <ls_row>.
    ASSIGN COMPONENT '%CONTROL' OF STRUCTURE <ls_line> TO <ls_control>.
    LOOP AT is_entity-fields INTO ls_field.
      READ TABLE is_inst-fields TRANSPORTING NO FIELDS WITH KEY table_line = ls_field-name.
      lv_set = boolc( sy-subrc = 0 ).
      IF iv_kind = co_operation-create AND ls_field-key = abap_true.
        lv_set = abap_true.
      ENDIF.
      IF ls_field-key = abap_false AND iv_kind = co_operation-delete.
        CONTINUE.
      ENDIF.
      IF ls_field-key = abap_false AND iv_kind = co_operation-update
          AND lv_set = abap_false AND is_entity-full_data = abap_false.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_from>.
      CHECK sy-subrc = 0.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_line> TO <lv_to>.
      CHECK sy-subrc = 0.
      <lv_to> = <lv_from>.
      IF lv_set = abap_true AND <ls_control> IS ASSIGNED.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_control> TO <lv_to>.
        IF sy-subrc = 0.
          <lv_to> = if_abap_behv=>mk-on.
        ENDIF.
      ENDIF.
    ENDLOOP.
    APPEND <ls_line> TO ct_rows.
  ENDMETHOD.

  METHOD draft_exists.
    DATA lr_keys  TYPE REF TO data.
    DATA lv_key   TYPE string.
    DATA lv_index TYPE i.
    DATA ls_inst  TYPE ty_inst.
    FIELD-SYMBOLS <ls_keys> TYPE any.

    lr_keys = new_row( is_root ).
    ASSIGN lr_keys->* TO <ls_keys>.
    copy_keys( EXPORTING is_entity = is_root is_from = is_keys CHANGING cs_to = <ls_keys> ).
    set_draft( EXPORTING iv_on = abap_true CHANGING cs_row = <ls_keys> ).
    lv_key = key_of( is_entity = is_root is_row = <ls_keys> ).
    lv_index = index_of( iv_entity = is_root-name iv_key = lv_key ).
    IF lv_index > 0.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      rv_exists = boolc( ls_inst-state <> co_operation-delete ).
      RETURN.
    ENDIF.
    IF table_row( is_entity = is_root is_keys = <ls_keys> ) IS NOT INITIAL.
      rv_exists = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD draft_holder.
    DATA lr_keys  TYPE REF TO data.
    DATA lr_line  TYPE REF TO data.
    DATA lv_key   TYPE string.
    DATA lv_index TYPE i.
    DATA ls_inst  TYPE ty_inst.
    DATA lv_uuid  TYPE zosd_draft_adm-draftuuid.
    FIELD-SYMBOLS <ls_keys> TYPE any.
    FIELD-SYMBOLS <ls_line> TYPE any.
    FIELD-SYMBOLS <lv_uuid> TYPE any.

    lr_keys = new_row( is_root ).
    ASSIGN lr_keys->* TO <ls_keys>.
    copy_keys( EXPORTING is_entity = is_root is_from = is_keys CHANGING cs_to = <ls_keys> ).
    set_draft( EXPORTING iv_on = abap_true CHANGING cs_row = <ls_keys> ).
    lv_key = key_of( is_entity = is_root is_row = <ls_keys> ).
    lv_index = index_of( iv_entity = is_root-name iv_key = lv_key ).
    IF lv_index > 0.
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      IF ls_inst-state = co_operation-delete OR ls_inst-created = abap_true.
        RETURN.
      ENDIF.
      lv_uuid = ls_inst-admin_uuid.
    ENDIF.
    IF lv_uuid IS INITIAL.
      lr_line = table_row( is_entity = is_root is_keys = <ls_keys> ).
      IF lr_line IS INITIAL.
        RETURN.
      ENDIF.
      ASSIGN lr_line->* TO <ls_line>.
      ASSIGN COMPONENT 'DRAFTADMINISTRATIVEDATAUUID' OF STRUCTURE <ls_line> TO <lv_uuid>.
      IF sy-subrc <> 0.
        RETURN.
      ENDIF.
      lv_uuid = <lv_uuid>.
    ENDIF.
    rv_user = holder_of( lv_uuid ).
  ENDMETHOD.

  METHOD holder_of.
    DATA lv_uuid TYPE zosd_draft_adm-draftuuid.
    lv_uuid = iv_uuid.
    IF lv_uuid IS INITIAL.
      RETURN.
    ENDIF.
    SELECT SINGLE inprocessbyuser FROM zosd_draft_adm INTO rv_user WHERE draftuuid = lv_uuid.
    IF sy-subrc <> 0.
      CLEAR rv_user.
    ENDIF.
  ENDMETHOD.

  METHOD foreign_draft.
* R9 (docs/rap-runtime.md, "The owner"): the user a draft is in process by
* holds it; the same user resumes it, anybody else is refused, as the
* exclusive lock of Edit refuses them on a system (unmeasured: the cause a
* system gives and its text, and the expiry after which another user may
* take a draft over -- there is none here)
    DATA lv_holder TYPE syuname.
    DATA ls_root   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_root   TYPE i.
    DATA ls_inst   TYPE ty_inst.
    FIELD-SYMBOLS <ls_row> TYPE any.

    lv_holder = holder_of( admin_uuid( is_entity = is_entity iv_index = iv_index ) ).
    IF lv_holder IS INITIAL OR lv_holder = zcl_osd_logon=>user( ).
      RETURN.
    ENDIF.
    rv_foreign = abap_true.
    root_of( EXPORTING is_entity = is_entity iv_index = iv_index IMPORTING es_root = ls_root ev_index = lv_root ).
    IF lv_root = 0.
      ls_root = is_entity.
      lv_root = iv_index.
    ENDIF.
    READ TABLE mt_inst INDEX lv_root INTO ls_inst.
    ASSIGN ls_inst-row->* TO <ls_row>.
    fail( EXPORTING is_entity = is_entity is_input = is_input
                    iv_cause = if_abap_behv=>cause-locked
                    iv_text = |{ ls_root-alias } { key_text( is_entity = ls_root is_row = <ls_row> ) } is a draft of user { lv_holder }|
          CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
  ENDMETHOD.

  METHOD result_row.
    FIELD-SYMBOLS <ls_out>   TYPE any.
    FIELD-SYMBOLS <ls_param> TYPE any.
    APPEND INITIAL LINE TO ct_result ASSIGNING <ls_out>.
    MOVE-CORRESPONDING is_row TO <ls_out>.
    ASSIGN COMPONENT '%PARAM' OF STRUCTURE <ls_out> TO <ls_param>.
    IF sy-subrc = 0.
      MOVE-CORRESPONDING is_row TO <ls_param>.
    ENDIF.
  ENDMETHOD.

  METHOD draft_action.
* R8 (docs/rap-runtime.md, "The draft actions"): on the root only, which is
* where the BDEF declares them
    DATA ls_inst   TYPE ty_inst.
    DATA lv_draft  TYPE abap_bool.
    DATA lv_ok     TYPE abap_bool.
    DATA lv_uuid   TYPE x LENGTH 16.
    DATA lv_index  TYPE i.
    DATA lv_holder TYPE syuname.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <ls_copy>   TYPE any.

    APPEND |DRAFT ACTION { iv_action }| TO mt_trace.
    READ TABLE mt_inst INDEX iv_index INTO ls_inst.
    ASSIGN ls_inst-row->* TO <ls_row>.
    lv_draft = is_draft( <ls_row> ).
    IF is_entity-parent IS NOT INITIAL.
      fail( EXPORTING is_entity = is_entity is_input = is_key
                      iv_cause = if_abap_behv=>cause-unspecific
                      iv_text = |{ iv_action } is a draft action of the root, not of { is_entity-alias }|
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.
    IF iv_action = 'EDIT' AND lv_draft = abap_true.
      fail( EXPORTING is_entity = is_entity is_input = is_key
                      iv_cause = if_abap_behv=>cause-unspecific
                      iv_text = |Edit of { is_entity-alias } needs the active instance|
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ELSEIF iv_action <> 'EDIT' AND lv_draft = abap_false.
      fail( EXPORTING is_entity = is_entity is_input = is_key
                      iv_cause = if_abap_behv=>cause-unspecific
                      iv_text = |{ iv_action } of { is_entity-alias } needs its draft|
            CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      RETURN.
    ENDIF.

* R9: Activate, Discard, Resume and Prepare of another user's draft are refused
    IF lv_draft = abap_true AND ls_inst-created = abap_false
        AND foreign_draft( EXPORTING is_entity = is_entity iv_index = iv_index is_input = is_key
                           CHANGING cs_failed = cs_failed cs_reported = cs_reported ) = abap_true.
      RETURN.
    ENDIF.

    CASE iv_action.
      WHEN 'EDIT'.
* one draft per instance: a second Edit is a conflict; R9: the draft of
* another user locks the instance (unmeasured: a system's cause and text)
        lv_holder = draft_holder( is_root = is_entity is_keys = <ls_row> ).
        IF lv_holder IS NOT INITIAL AND lv_holder <> zcl_osd_logon=>user( ).
          fail( EXPORTING is_entity = is_entity is_input = is_key
                          iv_cause = if_abap_behv=>cause-locked
                          iv_text = |{ is_entity-alias } { key_text( is_entity = is_entity is_row = <ls_row> ) } is locked by user { lv_holder }|
                CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
          RETURN.
        ENDIF.
        IF draft_exists( is_root = is_entity is_keys = <ls_row> ) = abap_true.
          fail( EXPORTING is_entity = is_entity is_input = is_key
                          iv_cause = if_abap_behv=>cause-conflict
                          iv_text = |{ is_entity-alias } { key_text( is_entity = is_entity is_row = <ls_row> ) } has a draft already|
                CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
          RETURN.
        ENDIF.
        lock( EXPORTING is_entity = is_entity iv_index = iv_index is_input = is_key
              IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        IF lv_ok = abap_false.
          RETURN.
        ENDIF.
        TRY.
            lv_uuid = cl_system_uuid=>create_uuid_x16_static( ).
          CATCH cx_uuid_error.
            RAISE EXCEPTION TYPE zcx_osd_rap EXPORTING iv_reason = |no UUID for the draft of { is_entity-alias }|.
        ENDTRY.
        lv_index = copy_to_draft( is_entity = is_entity iv_index = iv_index iv_uuid = lv_uuid ).
        READ TABLE mt_inst INDEX lv_index INTO ls_inst.
        ASSIGN ls_inst-row->* TO <ls_copy>.
        result_row( EXPORTING is_row = <ls_copy> CHANGING ct_result = ct_result ).

      WHEN 'RESUME'.
* the draft is there and nothing holds it but itself (no expiry here)
        result_row( EXPORTING is_row = <ls_row> CHANGING ct_result = ct_result ).

      WHEN 'DISCARD'.
        delete_tree( is_entity = is_entity iv_index = iv_index ).

      WHEN 'ACTIVATE'.
        activate_draft( EXPORTING is_entity = is_entity iv_index = iv_index is_key = is_key
                        CHANGING ct_result = ct_result cs_failed = cs_failed cs_reported = cs_reported ).
    ENDCASE.
  ENDMETHOD.

  METHOD activate_draft.
* R8: the draft's tree becomes the active one: each draft instance updates
* the active instance it came from or creates it, an active child the draft
* no longer has is deleted, the draft is deleted; the save checks the rest
    DATA ls_inst   TYPE ty_inst.
    DATA lv_ok     TYPE abap_bool.
    DATA lv_index  TYPE i.
    DATA lv_active TYPE i.
    DATA lt_tree   TYPE string_table.
    DATA lv_node   TYPE string.
    DATA lv_name   TYPE string.
    DATA lv_at     TYPE string.
    DATA lv_pos    TYPE i.
    DATA ls_node   TYPE zif_osd_rap_bo=>ty_entity.
    DATA lr_keys   TYPE REF TO data.
    DATA lr_copy   TYPE REF TO data.
    DATA lv_count  TYPE i.
    DATA lt_keep   TYPE string_table.
    DATA ls_assoc  TYPE zif_osd_rap_bo=>ty_assoc.
    DATA lt_children TYPE int4_table.
    DATA lv_child    TYPE i.
    DATA ls_child    TYPE ty_inst.
    DATA ls_target   TYPE zif_osd_rap_bo=>ty_entity.
    TYPES:
      BEGIN OF ty_copy,
        entity TYPE string,
        row    TYPE REF TO data,
      END OF ty_copy.
    DATA ls_copy   TYPE ty_copy.
    DATA lt_copies TYPE STANDARD TABLE OF ty_copy WITH DEFAULT KEY.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <ls_keys>   TYPE any.
    FIELD-SYMBOLS <ls_copy>   TYPE any.
    FIELD-SYMBOLS <lv_draft>  TYPE any.
    FIELD-SYMBOLS <lv_active> TYPE any.

    READ TABLE mt_inst INDEX iv_index INTO ls_inst.
    ASSIGN ls_inst-row->* TO <ls_row>.
* the active instance's total ETag must be the one the draft started from
    lr_keys = new_row( is_entity ).
    ASSIGN lr_keys->* TO <ls_keys>.
    copy_keys( EXPORTING is_entity = is_entity is_from = <ls_row> CHANGING cs_to = <ls_keys> ).
    set_draft( EXPORTING iv_on = abap_false CHANGING cs_row = <ls_keys> ).
    lv_active = resolve( is_entity = is_entity is_input = <ls_keys> ).
    IF lv_active > 0 AND is_entity-total_etag IS NOT INITIAL.
      READ TABLE mt_inst INDEX lv_active INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_copy>.
      ASSIGN COMPONENT is_entity-total_etag OF STRUCTURE <ls_copy> TO <lv_active>.
      ASSIGN COMPONENT is_entity-total_etag OF STRUCTURE <ls_row> TO <lv_draft>.
      IF <lv_active> IS ASSIGNED AND <lv_draft> IS ASSIGNED AND <lv_active> <> <lv_draft>.
        fail( EXPORTING is_entity = is_entity is_input = is_key
                        iv_cause = if_abap_behv=>cause-conflict
                        iv_text = |{ is_entity-alias } { key_text( is_entity = is_entity is_row = <ls_row> ) } changed after its draft was made|
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        RETURN.
      ENDIF.
    ENDIF.
* the draft tree, copied before it is deleted
    draft_tree( EXPORTING is_entity = is_entity iv_index = iv_index CHANGING ct_tree = lt_tree ).
    LOOP AT lt_tree INTO lv_node.
      SPLIT lv_node AT '|' INTO lv_name lv_at.
      lv_pos = lv_at.
      READ TABLE mt_inst INDEX lv_pos INTO ls_inst.
      ls_node = entity_of( lv_name ).
      lr_copy = new_row( ls_node ).
      ASSIGN lr_copy->* TO <ls_copy>.
      ASSIGN ls_inst-row->* TO <ls_row>.
      <ls_copy> = <ls_row>.
      set_draft( EXPORTING iv_on = abap_false CHANGING cs_row = <ls_copy> ).
      ls_copy-entity = lv_name.
      ls_copy-row = lr_copy.
      APPEND ls_copy TO lt_copies.
    ENDLOOP.
* everything that can refuse the activation is asked before anything in the
* buffer changes: a refused Activate leaves the draft as it was, so a later
* COMMIT ENTITIES saves nothing of it (the lock of the active root, while
* the draft that holds it still exists, and every mandatory field)
    IF lv_active > 0.
      mv_activating = abap_true.
      TRY.
          lock( EXPORTING is_entity = is_entity iv_index = lv_active is_input = is_key
                IMPORTING ev_ok = lv_ok CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        CLEANUP.
          mv_activating = abap_false.
      ENDTRY.
      mv_activating = abap_false.
      IF lv_ok = abap_false.
        RETURN.
      ENDIF.
    ENDIF.
    lv_ok = abap_true.
    LOOP AT lt_copies INTO ls_copy.
      ls_node = entity_of( ls_copy-entity ).
      ASSIGN ls_copy-row->* TO <ls_copy>.
      IF mandatory_ok( EXPORTING is_entity = ls_node is_row = <ls_copy>
                       CHANGING cs_failed = cs_failed cs_reported = cs_reported ) = abap_false.
        lv_ok = abap_false.
      ENDIF.
    ENDLOOP.
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.
    delete_tree( is_entity = is_entity iv_index = iv_index ).
* each draft instance updates the active instance it came from, or creates it
    CLEAR lv_count.
    LOOP AT lt_copies INTO ls_copy.
      lv_count = lv_count + 1.
      ls_node = entity_of( ls_copy-entity ).
      ASSIGN ls_copy-row->* TO <ls_copy>.
      lv_index = activate_one( EXPORTING is_entity = ls_node is_draft = <ls_copy>
                               CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
      READ TABLE mt_inst INDEX lv_index INTO ls_inst.
      APPEND |{ ls_copy-entity }\|{ ls_inst-key }| TO lt_keep.
      IF lv_count = 1.
        lv_active = lv_index.
      ENDIF.
    ENDLOOP.
* an active child the draft no longer has is deleted with its subtree
    IF lv_active > 0.
      LOOP AT lt_copies INTO ls_copy.
        ls_node = entity_of( ls_copy-entity ).
        ASSIGN ls_copy-row->* TO <ls_copy>.
        lv_index = resolve( is_entity = ls_node is_input = <ls_copy> ).
        CHECK lv_index > 0.
        LOOP AT ls_node-assocs INTO ls_assoc WHERE kind = 'C'.
          ls_target = entity_of( ls_assoc-target ).
          lt_children = targets( is_entity = ls_node is_assoc = ls_assoc iv_index = lv_index ).
          LOOP AT lt_children INTO lv_child.
            READ TABLE mt_inst INDEX lv_child INTO ls_child.
            READ TABLE lt_keep TRANSPORTING NO FIELDS WITH KEY table_line = |{ ls_target-name }\|{ ls_child-key }|.
            IF sy-subrc <> 0.
              delete_tree( is_entity = ls_target iv_index = lv_child ).
            ENDIF.
          ENDLOOP.
        ENDLOOP.
      ENDLOOP.
      READ TABLE mt_inst INDEX lv_active INTO ls_inst.
      ASSIGN ls_inst-row->* TO <ls_copy>.
      result_row( EXPORTING is_row = <ls_copy> CHANGING ct_result = ct_result ).
    ENDIF.
  ENDMETHOD.


  METHOD copy_to_draft.
    DATA ls_inst  TYPE ty_inst.
    DATA ls_new   TYPE ty_inst.
    DATA lr_row   TYPE REF TO data.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA ls_assoc TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_child TYPE zif_osd_rap_bo=>ty_entity.
    DATA lt_index TYPE int4_table.
    DATA lv_child TYPE i.
    DATA lv_index TYPE i.
    FIELD-SYMBOLS <ls_from> TYPE any.
    FIELD-SYMBOLS <ls_to>   TYPE any.

    READ TABLE mt_inst INDEX iv_index INTO ls_inst.
    ASSIGN ls_inst-row->* TO <ls_from>.
    lr_row = new_row( is_entity ).
    ASSIGN lr_row->* TO <ls_to>.
    <ls_to> = <ls_from>.
    set_draft( EXPORTING iv_on = abap_true CHANGING cs_row = <ls_to> ).
    ls_new-entity      = is_entity-name.
    ls_new-key         = key_of( is_entity = is_entity is_row = <ls_to> ).
    ls_new-row         = lr_row.
    ls_new-state       = co_operation-create.
    ls_new-created     = abap_true.
    ls_new-has_active  = abap_true.
    ls_new-admin_uuid  = iv_uuid.
    LOOP AT is_entity-fields INTO ls_field.
      APPEND ls_field-name TO ls_new-fields.
    ENDLOOP.
    lv_index = index_of( iv_entity = is_entity-name iv_key = ls_new-key ).
    IF lv_index > 0.
      MODIFY mt_inst INDEX lv_index FROM ls_new.
    ELSE.
      APPEND ls_new TO mt_inst.
      lv_index = lines( mt_inst ).
    ENDIF.
    rv_index = lv_index.
    mi_luw->modify( iv_entity = is_entity-name iv_key = ls_new-key
                    iv_operation = co_operation-create ir_row = lr_row ).
* the composition tree below it, read from the active side
    LOOP AT is_entity-assocs INTO ls_assoc WHERE kind = 'C'.
      ls_child = entity_of( ls_assoc-target ).
      lt_index = targets( is_entity = is_entity is_assoc = ls_assoc iv_index = iv_index ).
      LOOP AT lt_index INTO lv_child.
        copy_to_draft( is_entity = ls_child iv_index = lv_child iv_uuid = iv_uuid ).
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD draft_tree.
    DATA ls_assoc TYPE zif_osd_rap_bo=>ty_assoc.
    DATA ls_child TYPE zif_osd_rap_bo=>ty_entity.
    DATA lt_index TYPE int4_table.
    DATA lv_child TYPE i.

    APPEND |{ is_entity-name }\|{ iv_index }| TO ct_tree.
    LOOP AT is_entity-assocs INTO ls_assoc WHERE kind = 'C'.
      ls_child = entity_of( ls_assoc-target ).
      lt_index = targets( is_entity = is_entity is_assoc = ls_assoc iv_index = iv_index ).
      LOOP AT lt_index INTO lv_child.
        draft_tree( EXPORTING is_entity = ls_child iv_index = lv_child CHANGING ct_tree = ct_tree ).
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

  METHOD mandatory_ok.
* the mandatory fields a draft could leave empty must be filled when it
* becomes active
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    FIELD-SYMBOLS <lv_value> TYPE any.
    rv_ok = abap_true.
    LOOP AT is_entity-fields INTO ls_field WHERE mandatory IS NOT INITIAL.
      ASSIGN COMPONENT ls_field-name OF STRUCTURE is_row TO <lv_value>.
      IF sy-subrc = 0 AND <lv_value> IS INITIAL.
        fail( EXPORTING is_entity = is_entity is_input = is_row
                        iv_cause = if_abap_behv=>cause-unspecific
                        iv_text = |Field { ls_field-name } is mandatory|
                        iv_field = ls_field-name
              CHANGING cs_failed = cs_failed cs_reported = cs_reported ).
        rv_ok = abap_false.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD activate_one.
    DATA ls_inst  TYPE ty_inst.
    DATA ls_field TYPE zif_osd_rap_bo=>ty_field.
    DATA lr_row   TYPE REF TO data.
    DATA lv_create TYPE abap_bool.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_from> TYPE any.
    FIELD-SYMBOLS <lv_to>   TYPE any.


    rv_index = resolve( is_entity = is_entity is_input = is_draft ).
    IF rv_index = 0.
      lv_create = abap_true.
      lr_row = new_row( is_entity ).
      ASSIGN lr_row->* TO <ls_row>.
      <ls_row> = is_draft.
      CLEAR ls_inst.
      ls_inst-entity      = is_entity-name.
      ls_inst-key         = key_of( is_entity = is_entity is_row = <ls_row> ).
      ls_inst-row         = lr_row.
      ls_inst-state       = co_operation-create.
      ls_inst-created     = abap_true.
      ls_inst-req_created = abap_true.
      rv_index = index_of( iv_entity = is_entity-name iv_key = ls_inst-key ).
      IF rv_index > 0.
        MODIFY mt_inst INDEX rv_index FROM ls_inst.
      ELSE.
        APPEND ls_inst TO mt_inst.
        rv_index = lines( mt_inst ).
      ENDIF.
    ELSE.
      READ TABLE mt_inst INDEX rv_index ASSIGNING <ls_inst>.
      ASSIGN <ls_inst>-row->* TO <ls_row>.
      LOOP AT is_entity-fields INTO ls_field WHERE key = abap_false.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE is_draft TO <lv_from>.
        CHECK sy-subrc = 0.
        ASSIGN COMPONENT ls_field-name OF STRUCTURE <ls_row> TO <lv_to>.
        CHECK sy-subrc = 0.
        <lv_to> = <lv_from>.
      ENDLOOP.
      IF <ls_inst>-state IS INITIAL.
        <ls_inst>-state = co_operation-update.
      ENDIF.
      <ls_inst>-updated = abap_true.
      <ls_inst>-req_updated = abap_true.
    ENDIF.
    LOOP AT is_entity-fields INTO ls_field.
      mark( iv_index = rv_index iv_field = ls_field-name ).
    ENDLOOP.
    stamp( is_entity = is_entity iv_index = rv_index iv_create = lv_create ).
    READ TABLE mt_inst INDEX rv_index ASSIGNING <ls_inst>.
    IF lv_create = abap_true.
      mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                      iv_operation = co_operation-create ir_row = <ls_inst>-row ).
    ELSE.
      mi_luw->modify( iv_entity = is_entity-name iv_key = <ls_inst>-key
                      iv_operation = co_operation-update ir_row = <ls_inst>-row ).
    ENDIF.
  ENDMETHOD.

  METHOD admin_uuid.
    DATA ls_root  TYPE zif_osd_rap_bo=>ty_entity.
    DATA lv_index TYPE i.
    DATA lr_line  TYPE REF TO data.
    FIELD-SYMBOLS <ls_inst> TYPE ty_inst.
    FIELD-SYMBOLS <ls_row>  TYPE any.
    FIELD-SYMBOLS <lv_uuid> TYPE any.

    root_of( EXPORTING is_entity = is_entity iv_index = iv_index IMPORTING es_root = ls_root ev_index = lv_index ).
    IF lv_index = 0.
      lv_index = iv_index.
    ENDIF.
    READ TABLE mt_inst INDEX lv_index ASSIGNING <ls_inst>.
    IF <ls_inst>-admin_uuid IS INITIAL.
      ASSIGN <ls_inst>-row->* TO <ls_row>.
      lr_line = table_row( is_entity = ls_root is_keys = <ls_row> ).
      IF lr_line IS NOT INITIAL.
        ASSIGN lr_line->* TO <ls_row>.
        ASSIGN COMPONENT 'DRAFTADMINISTRATIVEDATAUUID' OF STRUCTURE <ls_row> TO <lv_uuid>.
        IF sy-subrc = 0.
          <ls_inst>-admin_uuid = <lv_uuid>.
        ENDIF.
      ENDIF.
    ENDIF.
    rv_uuid = <ls_inst>-admin_uuid.
  ENDMETHOD.

  METHOD draft_admin.
* the draft's administrative data: created with the root's draft, its last
* change moved by any change of the draft, deleted with the root's draft
    DATA ls_adm  TYPE zosd_draft_adm.
    DATA lv_now  TYPE timestampl.
    DATA lv_uuid TYPE zosd_draft_adm-draftuuid.

    lv_uuid = iv_uuid.
    IF lv_uuid IS INITIAL.
      RETURN.
    ENDIF.
    GET TIME STAMP FIELD lv_now.
    IF is_entity-parent IS INITIAL AND iv_operation = co_operation-delete.
      DELETE FROM zosd_draft_adm WHERE draftuuid = lv_uuid.
      RETURN.
    ENDIF.
    SELECT SINGLE * FROM zosd_draft_adm INTO ls_adm WHERE draftuuid = lv_uuid.
    IF sy-subrc <> 0.
      CLEAR ls_adm.
      ls_adm-draftuuid        = lv_uuid.
      ls_adm-draftentitytype  = ms_model-bdef.
      ls_adm-createdbyuser    = zcl_osd_logon=>user( ).
      ls_adm-creationdatetime = lv_now.
      ls_adm-inprocessbyuser  = zcl_osd_logon=>user( ).
      ls_adm-lastchangedbyuser  = zcl_osd_logon=>user( ).
      ls_adm-lastchangedatetime = lv_now.
      INSERT zosd_draft_adm FROM ls_adm.
    ELSE.
      ls_adm-lastchangedbyuser  = zcl_osd_logon=>user( ).
      ls_adm-lastchangedatetime = lv_now.
      UPDATE zosd_draft_adm FROM ls_adm.
    ENDIF.
  ENDMETHOD.

  METHOD rollback.
    DATA lt_savers LIKE mt_savers.
    DATA lo_saver  TYPE REF TO cl_abap_behavior_saver.
    TRY.
        lt_savers = savers( ).
      CATCH zcx_osd_rap.
        CLEAR lt_savers.
    ENDTRY.
    LOOP AT lt_savers INTO lo_saver.
      lo_saver->cleanup( ).
    ENDLOOP.
    APPEND 'ROLLBACK' TO mt_trace.
    mi_luw->discard( ).
    unlock( ).
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
