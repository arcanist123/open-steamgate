CLASS zcl_stg_filter DEFINITION PUBLIC CREATE PUBLIC.
* $filter -> /iwbep/t_mgw_select_option, the way the Gateway hands it to a
* DPC: one entry per property, SIGN/OPTION/LOW/HIGH ranges. Only filters that
* ranges can express are converted (per-property ORs joined by AND, ge/le
* pairs folded to BT, ne and not-eq to E EQ, startswith/endswith/substringof
* to CP). Anything else yields an empty table and the DPC gets the raw
* string, which is also what a real system does.
  PUBLIC SECTION.
    TYPES: BEGIN OF ty_token,
             kind  TYPE string,
             value TYPE string,
           END OF ty_token.
    TYPES ty_tokens TYPE STANDARD TABLE OF ty_token WITH DEFAULT KEY.

    TYPES: BEGIN OF ty_node,
             id       TYPE i,
             kind     TYPE string,
             left     TYPE i,
             right    TYPE i,
             property TYPE string,
             op       TYPE string,
             value    TYPE string,
           END OF ty_node.
    TYPES ty_nodes TYPE STANDARD TABLE OF ty_node WITH DEFAULT KEY.

    CLASS-METHODS parse
      IMPORTING
        iv_filter                TYPE string
        is_set                   TYPE zcl_stg_model_info=>ty_entity_set
      RETURNING
        VALUE(rt_select_options) TYPE /iwbep/t_mgw_select_option
      RAISING
        zcx_stg_error.

    CLASS-METHODS tokenize
      IMPORTING
        iv_filter        TYPE string
      RETURNING
        VALUE(rt_tokens) TYPE ty_tokens
      RAISING
        zcx_stg_error.

    METHODS constructor
      IMPORTING
        it_tokens TYPE ty_tokens
        is_set    TYPE zcl_stg_model_info=>ty_entity_set.

    METHODS parse_tree
      RETURNING
        VALUE(rt_nodes) TYPE ty_nodes
      RAISING
        zcx_stg_error.
  PRIVATE SECTION.
    TYPES: BEGIN OF ty_group,
             property TYPE string,
             options  TYPE /iwbep/t_cod_select_options,
           END OF ty_group.
    TYPES ty_groups TYPE STANDARD TABLE OF ty_group WITH DEFAULT KEY.

    DATA mt_tokens TYPE ty_tokens.
    DATA mv_pos    TYPE i.
    DATA mt_nodes  TYPE ty_nodes.
    DATA ms_set    TYPE zcl_stg_model_info=>ty_entity_set.

    METHODS peek
      RETURNING
        VALUE(rs_token) TYPE ty_token.

    METHODS take
      RETURNING
        VALUE(rs_token) TYPE ty_token.

    METHODS expect
      IMPORTING
        iv_kind  TYPE string
        iv_value TYPE string OPTIONAL
      RAISING
        zcx_stg_error.

    METHODS add_node
      IMPORTING
        is_node      TYPE ty_node
      RETURNING
        VALUE(rv_id) TYPE i.

    METHODS parse_or
      RETURNING
        VALUE(rv_id) TYPE i
      RAISING
        zcx_stg_error.

    METHODS parse_and
      RETURNING
        VALUE(rv_id) TYPE i
      RAISING
        zcx_stg_error.

    METHODS parse_unary
      RETURNING
        VALUE(rv_id) TYPE i
      RAISING
        zcx_stg_error.

    METHODS parse_primary
      RETURNING
        VALUE(rv_id) TYPE i
      RAISING
        zcx_stg_error.

    METHODS parse_function
      IMPORTING
        iv_name      TYPE string
      RETURNING
        VALUE(rv_id) TYPE i
      RAISING
        zcx_stg_error.

    METHODS property_name
      IMPORTING
        iv_name        TYPE string
      RETURNING
        VALUE(rv_name) TYPE string
      RAISING
        zcx_stg_error.

    METHODS literal_value
      IMPORTING
        is_token        TYPE ty_token
      RETURNING
        VALUE(rv_value) TYPE string
      RAISING
        zcx_stg_error.

    METHODS to_groups
      IMPORTING
        iv_id     TYPE i
      EXPORTING
        et_groups TYPE ty_groups
        ev_ok     TYPE abap_bool.

    METHODS merge_and
      IMPORTING
        it_left   TYPE ty_groups
        it_right  TYPE ty_groups
      EXPORTING
        et_groups TYPE ty_groups
        ev_ok     TYPE abap_bool.

    METHODS fail
      IMPORTING
        iv_message TYPE string
      RAISING
        zcx_stg_error.
