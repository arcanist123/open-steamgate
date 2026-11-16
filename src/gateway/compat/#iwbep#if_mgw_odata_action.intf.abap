INTERFACE /iwbep/if_mgw_odata_action PUBLIC.

  INTERFACES /iwbep/if_mgw_odata_annotatabl.
  INTERFACES /iwbep/if_mgw_odata_item.
  ALIASES set_label_from_text_element FOR /iwbep/if_mgw_odata_item~set_label_from_text_element.
* Overlay (milestone 4): set_disabled through the item, and the input
* parameter read back by name (a redefining model disables parameters)
  ALIASES set_disabled FOR /iwbep/if_mgw_odata_item~set_disabled.

  METHODS get_input_parameter
    IMPORTING
      iv_name             TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_parameter) TYPE REF TO /iwbep/if_mgw_odata_parameter
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_input_parameter
    IMPORTING
      iv_parameter_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_abap_fieldname   TYPE clike OPTIONAL
    RETURNING
      VALUE(ro_parameter) TYPE REF TO /iwbep/if_mgw_odata_parameter
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_return_entity_type
    IMPORTING
      iv_data_object_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_return_entity_set
    IMPORTING
      iv_entity_set_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_return_complex_type
    IMPORTING
      iv_data_object_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_http_method
    IMPORTING
      iv_method_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_http_method
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_action_for
    IMPORTING
      iv_entity_type_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS bind_input_structure
    IMPORTING
      iv_structure_name   TYPE string
      iv_bind_conversions TYPE abap_bool DEFAULT abap_false
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_return_multiplicity
    IMPORTING
      iv_cardinality TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality.

ENDINTERFACE.
