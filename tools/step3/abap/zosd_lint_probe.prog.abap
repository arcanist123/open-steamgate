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
DATA gv_bytes TYPE xstring.
DATA gv_msg TYPE string.
DATA gv_list TYPE string.
DATA gv_path TYPE string.
DATA gv_round TYPE i.
DATA gt_paths TYPE STANDARD TABLE OF string WITH DEFAULT KEY.
DATA gs_file TYPE zcl_osd_lint_engine=>ty_file.

START-OF-SELECTION.
  IF p_files IS INITIAL OR p_config IS INITIAL OR p_target IS INITIAL.
    RAISE EXCEPTION TYPE zcx_osd_lint_engine EXPORTING iv_reason =
      `usage: --files LIST --deps LIST --config JSON --target FILENAME -allow-read DIR`.
  ENDIF.
  CLEAR gv_bytes.
  OPEN DATASET p_config FOR INPUT IN BINARY MODE MESSAGE gv_msg.
  IF sy-subrc <> 0.
    RAISE EXCEPTION TYPE zcx_osd_lint_engine EXPORTING iv_reason = |cannot read { p_config }: { gv_msg }|.
  ENDIF.
  READ DATASET p_config INTO gv_bytes.
  CLOSE DATASET p_config.
  gv_config = cl_abap_codepage=>convert_from( gv_bytes ).
  DO 2 TIMES.
    gv_round = sy-index.
    IF gv_round = 1.
      gv_list = p_files.
    ELSE.
      gv_list = p_deps.
    ENDIF.
    IF gv_list IS INITIAL.
      CONTINUE.
    ENDIF.
    CLEAR gv_bytes.
    OPEN DATASET gv_list FOR INPUT IN BINARY MODE MESSAGE gv_msg.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE zcx_osd_lint_engine EXPORTING iv_reason = |cannot read { gv_list }: { gv_msg }|.
    ENDIF.
    READ DATASET gv_list INTO gv_bytes.
    CLOSE DATASET gv_list.
    gv_list = cl_abap_codepage=>convert_from( gv_bytes ).
    REPLACE ALL OCCURRENCES OF cl_abap_char_utilities=>cr_lf(1) IN gv_list WITH ``.
    CLEAR gt_paths.
    SPLIT gv_list AT cl_abap_char_utilities=>newline INTO TABLE gt_paths.
    LOOP AT gt_paths INTO gv_path.
      IF gv_path IS INITIAL.
        CONTINUE.
      ENDIF.
      CLEAR gs_file.
      CLEAR gv_bytes.
      OPEN DATASET gv_path FOR INPUT IN BINARY MODE MESSAGE gv_msg.
      IF sy-subrc <> 0.
        RAISE EXCEPTION TYPE zcx_osd_lint_engine EXPORTING iv_reason = |cannot read { gv_path }: { gv_msg }|.
      ENDIF.
      READ DATASET gv_path INTO gv_bytes.
      CLOSE DATASET gv_path.
      gs_file-raw = cl_abap_codepage=>convert_from( gv_bytes ).
      gs_file-filename = gv_path.
      REPLACE ALL OCCURRENCES OF `\` IN gs_file-filename WITH `/`.
      IF gv_round = 1.
        APPEND gs_file TO gt_files.
      ELSE.
        APPEND gs_file TO gt_deps.
      ENDIF.
    ENDLOOP.
  ENDDO.
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
