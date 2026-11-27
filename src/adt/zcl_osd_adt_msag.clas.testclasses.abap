CLASS ltcl_msag DEFINITION FINAL FOR TESTING DURATION SHORT RISK LEVEL HARMLESS.
  PRIVATE SECTION.
    METHODS parse FOR TESTING.
    METHODS document FOR TESTING.
    METHODS xml RETURNING VALUE(rv_xml) TYPE string.
ENDCLASS.
CLASS ltcl_msag IMPLEMENTATION.
  METHOD xml.
    rv_xml = `<abapGit><asx:values><T100A><ARBGB>ZMSG</ARBGB><MASTERLANG>E</MASTERLANG><STEXT>demo &lt;messages&gt;</STEXT></T100A>`
      && `<T100><T100><SPRSL>E</SPRSL><ARBGB>ZMSG</ARBGB><MSGNR>001</MSGNR><TEXT>Item &amp;1 not found</TEXT></T100>`
      && `<T100><SPRSL>D</SPRSL><ARBGB>ZMSG</ARBGB><MSGNR>001</MSGNR><TEXT>Position &amp;1 fehlt</TEXT></T100>`
      && `<T100><SPRSL>E</SPRSL><ARBGB>ZMSG</ARBGB><MSGNR>002</MSGNR><TEXT>Second</TEXT></T100></T100></asx:values></abapGit>`.
  ENDMETHOD.
  METHOD parse.
    DATA ls_class TYPE zcl_osd_adt_msag=>ty_class.
    DATA ls_message TYPE zcl_osd_adt_msag=>ty_message.
    ls_class = zcl_osd_adt_msag=>parse( iv_xml = xml( ) iv_name = `zmsg` ).
    cl_abap_unit_assert=>assert_equals( act = ls_class-name exp = `ZMSG` ).
    cl_abap_unit_assert=>assert_equals( act = ls_class-text exp = `demo <messages>` ).
    cl_abap_unit_assert=>assert_equals( act = ls_class-language exp = `E` ).
*   the master language only: the German row is not a second 001
    cl_abap_unit_assert=>assert_equals( act = lines( ls_class-messages ) exp = 2 ).
    READ TABLE ls_class-messages INDEX 1 INTO ls_message.
    cl_abap_unit_assert=>assert_equals( act = ls_message-number exp = `001` ).
    cl_abap_unit_assert=>assert_equals( act = ls_message-text exp = `Item &1 not found` ).
    cl_abap_unit_assert=>assert_equals( act = zcl_osd_adt_msag=>text( ls_class )
      exp = |001 Item &1 not found\n002 Second\n| ).
  ENDMETHOD.
  METHOD document.
    DATA ls_class TYPE zcl_osd_adt_msag=>ty_class.
    DATA ls_read TYPE zcl_osd_adt_host=>ty_read.
    DATA lv_xml TYPE string.
    ls_class = zcl_osd_adt_msag=>parse( iv_xml = xml( ) iv_name = `ZMSG` ).
    ls_read-package = `$TMP`.
    lv_xml = zcl_osd_adt_msag=>document( is_class = ls_class is_read = ls_read ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<mc:messageClass xmlns:mc="http://www.sap.com/adt/MessageClass"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:name="ZMSG" adtcore:type="MSAG/N"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `adtcore:description="demo &lt;messages&gt;"` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `<mc:messages mc:msgno="001" mc:msgtext="Item &amp;1 not found"/>` ) ).
    cl_abap_unit_assert=>assert_true( boolc( lv_xml CS `href="source/main" rel="http://www.sap.com/adt/relations/source" type="text/plain"` ) ).
  ENDMETHOD.
ENDCLASS.
