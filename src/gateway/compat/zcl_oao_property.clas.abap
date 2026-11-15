CLASS zcl_oao_property DEFINITION PUBLIC.
* Overlay of open-abap-odata's property (src/gateway/compat/README.md):
* the attributes bind_structure fills from the dictionary.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_property.

    DATA mv_abap_fieldname TYPE string.
    DATA mv_is_key         TYPE abap_bool.
    DATA mv_filterable     TYPE abap_bool.
    DATA mv_nullable       TYPE abap_bool.
    DATA mv_sortable       TYPE abap_bool.
    DATA mv_updatable      TYPE abap_bool.
    DATA mv_creatable      TYPE abap_bool.
    DATA mv_maxlength      TYPE i.
    DATA mv_precision      TYPE i.
    DATA mv_edm_type       TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_edm_type.
* set instead of mv_edm_type when the property is typed by a complex type of the model
    DATA mv_complex_type   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_conv_exit      TYPE string.
    DATA mv_conversion     TYPE abap_bool VALUE abap_true.
    DATA mv_content_type   TYPE abap_bool.
    DATA mv_text_symbol    TYPE textpoolky.
    DATA mv_text_container TYPE string.
    DATA mv_label          TYPE string.
* sap:display-format, "Date" for a DATS-bound Edm.DateTime (set by bind_structure)
    DATA mv_display_format TYPE string.
    DATA mv_semantic       TYPE string.
    DATA mv_etag           TYPE abap_bool.
    DATA mo_annotation     TYPE REF TO zcl_oao_annotation.
* what bind_structure derives from the dictionary (overlay, milestone 3 B4,
* zcl_osd_ddic_info=>bind): the component's data element (its medium field
* label is the label when the model set none, resolved in the session
* language when the model is written), its dictionary type, the property
* bound to its reference field (sap:unit of an amount or a quantity) and
* the semantics its type implies (a currency key, a unit)
    DATA mv_rollname       TYPE string.
    DATA mv_ddic_datatype  TYPE string.
    DATA mv_unit_property  TYPE string.
    DATA mv_ddic_semantic  TYPE string.
* a date (DATS) behind the property: the V4 facade types it Edm.Date; the
* V2 $metadata of a system writes no sap:display-format for it
    DATA mv_is_date        TYPE abap_bool.
ENDCLASS.

CLASS zcl_oao_property IMPLEMENTATION.
  METHOD /iwbep/if_mgw_odata_property~set_type_edm_string.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-string.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_byte.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-byte.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_int16.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-int16.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_int32.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-int32.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_boolean.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-boolean.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_decimal.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-decimal.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_datetime.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-datetime.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_time.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-time.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_guid.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-guid.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_binary.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-binary.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_datetimeoffset.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-datetimeoffset.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_int64.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-int64.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_double.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-double.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_single.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-single.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_float.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-float.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_type_edm_sbyte.
    mv_edm_type = /iwbep/if_mgw_med_odata_types=>gcs_edm_data_types-sbyte.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_precison.
    mv_precision = iv_precision.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_conversion_exit.
    mv_conv_exit = iv_conv_exit.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~disable_conversion.
    mv_conversion = abap_false.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_as_content_type.
    mv_content_type = abap_true.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_semantic.
    mv_semantic = iv_semantic.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_as_etag.
    mv_etag = abap_true.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_symbol    = iv_text_element_symbol.
    mv_text_container = iv_text_element_container.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_maxlength.
    mv_maxlength = iv_max_length.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_creatable.
    mv_creatable = iv_creatable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_updatable.
    mv_updatable = iv_updatable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_sortable.
    mv_sortable = iv_sortable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_nullable.
    mv_nullable = iv_nullable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_filterable.
    mv_filterable = iv_filterable.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_property~set_is_key.
    mv_is_key = iv_key.
  ENDMETHOD.

  METHOD /iwbep/if_mgw_odata_annotatabl~create_annotation.
    IF mo_annotation IS NOT BOUND.
      CREATE OBJECT mo_annotation.
    ENDIF.
    ro_annotation = mo_annotation.
  ENDMETHOD.

ENDCLASS.
