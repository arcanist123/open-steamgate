CLASS zcl_stg_request_context DEFINITION PUBLIC CREATE PUBLIC.
* The io_tech_request_context a DPC receives: one object serving every
* /iwbep/if_mgw_req_* facet plus the filter facet. Filled by the dispatcher.
  PUBLIC SECTION.
* A navigation as the technical interface describes it, filled by the
* dispatcher: the set the path starts from and its keys (the URL's, in
* OData names: get_converted_source_keys converts them against that set,
* not against the target), and the technical path, one row per step with
* the step's TARGET keys in ABAP field names (SO_ID, SO_ITEM_POS) -- empty
* for a step the URL gave no key, a to-many step read as a set or a to-one
* step. That is the contract a SEGW sample's provider reads; the twin in
* test/hana-m2 holds it (ZCL_OSD_H5X_TEST, M3-B2; measured on the bed in
* M3-B0, RC2).
    TYPES: BEGIN OF ty_navigation,
             source_set  TYPE zcl_stg_model_info=>ty_entity_set,
             source_keys TYPE /iwbep/t_mgw_name_value_pair,
             tech_path   TYPE /iwbep/t_mgw_tech_navi,
           END OF ty_navigation.

    INTERFACES /iwbep/if_mgw_req_entityset.
    INTERFACES /iwbep/if_mgw_req_entity.
    INTERFACES /iwbep/if_mgw_req_entity_c.
    INTERFACES /iwbep/if_mgw_req_entity_d.
    INTERFACES /iwbep/if_mgw_req_entity_u.
    INTERFACES /iwbep/if_mgw_req_filter.
    INTERFACES /iwbep/if_mgw_req_func_import.

    DATA mv_entity_set    TYPE string.
    DATA mv_entity_type   TYPE string.
    DATA mv_top           TYPE string.
    DATA mv_skip          TYPE i.
    DATA mv_inlinecount   TYPE abap_bool.
    DATA mv_count         TYPE abap_bool.
    DATA mt_orderby       TYPE /iwbep/t_mgw_tech_order.
    DATA mt_filter        TYPE /iwbep/t_mgw_select_option.
    DATA mv_filter_string TYPE string.
