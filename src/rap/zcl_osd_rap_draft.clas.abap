CLASS zcl_osd_rap_draft DEFINITION PUBLIC FINAL CREATE PUBLIC.
* R8 (docs/rap-runtime.md, "R8"): the rows a draft-enabled entity serves,
* its active instances and its drafts side by side. Called by the class
* rap-runtime-gen.mjs generates per draft entity (zif_stg_cds_draft_source)
* with both reads done: IR_ACTIVE the view's rows, IR_DRAFT the draft
* table's (columns named as the CDS elements, plus the admin columns),
* IR_ROWS the served rows (the view's components and ISACTIVEENTITY,
* HASACTIVEENTITY, HASDRAFTENTITY, DRAFTUUID). IR_KNOWN: every draft of the
* table, read without the request's condition: an active row has a draft
* (HasDraftEntity, the latest-version filter) whether or not that draft
* matches the condition; without it the matching drafts are asked.
*
* R9 (docs/rap-runtime.md, "Who sees a draft"): a draft is its owner's. The
* drafts of other users are not served (the request's user is
* ZCL_OSD_LOGON=>USER; the owner the admin row's creator or processor);
* their active instances still say HasDraftEntity and name the draft's
* admin row (DraftAdministrativeData: who holds it). Each row also carries
* what the Fiori Elements filters ask through a navigation: SIBLINGENTITY
* (the other version is there for this user: an active row's own draft, a
* draft's active instance), DRAFTADMIN (there is admin data) and
* INPROCESSBYUSER. IV_LATEST keeps each instance once for this user: its
* own draft, else the active instance.
  PUBLIC SECTION.
    CLASS-METHODS union
      IMPORTING
        ir_active  TYPE REF TO data
        ir_draft   TYPE REF TO data
        ir_known   TYPE REF TO data OPTIONAL
        it_keys    TYPE string_table
        it_orderby TYPE string_table
        it_flags   TYPE /iwbep/t_mgw_select_option OPTIONAL
        iv_latest  TYPE abap_bool DEFAULT abap_false
        ir_rows    TYPE REF TO data.

* whether a row satisfies the flag conditions: per property the I lines
* OR-ed, the E lines AND-ed after them (the select-options meaning); EQ
* and NE only, anything else is no match
* R10: the draft table of a CDS entity that is an entity of a draft-enabled
* behavior definition of the registry, initial otherwise (asked by the path
* elements of a draft row, ZCL_STG_CDS_PATH)
    CLASS-METHODS draft_table_of
      IMPORTING
        iv_entity       TYPE string
      RETURNING
        VALUE(rv_table) TYPE string.

    CLASS-METHODS matches
      IMPORTING
        is_row          TYPE any
        it_flags        TYPE /iwbep/t_mgw_select_option
      RETURNING
        VALUE(rv_match) TYPE abap_bool.
  PRIVATE SECTION.
* R9: SIBLINGENTITY, DRAFTADMIN, INPROCESSBYUSER of a served row (a row
* type without them is left as it is)
    CLASS-METHODS set_admin
      IMPORTING
        is_drafted_admin TYPE abap_bool
        iv_holder        TYPE syuname
        iv_sibling       TYPE abap_bool
      CHANGING
        cs_row           TYPE any.
    CLASS-METHODS key_text
      IMPORTING
        is_row         TYPE any
        it_keys        TYPE string_table
      RETURNING
        VALUE(rv_text) TYPE string.
ENDCLASS.

CLASS zcl_osd_rap_draft IMPLEMENTATION.

  METHOD draft_table_of.
    DATA li_registry TYPE REF TO zif_osd_rap_registry.
    DATA li_bo       TYPE REF TO zif_osd_rap_bo.
    DATA lt_bdefs    TYPE zif_osd_rap_registry=>tt_name.
    DATA lv_bdef     TYPE string.
    DATA lv_class    TYPE string.
    DATA lv_entity   TYPE string.
    DATA ls_model    TYPE zif_osd_rap_bo=>ty_model.
    DATA ls_entity   TYPE zif_osd_rap_bo=>ty_entity.

    lv_class = 'ZCL_OSD_RAP_REGISTRY'.
    TRY.
        CREATE OBJECT li_registry TYPE (lv_class).
      CATCH cx_sy_create_object_error.
        RETURN.
    ENDTRY.
    lv_entity = to_upper( iv_entity ).
    lt_bdefs = li_registry->list( ).
    LOOP AT lt_bdefs INTO lv_bdef.
      li_bo = li_registry->get( lv_bdef ).
      CHECK li_bo IS BOUND.
      ls_model = li_bo->model( ).
      CHECK ls_model-draft = abap_true.
      READ TABLE ls_model-entities INTO ls_entity WITH KEY name = lv_entity.
      IF sy-subrc = 0.
        rv_table = ls_entity-draft_table.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD key_text.
    DATA lv_key  TYPE string.
    DATA lv_text TYPE string.
    FIELD-SYMBOLS <lv_value> TYPE any.
    LOOP AT it_keys INTO lv_key.
      ASSIGN COMPONENT lv_key OF STRUCTURE is_row TO <lv_value>.
      IF sy-subrc = 0.
        lv_text = <lv_value>.
      ELSE.
        CLEAR lv_text.
      ENDIF.
      rv_text = rv_text && |{ strlen( lv_text ) }:{ lv_text }|.
    ENDLOOP.
  ENDMETHOD.

  METHOD set_admin.
    FIELD-SYMBOLS <lv_to> TYPE any.
    ASSIGN COMPONENT 'SIBLINGENTITY' OF STRUCTURE cs_row TO <lv_to>.
    IF sy-subrc = 0.
      <lv_to> = iv_sibling.
    ENDIF.
    ASSIGN COMPONENT 'DRAFTADMIN' OF STRUCTURE cs_row TO <lv_to>.
    IF sy-subrc = 0.
      <lv_to> = is_drafted_admin.
    ENDIF.
    ASSIGN COMPONENT 'INPROCESSBYUSER' OF STRUCTURE cs_row TO <lv_to>.
    IF sy-subrc = 0.
      <lv_to> = iv_holder.
    ENDIF.
  ENDMETHOD.

  METHOD matches.
    DATA ls_filter  LIKE LINE OF it_flags.
    DATA ls_option  TYPE /iwbep/s_cod_select_option.
    DATA lv_value   TYPE string.
    DATA lv_hit     TYPE abap_bool.
    DATA lv_any_i   TYPE abap_bool.
    DATA lv_i_match TYPE abap_bool.
    FIELD-SYMBOLS <lv_value> TYPE any.

    rv_match = abap_true.
    LOOP AT it_flags INTO ls_filter.
      ASSIGN COMPONENT ls_filter-property OF STRUCTURE is_row TO <lv_value>.
      IF sy-subrc <> 0.
        rv_match = abap_false.
        RETURN.
      ENDIF.
      lv_value = <lv_value>.
      CLEAR: lv_any_i, lv_i_match.
      LOOP AT ls_filter-select_options INTO ls_option.
        CASE ls_option-option.
          WHEN 'EQ'.
            lv_hit = boolc( lv_value = ls_option-low ).
          WHEN 'NE'.
            lv_hit = boolc( lv_value <> ls_option-low ).
          WHEN OTHERS.
            rv_match = abap_false.
            RETURN.
        ENDCASE.
        IF ls_option-sign = 'E'.
          IF lv_hit = abap_true.
            rv_match = abap_false.
            RETURN.
          ENDIF.
        ELSE.
          lv_any_i = abap_true.
          IF lv_hit = abap_true.
            lv_i_match = abap_true.
          ENDIF.
        ENDIF.
      ENDLOOP.
      IF lv_any_i = abap_true AND lv_i_match = abap_false.
        rv_match = abap_false.
        RETURN.
      ENDIF.
    ENDLOOP.
  ENDMETHOD.

  METHOD union.
    TYPES:
      BEGIN OF ty_draft_key,
        key    TYPE string,
        uuid   TYPE x LENGTH 16,
        admin  TYPE abap_bool,
        holder TYPE syuname,
        mine   TYPE abap_bool,
      END OF ty_draft_key.
    TYPES:
      BEGIN OF ty_admin,
        draftuuid       TYPE zosd_draft_adm-draftuuid,
        createdbyuser   TYPE zosd_draft_adm-createdbyuser,
        inprocessbyuser TYPE zosd_draft_adm-inprocessbyuser,
      END OF ty_admin.
    DATA lt_drafted TYPE SORTED TABLE OF ty_draft_key WITH UNIQUE KEY key.
    DATA ls_drafted TYPE ty_draft_key.
    DATA lt_admin   TYPE SORTED TABLE OF ty_admin WITH UNIQUE KEY draftuuid.
    DATA ls_admin   TYPE ty_admin.
    DATA lv_me      TYPE syuname.
    DATA lv_key     TYPE string.
    DATA lv_line    TYPE string.
    DATA lv_field   TYPE string.
    DATA lv_dir     TYPE string.
    DATA lv_index   TYPE i.
    DATA lt_order   TYPE string_table.
    FIELD-SYMBOLS <lt_active> TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_draft>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_known>  TYPE STANDARD TABLE.
    FIELD-SYMBOLS <lt_rows>   TYPE STANDARD TABLE.
    FIELD-SYMBOLS <ls_in>     TYPE any.
    FIELD-SYMBOLS <ls_row>    TYPE any.
    FIELD-SYMBOLS <lv_from>   TYPE any.
    FIELD-SYMBOLS <lv_to>     TYPE any.

    ASSIGN ir_active->* TO <lt_active>.
    ASSIGN ir_draft->* TO <lt_draft>.
    ASSIGN ir_rows->* TO <lt_rows>.
    IF ir_known IS BOUND.
      ASSIGN ir_known->* TO <lt_known>.
    ELSE.
      ASSIGN ir_draft->* TO <lt_known>.
    ENDIF.

    lv_me = zcl_osd_logon=>user( ).
    SELECT draftuuid createdbyuser inprocessbyuser FROM zosd_draft_adm
      INTO CORRESPONDING FIELDS OF TABLE lt_admin.
    LOOP AT <lt_known> ASSIGNING <ls_in>.
      CLEAR ls_drafted.
      ls_drafted-key = key_text( is_row = <ls_in> it_keys = it_keys ).
      ASSIGN COMPONENT 'DRAFTADMINISTRATIVEDATAUUID' OF STRUCTURE <ls_in> TO <lv_from>.
      IF sy-subrc = 0.
        ls_drafted-uuid = <lv_from>.
      ENDIF.
* R9: without an admin row (not written yet) the draft is nobody else's
      ls_drafted-mine = abap_true.
      READ TABLE lt_admin INTO ls_admin WITH TABLE KEY draftuuid = ls_drafted-uuid.
      IF sy-subrc = 0.
        ls_drafted-admin  = abap_true.
        ls_drafted-holder = ls_admin-inprocessbyuser.
        ls_drafted-mine   = boolc( ls_admin-createdbyuser = lv_me OR ls_admin-inprocessbyuser = lv_me ).
      ENDIF.
      INSERT ls_drafted INTO TABLE lt_drafted.
    ENDLOOP.

* the active instances: HasDraftEntity when a draft of the key exists
    LOOP AT <lt_active> ASSIGNING <ls_in>.
      APPEND INITIAL LINE TO <lt_rows> ASSIGNING <ls_row>.
      MOVE-CORRESPONDING <ls_in> TO <ls_row>.
      ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE <ls_row> TO <lv_to>.
      <lv_to> = abap_true.
      READ TABLE lt_drafted INTO ls_drafted WITH TABLE KEY key = key_text( is_row = <ls_in> it_keys = it_keys ).
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'HASDRAFTENTITY' OF STRUCTURE <ls_row> TO <lv_to>.
        <lv_to> = abap_true.
        ASSIGN COMPONENT 'DRAFTUUID' OF STRUCTURE <ls_row> TO <lv_to>.
        <lv_to> = ls_drafted-uuid.
        set_admin( EXPORTING is_drafted_admin = ls_drafted-admin iv_holder = ls_drafted-holder
                             iv_sibling = ls_drafted-mine CHANGING cs_row = <ls_row> ).
      ENDIF.
    ENDLOOP.
* the drafts: HasActiveEntity as the draft table keeps it; R9: another
* user's draft is not served
    LOOP AT <lt_draft> ASSIGNING <ls_in>.
      lv_key = key_text( is_row = <ls_in> it_keys = it_keys ).
      CLEAR ls_drafted.
      READ TABLE lt_drafted INTO ls_drafted WITH TABLE KEY key = lv_key.
      IF sy-subrc <> 0.
        ls_drafted-mine = abap_true.
      ELSEIF ls_drafted-mine = abap_false.
        CONTINUE.
      ENDIF.
      APPEND INITIAL LINE TO <lt_rows> ASSIGNING <ls_row>.
      MOVE-CORRESPONDING <ls_in> TO <ls_row>.
      ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE <ls_row> TO <lv_to>.
      CLEAR <lv_to>.
      ASSIGN COMPONENT 'HASDRAFTENTITY' OF STRUCTURE <ls_row> TO <lv_to>.
      CLEAR <lv_to>.
      ASSIGN COMPONENT 'DRAFTADMINISTRATIVEDATAUUID' OF STRUCTURE <ls_in> TO <lv_from>.
      IF sy-subrc = 0.
        ASSIGN COMPONENT 'DRAFTUUID' OF STRUCTURE <ls_row> TO <lv_to>.
        <lv_to> = <lv_from>.
      ENDIF.
      ASSIGN COMPONENT 'HASACTIVEENTITY' OF STRUCTURE <ls_row> TO <lv_from>.
      set_admin( EXPORTING is_drafted_admin = ls_drafted-admin iv_holder = ls_drafted-holder
                           iv_sibling = boolc( <lv_from> IS NOT INITIAL ) CHANGING cs_row = <ls_row> ).
    ENDLOOP.

    IF it_flags IS NOT INITIAL OR iv_latest = abap_true.
      lv_index = lines( <lt_rows> ).
      WHILE lv_index > 0.
        READ TABLE <lt_rows> INDEX lv_index ASSIGNING <ls_row>.
        IF iv_latest = abap_true.
* an active row whose draft this user sees gives way to the draft
          ASSIGN COMPONENT 'ISACTIVEENTITY' OF STRUCTURE <ls_row> TO <lv_from>.
          ASSIGN COMPONENT 'SIBLINGENTITY' OF STRUCTURE <ls_row> TO <lv_to>.
          IF <lv_from> IS NOT INITIAL AND <lv_to> IS NOT INITIAL.
            DELETE <lt_rows> INDEX lv_index.
            lv_index = lv_index - 1.
            CONTINUE.
          ENDIF.
        ENDIF.
        IF matches( is_row = <ls_row> it_flags = it_flags ) = abap_false.
          DELETE <lt_rows> INDEX lv_index.
        ENDIF.
        lv_index = lv_index - 1.
      ENDWHILE.
    ENDIF.

* the order: the request's, else the keys with the active version first;
* the last criterion is sorted first, each sort stable
    IF it_orderby IS INITIAL.
      LOOP AT it_keys INTO lv_field.
        APPEND |{ lv_field } ASCENDING| TO lt_order.
      ENDLOOP.
      APPEND `ISACTIVEENTITY DESCENDING` TO lt_order.
    ELSE.
      lt_order = it_orderby.
    ENDIF.
    lv_index = lines( lt_order ).
    WHILE lv_index > 0.
      READ TABLE lt_order INDEX lv_index INTO lv_line.
      SPLIT lv_line AT space INTO lv_field lv_dir.
      lv_field = to_upper( lv_field ).
      IF to_upper( lv_dir ) = 'DESCENDING'.
        SORT <lt_rows> STABLE BY (lv_field) DESCENDING.
      ELSE.
        SORT <lt_rows> STABLE BY (lv_field) ASCENDING.
      ENDIF.
      lv_index = lv_index - 1.
    ENDWHILE.
  ENDMETHOD.

ENDCLASS.
