INTERFACE zif_stg_sadl_behavior PUBLIC.
* A CDS entity whose writes belong to its behavior (docs/rap-runtime.md,
* "Serving"): the SADL data provider still reads the entity through the
* view, and hands create, update, delete and actions to an implementation
* of this interface instead of writing the table itself. The rows are the
* view's own rows (the CDS source's create_line); IT_FIELDS names the
* components the request gave (upper case), which is what the behavior's
* field control is checked against. A refusal is a business exception with
* the behavior's message text, and then nothing has been written.
* Implemented in src/rap/ over the managed RAP runtime; the SADL data
* provider creates that class by name, so a tree without RAP still compiles.

* whether IV_ENTITY (a CDS entity name) has a behavior this implementation runs
  METHODS handles
    IMPORTING
      iv_entity         TYPE csequence
    RETURNING
      VALUE(rv_handles) TYPE abap_bool.

* create one instance and save it. CS_ROW: the payload in, the saved
* instance's keys filled in on the way out
  METHODS create
    IMPORTING
      iv_entity TYPE csequence
      it_fields TYPE string_table
    CHANGING
      cs_row    TYPE any
    RAISING
      /iwbep/cx_mgw_busi_exception
      /iwbep/cx_mgw_tech_exception.

* change one instance and save it. IS_ROW: the keys and the values,
* IS_CURRENT: the instance as it is before the request. IV_REPLACE (PUT):
* an editable field the request did not give becomes initial; otherwise
* (PATCH, MERGE) only the given fields change
  METHODS update
    IMPORTING
      iv_entity  TYPE csequence
      is_row     TYPE any
      is_current TYPE any
      it_fields  TYPE string_table
      iv_replace TYPE abap_bool DEFAULT abap_false
    RAISING
      /iwbep/cx_mgw_busi_exception
      /iwbep/cx_mgw_tech_exception.

  METHODS delete
    IMPORTING
      iv_entity TYPE csequence
      is_row    TYPE any
    RAISING
      /iwbep/cx_mgw_busi_exception
      /iwbep/cx_mgw_tech_exception.

* run an instance action on the instance IS_ROW names by its keys, and save.
* ES_ROW: the keys of the instance to answer when it is another one (a
* factory action's new instance, RAP R6); left initial otherwise
  METHODS execute
    IMPORTING
      iv_entity TYPE csequence
      iv_action TYPE csequence
      is_row    TYPE any
    EXPORTING
      es_row    TYPE any
    RAISING
      /iwbep/cx_mgw_busi_exception
      /iwbep/cx_mgw_tech_exception.

* R5: create one instance below its parent (POST Parent(...)/to_Child, a
* create by association, docs/rap-runtime.md). IV_ENTITY the parent's CDS
* entity, IV_ASSOC its association (the CDS alias, _Items), IS_PARENT a row
* of the parent's view with the keys filled, IV_TARGET the child's CDS
* entity; CS_ROW the child's payload in, its keys filled in on the way out
  METHODS create_by
    IMPORTING
      iv_entity TYPE csequence
      iv_assoc  TYPE csequence
      is_parent TYPE any
      iv_target TYPE csequence
      it_fields TYPE string_table
    CHANGING
      cs_row    TYPE any
    RAISING
      /iwbep/cx_mgw_busi_exception
      /iwbep/cx_mgw_tech_exception.

* R8: the class serving IV_ENTITY's active and draft rows
* (zif_stg_cds_draft_source) when its business object is draft-enabled,
* initial otherwise
  METHODS draft_source
    IMPORTING
      iv_entity       TYPE csequence
    RETURNING
      VALUE(rv_class) TYPE string.

* the instance actions of IV_ENTITY a client may call, upper case
  METHODS actions
    IMPORTING
      iv_entity         TYPE csequence
    RETURNING
      VALUE(rt_actions) TYPE string_table.

ENDINTERFACE.
