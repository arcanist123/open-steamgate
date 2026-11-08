CLASS cl_abap_behavior_handler DEFINITION PUBLIC INHERITING FROM cl_abap_behv CREATE PUBLIC.
* The base of a behavior pool's local handler classes (lhc_*). Clean-room:
* it adds nothing to CL_ABAP_BEHV here; the managed runtime instantiates the
* local class by its absolute name and calls its methods
* (docs/rap-runtime.md, "Handler methods").
  PUBLIC SECTION.
ENDCLASS.

CLASS cl_abap_behavior_handler IMPLEMENTATION.
ENDCLASS.
