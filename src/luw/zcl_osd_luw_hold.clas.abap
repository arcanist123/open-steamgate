CLASS zcl_osd_luw_hold DEFINITION
  PUBLIC
  FINAL
  CREATE PRIVATE.
* Whether an enclosing unit holds the LUW: a V2 changeset (ZCL_STG_BATCH) or
* a V4 atomicity group (ZCL_OSD_V4_BATCH) commits or rolls back as a whole,
* so what runs inside it writes but does not end the LUW itself. The RAP save
* in ZCL_OSD_RAP_SADL asks. A real Gateway forbids COMMIT WORK in a changeset.
*
* It lives here and not in either batch class so that the RAP runtime does not
* depend on a gateway: the batches set it, the RAP bridge reads it, and both
* depend only on this package. The HTTP fronts clear it at request entry,
* because a class static outlives the request (ANORMALIES, PR #901).

  PUBLIC SECTION.
    CLASS-METHODS held
      RETURNING
        VALUE(rv_held) TYPE abap_bool.

    CLASS-METHODS hold
      IMPORTING
        iv_held TYPE abap_bool.

  PROTECTED SECTION.
  PRIVATE SECTION.
    CLASS-DATA gv_held TYPE abap_bool.
ENDCLASS.

CLASS zcl_osd_luw_hold IMPLEMENTATION.

  METHOD held.
    rv_held = gv_held.
  ENDMETHOD.

  METHOD hold.
    gv_held = iv_held.
  ENDMETHOD.

ENDCLASS.
