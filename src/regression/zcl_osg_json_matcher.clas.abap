CLASS zcl_osg_json_matcher DEFINITION PUBLIC FINAL CREATE PRIVATE.
  PUBLIC SECTION.
    CLASS-METHODS match
      IMPORTING
        iv_expected      TYPE string
        iv_actual        TYPE string
        it_masks         TYPE zif_osg_regression=>tt_path_rules OPTIONAL
      RETURNING
        VALUE(rs_result) TYPE zif_osg_regression=>ty_verdict.

  PRIVATE SECTION.
    CLASS-METHODS parse_to_nodes
      IMPORTING
        iv_json       TYPE string
      EXPORTING
        et_nodes      TYPE zif_osg_regression=>tt_json_nodes
        ev_ok         TYPE abap_bool.

    CLASS-METHODS append_children
      IMPORTING
        ii_json       TYPE REF TO zif_ajson
        is_parent     TYPE zif_ajson_types=>ty_node
        iv_pointer    TYPE string
      CHANGING
        ct_nodes      TYPE zif_osg_regression=>tt_json_nodes
        cv_ok         TYPE abap_bool.

    CLASS-METHODS child_tree_path
      IMPORTING
        is_parent     TYPE zif_ajson_types=>ty_node
      RETURNING
        VALUE(rv_path) TYPE string.

    CLASS-METHODS pointer_escape
      IMPORTING
        iv_segment       TYPE string
      RETURNING
        VALUE(rv_segment) TYPE string.

    CLASS-METHODS pointer_valid
      IMPORTING
        iv_pointer      TYPE string
      RETURNING
        VALUE(rv_valid) TYPE abap_bool.

    CLASS-METHODS path_is_below
      IMPORTING
        iv_path         TYPE string
        iv_parent       TYPE string
      RETURNING
        VALUE(rv_below) TYPE abap_bool.

    CLASS-METHODS path_is_masked
      IMPORTING
        iv_path         TYPE string
        it_masks        TYPE zif_osg_regression=>tt_path_rules
      RETURNING
        VALUE(rv_masked) TYPE abap_bool.

    CLASS-METHODS validate_masks
      IMPORTING
        it_masks        TYPE zif_osg_regression=>tt_path_rules
        it_expected     TYPE zif_osg_regression=>tt_json_nodes
        it_actual       TYPE zif_osg_regression=>tt_json_nodes
      RETURNING
        VALUE(rt_findings) TYPE zif_osg_regression=>tt_findings.

    CLASS-METHODS add_finding
      IMPORTING
        iv_kind         TYPE string
        iv_path         TYPE string
        iv_expected     TYPE string OPTIONAL
        iv_actual       TYPE string OPTIONAL
        iv_message      TYPE string OPTIONAL
      CHANGING
        ct_findings     TYPE zif_osg_regression=>tt_findings.
ENDCLASS.

CLASS zcl_osg_json_matcher IMPLEMENTATION.
  METHOD pointer_escape.
    rv_segment = iv_segment.
    REPLACE ALL OCCURRENCES OF '~' IN rv_segment WITH '~0'.
    REPLACE ALL OCCURRENCES OF '/' IN rv_segment WITH '~1'.
  ENDMETHOD.

  METHOD child_tree_path.
    DATA lv_name TYPE string.
    lv_name = is_parent-name.
    REPLACE ALL OCCURRENCES OF '/' IN lv_name
      WITH cl_abap_char_utilities=>horizontal_tab.
    rv_path = is_parent-path && lv_name && '/'.
  ENDMETHOD.

  METHOD append_children.
    DATA lv_tree_path TYPE string.
    DATA lv_segment   TYPE string.
    DATA lv_pointer   TYPE string.
    DATA lv_index     TYPE i.
    DATA ls_node      TYPE zif_osg_regression=>ty_json_node.
    DATA ls_child     TYPE zif_ajson_types=>ty_node.

    lv_tree_path = child_tree_path( is_parent ).
    LOOP AT ii_json->mt_json_tree INTO ls_child WHERE path = lv_tree_path.
      IF ls_child-name CS cl_abap_char_utilities=>horizontal_tab.
        cv_ok = abap_false.
        RETURN.
      ENDIF.

      IF is_parent-type = zif_ajson_types=>node_type-array.
        lv_index = ls_child-index - 1.
        lv_segment = |{ lv_index }|.
      ELSE.
        lv_segment = pointer_escape( ls_child-name ).
      ENDIF.

      IF iv_pointer IS INITIAL.
        lv_pointer = '/' && lv_segment.
      ELSE.
        lv_pointer = iv_pointer && '/' && lv_segment.
      ENDIF.

      CLEAR ls_node.
      ls_node-path = lv_pointer.
      ls_node-kind = ls_child-type.
      ls_node-value = ls_child-value.
      INSERT ls_node INTO TABLE ct_nodes.
      IF sy-subrc <> 0.
        cv_ok = abap_false.
        RETURN.
      ENDIF.

      IF ls_child-type = zif_ajson_types=>node_type-object
         OR ls_child-type = zif_ajson_types=>node_type-array.
        append_children(
          EXPORTING
            ii_json    = ii_json
            is_parent  = ls_child
            iv_pointer = lv_pointer
          CHANGING
            ct_nodes   = ct_nodes
            cv_ok      = cv_ok ).
        IF cv_ok = abap_false.
          RETURN.
        ENDIF.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD parse_to_nodes.
    DATA lo_json TYPE REF TO zcl_ajson.
    DATA ls_root TYPE zif_ajson_types=>ty_node.
    DATA ls_node TYPE zif_osg_regression=>ty_json_node.

    CLEAR et_nodes.
    ev_ok = abap_false.
    TRY.
        lo_json = zcl_ajson=>parse(
          iv_json   = iv_json
          iv_freeze = abap_true ).
        READ TABLE lo_json->mt_json_tree INTO ls_root
          WITH TABLE KEY path = '' name = ''.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.

        ls_node-path = ''.
        ls_node-kind = ls_root-type.
        ls_node-value = ls_root-value.
        INSERT ls_node INTO TABLE et_nodes.
        IF sy-subrc <> 0.
          RETURN.
        ENDIF.

        ev_ok = abap_true.
        IF ls_root-type = zif_ajson_types=>node_type-object
           OR ls_root-type = zif_ajson_types=>node_type-array.
          append_children(
            EXPORTING
              ii_json    = lo_json
              is_parent  = ls_root
              iv_pointer = ''
            CHANGING
              ct_nodes   = et_nodes
              cv_ok      = ev_ok ).
        ENDIF.
