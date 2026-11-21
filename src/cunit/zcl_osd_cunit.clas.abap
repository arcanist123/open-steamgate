CLASS zcl_osd_cunit DEFINITION PUBLIC FINAL CREATE PUBLIC.
* The unit of measure conversion exit (CUNIT) the function modules
* CONVERSION_EXIT_CUNIT_OUTPUT and _INPUT of this folder run: a unit's
* internal key (MSEHI) and its language-dependent external, commercial
* form (MSEH3), read from the unit text table: T006A on a system (public
* table, https://www.sapdatasheet.org/abap/tabl/t006a.html: SPRAS, MSEHI,
* MSEH3, MSEHT, MSEHL, client-dependent), a twin's own table of the same
* columns in its tests. Not in open-abap-core (ANORMALIES
* 2026-11-15-cunit-missing).
*
* Reads. Inside a scope (scope_begin / scope_end: the gateway opens one per
* request, a dialog step) the first conversion in a language reads that
* language's whole table once into a hashed table, and every conversion of
* the scope, both directions, is answered from it; the scope's end drops
* it. Outside a scope every conversion reads its one row, as before. Why
* the request and not the work process: the table is customizing and
* changes rarely, but a work process serves requests for hours, and a
* changed unit must be seen by the next request without an invalidation
* signal this runtime does not have. One read of a language's units per
* request (a few hundred rows) against one read per converted value (a
* whole product list converts thousands; milestone 3, pass 3).
*
* A missing table is not a unit that is not found: it raises
* ZCX_OSD_CONV_TABLE, so the gateway answers an error instead of the
* internal key (tools/hana-closure-convexit.mjs asks for the table).
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_unit,
             external   TYPE string,
             short_text TYPE string,
             long_text  TYPE string,
           END OF ty_unit.

* the system's unit text table: the closure reads this constant to ask
* for the table (tools/hana-closure-convexit.mjs)
    CONSTANTS c_text_table TYPE string VALUE 'T006A'.

* the table the units are read from; T006A when not given. Drops the cache
    CLASS-METHODS text_table
      IMPORTING
        iv_table TYPE csequence DEFAULT c_text_table.

* a scope in which a language's units are read once; nested scopes share
* the outermost one's cache
    CLASS-METHODS scope_begin.
    CLASS-METHODS scope_end.

* the statements this class has run on the unit text table (for tests)
    CLASS-METHODS reads
      RETURNING
        VALUE(rv_reads) TYPE i.

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
    TYPES: BEGIN OF ty_row,
             spras TYPE c LENGTH 1,
             msehi TYPE c LENGTH 3,
             mseh3 TYPE c LENGTH 3,
             mseht TYPE c LENGTH 10,
             msehl TYPE c LENGTH 30,
           END OF ty_row.
    TYPES ty_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.
    TYPES ty_cache TYPE HASHED TABLE OF ty_row WITH UNIQUE KEY spras msehi.
    TYPES ty_langus TYPE HASHED TABLE OF sy-langu WITH UNIQUE KEY table_line.

    CLASS-DATA gv_table  TYPE string VALUE c_text_table.
    CLASS-DATA gv_scope  TYPE i.
    CLASS-DATA gt_cache  TYPE ty_cache.
* the cache's rows of one language in MSEHI order, for the input direction
    CLASS-DATA gt_sorted TYPE ty_rows.
    CLASS-DATA gt_loaded TYPE ty_langus.
    CLASS-DATA gv_reads  TYPE i.

    CLASS-METHODS langu
      IMPORTING
        iv_langu        TYPE sy-langu
      RETURNING
        VALUE(rv_langu) TYPE sy-langu.

* the language's whole table into the cache, once per scope
    CLASS-METHODS load
      IMPORTING
        iv_langu TYPE sy-langu.

    CLASS-METHODS missing_table
      IMPORTING
        ix_error TYPE REF TO cx_root.

    CLASS-METHODS clear.
ENDCLASS.

