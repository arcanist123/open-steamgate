INTERFACE zif_osd_rap_bo PUBLIC.
* One behavior definition as the managed runtime sees it: its model, and the
* typed half of every call into its behavior pool. Implemented by a class
* generated from the BDEF (tools/rap/bdef-gen.mjs, gen/rap/), because the
* pool's handler methods are typed with the derived types of that BDEF and
* only generated code knows them. Everything generic -- the buffer, field
* control, numbering, the triggers, the save sequence -- is in
* ZCL_OSD_RAP_RUNTIME (docs/rap-runtime.md).

  TYPES ty_flag TYPE c LENGTH 1.

* one CDS element of an entity. NAME is the CDS name upper case, COLUMN the
* persistent table's column it is saved to (BDEF mapping, else the CDS base).
* READONLY: X always, U on update only. MANDATORY: X always, C on create
* only. NUMBERING: X when the key is drawn by managed numbering (a UUID).
  TYPES:
    BEGIN OF ty_field,
      name      TYPE string,
      column    TYPE string,
      key       TYPE abap_bool,
      readonly  TYPE ty_flag,
      mandatory TYPE ty_flag,
      numbering TYPE abap_bool,
      admin     TYPE string,
* R11: the value of a CDS element that is a literal (`1 as
* CarrierSingletonID`): no column holds it, every instance has it
      constant  TYPE string,
    END OF ty_field,
    tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

