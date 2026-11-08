CLASS zcl_osd_v4_test_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~create_entity REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~update_entity REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~delete_entity REDEFINITION.
* the notes live as long as the process; the wire tests restore what they change
    CLASS-DATA gt_notes TYPE zcl_osd_v4_test_mpc=>tt_notes.
  PRIVATE SECTION.
    CLASS-METHODS note_id IMPORTING it_key_tab TYPE /iwbep/t_mgw_name_value_pair
      RETURNING VALUE(rv_id) TYPE string.
    METHODS rows RETURNING VALUE(rt_rows) TYPE zcl_osd_v4_test_mpc=>tt_rows.
ENDCLASS.
CLASS zcl_osd_v4_test_dpc IMPLEMENTATION.
  METHOD rows.
    DATA ls_row TYPE zcl_osd_v4_test_mpc=>ty_row.
    ls_row-numeric_text = '0012'.
    ls_row-decimal_text = '0012'.
    ls_row-day = '20261107'.
    ls_row-guid = '12345678123412341234123456789ABC'.
    ls_row-amount = '123.45'.
    ls_row-moment = '20261107123045'.
    ls_row-name = |O'Brien, (a=b)  test|.
    APPEND ls_row TO rt_rows.
    CLEAR ls_row-numeric_text.
    CLEAR ls_row-decimal_text.
    ls_row-day = '20261108'.
    ls_row-name = 'Second'.
    APPEND ls_row TO rt_rows.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    DATA lt_rows TYPE zcl_osd_v4_test_mpc=>tt_rows.
    DATA ls_filter TYPE /iwbep/s_mgw_select_option.
    DATA ls_range TYPE /iwbep/s_cod_select_option.
    DATA lv_day TYPE d.
    IF iv_entity_set_name = 'NoteSet'.
      copy_data_to_ref( EXPORTING is_data = gt_notes CHANGING cr_data = er_entityset ).
      RETURN.
    ENDIF.
    lt_rows = rows( ).
    LOOP AT it_filter_select_options INTO ls_filter.
      READ TABLE ls_filter-select_options INDEX 1 INTO ls_range.
      CASE ls_filter-property.
        WHEN 'Day'.
          lv_day = ls_range-low.
          DELETE lt_rows WHERE day <> lv_day.
        WHEN 'Guid'.
          DELETE lt_rows WHERE guid <> ls_range-low.
        WHEN 'Name'.
          DELETE lt_rows WHERE name <> ls_range-low.
        WHEN 'Moment'.
          DELETE lt_rows WHERE moment <> ls_range-low.
      ENDCASE.
    ENDLOOP.
    copy_data_to_ref( EXPORTING is_data = lt_rows CHANGING cr_data = er_entityset ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entity.
    DATA lt_rows TYPE zcl_osd_v4_test_mpc=>tt_rows.
    DATA ls_row TYPE zcl_osd_v4_test_mpc=>ty_row.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    DATA lv_day TYPE d.
    DATA lv_guid TYPE string.
    DATA lv_name TYPE string.
    DATA ls_note TYPE zcl_osd_v4_test_mpc=>ty_note.
    DATA lv_id TYPE string.
    IF iv_entity_set_name = 'NoteSet'.
      lv_id = note_id( it_key_tab ).
      READ TABLE gt_notes INTO ls_note WITH KEY id = lv_id.
      IF sy-subrc = 0.
        copy_data_to_ref( EXPORTING is_data = ls_note CHANGING cr_data = er_entity ).
      ENDIF.
      RETURN.
    ENDIF.
    lt_rows = rows( ).
    LOOP AT it_key_tab INTO ls_key.
      CASE ls_key-name.
        WHEN 'Day'.
          lv_day = ls_key-value.
        WHEN 'Guid'.
          lv_guid = ls_key-value.
        WHEN 'Name'.
          lv_name = ls_key-value.
      ENDCASE.
    ENDLOOP.
    IF iv_entity_set_name = 'TextSet'.
      READ TABLE lt_rows INTO ls_row WITH KEY name = lv_name.
    ELSE.
      READ TABLE lt_rows INTO ls_row WITH KEY day = lv_day guid = lv_guid.
    ENDIF.
    IF sy-subrc = 0.
      copy_data_to_ref( EXPORTING is_data = ls_row CHANGING cr_data = er_entity ).
    ENDIF.
  ENDMETHOD.

  METHOD note_id.
    DATA ls_key TYPE /iwbep/s_mgw_name_value_pair.
    READ TABLE it_key_tab INTO ls_key WITH KEY name = 'Id'.
    rv_id = ls_key-value.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~create_entity.
    DATA ls_note TYPE zcl_osd_v4_test_mpc=>ty_note.
    io_data_provider->read_entry_data( IMPORTING es_data = ls_note ).
    READ TABLE gt_notes WITH KEY id = ls_note-id TRANSPORTING NO FIELDS.
    IF sy-subrc = 0 OR ls_note-id IS INITIAL.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception EXPORTING message = |Note { ls_note-id } cannot be created|.
    ENDIF.
    ls_note-version = 1.
    APPEND ls_note TO gt_notes.
    copy_data_to_ref( EXPORTING is_data = ls_note CHANGING cr_data = er_entity ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~update_entity.
    DATA ls_note TYPE zcl_osd_v4_test_mpc=>ty_note.
    DATA ls_old TYPE zcl_osd_v4_test_mpc=>ty_note.
    DATA lv_index TYPE i.
    DATA lv_id TYPE string.
    lv_id = note_id( it_key_tab ).
    READ TABLE gt_notes INTO ls_old WITH KEY id = lv_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception EXPORTING message = 'No such note'.
    ENDIF.
    lv_index = sy-tabix.
    io_data_provider->read_entry_data( IMPORTING es_data = ls_note ).
    ls_note-id = ls_old-id.
    ls_note-version = ls_old-version + 1.
    MODIFY gt_notes FROM ls_note INDEX lv_index.
    copy_data_to_ref( EXPORTING is_data = ls_note CHANGING cr_data = er_entity ).
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~delete_entity.
    DATA lv_id TYPE string.
    lv_id = note_id( it_key_tab ).
    DELETE gt_notes WHERE id = lv_id.
    IF sy-subrc <> 0.
      RAISE EXCEPTION TYPE /iwbep/cx_mgw_busi_exception EXPORTING message = 'No such note'.
    ENDIF.
  ENDMETHOD.
ENDCLASS.