CLASS zcl_osd_cunit IMPLEMENTATION.

  METHOD text_table.
    gv_table = to_upper( iv_table ).
    clear( ).
  ENDMETHOD.

  METHOD clear.
    CLEAR: gt_cache, gt_sorted, gt_loaded.
  ENDMETHOD.

  METHOD scope_begin.
    IF gv_scope = 0.
      clear( ).
    ENDIF.
    gv_scope = gv_scope + 1.
  ENDMETHOD.

  METHOD scope_end.
    IF gv_scope > 0.
      gv_scope = gv_scope - 1.
    ENDIF.
    IF gv_scope = 0.
      clear( ).
    ENDIF.
  ENDMETHOD.

  METHOD reads.
    rv_reads = gv_reads.
  ENDMETHOD.

  METHOD langu.
    rv_langu = iv_langu.
    IF rv_langu IS INITIAL.
      rv_langu = sy-langu.
    ENDIF.
  ENDMETHOD.

  METHOD missing_table.
    DATA lx_missing TYPE REF TO zcx_osd_conv_table.

    CREATE OBJECT lx_missing
      EXPORTING
        previous = ix_error
        exit     = 'CUNIT'
        table    = gv_table.
    RAISE EXCEPTION lx_missing.
  ENDMETHOD.

  METHOD load.
    DATA lt_rows  TYPE ty_rows.
    DATA ls_row   TYPE ty_row.
    DATA lx_error TYPE REF TO cx_root.

    READ TABLE gt_loaded TRANSPORTING NO FIELDS WITH TABLE KEY table_line = iv_langu.
    IF sy-subrc = 0.
      RETURN.
    ENDIF.
    gv_reads = gv_reads + 1.
    TRY.
        SELECT spras msehi mseh3 mseht msehl FROM (gv_table)
          INTO CORRESPONDING FIELDS OF TABLE lt_rows
          WHERE spras = iv_langu
          ORDER BY msehi.
      CATCH cx_root INTO lx_error.
        missing_table( lx_error ).
    ENDTRY.
    LOOP AT lt_rows INTO ls_row.
      INSERT ls_row INTO TABLE gt_cache.
      APPEND ls_row TO gt_sorted.
    ENDLOOP.
    INSERT iv_langu INTO TABLE gt_loaded.
  ENDMETHOD.

  METHOD external.
    DATA lv_langu TYPE sy-langu.
    DATA lv_msehi TYPE c LENGTH 3.
    DATA lv_mseh3 TYPE c LENGTH 3.
    DATA lv_mseht TYPE c LENGTH 10.
    DATA lv_msehl TYPE c LENGTH 30.
    DATA ls_row   TYPE ty_row.
    DATA lx_error TYPE REF TO cx_root.

    CLEAR: es_unit, ev_found.
    lv_langu = langu( iv_langu ).
    lv_msehi = iv_internal.
    IF gv_scope > 0.
      load( lv_langu ).
      READ TABLE gt_cache INTO ls_row WITH TABLE KEY spras = lv_langu msehi = lv_msehi.
      IF sy-subrc = 0.
        ev_found = abap_true.
        es_unit-external   = ls_row-mseh3.
        es_unit-short_text = ls_row-mseht.
        es_unit-long_text  = ls_row-msehl.
      ENDIF.
      RETURN.
    ENDIF.
    gv_reads = gv_reads + 1.
    TRY.
        SELECT SINGLE mseh3 mseht msehl FROM (gv_table)
          INTO (lv_mseh3, lv_mseht, lv_msehl)
          WHERE spras = lv_langu AND msehi = lv_msehi.
      CATCH cx_root INTO lx_error.
        missing_table( lx_error ).
    ENDTRY.
    IF sy-subrc = 0.
      ev_found = abap_true.
      es_unit-external   = lv_mseh3.
      es_unit-short_text = lv_mseht.
      es_unit-long_text  = lv_msehl.
    ENDIF.
  ENDMETHOD.

  METHOD internal.
    TYPES ty_msehi TYPE c LENGTH 3.
    DATA lt_msehi TYPE STANDARD TABLE OF ty_msehi WITH DEFAULT KEY.
    DATA lv_langu TYPE sy-langu.
    DATA lv_msehi TYPE c LENGTH 3.
    DATA lv_mseh3 TYPE c LENGTH 3.
    DATA ls_row   TYPE ty_row.
    DATA lx_error TYPE REF TO cx_root.

    CLEAR: ev_internal, ev_found.
    lv_langu = langu( iv_langu ).
    lv_mseh3 = iv_external.
* by the form a person reads; two units with one form in one language
* would be ambiguous, the first by key wins (not measured)
    IF gv_scope > 0.
      load( lv_langu ).
      READ TABLE gt_sorted INTO ls_row WITH KEY spras = lv_langu mseh3 = lv_mseh3.
      IF sy-subrc = 0.
        ev_found = abap_true.
        ev_internal = ls_row-msehi.
      ENDIF.
      RETURN.
    ENDIF.
    gv_reads = gv_reads + 1.
    TRY.
        SELECT msehi FROM (gv_table) INTO TABLE lt_msehi
          WHERE spras = lv_langu AND mseh3 = lv_mseh3
          ORDER BY msehi.
      CATCH cx_root INTO lx_error.
        missing_table( lx_error ).
    ENDTRY.
    READ TABLE lt_msehi INTO lv_msehi INDEX 1.
    IF sy-subrc = 0.
      ev_found = abap_true.
      ev_internal = lv_msehi.
    ENDIF.
  ENDMETHOD.

ENDCLASS.
