CLASS ltcl_select_loop DEFINITION FOR TESTING DURATION SHORT RISK LEVEL HARMLESS FINAL.
* The oracle of every case is the same join read with SELECT ... INTO TABLE,
* a different statement, over the seeded demo travels and their status
* texts. Each case first checks that the oracle has rows to compare.
  PRIVATE SECTION.
    TYPES:
      BEGIN OF ty_row,
        travel_id   TYPE zstg_demo-travel_id,
        description TYPE zstg_demo-description,
        status_text TYPE zstg_status-status_text,
      END OF ty_row,
      ty_rows TYPE STANDARD TABLE OF ty_row WITH DEFAULT KEY.

    METHODS every_target_per_row FOR TESTING RAISING cx_static_check.
    METHODS dbcnt_per_row FOR TESTING RAISING cx_static_check.
    METHODS paging_by_dbcnt FOR TESTING RAISING cx_static_check.
    METHODS where_on_both_order_by FOR TESTING RAISING cx_static_check.
    METHODS same_named_columns FOR TESTING RAISING cx_static_check.

    METHODS oracle
      RETURNING VALUE(rt_rows) TYPE ty_rows.
ENDCLASS.

CLASS ltcl_select_loop IMPLEMENTATION.

  METHOD oracle.
    SELECT t~travel_id t~description s~status_text
      INTO TABLE rt_rows
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      ORDER BY t~travel_id.
  ENDMETHOD.

  METHOD every_target_per_row.
    DATA lt_exp TYPE ty_rows.
    DATA lt_act TYPE ty_rows.
    DATA ls_row TYPE ty_row.
    DATA lv_id TYPE zstg_demo-travel_id.
    DATA lv_description TYPE zstg_demo-description.
    DATA lv_text TYPE zstg_status-status_text.

    lt_exp = oracle( ).
    cl_abap_unit_assert=>assert_differs( act = lines( lt_exp ) exp = 0 ).

    SELECT t~travel_id t~description s~status_text
      INTO (lv_id, lv_description, lv_text)
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      ORDER BY t~travel_id.
      ls_row-travel_id = lv_id.
      ls_row-description = lv_description.
      ls_row-status_text = lv_text.
      APPEND ls_row TO lt_act.
    ENDSELECT.

    cl_abap_unit_assert=>assert_equals( act = lt_act exp = lt_exp ).
    LOOP AT lt_act INTO ls_row.
      cl_abap_unit_assert=>assert_not_initial( ls_row-description ).
      cl_abap_unit_assert=>assert_not_initial( ls_row-status_text ).
    ENDLOOP.
  ENDMETHOD.

  METHOD dbcnt_per_row.
    DATA lt_exp TYPE ty_rows.
    DATA lv_id TYPE zstg_demo-travel_id.
    DATA lv_text TYPE zstg_status-status_text.
    DATA lv_rows TYPE i.

    lt_exp = oracle( ).
    cl_abap_unit_assert=>assert_differs( act = lines( lt_exp ) exp = 0 ).

    SELECT t~travel_id s~status_text
      INTO (lv_id, lv_text)
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      ORDER BY t~travel_id.
      lv_rows = lv_rows + 1.
      cl_abap_unit_assert=>assert_equals( act = sy-dbcnt exp = lv_rows ).
    ENDSELECT.

    cl_abap_unit_assert=>assert_equals( act = sy-subrc exp = 0 ).
    cl_abap_unit_assert=>assert_equals( act = sy-dbcnt exp = lines( lt_exp ) ).
    cl_abap_unit_assert=>assert_equals( act = lv_rows exp = lines( lt_exp ) ).
  ENDMETHOD.

  METHOD paging_by_dbcnt.
