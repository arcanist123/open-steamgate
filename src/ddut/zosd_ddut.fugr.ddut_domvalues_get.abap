FUNCTION ddut_domvalues_get.
* Clean room. The interface is SAP's: name, parameters and exception are
* the contract the callers were written against (the public signature:
* https://www.sapdatasheet.org/abap/func/ddut_domvalues_get.html); the
* body is ours. A domain's fixed values of the active version, read from
* the dictionary tables DD07L (values) and DD07T (texts), with the texts
* in LANGU (SY-LANGU when not passed). TEXTS_ONLY = 'X' reads the entries
* of the text table only: a value without a text in LANGU is left out.
* Otherwise every value comes back, its text blank where LANGU has none.
* ILLEGAL_INPUT: no name, or a name with no fixed values (unknown domain).
* Both tables are client-independent; over an existing HANA schema they
* are read through the shadow schema like any other table.
  DATA lv_langu TYPE sylangu.
  DATA lt_values TYPE STANDARD TABLE OF dd07l WITH DEFAULT KEY.
  DATA ls_value TYPE dd07l.
  DATA lt_texts TYPE STANDARD TABLE OF dd07t WITH DEFAULT KEY.
  DATA ls_text TYPE dd07t.
  DATA ls_out TYPE dd07v.

  CLEAR dd07v_tab[].
  IF name IS INITIAL.
    RAISE illegal_input.
  ENDIF.
  lv_langu = langu.
  IF lv_langu IS INITIAL.
    lv_langu = sy-langu.
  ENDIF.

  SELECT domname valpos domvalue_l domvalue_h appval
    FROM dd07l INTO CORRESPONDING FIELDS OF TABLE lt_values
    WHERE domname = name AND as4local = 'A' AND as4vers = '0000'
    ORDER BY valpos.
  IF lt_values IS INITIAL.
    RAISE illegal_input.
  ENDIF.

  SELECT valpos ddtext domval_ld domval_hd
    FROM dd07t INTO CORRESPONDING FIELDS OF TABLE lt_texts
    WHERE domname = name AND ddlanguage = lv_langu
      AND as4local = 'A' AND as4vers = '0000'.

  LOOP AT lt_values INTO ls_value.
    CLEAR ls_out.
    READ TABLE lt_texts INTO ls_text WITH KEY valpos = ls_value-valpos.
    IF sy-subrc = 0.
      ls_out-ddlanguage = lv_langu.
      ls_out-ddtext = ls_text-ddtext.
      ls_out-domval_ld = ls_text-domval_ld.
      ls_out-domval_hd = ls_text-domval_hd.
    ELSEIF texts_only = 'X'.
      CONTINUE.
    ENDIF.
    ls_out-domname = ls_value-domname.
    ls_out-valpos = ls_value-valpos.
    ls_out-domvalue_l = ls_value-domvalue_l.
    ls_out-domvalue_h = ls_value-domvalue_h.
    ls_out-appval = ls_value-appval.
    APPEND ls_out TO dd07v_tab.
  ENDLOOP.
ENDFUNCTION.