* the "search" URL option (Gateway's full-text search, iv_search_string)
    DATA mv_search_string TYPE string.
    DATA mt_key_tab       TYPE /iwbep/t_mgw_name_value_pair.
* a function import: its name and parameters, for a provider that is given
* only the context (SADL's execute_action)
    DATA mv_function_import TYPE string.
    DATA mt_parameter       TYPE /iwbep/t_mgw_name_value_pair.
    DATA ms_set           TYPE zcl_stg_model_info=>ty_entity_set.
    DATA mt_navigation_path TYPE /iwbep/t_mgw_navigation_path.
    DATA mv_source_entity_set TYPE string.
* the entity type of the set the URL addressed before its first navigation
* step: the source of the first row of the technical navigation path
    DATA mv_source_entity_type TYPE string.
    DATA ms_navigation    TYPE ty_navigation.
    DATA mv_select        TYPE string.
    DATA mv_aggregate     TYPE abap_bool.
* R8: the Fiori Elements V4 draft list filter (IsActiveEntity eq false or
* SiblingEntity/IsActiveEntity eq null): each instance once, its draft when
* it has one (docs/rap-runtime.md, R8)
    DATA mv_draft_latest  TYPE abap_bool.
* R9: the other draft conditions Fiori Elements V4 sends through the
* navigations SiblingEntity and DraftAdministrativeData, as conditions on
* the served rows' SIBLINGENTITY, DRAFTADMIN, INPROCESSBYUSER
* (ZCL_OSD_RAP_DRAFT; docs/rap-runtime.md, R9)
    DATA mt_draft_filter  TYPE /iwbep/t_mgw_select_option.

    METHODS get_sorting_order
      RETURNING
        VALUE(rt_order) TYPE /iwbep/t_mgw_sorting_order.

    METHODS get_paging
      RETURNING
        VALUE(rs_paging) TYPE /iwbep/s_mgw_paging.

* One select-option into one Open SQL clause, and one value into one escaped
* literal. Public and static because they are pure functions of their
* arguments and because there must be exactly **one** of each in the system:
* a second escaper is how two places end up quoting differently, and the one
* that is wrong is always the one nobody reads. The data browser (G.9) builds
* its selection screen into select-options and comes here, so its filter and
* an OData `$filter` mean the same thing by the same text.
    CLASS-METHODS where_for_option
      IMPORTING
        iv_field         TYPE string
        is_option        TYPE /iwbep/s_cod_select_option
      RETURNING
        VALUE(rv_clause) TYPE string.

    CLASS-METHODS sql_literal
      IMPORTING
        iv_value         TYPE string
      RETURNING
        VALUE(rv_literal) TYPE string.
  PRIVATE SECTION.
    METHODS tech_navigation_path
      RETURNING
        VALUE(rt_path) TYPE /iwbep/t_mgw_tech_navi.

    METHODS keys_to_structure
      IMPORTING
        is_set        TYPE zcl_stg_model_info=>ty_entity_set
        it_key_tab    TYPE /iwbep/t_mgw_name_value_pair
      EXPORTING
        es_key_values TYPE data.

    METHODS source_keys_to_structure
      EXPORTING
        es_key_values TYPE data.
ENDCLASS.

CLASS zcl_stg_request_context IMPLEMENTATION.

  METHOD get_sorting_order.
    DATA ls_tech LIKE LINE OF mt_orderby.
    DATA ls_sort TYPE /iwbep/s_mgw_sorting_order.

    LOOP AT mt_orderby INTO ls_tech.
      ls_sort-property = ls_tech-property.
      ls_sort-order    = ls_tech-order.
      APPEND ls_sort TO rt_order.
    ENDLOOP.
  ENDMETHOD.

  METHOD get_paging.
    IF mv_top IS NOT INITIAL.
      rs_paging-top = mv_top.
    ENDIF.
    rs_paging-skip = mv_skip.
  ENDMETHOD.

  METHOD keys_to_structure.
* by the ABAP field name the set gives the property: the caller's structure
* may be the set's own type or another one with the same field
    DATA ls_key      LIKE LINE OF it_key_tab.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    FIELD-SYMBOLS <lv_target> TYPE any.

    CLEAR es_key_values.
    LOOP AT it_key_tab INTO ls_key.
      READ TABLE is_set-properties INTO ls_property WITH KEY name = ls_key-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_property-fieldname OF STRUCTURE es_key_values TO <lv_target>.
      IF sy-subrc = 0.
        <lv_target> = ls_key-value.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD source_keys_to_structure.
* the keys of the set the navigation started from, converted against that
* set; without a navigation the source is the addressed entity itself.
* Converted against the target set, as before, a source key the target has
* no property for was dropped: the provider read `bp_id = ' '` (M3-B0, RC2)
    IF ms_navigation-source_set-name IS NOT INITIAL.
      keys_to_structure( EXPORTING is_set        = ms_navigation-source_set
                                   it_key_tab    = ms_navigation-source_keys
                         IMPORTING es_key_values = es_key_values ).
    ELSE.
      keys_to_structure( EXPORTING is_set        = ms_set
                                   it_key_tab    = mt_key_tab
                         IMPORTING es_key_values = es_key_values ).
    ENDIF.
  ENDMETHOD.

  METHOD sql_literal.
    DATA lv_quote TYPE string.
    DATA lv_two   TYPE string.

    lv_quote   = |'|.
    lv_two     = ''''''.
    rv_literal = iv_value.
    REPLACE ALL OCCURRENCES OF lv_quote IN rv_literal WITH lv_two.
    rv_literal = |'{ rv_literal }'|.
  ENDMETHOD.

  METHOD where_for_option.
    DATA lv_pattern TYPE string.
    DATA lv_char    TYPE string.
    DATA lv_len     TYPE i.
    DATA lv_off     TYPE i.
    DATA lv_hash    TYPE abap_bool.
    DATA lv_escape  TYPE abap_bool.
    DATA lv_like    TYPE string.

    CASE is_option-option.
      WHEN 'EQ'.
        rv_clause = |{ iv_field } = { sql_literal( is_option-low ) }|.
      WHEN 'NE'.
        rv_clause = |{ iv_field } <> { sql_literal( is_option-low ) }|.
      WHEN 'GT'.
        rv_clause = |{ iv_field } > { sql_literal( is_option-low ) }|.
      WHEN 'GE'.
        rv_clause = |{ iv_field } >= { sql_literal( is_option-low ) }|.
      WHEN 'LT'.
        rv_clause = |{ iv_field } < { sql_literal( is_option-low ) }|.
      WHEN 'LE'.
        rv_clause = |{ iv_field } <= { sql_literal( is_option-low ) }|.
      WHEN 'BT'.
        rv_clause = |{ iv_field } BETWEEN { sql_literal( is_option-low ) } AND { sql_literal( is_option-high ) }|.
      WHEN 'NB'.
        rv_clause = |{ iv_field } NOT BETWEEN { sql_literal( is_option-low ) } AND { sql_literal( is_option-high ) }|.
      WHEN 'CP' OR 'NP'.
* * is any string, + one character, # makes the next character literal; a
* literal % or _ (or #) is escaped with # and the condition says ESCAPE '#'
* (measured on A4H: LIKE 'L#_' ESCAPE '#' finds only L_). Not measured: a
* # before an ordinary character (it drops, the character stays) and a # at
* the very end, which escapes a padding blank in ABAP's CP and is dropped
* here, as a CHAR column holds no trailing blank to match
        lv_len = strlen( is_option-low ).
        DO lv_len TIMES.
          lv_off = sy-index - 1.
          lv_char = substring( val = is_option-low off = lv_off len = 1 ).
          IF lv_hash = abap_true.
            lv_hash = abap_false.
            IF lv_char = '%' OR lv_char = '_' OR lv_char = '#'.
              lv_escape = abap_true.
              lv_pattern = lv_pattern && '#' && lv_char.
            ELSE.
              lv_pattern = lv_pattern && lv_char.
            ENDIF.
            CONTINUE.
          ENDIF.
          CASE lv_char.
            WHEN '#'.
              lv_hash = abap_true.
            WHEN '*'.
              lv_pattern = lv_pattern && '%'.
            WHEN '+'.
              lv_pattern = lv_pattern && '_'.
            WHEN '%' OR '_'.
              lv_escape = abap_true.
              lv_pattern = lv_pattern && '#' && lv_char.
            WHEN OTHERS.
              lv_pattern = lv_pattern && lv_char.
          ENDCASE.
        ENDDO.
        lv_like = 'LIKE'.
        IF is_option-option = 'NP'.
          lv_like = 'NOT LIKE'.
        ENDIF.
        rv_clause = |{ iv_field } { lv_like } { sql_literal( lv_pattern ) }|.
        IF lv_escape = abap_true.
          rv_clause = |{ rv_clause } ESCAPE '#'|.
        ENDIF.
      WHEN OTHERS.
        rv_clause = |{ iv_field } = { sql_literal( is_option-low ) }|.
    ENDCASE.
    IF is_option-sign = 'E'.
      rv_clause = |NOT ( { rv_clause } )|.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_entity_set_name.
* ---------------- entity set facet
    rv_entity_set = mv_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_source_entity_set_name.
* the set a navigation started from, and nothing for a direct call: a
* SEGW sample's DPC reads "IS INITIAL" as "no navigation" and resolves a
* navigation path otherwise -- with the set itself answered here, a direct
* GET of its business set returned no rows (H5x-4 B4; the system answers
* that GET with rows, so it answers no source set)
    rv_entity_set = mv_source_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_top.
    rv_top = mv_top.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_skip.
    rv_skip = mv_skip.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_inlinecount.
    rv_has_inlinecount = mv_inlinecount.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~has_count.
    rv_has_count = mv_count.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_orderby.
* the technical order: ABAP names, the way get_osql_where_clause speaks. A
* DPC turns them into its SELECT's columns (PARTNER_ID -> b~PARTNER_ID), so an OData
* name here sorts by a column that does not exist. The non-technical
* it_order (get_sorting_order) keeps the OData names. A path into a complex
* property is its ABAP path in property_path (ADDRESS-CITY) with property
* left empty -- the form a caller reading "property, else property_path"
* expects; not measured on a system for a path.
    DATA ls_order    LIKE LINE OF mt_orderby.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.

    LOOP AT mt_orderby INTO ls_order.
      READ TABLE ms_set-properties INTO ls_property WITH KEY name = ls_order-property.
      IF sy-subrc = 0 AND ls_property-fieldname IS NOT INITIAL.
        ls_order-property      = ls_property-fieldname.
        ls_order-property_path = ls_property-fieldname.
      ELSE.
        READ TABLE ms_set-components INTO ls_property WITH KEY name = ls_order-property.
        IF sy-subrc = 0.
          CLEAR ls_order-property.
          ls_order-property_path = ls_property-fieldname.
        ENDIF.
      ENDIF.
      APPEND ls_order TO rt_orderby.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_filter.
    ro_filter = me.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_converted_source_keys.
    source_keys_to_structure( IMPORTING es_key_values = es_key_values ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause.
    DATA ls_filter   LIKE LINE OF mt_filter.
    DATA ls_option   LIKE LINE OF ls_filter-select_options.
    DATA ls_property TYPE zcl_stg_model_info=>ty_property.
    DATA lv_field    TYPE string.
    DATA lv_group    TYPE string.
    DATA lv_clause   TYPE string.
    DATA lv_include  TYPE string.
    DATA lv_exclude  TYPE string.

    LOOP AT mt_filter INTO ls_filter.
      READ TABLE ms_set-properties INTO ls_property WITH KEY name = ls_filter-property.
      IF sy-subrc <> 0.
* a path into a complex property (Address/City) is its ABAP path,
* ADDRESS-CITY, which is what a DPC maps onto its join's columns
        READ TABLE ms_set-components INTO ls_property WITH KEY name = ls_filter-property.
      ENDIF.
      IF sy-subrc = 0.
        lv_field = ls_property-fieldname.
      ELSE.
        lv_field = to_upper( ls_filter-property ).
      ENDIF.
* a select-options table means (any I line) AND NOT (any E line): the I
* lines OR-ed and put in parentheses, the E lines AND-ed after them. Chained
* as `a OR b AND NOT ( c )` the kernel reads `a OR ( b AND NOT c )`, AND
* binding tighter than OR (measured on A4H, docs/osql-where.md)
      CLEAR: lv_group, lv_include, lv_exclude.
      LOOP AT ls_filter-select_options INTO ls_option.
        lv_clause = where_for_option( iv_field  = lv_field
                                      is_option = ls_option ).
        IF ls_option-sign = 'E'.
          IF lv_exclude IS INITIAL.
            lv_exclude = lv_clause.
          ELSE.
            lv_exclude = |{ lv_exclude } AND { lv_clause }|.
          ENDIF.
        ELSE.
          IF lv_include IS INITIAL.
            lv_include = lv_clause.
          ELSE.
            lv_include = |{ lv_include } OR { lv_clause }|.
          ENDIF.
        ENDIF.
      ENDLOOP.
      IF lv_include IS NOT INITIAL AND lv_exclude IS NOT INITIAL.
        lv_group = |( { lv_include } ) AND { lv_exclude }|.
      ELSEIF lv_include IS NOT INITIAL.
        lv_group = lv_include.
      ELSE.
        lv_group = lv_exclude.
      ENDIF.
      IF lv_group IS INITIAL.
        CONTINUE.
      ENDIF.
      IF rv_osql_where_clause IS INITIAL.
        rv_osql_where_clause = |( { lv_group } )|.
      ELSE.
        rv_osql_where_clause = |{ rv_osql_where_clause } AND ( { lv_group } )|.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_osql_where_clause_convert.
    rv_osql_where_clause = /iwbep/if_mgw_req_entityset~get_osql_where_clause( ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_filter~get_filter_select_options.
* ---------------- filter facet
    rt_filter_select_options = mt_filter.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_filter~get_filter_string.
    rv_filter_string = mv_filter_string.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_filter~convert_select_option.
    DATA ls_option TYPE /iwbep/s_cod_select_option.
    DATA lr_line   TYPE REF TO data.
    FIELD-SYMBOLS <ls_line> TYPE any.
    FIELD-SYMBOLS <lv_comp> TYPE any.

    CLEAR et_select_option.
    ev_no_matching_values_found = abap_false.
    CREATE DATA lr_line LIKE LINE OF et_select_option.
    ASSIGN lr_line->* TO <ls_line>.

    LOOP AT is_select_option-select_options INTO ls_option.
      CLEAR <ls_line>.
      ASSIGN COMPONENT 'SIGN' OF STRUCTURE <ls_line> TO <lv_comp>.
      IF sy-subrc = 0.
        <lv_comp> = ls_option-sign.
      ENDIF.
      ASSIGN COMPONENT 'OPTION' OF STRUCTURE <ls_line> TO <lv_comp>.
      IF sy-subrc = 0.
        <lv_comp> = ls_option-option.
      ENDIF.
      ASSIGN COMPONENT 'LOW' OF STRUCTURE <ls_line> TO <lv_comp>.
      IF sy-subrc = 0.
        <lv_comp> = ls_option-low.
      ENDIF.
      ASSIGN COMPONENT 'HIGH' OF STRUCTURE <ls_line> TO <lv_comp>.
      IF sy-subrc = 0.
        <lv_comp> = ls_option-high.
      ENDIF.
      INSERT <ls_line> INTO TABLE et_select_option.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_set_name.
* ---------------- single entity facets
    rv_entity_set = mv_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_entity_type_name.
    rv_entity_type = mv_entity_type.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_source_entity_set_name.
* nothing for a direct read, as the entity-set facet: a SEGW sample's
* *_get_entity reads "IS INITIAL" as "direct" and resolves a navigation
* path otherwise -- with the set itself answered here every direct single
* read took the navigation branch, found an empty path and answered 404
* without a statement (M3-B0, RC1)
    rv_entity_set = mv_source_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_keys.
    keys_to_structure( EXPORTING is_set        = ms_set
                                 it_key_tab    = mt_key_tab
                       IMPORTING es_key_values = es_key_values ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_converted_source_keys.
    source_keys_to_structure( IMPORTING es_key_values = es_key_values ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_entity_set_name.
    rv_entity_set = mv_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_source_entity_set_name.
    IF mv_source_entity_set IS NOT INITIAL.
      rv_entity_set = mv_source_entity_set.
    ELSE.
      rv_entity_set = mv_entity_set.
    ENDIF.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_c~get_entity_type_name.
    rv_entity_type = mv_entity_type.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_d~get_entity_set_name.
    rv_entity_set = mv_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_d~get_entity_type_name.
    rv_entity_type = mv_entity_type.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_d~get_converted_keys.
    keys_to_structure( EXPORTING is_set        = ms_set
                                 it_key_tab    = mt_key_tab
                       IMPORTING es_key_values = es_key_values ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_u~get_entity_set_name.
    rv_entity_set = mv_entity_set.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity_u~get_converted_keys.
    keys_to_structure( EXPORTING is_set        = ms_set
                                 it_key_tab    = mt_key_tab
                       IMPORTING es_key_values = es_key_values ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entity~get_navigation_path.
* H5x-3, the members the SEGW sample calls: the navigation path the URL
* carried (both facets -- its RESOLVE_NAVIGATION_PATH receives the entity
* and the entity-set context and calls the getter on each), and the
* function import's name and its parameters converted into the provider's
* structure (its ACTION_SO_ACTIONS). The data is what the dispatcher filled
* from the parsed request.
    rt_navigation_path = tech_navigation_path( ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_entityset~get_navigation_path.
    rt_navigation_path = tech_navigation_path( ).
  ENDMETHOD.

  METHOD tech_navigation_path.
* The path in technical names, one row per step: the step's navigation
* property, its keys, the entity type it leads to, and the one it starts
* from -- the addressed set's type for the first step, the previous step's
* target for every later one. A caller that follows the contract branches
* on source_entity_type / target_entity_type.
    DATA ls_step   LIKE LINE OF mt_navigation_path.
    DATA ls_key    LIKE LINE OF ls_step-key_tab.
    DATA ls_row    TYPE /iwbep/s_mgw_tech_navi.
    DATA ls_pair   TYPE /iwbep/s_mgw_tech_pair.
    DATA lv_source TYPE string.

* the dispatcher's path, keys per step in ABAP names (ty_navigation); the
* rows below are the fallback for a caller that filled only the classic
* path, and they carry that path's keys as they are
    IF ms_navigation-tech_path IS NOT INITIAL.
      rt_path = ms_navigation-tech_path.
      RETURN.
    ENDIF.
    lv_source = mv_source_entity_type.
    LOOP AT mt_navigation_path INTO ls_step.
      CLEAR ls_row.
      ls_row-nav_prop           = ls_step-nav_prop.
      ls_row-key                = ls_step-key.
      LOOP AT ls_step-key_tab INTO ls_key.
        ls_pair-name  = ls_key-name.
        ls_pair-value = ls_key-value.
        APPEND ls_pair TO ls_row-key_tab.
      ENDLOOP.
      ls_row-source_entity_type = lv_source.
      ls_row-target_entity_type = ls_step-target_type.
      ls_row-multiplicity       = ls_step-multiplicity.
      APPEND ls_row TO rt_path.
      lv_source = ls_step-target_type.
    ENDLOOP.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_func_import~get_function_import_name.
    rv_function_import_name = mv_function_import.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_req_func_import~get_converted_parameters.
    DATA ls_parameter LIKE LINE OF mt_parameter.
    FIELD-SYMBOLS <lv_target> TYPE any.

    CLEAR es_parameter_values.
    LOOP AT mt_parameter INTO ls_parameter.
      ASSIGN COMPONENT ls_parameter-name OF STRUCTURE es_parameter_values TO <lv_target>.
      IF sy-subrc = 0.
        <lv_target> = ls_parameter-value.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

ENDCLASS.
