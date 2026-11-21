INTERFACE zif_osd_rap_augment PUBLIC.
* R10 (docs/rap-runtime.md, "Augment"): the augment of a projection, `use
* create ( augment )` / `use update ( augment )`, generated per projection
* BDEF by tools/rap/rap-runtime-gen.mjs because the pool's FOR MODIFY method
* is typed with the projection's derived types. ZCL_OSD_RAP_RUNTIME=>AUGMENT
* calls it with the base's transaction active, so the MODIFY AUGMENTING
* ENTITIES of the pool reaches the base.

* an empty TABLE FOR CREATE (IV_KIND CREATE) or UPDATE of the projection
* entity IV_ENTITY
  METHODS new_table
    IMPORTING
      iv_entity       TYPE csequence
      iv_kind         TYPE csequence
    RETURNING
      VALUE(rr_table) TYPE REF TO data.

* call the augment with the request's create and update rows (either may be
* unbound); EV_FAILED the rows it put into FAILED, ET_MESSAGES the texts
* of the messages it put into REPORTED
  METHODS augment
    IMPORTING
      iv_entity   TYPE csequence
      ir_create   TYPE REF TO data OPTIONAL
      ir_update   TYPE REF TO data OPTIONAL
    EXPORTING
      ev_failed   TYPE i
      et_messages TYPE string_table.

ENDINTERFACE.
