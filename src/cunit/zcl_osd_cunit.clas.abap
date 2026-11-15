CLASS zcl_osd_cunit DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The unit of measure conversion exit (CUNIT) the function modules
* CONVERSION_EXIT_CUNIT_OUTPUT and _INPUT of this folder run: a unit's
* internal key (MSEHI) and its language-dependent external, commercial
* form (MSEH3), read from
* the unit text table: T006A on a system (public table,
* https://www.sapdatasheet.org/abap/tabl/t006a.html: SPRAS, MSEHI, MSEH3,
* MSEHT, MSEHL, client-dependent), a twin's own table of the same columns
* in its tests. Not in open-abap-core (ANORMALIES
* 2026-11-15-cunit-missing).
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_unit,
             external   TYPE string,
             short_text TYPE string,
             long_text  TYPE string,
           END OF ty_unit.

* the table the units are read from; T006A when not given
    CLASS-METHODS text_table
      IMPORTING
        iv_table TYPE csequence DEFAULT 'T006A'.

    CLASS-METHODS external
      IMPORTING
        iv_internal TYPE any
        iv_langu    TYPE sy-langu OPTIONAL
      EXPORTING
        es_unit     TYPE ty_unit
        ev_found    TYPE abap_bool.

    CLASS-METHODS internal
      IMPORTING
        iv_external TYPE any
        iv_langu    TYPE sy-langu OPTIONAL
      EXPORTING
        ev_internal TYPE string
        ev_found    TYPE abap_bool.
  PRIVATE SECTION.
    CLASS-DATA gv_table TYPE string VALUE 'T006A'.

    CLASS-METHODS langu
      IMPORTING
        iv_langu        TYPE sy-langu
      RETURNING
        VALUE(rv_langu) TYPE sy-langu.
ENDCLASS.

CLASS zcl_osd_cunit IMPLEMENTATION.

  METHOD text_table.
    gv_table = to_upper( iv_table ).
  ENDMETHOD.

  METHOD langu.
    rv_langu = iv_langu.
    IF rv_langu IS INITIAL.
      rv_langu = sy-langu.
    ENDIF.
  ENDMETHOD.

  METHOD external.
    DATA lv_langu TYPE sy-langu.
    DATA lv_msehi TYPE c LENGTH 3.
    DATA lv_mseh3 TYPE c LENGTH 3.
    DATA lv_mseht TYPE c LENGTH 10.
    DATA lv_msehl TYPE c LENGTH 30.

    CLEAR: es_unit, ev_found.
    lv_langu = langu( iv_langu ).
    lv_msehi = iv_internal.
    TRY.
        SELECT SINGLE mseh3 mseht msehl FROM (gv_table)
          INTO (lv_mseh3, lv_mseht, lv_msehl)
          WHERE spras = lv_langu AND msehi = lv_msehi.
        IF sy-subrc = 0.
          ev_found = abap_true.
          es_unit-external   = lv_mseh3.
          es_unit-short_text = lv_mseht.
          es_unit-long_text  = lv_msehl.
        ENDIF.
      CATCH cx_root ##NO_HANDLER.
* no unit text table in this system: no unit is found
    ENDTRY.
  ENDMETHOD.

  METHOD internal.
    DATA lv_langu TYPE sy-langu.
    TYPES ty_msehi TYPE c LENGTH 3.
    DATA lt_msehi TYPE STANDARD TABLE OF ty_msehi WITH DEFAULT KEY.
    DATA lv_msehi TYPE c LENGTH 3.
    DATA lv_mseh3 TYPE c LENGTH 3.

    CLEAR: ev_internal, ev_found.
    lv_langu = langu( iv_langu ).
    lv_mseh3 = iv_external.
    TRY.
* by the form a person reads; two units with one form in one language
* would be ambiguous, the first by key wins (not measured)
        SELECT msehi FROM (gv_table) INTO TABLE lt_msehi
          WHERE spras = lv_langu AND mseh3 = lv_mseh3
          ORDER BY msehi.
        READ TABLE lt_msehi INTO lv_msehi INDEX 1.
        IF sy-subrc = 0.
          ev_found = abap_true.
          ev_internal = lv_msehi.
        ENDIF.
      CATCH cx_root ##NO_HANDLER.
* no unit text table in this system: no unit is found
    ENDTRY.
  ENDMETHOD.

ENDCLASS.
