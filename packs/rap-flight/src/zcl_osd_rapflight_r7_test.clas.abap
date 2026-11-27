CLASS zcl_osd_rapflight_r7_test DEFINITION PUBLIC FINAL CREATE PUBLIC FOR TESTING
  DURATION SHORT RISK LEVEL DANGEROUS.
* RAP R7 on the flight travel BO (docs/rap-runtime.md, "R7"): what the wire
* test cannot see -- the travel pool's saver writes its change log into
* /dmo/log_travel after the managed write (with additional save), and the
* booking supplements reach /dmo/booksuppl_m only through it (with
* unmanaged save, the update-task function modules).
  PUBLIC SECTION.
  PROTECTED SECTION.
  PRIVATE SECTION.
ENDCLASS.

CLASS zcl_osd_rapflight_r7_test IMPLEMENTATION.
ENDCLASS.
