CLASS cl_abap_behavior_saver DEFINITION PUBLIC INHERITING FROM cl_abap_behv CREATE PUBLIC
  GLOBAL FRIENDS zcl_osd_rap_runtime.
* The base of a behavior pool's local saver class (lsc_*): the phases of the
* save sequence, each empty until the pool redefines it. Clean-room; the
* method names and their order are the public contract, and the managed
* runtime (ZCL_OSD_RAP_RUNTIME, a friend) is what calls them:
*
*   finalize -> check_before_save -> save -> cleanup
*   (cleanup_finalize instead of save and cleanup when finalize or
*   check_before_save failed)
*
* On a system these phases have implicit FAILED / REPORTED (LATE)
* parameters. abaplint voids every parameter of this class's methods (its
* RAP saver workaround, core/abap/types/method_parameters.js), and a void
* parameter does not transpile, so in R2 the phases take none: a saver
* signals nothing back yet (docs/rap-runtime.md).
  PUBLIC SECTION.
  PROTECTED SECTION.
    METHODS finalize.

    METHODS check_before_save.

    METHODS cleanup.

    METHODS cleanup_finalize.
ENDCLASS.

CLASS cl_abap_behavior_saver IMPLEMENTATION.

  METHOD finalize.
    RETURN.
  ENDMETHOD.

  METHOD check_before_save.
    RETURN.
  ENDMETHOD.

  METHOD cleanup.
    RETURN.
  ENDMETHOD.

  METHOD cleanup_finalize.
    RETURN.
  ENDMETHOD.

ENDCLASS.
