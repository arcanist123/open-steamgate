INTERFACE /iwbep/if_mgw_odata_model PUBLIC.
* Overlay (milestone 4): the model features and the getters a redefining
* model reads the elements it changes through (entity set, association,
* association set, action); every getter raises the med exception for a
* name the model does not have, which is what such a model catches.

* the model features a generated _MPC_EXT sets; the components are the ones
* the services read so far call: long labels for properties (the service
* measured kept the medium labels of its properties with it set, so the
* $metadata writer does not change the label for it) and deferred batch
* response creation (no batch behaviour behind it here)
  TYPES:
    BEGIN OF ty_s_model_features,
      use_long_label_for_property TYPE abap_bool,
      use_deferred_batch_resp_crea TYPE abap_bool,
    END OF ty_s_model_features.

  METHODS set_model_features
    IMPORTING
      is_model_features TYPE ty_s_model_features.

  METHODS get_entity_set
    IMPORTING
      iv_entity_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_entity_set) TYPE REF TO /iwbep/if_mgw_odata_entity_set
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_association
    IMPORTING
      iv_association_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_association) TYPE REF TO /iwbep/if_mgw_odata_assoc
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_association_set
    IMPORTING
      iv_assoc_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_assoc_set) TYPE REF TO /iwbep/if_mgw_odata_assoc_set
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_action
    IMPORTING
      iv_action_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_action) TYPE REF TO /iwbep/if_mgw_odata_action
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_entity_type
    IMPORTING
      iv_entity_type_name TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_def_entity_set   TYPE abap_bool DEFAULT abap_true
    RETURNING
      VALUE(ro_entity)    TYPE REF TO /iwbep/if_mgw_odata_entity_typ
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_entity_type
    IMPORTING
      iv_entity_name        TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_entity_type) TYPE REF TO /iwbep/if_mgw_odata_entity_typ
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_complex_type
    IMPORTING
      iv_complex_type_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_complex_type) TYPE REF TO /iwbep/if_mgw_odata_cmplx_type
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS get_complex_type
    IMPORTING
      iv_complex_type_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_complex_type) TYPE REF TO /iwbep/if_mgw_odata_cmplx_type
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS set_schema_namespace
    IMPORTING
      iv_namespace TYPE string.

  METHODS get_schema_namespace
    EXPORTING
      ev_namespace TYPE string.

  METHODS create_association
    IMPORTING
      iv_association_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_left_type          TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_right_type         TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_left_card          TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality
      iv_right_card         TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_cardinality
      iv_def_assoc_set      TYPE abap_bool DEFAULT abap_true
    RETURNING
      VALUE(ro_association) TYPE REF TO /iwbep/if_mgw_odata_assoc
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_association_set
    IMPORTING
      iv_association_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_left_entity_set_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_right_entity_set_name  TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
      iv_association_name       TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name OPTIONAL
    RETURNING
      VALUE(ro_association_set) TYPE REF TO /iwbep/if_mgw_odata_assoc_set
    RAISING
      /iwbep/cx_mgw_med_exception.

  METHODS create_action
    IMPORTING
      iv_action_name   TYPE /iwbep/if_mgw_med_odata_types=>ty_e_med_entity_name
    RETURNING
      VALUE(ro_action) TYPE REF TO /iwbep/if_mgw_odata_action
    RAISING
      /iwbep/cx_mgw_med_exception.

ENDINTERFACE.