ENDCLASS.

CLASS zcl_stg_filter IMPLEMENTATION.

  METHOD parse.
    DATA lo_parser TYPE REF TO zcl_stg_filter.
    DATA lt_nodes  TYPE ty_nodes.
    DATA lt_groups TYPE ty_groups.
    DATA ls_group  LIKE LINE OF lt_groups.
    DATA ls_option TYPE /iwbep/s_mgw_select_option.
    DATA lv_ok     TYPE abap_bool.
    DATA lv_root   TYPE i.

    IF iv_filter IS INITIAL.
      RETURN.
    ENDIF.

    CREATE OBJECT lo_parser
      EXPORTING
        it_tokens = tokenize( iv_filter )
        is_set    = is_set.
    lt_nodes = lo_parser->parse_tree( ).
    lv_root  = lines( lt_nodes ).

    lo_parser->to_groups( EXPORTING iv_id     = lv_root
                          IMPORTING et_groups = lt_groups
                                    ev_ok     = lv_ok ).
    IF lv_ok = abap_false.
      RETURN.
    ENDIF.

    LOOP AT lt_groups INTO ls_group.
      CLEAR ls_option.
      ls_option-property       = ls_group-property.
      ls_option-select_options = ls_group-options.
      APPEND ls_option TO rt_select_options.
    ENDLOOP.
  ENDMETHOD.

  METHOD fail.
    RAISE EXCEPTION TYPE zcx_stg_error
      EXPORTING
        status  = 400
        code    = 'STG/BAD_FILTER'
        message = iv_message.
  ENDMETHOD.

  METHOD tokenize.
    DATA lv_len   TYPE i.
    DATA lv_off   TYPE i.
    DATA lv_char  TYPE c LENGTH 1.
    DATA lv_next  TYPE c LENGTH 1.
    DATA lv_quote TYPE string.
    DATA ls_token TYPE ty_token.
    DATA lv_start TYPE i.
    DATA lv_count TYPE i.
    DATA lv_piece TYPE string.

    lv_quote = |'|.
    lv_len   = strlen( iv_filter ).

    WHILE lv_off < lv_len.
      lv_char = iv_filter+lv_off(1).
      CLEAR ls_token.

      IF lv_char IS INITIAL.
        lv_off = lv_off + 1.
        CONTINUE.
      ENDIF.

      IF lv_char = '('.
        ls_token-kind = 'LPAREN'.
        lv_off = lv_off + 1.
      ELSEIF lv_char = ')'.
        ls_token-kind = 'RPAREN'.
        lv_off = lv_off + 1.
      ELSEIF lv_char = ','.
        ls_token-kind = 'COMMA'.
        lv_off = lv_off + 1.
      ELSEIF lv_char = lv_quote.
        ls_token-kind = 'STRING'.
        lv_off = lv_off + 1.
        WHILE lv_off < lv_len.
          lv_char = iv_filter+lv_off(1).
          IF lv_char = lv_quote.
            IF lv_off + 1 < lv_len.
              lv_start = lv_off + 1.
              lv_next  = iv_filter+lv_start(1).
              IF lv_next = lv_quote.
                ls_token-value = ls_token-value && lv_quote.
                lv_off = lv_off + 2.
                CONTINUE.
              ENDIF.
            ENDIF.
            lv_off = lv_off + 1.
            EXIT.
          ENDIF.
* c LENGTH 1 loses a blank in &&, a one-character string keeps it
          lv_piece = iv_filter+lv_off(1).
          ls_token-value = ls_token-value && lv_piece.
          lv_off = lv_off + 1.
        ENDWHILE.
      ELSEIF lv_char CA '0123456789-'.
        ls_token-kind = 'NUMBER'.
        lv_start = lv_off.
        WHILE lv_off < lv_len AND iv_filter+lv_off(1) CA '0123456789.-'.
          lv_off = lv_off + 1.
        ENDWHILE.
        lv_count = lv_off - lv_start.
        ls_token-value = iv_filter+lv_start(lv_count).
      ELSEIF to_upper( lv_char ) CA sy-abcde OR lv_char = '_' OR lv_char = '$'.
        ls_token-kind = 'IDENT'.
        lv_start = lv_off.
        WHILE lv_off < lv_len AND ( to_upper( iv_filter+lv_off(1) ) CA sy-abcde OR iv_filter+lv_off(1) CA '0123456789_./$' ).
          lv_off = lv_off + 1.
        ENDWHILE.
        lv_count = lv_off - lv_start.
        ls_token-value = iv_filter+lv_start(lv_count).
