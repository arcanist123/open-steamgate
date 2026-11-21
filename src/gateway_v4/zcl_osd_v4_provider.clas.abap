CLASS zcl_osd_v4_provider DEFINITION PUBLIC CREATE PUBLIC.
* The io_data_provider of a V4 write: the body's values, already checked
* against their EDM types by ZCL_OSD_V4_WRITE, laid over the entity as it is
* (PATCH) or over an initial one (POST, PUT). A JSON null clears the field;
* a string is assigned as it is, so the text "null" stays "null". Other
* values go through the V2 provider's conversion (dates, times, booleans).
* A deep insert's related entities (it_nested, already checked and converted
* by ZCL_OSD_V4_WRITE) fill the navigation components through the V2
* provider, which builds them from nested JSON.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_entry_provider.
    TYPES: BEGIN OF ty_value,
             name    TYPE string,
             value   TYPE string,
             is_null TYPE abap_bool,
             is_text TYPE abap_bool,
           END OF ty_value.
    TYPES ty_values TYPE STANDARD TABLE OF ty_value WITH DEFAULT KEY.
    METHODS constructor IMPORTING it_values TYPE ty_values is_set TYPE zcl_stg_model_info=>ty_entity_set
      ir_base TYPE REF TO data OPTIONAL
      it_nested TYPE tihttpnvp OPTIONAL is_service TYPE zcl_stg_model_info=>ty_service OPTIONAL.
  PRIVATE SECTION.
    DATA mt_values TYPE ty_values.
    DATA ms_set TYPE zcl_stg_model_info=>ty_entity_set.
    DATA mr_base TYPE REF TO data.
    DATA mt_nested TYPE tihttpnvp.
    DATA ms_service TYPE zcl_stg_model_info=>ty_service.
ENDCLASS.

CLASS zcl_osd_v4_provider IMPLEMENTATION.
  METHOD constructor.
    mt_values = it_values.
    ms_set = is_set.
    mr_base = ir_base.
    mt_nested = it_nested.
    ms_service = is_service.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_entry_provider~read_entry_data.
    DATA ls_value TYPE ty_value.
    DATA ls_prop TYPE zcl_stg_model_info=>ty_property.
    DATA lo_deep TYPE REF TO zcl_stg_entry_provider.
    DATA lt_none TYPE tihttpnvp.
    FIELD-SYMBOLS <ls_base> TYPE any.
    FIELD-SYMBOLS <lv_target> TYPE any.
    CLEAR es_data.
    IF mr_base IS BOUND.
      ASSIGN mr_base->* TO <ls_base>.
      MOVE-CORRESPONDING <ls_base> TO es_data.
    ENDIF.
    LOOP AT mt_values INTO ls_value.
      READ TABLE ms_set-properties INTO ls_prop WITH KEY name = ls_value-name.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      ASSIGN COMPONENT ls_prop-fieldname OF STRUCTURE es_data TO <lv_target>.
      IF sy-subrc <> 0.
        CONTINUE.
      ENDIF.
      IF ls_value-is_null = abap_true.
        CLEAR <lv_target>.
      ELSEIF ls_value-is_text = abap_true.
        <lv_target> = ls_value-value.
      ELSE.
        zcl_stg_entry_provider=>convert_value( EXPORTING iv_value = ls_value-value iv_edm_type = ls_prop-edm_type
          CHANGING cv_target = <lv_target> ).
      ENDIF.
    ENDLOOP.
    IF mt_nested IS NOT INITIAL.
      CREATE OBJECT lo_deep EXPORTING it_values = lt_none is_set = ms_set is_service = ms_service.
      lo_deep->fill( EXPORTING it_values = lt_none it_nested = mt_nested is_set = ms_set CHANGING cs_data = es_data ).
    ENDIF.
  ENDMETHOD.
ENDCLASS.
