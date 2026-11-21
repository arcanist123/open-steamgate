CLASS zcl_osd_rap_r9_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R9 (docs/rap-runtime.md, "R9"): the owner of a draft on the trip demo
* (src/rap_r8) -- a draft is in process by the user who made it
* (ZCL_OSD_LOGON), another user's change, Activate, Discard, Resume,
* Prepare or Edit of it is refused, the same user goes on.
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rap_r9_test IMPLEMENTATION.
ENDCLASS.
