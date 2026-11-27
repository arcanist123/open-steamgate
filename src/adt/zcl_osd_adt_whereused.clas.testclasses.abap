CLASS ltcl_whereused DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS document FOR TESTING.
    METHODS empty FOR TESTING.
ENDCLASS.
CLASS ltcl_whereused IMPLEMENTATION.
  METHOD document.
    DATA lt_hits TYPE zcl_osd_adt_whereused=>tt_hit.
    DATA ls_hit TYPE zcl_osd_adt_whereused=>ty_hit.
    DATA lv_xml TYPE string.
    ls_hit-name = `ZCL_A`.
    ls_hit-type = `CLAS`.
    ls_hit-adt_type = `CLAS/OC`.
    ls_hit-uri = `/sap/bc/adt/oo/classes/zcl_a`.
    ls_hit-package = `$TMP`.
    APPEND ls_hit TO lt_hits.
    lv_xml = zcl_osd_adt_whereused=>document( lt_hits ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<usageReferences:usageReferenceResult xmlns:usageReferences="http://www.sap.com/adt/ris/usageReferences"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<usageReferences:referencedObject uri="/sap/bc/adt/oo/classes/zcl_a" parentUri="" isResult="true"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:type="CLAS/OC" adtcore:name="ZCL_A"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<adtcore:packageRef adtcore:name="$TMP" adtcore:type="DEVC/K" adtcore:uri="/sap/bc/adt/packages/%24tmp"/>` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<objectIdentifier>CLAS/OC;ZCL_A</objectIdentifier>` ) ).
  ENDMETHOD.
  METHOD empty.
    DATA lt_hits TYPE zcl_osd_adt_whereused=>tt_hit.
    DATA lv_xml TYPE string.
    lv_xml = zcl_osd_adt_whereused=>document( lt_hits ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS |<usageReferences:referencedObjects>\n  </usageReferences:referencedObjects>| ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<usageReferences:affectedObjects/>` ) ).
  ENDMETHOD.
ENDCLASS.
