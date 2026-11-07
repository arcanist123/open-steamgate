CLASS zcl_osd_v4_test_dpc DEFINITION PUBLIC INHERITING FROM /iwbep/cl_mgw_push_abs_data CREATE PUBLIC.
  PUBLIC SECTION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entityset REDEFINITION.
    METHODS /iwbep/if_mgw_appl_srv_runtime~get_entity REDEFINITION.
  PRIVATE SECTION.
    METHODS rows RETURNING VALUE(rt_rows) TYPE zcl_osd_v4_test_mpc=>tt_rows.
ENDCLASS.
CLASS zcl_osd_v4_test_dpc IMPLEMENTATION.
  METHOD rows.
    DATA ls_row TYPE zcl_osd_v4_test_mpc=>ty_row.
    ls_row-day = '20261107'.
    ls_row-guid = '12345678123412341234123456789ABC'.
    ls_row-amount = '123.45'.
    ls_row-moment = '20261107123045'.
    ls_row-name = |O'Brien, (a=b)  test|.
    APPEND ls_row TO rt_rows.
    ls_row-day = '20261108'.
    ls_row-name = 'Second'.
    APPEND ls_row TO rt_rows.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_appl_srv_runtime~get_entityset.
    DATA lt_rows TYPE zcl_osd_v4_test_mpc=>tt_rows.
    DATA ls_filter TYPE /iwbep/s_mgw_select_option.
    DATA ls_range TYPE /iwbep/s_cod_select_option.
    DATA lv_day TYPE d.
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
ENDCLASS.