* a member named twice is CX_SY_ITAB_DUPLICATE_KEY in ajson's tree
      CATCH zcx_ajson_error cx_sy_itab_duplicate_key.
        CLEAR et_nodes.
        ev_ok = abap_false.
    ENDTRY.
  ENDMETHOD.

  METHOD pointer_valid.
    DATA lv_off TYPE i.
    DATA lv_len TYPE i.
    DATA lv_char TYPE c LENGTH 1.
    DATA lv_next TYPE c LENGTH 1.
    DATA lv_next_off TYPE i.

    rv_valid = abap_false.
    lv_len = strlen( iv_pointer ).
    IF lv_len < 1 OR iv_pointer(1) <> '/'.
      RETURN.
    ENDIF.

    WHILE lv_off < lv_len.
      lv_char = iv_pointer+lv_off(1).
      IF lv_char = '~'.
        IF lv_off + 1 >= lv_len.
          RETURN.
        ENDIF.
        lv_next_off = lv_off + 1.
        lv_next = iv_pointer+lv_next_off(1).
        IF lv_next <> '0' AND lv_next <> '1'.
          RETURN.
        ENDIF.
        lv_off = lv_off + 2.
      ELSE.
        lv_off = lv_off + 1.
      ENDIF.
    ENDWHILE.
    rv_valid = abap_true.
  ENDMETHOD.

  METHOD path_is_below.
    DATA lv_parent_len TYPE i.
    DATA lv_path_len TYPE i.
    rv_below = abap_false.
    lv_parent_len = strlen( iv_parent ).
    lv_path_len = strlen( iv_path ).
    IF lv_path_len <= lv_parent_len.
      RETURN.
    ENDIF.
    IF iv_path+0(lv_parent_len) = iv_parent
       AND iv_path+lv_parent_len(1) = '/'.
      rv_below = abap_true.
    ENDIF.
  ENDMETHOD.

  METHOD path_is_masked.
    DATA ls_mask TYPE zif_osg_regression=>ty_path_rule.
    LOOP AT it_masks INTO ls_mask.
      IF iv_path = ls_mask-path
         OR path_is_below( iv_path = iv_path iv_parent = ls_mask-path ) = abap_true.
        rv_masked = abap_true.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD add_finding.
    DATA ls_finding TYPE zif_osg_regression=>ty_finding.
    ls_finding-kind = iv_kind.
    ls_finding-scope = 'body'.
    ls_finding-path = iv_path.
    ls_finding-expected = iv_expected.
    ls_finding-actual = iv_actual.
    ls_finding-message = iv_message.
    APPEND ls_finding TO ct_findings.
  ENDMETHOD.

  METHOD validate_masks.
    DATA ls_mask TYPE zif_osg_regression=>ty_path_rule.
    DATA ls_other TYPE zif_osg_regression=>ty_path_rule.
    DATA lv_index TYPE sy-tabix.
    DATA lv_other_index TYPE sy-tabix.

    LOOP AT it_masks INTO ls_mask.
      lv_index = sy-tabix.
      IF ls_mask-reason IS INITIAL
         OR pointer_valid( ls_mask-path ) = abap_false.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_mask
                    iv_path = ls_mask-path
                    iv_message = 'mask requires a valid pointer and nonempty reason'
          CHANGING ct_findings = rt_findings ).
        CONTINUE.
      ENDIF.

      READ TABLE it_expected TRANSPORTING NO FIELDS
        WITH TABLE KEY path = ls_mask-path.
      IF sy-subrc <> 0.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_mask
                    iv_path = ls_mask-path
                    iv_message = 'mask is absent from expected JSON'
          CHANGING ct_findings = rt_findings ).
        CONTINUE.
      ENDIF.
      READ TABLE it_actual TRANSPORTING NO FIELDS
        WITH TABLE KEY path = ls_mask-path.
      IF sy-subrc <> 0.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_mask
                    iv_path = ls_mask-path
                    iv_message = 'mask is absent from actual JSON'
          CHANGING ct_findings = rt_findings ).
        CONTINUE.
      ENDIF.

      LOOP AT it_masks INTO ls_other.
        lv_other_index = sy-tabix.
        IF lv_other_index = lv_index.
          CONTINUE.
        ENDIF.
        IF ls_mask-path = ls_other-path
           OR path_is_below( iv_path = ls_mask-path iv_parent = ls_other-path ) = abap_true
           OR path_is_below( iv_path = ls_other-path iv_parent = ls_mask-path ) = abap_true.
          add_finding(
            EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_mask
                      iv_path = ls_mask-path
                      iv_message = 'duplicate or overlapping mask'
            CHANGING ct_findings = rt_findings ).
          EXIT.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
    SORT rt_findings BY path kind message.
    DELETE ADJACENT DUPLICATES FROM rt_findings COMPARING ALL FIELDS.
  ENDMETHOD.

  METHOD match.
    DATA lt_expected TYPE zif_osg_regression=>tt_json_nodes.
    DATA lt_actual TYPE zif_osg_regression=>tt_json_nodes.
    DATA lv_expected_ok TYPE abap_bool.
    DATA lv_actual_ok TYPE abap_bool.
    DATA ls_expected TYPE zif_osg_regression=>ty_json_node.
    DATA ls_actual TYPE zif_osg_regression=>ty_json_node.

    parse_to_nodes(
      EXPORTING iv_json = iv_expected
      IMPORTING et_nodes = lt_expected ev_ok = lv_expected_ok ).
    parse_to_nodes(
      EXPORTING iv_json = iv_actual
      IMPORTING et_nodes = lt_actual ev_ok = lv_actual_ok ).

    IF lv_expected_ok = abap_false OR lv_actual_ok = abap_false.
      IF lv_expected_ok = abap_false.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_json
                    iv_path = '/expected'
                    iv_message = 'expected body is not valid JSON'
          CHANGING ct_findings = rs_result-findings ).
      ENDIF.
      IF lv_actual_ok = abap_false.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-invalid_json
                    iv_path = '/actual'
                    iv_message = 'actual body is not valid JSON'
          CHANGING ct_findings = rs_result-findings ).
      ENDIF.
      rs_result-outcome = zif_osg_regression=>outcome-error.
      RETURN.
    ENDIF.

    rs_result-findings = validate_masks(
      it_masks = it_masks it_expected = lt_expected it_actual = lt_actual ).
    IF rs_result-findings IS NOT INITIAL.
      rs_result-outcome = zif_osg_regression=>outcome-error.
      RETURN.
    ENDIF.

    LOOP AT lt_expected INTO ls_expected.
      IF path_is_masked( iv_path = ls_expected-path it_masks = it_masks ) = abap_true.
        CONTINUE.
      ENDIF.
      READ TABLE lt_actual INTO ls_actual
        WITH TABLE KEY path = ls_expected-path.
      IF sy-subrc <> 0.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-missing
                    iv_path = ls_expected-path
                    iv_expected = ls_expected-kind
          CHANGING ct_findings = rs_result-findings ).
      ELSEIF ls_expected-kind <> ls_actual-kind.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-type_mismatch
                    iv_path = ls_expected-path
                    iv_expected = ls_expected-kind
                    iv_actual = ls_actual-kind
          CHANGING ct_findings = rs_result-findings ).
      ELSEIF ls_expected-kind <> zif_ajson_types=>node_type-object
         AND ls_expected-kind <> zif_ajson_types=>node_type-array
         AND ls_expected-value <> ls_actual-value.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-value_mismatch
                    iv_path = ls_expected-path
                    iv_expected = ls_expected-value
                    iv_actual = ls_actual-value
          CHANGING ct_findings = rs_result-findings ).
      ENDIF.
    ENDLOOP.

    LOOP AT lt_actual INTO ls_actual.
      IF path_is_masked( iv_path = ls_actual-path it_masks = it_masks ) = abap_true.
        CONTINUE.
      ENDIF.
      READ TABLE lt_expected TRANSPORTING NO FIELDS
        WITH TABLE KEY path = ls_actual-path.
      IF sy-subrc <> 0.
        add_finding(
          EXPORTING iv_kind = zif_osg_regression=>finding_kind-unexpected
                    iv_path = ls_actual-path
                    iv_actual = ls_actual-kind
          CHANGING ct_findings = rs_result-findings ).
      ENDIF.
    ENDLOOP.

    SORT rs_result-findings BY path kind.
    IF rs_result-findings IS INITIAL.
      rs_result-outcome = zif_osg_regression=>outcome-passed.
    ELSE.
      rs_result-outcome = zif_osg_regression=>outcome-failed.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
