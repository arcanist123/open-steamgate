CLASS cl_abap_behavior_saver DEFINITION PUBLIC INHERITING FROM cl_abap_behv CREATE PUBLIC
  GLOBAL FRIENDS zcl_osd_rap_runtime.
* The base of a behavior pool's local saver class (lsc_*): the phases of the
* save sequence, each empty until the pool redefines it. Clean-room; the
* method names and their order are the public contract, and the managed
* runtime (ZCL_OSD_RAP_RUNTIME, a friend) is what calls them:
*
*   finalize -> check_before_save -> adjust_numbers -> save -> cleanup
*   (cleanup_finalize instead of the rest when finalize or
*   check_before_save failed)
*
* R10: so has adjust_numbers (late numbering), the same way.
* R7: save_modified (with additional / unmanaged save) has parameters typed
* by the BDEF. It is declared below for abaplint's static check, which voids
* them as it voids every parameter here; the build blanks that declaration
* (between the LINT-ONLY markers, and the METHOD, tools/rap/lower-derived.mjs) and
* turns a pool's `METHODS save_modified REDEFINITION.` into a typed
* declaration of its own, which the generated adapter calls by name
* (docs/rap-runtime.md, R7).
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

    METHODS save.

* LINT-ONLY begin
* R10: adjust_numbers has the BDEF's MAPPED LATE and REPORTED; like
* save_modified it is declared here for the static check only, and a pool's
* REDEFINITION becomes a typed declaration of its own in the build
    METHODS adjust_numbers
      CHANGING
        mapped   TYPE any
        reported TYPE any.

    METHODS save_modified
      IMPORTING
        create   TYPE any
        update   TYPE any
        delete   TYPE any
      CHANGING
        reported TYPE any.
* LINT-ONLY end

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

  METHOD adjust_numbers.
* LINT-ONLY: blanked in the build with its declaration (see the header)
    RETURN.
  ENDMETHOD.

  METHOD save.
    RETURN.
  ENDMETHOD.

  METHOD save_modified.
* LINT-ONLY: blanked in the build with its declaration (see the header)
    RETURN.
  ENDMETHOD.

  METHOD cleanup.
    RETURN.
  ENDMETHOD.

  METHOD cleanup_finalize.
    RETURN.
  ENDMETHOD.

ENDCLASS.
