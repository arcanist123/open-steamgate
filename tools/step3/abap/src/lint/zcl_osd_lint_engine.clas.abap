CLASS zcl_osd_lint_engine DEFINITION PUBLIC FINAL CREATE PRIVATE.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_file,
             filename TYPE string,
             raw TYPE string,
           END OF ty_file,
           tt_file TYPE STANDARD TABLE OF ty_file WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_issue,
             key TYPE string,
             severity TYPE string,
             filename TYPE string,
             start_row TYPE i,
             start_col TYPE i,
             end_row TYPE i,
             end_col TYPE i,
             message TYPE string,
           END OF ty_issue,
           tt_issue TYPE STANDARD TABLE OF ty_issue WITH DEFAULT KEY.
    CLASS-METHODS prime
      IMPORTING it_files TYPE tt_file it_deps TYPE tt_file iv_config TYPE string.
    CLASS-METHODS check
      IMPORTING iv_filename TYPE string RETURNING VALUE(rt_issues) TYPE tt_issue.
    CLASS-METHODS update IMPORTING iv_filename TYPE string iv_raw TYPE string.
  PRIVATE SECTION.
    CLASS-DATA go_registry TYPE REF TO zcl_lnt_registry.
    CLASS-METHODS column
      IMPORTING io_position TYPE REF TO zcl_lnt_position
      RETURNING VALUE(rv_column) TYPE i.
ENDCLASS.

CLASS zcl_osd_lint_engine IMPLEMENTATION.
  METHOD prime.
    DATA lo_run TYPE REF TO zcl_lnt_registry_run.
    DATA ls_file TYPE ty_file.
*   A failed re-prime must not leave an old corpus available for checking.
    CLEAR go_registry.
    CREATE OBJECT lo_run.
    LOOP AT it_files INTO ls_file.
      lo_run->add_file( i_filename = ls_file-filename i_raw = ls_file-raw ).
    ENDLOOP.
    LOOP AT it_deps INTO ls_file.
      lo_run->add_dependency( i_filename = ls_file-filename i_raw = ls_file-raw ).
    ENDLOOP.
    go_registry = lo_run->parse( i_config = iv_config ).
  ENDMETHOD.

  METHOD check.
    DATA lo_file TYPE REF TO zif_lnt_file.
    DATA lo_object TYPE REF TO zif_lnt_object.
    DATA lo_issues TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
    DATA lo_item TYPE REF TO object.
    DATA lo_issue TYPE REF TO zcl_lnt_issue.
    DATA lo_start TYPE REF TO zcl_lnt_position.
    DATA lo_end TYPE REF TO zcl_lnt_position.
    DATA ls_issue TYPE ty_issue.
    IF go_registry IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = `prime must succeed before check`.
    ENDIF.
    lo_file = go_registry->get_file_by_name( i_filename = iv_filename ).
    IF lo_file IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = |file is not in the registry: { iv_filename }|.
    ENDIF.
    lo_object = go_registry->find_object_for_file( i_file = lo_file ).
    IF lo_object IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = |object is not in the registry: { iv_filename }|.
    ENDIF.
    lo_issues = go_registry->find_issues_object( i_iobj = lo_object ).
*   The generated JS-array view must be materialized before reading items.
    lo_issues->dense( ).
    LOOP AT lo_issues->items INTO lo_item.
      lo_issue ?= lo_item.
      lo_start = lo_issue->get_start( ).
      lo_end = lo_issue->get_end( ).
      ls_issue-key = lo_issue->get_key( ).
      ls_issue-severity = lo_issue->get_severity( ).
      ls_issue-filename = lo_issue->get_filename( ).
      ls_issue-start_row = lo_start->get_row( ).
      ls_issue-start_col = column( lo_start ).
      ls_issue-end_row = lo_end->get_row( ).
      ls_issue-end_col = column( lo_end ).
      ls_issue-message = lo_issue->get_message( ).
      APPEND ls_issue TO rt_issues.
    ENDLOOP.
  ENDMETHOD.

  METHOD column.
    DATA lo_column TYPE REF TO zlnt_runtime_opti_8df4f98f9a3a.
    lo_column = io_position->get_col( ).
    IF lo_column IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = `issue column is undefined`.
    ENDIF.
    IF lo_column->has <> abap_true OR lo_column->number_special <> 0.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = `issue column is not a finite number`.
    ENDIF.
    rv_column = lo_column->value.
  ENDMETHOD.

  METHOD update.
*   update_file alone does not invalidate cached syntax in dependent objects.
*   The overlay slice must also dirty readers and implement restoration.
    RAISE EXCEPTION TYPE zcx_osd_lint_engine
      EXPORTING iv_reason = `update is not implemented; re-prime the corpus`.
  ENDMETHOD.
ENDCLASS.
