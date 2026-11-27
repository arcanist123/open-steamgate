CLASS ltcl_lazy DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The stub raise the island's unresolvable methods carry: the text must
* name what is missing, and the RAISE statement must travel as cx_no_check
* -- no RAISING clause anywhere, the way the stub is written into a body
* whose signature came from the dump. And the kernel-side hook (round 5):
* the constructor signals the host -- a handler receives the names when one
* is installed, the console says them when none is -- and a CATCH of the
* raise cannot un-send the signal, which is the property $batch's
* CATCH cx_root must not defeat.
  PRIVATE SECTION.
    METHODS text_names_the_missing FOR TESTING RAISING cx_static_check.
    METHODS raise_carries_missing FOR TESTING RAISING cx_static_check.
    METHODS handler_receives_the_names FOR TESTING RAISING cx_static_check.
    METHODS handler_fires_even_when_caught FOR TESTING RAISING cx_static_check.
    METHODS without_a_handler_it_logs FOR TESTING RAISING cx_static_check.
    METHODS signal_alone_does_not_raise FOR TESTING RAISING cx_static_check.
ENDCLASS.

CLASS ltcl_lazy IMPLEMENTATION.

  METHOD text_names_the_missing.
    DATA lo_cut TYPE REF TO zcx_osd_not_activated.
* a no-op handler for this test: the constructor's kernel hook otherwise
* prints "not activated: ..." on console.error in every unit run
    WRITE '@KERNEL globalThis.osdNotActivated = () => {};'.
    CREATE OBJECT lo_cut EXPORTING missing = 'ZOSD_H5C_HEAD, ZOSD_H5C_ROLE'.
    WRITE '@KERNEL delete globalThis.osdNotActivated;'.
    cl_abap_unit_assert=>assert_equals(
      act = lo_cut->get_text( )
      exp = |not activated here: needs ZOSD_H5C_HEAD, ZOSD_H5C_ROLE| ).
  ENDMETHOD.

  METHOD raise_carries_missing.
    DATA lo_cut TYPE REF TO zcx_osd_not_activated.
    DATA lv_text TYPE string.
* the same no-op handler: the signal must not reach the console here
    WRITE '@KERNEL globalThis.osdNotActivated = () => {};'.
    TRY.
        RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_W'.
      CATCH zcx_osd_not_activated INTO lo_cut.
        lv_text = lo_cut->get_text( ).
    ENDTRY.
    WRITE '@KERNEL delete globalThis.osdNotActivated;'.
    IF lo_cut IS NOT BOUND.
      cl_abap_unit_assert=>fail( msg = 'the stub raise did not raise' ).
    ENDIF.
    cl_abap_unit_assert=>assert_equals( act = lv_text exp = |not activated here: needs ZOSD_H5C_W| ).
  ENDMETHOD.

  METHOD handler_receives_the_names.
    DATA lo_cut TYPE REF TO zcx_osd_not_activated.
    DATA lv_seen TYPE string.
    CLEAR lv_seen.
* install the host handler, construct, read back what it received, uninstall
    WRITE '@KERNEL globalThis.osdNotActivated = (m) => { globalThis.h5cSeen = m; };'.
    CREATE OBJECT lo_cut EXPORTING missing = 'ZOSD_H5C_HEAD, ZOSD_H5C_ROLE'.
    WRITE '@KERNEL lv_seen.set(globalThis.h5cSeen === undefined ? "<unset>" : globalThis.h5cSeen);'.
    WRITE '@KERNEL delete globalThis.osdNotActivated; delete globalThis.h5cSeen;'.
    cl_abap_unit_assert=>assert_equals(
      act = lv_seen
      exp = 'ZOSD_H5C_HEAD, ZOSD_H5C_ROLE' ).
  ENDMETHOD.

  METHOD handler_fires_even_when_caught.
    DATA lo_cut TYPE REF TO zcx_osd_not_activated.
    DATA lv_seen TYPE string.
    CLEAR lv_seen.
* the $batch property: the CATCH happens AFTER the constructor signalled,
* so the host has the names even when the request fails as an error part
* and nothing else on the wire says why
    WRITE '@KERNEL globalThis.osdNotActivated = (m) => { globalThis.h5cSeen = m; };'.
    TRY.
        RAISE EXCEPTION TYPE zcx_osd_not_activated EXPORTING missing = 'ZOSD_H5C_W'.
      CATCH zcx_osd_not_activated INTO lo_cut.
    ENDTRY.
    WRITE '@KERNEL lv_seen.set(globalThis.h5cSeen === undefined ? "<unset>" : globalThis.h5cSeen);'.
    WRITE '@KERNEL delete globalThis.osdNotActivated; delete globalThis.h5cSeen;'.
    cl_abap_unit_assert=>assert_equals(
      act = lv_seen
      exp = 'ZOSD_H5C_W' ).
  ENDMETHOD.

  METHOD without_a_handler_it_logs.
    DATA lo_cut TYPE REF TO zcx_osd_not_activated.
    DATA lv_logged TYPE string.
    CLEAR lv_logged.
* no handler installed: the console carries the signal instead -- spied,
* restored, and read back through the kernel escape
    WRITE '@KERNEL delete globalThis.osdNotActivated;'.
    WRITE '@KERNEL const h5cErr = console.error; console.error = (m) => { globalThis.h5cLog = String(m); };'.
    CREATE OBJECT lo_cut EXPORTING missing = 'ZOSD_H5C_W'.
    WRITE '@KERNEL console.error = h5cErr;'.
    WRITE '@KERNEL lv_logged.set(globalThis.h5cLog === undefined ? "<none>" : globalThis.h5cLog);'.
    WRITE '@KERNEL delete globalThis.h5cLog;'.
    cl_abap_unit_assert=>assert_equals(
      act = lv_logged
      exp = 'not activated: ZOSD_H5C_W' ).
  ENDMETHOD.

  METHOD signal_alone_does_not_raise.
    DATA lv_seen TYPE string.
    CLEAR lv_seen.
* what a stubbed CLASS_CONSTRUCTOR calls: the host gets the names, and the
* caller goes on -- nothing is raised at load
    WRITE '@KERNEL globalThis.osdNotActivated = (m) => { globalThis.h5cSeen = m; };'.
    zcx_osd_not_activated=>signal( 'ZOSD_H5C_CCTOR' ).
    WRITE '@KERNEL lv_seen.set(globalThis.h5cSeen === undefined ? "<unset>" : globalThis.h5cSeen);'.
    WRITE '@KERNEL delete globalThis.osdNotActivated; delete globalThis.h5cSeen;'.
    cl_abap_unit_assert=>assert_equals( act = lv_seen exp = 'ZOSD_H5C_CCTOR' ).
  ENDMETHOD.

ENDCLASS.
