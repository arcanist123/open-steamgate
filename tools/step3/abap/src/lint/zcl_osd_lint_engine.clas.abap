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
    TYPES: BEGIN OF ty_stats,
             updates TYPE i,
             noops TYPE i,
             indexed_objects TYPE i,
             reader_visits TYPE i,
             dirtied_objects TYPE i,
             parse_runs TYPE i,
             parse_objects TYPE i,
           END OF ty_stats.
    CLASS-METHODS prime
      IMPORTING it_files TYPE tt_file it_deps TYPE tt_file iv_config TYPE string.
    CLASS-METHODS check
      IMPORTING iv_filename TYPE string RETURNING VALUE(rt_issues) TYPE tt_issue.
    CLASS-METHODS update
      IMPORTING iv_filename TYPE string iv_raw TYPE string iv_remove TYPE abap_bool DEFAULT abap_false.
    CLASS-METHODS stats RETURNING VALUE(rs_stats) TYPE ty_stats.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_reader,
             word TYPE string,
             object TYPE REF TO zif_lnt_object,
           END OF ty_reader,
           tt_reader TYPE STANDARD TABLE OF ty_reader WITH DEFAULT KEY.
    TYPES: BEGIN OF ty_bucket,
             readers TYPE tt_reader,
           END OF ty_bucket,
           tt_bucket TYPE STANDARD TABLE OF ty_bucket WITH DEFAULT KEY.
    CLASS-DATA go_registry TYPE REF TO zcl_lnt_registry.
    CLASS-DATA gt_buckets TYPE tt_bucket.
    CLASS-DATA gs_stats TYPE ty_stats.
    CLASS-METHODS bucket IMPORTING iv_word TYPE string RETURNING VALUE(rv_bucket) TYPE i.
    CLASS-METHODS index_object
      IMPORTING io_object TYPE REF TO zif_lnt_object iv_remove TYPE abap_bool DEFAULT abap_false.
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
    CLEAR: go_registry, gt_buckets, gs_stats.
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
    DATA lo_objects TYPE REF TO zif_lnt_generator_8f73cd1c.
    DATA lo_next TYPE REF TO zcl_lnt_generator_17955b8b.
    DATA lv_dirty TYPE i.
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
*   Count dirty parse candidates, not rule checks. find_issues_object parses
*   lazily, including any pending restoration, and runs rules for this object.
    lo_objects = go_registry->get_objects( ).
    DO.
      lo_next = lo_objects->next( ).
      IF lo_next->done = abap_true.
        EXIT.
      ENDIF.
      IF lo_next->value->is_dirty( ) = abap_true.
        lv_dirty = lv_dirty + 1.
      ENDIF.
    ENDDO.
    IF lv_dirty > 0.
      gs_stats-parse_runs = gs_stats-parse_runs + 1.
      gs_stats-parse_objects = gs_stats-parse_objects + lv_dirty.
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

  METHOD stats.
    rs_stats = gs_stats.
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
    DATA ls_bucket TYPE ty_bucket.
    CLEAR gt_buckets.
    DO 1024 TIMES.
      APPEND ls_bucket TO gt_buckets.
    ENDDO.
    lo_objects = go_registry->get_objects( ).
    DO.
      lo_next = lo_objects->next( ).
      IF lo_next->done = abap_true.
        EXIT.
      ENDIF.
      index_object( lo_next->value ).
    ENDDO.
  ENDMETHOD.

  METHOD bucket.
    DATA lv_offset TYPE i.
    DATA lv_code TYPE i.
    DATA lv_char TYPE string.
    DATA lv_alphabet TYPE string VALUE `/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_`.
