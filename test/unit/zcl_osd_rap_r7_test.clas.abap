CLASS zcl_osd_rap_r7_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R7 (docs/rap-runtime.md, "R7"): the tour demo (src/rap_r7) -- the
* tour written by the managed save and logged by the saver's save_modified
* (with additional save), its stops written by save_modified alone (with
* unmanaged save), the stops' validation in a second behavior pool, and
* the save sequence with adjust_numbers and the savers.
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rap_r7_test IMPLEMENTATION.
ENDCLASS.
