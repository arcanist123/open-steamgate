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
    CLASS-METHODS update
      IMPORTING iv_filename TYPE string iv_raw TYPE string iv_remove TYPE abap_bool DEFAULT abap_false.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_reader,
             word TYPE string,
             object TYPE REF TO zif_lnt_object,
           END OF ty_reader,
           tt_reader TYPE STANDARD TABLE OF ty_reader WITH DEFAULT KEY.
    CLASS-DATA go_registry TYPE REF TO zcl_lnt_registry.
    CLASS-DATA gt_readers TYPE tt_reader.
    CLASS-METHODS index_object IMPORTING io_object TYPE REF TO zif_lnt_object.
    CLASS-METHODS drop_readers IMPORTING io_object TYPE REF TO zif_lnt_object.
    CLASS-METHODS index_registry.
    CLASS-METHODS column
      IMPORTING io_position TYPE REF TO zcl_lnt_position
      RETURNING VALUE(rv_column) TYPE i.
ENDCLASS.

CLASS zcl_osd_lint_engine IMPLEMENTATION.
  METHOD prime.
    DATA lo_run TYPE REF TO zcl_lnt_registry_run.
    DATA ls_file TYPE ty_file.
*   A failed re-prime must not leave an old corpus available for checking.
    CLEAR: go_registry, gt_readers.
    CREATE OBJECT lo_run.
    LOOP AT it_files INTO ls_file.
      lo_run->add_file( i_filename = ls_file-filename i_raw = ls_file-raw ).
    ENDLOOP.
    LOOP AT it_deps INTO ls_file.
      lo_run->add_dependency( i_filename = ls_file-filename i_raw = ls_file-raw ).
    ENDLOOP.
    go_registry = lo_run->parse( i_config = iv_config ).
    index_registry( ).
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

  METHOD index_registry.
    DATA lo_objects TYPE REF TO zif_lnt_generator_8f73cd1c.
    DATA lo_next TYPE REF TO zcl_lnt_generator_17955b8b.
    CLEAR gt_readers.
    lo_objects = go_registry->get_objects( ).
    DO.
      lo_next = lo_objects->next( ).
      IF lo_next->done = abap_true.
        EXIT.
      ENDIF.
      index_object( lo_next->value ).
    ENDDO.
  ENDMETHOD.

  METHOD drop_readers.
    DATA lv_index TYPE i.
    DATA ls_reader TYPE ty_reader.
    lv_index = lines( gt_readers ).
    WHILE lv_index > 0.
      READ TABLE gt_readers INTO ls_reader INDEX lv_index.
      IF ls_reader-object = io_object.
        DELETE gt_readers INDEX lv_index.
      ENDIF.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

  METHOD index_object.
    DATA lo_files TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
    DATA lo_item TYPE REF TO object.
    DATA lo_file TYPE REF TO zif_lnt_file.
    DATA lv_raw TYPE string.
    DATA lt_matches TYPE match_result_tab.
    DATA ls_match TYPE match_result.
    DATA ls_reader TYPE ty_reader.
    DATA lt_words TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lv_word TYPE string.
    drop_readers( io_object ).
    lo_files = io_object->get_files( ).
    lo_files->dense( ).
    LOOP AT lo_files->items INTO lo_item.
      lo_file ?= lo_item.
      lv_raw = to_upper( lo_file->get_raw( ) ).
*     Same over-approximation as OBJECT_NAME_PATTERN: comments/strings count.
      FIND ALL OCCURRENCES OF REGEX `(/[A-Z0-9_]{1,10}/)?[A-Z0-9_]{1,40}`
        IN lv_raw RESULTS lt_matches.
      LOOP AT lt_matches INTO ls_match.
        lv_word = lv_raw+ls_match-offset(ls_match-length).
        INSERT lv_word INTO TABLE lt_words.
      ENDLOOP.
    ENDLOOP.
    ls_reader-object = io_object.
    LOOP AT lt_words INTO lv_word.
      ls_reader-word = lv_word.
      APPEND ls_reader TO gt_readers.
    ENDLOOP.
  ENDMETHOD.

  METHOD update.
    DATA lo_before TYPE REF TO zif_lnt_file.
    DATA lo_file TYPE REF TO zif_lnt_file.
    DATA lo_old TYPE REF TO zif_lnt_object.
    DATA lo_object TYPE REF TO zif_lnt_object.
    DATA lo_parsed TYPE REF TO zif_lnt_registry.
    DATA lv_name TYPE string.
    DATA lv_word TYPE string.
    DATA lt_queue TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lt_reached TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lt_dirty TYPE STANDARD TABLE OF REF TO zif_lnt_object WITH DEFAULT KEY.
    DATA lv_seen TYPE abap_bool.
    DATA lo_seen TYPE REF TO zif_lnt_object.
    DATA ls_reader TYPE ty_reader.
    DATA lv_index TYPE i.
    IF go_registry IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = `prime must succeed before update`.
    ENDIF.
    lo_before = go_registry->get_file_by_name( i_filename = iv_filename ).
    IF iv_remove = abap_true AND lo_before IS NOT BOUND.
      lo_parsed = go_registry->parse( ).
      RETURN.
    ENDIF.
    IF lo_before IS BOUND.
      IF iv_remove = abap_false AND lo_before->get_raw( ) = iv_raw.
        lo_parsed = go_registry->parse( ).
        RETURN.
      ENDIF.
      lo_old = go_registry->find_object_for_file( i_file = lo_before ).
    ENDIF.
    IF iv_remove = abap_true.
      lo_file = lo_before.
      go_registry->remove_file( i_file = lo_before ).
    ELSE.
      CREATE OBJECT lo_file TYPE zcl_lnt_memory_file
        EXPORTING i_filename = iv_filename i_raw = iv_raw.
      IF lo_before IS BOUND.
        go_registry->update_file( i_file = lo_file ).
      ELSE.
        go_registry->add_file( i_file = lo_file ).
      ENDIF.
    ENDIF.
    lv_name = to_upper( lo_file->get_object_name( ) ).
    lo_object = go_registry->find_object_for_file( i_file = lo_file ).
    IF lo_old IS BOUND AND lo_old <> lo_object.
      drop_readers( lo_old ).
    ENDIF.
    IF lo_object IS BOUND.
      index_object( lo_object ).
    ENDIF.
    APPEND lv_name TO lt_queue.
    INSERT lv_name INTO TABLE lt_reached.
*   Visit appended names too: transitive lexical readers, as on Node.
    lv_index = 1.
    WHILE lv_index <= lines( lt_queue ).
      READ TABLE lt_queue INTO lv_word INDEX lv_index.
      lv_index = lv_index + 1.
      LOOP AT gt_readers INTO ls_reader WHERE word = lv_word.
        lv_seen = abap_false.
        LOOP AT lt_dirty INTO lo_seen.
          IF lo_seen = ls_reader-object.
            lv_seen = abap_true.
            EXIT.
          ENDIF.
        ENDLOOP.
        IF lv_seen = abap_true.
          CONTINUE.
        ENDIF.
        APPEND ls_reader-object TO lt_dirty.
        ls_reader-object->set_dirty( ).
        lv_name = to_upper( ls_reader-object->get_name( ) ).
        INSERT lv_name INTO TABLE lt_reached.
        IF sy-subrc = 0.
          APPEND lv_name TO lt_queue.
        ENDIF.
      ENDLOOP.
    ENDWHILE.
    lo_parsed = go_registry->parse( ).
  ENDMETHOD.
ENDCLASS.