* typed literal: datetime'...', guid'...', X'...'
        IF lv_off < lv_len AND iv_filter+lv_off(1) = lv_quote.
          ls_token-kind = 'TYPED'.
          lv_off = lv_off + 1.
          lv_start = lv_off.
          WHILE lv_off < lv_len AND iv_filter+lv_off(1) <> lv_quote.
            lv_off = lv_off + 1.
          ENDWHILE.
          lv_count = lv_off - lv_start.
          ls_token-value = |{ to_lower( ls_token-value ) }:{ iv_filter+lv_start(lv_count) }|.
          lv_off = lv_off + 1.
        ENDIF.
      ELSE.
        RAISE EXCEPTION TYPE zcx_stg_error
          EXPORTING
            status  = 400
            code    = 'STG/BAD_FILTER'
            message = |Unexpected character '{ lv_char }' at { lv_off } in $filter|.
      ENDIF.

      IF ls_token-kind = 'STRING' OR ls_token-kind = 'TYPED'.
        zcl_stg_url=>refuse_nul( iv_value = ls_token-value
                                 iv_code  = 'STG/BAD_FILTER'
                                 iv_where = 'a $filter literal' ).
      ENDIF.

      APPEND ls_token TO rt_tokens.
    ENDWHILE.
  ENDMETHOD.

  METHOD constructor.
    mt_tokens = it_tokens.
    ms_set    = is_set.
  ENDMETHOD.

  METHOD peek.
    READ TABLE mt_tokens INDEX mv_pos + 1 INTO rs_token.
    IF sy-subrc <> 0.
      rs_token-kind = 'END'.
    ENDIF.
  ENDMETHOD.

  METHOD take.
    rs_token = peek( ).
    mv_pos = mv_pos + 1.
  ENDMETHOD.

  METHOD expect.
    DATA ls_token TYPE ty_token.

    ls_token = take( ).
    IF ls_token-kind <> iv_kind OR ( iv_value IS NOT INITIAL AND to_lower( ls_token-value ) <> to_lower( iv_value ) ).
      fail( |Expected { iv_kind } { iv_value } in $filter, got { ls_token-kind } { ls_token-value }| ).
    ENDIF.
  ENDMETHOD.

  METHOD add_node.
    DATA ls_node TYPE ty_node.

    ls_node = is_node.
    ls_node-id = lines( mt_nodes ) + 1.
    APPEND ls_node TO mt_nodes.
    rv_id = ls_node-id.
  ENDMETHOD.

  METHOD parse_tree.
    DATA ls_token TYPE ty_token.

    parse_or( ).
    ls_token = peek( ).
    IF ls_token-kind <> 'END'.
      fail( |Unexpected { ls_token-value } in $filter| ).
    ENDIF.
    rt_nodes = mt_nodes.
  ENDMETHOD.

  METHOD parse_or.
    DATA ls_node  TYPE ty_node.
    DATA ls_token TYPE ty_token.
    DATA lv_right TYPE i.

    rv_id = parse_and( ).
    DO.
      ls_token = peek( ).
      IF ls_token-kind <> 'IDENT' OR to_lower( ls_token-value ) <> 'or'.
        EXIT.
      ENDIF.
      take( ).
      lv_right = parse_and( ).
      CLEAR ls_node.
      ls_node-kind  = 'or'.
      ls_node-left  = rv_id.
      ls_node-right = lv_right.
      rv_id = add_node( ls_node ).
    ENDDO.
  ENDMETHOD.

  METHOD parse_and.
    DATA ls_node  TYPE ty_node.
    DATA ls_token TYPE ty_token.
    DATA lv_right TYPE i.

    rv_id = parse_unary( ).
    DO.
      ls_token = peek( ).
      IF ls_token-kind <> 'IDENT' OR to_lower( ls_token-value ) <> 'and'.
        EXIT.
      ENDIF.
      take( ).
      lv_right = parse_unary( ).
      CLEAR ls_node.
      ls_node-kind  = 'and'.
      ls_node-left  = rv_id.
      ls_node-right = lv_right.
      rv_id = add_node( ls_node ).
    ENDDO.
  ENDMETHOD.

  METHOD parse_unary.
    DATA ls_node  TYPE ty_node.
    DATA ls_token TYPE ty_token.

    ls_token = peek( ).
    IF ls_token-kind = 'IDENT' AND to_lower( ls_token-value ) = 'not'.
      take( ).
      ls_node-kind = 'not'.
      ls_node-left = parse_unary( ).
      rv_id = add_node( ls_node ).
      RETURN.
    ENDIF.
    rv_id = parse_primary( ).
  ENDMETHOD.

  METHOD parse_primary.
    DATA ls_token TYPE ty_token.
    DATA ls_after TYPE ty_token.
    DATA ls_node  TYPE ty_node.
    DATA lv_op    TYPE string.

    ls_token = take( ).

    IF ls_token-kind = 'LPAREN'.
      rv_id = parse_or( ).
      expect( 'RPAREN' ).
      RETURN.
    ENDIF.

    IF ls_token-kind <> 'IDENT'.
      fail( |Expected a property or function in $filter, got { ls_token-value }| ).
    ENDIF.

    ls_after = peek( ).
    IF ls_after-kind = 'LPAREN'.
      take( ).
      rv_id = parse_function( to_lower( ls_token-value ) ).
      RETURN.
    ENDIF.

