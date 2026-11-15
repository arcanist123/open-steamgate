FUNCTION conversion_exit_cunit_input.
* Clean room. The interface is SAP's (the public signature:
* https://www.sapdatasheet.org/abap/func/conversion_exit_cunit_input.html);
* the body is ours, ZCL_OSD_CUNIT. The external unit INPUT of LANGUAGE
* (SY-LANGU when not passed) as its internal key: the unit whose
* commercial form MSEH3 is INPUT. An initial INPUT is an initial OUTPUT;
* UNIT_NOT_FOUND when no unit has that form in that language.
  DATA lv_internal TYPE string.
  DATA lv_found TYPE abap_bool.

  IF input IS INITIAL.
    CLEAR output.
    RETURN.
  ENDIF.
  zcl_osd_cunit=>internal( EXPORTING iv_external = input
                                     iv_langu    = language
                           IMPORTING ev_internal = lv_internal
                                     ev_found    = lv_found ).
  IF lv_found = abap_false.
    RAISE unit_not_found.
  ENDIF.
  output = lv_internal.
ENDFUNCTION.
