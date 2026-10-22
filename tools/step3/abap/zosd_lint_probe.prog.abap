REPORT zosd_lint_probe LINE-SIZE 1023.
PARAMETERS p_files TYPE string LOWER CASE.
PARAMETERS p_deps TYPE string LOWER CASE.
PARAMETERS p_config TYPE string LOWER CASE.
PARAMETERS p_target TYPE string LOWER CASE.

DATA gt_files TYPE zcl_osd_lint_engine=>tt_file.
DATA gt_deps TYPE zcl_osd_lint_engine=>tt_file.
DATA gt_issues TYPE zcl_osd_lint_engine=>tt_issue.
DATA gt_first TYPE zcl_osd_lint_engine=>tt_issue.
DATA gs_issue TYPE zcl_osd_lint_engine=>ty_issue.
DATA gv_config TYPE string.
DATA gv_before TYPE f.
DATA gv_after TYPE f.
DATA gv_prime TYPE i.
DATA gv_check1 TYPE i.
DATA gv_check2 TYPE i.
DATA gv_check TYPE i.

START-OF-SELECTION.
  IF p_files IS INITIAL OR p_config IS INITIAL OR p_target IS INITIAL.
    RAISE EXCEPTION TYPE zcx_osd_lint_engine EXPORTING iv_reason =
      `usage: --files LIST --deps LIST --config JSON --target FILENAME -allow-read DIR`.
  ENDIF.
  PERFORM read_raw USING p_config CHANGING gv_config.
  PERFORM read_files USING p_files CHANGING gt_files.
  IF p_deps IS NOT INITIAL.
    PERFORM read_files USING p_deps CHANGING gt_deps.
  ENDIF.
  REPLACE ALL OCCURRENCES OF `\` IN p_target WITH `/`.
  gv_before = zlnt_runtime_tele_970d5104e5f4=>now( ).
  zcl_osd_lint_engine=>prime( it_files = gt_files it_deps = gt_deps iv_config = gv_config ).
  gv_after = zlnt_runtime_tele_970d5104e5f4=>now( ).
  gv_prime = gv_after - gv_before.
  DO 2 TIMES.
    gv_check = sy-index.
    gv_before = zlnt_runtime_tele_970d5104e5f4=>now( ).
    gt_issues = zcl_osd_lint_engine=>check( p_target ).
    gv_after = zlnt_runtime_tele_970d5104e5f4=>now( ).
    IF gv_check = 1.
      gv_check1 = gv_after - gv_before.
      gt_first = gt_issues.
    ELSE.
      gv_check2 = gv_after - gv_before.
      IF gt_issues <> gt_first.
        RAISE EXCEPTION TYPE zcx_osd_lint_engine
          EXPORTING iv_reason = `repeated object check changed its ordered issues`.
      ENDIF.
    ENDIF.
    WRITE: / |# check{ gv_check } issues={ lines( gt_issues ) }|.
    LOOP AT gt_issues INTO gs_issue.
      WRITE: / |{ gs_issue-key }\|{ gs_issue-severity }\|{ gs_issue-filename }\|{ gs_issue-start_row }:{ gs_issue-start_col }\|{ gs_issue-end_row }:{ gs_issue-end_col }\|{ gs_issue-message }|.
    ENDLOOP.
  ENDDO.
  WRITE: / |# ms prime={ gv_prime } check1={ gv_check1 } check2={ gv_check2 }|.

FORM read_raw USING iv_path TYPE string CHANGING cv_raw TYPE string.
  DATA lv_bytes TYPE xstring.
  DATA lv_message TYPE string.
  OPEN DATASET iv_path FOR INPUT IN BINARY MODE MESSAGE lv_message.
  IF sy-subrc <> 0.
    RAISE EXCEPTION TYPE zcx_osd_lint_engine
      EXPORTING iv_reason = |cannot read { iv_path }: { lv_message }|.
  ENDIF.
  READ DATASET iv_path INTO lv_bytes.
  CLOSE DATASET iv_path.
  cv_raw = cl_abap_codepage=>convert_from( lv_bytes ).
ENDFORM.

FORM read_files USING iv_list TYPE string CHANGING ct_files TYPE zcl_osd_lint_engine=>tt_file.
  DATA lv_list TYPE string.
  DATA lt_paths TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
  DATA lv_path TYPE string.
  DATA ls_file TYPE zcl_osd_lint_engine=>ty_file.
  PERFORM read_raw USING iv_list CHANGING lv_list.
  REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf(1) IN lv_list WITH ``.
  SPLIT lv_list AT cl_abap_char_utilities=>newline INTO TABLE lt_paths.
  LOOP AT lt_paths INTO lv_path.
    IF lv_path IS INITIAL.
      CONTINUE.
    ENDIF.
    PERFORM read_raw USING lv_path CHANGING ls_file-raw.
    ls_file-filename = lv_path.
    REPLACE ALL OCCURRENCES OF `\` IN ls_file-filename WITH `/`.
    APPEND ls_file TO ct_files.
  ENDLOOP.
ENDFORM.