* property op literal
    ls_node-kind     = 'cmp'.
    ls_node-property = property_name( ls_token-value ).
    ls_token = take( ).
    lv_op = to_lower( ls_token-value ).
    IF ls_token-kind <> 'IDENT' OR NOT ( lv_op = 'eq' OR lv_op = 'ne' OR lv_op = 'gt' OR lv_op = 'ge' OR lv_op = 'lt' OR lv_op = 'le' ).
      fail( |Expected a comparison operator after { ls_node-property } in $filter| ).
    ENDIF.
    ls_node-op = lv_op.
    ls_token = take( ).
    ls_node-value = literal_value( ls_token ).
    rv_id = add_node( ls_node ).
  ENDMETHOD.

  METHOD parse_function.
    DATA ls_node  TYPE ty_node.
    DATA ls_token TYPE ty_token.
    DATA ls_value TYPE ty_token.

    ls_node-kind = 'fn'.
    ls_node-op   = iv_name.

    CASE iv_name.
      WHEN 'startswith' OR 'endswith'.
        ls_token = take( ).
        ls_node-property = property_name( ls_token-value ).
        expect( 'COMMA' ).
        ls_value = take( ).
        ls_node-value = literal_value( ls_value ).
        expect( 'RPAREN' ).
      WHEN 'substringof'.
        ls_value = take( ).
        ls_node-value = literal_value( ls_value ).
        expect( 'COMMA' ).
        ls_token = take( ).
        ls_node-property = property_name( ls_token-value ).
        expect( 'RPAREN' ).
      WHEN 'tolower' OR 'toupper' OR 'trim'.
* case folding is lost on the way to a range; the property is kept
        ls_token = take( ).
        expect( 'RPAREN' ).
        ls_node-kind     = 'cmp'.
        ls_node-property = property_name( ls_token-value ).
        ls_token = take( ).
        ls_node-op = to_lower( ls_token-value ).
        ls_token = take( ).
        ls_node-value = literal_value( ls_token ).
      WHEN OTHERS.
        fail( |Function { iv_name } is not supported in $filter| ).
    ENDCASE.

    rv_id = add_node( ls_node ).
  ENDMETHOD.

  METHOD property_name.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.

    ls_property = zcl_stg_model_info=>find_property( is_set  = ms_set
                                                     iv_name = iv_name ).
    rv_name = ls_property-name.
  ENDMETHOD.

  METHOD literal_value.
    DATA lv_type TYPE string.
    DATA lv_raw  TYPE string.
    DATA lv_off  TYPE i.

    CASE is_token-kind.
      WHEN 'STRING' OR 'NUMBER'.
        rv_value = is_token-value.
      WHEN 'IDENT'.
        CASE to_lower( is_token-value ).
          WHEN 'true'.
            rv_value = 'X'.
          WHEN 'false'.
            rv_value = ''.
          WHEN 'null'.
            rv_value = ''.
          WHEN OTHERS.
            fail( |Expected a literal in $filter, got { is_token-value }| ).
        ENDCASE.
      WHEN 'TYPED'.
        FIND FIRST OCCURRENCE OF ':' IN is_token-value MATCH OFFSET lv_off.
        lv_type = is_token-value(lv_off).
        lv_raw  = substring( val = is_token-value
                             off = lv_off + 1 ).
        CASE lv_type.
          WHEN 'datetime'.
