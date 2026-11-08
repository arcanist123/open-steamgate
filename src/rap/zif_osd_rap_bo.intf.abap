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
    END OF ty_field,
    tt_field TYPE STANDARD TABLE OF ty_field WITH DEFAULT KEY.

* a determination (D), validation (V) or action (A) and when it runs. ON is
* M (on modify) or S (on save); the triggers are the create and update
* operations and the CDS names in FIELDS. METHOD is the pool's method.
  TYPES:
    BEGIN OF ty_callable,
      kind      TYPE ty_flag,
      name      TYPE string,
      on        TYPE ty_flag,
      on_create TYPE abap_bool,
      on_update TYPE abap_bool,
      fields    TYPE string_table,
      method    TYPE string,
    END OF ty_callable,
    tt_callable TYPE STANDARD TABLE OF ty_callable WITH DEFAULT KEY.

* NAME the CDS entity, ALIAS the BDEF alias, RESPONSE the component of the
* response structures, SOURCE the generated table class
* (zif_stg_cds_source) of the persistent table, HANDLER the absolute name of
* the pool's local handler class.
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
      fields    TYPE tt_field,
      callables TYPE tt_callable,
    END OF ty_entity,
    tt_entity TYPE STANDARD TABLE OF ty_entity WITH DEFAULT KEY.

  TYPES:
    BEGIN OF ty_model,
      bdef     TYPE string,
      pool     TYPE string,
      saver    TYPE string,
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

* an empty response structure: MAPPED, FAILED or REPORTED (EARLY)
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
  METHODS call
    IMPORTING
      io_handler  TYPE REF TO object
      iv_entity   TYPE csequence
      iv_name     TYPE csequence
      ir_rows     TYPE REF TO data
      ir_keys     TYPE REF TO data OPTIONAL
      ir_result   TYPE REF TO data OPTIONAL
      ir_failed   TYPE REF TO data
      ir_reported TYPE REF TO data.

ENDINTERFACE.
