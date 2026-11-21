FUNCTION conversion_exit_cunit_output.
* Clean room. The interface is SAP's (the public signature:
* https://www.sapdatasheet.org/abap/func/conversion_exit_cunit_output.html);
* the body is ours, ZCL_OSD_CUNIT. The internal unit INPUT in the external
* form of LANGUAGE (SY-LANGU when not passed): the commercial form MSEH3,
* the short text MSEHT, the long text MSEHL of the unit text table.
* UNIT_NOT_FOUND when the unit has no row in that language.
  DATA ls_unit TYPE zcl_osd_cunit=>ty_unit.
  DATA lv_found TYPE abap_bool.

  zcl_osd_cunit=>external( EXPORTING iv_internal = input
                                     iv_langu    = language
                           IMPORTING es_unit     = ls_unit
                                     ev_found    = lv_found ).
  IF lv_found = abap_false.
    RAISE unit_not_found.
  ENDIF.
  output = ls_unit-external.
  short_text = ls_unit-short_text.
  long_text = ls_unit-long_text.
ENDFUNCTION.