* 2024-01-02T10:20:30 -> 20240102102030 (ABAP timestamp)
            REPLACE ALL OCCURRENCES OF '-' IN lv_raw WITH ''.
            REPLACE ALL OCCURRENCES OF ':' IN lv_raw WITH ''.
            REPLACE ALL OCCURRENCES OF 'T' IN lv_raw WITH ''.
            rv_value = lv_raw.
          WHEN 'guid'.
            REPLACE ALL OCCURRENCES OF '-' IN lv_raw WITH ''.
            rv_value = to_upper( lv_raw ).
          WHEN OTHERS.
            rv_value = lv_raw.
        ENDCASE.
      WHEN OTHERS.
        fail( |Expected a literal in $filter| ).
    ENDCASE.
  ENDMETHOD.

  METHOD to_groups.
    DATA ls_node   TYPE ty_node.
    DATA ls_group  TYPE ty_group.
    DATA ls_option TYPE /iwbep/s_cod_select_option.
    DATA lv_cp_value TYPE string.
    DATA lt_left   TYPE ty_groups.
    DATA lt_right  TYPE ty_groups.
    DATA ls_left   TYPE ty_group.
    DATA ls_right  TYPE ty_group.
    DATA lv_ok     TYPE abap_bool.
    DATA ls_child  TYPE ty_node.

    CLEAR et_groups.
    ev_ok = abap_false.
    READ TABLE mt_nodes INDEX iv_id INTO ls_node.
    IF sy-subrc <> 0.
      RETURN.
    ENDIF.

    CASE ls_node-kind.
      WHEN 'cmp'.
        ls_option-sign = 'I'.
        CASE ls_node-op.
          WHEN 'eq'.
            ls_option-option = 'EQ'.
          WHEN 'ne'.
            ls_option-sign   = 'E'.
            ls_option-option = 'EQ'.
          WHEN 'gt'.
            ls_option-option = 'GT'.
          WHEN 'ge'.
            ls_option-option = 'GE'.
          WHEN 'lt'.
            ls_option-option = 'LT'.
          WHEN 'le'.
            ls_option-option = 'LE'.
          WHEN OTHERS.
            RETURN.
        ENDCASE.
        ls_option-low = ls_node-value.
        ls_group-property = ls_node-property.
        APPEND ls_option TO ls_group-options.
        APPEND ls_group TO et_groups.
        ev_ok = abap_true.

      WHEN 'fn'.
        ls_option-sign   = 'I'.
        ls_option-option = 'CP'.
* the value is text, and * + # are CP's own characters: each is made
* literal with # before the wildcards go around it, or
* substringof('*',x) would match every row and startswith(x,'A#B') would
* read the # as an escape
        lv_cp_value = ls_node-value.
        REPLACE ALL OCCURRENCES OF REGEX '([*+#])' IN lv_cp_value WITH '#$1'.
        CASE ls_node-op.
          WHEN 'startswith'.
            ls_option-low = |{ lv_cp_value }*|.
          WHEN 'endswith'.
            ls_option-low = |*{ lv_cp_value }|.
          WHEN 'substringof'.
            ls_option-low = |*{ lv_cp_value }*|.
          WHEN OTHERS.
            RETURN.
        ENDCASE.
        ls_group-property = ls_node-property.
        APPEND ls_option TO ls_group-options.
        APPEND ls_group TO et_groups.
        ev_ok = abap_true.

      WHEN 'not'.
        READ TABLE mt_nodes INDEX ls_node-left INTO ls_child.
        IF sy-subrc <> 0 OR ls_child-kind <> 'cmp' OR ls_child-op <> 'eq'.
          RETURN.
        ENDIF.
        ls_option-sign   = 'E'.
        ls_option-option = 'EQ'.
        ls_option-low    = ls_child-value.
        ls_group-property = ls_child-property.
        APPEND ls_option TO ls_group-options.
        APPEND ls_group TO et_groups.
        ev_ok = abap_true.

      WHEN 'or'.
        to_groups( EXPORTING iv_id = ls_node-left IMPORTING et_groups = lt_left ev_ok = lv_ok ).
        IF lv_ok = abap_false OR lines( lt_left ) <> 1.
          RETURN.
        ENDIF.
        to_groups( EXPORTING iv_id = ls_node-right IMPORTING et_groups = lt_right ev_ok = lv_ok ).
        IF lv_ok = abap_false OR lines( lt_right ) <> 1.
          RETURN.
        ENDIF.
        READ TABLE lt_left INDEX 1 INTO ls_left.
        READ TABLE lt_right INDEX 1 INTO ls_right.
        IF ls_left-property <> ls_right-property.
          RETURN.
        ENDIF.
