CLASS ltcl_domvalues DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* ZOSD_DDUT_STATUS: three values in VALPOS order 1..3, inserted out of
* order, texts in E and D, plus an inactive (N) version of value 1 with
* another text. ZOSD_DDUT_BARE: two values, no text in any language.
  PRIVATE SECTION.
    TYPES ty_values TYPE STANDARD TABLE OF dd07v WITH DEFAULT KEY.

    METHODS setup.
    METHODS teardown.
    METHODS values_and_texts_in_e FOR TESTING RAISING cx_static_check.
    METHODS texts_in_d FOR TESTING RAISING cx_static_check.
    METHODS default_language_is_sy_langu FOR TESTING RAISING cx_static_check.
    METHODS unknown_domain_raises FOR TESTING RAISING cx_static_check.
    METHODS initial_name_raises FOR TESTING RAISING cx_static_check.
    METHODS domain_without_texts FOR TESTING RAISING cx_static_check.
    METHODS texts_only_skips_untexted FOR TESTING RAISING cx_static_check.

    METHODS clear_rows.
    METHODS value
      IMPORTING
        iv_domname TYPE csequence
        iv_valpos  TYPE csequence
        iv_low     TYPE csequence
        iv_local   TYPE csequence DEFAULT 'A'.
    METHODS text
      IMPORTING
        iv_domname TYPE csequence
        iv_langu   TYPE csequence
        iv_valpos  TYPE csequence
        iv_text    TYPE csequence
        iv_local   TYPE csequence DEFAULT 'A'.
    METHODS read
      IMPORTING
        iv_name       TYPE csequence
        iv_langu      TYPE sylangu OPTIONAL
        iv_texts_only TYPE char1 DEFAULT 'X'
      EXPORTING
        ev_subrc      TYPE sysubrc
        et_values     TYPE ty_values.
    METHODS joined
      IMPORTING
        it_values      TYPE ty_values
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS ltcl_domvalues IMPLEMENTATION.

  METHOD setup.
    clear_rows( ).
    value( iv_domname = 'ZOSD_DDUT_STATUS' iv_valpos = '0003' iv_low = 'C' ).
    value( iv_domname = 'ZOSD_DDUT_STATUS' iv_valpos = '0001' iv_low = 'N' ).
    value( iv_domname = 'ZOSD_DDUT_STATUS' iv_valpos = '0002' iv_low = 'P' ).
    value( iv_domname = 'ZOSD_DDUT_STATUS' iv_valpos = '0001' iv_low = 'X' iv_local = 'N' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'E' iv_valpos = '0001' iv_text = 'New' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'E' iv_valpos = '0002' iv_text = 'In process' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'E' iv_valpos = '0003' iv_text = 'Closed' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'D' iv_valpos = '0001' iv_text = 'Neu' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'D' iv_valpos = '0002' iv_text = 'In Bearbeitung' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'D' iv_valpos = '0003' iv_text = 'Abgeschlossen' ).
    text( iv_domname = 'ZOSD_DDUT_STATUS' iv_langu = 'E' iv_valpos = '0001' iv_text = 'Inactive text' iv_local = 'N' ).
    value( iv_domname = 'ZOSD_DDUT_BARE' iv_valpos = '0001' iv_low = 'A' ).
    value( iv_domname = 'ZOSD_DDUT_BARE' iv_valpos = '0002' iv_low = 'B' ).
  ENDMETHOD.

  METHOD teardown.
    clear_rows( ).
  ENDMETHOD.

  METHOD clear_rows.
    DELETE FROM dd07l WHERE domname LIKE 'ZOSD_DDUT_%'.
    DELETE FROM dd07t WHERE domname LIKE 'ZOSD_DDUT_%'.
  ENDMETHOD.

  METHOD value.
    DATA ls_row TYPE dd07l.
    ls_row-domname = iv_domname.
    ls_row-as4local = iv_local.
    ls_row-valpos = iv_valpos.
    ls_row-as4vers = '0000'.
    ls_row-domvalue_l = iv_low.
    INSERT dd07l FROM ls_row.
  ENDMETHOD.

  METHOD text.
    DATA ls_row TYPE dd07t.
    ls_row-domname = iv_domname.
    ls_row-ddlanguage = iv_langu.
    ls_row-as4local = iv_local.
    ls_row-valpos = iv_valpos.
    ls_row-as4vers = '0000'.
    ls_row-ddtext = iv_text.
    INSERT dd07t FROM ls_row.
  ENDMETHOD.

  METHOD read.
    DATA lv_name TYPE ddobjname.
    lv_name = iv_name.
    CLEAR et_values.
    IF iv_langu IS SUPPLIED.
      CALL FUNCTION 'DDUT_DOMVALUES_GET'
        EXPORTING
          name          = lv_name
          langu         = iv_langu
          texts_only    = iv_texts_only
        TABLES
          dd07v_tab     = et_values
        EXCEPTIONS
          illegal_input = 1
          OTHERS        = 2.
    ELSE.
      CALL FUNCTION 'DDUT_DOMVALUES_GET'
        EXPORTING
          name          = lv_name
          texts_only    = iv_texts_only
        TABLES
          dd07v_tab     = et_values
        EXCEPTIONS
          illegal_input = 1
          OTHERS        = 2.
    ENDIF.
    ev_subrc = sy-subrc.
  ENDMETHOD.

  METHOD joined.
    DATA ls_value TYPE dd07v.
    LOOP AT it_values INTO ls_value.
      rv_text = |{ rv_text }{ ls_value-valpos }:{ ls_value-domvalue_l }:{ ls_value-ddlanguage }:{ ls_value-ddtext };|.
    ENDLOOP.
  ENDMETHOD.

  METHOD values_and_texts_in_e.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_STATUS' iv_langu = 'E' IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = joined( lt_values )
      exp = `0001:N:E:New;0002:P:E:In process;0003:C:E:Closed;` ).
  ENDMETHOD.

  METHOD texts_in_d.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_STATUS' iv_langu = 'D' IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = joined( lt_values )
      exp = `0001:N:D:Neu;0002:P:D:In Bearbeitung;0003:C:D:Abgeschlossen;` ).
  ENDMETHOD.

  METHOD default_language_is_sy_langu.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    DATA lt_explicit TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_STATUS' IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    read( EXPORTING iv_name = 'ZOSD_DDUT_STATUS' iv_langu = sy-langu IMPORTING et_values = lt_explicit ).
    cl_abap_unit_assert=>assert_not_initial( lt_values ).
    cl_abap_unit_assert=>assert_equals( act = joined( lt_values ) exp = joined( lt_explicit ) ).
  ENDMETHOD.

  METHOD unknown_domain_raises.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_NOPE' iv_langu = 'E' IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 1 ).
    cl_abap_unit_assert=>assert_initial( lt_values ).
  ENDMETHOD.

  METHOD initial_name_raises.
    DATA lv_subrc TYPE sysubrc.
    read( EXPORTING iv_name = '' iv_langu = 'E' IMPORTING ev_subrc = lv_subrc ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 1 ).
  ENDMETHOD.

  METHOD domain_without_texts.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_BARE' iv_langu = 'E' iv_texts_only = ' '
      IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = joined( lt_values ) exp = `0001:A::;0002:B::;` ).
  ENDMETHOD.

  METHOD texts_only_skips_untexted.
    DATA lv_subrc TYPE sysubrc.
    DATA lt_values TYPE ty_values.
    read( EXPORTING iv_name = 'ZOSD_DDUT_BARE' iv_langu = 'E'
      IMPORTING ev_subrc = lv_subrc et_values = lt_values ).
    cl_abap_unit_assert=>assert_equals( act = lv_subrc exp = 0 ).
    cl_abap_unit_assert=>assert_initial( lt_values ).
  ENDMETHOD.

ENDCLASS.