*   OSGo currently scans even HASHED TABLE keys. Fixed buckets with INDEX
*   access keep both runtimes off the whole-corpus reader scan.
    DO strlen( iv_word ) TIMES.
      lv_offset = sy-index - 1.
      lv_char = iv_word+lv_offset(1).
      FIND FIRST OCCURRENCE OF lv_char IN lv_alphabet MATCH OFFSET lv_code.
      rv_bucket = ( rv_bucket * 31 + lv_code ) MOD 1024.
    ENDDO.
    rv_bucket = rv_bucket + 1.
  ENDMETHOD.

  METHOD index_object.
    DATA lo_files TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
    DATA lo_item TYPE REF TO object.
    DATA lo_file TYPE REF TO zif_lnt_file.
    DATA lv_raw TYPE string.
    DATA lt_matches TYPE match_result_tab.
    DATA ls_match TYPE match_result.
    DATA ls_reader TYPE ty_reader.
    DATA lt_words TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lv_word TYPE string.
    DATA lv_previous TYPE string.
    DATA lv_bucket TYPE i.
    DATA lv_index TYPE i.
    DATA ls_old TYPE ty_reader.
    FIELD-SYMBOLS <bucket> TYPE ty_bucket.
    gs_stats-indexed_objects = gs_stats-indexed_objects + 1.
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
        APPEND lv_word TO lt_words.
      ENDLOOP.
    ENDLOOP.
    SORT lt_words.
    ls_reader-object = io_object.
    LOOP AT lt_words INTO lv_word.
      IF lv_word = lv_previous.
        CONTINUE.
      ENDIF.
      lv_previous = lv_word.
      ls_reader-word = lv_word.
      lv_bucket = bucket( lv_word ).
      READ TABLE gt_buckets ASSIGNING <bucket> INDEX lv_bucket.
      IF iv_remove = abap_true.
        lv_index = lines( <bucket>-readers ).
        gs_stats-reader_visits = gs_stats-reader_visits + lv_index.
        WHILE lv_index > 0.
          READ TABLE <bucket>-readers INTO ls_old INDEX lv_index.
          IF ls_old-word = lv_word AND ls_old-object = io_object.
            DELETE <bucket>-readers INDEX lv_index.
          ENDIF.
          lv_index = lv_index - 1.
        ENDWHILE.
      ELSE.
        APPEND ls_reader TO <bucket>-readers.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD update.
    DATA lo_before TYPE REF TO zif_lnt_file.
    DATA lo_file TYPE REF TO zif_lnt_file.
    DATA lo_old TYPE REF TO zif_lnt_object.
    DATA lo_object TYPE REF TO zif_lnt_object.
    DATA lo_files TYPE REF TO zlnt_runtime_arra_c22708faf2e3.
    DATA lv_name TYPE string.
    DATA lv_word TYPE string.
    DATA lt_queue TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
    DATA lt_reached TYPE SORTED TABLE OF string WITH UNIQUE KEY table_line.
    DATA lt_dirty TYPE STANDARD TABLE OF REF TO zif_lnt_object WITH DEFAULT KEY.
    DATA lv_seen TYPE abap_bool.
    DATA lo_seen TYPE REF TO zif_lnt_object.
    DATA ls_reader TYPE ty_reader.
    DATA lv_index TYPE i.
    DATA lv_bucket TYPE i.
    FIELD-SYMBOLS <bucket> TYPE ty_bucket.
    IF go_registry IS NOT BOUND.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine
        EXPORTING iv_reason = `prime must succeed before update`.
    ENDIF.
    gs_stats-updates = gs_stats-updates + 1.
    lo_before = go_registry->get_file_by_name( i_filename = iv_filename ).
    IF iv_remove = abap_true AND lo_before IS NOT BOUND.
      gs_stats-noops = gs_stats-noops + 1.
      RETURN.
    ENDIF.
    IF lo_before IS BOUND.
*     The host bridge can supply a blank rather than an empty false flag.
      IF iv_remove <> abap_true AND lo_before->get_raw( ) = iv_raw.
        gs_stats-noops = gs_stats-noops + 1.
        RETURN.
      ENDIF.
      lo_old = go_registry->find_object_for_file( i_file = lo_before ).
    ENDIF.
*   Remove only this object's old edges while its old files still exist.
    IF lo_old IS BOUND.
      index_object( io_object = lo_old iv_remove = abap_true ).
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
    IF iv_remove = abap_true.
*     The removed filename cannot find an owner. Retain a surviving object's
*     other includes; remove_file only drops the object when its last file goes.
      lo_files = lo_old->get_files( ).
      lo_files->dense( ).
      IF lo_files->items IS NOT INITIAL.
        lo_object = lo_old.
      ENDIF.
    ELSE.
      lo_object = go_registry->find_object_for_file( i_file = lo_file ).
    ENDIF.
    IF lo_object IS BOUND.
      index_object( lo_object ).
*     update_file/add_file/remove_file already dirtied the target.
      APPEND lo_object TO lt_dirty.
    ENDIF.
    APPEND lv_name TO lt_queue.
    INSERT lv_name INTO TABLE lt_reached.
*   Visit appended names too: transitive lexical readers, as on Node.
    lv_index = 1.
    WHILE lv_index <= lines( lt_queue ).
      READ TABLE lt_queue INTO lv_word INDEX lv_index.
      lv_index = lv_index + 1.
      lv_bucket = bucket( lv_word ).
      READ TABLE gt_buckets ASSIGNING <bucket> INDEX lv_bucket.
      gs_stats-reader_visits = gs_stats-reader_visits + lines( <bucket>-readers ).
      LOOP AT <bucket>-readers INTO ls_reader WHERE word = lv_word.
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
    gs_stats-dirtied_objects = gs_stats-dirtied_objects + lines( lt_dirty ).
*   No eager parse here: batches and install/check/restore coalesce at CHECK.
  ENDMETHOD.
ENDCLASS.