* an OR of exclusions is not a range
        LOOP AT ls_left-options INTO ls_option WHERE sign = 'E'.
          RETURN.
        ENDLOOP.
        LOOP AT ls_right-options INTO ls_option WHERE sign = 'E'.
          RETURN.
        ENDLOOP.
        APPEND LINES OF ls_right-options TO ls_left-options.
        APPEND ls_left TO et_groups.
        ev_ok = abap_true.

      WHEN 'and'.
        to_groups( EXPORTING iv_id = ls_node-left IMPORTING et_groups = lt_left ev_ok = lv_ok ).
        IF lv_ok = abap_false.
          RETURN.
        ENDIF.
        to_groups( EXPORTING iv_id = ls_node-right IMPORTING et_groups = lt_right ev_ok = lv_ok ).
        IF lv_ok = abap_false.
          RETURN.
        ENDIF.
        merge_and( EXPORTING it_left   = lt_left
                             it_right  = lt_right
                   IMPORTING et_groups = et_groups
                             ev_ok     = ev_ok ).
    ENDCASE.
  ENDMETHOD.

  METHOD merge_and.
    DATA ls_right    TYPE ty_group.
    DATA ls_option   TYPE /iwbep/s_cod_select_option.
    DATA ls_existing TYPE /iwbep/s_cod_select_option.
    DATA lv_merged   TYPE abap_bool.
    FIELD-SYMBOLS <ls_group> TYPE ty_group.
    FIELD-SYMBOLS <ls_low>   TYPE /iwbep/s_cod_select_option.

    et_groups = it_left.
    ev_ok = abap_true.

    LOOP AT it_right INTO ls_right.
      READ TABLE et_groups ASSIGNING <ls_group> WITH KEY property = ls_right-property.
      IF sy-subrc <> 0.
        APPEND ls_right TO et_groups.
        CONTINUE.
      ENDIF.

      LOOP AT ls_right-options INTO ls_option.
        IF ls_option-sign = 'E'.
* exclusions AND freely
          APPEND ls_option TO <ls_group>-options.
          CONTINUE.
        ENDIF.
* the one inclusive AND a range can hold: ge/gt X and le/lt Y -> BT
        lv_merged = abap_false.
        LOOP AT <ls_group>-options ASSIGNING <ls_low> WHERE sign = 'I'.
          IF ( <ls_low>-option = 'GE' AND ls_option-option = 'LE' ).
            <ls_low>-option = 'BT'.
            <ls_low>-high   = ls_option-low.
            lv_merged = abap_true.
          ELSEIF ( <ls_low>-option = 'LE' AND ls_option-option = 'GE' ).
            <ls_low>-option = 'BT'.
            <ls_low>-high   = <ls_low>-low.
            <ls_low>-low    = ls_option-low.
            lv_merged = abap_true.
          ENDIF.
          IF lv_merged = abap_true.
            EXIT.
          ENDIF.
        ENDLOOP.
        IF lv_merged = abap_false.
          LOOP AT <ls_group>-options INTO ls_existing WHERE sign = 'I'.
* two inclusive conditions on one property that are not a BT pair:
* ranges would OR them, which is wrong
            ev_ok = abap_false.
            RETURN.
          ENDLOOP.
          APPEND ls_option TO <ls_group>-options.
        ENDIF.
      ENDLOOP.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
