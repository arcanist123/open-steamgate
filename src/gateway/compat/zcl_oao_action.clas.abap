* Local metadata holder for the public Gateway action contract.
CLASS zcl_oao_action DEFINITION PUBLIC.
  PUBLIC SECTION.
    INTERFACES /iwbep/if_mgw_odata_action.
    TYPES ty_parameters TYPE STANDARD TABLE OF REF TO zcl_oao_parameter WITH DEFAULT KEY.
* These fields are read by the runtime's metadata facade.
    DATA mt_parameters TYPE ty_parameters.
    DATA mv_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_http_method TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_http_method VALUE 'GET'.
    DATA mv_return_multiplicity TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality VALUE '1'.
    DATA mv_return_entity_type TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_return_entity_set TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_return_complex_type TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_action_for TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name.
    DATA mv_input_structure TYPE string.
    DATA mv_text_symbol TYPE textpoolky.
    DATA mv_text_container TYPE string.
* milestone 4: a disabled action leaves the model, a disabled parameter the
* function import
    DATA mv_disabled TYPE abap_bool.
ENDCLASS.
CLASS zcl_oao_action IMPLEMENTATION.
  METHOD /iwbep/if_mgw_odata_action~create_input_parameter.
    DATA parameter TYPE REF TO zcl_oao_parameter.
    CREATE OBJECT parameter.
    parameter->mv_name = iv_parameter_name.
    parameter->mv_abap_fieldname = iv_abap_fieldname.
    ro_parameter = parameter.
    INSERT parameter INTO TABLE mt_parameters.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_http_method.
    mv_http_method = iv_method_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_return_multiplicity.
    mv_return_multiplicity = iv_cardinality.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_return_entity_set.
    mv_return_entity_set = iv_entity_set_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_return_entity_type.
    mv_return_entity_type = iv_data_object_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_return_complex_type.
    mv_return_complex_type = iv_data_object_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~set_action_for.
    mv_action_for = iv_entity_type_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~bind_input_structure.
    mv_input_structure = iv_structure_name.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_item~set_label_from_text_element.
    mv_text_container = iv_text_element_container.
    mv_text_symbol = iv_text_element_symbol.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_item~set_disabled.
    mv_disabled = iv_disabled.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_action~get_input_parameter.
    DATA parameter TYPE REF TO zcl_oao_parameter.
    LOOP AT mt_parameters INTO parameter.
      IF parameter->mv_name = iv_name.
        ro_parameter = parameter.
        RETURN.
      ENDIF.
    ENDLOOP.
    RAISE EXCEPTION TYPE /iwbep/cx_mgw_med_exception.
  ENDMETHOD.
  METHOD /iwbep/if_mgw_odata_annotatabl~create_annotation.
    CREATE OBJECT ro_annotation TYPE zcl_oao_annotation.
  ENDMETHOD.
ENDCLASS.