* The Gateway read: UP TO skip + top ROWS, a dynamic WHERE and ORDER BY,
* and only the rows past skip are kept.
    DATA lt_all TYPE ty_rows.
    DATA lt_exp TYPE ty_rows.
    DATA lt_act TYPE ty_rows.
    DATA ls_row TYPE ty_row.
    DATA lv_where TYPE string.
    DATA lv_order TYPE string.
    DATA lv_skip TYPE i.
    DATA lv_top TYPE i.
    DATA lv_max TYPE i.

    lt_all = oracle( ).
    cl_abap_unit_assert=>assert_number_between( lower = 3 upper = 1000 number = lines( lt_all ) ).
    APPEND LINES OF lt_all FROM 2 TO 3 TO lt_exp.

    lv_where = `t~travel_id <> ' ' AND s~status <> ' '`.
    lv_order = `t~travel_id`.
    lv_skip = 1.
    lv_top = 2.
    lv_max = lv_skip + lv_top.

    SELECT t~travel_id t~description s~status_text
      INTO (ls_row-travel_id, ls_row-description, ls_row-status_text)
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      UP TO lv_max ROWS
      WHERE (lv_where)
      ORDER BY (lv_order).
      IF sy-dbcnt > lv_skip.
        APPEND ls_row TO lt_act.
      ENDIF.
    ENDSELECT.

    cl_abap_unit_assert=>assert_equals( act = lt_act exp = lt_exp ).
    cl_abap_unit_assert=>assert_equals( act = sy-dbcnt exp = lv_max ).
  ENDMETHOD.

  METHOD where_on_both_order_by.
    DATA lt_all TYPE ty_rows.
    DATA lt_exp TYPE ty_rows.
    DATA lt_act TYPE ty_rows.
    DATA ls_row TYPE ty_row.
    DATA lv_id TYPE zstg_demo-travel_id.
    DATA lv_description TYPE zstg_demo-description.
    DATA lv_text TYPE zstg_status-status_text.
    DATA lv_rows TYPE i.

    lt_all = oracle( ).
    SELECT t~travel_id t~description s~status_text
      INTO TABLE lt_exp
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      WHERE t~seats > 0 AND s~status <> 'X'
      ORDER BY t~travel_id DESCENDING.
* the condition filters: some rows go, some stay
    cl_abap_unit_assert=>assert_differs( act = lines( lt_exp ) exp = 0 ).
    cl_abap_unit_assert=>assert_differs( act = lines( lt_exp ) exp = lines( lt_all ) ).

    SELECT t~travel_id t~description s~status_text
      INTO (lv_id, lv_description, lv_text)
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      WHERE t~seats > 0 AND s~status <> 'X'
      ORDER BY t~travel_id DESCENDING.
      lv_rows = lv_rows + 1.
      cl_abap_unit_assert=>assert_equals( act = sy-dbcnt exp = lv_rows ).
      ls_row-travel_id = lv_id.
      ls_row-description = lv_description.
      ls_row-status_text = lv_text.
      APPEND ls_row TO lt_act.
    ENDSELECT.

    cl_abap_unit_assert=>assert_equals( act = lt_act exp = lt_exp ).
    cl_abap_unit_assert=>assert_equals( act = sy-dbcnt exp = lines( lt_exp ) ).
  ENDMETHOD.

  METHOD same_named_columns.
* t~status and s~status share a name; each goes to its own target, and the
* columns after them are not shifted. The oracle is the join without the
* second status (an INTO TABLE fills by name, so it cannot hold both).
    DATA lt_exp TYPE ty_rows.
    DATA ls_exp TYPE ty_row.
    DATA lv_id TYPE zstg_demo-travel_id.
    DATA lv_t_status TYPE zstg_demo-status.
    DATA lv_s_status TYPE zstg_status-status.
    DATA lv_text TYPE zstg_status-status_text.
    DATA lv_rows TYPE i.

    lt_exp = oracle( ).
    cl_abap_unit_assert=>assert_differs( act = lines( lt_exp ) exp = 0 ).

    SELECT t~travel_id t~status s~status s~status_text
      INTO (lv_id, lv_t_status, lv_s_status, lv_text)
      FROM ( zstg_demo AS t INNER JOIN zstg_status AS s ON t~status = s~status )
      ORDER BY t~travel_id.
      lv_rows = lv_rows + 1.
      READ TABLE lt_exp INTO ls_exp INDEX lv_rows.
      cl_abap_unit_assert=>assert_subrc( exp = 0 ).
      cl_abap_unit_assert=>assert_equals( act = lv_id exp = ls_exp-travel_id ).
      cl_abap_unit_assert=>assert_not_initial( lv_t_status ).
      cl_abap_unit_assert=>assert_equals( act = lv_s_status exp = lv_t_status ).
      cl_abap_unit_assert=>assert_equals( act = lv_text exp = ls_exp-status_text ).
    ENDSELECT.

    cl_abap_unit_assert=>assert_equals( act = lv_rows exp = lines( lt_exp ) ).
  ENDMETHOD.

ENDCLASS.
