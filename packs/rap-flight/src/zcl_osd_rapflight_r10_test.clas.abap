CLASS zcl_osd_rapflight_r10_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R10 on the flight's draft BOs (docs/rap-runtime.md, "R10"): the
* supplement (early numbering by category, a validation in Prepare and on
* Activate) and the agency (late numbering: a preliminary key and %pid while
* drafting, the final key from the saver's adjust_numbers on Activate),
* created as drafts, edited, activated and discarded through the runtime
* with %is_draft, as EML does. The projections and their augment are the
* wire's (test/rap-r10.mjs).
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rapflight_r10_test IMPLEMENTATION.
ENDCLASS.
