CLASS zcl_osd_rap_r4_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R4 (docs/rap-runtime.md, "R4"): early numbering over the trip demo
* (src/rap_r4) -- the content IDs a caller gives survive the numbering, and
* a numbering method that answers for a row with neither a key nor a
* failure fails that row.
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rap_r4_test IMPLEMENTATION.
ENDCLASS.