* a determination (D), validation (V) or action (A) and when it runs. ON is
* M (on modify) or S (on save); the triggers are the create and update
* operations and the CDS names in FIELDS. METHOD is the pool's method;
* ENTITIES is set when it takes the instances as a table it changes in
* place (the explicit form), and not when it uses EML (the system's form).
* FEATURES: an action declared ( features : instance ) asks the pool's
* FOR INSTANCE FEATURES method before it runs (R4).
* R6: KIND X is a determine action: no method, MEMBERS the determinations
* on save (D) and validations (V) it runs, ALWAYS set for a member declared
* ( always ). INTERNAL: an internal action, executed only by the BO's own
* handlers (IN LOCAL MODE). FACTORY: a factory action, which answers the
* new instances in MAPPED under the %cid of each import row.
* R8: KIND E is a draft action (Edit, Activate, Discard, Resume), the
* framework's: no method; Prepare is a determine action (X).
  TYPES:
    BEGIN OF ty_member,
      kind   TYPE ty_flag,
      name   TYPE string,
      always TYPE abap_bool,
* R11: the entity of a member of another entity than the action's (a
* root's determine action running a validation of the entities below it)
      entity TYPE string,
    END OF ty_member,
    tt_member TYPE STANDARD TABLE OF ty_member WITH DEFAULT KEY.
  TYPES:
    BEGIN OF ty_callable,
      kind      TYPE ty_flag,
      name      TYPE string,
      on        TYPE ty_flag,
      on_create TYPE abap_bool,
      on_update TYPE abap_bool,
      fields    TYPE string_table,
      method    TYPE string,
      entities  TYPE abap_bool,
      features  TYPE abap_bool,
      internal  TYPE abap_bool,
      factory   TYPE abap_bool,
      members   TYPE tt_member,
    END OF ty_callable,
    tt_callable TYPE STANDARD TABLE OF ty_callable WITH DEFAULT KEY.

* R5: one association the BDEF declares for an entity. KIND: C composition
* child, P to parent, A another association inside the business object.
* CREATE: association _x { create; }, FEAT_CREATE with ( features :
* instance ). NUMBERING E: the target's keys are drawn by the pool's FOR
* NUMBERING ... FOR CREATE e\_x method. PAIRS: source field = target field
  TYPES:
    BEGIN OF ty_pair,
      source TYPE string,
      target TYPE string,
    END OF ty_pair,
    tt_pair TYPE STANDARD TABLE OF ty_pair WITH DEFAULT KEY,
    BEGIN OF ty_assoc,
      name        TYPE string,
      target      TYPE string,
      kind        TYPE ty_flag,
      create      TYPE abap_bool,
      feat_create TYPE abap_bool,
      numbering   TYPE ty_flag,
      pairs       TYPE tt_pair,
    END OF ty_assoc,
    tt_assoc TYPE STANDARD TABLE OF ty_assoc WITH DEFAULT KEY.

* NAME the CDS entity, ALIAS the BDEF alias, RESPONSE the component of the
* response structures, SOURCE the generated table class
* (zif_stg_cds_source) of the persistent table, HANDLER the absolute name of
* the pool's local handler class. R4: ETAG the element of `etag master`;
* FEATURES set when the pool has a FOR INSTANCE FEATURES method, FEAT_UPDATE
* and FEAT_DELETE when update / delete are declared ( features : instance );
* NUMBERING E for `early numbering` (a FOR NUMBERING method draws the key),
* R10: L for `late numbering` (a preliminary key and %pid in the interaction
* phase, the final key from the saver's adjust_numbers).
* R5: ROOT the root entity of the tree, PARENT and PARENT_ASSOC the parent
* entity and the association to it (initial for the root), LOCK M for lock
* master and D for lock dependent, ASSOCS the associations.
* R7: SAVE A for `with additional save` (the managed write, then the
* savers' save_modified), U for `with unmanaged save` (no managed write;
* TABLE is the `mapping for` table, read only), initial for the managed
* write alone. FULL_DATA: `with full data`, update rows of the request carry
* every field. POOL: the entity's behavior pool (`implementation in class`).
* R8: DRAFT_TABLE the `draft table` of a draft-enabled BO (its columns are
* the CDS elements), DRAFT_SOURCE its generated table class, DRAFT_VIEW the
* CDS view's source class, UNION the generated class serving active and
* draft rows (zif_stg_cds_draft_source), TOTAL_ETAG the root's `total etag`.
  TYPES:
    BEGIN OF ty_entity,
      name      TYPE string,
      alias     TYPE string,
      response  TYPE string,
      table     TYPE string,
      source    TYPE string,
      handler   TYPE string,
      create    TYPE abap_bool,
      update    TYPE abap_bool,
      delete    TYPE abap_bool,
      etag        TYPE string,
      features    TYPE abap_bool,
      feat_update TYPE abap_bool,
      feat_delete TYPE abap_bool,
      numbering   TYPE ty_flag,
      root         TYPE string,
      parent       TYPE string,
      parent_assoc TYPE string,
      lock         TYPE ty_flag,
      assocs       TYPE tt_assoc,
      save         TYPE ty_flag,
      full_data    TYPE abap_bool,
      pool         TYPE string,
      draft_table  TYPE string,
      draft_source TYPE string,
      draft_view   TYPE string,
      total_etag   TYPE string,
      union        TYPE string,
      fields    TYPE tt_field,
      callables TYPE tt_callable,
    END OF ty_entity,
    tt_entity TYPE STANDARD TABLE OF ty_entity WITH DEFAULT KEY.

* R7: SAVERS the local saver classes of every pool of the BDEF (absolute
* names, the header's pool first); MODIFIED when it implements save_modified.
* SAVER is the first of them (R2). R10: ADJUST when it redefines
* adjust_numbers (late numbering).
  TYPES:
    BEGIN OF ty_saver,
      name     TYPE string,
      modified TYPE abap_bool,
      adjust   TYPE abap_bool,
    END OF ty_saver,
    tt_saver TYPE STANDARD TABLE OF ty_saver WITH DEFAULT KEY.
  TYPES:
    BEGIN OF ty_model,
      bdef     TYPE string,
      draft    TYPE abap_bool,
      pool     TYPE string,
      saver    TYPE string,
      savers   TYPE tt_saver,
      entities TYPE tt_entity,
    END OF ty_model.

  METHODS model
    RETURNING
      VALUE(rs_model) TYPE ty_model.

* an empty table of the entity's instances (TYPE TABLE FOR READ RESULT)
  METHODS new_rows
    IMPORTING
      iv_entity      TYPE csequence
    RETURNING
      VALUE(rr_rows) TYPE REF TO data.

* an empty result table of an action (TYPE TABLE FOR ACTION RESULT), or
* initial when the action declares no result
  METHODS new_result
    IMPORTING
      iv_entity        TYPE csequence
      iv_action        TYPE csequence
    RETURNING
      VALUE(rr_result) TYPE REF TO data.

* an empty derived table of the entity, for a caller that only knows the
* model (the OData bridge of this package): IV_KIND is CREATE, UPDATE,
* DELETE, ACTION IMPORT or ACTION RESULT, the last two of action IV_ACTION.
* R5: CREATE BY, READ BY, READ BY RESULT and LINK of association IV_ACTION.
* Unbound when the BDEF does not declare it.
  METHODS new_table
    IMPORTING
      iv_entity       TYPE csequence
      iv_kind         TYPE csequence
      iv_action       TYPE csequence OPTIONAL
    RETURNING
      VALUE(rr_table) TYPE REF TO data.

* an empty response structure: MAPPED, FAILED or REPORTED (EARLY); R10: MAPPED
* LATE when an entity of the BDEF has late numbering
  METHODS new_response
    IMPORTING
      iv_kind            TYPE csequence
    RETURNING
      VALUE(rr_response) TYPE REF TO data.

* call one determination, validation or action of the pool's handler.
* IR_ROWS: the instances concerned, a table from NEW_ROWS, which the handler
* may change (the runtime takes the changes back). IR_KEYS: for an action,
* the caller's TABLE FOR ACTION IMPORT; for the others the keys are built
* from IR_ROWS. IR_RESULT: for an action, a TABLE FOR ACTION RESULT.
* R4: IV_NAME %FEATURES calls the FOR INSTANCE FEATURES method (IR_ROWS the
* instances, IR_RESULT a table from NEW_TABLE( kind = 'FEATURES RESULT' ));
* %NUMBERING the FOR NUMBERING method (IR_ROWS a TABLE FOR CREATE, IR_MAPPED
* the RESPONSE FOR MAPPED it fills). R5: %NUMBERING\<assoc> calls the FOR
* NUMBERING ... FOR CREATE e\_assoc method (IR_ROWS a TABLE FOR CREATE
* e\_assoc). R6: for an action, IR_MAPPED is the caller's RESPONSE FOR
* MAPPED, given to the handler's MAPPED (a factory action fills it).
  METHODS call
    IMPORTING
      io_handler  TYPE REF TO object
      iv_entity   TYPE csequence
      iv_name     TYPE csequence
      ir_rows     TYPE REF TO data
      ir_keys     TYPE REF TO data OPTIONAL
      ir_result   TYPE REF TO data OPTIONAL
      ir_failed   TYPE REF TO data
      ir_reported TYPE REF TO data
      ir_mapped   TYPE REF TO data OPTIONAL.

* R7: an empty request of the saver: IV_KIND CHANGE (TYPE REQUEST FOR
* CHANGE, the create and update of save_modified) or DELETE (TYPE REQUEST
* FOR DELETE), one table per entity named by its alias
  METHODS new_request
    IMPORTING
      iv_kind           TYPE csequence
    RETURNING
      VALUE(rr_request) TYPE REF TO data.

* R7: call save_modified of a saver: IR_CREATE and IR_UPDATE from
* NEW_REQUEST( 'CHANGE' ), IR_DELETE from NEW_REQUEST( 'DELETE' ),
* IR_REPORTED the caller's RESPONSE FOR REPORTED
  METHODS save_modified
    IMPORTING
      io_saver    TYPE REF TO object
      ir_create   TYPE REF TO data
      ir_update   TYPE REF TO data
      ir_delete   TYPE REF TO data
      ir_reported TYPE REF TO data.

* R10: call adjust_numbers of a saver: IR_MAPPED from NEW_RESPONSE( 'MAPPED
* LATE' ), IR_REPORTED the caller's RESPONSE FOR REPORTED
  METHODS adjust_numbers
    IMPORTING
      io_saver    TYPE REF TO object
      ir_mapped   TYPE REF TO data
      ir_reported TYPE REF TO data.

ENDINTERFACE.
