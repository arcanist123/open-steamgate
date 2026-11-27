CLASS zcl_osd_select_loop_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL HARMLESS.
* A SELECT loop over an inner join of two aliased tables, INTO a list of
* variables, Open SQL 7.02 style: every target is assigned per row and
* sy-dbcnt counts the rows read so far, so a body that pages with it
* ($skip/$top in a Gateway read) skips the right rows.
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_select_loop_test IMPLEMENTATION.
ENDCLASS.
