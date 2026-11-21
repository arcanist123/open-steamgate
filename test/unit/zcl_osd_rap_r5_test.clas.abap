CLASS zcl_osd_rap_r5_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R5 (docs/rap-runtime.md, "R5"): the order demo (src/rap_r5) as a
* tree -- create by association with the cba numbering of the pool, read by
* association both ways, the delete that takes the items with the order, the
* root's total change stamp on a child write, the root's lock on a child
* write, the child's validation in the save.
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rap_r5_test IMPLEMENTATION.
ENDCLASS.
